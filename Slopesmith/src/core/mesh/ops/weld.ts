import type { QuadMeshDoc, V3 } from '../../doc/types';
import { cubicPoint, nearestCubicT } from '../../math/bezier';
import { add } from '../../math/vec';
import { normalizeTJunctions } from '../t-junctions';
import { directedEdgeKey, quadPerimeterEdges, readVertex } from '../primitives';
import { ekey, checkManifold, finishMeshRewrite, looseVertexIds, meshContext, quadEdges } from './contract';

/**
 * Vertex and edge welds — the surface-constrained slide's terminal state (slide.ts): fuse vertex pairs
 * through a union-find whose group root is the survivor, fold each rewritten cell into a quad or a legal
 * wedge, and stitch equal-size edge sets in one atomic weld.
 */

/**
 * The perimeter CYCLE of a stored quad `[a,b,c,d]` — `(a, b, d, c)`, the order its four boundary edges walk.
 * Storage reads back off a cycle `[P0,P1,P2,P3]` as `[P0, P1, P3, P2]` (the same swap, its own inverse).
 */
const quadCycle = (c: number[]): number[] => [c[0], c[1], c[3], c[2]];

/**
 * Fold a quad whose corners have just been rewritten (by a weld) into the canonical form, or say why it can't:
 *  - 4 distinct corners → unchanged (a renamed corner keeps its storage slot, so `quadTwist` still lines up).
 *  - 3 distinct → a WEDGE. The legal encoding `[A,B,C,C]` has the fused pair at the CYCLE's last two positions
 *    (storage `[A,B,C,C]` ⇒ cycle `(A,B,C,C)`), so rotate the cycle until the fused pair sits at positions
 *    2,3 — by `(i+2) mod 4` for a fused pair at cycle index `i` — and read the storage back off it. In storage
 *    terms: fused `(a,b)` → `[d,c,a,a]`; `(b,d)` → `[c,a,b,b]`; `(d,c)` → `[a,b,c,c]` (already canonical);
 *    `(c,a)` → `[b,d,a,a]`. Each is a cyclic relabel, so the winding — and the skyward normal — is preserved.
 *  - 3 distinct but the fused pair is a cycle DIAGONAL (storage `a===d` or `b===c`) → `null`: the quad
 *    primitive has no encoding for a diagonal collapse, so the caller must reject rather than emit a bowtie.
 *  - ≤2 distinct → `'drop'`: the whole cell collapsed.
 */
function weldCell(c: number[]): number[] | 'drop' | null {
  const n = new Set(c).size;
  if (n === 4) return c;
  if (n <= 2) return 'drop';
  const cyc = quadCycle(c);
  if (cyc[0] === cyc[2] || cyc[1] === cyc[3]) return null; // the fused pair is a diagonal of the cycle
  let i = -1;
  for (let k = 0; k < 4; k++) if (cyc[k] === cyc[(k + 1) % 4]) { i = k; break; }
  if (i < 0) return null; // unreachable: 3 distinct with no adjacent and no diagonal pair
  const rot = (i + 2) % 4;
  const p = [0, 1, 2, 3].map(j => cyc[(j + rot) % 4]);
  return [p[0], p[1], p[3], p[2]]; // p[2] === p[3] ⇒ the canonical [A,B,C,C]
}

/**
 * Rewrite the doc's directed-edge creases through a weld map. Both endpoints remap; a handle whose two ends
 * FUSED is dropped (a self-edge has no curve to shape). Two distinct directed edges can land on the same key —
 * their creases disagree and the mesh can only carry one — so edges are visited in ascending ORIGINAL
 * `(from, to)` order and the first to claim a key wins. That rule reads nothing but the input, so an undo /
 * redo, or the same weld replayed on the same doc, yields a byte-identical map.
 *
 * The creases are reached through the doc's own seams and free edges rather than by taking their keys apart:
 * a handle key is only ever written, never read back apart (docs/039).
 */
function weldEdgeHandles(doc: QuadMeshDoc, weld: (v: number) => number): Record<string, V3> {
  const src = doc.edgeHandles ?? {};
  const creased: [number, number][] = [], seen = new Set<string>();
  const collect = (from: number, to: number) => {
    if (from === to) return;
    const key = directedEdgeKey(from, to);
    if (seen.has(key)) return;
    seen.add(key);
    if (src[key] !== undefined) creased.push([from, to]);
  };
  for (const q of doc.quads) for (const [a, b] of quadEdges(q)) { collect(a, b); collect(b, a); }
  for (const [a, b] of doc.freeEdges ?? []) { collect(a, b); collect(b, a); }
  creased.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Record<string, V3> = {};
  for (const [from, to] of creased) {
    const f = weld(from), t = weld(to);
    if (f === t) continue;                       // both ends welded together: the edge is gone
    const key = directedEdgeKey(f, t);
    if (out[key] === undefined) out[key] = src[directedEdgeKey(from, to)]; // lowest original (from,to) wins
  }
  return out;
}

/**
 * WELD each `[from, into]` pair: `from` disappears, `into` survives and keeps its position. This is the
 * terminal state of a surface-constrained SLIDE (slide.ts): a cage vertex or edge may never travel PAST its
 * neighbour, so a drag that far MERGES the two instead of inverting the cell.
 *
 * Chains resolve — weld a→b and b→c and all three become c. Each pair points `from`'s set at `into`'s set, so
 * the union-find ROOT of a group is exactly the group's final `into`: the survivor, at its own position.
 *
 * Every quad's corners are rewritten through the weld map and folded by `weldCell`: a cell left with three
 * distinct corners becomes a WEDGE (docs/017 S3), one left with fewer is dropped, and a DIAGONAL collapse the
 * quad primitive can't encode is rejected outright. `edgeHandles` remap (self-edges dropped), a wedged cell
 * resets its interior twist — the rotation permutes the corner slots and folds C/D together, so the stored
 * per-corner offsets no longer name the control points they were sculpted against. Then the shared manifold
 * guard + `remapIds` compaction, like every op here. Pure: returns a NEW doc, the input is untouched.
 */
export function applyVertexWeld(doc: QuadMeshDoc, pairs: readonly (readonly [number, number])[]):
  { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  if (!pairs.length) return { ok: false, error: 'Weld found no vertex pairs to merge.' };
  const vcount = doc.vertices.length / 3;
  for (const [from, into] of pairs) {
    if (!Number.isInteger(from) || !Number.isInteger(into) || from < 0 || into < 0 || from >= vcount || into >= vcount)
      return { ok: false, error: 'Weld names a vertex that isn’t in the mesh — rejected.' };
    if (from === into) return { ok: false, error: 'Weld pairs a vertex with itself — nothing to merge.' };
  }

  // union-find, always pointing the FROM's root at the INTO's root (no union-by-rank), so a root only ever
  // migrates toward an `into` — the root of a group IS the survivor, and a chain resolves to its final `into`.
  const parent = Array.from({ length: vcount }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (const [from, into] of pairs) {
    const rf = find(from), ri = find(into);
    if (rf !== ri) parent[rf] = ri;
  }

  // A retained T record is an embedded constraint, not permission to teleport the weld survivor back onto its
  // host during the next render. Let a weld resolve the node into a host endpoint, or merge coincident T points
  // already on the unchanged host; reject every other source/host rewrite conservatively.
  const { edgeHandle } = meshContext(doc);
  const point = (vertex: number): V3 => readVertex(doc.vertices, vertex);
  for (const node of normalizeTJunctions(doc)) {
    const vertex = find(node.vertex), a = find(node.edge[0]), b = find(node.edge[1]);
    if (vertex === a || vertex === b) continue; // the weld resolves the T into conforming topology
    const unchanged = vertex === node.vertex && a === node.edge[0] && b === node.edge[1];
    if (unchanged) continue;
    if (a !== node.edge[0] || b !== node.edge[1])
      return { ok: false, error: 'Weld would reshape an edge that still hosts a T-junction. Resolve that T-junction first.' };
    const p0 = point(a), p3 = point(b), target = point(vertex);
    const p1 = add(p0, edgeHandle(a, b)), p2 = add(p3, edgeHandle(b, a));
    const t = nearestCubicT(p0, p1, p2, p3, target, 64), onCurve = cubicPoint(p0, p1, p2, p3, t);
    if (Math.hypot(target[0] - onCurve[0], target[1] - onCurve[1], target[2] - onCurve[2]) > 0.05)
      return { ok: false, error: 'Weld would move a T-junction away from its host edge. Weld it to a coincident point or resolve it into a host endpoint.' };
  }

  const quads: (number[] | null)[] = new Array(doc.quads.length);
  const quadTwist = doc.quadTwist ? { ...doc.quadTwist } : undefined;
  for (let q = 0; q < doc.quads.length; q++) {
    const folded = weldCell(doc.quads[q].map(v => find(v)));
    if (folded === null) return { ok: false, error: 'Weld would fuse two DIAGONAL corners of a cell — a quad can only encode the edge-collapsed wedge [A,B,C,C]. Rejected.' };
    quads[q] = folded === 'drop' ? null : folded;
    // a cell that collapsed to a wedge was rotated and lost its D corner: its twist can't follow (like the cut)
    if (quadTwist && folded !== 'drop' && new Set(folded).size === 3 && new Set(doc.quads[q]).size === 4) delete quadTwist[q];
  }
  const kept = quads.filter(Boolean) as number[][];
  if (!kept.length && doc.quads.length) return { ok: false, error: 'Weld would collapse every cell — rejected.' };

  const guard = checkManifold(kept);
  if (!guard.ok) return { ok: false, error: guard.error! };

  const { doc: out } = finishMeshRewrite(doc, {
    vertices: doc.vertices.slice(),
    quads,
    keepVertices: looseVertexIds(doc).map(find),
    freeEdges: doc.freeEdges?.map(([a, b]) => [find(a), find(b)] as [number, number]),
    tJunctions: doc.tJunctions?.map(node => ({
      vertex: find(node.vertex), edge: [find(node.edge[0]), find(node.edge[1])] as [number, number], t: node.t,
    })),
    edgeHandles: doc.edgeHandles ? weldEdgeHandles(doc, find) : undefined,
    quadPaint: doc.quadPaint ? { ...doc.quadPaint } : undefined,
    quadTex: doc.quadTex ? { ...doc.quadTex } : undefined,
    quadOrient: doc.quadOrient ? { ...doc.quadOrient } : undefined,
    quadLocked: doc.quadLocked ? { ...doc.quadLocked } : undefined,
    quadTwist,
    quadLabels: doc.quadLabels ? Object.fromEntries(Object.entries(doc.quadLabels)
      .map(([quad, labels]) => [quad, [...labels]])) : undefined,
  });
  return { ok: true, doc: out };
}

/** Collapse one selected vertex set into a deterministic survivor. The lowest id survives at its current
 * position; every other unique id is welded directly into it in the same guarded atomic rewrite as an ordinary
 * source-to-target weld. This is the point-weld tool's "to each other" path for overlapping points/T-nodes. */
export function applyVertexWeldTogether(doc: QuadMeshDoc, vertices: readonly number[]):
  { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  const unique = [...new Set(vertices)].sort((a, b) => a - b);
  if (unique.length < 2) return { ok: false, error: 'Weld to each other needs at least two selected points.' };
  const survivor = unique[0];
  return applyVertexWeld(doc, unique.slice(1).map(vertex => [vertex, survivor] as [number, number]));
}

/** Stitch equal-size source/target edge sets in one atomic vertex weld. The edges define two unique endpoint
 * sets; target vertices are paired globally to the closest source vertices, exactly like point weld. */
export function applyEdgeWeldSets(
  doc: QuadMeshDoc,
  sources: readonly (readonly [number, number])[],
  targets: readonly (readonly [number, number])[],
): { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  if (!sources.length || targets.length !== sources.length)
    return { ok: false, error: `Edge weld needs equally sized source and target sets (${sources.length} vs ${targets.length}).` };
  const { mesh, adj } = meshContext(doc);
  const count = mesh.vertexCount;
  for (const edge of [...sources, ...targets]) for (const vertex of edge)
    if (!Number.isInteger(vertex) || vertex < 0 || vertex >= count)
    return { ok: false, error: 'Edge weld names an edge that is no longer in the mesh.' };
  const free = new Set((doc.freeEdges ?? []).map(([a, b]) => ekey(a, b)));
  const exists = (edge: readonly [number, number]) => (adj.edgeQuads.get(ekey(edge[0], edge[1]))?.length ?? 0) > 0
    || free.has(ekey(edge[0], edge[1]));
  if ([...sources, ...targets].some(edge => !exists(edge))) return { ok: false, error: 'Edge weld needs live surface or free edges.' };
  const sourceKeys = new Set(sources.map(edge => ekey(edge[0], edge[1])));
  if (sourceKeys.size !== sources.length || new Set(targets.map(edge => ekey(edge[0], edge[1]))).size !== targets.length)
    return { ok: false, error: 'Edge weld selections contain the same edge more than once.' };
  if (targets.some(edge => sourceKeys.has(ekey(edge[0], edge[1]))))
    return { ok: false, error: 'Source and target edge sets must be separate.' };

  const p = (vertex: number): V3 => readVertex(doc.vertices, vertex);
  const sourceVertices = [...new Set(sources.flatMap(edge => [...edge]))];
  const targetVertices = [...new Set(targets.flatMap(edge => [...edge]))];
  if (sourceVertices.length !== targetVertices.length)
    return { ok: false, error: `The source edges contain ${sourceVertices.length} unique vertices, but the targets contain ${targetVertices.length}.` };
  const distance = (a: number, b: number) => {
    const pa = p(a), pb = p(b);
    return (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2;
  };
  const pairs: [number, number][] = [];
  if (sourceVertices.length <= 12) {
    const memo = new Map<string, { cost: number; target: number }>();
    const solve = (i: number, used: number): number => {
      if (i === sourceVertices.length) return 0;
      const key = `${i}:${used}`, cached = memo.get(key);
      if (cached) return cached.cost;
      let cost = Infinity, choice = -1;
      for (let j = 0; j < targetVertices.length; j++) if (!(used & (1 << j))) {
        const total = distance(sourceVertices[i], targetVertices[j]) + solve(i + 1, used | (1 << j));
        if (total < cost) { cost = total; choice = j; }
      }
      memo.set(key, { cost, target: choice });
      return cost;
    };
    solve(0, 0);
    let used = 0;
    for (let i = 0; i < sourceVertices.length; i++) {
      const target = memo.get(`${i}:${used}`)!.target;
      const from = targetVertices[target], into = sourceVertices[i];
      if (from !== into) pairs.push([from, into]);
      used |= 1 << target;
    }
  } else {
    const remainingSources = [...sourceVertices], remainingTargets = [...targetVertices];
    while (remainingSources.length) {
      let ai = 0, aj = 0, best = Infinity;
      for (let i = 0; i < remainingSources.length; i++) for (let j = 0; j < remainingTargets.length; j++) {
        const cost = distance(remainingSources[i], remainingTargets[j]);
        if (cost < best) { best = cost; ai = i; aj = j; }
      }
      const into = remainingSources.splice(ai, 1)[0], from = remainingTargets.splice(aj, 1)[0];
      if (from !== into) pairs.push([from, into]);
    }
  }
  if (!pairs.length) return { ok: false, error: 'Those edge sets already share all their vertices.' };
  const welded = applyVertexWeld(doc, pairs);
  if (!welded.ok) return welded;
  // A free construction edge can land directly on a surface edge. The surface owns that topology now; keeping
  // the coincident free-edge record would draw/select the same edge twice.
  if (welded.doc.freeEdges?.length) {
    const surface = new Set<string>();
    for (const [A, B, C, D] of welded.doc.quads)
      for (const [a, b] of quadPerimeterEdges([A, B, C, D])) surface.add(ekey(a, b));
    const remaining = welded.doc.freeEdges.filter(([a, b]) => !surface.has(ekey(a, b)));
    if (remaining.length) welded.doc.freeEdges = remaining; else delete welded.doc.freeEdges;
  }
  return welded;
}

/** Single-pair convenience wrapper retained for callers and tests. */
export function applyEdgeWeld(doc: QuadMeshDoc, source: readonly [number, number], target: readonly [number, number]):
  { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  return applyEdgeWeldSets(doc, [source], [target]);
}
