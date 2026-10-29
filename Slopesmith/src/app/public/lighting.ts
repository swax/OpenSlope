import { applyReferenceLightmaps, referenceLightmapIds, type RawPatch, type ReferenceMesh } from '../../core/reference/terrain';
import { decodeReferenceLightmap, referenceLightmapEncoding } from '../../core/reference/lightmap';
import type { LightmapSet } from '../../core/lighting/lightmap';

/** Match the editor's extracted-lightmap decode while sourcing PNGs from local Blobs or original map files. */
export async function lightPublicReference(mesh: ReferenceMesh, patches: RawPatch[], url: (id: number) => string): Promise<void> {
  const maps: LightmapSet = new Map();
  for (const id of referenceLightmapIds(patches)) {
    const response = await fetch(url(id));
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) continue;
    const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(image, 0, 0); image.close();
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    maps.set(id, decodeReferenceLightmap(data, referenceLightmapEncoding(patches, id)));
  }
  applyReferenceLightmaps(mesh, patches, maps);
}
