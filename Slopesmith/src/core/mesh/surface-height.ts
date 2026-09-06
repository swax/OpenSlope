import type { QuadMeshDoc, V3 } from '../doc/types';
import { patchPoint } from '../math/bezier';
import { buildQuadMesh, meshEdgeHandles, quadControlPoints } from './topology';

export type SurfaceSample = { height: number; quad: number; surface: number };

/** Topmost point and owning quad/surface on the editor quilt at an XZ coordinate, sampled at the 4×4
 * base/export-collider resolution. Returning the resolved SurfaceType alongside height prevents placement tools
 * from confusing an out-of-bounds shoulder with the intended ride surface. */
export function surfaceSampleAt(doc: QuadMeshDoc, x: number, z: number): SurfaceSample | null {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const handles = meshEdgeHandles(mesh, doc.edgeHandles);
  let best: SurfaceSample | null = null;
  const test = (a: V3, b: V3, c: V3, quad: number) => {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-12) return;
    const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) return;
    const y = w0 * a[1] + w1 * b[1] + w2 * c[1];
    if (best === null || y > best.height)
      best = { height: y, quad, surface: doc.quadPaint?.[quad] ?? doc.baseSurface };
  };
  const res = 4;
  for (let q = 0; q < doc.quads.length; q++) {
    const cp = quadControlPoints(mesh, handles, q, doc.quadTwist?.[q]);
    for (let u = 0; u < res; u++) for (let v = 0; v < res; v++) {
      const a = patchPoint(cp, u / res, v / res);
      const b = patchPoint(cp, u / res, (v + 1) / res);
      const c = patchPoint(cp, (u + 1) / res, v / res);
      const d = patchPoint(cp, (u + 1) / res, (v + 1) / res);
      test(a, d, c, q); test(a, b, d, q);
    }
  }
  return best;
}

/** Topmost height-only compatibility wrapper. */
export function surfaceHeightAt(doc: QuadMeshDoc, x: number, z: number): number | null {
  return surfaceSampleAt(doc, x, z)?.height ?? null;
}
