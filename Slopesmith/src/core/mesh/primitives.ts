import type { V3 } from '../doc/types';

export type MeshEdge = [number, number];

/** Read one xyz tuple from an interleaved mesh position buffer. */
export function readVertex(vertices: readonly number[], id: number): V3 {
  const offset = id * 3;
  return [vertices[offset], vertices[offset + 1], vertices[offset + 2]];
}

/** Write one xyz tuple into an interleaved mesh position buffer. */
export function writeVertex(vertices: number[], id: number, point: V3): void {
  const offset = id * 3;
  vertices[offset] = point[0];
  vertices[offset + 1] = point[1];
  vertices[offset + 2] = point[2];
}

/** Directed edge key used by the sparse handle map. */
export const directedEdgeKey = (from: number, to: number): string => `${from}>${to}`;

/** Undirected edge key, independent of endpoint order. */
export const undirectedEdgeKey = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`;

/** Canonical ascending endpoint order for an undirected edge. */
export const canonicalEdge = (a: number, b: number): MeshEdge => a < b ? [a, b] : [b, a];

/** Quad vertices in boundary traversal order rather than row-major control-net order. */
export const quadPerimeter = (corners: readonly number[]): [number, number, number, number] =>
  [corners[0], corners[1], corners[3], corners[2]];

/** All four boundary sides in traversal order, including a wedge's collapsed private side. */
export const quadPerimeterEdges = (corners: readonly number[]): MeshEdge[] => [
  [corners[0], corners[1]], [corners[1], corners[3]],
  [corners[3], corners[2]], [corners[2], corners[0]],
];

/** Non-collapsed boundary sides. Suitable for shared-edge maps and manifold counts. */
export const liveQuadEdges = (corners: readonly number[]): MeshEdge[] =>
  quadPerimeterEdges(corners).filter(([a, b]) => a !== b);
