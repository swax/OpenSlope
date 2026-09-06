import type { CoursePath, QuadMeshDoc, V3 } from './types';
import { frameAt, paramsAt, sampleSpine, spineAt, totalLength } from '../math/spine';
import { add, mul, norm, cross, sub } from '../math/vec';
import { surfaceHeightAt } from '../mesh/surface-height';

/**
 * The course line's shipped endpoints: where the game puts the rider (the SOP start gates) and where
 * the race ends (the race line's DistanceToFinish zero). The level export (AIP.json / SOP.json / the
 * start-gate prop) and the viewport's start/finish preview both read THESE functions, so the markers
 * the editor draws are the positions the disc ships.
 */

/** Riders the SOP stages: one start gate each, like every retail level. */
export const GATE_COUNT = 6;
/** Retail gate pitch — GARI's six SOP gates sit ~1.4 m apart across the start line. */
export const GATE_SPACING = 1.4;
/** Gate-path points that fade the lateral gate offset back onto the course line. */
const GATE_FADE_POINTS = 5;
/** Gate-path length in course points (~150 m at the ~15 m step; retail lead-ins run 250-375 m). */
const GATE_LINE_POINTS = 10;

/** The ~15 m sampling step every exported path shares, so the gate lead-ins, the AI lines and the race-line
 *  spine all land on the same stations. */
function sampleStep(total: number): number {
  return Math.max(10, total / Math.max(2, Math.round(total / 15)));
}

/** The exported AIP path's centers: the course spine sampled at ~15 m steps (always >= 2 points). Spans the
 *  WHOLE run, start anchor or not — this is the respawn spine and the race-line ruler, which have to cover
 *  the line a rider can be on, not just the raced part. */
export function courseCenters(course: CoursePath): V3[] {
  const samples = sampleSpine(course.knots);
  const total = totalLength(samples);
  const step = sampleStep(total);
  const centers: V3[] = [];
  for (let s = 0; s <= total + 1e-6; s += step) centers.push(spineAt(samples, Math.min(s, total)).pos);
  return centers;
}

/** One end of the course: its point on the line, the horizontal frame there, and the run floor width. */
export interface CourseEndFrame {
  pos: V3;
  /** Unit tangent, pointing downhill (start -> finish). */
  fwd: V3;
  /** Horizontal unit side vector (fwd x world-up). */
  side: V3;
  /** Run floor width here, metres (knot 0 / last knot). */
  width: number;
  /** Floor-edge points — the start gate's pillars straddle these. */
  left: V3;
  right: V3;
}

function endFrame(pos: V3, fwd: V3, width: number): CourseEndFrame {
  const side = norm(cross(fwd, [0, 1, 0]));
  const half = width / 2;
  return { pos, fwd, side, width, left: add(pos, mul(side, -half)), right: add(pos, mul(side, half)) };
}

/**
 * The arc position along the spine, in metres, of an anchor placed off the line — the station of the
 * nearest point on the sampled spine. A dragged marker keeps the run's own heading and width at that
 * station, so it stays square to the line and can never face uphill.
 */
function anchorStation(course: CoursePath, pos: V3): number {
  const samples = sampleSpine(course.knots);
  let best = Infinity, station = 0;
  for (const s of samples) {
    const d = (s.pos[0] - pos[0]) ** 2 + (s.pos[1] - pos[1]) ** 2 + (s.pos[2] - pos[2]) ** 2;
    if (d < best) { best = d; station = s.s; }
  }
  return station;
}

/** Where the field is staged, as an arc position along the run: 0 unless a start anchor moved it. */
export function startStation(course: CoursePath): number {
  return course.start ? anchorStation(course, course.start.pos) : 0;
}

/** Where the race is won, as an arc position along the run: the run's full length unless moved. */
export function finishStation(course: CoursePath): number {
  const samples = sampleSpine(course.knots);
  return course.finish ? anchorStation(course, course.finish.pos) : totalLength(samples);
}

/** The frame at an arc station: the run's own heading and floor width there, with the anchor's own position. */
function stationFrame(course: CoursePath, pos: V3, station: number): CourseEndFrame {
  const samples = sampleSpine(course.knots);
  const smp = spineAt(samples, Math.min(Math.max(station, 0), totalLength(samples)));
  return endFrame(pos, smp.fwd, paramsAt(course.knots, smp.k).width);
}

/** Where the field is staged. Absent an anchor this is the course head, whose gate is exactly perpendicular
 *  to the first two authored nodes; spline sampling would let node 2 bend the first finite-difference tangent
 *  before the race even starts. */
export function startFrame(course: CoursePath): CourseEndFrame {
  if (course.start) return stationFrame(course, course.start.pos, startStation(course));
  const a = course.knots[0].pos, b = course.knots[1].pos;
  const chord = sub(b, a);
  // A coincident/vertical first pair has no overhead direction; retain the sampled fallback for malformed
  // legacy data rather than producing a zero side vector. Ordinary authored courses take the exact chord.
  const fwd = Math.hypot(chord[0], chord[2]) > 1e-9 ? norm(chord) : sampleSpine(course.knots)[0].fwd;
  return endFrame(a, fwd, course.knots[0].width);
}

/** Where the race is won — the exported race line's DistanceToFinish reaches zero here. Absent an anchor
 *  this is the course tail. */
export function finishFrame(course: CoursePath): CourseEndFrame {
  if (course.finish) return stationFrame(course, course.finish.pos, finishStation(course));
  const samples = sampleSpine(course.knots);
  const s = samples[samples.length - 1];
  return endFrame(s.pos, s.fwd, course.knots[course.knots.length - 1].width);
}

/**
 * The SOP start-gate lead-in lines, one per rider: gate `i` starts `(i - (n-1)/2) * pitch` to the side
 * of the course head and its lateral offset fades onto the course line over the first few points, the
 * retail shape (short per-gate lead-ins converging on the racing line). The pitch is the retail 1.4 m
 * squeezed so all gates keep inside the run floor on a narrow start. Element 0 of each line is that
 * rider's spawn point.
 */
export function startGateLines(course: CoursePath): V3[][] {
  // Walk the SAME sample array the export's other paths use rather than re-deriving stations: an untouched
  // run then writes the identical bytes it always has (re-summing `k * step` where the sampler accumulated
  // `s += step` drifts by an ULP, which is invisible on the hill and loud in a golden hash).
  const centers = courseCenters(course);
  const start = startFrame(course);
  const pitch = Math.min(GATE_SPACING, Math.max(0.3, (start.width - 1) / (GATE_COUNT - 1)));
  const step = sampleStep(totalLength(sampleSpine(course.knots)));
  // Which sample the flag stands on — 0 on a run nobody has moved. Kept one short of the end so a flag
  // dropped at the very bottom still has a sample to lead into.
  const k0 = course.start
    ? Math.min(centers.length - 2, Math.max(0, Math.round(startStation(course) / step))) : 0;
  const n = Math.min(GATE_LINE_POINTS, centers.length - 1 - k0);
  const lines: V3[][] = [];
  for (let g = 0; g < GATE_COUNT; g++) {
    const offset = (g - (GATE_COUNT - 1) / 2) * pitch;
    const line: V3[] = [];
    for (let k = 0; k <= n; k++) {
      const fade = Math.max(0, 1 - k / GATE_FADE_POINTS);
      // Point 0 is the staged position itself when a flag placed it, so riders spawn where it sits; with no
      // flag it is the line's own head sample, exactly as before.
      const c = k === 0 && course.start ? start.pos : centers[k0 + k];
      line.push(add(c, mul(start.side, offset * fade)));
    }
    lines.push(line);
  }
  return lines;
}

/** The seed a doc without `aiSeed` derives its AI paths with — every mountain ships an AI field. */
export const DEFAULT_AI_SEED = 1;

/**
 * The line rating (the AIP record's `U3`) every derived AI line exports with, and the one the test ride's field
 * scores them by ([Trailmap: 395]). 0–100 is how *daring* a line is, and an AI rider picks the path whose rating
 * matches its mood — so a shipped level's network is a menu (a safe line, a fast line, a trick line over the same
 * stretch) and 50 is the default down the middle. Every line we derive is a full-course gate route, so they all
 * rate the same and the field has nothing to choose between: giving alternates a spread is what would make an
 * exported field diverge.
 */
export const DEFAULT_LINE_RATING = 50;

/** The band a derived line's rating quantizes onto — retail's own spread (GARI: mostly 50, with 0/20/25/80/100). */
const RATING_STEPS = [0, 25, 50, 80, 100];

/**
 * A rating for each derived AI line, in the same gate order as `aiPathLines`.
 *
 * The engine never labels what a rating *means*; the meaning is inferred from what the AI does with it — a rider
 * short of boost seeks 100, a rider that is winning seeks 0 ([Trailmap: 395]) — so 0 reads as the direct line and
 * 100 as the daring one. Our lines already differ along exactly that axis: each is generated with its own
 * `amp`, "how far into the floor this rider swings", and a line that hugs the fall line *is* the fast safe route
 * while one that swings wide into the shoulders *is* the risky one. So the rating is read off the line's own
 * wander rather than assigned arbitrarily, and it means something you can see in the editor: a leading rider
 * takes the straight line, a trailing one gambles on the wide one.
 *
 * With wandering off, every line is the same centre route — nothing to tell apart, so they all rate the default.
 */
export function aiLineRatings(course: CoursePath, seed: number, wander = true): number[] {
  const ratings: number[] = [];
  for (let g = 0; g < GATE_COUNT; g++) {
    if (!wander) { ratings.push(DEFAULT_LINE_RATING); continue; }
    const amp = 0.35 + 0.55 * hash01(seed, g, 0); // the same roll aiPathLines shapes the line with
    const t = Math.min(1, Math.max(0, (amp - 0.35) / 0.55));
    ratings.push(RATING_STEPS[Math.round(t * (RATING_STEPS.length - 1))]);
  }
  return ratings;
}

/** Deterministic per-(seed, gate, slot) hash in [0,1) — the generators' integer-lattice style, so the
 *  derived AI lines are a pure function of (course, seed) and export == preview. */
function hash01(seed: number, gate: number, slot: number): number {
  let n = (seed | 0) * 374761393 + gate * 668265263 + slot * 1013904223;
  n = (n ^ (n >> 13)) * 1274126177;
  return (((n ^ (n >> 16)) >>> 0) % 100000) / 100000;
}

/**
 * The AI opponents' lines — one per start gate, the `.aip` field shape ([Trailmap: 250-paths-aip-sop]:
 * `StartPosList` names one gate path per rider, seeded in a row at the start line). Line `g` begins AT
 * gate `g`'s route origin (the startGateLines head, shared with the SOP gates) and rides
 * the WHOLE course — retail start paths are ~350 m segments handing off through a fork network; giving
 * each rider a full run bypasses the hand-off machinery entirely. Past the gate fade, each line wanders
 * on its own seeded two-sine lateral offset, bounded by the local run floor, so the six riders take
 * individual lines without leaving the run. Derived, never stored: editing the course re-derives them,
 * and "regenerate" just re-rolls the seed. Stations match courseCenters' ~15 m export sampling.
 */
export function aiPathLines(course: CoursePath, seed: number, wander = true): V3[][] {
  const samples = sampleSpine(course.knots);
  const total = totalLength(samples);
  const step = sampleStep(total);
  const { width } = startFrame(course);
  const s0 = startStation(course);   // an opponent rides from the grid, not from the head of the line
  const pitch = Math.min(GATE_SPACING, Math.max(0.3, (width - 1) / (GATE_COUNT - 1)));
  const lines: V3[][] = [];
  for (let g = 0; g < GATE_COUNT; g++) {
    const gateOffset = (g - (GATE_COUNT - 1) / 2) * pitch;
    const amp = 0.35 + 0.55 * hash01(seed, g, 0);                    // how far into the floor this rider swings
    const l1 = 220 + 320 * hash01(seed, g, 1);                        // long carve wavelength, metres
    const p1 = hash01(seed, g, 2) * Math.PI * 2;
    const l2 = 60 + 110 * hash01(seed, g, 3);                         // short weave wavelength, metres
    const p2 = hash01(seed, g, 4) * Math.PI * 2;
    const line: V3[] = [];
    let k = 0;
    for (let s = s0; s <= total + 1e-6; s += step, k++) {
      const smp = spineAt(samples, Math.min(s, total));
      const { side } = frameAt(smp.fwd);
      const bound = Math.max(0, paramsAt(course.knots, smp.k).width / 2 - 1.5); // shoulder margin inside the floor edge
      const wanderOffset = wander
        ? bound * amp * (0.7 * Math.sin((2 * Math.PI * smp.s) / l1 + p1) + 0.3 * Math.sin((2 * Math.PI * smp.s) / l2 + p2))
        : 0;
      const fade = Math.max(0, 1 - k / GATE_FADE_POINTS);
      line.push(add(smp.pos, mul(side, gateOffset * fade + wanderOffset * (1 - fade))));
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Seat the run on the sculpted terrain: resample each course knot's elevation from the CURRENT quilt
 * surface at its (x, z). The run is a LINE the terrain doesn't follow — sculpting moves the net, never the
 * line — and everything the export derives from the line (per-mode start paths, respawn spine, race line,
 * AI lines) ships its heights verbatim. The StageArea formation is anchored to the same authored origin,
 * so a drifted line puts the entire start system off the snow. Seating the knots re-lands it in one stroke. The height at
 * a knot is the TOPMOST tessellated surface under/over it (a ridable overhang seats on its deck); a knot
 * with no terrain at its (x, z) keeps its height. Returns the largest knot adjustment, metres.
 */
export function seatRunOnTerrain(doc: QuadMeshDoc): number {
  let maxAdjust = 0;
  for (const k of doc.course.knots) {
    const y = surfaceHeightAt(doc, k.pos[0], k.pos[2]);
    if (y === null) continue;
    maxAdjust = Math.max(maxAdjust, Math.abs(k.pos[1] - y));
    k.pos[1] = y;
  }
  return maxAdjust;
}

/** An axis-aligned box: `base` is the bottom-center (the box spans base.y .. base.y + size.y). */
export interface GateBox {
  base: V3;
  size: V3;
}

/**
 * The start-gate prop's boxes — two pillars on the floor edges + a crossbar over the run. The export
 * writes these into Props.obj and the viewport previews the same three boxes. The crossbar is
 * approximated axis-aligned along the gate line's dominant axis, matching the shipped prop.
 */
export function startGateBoxes(left: V3, right: V3): GateBox[] {
  const mid: V3 = [(left[0] + right[0]) / 2, Math.max(left[1], right[1]) + 4, (left[2] + right[2]) / 2];
  const span = Math.hypot(right[0] - left[0], right[2] - left[2]) + 0.5;
  const alongX = Math.abs(right[0] - left[0]) > Math.abs(right[2] - left[2]);
  return [
    { base: left, size: [0.5, 4, 0.5] },
    { base: right, size: [0.5, 4, 0.5] },
    { base: mid, size: [alongX ? span : 0.4, 0.4, alongX ? 0.4 : span] },
  ];
}
