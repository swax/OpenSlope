import type { QuadMeshDoc, V3 } from '../doc/types';
import { SpatialHash3D } from '../math/spatial-hash';
import { readVertex } from './primitives';
import { meshAdjacency, meshFromDoc } from './topology';

export const COINCIDENT_VERTEX_TOLERANCE_M = 0.05;

export interface CoincidentVertices {
  vertices: [number, number];
  points: [V3, V3];
  point: V3;
  distance: number;
}

/** Find distinct, used mesh vertices that occupy effectively the same 3D position but remain unwelded. */
export function findCoincidentVertices(
  doc: QuadMeshDoc,
  tolerance = COINCIDENT_VERTEX_TOLERANCE_M,
): CoincidentVertices[] {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return [];
  const { mesh } = meshFromDoc(doc), adj = meshAdjacency(mesh);
  const grid = new SpatialHash3D<number>(tolerance), out: CoincidentVertices[] = [];
  const tolerance2 = tolerance * tolerance;
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (!(adj.neighbors[vertex]?.length)) continue;
    const p = readVertex(mesh.vertices, vertex);
    for (const other of grid.queryPointNeighborhood(p)) {
      const q = readVertex(mesh.vertices, other);
      const distance2 = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
      if (distance2 > tolerance2) continue;
      out.push({
        vertices: [other, vertex], points: [q, p],
        point: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2],
        distance: Math.sqrt(distance2),
      });
    }
    grid.insertPoint(p, vertex);
  }
  return out;
}

/** Return the vertices directly within tolerance of one seed. Proximity is deliberately not transitive: a
 * short chain must not pull a visibly distant endpoint into a one-click weld just because each intermediate
 * pair happens to be close. An isolated or invalid seed returns only itself when it is a live vertex. */
export function coincidentVertexGroup(
  doc: QuadMeshDoc,
  vertex: number,
  tolerance = COINCIDENT_VERTEX_TOLERANCE_M,
): number[] {
  const count = doc.vertices.length / 3;
  if (!Number.isInteger(vertex) || vertex < 0 || vertex >= count) return [];
  const group = new Set([vertex]);
  for (const { vertices: [a, b] } of findCoincidentVertices(doc, tolerance)) {
    if (a === vertex) group.add(b);
    else if (b === vertex) group.add(a);
  }
  return [...group].sort((a, b) => a - b);
}
