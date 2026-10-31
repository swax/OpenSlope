import { canonicalDiscCourse, isDiscCourse } from './disc-courses';

export interface AssetVersion {
  id: string;
  game: string;
  map: string;
  hash: string;
}

export function assetMapKey(name: string, course?: string): string {
  const canonical = canonicalDiscCourse(course ?? name);
  return isDiscCourse(canonical) ? canonical : name.toUpperCase();
}

export function assetVersion(game: string, map: string, hash: string): AssetVersion {
  return { id: `asset1:${encodeURIComponent(game)}:${encodeURIComponent(map)}:${hash}`, game, map, hash };
}

export function parseAssetVersion(id: string): AssetVersion | undefined {
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
      if (!child.startsWith('asset1:')) return;
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
