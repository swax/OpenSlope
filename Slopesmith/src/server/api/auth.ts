import type { IncomingMessage, ServerResponse } from 'node:http';
import { redeemAdminCode } from '../accounts/bootstrap';
import { OWNER, identify, insecureOriginRefusal, type Identity } from '../accounts/guard';
import {
  DEFAULT_INVITE_DAYS, listInvites, mintInvite, redeemInvite, revokeInvite,
} from '../accounts/invites';
import { generatePassword, verifyPassword } from '../accounts/passwords';
import {
  clientAddress, holds, isOrdinaryRole, isRole, isSecureOrigin, requiresAccounts, type Role,
} from '../accounts/policy';
import {
  LOGIN_LIMIT, REDEEM_LIMIT, clearFailures, recordFailure, throttledFor,
} from '../accounts/rate-limit';
import {
  clearSessionCookie, revokeSession, revokeUserSessions, sessionToken, setSessionCookie, startSession,
} from '../accounts/sessions';
import { readAccounts } from '../accounts/store';
import { createAccessToken, listAccessTokens, revokeAccessToken } from '../accounts/tokens';
import {
  AccountAdministrationError, equipmentProfile, findUserRecord, listUsers, publicUser, setUserDisabled,
  setUserAvailability, setUserBio, setUserEquipment, setUserInviteHandle, setUserPassword,
  setUserProfilePicture, setUserRole, setUserUsername, type PublicUser,
} from '../accounts/users';
import type { ApiRequest } from './request';
import { createLogger } from '../log';
import { listProjects } from '../projects';
import { liveSessions } from '../session/presence';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';
import {
  effectiveMemberStatus, type ManualAvailability, type MemberStatus,
} from '../../core/session/member-status';

/**
 * Accounts over HTTP (docs/038): enrolment, sign-in, a member's own password — and the roster the Users mode
 * reads, with the administration a server's admin does from inside the editor.
 *
 * Everything here that takes a password refuses a non-secure origin first, counts its failures second, and
 * does the expensive work third, so a caller who cannot get past either of the first two never reaches a
 * scrypt derivation.
 *
 * On a server nobody configured for accounts the sign-in routes have nothing to do: the request is already
 * the owner's, and they say so rather than offering a sign-in to a server with no members. The roster still
 * answers there, with the one member such a server has — a room of one, which is what editing alone is.
 *
 * The CLI (`src/server/main.ts`) remains the source of truth and always works, including when nothing can
 * connect. `/api/members` is the same set of actions reached from a chair rather than a terminal, because the
 * person running a server is usually an author rather than an administrator.
 */

const log = createLogger('accounts');
const AUTH_BODY_LIMIT = 8 * 1024;
/** A 256 KB image expands by one third in JSON base64, with a little room for the envelope. */
const PROFILE_PICTURE_BODY_LIMIT = 384 * 1024;
/** Two 1 MB images can expand by one third when both slots are staged before the same Save. */
const EQUIPMENT_BODY_LIMIT = 3 * 1024 * 1024;

interface AuthBody {
  username?: unknown; password?: unknown;
  token?: unknown; code?: unknown; current?: unknown; next?: unknown;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';

/** How this server establishes who somebody is, as the sign-in view reads it: `open` is a server serving its
 *  owner, with nothing to sign in to. */
const shape = (identity: Identity): 'open' | 'required' => identity.kind === 'owner' ? 'open' : 'required';

/** What every route here answers when there is nobody to sign in as. */
const NO_ACCOUNTS = 'This server has no accounts — it serves whoever is running it. Start it with --accounts'
  + ' to require a sign-in.';

/** A throttled endpoint answers 429 with how long the wait is, rather than making the caller guess. */
function throttleRefusal(bucket: string, limit: typeof LOGIN_LIMIT): { status: number; body: Record<string, unknown> } | null {
  const wait = throttledFor(bucket, limit);
  if (!wait) return null;
  const seconds = Math.ceil(wait / 1000);
  return { status: 429, body: { error: `Too many failed attempts — try again in ${seconds}s.`, retryAfter: seconds } };
}

/** Sign the user in on this browser: a fresh opaque session, in an httpOnly cookie. */
async function grantSession(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
  setSessionCookie(res, await startSession(userId), isSecureOrigin(req));
}

async function handleLogin(req: IncomingMessage, res: ServerResponse, body: AuthBody,
  identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  const insecure = insecureOriginRefusal(req);
  if (insecure) { jsonResponse(res, insecure.status, insecure.body); return; }

  const address = clientAddress(req);
  const username = text(body.username).trim().toLowerCase();
  const buckets = [`login:${address}`, `login:user:${username}`];
  for (const bucket of buckets) {
    const throttled = throttleRefusal(bucket, LOGIN_LIMIT);
    if (throttled) { jsonResponse(res, throttled.status, throttled.body); return; }
  }

  const user = findUserRecord(await readAccounts(), username);
  // The same answer either way: which half was wrong is not something an unauthenticated caller is owed,
  // because it is exactly the answer that turns guessing a password into first enumerating usernames.
  const ok = !!user && !user.disabledAt && await verifyPassword(text(body.password), user.password);
  if (!ok || !user) {
    for (const bucket of buckets) {
      recordFailure(bucket, LOGIN_LIMIT, `failed sign-in for ${username || '(no username)'} from ${address}`);
    }
    jsonResponse(res, 401, { error: 'That username and password do not match an account here.' });
    return;
  }
  for (const bucket of buckets) clearFailures(bucket);
  await grantSession(req, res, user.id);
  jsonResponse(res, 200, { accounts: 'required', user: publicUser(user) });
}

async function handleRedeem(req: IncomingMessage, res: ServerResponse, body: AuthBody,
  identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  const insecure = insecureOriginRefusal(req);
  if (insecure) { jsonResponse(res, insecure.status, insecure.body); return; }

  const address = clientAddress(req);
  const bucket = `redeem:${address}`;
  const throttled = throttleRefusal(bucket, REDEEM_LIMIT);
  if (throttled) { jsonResponse(res, throttled.status, throttled.body); return; }

  try {
    const user = await redeemInvite(text(body.token).trim(), {
      username: text(body.username), password: text(body.password),
    });
    clearFailures(bucket);
    await grantSession(req, res, user.id);
    jsonResponse(res, 201, { accounts: 'required', user });
  } catch (error) {
    recordFailure(bucket, REDEEM_LIMIT, `failed invite redemption from ${address}`);
    jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
  }
}

/** The one route that does anything while a server is still waiting for its first admin. */
async function handleBootstrap(req: IncomingMessage, res: ServerResponse, body: AuthBody,
  identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  const insecure = insecureOriginRefusal(req);
  if (insecure) { jsonResponse(res, insecure.status, insecure.body); return; }

  const address = clientAddress(req);
  const bucket = `bootstrap:${address}`;
  const throttled = throttleRefusal(bucket, REDEEM_LIMIT);
  if (throttled) { jsonResponse(res, throttled.status, throttled.body); return; }

  try {
    const user = await redeemAdminCode(text(body.code).trim(), {
      username: text(body.username), password: text(body.password),
    });
    clearFailures(bucket);
    await grantSession(req, res, user.id);
    log.info(`${user.username} enrolled as this server's admin`);
    jsonResponse(res, 201, { accounts: 'required', user });
  } catch (error) {
    recordFailure(bucket, REDEEM_LIMIT, `failed admin enrolment from ${address}`);
    jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
  }
}

/** A member changing their own password. The current one is required, so a browser left open on someone
 *  else's desk cannot lock them out of their own account. */
async function handlePassword(req: IncomingMessage, res: ServerResponse, body: AuthBody,
  identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  if (identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in first.', accounts: 'required' }); return;
  }
  const insecure = insecureOriginRefusal(req);
  if (insecure) { jsonResponse(res, insecure.status, insecure.body); return; }

  const record = findUserRecord(await readAccounts(), identity.user.username);
  if (!record || !await verifyPassword(text(body.current), record.password)) {
    recordFailure(`login:user:${identity.user.username}`, LOGIN_LIMIT,
      `failed password change for ${identity.user.username} from ${clientAddress(req)}`);
    jsonResponse(res, 403, { error: 'That is not your current password.' });
    return;
  }
  try {
    // Changing a password ends every session it protected, including this one, so the browser is signed back
    // in on the new one straight away rather than being dropped for doing the right thing.
    await setUserPassword(record.username, text(body.next));
    await grantSession(req, res, record.id);
    jsonResponse(res, 200, { accounts: 'required', user: publicUser(record), changed: true });
  } catch (error) {
    jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
  }
}

/** A signed-in member setting their own public picture. Unlike a password, this changes no credential and
 *  leaves every session alive; the profile event refreshes open member lists. */
async function handleProfilePicture(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  if (identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in first.', accounts: 'required' }); return;
  }
  const body = await readJsonBody(req, PROFILE_PICTURE_BODY_LIMIT) as { profilePicture?: unknown };
  const user = await setUserProfilePicture(identity.user.username, body.profilePicture);
  jsonResponse(res, 200, { accounts: 'required', user });
}

/** A member owns their public username. Stable relationships continue to use the account UUID underneath. */
async function handleUsername(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  if (identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in first.', accounts: 'required' }); return;
  }
  const body = await readJsonBody(req, AUTH_BODY_LIMIT) as { username?: unknown };
  const user = await setUserUsername(identity.user.username, body.username);
  jsonResponse(res, 200, { accounts: 'required', user });
}

/** A member owns the short public text shown in their profile. */
async function handleBio(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  if (identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in first.', accounts: 'required' }); return;
  }
  const body = await readJsonBody(req, AUTH_BODY_LIMIT) as { bio?: unknown };
  const user = await setUserBio(identity.user.username, body.bio);
  jsonResponse(res, 200, { accounts: 'required', user });
}

/** A member's explicit availability follows their account across devices. Automatic idle travels by socket. */
async function handleAvailability(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  if (identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in first.', accounts: 'required' }); return;
  }
  const body = await readJsonBody(req, AUTH_BODY_LIMIT) as { availability?: unknown };
  const user = await setUserAvailability(identity.user.username, body.availability);
  jsonResponse(res, 200, { accounts: 'required', user });
}

/** A signed-in member changing their private design libraries and public selected equipment appearance. */
async function handleEquipment(req: IncomingMessage, res: ServerResponse, identity: Identity): Promise<void> {
  if (identity.kind === 'owner') { jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' }); return; }
  if (identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in first.', accounts: 'required' }); return;
  }
  const body = await readJsonBody(req, EQUIPMENT_BODY_LIMIT) as {
    snowboard?: unknown; skis?: unknown; edgeColor?: unknown;
  };
  const changed = await setUserEquipment(identity.user.username, body);
  jsonResponse(res, 200, { accounts: 'required', ...changed });
}

/**
 * Who this browser is.
 *
 * One answer in one shape for both kinds of server: the principal, and how it was established. The sign-in
 * view reads this once at boot and, on a server that answers `open`, installs nothing at all.
 *
 * The two ways a configured server has nobody are the guard's to answer, not this route's: it asks for a
 * session like the rest of the mount (`ROUTE_ACCESS`), so an anonymous caller is refused with 401 and one at
 * a server still waiting for its first admin with 503 — each carrying the `accounts` and `bootstrap` the
 * sign-in view reads its next step from. What reaches here is somebody.
 */
function handleSession(res: ServerResponse, identity: Identity): void {
  if (identity.kind !== 'owner' && identity.kind !== 'member') {
    jsonResponse(res, 401, { error: 'Sign in to use this server.', accounts: 'required' });
    return;
  }
  jsonResponse(res, 200, {
    accounts: shape(identity), user: identity.user,
    ...(identity.kind === 'member' ? { sessionId: identity.sessionId } : {}),
  });
}

/**
 * Whose keys these are, or nobody — the narrowing every `/keys` route runs through.
 *
 * Two refusals, and both matter. A server with **no accounts** answers 400: `identify` resolves such a server
 * to its owner without ever looking at a key, so one minted here would be a credential nothing consults, and
 * handing somebody a secret that does nothing is worse than saying there is nothing to hand.
 *
 * And an identity that is not a `member` is refused, which is the rule that a **key cannot mint another key**.
 * A leaked key that could issue its own successors would survive being revoked.
 */
function keyHolder(res: ServerResponse, identity: Identity): PublicUser | null {
  if (identity.kind === 'owner') {
    jsonResponse(res, 400, {
      error: 'This server has no accounts, so the Blender add-on needs no key — point it at the server and it'
        + ' is already you.',
      accounts: 'open',
    });
    return null;
  }
  if (identity.kind !== 'member') {
    jsonResponse(res, identity.kind === 'token' ? 403 : 401, identity.kind === 'token'
      ? { error: 'An access key cannot manage access keys. Sign in to the editor.', token: true }
      : { error: 'Sign in to use this server.', accounts: 'required' });
    return null;
  }
  return identity.user;
}

// ---- the roster, and the administration that rides beside it ----

/**
 * One member as the Users mode lists them: the account, and what presence knows about them right now.
 *
 * Every member of the server appears here, not only the connected ones — which is the reason this is a route
 * at all rather than a read of the presence table, because presence only knows who is on a socket.
 */
interface RosterMember {
  id: string;
  username: string;
  bio: string;
  role: Role;
  createdAt: string;
  lastSeenAt: string;
  availability: ManualAvailability;
  /** Omitted unless the requesting member is a moderator or admin. */
  inviteHandle?: string;
  disabled: boolean;
  profilePictureUrl?: string;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
  online: boolean;
  status: MemberStatus;
  /** True when at least one live tab is actively following a shared screen. */
  watching: boolean;
  /** How many live participants, because presence is keyed by session and displayed by user. */
  sessions: number;
  /** Browser-local labels for the devices or profiles holding those participants. */
  devices: string[];
  /** The authored/reference pairs they have open, which is what a row offers to open. */
  maps: Array<{
    id: string; name: string; reference?: string; playing?: Array<'authored' | 'reference'>;
    sharingSessionId?: string;
  }>;
}

/** Who this request is, or nobody. Every route below runs under the `/api/members` access rule, so an
 *  anonymous caller never reaches one — this is the narrowing that gives the handler a user to work with. */
const principal = (req: IncomingMessage): PublicUser | null => {
  const identity = (req as ApiRequest).identity;
  return identity && (identity.kind === 'owner' || identity.kind === 'member') ? identity.user : null;
};

async function buildRoster(me: PublicUser): Promise<Record<string, unknown>> {
  // A server with no accounts has exactly one member: whoever is running it. The list is a room of one and
  // nothing about it prompts, which is what editing alone looks like here.
  const moderates = holds(me.role, 'moderator');
  const users = requiresAccounts() ? await listUsers() : [OWNER];
  const handles = moderates && requiresAccounts()
    ? new Map((await readAccounts()).users.map(user => [user.id, user.inviteHandle]))
    : new Map<string, string>();
  const names = new Map((await listProjects()).map(project => [project.id, project.name]));
  const present = new Map<string, {
    sessions: number;
    maps: Map<string, {
      id: string; name: string; reference?: string; playing?: Array<'authored' | 'reference'>;
      sharingSessionId?: string;
    }>;
    devices: Set<string>;
    lastSeen: number;
    idle: boolean[];
    watching: boolean;
  }>();
  for (const session of liveSessions()) {
    const found = present.get(session.member.id)
      ?? { sessions: 0, maps: new Map<string, {
        id: string; name: string; reference?: string; playing?: Array<'authored' | 'reference'>;
        sharingSessionId?: string;
      }>(),
        devices: new Set<string>(), lastSeen: 0, idle: [], watching: false };
    found.sessions++;
    found.lastSeen = Math.max(found.lastSeen, session.lastSeen);
    found.idle.push(session.idle);
    found.devices.add(session.deviceLabel);
    found.watching ||= !!session.screenWatchingSessionId;
    if (session.projectId) {
      const reference = session.referenceLevel ?? undefined;
      const key = `${session.projectId}\u0000${reference ?? ''}`;
      const existing = found.maps.get(key);
      const playing = new Set(existing?.playing ?? []);
      if (session.playing) playing.add(session.playing);
      found.maps.set(key, {
        id: session.projectId, name: names.get(session.projectId) ?? 'a map',
        ...(reference ? { reference } : {}),
        ...(playing.size ? { playing: [...playing] } : {}),
        ...(existing?.sharingSessionId || session.screenSharing
          ? { sharingSessionId: existing?.sharingSessionId ?? session.sessionId } : {}),
      });
    }
    present.set(session.member.id, found);
  }
  const members: RosterMember[] = users.map(user => {
    const seen = present.get(user.id);
    return {
      id: user.id, username: user.username, bio: user.bio, role: user.role,
      createdAt: user.createdAt, availability: user.availability,
      lastSeenAt: seen?.lastSeen ? new Date(seen.lastSeen).toISOString() : user.lastSeenAt,
      ...(handles.has(user.id) ? { inviteHandle: handles.get(user.id) } : {}),
      disabled: user.disabled, online: !!seen,
      status: effectiveMemberStatus(user.availability, seen?.idle ?? []),
      watching: seen?.watching ?? false, sessions: seen?.sessions ?? 0,
      ...(user.profilePictureUrl ? { profilePictureUrl: user.profilePictureUrl } : {}),
      ...(user.snowboardTextureUrl ? { snowboardTextureUrl: user.snowboardTextureUrl } : {}),
      ...(user.skiTextureUrl ? { skiTextureUrl: user.skiTextureUrl } : {}),
      ...(user.equipmentEdgeColor ? { equipmentEdgeColor: user.equipmentEdgeColor } : {}),
      devices: [...seen?.devices ?? []],
      maps: [...seen?.maps.values() ?? []],
    };
  }).sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  const administers = me.role === 'admin';
  return {
    accounts: requiresAccounts() ? 'required' : 'open',
    me, admin: administers, moderator: moderates, members,
    // What delete-map operates on. Listed only for the admin who could act on it, so other panels show no map
    // administration rather than a list of buttons that would refuse.
    ...(administers ? { maps: [...names].map(([id, name]) => ({ id, name })) } : {}),
  };
}

/** Administration needs accounts to administer. On a server that has none there is one member and no way to
 *  add another, so the actions are refused in the same words the sign-in routes use. */
const administrable = (res: ServerResponse): boolean => {
  if (requiresAccounts()) return true;
  jsonResponse(res, 400, { error: NO_ACCOUNTS, accounts: 'open' });
  return false;
};

async function handleMemberAction(req: IncomingMessage, res: ServerResponse, me: PublicUser,
  parts: string[]): Promise<void> {
  if (!administrable(res)) return;
  // Read tolerantly: signing somebody out carries no body at all, and refusing a request for being exactly
  // what it should be is the trap the sign-out route below already learned once.
  const body = await readJsonBody(req, AUTH_BODY_LIMIT).catch(() => ({})) as
    { role?: unknown; disabled?: unknown; password?: unknown; handle?: unknown; days?: unknown };

  if (parts[0] === 'invite') {
    const role = text(body.role) || 'editor';
    if (!isRole(role)) throw new Error(`Unknown role: ${role}`);
    if (me.role !== 'admin' && !(me.role === 'moderator' && isOrdinaryRole(role))) {
      jsonResponse(res, 403, { error: 'Moderators may create only viewer or editor invites.' });
      return;
    }
    // The token is handed back exactly once and never stored, so the panel shows the link and says so. The
    // address it belongs to is the browser's rather than the server's — the server only knows what it was
    // asked for, which behind a proxy is not the URL anybody types.
    const minted = await mintInvite({
      role, handle: text(body.handle), days: Number(body.days ?? DEFAULT_INVITE_DAYS), by: me.username,
    });
    jsonResponse(res, 201, minted);
    return;
  }
  if (parts[0] === 'invites' && parts[2] === 'revoke') {
    jsonResponse(res, 200, { invite: await revokeInvite(parts[1]) });
    return;
  }

  const username = decodeURIComponent(parts[0] ?? '');
  const action = parts[1];
  // Locking yourself out of your own server from a panel inside it is a mistake with no way back short of the
  // CLI, so the two actions that could do it refuse to act on the member performing them.
  if (username.toLowerCase() === me.username && (action === 'role' || action === 'disabled')) {
    jsonResponse(res, 400, {
      error: 'That would change your own access from inside the editor. Use the CLI if you mean it: '
        + `slopesmith ${action === 'role' ? 'set-role' : 'disable'} ${me.username} …`,
    });
    return;
  }
  switch (action) {
    case 'role': {
      const role = text(body.role);
      if (!isRole(role)) throw new Error(`Unknown role: ${role}`);
      jsonResponse(res, 200, { user: await setUserRole(username, role, me) });
      return;
    }
    case 'disabled': {
      const user = await setUserDisabled(username, body.disabled !== false, me);
      jsonResponse(res, 200, { user });
      return;
    }
    case 'password': {
      // Generated when none was given, exactly as `reset-password` does — an admin resets a password, and
      // never reads one.
      const password = text(body.password) || generatePassword();
      const user = await setUserPassword(username, password);
      jsonResponse(res, 200, { user, password: text(body.password) ? undefined : password });
      return;
    }
    case 'handle': {
      const user = await setUserInviteHandle(username, body.handle, me);
      jsonResponse(res, 200, { user });
      return;
    }
    case 'sign-out': {
      const found = (await listUsers()).find(user => user.username === username.trim().toLowerCase());
      if (!found) throw new Error(`No such user: ${username}`);
      jsonResponse(res, 200, { sessions: await revokeUserSessions(found.id) });
      return;
    }
    default:
      jsonResponse(res, 404, { error: `Unknown member action: ${action ?? '(none)'}` });
  }
}

/**
 * The roster the Users mode reads, and the administration inside it.
 *
 * Mounted separately from `/api/auth` so the access table decides what it asks of a caller in the same place
 * as every other route: reading the roster is any member, changing anybody is an admin. Nothing here checks
 * whether the server has accounts in order to decide who may act — the principal already answered that.
 */
export const memberRoutes: Record<string, ApiHandler> = {
  '/api/members': async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/^\/+|\/+$/g, '');
    const parts = path ? path.split('/') : [];
    const method = req.method ?? 'GET';
    try {
      const me = principal(req);
      if (!me) { jsonResponse(res, 401, { error: 'Sign in to use this server.', accounts: 'required' }); return; }
      if (method === 'GET' && !parts.length) { jsonResponse(res, 200, await buildRoster(me)); return; }
      if (method === 'GET' && parts[1] === 'profile-picture') {
        const username = decodeURIComponent(parts[0] ?? '').trim().toLowerCase();
        const picture = findUserRecord(await readAccounts(), username)?.profilePicture;
        if (!picture) { jsonResponse(res, 404, { error: 'That member has no profile picture.' }); return; }
        const bytes = Buffer.from(picture.data, 'base64');
        res.statusCode = 200;
        res.setHeader('content-type', picture.mimeType);
        res.setHeader('content-length', bytes.length);
        res.setHeader('cache-control', 'private, max-age=31536000, immutable');
        res.setHeader('x-content-type-options', 'nosniff');
        res.end(bytes);
        return;
      }
      if (method === 'GET' && parts[1] === 'equipment-texture'
        && (parts[2] === 'snowboard' || parts[2] === 'skis')) {
        const username = decodeURIComponent(parts[0] ?? '').trim().toLowerCase();
        const equipment = findUserRecord(await readAccounts(), username)?.equipment;
        const library = equipment?.[parts[2]];
        const requestedId = parts[3] ? decodeURIComponent(parts[3]) : library?.selectedId;
        const picture = library?.designs.find(design => design.id === requestedId)?.texture;
        if (!picture) { jsonResponse(res, 404, { error: `That member has no ${parts[2]} texture.` }); return; }
        const bytes = Buffer.from(picture.data, 'base64');
        res.statusCode = 200;
        res.setHeader('content-type', picture.mimeType);
        res.setHeader('content-length', bytes.length);
        res.setHeader('cache-control', 'private, max-age=31536000, immutable');
        res.setHeader('x-content-type-options', 'nosniff');
        res.end(bytes);
        return;
      }
      if (method === 'GET' && parts[0] === 'invites') {
        if (!administrable(res)) return;
        jsonResponse(res, 200, { invites: await listInvites() });
        return;
      }
      if (method !== 'POST') { jsonResponse(res, 405, { error: 'GET or POST only' }); return; }
      await handleMemberAction(req, res, me, parts);
    } catch (error) {
      jsonResponse(res, error instanceof AccountAdministrationError ? 403 : 400,
        { error: String(error instanceof Error ? error.message : error) });
    }
  },
};

export const authRoutes: Record<string, ApiHandler> = {
  '/api/auth': async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    try {
      const identity = await identify(req);
      if (method === 'GET' && (path === '/' || path === '/session')) { handleSession(res, identity); return; }
      if (method === 'GET' && path === '/keys') {
        const me = keyHolder(res, identity);
        if (me) jsonResponse(res, 200, { tokens: await listAccessTokens(me.id) });
        return;
      }
      if (method === 'GET' && path === '/equipment') {
        if (identity.kind !== 'member') {
          jsonResponse(res, identity.kind === 'owner' ? 400 : 401, identity.kind === 'owner'
            ? { error: NO_ACCOUNTS, accounts: 'open' }
            : { error: 'Sign in first.', accounts: 'required' });
          return;
        }
        const record = findUserRecord(await readAccounts(), identity.user.username);
        if (!record) throw new Error(`No such user: ${identity.user.username}`);
        jsonResponse(res, 200, { accounts: 'required', equipment: equipmentProfile(record) });
        return;
      }
      if (method !== 'POST') { jsonResponse(res, 405, { error: 'POST only' }); return; }
      // Read lazily: signing out carries no body at all, and parsing one that was never sent would refuse
      // the request for being exactly what it should be.
      const body = () => readJsonBody(req, AUTH_BODY_LIMIT) as Promise<AuthBody>;
      switch (path) {
        case '/login': await handleLogin(req, res, await body(), identity); return;
        case '/redeem': await handleRedeem(req, res, await body(), identity); return;
        case '/bootstrap': await handleBootstrap(req, res, await body(), identity); return;
        case '/password': await handlePassword(req, res, await body(), identity); return;
        case '/username': await handleUsername(req, res, identity); return;
        case '/bio': await handleBio(req, res, identity); return;
        case '/availability': await handleAvailability(req, res, identity); return;
        case '/profile-picture': await handleProfilePicture(req, res, identity); return;
        case '/equipment': await handleEquipment(req, res, identity); return;
        case '/logout': {
          await revokeSession(sessionToken(req));
          clearSessionCookie(res);
          jsonResponse(res, 200, { accounts: shape(identity), signedOut: true });
          return;
        }
        case '/logout-everywhere': {
          if (identity.kind !== 'member') {
            jsonResponse(res, identity.kind === 'owner' ? 400 : 401,
              identity.kind === 'owner' ? { error: NO_ACCOUNTS, accounts: 'open' }
                : { error: 'Sign in first.', accounts: 'required' });
            return;
          }
          const ended = await revokeUserSessions(identity.user.id);
          clearSessionCookie(res);
          jsonResponse(res, 200, { accounts: 'required', signedOut: true, sessions: ended });
          return;
        }
        // Personal access keys (docs/046): how the Blender add-on signs in to a hosted server.
        case '/keys': {
          const me = keyHolder(res, identity);
          if (!me) return;
          const { name } = await body() as { name?: string };
          const minted = await createAccessToken(me.id, String(name ?? ''));
          // The ONLY time the secret exists outside a digest. The client shows it once and cannot ask again.
          jsonResponse(res, 200, { key: minted.token, token: minted.record });
          return;
        }
        case '/keys/revoke': {
          const me = keyHolder(res, identity);
          if (!me) return;
          const { id } = await body() as { id?: string };
          jsonResponse(res, 200, { revoked: await revokeAccessToken(me.id, String(id ?? '')) });
          return;
        }
        default: jsonResponse(res, 404, { error: `Unknown auth route: ${path}` });
      }
    } catch (error) {
      jsonResponse(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
  },
};
