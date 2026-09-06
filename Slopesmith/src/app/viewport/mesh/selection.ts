import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { V3 } from '../../../core/doc/types';
import { meshAdjacency, quadControlPoints, vertexValence, type EdgeHandle, type MeshAdjacency, type QuadMesh } from '../../../core/mesh/topology';
import {
  INDEX_NAMING, meshEdgeSegments, resolveVertexSelection, resolveEdgeSelection, resolveCellSelection,
  type VertexSelectMode, type EdgeSelectMode,
} from '../../../core/mesh/selection';
import { ekey } from '../../../core/mesh/ops';
import { measureEdges, measureCells, type SelectionMeasure } from '../../../core/mesh/measure';
import { copyMeshVertices, type MeshVertexClipboard } from '../../../core/mesh/clipboard';
import { controlPointCageOwners, controlPointKey, type MeshControlPoint, type MeshControlPointId } from '../../../core/mesh/control-points';
import { controlPointIsLocked, lockedEdgeSet, lockedVertexSet } from '../../../core/mesh/locks';
import { cubicPoint, patchPoint } from '../../../core/math/bezier';
import { resolveTerrainTexRef } from '../../../core/paint/textures';
import { orientFromPatchUV } from '../../../core/paint/orientation';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import type { PreviewData } from '../../../core/mesh/tessellation';
import type { QuadMeshDoc } from '../../../core/doc/types';
import { pointsInProjectedTriangles, type ProjectedTriangle } from '../../../core/mesh/projected-overlap';
import { PATCH_VERTS } from '../../../core/mesh/tessellation';
import {
  controlPointIndex, edgeIndices, quadIndices, vertexIndices, vertexName, type NamedEdge, type QuadName,
} from '../../state/mesh-names';
import type { EditMarqueeSelection, MeshSelectionState, ShadeMode } from '../types';
import {
  LOOP_RENDER_ORDER, EDIT_CELL_FILL_COLOR, EDIT_CELL_FILL_OPACITY, EDIT_EDGE_SEL_COLOR, EDIT_EDGE_SEL_WIDTH,
  CTRL_NET_COLOR, CTRL_CAGE_COLOR, CTRL_HANDLE_PX, CTRL_NET_LINE_WIDTH, CTRL_NET_PT_PX, CTRL_NET_SEG,
  CTRL_ANCHOR_COLOR, CTRL_SEL_COLOR, CTRL_CORNER_SEL_PX, HANDLE_NUB_PX, F_LINE_WIDTH,
} from '../constants';
import { clearGlyphGroup, glyphLines, addCageLines, addLoopDots, addRoundDots } from '../shared/overlays';
import type { Stage } from '../stage';
import type { CageLayer } from './cage';

/** A pickable cage handle of the singly-selected cell / edge, as its build spec (with the sphere position)
 *  and, once picked, its identity. Two kinds: an `edge` handle pins a directed-edge tangent (from→to,
 *  writes `edgeHandles`); a `twist` handle pulls an interior control point (quad + corner slot 0/1/2/3 =
 *  A/B/C/D, writes `quadTwist`). Both carry the `vertex` whose slope frames the Surface-mode gizmo (the
 *  edge's `from`, the twist's own corner). */
export type CageHandleId =
  | { kind: 'edge'; from: number; to: number; vertex: number }
  | { kind: 'twist'; quad: number; corner: number; vertex: number };
type CageHandleSpec = CageHandleId & { pos: V3 };

/** The live substrate the selection draws and picks against, on both sides of the authored ⇄ reference
 *  parity: the authored quad net + tessellated preview + cached directed-edge handle and its terrain mesh,
 *  the loaded reference solid + data + control-point list, and the view / tool state that gates the drawn
 *  overlays. The shell owns all of it and hands it in as closures, null where nothing is loaded. */
export interface SelectionAccess {
  net(): { positions: number[]; adj: MeshAdjacency } | null;
  /** The authored document the named selections resolve against (docs/039). */
  meshDoc(): QuadMeshDoc | null;
  preview(): PreviewData | null;
  meshHandle(): EdgeHandle | null;
  terrain(): THREE.Mesh;
  reference(): THREE.Mesh | null;
  refData(): ReferenceMesh | null;
  refLevel(): string;
  referenceControlPoints(): readonly MeshControlPoint<number>[];
  /** Edit is the mode hidden mesh components exist in; the hidden predicates read false elsewhere. */
  editMode(): boolean;
  /** Marquee occlusion follows the shade view: wireframe ('none') selects through, no occlusion pass. */
  shading(): ShadeMode;
  netSpacing(): number;
  /** Bridge Builder owns the edge selection while active, so the per-edge cage / handles stand down. */
  bridgeActive(): boolean;
  /** Clone a render geometry into an isolated BVH (the host's shared builder); marquee occlusion casts into it. */
  geometryBVH(geo: THREE.BufferGeometry): MeshBVH | null;
}

/** Host work a selection change triggers: dropping the whole-reference move handle + its gizmo (the
 *  Info-mode selection, host-owned), and re-framing the shared gizmo when a group handle it already rides
 *  changes membership (the transform layer owns the frame). */
export interface SelectionHostHooks {
  clearRefSelection(): void;
  applyGizmoFrame(): void;
}

/**
 * The Edit-mode mesh-selection machinery, serving the authored net and the read-only reference alike off the
 * shared substrate (`MeshSelectionState`): the yellow cell shading + edge highlights and their control-net
 * studies, the pickable cage-handle spheres with their persistent gizmo anchor, the corner marker / region
 * dots / centroid group handles the transform gestures ride, the hidden-component Set caches and their
 * predicates, the reference vertex / edge / patch selections with their measure + clipboard reads, and the
 * marquee resolution that projects both point clouds and occludes each against its own solid. The layer owns
 * these scene objects and the selection caches; the shell hands in the live mesh substrate through accessors
 * (`SelectionAccess`), keeps the pointer routing + gizmo seating that call in, and reads the anchors,
 * predicates and counts back through the typed API.
 */
export function createSelectionLayer(
  stage: Stage, sel: MeshSelectionState, cage: CageLayer,
  access: SelectionAccess, host: SelectionHostHooks,
) {
  let cornerGroupIdx: number[] = []; // the current region's corner indices (for its averaged surface frame)
  let controlPointSel: MeshControlPointId[] = [];   // named, like every authored family on the substrate
  let controlPointSelPositions: V3[] = [];
  let movableControlPointKeys = new Set<string>();
  const refEdgeGroup = new THREE.Group();      // read-only reference edge selection highlight (refRoot coords)
  let refAdj: MeshAdjacency | null = null;   // cached adjacency of the reference QuadMesh (rebuilt on reference load)
  // the authored cell / edge selections live on the shared substrate (sel.cellSel / sel.edgeSel); these are
  // the previously-drawn copies the cage-handle lifecycle diffs against (re-picking the SAME single cell /
  // edge keeps its picked handle — see refreshEditCells).
  let lastCellSel: QuadName[] = [];
  let lastEdgeSel: NamedEdge[] = [];
  // Set-form caches of sel.hidden* resolved onto the live mesh (rebuilt by refreshHiddenSets) for the hot
  // hidden-component predicates, which all run on indices.
  let hiddenVertices = new Set<number>();
  let hiddenEdges = new Set<string>();
  let hiddenQuads = new Set<number>();
  let refHiddenQuads = new Set<number>();
  const editEdgeGroup = new THREE.Group();     // the selected edges' highlight, data coords like the cage / cell shading
  // A selected cell shades yellow (every selected cell the same strength) — a transparent surface tint (like
  // paintGhost) so the cell's EDGES stay free for a separate edge selection. One shared material drives both the
  // authored net's fill mesh (under worldRoot) and the reference quilt's (under refRoot); neither is a pick target.
  const cellFillMat = new THREE.MeshBasicMaterial({ color: EDIT_CELL_FILL_COLOR, transparent: true,
    opacity: EDIT_CELL_FILL_OPACITY, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const editCellGroup = new THREE.Group();                   // authored net's shading mesh (worldRoot coords)
  const editCellFill = new THREE.Mesh(new THREE.BufferGeometry(), cellFillMat);
  const editCellNetGroup = new THREE.Group();                // a singly-selected authored cell's 16-point control net (worldRoot coords)
  // Directly selecting a floating sub-cage point emphasizes the smallest cage that owns it over the global
  // lattice: the cubic polygon for a boundary tangent, or the full 4x4 net for an interior twist. Kept separate
  // from edge/cell selection because this point family has its own multi-select and centroid gizmo.
  const controlPointCageGroup = new THREE.Group();            // selected authored points' owner cages (worldRoot coords)
  // A singly-selected authored cell / edge exposes its editable TANGENT handles (the on-edge control points)
  // as pickable spheres: click one to seat the translate gizmo on it (Surface⇄World pill respected) and pull
  // that directed-edge handle (onMoveCageHandle → meshSetHandle). Each sphere carries its directed edge
  // (from→to); the picked one draws yellow. The gizmo rides a PERSISTENT anchor, not the sphere — the terrain
  // rebuild recreates the spheres each drag frame, so attaching to one would drop the gizmo mid-drag. Scene
  // root with Z negated by hand (like the tangent nubs), so the gizmo never sees worldRoot's mirror.
  const cageHandleGroup = new THREE.Group();                 // the current cell / edge's pickable handle spheres
  let cageHandleMeshes: THREE.Mesh[] = [];                   // their meshes (tagged userData.from / userData.to)
  let selectedCageHandle: CageHandleId | null = null;        // which cage handle (edge tangent or interior twist) is picked
  const ctrlDotGeo = new THREE.SphereGeometry(1, 12, 8);     // shared unit sphere: corner marker + cage handles
  const refCellGroup = new THREE.Group();                    // reference quilt's shading mesh (refRoot coords)
  const refCellFill = new THREE.Mesh(new THREE.BufferGeometry(), cellFillMat);
  const refCellNetGroup = new THREE.Group();                 // the selected patch's 16-point bicubic control net (refRoot coords)
  const refControlPointCageGroup = new THREE.Group();         // selected reference points' owner cages (refRoot coords)

  stage.refRoot.add(refEdgeGroup);    // reference edge selection highlight rides the reference frame too

  // Edit-mode cell selection: yellow face shading. renderOrder 9 keeps it above the terrain, below the cage
  // wires. The authored net's fill rides worldRoot; the reference quilt's rides refRoot (its placement offset).
  for (const m of [editCellFill, refCellFill]) {
    m.renderOrder = 9;
    m.visible = false;
    m.raycast = () => { /* a pure highlight, never a pick target */ };
  }
  editCellGroup.add(editCellFill);
  refCellGroup.add(refCellFill);
  stage.worldRoot.add(editCellGroup); // authored cell-selection shading, terrain data coords
  stage.worldRoot.add(editCellNetGroup); // a selected authored cell's 16-point control net, data coords
  stage.worldRoot.add(editEdgeGroup); // selected-edge highlight (data coords), drawn over the cage wires
  stage.worldRoot.add(controlPointCageGroup);
  stage.refRoot.add(refCellGroup);    // reference cell-selection shading, reference frame
  stage.refRoot.add(refCellNetGroup); // the selected patch's 16-point control net
  stage.refRoot.add(refControlPointCageGroup);

  // selected control-net corner: a small YELLOW dot the translate gizmo also anchors to (screen-constant,
  // always-on-top), so a picked corner reads at a glance like a picked cage handle. The gizmo + tangent
  // nubs seat here too. Scene root (Z negated by hand) so the gizmo has no mirrored parent.
  const cornerMarker: THREE.Object3D = new THREE.Mesh(
    ctrlDotGeo,
    new THREE.MeshBasicMaterial({ color: CTRL_SEL_COLOR, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  cornerMarker.renderOrder = 13;
  cornerMarker.visible = false;
  stage.scene.add(cornerMarker);

  // cage handles (a selected cell / edge's editable tangent handles) + their persistent gizmo anchor —
  // scene root with Z negated by hand, like the tangent nubs. The spheres are (re)built per selection /
  // rebuild in buildCageHandles; the anchor carries the gizmo so a rebuild never drops the drag.
  cageHandleGroup.renderOrder = 13;
  stage.scene.add(cageHandleGroup);
  const cageHandleAnchor = new THREE.Object3D();             // the picked handle's persistent gizmo anchor
  cageHandleAnchor.visible = false;
  stage.scene.add(cageHandleAnchor);

  // corner-group move handle: the same scene-root anchor pattern for a multi-corner selection (shift-range
  // or box-select). Parked at the set's centroid; gizmo drags report data-space deltas (onMoveCorners),
  // while the orange region dots mark the members.
  const cornerGroupHandle = new THREE.Object3D();            // scene-root gizmo anchor for a multi-corner selection
  cornerGroupHandle.visible = false;
  stage.scene.add(cornerGroupHandle);
  const cornerGroupHandleLast = new THREE.Vector3();         // its data-space pos at the last gizmo report (delta baseline)

  // box-selected corners: an orange points cloud (bulk crease/smooth target)
  const regionMarks = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0xffa23a, size: 7, sizeAttenuation: false, depthTest: false }),
  );
  regionMarks.renderOrder = 11;
  stage.worldRoot.add(regionMarks);
  // The reference uses the exact same point-marker geometry/update path, parented under its translated root.
  // It is read-only (no centre gizmo), but otherwise a box-selected vertex set reads identically.
  const refRegionMarks = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0xffa23a, size: 7, sizeAttenuation: false, depthTest: false }),
  );
  refRegionMarks.renderOrder = 11;
  refRegionMarks.visible = false;
  stage.refRoot.add(refRegionMarks);

  /** Rebuild the Set-form hidden-component caches from the substrate (sel.hidden*). False = the same sets
   *  again, so the host can skip the dependent index / cage / overlay rebuilds. */
  function refreshHiddenSets(): boolean {
    const doc = access.meshDoc();
    const nextVertices = new Set(doc ? vertexIndices(doc, sel.hiddenVertices) : []);
    const nextEdges = new Set(doc ? edgeIndices(doc, sel.hiddenEdges).map(([a, b]) => ekey(a, b)) : []);
    const nextQuads = new Set(doc ? quadIndices(doc, sel.hiddenQuads) : []);
    const same = (a: ReadonlySet<unknown>, b: ReadonlySet<unknown>) => a.size === b.size && [...a].every(value => b.has(value));
    if (same(hiddenVertices, nextVertices) && same(hiddenEdges, nextEdges) && same(hiddenQuads, nextQuads)) return false;
    hiddenVertices = nextVertices;
    hiddenEdges = nextEdges;
    hiddenQuads = nextQuads;
    return true;
  }

  /** Refresh the immutable reference mesh's index-addressed hidden-patch set. It is separate from the authored
   *  name→index cache above because a reference never renumbers; the next reference load simply clears it. */
  function refreshReferenceHiddenSets(): boolean {
    const next = new Set(sel.refHiddenQuads);
    const same = refHiddenQuads.size === next.size && [...refHiddenQuads].every(quad => next.has(quad));
    if (same) return false;
    refHiddenQuads = next;
    return true;
  }

  function vertexHidden(vertex: number) {
    if (!access.editMode()) return false;
    if (hiddenVertices.has(vertex)) return true;
    const net = access.net();
    const edges = (net?.adj.neighbors[vertex] ?? []).map(to => net!.adj.edgeQuads.get(ekey(vertex, to)) ?? []);
    return edges.length > 0 && edges.every(quads => quads.length > 0 && quads.every(quad => quadHidden(quad)));
  }
  function edgeHidden(a: number, b: number) {
    if (!access.editMode()) return false;
    if (hiddenVertices.has(a) || hiddenVertices.has(b) || hiddenEdges.has(ekey(a, b))) return true;
    const quads = access.net()?.adj.edgeQuads.get(ekey(a, b)) ?? [];
    return quads.length > 0 && quads.every(quad => quadHidden(quad));
  }
  function quadHidden(quad: number) {
    if (!access.editMode()) return false;
    if (hiddenQuads.has(quad)) return true;
    const q = access.preview()?.mesh.quads[quad];
    if (!q) return false;
    if (q.some(vertex => hiddenVertices.has(vertex))) return true;
    const [A, B, C, D] = q;
    return ([[A, B], [B, D], [D, C], [C, A]] as [number, number][])
      .some(([a, b]) => a !== b && hiddenEdges.has(ekey(a, b)));
  }
  function controlPointHidden(id: MeshControlPointId) {
    const doc = access.meshDoc();
    const at = doc ? controlPointIndex(doc, id) : null;
    if (!at) return false;
    return at.kind === 'vertex' ? vertexHidden(at.vertex)
      : at.kind === 'edge' ? edgeHidden(at.from, at.to)
      : quadHidden(at.quad);
  }

  function refQuadHidden(quad: number) {
    return access.editMode() && refHiddenQuads.has(quad);
  }
  function refVertexHidden(vertex: number) {
    if (!access.editMode()) return false;
    const adj = refAdjacency();
    const incident = adj?.neighbors[vertex]?.flatMap(to => adj.edgeQuads.get(ekey(vertex, to)) ?? []) ?? [];
    return incident.length > 0 && incident.every(quad => refHiddenQuads.has(quad));
  }
  function refEdgeHidden(a: number, b: number) {
    if (!access.editMode()) return false;
    const quads = refAdjacency()?.edgeQuads.get(ekey(a, b)) ?? [];
    return quads.length > 0 && quads.every(quad => refHiddenQuads.has(quad));
  }
  function refControlPointHidden(id: MeshControlPointId<number>) {
    return id.kind === 'vertex' ? refVertexHidden(id.vertex)
      : id.kind === 'edge' ? refEdgeHidden(id.from, id.to)
      : refQuadHidden(id.quad);
  }

  /** The authored cell / edge selections resolved onto the live mesh — the derive boundary the drawing below
   *  works behind (docs/039). */
  function cellSelIndices(): number[] {
    const doc = access.meshDoc();
    return doc ? quadIndices(doc, sel.cellSel) : [];
  }
  function edgeSelIndices(): [number, number][] {
    const doc = access.meshDoc();
    return doc ? edgeIndices(doc, sel.edgeSel) : [];
  }

  function refreshEditCells() {
    // a new / cleared / multi selection drops any picked cage handle (its gizmo + yellow); re-picking the SAME
    // single cell keeps it, so a rebuild after a handle drag doesn't yank the handle out from under the drag.
    const cells = sel.cellSel;
    const sameSingle = cells.length === 1 && lastCellSel.length === 1 && lastCellSel[0] === cells[0];
    if (!sameSingle) clearCageHandle();
    lastCellSel = [...cells];
    rebuildEditCellSel();
  }

  /** Rebuild the authored Edit cell shading (fill every selected cell); re-run on terrain rebuilds so the
   *  shading follows the surface a group move / slide reshapes. */
  function rebuildEditCellSel() {
    const pv = access.preview();
    clearGlyphGroup(editCellNetGroup);
    const cells = cellSelIndices();
    if (!pv || !cells.length) { editCellFill.visible = false; return; }
    setCellFill(editCellFill, pv.positions, pv.facesPerCell, cells);
    // A pinned selected patch emphasizes its real 4x4 cage. A single pinned patch also promotes its twelve
    // floating points to larger drag spheres; an unpinned selection keeps only its face shading.
    const eh = access.meshHandle();
    if (eh) {
      for (const quad of cells.filter(quad => cage.authoredQuadCageVisible(quad))) {
        const cps = quadControlPoints(pv.mesh, eh, quad, pv.twistOf(quad)) as number[][];
        const group = new THREE.Group();
        editCellNetGroup.add(group);
        buildCellNet(group, cps, true); // global lattice supplies context; this group contributes bright lines
      }
    }
    if (cells.length === 1 && cage.authoredQuadCageVisible(cells[0]) && eh) {
      const quad = cells[0], cps = quadControlPoints(pv.mesh, eh, quad, pv.twistOf(quad)) as number[][];
      const [A, B, C, D] = pv.mesh.quads[quad];
      // every non-corner control point is editable: the eight on-edge tangent handles (cp index → its directed
      // edge, writes edgeHandles) and the four INTERIOR twist points (cp 5/6/9/10 → corner slot A/B/C/D at the
      // twisted position pv.twistOf baked in, writes quadTwist). Both come from quadControlPoints' layout.
      const edgeSpec: [number, number, number][] = [[1, A, B], [2, B, A], [4, A, C], [7, B, D], [8, C, A], [11, D, B], [13, C, D], [14, D, C]];
      const twistSpec: [number, number, number][] = [[5, A, 0], [6, B, 1], [9, C, 2], [10, D, 3]]; // [cp, cornerVertex, slot]
      buildCageHandles([
        ...edgeSpec.map(([k, from, to]): CageHandleSpec => ({ kind: 'edge', from, to, vertex: from, pos: cps[k] as V3 })),
        ...twistSpec.map(([k, vertex, corner]): CageHandleSpec => ({ kind: 'twist', quad, corner, vertex, pos: cps[k] as V3 })),
      ]);
    }
  }

  function refreshEditEdges() {
    const edges = sel.edgeSel;
    const sameSingle = edges.length === 1 && lastEdgeSel.length === 1
      && lastEdgeSel[0][0] === edges[0][0] && lastEdgeSel[0][1] === edges[0][1];
    if (!sameSingle) clearCageHandle(); // same lifecycle as refreshEditCells (see there)
    lastEdgeSel = edges.map(edge => [...edge] as NamedEdge);
    rebuildEditEdgeSel();
  }

  /** Rebuild the selected-edge highlight: each edge re-drawn as a yellow fat line on its true cubic curve (the
   *  same cubic the cage wires use), always-on-top so it stays visible over the surface. A SINGLE selected edge
   *  also overlays its control CAGE (the cubic's four control points) — the edge twin of the cell's control-net
   *  study. Re-run on terrain rebuilds so it follows a corner drag / slide, like the cell shading. */
  function rebuildEditEdgeSel() {
    clearGlyphGroup(editEdgeGroup);
    const eh = access.meshHandle(), pv = access.preview();
    const edges = edgeSelIndices();
    if (!edges.length || !pv || !eh) return;
    const segs = meshEdgeSegments(pv.mesh, eh, edges);
    addGlyphLines(editEdgeGroup, segs, EDIT_EDGE_SEL_COLOR, 1, EDIT_EDGE_SEL_WIDTH, LOOP_RENDER_ORDER + 1, false);
    // Pinned selected edges emphasize their exact cubic control polygons. A lone pinned edge also promotes its
    // two tangents to the larger direct-drag spheres.
    if (!access.bridgeActive()) for (const edge of edges) {
      if (cage.authoredEdgeCageVisible(edge[0], edge[1])) buildEdgeCage(editEdgeGroup, edge, pv.mesh, eh, true);
    }
    if (!access.bridgeActive() && edges.length === 1
      && cage.authoredEdgeCageVisible(edges[0][0], edges[0][1])) {
      const edge = edges[0], mesh = pv.mesh;
      const V = (id: number): V3 => [mesh.vertices[id * 3], mesh.vertices[id * 3 + 1], mesh.vertices[id * 3 + 2]];
      const Va = V(edge[0]), Vb = V(edge[1]), h0 = eh(edge[0], edge[1]), h1 = eh(edge[1], edge[0]);
      buildCageHandles([
        { kind: 'edge', from: edge[0], to: edge[1], vertex: edge[0], pos: [Va[0] + h0[0], Va[1] + h0[1], Va[2] + h0[2]] },
        { kind: 'edge', from: edge[1], to: edge[0], vertex: edge[1], pos: [Vb[0] + h1[0], Vb[1] + h1[1], Vb[2] + h1[2]] },
      ]);
    }
  }

  /** Overlay the control CAGE of a single selected edge — the edge twin of buildCellNet. An edge is a cubic
   *  Bézier: its two endpoints P0 / P3 sit ON the curve (the mesh vertices), its two tangent handles P1 / P2
   *  float off it (P0 + the edge handle, P3 + the handle back — the same points meshEdgeSegments curves
   *  through). Draws the control polygon P0→P1→P2→P3 as the pink cage (ghosted: dim where it passes behind the
   *  surface), the two handles as pink circles (the prospective pull targets), the two endpoints as small dots. */
  function buildEdgeCage(group: THREE.Group, edge: [number, number], mesh: QuadMesh, eh: EdgeHandle, handlesExternal = false) {
    const V = (id: number): V3 => [mesh.vertices[id * 3], mesh.vertices[id * 3 + 1], mesh.vertices[id * 3 + 2]];
    const P0 = V(edge[0]), P3 = V(edge[1]);
    const h0 = eh(edge[0], edge[1]), h1 = eh(edge[1], edge[0]);
    const P1: V3 = [P0[0] + h0[0], P0[1] + h0[1], P0[2] + h0[2]];
    const P2: V3 = [P3[0] + h1[0], P3[1] + h1[1], P3[2] + h1[2]];
    addCageLines(group, [...P0, ...P1, ...P1, ...P2, ...P2, ...P3], CTRL_CAGE_COLOR, 0.9, true, LOOP_RENDER_ORDER); // control polygon, ghosted
    // the two tangent handles: circles here, UNLESS the caller draws them as its own pickable spheres (authored edit).
    if (!handlesExternal) addRoundDots(group, [...P1, ...P2], CTRL_CAGE_COLOR, CTRL_HANDLE_PX);
    if (!handlesExternal) addLoopDots(group, [...P0, ...P3], CTRL_CAGE_COLOR, CTRL_NET_PT_PX); // global authored cloud already draws them
  }

  /** (Re)build the pickable tangent-handle spheres for the singly-selected authored cell / edge: one sphere
   *  per editable directed-edge handle (from→to), pink — or YELLOW for the picked one. They're the gizmo pick
   *  targets; the gizmo itself rides the persistent cageHandleAnchor (a terrain rebuild recreates these each
   *  drag frame, so attaching to a sphere would drop the drag), which is kept synced to the picked handle here
   *  except mid-drag (the gizmo owns the anchor then). Scene root, Z negated like the tangent nubs. */
  function buildCageHandles(handles: CageHandleSpec[]) {
    clearCageHandleMeshes();
    for (const h of handles) {
      const { pos, ...id } = h; // userData carries the handle's identity (kind + ids), not its position
      const sel = cageHandleMatches(selectedCageHandle, id);
      const m = new THREE.Mesh(ctrlDotGeo, new THREE.MeshBasicMaterial({ color: sel ? CTRL_SEL_COLOR : CTRL_CAGE_COLOR, depthTest: false, transparent: true, opacity: 0.95 }));
      m.position.set(pos[0], pos[1], -pos[2]); // scene root: negate Z onto the flipped terrain
      m.renderOrder = 13;
      m.userData = id;
      cageHandleGroup.add(m);
      cageHandleMeshes.push(m);
    }
    if (selectedCageHandle && !stage.gizmo.dragging) { // the picked handle rides the reshaped surface (not mid-drag)
      const sel = cageHandleMeshes.find(m => cageHandleMatches(selectedCageHandle, m.userData as CageHandleId));
      if (sel) cageHandleAnchor.position.copy(sel.position);
    }
    scaleEditMarkers();
  }

  /** Do two cage-handle identities name the same handle? (same kind + same edge / interior slot.) */
  function cageHandleMatches(a: CageHandleId | null, b: CageHandleId): boolean {
    if (!a) return false;
    if (a.kind === 'edge' && b.kind === 'edge') return a.from === b.from && a.to === b.to;
    if (a.kind === 'twist' && b.kind === 'twist') return a.quad === b.quad && a.corner === b.corner;
    return false;
  }

  /** Dispose + drop the current cage-handle spheres (leaves the picked-handle state alone). */
  function clearCageHandleMeshes() {
    for (const m of cageHandleMeshes) { (m.material as THREE.Material).dispose(); cageHandleGroup.remove(m); }
    cageHandleMeshes = [];
  }

  /** Drop the cage-handle selection entirely (a new / cleared / multi cell-edge selection, or a mode / cage
   *  change): un-pick the handle, then clear the spheres. */
  function clearCageHandle() {
    releaseCageHandle();
    clearCageHandleMeshes();
  }

  /** Un-pick the cage handle but LEAVE its spheres up: the SAME single cell / edge is still selected, so its
   *  control points stay on show — they've just stopped being the gizmo's drag target (re-clicking the cell /
   *  edge hands the gizmo back to its group handle). Releases the gizmo if it rode the handle, hides the
   *  anchor, and repaints the spheres pink. */
  function releaseCageHandle() {
    selectedCageHandle = null;
    cageHandleAnchor.visible = false;
    if (stage.gizmoKind === 'cagehandle') stage.detachGizmo();
    for (const m of cageHandleMeshes) (m.material as THREE.MeshBasicMaterial).color.setHex(CTRL_CAGE_COLOR);
  }

  /** Pick a cage handle (an edge tangent or an interior twist point): seat the translate gizmo on the
   *  persistent anchor at the handle (Surface⇄World pill applied by applyGizmoFrame, which reads
   *  selectedCageHandle), colour it yellow. */
  function selectCageHandle(id: CageHandleId) {
    selectedCageHandle = id;
    const mesh = cageHandleMeshes.find(m => cageHandleMatches(id, m.userData as CageHandleId));
    if (mesh) cageHandleAnchor.position.copy(mesh.position);
    cageHandleAnchor.visible = true;
    stage.cb.onSelectKnot(null);
    stage.attachGizmo(cageHandleAnchor, 'cagehandle', 0); // afterGizmoAttach → applyGizmoFrame frames it
    for (const m of cageHandleMeshes) (m.material as THREE.MeshBasicMaterial).color.setHex(m === mesh ? CTRL_SEL_COLOR : CTRL_CAGE_COLOR);
  }

  /** (Re)build a cell-shading mesh from a set of cell/patch indices into a tessellated buffer (the authored
   *  preview OR the reference quilt — same per-cell layout): each cell's own side² surface verts + winding,
   *  so the shade hugs the real bicubic surface. Hidden when the set is empty. */
  function setCellFill(mesh: THREE.Mesh, positions: Float32Array, facesPerCell: number, cells: Iterable<number>) {
    const res = Math.round(Math.sqrt(facesPerCell / 2)), side = res + 1, verts = side * side;
    const nCells = positions.length / 3 / verts;
    const pos: number[] = [], idx: number[] = [];
    for (const ci of cells) {
      if (ci < 0 || ci >= nCells) continue;
      const base = ci * verts, vBase = pos.length / 3;
      for (let k = 0; k < verts; k++) { const p = (base + k) * 3; pos.push(positions[p], positions[p + 1], positions[p + 2]); }
      for (let iu = 0; iu < res; iu++) for (let iv = 0; iv < res; iv++) {
        const a = vBase + iu * side + iv, b = a + 1, c = a + side, d = c + 1;
        idx.push(a, d, c, a, b, d);
      }
    }
    if (!pos.length) { mesh.visible = false; return; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    g.setIndex(idx);
    mesh.geometry.dispose();
    mesh.geometry = g;
    mesh.visible = true;
  }

  /** Apply a click to the read-only reference CELL (patch) selection through the SAME shared semantics the
   *  authored net uses (resolveCellSelection), on the reference's own topology — plain / ctrl-toggle / shift-block,
   *  the cell twin of refEdgeSelect. Read-only: it shades + studies, nothing moves. */
  function refCellSelect(patch: number, mode: 'replace' | 'toggle' | 'range') {
    const d = access.refData();
    if (!d) return;
    const res = resolveCellSelection(sel.refCellSel, sel.refCellAnchor, patch, mode, INDEX_NAMING, d.topology);
    sel.refCellLoopSeed = null; // a single click breaks the double-click direction-toggle streak
    const cells = res.cells.filter(cell => !refQuadHidden(cell));
    if (!cells.length) { clearRefCells(); return; }
    sel.refCellSel = cells;
    sel.refCellAnchor = res.anchor !== null && !refQuadHidden(res.anchor) ? res.anchor : null;
    drawRefCells();
  }

  /** Double-click a reference patch → its face-loop strip, direction-alternating on a repeat of the same patch —
   *  the read-only twin of the authored selectCellLoop. */
  function refCellLoop(patch: number, additive: boolean) {
    const d = access.refData();
    if (!d) return;
    const dir: 0 | 1 = patch === sel.refCellLoopSeed ? (sel.refCellLoopDir === 0 ? 1 : 0) : 0;
    const res = resolveCellSelection(
      sel.refCellSel, sel.refCellAnchor, patch, additive ? 'loopAdd' : 'loop', INDEX_NAMING, d.topology, dir);
    sel.refCellLoopSeed = patch;
    sel.refCellLoopDir = dir;
    sel.refCellSel = res.cells.filter(cell => !refQuadHidden(cell));
    sel.refCellAnchor = res.anchor !== null && !refQuadHidden(res.anchor) ? res.anchor : null;
    drawRefCells();
  }

  /** Redraw reference cell shading and emphasize every selected patch's real cage lines. */
  function drawRefCells(notify = true) {
    const d = access.refData();
    clearGlyphGroup(refCellNetGroup);
    if (d && sel.refCellSel.length) {
      setCellFill(refCellFill, d.positions, d.facesPerPatch, sel.refCellSel);
    } else {
      refCellFill.visible = false;
    }
    if (notify) stage.cb.onRefSelectionChange?.(); // the panel re-reads refMeasure for the metric read-out (fires even when empty)
  }

  /** A control-point STUDY of a selected cell (authored or reference): its own SURFACE as an iso-parameter grid
   *  (soft blue) alongside the CONTROL cage in pink — the 4×4 lattice joining the sixteen control points, its
   *  twelve floating handles drawn as circles (prospective pull targets), its four on-surface corners as small
   *  dots — so the difference reads at a glance. The grid is the bicubic sampled at the two
   *  INTERNAL iso-parameters u,v = 1/3, 2/3 — curves the surface actually passes through, so they lie ON the
   *  terrain; the boundary iso-curves (0 / 1) are skipped as they run along the cell's edges (already drawn).
   *  Of the sixteen control points only the four corners land on the surface (its corners); the twelve handles
   *  float off it, pulling the surface toward them without the surface ever reaching them.
   *  A warm PULL line joins each handle to the surface spot it tugs hardest — control point cp[r*4+c]'s
   *  Bernstein weight peaks at u,v = r/3, c/3, so its partner is patchPoint(cp, r/3, c/3), an iso-grid
   *  node. The four corners sit ON that node (zero-length, skipped); the twelve handles fan out, the line's
   *  length and direction reading how far / which way that point yanks the surface at its home parameter.
   *  The iso-grid and dots draw always-on-top (depthTest off); the pull lines AND the control-point mesh
   *  instead depth-test against the surface (two passes: bright where in front, CAGE_OCCLUDED_DIM behind), so a
   *  cage line that plunges behind the cell reads as behind rather than punching through. */
  function buildCellNet(group: THREE.Group, cps: number[][], handlesExternal = false) {
    clearGlyphGroup(group);
    if (!cps || cps.length < 16) return;
    const cp = cps as V3[];
    // the patch surface as an iso-grid: each iso-curve tessellated into straight sub-segments along the bicubic
    const seg: number[] = [];
    const iso = (fn: (t: number) => V3) => {
      let a = fn(0);
      for (let i = 1; i <= CTRL_NET_SEG; i++) { const b = fn(i / CTRL_NET_SEG); seg.push(a[0], a[1], a[2], b[0], b[1], b[2]); a = b; }
    };
    const G = [0, 1 / 3, 2 / 3, 1]; // Bernstein max-weight nodes (all sixteen), for the pull lines below
    // iso-grid: the two INTERNAL iso-curves per axis (u,v = 1/3, 2/3). The boundary curves (0 / 1) run along the
    // cell's own edges — where the cage wires + cell shade already draw — so skip them to avoid doubling up.
    for (const u of [1 / 3, 2 / 3]) iso(v => patchPoint(cp, u, v)); // internal iso-u curves (run along +v)
    for (const v of [1 / 3, 2 / 3]) iso(u => patchPoint(cp, u, v)); // internal iso-v curves (run along +u)
    addGlyphLines(group, seg, CTRL_NET_COLOR, 0.9, CTRL_NET_LINE_WIDTH, LOOP_RENDER_ORDER, false); // depthTest off = over the shade
    // pull lines: each control point -> the on-surface node it tugs hardest, patchPoint(cp, r/3, c/3). Skip the
    // four corners (r,c both in {0,3}) — they sit on that node, so their line is zero-length. Drawn ghosted
    // (bright in front, dim behind the surface) so a handle whose line passes behind a ridge reads as behind.
    const pull: number[] = [];
    for (let k = 0; k < 16; k++) {
      const r = k >> 2, c = k & 3;
      if ((r === 0 || r === 3) && (c === 0 || c === 3)) continue; // corner: on-surface, nothing to draw
      const a = patchPoint(cp, G[r], G[c]);
      pull.push(cp[k][0], cp[k][1], cp[k][2], a[0], a[1], a[2]);
    }
    addCageLines(group, pull, CTRL_ANCHOR_COLOR, 0.8, true, LOOP_RENDER_ORDER); // ghost=true: always draw the dim behind-surface pass
    // the control-point MESH: the 4×4 lattice joining adjacent control points (the cage that shapes the cell) —
    // PINK lines (matching the tangent-handle nubs a selected corner shows), ghosted like the pull-lines (bright
    // in front, dim where a segment passes BEHIND the target surface) so the cage reads its depth against the cell.
    const lattice: number[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { const a = cp[r * 4 + c], b = cp[r * 4 + c + 1]; lattice.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) { const a = cp[r * 4 + c], b = cp[(r + 1) * 4 + c]; lattice.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
    addCageLines(group, lattice, CTRL_CAGE_COLOR, 0.9, true, LOOP_RENDER_ORDER); // ghost=true: dim behind-surface pass
    // the control points: the four on-surface CORNERS as small dots; the floating HANDLES as circles. When the
    // caller draws the editable handles as its own pickable spheres (handlesExternal, authored edit), EVERY
    // non-corner CP — the eight on-edge tangents AND the four interior twist points — is a sphere, so none draw
    // as circles here. A read-only reference patch (handlesExternal off) keeps all twelve as circles.
    const isCorner = (k: number) => { const r = k >> 2, c = k & 3; return (r === 0 || r === 3) && (c === 0 || c === 3); };
    const handlePts: number[] = [], cornerPts: number[] = [];
    for (let k = 0; k < 16; k++) {
      if (handlesExternal) continue; // authored global cloud draws all sixteen; this selection group adds lines only
      if (isCorner(k)) { cornerPts.push(cp[k][0], cp[k][1], cp[k][2]); continue; }
      handlePts.push(cp[k][0], cp[k][1], cp[k][2]);
    }
    addRoundDots(group, handlePts, CTRL_CAGE_COLOR, CTRL_HANDLE_PX); // floating handles (+ interior twist): circles
    addLoopDots(group, cornerPts, CTRL_CAGE_COLOR, CTRL_NET_PT_PX);  // corners: small on-surface markers
  }

  /** Drop the reference cell shading + its anchor / loop toggle (deselect / mode change / reference reload). */
  function clearRefCells() {
    if (!sel.refCellSel.length && sel.refCellAnchor === null) return;
    sel.refCellSel = [];
    sel.refCellAnchor = null;
    sel.refCellLoopSeed = null;
    refCellFill.visible = false;
    clearGlyphGroup(refCellNetGroup);
    stage.cb.onRefSelectionChange?.();
  }

  function setRegionMarks(positions: V3[]) {
    setVertexMarks(regionMarks, positions);
  }

  /** One marker builder for the authored and reference vertex selections. */
  function setVertexMarks(target: THREE.Points, positions: readonly V3[]) {
    target.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions.flat()), 3));
    target.geometry = g;
    target.visible = positions.length > 0;
  }

  /**
   * Flat ids of every point whose projection lies in the marquee and is not hidden by its own solid surface.
   * Both mountains call this SAME base with only their point buffer, placement offset and surface geometry
   * changed. In cage-only view there is intentionally no occlusion pass, preserving through-select.
   */
  function verticesInMarquee(marquee: { x0: number; y0: number } | null, points: ArrayLike<number>, offset: V3, surface: THREE.BufferGeometry | null, spacing: number): number[] {
    if (!marquee) return [];
    const r = stage.container.getBoundingClientRect();
    const left = parseFloat(stage.marqueeEl.style.left), top = parseFloat(stage.marqueeEl.style.top);
    const right = left + parseFloat(stage.marqueeEl.style.width), bottom = top + parseFloat(stage.marqueeEl.style.height);
    const v = new THREE.Vector3();
    const inside: number[] = []; // pass 1: points projecting inside the rectangle (+ in the depth frustum)
    for (let i = 0; i < points.length; i += 3) {
      v.set(points[i] + offset[0], points[i + 1] + offset[1], -(points[i + 2] + offset[2])).project(stage.camera);
      if (v.z < -1 || v.z > 1) continue; // behind the camera / beyond the far plane
      const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
      if (sx >= left && sx <= right && sy >= top && sy <= bottom) inside.push(i / 3);
    }
    if (access.shading() === 'none' || !inside.length) return inside; // wireframe selects through; nothing to test
    const bvh = surface ? access.geometryBVH(surface) : null;
    if (!bvh) return inside;
    // pass 2: drop the occluded ones — cast camera → point in the source's own untranslated data frame and reject it
    // when the surface is hit clearly in front of it. Corners sit ON the surface, so their own hit lands at
    // ~corner distance; the tolerance (≈ a cell, scaled with range) absorbs that + valley dips.
    const cam = new THREE.Vector3(
      stage.camera.position.x - offset[0],
      stage.camera.position.y - offset[1],
      -stage.camera.position.z - offset[2],
    );
    const cd = new THREE.Vector3(), ray = new THREE.Ray();
    const visible: number[] = [];
    for (const idx of inside) {
      const b = idx * 3;
      cd.set(points[b], points[b + 1], points[b + 2]);
      const dist = cam.distanceTo(cd);
      ray.origin.copy(cam);
      ray.direction.subVectors(cd, cam).normalize();
      const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, dist + spacing * 4);
      const tol = Math.max(spacing * 1.5, dist * 0.02);
      if (hit && hit.distance < dist - tol) continue; // the surface is in front → the corner is hidden
      visible.push(idx);
    }
    return visible;
  }

  /** Select-through query for the explicit "overlapping vertices" command. Selected curved patches become
   * a union of projected preview triangles in the CURRENT camera; their own corner ids are excluded, then
   * every other authored corner whose projection lands in that union is returned. Depth is deliberately not
   * compared: this is the view-relative masking operation used to clear mountain geometry below an overlay. */
  function projectedVerticesInsidePatches(quads: readonly number[]): number[] {
    const doc = access.meshDoc(), preview = access.preview();
    if (!doc || !preview || !quads.length) return [];
    stage.camera.updateMatrixWorld();
    const excluded = new Set<number>();
    for (const quad of quads) for (const vertex of doc.quads[quad] ?? []) excluded.add(vertex);

    const res = Math.round(Math.sqrt(preview.facesPerCell / 2)), side = res + 1;
    const projected = new THREE.Vector3();
    const pointAt = (vertex: number): { x: number; y: number; z: number } | null => {
      const offset = vertex * 3;
      if (offset < 0 || offset + 2 >= preview.positions.length) return null;
      projected.set(preview.positions[offset], preview.positions[offset + 1], -preview.positions[offset + 2])
        .project(stage.camera);
      return Number.isFinite(projected.x) && Number.isFinite(projected.y) && Number.isFinite(projected.z)
        ? { x: projected.x, y: projected.y, z: projected.z } : null;
    };
    const triangles: ProjectedTriangle[] = [];
    for (const quad of quads) {
      if (quad < 0 || quad >= doc.quads.length) continue;
      const base = quad * PATCH_VERTS;
      const grid = Array.from({ length: PATCH_VERTS }, (_, i) => pointAt(base + i));
      for (let u = 0; u < res; u++) for (let v = 0; v < res; v++) {
        const a = grid[u * side + v], b = grid[u * side + v + 1];
        const c = grid[(u + 1) * side + v], d = grid[(u + 1) * side + v + 1];
        if (!a || !b || !c || !d) continue;
        // Fully clipped cells cannot form a meaningful on-screen mask. Ordinary visible patches—the intended
        // workflow—remain exact; refusing near/far-plane straddlers avoids projection blow-ups behind camera.
        if ([a, b, c, d].some(point => point.z < -1 || point.z > 1)) continue;
        triangles.push([[a.x, a.y], [d.x, d.y], [c.x, c.y]]);
        triangles.push([[a.x, a.y], [b.x, b.y], [d.x, d.y]]);
      }
    }

    const candidates = [];
    for (let vertex = 0; vertex < doc.vertices.length / 3; vertex++) {
      if (excluded.has(vertex) || vertexHidden(vertex)) continue;
      const i = vertex * 3;
      projected.set(doc.vertices[i], doc.vertices[i + 1], -doc.vertices[i + 2]).project(stage.camera);
      if (projected.z < -1 || projected.z > 1) continue;
      candidates.push({ id: vertex, x: projected.x, y: projected.y });
    }
    return pointsInProjectedTriangles(candidates, triangles);
  }

  /** Authored point-cloud marquee source: every ordinary corner plus only the floating controls belonging to
   * explicitly pinned cages. The projection/occlusion work stays in verticesInMarquee. */
  function authoredControlPointsInMarquee(marquee: { x0: number; y0: number } | null): { ids: MeshControlPointId[]; points: number[]; indices: number[] } {
    if (!cage.subCage) {
      const net = access.net(), doc = access.meshDoc();
      const points = net ? Array.from(net.positions) : [];
      const indices = verticesInMarquee(marquee, points, [0, 0, 0], access.terrain().geometry, access.netSpacing())
        .filter(vertex => !vertexHidden(vertex));
      const ids = doc
        ? indices.flatMap((vertex): MeshControlPointId[] => {
          const name = vertexName(doc, vertex);
          return name === null ? [] : [{ kind: 'vertex', vertex: name }];
        })
        : [];
      return { ids, points, indices };
    }
    const cps = cage.authoredControlPoints.filter(cp => !controlPointHidden(cp.id) && cage.authoredControlPointVisible(cp.id));
    const points = cps.flatMap(cp => cp.pos);
    const indices = verticesInMarquee(marquee, points, [0, 0, 0], access.terrain().geometry, access.netSpacing());
    return { ids: indices.map(i => cps[i].id), points, indices };
  }

  function referenceControlPointsInMarquee(marquee: { x0: number; y0: number } | null): { ids: MeshControlPointId<number>[]; points: number[]; indices: number[] } {
    if (!access.refData() || !cage.cage) return { ids: [], points: [], indices: [] };
    const list = access.referenceControlPoints();
    const cps = list.filter(cp => cage.referenceControlPointVisible(cp.id));
    const points = cps.flatMap(cp => cp.pos), o = stage.refRoot.position;
    const indices = verticesInMarquee(marquee, points, [o.x, o.y, o.z], access.reference()?.geometry ?? null, access.netSpacing());
    return { ids: indices.map(i => cps[i].id), points, indices };
  }

  type MarqueeMeshSelection<Point> = {
    points: Point[];
    edges: [number, number][];
    patches: number[];
    pointPositions: number[];
    pointIndices: number[];
  };

  function curvedEdgeCenter(mesh: QuadMesh, edgeHandle: EdgeHandle, from: number, to: number): V3 {
    const at = (vertex: number): V3 => {
      const i = vertex * 3;
      return [mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]];
    };
    const p0 = at(from), p3 = at(to), h0 = edgeHandle(from, to), h1 = edgeHandle(to, from);
    return cubicPoint(
      p0,
      [p0[0] + h0[0], p0[1] + h0[1], p0[2] + h0[2]],
      [p3[0] + h1[0], p3[1] + h1[1], p3[2] + h1[2]],
      p3,
      0.5,
    );
  }

  /** Select edges by their true curved midpoint and patches by their true bicubic center. These component
   * centers match the click-family idea of one selectable item while letting a rectangle collect every
   * enabled family without requiring all four patch corners to fit inside it. */
  function componentCentersInMarquee(
    marquee: { x0: number; y0: number } | null,
    mesh: QuadMesh,
    adj: MeshAdjacency,
    edgeHandle: EdgeHandle,
    controls: readonly (readonly V3[])[],
    surface: THREE.BufferGeometry | null,
    offset: V3,
    edgeVisible: (from: number, to: number) => boolean,
    patchVisible: (patch: number) => boolean,
  ): { edges: [number, number][]; patches: number[] } {
    const edges: [number, number][] = [];
    const edgeCenters: number[] = [];
    for (let from = 0; from < adj.neighbors.length; from++) for (const to of adj.neighbors[from] ?? []) {
      if (to <= from || !edgeVisible(from, to)) continue;
      edges.push([from, to]);
      edgeCenters.push(...curvedEdgeCenter(mesh, edgeHandle, from, to));
    }
    const edgeHits = verticesInMarquee(marquee, edgeCenters, offset, surface, access.netSpacing());

    const patches: number[] = [];
    const patchCenters: number[] = [];
    for (let patch = 0; patch < controls.length; patch++) {
      const cp = controls[patch];
      if (!patchVisible(patch) || !cp || cp.length < 16) continue;
      patches.push(patch);
      patchCenters.push(...patchPoint(cp as V3[], 0.5, 0.5));
    }
    const patchHits = verticesInMarquee(marquee, patchCenters, offset, surface, access.netSpacing());
    return {
      edges: edgeHits.flatMap(index => edges[index] ? [edges[index]] : []),
      patches: patchHits.flatMap(index => patches[index] === undefined ? [] : [patches[index]]),
    };
  }

  function authoredEditSelectionInMarquee(marquee: { x0: number; y0: number } | null): MarqueeMeshSelection<MeshControlPointId> {
    const pointPick = sel.editPickKinds.point ? authoredControlPointsInMarquee(marquee) : { ids: [], points: [], indices: [] };
    const preview = access.preview(), net = access.net(), edgeHandle = access.meshHandle();
    const components = preview && net && edgeHandle && (sel.editPickKinds.edge || sel.editPickKinds.patch)
      ? componentCentersInMarquee(
        marquee, preview.mesh, net.adj, edgeHandle,
        preview.mesh.quads.map((_quad, patch) => quadControlPoints(preview.mesh, edgeHandle, patch, preview.twistOf(patch))) as V3[][],
        access.terrain().geometry, [0, 0, 0],
        (from, to) => sel.editPickKinds.edge && !edgeHidden(from, to),
        patch => sel.editPickKinds.patch && !quadHidden(patch),
      )
      : { edges: [], patches: [] };
    return {
      points: pointPick.ids,
      edges: components.edges,
      patches: components.patches,
      pointPositions: pointPick.points,
      pointIndices: pointPick.indices,
    };
  }

  function referenceEditSelectionInMarquee(marquee: { x0: number; y0: number } | null): MarqueeMeshSelection<MeshControlPointId<number>> {
    const pointPick = sel.editPickKinds.point ? referenceControlPointsInMarquee(marquee) : { ids: [], points: [], indices: [] };
    const data = access.refData(), adj = refAdjacency(), reference = access.reference(), o = stage.refRoot.position;
    const components = data && adj && reference && (sel.editPickKinds.edge || sel.editPickKinds.patch)
      ? componentCentersInMarquee(
        marquee, data.mesh, adj, data.edgeHandle, data.patchControls as V3[][],
        reference.geometry, [o.x, o.y, o.z],
        (from, to) => sel.editPickKinds.edge && !refEdgeHidden(from, to),
        patch => sel.editPickKinds.patch && !refQuadHidden(patch),
      )
      : { edges: [], patches: [] };
    return {
      points: pointPick.ids,
      edges: components.edges,
      patches: components.patches,
      pointPositions: pointPick.points,
      pointIndices: pointPick.indices,
    };
  }

  /** Screen distance from the marquee's start pixel to the nearest selected point (cage-only overlap fallback). */
  function nearestSelectedPointDist2(marquee: { x0: number; y0: number } | null, points: ArrayLike<number>, ids: readonly number[], offset: V3): number {
    if (!marquee || !ids.length) return Infinity;
    const r = stage.container.getBoundingClientRect();
    const p = new THREE.Vector3();
    let best = Infinity;
    for (const id of ids) {
      const i = id * 3;
      p.set(points[i] + offset[0], points[i + 1] + offset[1], -(points[i + 2] + offset[2])).project(stage.camera);
      const x = (p.x * 0.5 + 0.5) * r.width, y = (-p.y * 0.5 + 0.5) * r.height;
      best = Math.min(best, (x - marquee.x0) ** 2 + (y - marquee.y0) ** 2);
    }
    return best;
  }

  function selectReferenceControlPoints(incoming: readonly MeshControlPointId<number>[], mode: 'replace' | 'add' | 'remove' | 'toggle') {
    if (mode !== 'replace' && (authoredMeshSelectionActive() || sel.refEdgeSel.length || sel.refCellSel.length)) return;
    if (mode === 'replace') sel.refVertexAnchor = null;
    clearRefCells();
    clearRefEdges();
    const map = new Map((mode === 'replace' ? [] : sel.refControlSel).map(id => [controlPointKey(id), id]));
    for (const id of incoming) {
      const key = controlPointKey(id);
      if (mode === 'remove' || (mode === 'toggle' && map.has(key))) map.delete(key); else map.set(key, id);
    }
    sel.refControlSel = [...map.values()];
    sel.refVertexSel = sel.refControlSel.flatMap(id => id.kind === 'vertex' ? [id.vertex] : []).sort((a, b) => a - b);
    const byKey = new Map(access.referenceControlPoints().map(cp => [controlPointKey(cp.id), cp.pos]));
    const positions = sel.refControlSel.flatMap(id => { const p = byKey.get(controlPointKey(id)); return p ? [p] : []; });
    setVertexMarks(refRegionMarks, positions);
    rebuildReferenceControlPointCages();
    stage.detachGizmo();
    placeCornerMarker(null);
    stage.cb.onSelectKnot(null);
    stage.cb.onSelectCorner(null); // drops every authored vertex/edge/cell family through the host's normal path
    stage.cb.onRefSelectionChange?.();
  }

  /** Direct reference-vertex selection uses the same topology-aware replace/toggle/range resolver as authored
   * vertices. Only the host action differs afterward: the reference set gets no transform gizmo. */
  function selectReferenceVertex(vertex: number, mode: VertexSelectMode) {
    const id: MeshControlPointId<number> = { kind: 'vertex', vertex };
    const mixed = sel.refControlSel.some(point => point.kind !== 'vertex');
    if (mixed) {
      selectReferenceControlPoints([id], mode === 'toggle' ? 'toggle' : mode === 'range' ? 'add' : 'replace');
      sel.refVertexAnchor = vertex;
      return;
    }
    const adj = refAdjacency();
    if (!adj) return;
    const result = resolveVertexSelection(sel.refVertexSel, sel.refVertexAnchor, vertex, mode, adj, INDEX_NAMING);
    selectReferenceControlPoints(result.verts.map((v): MeshControlPointId<number> => ({ kind: 'vertex', vertex: v })), 'replace');
    sel.refVertexAnchor = result.anchor;
  }

  function mergeMarqueeValues<T>(current: readonly T[], incoming: readonly T[], key: (value: T) => string,
    mode: 'replace' | 'add' | 'remove'): T[] {
    const map = new Map((mode === 'replace' ? [] : current).map(value => [key(value), value]));
    for (const value of incoming) {
      const id = key(value);
      if (mode === 'remove') map.delete(id); else map.set(id, value);
    }
    return [...map.values()];
  }

  function renderReferenceMarqueeSelection() {
    const points = new Map(access.referenceControlPoints().map(point => [controlPointKey(point.id), point.pos]));
    setVertexMarks(refRegionMarks, sel.refControlSel.flatMap(id => {
      const point = points.get(controlPointKey(id));
      return point ? [point] : [];
    }));
    rebuildReferenceControlPointCages();
    drawRefEdges(false);
    drawRefCells(false);
    stage.detachGizmo();
    placeCornerMarker(null);
    stage.cb.onRefSelectionChange?.();
  }

  function applyReferenceMarquee(selection: MarqueeMeshSelection<MeshControlPointId<number>>,
    mode: 'replace' | 'add' | 'remove') {
    sel.refControlSel = mergeMarqueeValues(sel.refControlSel, selection.points, controlPointKey, mode);
    sel.refVertexSel = sel.refControlSel.flatMap(id => id.kind === 'vertex' ? [id.vertex] : []).sort((a, b) => a - b);
    sel.refEdgeSel = mergeMarqueeValues(sel.refEdgeSel, selection.edges, ([from, to]) => ekey(from, to), mode);
    sel.refCellSel = mergeMarqueeValues(sel.refCellSel, selection.patches, patch => `${patch}`, mode)
      .sort((a, b) => a - b);
    sel.refVertexAnchor = null;
    sel.refEdgeAnchor = null;
    sel.refCellAnchor = null;
    sel.refCellLoopSeed = null;
    renderReferenceMarqueeSelection();
  }

  /** Keep one reference family from a mixed marquee. Reference picks are read-only, so narrowing only redraws
   * the retained highlight and opens the already-existing type-specific reference toolbox. */
  function narrowReferenceEditSelection(kind: 'point' | 'edge' | 'patch') {
    if (kind !== 'point') { sel.refControlSel = []; sel.refVertexSel = []; sel.refVertexAnchor = null; }
    if (kind !== 'edge') { sel.refEdgeSel = []; sel.refEdgeAnchor = null; }
    if (kind !== 'patch') {
      sel.refCellSel = []; sel.refCellAnchor = null; sel.refCellLoopSeed = null;
    }
    renderReferenceMarqueeSelection();
  }

  /** Resolve all enabled Edit component families from one rectangle, then choose authored or reference as one
   * substrate. Authored results may include placed props; reference results remain mesh-only and read-only. */
  function finishEditMarquee(
    mode: 'replace' | 'add' | 'remove',
    marquee: { x0: number; y0: number } | null,
    hint: 'authored' | 'reference' | null,
    props: number[],
    authoredPropSelectionActive: boolean,
  ) {
    const authored = authoredEditSelectionInMarquee(marquee);
    const reference = referenceEditSelectionInMarquee(marquee);
    const authoredHas = authored.points.length > 0 || authored.edges.length > 0 || authored.patches.length > 0 || props.length > 0;
    const referenceHas = reference.points.length > 0 || reference.edges.length > 0 || reference.patches.length > 0;
    const modifying = mode !== 'replace';
    if (modifying && !authoredHas && !referenceHas) return;

    let source: 'authored' | 'reference' = 'authored';
    if (modifying && referenceMeshSelectionActive()) source = 'reference';
    else if (modifying && (authoredMeshSelectionActive() || authoredPropSelectionActive)) source = 'authored';
    else if (referenceHas && !authoredHas) source = 'reference';
    else if (referenceHas && authoredHas) {
      if (hint) source = hint;
      else if (authored.pointIndices.length && reference.pointIndices.length) {
        const o = stage.refRoot.position;
        const rd = nearestSelectedPointDist2(marquee, reference.pointPositions, reference.pointIndices, [o.x, o.y, o.z]);
        const ad = nearestSelectedPointDist2(marquee, authored.pointPositions, authored.pointIndices, [0, 0, 0]);
        source = rd < ad ? 'reference' : 'authored';
      }
    }

    if (source === 'reference') {
      // A replacement may be taking over from authored mesh/props. The host callback clears those families;
      // modifier edits already belong to the active reference and must retain its current sets for merging.
      if (!modifying) stage.cb.onSelectCorner(null);
      host.clearRefSelection();
      applyReferenceMarquee(reference, mode);
      return;
    }

    clearRefLoops();
    const selection: EditMarqueeSelection = {
      points: authored.points,
      edges: authored.edges,
      patches: authored.patches,
      props,
    };
    stage.cb.onSelectEditMarquee?.(selection, mode);
  }

  /** Drop any control-net corner selection (Escape, editor switch). */
  function clearCornerSelection() {
    stage.detachGizmo();
    placeCornerMarker(null);
    cage.showHandles(null, []);
    controlPointSel = [];
    controlPointSelPositions = [];
    movableControlPointKeys.clear();
    clearGlyphGroup(controlPointCageGroup);
    host.clearRefSelection();
    clearRefLoops();
    setRegionMarks([]);
    cornerGroupHandle.visible = false;
  }

  function setControlPointSelection(ids: readonly MeshControlPointId[]) {
    controlPointSel = [...new Map(ids.map(id => [controlPointKey(id), id])).values()];
    refreshControlPointSelection();
  }

  function refreshControlPointSelection() {
    const byKey = new Map(cage.authoredControlPoints.map(cp => [controlPointKey(cp.id), cp]));
    const live = controlPointSel.flatMap(id => {
      const cp = byKey.get(controlPointKey(id));
      return cp ? [cp] : [];
    });
    controlPointSel = live.map(cp => cp.id);
    controlPointSelPositions = live.map(cp => cp.pos);
    setRegionMarks(controlPointSelPositions);
    rebuildControlPointCages();
    const doc = access.meshDoc(), lockedVertices = doc ? lockedVertexSet(doc) : new Set<number>();
    const lockedEdges = doc ? lockedEdgeSet(doc) : new Set<string>();
    const movable = !doc ? [] : live.filter(cp => {
      const at = controlPointIndex(doc, cp.id);
      return !!at && !controlPointIsLocked(doc, at, lockedVertices, lockedEdges);
    });
    movableControlPointKeys = new Set(movable.map(cp => controlPointKey(cp.id)));
    // A document refresh during a combined mesh + prop drag must update these marks without handing the
    // shared anchor back to the point family. The mixed centroid owns it until the selection is narrowed.
    if (stage.gizmoKind === 'editmixed') return;
    if (!movable.length) {
      if (stage.gizmoKind === 'controlpoints') stage.detachGizmo();
      cornerGroupHandle.visible = false;
      return;
    }
    if (stage.gizmoKind === 'controlpoints' && stage.gizmo.dragging) return;
    let x = 0, y = 0, z = 0;
    for (const cp of movable) { x += cp.pos[0]; y += cp.pos[1]; z += cp.pos[2]; }
    x /= movable.length; y /= movable.length; z /= movable.length;
    cornerGroupHandle.position.set(x, y, -z);
    cornerGroupHandleLast.set(x, y, z);
    cornerGroupHandle.visible = true;
    if (stage.gizmoKind !== 'controlpoints') stage.attachGizmo(cornerGroupHandle, 'controlpoints', -1);
    else host.applyGizmoFrame();
  }

  /** Remap the live control-point selection marks by a gizmo Move delta. */
  function shiftControlPointMarks(d: V3) {
    controlPointSelPositions = controlPointSelPositions.map((q, i) => movableControlPointKeys.has(controlPointKey(controlPointSel[i]))
      ? [q[0] + d[0], q[1] + d[1], q[2] + d[2]] as V3 : q);
    setRegionMarks(controlPointSelPositions); // immediate feedback while the queued preview catches up
    rebuildControlPointCages();
  }

  /** Fold rotated / scaled control-point targets back into the live selection highlight (positions + marks). */
  function controlPointsMoved(targets: { id: MeshControlPointId; pos: V3 }[]) {
    const moved = new Map(targets.filter(t => movableControlPointKeys.has(controlPointKey(t.id)))
      .map(t => [controlPointKey(t.id), t.pos]));
    controlPointSelPositions = controlPointSelPositions.map((p, i) => moved.get(controlPointKey(controlPointSel[i])) ?? p);
    setRegionMarks(controlPointSelPositions);
    rebuildControlPointCages();
  }

  /** Redraw the contextual owner cages for the directly-selected authored floating points. */
  function rebuildControlPointCages() {
    clearGlyphGroup(controlPointCageGroup);
    const pv = access.preview(), eh = access.meshHandle(), doc = access.meshDoc();
    if (!cage.cage || !cage.subCage || !pv || !eh || !doc) return;
    const selected = controlPointSel.filter(id => !controlPointHidden(id));
    const named = controlPointCageOwners(selected);
    const owners = { edges: edgeIndices(doc, named.edges), quads: quadIndices(doc, named.quads) };
    for (const edge of owners.edges) buildEdgeCage(controlPointCageGroup, edge, pv.mesh, eh, true);
    for (const quad of owners.quads) {
      if (!pv.mesh.quads[quad]) continue;
      const group = new THREE.Group();
      controlPointCageGroup.add(group);
      buildCellNet(group, quadControlPoints(pv.mesh, eh, quad, pv.twistOf(quad)) as number[][], true);
    }
  }

  /** Reference twin of rebuildControlPointCages; the points are read-only but their ownership is identical. */
  function rebuildReferenceControlPointCages() {
    clearGlyphGroup(refControlPointCageGroup);
    const data = access.refData();
    if (!cage.cage || !cage.referenceSubCage || !data) return;
    const owners = controlPointCageOwners(sel.refControlSel.filter(id => !refControlPointHidden(id)));
    for (const edge of owners.edges) if (!refEdgeHidden(edge[0], edge[1]))
      buildEdgeCage(refControlPointCageGroup, edge, data.mesh, data.edgeHandle, true);
    for (const quad of owners.quads) {
      if (refQuadHidden(quad)) continue;
      const cps = data.patchControls[quad];
      if (!cps) continue;
      const group = new THREE.Group();
      refControlPointCageGroup.add(group);
      buildCellNet(group, cps, true);
    }
  }

  function setCornerGroup(positions: V3[], indices: number[] = [], showMarks = true) {
    setGroupHandle(positions, indices, showMarks, 'corners');
  }

  /** Seat the shared handle on the union of every movable authored family in an Edit marquee. It transforms
   * in World space: Move is free and Rotate is rigid about this centroid; Surface slide and Scale have no
   * single meaningful contract across terrain topology and placed props. */
  function setEditMixedGroup(positions: V3[], indices: number[] = []) {
    setGroupHandle(positions, indices, false, 'editmixed');
  }

  function setGroupHandle(positions: V3[], indices: number[], showMarks: boolean, kind: 'corners' | 'editmixed') {
    cornerGroupIdx = indices; // remembered for the averaged surface frame (regionFrame) + the group slide
    if (showMarks) setRegionMarks(positions);
    if (!positions.length) {
      if (kind === 'editmixed' || stage.gizmoKind === kind) stage.detachGizmo();
      cornerGroupHandle.visible = false;
      return;
    }
    if (stage.gizmoKind === kind && stage.gizmo.dragging) return; // the gizmo owns its position mid-drag
    let x = 0, y = 0, z = 0;
    for (const p of positions) { x += p[0]; y += p[1]; z += p[2]; }
    x /= positions.length; y /= positions.length; z /= positions.length;
    cornerGroupHandle.position.set(x, y, -z); // scene-root: negate Z onto the flipped terrain
    cornerGroupHandleLast.set(x, y, z);
    if (kind === 'editmixed') cornerGroupHandle.quaternion.identity();
    cornerGroupHandle.visible = true;
    if (stage.gizmoKind !== kind) {
      // a re-pick of the cell / edge whose cage handle carries the gizmo hands it back to the group — the
      // handle spheres were just rebuilt by the selection redraw, so release the pick without disposing them
      if (stage.gizmoKind === 'cagehandle') releaseCageHandle();
      stage.attachGizmo(cornerGroupHandle, kind, -1);
    }
    else host.applyGizmoFrame(); // same gizmo, changed membership → refresh the averaged surface frame
  }

  /** Select (or deselect, with null) a control-net corner: seats the invisible gizmo anchor on it. The
   *  visible selection is the translate gizmo + the tangent-handle nubs (showHandles) that mark the corner.
   *  Only positions the anchor - gizmo attachment is driven by explicit clicks (selectCorner / the nub
   *  branch), so a reposition never yanks the gizmo off a tangent nub the user is shaping. */
  function placeCornerMarker(index: number | null) {
    const doc = access.meshDoc();
    sel.selectedCorner = index === null || !doc ? null : vertexName(doc, index);
    const net = access.net();
    cornerMarker.visible = index !== null && !!net;
    if (index === null || !net) return;
    const i = index * 3, c = net.positions;
    cornerMarker.position.set(c[i], c[i + 1], -c[i + 2]); // scene-root: negate Z onto the flipped terrain
    scaleEditMarkers(); // size the dot for this frame; the render loop keeps it screen-constant after
  }

  /** Hold the selected-corner marker dot + the cage handle spheres at a constant few px on screen, re-scaled
   *  every frame — the point twin of scaleHandleNubs (the tangent nubs). */
  function scaleEditMarkers() {
    if (cornerMarker.visible) cornerMarker.scale.setScalar(Math.max(1e-4, CTRL_CORNER_SEL_PX * stage.worldPerPixel(cornerMarker.position)));
    for (const m of cageHandleMeshes) m.scale.setScalar(Math.max(1e-4, HANDLE_NUB_PX * stage.worldPerPixel(m.position)));
  }

  /** Drop BOTH reference net-click highlights — clicked-face cell shading and the edge selection (mutually
   *  exclusive), so an authored pick / deselect / mode change / reload clears the reference cleanly. The two
   *  finer clears below let a single reference pick keep its own selection alive. */
  function clearRefLoops() {
    clearRefCells();
    clearRefEdges();
    clearRefVertices();
  }

  /** Drop the read-only reference vertex marquee selection. */
  function clearRefVertices() {
    sel.refVertexAnchor = null;
    if (!sel.refControlSel.length && !sel.refVertexSel.length) return;
    sel.refControlSel = [];
    sel.refVertexSel = [];
    setVertexMarks(refRegionMarks, []);
    clearGlyphGroup(refControlPointCageGroup);
    stage.cb.onRefSelectionChange?.();
  }

  function referenceVertexSelectionCount(): number { return sel.refVertexSel.length; }
  function referenceControlPointSelectionCount(): number { return sel.refControlSel.length; }
  function referenceSelectedVertexInfo(): { vertex: number; valence: number }[] {
    const adj = refAdjacency();
    if (!adj) return [];
    return sel.refVertexSel.map(vertex => ({ vertex, valence: vertexValence(adj, vertex) }));
  }

  /** Resolve the mutually-exclusive reference point/edge/surface families to unique clipboard vertices. */
  function referenceCopyVertexIds(): number[] {
    if (sel.refVertexSel.length) return sel.refVertexSel;
    const vertices = new Set<number>();
    if (sel.refEdgeSel.length) {
      for (const [a, b] of sel.refEdgeSel) { vertices.add(a); vertices.add(b); }
    } else {
      const d = access.refData();
      if (d) for (const q of sel.refCellSel) for (const v of d.mesh.quads[q] ?? []) vertices.add(v);
    }
    return [...vertices].sort((a, b) => a - b);
  }

  function referenceCopyVertexCount(): number { return referenceCopyVertexIds().length; }

  function copyReferenceMeshSelection(): MeshVertexClipboard | null {
    const data = access.refData(), selectedVertices = referenceCopyVertexIds();
    if (!data || !selectedVertices.length) return null;
    const o = stage.refRoot.position;
    return copyMeshVertices({
      mesh: data.mesh,
      selectedVertices,
      naming: INDEX_NAMING,
      selectedQuads: sel.refEdgeSel.length ? [] : sel.refCellSel.length ? sel.refCellSel : undefined,
      selectedEdges: sel.refEdgeSel.length ? sel.refEdgeSel : sel.refCellSel.length ? [] : undefined,
      edgeHandle: data.edgeHandle,
      offset: [o.x, o.y, o.z],
      controls: q => data.patchControls[q] as V3[],
      paint: q => data.patchSurf[q],
      texture: q => data.patchTex[q] ? resolveTerrainTexRef(access.refLevel(), data.patchTex[q]!) : undefined,
      orientation: q => data.patchUV[q] ? orientFromPatchUV(data.patchUV[q]!) : undefined,
    });
  }

  /** Drop just the reference edge selection + its anchor. */
  function clearRefEdges() {
    if (!sel.refEdgeSel.length && sel.refEdgeAnchor === null) return;
    sel.refEdgeSel = [];
    sel.refEdgeAnchor = null;
    clearGlyphGroup(refEdgeGroup);
    stage.cb.onRefSelectionChange?.();
  }

  function refMeasure(): SelectionMeasure | null {
    const d = access.refData();
    if (!d) return null;
    if (sel.refEdgeSel.length) return measureEdges(d.mesh, d.edgeHandle, sel.refEdgeSel);
    if (sel.refCellSel.length) return measureCells(q => d.patchControls[q] as V3[], sel.refCellSel);
    return null;
  }

  /** Measure the authored selection from the viewport's already-derived preview mesh. Selection/UI refreshes
   * must not rebuild topology and automatic edge handles for the entire mountain just to inspect one patch. */
  function authoredMeasure(): SelectionMeasure | null {
    const preview = access.preview();
    if (!preview) return null;
    if (sel.edgeSel.length) return measureEdges(preview.mesh, preview.edgeHandle, edgeSelIndices());
    if (sel.cellSel.length) return measureCells(
      quad => quadControlPoints(preview.mesh, preview.edgeHandle, quad, preview.twistOf(quad)),
      cellSelIndices(),
    );
    return null;
  }

  /** Adjacency of the reference QuadMesh, built once per loaded reference (nulled on load / clear). */
  function refAdjacency(): MeshAdjacency | null {
    const d = access.refData();
    if (!d) return null;
    if (!refAdj) refAdj = meshAdjacency(d.mesh);
    return refAdj;
  }

  /** Apply a click to the read-only reference edge selection through the SAME shared semantics the authored
   *  net uses (resolveEdgeSelection), on the reference's own QuadMesh + faithful edge curves. */
  function refEdgeSelect(edge: [number, number], mode: EdgeSelectMode) {
    const data = access.refData(), adj = refAdjacency();
    if (!data || !adj) return;
    const res = resolveEdgeSelection(sel.refEdgeSel, sel.refEdgeAnchor, edge, mode, data.mesh, adj, INDEX_NAMING);
    sel.refEdgeSel = res.edges.filter(([a, b]) => !refEdgeHidden(a, b));
    sel.refEdgeAnchor = res.anchor && !refEdgeHidden(res.anchor[0], res.anchor[1]) ? res.anchor : null;
    drawRefEdges();
  }

  /** Redraw the reference edge-selection highlight: each edge as a yellow fat line on its OWN stored curve
   *  (data.edgeHandle), in the reference frame. A SINGLE selected edge also overlays its control cage (read-only),
   *  matching the authored net. Mirrors rebuildEditEdgeSel. */
  function drawRefEdges(notify = true) {
    clearGlyphGroup(refEdgeGroup);
    const data = access.refData();
    if (data && sel.refEdgeSel.length) {
      const segs = meshEdgeSegments(data.mesh, data.edgeHandle, sel.refEdgeSel);
      addGlyphLines(refEdgeGroup, segs, EDIT_EDGE_SEL_COLOR, 1, EDIT_EDGE_SEL_WIDTH, LOOP_RENDER_ORDER + 1, false);
    }
    if (notify) stage.cb.onRefSelectionChange?.(); // fires even when the last edge toggled off, so the panel re-reads refMeasure
  }

  /** Apply the current view-mode visibilities to the reference selection overlays (marks / edges / cells). */
  function applyRefView(has: boolean, cageOn: boolean) {
    refRegionMarks.visible = has && cageOn && sel.refControlSel.length > 0;
    refEdgeGroup.visible = has && cageOn;   // the edge selection rides the cage toggle too
    refCellGroup.visible = has && cageOn;   // the cell shading rides the cage toggle too
    refCellNetGroup.visible = has && cageOn; // its 16-point control net rides it too
    refControlPointCageGroup.visible = has && cageOn;
  }

  /** Drop the caches derived from the loaded reference (its QuadMesh adjacency; rebuilt lazily on demand). */
  function resetReferenceCache() {
    refAdj = null;
  }

  function authoredMeshSelectionActive(): boolean {
    // setCornerGroup also carries edge/cell endpoints (without orange marks), so it covers every multi-point,
    // edge and cell set; gizmoKind covers a plain single corner.
    return sel.selectedCorner !== null || cornerGroupIdx.length > 0 || controlPointSel.length > 0
      || sel.edgeSel.length > 0 || sel.cellSel.length > 0;
  }

  function referenceMeshSelectionActive(): boolean {
    return sel.refControlSel.length > 0 || sel.refVertexSel.length > 0 || sel.refEdgeSel.length > 0 || sel.refCellSel.length > 0;
  }

  /** Add one F-overlay line set as FAT lines at the current canvas resolution (see overlays.glyphLines). */
  function addGlyphLines(group: THREE.Group, arr: number[] | Float32Array, color: number, opacity: number,
    width = F_LINE_WIDTH, renderOrder = 12, depthTest = true) {
    glyphLines(group, arr, color, opacity, [stage.container.clientWidth || 1, stage.container.clientHeight || 1], width, renderOrder, depthTest);
  }

  return {
    get cornerMarker() { return cornerMarker; },
    get cornerGroupHandle() { return cornerGroupHandle; },
    get cornerGroupHandleLast() { return cornerGroupHandleLast; },
    get cageHandleAnchor() { return cageHandleAnchor; },
    get cageHandleMeshes() { return cageHandleMeshes; },
    get selectedCageHandle() { return selectedCageHandle; },
    get cornerGroupIdx(): readonly number[] { return cornerGroupIdx; },
    get controlPointSel(): readonly MeshControlPointId[] { return controlPointSel; },
    get hiddenVertices(): ReadonlySet<number> { return hiddenVertices; },
    get hiddenEdges(): ReadonlySet<string> { return hiddenEdges; },
    get hiddenQuads(): ReadonlySet<number> { return hiddenQuads; },
    get refHiddenQuads(): ReadonlySet<number> { return refHiddenQuads; },
    fatLineGroups: [editEdgeGroup, editCellNetGroup, controlPointCageGroup, refEdgeGroup, refCellNetGroup, refControlPointCageGroup] as const,
    refreshEditCells, refreshEditEdges, rebuildEditCellSel, rebuildEditEdgeSel, setCellFill,
    setRegionMarks, setControlPointSelection, refreshControlPointSelection, shiftControlPointMarks, controlPointsMoved,
    rebuildControlPointCages, rebuildReferenceControlPointCages,
    setCornerGroup, setEditMixedGroup, placeCornerMarker, scaleEditMarkers, clearCornerSelection,
    selectCageHandle, clearCageHandle, releaseCageHandle, cageHandleMatches,
    refreshHiddenSets, refreshReferenceHiddenSets, vertexHidden, edgeHidden, quadHidden, controlPointHidden,
    refVertexHidden, refEdgeHidden, refQuadHidden, refControlPointHidden,
    refCellSelect, refCellLoop, drawRefCells, clearRefCells, refEdgeSelect, drawRefEdges, clearRefEdges,
    selectReferenceVertex, selectReferenceControlPoints, clearRefVertices, clearRefLoops,
    applyRefView, resetReferenceCache,
    referenceVertexSelectionCount, referenceControlPointSelectionCount, referenceSelectedVertexInfo,
    referenceCopyVertexCount, copyReferenceMeshSelection, authoredMeasure, refMeasure,
    finishEditMarquee, narrowReferenceEditSelection,
    projectedVerticesInsidePatches, authoredMeshSelectionActive, referenceMeshSelectionActive,
  };
}

export type SelectionLayer = ReturnType<typeof createSelectionLayer>;
