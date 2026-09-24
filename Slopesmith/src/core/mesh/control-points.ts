import type { QuadMeshDoc, V3 } from '../doc/types';
import { getVertex, moveVertex } from '../doc/doc-edit';
import {
  buildQuadMesh, meshAdjacency, meshEdgeHandles, meshFromDoc, oppositeNeighbour, quadControlPoints, INTERIOR_CP,
  type MeshAdjacency, type QuadMesh,
} from './topology';
import { meshSetHandle, meshSetTwist } from '../doc/mountain';
import { undirectedEdgeKey } from './primitives';
import { controlPointIsLocked, edgeIsLocked, lockedEdgeSet, lockedVertexSet, quadIsLocked } from './locks';
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
 * interiors relative to the final zero-twist cage. This is the exact sink for rotating mixed point selections.
 *
 * Placed points keep the surface smooth: a tangent's opposite partner swings into line with it
 * (alignOppositeTangent) and an interior's mirrors around its corner follow it (alignCornerTwists), unless the
 * partner is itself a target. `independent` (Alt) skips both — exactly the targets move, creases allowed; the
 * caller pins everything else with captureAround / restoreAround. Points rewritten beyond the targets are
 * appended to `dirty` for the live preview. */
export function setMeshControlPoints(doc: QuadMeshDoc, incoming: readonly MeshControlPointTarget[],
  options: { independent?: boolean; dirty?: EditDirty } = {}): number {
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
  const smooth = !options.independent && !doc.linearCage;
  // Each dragged tangent's length before this edit: its partner scales by the same factor (alignOppositeTangent).
  const before = smooth && targets.some(t => t.kind === 'edge') ? meshFromDoc(doc).edgeHandle : null;
  const previous = new Map(targets.flatMap(t => t.kind === 'edge' && before
    ? [[`${t.from}>${t.to}`, before(t.from, t.to)] as const] : []));
  const placedEdges = new Set<string>();
  for (const t of targets) if (t.kind === 'edge') {
    const p = getVertex(doc, t.from);
    meshSetHandle(doc, t.from, t.to, [t.pos[0] - p[0], t.pos[1] - p[1], t.pos[2] - p[2]]);
    placedEdges.add(`${t.from}>${t.to}`);
  }
  const adj = smooth && targets.some(t => t.kind !== 'vertex')
    ? meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges)) : null;
  if (adj) for (const t of targets) if (t.kind === 'edge') {
    const aligned = alignOppositeTangent(doc, t.from, t.to, previous.get(`${t.from}>${t.to}`)!, adj, placedEdges);
    if (aligned) options.dirty?.edges.push(aligned);
  }
  if (targets.some(t => t.kind === 'twist')) {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    const placedTwists = new Set(targets.flatMap(t => t.kind === 'twist' ? [`${t.quad}:${t.corner}`] : []));
    for (const t of targets) if (t.kind === 'twist') {
      const base = quadControlPoints(mesh, edgeHandle, t.quad)[INTERIOR_CP[t.corner]];
      const was = doc.quadTwist?.[t.quad]?.[t.corner] ?? [0, 0, 0];
      const twist: V3 = [t.pos[0] - base[0], t.pos[1] - base[1], t.pos[2] - base[2]];
      meshSetTwist(doc, t.quad, t.corner, twist);
      if (adj) options.dirty?.quads.push(...alignCornerTwists(doc, t.quad, t.corner,
        [twist[0] - was[0], twist[1] - was[1], twist[2] - was[2]], adj, placedTwists));
    }
  }
  return targets.length;
}

/** Geometry an edit rewrote beyond its own targets, in previewMeshEdit's shape. */
export type EditDirty = { edges: [number, number][]; quads: number[] };

export type MeshVertexMove = {
  vertices: number[];
  /** Every patch touching a moved corner — the dirty set for the live preview. */
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

type VertexMoveContext = {
  vertices: number[];
  quads: number[][];
  freeEdges?: [number, number][];
  mesh: QuadMesh;
  vertQuads: number[][];
};

// A drag changes positions many times but not topology. Keep the corner→patch index beside the document so
// subsequent pointer frames touch only the few incident patches. Weak keys make replaced documents disappear
// naturally; reference checks invalidate if a topology operation swaps a backing array.
const vertexMoveContexts = new WeakMap<QuadMeshDoc, VertexMoveContext>();
function vertexMoveContext(doc: QuadMeshDoc): VertexMoveContext {
  const cached = vertexMoveContexts.get(doc);
  if (cached && cached.vertices === doc.vertices && cached.quads === doc.quads && cached.freeEdges === doc.freeEdges) return cached;
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const vertQuads: number[][] = Array.from({ length: mesh.vertexCount }, () => []);
  for (let quad = 0; quad < mesh.quads.length; quad++) {
    for (const vertex of new Set(mesh.quads[quad])) vertQuads[vertex]?.push(quad);
  }
  const context = { vertices: doc.vertices, quads: doc.quads, freeEdges: doc.freeEdges, mesh, vertQuads };
  vertexMoveContexts.set(doc, context);
  return context;
}

/** Move mesh corners without creasing the surface.
 *
 * A seam is smooth (G1) while the tangents through each corner stay collinear and each patch's interiors keep
 * their offsets from the tangents they are built on. A move therefore writes corners only: automatic tangents
 * re-derive around the new positions, a hand-set tangent keeps its direction and is scaled with its own edge's
 * length (so resizing a shaped patch still resizes its tangents, and an edge moved whole keeps them exactly),
 * and twists are untouched. No override is ever created, so an automatic cage stays automatic.
 */
export function moveMeshVertices(doc: QuadMeshDoc, moving: readonly number[], delta: V3): MeshVertexMove {
  const vertexCount = doc.vertices.length / 3;
  const lockedVertices = lockedVertexSet(doc);
  const vertices = [...new Set(moving)]
    .filter(v => Number.isInteger(v) && v >= 0 && v < vertexCount)
    .filter(v => !lockedVertices.has(v))
    .sort((a, b) => a - b);
  if (!vertices.length || (!delta[0] && !delta[1] && !delta[2])) return { vertices, quads: [], edges: [] };

  const moved = new Set(vertices);
  const { mesh, vertQuads } = vertexMoveContext(doc);
  const affected = new Set<number>();
  for (const vertex of vertices) for (const quad of vertQuads[vertex] ?? []) affected.add(quad);
  const quads = [...affected].sort((a, b) => a - b);
  const edgePairs = new Map<string, [number, number]>();
  const addEdge = (a: number, b: number) => { if (a !== b) edgePairs.set(edgeKey(a, b), a < b ? [a, b] : [b, a]); };
  for (const q of quads) {
    const [A, B, C, D] = mesh.quads[q];
    addEdge(A, B); addEdge(B, D); addEdge(D, C); addEdge(C, A);
  }
  for (const [a, b] of mesh.freeEdges) if (moved.has(a) || moved.has(b)) addEdge(a, b);

  // Only a curve with exactly one moving end changes length; one moved whole (or not at all) keeps its tangents.
  const chord = (a: number, b: number) => Math.sqrt(distSq(getVertex(doc, a), getVertex(doc, b)));
  const resized = [...edgePairs.values()]
    .filter(([a, b]) => moved.has(a) !== moved.has(b))
    .filter(([a, b]) => doc.edgeHandles?.[`${a}>${b}`] || doc.edgeHandles?.[`${b}>${a}`])
    .map(([a, b]) => ({ a, b, before: chord(a, b) }));

  for (const v of vertices) moveVertex(doc, v, delta);

  const lockedEdges = lockedEdgeSet(doc);
  for (const { a, b, before } of resized) {
    const after = chord(a, b);
    if (before < 1e-9 || after < 1e-9 || lockedEdges.has(edgeKey(a, b))) continue;
    const scale = after / before;
    for (const key of [`${a}>${b}`, `${b}>${a}`]) {
      const h = doc.edgeHandles?.[key];
      if (h) doc.edgeHandles![key] = [h[0] * scale, h[1] * scale, h[2] * scale];
    }
  }

  return { vertices, quads, edges: [...edgePairs.values()] };
}

/** Swing the opposite partner of the just-dragged tangent `from→to` into one straight line with it, so the curve
 * through `from` stays smooth — the Bezier-tool convention for dragging a handle. The partner scales by the same
 * factor the dragged tangent's length changed (from `previous`), keeping the pair's length ratio: that ratio must
 * match the far ends of the seams through `from` for them to stay G1 along their length, not just at the corner.
 * Only a corner with a unique opposite edge has a partner (a regular corner, or along a rim); a pole or the inward
 * edge of a rim corner has none. `skip` names directed tangents (`from>to`) placed in the same edit, which are
 * left as the user set them. Returns the partner curve when it was rewritten, else null. */
export function alignOppositeTangent(doc: QuadMeshDoc, from: number, to: number, previous: V3, adj: MeshAdjacency,
  skip: ReadonlySet<string> = new Set()): [number, number] | null {
  const opp = oppositeNeighbour(adj, from, to);
  if (opp === null || skip.has(`${from}>${opp}`) || edgeIsLocked(doc, from, opp)) return null;
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const eh = meshEdgeHandles(mesh, doc.edgeHandles, adj);
  const h = eh(from, to), partner = eh(from, opp);
  const hLen = Math.hypot(h[0], h[1], h[2]), previousLen = Math.hypot(previous[0], previous[1], previous[2]);
  const partnerLen = Math.hypot(partner[0], partner[1], partner[2]) * (previousLen < 1e-9 ? 1 : hLen / previousLen);
  if (hLen < 1e-9 || partnerLen < 1e-9) return null;
  const aligned: V3 = [-h[0] / hLen * partnerLen, -h[1] / hLen * partnerLen, -h[2] / hLen * partnerLen];
  if (distSq(aligned, partner) <= CP_EPS_SQ) return null;
  meshSetHandle(doc, from, opp, aligned);
  return from < opp ? [from, opp] : [opp, from];
}

/** Keep a corner smooth after one of its interiors moved by `delta` (twist change): the interiors of the patches
 * across each seam at that corner mirror it, scaled by the tangent ratio across the seam, and the diagonal patch
 * takes the product — the twist relation that keeps the 3x3 control block around a regular corner a smooth net.
 * A rim corner mirrors across its one shared seam; a pole has no unique partners and is left alone. `skip`
 * names interiors (`quad:corner`) placed in the same edit. Returns the patches rewritten. */
export function alignCornerTwists(doc: QuadMeshDoc, quad: number, corner: 0 | 1 | 2 | 3, delta: V3, adj: MeshAdjacency,
  skip: ReadonlySet<string> = new Set()): number[] {
  if (!delta[0] && !delta[1] && !delta[2]) return [];
  const q = doc.quads[quad];
  const A = q?.[corner];
  if (A === undefined || q.indexOf(A) !== q.lastIndexOf(A)) return [];
  // The corner's two in-patch neighbours, in the [A,B,C,D] layout (A-B / C-D across v, A-C / B-D down u).
  const IN_PATCH: readonly [number, number][] = [[1, 2], [0, 3], [0, 3], [1, 2]];
  const [x, y] = IN_PATCH[corner].map(slot => q[slot]);
  const eh = meshEdgeHandles(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), doc.edgeHandles, adj);
  const ratio = (to: number, opp: number) => {
    const a = eh(A, to), b = eh(A, opp);
    const la = Math.hypot(a[0], a[1], a[2]);
    return la < 1e-9 ? 0 : Math.hypot(b[0], b[1], b[2]) / la;
  };
  const xOpp = oppositeNeighbour(adj, A, x), yOpp = oppositeNeighbour(adj, A, y);
  const across = (a: number, b: number) => (adj.edgeQuads.get(edgeKey(a, b)) ?? []).find(other => other !== quad);
  const patchWith = (a: number, b: number) => (adj.edgeQuads.get(edgeKey(A, a)) ?? [])
    .find(p => (adj.edgeQuads.get(edgeKey(A, b)) ?? []).includes(p));
  const mirrors: [number | undefined, number][] = [];
  // Across seam A-x the neighbour holds A's other axis, so the mirror scales by that axis's ratio.
  if (yOpp !== null) mirrors.push([across(A, x), -ratio(y, yOpp)]);
  if (xOpp !== null) mirrors.push([across(A, y), -ratio(x, xOpp)]);
  if (xOpp !== null && yOpp !== null) mirrors.push([patchWith(xOpp, yOpp), ratio(x, xOpp) * ratio(y, yOpp)]);
  const changed: number[] = [];
  for (const [other, k] of mirrors) {
    if (other === undefined || other === quad || !k) continue;
    const slot = doc.quads[other].indexOf(A) as 0 | 1 | 2 | 3;
    if (slot < 0 || skip.has(`${other}:${slot}`) || quadIsLocked(doc, other)) continue;
    const was = doc.quadTwist?.[other]?.[slot] ?? [0, 0, 0];
    meshSetTwist(doc, other, slot, [was[0] + delta[0] * k, was[1] + delta[1] * k, was[2] + delta[2] * k]);
    changed.push(other);
  }
  return changed;
}

/** Every tangent and interior an edit around `vertices` could disturb, at its effective absolute position: the
 * tangents leaving those corners or their neighbours (an automatic tangent reads its neighbours' positions), and
 * the interiors of every patch touching them. The Alt (independent) edit pins these with restoreAround. */
export type ControlPointSnapshot = {
  handles: { from: number; to: number; pos: V3 }[];
  interiors: { quad: number; corner: 0 | 1 | 2 | 3; pos: V3 }[];
};

export function captureAround(doc: QuadMeshDoc, vertices: readonly number[]): ControlPointSnapshot {
  const snapshot: ControlPointSnapshot = { handles: [], interiors: [] };
  if (doc.linearCage || !vertices.length) return snapshot;
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const adj = meshAdjacency(mesh);
  const ring = new Set(vertices);
  for (const v of vertices) for (const nb of adj.neighbors[v] ?? []) ring.add(nb);
  for (const from of ring) for (const to of adj.neighbors[from] ?? []) {
    const p = getVertex(doc, from), h = edgeHandle(from, to);
    snapshot.handles.push({ from, to, pos: [p[0] + h[0], p[1] + h[1], p[2] + h[2]] });
  }
  mesh.quads.forEach((q, quad) => {
    if (!q.some(v => ring.has(v))) return;
    const cp = quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null);
    for (const corner of [0, 1, 2, 3] as const) snapshot.interiors.push({ quad, corner, pos: cp[INTERIOR_CP[corner]] });
  });
  return snapshot;
}

/** Pin a captured neighbourhood back after an independent edit. A point keeps its absolute position unless
 * everything it is built from moved: a tangent rides along only when both ends of its curve moved (an edge move),
 * an interior only when all four of its patch's corners moved (a patch move). `skip` names, by controlPointKey
 * over live indices, the points the edit placed itself. Sparse: a point already in place gets no override. */
export function restoreAround(
  doc: QuadMeshDoc,
  snapshot: ControlPointSnapshot,
  moved: (vertex: number) => V3 | undefined,
  skip: ReadonlySet<string> = new Set(),
): EditDirty {
  const dirty: EditDirty = { edges: [], quads: [] };
  if (!snapshot.handles.length && !snapshot.interiors.length) return dirty;
  const overrides = (doc.edgeHandles ??= {});
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const edgeHandle = meshEdgeHandles(mesh, overrides); // reads the live override map, so restored tangents count
  const lockedVertices = lockedVertexSet(doc), lockedEdges = lockedEdgeSet(doc);
  const edges = new Map<string, [number, number]>();
  for (const held of snapshot.handles) {
    const id: MeshControlPointId<number> = { kind: 'edge', from: held.from, to: held.to };
    if (skip.has(controlPointKey(id)) || controlPointIsLocked(doc, id, lockedVertices, lockedEdges)) continue;
    const da = moved(held.from), db = moved(held.to);
    const target: V3 = da && db
      ? [0, 1, 2].map(axis => held.pos[axis] + (2 * da[axis] + db[axis]) / 3) as V3
      : held.pos;
    const p = getVertex(doc, held.from), h = edgeHandle(held.from, held.to);
    if (distSq([p[0] + h[0], p[1] + h[1], p[2] + h[2]], target) <= CP_EPS_SQ) continue;
    overrides[`${held.from}>${held.to}`] = [target[0] - p[0], target[1] - p[1], target[2] - p[2]];
    edges.set(edgeKey(held.from, held.to), held.from < held.to ? [held.from, held.to] : [held.to, held.from]);
  }
  if (!Object.keys(overrides).length) doc.edgeHandles = undefined;

  // Interiors re-seat against the final tangents, so they resolve only after every handle above is written.
  const uv: readonly [number, number][] = [[1 / 3, 1 / 3], [1 / 3, 2 / 3], [2 / 3, 1 / 3], [2 / 3, 2 / 3]];
  const quads = new Set<number>();
  for (const held of snapshot.interiors) {
    const id: MeshControlPointId<number> = { kind: 'twist', quad: held.quad, corner: held.corner };
    const corners = mesh.quads[held.quad];
    if (!corners || skip.has(controlPointKey(id)) || controlPointIsLocked(doc, id, lockedVertices, lockedEdges)) continue;
    const ds = corners.map(moved);
    let target = held.pos;
    if (ds.every(d => d !== undefined)) {
      const [u, v] = uv[held.corner], w = [(1 - u) * (1 - v), (1 - u) * v, u * (1 - v), u * v];
      target = [0, 1, 2].map(axis => held.pos[axis] + ds.reduce((sum, d, i) => sum + d![axis] * w[i], 0)) as V3;
    }
    const current = quadControlPoints(mesh, edgeHandle, held.quad, doc.quadTwist?.[held.quad] ?? null)[INTERIOR_CP[held.corner]];
    if (distSq(current, target) <= CP_EPS_SQ) continue;
    const base = quadControlPoints(mesh, edgeHandle, held.quad)[INTERIOR_CP[held.corner]];
    meshSetTwist(doc, held.quad, held.corner, [target[0] - base[0], target[1] - base[1], target[2] - base[2]]);
    quads.add(held.quad);
  }
  dirty.edges = [...edges.values()];
  dirty.quads = [...quads];
  return dirty;
}