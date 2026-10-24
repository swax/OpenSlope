import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { appendMeshIds, nameIndex } from '../doc/ids';
import { cubicPoint, patchPoint, splitCubic } from '../math/bezier';
import { add, sub, mul, len } from '../math/vec';
import { meshFromDoc, meshAdjacency, type EdgeHandle } from './topology';
import { readVertex, undirectedEdgeKey } from './primitives';
import { finishMeshRewrite } from './ops/contract';
import type { Patch } from './loft-surface';
import { compactSurfaceCharts, type SurfaceAxis } from '../math/spline-surface';

type Guide = NonNullable<SurfaceObject['guides']>[number];
export type GuideCurve = { axis: SurfaceAxis; at: number; knots: number[]; points: V3[][]; reference?: V3[][] };
const EPS = 1e-8;
// Surface picking interpolates float32 UVs. Reuse existing stations within that precision instead of
// creating microscopic source spans whose derivatives explode when either endpoint is later moved.
export const GUIDE_STATION_EPS = 1e-6;
export const guideCuts = (values: number[]) =>
  values.sort((a, b) => a - b).filter((n, i, all) => !i || n - all[i - 1] > EPS);

export function readGuideCurves(doc: QuadMeshDoc, surface: SurfaceObject): GuideCurve[] {
  const ids = nameIndex(doc.vertexIds);
  const edges = new Set(doc.freeEdges?.map(([a, b]) => undirectedEdgeKey(a, b)));
  // Owned guides carry explicit cubic handles on free edges. Reading them must not rebuild adjacency
  // for the entire mountain. Retain the ordinary mesh fallback for missing handles or attached curves.
  let fallback: ReturnType<typeof meshFromDoc> | undefined;
  let neighbors: number[][] | undefined;
  const edgeHandle: EdgeHandle = (a, b) => {
    if (doc.edgeHandles?.[`${a}>${b}`] && !doc.linearCage) return doc.edgeHandles[`${a}>${b}`];
    return (fallback ??= meshFromDoc(doc)).edgeHandle(a, b);
  };
  const hasEdge = (a: number, b: number) => {
    if (edges.has(undirectedEdgeKey(a, b))) return true;
    neighbors ??= meshAdjacency((fallback ??= meshFromDoc(doc)).mesh).neighbors;
    return neighbors[a]?.includes(b);
  };
  return surface.guides!.map((guide, g) => ({
    ...guide,
    points: surface.controls[g].slice(1).map((id, i) => {
      const a = ids.get(surface.controls[g][i]),
        b = ids.get(id);
      if (a === undefined || b === undefined || !hasEdge(a, b))
        throw new Error('A control curve lost an edge. Undo the edit or bake the surface.');
      const A = readVertex(doc.vertices, a),
        B = readVertex(doc.vertices, b);
      const cp = [A, add(A, edgeHandle(a, b)), add(B, edgeHandle(b, a)), B];
      if (cp.some(p => p.some(n => !Number.isFinite(n)))) throw new Error('A control curve has an invalid position.');
      return cp;
    }),
  }));
}

export function curveAt(curve: Pick<GuideCurve, 'knots' | 'points'>, t: number): V3 {
  const hi = curve.knots.findIndex((hi, i) => i > 0 && hi >= t - EPS);
  const end = hi < 0 ? curve.points.length - 1 : Math.max(0, hi - 1);
  return cubicPoint(
    ...(curve.points[end] as [V3, V3, V3, V3]),
    (t - curve.knots[end]) / (curve.knots[end + 1] - curve.knots[end]),
  );
}

export function chartPoint(charts: Patch[], u: number, v: number): V3 {
  const p = charts.find(
    p => u >= p.domain[0] - EPS && u <= p.domain[1] + EPS && v >= p.domain[2] - EPS && v <= p.domain[3] + EPS,
  );
  if (!p) throw new Error('The surface has a gap in its parameter domain.');
  return patchPoint(
    p.controls,
    (u - p.domain[0]) / (p.domain[1] - p.domain[0]),
    (v - p.domain[2]) / (p.domain[3] - p.domain[2]),
  );
}

/** Interpolation used by existing files. It depends only on the current curve stations. */
function weights(stations: number[], t: number, curvature: number): number[] {
  const n = stations.length,
    out = stations.map(() => 0);
  if (!n) return out;
  if (n === 1) {
    const at = stations[0];
    const x = at < EPS ? 1 - t : at > 1 - EPS ? t : t <= at ? t / at : (1 - t) / (1 - at);
    return [x * x * (3 - 2 * x)];
  }
  const slope = (i: number): number[] => {
    const a = Math.max(0, i - 1),
      b = Math.min(n - 1, i + 1),
      h = stations[b] - stations[a];
    return stations.map((_, j) => (Number(j === b) - Number(j === a)) / h);
  };
  if (t < stations[0] || t > stations[n - 1]) {
    const end = t < stations[0] ? 0 : n - 1,
      d = slope(end);
    return out.map((_, j) => Number(j === end) + (t - stations[end]) * d[j]);
  }
  const i = Math.min(n - 2, Math.max(0, stations.findIndex((s, j) => j > 0 && s >= t - EPS) - 1));
  const h = stations[i + 1] - stations[i],
    x = (t - stations[i]) / h;
  const a = slope(i),
    b = slope(i + 1);
  return out.map((_, j) => {
    const chord = (Number(j === i + 1) - Number(j === i)) / h;
    return (
      (2 * x * x * x - 3 * x * x + 1) * Number(j === i) +
      (-2 * x * x * x + 3 * x * x) * Number(j === i + 1) +
      (x * x * x - 2 * x * x + x) * h * (chord + curvature * (a[j] - chord)) +
      (x * x * x - x * x) * h * (chord + curvature * (b[j] - chord))
    );
  });
}

/** Natural cubic interpolation. Inserting an existing section adds a visible constraint without
 * changing the interpolated shape. All basis coefficients depend only on the current guide stations. */
function interpolator(stations: number[], curvature: number) {
  const n = stations.length;
  if (n < 2)
    return (t: number) => {
      if (!n) return [];
      const at = stations[0],
        x = at < EPS ? 1 - t : at > 1 - EPS ? t : t <= at ? t / at : (1 - t) / (1 - at);
      return [x * x * (3 - 2 * x)];
    };
  const second = Array.from({ length: n }, () => stations.map(() => 0));
  const diagonal = stations.map(() => 1),
    upper = stations.map(() => 0);
  for (let i = 1; i < n - 1; i++) {
    const a = stations[i] - stations[i - 1],
      b = stations[i + 1] - stations[i];
    const lower = a / diagonal[i - 1];
    diagonal[i] = 2 * (a + b) - lower * upper[i - 1];
    upper[i] = b;
    for (let j = 0; j < n; j++)
      second[i][j] =
        6 * ((Number(j === i + 1) - Number(j === i)) / b - (Number(j === i) - Number(j === i - 1)) / a) -
        lower * second[i - 1][j];
  }
  for (let i = n - 2; i > 0; i--)
    for (let j = 0; j < n; j++) second[i][j] = (second[i][j] - upper[i] * second[i + 1][j]) / diagonal[i];
  return (t: number) => {
    if (t < stations[0] || t > stations[n - 1]) {
      const first = t < stations[0],
        i = first ? 0 : n - 2,
        end = first ? 0 : n - 1;
      const h = stations[i + 1] - stations[i];
      return stations.map(
        (_, j) =>
          Number(j === end) +
          (t - stations[end]) *
            ((Number(j === i + 1) - Number(j === i)) / h +
              ((curvature * h) / 6) *
                (first ? -2 * second[i][j] - second[i + 1][j] : second[i][j] + 2 * second[i + 1][j])),
      );
    }
    const i = Math.min(n - 2, Math.max(0, stations.findIndex((s, j) => j > 0 && s >= t - EPS) - 1));
    const h = stations[i + 1] - stations[i],
      x = (t - stations[i]) / h,
      a = 1 - x;
    return stations.map(
      (_, j) =>
        a * Number(j === i) +
        x * Number(j === i + 1) +
        ((curvature * h * h) / 6) * ((a * a * a - a) * second[i][j] + (x * x * x - x) * second[i + 1][j]),
    );
  };
}

/** A footprint derived entirely from visible curve endpoints. It only supplies directions not bounded
 * by a complete guide family; it cannot carry interior relief or any deleted curve's influence. */
function guideFootprint(U: GuideCurve[], V: GuideCurve[]) {
  const chord = (c: GuideCurve, t: number) => add(mul(curveAt(c, 0), 1 - t), mul(curveAt(c, 1), t));
  const family = U.length >= 2 ? U : V.length >= 2 ? V : undefined;
  if (family) {
    const a = family[0],
      b = family.at(-1)!;
    return (u: number, v: number) => {
      const along = a.axis === 'U' ? u : v,
        across = a.axis === 'U' ? v : u;
      const t = (across - a.at) / (b.at - a.at);
      return add(mul(chord(a, along), 1 - t), mul(chord(b, along), t));
    };
  }
  if (U.length && V.length) {
    const a = U[0],
      b = V[0],
      center = mul(add(chord(a, b.at), chord(b, a.at)), 0.5);
    return (u: number, v: number) => sub(add(chord(a, u), chord(b, v)), center);
  }
  throw new Error('A surface needs at least two control curves to define its extent.');
}

// Inverse Bernstein collocation at 0, 1/3, 2/3, 1. Exact for each cubic polynomial span.
const bernsteinInverse = [
  [1, 0, 0, 0],
  [-5 / 6, 3, -3 / 2, 1 / 3],
  [1 / 3, -3 / 2, 3, -5 / 6],
  [0, 0, 0, 1],
];
export function evaluateCharts(us: number[], vs: number[], evaluate: (u: number, v: number) => V3): Patch[] {
  const out: Patch[] = [];
  if ((us.length - 1) * (vs.length - 1) > 4096) throw new Error('Too many control curve spans.');
  for (let v = 0; v < vs.length - 1; v++)
    for (let u = 0; u < us.length - 1; u++) {
      const values = Array.from({ length: 4 }, (_, a) =>
        Array.from({ length: 4 }, (_, b) =>
          evaluate(us[u] + ((us[u + 1] - us[u]) * a) / 3, vs[v] + ((vs[v + 1] - vs[v]) * b) / 3),
        ),
      );
      const transform = (row: V3[]) =>
        bernsteinInverse.map(weights => {
          const p: V3 = [0, 0, 0];
          for (let i = 0; i < 4; i++) for (let d = 0; d < 3; d++) p[d] += weights[i] * row[i][d];
          return p;
        });
      const alongV = values.map(transform);
      const alongU = Array.from({ length: 4 }, (_, b) => transform(alongV.map(row => row[b])));
      const controls = Array.from({ length: 4 }, (_, a) => alongU.map(row => row[a])).flat();
      out.push({ domain: [us[u], us[u + 1], vs[v], vs[v + 1]], controls });
    }
  return out;
}

/** Absolute Gordon interpolation of the visible curves. Legacy seed/reference data is never a shape
 * input: deleting a constraint always recomputes the surface from the surviving controls. */
export function guideCharts(doc: QuadMeshDoc, surface: SurfaceObject, shapeCurves?: GuideCurve[]): Patch[] {
  const curves = shapeCurves ?? readGuideCurves(doc, surface);
  const U = curves.filter(c => c.axis === 'U').sort((a, b) => a.at - b.at),
    V = curves.filter(c => c.axis === 'V').sort((a, b) => a.at - b.at);
  for (const family of [U, V])
    if (family.some((c, i) => i > 0 && c.at - family[i - 1].at < EPS))
      throw new Error('Two control curves occupy the same station.');
  const rest = guideFootprint(U, V);
  const crossings = U.map(a =>
    V.map(b => {
      const p = curveAt(a, b.at),
        q = curveAt(b, a.at);
      if (len(sub(p, q)) > 1e-5) throw new Error('Control curves must share their crossing points.');
      return sub(p, rest(b.at, a.at));
    }),
  );
  const us = guideCuts([0, 1, ...U.flatMap(c => c.knots), ...V.map(c => c.at)]),
    vs = guideCuts([0, 1, ...V.flatMap(c => c.knots), ...U.map(c => c.at)]);
  const basis = (stations: number[]) =>
    surface.interpolation === 'natural'
      ? interpolator(stations, surface.curvature ?? 1)
      : (t: number) => weights(stations, t, surface.curvature ?? 1);
  const weightsU = basis(V.map(c => c.at)),
    weightsV = basis(U.map(c => c.at));
  const samples = (family: GuideCurve[], weights: (t: number) => number[], axis: SurfaceAxis) => {
    const cache = new Map<number, { w: number[]; delta: V3[] }>();
    return (t: number) => {
      let sample = cache.get(t);
      if (!sample) {
        sample = {
          w: weights(t),
          delta: family.map(c => sub(curveAt(c, t), axis === 'U' ? rest(t, c.at) : rest(c.at, t))),
        };
        cache.set(t, sample);
      }
      return sample;
    };
  };
  const sampleU = samples(U, weightsU, 'U'),
    sampleV = samples(V, weightsV, 'V');
  return evaluateCharts(us, vs, (u, v) => {
    const a = sampleU(u),
      b = sampleV(v),
      p = rest(u, v);
    for (let j = 0; j < U.length; j++) {
      for (let d = 0; d < 3; d++) p[d] += a.delta[j][d] * b.w[j];
      for (let i = 0; i < V.length; i++) for (let d = 0; d < 3; d++) p[d] -= crossings[j][i][d] * b.w[j] * a.w[i];
    }
    for (let i = 0; i < V.length; i++) for (let d = 0; d < 3; d++) p[d] += b.delta[i][d] * a.w[i];
    return p;
  });
}

/** Extract an exact piecewise cubic isoparametric curve. */
export function sectionCurve(charts: Patch[], axis: SurfaceAxis, at: number, extra: number[] = []): GuideCurve {
  const d = axis === 'U' ? 0 : 2;
  const knots = guideCuts([0, 1, ...charts.flatMap(p => p.domain.slice(d, d + 2)), ...extra]);
  const points = knots.slice(1).map((hi, i) => {
    const lo = knots[i],
      samples = [0, 1 / 3, 2 / 3, 1].map(t =>
        axis === 'U' ? chartPoint(charts, lo + (hi - lo) * t, at) : chartPoint(charts, at, lo + (hi - lo) * t),
      );
    return bernsteinInverse.map(row => row.reduce((p, w, j) => add(p, mul(samples[j], w)), [0, 0, 0] as V3));
  });
  // A quilt seam is not necessarily a bend in this particular section. Keep only actual cubic
  // changes and requested anchors, so straight boundaries do not acquire redundant source points.
  for (let i = 1; i < knots.length - 1;) {
    if (extra.some(t => Math.abs(t - knots[i]) < EPS)) {
      i++;
      continue;
    }
    const a = points[i - 1],
      b = points[i],
      t = (knots[i] - knots[i - 1]) / (knots[i + 1] - knots[i - 1]);
    const cp: [V3, V3, V3, V3] = [
      a[0],
      add(a[0], mul(sub(a[1], a[0]), 1 / t)),
      add(b[3], mul(sub(b[2], b[3]), 1 / (1 - t))),
      b[3],
    ];
    const split = splitCubic(...cp, t);
    if ([...split.left, ...split.right].every((p, j) => len(sub(p, [...a, ...b][j])) < 1e-7)) {
      knots.splice(i, 1);
      points.splice(i - 1, 2, cp);
      i = Math.max(1, i - 1);
    } else i++;
  }
  return { axis, at, knots, points };
}

/** Append one editable curve. Existing crossing ids let the two directions share actual source vertices. */
export function appendGuide(doc: QuadMeshDoc, curve: GuideCurve, crossings = new Map<number, string>()) {
  let out = {
    ...doc,
    vertices: [...doc.vertices],
    vertexIds: [...doc.vertexIds],
    freeEdges: [...(doc.freeEdges ?? [])],
    edgeHandles: { ...doc.edgeHandles },
  };
  const names = curve.knots.map((t, i) => {
    const existing = [...crossings].find(([s]) => Math.abs(s - t) < EPS)?.[1];
    if (existing) return existing;
    const idAt = out.vertexIds.length;
    out = { ...out, ...appendMeshIds(out, 1, 0) };
    out.vertices.push(...(i === curve.points.length ? curve.points.at(-1)![3] : curve.points[i][0]));
    return out.vertexIds[idAt];
  });
  const index = nameIndex(out.vertexIds);
  curve.points.forEach((cp, i) => {
    const a = index.get(names[i])!,
      b = index.get(names[i + 1])!;
    // Match migration's undirected-edge representation, so saving a guide does not change its hash on read.
    out.freeEdges.push([Math.min(a, b), Math.max(a, b)]);
    out.edgeHandles[`${a}>${b}`] = sub(cp[1], cp[0]);
    out.edgeHandles[`${b}>${a}`] = sub(cp[2], cp[3]);
  });
  return { doc: out as QuadMeshDoc, names };
}

/** Exact split of an owned source edge; its two cubic handles are retained on each side. */
export function splitGuide(doc: QuadMeshDoc, surface: SurfaceObject, g: number, t: number) {
  const guide = surface.guides![g],
    names = surface.controls[g];
  const existing = guide.knots.findIndex(s => Math.abs(s - t) < EPS);
  if (existing >= 0) return { doc, surface, id: names[existing] };
  const curve = readGuideCurves(doc, surface)[g],
    i = guide.knots.findIndex((hi, j) => j > 0 && hi > t) - 1;
  if (i < 0) throw new Error('The new control curve is outside the surface.');
  const parts = splitCubic(
    ...(curve.points[i] as [V3, V3, V3, V3]),
    (t - guide.knots[i]) / (guide.knots[i + 1] - guide.knots[i]),
  );
  const a = doc.vertexIds.indexOf(names[i]),
    b = doc.vertexIds.indexOf(names[i + 1]),
    c = doc.vertexIds.length;
  const out: QuadMeshDoc = {
    ...doc,
    ...appendMeshIds(doc, 1, 0),
    vertices: [...doc.vertices, ...parts.left[3]],
    freeEdges: [
      ...(doc.freeEdges ?? []).filter(([x, y]) => !((x === a && y === b) || (x === b && y === a))),
      [Math.min(a, c), Math.max(a, c)],
      [Math.min(c, b), Math.max(c, b)],
    ],
    edgeHandles: { ...doc.edgeHandles },
  };
  delete out.edgeHandles![`${a}>${b}`];
  delete out.edgeHandles![`${b}>${a}`];
  for (const [x, y, cp] of [
    [a, c, parts.left],
    [c, b, parts.right],
  ] as [number, number, V3[]][]) {
    out.edgeHandles![`${x}>${y}`] = sub(cp[1], cp[0]);
    out.edgeHandles![`${y}>${x}`] = sub(cp[2], cp[3]);
  }
  const controls = surface.controls.map((row, j) =>
    j === g ? [...row.slice(0, i + 1), out.vertexIds[c], ...row.slice(i + 1)] : row,
  );
  const guides = surface.guides!.map((item, j) => {
    if (j !== g) return item;
    const reference = item.reference;
    const split = reference
      ? splitCubic(...(reference[i] as [V3, V3, V3, V3]), (t - item.knots[i]) / (item.knots[i + 1] - item.knots[i]))
      : undefined;
    return {
      ...item,
      knots: [...guide.knots.slice(0, i + 1), t, ...guide.knots.slice(i + 1)],
      ...(split ? { reference: [...reference!.slice(0, i), split.left, split.right, ...reference!.slice(i + 1)] } : {}),
    };
  });
  return { doc: out, surface: { ...surface, controls, guides }, id: out.vertexIds[c] };
}

export function guideRows(surface: SurfaceObject, axis: SurfaceAxis): number[] {
  return surface
    .guides!.flatMap((g, i) => (g.axis === axis ? [i] : []))
    .sort((a, b) => surface.guides![a].at - surface.guides![b].at);
}

export type SurfaceGuideSnapTarget = { at: number; across: number; id: string; point: V3 };

/** Only perpendicular guides can contribute reusable crossing points to a new isoparametric curve. */
export function surfaceGuideSnapTargets(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  axis: SurfaceAxis,
): SurfaceGuideSnapTarget[] {
  const ids = nameIndex(doc.vertexIds);
  return surface.guides!.flatMap((g, i) =>
    g.axis === axis
      ? []
      : surface.controls[i].map((id, j) => ({
          at: g.knots[j],
          across: g.at,
          id,
          point: readVertex(doc.vertices, ids.get(id)!),
        })),
  );
}

/** A frozen placement query shared by hover and click. Distance follows the perpendicular section in 3D,
 * so a visually overlapping point on a distant fold cannot attract the guide. */
export function surfaceGuideSnapper(charts: Patch[], axis: SurfaceAxis, targets: SurfaceGuideSnapTarget[]) {
  const sections = new Map(
    [...new Set(targets.map(target => target.across))].map(across => [
      across,
      sectionCurve(charts, axis === 'U' ? 'V' : 'U', across),
    ]),
  );
  return (at: number, reach: (point: V3) => number) => {
    const positions = new Map<number, V3>();
    let best: SurfaceGuideSnapTarget | undefined,
      score = 1;
    for (const target of targets) {
      let point = positions.get(target.across);
      if (!point) {
        point = curveAt(sections.get(target.across)!, at);
        positions.set(target.across, point);
      }
      const distance = len(sub(point, target.point)),
        ratio = distance / Math.max(1e-12, reach(target.point));
      if (ratio <= score) {
        score = ratio;
        best = target;
      }
    }
    const points = best ? targets.filter(t => Math.abs(t.at - best.at) < EPS) : [];
    return { at: best?.at ?? at, points: [...new Map(points.map(p => [p.id, p])).values()] };
  };
}

/** Discard retired history fields. Curves are the complete source of shape. */
export function sourceGuideSurface(surface: SurfaceObject): SurfaceObject {
  const next = { ...surface, guides: surface.guides!.map(({ axis, at, knots }) => ({ axis, at, knots })) };
  delete next.seed;
  return next;
}

export function addGuide(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  axis: SurfaceAxis,
  row: number,
  position?: number,
  shape?: Patch[],
  profile?: GuideCurve,
) {
  surface = sourceGuideSurface(surface);
  const charts = shape ?? compactSurfaceCharts(guideCharts(doc, surface)),
    rows = guideRows(surface, axis),
    stations = rows.map(i => surface.guides![i].at);
  let at = 0.5;
  if (stations.length) {
    const i = Math.min(Math.max(0, row), stations.length - 1);
    at =
      stations[i] < 1 - EPS ? (stations[i] + (stations[i + 1] ?? 1)) / 2 : (stations[i] + (stations[i - 1] ?? 0)) / 2;
  }
  if (position !== undefined) at = position;
  if (!Number.isFinite(at) || at < 0 || at > 1) throw new Error('Place the control curve on the surface.');
  const anchors = surface.guides!.filter(g => g.axis !== axis).flatMap(g => g.knots);
  const snapped = anchors
    .filter(t => Math.abs(t - at) < GUIDE_STATION_EPS)
    .sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
  if (snapped !== undefined && !profile) at = snapped;
  if (stations.some(t => Math.abs(t - at) < GUIDE_STATION_EPS))
    throw new Error('There is no room for another curve here.');
  let out = doc,
    next = surface;
  const cross = new Map<number, string>();
  surface.guides!.forEach((g, i) => {
    if (g.axis === axis) return;
    const split = splitGuide(out, next, i, at);
    out = { ...split.doc, vertices: [...split.doc.vertices] };
    next = split.surface;
    const point = profile
      ? curveAt(profile, g.at)
      : chartPoint(charts, axis === 'U' ? g.at : at, axis === 'U' ? at : g.at);
    out.vertices.splice(out.vertexIds.indexOf(split.id) * 3, 3, ...point);
    cross.set(g.at, split.id);
  });
  let curve = profile ? structuredClone(profile) : sectionCurve(charts, axis, at, [...cross.keys()]);
  if (profile)
    for (const t of cross.keys()) {
      if (curve.knots.some(k => Math.abs(k - t) < EPS)) continue;
      const i = curve.knots.findIndex((hi, j) => j > 0 && hi > t) - 1;
      const parts = splitCubic(
        ...(curve.points[i] as [V3, V3, V3, V3]),
        (t - curve.knots[i]) / (curve.knots[i + 1] - curve.knots[i]),
      );
      curve = {
        ...curve,
        knots: [...curve.knots.slice(0, i + 1), t, ...curve.knots.slice(i + 1)],
        points: [...curve.points.slice(0, i), parts.left, parts.right, ...curve.points.slice(i + 1)],
      };
    }
  const appended = appendGuide(out, curve, cross);
  const candidate = {
    ...next,
    controls: [...next.controls, appended.names],
    guides: [...next.guides!, { axis, at, knots: curve.knots } as Guide],
  };
  return { doc: appended.doc, surface: sourceGuideSurface(candidate) };
}

/** Outer guide stations define the outline and remain structural controls. */
export function isSurfaceBoundaryGuide(surface: SurfaceObject, curve: number): boolean {
  const guide = surface.guides?.[curve];
  return !!guide && (guide.at < EPS || guide.at > 1 - EPS);
}

/** Retire only this guide's construction geometry. Other guides retain their exact cubic curves. */
export function detachGuide(doc: QuadMeshDoc, surface: SurfaceObject, at: number) {
  if (!surface.guides?.[at]) throw new Error('That control curve no longer exists.');
  if (isSurfaceBoundaryGuide(surface, at))
    throw new Error('Keep the surface boundary curves. Move their points or tangents to reshape the outline.');
  const controls = surface.controls.filter((_, i) => i !== at),
    guides = surface.guides.filter((_, i) => i !== at);
  const keep = new Set(controls.flat()),
    retired = new Set(surface.controls[at].filter(id => !keep.has(id)));
  const indices = new Set(doc.vertexIds.flatMap((id, i) => (retired.has(id) ? [i] : [])));
  const key = (a: string, b: string) => [a, b].sort().join(',');
  const activeEdges = new Set(surface.controls.flatMap(row => row.slice(1).map((id, i) => key(row[i], id))));
  if (
    doc.quads.some(q => q.some(v => indices.has(v))) ||
    doc.freeEdges?.some(
      ([a, b]) => (indices.has(a) || indices.has(b)) && !activeEdges.has(key(doc.vertexIds[a], doc.vertexIds[b])),
    )
  )
    throw new Error('Other geometry is attached to this control curve. Detach it before repositioning the guide.');
  const keptEdges = new Set(controls.flatMap(row => row.slice(1).map((id, i) => key(row[i], id))));
  const removedEdges = new Set(surface.controls[at].slice(1).map((id, i) => key(surface.controls[at][i], id)));
  const out = finishMeshRewrite(doc, {
    ...doc,
    freeEdges: doc.freeEdges?.filter(([a, b]) => {
      const edge = key(doc.vertexIds[a], doc.vertexIds[b]);
      return !indices.has(a) && !indices.has(b) && (!removedEdges.has(edge) || keptEdges.has(edge));
    }),
    keepVertices: doc.vertexIds.flatMap((_, i) => (indices.has(i) ? [] : [i])),
  }).doc;
  return { doc: out, surface: { ...surface, controls, guides } };
}

export function removeGuide(doc: QuadMeshDoc, surface: SurfaceObject, axis: SurfaceAxis, row: number) {
  if (surface.guides!.length <= 1) throw new Error('Keep one editable control curve.');
  const at = guideRows(surface, axis)[row];
  if (at === undefined) throw new Error('Select a control curve to remove.');
  return detachGuide(doc, sourceGuideSurface(surface), at);
}
