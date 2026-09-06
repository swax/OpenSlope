import type { IncomingMessage } from 'node:http';
import { bootstrapPending } from './bootstrap';
import { holds, isAllowedAuthority, isSameSiteOrigin, isSecureOrigin, requiresAccounts, type Role } from './policy';
import { resolveSession, sessionToken } from './sessions';
import { bearerToken, resolveAccessToken } from './tokens';
import type { PublicUser } from './users';
import { createLogger } from '../log';

const log = createLogger('accounts');

/**
 * Who is making a request, and whether the route they asked for is theirs to have.
 *
 * There is one identity path and one enforcement point. Every route runs below this, always sees a
 * principal, and always has a role checked against it — there is no second shape of request and no
 * "are accounts on" branch anywhere downstream. The only thing configuration changes is `identify`, which is
 * where the principal comes from; everything after it is written once.
 */

/** The owner of an unconfigured server: whoever started the process, which is whoever owns the workspace it
 *  is serving. Frozen, and built from nothing — no file, no record, no lookup that could fail. */
export const OWNER: PublicUser = Object.freeze({
  id: 'owner',
  username: 'owner',
  bio: '',
  role: 'admin' as Role,
  createdAt: '1970-01-01T00:00:00.000Z',
  lastSeenAt: '1970-01-01T00:00:00.000Z',
  availability: 'available',
  disabled: false,
});

/**
 * Who a request is from, and how that was established.
 *
 * `owner` is a server nobody has asked to require accounts: it serves the person running it, as admin, with
 * no sign-in and no enrolment. `member` is a signed-in account on a server that does require them.
 * `anonymous` and `unenrolled` are the two ways a configured server has nobody — no live session, and no
 * admin created yet.
 */
export type Identity =
  | { kind: 'owner'; user: PublicUser }
  | { kind: 'member'; user: PublicUser; sessionId: string; refreshCookie: boolean }
  /** A personal access key — a program, not a browser (docs/046). Its own kind rather than a synthetic
   *  session, because roughly twenty places downstream ask `kind === 'member'` for things a key must not
   *  have: a refreshed cookie, a seat in the session channel, and the account self-service routes that could
   *  mint another key. A separate kind makes every one of them exclude keys by default. */
  | { kind: 'token'; user: PublicUser; tokenId: string }
  | { kind: 'anonymous' }
  | { kind: 'unenrolled' };

export const ownerIdentity = (): Identity => ({ kind: 'owner', user: OWNER });

/**
 * The one branch point in the whole design.
 *
 * A server that has not been configured to require accounts answers `owner` immediately, having touched
 * nothing: no account record, no cookie, no filesystem. That is deliberate — the path that serves somebody
 * their own workspace performs no work that could fail, so it cannot fail. Everything else reads the
 * httpOnly cookie against the server's own session table, which is what makes a revoked session and a
 * changed role take effect on the very next request.
 */
export async function identify(req: IncomingMessage): Promise<Identity> {
  if (!requiresAccounts()) return ownerIdentity();
  if (await bootstrapPending()) return { kind: 'unenrolled' };
  const principal = await resolveSession(sessionToken(req));
  if (principal) {
    return {
      kind: 'member', user: principal.user, sessionId: principal.sessionId,
      refreshCookie: principal.refreshCookie,
    };
  }
  // The cookie is tried FIRST on purpose. A browser that is signed in always has one, so the ordinary path
  // costs nothing new; a key is only looked up for a caller that had no session, which is exactly the
  // program this exists for. It also means a stray `Authorization` header cannot displace a real sign-in.
  const bearer = await resolveAccessToken(bearerToken(req));
  if (bearer) return { kind: 'token', user: bearer.user, tokenId: bearer.tokenId };
  return { kind: 'anonymous' };
}

/** What a route asks for. Every mount names one (`app.ts`), and `public` is enrolment — the only place an
 *  unauthenticated caller is expected, and the only one that guards itself. */
export type Need = Role | 'public';

export type Decision =
  | { allowed: true; identity: Identity }
  | { allowed: false; status: number; body: Record<string, unknown> };

/**
 * Whether this request may proceed, given who it is from.
 *
 * Reads only the identity — never the configuration — so there is exactly one description of what a viewer
 * may do, and it is the same description on a laptop and on a VPS. On an unconfigured server the identity is
 * the admin owner, so every role check passes and the route behaves as it always has.
 */
export function authorize(identity: Identity, need: Need): Decision {
  if (identity.kind === 'unenrolled') {
    // The first-run rule: refuse every request until the one-time admin code has been redeemed. Enrolment is
    // reached as a `public` route, and it is the only one that answers here.
    if (need === 'public') return { allowed: true, identity };
    return {
      allowed: false, status: 503,
      body: {
        error: 'This server has not been enrolled yet — its operator has a one-time admin code in the log.',
        bootstrap: true, accounts: 'required',
      },
    };
  }
  if (need === 'public') return { allowed: true, identity };
  if (identity.kind === 'anonymous') {
    return { allowed: false, status: 401, body: { error: 'Sign in to use this server.', accounts: 'required' } };
  }
  // A personal access key is the account MINUS administration, whatever role that account holds. It lives as
  // plain text in a config file on whatever machine the program runs on (Blender keeps add-on preferences in
  // `userpref.blend`), so the blast radius of a leaked one has to stop short of adding users, changing roles
  // and repointing the workspace. Authoring is recoverable; administration is not.
  if (identity.kind === 'token' && need === 'admin') {
    return {
      allowed: false, status: 403,
      body: {
        error: 'An access key cannot do that — it authors, it does not administer. Sign in to the editor for'
          + ' administration.',
        role: identity.user.role, needs: need, token: true,
      },
    };
  }
  if (!holds(identity.user.role, need)) {
    return {
      allowed: false, status: 403,
      body: {
        error: `That needs the ${need} role; ${identity.user.username} is a ${identity.user.role}.`,
        role: identity.user.role, needs: need,
      },
    };
  }
  return { allowed: true, identity };
}

/**
 * Identify and authorize in one call, and never lock somebody out of their own workspace doing it.
 *
 * The failure rule is the important half. On a server nobody configured for accounts, a fault here resolves
 * to the owner and the request proceeds — refusing somebody access to their own files because an identity
 * layer they never asked for went wrong is not an acceptable failure mode. On a configured server the same
 * fault is a refusal, because there "assume admin on error" would be a way in.
 */
export async function authorizeRequest(req: IncomingMessage, need: Need): Promise<Decision> {
  let identity: Identity;
  try {
    identity = await identify(req);
  } catch (error) {
    if (!requiresAccounts()) {
      log.error('identifying this request failed on a server with no accounts, so it is being served as its'
        + ' owner', { error });
      return { allowed: true, identity: ownerIdentity() };
    }
    log.error('identifying this request failed', { error });
    return { allowed: false, status: 500, body: { error: 'This server could not establish who you are.' } };
  }
  return authorize(identity, need);
}

/** What a login or a redemption is refused with when it arrives over a connection a password should not
 *  cross. Its own function so both endpoints refuse in the same words. */
export function insecureOriginRefusal(req: IncomingMessage): { status: number; body: Record<string, unknown> } | null {
  if (isSecureOrigin(req)) return null;
  return {
    status: 403,
    body: {
      error: 'This server refuses passwords over a plain HTTP connection. Reach it over HTTPS — or, if a '
        + 'reverse proxy is terminating TLS in front of it, start it with --behind-proxy.',
      insecure: true,
    },
  };
}

/** What a write or a socket from a page on another site is refused with, or null when it is same-site or not
 *  from a browser at all. Its own function so the HTTP boundary and both upgrade paths refuse in the same
 *  words. */
export function crossSiteRefusal(req: IncomingMessage): { status: number; body: Record<string, unknown> } | null {
  if (isSameSiteOrigin(req)) return null;
  return {
    status: 403,
    body: { error: 'This server does not accept writes or sockets from a page on another site.', crossSite: true },
  };
}

/** What an HTTP request or upgrade with an unconfigured Host authority is refused with. */
export function authorityRefusal(req: IncomingMessage): { status: number; body: Record<string, unknown> } | null {
  if (isAllowedAuthority(req)) return null;
  return {
    status: 403,
    body: {
      error: 'This API does not accept the requested Host. Configure SLOPESMITH_ALLOWED_HOSTS for editor or hosted DNS names.',
      authority: false,
    },
  };
}
