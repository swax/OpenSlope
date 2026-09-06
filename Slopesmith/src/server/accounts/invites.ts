import { randomUUID } from 'node:crypto';
import { isRole, type Role } from './policy';
import {
  mintToken, readAccounts, tokenHash, updateAccounts, type AccountsFile, type InviteRecord,
} from './store';
import {
  claimUsername, draftUser, normalizeInviteHandle, publicUser, type NewUser, type PublicUser,
} from './users';

/**
 * Invite links: the only way in.
 *
 * The server mints a random token, stores only its digest, and records who minted it, the role it grants and
 * when it lapses. The honest security property is that **the link is the credential until it is redeemed,
 * and worthless afterwards** (docs/038) — anyone holding it can redeem it, so single use plus a short expiry
 * is what makes a leaked link a bounded problem: the intended person finds it already spent and says so.
 *
 * Because the role travels with the token, "here is a link that makes you an editor" is one action rather
 * than invite-then-grant.
 */

/** Unredeemed invites lying around are the actual risk, which is why they lapse by default rather than on
 *  request. A week is long enough to reach someone who reads their messages on Sunday. */
export const DEFAULT_INVITE_DAYS = 7;

export interface PublicInvite {
  id: string;
  role: Role;
  handle: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Who it created, so a private moderator listing says where the invitation went. */
  redeemedBy?: string;
  revokedAt?: string;
  /** Whether it can still create a user, and if not, why. */
  live: boolean;
  state: 'live' | 'spent' | 'expired' | 'revoked';
}

function inviteState(invite: InviteRecord, now: number): PublicInvite['state'] {
  if (invite.revokedAt) return 'revoked';
  if (invite.redeemed) return 'spent';
  return Date.parse(invite.expiresAt) <= now ? 'expired' : 'live';
}

function publicInvite(invite: InviteRecord, now = Date.now()): PublicInvite {
  const state = inviteState(invite, now);
  return {
    id: invite.id, role: invite.role, handle: invite.handle,
    createdBy: invite.createdBy, createdAt: invite.createdAt, expiresAt: invite.expiresAt,
    ...(invite.redeemed ? { redeemedBy: invite.redeemed.username } : {}),
    ...(invite.revokedAt ? { revokedAt: invite.revokedAt } : {}),
    live: state === 'live', state,
  };
}

export interface MintInvite {
  role: Role;
  /** Private moderator provenance, such as discord:joe123 or email:joe@example.com. */
  handle: string;
  days?: number;
  /** Who minted it, as a listing should name them. */
  by?: string;
}

/** The token is handed back exactly once — it is not stored, and there is no route that reads one out. */
export async function mintInvite(input: MintInvite): Promise<{ invite: PublicInvite; token: string }> {
  if (!isRole(input.role)) throw new Error(`Unknown role: ${String(input.role)}`);
  const handle = normalizeInviteHandle(input.handle);
  const days = Number(input.days ?? DEFAULT_INVITE_DAYS);
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error('An invite expires between now and a year out');
  const token = mintToken();
  const now = Date.now();
  const invite: InviteRecord = {
    id: randomUUID(), tokenHash: tokenHash(token), role: input.role, handle,
    createdBy: input.by?.trim() || 'cli', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * 24 * 60 * 60_000).toISOString(),
  };
  await updateAccounts(draft => { draft.invites.push(invite); });
  return { invite: publicInvite(invite, now), token };
}

export async function listInvites(): Promise<PublicInvite[]> {
  const now = Date.now();
  return (await readAccounts()).invites
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(invite => publicInvite(invite, now));
}

export async function revokeInvite(id: string): Promise<PublicInvite> {
  return updateAccounts(draft => {
    const invite = draft.invites.find(entry => entry.id === id);
    if (!invite) throw new Error(`No such invite: ${id}`);
    invite.revokedAt ??= new Date().toISOString();
    return publicInvite(invite);
  });
}

/** Why a redemption was refused, in the words the person holding the link needs to hear. */
const REFUSAL: Record<Exclude<PublicInvite['state'], 'live'>, string> = {
  spent: 'That invite link has already been used — ask whoever sent it for a fresh one.',
  expired: 'That invite link has expired — ask whoever sent it for a fresh one.',
  revoked: 'That invite link was withdrawn — ask whoever sent it for a fresh one.',
};

function findInvite(accounts: AccountsFile, token: string): InviteRecord | undefined {
  const hash = tokenHash(token);
  return accounts.invites.find(invite => invite.tokenHash === hash);
}

/**
 * Redeem a link: create the one user it describes and spend it.
 *
 * The password is hashed before the queue is taken, because scrypt is deliberately slow and every other
 * writer would wait behind it. Everything that has to agree — the link is still live, the username is free,
 * the redemption is recorded — happens inside one locked read-modify-write, so two people redeeming the same
 * link at once cannot both get it.
 */
export async function redeemInvite(token: string,
  account: Omit<NewUser, 'role' | 'inviteHandle'>): Promise<PublicUser> {
  const accounts = await readAccounts();
  const found = findInvite(accounts, token);
  // Refused before any work is done, so a wrong token costs a digest rather than a scrypt derivation.
  if (!found) throw new Error('That invite link is not valid.');
  const state = inviteState(found, Date.now());
  if (state !== 'live') throw new Error(REFUSAL[state]);
  const user = await draftUser({ ...account, role: found.role, inviteHandle: found.handle });
  return updateAccounts(draft => {
    const invite = draft.invites.find(entry => entry.id === found.id);
    if (!invite) throw new Error('That invite link is not valid.');
    const live = inviteState(invite, Date.now());
    if (live !== 'live') throw new Error(REFUSAL[live]);
    claimUsername(draft, user.username);
    invite.redeemed = { userId: user.id, username: user.username, at: new Date().toISOString() };
    draft.users.push(user);
    return publicUser(user);
  });
}
