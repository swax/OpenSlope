import type { ProjectBundle } from '../../core/project/transfer';
import { assetVersionsIn, parseAssetVersion } from '../../core/reference/asset-version';
import { mapSourceId } from '../../core/reference/map-source';
import { safeDataName } from '../../core/export/names';
import { readAssetVersion } from '../../shared/map-asset-version';
import { readLevelGroups } from '../../shared/map-groups';
import { buildLevelPropsUncached, nativeArtSource, readMaterialTables } from '../../shared/map-props';
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
  const versions = new Map<string, Promise<string | undefined>>();
  const packed = (bytes: Uint8Array) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  };
  async function localVersion(id: string) {
    let pending = versions.get(id);
    if (!pending) {
      pending = (async () => {
        const expected = parseAssetVersion(id)!;
        for (const course of cached) {
          if (course.toUpperCase() !== expected.map.toUpperCase()) continue;
          if ((await readAssetVersion(local.source, course)).id === id) return course;
        }
        return undefined;
      })();
      versions.set(id, pending);
    }
    return pending;
  }
  const tables = async () => {
    const source = await readMaterialTables(local.source);
    const result = Object.fromEntries(
      [...source].flatMap(([name, table]) => [
        [safeDataName(name), table],
        [safeDataName(mapSourceId('local', name)), table],
      ]),
    );
    for (const id of assetVersionsIn(bundle.document)) {
      const physical = await localVersion(id);
      const table = physical && [...source].find(([name]) => name.toLowerCase() === physical.toLowerCase())?.[1];
      if (table) result[safeDataName(id)] = table;
    }
    return result;
  };
  async function request(path: string): Promise<Response> {
    const selected = mapSourceRequest(path);
    const url = selected.url,
      q = url.searchParams;
    let level = selected.name;
    let useLocal = selected.source !== 'server' && local.hasLevel(level);
    if (selected.version) {
      const physical = await localVersion(selected.id);
      useLocal = !!physical;
      if (physical) {
        level = physical;
        q.set('level', physical);
        q.set('mapSource', 'local');
      }
    }
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
      if (url.pathname === '/api/groups') body = await readLevelGroups(local.source, level);
      else if (url.pathname === '/api/props') body = await buildLevelPropsUncached(local.source, level);
      else if (url.pathname === '/api/skybox/native' && q.get('files') === '1')
        body = {
          files: (await nativeSkyFiles(local.source, level)).map(file => ({
            path: file.path,
            bytes: packed(file.bytes),
          })),
        };
      if (body) return Response.json(bindMapPayload(path, body));
      const asset = await local.resolveRequest(url.href);
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
  return {
    request,
    dispose() {
      custom.dispose();
      local.dispose();
    },
  };
}
