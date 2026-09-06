import {
  FAL_GENERATION_HEADER, FAL_MODELS, FAL_PANORAMA_MODEL, FAL_PANORAMA_USD,
  createFalGenerationProvenance, falEndpointMayGenerate, falModel, usdText,
  type FalGenerationProvenance,
} from '../../core/paint/fal-models';
import { suggestTextureName } from '../../core/paint/textures';
import { loadSettings, saveSettings } from '../state/settings';
import { openSettingsDialog } from '../ui/chrome/settings-dialog';
import { modal } from '../ui/components/modal';
import { toast } from '../ui/components/toast';
import { ensureTexGenStyles, postFal, promptRig } from '../paint/texture-gen';
import { clientFetch } from '../net/client';
import { createFalRightsDisclosure, renderFalRightsDisclosure } from '../paint/fal-rights';
import { infoBadge } from '../ui/components/info';

/**
 * Generate skybox: the ✨ beside "▲ load image…" in the authored Skybox panel (docs/025). Describe a sky, fal
 * paints a 2:1 equirectangular view of it, and "use as sky" hands the PNG to the exact same
 * /api/skyupload?fit=equirect the load button uses — the server re-projects it into the ring band, derives
 * the ground disc, and from there it is an ordinary custom sky: same picker entry, same export path.
 *
 * Two things carry the quality:
 *
 *  • The ring keeps only the band below its measured open top, so the zenith — where a prompted "equirectangular"
 *    image is at its most warped — is DISCARDED. What survives is the horizon band, where a text-to-image
 *    model's panorama is at its most plausible. The format's weakness lands exactly on the geometry's
 *    blind spot.
 *
 *  • The ring wraps 360° and a generated image does not. Two remedies, priced apart: wrapBlendX (free,
 *    default) cross-fades the side bands with the half-width offset copy — the 1-D version of the tile
 *    dialog's wrap blend; the optional Hunyuan World pass (flat-priced, ~50× the base call) re-imagines
 *    the view as a genuinely wrapping panorama instead.
 *
 * Same dialog contract as Generate texture: nothing billed until Generate, nothing stored until use, the
 * modal is sticky (only Close / Esc dismiss it), and the shell borrows that dialog's stylesheet outright.
 */

/** Asked-for size: 2:1 at fal's edge cap. The stored band is 2048×384, so width is the binding side. */
const SKY_W = 1536, SKY_H = 768;

/** The fixed half of the prompt: everything that makes the model return a WRAPPABLE sky view rather than a
 *  postcard — and keeps the ground plausible, because the band keeps everything below the horizon too. */
const SKY_GUIDANCE =
  'Full 360-degree equirectangular panorama, 2:1 aspect, the horizon running level across the vertical '
  + 'middle, continuous unbroken sky and terrain all the way around, consistent lighting and sun position, '
  + 'left and right edges meeting seamlessly. Natural ground below the horizon. The sky high overhead is a '
  + 'smooth even gradient, free of clouds near the zenith. No text, no watermark, no people, no lens borders.';

const skyPromptFor = (subject: string) =>
  subject ? `Equirectangular panorama of ${subject}.\n\n${SKY_GUIDANCE}` : SKY_GUIDANCE;

/** Quick skies — the moods an SSX mountain actually ships under, one click into the description. */
const PRESETS: ReadonlyArray<{ label: string; subject: string }> = [
  { label: 'Bluebird', subject: 'a crisp cloudless blue-sky day over snowy alpine peaks, ranges receding to the horizon' },
  { label: 'Sunset', subject: 'a golden sunset over snowy mountains, warm orange light fading to violet overhead' },
  { label: 'Night', subject: 'a clear starry night over moonlit snowy peaks, deep blue sky' },
  { label: 'Aurora', subject: 'green aurora curtains over dark snowy mountains under a starry night sky' },
  { label: 'Storm', subject: 'a brooding storm front over a dark mountain ridge, heavy grey clouds, dramatic light' },
  { label: 'Alpenglow', subject: 'pink alpenglow on high snowy summits at dusk, cold blue valleys below' },
];

export interface SkyGenDeps {
  /** The panorama was stored — the host adopts it as the mountain's sky (picker entry, preview, doc).
   *  `name` is the name the store answered with, which steps past one already taken (docs/038). */
  onSaved(name: string): void | Promise<void>;
  /** Extracted ring used for upload/reprojection; absent keeps the generic authoring profile. */
  ringLevel?: string;
  /** Equirectangular source row meeting that ring's measured open top. */
  ringTopV?: number;
}

/** Open the Generate skybox dialog. Nothing is billed until Generate, nothing stored until "use as sky". */
export function openSkyGenDialog(deps: SkyGenDeps): void {
  ensureTexGenStyles();   // this dialog wears the Generate texture dialog's chrome
  const prefs = { ...loadSettings().skyGen };
  const { host, close: closeModal } = modal({ sticky: true });   // a paid panorama must not die to a stray click
  const onEsc = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onEsc);
  const close = () => {
    document.removeEventListener('keydown', onEsc);
    closeModal();
  };
  host.classList.add('sp-texgen');

  const title = document.createElement('h3');
  title.textContent = 'Generate skybox';

  // ---- no-key banner (same contract as Generate texture: the dialog explains itself before it asks) ----
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
  subjectLabel.textContent = 'Describe the sky';
  const subject = document.createElement('input');
  subject.type = 'text';
  subject.spellcheck = false;
  subject.placeholder = 'green aurora over dark snowy peaks';
  const subjectHint = document.createElement('p');
  subjectHint.className = 'hint';
  subjectHint.textContent = 'One line; the panorama wording is added for you. Describe the ground too — '
    + 'the ring shows down to the nadir.';

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

  const rig = promptRig(() => skyPromptFor(subject.value.trim()), () => onChanged());

  // ---- model + the panorama pass ----
  const modelLabel = document.createElement('label');
  modelLabel.className = 'fld';
  const price = document.createElement('span');
  price.className = 'price';
  modelLabel.append(document.createTextNode('Model'), price);
  const modelSel = document.createElement('select');
  for (const m of FAL_MODELS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = m.label;
    modelSel.appendChild(o);
  }
  modelSel.value = prefs.model;
  const modelHint = document.createElement('p');
  modelHint.className = 'hint';
  const modelRights = createFalRightsDisclosure();

  const panoWrap = document.createElement('label');
  panoWrap.className = 'chk';
  const panoChk = document.createElement('input');
  panoChk.type = 'checkbox';
  panoChk.checked = prefs.pano;
  const panoText = document.createElement('span');
  panoText.textContent = '360° panorama pass (Hunyuan World)';
  panoWrap.append(panoChk, panoText);
  const panoHint = document.createElement('p');
  panoHint.className = 'hint';
  panoHint.textContent = `Off, the side bands cross-fade (free). On, a second call (${usdText(FAL_PANORAMA_USD)}) `
    + 're-imagines the view as a true 360° sky.';
  panoHint.appendChild(infoBadge(
    'A generated view does not actually wrap round the back. The cross-fade is free and organic skies hide '
    + 'it well; the panorama model is dearer, takes a few minutes, and the scene may drift from the base view.'));

  // ---- name ----
  const nameLabel = document.createElement('label');
  nameLabel.className = 'fld';
  nameLabel.textContent = 'Save as';
  const name = document.createElement('input');
  name.type = 'text';
  name.spellcheck = false;
  const nameHint = document.createElement('p');
  nameHint.className = 'hint';
  nameHint.textContent = 'Stored as a ★ custom sky under this name. Re-using a name replaces that sky in '
    + 'place, wherever it is already picked.';

  // ---- preview ----
  const preview = document.createElement('div');
  preview.className = 'preview empty';
  preview.style.imageRendering = 'auto';   // a downscaled panorama wants smooth, not chunky texels
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder';
  placeholder.textContent = 'The panorama previews here, rolled half way round so the wrap seam sits mid-view.';
  preview.appendChild(placeholder);
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
  const generate = document.createElement('button');
  generate.type = 'button';
  generate.className = 'sp-btn';
  generate.textContent = 'Generate';
  const use = document.createElement('button');
  use.type = 'button';
  use.className = 'sp-btn accent';
  use.textContent = 'Use as sky';
  use.disabled = true;
  actions.append(cancel, generate, use);

  host.append(title, banner, subjectLabel, subject, subjectHint, presets, rig.el,
    modelLabel, modelSel, modelHint, modelRights, panoWrap, panoHint, nameLabel, name, nameHint,
    preview, previewCap, actions);

  // ---- live state ----
  let raw: HTMLCanvasElement | null = null;
  let lastSeed: number | null = null;
  let generation: FalGenerationProvenance | null = null;
  let busy = false;
  const hasKey = () => !!loadSettings().falKey.trim();

  const suggestedName = () => {
    const from = subject.value.trim() || (rig.edited() ? rig.value() : '');
    return from ? suggestTextureName(from, new Set()) : '';
  };

  const refresh = () => {
    const keyed = hasKey();
    banner.style.display = keyed ? 'none' : '';
    const model = falModel(modelSel.value);
    const base = model ? model.usdPerMegapixel * ((SKY_W * SKY_H) / 1_000_000) : null;
    const usd = base == null ? null : base + (panoChk.checked ? FAL_PANORAMA_USD : 0);
    price.textContent = usd == null ? '' : `≈ ${usdText(usd)} / run${panoChk.checked ? ' (2 calls)' : ''}`;
    modelHint.textContent = model?.note ?? '';
    const selectedModels = [modelSel.value, ...(panoChk.checked ? [FAL_PANORAMA_MODEL] : [])];
    renderFalRightsDisclosure(modelRights, selectedModels);
    name.placeholder = suggestedName() || 'named from your description';
    const described = !!subject.value.trim() || rig.edited();
    generate.disabled = busy || !keyed || !described
      || selectedModels.some(id => !falEndpointMayGenerate(id));
    generate.textContent = busy ? 'Generating…' : raw ? 'Regenerate' : 'Generate';
    use.disabled = busy || !raw || !generation;
  };
  const onChanged = () => { rig.sync(); refresh(); };

  const renderPreview = () => {
    if (!raw) return;
    placeholder.remove();
    preview.classList.remove('empty');
    preview.style.backgroundImage = `url(${raw.toDataURL('image/png')})`;
    // 100%/repeat + a half-width offset rolls the wrap seam into the middle of the view
    preview.style.backgroundSize = '100% 100%';
    preview.style.backgroundPosition = '50% 0';
    previewCap.textContent = `${raw.width}×${raw.height} equirect · shown rolled half way round`
      + (lastSeed != null ? ` · seed ${lastSeed}` : '');
  };

  modelSel.onchange = refresh;
  panoChk.onchange = refresh;

  generate.onclick = async () => {
    const key = loadSettings().falKey.trim();
    if (!key || busy || generate.disabled) return;
    busy = true;
    refresh();
    previewCap.textContent = 'Calling fal.ai — a few seconds…';
    try {
      const baseModel = modelSel.value;
      const usePanorama = panoChk.checked;
      const { image, seed } = await postFal('/api/fal-texture', key,
        { model: baseModel, prompt: rig.value(), size: SKY_W, height: SKY_H });
      if (usePanorama) {
        previewCap.textContent = 'Wrapping it into a true panorama — this call runs a few minutes…';
        const pano = await postFal('/api/fal-panorama', key,
          { prompt: rig.value(), image: image.toDataURL('image/png') });
        raw = calmTop(pano.image, deps.ringTopV);
      } else {
        raw = calmTop(wrapBlendX(image), deps.ringTopV);
      }
      lastSeed = seed;
      generation = createFalGenerationProvenance([
        baseModel, ...(usePanorama ? [FAL_PANORAMA_MODEL] : []),
      ]);
      saveSettings({ skyGen: { model: modelSel.value, pano: panoChk.checked } });
      busy = false;
      refresh();
      renderPreview();
    } catch (e) {
      busy = false;
      refresh();
      previewCap.textContent = '';
      toast(`Generation failed — ${e instanceof Error ? e.message : String(e)}`, 'err', 8000);
    }
  };

  // Store and ADOPT — then close: a mountain ships one sky, and the point of picking it is seeing it,
  // which the dialog would be covering.
  use.onclick = async () => {
    if (!raw || !generation || busy) return;
    busy = true;
    refresh();
    try {
      const blob = await new Promise<Blob>((ok, err) =>
        raw!.toBlob(b => (b ? ok(b) : err(new Error('PNG encode failed'))), 'image/png'));
      const stem = name.value.trim() || suggestedName() || 'generated-sky';
      const ring = deps.ringLevel ? `&ring=${encodeURIComponent(deps.ringLevel)}` : '';
      const res = await clientFetch(`/api/skyupload?name=${encodeURIComponent(stem)}&fit=equirect${ring}`, {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          [FAL_GENERATION_HEADER]: JSON.stringify(generation),
        },
        body: blob,
      });
      const body = await res.json() as { name?: string; error?: string };
      if (!res.ok || body.error || !body.name) throw new Error(body.error ?? `HTTP ${res.status}`);
      await deps.onSaved(body.name);
      close();
    } catch (e) {
      busy = false;
      refresh();
      toast(`Could not store the sky — ${e instanceof Error ? e.message : String(e)}`, 'err', 6000);
    }
  };

  subject.oninput = onChanged;
  subject.onkeydown = e => { if (e.key === 'Enter' && !generate.disabled) { e.preventDefault(); generate.click(); } };
  onChanged();
  subject.focus();
}

/**
 * Calm the sky toward ONE colour at the measured ring's top edge. Everything above that edge is discarded
 * at upload, and in its place the game draws
 * a flat fill derived as the MEAN of the band's top row. A generated sky varies around that row — cloud
 * here, clear there — so one flat colour cannot match it everywhere and the rim shows a seam. This makes
 * the convergence true by construction: average the equirect row that will BECOME the band's top edge,
 * paint everything at and above it that colour, and fade the sky into it on approach — so the derived
 * fill and the rim agree all the way round, whatever the model painted up there.
 */
function calmTop(src: HTMLCanvasElement, topV = 0.5, fade = 0.12): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const topY = Math.min(h - 1, Math.max(0, Math.round(topV * h)));
  let r = 0, g = 0, b = 0;
  for (let x = 0; x < w; x++) {
    const o = (topY * w + x) * 4;
    r += d[o]; g += d[o + 1]; b += d[o + 2];
  }
  r /= w; g /= w; b /= w;
  const fadeRows = Math.max(1, Math.round(h * fade));
  const yEnd = Math.min(h, topY + fadeRows);
  for (let y = 0; y < yEnd; y++) {
    const t = y <= topY ? 1 : 1 - (y - topY) / fadeRows;   // flat at and above the edge, easing off below it
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      d[o] += (r - d[o]) * t;
      d[o + 1] += (g - d[o + 1]) * t;
      d[o + 2] += (b - d[o + 2]) * t;
    }
  }
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d')!.putImageData(img, 0, 0);
  return cv;
}

/**
 * X-only wrap blend: cross-fade each side band with the half-width offset copy, pure source through the
 * middle — the 1-D sibling of core/paint/seamless.ts (its both-axis version would smear sky into ground).
 * At x = 0 the output samples column w/2 and at x = w−1 column w/2−1 — adjacent columns of the original —
 * so where the panorama meets itself round the back, the pixels either side of the join were neighbours.
 */
function wrapBlendX(src: HTMLCanvasElement, band = 0.2): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true })!;
  const from = ctx.getImageData(0, 0, w, h);
  const out = new ImageData(w, h);
  const bw = Math.max(1, Math.round(w * band));
  const half = w >> 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const t = Math.min(1, Math.min(x, w - 1 - x) / bw);   // 0 at either side edge → pure offset copy
      const o = (row + x) * 4;
      const oo = (row + ((x + half) % w)) * 4;
      for (let ch = 0; ch < 4; ch++) {
        out.data[o + ch] = from.data[oo + ch] * (1 - t) + from.data[o + ch] * t;
      }
    }
  }
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d')!.putImageData(out, 0, 0);
  return cv;
}
