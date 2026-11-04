import { readAssetManifest, type AssetSelection } from '../../shared/map-asset-manifest';
import { buildLevelPropsUncached, type PropSelection } from '../../shared/map-props';
import type { PropsPayload } from '../../core/reference/props';
import { propAssetPayload, type AssetManifest } from '../../core/reference/asset-manifest';
import { parseAssetVersion } from '../../core/reference/asset-version';
import type { lazyLocalMapData } from './lazy-local-map-data';

const cacheName = `slopesmith.imported-assets.v1.${import.meta.env?.VITE_ASSET_BUILD ?? 'unbundled'}`;
let diskCache: Promise<Cache> | undefined;
function cacheStore() {
  diskCache ??= (async () => {
    const cache = await caches.open(cacheName);
    for (const name of await caches.keys())
      if (name.startsWith('slopesmith.imported-assets.v1.') && name !== cacheName) await caches.delete(name);
    return cache;
  })();
  void diskCache.catch(() => { diskCache = undefined; });
  return diskCache;
}
// A dev-server restart/build gets a new identity. Invalidate derived data on live code edits too.
if (import.meta.hot) import.meta.hot.on('vite:beforeUpdate', () => { diskCache = undefined; void caches.delete(cacheName); });
type StoredBank = { manifest: AssetManifest; props?: PropsPayload };

/** Share selected model bakes between matching and fetching, and across editor/player reloads. */
export function createLocalAssetBank(local: Awaited<ReturnType<typeof lazyLocalMapData>>) {
  const manifests = new Map<string, Promise<AssetManifest>>();
  const payloads = new Map<string, Promise<PropsPayload>>();
  const models = new Map<string, PropsPayload>();
  function remember(level: string, payload: PropsPayload) {
    for (const model of payload.models) models.set(`${level}:prop:${model.id}`, payload);
    for (const body of payload.physicsBodies ?? []) models.set(`${level}:body:${body.id}`, payload);
  }
  function props(level: string, selection?: PropSelection) {
    const key = `${level}:${selection ? JSON.stringify([[...selection.models].sort(), [...selection.bodies].sort()]) : '*'}`;
    let pending = payloads.get(key);
    if (!pending) {
      pending = buildLevelPropsUncached(local.source, level, selection).then(payload => {
        remember(level, payload);
        return payload;
      });
      payloads.set(key, pending);
      void pending.catch(() => { if (payloads.get(key) === pending) payloads.delete(key); });
    }
    return pending;
  }
  return {
    async props(level: string, id?: string) {
      const asset = parseAssetVersion(id ?? '');
      if (!asset?.kind) return props(level);
      const payload = models.get(`${level}:${asset.kind}:${asset.key}`) ?? await props(level, {
        models: new Set(asset.kind === 'prop' ? [Number(asset.key)] : []),
        bodies: new Set(asset.kind === 'body' ? [Number(asset.key)] : []),
      });
      return propAssetPayload(payload, asset);
    },
    manifest(level: string, selection?: AssetSelection) {
      const key = `${level}:${JSON.stringify(selection ?? null)}`;
      let pending = manifests.get(key);
      if (!pending) {
        pending = (async () => {
          // Derived data is optional; unavailable/quota-limited browser storage never prevents loading.
          let cache: Cache | undefined, request: string | undefined;
          if (selection) try {
            const identity = await local.cacheIdentity(level);
            if (identity && typeof caches !== 'undefined') {
              cache = await cacheStore();
              request = `${location.origin}/__imported-assets/${encodeURIComponent(identity)}/${encodeURIComponent(key)}`;
              const response = await cache.match(request);
              if (response) {
                const stored = await response.json() as StoredBank;
                if (stored.props) remember(level, stored.props);
                return stored.manifest;
              }
            }
          } catch { /* Rebuild from the imported files. */ }
          let baked: PropsPayload | undefined;
          const manifest = await readAssetManifest(local.source, level, async subset => {
            baked = await props(level, subset);
            return baked;
          }, selection);
          if (cache && request && !manifest.unavailable?.length) {
            const stored: StoredBank = { manifest, ...(baked ? { props: { ...baked, instances: [], collisionMeshes: [] } } : {}) };
            await cache.put(request, Response.json(stored)).then(async () => {
              const keys = await cache!.keys();
              for (const key of keys.slice(0, Math.max(0, keys.length - 64))) await cache!.delete(key);
            }).catch(() => {});
          }
          return manifest;
        })();
        manifests.set(key, pending);
        void pending.catch(() => { if (manifests.get(key) === pending) manifests.delete(key); });
      }
      return pending;
    },
  };
}
