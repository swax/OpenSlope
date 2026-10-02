import type { EditDoc } from '../../core/doc/doc-edit';
import type { MeshControlPointId } from '../../core/mesh/control-points';
import type { Store } from './store';
import type { NamedEdge } from './mesh-names';

/** Keep selections attached to their identities across a same-map snapshot. Array slots are never identity:
 *  a deleted prop/rail must not select the object that moved into its slot. Unnamed course/rail points are
 *  retained only when their whole list is unchanged, since they cannot safely be matched after an edit. */
export function reconcileSyncContext(store: Store, before: EditDoc, mesh: EditDoc): void {
  const after = store.mdoc;
  const remap = (index: number | null, old: readonly { id?: string }[] = [], next: readonly { id?: string }[] = []) => {
    const id = index === null ? undefined : old[index]?.id;
    const at = id ? next.findIndex(item => item.id === id) : -1;
    return at < 0 ? null : at;
  };
  store.selectedProp = remap(store.selectedProp, before.props, after.props);
  store.multiSel = store.multiSel.flatMap(index => remap(index, before.props, after.props) ?? []);
  const oldRail = store.selectedRail === null ? undefined : before.rails?.[store.selectedRail];
  store.selectedRail = remap(store.selectedRail, before.rails, after.rails);
  const rail = store.selectedRail === null ? undefined : after.rails?.[store.selectedRail];
  if (!rail || JSON.stringify(oldRail?.nodes) !== JSON.stringify(rail.nodes)) store.selectedNode = null;
  if (!rail) store.railDrawing = false;
  const exists = (id: string | null, items: readonly { id?: string }[] = []) =>
    id !== null && items.some(item => item.id === id) ? id : null;
  store.selectedLight = exists(store.selectedLight, after.lights);
  store.selectedGem = exists(store.selectedGem, after.gems);
  store.selectedScreen = exists(store.selectedScreen, after.screens);
  store.selectedLine = exists(store.selectedLine, after.propLines);
  const oldLine = before.propLines?.find(line => line.id === store.selectedLine);
  const line = after.propLines?.find(item => item.id === store.selectedLine);
  if (!line || JSON.stringify(oldLine?.nodes) !== JSON.stringify(line.nodes)) store.selectedLineNode = null;
  if (!line) store.lineDrawing = false;
  if (JSON.stringify(before.course.knots) !== JSON.stringify(after.course.knots)) {
    store.selected = null;
    store.selectedKnots = [];
  }

  const vertices = new Set(mesh.vertexIds), quads = new Set(mesh.quadIds);
  const edges = new Set<string>();
  const edgeKey = ([a, b]: NamedEdge) => JSON.stringify(a < b ? [a, b] : [b, a]);
  const addEdge = (a: number, b: number) => {
    if (a !== b) edges.add(edgeKey([mesh.vertexIds[a], mesh.vertexIds[b]]));
  };
  for (const [a, b, c, d] of mesh.quads) {
    addEdge(a, b); addEdge(b, d); addEdge(d, c); addEdge(c, a);
  }
  for (const [a, b] of mesh.freeEdges ?? []) addEdge(a, b);
  const liveEdge = (edge: NamedEdge) => edges.has(edgeKey(edge));
  const livePoint = (point: MeshControlPointId) => point.kind === 'vertex' ? vertices.has(point.vertex)
    : point.kind === 'edge' ? liveEdge([point.from, point.to]) : quads.has(point.quad);
  const vertex = (id: string | null) => id !== null && vertices.has(id) ? id : null;
  const quad = (id: string | null) => id !== null && quads.has(id) ? id : null;
  store.selectedCorner = vertex(store.selectedCorner);
  store.anchorCorner = vertex(store.anchorCorner);
  store.regionSel = store.regionSel.filter(id => vertices.has(id));
  store.controlSel = store.controlSel.filter(livePoint);
  if (store.anchorControl && !livePoint(store.anchorControl)) store.anchorControl = null;
  store.cellSel = store.cellSel.filter(id => quads.has(id));
  store.anchorCell = quad(store.anchorCell);
  store.cellLoopSeed = quad(store.cellLoopSeed);
  store.edgeSel = store.edgeSel.filter(liveEdge);
  if (store.anchorEdge && !liveEdge(store.anchorEdge)) store.anchorEdge = null;
  store.hiddenVertices = store.hiddenVertices.filter(id => vertices.has(id));
  store.hiddenQuads = store.hiddenQuads.filter(id => quads.has(id));
  store.hiddenEdges = store.hiddenEdges.filter(liveEdge);
  store.controlCageQuads = store.controlCageQuads.filter(id => quads.has(id));
  store.controlCageEdges = store.controlCageEdges.filter(liveEdge);
  store.createPatchQuads = store.createPatchQuads.filter(id => quads.has(id));
  if (store.weldSource.some(id => !vertices.has(id)) || store.weldEdgeSource.some(edge => !liveEdge(edge))) {
    store.weldTool = null;
    store.weldSource = [];
    store.weldEdgeSource = [];
  }
  // These diagnostics describe positions/intersections, not merely surviving identities.
  store.selectedEdgeCrossing = null;
  store.selectedCoincidentVertices = null;
  // Paint always addresses the mountain, even when Edit is displaying a model substrate.
  const painted = new Set(after.quadIds);
  store.paintMultiSel = store.paintMultiSel.filter(id => painted.has(id));
  if (store.selectedPaintCell !== null && !painted.has(store.selectedPaintCell)) store.selectedPaintCell = null;
}
