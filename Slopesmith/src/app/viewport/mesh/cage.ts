import * as THREE from 'three';
import type { QuadMeshDoc, V3 } from '../../../core/doc/types';
import { meshAdjacency, meshCageEdges, quadControlPoints, type EdgeHandle, type MeshAdjacency, type QuadMesh } from '../../../core/mesh/topology';
import { meshPoleIndices } from '../../../core/mesh/selection';
import { ekey } from '../../../core/mesh/ops';
import { controlPointKey, meshControlPoints, type MeshControlPoint, type MeshControlPointId } from '../../../core/mesh/control-points';
import { lockedEdgeSet } from '../../../core/mesh/locks';
import { controlPointIndex, edgeIndices, quadIndices, type NamedEdge, type QuadName } from '../../state/mesh-names';
import type { PreviewData } from '../../../core/mesh/tessellation';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import {
  CAGE_BOUNDARY_COLOR, CAGE_EDGE_SEG, CAGE_EXTRA3_COLOR, CAGE_EXTRA5_COLOR, CAGE_INTERIOR_COLOR, CAGE_LOCKED_COLOR,
  CAGE_POINT_COLOR, CAGE_TEAR_COLOR, CTRL_CAGE_COLOR, HANDLE_DIRS, HANDLE_NUB_PX, SURFACE_POLY_OFFSET,
} from '../constants';
import { addCageLines, addCageLinesBehind, addCagePoints, addCagePointsBehind } from '../shared/overlays';
import type { Stage } from '../stage';

/** Append one topology edge's four-point cubic control polygon as three line segments. Boundary rows / columns
 * are shared by adjacent patches, so emitting them from the unique mesh edge graph keeps the pinned sub-cages
 * compact and prevents shared edges becoming artificially brighter through overdraw. */
function appendEdgeControlPolygon(out: number[], mesh: QuadMesh, eh: EdgeHandle, a: number, b: number) {
  const pa: V3 = [mesh.vertices[a * 3], mesh.vertices[a * 3 + 1], mesh.vertices[a * 3 + 2]];
  const pb: V3 = [mesh.vertices[b * 3], mesh.vertices[b * 3 + 1], mesh.vertices[b * 3 + 2]];
  const ha = eh(a, b), hb = eh(b, a);
  const ca: V3 = [pa[0] + ha[0], pa[1] + ha[1], pa[2] + ha[2]];
  const cb: V3 = [pb[0] + hb[0], pb[1] + hb[1], pb[2] + hb[2]];
  out.push(...pa, ...ca, ...ca, ...cb, ...cb, ...pb);
}

/** Append the twelve non-boundary connections of one row-major 4x4 patch cage. The other twelve connections
 * are its four boundary control polygons, emitted once per unique topology edge above. */
function appendPatchInteriorLattice(out: number[], cp: readonly (readonly number[])[]) {
  const segment = (a: number, b: number) => out.push(...cp[a], ...cp[b]);
  for (let row = 1; row <= 2; row++) for (let col = 0; col < 3; col++) segment(row * 4 + col, row * 4 + col + 1);
  for (let col = 1; col <= 2; col++) for (let row = 0; row < 3; row++) segment(row * 4 + col, (row + 1) * 4 + col);
}

function setGeometryPositions(geometry: THREE.BufferGeometry | null, positions: number[]) {
  if (!geometry) return;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.boundingBox = null;
  geometry.boundingSphere = null;
}

/** The live mesh substrate the cage draws — the same accessors on both sides of the authored ⇄ reference
 *  parity: the authored preview / quad net / mesh doc / cached directed-edge handle, the loaded reference,
 *  the shade view (wires-only ghosts against the depth masks), and the Edit-mode hidden-component filters.
 *  The shell owns all of it and hands it in as closures, null where nothing is loaded. */
export interface CageMeshAccess {
  preview(): PreviewData | null;
  net(): { positions: number[]; adj: MeshAdjacency } | null;
  meshDoc(): QuadMeshDoc | null;
  edgeHandle(): EdgeHandle | null;
  refData(): ReferenceMesh | null;
  referenceControlPoints(): readonly MeshControlPoint<number>[];
  editMode(): boolean;
  /** Named (docs/039): a pinned sub-cage outlives the topology edits made while it is up. */
  controlCageEdges(): readonly NamedEdge[];
  controlCageQuads(): readonly QuadName[];
  refControlCageEdges(): readonly [number, number][];
  refControlCageQuads(): readonly number[];
  /** Cage-wires-only view (shading 'none'): no solid is drawn, so wires ghost against the depth masks. */
  wiresOnly(): boolean;
  vertexHidden(vertex: number): boolean;
  edgeHidden(a: number, b: number): boolean;
  controlPointHidden(id: MeshControlPointId): boolean;
  refVertexHidden(vertex: number): boolean;
  refEdgeHidden(a: number, b: number): boolean;
  refControlPointHidden(id: MeshControlPointId<number>): boolean;
  /** Edit-mode hidden vertices / quads exist, so the pole dots need their own visibility filter. */
  hiddenPolesActive(): boolean;
}

/** Host work a cage rebuild triggers: dropping the drag-local dependency tint (the rebuild's fresh global
 *  wires replace its in-place curve edits, leaving them fully visible). */
export interface CageHostHooks {
  clearLiveEditPreview(): void;
}

/**
 * The control-net CAGE of Edit mode, one layer serving the authored net and the loaded reference alike:
 * the authored corner lattice drawn as true cubic-Bézier wires (the same curves the quilt bakes) with the
 * explicitly pinned 4x4 control lattices and the reference's control-net lines from its recovered
 * exact primitives, the depth-only masks that dim hidden wires in cage-wires-only view, and the tangent-handle
 * data. The layer owns the coarse cage, focused sub-cages, and the derived authored
 * control-point list; the shell hands in the live mesh substrate through accessors (`CageMeshAccess`) and
 * keeps selection + gizmo orchestration, reading the point list, nub meshes and retained cage-edge buffer
 * ranges back through the typed API.
 */
export function createCageLayer(stage: Stage, mesh: CageMeshAccess, host: CageHostHooks) {
  const PINNED_CAGE_OPACITY = 0.82;
  const PINNED_CAGE_POINT_PX = 6.5;
  const cageGroup = new THREE.Group();
  const cageEdgeRanges = new Map<string, { geometry: THREE.BufferGeometry; floatOffset: number; edge: [number, number] }>();
  let cageOn = false;
  // Sub-cages are an explicit Edit visibility set rather than a mountain-wide toggle. The selection toolbox
  // pins edge / patch cages into the store; they remain until the empty Edit toolbox clears them.
  // an invisible depth-only copy of the terrain: in cage-only view (shading 'none') it writes depth
  // so cage wires hidden behind the surface can be dimmed, without the surface itself being drawn.
  const depthMaskMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide, ...SURFACE_POLY_OFFSET });
  const cageDepthMask = new THREE.Mesh(new THREE.BufferGeometry(), depthMaskMat);
  /** The authored pinned-sub-cage point cloud is derived from this exact list. The same entries
   *  drive click/box picking, so every visible dot is selectable and every selectable point is visible. */
  let authoredControlPoints: MeshControlPoint[] = [];
  let authoredControlPointByKey = new Map<string, MeshControlPoint>();
  let authoredCagePointGeometry: THREE.BufferGeometry | null = null;
  let authoredCagePointVertices: number[] = [];
  let authoredPole3Geometry: THREE.BufferGeometry | null = null;
  let authoredPole3Vertices: number[] = [];
  let authoredPole5Geometry: THREE.BufferGeometry | null = null;
  let authoredPole5Vertices: number[] = [];
  let authoredSubCagePointGeometry: THREE.BufferGeometry | null = null;
  let authoredSubCageLineGeometry: THREE.BufferGeometry | null = null;
  let authoredSubCageFaintPointGeometry: THREE.BufferGeometry | null = null;
  let authoredSubCageFaintCornerGeometry: THREE.BufferGeometry | null = null;
  let authoredSubCageFaintLineGeometry: THREE.BufferGeometry | null = null;
  const authoredSubCageEdgeRanges = new Map<string, number>();
  const authoredSubCageQuadRanges = new Map<number, number>();
  let authoredVisibleControlKeys = new Set<string>();
  let authoredVisibilityReady = false;
  const handleGroup = new THREE.Group();
  const handleNubs: Record<string, THREE.Mesh> = {};
  let handleCorner: V3 | null = null;
  const refCageGroup = new THREE.Group();             // reference control lattices + net lines
  const refSubCageGroup = new THREE.Group();          // sticky read-only edge / patch control cages
  let refVisibleControlKeys = new Set<string>();
  let refCageDepthMask: THREE.Mesh | null = null;     // depth-only mask of the reference solid (dims hidden wires in cage-only view)
  let refCageOcclude = false;                         // occlusion state the ref cage was last built with (rebuild on change)

  // The pinned sets are named; every predicate below works on the live numbering, so each resolves first.
  const pinnedEdges = () => {
    const doc = mesh.meshDoc();
    return new Set(doc ? edgeIndices(doc, mesh.controlCageEdges()).map(([a, b]) => ekey(a, b)) : []);
  };
  const pinnedQuads = () => {
    const doc = mesh.meshDoc();
    return doc ? quadIndices(doc, mesh.controlCageQuads()) : [];
  };
  const subCageActive = () => mesh.editMode()
    && (mesh.controlCageQuads().length > 0 || mesh.controlCageEdges().length > 0);
  const refPinnedEdges = () => new Set(mesh.refControlCageEdges().map(([a, b]) => ekey(a, b)));
  const refPinnedQuads = () => new Set(mesh.refControlCageQuads());
  const refSubCageActive = () => mesh.editMode()
    && (mesh.refControlCageQuads().length > 0 || mesh.refControlCageEdges().length > 0);
  const authoredQuadCageVisible = (quad: number) => subCageActive() && pinnedQuads().includes(quad);
  const authoredEdgeCageVisible = (a: number, b: number) => {
    if (!subCageActive()) return false;
    const key = ekey(a, b);
    if (pinnedEdges().has(key)) return true;
    const pv = mesh.preview();
    return !!pv && pinnedQuads().some(quad => {
      const q = pv.mesh.quads[quad];
      if (!q) return false;
      const [A, B, C, D] = q;
      return ([[A, B], [B, D], [D, C], [C, A]] as [number, number][]).some(([from, to]) => ekey(from, to) === key);
    });
  };

  /** Toggle the control-net cage (corner lattice) - shows the bicubic-Bezier net you're shaping. */
  function setCage(on: boolean) {
    cageOn = on;
    cageGroup.visible = on;
    rebuildCage();
  }

  /** Build the two lower-left colour keys and prepend them into #lowerleft so they sit left of the controls
   *  list. Each starts hidden; set shadeMode reveals the one matching the active view (cage / surface). */
  function rebuildCage() {
    const subCageOn = subCageActive();
    host.clearLiveEditPreview();
    cageEdgeRanges.clear();
    authoredCagePointGeometry = null;
    authoredCagePointVertices = [];
    authoredPole3Geometry = null; authoredPole3Vertices = [];
    authoredPole5Geometry = null; authoredPole5Vertices = [];
    authoredSubCagePointGeometry = null;
    authoredSubCageLineGeometry = null;
    authoredSubCageFaintPointGeometry = null;
    authoredSubCageFaintCornerGeometry = null;
    authoredSubCageFaintLineGeometry = null;
    authoredSubCageEdgeRanges.clear();
    authoredSubCageQuadRanges.clear();
    authoredVisibleControlKeys.clear();
    authoredVisibilityReady = false;
    while (cageGroup.children.length) {
      const c = cageGroup.children.pop() as THREE.Points | THREE.LineSegments;
      c.geometry.dispose();
      (c.material as THREE.Material).dispose();
    }
    const ghost = mesh.wiresOnly(); // cage-wires-only view: dim hidden wires against the depth mask
    // Wireframe props also depth-test against this surface. Keep the mask alive for the whole no-solid view,
    // independently of the control-cage toggle, so buried trunks / posts remain dim even if cage visibility
    // is changed programmatically or while the view state is being restored.
    cageDepthMask.visible = ghost;
    // The complete derived point cloud is substantial on a production mountain. Do not even enumerate it
    // while Subcage is off: the ordinary cage already owns its cheap corner buffer, and marquee uses `net`
    // directly in that state. A mixed point selection is cleared when Subcage turns off, so no hidden member
    // needs refreshing either. This keeps ordinary quad/corner drags on their pre-subcage hot path.
    const doc = mesh.meshDoc();
    authoredControlPoints = subCageOn && doc ? meshControlPoints(doc) : [];
    authoredControlPointByKey = new Map(authoredControlPoints.map(cp => [controlPointKey(cp.id), cp]));
    const net = mesh.net();
    if (!cageOn || !net) return;
    const { positions: corners, adj } = net;
    const pg = new THREE.BufferGeometry();
    const visibleCorners: number[] = [];
    for (let vertex = 0; vertex < corners.length / 3; vertex++) {
      if (mesh.vertexHidden(vertex)) continue;
      authoredCagePointVertices.push(vertex);
      visibleCorners.push(corners[vertex * 3], corners[vertex * 3 + 1], corners[vertex * 3 + 2]);
    }
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(visibleCorners), 3));
    authoredCagePointGeometry = pg;
    // edges follow the true cubic-Bezier boundary curves (corner + directional handles) — the SAME curves the
    // quilt bakes — so the cage reads as the terrain's actual edges, not straight chords (matching the
    // reference cage), drawn by meshCageEdges off the doc's directed-edge handles. The net's outer rim (an
    // edge on a single quad) draws warm so the mesh silhouette stands out.
    let interior: number[], boundary: number[];
    let interiorEdges: [number, number][] = [], boundaryEdges: [number, number][] = [];
    const eh = mesh.edgeHandle();
    const pv = mesh.preview();
    if (eh && pv) {
      ({ interior, boundary } = meshCageEdges(pv.mesh, eh, adj, CAGE_EDGE_SEG));
      // meshCageEdges emits in this exact adjacency order. Retain each edge's fixed-size float range so a
      // drag can rewrite only dirty curves in-place while every unrelated global edge remains visible.
      for (let a = 0; a < adj.neighbors.length; a++) for (const b of adj.neighbors[a]) {
        if (b < a) continue;
        ((adj.edgeQuads.get(ekey(a, b)) ?? []).length >= 2 ? interiorEdges : boundaryEdges).push([a, b]);
      }
    } else {
      // fallback (no mesh doc): straight-chord edges from the adjacency
      interior = []; boundary = [];
      const P = (id: number): [number, number, number] => [corners[id * 3], corners[id * 3 + 1], corners[id * 3 + 2]];
      for (let id = 0; id < adj.neighbors.length; id++) {
        for (const nb of adj.neighbors[id]) {
          if (nb < id) continue; // each undirected edge once
          const quads = adj.edgeQuads.get(`${id},${nb}`) ?? []; // id < nb, so this is the ekey order
          (quads.length >= 2 ? interiorEdges : boundaryEdges).push([id, nb]);
          (quads.length >= 2 ? interior : boundary).push(...P(id), ...P(nb));
        }
      }
    }
    // meshCageEdges emits fixed-size cubic segments in the same order as the edge lists above. Filter both
    // together so a hidden edge disappears without changing the topology used by selection/range queries.
    const edgeStride = eh && pv ? CAGE_EDGE_SEG * 2 * 3 : 2 * 3;
    const filterEdges = (segments: number[], edges: [number, number][]) => {
      const keptSegments: number[] = [], keptEdges: [number, number][] = [];
      edges.forEach((edge, i) => {
        if (mesh.edgeHidden(edge[0], edge[1])) return;
        keptSegments.push(...segments.slice(i * edgeStride, (i + 1) * edgeStride));
        keptEdges.push(edge);
      });
      return { segments: keptSegments, edges: keptEdges };
    };
    const keptInterior = filterEdges(interior, interiorEdges);
    const keptBoundary = filterEdges(boundary, boundaryEdges);
    // Protection is an authored editing attribute, so it colours the authored cage over every shade mode.
    // Pull locked edges out of their ordinary grid/rim batches (rather than overdrawing them) so red is exact
    // over Wireframe, Surface and Texture, and each retained live-edit range still names one curve.
    const locked = doc ? lockedEdgeSet(doc) : new Set<string>();
    const partition = (kept: { segments: number[]; edges: [number, number][] }) => {
      const normalSegments: number[] = [], normalEdges: [number, number][] = [];
      const lockedSegments: number[] = [], lockedEdges: [number, number][] = [];
      kept.edges.forEach((edge, i) => {
        const isLocked = locked.has(ekey(edge[0], edge[1]));
        (isLocked ? lockedSegments : normalSegments).push(...kept.segments.slice(i * edgeStride, (i + 1) * edgeStride));
        (isLocked ? lockedEdges : normalEdges).push(edge);
      });
      return { normalSegments, normalEdges, lockedSegments, lockedEdges };
    };
    const interiorParts = partition(keptInterior), boundaryParts = partition(keptBoundary);
    interior = interiorParts.normalSegments; interiorEdges = interiorParts.normalEdges;
    boundary = boundaryParts.normalSegments; boundaryEdges = boundaryParts.normalEdges;
    const lockedSegments = [...interiorParts.lockedSegments, ...boundaryParts.lockedSegments];
    const lockedEdges = [...interiorParts.lockedEdges, ...boundaryParts.lockedEdges];
    const interiorGeometry = addCageLines(cageGroup, interior, CAGE_INTERIOR_COLOR, 0.75, ghost);
    const boundaryGeometry = addCageLines(cageGroup, boundary, CAGE_BOUNDARY_COLOR, 0.9, ghost);
    const lockedGeometry = addCageLines(cageGroup, lockedSegments, CAGE_LOCKED_COLOR, 0.98, ghost);
    interiorEdges.forEach((edge, i) => cageEdgeRanges.set(ekey(edge[0], edge[1]), { geometry: interiorGeometry, floatOffset: i * edgeStride, edge }));
    boundaryEdges.forEach((edge, i) => cageEdgeRanges.set(ekey(edge[0], edge[1]), { geometry: boundaryGeometry, floatOffset: i * edgeStride, edge }));
    lockedEdges.forEach((edge, i) => cageEdgeRanges.set(ekey(edge[0], edge[1]), { geometry: lockedGeometry, floatOffset: i * edgeStride, edge }));
    addCagePoints(cageGroup, pg, CAGE_POINT_COLOR, 3.5, ghost);
    // Only explicitly pinned edge / patch cages are batched here. Their full cage gets a normal depth-tested
    // pass plus a faint behind-surface pass; every other floating control point remains absent and unpickable.
    if (subCageOn) {
      authoredSubCageLineGeometry = addCageLines(cageGroup, [], CTRL_CAGE_COLOR, PINNED_CAGE_OPACITY, false, 12);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
      authoredSubCagePointGeometry = g;
      addCagePoints(cageGroup, g, CTRL_CAGE_COLOR, PINNED_CAGE_POINT_PX, false, 12);
      authoredSubCageFaintLineGeometry = addCageLinesBehind(cageGroup, [], CTRL_CAGE_COLOR, PINNED_CAGE_OPACITY, 12);
      authoredSubCageFaintPointGeometry = new THREE.BufferGeometry();
      authoredSubCageFaintPointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
      addCagePointsBehind(cageGroup, authoredSubCageFaintPointGeometry, CTRL_CAGE_COLOR, PINNED_CAGE_POINT_PX, 12);
      authoredSubCageFaintCornerGeometry = new THREE.BufferGeometry();
      authoredSubCageFaintCornerGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(), 3));
      addCagePointsBehind(cageGroup, authoredSubCageFaintCornerGeometry, CAGE_POINT_COLOR, PINNED_CAGE_POINT_PX, 12);
      applyAuthoredVisibility();
    }
    // Extraordinary poles (interior-seam valence 3 / 5) replace the green corner hue at the same point size —
    // the same blue / purple dots the reference cage draws, so a poled authored net reads identically.
    if (pv) {
      const visible = (vertices: number[]) => mesh.hiddenPolesActive()
        ? vertices.filter(vertex => !mesh.vertexHidden(vertex)) : vertices;
      const cloud = (vertices: number[]) => {
        const positions = new Float32Array(vertices.flatMap(vertex =>
          [corners[vertex * 3], corners[vertex * 3 + 1], corners[vertex * 3 + 2]]));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        return geometry;
      };
      const poles = meshPoleIndices(pv.mesh);
      authoredPole3Vertices = visible(poles.extra3);
      authoredPole5Vertices = visible(poles.extra5);
      if (authoredPole3Vertices.length) {
        authoredPole3Geometry = cloud(authoredPole3Vertices);
        addCagePoints(cageGroup, authoredPole3Geometry, CAGE_EXTRA3_COLOR, 3.5, ghost, 12);
      }
      if (authoredPole5Vertices.length) {
        authoredPole5Geometry = cloud(authoredPole5Vertices);
        addCagePoints(cageGroup, authoredPole5Geometry, CAGE_EXTRA5_COLOR, 3.5, ghost, 12);
      }
    }
  }

  function filteredSubCage<Id>(
    qmesh: QuadMesh, eh: EdgeHandle, controls: (quad: number) => readonly (readonly number[])[],
    points: readonly MeshControlPoint<Id>[], visible: ReadonlySet<number>, explicitEdges: ReadonlySet<string>,
    index: (id: MeshControlPointId<Id>) => MeshControlPointId<number> | null,
    hidden?: (id: MeshControlPointId<Id>) => boolean,
    edgeHidden?: (a: number, b: number) => boolean,
  ) {
    const adj = meshAdjacency(qmesh), visibleEdges = new Set(explicitEdges);
    for (const quad of visible) {
      const q = qmesh.quads[quad];
      if (!q) continue;
      const [A, B, C, D] = q;
      for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
        if (a !== b) visibleEdges.add(ekey(a, b));
      }
    }
    const brightLines: number[] = [], faintLines: number[] = [];
    const edgeRanges = new Map<string, number>(), quadRanges = new Map<number, number>();
    for (let a = 0; a < adj.neighbors.length; a++) for (const b of adj.neighbors[a]) {
      if (b < a || edgeHidden?.(a, b)) continue;
      const key = ekey(a, b);
      if (!visibleEdges.has(key)) continue;
      edgeRanges.set(key, brightLines.length);
      appendEdgeControlPolygon(brightLines, qmesh, eh, a, b);
      appendEdgeControlPolygon(faintLines, qmesh, eh, a, b);
    }
    for (const quad of visible) {
      quadRanges.set(quad, brightLines.length);
      appendPatchInteriorLattice(brightLines, controls(quad));
      appendPatchInteriorLattice(faintLines, controls(quad));
    }

    const visibleVertices = new Set<number>();
    for (let a = 0; a < adj.neighbors.length; a++) for (const b of adj.neighbors[a]) {
      if (visibleEdges.has(ekey(a, b))) { visibleVertices.add(a); visibleVertices.add(b); }
    }
    const shown = (id: MeshControlPointId<number>) => {
      if (id.kind === 'twist') return visible.has(id.quad);
      if (id.kind === 'edge') return visibleEdges.has(ekey(id.from, id.to));
      return visibleVertices.has(id.vertex);
    };
    const brightPoints: number[] = [], faintPoints: number[] = [], faintCorners: number[] = [];
    const visibleKeys = new Set<string>();
    for (const point of points) {
      if (hidden?.(point.id)) continue;
      const at = index(point.id);
      if (!at || !shown(at)) continue;
      visibleKeys.add(controlPointKey(point.id));
      if (point.id.kind === 'vertex') {
        faintCorners.push(...point.pos); // the ordinary cage already supplies the bright corner pass
      } else {
        brightPoints.push(...point.pos);
        faintPoints.push(...point.pos);
      }
    }
    return { brightLines, faintLines, brightPoints, faintPoints, faintCorners,
      visibleKeys, edgeRanges, quadRanges };
  }

  function applyAuthoredVisibility() {
    const pv = mesh.preview(), doc = mesh.meshDoc();
    if (!pv || !doc) return;
    const visible = new Set(mesh.controlCageQuads()
      .filter(quad => !mesh.controlPointHidden({ kind: 'twist', quad, corner: 0 }))
      .flatMap(quad => quadIndices(doc, [quad])));
    const filtered = filteredSubCage(pv.mesh, pv.edgeHandle,
      quad => quadControlPoints(pv.mesh, pv.edgeHandle, quad, pv.twistOf(quad)),
      authoredControlPoints, visible, pinnedEdges(), id => controlPointIndex(doc, id),
      id => mesh.controlPointHidden(id), (a, b) => mesh.edgeHidden(a, b));
    authoredVisibleControlKeys = filtered.visibleKeys;
    authoredVisibilityReady = true;
    authoredSubCageEdgeRanges.clear();
    for (const [key, offset] of filtered.edgeRanges) authoredSubCageEdgeRanges.set(key, offset);
    authoredSubCageQuadRanges.clear();
    for (const [quad, offset] of filtered.quadRanges) authoredSubCageQuadRanges.set(quad, offset);
    setGeometryPositions(authoredSubCageLineGeometry, filtered.brightLines);
    setGeometryPositions(authoredSubCagePointGeometry, filtered.brightPoints);
    setGeometryPositions(authoredSubCageFaintLineGeometry, filtered.faintLines);
    setGeometryPositions(authoredSubCageFaintPointGeometry, filtered.faintPoints);
    setGeometryPositions(authoredSubCageFaintCornerGeometry, filtered.faintCorners);
  }

  function authoredControlPointVisible<Id>(id: MeshControlPointId<Id>) {
    return id.kind === 'vertex' || authoredVisibilityReady && authoredVisibleControlKeys.has(controlPointKey(id));
  }

  function referenceControlPointVisible(id: MeshControlPointId<number>) {
    return !mesh.refControlPointHidden(id)
      && (id.kind === 'vertex' || refVisibleControlKeys.has(controlPointKey(id)));
  }

  /** Refresh the stable global point list from the already-updated dirty patch cages, then stream its
   * non-corner positions and affected lattice ranges into their shared geometries. */
  function updateAuthoredControlPointCache(quads: Iterable<number>) {
    const pv = mesh.preview(), doc = mesh.meshDoc();
    if (!pv || !doc || !authoredControlPoints.length) return;
    const V = (index: number) => doc.vertexIds[index], Q = (index: number) => doc.quadIds[index];
    const dirty = [...quads];
    const put = (id: MeshControlPointId, pos: V3) => { const item = authoredControlPointByKey.get(controlPointKey(id)); if (item) item.pos = pos; };
    for (const quad of dirty) {
      const q = pv.mesh.quads[quad];
      if (!q) continue;
      const [A, B, C, D] = q, cp = quadControlPoints(pv.mesh, pv.edgeHandle, quad, pv.twistOf(quad));
      put({ kind: 'vertex', vertex: V(A) }, cp[0]); put({ kind: 'vertex', vertex: V(B) }, cp[3]);
      put({ kind: 'vertex', vertex: V(C) }, cp[12]); put({ kind: 'vertex', vertex: V(D) }, cp[15]);
      for (const [k, from, to] of [[1, A, B], [2, B, A], [4, A, C], [7, B, D], [8, C, A], [11, D, B], [13, C, D], [14, D, C]] as [number, number, number][]) {
        put({ kind: 'edge', from: V(from), to: V(to) }, cp[k]);
      }
      for (const [k, corner] of [[5, 0], [6, 1], [9, 2], [10, 3]] as [number, 0 | 1 | 2 | 3][]) put({ kind: 'twist', quad: Q(quad), corner }, cp[k]);
    }
    const attr = authoredSubCagePointGeometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr) {
      const arr = attr.array as Float32Array;
      let p = 0;
      for (const cp of authoredControlPoints) if (cp.id.kind !== 'vertex' && !mesh.controlPointHidden(cp.id)
        && authoredVisibleControlKeys.has(controlPointKey(cp.id))) {
        arr[p++] = cp.pos[0]; arr[p++] = cp.pos[1]; arr[p++] = cp.pos[2];
      }
      attr.needsUpdate = true;
    }
    const cornerAttr = authoredCagePointGeometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (cornerAttr) {
      const arr = cornerAttr.array as Float32Array;
      let p = 0;
      for (const cp of authoredControlPoints) if (cp.id.kind === 'vertex' && !mesh.controlPointHidden(cp.id)) {
        arr[p++] = cp.pos[0]; arr[p++] = cp.pos[1]; arr[p++] = cp.pos[2];
      }
      cornerAttr.needsUpdate = true;
    }

    // The global lattice is one large batch, but its fixed edge (18 floats) and patch-interior (72 floats)
    // ranges let a drag rewrite only its dependency neighborhood instead of rebuilding the mountain-wide set.
    const lineAttr = authoredSubCageLineGeometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!lineAttr) return;
    const lineArray = lineAttr.array as Float32Array, dirtyEdges = new Map<string, [number, number]>();
    for (const quad of dirty) {
      const q = pv.mesh.quads[quad];
      if (!q) continue;
      const quadOffset = authoredSubCageQuadRanges.get(quad);
      if (quadOffset !== undefined) {
        const interior: number[] = [];
        appendPatchInteriorLattice(interior, quadControlPoints(pv.mesh, pv.edgeHandle, quad, pv.twistOf(quad)));
        lineArray.set(interior, quadOffset);
      }
      const [A, B, C, D] = q;
      for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
        if (a === b) continue;
        dirtyEdges.set(ekey(a, b), [a, b]);
      }
    }
    for (const [key, [a, b]] of dirtyEdges) {
      const edgeOffset = authoredSubCageEdgeRanges.get(key);
      if (edgeOffset === undefined) continue;
      const polygon: number[] = [];
      appendEdgeControlPolygon(polygon, pv.mesh, pv.edgeHandle, a, b);
      lineArray.set(polygon, edgeOffset);
    }
    lineAttr.needsUpdate = true;
  }

  /** Keep ordinary corners and extraordinary 3/5-pole dots under the moving surface. The much heavier curved
   * cage-wire rebuild waits for release, but these retained point clouds are cheap to stream each drag frame. */
  function streamCornerDots(vertices: readonly number[]) {
    const stream = (geometry: THREE.BufferGeometry | null, members: readonly number[]) => {
      if (!geometry) return;
      const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
      if (attr.count !== members.length) return;
      const out = attr.array as Float32Array;
      members.forEach((vertex, index) => {
        out[index * 3] = vertices[vertex * 3];
        out[index * 3 + 1] = vertices[vertex * 3 + 1];
        out[index * 3 + 2] = vertices[vertex * 3 + 2];
      });
      attr.needsUpdate = true;
      geometry.boundingBox = null;
      geometry.boundingSphere = null;
    };
    stream(authoredCagePointGeometry, authoredCagePointVertices);
    stream(authoredPole3Geometry, authoredPole3Vertices);
    stream(authoredPole5Geometry, authoredPole5Vertices);
  }

  /** Restore every global cage wire a live-edit preview may have hidden. */
  function showAllWires() {
    for (const child of cageGroup.children) if (child instanceof THREE.LineSegments) child.visible = true;
  }

  /** The retained fixed-size float range of one cage edge's cubic in the global wire buffers (see the
   *  rebuild), so a stable-topology drag rewrites only its dirty curves in place. */
  function edgeRange(key: string) { return cageEdgeRanges.get(key); }

  /** Point the cage-view depth mask at the (re)built terrain geometry, so its occlusion tracks edits. */
  function setDepthMaskGeometry(g: THREE.BufferGeometry) { cageDepthMask.geometry = g; }

  /** Retain the tangent-handle positions for compatibility with the corner-selection flow. Floating controls
   * are exposed through explicitly pinned edge/patch cages, so a normal corner stays dot + gizmo only. */
  function showHandles(corner: V3 | null, nubs: { dir: string; pos: V3 }[]) {
    handleCorner = corner;
    for (const n of nubs) handleNubs[n.dir].position.set(n.pos[0], n.pos[1], -n.pos[2]); // scene-root: negate Z
    applyNubVisibility();
  }

  /** Legacy corner nubs stay hidden: pinned cage points are the direct tangent drag targets. */
  function applyNubVisibility() {
    // Tangent points are part of the pinned sub-cage cloud and are selected directly from those dots.
    // A normal corner pick therefore stays clean: selection dot + gizmo only, with no four-nub fan-out.
    for (const dir of HANDLE_DIRS) handleNubs[dir].visible = false;
    scaleHandleNubs(); // size them for this frame; the render loop keeps them screen-constant after
    rebuildHandleLines();
  }

  /** Hold the visible tangent-handle nubs at a constant few px on screen (HANDLE_NUB_PX radius), re-scaled
   *  every frame — small enough to stay out of the gizmo arrows' way at any zoom. */
  function scaleHandleNubs() {
    if (!handleCorner) return;
    for (const dir of HANDLE_DIRS) {
      const m = handleNubs[dir];
      if (m.visible) m.scale.setScalar(Math.max(1e-4, HANDLE_NUB_PX * stage.worldPerPixel(m.position)));
    }
  }

  function rebuildHandleLines() {
    const pts: THREE.Vector3[] = [];
    if (handleCorner) {
      const cf = new THREE.Vector3(handleCorner[0], handleCorner[1], -handleCorner[2]); // scene-root: negate Z
      for (const dir of HANDLE_DIRS) {
        const m = handleNubs[dir];
        if (m.visible) { pts.push(cf.clone(), m.position.clone()); }
      }
    }
    handleLines.geometry.dispose();
    handleLines.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  /** The tangent-handle nubs currently shown — the pick / hover-gate targets (hidden nubs are unpickable). */
  function visibleNubs(): THREE.Mesh[] {
    return HANDLE_DIRS.map(d => handleNubs[d]).filter(m => m.visible);
  }

  /** Dispose + drop the reference's control-point cloud / net lines. */
  function clearRefCage() {
    for (const group of [refCageGroup, refSubCageGroup]) while (group.children.length) {
      const child = group.children.pop() as THREE.Points | THREE.LineSegments;
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    refVisibleControlKeys.clear();
  }

  /** Build the reference's control lattices + net lines (in the geometry's native coordinates). The
   *  quilt's rim (edges used by a single patch) draws warm, like the authored cage, so it stands out. */
  function buildRefCage(data: ReferenceMesh) {
    const ghost = mesh.wiresOnly(); // cage-wires-only view: dim wires hidden behind the depth mask
    refCageOcclude = !ghost;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(data.cornerPts, 3));
    addCageLines(refCageGroup, data.cornerSeg, CAGE_INTERIOR_COLOR, 0.7, ghost);
    addCageLines(refCageGroup, data.cornerSegBoundary, CAGE_BOUNDARY_COLOR, 0.85, ghost);
    addCageLines(refCageGroup, data.cornerSegTear, CAGE_TEAR_COLOR, 0.95, ghost);
    addCagePoints(refCageGroup, pg, CAGE_POINT_COLOR, 3, ghost);
    // Extraordinary poles (interior-seam valence 3 / 5) replace the green hue without changing point size.
    const cloud = (pts: Float32Array) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pts, 3)); return g; };
    if (data.cornerPtsExtra3.length) addCagePoints(refCageGroup, cloud(data.cornerPtsExtra3), CAGE_EXTRA3_COLOR, 3, ghost, 12);
    if (data.cornerPtsExtra5.length) addCagePoints(refCageGroup, cloud(data.cornerPtsExtra5), CAGE_EXTRA5_COLOR, 3, ghost, 12);
    if (refSubCageActive()) {
      const visible = new Set([...refPinnedQuads()].filter(quad => !mesh.refControlPointHidden({ kind: 'twist', quad, corner: 0 })));
      const explicitEdges = new Set([...refPinnedEdges()].filter(key => {
        const [a, b] = key.split(',').map(Number);
        return !mesh.refEdgeHidden(a, b);
      }));
      const filtered = filteredSubCage(data.mesh, data.edgeHandle, quad => data.patchControls[quad],
        mesh.referenceControlPoints(), visible, explicitEdges, id => id,
        id => mesh.refControlPointHidden(id), (a, b) => mesh.refEdgeHidden(a, b));
      refVisibleControlKeys = filtered.visibleKeys;
      addCageLines(refSubCageGroup, filtered.brightLines, CTRL_CAGE_COLOR, PINNED_CAGE_OPACITY, false, 12);
      addCagePoints(refSubCageGroup,
        new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(filtered.brightPoints), 3)),
        CTRL_CAGE_COLOR, PINNED_CAGE_POINT_PX, false, 12);
      addCageLinesBehind(refSubCageGroup, filtered.faintLines, CTRL_CAGE_COLOR, PINNED_CAGE_OPACITY, 12);
      const faint = new THREE.BufferGeometry().setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(filtered.faintPoints), 3));
      addCagePointsBehind(refSubCageGroup, faint, CTRL_CAGE_COLOR, PINNED_CAGE_POINT_PX, 12);
      const corners = new THREE.BufferGeometry().setAttribute('position',
        new THREE.BufferAttribute(new Float32Array(filtered.faintCorners), 3));
      addCagePointsBehind(refSubCageGroup, corners, CAGE_POINT_COLOR, PINNED_CAGE_POINT_PX, 12);
    }
  }

  function rebuildRefCage() {
    const data = mesh.refData();
    clearRefCage();
    if (data) buildRefCage(data);
    applyRefView();
  }

  /** Hide the reference cage (the reference is unloaded; the group is rebuilt on the next load). */
  function hideRefCage() { refCageGroup.visible = false; refSubCageGroup.visible = false; }

  /** Stand a depth-only mask of the reference solid in for cage-only view, sharing the reference geometry. */
  function setRefDepthMask(g: THREE.BufferGeometry) {
    refCageDepthMask = new THREE.Mesh(g, depthMaskMat); // invisible depth stand-in for cage-only view
    refCageDepthMask.renderOrder = -1;                  // establish ground depth before prop depth masks
    refCageDepthMask.visible = false;                   // applyRefView reveals it in cage-only view
    stage.refRoot.add(refCageDepthMask);
  }

  /** Drop the reference depth mask; it shares the reference solid's geometry (the host disposes that), so
   *  only the mesh goes. */
  function dropRefDepthMask() {
    if (!refCageDepthMask) return;
    stage.refRoot.remove(refCageDepthMask);
    refCageDepthMask = null;
  }

  /** Apply the current view-mode visibilities to the reference cage + its depth mask. */
  function applyRefView() {
    const data = mesh.refData(), has = !!data;
    // the cage's occlusion (and thus its bright/dim ghost split) is baked in at build time, so rebuild it when
    // the shade toggle changes whether a solid surface is there to occlude against
    const occlude = !mesh.wiresOnly();
    if (has && occlude !== refCageOcclude) { clearRefCage(); buildRefCage(data!); }
    refCageGroup.visible = has && cageOn;
    refSubCageGroup.visible = has && cageOn && refSubCageActive();
    // The mask belongs to the no-solid view rather than the cage toggle: reference prop wires below the
    // reference ground need it even when no control-net lines are being drawn.
    if (refCageDepthMask) refCageDepthMask.visible = has && mesh.wiresOnly();
  }

  // depth-only mask (re-pointed at the terrain geometry via setDepthMaskGeometry); shown only in cage-only
  // view so hidden wires dim
  cageDepthMask.visible = false;
  cageDepthMask.renderOrder = -1; // establish ground depth before prop depth masks
  stage.worldRoot.add(cageDepthMask);

  // the read-only reference's control-point cage (geometry filled on load)
  refCageGroup.visible = false;
  stage.refRoot.add(refCageGroup);
  refSubCageGroup.visible = false;
  stage.refRoot.add(refSubCageGroup);

  // the cage is a pure visual, so it rides worldRoot in data coords.
  stage.worldRoot.add(cageGroup);

  // tangent-handle nubs (magenta) + connector lines, revealed on the selected corner (S4)
  const nubGeo = new THREE.SphereGeometry(1, 12, 8);
  for (const dir of HANDLE_DIRS) {
    const m = new THREE.Mesh(nubGeo, new THREE.MeshBasicMaterial({ color: 0xff5cc8, depthTest: false, transparent: true, opacity: 0.95 }));
    m.renderOrder = 13;
    m.visible = false;
    m.userData.dir = dir;
    handleNubs[dir] = m;
    handleGroup.add(m);
  }
  const handleLines = new THREE.LineSegments(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0xff5cc8, depthTest: false, transparent: true, opacity: 0.7 }),
  );
  handleLines.renderOrder = 12;
  handleGroup.add(handleLines);
  stage.scene.add(handleGroup);

  return {
    get cage() { return cageOn; },
    get subCage() { return subCageActive(); },
    get referenceSubCage() { return refSubCageActive(); },
    get authoredControlPoints(): readonly MeshControlPoint[] { return authoredControlPoints; },
    get authoredControlPointByKey(): ReadonlyMap<string, MeshControlPoint> { return authoredControlPointByKey; },
    authoredControlPointVisible, referenceControlPointVisible, authoredQuadCageVisible, authoredEdgeCageVisible,
    setCage, rebuildCage,
    updateAuthoredControlPointCache, streamCornerDots, showAllWires, edgeRange, setDepthMaskGeometry,
    showHandles, scaleHandleNubs, rebuildHandleLines, visibleNubs,
    clearRefCage, buildRefCage, rebuildRefCage, hideRefCage, setRefDepthMask, dropRefDepthMask, applyRefView,
  };
}

export type CageLayer = ReturnType<typeof createCageLayer>;
