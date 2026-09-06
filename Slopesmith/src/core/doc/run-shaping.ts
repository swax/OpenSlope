import type { CoursePath, CourseKnot, QuadMeshDoc } from './types';
import { frameAt, paramsAt, sampleSpine, type SpineSample } from '../math/spine';
import { smoothstep } from '../math/scalar';
import { readVertex } from '../mesh/primitives';
import { lockedVertexSet } from '../mesh/locks';

/**
 * The run's CROSS-SECTION as terrain: the profile a knot's `width` / `wall` / `bank` / `shoulder` describe,
 * and the two operations that press it into a surface.
 *
 * The knots have always carried this ribbon — a floor of a given width, quarter-pipe walls at its edges, a
 * shoulder beyond them and a bank rolling the whole section — but for a long time only the one-shot generator
 * seat (`seatCourse`, on the build-time `GridNet`) ever read it, so the three profile fields were dead on
 * every document the editor actually holds. `shapeRunIntoTerrain` is the same profile applied to the quad
 * mesh, which is what makes them authoring controls: set a chute to 60 m with 30 m walls, a plaza to 260 m
 * flat, roll 20° of bank through a bend, press the button, and the terrain is that.
 *
 * It is a COMMAND, not a derive step. The mountain is its mesh — the course is a line through it, never a
 * modifier over it (docs/006) — so the shaping is written into the vertices once and everything afterwards
 * (sculpt, Edit, paint) owns the result. Re-running it re-asserts the profile over whatever has happened
 * since, which is the loop an author works in.
 *
 * Heights only. Vertices keep their XZ, so the floor spans exactly the authored width in plan and the op
 * cannot fold a patch sideways into its neighbour; a wall past vertical is Edit work, not a knot field.
 */

/** The knot fields that describe the ribbon at a station — everything `crossHeight` needs. */
export type CrossSection = Pick<CourseKnot, 'width' | 'wall' | 'bank' | 'shoulder'>;

/**
 * Ribbon surface height at signed lateral offset `s` (0 = floor centre), relative to the spine: flat floor
 * out to width/2, quarter-pipe walls rising to `wall`, a shoulder beyond, plus the bank tilt. This is the one
 * definition of the profile — the legacy grid seat and the mesh shaping below both sweep it, so a course
 * seeded by the generator and one shaped in the editor have the same cross-section.
 */
export function crossHeight(p: CrossSection, s: number): number {
  const e = p.width / 2;
  const L = Math.max(p.wall, 1.2); // wall lateral extent; non-degenerate even at wall=0
  const a = Math.abs(s);
  let h: number;
  if (a <= e) h = 0;
  else if (a <= e + L) h = p.wall * smoothstep((a - e) / L);
  else { const sh = Math.max(p.shoulder, 0.5); h = p.wall + 0.15 * sh * smoothstep((a - e - L) / sh); }
  return h + s * Math.sin((p.bank * Math.PI) / 180); // bank rolls the section about the spine
}

/** How far to either side of the spine the profile itself reaches, before `blend` fades it out. */
export function crossReach(p: CrossSection): number {
  return p.width / 2 + Math.max(p.wall, 1.2) + Math.max(p.shoulder, 0.5);
}

/** The spine sampled once, with its line, so a whole shaping pass shares one table. */
export interface CourseSamples {
  samples: SpineSample[];
  line: CoursePath;
}

/** The run's spine, sampled for a seat — null when it has too few knots to sweep. */
export const courseSamples = (line: CoursePath): CourseSamples | null =>
  line.knots.length >= 2 ? { line, samples: sampleSpine(line.knots) } : null;

/**
 * Nearest spine sample to an overhead point, coarse-then-fine. The samples are dense (32 per segment, so a
 * few metres apart on an ordinary run) and a full scan per subsample is the single hottest loop in a shaping
 * pass; striding the first sweep and refining a window around its winner is exact wherever the line does not
 * double back inside one stride, which a rideable run does not.
 */
const STRIDE = 4;
function nearestSample(samples: SpineSample[], x: number, z: number): SpineSample {
  let best = 0, bestD2 = Infinity;
  for (let i = 0; i < samples.length; i += STRIDE) {
    const dx = samples[i].pos[0] - x, dz = samples[i].pos[2] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  const lo = Math.max(0, best - STRIDE - 2), hi = Math.min(samples.length - 1, best + STRIDE + 2);
  for (let i = lo; i <= hi; i++) {
    const dx = samples[i].pos[0] - x, dz = samples[i].pos[2] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return samples[best];
}

/** The run's influence at (x, z): the pull toward the ribbon (t in 0..1), the target world height there, the
 *  floor surface, and whether (x, z) sits over the floor (for the strip paint). Null beyond the blend. */
export function seatSample(cs: CourseSamples, x: number, z: number):
{ t: number; y: number; surface: number; onFloor: boolean } | null {
  const sp = nearestSample(cs.samples, x, z);
  const { side } = frameAt(sp.fwd);
  const off = (x - sp.pos[0]) * side[0] + (z - sp.pos[2]) * side[2]; // signed lateral offset (horizontal)
  const p = paramsAt(cs.line.knots, sp.k);
  const beyond = Math.abs(off) - crossReach(p);
  if (beyond >= cs.line.blend) return null;
  const t = beyond <= 0 ? 1 : 1 - smoothstep(beyond / Math.max(1e-6, cs.line.blend));
  return { t, y: sp.pos[1] + crossHeight(p, off), surface: cs.line.surface, onFloor: Math.abs(off) <= p.width / 2 };
}

/** What one shaping pass did, for the toast and for a test to assert on. */
export interface RunShapingResult {
  /** Vertices the run reached and moved. */
  moved: number;
  /** Largest vertical adjustment, metres — how far the terrain was from the authored profile. */
  maxAdjust: number;
  /** Quads repainted to the run's floor surface. */
  painted: number;
  /** Vertices the run reached but a locked patch held. */
  held: number;
}

export interface RunShapingOptions {
  /** NxN subsamples per vertex (1 = a single point). The profile's wall and floor edges are far finer than
   *  the net's spacing, so a diagonal run sampled once per vertex staircases; averaging over a cell-sized
   *  window is a box low-pass at the net's own frequency, which lands the wall as a ramp the bicubic holds. */
  subsamples?: number;
  /** Width of that window, in net spacings. */
  footprint?: number;
  /** Paint the floor strip with the run's surface. */
  paint?: boolean;
}

/**
 * Press the run's cross-section into the terrain: move every vertex the ribbon reaches toward the profile,
 * fading back to the terrain it already has over the run's `blend`, then paint the floor strip.
 *
 * The band beyond the profile is a MIX with the current surface rather than a target of its own, so the hill
 * outside the run keeps whatever the generator or a sculpt gave it and only its last few metres bend in to
 * meet the shoulder. That is also why running this twice is not the same as running it once with a wider
 * blend: each pass drags the blend band a little further toward the ribbon, and it converges there.
 *
 * Locked patches are honoured exactly as sculpt honours them — a shaped run flows around a frozen feature
 * instead of flattening it — and the count of held vertices comes back so the caller can say so.
 */
export function shapeRunIntoTerrain(doc: QuadMeshDoc, opts: RunShapingOptions = {}): RunShapingResult {
  const result: RunShapingResult = { moved: 0, maxAdjust: 0, painted: 0, held: 0 };
  const cs = courseSamples(doc.course);
  if (!cs || !doc.vertices.length) return result;

  const N = Math.max(1, Math.round(opts.subsamples ?? 4));
  const R = (doc.spacing * (opts.footprint ?? 1.2)) / 2;      // half-window of the box low-pass
  const at = (k: number) => (N === 1 ? 0 : (k / (N - 1) - 0.5) * 2 * R);
  const locked = doc.quadLocked ? lockedVertexSet(doc) : null;

  for (let id = 0; id < doc.vertices.length / 3; id++) {
    const p = readVertex(doc.vertices, id);
    let sum = 0, hit = false;
    for (let a = 0; a < N; a++) {
      for (let b = 0; b < N; b++) {
        const seat = seatSample(cs, p[0] + at(a), p[2] + at(b));
        if (seat) hit = true;
        sum += seat ? seat.y * seat.t + p[1] * (1 - seat.t) : p[1];
      }
    }
    if (!hit) continue;                                       // leave vertices no run reaches
    if (locked?.has(id)) { result.held++; continue; }
    const y = sum / (N * N);
    const adjust = Math.abs(y - p[1]);
    if (adjust > 1e-9) {
      result.moved++;
      result.maxAdjust = Math.max(result.maxAdjust, adjust);
      doc.vertices[id * 3 + 1] = y;
    }
  }

  if (opts.paint !== false) {
    for (let q = 0; q < doc.quads.length; q++) {
      let cx = 0, cz = 0;
      for (const id of doc.quads[q]) { cx += doc.vertices[id * 3] / 4; cz += doc.vertices[id * 3 + 2] / 4; }
      const seat = seatSample(cs, cx, cz);
      if (!seat?.onFloor) continue;
      if (doc.quadLocked?.[q]) continue;
      if ((doc.quadPaint ??= {})[q] === seat.surface) continue;
      doc.quadPaint[q] = seat.surface;
      result.painted++;
    }
  }
  return result;
}

/** A knot's fields clamped to what the profile can express. Shared by the editor controls and any importer,
 *  so a hand-edited document and a dragged slider land on the same ranges. */
export const KNOT_LIMITS = {
  width: { min: 20, max: 3000, step: 5 },
  wall: { min: 0, max: 120, step: 1 },
  bank: { min: -45, max: 45, step: 1 },
  shoulder: { min: 0, max: 200, step: 1 },
} as const;

/** The steepest a painted snow / ice surface holds a board before it slides (the ride table's `tilt` column,
 *  58.3° for snow and most rock-free surfaces, 45° for ice). A wall face past it is scenery, not a berm. */
const HOLDABLE_TILT_DEG = 58.3;
/** A wall's face angle with no bank: its lateral run equals its height, so 45°. */
const WALL_FACE_DEG = 45;

/**
 * What this cross-section will do that its author probably did not mean — checked from the four numbers
 * alone, so it can be shown beside the sliders and printed by a build recipe.
 *
 * There is one trap here and it is not obvious: **bank rolls the walls with the floor.** Bank the section far
 * enough and the downhill wall's crest drops below the floor it was supposed to contain, so the "banked turn"
 * is a chute open on its outside edge and the whole field slides out of it into the shoulder. The rule is
 * `wall > (width/2 + wall)·sin|bank|` and it bites hardest exactly where a designer wants it least: a wide
 * floor needs a tall wall to survive even a gentle bank.
 *
 * The mirror of it is cheaper to fix but worth saying: the UPHILL wall stands at 45° + |bank|, and past ~58°
 * nothing holds to it, so a hard bank turns the outside of the berm into a slide back down.
 */
export function profileWarnings(p: CrossSection): string[] {
  const out: string[] = [];
  const bank = Math.abs(p.bank);
  if (bank > 0.5 && p.width > 0) {
    const crest = p.width / 2 + Math.max(p.wall, 1.2);
    const spill = crest * Math.sin((bank * Math.PI) / 180);
    if (p.wall <= spill) {
      const needed = Math.ceil((p.width / 2) * Math.sin((bank * Math.PI) / 180)
        / Math.max(0.05, 1 - Math.sin((bank * Math.PI) / 180)));
      const easedTo = Math.floor((Math.asin(Math.min(0.99, p.wall / Math.max(1, crest))) * 180) / Math.PI);
      out.push(`the ${bank.toFixed(0)}° bank tips the downhill wall crest ${(spill - p.wall).toFixed(0)} m `
        + `below the floor — nothing holds a rider in the turn. Raise the wall past ${needed} m, `
        + `or ease the bank to ${easedTo}°.`);
    }
    if (WALL_FACE_DEG + bank > HOLDABLE_TILT_DEG) {
      out.push(`the uphill wall stands at ${(WALL_FACE_DEG + bank).toFixed(0)}°, past the `
        + `${HOLDABLE_TILT_DEG}° a board holds — its upper face is a slide, not a berm.`);
    }
  }
  if (p.wall > 0 && p.wall < 3) {
    out.push(`a ${p.wall.toFixed(0)} m wall is under the terrain's own patch size and will not survive the `
      + 'surface fit — either commit to a wall or set it to 0 and let the shoulder spill.');
  }
  return out;
}

export function clampKnotProfile(knot: CourseKnot): CourseKnot {
  const fit = (v: number, l: { min: number; max: number }) =>
    (Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, v)) : l.min);
  knot.width = fit(knot.width, KNOT_LIMITS.width);
  knot.wall = fit(knot.wall, KNOT_LIMITS.wall);
  knot.bank = fit(knot.bank, KNOT_LIMITS.bank);
  knot.shoulder = fit(knot.shoulder, KNOT_LIMITS.shoulder);
  return knot;
}
