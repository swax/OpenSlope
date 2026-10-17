import { clientFetch } from '../../net/client';
import { button, group, iconBar, menu, type MenuItem } from '../components/controls';
import { svg } from '../components/icons';
import { tooltip } from '../components/tooltip';
import { postJson } from '../../net/fetch-json';
import { currentAccount, onAccountChanged, type Member } from '../../net/account';
import { isLocalWorkspace } from '../../net/workspace';
import { MAPS_PATH, pageInPath } from '../../navigation';

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
  try {
    await postJson(url);
  } catch {
    /* the cookie is going either way; the reload settles it */
  }
  const destination = new URL(location.href);
  if (pageInPath(destination.pathname) === 'editor') destination.searchParams.set('signin', '1');
  location.assign(destination);
}

/**
 * Put the account within reach without spending a mode, a shortcut or a slot in the mode row.
 */
export function createAccountMenu(user: Member, deps: AccountMenuDeps): HTMLButtonElement {
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
    ...(deps.editorAction ? [deps.editorAction] : []),
    {
      label: 'Sign out',
      desc: 'End this browser session and return to sign in.',
      onClick: () => void signOut('/api/auth/logout'),
    },
  ]);
  account.el.classList.add('sp-account-menu');
  account.el.setAttribute('aria-label', 'Account menu');
  tooltip(account.el, () => `Signed in as ${current.username} (${current.role}).`);
  // A narrow bar trades the name for its initial (`sp-fit-account`, top-bar.ts); CSS picks which one shows.
  const initial = document.createElement('span');
  initial.className = 'sp-menu-btn-icon sp-account-initial';
  account.el.appendChild(initial);
  const paint = () => {
    account.setLabel(current.username);
    initial.textContent = [...current.username][0]?.toUpperCase() ?? '?';
  };
  paint();
  onAccountChanged(changed => {
    current = changed;
    paint();
  });
  return account.el;
}

export interface AccountMenuDeps {
  openMyProfile: () => void;
  openSettings: () => void;
  editorAction?: MenuItem;
}

/**
 * Boot the identity layer, or discover there is nothing to boot.
 *
 * Called once from `app/main.ts`. It reads the answer the boot gate already has, so it costs no request at
 * all — and on a server with no accounts, where that answer is "owner", it returns having done nothing.
 *
 * Signed-out browser workspaces get Home. A signed-in member keeps their account menu in every workspace.
 */
export async function installAccounts(deps: AccountMenuDeps): Promise<void> {
  const account = await currentAccount();
  if (isLocalWorkspace() && !('user' in account)) {
    const home = group(
      iconBar([
        {
          icon: svg('<path d="m3 10 9-7 9 7v11H3Z"/><path d="M9 21v-8h6v8"/>'),
          label: 'Home',
          title: 'Save pending changes and return to Maps.',
          onClick: deps.editorAction?.onClick ?? (() => location.assign(MAPS_PATH)),
        },
      ]).el,
    );
    home.classList.add('sp-home-control');
    document.getElementById('dock-top')?.append(home);
    return;
  }
  if (!('user' in account)) {
    const bar = document.getElementById('dock-top');
    // File ▸ Settings… reaches the same dialog, so a narrow bar drops this button (`sp-fit-account`).
    if (bar)
      bar.append(
        group(
          button('Settings', deps.openSettings, {
            title: 'Application and server settings.',
            cls: 'sp-settings-btn',
          }),
        ),
      );
    return;
  }
  const accountControl = group(createAccountMenu(account.user, deps));
  accountControl.classList.add('sp-account-control');
  document.getElementById('dock-top')?.append(accountControl);
  // An open editor may otherwise cross the browser cookie's Max-Age using only WebSocket traffic, which
  // cannot renew a cookie. One ordinary authenticated request keeps an actively used login sliding — and a
  // session that ended anyway reloads into the login page rather than sitting in an editor being refused.
  const refresh = setInterval(() => {
    void clientFetch('/api/auth/session', { cache: 'no-store', headers: { accept: 'application/json' } })
      .then(response => {
        if (response.status === 401) location.reload();
      })
      .catch(() => {
        /* a transient outage is the session channel's reconnect problem */
      });
  }, COOKIE_REFRESH_MS);
  (refresh as { unref?: () => void }).unref?.();
}
