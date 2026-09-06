import type { PolygonMesh } from './obj';

/** Contour flow, stages 1-2 (RASTER + GRADE): the height raster, its box blur, its chamfer clearance
 *  field, and the bilinear sampler every later stage reads them through. See ./contour.ts. */

// ---- height raster + fields ------------------------------------------------------------------------------

export interface Raster {
  x0: number;
  z0: number;
  step: number;
  width: number;   // nodes along +X
  depth: number;   // nodes along +Z
  /** Graded height per node; NaN where the surface has no coverage. */
  height: Float64Array;
  /** Chamfer distance to the nearest uncovered node, metres. */
  clearance: Float64Array;
}

export function rasterize(surface: PolygonMesh, step: number): Raster {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, , z] of surface.vertices) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) throw new Error('contour raster has no surface vertices');
  const x0 = minX - step, z0 = minZ - step;
  const width = Math.ceil((maxX - x0) / step) + 2, depth = Math.ceil((maxZ - z0) / step) + 2;
  const height = new Float64Array(width * depth).fill(Number.NaN);
  for (const face of surface.faces) {
    for (let corner = 1; corner + 1 < face.length; corner++) {
      const a = surface.vertices[face[0]], b = surface.vertices[face[corner]], c = surface.vertices[face[corner + 1]];
      const loX = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - x0) / step));
      const hiX = Math.min(width - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - x0) / step));
      const loZ = Math.max(0, Math.floor((Math.min(a[2], b[2], c[2]) - z0) / step));
      const hiZ = Math.min(depth - 1, Math.ceil((Math.max(a[2], b[2], c[2]) - z0) / step));
      const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(d) < 1e-12) continue;
      for (let iz = loZ; iz <= hiZ; iz++) for (let ix = loX; ix <= hiX; ix++) {
        const x = x0 + ix * step, z = z0 + iz * step;
        const w0 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
        const w1 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const y = w0 * a[1] + w1 * b[1] + w2 * c[1];
        const at = iz * width + ix;
        // the terrain proxy is a single sheet; where triangles overlap a node the topmost sample wins,
        // matching the editor's own top-down sampling convention
        if (Number.isNaN(height[at]) || y > height[at]) height[at] = y;
      }
    }
  }
  return { x0, z0, step, width, depth, height, clearance: new Float64Array(width * depth) };
}

/** Box-blur the covered nodes in place (mask-normalized, separable, repeated); coverage never grows. */
export function grade(raster: Raster, radiusCells: number, passes: number): void {
  const { width, depth } = raster;
  const radius = Math.max(1, Math.round(radiusCells));
  let source = raster.height;
  for (let pass = 0; pass < passes; pass++) {
    for (const horizontal of [true, false]) {
      const out = new Float64Array(source.length).fill(Number.NaN);
      for (let iz = 0; iz < depth; iz++) for (let ix = 0; ix < width; ix++) {
        const at = iz * width + ix;
        if (Number.isNaN(source[at])) continue;
        let sum = 0, count = 0;
        for (let k = -radius; k <= radius; k++) {
          const jx = horizontal ? ix + k : ix, jz = horizontal ? iz : iz + k;
          if (jx < 0 || jx >= width || jz < 0 || jz >= depth) continue;
          const value = source[jz * width + jx];
          if (Number.isNaN(value)) continue;
          sum += value; count++;
        }
        out[at] = sum / count;
      }
      source = out;
    }
  }
  raster.height.set(source);
}

/** Two-pass chamfer distance from uncovered nodes, in metres. */
export function chamfer(raster: Raster): void {
  const { width, depth, step, height, clearance } = raster;
  const big = 1e9, orth = step, diag = step * Math.SQRT2;
  for (let at = 0; at < clearance.length; at++) clearance[at] = Number.isNaN(height[at]) ? 0 : big;
  for (let iz = 0; iz < depth; iz++) for (let ix = 0; ix < width; ix++) {
    const at = iz * width + ix;
    if (!clearance[at]) continue;
    let best = clearance[at];
    if (ix > 0) best = Math.min(best, clearance[at - 1] + orth);
    if (iz > 0) best = Math.min(best, clearance[at - width] + orth);
    if (ix > 0 && iz > 0) best = Math.min(best, clearance[at - width - 1] + diag);
    if (ix < width - 1 && iz > 0) best = Math.min(best, clearance[at - width + 1] + diag);
    clearance[at] = best;
  }
  for (let iz = depth - 1; iz >= 0; iz--) for (let ix = width - 1; ix >= 0; ix--) {
    const at = iz * width + ix;
    if (!clearance[at]) continue;
    let best = clearance[at];
    if (ix < width - 1) best = Math.min(best, clearance[at + 1] + orth);
    if (iz < depth - 1) best = Math.min(best, clearance[at + width] + orth);
    if (ix < width - 1 && iz < depth - 1) best = Math.min(best, clearance[at + width + 1] + diag);
    if (ix > 0 && iz < depth - 1) best = Math.min(best, clearance[at + width - 1] + diag);
    clearance[at] = best;
  }
}

export function bilinear(raster: Raster, field: Float64Array, x: number, z: number): number {
  const fx = Math.max(0, Math.min(raster.width - 1.001, (x - raster.x0) / raster.step));
  const fz = Math.max(0, Math.min(raster.depth - 1.001, (z - raster.z0) / raster.step));
  const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
  const at = iz * raster.width + ix;
  const v00 = field[at], v10 = field[at + 1], v01 = field[at + raster.width], v11 = field[at + raster.width + 1];
  if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) {
    const covered = [v00, v10, v01, v11].filter(value => !Number.isNaN(value));
    return covered.length ? covered.reduce((a, b) => a + b) / covered.length : Number.NaN;
  }
  return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
}
