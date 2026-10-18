import { mapNameAtPath } from '../navigation';

const STORAGE = 'slopesmith.last-play-map.v1';
export interface LastPublicMap { name: string; href: string }
function valid(value: unknown): value is LastPublicMap {
  if (!value || typeof value !== 'object') return false;
  const map = value as LastPublicMap;
  if (typeof map.name !== 'string' || !map.name || typeof map.href !== 'string') return false;
  try {
    const url = new URL(map.href, location.origin);
    return url.origin === location.origin && !!mapNameAtPath(url.pathname, 'play');
  } catch { return false; }
}
export function lastPublicMap(): LastPublicMap | null {
  try {
    const map: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    return valid(map) ? map : null;
  } catch { return null; }
}
export function rememberPublicMap(name: string, href: string): void {
  if (!valid({ name, href })) return;
  try { localStorage.setItem(STORAGE, JSON.stringify({ name, href })); } catch { /* storage can be disabled */ }
}
