/**
 * Bake the occlusion a flat directional sun can't reproduce - cast shadow along the sun, and ambient
 * occlusion over the sky hemisphere - so the lighting model can close the residual against the baked
 * lightmap (and later light an authored map the same way).
 *
 * The query is a CPU depth map (shadow map): project the terrain along a direction, keep the surface
 * nearest the light per cell, and a point is lit/open along that direction if it IS that nearest
 * surface (within a bias). This is true geometry - it handles cliffs and overhangs, not just a
 * heightfield - and one rasteriser serves both the single sun direction and the AO hemisphere.
 */

/** A point is lit along `dir` if its depth reaches the column's frontmost surface within this bias
 *  (in cell widths) - absorbs rasterisation discretisation without leaking light across real ledges. */
const BIAS_CELLS = 1.5;

/** Depth map of the frontmost surface (max p.dir) per cell, looking along `dir`, + the projection. */
interface DepthMap {
  map: Float32Array; W: number; H: number;
  rx: number; ry: number; rz: number; // right axis
  ux: number; uy: number; uz: number; // up axis
  dx: number; dy: number; dz: number; // dir (depth) axis
  minPx: number; minPy: number; cell: number;
}

/** Orthonormal basis + cell metrics for projecting positions along `dir` (square cells, no distortion). */
function project(positions: Float32Array, dx: number, dy: number, dz: number, res: number): DepthMap {
  const up0x = Math.abs(dy) < 0.9 ? 0 : 1, up0y = Math.abs(dy) < 0.9 ? 1 : 0, up0z = 0;
  let rx = up0y * dz - up0z * dy, ry = up0z * dx - up0x * dz, rz = up0x * dy - up0y * dx; // up0 x dir
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = dy * rz - dz * ry, uy = dz * rx - dx * rz, uz = dx * ry - dy * rx;            // dir x right
  let minPx = Infinity, minPy = Infinity, maxPx = -Infinity, maxPy = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i] * rx + positions[i + 1] * ry + positions[i + 2] * rz;
    const py = positions[i] * ux + positions[i + 1] * uy + positions[i + 2] * uz;
    if (px < minPx) minPx = px; if (px > maxPx) maxPx = px;
    if (py < minPy) minPy = py; if (py > maxPy) maxPy = py;
  }
  const cell = Math.max(1e-3, Math.max(maxPx - minPx, maxPy - minPy) / res);
  const W = Math.max(1, Math.ceil((maxPx - minPx) / cell) + 1);
  const H = Math.max(1, Math.ceil((maxPy - minPy) / cell) + 1);
  return { map: new Float32Array(W * H).fill(-Infinity), W, H, rx, ry, rz, ux, uy, uz, dx, dy, dz, minPx, minPy, cell };
}

/** Rasterise every triangle into the depth map, keeping the max depth (frontmost toward `dir`) per cell. */
function rasterise(dm: DepthMap, positions: Float32Array, indices: Uint32Array) {
  const { map, W, H, rx, ry, rz, ux, uy, uz, dx, dy, dz, minPx, minPy, cell } = dm;
  const cx = (i: number) => (positions[i] * rx + positions[i + 1] * ry + positions[i + 2] * rz - minPx) / cell;
  const cy = (i: number) => (positions[i] * ux + positions[i + 1] * uy + positions[i + 2] * uz - minPy) / cell;
  const cd = (i: number) => positions[i] * dx + positions[i + 1] * dy + positions[i + 2] * dz;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3;
    const ax = cx(i0), ay = cy(i0), ad = cd(i0);
    const bx = cx(i1), by = cy(i1), bd = cd(i1);
    const ex = cx(i2), ey = cy(i2), ed = cd(i2);
    const den = (by - ey) * (ax - ex) + (ex - bx) * (ay - ey);
    if (Math.abs(den) < 1e-9) continue;
    const inv = 1 / den;
    let lo = Math.floor(Math.min(ax, bx, ex)), hi = Math.ceil(Math.max(ax, bx, ex));
    let lj = Math.floor(Math.min(ay, by, ey)), hj = Math.ceil(Math.max(ay, by, ey));
    lo = Math.max(0, lo); hi = Math.min(W - 1, hi); lj = Math.max(0, lj); hj = Math.min(H - 1, hj);
    for (let y = lj; y <= hj; y++) {
      const fy = y + 0.5;
      for (let x = lo; x <= hi; x++) {
        const fx = x + 0.5;
        const w0 = ((by - ey) * (fx - ex) + (ex - bx) * (fy - ey)) * inv;
        const w1 = ((ey - ay) * (fx - ex) + (ax - ex) * (fy - ey)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const d = w0 * ad + w1 * bd + w2 * ed;
        const idx = y * W + x;
        if (d > map[idx]) map[idx] = d;
      }
    }
  }
}

/** Per-vertex visibility (0..1) along `dir`: 1 where the vertex is the frontmost surface in its cell. */
function visibility(dm: DepthMap, positions: Float32Array, out: Float32Array) {
  const { map, W, H, rx, ry, rz, ux, uy, uz, dx, dy, dz, minPx, minPy, cell } = dm;
  const bias = BIAS_CELLS * cell;
  for (let v = 0, i = 0; i < positions.length; i += 3, v++) {
    const px = positions[i] * rx + positions[i + 1] * ry + positions[i + 2] * rz;
    const py = positions[i] * ux + positions[i + 1] * uy + positions[i + 2] * uz;
    const d = positions[i] * dx + positions[i + 1] * dy + positions[i + 2] * dz;
    const gx = Math.min(W - 1, Math.max(0, Math.floor((px - minPx) / cell)));
    const gy = Math.min(H - 1, Math.max(0, Math.floor((py - minPy) / cell)));
    const front = map[gy * W + gx];
    out[v] = front === -Infinity ? 1 : Math.min(1, Math.max(0, (d - (front - 2 * bias)) / bias));
  }
}

/** Cast-shadow term (0 = shadowed, 1 = lit) along the sun direction L.
 *
 *  `query` resolves the term at OTHER points (the placed props — docs/032 · lighting) against the same
 *  occluders. It is deliberately separate from `positions`: the depth map's bounds and cell size come from
 *  the occluder geometry alone, so adding query points can never coarsen the map the terrain itself is
 *  shaded with. A query point outside the occluders' footprint clamps to the edge cell, which is what an
 *  off-map prop should see. */
export function bakeSunShadow(positions: Float32Array, indices: Uint32Array, L: [number, number, number],
                              res = 1536, query?: Float32Array): Float32Array {
  const dm = project(positions, L[0], L[1], L[2], res);
  rasterise(dm, positions, indices);
  const pts = query ?? positions;
  const out = new Float32Array(pts.length / 3);
  visibility(dm, pts, out);
  return out;
}

/** Upper-hemisphere directions (Fibonacci, y >= horizon) for the AO sky samples. */
function skyDirs(count: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = (i + 0.5) / count; // 0..1, upper hemisphere only
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

/**
 * Ambient occlusion (0 = buried, 1 = open sky) per vertex: cosine-weighted average of sky visibility
 * over `dirs` hemisphere directions, each resolved with the same depth-map query.
 */
export function bakeAO(positions: Float32Array, indices: Uint32Array, normals: Float32Array, dirs = 16, res = 1024,
                       query?: { positions: Float32Array; normals: Float32Array }): Float32Array {
  const pts = query?.positions ?? positions;
  const nrm = query?.normals ?? normals;
  const n = pts.length / 3;
  const num = new Float32Array(n), den = new Float32Array(n);
  const vis = new Float32Array(n);
  for (const [dx, dy, dz] of skyDirs(dirs)) {
    // occluders define the map (see bakeSunShadow); `query` only reads it
    const dm = project(positions, dx, dy, dz, res);
    rasterise(dm, positions, indices);
    visibility(dm, pts, vis);
    for (let v = 0; v < n; v++) {
      const j = v * 3;
      const cos = nrm[j] * dx + nrm[j + 1] * dy + nrm[j + 2] * dz;
      if (cos <= 0) continue;          // direction below this vertex's horizon
      num[v] += vis[v] * cos; den[v] += cos;
    }
  }
  const ao = new Float32Array(n);
  for (let v = 0; v < n; v++) ao[v] = den[v] > 1e-6 ? num[v] / den[v] : 1;
  return ao;
}
