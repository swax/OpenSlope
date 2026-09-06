import GUI from 'lil-gui';
import { installStyles } from '../components/styles';
import { banner, errorLine, focusField, named, secret, submitOnEnter } from '../components/credential-fields';
import { postJson } from '../../net/fetch-json';
import { adoptAccount, type Gate, type Member } from '../../net/account';
import { enterEditor } from '../../enter-editor';

/**
 * The page a server with accounts answers somebody it does not know yet (docs/038).
 *
 * It is a PAGE rather than a dialog over the editor, and that is the whole design: `boot.ts` asks who this
 * browser is before the editor module is fetched, so nobody who cannot use this server downloads it, boots
 * it, or watches every library it opens come back 401. What is on the screen is then true — there is no map
 * behind the form, because there is no map this browser may have.
 *
 * Three ways in, and they are the same three routes the server answers without a session: enrol the first
 * admin with the one-time code from the log, redeem an invite, and sign in. Everything else about an account
 * — changing a password, signing out, who else is here — belongs to the editor and lives there (sign-in.ts,
 * users-mode.ts), because all of it needs a session this page exists to establish.
 *
 * A password accepted here does NOT reload. The editor has not booted, so there is nothing stale to throw
 * away: the member the server just returned becomes this browser's account and the editor starts on top of
 * it, which is one page load instead of two and no flash of a second boot.
 */

const CSS = `
.sp-login { position: fixed; inset: 0; z-index: 80; box-sizing: border-box; display: grid; place-items: center;
  padding: 24px 16px; overflow: auto;
  background: radial-gradient(125% 90% at 50% 0, #14304a 0%, #0a1622 58%, #060d14 100%); }
.sp-login-card { width: 340px; max-width: 92vw; }
.sp-login-head { display: flex; align-items: center; gap: 11px; margin: 0 2px 13px; }
.sp-login-head img { display: block; flex: 0 0 auto; width: auto; height: 36px; }
.sp-login-head b { display: block; color: #eef7ff;
  font: 600 19px/1.15 ui-sans-serif, system-ui, sans-serif; letter-spacing: .01em; }
.sp-login-head span { display: block; margin-top: 2px; color: #7f9cb4;
  font: 11px/1.4 ui-sans-serif, system-ui, sans-serif; }
.sp-login-card .lil-gui.lil-root { width: 100%; }
.sp-login-foot { margin: 11px 4px 0; color: #5f7b93; text-align: center;
  font: 10.5px/1.5 ui-sans-serif, system-ui, sans-serif; }
.sp-login-done { padding: 11px 12px; color: #d5eee0; background: #14301f; border: 1px solid #2f6142;
  border-left: 3px solid #4f9f6c; border-radius: 5px; font: 12px/1.5 ui-sans-serif, system-ui, sans-serif; }
`;

/**
 * The card, cleared of whatever form was in it, wearing the app's mark and this form's name.
 *
 * The page swaps its form in place — somebody who opened an invite link but already has an account, or the
 * other way round, should not have to find a different URL to say so. `body` is what a form fills: the mark
 * stays above it, because `banner` inserts itself at the top of whatever it is given and the explanation
 * belongs under the name of the thing, not over it.
 */
function card(page: HTMLElement, tab: string, subtitle: string): { host: HTMLElement; body: HTMLElement } {
  document.title = `${tab} · Slopesmith`;
  page.replaceChildren();
  const host = document.createElement('div');
  host.className = 'sp-login-card';
  const head = document.createElement('div');
  head.className = 'sp-login-head';
  const mark = document.createElement('img');
  mark.src = '/slopesmith_icon_light.svg';
  mark.alt = '';
  const text = document.createElement('div');
  const name = document.createElement('b');
  name.textContent = 'Slopesmith';
  const line = document.createElement('span');
  line.textContent = subtitle;
  text.append(name, line);
  head.append(mark, text);
  const body = document.createElement('div');
  host.append(head, body);
  page.append(host);
  return { host, body };
}

/** The line under the card. It names the one thing this page cannot tell somebody who is stuck: that an
 *  account here is issued by whoever runs this server, and there is no self-service way around that. */
function foot(host: HTMLElement, text: string): void {
  const el = document.createElement('div');
  el.className = 'sp-login-foot';
  el.textContent = text;
  host.append(el);
}

/**
 * A password was accepted: hold the account the server returned, say who it belongs to, and start the editor.
 *
 * The confirmation is worth the beat it costs. Signing in is the one moment somebody learns what they are on
 * this server — a viewer who follows read-only and an editor who may change maps see the same screen until
 * something refuses them — so their role is said once, plainly, before the map takes the window.
 */
function entered(page: HTMLElement, user: Member, message: string): void {
  adoptAccount(user);
  const { body } = card(page, 'Signed in', 'Starting the editor…');
  const done = document.createElement('div');
  done.className = 'sp-login-done';
  done.setAttribute('role', 'status');
  done.textContent = message;
  body.append(done);
  // One frame, so the line above is actually on the screen before the editor's own boot takes the main
  // thread. Removing the page immediately would make it a flicker, which is worse than not showing it.
  requestAnimationFrame(() => void (async () => {
    await enterEditor();
    page.remove();
  })());
}

/** The first admin: the one-time code the server printed to its log, and the account it becomes. */
function enrolForm(page: HTMLElement): void {
  const { host, body } = card(page, 'Enrol', 'This server has no admin yet');
  const g = new GUI({ container: body, title: 'Enrol this server' });
  banner(body, 'This server has no admin yet, so it is refusing every request. Whoever started it has a '
    + 'one-time code in its log — that code and this form create the first account, which manages users, '
    + 'invites and maps.');
  const form = { code: '', username: '', password: '', confirm: '' };
  focusField(named(g.add(form, 'code').name('admin code'), 'off'));
  named(g.add(form, 'username').name('username'), 'username');
  secret(g.add(form, 'password').name('password'), 'new-password');
  secret(g.add(form, 'confirm').name('repeat password'), 'new-password');
  const fail = errorLine(body);
  const submit = () => void (async () => {
    if (form.password !== form.confirm) { fail('Those two passwords are different.'); return; }
    try {
      const { user } = await postJson<{ user: Member }>('/api/auth/bootstrap', JSON.stringify(form));
      entered(page, user, `Enrolled as ${user.username} — this server's admin.`);
    } catch (error) { fail(String(error instanceof Error ? error.message : error)); }
  })();
  g.add({ enrol: submit }, 'enrol').name('Create the admin account');
  foot(host, 'The code is printed once, when the server starts. Restart it to be given another.');
  submitOnEnter(host, submit);
}

/** Redeeming an invite: the link is the credential, and the role travels with it. */
function redeemForm(page: HTMLElement, token: string): void {
  const { host, body } = card(page, 'Redeem your invite', 'You have been invited');
  const g = new GUI({ container: body, title: 'Redeem your invite' });
  banner(body, 'Choose a username and a password. They work from any machine — there is nothing to move '
    + 'between computers. The invite decides what you may do here, and it can only be redeemed once.');
  const form = { token, username: '', password: '', confirm: '' };
  named(g.add(form, 'token').name('invite token'), 'off');
  focusField(named(g.add(form, 'username').name('username'), 'username'));
  secret(g.add(form, 'password').name('password'), 'new-password');
  secret(g.add(form, 'confirm').name('repeat password'), 'new-password');
  const fail = errorLine(body);
  const submit = () => void (async () => {
    if (form.password !== form.confirm) { fail('Those two passwords are different.'); return; }
    try {
      const { user } = await postJson<{ user: Member }>('/api/auth/redeem', JSON.stringify(form));
      // The link is spent. Clearing it keeps a reload from re-offering a token that can no longer be redeemed,
      // and keeps it out of the address bar of a browser that is now signed in.
      history.replaceState(null, '', location.pathname + location.search);
      entered(page, user, `Welcome, ${user.username} — you are a ${user.role} here.`);
    } catch (error) { fail(String(error instanceof Error ? error.message : error)); }
  })();
  g.add({ redeem: submit }, 'redeem').name('Create my account');
  g.add({ back: () => signInForm(page) }, 'back').name('I already have an account');
  submitOnEnter(host, submit);
}

/** Signing in, which is the same pair of fields from any machine. */
function signInForm(page: HTMLElement): void {
  const { host, body } = card(page, 'Sign in', 'A private server — sign in to carry on');
  const g = new GUI({ container: body, title: 'Sign in' });
  banner(body, 'This server is private and invite-only. Sign in with the username and password you chose '
    + 'when you redeemed your invite.');
  const form = { username: '', password: '' };
  focusField(named(g.add(form, 'username').name('username'), 'username'));
  secret(g.add(form, 'password').name('password'), 'current-password');
  const fail = errorLine(body);
  const submit = () => void (async () => {
    try {
      const { user } = await postJson<{ user: Member }>('/api/auth/login', JSON.stringify(form));
      entered(page, user, `Signed in as ${user.username} — you are a ${user.role} here.`);
    } catch (error) { fail(String(error instanceof Error ? error.message : error)); }
  })();
  g.add({ signIn: submit }, 'signIn').name('Sign in');
  g.add({ invite: () => redeemForm(page, '') }, 'invite').name('I have an invite link');
  foot(host, 'Accounts here are created from an invite. Whoever runs this server issues one — and resets a '
    + 'password nobody can remember.');
  submitOnEnter(host, submit);
}

/**
 * Take the page, in place of the editor.
 *
 * Called by `boot.ts` and by nothing else. It removes the boot splash index.html ships with — it is the
 * editor's progress, and there is no editor loading — and does not put it back; `enterEditor` does that at
 * the moment there is something to show progress for.
 */
export function showLoginPage(gate: Gate): void {
  installStyles('login', CSS);
  document.getElementById('load-status')?.classList.remove('show');
  const page = document.createElement('div');
  page.className = 'sp-login';
  document.body.append(page);
  if (gate.show === 'enrol') enrolForm(page);
  else if (gate.show === 'redeem') redeemForm(page, gate.invite);
  else signInForm(page);
}
