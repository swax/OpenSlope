import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from '../../doc/types';
import { deriveQuadMesh } from '../../doc/mountain';
import { meshId } from '../../doc/ids';
import { cubicPoint, patchPoint, splitCubic } from '../../math/bezier';
import { add, cross, dot, len, sub } from '../../math/vec';
import {
  pointStrictlyInProjectedPolygon, pointsInProjectedTriangles, polygonsIntersectProjectedTriangles,
  projectedSegmentsProperlyCross, type ProjectedPolygon, type ProjectedTriangle,
} from '../projected-overlap';
import { directedEdgeKey, quadPerimeterEdges, readVertex, undirectedEdgeKey } from '../primitives';
import { quadControlPoints } from '../topology';
import { tessellateQuads, type RetopologyConstraints } from './benchmark';
import { type PolygonMesh } from './obj';
import { edgeCycles, polygonBoundary } from './integrate-boundary';
import {
  candidateShapeDistributions, polygonFaceJacobian, type DistributionSummary,
} from './integrate-shape';

export { documentCageShapeDistributions, type DistributionSummary } from './integrate-shape';
export {
  fitBezierSurfaceHeight, type BezierSurfaceFitOptions, type BezierSurfaceFitReport,
} from './integrate-surface-fit';
export {
  cutCandidateByLockedFootprint, removeCandidateFacesAndRepairBoundary, splitCandidateFacesToWedges,
  type CandidateBoundaryTrim, type LockedFootprintCut,
} from './integrate-cut';
export {
  facesLeaningOverLockedFootprint, nudgeCrossingVerticesOffLockedFootprint,
  nudgeLeaningFacesOffLockedFootprint, type CrossingVertexNudge, type LeaningFaceNudge,
} from './integrate-nudge';

interface CubicEdge {
  a: number;
  b: number;
  cp: [V3, V3, V3, V3];
}

interface HostLoop {
  vertices: number[];
  edges: CubicEdge[];
}

interface CandidateSnap {
  point: V3;
  sourceVertex?: number;
  host: CubicEdge;
  t: number;
}

interface CandidateCurveSegment {
  from: number;
  to: number;
  cp: [V3, V3, V3, V3];
}

export interface CandidateRefinement {
  mesh: PolygonMesh;
  /** Genuine boundary vertices from before dependent T-node strip edges were introduced. */
  fixedBoundary: number[];
  interfaceLoops: number[][];
  /** Candidate vertex corresponding to each protected host corner, in host-loop order. */
  cornerVertices?: number[][];
  tJunctions: { vertex: number; edge: [number, number]; t: number }[];
  curveSegments: CandidateCurveSegment[];
  addedPatches: number;
}

export interface RetopologyIntegrationReport {
  protectedPatches: number;
  candidatePatches: number;
  sourceInterfaceEdges: number;
  candidateInterfaceEdges: number;
  embeddedTJunctions: number;
  connectedComponents: number;
  protectedControlDeviationM: number;
  maximumBoundarySnapM: number;
  minimumCandidateCornerJacobian: number;
  invertedCandidatePatches: number;
  invertedCandidatePatchesBeforeRelax: number;
  relaxedCandidateVertices: number;
  worstCandidatePatches: { patch: number; jacobian: number; fixedVertices: number; interfaceVertices: number }[];
  interfaceLoops: { protectedEdges: number; candidateEdges: number }[];
  maximumCornerSnapM: number;
  /** Generated seam-to-interior cage edges that properly cross a protected footprint in top view. */
  crossingInterfaceEdges: number;
  /** Candidate faces incident to a crossing edge; callers may use these to expand and retry the feature cut. */
  crossingInterfaceFaces: number[];
  /** Candidate faces with positive top-down area inside a protected patch, including overlaps that do not
   * produce a proper perimeter crossing. */
  overlappingProtectedFaces: number[];
  /** Folded candidate faces incident to the snapped protected interface. These can be removed by the same
   * monotone hole-growth repair; inverted faces elsewhere remain a hard solver failure. */
  invertedInterfaceFaces: number[];
  /** Inverted interface faces with at least three exact trail-loop vertices. They cannot be relaxed without
   * moving the protected feature and are eligible for an exceptional two-wedge split. */
  triangulatableInterfaceFaces: number[];
  /** Numerically flat interface quads reduced to one collapsed-edge wedge without adding a diagonal through
   * the protected collar. */
  collapsedInterfaceFaces: number[];
  interfaceWedgeSplits: { face: number; diagonal: 'ac' | 'bd' }[];
  boundaryRefinementPatches: number;
  boundaryRefinementTJunctions: number;
  transferredLockedPatches: number;
  regularizedCandidateVertices: number;
  candidateEdgeLengthM: DistributionSummary;
  candidateAspectRatio: DistributionSummary;
  candidateEquivalentSizeM: DistributionSummary;
}

export interface IntegratedRetopology {
  document: QuadMeshDoc;
  report: RetopologyIntegrationReport;
}

export interface RetopologyIntegrationOptions {
  /** Project the nearest source patch's surface and tile channels onto generated quads. */
  preserveSurfacePaint?: boolean;
  /** Reject alignments whose first generated row crosses the protected footprint. Disable only when the
   * protected loop is a generated collar whose phase was already fixed against the real feature boundary. */
  enforceProtectedSide?: boolean;
  /** Include first generated-row topology in the cyclic dynamic-programming assignment. */
  topologyAwareAlignment?: boolean;
  /** Encode a numerically flat three-interface-corner quad as its single collapsed-edge triangle. */
  collapseFlatInterfaceFaces?: boolean;
  /** The candidate rim carries exactly one vertex per protected corner (a prescribed 042 seam), so each
   * interface span is a single chord. Evaluate the planar crossing/overlap screens against the chordal
   * protected outline instead of a sampled cubic one — the chord-vs-curve gap otherwise reads as a false
   * crossing at every bulge, while the bicubic footprint-penetration gate still judges true curvature. */
  conformingSeams?: boolean;
}

export interface CandidateOuterBoundaryConformance {
  mesh: PolygonMesh;
  movedVertices: number;
  maximumMoveM: number;
}

/** Re-seat the candidate's largest (mountain-rim) boundary loop on the original bicubic perimeter. QuadWild
 * preserves rim topology as a sharp feature but its smoothing may still move it laterally; height-only surface
 * fitting cannot repair that directed Hausdorff error. Internal trail holes are deliberately untouched. */
export function conformCandidateOuterBoundary(
  source: QuadMeshDoc,
  candidate: PolygonMesh,
): CandidateOuterBoundaryConformance {
  const sourcePoints = Array.from({ length: source.vertices.length / 3 }, (_unused, vertex) => readVertex(source.vertices, vertex));
  const sourceMesh: PolygonMesh = {
    vertices: sourcePoints,
    faces: source.quads.map(([a, b, c, d]) => [a, b, d, c]),
  };
  const perimeter = (loop: readonly number[], points: readonly V3[]) => loop.reduce((sum, vertex, index) =>
    sum + len(sub(points[loop[(index + 1) % loop.length]], points[vertex])), 0);
  const simpleBoundaryLoops = (edges: readonly [number, number][]): number[][] => {
    const incident = new Map<number, number[]>();
    edges.forEach(([a, b], edge) => {
      for (const vertex of [a, b]) {
        const found = incident.get(vertex);
        if (found) found.push(edge); else incident.set(vertex, [edge]);
      }
    });
    const pending = new Set(edges.map((_edge, index) => index)), loops: number[][] = [];
    while (pending.size) {
      const seed = pending.values().next().value as number, component = new Set([seed]), queue = [seed];
      pending.delete(seed);
      while (queue.length) {
        const edge = queue.shift()!;
        for (const vertex of edges[edge]) for (const next of incident.get(vertex) ?? []) {
          if (pending.delete(next)) { component.add(next); queue.push(next); }
        }
      }
      const componentEdges = [...component].map(edge => edges[edge]);
      const degree = new Map<number, number>();
      for (const [a, b] of componentEdges) {
        degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
      }
      if ([...degree.values()].every(value => value === 2)) loops.push(...edgeCycles(componentEdges, 'simple source boundary'));
    }
    return loops;
  };
  const sourceLoops = simpleBoundaryLoops(polygonBoundary(sourceMesh));
  const candidateLoops = edgeCycles(polygonBoundary(candidate), 'candidate outer boundary');
  if (!sourceLoops.length || !candidateLoops.length) return { mesh: candidate, movedVertices: 0, maximumMoveM: 0 };
  const sourceLoop = sourceLoops.reduce((largest, loop) => perimeter(loop, sourcePoints) > perimeter(largest, sourcePoints)
    ? loop : largest, sourceLoops[0]);
  const candidateLoop = candidateLoops.reduce((largest, loop) => perimeter(loop, candidate.vertices) > perimeter(largest, candidate.vertices)
    ? loop : largest, candidateLoops[0]);
  const derived = deriveQuadMesh(source);
  const curves = sourceLoop.map((a, index): [V3, V3, V3, V3] => {
    const b = sourceLoop[(index + 1) % sourceLoop.length], p0 = sourcePoints[a], p3 = sourcePoints[b];
    return [p0, add(p0, derived.edgeHandle(a, b)), add(p3, derived.edgeHandle(b, a)), p3];
  });
  const vertices = candidate.vertices.map(point => [...point] as V3);
  let movedVertices = 0, maximumMoveM = 0;
  for (const vertex of candidateLoop) {
    const point = vertices[vertex];
    let best = point, bestDistance = Infinity;
    for (const curve of curves) {
      const t = nearestCubicParameter(point, curve), projected = cubicPoint(...curve, t);
      const distance = distance2(point, projected);
      if (distance < bestDistance) { bestDistance = distance; best = projected; }
    }
    if (bestDistance > 1e-12) { vertices[vertex] = [...best] as V3; movedVertices++; }
    maximumMoveM = Math.max(maximumMoveM, Math.sqrt(bestDistance));
  }
  return { mesh: { vertices, faces: candidate.faces.map(face => [...face]) }, movedVertices, maximumMoveM };
}

export interface ProtectedFootprintPenetration {
  overlappingTriangles: number[];
  penetratingCentroids: number;
  maximumCentroidDepthM: number;
  /** Deepest penetrating sample centroids, top-view metres — names WHERE a rejection happened. */
  worstPenetrations: { x: number; z: number; depthM: number }[];
}

/** Count generated tessellation triangles whose top-down footprint overlaps a protected bicubic patch by
 * positive area. A valid 2.5D stitch may share the exact feature boundary, but it must not put mountain
 * surface under or across the locked trail. This catches global loop phase/side swaps that edge-crossing
 * tests alone cannot see. */
export function generatedProtectedFootprintOverlaps(
  document: QuadMeshDoc,
  protectedPatches: number,
  resolution = 6,
): number[] {
  return generatedProtectedFootprintPenetration(document, protectedPatches, resolution).overlappingTriangles;
}

export function generatedProtectedFootprintPenetration(
  document: QuadMeshDoc,
  protectedPatches: number,
  resolution = 6,
): ProtectedFootprintPenetration {
  if (protectedPatches <= 0 || protectedPatches >= document.quads.length) return {
    overlappingTriangles: [], penetratingCentroids: 0, maximumCentroidDepthM: 0, worstPenetrations: [],
  };
  const protectedMesh = tessellateQuads(document,
    new Set(Array.from({ length: protectedPatches }, (_unused, patch) => patch)), resolution);
  const generatedMesh = tessellateQuads(document,
    new Set(Array.from({ length: document.quads.length - protectedPatches },
      (_unused, patch) => patch + protectedPatches)), resolution);
  const protectedTriangles: ProjectedTriangle[] = protectedMesh.faces.filter(face => face.length === 3)
    .map(face => face.map(vertex => {
      const point = protectedMesh.vertices[vertex];
      return [point[0], point[2]] as const;
    }) as unknown as ProjectedTriangle);
  const generatedTriangles: ProjectedPolygon[] = generatedMesh.faces.filter(face => face.length === 3)
    .map((face, id) => ({ id, points: face.map(vertex => {
      const point = generatedMesh.vertices[vertex];
      return [point[0], point[2]] as const;
    }) }));
  const overlappingTriangles = polygonsIntersectProjectedTriangles(generatedTriangles, protectedTriangles);
  const centroids = generatedTriangles.map(triangle => ({
    id: triangle.id,
    x: triangle.points.reduce((sum, point) => sum + point[0] / 3, 0),
    y: triangle.points.reduce((sum, point) => sum + point[1] / 3, 0),
  }));
  const penetrating = pointsInProjectedTriangles(centroids, protectedTriangles);
  const occurrences = new Map<string, { edge: [number, number]; count: number }>();
  protectedMesh.faces.forEach(face => face.forEach((vertex, corner) => {
    const edge: [number, number] = [vertex, face[(corner + 1) % face.length]], key = undirectedEdgeKey(...edge);
    const found = occurrences.get(key);
    if (found) found.count++; else occurrences.set(key, { edge, count: 1 });
  }));
  const boundary = [...occurrences.values()].filter(record => record.count === 1).map(record => record.edge);
  const pointSegmentDistance = (x: number, y: number, edge: [number, number]) => {
    const a = protectedMesh.vertices[edge[0]], b = protectedMesh.vertices[edge[1]];
    const dx = b[0] - a[0], dy = b[2] - a[2], denominator = dx * dx + dy * dy;
    const t = denominator > 1e-20 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[2]) * dy) / denominator)) : 0;
    return Math.hypot(x - (a[0] + dx * t), y - (a[2] + dy * t));
  };
  const centroidById = new Map(centroids.map(point => [point.id, point]));
  const depths = penetrating.map(id => {
    const point = centroidById.get(id)!;
    return { x: point.x, z: point.y, depthM: Math.min(...boundary.map(edge => pointSegmentDistance(point.x, point.y, edge))) };
  }).sort((a, b) => b.depthM - a.depthM);
  return {
    overlappingTriangles,
    penetratingCentroids: penetrating.length,
    maximumCentroidDepthM: depths[0]?.depthM ?? 0,
    worstPenetrations: depths.slice(0, 3),
  };
}

export interface ExactTrailBuffer {
  source: QuadMeshDoc;
  constraints: RetopologyConstraints;
  /** Candidate interface plus the exact cyclic candidate knot chosen for every collar corner. Reusing this
   * assignment during integration prevents a second independent alignment from switching hairpin banks. */
  refinement: CandidateRefinement;
  collarPatches: number;
  collarLoops: { innerEdges: number; outerCandidateEdges: number }[];
  adjustedOuterVertices: number;
}

const distance2 = (a: V3, b: V3): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function nearestCubicParameter(point: V3, cp: [V3, V3, V3, V3]): number {
  const samples = 64;
  let best = 0, bestDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, d = distance2(point, cubicPoint(...cp, t));
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  let low = Math.max(0, (best - 1) / samples), high = Math.min(1, (best + 1) / samples);
  for (let iteration = 0; iteration < 24; iteration++) {
    const left = low + (high - low) / 3, right = high - (high - low) / 3;
    if (distance2(point, cubicPoint(...cp, left)) <= distance2(point, cubicPoint(...cp, right))) high = right;
    else low = left;
  }
  return (low + high) / 2;
}

function segmentParameter(point: V3, a: V3, b: V3): number {
  const delta = sub(b, a), denominator = dot(delta, delta);
  return denominator > 1e-20 ? Math.max(0, Math.min(1, dot(sub(point, a), delta) / denominator)) : 0;
}

function lerpPoint(a: V3, b: V3, t: number): V3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function linearCubic(a: V3, b: V3): [V3, V3, V3, V3] {
  return [a, lerpPoint(a, b, 1 / 3), lerpPoint(a, b, 2 / 3), b];
}

function regularizeCandidateShape(
  mesh: PolygonMesh,
  fixed: ReadonlySet<number>,
  targetSize: number,
  iterations = 80,
  maximumMoveFraction = .2,
): { vertices: V3[]; moved: number } {
  const vertices = mesh.vertices.map(point => [...point] as V3), original = mesh.vertices;
  const neighbors = Array.from({ length: vertices.length }, () => new Set<number>());
  const incident = Array.from({ length: vertices.length }, () => [] as number[]);
  mesh.faces.forEach((face, faceIndex) => face.forEach((vertex, i) => {
    incident[vertex].push(faceIndex);
    neighbors[vertex].add(face[(i + 1) % face.length]); neighbors[vertex].add(face[(i + face.length - 1) % face.length]);
  }));
  const maxMove = Math.max(.1, targetSize * maximumMoveFraction), moved = new Set<number>();
  const facePenalty = (faceIndex: number) => {
    const face = mesh.faces[faceIndex], points = face.map(vertex => vertices[vertex]);
    if (new Set(face).size === 3) return 0;
    const edges = points.map((point, i) => len(sub(points[(i + 1) % points.length], point)));
    const shortest = Math.max(1e-6, Math.min(...edges)), longest = Math.max(...edges), aspect = longest / shortest;
    const area = len(cross(sub(points[1], points[0]), sub(points[2], points[0]))) / 2
      + len(cross(sub(points[2], points[0]), sub(points[3], points[0]))) / 2;
    const size = Math.sqrt(Math.max(1e-12, area)), jacobian = polygonFaceJacobian(vertices, face);
    if (jacobian <= 0) return 1e9 + Math.abs(jacobian) * 1e6;
    return 4 * Math.log(aspect) ** 2 + .25 * Math.log(size / targetSize) ** 2
      + 1.5 * Math.log(Math.max(1e-4, jacobian)) ** 2;
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    let accepted = 0;
    const badFaces = mesh.faces.map((_face, face) => facePenalty(face) > 1);
    const active = new Set(mesh.faces.flatMap((face, index) => badFaces[index] ? face : []));
    for (const vertex of active) {
      if (fixed.has(vertex) || !neighbors[vertex].size) continue;
      const faces = [...new Set(incident[vertex])], before = faces.reduce((sum, face) => sum + facePenalty(face), 0);
      const laplacian: V3 = [0, 0, 0];
      for (const neighbor of neighbors[vertex]) {
        laplacian[0] += vertices[neighbor][0]; laplacian[1] += vertices[neighbor][1]; laplacian[2] += vertices[neighbor][2];
      }
      laplacian[0] /= neighbors[vertex].size; laplacian[1] /= neighbors[vertex].size; laplacian[2] /= neighbors[vertex].size;
      const ideals: V3[] = [];
      for (const faceIndex of faces) {
        const face = mesh.faces[faceIndex], at = face.indexOf(vertex);
        if (at < 0) continue;
        const previous = vertices[face[(at + 3) % 4]], next = vertices[face[(at + 1) % 4]], opposite = vertices[face[(at + 2) % 4]];
        ideals.push([previous[0] + next[0] - opposite[0], previous[1] + next[1] - opposite[1], previous[2] + next[2] - opposite[2]]);
      }
      const idealMean = ideals.length ? ideals.reduce((sum, point): V3 => add(sum, point), [0, 0, 0] as V3)
        .map(value => value / ideals.length) as V3 : laplacian;
      const current = vertices[vertex], targets = [laplacian, idealMean];
      let winner: V3 | undefined, winnerPenalty = before;
      for (const target of targets) for (const blend of [.35, .2, .1, .05]) {
        let point: V3 = [
          current[0] + (target[0] - current[0]) * blend,
          current[1] + (target[1] - current[1]) * blend,
          current[2] + (target[2] - current[2]) * blend,
        ];
        const offset = sub(point, original[vertex]), distance = len(offset);
        if (distance > maxMove) point = add(original[vertex], offset.map(value => value * maxMove / distance) as V3);
        vertices[vertex] = point;
        const shapePenalty = faces.reduce((sum, face) => sum + facePenalty(face), 0);
        const displacementPenalty = .3 * (len(sub(point, original[vertex])) / maxMove) ** 2;
        const after = shapePenalty + displacementPenalty;
        vertices[vertex] = current;
        if (after < winnerPenalty - 1e-6) { winner = point; winnerPenalty = after; }
      }
      if (winner) { vertices[vertex] = winner; moved.add(vertex); accepted++; }
    }
    if (!accepted) break;
  }
  return { vertices, moved: moved.size };
}

/** Smoothly carry the exact trail-boundary displacement into the remesh while the mountain's outer rim stays
 * put. This is a generated transition field, not a retained source collar: every non-boundary vertex is free
 * to participate, so the new edge flow can spread across the whole mountain. */
function deformCandidateToSnaps(
  mesh: PolygonMesh,
  snaps: ReadonlyMap<number, CandidateSnap>,
  outerBoundary: ReadonlySet<number>,
  tJunctions: readonly { vertex: number; edge: [number, number]; t: number }[],
  iterations = 480,
): V3[] {
  const neighbors = Array.from({ length: mesh.vertices.length }, () => new Set<number>());
  for (const face of mesh.faces) face.forEach((a, i) => {
    const b = face[(i + 1) % face.length]; neighbors[a].add(b); neighbors[b].add(a);
  });
  const fixed = new Set(outerBoundary), displacement = mesh.vertices.map((): V3 => [0, 0, 0]);
  for (const [vertex, snap] of snaps) {
    fixed.add(vertex); displacement[vertex] = sub(snap.point, mesh.vertices[vertex]);
  }
  for (let iteration = 0; iteration < iterations; iteration++) {
    const next = displacement.map(value => [...value] as V3);
    let maximumChange = 0;
    for (let vertex = 0; vertex < displacement.length; vertex++) {
      if (fixed.has(vertex) || !neighbors[vertex].size) continue;
      const average: V3 = [0, 0, 0];
      for (const neighbor of neighbors[vertex]) {
        average[0] += displacement[neighbor][0]; average[1] += displacement[neighbor][1]; average[2] += displacement[neighbor][2];
      }
      average[0] /= neighbors[vertex].size; average[1] /= neighbors[vertex].size; average[2] /= neighbors[vertex].size;
      next[vertex] = average;
      maximumChange = Math.max(maximumChange, len(sub(average, displacement[vertex])));
    }
    for (let vertex = 0; vertex < displacement.length; vertex++) displacement[vertex] = next[vertex];
    if (maximumChange < 1e-5) break;
  }
  const vertices = mesh.vertices.map((point, vertex): V3 => add(point, displacement[vertex]));
  for (const [vertex, snap] of snaps) vertices[vertex] = [...snap.point] as V3;
  // A refined strip's opposite point is topologically embedded in an unsplit neighbour edge. Re-seat it after
  // deformation so the explicit T record and both linear cubic subedges describe exactly the same curve.
  for (const node of tJunctions) vertices[node.vertex] = lerpPoint(vertices[node.edge[0]], vertices[node.edge[1]], node.t);
  return vertices;
}

function relaxFoldedCandidate(
  mesh: PolygonMesh,
  fixed: ReadonlySet<number>,
  iterations = 160,
  tJunctions: readonly { vertex: number; edge: [number, number]; t: number }[] = [],
): { vertices: V3[]; moved: number } {
  const vertices = mesh.vertices.map(point => [...point] as V3);
  const neighbors = Array.from({ length: vertices.length }, () => new Set<number>());
  const incident = Array.from({ length: vertices.length }, () => [] as number[]);
  mesh.faces.forEach((face, faceIndex) => {
    face.forEach((vertex, i) => {
      incident[vertex].push(faceIndex);
      neighbors[vertex].add(face[(i + 1) % face.length]); neighbors[vertex].add(face[(i + face.length - 1) % face.length]);
    });
  });
  const dependent = new Set(tJunctions.map(node => node.vertex));
  const children = new Map<number, number[]>();
  tJunctions.forEach((node, index) => node.edge.forEach(parent => {
    const found = children.get(parent);
    if (found) found.push(index); else children.set(parent, [index]);
  }));
  const affectedNodes = (root: number) => {
    const found = new Set<number>(), queue = [root];
    while (queue.length) for (const nodeIndex of children.get(queue.shift()!) ?? []) if (!found.has(nodeIndex)) {
      found.add(nodeIndex); queue.push(tJunctions[nodeIndex].vertex);
    }
    return tJunctions.filter((_node, index) => found.has(index));
  };
  const projectNodes = (points: V3[], nodes: readonly { vertex: number; edge: [number, number]; t: number }[]) => {
    for (const node of nodes) points[node.vertex] = lerpPoint(points[node.edge[0]], points[node.edge[1]], node.t);
  };
  projectNodes(vertices, tJunctions);
  const moved = new Set<number>();
  for (let iteration = 0; iteration < iterations; iteration++) {
    const qualities = mesh.faces.map(face => polygonFaceJacobian(vertices, face));
    const active = new Set(mesh.faces.flatMap((face, index) => qualities[index] < 0.08 ? face : []));
    let accepted = 0;
    for (const vertex of active) {
      if (fixed.has(vertex) || dependent.has(vertex) || !neighbors[vertex].size) continue;
      const nodes = affectedNodes(vertex);
      const faces = [...new Set([...incident[vertex], ...nodes.flatMap(node => incident[node.vertex])])];
      const before = Math.min(...faces.map(face => qualities[face]));
      const average: V3 = [0, 0, 0];
      for (const neighbor of neighbors[vertex]) {
        average[0] += vertices[neighbor][0]; average[1] += vertices[neighbor][1]; average[2] += vertices[neighbor][2];
      }
      average[0] /= neighbors[vertex].size; average[1] /= neighbors[vertex].size; average[2] /= neighbors[vertex].size;
      const original = vertices[vertex];
      const originalNodes = new Map(nodes.map(node => [node.vertex, [...vertices[node.vertex]] as V3]));
      for (const blend of [0.65, 0.4, 0.2, 0.1]) {
        vertices[vertex] = [
          original[0] + (average[0] - original[0]) * blend,
          original[1] + (average[1] - original[1]) * blend,
          original[2] + (average[2] - original[2]) * blend,
        ];
        projectNodes(vertices, nodes);
        const after = Math.min(...faces.map(face => polygonFaceJacobian(vertices, mesh.faces[face])));
        if (after > before + 1e-5) { accepted++; moved.add(vertex); break; }
        vertices[vertex] = original;
        for (const [dependentVertex, point] of originalNodes) vertices[dependentVertex] = [...point] as V3;
      }
    }
    if (!accepted) break;
  }
  // A few folds can be mutually locked: moving either endpoint alone worsens its neighbour even though moving
  // the small active region together untangles both. Finish with conservative simultaneous Laplacian steps and
  // accept only a lexicographic improvement in inverted-face count, then low-Jacobian penalty.
  const objective = (points: readonly V3[]) => {
    const q = mesh.faces.map(face => polygonFaceJacobian(points, face));
    return { q, inverted: q.filter(value => value <= 0).length, penalty: q.reduce((sum, value) => sum + Math.max(0, 0.08 - value) ** 2, 0) };
  };
  let score = objective(vertices);
  for (let iteration = 0; iteration < 120 && score.inverted; iteration++) {
    const active = new Set(mesh.faces.flatMap((face, index) => score.q[index] < 0.08 ? face : []));
    const averages = new Map<number, V3>();
    for (const vertex of active) {
      if (fixed.has(vertex) || dependent.has(vertex) || !neighbors[vertex].size) continue;
      const average: V3 = [0, 0, 0];
      for (const neighbor of neighbors[vertex]) {
        average[0] += vertices[neighbor][0]; average[1] += vertices[neighbor][1]; average[2] += vertices[neighbor][2];
      }
      averages.set(vertex, average.map(value => value / neighbors[vertex].size) as V3);
    }
    let accepted = false;
    for (const blend of [0.25, 0.12, 0.06, 0.03]) {
      const proposal = vertices.map(point => [...point] as V3);
      for (const [vertex, average] of averages) proposal[vertex] = [
        vertices[vertex][0] + (average[0] - vertices[vertex][0]) * blend,
        vertices[vertex][1] + (average[1] - vertices[vertex][1]) * blend,
        vertices[vertex][2] + (average[2] - vertices[vertex][2]) * blend,
      ];
      projectNodes(proposal, tJunctions);
      const proposedScore = objective(proposal);
      if (proposedScore.inverted < score.inverted
        || (proposedScore.inverted === score.inverted && proposedScore.penalty < score.penalty - 1e-8)) {
        for (let vertex = 0; vertex < vertices.length; vertex++) vertices[vertex] = proposal[vertex];
        for (const vertex of averages.keys()) moved.add(vertex);
        score = proposedScore; accepted = true; break;
      }
    }
    if (!accepted) break;
  }
  // Laplacian motion alone cannot repair every concave quad: its best direction can be toward the wrong side
  // of the opposite corner. Search the remaining small bad region using the position that would complete each
  // incident face as a parallelogram. A move is committed only when it improves the global inversion/quality
  // objective, while its score can be updated from just the incident faces.
  const penalty = (quality: number) => Math.max(0, 0.08 - quality) ** 2;
  const better = (a: { inverted: number; penalty: number }, b: { inverted: number; penalty: number }) =>
    a.inverted < b.inverted || (a.inverted === b.inverted && a.penalty < b.penalty - 1e-10);
  for (let iteration = 0; iteration < 600 && score.inverted; iteration++) {
    const active = new Set(mesh.faces.flatMap((face, index) => score.q[index] < 0.08 ? face : []));
    let winner: { vertex: number; point: V3; dependentPoints: Map<number, V3>; qualities: Map<number, number>; inverted: number; penalty: number } | undefined;
    for (const vertex of active) {
      if (fixed.has(vertex) || dependent.has(vertex) || !neighbors[vertex].size) continue;
      const nodes = affectedNodes(vertex), original = vertices[vertex];
      const originalNodes = new Map(nodes.map(node => [node.vertex, [...vertices[node.vertex]] as V3]));
      const faces = [...new Set([...incident[vertex], ...nodes.flatMap(node => incident[node.vertex])])];
      const oldInverted = faces.filter(face => score.q[face] <= 0).length;
      const oldPenalty = faces.reduce((sum, face) => sum + penalty(score.q[face]), 0);
      const laplacian: V3 = [0, 0, 0];
      for (const neighbor of neighbors[vertex]) {
        laplacian[0] += vertices[neighbor][0]; laplacian[1] += vertices[neighbor][1]; laplacian[2] += vertices[neighbor][2];
      }
      laplacian[0] /= neighbors[vertex].size; laplacian[1] /= neighbors[vertex].size; laplacian[2] /= neighbors[vertex].size;
      const ideals: V3[] = [];
      for (const faceIndex of faces) {
        const face = mesh.faces[faceIndex], at = face.indexOf(vertex);
        if (face.length !== 4 || at < 0) continue;
        const previous = vertices[face[(at + 3) % 4]], next = vertices[face[(at + 1) % 4]], opposite = vertices[face[(at + 2) % 4]];
        ideals.push([
          previous[0] + next[0] - opposite[0],
          previous[1] + next[1] - opposite[1],
          previous[2] + next[2] - opposite[2],
        ]);
      }
      const targets = [laplacian, ...ideals];
      if (ideals.length > 1) targets.push([
        ideals.reduce((sum, point) => sum + point[0], 0) / ideals.length,
        ideals.reduce((sum, point) => sum + point[1], 0) / ideals.length,
        ideals.reduce((sum, point) => sum + point[2], 0) / ideals.length,
      ]);
      for (const target of targets) for (const blend of [0.8, 0.5, 0.3, 0.15, 0.075]) {
        const point: V3 = [
          original[0] + (target[0] - original[0]) * blend,
          original[1] + (target[1] - original[1]) * blend,
          original[2] + (target[2] - original[2]) * blend,
        ];
        vertices[vertex] = point;
        projectNodes(vertices, nodes);
        const qualities = new Map(faces.map(face => [face, polygonFaceJacobian(vertices, mesh.faces[face])]));
        const dependentPoints = new Map(nodes.map(node => [node.vertex, [...vertices[node.vertex]] as V3]));
        vertices[vertex] = original;
        for (const [dependentVertex, originalPoint] of originalNodes) vertices[dependentVertex] = [...originalPoint] as V3;
        const proposed = {
          inverted: score.inverted - oldInverted + [...qualities.values()].filter(value => value <= 0).length,
          penalty: score.penalty - oldPenalty + [...qualities.values()].reduce((sum, value) => sum + penalty(value), 0),
        };
        if (better(proposed, winner ?? score)) winner = { vertex, point, dependentPoints, qualities, ...proposed };
      }
    }
    if (!winner || !better(winner, score)) break;
    vertices[winner.vertex] = winner.point; moved.add(winner.vertex);
    for (const [vertex, point] of winner.dependentPoints) vertices[vertex] = point;
    for (const [face, quality] of winner.qualities) score.q[face] = quality;
    score = { q: score.q, inverted: winner.inverted, penalty: winner.penalty };
  }
  // The Laplacian and parallelogram targets span the usual repair directions, but on steep, non-planar
  // terrain their compromise can lie off both lines. Finish with a bounded deterministic pattern search in
  // 3D around the handful of still-active free vertices.
  const directions: V3[] = [];
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    if (!x && !y && !z) continue;
    const length = Math.hypot(x, y, z);
    directions.push([x / length, y / length, z / length]);
  }
  for (let iteration = 0; iteration < 320 && score.inverted; iteration++) {
    const active = new Set(mesh.faces.flatMap((face, index) => score.q[index] < .08 ? face : []));
    let winner: { vertex: number; point: V3; dependentPoints: Map<number, V3>; qualities: Map<number, number>;
      inverted: number; penalty: number } | undefined;
    for (const vertex of active) {
      if (fixed.has(vertex) || dependent.has(vertex) || !neighbors[vertex].size) continue;
      const nodes = affectedNodes(vertex), original = vertices[vertex];
      const originalNodes = new Map(nodes.map(node => [node.vertex, [...vertices[node.vertex]] as V3]));
      const faces = [...new Set([...incident[vertex], ...nodes.flatMap(node => incident[node.vertex])])];
      const oldInverted = faces.filter(face => score.q[face] <= 0).length;
      const oldPenalty = faces.reduce((sum, face) => sum + penalty(score.q[face]), 0);
      const meanEdge = [...neighbors[vertex]].reduce((sum, neighbor) =>
        sum + len(sub(vertices[neighbor], original)), 0) / neighbors[vertex].size;
      for (const fraction of [.35, .18, .09, .045]) for (const direction of directions) {
        const point: V3 = [
          original[0] + direction[0] * meanEdge * fraction,
          original[1] + direction[1] * meanEdge * fraction,
          original[2] + direction[2] * meanEdge * fraction,
        ];
        vertices[vertex] = point;
        projectNodes(vertices, nodes);
        const qualities = new Map(faces.map(face => [face, polygonFaceJacobian(vertices, mesh.faces[face])]));
        const dependentPoints = new Map(nodes.map(node => [node.vertex, [...vertices[node.vertex]] as V3]));
        vertices[vertex] = original;
        for (const [dependentVertex, originalPoint] of originalNodes) vertices[dependentVertex] = [...originalPoint] as V3;
        const proposed = {
          inverted: score.inverted - oldInverted + [...qualities.values()].filter(value => value <= 0).length,
          penalty: score.penalty - oldPenalty + [...qualities.values()].reduce((sum, value) => sum + penalty(value), 0),
        };
        if (better(proposed, winner ?? score)) winner = { vertex, point, dependentPoints, qualities, ...proposed };
      }
    }
    if (!winner || !better(winner, score)) break;
    vertices[winner.vertex] = winner.point; moved.add(winner.vertex);
    for (const [vertex, point] of winner.dependentPoints) vertices[vertex] = point;
    for (const [face, quality] of winner.qualities) score.q[face] = quality;
    score = { q: score.q, inverted: winner.inverted, penalty: winner.penalty };
  }
  return { vertices, moved: moved.size };
}

function hostLoops(doc: QuadMeshDoc, constraints: RetopologyConstraints): HostLoop[] {
  const vertexAt = new Map(doc.vertexIds.map((id, index) => [id, index]));
  const pairs: [number, number][] = constraints.interface.map(curve => {
    const a = vertexAt.get(curve.edgeVertexIds[0]), b = vertexAt.get(curve.edgeVertexIds[1]);
    if (a === undefined || b === undefined) throw new Error(`Protected interface names an absent source vertex`);
    return [a, b];
  });
  const derived = deriveQuadMesh(doc);
  return edgeCycles(pairs, 'protected').map(vertices => {
    const edges = vertices.map((a, index): CubicEdge => {
      const b = vertices[(index + 1) % vertices.length], p0 = readVertex(doc.vertices, a), p3 = readVertex(doc.vertices, b);
      return { a, b, cp: [p0, add(p0, derived.edgeHandle(a, b)), add(p3, derived.edgeHandle(b, a)), p3] };
    });
    return { vertices, edges };
  });
}

function nearestHostDistance2(point: V3, host: HostLoop): number {
  let best = Infinity;
  for (const edge of host.edges) for (let step = 0; step <= 12; step++) {
    best = Math.min(best, distance2(point, cubicPoint(...edge.cp, step / 12)));
  }
  return best;
}

function loopCentroid(points: readonly V3[]): V3 {
  const sum: V3 = [0, 0, 0];
  for (const p of points) { sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2]; }
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function pairKnownInterfaceLoops(
  hosts: HostLoop[],
  candidateLoops: number[][],
  mesh: PolygonMesh,
): { host: HostLoop; candidate: number[] }[] {
  if (candidateLoops.length < hosts.length) throw new Error('Candidate has fewer boundary cycles than the protected region');
  const unused = new Set(candidateLoops.map((_loop, index) => index));
  return hosts.map(host => {
    const center = loopCentroid(host.edges.map(edge => edge.cp[0]));
    let best = -1, bestScore = Infinity;
    for (const index of unused) {
      const points = candidateLoops[index].map(vertex => mesh.vertices[vertex]);
      // Ignore tiny incidental solver holes when pairing a long protected trail. Legitimate coarse interfaces
      // can still be refined, but a three-edge pinhole cannot represent dozens of ordered protected corners.
      if (points.length < Math.max(3, Math.floor(host.vertices.length / 4))) continue;
      const candidateCenter = loopCentroid(points);
      const guideDistance = points.reduce((sum, point) => sum + nearestHostDistance2(point, host), 0) / points.length;
      const score = guideDistance + distance2(center, candidateCenter) * 0.01;
      if (score < bestScore) { bestScore = score; best = index; }
    }
    if (best < 0) throw new Error('Could not pair a candidate interface cycle');
    unused.delete(best);
    return { host, candidate: candidateLoops[best] };
  });
}

function pairInterfaceLoops(hosts: HostLoop[], mesh: PolygonMesh): { host: HostLoop; candidate: number[] }[] {
  return pairKnownInterfaceLoops(hosts, edgeCycles(polygonBoundary(mesh), 'candidate'), mesh);
}

/** Insert protected corners that QuadWild represented inside a coarse boundary edge. The boundary-facing
 * quad is split into strips; matching points on its opposite edge are explicit T-nodes on the untouched
 * neighbour. This keeps the mountain coarse away from the trail and keeps every generated face a quad. */
function refineCandidateBoundary(
  mesh: PolygonMesh,
  pairs: readonly { host: HostLoop; candidate: number[] }[],
): CandidateRefinement {
  const vertices = mesh.vertices.map(point => [...point] as V3);
  const boundary = polygonBoundary(mesh), boundaryKeys = new Set(boundary.map(([a, b]) => undirectedEdgeKey(a, b)));
  const faces = mesh.faces.map(face => [...face]);
  const requests = new Map<string, { a: number; b: number; parameters: number[] }>();
  const request = (a: number, b: number, t: number) => {
    const key = undirectedEdgeKey(a, b), found = requests.get(key);
    if (found) found.parameters.push(found.a === a ? t : 1 - t);
    else requests.set(key, { a, b, parameters: [t] });
  };
  const pairCornerRequests: ({ a: number; b: number; t: number }[] | undefined)[] = [];
  for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
    const { host, candidate: loop } = pairs[pairIndex];
    // A coarse OR same-count loop can skip protected corners (for example, a diamond around a square). Insert
    // each geometrically missing host knot on the candidate edge that actually contains it. Uniformly adding
    // only the count deficit gives the right number of vertices at the wrong arc positions and can phase-swap
    // the two banks of a hairpin. A genuinely denser loop already has useful T-nodes and needs no split.
    if (loop.length > host.vertices.length) continue;
    if (loop.length < host.vertices.length) {
      // Align every EXISTING candidate knot to an ordered subset of protected corners. The omitted host
      // corners identify exactly which candidate edges must be split; this avoids putting a one-edge deficit
      // at an arbitrary/longest span on a parallel hairpin bank.
      const sourcePoints = host.vertices.map(sourceVertex => host.edges.find(edge => edge.a === sourceVertex)!.cp[0]);
      const area = (points: readonly V3[]) => points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point[0] * next[2] - next[0] * point[2];
      }, 0);
      const candidatePoints = loop.map(vertex => vertices[vertex]);
      const direction: 1 | -1 = area(sourcePoints) * area(candidatePoints) >= 0 ? 1 : -1;
      const deficit = host.vertices.length - loop.length;
      let winner: { cost: number; sequence: number[]; hosts: number[] } | undefined;
      for (let offset = 0; offset < loop.length; offset++) {
        const sequence = orderedCandidate(loop, offset, direction);
        let previous = new Array<number>(host.vertices.length).fill(Infinity);
        const back = Array.from({ length: loop.length }, () => new Array<number>(host.vertices.length).fill(-1));
        for (let inner = 0; inner <= deficit; inner++) {
          const squared = distance2(vertices[sequence[0]], sourcePoints[inner]);
          previous[inner] = squared + squared * squared * 1e-3;
        }
        for (let candidateIndex = 1; candidateIndex < sequence.length; candidateIndex++) {
          const current = new Array<number>(host.vertices.length).fill(Infinity);
          const low = candidateIndex, high = host.vertices.length - (sequence.length - candidateIndex);
          for (let inner = low; inner <= high; inner++) for (let before = candidateIndex - 1; before < inner; before++) {
            if (!Number.isFinite(previous[before])) continue;
            const squared = distance2(vertices[sequence[candidateIndex]], sourcePoints[inner]);
            const cost = previous[before] + squared + squared * squared * 1e-3;
            if (cost < current[inner]) { current[inner] = cost; back[candidateIndex][inner] = before; }
          }
          previous = current;
        }
        let inner = previous.reduce((best, cost, index) => cost < previous[best] ? index : best, 0);
        if (!Number.isFinite(previous[inner]) || (winner && previous[inner] >= winner.cost)) continue;
        const hosts = new Array<number>(sequence.length);
        for (let candidateIndex = sequence.length - 1; candidateIndex >= 0; candidateIndex--) {
          hosts[candidateIndex] = inner;
          inner = candidateIndex ? back[candidateIndex][inner] : 0;
        }
        winner = { cost: previous[hosts.at(-1)!], sequence, hosts };
      }
      if (!winner) throw new Error('Could not align a coarse candidate interface to protected corners');
      for (let candidateIndex = 0; candidateIndex < winner.sequence.length; candidateIndex++) {
        const a = winner.sequence[candidateIndex], b = winner.sequence[(candidateIndex + 1) % winner.sequence.length];
        const start = winner.hosts[candidateIndex];
        const end = candidateIndex + 1 < winner.hosts.length ? winner.hosts[candidateIndex + 1] : winner.hosts[0] + host.vertices.length;
        for (let inner = start + 1; inner < end; inner++) {
          const point = sourcePoints[inner % sourcePoints.length];
          request(a, b, segmentParameter(point, vertices[a], vertices[b]));
        }
      }
      continue;
    }
    const sourcePoints = host.vertices.map(sourceVertex => host.edges.find(edge => edge.a === sourceVertex)!.cp[0]);
    const signedArea = (points: readonly V3[]) => points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point[0] * next[2] - next[0] * point[2];
    }, 0);
    const candidatePoints = loop.map(vertex => vertices[vertex]);
    const direction: 1 | -1 = signedArea(sourcePoints) * signedArea(candidatePoints) >= 0 ? 1 : -1;
    // A prescribed rim (docs/ideas/042) carries exactly one candidate vertex per protected corner in
    // matching cyclic order. When some rotation assigns every corner unambiguously to its own vertex —
    // closer than half of either adjacent candidate edge — the seam needs no inserted knots: the
    // integration's cyclic alignment snaps those vertices onto the corners exactly. Inserting here would
    // only manufacture T-nodes out of sub-edge placement drift. A phase-shifted same-count loop (the
    // diamond around a square) fails the distance test on every rotation and still refines below.
    {
      let unambiguous = false;
      for (let offset = 0; offset < loop.length && !unambiguous; offset++) {
        const sequence = orderedCandidate(loop, offset, direction);
        unambiguous = sourcePoints.every((point, inner) => {
          const vertex = sequence[inner];
          const previousEdge = len(sub(vertices[vertex], vertices[sequence[(inner - 1 + sequence.length) % sequence.length]]));
          const nextEdge = len(sub(vertices[sequence[(inner + 1) % sequence.length]], vertices[vertex]));
          return distance2(point, vertices[vertex]) <= (.5 * Math.min(previousEdge, nextEdge)) ** 2;
        });
      }
      if (unambiguous) continue;
    }
    const sourceLengths = sourcePoints.map((point, index) => len(sub(sourcePoints[(index + 1) % sourcePoints.length], point)));
    const sourceArea = signedArea(sourcePoints);
    const sourceOutward = sourcePoints.map((_point, index): V3 => {
      const previous = sourcePoints[(index - 1 + sourcePoints.length) % sourcePoints.length];
      const next = sourcePoints[(index + 1) % sourcePoints.length];
      const tangent: V3 = [next[0] - previous[0], 0, next[2] - previous[2]];
      const normal: V3 = sourceArea >= 0 ? [tangent[2], 0, -tangent[0]] : [-tangent[2], 0, tangent[0]];
      const length = Math.max(1e-9, len(normal)); return normal.map(value => value / length) as V3;
    });
    const sourceTotal = Math.max(1e-9, sourceLengths.reduce((sum, length) => sum + length, 0));
    const sourceFractions: number[] = [];
    let sourceAlong = 0;
    for (const length of sourceLengths) { sourceFractions.push(sourceAlong / sourceTotal); sourceAlong += length; }
    let winner: { cost: number; assignments: { a: number; b: number; t: number }[] } | undefined;
    for (let offset = 0; offset < loop.length; offset++) {
      const sequence = orderedCandidate(loop, offset, direction);
      const lengths = sequence.map((vertex, index) => len(sub(
        vertices[sequence[(index + 1) % sequence.length]], vertices[vertex],
      )));
      const total = Math.max(1e-9, lengths.reduce((sum, length) => sum + length, 0));
      const cumulative = [0];
      for (const length of lengths) cumulative.push(cumulative.at(-1)! + length);
      const assignments: { a: number; b: number; t: number }[] = [];
      let cost = 0, segment = 0;
      for (let inner = 0; inner < sourcePoints.length; inner++) {
        const target = sourceFractions[inner] * total;
        while (segment + 1 < sequence.length && cumulative[segment + 1] < target) segment++;
        const a = sequence[segment], b = sequence[(segment + 1) % sequence.length];
        const local = lengths[segment] > 1e-9 ? (target - cumulative[segment]) / lengths[segment] : 0;
        const projected = segmentParameter(sourcePoints[inner], vertices[a], vertices[b]);
        // Arc position establishes bank identity; a bounded geometric projection seats the knot accurately
        // without allowing it to jump to another segment of a parallel hairpin.
        const t = Math.max(0, Math.min(1, projected * .75 + local * .25));
        const point = lerpPoint(vertices[a], vertices[b], t);
        const wrongBank = Math.max(0, .25 - dot(sub(point, sourcePoints[inner]), sourceOutward[inner]));
        cost += distance2(sourcePoints[inner], point) + wrongBank * wrongBank * 1e9;
        assignments.push({ a, b, t });
      }
      if (!winner || cost < winner.cost) winner = { cost, assignments };
    }
    pairCornerRequests[pairIndex] = winner?.assignments;
    for (const assignment of winner?.assignments ?? []) {
      if (assignment.t > 1e-3 && assignment.t < 1 - 1e-3) request(assignment.a, assignment.b, assignment.t);
    }
  }

  const tJunctions: CandidateRefinement['tJunctions'] = [];
  const curveSegments: CandidateCurveSegment[] = [];
  const insertedByEdge = new Map<string, { a: number; vertices: number[] }>();
  let addedPatches = 0;
  for (const [key, request] of requests) {
    const faceIndex = faces.findIndex(face => face.some((a, i) => undirectedEdgeKey(a, face[(i + 1) % 4]) === key));
    if (faceIndex < 0) throw new Error('Boundary refinement could not find its incident quad');
    const face = faces[faceIndex];
    let at = -1;
    for (let i = 0; i < 4; i++) if (undirectedEdgeKey(face[i], face[(i + 1) % 4]) === key) { at = i; break; }
    if (at < 0) throw new Error('Boundary refinement edge is absent from its incident quad');
    const p0 = face[at], p1 = face[(at + 1) % 4], p2 = face[(at + 2) % 4], p3 = face[(at + 3) % 4];
    // A narrow bridge can expose both opposite edges to the same trail-hole cycle. It cannot host the usual
    // interior T-node strip; leave it intact and let a wider footprint/collar remove that bridge explicitly.
    if (boundaryKeys.has(undirectedEdgeKey(p2, p3))) continue;
    const directed = request.a === p0 ? request.parameters : request.parameters.map(t => 1 - t);
    const parameters = [...new Set(directed.map(t => Math.round(t * 1e9) / 1e9))]
      .filter(t => t > 1e-3 && t < 1 - 1e-3).sort((a, b) => a - b);
    if (!parameters.length) continue;
    const boundaryVertices = [p0], oppositeVertices = [p3];
    for (const t of parameters) {
      const boundaryVertex = vertices.length; vertices.push(lerpPoint(vertices[p0], vertices[p1], t));
      const oppositeVertex = vertices.length; vertices.push(lerpPoint(vertices[p3], vertices[p2], t));
      boundaryVertices.push(boundaryVertex); oppositeVertices.push(oppositeVertex);
      tJunctions.push({ vertex: oppositeVertex, edge: [p3, p2], t });
    }
    boundaryVertices.push(p1); oppositeVertices.push(p2);
    insertedByEdge.set(key, {
      a: request.a,
      vertices: request.a === p0 ? boundaryVertices.slice(1, -1) : boundaryVertices.slice(1, -1).reverse(),
    });
    const children = Array.from({ length: parameters.length + 1 }, (_unused, i) => [
      boundaryVertices[i], boundaryVertices[i + 1], oppositeVertices[i + 1], oppositeVertices[i],
    ]);
    faces[faceIndex] = children[0]; faces.push(...children.slice(1));
    addedPatches += parameters.length;
    const hostCurve = linearCubic(vertices[p3], vertices[p2]);
    curveSegments.push({ from: p3, to: p2, cp: hostCurve });
    const knots = [0, ...parameters, 1];
    for (let i = 0; i + 1 < oppositeVertices.length; i++) curveSegments.push({
      from: oppositeVertices[i], to: oppositeVertices[i + 1], cp: subcurve(hostCurve, knots[i], knots[i + 1]),
    });
  }
  const interfaceLoops = pairs.map(pair => pair.candidate.flatMap((a, i) => {
    const inserted = insertedByEdge.get(undirectedEdgeKey(a, pair.candidate[(i + 1) % pair.candidate.length]));
    return [a, ...(inserted ? inserted.a === a ? inserted.vertices : [...inserted.vertices].reverse() : [])];
  }));
  const cornerVertices = pairs.map((pair, pairIndex) => (pairCornerRequests[pairIndex] ?? []).map(assignment => {
    if (assignment.t <= 1e-3) return assignment.a;
    if (assignment.t >= 1 - 1e-3) return assignment.b;
    const inserted = insertedByEdge.get(undirectedEdgeKey(assignment.a, assignment.b));
    if (!inserted?.vertices.length) return assignment.t < .5 ? assignment.a : assignment.b;
    const target = lerpPoint(vertices[assignment.a], vertices[assignment.b], assignment.t);
    return inserted.vertices.reduce((best, vertex) => distance2(vertices[vertex], target) < distance2(vertices[best], target)
      ? vertex : best, inserted.vertices[0]);
  }));
  return {
    mesh: { vertices, faces },
    fixedBoundary: [...new Set(boundary.flat())],
    interfaceLoops,
    cornerVertices,
    tJunctions, curveSegments, addedPatches,
  };
}

/** Densify only an interface that is topologically coarser than the exact protected loop. This is the
 * low-density counterpart to accepting a solver's already-overresolved boundary: it adds the minimum number
 * of boundary strip quads needed for one distinct candidate vertex per protected corner. */
export function refineCoarseCandidateInterface(
  source: QuadMeshDoc,
  candidate: PolygonMesh,
  constraints: RetopologyConstraints,
): CandidateRefinement | null {
  const hosts = hostLoops(source, constraints), pairs = pairInterfaceLoops(hosts, candidate);
  if (pairs.every(pair => pair.candidate.length > pair.host.vertices.length)) return null;
  return refineCandidateBoundary(candidate, pairs);
}

function orderedCandidate(loop: number[], offset: number, direction: 1 | -1): number[] {
  return Array.from({ length: loop.length }, (_, i) => loop[(offset + direction * i + loop.length * 2) % loop.length]);
}

/** Assign every protected corner to a distinct candidate boundary vertex without changing either cyclic order. */
function regularizedChordParameters(
  mesh: PolygonMesh,
  sequence: readonly number[],
  start: number,
  count: number,
): number[] {
  const segmentLengths = Array.from({ length: count }, (_unused, local) => len(sub(
    mesh.vertices[sequence[(start + local + 1) % sequence.length]],
    mesh.vertices[sequence[(start + local) % sequence.length]],
  )));
  const total = segmentLengths.reduce((sum, length) => sum + length, 0);
  if (total <= 1e-8) return Array.from({ length: count + 1 }, (_unused, local) => local / count);
  // Preserve QuadWild's relative boundary spacing, but give every sub-edge part of an even share. A nearly
  // collapsed candidate edge otherwise maps to an equally tiny Bezier interval and produces pinched texture
  // patches at the protected seam.
  const mean = total / count, regularization = .25;
  const weights = segmentLengths.map(length => length * (1 - regularization) + mean * regularization);
  const parameters = [0];
  for (const weight of weights) parameters.push(parameters.at(-1)! + weight / total);
  parameters[parameters.length - 1] = 1;
  return parameters;
}

function bestCyclicAlignment(
  source: V3[],
  candidateLoop: number[],
  mesh: PolygonMesh,
  hostEdges?: readonly CubicEdge[],
  enforceProtectedSide = true,
  requiredDirection?: 1 | -1,
  requireOutsideCandidate = false,
): { sequence: number[]; corners: number[] } {
  const m = source.length, n = candidateLoop.length;
  if (n < m) throw new Error(`Candidate interface has ${n} vertices for ${m} protected corners; a denser solve is required`);
  let winner: { cost: number; sequence: number[]; corners: number[] } | null = null;
  const sourceArea = source.reduce((sum, point, index) => {
    const next = source[(index + 1) % m]; return sum + point[0] * next[2] - next[0] * point[2];
  }, 0);
  const outward = source.map((point, index): V3 => {
    const previous = source[(index - 1 + m) % m], next = source[(index + 1) % m];
    const tangent: V3 = [next[0] - previous[0], 0, next[2] - previous[2]];
    const normal: V3 = sourceArea >= 0 ? [tangent[2], 0, -tangent[0]] : [-tangent[2], 0, tangent[0]];
    const length = Math.max(1e-9, len(normal)); return normal.map(value => value / length) as V3;
  });
  const pointCost = (sourceIndex: number, candidateVertex: number) => {
    const delta = sub(mesh.vertices[candidateVertex], source[sourceIndex]);
    const wrongBank = requireOutsideCandidate ? Math.max(0, .25 - dot(delta, outward[sourceIndex])) : 0;
    const squaredDistance = distance2(source[sourceIndex], mesh.vertices[candidateVertex]);
    return squaredDistance + squaredDistance * squaredDistance * 1e-3 + wrongBank * wrongBank * 1e9;
  };
  const directions: readonly (1 | -1)[] = requiredDirection === undefined ? [1, -1] : [requiredDirection];
  for (const direction of directions) for (let offset = 0; offset < n; offset++) {
    const sequence = orderedCandidate(candidateLoop, offset, direction);
    let previous = new Array<number>(n).fill(Infinity);
    previous[0] = pointCost(0, sequence[0]);
    const back: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));
    for (let i = 1; i < m; i++) {
      const current = new Array<number>(n).fill(Infinity);
      let prefixCost = Infinity, prefixIndex = -1;
      for (let j = 1; j < n; j++) {
        if (previous[j - 1] < prefixCost) { prefixCost = previous[j - 1]; prefixIndex = j - 1; }
        if (j < i || j > n - (m - i) || !Number.isFinite(prefixCost)) continue;
        const expected = i * n / m, spacing = (j - expected) ** 2 * 0.05;
        current[j] = prefixCost + pointCost(i, sequence[j]) + spacing;
        back[i][j] = prefixIndex;
      }
      previous = current;
    }
    let at = -1, distanceCost = Infinity;
    for (let j = m - 1; j < n; j++) if (previous[j] < distanceCost) { distanceCost = previous[j]; at = j; }
    if (at < 0) continue;
    const corners = new Array<number>(m);
    for (let i = m - 1; i >= 0; i--) { corners[i] = at; at = i ? back[i][at] : 0; }
    // Point distance alone can choose the wrong phase at a tight S-turn: all sixty knots are near the loop,
    // yet one boundary-facing quad crosses after snapping. Score the actual incident candidate faces with the
    // proposed exact corner positions so a fold is vastly more expensive than a modestly longer seam snap.
    let shapePenalty = 0;
    const mapped = new Map<number, V3>();
    const cornerVertices = new Set<number>();
    for (let i = 0; i < m; i++) {
      const start = corners[i], end = i + 1 < m ? corners[i + 1] : n, count = end - start;
      const cp = hostEdges?.[i]?.cp ?? linearCubic(source[i], source[(i + 1) % m]);
      const parameters = regularizedChordParameters(mesh, sequence, start, count);
      cornerVertices.add(sequence[start]);
      for (let local = 0; local < count; local++) {
        mapped.set(sequence[(start + local) % n], cubicPoint(...cp, parameters[local]));
      }
    }
    const protectedPolygon: [number, number][] = hostEdges?.flatMap(edge =>
      Array.from({ length: 6 }, (_unused, sample) => {
        const point = cubicPoint(...edge.cp, sample / 6);
        return [point[0], point[2]] as [number, number];
      })) ?? source.map(point => [point[0], point[2]]);
    for (const face of mesh.faces) {
      if (!face.some(vertex => mapped.has(vertex))) continue;
      const points = face.map(vertex => mapped.get(vertex) ?? mesh.vertices[vertex]);
      const jacobian = polygonFaceJacobian(points, face.map((_vertex, i) => i));
      // Three exact protected corners in one generated boundary quad leave only one free vertex and commonly
      // make the face impossible to untangle. Spend a surplus candidate knot between those corners instead.
      const exactCorners = face.filter(vertex => cornerVertices.has(vertex)).length;
      if (exactCorners > 2) shapePenalty += (exactCorners - 2) * 5e8;
      if (jacobian <= 0) shapePenalty += 1e8 + Math.abs(jacobian) * 1e7;
      else shapePenalty += 1e5 * Math.max(0, .08 - jacobian) ** 2;
      // A manifold quad can still reach across a narrow trail and attach to the opposite side. Boundary
      // vertices lie on the protected cubic by construction; every OTHER corner and the face center must
      // remain outside that ribbon, and no face edge may properly cross its sampled perimeter.
      if (enforceProtectedSide) {
        const projected = points.map(point => [point[0], point[2]] as [number, number]);
        for (let corner = 0; corner < face.length; corner++) {
          if (!mapped.has(face[corner]) && pointStrictlyInProjectedPolygon(projected[corner], protectedPolygon))
            shapePenalty += 2e10;
          const a = projected[corner], b = projected[(corner + 1) % face.length];
          for (let edge = 0; edge < protectedPolygon.length; edge++) if (projectedSegmentsProperlyCross(
            a, b, protectedPolygon[edge], protectedPolygon[(edge + 1) % protectedPolygon.length], 1e-7)) {
            shapePenalty += 2e10; break;
          }
        }
        const center = projected.reduce<[number, number]>((sum, point) =>
          [sum[0] + point[0] / projected.length, sum[1] + point[1] / projected.length], [0, 0]);
        if (pointStrictlyInProjectedPolygon(center, protectedPolygon, 1e-7)) shapePenalty += 2e10;
        if (protectedPolygon.some(point => pointStrictlyInProjectedPolygon(point, projected, 1e-7))) {
          shapePenalty += 2e10;
        }
      }
    }
    const cost = distanceCost + shapePenalty;
    if (winner && cost >= winner.cost) continue;
    winner = { cost, sequence, corners };
  }
  if (!winner) throw new Error('Could not align candidate and protected interface cycles');
  return winner;
}

function qualityCyclicAlignment(
  source: V3[],
  candidateLoop: number[],
  mesh: PolygonMesh,
  hostEdges?: readonly CubicEdge[],
  snapToOuterChord = false,
): { sequence: number[]; corners: number[] } {
  const m = source.length, n = candidateLoop.length;
  if (n < m) throw new Error(`Candidate interface has ${n} vertices for ${m} protected corners; a denser solve is required`);
  let winner: { cost: number; sequence: number[]; corners: number[] } | undefined;
  const expectedStep = n / m, maximumStep = Math.max(4, Math.ceil(expectedStep * 4));
  const boundaryVertices = new Set(candidateLoop), boundaryEdgeFaces = new Map<string, number[]>();
  mesh.faces.forEach((face, faceIndex) => face.forEach((vertex, corner) => {
    const next = face[(corner + 1) % face.length];
    if (!boundaryVertices.has(vertex) || !boundaryVertices.has(next)) return;
    const key = undirectedEdgeKey(vertex, next), found = boundaryEdgeFaces.get(key);
    if (found) found.push(faceIndex); else boundaryEdgeFaces.set(key, [faceIndex]);
  }));
  const protectedPolygon: [number, number][] = hostEdges?.flatMap(edge =>
    Array.from({ length: 6 }, (_unused, sample) => {
      const point = cubicPoint(...edge.cp, sample / 6);
      return [point[0], point[2]] as [number, number];
    })) ?? source.map(point => [point[0], point[2]]);
  const protectedPolygons = [protectedPolygon, source.map(point => [point[0], point[2]] as [number, number])];
  // Establish traversal direction from signed top-down winding, then phase from geometry. A tight hairpin can
  // make the reverse traversal nearly as close point-for-point, but that reversal attaches the mountain's right
  // bank to the trail's left bank. Topology scoring may redistribute surplus knots, never reverse this winding.
  const signedArea = (points: readonly V3[]) => points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point[0] * next[2] - next[0] * point[2];
  }, 0);
  const sourceWinding = signedArea(source), candidateWinding = signedArea(candidateLoop.map(vertex => mesh.vertices[vertex]));
  const windingDirection: 1 | -1 = sourceWinding * candidateWinding >= 0 ? 1 : -1;
  const preferredAlignment = bestCyclicAlignment(
    source, candidateLoop, mesh, hostEdges, false, windingDirection, true,
  );
  const preferred = preferredAlignment.sequence;
  const preferredOffset = candidateLoop.indexOf(preferred[0]);
  const preferredDirection: 1 | -1 = candidateLoop[(preferredOffset + 1) % n] === preferred[1] ? 1 : -1;
  for (const direction of [preferredDirection]) for (const offset of [preferredOffset]) {
    const sequence = orderedCandidate(candidateLoop, offset, direction);
    const transitionCost = (inner: number, outerStart: number, outerEnd: number): number => {
      const step = outerEnd - outerStart;
      const points: V3[] = [
        source[inner], source[(inner + 1) % m],
        mesh.vertices[sequence[outerEnd % n]], mesh.vertices[sequence[outerStart % n]],
      ];
      const edges = points.map((point, i) => len(sub(points[(i + 1) % 4], point)));
      const aspect = Math.max(...edges) / Math.max(1e-6, Math.min(...edges));
      const jacobian = polygonFaceJacobian(points, [0, 1, 2, 3]);
      const invalid = jacobian <= 0 ? 1e6 + Math.abs(jacobian) * 1e5 : 0;
      const projected = points.map(point => [point[0], point[2]] as [number, number]);
      let wrongSide = protectedPolygons.some(polygon => projected.slice(2)
        .some(point => pointStrictlyInProjectedPolygon(point, polygon, 1e-7)))
        || [[projected[0], projected[3]], [projected[1], projected[2]]].some(([a, b]) =>
          protectedPolygons.some(polygon => polygon.some((point, edge) => projectedSegmentsProperlyCross(
            a, b, point, polygon[(edge + 1) % polygon.length], 1e-7))))
        ? 1 : 0;
      const center: [number, number] = projected.reduce<[number, number]>((sum, point) =>
        [sum[0] + point[0] / projected.length, sum[1] + point[1] / projected.length], [0, 0]);
      if (protectedPolygons.some(polygon => pointStrictlyInProjectedPolygon(center, polygon, 1e-7)
        || polygon.some(point => pointStrictlyInProjectedPolygon(point, projected, 1e-7)))) wrongSide++;
      // Score the topology that DIRECT integration actually creates: every vertex in this candidate boundary
      // interval moves onto one protected cubic, while its incident interior vertices stay in place. A radial
      // first-row edge that would then cut through the feature is a hard topology error, even if the two loop
      // corners themselves form a harmless-looking bridge quad.
      const cp = hostEdges?.[inner]?.cp ?? linearCubic(source[inner], source[(inner + 1) % m]);
      const parameters = regularizedChordParameters(mesh, sequence, outerStart, step);
      const mapped = new Map<number, V3>();
      let boundarySnapCost = 0;
      for (let local = 0; local <= step; local++) mapped.set(
        sequence[(outerStart + local) % n], cubicPoint(...cp, parameters[local]),
      );
      for (const [vertex, point] of mapped) boundarySnapCost += distance2(mesh.vertices[vertex], point);
      const incident = new Set<number>();
      for (let at = outerStart; at < outerEnd; at++) for (const face of boundaryEdgeFaces.get(undirectedEdgeKey(
        sequence[at % n], sequence[(at + 1) % n],
      )) ?? []) incident.add(face);
      for (const faceIndex of incident) {
        const face = mesh.faces[faceIndex];
        for (let corner = 0; corner < face.length; corner++) {
          const a = face[corner], b = face[(corner + 1) % face.length];
          if (mapped.has(a) === mapped.has(b) || (boundaryVertices.has(a) && boundaryVertices.has(b))) continue;
          const boundary = mapped.has(a) ? mapped.get(a)! : mapped.get(b)!;
          const interior = mapped.has(a) ? mesh.vertices[b] : mesh.vertices[a];
          const projectedBoundary: [number, number] = [boundary[0], boundary[2]];
          const projectedInterior: [number, number] = [interior[0], interior[2]];
          if (protectedPolygons.some(polygon => pointStrictlyInProjectedPolygon(projectedInterior, polygon, 1e-7)
            || polygon.some((point, edge) => projectedSegmentsProperlyCross(
              projectedBoundary, projectedInterior, point, polygon[(edge + 1) % polygon.length], 1e-7)))) wrongSide++;
        }
      }
      // A transition collar does not snap this interval onto the protected cubic: it snaps it onto its own
      // straight OUTER chord between the two chosen corner vertices. The protected-cubic distance cannot see
      // the difference — a bulge in the hole boundary is far from the trail under every assignment — but the
      // chord drag is ~zero when the chosen corners follow the bulge and huge when the chord cuts it off,
      // dragging the first row across itself. Charge that drag so corners trace the hole outline.
      let chordSnapCost = 0;
      if (snapToOuterChord) for (let local = 0; local <= step; local++) chordSnapCost += distance2(
        mesh.vertices[sequence[(outerStart + local) % n]],
        lerpPoint(points[3], points[2], parameters[local]),
      );
      return wrongSide * 2e10 + invalid + 5 * Math.log(aspect) ** 2 + 12 * Math.max(0, .35 - jacobian) ** 2
        + 5 * (distance2(source[inner], points[3]) + distance2(source[(inner + 1) % m], points[2]))
        + 5 * (boundarySnapCost + chordSnapCost)
        + .12 * (step - expectedStep) ** 2;
    };
    let previous = new Array<number>(n).fill(Infinity); previous[0] = 0;
    const back: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));
    for (let inner = 1; inner < m; inner++) {
      const current = new Array<number>(n).fill(Infinity);
      const low = inner, high = n - (m - inner);
      for (let end = low; end <= high; end++) for (let step = 1; step <= maximumStep; step++) {
        const start = end - step;
        if (start < 0 || !Number.isFinite(previous[start])) continue;
        const cost = previous[start] + transitionCost(inner - 1, start, end);
        if (cost < current[end]) { current[end] = cost; back[inner][end] = start; }
      }
      previous = current;
    }
    let end = -1, cost = Infinity;
    for (let start = m - 1; start < n; start++) {
      const closingStep = n - start;
      if (closingStep < 1 || closingStep > maximumStep || !Number.isFinite(previous[start])) continue;
      const total = previous[start] + transitionCost(m - 1, start, n);
      if (total < cost) { cost = total; end = start; }
    }
    if (end < 0 || (winner && cost >= winner.cost)) continue;
    const corners = new Array<number>(m);
    for (let inner = m - 1; inner >= 0; inner--) {
      corners[inner] = end;
      end = inner ? back[inner][end] : 0;
    }
    winner = { cost, sequence, corners };
  }
  if (!winner) throw new Error('Could not quality-align candidate and protected interface cycles');
  return winner;
}

/** Add a generated, trail-shaped one-patch collar to the temporary protected source. The collar's inner edges
 * are the exact trail cubics; its outer corners are ordered vertices selected from the buffered QuadWild hole.
 * Integration therefore spends all candidate/source count mismatch on the OUTER collar edge. */
export function buildExactTrailBuffer(
  source: QuadMeshDoc,
  candidate: PolygonMesh,
  constraints: RetopologyConstraints,
  candidateRefinement?: CandidateRefinement,
  minimumWidthM?: number,
): ExactTrailBuffer {
  if (constraints.options.wholeSurface) throw new Error('Exact trail buffer needs protected-mode constraints');
  const hosts = hostLoops(source, constraints), pairs = candidateRefinement?.interfaceLoops
    ? pairKnownInterfaceLoops(hosts, candidateRefinement.interfaceLoops, candidate)
    : pairInterfaceLoops(hosts, candidate);
  let nextId = source.nextId;
  const vertices = [...source.vertices], vertexIds = [...source.vertexIds], quads = source.quads.map(quad => [...quad]);
  const quadIds = [...source.quadIds], edgeHandles = { ...source.edgeHandles }, quadPaint = { ...source.quadPaint };
  const quadLocked = { ...source.quadLocked }, protectedQuadIds = [...constraints.protectedQuadIds];
  const interfaceCurves: RetopologyConstraints['interface'] = [], collarLoops: ExactTrailBuffer['collarLoops'] = [];
  const cornerVertices: number[][] = [];
  let collarPatches = 0, adjustedOuterVertices = 0;
  for (const { host, candidate: candidateLoop } of pairs) {
    const innerPoints = host.vertices.map(vertex => host.edges.find(edge => edge.a === vertex)!.cp[0]);
    const alignment = qualityCyclicAlignment(innerPoints, candidateLoop, candidate, host.edges, true);
    cornerVertices.push(alignment.corners.map(corner => alignment.sequence[corner]));
    const area = innerPoints.reduce((sum, point, index) => {
      const next = innerPoints[(index + 1) % innerPoints.length];
      return sum + point[0] * next[2] - next[0] * point[2];
    }, 0);
    const minimumWidth = minimumWidthM ?? constraints.options.targetPatchSizeM * .5;
    const cornerCount = alignment.corners.length;
    const cornerData = alignment.corners.map((corner, index) => {
      const point = candidate.vertices[alignment.sequence[corner]];
      const previous = innerPoints[(index - 1 + innerPoints.length) % innerPoints.length];
      const next = innerPoints[(index + 1) % innerPoints.length];
      const tangent: V3 = [next[0] - previous[0], 0, next[2] - previous[2]];
      const normal: V3 = area >= 0 ? [tangent[2], 0, -tangent[0]] : [-tangent[2], 0, tangent[0]];
      const normalLength = Math.max(1e-9, len(normal)), outward = normal.map(value => value / normalLength) as V3;
      const width = dot(sub(point, innerPoints[index]), outward);
      return { point, outward, push: Math.max(0, minimumWidth - width) };
    });
    // The minimum-width push guarantees usable collar patches, but a pushed chord can slice across the
    // candidate's first row: every loop vertex snaps onto its chord while the interior stays put, so a
    // radial first-row edge that crosses another chord becomes a hard crossing after integration. Verify
    // the pushed chords against those post-snap radial edges and locally back the push off where it causes
    // a crossing — a narrow transition patch is repairable, a crossed one is rejected outright.
    const loopSet = new Set(alignment.sequence);
    const radialNeighbors = new Map<number, number[]>();
    for (const face of candidate.faces) {
      if (!face.some(vertex => loopSet.has(vertex))) continue;
      face.forEach((vertex, corner) => {
        const nextVertex = face[(corner + 1) % face.length];
        for (const [a, b] of [[vertex, nextVertex], [nextVertex, vertex]] as const) {
          if (!loopSet.has(a) || loopSet.has(b)) continue;
          const found = radialNeighbors.get(a);
          if (found) found.push(b); else radialNeighbors.set(a, [b]);
        }
      });
    }
    const pushScale = new Array<number>(cornerCount).fill(1);
    const cornerPosition = (index: number): V3 => add(cornerData[index].point,
      cornerData[index].outward.map(value => value * cornerData[index].push * pushScale[index]) as V3);
    for (let attempt = 0; attempt < 8; attempt++) {
      const positions = cornerData.map((_corner, index) => cornerPosition(index));
      const snapTarget = new Map<number, V3>();
      for (let i = 0; i < cornerCount; i++) {
        const start = alignment.corners[i];
        const end = i + 1 < cornerCount ? alignment.corners[i + 1] : alignment.sequence.length;
        const parameters = regularizedChordParameters(candidate, alignment.sequence, start, end - start);
        for (let local = 0; local < end - start; local++) snapTarget.set(
          alignment.sequence[(start + local) % alignment.sequence.length],
          lerpPoint(positions[i], positions[(i + 1) % cornerCount], parameters[local]),
        );
      }
      const crossingChords = new Set<number>();
      for (let i = 0; i < cornerCount; i++) {
        const a = positions[i], b = positions[(i + 1) % cornerCount];
        const chordA: [number, number] = [a[0], a[2]], chordB: [number, number] = [b[0], b[2]];
        scan: for (const [loopVertex, neighbors] of radialNeighbors) {
          const snapped = snapTarget.get(loopVertex);
          if (!snapped) continue;
          const from: [number, number] = [snapped[0], snapped[2]];
          for (const neighbor of neighbors) {
            const interior = candidate.vertices[neighbor];
            if (projectedSegmentsProperlyCross(from, [interior[0], interior[2]], chordA, chordB, 1e-7)) {
              crossingChords.add(i); break scan;
            }
          }
        }
      }
      if (!crossingChords.size) break;
      let reduced = false;
      for (const chord of crossingChords) for (const corner of [chord, (chord + 1) % cornerCount]) {
        if (cornerData[corner].push * pushScale[corner] > minimumWidth * 1e-3) {
          pushScale[corner] *= .5; reduced = true;
        }
      }
      if (!reduced) break;
    }
    const outer = cornerData.map((corner, index) => {
      const point = cornerPosition(index);
      if (corner.push * pushScale[index] > 1e-9) adjustedOuterVertices++;
      const vertex = vertices.length / 3;
      vertices.push(...point); vertexIds.push(meshId(nextId++));
      return vertex;
    });
    for (let i = 0; i < host.vertices.length; i++) {
      const inner = host.vertices[i], innerNext = host.vertices[(i + 1) % host.vertices.length];
      const outside = outer[i], outsideNext = outer[(i + 1) % outer.length];
      const quad = quads.length, id = meshId(nextId++);
      // [A,B,C,D] with A->B and A->C as the patch axes; pick the corner order whose normal points up, or the
      // whole collar ring renders back-faced. The host loop's traversal direction decides which order that is.
      const upward: number[] = [inner, innerNext, outside, outsideNext];
      const [A, B, C] = [readVertex(vertices, upward[0]), readVertex(vertices, upward[1]), readVertex(vertices, upward[2])];
      const normalY = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
      quads.push(normalY >= 0 ? upward : [innerNext, inner, outsideNext, outside]);
      quadIds.push(id); protectedQuadIds.push(id);
      quadPaint[quad] = source.baseSurface; collarPatches++;
      for (const [a, b] of [[inner, outside], [outside, outsideNext], [outsideNext, innerNext]] as [number, number][]) {
        const p0 = readVertex(vertices, a), p3 = readVertex(vertices, b), delta = sub(p3, p0);
        edgeHandles[directedEdgeKey(a, b)] = delta.map(value => value / 3) as V3;
        edgeHandles[directedEdgeKey(b, a)] = delta.map(value => -value / 3) as V3;
      }
      const start = alignment.corners[i];
      const end = i + 1 < alignment.corners.length ? alignment.corners[i + 1] : alignment.sequence.length;
      const boundaryPoints = Array.from({ length: end - start + 1 }, (_unused, local) =>
        candidate.vertices[alignment.sequence[(start + local) % alignment.sequence.length]]);
      boundaryPoints[0] = readVertex(vertices, outside);
      boundaryPoints[boundaryPoints.length - 1] = readVertex(vertices, outsideNext);
      // The outer collar is a topology handoff, not a source feature. A least-squares cubic through a dense
      // candidate run can overshoot between outward-adjusted endpoints and put the candidate's first row back
      // through the collar. Keep this edge inside its endpoint chord; surface fitting restores the mountain
      // height while the exact inner trail cubic still supplies the authored curvature.
      const p0 = boundaryPoints[0], p3 = boundaryPoints[boundaryPoints.length - 1];
      const cp = linearCubic(p0, p3);
      edgeHandles[directedEdgeKey(outside, outsideNext)] = sub(cp[1], p0);
      edgeHandles[directedEdgeKey(outsideNext, outside)] = sub(cp[2], p3);
      interfaceCurves.push({
        edgeVertexIds: [vertexIds[outside], vertexIds[outsideNext]],
        samples: Array.from({ length: 9 }, (_unused, step) => cubicPoint(...cp, step / 8)),
      });
    }
    collarLoops.push({ innerEdges: host.vertices.length, outerCandidateEdges: candidateLoop.length });
  }
  const augmented: QuadMeshDoc = {
    ...source,
    vertices, vertexIds, quads, quadIds, nextId, edgeHandles, quadPaint, quadLocked,
  };
  return {
    source: augmented,
    constraints: { ...constraints, protectedQuadIds, interface: interfaceCurves },
    refinement: {
      mesh: candidate,
      fixedBoundary: candidateRefinement?.fixedBoundary ?? [...new Set(polygonBoundary(candidate).flat())],
      interfaceLoops: pairs.map(pair => pair.candidate),
      cornerVertices,
      tJunctions: candidateRefinement?.tJunctions ?? [],
      curveSegments: candidateRefinement?.curveSegments ?? [],
      addedPatches: candidateRefinement?.addedPatches ?? 0,
    },
    collarPatches,
    collarLoops,
    adjustedOuterVertices,
  };
}

function subcurve(cp: [V3, V3, V3, V3], t0: number, t1: number): [V3, V3, V3, V3] {
  let segment = t1 < 1 ? splitCubic(...cp, t1).left : cp.map(point => [...point] as V3) as [V3, V3, V3, V3];
  if (t0 > 0) segment = splitCubic(...segment, t0 / t1).right;
  return segment;
}

function snapLoop(
  host: HostLoop,
  candidateLoop: number[],
  mesh: PolygonMesh,
  snaps: Map<number, CandidateSnap>,
  curveSegments: CandidateCurveSegment[],
  arcLengthParameters = false,
  enforceProtectedSide = true,
  topologyAwareAlignment = false,
  knownCornerVertices?: readonly number[],
): number {
  const source = host.vertices.map(vertex => host.edges.find(edge => edge.a === vertex)!.cp[0]);
  let knownAlignment: { sequence: number[]; corners: number[] } | undefined;
  if (knownCornerVertices?.length === source.length && new Set(knownCornerVertices).size === source.length) {
    const offset = candidateLoop.indexOf(knownCornerVertices[0]);
    if (offset >= 0) for (const direction of [1, -1] as const) {
      const sequence = orderedCandidate(candidateLoop, offset, direction);
      const positions = new Map(sequence.map((vertex, position) => [vertex, position]));
      const corners = knownCornerVertices.map(vertex => positions.get(vertex) ?? -1);
      if (corners[0] === 0 && corners.every((position, index) => position >= 0
        && (!index || position > corners[index - 1]))) { knownAlignment = { sequence, corners }; break; }
    }
  }
  const { sequence, corners } = knownAlignment ?? (enforceProtectedSide && topologyAwareAlignment
    ? qualityCyclicAlignment(source, candidateLoop, mesh, host.edges)
    : bestCyclicAlignment(source, candidateLoop, mesh, host.edges, enforceProtectedSide));
  let maximumSnap2 = 0;
  for (let edgeIndex = 0; edgeIndex < host.edges.length; edgeIndex++) {
    const start = corners[edgeIndex], end = edgeIndex + 1 < corners.length ? corners[edgeIndex + 1] : sequence.length;
    const hostEdge = host.edges[edgeIndex];
    const count = end - start;
    const parameters = arcLengthParameters ? regularizedChordParameters(mesh, sequence, start, count)
      : Array.from({ length: count + 1 }, (_, local) => local === 0 ? 0 : local === count ? 1
      : nearestCubicParameter(mesh.vertices[sequence[start + local]], hostEdge.cp));
    // Candidate loop order is authoritative. Closest points can tie or cross slightly at high curvature, so
    // keep a tiny strictly increasing interval for every sub-edge without otherwise redistributing the loop.
    const epsilon = Math.min(1e-4, 0.1 / Math.max(1, count));
    for (let local = 1; local < count; local++) parameters[local] = Math.max(parameters[local], parameters[local - 1] + epsilon);
    for (let local = count - 1; local > 0; local--) parameters[local] = Math.min(parameters[local], parameters[local + 1] - epsilon);
    for (let at = start; at < end; at++) {
      const candidate = sequence[at], local = at - start;
      const t = parameters[local], point = cubicPoint(...hostEdge.cp, t);
      const sourceVertex = local === 0 ? hostEdge.a : undefined;
      const existing = snaps.get(candidate);
      if (existing && existing.sourceVertex !== sourceVertex) throw new Error('Candidate interface corner was assigned twice');
      snaps.set(candidate, { point, sourceVertex, host: hostEdge, t });
      maximumSnap2 = Math.max(maximumSnap2, distance2(mesh.vertices[candidate], point));
      const nextCandidate = sequence[(at + 1) % sequence.length], t1 = parameters[local + 1];
      curveSegments.push({ from: candidate, to: nextCandidate, cp: subcurve(hostEdge.cp, t, t1) });
    }
  }
  return Math.sqrt(maximumSnap2);
}

function connectedComponents(vertexCount: number, quads: readonly number[][]): number {
  const adjacency = Array.from({ length: vertexCount }, () => [] as number[]), used = new Set<number>();
  for (const quad of quads) for (const [a, b] of quadPerimeterEdges(quad)) {
    if (a === b) continue;
    adjacency[a].push(b); adjacency[b].push(a); used.add(a); used.add(b);
  }
  let components = 0;
  while (used.size) {
    components++;
    const stack = [used.values().next().value as number]; used.delete(stack[0]);
    while (stack.length) for (const neighbor of adjacency[stack.pop()!] ?? []) if (used.delete(neighbor)) stack.push(neighbor);
  }
  return components;
}

function candidateJacobians(vertices: readonly number[], quads: readonly number[][]): number[] {
  const points = Array.from({ length: vertices.length / 3 }, (_unused, vertex) => readVertex(vertices, vertex));
  return quads.map(([A, B, C, D]) => polygonFaceJacobian(points, [A, B, D, C]));
}

/**
 * Merge a denser QuadWild hole boundary into exact locked Bezier edges. Locked corners are conforming shared
 * vertices; additional remesh vertices become explicit T-nodes and inherit exact cubic sub-edge handles.
 */
export function integrateRetopologyCandidate(
  source: QuadMeshDoc,
  candidateInput: PolygonMesh,
  constraints: RetopologyConstraints,
  name = `${source.name}_RETOPO_QUADWILD_INTEGRATED`,
  preparedRefinement?: CandidateRefinement,
  integrationOptions: RetopologyIntegrationOptions = {},
): IntegratedRetopology {
  if (candidateInput.faces.some(face => face.length !== 4)) throw new Error('Integrated SlopeSmith output currently requires all-quad candidates');
  const protectedIds = new Set(constraints.protectedQuadIds), protectedQuads = source.quadIds
    .map((id, index) => protectedIds.has(id) ? index : -1).filter(index => index >= 0);
  const protectedVertices = new Set(protectedQuads.flatMap(quad => source.quads[quad]));
  const wholeSurface = constraints.options.wholeSurface === true;
  const hosts = wholeSurface ? [] : hostLoops(source, constraints);
  const initialPairs = preparedRefinement
    ? pairKnownInterfaceLoops(hosts, preparedRefinement.interfaceLoops, preparedRefinement.mesh)
    : pairInterfaceLoops(hosts, candidateInput);
  const refinement: CandidateRefinement = preparedRefinement ?? (constraints.options.refineBoundaryCorners === false ? {
    mesh: candidateInput,
    fixedBoundary: [...new Set(polygonBoundary(candidateInput).flat())],
    interfaceLoops: initialPairs.map(pair => pair.candidate),
    tJunctions: [], curveSegments: [], addedPatches: 0,
  } : refineCandidateBoundary(candidateInput, initialPairs));
  const candidate = refinement.mesh, pairs = initialPairs.map((pair, index) => ({
    host: pair.host, candidate: refinement.interfaceLoops[index], cornerVertices: refinement.cornerVertices?.[index],
  }));

  const snaps = new Map<number, CandidateSnap>(), curveSegments: CandidateCurveSegment[] = [];
  let maximumBoundarySnapM = 0;
  for (const pair of pairs) maximumBoundarySnapM = Math.max(maximumBoundarySnapM,
    snapLoop(pair.host, pair.candidate, candidate, snaps, curveSegments,
      constraints.options.arcLengthInterfaceParameters === true,
      integrationOptions.enforceProtectedSide !== false,
      integrationOptions.topologyAwareAlignment === true,
      pair.cornerVertices));

  const interfaceVertexSet = new Set(refinement.interfaceLoops.flat());
  const trueBoundary = new Set([...refinement.fixedBoundary, ...interfaceVertexSet]);
  let fixedBoundary = new Set(trueBoundary);
  const snappedCandidate: PolygonMesh = {
    vertices: deformCandidateToSnaps(candidate, snaps, trueBoundary, refinement.tJunctions),
    faces: candidate.faces,
  };
  const beforeRelax = candidate.faces.map(face => polygonFaceJacobian(snappedCandidate.vertices, face));
  let relaxed = relaxFoldedCandidate(snappedCandidate, fixedBoundary, 240, refinement.tJunctions);
  const initiallyFolded = candidate.faces.map(face => polygonFaceJacobian(relaxed.vertices, face));
  const releasableRim = new Set(candidate.faces.flatMap((face, patch) => initiallyFolded[patch] <= 0
    && face.some(vertex => interfaceVertexSet.has(vertex))
    ? face.filter(vertex => trueBoundary.has(vertex) && !interfaceVertexSet.has(vertex)) : []));
  if (releasableRim.size) {
    const fallbackFixed = new Set([...trueBoundary].filter(vertex => !releasableRim.has(vertex)));
    const fallback = relaxFoldedCandidate(snappedCandidate, fallbackFixed, 360, refinement.tJunctions);
    const fallbackQuality = candidate.faces.map(face => polygonFaceJacobian(fallback.vertices, face));
    const score = (quality: readonly number[]) => ({
      inverted: quality.filter(value => value <= 0).length,
      minimum: Math.min(...quality),
    });
    const before = score(initiallyFolded), after = score(fallbackQuality);
    if (after.inverted < before.inverted || (after.inverted === before.inverted && after.minimum > before.minimum)) {
      relaxed = fallback; fixedBoundary = fallbackFixed;
    }
  }
  let regularizedCandidateVertices = 0;
  if (wholeSurface || constraints.options.regularizeCandidate === true) {
    const beforeRegularize = candidateShapeDistributions({ vertices: relaxed.vertices, faces: candidate.faces });
    const regularized = regularizeCandidateShape(
      { vertices: relaxed.vertices, faces: candidate.faces },
      fixedBoundary,
      beforeRegularize.equivalentSize.median || constraints.options.targetPatchSizeM,
    );
    relaxed.vertices = regularized.vertices;
    regularizedCandidateVertices = regularized.moved;
  }
  const collapsedInterfaceFaces: number[] = [];
  const cornerVertexSet = new Set(refinement.cornerVertices?.flat() ?? []);
  const incidentCandidateFaces = new Map<number, number>();
  for (const face of candidate.faces) for (const vertex of new Set(face)) {
    incidentCandidateFaces.set(vertex, (incidentCandidateFaces.get(vertex) ?? 0) + 1);
  }
  const outputCandidateFaces = candidate.faces.map((face, patch) => {
    const jacobian = polygonFaceJacobian(relaxed.vertices, face);
    // A numerically flat boundary quad is a triangle carrying one redundant surplus knot. Its fourth corner
    // may itself sit on the interface (an ear filling a collar notch), so three or four interface corners
    // both qualify. The sign of a ~zero Jacobian is floating-point noise, so the flatness window is symmetric.
    if (integrationOptions.collapseFlatInterfaceFaces !== true || jacobian > 1e-10 || jacobian < -1e-10
      || face.filter(vertex => interfaceVertexSet.has(vertex)).length < 3) return [...face];
    const middle = face.find((vertex, corner) => interfaceVertexSet.has(vertex)
      && interfaceVertexSet.has(face[(corner + 3) % 4])
      && interfaceVertexSet.has(face[(corner + 1) % 4])
      && !cornerVertexSet.has(vertex)
      && incidentCandidateFaces.get(vertex) === 1);
    if (middle === undefined) return [...face];
    const triangle = face.filter(vertex => vertex !== middle);
    collapsedInterfaceFaces.push(patch);
    return [triangle[0], triangle[1], triangle[2], triangle[2]];
  });
  const relaxedQuality = outputCandidateFaces.map(face => polygonFaceJacobian(relaxed.vertices, face));
  const candidateShape = candidateShapeDistributions({ vertices: relaxed.vertices, faces: candidate.faces });
  const interfaceEdgeSet = new Set(refinement.interfaceLoops.flatMap(loop => loop.map((vertex, index) =>
    undirectedEdgeKey(vertex, loop[(index + 1) % loop.length]))));
  const protectedOutlineSamples = integrationOptions.conformingSeams === true ? 1 : 6;
  const protectedPolygons = hosts.map(host => host.edges.flatMap(edge =>
    Array.from({ length: protectedOutlineSamples }, (_unused, sample) => {
      const point = cubicPoint(...edge.cp, sample / protectedOutlineSamples);
      return [point[0], point[2]] as [number, number];
    })));
  const protectedFootprint = tessellateQuads(source, new Set(protectedQuads),
    integrationOptions.conformingSeams === true ? 1 : 4);
  const protectedFootprintTriangles: ProjectedTriangle[] = protectedFootprint.faces
    .filter(face => face.length === 3).map(face => [
      [protectedFootprint.vertices[face[0]][0], protectedFootprint.vertices[face[0]][2]],
      [protectedFootprint.vertices[face[1]][0], protectedFootprint.vertices[face[1]][2]],
      [protectedFootprint.vertices[face[2]][0], protectedFootprint.vertices[face[2]][2]],
    ]);
  const overlappingProtectedFaces = polygonsIntersectProjectedTriangles(outputCandidateFaces.map((face, id) => ({
    id,
    points: face.map(vertex => [relaxed.vertices[vertex][0], relaxed.vertices[vertex][2]] as const),
  })), protectedFootprintTriangles);
  const testedCrossEdges = new Set<string>();
  const crossingInterfaceFaces = new Set<number>();
  let crossingInterfaceEdges = 0;
  for (let faceIndex = 0; faceIndex < outputCandidateFaces.length; faceIndex++) {
    const face = outputCandidateFaces[faceIndex];
    for (let corner = 0; corner < face.length; corner++) {
    const a = face[corner], b = face[(corner + 1) % face.length], key = undirectedEdgeKey(a, b);
    if (interfaceEdgeSet.has(key) || interfaceVertexSet.has(a) === interfaceVertexSet.has(b)) continue;
    const pa = relaxed.vertices[a], pb = relaxed.vertices[b];
    const projectedA: [number, number] = [pa[0], pa[2]], projectedB: [number, number] = [pb[0], pb[2]];
    if (!protectedPolygons.some(polygon => polygon.some((point, edge) => projectedSegmentsProperlyCross(
      projectedA, projectedB, point, polygon[(edge + 1) % polygon.length], 1e-7)))) continue;
    crossingInterfaceFaces.add(faceIndex);
    if (!testedCrossEdges.has(key)) { testedCrossEdges.add(key); crossingInterfaceEdges++; }
    }
  }

  const vertices: number[] = [], vertexIds: string[] = [], sourceToNew = new Map<number, number>();
  for (const sourceVertex of [...protectedVertices].sort((a, b) => a - b)) {
    sourceToNew.set(sourceVertex, vertices.length / 3);
    vertices.push(...readVertex(source.vertices, sourceVertex)); vertexIds.push(source.vertexIds[sourceVertex]);
  }
  let nextId = source.nextId;
  const candidateToNew = new Map<number, number>();
  const usedCandidateVertices = new Set(outputCandidateFaces.flat());
  for (let vertex = 0; vertex < candidate.vertices.length; vertex++) {
    if (!usedCandidateVertices.has(vertex)) continue;
    const snap = snaps.get(vertex);
    if (snap?.sourceVertex !== undefined) {
      const mapped = sourceToNew.get(snap.sourceVertex);
      if (mapped === undefined) throw new Error('Protected interface corner is not owned by a protected patch');
      candidateToNew.set(vertex, mapped); continue;
    }
    candidateToNew.set(vertex, vertices.length / 3);
    vertices.push(...relaxed.vertices[vertex]); vertexIds.push(meshId(nextId++));
  }

  const quads: number[][] = [], quadIds: string[] = [];
  const quadPaint: Record<number, number> = {}, quadTex: Record<number, string> = {};
  const quadOrient: Record<number, { rot: number; mirror: boolean }> = {}, quadLocked: Record<number, true> = {};
  const quadTwist: Record<number, [V3, V3, V3, V3]> = {};
  const oldQuadToNew = new Map<number, number>();
  for (const oldQuad of protectedQuads) {
    const mapped = source.quads[oldQuad].map(vertex => sourceToNew.get(vertex)!);
    const at = quads.length; oldQuadToNew.set(oldQuad, at); quads.push(mapped); quadIds.push(source.quadIds[oldQuad]);
    quadPaint[at] = source.quadPaint?.[oldQuad] ?? source.baseSurface;
    if (source.quadTex?.[oldQuad]) quadTex[at] = source.quadTex[oldQuad];
    if (source.quadOrient?.[oldQuad]) quadOrient[at] = { ...source.quadOrient[oldQuad] };
    if (source.quadLocked?.[oldQuad] === true) quadLocked[at] = true;
  }
  const original = deriveQuadMesh(source);
  const preserveSurfacePaint = integrationOptions.preserveSurfacePaint === true || wholeSurface;
  const remeshIds = new Set(constraints.remeshQuadIds);
  const transferableSourceQuads = source.quadIds
    .map((id, sourceQuad) => remeshIds.has(id) || wholeSurface ? sourceQuad : -1)
    .filter(sourceQuad => sourceQuad >= 0);
  const sourceCenters = preserveSurfacePaint ? transferableSourceQuads.map(sourceQuad => ({
    sourceQuad,
    point: patchPoint(quadControlPoints(original.mesh, original.edgeHandle, sourceQuad, original.twistOf(sourceQuad)), .5, .5),
  })) : [];
  const nearestSourceQuad = (point: V3): number => {
    let best = transferableSourceQuads[0] ?? 0, bestDistance = Infinity;
    for (const candidate of sourceCenters) {
      const distance = distance2(point, candidate.point);
      if (distance < bestDistance) { bestDistance = distance; best = candidate.sourceQuad; }
    }
    return best;
  };
  let transferredLockedPatches = 0;
  for (const face of outputCandidateFaces) {
    // Candidate OBJ faces use perimeter order [A,B,D,C]; SlopeSmith stores [A,B,C,D].
    const at = quads.length;
    quads.push([candidateToNew.get(face[0])!, candidateToNew.get(face[1])!,
      candidateToNew.get(face[3])!, candidateToNew.get(face[2])!]);
    quadIds.push(meshId(nextId++));
    if (preserveSurfacePaint) {
      const center = face.reduce((sum, vertex): V3 => add(sum, relaxed.vertices[vertex]), [0, 0, 0] as V3)
        .map(value => value / face.length) as V3;
      const sourceQuad = nearestSourceQuad(center);
      quadPaint[at] = source.quadPaint?.[sourceQuad] ?? source.baseSurface;
      if (source.quadTex?.[sourceQuad]) quadTex[at] = source.quadTex[sourceQuad];
      if (source.quadOrient?.[sourceQuad]) quadOrient[at] = { ...source.quadOrient[sourceQuad] };
      if (wholeSurface && source.quadLocked?.[sourceQuad] === true) { quadLocked[at] = true; transferredLockedPatches++; }
    }
  }

  const edgeHandles: Record<string, V3> = {};
  for (const oldQuad of protectedQuads) {
    const newQuad = oldQuadToNew.get(oldQuad)!;
    const twist = original.twistOf(oldQuad);
    if (twist) quadTwist[newQuad] = twist.map(point => [...point] as V3) as [V3, V3, V3, V3];
    for (const [a, b] of quadPerimeterEdges(source.quads[oldQuad])) {
      const na = sourceToNew.get(a)!, nb = sourceToNew.get(b)!;
      edgeHandles[directedEdgeKey(na, nb)] = [...original.edgeHandle(a, b)] as V3;
      edgeHandles[directedEdgeKey(nb, na)] = [...original.edgeHandle(b, a)] as V3;
    }
  }
  for (const segment of [...refinement.curveSegments, ...curveSegments]) {
    const from = candidateToNew.get(segment.from), to = candidateToNew.get(segment.to);
    if (from === undefined || to === undefined) continue;
    const cp = refinement.curveSegments.includes(segment)
      ? linearCubic(relaxed.vertices[segment.from], relaxed.vertices[segment.to]) : segment.cp;
    edgeHandles[directedEdgeKey(from, to)] = sub(cp[1], cp[0]);
    edgeHandles[directedEdgeKey(to, from)] = sub(cp[2], cp[3]);
  }
  // At an extraordinary seam vertex the automatic Bessel "opposite" edge is ambiguous and can aim the
  // first generated control row back underneath the locked feature. Keep every cross-interface cage edge
  // linear for its first patch span; the next generated ring resumes the ordinary shared smooth defaults.
  const interfaceVertices = new Set(refinement.interfaceLoops.flat());
  const interfaceEdges = new Set(refinement.interfaceLoops.flatMap(loop => loop.map((vertex, index) =>
    undirectedEdgeKey(vertex, loop[(index + 1) % loop.length]))));
  for (const face of outputCandidateFaces) for (let corner = 0; corner < face.length; corner++) {
    const a = face[corner], b = face[(corner + 1) % face.length];
    if (interfaceEdges.has(undirectedEdgeKey(a, b)) || (!interfaceVertices.has(a) && !interfaceVertices.has(b))) continue;
    const from = candidateToNew.get(a)!, to = candidateToNew.get(b)!;
    const delta = sub(relaxed.vertices[b], relaxed.vertices[a]);
    edgeHandles[directedEdgeKey(from, to)] = delta.map(value => value / 3) as V3;
    edgeHandles[directedEdgeKey(to, from)] = delta.map(value => -value / 3) as V3;
  }
  // Candidate boundary segments and first-row stabilizers share endpoint ids with the exact protected edge.
  // Reassert protected handles last so a coincident candidate key can never flatten or otherwise overwrite
  // the authored feature/collar cubic that its T-nodes were snapped against.
  for (const oldQuad of protectedQuads) for (const [a, b] of quadPerimeterEdges(source.quads[oldQuad])) {
    const from = sourceToNew.get(a)!, to = sourceToNew.get(b)!;
    edgeHandles[directedEdgeKey(from, to)] = [...original.edgeHandle(a, b)] as V3;
    edgeHandles[directedEdgeKey(to, from)] = [...original.edgeHandle(b, a)] as V3;
  }

  const tJunctions: EdgeEmbeddedTJunction[] = refinement.tJunctions.flatMap(node => {
    const vertex = candidateToNew.get(node.vertex), a = candidateToNew.get(node.edge[0]), b = candidateToNew.get(node.edge[1]);
    return vertex === undefined || a === undefined || b === undefined ? [] : [{ vertex, edge: [a, b], t: node.t }];
  });
  for (const [candidateVertex, snap] of snaps) {
    if (snap.sourceVertex !== undefined || snap.t <= 1e-3 || snap.t >= 1 - 1e-3) continue;
    const vertex = candidateToNew.get(candidateVertex);
    if (vertex === undefined) continue;
    tJunctions.push({
      vertex,
      edge: [sourceToNew.get(snap.host.a)!, sourceToNew.get(snap.host.b)!],
      t: snap.t,
    });
  }
  // A regional solve promises that the outside document is exact, including topology metadata that does not
  // belong to a patch record. Carry only source records whose complete support survived in the protected set.
  for (const node of source.tJunctions ?? []) {
    const vertex = sourceToNew.get(node.vertex), a = sourceToNew.get(node.edge[0]), b = sourceToNew.get(node.edge[1]);
    if (vertex !== undefined && a !== undefined && b !== undefined) tJunctions.push({ vertex, edge: [a, b], t: node.t });
  }
  const freeEdges = (source.freeEdges ?? []).flatMap(([a, b]) => {
    const mappedA = sourceToNew.get(a), mappedB = sourceToNew.get(b);
    return mappedA === undefined || mappedB === undefined ? [] : [[mappedA, mappedB] as [number, number]];
  });
  const tombstones = [...new Set([
    ...(source.tombstones ?? []),
    ...source.vertexIds.filter((_id, vertex) => !sourceToNew.has(vertex)),
    ...source.quadIds.filter((_id, quad) => !oldQuadToNew.has(quad)),
  ])];

  const document: QuadMeshDoc = {
    ...source,
    name,
    vertices, vertexIds, quads, quadIds, nextId, tombstones,
    freeEdges, tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist,
    linearCage: false,
  };

  const integrated = deriveQuadMesh(document);
  let protectedControlDeviationM = 0;
  for (const oldQuad of protectedQuads) {
    const newQuad = oldQuadToNew.get(oldQuad)!;
    const before = quadControlPoints(original.mesh, original.edgeHandle, oldQuad, original.twistOf(oldQuad));
    const after = quadControlPoints(integrated.mesh, integrated.edgeHandle, newQuad, integrated.twistOf(newQuad));
    for (let i = 0; i < 16; i++) protectedControlDeviationM = Math.max(protectedControlDeviationM, len(sub(before[i], after[i])));
  }
  const candidateQuality = candidateJacobians(vertices, quads.slice(protectedQuads.length));
  const interfaceWedgeSplits = relaxedQuality.flatMap((jacobian, patch): { face: number; diagonal: 'ac' | 'bd' }[] => {
    const face = outputCandidateFaces[patch];
    if (jacobian > 0 || face.filter(vertex => interfaceVertexSet.has(vertex)).length < 3) return [];
    const [a, b, c, d] = face;
    const projected = (vertex: number): [number, number] =>
      [relaxed.vertices[vertex][0], relaxed.vertices[vertex][2]];
    const score = (diagonal: 'ac' | 'bd') => {
      const pairs = diagonal === 'ac' ? [[a, c], [a, b, c], [a, c, d]] : [[b, d], [b, c, d], [b, d, a]];
      const [edge, ...triangles] = pairs;
      const p0 = projected(edge[0]), p1 = projected(edge[1]);
      const midpoint: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      let invalid = protectedPolygons.some(polygon => pointStrictlyInProjectedPolygon(midpoint, polygon, 1e-7)
        || polygon.some((point, index) => projectedSegmentsProperlyCross(
          p0, p1, point, polygon[(index + 1) % polygon.length], 1e-7))) ? 1 : 0;
      for (const triangle of triangles) {
        const points = triangle.map(projected);
        const center: [number, number] = [
          (points[0][0] + points[1][0] + points[2][0]) / 3,
          (points[0][1] + points[1][1] + points[2][1]) / 3,
        ];
        if (protectedPolygons.some(polygon => pointStrictlyInProjectedPolygon(center, polygon, 1e-7))) invalid++;
      }
      return invalid * 1e12 + distance2(relaxed.vertices[edge[0]], relaxed.vertices[edge[1]]);
    };
    return [{ face: patch, diagonal: score('ac') <= score('bd') ? 'ac' : 'bd' }];
  });
  return {
    document,
    report: {
      protectedPatches: protectedQuads.length,
      candidatePatches: candidate.faces.length,
      sourceInterfaceEdges: hosts.reduce((sum, loop) => sum + loop.edges.length, 0),
      candidateInterfaceEdges: pairs.reduce((sum, pair) => sum + pair.candidate.length, 0),
      embeddedTJunctions: tJunctions.length,
      connectedComponents: connectedComponents(vertices.length / 3, quads),
      protectedControlDeviationM,
      maximumBoundarySnapM,
      minimumCandidateCornerJacobian: Math.min(...candidateQuality),
      invertedCandidatePatches: candidateQuality.filter(value => value <= 0).length,
      invertedCandidatePatchesBeforeRelax: beforeRelax.filter(value => value <= 0).length,
      relaxedCandidateVertices: relaxed.moved,
      worstCandidatePatches: relaxedQuality
        .map((jacobian, patch) => ({ patch, jacobian,
          fixedVertices: outputCandidateFaces[patch].filter(vertex => fixedBoundary.has(vertex)).length,
          interfaceVertices: outputCandidateFaces[patch].filter(vertex => interfaceVertexSet.has(vertex)).length }))
        .sort((a, b) => a.jacobian - b.jacobian)
        .slice(0, 12),
      interfaceLoops: pairs.map(pair => ({ protectedEdges: pair.host.edges.length, candidateEdges: pair.candidate.length })),
      maximumCornerSnapM: Math.sqrt(Math.max(0, ...[...snaps.entries()]
        .filter(([, snap]) => snap.sourceVertex !== undefined)
        .map(([vertex]) => distance2(candidate.vertices[vertex], snaps.get(vertex)!.point)))),
      crossingInterfaceEdges,
      crossingInterfaceFaces: [...crossingInterfaceFaces].sort((a, b) => a - b),
      overlappingProtectedFaces,
      invertedInterfaceFaces: relaxedQuality
        .map((jacobian, patch) => jacobian <= 0 && outputCandidateFaces[patch]
          .some(vertex => interfaceVertexSet.has(vertex)) ? patch : -1)
        .filter(patch => patch >= 0),
      triangulatableInterfaceFaces: relaxedQuality
        .map((jacobian, patch) => jacobian <= 0 && outputCandidateFaces[patch]
          .filter(vertex => interfaceVertexSet.has(vertex)).length >= 3 ? patch : -1)
        .filter(patch => patch >= 0),
      collapsedInterfaceFaces,
      interfaceWedgeSplits,
      boundaryRefinementPatches: refinement.addedPatches,
      boundaryRefinementTJunctions: refinement.tJunctions.length,
      transferredLockedPatches,
      regularizedCandidateVertices,
      candidateEdgeLengthM: candidateShape.edgeLength,
      candidateAspectRatio: candidateShape.aspect,
      candidateEquivalentSizeM: candidateShape.equivalentSize,
    },
  };
}
