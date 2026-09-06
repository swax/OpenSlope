/** Fit a generated quad chart back onto the single-valued source mountain: top-down height sampling plus
 * the optional bounded shared twist field. */
import type { QuadMeshDoc, V3 } from '../../doc/types';
import { deriveQuadMesh } from '../../doc/mountain';
import { patchPoint } from '../../math/bezier';
import { readVertex, writeVertex } from '../primitives';
import { meshAdjacency, quadControlPoints } from '../topology';
import { tessellateQuads } from './benchmark';
import { distribution, type DistributionSummary } from './integrate-shape';

export interface BezierSurfaceFitReport {
  fittedVertices: number;
  fittedPatches: number;
  missedHeightSamples: number;
  maximumVertexCorrectionM: number;
  maximumInteriorControlCorrectionM: number;
  rejectedAmbiguousHeightSamples: number;
  clampedInteriorControls: number;
  sourceTessellationResolution: number;
  sharedTwistVertices: number;
  sharedInteriorControls: number;
  maximumInteriorControlLimitM: number;
  interiorControlCorrectionM: DistributionSummary;
  twistSmoothingIterations: number;
}

export interface BezierSurfaceFitOptions {
  /** Opt into a bounded shared twist field. The retail-faithful default is pure zero-twist Ferguson. */
  fitInteriorControls?: boolean;
  /** Maximum vertical offset from a generated patch's zero-twist interior control point. */
  maximumTwistCorrectionM?: number;
  /** Neighbor averaging passes over the shared per-vertex twist field. */
  twistSmoothingIterations?: number;
  /** Strength of the fitted value versus the neighbor average during smoothing. */
  twistDataWeight?: number;
  /** Maximum vertical vertex seating correction. Defaults to one authored source spacing. */
  maximumSampleCorrectionM?: number;
}

interface HeightTriangle { a: V3; b: V3; c: V3 }

/** A compact top-down acceleration structure for the production terrain case. The source mountain is sampled
 * from its actual bicubic quilt; a query answers the projected height nearest `nearY` at x/z. Vertical/cave
 * faces intentionally do not participate in this 2.5D sampler. Exported for the fitter here and for the API's
 * ground query (docs/052), which asks with a `nearY` above everything to read the uppermost surface. */
export function surfaceHeightSampler(source: QuadMeshDoc, resolution: number): (x: number, z: number, nearY: number) => number | null {
  const quads = new Set(Array.from({ length: source.quads.length }, (_unused, q) => q));
  const mesh = tessellateQuads(source, quads, resolution);
  const triangles: HeightTriangle[] = mesh.faces.flatMap(face => face.length === 3
    ? [{ a: mesh.vertices[face[0]], b: mesh.vertices[face[1]], c: mesh.vertices[face[2]] }]
    : []);
  if (!triangles.length) return () => null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const { a, b, c } of triangles) for (const point of [a, b, c]) {
    minX = Math.min(minX, point[0]); minZ = Math.min(minZ, point[2]);
    maxX = Math.max(maxX, point[0]); maxZ = Math.max(maxZ, point[2]);
  }
  const size = Math.max(16, Math.min(256, Math.ceil(Math.sqrt(triangles.length / 2))));
  const width = Math.max(1e-9, maxX - minX), depth = Math.max(1e-9, maxZ - minZ);
  const cellX = (x: number) => Math.max(0, Math.min(size - 1, Math.floor((x - minX) / width * size)));
  const cellZ = (z: number) => Math.max(0, Math.min(size - 1, Math.floor((z - minZ) / depth * size)));
  const bins = new Map<number, number[]>();
  const insert = (key: number, triangle: number) => {
    const bin = bins.get(key);
    if (bin) bin.push(triangle); else bins.set(key, [triangle]);
  };
  triangles.forEach(({ a, b, c }, triangle) => {
    const x0 = cellX(Math.min(a[0], b[0], c[0])), x1 = cellX(Math.max(a[0], b[0], c[0]));
    const z0 = cellZ(Math.min(a[2], b[2], c[2])), z1 = cellZ(Math.max(a[2], b[2], c[2]));
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) insert(z * size + x, triangle);
  });
  return (x: number, z: number, nearY: number): number | null => {
    const cx = cellX(x), cz = cellZ(z);
    let best: number | null = null, bestDistance = Infinity;
    const tested = new Set<number>();
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const bx = cx + dx, bz = cz + dz;
      if (bx < 0 || bx >= size || bz < 0 || bz >= size) continue;
      for (const triangle of bins.get(bz * size + bx) ?? []) {
        if (tested.has(triangle)) continue;
        tested.add(triangle);
        const { a, b, c } = triangles[triangle];
        const denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(denominator) < 1e-12) continue;
        const wa = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
        const wb = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
        const wc = 1 - wa - wb;
        if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
        const height = wa * a[1] + wb * b[1] + wc * c[1];
        const distance = Math.abs(height - nearY);
        if (distance < bestDistance) { best = height; bestDistance = distance; }
      }
    }
    return best;
  };
}

function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const n = rhs.length, rows = matrix.map((row, i) => [...row, rhs[i]]);
  for (let column = 0; column < n; column++) {
    let pivot = column;
    for (let row = column + 1; row < n; row++)
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < 1e-12) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let at = column; at <= n; at++) rows[column][at] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let at = column; at <= n; at++) rows[row][at] -= factor * rows[column][at];
    }
  }
  return rows.map(row => row[n]);
}

const bernstein3 = (t: number): [number, number, number, number] => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

/** Fit a coarse generated quad chart back to a single-valued source mountain using the shape channels SSX
 * actually stores. The caller chooses the byte-preserved leading patch set (normally the exact trail; an
 * integration-only collar may remain fit-able). Unfrozen vertices are vertically seated on the source and
 * default to retail-like zero-twist Ferguson controls.
 * The optional experimental interior fit is first estimated per patch, then collapsed to one bounded value
 * per shared cage vertex and smoothed over the generated mesh. Every incident patch thus receives the same
 * corner twist instead of independently overfitting its samples. Shared Bessel boundary curves stay intact. */
export function fitBezierSurfaceHeight(
  source: QuadMeshDoc,
  input: QuadMeshDoc,
  frozenPatchCount: number,
  sourceTessellationResolution = 8,
  options: BezierSurfaceFitOptions = {},
): { document: QuadMeshDoc; report: BezierSurfaceFitReport } {
  const frozenCount = Math.max(0, Math.min(input.quads.length, Math.floor(frozenPatchCount)));
  const resolution = Math.max(2, Math.floor(sourceTessellationResolution));
  const heightAt = surfaceHeightSampler(source, resolution);
  const maximumSampleCorrectionM = Math.max(2, options.maximumSampleCorrectionM ?? (source.spacing || 25));
  const fitInteriorControls = options.fitInteriorControls === true;
  const maximumTwistCorrectionM = Math.max(0, options.maximumTwistCorrectionM
    ?? Math.max(2, Math.min(4, (source.spacing || 25) * .1)));
  const twistSmoothingIterations = fitInteriorControls
    ? Math.max(0, Math.min(20, Math.floor(options.twistSmoothingIterations ?? 5)))
    : 0;
  const twistDataWeight = Math.max(0, Math.min(1, options.twistDataWeight ?? .65));
  const frozenVertices = new Set(input.quads.slice(0, frozenCount).flat());
  for (const node of input.tJunctions ?? []) {
    frozenVertices.add(node.vertex); frozenVertices.add(node.edge[0]); frozenVertices.add(node.edge[1]);
  }
  const document: QuadMeshDoc = {
    ...input,
    vertices: [...input.vertices],
    edgeHandles: { ...(input.edgeHandles ?? {}) },
    quadTwist: Object.fromEntries(Object.entries(input.quadTwist ?? {})
      .map(([quad, twists]) => [quad, twists.map(point => [...point] as V3) as [V3, V3, V3, V3]])),
  };
  const generatedVertices = new Set(document.quads.slice(frozenCount).flat());
  let fittedVertices = 0, fittedPatches = 0, missedHeightSamples = 0;
  let rejectedAmbiguousHeightSamples = 0, clampedInteriorControls = 0;
  let maximumVertexCorrectionM = 0, maximumInteriorControlCorrectionM = 0;
  for (const vertex of generatedVertices) {
    if (frozenVertices.has(vertex)) continue;
    const point = readVertex(document.vertices, vertex), height = heightAt(point[0], point[2], point[1]);
    if (height === null) { missedHeightSamples++; continue; }
    if (Math.abs(height - point[1]) > maximumSampleCorrectionM) { rejectedAmbiguousHeightSamples++; continue; }
    maximumVertexCorrectionM = Math.max(maximumVertexCorrectionM, Math.abs(height - point[1]));
    writeVertex(document.vertices, vertex, [point[0], height, point[2]]); fittedVertices++;
  }
  if (!fitInteriorControls) for (let quad = frozenCount; quad < document.quads.length; quad++) {
    delete document.quadTwist![quad];
  }
  const derived = deriveQuadMesh(document), adjacency = meshAdjacency(derived.mesh);
  const interior = [5, 6, 9, 10] as const;
  const parameters: readonly [number, number][] = [.25, .5, .75]
    .flatMap(u => [.25, .5, .75].map(v => [u, v] as [number, number]));
  const suggestions = new Map<number, number[]>();
  for (let quad = frozenCount; fitInteriorControls && quad < document.quads.length; quad++) {
    const zero = quadControlPoints(derived.mesh, derived.edgeHandle, quad, null);
    const existing = document.quadTwist?.[quad] ?? [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const current = quadControlPoints(derived.mesh, derived.edgeHandle, quad, existing);
    const matrix: number[][] = [], rhs: number[] = [];
    let valid = true;
    for (const [u, v] of parameters) {
      const point = patchPoint(current, u, v), target = heightAt(point[0], point[2], point[1]);
      if (target === null) { missedHeightSamples++; valid = false; break; }
      if (Math.abs(target - point[1]) > maximumSampleCorrectionM) {
        rejectedAmbiguousHeightSamples++; valid = false; break;
      }
      const bu = bernstein3(u), bv = bernstein3(v);
      const weights = [bu[1] * bv[1], bu[1] * bv[2], bu[2] * bv[1], bu[2] * bv[2]];
      const existingInterior = weights.reduce((sum, weight, i) => sum + weight * current[interior[i]][1], 0);
      matrix.push(weights);
      rhs.push(target - (patchPoint(current, u, v)[1] - existingInterior));
    }
    if (!valid) continue;
    // Least squares over a 3x3 interior sample grid. A small prior toward the current control net avoids the
    // large oscillating controls produced by exact interpolation on a skewed patch.
    const currentInterior = interior.map(index => current[index][1]);
    const regularization = .03;
    const normal = Array.from({ length: 4 }, () => new Array<number>(4).fill(0));
    const normalRhs = new Array<number>(4).fill(0);
    for (let sample = 0; sample < matrix.length; sample++) for (let i = 0; i < 4; i++) {
      normalRhs[i] += matrix[sample][i] * rhs[sample];
      for (let j = 0; j < 4; j++) normal[i][j] += matrix[sample][i] * matrix[sample][j];
    }
    for (let i = 0; i < 4; i++) {
      normal[i][i] += regularization;
      normalRhs[i] += regularization * currentInterior[i];
    }
    const solved = solveLinear(normal, normalRhs);
    if (!solved || solved.some(value => !Number.isFinite(value))) continue;
    for (let corner = 0; corner < 4; corner++) {
      const requested = solved[corner] - zero[interior[corner]][1];
      if (Math.abs(requested) > maximumTwistCorrectionM) clampedInteriorControls++;
      const vertex = document.quads[quad][corner], found = suggestions.get(vertex);
      if (found) found.push(requested); else suggestions.set(vertex, [requested]);
    }
    fittedPatches++;
  }

  // A patch-local least-squares fit can satisfy its own samples with a large positive/negative control pair,
  // even when every cage edge is clean. Use the median request at each global vertex as the robust data term,
  // then diffuse it into a low-frequency field. Vertices touching the exact trail stay zero-twist so fitting
  // cannot alter the character of the protected seam.
  const clampTwist = (value: number): number => Math.max(-maximumTwistCorrectionM,
    Math.min(maximumTwistCorrectionM, value));
  const data = new Map<number, number>(), twist = new Map<number, number>();
  for (const vertex of generatedVertices) {
    const values = [...(suggestions.get(vertex) ?? [])].sort((a, b) => a - b);
    const middle = values.length ? values[Math.floor(values.length / 2)] : 0;
    const value = frozenVertices.has(vertex) ? 0 : clampTwist(middle);
    data.set(vertex, value); twist.set(vertex, value);
  }
  for (let iteration = 0; iteration < twistSmoothingIterations; iteration++) {
    const next = new Map<number, number>();
    for (const vertex of generatedVertices) {
      if (frozenVertices.has(vertex)) { next.set(vertex, 0); continue; }
      const neighbors = adjacency.neighbors[vertex].filter(neighbor => generatedVertices.has(neighbor));
      const average = neighbors.length
        ? neighbors.reduce((sum, neighbor) => sum + (twist.get(neighbor) ?? 0), 0) / neighbors.length
        : twist.get(vertex) ?? 0;
      next.set(vertex, clampTwist(twistDataWeight * (data.get(vertex) ?? 0) + (1 - twistDataWeight) * average));
    }
    twist.clear();
    for (const [vertex, value] of next) twist.set(vertex, value);
  }

  const controlCorrections: number[] = [];
  if (fitInteriorControls) for (let quad = frozenCount; quad < document.quads.length; quad++) {
    const existing = document.quadTwist?.[quad] ?? [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const twists = existing.map(point => [...point] as V3) as [V3, V3, V3, V3];
    for (let corner = 0; corner < 4; corner++) {
      const correction = twist.get(document.quads[quad][corner]) ?? 0;
      twists[corner][1] = correction;
      controlCorrections.push(Math.abs(correction));
      maximumInteriorControlCorrectionM = Math.max(maximumInteriorControlCorrectionM, Math.abs(correction));
    }
    if (twists.some(point => point.some(value => Math.abs(value) > 1e-12))) document.quadTwist![quad] = twists;
    else delete document.quadTwist![quad];
  }
  return {
    document,
    report: {
      fittedVertices, fittedPatches, missedHeightSamples,
      maximumVertexCorrectionM, maximumInteriorControlCorrectionM,
      rejectedAmbiguousHeightSamples, clampedInteriorControls,
      sourceTessellationResolution: resolution,
      sharedTwistVertices: [...twist.values()].filter(value => Math.abs(value) > 1e-12).length,
      sharedInteriorControls: controlCorrections.length,
      maximumInteriorControlLimitM: maximumTwistCorrectionM,
      interiorControlCorrectionM: distribution(controlCorrections),
      twistSmoothingIterations,
    },
  };
}
