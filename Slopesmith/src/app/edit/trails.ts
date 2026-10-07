import type {
  AuthoredTrail, PathHandles, QuadMeshDoc, TrailKnotSettings, TrailPath, TrailSettings, TrailTileRow, TrailTileSet, V3,
} from '../../core/doc/types';
import { nameIndex, nextTrailId } from '../../core/doc/ids';
import {
  compactTrail, connectedPaths, cutTrail, disconnectPoint, extendPath, fusePathsAt, joinTrails, mergeTrailPoints, pathCuts, pathEndsAt, pathKnots,
  pathsThrough, pointArms, removeTrailPatches, resolveTrail, separateTrail, setTrailKnotValue, splitPathsAt, trailCustomTiles, trailCutShape,
  trailIsConnected, trailOwningQuad, trailPathQuads,
  trailPathStations, trailPreview, trimPath, withNewPoint, withoutTrailPaths, withoutTrailPoint, withPath, type TrailCustomTile,
  type TrailCutOptions, type TrailRenumbering,
} from '../../core/mesh/trail-object';
import type { TrailStation } from '../../core/mesh/trail';
import {
  DEFAULT_TRAIL_TILES, findTrailTileSet, nextTrailTileSetName, TRAIL_TILE_ROWS, trailSettingsTiles, trailTileRowTiles, trailTileSetId,
  trailTileSetsWith, withoutTrailTileMiddle, type TrailTileRowKey,
} from '../../core/mesh/trail-textures';
import { parseTexRef } from '../../core/paint/textures';
import type { Store } from '../state/store';
import { commitEditMesh } from './mesh-target';
import type { EditViewportPort, TrailShape, TrailTransform } from './viewport-port';
import { toast } from '../ui/components/toast';

/**
 * Owned trails in Edit mode (docs/023): the app half of a network of centre splines that keeps the patches it cut.
 *
 * A trail is POINTS and the PATHS through them (docs/023 · Networks), every path alike — its own settings and
 * handles — and a point paths share is where they meet. A click on a trail patch selects the PATH it belongs to;
 * Ctrl-click, a box, Ctrl+A and a double-click take in more, up to the whole network. The selection is not stored:
 * it is the paths whose patches are exactly the patch selection, so any other selection is already "not a trail".
 * The point carrying the gizmo is kept, in `store.trailPoint`; with none, the selected paths carry the gizmo
 * together and move, turn or scale as a unit (`transformTrail`) — dragging along whatever they share a point with.
 *
 * Create Trail draws one path, a click per point, and the points stay live: a click on one picks it up to drag
 * while the path is still being laid. From its second point the path is in the document, patches and all, and
 * every change to a point or a setting re-cuts the trail (`cutTrail`), so the patches are never edited on their
 * own; **dissolve** is the way out for hand work on them. While a path is drawn, every hover ghosts what the click
 * there would lay (`trailPreview`).
 *
 * Joining is one rule: a point laid, or dropped, on another point — any point of any trail, snapped to within a few
 * pixels — becomes that point. The first point of a new trail on a free end goes on drawing that path; on any other
 * point it starts a new path there. A later point there ends the path on it: a fork, a merge, a crossing, a loop.
 * Two trails that come to share a point become one network, and two path ends meeting alone become one path when
 * they are cut alike.
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

/** A path's settings and the store's new-path defaults they mirror. */
const STORE_KEYS = {
  widthM: 'trailWidth', lanes: 'trailLanes', centerBias: 'trailCenterBias', dishPercent: 'trailDishPercent', patchLengthM: 'trailPatchLength',
  maxTurnDegrees: 'trailMaxTurnDegrees', bankGainM: 'trailBankGain', maxBankDegrees: 'trailMaxBankDegrees',
  trailTiles: 'trailTileSet', turnRadiusM: 'trailTurnRadius', caps: 'trailCaps',
} as const satisfies Record<keyof TrailSettings, keyof Store>;

export interface TrailStatus {
  /** Points of the selected paths (or of the path being drawn). */
  points: number;
  /** Paths selected, and in the whole network. */
  paths: number;
  networkPaths: number;
  junctions: number;
  spans: number;
  patches: number;
  /** Other patches share its vertices, so its layout is held. */
  connected: boolean;
  /** Something cut into its patches; it can only be dissolved or deleted. */
  broken: boolean;
  /** Not in the document yet: no path of it has two points. */
  draft: boolean;
}

/** Some of one trail's paths, selected. */
export interface TrailPick { trail: AuthoredTrail; paths: number[] }

/** The trail the panel and the handles are about, the paths of it selected, and the one whose settings and handles
 *  show — null while a new path is about to be laid. */
export interface TrailFocus { trail: AuthoredTrail; paths: number[]; path: number | null }

/** A point of a trail, by the trail's id. */
export type TrailPointRef = { trail: string; point: number };

/** The path being drawn: one of the trail's, growing from one end — or, `path` null, a new one about to be laid from
 *  point `from`. */
type Drawing = { id: string; path: number | null; end: 'start' | 'end'; from: number | null };

type SnapTarget = { trail: AuthoredTrail; point: number; pos: V3 };

export function createTrailTools(deps: TrailToolDeps) {
  const {
    store, viewport: getViewport, applyCage, persistUi, scheduleRebuild, rebuildTools, updateCmdSheet,
    exitRegion, seatMoveGizmo, resetGizmoMode,
  } = deps;
  const view = () => getViewport();

  let drawing: Drawing | null = null;
  /** A trail being drawn that is not in the document yet: no path of it has two points. */
  let draft: AuthoredTrail | null = null;
  /** The ghost: the hover it is for, the frame that draws it, and why there is none, when the cut refuses. */
  let previewAt: V3 | null = null;
  let previewFrame = 0;
  let previewError: string | null = null;
  /** A drag cuts every frame from the document as it stood when the drag began, so the frames do not pile up each
   *  other's minted and retired ids: what lands is always one cut of the base. */
  let drag: { base: QuadMeshDoc; trails: AuthoredTrail[]; picks: TrailPick[] } | null = null;
  let pendingMove: { trails: AuthoredTrail[]; base: QuadMeshDoc } | null = null;
  let moveFrame = 0;
  /** Whether the ghost shows the merge a drag's drop would make now — so ending the drag clears only its own. */
  let dropGhost = false;
  let lastError: string | null = null;
  /** The cell highlight is drawn from names, so it is refreshed on the render after a cut has landed. */
  let cellsStale = false;

  const docTrails = (): readonly AuthoredTrail[] => store.modelEditId ? [] : store.mdoc.trails ?? [];
  const inDoc = (trail: AuthoredTrail) => docTrails().some(other => other.id === trail.id);
  const byId = (id: string) => docTrails().find(trail => trail.id === id) ?? (draft?.id === id ? draft : null);

  function drawingTrail(): AuthoredTrail | null {
    if (store.surgeryTool !== 'trail' || !drawing) { drawing = null; draft = null; return null; }
    return byId(drawing.id);
  }

  /** Each path's patches — or, for a trail that cannot be found, all of them as one. */
  const pathCells = (trail: AuthoredTrail): string[][] =>
    trailPathQuads(store.mdoc, trail) ?? trail.paths.map((_, i) => i === 0 ? [...trail.quads] : []);

  let picksMemo: { cells: readonly string[]; length: number; doc: QuadMeshDoc; trails: unknown; picks: TrailPick[] } | null = null;

  /** The selected paths: whole paths whose patches are, together, exactly the patch selection. */
  function selectionPicks(): TrailPick[] {
    const cells = store.cellSel;
    if (picksMemo && picksMemo.cells === cells && picksMemo.length === cells.length && picksMemo.doc === store.mdoc
      && picksMemo.trails === store.mdoc.trails) return picksMemo.picks;
    let picks: TrailPick[] = [];
    if (cells.length && !store.modelEditId) {
      const selected = new Set(cells);
      let covered = 0;
      for (const trail of docTrails()) {
        if (!trail.quads.some(id => selected.has(id))) continue;
        const lists = pathCells(trail);
        const paths = lists.flatMap((ids, path) => ids.length && ids.every(id => selected.has(id)) ? [path] : []);
        for (const path of paths) covered += lists[path].length;
        if (paths.length) picks.push({ trail, paths });
      }
      if (covered !== selected.size) picks = [];
    }
    picksMemo = { cells, length: cells.length, doc: store.mdoc, trails: store.mdoc.trails, picks };
    return picks;
  }

  /** The path a patch belongs to. */
  function pathOfCell(trail: AuthoredTrail, id: string | null): number | null {
    if (id === null) return null;
    const at = pathCells(trail).findIndex(ids => ids.includes(id));
    return at < 0 ? null : at;
  }

  /** What the panel and the handles are about: the path being drawn, or else the selected paths — of the trail whose
   *  point is picked, or whose patch was clicked last — and of those the one through the picked point, or clicked. */
  function focus(): TrailFocus | null {
    if (store.currentMode !== 'edit') return null;
    const drawn = drawingTrail();
    if (drawn && drawing) return { trail: drawn, paths: drawing.path === null ? [] : [drawing.path], path: drawing.path };
    const picks = selectionPicks();
    if (!picks.length) return null;
    const point = store.trailPoint;
    const pick = (point && picks.find(entry => entry.trail.id === point.trail))
      ?? picks.find(entry => entry.trail.quads.includes(store.anchorCell ?? '')) ?? picks[0];
    const clicked = pathOfCell(pick.trail, store.anchorCell);
    const through = point?.trail === pick.trail.id ? pick.paths.filter(path => pick.trail.paths[path].points.includes(point.point)) : pick.paths;
    const path = clicked !== null && through.includes(clicked) ? clicked : through[0] ?? pick.paths[0];
    return { trail: pick.trail, paths: pick.paths, path };
  }

  /** The trail the panel and the knot handles are about: the one being drawn, or the selected one. */
  const selectedTrail = (): AuthoredTrail | null => focus()?.trail ?? null;

  /** The trail owning the patch at `quad` in the edited mountain, if any. */
  function trailAtQuad(quad: number): AuthoredTrail | null {
    return store.modelEditId ? null : trailOwningQuad(store.mdoc, store.mdoc.trails, quad) ?? null;
  }

  /** The patches of the path the patch at `quad` belongs to — what a click on it selects — or null off a trail. */
  function pathCellsAt(quad: number): string[] | null {
    const trail = trailAtQuad(quad);
    if (!trail) return null;
    const lists = pathCells(trail);
    const path = pathOfCell(trail, store.mdoc.quadIds[quad] ?? null);
    return path === null ? [...trail.quads] : [...lists[path]];
  }

  /** The patches of every path joined to the one at `quad` — a double-click's whole network — or null off a trail. */
  function networkCellsAt(quad: number): string[] | null {
    const trail = trailAtQuad(quad);
    if (!trail) return null;
    const path = pathOfCell(trail, store.mdoc.quadIds[quad] ?? null);
    if (path === null) return [...trail.quads];
    const lists = pathCells(trail);
    return connectedPaths(trail, path).flatMap(index => lists[index]);
  }

  /** Every vertex any trail owns, as live indices: the ones a move can only reach through a trail's points. */
  function trailVertexIndices(): Set<number> {
    const at = nameIndex(store.mdoc.vertexIds), out = new Set<number>();
    for (const trail of docTrails()) for (const id of trail.vertices) {
      const vertex = at.get(id);
      if (vertex !== undefined) out.add(vertex);
    }
    return out;
  }

  /** Patch names, with every path any of them belongs to added whole — how a box selects paths. */
  function withWholePaths(names: readonly string[]): string[] {
    const caught = new Set(names);
    const out = new Set(names);
    for (const trail of docTrails()) {
      if (!trail.quads.some(id => caught.has(id))) continue;
      for (const ids of pathCells(trail)) if (ids.some(id => caught.has(id))) for (const id of ids) out.add(id);
    }
    return [...out];
  }

  /** Grow the selected paths to every path joined to them (Ctrl+A, the panel's button): their whole networks. */
  function selectWholeNetwork(): boolean {
    const picks = selectionPicks();
    if (!picks.length) return false;
    const cells = picks.flatMap(({ trail, paths }) => {
      const lists = pathCells(trail);
      return [...new Set(paths.flatMap(path => connectedPaths(trail, path)))].flatMap(path => lists[path]);
    });
    if (cells.length === store.cellSel.length) return false;
    store.cellSel = cells;
    cellsStale = true;
    syncTrailView();
    view().refreshEditCells();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    return true;
  }

  // ---- what the viewport shows ------------------------------------------------------------------------------

  /** The points the viewport shows, in its order: the path being drawn's (and the point a new path leaves from), or
   *  every point of the selected paths, trail by trail. */
  function shownPoints(): TrailPointRef[] {
    const drawn = drawingTrail();
    if (drawn && drawing) {
      const own = drawing.path === null ? [] : drawn.paths[drawing.path]?.points ?? [];
      const all = drawing.from === null ? own : [drawing.from, ...own];
      return [...new Set(all)].map(point => ({ trail: drawn.id, point }));
    }
    return selectionPicks().flatMap(({ trail, paths }) =>
      [...new Set(paths.flatMap(path => trail.paths[path].points))].sort((a, b) => a - b).map(point => ({ trail: trail.id, point })));
  }

  const positionOf = (ref: TrailPointRef): V3 | null => byId(ref.trail)?.points[ref.point] ?? null;

  /** The picked point, if it is one the viewport shows. */
  function pickedPoint(): TrailPointRef | null {
    const ref = store.trailPoint;
    if (!ref) return null;
    return shownPoints().some(shown => shown.trail === ref.trail && shown.point === ref.point) ? ref : null;
  }

  /** Push the shown points to the viewport. Called on every Tools rebuild and every render, which between them
   *  follow every selection change and every document change. Only a render (`rendered`) lands a cut's cell
   *  highlight: the highlight resolves names on the drawn mesh, which is the new one only once it has rendered. */
  function syncTrailView(rendered = false) {
    const shown = shownPoints();
    if (store.trailPoint && !pickedPoint()) store.trailPoint = null;
    const indexOf = (trail: string, point: number) => shown.findIndex(ref => ref.trail === trail && ref.point === point);
    const knots = shown.map(ref => positionOf(ref) ?? [0, 0, 0] as V3);
    // A point whose Bézier handle holds the gizmo leaves it there (app/paths/handles.ts).
    const picked = store.trailPoint && store.pathHandle?.family !== 'trail' ? indexOf(store.trailPoint.trail, store.trailPoint.point) : -1;
    const drawn = drawingTrail();
    // No point picked on selected paths: the gizmo is theirs together, at the centre of their patches — where a
    // patch selection's gizmo would sit. Not while drawing, when a click on a ribbon lays the next point.
    const whole = !drawn && !store.trailPoint && shown.length >= 2;
    const lines: { nodes: number[]; handles?: TrailPath['handles'] }[] = [];
    let draw: TrailShape['draw'];
    if (drawn && drawing) {
      const path = drawing.path === null ? null : drawn.paths[drawing.path];
      if (path) lines.push({ nodes: path.points.map(point => indexOf(drawn.id, point)), handles: path.handles });
      draw = { path: path ? 0 : null, end: drawing.end, from: drawing.from === null ? null : indexOf(drawn.id, drawing.from) };
    } else {
      for (const { trail, paths } of selectionPicks()) for (const index of paths) {
        const path = trail.paths[index];
        lines.push({ nodes: path.points.map(point => indexOf(trail.id, point)), handles: path.handles });
      }
    }
    // Points catch the path being drawn, and the picked point dragged (docs/023 · Networks).
    const snaps = snapTargets('draw').map(target => target.pos), dragSnaps = snapTargets('drag').map(target => target.pos);
    view().setTrailKnots(knots, picked >= 0 ? picked : null, whole ? selectionCentre() : null, { paths: lines, draw, snaps, dragSnaps });
    if (rendered && cellsStale) { cellsStale = false; view().refreshEditCells(); seatMoveGizmo(); }
  }

  /** The mean of the selected patches' vertices as they stand. */
  function selectionCentre(): V3 {
    const at = nameIndex(store.mdoc.quadIds), seen = new Set<number>();
    const sum: V3 = [0, 0, 0];
    for (const id of store.cellSel) {
      const quad = at.get(id);
      if (quad === undefined) continue;
      for (const vertex of store.mdoc.quads[quad]) {
        if (seen.has(vertex)) continue;
        seen.add(vertex);
        for (let k = 0; k < 3; k++) sum[k] += store.mdoc.vertices[vertex * 3 + k];
      }
    }
    return seen.size ? [sum[0] / seen.size, sum[1] / seen.size, sum[2] / seen.size] : [0, 0, 0];
  }

  // ---- joining (docs/023 · Networks) ----------------------------------------------------------------------------

  /**
   * The points what is moving may land on. The next point `draw`n: every point of every trail but the one the path
   * being drawn grows from. The picked point, `drag`ged: every point but itself and its neighbours along its paths,
   * which it would fold a path onto — mid-draw too, and none while its trail is not in the document yet.
   */
  function snapTargets(moving: 'draw' | 'drag'): SnapTarget[] {
    const drawn = drawingTrail();
    let skip: TrailPointRef[] = [];
    if (moving === 'draw') {
      if (!drawn || !drawing) return [];
      const anchor = drawAnchorPoint();
      skip = anchor === null ? [] : [{ trail: drawn.id, point: anchor }];
    } else {
      const picked = pickedPoint(), trail = picked && byId(picked.trail);
      if (!picked || !trail || !inDoc(trail)) return [];
      const near = new Set([picked.point]);
      for (const path of trail.paths) path.points.forEach((point, i) => {
        if (point === picked.point) { if (i > 0) near.add(path.points[i - 1]); if (i + 1 < path.points.length) near.add(path.points[i + 1]); }
      });
      skip = [...near].map(point => ({ trail: trail.id, point }));
    }
    const all: SnapTarget[] = [];
    const trails = drawn && !inDoc(drawn) ? [...docTrails(), drawn] : docTrails();
    for (const trail of trails) {
      const used = new Set(trail.paths.flatMap(path => path.points));
      trail.points.forEach((pos, point) => {
        if (used.has(point) && !skip.some(ref => ref.trail === trail.id && ref.point === point)) all.push({ trail, point, pos });
      });
    }
    return all;
  }

  /** The point at exactly `pos` — where the viewport snapped — if what is moving may land on it. */
  const targetAt = (pos: readonly number[], moving: 'draw' | 'drag'): SnapTarget | null =>
    snapTargets(moving).find(target => Math.hypot(target.pos[0] - pos[0], target.pos[1] - pos[1], target.pos[2] - pos[2]) < 1e-6) ?? null;

  /** Whether other patches are joined to a trail in the document — which then cannot be taken into another. */
  function joinedToMesh(trail: AuthoredTrail): boolean {
    if (!inDoc(trail)) return false;
    const owned = resolveTrail(store.mdoc, trail);
    return !!owned && trailIsConnected(store.mdoc, owned);
  }

  const JOINED_TRAIL = 'Other patches are joined to this trail, so it cannot be taken into another — it would have to be cut afresh.';

  function status(): TrailStatus | null {
    const at = focus();
    if (!at) return null;
    const { trail, paths } = at;
    const owned = inDoc(trail) ? resolveTrail(store.mdoc, trail) : null;
    const picks = drawingTrail() ? [{ trail, paths }] : selectionPicks();
    let spans = 0, patches = 0;
    for (const pick of picks) {
      if (!inDoc(pick.trail)) continue;
      const lists = pathCells(pick.trail);
      const shape = trailCutShape(pick.trail);
      for (const path of pick.paths) {
        patches += lists[path]?.length ?? 0;
        spans += shape.runSpans.reduce((sum, count, run) => sum + (shape.runPaths[run] === path ? count : 0), 0);
      }
    }
    return {
      points: shownPoints().length,
      paths: picks.reduce((sum, pick) => sum + pick.paths.length, 0),
      networkPaths: trail.paths.filter(pathCuts).length,
      junctions: trail.network?.junctionArms.length ?? 0,
      spans,
      patches,
      connected: !!owned && trailIsConnected(store.mdoc, owned),
      broken: inDoc(trail) && !owned,
      draft: !inDoc(trail),
    };
  }

  /** Why the last change was refused — or, while drawing, why the point under the cursor could not be laid. */
  const error = () => lastError ?? (previewError ? `Not here: ${previewError}` : null);

  // ---- cutting ------------------------------------------------------------------------------------------------

  type ApplyOptions = {
    /** The document to cut into: a drag's start. */
    base?: QuadMeshDoc;
    /** Keep a refusal to the panel, rather than saying it at once. */
    quiet?: boolean;
    /** The paths of each cut trail to select afterwards; a trail not named keeps the paths it had selected. */
    select?: Record<string, number[]>;
    /** Trails taken out first, patches and all — taken into one of the cut ones. */
    remove?: readonly AuthoredTrail[];
    /** The cut document's last change before it is installed. */
    settle?: (doc: QuadMeshDoc) => QuadMeshDoc;
    /** The document whose tile sets laid the tiles on the trails' patches, where it is not `base`: a set edited is cut
     *  with its new rows, but its old ones are what the patches wear, and what a tile painted by hand differs from. */
    laid?: QuadMeshDoc;
    /** Trails whose tiles painted by hand the cut ones carry on, wherever their knot segments still run: one broken
     *  apart. The trails in `remove` are carried too. */
    carry?: readonly AuthoredTrail[];
    /** Tiles painted by hand to let go of — the panel's reset — so their patches wear what their sets lay again. */
    drop?: (tile: TrailCustomTile) => boolean;
  };

  /**
   * Cut `nexts` into the document and install the result — the new mesh, the trails in their list, and the selected
   * paths' patches as the patch selection. A cut the generator refuses changes nothing; its reason is kept for the
   * panel and, unless `quiet`, said at once. Tiles painted by hand go with the patches they were painted on
   * (docs/023 · Hand-painted tiles): read before anything changes — from the drag's start, while one is dragged.
   */
  function apply(nexts: readonly AuthoredTrail[], options: ApplyOptions = {}): boolean {
    const before = drag?.picks ?? selectionPicks();
    let doc = options.base ?? store.mdoc;
    const laid = options.laid ?? doc;
    const carried = [...(options.remove ?? []), ...(options.carry ?? [])].flatMap(other => trailCustomTiles(laid, other) ?? []);
    /** The tiles painted by hand that `next` carries on — its own, and those of the trails it takes in or is broken
     *  from — and those it lets go of. */
    const customOf = (next: AuthoredTrail): TrailCutOptions => {
      const record = laid.trails?.find(other => other.id === next.id);
      const own = record ? trailCustomTiles(laid, record) : [];
      if (!own) return { custom: null };
      const all = [...own, ...carried.filter(tile => !record || tile.trail !== next.id)];
      const { drop } = options;
      return drop ? { custom: all.filter(tile => !drop(tile)), dropped: all.filter(drop) } : { custom: all };
    };
    for (const gone of options.remove ?? []) {
      doc = { ...removeTrailPatches(doc, gone), trails: (doc.trails ?? []).filter(other => other.id !== gone.id) };
    }
    const cuts: AuthoredTrail[] = [];
    for (const next of nexts) {
      const cut = cutTrail(doc, next, customOf(next));
      if (!cut.ok) {
        lastError = cut.error;
        if (!options.quiet) toast(cut.error, 'err');
        return false;
      }
      const trails = [...(doc.trails ?? [])];
      const at = trails.findIndex(trail => trail.id === next.id);
      if (at >= 0) trails[at] = cut.trail; else trails.push(cut.trail);
      cut.doc.trails = trails;
      doc = cut.doc;
      cuts.push(cut.trail);
    }
    lastError = null;
    if (draft && nexts.some(next => next.id === draft!.id)) draft = null;
    if (options.settle) doc = options.settle(doc);
    commitEditMesh(store, doc);
    // The selection follows the cut: each cut trail's selected paths by their new patches, everything else as it was.
    const touched = new Set([...cuts.map(trail => trail.id), ...(options.remove ?? []).map(trail => trail.id)]);
    const kept = new Set(before.filter(pick => !touched.has(pick.trail.id)).flatMap(pick => pick.trail.quads));
    const cells = store.cellSel.filter(id => kept.has(id));
    for (const trail of cuts) {
      const paths = options.select?.[trail.id] ?? before.find(pick => pick.trail.id === trail.id)?.paths ?? [];
      const lists = trailPathQuads(doc, trail);
      cells.push(...paths.flatMap(path => lists?.[path] ?? []));
    }
    store.cellSel = cells;
    if (!store.anchorCell || !cells.includes(store.anchorCell)) store.anchorCell = cells[0] ?? null;
    cellsStale = true;
    scheduleRebuild();
    return true;
  }

  /** Put a trail in place after an edit: re-cut while a path of it has two points; while none does, out of the
   *  document — a trail being drawn goes back to a draft, any other is gone. */
  function place(next: AuthoredTrail, options: ApplyOptions = {}): boolean {
    if (next.paths.some(pathCuts)) return apply([next], options);
    if (inDoc(next)) removeTrails([next]);
    if (drawing?.id === next.id) {
      draft = { ...next, vertices: [], quads: [] };
      delete draft.network;
    }
    return true;
  }

  /** Take trails and their patches out of the document. */
  function removeTrails(gone: readonly AuthoredTrail[]) {
    let doc = store.mdoc;
    for (const trail of gone) doc = removeTrailPatches(doc, trail);
    const ids = new Set(gone.map(trail => trail.id));
    doc.trails = (store.mdoc.trails ?? []).filter(other => !ids.has(other.id));
    commitEditMesh(store, doc);
    store.cellSel = [];
    store.anchorCell = null;
    store.trailPoint = null;
    cellsStale = true;
    scheduleRebuild();
  }

  // ---- drawing ------------------------------------------------------------------------------------------------

  /** The next new path's settings: the panel's — its tile set the one last chosen, or the default where this mountain
   *  has no set of that name (one of another mountain's own). */
  function settingsFromStore(): TrailSettings {
    const settings = Object.fromEntries(Object.entries(STORE_KEYS).map(([key, storeKey]) => [key, store[storeKey]])) as unknown as TrailSettings;
    if (settings.trailTiles) {
      // By the name it goes by now — a set since renamed under its new one.
      const set = findTrailTileSet(settings.trailTiles, store.modelEditId ? [] : store.mdoc.trailTileSets);
      settings.trailTiles = set ? trailTileSetId(set) : DEFAULT_TRAIL_TILES.trailTiles;
    }
    return settings;
  }

  function beginDrawing(next: Drawing) {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    drawing = next;
    previewAt = null; previewError = null;
    store.selectedCorner = null; store.selected = null;
    store.surgeryTool = 'trail'; store.createPatchQuads = [];
    store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    store.trailPoint = null;
    view().setWeldTool(false);
    view().setCreateTrailSurfaceLift(store.trailSurfaceLift);
    view().setSurgeryTool('trail');
    syncTrailView();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  /** Arm Create Trail: a fresh trail whose first path the next clicks lay. */
  function armCreateTrail() {
    if (store.modelEditId) { toast('Create Trail builds mountain terrain, not a prop model.', 'err'); return; }
    exitRegion();
    resetGizmoMode();
    draft = { id: nextTrailId(docTrails()), points: [], paths: [{ points: [], settings: settingsFromStore() }], vertices: [], quads: [] };
    beginDrawing({ id: draft.id, path: 0, end: 'end', from: null });
    toast('click centre-spline points · start or end on any trail’s point to join it · Shift axis-locks · Enter finishes', 'info');
  }

  /** The point the next one is laid from: the end of the path being drawn, or the point a new path leaves. */
  function drawAnchorPoint(): number | null {
    const trail = drawingTrail();
    if (!trail || !drawing) return null;
    if (drawing.path === null) return drawing.from;
    const points = trail.paths[drawing.path]?.points ?? [];
    return (drawing.end === 'start' ? points[0] : points.at(-1)) ?? null;
  }

  /**
   * What the picked point is, for the panel's actions: how many arms meet there, which ends of the focus path stand
   * on it, and whether it is a FREE end — one path's end with nothing else, which drawing from grows that path.
   */
  function selectedPointRole():
  { point: number; arms: number; paths: number; through: number; ends: ('start' | 'end')[]; free: boolean } | null {
    const at = focus(), picked = pickedPoint();
    if (!at || !picked || picked.trail !== at.trail.id) return null;
    const arms = pointArms(at.trail)[picked.point] ?? 0;
    const path = at.path === null ? null : at.trail.paths[at.path];
    // Paths running on through the point, rather than ending at it: what a split there would cut.
    const through = at.trail.paths.filter(other => pathCuts(other)
      && other.points.some((point, i) => point === picked.point && i > 0 && i < other.points.length - 1)).length;
    return {
      point: picked.point, arms, paths: pathsThrough(at.trail, picked.point).length, through,
      ends: path ? pathEndsAt(path, picked.point) : [], free: arms === 1,
    };
  }

  /** The ends "add points" can draw onto: the one selected path's two with no point picked, the picked point's
   *  with one of its ends picked, and none otherwise. */
  function resumeEnds(): ('start' | 'end')[] {
    const at = focus();
    if (!at || drawingTrail() || at.path === null || selectionPicks().reduce((n, pick) => n + pick.paths.length, 0) !== 1) return [];
    if (!store.trailPoint) return ['start', 'end'];
    return selectedPointRole()?.ends ?? [];
  }

  /** Lay more points onto one end of the selected path (the panel's "add points"). */
  function resumeTrail(end: 'start' | 'end') {
    const at = focus();
    if (!at || at.path === null || !resumeEnds().includes(end)) return;
    draft = null;
    beginDrawing({ id: at.trail.id, path: at.path, end, from: null });
    toast(`click to add points to the ${end} of the path · Enter finishes`, 'info');
  }

  /** Lay a new path from the picked point (the panel's "new path here"): its first click lays the path and the
   *  junction it makes. */
  function armPathFrom() {
    const at = focus(), role = selectedPointRole();
    if (!at || !role || !inDoc(at.trail)) return;
    draft = null;
    beginDrawing({ id: at.trail.id, path: null, end: 'end', from: role.point });
    toast('click to lay the new path · the ghost shows the junction it makes · Enter finishes', 'info');
  }

  type Lay =
    | { kind: 'start'; drawing: Drawing; trail: AuthoredTrail }
    | { kind: 'cut'; trail: AuthoredTrail; drawing: Drawing | null; remove?: AuthoredTrail; path: number }
    | { kind: 'error'; error: string };

  /** The path being drawn with its next point at `pos` — or on `target`, a point already there. */
  function lay(trail: AuthoredTrail, at: Drawing, pos: V3, target: SnapTarget | null): Lay {
    const drawn = at.path === null ? null : trail.paths[at.path];
    if (drawn && !drawn.points.length) {
      // A fresh trail's first point. On a free end it goes on drawing that path; on any other point, a new path
      // leaves it.
      if (!target) {
        const added = withNewPoint(trail, pos);
        return { kind: 'cut', trail: withPath(added.trail, at.path!, { ...drawn, points: [added.point] }), drawing: at, path: at.path! };
      }
      const host = target.trail;
      if (pointArms(host)[target.point] === 1) {
        const path = host.paths.findIndex(candidate => pathCuts(candidate) && pathEndsAt(candidate, target.point).length);
        return { kind: 'start', trail: host, drawing: { id: host.id, path, end: pathEndsAt(host.paths[path], target.point)[0], from: null } };
      }
      return { kind: 'start', trail: host, drawing: { id: host.id, path: null, end: 'end', from: target.point } };
    }

    // Into another trail: that trail takes this one in, and the two are one network from here on.
    let next = trail, pointShift = 0, pathShift = 0;
    let remove: AuthoredTrail | undefined;
    if (target && target.trail.id !== trail.id) {
      if (joinedToMesh(trail)) return { kind: 'error', error: JOINED_TRAIL };
      const joined = joinTrails(target.trail, trail);
      next = joined.trail; pointShift = joined.points; pathShift = joined.paths;
      remove = inDoc(trail) ? trail : undefined;
    }
    let point: number;
    if (target) point = target.point;
    else { const added = withNewPoint(next, pos); next = added.trail; point = added.point; }
    const anchor = at.path === null ? at.from : null;
    const from = anchor === null ? null : anchor + pointShift;
    if (from === point) return { kind: 'error', error: 'A path needs two different points.' };

    let path: number;
    if (at.path !== null) {
      path = at.path + pathShift;
      const grown = next.paths[path];
      if ((at.end === 'end' ? grown.points.at(-1) : grown.points[0]) === point) return { kind: 'error', error: 'That is the point it grows from.' };
      next = withPath(next, path, extendPath(grown, point, at.end));
    } else {
      path = next.paths.length;
      next = { ...next, paths: [...next.paths, { points: [from!, point], settings: settingsFromStore() }] };
    }
    let end = at.end;
    // Two path ends meeting alone, cut alike, are one path: where this one lands, and where a new one left.
    for (const meet of [target ? point : null, from]) {
      if (meet === null) continue;
      const fused = fusePathsAt(next, meet);
      if (!fused) continue;
      next = fused.trail;
      path = fused.paths[path] ?? fused.kept;
      point = fused.points[point] ?? point;
      const grown = next.paths[path];
      end = grown.points[0] === point && grown.points.at(-1) !== point ? 'start' : 'end';
    }
    // A point laid on one already there ends the path on it.
    return { kind: 'cut', trail: next, remove, path, drawing: target ? null : { id: next.id, path, end, from: null } };
  }

  /** Begin drawing on from a point already there: a free end's path, or a new path leaving it. */
  function startAt(next: Drawing, host: AuthoredTrail) {
    draft = null;
    const lists = pathCells(host);
    store.cellSel = next.path === null ? [] : [...lists[next.path]];
    store.anchorCell = store.cellSel[0] ?? null;
    drawing = next;
    cellsStale = true;
    toast(next.path === null ? 'drawing a new path from that point · Enter finishes' : 'drawing on from the end of that path · Enter finishes', 'info');
  }

  /** A drawing click: lay a point there — or, on a point already there, join it. */
  function appendKnot(pos: V3) {
    const trail = drawingTrail();
    if (!trail || !drawing) return;
    store.trailPoint = null; // keep the gizmo off the newest point so it does not catch the next click
    previewAt = null; previewError = null;
    const laid = lay(trail, drawing, [pos[0], pos[1], pos[2]], targetAt(pos, 'draw'));
    if (laid.kind === 'error') { lastError = laid.error; toast(laid.error, 'err'); }
    else if (laid.kind === 'start') startAt(laid.drawing, laid.trail);
    else {
      const ok = place(laid.trail, { select: { [laid.trail.id]: [laid.path] }, remove: laid.remove ? [laid.remove] : [] });
      if (ok) {
        if (laid.drawing) drawing = laid.drawing;
        else {
          endDrawing();
          toast('joined — the path ends on that point', 'ok');
        }
      }
    }
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** Backspace while drawing: take the newest point back off the path being drawn. */
  function undoCreateTrailPoint() {
    const trail = drawingTrail();
    if (!trail || !drawing || drawing.path === null) return;
    const path = trail.paths[drawing.path];
    if (!path?.points.length) return;
    store.trailPoint = null;
    const left = trimPath(path, drawing.end);
    // A draft keeps a path down to nothing; one in the document leaves the point it would have left from.
    if (left.points.length >= 2 || !inDoc(trail)) {
      const tidied = compactTrail(withPath(trail, drawing.path, left), drawing.path);
      const index = tidied.paths[drawing.path];
      if (index !== null) {
        drawing = { ...drawing, path: index };
        place(tidied.trail, { select: { [trail.id]: [index] } });
      } else {
        drawing = { ...drawing, path: 0 };
        draft = { id: trail.id, points: [], paths: [{ points: [], settings: path.settings }], vertices: [], quads: [] };
      }
    } else {
      // Down to one point on a trail in the document: the path goes, and drawing waits to lay it again from there.
      const from = left.points[0] ?? null;
      const tidied = compactTrail({ ...trail, paths: trail.paths.map((other, i) => i === drawing!.path ? { ...other, points: [] } : other) });
      const at = from === null ? null : tidied.points[from];
      if (!tidied.trail.paths.some(pathCuts)) {
        // Its only path: the trail is a draft of that one point again.
        removeTrails([trail]);
        const lone = from === null ? null : trail.points[from];
        draft = { id: trail.id, points: lone ? [lone] : [], paths: [{ points: lone ? [0] : [], settings: path.settings }], vertices: [], quads: [] };
        drawing = { id: draft.id, path: 0, end: 'end', from: null };
      } else {
        apply([tidied.trail], { select: { [trail.id]: [] } });
        if (at === null) endDrawing(); // it shared no point with the rest: nothing is left to draw from
        else drawing = { ...drawing, path: null, end: 'end', from: at };
      }
    }
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** The cursor moved while drawing: ghost what a click there would lay, a frame later. */
  function previewHover(pos: V3 | null) {
    previewAt = pos ? [pos[0], pos[1], pos[2]] : null;
    previewFrame ||= requestAnimationFrame(() => { previewFrame = 0; showPreview(); });
  }

  /** Ghost the new and reshaped patches the next point would cut — the next span, or the path and the junction it
   *  makes — or say why a point there would be refused. */
  function showPreview() {
    const trail = drawingTrail();
    let shown: AuthoredTrail | null = null, reason: string | null = null;
    if (trail && drawing && previewAt) {
      const laid = lay(trail, drawing, previewAt, targetAt(previewAt, 'draw'));
      if (laid.kind === 'error') reason = laid.error;
      else if (laid.kind === 'cut' && laid.trail.paths.some(pathCuts)) shown = laid.trail;
    }
    const preview = shown ? trailPreview(store.mdoc, shown) : null;
    if (preview && !preview.ok) reason = preview.error;
    // The panel says why a point here would be refused; its rebuild clears the ghost, so it goes first.
    if (reason !== previewError) { previewError = reason; rebuildTools(); }
    view().setLoftPreview(preview?.ok && preview.quads.length ? preview.quads.map(quad => preview.doc.quads[quad]) : null,
      preview?.ok ? preview.doc : null);
  }

  /** Leave the drawing tool, keeping whatever is selected. */
  function endDrawing() {
    store.surgeryTool = null;
    drawing = null; draft = null;
    store.trailPoint = null;
    previewAt = null; previewError = null;
    view().setSurgeryTool(null);
  }

  /** Enter / Esc: stop drawing. A trail that never had a path of two points was never in the document and is
   *  dropped; the path drawn stays selected with its points showing. */
  function finishCreateTrail() {
    if (store.surgeryTool !== 'trail') return;
    const trail = drawingTrail();
    const kept = trail && inDoc(trail) ? trail : null;
    const path = kept && drawing?.path !== null && drawing?.path !== undefined ? drawing.path : null;
    endDrawing();
    if (kept) {
      const lists = pathCells(kept);
      store.cellSel = path !== null && lists[path]?.length ? [...lists[path]] : store.cellSel;
      store.anchorCell = store.cellSel[0] ?? null;
      cellsStale = true;
    }
    syncTrailView();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    if (kept) toast('path finished — click any of its patches to edit it again', 'ok');
  }

  /** The old Cancel: with a trail that edits in place, leaving the tool is finishing it. */
  const cancelCreateTrail = finishCreateTrail;

  // ---- editing ------------------------------------------------------------------------------------------------

  /** A click on a shown point (by its place in the viewport's list) picks it; null drops the pick. */
  function selectKnot(knot: number | null) {
    store.trailPoint = knot === null ? null : shownPoints()[knot] ?? null;
    store.pathHandle = null; // the point takes the gizmo back from its handle
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /** A point, handle or whole-selection drag starts or ends. The end lands the last frame and says why, if the trail
   *  could not follow; a point dropped on another point becomes it. */
  function knotDrag(dragging: boolean) {
    if (dragging) {
      lastError = null;
      const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
      if (picked) drag = trail && inDoc(trail) ? { base: store.mdoc, trails: [trail], picks: selectionPicks() } : null;
      else {
        const picks = selectionPicks();
        drag = picks.length ? { base: store.mdoc, trails: picks.map(pick => pick.trail), picks } : null;
      }
      return;
    }
    flushMove();
    drag = null;
    clearDropGhost();
    const failed = lastError;
    const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
    const target = !failed && picked && trail && inDoc(trail) ? targetAt(trail.points[picked.point], 'drag') : null;
    if (picked && trail && target) dropOn(trail, picked.point, target);
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    if (failed) toast(`${failed} The trail keeps its last shape.`, 'err');
  }

  /** What `point` of `trail` dropped on `target` makes: one point there — and, when the point is another trail's, one
   *  network, `target`'s trail taking `trail` in after its own paths (`pathShift` of them) — or why it cannot. */
  function mergeOnto(trail: AuthoredTrail, point: number, target: SnapTarget):
  { merged: TrailRenumbering; pathShift: number; remove: AuthoredTrail[] } | { error: string } {
    if (target.trail.id === trail.id) return { merged: mergeTrailPoints(trail, point, target.point), pathShift: 0, remove: [] };
    if (joinedToMesh(trail)) return { error: JOINED_TRAIL };
    const joined = joinTrails(target.trail, trail);
    return { merged: mergeTrailPoints(joined.trail, point + joined.points, target.point), pathShift: joined.paths, remove: [trail] };
  }

  /** While a dragged point sits on a point it may land on, ghost the merge a drop there would make — the junction
   *  the paths would meet in, or the one path two ends fuse into — over the drag's own live cut. */
  function showDropGhost() {
    const picked = drag ? pickedPoint() : null, trail = picked ? byId(picked.trail) : null;
    const target = picked && trail && inDoc(trail) ? targetAt(trail.points[picked.point], 'drag') : null;
    const merge = picked && trail && target ? mergeOnto(trail, picked.point, target) : null;
    const preview = merge && 'merged' in merge
      ? trailPreview(store.mdoc, merge.merged.trail, merge.remove.length ? [trail!] : []) : null;
    const quads = preview?.ok && preview.quads.length ? preview.quads.map(quad => preview.doc.quads[quad]) : null;
    if (!quads && !dropGhost) return;
    dropGhost = !!quads;
    view().setLoftPreview(quads, preview?.ok ? preview.doc : null);
  }

  function clearDropGhost() {
    if (dropGhost) view().setLoftPreview(null);
    dropGhost = false;
  }

  /** `point` of `trail`, dropped on `target`: one point now — and one network, when it is another trail's. */
  function dropOn(trail: AuthoredTrail, point: number, target: SnapTarget) {
    const before = selectionPicks();
    const merge = mergeOnto(trail, point, target);
    if ('error' in merge) { lastError = merge.error; toast(merge.error, 'err'); return; }
    const { merged, pathShift, remove } = merge;
    // The selected paths of either trail, renumbered into the one it makes.
    const paths = before.flatMap(pick => pick.trail.id === trail.id ? pick.paths.map(path => path + pathShift)
      : pick.trail.id === target.trail.id ? pick.paths : []).flatMap(path => merged.paths[path] ?? []);
    if (!apply([merged.trail], { select: { [merged.trail.id]: [...new Set(paths)] }, remove })) return;
    // A join mid-draw renumbers the path being drawn, perhaps into another trail: the drawing ends there.
    if (drawing?.id === trail.id) endDrawing();
    const at = merged.points[target.point];
    store.trailPoint = at === null ? null : { trail: merged.trail.id, point: at };
    toast(target.trail.id === trail.id ? 'points joined — the paths meet there now' : 'joined into the other trail — one network now', 'ok');
  }

  function flushMove() {
    if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; }
    const move = pendingMove;
    pendingMove = null;
    if (move) apply(move.trails, { base: move.base, quiet: true });
    if (drag) showDropGhost();
  }

  function queueMove(trails: AuthoredTrail[]) {
    pendingMove = { trails, base: drag?.base ?? store.mdoc };
    if (!drag) { flushMove(); return; }
    moveFrame ||= requestAnimationFrame(() => { moveFrame = 0; flushMove(); });
  }

  /** The picked point's gizmo moved it (by its place in the viewport's list). Cuts run once per frame, each from
   *  the drag's base document. */
  function moveKnot(knot: number, pos: V3) {
    const ref = shownPoints()[knot];
    const trail = ref ? drag?.trails.find(other => other.id === ref.trail) ?? byId(ref.trail) : null;
    if (!ref || !trail) return;
    const next: AuthoredTrail = { ...trail, points: trail.points.map((point, i): V3 => i === ref.point ? [pos[0], pos[1], pos[2]] : point) };
    if (!inDoc(trail)) { draft = next; syncTrailView(); return; }
    queueMove([next]);
  }

  /**
   * The selected paths' gizmo moved, turned or scaled them, from the drag's start: every point they run through and
   * every handle dragged on them goes with it. A point they share with paths not selected moves too, taking those
   * paths' ends along. Cut once per frame from the drag's base document, as a point drag is.
   */
  function transformTrail(xf: TrailTransform) {
    const picks = drag?.picks ?? selectionPicks();
    if (!picks.length) return;
    const nexts = picks.map(({ trail, paths }) => {
      const start = drag?.trails.find(other => other.id === trail.id) ?? trail;
      const moved = new Set(paths.flatMap(path => start.paths[path].points));
      const vector = (v: V3 | undefined) => v && xf.vector(v);
      return {
        ...start,
        points: start.points.map((point, i) => moved.has(i) ? xf.point(point) : point),
        paths: start.paths.map((path, i): TrailPath => !paths.includes(i) || !path.handles ? path : {
          ...path,
          handles: path.handles.map(own => own ? { ...(own.in ? { in: vector(own.in) } : {}), ...(own.out ? { out: vector(own.out) } : {}) } as PathHandles : null),
        }),
      };
    });
    queueMove(nexts);
  }

  /** The path whose handles show — the focus path — as the handle layer takes it, and its picked point's place on
   *  it (app/paths/handles.ts). Its id names the trail and the path. */
  function focusPath(): { id: string; nodes: V3[]; handles?: (PathHandles | null)[]; node: number | null } | null {
    const at = focus();
    if (!at || at.path === null) return null;
    const path = at.trail.paths[at.path];
    if (!path) return null;
    const picked = store.trailPoint?.trail === at.trail.id ? store.trailPoint.point : null;
    const node = picked === null ? -1 : path.points.indexOf(picked);
    return { id: `${at.trail.id}#${at.path}`, nodes: pathKnots(at.trail, path), handles: path.handles, node: node < 0 ? null : node };
  }

  /** A handle of the focus path was clicked: its point is the picked one. */
  function selectTrailNode(node: number) {
    const at = focus();
    const point = at && at.path !== null ? at.trail.paths[at.path]?.points[node] : undefined;
    if (at && point !== undefined) store.trailPoint = { trail: at.trail.id, point };
  }

  /**
   * New Bézier handles for the focus path (app/paths/handles.ts). A `live` change is one frame of a handle drag, cut
   * from the drag's base document like a point drag's; any other re-cuts the trail as it stands.
   */
  function setTrailHandles(handles: (PathHandles | null)[], live: boolean) {
    const at = focus();
    if (!at || at.path === null) return;
    const trail = (live ? drag?.trails.find(other => other.id === at.trail.id) : null) ?? at.trail;
    const changed: TrailPath = { ...trail.paths[at.path] };
    if (handles.some(Boolean)) changed.handles = handles; else delete changed.handles;
    const next = withPath(trail, at.path, changed);
    if (!inDoc(trail)) { draft = next; syncTrailView(); return; }
    if (!live || !drag) { apply([next], { quiet: live }); return; }
    queueMove([next]);
  }

  /** Delete the picked point: every path through it runs straight past it, a path left with one point goes, and a
   *  trail left with no path is removed. */
  function deleteSelectedTrailKnot() {
    const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
    if (!picked || !trail) return;
    store.trailPoint = null;
    store.pathHandle = null;
    const drawn = drawingTrail()?.id === trail.id ? drawing : null;
    const keep = drawn?.path ?? null;
    const tidied = withoutTrailPoint(trail, picked.point, inDoc(trail) ? null : keep);
    const before = selectionPicks().find(pick => pick.trail.id === trail.id)?.paths ?? [];
    if (drawn && drawing) {
      const path = drawn.path === null ? null : tidied.paths[drawn.path];
      const from = drawn.from === null ? null : tidied.points[drawn.from];
      if ((drawn.path !== null && path === null) || (drawn.path === null && from === null)) {
        // What was being drawn is gone with the point: stop drawing.
        place(tidied.trail, { select: { [trail.id]: [] } });
        endDrawing();
      } else {
        drawing = { ...drawing, path, from };
        place(tidied.trail, { select: { [trail.id]: path === null ? [] : [path] } });
      }
    } else {
      const select = before.flatMap(path => tidied.paths[path] ?? []);
      place(tidied.trail, { select: { [trail.id]: select } });
      if (!tidied.trail.paths.some(pathCuts)) toast('trail removed — no path of it has two points left', 'info');
    }
    syncTrailView();
    rebuildTools(); updateCmdSheet();
  }

  /**
   * Break the picked point apart (the panel's "disconnect here"): each side there ends at a point of its own, at the
   * same place — two mid-path, three at a fork — and a side no longer joined to the rest becomes a trail of its own,
   * cut fresh. The selected paths stay selected as their pieces, and the focus path's side keeps the point picked,
   * so a drag pulls that side away.
   */
  function disconnectSelectedPoint() {
    const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
    if (!picked || !trail || !inDoc(trail) || drawingTrail()) return;
    const broken = disconnectPoint(trail, picked.point, focus()?.path ?? undefined);
    if (!broken) return;
    const parts = separateTrail(broken.trail);
    const taken = [...docTrails()];
    const nexts = parts.trails.map((part, i) => {
      if (i === 0) return part;
      const made = { ...part, id: nextTrailId(taken) };
      taken.push(made);
      return made;
    });
    const select: Record<string, number[]> = {};
    for (const path of selectionPicks().find(pick => pick.trail.id === trail.id)?.paths ?? []) {
      for (const piece of broken.pieces[path] ?? []) {
        const at = parts.paths[piece];
        if (at) (select[nexts[at.trail].id] ??= []).push(at.path);
      }
    }
    const sides = pointArms(trail)[picked.point] ?? 0;
    if (!apply(nexts, { select, carry: [trail] })) return;
    const at = parts.points[picked.point];
    store.trailPoint = at ? { trail: nexts[at.trail].id, point: at.point } : null;
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    toast(`disconnected into ${sides} sides${nexts.length > 1 ? `, ${nexts.length} trails now` : ''} · drag the point to pull its side away`, 'ok');
  }

  /**
   * Split the paths running through the picked point there (the panel's "split here"): each becomes two pieces that
   * still meet at the point, so a piece can be set on its own — its tiles above all. Unlike disconnecting, nothing
   * comes apart: the point stays one, and the pieces meet in a joint there. The selected paths stay selected as their
   * pieces, and the point stays picked.
   */
  function splitSelectedPoint() {
    const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
    if (!picked || !trail || !inDoc(trail) || drawingTrail()) return;
    const split = splitPathsAt(trail, picked.point);
    if (!split) return;
    const selected = selectionPicks().find(pick => pick.trail.id === trail.id)?.paths ?? [];
    if (!apply([split.trail], { select: { [trail.id]: selected.flatMap(path => split.pieces[path] ?? [path]) } })) return;
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    const cut = split.pieces.filter(pieces => pieces.length > 1).length;
    toast(`split ${cut > 1 ? `${cut} paths` : 'the path'} here · click a piece’s patches to set it on its own`, 'ok');
  }

  // ---- tile sets (docs/023 · Textures) ------------------------------------------------------------------------

  /** Every set a path may wear: the built-in ones, then the mountain's own. */
  const trailTileSets = (): TrailTileSet[] => trailTileSetsWith(store.modelEditId ? [] : store.mdoc.trailTileSets);

  /** The document with `own` as the mountain's sets, the field dropped once there are none. */
  function withOwnSets(doc: QuadMeshDoc, own: readonly TrailTileSet[]): QuadMeshDoc {
    const next = { ...doc };
    if (own.length) next.trailTileSets = [...own]; else delete next.trailTileSets;
    return next;
  }

  /** Whether a path wears set `id`. */
  const pathWears = (path: TrailPath, id: string): boolean => trailSettingsTiles(path.settings).trailTiles === id;
  const trailsWearing = (id: string): AuthoredTrail[] => docTrails().filter(trail => trail.paths.some(path => pathWears(path, id)));
  /** Every tile of a set's rows. */
  const setTiles = (set: Pick<TrailTileSet, TrailTileRowKey>): string[] =>
    TRAIL_TILE_ROWS.flatMap(key => set[key] ? trailTileRowTiles(set[key]!) : []);

  /**
   * A new set of the mountain's own, of these rows of one map's tiles — a trail row of new tiles, or every row of a set
   * to copy, narrow as it is — named next among that map's — `GARI/Trail 1` — and its id; null, said, when the tiles
   * are from more than one map. Nothing wears it until a path is set to.
   */
  function addTrailTileSet(rows: Pick<TrailTileSet, TrailTileRowKey | 'narrow'>): string | null {
    if (store.modelEditId) return null;
    const tiles = setTiles(rows), level = parseTexRef(tiles[0] ?? '').level;
    if (!level || tiles.some(tile => parseTexRef(tile).level !== level)) {
      toast(`A set’s tiles come from one map: choose ${level || 'one map'}’s tiles.`, 'err');
      return null;
    }
    const own = store.mdoc.trailTileSets ?? [];
    // Its rows in a set's order — cap, trail, right turn, left turn — as it is drawn.
    const set = { level, name: nextTrailTileSetName(level, own), ...(rows.narrow ? { narrow: true } : {}) } as TrailTileSet;
    for (const key of TRAIL_TILE_ROWS) {
      const row = rows[key] && structuredClone(rows[key]);
      if (row) set[key] = set.narrow ? withoutTrailTileMiddle(row) : row;
    }
    commitEditMesh(store, withOwnSets(store.mdoc, [...own, set]));
    scheduleRebuild();
    return trailTileSetId(set);
  }

  /**
   * Change rows of one of the mountain's own sets — a tile, which are mirrored, how they are turned — at once, or make
   * it narrow or wide, and re-cut every trail wearing it. A cap or turn row it has none of starts as its trail row;
   * `null` takes one off again, to wear the trail row there. Its tiles stay one map's; a middle changed to '' is taken
   * off, and an edge tile changed to '' leaves that lane plain. A narrow set's rows have no middle: made narrow, it
   * loses them.
   */
  function editTrailTileSet(id: string, changes: Partial<Record<TrailTileRowKey, Partial<TrailTileRow> | null>>,
    options: { narrow?: boolean } = {}): boolean {
    const own = store.mdoc.trailTileSets ?? [];
    const at = own.findIndex(set => trailTileSetId(set) === id);
    if (at < 0 || store.modelEditId || changes.trail === null) return false;
    const next: TrailTileSet = { ...own[at] };
    for (const key of TRAIL_TILE_ROWS) {
      const change = changes[key];
      if (change === undefined) continue;
      if (change === null) { delete next[key]; continue; }
      const row: TrailTileRow = { ...(own[at][key] ?? own[at].trail), ...change };
      for (const which of ['left', 'middle', 'right'] as const) {
        if (row[which]) continue;
        if (row.mirrored) row.mirrored = row.mirrored.filter(side => side !== which);
        if (row.turns) { row.turns = { ...row.turns }; delete row.turns[which]; }
      }
      // A trail row with no middle leaves the lanes between plain; a cap or turn row's '' does, where none wears the
      // trail row's.
      if (!row.middle && (key === 'trail' || row.middle === undefined)) delete row.middle;
      if (!row.mirrored?.length) delete row.mirrored;
      if (!row.turns || !Object.values(row.turns).some(Boolean)) delete row.turns;
      next[key] = row;
    }
    if (options.narrow !== undefined) { if (options.narrow) next.narrow = true; else delete next.narrow; }
    if (next.narrow) for (const key of TRAIL_TILE_ROWS) if (next[key]) next[key] = withoutTrailTileMiddle(next[key]!);
    if (setTiles(next).some(tile => parseTexRef(tile).level !== next.level)) {
      toast(`A set’s tiles come from one map: choose a ${next.level} tile for ${id}.`, 'err');
      return false;
    }
    const sets = own.map((set, i) => i === at ? next : set);
    const users = trailsWearing(id);
    // Cut knowing the set as it was too, after the new one so its id finds that: a tile it no longer has — a middle
    // taken off — is a set's, and is taken back, not left on as if painted by hand. What was painted by hand is read
    // against the set as it was, which laid the rest.
    if (users.length) {
      return apply(users, { base: withOwnSets(store.mdoc, [...sets, own[at]]), laid: store.mdoc, settle: doc => withOwnSets(doc, sets) });
    }
    commitEditMesh(store, withOwnSets(store.mdoc, sets));
    scheduleRebuild();
    return true;
  }

  /** Delete one of the mountain's own sets: every path wearing it goes plain and re-cuts, which takes its tiles back
   *  off. */
  function deleteTrailTileSet(id: string): boolean {
    const own = store.mdoc.trailTileSets ?? [];
    if (store.modelEditId || !own.some(set => trailTileSetId(set) === id)) return false;
    const strip = (settings: TrailSettings): TrailSettings => {
      const tiles = trailSettingsTiles(settings);
      return { ...settings, ...tiles, trailTiles: tiles.trailTiles === id ? null : tiles.trailTiles };
    };
    const stripped = (trail: AuthoredTrail): AuthoredTrail =>
      ({ ...trail, paths: trail.paths.map(path => ({ ...path, settings: strip(path.settings) })) });
    const users = trailsWearing(id);
    const paths = users.reduce((n, trail) => n + trail.paths.filter(path => pathWears(path, id)).length, 0);
    // Cut while the set is still the mountain's, so the cut knows its tiles as a set's and takes them back.
    if (users.length && !apply(users.map(stripped))) return false;
    commitEditMesh(store, withOwnSets(store.mdoc, own.filter(set => trailTileSetId(set) !== id)));
    if (draft) draft = stripped(draft);
    if (store.trailTileSet === id) store.trailTileSet = null;
    scheduleRebuild();
    toast(`${id} deleted${paths ? ` — ${paths} path${paths === 1 ? '' : 's'} wearing it went plain` : ''}`, 'ok');
    return true;
  }

  // ---- tiles painted by hand (docs/023 · Hand-painted tiles) --------------------------------------------------------

  /** How many of the selected paths' patches wear a tile painted by hand: other than their set lays, turned otherwise,
   *  or taken off. */
  function trailCustomTileCount(): number {
    if (drawingTrail()) return 0;
    return selectionPicks().reduce((sum, { trail, paths }) =>
      sum + (trailCustomTiles(store.mdoc, trail) ?? []).filter(tile => paths.includes(tile.place.path)).length, 0);
  }

  /** Put the selected paths' patches back in what their sets lay, letting go of every tile painted by hand on them. */
  function resetTrailTextures() {
    const picks = selectionPicks();
    const count = trailCustomTileCount();
    if (!picks.length || !count) return;
    const selected = new Map(picks.map(({ trail, paths }) => [trail.id, new Set(paths)]));
    if (!apply(picks.map(pick => pick.trail), { drop: tile => !!selected.get(tile.trail)?.has(tile.place.path) })) return;
    toast(`${count} hand-painted patch${count === 1 ? '' : 'es'} back to the tile set`, 'ok');
  }

  /** Every selected path, or the one being drawn: what a setting change applies to. */
  function editedPaths(): TrailPick[] {
    const trail = drawingTrail();
    if (trail && drawing) return drawing.path === null ? [] : [{ trail, paths: [drawing.path] }];
    return selectionPicks();
  }

  /** A setting changed in the panel: every selected path takes it — re-cut — and so does the next new path. */
  function setTrailSetting<K extends keyof TrailSettings>(key: K, value: TrailSettings[K]) {
    (store as unknown as Record<string, unknown>)[STORE_KEYS[key]] = value;
    if (key === 'trailTiles') persistUi(); // the next path wears the set last chosen, after a reload too
    const nexts = editedPaths().map(({ trail, paths }) => ({
      ...trail,
      paths: trail.paths.map((path, i) => paths.includes(i) ? { ...path, settings: { ...path.settings, [key]: value } } : path),
    }));
    const live = nexts.filter(inDoc);
    for (const next of nexts) if (!inDoc(next)) draft = next;
    // Quiet: a slider reports every step of a drag, and the panel's banner already says why a cut was refused.
    // No Tools rebuild either, which would tear the slider out from under the pointer.
    if (live.length) apply(live, { quiet: true });
  }

  /** The focus path's settings, or the next new path's while one is about to be laid. */
  function focusSettings(): TrailSettings | null {
    const at = focus();
    if (!at) return null;
    return at.path === null ? settingsFromStore() : at.trail.paths[at.path]?.settings ?? null;
  }

  // ---- the picked point's own section (docs/023 · Per-point section) -----------------------------------------

  /** The picked point: its own values, and the station the focus path (or the first path through it) is cut with
   *  there — null while it cannot be cut, or is still a draft. */
  function selectedTrailKnot(): { point: number; own: TrailKnotSettings; cut: TrailStation | null; settings: TrailSettings } | null {
    const at = focus(), picked = pickedPoint();
    if (!at || !picked || picked.trail !== at.trail.id) return null;
    const trail = at.trail;
    const through = pathsThrough(trail, picked.point).filter(path => pathCuts(trail.paths[path]));
    const path = at.path !== null && through.includes(at.path) ? at.path : through[0];
    if (path === undefined) return null;
    const node = trail.paths[path].points.indexOf(picked.point);
    const cut = inDoc(trail) ? trailPathStations(trail, path)?.[node] ?? null : null;
    return { point: picked.point, own: { ...(trail.pointSettings?.[picked.point] ?? {}) }, cut, settings: trail.paths[path].settings };
  }

  /** The trail with these point values, the field dropped once no point has any. */
  function withPointSettings(trail: AuthoredTrail, list: readonly (TrailKnotSettings | null)[]): AuthoredTrail {
    const next = { ...trail };
    if (list.some(Boolean)) next.pointSettings = [...list]; else delete next.pointSettings;
    return next;
  }

  /**
   * Set one of the picked point's own values, or clear it (`undefined`) so the point follows its paths again.
   * Quiet and without a Tools rebuild, like `setTrailSetting`: a slider reports every step of its drag.
   */
  function setTrailKnotSetting<K extends keyof TrailKnotSettings>(key: K, value: TrailKnotSettings[K] | undefined) {
    const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
    if (!picked || !trail) return;
    const next = withPointSettings(trail, setTrailKnotValue(trail.pointSettings, trail.points.length, picked.point, key, value));
    if (!inDoc(trail)) { draft = next; return; }
    apply([next], { quiet: true });
  }

  /** Put the picked point back on its paths' own settings. */
  function resetTrailKnotSettings() {
    const picked = pickedPoint(), trail = picked ? byId(picked.trail) : null;
    if (!picked || !trail?.pointSettings?.[picked.point]) return;
    const next = withPointSettings(trail, trail.pointSettings.map((entry, i) => i === picked.point ? null : entry ?? null));
    if (!inDoc(trail)) draft = next; else apply([next]);
    rebuildTools();
  }

  /** Delete the selected paths with their patches, and every point only they ran through; a trail left with no
   *  path goes. */
  function deleteSelectedTrail() {
    const drawn = drawingTrail();
    if (drawn && !inDoc(drawn)) { finishCreateTrail(); return; }
    if (drawn) finishCreateTrail();
    const picks = selectionPicks();
    if (!picks.length) return;
    const emptied = picks.map(({ trail, paths }) => withoutTrailPaths(trail, paths).trail);
    const left = emptied.filter(trail => trail.paths.some(pathCuts));
    const gone = picks.map(pick => pick.trail).filter(trail => !left.some(other => other.id === trail.id));
    if (gone.length) removeTrails(gone);
    if (left.length) apply(left, { select: Object.fromEntries(left.map(trail => [trail.id, []])) });
    store.trailPoint = null;
    const count = picks.reduce((n, pick) => n + pick.paths.length, 0);
    syncTrailView();
    rebuildTools(); updateCmdSheet();
    toast(count === 1 ? 'path and its patches deleted' : `${count} paths and their patches deleted`, 'ok');
  }

  /** Let the patches go: the selected paths' trails are removed — whole networks, which own their patches together —
   *  and their patches stay, selected, as ordinary (still locked) mesh. */
  function dissolveSelectedTrail() {
    const picks = selectionPicks();
    if (!picks.length) return;
    const ids = new Set(picks.map(pick => pick.trail.id));
    const cells = picks.flatMap(pick => pick.trail.quads);
    store.mdoc.trails = (store.mdoc.trails ?? []).filter(other => !ids.has(other.id));
    store.cellSel = cells;
    store.trailPoint = null;
    syncTrailView();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(`trail dissolved — its ${cells.length} patches are ordinary mesh now, still locked (Visibility ▸ unlock to edit them)`, 'ok');
  }

  return {
    selectedTrail, trailFocus: focus, trailSelection: selectionPicks, trailAtQuad, trailVertexIndices, withWholePaths,
    pathCellsAt, networkCellsAt, selectWholeNetwork, syncTrailView, trailStatus: status, trailError: error,
    armCreateTrail, resumeTrail, resumeEnds, armPathFrom, selectedPointRole, previewHover, focusSettings,
    /** The point the new path being drawn leaves from, while it has no point of its own yet; else null. */
    drawingFrom: (): number | null => drawingTrail() && drawing?.path === null ? drawing.from : null,
    /** The point the next one is laid from: the end being drawn onto, or the point a new path leaves. */
    trailDrawAnchor: (): V3 | null => {
      const trail = drawingTrail(), point = drawAnchorPoint();
      return trail && point !== null ? trail.points[point] ?? null : null;
    },
    appendKnot, undoCreateTrailPoint, finishCreateTrail, cancelCreateTrail,
    selectKnot, knotDrag, moveKnot, transformTrail, focusPath, selectTrailNode, setTrailHandles, deleteSelectedTrailKnot,
    disconnectSelectedPoint, splitSelectedPoint, setTrailSetting, deleteSelectedTrail, dissolveSelectedTrail,
    selectedTrailKnot, setTrailKnotSetting, resetTrailKnotSettings,
    trailTileSets, addTrailTileSet, editTrailTileSet, deleteTrailTileSet, trailCustomTileCount, resetTrailTextures,
  };
}

export type TrailTools = ReturnType<typeof createTrailTools>;
