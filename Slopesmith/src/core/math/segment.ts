import type { V3 } from '../doc/types';
import { dot, sub } from './vec';

export interface PointSegmentClosest {
  t: number;
  point: V3;
  distance2: number;
}

/** Closest point on the closed segment a-b to point p. */
export function closestPointOnSegment(p: V3, a: V3, b: V3): PointSegmentClosest {
  const ab = sub(b, a), ap = sub(p, a), length2 = dot(ab, ab);
  const t = length2 > 1e-18 ? Math.min(1, Math.max(0, dot(ap, ab) / length2)) : 0;
  const point: V3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  const delta = sub(point, p);
  return { t, point, distance2: dot(delta, delta) };
}

export interface SegmentSegmentClosest {
  s: number;
  t: number;
  first: V3;
  second: V3;
  distance2: number;
  firstDirection: V3;
  secondDirection: V3;
}

/** Closest points on two closed 3D segments (Ericson's clamped segment/segment solve). */
export function closestPointsBetweenSegments(p1: V3, q1: V3, p2: V3, q2: V3): SegmentSegmentClosest {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), epsilon = 1e-18;
  let s = 0, t = 0;
  if (a <= epsilon && e <= epsilon) { /* both segments collapse to points */ }
  else if (a <= epsilon) t = Math.min(1, Math.max(0, f / e));
  else {
    const c = dot(d1, r);
    if (e <= epsilon) s = Math.min(1, Math.max(0, -c / a));
    else {
      const b = dot(d1, d2), denominator = a * e - b * b;
      if (Math.abs(denominator) > epsilon) s = Math.min(1, Math.max(0, (b * f - c * e) / denominator));
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const first: V3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const second: V3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const delta = sub(first, second);
  return { s, t, first, second, distance2: dot(delta, delta), firstDirection: d1, secondDirection: d2 };
}
