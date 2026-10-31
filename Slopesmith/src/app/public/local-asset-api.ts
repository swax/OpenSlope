import { configureWorkspace } from '../net/workspace';
import { clearAssetCatalogue } from '../net/asset-versions';
import { mapSourceId } from '../../core/reference/map-source';
import { listLevelOrigins } from '../../shared/map-levels';
import { readAssetVersion } from '../../shared/map-asset-version';
import { buildLevelPropsUncached, readMaterialTables } from '../../shared/map-props';
import { readLevelGroups } from '../../shared/map-groups';
import type { localMapData } from './local-map-data';

/** The public player resolves the same versioned dependencies, without starting editor/project writes. */
export function installLocalAssetApi(
  local: Awaited<ReturnType<typeof localMapData>>,
  courses: readonly string[],
  allowServer: boolean,
): void {
  clearAssetCatalogue();
  const versions = new Map<string, ReturnType<typeof readAssetVersion>>();
  configureWorkspace(false, async (url, init) => {
    const level = url.searchParams.get('level') ?? '';
    const source = url.searchParams.get('mapSource');
    if (url.pathname === '/api/levels') {
      const localMaps = (await listLevelOrigins(local.source)).map(map => ({
        ...map,
        name: mapSourceId('local', courses.find(course => course.toLowerCase() === map.name.toLowerCase()) ?? map.name),
        source: 'local',
      }));
      const response = allowServer ? await fetch(url, init).catch(() => null) : null;
      const server = response?.ok ? ((await response.json()) as { maps?: { name: string }[]; levels?: string[] }) : {};
      const serverMaps = (server.maps ?? server.levels?.map(name => ({ name })) ?? []).map(map => ({
        ...map,
        name: mapSourceId('server', map.name),
        source: 'server',
      }));
      const maps = [...localMaps, ...serverMaps];
      return Response.json({ levels: maps.map(map => map.name), maps });
    }
    if (source !== 'local')
      return allowServer
        ? null
        : Response.json({ error: 'Load the matching disc assets on this device.' }, { status: 404 });
    if (url.pathname === '/api/map-asset-version') {
      let value = versions.get(level);
      if (!value) {
        value = readAssetVersion(local.source, level);
        versions.set(level, value);
      }
      return Response.json(await value);
    }
    if (url.pathname === '/api/props') return Response.json(await buildLevelPropsUncached(local.source, level));
    if (url.pathname === '/api/groups') return Response.json(await readLevelGroups(local.source, level));
    if (url.pathname === '/api/props/materials')
      return Response.json({ tables: Object.fromEntries(await readMaterialTables(local.source)) });
    const resolved = local.resolveAsset(url.href);
    return resolved !== url.href
      ? fetch(resolved)
      : Response.json({ error: 'The matching local asset is unavailable.' }, { status: 404 });
  });
}
