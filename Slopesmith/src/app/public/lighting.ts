import { applyReferenceLightmaps, type RawPatch, type ReferenceMesh } from '../../core/reference/terrain';
import { decodeLightmapTexel } from '../../core/lighting/bake';
import type { LightmapSet } from '../../core/lighting/lightmap';

/** Match the editor's extracted-lightmap decode while sourcing PNGs from local Blobs or original map files. */
export async function lightPublicReference(mesh: ReferenceMesh, patches: RawPatch[], url: (id: number) => string): Promise<void> {
  const maps: LightmapSet = new Map();
  for (const id of new Set(patches.flatMap(patch => patch.LightmapID === undefined ? [] : [patch.LightmapID]))) {
    const response = await fetch(url(id));
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) continue;
    const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(image, 0, 0); image.close();
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const a = new Float32Array(canvas.width * canvas.height), rgb = new Float32Array(a.length * 3);
    for (let i = 0; i < a.length; i++) {
      a[i] = data[i * 4 + 3] / 255;
      rgb.set(decodeLightmapTexel(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], data[i * 4 + 3]), i * 3);
    }
    maps.set(id, { a, rgb });
  }
  applyReferenceLightmaps(mesh, patches, maps);
}
