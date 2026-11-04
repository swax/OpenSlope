import { applyReferenceLightmaps, referenceLightmapIds, type RawPatch, type ReferenceMesh } from '../../core/reference/terrain';
import { decodeReferenceLightmap, referenceLightmapEncoding } from '../../core/reference/lightmap';
import type { LightmapSet } from '../../core/lighting/lightmap';
import { clientFetch } from '../net/client';
import type { EditDoc } from '../../core/doc/doc-edit';
import { DEFAULT_SUN } from '../../core/doc/types';
import { authoredFreeLights, authoredSignLights } from '../../core/lighting/sign-lights';
import { authoredGroupLights } from '../../core/reference/groups';
import type { Viewport } from '../viewport/viewport';

/** Build the same light rig as the editor before props consume its sign tint and terrain glow. */
export function lightPublicMountain(
  viewport: Pick<Viewport, 'assets' | 'setAuthoredLights' | 'showAuthoredLights'>,
  document: EditDoc,
): void {
  viewport.setAuthoredLights([
    ...authoredSignLights(document.props, viewport.assets.propLocalBox),
    ...authoredFreeLights(document.lights),
    ...authoredGroupLights(
      document.props,
      prop => prop.groupDefinition ?? viewport.assets.groupDefs.get(`${prop.level}:${prop.group}`) ?? null,
    ),
  ]);
  viewport.showAuthoredLights(document.sun?.on ?? DEFAULT_SUN.on);
}

/** Match the editor's extracted-lightmap decode while sourcing PNGs from local Blobs or original map files. */
export async function lightPublicReference(mesh: ReferenceMesh, patches: RawPatch[], url: (id: number) => string): Promise<void> {
  const maps: LightmapSet = new Map();
  for (const id of referenceLightmapIds(patches)) {
    const response = await clientFetch(url(id));
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) continue;
    const image = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true })!; context.drawImage(image, 0, 0); image.close();
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    maps.set(id, decodeReferenceLightmap(data, referenceLightmapEncoding(patches, id)));
  }
  applyReferenceLightmaps(mesh, patches, maps);
}
