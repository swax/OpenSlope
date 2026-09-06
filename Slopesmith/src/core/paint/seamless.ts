import type { Rgba } from './ground-textures';

/**
 * Make an image meet itself when tiled — the wrap-offset cross-fade behind the Generate texture dialog's
 * "Seamless wrap blend" (docs/033). Pure pixel math on an Rgba buffer so it can be tested without a DOM;
 * the canvas plumbing lives in app/paint/texture-gen.ts.
 *
 * WHY this is needed at all: no text-to-image model produces a tiling image. The prompt can ask for a flat,
 * borderless, evenly-lit frame — which is most of the battle for a material sample — but the left edge still
 * knows nothing about the right one, so painting the raw result across terrain shows a hard grid.
 *
 * HOW it works: every output pixel cross-fades the source with a copy of itself offset by half the image in
 * BOTH axes, weighted so the middle stays pure source and the very border is pure offset. That guarantees
 * tiling rather than merely improving the odds:
 *
 *   • At x = 0 the weight is 0, so the output is the offset copy — which samples source column w/2.
 *   • At x = w-1 the weight is also 0, so the output samples source column w/2 - 1.
 *
 * Those two source columns are ADJACENT in the original, so when tile edges meet, the pixels either side of
 * the join were neighbours in the source image. The same argument runs down the y axis and through the
 * corners, which is why the offset is applied in both axes at once.
 *
 * The cost is a softened band around the border, where the blend is genuinely mixing two parts of the image.
 * Organic materials (snow, rock, bark, gravel) hide this completely; regular geometric patterns do not, so
 * the dialog lets the author switch it off and see the seam for themselves.
 */

/** How far in from each edge the cross-fade reaches, as a fraction of the edge length. A quarter leaves the
 *  central half of the tile untouched — the visible difference between this and the classic whole-image
 *  version, which blends everywhere and ghosts the entire texture. */
export const SEAMLESS_BAND = 0.25;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Per-axis blend weight: 0 at either border, ramping to 1 once inside the band. */
function axisWeights(n: number): Float32Array {
  const reach = Math.max(1, n * SEAMLESS_BAND);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = smoothstep(Math.min(1, Math.min(i, n - 1 - i) / reach));
  return w;
}

/**
 * Return a new image that tiles. Images smaller than 8px on an edge are returned as-is — there is no room
 * for a band, and the blend would just average the whole thing to mud.
 */
export function makeSeamless(img: Rgba): Rgba {
  const { w, h } = img;
  if (w < 8 || h < 8) return img;
  const hx = w >> 1, hy = h >> 1;
  const wx = axisWeights(w), wy = axisWeights(h);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const oy = (y + hy) % h;
    for (let x = 0; x < w; x++) {
      const ox = (x + hx) % w;
      const k = wx[x] * wy[y];
      const a = (y * w + x) * 4, b = (oy * w + ox) * 4;
      for (let c = 0; c < 4; c++) data[a + c] = Math.round(img.data[a + c] * k + img.data[b + c] * (1 - k));
    }
  }
  return { w, h, data };
}

/**
 * How badly an image seams, as the mean absolute per-channel difference between the columns (and rows) that
 * would sit either side of a tile join. 0 is a perfect wrap. Used by the tests to assert makeSeamless
 * actually improves what it claims to; also a useful number to reason with when tuning SEAMLESS_BAND.
 */
export function seamError(img: Rgba): number {
  const { w, h, data } = img;
  let total = 0, n = 0;
  const at = (x: number, y: number, c: number) => data[(y * w + x) * 4 + c];
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 4; c++) { total += Math.abs(at(0, y, c) - at(w - 1, y, c)); n++; }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) { total += Math.abs(at(x, 0, c) - at(x, h - 1, c)); n++; }
  }
  return n ? total / n : 0;
}
