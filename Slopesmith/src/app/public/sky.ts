import type { MapDataSource } from '../../shared/map-data';
import { readNativeSky } from '../../shared/map-sky';
import type { Viewport } from '../viewport/viewport';

/** Editor and Play use the same original dome renderer and async visibility guards. */
export async function installLocalSky(viewport: Viewport, source: MapDataSource, course: string,
  fileUrl: (path: string) => string): Promise<{ setVisible(on: boolean): void } | undefined> {
  const native = await readNativeSky(source, course, fileUrl);
  if (!native) return;
  viewport.setSky({ native });
  return { setVisible: on => viewport.showSky(on) };
}
