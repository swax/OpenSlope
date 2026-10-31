import { mapDisplayName, mapGame, mapGameLabel, type MapSourceChoice } from '../../core/reference/map-game';
import { findMapChoice, splitMapSource } from '../../core/reference/map-source';
import { isLocalWorkspace } from '../net/workspace';
import { assetLocation, assetPreference, watchAssetLocations } from '../net/asset-versions';
import { parseAssetVersion } from '../../core/reference/asset-version';

const catalogues = new Map<string, readonly MapSourceChoice[]>();
const listeners = new Set<() => void>();
watchAssetLocations(() => {
  for (const changed of listeners) changed();
});

/** Share the pickers' metadata with asset inspectors without fetching a second catalogue. */
export function registerMapSources(context: string, maps: readonly MapSourceChoice[]): void {
  catalogues.set(context, maps);
  for (const changed of listeners) changed();
}

export function watchMapSources(changed: () => void): () => void {
  listeners.add(changed);
  return () => listeners.delete(changed);
}

export function mapSourceDetails(level: string): { source: string; game: string; map: string; version?: string } {
  const version = parseAssetVersion(level);
  const original = level;
  level = assetLocation(level) ?? level;
  const maps = [...catalogues.values()].flat();
  const own = ['Custom', '@models', '@import'].includes(level);
  const map = findMapChoice(maps, level) ?? { name: level };
  const source = own
    ? isLocalWorkspace()
      ? 'local'
      : 'server'
    : (map.source ?? splitMapSource(map.name).source ?? 'server');
  const mountain = maps.find(map => ['Custom', '@models'].includes(map.name));
  const preferred = assetPreference(original);
  return {
    source: version
      ? `${preferred === 'local' ? 'Local' : 'Server'} preferred${assetLocation(original) && source !== preferred ? ` · using ${source === 'local' ? 'Local' : 'Server'}` : ''}`
      : source === 'local'
        ? 'Local'
        : 'Server',
    game: mapGameLabel(version?.game ?? mapGame(map)),
    map: own ? (map.label ?? mountain?.label ?? 'Mountain') : mapDisplayName(map),
    ...(version ? { version: version.hash.slice(0, 8) } : {}),
  };
}
