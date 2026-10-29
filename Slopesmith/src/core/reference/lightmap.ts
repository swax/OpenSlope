import { decodeLightmapTexel } from '../lighting/bake';
import type { LightmapTexels } from '../lighting/lightmap';
import type { RawPatch } from './terrain';

/** A page has one storage format, even when many patches share its atlas. */
export function referenceLightmapEncoding(patches: RawPatch[], id: number): 'gs' | 'rgb-multiply' {
  let encoding: 'gs' | 'rgb-multiply' | undefined;
  for (const patch of patches) {
    if (patch.LightmapID !== id) continue;
    const format = patch.LightmapEncoding ?? 'gs';
    if (format !== 'gs' && format !== 'rgb-multiply') throw new Error(`Unsupported lightmap encoding ${format}`);
    if (encoding && encoding !== format) throw new Error(`Mixed encodings on lightmap ${id}`);
    encoding = format;
  }
  return encoding ?? 'gs';
}

export function decodeReferenceLightmap(data: ArrayLike<number>, encoding: 'gs' | 'rgb-multiply'): LightmapTexels {
  const a = new Float32Array(data.length / 4),
    rgb = new Float32Array(a.length * 3);
  for (let i = 0; i < a.length; i++) {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2],
      alpha = data[i * 4 + 3];
    const light = encoding === 'rgb-multiply' ? [r / 255, g / 255, b / 255] : decodeLightmapTexel(r, g, b, alpha);
    rgb.set(light, i * 3);
    a[i] = encoding === 'rgb-multiply' ? light[0] * 0.2126 + light[1] * 0.7152 + light[2] * 0.0722 : alpha / 255;
  }
  return { a, rgb };
}
