import type { QuadMeshDoc, V3 } from '../doc/types';
import { appendMeshIds } from '../doc/ids';
import { cubicPoint, splitCubic } from '../math/bezier';
import { add, len, mul, norm, sub } from '../math/vec';
import { checkManifold } from './ops';
import { directedEdgeKey } from './primitives';

/** One exact cubic segment of the construction spline, p0..p3 in Slopesmith editor metres. */
export type TrailCubic = readonly [V3, V3, V3, V3];

export interface TrailTexturePreset {
  /** Mirrored left/right half-tiles for ordinary trail spans. */
  standard: readonly (readonly [string, string])[];
  /** Mirrored half-tiles used below `tightRadiusM`; absent keeps using `standard`. */
  tight?: readonly (readonly [string, string])[];
  tightRadiusM?: number;
  /** Hold one pair for this many consecutive spans, avoiding a flickering tile change every patch. */
  runLength?: number;
  seed?: number;
}

/** Optional section values at the input spline knots (`spline.length + 1` entries). Generated stations
 *  interpolate between them, so the eventual tool can expose sparse-looking width/dish/bank controls without
 *  tying the mesh density to the construction-spline knot density. */
export interface TrailKnotProfile {
  widthM?: readonly number[];
  dishFraction?: readonly number[];
  /** Centre seam position across the width: 0.5 is equal lanes, larger gives the minus/left lane more width. */
  centerBias?: readonly number[];
  /** Explicit signed banks in degrees. Absent uses curvature auto-bank; a supplied array overrides it. */
  bankDegrees?: readonly number[];
}

export interface TrailOptions {
  /** Horizontal rim-to-rim width. Mesa's selected two-lane trail median is ~13.0m in plan (~15.5m on surface). */
  widthM?: number;
  /** Centre seam position across the full width, in (0,1); 0.5 makes two equal patch lanes. */
  centerBias?: number;
  /** Centre seam below the banked rim chord, as a fraction of width. Mesa plan-width median is 0.105. */
  dishFraction?: number;
  /** Ordinary station spacing cap. Curvature can cut shorter spans. */
  maxPatchLengthM?: number;
  /** Soft floor on adaptive spans: very tight turns may exceed maxTurn rather than emit unusably tiny patches. */
  minPatchLengthM?: number;
  /** Tangent turn cap per span. 23deg with 22.5m reproduces Mesa's radius-dependent spacing closely. */
  maxTurnDegrees?: number;
  /** Auto-bank law: bank = -atan(bankGainM * signed horizontal curvature); positive gain raises the outside rim. */
  bankGainM?: number;
  maxBankDegrees?: number;
  /** Forward/backward slew limit so bank ramps instead of jumping at a station. */
  maxBankStepDegrees?: number;
  surface?: number;
  textures?: TrailTexturePreset;
  knotProfile?: TrailKnotProfile;
}

export const MESA_TRAIL_DEFAULTS = {
  widthM: 13,
  centerBias: 0.5,
  dishFraction: 0.105,
  maxPatchLengthM: 22.5,
  minPatchLengthM: 9.5,
  maxTurnDegrees: 52,
  bankGainM: 15,
  maxBankDegrees: 20,
  maxBankStepDegrees: 20,
  surface: 1,
} as const;

/** Mesa's two patches form one visual tile: every tuple is [left half, right half]. */
export const MESA_TRAIL_TEXTURES: TrailTexturePreset = {
  standard: [
    ['MESA/0044.png', 'MESA/0045.png'],
    ['MESA/0046.png', 'MESA/0047.png'],
    ['MESA/0059.png', 'MESA/0061.png'],
    ['MESA/0002.png', 'MESA/0042.png'],
  ],
  tight: [
    ['MESA/0066.png', 'MESA/0064.png'], // blue outside stripes
    ['MESA/0063.png', 'MESA/0062.png'], // red outside stripes
  ],
  tightRadiusM: 80,
  runLength: 6,
  seed: 0,
};

export interface TrailStation {
  center: V3;
  left: V3;
  right: V3;
  tangent: V3;
  signedCurvature: number;
  bankDegrees: number;
  widthM: number;
  dishM: number;
  centerBias: number;
}

export interface TrailSpan {
  /** Exact re-cut of its source cubic. The generated centre seam writes these handles verbatim. */
  center: [V3, V3, V3, V3];
  sourceSegment: number;
  sourceT0: number;
  sourceT1: number;
  lengthM: number;
  planLengthM: number;
  signedCurvature: number;
  radiusM: number;
  textures?: readonly [string, string];
}

/** One generated ribbon: the mesh it was appended to, the three rails of vertices along it, and the geometry
 *  each was derived from. */
export interface TrailRibbon {
  doc: QuadMeshDoc;
  rails: { left: number[]; center: number[]; right: number[] };
  quads: number[];
  stations: TrailStation[];
  spans: TrailSpan[];
}

export type TrailResult = ({ ok: true } & TrailRibbon) | { ok: false; error: string };

const DEG = Math.PI / 180;
const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const clone = (p: readonly number[]): V3 => [p[0], p[1], p[2]];
const finiteV3 = (p: readonly number[]) => p.length >= 3 && p.every(Number.isFinite);
const lerpNumber = (a: number, b: number, t: number): number => a + (b - a) * t;

export type TrailBankOptions = Pick<TrailOptions, 'bankGainM' | 'maxBankDegrees' | 'maxBankStepDegrees'>;

/** The deterministic curvature → bank profile used by generation, exported so reference fitting and a future
 *  spline-tool preview can evaluate the exact same law without constructing a mesh. Positive bank raises the
 *  generated right rim; reversing a spline reverses both curvature and its lateral frame, preserving geometry. */
export function trailBankProfile(signedCurvatures: readonly number[], options: TrailBankOptions = {}): number[] {
  const bankGainM = options.bankGainM ?? MESA_TRAIL_DEFAULTS.bankGainM;
  const maxBankDegrees = options.maxBankDegrees ?? MESA_TRAIL_DEFAULTS.maxBankDegrees;
  const maxBankStepDegrees = options.maxBankStepDegrees ?? MESA_TRAIL_DEFAULTS.maxBankStepDegrees;
  const bank = signedCurvatures.map(curvature => clamp(
    -Math.atan(bankGainM * curvature) / DEG, -maxBankDegrees, maxBankDegrees,
  ));
  // Two passes in each direction spread a sharp curvature change, then enforce the measured station ramp.
  for (let pass = 0; pass < 2; pass++) {
    const smoothed = bank.map((value, i) => i === 0 || i === bank.length - 1
      ? value : (bank[i - 1] + value * 2 + bank[i + 1]) / 4);
    bank.splice(0, bank.length, ...smoothed);
  }
  for (let i = 1; i < bank.length; i++) bank[i] = clamp(bank[i], bank[i - 1] - maxBankStepDegrees, bank[i - 1] + maxBankStepDegrees);
  for (let i = bank.length - 2; i >= 0; i--) bank[i] = clamp(bank[i], bank[i + 1] - maxBankStepDegrees, bank[i + 1] + maxBankStepDegrees);
  return bank;
}

function derivative(cp: TrailCubic, t: number): V3 {
  const s = 1 - t;
  return add(add(
    mul(sub(cp[1], cp[0]), 3 * s * s),
    mul(sub(cp[2], cp[1]), 6 * s * t),
  ), mul(sub(cp[3], cp[2]), 3 * t * t));
}

function signedPlanAngle(a: V3, b: V3): number {
  const al = Math.hypot(a[0], a[2]), bl = Math.hypot(b[0], b[2]);
  if (al < 1e-10 || bl < 1e-10) return 0;
  return Math.atan2(a[0] * b[2] - a[2] * b[0], a[0] * b[0] + a[2] * b[2]);
}

function cubicMetrics(cp: TrailCubic, samples = 64): { length: number; planLength: number; turn: number; signedTurn: number } {
  let length = 0, planLength = 0, turn = 0, signedTurn = 0;
  let previousPoint = cp[0], previousTangent = derivative(cp, 0);
  for (let i = 1; i <= samples; i++) {
    const t = i / samples, here = cubicPoint(cp[0], cp[1], cp[2], cp[3], t), tangent = derivative(cp, t);
    length += len(sub(here, previousPoint));
    planLength += Math.hypot(here[0] - previousPoint[0], here[2] - previousPoint[2]);
    const angle = signedPlanAngle(previousTangent, tangent);
    turn += Math.abs(angle); signedTurn += angle;
    previousPoint = here; previousTangent = tangent;
  }
  return { length, planLength, turn, signedTurn };
}

/** Parameter at a requested fraction of the cubic's 3-D arc length, from a dense monotone lookup. */
function arcFractionT(cp: TrailCubic, fraction: number, samples = 128): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  const cumulative = new Float64Array(samples + 1);
  let previous = cp[0];
  for (let i = 1; i <= samples; i++) {
    const here = cubicPoint(cp[0], cp[1], cp[2], cp[3], i / samples);
    cumulative[i] = cumulative[i - 1] + len(sub(here, previous)); previous = here;
  }
  const target = cumulative[samples] * fraction;
  let lo = 0, hi = samples;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cumulative[mid] < target) lo = mid; else hi = mid; }
  const span = cumulative[hi] - cumulative[lo];
  return (lo + (span > 1e-12 ? (target - cumulative[lo]) / span : 0)) / samples;
}

/** Exact cubic restriction to parent parameter [t0,t1]. */
function sliceCubic(cp: TrailCubic, t0: number, t1: number): [V3, V3, V3, V3] {
  if (t0 <= 0 && t1 >= 1) return cp.map(clone) as [V3, V3, V3, V3];
  const left = splitCubic(cp[0], cp[1], cp[2], cp[3], t1).left;
  if (t0 <= 0) return left;
  return splitCubic(left[0], left[1], left[2], left[3], t0 / t1).right;
}

function textureForSpan(preset: TrailTexturePreset | undefined, index: number, radius: number): readonly [string, string] | undefined {
  if (!preset?.standard.length) return undefined;
  const bank = preset.tight?.length && radius <= (preset.tightRadiusM ?? 80) ? preset.tight : preset.standard;
  const run = Math.max(1, Math.trunc(preset.runLength ?? 6));
  const choice = Math.floor((index + Math.trunc(preset.seed ?? 0)) / run) % bank.length;
  return bank[choice];
}

/**
 * Append a Mesa-like two-patch-wide trail chart around an exact cubic spline.
 *
 * This emits only ordinary ribbon spans — one strip, two ends, no branching. A spline network is generated by
 * `applyTrailNetwork`, which calls this for each run between two junctions and knits the junctions themselves.
 */
export function applyTrailSpline(doc: QuadMeshDoc, spline: readonly TrailCubic[], options: TrailOptions = {}): TrailResult {
  if (!spline.length) return { ok: false, error: 'Trail needs at least one cubic spline segment.' };
  for (let i = 0; i < spline.length; i++) {
    if (spline[i].length !== 4 || !spline[i].every(finiteV3))
      return { ok: false, error: `Spline segment ${i} is not four finite 3-D Bézier controls.` };
    if (i && len(sub(spline[i - 1][3], spline[i][0])) > 1e-4)
      return { ok: false, error: `Spline is discontinuous between segments ${i - 1} and ${i}; join their endpoints before generating the trail.` };
  }

  const opts = { ...MESA_TRAIL_DEFAULTS, ...options };
  if (!(opts.widthM > 0) || !(opts.centerBias > 0 && opts.centerBias < 1)
    || !(opts.dishFraction >= 0) || !(opts.maxPatchLengthM > 0)
    || !(opts.minPatchLengthM > 0 && opts.minPatchLengthM <= opts.maxPatchLengthM)
    || !(opts.maxTurnDegrees > 0) || !(opts.bankGainM >= 0)
    || !(opts.maxBankDegrees >= 0) || !(opts.maxBankStepDegrees > 0))
    return { ok: false, error: 'Trail width, patch lengths, and turn limit must be positive; centre bias must be inside (0,1), and dish cannot be negative.' };
  const profileLength = spline.length + 1;
  for (const [name, values] of Object.entries(opts.knotProfile ?? {})) {
    if (!Array.isArray(values) || values.length !== profileLength || values.some(value => !Number.isFinite(value)))
      return { ok: false, error: `Trail knot-profile ${name} must contain ${profileLength} finite values (one per spline knot).` };
  }
  if (opts.knotProfile?.widthM?.some(value => value <= 0))
    return { ok: false, error: 'Trail knot-profile widths must be positive.' };
  if (opts.knotProfile?.dishFraction?.some(value => value < 0))
    return { ok: false, error: 'Trail knot-profile dish values cannot be negative.' };
  if (opts.knotProfile?.centerBias?.some(value => value <= 0 || value >= 1))
    return { ok: false, error: 'Trail knot-profile centre-bias values must be inside (0,1).' };

  const sourceMetrics = spline.map(source => cubicMetrics(source));
  const sourceJoinTurns = Array.from({ length: Math.max(0, spline.length - 1) }, (_, i) =>
    signedPlanAngle(derivative(spline[i], 1), derivative(spline[i + 1], 0)));
  const spans: TrailSpan[] = [];
  for (let sourceSegment = 0; sourceSegment < spline.length; sourceSegment++) {
    const source = spline[sourceSegment], metrics = sourceMetrics[sourceSegment];
    if (metrics.length < 1e-5) continue;
    // A retail station can carry some of its turn between two source cubics rather than inside either one.
    // Charge half of that join deflection to each neighbor when choosing density, shortening cells around a
    // sharp knot without introducing a duplicate station or moving the exact centre curve.
    const effectiveTurn = metrics.turn
      + Math.abs(sourceJoinTurns[sourceSegment - 1] ?? 0) / 2
      + Math.abs(sourceJoinTurns[sourceSegment] ?? 0) / 2;
    const required = Math.max(1,
      Math.ceil(metrics.length / opts.maxPatchLengthM),
      Math.ceil(effectiveTurn / (opts.maxTurnDegrees * DEG)));
    // Mesa keeps a ~6m practical floor even at hairpins; maxTurn becomes soft once satisfying it would make
    // smaller patches. Long/ordinary curves still honour both caps exactly.
    const floorLimited = Math.max(1, Math.floor(metrics.length / opts.minPatchLengthM));
    let count = Math.min(512, Math.min(required, floorLimited));
    let cuts = Array.from({ length: count + 1 }, (_, i) => arcFractionT(source, i / count));
    // Total turn establishes the first count. A cubic can concentrate that turn locally, so refine until every
    // exact sub-curve also respects the turn target or the practical minimum-length budget makes it soft.
    while (count < Math.min(512, floorLimited)) {
      const locallyTooSharp = Array.from({ length: count }, (_, i) =>
        cubicMetrics(sliceCubic(source, cuts[i], cuts[i + 1])).turn > opts.maxTurnDegrees * DEG + 1e-6).some(Boolean);
      if (!locallyTooSharp) break;
      count++;
      cuts = Array.from({ length: count + 1 }, (_, i) => arcFractionT(source, i / count));
    }
    for (let i = 0; i < count; i++) {
      const center = sliceCubic(source, cuts[i], cuts[i + 1]);
      const local = cubicMetrics(center);
      const signedCurvature = local.signedTurn / Math.max(1e-6, local.planLength);
      const radiusM = Math.abs(signedCurvature) > 1e-7 ? 1 / Math.abs(signedCurvature) : Infinity;
      spans.push({
        center, sourceSegment, sourceT0: cuts[i], sourceT1: cuts[i + 1], lengthM: local.length,
        planLengthM: local.planLength, signedCurvature, radiusM,
      });
    }
  }
  if (!spans.length) return { ok: false, error: 'Spline has no measurable length.' };

  const stationCurvature = Array.from({ length: spans.length + 1 }, (_, station) => {
    if (station === 0) return spans[0].signedCurvature;
    if (station === spans.length) return spans[spans.length - 1].signedCurvature;
    const before = spans[station - 1], after = spans[station];
    const joinCurvature = before.sourceSegment !== after.sourceSegment
      ? signedPlanAngle(derivative(before.center, 1), derivative(after.center, 0))
        / Math.max(1e-6, (before.planLengthM + after.planLengthM) / 2)
      : 0;
    return (before.signedCurvature + after.signedCurvature) / 2 + joinCurvature;
  });
  // Texture bands respond to curvature carried at source-cubic joins too, not only turn inside one cubic.
  for (let i = 0; i < spans.length; i++) {
    const curvature = Math.max(Math.abs(spans[i].signedCurvature), Math.abs(stationCurvature[i]), Math.abs(stationCurvature[i + 1]));
    spans[i].radiusM = curvature > 1e-7 ? 1 / curvature : Infinity;
    spans[i].textures = textureForSpan(opts.textures, i, spans[i].radiusM);
  }
  const bank = trailBankProfile(stationCurvature, opts);

  const stationSources = [
    { segment: spans[0].sourceSegment, t: spans[0].sourceT0 },
    ...spans.map(span => ({ segment: span.sourceSegment, t: span.sourceT1 })),
  ];
  const profileAt = (values: readonly number[] | undefined, station: number, fallback: number): number => {
    if (!values) return fallback;
    const source = stationSources[station];
    return lerpNumber(values[source.segment], values[source.segment + 1], source.t);
  };
  if (opts.knotProfile?.bankDegrees)
    for (let i = 0; i < bank.length; i++) bank[i] = profileAt(opts.knotProfile.bankDegrees, i, bank[i]);

  const centers = [clone(spans[0].center[0]), ...spans.map(span => clone(span.center[3]))];
  const tangents: V3[] = [];
  for (let i = 0; i < centers.length; i++) {
    const before = i ? derivative(spans[i - 1].center, 1) : null;
    const after = i < spans.length ? derivative(spans[i].center, 0) : null;
    const combined = before && after ? add(norm(before), norm(after)) : before ?? after!;
    const horizontal: V3 = [combined[0], 0, combined[2]];
    tangents.push(Math.hypot(horizontal[0], horizontal[2]) < 1e-8
      ? (i ? clone(tangents[i - 1]) : [0, 0, 1])
      : norm(horizontal));
  }
  const stations: TrailStation[] = centers.map((center, i) => {
    const tangent = tangents[i];
    // cross(right, flow) = up, matching the quilt's [A,B,C,D] / patchNormal winding.
    const right: V3 = [-tangent[2], 0, tangent[0]];
    const widthM = profileAt(opts.knotProfile?.widthM, i, opts.widthM);
    const dishFraction = profileAt(opts.knotProfile?.dishFraction, i, opts.dishFraction);
    const centerBias = profileAt(opts.knotProfile?.centerBias, i, opts.centerBias);
    const minusWidth = widthM * centerBias, plusWidth = widthM * (1 - centerBias);
    const dishM = widthM * dishFraction, bankSlope = Math.tan(bank[i] * DEG);
    const left = add(add(center, mul(right, -minusWidth)), [0, dishM - bankSlope * minusWidth, 0]);
    const rightPoint = add(add(center, mul(right, plusWidth)), [0, dishM + bankSlope * plusWidth, 0]);
    return {
      center, left, right: rightPoint, tangent, signedCurvature: stationCurvature[i],
      bankDegrees: bank[i], widthM, dishM, centerBias,
    };
  });

  // Catch an offset rail folding through the centre on a turn tighter than half the width. The reference uses
  // hand-knit darts/junctions there; a regular chart must refuse rather than emit inverted patches.
  for (let i = 0; i < stations.length - 1; i++) {
    for (const [lane, a, b, c] of [
      ['left', stations[i].left, stations[i].center, stations[i + 1].left],
      ['right', stations[i].center, stations[i].right, stations[i + 1].center],
    ] as const) {
      const dv = sub(b, a), du = sub(c, a);
      const normalY = dv[2] * du[0] - dv[0] * du[2]; // cross(dv,du).y
      if (normalY <= 1e-5)
        return { ok: false, error: `Trail ${lane} lane folds at span ${i}; narrow the trail or widen the spline turn.` };
    }
  }

  const vertices = doc.vertices.slice();
  const left: number[] = [], center: number[] = [], right: number[] = [];
  for (const station of stations) {
    left.push(vertices.length / 3); vertices.push(...station.left);
    center.push(vertices.length / 3); vertices.push(...station.center);
    right.push(vertices.length / 3); vertices.push(...station.right);
  }
  const quads = doc.quads.map(quad => quad.slice()), createdQuads: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    createdQuads.push(quads.length); quads.push([left[i], center[i], left[i + 1], center[i + 1]]);
    createdQuads.push(quads.length); quads.push([center[i], right[i], center[i + 1], right[i + 1]]);
  }
  const manifold = checkManifold(quads);
  if (!manifold.ok) return { ok: false, error: 'Trail would drive an existing edge onto three or more patches; generate into an open area or stitch explicitly.' };

  const out: QuadMeshDoc = {
    ...doc, vertices, quads,
    ...appendMeshIds(doc, stations.length * 3, spans.length * 2),
  };
  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  for (let i = 0; i < spans.length; i++) {
    edgeHandles[directedEdgeKey(center[i], center[i + 1])] = sub(spans[i].center[1], spans[i].center[0]);
    edgeHandles[directedEdgeKey(center[i + 1], center[i])] = sub(spans[i].center[2], spans[i].center[3]);
  }
  out.edgeHandles = edgeHandles;

  const quadPaint = { ...(doc.quadPaint ?? {}) };
  for (const quad of createdQuads) quadPaint[quad] = opts.surface;
  out.quadPaint = quadPaint;
  if (spans.some(span => span.textures)) {
    const quadTex = { ...(doc.quadTex ?? {}) }, quadOrient = { ...(doc.quadOrient ?? {}) };
    for (let i = 0; i < spans.length; i++) {
      const textures = spans[i].textures;
      if (!textures) continue;
      quadTex[createdQuads[i * 2]] = textures[0];
      quadTex[createdQuads[i * 2 + 1]] = textures[1];
      // Mesa stores flow on patch-v; our loft stores flow on patch-u, so rotate the tile one quarter-turn.
      quadOrient[createdQuads[i * 2]] = { rot: 1, mirror: false };
      quadOrient[createdQuads[i * 2 + 1]] = { rot: 1, mirror: false };
    }
    out.quadTex = quadTex; out.quadOrient = quadOrient;
  }

  return { ok: true, doc: out, rails: { left, center, right }, quads: createdQuads, stations, spans };
}

// ---- networks --------------------------------------------------------------------------------------------

/** One run of a trail network: an exact cubic chain, and the junction each of its ends belongs to. An end
 *  with no junction is a free end and is capped like an ordinary trail's. */
export interface TrailRunSpec {
  spline: readonly TrailCubic[];
  from?: number;
  to?: number;
  /** Per-run section and dressing, over the network's own defaults. */
  options?: TrailOptions;
}

/** A knitted junction: the patch fan filling the opening the retracted ribbons left around a node. */
export interface TrailJunction {
  node: number;
  /** Vertex at the centre of the fan; its valence is twice the number of trails meeting here. */
  center: number;
  quads: number[];
  /** How far back up each trail the fan reaches. */
  reachM: number;
  /** Trails meeting here, in the order they leave. */
  runs: number[];
}

export type TrailNetworkResult =
  | { ok: true; doc: QuadMeshDoc; runs: TrailRibbon[]; junctions: TrailJunction[]; quads: number[] }
  | { ok: false; error: string };

export interface TrailNetworkOptions extends TrailOptions {
  /** The furthest a junction fan may reach back up its trails before the network is refused. A shallow fork
   *  needs a long reach — two 40 m trails parting at 15° do not stop overlapping for 150 m — and past some
   *  point what that builds is a clearing, not a junction. */
  maxJunctionReachM?: number;
  /** The shortest ribbon a run may be left with once both its ends have been retracted into their fans. */
  minRunLengthM?: number;
}

const NETWORK_DEFAULTS = { maxJunctionReachM: 140, minRunLengthM: 30 } as const;

/** Plan bearing of a horizontal direction, in the same frame `signedPlanAngle` measures turns in. */
const planBearing = (d: V3) => Math.atan2(d[2], d[0]);

/** Signed plan area of a patch, walking its perimeter A→B→D→C rather than its corner order. */
function patchPlanArea(vertices: readonly number[], corners: readonly number[]): number {
  const ring = corners.length === 3 ? corners : [corners[0], corners[1], corners[3], corners[2]];
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i] * 3, b = ring[(i + 1) % ring.length] * 3;
    area += vertices[a] * vertices[b + 2] - vertices[b] * vertices[a + 2];
  }
  return area / 2;
}

/** Arc length of each cubic in a chain, and the running total. */
function chainArcs(spline: readonly TrailCubic[]): { each: number[]; total: number } {
  const each = spline.map(segment => cubicMetrics(segment).length);
  return { each, total: each.reduce((s, v) => s + v, 0) };
}

/** Which segment, and where inside it, sits a given arc distance along a chain. */
function chainParam(spline: readonly TrailCubic[], each: readonly number[], distance: number):
{ segment: number; t: number } {
  let left = distance;
  for (let i = 0; i < spline.length; i++) {
    if (left <= each[i] || i === spline.length - 1) {
      return { segment: i, t: arcFractionT(spline[i], each[i] < 1e-9 ? 0 : left / each[i]) };
    }
    left -= each[i];
  }
  return { segment: spline.length - 1, t: 1 };
}

/**
 * The stretch of a spline chain between two arc distances from its ends, with its knot profile carried across.
 *
 * A junction is knitted around an OPENING, so every trail entering one has to stop short of it — and stopping
 * short has to be an exact operation or the trail no longer follows the line it was drawn on. Both ends are
 * re-cut with de Casteljau, which restricts a cubic to a parameter range without approximating it, and each
 * profile array is re-sampled at the new knots by the same linear rule generation reads it with. What comes
 * back is a shorter chain describing exactly the same curve.
 */
export function trimTrailSpline(spline: readonly TrailCubic[], profile: TrailKnotProfile | undefined,
  headM: number, tailM: number): { spline: TrailCubic[]; profile?: TrailKnotProfile } | { error: string } {
  const { each, total } = chainArcs(spline);
  if (headM + tailM >= total) return { error: `nothing is left of it between its junctions` };
  const head = chainParam(spline, each, headM);
  const tail = chainParam(spline, each, total - tailM);
  // A cut landing on a knot belongs to the segment that still has length on the far side of it.
  if (head.t > 1 - 1e-9 && head.segment < spline.length - 1) { head.segment++; head.t = 0; }
  if (tail.t < 1e-9 && tail.segment > 0) { tail.segment--; tail.t = 1; }

  const out: TrailCubic[] = head.segment === tail.segment
    ? [sliceCubic(spline[head.segment], head.t, tail.t)]
    : [
      sliceCubic(spline[head.segment], head.t, 1),
      ...spline.slice(head.segment + 1, tail.segment),
      sliceCubic(spline[tail.segment], 0, tail.t),
    ];

  if (!profile) return { spline: out };
  const carry = (values: readonly number[]): number[] => {
    const at = (segment: number, t: number) => lerpNumber(values[segment], values[segment + 1], t);
    return head.segment === tail.segment
      ? [at(head.segment, head.t), at(tail.segment, tail.t)]
      : [at(head.segment, head.t), ...values.slice(head.segment + 1, tail.segment + 1), at(tail.segment, tail.t)];
  };
  const carried: TrailKnotProfile = {};
  for (const key of ['widthM', 'dishFraction', 'centerBias', 'bankDegrees'] as const) {
    // Only carry the arrays that were there: generation reads a knot profile by its keys, and a key present
    // with nothing behind it is not the same as a key that was never set.
    if (profile[key]) carried[key] = carry(profile[key]!);
  }
  return { spline: out, profile: carried };
}

/**
 * The widest half-section a run reaches within `window` metres of one of its ends.
 *
 * A junction has to know how wide the trails entering it are before it can know how far back to push them,
 * and "how wide" is a question about the last stretch of trail rather than about the whole descent — a run
 * that opens to 44 m halfway down still arrives at its junction at whatever its profile says there. Taking
 * the maximum over the window rather than the value at the knot keeps the answer an upper bound, which is
 * what makes the fan's own geometry safe: a rim can only meet its neighbour closer than a wider one would.
 */
function halfWithin(spline: readonly TrailCubic[], profile: readonly number[] | undefined,
  fallbackWidth: number, atHead: boolean, window: number): number {
  if (!profile?.length) return fallbackWidth / 2;
  const { each, total } = chainArcs(spline);
  let at = 0;
  let widest = profile[atHead ? 0 : profile.length - 1];
  for (let knot = 0; knot < profile.length; knot++) {
    if (knot) at += each[knot - 1];
    const away = atHead ? at : total - at;
    if (away <= window) widest = Math.max(widest, profile[knot]);
  }
  return widest / 2;
}

/**
 * Build a whole trail NETWORK — ribbons along every run, and a patch fan at every junction they meet at.
 *
 * A ski mountain is a graph, not a bundle of strips: a trail forks, two trails merge, a cat-track crosses
 * three of them. Generating each run as its own ribbon puts two charts on the same ground wherever two of
 * them meet, so this does the two things a chart cannot do for itself.
 *
 * **It stops every trail short of its junctions.** How short is geometry, not taste. Two trails leaving a
 * node at an angle have rims that cross each other until they are far enough out for the wedge between them
 * to be wider than nothing; that distance is where the two rims meet, and every trail at the node is cut back
 * to the furthest such distance around it so the opening left behind is a simple polygon. A node with one
 * trail is not a junction and is left alone.
 *
 * **It fills the opening with a fan.** The opening is bounded by each trail's end cross-section — its two
 * lanes, three vertices — and by a CROTCH between each neighbouring pair, the point where their rims meet.
 * That is 4 vertices per trail, always even, so a vertex in the middle turns it into two quads per trail: a
 * three-way junction is six patches around a valence-6 centre, which is what the shipped levels knit by hand.
 * The rim vertices are the ribbons' own, so the network comes out as one connected surface.
 */
export function applyTrailNetwork(doc: QuadMeshDoc, runs: readonly TrailRunSpec[],
  options: TrailNetworkOptions = {}): TrailNetworkResult {
  if (!runs.length) return { ok: false, error: 'A trail network needs at least one run.' };
  const maxReach = options.maxJunctionReachM ?? NETWORK_DEFAULTS.maxJunctionReachM;
  const minRun = options.minRunLengthM ?? NETWORK_DEFAULTS.minRunLengthM;
  const optionsFor = (run: TrailRunSpec): TrailOptions => ({ ...options, ...run.options });

  // ---- who meets whom, and where -----------------------------------------------------------------------
  interface Arm {
    run: number;
    atHead: boolean;
    /** Away from the node, along the trail, as it runs `distance` metres out from the junction. */
    dirAt: (distance: number) => V3;
    /** Half the trail's widest section within `window` metres of this end. */
    halfWithin: (window: number) => number;
    /** Both of the above, at the reach the fan settled on. */
    out: V3;
    half: number;
    bearing: number;
  }
  const arms = new Map<number, Arm[]>();
  const position = new Map<number, V3>();
  for (let i = 0; i < runs.length; i++) {
    const spline = runs[i].spline;
    if (!spline.length) return { ok: false, error: `Run ${i} has no spline segments.` };
    const opts = { ...MESA_TRAIL_DEFAULTS, ...optionsFor(runs[i]) };
    for (const [node, atHead] of [[runs[i].from, true], [runs[i].to, false]] as const) {
      if (node === undefined || node < 0) continue;
      const end = atHead ? spline[0][0] : spline[spline.length - 1][3];
      const raw = atHead ? derivative(spline[0], 0) : mul(derivative(spline[spline.length - 1], 1), -1);
      const out: V3 = [raw[0], 0, raw[2]];
      if (Math.hypot(out[0], out[2]) < 1e-8) return { ok: false, error: `Run ${i} leaves junction ${node} with no direction.` };
      const known = position.get(node);
      if (known && len(sub(known, end)) > 0.5) {
        return { ok: false, error: `Runs meeting at junction ${node} do not share a point (${len(sub(known, end)).toFixed(1)} m apart).` };
      }
      position.set(node, known ?? clone(end));
      const within = (window: number) =>
        halfWithin(spline, opts.knotProfile?.widthM, opts.widthM, atHead, window);
      /**
       * Which way the trail is going where the ribbon will actually START, not where the node is.
       *
       * A junction is knitted between the ribbon ends, so the wedge between two trails is the wedge their
       * rims make out there — and out there they have diverged. Reading the tangent at the node instead
       * measures two trails as nearly parallel whenever the survey drew them leaving together, which asks
       * the fan to reach hundreds of metres up a mountain where thirty would do.
       */
      /**
       * The trail's heading exactly where its ribbon will start — the same tangent the end station's cross-bar
       * is drawn square to, so the rims this junction reasons about are the rims it will actually get. Read at
       * the node instead, it measures two trails as nearly parallel whenever the survey drew them leaving
       * together, and asks the fan to reach hundreds of metres up a mountain where thirty would do.
       */
      const dirAt = (distance: number): V3 => {
        const { each, total } = chainArcs(spline);
        const along = Math.max(0, Math.min(distance, total * 0.9));
        const where = chainParam(spline, each, atHead ? along : total - along);
        const raw = derivative(spline[where.segment], where.t);
        const sign = atHead ? 1 : -1;
        const plan: V3 = [raw[0] * sign, 0, raw[2] * sign];
        return Math.hypot(plan[0], plan[2]) < 1e-8 ? norm(out) : norm(plan);
      };
      (arms.get(node) ?? (arms.set(node, []), arms.get(node)!)).push({
        run: i, atHead, dirAt, halfWithin: within,
        out: norm(out), half: within(0), bearing: planBearing(out),
      });
    }
  }

  // ---- how far back each junction has to push its trails --------------------------------------------------
  /** Where two neighbouring rims meet, as a distance back up each of the two trails. A wedge wide enough that
   *  the rims already diverge asks for nothing; one at or past a straight line has no meeting point at all. */
  const rimMeet = (a: Arm, b: Arm): { a: number; b: number } => {
    let wedge = b.bearing - a.bearing;
    while (wedge <= 0) wedge += Math.PI * 2;
    if (wedge >= Math.PI * 0.97) return { a: 0, b: 0 };
    // a's right rim and b's left rim, as lines through the node offset sideways; solve where they cross.
    const ra: V3 = [-a.out[2], 0, a.out[0]], rb: V3 = [-b.out[2], 0, b.out[0]];
    const px = ra[0] * a.half - -rb[0] * b.half, pz = ra[2] * a.half - -rb[2] * b.half;
    const determinant = a.out[0] * -b.out[2] - a.out[2] * -b.out[0];
    if (Math.abs(determinant) < 1e-9) return { a: 0, b: 0 };
    const ta = (-px * -b.out[2] - -pz * -b.out[0]) / determinant;
    const tb = (a.out[0] * -pz - a.out[2] * -px) / determinant;
    return { a: Math.max(0, ta), b: Math.max(0, tb) };
  };
  const reach = new Map<number, number>();
  for (const [node, list] of arms) {
    if (list.length < 2) {
      reach.set(node, 0);
      list.forEach(arm => { arm.out = arm.dirAt(0); arm.bearing = planBearing(arm.out); });
      continue;
    }
    /**
     * How far the fan reaches and what it is knitting decide each other. Push the ribbons further back and
     * the trails there are wider, which asks for more reach; but they have also diverged further, which asks
     * for less, and that second effect is the stronger one. So what is wanted is the SMALLEST reach that is
     * enough for itself — measured, not guessed, because a fan reaching further than it has to is a clearing
     * on the mountainside and one reaching less far is two ribbons on the same ground.
     */
    let binding = { need: 0, pair: [list[0], list[0]] as [Arm, Arm], wedge: 0 };
    const settle = (candidate: number): number => {
      for (const arm of list) {
        arm.out = arm.dirAt(candidate);
        arm.bearing = planBearing(arm.out);
        arm.half = arm.halfWithin(candidate * 1.25);
      }
      list.sort((a, b) => a.bearing - b.bearing);
      // A fan needs a body even where the rims never cross: below the widest half-section the trails' own
      // cross-sections reach past the junction and the opening stops being a simple ring.
      binding = { need: Math.max(...list.map(arm => arm.half)) * 1.2, pair: [list[0], list[0]], wedge: 0 };
      for (let i = 0; i < list.length; i++) {
        const a = list[i], b = list[(i + 1) % list.length];
        const meet = rimMeet(a, b);
        let wedgeRadians = b.bearing - a.bearing;
        while (wedgeRadians <= 0) wedgeRadians += Math.PI * 2;
        /**
         * Two trails must not only stop overlapping — their cross-sections must stop overlapping IN BEARING
         * from the junction, or the opening is not a simple ring and no fan can cover it. A trail of half-
         * width h seen from `R` away subtends `atan(h/R)` either side of its own heading, so the two of them
         * together have to fit inside the wedge with a little to spare.
         */
        let angular = 0;
        if (wedgeRadians < Math.PI * 0.97) {
          const target = wedgeRadians * 0.85;
          let lo = 1, hi = 8000;
          for (let step = 0; step < 24; step++) {
            const middle = (lo + hi) / 2;
            if (Math.atan(a.half / middle) + Math.atan(b.half / middle) <= target) hi = middle; else lo = middle;
          }
          angular = hi;
        }
        const asked = Math.max(meet.a, meet.b, angular);
        if (asked > binding.need) {
          let wedge = ((b.bearing - a.bearing) * 180) / Math.PI;
          while (wedge <= 0) wedge += 360;
          binding = { need: asked, pair: [a, b], wedge };
        }
      }
      return binding.need;
    };
    if (settle(maxReach) > maxReach) {
      const [a, b] = binding.pair;
      return { ok: false, error: `Junction ${node}: runs ${a.run} and ${b.run} still leave it `
        + `${binding.wedge.toFixed(0)}° apart ${maxReach} m out, at ${a.half.toFixed(0)} and `
        + `${b.half.toFixed(0)} m half-width — their rims would need ${binding.need.toFixed(0)} m to stop `
        + 'crossing. Narrow them or widen the fork.' };
    }
    let low = 0, high = maxReach;
    for (let step = 0; step < 16; step++) {
      const middle = (low + high) / 2;
      if (settle(middle) <= middle) high = middle; else low = middle;
    }
    // A little past the point where the rims stop crossing, so the opening has some width where they part
    // rather than pinching to nothing at the crotch.
    reach.set(node, Math.min(maxReach, high * 1.15));
    settle(reach.get(node)!);
  }

  // ---- generate every ribbon, cut back to its junctions -----------------------------------------------------
  let out = doc;
  const ribbons: TrailRibbon[] = [];
  const created: number[] = [];
  for (let i = 0; i < runs.length; i++) {
    const spec = runs[i];
    const head = spec.from !== undefined && spec.from >= 0 ? reach.get(spec.from) ?? 0 : 0;
    const tail = spec.to !== undefined && spec.to >= 0 ? reach.get(spec.to) ?? 0 : 0;
    const opts = optionsFor(spec);
    const trimmed = trimTrailSpline(spec.spline, opts.knotProfile, head, tail);
    if ('error' in trimmed) return { ok: false, error: `Run ${i}: ${trimmed.error}` };
    if (chainArcs(trimmed.spline).total < minRun) {
      return { ok: false, error: `Run ${i} is under ${minRun} m once its junctions have taken their room.` };
    }
    const ribbon = applyTrailSpline(out, trimmed.spline, { ...opts, knotProfile: trimmed.profile });
    if (!ribbon.ok) return { ok: false, error: `Run ${i}: ${ribbon.error}` };
    out = ribbon.doc;
    ribbons.push(ribbon);
    created.push(...ribbon.quads);
  }

  // ---- knit the junctions ------------------------------------------------------------------------------------
  const upright = Math.sign(patchPlanArea(out.vertices, out.quads[ribbons[0].quads[0]]));
  const vertices = out.vertices.slice();
  const quads = out.quads.map(quad => quad.slice());
  const junctions: TrailJunction[] = [];
  const point = (v: number): V3 => [vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]];

  for (const [node, list] of arms) {
    if (list.length < 2) continue;
    const R = reach.get(node)!;
    const centre = position.get(node)!;

    /** Each trail's end cross-section, in the frame of a skier leaving the junction along it: the ribbon's
     *  own left/right swap when the trail runs INTO the node rather than out of it. */
    const ends = list.map(arm => {
      const ribbon = ribbons[arm.run];
      const at = arm.atHead ? 0 : ribbon.rails.center.length - 1;
      return {
        arm,
        left: arm.atHead ? ribbon.rails.left[at] : ribbon.rails.right[at],
        seam: ribbon.rails.center[at],
        right: arm.atHead ? ribbon.rails.right[at] : ribbon.rails.left[at],
      };
    });

    const crotches: number[] = [];
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i], b = ends[(i + 1) % ends.length];
      let wedge = b.arm.bearing - a.arm.bearing;
      while (wedge <= 0) wedge += Math.PI * 2;
      /** Walk both rims back toward the node from where the ribbons stopped, and return where they meet.
       *  Refused if they meet behind the node or further out than the fan reaches. */
      const back = (from: V3, along: V3, other: V3, otherAlong: V3): V3 | null => {
        const determinant = along[0] * otherAlong[2] - along[2] * otherAlong[0];
        if (Math.abs(determinant) < 1e-9) return null;
        const dx = other[0] - from[0], dz = other[2] - from[2];
        const s = (dz * otherAlong[0] - dx * otherAlong[2]) / determinant;
        const u = (along[0] * dz - along[2] * dx) / determinant;
        // Both rims have to reach it, and neither may pass its own ribbon's end getting there.
        if (s < -1e-6 || s > R + 1e-3 || u < -1e-6 || u > R + 1e-3) return null;
        return [from[0] - along[0] * s, 0, from[2] - along[2] * s];
      };
      const aPoint = point(a.right), bPoint = point(b.left);
      // Where their two rims meet. A wedge at or past a straight line has no such point: there the fan
      // simply rounds the back of the junction.
      const met = wedge < Math.PI * 0.97
        ? back(aPoint, a.arm.out, bPoint, b.arm.out) : null;
      const bisect = a.arm.bearing + wedge / 2;
      const plan: V3 = met ?? [
        centre[0] + Math.cos(bisect) * R, 0, centre[2] + Math.sin(bisect) * R,
      ];
      /**
       * Hold every crotch out at a fraction of the fan's reach.
       *
       * One reach serves the whole junction, and it is set by the tightest fork at it. At a node with both a
       * tight fork and a wide one — a trail splitting in two while a third crosses — the wide side's rims meet
       * almost at the node while its ribbons stop a hundred metres out, so the crotch between them collapses
       * onto the middle of the fan and the two patches either side of it turn over. Pushing it back out along
       * the wedge's own bisector keeps the opening star-shaped about the junction, which is the one property
       * a fan needs to be a fan.
       */
      const reachOut = Math.hypot(plan[0] - centre[0], plan[2] - centre[2]);
      if (reachOut < R * 0.45) {
        plan[0] = centre[0] + Math.cos(bisect) * R * 0.45;
        plan[2] = centre[2] + Math.sin(bisect) * R * 0.45;
      }
      // Sit the crotch on the plane through the two rim points it joins, so the fan stays on the hillside.
      plan[1] = (aPoint[1] + bPoint[1]) / 2;
      crotches.push(vertices.length / 3);
      vertices.push(...plan);
    }

    // The opening, walked the way the trails leave: each trail's two lanes, then the crotch to the next one.
    let ring: number[] = [];
    for (let i = 0; i < ends.length; i++) ring.push(ends[i].left, ends[i].seam, ends[i].right, crotches[i]);
    // The fan has to wind the way the ribbons do, and which way that is depends on the document's frame.
    const ringArea = (loop: number[]) => {
      let area = 0;
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i] * 3, q = loop[(i + 1) % loop.length] * 3;
        area += vertices[p] * vertices[q + 2] - vertices[q] * vertices[p + 2];
      }
      return area / 2;
    };
    // Reversing alone would pair each quad across a crotch and half a trail end; rotating the reversed ring by
    // one puts the trail ends back on their own patches, which is what makes a junction read as trail.
    if (Math.sign(ringArea(ring)) !== upright) {
      const backwards = ring.slice().reverse();
      ring = [...backwards.slice(1), backwards[0]];
    }

    // The fan turns about the junction ITSELF, not about the average of its corners. Every trail radiates
    // from that point, so it is inside the opening whatever shape the opening is; a centroid of a ring with
    // one crotch far out and another close in can sit outside it, and the patches on that side turn over.
    const hub = vertices.length / 3;
    vertices.push(centre[0], ends.reduce((s, e) => s + vertices[e.seam * 3 + 1], 0) / ends.length, centre[2]);

    /**
     * A fan cell that turns over is a crotch in the wrong place, and there is no repairing it downstream:
     * an inverted locked patch fails the mountain's own check and the retopologiser's after it. Where the
     * rims genuinely cannot be resolved the junction is refused by name, and the recipe drops the lesser of
     * the two trails and knits the network again without it.
     */
    const fan: number[] = [];
    for (let i = 0; i < ring.length; i += 2) {
      const a = ring[i], b = ring[(i + 1) % ring.length], c = ring[(i + 2) % ring.length];
      const corners = [a, b, hub, c];              // perimeter a → b → c → hub
      if (Math.sign(patchPlanArea(vertices, corners)) !== upright) {
        const polar = (v: number) => {
          const dx = vertices[v * 3] - centre[0], dz = vertices[v * 3 + 2] - centre[2];
          return `${((Math.atan2(dz, dx) * 180) / Math.PI).toFixed(0)}°/${Math.hypot(dx, dz).toFixed(0)}m`;
        };
        const near = list
          .map(arm => ({ arm, d: Math.hypot(vertices[a * 3] - centre[0] - arm.out[0] * R,
            vertices[a * 3 + 2] - centre[2] - arm.out[2] * R) }))
          .sort((x, y) => x.d - y.d);
        return { ok: false, error: `Junction ${node}: runs ${near[0].arm.run} and `
          + `${near[1 % near.length].arm.run} leave it in a shape their fan cannot be knitted over — one of `
          + `them has to go. [reach ${R.toFixed(0)} m, halves ${list.map(arm => arm.half.toFixed(0)).join('/')}, `
          + `cell ${i} of ring ${ring.map(polar).join(' ')}]` };
      }
      fan.push(quads.length);
      quads.push(corners);
    }
    junctions.push({ node, center: hub, quads: fan, reachM: R, runs: list.map(arm => arm.run) });
    created.push(...fan);
  }

  const manifold = checkManifold(quads);
  if (!manifold.ok) {
    return { ok: false, error: 'The knitted network drives an edge onto three or more patches — two runs are '
      + 'on the same ground, or a junction was left out.' };
  }

  const added = { vertices: vertices.length / 3 - out.vertices.length / 3, quads: quads.length - out.quads.length };
  const network: QuadMeshDoc = { ...out, vertices, quads, ...appendMeshIds(out, added.vertices, added.quads) };

  // A junction wears whatever the widest trail through it wears: it is that trail's snow, opened out.
  const quadPaint = { ...(network.quadPaint ?? {}) };
  const quadTex = { ...(network.quadTex ?? {}) };
  const quadOrient = { ...(network.quadOrient ?? {}) };
  for (const junction of junctions) {
    const widest = junction.runs
      .map(run => ({ run, half: arms.get(junction.node)!.find(arm => arm.run === run)!.half }))
      .sort((a, b) => b.half - a.half)[0].run;
    const dress = { ...MESA_TRAIL_DEFAULTS, ...optionsFor(runs[widest]) };
    const tile = dress.textures?.standard?.[0]?.[0];
    for (const quad of junction.quads) {
      quadPaint[quad] = dress.surface;
      // A junction has no direction of travel, so its tile is laid square rather than turned onto one.
      if (tile) { quadTex[quad] = tile; quadOrient[quad] = { rot: 0, mirror: false }; }
    }
  }
  network.quadPaint = quadPaint;
  if (Object.keys(quadTex).length) { network.quadTex = quadTex; network.quadOrient = quadOrient; }

  return { ok: true, doc: network, runs: ribbons, junctions, quads: created };
}
