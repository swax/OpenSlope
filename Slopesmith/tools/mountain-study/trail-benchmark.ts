/**
 * Fit the parameterized trail law to copied reference centre seams and directly compare the generated
 * two-patch surface against the retail bicubic patches on the other side of those same seams.
 *
 * Junction-adjacent source edges are excluded: the retail maps use hand-knit valence fans there rather than
 * an ordinary three-rail ribbon. Every other source patch is sampled at matched centre-curve and cross-patch
 * parameters, so this is a geometric reconstruction test rather than a comparison of summary statistics.
 *
 * Usage:
 *   npx tsx tools/mountain-study/trail-benchmark.ts ../ResearchData/trails/centerlines
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { QuadMeshDoc, V3 } from '../../src/core/doc/types';
import { cubicPoint, patchPoint } from '../../src/core/math/bezier';
import { add, dot, len, mul, norm, sub } from '../../src/core/math/vec';
import { buildReferenceMesh, type RawPatch, type ReferenceMesh } from '../../src/core/reference/terrain';
import { meshAdjacency, meshFromDoc, quadControlPoints } from '../../src/core/mesh/topology';
import {
  MESA_TRAIL_DEFAULTS, applyTrailSpline, trailBankProfile,
  type TrailCubic, type TrailOptions, type TrailResult,
} from '../../src/core/mesh/trail';
import { MAPS_DIR, REPO_ROOT, evidencePath, tempFile } from './paths';

interface SelectionEdge { vertices: [number, number]; bezier: [V3, V3, V3, V3] | null }
interface SelectionFile {
  format: string;
  source: 'authored' | 'reference';
  referenceLevel?: string;
  referenceOffset?: V3;
  selection: { vertices: V3[]; edges: SelectionEdge[]; patches: number[][] };
}
interface PatchRecord extends RawPatch { PatchName?: string }

interface SourceEdge {
  index: number;
  local: [number, number];
  mesh: [number, number];
  cp: TrailCubic;
  faces: [number, number];
  lengthM: number;
  planLengthM: number;
  signedCurvature: number;
}
interface SourceRun {
  index: number;
  vertices: number[];
  edges: SourceEdge[];
  cubics: TrailCubic[];
}
interface StationObservation {
  center: V3;
  tangent: V3;
  right: V3;
  sourceMinus: V3;
  sourcePlus: V3;
  widthPlanM: number;
  centerBias: number;
  dishM: number;
  bankDegrees: number;
  signedCurvature: number;
}
interface RunObservations { run: SourceRun; stations: StationObservation[] }
interface Dataset {
  input: string;
  level: string;
  reference: ReferenceMesh;
  nativeVertices: V3[];
  graph: number[][];
  sourceEdges: SourceEdge[];
  excludedJunctionEdges: number;
  runs: SourceRun[];
  observations: RunObservations[];
}

const DEG = Math.PI / 180;
const clone = (p: readonly number[]): V3 => [p[0], p[1], p[2]];
const edgeKey = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`;
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const q = (values: readonly number[], at: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * clamp(at, 0, 1))];
};
const metric = (values: readonly number[]) => ({
  n: values.length,
  p10: q(values, .1),
  median: q(values, .5),
  p90: q(values, .9),
  p95: q(values, .95),
  max: values.length ? Math.max(...values) : NaN,
  rms: values.length ? Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length) : NaN,
});
const cubicLength = (cp: TrailCubic, plan = false, samples = 64): number => {
  let total = 0, previous = cp[0];
  for (let i = 1; i <= samples; i++) {
    const here = cubicPoint(cp[0], cp[1], cp[2], cp[3], i / samples);
    total += plan ? Math.hypot(here[0] - previous[0], here[2] - previous[2]) : len(sub(here, previous));
    previous = here;
  }
  return total;
};
const derivative = (cp: TrailCubic, t: number): V3 => {
  const s = 1 - t;
  return add(add(
    mul(sub(cp[1], cp[0]), 3 * s * s),
    mul(sub(cp[2], cp[1]), 6 * s * t),
  ), mul(sub(cp[3], cp[2]), 3 * t * t));
};
const signedPlanAngle = (a: V3, b: V3): number => {
  const al = Math.hypot(a[0], a[2]), bl = Math.hypot(b[0], b[2]);
  if (al < 1e-10 || bl < 1e-10) return 0;
  return Math.atan2(a[0] * b[2] - a[2] * b[0], a[0] * b[0] + a[2] * b[2]);
};
const cubicSignedCurvature = (cp: TrailCubic, samples = 64): number => {
  let signedTurn = 0, previous = derivative(cp, 0);
  for (let i = 1; i <= samples; i++) {
    const tangent = derivative(cp, i / samples);
    signedTurn += signedPlanAngle(previous, tangent); previous = tangent;
  }
  return signedTurn / Math.max(1e-6, cubicLength(cp, true, samples));
};
const reverseCubic = (cp: TrailCubic): TrailCubic => [clone(cp[3]), clone(cp[2]), clone(cp[1]), clone(cp[0])];
const emptyDoc = (level: string): QuadMeshDoc => ({
  kind: 'mountain', version: 5, name: `${level} TRAIL BENCHMARK`, spacing: 30,
  course: { knots: [], blend: 30, surface: 1 }, baseSurface: 1,
  vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
});

function sourceLaneEvaluator(reference: ReferenceMesh, face: number, from: number, to: number): (along: number, lateral: number) => V3 {
  const [A, B, C, D] = reference.mesh.quads[face];
  const controls = reference.patchControls[face] as V3[];
  const selected = edgeKey(from, to);
  if (selected === edgeKey(A, C)) {
    const forward = from === A;
    return (along, lateral) => patchPoint(controls, forward ? along : 1 - along, lateral);
  }
  if (selected === edgeKey(B, D)) {
    const forward = from === B;
    return (along, lateral) => patchPoint(controls, forward ? along : 1 - along, 1 - lateral);
  }
  if (selected === edgeKey(A, B)) {
    const forward = from === A;
    return (along, lateral) => patchPoint(controls, lateral, forward ? along : 1 - along);
  }
  if (selected === edgeKey(C, D)) {
    const forward = from === C;
    return (along, lateral) => patchPoint(controls, 1 - lateral, forward ? along : 1 - along);
  }
  throw new Error(`patch ${face} does not contain selected edge ${from},${to}`);
}

function buildRuns(edges: SourceEdge[], vertexCount: number): SourceRun[] {
  const incidence = Array.from({ length: vertexCount }, () => [] as SourceEdge[]);
  for (const edge of edges) { incidence[edge.local[0]].push(edge); incidence[edge.local[1]].push(edge); }
  const unwalked = new Set(edges.map(edge => edge.index));
  const runs: SourceRun[] = [];
  const walk = (start: number, first: SourceEdge): void => {
    const vertices = [start];
    const ordered: SourceEdge[] = [];
    let current = start, edge: SourceEdge | undefined = first;
    while (edge && unwalked.has(edge.index)) {
      unwalked.delete(edge.index);
      const next = edge.local[0] === current ? edge.local[1] : edge.local[0];
      const cp = edge.local[0] === current ? edge.cp : reverseCubic(edge.cp);
      ordered.push({
        ...edge,
        local: [current, next],
        mesh: edge.local[0] === current ? edge.mesh : [edge.mesh[1], edge.mesh[0]],
        cp,
        // Signed curvature is orientation-dependent. The copied edge direction is arbitrary; a run's is not.
        signedCurvature: cubicSignedCurvature(cp),
      });
      vertices.push(next); current = next;
      if (incidence[current].length !== 2) break;
      edge = incidence[current].find(candidate => unwalked.has(candidate.index));
    }
    if (ordered.length) runs.push({ index: runs.length, vertices, edges: ordered, cubics: ordered.map(item => item.cp) });
  };
  for (let vertex = 0; vertex < incidence.length; vertex++) {
    if (incidence[vertex].length === 2) continue;
    for (const edge of incidence[vertex]) if (unwalked.has(edge.index)) walk(vertex, edge);
  }
  // A component with no endpoints is a cycle. Break it at a deterministic edge for ordinary-ribbon fitting.
  while (unwalked.size) {
    const index = Math.min(...unwalked);
    const edge = edges.find(candidate => candidate.index === index)!;
    walk(Math.min(...edge.local), edge);
  }
  return runs;
}

function loadDataset(input: string): Dataset {
  const copied = JSON.parse(readFileSync(input, 'utf8')) as SelectionFile;
  if (copied.format !== 'slopesmith-mesh-selection' || copied.source !== 'reference' || !copied.referenceLevel)
    throw new Error(`${basename(input)} is not a copied reference centreline`);
  const level = copied.referenceLevel, offset = copied.referenceOffset ?? [0, 0, 0];
  const raw = JSON.parse(readFileSync(join(MAPS_DIR, level, 'Patches.json'), 'utf8')) as { Patches: PatchRecord[] };
  const reference = buildReferenceMesh(raw.Patches.filter(patch => patch.Points?.length >= 16), undefined, 1);
  const adjacency = meshAdjacency(reference.mesh);
  const point = (vertex: number): V3 => {
    const i = vertex * 3; return [reference.mesh.vertices[i], reference.mesh.vertices[i + 1], reference.mesh.vertices[i + 2]];
  };
  const native = (p: V3): V3 => [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]];
  const pkey = (p: V3): string => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
  const meshByPoint = new Map<string, number>();
  for (let i = 0; i < reference.mesh.vertexCount; i++) meshByPoint.set(pkey(point(i)), i);
  const nativeVertices = copied.selection.vertices.map(native);
  const meshVertices = nativeVertices.map((p, local) => {
    const exact = meshByPoint.get(pkey(p));
    if (exact !== undefined) return exact;
    let best = -1, distance = Infinity;
    for (let i = 0; i < reference.mesh.vertexCount; i++) {
      const d = len(sub(point(i), p)); if (d < distance) { distance = d; best = i; }
    }
    if (distance > .03) throw new Error(`${level} selection vertex ${local} misses reference by ${distance.toFixed(3)}m`);
    return best;
  });
  const graph = Array.from({ length: nativeVertices.length }, () => [] as number[]);
  for (const edge of copied.selection.edges) {
    graph[edge.vertices[0]].push(edge.vertices[1]); graph[edge.vertices[1]].push(edge.vertices[0]);
  }
  const allEdges = copied.selection.edges.map((edge, index): SourceEdge => {
    const mesh: [number, number] = [meshVertices[edge.vertices[0]], meshVertices[edge.vertices[1]]];
    const p0 = point(mesh[0]), p3 = point(mesh[1]);
    const cp = edge.bezier
      ? edge.bezier.map(native) as [V3, V3, V3, V3]
      : [p0, add(p0, reference.edgeHandle(...mesh)), add(p3, reference.edgeHandle(mesh[1], mesh[0])), p3] as TrailCubic;
    const faces = adjacency.edgeQuads.get(edgeKey(...mesh)) ?? [];
    return {
      index, local: edge.vertices, mesh, cp,
      faces: faces.length === 2 ? [faces[0], faces[1]] : [-1, -1],
      lengthM: cubicLength(cp), planLengthM: cubicLength(cp, true), signedCurvature: cubicSignedCurvature(cp),
    };
  });
  const eligible = allEdges.filter(edge => edge.faces[0] >= 0
    && graph[edge.local[0]].length <= 2 && graph[edge.local[1]].length <= 2);
  const runs = buildRuns(eligible, nativeVertices.length);
  const observations = runs.map(run => ({ run, stations: observeRun(reference, run) }));
  return {
    input, level, reference, nativeVertices, graph, sourceEdges: allEdges,
    excludedJunctionEdges: allEdges.length - eligible.length, runs, observations,
  };
}

function observeRun(reference: ReferenceMesh, run: SourceRun): StationObservation[] {
  const curvatures = Array.from({ length: run.edges.length + 1 }, (_, i) => {
    if (i === 0) return run.edges[0].signedCurvature;
    if (i === run.edges.length) return run.edges[run.edges.length - 1].signedCurvature;
    const before = run.edges[i - 1], after = run.edges[i];
    const join = signedPlanAngle(derivative(before.cp, 1), derivative(after.cp, 0))
      / Math.max(1e-6, (before.planLengthM + after.planLengthM) / 2);
    return (before.signedCurvature + after.signedCurvature) / 2 + join;
  });
  return Array.from({ length: run.edges.length + 1 }, (_, i): StationObservation => {
    const before = i ? derivative(run.cubics[i - 1], 1) : null;
    const after = i < run.cubics.length ? derivative(run.cubics[i], 0) : null;
    const combined = before && after ? add(norm(before), norm(after)) : before ?? after!;
    const tangent = Math.hypot(combined[0], combined[2]) > 1e-9 ? norm([combined[0], 0, combined[2]]) : [0, 0, 1] as V3;
    const right: V3 = [-tangent[2], 0, tangent[0]];
    const edgeIndex = Math.min(i, run.edges.length - 1), edge = run.edges[edgeIndex];
    const along = i === run.edges.length ? 1 : (i === edgeIndex ? 0 : 1);
    const evaluators = edge.faces.map(face => sourceLaneEvaluator(reference, face, edge.mesh[0], edge.mesh[1]));
    const center = cubicPoint(edge.cp[0], edge.cp[1], edge.cp[2], edge.cp[3], along);
    const outers = evaluators.map(evaluate => evaluate(along, 1));
    outers.sort((a, b) => dot(sub(a, center), right) - dot(sub(b, center), right));
    const [sourceMinus, sourcePlus] = outers as [V3, V3];
    const cross = sub(sourcePlus, sourceMinus), widthPlanM = Math.hypot(cross[0], cross[2]);
    const projected = Math.max(1e-9, cross[0] * cross[0] + cross[2] * cross[2]);
    const chordT = clamp(((center[0] - sourceMinus[0]) * cross[0] + (center[2] - sourceMinus[2]) * cross[2]) / projected, 0, 1);
    const chordY = sourceMinus[1] + chordT * (sourcePlus[1] - sourceMinus[1]);
    return {
      center, tangent, right, sourceMinus, sourcePlus, widthPlanM, centerBias: chordT,
      dishM: chordY - center[1],
      bankDegrees: Math.atan2(sourcePlus[1] - sourceMinus[1], widthPlanM) / DEG,
      signedCurvature: curvatures[i],
    };
  });
}

interface FittedOptions extends TrailOptions {
  widthM: number;
  centerBias: number;
  dishFraction: number;
  maxPatchLengthM: number;
  minPatchLengthM: number;
  maxTurnDegrees: number;
  bankGainM: number;
  maxBankDegrees: number;
  maxBankStepDegrees: number;
}

function fitLength(edges: readonly SourceEdge[]): Pick<FittedOptions, 'maxPatchLengthM' | 'minPatchLengthM' | 'maxTurnDegrees'> & { logError: number } {
  const minPatchLengthM = clamp(q(edges.map(edge => edge.lengthM), .1), 4, 14);
  let best = { maxPatchLengthM: 25, minPatchLengthM, maxTurnDegrees: 23, logError: Infinity };
  for (let lengthM = 16; lengthM <= 50; lengthM += .5) for (let turn = 10; turn <= 70; turn += 1) {
    const errors = edges.map(edge => {
      const radiusLength = Math.abs(edge.signedCurvature) > 1e-7 ? turn * DEG / Math.abs(edge.signedCurvature) : Infinity;
      const predicted = Math.max(minPatchLengthM, Math.min(lengthM, radiusLength));
      return Math.abs(Math.log(Math.max(1e-6, edge.lengthM) / predicted));
    });
    const score = q(errors, .5) + .25 * q(errors, .75);
    if (score < best.logError) best = { maxPatchLengthM: lengthM, minPatchLengthM, maxTurnDegrees: turn, logError: score };
  }
  return best;
}

/** Edge curvature used by the density law, including half of each adjacent cubic-junction deflection. */
function spacingEdges(runs: readonly RunObservations[]): SourceEdge[] {
  return runs.flatMap(({ run }) => run.edges.map((edge, i) => {
    const before = i ? Math.abs(signedPlanAngle(derivative(run.edges[i - 1].cp, 1), derivative(edge.cp, 0))) / 2 : 0;
    const after = i + 1 < run.edges.length
      ? Math.abs(signedPlanAngle(derivative(edge.cp, 1), derivative(run.edges[i + 1].cp, 0))) / 2 : 0;
    const ownTurn = Math.abs(edge.signedCurvature) * edge.planLengthM;
    return { ...edge, signedCurvature: (ownTurn + before + after) / Math.max(1e-6, edge.planLengthM) };
  }));
}

function fitBank(runs: readonly RunObservations[]): Pick<FittedOptions, 'bankGainM' | 'maxBankDegrees' | 'maxBankStepDegrees'> & { maeDegrees: number; p90Degrees: number } {
  let best = { bankGainM: 15, maxBankDegrees: 31, maxBankStepDegrees: 6, maeDegrees: Infinity, p90Degrees: Infinity };
  for (let gain = 0; gain <= 60; gain += 1) {
    for (const maxBank of [20, 25, 30, 35, 40, 45]) for (const step of [4, 6, 8, 12, 20, 45]) {
      const errors: number[] = [];
      for (const run of runs) {
        const predicted = trailBankProfile(run.stations.map(station => station.signedCurvature), {
          bankGainM: gain, maxBankDegrees: maxBank, maxBankStepDegrees: step,
        });
        predicted.forEach((bank, i) => errors.push(Math.abs(bank - run.stations[i].bankDegrees)));
      }
      const mae = errors.reduce((sum, value) => sum + value, 0) / Math.max(1, errors.length);
      const score = mae + .2 * q(errors, .9);
      if (score < best.maeDegrees + .2 * best.p90Degrees)
        best = { bankGainM: gain, maxBankDegrees: maxBank, maxBankStepDegrees: step, maeDegrees: mae, p90Degrees: q(errors, .9) };
    }
  }
  return best;
}

function fitOptions(dataset: Dataset, observations = dataset.observations): FittedOptions & { fit: Record<string, number> } {
  const stations = observations.flatMap(run => run.stations);
  const edges = spacingEdges(observations);
  const widthM = q(stations.map(station => station.widthPlanM), .5);
  const centerBias = clamp(q(stations.map(station => station.centerBias), .5), .05, .95);
  const dishFraction = clamp(q(stations.map(station => station.dishM / Math.max(1e-6, station.widthPlanM)), .5), 0, .35);
  const lengthFit = fitLength(edges), bankFit = fitBank(observations);
  return {
    widthM, centerBias, dishFraction,
    maxPatchLengthM: lengthFit.maxPatchLengthM,
    minPatchLengthM: lengthFit.minPatchLengthM,
    maxTurnDegrees: lengthFit.maxTurnDegrees,
    bankGainM: bankFit.bankGainM,
    maxBankDegrees: bankFit.maxBankDegrees,
    maxBankStepDegrees: bankFit.maxBankStepDegrees,
    surface: 1,
    fit: { spacingLogError: lengthFit.logError, bankMaeDegrees: bankFit.maeDegrees, bankP90Degrees: bankFit.p90Degrees },
  };
}

interface ComparisonAccumulator {
  surfaceErrorsM: number[];
  rimErrorsM: number[];
  centerErrorsM: number[];
  sourceEdges: Set<number>;
  generatedSpans: number;
  generatedPatches: number;
  refusedSourceEdges: number[];
  splitRuns: number;
}
const accumulator = (): ComparisonAccumulator => ({
  surfaceErrorsM: [], rimErrorsM: [], centerErrorsM: [], sourceEdges: new Set(),
  generatedSpans: 0, generatedPatches: 0, refusedSourceEdges: [], splitRuns: 0,
});

function compareResult(reference: ReferenceMesh, run: SourceRun, result: Extract<TrailResult, { ok: true }>, out: ComparisonAccumulator): void {
  const generated = meshFromDoc(result.doc);
  const alongSamples = [0, .25, .5, .75, 1], lateralSamples = [.25, .5, .75, 1];
  result.spans.forEach((span, spanIndex) => {
    const source = run.edges[span.sourceSegment];
    const ref = source.faces.map(face => sourceLaneEvaluator(reference, face, source.mesh[0], source.mesh[1]));
    const controls = [0, 1].map(lane => quadControlPoints(generated.mesh, generated.edgeHandle, result.quads[spanIndex * 2 + lane]));
    const errorFor = (lane: number, face: number): number[] => {
      const errors: number[] = [];
      for (const u of alongSamples) for (const lateral of lateralSamples) {
        const generatedLateral = lane === 0 ? 1 - lateral : lateral;
        const actual = patchPoint(controls[lane], u, generatedLateral);
        const sourceT = span.sourceT0 + (span.sourceT1 - span.sourceT0) * u;
        errors.push(len(sub(actual, ref[face](sourceT, lateral))));
      }
      return errors;
    };
    const costs = [[errorFor(0, 0), errorFor(1, 1)], [errorFor(0, 1), errorFor(1, 0)]] as const;
    const total = (pair: readonly number[][]): number => pair.flat().reduce((sum, value) => sum + value * value, 0);
    const chosen = total(costs[0]) <= total(costs[1]) ? costs[0] : costs[1];
    out.surfaceErrorsM.push(...chosen[0], ...chosen[1]);
    // lateralSamples is nested inside each along sample, so every fourth value is the rim (lateral=1).
    chosen.forEach(errors => errors.forEach((value, index) => { if (index % lateralSamples.length === lateralSamples.length - 1) out.rimErrorsM.push(value); }));
    for (const u of alongSamples) {
      const actual = patchPoint(controls[1], u, 0);
      const sourceT = span.sourceT0 + (span.sourceT1 - span.sourceT0) * u;
      out.centerErrorsM.push(len(sub(actual, ref[0](sourceT, 0))));
    }
    out.sourceEdges.add(source.index); out.generatedSpans++; out.generatedPatches += 2;
  });
}

function compareRun(dataset: Dataset, run: SourceRun, options: TrailOptions, out: ComparisonAccumulator): void {
  const result = applyTrailSpline(emptyDoc(dataset.level), run.cubics, options);
  if (result.ok) { compareResult(dataset.reference, run, result, out); return; }
  if (run.edges.length === 1) { out.refusedSourceEdges.push(run.edges[0].index); return; }
  out.splitRuns++;
  const half = Math.floor(run.edges.length / 2);
  const slice = (from: number, to: number): SourceRun => ({
    index: run.index, vertices: run.vertices.slice(from, to + 1), edges: run.edges.slice(from, to), cubics: run.cubics.slice(from, to),
  });
  const optionsSlice = (from: number, to: number): TrailOptions => {
    if (!options.knotProfile) return options;
    return {
      ...options,
      knotProfile: Object.fromEntries(Object.entries(options.knotProfile)
        .map(([name, values]) => [name, values?.slice(from, to + 1)])),
    };
  };
  compareRun(dataset, slice(0, half), optionsSlice(0, half), out);
  compareRun(dataset, slice(half, run.edges.length), optionsSlice(half, run.edges.length), out);
}

function compareDataset(dataset: Dataset, mapOptions: FittedOptions, sectionMode: 'map' | 'run' | 'source-knots') {
  const out = accumulator();
  for (const observed of dataset.observations) {
    const section = sectionMode === 'run' ? fitOptions(dataset, [observed]) : mapOptions;
    const knotProfile = sectionMode === 'source-knots' ? {
      widthM: observed.stations.map(station => station.widthPlanM),
      dishFraction: observed.stations.map(station => clamp(station.dishM / Math.max(1e-6, station.widthPlanM), 0, .35)),
      centerBias: observed.stations.map(station => clamp(station.centerBias, .02, .98)),
      bankDegrees: observed.stations.map(station => station.bankDegrees),
    } : undefined;
    compareRun(dataset, observed.run, {
      ...mapOptions, widthM: section.widthM, centerBias: section.centerBias, dishFraction: section.dishFraction,
      ...(knotProfile ? { knotProfile } : {}),
    }, out);
  }
  return {
    comparedSourceEdges: out.sourceEdges.size,
    eligibleSourceEdges: dataset.runs.reduce((sum, run) => sum + run.edges.length, 0),
    refusedSourceEdges: [...new Set(out.refusedSourceEdges)].sort((a, b) => a - b),
    generatedSpans: out.generatedSpans,
    generatedPatches: out.generatedPatches,
    recursiveRunSplits: out.splitRuns,
    surfaceDistanceM: metric(out.surfaceErrorsM),
    rimDistanceM: metric(out.rimErrorsM),
    centerDistanceM: metric(out.centerErrorsM),
    surfaceDistanceFractionOfWidth: metric(out.surfaceErrorsM.map(value => value / mapOptions.widthM)),
  };
}

const inputArg = resolve(process.argv[2] ?? join(REPO_ROOT, 'ResearchData', 'trails', 'centerlines'));
const inputs = statSync(inputArg).isDirectory()
  ? readdirSync(inputArg).filter(name => name.endsWith('-centerline.json')).sort().map(name => join(inputArg, name))
  : [inputArg];
if (!inputs.length) throw new Error(`no *-centerline.json files found in ${inputArg}`);

const datasets: Dataset[] = [];
for (const input of inputs) {
  process.stdout.write(`loading ${basename(input)} ... `);
  const dataset = loadDataset(input); datasets.push(dataset);
  console.log(`${dataset.sourceEdges.length} edges, ${dataset.runs.length} ordinary runs`);
}

const allObservations = datasets.flatMap(dataset => dataset.observations);
const allEdges = spacingEdges(allObservations);
// The shared fit uses a synthetic aggregate dataset shape only for its station/edge pools.
const aggregate = { ...datasets[0], observations: allObservations } as Dataset;
const sharedOptions = fitOptions(aggregate, allObservations);
const sharedLength = fitLength(allEdges);
Object.assign(sharedOptions, sharedLength);

const reports = datasets.map(dataset => {
  const options = fitOptions(dataset);
  console.log(`benchmarking ${dataset.level} ...`);
  return {
    level: dataset.level,
    input: evidencePath(dataset.input),
    source: {
      vertices: dataset.nativeVertices.length,
      selectedEdges: dataset.sourceEdges.length,
      ordinaryRuns: dataset.runs.length,
      ordinaryEdges: dataset.runs.reduce((sum, run) => sum + run.edges.length, 0),
      junctionAdjacentEdgesExcluded: dataset.excludedJunctionEdges,
      planWidthM: metric(dataset.observations.flatMap(run => run.stations.map(station => station.widthPlanM))),
      centerBias: metric(dataset.observations.flatMap(run => run.stations.map(station => station.centerBias))),
      dishFraction: metric(dataset.observations.flatMap(run => run.stations.map(station => station.dishM / station.widthPlanM))),
      absoluteBankDegrees: metric(dataset.observations.flatMap(run => run.stations.map(station => Math.abs(station.bankDegrees)))),
      patchLengthM: metric(dataset.runs.flatMap(run => run.edges.map(edge => edge.lengthM))),
      effectiveTurnDegrees: metric(spacingEdges(dataset.observations)
        .map(edge => Math.abs(edge.signedCurvature) * edge.planLengthM / DEG)),
    },
    fittedOptions: options,
    reconstruction: {
      mesaPrototypeDefaults: compareDataset(dataset, MESA_TRAIL_DEFAULTS, 'map'),
      sharedDefaults: compareDataset(dataset, sharedOptions, 'map'),
      mapParameters: compareDataset(dataset, options, 'map'),
      mapBankLengthPerRunSection: compareDataset(dataset, options, 'run'),
      sourceKnotProfileUpperBound: compareDataset(dataset, options, 'source-knots'),
    },
  };
});

const report = {
  generatedAt: new Date().toISOString(),
  method: {
    samplesPerGeneratedPatch: 20,
    samplesPerTwoPatchSpan: 40,
    note: 'Distances compare matched source/generated bicubic parameters; center samples are separate and exact by construction.',
    exclusions: 'Edges touching a selected degree>2 split/merge vertex are hand-knit junction cells and excluded.',
  },
  totals: {
    maps: reports.length,
    selectedEdges: reports.reduce((sum, item) => sum + item.source.selectedEdges, 0),
    ordinaryEdges: reports.reduce((sum, item) => sum + item.source.ordinaryEdges, 0),
  },
  sharedOptions,
  maps: reports,
};
const output = tempFile('trail-reconstruction-benchmark.json');
writeFileSync(output, JSON.stringify(report, null, 2));

const show = (value: number): string => Number.isFinite(value) ? value.toFixed(3) : '-';
console.log('\n=== FITTED GENERATOR PARAMETERS ===');
console.log(`shared: width ${sharedOptions.widthM.toFixed(1)}m · balance ${sharedOptions.centerBias.toFixed(2)} · dish ${(sharedOptions.dishFraction * 100).toFixed(1)}% · target ${sharedOptions.maxPatchLengthM.toFixed(1)}m · turn ${sharedOptions.maxTurnDegrees.toFixed(0)}° · bank gain ${sharedOptions.bankGainM.toFixed(0)}m / clamp ${sharedOptions.maxBankDegrees}° / step ${sharedOptions.maxBankStepDegrees}°`);
for (const item of reports) {
  const o = item.fittedOptions;
  console.log(`${item.level.padEnd(8)} width ${o.widthM.toFixed(1)}m · balance ${o.centerBias.toFixed(2)} · dish ${(o.dishFraction * 100).toFixed(1)}% · target ${o.maxPatchLengthM.toFixed(1)}m · turn ${o.maxTurnDegrees.toFixed(0)}° · bank ${o.bankGainM.toFixed(0)}m/${o.maxBankDegrees}°/${o.maxBankStepDegrees}°`);
}
console.log('\n=== DIRECT BICUBIC SURFACE RECONSTRUCTION ===');
for (const item of reports) {
  const map = item.reconstruction.mapParameters, run = item.reconstruction.mapBankLengthPerRunSection;
  const knots = item.reconstruction.sourceKnotProfileUpperBound;
  console.log(`${item.level.padEnd(8)} map RMS ${show(map.surfaceDistanceM.rms)}m  med ${show(map.surfaceDistanceM.median)}m  p90 ${show(map.surfaceDistanceM.p90)}m · run RMS ${show(run.surfaceDistanceM.rms)}m · knot-profile RMS ${show(knots.surfaceDistanceM.rms)}m  med ${show(knots.surfaceDistanceM.median)}m  p90 ${show(knots.surfaceDistanceM.p90)}m · edges ${map.comparedSourceEdges}/${map.eligibleSourceEdges}`);
}
console.log(`\nfull report -> ${output}`);
