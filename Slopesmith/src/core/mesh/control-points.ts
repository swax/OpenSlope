import type { QuadMeshDoc, V3 } from '../doc/types';
import { getVertex, moveVertex } from '../doc/doc-edit';
import { buildQuadMesh, meshEdgeHandles, meshFromDoc, quadControlPoints, INTERIOR_CP, type EdgeHandle, type QuadMesh } from './topology';
import { meshSetHandle, meshSetTwist } from '../doc/mountain';
import { undirectedEdgeKey } from './primitives';
import { controlPointIsLocked, lockedEdgeSet, lockedVertexSet } from './locks';
import type { MeshControlPointId } from './control-point-types';

export type { MeshControlPointId } from './control-point-types';

/** A stable identity for every authored bicubic control point.
 *
 * Corners are shared mesh vertices, boundary points are directed-edge handles (the handle owned by `from`
 * on the curve toward `to`), and the four floating interior points belong to one quad corner. This is the
 * common vocabulary used by the sub-cage renderer, point picking and batch transforms.
 *
 * The names it carries are the document's own stable vertex and quad ids (docs/039), so a sub-cage pinned
 * before a topology edit still names the same tangent afterwards. The read-only reference instantiates it
 * over indices instead — that mesh is rebuilt by position-dedup on every load and never edited, so its
 * numbering is its identity. */
export type MeshControlPoint<Id = string> = {
  id: MeshControlPointId<Id>;
  pos: V3;
  /** Vertex whose surface frame/ownership applies to this point, as an index into the mesh this list was
   *  derived from — a rendering detail of the same rebuild, never held across one. */
  anchorVertex: number;
};

export type MeshControlPointTarget<Id = string> = { id: MeshControlPointId<Id>; pos: V3 };

export function controlPointKey<Id>(id: MeshControlPointId<Id>): string {
  if (id.kind === 'vertex') return `v:${String(id.vertex)}`;
  if (id.kind === 'edge') return `e:${String(id.from)}>${String(id.to)}`;
  return `t:${String(id.quad)}:${id.corner}`;
}

/** The smallest control cages that explain a set of directly-selected floating points. A boundary tangent
 * belongs to its cubic edge; an interior twist belongs to its 4x4 patch. Corners need no extra reveal because
 * they already sit on the ordinary mesh cage. Owners are de-duplicated so selecting both directed tangents of
 * one edge, or several interiors of one patch, draws that cage only once. */
export function controlPointCageOwners<Id>(ids: readonly MeshControlPointId<Id>[]): { edges: [Id, Id][]; quads: Id[] } {
  const edges = new Map<string, [Id, Id]>(), quads = new Map<string, Id>();
  const undirected = (a: Id, b: Id) => String(a) < String(b) ? `${String(a)},${String(b)}` : `${String(b)},${String(a)}`;
  for (const id of ids) {
    if (id.kind === 'edge') edges.set(undirected(id.from, id.to), [id.from, id.to]);
    else if (id.kind === 'twist') quads.set(String(id.quad), id.quad);
  }
  return { edges: [...edges.values()], quads: [...quads.values()] };
}

/** Enumerate every UNIQUE point in a quad document: shared corners once, each directed boundary handle once,
 * and every patch's four interior points, each named by the document's own stable ids. Positions are the
 * exact points used by preview/export. */
export function meshControlPoints(doc: QuadMeshDoc): MeshControlPoint[] {
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const out: MeshControlPoint[] = [];
  const V = (index: number) => doc.vertexIds[index], Q = (index: number) => doc.quadIds[index];
  for (let vertex = 0; vertex < mesh.vertices.length / 3; vertex++) {
    out.push({ id: { kind: 'vertex', vertex: V(vertex) }, pos: getVertex(doc, vertex), anchorVertex: vertex });
  }

  const directed = new Set<string>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    for (const [from, to] of [[a, b], [b, a]] as [number, number][]) {
      const key = `${from}>${to}`;
      if (directed.has(key)) continue;
      directed.add(key);
      const p = getVertex(doc, from), h = edgeHandle(from, to);
      out.push({ id: { kind: 'edge', from: V(from), to: V(to) }, pos: [p[0] + h[0], p[1] + h[1], p[2] + h[2]], anchorVertex: from });
    }
  };
  for (const q of mesh.quads) {
    const [A, B, C, D] = q;
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      addEdge(a, b); // a wedge's collapsed side is skipped by addEdge
    }
  }
  for (const [a, b] of mesh.freeEdges) addEdge(a, b);

  for (let quad = 0; quad < mesh.quads.length; quad++) {
    const q = mesh.quads[quad];
    const cp = quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null);
    for (let corner = 0 as 0 | 1 | 2 | 3; corner < 4; corner = (corner + 1) as 0 | 1 | 2 | 3) {
      out.push({ id: { kind: 'twist', quad: Q(quad), corner }, pos: cp[INTERIOR_CP[corner]], anchorVertex: q[corner] });
    }
  }
  return out;
}

/** Translate an arbitrary control-point set exactly. Targets are snapshotted first; then corners, boundary
 * handles and interiors are written in dependency order. Thus selecting a whole 4x4 cage translates every
 * point once (moving a corner cannot accidentally double-move its selected tangent/interior points), while a
 * lone tangent or interior point deforms only that part of the cage. Returns the number of valid points moved. */
export function moveMeshControlPoints(doc: QuadMeshDoc, ids: readonly MeshControlPointId[], delta: V3): number {
  const selected = new Map(ids.map(id => [controlPointKey(id), id]));
  if (!selected.size || (!delta[0] && !delta[1] && !delta[2])) return 0;
  const live = new Map(meshControlPoints(doc).map(cp => [controlPointKey(cp.id), cp]));
  const targets = [...selected].flatMap(([key, id]) => {
    const cp = live.get(key);
    return cp ? [{ id, pos: [cp.pos[0] + delta[0], cp.pos[1] + delta[1], cp.pos[2] + delta[2]] as V3 }] : [];
  });

  return setMeshControlPoints(doc, targets);
}

/** Place an arbitrary authored control-point set at absolute positions. Writes follow the same dependency order
 * as batch translation: corners first, directed boundary handles relative to their possibly moved owners, then
 * interiors relative to the final zero-twist cage. This is the exact sink for rotating mixed point selections. */
export function setMeshControlPoints(doc: QuadMeshDoc, incoming: readonly MeshControlPointTarget[]): number {
  // A target naming geometry this document no longer carries is dropped: the point it addressed is gone, so
  // there is nothing to place and nothing to say about it (docs/039 tombstones).
  const vertexAt = new Map(doc.vertexIds.map((id, index) => [id, index]));
  const quadAt = new Map(doc.quadIds.map((id, index) => [id, index]));
  const lockedVertices = lockedVertexSet(doc), lockedEdges = lockedEdgeSet(doc);
  type Placed =
    | { kind: 'vertex'; vertex: number; pos: V3 }
    | { kind: 'edge'; from: number; to: number; pos: V3 }
    | { kind: 'twist'; quad: number; corner: 0 | 1 | 2 | 3; pos: V3 };
  const targets = [...new Map(incoming.map(t => [controlPointKey(t.id), t])).values()].flatMap((t): Placed[] => {
    if (!t.pos.every(Number.isFinite)) return [];
    if (t.id.kind === 'vertex') {
      const vertex = vertexAt.get(t.id.vertex);
      return vertex === undefined || controlPointIsLocked(doc, { kind: 'vertex', vertex }, lockedVertices, lockedEdges)
        ? [] : [{ kind: 'vertex', vertex, pos: t.pos }];
    }
    if (t.id.kind === 'edge') {
      const from = vertexAt.get(t.id.from), to = vertexAt.get(t.id.to);
      return from === undefined || to === undefined || from === to
        || controlPointIsLocked(doc, { kind: 'edge', from, to }, lockedVertices, lockedEdges)
        ? [] : [{ kind: 'edge', from, to, pos: t.pos }];
    }
    const quad = quadAt.get(t.id.quad);
    return quad === undefined || t.id.corner < 0 || t.id.corner > 3
      || controlPointIsLocked(doc, { kind: 'twist', quad, corner: t.id.corner }, lockedVertices, lockedEdges)
      ? [] : [{ kind: 'twist', quad, corner: t.id.corner, pos: t.pos }];
  });
  for (const t of targets) if (t.kind === 'vertex') {
    const i = t.vertex * 3;
    doc.vertices[i] = t.pos[0]; doc.vertices[i + 1] = t.pos[1]; doc.vertices[i + 2] = t.pos[2];
  }
  for (const t of targets) if (t.kind === 'edge') {
    const p = getVertex(doc, t.from);
    meshSetHandle(doc, t.from, t.to, [t.pos[0] - p[0], t.pos[1] - p[1], t.pos[2] - p[2]]);
  }
  if (targets.some(t => t.kind === 'twist')) {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    for (const t of targets) if (t.kind === 'twist') {
      const base = quadControlPoints(mesh, edgeHandle, t.quad)[INTERIOR_CP[t.corner]];
      meshSetTwist(doc, t.quad, t.corner, [t.pos[0] - base[0], t.pos[1] - base[1], t.pos[2] - base[2]]);
    }
  }
  return targets.length;
}

export type ProportionalVertexMove = {
  vertices: number[];
  /** Every patch whose 4x4 cage was proportionally deformed. */
  quads: number[];
  /** Every boundary curve belonging to those patches (canonical endpoint order). */
  edges: [number, number][];
};

const CP_EPS_SQ = 1e-16;
const edgeKey = undirectedEdgeKey;
const distSq = (a: V3, b: V3) => {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
  return x * x + y * y + z * z;
};

type ProportionalMoveContext = {
  vertices: number[];
  quads: number[][];
  freeEdges?: [number, number][];
  mesh: QuadMesh;
  edgeHandle: EdgeHandle;
  /** Mutable map captured by edgeHandle, including when the document started with no sparse overrides. */
  overrides: Record<string, V3>;
  vertQuads: number[][];
};

// A drag changes positions many times but not topology. Keep the derived adjacency/handle provider beside the
// document so subsequent pointer frames touch only the few incident patches. Weak keys make replaced documents
// disappear naturally; reference checks invalidate if a topology operation swaps either backing array.
const proportionalMoveContexts = new WeakMap<QuadMeshDoc, ProportionalMoveContext>();
function proportionalMoveContext(doc: QuadMeshDoc): ProportionalMoveContext {
  const cached = proportionalMoveContexts.get(doc);
  const handlesCompatible = cached && (doc.edgeHandles === cached.overrides
    || (doc.edgeHandles === undefined && Object.keys(cached.overrides).length === 0));
  if (cached && cached.vertices === doc.vertices && cached.quads === doc.quads
    && cached.freeEdges === doc.freeEdges && handlesCompatible) return cached;

  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const overrides = doc.edgeHandles ?? {};
  const vertQuads: number[][] = Array.from({ length: mesh.vertexCount }, () => []);
  for (let quad = 0; quad < mesh.quads.length; quad++) {
    for (const vertex of new Set(mesh.quads[quad])) vertQuads[vertex]?.push(quad);
  }
  const context = { vertices: doc.vertices, quads: doc.quads, freeEdges: doc.freeEdges, mesh, overrides, vertQuads,
    edgeHandle: meshEdgeHandles(mesh, overrides) };
  proportionalMoveContexts.set(doc, context);
  return context;
}

/** Move mesh corners while deforming every affected bicubic cage proportionally.
 *
 * A plain corner-only write leaves an authored tangent offset numerically unchanged. That makes the control
 * point nearest a moved edge travel too far (or not far enough) when the edge resizes. Here the displacement
 * over each affected patch is the bilinear interpolation of its four corner displacements. Consequently a
 * moved edge travels 100%, its adjacent control row 2/3, the next row 1/3, and the opposite edge 0% — exactly
 * the proportions of a 4x4 Bezier cage. Effective boundary/interior points are snapshotted before the corner
 * write and then re-encoded as sparse edge-handle / twist offsets afterward.
 *
 * Automatic handles stay automatic whenever their newly derived position already equals the proportional
 * target. An override is introduced only where the automatic Bessel result would otherwise move a control
 * point away from that target. This keeps a simple free patch sparse while preserving shaped connected cages.
 */
export function moveMeshVerticesProportional(
  doc: QuadMeshDoc,
  moving: readonly number[],
  delta: V3,
): ProportionalVertexMove {
  const vertexCount = doc.vertices.length / 3;
  const lockedVertices = lockedVertexSet(doc);
  const vertices = [...new Set(moving)]
    .filter(v => Number.isInteger(v) && v >= 0 && v < vertexCount)
    .filter(v => !lockedVertices.has(v))
    .sort((a, b) => a - b);
  if (!vertices.length || (!delta[0] && !delta[1] && !delta[2])) return { vertices, quads: [], edges: [] };

  const moved = new Set(vertices);
  const d = (v: number): V3 => moved.has(v) ? delta : [0, 0, 0];
  const { mesh, edgeHandle, overrides, vertQuads } = proportionalMoveContext(doc);
  const affected = new Set<number>();
  for (const vertex of vertices) for (const quad of vertQuads[vertex] ?? []) affected.add(quad);
  const quads = [...affected].sort((a, b) => a - b);
  const edgePairs = new Map<string, [number, number]>();

  for (const q of quads) {
    const [A, B, C, D] = mesh.quads[q];
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      if (a === b) continue;
      const pair: [number, number] = a < b ? [a, b] : [b, a];
      edgePairs.set(edgeKey(a, b), pair);
    }
  }

  // Capture the exact effective points, not merely sparse offsets: an automatic Bessel point is still part of
  // the visible 4x4 cage and must land at the same proportional target as a hand-pulled point.
  const edgeTargets: { from: number; to: number; pos: V3; explicit: boolean }[] = [];
  for (const [a, b] of edgePairs.values()) {
    const pa = getVertex(doc, a), pb = getVertex(doc, b), da = d(a), db = d(b);
    const hab = edgeHandle(a, b), hba = edgeHandle(b, a);
    edgeTargets.push(
      {
        from: a, to: b,
        pos: [pa[0] + hab[0] + (2 * da[0] + db[0]) / 3, pa[1] + hab[1] + (2 * da[1] + db[1]) / 3, pa[2] + hab[2] + (2 * da[2] + db[2]) / 3],
        explicit: overrides[`${a}>${b}`] !== undefined,
      },
      {
        from: b, to: a,
        pos: [pb[0] + hba[0] + (2 * db[0] + da[0]) / 3, pb[1] + hba[1] + (2 * db[1] + da[1]) / 3, pb[2] + hba[2] + (2 * db[2] + da[2]) / 3],
        explicit: overrides[`${b}>${a}`] !== undefined,
      },
    );
  }

  const uv: readonly [number, number][] = [[1 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 1 / 3], [2 / 3, 2 / 3]];
  const interiorTargets = quads.map(quad => {
    const corners = mesh.quads[quad], cp = quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null);
    const ds = corners.map(d);
    return {
      quad,
      explicit: doc.quadTwist?.[quad] !== undefined,
      pos: uv.map(([u, v], corner) => {
        const wA = (1 - u) * (1 - v), wB = (1 - u) * v, wC = u * (1 - v), wD = u * v;
        const move: V3 = [
          ds[0][0] * wA + ds[1][0] * wB + ds[2][0] * wC + ds[3][0] * wD,
          ds[0][1] * wA + ds[1][1] * wB + ds[2][1] * wC + ds[3][1] * wD,
          ds[0][2] * wA + ds[1][2] * wB + ds[2][2] * wC + ds[3][2] * wD,
        ];
        const p = cp[INTERIOR_CP[corner]];
        return [p[0] + move[0], p[1] + move[1], p[2] + move[2]] as V3;
      }),
    };
  });

  for (const v of vertices) moveVertex(doc, v, delta);

  // Compare against the post-corner automatic result first. Do not materialise an override when the derived
  // handle already lands exactly where the proportional cage asks it to.
  let handlesChanged = false;
  for (const target of edgeTargets) {
    const p = getVertex(doc, target.from), h = edgeHandle(target.from, target.to);
    const current: V3 = [p[0] + h[0], p[1] + h[1], p[2] + h[2]];
    if (target.explicit || distSq(current, target.pos) > CP_EPS_SQ) {
      overrides[`${target.from}>${target.to}`] = [target.pos[0] - p[0], target.pos[1] - p[1], target.pos[2] - p[2]];
      handlesChanged = true;
    }
  }
  if (handlesChanged && doc.edgeHandles !== overrides) doc.edgeHandles = overrides;

  // Boundary writes change each Ferguson interior base, so resolve that base only after every edge target is in
  // place. Existing sculpt tuples remain explicit; an untouched zero-twist patch stays sparse when it matches.
  for (const target of interiorTargets) {
    const base = quadControlPoints(mesh, edgeHandle, target.quad);
    for (let corner = 0; corner < 4; corner++) {
      const p = base[INTERIOR_CP[corner]], wanted = target.pos[corner];
      if (target.explicit || distSq(p, wanted) > CP_EPS_SQ) {
        meshSetTwist(doc, target.quad, corner, [wanted[0] - p[0], wanted[1] - p[1], wanted[2] - p[2]]);
      }
    }
  }

  return { vertices, quads, edges: [...edgePairs.values()] };
}
