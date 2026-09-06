/** A member's explicit availability choice. Idle is deliberately absent: it is derived from live tabs. */
export type ManualAvailability = 'available' | 'away' | 'dnd';

/** The effective state shown by the server roster. */
export type MemberStatus = 'online' | 'idle' | 'away' | 'dnd' | 'offline';

export const isManualAvailability = (value: unknown): value is ManualAvailability =>
  value === 'available' || value === 'away' || value === 'dnd';

/**
 * Collapse an account preference and all of its connected browser tabs into one public state.
 *
 * Explicit Away / DND wins while connected. Automatic idle requires every live tab to be idle, so leaving a
 * phone untouched cannot turn an account yellow while its desktop is still being used.
 */
export function effectiveMemberStatus(availability: ManualAvailability, sessionIdle: readonly boolean[]): MemberStatus {
  if (!sessionIdle.length) return 'offline';
  if (availability === 'away' || availability === 'dnd') return availability;
  return sessionIdle.every(Boolean) ? 'idle' : 'online';
}
