import type { V3 } from '../doc/types';
import { add, cross, dot, len, lerp, mul, norm, sub } from './vec';

/**
 * Bicubic Bezier patch math. Each corner carries four directional tangent HANDLES (the
 * offset from the corner to its edge control point): u- / u+ along the spine, v- / v+ across. By
 * default they are Bessel (chord-weighted finite differences), so the quilt is watertight (shared
 * boundary points / shared edge curves), G1 across seams, and never overshoots on uneven spacing.
 * A handle can be OVERRIDDEN per (corner, direction) to pull an overhang or - by breaking the u-/u+
 * (or v-/v+) collinearity - author a deliberate crease. Twist vectors are zero (Ferguson patch).
 *
 * Control point order matches snowknife's Bezier.Patch: row-major cp[r*4+c], rows along u (spine),
 * cols along v (across). This is the SAME evaluator the bake uses, so preview == bake.
 */

/** The four directional handles of a lattice vertex, named for the grid the generators sweep. */
export type HandleDir = 'u-' | 'u+' | 'v-' | 'v+';

/** Chord-weighted (Bessel) tangent at b per index step; one-sided where a or c is missing (ends). */
export function besselTangent(a: V3 | null, b: V3, c: V3 | null): V3 {
  if (a && c) {
    const d0 = sub(b, a), d1 = sub(c, b);
    const h0 = Math.max(1e-9, len(d0)), h1 = Math.max(1e-9, len(d1));
    // Bessel: weight each one-sided slope by the OTHER side's span
    return add(mul(d1, h0 / (h0 + h1)), mul(d0, h1 / (h0 + h1)));
  }
  if (c) return sub(c, b);
  if (a) return sub(b, a);
  return [0, 0, 0];
}


function bez(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const s = 1 - t;
  return add(
    add(mul(p0, s * s * s), mul(p1, 3 * s * s * t)),
    add(mul(p2, 3 * s * t * t), mul(p3, t * t * t)),
  );
}
function bezD(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  const s = 1 - t;
  return add(
    add(mul(sub(p1, p0), 3 * s * s), mul(sub(p2, p1), 6 * s * t)),
    mul(sub(p3, p2), 3 * t * t),
  );
}

/** A single cubic Bezier edge (4 control points) evaluated at t = 0..1 — the point on the shared boundary
 *  curve the quilt bakes. `mesh-ops` inserts a loop-cut vertex here (on the true edge curve, not the chord),
 *  so a cut through curved terrain lands ON the surface. Same `bez` the patch evaluator uses. */
export function cubicPoint(p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 {
  return bez(p0, p1, p2, p3, t);
}

/** P(u,v) with rows of cp along u — identical operation order to snowknife Bezier.Patch. */
export function patchPoint(cp: V3[], u: number, v: number): V3 {
  const r0 = bez(cp[0], cp[1], cp[2], cp[3], v);
  const r1 = bez(cp[4], cp[5], cp[6], cp[7], v);
  const r2 = bez(cp[8], cp[9], cp[10], cp[11], v);
  const r3 = bez(cp[12], cp[13], cp[14], cp[15], v);
  return bez(r0, r1, r2, r3, u);
}

const dup = (p: V3): V3 => [p[0], p[1], p[2]];

/**
 * de Casteljau split of a cubic Bezier at t: `left` is the sub-curve over [0,t], `right` over [t,1]. The
 * recursive lerps ARE the curve's own corner-cutting construction, so each half is an exact
 * reparameterization — the same curve, re-cut, not a fit. The shared endpoint is the curve point at t and
 * each half inherits the parent's tangent there, so the seam is watertight and G1 for free.
 */
export function splitCubic(p0: V3, p1: V3, p2: V3, p3: V3, t: number): { left: [V3, V3, V3, V3]; right: [V3, V3, V3, V3] } {
  const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);                     // the curve point at t — the new shared corner
  return { left: [dup(p0), q0, r0, s], right: [dup(s), r1, q2, dup(p3)] };
}

/**
 * Split a patch across u at t: `lower` covers u ∈ [0,t], `upper` covers u ∈ [t,1]. Column c of the net
 * (cp[c], cp[4+c], cp[8+c], cp[12+c]) is the patch's control polygon down u, and `patchPoint` is linear in
 * those columns, so de Casteljau on each of the four columns — reassembled row-major — splits the SURFACE
 * exactly: each sub-patch evaluates to the parent's points over its own sub-range, to the last bit.
 *
 * The load-bearing fact: the sub-patch of a ZERO-TWIST (Ferguson) patch is NOT itself zero-twist. A corner's
 * twist is a mixed second derivative, and re-cutting the patch stirs the boundary curvature into it, so the
 * exact halves carry genuine interior control points even where the parent's interiors were just the corner
 * plus its two handles. A caller that reparameterizes a patch must therefore WRITE the four interior CPs
 * these return (the twist), not only the corners and boundary handles: re-deriving a zero twist from the
 * boundary alone bows the sub-patch off the surface it was cut from.
 */
export function splitPatchU(cp: V3[], t: number): { lower: V3[]; upper: V3[] } {
  const lower: V3[] = new Array(16), upper: V3[] = new Array(16);
  for (let c = 0; c < 4; c++) {
    const { left, right } = splitCubic(cp[c], cp[4 + c], cp[8 + c], cp[12 + c], t);
    for (let r = 0; r < 4; r++) { lower[r * 4 + c] = left[r]; upper[r * 4 + c] = right[r]; }
  }
  return { lower, upper };
}

/**
 * Split a patch across v at t: `lower` covers v ∈ [0,t], `upper` covers v ∈ [t,1]. The v twin of
 * `splitPatchU` — row r of the net (cp[4r]..cp[4r+3]) is the control polygon across v, so the four rows are
 * the four cubics to cut. The same exactness holds, and so does the same warning: the halves of a zero-twist
 * (Ferguson) patch have a real twist, so a caller must carry the interior CPs across, not just the boundary.
 */
export function splitPatchV(cp: V3[], t: number): { lower: V3[]; upper: V3[] } {
  const lower: V3[] = new Array(16), upper: V3[] = new Array(16);
  for (let r = 0; r < 4; r++) {
    const { left, right } = splitCubic(cp[4 * r], cp[4 * r + 1], cp[4 * r + 2], cp[4 * r + 3], t);
    for (let c = 0; c < 4; c++) { lower[r * 4 + c] = left[c]; upper[r * 4 + c] = right[c]; }
  }
  return { lower, upper };
}

/** A cubic Bezier edge (4 control points) sampled into `seg`+1 distinct points along t = 0..1. */
export function cubicPolyline(p0: V3, p1: V3, p2: V3, p3: V3, seg: number): V3[] {
  const out: V3[] = [];
  for (let i = 0; i <= seg; i++) out.push(bez(p0, p1, p2, p3, i / seg));
  return out;
}

/**
 * The parameter t ∈ [0,1] of the point ON the cubic (p0..p3) nearest to `p` — the foot of the perpendicular
 * from `p`. This is how a SLIDE reads its cursor: a slide is a re-cut at a parameter, not a translation by a
 * delta, so the drag's meaning is "where along this frozen curve is the cursor now", and a delta projected on a
 * straight axis would drift off a curved edge.
 *
 * Squared distance is stationary where g(t) = (C(t) − p) · C′(t) = 0: g < 0 while the curve still closes on `p`,
 * g > 0 once it recedes, so a sign change of g brackets the foot. `seg` coarse samples pick the right basin (a
 * cubic's distance can have several) and bisection on g refines it inside the one-sample-wide bracket around the
 * sampled minimum — to ~1e-11 in t, far under the SLIDE_EPS the caller clamps with.
 *
 * A `p` that lies PAST an end has no interior foot: g never changes sign there and the end is returned exactly.
 * That is the bound a slide needs — t = 1 means "the cursor is at or beyond the neighbour", the merge condition.
 */
export function nearestCubicT(p0: V3, p1: V3, p2: V3, p3: V3, p: V3, seg = 32): number {
  const pl = cubicPolyline(p0, p1, p2, p3, seg);
  let best = 0, bestD = Infinity;
  for (let i = 0; i <= seg; i++) {
    const d = sub(pl[i], p), q = dot(d, d);
    if (q < bestD) { bestD = q; best = i; }
  }
  const g = (t: number) => dot(sub(bez(p0, p1, p2, p3, t), p), bezD(p0, p1, p2, p3, t));
  // `best` is the sampled minimum, so its two neighbouring samples are no closer and the foot lies between them.
  // The early returns therefore only fire at the curve's own ends (a = 0 / b = 1), where the foot is the endpoint.
  let a = Math.max(0, (best - 1) / seg), b = Math.min(1, (best + 1) / seg);
  if (g(a) >= 0) return a;
  if (g(b) <= 0) return b;
  for (let i = 0; i < 32; i++) { const m = (a + b) / 2; if (g(m) <= 0) a = m; else b = m; }
  return (a + b) / 2;
}

/** Sample a cubic Bezier edge (4 control points) into `seg` straight sub-segments, appending each
 *  segment's two endpoints to `out` as a flat [ax,ay,az, bx,by,bz, ...] list for a THREE.LineSegments. */
export function pushCubicEdge(out: number[], p0: V3, p1: V3, p2: V3, p3: V3, seg: number): void {
  const pl = cubicPolyline(p0, p1, p2, p3, seg);
  for (let i = 0; i < pl.length - 1; i++) out.push(pl[i][0], pl[i][1], pl[i][2], pl[i + 1][0], pl[i + 1][1], pl[i + 1][2]);
}

/** The (un-normalised) skyward normal at (u,v): the quilt's uÃ—v cross points down, so cross(dv, du). */
function patchCross(cp: V3[], u: number, v: number): V3 {
  const r0 = bez(cp[0], cp[1], cp[2], cp[3], v);
  const r1 = bez(cp[4], cp[5], cp[6], cp[7], v);
  const r2 = bez(cp[8], cp[9], cp[10], cp[11], v);
  const r3 = bez(cp[12], cp[13], cp[14], cp[15], v);
  const du = bezD(r0, r1, r2, r3, u);
  const d0 = bezD(cp[0], cp[1], cp[2], cp[3], v);
  const d1 = bezD(cp[4], cp[5], cp[6], cp[7], v);
  const d2 = bezD(cp[8], cp[9], cp[10], cp[11], v);
  const d3 = bezD(cp[12], cp[13], cp[14], cp[15], v);
  const dv = bez(d0, d1, d2, d3, u);
  return cross(dv, du);
}

/** Skyward analytic normal at (u,v). A collapsed patch row/col â€” a WEDGE apex folds the u=1 edge to a point,
 *  so âˆ‚v vanishes there (docs/017 S3) â€” leaves a zero frame; when that happens, nudge the sample off the
 *  collapsed boundary and retry, so the apex still gets a finite normal (else NaN poisons the shading). A
 *  proper patch never triggers the nudge, so its normals are byte-identical to before. */
export function patchNormal(cp: V3[], u: number, v: number): V3 {
  let c = patchCross(cp, u, v);
  if (len(c) < 1e-9) { const e = 1e-3; c = patchCross(cp, Math.min(Math.max(u, e), 1 - e), Math.min(Math.max(v, e), 1 - e)); }
  return len(c) < 1e-9 ? [0, 1, 0] : norm(c);
}
