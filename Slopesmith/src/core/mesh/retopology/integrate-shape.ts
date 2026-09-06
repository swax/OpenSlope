/** Cage/patch shape quality measures shared by the integrator, the surface fitter and its report. */
import type { QuadMeshDoc, V3 } from '../../doc/types';
import { add, cross, dot, len, sub } from '../../math/vec';
import { readVertex } from '../primitives';
import type { PolygonMesh } from './obj';

export interface DistributionSummary { min: number; median: number; p95: number; max: number }

export function polygonFaceJacobian(vertices: readonly V3[], face: readonly number[]): number {
  const unique = [...new Set(face)];
  if (unique.length === 3) {
    const points = unique.map(vertex => vertices[vertex]);
    return Math.min(...points.map((point, i) => {
      const a = sub(points[(i + 1) % 3], point), b = sub(points[(i + 2) % 3], point);
      const denominator = len(a) * len(b);
      return denominator > 1e-20 ? len(cross(a, b)) / denominator : 0;
    }));
  }
  if (unique.length < 4) return 0;
  const points = face.map(vertex => vertices[vertex]);
  const cornerCrosses = points.map((point, i) => cross(sub(points[(i + 1) % 4], point), sub(points[(i + 3) % 4], point)));
  const normalSum = cornerCrosses.reduce((sum, value): V3 => add(sum, value), [0, 0, 0] as V3);
  const normalLength = len(normalSum);
  return Math.min(...points.map((point, i) => {
    const next = sub(points[(i + 1) % 4], point), previous = sub(points[(i + 3) % 4], point);
    const denominator = len(next) * len(previous);
    return denominator > 1e-20 && normalLength > 1e-20 ? dot(cornerCrosses[i], normalSum) / (denominator * normalLength) : 0;
  }));
}

export function distribution(values: number[]): DistributionSummary {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.round((sorted.length - 1) * q)] ?? 0;
  return { min: sorted[0] ?? 0, median: at(.5), p95: at(.95), max: sorted.at(-1) ?? 0 };
}

export function candidateShapeDistributions(mesh: PolygonMesh): {
  edgeLength: DistributionSummary; aspect: DistributionSummary; equivalentSize: DistributionSummary;
  minimumCornerJacobian: DistributionSummary;
} {
  const edgeLengths: number[] = [], aspects: number[] = [], sizes: number[] = [], jacobians: number[] = [];
  for (const face of mesh.faces) {
    const points = face.map(vertex => mesh.vertices[vertex]);
    const edges = points.map((point, i) => len(sub(points[(i + 1) % points.length], point))).filter(length => length > 1e-8);
    edgeLengths.push(...edges);
    const shortest = Math.min(...edges), longest = Math.max(...edges);
    if (shortest > 1e-9) aspects.push(longest / shortest);
    const area = len(cross(sub(points[1], points[0]), sub(points[2], points[0]))) / 2
      + len(cross(sub(points[2], points[0]), sub(points[3], points[0]))) / 2;
    sizes.push(Math.sqrt(Math.max(0, area)));
    jacobians.push(polygonFaceJacobian(mesh.vertices, face));
  }
  return {
    edgeLength: distribution(edgeLengths), aspect: distribution(aspects), equivalentSize: distribution(sizes),
    minimumCornerJacobian: distribution(jacobians),
  };
}

export function documentCageShapeDistributions(doc: QuadMeshDoc, quadIndices: readonly number[]): {
  edgeLength: DistributionSummary; aspect: DistributionSummary; equivalentSize: DistributionSummary;
  minimumCornerJacobian: DistributionSummary;
} {
  const vertices = Array.from({ length: doc.vertices.length / 3 }, (_unused, vertex) => readVertex(doc.vertices, vertex));
  return candidateShapeDistributions({
    vertices,
    faces: quadIndices.map(quad => {
      const [A, B, C, D] = doc.quads[quad];
      return [A, B, D, C];
    }),
  });
}
