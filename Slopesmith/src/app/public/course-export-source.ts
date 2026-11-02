import type { ProjectBundle } from '../../core/project/transfer';
import { mapSourceId } from '../../core/reference/map-source';
import { safeDataName } from '../../core/export/names';
import { readAssetVersion } from '../../shared/map-asset-version';
import { readAssetManifest } from '../../shared/map-asset-manifest';
import { listLevelOrigins } from '../../shared/map-levels';
import { createAssetReader } from '../net/asset-reader';
import { createAssetResolver } from '../../shared/asset-resolver';
import {
  referenceAssetCacheKey,
  browserAssetCache,
  validateReferenceAssetResponse,
  missingAssetUrl,
} from '../net/asset-cache';
import { currentAccount } from '../net/account';
import { readLevelGroups } from '../../shared/map-groups';
import {
  buildLevelPropsUncached,
  nativeArtSource,
  readMaterialTables,
  readPhysicsBodySpheres,
} from '../../shared/map-props';
import { levelsWithNativeSky, nativeSkyFiles } from '../../shared/map-sky';
import { bindMapPayload, mapSourceRequest } from '../net/map-source';
import { bundleAssets, bundleProps } from './bundle-assets';
import { cachedIsoCourses } from './iso-cache';
import { lazyLocalMapData } from './lazy-local-map-data';

/** Owns only this export's bytes. It never reconfigures the live player or editor's workspace. */
export async function courseExportSource(bundle: ProjectBundle, aliases: Record<string, string> = {}) {
  const cached = await cachedIsoCourses();
  const local = await lazyLocalMapData(cached, aliases);
  const custom = bundleAssets(bundle);
  const packed = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  const tables = async () => {
    const source = await readMaterialTables(local.source);
    const result = Object.fromEntries(
      [...source].flatMap(([name, table]) => [
        [safeDataName(name), table],
        [safeDataName(mapSourceId('local', name)), table],
      ]),
    );
    return result;
  };
  async function request(path: string): Promise<Response> {
    const selected = mapSourceRequest(path);
    const url = selected.url,
      q = url.searchParams;
    if (url.pathname === '/api/levels') {
      const response = await fetch(url).catch(() => null);
      const server = response?.ok ? ((await response.json()) as { maps?: { name: string }[]; levels?: string[] }) : {};
      const maps = [
        ...(server.maps ?? server.levels?.map(name => ({ name })) ?? []).map(map => ({
          ...map,
          name: mapSourceId('server', map.name),
          source: 'server',
        })),
        ...(await listLevelOrigins(local.source)).map(map => ({
          ...map,
          name: mapSourceId('local', map.name),
          source: 'local',
        })),
      ];
      return Response.json({ levels: maps.map(map => map.name), maps });
    }
    const level = selected.name;
    const useLocal = selected.source !== 'server' && local.hasLevel(level);
    if (selected.source === 'local' && !useLocal)
      throw new Error(`Load ${level} on this device before exporting this mountain.`);
    const resolved = custom.resolve(url.href);
    if (resolved !== url.href) {
      if (resolved.startsWith('data:'))
        throw new Error(`The mountain is missing the asset ${q.get('name') ?? q.get('sky') ?? ''}.`);
      return fetch(resolved);
    }
    if (url.pathname === '/api/custom-props') return Response.json(bundleProps(bundle));
    if (url.pathname === '/api/props/materials') {
      const response = await fetch(url).catch(() => null);
      const server = response?.ok ? ((await response.json()) as { tables: Record<string, unknown> }) : { tables: {} };
      return Response.json({
        tables: {
          ...server.tables,
          ...Object.fromEntries(
            Object.entries(server.tables).map(([name, table]) => [safeDataName(mapSourceId('server', name)), table]),
          ),
          ...(await tables()),
        },
      });
    }
    if (useLocal) {
      let body: unknown;
      if (url.pathname === '/api/map-asset-manifest') body = await readAssetManifest(local.source, level);
      else if (url.pathname === '/api/map-asset-version') body = await readAssetVersion(local.source, level);
      else if (url.pathname === '/api/groups') body = await readLevelGroups(local.source, level);
      else if (url.pathname === '/api/props') body = await buildLevelPropsUncached(local.source, level);
      else if (url.pathname === '/api/physics-body')
        body = { spheres: await readPhysicsBodySpheres(local.source, level, Number(q.get('idx'))) };
      else if (url.pathname === '/api/skybox/native' && q.get('files') === '1')
        body = {
          files: (await nativeSkyFiles(local.source, level)).map(file => ({
            path: file.path,
            bytes: packed(file.bytes),
          })),
        };
      if (body) return Response.json(bindMapPayload(path, body));
      const asset = await local.resolveRequest(url.href);
      if (missingAssetUrl(asset))
        return selected.source === 'local'
          ? Response.json({ error: 'The matching local asset is unavailable.' }, { status: 404 })
          : fetch(url);
      if (asset !== url.href) return fetch(asset);
      throw new Error(`The locally loaded map cannot supply ${url.pathname}.`);
    }
    if (url.pathname === '/api/props/native-art') {
      const server = await fetch(url).catch(() => null);
      return server?.ok ? server : Response.json(await nativeArtSource(local.source));
    }
    if (url.pathname === '/api/skybox') {
      const response = await fetch(url).catch(() => null);
      const server = response?.ok ? ((await response.json()) as { nativeLevels?: string[] }) : {};
      return Response.json({
        ...server,
        nativeLevels: [
          ...(server.nativeLevels ?? []),
          ...(await levelsWithNativeSky(local.source)).map(name => mapSourceId('local', name)),
        ],
      });
    }
    return fetch(url);
  }
  const reader = createAssetReader(input => request(input instanceof Request ? input.url : input.toString()));
  const assets = createAssetResolver({
    local: async () => null,
    remote: input =>
      mapSourceRequest(input).version
        ? reader.fetch(input)
        : request(input instanceof Request ? input.url : input.toString()),
    key: referenceAssetCacheKey,
    validate: validateReferenceAssetResponse,
    cache: browserAssetCache(async () => {
      const account = await currentAccount();
      return 'user' in account
        ? `member:${account.user.id}`
        : account.accounts === 'open' && !account.offline
          ? 'open-server'
          : 'device';
    }),
  });
  return {
    request: (path: string) => assets.fetch(path),
    dispose() {
      assets.clear();
      custom.dispose();
      local.dispose();
    },
  };
}
