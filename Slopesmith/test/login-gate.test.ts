/**
 * The boot gate: what the browser decides BEFORE it loads the editor (docs/038).
 *
 * `index.html` names `src/app/boot.ts`, not `src/app/main.ts`, because importing main IS booting the editor —
 * it builds the store and constructs the viewport while it is being evaluated. So the question "may this
 * browser use this server" has to be answered first, and the answer decides whether several megabytes of
 * editor are fetched at all or a login page is shown instead.
 *
 * Two ways that decision can be wrong, and they are not symmetric. Answering "editor" for a browser the
 * server will refuse is the old behaviour this replaced: an editor booting into a wall of 401s. Answering
 * "login page" for a server that never asked for accounts is far worse — a password prompt in front of
 * somebody's own workspace, with nothing behind it that a password would open. The probe is deliberately
 * asymmetric about that (net/account.ts), and the last case here is the one that pins it.
 *
 * Everything runs against a REAL service, so what is under test is the pair: the routes a server answers an
 * unknown browser with, and what the browser does with each of them. A relative-URL `fetch` shim stands in
 * for the origin the page would have been served from, and carries the cookie a browser would.
 *
 * Run: tsx test/login-gate.test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiService } from '../src/server/main';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-login-gate-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
const { forgetRateLimits } = await import('../src/server/accounts/rate-limit');
const { configureAccounts } = await import('../src/server/accounts/policy');
const { mintInvite } = await import('../src/server/accounts/invites');
const { startApiService } = await import('../src/server/main');
const { adoptAccount, administersServer, currentAccount, forgetAccount, gateFor, inviteIn } =
  await import('../src/app/net/account');

/**
 * The browser's side of the wire.
 *
 * The client asks for `/api/auth/session` — a same-origin path, which is what it is in a browser and what
 * node's fetch cannot resolve — so the shim supplies the origin, sends whatever cookie this "browser" is
 * holding, and counts what actually went out. `broken` is the failed probe: an API that is not there.
 */
const realFetch = globalThis.fetch;
const browser = { origin: '', cookie: '', calls: 0, broken: false };
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  browser.calls++;
  if (browser.broken) return Promise.reject(new TypeError('fetch failed'));
  const headers = new Headers(init?.headers);
  if (browser.cookie) headers.set('cookie', browser.cookie);
  return realFetch(new URL(String(input), browser.origin), { ...init, headers });
}) as typeof fetch;

/** What boot would do right now, for a page opened at `hash`. Each ask starts from nothing, because the
 *  probe's answer is deliberately asked once per page load and this file is several page loads. */
async function gate(hash = ''): Promise<string> {
  forgetAccount();
  return gateFor(await currentAccount(), hash).show;
}

/** Establish a session the way the login page does, and keep the cookie the way a browser would. */
async function signIn(path: string, body: unknown): Promise<{ status: number; user?: { role: string } }> {
  const response = await realFetch(new URL(path, browser.origin), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const line = response.headers.getSetCookie().find(cookie => cookie.startsWith('slopesmith_session='));
  if (line) browser.cookie = line.split(';')[0];
  return { status: response.status, ...(await response.json().catch(() => ({}))) as { user?: { role: string } } };
}

let service: ApiService | null = null;
try {
  // ---- a server nobody configured for accounts ----
  service = await startApiService({ port: 0, host: '127.0.0.1' });
  browser.origin = `http://127.0.0.1:${service.port}`;

  check(await gate() === 'editor',
    'a server with no accounts boots straight into the editor — there is nothing to sign in to');
  check(await gate('#invite=someone-elses-link') === 'editor',
    'and an invite link pointed at it changes nothing, because it has no accounts to join');
  const owner = await currentAccount();
  check(owner.accounts === 'open',
    'the owner is not a member, so the editor installs no account menu or session refresh');

  await service.close();
  service = null;

  // ---- a server that requires accounts, before anybody has enrolled ----
  forgetAccounts();
  forgetRateLimits();
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: true });
  browser.origin = `http://127.0.0.1:${service.port}`;
  const adminCode = service.adminCode ?? '';

  check(await gate() === 'enrol',
    'a server still waiting for its first admin answers the enrolment form, not a sign-in it cannot honour');
  check(await gate('#invite=cannot-exist-yet') === 'enrol',
    'and enrolment outranks an invite link, because there is nobody yet who could have issued one');

  // ---- enrolled, and this browser is nobody ----
  const enrolled = await signIn('/api/auth/bootstrap',
    { code: adminCode, username: 'Ada', password: 'first admin password' });
  check(enrolled.status === 201 && enrolled.user?.role === 'admin', 'the one-time code creates the first admin');
  const adminCookie = browser.cookie;
  check(adminCookie.startsWith('slopesmith_session='), 'and hands this browser a session cookie');

  browser.cookie = '';
  check(await gate() === 'sign-in',
    'a browser with no session gets the login page — the editor is never fetched for somebody who cannot use it');
  check(await gate('#invite=link-tok-en') === 'redeem',
    'arriving on an invite link opens the form that spends it, rather than a sign-in for an account nobody has yet');

  // ---- signed in ----
  browser.cookie = adminCookie;
  check(await gate() === 'editor', 'a signed-in browser boots the editor');
  const member = await currentAccount();
  check('user' in member && member.user.username === 'ada' && member.user.role === 'admin',
    'carrying the member the server named, so the editor has the chip and the role without asking again');
  check(await administersServer(), 'an admin sees the server-owned settings');

  const invited = await mintInvite({ role: 'viewer', handle: 'discord:grace', by: 'ada' });
  browser.cookie = '';
  check(await gate(`#invite=${invited.token}`) === 'redeem', 'the minted link opens the redemption form');
  const joined = await signIn('/api/auth/redeem',
    { token: invited.token, username: 'Grace', password: 'grace password one' });
  check(joined.status === 201 && joined.user?.role === 'viewer', 'redeeming it creates the account it carried');
  check(await gate() === 'editor' && !(await administersServer()),
    'who then boots the editor as a viewer, and is not offered the settings that belong to the server');

  // A sign-in does not reload any more: the page hands the member it was given straight to the editor, which
  // is one page load instead of two — and it must be THIS browser's member, not a re-probe of the server.
  browser.cookie = '';
  forgetAccount();
  const before = browser.calls;
  adoptAccount({ id: 'u1', username: 'kaz', bio: '', role: 'editor', disabled: false,
    createdAt: '2026-01-01T00:00:00.000Z', lastSeenAt: '2026-01-01T00:00:00.000Z',
    availability: 'available' });
  const adopted = await currentAccount();
  check('user' in adopted && adopted.user.username === 'kaz' && browser.calls === before,
    'the account a sign-in returned becomes this browser\'s, with no second request on the wire');

  // ---- the rule that outranks the rest ----
  browser.broken = true;
  check(await gate() === 'editor',
    'a probe that fails outright boots the editor: a server that answered nothing must never be read as one '
    + 'demanding a password, because that is a wall in front of somebody\'s own workspace');
  browser.broken = false;

  check(inviteIn('') === '' && inviteIn('#invite=abc') === 'abc'
    && inviteIn('#from=mail&invite=a%20b') === 'a b' && inviteIn('#invited=no') === '',
    'the invite token is read out of the fragment — where a credential belongs, since browsers never send it '
    + 'to the server and it stays out of access logs');
} finally {
  globalThis.fetch = realFetch;
  await service?.close();
  configureAccounts({ required: false, behindProxy: false });
  forgetAccounts();
  forgetRateLimits();
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  forgetWorkspaceConfig();
  rmSync(root, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exitCode = 1; }
else console.log('login-gate: all checks passed');
