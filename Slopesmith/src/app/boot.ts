import { currentAccount, gateFor } from './net/account';
import { enterEditor } from './enter-editor';

/**
 * Ask who this browser is before loading the editor. Visitors get the public course homepage; members get
 * the editor, and /?play opens the homepage for members too. Explicit sign-in, invitations and first-run
 * enrolment retain their account forms (docs/038).
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
 * Nothing else imports this entry. Public riding loads its own viewport composition only after a course
 * has been chosen, so it never starts project sync or editor autosave.
 */
async function boot(): Promise<void> {
  const gate = gateFor(await currentAccount(), location.hash);
  if (new URLSearchParams(location.search).has('play') || (gate.show === 'sign-in' && location.hash !== '#sign-in')) {
    const { showPublicHome } = await import('./public/home');
    await showPublicHome();
    return;
  }
  if (gate.show === 'editor') { await enterEditor(); return; }
  const { showLoginPage } = await import('./ui/chrome/login-page');
  showLoginPage(gate);
}

void boot();
