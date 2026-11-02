import { configureWorkspace } from '../net/workspace';
import { clearAssetCatalogue } from '../net/asset-versions';
import { missingAssetUrl } from '../net/asset-cache';
import { mapSourceId } from '../../core/reference/map-source';
import { listLevelOrigins } from '../../shared/map-levels';
import { readAssetVersion } from '../../shared/map-asset-version';
import { readAssetManifest } from '../../shared/map-asset-manifest';
import { buildLevelPropsUncached, readMaterialTables, readPhysicsBodySpheres } from '../../shared/map-props';
import { readLevelGroups } from '../../shared/map-groups';
import type { lazyLocalMapData as localMapData } from './lazy-local-map-data';

/** The public player resolves the same versioned dependencies, without starting editor/project writes. */
export function installLocalAssetApi(
  local: Awaited<ReturnType<typeof localMapData>>,
  courses: readonly string[],
  allowServer: boolean,
): void {
  clearAssetCatalogue();
  const versions = new Map<string, ReturnType<typeof readAssetVersion>>();
  const manifests = new Map<string, ReturnType<typeof readAssetManifest>>();
  configureWorkspace(
    false,
    async (url, init) => {
      const level = url.searchParams.get('level') ?? '';
      const source = url.searchParams.get('mapSource');
      if (source === 'local' && level && !local.hasLevel(level))
        return Response.json({ error: 'This local map is not available on this device.' }, { status: 404 });
      if (url.pathname === '/api/levels') {
        const localMaps = (await listLevelOrigins(local.source)).map(map => ({
          ...map,
          name: mapSourceId(
            'local',
            courses.find(course => course.toLowerCase() === map.name.toLowerCase()) ?? map.name,
          ),
          source: 'local',
        }));
        const response = allowServer ? await fetch(url, init).catch(() => null) : null;
        const server = response?.ok
          ? ((await response.json()) as { maps?: { name: string }[]; levels?: string[] })
          : {};
        const serverMaps = (server.maps ?? server.levels?.map(name => ({ name })) ?? []).map(map => ({
          ...map,
          name: mapSourceId('server', map.name),
          source: 'server',
        }));
        const maps = [...localMaps, ...serverMaps];
        return Response.json({ levels: maps.map(map => map.name), maps });
      }
      if (source !== 'local') {
        if (allowServer && !level && url.pathname === '/api/particle-texture') return null;
        if (source !== 'server' && (local.hasLevel(level) || (!level && courses.length))) {
          const resolved = await local.resolveRequest(url.href);
          if (resolved !== url.href && !missingAssetUrl(resolved)) return fetch(resolved);
        }
        return allowServer
          ? null
          : Response.json({ error: 'Load the matching disc assets on this device.' }, { status: 404 });
      }
      if (url.pathname === '/api/map-asset-version') {
        let value = versions.get(level);
        if (!value) {
          value = readAssetVersion(local.source, level);
          versions.set(level, value);
        }
        return Response.json(await value);
      }
      if (url.pathname === '/api/map-asset-manifest') {
        let value = manifests.get(level);
        if (!value) {
          value = readAssetManifest(local.source, level);
          manifests.set(level, value);
        }
        return Response.json(await value);
      }
      if (url.pathname === '/api/props') return Response.json(await buildLevelPropsUncached(local.source, level));
      if (url.pathname === '/api/physics-body')
        return Response.json({
          spheres: await readPhysicsBodySpheres(local.source, level, Number(url.searchParams.get('idx'))),
        });
      if (url.pathname === '/api/groups') return Response.json(await readLevelGroups(local.source, level));
      if (url.pathname === '/api/props/materials')
        return Response.json({ tables: Object.fromEntries(await readMaterialTables(local.source)) });
      const resolved = await local.resolveRequest(url.href);
      return resolved !== url.href && !missingAssetUrl(resolved)
        ? fetch(resolved)
        : Response.json({ error: 'The matching local asset is unavailable.' }, { status: 404 });
    },
    allowServer ? undefined : 'device',
  );
}
