import type { V3 } from '../doc/types';

/** Path/event distances share the horizontal metric, with Y as editor up. */
export function aiPathMetrics(points: readonly V3[]) {
  let length = 0;
  for (let i = 1; i < points.length; i++)
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]);
  const segments = Math.max(0, points.length - 1);
  return { length, segments, average: segments ? length / segments : 0 };
}

/** Clip an event window to the polyline, retaining bends and interpolating its exact boundary stations. */
export function aiPathEventSpan(points: readonly V3[], start: number, end: number): V3[] {
  if (!points.length || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const total = aiPathMetrics(points).length;
  if (end < 0 || start > total) return [];
  const lo = Math.max(0, start),
    hi = Math.min(total, end);
  const result: V3[] = [];
  const append = (p: V3) => {
    if (!result.length || p.some((value, axis) => value !== result.at(-1)![axis])) result.push(p);
  };
  let arc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const next = arc + length;
    if (length > 0 && next >= lo && arc <= hi) {
      const at = (station: number): V3 => {
        const t = (station - arc) / length;
        return a.map((value, axis) => value + t * (b[axis] - value)) as V3;
      };
      append(at(Math.max(lo, arc)));
      append(at(Math.min(hi, next)));
    }
    arc = next;
    if (arc > hi) break;
  }
  if (!result.length && lo === 0) append([...points[0]]);
  return result;
}
