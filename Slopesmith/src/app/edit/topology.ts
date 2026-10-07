import type { QuadMeshDoc, V3 } from '../../core/doc/types';
import {
  appendFreeEdge, appendTube, applySurfaceCut, autoWeldCreatedEdgeCrossings, ekey, routeSurfaceCutPath, validateSurfaceCutPath,
  fillSelectedEdgeHoles, type SurfaceCutPoint,
} from '../../core/mesh/ops';
import { applyLoft, railFromEdges, type RailResult } from '../../core/mesh/loft';
import { getVertex } from '../../core/doc/doc-edit';
import type { Store } from '../state/store';
import {
  canonicalNamedEdge, edgeIndex, edgeIndices, namedEdge, namedEdges, namedSurfaceCutPath, quadNames,
  surfaceCutPathIndices, vertexIndex, vertexIndices, vertexName, vertexNames, type NamedEdge, type VertexName,
} from '../state/mesh-names';
import { commitEditMesh, editMesh } from './mesh-target';
import type { EditViewportPort } from './viewport-port';
import { toast } from '../ui/components/toast';
import type { CreateEdgeEndpoint } from '../viewport/types';
import { quadPerimeterEdges } from '../../core/mesh/primitives';
import { buildQuadMesh, meshAdjacency } from '../../core/mesh/topology';
import { findTJunctions } from '../../core/mesh/t-junctions';

const quadHasEdge = (q: number[], edge: readonly [number, number]) =>
  quadPerimeterEdges(q).some(([a, b]) => a !== b && ekey(a, b) === ekey(edge[0], edge[1]));
const isSurfaceEdge = (doc: QuadMeshDoc, edge: readonly [number, number]) => doc.quads.some(q => quadHasEdge(q, edge));

/** Carry the Create Edge chain across a commit that split some of its edges — a later edge drawn to end on one,
 *  or a crossing welded into it. A named edge the commit removed becomes the run of edges joining its two ends
 *  through points the commit created; one that cannot be traced is dropped, so the chain (and the selection it
 *  becomes) never names an edge the mesh does not have. */
function traceSplitChain(before: QuadMeshDoc, after: QuadMeshDoc, chain: readonly NamedEdge[]): NamedEdge[] {
  const adj = meshAdjacency(buildQuadMesh(after.vertices, after.quads, after.freeEdges));
  const born = (v: number) => vertexIndex(before, after.vertexIds[v]) === null;
  const out: NamedEdge[] = [], seen = new Set<string>();
  const push = (edge: NamedEdge) => {
    const key = edge.join('|');
    if (!seen.has(key)) { seen.add(key); out.push(edge); }
  };
  for (const named of chain) {
    const at = edgeIndex(after, named);
    if (!at) continue;
    const [a, b] = at;
    if (adj.neighbors[a]?.includes(b)) { push(named); continue; }
    const previous = new Map<number, number>([[a, a]]), queue = [a];
    for (let i = 0; i < queue.length && !previous.has(b); i++) for (const n of adj.neighbors[queue[i]] ?? []) {
      if (previous.has(n) || (n !== b && !born(n))) continue;
      previous.set(n, queue[i]); queue.push(n);
    }
    if (!previous.has(b)) continue;
    const run: NamedEdge[] = [];
    for (let v = b; v !== a; v = previous.get(v)!) {
      const edge = namedEdge(after, [previous.get(v)!, v]);
      if (edge) run.push(edge);
    }
    run.reverse().forEach(push);
  }
  return out;
}

export type TopologyToolDeps = {
  store: Store;
  viewport: () => EditViewportPort;
  cageActive: () => boolean;
  applyCage: () => void;
  persistUi: () => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  clearEdgeSelection: () => void;
  clearCellSelection: () => void;
  dropCornerSelection: () => void;
  exitRegion: () => void;
  seatMoveGizmo: () => void;
  resetGizmoMode: () => void;
};

/** Bridge Builder and Create Edge are topology-authoring workflows with their own modal state and commands.
 * Keeping them together makes EditSession the coordinator while this module owns their multi-step lifecycles. */
export function createTopologyTools(deps: TopologyToolDeps) {
  const {
    store, viewport: getViewport, cageActive, applyCage, persistUi, scheduleRebuild, rebuildTools, updateCmdSheet,
    clearEdgeSelection, clearCellSelection, dropCornerSelection, exitRegion, seatMoveGizmo, resetGizmoMode,
  } = deps;
  const view = () => getViewport();
  const mdoc = () => editMesh(store); // the edit target: the mountain net, or the model being edited
  const railEdges = (rail: readonly VertexName[]): NamedEdge[] => Array.from(
    { length: Math.max(0, rail.length - 1) }, (_, i) => canonicalNamedEdge(rail[i], rail[i + 1]),
  );
  const railKey = (rail: readonly VertexName[]) => [...rail].sort().join(',');
  /** A Bridge session outlives the edits made between adopting one rail and the next, so its rails name the
   *  run they adopted; the preview and the loft take them as live indices (docs/039). */
  const railIndices = (rail: readonly VertexName[]) => vertexIndices(mdoc(), rail);
  const pushBridgeRails = () => view().setBridgeRails((store.bridgeRails ?? []).map(railIndices));
  /** A topology commit installs new stable ids in the document, but the viewport receives that document on
   * the scheduled render frame. Rebuild the selection-dependent toolbox only after that frame so its
   * measurement lookup resolves the newly created cells instead of falling through to the default panel. */
  const refreshCreatedCellSelection = () => requestAnimationFrame(() => {
    view().refreshEditCells();
    seatMoveGizmo();
    rebuildTools();
    updateCmdSheet();
  });

  /** The candidate rail as the store keeps rails: an ordered run of names. */
  const namedRail = (rail: readonly number[]): VertexName[] | null => {
    const named = vertexNames(mdoc(), rail);
    return named.length === rail.length ? named : null;
  };
  const UNNAMEABLE_RAIL = 'That selection names points this mountain no longer carries.';

  function bridgeCandidate(): RailResult {
    const candidate = railFromEdges(edgeIndices(mdoc(), store.edgeSel));
    if (!candidate.ok) return candidate;
    const rails = store.bridgeRails ?? [];
    if (rails.length && candidate.rail.length !== rails[0].length)
      return { ok: false, error: `The next rail needs ${rails[0].length} vertices; this selection has ${candidate.rail.length}.` };
    const named = namedRail(candidate.rail);
    if (!named) return { ok: false, error: UNNAMEABLE_RAIL };
    if (rails.some(rail => railKey(rail) === railKey(named))) return { ok: false, error: 'That rail is already in this bridge.' };
    return candidate;
  }

  function alignRail(rail: readonly VertexName[]): VertexName[] {
    const previous = store.bridgeRails?.[store.bridgeRails.length - 1];
    if (!previous || previous.length !== rail.length) return [...rail];
    const at = railIndices(previous), here = railIndices(rail);
    if (at.length !== previous.length || here.length !== rail.length) return [...rail];
    const p0 = getVertex(mdoc(), at[0]), p1 = getVertex(mdoc(), at[at.length - 1]);
    const r0 = getVertex(mdoc(), here[0]), r1 = getVertex(mdoc(), here[here.length - 1]);
    const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return distance(p0, r1) + distance(p1, r0) < distance(p0, r0) + distance(p1, r1) ? [...rail].reverse() : [...rail];
  }

  function startBridge() {
    if (store.bridgeRails !== null) return;
    const seed = railFromEdges(edgeIndices(mdoc(), store.edgeSel));
    if (!seed.ok) { toast(seed.error, 'err'); return; }
    const named = namedRail(seed.rail);
    if (!named) { toast(UNNAMEABLE_RAIL, 'err'); return; }
    store.bridgeRails = [named];
    clearEdgeSelection();
    pushBridgeRails();
    rebuildTools(); updateCmdSheet();
    toast('Bridge Builder — select the next edge chain, then press A to add it', 'info');
  }

  function addBridgeRail() {
    if (store.bridgeRails === null) return;
    const candidate = bridgeCandidate();
    if (!candidate.ok) { toast(candidate.error, 'err'); return; }
    const named = namedRail(candidate.rail);
    if (!named) { toast(UNNAMEABLE_RAIL, 'err'); return; }
    store.bridgeRails.push(alignRail(named));
    clearEdgeSelection();
    pushBridgeRails();
    rebuildTools();
  }

  function reverseBridgeRail(index: number) {
    const rail = store.bridgeRails?.[index];
    if (!rail) return;
    store.bridgeRails![index] = [...rail].reverse();
    rebuildTools();
  }

  function removeBridgeRail(index: number) {
    if (!store.bridgeRails?.[index]) return;
    store.bridgeRails.splice(index, 1);
    rebuildTools();
  }

  function moveBridgeRail(from: number, to: number) {
    const rails = store.bridgeRails;
    if (!rails || from < 0 || from >= rails.length || to < 0 || to >= rails.length || from === to) return;
    const [rail] = rails.splice(from, 1);
    rails.splice(to, 0, rail);
    rebuildTools();
  }

  function cancelBridge(refresh = true, restoreSelection = true) {
    if (store.bridgeRails === null) return;
    const first = store.bridgeRails[0];
    store.bridgeRails = null;
    view().setBridgeRails(null);
    view().setLoftPreview(null);
    clearEdgeSelection();
    if (restoreSelection && first?.length >= 2) {
      store.edgeSel = railEdges(first);
      store.anchorEdge = store.edgeSel[0] ?? null;
      view().refreshEditEdges();
      if (store.currentMode === 'edit' && cageActive()) seatMoveGizmo();
    }
    if (refresh) { rebuildTools(); updateCmdSheet(); }
  }

  function completeBridge() {
    const rails = store.bridgeRails;
    if (!rails || rails.length < 2) { toast('Add at least two rails before completing the bridge.', 'err'); return; }
    const resolved = rails.map(railIndices);
    if (resolved.some((rail, at) => rail.length !== rails[at].length)) {
      toast('This bridge names points the mountain no longer carries — rebuild its rails.', 'err'); return;
    }
    const before = mdoc().quads.length;
    const result = applyLoft(mdoc(), resolved, {
      preserveRailOrder: true, targetPatchM: store.bridgePatchM, connectionCurve: store.bridgeCurve,
    });
    if (!result.ok) { toast(result.error.replace(/\bLoft\b/g, 'Bridge').replace(/\bloft\b/g, 'bridge'), 'err'); return; }
    commitEditMesh(store, result.doc);
    const cells = Array.from({ length: result.doc.quads.length - before }, (_, i) => before + i);
    store.bridgeRails = null;
    view().setBridgeRails(null); view().setLoftPreview(null);
    clearEdgeSelection(); dropCornerSelection(); clearCellSelection();
    store.cellSel = quadNames(mdoc(), cells); store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode(); scheduleRebuild();
    refreshCreatedCellSelection();
    toast(`bridge complete · ${rails.length} rails · ${cells.length} ${cells.length === 1 ? 'surface' : 'surfaces'}`, 'ok');
  }

  function createPatchesFromEdges() {
    const doc = mdoc(), selected = edgeIndices(doc, store.edgeSel);
    if (selected.length !== store.edgeSel.length) {
      toast('Some selected edges no longer exist — select the hole boundaries again.', 'err'); return;
    }
    const result = fillSelectedEdgeHoles(doc, selected);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    clearEdgeSelection(); dropCornerSelection(); clearCellSelection();
    store.cellSel = quadNames(mdoc(), result.quads); store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode(); scheduleRebuild(); refreshCreatedCellSelection();
    toast(`${result.quads.length} ${result.quads.length === 1 ? 'patch' : 'patches'} created`
      + (result.skipped ? ` · ${result.skipped} invalid ${result.skipped === 1 ? 'loop' : 'loops'} skipped` : ''), 'ok');
  }

  function armCreateEdge() {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    exitRegion();
    store.selectedCorner = null; store.selected = null;
    store.createEdgeTool = true; store.createEdgeStart = null; store.createEdgeChain = [];
    store.createEdgeSurfacePath = []; store.createEdgeSurfacePositions = [];
    store.surgeryTool = null; store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    view().setSurgeryTool(null); view().setWeldTool(false); view().setCreateEdgeTool(true, null);
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('click any point or edge to start — keep clicking to extend — Esc starts a new strand — Enter to finish', 'info');
  }

  function armCreatePatch() {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    exitRegion();
    store.selectedCorner = null; store.selected = null;
    store.surgeryTool = 'patch'; store.createPatchQuads = []; store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    view().setWeldTool(false); view().setCreatePatchSides(store.createPatchSides); view().setSurgeryTool('patch');
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(store.createPatchSides === 3
      ? 'click 3 corners around each triangle — hold Shift to lock the next side to a world axis'
      : 'click 4 corners around each quad, or repeat any corner after the third to close a triangle — hold Shift for axis lock', 'info');
  }

  function armCreateTube() {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    exitRegion();
    store.selectedCorner = null; store.selected = null;
    store.surgeryTool = 'tube'; store.createPatchQuads = [];
    store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    view().setWeldTool(false); view().setSurgeryTool('tube');
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('click the two tube endpoints — hold Shift to lock the axis — adjust dimensions, then press Enter', 'info');
  }

  /** Loop Cut (docs/017): hover an edge, the strip through it previews, Alt+scroll slides it, a click cuts —
   *  and the tool stays armed for the next. Esc leaves it. */
  function armLoopCut() {
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    exitRegion();
    store.selectedCorner = null; store.selected = null;
    store.surgeryTool = 'loopcut'; store.createPatchQuads = [];
    store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    view().setWeldTool(false); view().setSurgeryTool('loopcut');
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('hover an edge to preview the loop · Alt+scroll slides it · click to cut · Esc to finish', 'info');
  }

  function previewCreateTube() {
    const points = view().createTubePoints;
    if (points.length !== 2) { view().setLoftPreview(null); return null; }
    const result = appendTube(
      mdoc(), points[0], points[1], store.tubeWidth, store.tubeHeight, store.tubeSectionLength, store.tubeRingEdges,
    );
    if (!result.ok) { view().setLoftPreview(null); return result; }
    view().setLoftPreview(result.quads.map(quad => result.doc.quads[quad]), result.doc);
    return result;
  }

  function finishCreateTube() {
    if (store.surgeryTool !== 'tube') return;
    const result = previewCreateTube();
    if (!result) { toast('Draw both tube endpoints before creating it.', 'err'); return; }
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    store.surgeryTool = null;
    view().setSurgeryTool(null); view().setLoftPreview(null);
    clearEdgeSelection(); dropCornerSelection(); clearCellSelection();
    store.cellSel = quadNames(mdoc(), result.quads); store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode(); scheduleRebuild();
    refreshCreatedCellSelection();
    toast(`tube created · ${result.axialSections} × ${result.radialSections} sections · ${result.quads.length} patches`, 'ok');
  }

  function cancelCreateTube() {
    if (store.surgeryTool !== 'tube') return;
    store.surgeryTool = null;
    view().setSurgeryTool(null); view().setLoftPreview(null);
    rebuildTools(); updateCmdSheet();
  }

  function finishCreatePatch(selectCreated: boolean) {
    if (store.surgeryTool !== 'patch') return;
    const created = [...store.createPatchQuads];
    store.surgeryTool = null; store.createPatchQuads = [];
    view().setSurgeryTool(null);
    clearEdgeSelection(); dropCornerSelection(); clearCellSelection();
    if (selectCreated && created.length) {
      store.cellSel = created; store.anchorCell = created[0];
      resetGizmoMode();
    }
    scheduleRebuild();
    if (selectCreated && created.length) requestAnimationFrame(() => { view().refreshEditCells(); seatMoveGizmo(); });
    rebuildTools(); updateCmdSheet();
    if (created.length) toast(`${created.length} ${created.length === 1 ? 'patch' : 'patches'} created${selectCreated ? ' and selected' : ''}`, 'ok');
  }

  /** The surface cut a Create Edge point would continue from the chain's start: the path as drawn and its plan,
   *  and — for a single segment the drawn path cannot cross — the route across the strip of patches between.
   *  `route: false` skips that strip search. Shared by the click and by the hover's `createEdgeCuts`. */
  function surfaceCutCandidate(
    doc: QuadMeshDoc, start: NonNullable<Store['createEdgeStart']>, surfacePath: SurfaceCutPoint[],
    endpoint: CreateEdgeEndpoint, route = true,
  ) {
    const startVertex = start.vertex === null ? null : vertexIndex(doc, start.vertex);
    const endpointOnSurfaceEdge = endpoint.edge != null && isSurfaceEdge(doc, endpoint.edge);
    const endpointOnSurfaceVertex = endpoint.vertex !== null && doc.quads.some(q => q.includes(endpoint.vertex!));
    const endpointPoint: SurfaceCutPoint | null = endpointOnSurfaceVertex
      ? { vertex: endpoint.vertex! }
      : endpoint.edge && endpoint.t !== undefined && endpointOnSurfaceEdge ? { edge: endpoint.edge, t: endpoint.t } : null;
    const startOnSurface = startVertex !== null && doc.quads.some(q => q.includes(startVertex));
    const path: SurfaceCutPoint[] | null = endpointPoint && (surfacePath.length || startOnSurface)
      ? surfacePath.length
        ? [...surfacePath, endpointPoint]
        : [{ vertex: startVertex! }, endpointPoint]
      : null;
    const plan = path ? validateSurfaceCutPath(doc, path) : null;
    const routed = route && path?.length === 2 && plan && !plan.ok ? routeSurfaceCutPath(doc, path[0], path[1]) : null;
    return { startVertex, startOnSurface, endpointOnSurfaceEdge, endpointPoint, path, plan, routed };
  }

  /** The last hover answer, kept while the pointer stays on the same edge of the same document and chain. */
  let cutsCache: { doc: QuadMeshDoc; key: string; cuts: boolean } | null = null;

  /** Whether a patch edge under the pointer continues a cut from the chain's start, so the hover sticks to it
   *  without Ctrl and a patch can be split by drawing across it. Any cut across a patch the start touches
   *  qualifies; a route across a longer strip only out of a T-junction, the vertex a cut is drawn from to
   *  stitch a split patch back into its neighbours. Elsewhere a patch edge still needs Ctrl, so a busy map
   *  does not pull a free-standing wall onto the terrain behind it. */
  function createEdgeCuts(endpoint: CreateEdgeEndpoint): boolean {
    const start = store.createEdgeStart;
    if (!store.createEdgeTool || !start || !endpoint.edge || endpoint.t === undefined) return false;
    const doc = mdoc();
    const key = JSON.stringify([start, store.createEdgeSurfacePath, ekey(endpoint.edge[0], endpoint.edge[1])]);
    if (cutsCache?.doc === doc && cutsCache.key === key) return cutsCache.cuts;
    const startVertex = start.vertex === null ? null : vertexIndex(doc, start.vertex);
    const fromJunction = startVertex !== null && findTJunctions(doc, undefined, [startVertex]).length > 0;
    const candidate = surfaceCutCandidate(doc, start, surfaceCutPathIndices(doc, store.createEdgeSurfacePath), endpoint, fromJunction);
    const cuts = candidate.plan?.ok === true || candidate.routed !== null;
    cutsCache = { doc, key, cuts };
    return cuts;
  }

  function addCreateEdgePoint(endpoint: CreateEdgeEndpoint) {
    if (!store.createEdgeTool) return;
    const doc = mdoc();
    // The chain commits a topology edit per click, so the pending start and the provisional route are held by
    // NAME and resolved fresh here: a cut that splits a patch renumbers the very edge the route is standing on.
    const surfacePath = surfaceCutPathIndices(doc, store.createEdgeSurfacePath);
    const start = store.createEdgeStart;
    if (!start) {
      if (endpoint.edge && endpoint.t !== undefined && isSurfaceEdge(doc, endpoint.edge)) {
        const point: SurfaceCutPoint = { edge: endpoint.edge, t: endpoint.t };
        const plan = validateSurfaceCutPath(doc, [point]);
        if (!plan.ok) { toast(plan.error, 'err'); return; }
        const named = namedEdge(doc, endpoint.edge);
        if (!named) return;
        store.createEdgeSurfacePath = [{ edge: named, t: endpoint.t }];
        store.createEdgeSurfacePositions = [[...endpoint.pos] as V3];
        store.createEdgeStart = { vertex: null, pos: [...endpoint.pos] as V3, edge: named, t: endpoint.t };
        view().setCreateEdgeStart(store.createEdgeStart.pos); view().setCreateEdgePath(store.createEdgeSurfacePositions);
        rebuildTools();
        toast('surface-edge point placed · continue the cut across either incident patch', 'info');
        return;
      }
      const named = endpoint.edge ? namedEdge(doc, endpoint.edge) : null;
      store.createEdgeStart = {
        vertex: endpoint.vertex === null ? null : vertexName(doc, endpoint.vertex),
        pos: [...endpoint.pos] as V3,
        ...(named && endpoint.t !== undefined ? { edge: named, t: endpoint.t } : {}),
      };
      view().setCreateEdgeStart(store.createEdgeStart.pos); rebuildTools(); return;
    }
    const startEdge = start.edge ? edgeIndex(doc, start.edge) : null;
    const {
      startVertex, startOnSurface, endpointOnSurfaceEdge, endpointPoint,
      path: candidateSurfacePath, plan: candidateSurfacePlan, routed: routedSurfacePath,
    } = surfaceCutCandidate(doc, start, surfacePath, endpoint);
    const cutEnd = endpoint.vertex;
    const sharePatch = startOnSurface && cutEnd !== null
      && doc.quads.some(q => q.includes(startVertex!) && q.includes(cutEnd));
    const endpointEdgeSharesPatch = startOnSurface && endpoint.edge != null && endpointOnSurfaceEdge
      && doc.quads.some(q => q.includes(startVertex!) && quadHasEdge(q, endpoint.edge!));
    const directSurfaceIntent = candidateSurfacePlan?.ok === true || routedSurfacePath !== null;
    const surfaceIntent = surfacePath.length > 0
      || sharePatch || endpointEdgeSharesPatch || directSurfaceIntent;
    if (surfaceIntent) {
      const canFallBackToFree = surfacePath.length === 1;
      if (endpointPoint) {
        const path = routedSurfacePath ?? candidateSurfacePath!;
        const plan = validateSurfaceCutPath(doc, path);
        if (plan.ok) {
          if (!plan.complete) {
            store.createEdgeSurfacePath = namedSurfaceCutPath(doc, path);
            store.createEdgeSurfacePositions = store.createEdgeSurfacePositions.length
              ? [...store.createEdgeSurfacePositions, [...endpoint.pos] as V3]
              : [[...start.pos] as V3, [...endpoint.pos] as V3];
            store.createEdgeStart = { vertex: null, pos: [...endpoint.pos] as V3 };
            view().setCreateEdgeStart(store.createEdgeStart.pos); view().setCreateEdgePath(store.createEdgeSurfacePositions); rebuildTools();
            toast('surface cut is provisional · continue to another edge or existing point', 'info');
            return;
          }
          const result = applySurfaceCut(doc, path);
          if (!result.ok) { toast(result.error, 'err'); return; }
          const automatic = autoWeldCreatedEdgeCrossings(result.doc, result.edges);
          commitEditMesh(store, automatic.doc);
          store.createEdgeChain = traceSplitChain(doc, mdoc(), [...store.createEdgeChain, ...namedEdges(mdoc(), automatic.edges)]);
          store.edgeSel = [...store.createEdgeChain]; store.anchorEdge = store.edgeSel[0] ?? null;
          store.createEdgeSurfacePath = [];
          store.createEdgeSurfacePositions = [];
          store.createEdgeStart = { vertex: vertexName(mdoc(), result.endVertex), pos: [...endpoint.pos] as V3 };
          view().setCreateEdgeStart(store.createEdgeStart.pos); view().setCreateEdgePath([]);
          scheduleRebuild(); rebuildTools();
          toast(`surface cut complete · ${automatic.edges.length} ${automatic.edges.length === 1 ? 'edge' : 'edges'}${result.wedges ? ` · ${result.wedges} temporary ${result.wedges === 1 ? 'wedge' : 'wedges'}` : ''}${automatic.welded ? ` · ${automatic.welded} crossing ${automatic.welded === 1 ? 'auto-welded' : 'crossings auto-welded'}` : ''}`, 'ok');
          return;
        }
        if (!canFallBackToFree) { toast(plan.error, 'err'); return; }
      } else if (!canFallBackToFree) {
        toast('Continue the surface cut across an edge, or finish it on an existing point.', 'err'); return;
      }
      // A surface-edge start followed by a point outside either incident patch is an ordinary construction
      // edge. Keep its exact curve contact as a separate id; the T-junction diagnostic explains the unresolved
      // topology after the chain finishes instead of blocking the draft.
      store.createEdgeSurfacePath = [];
      store.createEdgeSurfacePositions = [];
      view().setCreateEdgePath([]);
    }
    const from = startVertex ?? (startEdge && start.t !== undefined
      ? { pos: start.pos, edge: startEdge, t: start.t }
      : start.pos);
    const to = endpoint.vertex ?? (endpoint.edge && endpoint.t !== undefined
      ? { pos: endpoint.pos, edge: endpoint.edge, t: endpoint.t }
      : endpoint.pos);
    const result = appendFreeEdge(doc, from, to);
    if (!result.ok) { toast(result.error, 'err'); return; }
    const automatic = autoWeldCreatedEdgeCrossings(result.doc, [result.edge]);
    commitEditMesh(store, automatic.doc);
    store.createEdgeChain = traceSplitChain(doc, mdoc(), [...store.createEdgeChain, ...namedEdges(mdoc(), automatic.edges)]);
    store.edgeSel = [...store.createEdgeChain]; store.anchorEdge = store.edgeSel[0] ?? null;
    const endVertex = endpoint.vertex ?? result.appendedVertices[result.appendedVertices.length - 1];
    store.createEdgeStart = { vertex: vertexName(mdoc(), endVertex), pos: [...endpoint.pos] as V3 };
    view().setCreateEdgeStart(store.createEdgeStart.pos);
    scheduleRebuild(); rebuildTools();
    if (automatic.welded) toast(`${automatic.welded === 1 ? 'crossing' : `${automatic.welded} crossings`} auto-welded`, 'ok');
  }

  /** Esc's first press: end the strand being drawn but keep the tool armed, so a web of separate strands is
   *  drawn without re-arming, and its edges stay collected for the final selection. False when no strand is
   *  under way — Esc then leaves the tool. */
  function endCreateEdgeChain(): boolean {
    if (!store.createEdgeTool || !store.createEdgeStart) return false;
    store.createEdgeStart = null; store.createEdgeSurfacePath = []; store.createEdgeSurfacePositions = [];
    view().setCreateEdgeStart(null); view().setCreateEdgePath([]);
    rebuildTools();
    return true;
  }

  function finishCreateEdge() {
    if (!store.createEdgeTool) return;
    store.createEdgeTool = false; store.createEdgeStart = null; store.createEdgeSurfacePath = []; store.createEdgeSurfacePositions = [];
    store.edgeSel = [...store.createEdgeChain]; store.anchorEdge = store.edgeSel[0] ?? null; store.createEdgeChain = [];
    view().setCreateEdgeTool(false, null);
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  function clearCreateEdge() {
    store.createEdgeTool = false; store.createEdgeStart = null; store.createEdgeChain = [];
    store.createEdgeSurfacePath = []; store.createEdgeSurfacePositions = [];
    view().setCreateEdgeTool(false, null);
  }

  return {
    bridgeCandidate, startBridge, addBridgeRail, reverseBridgeRail, removeBridgeRail, moveBridgeRail, cancelBridge, completeBridge,
    createPatchesFromEdges, armCreateEdge, armCreatePatch, armLoopCut, armCreateTube, previewCreateTube, finishCreateTube, cancelCreateTube,
    finishCreatePatch, addCreateEdgePoint, createEdgeCuts, endCreateEdgeChain, finishCreateEdge, clearCreateEdge,
  };
}

export type TopologyTools = ReturnType<typeof createTopologyTools>;
