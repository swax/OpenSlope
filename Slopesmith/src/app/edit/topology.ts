import type { QuadMeshDoc, V3 } from '../../core/doc/types';
import {
  appendFreeEdge,
  appendGrid,
  appendTube,
  applySurfaceCut,
  autoWeldCreatedEdgeCrossings,
  ekey,
  gridCornersFromClicks,
  planGrid,
  resizeGridLength,
  resizeGridWidth,
  routeSurfaceCutPath,
  validateSurfaceCutPath,
  fillSelectedEdgeHoles,
  type GridPlanResult,
  type SurfaceCutPoint,
} from '../../core/mesh/ops';
import { applyLoft, railFromEdges, type RailResult } from '../../core/mesh/loft';
import {
  deleteSurfaceControls,
  createSurfaceFromProfiles,
  createSurfaceFromBoundary,
  rebuildSurface,
  placeSurfaceGuide,
  placeSurfacePoint,
  removeSurfacePoint,
  insertSurfaceRow,
  deleteSurfaceRow,
  bakeSurface as bakeSurfaceObject,
  deleteSurfaceObject,
  type SurfaceResult,
} from '../../core/mesh/surface-object';
import type { SurfaceAxis } from '../../core/math/spline-surface';
import { surfaceEditState } from '../state/surface-edit';
import { guideRows, guideCharts, readGuideCurves, surfaceGuideSnapTargets } from '../../core/mesh/surface-guides';
import {
  surfaceBoundaryDraft,
  surfaceBoundarySegmentLength,
  createSurfaceFromDrawnBoundary,
} from '../../core/mesh/surface-boundary';
import { cellMetrics } from '../../core/mesh/measure';
import { getVertex } from '../../core/doc/doc-edit';
import type { Store } from '../state/store';
import {
  canonicalNamedEdge,
  edgeIndex,
  edgeIndices,
  namedEdge,
  namedEdges,
  namedSurfaceCutPath,
  quadNames,
  surfaceCutPathIndices,
  vertexIndex,
  vertexIndices,
  vertexName,
  vertexNames,
  type NamedEdge,
  type VertexName,
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
  const out: NamedEdge[] = [],
    seen = new Set<string>();
  const push = (edge: NamedEdge) => {
    const key = edge.join('|');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(edge);
    }
  };
  for (const named of chain) {
    const at = edgeIndex(after, named);
    if (!at) continue;
    const [a, b] = at;
    if (adj.neighbors[a]?.includes(b)) {
      push(named);
      continue;
    }
    const previous = new Map<number, number>([[a, a]]),
      queue = [a];
    for (let i = 0; i < queue.length && !previous.has(b); i++)
      for (const n of adj.neighbors[queue[i]] ?? []) {
        if (previous.has(n) || (n !== b && !born(n))) continue;
        previous.set(n, queue[i]);
        queue.push(n);
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
  commitHistory?: () => void;
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
    store,
    viewport: getViewport,
    cageActive,
    applyCage,
    persistUi,
    scheduleRebuild,
    rebuildTools,
    updateCmdSheet,
    clearEdgeSelection,
    clearCellSelection,
    dropCornerSelection,
    exitRegion,
    seatMoveGizmo,
    resetGizmoMode,
  } = deps;
  const view = () => getViewport();
  const mdoc = () => editMesh(store); // the edit target: the mountain net, or the model being edited
  let guidePlacement: {
    id: string;
    axis: SurfaceAxis;
    row: number;
    mode: 'add' | 'move' | 'add-point' | 'move-point';
    point?: number;
    snappedPoints?: number;
  } | null = null;
  const railEdges = (rail: readonly VertexName[]): NamedEdge[] =>
    Array.from({ length: Math.max(0, rail.length - 1) }, (_, i) => canonicalNamedEdge(rail[i], rail[i + 1]));
  const railKey = (rail: readonly VertexName[]) => [...rail].sort().join(',');
  /** A Bridge session outlives the edits made between adopting one rail and the next, so its rails name the
   *  run they adopted; the preview and the loft take them as live indices (docs/039). */
  const railIndices = (rail: readonly VertexName[]) => vertexIndices(mdoc(), rail);
  const pushBridgeRails = () => view().setBridgeRails((store.bridgeRails ?? []).map(railIndices));
  /** A topology commit installs new stable ids in the document, but the viewport receives that document on
   * the scheduled render frame. Rebuild the selection-dependent toolbox only after that frame so its
   * measurement lookup resolves the newly created cells instead of falling through to the default panel. */
  const refreshCreatedCellSelection = () =>
    requestAnimationFrame(() => {
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
    if (store.modelEditId && rails.length && candidate.rail.length !== rails[0].length)
      return {
        ok: false,
        error: `The next rail needs ${rails[0].length} vertices; this selection has ${candidate.rail.length}.`,
      };
    const named = namedRail(candidate.rail);
    if (!named) return { ok: false, error: UNNAMEABLE_RAIL };
    if (rails.some(rail => railKey(rail) === railKey(named)))
      return { ok: false, error: 'That profile is already in this loft.' };
    return candidate;
  }

  function alignRail(rail: readonly VertexName[]): VertexName[] {
    const previous = store.bridgeRails?.[store.bridgeRails.length - 1];
    if (!previous) return [...rail];
    const at = railIndices(previous),
      here = railIndices(rail);
    if (at.length !== previous.length || here.length !== rail.length) return [...rail];
    const p0 = getVertex(mdoc(), at[0]),
      p1 = getVertex(mdoc(), at[at.length - 1]);
    const r0 = getVertex(mdoc(), here[0]),
      r1 = getVertex(mdoc(), here[here.length - 1]);
    const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return distance(p0, r1) + distance(p1, r0) < distance(p0, r0) + distance(p1, r1) ? [...rail].reverse() : [...rail];
  }

  function startBridge() {
    if (store.bridgeRails !== null) return;
    const seed = railFromEdges(edgeIndices(mdoc(), store.edgeSel));
    if (!seed.ok) {
      toast(seed.error, 'err');
      return;
    }
    const named = namedRail(seed.rail);
    if (!named) {
      toast(UNNAMEABLE_RAIL, 'err');
      return;
    }
    store.bridgeRails = [named];
    clearEdgeSelection();
    pushBridgeRails();
    rebuildTools();
    updateCmdSheet();
    toast('Surface from profiles — select the next profile curve, then press A to add it', 'info');
  }

  function addBridgeRail() {
    if (store.bridgeRails === null) return;
    const candidate = bridgeCandidate();
    if (!candidate.ok) {
      toast(candidate.error, 'err');
      return;
    }
    const named = namedRail(candidate.rail);
    if (!named) {
      toast(UNNAMEABLE_RAIL, 'err');
      return;
    }
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
    if (refresh) {
      rebuildTools();
      updateCmdSheet();
    }
  }

  function completeBridge() {
    const rails = store.bridgeRails;
    if (!rails || rails.length < 2) {
      toast('Add at least two profiles before creating the loft.', 'err');
      return;
    }
    const resolved = rails.map(railIndices);
    if (resolved.some((rail, at) => rail.length !== rails[at].length)) {
      toast('This loft names points the mountain no longer carries — select its profiles again.', 'err');
      return;
    }
    const before = mdoc().quads.length;
    const result = store.modelEditId
      ? applyLoft(mdoc(), resolved, {
          preserveRailOrder: true,
          targetPatchM: store.bridgePatchM,
          connectionCurve: store.bridgeCurve,
        })
      : createSurfaceFromProfiles(mdoc(), resolved, { patchSizeM: store.bridgePatchM, curvature: store.bridgeCurve });
    if (!result.ok) {
      toast(result.error, 'err');
      return;
    }
    commitEditMesh(store, result.doc);
    const cells =
      'surface' in result ? [] : Array.from({ length: result.doc.quads.length - before }, (_, i) => before + i);
    store.bridgeRails = null;
    view().setBridgeRails(null);
    view().setLoftPreview(null);
    clearEdgeSelection();
    dropCornerSelection();
    clearCellSelection();
    store.cellSel = quadNames(mdoc(), cells);
    store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode();
    scheduleRebuild();
    if ('surface' in result) selectSurfaceControls(result.surface.id);
    else refreshCreatedCellSelection();
    const patchCount = 'surface' in result ? result.surface.patches.length : cells.length;
    toast(`surface created · ${rails.length} profiles · ${patchCount} patches`, 'ok');
  }

  function selectSurfaceControls(id: string, axis?: SurfaceAxis, row?: number, point?: number) {
    if (guidePlacement) cancelSurfaceGuidePlacement(false);
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (!surface) return;
    clearCellSelection();
    dropCornerSelection();
    clearEdgeSelection();
    exitRegion();
    store.controlSel = [];
    view().setControlPointSelection([]);
    let names =
      axis && row !== undefined
        ? surface.guides
          ? (surface.controls[
              guideRows(surface, axis)[Math.max(0, Math.min(row, guideRows(surface, axis).length - 1))]
            ] ?? surface.controls.flat())
          : axis === 'U'
            ? surface.controls.map(line => line[Math.max(0, Math.min(row, line.length - 1))])
            : surface.controls[Math.max(0, Math.min(row, surface.controls.length - 1))]
        : surface.controls.flat();
    if (point !== undefined) names = names[point] ? [names[point]] : [];
    store.regionSel = [...new Set(names)];
    store.anchorCorner = names[0] ?? null;
    if (axis && row !== undefined)
      Object.assign(surfaceEditState(store, id), { axis, row, ...(point === undefined ? {} : { point }) });
    const refresh = () => {
      const doc = mdoc(),
        indices = vertexIndices(doc, store.regionSel);
      view().setCornerGroup(
        indices.map(i => getVertex(doc, i)),
        indices,
      );
      seatMoveGizmo();
      rebuildTools();
      updateCmdSheet();
    };
    // Row edits can replace every source id. Seat the gizmo after the queued render installs that cage.
    requestAnimationFrame(refresh);
  }

  function finishSurface(result: SurfaceResult, axis?: SurfaceAxis, row?: number, point?: number) {
    if (!result.ok) {
      toast(result.error, 'err');
      rebuildTools();
      return;
    }
    commitEditMesh(store, result.doc);
    scheduleRebuild();
    selectSurfaceControls(result.surface.id, axis, row, point);
    if (result.deviationM !== undefined)
      toast('Row removed · maximum deviation ' + result.deviationM.toFixed(3) + ' m', 'ok');
  }

  function updateSurface(id: string, values: { name?: string; patchSizeM?: number }) {
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (surface) {
      const next = { ...surface, ...values };
      finishSurface(
        values.patchSizeM === undefined
          ? {
              ok: true,
              doc: { ...mdoc(), surfaces: mdoc().surfaces!.map(s => (s.id === id ? next : s)) },
              surface: next,
            }
          : rebuildSurface(mdoc(), next),
      );
    }
  }
  function selectSurfaceRow(id: string, axis: SurfaceAxis, row: number) {
    selectSurfaceControls(id, axis, row);
  }
  function addSurfaceRow(id: string, axis: SurfaceAxis, row: number) {
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (surface) {
      const result = insertSurfaceRow(mdoc(), surface, axis, row);
      const selected =
        result.ok && result.surface.guides
          ? guideRows(result.surface, axis).indexOf(result.surface.guides.length - 1)
          : row + 1;
      finishSurface(result, axis, selected);
    }
  }
  function cancelSurfaceGuidePlacement(restore = true) {
    const current = guidePlacement;
    if (!current) return;
    guidePlacement = null;
    view().setSurfaceGuidePlacement?.(null);
    if (restore && current) selectSurfaceControls(current.id, current.axis, current.row, current.point);
    rebuildTools();
    updateCmdSheet();
  }
  function beginSurfaceGuidePlacement(
    id: string,
    axis: SurfaceAxis,
    row: number,
    mode: 'add' | 'move' | 'add-point' | 'move-point',
    point?: number,
  ) {
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (!surface?.guides || !view().setSurfaceGuidePlacement) return;
    try {
      const ordered = guideRows(surface, axis),
        replace = mode === 'move' ? ordered[row] : undefined;
      const isPoint = mode.endsWith('-point'),
        curve = ordered[row],
        moving = mode === 'move' || mode === 'move-point';
      if (isPoint && curve === undefined) throw new Error('Select a curve for this point.');
      if (mode === 'move' && replace === undefined) throw new Error('Select a curve to reposition.');
      const stampOf = (surface: NonNullable<QuadMeshDoc['surfaces']>[number]) =>
        JSON.stringify({ surface, curves: readGuideCurves(mdoc(), surface) }, (_key, value) =>
          typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value,
        );
      const stamp = stampOf(surface);
      const knots = isPoint ? surface.guides[curve].knots : ordered.map(i => surface.guides![i].at);
      const index = isPoint ? (point ?? 0) : row;
      const stations = knots.filter((_, i) => !moving || i !== index);
      const start = knots[index];
      const initial = moving
        ? start!
        : start === undefined
          ? 0.5
          : start < 1 - 1e-8
            ? (start + (knots[index + 1] ?? 1)) / 2
            : (start + (knots[index - 1] ?? 0)) / 2;
      guidePlacement = { id, axis, row, mode, point };
      view().setSurfaceGuidePlacement!({
        charts: guideCharts(mdoc(), surface),
        axis,
        stations,
        initial,
        ...(!isPoint
          ? {
              snapTargets: surfaceGuideSnapTargets(mdoc(), surface, axis),
              onSnap: (count: number) => {
                if (guidePlacement) guidePlacement.snappedPoints = count;
              },
            }
          : {}),
        ...(isPoint ? { pointOn: { axis, at: surface.guides[curve].at } } : {}),
        cancel: () => cancelSurfaceGuidePlacement(),
        commit: at => {
          guidePlacement = null;
          try {
            const latest = mdoc().surfaces?.find(s => s.id === id);
            if (!latest || stamp !== stampOf(latest)) {
              toast('The surface changed while placing the guide. Start placement again.', 'info');
              selectSurfaceControls(id, axis, row);
              rebuildTools();
              updateCmdSheet();
              return;
            }
            const result = isPoint
              ? placeSurfacePoint(mdoc(), latest, curve, at, mode === 'move-point' ? point : undefined)
              : placeSurfaceGuide(mdoc(), latest, axis, at, replace);
            const selected =
              result.ok && result.surface === latest
                ? row
                : result.ok
                  ? guideRows(result.surface, axis).indexOf(result.surface.guides!.length - 1)
                  : row;
            const selectedPoint =
              isPoint && result.ok
                ? result.surface.guides![curve].knots.findIndex(t => Math.abs(t - at) < 1e-8)
                : undefined;
            finishSurface(result, axis, isPoint ? row : Math.max(0, selected), selectedPoint);
          } catch (error) {
            toast(error instanceof Error ? error.message : String(error), 'err');
            rebuildTools();
            updateCmdSheet();
          }
        },
      });
      rebuildTools();
      updateCmdSheet();
    } catch (error) {
      guidePlacement = null;
      toast(error instanceof Error ? error.message : String(error), 'err');
    }
  }
  function removeSurfaceRow(id: string, axis: SurfaceAxis, row: number) {
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (surface) finishSurface(deleteSurfaceRow(mdoc(), surface, axis, row), axis, Math.max(0, row - 1));
  }
  function removeSurfaceControlPoint(id: string, axis: SurfaceAxis, row: number, point: number) {
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (surface?.guides)
      finishSurface(
        removeSurfacePoint(mdoc(), surface, guideRows(surface, axis)[row], point),
        axis,
        row,
        Math.max(0, point - 1),
      );
  }
  function deleteSurfaceCurve(id: string, axis: SurfaceAxis, row: number) {
    deps.commitHistory?.();
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (!surface?.guides) return;
    finishSurface(
      deleteSurfaceControls(mdoc(), surface, { curves: [guideRows(surface, axis)[row]] }),
      axis,
      Math.max(0, row - 1),
    );
    deps.commitHistory?.();
  }
  function deleteSurfaceControlPoint(id: string, axis: SurfaceAxis, row: number, point: number) {
    deps.commitHistory?.();
    const surface = mdoc().surfaces?.find(s => s.id === id);
    if (!surface?.guides) return;
    finishSurface(
      deleteSurfaceControls(mdoc(), surface, { points: [surface.controls[guideRows(surface, axis)[row]][point]] }),
      axis,
      row,
      Math.max(0, point - 1),
    );
    deps.commitHistory?.();
  }
  function createBoundarySurface(corners?: number[]) {
    finishSurface(createSurfaceFromBoundary(mdoc(), edgeIndices(mdoc(), store.edgeSel), corners, store.bridgePatchM));
  }
  function bakeSurface(id: string) {
    deps.commitHistory?.();
    commitEditMesh(store, bakeSurfaceObject(mdoc(), id));
    clearCellSelection();
    dropCornerSelection();
    clearEdgeSelection();
    exitRegion();
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    deps.commitHistory?.();
    toast('Surface baked — its terrain patches are now directly editable.', 'ok');
  }
  function deleteSurface(id: string) {
    const result = deleteSurfaceObject(mdoc(), id);
    if (!result.ok) {
      toast(result.error, 'err');
      return;
    }
    commitEditMesh(store, result.doc);
    clearCellSelection();
    dropCornerSelection();
    clearEdgeSelection();
    exitRegion();
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    toast('Surface deleted · original sketch curves retained.', 'ok');
  }

  function createPatchesFromEdges() {
    const doc = mdoc(),
      selected = edgeIndices(doc, store.edgeSel);
    if (selected.length !== store.edgeSel.length) {
      toast('Some selected edges no longer exist — select the hole boundaries again.', 'err');
      return;
    }
    const result = fillSelectedEdgeHoles(doc, selected);
    if (!result.ok) {
      toast(result.error, 'err');
      return;
    }
    commitEditMesh(store, result.doc);
    clearEdgeSelection();
    dropCornerSelection();
    clearCellSelection();
    store.cellSel = quadNames(mdoc(), result.quads);
    store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode();
    scheduleRebuild();
    refreshCreatedCellSelection();
    toast(
      `${result.quads.length} ${result.quads.length === 1 ? 'patch' : 'patches'} created` +
        (result.skipped ? ` · ${result.skipped} invalid ${result.skipped === 1 ? 'loop' : 'loops'} skipped` : ''),
      'ok',
    );
  }

  function armCreateEdge() {
    if (!store.cageOn) {
      store.cageOn = true;
      applyCage();
      persistUi();
    }
    exitRegion();
    store.selectedCorner = null;
    store.selected = null;
    store.createEdgeTool = true;
    store.createEdgeStart = null;
    store.createEdgeChain = [];
    store.createEdgeSurfacePath = [];
    store.createEdgeSurfacePositions = [];
    store.surgeryTool = null;
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setSurgeryTool(null);
    view().setWeldTool(false);
    view().setCreateEdgeTool(true, null);
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    toast(
      'click any point or edge to start — keep clicking to extend — Esc starts a new strand — Enter to finish',
      'info',
    );
  }

  function armCreatePatch() {
    if (!store.cageOn) {
      store.cageOn = true;
      applyCage();
      persistUi();
    }
    exitRegion();
    store.selectedCorner = null;
    store.selected = null;
    store.surgeryTool = 'patch';
    store.createPatchQuads = [];
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setWeldTool(false);
    view().setCreatePatchSides(store.createPatchSides);
    view().setSurgeryTool('patch');
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    toast(
      store.createPatchSides === 3
        ? 'click 3 corners around each triangle — hold Shift to lock the next side to a world axis'
        : 'click 4 corners around each quad, or repeat any corner after the third to close a triangle — hold Shift for axis lock',
      'info',
    );
  }

  function armCreateTube() {
    if (!store.cageOn) {
      store.cageOn = true;
      applyCage();
      persistUi();
    }
    exitRegion();
    store.selectedCorner = null;
    store.selected = null;
    store.surgeryTool = 'tube';
    store.createPatchQuads = [];
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setWeldTool(false);
    view().setSurgeryTool('tube');
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    toast('click the two tube endpoints — hold Shift to lock the axis — adjust dimensions, then press Enter', 'info');
  }

  /** Loop Cut (docs/017): hover an edge, the strip through it previews, Alt+scroll slides it, a click cuts —
   *  and the tool stays armed for the next. Esc leaves it. */
  function armLoopCut() {
    if (!store.cageOn) {
      store.cageOn = true;
      applyCage();
      persistUi();
    }
    exitRegion();
    store.selectedCorner = null;
    store.selected = null;
    store.surgeryTool = 'loopcut';
    store.createPatchQuads = [];
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setWeldTool(false);
    view().setSurgeryTool('loopcut');
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    toast('hover an edge to preview the loop · Alt+scroll slides it · click to cut · Esc to finish', 'info');
  }

  function previewCreateTube() {
    const points = view().createTubePoints;
    if (points.length !== 2) {
      view().setLoftPreview(null);
      return null;
    }
    const result = appendTube(
      mdoc(),
      points[0],
      points[1],
      store.tubeWidth,
      store.tubeHeight,
      store.tubeSectionLength,
      store.tubeRingEdges,
    );
    if (!result.ok) {
      view().setLoftPreview(null);
      return result;
    }
    view().setLoftPreview(
      result.quads.map(quad => result.doc.quads[quad]),
      result.doc,
    );
    return result;
  }

  function finishCreateTube() {
    if (store.surgeryTool !== 'tube') return;
    const result = previewCreateTube();
    if (!result) {
      toast('Draw both tube endpoints before creating it.', 'err');
      return;
    }
    if (!result.ok) {
      toast(result.error, 'err');
      return;
    }
    commitEditMesh(store, result.doc);
    store.surgeryTool = null;
    view().setSurgeryTool(null);
    view().setLoftPreview(null);
    clearEdgeSelection();
    dropCornerSelection();
    clearCellSelection();
    store.cellSel = quadNames(mdoc(), result.quads);
    store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode();
    scheduleRebuild();
    refreshCreatedCellSelection();
    toast(
      `tube created · ${result.axialSections} × ${result.radialSections} sections · ${result.quads.length} patches`,
      'ok',
    );
  }

  function cancelCreateTube() {
    if (store.surgeryTool !== 'tube') return;
    store.surgeryTool = null;
    view().setSurgeryTool(null);
    view().setLoftPreview(null);
    rebuildTools();
    updateCmdSheet();
  }

  /** Create Grid's latest plan, kept so the panel's read-outs follow the cursor without planning twice a move. */
  let gridPlan: GridPlanResult | null = null;
  const surfaceSettings = { patchSizeM: 25 };
  let surfaceDraftError: string | null = null;
  let surfaceDraftArea: number | null = null,
    surfaceDraftEdgeLength: number | null = null;

  function armCreateSurface() {
    if (store.modelEditId) return;
    deps.commitHistory?.();
    clearCreateEdge();
    clearCellSelection();
    clearEdgeSelection();
    dropCornerSelection();
    exitRegion();
    store.controlSel = [];
    view().setControlPointSelection([]);
    store.selected = null;
    store.surgeryTool = 'surface';
    store.weldTool = null;
    view().setWeldTool(false);
    view().setEdgeWeldTool(null);
    surfaceDraftError = null;
    surfaceDraftArea = surfaceDraftEdgeLength = null;
    view().setSurgeryTool('surface');
    rebuildTools();
    updateCmdSheet();
    toast(
      'click around the boundary · click the first point to edit it · Enter creates the surface · Esc cancels',
      'info',
    );
  }
  function previewCreateSurface() {
    if (store.surgeryTool !== 'surface') return;
    const points = view().createSurfacePoints ?? [],
      hover = view().createSurfaceHover,
      closed = view().createSurfaceClosed,
      selected = view().createSurfaceSelectedPoint,
      boundary = hover && !closed && !view().createSurfaceClosing ? [...points, hover] : points;
    surfaceDraftError = null;
    surfaceDraftArea = surfaceDraftEdgeLength = null;
    const edge =
      selected !== null && selected !== undefined && points.length > 1
        ? [points[selected], points[(selected + 1) % points.length]]
        : hover && points.length
          ? [points.at(-1)!, hover]
          : closed && points.length
            ? [points.at(-1)!, points[0]]
            : points.length > 1
              ? points.slice(-2)
              : null;
    if (edge) surfaceDraftEdgeLength = surfaceBoundarySegmentLength(mdoc(), edge[0], edge[1]);
    if (boundary.length < 4) {
      view().setCreateSurfaceCharts?.(null);
      return;
    }
    try {
      const { charts } = surfaceBoundaryDraft(mdoc(), boundary);
      surfaceDraftArea = charts.reduce((area, chart) => area + cellMetrics(chart.controls).area, 0);
      view().setCreateSurfaceCharts?.(charts);
    } catch (error) {
      surfaceDraftError = error instanceof Error ? error.message : String(error);
      view().setCreateSurfaceCharts?.(null);
    }
  }
  function finishCreateSurface() {
    if (store.surgeryTool !== 'surface') return;
    deps.commitHistory?.();
    const result = createSurfaceFromDrawnBoundary(mdoc(), view().createSurfacePoints ?? [], surfaceSettings.patchSizeM);
    if (!result.ok) {
      surfaceDraftError = result.error;
      toast(result.error, 'err');
      rebuildTools();
      return;
    }
    store.surgeryTool = null;
    view().setSurgeryTool(null);
    surfaceDraftError = null;
    finishSurface(result);
    deps.commitHistory?.();
    toast(`surface created · ${result.surface.patches.length} terrain patches`, 'ok');
  }
  function cancelCreateSurface() {
    if (store.surgeryTool !== 'surface') return;
    store.surgeryTool = null;
    surfaceDraftError = null;
    view().setSurgeryTool(null);
    rebuildTools();
    updateCmdSheet();
  }
  function undoCreateSurfacePoint() {
    if (store.surgeryTool === 'surface') view().undoCreateSurfacePoint?.();
  }

  function armCreateGrid() {
    if (!store.cageOn) {
      store.cageOn = true;
      applyCage();
      persistUi();
    }
    exitRegion();
    store.selectedCorner = null;
    store.selected = null;
    store.surgeryTool = 'grid';
    store.createPatchQuads = [];
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setWeldTool(false);
    view().setSurgeryTool('grid');
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
    toast(
      'click both ends of the first side, then its width — snap to an edge’s points to attach — then press Enter',
      'info',
    );
  }

  /** Plan the grid from its draft corners — or, while the third is being placed, from the cursor standing in for
   *  it — and show the lattice in the teal preview. */
  function previewCreateGrid() {
    const points = view().createGridPoints,
      hover = view().createGridHover;
    const corners =
      view().createGridCorners ??
      (points.length === 2 && hover ? gridCornersFromClicks(points[0], points[1], hover) : null);
    gridPlan = corners
      ? planGrid(mdoc(), corners, {
          columns: store.gridColumns,
          rows: store.gridRows,
          patchSize: store.gridSizing === 'size' ? store.gridPatchSize : null,
          eye: view().createGridEye,
        })
      : null;
    if (gridPlan?.ok) view().setLoftPreview(gridPlan.plan.quads, gridPlan.plan.points.flat());
    else view().setLoftPreview(null);
    view().setCreateGridLattice(gridPlan?.ok ? gridPlan.plan : null);
    return gridPlan;
  }

  function finishCreateGrid() {
    if (store.surgeryTool !== 'grid') return;
    if (!view().createGridCorners) {
      toast('Place all three grid corners before creating it.', 'err');
      return;
    }
    const planned = previewCreateGrid();
    if (!planned?.ok) {
      if (planned) toast(planned.error, 'err');
      return;
    }
    const result = appendGrid(mdoc(), planned.plan);
    if (!result.ok) {
      toast(result.error, 'err');
      return;
    }
    commitEditMesh(store, result.doc);
    store.surgeryTool = null;
    gridPlan = null;
    view().setSurgeryTool(null);
    view().setLoftPreview(null);
    clearEdgeSelection();
    dropCornerSelection();
    clearCellSelection();
    store.cellSel = quadNames(mdoc(), result.quads);
    store.anchorCell = store.cellSel[0] ?? null;
    resetGizmoMode();
    scheduleRebuild();
    refreshCreatedCellSelection();
    toast(`grid created · ${planned.plan.columns} × ${planned.plan.rows} · ${result.quads.length} patches`, 'ok');
  }

  /** A typed size for the draft: the first side's length (B and C move along it) or the width (C and D move). */
  function setCreateGridLength(length: number) {
    const corners = view().createGridCorners;
    if (corners) view().setCreateGridCorners(resizeGridLength(corners, length));
  }
  function setCreateGridWidth(width: number) {
    const corners = view().createGridCorners;
    if (corners) view().setCreateGridCorners(resizeGridWidth(corners, width));
  }

  function cancelCreateGrid() {
    if (store.surgeryTool !== 'grid') return;
    store.surgeryTool = null;
    gridPlan = null;
    view().setSurgeryTool(null);
    view().setLoftPreview(null);
    rebuildTools();
    updateCmdSheet();
  }

  function finishCreatePatch(selectCreated: boolean) {
    if (store.surgeryTool !== 'patch') return;
    const created = [...store.createPatchQuads];
    store.surgeryTool = null;
    store.createPatchQuads = [];
    view().setSurgeryTool(null);
    clearEdgeSelection();
    dropCornerSelection();
    clearCellSelection();
    if (selectCreated && created.length) {
      store.cellSel = created;
      store.anchorCell = created[0];
      resetGizmoMode();
    }
    scheduleRebuild();
    if (selectCreated && created.length)
      requestAnimationFrame(() => {
        view().refreshEditCells();
        seatMoveGizmo();
      });
    rebuildTools();
    updateCmdSheet();
    if (created.length)
      toast(
        `${created.length} ${created.length === 1 ? 'patch' : 'patches'} created${selectCreated ? ' and selected' : ''}`,
        'ok',
      );
  }

  /** The surface cut a Create Edge point would continue from the chain's start: the path as drawn and its plan,
   *  and — for a single segment the drawn path cannot cross — the route across the strip of patches between.
   *  `route: false` skips that strip search. Shared by the click and by the hover's `createEdgeCuts`. */
  function surfaceCutCandidate(
    doc: QuadMeshDoc,
    start: NonNullable<Store['createEdgeStart']>,
    surfacePath: SurfaceCutPoint[],
    endpoint: CreateEdgeEndpoint,
    route = true,
  ) {
    const startVertex = start.vertex === null ? null : vertexIndex(doc, start.vertex);
    const endpointOnSurfaceEdge = endpoint.edge != null && isSurfaceEdge(doc, endpoint.edge);
    const endpointOnSurfaceVertex = endpoint.vertex !== null && doc.quads.some(q => q.includes(endpoint.vertex!));
    const endpointPoint: SurfaceCutPoint | null = endpointOnSurfaceVertex
      ? { vertex: endpoint.vertex! }
      : endpoint.edge && endpoint.t !== undefined && endpointOnSurfaceEdge
        ? { edge: endpoint.edge, t: endpoint.t }
        : null;
    const startOnSurface = startVertex !== null && doc.quads.some(q => q.includes(startVertex));
    const path: SurfaceCutPoint[] | null =
      endpointPoint && (surfacePath.length || startOnSurface)
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
    const candidate = surfaceCutCandidate(
      doc,
      start,
      surfaceCutPathIndices(doc, store.createEdgeSurfacePath),
      endpoint,
      fromJunction,
    );
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
        if (!plan.ok) {
          toast(plan.error, 'err');
          return;
        }
        const named = namedEdge(doc, endpoint.edge);
        if (!named) return;
        store.createEdgeSurfacePath = [{ edge: named, t: endpoint.t }];
        store.createEdgeSurfacePositions = [[...endpoint.pos] as V3];
        store.createEdgeStart = { vertex: null, pos: [...endpoint.pos] as V3, edge: named, t: endpoint.t };
        view().setCreateEdgeStart(store.createEdgeStart.pos);
        view().setCreateEdgePath(store.createEdgeSurfacePositions);
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
      view().setCreateEdgeStart(store.createEdgeStart.pos);
      rebuildTools();
      return;
    }
    const startEdge = start.edge ? edgeIndex(doc, start.edge) : null;
    const {
      startVertex,
      startOnSurface,
      endpointOnSurfaceEdge,
      endpointPoint,
      path: candidateSurfacePath,
      plan: candidateSurfacePlan,
      routed: routedSurfacePath,
    } = surfaceCutCandidate(doc, start, surfacePath, endpoint);
    const cutEnd = endpoint.vertex;
    const sharePatch =
      startOnSurface && cutEnd !== null && doc.quads.some(q => q.includes(startVertex!) && q.includes(cutEnd));
    const endpointEdgeSharesPatch =
      startOnSurface &&
      endpoint.edge != null &&
      endpointOnSurfaceEdge &&
      doc.quads.some(q => q.includes(startVertex!) && quadHasEdge(q, endpoint.edge!));
    const directSurfaceIntent = candidateSurfacePlan?.ok === true || routedSurfacePath !== null;
    const surfaceIntent = surfacePath.length > 0 || sharePatch || endpointEdgeSharesPatch || directSurfaceIntent;
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
            view().setCreateEdgeStart(store.createEdgeStart.pos);
            view().setCreateEdgePath(store.createEdgeSurfacePositions);
            rebuildTools();
            toast('surface cut is provisional · continue to another edge or existing point', 'info');
            return;
          }
          const result = applySurfaceCut(doc, path);
          if (!result.ok) {
            toast(result.error, 'err');
            return;
          }
          const automatic = autoWeldCreatedEdgeCrossings(result.doc, result.edges);
          commitEditMesh(store, automatic.doc);
          store.createEdgeChain = traceSplitChain(doc, mdoc(), [
            ...store.createEdgeChain,
            ...namedEdges(mdoc(), automatic.edges),
          ]);
          store.edgeSel = [...store.createEdgeChain];
          store.anchorEdge = store.edgeSel[0] ?? null;
          store.createEdgeSurfacePath = [];
          store.createEdgeSurfacePositions = [];
          store.createEdgeStart = { vertex: vertexName(mdoc(), result.endVertex), pos: [...endpoint.pos] as V3 };
          view().setCreateEdgeStart(store.createEdgeStart.pos);
          view().setCreateEdgePath([]);
          scheduleRebuild();
          rebuildTools();
          toast(
            `surface cut complete · ${automatic.edges.length} ${automatic.edges.length === 1 ? 'edge' : 'edges'}${result.wedges ? ` · ${result.wedges} temporary ${result.wedges === 1 ? 'wedge' : 'wedges'}` : ''}${automatic.welded ? ` · ${automatic.welded} crossing ${automatic.welded === 1 ? 'auto-welded' : 'crossings auto-welded'}` : ''}`,
            'ok',
          );
          return;
        }
        if (!canFallBackToFree) {
          toast(plan.error, 'err');
          return;
        }
      } else if (!canFallBackToFree) {
        toast('Continue the surface cut across an edge, or finish it on an existing point.', 'err');
        return;
      }
      // A surface-edge start followed by a point outside either incident patch is an ordinary construction
      // edge. Keep its exact curve contact as a separate id; the T-junction diagnostic explains the unresolved
      // topology after the chain finishes instead of blocking the draft.
      store.createEdgeSurfacePath = [];
      store.createEdgeSurfacePositions = [];
      view().setCreateEdgePath([]);
    }
    const from =
      startVertex ?? (startEdge && start.t !== undefined ? { pos: start.pos, edge: startEdge, t: start.t } : start.pos);
    const to =
      endpoint.vertex ??
      (endpoint.edge && endpoint.t !== undefined
        ? { pos: endpoint.pos, edge: endpoint.edge, t: endpoint.t }
        : endpoint.pos);
    const result = appendFreeEdge(doc, from, to);
    if (!result.ok) {
      toast(result.error, 'err');
      return;
    }
    const automatic = autoWeldCreatedEdgeCrossings(result.doc, [result.edge]);
    commitEditMesh(store, automatic.doc);
    store.createEdgeChain = traceSplitChain(doc, mdoc(), [
      ...store.createEdgeChain,
      ...namedEdges(mdoc(), automatic.edges),
    ]);
    store.edgeSel = [...store.createEdgeChain];
    store.anchorEdge = store.edgeSel[0] ?? null;
    const endVertex = endpoint.vertex ?? result.appendedVertices[result.appendedVertices.length - 1];
    store.createEdgeStart = { vertex: vertexName(mdoc(), endVertex), pos: [...endpoint.pos] as V3 };
    view().setCreateEdgeStart(store.createEdgeStart.pos);
    scheduleRebuild();
    rebuildTools();
    if (automatic.welded)
      toast(`${automatic.welded === 1 ? 'crossing' : `${automatic.welded} crossings`} auto-welded`, 'ok');
  }

  /** Esc's first press: end the strand being drawn but keep the tool armed, so a web of separate strands is
   *  drawn without re-arming, and its edges stay collected for the final selection. False when no strand is
   *  under way — Esc then leaves the tool. */
  function endCreateEdgeChain(): boolean {
    if (!store.createEdgeTool || !store.createEdgeStart) return false;
    store.createEdgeStart = null;
    store.createEdgeSurfacePath = [];
    store.createEdgeSurfacePositions = [];
    view().setCreateEdgeStart(null);
    view().setCreateEdgePath([]);
    rebuildTools();
    return true;
  }

  function finishCreateEdge() {
    if (!store.createEdgeTool) return;
    store.createEdgeTool = false;
    store.createEdgeStart = null;
    store.createEdgeSurfacePath = [];
    store.createEdgeSurfacePositions = [];
    store.edgeSel = [...store.createEdgeChain];
    store.anchorEdge = store.edgeSel[0] ?? null;
    store.createEdgeChain = [];
    view().setCreateEdgeTool(false, null);
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
  }

  function clearCreateEdge() {
    store.createEdgeTool = false;
    store.createEdgeStart = null;
    store.createEdgeChain = [];
    store.createEdgeSurfacePath = [];
    store.createEdgeSurfacePositions = [];
    view().setCreateEdgeTool(false, null);
  }

  return {
    armCreateSurface,
    previewCreateSurface,
    finishCreateSurface,
    cancelCreateSurface,
    undoCreateSurfacePoint,
    createSurfaceSettings: () => surfaceSettings,
    createSurfaceStatus: () => ({
      points: view().createSurfacePoints?.length ?? 0,
      closed: view().createSurfaceClosed ?? false,
      selected: view().createSurfaceSelectedPoint ?? null,
      error: surfaceDraftError,
      area: surfaceDraftArea,
      edgeLength: surfaceDraftEdgeLength,
    }),
    beginSurfaceGuidePlacement,
    cancelSurfaceGuidePlacement,
    surfaceGuidePlacement: () => guidePlacement,
    updateSurface,
    selectSurfaceControls,
    selectSurfaceRow,
    addSurfaceRow,
    removeSurfaceRow,
    removeSurfaceControlPoint,
    deleteSurfaceCurve,
    deleteSurfaceControlPoint,
    createBoundarySurface,
    bakeSurface,
    deleteSurface,
    bridgeCandidate,
    startBridge,
    addBridgeRail,
    reverseBridgeRail,
    removeBridgeRail,
    moveBridgeRail,
    cancelBridge,
    completeBridge,
    createPatchesFromEdges,
    armCreateEdge,
    armCreatePatch,
    armLoopCut,
    armCreateTube,
    previewCreateTube,
    finishCreateTube,
    cancelCreateTube,
    armCreateGrid,
    previewCreateGrid,
    finishCreateGrid,
    cancelCreateGrid,
    setCreateGridLength,
    setCreateGridWidth,
    createGridPlan: () => gridPlan,
    finishCreatePatch,
    addCreateEdgePoint,
    createEdgeCuts,
    endCreateEdgeChain,
    finishCreateEdge,
    clearCreateEdge,
  };
}

export type TopologyTools = ReturnType<typeof createTopologyTools>;
