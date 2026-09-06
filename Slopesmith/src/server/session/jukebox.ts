import { randomUUID } from 'node:crypto';
import {
  JUKEBOX_MAX_ITEMS, emptyJukeboxState, jukeboxPosition,
  type JukeboxEntry, type JukeboxState,
} from '../../core/session/jukebox';
import type { SessionMember } from './presence';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_POSITION_SECONDS = 24 * 60 * 60;

export type JukeboxResult =
  | { ok: true; state: JukeboxState }
  | { ok: false; error: string };

/** Accept the same public YouTube identities as the browser bridge, then store one stable, credential-free URL. */
export function canonicalJukeboxUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (VIDEO_ID.test(candidate)) return `https://www.youtube.com/watch?v=${candidate}`;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  let id = '';
  if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] ?? '';
  else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') ?? '';
    else {
      const segments = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) id = segments[1] ?? '';
    }
  }
  return VIDEO_ID.test(id) ? `https://www.youtube.com/watch?v=${id}` : null;
}

const mayManage = (member: SessionMember, entry: JukeboxEntry): boolean =>
  member.id === entry.userId || member.role === 'moderator' || member.role === 'admin';

/**
 * One service-wide queue. It intentionally never touches disk: URLs are room activity, not mountain content,
 * and a service restart is a natural point for the party queue to end.
 */
export function createJukebox(now: () => number = Date.now) {
  let state = emptyJukeboxState(now());

  const snapshot = (): JukeboxState => ({
    ...state,
    current: state.current ? { ...state.current } : null,
    queue: state.queue.map(entry => ({ ...entry })),
  });

  const changed = (next: Partial<JukeboxState>, reload = false): JukeboxResult => {
    state = {
      ...state,
      ...next,
      revision: state.revision + 1,
      mediaVersion: state.mediaVersion + (reload ? 1 : 0),
    };
    return { ok: true, state: snapshot() };
  };

  const promote = (queue: JukeboxEntry[], stopWhenEmpty: boolean): JukeboxResult => {
    const current = queue[0] ?? null;
    return changed({
      current,
      queue: current ? queue.slice(1) : [],
      position: 0,
      changedAt: now(),
      playing: !!current,
    }, !!current || !stopWhenEmpty);
  };

  return {
    snapshot,

    add(member: SessionMember, source: unknown): JukeboxResult {
      const url = canonicalJukeboxUrl(source);
      if (!url) return { ok: false, error: 'Enter a valid youtube.com or youtu.be video URL.' };
      if ((state.current ? 1 : 0) + state.queue.length >= JUKEBOX_MAX_ITEMS) {
        return { ok: false, error: `The jukebox is full (${JUKEBOX_MAX_ITEMS} videos).` };
      }
      const entry: JukeboxEntry = {
        id: randomUUID(), url, userId: member.id, username: member.username, addedAt: now(),
      };
      if (!state.current) {
        return changed({ current: entry, position: 0, changedAt: now(), playing: true }, true);
      }

      // Fair round-robin insertion: everybody's first pending item precedes anybody's second, and so on.
      const round = 1 + state.queue.filter(item => item.userId === member.id).length;
      const occurrence = new Map<string, number>();
      let insertAt = state.queue.length;
      for (let index = 0; index < state.queue.length; index++) {
        const item = state.queue[index];
        const itemRound = (occurrence.get(item.userId) ?? 0) + 1;
        occurrence.set(item.userId, itemRound);
        if (itemRound > round) { insertAt = index; break; }
      }
      const queue = state.queue.slice();
      queue.splice(insertAt, 0, entry);
      return changed({ queue });
    },

    remove(member: SessionMember, id: unknown): JukeboxResult {
      if (typeof id !== 'string') return { ok: false, error: 'Choose a queued video to remove.' };
      if (state.current?.id === id) {
        if (!mayManage(member, state.current)) {
          return { ok: false, error: 'Only its queuer, a moderator, or an admin may skip that video.' };
        }
        return promote(state.queue, true);
      }
      const index = state.queue.findIndex(entry => entry.id === id);
      if (index < 0) return { ok: false, error: 'That video is no longer in the queue.' };
      if (!mayManage(member, state.queue[index])) {
        return { ok: false, error: 'Only its queuer, a moderator, or an admin may remove that video.' };
      }
      return changed({ queue: state.queue.filter(entry => entry.id !== id) });
    },

    skip(member: SessionMember, id: unknown): JukeboxResult {
      if (!state.current || id !== state.current.id) {
        return { ok: false, error: 'That video is no longer playing.' };
      }
      return this.remove(member, id);
    },

    seek(id: unknown, position: unknown): JukeboxResult {
      if (!state.current || id !== state.current.id) {
        return { ok: false, error: 'That video is no longer playing.' };
      }
      const seconds = Number(position);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_POSITION_SECONDS) {
        return { ok: false, error: 'Choose a valid position in the current video.' };
      }
      return changed({ position: seconds, changedAt: now(), playing: true });
    },

    setPlaying(id: unknown, playing: unknown): JukeboxResult {
      if (!state.current || id !== state.current.id) {
        return { ok: false, error: 'That video is no longer playing.' };
      }
      if (typeof playing !== 'boolean') {
        return { ok: false, error: 'Choose whether the current video should play or pause.' };
      }
      if (playing === state.playing) return { ok: true, state: snapshot() };
      const changedAt = now();
      return changed({
        position: jukeboxPosition(state, changedAt),
        changedAt,
        playing,
      });
    },

    ended(id: unknown, mediaVersion: unknown): JukeboxResult {
      if (!state.current || id !== state.current.id || Number(mediaVersion) !== state.mediaVersion) {
        return { ok: false, error: 'That playback event is stale.' };
      }
      if (state.queue.length) return promote(state.queue, false);
      // Match the in-world jukebox: an intact last item loops until it is explicitly skipped.
      return changed({ position: 0, changedAt: now(), playing: true }, true);
    },
  };
}

export type ServerJukebox = ReturnType<typeof createJukebox>;
