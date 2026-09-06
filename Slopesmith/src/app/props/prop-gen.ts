import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  FAL_3D_MODELS, FAL_MODELS, createFalGenerationProvenance, estimateUsd,
  fal3dModel, falEndpointMayGenerate, usdText, type FalGenerationProvenance,
} from '../../core/paint/fal-models';
import { MAX_IMPORT_TRIS } from '../../core/props/imported';
import { THUMB_DEFAULT_AZIMUTH, THUMB_DEFAULT_ELEVATION } from './thumb-renderer';
import { suggestTextureName } from '../../core/paint/textures';
import { loadSettings, saveSettings } from '../state/settings';
import { openSettingsDialog } from '../ui/chrome/settings-dialog';
import { modal } from '../ui/components/modal';
import { toast } from '../ui/components/toast';
import { ensureTexGenStyles, falFetch, postFal, promptRig } from '../paint/texture-gen';
import { createFalRightsDisclosure, renderFalRightsDisclosure } from '../paint/fal-rights';

/**
 * Generate prop: the ✨ tile beside ＋ in the Prop Library's Custom view (docs/032). Two billed steps,
 * checkpointed apart because they are priced ~an order of magnitude apart:
 *
 *   1. CONCEPT IMAGE — the ordinary text-to-image catalogue paints one studio-shot object view (cheap,
 *      seconds). Regenerate until the object is right; nothing downstream is spent judging a bad one.
 *   2. BUILD 3D — an image-to-3D model (FAL_3D_MODELS) turns that view into a textured GLB, through the
 *      queue proxy /api/fal-3d (minutes, like the panorama pass).
 *
 * "Add to library" then hands the GLB to the Prop Library's own import path — the same conversion, texture
 * staging and record the ＋ tile runs on a picked file — plus one thing a picked file doesn't need: a real
 * size. A generated mesh arrives normalized to roughly a unit box, so the dialog asks for the longest side
 * in metres and the draft is rescaled before it is stored. From there it is an ordinary imported prop:
 * same grid, same arming, same export, replace-by-name and all.
 *
 * Same dialog contract as the other generators: nothing billed until a button is pressed, nothing stored
 * until Add, sticky modal (only Close / Esc dismiss it), the shared prompt-disclosure leash.
 */

/** Concept image edge — ~1 MP: sharp enough to condition the mesh models, cheap enough to iterate on. */
const CONCEPT_SIZE = 1024;

/** The fixed half of the prompt: everything that makes the image an OBJECT SHOT the image-to-3D models are
 *  built for — one subject, clean background, most of the frame — rather than a scene. */
const PROP_GUIDANCE =
  'A single isolated object, whole and fully in frame, filling most of the frame, centered on a plain flat '
  + 'light grey background, three-quarter view, even studio lighting, no cast shadow, no text, no watermark, '
  + 'no people.';

const propPromptFor = (subject: string) => (subject ? `${subject}. ${PROP_GUIDANCE}` : PROP_GUIDANCE);

/** Quick props — the furniture an SSX mountain actually wants, one click into the description. */
const PRESETS: ReadonlyArray<{ label: string; subject: string }> = [
  { label: 'Banner', subject: 'a red and white racing banner arch on two steel poles' },
  { label: 'Rock', subject: 'a jagged granite boulder dusted with snow' },
  { label: 'Pine', subject: 'a tall snow-laden pine tree' },
  { label: 'Sign', subject: 'a weathered wooden trail sign on a single post' },
  { label: 'Hut', subject: 'a small alpine timber hut with a snow-covered roof' },
  { label: 'Pylon', subject: 'a red steel chairlift pylon with a crossbar' },
];

export interface PropGenDeps {
  /** The finished GLB — hand it to the Prop Library's ordinary import path, rescaled so its longest side
   *  is `meters`. Resolves once the model is in the catalogue and armed; throws to keep the dialog open. */
  importGlb(file: File, meters: number, generation: FalGenerationProvenance): Promise<void>;
}

/** Open the Generate prop dialog. Nothing is billed until Generate / Build, nothing stored until Add. */
export function openPropGenDialog(deps: PropGenDeps): void {
  ensureTexGenStyles();   // this dialog wears the Generate texture dialog's chrome
  const prefs = { ...loadSettings().propGen };
  const { host, close: closeModal } = modal({ sticky: true });   // a paid mesh must not die to a stray click
  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onEsc);
  const close = () => {
    document.removeEventListener('keydown', onEsc);
    meshView.dispose();
    closeModal();
  };
  host.classList.add('sp-texgen');

  const title = document.createElement('h3');
  title.textContent = 'Generate prop';

  // ---- no-key banner (same contract as the other generators: explain before asking) ----
  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.textContent = 'No fal.ai API key yet. Generation calls fal.ai with your own key and bills your '
    + 'own account — add one to switch this on.';
  const bannerBtn = document.createElement('button');
  bannerBtn.type = 'button';
  bannerBtn.className = 'sp-btn';
  bannerBtn.textContent = 'Open Settings…';
  bannerBtn.onclick = () => { close(); openSettingsDialog(); };
  banner.appendChild(bannerBtn);

  // ---- subject ----
  const subjectLabel = document.createElement('label');
  subjectLabel.className = 'fld';
  subjectLabel.textContent = 'Describe the object';
  const subject = document.createElement('input');
  subject.type = 'text';
  subject.spellcheck = false;
  subject.placeholder = 'a weathered wooden trail sign on a single post';
  const subjectHint = document.createElement('p');
  subjectHint.className = 'hint';
  subjectHint.textContent = 'One thing, not a scene. The studio-shot wording is added for you, and the '
    + 'prop is named from this too.';

  const presets = document.createElement('div');
  presets.className = 'presets';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-btn';
    b.textContent = p.label;
    b.onclick = () => { subject.value = p.subject; onChanged(); };
    presets.appendChild(b);
  }

  const rig = promptRig(() => propPromptFor(subject.value.trim()), () => onChanged());

  // ---- the two models, priced apart ----
  const imgLabel = document.createElement('label');
  imgLabel.className = 'fld';
  const imgPrice = document.createElement('span');
  imgPrice.className = 'price';
  imgLabel.append(document.createTextNode('Concept image model'), imgPrice);
  const imgSel = document.createElement('select');
  for (const m of FAL_MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    imgSel.appendChild(o);
  }
  imgSel.value = prefs.imageModel;
  if (!imgSel.value) imgSel.value = FAL_MODELS[0].id;
  const imgRights = createFalRightsDisclosure();

  const meshLabel = document.createElement('label');
  meshLabel.className = 'fld';
  const meshPrice = document.createElement('span');
  meshPrice.className = 'price';
  meshLabel.append(document.createTextNode('3D model'), meshPrice);
  const meshSel = document.createElement('select');
  for (const m of FAL_3D_MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    meshSel.appendChild(o);
  }
  meshSel.value = prefs.meshModel;
  const meshHint = document.createElement('p');
  meshHint.className = 'hint';
  const meshRights = createFalRightsDisclosure();

  // ---- the chosen model's detail menu (Rodin's quality tiers / Sketch) — hidden when it offers none ----
  const detailLabel = document.createElement('label');
  detailLabel.className = 'fld';
  detailLabel.textContent = 'Detail';
  const detailSel = document.createElement('select');
  const detailHint = document.createElement('p');
  detailHint.className = 'hint';
  detailHint.textContent = 'Same price either way — lower levels return a lighter mesh; Sketch is the fast rough tier.';
  const syncDetail = () => {
    const details = fal3dModel(meshSel.value)?.details ?? [];
    const prev = detailSel.value || prefs.meshDetail;
    detailSel.replaceChildren();
    for (const d of details) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = d.label;
      detailSel.appendChild(o);
    }
    if (details.some(d => d.id === prev)) detailSel.value = prev;
    const show = details.length > 0;
    detailLabel.style.display = show ? '' : 'none';
    detailSel.style.display = show ? '' : 'none';
    detailHint.style.display = show ? '' : 'none';
  };
  syncDetail();

  // ---- imported size + name ----
  const cols = document.createElement('div');
  cols.className = 'cols';
  const sizeCol = document.createElement('div');
  const sizeLabel = document.createElement('label');
  sizeLabel.className = 'fld';
  sizeLabel.textContent = 'Imported size (m)';
  const sizeInp = document.createElement('input');
  sizeInp.type = 'number';
  sizeInp.min = '0.5';
  sizeInp.max = '100';
  sizeInp.step = '0.5';
  sizeInp.value = String(prefs.sizeM);
  sizeCol.append(sizeLabel, sizeInp);
  const nameCol = document.createElement('div');
  const nameLabel = document.createElement('label');
  nameLabel.className = 'fld';
  nameLabel.textContent = 'Save as';
  const name = document.createElement('input');
  name.type = 'text';
  name.spellcheck = false;
  nameCol.append(nameLabel, name);
  cols.append(sizeCol, nameCol);
  const colsHint = document.createElement('p');
  colsHint.className = 'hint';
  // A generated model has no real-world scale of its own, hence the explicit imported size.
  colsHint.textContent = 'Longest side lands at this size (⇧scroll resizes a placed prop). '
    + 'Re-using a name replaces that model wherever it is placed.';

  // ---- the two result slots: concept image, then the mesh built from it ----
  const slots = document.createElement('div');
  slots.className = 'abc';
  slots.style.gridTemplateColumns = '1fr 1fr';
  const mkSlot = (placeholder: string, cap: string) => {
    const wrap = document.createElement('div');
    const slot = document.createElement('div');
    slot.className = 'slot empty';
    slot.style.backgroundSize = 'contain';   // the object, whole — not a crop of it
    slot.textContent = placeholder;
    const capEl = document.createElement('div');
    capEl.className = 'slot-cap';
    capEl.textContent = cap;
    wrap.append(slot, capEl);
    return { wrap, slot, cap: capEl };
  };
  const conceptSlot = mkSlot('the concept image previews here', 'concept image');
  const meshSlot = mkSlot('the built model previews here', '3D model');
  slots.append(conceptSlot.wrap, meshSlot.wrap);
  const previewCap = document.createElement('div');
  previewCap.className = 'previewcap';

  // ---- actions ----
  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sp-btn';
  cancel.textContent = 'Close';
  cancel.onclick = close;
  const genImg = document.createElement('button');
  genImg.type = 'button';
  genImg.className = 'sp-btn';
  const build = document.createElement('button');
  build.type = 'button';
  build.className = 'sp-btn';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'sp-btn accent';
  actions.append(cancel, genImg, build, add);

  host.append(title, banner, subjectLabel, subject, subjectHint, presets, rig.el,
    imgLabel, imgSel, imgRights, meshLabel, meshSel, meshHint, meshRights,
    detailLabel, detailSel, detailHint,
    cols, colsHint, slots, previewCap, actions);

  // ---- live state ----
  let concept: HTMLCanvasElement | null = null;
  let conceptModel: string | null = null;
  let glb: Blob | null = null;
  let glbGeneration: FalGenerationProvenance | null = null;
  let busy: false | 'image' | 'mesh' | 'import' = false;
  const meshView = new MeshOrbitView();
  const hasKey = () => !!loadSettings().falKey.trim();

  const suggestedName = () => {
    const from = subject.value.trim() || (rig.edited() ? rig.value() : '');
    return from ? suggestTextureName(from, new Set()) : '';
  };

  const refresh = () => {
    const keyed = hasKey();
    banner.style.display = keyed ? 'none' : '';
    const imgUsd = estimateUsd(imgSel.value, CONCEPT_SIZE);
    imgPrice.textContent = imgUsd == null ? '' : `≈ ${usdText(imgUsd)} / image`;
    const mesh = fal3dModel(meshSel.value);
    meshPrice.textContent = mesh ? `${usdText(mesh.usdPerRun)} / build` : '';
    meshHint.textContent = mesh?.note ?? '';
    renderFalRightsDisclosure(imgRights, [imgSel.value]);
    renderFalRightsDisclosure(meshRights, [meshSel.value]);
    name.placeholder = suggestedName() || 'named from your description';
    const described = !!subject.value.trim() || rig.edited();
    genImg.disabled = !!busy || !keyed || !described || !falEndpointMayGenerate(imgSel.value);
    genImg.textContent = busy === 'image' ? 'Generating…' : concept ? 'Regenerate image' : 'Generate image';
    build.disabled = !!busy || !keyed || !concept || !conceptModel
      || !falEndpointMayGenerate(meshSel.value);
    build.textContent = busy === 'mesh' ? 'Building…' : glb ? 'Rebuild 3D' : 'Build 3D model';
    add.disabled = !!busy || !glb || !glbGeneration;
    add.textContent = busy === 'import' ? 'Importing…' : 'Add to library';
  };
  const onChanged = () => { rig.sync(); refresh(); };

  const showIn = (slot: { slot: HTMLDivElement }, url: string) => {
    slot.slot.classList.remove('empty');
    slot.slot.textContent = '';
    slot.slot.style.backgroundImage = `url(${url})`;
  };

  imgSel.onchange = refresh;
  meshSel.onchange = () => { syncDetail(); refresh(); };

  genImg.onclick = async () => {
    const key = loadSettings().falKey.trim();
    if (!key || busy || genImg.disabled) return;
    busy = 'image';
    refresh();
    previewCap.textContent = 'Painting the concept image — a few seconds…';
    try {
      const usedModel = imgSel.value;
      const { image } = await postFal('/api/fal-texture', key,
        { model: usedModel, prompt: rig.value(), size: CONCEPT_SIZE });
      concept = image;
      conceptModel = usedModel;
      showIn(conceptSlot, image.toDataURL('image/png'));
      // a paid mesh is never thrown away by a cheap image regenerate — it just stops matching the picture
      if (glb) meshSlot.cap.textContent = '3D model — built from the previous image';
      previewCap.textContent = 'Happy with the object? Build the 3D model next — or regenerate until it reads right.';
      saveSettings({ propGen: { ...loadSettings().propGen, imageModel: imgSel.value } });
    } catch (e) {
      previewCap.textContent = '';
      toast(`Generation failed — ${e instanceof Error ? e.message : String(e)}`, 'err', 8000);
    }
    busy = false;
    refresh();
  };

  build.onclick = async () => {
    const key = loadSettings().falKey.trim();
    if (!key || !concept || busy || build.disabled) return;
    busy = 'mesh';
    refresh();
    previewCap.textContent = 'Building the 3D model — this runs a few minutes on fal’s queue…';
    try {
      const usedMeshModel = meshSel.value;
      const mesh = fal3dModel(usedMeshModel);
      const res = await falFetch('/api/fal-3d', key, {
        model: usedMeshModel, prompt: rig.value(), image: concept.toDataURL('image/png'),
        ...(mesh?.details?.length ? { detail: detailSel.value } : {}),
      });
      const blob = await res.blob();
      const parsed = await new GLTFLoader().parseAsync(await blob.arrayBuffer(), '');
      const { tris, verts } = countGeo(parsed.scene);
      glb = blob;
      glbGeneration = createFalGenerationProvenance([conceptModel!, usedMeshModel]);
      meshSlot.slot.classList.remove('empty');
      meshSlot.slot.textContent = '';
      if (!meshView.el.parentElement) meshSlot.slot.appendChild(meshView.el);
      meshView.set(parsed.scene);
      meshSlot.cap.textContent = '3D model — drag to orbit';
      const over = tris > MAX_IMPORT_TRIS;
      previewCap.textContent = `${tris.toLocaleString()} tris · ${verts.toLocaleString()} verts`
        + (over ? ` — past the ${MAX_IMPORT_TRIS.toLocaleString()} import cap, so Add will refuse; rebuild (Trellis simplifies hardest)`
          : ' — look it over, set the size, and add it to the library.');
      saveSettings({ propGen: { ...loadSettings().propGen, meshModel: meshSel.value, meshDetail: detailSel.value } });
    } catch (e) {
      previewCap.textContent = '';
      toast(`Build failed — ${e instanceof Error ? e.message : String(e)}`, 'err', 8000);
    }
    busy = false;
    refresh();
  };

  // Import and CLOSE — adding is choosing: the library arms the new model, and the point of generating a
  // prop is placing it, which the dialog would be covering.
  add.onclick = async () => {
    if (!glb || !glbGeneration || busy) return;
    const meters = Math.min(100, Math.max(0.1, Number(sizeInp.value) || prefs.sizeM));
    const stem = name.value.trim() || suggestedName() || 'generated-prop';
    busy = 'import';
    refresh();
    try {
      const file = new File([glb], `${stem}.glb`, { type: 'model/gltf-binary' });
      await deps.importGlb(file, meters, glbGeneration);
      saveSettings({ propGen: { imageModel: imgSel.value, meshModel: meshSel.value, meshDetail: detailSel.value, sizeM: meters } });
      close();
    } catch (e) {
      busy = false;
      refresh();
      toast(`Could not import — ${e instanceof Error ? e.message : String(e)}`, 'err', 6000);
    }
  };

  subject.oninput = onChanged;
  subject.onkeydown = e => { if (e.key === 'Enter' && !genImg.disabled) { e.preventDefault(); genImg.click(); } };
  onChanged();
  subject.focus();
}

/** Triangle / vertex counts across every mesh in a loaded glTF scene — caption estimates; the importer
 *  recounts exactly (and enforces the cap) when the model is actually added. */
function countGeo(scene: THREE.Object3D): { tris: number; verts: number } {
  let tris = 0, verts = 0;
  scene.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const position = mesh.geometry.getAttribute('position');
    verts += position?.count ?? 0;
    const count = mesh.geometry.index?.count ?? position?.count ?? 0;
    tris += Math.floor(count / 3);
  });
  return { tris, verts };
}

const ORBIT_SENSITIVITY = 0.01;   // radians of orbit per pixel dragged — matches the Prop Tools preview
const MAX_ELEVATION = 1.45;       // clamp the pitch just shy of straight over / under the model
const VIEW_FOV = 35;

/**
 * The mesh slot's live view: the parsed GLB in a small renderer you can drag to orbit — the dialog twin of
 * the Prop Tools preview card (props/preview.ts), inspection only. Unlike that card it renders the glTF
 * scene directly rather than going through ThumbRenderer: the draft's textures aren't staged into the
 * Custom bank until Add, but the parsed scene already wears them as live materials. One renderer for the
 * dialog's lifetime (disposed on close — GL contexts are a finite resource); the scene swaps on rebuild
 * and the orbit angle sticks, opening at the library's own 3/4 view.
 */
class MeshOrbitView {
  readonly el = document.createElement('div');
  private renderer: THREE.WebGLRenderer | null = null;
  private world = new THREE.Scene();
  private holder = new THREE.Group();   // the parsed scene swaps inside this
  private cam = new THREE.PerspectiveCamera(VIEW_FOV, 1, 0.01, 100);
  private centre = new THREE.Vector3();
  private dist = 1;
  private azimuth = THUMB_DEFAULT_AZIMUTH;
  private elevation = THUMB_DEFAULT_ELEVATION;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private drawQueued = false;

  constructor() {
    this.el.style.cssText = 'position:absolute;inset:0;cursor:grab;touch-action:none;user-select:none;';
    this.world.add(this.holder);
    this.world.add(new THREE.AmbientLight(0xffffff, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(1, 2, 1.5);
    this.world.add(sun);
    this.wireOrbit();
  }

  /** Swap in a freshly parsed GLB scene, reframe on its bounds, and draw at the kept orbit angle. */
  set(scene: THREE.Object3D) {
    this.holder.clear();
    this.holder.add(scene);
    const box = new THREE.Box3().setFromObject(scene);
    box.getCenter(this.centre);
    const radius = Math.max(1e-6, box.getSize(new THREE.Vector3()).length() / 2);
    this.dist = (radius / Math.tan((VIEW_FOV * Math.PI / 180) / 2)) * 1.1;
    this.cam.near = this.dist / 100;
    this.cam.far = this.dist * 10;
    this.cam.updateProjectionMatrix();
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setSize(256, 256);
      this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;';
      this.el.appendChild(this.renderer.domElement);
    }
    this.draw();
  }

  private draw() {
    if (!this.renderer) return;
    const flat = Math.cos(this.elevation);
    this.cam.position.set(
      this.centre.x + this.dist * flat * Math.sin(this.azimuth),
      this.centre.y + this.dist * Math.sin(this.elevation),
      this.centre.z + this.dist * flat * Math.cos(this.azimuth),
    );
    this.cam.lookAt(this.centre);
    this.renderer.render(this.world, this.cam);
  }

  /** Coalesce a burst of pointer-moves into one render per animation frame. */
  private scheduleDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
  }

  /** Pointer drag orbits (horizontal → azimuth, vertical → elevation); pointer capture keeps the drag
   *  alive when the cursor leaves the little canvas. Same feel as the Prop Tools preview. */
  private wireOrbit() {
    this.el.addEventListener('pointerdown', e => {
      if (!this.renderer) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.el.style.cursor = 'grabbing';
      this.el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.el.addEventListener('pointermove', e => {
      if (!this.dragging) return;
      this.azimuth -= (e.clientX - this.lastX) * ORBIT_SENSITIVITY;   // drag right → the model turns to follow
      this.elevation += (e.clientY - this.lastY) * ORBIT_SENSITIVITY; // drag down → look from lower
      this.elevation = Math.max(-MAX_ELEVATION, Math.min(MAX_ELEVATION, this.elevation));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.scheduleDraw();
    });
    const end = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.el.style.cursor = 'grab';
      try { this.el.releasePointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  dispose() {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
