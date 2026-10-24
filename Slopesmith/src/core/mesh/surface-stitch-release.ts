import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { patchPoint } from '../math/bezier';
import { chartPoint, evaluateCharts } from './surface-guides';
import { materializeSurfaceShape } from './surface-source';
import { surfaceFitTolerance } from './surface-fit';

/** Capture the attached shape back into the source basis before releasing a live constraint. */
export function releaseSurfaceShape(doc: QuadMeshDoc, surface: SurfaceObject) {
  if (!surface.guides || !surface.fitted) return { doc, surface };
  const cells = surface.patches.map(p => ({
    ...p,
    uv: p.uv ?? [
      [p.domain[0], p.domain[2]],
      [p.domain[0], p.domain[3]],
      [p.domain[1], p.domain[2]],
      [p.domain[1], p.domain[3]],
    ],
  }));
  const evaluate = (u: number, v: number): V3 => {
    for (const p of cells) {
      if (u < p.domain[0] - 1e-7 || u > p.domain[1] + 1e-7 || v < p.domain[2] - 1e-7 || v > p.domain[3] + 1e-7)
        continue;
      const [a, b, c, d] = p.uv;
      let s = 0.5,
        t = 0.5;
      for (let i = 0; i < 16; i++) {
        const point = [0, 1].map(
          k => a[k] * (1 - s) * (1 - t) + b[k] * (1 - s) * t + c[k] * s * (1 - t) + d[k] * s * t,
        );
        const ds = [0, 1].map(k => (c[k] - a[k]) * (1 - t) + (d[k] - b[k]) * t),
          dt = [0, 1].map(k => (b[k] - a[k]) * (1 - s) + (d[k] - c[k]) * s);
        const det = ds[0] * dt[1] - ds[1] * dt[0];
        if (Math.abs(det) < 1e-12) break;
        const x = point[0] - u,
          y = point[1] - v;
        s -= (x * dt[1] - y * dt[0]) / det;
        t -= (ds[0] * y - ds[1] * x) / det;
        if (Math.abs(x) + Math.abs(y) < 1e-10) break;
      }
      if (s >= -1e-6 && s <= 1 + 1e-6 && t >= -1e-6 && t <= 1 + 1e-6)
        return patchPoint(p.base, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, t)));
    }
    return chartPoint(surface.fitted!, u, v);
  };
  const cuts = (a: 0 | 2) => [...new Set(surface.fitted!.flatMap(p => p.domain.slice(a, a + 2)))].sort((a, b) => a - b);
  const seed = evaluateCharts(cuts(0), cuts(2), evaluate);
  const visible = materializeSurfaceShape(doc, surface, seed, surfaceFitTolerance(surface.patchSizeM) / 2);
  return { doc: visible.doc, surface: { ...visible.surface, fitted: seed } };
}
