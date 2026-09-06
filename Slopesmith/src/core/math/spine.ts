import type { CourseKnot, V3 } from '../doc/types';
import { cross, lerp, norm, sub } from './vec';

/**
 * The course spine: a centripetal-ish Catmull-Rom through the knot positions, sampled densely
 * once so everything downstream (rows, frames, parameter blending) works in arc length.
 */
export interface SpineSample {
  pos: V3;
  /** Unit tangent, pointing from start toward end. */
  fwd: V3;
  /** Arc length from the start, metres. */
  s: number;
  /** Continuous knot index (e.g. 1.4 = 40% between knot 1 and 2) for parameter blending. */
  k: number;
}

const DENSITY = 32; // samples per knot segment for the arc-length table

function cr(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const t2 = t * t, t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number) =>
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), f(p0[2], p1[2], p2[2], p3[2])];
}

export function sampleSpine(knots: { pos: V3 }[]): SpineSample[] {
  if (knots.length < 2) throw new Error('A spine needs at least 2 knots.');
  const P = knots.map(k => k.pos);
  const at = (i: number) => P[Math.max(0, Math.min(P.length - 1, i))];

  const out: SpineSample[] = [];
  let s = 0;
  let prev: V3 | null = null;
  for (let seg = 0; seg < P.length - 1; seg++) {
    const last = seg === P.length - 2;
    const n = last ? DENSITY + 1 : DENSITY; // include the final endpoint once
    for (let i = 0; i < n; i++) {
      const t = i / DENSITY;
      const pos = cr(at(seg - 1), at(seg), at(seg + 1), at(seg + 2), t);
      if (prev) s += Math.hypot(pos[0] - prev[0], pos[1] - prev[1], pos[2] - prev[2]);
      out.push({ pos, fwd: [0, 0, 1], s, k: seg + t });
      prev = pos;
    }
  }
  // Tangents from neighbours over the sampled polyline (stable, no dependence on CR parameterization).
  for (let i = 0; i < out.length; i++) {
    const a = out[Math.max(0, i - 1)].pos;
    const b = out[Math.min(out.length - 1, i + 1)].pos;
    out[i].fwd = norm(sub(b, a));
  }
  return out;
}

/** Interpolate position + frame + knot parameter at arc length s (clamped). */
export function spineAt(samples: SpineSample[], s: number): SpineSample {
  const total = samples[samples.length - 1].s;
  const t = Math.max(0, Math.min(total, s));
  // binary search the bracketing pair
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= t) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const span = Math.max(1e-9, b.s - a.s);
  const f = (t - a.s) / span;
  return { pos: lerp(a.pos, b.pos, f), fwd: norm(lerp(a.fwd, b.fwd, f)), s: t, k: a.k + (b.k - a.k) * f };
}

/** Knot parameters blended smoothly at continuous knot index k. */
export function paramsAt(knots: CourseKnot[], k: number): Pick<CourseKnot, 'width' | 'wall' | 'bank' | 'shoulder'> {
  const i = Math.max(0, Math.min(knots.length - 2, Math.floor(k)));
  const t = Math.max(0, Math.min(1, k - i));
  const sm = t * t * (3 - 2 * t); // smoothstep so params ease between knots
  const a = knots[i], b = knots[i + 1];
  const mix = (x: number, y: number) => x + (y - x) * sm;
  return {
    width: mix(a.width, b.width),
    wall: mix(a.wall, b.wall),
    bank: mix(a.bank, b.bank),
    shoulder: mix(a.shoulder, b.shoulder),
  };
}

/**
 * The lateral frame at a spine sample: `side` points across the course (column direction),
 * `up` completes the right-handed frame. side = fwd × worldUp keeps the quilt's u×v cross
 * pointing DOWN in editor space, which is what gives skyward normals after the bake's
 * X-mirror + winding convention (see export/level.ts).
 */
export function frameAt(fwd: V3): { side: V3; up: V3 } {
  const side = norm(cross(fwd, [0, 1, 0]));
  const up = norm(cross(side, fwd));
  return { side, up };
}

export const totalLength = (samples: SpineSample[]) => samples[samples.length - 1].s;
