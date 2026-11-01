import type { MapDataSource } from '../../shared/map-data';
import { readNativeSky, type NativeSkyPayload } from '../../shared/map-sky';
import type { Viewport } from '../viewport/viewport';
import { referenceSkyUrl } from '../net/asset-paths';
import { mapDisplayName } from '../../core/reference/map-game';

/** Server references use the same original geometry as local extractions, with legacy panorama fallback. */
export async function installServerSky(viewport: Viewport, level: string, topColor?: string): Promise<void> {
  // Public original references use their narrowly scoped server read routes, independent of the ISO bridge.
  const response = await fetch(`/api/skybox/native?level=${encodeURIComponent(level)}`);
  if (response.ok) {
    viewport.setSky({ native: (await response.json()) as NativeSkyPayload, topColor });
    return;
  }
  if (response.status !== 404)
    throw new Error(`${mapDisplayName({ name: level })}’s sky could not be loaded (${response.status}).`);
  viewport.setSky({
    panorama: referenceSkyUrl(level, 'panorama'),
    ground: referenceSkyUrl(level, 'ground'),
    topColor,
  });
}

/** Editor and Play use the same original dome renderer and async visibility guards. */
export async function installLocalSky(viewport: Viewport, source: MapDataSource, course: string,
  fileUrl: (path: string) => string): Promise<{ setVisible(on: boolean): void } | undefined> {
  const native = await readNativeSky(source, course, fileUrl);
  if (!native) return;
  viewport.setSky({ native });
  return { setVisible: on => viewport.showSky(on) };
}
