import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { V3 } from '../../doc/types';
import type { RetopologyConstraints } from './benchmark';
import { polygonArea } from './benchmark';
import type { PolygonMesh } from './obj';
import { triangulateFaces } from './obj';

export interface MetricSummary {
  count: number;
  min: number | null;
  median: number | null;
  p95: number | null;
  max: number | null;
  rms: number | null;
}

export interface RetopologyScore {
  faces: {
    total: number;
    triangles: number;
    quads: number;
    ngons: number;
    quadPercentage: number;
    target: number;
    targetRatio: number;
  };
  poles: {
    interior3: number;
    interior5: number;
    interiorOther: number;
    total: number;
  };
  patchQuality: {
    minimumScaledJacobian: MetricSummary;
    aspectRatio: MetricSummary;
    equivalentEdgeLengthM: MetricSummary;
  };
  trailAlignment: {
    sampledEdges: number;
    crossFieldDeviationDegrees: MetricSummary;
  };
  protectedBoundary: {
    referenceCurves: number;
    candidateEdges: number;
    candidateToReferenceM: MetricSummary;
    referenceToCandidateM: MetricSummary;
    coverageFraction: number;
    knotMatchFraction: number;
  };
  surfaceDeviation: {
    candidateToSourceM: MetricSummary;
    sourceToCandidateM: MetricSummary;
    symmetricMaxM: number | null;
  };
  topology: {
    boundaryEdges: number;
    nonManifoldEdges: number;
    isolatedVertices: number;
  };
}

type EdgeRecord = { a: number; b: number; faces: number[] };
type Segment = { a: V3; b: V3; tangent: V3 };

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));
const subtract = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (v: V3): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const midpoint = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

export function summarize(values: readonly number[]): MetricSummary {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (at: number): number | null => finite.length
    ? finite[Math.round((finite.length - 1) * at)] : null;
  return {
    count: finite.length,
    min: finite[0] ?? null,
    median: quantile(.5),
    p95: quantile(.95),
    max: finite.at(-1) ?? null,
    rms: finite.length ? Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / finite.length) : null,
  };
}

function meshEdges(mesh: PolygonMesh): EdgeRecord[] {
  const edges = new Map<string, EdgeRecord>();
  mesh.faces.forEach((face, faceIndex) => {
    for (let i = 0; i < face.length; i++) {
      const a0 = face[i], b0 = face[(i + 1) % face.length];
      if (a0 === b0) continue;
      const a = Math.min(a0, b0), b = Math.max(a0, b0), key = `${a},${b}`;
      let record = edges.get(key);
      if (!record) { record = { a, b, faces: [] }; edges.set(key, record); }
      record.faces.push(faceIndex);
    }
  });
  return [...edges.values()];
}

function guideSegments(constraints: RetopologyConstraints): Segment[] {
  return constraints.interface.flatMap(curve => curve.samples.slice(0, -1).map((a, i) => {
    const b = curve.samples[i + 1], delta = subtract(b, a), magnitude = length(delta);
    return { a, b, tangent: magnitude > 1e-12 ? delta.map(value => value / magnitude) as V3 : [1, 0, 0] };
  }));
}

function pointSegmentDistance(point: V3, segment: Segment): number {
  const delta = subtract(segment.b, segment.a), squared = dot(delta, delta);
  const t = squared > 1e-20 ? clamp(dot(subtract(point, segment.a), delta) / squared, 0, 1) : 0;
  return length(subtract(point, [
    segment.a[0] + delta[0] * t,
    segment.a[1] + delta[1] * t,
    segment.a[2] + delta[2] * t,
  ]));
}

function nearestSegment(point: V3, segments: readonly Segment[]): { distance: number; tangent: V3 } | null {
  let best: { distance: number; tangent: V3 } | null = null;
  for (const segment of segments) {
    const distance = pointSegmentDistance(point, segment);
    if (!best || distance < best.distance) best = { distance, tangent: segment.tangent };
  }
  return best;
}

function pointToEdges(point: V3, mesh: PolygonMesh, edges: readonly EdgeRecord[]): number {
  let best = Infinity;
  for (const edge of edges) {
    const a = mesh.vertices[edge.a], b = mesh.vertices[edge.b], delta = subtract(b, a), magnitude = length(delta);
    const segment: Segment = { a, b, tangent: magnitude > 1e-12 ? delta.map(value => value / magnitude) as V3 : [1, 0, 0] };
    best = Math.min(best, pointSegmentDistance(point, segment));
  }
  return best;
}

function faceCenter(mesh: PolygonMesh, face: readonly number[]): V3 {
  const center: V3 = [0, 0, 0];
  for (const index of face) {
    const point = mesh.vertices[index];
    center[0] += point[0]; center[1] += point[1]; center[2] += point[2];
  }
  center[0] /= face.length; center[1] /= face.length; center[2] /= face.length;
  return center;
}

function samplePoints(mesh: PolygonMesh, maximum = 100_000): V3[] {
  const all = [...mesh.vertices, ...mesh.faces.map(face => faceCenter(mesh, face))];
  if (all.length <= maximum) return all;
  const stride = all.length / maximum;
  return Array.from({ length: maximum }, (_, i) => all[Math.floor(i * stride)]);
}

function meshBvh(mesh: PolygonMesh): { geometry: THREE.BufferGeometry; bvh: MeshBVH } {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.vertices.flat()), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(triangulateFaces(mesh).flat()), 1));
  return { geometry, bvh: new MeshBVH(geometry) };
}

function distancesToMesh(points: readonly V3[], mesh: PolygonMesh): number[] {
  const { geometry, bvh } = meshBvh(mesh), query = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const distances = points.map(point => {
    query.set(point[0], point[1], point[2]);
    return bvh.closestPointToPoint(query, target)?.distance ?? Infinity;
  });
  geometry.dispose();
  return distances;
}

/** Symmetric sampled distance between two polygonal surface tessellations. */
export function scoreSurfaceDeviation(
  source: PolygonMesh,
  candidate: PolygonMesh,
): RetopologyScore['surfaceDeviation'] {
  const candidateToSource = distancesToMesh(samplePoints(candidate), source);
  const sourceToCandidate = distancesToMesh(samplePoints(source), candidate);
  const candidateSummary = summarize(candidateToSource), sourceSummary = summarize(sourceToCandidate);
  const cmax = candidateSummary.max, smax = sourceSummary.max;
  return {
    candidateToSourceM: candidateSummary,
    sourceToCandidateM: sourceSummary,
    symmetricMaxM: cmax === null ? smax : smax === null ? cmax : Math.max(cmax, smax),
  };
}

function patchQuality(mesh: PolygonMesh): RetopologyScore['patchQuality'] {
  const jacobians: number[] = [], aspects: number[] = [], sizes: number[] = [];
  for (const face of mesh.faces) {
    if (face.length !== 4) continue;
    const points = face.map(index => mesh.vertices[index]);
    const edges = points.map((point, i) => length(subtract(points[(i + 1) % 4], point)));
    const shortest = Math.min(...edges), longest = Math.max(...edges);
    if (shortest > 1e-12) aspects.push(longest / shortest);
    const cornerCrosses = points.map((point, i) => {
      const next = subtract(points[(i + 1) % 4], point), previous = subtract(points[(i + 3) % 4], point);
      return cross(next, previous);
    });
    const normalSum = cornerCrosses.reduce((sum, value): V3 =>
      [sum[0] + value[0], sum[1] + value[1], sum[2] + value[2]], [0, 0, 0] as V3);
    const normalLength = length(normalSum);
    const normal = normalLength > 1e-20
      ? normalSum.map(value => value / normalLength) as V3 : [0, 0, 0] as V3;
    const cornerJacobians = points.map((point, i) => {
      const next = subtract(points[(i + 1) % 4], point), previous = subtract(points[(i + 3) % 4], point);
      const denominator = length(next) * length(previous);
      return denominator > 1e-20 && normalLength > 1e-20 ? dot(cornerCrosses[i], normal) / denominator : 0;
    });
    jacobians.push(Math.min(...cornerJacobians));
    const oneFace: PolygonMesh = { vertices: points, faces: [[0, 1, 2, 3]] };
    sizes.push(Math.sqrt(polygonArea(oneFace)));
  }
  return {
    minimumScaledJacobian: summarize(jacobians),
    aspectRatio: summarize(aspects),
    equivalentEdgeLengthM: summarize(sizes),
  };
}

function poles(mesh: PolygonMesh, edges: readonly EdgeRecord[]): RetopologyScore['poles'] {
  const incident = Array.from({ length: mesh.vertices.length }, () => new Set<number>());
  mesh.faces.forEach((face, faceIndex) => face.forEach(vertex => incident[vertex].add(faceIndex)));
  const boundary = new Set<number>();
  for (const edge of edges) if (edge.faces.length === 1) { boundary.add(edge.a); boundary.add(edge.b); }
  let interior3 = 0, interior5 = 0, interiorOther = 0;
  incident.forEach((faces, vertex) => {
    if (boundary.has(vertex) || !faces.size || faces.size === 4) return;
    if (faces.size === 3) interior3++;
    else if (faces.size === 5) interior5++;
    else interiorOther++;
  });
  return { interior3, interior5, interiorOther, total: interior3 + interior5 + interiorOther };
}

function boundaryScore(
  candidate: PolygonMesh,
  edges: readonly EdgeRecord[],
  constraints: RetopologyConstraints,
): RetopologyScore['protectedBoundary'] {
  const guides = guideSegments(constraints), band = Math.max(.25, constraints.options.targetPatchSizeM * 1.5);
  const candidateEdges = edges.filter(edge => edge.faces.length === 1
    && (nearestSegment(midpoint(candidate.vertices[edge.a], candidate.vertices[edge.b]), guides)?.distance ?? Infinity) <= band);
  const candidatePoints = [...new Set(candidateEdges.flatMap(edge => [edge.a, edge.b]))].map(index => candidate.vertices[index]);
  const candidateToReference = candidatePoints.map(point => nearestSegment(point, guides)?.distance ?? Infinity);
  const referencePoints = constraints.interface.flatMap(curve => curve.samples);
  const referenceToCandidate = referencePoints.map(point => pointToEdges(point, candidate, candidateEdges));
  const tolerance = Math.max(.01, constraints.options.targetPatchSizeM * .05);
  const knots = [...new Map(constraints.interface.flatMap(curve => [curve.samples[0], curve.samples.at(-1)!])
    .map(point => [point.join(','), point] as const)).values()];
  return {
    referenceCurves: constraints.interface.length,
    candidateEdges: candidateEdges.length,
    candidateToReferenceM: summarize(candidateToReference),
    referenceToCandidateM: summarize(referenceToCandidate),
    coverageFraction: referenceToCandidate.length
      ? referenceToCandidate.filter(distance => distance <= tolerance).length / referenceToCandidate.length : 0,
    knotMatchFraction: knots.length
      ? knots.filter(point => candidatePoints.some(candidatePoint => length(subtract(point, candidatePoint)) <= tolerance)).length / knots.length : 0,
  };
}

function trailAlignment(
  mesh: PolygonMesh,
  edges: readonly EdgeRecord[],
  constraints: RetopologyConstraints,
): RetopologyScore['trailAlignment'] {
  const guides = guideSegments(constraints), band = Math.max(.25, constraints.options.targetPatchSizeM * 2);
  const deviations: number[] = [];
  for (const edge of edges) {
    const a = mesh.vertices[edge.a], b = mesh.vertices[edge.b], nearest = nearestSegment(midpoint(a, b), guides);
    const delta = subtract(b, a), magnitude = length(delta);
    if (!nearest || nearest.distance > band || magnitude < 1e-12) continue;
    const cosine = clamp(Math.abs(dot(delta, nearest.tangent)) / magnitude, 0, 1);
    const parallelDegrees = Math.acos(cosine) * 180 / Math.PI;
    deviations.push(Math.min(parallelDegrees, 90 - parallelDegrees));
  }
  return { sampledEdges: deviations.length, crossFieldDeviationDegrees: summarize(deviations) };
}

/** Score one candidate OBJ against the exact remeshable source and preserved-region interface. */
export function scoreRetopologyCandidate(
  source: PolygonMesh,
  candidate: PolygonMesh,
  constraints: RetopologyConstraints,
): RetopologyScore {
  const edges = meshEdges(candidate), triangleCount = candidate.faces.filter(face => face.length === 3).length;
  const quadCount = candidate.faces.filter(face => face.length === 4).length;
  const ngonCount = candidate.faces.filter(face => face.length > 4).length;
  const surfaceDeviation = scoreSurfaceDeviation(source, candidate);
  const incident = new Set(candidate.faces.flat());
  return {
    faces: {
      total: candidate.faces.length,
      triangles: triangleCount,
      quads: quadCount,
      ngons: ngonCount,
      quadPercentage: candidate.faces.length ? quadCount / candidate.faces.length : 0,
      target: constraints.targetFaces,
      targetRatio: candidate.faces.length / constraints.targetFaces,
    },
    poles: poles(candidate, edges),
    patchQuality: patchQuality(candidate),
    trailAlignment: trailAlignment(candidate, edges, constraints),
    protectedBoundary: boundaryScore(candidate, edges, constraints),
    surfaceDeviation,
    topology: {
      boundaryEdges: edges.filter(edge => edge.faces.length === 1).length,
      nonManifoldEdges: edges.filter(edge => edge.faces.length > 2).length,
      isolatedVertices: candidate.vertices.length - incident.size,
    },
  };
}
