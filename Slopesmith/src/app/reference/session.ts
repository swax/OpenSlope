import GUI, { Controller } from 'lil-gui';
import { DEFAULT_SUN, type QuadMeshDoc, type SunLight, type V3 } from '../../core/doc/types';
import {
  DEFAULT_LAPS, DEFAULT_SHOWOFF_SECONDS, normalizeLaps, normalizeShowoffSeconds,
} from '../../core/doc/race';
import { effectiveBakeSun, effectiveBakeAmbient, decodeLightmapTexel } from '../../core/lighting/bake';
import { applyReferenceLightmaps, buildReferenceMeshProgressive, referenceLightmapLayoutStats, type RawPatch, type ReferenceMesh, type RefAiPath, type RefCourseAnchors, type RefSplineRaw, type RefSunSeed } from '../../core/reference/terrain';
import type { LevelProps } from '../../core/reference/props';
import type { ReferenceScreen } from '../../core/reference/screens';
import { screenPoseFromAxes } from '../../core/props/screen';
import { decodeLightRig, bakeRigLighting, type LightRig, type LightRigPayload, type RigLight } from '../../core/reference/lights';
import { fitSun, intensityColors, computeModel, refitWithOcclusion, residualColors, sunDirFromElAz, checkRecordSun, type LightmapSet, type SunFit, type ShadeModel, type SunRecordCheck } from '../../core/lighting/lightmap';
import { bakeSunShadow, bakeAO } from '../../core/lighting/occlusion';
import { DEFAULT_GODRAY_COURSE, normalizeGodRayCourse, type GodRayCourse } from '../../core/lighting/god-rays';
import type { Viewport } from '../viewport/viewport';
import type { Store } from '../state/store';
import { REF_KEY, loadStored, type StoredRef } from '../state/storage';
import { clearGui, note, tip } from '../ui/components/gui';
import { toast } from '../ui/components/toast';
import { fetchJson } from '../net/fetch-json';
import {
  RETAIL_EXTRACT_REASON, UNCLASSIFIED_EXPORT_REASON, UNIDENTIFIED_FOLDER_REASON,
  type MapOriginSummary as ReferenceMapSummary,
} from '../../core/export/origin';
import { beginDiagnosticPhase, runDiagnosticPhase, runDiagnosticPhaseAsync } from '../net/diagnostics';
import { decodeReferenceEffects, type ReferenceEffectsPayload, type ReferenceEffectsState } from '../../core/reference/effects';
import { addReferenceLightDetails } from '../ui/components/light-details';
import { openMountainStatsDialog } from '../ui/dialogs/mountain-stats';
import { normalizeLevelCensus, pageMegabytes, type LevelCensus } from '../../core/reference/census';
import { exportFolderName } from '../../core/export/folder';
import { createReferenceMusicStudy } from './music-study';
import { authoredReferenceMesh } from './authored';
import type { LoadStatus } from '../ui/components/load-status';
import { godRaysForSkyWorld, type SkyPreviewTarget } from '../sky/preview';
import { registerReferenceTextureRevisions } from '../net/asset-paths';

/**
 * The reference-world subsystem: loading an extracted level's terrain to study (read-only), the lighting
 * study recovered from its baked lightmap (sun fit + cast-shadow / AO + records-vs-fit self-check), and the
 * authored SSX sun that lights the mountain you're building. It also owns the layer-visibility toggles that
 * touch the reference — Props / Tricks / Sources / Lighting's Local lights — since each one loads or re-shades part of
 * the loaded reference on demand.
 *
 * A factory over the host: the reference state (loaded mesh, recovered sun, the Reference-panel controllers) lives
 * as closure state; the viewport, store, the scene-panel's Reference / Course / lighting folders, and the
 * host's persistence / rebuild / dialog hooks are injected. The host destructures the returned toggles + init
 * functions (kept under the same names the call sites already use) and reads the loaded reference through the
 * accessor getters (hasReference / getRefCourse / getRefLaps / getRefLevel / getSunOn).
 */

interface RefCourse extends RefCourseAnchors { source: string; points: V3[]; length: number; drop: number; }

/** What the cost rows read before a mountain is loaded — and what they go back to when one is cleared. */
const NO_COST = '—';
type ReferenceOwner = { generation: number; level: string; mesh: ReferenceMesh; patches: RawPatch[] };
type LitView = 'lightmap' | 'model' | 'residual';

export type ReferenceDeps = {
  store: Store;
  viewport: Viewport;
  // the scene panel's detail folders this subsystem fills (Mountain lighting/glare and Reference studies)
  sunFolder: GUI;
  godRayFolder: GUI;
  refGodRayFolder: GUI;
  refFolder: GUI;
  refCourseFolder: GUI;
  lightFolder: GUI;
  refSoundFolder: GUI;
  // scene-panel behaviours the reference drives on load / clear
  rebuildOutliner: () => void;
  applySceneSelection: () => void;
  selectScene: (kind: 'info' | 'lighting') => void;
  // host behaviours
  scheduleRebuild: () => void;
  persistDoc: () => void;
  /** Persist a non-geometry edit through recovery, project, and shared-register storage. */
  persistDocumentEdit: () => void;
  persistRef: () => void;
  persistUi: () => void;
  log: (msg: string) => void;
  loadStatus: LoadStatus;
  focusActive: () => void;
  refreshLighting: () => void;                              // repaint the top-bar lighting pills (sources / prop lights / sun)
  ensurePropLevel: (level: string) => Promise<LevelProps>; // shared prop-payload fetch + geometry registration (host-owned)
  buildFromReferenceCourseDialog: () => void;              // shared terrain dialog, substituting the reference course
  setupRefSky: (level: string | null) => void;             // rebuild Scene ▸ Skybox ▸ Reference for the loaded level
  getActiveGodRayWorld: () => SkyPreviewTarget | null;     // Scene glare preview or active Test ride target
  onReferenceEffects: (state: ReferenceEffectsState) => void; // Effects-mode read-only graph + preview runtime
  /** Publish the extracted mountain currently loaded in this tab's Reference slot. */
  onReferenceChanged: (level: string | null) => void;
};

export function createReference(deps: ReferenceDeps) {
  const { store, viewport, sunFolder, godRayFolder, refGodRayFolder, refFolder, refCourseFolder,
    lightFolder, refSoundFolder,
    rebuildOutliner, applySceneSelection, selectScene, scheduleRebuild,
    persistDoc, persistDocumentEdit, persistRef, persistUi, log, loadStatus, focusActive, refreshLighting,
    ensurePropLevel, buildFromReferenceCourseDialog, setupRefSky, getActiveGodRayWorld, onReferenceEffects,
    onReferenceChanged } = deps;

  const lightRigs = new Map<string, LightRig>();    // fetched + decoded light rigs, per reference level
  const musicStudy = createReferenceMusicStudy(refSoundFolder);

  // ---- Reference: load an extracted level's terrain to study (read-only, not editable) ----
  const refState = { level: '', lighting: 'off' as 'off' | 'lightmap' | 'model' | 'residual', shadow: false, ao: false };
  let refCourse: RefCourse | null = null;             // the loaded reference's recovered main course line (SOP/AIP)
  let refGlare: GodRayCourse | null = null;            // the loaded reference's own glare, from its World.json
  /** The glare panel's own primitives (lil-gui binds plain values; colours are hex strings). Declared with
   *  the rest of the session state rather than beside its panel code, so an early applyGodRays - a reference
   *  cleared during setup, say - can never read it before its initializer has run. */
  const glareUi = {
    on: DEFAULT_GODRAY_COURSE.enabled,
    core: '#' + DEFAULT_GODRAY_COURSE.core.map(v => v.toString(16).padStart(2, '0')).join(''),
    fanIntensity: DEFAULT_GODRAY_COURSE.fanIntensity,
    rim: '#' + DEFAULT_GODRAY_COURSE.rim.map(v => v.toString(16).padStart(2, '0')).join(''),
    spriteIntensity: DEFAULT_GODRAY_COURSE.spriteIntensity,
    el: DEFAULT_GODRAY_COURSE.el,
    az: DEFAULT_GODRAY_COURSE.az,
    distance: DEFAULT_GODRAY_COURSE.distance,
    size: DEFAULT_GODRAY_COURSE.size,
    source: '',
  };
  let glareFolder: GUI | null = null;
  let glareSourceCtl: Controller | null = null;
  let refLightSeed: RefSunSeed | null = null;         // the loaded reference's sun seeded from its OWN Lights.json records (preferred over the lightmap fit)
  let refLightCheck: SunRecordCheck | null = null;    // records-vs-fit self-check: direction agreement + the bake exposure that makes the HDR record bake to this level's own lightmap look
  const courseInfo = { course: '(load a level to read its course line)', checkpoints: '', laps: '', showoff: '' };
  let courseCtl: { updateDisplay(): void } | null = null;
  let checkpointsCtl: { updateDisplay(): void } | null = null;
  let lapsCtl: { updateDisplay(): void } | null = null;
  let showoffCtl: { updateDisplay(): void } | null = null;
  let refLaps = DEFAULT_LAPS;                         // passes the loaded reference is raced over (core/doc/race)
  const refInfo = { terrain: '(load a level to see its size)' }; // reference summary shown in-panel (was a log overlay)
  let refInfoCtl: { updateDisplay(): void } | null = null;
  /** What the loaded mountain COSTS, in the Reference panel beside the picker: the same census
   *  `/api/level-census` prices the whole library with, so one mountain's rows and the comparison table can
   *  never disagree. Priced on its own request, because it reads every mesh in the folder and must not hold
   *  up the terrain the picker was actually asked for. */
  const costInfo = { props: NO_COST, tris: NO_COST, textures: NO_COST, scene: NO_COST, sound: NO_COST };
  const costCtl: Record<keyof typeof costInfo, { updateDisplay(): void } | null> =
    { props: null, tris: null, textures: null, scene: null, sound: null };
  let costGeneration = 0;
  /** Where each map folder in the library came from, as `/api/levels` lists it (core/export/origin.ts): an
   *  extract of a retail course and which slot, or an authored export and whether it borrows retail art. Shown
   *  under the picker as the loaded reference's `origin` row, so what is in the slot says what it is. */
  let mapOrigins = new Map<string, ReferenceMapSummary>();
  const originInfo = { origin: NO_COST };
  let originCtl: { updateDisplay(): void } | null = null;
  let refMesh: ReferenceMesh | null = null; // the loaded reference (kept for the lighting study)
  let refGeneration = 0;                    // changes as soon as a new reference load starts
  let refLoadStatusToken: number | null = null;
  let refOwner: ReferenceOwner | null = null; // binds level + mesh + patches to one completed load
  let refLightingIntent: LitView = 'lightmap'; // desired study view, even while its data is still loading
  let refLightmapStatus: 'idle' | 'loading' | 'ready' | 'missing' | 'placeholder' | 'error' = 'idle';
  let refLightmapRequest: { owner: ReferenceOwner; promise: Promise<void> } | null = null;
  let refEffectsRequest: { owner: ReferenceOwner; promise: Promise<void> } | null = null;
  let refEffectsReadyOwner: ReferenceOwner | null = null;
  let refProps: LevelProps | null = null;   // the loaded reference's placed props (fetched on demand from /api/props)
  let refPropsRequest: { owner: ReferenceOwner; promise: Promise<void> } | null = null;
  let refLightsLoading = false;             // ditto for the light-rig overlay (fetched on demand from /api/lightrig)
  let refGlowLoading = false;               // ditto for the rig-glow bake (Local lights folding the rig in)
  let refRigLightBuf: Float32Array | null = null; // the loaded reference's rig lighting term (per-vertex RGB, strength 1), baked once
  let rigLightStrength = 0.7;               // how strongly the rig glow adds over the recovered sun model (Scene ▸ Lighting)
  let refSun: SunFit | null = null;         // the sun direction recovered from its baked lightmap (Stage B)
  let refModel: ShadeModel | null = null;   // current best-fit ambient/diffuse for the active terms
  let refSunColor: [number, number, number] | null = null; // recovered sun colour (per-channel fit)
  let refSkyColor: [number, number, number] | null = null; // recovered ambient / sky (shadow) colour
  let refShadow: Float32Array | null = null; // cached cast-shadow bake along refSun.dir (Stage C)
  let refAO: Float32Array | null = null;     // cached ambient-occlusion bake
  const lightReadout = { fit: '', sun: '', col: '', chk: '' };
  let fitCtl: { updateDisplay(): void } | null = null;
  let sunCtl: { updateDisplay(): void } | null = null;
  let colCtl: { updateDisplay(): void } | null = null;
  let chkCtl: { updateDisplay(): void } | null = null;
  let updateLightPanelVis: (() => void) | null = null;       // refresh which lighting-study controls are shown (view + rig-glow gating)
  let selectedReferenceLight: { level: string; light: RigLight } | null = null;
  let selectedReferenceLightFolder: GUI | null = null;
  /** The level combo and its "nothing loaded" entry, so a checkpoint taking the slot can put the combo back
   *  to neutral — the slot is holding this map's own past rather than an extracted level. */
  let levelCtl: { updateDisplay(): void } | null = null;
  let neutralLevel = '';
  let referenceNote: HTMLElement | null = null;
  /** What the slot is showing when it is showing a checkpoint rather than an extracted level (docs/040). */
  let refDocument: string | null = null;

  function refreshMountainName(): void {
    const mountainName = store.mdoc.name.trim() || 'Mountain';
    if (referenceNote)
      referenceNote.textContent = `Choose a read-only mountain to compare with ${mountainName}. It does not change ${mountainName}.`;
    if (selectedReferenceLight) rebuildSelectedReferenceLightDetails();
  }

  function rebuildSelectedReferenceLightDetails() {
    selectedReferenceLightFolder?.destroy();
    selectedReferenceLightFolder = null;
    if (!selectedReferenceLight) return;
    selectedReferenceLightFolder = lightFolder.addFolder('Selected light');
    addReferenceLightDetails(selectedReferenceLightFolder, selectedReferenceLight.level, selectedReferenceLight.light,
      store.mdoc.name.trim() || 'Mountain');
    selectedReferenceLightFolder.open();
    lightFolder.open();
  }

  /** Feed the same recovered record into Scene's lighting study that Props shows for a clicked reference bulb. */
  function setSelectedLightDetails(level: string | null, light: RigLight | null) {
    selectedReferenceLight = level !== null && light !== null ? { level, light } : null;
    rebuildSelectedReferenceLightDetails();
    if (selectedReferenceLight && store.currentMode === 'info') selectScene('lighting');
  }

  /** Inject an ✕ button into a level dropdown's widget (beside the <select>) that clears the loaded
   *  reference and snaps the combo back to its neutral "(none)" entry. */
  function addRefClearButton(ctl: { domElement: HTMLElement; $widget: HTMLElement; updateDisplay(): void }, opts: string[]) {
    ctl.domElement.classList.add('ref-has-clear');
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ref-clear-btn';
    x.textContent = '✕';
    x.title = 'clear the loaded reference';
    x.addEventListener('click', e => {
      e.stopPropagation();
      const neutral = opts.find(o => o.startsWith('(')) ?? opts[0]; // back to "(none)" (clears via the dropdown's onChange path too)
      if (refState.level !== neutral) { refState.level = neutral; ctl.updateDisplay(); }
      clearReference();
    });
    ctl.$widget.appendChild(x);
  }

  /**
   * What the picked mountain IS, under the picker: the folder's own `Origin.json` answer, as the listing
   * carried it. Two facts in one row — who wrote the folder, and whether retail bytes are in it — because an
   * authored mountain that places one borrowed tree is both, and a single word would hide that.
   */
  function describeOrigin(map: ReferenceMapSummary | undefined): string {
    if (!map) return '(not in the library listing — reload to refresh)';
    if (map.origin === 'retail') {
      if (map.reasons.includes(UNIDENTIFIED_FOLDER_REASON)) return 'unidentified folder · read as retail';
      if (map.course) return `SSX Tricky extract · ${map.course}`;
      return map.reasons.length === 1 && map.reasons[0] === RETAIL_EXTRACT_REASON
        ? 'SSX Tricky extract'
        : 'retail folder';
    }
    if (!map.retailData) return 'authored in Slopesmith · no retail data';
    if (map.reasons.includes(UNCLASSIFIED_EXPORT_REASON)) return 'authored in Slopesmith · unclassified legacy export';
    const borrowed = map.reasons.filter(reason => reason.startsWith('retail-')).map(reason => reason.slice('retail-'.length));
    return `authored in Slopesmith · borrows retail ${borrowed.join(', ') || 'art'}`;
  }

  function buildOriginRow(): void {
    const controller = refFolder.add(originInfo, 'origin').name('origin').disable();
    controller.domElement.classList.add('sp-detail');
    originCtl = controller;
    tip(controller,
      'Where this map folder came from, read from its producer’s Origin.json.',
      '“SSX Tricky extract” is a course `snowknife import` read off a disc, named by its slot. “Authored in '
      + 'Slopesmith” is an export, followed by whether its classification found borrowed retail art and in '
      + 'which channels. A folder nothing identifies is read as retail rather than as clean.');
  }

  /** The origin row for the level in the slot, or the neutral dash when nothing (or a checkpoint) is there. */
  function showOrigin(level: string | null): void {
    originInfo.origin = level ? describeOrigin(mapOrigins.get(level)) : NO_COST;
    originCtl?.updateDisplay();
  }

  /**
   * What the picked mountain costs, under the picker — and the door to the same numbers for every other
   * mountain in the library.
   *
   * A mountain loaded on its own answers "what does this look like?" and never "is what I am building
   * affordable?", because a figure like 306k baked triangles means nothing until the mountains either side of
   * it are on the same page. Four rows say what this one spends; the button opens all of them at once, with
   * the shipped courses' range pinned under every column (`ui/dialogs/mountain-stats`).
   */
  function buildCostRows(): void {
    // The same neutral readout card `detail` renders, but bound to a field this panel updates rather than to a
    // string captured at build time — the rows are rewritten on every load, not rebuilt.
    const costRow = (key: keyof typeof costInfo, name: string, help: string, more?: string) => {
      const controller = refFolder.add(costInfo, key).name(name).disable();
      controller.domElement.classList.add('sp-detail');
      costCtl[key] = controller;
      tip(controller, help, more);
    };
    costRow('props', 'props',
      'Visible placements and the distinct models behind them.',
      'Placements ÷ models is how MODULAR the mountain is: the shipped courses reach thousands of placements '
      + 'from a few hundred models, and reuse on that scale is what keeps their geometry affordable.');
    costRow('tris', 'triangles',
      'Baked triangles drawn, then the distinct art behind them.',
      'Baked = placements × per-copy geometry. Retail earns the gap between the two by instancing; a Slopesmith '
      + 'export bakes one mesh per placement, so an authored map is read against retail’s distinct column.');
    costRow('textures', 'textures',
      'Texture pages in the folder, and what they occupy at one byte per texel.',
      'Pages are what runs out first: a repacked bank is a fixed list of slots and every distinct tile a patch '
      + 'or prop material names claims one, flipbook frames included.');
    costRow('scene', 'lights · fx · rails',
      'Light records, particle placements and native splines — where a triangle-cheap mountain can still be expensive.');
    costRow('sound', 'sound',
      'The mountain’s own sound: populated SFX slots, banks, and race songs.',
      'The two shared board banks are excluded — every level carries the same copies, so counting them would '
      + 'say nothing about this one.');
    // The open mountain's own export goes to the top of that table, so the dialog is told which folder is
    // its — the same name Export lands in, resolved the same way rather than guessed from the title.
    tip(refFolder.add({
      compare: () => openMountainStatsDialog(loadedLevelName(), store.mdoc.name.trim(), exportFolderName(store.mdoc)),
    }, 'compare').name('▤ compare every mountain'),
      'Price every map folder in the library side by side.',
      'Terrain, props, triangles, texture pages, scene extras, sound and course shape — your own last export '
      + 'first, with the shipped courses’ range pinned under each column.');
  }

  /** The extracted level in the slot, or '' when it holds a checkpoint (or nothing) instead. */
  const loadedLevelName = (): string =>
    !refDocument && refState.level && !refState.level.startsWith('(') ? refState.level : '';

  function clearCostRows(): void {
    costGeneration++;
    for (const key of Object.keys(costInfo) as (keyof typeof costInfo)[]) {
      costInfo[key] = NO_COST;
      costCtl[key]?.updateDisplay();
    }
  }

  const showCost = (text: string) => {
    for (const key of Object.keys(costInfo) as (keyof typeof costInfo)[]) costInfo[key] = text;
    for (const key of Object.keys(costInfo) as (keyof typeof costInfo)[]) costCtl[key]?.updateDisplay();
  };

  /**
   * Price the loaded mountain.
   *
   * Failure is quiet — an unpriceable folder is still perfectly loadable, and a census is a convenience beside
   * the thing the picker was asked for. Quiet is not the same as SILENT, though: the one state these rows must
   * never be left in is "measuring…", because that is a promise to update them. Everything after the fetch is
   * therefore inside the `try` as well, so a served shape this build does not expect ends as a sentence in the
   * rows rather than as a rejected promise nobody awaited (`void refreshCost` is deliberately not awaited).
   */
  async function refreshCost(level: string): Promise<void> {
    const generation = ++costGeneration;
    showCost('measuring…');
    try {
      const answer = await fetchJson<LevelCensus>(`/api/level-census?level=${encodeURIComponent(level)}`);
      if (generation !== costGeneration) return; // the slot moved on while the folder was being read
      if (!answer?.level) { showCost('(could not measure this folder)'); return; }
      // An older service answers without groups this build charts; zero beats throwing, and the last row says
      // which it is rather than leaving a plausible-looking zero to be read as a measurement.
      const { census, filled } = normalizeLevelCensus(answer);
      const count = (value: number) => value.toLocaleString();
      costInfo.props = `${count(census.instances.visible)} placed · ${count(census.models.placed)} models`;
      costInfo.tris = `${count(census.bakedTris)} baked · ${count(census.geomTris)} distinct`;
      costInfo.textures = `${count(census.pages.onDisk)} pages · ${pageMegabytes(census.pages.texels).toFixed(2)} MB`;
      costInfo.scene = `${count(census.extras.lights)} · ${count(census.extras.particles)} · ${count(census.extras.splines)}`;
      costInfo.sound = filled
        ? '(server is older than this page — restart it)'
        : census.sound.slots
          ? `${count(census.sound.slots)} slots · ${count(census.sound.banks)} banks`
            + `${census.sound.songs ? ` · ${count(census.sound.songs)} songs` : ''}`
          : '(silent — no extracted audio)';
      for (const key of Object.keys(costInfo) as (keyof typeof costInfo)[]) costCtl[key]?.updateDisplay();
    } catch (error) {
      if (generation !== costGeneration) return;
      showCost('(could not measure this folder)');
      console.warn(`[reference] could not price ${level}: ${String(error)}`);
    }
  }

  async function initReference() {
    let opts: string[] = ['(dev server only)'];
    try {
      const answer = await fetchJson<{ levels?: string[]; maps?: ReferenceMapSummary[] }>('/api/levels');
      mapOrigins = new Map((answer.maps ?? []).map(map => [map.name, map]));
      const levels = answer.levels;
      if (levels && levels.length) opts = ['(none)', ...levels]; // a neutral "nothing loaded" entry to sit on / clear back to
    } catch { /* static build / server down - leave the placeholder */ }
    // re-load the reference that was open last session (if its level is still available)
    const storedRef = loadStored<StoredRef>(REF_KEY);
    const restoreRef = storedRef && opts.includes(storedRef.level) ? storedRef : null;
    refState.level = restoreRef ? restoreRef.level : opts[0]; // fresh session sits on the neutral "(none)" entry
    clearGui(refFolder);
    clearGui(refCourseFolder);
    referenceNote = note(refFolder, '');
    refreshMountainName();
    // Picking a level loads it immediately (no load button); the neutral "(none)" entry clears it.
    const combo = refFolder.add(refState, 'level', opts).name('mountain')
      .onChange((name: string) => {
        if (name && !name.startsWith('(')) void loadReference(); else clearReference();
      });
    levelCtl = combo;
    neutralLevel = opts.find(entry => entry.startsWith('(')) ?? opts[0];
    tip(combo, 'Pick a level to load it straight away; “(none)” or the ✕ clears it.');
    addRefClearButton(combo, opts); // an ✕ next to the combo to clear the loaded reference
    buildOriginRow();
    buildCostRows();
    refInfoCtl = tip(refCourseFolder.add(refInfo, 'terrain').name('terrain').disable(),
      'The loaded level’s terrain size — patch and vertex counts.');
    courseCtl = tip(refCourseFolder.add(courseInfo, 'course').name('course line').disable(),
      "This level's main racing line, recovered top-to-bottom from its SOP/AIP path tables.");
    checkpointsCtl = tip(refCourseFolder.add(courseInfo, 'checkpoints').name('checkpoints').disable(),
      'Positive type-11 events on the showoff race lines; the viewport labels their route and exact time award.',
      'These are course-progress crossings, not collisions with the flashing roadside sign models. Multiple '
      + 'path events can be alternate-route copies of one logical checkpoint.');
    lapsCtl = tip(refCourseFolder.add(courseInfo, 'laps').name('laps').disable(),
      'How many passes down this course make a race.',
      'Every retail course is a single pass except MEGAPLEX, whose four are what its finish tube exists for — '
      + 'the tube throws you back up the mountain at every crossing but the last.');
    showoffCtl = tip(refCourseFolder.add(courseInfo, 'showoff').name('showoff clock').disable(),
      'Seconds a showoff run on this course starts with.',
      'The game holds one number per course in its own executable — Garibaldi 120, most courses 90, Alaska '
      + '135 — and ends the run at zero; checkpoints add time. Nothing in the level files says it, which is '
      + 'why an authored mountain carries its number in the export instead.');
    tip(refCourseFolder.add({ build: () => buildFromReferenceCourseDialog() }, 'build').name('▶ new mountain from this course'),
      'Open the terrain-generation dialog seeded with this level’s course line.');
    rebuildOutliner();      // the reference row reflects the loaded level (or "(none loaded)")
    applySceneSelection();  // honour the current item's folder visibility now the panel is populated
    if (restoreRef) {
      // load without stealing the restored camera view (frame:false) and without changing the current
      // selection (select:false); then re-apply the saved placement offset.
      await loadReference({ frame: false, select: false });
      if (refMesh) {
        // where a previous session put it (an all-zero offset is the pre-fixed-offset era's overlay default,
        // not a drag — let those fall through to the fixed load offset)
        if (restoreRef.offset && restoreRef.offset.some(v => v !== 0)) viewport.setReferenceOffset(restoreRef.offset);
        persistRef();
      }
    }
  }

  function clearReference() {
    refGeneration++;
    refDocument = null;
    if (refLoadStatusToken !== null) { loadStatus.cancel(refLoadStatusToken); refLoadStatusToken = null; }
    viewport.setReference(null);
    onReferenceChanged(null);
    onReferenceEffects({ status: 'empty' });
    store.playSpawnRef = null; // a future reference must derive its own course-based ride default
    refMesh = null; refOwner = null; refSun = null; refModel = null; refShadow = null; refAO = null;
    refLightingIntent = 'lightmap';
    refLightmapStatus = 'idle'; refLightmapRequest = null;
    refEffectsRequest = null; refEffectsReadyOwner = null;
    refPropsRequest = null;
    refProps = null; // setReference(null) already dropped the reference props; placed props follow the global toggle
    refState.shadow = false; refState.ao = false;
    refCourse = null; refLightSeed = null; refLightCheck = null; courseInfo.course = '(load a level to read its course line)'; courseCtl?.updateDisplay();
    courseInfo.checkpoints = ''; checkpointsCtl?.updateDisplay();
    refLaps = DEFAULT_LAPS; courseInfo.laps = ''; lapsCtl?.updateDisplay();
    courseInfo.showoff = ''; showoffCtl?.updateDisplay();
    refInfo.terrain = '(load a level to see its size)'; refInfoCtl?.updateDisplay();
    showOrigin(null);                      // ...nothing to describe...
    clearCostRows();                       // ...and nothing to price
    clearGui(lightFolder);                 // no reference -> empty Reference lighting half (scene panel adds its prompt)
    musicStudy.clear();                    // ...and no PathFinder graph study
    setupRefSky(null);                     // ...and no level sky to preview or adopt
    refGlare = null; buildReferenceGlarePanel(); applyGodRays(); // ...and no course sun or stale readout
    rebuildOutliner();                     // the reference row falls back to "(none loaded)"
    applySceneSelection();                 // hide the (now empty) lighting study
    persistRef();                          // refMesh is null now -> forget the stored reference
    focusActive(); log('');
  }

  /**
   * Show a checkpoint of this map in the reference slot, beside the live mountain (docs/040).
   *
   * Comparison needs no viewer of its own. The slot already holds an authored map folder with the placement
   * controls to slide it off the live one, so a checkpoint tessellates into the same quilt an extracted level
   * does and then-and-now sit in one viewport. Nothing about the project is touched: the checkpoint is read,
   * rendered, and has no way back into the editor's grammar — Restore is what makes one the live document.
   *
   * It carries no level, so every per-level layer the slot usually grows — lightmaps, props, the light rig,
   * the effects graph, the sky, the sound study — has nothing to fetch and stays where `clearReference` left
   * it. What is drawn is shape and surface type, which is what "what changed?" is asked about.
   */
  function showDocumentReference(doc: QuadMeshDoc, label: string): void {
    clearReference();                       // whatever the slot held goes, along with its per-level layers
    const generation = ++refGeneration;
    const mesh = authoredReferenceMesh(doc);
    if (generation !== refGeneration) return; // the slot moved on while the quilt was being tessellated
    refMesh = mesh;
    refDocument = label;
    // The combo names extracted levels, and this is not one, so it goes back to its "nothing loaded" entry
    // rather than sitting on a name that no longer describes what is in the slot.
    if (refState.level !== neutralLevel) { refState.level = neutralLevel; levelCtl?.updateDisplay(); }
    viewport.setReference(mesh, label, true);
    const verts = (mesh.positions.length / 3) | 0;
    refInfo.terrain = `${label} · ${mesh.patchCount.toLocaleString()} patches · ${verts.toLocaleString()} verts`;
    refInfoCtl?.updateDisplay();
    courseInfo.course = '(a checkpoint of this map — its run is not recovered)';
    courseCtl?.updateDisplay();
    courseInfo.checkpoints = ''; checkpointsCtl?.updateDisplay();
    // A checkpoint is not a map folder, so there is nothing to price: the census reads Models/Instances/
    // Materials off disk, and a snapshot of the document in progress has none of them. `clearReference` above
    // already put the rows back to neutral; this only says WHY they are empty.
    costInfo.props = '(a checkpoint — export it to price it)';
    costCtl.props?.updateDisplay();
    originInfo.origin = '(a checkpoint of this map — not a map folder)';
    originCtl?.updateDisplay();
    // A checkpoint is a snapshot of the mountain being built, so its race is the document's own, not a level's.
    refLaps = DEFAULT_LAPS; courseInfo.laps = ''; lapsCtl?.updateDisplay();
    courseInfo.showoff = ''; showoffCtl?.updateDisplay();
    setupLightingUi();      // no baked lightmap to study, so the study half says so rather than going stale
    rebuildOutliner();
    applySceneSelection();
    selectScene('info');
    log('');
  }

  function ensureReferenceEffects(): Promise<void> {
    const owner = refOwner;
    if (!owner || owner.generation !== refGeneration || owner.level !== refState.level) return Promise.resolve();
    if (refEffectsReadyOwner === owner) return Promise.resolve();
    if (refEffectsRequest?.owner === owner) return refEffectsRequest.promise;
    const promise = (async () => {
      const level = owner.level;
      const trace = beginDiagnosticPhase('effects', `${level}:load-total`);
      onReferenceEffects({ status: 'loading', level });
      try {
        const payload = await fetchJson<ReferenceEffectsPayload>(`/api/effects?level=${encodeURIComponent(level)}`);
        if (refOwner !== owner) { trace.complete('cancelled after request'); return; }
        const data = runDiagnosticPhase('effects', `${level}:decode`, () => decodeReferenceEffects(payload),
          `${payload.instances.length} instances`);
        runDiagnosticPhase('effects', `${level}:publish`, () => onReferenceEffects({ status: 'ready', data }));
        refEffectsReadyOwner = owner;
        trace.complete(`${data.instances.length} instances · ${data.document.graphs.length} graphs`);
      } catch (error) {
        trace.fail(error);
        if (refOwner !== owner) return;
        onReferenceEffects({ status: 'error', level, message: error instanceof Error ? error.message : String(error) });
      }
    })().finally(() => {
      if (refEffectsRequest?.promise === promise) refEffectsRequest = null;
    });
    refEffectsRequest = { owner, promise };
    return promise;
  }

  /**
   * Decode the level's lightmaps (the unique LightmapIDs its patches use) into A_S intensity maps. The
   * PNG's alpha channel is the baked light intensity; RGB is the base-entangled residual we don't need.
   */
  async function decodeLightmaps(level: string, patches: RawPatch[]): Promise<LightmapSet> {
    const ids = new Set<number>();
    for (const p of patches) if (p.LightmapID != null) ids.add(p.LightmapID);
    const maps: LightmapSet = new Map();
    await Promise.all([...ids].map(async id => {
        const resp = await fetch(`/api/lightmap?level=${encodeURIComponent(level)}&id=${id}`);
        if (resp.status === 404) return; // a genuinely absent extracted map leaves those patches neutral
        if (!resp.ok) throw new Error(`lightmap ${id}: ${resp.status} ${resp.statusText}`.trim());
        const bmp = await createImageBitmap(await resp.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        const cv = document.createElement('canvas'); cv.width = bmp.width; cv.height = bmp.height;
        const ctx = cv.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const { data } = ctx.getImageData(0, 0, bmp.width, bmp.height);
        const px = bmp.width * bmp.height;
        const a = new Float32Array(px), rgb = new Float32Array(px * 3); // A_S + the coloured multiply
        for (let i = 0; i < px; i++) {
          a[i] = data[i * 4 + 3] / 255; // alpha = A_S (intensity)
          // reconstruct the coloured light L = (0.5 - C_S) x (A_S x 255/128) via the SHARED GS display decode
          // the user's baked-lightmap view also uses, so the two views are on one scale.
          const [r, g, b] = decodeLightmapTexel(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]);
          rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
        }
        maps.set(id, { a, rgb });
    }));
    return maps;
  }

  /** Load and sample the lighting study without rebuilding the visible terrain. Boot restoration leaves this
   * idle; a fresh reference choice, the study's load button, or another lighting consumer starts it. */
  function ensureReferenceLightmaps(): Promise<void> {
    const owner = refOwner;
    if (!owner || owner.generation !== refGeneration || owner.level !== refState.level || !owner.patches.length) return Promise.resolve();
    if (refLightmapStatus === 'ready' || refLightmapStatus === 'missing' || refLightmapStatus === 'placeholder') return Promise.resolve();
    if (refLightmapRequest?.owner === owner) return refLightmapRequest.promise;
    refLightmapStatus = 'loading';
    setupLightingUi();
    const promise = (async () => {
      try {
        const layout = referenceLightmapLayoutStats(owner.patches);
        if (layout.collapsed) {
          if (refOwner !== owner) return;
          refLightmapStatus = 'placeholder';
          setupLightingUi();
          log(`lighting study skipped: ${layout.assigned} patches share only ${layout.unique} placeholder tile`);
          return;
        }
        const lightmaps = await decodeLightmaps(owner.level, owner.patches);
        if (refOwner !== owner) return;
        if (!lightmaps.size) {
          refLightmapStatus = 'missing';
          setupLightingUi();
          return;
        }
        if (!applyReferenceLightmaps(owner.mesh, owner.patches, lightmaps)) {
          refLightmapStatus = 'placeholder';
          setupLightingUi();
          return;
        }
        refSun = owner.mesh.intensity ? fitSun(owner.mesh.normals, owner.mesh.intensity) : null;
        refSunColor = refSkyColor = null;
        if (owner.mesh.lightColor && refSun) {
          const recovered = recoverColors(owner.mesh.normals, owner.mesh.lightColor, refSun.dir);
          refSunColor = recovered.sun; refSkyColor = recovered.sky;
        }
        recomputeModel();
        refLightCheck = null;
        if (refLightSeed && refSun && owner.mesh.intensity) {
          const recordDir = sunDirFromElAz(refLightSeed.el, refLightSeed.az);
          const pinned = fitSun(owner.mesh.normals, owner.mesh.intensity, recordDir);
          refLightCheck = checkRecordSun(recordDir, refSun.dir, refLightSeed.sun, pinned.diffuse, pinned.ambient);
        }
        refLightmapStatus = 'ready';
        setupLightingUi();
      } catch (error) {
        if (refOwner !== owner) return;
        refLightmapStatus = 'error';
        setupLightingUi();
        log(`lighting study failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })().finally(() => {
      if (refLightmapRequest?.promise === promise) refLightmapRequest = null;
    });
    refLightmapRequest = { owner, promise };
    return promise;
  }

  /** A manual study load/retry also resumes the effective Local lights layer once the base model is available. */
  function requestLightingStudy() {
    void ensureReferenceLightmaps().then(() => {
      if (refLightmapStatus === 'ready' && localLightsVisible()) void ensureRefGlow();
    });
  }

  /** Push the Tricks view filter to the viewport: the rails / gems you author AND the loaded reference world's
   *  own rail / gem models (which come from the reference prop payload — the extractor ships them as props —
   *  loaded on demand the first time either overlay wants it). Re-runs the scene build so the authored rail /
   *  gem groups pick up the new visibility. */
  function applyTricksVisible() {
    viewport.showTricks(store.tricksVisible);            // authored rails + gems
    ensureRefOverlays();                           // the reference's rail / gem models ride in the prop payload
    viewport.showReferenceTricks(store.tricksVisible && !!refMesh);
    scheduleRebuild();
  }

  /** Load Instances.json when Props, Tricks, or Sources needs it. The same payload carries scenery, native
   * rail/gem models, and every prop-attached external sound record. */
  function ensureRefOverlays() {
    if (!refMesh || (!store.propsVisible && !store.tricksVisible && !store.lightRigVisible)) return;
    if (viewport.hasReferenceProps()) return; // already built for this level
    void ensureRefProps();
  }

  /** Tricks filter on/off (the top-bar star pill): show / hide the whole trick layer — rails + gems together. */
  function toggleTricks() {
    store.tricksVisible = !store.tricksVisible;
    applyTricksVisible();
    persistUi();
  }

  /** Global props on/off (the top-bar pill): flip and apply to the placed + reference props. */
  function toggleProps() {
    store.propsVisible = !store.propsVisible;
    applyPropsVisible();
    persistUi();
  }

  /** Push the global props visibility to the placed props and the loaded reference's SCENERY props — loading the
   *  reference's prop payload the first time it's wanted (per level, via ensureRefProps). The reference's rail /
   *  gem models ride in the same payload but follow the Tricks filter, not this one. */
  function applyPropsVisible() {
    viewport.setPlacedPropsVisible(store.propsVisible);
    ensureRefOverlays(); // load the reference prop payload if Props (or Tricks) wants it
    viewport.showReferenceProps(store.propsVisible && !!refMesh);
  }

  /**
   * Build the loaded reference's prop payload once (fetched per level via ensurePropLevel, which shares the cache
   * with prop placement) and show it, honouring BOTH the Props filter (scenery) and the Tricks filter (its rail /
   * gem models, split out by viewport.setReferenceProps). Guards a double fetch and a reference change mid-flight.
   * A level carries thousands of props, so the first show fetches a few MB.
   */
  function ensureRefProps(): Promise<void> {
    const owner = refOwner;
    if (!owner || owner.generation !== refGeneration
      || (!store.propsVisible && !store.tricksVisible && !store.lightRigVisible)) return Promise.resolve();
    if (refPropsRequest?.owner === owner) return refPropsRequest.promise;
    if (viewport.hasReferenceProps()) { // already built for this level — just apply both overlays' visibility
      viewport.showReferenceProps(store.propsVisible); viewport.showReferenceTricks(store.tricksVisible);
      return Promise.resolve();
    }
    const level = owner.level;
    const sharedStatusToken = refLoadStatusToken;
    const statusToken = sharedStatusToken ?? loadStatus.begin({
      title: `Loading ${level}`,
      label: 'Loading reference props',
      detail: 'Waiting for model geometry and collision data',
      progress: 82,
    });
    const ownsStatus = sharedStatusToken === null;
    const promise = (async () => {
      const trace = beginDiagnosticPhase('props', `${level}:load-total`);
      try {
        loadStatus.update(statusToken, {
          progress: 82,
          label: 'Loading reference props',
          detail: 'Waiting for model geometry and collision data',
        });
        await loadStatus.afterPaint();
        const lp = await ensurePropLevel(level);
        if (refOwner !== owner) {
          trace.complete('cancelled after request');
          if (ownsStatus) loadStatus.cancel(statusToken);
          return;
        }
        loadStatus.update(statusToken, {
          progress: 91,
          label: 'Building reference props',
          detail: `${lp.models.length.toLocaleString()} models · ${lp.instances.length.toLocaleString()} placements`,
        });
        await loadStatus.afterPaint();
        refProps = lp;
        await viewport.setReferencePropsProgressive(lp, loadStatus.yieldToBrowser);
        if (refOwner !== owner) {
          trace.complete('cancelled during scene build');
          if (ownsStatus) loadStatus.cancel(statusToken);
          return;
        }
        viewport.showReferenceProps(store.propsVisible);   // scenery follows the Props filter
        viewport.showReferenceTricks(store.tricksVisible); // its rail / gem models follow the Tricks filter
        loadStatus.update(statusToken, {
          progress: 97,
          label: 'Installing reference props',
          detail: `${lp.instances.length.toLocaleString()} placements ready`,
        });
        toast(`${lp.instances.length.toLocaleString()} props · ${lp.models.length} models`, 'ok');
        trace.complete(`${lp.models.length} models · ${lp.instances.length} instances`);
        if (ownsStatus) await loadStatus.finish(statusToken, {
          label: `${level} props ready`,
          detail: `${lp.instances.length.toLocaleString()} placements loaded`,
        });
      } catch (e) {
        trace.fail(e);
        if (refOwner === owner) toast(`props load failed: ${e}`, 'err');
        if (ownsStatus) await loadStatus.fail(statusToken, e instanceof Error ? e.message : String(e));
      }
    })().finally(() => {
      if (refPropsRequest?.promise === promise) refPropsRequest = null;
    });
    refPropsRequest = { owner, promise };
    return promise;
  }

  /** Sources overlay on/off (stored under the legacy lightRig key): compact clickable bulbs for reference and
   * authored lights plus speakers for reference prop emitters. One selected source expands its rig/range;
   * the light those sources cast rides effective Local lights (ensureRefGlow / withRig / applyPropLightsVisible). */
  function toggleLights() {
    store.lightRigVisible = !store.lightRigVisible;
    applyLightsVisible();
    persistUi();
  }

  const localLightsVisible = () => sunLight.on && store.propLightsVisible;

  /** Tint the loaded reference's props by its rig (a sign light lighting up its billboard), scaled by the same
   *  strength as the terrain glow. Local lights are subordinate to the master Lighting preview. */
  function applyPropRigLighting() {
    const rig = localLightsVisible() ? lightRigs.get(refState.level) ?? null : null;
    viewport.setPropRigLighting(rig, rigLightStrength);
  }

  /** Push the persisted Sources switch (legacy storage name) to the combined layer: sound markers are already
   * available with props, reference bulbs load lazily, and authored bulbs are local. Expanded rig/range lines
   * remain inspection-only; the light they cast rides Lighting's Local lights option. */
  function applyLightsVisible() {
    if (store.lightRigVisible && refMesh) {
      viewport.showReferenceLights(true); // speakers do not depend on the separately fetched Lights.json
      ensureRefOverlays();
      if (!viewport.hasReferenceLights()) void ensureRefLights();
    } else {
      viewport.showReferenceLights(false);
    }
    viewport.showAuthoredLightRig(store.lightRigVisible);
    // Video screens ride Sources with the bulbs and the speakers: all three are markers at the places the
    // world emits something, wanted while you are asking that question and clutter the rest of the time
    // (docs/051).
    viewport.showScreens(store.lightRigVisible);
  }

  /** Push the effective master Lighting + Local lights state to authored glow/tint and Play presentation. */
  function applyPropLightsVisible() {
    viewport.showAuthoredLights(localLightsVisible());
    viewport.setPlayLightingVisibility(sunLight.on);
    scheduleRebuild(); // re-run setPlacedProps so the billboard tint tracks the toggle
  }

  /** Apply the advanced Local lights preference. Enabling it also enables the master Lighting preview so the
   *  result is immediately visible; disabling it leaves the sun/sky/shadow result intact. */
  function applyLocalLightsPreference() {
    if (store.propLightsVisible) {
      if (!sunLight.on) {
        sunLight.on = true;
        applySunLight(true);
      }
      if (!viewport.hasAuthoredLights() && !(store.mdoc.lights?.length) && !refMesh)
        toast('no course lights yet — Add light drops one, and a billboard brings its own sign light', 'warn');
      void ensureRefGlow();      // reference side: bake + fold its rig's light (fetches the rig on demand)
    }
    applyReferenceLighting();
    applyPropRigLighting();
    updateLightPanelVis?.();
    applyPropLightsVisible();
    sunFolder.controllers.forEach(c => c.updateDisplay());
    refreshLighting();
    persistUi();
  }

  function togglePropLights() {
    store.propLightsVisible = !store.propLightsVisible;
    applyLocalLightsPreference();
  }

  /** Fetch + decode a level's light rig once (cached in lightRigs, shared by the gizmo overlay and the
   *  Local lights glow). Null when the level ships no Lights.json. */
  async function fetchRefRig(level: string): Promise<LightRig | null> {
    let rig = lightRigs.get(level);
    if (rig) { pushRefGlints(level, rig); return rig; }
    const payload = await fetchJson<LightRigPayload>(`/api/lightrig?level=${encodeURIComponent(level)}`);
    if (!payload.lights?.length) return null;
    rig = decodeLightRig(payload);
    lightRigs.set(level, rig);
    pushRefGlints(level, rig);
    return rig;
  }

  /** The level's own GLINTS — the sparkle its lamps and flares draw, gated by the engine's `SpriteRes & 0x70`
   *  (docs/047). Pushed from the one rig funnel (including a cache hit, since a reference reload clears them)
   *  so the sparkle shows from EITHER path that wants a rig: Sources' bulbs or Local lights' glow. A rig
   *  fetched for a level that is no longer loaded is dropped, as everywhere else here. */
  function pushRefGlints(level: string, rig: LightRig) {
    if (level === refState.level && refMesh) viewport.setReferenceGlints(rig);
  }

  /**
   * Build the loaded reference's light source markers once (the rig fetched per level, cached) and show them,
   * honouring the toggle. Guards a double fetch and a reference change mid-flight.
   */
  async function ensureRefLights() {
    if (!refMesh || !store.lightRigVisible) return;
    if (viewport.hasReferenceLights()) { viewport.showReferenceLights(true); return; } // already built for this level
    if (refLightsLoading) return;
    refLightsLoading = true;
    const level = refState.level;
    try {
      const rig = await fetchRefRig(level);
      if (!rig) { toast(`no Lights.json sources for ${level}`, 'warn'); return; }
      if (level !== refState.level || !refMesh) return; // the reference changed while we were fetching — drop it
      viewport.setReferenceLights(rig);
      viewport.showReferenceLights(store.lightRigVisible && !!refMesh);
      const shown = rig.lights.filter(l => !l.negative && l.kind !== 'ambient').length;
      const shadow = rig.counts.neg ?? 0;
      const sign = rig.counts.sign ?? 0;
      toast(`${level}: ${shown} light sources${sign ? ` (${sign} sign)` : ''}${shadow ? ` + ${shadow} shadow` : ''}`, 'ok');
    } catch (e) {
      toast(`light rig load failed: ${e}`, 'err');
    } finally {
      refLightsLoading = false;
    }
  }

  /**
   * Fold the loaded reference's rig LIGHT into the view when Local lights is effectively on: bake its per-vertex glow term
   * once per level (independent of the sun sliders; the rig fetched on demand, shared cache with the gizmo
   * overlay) and tint the props the rig aims at.
   *
   * It does NOT touch the study's view. It used to force 'model' so the glow read at once, which had two
   * failure modes: the pill persists, so every reference load silently opened on the reconstruction rather
   * than the baked ground truth; and because this function awaits a decode and a fetch before applying, a
   * view the user picked in the meantime got stomped when it resumed — the study looked stuck on 'model'.
   * The pill is a light-layer toggle and the view is the user's selection; they are now independent, and the
   * panel says where the glow shows instead of moving them there.
   */
  async function ensureRefGlow() {
    const owner = refOwner;
    if (!owner || owner.generation !== refGeneration || !localLightsVisible()) return;
    await ensureReferenceLightmaps();
    if (refOwner !== owner || !owner.mesh.intensity || !localLightsVisible()) return;
    if (!refRigLightBuf) {
      if (refGlowLoading) return;
      refGlowLoading = true;
      try {
        const rig = await fetchRefRig(owner.level);
        if (!rig || refOwner !== owner || !localLightsVisible()) return; // no rig, or things changed mid-fetch
        refRigLightBuf = bakeRigLighting(owner.mesh.positions, owner.mesh.normals, rig);
      } catch (e) {
        toast(`light rig load failed: ${e}`, 'err');
        return;
      } finally {
        refGlowLoading = false;
      }
    }
    applyReferenceLighting();  // fold the rig glow into the terrain (a no-op unless the study is in model view)
    applyPropRigLighting();    // …and light the props it aims at (billboards under their sign lights)
    updateLightPanelVis?.();   // the panel's "where the glow shows" hint follows the pill
  }

  async function loadReference(opts: { frame?: boolean; select?: boolean } = {}) {
    const name = refState.level;
    if (!name || name.startsWith('(')) return;
    const generation = ++refGeneration;
    const statusToken = loadStatus.begin({
      title: `Loading ${name}`,
      label: 'Downloading reference terrain',
      detail: 'Waiting for the extracted mountain data',
      progress: 5,
    });
    refLoadStatusToken = statusToken;
    log(`loading ${name} terrain...`);
    try {
      const body = await fetchJson<Record<string, unknown> & {
        error?: string;
        patches: RawPatch[];
        textureRevisions?: Record<string, string>;
      }>(
        `/api/level?name=${encodeURIComponent(name)}`,
      );
      if (body.error) {
        log(`load failed: ${body.error}`);
        await loadStatus.fail(statusToken, body.error);
        return;
      }
      if (generation !== refGeneration || name !== refState.level) { loadStatus.cancel(statusToken); return; }
      registerReferenceTextureRevisions(name, body.textureRevisions ?? {});
      const patches = body.patches as RawPatch[];
      // Terrain is the useful first paint. Lightmaps and the multi-MB effects graph attach later, on demand.
      loadStatus.update(statusToken, {
        progress: 28,
        label: 'Building reference terrain',
        detail: `${patches.length.toLocaleString()} patches to tessellate`,
      });
      await loadStatus.afterPaint();
      const mesh = await runDiagnosticPhaseAsync('reference', `${name}:terrain-build`,
        () => buildReferenceMeshProgressive(patches, {
          frameBudgetMs: 10,
          yieldControl: loadStatus.yieldToBrowser,
          onProgress: (completed, total) => loadStatus.update(statusToken, {
            progress: 28 + (total ? 36 * completed / total : 36),
            detail: `${completed.toLocaleString()} / ${total.toLocaleString()} patches tessellated`,
          }),
        }), `${patches.length} patches`);
      if (generation !== refGeneration || name !== refState.level) { loadStatus.cancel(statusToken); return; }
      loadStatus.update(statusToken, {
        progress: 68,
        label: 'Installing reference terrain',
        detail: `${((mesh.positions.length / 3) | 0).toLocaleString()} rendered vertices`,
      });
      await loadStatus.afterPaint();
      refMesh = mesh;
      refOwner = { generation, level: name, mesh, patches };
      refLightingIntent = 'lightmap';
      refLightmapStatus = 'idle'; refLightmapRequest = null;
      refEffectsRequest = null; refEffectsReadyOwner = null;
      refPropsRequest = null;
      refSun = null; refSunColor = refSkyColor = null;
      refShadow = null; refAO = null; refState.shadow = false; refState.ao = false;
      recomputeModel(); // plain sun fit until shadow/AO are toggled on
      runDiagnosticPhase('reference', `${name}:terrain-install`,
        () => viewport.setReference(mesh, name, opts.frame !== false),
        `${((mesh.positions.length / 3) | 0).toLocaleString()} vertices`); // boot-restore preserves the restored view
      onReferenceEffects({ status: 'idle', level: name });
      store.playSpawnRef = null; // a saved click/default belonged to the previous reference level
      viewport.setReferenceSplines((body.splines as RefSplineRaw[] | null) ?? null); // stable table shared by grind and effect routes
      refProps = null; // props are per-level; setReference dropped the old meshes — staged in after the terrain paint
      refRigLightBuf = null; // the rig lighting term is per-level; rebuilt when effective Local lights is on
      refCourse = (body.course as RefCourse | null) ?? null; // the level's recovered main course line
      viewport.setReferenceCourse(refCourse ? refCourse.points : null, refCourse); // the route + the level's real start/finish
      viewport.setReferenceAiPaths((body.aiPaths as RefAiPath[] | null) ?? null); // its AI network, for the "Show AI paths" overlay
      // The level's own video screens (its Billboards.json, measured by `snowknife billboards`): selectable
      // read-only, never adopted. Keep the detector identity beside the pose so its inspector can name the
      // exact billboard, native instance row and texture page that rectangle is meant to cover (docs/051).
      viewport.setReferenceScreens(((body.billboards as ReferenceScreen[] | undefined) ?? []).map(screen => ({
        level: name,
        name: screen.name,
        ...(screen.family ? { family: screen.family } : {}),
        ...(screen.instance !== undefined ? { instance: screen.instance } : {}),
        ...(screen.page ? { page: screen.page } : {}),
        width: screen.width,
        height: screen.height,
        pose: screenPoseFromAxes(screen.center, screen.normal, screen.up, screen.width, screen.height),
      })));
      refLightSeed = (body.light as RefSunSeed | null) ?? null; // the level's TRUE sun, seeded from its own Lights.json records
      // The level's own glare, straight from its World.json. Shown, not adopted: the ⟶ button in the panel
      // is what copies it onto the document, the same way a level's sky is offered rather than taken.
      refGlare = body.world ? normalizeGodRayCourse(body.world as Partial<GodRayCourse>) : null;
      buildReferenceGlarePanel();
      refLightCheck = null;
      loadStatus.update(statusToken, {
        progress: 74,
        label: 'Restoring reference scene layers',
        detail: 'Course, AI paths, lighting, sky, and object layers',
      });
      courseInfo.course = refCourse
        ? `${refCourse.source} · ${(refCourse.length / 1000).toFixed(2)} km, ${Math.round(refCourse.drop)} m drop`
        : '(no course line in this level)';
      courseCtl?.updateDisplay();
      const checkpoints = refCourse?.checkpoints ?? [];
      const logical = new Map(checkpoints.map(checkpoint => [checkpoint.group, checkpoint]));
      courseInfo.checkpoints = checkpoints.length
        ? `${logical.size} logical / ${checkpoints.length} path · ${[...new Set(checkpoints
          .map(checkpoint => checkpoint.bonusSeconds))].map(seconds => `+${seconds}s`).join(', ')}`
        : 'none';
      checkpointsCtl?.updateDisplay();
      refLaps = normalizeLaps(body.laps) ?? DEFAULT_LAPS;
      courseInfo.laps = refLaps === 1 ? '1 (single pass)' : `${refLaps}`;
      lapsCtl?.updateDisplay();
      // The server answers this for an authored folder from its own sidecar and for a retail level from the
      // slot table, so the row reads the same way either way (core/doc/race).
      const refShowoff = normalizeShowoffSeconds(body.showoffSeconds) ?? DEFAULT_SHOWOFF_SECONDS;
      courseInfo.showoff = refShowoff === 0 ? 'none (no showoff event)' : `${refShowoff} s`;
      showoffCtl?.updateDisplay();
      viewport.setReferenceShowoffSeconds(refShowoff); // what a showoff ride on this reference counts down
      viewport.setReferenceLaps(refLaps); // what a reference Play counts down, and what gates its lap volumes
      setupLightingUi();
      void musicStudy.setLevel(name);
      setupRefSky(name);   // this level's own sky: its horizon panorama + the ⟶ button that adopts it
      applyGodRays();      // ...and its sun's beams, when this course shipped with any (docs/049)
      if (opts.select === false) { rebuildOutliner(); applySceneSelection(); } // boot-restore keeps the current selection (ref stays unselected)
      else selectScene('info'); // a fresh load returns to Reference, where both positionable worlds are framed
      persistRef(); // remember this level so a reload re-loads it
      onReferenceChanged(name);
      const verts = (mesh.positions.length / 3) | 0;
      refInfo.terrain = `${mesh.patchCount.toLocaleString()} patches · ${verts.toLocaleString()} verts`;
      refInfoCtl?.updateDisplay(); // the summary lives in the Reference panel, not a viewport overlay
      showOrigin(name);            // what this folder is, from the listing already in hand
      void refreshCost(name);      // priced on its own request: reading every mesh must not delay the terrain
      log(''); // clear the transient "loading…" line so nothing overlays the view
      loadStatus.update(statusToken, {
        progress: 77,
        label: 'Reference terrain ready',
        detail: `${mesh.patchCount.toLocaleString()} patches loaded · preparing requested scene layers`,
      });
      if (refOwner?.generation !== generation) return;
      await loadStatus.afterPaint();
      if (refOwner?.generation !== generation) return;

      // Effects identity goes first when requested, so the following prop build incorporates its material /
      // animation partitions once instead of rebuilding. Both remain on the shared central loading surface.
      if (store.currentMode === 'effects' || store.worldEffectsVisible) {
        loadStatus.update(statusToken, {
          progress: 79,
          label: 'Loading reference effects',
          detail: 'Preparing effect attachments and animated prop partitions',
        });
        await ensureReferenceEffects();
      }
      if (refOwner?.generation !== generation) return;
      applyPropsVisible(); // global props toggle: progressively build + show this level's scenery (default on)
      applyLightsVisible(); // Sources: fetch its bulb/speaker markers only after the useful first paint
      applyTricksVisible(); // Tricks: shares the in-flight prop payload and applies its own visibility gate
      if (store.propsVisible || store.tricksVisible || store.lightRigVisible) await ensureRefProps();
      if (refOwner?.generation !== generation) return;

      // Attach the lighting study last. A restored reference stays lean when Local lights are disabled;
      // when enabled the study is their required base and the rig follows the same request.
      if (opts.select !== false || localLightsVisible()) requestAnimationFrame(() => {
        if (refOwner?.generation !== generation) return;
        if (localLightsVisible()) void ensureRefGlow();
        else void ensureReferenceLightmaps();
      });
      // ensureRefProps assigns through its guarded async owner; keep that post-await fact explicit for TS.
      const loadedProps = refProps as LevelProps | null;
      await loadStatus.finish(statusToken, {
        label: `${name} ready`,
        detail: `${mesh.patchCount.toLocaleString()} patches loaded${viewport.hasReferenceProps()
          ? ` · ${(loadedProps?.instances.length ?? 0).toLocaleString()} props loaded` : ''}`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`load failed: ${message}`);
      await loadStatus.fail(statusToken, message);
    } finally {
      if (refLoadStatusToken === statusToken) refLoadStatusToken = null;
    }
  }

  /** Choose and load the same extracted mountain another member has in their Reference slot. */
  async function openReference(level: string): Promise<void> {
    const name = level.trim();
    if (!name || name.startsWith('(')) return;
    if (refOwner?.level === name && refMesh) { selectScene('info'); return; }
    refState.level = name;
    levelCtl?.updateDisplay();
    await loadReference();
  }

  /** Re-fit (ambient, diffuse) for the recovered sun with whichever occlusion terms are toggled on. */
  function recomputeModel() {
    if (!refMesh?.intensity || !refSun) { refModel = null; return; }
    refModel = refitWithOcclusion(refMesh.normals, refMesh.intensity, refSun.dir,
      refState.shadow ? refShadow ?? undefined : undefined,
      refState.ao ? refAO ?? undefined : undefined);
  }

  /** Bake the cast-shadow / AO terms the first time they're switched on (yields a frame so the status
   *  paints before the synchronous bake). Cached for the loaded reference + its recovered sun. */
  async function ensureOcclusion() {
    if (!refMesh || !refSun) return;
    const frame = () => new Promise<void>(r => requestAnimationFrame(() => r()));
    if (refState.shadow && !refShadow) {
      log('baking sun shadow…'); await frame();
      refShadow = bakeSunShadow(refMesh.positions, refMesh.indices, refSun.dir);
    }
    if (refState.ao && !refAO) {
      log('baking ambient occlusion…'); await frame();
      refAO = bakeAO(refMesh.positions, refMesh.indices, refMesh.normals);
    }
  }

  /** A shadow / AO toggle changed: bake if needed, re-fit, and refresh the active view + readout. */
  async function onOcclusionToggle() {
    await ensureOcclusion();
    recomputeModel();
    refreshLightReadout();
    applyLighting(refState.lighting);
    log(refModel ? `model R² ${refModel.r2.toFixed(2)} (shadow ${refState.shadow ? 'on' : 'off'}, AO ${refState.ao ? 'on' : 'off'})` : '');
  }

  /** Show the chosen lighting view: baked lightmap, the recovered model (sun + active shadow/AO), the
   *  residual heatmap, or off (the level's normal shading). */
  function applyLighting(mode: string) {
    refState.lighting = mode as typeof refState.lighting;
    if (mode !== 'off') refLightingIntent = mode as LitView;
    const m = refMesh;
    if (!m || !m.intensity || mode === 'off') { viewport.setReferenceLighting(null); return; }
    if (mode === 'lightmap') { viewport.setReferenceLighting(m.lightColor ?? intensityColors(m.intensity)); return; }
    if (!refModel || !refSun) { viewport.setReferenceLighting(null); return; }
    const sh = refState.shadow ? refShadow ?? undefined : undefined;
    const ao = refState.ao ? refAO ?? undefined : undefined;
    const model = computeModel(m.normals, refSun.dir, refModel, sh, ao); // luminance model (residual + readout)
    if (mode === 'residual') { viewport.setReferenceLighting(residualColors(model, m.intensity)); return; }
    // model view: recover the COLOURED sun + ambient by fitting each lightmap colour channel (shared sun
    // direction + shadow/AO), so warm sun / blue-or-pink shadow come through - else neutral grey. When
    // With Local lights on, the level's sign / tunnel / point sources add their glow on top.
    viewport.setReferenceLighting(withRig(m.lightColor ? coloredModel(m.normals, m.lightColor, refSun.dir, sh, ao) : intensityColors(model)));
  }

  /** Composite the loaded reference's local light rig over a per-vertex lit buffer (the recovered sun model):
   *  a screen blend `base + (1−base)·(1−e^(−strength·rig))`, so a lit vertex only brightens toward full and
   *  overlapping lights saturate instead of blowing out. A no-op unless Local lights is effective and the rig term is
   *  baked for this level; the term is independent of the sun sliders, so it's baked once and scaled here. */
  function withRig(base: Float32Array): Float32Array {
    if (!localLightsVisible() || !refRigLightBuf || refRigLightBuf.length !== base.length) return base;
    const out = new Float32Array(base.length);
    const s = rigLightStrength;
    for (let i = 0; i < base.length; i++) {
      const add = 1 - Math.exp(-s * refRigLightBuf[i]); // ≥0; the rig only adds light
      out[i] = base[i] + (1 - base[i]) * add;
    }
    return out;
  }

  /** Apply the reference's lighting view, gated by master Lighting: off -> normal shading. */
  function applyReferenceLighting() {
    if (!refMesh || !sunLight.on) { viewport.setReferenceLighting(null); return; }
    applyLighting(refState.lighting);
  }

  /** Refresh the readout rows from the current model + recovered sun (no panel rebuild). The last row is the
   *  records-vs-fit self-check (only when the level ships its own Lights.json): how closely the fit direction
   *  agrees with the record, and the bake exposure that reconciles the HDR record with the level's lightmap. */
  function refreshLightReadout() {
    lightReadout.fit = refModel
      ? `R² ${refModel.r2.toFixed(2)} · rms ${refModel.rms.toFixed(3)}` +
        (refState.shadow ? ` · shdw ${refModel.shadow.toFixed(2)}` : '') + (refState.ao ? ` · ao ${refModel.ao.toFixed(2)}` : '')
      : '';
    lightReadout.sun = refSun && refModel
      ? `az ${refSun.azimuthDeg | 0}° el ${refSun.elevationDeg | 0}° · amb ${refModel.ambient.toFixed(2)} sun ${refModel.sun.toFixed(2)}`
      : '';
    lightReadout.col = refSunColor && refSkyColor ? `sun ${rgb2hex(normTint(refSunColor))} · sky ${rgb2hex(normTint(refSkyColor))}` : '';
    lightReadout.chk = refLightCheck && refLightSeed
      ? `dir Δ${refLightCheck.dirErrorDeg.toFixed(1)}° · record sun ${refLightSeed.sun.toFixed(2)} · bake sun ${effectiveBakeSun(sunLight).toFixed(2)} (×${(sunLight.bakeExposure ?? 1).toFixed(2)}, lit→white)` +
        ` · amb ${(refLightSeed.ambient ?? sunLight.ambient).toFixed(2)}→${refLightCheck.fitAmbient.toFixed(2)}`
      : '';
    fitCtl?.updateDisplay(); sunCtl?.updateDisplay(); colCtl?.updateDisplay(); chkCtl?.updateDisplay();
  }

  /** Pull the loaded reference's sun into the authored sun (and switch the authored lighting on so it shows
   *  right away). Precedence: the level's OWN light records (refLightSeed, its TRUE HDR sun/sky from
   *  Lights.json) SEED the values; the lightmap-derived fit is the FALLBACK and fills whatever the records
   *  don't carry. The exported Lights.json keeps the raw HDR `sun` + hot record `ambient`; the bake instead
   *  uses `bakeExposure` (= I_fit / recordIntensity) and `bakeAmbient` (the fit ambient) so the terrain
   *  lightmap reproduces THIS level's own (LDR) look. shadow/AO aren't in the records, so they come from the
   *  occlusion refit pinned to the record direction (else kept). */
  function useReferenceLight() {
    // the lightmap colour fit, packed into the same shape as a record seed (or null when there's no lightmap)
    const fit: RefSunSeed | null = (refSun && refSunColor && refSkyColor)
      ? {
          el: refSun.elevationDeg, az: refSun.azimuthDeg,
          sun: Math.max(...refSunColor), sunTint: rgb2hex(normTint(refSunColor)),
          ambient: Math.max(...refSkyColor), skyTint: rgb2hex(normTint(refSkyColor)),
        }
      : null;
    if (!refLightSeed && !fit) { log('load a reference level first'); return; }
    // records win field-by-field; the fit (then the current authored value) backfills
    const el = refLightSeed?.el ?? fit!.el;
    const az = refLightSeed?.az ?? fit!.az;
    const sun = refLightSeed?.sun ?? fit!.sun;
    const sunTint = refLightSeed?.sunTint ?? fit!.sunTint;
    const ambient = refLightSeed?.ambient ?? fit?.ambient ?? sunLight.ambient;
    const skyTint = refLightSeed?.skyTint ?? fit?.skyTint ?? sunLight.skyTint;

    // Decouple the exported light from the bake. With records: keep the raw HDR `sun` + hot `ambient` for
    // Lights.json, but for the BAKE drive the directional sun to the LDR ceiling so a fully sun-facing,
    // unshadowed slope reaches A_S 255 (= the full-bright base texture = WHITE snow, the way SSX's original
    // lightmap is encoded). The HDR record magnitude (e.g. 2.47) can't set lightmap brightness directly (the
    // lightmap is relative-to-full-bright), and the lightmap fit recovers the MEAN slope, not the brightest —
    // baking at that under-drives the peak and the terrain renders grey. So bakeExposure saturates: effSun =
    // min(sun * 1/sun, ceil) = ceil. bakeAmbient stays the fit's lightmap-effective ambient (the shadow floor),
    // so contrast (lit white -> shadow ambient) matches original. With no records: exposure 1 (the authored sun
    // defaults to 1.0, which already saturates) and bakeAmbient cleared.
    let bakeExposure = 1;
    if (refLightSeed && refLightCheck) {
      bakeExposure = 1 / Math.max(sun, 1e-3); // saturate: effectiveBakeSun clamps sun*bakeExposure to the LDR ceiling
      sunLight.bakeAmbient = +refLightCheck.fitAmbient.toFixed(3); // bake the lightmap-effective ambient; export keeps raw
      // shadow/AO pinned to the record direction (better-conditioned), but only adopt what's actually been
      // baked in the study — otherwise keep the authored cast-shadow / AO defaults.
      if (refMesh?.intensity && ((refState.shadow && refShadow) || (refState.ao && refAO))) {
        const recDir = sunDirFromElAz(el, az);
        const occ = refitWithOcclusion(refMesh.normals, refMesh.intensity, recDir,
          refState.shadow ? refShadow ?? undefined : undefined, refState.ao ? refAO ?? undefined : undefined);
        if (refState.shadow && refShadow) sunLight.shadow = +occ.shadow.toFixed(2);
        if (refState.ao && refAO) sunLight.ao = +occ.ao.toFixed(2);
      }
    } else {
      delete sunLight.bakeAmbient; // no records -> the bake uses the authored/fit ambient (no decoupling)
    }

    sunLight.on = true;
    sunLight.el = Math.round(el);
    sunLight.az = Math.round((az + 360) % 360);
    sunLight.sun = +sun.toFixed(2);
    sunLight.ambient = +ambient.toFixed(2);
    sunLight.sunTint = sunTint;
    sunLight.skyTint = skyTint;
    sunLight.bakeExposure = +bakeExposure.toFixed(3);
    fitSunSlider();
    syncBakeAmbient();
    sunFolder.controllers.forEach(c => c.updateDisplay());
    applyMasterLighting(true);
    refreshLightReadout(); // surface the records-vs-fit self-check
    if (refLightCheck) {
      log(`record sun: dir agrees within ${refLightCheck.dirErrorDeg.toFixed(1)}° · export sun ${sunLight.sun.toFixed(2)} amb ${sunLight.ambient.toFixed(2)} · bake sun ${effectiveBakeSun(sunLight).toFixed(2)} (×${bakeExposure.toFixed(2)}) amb ${effectiveBakeAmbient(sunLight).toFixed(2)}`);
    }
  }

  const rgb2hex = (c: [number, number, number]) => '#' + c.map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
  const normTint = (c: [number, number, number]): [number, number, number] => { const m = Math.max(c[0], c[1], c[2]) || 1; return [c[0] / m, c[1] / m, c[2] / m]; };

  /** Recover the level's sun + ambient COLOUR from the baked lightmap: a per-channel base fit, where the
   *  constant term is the ambient (sky / shadow) colour and the N·L term is the sun colour. */
  function recoverColors(normals: Float32Array, lightColor: Float32Array, dir: [number, number, number]): { sun: [number, number, number]; sky: [number, number, number] } {
    const n = normals.length / 3, chan = new Float32Array(n);
    const sun: [number, number, number] = [0, 0, 0], sky: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) chan[i] = lightColor[i * 3 + c];
      const f = refitWithOcclusion(normals, chan, dir);
      sun[c] = f.sun; sky[c] = f.ambient;
    }
    return { sun, sky };
  }

  /** Recover a COLOURED sun model: fit each colour channel of the baked lightmap independently against the
   *  shared sun direction (+ shadow/AO), so the model view shows the level's real warm-sun / cool-shadow. */
  function coloredModel(normals: Float32Array, lightColor: Float32Array, dir: [number, number, number], sh?: Float32Array, ao?: Float32Array): Float32Array {
    const n = normals.length / 3;
    const out = new Float32Array(n * 3);
    const chan = new Float32Array(n);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) chan[i] = lightColor[i * 3 + c];
      const fit = refitWithOcclusion(normals, chan, dir, sh, ao);
      const model = computeModel(normals, dir, fit, sh, ao);
      for (let i = 0; i < n; i++) out[i * 3 + c] = Math.min(1, Math.max(0, model[i]));
    }
    return out;
  }

  /** Rebuild the lighting-study panel for the freshly loaded reference (view picker, shadow/AO, readout). */
  function setupLightingUi() {
    clearGui(lightFolder); // visibility is governed by the Scene Lighting category
    selectedReferenceLightFolder = null; // clearGui destroyed the old child; rebuild it from semantic state below
    refState.lighting = refMesh?.intensity ? refLightingIntent : 'off';
    fitCtl = sunCtl = colCtl = chkCtl = null;
    updateLightPanelVis = null;
    if (!refMesh?.intensity) {
      if (refLightmapStatus === 'loading') note(lightFolder, 'Loading baked lightmaps…');
      else if (refLightmapStatus === 'error') {
        note(lightFolder, 'Lighting study failed to load.');
        tip(lightFolder.add({ retry: requestLightingStudy }, 'retry').name('Retry lighting study'),
          'Retry fetching and decoding this level’s baked lightmaps.');
      }
      else if (refLightmapStatus === 'missing') note(lightFolder, 'No lightmap for this level.');
      else if (refLightmapStatus === 'placeholder') note(lightFolder,
        'No usable baked lightmap — this map assigns its patches to a repeated placeholder tile.');
      else {
        note(lightFolder, 'Lighting study is deferred so reference terrain restores faster.');
        tip(lightFolder.add({ load: requestLightingStudy }, 'load').name('Load lighting study'),
          'Fetch this level’s baked lightmaps and recover its sun, shadow, ambient occlusion, and colour model.');
      }
      if (refLightSeed) tip(lightFolder.add({ use: () => useReferenceLight() }, 'use').name('⟶ use recorded sun'),
        'Copy the directional and ambient light records now.',
        'Loading the study additionally recovers bake exposure and colour from the terrain lightmaps.');
      rebuildSelectedReferenceLightDetails();
      lightFolder.open();
      return;
    }
    let glowHintCtl: { show(v?: boolean): unknown } | null = null;
    // cast-shadow / AO only shape the model + residual views, so only reveal them when one is selected; the
    // rig-glow strength only bites in the model view with effective Local lights on
    const updateOcc = () => {
      const uses = refState.lighting === 'model' || refState.lighting === 'residual';
      shadowCtl.show(uses); aoCtl.show(uses);
      const glowShows = refState.lighting === 'model' && localLightsVisible();
      rigCtl.show(glowShows);
      // Local lights on but the glow has nowhere to show: say so rather than moving the user's view for them.
      // On 'lightmap' it is not even missing — the baked page already carries the level's own local lights.
      glowHintCtl?.show(localLightsVisible() && !glowShows);
    };
    updateLightPanelVis = updateOcc; // so toggling Lighting / Local lights refreshes the rig-glow slider
    tip(lightFolder.add(refState, 'lighting', ['lightmap', 'model', 'residual']).name('view').onChange(() => {
      refLightingIntent = refState.lighting as LitView;
      if (!sunLight.on) { sunLight.on = true; applyMasterLighting(true); } // picking a view turns lighting on
      applyReferenceLighting(); updateOcc();
    }), 'lightmap = baked ground truth · model = the recovered sun · residual = where the model misses.',
      'model adds shadow/AO when they are on, and the level’s local lights when Local lights is on. residual: '
      + 'red = over-lit, blue = under-lit (baked shadow / fill). Lighting is the master on/off.');
    const shadowCtl = tip(lightFolder.add(refState, 'shadow').name('cast shadow').onChange(onOcclusionToggle),
      'Bake the sun’s cast shadow into the model (first toggle bakes; cached after).');
    const aoCtl = tip(lightFolder.add(refState, 'ao').name('ambient occlusion').onChange(onOcclusionToggle),
      'Bake hemisphere ambient occlusion (valleys / creases darken) and fold it into the model.');
    const rigCtl = tip(lightFolder.add({ get s() { return rigLightStrength; }, set s(v: number) { rigLightStrength = v; } }, 's', 0, 3, 0.05).name('light rig glow')
      .onChange(() => { applyReferenceLighting(); applyPropRigLighting(); }),
      'How strongly the level’s own local lights glow over the recovered sun model.',
      'Lighting’s Local lights option: sign / tunnel / point lights and the props they aim at. Compare to the baked '
      + '‘lightmap’ view for the original.');
    glowHintCtl = tip(lightFolder.add({ v: 'switch view to “model”' }, 'v').name('rig glow').disable(),
      'The rig glow only draws over the recovered sun — switch the view to “model” to see it.',
      'The props it aims at are tinted either way, and the baked ‘lightmap’ view already contains this level’s '
      + 'own local lights, so nothing is missing there.');
    fitCtl = lightFolder.add(lightReadout, 'fit').name('fit').disable();
    sunCtl = lightFolder.add(lightReadout, 'sun').name('sun').disable();
    colCtl = lightFolder.add(lightReadout, 'col').name('colour').disable();
    chkCtl = tip(lightFolder.add(lightReadout, 'chk').name('record check').disable(),
      'How closely the lightmap fit agrees with the level’s own Lights.json; blank if no records.',
      'Shows the fit direction’s agreement with the record, and the bake exposure (record sun × this) that '
      + 'reproduces the level’s own lightmap.');
    tip(lightFolder.add({ use: () => useReferenceLight() }, 'use').name('⟶ use for my map'),
      'Copy this level’s sun into the authored Lighting settings.',
      'Uses its own light records (Lights.json, the true HDR sun/sky) when it ships them, else the sun '
      + 'recovered from the baked lightmap. Records seed the exported light; the study sets the bake exposure '
      + 'so the terrain lightmap matches this level.');
    refreshLightReadout();
    applyReferenceLighting(); // show the coloured lightmap immediately (if the bulb is on)
    updateOcc(); // default view is lightmap -> cast-shadow / AO start hidden
    rebuildSelectedReferenceLightDetails();
    lightFolder.open();
  }

  // ---- Lighting: light the AUTHORED terrain with a recovered SSX-style sun (Stage D) ----
  // Starts from OpenSlope's warm-daylight/cool-sky palette; imported records remain available to adopt.
  // typed SunLight so the optional bake-only overrides (bakeExposure / bakeAmbient) can be set or cleared
  const sunLight: SunLight = { ...DEFAULT_SUN, on: false }; // off until requested; imported records may replace this authored starting point

  const hex2rgb = (h: string): [number, number, number] => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };

  // view-only (not doc data): preview the authored terrain as it bakes in-game — the light through the real GS
  // lightmap encode -> decode (quantization/clamp) with the full-res tile riding on top (texture × baked-light).
  const terrainView = { baked: false };

  // The sun slider covers the ENGINE's HDR scale (retail records ship 2.47), not just the bake's 0–1;
  // grow the range further if a record ever exceeds it, or lil-gui clamps the value on the first drag
  // (silently discarding the seed while its paired bakeExposure stays computed for the HDR magnitude).
  let sunSliderCtl: Controller | null = null;
  function fitSunSlider() {
    sunSliderCtl?.max(Math.max(3, sunLight.sun)).updateDisplay();
  }
  /** Manual sun edits keep the bake saturated, mirroring a record seed: above the LDR rail the slider is
   *  RIDER heat (bakeExposure = 1/sun pins the terrain bake at the white ceiling); at or below the rail
   *  exposure is 1 and the slider dims terrain and rider together. */
  function autoSunExposure() {
    sunLight.bakeExposure = +(1 / Math.max(1, sunLight.sun)).toFixed(3);
  }
  // 'bake ambient' = the terrain lightmap's ambient floor (shadow depth), viewed through its own control.
  // It follows `ambient` until moved apart (the override is stored only while they differ), so `ambient`
  // can ship hot to Lights.json (rider fill) while the bake keeps a deep shadow floor — the same
  // decoupling a record seed authors (GARI: ambient 0.68, bake ~0.3).
  const bakeAmb = { v: 0 };
  let bakeAmbCtl: Controller | null = null;
  function syncBakeAmbient() {
    bakeAmb.v = effectiveBakeAmbient(sunLight);
    bakeAmbCtl?.updateDisplay();
  }

  function applySunLight(edited = false, persist = true) {
    if (persist) {
      store.mdoc.sun = { ...sunLight }; // the authored sun rides on the doc, so export / save / reload all carry it
      // The disk-backed project wins over localStorage at boot. User changes must therefore enter the same
      // project/register transports as geometry edits or a refresh restores the previous server revision.
      // Restore/repaint calls leave edited=false so merely opening a project never creates a new revision.
      if (edited) persistDocumentEdit();
      else persistDoc(); // restore/repaint still keeps the immediate local recovery copy current
    }
    viewport.setPlayLightingVisibility(sunLight.on);
    if (!sunLight.on) { viewport.setTerrainLight(null); viewport.setPropLight(null); applyGodRays(); return; }
    const e = (sunLight.el * Math.PI) / 180, a = (sunLight.az * Math.PI) / 180;
    const dir: [number, number, number] = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
    // Props preview from the RAW record pair because that is what their per-instance lighting ships with
    // (docs/032 · lighting). Terrain normalises independently through bakeExposure/lightmap saturation;
    // passing its exposed pair here would make an HDR reference-seeded preview disagree with the packed PBD.
    viewport.setPropLight({
      dir, ambient: sunLight.ambient, sun: sunLight.sun,
      sunTint: hex2rgb(sunLight.sunTint), skyTint: hex2rgb(sunLight.skyTint),
    });
    // WYSIWYG: preview the terrain at the BAKED sun + ambient (the exact effective values bakeLightmaps uses,
    // incl. the safe clamp), so a record-seeded HDR sun (e.g. 2.47) reads at its baked ~0.67 and the record's
    // hot ambient reads at the lightmap-effective ~0.3 — not blown out. Export (buildLightsJson) keeps the raw
    // sun.sun / ambient; with no records both overrides are absent, so this matches the authored values.
    viewport.setTerrainLight({
      dir, ambient: effectiveBakeAmbient(sunLight), sun: effectiveBakeSun(sunLight), shadow: sunLight.shadow, ao: sunLight.ao,
      sunTint: hex2rgb(sunLight.sunTint), skyTint: hex2rgb(sunLight.skyTint),
    });
    applyGodRays();
  }

  /** The Skybox preview and an active Test ride choose the world whose own authored glare is eligible. */
  function effectiveGlare(): GodRayCourse | null {
    return godRaysForSkyWorld(getActiveGodRayWorld(), store.mdoc.glare, refGlare);
  }

  function applyGodRays() {
    const world = getActiveGodRayWorld();
    const shown = effectiveGlare();
    glareUi.source = world === null ? '(Skybox preview / Test ride only)'
      : world === 'authored'
        ? shown ? 'this mountain' : 'this mountain — its glare is off'
        : shown ? `${loadedLevelName() || 'the loaded level'} (not adopted)`
          : refGlare ? `${loadedLevelName() || 'the loaded level'} — its glare is off`
            : `${loadedLevelName() || 'the loaded level'} — no glare`;
    viewport.setGodRays(shown);
    glareSourceCtl?.updateDisplay();
  }

  /** Pull a loaded doc's saved sun back into the editor (restore it), then re-light the current terrain.
   *  sunLight is made to mirror mdoc.sun EXACTLY: Object.assign leaves keys absent from mdoc.sun untouched,
   *  so the optional bake overrides are reset explicitly — otherwise a prior map's bakeExposure/bakeAmbient
   *  would drift onto a doc that doesn't carry one (and a record doc's exposure would never be cleared). */
  function syncSunFromDoc() {
    syncGlareFromDoc(); // the doc's glare rides the same restore as its sun
    if (store.mdoc.sun) {
      Object.assign(sunLight, store.mdoc.sun);
      sunLight.bakeExposure = store.mdoc.sun.bakeExposure ?? 1;
      if (store.mdoc.sun.bakeAmbient == null) delete sunLight.bakeAmbient; else sunLight.bakeAmbient = store.mdoc.sun.bakeAmbient;
      fitSunSlider();
      syncBakeAmbient();
      sunFolder.controllers.forEach(c => c.updateDisplay());
    }
    applySunLight();
    if (localLightsVisible()) void ensureRefGlow();
    applyReferenceLighting();
    applyPropRigLighting();
    applyPropLightsVisible();
    refreshLighting(); // keep the top-bar Lighting toggle in sync with the restored on/off state
  }

  function initSunLight() {
    tip(sunFolder.add(sunLight, 'on').name('preview').onChange(() => applyMasterLighting(true)),
      'Master Lighting toggle (the top-bar sun); re-lights live as you sculpt.',
      'Lights both mountains with sun + sky colour + baked cast-shadow/AO and the Local lights layer below.');
    tip(sunFolder.add(store, 'propLightsVisible').name('local lights').onChange(() => applyLocalLightsPreference()),
      'Add the course’s local sign, tunnel, point, and free lights to the master Lighting preview.',
      'This is the former top-bar Prop lights switch. It remains available here for focused lighting study; '
      + 'turning it on also turns the master preview on.');
    tip(sunFolder.add(sunLight, 'el', 5, 90, 1).name('elevation°').onChange(() => applySunLight(true)), 'Sun height above the horizon.');
    sunFolder.add(sunLight, 'az', 0, 360, 1).name('azimuth°').onChange(() => applySunLight(true));
    tip(sunFolder.add(sunLight, 'ambient', 0, 1, 0.01).name('ambient').onChange(() => { syncBakeAmbient(); applySunLight(true); }),
      'Sky-fill floor, exported raw to Lights.json (the rider fill).',
      'Retail records ship it hot — GARI 0.68. The terrain bake follows it through "bake ambient" below until '
      + 'that is moved apart.');
    bakeAmbCtl = tip(sunFolder.add(bakeAmb, 'v', 0, 1, 0.01).name('bake ambient').onChange((v: number) => {
      if (Math.abs(v - sunLight.ambient) < 5e-3) delete sunLight.bakeAmbient; else sunLight.bakeAmbient = +v.toFixed(3);
      applySunLight(true);
    }), 'The ambient floor the terrain lightmap bakes with — the shadow depth.',
      'Follows the ambient slider until moved apart; keep it low (~0.3, the retail lightmap-effective floor) '
      + 'while shipping a hot ambient for the rider. Drag it back onto ambient to re-couple. A record seed '
      + 'sets it from the reference’s lightmap fit.');
    sunSliderCtl = tip(sunFolder.add(sunLight, 'sun', 0, 3, 0.01).name('sun').onChange(() => { autoSunExposure(); applySunLight(true); }),
      'Direct-sun strength, exported raw to Lights.json (what lights the rider).',
      'Retail records are HDR — GARI 2.47. Above 1.0 the terrain bake stays pinned at the white ceiling '
      + '(bakeExposure auto-saturates, exactly like a record seed) and the extra heat reaches only the rider; '
      + 'at or below 1.0 terrain and rider dim together.');
    fitSunSlider();
    syncBakeAmbient();
    tip(sunFolder.addColor(sunLight, 'sunTint').name('sun colour').onChange(() => applySunLight(true)), 'Colour of the direct sun (warm-white in daylight, pink at a low sun).');
    tip(sunFolder.addColor(sunLight, 'skyTint').name('sky colour').onChange(() => applySunLight(true)), 'Colour the sky fills shadow with - this is what tints the shadows (blue in daylight, magenta at a low sun).');
    tip(sunFolder.add(sunLight, 'shadow', 0, 1, 0.01).name('cast shadow').onChange(() => applySunLight(true)), 'How strongly the baked cast shadow drops the sun term toward sky colour.');
    tip(sunFolder.add(sunLight, 'ao', 0, 1, 0.01).name('ambient occl.').onChange(() => applySunLight(true)), 'How strongly baked ambient occlusion darkens the creases / valleys.');
    // our own day / night presets (a loaded level's exact recovered look lives on the ⟶ button in the lighting study)
    const presets: Record<string, () => void> = {
      Day: () => { sunLight.el = 55; sunLight.az = 150; sunLight.ambient = 0.32; sunLight.sun = 0.78; sunLight.shadow = 0.50; sunLight.ao = 0.40; sunLight.sunTint = '#fff2e0'; sunLight.skyTint = '#bcd8ff'; },
      Night: () => { sunLight.el = 24; sunLight.az = 210; sunLight.ambient = 0.16; sunLight.sun = 0.30; sunLight.shadow = 0.60; sunLight.ao = 0.55; sunLight.sunTint = '#cdd8ff'; sunLight.skyTint = '#33406e'; },
    };
    sunFolder.add({ preset: 'Day' }, 'preset', Object.keys(presets)).name('preset')
      .onChange((k: string) => {
        presets[k]();
        // a preset is a complete look: clear any seeded/manual bake decoupling so it bakes what it shows
        autoSunExposure();
        delete sunLight.bakeAmbient;
        syncBakeAmbient();
        sunFolder.controllers.forEach(c => c.updateDisplay());
        applySunLight(true);
      });
    tip(sunFolder.add(terrainView, 'baked').name('baked (in-game) view').onChange((v: boolean) => viewport.setTerrainBakedView(v)),
      'Show your terrain as it bakes in-game, through the real GS lightmap encode + decode.',
      'Seeing (almost) no change is the bake being faithful — the difference is at most faint banding in '
      + 'smooth shadow / AO gradients and flattened highlights where light overshoots the LDR rail. Does '
      + 'nothing while the sun is off. Off = the live smooth sun model you tune (the default).');
    initGlare();
    applySunLight(); // apply the current lighting state (off by default)
  }

  // ---- sun glare (docs/049) -------------------------------------------------------------------------
  // The beams that fan across the view when you look toward the sun. Authored per mountain and exported as
  // World.json, which is the same contract `snowknife import` writes from a course's own settings — so an
  // authored course and an imported one are read identically here, in Unity and by a repack.
  //
  // The glare has its OWN direction, deliberately separate from the sun above: a course can light from
  // overhead and still glare off the horizon, which is what every shipped one does.
  function hex2rgb255(h: string): [number, number, number] {
    const n = parseInt(h.replace('#', ''), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgb2552hex(c: readonly [number, number, number]): string {
    return '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  function glareFromUi(): GodRayCourse {
    return {
      enabled: glareUi.on,
      core: hex2rgb255(glareUi.core),
      fanIntensity: glareUi.fanIntensity,
      rim: hex2rgb255(glareUi.rim),
      spriteIntensity: glareUi.spriteIntensity,
      az: glareUi.az,
      el: glareUi.el,
      distance: glareUi.distance,
      size: glareUi.size,
    };
  }

  function glareToUi(g: GodRayCourse) {
    glareUi.on = g.enabled;
    glareUi.core = rgb2552hex(g.core);
    glareUi.fanIntensity = g.fanIntensity;
    glareUi.rim = rgb2552hex(g.rim);
    glareUi.spriteIntensity = g.spriteIntensity;
    glareUi.az = g.az;
    glareUi.el = g.el;
    glareUi.distance = g.distance;
    glareUi.size = g.size;
  }

  /** Push the panel onto the document + the viewport. Absent when off, like every other optional doc field. */
  function applyGlare(edited = false) {
    const g = glareFromUi();
    store.mdoc.glare = g.enabled ? g : undefined;
    if (edited) persistDocumentEdit(); else persistDoc();
    applyGodRays();
  }

  /** Restore the panel from a loaded document (or clear it back to the default when the doc has no glare). */
  function syncGlareFromDoc() {
    glareToUi(store.mdoc.glare ? normalizeGodRayCourse(store.mdoc.glare) : DEFAULT_GODRAY_COURSE);
    glareFolder?.controllers.forEach(c => c.updateDisplay());
    applyGodRays();
  }

  /** Rebuild the loaded map's half of Scene ▸ God Rays. These controls deliberately mirror the authored
   *  labels and order so values can be scanned row-for-row, but every one is disabled: Reference is evidence,
   *  and the explicit take button is the only path that writes it onto the mountain. */
  function buildReferenceGlarePanel() {
    clearGui(refGodRayFolder);
    const level = loadedLevelName();
    if (!refGlare) {
      note(refGodRayFolder, level
        ? `${level} has no extracted god-ray settings.`
        : 'Load a mountain in Reference to compare its god-ray settings.');
      return;
    }
    const g = refGlare;
    const ui = {
      on: g.enabled,
      core: rgb2552hex(g.core),
      fanIntensity: g.fanIntensity,
      rim: rgb2552hex(g.rim),
      spriteIntensity: g.spriteIntensity,
      el: g.el,
      az: g.az,
      distance: g.distance,
      size: g.size,
    };
    note(refGodRayFolder, `Read-only values extracted from ${level || 'the loaded level'}/World.json.`);
    refGodRayFolder.add(ui, 'on').name('beams').disable();
    refGodRayFolder.addColor(ui, 'core').name('core colour').disable();
    refGodRayFolder.add(ui, 'fanIntensity').name('fan intensity').disable();
    refGodRayFolder.addColor(ui, 'rim').name('rim colour').disable();
    refGodRayFolder.add(ui, 'spriteIntensity').name('sprite intensity').disable();
    refGodRayFolder.add(ui, 'el').name('elevation°').disable();
    refGodRayFolder.add(ui, 'az').name('azimuth°').disable();
    refGodRayFolder.add(ui, 'distance').name('distance').disable();
    refGodRayFolder.add(ui, 'size').name('sprite size').disable();
    if (!g.enabled) note(refGodRayFolder, 'This course retains values, but its retail enable flag is off.');
  }

  function initGlare() {
    clearGui(godRayFolder);
    const folder = godRayFolder;
    glareFolder = folder;
    note(folder, 'Editable settings exported with this mountain as World.json.');
    tip(folder.add(glareUi, 'on').name('beams').onChange(() => applyGlare(true)),
      'The radial beams that fan across the view when you look toward the sun.',
      'Most shipped courses have none — it is a look, not a default. Previewed with this mountain’s skybox, '
      + 'and shown automatically during its Test ride.');
    tip(folder.addColor(glareUi, 'core').name('core colour').onChange(() => applyGlare(true)),
      'The retail CoreColour field: the flat tint used by every triangle in the beam fan.');
    // The two independent intensity roles follow [Trailmap: 400-celestial-params].
    tip(folder.add(glareUi, 'fanIntensity', 0, 2, 0.001).name('fan intensity').onChange(() => applyGlare(true)),
      'Per-course strength of the screen-space beam fan.',
      'This is separate from the spoke pattern: it scales the complete fan without flattening the contrast '
      + 'between bright rays and dim gaps.');
    tip(folder.addColor(glareUi, 'rim').name('rim colour').onChange(() => applyGlare(true)),
      'The retail RimColour field: the tint of the single soft corona sprite.');
    tip(folder.add(glareUi, 'spriteIntensity', 0, 2, 0.001).name('sprite intensity').onChange(() => applyGlare(true)),
      'Per-course strength of the authored-radius soft corona sprite.');
    tip(folder.add(glareUi, 'el', -5, 90, 0.5).name('elevation°').onChange(() => applyGlare(true)),
      'The glare sun’s height — its own setting, not the lighting sun’s.',
      'Every shipped glare sits within 13°: a low sun you ride toward. Put it overhead and you will never '
      + 'look at it.');
    tip(folder.add(glareUi, 'az', 0, 360, 0.5).name('azimuth°').onChange(() => applyGlare(true)),
      'Which way the glare sun lies — a course can light from one side and glare from another.');
    tip(folder.add(glareUi, 'distance', 5000, 60000, 100).name('distance').onChange(() => applyGlare(true)),
      'How far out the sun is placed, in map units.',
      'It rides with the camera, so this only decides what it is drawn in front of; a consumer keeps it '
      + 'inside its own far plane.');
    tip(folder.add(glareUi, 'size', 0, 30000, 100).name('sprite size').onChange(() => applyGlare(true)),
      'World size of the sun’s own sprite — the beams run to the view edge regardless.');
    glareSourceCtl = folder.add(glareUi, 'source').name('showing').disable();
    tip(folder.add({ adopt: adoptReferenceGlare }, 'adopt').name('⟶ take from level'),
      'Copy the loaded level’s own glare onto this mountain and edit from there.');
    syncGlareFromDoc();
    buildReferenceGlarePanel();
  }

  /** Copy the loaded reference level's glare onto the document — the ⟶ idiom the sky already uses. */
  function adoptReferenceGlare() {
    if (!refGlare) { toast('the loaded level has no glare settings to take', 'warn'); return; }
    glareToUi(refGlare);
    glareFolder?.controllers.forEach(c => c.updateDisplay());
    applyGlare(true);
    toast(`took ${loadedLevelName() || 'the level'}'s glare`);
  }

  /** Apply the one top-level Lighting state to the sun model and its subordinate local-light layer. */
  function applyMasterLighting(edited = false, persist = true) {
    applySunLight(edited, persist);
    if (localLightsVisible()) void ensureRefGlow();
    applyReferenceLighting();
    applyPropRigLighting();
    applyPropLightsVisible();
    updateLightPanelVis?.();
    sunFolder.controllers.forEach(c => c.updateDisplay());
    refreshLighting();
  }

  /** Toggle the complete authored lighting preview; keeps the Lighting panel in sync. */
  function toggleSunLight() {
    sunLight.on = !sunLight.on;
    applyMasterLighting(true);
  }

  /**
   * Apply another member's display switches without writing them into this mountain or local preferences.
   * The ordinary controls remain live; a local click changes these same values until the next shared frame.
   */
  function applySharedViewOptions(options: {
    props: boolean; tricks: boolean; sources: boolean; propLights: boolean; sun: boolean;
  }): void {
    store.propsVisible = options.props;
    store.tricksVisible = options.tricks;
    store.lightRigVisible = options.sources;
    applyPropsVisible();
    applyTricksVisible();
    applyLightsVisible();

    sunLight.on = options.sun;
    store.propLightsVisible = options.propLights;
    applyMasterLighting(false, false);
  }

  // debug hook: drive + inspect the lighting study from devtools (unstaged experiment).
  (window as unknown as Record<string, unknown>).slop = {
    state: refState,
    load: () => loadReference(),
    setLighting: (m: string) => applyLighting(m),
    toggleOcclusion: () => onOcclusionToggle(),
    get data() { return { mesh: refMesh, sun: refSun, model: refModel, shadow: refShadow, ao: refAO }; },
  };

  return {
    initReference, initSunLight, syncSunFromDoc,
    applySunLight, applyReferenceLighting, syncGodRays: applyGodRays,
    ensureReferenceEffects, ensureReferenceLightmaps,
    applyPropsVisible, applyLightsVisible,
    toggleProps, toggleTricks, toggleLights, togglePropLights, toggleSunLight, applySharedViewOptions,
    setSelectedLightDetails, showDocumentReference, clearReference, openReference, refreshMountainName,
    getSunOn: () => sunLight.on,
    hasReference: () => !!refMesh,
    getRefCourse: () => refCourse,
    getRefLaps: () => refLaps,
    getRefLevel: () => refState.level,
    /** What the slot is showing when it holds a checkpoint rather than an extracted level (docs/040). */
    getRefDocument: () => refDocument,
  };
}

export type Reference = ReturnType<typeof createReference>;
