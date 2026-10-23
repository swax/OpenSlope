import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { appendMeshIds, nameIndex } from '../doc/ids';
import { cubicPoint, patchPoint, splitCubic } from '../math/bezier';
import { add, sub, mul, len, dot, cross } from '../math/vec';
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

/** Interpolating cardinal Hermite basis, including unequal guide spacing and linear end extrapolation. */
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

/** Gordon-style residual blend: both curve families are interpolated, subtracting their shared crossings. */
export function guideCharts(doc: QuadMeshDoc, surface: SurfaceObject, shapeCurves?: GuideCurve[]): Patch[] {
  const curves = shapeCurves ?? readGuideCurves(doc, surface),
    seed = surface.seed!;
  const U = curves.filter(c => c.axis === 'U').sort((a, b) => a.at - b.at),
    V = curves.filter(c => c.axis === 'V').sort((a, b) => a.at - b.at);
  // The rest quilt is rectangular. Locate its spans by parameter instead of linearly scanning all
  // patches for every blend sample and every guide residual.
  const seedU = guideCuts(seed.flatMap(p => p.domain.slice(0, 2))),
    seedV = guideCuts(seed.flatMap(p => p.domain.slice(2)));
  const quilt: Patch[][] = Array.from({ length: seedV.length - 1 }, () => []);
  for (const p of seed) quilt[seedV.indexOf(p.domain[2])][seedU.indexOf(p.domain[0])] = p;
  const span = (cuts: number[], t: number) => {
    let lo = 1,
      hi = cuts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cuts[mid] < t - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  const rest = (u: number, v: number) => {
    const p = quilt[span(seedV, v)]?.[span(seedU, u)];
    if (!p) throw new Error('The surface has a gap in its parameter domain.');
    return patchPoint(
      p.controls,
      (u - p.domain[0]) / (p.domain[1] - p.domain[0]),
      (v - p.domain[2]) / (p.domain[3] - p.domain[2]),
    );
  };
  for (const family of [U, V])
    if (family.some((c, i) => i > 0 && c.at - family[i - 1].at < EPS))
      throw new Error('Two control curves occupy the same station.');
  const crossings = U.map(a =>
    V.map(b => {
      const base = rest(b.at, a.at);
      const p = sub(curveAt(a, b.at), a.reference ? curveAt({ ...a, points: a.reference }, b.at) : base),
        q = sub(curveAt(b, a.at), b.reference ? curveAt({ ...b, points: b.reference }, a.at) : base);
      if (len(sub(p, q)) > 1e-5) throw new Error('Control curves must share their crossing points.');
      return p;
    }),
  );
  const us = guideCuts([
    0,
    1,
    ...seed.flatMap(p => p.domain.slice(0, 2)),
    ...U.flatMap(c => c.knots),
    ...V.map(c => c.at),
  ]);
  const vs = guideCuts([
    0,
    1,
    ...seed.flatMap(p => p.domain.slice(2)),
    ...V.flatMap(c => c.knots),
    ...U.map(c => c.at),
  ]);
  const samples = (family: GuideCurve[], other: GuideCurve[], axis: SurfaceAxis) => {
    const stations = other.map(c => c.at);
    const cache = new Map<number, { w: number[]; delta: V3[] }>();
    return (t: number) => {
      let sample = cache.get(t);
      if (!sample) {
        sample = {
          w: weights(stations, t, surface.curvature ?? 1),
          delta: family.map(c =>
            sub(
              curveAt(c, t),
              c.reference ? curveAt({ ...c, points: c.reference }, t) : axis === 'U' ? rest(t, c.at) : rest(c.at, t),
            ),
          ),
        };
        cache.set(t, sample);
      }
      return sample;
    };
  };
  const sampleU = samples(U, V, 'U'),
    sampleV = samples(V, U, 'V');
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
  return { axis, at, knots, points };
}

/** Sparse authoring basis: endpoints plus explicit crossings. The exact rest section is retained by
 * the surface, so its internal polynomial seams do not become compulsory editable control points. */
function sectionBasis(charts: Patch[], axis: SurfaceAxis, at: number, anchors: number[]): GuideCurve {
  const section = sectionCurve(charts, axis, at),
    knots = guideCuts([0, 1, ...anchors]);
  const tangent = (t: number, right: boolean) => {
    const index = section.knots.findIndex((hi, i) => i > 0 && (right ? hi > t + EPS : hi >= t - EPS));
    const i = index < 0 ? section.points.length - 1 : index - 1;
    const cp = section.points[i],
      h = section.knots[i + 1] - section.knots[i],
      x = (t - section.knots[i]) / h,
      s = 1 - x;
    return mul(
      add(add(mul(sub(cp[1], cp[0]), 3 * s * s), mul(sub(cp[2], cp[1]), 6 * s * x)), mul(sub(cp[3], cp[2]), 3 * x * x)),
      1 / h,
    );
  };
  const points = knots.slice(1).map((hi, i) => {
    const lo = knots[i],
      A = curveAt(section, lo),
      B = curveAt(section, hi),
      scale = (hi - lo) / 3;
    return [A, add(A, mul(tangent(lo, true), scale)), sub(B, mul(tangent(hi, false), scale)), B];
  });
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

/** Carry the rest quilt through a whole-object affine edit; ordinary local edits leave it alone. */
export function rebaseGuideSeed(doc: QuadMeshDoc, surface: SurfaceObject): SurfaceObject {
  const old = surface.evaluated.points.flat(),
    now = readGuideCurves(doc, surface).flatMap(c => c.points.flat());
  if (old.length !== now.length || old.length < 4 || old.every((p, i) => len(sub(p, now[i])) < 1e-10)) return surface;
  const origin = old[0],
    target = now[0];
  const carry = (map: (p: V3) => V3): SurfaceObject => ({
    ...surface,
    seed: surface.seed!.map(p => ({ ...p, controls: p.controls.map(map) })),
    guides: surface.guides!.map(g => (g.reference ? { ...g, reference: g.reference.map(cp => cp.map(map)) } : g)),
  });
  const translation = sub(target, origin);
  if (old.every((p, i) => len(sub(add(p, translation), now[i])) < 1e-6)) return carry(p => add(p, translation));
  const farthest = (score: (p: V3) => number) =>
    old.reduce((best, p, i) => (score(p) > score(old[best]) ? i : best), 0);
  const i = farthest(p => len(sub(p, origin))),
    a = sub(old[i], origin),
    A = sub(now[i], target);
  const j = farthest(p => len(cross(a, sub(p, origin)))),
    b = sub(old[j], origin),
    B = sub(now[j], target),
    normal = cross(a, b);
  if (len(normal) < 1e-8) return surface;
  const k = farthest(p => Math.abs(dot(normal, sub(p, origin))));
  const c = sub(old[k], origin),
    C = sub(now[k], target),
    det = dot(a, cross(b, c));
  const map = (p: V3): V3 => {
    const r = sub(p, origin);
    if (Math.abs(det) > 1e-8)
      return add(
        target,
        add(
          add(mul(A, dot(r, cross(b, c)) / det), mul(B, dot(a, cross(r, c)) / det)),
          mul(C, dot(a, cross(b, r)) / det),
        ),
      );
    const aa = dot(a, a),
      bb = dot(b, b),
      ab = dot(a, b),
      d = aa * bb - ab * ab;
    return add(
      target,
      add(mul(A, (dot(r, a) * bb - dot(r, b) * ab) / d), mul(B, (dot(r, b) * aa - dot(r, a) * ab) / d)),
    );
  };
  if (old.some((p, i) => len(sub(map(p), now[i])) > 1e-6)) return surface;
  return carry(map);
}

/** Capture the current shape and the current authoring basis independently. Reorganizing controls then
 * starts at zero displacement even when a sparse guide no longer represents every rest-surface span. */
export function freezeGuideSurface(doc: QuadMeshDoc, surface: SurfaceObject): SurfaceObject {
  const seed = compactSurfaceCharts(guideCharts(doc, surface)),
    curves = readGuideCurves(doc, surface);
  return { ...surface, seed, guides: surface.guides!.map((g, i) => ({ ...g, reference: curves[i].points })) };
}

export function addGuide(doc: QuadMeshDoc, surface: SurfaceObject, axis: SurfaceAxis, row: number, position?: number) {
  surface = freezeGuideSurface(doc, surface);
  const charts = surface.seed!,
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
  if (snapped !== undefined) at = snapped;
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
    const point = chartPoint(charts, axis === 'U' ? g.at : at, axis === 'U' ? at : g.at);
    out.vertices.splice(out.vertexIds.indexOf(split.id) * 3, 3, ...point);
    cross.set(g.at, split.id);
  });
  const curve = sectionBasis(charts, axis, at, [...cross.keys()]);
  const appended = appendGuide(out, curve, cross);
  const candidate = {
    ...next,
    seed: charts,
    controls: [...next.controls, appended.names],
    guides: [...next.guides!, { axis, at, knots: curve.knots } as Guide],
  };
  const curves = readGuideCurves(appended.doc, candidate);
  return {
    doc: appended.doc,
    surface: {
      ...candidate,
      guides: candidate.guides.map((g, i) => ({ ...g, reference: curves[i].points })),
    },
  };
}

/** Retire only this guide's construction geometry. Other guides retain their exact cubic curves. */
export function detachGuide(doc: QuadMeshDoc, surface: SurfaceObject, at: number) {
  if (!surface.guides?.[at]) throw new Error('That control curve no longer exists.');
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
  return detachGuide(doc, freezeGuideSurface(doc, surface), at);
}

type GuideEdge = { curve: GuideCurve; from: number; to: number };
const drawnGuides = new WeakMap<QuadMeshDoc, { surfaces: QuadMeshDoc['surfaces']; edges: Map<string, GuideEdge> }>();
/** The visible guide follows the rest surface plus its authored displacement, independently of how many
 * authoring points describe that displacement. Internal polynomial seams are not extra editable points. */
export function surfaceGuideEdgeEvaluator(doc: QuadMeshDoc, a: number, b: number): ((t: number) => V3) | undefined {
  if (!doc.surfaces?.some(s => s.guides?.some(g => g.reference))) return;
  let cached = drawnGuides.get(doc);
  if (!cached || cached.surfaces !== doc.surfaces) {
    const edges = new Map<string, GuideEdge>();
    for (const surface of doc.surfaces ?? []) {
      if (!surface.guides?.some(g => g.reference)) continue;
      const charts = guideCharts(doc, surface);
      surface.guides.forEach((g, i) => {
        const curve = sectionCurve(charts, g.axis, g.at);
        surface.controls[i].slice(1).forEach((id, j) => {
          const first = surface.controls[i][j];
          edges.set(`${first}>${id}`, { curve, from: g.knots[j], to: g.knots[j + 1] });
          edges.set(`${id}>${first}`, { curve, from: g.knots[j + 1], to: g.knots[j] });
        });
      });
    }
    cached = { surfaces: doc.surfaces, edges };
    drawnGuides.set(doc, cached);
  }
  const edge = cached.edges.get(`${doc.vertexIds[a]}>${doc.vertexIds[b]}`);
  return edge ? t => curveAt(edge.curve, edge.from + (edge.to - edge.from) * t) : undefined;
}
