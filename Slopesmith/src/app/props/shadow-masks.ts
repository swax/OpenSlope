import type * as THREE from 'three';
import type { PropTextureCache } from './textures';
import { textureShadowMask, type ShadowMask } from '../../core/lighting/shadow-mask';
import type { TextureAlphaPolicy } from '../../core/props/texture-alpha';
import type { Rgba } from '../../core/paint/ground-textures';

/** Read each already-loaded texture once; image arrivals notify the existing asset watcher. No extra downloads. */
export function createPropShadowMasks(textures: Pick<PropTextureCache, 'texture'>) {
  const pending = new Set<THREE.Texture>();
  const cache = new WeakMap<
    THREE.Texture,
    {
      image: unknown;
      version: number;
      pixels?: Rgba;
      masks: Map<string, ShadowMask | null | undefined>;
    }
  >();
  const read = (level: string, file: string | null, policy: TextureAlphaPolicy): ShadowMask | null | undefined => {
    if (policy.mode === 'glow') return null;
    if (
      !file ||
      policy.mode === 'opaque' ||
      (!policy.mode && !policy.alphaPass && !policy.priority && !policy.pixelAlpha)
    )
      return undefined;
    const texture = textures.texture(level, file);
    const image = texture.image as CanvasImageSource & {
      width?: number;
      height?: number;
      naturalWidth?: number;
      naturalHeight?: number;
    };
    if (!image) {
      pending.add(texture);
      return undefined;
    }
    if (texture.userData.missingAsset) return undefined;
    let entry = cache.get(texture);
    if (!entry || entry.image !== image || entry.version !== texture.version) {
      let pixels: Rgba | undefined;
      try {
        const w = image.naturalWidth || image.width || 0,
          h = image.naturalHeight || image.height || 0;
        if (w && h) {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (context) {
            context.drawImage(image, 0, 0);
            const data = context.getImageData(0, 0, w, h).data;
            pixels = { w, h, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
          }
        }
      } catch {
        /* A missing/tainted image keeps the solid-mesh fallback. */
      }
      entry = { image, version: texture.version, pixels, masks: new Map() };
      cache.set(texture, entry);
    }
    const key = JSON.stringify([policy.mode, policy.alphaPass, policy.priority, policy.pixelAlpha]);
    if (!entry.masks.has(key)) entry.masks.set(key, textureShadowMask(entry.pixels, policy));
    return entry.masks.get(key);
  };
  return {
    read,
    begin() {
      pending.clear();
    },
    get ready() {
      return [...pending].every(texture => !!texture.image);
    },
  };
}
