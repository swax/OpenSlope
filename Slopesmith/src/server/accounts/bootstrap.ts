import { mintToken, readAccounts, tokenHash, updateAccounts } from './store';
import { claimUsername, draftUser, publicUser, type NewUser, type PublicUser } from './users';

/**
 * First run: the one-time admin-enrolment code.
 *
 * The server prints a code to its log and refuses every other request until it is redeemed (docs/038). There
 * is no default password and no window in which whoever finds the URL becomes admin — the machine's own log
 * is the channel, so being able to read it is the qualification.
 *
 * Only the digest is stored, so a code cannot be read back out of the record; a restart or `--new-admin-code`
 * mints a fresh one and prints that instead.
 */

/** Whether the server is still waiting to be enrolled: no admin has ever been created. */
export async function bootstrapPending(): Promise<boolean> {
  return !(await readAccounts()).users.some(user => user.role === 'admin');
}

/**
 * The code to print, or null when there is already an admin.
 *
 * Minted fresh on every start while enrolment is outstanding, deliberately. The record holds a digest, so a
 * code carried across a restart could never be printed again — keeping one printable would mean storing a
 * live credential in plaintext beside the accounts it exists to protect, which is the one thing this file
 * refuses to do. Re-minting instead makes the code's life the process's, so one that leaked into a log or was
 * left on somebody's terminal stops working the moment the server is restarted, and a restart is also how an
 * operator gets a fresh one when the log has scrolled past the last.
 *
 * The cost is real and bounded: a restart invalidates a code somebody was about to type, and the banner
 * carrying its replacement is on screen before they can ask about it.
 */
export async function issueAdminCode(): Promise<string | null> {
  if (!await bootstrapPending()) return null;
  const code = mintToken();
  await updateAccounts(draft => {
    draft.bootstrap = { codeHash: tokenHash(code), createdAt: new Date().toISOString() };
  });
  return code;
}

/**
 * Redeem the code, creating the server's first admin.
 *
 * Exactly once: the record is marked redeemed inside the same locked step that creates the user, and an
 * admin existing is what closes enrolment — so the second attempt with the same code finds neither a live
 * code nor a server that is still waiting for one.
 */
export async function redeemAdminCode(code: string,
  account: Omit<NewUser, 'role' | 'inviteHandle'>): Promise<PublicUser> {
  const accounts = await readAccounts();
  const hash = tokenHash(code);
  // Checked before the scrypt derivation, so a wrong code costs a digest and a comparison.
  if (!accounts.bootstrap || accounts.bootstrap.redeemedAt || accounts.bootstrap.codeHash !== hash)
    throw new Error('That admin-enrolment code is not valid.');
  const user = await draftUser({ ...account, role: 'admin', inviteHandle: 'server:bootstrap' });
  return updateAccounts(draft => {
    if (!draft.bootstrap || draft.bootstrap.redeemedAt || draft.bootstrap.codeHash !== hash)
      throw new Error('That admin-enrolment code is not valid.');
    if (draft.users.some(entry => entry.role === 'admin')) throw new Error('This server already has an admin.');
    claimUsername(draft, user.username);
    draft.bootstrap.redeemedAt = new Date().toISOString();
    draft.bootstrap.redeemedBy = user.username;
    draft.users.push(user);
    return publicUser(user);
  });
}

/** What `main.ts` prints when a server starts with enrolment outstanding. Its own function so the CLI flag
 *  that regenerates the code says exactly the same thing. */
export function adminCodeBanner(code: string, url: string): string {
  return [
    '',
    '  ┌─ Slopesmith is waiting to be enrolled ─────────────────────────────',
    '  │  Every request is refused until an admin account exists.',
    `  │  Open ${url} and enter this one-time code:`,
    '  │',
    `  │      ${code}`,
    '  │',
    '  │  It is shown once — restart, or run with --new-admin-code, for another.',
    '  └────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
