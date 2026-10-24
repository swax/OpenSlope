import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { add, cross, dot, len, mul, norm, sub } from '../math/vec';
import type { SurfaceAxis } from '../math/spline-surface';
import type { Patch } from './loft-surface';
import { curveAt, guideCharts, readGuideCurves, sectionCurve, addGuide, type GuideCurve } from './surface-guides';
import { rebuildSurface, type SurfaceResult } from './surface-object';

export type SurfaceCurveClipboard = { kind: 'slopesmith-control-curve'; curve: GuideCurve };

export function copySurfaceCurve(doc: QuadMeshDoc, surface: SurfaceObject, curve: number): SurfaceCurveClipboard {
  const source = readGuideCurves(doc, surface)[curve];
  if (!source) throw new Error('Select a control curve to copy.');
  return { kind: 'slopesmith-control-curve', curve: structuredClone(source) };
}

function frame(a: V3, b: V3) {
  const chord = sub(b, a),
    length = len(chord);
  if (length < 1e-7) throw new Error('The curve endpoints must be distinct.');
  const x = norm(chord),
    up: V3 = Math.abs(x[1]) < 0.95 ? [0, 1, 0] : [0, 0, 1];
  const z = norm(cross(x, up)),
    y = cross(z, x);
  return { x, y, z, length };
}

/** Keep profile relief in metres while fitting its chord to the target boundary endpoints. */
export function positionedSurfaceCurve(
  clipboard: SurfaceCurveClipboard,
  charts: Patch[],
  axis: SurfaceAxis,
  at: number,
): GuideCurve {
  const source = clipboard.curve,
    section = sectionCurve(charts, axis, at);
  const a = curveAt(source, 0),
    b = curveAt(source, 1),
    c = curveAt(section, 0),
    d = curveAt(section, 1);
  const from = frame(a, b),
    to = frame(c, d);
  return {
    axis,
    at,
    knots: [...source.knots],
    points: source.points.map(span =>
      span.map(p => {
        const offset = sub(p, a);
        return add(
          c,
          add(
            mul(to.x, (dot(offset, from.x) * to.length) / from.length),
            add(mul(to.y, dot(offset, from.y)), mul(to.z, dot(offset, from.z))),
          ),
        );
      }),
    ),
  };
}

export function pasteSurfaceCurve(
  doc: QuadMeshDoc,
  surface: SurfaceObject,
  clipboard: SurfaceCurveClipboard,
  axis: SurfaceAxis,
  at: number,
): SurfaceResult {
  try {
    const charts = guideCharts(doc, surface),
      curve = positionedSurfaceCurve(clipboard, charts, axis, at);
    const added = addGuide(doc, surface, axis, 0, at, charts, curve);
    return rebuildSurface(added.doc, added.surface);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
