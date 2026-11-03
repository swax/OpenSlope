import { analyzeTexturePixels, resolvePropAlphaMode, type TextureAlphaPolicy } from '../props/texture-alpha';
import type { Rgba } from '../paint/ground-textures';

export interface ShadowMask {
  width: number;
  height: number;
  alpha: Uint8Array;
  cutoff: number;
}

/** Undefined is solid/fallback; null has no hard shadow. Static lightmaps use the material's rest frame. */
export function textureShadowMask(image: Rgba | undefined, policy: TextureAlphaPolicy): ShadowMask | null | undefined {
  const analysis = image ? analyzeTexturePixels(image.data, image.w, image.h) : undefined;
  const mode = resolvePropAlphaMode([analysis], policy);
  if (mode === 'opaque') return undefined;
  if (mode === 'glow' || analysis?.kind === 'clear' || (mode === 'blend' && analysis?.kind === 'translucent'))
    return null;
  if (!image || image.w <= 0 || image.h <= 0 || image.data.length !== image.w * image.h * 4) return undefined;
  const alpha = new Uint8Array(image.w * image.h);
  let solid = true;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = image.data[i * 4 + 3];
    solid &&= alpha[i] === 255;
  }
  return solid ? undefined : { width: image.w, height: image.h, alpha, cutoff: 128 };
}

/** Match TextureLoader's flipY, RepeatWrapping and bilinear filtering, including negative/repeated UVs. */
export function shadowMaskVisible(mask: ShadowMask, u: number, v: number): boolean {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return true;
  const { width, height, alpha } = mask;
  const x = (u - Math.floor(u)) * width - 0.5;
  const y = (1 - v - Math.floor(1 - v)) * height - 0.5;
  const ix = Math.floor(x),
    iy = Math.floor(y),
    tx = x - ix,
    ty = y - iy;
  const at = (a: number, b: number) =>
    alpha[(((b % height) + height) % height) * width + (((a % width) + width) % width)];
  const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
  const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
  return top * (1 - ty) + bottom * ty >= mask.cutoff;
}
