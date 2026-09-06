import { button, group, menu } from '../components/controls';
import { tooltip } from '../components/tooltip';
import { postJson } from '../../net/fetch-json';
import { currentAccount, onAccountChanged, type Member } from '../../net/account';

/**
 * The account, from inside the editor (docs/038).
 *
 * Everything about GETTING in — enrolling the first admin, redeeming an invite, signing in — happens before
 * the editor exists, on the login page the boot gate shows instead of it (`boot.ts`, `login-page.ts`). By the
 * time this module runs, the server has already accepted this browser, so what is left is a compact identity
 * menu: their profile, Settings, and signing out. Profile editing, device naming, passwords and access keys
 * live together on Settings' Account page rather than growing a second account dialog here.
 *
 * On the loopback server serving somebody's own workspace there is no identity or session to manage. It still
 * gets the Settings button in this same upper-right position, since Settings no longer belongs to File.
 *
 * Managing other people is the CLI (`src/server/main.ts`) and the Users mode.
 */

/** How long a browser may sit on a live editor without an ordinary HTTP request going out. */
const COOKIE_REFRESH_MS = 6 * 60 * 60_000;

/** Signing out reloads, which lands on the boot gate — and the gate, finding no session, answers the login
 *  page. The cookie is going either way, so a refused request is not worth blocking on. */
async function signOut(url: string): Promise<void> {
  try { await postJson(url); } catch { /* the cookie is going either way; the reload settles it */ }
  location.reload();
}

/**
 * Put the account within reach without spending a mode, a shortcut or a slot in the mode row.
 */
function installAccountMenu(user: Member, deps: AccountMenuDeps): void {
  const bar = document.getElementById('dock-top');
  if (!bar) return;
  let current = user;
  const account = menu('', () => [
    {
      label: 'My profile',
      desc: 'See the profile other members see, including your detected devices.',
      onClick: deps.openMyProfile,
    },
    {
      label: 'Settings…',
      desc: 'Edit your account and device, or open application and server settings.',
      onClick: deps.openSettings,
    },
    {
      label: 'Sign out',
      desc: 'End this browser session and return to sign in.',
      onClick: () => void signOut('/api/auth/logout'),
    },
  ]);
  account.el.classList.add('sp-account-menu');
  account.el.setAttribute('aria-label', 'Account menu');
  tooltip(account.el, () => `Signed in as ${current.username} (${current.role}).`);
  const paint = () => {
    account.setLabel(current.username);
  };
  paint();
  onAccountChanged(changed => { current = changed; paint(); });
  bar.append(group(account.el));
}

export interface AccountMenuDeps {
  openMyProfile: () => void;
  openSettings: () => void;
}

/**
 * Boot the identity layer, or discover there is nothing to boot.
 *
 * Called once from `app/main.ts`. It reads the answer the boot gate already has, so it costs no request at
 * all — and on a server with no accounts, where that answer is "owner", it returns having done nothing.
 *
 * The states this used to handle — nobody, and a server waiting to be enrolled — cannot arrive here any more:
 * the gate does not start the editor for them. The one way to reach this module without a member is a probe
 * that failed and was read as "no accounts" (net/account.ts), which is the fail-open rule working as
 * designed, and which this treats exactly as it treats an owner.
 */
export async function installAccounts(deps: AccountMenuDeps): Promise<void> {
  const account = await currentAccount();
  if (!('user' in account)) {
    const bar = document.getElementById('dock-top');
    if (bar) bar.append(group(button('Settings', deps.openSettings, {
      title: 'Application and server settings.',
    })));
    return;
  }
  installAccountMenu(account.user, deps);
  // An open editor may otherwise cross the browser cookie's Max-Age using only WebSocket traffic, which
  // cannot renew a cookie. One ordinary authenticated request keeps an actively used login sliding — and a
  // session that ended anyway reloads into the login page rather than sitting in an editor being refused.
  const refresh = setInterval(() => {
    void fetch('/api/auth/session', { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(response => { if (response.status === 401) location.reload(); })
      .catch(() => { /* a transient outage is the session channel's reconnect problem */ });
  }, COOKIE_REFRESH_MS);
  (refresh as { unref?: () => void }).unref?.();
}
