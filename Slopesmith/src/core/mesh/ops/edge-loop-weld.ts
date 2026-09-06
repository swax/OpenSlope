import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendPatchFromCorners, type PatchCorners } from './append';
import { ekey, meshContext } from './contract';
import { readVertex } from '../primitives';

export type BoundaryEdgeLoop =
  | { ok: true; vertices: number[] }
  | { ok: false; error: string };

export type EdgeLoopWeldResult =
  | { ok: true; doc: QuadMeshDoc; quads: number[]; triangles: number }
  | { ok: false; error: string };

/**
 * Order one selected closed surface boundary. The edge selection may arrive in any order/direction; the
 * returned vertex cycle is deterministic. Requiring exactly one incident patch per edge prevents an interior
 * loop from being mistaken for an open seam and prevents a free construction ring from acquiring faces by
 * accident.
 */
export function boundaryEdgeLoopVertices(
  doc: QuadMeshDoc,
  edges: readonly (readonly [number, number])[],
): BoundaryEdgeLoop {
  if (edges.length < 3) return { ok: false, error: 'A boundary loop needs at least three selected edges.' };
  const { mesh, adj } = meshContext(doc), count = mesh.vertexCount;
  const neighbors = new Map<number, number[]>(), keys = new Set<string>();
  for (const [a, b] of edges) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= count || b >= count || a === b)
      return { ok: false, error: 'The loop selection contains a stale or invalid edge.' };
    const key = ekey(a, b);
    if (keys.has(key)) return { ok: false, error: 'The loop selection contains the same edge more than once.' };
    keys.add(key);
    if ((adj.edgeQuads.get(key)?.length ?? 0) !== 1)
      return { ok: false, error: 'Weld Loops needs surface boundary edges with exactly one incident patch.' };
    (neighbors.get(a) ?? (neighbors.set(a, []), neighbors.get(a)!)).push(b);
    (neighbors.get(b) ?? (neighbors.set(b, []), neighbors.get(b)!)).push(a);
  }
  if ([...neighbors.values()].some(next => next.length !== 2))
    return { ok: false, error: 'The selected boundary must be one unbranched closed loop.' };
  if (neighbors.size !== edges.length)
    return { ok: false, error: 'The selected edges do not form one simple closed loop.' };

  const start = Math.min(...neighbors.keys()), first = Math.min(...neighbors.get(start)!);
  const vertices = [start];
  let previous = start, current = first;
  while (current !== start) {
    if (vertices.length >= edges.length) return { ok: false, error: 'The selected edges contain separate loops.' };
    vertices.push(current);
    const next = neighbors.get(current)!;
    const onward = next[0] === previous ? next[1] : next[0];
    previous = current;
    current = onward;
  }
  if (vertices.length !== edges.length)
    return { ok: false, error: 'The selected edges contain separate loops.' };
  return { ok: true, vertices };
}

type LoopStep = { corners: PatchCorners; connector: [number, number] };

function loopBreaks(doc: QuadMeshDoc, vertices: readonly number[]): number[] | null {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < vertices.length; i++) {
    const a = readVertex(doc.vertices, vertices[i]), b = readVertex(doc.vertices, vertices[(i + 1) % vertices.length]);
    const length = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (!Number.isFinite(length) || length < 1e-6) return null;
    lengths.push(length); total += length;
  }
  const out = [0];
  let at = 0;
  for (const length of lengths) { at += length; out.push(at / total); }
  out[out.length - 1] = 1;
  return out;
}

/** Cheap phase-search zipper. It advances both loops together whenever possible, so every candidate already
 * has the theoretical maximum `min(n,m)` quads and minimum `abs(n-m)` triangles. Arc length distributes the
 * unavoidable one-sided advances rather than bunching them at the end. */
function greedyMaxQuadLoopSteps(doc: QuadMeshDoc, source: readonly number[], target: readonly number[]): LoopStep[] | null {
  const sb = loopBreaks(doc, source), tb = loopBreaks(doc, target);
  if (!sb || !tb) return null;
  const steps: LoopStep[] = [];
  let i = 0, j = 0;
  if (source.length >= target.length) while (i < source.length) {
    const s0 = source[i % source.length], t0 = target[j % target.length];
    const remainingSource = source.length - i, remainingTarget = target.length - j;
    const mustPair = remainingSource === remainingTarget;
    const pairHere = j < target.length && (mustPair
      || Math.abs(sb[i + 1] - tb[j + 1]) <= Math.abs(sb[Math.min(i + 2, source.length)] - tb[j + 1]));
    if (pairHere) {
      const s1 = source[(i + 1) % source.length], t1 = target[(j + 1) % target.length];
      steps.push({ corners: [s0, s1, t1, t0], connector: [s1, t1] });
      i++; j++;
    } else {
      const s1 = source[(i + 1) % source.length];
      steps.push({ corners: [s0, s1, t0], connector: [s1, t0] });
      i++;
    }
  }
  else while (j < target.length) {
    const s0 = source[i % source.length], t0 = target[j % target.length];
    const remainingSource = source.length - i, remainingTarget = target.length - j;
    const mustPair = remainingSource === remainingTarget;
    const pairHere = i < source.length && (mustPair
      || Math.abs(tb[j + 1] - sb[i + 1]) <= Math.abs(tb[Math.min(j + 2, target.length)] - sb[i + 1]));
    if (pairHere) {
      const s1 = source[(i + 1) % source.length], t1 = target[(j + 1) % target.length];
      steps.push({ corners: [s0, s1, t1, t0], connector: [s1, t1] });
      i++; j++;
    } else {
      const t1 = target[(j + 1) % target.length];
      steps.push({ corners: [s0, t1, t0], connector: [s0, t1] });
      j++;
    }
  }
  return steps;
}

const squaredDistance = (doc: QuadMeshDoc, [a, b]: readonly [number, number]): number => {
  const pa: V3 = readVertex(doc.vertices, a), pb: V3 = readVertex(doc.vertices, b);
  return (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2;
};

/** Refine the winning cyclic phase with a monotone dynamic program. The smaller loop advances only as part
 * of a quad, which proves the result contains the maximum possible number of quads; the DP chooses where the
 * denser loop's remaining triangle advances go by minimum total connector distance. */
function optimalMaxQuadLoopSteps(doc: QuadMeshDoc, source: readonly number[], target: readonly number[]): LoopStep[] | null {
  const n = source.length, m = target.length, width = m + 1;
  const at = (i: number, j: number) => i * width + j;
  const cost = new Float64Array((n + 1) * (m + 1)); cost.fill(Infinity);
  const previous = new Int8Array(cost.length); previous.fill(-1);
  cost[0] = squaredDistance(doc, [source[0], target[0]]);
  const relax = (from: number, to: number, added: number, move: number) => {
    const candidate = cost[from] + added;
    if (candidate < cost[to] - 1e-9) { cost[to] = candidate; previous[to] = move; }
  };

  if (n >= m) {
    for (let i = 0; i < n; i++) for (let j = 0; j <= Math.min(i, m); j++) {
      const from = at(i, j);
      if (!Number.isFinite(cost[from])) continue;
      const s1 = source[(i + 1) % n];
      // A source-only triangle is legal only when enough source edges remain to pair every target edge.
      if (n - (i + 1) >= m - j)
        relax(from, at(i + 1, j), squaredDistance(doc, [s1, target[j % m]]), 1);
      if (j < m)
        relax(from, at(i + 1, j + 1), squaredDistance(doc, [s1, target[(j + 1) % m]]), 2);
    }
  } else {
    for (let j = 0; j < m; j++) for (let i = 0; i <= Math.min(j, n); i++) {
      const from = at(i, j);
      if (!Number.isFinite(cost[from])) continue;
      const t1 = target[(j + 1) % m];
      // A target-only triangle is legal only when enough target edges remain to pair every source edge.
      if (m - (j + 1) >= n - i)
        relax(from, at(i, j + 1), squaredDistance(doc, [source[i % n], t1]), 3);
      if (i < n)
        relax(from, at(i + 1, j + 1), squaredDistance(doc, [source[(i + 1) % n], t1]), 2);
    }
  }
  if (!Number.isFinite(cost[at(n, m)])) return null;

  const moves: number[] = [];
  let i = n, j = m;
  while (i || j) {
    const move = previous[at(i, j)];
    if (move < 0) return null;
    moves.push(move);
    if (move === 1) i--;
    else if (move === 2) { i--; j--; }
    else j--;
  }
  moves.reverse();
  const steps: LoopStep[] = [];
  i = 0; j = 0;
  for (const move of moves) {
    const s0 = source[i % n], t0 = target[j % m];
    if (move === 1) {
      const s1 = source[(i + 1) % n];
      steps.push({ corners: [s0, s1, t0], connector: [s1, t0] }); i++;
    } else if (move === 2) {
      const s1 = source[(i + 1) % n], t1 = target[(j + 1) % m];
      steps.push({ corners: [s0, s1, t1, t0], connector: [s1, t1] }); i++; j++;
    } else {
      const t1 = target[(j + 1) % m];
      steps.push({ corners: [s0, t1, t0], connector: [s0, t1] }); j++;
    }
  }
  return steps;
}

/**
 * Stitch two disjoint closed surface boundaries through the negative space between them. Neither loop moves:
 * the operation finds the least-distance cyclic phase (both target directions, every seam offset), then adds
 * an annular quad/wedge strip. Different vertex counts are intentional and need no destructive resampling.
 */
export function applyEdgeLoopWeld(
  doc: QuadMeshDoc,
  sourceEdges: readonly (readonly [number, number])[],
  targetEdges: readonly (readonly [number, number])[],
): EdgeLoopWeldResult {
  const source = boundaryEdgeLoopVertices(doc, sourceEdges);
  if (!source.ok) return source;
  const target = boundaryEdgeLoopVertices(doc, targetEdges);
  if (!target.ok) return target;
  const sourceSet = new Set(source.vertices);
  if (target.vertices.some(vertex => sourceSet.has(vertex)))
    return { ok: false, error: 'The source and target boundary loops must not share vertices.' };

  let best: { cost: number; steps: LoopStep[]; target: number[] } | null = null;
  const n = target.vertices.length;
  for (const direction of [1, -1]) for (let offset = 0; offset < n; offset++) {
    const ordered = Array.from({ length: n }, (_, i) => target.vertices[(offset + direction * i + n * 2) % n]);
    const steps = greedyMaxQuadLoopSteps(doc, source.vertices, ordered);
    if (!steps) return { ok: false, error: 'A loop contains a zero-length edge and cannot be welded.' };
    const connectors: [number, number][] = [[source.vertices[0], ordered[0]], ...steps.map(step => step.connector)];
    const cost = connectors.reduce((sum, edge) => sum + squaredDistance(doc, edge), 0) / connectors.length;
    if (!best || cost < best.cost - 1e-9) best = { cost, steps, target: ordered };
  }
  if (!best) return { ok: false, error: 'Weld Loops could not align the two boundaries.' };
  const steps = optimalMaxQuadLoopSteps(doc, source.vertices, best.target) ?? best.steps;

  let out = doc;
  const quads: number[] = [];
  let triangles = 0;
  for (const step of steps) {
    const appended = appendPatchFromCorners(out, step.corners);
    if (!appended.ok) return { ok: false, error: `Weld Loops could not close this gap: ${appended.error}` };
    out = appended.doc;
    quads.push(appended.quad);
    if (step.corners.length === 3) triangles++;
  }
  return { ok: true, doc: out, quads, triangles };
}
