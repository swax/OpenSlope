import type { V3 } from '../doc/types';
import { add, mul, sub, len } from './vec';
import { splitCubic } from './bezier';
import type { Patch } from '../mesh/loft-surface';

export type SplineNet = { points: V3[][]; knotsU: number[]; knotsV: number[] };
export type SurfaceAxis = 'U' | 'V';
const EPS = 1e-9;
const copy = (p: V3): V3 => [...p];
const transpose = (p: V3[][]): V3[][] => p[0].map((_, u) => p.map(row => row[u]));

export function splineBasis(knots: number[], t: number): number[] {
  const count = knots.length - 4;
  if (t <= knots[3]) return Array.from({ length: count }, (_, i) => Number(i === 0));
  if (t >= knots[count]) return Array.from({ length: count }, (_, i) => Number(i === count - 1));
  let weights = knots.slice(1).map((end, i) => Number(t >= knots[i] && t < end));
  for (let degree = 1; degree <= 3; degree++) {
    weights = weights.slice(0, -1).map((_, i) => {
      const a = knots[i + degree] - knots[i],
        b = knots[i + degree + 1] - knots[i + 1];
      return (a ? ((t - knots[i]) / a) * weights[i] : 0) + (b ? ((knots[i + degree + 1] - t) / b) * weights[i + 1] : 0);
    });
  }
  return weights;
}

export function splinePoint(net: SplineNet, u: number, v: number): V3 {
  const U = splineBasis(net.knotsU, u),
    V = splineBasis(net.knotsV, v);
  let out: V3 = [0, 0, 0];
  net.points.forEach((row, j) =>
    row.forEach((p, i) => {
      out = add(out, mul(p, U[i] * V[j]));
    }),
  );
  return out;
}

/** Each inserted control is either an old control or a blend of two neighbors. */
function insertion(knots: number[], t: number): { knots: number[]; rows: [number, number][][] } {
  const count = knots.length - 4;
  if (!Number.isFinite(t) || t <= knots[3] + EPS || t >= knots[count] - EPS)
    throw new Error('Insert rows inside the surface, between its outer boundaries.');
  let span = 3;
  while (span + 1 < count && knots[span + 1] <= t + EPS) span++;
  const multiplicity = knots.filter(k => Math.abs(k - t) < EPS).length;
  if (multiplicity >= 3) throw new Error('This position already has the maximum number of cubic rows.');
  const rows: [number, number][][] = [];
  for (let i = 0; i <= count; i++) {
    if (i <= span - 3) rows.push([[i, 1]]);
    else if (i >= span - multiplicity + 1) rows.push([[i - 1, 1]]);
    else {
      const t0 = knots[i],
        t1 = knots[i + 3];
      const alpha = (t - t0) / (t1 - t0);
      rows.push([
        [i - 1, 1 - alpha],
        [i, alpha],
      ]);
    }
  }
  return { knots: [...knots.slice(0, span + 1), t, ...knots.slice(span + 1)], rows };
}

export function insertSplineRow(net: SplineNet, axis: SurfaceAxis, t: number): SplineNet {
  const plan = insertion(axis === 'U' ? net.knotsU : net.knotsV, t);
  const lines = axis === 'U' ? net.points : transpose(net.points);
  const next = lines.map(line =>
    plan.rows.map(row => row.reduce<V3>((p, [at, weight]) => add(p, mul(line[at], weight)), [0, 0, 0])),
  );
  return axis === 'U'
    ? { ...net, points: next, knotsU: plan.knots }
    : { ...net, points: transpose(next), knotsV: plan.knots };
}

/** Fit the inverse of knot insertion. Its matrix is bidiagonal, so the normal system is tridiagonal.
 * End controls are fixed, preserving the two opposite boundary curves during simplification. */
export function removeSplineKnot(
  net: SplineNet,
  axis: SurfaceAxis,
  knotIndex: number,
): { net: SplineNet; deviationM: number } {
  const knots = axis === 'U' ? net.knotsU : net.knotsV;
  const count = knots.length - 4;
  if (knotIndex < 4 || knotIndex >= count || count <= 4)
    throw new Error('Keep the outer boundary and at least four control rows in each direction.');
  const value = knots[knotIndex],
    reduced = knots.filter((_, i) => i !== knotIndex);
  const plan = insertion(reduced, value),
    n = count - 1;
  const lines = axis === 'U' ? net.points : transpose(net.points);
  const fit = lines.map(line => {
    const diagonal = Array<number>(n).fill(0),
      side = Array<number>(n - 1).fill(0);
    const rhs: V3[] = Array.from({ length: n }, () => [0, 0, 0]);
    plan.rows.forEach((row, i) => {
      for (const [at, weight] of row) {
        diagonal[at] += weight * weight;
        rhs[at] = add(rhs[at], mul(line[i], weight));
      }
      if (row.length === 2) side[row[0][0]] += row[0][1] * row[1][1];
    });
    rhs[1] = sub(rhs[1], mul(line[0], side[0]));
    rhs[n - 2] = sub(rhs[n - 2], mul(line.at(-1)!, side[n - 2]));
    diagonal[0] = diagonal[n - 1] = 1;
    side[0] = side[n - 2] = 0;
    rhs[0] = copy(line[0]);
    rhs[n - 1] = copy(line.at(-1)!);
    for (let i = 1; i < n; i++) {
      const factor = side[i - 1] / diagonal[i - 1];
      diagonal[i] -= factor * side[i - 1];
      rhs[i] = sub(rhs[i], mul(rhs[i - 1], factor));
    }
    const out: V3[] = new Array(n);
    for (let i = n - 1; i >= 0; i--)
      out[i] = mul(i === n - 1 ? rhs[i] : sub(rhs[i], mul(out[i + 1], side[i])), 1 / diagonal[i]);
    return out;
  });
  const next =
    axis === 'U' ? { ...net, points: fit, knotsU: reduced } : { ...net, points: transpose(fit), knotsV: reduced };
  // The insertion matrix expresses the fitted surface in the old basis. Its largest control displacement
  // bounds positional error everywhere (nonnegative partition-of-unity B-spline basis).
  let deviationM = 0;
  lines.forEach((line, j) =>
    plan.rows.forEach((row, i) => {
      const p = row.reduce<V3>((p, [at, weight]) => add(p, mul(fit[j][at], weight)), [0, 0, 0]);
      deviationM = Math.max(deviationM, len(sub(p, line[i])));
    }),
  );
  return { net: next, deviationM };
}

export const greville = (knots: number[], i: number): number => (knots[i + 1] + knots[i + 2] + knots[i + 3]) / 3;

/** Exact Bezier extraction after raising each internal knot's multiplicity to three. */
export function splineCharts(net: SplineNet): Patch[] {
  let refined = net;
  const breaks = (knots: number[]) => [...new Set(knots.slice(3, -3))];
  const us = breaks(net.knotsU),
    vs = breaks(net.knotsV);
  for (const axis of ['U', 'V'] as const) {
    const knots = axis === 'U' ? net.knotsU : net.knotsV;
    for (const t of breaks(knots).slice(1, -1))
      for (let i = knots.filter(k => k === t).length; i < 3; i++) refined = insertSplineRow(refined, axis, t);
  }
  const out: Patch[] = [];
  for (let v = 0; v < vs.length - 1; v++)
    for (let u = 0; u < us.length - 1; u++) {
      const controls: V3[] = [];
      for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) controls.push(copy(refined.points[v * 3 + b][u * 3 + a]));
      out.push({ domain: [us[u], us[u + 1], vs[v], vs[v + 1]], controls });
    }
  return out;
}

/** Adopt an exact rectangular Bezier quilt as a cubic spline, removing redundant seam knots. */
export function splineFromCharts(charts: Patch[]): SplineNet {
  const us = [...new Set(charts.flatMap(p => p.domain.slice(0, 2)))].sort((a, b) => a - b);
  const vs = [...new Set(charts.flatMap(p => p.domain.slice(2, 4)))].sort((a, b) => a - b);
  const points: V3[][] = Array.from({ length: (vs.length - 1) * 3 + 1 }, () => new Array((us.length - 1) * 3 + 1));
  for (const chart of charts) {
    const u = us.indexOf(chart.domain[0]),
      v = vs.indexOf(chart.domain[2]);
    for (let a = 0; a < 4; a++)
      for (let b = 0; b < 4; b++) points[v * 3 + b][u * 3 + a] = copy(chart.controls[a * 4 + b]);
  }
  if (points.some(row => row.some(p => !p)))
    throw new Error('The source patches must form a complete rectangular surface.');
  const knots = (breaks: number[]) =>
    breaks.flatMap((t, i) => Array(i === 0 || i === breaks.length - 1 ? 4 : 3).fill(t));
  let net: SplineNet = { points, knotsU: knots(us), knotsV: knots(vs) };
  for (const axis of ['U', 'V'] as const) {
    let index = 4;
    while (index < (axis === 'U' ? net.knotsU : net.knotsV).length - 4) {
      const candidate = removeSplineKnot(net, axis, index);
      if (candidate.deviationM < 1e-7) net = candidate.net;
      else index++;
    }
  }
  return net;
}

/** Remove only seams separating restrictions of the same bicubic. Unlike spline knot reduction this
 * does not fit intermediate C1/C2 control nets that Bezier extraction would immediately split again. */
export function compactSurfaceCharts(charts: Patch[]): Patch[] {
  const us = [...new Set(charts.flatMap(p => p.domain.slice(0, 2)))].sort((a, b) => a - b);
  const vs = [...new Set(charts.flatMap(p => p.domain.slice(2)))].sort((a, b) => a - b);
  const grid: Patch[][] = Array.from({ length: vs.length - 1 }, () => []);
  for (const p of charts) grid[vs.indexOf(p.domain[2])][us.indexOf(p.domain[0])] = p;
  if (grid.some(row => Array.from({ length: us.length - 1 }, (_, i) => !row[i]).some(Boolean)))
    throw new Error('The source patches must form a complete rectangular surface.');
  const join = (a: Patch, b: Patch, axis: 0 | 2): Patch | undefined => {
    const t = (a.domain[axis + 1] - a.domain[axis]) / (b.domain[axis + 1] - a.domain[axis]);
    const controls: V3[] = new Array(16);
    for (let i = 0; i < 4; i++) {
      const at = (j: number) => (axis === 0 ? j * 4 + i : i * 4 + j);
      const cp = [
        a.controls[at(0)],
        add(a.controls[at(0)], mul(sub(a.controls[at(1)], a.controls[at(0)]), 1 / t)),
        add(b.controls[at(3)], mul(sub(b.controls[at(2)], b.controls[at(3)]), 1 / (1 - t))),
        b.controls[at(3)],
      ] as [V3, V3, V3, V3];
      const split = splitCubic(...cp, t);
      for (let j = 0; j < 4; j++) {
        if (len(sub(split.left[j], a.controls[at(j)])) >= 1e-7 || len(sub(split.right[j], b.controls[at(j)])) >= 1e-7)
          return;
        controls[at(j)] = cp[j];
      }
    }
    const domain = [...a.domain] as Patch['domain'];
    domain[axis + 1] = b.domain[axis + 1];
    return { domain, controls };
  };
  for (let u = 0; u < grid[0].length - 1;) {
    const merged = grid.map(row => join(row[u], row[u + 1], 0));
    if (merged.every((p): p is Patch => !!p)) grid.forEach((row, v) => row.splice(u, 2, merged[v]));
    else u++;
  }
  for (let v = 0; v < grid.length - 1;) {
    const merged = grid[v].map((p, u) => join(p, grid[v + 1][u], 2));
    if (merged.every((p): p is Patch => !!p)) grid.splice(v, 2, merged);
    else v++;
  }
  return grid.flat();
}
