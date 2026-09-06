import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mintToken, readAccounts, tokenHash, updateAccounts, type AccessTokenRecord } from './store';
import { publicUser, type PublicUser } from './users';

/**
 * Personal access keys: how a program that is not a browser signs in (docs/046).
 *
 * The Blender add-on has no cookie jar, no login form and no session channel. On a loopback server it needs
 * none of that — the identity is the owner — but a hosted one has real accounts, and a program has to say
 * which of them it is. So: a key the author mints in Settings, pastes into the program once, and revokes from
 * the same list when the machine it lives on stops being theirs.
 *
 * Blender is what these were built for and remains the only caller today, but nothing here knows that. A key
 * is an ordinary bearer credential for the whole API — a script, a CI job or another editor carries one the
 * same way — which is why it is called an access key rather than a Blender key everywhere a person reads it.
 *
 * ## What a key is, and what it deliberately is not
 *
 * It is **the account, minus administration**. A key resolves to its user and inherits that user's CURRENT
 * role, so a demotion or a disable takes effect on the very next request exactly as it does for a session —
 * the role is never baked into the credential. What it cannot do is satisfy the `admin` need (`guard.ts`),
 * which is the deliberate cap: a key lives in `userpref.blend` as plain text on whatever machine Blender is
 * installed on, so it must not be able to add users, change roles or repoint the workspace. Authoring is
 * recoverable; administration is not.
 *
 * It is also **not a session**. It carries no cookie, gets no sliding expiry, and `identify` gives it its own
 * `Identity` kind — which is what keeps it out of the session channel, out of `/api/auth`'s self-service
 * routes, and unable to mint another key. Those all test for `member`, and a key is not one.
 *
 * ## The prefix
 *
 * A key reads `slop_<43 urlsafe chars>`. The prefix costs five bytes and buys two things: a secret scanner
 * (GitHub's, or a `grep` over a repository somebody pasted it into) can recognise one on sight, and a person
 * who finds the string in a config file knows what they are looking at instead of deleting it to see.
 */

/** What every minted key begins with, so one is recognisable wherever it turns up. */
export const ACCESS_TOKEN_PREFIX = 'slop_';

/** `lastUsedAt` is written at most this often — a listing wants "yesterday", not a record write per request. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

/** A person can lose track of more than this, and each one is a way in. Refusing past it forces a revoke. */
export const MAX_TOKENS_PER_USER = 10;

/** A key as a listing shows it: everything except the secret, which the server cannot reproduce. */
export interface PublicAccessToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  /** The first few characters of the secret, so a person can tell two keys apart in a list without holding
   *  either. Stored rather than derived, because the digest cannot be turned back into a prefix. */
  hint: string;
}

const publicToken = (record: AccessTokenRecord): PublicAccessToken => ({
  id: record.id, name: record.name, createdAt: record.createdAt,
  ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
  hint: record.id.slice(0, 8),
});

/** The `Authorization: Bearer <key>` a request carries, or undefined. Case-insensitive on the scheme, because
 *  the header's grammar says it is and a Python client is entitled to write it however it likes. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const raw = req.headers.authorization;
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!header) return undefined;
  const space = header.indexOf(' ');
  if (space < 0 || header.slice(0, space).toLowerCase() !== 'bearer') return undefined;
  const value = header.slice(space + 1).trim();
  return value || undefined;
}

export interface TokenPrincipal {
  user: PublicUser;
  tokenId: string;
}

/**
 * Who a key belongs to, or null.
 *
 * Every check the answer depends on is made here and now: the key exists, it has not been revoked, and the
 * account behind it is still enabled. That is the same rule `resolveSession` holds, and for the same reason —
 * a credential that outlives its account must answer nobody.
 */
export async function resolveAccessToken(token: string | undefined): Promise<TokenPrincipal | null> {
  if (!token) return null;
  const accounts = await readAccounts();
  const hash = tokenHash(token);
  const record = accounts.tokens.find(entry => entry.tokenHash === hash);
  if (!record || record.revokedAt) return null;
  const user = accounts.users.find(entry => entry.id === record.userId);
  if (!user || user.disabledAt) return null;
  await touchToken(record);
  return { user: publicUser(user), tokenId: record.id };
}

async function touchToken(record: AccessTokenRecord): Promise<void> {
  const now = Date.now();
  if (record.lastUsedAt && now - Date.parse(record.lastUsedAt) < TOUCH_INTERVAL_MS) return;
  await updateAccounts(draft => {
    const entry = draft.tokens.find(candidate => candidate.id === record.id);
    if (entry) entry.lastUsedAt = new Date(now).toISOString();
  });
}

/** Mint one, returning the ONLY copy of its secret alongside the record. The caller shows it once. */
export async function createAccessToken(userId: string, name: string):
Promise<{ token: string; record: PublicAccessToken }> {
  // Named for what it is, not for its first caller: a key is an ordinary bearer credential for the whole
  // API, and anything speaking HTTP can carry one.
  const label = name.trim().slice(0, 64) || 'Access key';
  const token = `${ACCESS_TOKEN_PREFIX}${mintToken()}`;
  const record: AccessTokenRecord = {
    id: randomUUID(), tokenHash: tokenHash(token), userId, name: label,
    createdAt: new Date().toISOString(),
  };
  await updateAccounts(draft => {
    const live = draft.tokens.filter(entry => entry.userId === userId && !entry.revokedAt);
    if (live.length >= MAX_TOKENS_PER_USER) {
      throw new Error(`that is ${MAX_TOKENS_PER_USER} keys already — revoke one before making another`);
    }
    draft.tokens.push(record);
  });
  return { token, record: publicToken(record) };
}

/** One account's live keys, newest first. */
export async function listAccessTokens(userId: string): Promise<PublicAccessToken[]> {
  return (await readAccounts()).tokens
    .filter(entry => entry.userId === userId && !entry.revokedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicToken);
}

/**
 * Revoke one of an account's own keys.
 *
 * Marked rather than deleted: the record is the only evidence a key ever existed, and "this machine had
 * access until Tuesday" is worth more than the bytes it costs. Scoped to `userId` by the query rather than
 * by the caller, so a member cannot revoke somebody else's key by guessing an id.
 */
export async function revokeAccessToken(userId: string, id: string): Promise<boolean> {
  return updateAccounts(draft => {
    const record = draft.tokens.find(entry => entry.id === id && entry.userId === userId && !entry.revokedAt);
    if (!record) return false;
    record.revokedAt = new Date().toISOString();
    return true;
  });
}

/** Revoke every key an account holds — what disabling a user and changing a password sweep through, beside
 *  the sessions they already revoke. A credential that survived either of those would be the hole. */
export async function revokeUserAccessTokens(userId: string): Promise<number> {
  return updateAccounts(draft => {
    let revoked = 0;
    const at = new Date().toISOString();
    for (const record of draft.tokens) {
      if (record.userId !== userId || record.revokedAt) continue;
      record.revokedAt = at;
      revoked++;
    }
    return revoked;
  });
}
