/**
 * Load the editor and let it boot, which is the last thing either way into the app does.
 *
 * `boot.ts` calls this for a browser the server already accepts; the login page calls it the moment a
 * password is accepted, in place of the reload that used to be needed there. The import is what actually
 * fetches the editor — several megabytes of it — so it is deliberately the only place that does, and the one
 * place that says something when those bytes never arrive.
 */

/** The boot splash index.html ships, put back after the login page borrowed the screen. */
function splash(): HTMLElement | null {
  return document.getElementById('load-status');
}

/**
 * A chunk that never loaded, said out loud.
 *
 * The likeliest cause is a deploy: an open tab holding an index that names asset hashes the server has just
 * replaced. That used to be a blank page and a line in the console, and it is more reachable now that the
 * editor arrives as a dynamic import rather than as the entry script itself — so it gets the load card,
 * which is already on the screen, rather than nothing at all.
 */
function failed(error: unknown): void {
  const root = splash();
  const title = document.getElementById('load-title');
  const label = document.getElementById('load-label');
  const detail = document.getElementById('load-detail');
  console.error('[boot] the editor failed to load', error);
  if (!root || !title || !label || !detail) return;
  root.classList.add('show', 'error');
  root.setAttribute('aria-busy', 'false');
  title.textContent = 'Slopesmith could not start';
  label.textContent = 'The editor did not finish loading. Reload the page — if this server was just updated,'
    + ' a reload is all it needs.';
  detail.textContent = String(error instanceof Error ? error.message : error);
}

/** Start the editor. Resolves once its module has been evaluated, which is when the editor has taken over
 *  the page; a failure is reported here rather than thrown, because there is nobody above this to catch it. */
export async function enterEditor(): Promise<void> {
  splash()?.classList.add('show');
  try { await import('./main'); } catch (error) { failed(error); }
}
