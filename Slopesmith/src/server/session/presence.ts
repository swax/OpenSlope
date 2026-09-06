import type { Role } from '../accounts/policy';
import type { PlayerPose } from '../../core/session/player-pose';

/**
 * Who is on which map, what each of them is looking at, and what they are touching (docs/038, docs/039).
 *
 * Presence is part of the concurrency design rather than decoration on top of it. Ordinary editing is a
 * free-for-all of last-writer-wins register assignments, and what makes that work in practice is that people
 * can SEE each other: live selections in each participant's colour and a soft highlight on whatever somebody
 * is dragging avoid nearly every collision socially — far cheaper than any locking scheme. Shared-screen
 * cursors travel separately to active observers only. So this table carries awareness as well as membership.
 *
 * Nothing here is exclusive. An assignment is absolute and idempotent, so it cannot be refused for having
 * lost a race, and the one thing that genuinely cannot be last-writer-wins — topology — takes an instantaneous
 * compare-and-swap over the ids it consumes (`room.ts`) rather than anything anybody holds. The only roster
 * this file keeps is of who has actually changed each map, which is what a session-end checkpoint is credited
 * to.
 *
 * Both tables live in memory in the service and nowhere else. They describe connections rather than work, so a
 * restart is allowed to forget them entirely — and writing them down would mean a `mountain.slope.json` whose
 * bytes change because somebody opened a tab, which is exactly the thing presence must never be. The service
 * outlives Vite's restarts (`scripts/dev.ts`), so "in memory" here is the whole editing day.
 *
 * Presence is keyed by session and displayed by user: one person with two tabs is one member in the list and
 * two entries in this table, because "is Ada here" and "how many editors am I racing" are different questions.
 */

/** The member behind a session, in the shape presence reports them. */
export interface SessionMember {
  id: string;
  username: string;
  role: Role;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
}

/**
 * What one participant is doing right now, in the document's own names.
 *
 * Everything here is id-named rather than index-named, for the same reason a selection is: a topology edit
 * renumbers the arrays, and a highlight drawn from an index kept across one lands on different terrain. It is
 * relayed exactly as it arrives — the server has no opinion about what a selection means.
 */
export interface Awareness {
  /** Legacy room-wide slot, always null; shared-screen cursors are routed separately to active observers. */
  cursor: [number, number, number] | null;
  /** The vertices and quads they have selected. */
  vertices: string[];
  quads: string[];
  /** What they are actively dragging, which is drawn softer than a selection and is the whole of the
   *  "somebody is holding this right now" signal. */
  dragging: string[];
  /** World-space camera/rider pose; transient and never written into a mountain. */
  player: PlayerPose | null;
  /** When this was last said, so a stale highlight fades rather than sticking to the mountain. */
  at: number;
}

export const emptyAwareness = (): Awareness =>
  ({ cursor: null, vertices: [], quads: [], dragging: [], player: null, at: 0 });

export interface PresenceEntry {
  userId: string;
  sessionId: string;
  /** The browser tab, which is what the HTTP routes carry in `x-slopesmith-client`. */
  clientId: string;
  /** A short browser-local label (phone, computer, or a name the member chose). */
  deviceLabel: string;
  username: string;
  role: Role;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
  /** This participant's colour, everywhere they appear. Derived from the user id so every client picks the
   *  same one for the same person without anybody being told. */
  color: string;
  /** The extracted mountain loaded in this tab's read-only Reference slot, when there is one. */
  referenceLevel?: string;
  /** Which world this tab is actively playing. */
  playing?: 'authored' | 'reference';
  /** This tab is offering its live camera and display options to observers. */
  screenSharing?: boolean;
  /** Exact shared-screen session this tab actively follows. Paused observers are omitted. */
  screenWatchingSessionId?: string;
  /** Milliseconds since the epoch, so a client renders it against its own clock. */
  lastSeen: number;
}

/** One absolute change to the presence table. A client can remove `from` and upsert `to` without being sent
 * every other participant again. */
export interface PresenceChange {
  kind: 'open' | 'move' | 'update' | 'close';
  sessionId: string;
  userId: string;
  from: { projectId: string; entry: PresenceEntry } | null;
  to: { projectId: string; entry: PresenceEntry } | null;
}

/** One connected editor. `send` is the socket's, so this table can push without knowing what a socket is. */
export interface LiveSession {
  sessionId: string;
  /** The opaque account session that authorized this socket. Absent on an open owner server. */
  accountSessionId?: string;
  clientId: string;
  deviceLabel: string;
  member: SessionMember;
  /** The map this tab is looking at, which is what presence is keyed on. */
  projectId: string | null;
  /** The extracted mountain in this tab's read-only Reference slot. */
  referenceLevel: string | null;
  /** Which world this tab is actively playing, or null outside a play session. */
  playing: 'authored' | 'reference' | null;
  /** Whether other members may subscribe to this tab's disposable view stream. */
  screenSharing: boolean;
  /** Exact shared-screen session this tab actively follows, or null while paused/not observing. */
  screenWatchingSessionId: string | null;
  /** Whether this browser has crossed its local human-inactivity threshold. */
  idle: boolean;
  lastSeen: number;
  /** What this tab is selecting and dragging on that map, plus its player pose. */
  aware: Awareness;
  /** Where this tab is in the room's sequence — what a topology claim is compared against and what a
   *  reconnection is caught up from (docs/039, `room.ts`). */
  at: number;
  /** Whether this tab may change the map at all: an editor or admin on a matching build. A viewer, or an
   *  install whose document or core version differs, follows read-only rather than writing geometry the rest
   *  of the room would evaluate differently. */
  writable: boolean;
  /** Whether this member owns/moderates the open map — specifically the authority to rename it. */
  managesProject?: boolean;
  /** Build versions remembered from the last watch message, so a permission change can recompute writability
   *  without accidentally admitting an incompatible editor. */
  docVersion?: number;
  coreVersion?: string;
  send(message: unknown): void;
  sendPrepared(frame: Buffer, coalesceKey?: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * How long a session survives without traffic, and how often that is swept.
 *
 * The presence TTL is the one number that matters now: it is how long the room goes on expecting somebody who
 * has gone quiet, and therefore also the threshold past which a returning client's held changes are summarised
 * rather than replayed blind (`app/net/register-sync.ts`). One number, so the two cannot disagree.
 */
export interface SessionPolicy {
  presenceTtlMs: number;
  sweepMs: number;
}

export const sessionPolicy: SessionPolicy = {
  presenceTtlMs: 90_000,
  sweepMs: 5_000,
};

/** Retune the timings — the seam a test uses to exercise expiry without waiting one out. */
export function configureSessions(patch: Partial<SessionPolicy>): SessionPolicy {
  return Object.assign(sessionPolicy, patch);
}

const sessions = new Map<string, LiveSession>();
/** Room membership beside the session table. Relaying one edit should walk that room, not every socket on the
 * server. The set keeps session insertion order, which is also presence display order. */
const projectSessions = new Map<string, Set<string>>();

/**
 * Who has actually changed each map since the first client arrived on it.
 *
 * This is what a session-end checkpoint is credited to: the checkpoint holds the work of everybody who wrote
 * it, which is now the set of people whose assignments and claims landed rather than the set who took a lease.
 */
const writers = new Map<string, Set<string>>();

type Listener = (change: PresenceChange) => void;
const changeListeners = new Set<Listener>();
const statusListeners = new Set<(userId: string) => void>();
/** Raised when the last client leaves a map, with the members whose work it holds — empty when nobody wrote. */
const idleListeners = new Set<(projectId: string, members: string[]) => void>();

export function onPresenceChanged(listener: Listener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

/** Roster-only state changed without moving a tab between maps. */
export function onMemberStatusChanged(listener: (userId: string) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function onProjectIdle(listener: (projectId: string, members: string[]) => void): () => void {
  idleListeners.add(listener);
  return () => idleListeners.delete(listener);
}

function announce(change: PresenceChange): void {
  for (const listener of changeListeners) listener(change);
}

function announceStatus(userId: string): void {
  for (const listener of statusListeners) listener(userId);
}

function addToProject(projectId: string | null, sessionId: string): void {
  if (!projectId) return;
  const held = projectSessions.get(projectId) ?? new Set<string>();
  held.add(sessionId);
  projectSessions.set(projectId, held);
}

function removeFromProject(projectId: string | null, sessionId: string): void {
  if (!projectId) return;
  const held = projectSessions.get(projectId);
  if (!held) return;
  held.delete(sessionId);
  if (!held.size) projectSessions.delete(projectId);
}

/**
 * A participant's colour, chosen from their user id.
 *
 * Derived rather than assigned, so every client — and the server — picks the same colour for the same person
 * with nothing negotiated, and so somebody's colour is the same tomorrow. Eight hues at one saturation and
 * lightness, which keeps two participants distinguishable against the terrain without any of them reading as
 * a selection colour the editor already uses.
 */
const PRESENCE_COLORS = [
  '#f2a33c', '#63c4e8', '#8ad06a', '#e88f6a', '#c58ff0', '#f07f9c', '#5fd3b2', '#e6d75a',
];

export function colorFor(userId: string): string {
  let hash = 0;
  for (let at = 0; at < userId.length; at++) hash = (Math.imul(hash, 31) + userId.charCodeAt(at)) | 0;
  return PRESENCE_COLORS[Math.abs(hash) % PRESENCE_COLORS.length];
}

// ---- sessions ----

export function openSession(session: Omit<LiveSession,
  'lastSeen' | 'aware' | 'at' | 'writable' | 'referenceLevel' | 'playing' | 'screenSharing' | 'idle'
    | 'screenWatchingSessionId'>
  & Partial<Pick<LiveSession, 'writable'>>): LiveSession {
  const live: LiveSession = {
    ...session, referenceLevel: null, playing: null, screenSharing: false, screenWatchingSessionId: null,
    idle: false,
    lastSeen: Date.now(), aware: emptyAwareness(), at: 0,
    writable: session.writable ?? true,
  };
  sessions.set(live.sessionId, live);
  addToProject(live.projectId, live.sessionId);
  announce({
    kind: 'open', sessionId: live.sessionId, userId: live.member.id, from: null,
    to: live.projectId ? { projectId: live.projectId, entry: entryFor(live) } : null,
  });
  // A tab with no map produces no presence delta, but it still changes the server roster from Offline.
  if (!live.projectId) announceStatus(live.member.id);
  return live;
}

export const sessionById = (sessionId: string): LiveSession | undefined => sessions.get(sessionId);

export const liveSessions = (): LiveSession[] => [...sessions.values()];

/** Every session looking at one map — the list a register broadcast and a presence change go to. */
export const sessionsOn = (projectId: string): LiveSession[] =>
  [...projectSessions.get(projectId) ?? []].flatMap(id => {
    const session = sessions.get(id);
    return session ? [session] : [];
  });

export function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) session.lastSeen = Date.now();
}

/** Record only an actual transition; activity heartbeats should not become roster refresh traffic. */
export function setSessionIdle(sessionId: string, idle: boolean): void {
  const session = sessions.get(sessionId);
  if (!session || session.idle === idle) return;
  session.idle = idle;
  announceStatus(session.member.id);
}

/** What a tab is selecting and dragging, plus its player pose. Relayed rather than stored anywhere durable. */
export function setAwareness(sessionId: string, aware: Partial<Awareness>): Awareness | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  session.aware = { ...session.aware, ...aware, at: Date.now() };
  session.lastSeen = session.aware.at;
  return session.aware;
}

/** Somebody's change landed on a map, so the checkpoint that ends this session holds their work. */
export function noteWriter(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session?.projectId) return;
  const held = writers.get(session.projectId) ?? new Set<string>();
  held.add(session.member.username);
  writers.set(session.projectId, held);
}

/**
 * The map is gone, so the roster of who wrote on it goes with it (docs/038).
 *
 * Called before the sessions on that map are moved off, because moving the last one off settles the map: with
 * the roster still standing that settlement reports members, and the checkpoint credited to them would be
 * written into a project that is no longer there.
 */
export function forgetWriters(projectId: string): void {
  writers.delete(projectId);
}

/**
 * Which map a tab is on.
 *
 * Leaving a map drops whatever this tab was showing the room it was doing there — a selection on a mountain
 * somebody is no longer looking at is not a selection.
 */
export function watchProject(sessionId: string, projectId: string | null): void {
  const session = sessions.get(sessionId);
  if (!session || session.projectId === projectId) return;
  const left = session.projectId;
  const before = left ? entryFor(session) : null;
  removeFromProject(left, sessionId);
  session.projectId = projectId;
  session.aware = emptyAwareness();
  session.at = 0;
  session.lastSeen = Date.now();
  addToProject(projectId, sessionId);
  if (left) settleIdle(left);
  announce({
    kind: 'move', sessionId, userId: session.member.id,
    from: left && before ? { projectId: left, entry: before } : null,
    to: projectId ? { projectId, entry: entryFor(session) } : null,
  });
}

/**
 * Which extracted mountain this tab is studying beside its authored map.
 *
 * Reference changes do not move the tab between edit rooms or discard its awareness. They still produce an
 * absolute presence upsert so every open Users panel can refresh the map / reference pair immediately.
 */
export function watchReference(sessionId: string, referenceLevel: string | null): void {
  const session = sessions.get(sessionId);
  if (!session || session.referenceLevel === referenceLevel) return;
  session.referenceLevel = referenceLevel;
  announceUpdate(session);
}

/** Publish which world this tab is actively playing without moving it between edit rooms. */
export function watchPlaying(sessionId: string, playing: 'authored' | 'reference' | null): void {
  const session = sessions.get(sessionId);
  if (!session || session.playing === playing) return;
  session.playing = playing;
  announceUpdate(session);
}

/** Advertise or withdraw this tab's opt-in screen stream. */
export function watchScreenSharing(sessionId: string, screenSharing: boolean): void {
  const session = sessions.get(sessionId);
  if (!session || session.screenSharing === screenSharing) return;
  session.screenSharing = screenSharing;
  announceUpdate(session);
}

/** Advertise only active observation. A paused subscription stays connected but leaves this presence target. */
export function watchScreenWatching(sessionId: string, targetSessionId: string | null): void {
  const session = sessions.get(sessionId);
  if (!session || session.screenWatchingSessionId === targetSessionId) return;
  session.screenWatchingSessionId = targetSessionId;
  announceUpdate(session);
}

function announceUpdate(session: LiveSession): void {
  session.lastSeen = Date.now();
  announce({
    kind: 'update', sessionId: session.sessionId, userId: session.member.id, from: null,
    to: session.projectId ? { projectId: session.projectId, entry: entryFor(session) } : null,
  });
}

/**
 * A session has gone: it stops being present, and the map it was on is settled.
 *
 * A returning client is a fresh session that says where it left off in the room's sequence; nothing is queued
 * here for one that is away. What it held while it was gone is held by the client, which is where the decision
 * about replaying it belongs (docs/039).
 */
export function closeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const left = session.projectId;
  const before = left ? entryFor(session) : null;
  sessions.delete(sessionId);
  removeFromProject(left, sessionId);
  if (left) settleIdle(left);
  announce({
    kind: 'close', sessionId, userId: session.member.id,
    from: left && before ? { projectId: left, entry: before } : null,
    to: null,
  });
  // As on open, a map-less tab has no presence delta to invalidate the roster on its behalf.
  if (!left) announceStatus(session.member.id);
}

const entryFor = (session: LiveSession): PresenceEntry => ({
  userId: session.member.id,
  sessionId: session.sessionId,
  clientId: session.clientId,
  deviceLabel: session.deviceLabel,
  username: session.member.username,
  role: session.member.role,
  ...(session.member.snowboardTextureUrl ? { snowboardTextureUrl: session.member.snowboardTextureUrl } : {}),
  ...(session.member.skiTextureUrl ? { skiTextureUrl: session.member.skiTextureUrl } : {}),
  ...(session.member.equipmentEdgeColor ? { equipmentEdgeColor: session.member.equipmentEdgeColor } : {}),
  ...(session.referenceLevel ? { referenceLevel: session.referenceLevel } : {}),
  ...(session.playing ? { playing: session.playing } : {}),
  ...(session.screenSharing ? { screenSharing: true } : {}),
  ...(session.screenWatchingSessionId ? { screenWatchingSessionId: session.screenWatchingSessionId } : {}),
  color: colorFor(session.member.id),
  lastSeen: session.lastSeen,
});

/** Presence for one map, oldest arrival first so the list does not reshuffle under a reader. */
export function presenceFor(projectId: string, now = Date.now()): PresenceEntry[] {
  return sessionsOn(projectId)
    .filter(session => now - session.lastSeen < sessionPolicy.presenceTtlMs).map(entryFor);
}

/** The whole table, which is what every client is pushed: which maps have somebody on them, and who. */
export function presenceTable(now = Date.now()): Record<string, PresenceEntry[]> {
  const table: Record<string, PresenceEntry[]> = {};
  for (const projectId of projectSessions.keys()) {
    const present = presenceFor(projectId, now);
    if (present.length) table[projectId] = present;
  }
  return table;
}

// ---- the end of a session on a map ----

/** Nobody is left on this map: report who wrote on it so the checkpoint can be credited, and forget them. */
function settleIdle(projectId: string): void {
  if (sessionsOn(projectId).length) return;
  const members = writers.get(projectId);
  writers.delete(projectId);
  const named = members?.size ? [...members].sort() : [];
  for (const listener of idleListeners) listener(projectId, named);
}

/** Drop what has gone quiet: sessions whose socket never closed. */
export function sweepSessions(now = Date.now()): void {
  for (const session of [...sessions.values()]) {
    if (now - session.lastSeen >= sessionPolicy.presenceTtlMs) closeSession(session.sessionId);
  }
}

/** Everything this module holds, discarded — for a test that wants a server's session table to start empty. */
export function forgetSessions(): void {
  sessions.clear();
  projectSessions.clear();
  writers.clear();
}
