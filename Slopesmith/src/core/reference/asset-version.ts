import { canonicalDiscCourse, isDiscCourse } from './disc-courses';

export interface AssetVersion {
  id: string;
  game: string;
  map: string;
  hash: string;
  kind?: 'texture' | 'prop' | 'body';
  key?: string;
}

export function assetMapKey(name: string, course?: string): string {
  const canonical = canonicalDiscCourse(course ?? name);
  return isDiscCourse(canonical) ? canonical : name.toUpperCase();
}

export function assetVersion(game: string, map: string, hash: string): AssetVersion {
  return { id: `asset1:${encodeURIComponent(game)}:${encodeURIComponent(map)}:${hash}`, game, map, hash };
}

export function parseAssetVersion(id: string): AssetVersion | undefined {
  const asset = /^asset2:([^:/]+):([^:/]+):(texture|prop|body):([^:/]+):([a-f0-9]{64})$/.exec(id);
  if (asset) {
    try {
      const key = decodeURIComponent(asset[4]);
      if (
        !key ||
        key.split('/').some(part => !part || part === '.' || part === '..') ||
        key.includes('\\') ||
        [...key].some(character => character.charCodeAt(0) < 32)
      )
        return;
      if (asset[3] !== 'texture' && !/^(0|[1-9]\d*)$/.test(key)) return;
      return {
        id,
        game: decodeURIComponent(asset[1]),
        map: decodeURIComponent(asset[2]),
        kind: asset[3] as AssetVersion['kind'],
        key,
        hash: asset[5],
      };
    } catch {
      return;
    }
  }
  const match = /^asset1:([^:/]+):([^:/]+):([a-f0-9]{64})$/.exec(id);
  if (!match) return undefined;
  try {
    return { id, game: decodeURIComponent(match[1]), map: decodeURIComponent(match[2]), hash: match[3] };
  } catch {
    return undefined;
  }
}

/** Versioned levels embedded in texture refs, placed props, groups and model definitions. */
export function assetVersionsIn(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (child: unknown): void => {
    if (typeof child === 'string') {
      if (!/^asset[12]:/.test(child)) return;
      const level = child.split('/')[0];
      if (parseAssetVersion(level)) found.add(level);
    } else if (ArrayBuffer.isView(child)) return;
    else if (Array.isArray(child)) {
      if (typeof child[0] !== 'number') child.forEach(visit);
    } else if (child && typeof child === 'object') Object.values(child).forEach(visit);
  };
  visit(value);
  return [...found];
}

const serverLocations = new Map<string, string>();
export function registerServerAssetVersion(id: string, name: string): void {
  serverLocations.set(id, name);
}
export function serverAssetVersionName(id: string): string | undefined {
  return serverLocations.get(id);
}
export function serverAssetVersionLocations(): ReadonlyMap<string, string> {
  return serverLocations;
}
