import type { CoursePath, AuthoredLight, Gem, V3 } from '../core/doc/types';
import {
  applyBrush, applyGrabBrush, applyPushBrush, createFlattenBrushPlane, createGrabBrushState,
  type BrushOp, type BrushDir, type BrushFalloff, type FlattenMode, type FlattenPlaneBehavior,
  type FlattenBrushPlane, type GrabBrushState,
} from '../core/doc/mountain';
import { setSurf, setTex, setOrient } from '../core/doc/doc-edit';
import { makeTexRef, parseTexRef } from '../core/paint/textures';
import { alphaAnalysisLabel, analyzeTextureAlpha } from './props/texture-alpha';
import type { Store } from './state/store';
import type { EditSession } from './edit/session';
import type { Palette } from './paint/palette';
import type { TextureLibrary } from './paint/library';
import type { PropOps } from './props/operations';
import type { Play } from './ride/play';
import type { SceneSel } from './ui/chrome/scene-panel';
import { toast } from './ui/components/toast';
import type { RotationSnapStep, SnapStep, Viewport, ViewportCallbacks } from './viewport/viewport';
import { shortcutForMode } from './mode-shortcuts';
import { attachModelEffectsToProp, createEmptyEffectsDocument, nextPlacedPropId } from '../core/effects/authoring';
import { nextGemId, nextLightId } from '../core/doc/ids';
import type { RigLight } from '../core/reference/lights';
import { placedPropCollisionProfile } from '../core/props/contact';
import { unrotateByPlacement, writePropRotation } from '../core/props/pose';
import { screenProp } from '../core/props/screen';
import type { RideEvent } from '../core/session/ride-event';

const subV3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleV3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/**
 * The viewport → application wiring: builds the ViewportCallbacks the Viewport is constructed with,
 * translating each viewport gesture — knot picks, painting + tile turns, sculpt dabs, prop / light / rail /
 * gem placement and transforms, the reference + mountain picks, the ride-spawn click — into store writes and
 * the host's rebuild / persist / panel refreshes. The Edit-mode gestures arrive as the edit session's own
 * callback block, spread in first. The Viewport consumes these callbacks while it is being constructed, and
 * several services (the panels, prop ops, the rebuild funnel, play) are built after it — those come in as
 * accessor closures, resolved when a callback fires, never during construction.
 */

export type ViewportWiringDeps = {
  // built before the viewport — passed directly
  store: Store;
  edit: EditSession; // its viewportCallbacks block is spread in; prop picks reset the gizmo through it
  brush: { op: BrushOp; dir: BrushDir; falloff: BrushFalloff; flattenMode: FlattenMode;
    flattenPlaneBehavior: FlattenPlaneBehavior; radius: number; strength: number;
    smoothAmount: number; flattenAmount: number; pushAmount: number }; // shared sculpt config
  gemTool: { height: number; spacing: number; value: number }; // gem placement defaults (float height, drag-row gap, tier)
  /** Free-light placement defaults — what the next hand-placed light drops as (main.ts owns the object). */
  lightTool: { kind: 'point' | 'spot'; color: string; intensity: number; reach: number; cone: number; glint: number };
  // host glue that stays with the compose root (view toggles + the paint-selection helpers)
  toggleViewGrid: () => void;
  setViewGridStep: (step: SnapStep) => void;
  toggleSnap: () => void;
  setSnapStep: (step: SnapStep) => void;
  setRotationSnapStep: (step: RotationSnapStep) => void;
  selectPaintCell: (quad: number | null) => void;
  rangeSelectPaintCells: (quad: number) => void;
  clearPaintSelection: () => void;
  // built after the viewport — reached through accessor closures, live by the time any callback fires
  viewport: () => Viewport;
  palette: () => Palette;
  library: () => TextureLibrary;
  propOps: () => PropOps;
  play: () => Play;
  coursePath: () => CoursePath;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  refreshSelection: () => void;
  getSceneSel: () => SceneSel;
  selectScene: (kind: SceneSel) => void;
  showReferenceLightDetails: (level: string | null, light: RigLight | null) => void;
  persistRef: () => void;
  sendRideEvent: (event: RideEvent) => boolean;
};

export function createViewportCallbacks(deps: ViewportWiringDeps): ViewportCallbacks {
  const {
    store, edit, brush, gemTool, lightTool,
    toggleViewGrid, setViewGridStep, toggleSnap, setSnapStep, setRotationSnapStep,
    selectPaintCell, rangeSelectPaintCells, clearPaintSelection,
    viewport, palette, library, propOps, play, coursePath,
    scheduleRebuild, rebuildTools, updateCmdSheet, refreshSelection,
    getSceneSel, selectScene, showReferenceLightDetails, persistRef, sendRideEvent,
  } = deps;
  const { resetGizmoMode } = edit;
  let grabBrush: GrabBrushState | null = null;
  let flattenPlane: FlattenBrushPlane | null = null;
  let pushPoint: V3 | null = null;

  const clearReferenceLight = () => {
    if (!store.selectedRefLight) return;
    store.selectedRefLight = null;
    showReferenceLightDetails(null, null);
  };
  const clearScreenState = () => {
    store.selectedScreen = null;
    store.selectedRefScreen = null;
  };

  /** A fresh hand-placed free light, dropped at whatever the Add light panel is preset to. A spot also needs
   *  the two fields only it has; a point carries neither, so nothing writes a cone onto a light with no cone. */
  function newFreeLight(lights: readonly AuthoredLight[], pos: V3): AuthoredLight {
    const light: AuthoredLight = { id: nextLightId(lights), kind: lightTool.kind, pos,
      color: lightTool.color, intensity: lightTool.intensity, reach: lightTool.reach };
    if (lightTool.kind === 'spot') { light.dir = [0, -1, 0]; light.cone = lightTool.cone; }
    if (lightTool.glint) light.glint = lightTool.glint;
    return light;
  }

  return {
    ...edit.viewportCallbacks,
    onRideControlContextChange() { updateCmdSheet(); },
    onRideEvent(event) { sendRideEvent(event); },
    onToggleViewGrid() { toggleViewGrid(); },
    onSetViewGridStep(step) { setViewGridStep(step); },
    onToggleSnap() { toggleSnap(); },
    onSetSnapStep(step) { setSnapStep(step); },
    onSetRotationSnapStep(step) { setRotationSnapStep(step); },
    onClickTargetUnavailable(component, source) {
      const noun = component === 'vertex' ? 'point' : component === 'line' ? 'edge' : component === 'surface' ? 'patch'
        : component === 'knot' ? 'course knot' : component === 'screen' ? 'video screen' : component;
      const target = `${source === 'reference' ? 'a reference ' : 'a '}${noun}`;
      if (store.currentMode === 'edit'
        && (component === 'vertex' || component === 'line' || component === 'surface')) {
        const filter = component === 'vertex' ? 'Point' : component === 'line' ? 'Edge' : 'Patch';
        toast(`You clicked ${target}, but ${filter} selection is off. Turn on ${filter} at the top of the Edit toolbox to select it.`, 'warn');
        return;
      }
      // Test mode: every click belongs to the mountain being ridden, so the useful thing to say is WHICH
      // mountain was clicked and how to reconcile it — not "switch to Edit", which is never what was meant.
      // Only the click that lands consumes an armed start placement, so say that it survives this one.
      if (store.currentMode === 'play') {
        if (source !== store.playTarget) {
          const mountainName = store.mdoc.name.trim() || 'Mountain';
          const referenceName = viewport().refLevelName.trim() || 'Reference';
          const clicked = source === 'reference' ? referenceName : mountainName;
          const riding = store.playTarget === 'reference' ? referenceName : mountainName;
          const slope = store.playTarget === 'reference' ? `${referenceName} terrain` : `${mountainName} terrain`;
          const swap = source === 'reference' ? referenceName : mountainName; // the button for the mountain just clicked
          toast(`You clicked ${clicked}, but you’re set to ride ${riding}. Click ${slope}, or switch the ride target`
            + ` to ${swap}.${store.placingStart ? ' The start stays armed.' : ''}`, 'warn');
          return;
        }
        toast(`You clicked ${target}, not the slope. Click the terrain itself to `
          + `${store.placingStart ? 'place the ride start' : 'drop an AI rider'}.`, 'warn');
        return;
      }
      const destination = shortcutForMode(component === 'knot' ? 'info'
        : component === 'prop' || component === 'light' || component === 'rail' || component === 'gem' ? 'props' : 'edit');
      toast(`You clicked ${target}. Switch to the ${destination.label} view [${destination.key}] to edit.`, 'warn');
    },
    onSelectEdgeCrossing(crossing) { edit.selectEdgeCrossing(crossing); },
    onSelectCoincidentVertices(diagnostic) { edit.selectCoincidentVertices(diagnostic); },
    onSelectKnot(i) {
      // Scene-object picks call onSelectKnot(null) to enforce mutual exclusion. In Props mode this is almost
      // always already true; routing that no-op through scheduleRebuild recreated the mountain and every prop
      // on the next animation frame (hundreds of milliseconds on a loaded reference) after the prop itself had
      // already selected. Keep the callback idempotent so only an actual course-selection change renders.
      if (store.selected === i && store.selectedKnots.length === 0 && (i === null || getSceneSel() === 'course')) return;
      store.selected = i;
      store.selectedKnots = [];
      if (i !== null) selectScene('course'); // activate Mountain's Course/knot panels
      refreshSelection();
      updateCmdSheet();
      scheduleRebuild();
    },
    onSelectKnots(indices) {
      store.selected = null;
      store.selectedKnots = [...new Set(indices)].sort((a, b) => a - b);
      if (store.selectedKnots.length) selectScene('course');
      refreshSelection();
      updateCmdSheet();
      scheduleRebuild();
    },
    onMoveKnot(i, pos: V3) {
      const line = coursePath();
      if (line?.knots[i]) line.knots[i].pos = pos;
      refreshSelection();
      scheduleRebuild();
    },
    onMoveAnchor(which, pos: V3) {
      const line = coursePath();
      if (!line) return;
      line[which] = { pos };
      refreshSelection();
      scheduleRebuild();
    },
    onPaintCell(quad) {
      if (!store.paintBrush) return;
      if (store.selectedPaintCell !== null || store.selectedRefPatch !== null || store.paintMultiSel.length
        || palette().inspecting) clearPaintSelection(); // first stroke leaves the sampled source for the live brush
      const d = store.mdoc, b = store.paintBrush; // a tile brush: carries the tile + its ride feel + D4 orientation
      setTex(d, quad, b.ref);
      setOrient(d, quad, b.rot || b.mirror ? { rot: b.rot, mirror: b.mirror } : null);
      // tile look and SurfaceType (physics) are separate channels in SSX, but every painted tile carries a
      // ride feel (snow by default, chosen per-cell in the Palette's Surface mode), so always stamp it.
      setSurf(d, quad, b.surface);
      scheduleRebuild();
    },
    onPick(p) {
      // Paint MMB makes the sampled texture the active brush at the orientation it sits at
      // relative to the patch (the green frame-F → pink art-F turn), ride feel and all.
      if (!p.ref) {
        toast(p.source === 'reference' ? 'that reference patch has no texture'
          : p.source === 'prop' ? 'that prop surface is untextured'
          : 'no texture here yet — paint one first', 'warn');
        return;
      }
      void library().pickTexture(p.ref, p.surface, p.rot, p.mirror)
        .then(msg => toast(msg, 'ok'))
        .catch(error => toast(`texture sample failed: ${error instanceof Error ? error.message : String(error)}`, 'err'));
    },
    onBeginSculpt(point, quad, normal) {
      pushPoint = brush.op === 'push' ? [...point] : null;
      flattenPlane = brush.op === 'flatten' && brush.flattenPlaneBehavior === 'locked'
        ? createFlattenBrushPlane(store.mdoc, point, brush.radius, quad, brush.falloff, brush.flattenMode, normal)
        : null;
    },
    onSculpt(point, quad, normal) {
      if (brush.op === 'push') {
        const previous = pushPoint;
        pushPoint = [...point];
        if (!previous) return;
        const delta: V3 = [point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]];
        if (Math.hypot(...delta) < 1e-12) return;
        applyPushBrush(store.mdoc, point, brush.radius, quad, brush.falloff, delta, normal, brush.pushAmount / 100);
        scheduleRebuild();
        return;
      }
      applyBrush(store.mdoc, brush.op, point, brush.radius, brush.strength, brush.dir, quad, brush.falloff,
        brush.flattenMode, normal, flattenPlane, brush.smoothAmount / 100, brush.flattenAmount / 100);
      scheduleRebuild();
    },
    onEndSculpt() { flattenPlane = null; pushPoint = null; },
    isGrabBrush() { return brush.op === 'grab'; },
    onBeginSculptGrab(point, quad) {
      grabBrush = createGrabBrushState(store.mdoc, point, brush.radius, quad, brush.falloff);
    },
    onSculptGrab(delta) {
      if (!grabBrush) return;
      applyGrabBrush(store.mdoc, grabBrush, delta);
      scheduleRebuild();
    },
    onEndSculptGrab() { grabBrush = null; },
    onPlaceProp(pos: V3, yaw: number, scale: number) {
      if (!store.armedProp) return;
      const props = (store.mdoc.props ??= []);
      // the viewport hands over the ghost's exact pose: pos already seated (base offset × scale taken out of
      // the height), yaw/scale as the wheel left them. The tool stays armed — repeat clicks stamp more —
      // and nothing gets selected, so the gizmo never lands under the ghost mid-stamp. A held GROUP stamps
      // one placement carrying the def id; its members + lights derive from it (docs/015).
      const id = nextPlacedPropId(props);
      props.push({ id, level: store.armedProp.level, model: store.armedProp.model, name: store.armedProp.name, pos, yaw, scale,
        nativeCollision: structuredClone(store.armedProp.nativeCollision),
        ...(typeof store.armedProp.surface === 'number' ? { surface: store.armedProp.surface } : {}),
        ...(store.armedProp.modePresence === 'showoff' ? { modePresence: 'showoff' as const } : {}),
        ...(store.armedProp.group ? { group: store.armedProp.group } : {}),
      });
      // A model that declared its own effects gets them attached here, so stamping a snow gun down gives
      // you one that is already throwing snow rather than one waiting to be wired up. Emitters and
      // scrolling surfaces both become ordinary nodes in an ordinary persistent graph, which the Effects
      // editor owns from that moment: retune or delete it, and the next stamp is unaffected because this
      // only ever fires for a prop with no attachment yet.
      const declared = propOps().modelDeclarations(store.armedProp.level, store.armedProp.model);
      if (declared.emitters.length || declared.scrolls.length || declared.clip) {
        const effects = (store.mdoc.effects ??= createEmptyEffectsDocument(store.mdoc.name));
        attachModelEffectsToProp(effects, id, declared);
      }
      scheduleRebuild();
    },
    onSelectProp(i: number | null) {
      resetGizmoMode();
      store.selectedProp = i;
      store.multiSel = []; // a single pick (or an empty-space click) replaces any box selection
      if (i !== null) {
        store.selectedLight = null; store.selectedRail = null; store.selectedNode = null; store.selectedGem = null;
        clearScreenState();
        clearReferenceLight();
      }
      if (store.currentMode === 'props') rebuildTools();
    },
    onMoveProp(i: number, pos: V3) {
      const p = store.mdoc.props?.[i];
      if (p) p.pos = pos;
      scheduleRebuild();
    },
    onRotateProp(i: number, rot) {
      const p = store.mdoc.props?.[i];
      if (p) writePropRotation(p, rot);
      scheduleRebuild();
    },
    onScaleProp(i: number, pos: V3, scale: number) {
      const p = store.mdoc.props?.[i];
      if (p) { p.pos = pos; p.scale = scale; }
      scheduleRebuild();
    },
    onResizeEffectTrigger(i: number, size: V3) {
      const p = store.mdoc.props?.[i];
      if (p?.effectTrigger) p.effectTrigger.size = size;
      scheduleRebuild();
    },
    onSelectProps(indices: number[]) { // box-select drag finished (empty = dragged over nothing, clearing the set)
      resetGizmoMode();
      store.multiSel = indices;
      if (indices.length) {
        store.selectedProp = null; store.selectedLight = null; store.selectedRail = null; store.selectedNode = null;
        store.selectedGem = null; clearScreenState(); clearReferenceLight();
      }
      viewport().setPlacedPropSelection(store.selectedProp, indices);
      if (store.currentMode === 'props') rebuildTools();
    },
    onMoveProps(delta: V3) { // the multi-selection's centre gizmo moved: carry every member along
      if (!store.mdoc.props) return;
      for (const i of store.multiSel) {
        const p = store.mdoc.props[i];
        if (p) { p.pos[0] += delta[0]; p.pos[1] += delta[1]; p.pos[2] += delta[2]; }
      }
      scheduleRebuild();
    },
    onRotateProps(updates) { // rigid turn around the set's centre: both origins and authored rotations follow
      if (!store.mdoc.props) return;
      for (const u of updates) {
        const p = store.mdoc.props[u.index];
        if (p) { p.pos = u.pos; writePropRotation(p, u); }
      }
      scheduleRebuild();
    },
    onScaleProps(updates) { // scale the set about its centre: both placement origins and member sizes follow
      if (!store.mdoc.props) return;
      for (const u of updates) {
        const p = store.mdoc.props[u.index];
        if (p) { p.pos = u.pos; p.scale = u.scale; }
      }
      scheduleRebuild();
    },
    onPickReferenceProp(level: string, model: number, name: string, sourceIndex?: number) {
      void propOps().armProp(level, model, name, { sourceIndex });
    }, // MMB a ref prop → hold an exact instance-derived copy
    onPickPlacedProp(i: number) { // MMB a placed prop → hold its model (or its whole group) to place more
      const p = store.mdoc.props?.[i];
      if (!p) return;
      if (p.group) void propOps().armGroupById(p.level, p.group, {
        nativeCollision: structuredClone(placedPropCollisionProfile(p)),
        ...(typeof p.surface === 'number' ? { surface: p.surface } : {}),
        ...(p.modePresence === 'showoff' ? { modePresence: 'showoff' as const } : {}),
      });
      else void propOps().armProp(p.level, p.model, p.name, {
        nativeCollision: structuredClone(placedPropCollisionProfile(p)),
        ...(typeof p.surface === 'number' ? { surface: p.surface } : {}),
        ...(p.modePresence === 'showoff' ? { modePresence: 'showoff' as const } : {}),
      });
    },
    onSelectReferenceProp(level, model, modelName, inst) { // read-only pick of a reference prop (all-null clears it)
      const selected = level !== null && model !== null && modelName !== null;
      if (selected) {
        // PointerRouter already dropped the live scene handles. Mirror that mutual exclusion in host state
        // here so selecting a reference prop needs one toolbox refresh and no document rebuild callbacks.
        store.selectedProp = null; store.multiSel = []; store.selectedLight = null;
        store.selectedRail = null; store.selectedNode = null; store.selectedGem = null;
        clearScreenState();
        clearReferenceLight();
      }
      store.selectedRefProp = selected
        ? { level: level!, model: model!, name: inst?.name?.trim() || modelName!, modelName: modelName!,
            ...(inst ? { sourceIndex: inst.sourceIndex } : {}),
            ltgState: inst?.ltgState ?? 0,
            collisionSound: inst?.collisionSound ?? -1, contact: inst?.contact,
            playerCollision: inst?.playerCollision ?? false, playerBounce: inst?.playerBounce ?? false,
            bounce: inst?.bounce ?? -1, surface: inst?.surface ?? -1, shape: inst?.shape ?? 0,
            responseMass: inst?.responseMass ?? -1, dynamicMass: inst?.dynamicMass ?? -1,
            physicsBody: inst?.physicsBody ?? -1,
            externalSounds: inst?.externalSounds ?? [] } : null;
      if (store.currentMode === 'props') rebuildTools(); // the preview card shows it tagged 'reference'
    },
    onSelectReferenceLight(level, light) {
      const selected = level !== null && light !== null;
      if (selected) {
        store.selectedProp = null; store.multiSel = []; store.selectedLight = null; store.selectedRefProp = null;
        store.selectedRail = null; store.selectedNode = null; store.selectedGem = null;
        clearScreenState();
      }
      store.selectedRefLight = selected ? { level: level!, light: light! } : null;
      showReferenceLightDetails(level, light);
      if (store.currentMode === 'props') rebuildTools();
    },
    onSelectReferenceScreen(level, screen) {
      const selected = level !== null && screen !== null;
      if (selected) {
        store.selectedProp = null; store.multiSel = []; store.selectedRefProp = null;
        store.selectedLight = null; store.selectedRail = null; store.selectedNode = null;
        store.selectedGem = null; store.selectedScreen = null;
        clearReferenceLight();
      }
      store.selectedRefScreen = selected ? { level: level!, screen: screen! } : null;
      if (store.currentMode === 'props') rebuildTools();
    },
    onSelectPaintCell(quad: number | null) { selectPaintCell(quad); },
    onRangeSelectPaintCell(quad) { rangeSelectPaintCells(quad); }, // shift-click: add this quad to the set
    onSelectRefPatch(patch, ref, rot, mirror, surface) { // read-only pick of a reference patch (its tile in the readout)
      store.selectedPaintCell = null;
      store.paintMultiSel = [];
      viewport().setSelectedPaintCell(null);
      viewport().setSelectedPaintCells([]);
      store.selectedRefPatch = patch;
      viewport().setSelectedRefPatch(patch);
      palette().showCell({ ref, surface: surface ?? null, rot, mirror, context: 'terrain',
        source: 'surface', sourceName: `reference · ${parseTexRef(ref).level} · patch ${patch}` });
      library().highlightRef(ref);
      updateCmdSheet();
    },
    onInspectPropTexture(ref, propName, surface, uvEdges) { // paint select mode: a prop click shows the clicked submesh's tile
      if (!ref) { // off-nominal — there's nothing to put in the panel, so this one stays a toast
        toast(propName ? `${propName} — that surface is untextured` : 'that prop surface is untextured', 'warn');
        return;
      }
      // Mirror the reference-patch inspect: drop any cell selection and magnify the tile read-only. Native
      // appearance / animation / mapping facts become labelled Texture Details beneath the Paint action.
      store.selectedPaintCell = null;
      store.paintMultiSel = [];
      store.selectedRefPatch = null;
      viewport().setSelectedPaintCell(null);
      viewport().setSelectedPaintCells([]);
      viewport().setSelectedRefPatch(null);
      const sourceLevel = parseTexRef(ref).level;
      const flipbookFrames = (surface?.frameFiles ?? []).map(name => makeTexRef(sourceLevel, name));
      palette().showCell({ ref, surface: null, rot: 0, mirror: false, context: 'prop',
        source: 'model', sourceName: propName || 'unnamed model',
        uvEdges: uvEdges ?? undefined, // the submesh's UV wireframe over the art
        flipbookFrames: flipbookFrames.length > 1 ? flipbookFrames : undefined,
        flipbookEffect: surface?.flipbook,
        appearance: surface ? (surface.alphaMode
          ? `${surface.alphaMode} (explicit)`
          : surface.blend ? 'alpha pass — reading alpha…' : 'opaque') : undefined,
        priority: surface?.prio,
        scroll: surface?.scroll });
      library().highlightRef(ref);
      // cutout vs translucent is a texture property — refine the appearance line once the alpha is read
      // (cached; usually instant since the art is already loaded). updateCellAppearance drops a stale refine.
      const { level, name: texName } = parseTexRef(ref);
      if (surface?.blend && !surface.alphaMode) void analyzeTextureAlpha(level, texName)
        .then(analysis => palette().updateCellAppearance(ref, alphaAnalysisLabel(analysis, true)));
      updateCmdSheet();
    },
    onPlaceLight(pos: V3) {
      const lights = (store.mdoc.lights ??= []);
      pos[1] += 4; // float the source a little above the clicked ground so it isn't buried
      pos = viewport().snapPoint(pos);
      const placed = newFreeLight(lights, pos);
      lights.push(placed);
      store.selectedLight = placed.id ?? null;
      store.selectedProp = null;
      clearScreenState();
      viewport().setLightArmed(false); // one drop per arm, like nothing else stays armed
      scheduleRebuild();
      rebuildTools();
    },
    onSelectLight(id: string | null) {
      store.selectedLight = id;
      if (id !== null) { store.selectedProp = null; store.multiSel = []; clearScreenState(); clearReferenceLight(); }
      scheduleRebuild();
      if (store.currentMode === 'props') rebuildTools();
    },
    onMoveLight(id: string, pos: V3) {
      const l = store.mdoc.lights?.find(light => light.id === id);
      if (l) l.pos = pos;
      scheduleRebuild();
    },
    onAppendRailNode(pos: V3) {
      if (store.selectedRail === null || !store.mdoc.rails?.[store.selectedRail]) return;
      const rail = store.mdoc.rails[store.selectedRail];
      rail.nodes.push(pos);
      store.selectedNode = null;   // keep the gizmo off the last node so it doesn't intercept the next placing click
      scheduleRebuild();
      rebuildTools();        // node count changed
    },
    onSelectRailNode(rail: number | null, node: number | null) {
      store.selectedRail = rail;
      store.selectedNode = node;
      if (rail !== null) {
        store.selectedProp = null; store.selectedLight = null; store.multiSel = []; store.railDrawing = false;
        clearScreenState();
        clearReferenceLight();
      } // picking a node stops drawing
      scheduleRebuild();
      if (store.currentMode === 'props') rebuildTools();
    },
    onMoveRailNode(rail: number, node: number, pos: V3) {
      const r = store.mdoc.rails?.[rail];
      if (r?.nodes[node]) r.nodes[node] = pos;
      scheduleRebuild();
    },
    onPlaceGem(pos: V3) {
      const gems = (store.mdoc.gems ??= []);
      const placed: Gem = { id: nextGemId(gems), pos, value: gemTool.value };
      gems.push(placed);
      store.selectedGem = placed.id ?? null;
      clearScreenState();
      scheduleRebuild();
      rebuildTools();
    },
    onPlaceGemLine(a: V3, b: V3) {
      const gems = (store.mdoc.gems ??= []);
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      const n = Math.max(1, Math.round(len / Math.max(0.5, gemTool.spacing))); // segments → n+1 gems, endpoints included
      let last = '';
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const pos = viewport().snapPoint([a[0] + dx * t, a[1] + dy * t, a[2] + dz * t]);
        const key = pos.join(',');
        if (key === last) continue; // coarse snap steps can collapse adjacent samples; place one gem there
        last = key;
        gems.push({ id: nextGemId(gems), pos, value: gemTool.value });
      }
      store.selectedGem = gems[gems.length - 1]?.id ?? null;
      clearScreenState();
      scheduleRebuild();
      rebuildTools();
    },
    onSelectGem(id: string | null) {
      store.selectedGem = id;
      if (id !== null) {
        store.selectedProp = null; store.selectedLight = null; store.multiSel = []; store.selectedRail = null;
        store.selectedNode = null; store.railDrawing = false; viewport().setRailArmed(false); store.trickTool = 'gem';
        clearScreenState();
        clearReferenceLight();
      }
      scheduleRebuild();
      if (store.currentMode === 'props') rebuildTools();
    },
    onMoveGem(id: string, pos: V3) {
      const g = store.mdoc.gems?.find(gem => gem.id === id);
      if (g) g.pos = pos;
      scheduleRebuild();
    },
    onSelectScreen(id: string | null) {
      store.selectedScreen = id;
      store.selectedRefScreen = null;
      if (id !== null) {
        store.selectedProp = null; store.selectedLight = null; store.multiSel = []; store.selectedRail = null;
        store.selectedNode = null; store.selectedGem = null; store.railDrawing = false;
        clearReferenceLight();
      }
      scheduleRebuild();
      if (store.currentMode === 'props') rebuildTools();
    },
    onMoveScreen(id: string, pos: V3) {
      const screen = store.mdoc.screens?.find(s => s.id === id);
      if (!screen) return;
      // The gizmo reports a WORLD centre; an attached screen is stored in its board's own frame, so the move
      // is expressed back through the prop it rides — otherwise dragging a screen would silently detach it
      // from the board that carries it.
      const prop = screenProp(screen, store.mdoc.props);
      screen.pos = prop
        ? scaleV3(unrotateByPlacement(subV3(pos, prop.pos), prop), 1 / (prop.scale || 1))
        : pos;
      scheduleRebuild();
    },
    onSelectReference() { selectScene('info'); }, // clicked the reference in 3D: show the shared Reference card
    onMoveReference() { persistRef(); }, // dragged the reference to a new place: save the offset
    onSelectMountain() { // view mode: clicked the terrain body -> select the Mountain item in the scene tree
      store.selected = null;
      store.selectedKnots = [];
      selectScene('info');
      refreshSelection();
      scheduleRebuild(); // clear any knot highlight in 3D
    },
    onPlayClick(world) { play().clickSlope(world); }, // Test mode: drop an AI rider, or place the ride start
  };
}
