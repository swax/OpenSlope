/** A map's storage location is independent of its game and display name. */
import { parseAssetVersion, serverAssetVersionName } from './asset-version';
export type MapSource = 'local' | 'server';

export function splitMapSource(id: string): { name: string; source?: MapSource } {
  const match = /^(local|server):(.+)$/i.exec(id);
  return match ? { name: match[2], source: match[1].toLowerCase() as MapSource } : { name: id };
}

export const mapSourceId = (source: MapSource, name: string): string => `${source}:${splitMapSource(name).name}`;

/** Server-side filesystem readers can consume explicit server references, never a browser-local copy. */
export function serverMapName(id: string): string {
  if (parseAssetVersion(id)) {
    const name = serverAssetVersionName(id);
    if (!name) throw new Error('This asset version must be resolved before reading its files.');
    return name;
  }
  const { source, name } = splitMapSource(id);
  if (source === 'local') throw new Error(`Local map "${name}" must be read on this device.`);
  return name;
}

/** Legacy unqualified references retain their local-first resolution in a mixed catalogue. */
export function findMapChoice<T extends { name: string; source?: MapSource }>(
  maps: readonly T[],
  id: string,
): T | undefined {
  const exact = maps.find(map => map.name === id);
  if (exact || splitMapSource(id).source) return exact;
  const matches = maps.filter(map => splitMapSource(map.name).name.toLowerCase() === id.toLowerCase());
  return matches.find(map => (map.source ?? splitMapSource(map.name).source) === 'local') ?? matches[0];
}
