import type { V3 } from '../../core/doc/types';
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
import { applyTrailSpline, MESA_TRAIL_TEXTURES } from '../../core/mesh/trail';
import { railBezierSegments } from '../../core/rails/rails';

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
    toast('click any point or edge to start — keep clicking to extend — Enter / Esc to finish', 'info');
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

  function armCreateTrail() {
    if (store.modelEditId) { toast('Create Trail builds mountain terrain, not a prop model.', 'err'); return; }
    if (!store.cageOn) { store.cageOn = true; applyCage(); persistUi(); }
    exitRegion();
    store.selectedCorner = null; store.selected = null;
    store.surgeryTool = 'trail'; store.createPatchQuads = [];
    store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    view().setWeldTool(false);
    view().setCreateTrailSurfaceLift(store.trailSurfaceLift);
    view().setSurgeryTool('trail');
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('click centre-spline knots · hold Shift to axis-lock · tune the trail, then press Enter', 'info');
  }

  function previewCreateTrail() {
    const points = [...view().createTrailPoints];
    if (points.length < 2) { view().setLoftPreview(null); return null; }
    const result = applyTrailSpline(mdoc(), railBezierSegments(points), {
      widthM: store.trailWidth,
      centerBias: store.trailCenterBias,
      dishFraction: store.trailDishPercent / 100,
      maxPatchLengthM: store.trailPatchLength,
      minPatchLengthM: Math.min(9.5, store.trailPatchLength * 0.45),
      maxTurnDegrees: store.trailMaxTurnDegrees,
      bankGainM: store.trailBankGain,
      maxBankDegrees: store.trailMaxBankDegrees,
      maxBankStepDegrees: 20,
      surface: 1,
      textures: store.trailMesaTextures ? MESA_TRAIL_TEXTURES : undefined,
    });
    if (!result.ok) { view().setLoftPreview(null); return result; }
    view().setLoftPreview(result.quads.map(quad => result.doc.quads[quad]), result.doc);
    return result;
  }

  function undoCreateTrailPoint() {
    if (store.surgeryTool !== 'trail') return;
    view().removeLastCreateTrailPoint();
  }

  function finishCreateTrail() {
    if (store.surgeryTool !== 'trail') return;
    const result = previewCreateTrail();
    if (!result) { toast('Place at least two centre-spline knots before creating the trail.', 'err'); return; }
    if (!result.ok) { toast(result.error, 'err'); return; }
    const knots = view().createTrailPoints.length;
    // Capture stable names from the exact generated document before installing it. This makes the committed
    // ribbon—not the spline knots or any prior terrain selection—the one replacement selection after create.
    const created = quadNames(result.doc, result.quads);
    commitEditMesh(store, result.doc);
    store.surgeryTool = null;
    view().setSurgeryTool(null); view().setLoftPreview(null);
    clearEdgeSelection(); dropCornerSelection(); clearCellSelection();
    store.cellSel = created; store.anchorCell = created[0] ?? null;
    resetGizmoMode(); scheduleRebuild();
    refreshCreatedCellSelection();
    toast(`trail created and selected · ${knots} spline knots · ${result.spans.length} spans · ${created.length} patches`, 'ok');
  }

  function cancelCreateTrail() {
    if (store.surgeryTool !== 'trail') return;
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

  function addCreateEdgePoint(endpoint: CreateEdgeEndpoint) {
    if (!store.createEdgeTool) return;
    const doc = mdoc();
    const quadHasEdge = (q: number[], edge: [number, number]) => {
      const perimeter = quadPerimeterEdges(q);
      return perimeter.some(([a, b]) => a !== b && ekey(a, b) === ekey(edge[0], edge[1]));
    };
    const isSurfaceEdge = (edge: [number, number]) => doc.quads.some(q => quadHasEdge(q, edge));
    // The chain commits a topology edit per click, so the pending start and the provisional route are held by
    // NAME and resolved fresh here: a cut that splits a patch renumbers the very edge the route is standing on.
    const surfacePath = surfaceCutPathIndices(doc, store.createEdgeSurfacePath);
    const start = store.createEdgeStart;
    if (!start) {
      if (endpoint.edge && endpoint.t !== undefined && isSurfaceEdge(endpoint.edge)) {
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
    const startVertex = start.vertex === null ? null : vertexIndex(doc, start.vertex);
    const startEdge = start.edge ? edgeIndex(doc, start.edge) : null;
    const endpointOnSurfaceEdge = endpoint.edge != null && isSurfaceEdge(endpoint.edge);
    const endpointOnSurfaceVertex = endpoint.vertex !== null && doc.quads.some(q => q.includes(endpoint.vertex!));
    const endpointPoint: SurfaceCutPoint | null = endpointOnSurfaceVertex
      ? { vertex: endpoint.vertex! }
      : endpoint.edge && endpoint.t !== undefined && endpointOnSurfaceEdge ? { edge: endpoint.edge, t: endpoint.t } : null;
    const cutEnd = endpoint.vertex;
    const startOnSurface = startVertex !== null && doc.quads.some(q => q.includes(startVertex));
    const sharePatch = startOnSurface && cutEnd !== null
      && doc.quads.some(q => q.includes(startVertex) && q.includes(cutEnd));
    const endpointEdgeSharesPatch = startOnSurface && endpoint.edge != null && endpointOnSurfaceEdge
      && doc.quads.some(q => q.includes(startVertex!) && quadHasEdge(q, endpoint.edge!));
    const candidateSurfacePath: SurfaceCutPoint[] | null = endpointPoint && (surfacePath.length || startOnSurface)
      ? surfacePath.length
        ? [...surfacePath, endpointPoint]
        : [{ vertex: startVertex! }, endpointPoint]
      : null;
    const candidateSurfacePlan = candidateSurfacePath ? validateSurfaceCutPath(doc, candidateSurfacePath) : null;
    const routedSurfacePath = candidateSurfacePath?.length === 2 && candidateSurfacePlan && !candidateSurfacePlan.ok
      ? routeSurfaceCutPath(doc, candidateSurfacePath[0], candidateSurfacePath[1])
      : null;
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
          store.createEdgeChain.push(...namedEdges(mdoc(), automatic.edges));
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
    store.createEdgeChain.push(...namedEdges(mdoc(), automatic.edges));
    store.edgeSel = [...store.createEdgeChain]; store.anchorEdge = store.edgeSel[0] ?? null;
    const endVertex = endpoint.vertex ?? result.appendedVertices[result.appendedVertices.length - 1];
    store.createEdgeStart = { vertex: vertexName(mdoc(), endVertex), pos: [...endpoint.pos] as V3 };
    view().setCreateEdgeStart(store.createEdgeStart.pos);
    scheduleRebuild(); rebuildTools();
    if (automatic.welded) toast(`${automatic.welded === 1 ? 'crossing' : `${automatic.welded} crossings`} auto-welded`, 'ok');
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
    createPatchesFromEdges, armCreateEdge, armCreatePatch, armCreateTube, previewCreateTube, finishCreateTube, cancelCreateTube,
    armCreateTrail, previewCreateTrail, undoCreateTrailPoint, finishCreateTrail, cancelCreateTrail,
    finishCreatePatch, addCreateEdgePoint, finishCreateEdge, clearCreateEdge,
  };
}

export type TopologyTools = ReturnType<typeof createTopologyTools>;
