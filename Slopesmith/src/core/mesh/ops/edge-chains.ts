/**
 * Edge-selection chain ordering: turns a set of undirected edges into the single open vertex path an op walks.
 * Rip consumes it here; the loft (`loft.ts` `railsFromEdges`) orders each of its rails with it.
 */

/** Order a set of edges into a single open vertex chain `[v0..vk]` (each consecutive pair an edge), or null if
 *  they aren't a simple connected run — a ring (no ends), a fork (a vertex on 3+), or a broken/disjoint set. A
 *  lone edge is its own chain. Deterministic start (the smaller end id) so the op is stable. Shared with the loft
 *  (`loft.ts` `railsFromEdges`), which partitions an edge selection into components and orders each into a rail. */
export function orderEdgeChain(edges: readonly [number, number][]): number[] | null {
  if (edges.length === 1) return [edges[0][0], edges[0][1]];
  if (!edges.length) return null;
  const inc = new Map<number, number[]>();
  const push = (v: number, i: number) => { const a = inc.get(v); if (a) a.push(i); else inc.set(v, [i]); };
  edges.forEach(([a, b], i) => { push(a, i); push(b, i); });
  const ends: number[] = [];
  for (const [v, es] of inc) { if (es.length === 1) ends.push(v); else if (es.length !== 2) return null; } // 3+ = fork
  if (ends.length !== 2) return null; // 0 ends = ring; anything else = not a simple path
  const used = new Array(edges.length).fill(false);
  const chain = [Math.min(ends[0], ends[1])];
  let cur = chain[0];
  for (let s = 0; s < edges.length; s++) {
    const ei = (inc.get(cur) ?? []).find(i => !used[i]);
    if (ei === undefined) break;
    used[ei] = true;
    const [a, b] = edges[ei];
    cur = a === cur ? b : a;
    chain.push(cur);
  }
  return chain.length === edges.length + 1 ? chain : null; // one path consumed every edge
}
