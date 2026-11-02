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
  const stores = new Map<string, Promise<{ cache: Cache; sizes?: Map<string, number>; total: number }>>();
  async function open() {
    if (typeof caches === 'undefined') return undefined;
    const name = `slopesmith.reference-assets.v1.${encodeURIComponent(await scope())}`;
    let store = stores.get(name);
    if (!store) {
      store = caches.open(name).then(cache => ({ cache, total: 0 }));
      stores.set(name, store);
      void store.catch(() => stores.delete(name));
    }
    return store;
  }
  return {
    async get(key) {
      return (await open())?.cache.match(key);
    },
    put(key, response, bytes) {
      const work = writing.then(async () => {
        const store = await open();
        const limit = 128 * 1024 * 1024;
        if (!store || bytes > limit) return;
        const { cache } = store;
        // Read existing sizes once, rather than reopening every stored response for each new tile.
        if (!store.sizes) {
          store.sizes = new Map(
            await Promise.all(
              (await cache.keys()).map(async entry => {
                const size = Number((await cache.match(entry))?.headers.get('x-slopesmith-cache-size') ?? limit);
                return [entry.url, Number.isFinite(size) && size >= 0 ? size : limit] as const;
              }),
            ),
          );
          store.total = [...store.sizes.values()].reduce((sum, size) => sum + size, 0);
        }
        const sizes = store.sizes;
        let total = store.total - (sizes.get(key) ?? 0) + bytes;
        sizes.delete(key);
        for (const [oldest, size] of sizes) {
          if (total <= limit && sizes.size < 4096) break;
          await cache.delete(oldest);
          sizes.delete(oldest);
          total -= size;
        }
        const headers = new Headers(response.headers);
        headers.set('x-slopesmith-cache-size', String(bytes));
        await cache.put(key, new Response(response.body, { status: response.status, headers }));
        sizes.set(key, bytes);
        store.total = total;
      });
      writing = work.catch(() => stores.clear());
      return work;
    },
  };
}
