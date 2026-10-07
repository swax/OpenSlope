import type { QuadMeshDoc, V3 } from '../doc/types';
import { appendMeshIds } from '../doc/ids';
import { cubicPoint, splitCubic } from '../math/bezier';
import { add, len, mul, norm, sub } from '../math/vec';
import { checkManifold } from './ops';
import { directedEdgeKey } from './primitives';

/** One exact cubic segment of the construction spline, p0..p3 in Slopesmith editor metres. */
export type TrailCubic = readonly [V3, V3, V3, V3];

/**
 * One matched set as a ribbon wears it: the tiles of the edge lanes to a rider's left and right going along the
 * spline, the tile of every lane between them, and the quarter turns all are worn at beyond a trail tile's own
 * (`TRAIL_TILE_ORIENT`). A ribbon one lane wide wears the middle tile. A tile that is '' (or a middle that is absent)
 * leaves its lanes plain.
 *
 * Data space is the game's left-handed frame, so a rider's left is the side the generator calls `right` (its
 * `[-tz, 0, tx]`): the `left` tile goes on each span's last patch, the `right` tile on its first.
 */
export interface TrailLaneTiles {
  left: string;
  right: string;
  middle?: string;
  quarterTurns?: number;
  /** The tiles worn mirrored across the trail. */
  mirrored?: readonly ('left' | 'middle' | 'right')[];
  /** Quarter turns a tile is worn at beyond `quarterTurns`, each its own. */
  turns?: Readonly<Partial<Record<'left' | 'middle' | 'right', number>>>;
}

/** A tile orientation mirrored ACROSS the trail. The D4 mirror flips the tile along it (the patch's u, which runs
 *  along the trail), so across is that and half a turn. */
export const mirrorAcross = (o: { rot: number; mirror: boolean }): { rot: number; mirror: boolean } =>
  ({ rot: (o.rot + 2) % 4, mirror: !o.mirror });

/** The tiles a ribbon wears, a tile set's rows: one along its spans, others through left and right turns tighter than
 *  `turnRadiusM`, and one on its capped ends. */
export interface TrailTiling {
  /** Worn along every span but the tight ones; absent leaves them plain. */
  trail?: TrailLaneTiles | null;
  /** Worn through left (right) turns tighter than `turnRadiusM` — a rider's left going along the spline, where the
   *  signed curvature is positive (negative); absent wears `trail` there too. */
  leftTurn?: TrailLaneTiles | null;
  rightTurn?: TrailLaneTiles | null;
  /** Worn on a capped end's square span, as a rider travelling out to that end sees it: laid as given at the path's
   *  last point, and turned round at its first — where travelling out is going back along it. Absent wears the
   *  trail's own tiles there. */
  cap?: TrailLaneTiles | null;
  turnRadiusM?: number;
}

/** Optional section values at the input spline knots (`spline.length + 1` entries). Generated stations
 *  interpolate between them by distance along each cubic, so a trail's knots carry width/dish/bank controls
 *  without tying the mesh density to the construction-spline knot density. */
export interface TrailKnotProfile {
  widthM?: readonly number[];
  dishFraction?: readonly number[];
  /** The spline's place across the width: 0.5 is the middle, larger gives the minus/left lanes more width. */
  centerBias?: readonly number[];
  /** Explicit signed banks in degrees; a null entry is the curvature auto-bank at that knot. Between two knots
   *  the bank eases from one knot's to the next, an automatic knot's being the auto-bank wherever it is read:
   *  two fixed knots ramp straight between their angles, a fixed and an automatic one cross-fade, and two
   *  automatic ones are the auto-bank exactly. */
  bankDegrees?: readonly (number | null)[];
  /** Multiplier on the auto-bank law at each knot, before smoothing: 0 levels the rims, 2 doubles the bank. */
  bankStrength?: readonly number[];
}

export interface TrailOptions {
  /** Horizontal rim-to-rim width. Mesa's selected two-lane trail median is ~13.0m in plan (~15.5m on surface). */
  widthM?: number;
  /** Patches across the width, 1 to `MAX_TRAIL_LANES`. Mesa's trails are two. */
  lanes?: number;
  /** Where the spline sits across the full width, in (0,1). The lanes either side of it share their side's width
   *  evenly, so 0.5 makes equal lanes, and with two lanes it is the centre seam. */
  centerBias?: number;
  /** The spline's place below the banked rim chord, as a fraction of width — the dish, a parabola across the lanes
   *  (two lanes: the centre seam). Mesa plan-width median is 0.105. */
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
  textures?: TrailTiling;
  knotProfile?: TrailKnotProfile;
  /** Close the ribbon's first (last) span as a CAP: square, as long as a lane is wide, wearing the tiling's cap. */
  caps?: { start?: boolean; end?: boolean };
}

export const MESA_TRAIL_DEFAULTS = {
  widthM: 13,
  lanes: 2,
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

/** The most lanes a trail is cut with. */
export const MAX_TRAIL_LANES = 12;

export interface TrailStation {
  /** The spline's point, and the rims. */
  center: V3;
  left: V3;
  right: V3;
  /** Every rail's point, from the generator's left rim across to its right: one more than the lanes. */
  rails: V3[];
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
  /** Each of its patches' tiles, in the order it lays them (`trailSpanPatches`): a lane at a time from the generator's
   *  left rim; '' leaves one plain. */
  textures?: readonly string[];
  /** How its tiles are worn: `TRAIL_TILE_ORIENT`, turned further as its set says — and, where `textureMirrors` says,
   *  mirrored across the trail. */
  textureOrient?: { rot: number; mirror: boolean };
  textureMirrors?: readonly boolean[];
  /** Quarter turns each patch's tile is worn at beyond `textureOrient`, where its set turns tiles of their own. */
  textureTurns?: readonly number[];
  /** The cap closing the ribbon's first or last point, where this span is one. */
  cap?: 'start' | 'end';
}

/** One generated ribbon: the mesh it was appended to, its vertices station by station — from the generator's left rim
 *  across to its right, one more than the lanes there — and the geometry each was derived from. */
export interface TrailRibbon {
  doc: QuadMeshDoc;
  sections: number[][];
  /** Its patches, span by span, as each span lays them (`trailSpanPatches`). */
  quads: number[];
  stations: TrailStation[];
  spans: TrailSpan[];
}

/** The rail running along the spline itself, which carries its exact handles: the middle one of an even number of
 *  lanes. An odd number puts the spline inside the middle lane, on no rail. */
export const trailSeamRail = (lanes: number): number | null => lanes % 2 ? null : lanes / 2;

/**
 * The lanes at each station of a run `spans` long and `lanes` wide whose first and last stations are `ends` lanes wide
 * — narrowing into a junction, or to meet a path not as wide. From each end it changes a lane a span toward its own
 * width, or as many a span as it must to get there and back; a run too short to reach its width stays narrower.
 */
export function trailStationLanes(spans: number, lanes: number, ends?: readonly [number, number]): number[] {
  const [head, tail] = ends ?? [lanes, lanes];
  const rate = Math.max(1, Math.ceil(Math.max(Math.abs(head - lanes), Math.abs(tail - lanes)) / Math.max(1, spans)));
  const off = (end: number, steps: number) => Math.sign(end - lanes) * Math.max(0, Math.abs(end - lanes) - rate * steps);
  return Array.from({ length: spans + 1 }, (_, i) => {
    const a = off(head, i), b = off(tail, spans - i);
    return lanes + (a <= 0 && b <= 0 ? Math.min(a, b) : a >= 0 && b >= 0 ? Math.max(a, b) : a + b);
  });
}

/** One patch of a span: its corners as [0 for the span's first station or 1 for its next, rail there], the lane of the
 *  wider station it is — null for a lane ending (or starting) in a wedge — and whether it is a wedge pointing back
 *  along the trail, its tile turned half round to match. */
export interface TrailSpanPatch { corners: [0 | 1, number][]; lane: number | null; turned: boolean }

/** The lanes a station narrowing from `wider` to `narrower` leaves out: the middle-most, a lane at a time, so the
 *  edge lanes run on. */
function droppedLanes(wider: number, narrower: number): Set<number> {
  const lanes = Array.from({ length: wider }, (_, i) => i), out = new Set<number>();
  while (lanes.length > narrower) out.add(lanes.splice(Math.floor((lanes.length - 1) / 2), 1)[0]);
  return out;
}

/**
 * The patches of a span from a station `from` lanes wide to the next, `to` lanes wide, a lane at a time from the
 * generator's left rim. Each lane carries on; where the lanes change, the middle-most of the wider station's end (or
 * begin) in a WEDGE (docs/017: a patch whose last two corners are one) to a point on the narrower station — a lane
 * dropping out like a road's, the lanes either side closing over it.
 */
export function trailSpanPatches(from: number, to: number): TrailSpanPatch[] {
  const wider = Math.max(from, to), dropped = droppedLanes(wider, Math.min(from, to));
  const narrowing = from >= to;
  const out: TrailSpanPatch[] = [];
  let j = 0;
  for (let g = 0; g < wider; g++) {
    if (dropped.has(g)) {
      out.push(narrowing
        ? { corners: [[0, g], [0, g + 1], [1, j], [1, j]], lane: null, turned: false }
        : { corners: [[1, g + 1], [1, g], [0, j], [0, j]], lane: null, turned: true });
      continue;
    }
    out.push(narrowing
      ? { corners: [[0, g], [0, g + 1], [1, j], [1, j + 1]], lane: g, turned: false }
      : { corners: [[0, j], [0, j + 1], [1, g], [1, g + 1]], lane: g, turned: false });
    j++;
  }
  return out;
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
 *  generated right rim; reversing a spline reverses both curvature and its lateral frame, preserving geometry.
 *  `strength`, one per station, scales the law's clamped bank there before it is smoothed (a knot's
 *  `bankStrength`). */
export function trailBankProfile(signedCurvatures: readonly number[], options: TrailBankOptions = {},
  strength?: readonly number[]): number[] {
  const bankGainM = options.bankGainM ?? MESA_TRAIL_DEFAULTS.bankGainM;
  const maxBankDegrees = options.maxBankDegrees ?? MESA_TRAIL_DEFAULTS.maxBankDegrees;
  const maxBankStepDegrees = options.maxBankStepDegrees ?? MESA_TRAIL_DEFAULTS.maxBankStepDegrees;
  const bank = signedCurvatures.map((curvature, i) => (strength?.[i] ?? 1) * clamp(
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

/**
 * The tiles a span turning at `signedCurvature` wears across `lanes`, and how: on a cap, the tiling's cap; through a
 * turn tighter than the tiling's radius, the set for that way of turning — positive curvature turns to a rider's left
 * — and the trail set elsewhere, or where those have none. `tiles` follows the span's patches, the generator's left rail's lane first:
 * the rider's right edge, then the middle lanes, then the rider's left edge. `middle` is the set's middle tile, for
 * the patches of a junction between its lanes and its hub.
 */
function textureForSpan(tiling: TrailTiling | undefined, signedCurvature: number, lanes: number, cap?: 'start' | 'end'):
{
  tiles: string[]; middle: string; mirrors: boolean[]; middleMirrored: boolean; turns: number[]; middleTurns: number;
  orient: { rot: number; mirror: boolean };
} | undefined {
  const tight = Math.abs(signedCurvature) >= 1 / (tiling?.turnRadiusM ?? 80);
  const turn = tight ? (signedCurvature > 0 ? tiling?.leftTurn : tiling?.rightTurn) : null;
  const capSet = cap ? tiling?.cap : null;
  const set = capSet ?? turn ?? tiling?.trail;
  if (!set) return undefined;
  // A cap reads as a rider travelling out to its end sees it; at the first point that is back along the path, so the
  // row is turned round, and its left lane is the path's right.
  const back = !!capSet && cap === 'start';
  const turns = Math.trunc(set.quarterTurns ?? 0) + (back ? 2 : 0);
  const middle = set.middle ?? '';
  const [first, last] = back ? ['left', 'right'] as const : ['right', 'left'] as const;
  const which = (lane: number) => lanes === 1 ? 'middle' : lane === 0 ? first : lane === lanes - 1 ? last : 'middle';
  const flipped = (side: 'left' | 'middle' | 'right') => !!set.mirrored?.includes(side);
  const turned = (side: 'left' | 'middle' | 'right') => Math.trunc(set.turns?.[side] ?? 0);
  return {
    tiles: Array.from({ length: lanes }, (_, lane) => { const side = which(lane); return side === 'middle' ? middle : set[side]; }),
    middle,
    mirrors: Array.from({ length: lanes }, (_, lane) => flipped(which(lane))),
    middleMirrored: flipped('middle'),
    turns: Array.from({ length: lanes }, (_, lane) => turned(which(lane))),
    middleTurns: turned('middle'),
    orient: { rot: (((TRAIL_TILE_ORIENT.rot + turns) % 4) + 4) % 4, mirror: TRAIL_TILE_ORIENT.mirror },
  };
}

export interface TrailLayoutOptions extends TrailOptions {
  /** Hold the ribbon at exactly this many lengthwise spans instead of choosing the count adaptively. A trail
   *  whose rims other patches are welded to keeps its topology this way while its spline is edited: the same
   *  vertices move, and the patches sharing them stretch with it. The spans are shared out across the source
   *  cubics by the same length and turn demand the adaptive count reads, at least one each. */
  spanCount?: number;
  /** The lanes at its first and last stations, where they are not its own (`trailStationLanes`). */
  laneEnds?: readonly [number, number];
}

/** The stations and spans of one ribbon, before any of it is written into a mesh. */
export type TrailLayout = { stations: TrailStation[]; spans: TrailSpan[] };
export type TrailLayoutResult = ({ ok: true } & TrailLayout) | { ok: false; error: string };

/** Share `total` spans out across sources in proportion to `demand`, at least one each (largest remainder). */
function apportionSpans(demand: readonly number[], total: number): number[] {
  const sum = demand.reduce((s, value) => s + value, 0);
  const exact = demand.map(value => sum > 0 ? (total * value) / sum : total / demand.length);
  const counts = exact.map(value => Math.max(1, Math.floor(value)));
  let left = total - counts.reduce((s, value) => s + value, 0);
  const byRemainder = exact.map((value, i) => ({ i, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest);
  for (let k = 0; left > 0; k = (k + 1) % byRemainder.length, left--) counts[byRemainder[k].i]++;
  // The one-each floor can overshoot; take the excess back from the sources holding the most.
  while (left < 0) {
    let most = 0;
    for (let i = 1; i < counts.length; i++) if (counts[i] > counts[most]) most = i;
    counts[most]--; left++;
  }
  return counts;
}

/**
 * The geometry of a Mesa-like trail, some patches wide, around an exact cubic spline: where every station's rail
 * points sit and which exact sub-cubic each span follows. Pure — `applyTrailSpline` appends it as new mesh, and an
 * owned trail (`trail-object.ts`) writes it back over the vertices it already has.
 */
export function layoutTrailSpline(spline: readonly TrailCubic[], options: TrailLayoutOptions = {}): TrailLayoutResult {
  if (!spline.length) return { ok: false, error: 'Trail needs at least one cubic spline segment.' };
  for (let i = 0; i < spline.length; i++) {
    if (spline[i].length !== 4 || !spline[i].every(finiteV3))
      return { ok: false, error: `Spline segment ${i} is not four finite 3-D Bézier controls.` };
    if (i && len(sub(spline[i - 1][3], spline[i][0])) > 1e-4)
      return { ok: false, error: `Spline is discontinuous between segments ${i - 1} and ${i}; join their endpoints before generating the trail.` };
  }

  const opts = { ...MESA_TRAIL_DEFAULTS, ...options };
  if (!Number.isInteger(opts.lanes) || opts.lanes < 1 || opts.lanes > MAX_TRAIL_LANES)
    return { ok: false, error: `A trail is 1 to ${MAX_TRAIL_LANES} patches wide.` };
  const lanes = opts.lanes;
  if (options.laneEnds?.some(end => !Number.isInteger(end) || end < 1 || end > MAX_TRAIL_LANES))
    return { ok: false, error: `A trail's ends are 1 to ${MAX_TRAIL_LANES} patches wide.` };
  if (!(opts.widthM > 0) || !(opts.centerBias > 0 && opts.centerBias < 1)
    || !(opts.dishFraction >= 0) || !(opts.maxPatchLengthM > 0)
    || !(opts.minPatchLengthM > 0 && opts.minPatchLengthM <= opts.maxPatchLengthM)
    || !(opts.maxTurnDegrees > 0) || !(opts.bankGainM >= 0)
    || !(opts.maxBankDegrees >= 0) || !(opts.maxBankStepDegrees > 0))
    return { ok: false, error: 'Trail width, patch lengths, and turn limit must be positive; centre bias must be inside (0,1), and dish cannot be negative.' };
  const profileLength = spline.length + 1;
  for (const [name, values] of Object.entries(opts.knotProfile ?? {})) {
    // A bank may be null at a knot: that knot banks automatically.
    const allowed = (value: unknown) => Number.isFinite(value) || (name === 'bankDegrees' && value === null);
    if (!Array.isArray(values) || values.length !== profileLength || !values.every(allowed))
      return { ok: false, error: `Trail knot-profile ${name} must contain ${profileLength} finite values (one per spline knot).` };
  }
  if (opts.knotProfile?.widthM?.some(value => value <= 0))
    return { ok: false, error: 'Trail knot-profile widths must be positive.' };
  if (opts.knotProfile?.dishFraction?.some(value => value < 0))
    return { ok: false, error: 'Trail knot-profile dish values cannot be negative.' };
  if (opts.knotProfile?.centerBias?.some(value => value <= 0 || value >= 1))
    return { ok: false, error: 'Trail knot-profile centre-bias values must be inside (0,1).' };
  if (opts.knotProfile?.bankStrength?.some(value => value < 0))
    return { ok: false, error: 'Trail knot-profile bank strengths cannot be negative.' };

  const sourceMetrics = spline.map(source => cubicMetrics(source));
  const sourceJoinTurns = Array.from({ length: Math.max(0, spline.length - 1) }, (_, i) =>
    signedPlanAngle(derivative(spline[i], 1), derivative(spline[i + 1], 0)));
  // A retail station can carry some of its turn between two source cubics rather than inside either one.
  // Charge half of that join deflection to each neighbor when choosing density, shortening cells around a
  // sharp knot without introducing a duplicate station or moving the exact centre curve.
  const effectiveTurns = sourceMetrics.map((metrics, sourceSegment) => metrics.turn
    + Math.abs(sourceJoinTurns[sourceSegment - 1] ?? 0) / 2
    + Math.abs(sourceJoinTurns[sourceSegment] ?? 0) / 2);
  const measurable = sourceMetrics.map(metrics => metrics.length >= 1e-5);
  let fixedCounts: number[] | null = null;
  if (options.spanCount !== undefined) {
    const sources = measurable.filter(Boolean).length;
    if (!Number.isInteger(options.spanCount) || options.spanCount < 1)
      return { ok: false, error: 'A fixed trail span count must be a positive whole number.' };
    if (sources > options.spanCount)
      return { ok: false, error: `The trail keeps its ${options.spanCount} spans while other patches are joined to it, `
        + `and ${sources} knot segments cannot share them out one each. Remove a knot.` };
    const demand = sourceMetrics.flatMap((metrics, i) => measurable[i]
      ? [Math.max(metrics.length / opts.maxPatchLengthM, effectiveTurns[i] / (opts.maxTurnDegrees * DEG), 1e-6)] : []);
    const shared = apportionSpans(demand, options.spanCount);
    let next = 0;
    fixedCounts = measurable.map(ok => ok ? shared[next++] : 0);
  }
  const spans: TrailSpan[] = [];
  /** Where each span starts and ends along its source cubic, as fractions of that cubic's arc length. */
  const spanArcs: [number, number][] = [];
  // A capped end's last lane-width of spline is a span of its own, as long as a lane is wide (docs/023 · Caps); the
  // stretch between is cut as ever.
  const firstMeasured = measurable.indexOf(true), lastMeasured = measurable.lastIndexOf(true);
  const capLength = (knot: number) => (opts.knotProfile?.widthM?.[knot] ?? opts.widthM) / lanes;
  for (let sourceSegment = 0; sourceSegment < spline.length; sourceSegment++) {
    const source = spline[sourceSegment], metrics = sourceMetrics[sourceSegment];
    if (!measurable[sourceSegment]) continue;
    const head = !!options.caps?.start && sourceSegment === firstMeasured;
    const tail = !!options.caps?.end && sourceSegment === lastMeasured;
    const from = head ? capLength(sourceSegment) / metrics.length : 0;
    const to = tail ? 1 - capLength(sourceSegment + 1) / metrics.length : 1;
    if ((head || tail) && to - from < 0.1) {
      return { ok: false, error: `The trail is too short ${head ? 'from its first point' : 'to its last point'} for its cap: `
        + 'a cap is as long as a lane is wide. Move the point further off, or take the cap off.' };
    }
    const effectiveTurn = effectiveTurns[sourceSegment] * (to - from), length = metrics.length * (to - from);
    const required = Math.max(1,
      Math.ceil(length / opts.maxPatchLengthM),
      Math.ceil(effectiveTurn / (opts.maxTurnDegrees * DEG)));
    // Mesa keeps a ~6m practical floor even at hairpins; maxTurn becomes soft once satisfying it would make
    // smaller patches. Long/ordinary curves still honour both caps exactly.
    const floorLimited = Math.max(1, Math.floor(length / opts.minPatchLengthM));
    let count = fixedCounts ? fixedCounts[sourceSegment] - Number(head) - Number(tail) : Math.min(512, Math.min(required, floorLimited));
    if (count < 1) return { ok: false, error: 'The trail keeps its spans while other patches are joined to it, and has none to spare for a cap.' };
    /** The arc fractions the spans are cut at: the caps, and `n` even spans between. */
    const fractions = (n: number) => [
      ...(head ? [0] : []), ...Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n), ...(tail ? [1] : []),
    ];
    let arcs = fractions(count);
    let cuts = arcs.map(f => arcFractionT(source, f));
    // Total turn establishes the first count. A cubic can concentrate that turn locally, so refine until every
    // exact sub-curve between the caps also respects the turn target or the practical minimum-length budget makes it
    // soft.
    while (!fixedCounts && count < Math.min(512, floorLimited)) {
      const locallyTooSharp = cuts.slice(Number(head), cuts.length - Number(tail)).some((t, i, between) => i + 1 < between.length
        && cubicMetrics(sliceCubic(source, t, between[i + 1])).turn > opts.maxTurnDegrees * DEG + 1e-6);
      if (!locallyTooSharp) break;
      count++;
      arcs = fractions(count);
      cuts = arcs.map(f => arcFractionT(source, f));
    }
    for (let i = 0; i + 1 < cuts.length; i++) {
      const center = sliceCubic(source, cuts[i], cuts[i + 1]);
      const local = cubicMetrics(center);
      const signedCurvature = local.signedTurn / Math.max(1e-6, local.planLength);
      const radiusM = Math.abs(signedCurvature) > 1e-7 ? 1 / Math.abs(signedCurvature) : Infinity;
      const cap = head && i === 0 ? 'start' : tail && i === cuts.length - 2 ? 'end' : null;
      spans.push({
        center, sourceSegment, sourceT0: cuts[i], sourceT1: cuts[i + 1], lengthM: local.length,
        planLengthM: local.planLength, signedCurvature, radiusM, ...(cap ? { cap } : {}),
      });
      spanArcs.push([arcs[i], arcs[i + 1]]);
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
  const stationLanes = trailStationLanes(spans.length, lanes, options.laneEnds);
  // Texture bands respond to curvature carried at source-cubic joins too, not only turn inside one cubic.
  for (let i = 0; i < spans.length; i++) {
    const curvature = Math.max(Math.abs(spans[i].signedCurvature), Math.abs(stationCurvature[i]), Math.abs(stationCurvature[i + 1]));
    spans[i].radiusM = curvature > 1e-7 ? 1 / curvature : Infinity;
    const [from, to] = [stationLanes[i], stationLanes[i + 1]];
    const tile = textureForSpan(opts.textures, spans[i].signedCurvature, Math.max(from, to), spans[i].cap);
    if (tile) {
      const patches = trailSpanPatches(from, to);
      spans[i].textures = patches.map(patch => patch.lane === null ? tile.middle : tile.tiles[patch.lane]);
      spans[i].textureOrient = tile.orient;
      if (tile.mirrors.some(Boolean) || tile.middleMirrored)
        spans[i].textureMirrors = patches.map(patch => patch.lane === null ? tile.middleMirrored : tile.mirrors[patch.lane]);
      if (tile.turns.some(Boolean) || tile.middleTurns)
        spans[i].textureTurns = patches.map(patch => patch.lane === null ? tile.middleTurns : tile.turns[patch.lane]);
    }
  }
  // Every station reads the knot profile at its place between two knots: its source cubic, and how far along it
  // by arc length — the spans were cut at even arc fractions, so a taper runs evenly however the handles bend.
  const stationSources = [
    { segment: spans[0].sourceSegment, f: spanArcs[0][0] },
    ...spans.map((span, i) => ({ segment: span.sourceSegment, f: spanArcs[i][1] })),
  ];
  const profileAt = (values: readonly number[] | undefined, station: number, fallback: number): number => {
    if (!values) return fallback;
    const source = stationSources[station];
    return lerpNumber(values[source.segment], values[source.segment + 1], source.f);
  };
  const strength = opts.knotProfile?.bankStrength
    ? stationSources.map((_, i) => profileAt(opts.knotProfile!.bankStrength, i, 1)) : undefined;
  const bank = trailBankProfile(stationCurvature, opts, strength);
  const fixedBank = opts.knotProfile?.bankDegrees;
  if (fixedBank) {
    for (let i = 0; i < bank.length; i++) {
      const { segment, f } = stationSources[i];
      bank[i] = lerpNumber(fixedBank[segment] ?? bank[i], fixedBank[segment + 1] ?? bank[i], f);
    }
  }

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
    // Across from the left rim (-1) to the right (+1), the spline at 0: each side's lanes share that side's width,
    // the dish rises as the square of the way out, and the bank tilts the whole section.
    const here = stationLanes[i];
    const rails = Array.from({ length: here + 1 }, (_, k): V3 => {
      const across = (2 * k) / here - 1;
      const offset = across * (across < 0 ? minusWidth : plusWidth);
      return add(add(center, mul(right, offset)), [0, dishM * across * across + bankSlope * offset, 0]);
    });
    return {
      center, left: rails[0], right: rails[here], rails, tangent, signedCurvature: stationCurvature[i],
      bankDegrees: bank[i], widthM, dishM, centerBias,
    };
  });

  // Catch an offset rail folding through the centre on a turn tighter than half the width. The reference uses
  // hand-knit darts/junctions there; a regular chart must refuse rather than emit inverted patches.
  for (let i = 0; i < stations.length - 1; i++) {
    const wide = Math.max(stationLanes[i], stationLanes[i + 1]);
    for (const { corners, lane } of trailSpanPatches(stationLanes[i], stationLanes[i + 1])) {
      const [a, b, c] = corners.map(([station, rail]) => stations[i + station].rails[rail]);
      const dv = sub(b, a), du = sub(c, a);
      const normalY = dv[2] * du[0] - dv[0] * du[2]; // cross(dv,du).y
      if (normalY <= 1e-5) {
        const which = lane === null ? 'narrowing lane' : wide === 2 ? (lane ? 'right lane' : 'left lane') : `lane ${lane + 1}`;
        return { ok: false, error: `Trail ${which} folds at span ${i}; narrow the trail or widen the spline turn.` };
      }
    }
  }
  return { ok: true, stations, spans };
}

/** Write each span's exact centre-seam Bézier handles, both directions, for a ribbon whose stations' vertices are
 *  `sections`: where a span keeps an even number of lanes, along the rail running on the spline at both its ends. */
export function writeTrailSeamHandles(edgeHandles: Record<string, V3>, sections: readonly (readonly number[])[], spans: readonly TrailSpan[]) {
  for (let i = 0; i < spans.length; i++) {
    const lanes = sections[i].length - 1, seam = trailSeamRail(lanes);
    if (seam === null || sections[i + 1].length - 1 !== lanes) continue;
    const [a, b] = [sections[i][seam], sections[i + 1][seam]];
    edgeHandles[directedEdgeKey(a, b)] = sub(spans[i].center[1], spans[i].center[0]);
    edgeHandles[directedEdgeKey(b, a)] = sub(spans[i].center[2], spans[i].center[3]);
  }
}

/** Mesa stores flow on patch-v; our loft stores flow on patch-u, so a trail tile turns one quarter. */
export const TRAIL_TILE_ORIENT = { rot: 1, mirror: false } as const;

/**
 * Append a Mesa-like trail chart, some patches wide, around an exact cubic spline.
 *
 * This emits only ordinary ribbon spans — one strip, two ends, no branching. A spline network is generated by
 * `applyTrailNetwork`, which calls this for each run between two junctions and knits the junctions themselves.
 */
export function applyTrailSpline(doc: QuadMeshDoc, spline: readonly TrailCubic[], options: TrailLayoutOptions = {}): TrailResult {
  const layout = layoutTrailSpline(spline, options);
  if (!layout.ok) return layout;
  const { stations, spans } = layout;
  const surface = options.surface ?? MESA_TRAIL_DEFAULTS.surface;

  const vertices = doc.vertices.slice();
  const sections = stations.map(station => station.rails.map(point => vertices.push(...point) / 3 - 1));
  const quads = doc.quads.map(quad => quad.slice()), createdQuads: number[] = [];
  /** Each patch laid, span by span, and how its tile turns. */
  const laid: { span: number; at: number; turned: boolean }[] = [];
  for (let i = 0; i < spans.length; i++) {
    trailSpanPatches(sections[i].length - 1, sections[i + 1].length - 1).forEach((patch, at) => {
      createdQuads.push(quads.length);
      laid.push({ span: i, at, turned: patch.turned });
      quads.push(patch.corners.map(([station, rail]) => sections[i + station][rail]));
    });
  }
  const manifold = checkManifold(quads);
  if (!manifold.ok) return { ok: false, error: 'Trail would drive an existing edge onto three or more patches; generate into an open area or stitch explicitly.' };

  const out: QuadMeshDoc = {
    ...doc, vertices, quads,
    ...appendMeshIds(doc, vertices.length / 3 - doc.vertices.length / 3, createdQuads.length),
  };
  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  writeTrailSeamHandles(edgeHandles, sections, spans);
  out.edgeHandles = edgeHandles;

  const quadPaint = { ...(doc.quadPaint ?? {}) };
  for (const quad of createdQuads) quadPaint[quad] = surface;
  out.quadPaint = quadPaint;
  if (spans.some(span => span.textures?.some(Boolean))) {
    const quadTex = { ...(doc.quadTex ?? {}) }, quadOrient = { ...(doc.quadOrient ?? {}) };
    laid.forEach(({ span, at, turned }, k) => {
      const texture = spans[span].textures?.[at];
      if (!texture) return; // a plain lane
      const worn = spans[span].textureOrient ?? TRAIL_TILE_ORIENT;
      const rot = worn.rot + (turned ? 2 : 0) + (spans[span].textureTurns?.[at] ?? 0);
      const orient = { rot: ((rot % 4) + 4) % 4, mirror: worn.mirror };
      quadTex[createdQuads[k]] = texture;
      quadOrient[createdQuads[k]] = spans[span].textureMirrors?.[at] ? mirrorAcross(orient) : orient;
    });
    out.quadTex = quadTex; out.quadOrient = quadOrient;
  }

  return { ok: true, doc: out, sections, quads: createdQuads, stations, spans };
}

// ---- networks --------------------------------------------------------------------------------------------

/** One run of a trail network: an exact cubic chain, and the junction each of its ends belongs to. An end
 *  with no junction is a free end and is capped like an ordinary trail's. */
export interface TrailRunSpec {
  spline: readonly TrailCubic[];
  from?: number;
  to?: number;
  /** Per-run section and dressing, over the network's own defaults — and a held span count. */
  options?: TrailLayoutOptions;
}

/** A knitted junction: the patch fan filling the opening the retracted ribbons left around a node. */
export interface TrailJunction {
  node: number;
  /** Vertex at the centre of the fan, its valence twice the number of trails meeting here — or null on the split
   *  line of a path of an odd number of lanes, which has no rail at the centre. */
  center: number | null;
  /** Every vertex it added, in order: a crotch per arm, the hub, then the points its lanes run through. */
  vertices: number[];
  /** Its patches, arm by arm: the arm's lanes carried on, and the patches narrowing a wider one to two. */
  quads: number[];
  /** Which lane each patch carries on, index-parallel with `quads`: of which run, at its head or its tail, and which of
   *  the `of` lanes that end has, from the run's own left rim. */
  lanes: { run: number; atHead: boolean; lane: number; of: number }[];
  /** How far back up each trail the fan reaches. */
  reachM: number;
  /** Trails meeting here, in the order they leave. */
  runs: number[];
}

export type TrailNetworkResult =
  /** `trims`: where each run's ribbon starts and ends on its spline, its junctions having taken their room. */
  | { ok: true; doc: QuadMeshDoc; runs: TrailRibbon[]; trims: TrailSplineTrim[]; junctions: TrailJunction[]; quads: number[] }
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
{ segment: number; t: number; f: number } {
  let left = distance;
  for (let i = 0; i < spline.length; i++) {
    if (left <= each[i] || i === spline.length - 1) {
      const f = each[i] < 1e-9 ? 0 : Math.min(1, Math.max(0, left / each[i]));
      return { segment: i, t: arcFractionT(spline[i], f), f };
    }
    left -= each[i];
  }
  return { segment: spline.length - 1, t: 1, f: 1 };
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
  headM: number, tailM: number): ({ spline: TrailCubic[]; profile?: TrailKnotProfile } & TrailSplineTrim) | { error: string } {
  const { each, total } = chainArcs(spline);
  if (headM + tailM >= total) return { error: `nothing is left of it between its junctions` };
  const head = chainParam(spline, each, headM);
  const tail = chainParam(spline, each, total - tailM);
  // A cut landing on a knot belongs to the segment that still has length on the far side of it.
  if (head.t > 1 - 1e-9 && head.segment < spline.length - 1) { head.segment++; head.t = 0; head.f = 0; }
  if (tail.t < 1e-9 && tail.segment > 0) { tail.segment--; tail.t = 1; tail.f = 1; }

  const out: TrailCubic[] = head.segment === tail.segment
    ? [sliceCubic(spline[head.segment], head.t, tail.t)]
    : [
      sliceCubic(spline[head.segment], head.t, 1),
      ...spline.slice(head.segment + 1, tail.segment),
      sliceCubic(spline[tail.segment], 0, tail.t),
    ];

  const trim: TrailSplineTrim = { from: { segment: head.segment, t: head.t }, to: { segment: tail.segment, t: tail.t } };
  if (!profile) return { spline: out, ...trim };
  // A new end knot reads the profile where it lands, by the arc fraction generation reads it with. A bank only
  // fixed on one side of it has no single value there; the nearer knot's choice carries.
  const carry = <T extends number | null>(values: readonly T[]): T[] => {
    const at = (segment: number, f: number): T => {
      const a = values[segment], b = values[segment + 1];
      if (a === null || b === null) return f < 0.5 ? a : b;
      return lerpNumber(a, b, f) as T;
    };
    return head.segment === tail.segment
      ? [at(head.segment, head.f), at(tail.segment, tail.f)]
      : [at(head.segment, head.f), ...values.slice(head.segment + 1, tail.segment + 1), at(tail.segment, tail.f)];
  };
  const carried: TrailKnotProfile = {};
  // Only carry the arrays that were there: generation reads a knot profile by its keys, and a key present
  // with nothing behind it is not the same as a key that was never set.
  for (const key of ['widthM', 'dishFraction', 'centerBias', 'bankStrength'] as const)
    if (profile[key]) carried[key] = carry(profile[key]!);
  if (profile.bankDegrees) carried.bankDegrees = carry(profile.bankDegrees);
  return { spline: out, profile: carried, ...trim };
}

/** Where a trimmed chain starts and ends on the chain it was cut from: a segment of that chain, and a parameter of
 *  that segment's cubic. */
export interface TrailSplineTrim { from: { segment: number; t: number }; to: { segment: number; t: number } }

/** A place on a trimmed chain — `t` along its `segment` — as the same place on the chain it was cut from. The trimmed
 *  ends are de Casteljau restrictions, which reparameterise linearly. */
export function untrimmedSplinePlace(trim: TrailSplineTrim | undefined, segment: number, t: number): { segment: number; t: number } {
  if (!trim) return { segment, t };
  const { from, to } = trim, at = from.segment + segment;
  const t0 = segment === 0 ? from.t : 0, t1 = at === to.segment ? to.t : 1;
  return { segment: at, t: t0 + t * (t1 - t0) };
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
 * **It carries every lane on into the junction.** Each trail's centre seam runs on to a HUB at the node, and
 * each pair of neighbouring trails' facing rims runs on to the CROTCH where they meet. Between a seam spoke and a
 * crotch spoke lies one lane of one trail, so the opening fills with one patch per lane — two per trail — each
 * wound and parameterised as the lane it continues: a three-way junction is six quads around a valence-6 hub,
 * which is what the shipped levels knit by hand. The end vertices are the ribbons' own, so the network comes out
 * as one connected surface.
 *
 * Every junction is two lanes in and out at its hub, so a trail of other than two lanes changes to two over its last
 * spans on its way in — a lane a span, the middle ones ending in wedges (`trailSpanPatches`). Two arms meeting alone —
 * a path split in two, two paths laid end to end — are as wide as the narrower: the wider narrows to it, and every lane
 * runs straight on across the split line.
 */
export function applyTrailNetwork(doc: QuadMeshDoc, runs: readonly TrailRunSpec[],
  options: TrailNetworkOptions = {}): TrailNetworkResult {
  if (!runs.length) return { ok: false, error: 'A trail network needs at least one run.' };
  const maxReach = options.maxJunctionReachM ?? NETWORK_DEFAULTS.maxJunctionReachM;
  const minRun = options.minRunLengthM ?? NETWORK_DEFAULTS.minRunLengthM;
  const optionsFor = (run: TrailRunSpec): TrailOptions => ({ ...options, ...run.options });
  const lanesOf = (run: number): number => optionsFor(runs[run]).lanes ?? MESA_TRAIL_DEFAULTS.lanes;

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
        /**
         * Two neighbouring trails' facing rims have to meet before either ribbon ends: the crotch where they do
         * is a corner of both lanes' junction patches, and a lane patch runs from its ribbon's end back to it.
         */
        const meet = rimMeet(a, b);
        const asked = Math.max(meet.a, meet.b);
        if (asked > binding.need) {
          let wedge = ((b.bearing - a.bearing) * 180) / Math.PI;
          while (wedge <= 0) wedge += 360;
          binding = { need: asked, pair: [a, b], wedge };
        }
      }
      return binding.need;
    };
    /**
     * Find it by working OUT from the node, not in from the far limit: trails that part at a junction are not
     * bound to go on parting — a bypass leaves its trail and bends back to rejoin it, so far out it runs alongside
     * again — and only the nearest reach that is enough decides the fan. Step out until one is, then narrow it.
     */
    let below = 0, enough = -1;
    for (let candidate = Math.min(2, maxReach); ; candidate = Math.min(maxReach, candidate * 1.25 + 1)) {
      if (settle(candidate) <= candidate) { enough = candidate; break; }
      below = candidate;
      if (candidate >= maxReach) break;
    }
    if (enough < 0) {
      const [a, b] = binding.pair;
      return { ok: false, error: `Junction ${node}: runs ${a.run} and ${b.run} still leave it `
        + `${binding.wedge.toFixed(0)}° apart ${maxReach} m out, at ${a.half.toFixed(0)} and `
        + `${b.half.toFixed(0)} m half-width — their rims would need ${binding.need.toFixed(0)} m to stop `
        + 'crossing. Narrow them or widen the fork.' };
    }
    let low = below, high = enough;
    for (let step = 0; step < 16; step++) {
      const middle = (low + high) / 2;
      if (settle(middle) <= middle) high = middle; else low = middle;
    }
    // A little past the point where the rims stop crossing, so the opening has some width where they part
    // rather than pinching to nothing at the crotch.
    reach.set(node, Math.min(maxReach, high * 1.15));
    settle(reach.get(node)!);
    // Start the ring at the lowest-numbered run, so the fan's crotches and patches come out in the same order
    // however the bearings turn — the order an owned trail names them by (trail-object.ts).
    const first = list.reduce((best, arm, i) => arm.run < list[best].run ? i : best, 0);
    list.push(...list.splice(0, first));
  }

  // ---- the lanes each run ends with ------------------------------------------------------------------------------
  // Every junction is two lanes in and out at its hub, and a path split — or two paths laid end to end — as wide as the
  // narrower across the point: a run changes to that over its last spans (`trailStationLanes`), a lane a span.
  const laneEnds = runs.map((_, i): [number, number] => [lanesOf(i), lanesOf(i)]);
  for (const list of arms.values()) {
    if (list.length < 2) continue;
    const meeting = list.length === 2 ? Math.min(...list.map(arm => lanesOf(arm.run))) : 2;
    for (const arm of list) laneEnds[arm.run][arm.atHead ? 0 : 1] = meeting;
  }

  // ---- generate every ribbon, cut back to its junctions -----------------------------------------------------
  let out = doc;
  const ribbons: TrailRibbon[] = [];
  const trims: TrailSplineTrim[] = [];
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
    const ribbon = applyTrailSpline(out, trimmed.spline, { ...opts, knotProfile: trimmed.profile, laneEnds: laneEnds[i] });
    if (!ribbon.ok) return { ok: false, error: `Run ${i}: ${ribbon.error}` };
    out = ribbon.doc;
    ribbons.push(ribbon);
    trims.push({ from: trimmed.from, to: trimmed.to });
    created.push(...ribbon.quads);
  }

  // ---- knit the junctions ------------------------------------------------------------------------------------
  const upright = Math.sign(patchPlanArea(out.vertices, out.quads[ribbons[0].quads[0]]));
  const vertices = out.vertices.slice();
  const quads = out.quads.map(quad => quad.slice());
  const junctions: TrailJunction[] = [];
  /** Every junction patch, the run it carries on and at which end, and which of the lanes at that end of the run — `of`
   *  them, from the generator's left rim. */
  const laneOf: { quad: number; run: number; atHead: boolean; lane: number; of: number }[] = [];
  const point = (v: number): V3 => [vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]];
  const between = (a: V3, b: V3, t: number): V3 => [lerpNumber(a[0], b[0], t), lerpNumber(a[1], b[1], t), lerpNumber(a[2], b[2], t)];
  const addVertex = (p: V3): number => vertices.push(p[0], p[1], p[2]) / 3 - 1;

  for (const [node, list] of arms) {
    if (list.length < 2) continue;
    const R = reach.get(node)!;
    const centre = position.get(node)!;
    const first = vertices.length / 3, firstLane = laneOf.length;

    /** Each trail's end cross-section, rim to rim, in the frame of a skier leaving the junction along it: the
     *  ribbon's own rails run the other way when the trail runs INTO the node rather than out of it. */
    const ends = list.map(arm => {
      const ribbon = ribbons[arm.run];
      const at = arm.atHead ? 0 : ribbon.stations.length - 1;
      const across = [...ribbon.sections[at]];
      return { arm, cross: arm.atHead ? across : across.reverse(), middle: ribbon.stations[at].center };
    });

    // A crotch between every neighbouring pair, `crotches[i]` between trail i's right rim and trail i+1's left.
    const crotches: number[] = [];
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i], b = ends[(i + 1) % ends.length];
      let wedge = b.arm.bearing - a.arm.bearing;
      while (wedge <= 0) wedge += Math.PI * 2;
      /** Walk both rims back toward the node from where the ribbons stopped, and return where they meet.
       *  Refused if they meet behind the node or further out than the ribbons stop. */
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
      const aPoint = point(a.cross[a.cross.length - 1]), bPoint = point(b.cross[0]);
      const met = wedge < Math.PI * 0.97 ? back(aPoint, a.arm.out, bPoint, b.arm.out) : null;
      /**
       * Where the rims do not meet ahead of the node — a wide side, where the two trails part at or past a straight
       * line — the crotch is where their rim LINES cross, which is on the wedge's bisector, `h / sin(wedge / 2)`
       * out: abeam the node for a trail running straight through, the outer corner of a bend. The two lane
       * patches either side of it come out squared off rather than bulging past the rims.
       */
      const bisect = a.arm.bearing + wedge / 2;
      const out = Math.min(R * 2, ((a.arm.half + b.arm.half) / 2) / Math.max(0.2, Math.sin(wedge / 2)));
      const plan: V3 = met ?? [centre[0] + Math.cos(bisect) * out, 0, centre[2] + Math.sin(bisect) * out];
      // Sit the crotch on the plane through the two rim points it joins, so the junction stays on the hillside.
      plan[1] = (aPoint[1] + bPoint[1]) / 2;
      crotches.push(vertices.length / 3);
      vertices.push(...plan);
    }

    /**
     * Two arms meet as wide as each other (`laneEnds`) — a path split in two, a loop closed on itself, two paths laid
     * end to end — and run straight on across the point, lane for lane, through a cross-section of its own there: a
     * point a rail, crotch to crotch, sharing out each side as the ribbon does, at the height where the rail's two ends
     * meet. More arms meet two lanes wide at the hub.
     */
    const through = ends.length === 2;
    const width = ends[0].cross.length - 1;
    // The hub is the junction ITSELF, where every trail's centre line runs to: one rail's point on a split line, which
    // an odd number of lanes has no rail at.
    const hubAt: V3 = [centre[0], ends.reduce((s, e) => s + e.middle[1], 0) / ends.length, centre[2]];
    const hub = through && width % 2 ? null : addVertex(hubAt);

    /**
     * Each lane carried on, written as the ribbon writes its own lane quads — a station further along, or one before
     * the first — so it winds as the ribbon does and wears its lane's tile the same way round. Leaving the junction the
     * ribbon's left is the skier's; arriving, its left is the skier's right.
     *
     * A patch that turns over is a crotch in the wrong place, and there is no repairing it downstream: an
     * inverted locked patch fails the mountain's own check and the retopologiser's after it. Where the rims
     * genuinely cannot be resolved the junction is refused by name, and the caller drops or moves a trail.
     */
    const fan: number[] = [];
    let splitLine: number[] = [];
    for (let i = 0; i < ends.length; i++) {
      const end = ends[i], lanes = end.cross.length - 1;
      const before = crotches[(i + ends.length - 1) % ends.length], after = crotches[i];
      /** `k` of `lanes` sides across from `before` through the hub to `after`, each half shared as the ribbon shares
       *  its side of the width. */
      const across = (k: number): V3 =>
        k <= lanes / 2 ? between(point(before), hubAt, k / (lanes / 2)) : between(hubAt, point(after), k / (lanes / 2) - 1);
      let inner: number[];
      if (!through) {
        if (lanes !== 2) return { ok: false, error: `Junction ${node}: run ${end.arm.run} reaches it ${lanes} lanes wide, not two.` };
        inner = [before, hub!, after];
      } else if (i === 0) {
        // The first arm makes the split line's points, crotch 1 to crotch 0; the second runs back along them.
        inner = splitLine = Array.from({ length: width + 1 }, (_, k) => {
          if (k === 0) return before;
          if (k === width) return after;
          if (hub !== null && k === width / 2) return hub;
          const p = across(k);
          p[1] = (point(end.cross[k])[1] + point(ends[1].cross[width - k])[1]) / 2;
          return addVertex(p);
        });
      } else inner = [...splitLine].reverse();
      for (let k = 0; k < lanes; k++) {
        const corners = end.arm.atHead ? [inner[k], inner[k + 1], end.cross[k], end.cross[k + 1]]
          : [end.cross[k + 1], end.cross[k], inner[k + 1], inner[k]];
        if (Math.sign(patchPlanArea(vertices, corners)) !== upright) {
          const beside = ends[(i + (k < lanes / 2 ? ends.length - 1 : 1)) % ends.length];
          return { ok: false, error: `Junction ${node}: runs ${end.arm.run} and ${beside.arm.run} leave it in a shape `
            + 'its lanes cannot be carried into — one of them has to go, or leave at a wider angle. '
            + `[reach ${R.toFixed(0)} m, halves ${list.map(arm => arm.half.toFixed(0)).join('/')}]` };
        }
        fan.push(quads.length);
        laneOf.push({ quad: quads.length, run: end.arm.run, atHead: end.arm.atHead, lane: end.arm.atHead ? k : lanes - 1 - k, of: lanes });
        quads.push(corners);
      }
    }
    junctions.push({
      node, center: hub, quads: fan, reachM: R, runs: list.map(arm => arm.run),
      vertices: Array.from({ length: vertices.length / 3 - first }, (_, k) => first + k),
      lanes: laneOf.slice(firstLane).map(({ run, atHead, lane, of }) => ({ run, atHead, lane, of })),
    });
    created.push(...fan);
  }

  const manifold = checkManifold(quads);
  if (!manifold.ok) {
    return { ok: false, error: 'The knitted network drives an edge onto three or more patches — two runs are '
      + 'on the same ground, or a junction was left out.' };
  }

  const added = { vertices: vertices.length / 3 - out.vertices.length / 3, quads: quads.length - out.quads.length };
  const network: QuadMeshDoc = { ...out, vertices, quads, ...appendMeshIds(out, added.vertices, added.quads) };

  // A junction patch is its lane carried on, so it wears its path's trail tile — a junction is not a turn, so the
  // turn tiles stop where the ribbon does even when its last span is tight.
  const quadPaint = { ...(network.quadPaint ?? {}) };
  const quadTex = { ...(network.quadTex ?? {}) };
  const quadOrient = { ...(network.quadOrient ?? {}) };
  for (const { quad, run, lane, of } of laneOf) {
    const dress = { ...MESA_TRAIL_DEFAULTS, ...optionsFor(runs[run]) };
    quadPaint[quad] = dress.surface;
    const tile = textureForSpan(dress.textures, 0, of);
    if (tile?.tiles[lane]) {
      const orient = { rot: (((tile.orient.rot + tile.turns[lane]) % 4) + 4) % 4, mirror: tile.orient.mirror };
      quadTex[quad] = tile.tiles[lane];
      quadOrient[quad] = tile.mirrors[lane] ? mirrorAcross(orient) : orient;
    }
  }
  network.quadPaint = quadPaint;
  if (Object.keys(quadTex).length) { network.quadTex = quadTex; network.quadOrient = quadOrient; }

  return { ok: true, doc: network, runs: ribbons, trims, junctions, quads: created };
}
