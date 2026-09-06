import { currentAccount, gateFor } from './net/account';
import { enterEditor } from './enter-editor';

/**
 * The page's entry point: ask the server who this browser is, then load the editor — or a login page instead
 * (docs/038).
 *
 * The gate is here, in a module of its own, because of what `main.ts` is: importing it IS booting the editor.
 * It builds the store, constructs the viewport and starts reading libraries while it is being evaluated, so
 * there is no way to load it speculatively and decide afterwards. Asking first, and importing it only for a
 * browser the server accepts, is what makes a login page possible at all — and it means somebody who cannot
 * use this server never downloads several megabytes of editor to be refused by it.
 *
 * The cost is one round trip before the editor's bytes are requested, and it is paid on every load, including
 * by the owner of a loopback server who will never see a login page. `/api/auth/session` is a small
 * same-origin GET against a route that resolves a cookie and answers — on a server with no accounts it does
 * not even touch the filesystem (server/accounts/guard.ts) — so what is being spent is a round trip, not
 * work. That is the trade: a page that is honest about who may use this server, against a few milliseconds
 * before the first byte of the editor.
 *
 * Nothing else in the app may import this file. It is the script index.html names, it runs once, and its two
 * branches are the two shapes the app has.
 */
async function boot(): Promise<void> {
  const gate = gateFor(await currentAccount(), location.hash);
  if (gate.show === 'editor') { await enterEditor(); return; }
  const { showLoginPage } = await import('./ui/chrome/login-page');
  showLoginPage(gate);
}

void boot();
