import type { CoursePath } from '../core/doc/types';
import { SURFACE_TYPES } from '../core/doc/types';
import {
  defaultMountain, migrateMountain,
  type BrushOp, type BrushDir, type BrushFalloff, type FlattenMode, type FlattenPlaneBehavior,
} from '../core/doc/mountain';
import { surfOf, texOf, orientOf, clearTex, setOrient, turnOrient, type EditDoc } from '../core/doc/doc-edit';
import type { LevelProps } from '../core/reference/props';
import type { GroupDef } from '../core/reference/groups';
import { TextureLibrary } from './paint/library';
import { openSettingsDialog } from './ui/chrome/settings-dialog';
import { describeApplied, drainBlenderPushes, openBlenderGuide } from './props/blender-bridge';
import { PropLibrary } from './props/library';
import { PropPreview } from './props/preview';
import { createPropOps } from './props/operations';
import { createTrickTools } from './tricks/operations';
import { Palette } from './paint/palette';
import { tooltip } from './ui/components/tooltip';
import { Viewport, type Mode, type ShadeMode, type ViewState } from './viewport/viewport';
import { MOUNTAIN_KEY, VIEW_KEY, UI_KEY, loadStored, isValidView, createPersistence, type StoredUi } from './state/storage';
import { mapNameInUrl, showMapInUrl } from './state/map-url';
import { createHistory } from './state/history';
import { createRebuilder } from './state/rebuild';
import { createStore } from './state/store';
import { quadIndex, quadIndices, quadName } from './state/mesh-names';
import { reconcileTJunctionGeometry } from '../core/mesh/t-junctions';
import { createNetWatcher, type NetChange } from '../core/mesh/incremental';
import { AUTHORED_MODEL_LEVEL, createAuthoredModel, duplicateAuthoredModel, findModel, modelEditDocFor, modelIdFromNumber, modelNumber, rebaseModelToPlacement } from '../core/doc/models';
import { turnD4 } from '../core/paint/orientation';
import { recordFromReferenceProp, revisedPropName } from '../core/props/adopt';
import { IMPORTED_PROP_LEVEL } from '../core/props/imported';
import { detachEffectFromProp, ensurePlacedPropIds, transformModelEmitterFrames } from '../core/effects/authoring';
import { railHasTube } from '../core/rails/rails';
import { refreshModelEditTarget } from './edit/mesh-target';
import { toast } from './ui/components/toast';
import { LIB_GRID_ICON, PROP_LIB_ICON } from './ui/components/icons';
import { DockTab } from './ui/components/dock-tab';
import { createDialogs } from './ui/chrome/dialogs';
import { fetchJson } from './net/fetch-json';
import { createScenePanel } from './ui/chrome/scene-panel';
import { installAccounts } from './ui/chrome/sign-in';
import { createChatBox, plainChatText } from './ui/chrome/chat-box';
import { createVoiceChat } from './ui/chrome/voice-chat';
import { createUsersMode } from './ui/chrome/users-mode';
import { createTopBar } from './ui/chrome/top-bar';
import { createObserverControls } from './ui/chrome/observer-controls';
import { createToolsPanel } from './ui/chrome/tools-panel';
import { createPlay } from './ride/play';
import { refreshRiderModelCatalog } from './ride/rider-models';
import { loadCustomSounds } from './ui/components/custom-sounds';
import { createReference } from './reference/session';
import { createSkybox } from './sky/session';
import { createEditSession } from './edit/session';
import { createViewportCallbacks } from './viewport-callbacks';
import { installShortcuts } from './shortcuts';
import { MODE_SHORTCUTS } from './mode-shortcuts';
import { createEffectsEditor, type EffectsEditor } from './effects/editor';
import type { AgentLayer } from './dev/agent-layer';
import { createLoadStatus } from './ui/components/load-status';
import {
  createProjectSync, clientId as editorClientId, deviceLabel as editorDeviceLabel, type ProjectSaveState,
} from './state/project-sync';
import { createSessionChannel, membersOn, type PresenceEntry } from './net/session-channel';
import { currentAccount, onAccountChanged, type Member } from './net/account';
import { createRegisterSync } from './net/register-sync';
import { createAwareness } from './net/awareness';
import { createSyncStatus } from './state/sync-status';
import { loadSettings, saveSettings } from './state/settings';
import type { PeerMarks } from './viewport/scene/peers';
import { emptyJukeboxState, jukeboxPosition, type JukeboxState } from '../core/session/jukebox';
import type {
  SharedScreenFrame, SharedScreenState, SharedViewOptions,
} from '../core/session/screen-share';

/*
 * UI layout - a docked, three-region editor:
 *   top    (#dock-top)    context + view + file : editor & mode switch, cage/grid/focus, New/Save/Load/Export
 *   right  (#dock-right)  the toolbox: options for the active mode (sculpt brush, edit corner/crease tools,
 *                         the paint Palette) — and in Info mode, the Scene block (tabs + the selected
 *                         item's details: mountain + Course, Lighting, reference + lighting study)
 *   bottom (library)      Texture Library : the level's texture tiles — drag them into the Palette (shown while painting)
 * The top bar is plain DOM (horizontal); the toolbox panels are lil-gui (vertical property lists).
 * On phones the toolbox stays persistent, scaled down into a mini-panel under the top bar on the LEFT half,
 * leaving the top-right corner to the nav gizmo (see index.html @media).
 */

const storedMountain = loadStored<unknown>(MOUNTAIN_KEY);

// editor mode + view toggles carried over from the last session (see persistUi / StoredUi + state/store.ts).
// shadeMode (which includes the cage-only 'none' state) is pushed onto the viewport just after it's constructed;
// invalid / absent entries fall back to defaults.
const MODES: Mode[] = MODE_SHORTCUTS.map(item => item.mode);
const SHADES: ShadeMode[] = ['textured', 'surface', 'none'];
const storedUi = loadStored<Partial<StoredUi>>(UI_KEY) ?? {};
const bootMode: Mode = (storedUi.mode as Mode) === 'play' ? 'edit' // never boot straight into a live ride setup
  : MODES.includes(storedUi.mode as Mode) ? (storedUi.mode as Mode)
  : (storedUi.mode as string) === 'view' ? 'info' // a stored 'view' mode (the old read-only mode) boots into Info
  : 'edit';
// The editor's shared mutable state (doc + selection + mode + view toggles) lives in state/store.ts; boot it
// from the migrated document, the validated mode, and the persisted view toggles. Everything below reads and
// writes it as store.<field>.
const store = createStore({
  mdoc: storedMountain ? migrateMountain(storedMountain) : defaultMountain(), // legacy heightfield -> control net
  currentMode: bootMode,
  storedUi,
});
const gemTool = { height: 2, spacing: 4, value: 2 }; // gem placement defaults (float height, drag-row gap, tier); the tier picker (GEM_TIERS) lives in ui/tool-panels/tricks
// Free-light placement defaults, the same shape as gemTool: what the NEXT hand-placed light drops as, presettable
// in the Add light panel before the click. A warm point light, bright enough to read, reaching ~30 m — the values
// newFreeLight used to hard-code. `cone` only reaches the light when the kind is spot (viewport-callbacks).
const lightTool = { kind: 'point' as 'point' | 'spot', color: '#ffd9a0', intensity: 2, reach: 30, cone: 35, glint: 0 };
const propLevels = new Map<string, LevelProps>(); // fetched prop payloads, shared by the library + placement geometry
const groupDefIdx = new Map<string, GroupDef>();  // "<level>:<id>" -> mined group def, for placements to resolve

const container = document.getElementById('viewport')!;
const logEl = document.getElementById('log')! as HTMLDivElement;
const logTextEl = document.getElementById('log-text')! as HTMLPreElement;
const loadStatus = createLoadStatus();
document.getElementById('log-close')!.addEventListener('click', () => log(''));

const brush = {
  op: 'raise' as BrushOp,
  dir: 'vertical' as BrushDir,
  falloff: 'smooth' as BrushFalloff,
  flattenMode: 'height' as FlattenMode,
  flattenPlaneBehavior: 'locked' as FlattenPlaneBehavior,
  radius: 60,
  strength: 1.2,
  smoothAmount: 50,
  flattenAmount: 35,
  pushAmount: 65,
};

// Edit is an application workflow, not bootstrap code. Its viewport dependency is lazy because the viewport
// consumes the session's callbacks while it is being constructed; no callback can fire until construction ends.
const edit = createEditSession({
  store,
  viewport: () => viewport,
  cageActive,
  applyCage,
  persistUi: () => persistUi(),
  scheduleRebuild: () => scheduleRebuild(),
  scheduleCommit: () => scheduleCommit(),
  rebuildTools: () => rebuildTools(),
  updateCmdSheet: () => updateCmdSheet(),
  refreshSelection: () => refreshSelection(),
  log,
});
const {
  exitRegion, refreshHandles,
  cancelBridge, clearCreateEdge, cancelPastePlacement,
} = edit;

// The viewport-event → app-op translation (viewport-callbacks.ts). The callbacks are handed over before the
// panels / prop ops / rebuild funnel / play exist, and they fire only on user events after module
// evaluation — so everything constructed below the viewport is reached through accessor closures.
let effectsEditor: EffectsEditor | null = null;
const viewportCallbacks = createViewportCallbacks({
  store, edit, brush, gemTool, lightTool,
  toggleViewGrid, setViewGridStep, toggleSnap, setSnapStep, setRotationSnapStep,
  selectPaintCell, rangeSelectPaintCells, clearPaintSelection: clearPaintSel,
  viewport: () => viewport,
  palette: () => palette,
  library: () => library,
  propOps: () => propOps,
  play: () => play,
  coursePath: () => coursePath(),
  scheduleRebuild: () => scheduleRebuild(),
  rebuildTools: () => rebuildTools(),
  updateCmdSheet: () => updateCmdSheet(),
  refreshSelection: () => refreshSelection(),
  getSceneSel: () => getSceneSel(),
  selectScene: kind => selectScene(kind),
  showReferenceLightDetails: (level, light) => reference.setSelectedLightDetails(level, light),
  persistRef: () => persistRef(),
  sendRideEvent: event => session.rideEvent(event),
});
viewportCallbacks.onMoveEffect = pos => effectsEditor?.moveSelectedEmitter(pos);
viewportCallbacks.onSelectEffectProp = (index, additive) => effectsEditor?.selectAuthoredPropEffect(index, additive) ?? false;
viewportCallbacks.onSelectReferenceEffectProp = (sourceIndex, additive) => effectsEditor?.selectReferencePropEffect(sourceIndex, additive) ?? false;
viewportCallbacks.onSelectParticleVolume = (source, index, id) => effectsEditor?.selectParticleVolume(source, index, id) ?? false;
// A shipped level's grind curve has no document object to select — it IS a native Splines.json row — so the
// Effects panel owns the whole selection and the store never hears about it.
viewportCallbacks.onSelectReferenceSpline = index => { effectsEditor?.selectReferenceSpline(index); };
viewportCallbacks.onClearEffectSelection = () => { effectsEditor?.clearSelection(); };
const selectRailNodeForMode = viewportCallbacks.onSelectRailNode;
viewportCallbacks.onSelectRailNode = (rail, node) => {
  selectRailNodeForMode?.(rail, node);
  if (rail !== null && store.currentMode === 'effects') effectsEditor?.selectCourseSpline(rail, node);
};
// An armed Edit modal tool owns its clicks: a prop pick or a click on nothing keeps that tool's
// meaning and never enters or leaves a model edit session.
const modalEditToolActive = () => store.bridgeRails !== null || !!store.surgeryTool || !!store.weldTool
  || !!store.createEdgeTool || viewport.pastePlacing || viewport.edgeExtrusionStaged;
// Edit mode: clicking a placed prop SELECTS it — the same amber box + move gizmo Props mode shows — and
// its banner lands in the toolbox: a MODEL placement's opens the edit session (clicking the selected
// piece again enters too), a reference placement's offers the revised copy. A locked session stays put.
viewportCallbacks.onEditPropPick = (index, toggle) => {
  const pp = store.mdoc.props?.[index];
  if (!pp || modalEditToolActive()) return false;
  if (store.modelEditId && store.modelEditLocked) {
    toast(`Editing ${findModel(store.mdoc, store.modelEditId)?.name ?? 'model'} is locked — ✔ done editing to leave.`, 'warn');
    return true;
  }
  if (toggle) {
    if (store.modelEditId) exitModelEdit(false);
    edit.toggleEditProp(index);
    return true;
  }
  if (pp.level === AUTHORED_MODEL_LEVEL && store.selectedProp === index) {
    enterModelEdit(modelIdFromNumber(pp.model), index); // click-again on the selected model piece: enter AT it
    return true;
  }
  if (store.modelEditId) exitModelEdit(false); // selecting a placement is a click off the edited model
  edit.deselectEdit(); // one selection at a time: the placement takes the toolbox + gizmo
  store.selectedProp = index;
  store.multiSel = [];
  rebuildTools();
  scheduleRebuild();
  return true;
};
// Edit mode: a plain click off everything deselects a selected placement, then ends an unlocked model
// session — the click-on / click-off flow.
viewportCallbacks.onEditClickAway = () => {
  if (modalEditToolActive()) return;
  if (store.selectedProp !== null || store.multiSel.length) {
    store.selectedProp = null;
    store.multiSel = [];
    rebuildTools();
    scheduleRebuild();
    return;
  }
  if (!store.modelEditId || store.modelEditLocked) return;
  exitModelEdit();
};
const viewport: Viewport = new Viewport(container, viewportCallbacks, store, store.playSmoothCutoutsOn); // the store IS the mesh-selection substrate the viewport reads (MeshSelectionState)

viewport.brushRadius = brush.radius;

// `?verifyRebuild=1`: check every incremental patch write against a full rebuild of the same document and
// throw on any disagreement (docs/039, stage 6). A stale patch is silent — the terrain simply renders
// differently for two people looking at one mountain — so the equivalence the mesh suite proves is also
// checkable in a live session. Far too slow to leave on, and exactly what you want while hunting one.
if (new URLSearchParams(location.search).has('verifyRebuild')) viewport.verifyRebuilds = true;

// Automated-browser support (docs/029): mirrors scene entities into the accessibility tree so an MCP client
// can address a prop / rail / gem / light by uid, and exposes a READ-ONLY observation API. Dev + ?agent=1
// only, and dynamically imported so it never enters a production bundle. Null in every ordinary session.
let agentLayer: AgentLayer | null = null;
if (import.meta.env.DEV && new URLSearchParams(location.search).has('agent')) {
  void import('./dev/agent-layer')
    .then(m => { agentLayer = m.installAgentLayer({ store, viewport, container }); })
    .catch(e => log(`agent layer failed to load: ${e}`));
}

// The Palette (paint mode): a staging grid of tile + ride-feel + orientation combos.
// Selecting a cell makes it the terrain brush; its .el is mounted under the Tools panel (below).
const palette = new Palette({
  onSelect(b, preserveInspection) {
    store.paintBrush = b; // painting terrain uses this exact tile + ride feel + orientation
    library.highlightRef(b.ref); // mirror the active tile in the Texture Library
    viewport.setPaintBrush(b);   // arm placement mode — the ghost previews this brush on the hovered cell
    if (!preserveInspection) clearPaintSel(); // the panel action retains its inspected source until first stroke
    updateCmdSheet();
  },
  onContentsChange() { library.refresh(); }, // re-filter the Library when "hide staged" is on
  onToggleLibrary() { setLibraryWanted(!store.libraryWanted); }, // pad's "Texture Library" toggle (open intent is remembered)
  onViewChange() { updateCmdSheet(); }, // Texture ↔ Surface changes the pad's keys/right-click, so redraw the help
});

// The bottom Texture Library panel (class TextureLibrary): the level's texture tiles, the drag source.
const library = new TextureLibrary({
  onBrush(b, sampled) {
    store.paintBrush = b;
    palette.setCurrent(b, sampled); // a viewport sample keeps its clicked-surface details visible
    viewport.setPaintBrush(b); // arm placement mode — the ghost previews this brush on the hovered cell
    if (!sampled) clearPaintSel(); // Library/Palette brushes replace inspection; samples retain their source
    // picking a tile means "paint this" - jump straight into paint mode
    if (store.currentMode !== 'paint') setMode('paint');
    else rebuildTools();
    updatePaintUi();
  },
  // show / hide re-places the overlays that sit above the panel, and settles the pull-up tab: a pick raises
  // this panel without touching the open intent, so the tab has to stand down on the panel itself appearing
  onHeightChange() { updateCmdSheet(); syncDockTabs(); },
  onClose() { setLibraryWanted(false); }, // the panel's ✕ — remembers it as closed
  // a texture pick resolved; the panel goes back to obeying the per-mode rule (hidden again outside Paint)
  onPickEnd() { rebuildTools(); updatePaintUi(); },
  stagedRefs: () => palette.stagedRefs(),  // the Palette's tiles, so the Library can hide ones already staged
  onTextureRevision() {
    propLib.invalidateThumbnails();
    scheduleRebuild(); // fold a tile that just entered the library into whatever is already drawn
  },
  docTexUsage: ref => countDocTexRefs(ref),
  onTextureRenamed: (from, to) => retargetDocTex(from, to),
  onTextureDeleted: ref => retargetDocTex(ref, null),
  refLevel: () => reference.getRefLevel(), // the opening view falls back to the level being studied
  mountainName: () => store.mdoc.name,
});

/** Every place the LIVE document wears a texture ref: painted terrain cells plus authored model tiles.
 *  Imported props are NOT counted here — their records live on disk and the Library asks the server. */
function countDocTexRefs(ref: string): number {
  const doc = activeDoc();
  const painted = Object.values(doc.quadTex ?? {}).filter(r => r === ref).length;
  // A model wears a tile as its resting texture and again as any flipbook state, and both are places the
  // document would be left holding a dead ref — so both count toward what a delete costs.
  const models = (doc.models ?? [])
    .reduce((n, m) => n + (m.texture === ref ? 1 : 0) + (m.frames ?? []).filter(f => f === ref).length, 0);
  return painted + models;
}

/**
 * Repoint the document's texture refs after a Custom tile was renamed, or drop them (`to === null`) after
 * one was deleted. Both cases go through history, so a rename that turns out to be a mistake is one Ctrl+Z
 * away — the FILE operation is not undoable, but the document edit that followed it is, and leaving that
 * un-undoable would be the more surprising half.
 *
 * A dropped cell falls back to its SurfaceType tint and a cleared model to untextured clay, which is what
 * those absent fields already mean everywhere else — no separate "missing texture" state is invented.
 */
function retargetDocTex(from: string, to: string | null): void {
  const doc = activeDoc();
  let changed = 0;
  for (const [q, ref] of Object.entries(doc.quadTex ?? {})) {
    if (ref !== from) continue;
    if (to) doc.quadTex![Number(q)] = to; else delete doc.quadTex![Number(q)];
    changed++;
  }
  for (const model of doc.models ?? []) {
    // States first, so a dropped tile leaves a shorter list rather than a hole; the list is then re-headed
    // onto whatever the texture ends up as, keeping frames[0] === texture true through the edit.
    const frames = model.frames ?? [];
    if (frames.some(ref => ref === from)) {
      const next = to ? frames.map(ref => (ref === from ? to : ref)) : frames.filter(ref => ref !== from);
      if (next.length > 1) model.frames = next; else delete model.frames;
      changed++;
    }
    if (model.texture === from) {
      if (to) model.texture = to; else delete model.texture;
      changed++;
    }
    if (model.frames?.length) {
      const head = model.texture ? [model.texture, ...model.frames.slice(1)] : [];
      if (head.length > 1) model.frames = head; else delete model.frames;
    }
  }
  palette.retargetRef(from, to);       // the staging pad holds refs too, and is not part of the document
  propLib.invalidateThumbnails();
  if (changed) commit(); // history derives its own summary by diffing the doc (describeChange)
  scheduleRebuild();
}

// The bottom Prop Library panel (class PropLibrary): a reference world's placeable models, click to arm.
const propLib = new PropLibrary({
  async levels() {
    // This mountain first, then reference levels from the configured Maps library (docs/012).
    let server: string[] = [];
    try { server = (await fetchJson<{ levels?: string[] }>('/api/props')).levels ?? []; }
    catch { /* dev server down — the authored mountain still works */ }
    return [AUTHORED_MODEL_LEVEL, ...server];
  },
  loadLevel: (level) => propOps.ensurePropLevel(level), // shares the propLevels cache + registers geometry
  // the two pseudo-levels are authored/imported geometry, not a shipped level with placements to mine
  groups: (level) => level === AUTHORED_MODEL_LEVEL || level === IMPORTED_PROP_LEVEL
    ? Promise.resolve([]) : propOps.ensureGroupDefs(level),
  onPick: (level, model, name) => void propOps.armProp(level, model, name),
  onPickGroup: (level, id) => void propOps.armGroupById(level, id),
  // the Custom view also lists imported GLB props, loaded through its + tile (docs/032)
  importedProps: () => propOps.ensurePropLevel(IMPORTED_PROP_LEVEL),
  onImported: () => propOps.reloadImportedProps(),
  refLevel: () => reference.getRefLevel(), // the opening view falls back to the level being studied
  mountainName: () => store.mdoc.name,
  onHeightChange() { updateCmdSheet(); syncDockTabs(); }, // re-place the overlays above the panel, settle the tab
  onClose() { setPropLibWanted(false); }, // the panel's ✕ — remembers it as closed
  docModels: {
    usage: (level, model) => placementsOf(level, model).length,
    rename: (level, model, name) => renameLibraryModel(level, model, name),
    remove: (level, model) => removeLibraryModel(level, model),
    duplicate: model => duplicateLibraryModel(model),
  },
});

/** Indices of every placement of one library model, highest first — so a caller can splice the list without
 *  invalidating the indices it has not reached yet. */
function placementsOf(level: string, model: number): number[] {
  const props = store.mdoc.props ?? [];
  const out: number[] = [];
  for (let i = props.length - 1; i >= 0; i--) if (props[i].level === level && props[i].model === model) out.push(i);
  return out;
}

/** The Prop Library renamed a model the author owns. A placement carries its model's name denormalised (it
 *  is what the selection panel and the export's object names read), so the placements move with it; an
 *  authored model's definition is the name's home and moves too. */
function renameLibraryModel(level: string, model: number, name: string): void {
  const authored = level === AUTHORED_MODEL_LEVEL;
  const definition = authored ? findModel(store.mdoc, modelIdFromNumber(model)) : null;
  if (authored && !definition) return;
  if (definition) definition.name = name;
  for (const i of placementsOf(level, model)) store.mdoc.props![i].name = name;
  commit(); // the FILE half of an imported rename is not undoable, but the document half is
  scheduleRebuild();
  rebuildTools();
}

/**
 * The Prop Library deleted a model the author owns: its placements go with it, and — for an authored model —
 * the definition itself.
 *
 * Leaving the placements behind was the alternative, and it is worse than it sounds: a placement whose model
 * has gone renders nothing, so it becomes an invisible object that cannot be clicked and only reappears as a
 * warning at export time. Removing them is one commit, so the whole delete is one Ctrl+Z away on the document
 * side even though an imported record's file is gone for good.
 */
function removeLibraryModel(level: string, model: number): void {
  const id = modelIdFromNumber(model);
  // End its edit session BEFORE the sweep: leaving a session seats a home placement for a model that has
  // none, so exiting afterwards would put one of these back for a definition that is about to go.
  if (level === AUTHORED_MODEL_LEVEL && store.modelEditId === id) exitModelEdit(false);
  for (const i of placementsOf(level, model)) {
    const placementId = store.mdoc.props![i]?.id;
    if (placementId && store.mdoc.effects) detachEffectFromProp(store.mdoc.effects, placementId);
    store.mdoc.props!.splice(i, 1);
  }
  if (level === AUTHORED_MODEL_LEVEL)
    store.mdoc.models = (store.mdoc.models ?? []).filter(entry => entry.id !== id);
  if (store.armedProp?.level === level && store.armedProp.model === model) propOps.disarmProp();
  store.selectedProp = null; // the indices it named have moved
  store.multiSel = [];
  commit();
  scheduleRebuild();
  rebuildTools();
  updateCmdSheet();
}

/**
 * A model came back from Blender (docs/046): put its cage into the definition.
 *
 * This is where the round trip lands for an AUTHORED model, and it is a document edit like any other — one
 * `commit()`, so a push that turned out wrong is one Ctrl+Z from the cage that went out. The definition is
 * shared by every placement, so all of them re-render against the new geometry with nothing else to do; the
 * anchor is deliberately left alone, because the push already came home in world metres against it.
 *
 * An open edit session on this model has to end first. `modelEditDocFor` hands the session the model's OWN
 * arrays, so replacing them underneath it would leave the substrate drawing a mesh the document no longer
 * holds — and the next commit out of that session would put the pre-Blender geometry straight back.
 */
function applyBlenderCage(
  model: number,
  cage: { vertices: number[]; quads: [number, number, number, number][] },
  texture?: string,
): boolean {
  const id = modelIdFromNumber(model);
  const definition = findModel(store.mdoc, id);
  if (!definition) return false;                       // deleted while the artist was in Blender
  if (store.modelEditId === id) exitModelEdit(false);
  definition.vertices = cage.vertices;
  definition.quads = cage.quads;
  // Channels keyed on the OLD topology cannot survive a mesh the artist rebuilt in another tool, and a stale
  // lock or T-junction is worse than none: it names quads that are now somebody else's.
  delete definition.quadLocked;
  delete definition.freeEdges;
  delete definition.tJunctions;
  // Art the same push brought back. It lands in the same commit as the cage, because painting a tile and
  // reshaping what wears it is one edit to the author and should be one Ctrl+Z. `frames[0] === texture` is an
  // invariant of a flipbook model (docs/028), so the list is re-headed rather than left disagreeing.
  if (texture && definition.texture !== texture) {
    definition.texture = texture;
    if (definition.frames?.length) definition.frames = [texture, ...definition.frames.slice(1)];
  }
  commit();
  propLib.invalidateThumbnails();
  scheduleRebuild();
  rebuildTools();
  return true;
}

/** Take whatever Blender pushed back for this mountain's authored models and tiles, and say so once for the
 *  batch. A repainted tile's ref MOVED (docs/038), so the document follows it through the same retarget the
 *  Texture Library's own ⟳ replace art goes through — one undoable edit, not a route writing the document. */
async function collectBlenderPushes(): Promise<void> {
  const applied = await drainBlenderPushes(push => {
    if (push.kind === 'retex') {
      // Reported only when the document actually wore it. The move is applied and acknowledged either way —
      // leaving it in the inbox would replay it forever — but a mountain where nothing but an imported
      // record wore that tile has nothing for the author to be told about.
      const wore = countDocTexRefs(push.from) > 0;
      retargetDocTex(push.from, push.to);
      return wore;
    }
    return applyBlenderCage(push.id, push.cage, push.texture);
  });
  if (applied.length) toast(describeApplied(applied), 'ok', 6000);
}

/** Copy an authored model's definition from the library (imported records duplicate on the server). The copy
 *  is named by the document's own revision rule — 'Rail jump' → 'Rail jump v2' — and starts unplaced. */
function duplicateLibraryModel(model: number): { model: number; name: string } | null {
  const source = findModel(store.mdoc, modelIdFromNumber(model));
  if (!source) return null;
  const copy = duplicateAuthoredModel(store.mdoc, source);
  commit();
  scheduleRebuild();
  return { model: modelNumber(copy.id), name: copy.name };
}

// The Prop Tools preview card (big 3/4 thumbnail of the held / selected prop), mounted at the top of the
// Tools panel and shown only in Props mode — see updatePropPreview / buildPropTools. Drag it to orbit the model.
const propPreview = new PropPreview();

// The idle Prop Tools launcher at the very top of the panel: a full-width "Prop Library" show/hide toggle — the
// props-side twin of the paint pad's Texture Library toggle — followed by full-width Add rail pipe / Add gem /
// Add light actions. It is a persistent panel child, but the tools coordinator hides it while an object owns
// the details panel. PROP_LIB_ICON + the other glyphs live in ui/icons.ts.
const propLibToggle = document.createElement('div');
propLibToggle.className = 'sp-prop-launchers';
propLibToggle.style.display = 'none';
const propLibBtn = document.createElement('button');
propLibBtn.type = 'button';
propLibBtn.className = 'sp-btn sp-prop-launcher';
propLibBtn.innerHTML = `${PROP_LIB_ICON}<span>Prop Library</span>`;
tooltip(propLibBtn, 'Show / hide the Prop Library — the reference world’s placeable props, at the bottom of the screen.');
propLibBtn.onclick = () => setPropLibWanted(!store.propLibWanted); // open intent is remembered across Props visits
propLibToggle.appendChild(propLibBtn);
/** Reflect the Prop Library's open intent on the Prop Tools "Prop Library" toggle (its pressed highlight). */
function syncPropLibBtn() { propLibBtn.classList.toggle('on', store.propLibWanted); }

// The pull-up tabs at the bottom edge (class DockTab): while a library is hidden in its own mode, a small
// handle in the middle of the bottom edge says what is folded away down there and brings it back. Without one
// the panel's ✕ is close to a one-way door — reopening means already knowing the toggle is up in the Tools
// panel. Each tab is that toggle's twin, offered where the panel itself sits.
const libraryTab = new DockTab({
  icon: LIB_GRID_ICON, label: 'Texture Library',
  tip: 'Show the Texture Library — the level’s texture tiles, at the bottom of the screen.',
  onOpen: () => setLibraryWanted(true),
});
const propLibTab = new DockTab({
  icon: LIB_GRID_ICON, label: 'Prop Library',
  tip: 'Show the Prop Library — this mountain’s and the reference world’s placeable props, at the bottom of the screen.',
  onOpen: () => setPropLibWanted(true),
});

/** Offer each tab exactly when its library is hidden AND its own mode is up — so it never competes with the
 *  panel it opens, and never appears in a mode where that panel could not show anyway. A live texture pick
 *  holds the Texture panel open from other modes (docs/005), so the tab stands down for that too. */
function syncDockTabs() {
  libraryTab.setVisible(store.currentMode === 'paint' && !store.libraryWanted && !library.picking);
  propLibTab.setVisible(store.currentMode === 'props' && !store.propLibWanted);
}

/** Set whether the Texture Library should be open, remember it, and apply it if we're in Paint mode (it only
 *  shows there). The paint pad's toggle, the bottom tab, the panel's ✕, and boot-restore all go through here. */
function setLibraryWanted(want: boolean) {
  store.libraryWanted = want;
  if (store.currentMode === 'paint') { if (want) library.show(); else library.hide(); }
  palette.setLibraryOpen(want);
  syncDockTabs();
  persistUi();
}

/** Set whether the Prop Library should be open, remember it, and apply it if we're in Props mode. */
function setPropLibWanted(want: boolean) {
  store.propLibWanted = want;
  if (store.currentMode === 'props') { if (want) propLib.show(); else propLib.hide(); }
  syncPropLibBtn();
  syncDockTabs();
  updateCmdSheet();
  persistUi();
}

// Push the last session's shading onto the fresh viewport (mode + cage are (re)applied by loadMountain at
// boot). The setter no-ops against the still-empty terrain but seeds the field the first build reads, so the
// map draws in the saved shading (incl. the cage-only 'none' view) with no default-state flash.
if (SHADES.includes(storedUi.shadeMode as ShadeMode)) viewport.shadeMode = storedUi.shadeMode as ShadeMode;
if (store.fOverlayOn) applyFOverlay(); // restore the persisted F overlay across all its displays
viewport.viewGridStep = store.viewGridStep;
viewport.viewGrid = store.viewGridOn;  // restore the XYZ world-coordinate reference grid
viewport.snapStep = store.snapStep;
viewport.rotationSnapStep = store.rotationSnapStep;
viewport.snapEnabled = store.snapOn;
viewport.courseGuide = store.courseGuideOn;
viewport.normalsGuide = store.normalsOn;
viewport.aiPathsGuide = store.aiPathsOn;
viewport.playAiPathsGuide = store.playAiPathsOn; // Play's AI-path overlay is its own toggle, not Info's
viewport.aiRiderMax = store.playAiMax;
viewport.riderModel = store.playRiderModel;
viewport.riderStyle = store.playRiderStyle;
viewport.rideGear = store.playRideGear;
viewport.snowboardStance = store.playSnowboardStance;
viewport.raceMode = store.playRaceMode; // race or showoff: which way a test ride's clock runs

const activeDoc = (): EditDoc => store.mdoc;
const coursePath = (): CoursePath => store.mdoc.course;

// Session persistence (keys + writers) lives in state/storage.ts; the writers pull the live values through
// these getters. Destructured to the same names the ~20 call sites already use.
const persistence = createPersistence({
  getDoc: () => store.mdoc,
  getView: () => viewport.serializeView(),
  getUi: () => ({ mode: store.currentMode, cageOn: store.cageOn, viewGrid: store.viewGridOn, viewGridStep: store.viewGridStep,
    snapOn: store.snapOn, snapStep: store.snapStep, rotationSnapStep: store.rotationSnapStep,
    shadeMode: viewport.shadeMode, fOverlay: store.fOverlayOn, courseGuide: store.courseGuideOn, normals: store.normalsOn, aiPaths: store.aiPathsOn, propsVisible: store.propsVisible,
    collisionOverlay: store.collisionOverlayOn,
    worldEffects: store.worldEffectsVisible,
    lightRig: store.lightRigVisible, propLights: store.propLightsVisible, skybox: store.skyboxVisible,
    tricks: store.tricksVisible, textureLib: store.libraryWanted,
    propLib: store.propLibWanted, playTarget: store.playTarget, playRiderModel: store.playRiderModel,
    playRiderStyle: store.playRiderStyle, playRideGear: store.playRideGear,
    playSnowboardStance: store.playSnowboardStance,
    playRaceMode: store.playRaceMode,
    playAiPaths: store.playAiPathsOn, playAiMax: store.playAiMax, playCountdown: store.playCountdownOn,
    playSnow: store.playSnowAmount, playMusic: store.playMusicOn, playGameVolume: store.playGameVolume,
    playTelemetry: store.playTelemetryOn, playBoardFx: store.playBoardFxOn,
    playColliders: store.playCollidersOn, playSmoothCutouts: store.playSmoothCutoutsOn,
    playVrRenderScale: store.playVrRenderScale,
    playVrEyeBuffer: store.playVrEyeBuffer,
    playVrLayerMode: store.playVrLayerMode, playVrStats: store.playVrStatsOn,
    playDrawDistance: store.playDrawDistance,
    gizmoFrame: store.gizmoFrame }),
  getRef: () => (reference.hasReference() && reference.getRefLevel() && !reference.getRefLevel().startsWith('('))
    ? { level: reference.getRefLevel(), offset: viewport.referenceOffset() } : null,
});
const { persistDoc, persistView, persistUi, persistRef } = persistence;

// The editable document is a responsive browser replica of one revisioned project on the local Slopesmith
// service. localStorage remains a last-ditch recovery copy; successful server saves are the durable authority.
const syncChip = createSyncStatus({
  replay: () => registerSync.replayHeld(),
  discard: () => registerSync.discardHeld(),
});
let lastProjectStateMessage = '';
const projectSync = createProjectSync({
  getDoc: () => store.mdoc,
  onState: (state: ProjectSaveState, detail = '') => {
    syncChip.project(state, detail);
    document.documentElement.dataset.projectSave = state;
    if ((state === 'error' || state === 'conflict' || state === 'recovery-only' || state === 'following')
      && detail && detail !== lastProjectStateMessage) {
      lastProjectStateMessage = detail;
      log(detail);
      if (state === 'conflict') toast(detail, 'err', 8000);
    }
  },
  // A refused save stops autosave, so it opens its resolution rather than leaving the editor with nowhere to
  // write. File ▸ Resolve conflict… reopens it if this one is dismissed.
  onConflict: () => conflictDialog(),
  // A revision somebody else wrote, already applied to this replica as a whole-document replace. Undo history
  // is reset for the same reason a project switch resets it: every state it holds was built on a document
  // that is no longer the project's (docs/038).
  onFollow: document => {
    history.reset();
    store.mdoc = document;
    void loadMountain();
  },
  // Shared: what is outstanding is a coalescing window of register assignments, not a document (docs/039).
  flushShared: () => registerSync.flush(),
});

// The mutation -> render funnel lives in state/rebuild.ts; renderDoc is the actual per-frame rebuild — it
// pushes the live doc + the current selections into the viewport, derives the sign-light rig, and persists.
// The editable substrate is the mountain net — or, while a model is being edited, that model's flat mesh.
const activeEditMesh = () => store.modelEditDoc ?? store.mdoc;
/**
 * What the viewport has drawn of the control net, so a render can ask what moved rather than be told
 * (docs/039, stage 6). One comparison per rendered frame answers with the UNION of everything that changed
 * since the last one, so a burst of remote assignments arriving together produces one rebuild of what they
 * touched between them.
 */
const netWatcher = createNetWatcher();

function prepareRenderDoc(change: NetChange) {
  if (!change.renumbered) return;
  // Which vertices and quads exist has moved, so every one of these is an index into a mesh that is gone.
  const hadHidden = store.hiddenVertices.length || store.hiddenEdges.length || store.hiddenQuads.length;
  const hadControlCages = store.controlCageEdges.length || store.controlCageQuads.length;
  const hadDiagnostic = store.selectedEdgeCrossing !== null || store.selectedCoincidentVertices !== null;
  store.hiddenVertices = []; store.hiddenEdges = []; store.hiddenQuads = [];
  store.controlCageEdges = []; store.controlCageQuads = [];
  store.selectedEdgeCrossing = null; store.selectedCoincidentVertices = null;
  if ((hadHidden || hadControlCages || hadDiagnostic) && store.currentMode === 'edit') rebuildTools();
}

/**
 * Draw whatever the net watcher says moved.
 *
 * `none` touches the terrain not at all — an object assignment, a selection or a global the quilt does not
 * read leaves every patch exactly where it is. `patches` re-emits the dependency radius and arms the settle
 * pass for the occlusion bake it left standing. `whole` is the full re-tessellation, which is also the
 * fallback whenever the incremental path declines a change (a preview not built yet, a topology that moved
 * under it) — declining is always safe, because the answer is only ever "rebuild more than you had to".
 */
function renderMountainTerrain(change: NetChange) {
  const mesh = activeEditMesh();
  const incremental = change.kind === 'patches' && viewport.updateMountain(mesh, change);
  // The overlays a full rebuild folds in already — the run, the awareness marks, the selection glyphs seated
  // on corners — are owed by the other two paths, because they move for reasons the quilt knows nothing about.
  if (!incremental && change.kind !== 'none') viewport.setMountain(mesh, store.selected, store.selectedKnots);
  else viewport.refreshMountainOverlays(mesh, store.selected, store.selectedKnots);
  viewport.refreshHiddenMesh(); // a no-op unless the hidden sets moved, which is a selection rather than a doc change
  if (viewport.mountainSettlePending) scheduleSettle();
}

function hiddenModelPlacements(): Set<number> | undefined {
  return store.modelEditId ? new Set((store.mdoc.props ?? [])
    .map((pp, i) => pp.level === AUTHORED_MODEL_LEVEL && modelIdFromNumber(pp.model) === store.modelEditId
      && (store.modelEditPlacementId === null || pp.id === store.modelEditPlacementId) ? i : -1)
    .filter(i => i >= 0)) : undefined;
}

function renderMountainObjects() {
  propOps.rebuildAuthoredRig();  // derive the sign lights + resolve the free lights BEFORE the props, so the tint is ready
  propOps.syncAuthoredModelLevel(); // re-bake the '@models' pseudo-level so edited definitions re-render live
  // during a model-edit session the placement it opened AT hides (the substrate stands in its place);
  // the model's other placements stay visible and update live. With no session placement (create flow,
  // older saves without ids) every placement of the model hides, as before.
  viewport.setPlacedProps(store.mdoc.props ?? [], store.selectedProp, store.multiSel, store.mdoc.effects, hiddenModelPlacements());
  viewport.setParticleVolumes(store.mdoc.particleVolumes ?? []);
}

function renderMountainDetails() {
  viewport.setFreeLights(store.mdoc.lights ?? [], store.selectedLight);
  viewport.setRails(store.mdoc.rails ?? [], store.selectedRail, store.selectedNode);
  viewport.setGems(store.mdoc.gems ?? [], store.selectedGem);
  // Screens resolve against the placements they are attached to, so they rebuild whenever either does.
  viewport.setScreens(store.mdoc.screens ?? [], store.mdoc.props, store.selectedScreen);
  if (store.mdoc.gems?.length || store.mdoc.rails?.some(railHasTube))
    void trickTools.ensureTrickArt(); // native crystals + rail skin (a tubeless curve has no visible art)
}

/** A realized document edit must reach all three persistence layers. localStorage is only the recovery copy;
 *  the disk project wins on reload, while a shared session writes the global through its register transport. */
function persistDocumentEdit() {
  persistDoc();
  projectSync.schedule();
  registerSync.noteEdit();
}

function finishRenderDoc(edited = true) {
  // Loading/replacing a document uses the same renderer as an authored edit, but it must not turn that
  // rendering work into a save. In particular, a dev reload of an idle tab must not race a headless
  // publisher by writing the document it merely opened under a newer project revision.
  if (edited) persistDocumentEdit();
  else persistDoc(); // keep the crash-recovery copy current without touching the revisioned project
  refreshMountainTitle();
  agentLayer?.onRendered(); // drives the agent layer's settled() + entity re-projection
}

function renderDoc() {
  reconcileTJunctionGeometry(activeEditMesh());
  const change = netWatcher.note(activeEditMesh());
  prepareRenderDoc(change);
  renderMountainTerrain(change);
  renderMountainObjects();
  renderMountainDetails();
  finishRenderDoc();
}

/**
 * The deferred half of a rebuild, once the mountain has been quiet for a moment (state/rebuild.ts).
 *
 * Cast shadow, ambient occlusion and the whole-mesh diagnostics are global queries — a moved ridge shades
 * ground it never touches — so incremental renders leave them standing and this puts them right at rest.
 */
function settleDoc() {
  viewport.settleMountain();
  agentLayer?.onRendered();
}

/** Document replacement uses the same render stages, with a patch-counting tessellator and paint breaks. */
async function renderDocProgressively(token: number) {
  const mesh = activeEditMesh();
  const vertices = (mesh.vertices.length / 3) | 0;
  reconcileTJunctionGeometry(mesh);
  prepareRenderDoc(netWatcher.note(mesh));
  loadStatus.update(token, {
    progress: 10,
    label: 'Preparing mountain topology',
    detail: `${mesh.quads.length.toLocaleString()} patches · ${vertices.toLocaleString()} control points`,
  });
  await loadStatus.afterPaint();
  await viewport.setMountainProgressive(
    mesh,
    store.selected,
    store.selectedKnots,
    (completed, total) => {
      const ratio = total ? completed / total : 1;
      loadStatus.update(token, {
        progress: 14 + ratio * 50,
        label: 'Building terrain geometry',
        detail: `${completed.toLocaleString()} / ${total.toLocaleString()} patches`,
      });
    },
    loadStatus.yieldToBrowser,
  );
  viewport.refreshHiddenMesh();
  loadStatus.update(token, {
    progress: 70,
    label: 'Restoring mountain objects',
    detail: `${(store.mdoc.props?.length ?? 0).toLocaleString()} placed props`,
  });
  await loadStatus.afterPaint();
  await propOps.syncPropGeom(false); // progressive load renders once, after every referenced model is available
  renderMountainObjects();
  loadStatus.update(token, {
    progress: 86,
    label: 'Adding lights, rails, and effects',
    detail: `${(store.mdoc.lights?.length ?? 0).toLocaleString()} lights · ${(store.mdoc.rails?.length ?? 0).toLocaleString()} rails · ${(store.mdoc.gems?.length ?? 0).toLocaleString()} gems`,
  });
  await loadStatus.afterPaint();
  renderMountainDetails();
  loadStatus.update(token, { progress: 96, label: 'Finalizing editor state', detail: 'Preparing the restored session' });
  finishRenderDoc(false);
}
const { scheduleRebuild, scheduleSettle } = createRebuilder({
  scheduleCommit: () => scheduleCommit(), // deferred: history is created below
  render: renderDoc,
  settle: settleDoc,
  // A render that threw may have left the quilt half-written, and the watcher has already taken the document
  // it was drawing as drawn. Forgetting that is what makes the next render a full rebuild rather than an
  // incremental one on top of a state nothing ever finished painting.
  onError: e => { netWatcher.reset(); log(`build error: ${e}`); agentLayer?.onBuildError(e); },
});

function log(msg: string) {
  logTextEl.textContent = msg;
  logEl.style.display = msg ? 'block' : 'none';
}

const surfaceOptions: Record<string, number> = {};
for (const [num, lbl] of Object.entries(SURFACE_TYPES)) surfaceOptions[`${num} ${lbl}`] = Number(num);

// Undo / redo (debounced doc snapshots) live in state/history.ts. Restoring a snapshot reassigns the doc and
// resets every selection, then rebuilds + rebinds the panels — that's the host's job, passed in as onRestore.
// EVERY selection is dropped, because every one of them is an INDEX into the doc we're about to replace: a
// corner / cell / edge id, a prop or rail slot, a painted quad. Undoing a topology edit (loop cut or split)
// shrinks the net, so a surviving id can point past its end — and the next preview rebuild reads
// mesh.quads[dead] and throws into the rebuild error boundary, freezing the terrain at its pre-undo geometry.
function restoreDoc(json: string) {
  cancelPastePlacement(false);
  cancelBridge(false, false);
  store.mdoc = migrateMountain(JSON.parse(json)); // migrate guarantees a mesh doc back
  // re-seat (or exit) the model-edit substrate: its arrays belonged to the doc we just replaced
  refreshModelEditTarget(store);
  viewport.setModelEditContext(!!store.modelEditId, store.mdoc);
  store.hiddenVertices = []; store.hiddenEdges = []; store.hiddenQuads = [];
  store.controlCageEdges = []; store.controlCageQuads = [];
  store.selected = null;
  store.selectedKnots = [];
  store.selectedProp = null;
  store.multiSel = [];
  store.selectedLight = null;
  store.selectedRefLight = null;
  store.selectedScreen = null;
  store.selectedRefScreen = null;
  viewport.clearScreenSelection();
  store.selectedRail = null;
  store.selectedNode = null;
  store.railDrawing = false;
  viewport.setRailArmed(false);
  store.selectedGem = null;
  store.gemArmed = false;
  viewport.setGemArmed(false);
  store.trickTool = null;
  clearCreateEdge();
  // the terrain-net selections: the corner + its tangent nubs, the region, the cell / edge families (and the
  // sub-cage handles they hang off), any armed surgery tool, and Paint's picked quads
  store.selectedCorner = null;
  store.selectedEdgeCrossing = null;
  store.selectedCoincidentVertices = null;
  if (store.surgeryTool) { store.surgeryTool = null; viewport.setSurgeryTool(null); } // its ghost previews the OLD net
  if (store.weldTool) { store.weldTool = null; store.weldSource = []; store.weldEdgeSource = []; viewport.setWeldTool(false); } // its source ids belong to the OLD net
  exitRegion();                    // region + cell + edge selections (refreshEditCells / refreshEditEdges drop the cage handles)
  viewport.clearCornerSelection(); // the corner marker / gizmo / tangent nubs seated on the old net
  clearPaintSel();
  refreshHandles();
  rebuildScene();
  applySceneSelection();
  refreshSelection();
  if (store.currentMode === 'edit' || store.currentMode === 'props' || store.currentMode === 'effects') rebuildTools(); // the toolbox described the dropped selection
  scheduleRebuild();
  void propOps.syncPropGeom(); // an undone/redone state may reference a prop level not yet loaded
}

function refreshHistButtons() {
  histBar.refresh(); // re-reads each button's enabled() (undo/redo history depth)
}

const history = createHistory({
  getDocJson: () => JSON.stringify(store.mdoc),
  onRestore: restoreDoc,
  // Undo of an ordinary edit re-asserts register values onto the live document, so the host only has to
  // render what it already holds (docs/039).
  onRefresh: () => scheduleRebuild(),
  refreshButtons: refreshHistButtons,
  registers: () => registerSync,
});
const { scheduleCommit, commit, undo, redo } = history;

// The modal dialogs + file actions (New / generate-terrain / borrow-a-line / History / mountain import/export
// / map export, and the resolution behind a refused save). They replace the document via setDoc + re-run loadMountain, and
// read the loaded reference through getters.
const { newMountainDialog, genTerrainDialog, buildFromReferenceCourseDialog, openProjectDialog, historyDialog,
  closePreview, conflictDialog, renameMountain, duplicateMountain, deleteMountain,
  exportMountain, importMountain, exportDialog } = createDialogs({
  getDoc: activeDoc,
  setDoc: d => { store.mdoc = d; },
  // Opening or creating a map moves this tab's presence and its register room with it (docs/038).
  startProject: async d => { await projectSync.create(d); joinMap(d); },
  canCreateMountains: () => session.mayCreateMountains(),
  canManageMountain: () => session.mayManageMountain(projectSync.current()),
  listProjects: () => projectSync.list(),
  openProject: async id => { const doc = await projectSync.open(id); joinMap(doc); return doc; },
  exportMountainBundle: () => projectSync.exportMountain(),
  importMountainBundle: async (bundle, name) => {
    const imported = await projectSync.importMountain(bundle, name);
    joinMap(imported.document);
    return imported;
  },
  duplicateMountainProject: async name => {
    const duplicated = await projectSync.duplicateMountain(name);
    joinMap(duplicated.document);
    return duplicated;
  },
  renameMountainProject: name => {
    store.mdoc.name = name;
    refreshMountainTitle();
    refreshMapUrl(name); // the manifest still holds the old name until this rename's save lands
    library.refreshMountainName();
    propLib.refreshMountainName();
    reference.refreshMountainName();
    scheduleRebuild();
    rebuildScene();
    effects.render();
  },
  deleteMountainProject: async id => {
    const deleted = await projectSync.deleteMountain(id);
    await leaveDeletedMap({ projectId: deleted.id, name: deleted.name });
  },
  currentProject: () => projectSync.current(),
  listCheckpoints: () => projectSync.checkpoints(),
  readCheckpoint: file => projectSync.readCheckpoint(file),
  exportCheckpoint: file => projectSync.exportCheckpoint(file),
  checkpointNow: (note, reason) => projectSync.checkpointNow(note, reason),
  nameCheckpoint: (file, note) => projectSync.nameCheckpoint(file, note),
  restoreCheckpoint: file => projectSync.restoreCheckpoint(file),
  checkpointChanges: file => projectSync.checkpointChanges(file),
  revertCheckpoint: (file, scope) => projectSync.revertCheckpoint(file, scope),
  // Comparison reuses the authored-map reference layer rather than growing a diff viewer of its own: the
  // checkpoint goes into the slot beside the live mountain, with the placement controls already there.
  compareCheckpoint: (document, label) => reference.showDocumentReference(document, label),
  // The same selection presence already publishes, which is what a selection-bounded revert is scoped by.
  getSelection: () => ({
    vertices: [...new Set([...store.regionSel, ...(store.selectedCorner ? [store.selectedCorner] : [])])],
    quads: [...new Set([...store.cellSel, ...store.paintMultiSel])],
  }),
  isWritable: () => projectSync.isWritable(),
  beginPreview: () => projectSync.beginPreview(),
  endPreview: () => projectSync.endPreview(),
  getConflict: () => projectSync.conflict(),
  keepMine: () => projectSync.keepMine(),
  takeTheirs: () => projectSync.takeTheirs(),
  saveMineAsNewProject: () => projectSync.saveMineAsNewProject(),
  resetHistory: () => history.reset(),
  loadMountain: () => loadMountain(),
  getRefCourse: () => reference.getRefCourse(),
  getRefLevel: () => reference.getRefLevel(),
  log,
});

// ================= Scene toolbox: category launcher + paired Mountain / Reference detail =================
// Reference is the landing view; Lighting / God Rays / Sound / Skybox / Course compare the authored mountain above it.
// rebuildTools swaps this whole block in/out per mode. The panel owns its view
// state + paired folders; the Lighting / Skybox / Reference / lighting-study / sound-study /
// reference-Skybox / reference-Course folders are filled below by the sun + reference + sky subsystems, so it returns
// those handles. The
// selected knot lives in the host store.
let syncSceneSkyPreview = () => {};
let syncGodRayPreview = () => {};
const { sunFolder, godRayFolder, refGodRayFolder, skyPreviewFolder, skyFolder, refFolder, lightFolder,
  refSoundFolder, refSkyFolder, refCourseFolder,
  getSceneSel, setSceneSel, rebuildScene, rebuildOutliner, selectScene, backToInfo,
  applySceneSelection, refreshSelection, deleteKnot, setSceneVisible } = createScenePanel({
  getDoc: activeDoc,
  getSelected: () => store.selected,
  setSelected: i => { store.selected = i; if (i !== null) store.selectedKnots = []; },
  getSelectedKnots: () => store.selectedKnots,
  setSelectedKnots: indices => { store.selectedKnots = indices; if (indices.length) store.selected = null; },
  scheduleRebuild,
  surfaceOptions,
  isSceneActive: () => store.currentMode === 'info',
  onSelectionChange: () => syncSceneSkyPreview(),
  showOwnBox: on => viewport.showOwnBox(on),
  showRefBox: on => viewport.showRefBox(on),
  hasReference: () => reference.hasReference(),
  getReferenceName: () => viewport.refLevelName,
  getCourseVisible: () => store.courseGuideOn,
  setCourseVisible: on => { store.courseGuideOn = on; viewport.courseGuide = on; persistUi(); },
  getNormalsVisible: () => store.normalsOn,
  setNormalsVisible: on => { store.normalsOn = on; viewport.normalsGuide = on; persistUi(); },
  getAiPathsVisible: () => store.aiPathsOn,
  setAiPathsVisible: on => { store.aiPathsOn = on; viewport.aiPathsGuide = on; persistUi(); },
  genTerrainDialog,
});
// ================= Placed props: caches + arming + deletes =================
// The placed-prop domain ops live in props/operations.ts: the model geometry caches (base offsets + local
// boxes), the per-level prop payload + mined group-def fetches, prop / group arming, the delete +
// multi-select ops, and the authored light rig derivation renderDoc re-runs on every rebuild. The tools
// panel is created later, so it's reached through accessor closures (as edit's are, above).
const propOps = createPropOps({
  store, viewport, propLevels, groupDefIdx, propLib, propPreview, setMode,
  scheduleRebuild,
  rebuildTools: () => rebuildTools(),
  updateCmdSheet: () => updateCmdSheet(),
});
const effects = createEffectsEditor({
  store, viewport, scheduleRebuild, goToProp, goToRail,
  loadPropLevel: propOps.ensurePropLevel,
});
effectsEditor = effects;
// ================= Reference world + lighting study + authored sun =================
// The reference-world subsystem (load an extracted level to study, its recovered lighting, and the authored
// SSX sun that lights the mountain) lives in reference/reference.ts. It fills the scene panel's Sun / Reference
// / lighting-study folders, owns the layer toggles that touch the reference (Props / Tricks / Light-rig /
// Local lights), and is read back through its accessor getters. viewLighting (the top-bar presentation pills it
// repaints) is built later, so it rides a closure.
// ================= Skybox: the backdrop, on both scene tabs =================
// The sky subsystem (docs/025) fills the Skybox category's authored-mountain folder (which sky your map ships with,
// and the fill over the ring's open top) and its Reference folder (the loaded level's own sky, previewed as its
// horizon panorama, with the ⟶ button that adopts it). Built BEFORE the reference so its per-level panel can
// be rebuilt from the reference's load / clear.
const skybox = createSkybox({
  store, viewport, previewFolder: skyPreviewFolder, skyFolder, refSkyFolder, persistDoc, persistUi, log,
  isPreviewSelected: () => getSceneSel() === 'skybox' || getSceneSel() === 'godrays',
  onVisibleWorldChange: () => syncGodRayPreview(),
  refreshView: () => viewLighting.refresh(),
});
const { initSky, syncSkyFromDoc, setupRefSkyUi, syncSkyVisibility, toggleSkybox } = skybox;
syncSceneSkyPreview = syncSkyVisibility;
viewport.onNearestMountainWorldChange(() => syncSkyVisibility());

// The reference-world + lighting + authored-sun subsystem (reference/session.ts). The persistence / dialog /
// scene-panel getters wired above it read the loaded reference through closures that fire at runtime, after
// this assignment.
const reference = createReference({
  store, viewport, sunFolder, godRayFolder, refGodRayFolder, refFolder, refCourseFolder, lightFolder, refSoundFolder,
  rebuildOutliner, applySceneSelection, selectScene,
  scheduleRebuild, persistDoc, persistDocumentEdit, persistRef, persistUi, log, loadStatus, focusActive,
  refreshLighting: () => viewLighting.refresh(),
  ensurePropLevel: propOps.ensurePropLevel, buildFromReferenceCourseDialog,
  setupRefSky: setupRefSkyUi,
  getActiveGodRayWorld: skybox.getActiveGodRayWorld,
  onReferenceEffects: state => { effects.setReferenceState(state); flushPendingRefEffectSelect(); },
  onReferenceChanged: level => session.reference(level),
});
const { initReference, initSunLight, syncSunFromDoc, applySunLight, applyReferenceLighting,
  applyPropsVisible, applyLightsVisible, toggleProps, toggleTricks, toggleLights,
  togglePropLights, toggleSunLight, ensureReferenceEffects, syncGodRays } = reference;
syncGodRayPreview = syncGodRays;

/** Preview always-on graph-driven material/model motion and persistent emitters on both mountains. */
function toggleWorldEffects() {
  store.worldEffectsVisible = !store.worldEffectsVisible;
  if (store.worldEffectsVisible) void ensureReferenceEffects();
  viewport.showWorldEffects(store.worldEffectsVisible);
  persistUi();
}

/** Arm a new free light for placement (the Prop Tools' Add light button). Turns Sources on (the bulb
 *  you'll see + pick) and the Lighting/local-lights preview on (the glow it casts), then disarms any held prop — a click on the
 *  mountain then drops the light. */
function armLight() {
  if (!store.propLightsVisible) togglePropLights(); // must be on to see the light the drop casts
  else if (!reference.getSunOn()) toggleSunLight(); // local lights are a subordinate layer of Lighting
  if (!store.lightRigVisible) toggleLights();       // …and the rigging layer holds the gizmo you place + pick
  viewLighting.refresh();                     // programmatic toggles aren't bar clicks — repaint both pills
  store.armedProp = null;
  viewport.setPropArmed(null);
  trickTools.discardUnfinishedRail(); // arming a light cancels rail drawing — and drops a rail with no points
  store.railDrawing = false; viewport.setRailArmed(false);
  store.gemArmed = false; viewport.setGemArmed(false); store.trickTool = null; // …and leaves the trick tools
  viewport.setLightArmed(true);
  store.selectedLight = null;
  store.selectedRefLight = null;
  store.selectedScreen = null;
  store.selectedRefScreen = null;
  viewport.clearScreenSelection();
  store.multiSel = [];
  if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); }
  toast('click the mountain to place the light', 'info');
}

/** Turn the Sources view on before a video screen is added. Screens ride that view with the bulbs and the
 *  speakers (docs/051), so dropping one while it is off looks like nothing happened. Mirrors armLight. */
function revealScreens() {
  if (store.lightRigVisible) return;
  toggleLights();
  viewLighting.refresh();   // a programmatic toggle isn't a bar click — repaint the pill
}

/** Remove the selected video screen (Delete key or its inspector's button; docs/051). */
function deleteSelectedScreen() {
  if (store.selectedScreen === null || !store.mdoc.screens) return;
  store.mdoc.screens = store.mdoc.screens.filter(screen => screen.id !== store.selectedScreen);
  store.selectedScreen = null;
  scheduleRebuild();
  rebuildTools();
}

/** Remove the selected free light (Delete key or the Tools button). */
function deleteSelectedLight() {
  if (store.selectedLight === null || !store.mdoc.lights) return;
  store.mdoc.lights = store.mdoc.lights.filter(light => light.id !== store.selectedLight);
  store.selectedLight = null;
  store.selectedRefLight = null;
  scheduleRebuild();
  rebuildTools();
}

// ================= Trick tools: rails + gems (docs/014) =================
// The trick tools live in tricks/operations.ts: arming rails / gems, their deletes, the native trick-art
// resolve, and the Add rail pipe / gem / light row it docks under the Prop Library toggle (the light itself is
// armLight above — lights are rig territory, the row just hosts its button). The tools panel is created
// later, so it's reached through an accessor closure.
const trickTools = createTrickTools({
  store, viewport, gemTool, propLibToggle,
  ensurePropLevel: propOps.ensurePropLevel,
  toggleTricks, armLight, revealScreens, setMode,
  scheduleRebuild,
  rebuildTools: () => rebuildTools(),
  log,
});

// ================= Test mode: test ride (stored as `play`; docs/016) =================
/** Paint select mode: a click landed on quad `q` — select it if it holds a tile (amber outline; the pad's
 *  preview readout shows what it is), else clear the selection (an empty cell / off the terrain). A plain
 *  click also drops any multi-selection and (re)sets the anchor a later shift-click adds from. */
function selectPaintCell(q: number | null) {
  const d = store.mdoc;
  const ref = q !== null ? texOf(d, q) : null;
  const name = q === null ? null : quadName(d, q);
  if (q === null || !ref || name === null) { clearPaintSel(); return; }
  store.selectedPaintCell = name;
  store.selectedRefPatch = null; // an authored cell and a reference patch can't both be selected
  if (store.paintMultiSel.length) { store.paintMultiSel = []; viewport.setSelectedPaintCells([]); } // a single click drops a set
  viewport.setSelectedRefPatch(null);
  viewport.setSelectedPaintCell(q);
  const o = orientOf(d, q) ?? { rot: 0, mirror: false };
  palette.showCell({ ref, surface: surfOf(d, q), rot: o.rot, mirror: o.mirror, context: 'terrain',
    source: 'surface', sourceName: `${store.mdoc.name || 'Mountain'} · cell ${q}` }); // the sample's origin sits above the art
  library.highlightRef(ref);
  updateCmdSheet();
}

/** Shift-click in paint select mode: add quad `q` to the painted-cell multi-selection (if it holds a tile).
 *  The anchor stays put; Delete clears every tile in the set. (The old rectangular-block range is retired
 *  with the grid; a loop / flood grammar replaces it for the mesh.) */
function rangeSelectPaintCells(q: number) {
  if (store.selectedPaintCell === null) return; // no anchor to add to (the viewport only routes here when one exists)
  const d = store.mdoc;
  const name = quadName(d, q);
  if (name === null || !texOf(d, q)) return; // only painted cells join the set
  const set = new Set(store.paintMultiSel.length ? store.paintMultiSel : [store.selectedPaintCell]);
  set.add(name);
  store.paintMultiSel = [...set];
  viewport.setSelectedPaintCells(quadIndices(d, store.paintMultiSel));
  // the pad readout keeps describing the anchor tile, with the set's size alongside
  const a = quadIndex(d, store.selectedPaintCell);
  const ref = a === null ? null : texOf(d, a);
  const o = (a === null ? null : orientOf(d, a)) ?? { rot: 0, mirror: false };
  if (ref) palette.showCell({ ref, surface: surfOf(d, a!), rot: o.rot, mirror: o.mirror, context: 'terrain',
    count: store.paintMultiSel.length, source: 'surface', sourceName: `${store.mdoc.name || 'Mountain'} · cell ${a}` });
  updateCmdSheet();
}

/** Drop any paint selection — authored cell / multi-selection, reference patch, or inspected prop surface
 *  (outlines + the pad's inspection readout). */
function clearPaintSel() {
  viewport.clearInspectedPropSurface(); // a prop-texture inspect sets no selection state, so clear it first
  if (store.selectedPaintCell === null && store.selectedRefPatch === null && !store.paintMultiSel.length) {
    palette.showCell(null); // the pad may still be showing that prop inspect's readout
    return;
  }
  store.selectedPaintCell = null;
  store.selectedRefPatch = null;
  store.paintMultiSel = [];
  viewport.setSelectedPaintCell(null);
  viewport.setSelectedPaintCells([]);
  viewport.setSelectedRefPatch(null);
  palette.showCell(null);
  updateCmdSheet();
}

/** Clear the selected cells' painted tiles (Delete in paint select mode) — each falls back to its
 *  ride-feel tint; the SurfaceType (physics) stays painted. A multi-selection clears the whole set. */
function deleteSelectedPaintTile() {
  if (store.selectedPaintCell === null) return;
  const d = store.mdoc;
  for (const q of quadIndices(d, store.paintMultiSel.length ? store.paintMultiSel : [store.selectedPaintCell])) {
    clearTex(d, q);
    setOrient(d, q, null);
  }
  clearPaintSel();
  scheduleRebuild();
}

/** Paint mode's ← / → (⇧ mirrors): turn a texture a quarter. One key pair, one target, resolved by which
 *  paint state is live — a held brush turns while placing, the selected cell(s) turn while selecting.
 *
 *  `dir` −1 (→) steps rot DOWN, which reads as a quarter CW on screen: the terrain draws through the UV
 *  lookup, whose rising rot reads CCW on-surface. The Palette turns the same way, and the pad renders a tile
 *  exactly as the terrain does, so a tile turns one direction everywhere. ⇧ toggles mirror instead —
 *  mirrored tiles are essentially unused in original SSX (a rare few patches), so flipping is deliberate,
 *  never cycled into. Returns true when there was something to turn (so the key is only swallowed then). */
function turnPaintTexture(dir: 1 | -1, flip: boolean): boolean {
  if (store.paintBrush) return palette.turnActive(dir, flip); // placing: the held brush (or its pad cell)
  if (store.selectedPaintCell === null) return palette.turnActive(dir, flip); // else a focused pad cell, if any
  // select mode: turn every selected placed tile, as Delete clears every selected tile
  const d = store.mdoc;
  const quads = quadIndices(d, store.paintMultiSel.length ? store.paintMultiSel : [store.selectedPaintCell]);
  if (!turnOrient(d, quads, dir, flip)) return false; // an unpainted selection has no orientation to turn
  scheduleRebuild();
  // re-show the anchor so the pad's preview + rotation readout track the turn (a set keeps its count line)
  const a = quadIndex(d, store.selectedPaintCell);
  const ref = a === null ? null : texOf(d, a);
  if (a !== null && ref) {
    const o = orientOf(d, a) ?? { rot: 0, mirror: false };
    palette.showCell({ ref, surface: surfOf(d, a), rot: o.rot, mirror: o.mirror, context: 'terrain',
      count: store.paintMultiSel.length, source: 'surface', sourceName: `${store.mdoc.name || 'Mountain'} · cell ${a}` });
  }
  return true;
}

/** Put the paint brush down (Esc in placement mode): LMB returns to selection/inspection. */
function disarmBrush() {
  if (!store.paintBrush) return;
  store.paintBrush = null;
  viewport.setPaintBrush(null);
  palette.clearCurrent();
  library.highlightRef(null);
  updateCmdSheet();
}

// ================= right dock: Tools (options for the active mode) =================
// The per-mode Tools panel + the mode UI it drives (prop preview, bottom-dock library visibility + arming,
// the command-sheet help overlays) live in ui/chrome/tools-panel.ts. It reads editor state from the store and calls
// back into the host for the edit / play / delete ops + shared widgets. Info mode shows the Scene block in
// place of the Tools gui (showScene toggles the scene panel's host).

// Users mode (docs/038): the server's roster in the right dock, reached from beside the numbered mode row.
// Built before the tools panel because that panel asks whether Users holds the dock on every rebuild.
const voice = createVoiceChat({
  audioHost: document.getElementById('voice-audio')!,
  notify: (message, kind = 'info') => toast(message, kind),
});

interface ScreenObservation { sessionId: string; username: string; paused: boolean }
let screenObservation: ScreenObservation | null = null;
let pendingScreenFrame: SharedScreenFrame | null = null;
let applyingScreenFrame = false;
let appliedScreenOptions = '';
let observedScreenCursor: [number, number, number] | null = null;
let screenWatcherCount = 0;
let refreshObserverControls = (): void => { /* top bar is installed just below */ };

async function openProjectFromUsers(id: string, announce = true): Promise<boolean> {
  if (projectSync.current()?.id === id) return true;
  try {
    const document = await projectSync.open(id);
    joinMap(document); // presence and the register room follow the document that is about to be rendered
    history.reset();
    store.mdoc = document;
    await loadMountain();
    if (announce) toast(`Opened ${document.name}.`, 'ok');
    return true;
  } catch (error) {
    toast(`Could not open that map: ${error instanceof Error ? error.message : error}`, 'err');
    return false;
  }
}

function startObservingScreen(sessionId: string, username: string): void {
  screenObservation = { sessionId, username, paused: false };
  pendingScreenFrame = null;
  appliedScreenOptions = '';
  observedScreenCursor = null;
  session.observeScreen(sessionId);
  refreshObserverControls();
  refreshPeers();
}

function pauseObservingScreen(): void {
  if (!screenObservation) return;
  screenObservation.paused = true;
  pendingScreenFrame = null;
  observedScreenCursor = null;
  session.observeScreen(screenObservation.sessionId, false);
  refreshObserverControls();
  refreshPeers();
}

function continueObservingScreen(): void {
  if (!screenObservation) return;
  screenObservation.paused = false;
  session.observeScreen(screenObservation.sessionId); // repeating the subscription replays the latest frame
  refreshObserverControls();
  refreshPeers();
}

function stopObservingScreen(tellServer = true): void {
  if (!screenObservation) return;
  screenObservation = null;
  pendingScreenFrame = null;
  appliedScreenOptions = '';
  observedScreenCursor = null;
  if (tellServer) session.observeScreen(null);
  refreshObserverControls();
  refreshPeers();
}

function currentSharedViewOptions(): SharedViewOptions {
  return {
    shadeMode: viewport.shadeMode,
    cage: cageActive(),
    viewGrid: store.viewGridOn,
    orientation: store.fOverlayOn,
    courseGuide: store.courseGuideOn,
    normals: store.normalsOn,
    aiPaths: store.aiPathsOn,
    props: store.propsVisible,
    tricks: store.tricksVisible,
    effects: store.worldEffectsVisible,
    sources: store.lightRigVisible,
    propLights: store.propLightsVisible,
    sun: reference.getSunOn(),
    skybox: store.skyboxVisible,
  };
}

function applyScreenOptions(state: SharedScreenState): void {
  const options = state.options;
  const encoded = JSON.stringify(options);
  // A local click is allowed while observing. Leave it in place until a new target frame arrives, then let
  // that absolute frame win even when the target's own option payload did not change since its last frame.
  if (encoded === appliedScreenOptions && JSON.stringify(currentSharedViewOptions()) === encoded) return;
  appliedScreenOptions = encoded;
  viewport.shadeMode = options.shadeMode;
  store.cageOn = options.cage;
  store.viewGridOn = options.viewGrid;
  viewport.viewGrid = options.viewGrid;
  store.fOverlayOn = options.orientation;
  applyFOverlay();
  store.courseGuideOn = options.courseGuide;
  viewport.courseGuide = options.courseGuide;
  store.normalsOn = options.normals;
  viewport.normalsGuide = options.normals;
  store.aiPathsOn = options.aiPaths;
  viewport.aiPathsGuide = options.aiPaths;
  store.worldEffectsVisible = options.effects;
  if (options.effects) void ensureReferenceEffects();
  viewport.showWorldEffects(options.effects);
  reference.applySharedViewOptions(options);
  skybox.setSkyboxVisible(options.skybox, false);
  applyCage();
  viewShade.refresh();
  viewOverlays.refresh();
  viewShow.refresh();
  viewLighting.refresh();
}

async function drainScreenFrames(): Promise<void> {
  if (applyingScreenFrame) return;
  applyingScreenFrame = true;
  try {
    while (pendingScreenFrame) {
      const frame = pendingScreenFrame;
      pendingScreenFrame = null;
      if (!screenObservation || screenObservation.paused
        || screenObservation.sessionId !== frame.sessionId) continue;
      if (projectSync.current()?.id !== frame.projectId) {
        if (!await openProjectFromUsers(frame.projectId, false)) {
          stopObservingScreen();
          return;
        }
        appliedScreenOptions = '';
      }
      if (!screenObservation || screenObservation.paused
        || screenObservation.sessionId !== frame.sessionId) continue;
      if (pendingScreenFrame) continue;
      const currentReference = reference.getRefLevel().trim();
      if (frame.referenceLevel) {
        if (currentReference !== frame.referenceLevel) {
          await reference.openReference(frame.referenceLevel);
          appliedScreenOptions = '';
        }
      } else if (currentReference && !currentReference.startsWith('(')) {
        reference.clearReference();
        appliedScreenOptions = '';
      }
      if (!screenObservation || screenObservation.paused
        || screenObservation.sessionId !== frame.sessionId) continue;
      if (pendingScreenFrame) continue;
      applyScreenOptions(frame);
      viewport.followView(frame.view);
    }
  } finally {
    applyingScreenFrame = false;
    if (pendingScreenFrame) void drainScreenFrames();
  }
}

function receiveScreenFrame(frame: SharedScreenFrame): void {
  if (!screenObservation || screenObservation.paused
    || screenObservation.sessionId !== frame.sessionId) return;
  observedScreenCursor = frame.cursor;
  refreshPeers();
  pendingScreenFrame = frame; // loading may be in flight; only the newest absolute frame matters
  void drainScreenFrames();
}

const usersMode = createUsersMode({
  openProject: id => openProjectFromUsers(id),
  openReference: level => void reference.openReference(level),
  openChat: prefill => chat.open(prefill),
  goToPlayer: userId => viewport.goToPlayer(userId),
  screenSharing: () => session.screenSharing(),
  setScreenSharing: enabled => {
    if (!enabled) screenWatcherCount = 0;
    session.setScreenSharing(enabled);
    refreshObserverControls();
    refreshPeers();
  },
  observeScreen: startObservingScreen,
  currentProject: () => projectSync.current(),
  setProjectEditors: editorIds => projectSync.setProjectEditors(editorIds),
  voice,
  addVideo: sourceUrl => session.addJukeboxVideo(sourceUrl),
  removeVideo: id => session.removeJukeboxVideo(id),
  skipVideo: id => session.skipJukeboxVideo(id),
  seekVideo: (id, position) => session.seekJukeboxVideo(id, position),
  setVideoPlaying: (id, playing) => session.setJukeboxVideoPlaying(id, playing),
  videoEnabled: () => loadSettings().videoBridge.enabled,
  setVideoEnabled: enabled => setJukeboxVideoEnabled(enabled),
  mountVideo: host => viewport.mountJukeboxPreview(host),
  videoTime: () => viewport.jukeboxVideoTime(),
  videoMuted: () => viewport.jukeboxVideoMuted(),
  setVideoMuted: muted => viewport.setJukeboxVideoMuted(muted),
  videoVolume: () => viewport.jukeboxVideoVolume(),
  setVideoVolume: volume => viewport.setJukeboxVideoVolume(volume),
  serverNow: () => session.serverNow(),
  rebuildTools: () => rebuildTools(),
});
void voice.probe();
const { rebuildTools, updatePaintUi, updateCmdSheet } = createToolsPanel({
  store, viewport, edit, palette, propPreview, propLib, library, propLibToggle, brush, gemTool,
  showScene: setSceneVisible,
  usersActive: () => usersMode.active(),
  refreshShowFilters: () => viewShow.refresh(),
  syncAddTrickBtns: trickTools.syncAddTrickBtns,
  persistUi, cageActive, scheduleRebuild, clearPaintSel, syncPropLibBtn, syncDockTabs,
  getRefLevel: () => reference.getRefLevel(),
  propLevels, groupDefIdx,
  reloadImportedProps: () => propOps.reloadImportedProps(),
  setAuthoredModelTexture: (model, ref) => setAuthoredModelTextureByNumber(model, ref),
  setAuthoredModelFrames: (model, frames) => setAuthoredModelFramesByNumber(model, frames),
  identifyMultiProp: propOps.identifyMultiProp, removeFromMultiSel: propOps.removeFromMultiSel,
  defOfPlaced: propOps.defOfPlaced, placedBaseOffset: propOps.placedBaseOffset,
  shortPropName: propOps.shortPropName, propBaseOffset: propOps.propBaseOffset,
  armProp: propOps.armProp, armGroupById: propOps.armGroupById,
  deselectPropOrLight: propOps.deselectPropOrLight,
  cancelPlacement: () => { viewport.setLightArmed(false); trickTools.cancelTrickTools(); },
  lightTool,
  getPlay: () => play,
  deleteSelectedProp: propOps.deleteSelectedProp, deleteMultiSelProps: propOps.deleteMultiSelProps,
  deleteSelectedLight, deleteSelectedScreen, revealScreens,
  deleteSelectedGem: trickTools.deleteSelectedGem, deleteSelectedRail: trickTools.deleteSelectedRail,
  deleteSelectedRailNode: trickTools.deleteSelectedRailNode, finishRail: trickTools.finishRail,
  modelEdit: {
    create: () => createModelFlow(),
    enter: (id, atIndex) => enterModelEdit(id, atIndex),
    exit: () => exitModelEdit(),
    rename: name => renameEditedModel(name),
    setTexture: ref => setEditedModelTexture(ref),
    pickTexture: () => pickEditedModelTexture(),
    activeName: () => findModel(store.mdoc, store.modelEditId)?.name ?? null,
    activeTexture: () => findModel(store.mdoc, store.modelEditId)?.texture ?? null,
    activeOrient: () => findModel(store.mdoc, store.modelEditId)?.orient ?? { rot: 0, mirror: false },
    activeQuads: () => findModel(store.mdoc, store.modelEditId)?.quads.length ?? 0,
    turnTexture: (dir, flip) => turnEditedModelTexture(dir, flip),
    createRevision: index => createPlacementRevision(index),
    // The same action from the other side: a picked reference instance that is not placed here at all.
    reviseReference: (level, model, name) => void reviseReferenceProp(level, model, name),
    // Offered from INSIDE the session, because "this bit is hard to do with the mesh tools" is discovered
    // mid-edit, not from the library. Withheld while the model is still empty: an escape hatch out of nothing
    // hands Blender a mesh with no faces and gets a refusal back for it (docs/046).
    canSendToBlender: () => !!findModel(store.mdoc, store.modelEditId)?.quads.length,
    sendToBlender: () => sendEditedModelToBlender(),
  },
  retopology: {
    isWritable: () => projectSync.isWritable(),
    apply: async document => {
      // A topology replacement is one deliberate bulk edit: seal anything preceding it, set the durable
      // project aside when possible, then let the ordinary topology/history funnel publish one atomic doc.
      commit();
      try { await projectSync.checkpointNow('before retopology', 'bulk'); }
      catch (error) { log(`checkpoint before retopology failed: ${error instanceof Error ? error.message : error}`); }
      restoreDoc(JSON.stringify(document));
      commit();
    },
  },
  effects,
  goToEffects,
});
// The test-ride setup + launch glue lives in play/play.ts. Play calls the tools panel's rebuildTools /
// updateCmdSheet, and the tools panel wires its Play buttons to play's actions — a mutual dependency, so play
// is built just AFTER the tools panel and takes those two directly; the tools panel reaches back through a
// single getPlay accessor, and the earlier viewport callbacks reach it through closures that fire at runtime.
const play = createPlay({
  store, viewport, persistUi, rebuildTools, updateCmdSheet, syncSkyVisibility, ensureReferenceEffects,
  onPlayingChanged: target => {
    session.setPlaying(target);
    if (target) chat.close(); // the ride gets input; recent lines and active speakers remain as passive HUD
  },
});

// ================= top dock: context + view + file =================
// The top dock's buttons + layout live in ui/top-bar.ts; the toggle behaviour they invoke stays here (below,
// and across the edit / lighting subsystems). We hand it the actions + active/enabled reads and keep back the
// bar objects the host repaints programmatically (mode segment, history bar, show + lighting pills, and view pills).
const {
  modeSeg, usersBar, histBar, viewShow, viewLighting, viewOverlays, viewShade,
  refreshMountainTitle,
} = createTopBar({
  viewport, applyCage, cageActive, persistUi,
  getMode: () => store.currentMode, setMode,
  getMountainName: () => projectSync.current() ? store.mdoc.name : '',
  getReferenceName: () => reference.getRefLevel(),
  usersActive: () => usersMode.active(),
  toggleUsers: () => { usersMode.setActive(!usersMode.active()); modeSeg.refresh(); },
  undo, redo, saveStatus: syncChip.indicator,
  canUndo: () => history.canUndo(), canRedo: () => history.canRedo(),
  undoSummary: () => history.undoSummary(), redoSummary: () => history.redoSummary(),
  recentUndo: () => history.recentUndo(), recentRedo: () => history.recentRedo(),
  historyEntries: () => history.entries(), jumpHistory: index => history.jumpTo(index),
  toggleProps, getPropsVisible: () => store.propsVisible,
  toggleTricks, getTricksVisible: () => store.tricksVisible,
  toggleWorldEffects, getWorldEffectsVisible: () => store.worldEffectsVisible,
  toggleLights, getLightRigVisible: () => store.lightRigVisible,
  toggleSunLight, getSunOn: () => reference.getSunOn(),
  toggleSkybox, getSkyboxVisible: () => store.skyboxVisible,
  toggleCage,
  toggleFOverlay, getFOverlayOn: () => store.fOverlayOn,
  focusActive, newMountainDialog, canCreateMountains: () => session.mayCreateMountains(),
  canManageMountain: () => session.mayManageMountain(projectSync.current()),
  openProjectDialog, historyDialog, renameMountain,
  closePreview, isPreviewing: () => projectSync.isPreviewing(),
  conflictDialog, hasConflict: () => !!projectSync.conflict(),
  duplicateMountain, deleteMountain, exportMountain, importMountain, exportDialog,
  settingsDialog: openSettingsDialog,
});
// (Test ride lives in Test mode — see the mode segment + buildPlayTools, docs/016.)

/** Whether the control cage is effectively shown: the user's toggle, OR forced on while editing or in the
 *  no-solid state. The saved toggle remains untouched so leaving Edit restores the user's view preference. */
function cageActive() { return store.cageOn || store.currentMode === 'edit' || viewport.shadeMode === 'none'; }

/** Push the effective cage state onto the viewport + edit tools. Call after cageOn, the mode, or the shade mode
 *  changes; it repaints both view pills. */
function applyCage() {
  const active = cageActive();
  viewport.cage = active;
  if (!active) { cancelPastePlacement(false); cancelBridge(false, false); viewport.clearCornerSelection(); store.selectedCorner = null; exitRegion(); if (store.surgeryTool) { store.surgeryTool = null; viewport.setSurgeryTool(null); } if (store.weldTool) { store.weldTool = null; store.weldSource = []; store.weldEdgeSource = []; viewport.setWeldTool(false); } }
  viewShade.refresh();
  viewOverlays.refresh();
  refreshHandles();
  if (store.currentMode === 'edit') rebuildTools(); // cage on/off changes whether corners are grabbable
}

/** Toggle the three-plane XYZ world grid. The viewport shows it only while the camera is orthographic. */
function toggleViewGrid() {
  store.viewGridOn = !store.viewGridOn;
  viewport.viewGrid = store.viewGridOn;
  persistUi();
}

function setViewGridStep(step: 1 | 5 | 10) {
  store.viewGridStep = step;
  viewport.viewGridStep = step;
  persistUi();
}

function toggleSnap() {
  store.snapOn = !store.snapOn;
  viewport.snapEnabled = store.snapOn;
  persistUi();
}

function setSnapStep(step: 1 | 5 | 10) {
  store.snapStep = step;
  viewport.snapStep = step;
  persistUi();
}

function setRotationSnapStep(step: 5 | 15 | 45) {
  store.rotationSnapStep = step;
  viewport.rotationSnapStep = step;
  persistUi();
}

function toggleCage() {
  store.cageOn = !store.cageOn;
  applyCage();
  persistUi();
}

/** Push the F-overlay state onto every tile display: the 3D terrain (viewport), the Texture Library
 *  swatches, and the Palette's cells + preview. */
function applyFOverlay() {
  viewport.tileF = store.fOverlayOn;
  viewport.propFacingArrows = store.fOverlayOn; // green facing arrows on the selected prop ride the same F
  library.setShowF(store.fOverlayOn);
  palette.setShowF(store.fOverlayOn);
}

function toggleFOverlay() {
  store.fOverlayOn = !store.fOverlayOn;
  applyFOverlay();
  persistUi();
}

// ================= mode switching =================

/** Effects mode's "Go to prop": jump to Props mode with the effect's host selected — an authored placement
 *  (by doc index) seats its normal amber selection + gizmo; a native instance becomes the read-only
 *  reference pick. The camera stays where it is — jumping modes is not a reframe. */
function goToProp(target: { propIndex: number } | { sourceIndex: number }) {
  if ('propIndex' in target) {
    store.selectedRefProp = null;
    store.selectedProp = target.propIndex;
    store.multiSel = [];
    setMode('props');
    scheduleRebuild(); // the re-render seats the amber outline + gizmo on the placement
  } else {
    store.selectedProp = null;
    store.multiSel = [];
    setMode('props');
    if (!viewport.selectReferencePropBySource(target.sourceIndex))
      toast('This native prop is not built yet — turn the Props filter on to load the reference props.', 'err');
  }
}

/**
 * Hand a grind rail to the Tricks tools in Props view, still selected.
 *
 * A rail IS its own prop — the tube it bakes is the thing you see — so Effects mode's rail panel, which owns
 * only the switching side, needs somewhere to send an author who wants the geometry. Selecting it here rather
 * than just changing mode is the whole point: arriving in Props view with nothing picked would make the
 * author hunt for the rail they were already looking at.
 */
function goToRail(index: number) {
  if (!store.mdoc.rails?.[index]) return;
  if (!store.tricksVisible) toggleTricks(); // a hidden rail cannot be the thing you just jumped to
  store.selectedProp = null; store.selectedRefProp = null; store.multiSel = [];
  store.selectedLight = null; store.selectedGem = null;
  store.selectedRail = index; store.selectedNode = null; store.railDrawing = false;
  setMode('props');
  scheduleRebuild();
  rebuildTools(); // the Tricks rail panel is what the author came for
}

/** Select a native instance's effect host, waiting out the effects-graph fetch on the first Effects entry.
 *  The fetch resolving and the editor receiving the ready state are separate moments, so the pending pick
 *  is flushed from BOTH — whichever lands last completes the selection. */
let pendingRefEffectSelect: { sourceIndex: number; called: boolean } | null = null;
function selectRefEffectWhenReady(sourceIndex: number, called = false) {
  const selected = called
    ? effects.selectReferenceCalledEffect(sourceIndex)
    : effects.selectReferencePropEffect(sourceIndex);
  if (selected) return;
  pendingRefEffectSelect = { sourceIndex, called };
  void ensureReferenceEffects().then(() => flushPendingRefEffectSelect());
}
function flushPendingRefEffectSelect() {
  if (pendingRefEffectSelect === null || store.currentMode !== 'effects') return;
  const request = pendingRefEffectSelect;
  const selected = request.called
    ? effects.selectReferenceCalledEffect(request.sourceIndex)
    : effects.selectReferencePropEffect(request.sourceIndex);
  if (selected) { pendingRefEffectSelect = null; return; }
  if (request.called && effects.referenceReady) {
    pendingRefEffectSelect = null;
    effects.selectReferencePropEffect(request.sourceIndex);
    toast('This prop has no resolved called effect; opened its own Effects entry instead.', 'info');
  }
}

/** Props-mode navigation into Effects. The ordinary path carries the current selection; the explicit native
 * call path follows the Run edge after the reference Effects document has loaded. */
function goToEffects(target?: { sourceIndex: number; called: true }): void {
  setMode('effects');
  if (target) selectRefEffectWhenReady(target.sourceIndex, true);
}

function setMode(m: Mode) {
  usersMode.setActive(false); // Users is its own mode: picking a numbered one leaves it (docs/038)
  usersBar.refresh();
  library.cancelPick(); // a texture pick belongs to the session that raised it, not to the next mode
  // Captured before the switch-over: entering Effects re-renders the editor, which drops the Props-mode
  // reference pick as part of its mutual exclusion — the carry below re-selects from this snapshot.
  const carriedProp = store.selectedProp;
  const carriedRefSource = store.selectedRefProp?.sourceIndex;
  if (m !== 'info') store.selectedKnots = []; // course marquee selection exists only in Info
  if (m !== 'edit') cancelPastePlacement(false);
  if (m !== 'edit') cancelBridge(false, false);
  if (m !== 'edit') exitRegion(); // box-select is an Edit-only tool
  if (m !== 'edit' && store.surgeryTool) { store.surgeryTool = null; viewport.setSurgeryTool(null); } // surgery is Edit-only
  if (m !== 'edit' && store.weldTool) { store.weldTool = null; store.weldSource = []; store.weldEdgeSource = []; viewport.setWeldTool(false); } // the weld gesture is Edit-only too
  if (m !== 'edit') clearCreateEdge();
  if (m !== 'edit' && store.modelEditId) exitModelEdit(false); // model editing is an Edit-mode session; other modes see the mountain
  if (m !== 'props') { // the trick tools (rails + gems) and the screens live in Props mode
    store.railDrawing = false; viewport.setRailArmed(false); store.selectedRail = null; store.selectedNode = null;
    store.gemArmed = false; viewport.setGemArmed(false); store.selectedGem = null; store.trickTool = null;
    store.selectedScreen = null;
    store.selectedRefScreen = null;
    viewport.clearScreenSelection();
  }
  if (store.currentMode === 'play' && m !== 'play') { // leaving Play: stop any ride or watched field + hide the setup marker
    play.cancelLaunch(); // a pending effects await must not start a ride after the mode has changed
    if (viewport.riding) { viewport.stopRide(); session.setPlaying(null); }
    if (viewport.watching) viewport.stopWatch();
    play.cancelStartPlacement(false); // an armed one-shot doesn't survive the mode
    viewport.setPlayActive(false, store.playTarget); // ...and neither do the riders dropped by hand
  }
  store.currentMode = m;
  viewport.mode = m;
  if (m === 'effects' || (m === 'play' && store.playTarget === 'reference')) void ensureReferenceEffects();
  effects.setActive(m === 'effects');
  // Prop-first carry: entering Effects keeps the Props selection — the selected placement (or native
  // reference instance) opens as the selected effect host, so both modes stay on the same object.
  if (m === 'effects') {
    if (carriedProp !== null) effects.selectAuthoredPropEffect(carriedProp);
    else if (carriedRefSource !== undefined) selectRefEffectWhenReady(carriedRefSource);
  } else pendingRefEffectSelect = null; // a pick pending on the fetch dies with the mode
  applyCage(); // Edit implicitly shows the cage; leaving it restores the saved cage toggle.
  if (m === 'play') { // entering Play leaves mountain visibility alone and shows the target's editable start marker
    if (store.playTarget === 'reference' && !viewport.canRideReference) store.playTarget = 'authored';
    viewport.setPlayActive(true, store.playTarget);
    play.ensurePlaySpawn();
  }
  // Scene previews the selected Skybox world; only a running ride shows its target. Other states are flat.
  syncSkyVisibility();
  modeSeg.refresh();
  rebuildTools();
  updatePaintUi();
  refreshHandles(); // entering/leaving Edit shows/hides the selected corner's handles
  applySceneSelection(); // keep category folders and the Reference tab's two mountain boxes in sync
  persistUi();
}

function focusActive() {
  viewport.focusMountain(store.mdoc);
}

// ================= model editing (Edit mode: authored polygon models, docs/012 successor) =================

/** Drop every mesh selection + modal tool before the edit SUBSTRATE changes: their ids index the doc being
 *  swapped out — exactly the reason restoreDoc clears them when the document itself is replaced. */
function clearMeshEditState() {
  cancelPastePlacement(false);
  cancelBridge(false, false);
  if (store.surgeryTool) { store.surgeryTool = null; viewport.setSurgeryTool(null); }
  if (store.weldTool) { store.weldTool = null; store.weldSource = []; store.weldEdgeSource = []; viewport.setWeldTool(false); }
  clearCreateEdge();
  store.selectedProp = null; store.multiSel = []; // a placement selection doesn't survive a substrate change
  store.hiddenVertices = []; store.hiddenEdges = []; store.hiddenQuads = [];
  store.controlCageEdges = []; store.controlCageQuads = [];
  store.selectedCorner = null;
  store.selectedEdgeCrossing = null;
  store.selectedCoincidentVertices = null;
  exitRegion();
  viewport.clearCornerSelection();
}

/** Enter the "Editing <model>" session: the edit stack's substrate becomes the model's flat mesh, and the
 *  mountain stays visible, fully rendered, as a read-only context surface that placement clicks (patch
 *  corners) can land on. Entering FROM a placement first REBASES the definition onto that placement —
 *  the session opens at the prop you picked, only that placement hides, and the model's other placements
 *  stay visible, updating live as the shared definition changes. */
function enterModelEdit(id: string, atIndex?: number) {
  const model = findModel(store.mdoc, id);
  if (!model) return;
  const placement = atIndex !== undefined ? store.mdoc.props?.[atIndex] : undefined;
  let placementId: string | null = null;
  if (placement && placement.level === AUTHORED_MODEL_LEVEL && modelIdFromNumber(placement.model) === id) {
    const absorbed = rebaseModelToPlacement(store.mdoc, model, placement);
    if (absorbed && store.mdoc.effects) {
      // attached emitter offsets are model-frame coordinates: re-frame them with the absorbed pose
      transformModelEmitterFrames(store.mdoc.effects, (store.mdoc.props ?? [])
        .filter(pp => pp.level === AUTHORED_MODEL_LEVEL && modelIdFromNumber(pp.model) === id && pp.id)
        .map(pp => pp.id!), absorbed.rotation, absorbed.scale);
    }
    placementId = placement.id ?? null;
  }
  clearMeshEditState();
  store.modelEditId = id;
  store.modelEditDoc = modelEditDocFor(store.mdoc, model);
  store.modelEditLocked = false; // sessions open unlocked: a click off the model returns to the terrain
  store.modelEditPlacementId = placementId;
  if (store.currentMode !== 'edit') setMode('edit');
  viewport.setModelEditContext(true, store.mdoc);
  scheduleRebuild();
  rebuildTools(); updateCmdSheet();
}

function exitModelEdit(refreshUi = true) {
  if (!store.modelEditId) return;
  library.cancelPick(); // nothing left to answer once the session that asked is over
  // a built model leaves its session PLACED: the first Done seats the home placement at the anchor, so the
  // geometry you just authored stays in the world as an ordinary prop (with a stable id effects can target)
  const model = findModel(store.mdoc, store.modelEditId);
  if (model?.vertices.length && !(store.mdoc.props ?? []).some(pp =>
    pp.level === AUTHORED_MODEL_LEVEL && modelIdFromNumber(pp.model) === model.id)) {
    const props = (store.mdoc.props ??= []);
    props.push({ level: AUTHORED_MODEL_LEVEL, model: modelNumber(model.id), name: model.name,
      pos: [model.anchor[0], model.anchor[1], model.anchor[2]], yaw: 0, scale: 1 });
    ensurePlacedPropIds(props);
  }
  // an EMPTY model (no geometry, no placements) evaporates on exit: with the click-off flow a stray click
  // can end a session early, and an empty definition would be unreachable — nothing of it exists to click
  if (model && !model.vertices.length && !(store.mdoc.props ?? []).some(pp =>
    pp.level === AUTHORED_MODEL_LEVEL && modelIdFromNumber(pp.model) === model.id)) {
    store.mdoc.models = (store.mdoc.models ?? []).filter(entry => entry.id !== model.id);
  }
  clearMeshEditState();
  store.modelEditId = null;
  store.modelEditDoc = null;
  store.modelEditLocked = false;
  store.modelEditPlacementId = null;
  viewport.setModelEditContext(false);
  scheduleRebuild();
  if (refreshUi) { rebuildTools(); updateCmdSheet(); }
}

function createModelFlow() {
  const name = window.prompt('Name this tiled prop', 'Prop')?.trim();
  if (!name) return;
  const model = createAuthoredModel(store.mdoc, name);
  enterModelEdit(model.id);
  toast(`Editing ${model.name} — create patches to build it; a click off it returns to the mountain.`, 'ok');
}

/** REVISE a reference prop placement: bake its posed triangle mesh into a new authored model (v2 name),
 *  point this placement at it, and leave it looking exactly as it did.
 *
 * The copy lands in the TEXTURED lane, which is the whole change: a reference prop and a stored record are
 * the same shape of thing (docs/032), so this is a re-pack that keeps the UV layout, the material table, the
 * flipbook frames and the alpha flag. The old behaviour baked it into a tiled cage instead, which cannot
 * express a shipped prop's mapping — measured on GARI's river, a segment spans its tile once across two
 * quads, where the tiled rule would show it twice — so the copy arrived as grey clay and the author had to
 * re-texture something that was already textured.
 *
 * Nothing about the placement moves. The record stores model-local raw cm exactly as the reference model
 * does, so the existing pose still applies and the prop does not so much as twitch; and the placement is
 * MUTATED rather than replaced, so it keeps its `id` and every effect attached to it stays attached.
 */
async function revisePlacedProp(index: number) {
  const pp = store.mdoc.props?.[index];
  if (!pp || pp.level === AUTHORED_MODEL_LEVEL) return;
  if (pp.group) { toast('Group props can’t be revised yet — revise a single prop.', 'err'); return; }
  const copy = await adoptPropIntoLibrary(pp.level, pp.model, pp.name);
  if (!copy) return;
  // The placement is MUTATED rather than replaced, so it keeps its `id` and every effect attached to it stays
  // attached. Its pose is untouched too: a record stores the same model-local raw cm the reference model
  // does, so the prop does not move.
  pp.level = IMPORTED_PROP_LEVEL;
  pp.model = copy.id;
  pp.name = copy.name;
  commit();
  scheduleRebuild();
  rebuildTools();
  toast(`${copy.name} is yours now — ${copy.detail}. This placement uses it; edit it in Blender, or `
    + 'right-click it in the library.', 'ok', 6000);
}

/**
 * Revise a picked REFERENCE instance — the read-only extracted level's own prop, which is not placed in this
 * mountain at all.
 *
 * The other way in starts from a placement, which meant taking a copy of a shipped prop required placing one
 * first: a strange prerequisite for "I want this in my library", and backwards now that revising IS the copy.
 * There is no placement to repoint here, so the copy is armed instead — the button sits directly under
 * ＋ place prop, and this is that button's own outcome with your own editable prop on the cursor.
 */
async function reviseReferenceProp(level: string, model: number, name: string) {
  const copy = await adoptPropIntoLibrary(level, model, name);
  if (!copy) return;
  rebuildTools();
  void propOps.armProp(IMPORTED_PROP_LEVEL, copy.id, copy.name);
  toast(`${copy.name} is yours now — ${copy.detail}. It is on the cursor; click to place it.`, 'ok', 6000);
}

/**
 * Copy one model out of a level you do not own into this mountain's own library, keeping how it looks.
 *
 * The shared half of both revise paths. It lands in the TEXTURED lane, where a shipped prop's UV layout,
 * material table, flipbook frames and alpha flag all have somewhere to go — `recordFromReferenceProp` is a
 * re-pack rather than a conversion, so not a coordinate moves (docs/028). Returns null having already said
 * why, so callers only handle the success.
 */
async function adoptPropIntoLibrary(level: string, model: number, name: string):
Promise<{ id: number; name: string; detail: string } | null> {
  let props;
  let source;
  try {
    props = await propOps.ensurePropLevel(level);
    source = props.models.find(entry => entry.id === model);
  } catch (e) { toast(`props load failed: ${e}`, 'err'); return null; }
  if (!source?.subs.length) { toast('This prop has no mesh to revise.', 'err'); return null; }

  const copyName = revisedPropName(name || source.name);
  const adopted = recordFromReferenceProp(props, source, copyName);
  if (!adopted.record.subs.length) { toast('This prop has no mesh to revise.', 'err'); return null; }
  let saved;
  try {
    // `adopt=1` brings the ART across too, not just a ref to it. Without it the mesh would be the author's
    // while its paint stayed a pointer into a read-only bank — a copy they could reshape but never
    // retexture, replace art on, or generate over (docs/032).
    saved = await fetchJson<{ id: number; name: string; staged?: number; missing?: number; error?: string }>(
      `/api/custom-prop-import?adopt=1&name=${encodeURIComponent(copyName)}`,
      { method: 'POST', body: JSON.stringify(adopted.record) });
    if (saved.error) throw new Error(saved.error);
  } catch (e) { toast(`Revise failed — ${e instanceof Error ? e.message : e}`, 'err', 6000); return null; }

  // The catalogue has to hold the new record before anything points at it, or the rebuild in between draws
  // a placement whose model number names nothing.
  try { await propOps.reloadImportedProps(); }
  catch { /* a refetch races a reconnect at worst; the record is stored either way */ }
  const carried = adopted.materials === 1 ? 'its tile' : `${adopted.materials} materials`;
  // Said explicitly, because it is the difference between a copy you can reshape and one you can repaint:
  // those tiles are now in the Texture Library under your own bank.
  const art = saved.staged
    ? `, ${saved.staged} tile${saved.staged === 1 ? '' : 's'} copied into Custom`
    : '';
  const lost = saved.missing
    ? ` (${saved.missing} tile${saved.missing === 1 ? '' : 's'} could not be read and still point at the level)`
    : '';
  return {
    id: saved.id, name: saved.name,
    detail: `${adopted.tris.toLocaleString()} tris, ${carried} and its UVs came with it${art}${lost}`,
  };
}

/**
 * The escape hatch, taken from inside a model's edit session (docs/046).
 *
 * The session already owns the answer to "which model?", so this asks nothing: it downloads the cage as a GLB
 * and says where the live route is. The download is the fallback path — with the add-on installed the author
 * never needs it, because Blender's own Slopesmith panel lists this model and pulls it as editable quads —
 * but it is what makes the hatch work before anything is installed, which is the moment it is reached for.
 */
function sendEditedModelToBlender(): void {
  const model = findModel(store.mdoc, store.modelEditId);
  if (!model?.quads.length) { toast('This prop has no geometry to send yet.', 'warn'); return; }
  openBlenderGuide({ kind: 'model', id: modelNumber(model.id), name: model.name });
}

/** CREATE REVISION from a selected placement: fork the source into a new authored model (`<name> v2`),
 *  swap THIS placement to the copy, and open its edit session. A custom model duplicates its definition
 *  (other placements keep the original); a reference prop bakes its posed triangle mesh (revisePlacedProp). */
function createPlacementRevision(index: number) {
  const pp = store.mdoc.props?.[index];
  if (!pp) return;
  if (pp.level !== AUTHORED_MODEL_LEVEL) { void revisePlacedProp(index); return; }
  const model = findModel(store.mdoc, modelIdFromNumber(pp.model));
  if (!model) return;
  const copy = duplicateAuthoredModel(store.mdoc, model);
  pp.model = modelNumber(copy.id);
  pp.name = copy.name;
  enterModelEdit(copy.id, index);
  toast(`Now editing ${copy.name} — this placement uses the revision; other placements keep ${model.name}.`, 'ok');
}

function renameEditedModel(name: string) {
  const model = findModel(store.mdoc, store.modelEditId);
  const next = name.trim();
  if (!model || !next) return;
  model.name = next;
  scheduleRebuild();
}

/** Set (or clear) the edited model's uniform tile and re-materialize so the substrate wears it live. */
function setEditedModelTexture(ref: string) {
  const model = findModel(store.mdoc, store.modelEditId);
  if (!model) return;
  const next = ref.trim();
  if (next === (model.texture ?? '')) return;
  if (next) model.texture = next; else delete model.texture;
  store.modelEditDoc = modelEditDocFor(store.mdoc, model);
  commit(); // a one-click pick has to be one Ctrl+Z away, like every other edit to the document
  scheduleRebuild();
}

/**
 * Turn the edited model's tile a quarter, or mirror it — the prop-side of Paint's ← / → (the panel's ↺ / ↻ /
 * ⇋ buttons drive the same call), so a tile turns by one gesture wherever a tile is worn.
 *
 * The step is the shared `turnD4` a painted terrain quad takes, so → turns a prop's tile the same way on
 * screen as it turns the mountain's. The state is ONE per model rather than one per quad — the mapping is
 * computed, not authored (types.ts `AuthoredModel.orient`) — and the identity state is stored as absence, so
 * turning a tile back to upright leaves a document identical to one that was never turned at all.
 * Re-materializing is what carries it to the substrate; the placements re-bake through
 * `syncAuthoredModelLevel` on the scheduled render. Returns true when there was a tile to turn, so the key is
 * only swallowed then.
 */
function turnEditedModelTexture(dir: 1 | -1, flip: boolean): boolean {
  const model = findModel(store.mdoc, store.modelEditId);
  if (!model?.texture) return false; // untextured clay has no tile to turn
  const next = turnD4(model.orient ?? { rot: 0, mirror: false }, dir, flip);
  if (next.rot === 0 && !next.mirror) delete model.orient; else model.orient = next;
  store.modelEditDoc = modelEditDocFor(store.mdoc, model);
  commit(); // one Ctrl+Z away, like the texture pick it sits beside
  scheduleRebuild();
  rebuildTools(); // the banner states the orientation and draws the swatch at it
  return true;
}

/** The same edit from OUTSIDE an Edit session: the prop inspector's Materials block, where a placement names
 *  its model rather than the editor holding one open. The live edit doc only needs re-deriving when the model
 *  being retextured happens to be the one open. */
function setAuthoredModelTextureByNumber(model: number, ref: string) {
  const target = findModel(store.mdoc, modelIdFromNumber(model));
  if (!target) return;
  const next = ref.trim();
  if (next === (target.texture ?? '')) return;
  if (next) target.texture = next; else delete target.texture;
  // The state list is headed by the resting tile, so re-picking the texture moves frame 0 rather than
  // stranding a flipbook on a tile the surface no longer rests on. Clearing the texture clears the list.
  if (target.frames?.length) {
    if (next) target.frames = [next, ...target.frames.slice(1)]; else delete target.frames;
  }
  if (store.modelEditId === target.id) store.modelEditDoc = modelEditDocFor(store.mdoc, target);
  // The inspector reads a model's tile and state list off the baked '@models' level rather than the
  // document, and rebuilds itself the moment this returns — a frame before the scheduled render would
  // re-bake it. Re-baking here is what makes the panel show the edit that was just made.
  propOps.syncAuthoredModelLevel();
  commit();
  scheduleRebuild();
}

/** Set an authored model's flipbook state list. Under two entries is a still image, so the key is dropped
 *  rather than left holding a one-frame animation. */
function setAuthoredModelFramesByNumber(model: number, frames: readonly string[]) {
  const target = findModel(store.mdoc, modelIdFromNumber(model));
  if (!target?.texture) return;
  const next = [target.texture, ...frames.slice(1).filter(ref => !!ref)];
  if (next.length > 1) target.frames = next; else delete target.frames;
  if (store.modelEditId === target.id) store.modelEditDoc = modelEditDocFor(store.mdoc, target);
  propOps.syncAuthoredModelLevel(); // the inspector reads the baked level, and rebuilds before the render does
  commit();
  scheduleRebuild();
}

/** Choose the edited model's tile off the art: the Texture Library rises at the bottom in pick mode, over the
 *  Edit session, and the chosen tile (or the "no texture" cell) lands on the model. Cancelling changes nothing. */
function pickEditedModelTexture() {
  const model = findModel(store.mdoc, store.modelEditId);
  if (!model) return;
  library.openPick({
    title: `Choose a texture — ${model.name}`,
    current: model.texture ?? null,
    onPick: ref => setEditedModelTexture(ref ?? ''),
  });
}


/**
 * Point the address bar at the map this tab has open, so the URL is a bookmark and a reload opens the same
 * mountain (state/map-url.ts).
 *
 * The project manifest is the authority on what a map is called, so the address names a map only while one is
 * genuinely open — the same rule the top bar's title follows (`getMountainName`). A tab still choosing which
 * mountain to open, or holding a browser-recovery document because the local service is down, has no map to
 * name: writing the document's name there would promise a URL this server cannot honour, and the next person
 * to follow the bookmark would be told no such mountain exists.
 *
 * A rename hands over the name it just settled on, because the manifest does not carry it until that save lands.
 */
function refreshMapUrl(name = projectSync.current()?.name ?? '') {
  showMapInUrl(name);
}

/** Bind the scene + panels to the current `mdoc` (after New / Load / undo). */
let mountainLoadCount = 0;
let assetProjectId = '';
async function loadMountain() {
  refreshMountainTitle();
  refreshMapUrl(); // every document replacement passes through here, so the URL follows the map by construction
  library.refreshMountainName();
  propLib.refreshMountainName();
  reference.refreshMountainName();
  const boot = mountainLoadCount++ === 0;
  const token = loadStatus.begin({
    title: boot ? 'Loading Slopesmith' : `Loading ${store.mdoc.name || 'mountain'}`,
    label: boot ? 'Restoring your mountain' : 'Opening mountain document',
    detail: 'Preparing editor state',
    progress: 3,
  });
  await loadStatus.afterPaint();
  try {
    const nextAssetProject = projectSync.current()?.id ?? '';
    const previousAssetProject = assetProjectId;
    // `boot === false` with no prior asset project is the project-picker path: the recovery document was
    // already rendered without a server-side project context. Treat binding its first real mountain exactly
    // like a switch so failed Custom/retail requests are retried instead of staying black until refresh.
    if (nextAssetProject && nextAssetProject !== previousAssetProject) {
      assetProjectId = nextAssetProject;
      if (previousAssetProject || !boot) {
        viewport.invalidateProjectAssets();
        propPreview.invalidateProjectAssets();
        await Promise.all([
          library.reloadCatalogue(), propLib.reloadCatalogue(), loadCustomSounds(true), initSky(),
        ]);
      }
    }
    cancelPastePlacement(false);
    cancelBridge(false, false);
    store.selected = null;
    store.selectedKnots = [];
    store.hiddenVertices = []; store.hiddenEdges = []; store.hiddenQuads = [];
    store.controlCageEdges = []; store.controlCageQuads = [];
    store.selectedCorner = null;
    store.selectedProp = null;
    store.selectedLight = null;
    store.selectedRefLight = null;
    store.selectedRefScreen = null;
    store.selectedRail = null;
    store.selectedNode = null;
    store.railDrawing = false;
    viewport.setRailArmed(false);
    store.selectedGem = null;
    store.gemArmed = false;
    viewport.setGemArmed(false);
    store.trickTool = null;
    store.selectedScreen = null;
    viewport.clearScreenSelection();
    effectsEditor?.clearSelection();
    store.surgeryTool = null;
    viewport.setSurgeryTool(null);
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    viewport.setWeldTool(false);
    clearCreateEdge();
    setSceneSel('info');
    exitRegion();
    viewport.clearCornerSelection();
    rebuildScene();
    applySceneSelection();
    viewport.mode = store.currentMode;
    effects.setActive(store.currentMode === 'effects');
    modeSeg.refresh();
    rebuildTools();
    updatePaintUi();
    refreshSelection();
    applyCage(); // effective cage onto the viewport + re-gate the overlay pill for the shade view
    focusActive();
    scheduleCommit(); // document replacement still participates in the same debounced history contract
    await renderDocProgressively(token);
    syncSunFromDoc(); // restore this doc's saved sun (or re-light with the current one) - it ships on export
    syncSkyFromDoc(); // ...and its saved sky, which ships the same way
    await loadStatus.finish(token, {
      label: 'Mountain ready',
      detail: `${store.mdoc.quads.length.toLocaleString()} patches loaded`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`build error: ${message}`);
    agentLayer?.onBuildError(error);
    await loadStatus.fail(token, message);
  }
}

// keyboard — the global shortcut listener (shortcuts.ts); everything it routes to exists by now
installShortcuts({
  store, viewport, edit, trickTools, propOps, sculptBrush: brush,
  undo, redo, setMode, rebuildTools, updateCmdSheet, scheduleRebuild, refreshSelection, deleteKnot,
  cageActive, focusActive, clearPaintSel, deleteSelectedLight, deleteSelectedScreen, deleteSelectedPaintTile,
  turnPaintTexture,
  turnModelTexture: turnEditedModelTexture,
  disarmBrush,
  stopWatch: () => play.stopWatch(),
  cancelStartPlacement: () => play.cancelStartPlacement(),
  exitModelEdit: () => exitModelEdit(),
  sceneBack: backToInfo,
  effects,
  chatFocused: () => chat.focused(),
  openChat: prefill => chat.open(prefill),
});

// Boot waits for the progressive terrain build before restoring dependent services and the saved camera. This
// also prevents a stored reference mountain from competing with the authored mountain for the status surface.
async function boot() {
  // Existing users arrive with their last localStorage mountain. If no disk project exists, initialize() makes
  // that exact recovery document the first project; otherwise the URL's map, and failing that the active disk
  // project, wins.
  store.mdoc = migrateMountain(await projectSync.initialize(store.mdoc, mapNameInUrl()));
  joinMap(); // presence and the register room follow the map this tab actually opened (docs/038)
  await loadMountain();
  // A link to a map this server does not have — renamed since, deleted, or somebody else's. Said out loud
  // rather than silently ignored, because the address bar has just been rewritten to whatever DID open. Which
  // may be nothing at all: with several mountains to choose between, the dialog below is the next thing on
  // screen, and naming the browser-recovery document there would name a map this server has never held.
  const missing = projectSync.missingMapName();
  const openedInstead = projectSync.current()?.name;
  if (missing) {
    toast(openedInstead
      ? `No mountain named ${missing} on this server — opened ${openedInstead} instead.`
      : `No mountain named ${missing} on this server.`, 'warn', 8000);
  }
  if (projectSync.needsProjectChoice()) openProjectDialog(true);
  void initReference();
  initSunLight();
  void initSky(); // fetches the sky catalogue, then hangs whatever sky the restored doc names
  library.init();
  propLib.init();
  applyPropsVisible(); // seed placed-prop visibility from the restored global toggle (reference props follow on load)
  viewport.showSelectedPropCollider(store.collisionOverlayOn); // seed the selection-local collision-shape preference
  applyLightsVisible(); // seed the light/sound source markers from the restored legacy lightRig toggle
  viewport.showAuthoredLights(reference.getSunOn() && store.propLightsVisible); // Lighting master + local-light preference
  viewport.showTricks(store.tricksVisible); // seed the Tricks filter (rails + gems visibility)
  viewport.showWorldEffects(store.worldEffectsVisible); // seed recovered material/model motion + persistent emitters
  viewport.setRideDrawDistance(store.playDrawDistance); // seed how far a ride draws (Test ▸ Draw distance)
  viewport.setRideSnow(store.playSnowAmount); // ...and how much snow it is ridden through (Test ▸ Snow)
  viewport.setRideMusic(store.playMusicOn); // ...and whether its environment/race-music handoff is audible
  viewport.setRideGameVolume(store.playGameVolume); // ...and the master gain over every gameplay voice
  viewport.setRideBoardFx(store.playBoardFxOn); // ...and whether the local board cuts a wake + throws contact spray
  viewport.setRideColliders(store.playCollidersOn); // ...and whether it draws its colliders (Test ▸ Show colliders)
  commit(); // baseline snapshot so the first edit is undoable
  refreshHistButtons();
  updateCmdSheet(); // seed the lower-right command summary for the initial (edit) mode
  log('');

  // loadMountain() frames from scratch; only boot overrides that with the view the user left off at.
  const storedView = loadStored<ViewState>(VIEW_KEY);
  if (isValidView(storedView)) viewport.applyView(storedView);
  // The terrain now exists, so restored sun/reference lighting can safely target its live materials.
  requestAnimationFrame(() => { applySunLight(); applyReferenceLighting(); });
}
void boot();
// The account menu, for a member (docs/038). Who this browser is was settled before this module was fetched —
// `boot.ts` only imports the editor for a browser the server accepts — so this reads that same answer and
// costs no request. An accountless loopback workspace gets Settings in the same upper-right position.
void installAccounts({
  openMyProfile: usersMode.showMyProfile,
  openSettings: () => openSettingsDialog('account'),
});
const applyMemberEquipment = (member: Member) => {
  viewport.equipmentAppearance = {
    ...(member.snowboardTextureUrl ? { snowboardTextureUrl: member.snowboardTextureUrl } : {}),
    ...(member.skiTextureUrl ? { skiTextureUrl: member.skiTextureUrl } : {}),
    ...(member.equipmentEdgeColor ? { edgeColor: member.equipmentEdgeColor } : {}),
  };
};
void currentAccount().then(account => { if ('user' in account) applyMemberEquipment(account.user); });
onAccountChanged(applyMemberEquipment);

/**
 * The session channel (docs/038, docs/039): presence, awareness, register changes and topology claims, over
 * one socket.
 *
 * Editing alone runs through exactly this path and notices nothing. The socket connects as the owner, this
 * tab is the only session in presence, every register it assigns lands, and the save disk settles after each
 * brief pulse. Nothing here prompts.
 */
let presenceByMap: Record<string, PresenceEntry[]> = {};
const peerMarks = new Map<string, PeerMarks>();
let jukeboxState: JukeboxState = emptyJukeboxState();
let jukeboxMediaId: string | null = null;
let jukeboxMediaVersion = -1;
let jukeboxChangedAt = -1;
// The room (docs/038), bottom-left over the viewport. It holds the keyboard while it is focused, which is
// what `chatFocused` above suppresses every editor shortcut against.
const chat = createChatBox({
  say: text => session.say(text),
  me: () => session.member(),
  suspended: () => viewport.riding,
});
const syncChatSpeakers = () => chat.setSpeakers(voice.members().filter(member => member.speaking));
voice.subscribe(syncChatSpeakers);
syncChatSpeakers();
/** This replica's register half: it watches the document, sends absolute assignments at the coalescing rate,
 *  claims the ids a topology edit consumes, and holds this participant's undo as inverse assignments. */
const registerSync = createRegisterSync({
  getDoc: () => store.mdoc,
  setDoc: doc => { store.mdoc = migrateMountain(doc); },
  channel: {
    assign: (changes, batch) => session.assign(changes, batch),
    claim: (ids, document, batch) => session.claim(ids, document, batch),
    checkDrift: digest => session.checkDrift(digest),
    fetchSections: sections => session.fetchSections(sections),
  },
  onApplied: what => {
    if (what === 'document') { history.reset(); void loadMountain(); return; }
    scheduleRebuild();
  },
  onStatus: status => syncChip.show(status),
  onOverride: (keys, by) => { log(`${by} changed ${keys.length} of the values you had touched`); },
  onReconcile: summary => syncChip.reconcile(summary),
});

/** Apply one authoritative queue/transport snapshot to this browser's optional local decoder. */
function applyJukeboxState(state: JukeboxState): void {
  jukeboxState = state;
  usersMode.setJukebox(state);
  const current = state.current;
  if (!current) {
    jukeboxMediaId = null;
    jukeboxMediaVersion = -1;
    jukeboxChangedAt = state.changedAt;
    viewport.stopJukeboxVideo();
    usersMode.setJukeboxMessage('The shared queue is empty.');
    return;
  }
  if (!loadSettings().videoBridge.enabled) {
    jukeboxMediaId = null;
    jukeboxMediaVersion = -1;
    jukeboxChangedAt = state.changedAt;
    viewport.stopJukeboxVideo();
    usersMode.setJukeboxMessage('Video playback is off in this browser.');
    return;
  }

  // Local Jukebox audio wins over Test mode's environment/race music. The viewport retains the checkbox
  // preference underneath this transport override, so pause/stop restores music only when it is still checked.
  viewport.setJukeboxVideoPlaying(state.playing);
  const expected = jukeboxPosition(state, session.serverNow());
  const reload = current.id !== jukeboxMediaId || state.mediaVersion !== jukeboxMediaVersion;
  const transportChanged = state.changedAt !== jukeboxChangedAt;
  jukeboxChangedAt = state.changedAt;
  if (!reload) {
    if (transportChanged) viewport.seekJukeboxVideo(expected);
    return;
  }
  jukeboxMediaId = current.id;
  jukeboxMediaVersion = state.mediaVersion;
  usersMode.setJukeboxMessage(`Starting ${current.username}’s video in this browser…`);
  void viewport.playJukeboxVideo(current.url, expected)
    .then(result => {
      if (!result || jukeboxState.current?.id !== current.id
        || jukeboxState.mediaVersion !== state.mediaVersion) return;
      // Extraction can take seconds. Rejoin the authoritative clock after it, rather than preserving the
      // position captured before the request left this browser.
      viewport.seekJukeboxVideo(jukeboxPosition(jukeboxState, session.serverNow()));
      viewport.setJukeboxVideoPlaying(jukeboxState.playing);
      if (result.provider === 'youtube') {
        const notConfigured = result.bridge.kind === 'not-configured';
        const bridgeState = notConfigured ? 'video bridge not set up' : 'video bridge failed';
        const explanation = notConfigured
          ? 'This browser is playing through YouTube because it does not have a complete Yattee account saved. '
            + 'YouTube’s embedded player cannot supply pixels to the WebGL course screens. '
            + `The bridge attempt reported: ${result.bridge.detail} `
            + 'Open the bridge settings, enter a reachable Yattee URL and account, choose Test connection, and save. '
            + 'On another computer, 127.0.0.1 means that computer. Reload Slopesmith or advance the queue after setup.'
          : `Slopesmith tried the video bridge at ${result.bridge.serverUrl}, but it could not provide this stream: `
            + `${result.bridge.detail} YouTube playback can continue, but its embedded player cannot supply pixels `
            + 'to the WebGL course screens. Open the bridge settings and choose Test connection; after repairing it, '
            + 'reload Slopesmith or advance the queue.';
        usersMode.setJukeboxMessage(
          `${jukeboxState.playing ? 'Playing' : 'Paused'} ${result.title} on YouTube · ${bridgeState}; `
            + `course screens off · queued by ${current.username}.`,
          'warn',
          {
            title: notConfigured ? 'Course screens need a video bridge' : 'The video bridge failed',
            body: explanation,
            actionLabel: 'Open bridge settings',
            action: () => openSettingsDialog('integrations'),
          },
        );
      } else {
        usersMode.setJukeboxMessage(
          `${jukeboxState.playing ? 'Playing' : 'Paused'} ${result.title} · queued by ${current.username}.`, 'ok',
        );
      }
    })
    .catch(error => {
      if (jukeboxState.current?.id !== current.id) return;
      usersMode.setJukeboxMessage(error instanceof Error ? error.message : String(error), 'err');
    });
}

/** The Jukebox switch is browser-local; turning it back on joins the current shared media epoch immediately. */
function setJukeboxVideoEnabled(enabled: boolean): void {
  const videoBridge = loadSettings().videoBridge;
  saveSettings({ videoBridge: { ...videoBridge, enabled } });
  jukeboxMediaId = null;
  jukeboxMediaVersion = -1;
  applyJukeboxState(jukeboxState);
}

const session = createSessionChannel({
  clientId: editorClientId,
  deviceLabel: editorDeviceLabel,
  // Presence moved, so the roster's online column and everybody's open map moved with it.
  onPresence: maps => { presenceByMap = maps; usersMode.refresh(); refreshPeers(); },
  onProfileChanged: () => usersMode.refresh(),
  onStatusChanged: () => usersMode.refresh(),
  onChat: line => {
    chat.push(line);
    if (line.kind !== 'system' && line.from) {
      viewport.showPlayerChat(line.from.userId, plainChatText(line.text));
    }
  },
  onChatHistory: lines => chat.replay(lines),
  onJukebox: applyJukeboxState,
  onJukeboxError: message => usersMode.setJukeboxMessage(message, 'err'),
  onScreenState: receiveScreenFrame,
  onScreenObserveEnded: targetSessionId => {
    if (screenObservation?.sessionId !== targetSessionId) return;
    const username = screenObservation.username;
    stopObservingScreen(false);
    toast(`${username} stopped sharing their screen.`, 'info');
  },
  onScreenWatchers: count => {
    screenWatcherCount = count;
    refreshObserverControls();
  },
  onRideEvent: event => {
    const current = projectSync.current();
    if (current && event.projectId === current.id) viewport.applyRideEvent(event);
  },
  // The room on this map is open. A tab that may write sends registers from here on; one that may not — a
  // viewer, or a build that would evaluate this mountain differently — follows read-only (docs/039).
  onJoined: view => {
    const current = projectSync.current();
    if (!current || view.projectId !== current.id) return;
    projectSync.setWritable(view.writable, view.reason ?? '');
    projectSync.setShared(view.writable);
    syncChip.setShared(view.writable);
    if (view.writable) registerSync.connect(); else registerSync.detach();
  },
  onProjectAccess: change => {
    if (!projectSync.applyProjectMetadata(change.project)) return;
    projectSync.setWritable(change.writable, change.reason ?? '');
    projectSync.setShared(change.writable);
    syncChip.setShared(change.writable);
    if (change.writable) registerSync.connect();
    else {
      registerSync.detach();
      if (change.document) {
        store.mdoc = migrateMountain(change.document);
        registerSync.adopt(store.mdoc);
        history.reset();
        void loadMountain();
      }
    }
    usersMode.refresh();
  },
  onSync: push => registerSync.applySync(push.changes, push.by),
  onLanded: ack => registerSync.landed(ack),
  onClaim: result => registerSync.claimed(result),
  onTopology: push => registerSync.applyTopology(migrateMountain(push.document)),
  onDigest: answer => registerSync.compareDigest(answer),
  onSections: repair => registerSync.repair(repair),
  onCaughtUp: missed => registerSync.caughtUp(missed),
  onRoomPolicy: policy => awareness.setPeriod(policy.awarenessMs),
  onLibraryChanged: change => {
    if (change.scope === 'custom') {
      // A Blender push announces itself on this same event (docs/046). An imported prop's push has already
      // been written to its record, so the catalogue reload below IS the update; an authored model's is
      // still waiting in the mountain's inbox, and this is the tab that comes and collects it.
      void collectBlenderPushes();
      void Promise.all([library.reloadCatalogue(), propLib.reloadCatalogue(), refreshRiderModelCatalog()])
        .then(() => rebuildTools())
        .catch(() => toast('The shared asset catalogue changed, but could not be refreshed yet.', 'err'));
    } else {
      void initSky().then(() => rebuildTools())
        .catch(() => toast('The shared sky catalogue changed, but could not be refreshed yet.', 'err'));
    }
  },
  onAware: peer => {
    peerMarks.set(peer.sessionId, {
      sessionId: peer.sessionId,
      userId: peer.userId,
      username: peer.username,
      color: peer.color,
      ...(peer.snowboardTextureUrl ? { snowboardTextureUrl: peer.snowboardTextureUrl } : {}),
      ...(peer.skiTextureUrl ? { skiTextureUrl: peer.skiTextureUrl } : {}),
      ...(peer.equipmentEdgeColor ? { equipmentEdgeColor: peer.equipmentEdgeColor } : {}),
      cursor: peer.aware.cursor, vertices: peer.aware.vertices, quads: peer.aware.quads,
      dragging: peer.aware.dragging,
      player: peer.aware.player,
    });
    refreshPeers();
  },
  onRevision: push => {
    const applied = projectSync.applyPush(push);
    if (applied) registerSync.adopt(applied);
  },
  // The map this tab had open has been deleted on the server (docs/038).
  onGone: map => { void leaveDeletedMap(map); },
  onStatus: status => {
    // A reconnection is a fresh session on the server, holding empty awareness for this tab until it says
    // otherwise — so what this replica believes the room knows about it starts over with the socket. The
    // channel rejoins after its welcome; doing that here as well asks for (and applies) the same catch-up twice.
    if (status === 'open') awareness.reset();
    else if (status === 'closed') { registerSync.disconnect(); projectSync.setShared(false); }
  },
  onAccessChanged: reason => {
    toast(reason, 'info', 7000);
    setTimeout(() => location.reload(), 800);
  },
  onCapacityRefused: reason => {
    toast(`${reason} This tab will retry automatically.`, 'warn', 8000);
  },
});
// This overlay reads the session's local sharing state during its initial refresh, so construct it only after
// the channel exists. It is still installed before start(), ensuring the first socket event has a live repaint.
const observerControls = createObserverControls({
  observing: () => screenObservation
    ? { username: screenObservation.username, paused: screenObservation.paused } : null,
  sharing: () => session.screenSharing() ? { watchers: screenWatcherCount } : null,
  pauseObserving: pauseObservingScreen,
  continueObserving: continueObservingScreen,
  stopObserving: () => stopObservingScreen(),
});
refreshObserverControls = () => observerControls.refresh();
session.start();
viewport.onJukeboxVideoEnded(() => {
  const current = jukeboxState.current;
  if (current) session.jukeboxVideoEnded(current.id, jukeboxState.mediaVersion);
});
// A buffering stall does not move the server clock. Nudge this decoder back when it drifts materially, while
// leaving small media-clock differences alone so playback is not constantly seeking.
setInterval(() => {
  if (!jukeboxState.current || jukeboxMediaId !== jukeboxState.current.id) return;
  const local = viewport.jukeboxVideoTime();
  const expected = jukeboxPosition(jukeboxState, session.serverNow());
  // A browser may require one local click before unmuted autoplay. Keep its pending retry position current
  // even while it is paused at zero; the card's Retry button then starts at the live server playhead.
  if ((local.current <= 0 && expected > 1) || (local.duration > 0 && Math.abs(local.current - expected) > 1.5)) {
    viewport.seekJukeboxVideo(expected);
  }
}, 2_000);
registerSync.start();
/** Only the people on this map, and only while their marks are fresh — a peer who has gone leaves nothing
 *  drawn on the terrain. */
let warnedOtherOwnSessionOn: string | null = null;
let playPlayerRosterKey = '';
function refreshPeers(): void {
  const projectId = projectSync.current()?.id ?? '';
  const entries = presenceByMap[projectId] ?? [];
  const here = new Set(entries.map(entry => entry.sessionId));
  for (const sessionId of [...peerMarks.keys()]) if (!here.has(sessionId)) peerMarks.delete(sessionId);
  const hiddenObservationTargets = new Set<string>();
  const localSessionId = session.sessionId();
  if (session.screenSharing() && localSessionId) hiddenObservationTargets.add(localSessionId);
  if (screenObservation && !screenObservation.paused) hiddenObservationTargets.add(screenObservation.sessionId);
  const hiddenPlayerSessions = new Set(entries
    .filter(entry => entry.screenWatchingSessionId
      && hiddenObservationTargets.has(entry.screenWatchingSessionId))
    .map(entry => entry.sessionId));
  const observedSessionId = screenObservation && !screenObservation.paused
    ? screenObservation.sessionId : null;
  // The observer is rendering from the sharer's camera, so their remote avatar would overlap that view.
  // Suppress only the player model here; their observer-routed cursor and editing marks remain visible.
  if (observedSessionId) hiddenPlayerSessions.add(observedSessionId);
  const visiblePeerMarks = [...peerMarks.values()]
    .filter(peer => peer.sessionId !== localSessionId)
    .map(peer => ({
      ...peer,
      cursor: peer.sessionId === observedSessionId ? observedScreenCursor : null,
    }));
  // Screen frames can arrive before the target's first awareness batch. Presence has enough identity to
  // render their observer-only cursor immediately without inventing selections, a player pose, or drag marks.
  if (observedSessionId && observedScreenCursor
    && !visiblePeerMarks.some(peer => peer.sessionId === observedSessionId)) {
    const target = entries.find(entry => entry.sessionId === observedSessionId);
    if (target) visiblePeerMarks.push({
      sessionId: target.sessionId,
      userId: target.userId,
      username: target.username,
      color: target.color,
      ...(target.snowboardTextureUrl ? { snowboardTextureUrl: target.snowboardTextureUrl } : {}),
      ...(target.skiTextureUrl ? { skiTextureUrl: target.skiTextureUrl } : {}),
      ...(target.equipmentEdgeColor ? { equipmentEdgeColor: target.equipmentEdgeColor } : {}),
      cursor: observedScreenCursor,
      vertices: [],
      quads: [],
      dragging: [],
      player: null,
    });
  }
  viewport.setPeers(
    visiblePeerMarks, session.serverNow(), hiddenPlayerSessions,
  );
  // Awareness poses refresh continuously; the toolbox only needs rebuilding when the set of selectable players
  // changes. That makes the Position chooser appear/disappear live without repeatedly destroying a focused UI.
  const nextPlayerRosterKey = viewport.activeMapPlayers()
    .map(player => `${player.sessionId}\u0000${player.username}`).sort().join('\u0001');
  if (nextPlayerRosterKey !== playPlayerRosterKey) {
    playPlayerRosterKey = nextPlayerRosterKey;
    if (store.currentMode === 'play') rebuildTools();
  }
  const ownUserId = session.member()?.id;
  const anotherOwnSession = ownUserId
    ? entries.find(entry => entry.userId === ownUserId && entry.sessionId !== session.sessionId())
    : undefined;
  if (anotherOwnSession && warnedOtherOwnSessionOn !== projectId) {
    warnedOtherOwnSessionOn = projectId;
    toast(`This map is also open as you on ${anotherOwnSession.deviceLabel ?? 'another device'}. `
      + 'Changes sync live; Undo can replace their recent changes.', 'info', 9000);
  } else if (!anotherOwnSession && warnedOtherOwnSessionOn === projectId) {
    warnedOtherOwnSessionOn = null;
  }
}
/**
 * What this tab is selecting and painting, told to the room (docs/039).
 *
 * The selection is what was picked by hand; the register sync says what is being WRITTEN, which is the half
 * that makes a paint stroke visible — a stroke drops the paint selection on its first face, so the faces it
 * is painting are the only thing there is to report.
 */
const awareness = createAwareness({
  selection: () => ({
    vertices: [...store.regionSel, ...(store.selectedCorner ? [store.selectedCorner] : [])],
    quads: [...store.cellSel, ...store.paintMultiSel,
      ...(store.selectedPaintCell ? [store.selectedPaintCell] : [])],
  }),
  editing: () => registerSync.editing(),
  // Keep the legacy awareness field explicitly empty. Cursors belong to observer-routed screen frames.
  cursor: () => null,
  player: () => viewport.playerPose(store.playRiderModel, session.serverNow()),
  send: aware => session.aware(aware),
});
awareness.start();
/** A shared screen is a local re-render, not video: publish the camera + display switches at awareness cadence. */
setInterval(() => {
  if (!session.screenSharing()) return;
  session.shareScreen({
    cursor: viewport.pointerOnMountain(),
    view: viewport.serializeSharedView(),
    options: currentSharedViewOptions(),
  });
}, 80);
/** Follow this tab's open map: presence is keyed on it, and so is the room. */
function joinMap(document: EditDoc = store.mdoc): void {
  const current = projectSync.current();
  peerMarks.clear();
  refreshPeers();
  session.watch(current?.id ?? null);
  awareness.reset(); // the server drops what a tab said about the map it left
  // Project creation/opening calls this before the dialog installs the document into store.mdoc. Rebase the
  // register replica from the document being joined, not from the project that happens to still be rendered.
  registerSync.adopt(document);
}
/**
 * Somebody deleted the map this tab had open (docs/038).
 *
 * The server has already taken this tab off it, so what is left is to say so and put the editor back on a map
 * it can write to — another one on the server, or a fresh one when that was the last. Leaving it pointed at
 * the deleted project would mean an autosave failing against a folder that is gone, over and over.
 */
let leavingDeletedProjectId: string | null = null;
async function leaveDeletedMap(map: { projectId: string; name: string }): Promise<void> {
  if (projectSync.current()?.id !== map.projectId || leavingDeletedProjectId === map.projectId) return;
  leavingDeletedProjectId = map.projectId;
  toast(`${map.name} was deleted on this server, and its name retired.`, 'info', 8000);
  try {
    const remaining = (await projectSync.list()).filter(entry => entry.id !== map.projectId);
    let document: EditDoc;
    if (remaining.length) document = await projectSync.open(remaining[0].id);
    else { document = defaultMountain(); await projectSync.create(document); }
    joinMap(document);
    history.reset();
    store.mdoc = document;
    await loadMountain();
    toast(`Opened ${document.name}.`, 'ok');
  } catch (error) {
    toast(`No map could be opened after that: ${error instanceof Error ? error.message : error}`, 'err', 8000);
  } finally {
    if (leavingDeletedProjectId === map.projectId) leavingDeletedProjectId = null;
  }
}
/** Who else is on this map, one row per person however many tabs they have open — presence keyed by session
 *  and displayed by user. The dock that lists them is Users mode (docs/038); this is what it reads. */
export const mapMembers = () => membersOn(presenceByMap[projectSync.current()?.id ?? ''] ?? []);
window.addEventListener('pagehide', () => registerSync.flush());
// ...and save it again when the page is hidden / unloaded so the next refresh keeps this view
window.addEventListener('pagehide', persistView);
window.addEventListener('beforeunload', persistView);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistView(); });
window.addEventListener('pagehide', () => { void projectSync.flush(true); });
window.addEventListener('beforeunload', () => { void projectSync.flush(true); });
