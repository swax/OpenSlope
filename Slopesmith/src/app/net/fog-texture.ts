import { parseAssetVersion } from '../../core/reference/asset-version';
import { workspaceFetch } from './workspace';

/** Older volumes have no texture field. Discover their real sprite, then use /api/texture like other art. */
export async function resolveFogTexture(
  level = '',
  request: (url: string) => Promise<Response> = workspaceFetch,
  source?: string,
): Promise<string> {
  const query = new URLSearchParams({ name: 'fog0.png', level, reference: '1' });
  if (source) query.set('mapSource', source);
  const response = await request(`/api/particle-texture?${query}`);
  if (!response.ok) throw new Error('The original fog texture is unavailable. Load its source course.');
  const { texture } = (await response.json()) as { texture?: string };
  if (!texture || parseAssetVersion(texture)?.kind !== 'texture')
    throw new Error('The fog source did not return an exact texture identity.');
  return texture;
}
