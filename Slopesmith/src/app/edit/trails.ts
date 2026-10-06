import type { AuthoredTrail, PathHandles, QuadMeshDoc, TrailBranch, TrailKnotSettings, TrailSettings, V3 } from '../../core/doc/types';
import { withoutPathNode } from '../../core/rails/rails';
import { nameIndex, nextTrailId } from '../../core/doc/ids';
import {
  branchEndpoints, branchesWithKnotAt, branchesWithoutKnot, cutTrail, joinBranch, mergeTrailInto, removeTrailPatches, resolveTrail, setTrailKnotValue, trailAllKnots,
  trailIsConnected, trailKnotRef, trailKnotStations, trailOwningQuad, trailPreview, withoutTrailKnot,
  type TrailKnotSettingsList,
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
 *
 * A trail's BRANCHES (docs/023 · Branches) are drawn like the trail is, from a middle knot, and are the trail's
 * own: its patches, its selection, its re-cut. Their knots follow the trail's in one list (`trailAllKnots`), so a
 * `store.trailKnot` past the trail's own knots is a branch knot. While a trail is drawn, every hover ghosts what
 * the click there would lay (`trailPreview`).
 *
 * MERGING (docs/023 · Merging): an end of a trail laid, or dropped, on another trail's knot joins the two — end to
 * end on one of its ends, as a branch on a middle knot — and the other trail takes it in (`mergeTrailInto`). A new
 * trail's first knot laid on another's just goes on drawing that one, from there. A branch's free tip lands the
 * same way (`joinBranch`): on a knot of its own trail it rejoins it, and on another trail's end that trail goes on
 * as the rest of the branch.
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
  branches: number;
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
  /** Where the trail being drawn grows: onto an end — a trail resumed from its first knot grows backward — or
   *  onto the branch leaving one of its knots, which the first click there lays. */
  let drawTarget: { end: 'start' | 'end' } | { branch: number } = { end: 'end' };
  /** The ghost: the hover it is for, the frame that draws it, and why there is none, when the cut refuses. */
  let previewAt: V3 | null = null;
  let previewFrame = 0;
  let previewError: string | null = null;
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
    const knots = trail ? trailAllKnots(trail) : [];
    // A knot whose Bézier handle holds the gizmo leaves it there (app/paths/handles.ts).
    const knot = trail && store.trailKnot !== null && store.trailKnot < knots.length
      && store.pathHandle?.family !== 'trail' ? store.trailKnot : null;
    // No knot picked on a finished trail: the gizmo is the whole trail's, at the centre of its ribbon — where a
    // patch selection's gizmo would sit. Not while drawing, when a click on the ribbon lays the next knot.
    const whole = !!trail && store.trailKnot === null && !drawingTrail() && inDoc(trail);
    // A branch that rejoins the trail runs on to the knot it rejoins.
    const branches = (trail?.branches ?? []).map(branch =>
      [trail!.knots[branch.knot], ...branch.knots, ...(branch.to !== undefined && trail!.knots[branch.to] ? [trail!.knots[branch.to]] : [])]);
    let draw: { end: 'start' | 'end' } | { branch: number } = 'end' in drawTarget ? drawTarget : { end: 'end' };
    if (trail && 'branch' in drawTarget) {
      const junction = drawTarget.branch;
      const at = (trail.branches ?? []).findIndex(branch => branch.knot === junction);
      // A branch not laid yet is its junction alone, so the guide runs from there to the cursor.
      if (at < 0 && trail.knots[junction]) branches.push([trail.knots[junction]]);
      draw = { branch: at < 0 ? branches.length - 1 : at };
    }
    // Knots catch the end or branch tip being drawn, or the picked one dragged (docs/023 · Merging).
    const snaps = snapTargets(trail).map(target => target.pos);
    view().setTrailKnots(knots, knot, trail?.handles, whole ? ribbonCentre(trail) : null,
      { main: trail?.knots.length ?? 0, branches, draw, snaps });
    if (rendered && cellsStale) { cellsStale = false; view().refreshEditCells(); seatMoveGizmo(); }
  }

  // ---- merging -------------------------------------------------------------------------------------------------

  type SnapTarget = { trail: AuthoredTrail; knot: number; pos: V3 };

  type Landing = { kind: 'end'; end: 'start' | 'end' } | { kind: 'branch'; junction: number };

  /** What of the selected trail can land on a knot now: the end being drawn onto, the free tip of the branch being
   *  drawn, or the picked end knot or free branch tip, about to be dragged. */
  function landing(): Landing | null {
    const trail = selectedTrail();
    if (!trail) return null;
    if (drawingTrail()) {
      if ('end' in drawTarget) return { kind: 'end', end: drawTarget.end };
      const junction = drawTarget.branch;
      return trail.branches?.find(branch => branch.knot === junction)?.to !== undefined ? null : { kind: 'branch', junction };
    }
    const role = selectedKnotRole();
    if (role?.kind === 'trail' && role.end) return { kind: 'end', end: role.end };
    if (role?.kind === 'branch' && role.tip) return { kind: 'branch', junction: role.junction };
    return null;
  }

  /**
   * The knots what is landing may join. A trail END joins other trails: their ends, and — while it has no branches of
   * its own to lose by becoming one — their middle knots no branch uses. A branch TIP rejoins its own trail at a knot
   * no branch uses, or runs on into another trail from that trail's end.
   */
  function snapTargets(trail: AuthoredTrail | null, mode = landing()): SnapTarget[] {
    if (!trail || !mode) return [];
    const others = docTrails().filter(other => other.id !== trail.id);
    if (mode.kind === 'branch') {
      const used = branchEndpoints(trail);
      const own = trail.knots.flatMap((pos, knot) => knot === mode.junction || used.has(knot) ? [] : [{ trail, knot, pos }]);
      const ends = others.filter(other => !other.branches?.length)
        .flatMap(other => [0, other.knots.length - 1].map(knot => ({ trail: other, knot, pos: other.knots[knot] })));
      return [...own, ...ends];
    }
    return others.flatMap(other => {
      const used = branchEndpoints(other);
      return other.knots.flatMap((pos, knot) => {
        const end = knot === 0 || knot === other.knots.length - 1;
        return !end && (trail.branches?.length || used.has(knot)) ? [] : [{ trail: other, knot, pos }];
      });
    });
  }

  /** The knot at exactly `pos` — where the viewport snapped a knot — if what is landing may join it. */
  const targetAt = (trail: AuthoredTrail, pos: readonly number[], mode = landing()): SnapTarget | null =>
    snapTargets(trail, mode).find(target => Math.hypot(target.pos[0] - pos[0], target.pos[1] - pos[1], target.pos[2] - pos[2]) < 1e-6) ?? null;

  /**
   * Land the free tip of `trail`'s branch leaving `junction` on `target` (`joinBranch`): rejoining the trail, or
   * running on into another, which is taken out with its patches — one document, one history step.
   */
  function landBranch(trail: AuthoredTrail, junction: number, target: SnapTarget): boolean {
    const index = trail.branches?.findIndex(branch => branch.knot === junction) ?? -1;
    const joined = joinBranch(trail, index, target);
    if (!joined.ok) { lastError = joined.error; toast(joined.error, 'err'); return false; }
    const absorbed = joined.joined === 'extend' ? target.trail : null;
    const base = absorbed
      ? { ...removeTrailPatches(store.mdoc, absorbed), trails: (store.mdoc.trails ?? []).filter(other => other.id !== absorbed.id) }
      : store.mdoc;
    if (!apply(joined.trail, base)) return false;
    store.trailKnot = null;
    toast(absorbed
      ? 'the other trail goes on as the rest of the branch — cut with this trail\'s settings'
      : `the branch rejoins the trail at knot ${target.knot + 1} — a junction at each end`, 'ok');
    return true;
  }

  /**
   * Join `trail`, whose `end` lies on `target`, into the trail `target` is on, and take `trail` and its patches out —
   * one document, one history step. Refused with its reason, changing nothing.
   */
  function mergeInto(trail: AuthoredTrail, end: 'start' | 'end', target: SnapTarget): boolean {
    const merged = mergeTrailInto(target.trail, target.knot, trail, end);
    if (!merged.ok) { lastError = merged.error; toast(merged.error, 'err'); return false; }
    const base = inDoc(trail)
      ? { ...removeTrailPatches(store.mdoc, trail), trails: (store.mdoc.trails ?? []).filter(other => other.id !== trail.id) }
      : store.mdoc;
    if (!apply(merged.trail, base)) return false;
    store.trailKnot = null;
    toast(merged.joined === 'branch'
      ? `joined as a branch at knot ${target.knot + 1} of the other trail — a three-way junction, cut with that trail's settings`
      : 'joined end to end into one trail — it keeps the other trail\'s settings, and these knots their own section', 'ok');
    return true;
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
      branches: trail.branches?.length ?? 0,
      spans: trail.network ? trail.network.runSpans.reduce((sum, spans) => sum + spans, 0) : trail.quads.length / 2,
      patches: trail.quads.length,
      connected: !!owned && trailIsConnected(store.mdoc, owned),
      broken: inDoc(trail) && !owned,
      draft: !inDoc(trail),
    };
  }

  /** Why the last change was refused — or, while drawing, why the knot under the cursor could not be laid. */
  const error = () => lastError ?? (previewError ? `Not here: ${previewError}` : null);

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

  /** The trail with these branches, the field dropped once it has none. */
  function withBranches(trail: AuthoredTrail, branches: readonly TrailBranch[] | undefined): AuthoredTrail {
    const next = { ...trail };
    if (branches?.length) next.branches = [...branches].sort((a, b) => a.knot - b.knot); else delete next.branches;
    return next;
  }

  /** Give a trail new knots (and the handles, knot values and branches that go with them): re-cut while it has
   *  two, and while it has fewer take it out of the mesh — a trail being drawn goes back to a draft, any other is
   *  gone. */
  function setKnots(trail: AuthoredTrail, knots: V3[], handles = trail.handles, knotSettings = trail.knotSettings,
    branches = trail.branches): boolean {
    const next = withBranches(withKnotSettings(withHandles({ ...trail, knots }, handles?.slice(0, knots.length)),
      knotSettings?.slice(0, knots.length)), branches?.filter(branch => branch.knot < knots.length));
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

  function beginDrawing(id: string, target: { end: 'start' | 'end' } | { branch: number } = { end: 'end' }) {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    drawTarget = target;
    previewAt = null; previewError = null;
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

  /** What the picked knot of the selected trail is, for the panel's actions: one of the trail's own — an end, or a
   *  middle knot that can carry a branch or carries one — or one of a branch's, and whether it is that branch's
   *  tip. */
  function selectedKnotRole():
    | { kind: 'trail'; knot: number; end: 'start' | 'end' | null; branch: boolean }
    | { kind: 'branch'; junction: number; knot: number; of: number; tip: boolean; rejoins: boolean }
    | null {
    const trail = selectedTrail(), at = store.trailKnot;
    const ref = trail && at !== null ? trailKnotRef(trail, at) : null;
    if (!trail || !ref) return null;
    if (ref.branch !== null) {
      const branch = trail.branches![ref.branch];
      // A branch that rejoins the trail has no free tip: its last knot runs on to the trail.
      const rejoins = branch.to !== undefined;
      return { kind: 'branch', junction: branch.knot, knot: ref.knot, of: branch.knots.length, rejoins,
        tip: !rejoins && ref.knot === branch.knots.length - 1 };
    }
    const last = trail.knots.length - 1;
    return {
      kind: 'trail', knot: ref.knot, end: ref.knot === 0 ? 'start' : ref.knot === last ? 'end' : null,
      branch: branchEndpoints(trail).has(ref.knot),
    };
  }

  /** The ends "add points" can draw onto, for the selected trail: both with no knot picked, the picked one's
   *  with an end knot picked, and neither with a middle knot or a branch's knot picked. */
  function resumeEnds(): ('start' | 'end')[] {
    if (!trailOfSelection()) return [];
    if (store.trailKnot === null) return ['start', 'end'];
    const role = selectedKnotRole();
    return role?.kind === 'trail' && role.end ? [role.end] : [];
  }

  /** Lay more knots onto one end of the selected trail (the panel's "add points"): ahead of its first knot, or
   *  after its last. */
  function resumeTrail(end: 'start' | 'end') {
    const trail = trailOfSelection();
    if (!trail || !resumeEnds().includes(end)) return;
    draft = null;
    beginDrawing(trail.id, { end });
    toast(`click to add knots to the ${end} of the trail · Enter finishes`, 'info');
  }

  /** Lay a branch off the picked middle knot of the selected trail (the panel's "add a branch"), or more knots onto
   *  the branch whose tip is picked. Its first click lays the branch and the junction where it meets the trail. */
  function armBranch() {
    const trail = trailOfSelection(), role = selectedKnotRole();
    if (!trail || !role) return;
    let junction: number;
    if (role.kind === 'trail' && role.end === null && !role.branch) junction = role.knot;
    else if (role.kind === 'branch' && role.tip) junction = role.junction;
    else return;
    draft = null;
    beginDrawing(trail.id, { branch: junction });
    toast(role.kind === 'trail'
      ? 'click to lay the branch · the ghost shows the junction it makes · Enter finishes'
      : 'click to add knots to the branch · Enter finishes', 'info');
  }

  /** Take the picked knot's branch off the trail. */
  function removeBranch() {
    const trail = trailOfSelection(), role = selectedKnotRole();
    if (!trail || role?.kind !== 'trail' || !role.branch) return;
    // The branch leaving this knot, or rejoining at it.
    if (apply(withBranches(trail, trail.branches!.filter(branch => branch.knot !== role.knot && branch.to !== role.knot))))
      toast('branch removed — the trail runs through its knot again', 'ok');
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** The knot being drawn added to `trail` at `pos`: the trail as the next click would make it. */
  function withNextKnot(trail: AuthoredTrail, pos: V3): AuthoredTrail {
    const knot: V3 = [pos[0], pos[1], pos[2]];
    if ('branch' in drawTarget) {
      const junction = drawTarget.branch;
      const branches = [...(trail.branches ?? [])];
      const at = branches.findIndex(branch => branch.knot === junction);
      if (at >= 0) branches[at] = { ...branches[at], knots: [...branches[at].knots, knot] };
      else branches.push({ knot: junction, knots: [knot] });
      return withBranches(trail, branches);
    }
    if (drawTarget.end === 'end') return { ...trail, knots: [...trail.knots, knot] };
    // Onto the start: every knot's own handles, values and branch move up one with it.
    const shift = <T>(list: readonly (T | null)[] | undefined): (T | null)[] | undefined =>
      list?.some(Boolean) ? [null, ...list] : undefined;
    return withBranches(withKnotSettings(withHandles({ ...trail, knots: [knot, ...trail.knots] }, shift(trail.handles)),
      shift(trail.knotSettings)), branchesWithKnotAt(trail.branches, 0));
  }

  /**
   * A knot laid on another trail's knot. A new trail's first knot there goes on drawing that trail instead — on from
   * its end, or as a branch from a middle knot; any later one joins the two trails and ends the drawing.
   */
  function joinAt(trail: AuthoredTrail, end: 'start' | 'end', target: SnapTarget, pos: V3) {
    if (!trail.knots.length) {
      const last = target.trail.knots.length - 1;
      draft = null;
      store.cellSel = [...target.trail.quads];
      store.anchorCell = target.trail.quads[0] ?? null;
      beginDrawing(target.trail.id, target.knot === 0 ? { end: 'start' } : target.knot === last ? { end: 'end' } : { branch: target.knot });
      toast(target.knot === 0 || target.knot === last
        ? 'drawing on from the end of that trail · Enter finishes' : 'drawing a branch from that knot · Enter finishes', 'info');
      return;
    }
    if (mergeInto(withNextKnot(trail, pos), end, target)) endDrawing();
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** A drawing click on no knot: lay one there. */
  function appendKnot(pos: V3) {
    const trail = drawingTrail();
    if (!trail) return;
    store.trailKnot = null; // keep the gizmo off the newest knot so it does not catch the next click
    previewAt = null; previewError = null;
    const target = targetAt(trail, pos);
    if (target && 'end' in drawTarget) { joinAt(trail, drawTarget.end, target, pos); return; }
    if (target && 'branch' in drawTarget) {
      // The branch's next knot on a knot it can join: lay it there, land the tip, and stop drawing.
      if (landBranch(withNextKnot(trail, pos), drawTarget.branch, target)) endDrawing();
      syncTrailView();
      rebuildTools(); updateCmdSheet();
      return;
    }
    const next = withNextKnot(trail, pos);
    if ('branch' in drawTarget) apply(next);
    else setKnots(trail, next.knots, next.handles, next.knotSettings, next.branches);
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** Backspace while drawing: take the newest knot back off the end, or the branch, being drawn onto. */
  function undoCreateTrailPoint() {
    const trail = drawingTrail();
    if (!trail?.knots.length) return;
    store.trailKnot = null;
    if ('branch' in drawTarget) {
      const junction = drawTarget.branch;
      const branch = trail.branches?.find(entry => entry.knot === junction);
      if (!branch) return;
      // Its last knot goes, and with it the branch: back to a branch not laid yet.
      apply(withBranches(trail, (trail.branches ?? []).flatMap(entry => entry !== branch ? [entry]
        : entry.knots.length > 1 ? [{ ...entry, knots: entry.knots.slice(0, -1) }] : [])));
    } else if (drawTarget.end === 'end') {
      const last = trail.knots.length - 1;
      setKnots(trail, trail.knots.slice(0, -1), trail.handles, trail.knotSettings, branchesWithoutKnot(trail.branches, last));
    } else {
      setKnots(trail, trail.knots.slice(1), withoutPathNode(trail.handles, 0), withoutTrailKnot(trail.knotSettings, 0),
        branchesWithoutKnot(trail.branches, 0));
    }
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** The cursor moved while drawing: ghost what a click there would lay, a frame later. */
  function previewHover(pos: V3 | null) {
    previewAt = pos ? [pos[0], pos[1], pos[2]] : null;
    previewFrame ||= requestAnimationFrame(() => { previewFrame = 0; showPreview(); });
  }

  /** Ghost the new and reshaped patches the next knot would cut — the next span, or the branch and the junction
   *  it makes — or say why a knot there would be refused. */
  function showPreview() {
    const trail = drawingTrail();
    let shown: AuthoredTrail | null = null, reason: string | null = null;
    if (trail && previewAt) {
      const next = withNextKnot(trail, previewAt);
      const target = targetAt(trail, previewAt);
      if (target && 'end' in drawTarget) {
        // On another trail's knot: ghost the two joined (a first knot there joins nothing yet).
        const merged = trail.knots.length ? mergeTrailInto(target.trail, target.knot, next, drawTarget.end) : null;
        if (merged?.ok) shown = merged.trail; else if (merged) reason = merged.error;
      } else if (target && 'branch' in drawTarget) {
        // A branch tip on a knot it can join: ghost it rejoining, or running on into the other trail.
        const junction = drawTarget.branch;
        const landed = joinBranch(next, next.branches?.findIndex(branch => branch.knot === junction) ?? -1, target);
        if (landed.ok) shown = landed.trail; else reason = landed.error;
      } else if (next.knots.length >= 2) shown = inDoc(trail) ? next : { ...next, vertices: [], quads: [] };
    }
    const preview = shown ? trailPreview(store.mdoc, shown) : null;
    if (preview && !preview.ok) reason = preview.error;
    // The panel says why a knot here would be refused; its rebuild clears the ghost, so it goes first.
    if (reason !== previewError) { previewError = reason; rebuildTools(); }
    view().setLoftPreview(preview?.ok && preview.quads.length ? preview.quads.map(quad => preview.doc.quads[quad]) : null,
      preview?.ok ? preview.doc : null);
  }

  /** Leave the drawing tool, keeping whatever is selected. */
  function endDrawing() {
    store.surgeryTool = null;
    drawingId = null; draft = null;
    store.trailKnot = null;
    drawTarget = { end: 'end' };
    previewAt = null; previewError = null;
    view().setSurgeryTool(null);
  }

  /** Enter / Esc: stop drawing. A trail that never reached two knots was never in the document and is dropped;
   *  one that did stays selected with its knots showing. */
  function finishCreateTrail() {
    if (store.surgeryTool !== 'trail') return;
    const trail = drawingTrail();
    const kept = trail && inDoc(trail) ? trail : null;
    endDrawing();
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
    const failed = lastError;
    // An end knot dropped on another trail's knot joins the two there; a branch's free tip dropped on a knot it can
    // join lands there.
    const dropped = selectedTrail(), role = selectedKnotRole();
    if (dropped && inDoc(dropped) && !failed && role?.kind === 'trail' && role.end) {
      const target = targetAt(dropped, dropped.knots[role.knot]);
      if (target) mergeInto(dropped, role.end, target);
    } else if (dropped && inDoc(dropped) && !failed && role?.kind === 'branch' && role.tip) {
      const tip = dropped.branches?.find(branch => branch.knot === role.junction)?.knots.at(-1);
      const target = tip ? targetAt(dropped, tip) : null;
      if (target) landBranch(dropped, role.junction, target);
    }
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    if (failed) toast(`${failed} The trail keeps its last shape.`, 'err');
  }

  function flushMove() {
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
    const move = pendingMove;
    pendingMove = null;
    if (move) apply(move.trail, move.base, true);
  }

  /** The selected knot's gizmo moved it — one of the trail's own, or a branch's. Cuts run once per frame, each from
   *  the drag's base document. */
  function moveKnot(at: number, pos: V3) {
    const trail = drag?.trail ?? selectedTrail();
    const ref = trail ? trailKnotRef(trail, at) : null;
    if (!trail || !ref) return;
    const p: V3 = [pos[0], pos[1], pos[2]];
    const next = ref.branch === null
      ? { ...trail, knots: trail.knots.map((knot, i): V3 => i === ref.knot ? p : knot) }
      : { ...trail, branches: trail.branches!.map((branch, b) => b !== ref.branch ? branch
        : { ...branch, knots: branch.knots.map((knot, i): V3 => i === ref.knot ? p : knot) }) };
    if (!inDoc(trail)) { draft = next; syncTrailView(); return; }
    pendingMove = { trail: next, base: drag?.base ?? store.mdoc };
    if (!drag) { flushMove(); return; }
    moveFrame ||= requestAnimationFrame(() => { moveFrame = 0; flushMove(); });
  }

  /**
   * The whole trail's gizmo moved, turned or scaled it: these are all its knots and dragged handles now. Cut once
   * per frame from the drag's base document, as a knot drag is; a joined trail stretches what is joined to it.
   */
  function transformTrail(knots: V3[], handles: (PathHandles | null)[]) {
    const trail = drag?.trail ?? selectedTrail();
    if (!trail || !inDoc(trail) || knots.length !== trailAllKnots(trail).length) return;
    // The list is the trail's own knots, then each branch's in turn.
    const own = trail.knots.length;
    let from = own;
    const branches = trail.branches?.map(branch => {
      const moved = knots.slice(from, from + branch.knots.length);
      from += branch.knots.length;
      return { ...branch, knots: moved };
    });
    pendingMove = {
      trail: withHandles({ ...trail, knots: knots.slice(0, own), ...(branches ? { branches } : {}) }, handles.slice(0, own)),
      base: drag?.base ?? store.mdoc,
    };
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

  /** Delete the selected knot. One of the trail's own takes its branch with it, and a trail left with one knot
   *  has nothing to cut and is removed; a branch's last knot takes the branch. */
  function deleteSelectedTrailKnot() {
    const trail = selectedTrail(), at = store.trailKnot;
    const ref = trail && at !== null ? trailKnotRef(trail, at) : null;
    if (!trail || !ref) return;
    store.trailKnot = null;
    store.pathHandle = null;
    if (ref.branch !== null) {
      // A branch keeps going while it has knots, or rejoins the trail (a straight link from knot to knot).
      const branches = trail.branches!.flatMap((branch, b) => {
        if (b !== ref.branch) return [branch];
        const knots = branch.knots.filter((_, i) => i !== ref.knot);
        return knots.length || branch.to !== undefined ? [{ ...branch, knots }] : [];
      });
      if (inDoc(trail)) apply(withBranches(trail, branches)); else draft = withBranches(trail, branches);
    } else {
      const knot = ref.knot;
      const knots = trail.knots.filter((_, i) => i !== knot);
      const drawn = drawingTrail()?.id === trail.id;
      const hadBranch = !!trail.branches?.some(branch => branch.knot === knot);
      setKnots(trail, knots, withoutPathNode(trail.handles, knot), withoutTrailKnot(trail.knotSettings, knot),
        branchesWithoutKnot(trail.branches, knot));
      if (knots.length < 2 && !drawn) toast('trail removed — it needs at least two knots', 'info');
      else if (hadBranch) toast('knot deleted, and the branch it carried with it', 'info');
    }
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
    armCreateTrail, resumeTrail, resumeEnds, armBranch, removeBranch, selectedKnotRole, previewHover,
    trailDrawEnd: () => 'end' in drawTarget ? drawTarget.end : 'end' as const,
    /** The trail knot whose branch is being drawn, or null. */
    drawingBranch: () => drawingTrail() && 'branch' in drawTarget ? drawTarget.branch : null,
    /** The knot the next one is laid from: the end, or the branch tip, being drawn onto. */
    trailDrawAnchor: (): V3 | null => {
      const trail = drawingTrail();
      if (!trail) return null;
      if ('end' in drawTarget) return (drawTarget.end === 'start' ? trail.knots[0] : trail.knots.at(-1)) ?? null;
      const junction = drawTarget.branch;
      return trail.branches?.find(branch => branch.knot === junction)?.knots.at(-1) ?? trail.knots[junction] ?? null;
    },
    appendKnot, undoCreateTrailPoint, finishCreateTrail, cancelCreateTrail,
    selectKnot, knotDrag, moveKnot, transformTrail, setTrailHandles, deleteSelectedTrailKnot, setTrailSetting, deleteSelectedTrail, dissolveSelectedTrail,
    selectedTrailKnot, setTrailKnotSetting, resetTrailKnotSettings,
  };
}

export type TrailTools = ReturnType<typeof createTrailTools>;
