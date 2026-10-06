import type { AuthoredTrail, PathHandles, QuadMeshDoc, TrailKnotSettings, TrailSettings, V3 } from '../../core/doc/types';
import { withoutPathNode } from '../../core/rails/rails';
import { nameIndex, nextTrailId } from '../../core/doc/ids';
import {
  cutTrail, removeTrailPatches, resolveTrail, setTrailKnotValue, trailIsConnected, trailKnotStations, trailOwningQuad,
  withoutTrailKnot, type TrailKnotSettingsList,
} from '../../core/mesh/trail-object';
import type { TrailStation } from '../../core/mesh/trail';
import type { Store } from '../state/store';
import { commitEditMesh } from './mesh-target';
import type { EditViewportPort } from './viewport-port';
import { toast } from '../ui/components/toast';

/**
 * Owned trails in Edit mode (docs/023): the app half of a centre spline that keeps the ribbon it cut.
 *
 * Create Trail draws like a rail — a click per knot, and the knots stay live: a click on one picks it up to drag
 * while the trail is still being laid. From its second knot the trail is in the document, patches and all, and
 * every change to a knot or a setting re-cuts it (`cutTrail`), so the patches are never edited on their own: a
 * click on one selects the whole trail, and **dissolve** is the way out for hand work on the patches.
 *
 * The SELECTED trail is not stored: it is the one being drawn, or else the one whose patches are exactly the
 * patch selection. Any other selection is therefore already "not the trail", with nothing to clear. Only the
 * knot carrying the gizmo is kept, in `store.trailKnot`; with none, a finished trail carries the gizmo itself and
 * moves, turns or scales as a unit (`transformTrail`).
 */

export type TrailToolDeps = {
  store: Store;
  viewport: () => EditViewportPort;
  applyCage: () => void;
  persistUi: () => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  exitRegion: () => void;
  seatMoveGizmo: () => void;
  resetGizmoMode: () => void;
};

/** A trail's settings and the store's new-trail defaults they mirror. */
const STORE_KEYS = {
  widthM: 'trailWidth', centerBias: 'trailCenterBias', dishPercent: 'trailDishPercent', patchLengthM: 'trailPatchLength',
  maxTurnDegrees: 'trailMaxTurnDegrees', bankGainM: 'trailBankGain', maxBankDegrees: 'trailMaxBankDegrees',
  mesaTextures: 'trailMesaTextures',
} as const satisfies Record<keyof TrailSettings, keyof Store>;

export interface TrailStatus {
  knots: number;
  spans: number;
  patches: number;
  /** Other patches share its vertices, so its patch count is held. */
  connected: boolean;
  /** Something cut into its ribbon; it can only be dissolved or deleted. */
  broken: boolean;
  /** Not in the document yet: it has fewer than two knots. */
  draft: boolean;
}

export function createTrailTools(deps: TrailToolDeps) {
  const {
    store, viewport: getViewport, applyCage, persistUi, scheduleRebuild, rebuildTools, updateCmdSheet,
    exitRegion, seatMoveGizmo, resetGizmoMode,
  } = deps;
  const view = () => getViewport();

  /** The trail being drawn, by id — in the document once it has two knots, until then `draft`. */
  let drawingId: string | null = null;
  let draft: AuthoredTrail | null = null;
  /** Which end of the trail being drawn new knots go on: a trail resumed from its first knot grows backward. */
  let drawEnd: 'start' | 'end' = 'end';
  /** A knot drag cuts every frame from the document as it stood when the drag began, so the frames do not
   *  pile up each other's minted and retired ids: what lands is always one cut of the base. */
  let drag: { base: QuadMeshDoc; trail: AuthoredTrail } | null = null;
  let pendingMove: { trail: AuthoredTrail; base: QuadMeshDoc } | null = null;
  let moveFrame = 0;
  let lastError: string | null = null;
  /** The cell highlight is drawn from names, so it is refreshed on the render after a cut has landed. */
  let cellsStale = false;

  const docTrails = (): readonly AuthoredTrail[] => store.modelEditId ? [] : store.mdoc.trails ?? [];
  const inDoc = (trail: AuthoredTrail) => docTrails().some(other => other.id === trail.id);

  function drawingTrail(): AuthoredTrail | null {
    if (store.surgeryTool !== 'trail' || drawingId === null) { drawingId = null; draft = null; return null; }
    return docTrails().find(trail => trail.id === drawingId) ?? (draft?.id === drawingId ? draft : null);
  }

  /** The trail whose patches are exactly the patch selection. */
  function trailOfSelection(): AuthoredTrail | null {
    const cells = store.cellSel;
    if (!cells.length) return null;
    const selected = new Set(cells);
    return docTrails().find(trail => trail.quads.length === selected.size && trail.quads.every(id => selected.has(id))) ?? null;
  }

  /** The trail the panel and the knot handles are about: the one being drawn, or the selected one. */
  function selectedTrail(): AuthoredTrail | null {
    if (store.currentMode !== 'edit') return null;
    return drawingTrail() ?? trailOfSelection();
  }

  /** The trail owning the patch at `quad` in the edited mountain, if any. */
  function trailAtQuad(quad: number): AuthoredTrail | null {
    return store.modelEditId ? null : trailOwningQuad(store.mdoc, store.mdoc.trails, quad) ?? null;
  }

  /** Every vertex any trail owns, as live indices: the ones a move can only reach through a trail's knots. */
  function trailVertexIndices(): Set<number> {
    const at = nameIndex(store.mdoc.vertexIds), out = new Set<number>();
    for (const trail of docTrails()) for (const id of trail.vertices) {
      const vertex = at.get(id);
      if (vertex !== undefined) out.add(vertex);
    }
    return out;
  }

  /** Patch names, with every trail any of them belongs to added whole — how a box selects trails. */
  function withWholeTrails(names: readonly string[]): string[] {
    const caught = new Set(names);
    const out = new Set(names);
    for (const trail of docTrails()) if (trail.quads.some(id => caught.has(id))) for (const id of trail.quads) out.add(id);
    return [...out];
  }

  /** Push the shown trail's knots to the viewport. Called on every Tools rebuild and every render, which between
   *  them follow every selection change and every document change. Only a render (`rendered`) lands a cut's cell
   *  highlight: the highlight resolves names on the drawn mesh, which is the new one only once it has rendered. */
  function syncTrailView(rendered = false) {
    const trail = selectedTrail();
    if (!trail) store.trailKnot = null;
    // A knot whose Bézier handle holds the gizmo leaves it there (app/paths/handles.ts).
    const knot = trail && store.trailKnot !== null && store.trailKnot < trail.knots.length
      && store.pathHandle?.family !== 'trail' ? store.trailKnot : null;
    // No knot picked on a finished trail: the gizmo is the whole trail's, at the centre of its ribbon — where a
    // patch selection's gizmo would sit. Not while drawing, when a click on the ribbon lays the next knot.
    const whole = !!trail && store.trailKnot === null && !drawingTrail() && inDoc(trail);
    view().setTrailKnots(trail?.knots ?? [], knot, trail?.handles, whole ? ribbonCentre(trail) : null);
    if (rendered && cellsStale) { cellsStale = false; view().refreshEditCells(); seatMoveGizmo(); }
  }

  /** The mean of a trail's own vertices as they stand, or of its knots if its ribbon cannot be found. */
  function ribbonCentre(trail: AuthoredTrail): V3 {
    const owned = resolveTrail(store.mdoc, trail);
    const points: V3[] = owned
      ? owned.vertices.map(v => [store.mdoc.vertices[v * 3], store.mdoc.vertices[v * 3 + 1], store.mdoc.vertices[v * 3 + 2]])
      : trail.knots;
    const sum = points.reduce<V3>((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
    return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
  }

  function status(): TrailStatus | null {
    const trail = selectedTrail();
    if (!trail) return null;
    const owned = inDoc(trail) ? resolveTrail(store.mdoc, trail) : null;
    return {
      knots: trail.knots.length,
      spans: trail.quads.length / 2,
      patches: trail.quads.length,
      connected: !!owned && trailIsConnected(store.mdoc, owned),
      broken: inDoc(trail) && !owned,
      draft: !inDoc(trail),
    };
  }

  const error = () => lastError;

  // ---- cutting ------------------------------------------------------------------------------------------------

  /**
   * Cut `next` into `base` and install the result: the new mesh, the trail in its list, and the trail's patches
   * as the patch selection. A cut the generator refuses changes nothing; its reason is kept for the panel and,
   * unless `quiet`, said at once.
   */
  function apply(next: AuthoredTrail, base: QuadMeshDoc = store.mdoc, quiet = false): boolean {
    const cut = cutTrail(base, next);
    if (!cut.ok) {
      lastError = cut.error;
      if (!quiet) toast(cut.error, 'err');
      return false;
    }
    lastError = null;
    const trails = [...(base.trails ?? [])];
    const at = trails.findIndex(trail => trail.id === next.id);
    if (at >= 0) trails[at] = cut.trail; else trails.push(cut.trail);
    cut.doc.trails = trails;
    if (draft?.id === next.id) draft = null;
    commitEditMesh(store, cut.doc);
    store.cellSel = [...cut.trail.quads];
    store.anchorCell = cut.trail.quads[0] ?? null;
    cellsStale = true;
    scheduleRebuild();
    return true;
  }

  /** The trail with these handles, the field dropped once nothing is overridden. */
  function withHandles(trail: AuthoredTrail, handles: readonly (PathHandles | null)[] | undefined): AuthoredTrail {
    const next = { ...trail };
    if (handles?.length) next.handles = [...handles]; else delete next.handles;
    return next;
  }

  /** The trail with these knot values, the field dropped once no knot has any. */
  function withKnotSettings(trail: AuthoredTrail, list: TrailKnotSettingsList): AuthoredTrail {
    const next = { ...trail };
    if (list?.some(Boolean)) next.knotSettings = list.map(entry => entry ?? null); else delete next.knotSettings;
    return next;
  }

  /** Give a trail new knots (and the handles and knot values index-parallel with them): re-cut while it has two,
   *  and while it has fewer take it out of the mesh — a trail being drawn goes back to a draft, any other is gone. */
  function setKnots(trail: AuthoredTrail, knots: V3[], handles = trail.handles, knotSettings = trail.knotSettings): boolean {
    const next = withKnotSettings(withHandles({ ...trail, knots }, handles?.slice(0, knots.length)),
      knotSettings?.slice(0, knots.length));
    if (knots.length >= 2) return apply(next);
    if (inDoc(trail)) removeTrail(trail);
    if (drawingId === trail.id) draft = { ...next, vertices: [], quads: [] };
    return true;
  }

  /** Take a trail and its patches out of the document. */
  function removeTrail(trail: AuthoredTrail) {
    const doc = removeTrailPatches(store.mdoc, trail);
    doc.trails = (store.mdoc.trails ?? []).filter(other => other.id !== trail.id);
    commitEditMesh(store, doc);
    store.cellSel = [];
    store.anchorCell = null;
    store.trailKnot = null;
    cellsStale = true;
    scheduleRebuild();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  function settingsFromStore(): TrailSettings {
    return Object.fromEntries(Object.entries(STORE_KEYS).map(([key, storeKey]) => [key, store[storeKey]])) as unknown as TrailSettings;
  }

  function beginDrawing(id: string, end: 'start' | 'end' = 'end') {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    drawEnd = end;
    view().setTrailDrawEnd(end);
    store.selectedCorner = null; store.selected = null;
    store.surgeryTool = 'trail'; store.createPatchQuads = [];
    store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    store.trailKnot = null;
    drawingId = id;
    view().setWeldTool(false);
    view().setCreateTrailSurfaceLift(store.trailSurfaceLift);
    view().setSurgeryTool('trail');
    syncTrailView();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  /** Arm Create Trail: a fresh trail whose knots the next clicks lay. */
  function armCreateTrail() {
    if (store.modelEditId) { toast('Create Trail builds mountain terrain, not a prop model.', 'err'); return; }
    exitRegion();
    resetGizmoMode();
    draft = { id: nextTrailId(docTrails()), knots: [], settings: settingsFromStore(), vertices: [], quads: [] };
    beginDrawing(draft.id);
    toast('click centre-spline knots · click a knot to move it · Shift axis-locks · Enter finishes', 'info');
  }

  /** The ends "add points" can draw onto, for the selected trail: both with no knot picked, the picked one's
   *  with an end knot picked, and neither with a middle knot picked — that is where a branch will start. */
  function resumeEnds(): ('start' | 'end')[] {
    const trail = trailOfSelection(), knot = store.trailKnot;
    if (!trail) return [];
    if (knot === null) return ['start', 'end'];
    return knot === 0 ? ['start'] : knot === trail.knots.length - 1 ? ['end'] : [];
  }

  /** Lay more knots onto one end of the selected trail (the panel's "add points"): ahead of its first knot, or
   *  after its last. */
  function resumeTrail(end: 'start' | 'end') {
    const trail = trailOfSelection();
    if (!trail || !resumeEnds().includes(end)) return;
    draft = null;
    beginDrawing(trail.id, end);
    toast(`click to add knots to the ${end} of the trail · Enter finishes`, 'info');
  }

  /** A drawing click on no knot: append one there. */
  function appendKnot(pos: V3) {
    const trail = drawingTrail();
    if (!trail) return;
    store.trailKnot = null; // keep the gizmo off the newest knot so it does not catch the next click
    const knot: V3 = [pos[0], pos[1], pos[2]];
    if (drawEnd === 'end') setKnots(trail, [...trail.knots, knot]);
    else {
      // Onto the start: every knot's own handles and values move up one with it.
      const shift = <T>(list: readonly (T | null)[] | undefined): (T | null)[] | undefined =>
        list?.some(Boolean) ? [null, ...list] : undefined;
      setKnots(trail, [knot, ...trail.knots], shift(trail.handles), shift(trail.knotSettings));
    }
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** Backspace while drawing: take the newest knot back off the end being drawn onto. */
  function undoCreateTrailPoint() {
    const trail = drawingTrail();
    if (!trail?.knots.length) return;
    store.trailKnot = null;
    if (drawEnd === 'end') setKnots(trail, trail.knots.slice(0, -1));
    else setKnots(trail, trail.knots.slice(1), withoutPathNode(trail.handles, 0), withoutTrailKnot(trail.knotSettings, 0));
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** Enter / Esc: stop drawing. A trail that never reached two knots was never in the document and is dropped;
   *  one that did stays selected with its knots showing. */
  function finishCreateTrail() {
    if (store.surgeryTool !== 'trail') return;
    const trail = drawingTrail();
    const kept = trail && inDoc(trail) ? trail : null;
    store.surgeryTool = null;
    drawingId = null; draft = null;
    store.trailKnot = null;
    drawEnd = 'end';
    view().setTrailDrawEnd('end');
    view().setSurgeryTool(null);
    if (kept) { store.cellSel = [...kept.quads]; store.anchorCell = kept.quads[0] ?? null; cellsStale = true; }
    syncTrailView();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    if (kept) toast(`trail finished · ${kept.knots.length} knots · ${kept.quads.length} patches — click any of its patches to edit it again`, 'ok');
  }

  /** The old Cancel: with a trail that edits in place, leaving the tool is finishing it. */
  const cancelCreateTrail = finishCreateTrail;

  // ---- editing ------------------------------------------------------------------------------------------------

  function selectKnot(knot: number | null) {
    store.trailKnot = knot;
    store.pathHandle = null; // the knot takes the gizmo back from its handle
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** A knot drag starts or ends. The end lands the last frame and says why, if the trail could not follow. */
  function knotDrag(dragging: boolean) {
    const trail = selectedTrail();
    if (dragging) { drag = trail && inDoc(trail) ? { base: store.mdoc, trail } : null; lastError = null; return; }
    flushMove();
    drag = null;
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    if (lastError) toast(`${lastError} The trail keeps its last shape.`, 'err');
  }

  function flushMove() {
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
    const move = pendingMove;
    pendingMove = null;
    if (move) apply(move.trail, move.base, true);
  }

  /** The selected knot's gizmo moved it. Cuts run once per frame, each from the drag's base document. */
  function moveKnot(knot: number, pos: V3) {
    const trail = drag?.trail ?? selectedTrail();
    if (!trail?.knots[knot]) return;
    const knots = trail.knots.map((p, i): V3 => i === knot ? [pos[0], pos[1], pos[2]] : p);
    if (!inDoc(trail)) { draft = { ...trail, knots }; syncTrailView(); return; }
    pendingMove = { trail: { ...trail, knots }, base: drag?.base ?? store.mdoc };
    if (!drag) { flushMove(); return; }
    moveFrame ||= requestAnimationFrame(() => { moveFrame = 0; flushMove(); });
  }

  /**
   * The whole trail's gizmo moved, turned or scaled it: these are all its knots and dragged handles now. Cut once
   * per frame from the drag's base document, as a knot drag is; a joined trail stretches what is joined to it.
   */
  function transformTrail(knots: V3[], handles: (PathHandles | null)[]) {
    const trail = drag?.trail ?? selectedTrail();
    if (!trail || !inDoc(trail) || knots.length !== trail.knots.length) return;
    pendingMove = { trail: withHandles({ ...trail, knots }, handles), base: drag?.base ?? store.mdoc };
    if (!drag) { flushMove(); return; }
    moveFrame ||= requestAnimationFrame(() => { moveFrame = 0; flushMove(); });
  }

  /**
   * New Bézier handles for the selected trail (app/paths/handles.ts). A `live` change is one frame of a handle
   * drag, cut from the drag's base document like a knot drag's; any other re-cuts the trail as it stands.
   */
  function setTrailHandles(handles: (PathHandles | null)[], live: boolean) {
    const trail = (live ? drag?.trail : null) ?? selectedTrail();
    if (!trail) return;
    const next = withHandles(trail, handles);
    if (!inDoc(trail)) { draft = next; syncTrailView(); return; }
    if (!live || !drag) { apply(next, store.mdoc, live); return; }
    pendingMove = { trail: next, base: drag.base };
    moveFrame ||= requestAnimationFrame(() => { moveFrame = 0; flushMove(); });
  }

  /** Delete the selected knot; a trail left with one knot has nothing to cut and is removed. */
  function deleteSelectedTrailKnot() {
    const trail = selectedTrail(), knot = store.trailKnot;
    if (!trail || knot === null) return;
    store.trailKnot = null;
    const knots = trail.knots.filter((_, i) => i !== knot);
    const drawn = drawingTrail()?.id === trail.id;
    store.pathHandle = null;
    setKnots(trail, knots, withoutPathNode(trail.handles, knot), withoutTrailKnot(trail.knotSettings, knot));
    if (knots.length < 2 && !drawn) toast('trail removed — it needs at least two knots', 'info');
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** A setting changed in the panel: re-cut, and make it the next trail's starting point too. */
  function setTrailSetting<K extends keyof TrailSettings>(key: K, value: TrailSettings[K]) {
    (store as unknown as Record<string, unknown>)[STORE_KEYS[key]] = value;
    const trail = selectedTrail();
    if (!trail) return;
    const next = { ...trail, settings: { ...trail.settings, [key]: value } };
    if (!inDoc(trail)) { draft = next; return; }
    // Quiet: a slider reports every step of a drag, and the panel's banner already says why a cut was refused.
    // No Tools rebuild either, which would tear the slider out from under the pointer.
    apply(next, store.mdoc, true);
  }

  // ---- the selected knot's own section (docs/023 · Per-knot section) -----------------------------------------

  /** The selected knot: its own values, and the station the trail is cut with there (null while it cannot be
   *  cut, or is still a draft). */
  function selectedTrailKnot(): { knot: number; own: TrailKnotSettings; cut: TrailStation | null } | null {
    const trail = selectedTrail(), knot = store.trailKnot;
    if (!trail || knot === null || knot >= trail.knots.length) return null;
    const cut = inDoc(trail) ? trailKnotStations(store.mdoc, trail)?.[knot] ?? null : null;
    return { knot, own: { ...(trail.knotSettings?.[knot] ?? {}) }, cut };
  }

  /**
   * Set one of the selected knot's own values, or clear it (`undefined`) so the knot follows the trail again.
   * Quiet and without a Tools rebuild, like `setTrailSetting`: a slider reports every step of its drag.
   */
  function setTrailKnotSetting<K extends keyof TrailKnotSettings>(key: K, value: TrailKnotSettings[K] | undefined) {
    const trail = selectedTrail(), knot = store.trailKnot;
    if (!trail || knot === null || knot >= trail.knots.length) return;
    const next = withKnotSettings(trail, setTrailKnotValue(trail.knotSettings, trail.knots.length, knot, key, value));
    if (!inDoc(trail)) { draft = next; return; }
    apply(next, store.mdoc, true);
  }

  /** Put the selected knot back on the trail's own settings. */
  function resetTrailKnotSettings() {
    const trail = selectedTrail(), knot = store.trailKnot;
    if (!trail || knot === null || !trail.knotSettings?.[knot]) return;
    const next = withKnotSettings(trail, trail.knotSettings.map((entry, i) => i === knot ? null : entry));
    if (!inDoc(trail)) draft = next; else apply(next);
    rebuildTools();
  }

  /** Delete the selected trail with every patch it owns. */
  function deleteSelectedTrail() {
    const trail = selectedTrail();
    if (!trail) return;
    if (drawingTrail()?.id === trail.id) { draft = null; finishCreateTrail(); }
    if (inDoc(trail)) removeTrail(trail);
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    toast('trail and its patches deleted', 'ok');
  }

  /** Let the patches go: the trail is removed and its patches stay, selected, as ordinary (still locked) mesh. */
  function dissolveSelectedTrail() {
    const trail = trailOfSelection();
    if (!trail) return;
    store.mdoc.trails = (store.mdoc.trails ?? []).filter(other => other.id !== trail.id);
    store.trailKnot = null;
    syncTrailView();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(`trail dissolved — its ${trail.quads.length} patches are ordinary mesh now, still locked (Visibility ▸ unlock to edit them)`, 'ok');
  }

  return {
    selectedTrail, trailAtQuad, trailOfSelection, trailVertexIndices, withWholeTrails, syncTrailView, trailStatus: status, trailError: error,
    armCreateTrail, resumeTrail, resumeEnds, trailDrawEnd: () => drawEnd, appendKnot, undoCreateTrailPoint, finishCreateTrail, cancelCreateTrail,
    selectKnot, knotDrag, moveKnot, transformTrail, setTrailHandles, deleteSelectedTrailKnot, setTrailSetting, deleteSelectedTrail, dissolveSelectedTrail,
    selectedTrailKnot, setTrailKnotSetting, resetTrailKnotSettings,
  };
}

export type TrailTools = ReturnType<typeof createTrailTools>;
