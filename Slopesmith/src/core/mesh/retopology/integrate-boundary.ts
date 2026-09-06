/** Open-boundary extraction and simple-cycle decomposition for candidate polygon meshes. Shared by the
 * footprint cut, the seam nudge repair, and the integrator itself. */
import { undirectedEdgeKey } from '../primitives';
import type { PolygonMesh } from './obj';

export function edgeCycles(edges: readonly [number, number][], label: string): number[][] {
  const adjacency = new Map<number, number[]>(), unused = new Set(edges.map(([a, b]) => undirectedEdgeKey(a, b)));
  const connect = (a: number, b: number) => {
    const found = adjacency.get(a);
    if (found) found.push(b); else adjacency.set(a, [b]);
  };
  for (const [a, b] of edges) { connect(a, b); connect(b, a); }
  for (const [vertex, neighbors] of adjacency) {
    if (neighbors.length !== 2) throw new Error(`${label} boundary vertex ${vertex} has degree ${neighbors.length}, expected 2`);
  }
  const loops: number[][] = [];
  while (unused.size) {
    const firstKey = unused.values().next().value as string;
    const [start, nextStart] = firstKey.split(',').map(Number);
    const loop = [start];
    let previous = start, current = nextStart;
    unused.delete(undirectedEdgeKey(previous, current));
    while (current !== start) {
      loop.push(current);
      const candidates = adjacency.get(current) ?? [];
      const next = candidates[0] === previous ? candidates[1] : candidates[0];
      if (next === undefined || !unused.delete(undirectedEdgeKey(current, next))) {
        throw new Error(`${label} boundary does not form disjoint simple cycles`);
      }
      previous = current; current = next;
    }
    loops.push(loop);
  }
  return loops;
}

export function polygonBoundary(mesh: PolygonMesh): [number, number][] {
  const occurrences = new Map<string, { edge: [number, number]; count: number }>();
  for (const face of mesh.faces) for (let i = 0; i < face.length; i++) {
    const edge: [number, number] = [face[i], face[(i + 1) % face.length]];
    if (edge[0] === edge[1]) continue; // a SlopeSmith wedge's collapsed side is private, not an open boundary
    const key = undirectedEdgeKey(edge[0], edge[1]);
    const found = occurrences.get(key);
    if (found) found.count++; else occurrences.set(key, { edge, count: 1 });
  }
  return [...occurrences.values()].filter(record => record.count === 1).map(record => record.edge);
}
