import type { QuadMeshDoc, SurfaceObject, SurfaceSide, SurfaceStitch, V3 } from '../doc/types';
import { readVertex } from './primitives';
import {
  boundarySurfaceCharts,
  boundarySurfaceInput,
  rebuildSurface,
  surfaceBoundaryLoop,
  type SurfaceResult,
} from './surface-object';
import { addGuide, chartPoint, evaluateCharts, guideCharts, guideCuts, isSurfaceBoundaryGuide } from './surface-guides';
import { patchDerivatives, patchNormal, patchPoint } from '../math/bezier';
import { len, sub } from '../math/vec';
import { compactSurfaceCharts } from '../math/spline-surface';
import { finishMeshRewrite } from './ops/contract';
import { surfaceFitTolerance } from './surface-fit';
import { materializeSurfaceShape } from './surface-source';
import type { Patch } from './loft-surface';

const EPS = 1e-7;
const sideOf = (g: NonNullable<SurfaceObject['guides']>[number]) =>
  `${g.axis === 'U' ? 'v' : 'u'}${g.at}` as SurfaceSide;

/** The live perimeter, including points inserted after creation; original sketch inputs can be stale. */
export function surfaceCornerBoundary(doc: QuadMeshDoc, surface: SurfaceObject) {
  if (!surface.guides) throw new Error('This surface needs editable boundary guides.');
  const rows = surface.guides.flatMap((g, i) => (isSurfaceBoundaryGuide(surface, i) ? [i] : []));
  if (rows.length !== 4) throw new Error('Keep four boundary curves before editing corners.');
  const edges = rows.flatMap(i =>
    surface.controls[i]
      .slice(1)
      .map((id, j) => [doc.vertexIds.indexOf(surface.controls[i][j]), doc.vertexIds.indexOf(id)]),
  );
  const ordered = surfaceBoundaryLoop(doc, edges);
  if (!ordered.ok) throw new Error(ordered.error);
  const endpoints = new Set(rows.flatMap(i => [surface.controls[i][0], surface.controls[i].at(-1)!]));
  return { loop: ordered.loop, corners: ordered.loop.flatMap((v, i) => (endpoints.has(doc.vertexIds[v]) ? [i] : [])) };
}

type BoundarySpan = { side: SurfaceSide; from: string; to: string; lo: number; hi: number };
function spans(surface: SurfaceObject): BoundarySpan[] {
  return surface.guides!.flatMap((g, i) =>
    isSurfaceBoundaryGuide(surface, i)
      ? surface.controls[i]
          .slice(1)
          .map((to, j) => ({ side: sideOf(g), from: surface.controls[i][j], to, lo: g.knots[j], hi: g.knots[j + 1] }))
      : [],
  );
}

/** Translate a boundary interval by its unchanged source edges, splitting only where its new side changes.
 *  Each span records the old and new parameters so either end of a directed stitch can be translated. */
function translateBoundary(before: SurfaceObject, after: SurfaceObject, side: SurfaceSide, range: [number, number]) {
  const next = spans(after),
    out: { side: SurfaceSide; old: [number, number]; range: [number, number] }[] = [];
  for (const edge of spans(before).filter(e => e.side === side)) {
    const lo = Math.max(Math.min(...range), edge.lo),
      hi = Math.min(Math.max(...range), edge.hi);
    if (hi - lo < EPS) continue;
    const found = next.find(
      e => (e.from === edge.from && e.to === edge.to) || (e.from === edge.to && e.to === edge.from),
    );
    if (!found) throw new Error('A stitched boundary edge was removed.');
    const at = (t: number) => {
      const x = (t - edge.lo) / (edge.hi - edge.lo);
      return found.from === edge.from ? found.lo + x * (found.hi - found.lo) : found.hi - x * (found.hi - found.lo);
    };
    const piece = { side: found.side, old: [lo, hi] as [number, number], range: [at(lo), at(hi)] as [number, number] },
      previous = out.at(-1);
    const slope = (p: typeof piece) => (p.range[1] - p.range[0]) / (p.old[1] - p.old[0]);
    if (
      previous &&
      previous.side === piece.side &&
      Math.abs(previous.old[1] - lo) < EPS &&
      Math.abs(previous.range[1] - piece.range[0]) < EPS &&
      Math.abs(slope(previous) - slope(piece)) < EPS
    ) {
      previous.old[1] = hi;
      previous.range[1] = piece.range[1];
    } else out.push(piece);
  }
  if (range[0] > range[1])
    return out.reverse().map(p => ({
      ...p,
      old: [...p.old].reverse() as [number, number],
      range: [...p.range].reverse() as [number, number],
    }));
  return out;
}

export function remapSurfaceCornerStitches(doc: QuadMeshDoc, before: SurfaceObject, after: SurfaceObject) {
  const interpolate = (range: [number, number], t: number) => range[0] + (range[1] - range[0]) * t;
  return doc.surfaces!.map(owner => {
    const stitches = owner.stitches?.flatMap(st => {
      if (owner.id === before.id) {
        const pieces = translateBoundary(before, after, st.side, st.range);
        return pieces.map((part, i): SurfaceStitch => {
          let target = st.target;
          const fractions = part.old.map(t => (t - st.range[0]) / (st.range[1] - st.range[0]));
          if ('surface' in target) {
            const targetRange = target.range;
            target = { ...target, range: fractions.map(t => interpolate(targetRange, t)) as [number, number] };
          } else if (pieces.length > 1) {
            // An ordinary host has actual vertices, rather than a parameter range. Splitting its constraint
            // requires matching host stations; never silently drop part of a plain-terrain connection.
            const chain = target.vertices,
              distance = [0];
            for (let j = 1; j < chain.length; j++)
              distance.push(
                distance[j - 1] +
                  len(
                    sub(
                      readVertex(doc.vertices, doc.vertexIds.indexOf(chain[j])),
                      readVertex(doc.vertices, doc.vertexIds.indexOf(chain[j - 1])),
                    ),
                  ),
              );
            const indices = fractions.map(t => distance.findIndex(d => Math.abs(d / distance.at(-1)! - t) < 1e-5));
            if (indices.some(j => j < 0))
              throw new Error(
                'A new corner splits a plain-terrain stitch between host vertices. Add a matching host point first, or choose another corner.',
              );
            target = { vertices: chain.slice(Math.min(...indices), Math.max(...indices) + 1) };
          }
          let range = part.range;
          if (range[0] > range[1]) {
            range = [...range].reverse() as [number, number];
            target =
              'surface' in target
                ? { ...target, range: [...target.range].reverse() as [number, number] }
                : { vertices: [...target.vertices].reverse() };
          }
          return { ...st, id: i ? `${st.id}/corner:${i}` : st.id, side: part.side, range, target };
        });
      }
      if (!('surface' in st.target) || st.target.surface !== before.id) return [{ ...st }];
      const target = st.target;
      return translateBoundary(before, after, target.side, target.range).map((part, i): SurfaceStitch => ({
        ...st,
        id: i ? `${st.id}/corner:${i}` : st.id,
        range: part.old.map(t =>
          interpolate(st.range, (t - target.range[0]) / (target.range[1] - target.range[0])),
        ) as [number, number],
        target: { ...target, side: part.side, range: part.range },
      }));
    });
    const ids = new Set<string>();
    for (const stitch of stitches ?? []) {
      const base = stitch.id;
      let i = 1;
      while (ids.has(stitch.id)) stitch.id = `${base}/split:${i++}`;
      ids.add(stitch.id);
    }
    if ((stitches?.length ?? 0) > 128)
      throw new Error('These corners need more than 128 stitched spans. Choose fewer stitch divisions first.');
    return { ...(owner.id === before.id ? after : owner), stitches };
  });
}

/** Re-sample a terrain-shaped surface through its dominant-plane projection. A folded/multivalued projection
 *  is refused rather than substituting a fresh interior under a request to preserve the artist's shape. */
function preserveShape(old: Patch[], outline: Patch[], tolerance: number): Patch[] {
  const normal = outline.reduce(
    (n, p) => {
      const q = patchNormal(p.controls, 0.5, 0.5);
      return n.map((v, i) => v + q[i]);
    },
    [0, 0, 0],
  );
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),
    axes = [0, 1, 2].filter(i => i !== drop),
    bounds = old.map(p =>
      axes.map(k => [Math.min(...p.controls.map(x => x[k])), Math.max(...p.controls.map(x => x[k]))]),
    );
  const cache = new Map<string, V3>();
  const evaluate = (u: number, v: number): V3 => {
    const key = `${u.toFixed(10)},${v.toFixed(10)}`,
      held = cache.get(key);
    if (held) return held;
    const target = chartPoint(outline, u, v);
    if (u < EPS || v < EPS || u > 1 - EPS || v > 1 - EPS) return target;
    let best: V3 | undefined,
      distance = Infinity;
    old.forEach((patch, i) => {
      if (axes.some((k, a) => target[k] < bounds[i][a][0] - EPS || target[k] > bounds[i][a][1] + EPS)) return;
      for (const initial of [
        [0.5, 0.5],
        [0.1, 0.1],
        [0.9, 0.9],
      ]) {
        let [s, t] = initial;
        for (let step = 0; step < 25; step++) {
          const p = patchPoint(patch.controls, s, t),
            { du, dv } = patchDerivatives(patch.controls, s, t),
            [a, b] = axes,
            x = p[a] - target[a],
            y = p[b] - target[b],
            det = du[a] * dv[b] - du[b] * dv[a];
          if (Math.hypot(x, y) < 1e-6) break;
          if (Math.abs(det) < 1e-12) break;
          s = Math.max(-0.05, Math.min(1.05, s - (x * dv[b] - y * dv[a]) / det));
          t = Math.max(-0.05, Math.min(1.05, t - (du[a] * y - du[b] * x) / det));
        }
        const p = patchPoint(patch.controls, s, t);
        if (
          s >= -EPS &&
          s <= 1 + EPS &&
          t >= -EPS &&
          t <= 1 + EPS &&
          Math.hypot(...axes.map(k => p[k] - target[k])) < 1e-5 &&
          len(sub(p, target)) < distance
        ) {
          if (best && len(sub(best, p)) > 1e-4)
            throw new Error(
              'The existing surface overlaps in this projection. Choose different corners or Refill from boundary.',
            );
          best = p;
          distance = len(sub(p, target));
          break;
        }
      }
    });
    if (!best)
      throw new Error(
        'The existing shape cannot be mapped through this outline. Try different corners or choose Refill from boundary.',
      );
    cache.set(key, best);
    return best;
  };
  for (const divisions of [8, 16, 32]) {
    const extra = Array.from({ length: divisions + 1 }, (_, i) => i / divisions),
      us = guideCuts([...extra, ...outline.flatMap(p => p.domain.slice(0, 2))]),
      vs = guideCuts([...extra, ...outline.flatMap(p => p.domain.slice(2))]);
    const charts = evaluateCharts(us, vs, evaluate);
    const valid = charts.every(p =>
      [
        [0.5, 0.5],
        [0.25, 0.75],
        [0.75, 0.25],
      ].every(
        ([s, t]) =>
          len(
            sub(
              patchPoint(p.controls, s, t),
              evaluate(p.domain[0] + s * (p.domain[1] - p.domain[0]), p.domain[2] + t * (p.domain[3] - p.domain[2])),
            ),
          ) <= tolerance,
      ),
    );
    if (valid) return compactSurfaceCharts(charts);
  }
  throw new Error('Preserving this shape needs more detail. Try closer corners or choose Refill from boundary.');
}

/** Reparameterize one object atomically. Boundary identities/cubics survive; interior guides are sampled on
 *  the new chart, and both incoming and outgoing stitch intervals follow the unchanged perimeter. */
export function rebuildSurfaceCorners(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  corners: readonly string[],
  preserve = true,
): SurfaceResult {
  try {
    const boundary = surfaceCornerBoundary(doc, surface),
      edges = boundary.loop.map((v, i) => [v, boundary.loop[(i + 1) % boundary.loop.length]]),
      chosen = corners.map(id => doc.vertexIds.indexOf(id)),
      { paths, curves } = boundarySurfaceInput(doc, edges, chosen);
    if (preserve && boundary.corners.every((at, i) => corners[i] === doc.vertexIds[boundary.loop[at]]))
      return { ok: true, doc, surface };
    let seed = boundarySurfaceCharts(doc, edges, chosen, false),
      next: SurfaceObject = {
        ...surface,
        controls: paths.map(row => row.map(i => doc.vertexIds[i])),
        guides: curves.map(c => ({ axis: c.axis, at: c.at, knots: c.knots })),
        seed: undefined,
        fitted: undefined,
        outputKeys: surface.outputKeys,
        error: undefined,
      };
    if (seed.reduce((sum, p) => sum + patchNormal(p.controls, 0.5, 0.5)[1], 0) < 0) {
      seed = seed.map(p => ({
        domain: [1 - p.domain[1], 1 - p.domain[0], p.domain[2], p.domain[3]],
        controls: [3, 2, 1, 0].flatMap(i => p.controls.slice(i * 4, i * 4 + 4)),
      }));
      next.controls = next.controls.map((row, i) => (next.guides![i].axis === 'U' ? [...row].reverse() : row));
      next.guides = next.guides!.map(g =>
        g.axis === 'U'
          ? { ...g, knots: [...g.knots].reverse().map(t => 1 - t), reference: undefined }
          : { ...g, at: 1 - g.at, reference: undefined },
      );
    }
    const target = preserve
      ? preserveShape(guideCharts(doc, surface), seed, surfaceFitTolerance(surface.patchSizeM) / 2)
      : seed;
    const keepBoundary = new Set(next.controls.flat()),
      owned = new Set(surface.controls.flat()),
      remove = new Set(doc.vertexIds.flatMap((id, i) => (owned.has(id) && !keepBoundary.has(id) ? [i] : [])));
    if (
      doc.quads.some(q => q.some(v => remove.has(v))) ||
      doc.freeEdges?.some(
        ([a, b]) => (remove.has(a) || remove.has(b)) && (!owned.has(doc.vertexIds[a]) || !owned.has(doc.vertexIds[b])),
      )
    )
      throw new Error('Other geometry uses an interior guide point. Disconnect that point before changing corners.');
    let out: QuadMeshDoc = { ...doc, surfaces: remapSurfaceCornerStitches(doc, surface, next) };
    out = finishMeshRewrite(out, {
      ...out,
      freeEdges: out.freeEdges?.filter(([a, b]) => !remove.has(a) && !remove.has(b)),
      keepVertices: out.vertexIds.flatMap((_, i) => (remove.has(i) ? [] : [i])),
    }).doc;
    next = out.surfaces!.find(s => s.id === surface.id)!;
    // Retain the artist's guide count/stations, but rebuild their endpoints and crossings on the new chart.
    for (const g of surface.guides!.filter((_, i) => !isSurfaceBoundaryGuide(surface, i))) {
      const added = addGuide(out, next, g.axis, 0, g.at, target);
      out = added.doc;
      next = added.surface;
    }
    const visible = materializeSurfaceShape(out, next, target, surfaceFitTolerance(surface.patchSizeM) / 2);
    return rebuildSurface(visible.doc, visible.surface);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
