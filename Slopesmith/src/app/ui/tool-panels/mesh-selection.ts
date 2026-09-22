import { editMesh } from '../../edit/mesh-target';
import type GUI from 'lil-gui';
import type { QuadMeshDoc } from '../../../core/doc/types';
import { meshVertexCanSmooth } from '../../../core/doc/mountain';
import { buildQuadMesh, meshAdjacency, vertexValence } from '../../../core/mesh/topology';
import { quadVerts } from '../../../core/doc/doc-edit';
import type { SelectionMeasure } from '../../../core/mesh/measure';
import { railFromEdges } from '../../../core/mesh/loft';
import { applyCellEdgeInsert, applyEdgeCrossingWeld, applyMeshDissolve, applyVertexWeld, boundaryEdgeLoopVertices } from '../../../core/mesh/ops';
import { findTJunctions, T_JUNCTION_TOLERANCE_M } from '../../../core/mesh/t-junctions';
import {
  coincidentVertexIndices, edgeCrossingIndex, edgeIndices, quadIndices, vertexIndices, vertexNames,
  type VertexName,
} from '../../state/mesh-names';
import { actionPair, detail, errorBanner, tip } from '../components/gui';
import { fmtArea, fmtM, type ToolsContext } from './widgets';

// The regional solver remains implemented for benchmark iteration, but its editor entry point stays hidden
// until repeated solves and every protected-interface shape are production-safe.
const SELECTED_RETOPOLOGY_VISIBLE = false;

/**
 * The Edit-mode selection toolbox: the measurement read-outs and the shape / topology / visibility actions for
 * the current mesh selection — authored corners, control points, edges and patches, plus the read-only
 * reference picks — with every branch ending in the shared Deselect row.
 */
export function createMeshSelectTools(ctx: ToolsContext, openSelectedRetopology?: () => void,
  buildLabelAssignment?: () => void) {
  const { store, viewport, editSection, edit } = ctx;
  const {
    deselectEdit, copySelectedVertices, cutSelectedVertices, copySelectionVertexCount,
    hideSelectedMesh, showAllHidden, hiddenMeshCount, toggleSelectedControlCages, selectedControlCagesVisible, canEditCurvature,
    selectedPatchLockState, toggleSelectedPatchLocks,
    selectConnected, selectOverlappingVertices,
    deleteSelectedMesh, dissolveSelectedMesh, flipSelectedMesh, meshDeleteTargetCount, canDeleteMeshSelection,
    ripEdges, insertCellEdge, resetCellShape, creaseVertices, smoothVertices, createPatchesFromEdges,
    startBridge, beginEdgeExtrusion, beginPointWeld, beginEdgeWeld, weldSelectedEdgeCrossing, weldSelectedCoincidentVertices,
  } = edit;

  /** Render an authored or read-only reference mesh selection. Returns true when a selection owned the panel.
   *  Every branch ends with the shared Deselect button, after all selection-specific details and actions. */
  function renderVertexValence(g: GUI, vertices: readonly { vertex: number; valence: number }[]) {
    if (!vertices.length) return;
    if (vertices.length === 1) { detail(g, `${vertices[0].valence}`, 'valence'); return; }
    const counts = new Map<number, number>();
    for (const vertex of vertices) counts.set(vertex.valence, (counts.get(vertex.valence) ?? 0) + 1);
    detail(g, [...counts].sort(([a], [b]) => a - b)
      .map(([valence, count]) => `${count} × ${valence}`).join(' · '), 'valence');
  }

  function authoredVertexInfo(mdoc: QuadMeshDoc, vertices: readonly VertexName[]) {
    const adj = meshAdjacency(buildQuadMesh(mdoc.vertices, mdoc.quads, mdoc.freeEdges));
    return [...new Set(vertexIndices(mdoc, vertices))].map(vertex => ({ vertex, valence: vertexValence(adj, vertex) }));
  }

  function addTJunctionWarning(g: GUI, mdoc: QuadMeshDoc, vertices: readonly VertexName[]) {
    const count = new Set(findTJunctions(mdoc, T_JUNCTION_TOLERANCE_M, vertexIndices(mdoc, vertices))
      .map(junction => junction.vertex)).size;
    if (!count) return;
    errorBanner(g, count === 1
      ? 'T-JUNCTION — this point is embedded in an unsplit patch edge. Complete the neighboring cut to resolve it.'
      : `${count} T-JUNCTIONS — these points are embedded in unsplit patch edges and can be resolved by completing their neighboring cuts.`);
  }

  function buildMeshSelectionTools(mdoc: QuadMeshDoc): boolean {
    // Selection measurements — the SAME read-out for the authored net and the read-only reference, because
    // both are a QuadMesh + EdgeHandle measured through one core (core/mesh/measure.ts): an edge shows its curved
    // length, a cell its down-slope length × width, vertical drop and surface area. The authored selection is
    // in the store; the reference's is viewport-owned (refMeasure), so a change to the read-out serves both.
    // Authored wins when both somehow coexist.
    const coincident = store.selectedCoincidentVertices;
    if (coincident) {
      const selection = editSection('selection', 'Selection');
      errorBanner(selection, 'COINCIDENT POINTS — two separate vertex IDs occupy effectively the same location but are not welded.');
      detail(selection, `${coincident.distance.toFixed(3)} m`, 'gap');
      const pair = coincidentVertexIndices(mdoc, coincident);
      detail(selection, (pair ?? coincident.vertices).join(' + '), 'points');
      const topology = editSection('topology', 'Topology');
      const survivor = pair ? Math.min(...pair) : -1, removed = pair ? Math.max(...pair) : -1;
      const result = pair
        ? applyVertexWeld(mdoc, [[removed, survivor]])
        : { ok: false as const, error: 'Those points are no longer part of this mountain — select the pair again.' };
      const weld = tip(topology.add({ weld: weldSelectedCoincidentVertices }, 'weld').name('weld points'), result.ok
        ? `Merge both IDs into point ${survivor}, preserving all incident edges and patches.`
        : result.error);
      if (!result.ok) weld.disable();
      addDeselect(selection);
      return true;
    }

    const edgeCrossing = store.selectedEdgeCrossing;
    if (edgeCrossing) {
      const selection = editSection('selection', 'Selection');
      errorBanner(selection, edgeCrossing.kind === 'crossing'
        ? 'EDGE CROSSING — two unconnected edges pass through each other without a shared vertex.'
        : 'NEAR-OVERLAP — two unconnected edges run nearly parallel within the diagnostic tolerance.');
      detail(selection, `${edgeCrossing.distance.toFixed(3)} m`, 'gap');
      const crossing = edgeCrossingIndex(mdoc, edgeCrossing);
      detail(selection, (crossing ?? edgeCrossing).edges.map(([a, b]) => `${a}–${b}`).join(' × '), 'edges');
      const topology = editSection('topology', 'Topology');
      const result = crossing
        ? applyEdgeCrossingWeld(mdoc, crossing)
        : { ok: false as const, error: 'Those edges are no longer part of this mountain — select the crossing again.' };
      const weld = tip(topology.add({ weld: weldSelectedEdgeCrossing }, 'weld').name('create vertex + weld'), result.ok
        ? 'Insert one shared vertex at the closest point, split both edges there, and weld them into one connected junction.'
        : result.error);
      if (!result.ok) weld.disable();
      addDeselect(selection);
      return true;
    }

    const refPoints = viewport.referenceControlPointSelectionCount();
    const refVertices = viewport.referenceVertexSelectionCount();
    if (refPoints) {
      const selection = editSection('selection', 'Selection');
      const vertices = viewport.referenceSelectedVertexInfo();
      detail(selection, refPoints === 1 && vertices.length === 1
        ? `reference vertex ${vertices[0].vertex} selected`
        : `${refPoints} reference control ${refPoints === 1 ? 'point' : 'points'} selected`);
      renderVertexValence(selection, vertices);
      detail(selection, 'read-only source · copy to bring into this mountain');
      if (refVertices) addCopy(selection);
      addDeselect(selection);
      return true;
    }

    // an authored edge / cell selection, else a read-only reference edge / patch pick (viewport-owned selection)
    const measure = store.edgeSel.length || store.cellSel.length ? viewport.authoredMeasure() : viewport.refMeasure();
    if (measure) {
      const selection = editSection('selection', 'Selection');
      renderMeasure(selection, measure);
      const copyCount = copySelectionVertexCount();
      if (copyCount) addCopy(selection);
      if (store.edgeSel.length || store.cellSel.length) addSelectConnected(selection);
      const shapeVertices: VertexName[] = store.edgeSel.length
        ? [...new Set(store.edgeSel.flatMap(([a, b]) => [a, b]))]
        : store.cellSel.length
          ? [...new Set(vertexNames(mdoc, quadIndices(mdoc, store.cellSel).flatMap(quad => quadVerts(mdoc, quad))))]
          : [];
      const topology = store.edgeSel.length || store.cellSel.length ? editSection('topology', 'Topology') : null;
      const shape = shapeVertices.length && canEditCurvature() ? editSection('shape', 'Shape') : null;
      if (store.edgeSel.length || store.cellSel.length || store.refEdgeSel.length || store.refCellSel.length)
        addSelectionVisibility();
      if (shape) addCreaseSmooth(
        shape, shapeVertices,
        store.edgeSel.length
          ? 'Crease every unique corner vertex belonging to the selected edge or edge run.'
          : 'Crease every unique corner vertex belonging to the selected patch or patch selection.',
        store.edgeSel.length
          ? 'Reset every unique corner vertex belonging to the selected edge or edge run to automatic smoothing.'
          : 'Reset every unique corner vertex belonging to the selected patch or patch selection to automatic smoothing.',
      );
      if (store.edgeSel.length) {
        const free = new Set((mdoc.freeEdges ?? []).map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`));
        const selectedEdges = edgeIndices(mdoc, store.edgeSel);
        const hasFree = selectedEdges.some(([a, b]) => free.has(a < b ? `${a},${b}` : `${b},${a}`));
        const boundaryLoop = boundaryEdgeLoopVertices(mdoc, selectedEdges);
        if (store.edgeSel.length > 1) {
          const fill = tip(topology!.add({ patches: createPatchesFromEdges }, 'patches').name('create patches'),
            'Fill every empty 3- or 4-sided hole outlined by the selected edges.',
            'Select every side of each hole. Existing patches are skipped; new patches reuse the boundary corners and curves.');
          if (selectedEdges.length < 3) fill.disable();
        }
        tip(topology!.add({ extrude: beginEdgeExtrusion }, 'extrude').name('▰ extrude (X)'),
          'Stage a new patch strip from the selected edge.',
          'An interior run lifts perpendicular to the surface, uses the side you clicked, and closes with '
          + 'triangular end caps; F flips sides.');
        tip(topology!.add({ weld: beginEdgeWeld }, 'weld').name(`⊕ weld ${store.edgeSel.length === 1 ? 'edge' : 'edges'} (M)`),
          boundaryLoop.ok
            ? `Capture this ${store.edgeSel.length}-edge boundary loop for Weld Loops.`
            : `Capture the selected ${store.edgeSel.length === 1 ? 'edge' : 'edges'} as weld sources.`,
          boundaryLoop.ok
            ? 'Then double-click one edge on the facing border loop; Weld Loops fills the negative space with '
              + 'a connected patch seam, even when the two loops have different vertex counts.'
            : 'Then select the same number of target edges and press Enter. Their unique vertices are paired '
              + 'by closest distance and fused into the sources.');
        if (!hasFree) {
          tip(topology!.add({ rip: ripEdges }, 'rip').name('rip (K)'),
            'Open the selected interior edge or connected path into two separated lips.',
            'Split vertices separate by 1 m perpendicular to the path. '
            + 'Endpoints on the quilt boundary split too, so a rip across the quilt separates it completely. '
            + 'A single edge needs an endpoint on that boundary.');
        } else detail(topology!, 'free edges can also be used as rails in a bridge');
        const seed = railFromEdges(edgeIndices(mdoc, store.edgeSel));
        if (seed.ok) {
          tip(topology!.add({ bridge: startBridge }, 'bridge').name('create bridge (B)'),
            'Open Bridge Builder with this edge chain as Rail 1.',
            'Select another chain and press A to add rails; the ordered list and teal preview stay editable '
            + 'until Complete Bridge.');
        } else {
          tip(topology!.add({ bridge: () => {} }, 'bridge').name('create bridge (B)').disable(), seed.error);
        }
      }
      // Split the selected straight CELL strip only; unresolved interior ends become explicit T-junctions.
      if (store.cellSel.length) {
        if (SELECTED_RETOPOLOGY_VISIBLE && !store.modelEditId && openSelectedRetopology) {
          tip(topology!.add({ retopologize: openSelectedRetopology }, 'retopologize').name('▦ retopologize region…'),
            'Rebuild this connected patch region plus optional influence rings. Locked patches and everything outside the solve remain exact.');
        }
        tip(topology!.add({ overlap: selectOverlappingVertices }, 'overlap').name('select overlapping vertices'),
          'Swap the selection for every other authored vertex under the selected patches in this view.',
          'The current viewport is the mask: selection passes through depth and excludes the selected '
          + 'patches’ own corners. Press Delete afterward to remove the incident mountain patches.');
        if (shape) tip(shape.add({ reset: () => resetCellShape(store.cellSel) }, 'reset').name('reset shape'),
          'Keep the selected patch corners in place, restore their boundary control points to automatic smoothing, and clear their interior sculpt offsets.');
        tip(topology!.add({ extrude: beginEdgeExtrusion }, 'extrude').name('▰ extrude (X)'),
          'Lift the patch region as one preserved top, walling its boundary; position it, then Commit.');
        // A valid single quad is necessarily a straight strip. Avoid dry-running an O(full mountain) topology
        // rewrite merely to enable its button; the command still performs the authoritative validation/commit.
        const cells = quadIndices(mdoc, store.cellSel);
        const single = cells.length === 1 ? mdoc.quads[cells[0]] : null;
        const insert = single && new Set(single).size === 4
          ? { ok: true as const, doc: mdoc }
          : applyCellEdgeInsert(mdoc, cells);
        const insertButton = tip(topology!.add({ split: insertCellEdge }, 'split').name('⊟ split (I)'), insert.ok
          ? 'Split every selected patch through the straight strip. Ends against unselected patches become T-junctions; true rim ends remain conforming.'
          : insert.error);
        if (!insert.ok) insertButton.disable();
        tip(topology!.add({ flip: flipSelectedMesh }, 'flip').name('⇅ flip ridable side (N)'),
          'Reverse which side of the patch the board can ride.',
          'The game’s contact is one-sided — the rider falls through a surface approached from its back '
          + '(magenta-tinted) face. The surface itself does not move; flipping again restores it.');
      }
      if (topology) { addDissolveMesh(topology); addDeleteMesh(topology); }
      if (store.cellSel.length) buildLabelAssignment?.();
      addDeselect(selection);
      return true;
    }

    const floatingPoints = store.controlSel.filter(id => id.kind !== 'vertex');
    if (floatingPoints.length) {
      const selection = editSection('selection', 'Selection');
      addTJunctionWarning(selection, mdoc, store.regionSel);
      const boundary = floatingPoints.filter(id => id.kind === 'edge').length;
      const interior = floatingPoints.length - boundary;
      detail(selection, `${store.controlSel.length} control ${store.controlSel.length === 1 ? 'point' : 'points'} selected`);
      detail(selection, [store.regionSel.length ? `${store.regionSel.length} corners` : '', boundary ? `${boundary} tangents` : '', interior ? `${interior} interiors` : ''].filter(Boolean).join(' · '));
      renderVertexValence(selection, authoredVertexInfo(mdoc, store.regionSel));
      detail(selection, store.controlSel.length > 1 ? 'use Move or Rotate to transform them together' : 'drag the gizmo to move it');
      if (store.regionSel.length) {
        addCopy(selection);
        const topology = editSection('topology', 'Topology');
        const shape = canEditCurvature() ? editSection('shape', 'Shape') : null;
        addSelectionVisibility();
        if (shape) addCreaseSmooth(
          shape, store.regionSel,
          'Crease only the selected corner points; tangent and interior control points remain selected and unchanged.',
          'Reset only the selected corner points to automatic smoothing.',
        );
        addPointWeld(topology);
        addDissolveMesh(topology);
        if (canDeleteMeshSelection()) addDeleteMesh(topology);
      }
      addDeselect(selection);
      return true;
    }

    if (store.regionSel.length) {
      const selection = editSection('selection', 'Selection');
      addTJunctionWarning(selection, mdoc, store.regionSel);
      detail(selection, `${store.regionSel.length} corners selected`);
      renderVertexValence(selection, authoredVertexInfo(mdoc, store.regionSel));
      detail(selection, 'drag the gizmo to move or rotate them together');
      const ids = store.regionSel;
      addCopy(selection);
      addSelectConnected(selection);
      const topology = editSection('topology', 'Topology');
      const shape = canEditCurvature() ? editSection('shape', 'Shape') : null;
      addSelectionVisibility();
      if (shape) addCreaseSmooth(
        shape, ids,
        'Sharp edges across the whole selection — e.g. a wall-top line in one go.',
        'Reset the whole selection to smooth tangents.',
      );
      addPointWeld(topology);
      addDissolveMesh(topology);
      if (canDeleteMeshSelection()) addDeleteMesh(topology);
      addDeselect(selection);
      return true;
    }
    if (store.selectedCorner === null) return false;
    const name = store.selectedCorner, id = vertexIndices(mdoc, [name])[0];
    if (id === undefined) return false;
    const j = id * 3;
    const selection = editSection('selection', 'Selection');
    addTJunctionWarning(selection, mdoc, [name]);
    detail(selection, `corner ${id}`);
    detail(selection, `x ${mdoc.vertices[j].toFixed(1)}  y ${mdoc.vertices[j + 1].toFixed(1)}  z ${mdoc.vertices[j + 2].toFixed(1)}`);
    renderVertexValence(selection, authoredVertexInfo(mdoc, [name]));
    detail(selection, 'shift-click another corner = add to selection');
    addCopy(selection);
    addSelectConnected(selection);
    const topology = editSection('topology', 'Topology');
    const shape = canEditCurvature() ? editSection('shape', 'Shape') : null;
    addSelectionVisibility();
    if (shape) {
      const crease = tip(shape.add({ crease: () => creaseVertices([name]) }, 'crease').name('crease (C)'),
        'Sharp edge here: tangents go one-sided so the surface kinks (wall top / lip).');
      if (meshVertexCanSmooth(mdoc, meshAdjacency(buildQuadMesh(mdoc.vertices, mdoc.quads, mdoc.freeEdges)), id)) {
        const smooth = tip(shape.add({ smooth: () => smoothVertices([name]) }, 'smooth').name('smooth (S)'),
          'Reset this corner to smooth tangents. Regular vertices return to Bessel; extraordinary poles fit a shared tangent plane across their full edge fan.');
        actionPair(crease, smooth);
      }
    }
    addPointWeld(topology);
    addDissolveMesh(topology);
    addDeleteMesh(topology);
    addDeselect(selection);
    return true;
  }

  function addCopy(g: GUI) {
    const copy = tip(g.add({ copy: copySelectedVertices }, 'copy').name('copy (Ctrl+C)'),
      'Copy the selected points, edges, or surfaces. Free edges stay edges; surfaces keep their topology, shape, and material metadata.');
    const cut = tip(g.add({ cut: cutSelectedVertices }, 'cut').name('cut (Ctrl+X)'),
      'Copy the selection, then remove authored geometry using the same safe operation as Delete. Reference geometry is read-only, so Cut falls back to Copy there.');
    actionPair(copy, cut);
  }

  function addSelectConnected(g: GUI) {
    const noun = store.cellSel.length ? 'patch' : store.edgeSel.length ? 'edge' : 'vertex';
    tip(g.add({ connected: selectConnected }, 'connected').name('select connected (Ctrl+A)'),
      `Grow the selection to every connected visible ${noun} — one tube patch grows to the whole tube.`,
      'Reachable through visible surface or free edges only; hidden geometry is excluded and blocks traversal.');
  }

  function addHideMesh(g: GUI) {
    const count = store.refCellSel.length || store.cellSel.length || store.edgeSel.length
      || store.regionSel.length || (store.selectedCorner !== null ? 1 : 0);
    if (!count) return;
    const noun = store.refCellSel.length || store.cellSel.length ? (count === 1 ? 'patch' : 'patches')
      : store.edgeSel.length ? (count === 1 ? 'edge' : 'edges')
      : count === 1 ? 'point' : 'points';
    const effect = store.refCellSel.length
      ? `Temporarily hide the selected reference ${noun} and clear the selection.`
      : store.regionSel.length || store.selectedCorner !== null
      ? 'Hide the selected points and every edge and patch that uses them.'
      : store.edgeSel.length
      ? 'Hide the selected edges and every patch that uses them.'
      : `Temporarily hide the selected ${noun} and clear the selection.`;
    tip(g.add({ hide: hideSelectedMesh }, 'hide').name(`hide ${noun} (H)`),
      effect, 'Alt+H, or Show All Hidden in the empty Edit toolbox, reveals everything again.');
  }

  function addSelectionVisibility() {
    const visibility = editSection('visibility', 'Visibility');
    addHideMesh(visibility);
    if (store.cellSel.length) {
      const state = selectedPatchLockState();
      const unlock = state.total > 0 && state.locked === state.total;
      if (state.locked) detail(visibility,
        state.locked === state.total ? `${state.locked} locked` : `${state.locked} of ${state.total} locked`,
        'protection');
      if (unlock) {
        tip(visibility.add({ lock: toggleSelectedPatchLocks }, 'lock')
          .name(`unlock ${state.total === 1 ? 'patch' : 'patches'}`),
        'Allow these patches to be sculpted and transformed again. Their captured boundary shape remains unchanged until explicitly smoothed.');
      } else {
        tip(visibility.add({ lock: toggleSelectedPatchLocks }, 'lock')
          .name(`lock ${state.total === 1 ? 'patch' : 'patches'}`),
        'Protect the selected patches’ complete surfaces from every edit.',
        'Sculpt brushes, point/control-cage drags, and group Move/Rotate/Scale leave their corners, boundary '
        + 'controls, and interiors fixed. Locked edges draw red in wireframe view.');
      }
    }
    const referenceCageSelection = store.refEdgeSel.length > 0 || store.refCellSel.length > 0;
    if (referenceCageSelection || (store.edgeSel.length || store.cellSel.length) && canEditCurvature()) {
      const hide = selectedControlCagesVisible();
      tip(
        visibility.add({ cage: toggleSelectedControlCages }, 'cage')
          .name(`${hide ? 'hide' : 'show'} control cage (G)`),
        hide
          ? 'Remove the selected control cages from the focused working set, then clear the selection.'
          : `Pin the selected control cages, then clear the selection; repeat to build a focused working set.${referenceCageSelection ? ' Reference cages remain read-only.' : ''}`,
      );
    }
    if (hiddenMeshCount()) tip(visibility.add({ show: showAllHidden }, 'show').name('show all hidden (Alt+H)'),
      'Reveal every point, edge, and patch hidden with H without changing the mountain.');
  }

  function addPointWeld(g: GUI) {
    tip(g.add({ weld: beginPointWeld }, 'weld').name('⊕ weld points (M)'),
      'Capture the selected corner points as weld sources.',
      'Then select an equal-size target set and Commit Weld; each source merges into its nearest target.');
  }

  /** Shape actions always travel as a compact pair; callers choose which unique mesh vertices they affect. */
  function addCreaseSmooth(g: GUI, vertices: readonly VertexName[], creaseTip: string, smoothTip: string) {
    const crease = tip(g.add({ crease: () => creaseVertices(vertices) }, 'crease').name('crease (C)'), creaseTip);
    const smooth = tip(g.add({ smooth: () => smoothVertices(vertices) }, 'smooth').name('smooth (S)'), smoothTip);
    actionPair(crease, smooth);
  }

  /** Contextual topology deletion. A selected point removes its incident patch fan; a selected edge removes its
   *  incident patch(es), while a cell selection names patches directly. */
  function addDeleteMesh(g: GUI) {
    const count = meshDeleteTargetCount();
    if (!canDeleteMeshSelection()) return;
    const points = store.regionSel.length || (store.selectedCorner !== null ? 1 : 0);
    const free = new Set((editMesh(store).freeEdges ?? []).map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`));
    const freeEdges = edgeIndices(editMesh(store), store.edgeSel)
      .filter(([a, b]) => free.has(a < b ? `${a},${b}` : `${b},${a}`)).length;
    const title = points
      ? 'Delete the selected point(s) and every patch that uses them. A loose point is removed by itself; a connected point opens a hole by removing its whole incident patch fan.'
      : freeEdges && !count
      ? 'Delete the selected free edge(s). Endpoints unused by another edge or surface are removed too.'
      : store.edgeSel.length
      ? 'Delete every patch touching the selected edge(s). A rim edge removes one patch; an interior edge removes the patch on both sides and leaves an open boundary.'
      : store.cellSel.length
        ? 'Delete the selected patch(es). Vertices and control handles left unused afterward are removed automatically.'
        : 'Delete the current mesh selection.';
    const label = points
      ? 'delete (Del)'
      : freeEdges && !count
      ? `delete ${freeEdges === 1 ? 'edge' : `${freeEdges} edges`} (Del)`
      : `delete ${count} ${count === 1 ? 'patch' : 'patches'} (Del)`;
    tip(g.add({ del: deleteSelectedMesh }, 'del').name(label), title);
  }

  /** Standard modelling distinction: Dissolve preserves a surface by fusing incident patches; Delete removes
   * those patches and opens a hole. Dissolve may skip intermediate boundary points and expose T-junctions. */
  function addDissolveMesh(g: GUI) {
    const doc = editMesh(store);
    const vertices = store.regionSel.length ? store.regionSel : store.selectedCorner !== null ? [store.selectedCorner] : [];
    if (!vertices.length && !store.edgeSel.length) return;
    const result = applyMeshDissolve(doc,
      { vertices: vertexIndices(doc, vertices), edges: edgeIndices(doc, store.edgeSel) });
    const noun = store.edgeSel.length ? (store.edgeSel.length === 1 ? 'edge' : 'edges') : (vertices.length === 1 ? 'point' : 'points');
    const button = tip(g.add({ dissolve: dissolveSelectedMesh }, 'dissolve').name(`dissolve ${noun} (D)`), result.ok
      ? 'Remove the selection while preserving the surface as one larger quad. Intermediate boundary points used by neighboring patches remain in place and are highlighted as red T-junctions.'
      : result.error);
    if (!result.ok) button.disable();
  }

  /** Standard last row for every Edit selection; routed through the host's exact Escape clearing path. */
  function addDeselect(g: GUI) {
    tip(g.add({ deselect: deselectEdit }, 'deselect').name('deselect (Esc)'),
      'Clear the Edit selection — the same as pressing Esc.');
  }

  /** The read-out for a control-net selection's metrics (core/mesh/measure.ts) — the SAME lines for the authored net
   *  and the read-only reference (both are a QuadMesh + EdgeHandle measured through one core), so the two
   *  surfaces stay in parity: an edge shows its curved (ridable) length; a cell its down-slope length × across
   *  width, vertical drop and true 3D surface area; a multi-selection folds to a total. */
  function renderMeasure(g: GUI, m: SelectionMeasure) {
    if (m.kind === 'edge') {
      if (m.count === 1) {
        tip(detail(g, fmtM(m.total), 'edge'),
          'The true (curved) length of this control-net edge along the surface — the ridable distance, not the straight line between its corners.');
      } else {
        detail(g, `${m.count} edges selected`);
        tip(detail(g, fmtM(m.total), 'total'), 'The summed curved length of every selected edge — e.g. a whole ridge run picked along its loop.');
      }
      detail(g, 'shift-click along the loop = extend');
      return;
    }
    if (m.single) {
      detail(g, `cell ${m.id}`);
      tip(detail(g, `${fmtM(m.single.length)} × ${fmtM(m.single.width)}`, 'size'),
        'Down-slope length × across-slope width, measured along the patch centre lines on the curved surface.');
      tip(detail(g, fmtM(m.single.drop), 'drop'), 'The vertical fall across this cell (highest to lowest point on its surface).');
      tip(detail(g, fmtArea(m.single.area), 'area'), 'The true 3D surface area of this patch (follows the curve, so it exceeds the flat footprint on a slope).');
    } else {
      detail(g, `${m.count} cells selected`);
      tip(detail(g, fmtArea(m.area), 'area'), 'Total 3D surface area of every selected cell.');
      tip(detail(g, fmtM(m.drop), 'drop'), 'Overall vertical fall across the whole selection (highest to lowest point).');
    }
  }

  return { buildMeshSelectionTools };
}
