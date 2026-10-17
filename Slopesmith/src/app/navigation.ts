export const MAPS_PATH = '/maps';
export const ISOS_PATH = '/isos';
export const PLAY_PATH = '/play';
export const EDITOR_PATH = '/editor';

export type AppPage = 'maps' | 'isos' | 'play' | 'editor';

/** Public browsing and authenticated editing have separate routes. */
export function pageInPath(pathname: string): AppPage | null {
  const page = /^\/(maps|isos)\/?$/i.exec(pathname)?.[1] ?? /^\/(play|editor)(?:\/[^/]+)?\/?$/i.exec(pathname)?.[1];
  return page ? (page.toLowerCase() as AppPage) : null;
}

export function mapPath(page: 'play' | 'editor', name: string): string {
  const base = page === 'play' ? PLAY_PATH : EDITOR_PATH;
  return name.trim() ? `${base}/${encodeURIComponent(name.trim())}` : base;
}

/** Decode exactly one name segment; malformed or nested paths never name a map. */
export function mapNameAtPath(pathname: string, page: 'play' | 'editor'): string {
  const encoded = new RegExp(`^/${page}/([^/]+)/?$`, 'i').exec(pathname)?.[1];
  if (!encoded) return '';
  try {
    const name = decodeURIComponent(encoded);
    return name.includes('/') || name.includes('\\') ? '' : name;
  } catch {
    return '';
  }
}

/** Public account menus open the editor's existing account panels. */
export function editorAccountUrl(panel: 'profile' | 'settings'): string {
  return `${EDITOR_PATH}?account=${panel}`;
}
