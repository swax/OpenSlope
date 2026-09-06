import type { QuadMeshDoc, V3 } from '../doc/types';
import { cubicPoint } from '../math/bezier';
import { add } from '../math/vec';
import { meshAdjacency, meshFromDoc, type MeshAdjacency, type QuadMesh } from './topology';
import { readVertex } from './primitives';

export interface MeshEdgeCurve {
  edge: [number, number];
  cp: [V3, V3, V3, V3];
  min: V3;
  max: V3;
  samples?: V3[];
}

/** Enumerate every unique authored edge with its cubic controls, padded control hull, and optional samples. */
export function buildMeshEdgeCurves(
  doc: QuadMeshDoc,
  padding: number,
  sampleSegments = 0,
): { mesh: QuadMesh; adjacency: MeshAdjacency; curves: MeshEdgeCurve[] } {
  const { mesh, edgeHandle } = meshFromDoc(doc), adjacency = meshAdjacency(mesh), curves: MeshEdgeCurve[] = [];
  for (let a = 0; a < adjacency.neighbors.length; a++) for (const b of adjacency.neighbors[a] ?? []) {
    if (b <= a) continue;
    const p0 = readVertex(mesh.vertices, a), p3 = readVertex(mesh.vertices, b);
    const cp: [V3, V3, V3, V3] = [p0, add(p0, edgeHandle(a, b)), add(p3, edgeHandle(b, a)), p3];
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const point of cp) for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis] - padding);
      max[axis] = Math.max(max[axis], point[axis] + padding);
    }
    const curve: MeshEdgeCurve = { edge: [a, b], cp, min, max };
    if (sampleSegments > 0) curve.samples = Array.from({ length: sampleSegments + 1 }, (_, index) =>
      cubicPoint(cp[0], cp[1], cp[2], cp[3], index / sampleSegments));
    curves.push(curve);
  }
  return { mesh, adjacency, curves };
}

/** Diagnostic grid scale: bounded by useful editor-space sizes, seeded from the authored net spacing. */
export const meshDiagnosticCellSize = (doc: QuadMeshDoc): number =>
  Math.max(5, Math.min(30, Number.isFinite(doc.spacing) ? doc.spacing : 10));
