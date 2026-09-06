/**
 * Procedural seamless ground textures for authored levels - no game assets involved.
 * Pure RGBA generation (browser + node); PNG encoding happens server-side (server/routes/png.ts).
 */
export interface Rgba {
  w: number;
  h: number;
  data: Uint8Array;
}

/** Deterministic lattice value noise, tileable because the lattice wraps. */
function makeNoise(seed: number, cells: number) {
  const lattice = new Float32Array(cells * cells);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  return (x: number, y: number) => {
    // x, y in [0,1)
    const fx = x * cells, fy = y * cells;
    const x0 = Math.floor(fx) % cells, y0 = Math.floor(fy) % cells;
    const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = lattice[y0 * cells + x0], b = lattice[y0 * cells + x1];
    const c = lattice[y1 * cells + x0], d = lattice[y1 * cells + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
}

function paint(
  base: [number, number, number],
  tint: [number, number, number],
  opts: { seed: number; octaves?: number; streakX?: number },
): Rgba {
  const W = 256;
  const data = new Uint8Array(W * W * 4);
  const layers = [makeNoise(opts.seed, 8), makeNoise(opts.seed * 7 + 1, 24), makeNoise(opts.seed * 31 + 5, 64)];
  const octaves = opts.octaves ?? 3;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / W;
      let n = 0, amp = 0.55, tot = 0;
      for (let o = 0; o < octaves; o++) {
        // streakX stretches noise along x for directional surfaces like ice
        n += layers[o](((u * (opts.streakX ?? 1)) % 1 + 1) % 1, v) * amp;
        tot += amp;
        amp *= 0.5;
      }
      n /= tot;
      const i = (y * W + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round((base[0] + (tint[0] - base[0]) * n) * 255)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((base[1] + (tint[1] - base[1]) * n) * 255)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((base[2] + (tint[2] - base[2]) * n) * 255)));
      data[i + 3] = 255;
    }
  }
  return { w: W, h: W, data };
}

/**
 * Bilinear-sample an RGBA tile at (u, v), tiling: u/v wrap into [0,1) so a patch UV that spans several
 * texture repeats reads the seamless tile. Returns gamma-space (sRGB-byte) RGB in 0..1 — the diffuse C_D
 * the lightmap encode folds in (ground-textures.ts pixels are already the gamma-space base the GS blend uses).
 */
export function sampleRgba(tex: Rgba, u: number, v: number): [number, number, number] {
  const { w, h, data } = tex;
  const wrap = (t: number, n: number) => { const m = t - Math.floor(t); return m * n; }; // [0,1) -> [0,n)
  const fx = wrap(u, w) - 0.5, fy = wrap(v, h) - 0.5; // -0.5 centres the bilinear kernel on texel centres
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const ix = (x: number) => ((x % w) + w) % w, iy = (y: number) => ((y % h) + h) % h;
  const x1 = ix(x0 + 1), y1 = iy(y0 + 1), cx0 = ix(x0), cy0 = iy(y0);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = data[(cy0 * w + cx0) * 4 + c], b = data[(cy0 * w + x1) * 4 + c];
    const d = data[(y1 * w + cx0) * 4 + c], e = data[(y1 * w + x1) * 4 + c];
    out[c] = ((a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty) / 255;
  }
  return out;
}

export function generateTexture(name: string): Rgba {
  switch (name) {
    case 'snow.png':
      return paint([0.93, 0.95, 0.99], [0.8, 0.85, 0.95], { seed: 11 });
    case 'powder.png':
      return paint([0.97, 0.98, 1.0], [0.86, 0.9, 0.99], { seed: 23 });
    case 'ice.png':
      return paint([0.55, 0.75, 0.92], [0.8, 0.92, 1.0], { seed: 37, streakX: 4 });
    case 'rock.png':
      return paint([0.42, 0.38, 0.34], [0.62, 0.58, 0.52], { seed: 51, octaves: 3 });
    case 'offtrack.png':
      return paint([0.7, 0.73, 0.78], [0.55, 0.58, 0.64], { seed: 67 });
    case 'oob.png':
      return paint([0.85, 0.55, 0.5], [0.7, 0.4, 0.38], { seed: 83 });
    default:
      return paint([1, 0, 1], [0.5, 0, 0.5], { seed: 1 }); // loud magenta = unmapped name
  }
}
