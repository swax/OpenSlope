/**
 * The open mountain's name, in the address bar: `slopesmith.example.com/MOUNTAIN01`.
 *
 * Three things at once. A URL worth bookmarking, so "the map I am working on" is a link rather than a state
 * this browser happens to be in. An address bar that says which mountain is open, beside the tab title that
 * already does (`top-bar.ts`). And a deterministic load: the page opens the map its URL names, rather than
 * whichever one this tab last activated on the server (`server/projects.ts`, the per-client session record).
 *
 * The name is the map's own — the manifest is the authority on what a map is called, and a rename moves the
 * URL with it.
 *
 * **Why the first path segment can hold it.** A map name is `[A-Za-z0-9_-]` (`safeDataName`), so it can never
 * collide with a root file: every one of those — `favicon.ico`, `site.webmanifest`, the icons — carries a dot.
 * What is left is the handful of root DIRECTORIES the host serves, listed below. A map called one of those
 * still opens and still works; it simply goes without a vanity URL, because the file server would answer that
 * path long before the editor booted. Degrading is the whole handling: nothing about a map depends on this.
 *
 * **What the deployment owes.** Reaching `/MOUNTAIN01` needs the SPA fallback the editor is already served
 * with — `try_files {path} /index.html` in `deploy/Caddyfile.example`, and Vite's own in development. Every
 * request the app makes is absolute (`/api/...`), so nothing else moves when the path does.
 */

/** Root paths the host serves itself, in production (`dist/`) and in development (Vite). */
const RESERVED: ReadonlySet<string> = new Set(['api', 'assets', 'characters', 'src', 'node_modules']);

/** What a map may be called, which is exactly what may stand as a path segment. */
const MAP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether a name is one the address bar cannot carry, so the name prompt can steer away from it. */
export const isReservedMapName = (name: string): boolean => RESERVED.has(name.trim().toLowerCase());

/** Whether this name can name a map in a URL at all. */
const addressable = (name: string): boolean => MAP_NAME.test(name) && !isReservedMapName(name);

/** The map this URL asks for, or `''` for the plain address — which means "whatever this tab had open". */
export function mapNameInUrl(): string {
  let segment: string;
  try { segment = decodeURIComponent(location.pathname.split('/')[1] ?? ''); }
  catch { return ''; } // a stray % is not a map name
  return addressable(segment) ? segment : '';
}

/**
 * Point the address bar at the map now open, without adding a history entry.
 *
 * `replaceState` rather than `pushState`: Back leaves the editor, as it always has, instead of silently
 * swapping the document out from under an author mid-edit. The query and hash ride along untouched, so
 * `?agent=1`, `?verifyRebuild=1` and a `#invite=` link all survive a map switch.
 */
export function showMapInUrl(name: string): void {
  const wanted = name.trim();
  const path = addressable(wanted) ? `/${wanted}` : '/';
  if (location.pathname === path) return;
  try { history.replaceState(history.state, '', `${path}${location.search}${location.hash}`); }
  catch { /* a browser that refuses history is no reason to fail a load */ }
}
