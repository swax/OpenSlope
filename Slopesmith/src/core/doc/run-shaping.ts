import type { CoursePath, CourseKnot } from './types';
import { frameAt, paramsAt, sampleSpine, type SpineSample } from '../math/spine';
import { smoothstep } from '../math/scalar';

/**
 * The run's CROSS-SECTION as terrain: the channel a knot's `width` / `wall` / `bank` / `shoulder` describe — a
 * floor of a given width, quarter-pipe walls at its edges, a shoulder beyond them and a bank rolling the whole
 * section.
 *
 * Only one thing still reads it: the legacy-carve migration (mountain.ts `seatCourse`), which re-creates an old
 * save's carved channel on its build-time grid so the document opens with the terrain it was saved with. The
 * editor no longer presses the profile into a mountain — the course is a line through the terrain and nothing
 * else, and a groomed path is built with Edit ▸ Create Trail — so `wall`, `bank` and `shoulder` have no controls
 * and new runs carry DEFAULT_KNOT_PROFILE's. `width` still means something: it bounds the AI field's weave.
 */

/** The knot fields that describe the ribbon at a station — everything `crossHeight` needs. */
export type CrossSection = Pick<CourseKnot, 'width' | 'wall' | 'bank' | 'shoulder'>;

/**
 * Ribbon surface height at signed lateral offset `s` (0 = floor centre), relative to the spine: flat floor
 * out to width/2, quarter-pipe walls rising to `wall`, a shoulder beyond, plus the bank tilt.
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

/** The spine sampled once, with its line, so a whole seat shares one table. */
export interface CourseSamples {
  samples: SpineSample[];
  line: CoursePath;
}

/** The run's spine, sampled for a seat — null when it has too few knots to sweep. */
export const courseSamples = (line: CoursePath): CourseSamples | null =>
  line.knots.length >= 2 ? { line, samples: sampleSpine(line.knots) } : null;

/**
 * Nearest spine sample to an overhead point, coarse-then-fine. The samples are dense (32 per segment, so a
 * few metres apart on an ordinary run) and a full scan per subsample is the single hottest loop in a seat;
 * striding the first sweep and refining a window around its winner is exact wherever the line does not
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

/** The range the Selected-knot floor width slider offers. */
export const KNOT_WIDTH_LIMITS = { min: 20, max: 3000, step: 5 } as const;

/** A floor width clamped to KNOT_WIDTH_LIMITS (a non-number reads as the minimum). */
export function clampKnotWidth(width: number): number {
  return Number.isFinite(width) ? Math.min(KNOT_WIDTH_LIMITS.max, Math.max(KNOT_WIDTH_LIMITS.min, width))
    : KNOT_WIDTH_LIMITS.min;
}
