import type { Rgba } from '../paint/ground-textures';
import {
  groundTexelDir, panelRect, panoramaX, type SkyGeometry, type SkyRing, type PanelRect,
} from './ring';

/**
 * Cutting a sky between its two forms: a PANORAMA (one wide image of the whole horizon band — what a user
 * loads, edits and previews) and the texture pages the measured ring actually samples (what ships in `_sky.ssh`).
 *
 * The cut has to be made against the TARGET level's real ring, not an idealised one: its authored panel spans
 * are not assumed to be uniform. `panelRect` reads them from generated metadata; these functions just resample.
 */

/** Bilinear sample of a panorama: WRAP in x (it is a 360° loop, so the left and right edges are neighbours)
 *  and CLAMP in y (the top edge is the open sky and the bottom is the ground — wrapping bleeds one into the
 *  other). This is the one place a plain `sampleRgba` is wrong. */
function samplePanorama(img: Rgba, u: number, v: number): [number, number, number] {
  const { w, h, data } = img;
  const fx = (((u % 1) + 1) % 1) * w - 0.5;
  const fy = Math.min(Math.max(v, 0), 1) * h - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const wx = (x: number) => ((x % w) + w) % w;
  const cy = (y: number) => Math.min(h - 1, Math.max(0, y));
  const xa = wx(x0), xb = wx(x0 + 1), ya = cy(y0), yb = cy(y0 + 1);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p00 = data[(ya * w + xa) * 4 + c], p10 = data[(ya * w + xb) * 4 + c];
    const p01 = data[(yb * w + xa) * 4 + c], p11 = data[(yb * w + xb) * 4 + c];
    out[c] = (p00 * (1 - tx) + p10 * tx) * (1 - ty) + (p01 * (1 - tx) + p11 * tx) * ty;
  }
  return out;
}

const blank = (w: number, h: number): Rgba => ({ w, h, data: new Uint8Array(w * h * 4) });

function put(img: Rgba, x: number, y: number, rgb: [number, number, number]) {
  const d = (y * img.w + x) * 4;
  img.data[d] = rgb[0]; img.data[d + 1] = rgb[1]; img.data[d + 2] = rgb[2]; img.data[d + 3] = 255;
}

/** Cut one wall panel's tile out of a panorama. The tile's V runs UP while an image's rows run DOWN, so
 *  the rect is read bottom-row-first. */
export function sliceWallTile(pano: Rgba, rect: PanelRect, w: number, h: number): Rgba {
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const v = rect.y0 + ((y + 0.5) / h) * (rect.y1 - rect.y0);
    for (let x = 0; x < w; x++) {
      const u = rect.x0 + ((x + 0.5) / w) * (rect.x1 - rect.x0);
      put(out, x, y, samplePanorama(pano, u, v));
    }
  }
  return out;
}

/**
 * Derive the ground disc from a panorama. The disc is a radial projection of the terrain below the horizon
 * (using the UV radius measured into the ring sidecar), so its rim must continue the panorama's bottom row at the
 * matching azimuth or the horizon tears. Inward from the rim the ground has no source data — the panorama
 * stops at the ring's bottom edge — so it fades to the ring's mean ground colour, which reads as haze toward the
 * nadir. Good enough for a sky nobody looks straight down through; a level's OWN disc (an aerial photo of
 * the town below, on MERQUER) ships verbatim instead of coming through here.
 */
export function deriveGroundTile(pano: Rgba, size: number, geometry: SkyGeometry): Rgba {
  return groundFromPanorama(pano, size, geometry);
}

/** A radial ground disc read off the panorama's bottom edge. The rim continues that edge at the matching
 *  azimuth and falls off linearly toward the edge's mean colour at the nadir. */
function groundFromPanorama(pano: Rgba, size: number, geometry: SkyGeometry): Rgba {
  const out = blank(size, size);
  const mean: [number, number, number] = [0, 0, 0];
  const cols = Math.max(1, pano.w);
  for (let x = 0; x < cols; x++) {
    const s = samplePanorama(pano, (x + 0.5) / cols, 1);
    mean[0] += s[0] / cols; mean[1] += s[1] / cols; mean[2] += s[2] / cols;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const { az, r } = groundTexelDir((x + 0.5) / size, (y + 0.5) / size, geometry);
      if (r > 1) { put(out, x, y, mean); continue; } // outside the disc: never sampled, but keep it seamless
      const rim = samplePanorama(pano, panoramaX(az), 1);
      const w = Math.min(1, r); // 1 at the rim (continue the panorama exactly), 0 at the nadir
      put(out, x, y, [
        mean[0] + (rim[0] - mean[0]) * w,
        mean[1] + (rim[1] - mean[1]) * w,
        mean[2] + (rim[2] - mean[2]) * w,
      ]);
    }
  }
  return out;
}

/** Cut a whole ring's worth of tiles out of a panorama: every measured wall panel at its real span, and a
 *  derived ground disc. Slot order, so slot i is `_sky.ssh` page i. */
export function sliceRing(pano: Rgba, ring: SkyRing): Rgba[] {
  const tiles: Rgba[] = [];
  for (const p of ring.panels) {
    const size = ring.tiles[p.index];
    if (!size) throw new Error(`sky ring has no tile metadata for panel ${p.index}`);
    tiles[p.index] = sliceWallTile(pano, panelRect(p, ring), size.w, size.h);
  }
  const groundSize = ring.tiles[ring.groundIndex];
  if (!groundSize) throw new Error(`sky ring has no tile metadata for ground ${ring.groundIndex}`);
  tiles[ring.groundIndex] = deriveGroundTile(pano, groundSize.w, ring);
  return tiles;
}

/**
 * Stitch a ring's wall tiles back into one panorama — the inverse cut. This is what makes a shipped sky
 * previewable and editable: the Reference panel shows this image, and "use for my map" hands the same
 * pixels to the authored sky, so a round trip (download, repaint, load) lands every panel back where it
 * came from.
 */
export function stitchPanorama(tiles: (Rgba | null)[], ring: SkyRing, w: number, h: number): Rgba {
  const out = blank(w, h);
  for (const p of ring.panels) {
    const tile = tiles[p.index];
    if (!tile) continue;
    const r = panelRect(p, ring);
    const px0 = Math.round(r.x0 * w), px1 = Math.round(r.x1 * w);
    const py0 = Math.round(r.y0 * h), py1 = Math.round(r.y1 * h);
    for (let y = py0; y < py1; y++) {
      const v = (y + 0.5 - py0) / Math.max(1, py1 - py0);   // 0 at the panel's top row
      for (let x = px0; x < px1; x++) {
        const u = (x + 0.5 - px0) / Math.max(1, px1 - px0);
        const sx = Math.min(tile.w - 1, Math.max(0, Math.floor(u * tile.w)));
        const sy = Math.min(tile.h - 1, Math.max(0, Math.floor(v * tile.h)));
        const s = (sy * tile.w + sx) * 4;
        put(out, x, y, [tile.data[s], tile.data[s + 1], tile.data[s + 2]]);
      }
    }
  }
  return out;
}

/**
 * Remap a full 2:1 equirectangular sky (the format any panorama off the web or out of Blender comes in)
 * into the ring band. The band is NOT a plain crop: a panorama's rows are linear in cylinder height Z
 * while an equirect's are linear in elevation ANGLE, so each row is re-projected through
 * elevation = atan2(Z, R). Everything above the measured top edge in the source is discarded — the ring has no geometry
 * up there to paint it on.
 */
export function equirectToBand(equirect: Rgba, w: number, h: number, geometry: SkyGeometry): Rgba {
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const z = geometry.topZ - ((y + 0.5) / h) * (geometry.topZ - geometry.bottomZ);
    const el = Math.atan2(z, geometry.radius);          // radians, + up
    const v = 0.5 - el / Math.PI;                      // equirect row: 0 at the zenith, 1 at the nadir
    for (let x = 0; x < w; x++) {
      put(out, x, y, samplePanorama(equirect, (x + 0.5) / w, v));
    }
  }
  return out;
}

/** Fit an arbitrary image to the ring band. A ~2:1 image is treated as an equirect and re-projected;
 *  anything else is taken as already-a-band and simply resampled to size. */
export function fitToBand(img: Rgba, w: number, h: number, geometry: SkyGeometry,
  mode: 'auto' | 'band' | 'equirect' = 'auto'): Rgba {
  const equirect = mode === 'equirect' || (mode === 'auto' && Math.abs(img.w / img.h - 2) < 0.25);
  if (equirect) return equirectToBand(img, w, h, geometry);
  const out = blank(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      put(out, x, y, samplePanorama(img, (x + 0.5) / w, (y + 0.5) / h));
  return out;
}

/** The colour to fill the open top with when none is authored: the mean of the panorama's TOP row — the sky
 *  exactly where it runs out of geometry, so the fill meets the rim without a visible line. The same trick
 *  the Unity SkyboxBaker plays with its magenta sentinel, done on the source image instead of a render. */
export function deriveTopColor(pano: Rgba): [number, number, number] {
  const mean: [number, number, number] = [0, 0, 0];
  const cols = Math.max(1, pano.w);
  for (let x = 0; x < cols; x++) {
    const s = samplePanorama(pano, (x + 0.5) / cols, 0);
    mean[0] += s[0] / cols; mean[1] += s[1] / cols; mean[2] += s[2] / cols;
  }
  return mean;
}
