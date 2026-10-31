/** A map's storage location is independent of its game and display name. */
import { parseAssetVersion, serverAssetVersionName } from './asset-version';
import { canonicalDiscCourse } from './disc-courses';
export type MapSource = 'local' | 'server';

export function splitMapSource(id: string): { name: string; source?: MapSource } {
  const match = /^(local|server):(.+)$/i.exec(id);
  return match ? { name: match[2], source: match[1].toLowerCase() as MapSource } : { name: id };
}

export const mapSourceId = (source: MapSource, name: string): string => `${source}:${splitMapSource(name).name}`;

/** Try this only after the requested bank is absent; filenames inside an existing bank never fall back. */
export function legacyTrickyMapName(name: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(name) || /^(custom|shared|riders)$/i.test(name)) return;
  const upper = name.toUpperCase();
  const canonical = canonicalDiscCourse(upper);
  return canonical !== upper ? canonical : undefined;
}

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
  if (exact) return exact;
  const selected = splitMapSource(id);
  for (const name of [selected.name, legacyTrickyMapName(selected.name)]) {
    if (!name) continue;
    const matches = maps.filter(map => {
      const candidate = splitMapSource(map.name);
      return (
        candidate.name.toLowerCase() === name.toLowerCase() &&
        (!selected.source || (map.source ?? candidate.source ?? 'server') === selected.source)
      );
    });
    const match = matches.find(map => (map.source ?? splitMapSource(map.name).source) === 'local') ?? matches[0];
    if (match) return match;
  }
  return undefined;
}
