import type { QuadMeshDoc, SurfaceObject } from '../doc/types';
import { compactSurfaceCharts } from '../math/spline-surface';
import { len, sub } from '../math/vec';
import {
  addGuide,
  chartPoint,
  guideCharts,
  readGuideCurves,
  sectionCurve,
  sourceGuideSurface,
  splitGuide,
} from './surface-guides';
import type { Patch } from './loft-surface';

/** Express a sampled shape through visible, editable curves. Used by corner changes, legacy cage
 * conversion and stitch detachment; the sampled quilt is temporary and never survives as an input. */
export function materializeSurfaceShape(doc: QuadMeshDoc, surface: SurfaceObject, shape: Patch[], tolerance: number) {
  const target = compactSurfaceCharts(shape);
  let out = doc,
    next = sourceGuideSurface(surface);
  // Recreate complete cubic sections, including the points required by their polynomial spans.
  // Reusing existing ids preserves outline attachments and selection at existing crossings.
  for (let i = 0; i < next.guides!.length; i++) {
    const g = next.guides![i];
    const curve = sectionCurve(target, g.axis, g.at, g.knots);
    for (const t of curve.knots.slice(1, -1)) {
      const split = splitGuide(out, next, i, t);
      out = split.doc;
      next = split.surface;
    }
  }
  out = { ...out, vertices: [...out.vertices], edgeHandles: { ...out.edgeHandles } };
  for (let i = 0; i < next.guides!.length; i++) {
    const g = next.guides![i],
      row = next.controls[i],
      curve = sectionCurve(target, g.axis, g.at, g.knots);
    const put = (key: string, value: [number, number, number]) => {
      if (!out.edgeHandles![key] || len(sub(value, out.edgeHandles![key])) > 1e-9) out.edgeHandles![key] = value;
    };
    curve.points.forEach((cp, j) => {
      const a = out.vertexIds.indexOf(row[j]),
        b = out.vertexIds.indexOf(row[j + 1]);
      if (len(sub(cp[0], out.vertices.slice(a * 3, a * 3 + 3) as [number, number, number])) > 1e-9)
        out.vertices.splice(a * 3, 3, ...cp[0]);
      if (
        j === curve.points.length - 1 &&
        len(sub(cp[3], out.vertices.slice(b * 3, b * 3 + 3) as [number, number, number])) > 1e-9
      )
        out.vertices.splice(b * 3, 3, ...cp[3]);
      put(`${a}>${b}`, sub(cp[1], cp[0]));
      put(`${b}>${a}`, sub(cp[2], cp[3]));
    });
  }
  for (let iteration = 0; iteration < 64; iteration++) {
    if (next.controls.flat().length > 4096) break;
    const fitted = guideCharts(out, next);
    let error = 0,
      u = 0.5,
      v = 0.5;
    for (const p of target)
      for (const a of [0.2, 0.5, 0.8])
        for (const b of [0.2, 0.5, 0.8]) {
          const x = p.domain[0] + a * (p.domain[1] - p.domain[0]),
            y = p.domain[2] + b * (p.domain[3] - p.domain[2]);
          const distance = len(sub(chartPoint(target, x, y), chartPoint(fitted, x, y)));
          if (distance > error) {
            error = distance;
            u = x;
            v = y;
          }
        }
    if (error <= tolerance) {
      next = {
        ...sourceGuideSurface(next),
        evaluated: { points: readGuideCurves(out, next).map(c => c.points.flat()), patchSizeM: next.patchSizeM },
      };
      return { doc: { ...out, surfaces: out.surfaces?.map(s => (s.id === next.id ? next : s)) }, surface: next };
    }
    // Complete sections already capture every polynomial change in their running direction. Refine
    // one transverse family, rather than growing a dense two-dimensional lattice of crossing guides.
    const axis = next.guides!.filter(g => g.axis === 'U').length >= 2 ? 'U' : 'V';
    const added = addGuide(out, next, axis, 0, axis === 'U' ? v : u, target);
    out = added.doc;
    next = added.surface;
  }
  throw new Error(
    'Preserving this shape needs more visible source controls than this operation supports. Try smaller corner changes or refill from the boundary.',
  );
}
