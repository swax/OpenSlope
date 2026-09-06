import { ROLES, type Role } from '../accounts/policy';
import { closeSession, liveSessions, type LiveSession, type SessionMember } from './presence';

/** Private close code shared with the browser client. It means the account is still valid, but this tab does
 * not currently hold one of the server's player seats. */
export const CAPACITY_CLOSE_CODE = 4003;
export const CAPACITY_CLOSE_REASON = 'Server full; waiting for a player slot.';
const roleRank = (role: Role): number => ROLES.indexOf(role);

interface ConnectedAccount {
  id: string;
  sessions: LiveSession[];
}

/** Group in first-arrival order. Presence remains session-shaped, but capacity is deliberately account-shaped:
 * opening a second tab or device must not make one person occupy two player seats. */
function connectedAccounts(): ConnectedAccount[] {
  const accounts = new Map<string, ConnectedAccount>();
  for (const session of liveSessions()) {
    const account = accounts.get(session.member.id) ?? { id: session.member.id, sessions: [] };
    account.sessions.push(session);
    accounts.set(account.id, account);
  }
  return [...accounts.values()];
}

/** Account authority is server-wide, so all of its live sessions normally agree. Choosing the strongest is
 * fail-safe during the instant a role-change close is propagating: stale lower authority cannot evict newer
 * higher authority belonging to the same account. */
const accountRole = (account: ConnectedAccount): Role => account.sessions.reduce<Role>(
  (strongest, session) => roleRank(session.member.role) > roleRank(strongest) ? session.member.role : strongest,
  'viewer',
);

/** Prefer the weakest eligible role, then its oldest connected account. Editors therefore bump viewers;
 * moderators bump viewers before editors; admins bump viewers, then editors, then moderators. */
function bumpTarget(accounts: ConnectedAccount[], incoming: Role): ConnectedAccount | undefined {
  const incomingRank = roleRank(incoming);
  for (let rank = 0; rank < incomingRank; rank++) {
    const target = accounts.find(account => roleRank(accountRole(account)) === rank);
    if (target) return target;
  }
  return undefined;
}

/** Close a seat and remove it synchronously. The socket's close listener normally performs the removal too,
 * but doing it here makes the capacity decision atomic even for a transport whose close callback is delayed. */
function displace(session: LiveSession, reason: string): void {
  session.close(CAPACITY_CLOSE_CODE, reason);
  closeSession(session.sessionId);
}

/** Free one account seat, which requires ending every tab/device that account currently holds. */
function displaceAccount(account: ConnectedAccount, reason: string): void {
  for (const session of account.sessions) displace(session, reason);
}

const displacementReason = (role: Role): string =>
  `${role === 'moderator' ? 'A' : 'An'} ${role} needed this player slot.`;

/**
 * Reserve a seat for an account whose new connection has authenticated but has not entered presence yet.
 *
 * Another tab belonging to an account already present needs no new seat. Otherwise a viewer is first-come,
 * first-served; an editor may take a viewer seat; a moderator may take a viewer or editor seat; and an admin
 * may take any lower-role seat. Only admins are unbounded: when a full server contains no lower role to bump,
 * an admin is admitted above the configured limit while every other role is refused.
 */
export function reservePlayerSeat(member: Pick<SessionMember, 'id' | 'role'>, maxPlayers: number): boolean {
  const connected = connectedAccounts();
  if (connected.some(account => account.id === member.id)) return true;
  if (connected.length < maxPlayers) return true;
  const target = bumpTarget(connected, member.role);
  if (target) {
    displaceAccount(target, displacementReason(member.role));
    return true;
  }
  return member.role === 'admin';
}

/** Apply a lowered setting immediately in the same priority order: viewers, then editors, then moderators.
 * Admin accounts are unbounded and never removed merely because the configured limit fell below their count. */
export function trimPlayerSeats(maxPlayers: number): number {
  let removed = 0;
  for (;;) {
    const connected = connectedAccounts();
    if (connected.length <= maxPlayers) break;
    const target = bumpTarget(connected, 'admin');
    if (!target) break;
    displaceAccount(target, CAPACITY_CLOSE_REASON);
    removed++;
  }
  return removed;
}
