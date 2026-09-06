import type { PublicUser } from './public-user';
import { createLogger } from '../log';

const log = createLogger('accounts');

/**
 * Changes to account authority that already-open transports must hear about.
 *
 * HTTP requests resolve the account store on every request, but a WebSocket is authorized only while it is
 * upgraded. Publishing the same mutations here lets that long-lived transport stop using the identity it
 * captured at connect time. The account layer knows nothing about sockets; the session channel subscribes.
 */
export type AccountAccessEvent =
  | { kind: 'session-revoked'; accountSessionId: string }
  | { kind: 'user-revoked'; userId: string }
  | { kind: 'role-changed'; user: PublicUser };

const listeners = new Set<(event: AccountAccessEvent) => void>();

export function onAccountAccessChanged(listener: (event: AccountAccessEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceAccountAccessChanged(event: AccountAccessEvent): void {
  for (const listener of listeners) {
    try { listener(event); }
    catch (error) { log.error('an access-change listener failed', { error }); }
  }
}

/** Profile changes do not alter authority, but open Users panels still need to refresh immediately. Kept on
 *  a separate feed so the access listener can continue treating every event it receives as security-sensitive. */
const profileListeners = new Set<(user: PublicUser) => void>();

export function onAccountProfileChanged(listener: (user: PublicUser) => void): () => void {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
}

export function announceAccountProfileChanged(user: PublicUser): void {
  for (const listener of profileListeners) {
    try { listener(user); }
    catch (error) { log.error('a profile-change listener failed', { error }); }
  }
}
