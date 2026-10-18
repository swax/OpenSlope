import { currentAccount, gateFor } from './net/account';
import { enterEditor } from './enter-editor';
import { MAPS_PATH, pageInPath } from './navigation';
import { startSitePresence } from './net/site-presence';

/**
 * Ask who this browser is before loading the editor. Visitors get the public course homepage; members get
 * the editor. /maps, /isos and /play/<name> are public for everyone; /editor uses a browser workspace for
 * signed-out visitors and server projects for members. Explicit sign-in links retain the login form.
 * Invitations and first-run enrolment retain their account forms (docs/038).
 *
 * The gate is here, in a module of its own, because of what `main.ts` is: importing it IS booting the editor.
 * It builds the store, constructs the viewport and starts reading libraries while it is being evaluated, so
 * there is no way to load it speculatively and decide afterwards. Asking first lets us configure a local
 * workspace before the editor can start any project or library requests.
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
  const account = await currentAccount();
  void startSitePresence();
  const gate = gateFor(account, location.hash);
  const url = new URL(location.href);
  const page = pageInPath(url.pathname);
  if (page === 'isos') {
    const { showIsoPage } = await import('./public/iso-page');
    await showIsoPage();
    return;
  }
  const guestHome = url.pathname === '/' && gate.show === 'sign-in';
  if (page === 'maps' || page === 'play' || guestHome || (!page && url.pathname !== '/')) {
    if (page !== 'play') {
      url.pathname = MAPS_PATH;
      history.replaceState(history.state, '', url);
    }
    const { showPublicHome } = await import('./public/home');
    await showPublicHome();
    return;
  }
  if (
    gate.show === 'editor' ||
    (page === 'editor' &&
      gate.show === 'sign-in' &&
      !url.searchParams.has('signin') &&
      !url.searchParams.has('account'))
  ) {
    await enterEditor();
    return;
  }
  const { showLoginPage } = await import('./ui/chrome/login-page');
  showLoginPage(gate);
}

void boot();
