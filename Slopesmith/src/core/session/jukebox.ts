/**
 * Shared, ephemeral jukebox state. The server owns these values; browsers only resolve the public YouTube
 * URL through their own local bridge and decode the resulting stream.
 */

export const JUKEBOX_MAX_ITEMS = 24;

export interface JukeboxEntry {
  id: string;
  url: string;
  userId: string;
  username: string;
  addedAt: number;
}

export interface JukeboxState {
  /** Changes on every accepted queue or transport mutation. */
  revision: number;
  /** Changes only when the decoder should start/restart the current source, not for a pure seek. */
  mediaVersion: number;
  current: JukeboxEntry | null;
  queue: JukeboxEntry[];
  /** Media seconds at `changedAt`; while playing, server time advances it. */
  position: number;
  changedAt: number;
  playing: boolean;
}

export const emptyJukeboxState = (now = 0): JukeboxState => ({
  revision: 0,
  mediaVersion: 0,
  current: null,
  queue: [],
  position: 0,
  changedAt: now,
  playing: false,
});

/** The shared playhead at one server-clock instant, including late joins and time spent resolving locally. */
export function jukeboxPosition(state: JukeboxState, serverNow: number): number {
  if (!state.current) return 0;
  return Math.max(0, state.position + (state.playing ? Math.max(0, serverNow - state.changedAt) / 1000 : 0));
}

export function mayManageJukeboxEntry(
  member: { id: string; role: string } | null,
  entry: JukeboxEntry | null,
): boolean {
  return !!member && !!entry
    && (member.id === entry.userId || member.role === 'moderator' || member.role === 'admin');
}
