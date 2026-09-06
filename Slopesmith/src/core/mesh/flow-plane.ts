/**
 * Plan-frame arithmetic the flow builder measures with: signed angles either side of a bearing, the crossing
 * of two segments, and the polyline readings its rows and rim arcs are sized and resampled by. Nothing here
 * knows about corridors, rows or cells — every function is a pure reading of points in the plan's x/z frame.
 */
import type { SheetPoint } from './sheet';

// ---- plane helpers -----------------------------------------------------------------------------------------

export const TAU = Math.PI * 2;
/** Positive when `b` sits counterclockwise of `a` in the plan's x/z frame. */
export const cross2 = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;
/** Signed difference a−b folded to (−π, π]. */
export const angleGap = (a: number, b: number): number => {
  let d = (a - b) % TAU;
  if (d <= -Math.PI) d += TAU;
  if (d > Math.PI) d -= TAU;
  return d;
};

// ---- polyline readings -------------------------------------------------------------------------------------

/** The two ends of a realized row, told apart by which side of the group's bearing they sit on. */
export const rowEnds = (points: SheetPoint[], bearing: number, node: SheetPoint): { cw: SheetPoint; ccw: SheetPoint } => {
  const first = points[0], last = points[points.length - 1];
  const side = (p: SheetPoint) => angleGap(Math.atan2(p.z - node.z, p.x - node.x), bearing);
  return side(first) < side(last) ? { cw: first, ccw: last } : { cw: last, ccw: first };
};

export const distToPolyline = (p: SheetPoint, pts: SheetPoint[]): number => {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)));
  }
  return best;
};

export const lengthOf = (pts: SheetPoint[]): number => {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return sum;
};

/** Resample an open polyline to `edges` equal-length steps, keeping both endpoints. */
export const resample = (pts: SheetPoint[], edges: number): SheetPoint[] => {
  const cumulative = [0];
  for (let i = 1; i < pts.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  const total = cumulative[cumulative.length - 1];
  const out: SheetPoint[] = [pts[0]];
  for (let e = 1; e < edges; e++) {
    const s = (total * e) / edges;
    let low = 0, high = cumulative.length - 1;
    while (high - low > 1) { const middle = (low + high) >> 1; if (cumulative[middle] <= s) low = middle; else high = middle; }
    const span = cumulative[high] - cumulative[low];
    const t = span > 1e-9 ? (s - cumulative[low]) / span : 0;
    out.push({ x: pts[low].x + (pts[high].x - pts[low].x) * t, z: pts[low].z + (pts[high].z - pts[low].z) * t });
  }
  out.push(pts[pts.length - 1]);
  return out;
};

export const segCross = (a: SheetPoint, b: SheetPoint, c: SheetPoint, d: SheetPoint): SheetPoint | null => {
  const r = { x: b.x - a.x, z: b.z - a.z }, s = { x: d.x - c.x, z: d.z - c.z };
  const denominator = cross2(r.x, r.z, s.x, s.z);
  if (Math.abs(denominator) < 1e-12) return null;
  const t = cross2(c.x - a.x, c.z - a.z, s.x, s.z) / denominator;
  const u = cross2(c.x - a.x, c.z - a.z, r.x, r.z) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: a.x + r.x * t, z: a.z + r.z * t };
};
