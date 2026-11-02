import type { AssetCache } from '../../shared/asset-resolver';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { splitMapSource } from '../../core/reference/map-source';

export const REFERENCE_ASSET_ROUTES = new Set([
  '/api/texture',
  '/api/lightmap',
  '/api/particle-texture',
  '/api/effect-sound',
  '/api/board-sound',
  '/api/environment-sound',
  '/api/announcer-sound',
  '/api/skypano',
  '/api/skyground',
  '/api/skybox/page',
  '/api/props',
  '/api/groups',
  '/api/physics-body',
]);

/** Local readers use an empty data URL as their missing-file marker, never as successful bytes. */
export const missingAssetUrl = (url: string): boolean => /^data:[^,]*,$/.test(url);

export function referenceAssetRequest(input: RequestInfo | URL): boolean {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    globalThis.location?.origin ?? 'http://localhost',
  );
  const level = splitMapSource(url.searchParams.get('level') ?? '').name;
  return (
    url.origin === (globalThis.location?.origin ?? 'http://localhost') &&
    REFERENCE_ASSET_ROUTES.has(url.pathname) &&
    !/^(custom$|@)/i.test(level) &&
    !url.searchParams.has('project') &&
    !url.searchParams.has('client')
  );
}

/** Old unversioned names stay live. A revision or exact asset identity is required for persistent reuse. */
export function referenceAssetCacheKey(input: RequestInfo | URL): string | undefined {
  if (!referenceAssetRequest(input)) return;
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    globalThis.location?.origin ?? 'http://localhost',
  );
  if (
    !parseAssetVersion(url.searchParams.get('level') ?? '') &&
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('v') ?? '')
  )
    return;
  url.searchParams.sort();
  return url.href;
}

export async function validateReferenceAssetResponse(input: RequestInfo | URL, response: Response): Promise<boolean> {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    globalThis.location?.origin ?? 'http://localhost',
  );
  const revision = url.searchParams.get('v');
  if (!revision) return true;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer()));
  return (
    btoa(String.fromCharCode(...digest))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '') === revision
  );
}

/** Browser storage is optional. Account/policy scopes keep private cache entries out of public playback. */
export function browserAssetCache(scope: () => Promise<string>): AssetCache {
  let writing: Promise<void> = Promise.resolve();
  async function open() {
    if (typeof caches === 'undefined') return undefined;
    return caches.open(`slopesmith.reference-assets.v1.${encodeURIComponent(await scope())}`);
  }
  return {
    async get(key) {
      return (await open())?.match(key);
    },
    put(key, response, bytes) {
      const work = writing.then(async () => {
        const cache = await open();
        const limit = 128 * 1024 * 1024;
        if (!cache || bytes > limit) return;
        const entries = (await cache.keys()).filter(entry => entry.url !== key);
        const sizes = await Promise.all(
          entries.map(async entry =>
            Number((await cache.match(entry))?.headers.get('x-slopesmith-cache-size') ?? limit),
          ),
        );
        let total = bytes + sizes.reduce((sum, size) => sum + size, 0),
          count = entries.length + 1;
        for (let i = 0; i < entries.length && (total > limit || count > 256); i++) {
          await cache.delete(entries[i]);
          total -= sizes[i];
          count--;
        }
        const headers = new Headers(response.headers);
        headers.set('x-slopesmith-cache-size', String(bytes));
        await cache.put(key, new Response(response.body, { status: response.status, headers }));
      });
      writing = work.catch(() => {});
      return work;
    },
  };
}
