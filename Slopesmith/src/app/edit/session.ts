import type { LabelDefinition, QuadMeshDoc, V3 } from '../../core/doc/types';
import { nextLabelColor, nextLabelId } from '../../core/doc/labels';
import { writePropRotation } from '../../core/props/pose';
import {
  meshCreaseVertices, meshDirNeighbors, meshResetShape, meshSmoothVertices, meshSetHandle, meshSetTwist,
  HANDLE_DIRS, type HandleDir,
} from '../../core/doc/mountain';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles, meshFromDoc, quadControlPoints, INTERIOR_CP, type MeshAdjacency } from '../../core/mesh/topology';
import {
  planLoopCut, applyLoopCut, meshContext, applyEdgeRip, applyCellEdgeInsert, applyVertexWeld, applyVertexWeldTogether,
  appendPatchFromCorners, applyEdgeExtrusion, applyPlannedEdgeExtrusion, applyEdgeWeldSets, applyEdgeLoopWeld,
  boundaryEdgeLoopVertices, meshDeleteTargets, applyMeshDelete,
  applyMeshDissolve, applyMeshFlip, applyEdgeCrossingWeld, ekey, type MeshDeleteSelection, type PatchCorners,
} from '../../core/mesh/ops';
import type { EdgeCrossing } from '../../core/mesh/edge-crossings';
import type { CoincidentVertices } from '../../core/mesh/coincident-vertices';
import { coincidentVertexGroup } from '../../core/mesh/coincident-vertices';
import { applySlidePlan, type SlidePlan } from '../../core/mesh/slide';
import { resolveEdgeSelection, resolveVertexSelection, resolveCellSelection, type EdgeSelectMode } from '../../core/mesh/selection';
import { getVertex, setVertex, quadVerts } from '../../core/doc/doc-edit';
import {
  controlPointKey, meshControlPoints, moveMeshControlPoints, moveMeshVerticesProportional, setMeshControlPoints,
  type MeshControlPointId,
} from '../../core/mesh/control-points';
import {
  controlPointIsLocked, edgeIsLocked, lockedEdgeSet, lockedVertexSet, quadIsLocked, setQuadsLocked,
} from '../../core/mesh/locks';
import type { Store } from '../state/store';
import {
  coincidentVertexIndices, controlPointIndex, controlPointIndices, directedEdgeIndex, edgeCrossingIndex, edgeIndex, edgeIndices,
  namedCoincidentVertices, namedEdge, namedEdgeCrossing, namedEdges, quadIndex, quadIndices, quadName,
  quadNames, quadNaming, vertexIndex, vertexIndices, vertexName, vertexNames, vertexNaming,
  type NamedEdge, type QuadName, type VertexName,
} from '../state/mesh-names';
import { commitEditMesh, editMesh } from './mesh-target';
import type { EditMarqueeSelection, RigidCornerUpdate, ViewportCallbacks } from '../viewport/types';
import { toast } from '../ui/components/toast';
import { createTopologyTools } from './topology';
import { createMeshClipboardSession } from './clipboard';
import type { EditViewportPort } from './viewport-port';

export type { EditViewportPort } from './viewport-port';

type EditCallbackName =
  | 'onSelectCorner' | 'onSelectCorners' | 'onSelectControlPoints' | 'onSelectEditMarquee' | 'onRangeSelectCorner' | 'onToggleCorner'
  | 'onMoveCorners' | 'onMoveControlPoints' | 'onMoveMixedEditSelection' | 'onRotateMixedEditSelection'
  | 'onRotateControlPoints' | 'onRotateCorners'
  | 'onScaleControlPoints' | 'onScaleCorners' | 'onSlideCorners'
  | 'onSlideBegin' | 'onSlideRecut' | 'onSlideMergePending' | 'onSlideEnd' | 'onEditTransformEnd'
  | 'onCreateEdgePoint' | 'onCreateTubeAxisChange' | 'onCreateTrailPointsChange' | 'onLoopCut' | 'onCreatePatch' | 'onPasteVertices'
  | 'onSelectEditCell' | 'onSelectCellLoop' | 'onSelectEdge' | 'onSelectEdgeLoop'
  | 'onExtrudeEdges' | 'onCommitExtrudeEdges' | 'onExtrudeStageChange' | 'onExtrudeEdgesInvalid' | 'onRefSelectionChange'
  | 'onMoveCorner' | 'onMoveHandle' | 'onMoveCageHandle' | 'onMoveTwist';

export type EditViewportCallbacks = Pick<ViewportCallbacks, EditCallbackName>;

export type EditSessionDeps = {
  store: Store;
  viewport: () => EditViewportPort;
  cageActive: () => boolean;
  applyCage: () => void;
  persistUi: () => void;
  scheduleRebuild: () => void;
  scheduleCommit: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
  refreshSelection: () => void;
  log: (message: string) => void;
};

/**
 * Owns the Edit mode's application workflow. Pure topology and geometry remain in `core`; this controller owns
 * selection transitions, modal-tool state, undo/rebuild effects, and translation between viewport gestures and
 * document operations. Its methods are shared by the viewport callbacks, tools panel, keyboard, and document
 * lifecycle so those callers cannot each grow a subtly different version of the same rules.
 */
export function createEditSession(deps: EditSessionDeps) {
  const {
    store, viewport: getViewport, cageActive, applyCage, persistUi, scheduleRebuild, scheduleCommit,
    rebuildTools, updateCmdSheet, refreshSelection, log,
  } = deps;
  const view = () => getViewport();
  const mdoc = () => editMesh(store); // the edit target: the mountain net, or the model being edited

  let slideBase: QuadMeshDoc | null = null;
  let slideWeld: [number, number][] = [];
  let tubePointCount = -1;
  let trailPointCount = -1;
  let selectedDirNb: Record<HandleDir, number> | null = null;

  type EditSelectionKind = 'point' | 'edge' | 'patch' | 'prop';

  /** Mixed marquee selections keep all family highlights and share one Move / Rotate gizmo. Type-specific
   * topology/shape commands stay dormant until the user narrows the selection through its count chooser. */
  function selectedEditKindCount(): number {
    const pointCount = store.controlSel.length || store.regionSel.length || (store.selectedCorner !== null ? 1 : 0)
      || store.refControlSel.length;
    return Number(pointCount > 0)
      + Number(store.edgeSel.length > 0 || store.refEdgeSel.length > 0)
      + Number(store.cellSel.length > 0 || store.refCellSel.length > 0)
      + Number(store.selectedProp !== null || store.multiSel.length > 0);
  }

  function mixedEditSelection(): boolean { return selectedEditKindCount() > 1; }

  function activeEditFamily(): 'corner' | 'edge' | 'cell' | null {
    if (store.controlSel.length || store.regionSel.length || store.selectedCorner !== null) return 'corner';
    if (store.edgeSel.length) return 'edge';
    if (store.cellSel.length) return 'cell';
    return null;
  }

  // ---- the id ⇄ index boundary (docs/039). The store names the authored mesh; the ops, the topology walks
  // and the viewport all subscript arrays, so every read resolves here and every write names what it landed on.
  const vAt = (name: VertexName) => vertexIndex(mdoc(), name);
  const selectedVertexIndices = () => vertexIndices(mdoc(), selectedAuthoredVertexIds());
  const edgeSelIndices = () => edgeIndices(mdoc(), store.edgeSel);
  const cellSelIndices = () => quadIndices(mdoc(), store.cellSel);
  /** Set key for a named edge already in canonical order. */
  const nameKey = (edge: NamedEdge) => `${edge[0]}|${edge[1]}`;

  /** The transient Edit visibility filters resolved onto the live mesh — the form every predicate below reads. */
  type HiddenMesh = { vertices: Set<number>; edges: Set<string>; quads: Set<number> };
  function hiddenMesh(): HiddenMesh {
    const doc = mdoc();
    return {
      vertices: new Set(vertexIndices(doc, store.hiddenVertices)),
      edges: new Set(edgeIndices(doc, store.hiddenEdges).map(([a, b]) => ekey(a, b))),
      quads: new Set(quadIndices(doc, store.hiddenQuads)),
    };
  }
  function quadIsHidden(quad: number, hidden: HiddenMesh) {
    if (hidden.quads.has(quad)) return true;
    const q = mdoc().quads[quad];
    if (!q) return false;
    if (q.some(vertex => hidden.vertices.has(vertex))) return true;
    const [A, B, C, D] = q;
    return ([[A, B], [B, D], [D, C], [C, A]] as [number, number][])
      .some(([a, b]) => a !== b && hidden.edges.has(ekey(a, b)));
  }
  function vertexIsHidden(vertex: number, adj: MeshAdjacency, hidden: HiddenMesh) {
    if (hidden.vertices.has(vertex)) return true;
    const incident = (adj.neighbors[vertex] ?? []).map(to => adj.edgeQuads.get(ekey(vertex, to)) ?? []);
    return incident.length > 0 && incident.every(quads => quads.length > 0 && quads.every(quad => quadIsHidden(quad, hidden)));
  }
  function edgeIsHidden(a: number, b: number, adj: MeshAdjacency, hidden: HiddenMesh) {
    if (hidden.vertices.has(a) || hidden.vertices.has(b) || hidden.edges.has(ekey(a, b))) return true;
    const quads = adj.edgeQuads.get(ekey(a, b)) ?? [];
    return quads.length > 0 && quads.every(quad => quadIsHidden(quad, hidden));
  }
  function hiddenMeshCount() {
    return store.hiddenVertices.length + store.hiddenEdges.length + store.hiddenQuads.length
      + store.refHiddenQuads.length;
  }
  function controlCageCount() {
    return store.controlCageEdges.length + store.controlCageQuads.length
      + store.refControlCageEdges.length + store.refControlCageQuads.length;
  }
  function pushHiddenMesh() { view().refreshHiddenMesh(); }
  function canHideSelection() {
    return store.currentMode === 'edit' && cageActive() && store.bridgeRails === null && !store.surgeryTool
      && !store.weldTool && !store.createEdgeTool && !view().pastePlacing && !view().edgeExtrusionStaged
      && !mixedEditSelection()
      && (selectedAuthoredVertexIds().length > 0 || store.edgeSel.length > 0 || store.cellSel.length > 0
        || store.refCellSel.length > 0);
  }

  function canSelectConnected() {
    const clear = store.currentMode === 'edit' && cageActive() && store.bridgeRails === null && !store.surgeryTool
      && !store.weldTool && !store.createEdgeTool && !view().pastePlacing && !view().edgeExtrusionStaged
      && !mixedEditSelection();
    if (!clear) return false;
    if (store.cellSel.length || store.edgeSel.length) return true;
    return !store.controlSel.some(id => id.kind !== 'vertex') && selectedAuthoredVertexIds().length > 0;
  }

  /** Grow the current selection to everything connected, staying in its own family: a point selection becomes
   *  every visible vertex reachable through visible surface or free edges, an edge selection every visible
   *  edge of that component, a patch selection every visible patch (select one tube cell, Ctrl+A, N flips the
   *  whole tube). Hidden geometry is excluded and blocks traversal. */
  function selectConnected() {
    if (!canSelectConnected()) return;
    const doc = mdoc();
    const { adj } = meshContext(doc), hidden = hiddenMesh();
    const component = (seeds: number[]) => {
      const selected = new Set(seeds.filter(vertex => !vertexIsHidden(vertex, adj, hidden)));
      const queue = [...selected];
      for (let at = 0; at < queue.length; at++) {
        const vertex = queue[at];
        for (const neighbour of adj.neighbors[vertex] ?? []) {
          if (selected.has(neighbour) || vertexIsHidden(neighbour, adj, hidden)
            || edgeIsHidden(vertex, neighbour, adj, hidden)) continue;
          selected.add(neighbour);
          queue.push(neighbour);
        }
      }
      return selected;
    };
    if (store.cellSel.length) {
      const seeded = cellSelIndices();
      const verts = component(seeded.flatMap(quad => quadVerts(doc, quad)));
      const cells = seeded.slice(), have = new Set(cells);
      doc.quads.forEach((corners, quad) => {
        if (have.has(quad) || quadIsHidden(quad, hidden)) return;
        if (corners.every(v => verts.has(v))) { have.add(quad); cells.push(quad); }
      });
      if (cells.length === store.cellSel.length) return; // already the whole component
      store.cellSel = quadNames(doc, cells);
      view().refreshEditCells();
      seatEditMoveGizmo();
      refreshEditSelectionUi();
    } else if (store.edgeSel.length) {
      const seeded = edgeSelIndices();
      const verts = component(seeded.flatMap(([a, b]) => [a, b]));
      const edges = seeded.slice(), have = new Set(edges.map(([a, b]) => ekey(a, b)));
      for (const vertex of verts) {
        for (const neighbour of adj.neighbors[vertex] ?? []) {
          if (neighbour < vertex || !verts.has(neighbour)) continue; // each undirected edge once
          const key = ekey(vertex, neighbour);
          if (have.has(key) || edgeIsHidden(vertex, neighbour, adj, hidden)) continue;
          have.add(key);
          edges.push([vertex, neighbour]);
        }
      }
      if (edges.length === store.edgeSel.length) return;
      store.edgeSel = namedEdges(doc, edges);
      view().refreshEditEdges();
      seatEditMoveGizmo();
      refreshEditSelectionUi();
    } else {
      setRegion(vertexNames(doc, [...component(selectedVertexIndices())].sort((a, b) => a - b)));
    }
  }

  /** Replace a patch selection with every OTHER authored corner whose current-view projection lies inside
   * those curved patch silhouettes. The source corners are excluded in the viewport query, so Delete opens
   * the geometry behind an overlay without deleting the overlay itself. */
  function selectOverlappingVertices() {
    if (store.currentMode !== 'edit' || !cageActive() || !store.cellSel.length) return;
    const doc = mdoc();
    const vertices = view().projectedVerticesInsidePatches(cellSelIndices());
    if (!vertices.length) {
      toast('No other vertices overlap the selected patches from this view.', 'info');
      return;
    }
    store.anchorCorner = null;
    setRegion(vertexNames(doc, vertices));
    toast(`${vertices.length} overlapping ${vertices.length === 1 ? 'vertex' : 'vertices'} selected · press Delete to open the space`, 'ok');
  }

  function hideSelectedMesh() {
    if (!canHideSelection()) return;
    if (store.refCellSel.length)
      store.refHiddenQuads = [...new Set([...store.refHiddenQuads, ...store.refCellSel])].sort((a, b) => a - b);
    else if (store.cellSel.length) store.hiddenQuads = [...new Set([...store.hiddenQuads, ...store.cellSel])].sort();
    else if (store.edgeSel.length) {
      const edges = new Map(store.hiddenEdges.map(edge => [nameKey(edge), edge]));
      for (const edge of store.edgeSel) edges.set(nameKey(edge), edge);
      store.hiddenEdges = [...edges.values()];
    } else {
      store.hiddenVertices = [...new Set([...store.hiddenVertices, ...selectedAuthoredVertexIds()])].sort();
    }
    pushHiddenMesh();
    deselectEdit();
  }

  function showAllHidden() {
    if (!hiddenMeshCount()) return;
    store.hiddenVertices = [];
    store.hiddenEdges = [];
    store.hiddenQuads = [];
    store.refHiddenQuads = [];
    pushHiddenMesh();
    rebuildTools(); updateCmdSheet();
  }

  /** Whether every edge or patch in the active selection is explicitly pinned into the focused cage set. */
  function selectedControlCagesVisible() {
    if (store.refCellSel.length) {
      const shown = new Set(store.refControlCageQuads);
      return store.refCellSel.every(quad => shown.has(quad));
    }
    if (store.refEdgeSel.length) {
      const shown = new Set(store.refControlCageEdges.map(([a, b]) => ekey(a, b)));
      return store.refEdgeSel.every(([a, b]) => shown.has(ekey(a, b)));
    }
    if (store.cellSel.length) {
      const shown = new Set(store.controlCageQuads);
      return store.cellSel.every(quad => shown.has(quad));
    }
    if (store.edgeSel.length) {
      const shown = new Set(store.controlCageEdges.map(nameKey));
      return store.edgeSel.every(edge => shown.has(nameKey(edge)));
    }
    return false;
  }

  /** The curvature tools — pinned control cages (G), crease/smooth (C/S), reset shape — edit the doc's
   *  stored curvature channels. A model's flat cage derives every handle (`linearCage`) and drops any
   *  curvature an edit writes, so while a model is being edited none of them has anything real to do;
   *  their buttons, shortcuts, and help rows all follow this predicate. */
  function canEditCurvature() { return !mdoc().linearCage; }

  /** Toggle the current edge/patch selection in the sticky sub-cage visibility set, then clear the selection
   * like Hide. A mixed selection becomes fully shown; only a fully shown selection is removed. */
  function toggleSelectedControlCages() {
    const reference = store.refCellSel.length > 0 || store.refEdgeSel.length > 0;
    if (store.currentMode !== 'edit' || !cageActive() || (!reference && !canEditCurvature())) return;
    const hide = selectedControlCagesVisible();
    if (store.refCellSel.length) {
      const selected = new Set(store.refCellSel);
      store.refControlCageQuads = hide
        ? store.refControlCageQuads.filter(quad => !selected.has(quad))
        : [...new Set([...store.refControlCageQuads, ...store.refCellSel])].sort((a, b) => a - b);
    } else if (store.refEdgeSel.length) {
      const selected = new Set(store.refEdgeSel.map(([a, b]) => ekey(a, b)));
      if (hide) store.refControlCageEdges = store.refControlCageEdges.filter(([a, b]) => !selected.has(ekey(a, b)));
      else {
        const edges = new Map(store.refControlCageEdges.map(edge => [ekey(edge[0], edge[1]), edge]));
        for (const edge of store.refEdgeSel) edges.set(ekey(edge[0], edge[1]), edge);
        store.refControlCageEdges = [...edges.values()];
      }
    } else if (store.cellSel.length) {
      const selected = new Set(store.cellSel);
      store.controlCageQuads = hide
        ? store.controlCageQuads.filter(quad => !selected.has(quad))
        : [...new Set([...store.controlCageQuads, ...store.cellSel])].sort();
    } else if (store.edgeSel.length) {
      const selected = new Set(store.edgeSel.map(nameKey));
      if (hide) store.controlCageEdges = store.controlCageEdges.filter(edge => !selected.has(nameKey(edge)));
      else {
        const edges = new Map(store.controlCageEdges.map(edge => [nameKey(edge), edge]));
        for (const edge of store.edgeSel) edges.set(nameKey(edge), edge);
        store.controlCageEdges = [...edges.values()];
      }
    } else return;
    view().refreshControlCages();
    deselectEdit();
  }

  /** Clear every explicitly pinned edge/patch cage without changing the mountain or hidden components. */
  function hideSubCages() {
    if (!controlCageCount()) return;
    store.controlCageEdges = [];
    store.controlCageQuads = [];
    store.refControlCageEdges = [];
    store.refControlCageQuads = [];
    if (store.controlSel.some(id => id.kind !== 'vertex') || store.refControlSel.some(id => id.kind !== 'vertex')) deselectEdit();
    view().refreshControlCages();
    rebuildTools(); updateCmdSheet();
  }

  function transformSelectionActive(): boolean {
    if (view().edgeExtrusionStaged) return true;
    if (store.currentMode === 'props') return store.selectedProp !== null || store.multiSel.length > 0;
    if (store.currentMode !== 'edit' || store.bridgeRails !== null || !cageActive()) return false;
    if (mixedEditSelection()) return mixedEditMoveVertices().length > 0 || mixedEditFloatingPoints().length > 0
      || selectedEditPropIndices().length > 0;
    return store.selectedCorner !== null || store.controlSel.length > 0 || store.regionSel.length > 0
      || store.edgeSel.length > 0 || store.cellSel.length > 0;
  }

  function movableControlPoints(ids: readonly MeshControlPointId[]): MeshControlPointId[] {
    const doc = mdoc(), vertices = lockedVertexSet(doc), edges = lockedEdgeSet(doc);
    return ids.filter(id => {
      const at = controlPointIndex(doc, id);
      return !!at && !controlPointIsLocked(doc, at, vertices, edges);
    });
  }

  /** Every topology corner implied by the selected point / edge / patch families, resolved once and
   * de-duplicated. Locked vertices remain highlighted but do not contribute to the movable centroid. */
  function mixedEditMoveVertices(): number[] {
    const doc = mdoc(), locked = lockedVertexSet(doc), vertices = new Set<number>();
    for (const point of controlPointIndices(doc, store.controlSel)) if (point.kind === 'vertex') vertices.add(point.vertex);
    for (const vertex of selectedVertexIndices()) vertices.add(vertex);
    for (const [a, b] of edgeSelIndices()) { vertices.add(a); vertices.add(b); }
    for (const quad of cellSelIndices()) for (const vertex of quadVerts(doc, quad)) vertices.add(vertex);
    return [...vertices].filter(vertex => !locked.has(vertex)).sort((a, b) => a - b);
  }

  function mixedEditFloatingPoints(): MeshControlPointId[] {
    return movableControlPoints(store.controlSel).filter(point => point.kind !== 'vertex');
  }

  function selectedEditPropIndices(): number[] {
    const count = store.mdoc.props?.length ?? 0;
    const selected = store.multiSel.length ? store.multiSel
      : store.selectedProp !== null ? [store.selectedProp] : [];
    return [...new Set(selected)].filter(index => index >= 0 && index < count).sort((a, b) => a - b);
  }

  // ---- semantic labels -------------------------------------------------------------------------------------

  /** Labels apply to the authored mountain's patches and placements. Model-internal faces deliberately have
   * no stable semantic identity yet (docs/044), so a model-edit substrate never exposes these commands. */
  function labelsAvailable(): boolean {
    return store.currentMode === 'edit' && !store.modelEditId;
  }

  function selectedLabelTargets(): { quads: number[]; props: number[] } {
    if (!labelsAvailable()) return { quads: [], props: [] };
    return {
      quads: quadIndices(store.mdoc, store.cellSel),
      props: selectedEditPropIndices(),
    };
  }

  function labelRows(): (LabelDefinition & { patches: number; props: number; count: number })[] {
    if (!labelsAvailable()) return [];
    return (store.mdoc.labels ?? []).map(label => {
      let patches = 0, props = 0;
      for (const memberships of Object.values(store.mdoc.quadLabels ?? {})) if (memberships.includes(label.id)) patches++;
      for (const prop of store.mdoc.props ?? []) if (prop.labels?.includes(label.id)) props++;
      return { ...label, patches, props, count: patches + props };
    });
  }

  function selectedLabelState(labelId: string): 'none' | 'some' | 'all' {
    const { quads, props } = selectedLabelTargets(), total = quads.length + props.length;
    if (!total) return 'none';
    let held = 0;
    for (const quad of quads) if (store.mdoc.quadLabels?.[quad]?.includes(labelId)) held++;
    for (const prop of props) if (store.mdoc.props?.[prop]?.labels?.includes(labelId)) held++;
    return held === 0 ? 'none' : held === total ? 'all' : 'some';
  }

  function setSelectedLabel(labelId: string, enabled: boolean): void {
    if (!store.mdoc.labels?.some(label => label.id === labelId)) return;
    const { quads, props } = selectedLabelTargets();
    if (!quads.length && !props.length) return;
    for (const quad of quads) {
      const labels = new Set(store.mdoc.quadLabels?.[quad] ?? []);
      if (enabled) labels.add(labelId); else labels.delete(labelId);
      if (labels.size) (store.mdoc.quadLabels ??= {})[quad] = [...labels].sort();
      else if (store.mdoc.quadLabels) delete store.mdoc.quadLabels[quad];
    }
    if (store.mdoc.quadLabels && !Object.keys(store.mdoc.quadLabels).length) delete store.mdoc.quadLabels;
    for (const index of props) {
      const prop = store.mdoc.props?.[index];
      if (!prop) continue;
      const labels = new Set(prop.labels ?? []);
      if (enabled) labels.add(labelId); else labels.delete(labelId);
      if (labels.size) prop.labels = [...labels].sort(); else delete prop.labels;
    }
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
  }

  function createLabel(name: string): boolean {
    if (!labelsAvailable()) return false;
    const clean = name.trim();
    if (!clean) { toast('enter a label name', 'warn'); return false; }
    if ((store.mdoc.labels ?? []).some(label => label.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      toast(`a label named “${clean}” already exists`, 'warn'); return false;
    }
    const label: LabelDefinition = {
      id: nextLabelId(store.mdoc.labels), name: clean, color: nextLabelColor(store.mdoc.labels),
    };
    (store.mdoc.labels ??= []).push(label);
    const targets = selectedLabelTargets();
    if (targets.quads.length || targets.props.length) setSelectedLabel(label.id, true);
    else { scheduleRebuild(); rebuildTools(); updateCmdSheet(); }
    toast(`created label “${clean}”`, 'ok');
    return true;
  }

  function renameLabel(labelId: string, name: string): boolean {
    const label = store.mdoc.labels?.find(item => item.id === labelId);
    const clean = name.trim();
    if (!label || !clean) return false;
    if (store.mdoc.labels?.some(item => item.id !== labelId && item.name.toLocaleLowerCase() === clean.toLocaleLowerCase())) {
      toast(`a label named “${clean}” already exists`, 'warn'); return false;
    }
    label.name = clean;
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    return true;
  }

  function deleteLabel(labelId: string): void {
    const label = store.mdoc.labels?.find(item => item.id === labelId);
    if (!label) return;
    store.mdoc.labels = store.mdoc.labels!.filter(item => item.id !== labelId);
    if (!store.mdoc.labels.length) delete store.mdoc.labels;
    for (const key of Object.keys(store.mdoc.quadLabels ?? {})) {
      const quad = Number(key), memberships = store.mdoc.quadLabels![quad].filter(id => id !== labelId);
      if (memberships.length) store.mdoc.quadLabels![quad] = memberships; else delete store.mdoc.quadLabels![quad];
    }
    if (store.mdoc.quadLabels && !Object.keys(store.mdoc.quadLabels).length) delete store.mdoc.quadLabels;
    for (const prop of store.mdoc.props ?? []) {
      const memberships = prop.labels?.filter(id => id !== labelId) ?? [];
      if (memberships.length) prop.labels = memberships; else delete prop.labels;
    }
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(`deleted label “${label.name}”`, 'ok');
  }

  function selectLabel(labelId: string, mode: 'replace' | 'add' | 'toggle' = 'replace'): void {
    if (!labelsAvailable() || !store.mdoc.labels?.some(label => label.id === labelId)) return;
    const incomingQuads = Object.entries(store.mdoc.quadLabels ?? {})
      .flatMap(([quad, memberships]) => memberships.includes(labelId) ? [Number(quad)] : []);
    const incomingProps = (store.mdoc.props ?? []).flatMap((prop, index) => prop.labels?.includes(labelId) ? [index] : []);
    const merge = <T>(current: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] => {
      const held = new Map((mode === 'replace' ? [] : current).map(item => [key(item), item]));
      for (const item of incoming) {
        const id = key(item);
        if (mode === 'toggle' && held.has(id)) held.delete(id); else held.set(id, item);
      }
      return [...held.values()];
    };
    if (mode === 'replace') {
      store.selectedCorner = null; store.anchorCorner = null; store.regionSel = []; store.controlSel = [];
      store.edgeSel = []; store.anchorEdge = null;
      store.refControlSel = []; store.refEdgeSel = []; store.refCellSel = [];
    }
    store.cellSel = merge(store.cellSel, quadNames(store.mdoc, incomingQuads), item => item).sort();
    store.anchorCell = store.cellSel[0] ?? null; store.cellLoopSeed = null;
    const currentProps = selectedEditPropIndices();
    store.multiSel = merge(currentProps, incomingProps, item => String(item)).sort((a, b) => a - b);
    store.selectedProp = null;
    resetGizmoMode(); renderEditMarqueeSelection(); refreshSelection(); refreshEditSelectionUi();
  }

  /** The centroid members for the combined gizmo. Mesh vertices and floating points use their exact live
   * positions; placed props contribute their authored origins. Overlapping mesh families share one vertex. */
  function mixedEditAnchorPositions(vertices = mixedEditMoveVertices()): V3[] {
    const doc = mdoc(), positions = vertices.map(vertex => getVertex(doc, vertex));
    const byKey = new Map(meshControlPoints(doc).map(point => [controlPointKey(point.id), point.pos]));
    for (const point of mixedEditFloatingPoints()) {
      const pos = byKey.get(controlPointKey(point));
      if (pos) positions.push(pos);
    }
    for (const index of selectedEditPropIndices()) {
      const prop = store.mdoc.props?.[index];
      if (prop) positions.push(prop.pos);
    }
    return positions;
  }

  /** Which live geometry a control-point write touched, for the incremental preview. */
  function controlPointChange(ids: readonly MeshControlPointId[]) {
    const at = controlPointIndices(mdoc(), ids);
    return {
      vertices: at.flatMap(id => id.kind === 'vertex' ? [id.vertex] : []),
      edges: at.flatMap(id => id.kind === 'edge' ? [[id.from, id.to] as [number, number]] : []),
      quads: at.flatMap(id => id.kind === 'twist' ? [id.quad] : []),
    };
  }

  function rotatableSelection(): boolean {
    if (view().edgeExtrusionStaged) return true;
    if (store.currentMode === 'props') return store.selectedProp !== null || store.multiSel.length > 0;
    if (store.bridgeRails !== null) return false;
    if (mixedEditSelection()) return store.currentMode === 'edit' && cageActive() && mixedEditAnchorPositions().length > 1;
    if (store.controlSel.length) return store.currentMode === 'edit' && cageActive() && movableControlPoints(store.controlSel).length > 1;
    return store.currentMode === 'edit' && cageActive()
      && (store.regionSel.length > 1 || store.edgeSel.length > 0 || store.cellSel.length > 0);
  }

  function previewMeshChange(change: {
    vertices?: readonly number[];
    edges?: readonly [number, number][];
    quads?: readonly number[];
  }) {
    if (view().previewMeshEdit(mdoc(), change)) scheduleCommit();
    else scheduleRebuild();
  }

  function setGizmoMode(mode: 'move' | 'rotate' | 'scale', refresh = false) {
    if (mode === 'scale' && mixedEditSelection()) return;
    if (mode !== 'move' && !rotatableSelection()) return;
    store.gizmoMode = mode;
    view().setGizmoMode(mode);
    if (refresh) { rebuildTools(); updateCmdSheet(); }
  }

  function resetGizmoMode() { setGizmoMode('move'); }

  /** Selection changes affect both the toolbox actions and the bottom Edit context title/shortcuts. */
  function refreshEditSelectionUi() {
    if (store.currentMode !== 'edit') return;
    rebuildTools();
    updateCmdSheet();
  }

  function beginEdgeExtrusion() { resetGizmoMode(); view().beginEdgeExtrusionStage(); }
  function flipEdgeExtrusionSide() { if (view().flipEdgeExtrusionSide()) { rebuildTools(); updateCmdSheet(); } }
  function commitEdgeExtrusion() { view().commitEdgeExtrusionStage(); }
  function cancelEdgeExtrusion() { view().cancelEdgeExtrusionStage(); }

  /** The corners a gizmo drag moves, as live indices - the derive boundary between the named selection and
   *  the geometry it acts on. */
  function editMoveSet(): number[] {
    const locked = lockedVertexSet(mdoc());
    if (store.regionSel.length) return selectedVertexIndices().filter(vertex => !locked.has(vertex));
    const verts = new Set<number>();
    if (store.edgeSel.length) for (const [a, b] of edgeSelIndices()) { verts.add(a); verts.add(b); }
    else for (const q of cellSelIndices()) for (const v of quadVerts(mdoc(), q)) verts.add(v);
    return [...verts].filter(vertex => !locked.has(vertex)).sort((a, b) => a - b);
  }

  function selectedPatchLockState(): { total: number; locked: number } {
    const doc = mdoc(), quads = cellSelIndices();
    return { total: quads.length, locked: quads.filter(quad => quadIsLocked(doc, quad)).length };
  }

  /** A mixed patch selection locks as a set; only an entirely locked selection unlocks. Locking captures the
   * effective boundary handles before setting the flag, so the selected bicubic surfaces stay exact when
   * neighbouring unlocked terrain later moves. */
  function toggleSelectedPatchLocks() {
    const doc = mdoc(), quads = cellSelIndices();
    if (!quads.length) return;
    const state = selectedPatchLockState(), lock = state.locked !== state.total;
    const changed = setQuadsLocked(doc, quads, lock);
    if (!changed) return;
    commitEditMesh(store, doc); // model substrates persist the map through their model record too
    seatEditMoveGizmo();
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(`${changed} ${changed === 1 ? 'patch' : 'patches'} ${lock ? 'locked' : 'unlocked'}`, 'ok');
  }

  function seatEditMoveGizmo() {
    const verts = editMoveSet();
    view().setCornerGroup(verts.map(v => getVertex(mdoc(), v)), verts, false);
  }

  function crossFamilyModifier(family: 'corner' | 'edge' | 'cell'): boolean {
    const active = activeEditFamily();
    return active !== null && active !== family;
  }

  function clearCellSel() {
    if (!store.cellSel.length && store.anchorCell === null) return;
    store.cellSel = [];
    store.anchorCell = null;
    store.cellLoopSeed = null;
    view().refreshEditCells();
    view().setCornerGroup([]);
  }

  function clearEdgeSel() {
    if (!store.edgeSel.length && store.anchorEdge === null) return;
    store.edgeSel = [];
    store.anchorEdge = null;
    view().refreshEditEdges();
    view().setCornerGroup([]);
  }

  function refreshHandles() {
    const d = mdoc();
    selectedDirNb = null;
    const id = store.selectedCorner === null ? null : vertexIndex(d, store.selectedCorner);
    if (store.currentMode !== 'edit' || !cageActive() || id === null) {
      view().showHandles(null, []);
      return;
    }
    const mesh = buildQuadMesh(d.vertices, d.quads, d.freeEdges);
    const adj = meshAdjacency(mesh);
    const eh = meshEdgeHandles(mesh, d.edgeHandles);
    const nb = meshDirNeighbors(adj, id);
    selectedDirNb = nb;
    const corner = getVertex(d, id);
    const nubs = HANDLE_DIRS.filter(dir => nb[dir] >= 0).map(dir => {
      const o = eh(id, nb[dir]);
      return { dir, pos: [corner[0] + o[0], corner[1] + o[1], corner[2] + o[2]] as V3 };
    });
    view().showHandles(corner, nubs);
  }

  function dropCornerSel() {
    store.selectedCorner = null;
    store.regionSel = [];
    store.controlSel = [];
    view().clearCornerSelection();
    view().setCornerGroup([]);
    refreshHandles();
  }

  function applyRegion(names: readonly VertexName[]) {
    const doc = mdoc();
    const { adj } = meshContext(doc);
    const hidden = hiddenMesh();
    const visible = names.filter(name => {
      const vertex = vertexIndex(doc, name);
      return vertex !== null && !vertexIsHidden(vertex, adj, hidden);
    });
    resetGizmoMode();
    store.regionSel = visible;
    store.controlSel = visible.map(vertex => ({ kind: 'vertex', vertex }));
    store.selectedCorner = null;
    view().clearCornerSelection();
    const move = editMoveSet();
    view().setCornerGroup(move.map(i => getVertex(doc, i)), move);
    refreshHandles();
    refreshEditSelectionUi();
  }

  function setRegion(names: readonly VertexName[]) {
    clearCellSel();
    clearEdgeSel();
    applyRegion(names);
  }

  /** Edit-mode placement selection (a placed prop's box + move gizmo) yields to any mesh pick — one
   *  selection at a time owns the toolbox and the gizmo. */
  function dropPlacementSelection() {
    if (store.selectedProp === null && !store.multiSel.length) return;
    store.selectedProp = null;
    store.multiSel = [];
    scheduleRebuild();
  }

  function mergeMarqueeSet<T>(current: readonly T[], incoming: readonly T[], key: (value: T) => string,
    mode: 'replace' | 'add' | 'remove'): T[] {
    const map = new Map((mode === 'replace' ? [] : current).map(value => [key(value), value]));
    for (const value of incoming) {
      const id = key(value);
      if (mode === 'remove') map.delete(id); else map.set(id, value);
    }
    return [...map.values()];
  }

  /** Redraw all authored marquee families together. One family keeps its existing transform behavior; two or
   * more families share a Move / Rotate centroid while the toolbox remains a count-based type chooser. */
  function renderEditMarqueeSelection() {
    const doc = mdoc();
    view().clearCornerSelection();
    store.selectedCorner = null;

    const floating = store.controlSel.some(id => id.kind !== 'vertex');
    if (floating) {
      view().setCornerGroup([]);
      view().setControlPointSelection(store.controlSel);
    } else {
      view().setControlPointSelection([]);
      const vertices = vertexIndices(doc, store.regionSel);
      view().setCornerGroup(vertices.map(vertex => getVertex(doc, vertex)), vertices);
    }
    view().refreshEditEdges();
    view().refreshEditCells();
    view().setPlacedPropSelection(null, store.multiSel);

    const kinds = selectedEditKindCount();
    if (kinds > 1) {
      const vertices = mixedEditMoveVertices();
      view().setEditMixedGroup(mixedEditAnchorPositions(vertices), vertices);
    }
    else if (kinds === 0) view().detachSelectionGizmo();
    else if (store.edgeSel.length || store.cellSel.length) seatEditMoveGizmo();
    refreshHandles();
  }

  /** Commit one Edit marquee atomically, so the ordinary family setters never clear an earlier family from
   * the same rectangle. Stable mesh names enter the store here; props remain live document indices. */
  function selectEditMarquee(selection: EditMarqueeSelection, mode: 'replace' | 'add' | 'remove') {
    if (store.bridgeRails !== null) return;
    const doc = mdoc();
    const currentPoints = store.controlSel.length
      ? store.controlSel
      : store.regionSel.length
        ? store.regionSel.map(vertex => ({ kind: 'vertex', vertex }) as MeshControlPointId)
        : store.selectedCorner !== null ? [{ kind: 'vertex', vertex: store.selectedCorner } as MeshControlPointId] : [];
    const incomingPoints = selection.points.filter(point => controlPointIndex(doc, point) !== null);
    const incomingEdges = namedEdges(doc, selection.edges);
    const incomingPatches = quadNames(doc, selection.patches);
    const currentProps = store.multiSel.length ? store.multiSel
      : store.selectedProp !== null ? [store.selectedProp] : [];
    const incomingProps = store.modelEditId ? []
      : selection.props.filter(index => index >= 0 && index < (store.mdoc.props?.length ?? 0));

    const points = mergeMarqueeSet(currentPoints, incomingPoints, controlPointKey, mode);
    store.edgeSel = mergeMarqueeSet(store.edgeSel, incomingEdges, nameKey, mode);
    store.cellSel = mergeMarqueeSet(store.cellSel, incomingPatches, name => name, mode).sort();
    store.multiSel = mergeMarqueeSet(currentProps, incomingProps, index => `${index}`, mode)
      .sort((a, b) => a - b);
    store.selectedProp = null;
    store.selectedCorner = null;
    store.controlSel = points;
    store.regionSel = points.flatMap(point => point.kind === 'vertex' ? [point.vertex] : []).sort();
    store.anchorCorner = null;
    store.anchorEdge = null;
    store.anchorCell = null;
    store.cellLoopSeed = null;
    store.selectedEdgeCrossing = null;
    store.selectedCoincidentVertices = null;
    resetGizmoMode();
    renderEditMarqueeSelection();
    refreshEditSelectionUi();
  }

  /** Ctrl/Cmd-click prop selection uses the same mixed-family state as the marquee: toggle only this prop,
   * preserve every mesh family, then redraw one combined selection and centroid. */
  function toggleEditProp(index: number) {
    if (store.currentMode !== 'edit' || index < 0 || index >= (store.mdoc.props?.length ?? 0)) return;
    const props = new Set(selectedEditPropIndices());
    if (props.has(index)) props.delete(index); else props.add(index);
    store.selectedProp = null;
    store.multiSel = [...props].sort((a, b) => a - b);
    resetGizmoMode();
    renderEditMarqueeSelection();
    refreshEditSelectionUi();
  }

  /** The mixed-count chooser calls this to keep one family and hand that already-highlighted set back to its
   * existing type-specific toolbox and transform behavior. */
  function narrowEditSelection(kind: EditSelectionKind) {
    const referenceActive = store.refControlSel.length > 0 || store.refEdgeSel.length > 0 || store.refCellSel.length > 0;
    if (referenceActive && kind !== 'prop') {
      view().narrowReferenceEditSelection(kind);
      rebuildTools(); updateCmdSheet();
      return;
    }
    if (kind !== 'point') {
      store.selectedCorner = null; store.regionSel = []; store.controlSel = []; store.anchorCorner = null;
    }
    if (kind !== 'edge') { store.edgeSel = []; store.anchorEdge = null; }
    if (kind !== 'patch') {
      store.cellSel = []; store.anchorCell = null; store.cellLoopSeed = null;
    }
    if (kind !== 'prop') { store.selectedProp = null; store.multiSel = []; }
    resetGizmoMode();
    renderEditMarqueeSelection();
    rebuildTools(); updateCmdSheet();
  }

  function selectCornerMulti(vertex: number, mode: 'toggle' | 'range') {
    if (mode !== 'toggle') dropPlacementSelection();
    const doc = mdoc();
    const name = vertexName(doc, vertex);
    if (name === null) return;
    const { adj } = meshContext(doc);
    const current = store.regionSel.length ? store.regionSel : store.selectedCorner !== null ? [store.selectedCorner] : [];
    const result = resolveVertexSelection(current, store.anchorCorner, name, mode, adj, vertexNaming(doc));
    if (mode === 'toggle') {
      resetGizmoMode();
      store.selectedCorner = null;
      store.regionSel = result.verts;
      store.controlSel = result.verts.map(vertex => ({ kind: 'vertex', vertex }));
      store.anchorCorner = result.verts.length ? result.anchor : null;
      renderEditMarqueeSelection();
      refreshEditSelectionUi();
      return;
    }
    if (!result.verts.length) { store.anchorCorner = null; dropCornerSel(); refreshEditSelectionUi(); return; }
    store.anchorCorner = result.anchor;
    setRegion(result.verts);
  }

  function selectControlPoints(incoming: readonly MeshControlPointId[], mode: 'replace' | 'add' | 'remove' | 'toggle') {
    if (mode !== 'replace' && mode !== 'toggle' && crossFamilyModifier('corner')) return;
    if (mode !== 'toggle') dropPlacementSelection();
    const seed = store.controlSel.length
      ? store.controlSel
      : store.regionSel.length
        ? store.regionSel.map(vertex => ({ kind: 'vertex', vertex }) as MeshControlPointId)
        : store.selectedCorner !== null ? [{ kind: 'vertex', vertex: store.selectedCorner } as MeshControlPointId] : [];
    const map = new Map((mode === 'replace' ? [] : seed).map(id => [controlPointKey(id), id]));
    for (const id of incoming) {
      const key = controlPointKey(id);
      if (mode === 'remove' || (mode === 'toggle' && map.has(key))) map.delete(key); else map.set(key, id);
    }
    const ids = [...map.values()];
    const vertices = ids.flatMap(id => id.kind === 'vertex' ? [id.vertex] : []).sort();
    if (mode === 'toggle') {
      resetGizmoMode();
      store.selectedCorner = null;
      store.anchorCorner = null;
      store.controlSel = ids;
      store.regionSel = vertices;
      renderEditMarqueeSelection();
      refreshEditSelectionUi();
      return;
    }
    if (ids.length === vertices.length) { applyRegion(vertices); return; }

    resetGizmoMode();
    clearCellSel();
    clearEdgeSel();
    store.selectedCorner = null;
    store.anchorCorner = null;
    store.controlSel = ids;
    store.regionSel = vertices;
    view().clearCornerSelection();
    view().setControlPointSelection(ids);
    refreshHandles();
    refreshEditSelectionUi();
  }

  function selectEditCell(quad: number, mode: 'replace' | 'toggle' | 'range') {
    if (mode !== 'toggle') dropPlacementSelection();
    const doc = mdoc();
    const name = quadName(doc, quad);
    if (name === null) return;
    const naming = quadNaming(doc);
    // Plain/Ctrl clicks are flat set operations and must stay O(selection), not O(the whole mountain).
    // Only Shift-range needs the derived surface topology used to trace a rectangular patch block.
    const result = mode === 'range'
      ? resolveCellSelection(store.cellSel, store.anchorCell, name, mode, naming, meshContext(doc).mesh.topology)
      : resolveCellSelection(store.cellSel, store.anchorCell, name, mode, naming);
    if (name !== store.cellLoopSeed) store.cellLoopSeed = null;
    resetGizmoMode();
    const hidden = hiddenMesh();
    const cells = result.cells.filter(cell => {
      const at = quadIndex(doc, cell);
      return at !== null && !quadIsHidden(at, hidden);
    });
    if (mode === 'toggle') {
      store.cellSel = cells;
      store.anchorCell = result.anchor;
      renderEditMarqueeSelection();
      refreshEditSelectionUi();
      return;
    }
    if (!cells.length) { clearCellSel(); refreshEditSelectionUi(); return; }
    dropCornerSel();
    clearEdgeSel();
    store.cellSel = cells;
    store.anchorCell = result.anchor;
    view().refreshEditCells();
    seatEditMoveGizmo();
    refreshEditSelectionUi();
  }

  function selectCellLoop(quad: number, additive: boolean) {
    dropPlacementSelection();
    const doc = mdoc();
    const name = quadName(doc, quad);
    if (name === null) return;
    const { mesh } = meshContext(doc);
    const dir: 0 | 1 = name === store.cellLoopSeed ? (store.cellLoopDir === 0 ? 1 : 0) : 0;
    const result = resolveCellSelection(
      store.cellSel, store.anchorCell, name, additive ? 'loopAdd' : 'loop', quadNaming(doc), mesh.topology, dir);
    const hidden = hiddenMesh();
    const cells = result.cells.filter(cell => {
      const at = quadIndex(doc, cell);
      return at !== null && !quadIsHidden(at, hidden);
    });
    resetGizmoMode();
    store.cellLoopSeed = name;
    store.cellLoopDir = dir;
    dropCornerSel();
    clearEdgeSel();
    store.cellSel = cells;
    store.anchorCell = result.anchor;
    view().refreshEditCells();
    seatEditMoveGizmo();
    refreshEditSelectionUi();
  }

  function selectEditEdge(edge: [number, number], mode: EdgeSelectMode) {
    if (mode !== 'toggle') dropPlacementSelection();
    const doc = mdoc();
    const named = namedEdge(doc, edge);
    if (!named) return;
    const { mesh, adj } = meshContext(doc);
    const result = resolveEdgeSelection(store.edgeSel, store.anchorEdge, named, mode, mesh, adj, vertexNaming(doc));
    const hidden = hiddenMesh();
    const edges = result.edges.filter(candidate => {
      const at = edgeIndex(doc, candidate);
      return at !== null && !edgeIsHidden(at[0], at[1], adj, hidden);
    });
    resetGizmoMode();
    if (mode === 'toggle') {
      store.edgeSel = edges;
      store.anchorEdge = result.anchor;
      renderEditMarqueeSelection();
      refreshEditSelectionUi();
      return;
    }
    if (store.selectedCorner !== null || store.regionSel.length) dropCornerSel();
    clearCellSel();
    store.edgeSel = edges;
    store.anchorEdge = result.anchor;
    view().refreshEditEdges();
    if (store.bridgeRails === null) seatEditMoveGizmo(); else view().setCornerGroup([]);
    refreshEditSelectionUi();
  }

  function ripEdges() {
    if (store.edgeSel.length < 2) return;
    const result = applyEdgeRip(mdoc(), edgeSelIndices(), 1);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    const edgeHeight = ([a, b]: [number, number]) =>
      (result.doc.vertices[a * 3 + 1] + result.doc.vertices[b * 3 + 1]) / 2;
    const topEdge = result.lips.flat().reduce<[number, number] | null>((best, edge) => {
      if (!best) return edge;
      const dh = edgeHeight(edge) - edgeHeight(best);
      const earlier = edge[0] < best[0] || (edge[0] === best[0] && edge[1] < best[1]);
      return dh > 1e-9 || (Math.abs(dh) <= 1e-9 && earlier) ? edge : best;
    }, null);
    store.edgeSel = topEdge ? namedEdges(mdoc(), [topEdge]) : [];
    store.anchorEdge = store.edgeSel[0] ?? null;
    resetGizmoMode();
    scheduleRebuild();
    requestAnimationFrame(() => { view().refreshEditEdges(); seatEditMoveGizmo(); });
    rebuildTools(); updateCmdSheet();
  }

  function insertCellEdge() {
    if (!store.cellSel.length) return;
    const result = applyCellEdgeInsert(mdoc(), cellSelIndices());
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    scheduleRebuild();
  }

  function resetCellShape(cells: readonly QuadName[]) {
    if (!canEditCurvature()) return;
    meshResetShape(mdoc(), quadIndices(mdoc(), cells));
    refreshHandles();
    scheduleRebuild();
  }

  function creaseVertices(vertices: readonly VertexName[]) {
    if (!canEditCurvature()) return;
    meshCreaseVertices(mdoc(), vertexIndices(mdoc(), vertices));
    refreshHandles();
    scheduleRebuild();
  }

  function smoothVertices(vertices: readonly VertexName[]) {
    if (!canEditCurvature()) return;
    meshSmoothVertices(mdoc(), vertexIndices(mdoc(), vertices));
    refreshHandles();
    scheduleRebuild();
  }

  const topology = createTopologyTools({
    store,
    viewport: getViewport,
    cageActive,
    applyCage,
    persistUi,
    scheduleRebuild,
    rebuildTools,
    updateCmdSheet,
    clearEdgeSelection: clearEdgeSel,
    clearCellSelection: clearCellSel,
    dropCornerSelection: dropCornerSel,
    exitRegion,
    seatMoveGizmo: seatEditMoveGizmo,
    resetGizmoMode,
  });

  function exitRegion() {
    store.regionSel = [];
    store.controlSel = [];
    store.anchorCorner = null;
    clearCellSel();
    clearEdgeSel();
    view().setCornerGroup([]);
    view().setControlPointSelection([]);
  }

  function deselectEdit() {
    resetGizmoMode();
    topology.cancelBridge(false, false);
    dropPlacementSelection(); // an Edit-mode placed-prop selection (box + gizmo + banner) is a selection too
    store.selected = null;
    store.selectedCorner = null;
    store.selectedEdgeCrossing = null;
    store.selectedCoincidentVertices = null;
    store.anchorCorner = null;
    topology.clearCreateEdge();
    exitRegion();
    view().clearCornerSelection();
    refreshHandles(); refreshSelection(); rebuildTools(); updateCmdSheet(); scheduleRebuild();
  }

  function selectEdgeCrossing(crossing: EdgeCrossing | null) {
    const named = crossing ? namedEdgeCrossing(mdoc(), crossing) : null;
    if (!named && !store.selectedEdgeCrossing) return;
    resetGizmoMode();
    store.selectedEdgeCrossing = named;
    if (named) {
      store.selectedCoincidentVertices = null;
      // The pointer router may also select a real vertex at this marker. Keep that ordinary selection and its
      // gizmo alive; this record only raises the crossing warning and weld action above its normal details.
      store.selected = null;
    }
    rebuildTools(); updateCmdSheet();
  }

  function selectCoincidentVertices(diagnostic: CoincidentVertices | null) {
    const named = diagnostic ? namedCoincidentVertices(mdoc(), diagnostic) : null;
    if (!named && !store.selectedCoincidentVertices) return;
    resetGizmoMode();
    store.selectedCoincidentVertices = named;
    if (named) {
      store.selectedEdgeCrossing = null;
      // Coincident IDs are still movable mesh vertices. The following corner callback expands them into the
      // existing group-selection path and seats its centroid gizmo while this diagnostic remains selected.
      store.selected = null;
    }
    rebuildTools(); updateCmdSheet();
  }

  /** A diagnostic is clicked, then acted on later, so what it names is resolved fresh at that point: an edit
   *  in between can have removed the very geometry it reported on. */
  const STALE_DIAGNOSTIC = 'That diagnostic names geometry this mountain no longer carries — select it again.';

  function weldSelectedEdgeCrossing() {
    const named = store.selectedEdgeCrossing;
    if (!named) return;
    const crossing = edgeCrossingIndex(mdoc(), named);
    if (!crossing) { store.selectedEdgeCrossing = null; toast(STALE_DIAGNOSTIC, 'err'); return; }
    const result = applyEdgeCrossingWeld(mdoc(), crossing);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    store.selectedEdgeCrossing = null;
    const welded = vertexName(mdoc(), result.vertex);
    store.selectedCorner = welded; store.anchorCorner = welded;
    exitRegion(); scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('crossing welded · one shared vertex created', 'ok');
  }

  function weldSelectedCoincidentVertices() {
    const named = store.selectedCoincidentVertices;
    if (!named) return;
    const pair = coincidentVertexIndices(mdoc(), named);
    if (!pair) { store.selectedCoincidentVertices = null; toast(STALE_DIAGNOSTIC, 'err'); return; }
    const survivor = Math.min(...pair), removed = Math.max(...pair);
    const survivorName = vertexName(mdoc(), survivor);
    const result = applyVertexWeld(mdoc(), [[removed, survivor]]);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    store.selectedCoincidentVertices = null;
    store.selectedCorner = survivorName; store.anchorCorner = survivorName;
    exitRegion(); scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('coincident points welded', 'ok');
  }

  function selectedAuthoredVertexIds(): VertexName[] {
    if (store.regionSel.length) return store.regionSel;
    return store.selectedCorner !== null ? [store.selectedCorner] : [];
  }

  /** Capture the current corner selection as the vertices that will disappear. Targets are then selected with
   * the normal point tools, so Shift selection and marquee selection keep working during the weld workflow. */
  function beginPointWeld() {
    const source = [...new Set(selectedAuthoredVertexIds())];
    if (!source.length) { toast('select one or more source points first', 'err'); return; }
    store.weldSource = source;
    store.weldEdgeSource = [];
    store.weldTool = 'weld';
    if (store.surgeryTool) { store.surgeryTool = null; view().setSurgeryTool(null); }
    const marks = vertexIndices(mdoc(), source);
    dropCornerSel(); clearCellSel(); clearEdgeSel();
    view().setWeldTool(marks);
    rebuildTools(); updateCmdSheet();
  }

  function cancelPointWeld() {
    const source = store.weldSource.filter(name => vAt(name) !== null);
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setWeldTool(false);
    dropCornerSel();
    if (source.length) applyRegion(source);
    rebuildTools(); updateCmdSheet();
  }

  /** Pair unordered sets by minimum total geometric distance (exact for normal-sized selections, with a
   * deterministic nearest fallback for very large sets). Box-selected rows/fans therefore pair by shape rather
   * than unrelated vertex-id ordering. */
  function nearestWeldPairs(source: readonly number[], target: readonly number[]): [number, number][] {
    const from = [...source], into = [...target];
    const distance = (a: number, b: number) => {
      const pa = getVertex(mdoc(), a), pb = getVertex(mdoc(), b);
      return (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2;
    };
    if (from.length <= 12) {
      const memo = new Map<string, { cost: number; target: number }>();
      const solve = (i: number, used: number): number => {
        if (i === from.length) return 0;
        const key = `${i}:${used}`, cached = memo.get(key);
        if (cached) return cached.cost;
        let cost = Infinity, choice = -1;
        for (let j = 0; j < into.length; j++) if (!(used & (1 << j))) {
          const candidate = distance(from[i], into[j]) + solve(i + 1, used | (1 << j));
          if (candidate < cost) { cost = candidate; choice = j; }
        }
        memo.set(key, { cost, target: choice });
        return cost;
      };
      solve(0, 0);
      let used = 0;
      return from.map((vertex, i) => {
        const j = memo.get(`${i}:${used}`)!.target;
        used |= 1 << j;
        return [vertex, into[j]];
      });
    }
    const pairs: [number, number][] = [];
    while (from.length) {
      let bestFrom = 0, bestInto = 0, best = Infinity;
      for (let i = 0; i < from.length; i++) for (let j = 0; j < into.length; j++) {
        const d = distance(from[i], into[j]);
        if (d < best) { best = d; bestFrom = i; bestInto = j; }
      }
      pairs.push([from.splice(bestFrom, 1)[0], into.splice(bestInto, 1)[0]]);
    }
    return pairs;
  }

  const STALE_WELD = 'That weld names geometry this mountain no longer carries — pick its points again.';

  function commitPointWeld() {
    const sourceNames = [...new Set(store.weldSource)], targetNames = [...new Set(selectedAuthoredVertexIds())];
    if (!sourceNames.length || targetNames.length !== sourceNames.length) {
      toast(`select exactly ${sourceNames.length} target ${sourceNames.length === 1 ? 'point' : 'points'} before committing`, 'err');
      return;
    }
    if (targetNames.some(name => sourceNames.includes(name))) { toast('source and target point sets must be separate', 'err'); return; }
    const doc = mdoc();
    const source = vertexIndices(doc, sourceNames), target = vertexIndices(doc, targetNames);
    if (source.length !== sourceNames.length || target.length !== targetNames.length) { toast(STALE_WELD, 'err'); return; }
    const result = applyVertexWeld(doc, nearestWeldPairs(source, target));
    if (!result.ok) { toast(result.error, 'err'); return; }
    finishPointWeld(result.doc, `${source.length} ${source.length === 1 ? 'point' : 'points'} welded`);
  }

  /** Merge the captured source selection into one of its own points, with no separate target-picking step. */
  function commitPointWeldTogether() {
    const sourceNames = [...new Set(store.weldSource)];
    const source = vertexIndices(mdoc(), sourceNames);
    if (source.length !== sourceNames.length) { toast(STALE_WELD, 'err'); return; }
    const result = applyVertexWeldTogether(mdoc(), source);
    if (!result.ok) { toast(result.error, 'err'); return; }
    finishPointWeld(result.doc, `${source.length} points welded to each other`);
  }

  function finishPointWeld(doc: QuadMeshDoc, message: string) {
    commitEditMesh(store, doc);
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setWeldTool(false);
    dropCornerSel(); exitRegion(); scheduleRebuild();
    rebuildTools(); updateCmdSheet();
    toast(message, 'ok');
  }

  function beginEdgeWeld() {
    if (!store.edgeSel.length) { toast('select one or more source edges first', 'err'); return; }
    store.weldEdgeSource = store.edgeSel.map(edge => [...edge] as NamedEdge);
    store.weldTool = 'edge-weld';
    store.weldSource = [];
    if (store.surgeryTool) { store.surgeryTool = null; view().setSurgeryTool(null); }
    const marks = edgeIndices(mdoc(), store.weldEdgeSource);
    clearEdgeSel();
    view().setEdgeWeldTool(marks);
    rebuildTools(); updateCmdSheet();
  }

  function cancelEdgeWeld() {
    const source = store.weldEdgeSource.map(edge => [...edge] as NamedEdge);
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
    view().setEdgeWeldTool(null);
    clearEdgeSel();
    if (source.length) {
      store.edgeSel = source; store.anchorEdge = source[0];
      view().refreshEditEdges(); seatEditMoveGizmo();
    }
    rebuildTools(); updateCmdSheet();
  }

  function commitEdgeWeld() {
    const sourceNames = store.weldEdgeSource, targetNames = store.edgeSel;
    if (!sourceNames.length || !targetNames.length) { toast('select a target edge set before committing', 'err'); return; }
    const sourceKeys = new Set(sourceNames.map(nameKey));
    if (targetNames.some(edge => sourceKeys.has(nameKey(edge)))) {
      toast('source and target edge sets must be separate', 'err'); return;
    }
    const doc = mdoc();
    const source = edgeIndices(doc, sourceNames), target = edgeIndices(doc, targetNames);
    if (source.length !== sourceNames.length || target.length !== targetNames.length) { toast(STALE_WELD, 'err'); return; }
    const sourceLoop = boundaryEdgeLoopVertices(doc, source);
    const targetLoop = boundaryEdgeLoopVertices(doc, target);
    if (sourceLoop.ok && !targetLoop.ok) {
      toast(`select one complete target boundary loop — ${targetLoop.error}`, 'err'); return;
    }
    if (!sourceLoop.ok && target.length !== source.length) {
      toast(`select exactly ${source.length} target ${source.length === 1 ? 'edge' : 'edges'} before committing`, 'err');
      return;
    }
    const loopWeld = sourceLoop.ok && targetLoop.ok;
    const loopResult = loopWeld ? applyEdgeLoopWeld(doc, source, target) : null;
    const result = loopResult ?? applyEdgeWeldSets(doc, source, target);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    store.weldTool = null; store.weldSource = []; store.weldEdgeSource = [];
    view().setEdgeWeldTool(null);
    clearEdgeSel(); dropCornerSel(); exitRegion(); scheduleRebuild();
    rebuildTools(); updateCmdSheet();
    toast(loopResult?.ok
      ? `${loopResult.quads.length} seam ${loopResult.quads.length === 1 ? 'patch' : 'patches'} welded between loops`
      : `${source.length} ${source.length === 1 ? 'edge' : 'edges'} welded`, 'ok');
  }

  function selectedMeshDeleteInput(): MeshDeleteSelection {
    return { vertices: selectedVertexIndices(), edges: edgeSelIndices(), quads: cellSelIndices() };
  }
  function meshDeleteTargetCount(): number {
    if (store.currentMode !== 'edit' || !cageActive()) return 0;
    return meshDeleteTargets(mdoc(), selectedMeshDeleteInput()).length;
  }
  function selectedFreeEdgeCount(): number {
    const free = new Set((mdoc().freeEdges ?? []).map(([a, b]) => ekey(a, b)));
    return edgeSelIndices().filter(([a, b]) => free.has(ekey(a, b))).length;
  }
  function canDeleteMeshSelection(): boolean {
    return store.currentMode === 'edit' && cageActive() && !mixedEditSelection()
      && (selectedAuthoredVertexIds().length > 0 || meshDeleteTargetCount() > 0 || selectedFreeEdgeCount() > 0);
  }

  function deleteSelectedMesh() {
    if (store.currentMode !== 'edit' || !cageActive() || mixedEditSelection()) return;
    const selectedPoints = new Set(selectedAuthoredVertexIds()).size;
    const selectedFreeEdges = selectedFreeEdgeCount();
    const result = applyMeshDelete(mdoc(), selectedMeshDeleteInput());
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    dropCornerSel(); exitRegion(); scheduleRebuild(); rebuildTools(); updateCmdSheet();
    const parts: string[] = [];
    if (selectedPoints) parts.push(`deleted ${selectedPoints} ${selectedPoints === 1 ? 'point' : 'points'}`);
    if (selectedFreeEdges) parts.push(`deleted ${selectedFreeEdges} free ${selectedFreeEdges === 1 ? 'edge' : 'edges'}`);
    if (result.quads) parts.push(`${result.quads} ${result.quads === 1 ? 'patch' : 'patches'}`);
    const cleanup = Math.max(0, result.vertices - selectedPoints);
    if (cleanup) parts.push(`${cleanup} ${selectedPoints ? 'other ' : ''}unused ${cleanup === 1 ? 'vertex' : 'vertices'}`);
    toast(parts.join(' · '), 'ok');
  }

  function dissolveSelectedMesh() {
    if (mixedEditSelection()) return;
    const selection = { vertices: selectedVertexIndices(), edges: edgeSelIndices() };
    const result = applyMeshDissolve(mdoc(), selection);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    dropCornerSel(); exitRegion(); scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast('selection dissolved · skipped boundary points are marked as T-junctions', 'ok');
  }

  function canDissolveSelectedMesh(): boolean {
    return !mixedEditSelection()
      && applyMeshDissolve(mdoc(), { vertices: selectedVertexIndices(), edges: edgeSelIndices() }).ok;
  }

  /** Reverse the ridable side of the selected patches (core/mesh/ops/flip.ts). Ids are untouched, so the
   *  selection survives and a second press flips straight back. */
  function flipSelectedMesh() {
    if (store.currentMode !== 'edit' || !cageActive() || !store.cellSel.length || mixedEditSelection()) return;
    const result = applyMeshFlip(mdoc(), cellSelIndices());
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    scheduleRebuild(); rebuildTools(); updateCmdSheet();
    toast(`${result.flipped} ${result.flipped === 1 ? 'patch' : 'patches'} flipped — ridable side reversed`, 'ok');
  }

  function canFlipSelectedMesh(): boolean {
    return store.currentMode === 'edit' && cageActive() && store.cellSel.length > 0 && !mixedEditSelection();
  }

  const clipboard = createMeshClipboardSession({
    store,
    viewport: getViewport,
    cageActive,
    selectedAuthoredVertices: selectedAuthoredVertexIds,
    editMoveSet,
    seatMoveGizmo: seatEditMoveGizmo,
    resetGizmoMode,
    deselectEdit,
    refreshHandles,
    scheduleRebuild,
    rebuildTools,
    updateCmdSheet,
    deleteSelectedMesh,
  });

  function slidePlanPreviewChange(plan: SlidePlan) {
    const vertices: number[] = [], edges: [number, number][] = [], quads: number[] = [];
    for (const pass of plan.passes) {
      if (pass.kind === 'edges') for (const item of pass.items) { edges.push([item.edge[0], item.edge[1]]); quads.push(item.quad); vertices.push(...item.edge); }
      else if (pass.kind === 'verts') for (const item of pass.items) vertices.push(item.vertex);
      else if (pass.kind === 'patch') { vertices.push(pass.vertex); quads.push(pass.quad); }
      else for (const item of pass.items) vertices.push(item.vertex);
    }
    return { vertices, edges, quads };
  }

  function slideFrom(recut: (doc: QuadMeshDoc) => void, change: { vertices?: readonly number[]; edges?: readonly [number, number][]; quads?: readonly number[] }) {
    if (!slideBase) return;
    const doc = structuredClone(slideBase);
    recut(doc);
    commitEditMesh(store, doc);
    previewMeshChange(change);
  }

  function commitSlide(mergePending: boolean) {
    const pairs = slideWeld;
    slideBase = null;
    slideWeld = [];
    if (!mergePending || !pairs.length) return;
    const result = applyVertexWeld(mdoc(), pairs);
    if (!result.ok) { toast(result.error, 'err'); return; }
    commitEditMesh(store, result.doc);
    dropCornerSel(); exitRegion(); scheduleRebuild();
    if (store.currentMode === 'edit') rebuildTools();
  }

  /**
   * One frame of a rigid Rotate / Scale. The drag froze its members by NAME before the gesture began, so this
   * resolves each one onto the document as it stands now and writes the absolute value there — what the drag
   * captured is what moves, whatever the arrays have done in between (docs/039).
   */
  function writeRigidCornerUpdate(update: RigidCornerUpdate) {
    const doc = mdoc();
    const lockedVertices = lockedVertexSet(doc), lockedEdges = lockedEdgeSet(doc);
    const vertices: number[] = [], marks: V3[] = [];
    for (const item of update.vertices) {
      const vertex = vertexIndex(doc, item.vertex);
      if (vertex === null || lockedVertices.has(vertex)) continue;
      setVertex(doc, vertex, item.pos);
      vertices.push(vertex);
      marks.push(item.pos);
    }
    const edges: [number, number][] = [];
    if (update.edgeHandles.length) {
      const handles = (doc.edgeHandles ??= {});
      for (const handle of update.edgeHandles) {
        const at = directedEdgeIndex(doc, handle.from, handle.to);
        if (!at || edgeIsLocked(doc, at[0], at[1], lockedEdges)) continue;
        handles[`${at[0]}>${at[1]}`] = handle.offset;
        edges.push(at);
      }
    }
    const quads: number[] = [];
    if (update.quadTwist.length) {
      const twist = (doc.quadTwist ??= {});
      for (const item of update.quadTwist) {
        const quad = quadIndex(doc, item.quad);
        if (quad === null || quadIsLocked(doc, quad)) continue;
        twist[quad] = item.offsets;
        quads.push(quad);
      }
    }
    return { change: { vertices, edges, quads }, marks };
  }

  function applyRigidCornerUpdate(update: RigidCornerUpdate) {
    const written = writeRigidCornerUpdate(update);
    previewMeshChange(written.change);
    if (store.regionSel.length) view().setRegionMarks(written.marks);
  }

  const viewportCallbacks: EditViewportCallbacks = {
    onSelectCorner(index) {
      if (store.bridgeRails !== null) return;
      dropPlacementSelection();
      resetGizmoMode();
      if (store.controlSel.length) view().setControlPointSelection([]);
      const doc = mdoc();
      const name = index === null ? null : vertexName(doc, index);
      if (index !== null && name !== null) {
        const coincident = coincidentVertexGroup(doc, index);
        if (coincident.length > 1) {
          store.anchorCorner = name;
          setRegion(vertexNames(doc, coincident));
          log('');
          return;
        }
      }
      store.selectedCorner = name;
      store.controlSel = [];
      store.anchorCorner = name;
      clearCellSel(); clearEdgeSel();
      if (store.regionSel.length) { store.regionSel = []; view().setCornerGroup([]); }
      log(''); refreshHandles();
      refreshEditSelectionUi();
    },
    onSelectCorners(indices, mode = 'replace') {
      if (store.bridgeRails !== null) return;
      dropPlacementSelection();
      const names = vertexNames(mdoc(), indices);
      if (mode !== 'replace') {
        if (!names.length || crossFamilyModifier('corner')) return;
        const current = store.regionSel.length ? store.regionSel : store.selectedCorner !== null ? [store.selectedCorner] : [];
        const boxed = new Set(names);
        const next = mode === 'add' ? [...new Set([...current, ...names])] : current.filter(name => !boxed.has(name));
        setRegion(next.sort());
        return;
      }
      setRegion(names);
    },
    onSelectEditMarquee(selection, mode) { selectEditMarquee(selection, mode); },
    onSelectControlPoints(ids, mode) { if (store.bridgeRails === null) selectControlPoints(ids, mode); },
    onRangeSelectCorner(index) { if (store.bridgeRails === null && !crossFamilyModifier('corner')) selectCornerMulti(index, 'range'); },
    onToggleCorner(index) { if (store.bridgeRails === null) selectCornerMulti(index, 'toggle'); },
    onMoveCorners(delta) {
      const change = moveMeshVerticesProportional(mdoc(), editMoveSet(), delta);
      previewMeshChange(change);
      if (store.regionSel.length) view().setRegionMarks(selectedVertexIndices().map(i => getVertex(mdoc(), i)));
    },
    onMoveControlPoints(delta) {
      const movable = movableControlPoints(store.controlSel);
      if (!movable.length) return;
      moveMeshControlPoints(mdoc(), movable, delta);
      previewMeshChange(controlPointChange(movable));
    },
    onMoveMixedEditSelection(delta) {
      if (!mixedEditSelection()) return;
      const doc = mdoc();
      // Snapshot direct floating points before the topology move. Re-applying their absolute translated
      // positions afterward preserves exact point motion even when their owner edge/patch also participates.
      const floating = mixedEditFloatingPoints();
      const live = new Map(meshControlPoints(doc).map(point => [controlPointKey(point.id), point.pos]));
      const targets = floating.flatMap(id => {
        const pos = live.get(controlPointKey(id));
        return pos ? [{ id, pos: [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2]] as V3 }] : [];
      });
      const proportional = moveMeshVerticesProportional(doc, mixedEditMoveVertices(), delta);
      const movedFloating = setMeshControlPoints(doc, targets);
      if (proportional.vertices.length || movedFloating) {
        const direct = movedFloating ? controlPointChange(floating) : { vertices: [], edges: [], quads: [] };
        const edges = new Map([...proportional.edges, ...direct.edges]
          .map(edge => [ekey(edge[0], edge[1]), edge] as const));
        previewMeshChange({
          vertices: [...new Set([...proportional.vertices, ...direct.vertices])],
          edges: [...edges.values()],
          quads: [...new Set([...proportional.quads, ...direct.quads])],
        });
      }
      // Vertex-only point marquees draw their orange marks through setCornerGroup rather than the live
      // control-point cache. Refresh those marks explicitly so they follow the combined anchor every frame.
      if (store.regionSel.length && !store.controlSel.some(point => point.kind !== 'vertex'))
        view().setRegionMarks(selectedVertexIndices().map(vertex => getVertex(doc, vertex)));
      let propsMoved = false;
      for (const index of selectedEditPropIndices()) {
        const prop = store.mdoc.props?.[index];
        if (!prop) continue;
        prop.pos[0] += delta[0]; prop.pos[1] += delta[1]; prop.pos[2] += delta[2];
        propsMoved = true;
      }
      if (propsMoved) scheduleRebuild();
    },
    onRotateMixedEditSelection(update) {
      if (!mixedEditSelection()) return;
      const doc = mdoc();
      const rigid = writeRigidCornerUpdate(update.corners);
      const movable = new Set(movableControlPoints(store.controlSel).map(controlPointKey));
      const controlPoints = update.controlPoints.filter(target => movable.has(controlPointKey(target.id)));
      const movedControlPoints = setMeshControlPoints(doc, controlPoints);
      const direct = movedControlPoints
        ? controlPointChange(controlPoints.map(target => target.id)) : { vertices: [], edges: [], quads: [] };
      if (rigid.change.vertices.length || rigid.change.edges.length || rigid.change.quads.length || movedControlPoints) {
        const edges = new Map([...rigid.change.edges, ...direct.edges]
          .map(edge => [ekey(edge[0], edge[1]), edge] as const));
        previewMeshChange({
          vertices: [...new Set([...rigid.change.vertices, ...direct.vertices])],
          edges: [...edges.values()],
          quads: [...new Set([...rigid.change.quads, ...direct.quads])],
        });
      }
      if (store.regionSel.length && !store.controlSel.some(point => point.kind !== 'vertex'))
        view().setRegionMarks(selectedVertexIndices().map(vertex => getVertex(doc, vertex)));
      let propsRotated = false;
      const selectedProps = new Set(selectedEditPropIndices());
      for (const item of update.props) {
        if (!selectedProps.has(item.index)) continue;
        const prop = store.mdoc.props?.[item.index];
        if (!prop) continue;
        prop.pos = item.pos;
        writePropRotation(prop, item);
        propsRotated = true;
      }
      if (propsRotated) scheduleRebuild();
    },
    onRotateControlPoints(targets) {
      const movable = new Set(movableControlPoints(store.controlSel).map(controlPointKey));
      const updates = targets.filter(target => movable.has(controlPointKey(target.id)));
      if (!updates.length) return;
      setMeshControlPoints(mdoc(), updates);
      previewMeshChange(controlPointChange(updates.map(target => target.id)));
    },
    onScaleControlPoints(targets) {
      const movable = new Set(movableControlPoints(store.controlSel).map(controlPointKey));
      const updates = targets.filter(target => movable.has(controlPointKey(target.id)));
      if (!updates.length) return;
      setMeshControlPoints(mdoc(), updates);
      previewMeshChange(controlPointChange(updates.map(target => target.id)));
    },
    onRotateCorners(update) { applyRigidCornerUpdate(update); },
    onScaleCorners(update) { applyRigidCornerUpdate(update); },
    onSlideCorners(updates) {
      const doc = mdoc();
      const locked = lockedVertexSet(doc);
      const moved: number[] = [], marks: V3[] = [];
      for (const update of updates) {
        const vertex = vertexIndex(doc, update.vertex);
        if (vertex === null || locked.has(vertex)) continue;
        setVertex(doc, vertex, update.pos);
        moved.push(vertex);
        marks.push(update.pos);
      }
      previewMeshChange({ vertices: moved });
      if (store.regionSel.length) view().setRegionMarks(marks);
    },
    onSlideBegin() { slideBase = structuredClone(mdoc()); slideWeld = []; },
    onSlideRecut(plan) {
      if (!slideBase) return;
      const change = slidePlanPreviewChange(plan);
      const lockedVertices = lockedVertexSet(slideBase), lockedEdges = lockedEdgeSet(slideBase);
      const touchesLock = (change.vertices ?? []).some(vertex => lockedVertices.has(vertex))
        || (change.edges ?? []).some(([a, b]) => edgeIsLocked(slideBase!, a, b, lockedEdges))
        || (change.quads ?? []).some(quad => quadIsLocked(slideBase!, quad));
      if (touchesLock) { slideWeld = []; log('Locked patches cannot be moved by a surface slide.'); return; }
      slideWeld = plan.weld;
      let refusal: string | null = null;
      slideFrom(doc => { const result = applySlidePlan(doc, plan); if (!result.ok) refusal = result.error; }, change);
      if (refusal) log(refusal); else if (store.selectedCorner !== null) refreshHandles();
    },
    onSlideMergePending(pending) {
      if (!pending) { log(''); return; }
      log(activeEditFamily() === 'cell'
        ? 'slide is clamped at the cell ahead — release to dissolve it'
        : 'slide is clamped at its neighbour — release to merge them');
    },
    onSlideEnd(mergePending) { commitSlide(mergePending); },
    onEditTransformEnd() { scheduleRebuild(); },
    onCreateEdgePoint(endpoint) { topology.addCreateEdgePoint(endpoint); },
    onCreateTubeAxisChange() {
      if (store.surgeryTool !== 'tube') return;
      const count = view().createTubePoints.length;
      if (count !== tubePointCount) {
        tubePointCount = count;
        rebuildTools(); updateCmdSheet();
      } else topology.previewCreateTube();
    },
    onCreateTrailPointsChange() {
      if (store.surgeryTool !== 'trail') return;
      topology.previewCreateTrail();
      const count = view().createTrailPoints.length;
      if (count !== trailPointCount) {
        trailPointCount = count;
        rebuildTools(); updateCmdSheet();
      }
    },
    onLoopCut(quad, edge, t) {
      const { mesh, adj } = meshContext(mdoc());
      const result = applyLoopCut(mdoc(), planLoopCut(mesh, adj, quad, edge), t);
      if (!result.ok) { toast(result.error, 'err'); return; }
      commitEditMesh(store, result.doc);
      scheduleRebuild();
      if (store.currentMode === 'edit') rebuildTools();
    },
    onCreatePatch(corners) {
      const result = appendPatchFromCorners(
        mdoc(),
        corners.map(corner => corner.vertex ?? corner.pos) as unknown as PatchCorners,
      );
      if (!result.ok) { toast(result.error, 'err'); return false; }
      commitEditMesh(store, result.doc);
      const created = quadName(mdoc(), result.quad);
      if (created !== null) store.createPatchQuads.push(created);
      scheduleRebuild();
      rebuildTools(); updateCmdSheet();
      toast(`${corners.length === 3 ? 'triangle' : 'quad'} patch created — click the first corner of the next patch`, 'ok');
      return true;
    },
    onPasteVertices(translation) { clipboard.commitPastedVertices(translation); },
    onSelectEditCell(quad, mode) {
      if (store.bridgeRails === null && (mode === 'replace' || mode === 'toggle' || !crossFamilyModifier('cell')))
        selectEditCell(quad, mode);
    },
    onSelectCellLoop(quad, additive) {
      if (store.bridgeRails === null && (!additive || !crossFamilyModifier('cell'))) selectCellLoop(quad, additive);
    },
    onSelectEdge(edge, mode) {
      if (mode === 'replace' || mode === 'toggle' || !crossFamilyModifier('edge')) selectEditEdge(edge, mode);
    },
    onSelectEdgeLoop(edge, additive) { if (!additive || !crossFamilyModifier('edge')) selectEditEdge(edge, additive ? 'loopAdd' : 'loop'); },
    onExtrudeEdges(edges, delta) {
      const result = applyEdgeExtrusion(mdoc(), edges, delta);
      if (!result.ok) { toast(result.error, 'err'); return; }
      commitEditMesh(store, result.doc);
      store.edgeSel = namedEdges(mdoc(), result.outerEdges);
      store.anchorEdge = store.edgeSel[0] ?? null;
      resetGizmoMode(); scheduleRebuild();
      requestAnimationFrame(() => { view().refreshEditEdges(); seatEditMoveGizmo(); });
      rebuildTools(); updateCmdSheet();
    },
    onCommitExtrudeEdges(plan, placement) {
      const result = applyPlannedEdgeExtrusion(mdoc(), plan, placement);
      if (!result.ok) { toast(result.error, 'err'); return false; }
      commitEditMesh(store, result.doc);
      const doc = mdoc();
      if (plan.kind === 'patch') {
        store.edgeSel = []; store.anchorEdge = null;
        store.cellSel = quadNames(doc, result.topQuads ?? []);
        store.anchorCell = store.cellSel[0] ?? null; store.cellLoopSeed = null;
      } else {
        store.cellSel = []; store.anchorCell = null; store.cellLoopSeed = null;
        store.edgeSel = namedEdges(doc, result.outerEdges); store.anchorEdge = store.edgeSel[0] ?? null;
      }
      resetGizmoMode(); scheduleRebuild();
      requestAnimationFrame(() => { view().refreshEditEdges(); view().refreshEditCells(); seatEditMoveGizmo(); });
      rebuildTools(); updateCmdSheet();
      return true;
    },
    onExtrudeStageChange(_active) {
      rebuildTools(); updateCmdSheet();
    },
    onExtrudeEdgesInvalid(error) { toast(error, 'err'); },
    onRefSelectionChange() { refreshEditSelectionUi(); },
    onMoveCorner(index, pos) {
      if (lockedVertexSet(mdoc()).has(index)) return;
      setVertex(mdoc(), index, pos);
      previewMeshChange({ vertices: [index] });
      refreshHandles();
    },
    onMoveHandle(dir, pos) {
      const corner = store.selectedCorner === null ? null : vAt(store.selectedCorner);
      if (corner === null || !selectedDirNb) return;
      const neighbour = selectedDirNb[dir as HandleDir];
      if (neighbour === undefined || neighbour < 0) return;
      if (edgeIsLocked(mdoc(), corner, neighbour)) return;
      const base = getVertex(mdoc(), corner);
      meshSetHandle(mdoc(), corner, neighbour, [pos[0] - base[0], pos[1] - base[1], pos[2] - base[2]]);
      previewMeshChange({ edges: [[corner, neighbour]] });
    },
    onMoveCageHandle(from, to, pos) {
      if (edgeIsLocked(mdoc(), from, to)) return;
      const base = getVertex(mdoc(), from);
      meshSetHandle(mdoc(), from, to, [pos[0] - base[0], pos[1] - base[1], pos[2] - base[2]]);
      previewMeshChange({ edges: [[from, to]] });
    },
    onMoveTwist(quad, corner, pos) {
      if (quadIsLocked(mdoc(), quad)) return;
      const { mesh, edgeHandle } = meshFromDoc(mdoc());
      const base = quadControlPoints(mesh, edgeHandle, quad)[INTERIOR_CP[corner]];
      meshSetTwist(mdoc(), quad, corner, [pos[0] - base[0], pos[1] - base[1], pos[2] - base[2]]);
      previewMeshChange({ quads: [quad] });
    },
  };

  return {
    viewportCallbacks,
    activeEditFamily, mixedEditSelection, transformSelectionActive, rotatableSelection, setGizmoMode, resetGizmoMode,
    toggleEditProp,
    beginEdgeExtrusion, flipEdgeExtrusionSide, commitEdgeExtrusion, cancelEdgeExtrusion,
    clearCellSel, clearEdgeSel, exitRegion, deselectEdit, refreshHandles, narrowEditSelection,
    selectEdgeCrossing, weldSelectedEdgeCrossing, selectCoincidentVertices, weldSelectedCoincidentVertices,
    hideSelectedMesh, showAllHidden, canHideSelection, hiddenMeshCount,
    toggleSelectedControlCages, selectedControlCagesVisible, hideSubCages, controlCageCount, canEditCurvature,
    selectedPatchLockState, toggleSelectedPatchLocks,
    labelsAvailable, labelRows, selectedLabelTargets, selectedLabelState, setSelectedLabel,
    createLabel, renameLabel, deleteLabel, selectLabel,
    selectConnected, canSelectConnected, selectOverlappingVertices,
    ripEdges, insertCellEdge, resetCellShape, creaseVertices, smoothVertices,
    beginPointWeld, cancelPointWeld, commitPointWeld, commitPointWeldTogether, beginEdgeWeld, cancelEdgeWeld, commitEdgeWeld,
    ...topology,
    ...clipboard,
    deleteSelectedMesh, dissolveSelectedMesh, canDissolveSelectedMesh, meshDeleteTargetCount, canDeleteMeshSelection,
    flipSelectedMesh, canFlipSelectedMesh,
  };
}

export type EditSession = ReturnType<typeof createEditSession>;
