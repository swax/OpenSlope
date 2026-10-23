import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { cubicPolyline } from '../math/bezier';
import { len, sub } from '../math/vec';
import { cellDimensions, cellMetrics } from './measure';
import { guideCharts, sectionCurve } from './surface-guides';

function cubicLength(cp: V3[], steps = 64) {
  const points = cubicPolyline(cp[0], cp[1], cp[2], cp[3], steps);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += len(sub(points[i], points[i - 1]));
  return length;
}

/** Source area and guide lengths stay independent of output density. Average patch dimensions measure the
 * fitted output's curved centre lines in U and V. Read once per inspector rebuild, never every drag frame. */
export function measureSurfaceObject(doc: QuadMeshDoc, surface: SurfaceObject) {
  const charts = surface.guides
    ? guideCharts(doc, surface)
    : surface.patches.map(p => ({ domain: p.domain, controls: p.base }));
  const area = charts.reduce((sum, p) => sum + cellMetrics(p.controls).area, 0);
  let length = 0,
    width = 0;
  for (const { base: cp } of surface.patches) {
    const dimensions = cellDimensions(cp);
    length += dimensions.length;
    width += dimensions.width;
  }
  return {
    area,
    averagePatchSize: surface.patches.length
      ? { length: length / surface.patches.length, width: width / surface.patches.length }
      : null,
    curveLength(index: number) {
      const guide = surface.guides?.[index];
      if (!guide) return 0;
      // A sparse authoring curve can carry additional shape in the rest quilt. Measure its visible section.
      return sectionCurve(charts, guide.axis, guide.at).points.reduce((length, cp) => length + cubicLength(cp), 0);
    },
  };
}
