import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mintToken, readAccounts, tokenHash, updateAccounts, type SessionRecord } from './store';
import { publicUser, type PublicUser } from './users';
import { announceAccountAccessChanged } from './events';

/**
 * Opaque server-side sessions, in an httpOnly cookie.
 *
 * The cookie carries 32 random bytes and nothing else — no claims, no role, no expiry the client could read
 * or the server would have to honour. Everything a request is allowed to do is looked up here, which is what
 * makes "sign out everywhere" and a role change take effect on the very next request instead of whenever a
 * token happens to expire (docs/038). A signed token would have to be believed until then; this can simply
 * be deleted.
 */

export const SESSION_COOKIE = 'slopesmith_session';

/** Long enough that an author is not signed out mid-week, short enough that an abandoned browser stops being
 *  a way in. Renewed as it is used, so a session in daily use never expires under someone. */
const SESSION_TTL_MS = 14 * 24 * 60 * 60_000;

/** `lastSeenAt` is written at most this often. Without it every request is a write of the whole record. */
const TOUCH_INTERVAL_MS = 5 * 60_000;
/** A socket close is useful after a long editing session, but not another account-file write seconds after login. */
const SOCKET_LAST_SEEN_INTERVAL_MS = 60_000;

export interface Principal {
  user: PublicUser;
  sessionId: string;
  /** Re-issue the request's cookie: its server-side sliding expiry was renewed on this resolution. */
  refreshCookie: boolean;
}

/** Start a session and hand back the only copy of its token. */
export async function startSession(userId: string): Promise<string> {
  const token = mintToken();
  const now = Date.now();
  const session: SessionRecord = {
    id: randomUUID(), tokenHash: tokenHash(token), userId,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  await updateAccounts(draft => {
    // Sweep what has already lapsed on the way past, so the record does not grow a tail of dead sessions.
    draft.sessions = draft.sessions.filter(entry => Date.parse(entry.expiresAt) > now);
    draft.sessions.push(session);
    const user = draft.users.find(entry => entry.id === userId);
    if (user) user.lastSeenAt = session.lastSeenAt;
  });
  return token;
}

/**
 * Who is making this request, or null.
 *
 * Every check the answer depends on is made here and now: the session exists, it has not lapsed, and the
 * account behind it is still enabled. A disabled account's sessions are dropped when it is disabled, and
 * this is the second half of that — a session that outlives its user answers nobody.
 */
export async function resolveSession(token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const accounts = await readAccounts();
  const hash = tokenHash(token);
  const session = accounts.sessions.find(entry => entry.tokenHash === hash);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return null;
  const user = accounts.users.find(entry => entry.id === session.userId);
  if (!user || user.disabledAt) return null;
  const refreshCookie = await touchSession(session);
  return { user: publicUser(user), sessionId: session.id, refreshCookie };
}

/** Record that a session is still in use, and push its expiry out with it. Throttled, because otherwise the
 *  record is rewritten once per request. */
async function touchSession(session: SessionRecord): Promise<boolean> {
  const now = Date.now();
  if (now - Date.parse(session.lastSeenAt) < TOUCH_INTERVAL_MS) return false;
  return await updateAccounts(draft => {
    const entry = draft.sessions.find(candidate => candidate.id === session.id);
    if (!entry) return false;
    entry.lastSeenAt = new Date(now).toISOString();
    entry.expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
    const user = draft.users.find(candidate => candidate.id === entry.userId);
    if (user) user.lastSeenAt = entry.lastSeenAt;
    return true;
  });
}

/** End one session — the sign-out on this machine. */
export async function revokeSession(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const hash = tokenHash(token);
  let accountSessionId = '';
  const revoked = await updateAccounts(draft => {
    const session = draft.sessions.find(entry => entry.tokenHash === hash);
    accountSessionId = session?.id ?? '';
    const user = session && draft.users.find(entry => entry.id === session.userId);
    if (user) user.lastSeenAt = new Date().toISOString();
    const before = draft.sessions.length;
    draft.sessions = draft.sessions.filter(entry => entry.tokenHash !== hash);
    return draft.sessions.length !== before;
  });
  if (revoked && accountSessionId) announceAccountAccessChanged({ kind: 'session-revoked', accountSessionId });
  return revoked;
}

/** End every session an account holds — the sign-out everywhere, and what a password change and a disable
 *  both do on the way through. */
export async function revokeUserSessions(userId: string): Promise<number> {
  const revoked = await updateAccounts(draft => {
    const before = draft.sessions.length;
    draft.sessions = draft.sessions.filter(entry => entry.userId !== userId);
    const user = draft.users.find(entry => entry.id === userId);
    if (user) user.lastSeenAt = new Date().toISOString();
    return before - draft.sessions.length;
  });
  // Publish even when the account file already held no session: a socket authenticated before an unusual
  // partial failure is still authority that a sign-out-everywhere explicitly asked to end.
  announceAccountAccessChanged({ kind: 'user-revoked', userId });
  return revoked;
}

export async function countUserSessions(userId: string): Promise<number> {
  const now = Date.now();
  return (await readAccounts()).sessions
    .filter(entry => entry.userId === userId && Date.parse(entry.expiresAt) > now).length;
}

/** Persist the end of live browser activity, including a WebSocket-only editing session. */
export async function recordUserLastSeen(userId: string, at = new Date().toISOString()): Promise<void> {
  const recorded = (await readAccounts()).users.find(entry => entry.id === userId)?.lastSeenAt;
  if (!recorded || Date.parse(at) - Date.parse(recorded) < SOCKET_LAST_SEEN_INTERVAL_MS) return;
  await updateAccounts(draft => {
    const user = draft.users.find(entry => entry.id === userId);
    if (user && Date.parse(at) > Date.parse(user.lastSeenAt)) user.lastSeenAt = at;
  });
}

/** One cookie out of a request's `cookie` header. */
export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export const sessionToken = (req: IncomingMessage): string | undefined => readCookie(req, SESSION_COOKIE);

/**
 * Hand the session to the browser and to nothing else.
 *
 * `HttpOnly` keeps it out of script, so a cross-site script injection cannot read it. `SameSite=Lax` keeps
 * it off cross-site writes. `Secure` is set when the request actually arrived over TLS — on a loopback
 * development server it is omitted, because a cookie marked Secure over plain http is one the browser drops
 * and the sign-in silently fails.
 */
export function setSessionCookie(res: ServerResponse, token: string, secure: boolean): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
    + `; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
