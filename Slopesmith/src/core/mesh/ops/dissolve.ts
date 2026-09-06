import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from '../../doc/types';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import { ekey, isValidCell, checkManifold, finishMeshRewrite, looseVertexIds } from './contract';
import type { MeshDeleteSelection } from './delete';
import { readVertex } from '../primitives';

/**
 * Dissolve: merges a connected region — an interior edge's two patches, or a vertex's whole incident fan —
 * back into one quad. A boundary with more than four points is reduced to its four strongest corners; skipped
 * points that remain in neighboring patches intentionally become visible T-junctions.
 */

/** Merge a connected region into one quad. For an n-sided boundary, retain the four vertices with the strongest
 * tangent turn and skip the straighter intermediate points. On a regular grid this turns a six-point two-cell
 * rectangle into its four outside corners, and an eight-point point fan into its four diagonal corners. */
function dissolvedRegionQuad(doc: QuadMeshDoc, cells: readonly number[]): {
  quad: number[]; handles: Record<string, V3>; junctions: EdgeEmbeddedTJunction[];
} | null {
  const edges = new Map<string, { count: number; from: number; to: number }>();
  for (const cell of cells) {
    const q = doc.quads[cell];
    if (!q || !isValidCell(q)) return null;
    const cycle = new Set(q).size === 3 ? [q[0], q[1], q[2]] : [q[0], q[1], q[3], q[2]];
    for (let i = 0; i < cycle.length; i++) {
      const from = cycle[i], to = cycle[(i + 1) % cycle.length], key = ekey(from, to), prior = edges.get(key);
      if (prior) prior.count++; else edges.set(key, { count: 1, from, to });
    }
  }
  const boundary = [...edges.values()].filter(edge => edge.count === 1);
  const next = new Map<number, number>();
  for (const edge of boundary) {
    if (next.has(edge.from)) return null;
    next.set(edge.from, edge.to);
  }
  if (!boundary.length) return null;
  const cycle: number[] = [];
  let vertex = boundary[0].from;
  for (let i = 0; i < boundary.length; i++) {
    cycle.push(vertex);
    const following = next.get(vertex);
    if (following === undefined) return null;
    vertex = following;
  }
  if (vertex !== cycle[0]) return null;
  if (cycle.length < 4 || new Set(cycle).size !== cycle.length) return null;
  let keptIndices = cycle.map((_, index) => index);
  let handle: ReturnType<typeof meshEdgeHandles> | null = null;
  if (cycle.length > 4) {
    const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
    const localHandle = meshEdgeHandles(mesh, doc.edgeHandles);
    handle = localHandle;
    const turn = (index: number) => {
      const v = cycle[index], previous = cycle[(index + cycle.length - 1) % cycle.length], next = cycle[(index + 1) % cycle.length];
      const a = localHandle(v, previous), b = localHandle(v, next);
      const al = Math.hypot(a[0], a[1], a[2]), bl = Math.hypot(b[0], b[1], b[2]);
      if (al < 1e-9 || bl < 1e-9) return 0;
      // Straight-through boundary tangents point opposite (dot = -1 → score 0); a 90° corner scores 1.
      return 1 + Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl)));
    };
    keptIndices = cycle.map((_, index) => ({ index, turn: turn(index) }))
      .sort((a, b) => b.turn - a.turn || a.index - b.index).slice(0, 4)
      .sort((a, b) => a.index - b.index).map(item => item.index);
  }
  const corners = keptIndices.map(index => cycle[index]);
  if (new Set(corners).size !== 4) return null;

  // A new long side must still pass through the skipped boundary points; otherwise Dissolve would create a
  // gap rather than a T-junction. Fit its two cubic controls to those points (one/two are exact; larger arcs
  // use least squares), starting from the old endpoint tangents scaled to the full chain length.
  const handles: Record<string, V3> = {};
  const junctions: EdgeEmbeddedTJunction[] = [];
  const P = (id: number): V3 => readVertex(doc.vertices, id);
  const distance = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (let side = 0; side < 4; side++) {
    const fromIndex = keptIndices[side], toIndex = keptIndices[(side + 1) % 4];
    const chain: number[] = [cycle[fromIndex]];
    for (let index = (fromIndex + 1) % cycle.length; index !== toIndex; index = (index + 1) % cycle.length) chain.push(cycle[index]);
    chain.push(cycle[toIndex]);
    if (chain.length <= 2 || !handle) continue;
    const cumulative = [0];
    for (let i = 1; i < chain.length; i++) cumulative.push(cumulative[i - 1] + distance(P(chain[i - 1]), P(chain[i])));
    const total = cumulative[cumulative.length - 1];
    if (total < 1e-9) continue;
    const p0 = P(chain[0]), p3 = P(chain[chain.length - 1]);
    const firstLength = Math.max(1e-9, cumulative[1]), lastLength = Math.max(1e-9, total - cumulative[cumulative.length - 2]);
    const h0 = handle(chain[0], chain[1]), h3 = handle(chain[chain.length - 1], chain[chain.length - 2]);
    const q1: V3 = [p0[0] + h0[0] * total / firstLength, p0[1] + h0[1] * total / firstLength, p0[2] + h0[2] * total / firstLength];
    const q2: V3 = [p3[0] + h3[0] * total / lastLength, p3[1] + h3[1] * total / lastLength, p3[2] + h3[2] * total / lastLength];
    const samples = chain.slice(1, -1).map((vertex, i) => ({ point: P(vertex), t: cumulative[i + 1] / total }));
    for (let i = 1; i < chain.length - 1; i++)
      junctions.push({ vertex: chain[i], edge: [chain[0], chain[chain.length - 1]], t: cumulative[i] / total });
    for (let axis = 0; axis < 3; axis++) {
      let aa = 1e-9, ab = 0, bb = 1e-9, ar = 1e-9 * q1[axis], br = 1e-9 * q2[axis];
      for (const sample of samples) {
        const s = 1 - sample.t;
        const a = 3 * s * s * sample.t, b = 3 * s * sample.t * sample.t;
        const rhs = sample.point[axis] - s * s * s * p0[axis] - sample.t * sample.t * sample.t * p3[axis];
        aa += a * a; ab += a * b; bb += b * b; ar += a * rhs; br += b * rhs;
      }
      const det = aa * bb - ab * ab;
      if (Math.abs(det) > 1e-15) {
        q1[axis] = (ar * bb - br * ab) / det;
        q2[axis] = (br * aa - ar * ab) / det;
      }
    }
    const start = chain[0], end = chain[chain.length - 1];
    handles[`${start}>${end}`] = [q1[0] - p0[0], q1[1] - p0[1], q1[2] - p0[2]];
    handles[`${end}>${start}`] = [q2[0] - p3[0], q2[1] - p3[1], q2[2] - p3[2]];
  }
  return { quad: [corners[0], corners[1], corners[3], corners[2]], handles, junctions };
}

/** Dissolve selected interior edges or vertices while preserving one surface patch. Intermediate boundary
 * points may be skipped; any still owned by neighboring patches become explicit edge-embedded T-junctions. */
export function applyMeshDissolve(doc: QuadMeshDoc, selection: Pick<MeshDeleteSelection, 'vertices' | 'edges'>):
  { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  const vertices = [...new Set(selection.vertices ?? [])], edges = selection.edges ?? [];
  if (!!vertices.length === !!edges.length) return { ok: false, error: 'Dissolve either points or edges, not both.' };
  const adj = meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges));
  const regions: { cells: number[]; merged: number[]; handles: Record<string, V3>; junctions: EdgeEmbeddedTJunction[] }[] = [];
  if (edges.length) {
    for (const [a, b] of edges) {
      const cells = adj.edgeQuads.get(ekey(a, b)) ?? [];
      if (cells.length !== 2) return { ok: false, error: 'Dissolve Edge needs interior surface edges with a patch on both sides.' };
      const merged = dissolvedRegionQuad(doc, cells);
      if (!merged) return { ok: false, error: 'Those adjacent patches do not reduce to four distinct outer corners.' };
      regions.push({ cells: [...cells], merged: merged.quad, handles: merged.handles, junctions: merged.junctions });
    }
  } else {
    for (const vertex of vertices) {
      const cells = doc.quads.flatMap((q, i) => q.includes(vertex) ? [i] : []);
      if (cells.length < 2 || (doc.freeEdges ?? []).some(([a, b]) => a === vertex || b === vertex))
        return { ok: false, error: 'Dissolve Point needs a connected surface fan and no attached free edge.' };
      const merged = dissolvedRegionQuad(doc, cells);
      if (!merged) return { ok: false, error: 'That point’s complete patch fan does not reduce to four distinct outer corners.' };
      regions.push({ cells, merged: merged.quad, handles: merged.handles, junctions: merged.junctions });
    }
  }
  const claimed = new Set<number>();
  for (const region of regions) for (const cell of region.cells) {
    if (claimed.has(cell)) return { ok: false, error: 'The dissolve regions overlap; dissolve them separately.' };
    claimed.add(cell);
  }
  const quads: (number[] | null)[] = doc.quads.map(q => q.slice());
  const quadTwist = doc.quadTwist ? { ...doc.quadTwist } : undefined;
  const quadLabels = doc.quadLabels ? Object.fromEntries(Object.entries(doc.quadLabels)
    .map(([quad, labels]) => [quad, [...labels]])) : undefined;
  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  for (const region of regions) {
    const survivor = Math.min(...region.cells);
    quads[survivor] = region.merged;
    for (const cell of region.cells) {
      if (cell !== survivor) quads[cell] = null;
      if (quadTwist) delete quadTwist[cell];
    }
    if (quadLabels) {
      const union = [...new Set(region.cells.flatMap(cell => quadLabels[cell] ?? []))].sort();
      if (union.length) quadLabels[survivor] = union; else delete quadLabels[survivor];
    }
    Object.assign(edgeHandles, region.handles);
  }
  const guard = checkManifold(quads.filter((q): q is number[] => q !== null));
  if (!guard.ok) return { ok: false, error: guard.error! };
  const { doc: out } = finishMeshRewrite(doc, {
    vertices: doc.vertices.slice(), quads, keepVertices: looseVertexIds(doc), freeEdges: doc.freeEdges,
    tJunctions: [...(doc.tJunctions ?? []), ...regions.flatMap(region => region.junctions)],
    edgeHandles: Object.keys(edgeHandles).length ? edgeHandles : undefined,
    quadPaint: doc.quadPaint ? { ...doc.quadPaint } : undefined,
    quadTex: doc.quadTex ? { ...doc.quadTex } : undefined,
    quadOrient: doc.quadOrient ? { ...doc.quadOrient } : undefined,
    quadLocked: doc.quadLocked ? { ...doc.quadLocked } : undefined,
    quadTwist,
    quadLabels,
  });
  return { ok: true, doc: out };
}
