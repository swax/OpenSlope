/**
 * Who this browser is on the server it talks to (docs/038).
 *
 * This is the boot gate's entire input. `src/app/boot.ts` asks it BEFORE the editor module exists, so a
 * server that requires accounts and does not recognise this browser answers a login page rather than an
 * editor booting behind a dialog with every one of its requests being refused.
 *
 * It lives apart from the sign-in UI it used to sit inside so that asking costs one fetch and nothing else —
 * no lil-gui, no project sync, no viewport. That is the whole point of asking first: at the moment this runs,
 * nothing expensive has loaded yet, and whether anything expensive SHOULD load is what the answer decides.
 */
import type { ManualAvailability } from '../../core/session/member-status';

export type Role = 'admin' | 'moderator' | 'editor' | 'viewer';

export interface Member {
  id: string;
  username: string;
  bio: string;
  role: Role;
  createdAt: string;
  lastSeenAt: string;
  availability: ManualAvailability;
  disabled: boolean;
  profilePictureUrl?: string;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
}

export interface EquipmentDesignSummary {
  id: string;
  name: string;
  createdAt: string;
  textureUrl: string;
}

export interface EquipmentLibrarySummary {
  selectedId?: string;
  designs: EquipmentDesignSummary[];
}

export interface EquipmentProfile {
  edgeColor: string;
  snowboard: EquipmentLibrarySummary;
  skis: EquipmentLibrarySummary;
}

/** What the server says about this browser: it is the owner of a server with no accounts, it is a signed-in
 *  member, it is nobody, or the server is still waiting to be enrolled. */
export type Account =
  | { accounts: 'open' }
  | { accounts: 'required'; bootstrap: true }
  | { accounts: 'required'; user: Member }
  | { accounts: 'required' };

interface SessionBody { accounts?: string; bootstrap?: boolean; user?: Member }

/**
 * Ask who this browser is.
 *
 * Anything other than a server that positively says it requires accounts is read as one that does not,
 * including a failed request and a build served with no API behind it. That asymmetry is deliberate, and it
 * matters more now than it did as a dialog: reading a broken probe as "no accounts" costs an editor whose
 * requests are refused and say so, while reading it as "accounts" would put a login PAGE in front of somebody
 * else's own workspace — a wall with nothing behind it, on a server that never asked for one.
 */
async function probeAccount(): Promise<Account> {
  try {
    const response = await fetch('/api/auth/session', { headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => ({})) as SessionBody;
    if (body.accounts !== 'required') return { accounts: 'open' };
    if (response.ok && body.user) return { accounts: 'required', user: body.user };
    return body.bootstrap ? { accounts: 'required', bootstrap: true } : { accounts: 'required' };
  } catch { return { accounts: 'open' }; }
}

/** The probe's answer, asked once. `boot.ts` runs it before anything else; everything that later needs to
 *  know who this browser is reads the same answer rather than putting a second request on the wire. */
let asked: Promise<Account> | null = null;
const accountListeners = new Set<(user: Member) => void>();

/** Who this browser is, as the boot probe found it. Resolved before the editor module is even fetched. */
export function currentAccount(): Promise<Account> {
  return asked ??= probeAccount();
}

/**
 * Take a sign-in's own answer as the current one.
 *
 * The login page holds the member the server just returned, so the editor it then starts must not go back and
 * ask again — and must not be left holding the "nobody" the probe found a moment before the password was
 * accepted. Called by the login page in place of the page reload this used to need.
 */
export function adoptAccount(user: Member): void {
  asked = Promise.resolve({ accounts: 'required', user });
  for (const listener of accountListeners) listener(user);
}

/** Hear profile presentation edits made in this tab without re-probing the server. */
export function onAccountChanged(listener: (user: Member) => void): () => void {
  accountListeners.add(listener);
  return () => accountListeners.delete(listener);
}

/** Forget the probe's answer, so the next ask goes back to the server. For checks, which run several servers
 *  past one module instance. */
export function forgetAccount(): void {
  asked = null;
}

/**
 * Whether this browser may see the settings that belong to the SERVER rather than to the person at it.
 *
 * On a server with no accounts that is whoever is running it — their own machine, their own folders. On one
 * with accounts it is an admin and nobody else, which is what `/api/config` enforces regardless (server/
 * app.ts); this only keeps the editor from offering a field it knows the server will refuse.
 */
export async function administersServer(): Promise<boolean> {
  const account = await currentAccount();
  return account.accounts === 'open' || ('user' in account && account.user.role === 'admin');
}

/** The invite token carried in a URL fragment, if the person arrived by link. A fragment rather than a query
 *  because it is a credential: browsers do not send it to the server, and it stays out of access logs. */
export function inviteIn(hash: string): string {
  const match = /(?:^|[#&])invite=([^&]+)/.exec(hash);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * What boot does with an answer: start the editor, or show one of the three ways in.
 *
 * Pure, and separate from the page that renders it, because this is the decision worth being sure about —
 * "editor" for a browser the server has not accepted is a wall of 401s, and a login page for a server with no
 * accounts is somebody locked out of their own files. A function over a value can be checked in a test
 * without a browser (`test/login-gate.test.ts`); a branch inside a DOM entry point cannot.
 */
export type Gate =
  | { show: 'editor' }
  | { show: 'enrol' }
  | { show: 'redeem'; invite: string }
  | { show: 'sign-in' };

export function gateFor(account: Account, hash: string): Gate {
  if (account.accounts === 'open' || 'user' in account) return { show: 'editor' };
  // Enrolment outranks an invite: a server with no admin yet cannot redeem one, because there is nobody to
  // have issued it. Whoever is holding a link at that moment needs the one-time code, not this form.
  if ('bootstrap' in account) return { show: 'enrol' };
  const invite = inviteIn(hash);
  return invite ? { show: 'redeem', invite } : { show: 'sign-in' };
}
