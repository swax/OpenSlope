/**
 * Terrain lighting study: read the baked SSX lightmap as ground truth, then recover the directional
 * sun that best explains it - so we can light our own authored maps the same way and validate the
 * model against the real level.
 *
 * The lightmap stores per-texel light INTENSITY A_S in its alpha channel (the colour C_S in RGB is
 * base-entangled and not separable - see the Trailmap research notes). So everything here is intensity-only: a neutral
 * sun direction + ambient floor, which is the geometric "how is it lit" we want for authoring; the
 * light COLOUR is an authored choice on top.
 */

import { lerpScalar as lerp } from '../math/scalar';

/** Lightmap tile size: each level lightmap is 128x128, addressed by a per-patch sub-rect. */
export const LIGHTMAP_W = 128;

/** One decoded lightmap keyed by LightmapID: A_S intensity (128x128 scalar) for the geometric fit, plus
 *  the COLOURED multiply (128x128 x3 interleaved RGB) reconstructed from the GS residual C_S - the warm
 *  sun / cool-or-pink shadow colour the level actually baked. */
export interface LightmapTexels { a: Float32Array; rgb: Float32Array; }
export type LightmapSet = Map<number, LightmapTexels>;

/**
 * Sample a patch's lightmap intensity, mirroring snowknife's SampleTile: the patch owns the sub-rect
 * (lx,ly,lw,lh) of the 128x128 map (fractions), bilinear across (u,v) in 0..1. Out-of-range texels
 * clamp to the map edge so an edge patch never reads past the buffer.
 */
export function sampleTile(map: Float32Array, lx: number, ly: number, lw: number, lh: number, u: number, v: number): number {
  const W = LIGHTMAP_W;
  const bx = Math.round(lx * W), by = Math.round(ly * W);
  const tw = Math.max(1, Math.round(lw * W) - 1), th = Math.max(1, Math.round(lh * W) - 1);
  const fx = u * tw, fy = v * th;
  const ix = Math.min(Math.max(Math.floor(fx), 0), tw - 1), iy = Math.min(Math.max(Math.floor(fy), 0), th - 1);
  const dx = fx - ix, dy = fy - iy;
  const at = (x: number, y: number) => map[Math.min(Math.max(y, 0), W - 1) * W + Math.min(Math.max(x, 0), W - 1)];
  const a = at(bx + ix, by + iy), b = at(bx + ix + 1, by + iy);
  const c = at(bx + ix, by + iy + 1), e = at(bx + ix + 1, by + iy + 1);
  return lerp(lerp(a, b, dx), lerp(c, e, dx), dy);
}

/** Bilinear-sample an interleaved RGB tile (128x128 x3), same sub-rect addressing as sampleTile. */
export function sampleTileRGB(rgb: Float32Array, lx: number, ly: number, lw: number, lh: number, u: number, v: number): [number, number, number] {
  const W = LIGHTMAP_W;
  const bx = Math.round(lx * W), by = Math.round(ly * W);
  const tw = Math.max(1, Math.round(lw * W) - 1), th = Math.max(1, Math.round(lh * W) - 1);
  const fx = u * tw, fy = v * th;
  const ix = Math.min(Math.max(Math.floor(fx), 0), tw - 1), iy = Math.min(Math.max(Math.floor(fy), 0), th - 1);
  const dx = fx - ix, dy = fy - iy;
  const at = (x: number, y: number, c: number) => rgb[(Math.min(Math.max(y, 0), W - 1) * W + Math.min(Math.max(x, 0), W - 1)) * 3 + c];
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = at(bx + ix, by + iy, c), b = at(bx + ix + 1, by + iy, c), cc = at(bx + ix, by + iy + 1, c), e = at(bx + ix + 1, by + iy + 1, c);
    out[c] = lerp(lerp(a, b, dx), lerp(cc, e, dx), dy);
  }
  return out;
}

/** Remap a patch (u,v) to the lightmap's own orientation. SSX terrain uses mode 6 (transpose). */
export function remapLightmapUv(u: number, v: number, mode = 6): [number, number] {
  switch (((mode % 8) + 8) % 8) {
    case 1: return [v, 1 - u];
    case 2: return [1 - u, 1 - v];
    case 3: return [1 - v, u];
    case 4: return [1 - u, v];
    case 5: return [u, 1 - v];
    case 6: return [v, u];
    case 7: return [1 - v, 1 - u];
    default: return [u, v];
  }
}

/** The recovered directional sun + how well it explains the baked lightmap. */
export interface SunFit {
  /** Editor-space unit direction TOWARD the light. */
  dir: [number, number, number];
  /** Intensity floor (the ambient term a in intensity = a + d*max(0, N.L)). */
  ambient: number;
  /** Sun strength (the slope d). */
  diffuse: number;
  /** Coefficient of determination, 0..1: how much of the lightmap a single sun + ambient explains. */
  r2: number;
  /** RMS of (model - actual) over all vertices, in intensity units. */
  rms: number;
  /** Compass bearing of the light in the editor XZ plane (deg, 0 = +X, CCW toward +Z). */
  azimuthDeg: number;
  /** Angle of the light above the horizon (deg). */
  elevationDeg: number;
  /** Vertices used in the fit. */
  samples: number;
}

/** Fibonacci-sphere unit directions (count x 3), evenly spread over the whole sphere. */
function candidateDirs(count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out[i * 3] = Math.cos(th) * r;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = Math.sin(th) * r;
  }
  return out;
}

/** Least-squares (ambient, diffuse) for a fixed light dir over a strided vertex set; returns fit stats. */
function regress(
  normals: Float32Array, intensity: Float32Array, lx: number, ly: number, lz: number,
  stride: number, sy: number, syy: number, count: number, ssTot: number,
): { a: number; b: number; r2: number } {
  let sx = 0, sxx = 0, sxy = 0;
  for (let i = 0, k = 0; k < count; i += stride * 3, k++) {
    const d = normals[i] * lx + normals[i + 1] * ly + normals[i + 2] * lz;
    const x = d > 0 ? d : 0;
    sx += x; sxx += x * x; sxy += x * intensity[(i / 3) | 0];
  }
  const denom = count * sxx - sx * sx;
  let b = denom > 1e-9 ? (count * sxy - sx * sy) / denom : 0;
  if (b < 0) b = 0; // a sun can only add light
  const a = (sy - b * sx) / count;
  const sse = syy - 2 * a * sy - 2 * b * sxy + a * a * count + 2 * a * b * sx + b * b * sxx;
  const r2 = ssTot > 1e-9 ? 1 - sse / ssTot : 1;
  return { a, b, r2 };
}

/**
 * Recover the directional sun (+ ambient) that best reproduces the baked lightmap: sweep a dense set
 * of candidate directions, fit (ambient, diffuse) by least squares at each, and keep the best R2. A
 * high R2 means the level is essentially a clean directional sun; a low one means shadow / AO / fill
 * dominate (which is exactly what the residual view then shows). The dir is reported in editor space.
 */
export function fitSun(normals: Float32Array, intensity: Float32Array, fixedDir?: [number, number, number]): SunFit {
  const n = intensity.length;
  const stride = Math.max(1, Math.floor(n / 8000)); // cap the sweep cost; refine on all verts at the end
  let count = 0, sy = 0, syy = 0;
  for (let i = 0; i < n; i += stride) { count++; sy += intensity[i]; syy += intensity[i] * intensity[i]; }
  const mean = sy / Math.max(1, count);
  const ssTot = syy - count * mean * mean;

  let best = { a: mean, b: 0, r2: 0, lx: 0, ly: 1, lz: 0 };
  if (fixedDir) {
    // PINNED mode: the level's own light record gives the true direction, so hold el/az and least-squares
    // only the intensity (+ ambient) below. Fewer free params -> a better-conditioned fit (skips the sweep).
    const fl = Math.hypot(fixedDir[0], fixedDir[1], fixedDir[2]) || 1;
    best.lx = fixedDir[0] / fl; best.ly = fixedDir[1] / fl; best.lz = fixedDir[2] / fl;
  } else {
    const dirs = candidateDirs(1500);
    for (let d = 0; d < dirs.length; d += 3) {
      const ly = dirs[d + 1];
      if (ly < -0.25) continue; // ignore suns from well below the horizon
      const lx = dirs[d], lz = dirs[d + 2];
      const { a, b, r2 } = regress(normals, intensity, lx, ly, lz, stride, sy, syy, count, ssTot);
      if (r2 > best.r2) best = { a, b, r2, lx, ly, lz };
    }

    // local refine: hill-climb the direction on a shrinking ring around the grid winner, so the reported
    // sun (and its ambient / diffuse split) settles to the true direction instead of the nearest grid node.
    for (let step = 0.06; step > 0.002; step *= 0.5) {
      const bx = best.lx, by = best.ly, bz = best.lz;
      const up = Math.abs(by) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let tx = up[1] * bz - up[2] * by, ty = up[2] * bx - up[0] * bz, tz = up[0] * by - up[1] * bx; // up x b
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const ux = by * tz - bz * ty, uy = bz * tx - bx * tz, uz = bx * ty - by * tx;                // b x t
      for (let k = 0; k < 8; k++) {
        const ang = (k / 8) * Math.PI * 2, ox = Math.cos(ang) * step, oy = Math.sin(ang) * step;
        let cx = bx + tx * ox + ux * oy, cy = by + ty * ox + uy * oy, cz = bz + tz * ox + uz * oy;
        const cl = Math.hypot(cx, cy, cz) || 1; cx /= cl; cy /= cl; cz /= cl;
        const { a, b, r2 } = regress(normals, intensity, cx, cy, cz, stride, sy, syy, count, ssTot);
        if (r2 > best.r2) best = { a, b, r2, lx: cx, ly: cy, lz: cz };
      }
    }
  }

  // recompute (ambient, diffuse) + R2 on every vertex for the winning direction
  let fsx = 0, fsxx = 0, fsxy = 0, fsy = 0, fsyy = 0;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const dot = normals[j] * best.lx + normals[j + 1] * best.ly + normals[j + 2] * best.lz;
    const x = dot > 0 ? dot : 0, y = intensity[i];
    fsx += x; fsxx += x * x; fsxy += x * y; fsy += y; fsyy += y * y;
  }
  const fdenom = n * fsxx - fsx * fsx;
  let b = fdenom > 1e-9 ? (n * fsxy - fsx * fsy) / fdenom : 0;
  if (b < 0) b = 0;
  const a = (fsy - b * fsx) / n;
  const fmean = fsy / n, fssTot = fsyy - n * fmean * fmean;
  const sse = fsyy - 2 * a * fsy - 2 * b * fsxy + a * a * n + 2 * a * b * fsx + b * b * fsxx;
  const r2 = fssTot > 1e-9 ? 1 - sse / fssTot : 1;
  const rms = Math.sqrt(Math.max(0, sse) / n);

  return {
    dir: [best.lx, best.ly, best.lz], ambient: a, diffuse: b, r2, rms,
    azimuthDeg: (Math.atan2(best.lz, best.lx) * 180) / Math.PI,
    elevationDeg: (Math.asin(Math.max(-1, Math.min(1, best.ly))) * 180) / Math.PI,
    samples: n,
  };
}

/** Editor-space unit direction TOWARD a sun at (elevation, azimuth) degrees — the space fitSun reports and
 *  the viewport lights by (Y up). Matches main.ts applySunLight, so a record's el/az can pin the fit. */
export function sunDirFromElAz(elDeg: number, azDeg: number): [number, number, number] {
  const e = (elDeg * Math.PI) / 180, a = (azDeg * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}

/** How a level's own light RECORD agrees with the lightmap FIT, and the bake terms that reconcile them.
 *  `recDir` (the record direction) and `fitDir` (the free fit direction) are editor-space toward-light unit
 *  vectors; `recordIntensity` is the record's peak sun strength (HDR, exported as-is); `fitIntensity` /
 *  `fitAmbient` are the fit's diffuse + ambient pinned to the record direction (the level's own lightmap
 *  exposure). bakeExposure scales the HDR sun down to that lightmap exposure, and fitAmbient is the lightmap
 *  ambient floor — both for the BAKE only (the export keeps the raw record sun + ambient). */
export interface SunRecordCheck { dirErrorDeg: number; fitIntensity: number; fitAmbient: number; bakeExposure: number; }
export function checkRecordSun(
  recDir: [number, number, number], fitDir: [number, number, number],
  recordIntensity: number, fitIntensity: number, fitAmbient: number,
): SunRecordCheck {
  const dot = Math.max(-1, Math.min(1, recDir[0] * fitDir[0] + recDir[1] * fitDir[1] + recDir[2] * fitDir[2]));
  return {
    dirErrorDeg: (Math.acos(dot) * 180) / Math.PI,
    fitIntensity,
    fitAmbient,
    bakeExposure: recordIntensity > 1e-6 ? fitIntensity / recordIntensity : 1,
  };
}

/**
 * A lighting model on the reference: a fixed sun, fit as a sum of basis terms. `ambient` + `sun`·N.L is
 * the base; `shadow`/`ao` (>=0) are how strongly the baked cast-shadow / AO DARKEN that base. Because
 * the occlusion terms are additive (not a multiply), the least-squares fit can down-weight a term that
 * doesn't match the lightmap, so adding shadow/AO never lowers R2 below the base sun.
 */
export interface ShadeModel {
  dir: [number, number, number];
  ambient: number; // constant floor
  sun: number;     // directional term, x max(0, N.L)
  shadow: number;  // >=0: darkening x (1 - shadow) x max(0, N.L)
  ao: number;      // >=0: darkening x (1 - ao)
  r2: number;
  rms: number;
}

/** Per-vertex grey RGB from any 0..1 intensity array (the lightmap ground truth or a model). */
export function intensityColors(intensity: Float32Array, scale = 1): Float32Array {
  const out = new Float32Array(intensity.length * 3);
  for (let i = 0; i < intensity.length; i++) {
    const g = Math.min(1, Math.max(0, intensity[i] * scale));
    out[i * 3] = g; out[i * 3 + 1] = g; out[i * 3 + 2] = g;
  }
  return out;
}

/**
 * Per-vertex model intensity = ambient + sun*max(0,N.L) - shadow*(1-shadow_v)*max(0,N.L) - ao*(1-ao_v).
 * Pass `shadow`/`ao` (per-vertex 0..1 from the occlusion bake) to include those darkening terms.
 */
export function computeModel(
  normals: Float32Array, dir: [number, number, number], m: ShadeModel,
  shadow?: Float32Array, ao?: Float32Array,
): Float32Array {
  const n = normals.length / 3;
  const out = new Float32Array(n);
  const [lx, ly, lz] = dir;
  for (let v = 0; v < n; v++) {
    const j = v * 3;
    const ndl = Math.max(0, normals[j] * lx + normals[j + 1] * ly + normals[j + 2] * lz);
    let val = m.ambient + m.sun * ndl;
    if (shadow) val -= m.shadow * (1 - shadow[v]) * ndl;
    if (ao) val -= m.ao * (1 - ao[v]);
    out[v] = val < 0 ? 0 : val;
  }
  return out;
}

/**
 * Coloured authored model (for maps with no lightmap): sky (ambient) colour fills the surface, the sun
 * colour adds where lit (max(0,N·L)), and the baked occlusion darkens each - cast shadow attenuates the
 * sun, AO attenuates the sky. Returns per-vertex RGB (0..1), so shadows take the sky colour (blue / pink).
 */
export function computeModelColored(
  normals: Float32Array, dir: [number, number, number],
  p: { ambient: number; sun: number; shadow: number; ao: number; sunTint: [number, number, number]; skyTint: [number, number, number] },
  shadow?: Float32Array, ao?: Float32Array,
): Float32Array {
  const n = normals.length / 3;
  const out = new Float32Array(n * 3);
  const [lx, ly, lz] = dir;
  for (let v = 0; v < n; v++) {
    const j = v * 3;
    const ndl = Math.max(0, normals[j] * lx + normals[j + 1] * ly + normals[j + 2] * lz);
    const skyF = p.ambient * (ao ? 1 - p.ao * (1 - ao[v]) : 1);
    const sunF = p.sun * ndl * (shadow ? 1 - p.shadow * (1 - shadow[v]) : 1);
    for (let c = 0; c < 3; c++) out[j + c] = Math.min(1, Math.max(0, skyF * p.skyTint[c] + sunF * p.sunTint[c]));
  }
  return out;
}

/** Solve A w = b for a small dense system (partial-pivot Gaussian elimination); singular rows -> 0. */
function solveLinear(A: Float64Array[], b: Float64Array): Float64Array {
  const k = b.length;
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) continue;
    [A[col], A[piv]] = [A[piv], A[col]];
    const t = b[col]; b[col] = b[piv]; b[piv] = t;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let c = col; c < k; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const w = new Float64Array(k);
  for (let i = 0; i < k; i++) w[i] = Math.abs(A[i][i]) > 1e-12 ? b[i] / A[i][i] : 0;
  return w;
}

/**
 * Re-fit the model for a FIXED sun direction with the baked shadow / AO folded in as ADDITIVE darkening
 * terms, by non-negative least squares: intensity ~ ambient + sun*N.L - shadow*(1-shadow)*N.L
 * - ao*(1-ao), with the two darkening weights constrained >= 0 (occlusion can only remove light). The
 * base sun terms are always present, so R2 is monotonic: adding shadow/AO can only raise it (a term that
 * doesn't fit the lightmap gets weight ~0). With no occlusion this is the plain flat-sun fit.
 */
export function refitWithOcclusion(
  normals: Float32Array, intensity: Float32Array, dir: [number, number, number],
  shadow?: Float32Array, ao?: Float32Array,
): ShadeModel {
  const n = intensity.length;
  const [lx, ly, lz] = dir;
  // basis ids: 0 = 1, 1 = N.L, 2 = -(1-shadow)*N.L, 3 = -(1-ao). 2/3 only when their map is supplied.
  const ids = [0, 1];
  if (shadow) ids.push(2);
  if (ao) ids.push(3);
  const k = ids.length;
  const G = Array.from({ length: k }, () => new Float64Array(k)); // Gram matrix of the active basis
  const rhs = new Float64Array(k);
  const b = [0, 0, 0, 0];
  let sy = 0, syy = 0;
  for (let v = 0; v < n; v++) {
    const j = v * 3;
    const ndl = Math.max(0, normals[j] * lx + normals[j + 1] * ly + normals[j + 2] * lz);
    b[0] = 1; b[1] = ndl;
    b[2] = shadow ? -(1 - shadow[v]) * ndl : 0;
    b[3] = ao ? -(1 - ao[v]) : 0;
    const y = intensity[v]; sy += y; syy += y * y;
    for (let a = 0; a < k; a++) {
      const ba = b[ids[a]];
      rhs[a] += ba * y;
      for (let c = a; c < k; c++) G[a][c] += ba * b[ids[c]];
    }
  }
  for (let a = 0; a < k; a++) for (let c = 0; c < a; c++) G[a][c] = G[c][a];

  // active-set NNLS: solve, drop the most-negative constrained (id>=2) weight, repeat until all >= 0.
  let active = ids.map((_, i) => i);
  let w = new Float64Array(k);
  for (; ;) {
    const m = active.length;
    const A = Array.from({ length: m }, (_, a) => { const row = new Float64Array(m); for (let c = 0; c < m; c++) row[c] = G[active[a]][active[c]]; return row; });
    const r = new Float64Array(m); for (let a = 0; a < m; a++) r[a] = rhs[active[a]];
    const sol = solveLinear(A, r);
    w = new Float64Array(k);
    for (let a = 0; a < m; a++) w[active[a]] = sol[a];
    let worst = -1, worstVal = 0;
    for (let a = 0; a < k; a++) if (ids[a] >= 2 && w[a] < worstVal) { worstVal = w[a]; worst = a; }
    if (worst < 0) break;
    active = active.filter(p => p !== worst);
  }
  const wOf = (id: number) => { const a = ids.indexOf(id); return a < 0 ? 0 : w[a]; };

  let sse = syy;
  for (let a = 0; a < k; a++) { sse -= 2 * w[a] * rhs[a]; for (let c = 0; c < k; c++) sse += w[a] * w[c] * G[a][c]; }
  const mean = sy / n, ssTot = syy - n * mean * mean;
  return {
    dir, ambient: wOf(0), sun: wOf(1), shadow: wOf(2), ao: wOf(3),
    r2: ssTot > 1e-9 ? 1 - sse / ssTot : 1, rms: Math.sqrt(Math.max(0, sse) / n),
  };
}

/**
 * Per-vertex residual heatmap (model - actual): white = match, red = model too bright (a baked shadow /
 * occlusion the model misses), blue = model too dark (baked bounce / fill). `gain` scales intensity-unit
 * error to colour saturation.
 */
export function residualColors(model: Float32Array, actual: Float32Array, gain = 4): Float32Array {
  const n = model.length;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const t = Math.min(1, Math.max(-1, (model[i] - actual[i]) * gain));
    if (t >= 0) { out[j] = 1; out[j + 1] = 1 - t; out[j + 2] = 1 - t; } // model brighter -> red
    else { out[j] = 1 + t; out[j + 1] = 1 + t; out[j + 2] = 1; }        // model darker  -> blue
  }
  return out;
}
