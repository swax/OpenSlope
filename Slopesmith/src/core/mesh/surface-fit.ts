import type { LoftDomain, V3 } from '../doc/types';
import { patchNormal, patchPoint } from '../math/bezier';
import { add, dot, len, mul, sub } from '../math/vec';
import { measureSurfaceAxis, restrict, type Patch } from './loft-surface';
import { compactSurfaceCharts } from '../math/spline-surface';
import { cellDimensions } from './measure';

const EPS = 1e-9;
const MAX_PATCHES = 16384;
const cuts = (values: number[]) => values.sort((a, b) => a - b).filter((t, i, a) => !i || t - a[i - 1] > EPS);

/** Terrain fitting budget scales with the intended patch size: 30 cm at 15 m. */
export const surfaceFitTolerance = (patchSizeM: number, override?: number) => override ?? patchSizeM * 0.02;

function interval(values: number[], t: number): number {
  let lo = 0,
    hi = values.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] <= t) lo = mid;
    else hi = mid;
  }
  return Math.min(values.length - 2, lo);
}

/** Rectangular source quilt, indexed once rather than scanned for every sample and error check. */
function sourceQuilt(charts: Patch[]) {
  const us = cuts(charts.flatMap(p => p.domain.slice(0, 2))),
    vs = cuts(charts.flatMap(p => p.domain.slice(2))),
    rows: Patch[][] = Array.from({ length: vs.length - 1 }, () => []);
  for (const p of charts) rows[interval(vs, p.domain[2] + EPS)][interval(us, p.domain[0] + EPS)] = p;
  const chart = (u: number, v: number) => rows[interval(vs, v)]?.[interval(us, u)];
  const overlaps = (d: LoftDomain) => {
    const out: Patch[] = [];
    for (let j = interval(vs, d[2] + EPS); j <= interval(vs, d[3] - EPS); j++)
      for (let i = interval(us, d[0] + EPS); i <= interval(us, d[1] - EPS); i++) {
        if (!rows[j]?.[i]) throw new Error('The source surface has an invalid chart partition.');
        out.push(rows[j][i]);
      }
    return out;
  };
  return { us, vs, chart, overlaps };
}

// Four-point Gauss quadrature integrates cubic source × cubic basis exactly on each source span.
const GAUSS = [
  [-0.8611363115940526, 0.3478548451374538],
  [-0.3399810435848563, 0.6521451548625461],
  [0.3399810435848563, 0.6521451548625461],
  [0.8611363115940526, 0.3478548451374538],
];

/** Endpoint-interpolating least squares projection. Fit positions over the whole span, rather than
 * forcing endpoint derivatives: a harmless change in source parameter speed must not force tiny rows. */
function projection(from: number, to: number, breaks: number[]) {
  const stations = [from, ...breaks.filter(t => t > from + EPS && t < to - EPS), to],
    samples = stations.slice(1).flatMap((hi, i) =>
      GAUSS.map(([x, weight]) => {
        const lo = stations[i],
          t = (lo + hi + (hi - lo) * x) / 2,
          s = (t - from) / (to - from);
        return {
          t,
          weight: ((hi - lo) * weight) / (2 * (to - from)),
          basis: [(1 - s) ** 3, 3 * (1 - s) ** 2 * s, 3 * (1 - s) * s * s, s ** 3],
        };
      }),
    );
  let aa = 0,
    ab = 0,
    bb = 0;
  for (const { weight: w, basis: b } of samples) {
    aa += w * b[1] * b[1];
    ab += w * b[1] * b[2];
    bb += w * b[2] * b[2];
  }
  const inverse = 1 / (aa * bb - ab * ab),
    weights = samples.map(({ t, weight: w, basis: b }) => ({
      t,
      x: w * (bb * b[1] - ab * b[2]) * inverse,
      y: w * (aa * b[2] - ab * b[1]) * inverse,
      end: b[3],
    })),
    endX = weights.reduce((sum, p) => sum + p.x * p.end, 0),
    endY = weights.reduce((sum, p) => sum + p.y * p.end, 0);
  return (point: (t: number) => V3): V3[] => {
    const a = point(from),
      b = point(to),
      end = sub(b, a);
    const x: V3 = [0, 0, 0],
      y: V3 = [0, 0, 0];
    for (const weight of weights) {
      const residual = sub(point(weight.t), a);
      for (let k = 0; k < 3; k++) {
        x[k] += residual[k] * weight.x;
        y[k] += residual[k] * weight.y;
      }
    }
    return [a, add(a, sub(x, mul(end, endX))), add(a, sub(y, mul(end, endY))), b];
  };
}

/** Tensor projection fits all sixteen controls, including the four interiors. The same one-dimensional
 * projection on each shared edge gives neighbours identical boundaries, regardless of source seams. */
function leastSquares(
  quilt: ReturnType<typeof sourceQuilt>,
  u: ReturnType<typeof projection>,
  v: ReturnType<typeof projection>,
): V3[] {
  const rows = new Map<number, V3[]>();
  const row = (t: number) => {
    let controls = rows.get(t);
    if (!controls) {
      controls = u(s => {
        const chart = quilt.chart(s, t);
        if (!chart) throw new Error('The source surface has an invalid chart partition.');
        return patchPoint(
          chart.controls,
          (s - chart.domain[0]) / (chart.domain[1] - chart.domain[0]),
          (t - chart.domain[2]) / (chart.domain[3] - chart.domain[2]),
        );
      });
      rows.set(t, controls);
    }
    return controls;
  };
  return [0, 1, 2, 3].flatMap(i => v(t => row(t)[i]));
}

/** Bernstein convex-hull bound, over every intersected source span. It bounds the whole surface,
 * including narrow details between samples, rather than just checking a few sample points. */
function errorBound(patch: Patch, sources: Patch[]): number {
  let error = 0;
  for (const source of sources) {
    const d: LoftDomain = [
      Math.max(source.domain[0], patch.domain[0]),
      Math.min(source.domain[1], patch.domain[1]),
      Math.max(source.domain[2], patch.domain[2]),
      Math.min(source.domain[3], patch.domain[3]),
    ];
    const a = restrict(source.controls, source.domain, d),
      b = restrict(patch.controls, patch.domain, d);
    for (let i = 0; i < 16; i++) error = Math.max(error, len(sub(a[i], b[i])));
  }
  return error;
}

/** Preserve deliberate creases. Smooth source stations remain independent of output patch boundaries. */
function creaseCuts(quilt: ReturnType<typeof sourceQuilt>, axis: 0 | 2): number[] {
  const along = axis === 0 ? quilt.us : quilt.vs,
    across = axis === 0 ? quilt.vs : quilt.us;
  return along.slice(1, -1).filter(t =>
    across.slice(1).some((hi, k) =>
      [0.2, 0.5, 0.8].some(s => {
        const other = across[k] + (hi - across[k]) * s,
          u = axis === 0 ? t : other,
          v = axis === 0 ? other : t,
          a = quilt.chart(u - (axis === 0 ? EPS : 0), v - (axis === 2 ? EPS : 0)),
          b = quilt.chart(u + (axis === 0 ? EPS : 0), v + (axis === 2 ? EPS : 0));
        if (!a || !b) return false;
        const normal = (p: Patch) =>
          patchNormal(
            p.controls,
            (u - p.domain[0]) / (p.domain[1] - p.domain[0]),
            (v - p.domain[2]) / (p.domain[3] - p.domain[2]),
          );
        return dot(normal(a), normal(b)) < Math.cos(Math.PI / 12);
      }),
    ),
  );
}

/** Fit independently of source topology. When a row needs more resolution, redistribute the entire
 * physical interval, rather than inserting a source seam beside an existing cut and leaving a sliver. */
export function fitSurface(
  charts: Patch[],
  patchSizeM: number,
  layout?: { us: number[]; vs: number[] },
  fitToleranceM?: number,
) {
  if (!layout) charts = compactSurfaceCharts(charts);
  const quilt = sourceQuilt(charts),
    tolerance = surfaceFitTolerance(patchSizeM, fitToleranceM),
    cache = new Map<string, { patch: Patch; error: number }>(),
    projections = [new Map<string, ReturnType<typeof projection>>(), new Map<string, ReturnType<typeof projection>>()];
  const project = (axis: 0 | 2, domain: LoftDomain) => {
    const cache = projections[axis / 2],
      key = `${domain[axis]},${domain[axis + 1]}`;
    let plan = cache.get(key);
    if (!plan) {
      plan = projection(domain[axis], domain[axis + 1], axis === 0 ? quilt.us : quilt.vs);
      cache.set(key, plan);
    }
    return plan;
  };
  const fit = (domain: LoftDomain) => {
    const key = domain.join(','),
      cached = cache.get(key);
    if (cached) return cached;
    const sources = quilt.overlaps(domain),
      single = sources.length === 1,
      patch = {
        domain,
        controls: single
          ? restrict(sources[0].controls, sources[0].domain, domain)
          : leastSquares(quilt, project(0, domain), project(2, domain)),
      },
      result = { patch, error: layout || single ? 0 : errorBound(patch, sources) };
    cache.set(key, result);
    return result;
  };
  const grid = (us: number[], vs: number[]) => {
    if ((us.length - 1) * (vs.length - 1) > MAX_PATCHES)
      throw new Error('This surface exceeds 16,384 patches. Increase its target patch size.');
    const patches: Patch[] = [];
    let worst: ReturnType<typeof fit> | undefined;
    for (let v = 0; v < vs.length - 1; v++)
      for (let u = 0; u < us.length - 1; u++) {
        const result = fit([us[u], us[u + 1], vs[v], vs[v + 1]]);
        patches.push(result.patch);
        if (result.error > tolerance && (!worst || result.error > worst.error)) worst = result;
      }
    return { patches, us, vs, worst };
  };
  if (layout) {
    const metrics = [measureSurfaceAxis(charts, 0, true, 'average'), measureSurfaceAxis(charts, 2, true, 'average')];
    const redistribute = (axis: 0 | 2, values: number[]) => {
      const metric = metrics[axis / 2],
        knots = axis === 0 ? quilt.us : quilt.vs,
        anchors = values.flatMap((t, i) =>
          i === 0 || i === values.length - 1 || knots.some(knot => Math.abs(knot - t) < EPS) ? [i] : [],
        );
      const lengths = anchors
          .slice(1)
          .map((hi, i) => metric.distanceAt(values[hi]) - metric.distanceAt(values[anchors[i]])),
        total = values.length - 1,
        ideals = lengths.map(length =>
          metric.length > EPS ? (total * length) / metric.length : total / lengths.length,
        ),
        counts = ideals.map(ideal => Math.max(1, Math.floor(ideal)));
      let used = counts.reduce((sum, n) => sum + n, 0);
      while (used !== total) {
        const adding = used < total,
          candidates = counts.flatMap((n, i) => (adding || n > 1 ? [i] : []));
        candidates.sort((i, j) =>
          adding ? ideals[j] - counts[j] - (ideals[i] - counts[i]) : ideals[i] - counts[i] - (ideals[j] - counts[j]),
        );
        counts[candidates[0]] += adding ? 1 : -1;
        used += adding ? 1 : -1;
      }
      return anchors.slice(1).flatMap((hi, i) => {
        const lo = anchors[i];
        return metric.cuts(counts[i], values[lo], values[hi]).slice(i ? 1 : 0);
      });
    };
    const anchored = grid(redistribute(0, layout.us), redistribute(2, layout.vs));
    const aspect = (patches: Patch[]) =>
      patches.reduce((worst, patch) => {
        const { length, width } = cellDimensions(patch.controls);
        return Math.max(worst, Math.max(length, width) / Math.max(EPS, Math.min(length, width)));
      }, 1);
    const anchoredAspect = aspect(anchored.patches);
    if (anchoredAspect > 3) {
      // Old saved layouts can have uneven numbers of cuts around a source station. Keep the drag's
      // connectivity, but prefer uniform spacing when retaining those stations would create thin strips.
      const uniform = grid(metrics[0].cuts(layout.us.length - 1), metrics[1].cuts(layout.vs.length - 1));
      if (aspect(uniform.patches) < anchoredAspect) return uniform;
    }
    return anchored;
  }
  const axisLayout = (axis: 0 | 2) => {
    const metric = measureSurfaceAxis(charts, axis, false, 'average'),
      anchors = [metric.boundaries[0], ...creaseCuts(quilt, axis), metric.boundaries.at(-1)!],
      lengths = anchors.slice(1).map((t, i) => metric.distanceAt(t) - metric.distanceAt(anchors[i]));
    return { metric, anchors, lengths, counts: lengths.map(d => Math.max(1, Math.round(d / patchSizeM))) };
  };
  type AxisLayout = ReturnType<typeof axisLayout>;
  const count = (axis: AxisLayout) => axis.counts.reduce((total, n) => total + n, 0);
  const values = (axis: AxisLayout) => {
    if (count(axis) > MAX_PATCHES)
      throw new Error('This surface needs too many spans. Increase its target patch size.');
    return axis.counts.flatMap((n, i) => axis.metric.cuts(n, axis.anchors[i], axis.anchors[i + 1]).slice(i ? 1 : 0));
  };
  // Keep refinement from producing long strips in the other direction. This is a physical spacing
  // budget; naturally tapering boundaries can still need a less regular rectangular parameterization.
  const balance = (a: AxisLayout, b: AxisLayout): [AxisLayout, AxisLayout] => {
    const refine = (a: AxisLayout, b: AxisLayout): AxisLayout => {
      const sizes = b.lengths.map((d, i) => d / b.counts[i]).filter(d => d > EPS),
        limit = Math.min(...sizes) * 2;
      return { ...a, counts: a.counts.map((n, i) => Math.max(n, Math.ceil(a.lengths[i] / limit))) };
    };
    a = refine(a, b);
    b = refine(b, a);
    return [a, b];
  };
  let [a, b] = balance(axisLayout(0), axisLayout(2));
  for (;;) {
    const current = grid(values(a), values(b)),
      worst = current.worst;
    if (!worst) {
      // Average spacing alone can hide a tapered edge. Check the actual curved patch dimensions too.
      let skinny: { domain: LoftDomain; axis: 0 | 2; ratio: number } | undefined;
      for (const patch of current.patches) {
        const { length, width } = cellDimensions(patch.controls),
          ratio = Math.max(length, width) / Math.max(EPS, Math.min(length, width)),
          axis = length > width ? 0 : 2,
          row = axis === 0 ? a : b,
          at = interval(row.anchors, (patch.domain[axis] + patch.domain[axis + 1]) / 2);
        // Narrow features and boundary tapers cannot always be made square with a global quad grid.
        // Do not turn an isolated short span into a request to shrink the whole surface indefinitely.
        if (ratio > 2.5 && row.lengths[at] / row.counts[at] > patchSizeM * 0.5 && (!skinny || ratio > skinny.ratio))
          skinny = { domain: patch.domain, axis, ratio };
      }
      if (!skinny) return current;
      const row = skinny.axis === 0 ? a : b,
        at = interval(row.anchors, (skinny.domain[skinny.axis] + skinny.domain[skinny.axis + 1]) / 2),
        next = { ...row, counts: row.counts.map((n, i) => n + Number(i === at)) };
      [a, b] = balance(skinny.axis === 0 ? next : a, skinny.axis === 2 ? next : b);
      continue;
    }
    const domain = worst.patch.domain;
    const candidates = ([0, 2] as const).flatMap(axis => {
      const row = axis === 0 ? a : b,
        at = interval(row.anchors, (domain[axis] + domain[axis + 1]) / 2),
        n = row.counts[at];
      const refinements = [...new Set([n + 1, Math.ceil(n * 1.5), n * 2])].map(spans => ({
        ...row,
        counts: row.counts.map((v, i) => (i === at ? spans : v)),
      }));
      // Try redistributing the same number of cuts around a real polynomial change before adding rows.
      // Redundant authoring seams were compacted above, so inserting an unchanged guide cannot pin a cut.
      const knots = axis === 0 ? quilt.us : quilt.vs;
      for (const t of knots.filter(t => t > domain[axis] + EPS && t < domain[axis + 1] - EPS)) {
        const left = row.metric.distanceAt(t) - row.metric.distanceAt(row.anchors[at]),
          right = row.lengths[at] - left,
          spans = Math.max(2, n),
          first = Math.max(1, Math.min(spans - 1, Math.round((spans * left) / (left + right))));
        refinements.push({
          ...row,
          anchors: [...row.anchors.slice(0, at + 1), t, ...row.anchors.slice(at + 1)],
          lengths: [...row.lengths.slice(0, at), left, right, ...row.lengths.slice(at + 1)],
          counts: [...row.counts.slice(0, at), first, spans - first, ...row.counts.slice(at + 1)],
        });
      }
      return refinements.flatMap(next => {
        const [nextA, nextB] = balance(axis === 0 ? next : a, axis === 2 ? next : b);
        if (count(nextA) * count(nextB) > MAX_PATCHES) return [];
        const us = values(nextA),
          vs = values(nextB),
          cost = (us.length - 1) * (vs.length - 1) - current.patches.length;
        // Evaluate only the part the worst cell covered. A shifted grid must not be penalized for a
        // different unresolved feature elsewhere, nor rewarded for missing a narrow detail between samples.
        let error = 0;
        for (let j = interval(vs, domain[2] + EPS); j <= interval(vs, domain[3] - EPS); j++)
          for (let i = interval(us, domain[0] + EPS); i <= interval(us, domain[1] - EPS); i++) {
            const patch = fit([us[i], us[i + 1], vs[j], vs[j + 1]]).patch,
              d: LoftDomain = [
                Math.max(domain[0], us[i]),
                Math.min(domain[1], us[i + 1]),
                Math.max(domain[2], vs[j]),
                Math.min(domain[3], vs[j + 1]),
              ];
            error = Math.max(
              error,
              errorBound({ domain: d, controls: restrict(patch.controls, patch.domain, d) }, quilt.overlaps(d)),
            );
          }
        return [{ a: nextA, b: nextB, score: (worst.error - error) / Math.max(1, cost), error }];
      });
    });
    candidates.sort((a, b) => b.score - a.score || a.error - b.error);
    const next = candidates[0];
    if (!next) throw new Error('This surface exceeds 16,384 patches. Increase its target patch size.');
    a = next.a;
    b = next.b;
  }
}
