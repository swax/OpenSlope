import { mapNameAtPath, mapPath } from '../navigation';

/** The editor opens the named mountain rather than whichever project this tab last activated. */
export function mapNameInUrl(): string {
  const name = mapNameAtPath(location.pathname, 'editor');
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name : '';
}

/**
 * Keep /editor/<name> in step with the open mountain and any rename. Query options and fragments survive;
 * replacing history keeps Back from swapping the document out from under an author mid-edit.
 * With no durable project open, /editor names only the editor, never a browser recovery document.
 */
export function showMapInUrl(name: string, projectId?: string): void {
  const path = mapPath('editor', name);
  const search = new URLSearchParams(location.search);
  // Camera capture links also pin the project identity so their view/revision cannot apply to another map.
  if (projectId && search.has('project')) search.set('project', projectId);
  const query = search.size ? `?${search}` : '';
  if (location.pathname === path && location.search === query) return;
  try { history.replaceState(history.state, '', `${path}${query}${location.hash}`); }
  catch { /* a browser that refuses history is no reason to fail a load */ }
}
