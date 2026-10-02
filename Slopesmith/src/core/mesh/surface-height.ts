import type { QuadMeshDoc, V3 } from '../doc/types';
import { patchPoint } from '../math/bezier';
import { buildQuadMesh, meshEdgeHandles, quadControlPoints } from './topology';

export type SurfaceSample = { height: number; quad: number; surface: number };

/** Patch evaluation resolution: the 4×4 base / export-collider tessellation. */
const RES = 4;

/** Topmost samples on the editor quilt at several XZ coordinates, over ONE mesh build and one evaluation of
 * each patch's grid. Each patch is sampled at the 4×4 base/export-collider resolution. Returning the resolved
 * SurfaceType alongside height prevents placement tools from confusing an out-of-bounds shoulder with the
 * intended ride surface. Null where no patch covers the point. */
export function surfaceSamplesAt(doc: QuadMeshDoc, points: readonly (readonly [number, number])[]): (SurfaceSample | null)[] {
  const best: (SurfaceSample | null)[] = points.map(() => null);
  if (!points.length) return best;
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const handles = meshEdgeHandles(mesh, doc.edgeHandles);
  const test = (a: V3, b: V3, c: V3, quad: number) => {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-12) return;
    const minX = Math.min(a[0], b[0], c[0]), maxX = Math.max(a[0], b[0], c[0]);
    const minZ = Math.min(a[2], b[2], c[2]), maxZ = Math.max(a[2], b[2], c[2]);
    for (let i = 0; i < points.length; i++) {
      const [x, z] = points[i];
      // A generous pre-filter only: the barycentric test below is the real (unchanged) inclusion rule.
      if (x < minX - 1e-3 || x > maxX + 1e-3 || z < minZ - 1e-3 || z > maxZ + 1e-3) continue;
      const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
      const w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const y = w0 * a[1] + w1 * b[1] + w2 * c[1];
      const held = best[i];
      if (held === null || y > held.height)
        best[i] = { height: y, quad, surface: doc.quadPaint?.[quad] ?? doc.baseSurface };
    }
  };
  const grid: V3[] = new Array((RES + 1) * (RES + 1));
  for (let q = 0; q < doc.quads.length; q++) {
    const cp = quadControlPoints(mesh, handles, q, doc.quadTwist?.[q]);
    // A Bézier patch lies inside the hull of its control points, so a patch whose control box covers none of
    // the points cannot answer any of them — skip its evaluation, which is nearly all of the cost.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of cp) {
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
    }
    if (!points.some(([x, z]) => x >= minX - 1e-3 && x <= maxX + 1e-3 && z >= minZ - 1e-3 && z <= maxZ + 1e-3)) continue;
    for (let u = 0; u <= RES; u++) for (let v = 0; v <= RES; v++) grid[u * (RES + 1) + v] = patchPoint(cp, u / RES, v / RES);
    for (let u = 0; u < RES; u++) for (let v = 0; v < RES; v++) {
      const a = grid[u * (RES + 1) + v];
      const b = grid[u * (RES + 1) + v + 1];
      const c = grid[(u + 1) * (RES + 1) + v];
      const d = grid[(u + 1) * (RES + 1) + v + 1];
      test(a, d, c, q); test(a, b, d, q);
    }
  }
  return best;
}

/** Topmost point and owning quad/surface on the editor quilt at one XZ coordinate (see surfaceSamplesAt). */
export function surfaceSampleAt(doc: QuadMeshDoc, x: number, z: number): SurfaceSample | null {
  return surfaceSamplesAt(doc, [[x, z]])[0];
}

/** Topmost height-only compatibility wrapper. */
export function surfaceHeightAt(doc: QuadMeshDoc, x: number, z: number): number | null {
  return surfaceSampleAt(doc, x, z)?.height ?? null;
}
