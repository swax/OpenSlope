import { mapNameAtPath, pageInPath } from '../navigation';

const STORAGE = 'slopesmith.last-play-map.v1';
export interface LastPublicMap { name: string; href: string; editorHref?: string; requiredIsoCourses?: string[] }
function valid(value: unknown): value is LastPublicMap {
  if (!value || typeof value !== 'object') return false;
  const map = value as LastPublicMap;
  if (typeof map.name !== 'string' || !map.name || typeof map.href !== 'string') return false;
  if (map.requiredIsoCourses !== undefined && (!Array.isArray(map.requiredIsoCourses)
    || !map.requiredIsoCourses.every(course => typeof course === 'string'))) return false;
  try {
    const url = new URL(map.href, location.origin);
    if (map.editorHref !== undefined) {
      if (typeof map.editorHref !== 'string') return false;
      const editor = new URL(map.editorHref, location.origin);
      if (editor.origin !== location.origin || pageInPath(editor.pathname) !== 'editor') return false;
    }
    return url.origin === location.origin && !!mapNameAtPath(url.pathname, 'play');
  } catch { return false; }
}
export function lastPublicMap(): LastPublicMap | null {
  try {
    const map: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    return valid(map) ? map : null;
  } catch { return null; }
}
export function rememberPublicMap(name: string, href: string, editorHref: string, requiredIsoCourses: string[] = []): void {
  if (!valid({ name, href, editorHref, requiredIsoCourses })) return;
  try { localStorage.setItem(STORAGE, JSON.stringify({ name, href, editorHref, requiredIsoCourses })); } catch { /* storage can be disabled */ }
}
export function forgetPublicMap(): void {
  try { localStorage.removeItem(STORAGE); } catch { /* storage can be disabled */ }
}
