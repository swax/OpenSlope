import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { DocumentDigest } from '../../core/doc/digest';
import { globalRegister } from '../../core/doc/registers';
import { onAccountAccessChanged, onAccountProfileChanged } from '../accounts/events';
import { authorityRefusal, authorizeRequest, crossSiteRefusal, type Identity } from '../accounts/guard';
import { holds, requiresAccounts } from '../accounts/policy';
import { recordUserLastSeen } from '../accounts/sessions';
import { listUsers } from '../accounts/users';
import { accessFor } from '../app';
import { workspaceConfig } from '../workspace-config';
import { onLibraryChanged } from '../library-events';
import { createLogger } from '../log';
import {
  activeProjectFor, canEditProject, canManageProject, checkpointOnSessionEnd, onProjectDeleted,
  onProjectPermissionsChanged, onProjectWritten, projectManifest, type ProjectManifest, type ProjectSnapshot,
} from '../projects';
import {
  onChatLine, scrollbackFor, submitChat, systemEvent,
  type ChatDirectory, type ChatLine, type ChatWho,
} from './chat';
import {
  closeSession, colorFor, forgetWriters, liveSessions, noteWriter, onMemberStatusChanged,
  onPresenceChanged, onProjectIdle, openSession, presenceTable, sessionById, sessionPolicy, sessionsOn,
  setAwareness, setSessionIdle, sweepSessions,
  touchSession, watchPlaying, watchProject, watchReference, watchScreenSharing, watchScreenWatching,
  type Awareness, type PresenceChange, type PresenceEntry, type SessionMember,
} from './presence';
import {
  assign, changesSince, claimTopology, closeRoom, discardRoom, joinRoom, onWire, roomDigest, roomFor,
  roomSection, type RegisterAssignment,
} from './room';
import { awarenessPolicyFor, type AwarenessPolicy } from './awareness-policy';
import { CAPACITY_CLOSE_CODE, CAPACITY_CLOSE_REASON, reservePlayerSeat } from './capacity';
import { sanitizePlayerPose } from '../../core/session/player-pose';
import {
  sanitizeRideEventMessage, type RideEventMessage, type SharedRideEvent,
} from '../../core/session/ride-event';
import { acceptWebSocket, isWebSocketUpgrade, prepareWebSocketText, refuseUpgrade } from './socket';
import { createJukebox, type ServerJukebox } from './jukebox';
import type { JukeboxState } from '../../core/session/jukebox';
import {
  sanitizeSharedScreenState, type SharedScreenFrame, type SharedScreenState,
} from '../../core/session/screen-share';

const log = createLogger('session');

/**
 * One long-lived socket per browser tab, carrying presence, awareness, register changes, topology claims and
 * the room (docs/038, docs/039).
 *
 * It lives in the service rather than in a Vite plugin, which is the reason the service was split out in the
 * first place: Vite restarts itself when its config changes and re-evaluates modules on every hot update, so a
 * presence table and a live document held there would be reset at moments nobody chose. Vite forwards the
 * upgrade on `/api` (`vite.config.ts`, `ws: true`) and everything below runs in the process that owns the
 * workspace.
 *
 * The socket authenticates exactly the way every other route does: `authorizeRequest` over the upgrade
 * request, reading the same httpOnly session cookie the browser sends with an ordinary fetch. There is no
 * token in the URL to leak into a log and no second identity path — on a server with no accounts the upgrade
 * resolves to the owner and connects with nothing asked, which is what editing alone looks like.
 *
 * ## What travels
 *
 * Register-shaped, absolute values, in both directions. A client says "these registers now hold these values",
 * never "I performed this operation" — the relative tools resolve into the values they produce before anything
 * is sent — so an ordinary edit has a defined outcome whatever order it arrives in and can never be refused.
 * Keeping the wire that shape is also what would let a CRDT slot in behind it later without the editor
 * noticing (docs/039).
 *
 * The room (docs/038) rides here too (`chat.ts` holds its rules). Chat is server-wide, so a line goes to every
 * session rather than to a map; the system events in the same stream are generated below from the tables this
 * file already keeps, never from anything a client said.
 */

/** Where the channel listens. Declared in `ROUTE_ACCESS` like every other mount, so what it asks of a caller
 *  is decided in the same table as the HTTP routes. */
export const SESSION_PATH = '/api/session';

/**
 * What this build's documents and core evaluate as.
 *
 * Participants compare these when they join, and a mismatched install joins read-only rather than writing
 * geometry the others would evaluate differently (docs/039). The document version is the format; the core
 * version is the evaluator — tessellation, crease handling, the ops — which two installs must agree on for
 * "the same document" to mean the same mountain.
 */
export const DOCUMENT_VERSION = 3;
export const CORE_VERSION = '2';

/** A normal editor peaks around forty channel messages a second (25 Hz registers + 12.5 Hz awareness). The
 * burst leaves room for topology and reconnect catch-up without letting one socket monopolise the event loop. */
const INBOUND_MESSAGES_PER_SECOND = 120;
const INBOUND_MESSAGE_BURST = 240;
const INBOUND_BYTES_PER_SECOND = 8 * 1024 * 1024;
const INBOUND_BYTE_BURST = 32 * 1024 * 1024;
/** World interactions are human-scale one-shots. Give simultaneous pads/breakables room to burst without
 * allowing an authenticated tab to turn the project relay into a particle/sound flood. */
const RIDE_EVENTS_PER_SECOND = 12;
const RIDE_EVENT_BURST = 24;
const MAX_ASSIGNMENTS = 4096;
const MAX_CLAIM_IDS = 100_000;
/** Catch account-file changes made by the separate CLI process as well as in-process admin actions. */
const ACCESS_RECHECK_MS = 30_000;

// ---- the wire protocol ----

/** What a client may say. Anything else is answered with an error and the socket is left open. */
export type ClientMessage =
  /** Which map this tab is on, the sequence it last saw there, and what it evaluates documents with. */
  | { t: 'watch'; projectId: string | null; at?: number; doc?: number; core?: string }
  /** Which extracted mountain is loaded in this tab's read-only Reference slot. */
  | { t: 'reference'; level: string | null }
  /** Which world this tab is actively playing. */
  | { t: 'playing'; playing: 'authored' | 'reference' | null }
  /** Opt-in screen sharing plus its disposable view stream and observer subscription. */
  | { t: 'screen-share'; enabled: boolean }
  | { t: 'screen-state'; state: SharedScreenState }
  | { t: 'screen-observe'; sessionId: string | null; active?: boolean }
  /** Absolute register assignments — the whole of an ordinary edit. */
  | { t: 'assign'; changes: RegisterAssignment[]; batch?: number }
  /** A topology edit, compare-and-swapping the ids it consumes. */
  | { t: 'claim'; ids: string[]; at: number; document: EditDoc; batch?: number }
  /** This replica's two-level digest, for the drift check. */
  | { t: 'digest'; root: string; sections: Record<string, string> }
  /** Refetch exactly the sections that diverged. */
  | { t: 'fetch'; sections: string[] }
  /** This tab's live selection, cursor and drag. */
  | { t: 'aware'; aware: Partial<Awareness> }
  /** The server-wide video queue. URLs are public identities; bridge credentials never travel here. */
  | { t: 'jukebox-add'; url: string }
  | { t: 'jukebox-remove'; id: string }
  | { t: 'jukebox-skip'; id: string }
  | { t: 'jukebox-seek'; id: string; position: number }
  | { t: 'jukebox-playing'; id: string; playing: boolean }
  | { t: 'jukebox-ended'; id: string; mediaVersion: number }
  /** One locally detected, throwaway Play-world interaction. Project and sender identity come from the socket. */
  | ({ t: 'ride-event' } & RideEventMessage)
  | { t: 'chat'; text: string }
  /** Human inactivity transition, separate from transport pings which only prove the tab is connected. */
  | { t: 'idle'; idle: boolean }
  | { t: 'ping'; at?: number };

export type ServerMessage =
  | { t: 'welcome'; sessionId: string; clientId: string; accounts: 'open' | 'required'; member: SessionMember;
    projectId: string | null; color: string; serverTime: number; versions: { doc: number; core: string } }
  | { t: 'presence'; maps: Record<string, PresenceEntry[]> }
  /** One participant joined, left or moved. Absolute upserts make repeated or coalesced delivery harmless. */
  | { t: 'presence-delta'; change: PresenceChange }
  /** Where the room is, whether this tab may write to it, and why not when it may not. */
  | { t: 'joined'; projectId: string; at: number; writable: boolean; reason?: string }
  /** Somebody else's registers, absolute. */
  | { t: 'sync'; projectId: string; at: number; changes: RegisterAssignment[]; by: string }
  /** How a batch of this tab's own assignments turned out. */
  | { t: 'landed'; batch: number; at: number; retired: string[]; refused: string[] }
  /** How a topology claim turned out. A loser is handed the document that won, so it moves from its own
   *  optimistic state straight to the authoritative one rather than back through the state it started in. */
  | { t: 'claim'; batch: number; ok: boolean; at: number; document?: EditDoc; by?: string }
  /** Somebody else's accepted topology, whole — topology renumbers, so nothing smaller would do. */
  | { t: 'topology'; projectId: string; at: number; document: EditDoc; by: string }
  /** The room's digest, answering a drift check. */
  | { t: 'digest'; projectId: string; at: number; root: string; sections: Record<string, string> }
  /** The repair: one divergent section's registers, or the document when what diverged was the topology. */
  | { t: 'sections'; projectId: string; at: number; registers: RegisterAssignment[]; document?: EditDoc }
  /** What everybody the caught-up client missed did while it was away, so it can be told rather than guess. */
  | { t: 'caught-up'; projectId: string; at: number; changes: RegisterAssignment[]; document?: EditDoc }
  /** The disposable states that changed during one room window, encoded once and shared by every socket. */
  | { t: 'awareness-batch'; projectId: string; peers: AwarenessPeer[] }
  /** The cadence browsers on this room should use when publishing disposable awareness. */
  | { t: 'room-policy'; projectId: string; awarenessMs: number }
  | ({ t: 'screen-state' } & SharedScreenFrame)
  | { t: 'screen-observe-ended'; sessionId: string }
  | { t: 'screen-watchers'; count: number }
  /** A shared asset catalogue changed; immutable asset bytes themselves never need invalidating. */
  | { t: 'library-changed'; scope: 'custom' | 'shared' }
  /** Account presentation changed; clients with a roster open re-read it without disturbing sessions. */
  | { t: 'profile-changed'; userId: string }
  /** Automatic activity changed; this invalidates the aggregate member roster, not map presence. */
  | { t: 'status-changed'; userId: string }
  /** A whole document that arrived outside the room — an import, a checkpoint restore, a script. */
  | { t: 'revision'; projectId: string; project: ProjectSnapshot['project']; document: ProjectSnapshot['document'] }
  /** Ownership/edit policy changed without changing the mountain document. */
  | { t: 'project-access'; projectId: string; project: ProjectSnapshot['project']; writable: boolean;
    reason?: string; document?: EditDoc }
  /** The map this tab was on has been deleted, so it is on no map now and there is nothing left to write to. */
  | { t: 'gone'; projectId: string; name: string }
  // The room (docs/038). A joiner is replayed what it missed, and hears every line after that one at a time.
  | { t: 'chat-history'; lines: ChatLine[] }
  | { t: 'chat'; line: ChatLine }
  | { t: 'jukebox-state'; state: JukeboxState }
  | { t: 'jukebox-error'; message: string }
  /** A live-only Play-world interaction. It is never written into document history or replayed to a joiner. */
  | ({ t: 'ride-event' } & SharedRideEvent)
  | { t: 'pong'; echo?: number; serverTime: number }
  | { t: 'error'; message: string };

/** One participant's absolute latest state inside a room batch. The project id lives on the batch once. */
interface AwarenessPeer {
  sessionId: string;
  userId: string;
  username: string;
  deviceLabel: string;
  color: string;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
  aware: Awareness;
}

/** The member behind an identity. A server with no accounts answers its owner here, so nothing below this
 *  line asks which kind of server it is running on. */
function memberOf(identity: Identity): SessionMember | null {
  if (identity.kind === 'owner' || identity.kind === 'member') {
    const { id, username, role, snowboardTextureUrl, skiTextureUrl, equipmentEdgeColor } = identity.user;
    return {
      id, username, role,
      ...(snowboardTextureUrl ? { snowboardTextureUrl } : {}),
      ...(skiTextureUrl ? { skiTextureUrl } : {}),
      ...(equipmentEdgeColor ? { equipmentEdgeColor } : {}),
    };
  }
  return null;
}

/** The same member, as a chat line names them. */
const whoOf = (member: SessionMember): ChatWho => ({
  userId: member.id, username: member.username, role: member.role,
});

// ---- the connected fleet ----

const send = (sessionId: string, message: ServerMessage): void => sessionById(sessionId)?.send(message);

/** Encode one fleet message once, including its WebSocket frame, and share those immutable bytes. */
function sendMany(recipients: Iterable<ReturnType<typeof liveSessions>[number]>, message: ServerMessage,
  options: { except?: string; coalesceKey?: string } = {}): void {
  const prepared = prepareWebSocketText(JSON.stringify(message));
  for (const session of recipients) {
    if (session.sessionId === options.except) continue;
    session.sendPrepared(prepared, options.coalesceKey);
  }
}

// ---- opt-in screen streams ----

/** One observer has one target. Reverse indexing makes a target withdrawal/disconnect an immediate barrier. */
const screenTargetByObserver = new Map<string, string>();
const screenObserversByTarget = new Map<string, Set<string>>();
const screenObserverActive = new Map<string, boolean>();
const latestScreenByTarget = new Map<string, SharedScreenState>();

function screenWatcherCount(targetSessionId: string): number {
  const users = new Set<string>();
  for (const observerSessionId of screenObserversByTarget.get(targetSessionId) ?? []) {
    const observer = sessionById(observerSessionId);
    if (screenObserverActive.get(observerSessionId) === true && observer) users.add(observer.member.id);
  }
  return users.size;
}

function notifyScreenWatcherCount(targetSessionId: string, count = screenWatcherCount(targetSessionId)): void {
  send(targetSessionId, { t: 'screen-watchers', count });
}

function screenFrame(targetSessionId: string, state: SharedScreenState): ServerMessage | null {
  const target = sessionById(targetSessionId);
  if (!target?.screenSharing || !target.projectId) return null;
  return {
    t: 'screen-state', sessionId: targetSessionId,
    userId: target.member.id, username: target.member.username,
    projectId: target.projectId, referenceLevel: target.referenceLevel,
    ...state,
  };
}

function stopObserving(observerSessionId: string): void {
  const targetSessionId = screenTargetByObserver.get(observerSessionId);
  if (!targetSessionId) return;
  const wasActive = screenObserverActive.get(observerSessionId) === true;
  screenTargetByObserver.delete(observerSessionId);
  screenObserverActive.delete(observerSessionId);
  const observers = screenObserversByTarget.get(targetSessionId);
  observers?.delete(observerSessionId);
  if (!observers?.size) screenObserversByTarget.delete(targetSessionId);
  watchScreenWatching(observerSessionId, null);
  if (wasActive) notifyScreenWatcherCount(targetSessionId);
}

function endScreenStream(targetSessionId: string): void {
  latestScreenByTarget.delete(targetSessionId);
  const observers = screenObserversByTarget.get(targetSessionId);
  screenObserversByTarget.delete(targetSessionId);
  notifyScreenWatcherCount(targetSessionId, 0);
  if (!observers?.size) return;
  for (const observerSessionId of observers) {
    screenTargetByObserver.delete(observerSessionId);
    screenObserverActive.delete(observerSessionId);
    watchScreenWatching(observerSessionId, null);
    send(observerSessionId, { t: 'screen-observe-ended', sessionId: targetSessionId });
  }
}

function closeScreenSession(sessionId: string): void {
  stopObserving(sessionId);
  endScreenStream(sessionId);
}

function observeScreen(observerSessionId: string, targetSessionId: string | null, active: boolean): void {
  const currentTarget = screenTargetByObserver.get(observerSessionId);
  if (!targetSessionId) { stopObserving(observerSessionId); return; }
  const target = sessionById(targetSessionId);
  if (!target?.screenSharing || !target.projectId || targetSessionId === observerSessionId) {
    stopObserving(observerSessionId);
    send(observerSessionId, { t: 'screen-observe-ended', sessionId: targetSessionId });
    return;
  }
  if (currentTarget === targetSessionId) {
    const wasActive = screenObserverActive.get(observerSessionId) === true;
    screenObserverActive.set(observerSessionId, active);
    watchScreenWatching(observerSessionId, active ? targetSessionId : null);
    if (wasActive !== active) notifyScreenWatcherCount(targetSessionId);
    if (active) {
      const latest = latestScreenByTarget.get(targetSessionId);
      const frame = latest && screenFrame(targetSessionId, latest);
      if (frame) send(observerSessionId, frame);
    }
    return;
  }
  stopObserving(observerSessionId);
  screenTargetByObserver.set(observerSessionId, targetSessionId);
  screenObserverActive.set(observerSessionId, active);
  const observers = screenObserversByTarget.get(targetSessionId) ?? new Set<string>();
  observers.add(observerSessionId);
  screenObserversByTarget.set(targetSessionId, observers);
  watchScreenWatching(observerSessionId, active ? targetSessionId : null);
  if (active) notifyScreenWatcherCount(targetSessionId);
  const latest = latestScreenByTarget.get(targetSessionId);
  const frame = latest && screenFrame(targetSessionId, latest);
  if (active && frame) send(observerSessionId, frame);
}

function publishScreen(targetSessionId: string, input: unknown): void {
  const state = sanitizeSharedScreenState(input);
  const frame = state && screenFrame(targetSessionId, state);
  if (!state || !frame) return;
  latestScreenByTarget.set(targetSessionId, state);
  const recipients = [...screenObserversByTarget.get(targetSessionId) ?? []]
    .filter(sessionId => screenObserverActive.get(sessionId) === true)
    .flatMap(sessionId => {
      const observer = sessionById(sessionId);
      return observer ? [observer] : [];
    });
  if (recipients.length) sendMany(recipients, frame, { coalesceKey: `screen:${targetSessionId}` });
}

/** Everyone else on one map. The tab that sent a change already holds it, and sending it back would replace a
 *  live edit with an echo of itself. */
function relay(projectId: string, exceptSessionId: string, message: ServerMessage, coalesceKey?: string): void {
  sendMany(sessionsOn(projectId), message, { except: exceptSessionId, coalesceKey });
}

// ---- disposable awareness batches ----

interface PendingAwareness {
  peers: Map<string, AwarenessPeer>;
  timer: ReturnType<typeof setTimeout> | null;
}

const pendingAwareness = new Map<string, PendingAwareness>();
const awarenessPolicies = new Map<string, AwarenessPolicy>();

function projectAwarenessPolicy(projectId: string): AwarenessPolicy {
  const participants = sessionsOn(projectId).length;
  const policy = awarenessPolicyFor(participants, awarenessPolicies.get(projectId));
  if (participants) awarenessPolicies.set(projectId, policy);
  else awarenessPolicies.delete(projectId);
  return policy;
}

const sameAwarenessPolicy = (a: AwarenessPolicy | undefined, b: AwarenessPolicy): boolean =>
  !!a && a.flushMs === b.flushMs && a.publishMs === b.publishMs;

/**
 * Tell the room when its tier changes. An arrival inside the same tier is the only participant that has not
 * heard the existing policy, so addressing it alone keeps a connection burst from turning this control
 * message into another quadratic broadcast.
 */
function sendRoomPolicy(projectId: string, newcomerId?: string): void {
  const recipients = sessionsOn(projectId);
  if (!recipients.length) { awarenessPolicies.delete(projectId); return; }
  const previous = awarenessPolicies.get(projectId);
  const policy = projectAwarenessPolicy(projectId);
  const message: ServerMessage = { t: 'room-policy', projectId, awarenessMs: policy.publishMs };
  if (!sameAwarenessPolicy(previous, policy)) sendMany(recipients, message);
  else if (newcomerId && sessionById(newcomerId)?.projectId === projectId) send(newcomerId, message);
}

/**
 * Flush only states that changed, but include at most one — the newest — per participant. The batch is sent
 * to its authors as well so every recipient gets identical framed bytes; browser clients ignore their own
 * entry. A batch is intentionally not socket-level coalesced: two successive changed-only batches can name
 * different participants, so replacing one with the other would lose an absolute state transition.
 */
function flushAwareness(projectId: string): void {
  const pending = pendingAwareness.get(projectId);
  if (!pending) return;
  pending.timer = null;
  const recipients = sessionsOn(projectId);
  const peers = [...pending.peers.values()].filter(peer =>
    sessionById(peer.sessionId)?.projectId === projectId);
  pending.peers.clear();
  if (recipients.length > 1 && peers.length) {
    sendMany(recipients, { t: 'awareness-batch', projectId, peers });
  }
  if (!pending.peers.size && !pending.timer) pendingAwareness.delete(projectId);
}

function queueAwareness(projectId: string, peer: AwarenessPeer): void {
  // The state still lives on the session for presence and a later update; there is nobody else to relay to.
  if (sessionsOn(projectId).length < 2) return;
  const pending = pendingAwareness.get(projectId) ?? { peers: new Map(), timer: null };
  pending.peers.set(peer.sessionId, peer);
  pendingAwareness.set(projectId, pending);
  if (pending.timer) return;
  pending.timer = setTimeout(() => flushAwareness(projectId), projectAwarenessPolicy(projectId).flushMs);
  pending.timer.unref?.();
}

function dropPendingAwareness(projectId: string, sessionId?: string): void {
  const pending = pendingAwareness.get(projectId);
  if (!pending) return;
  if (sessionId) pending.peers.delete(sessionId);
  else pending.peers.clear();
  if (pending.peers.size) return;
  if (pending.timer) clearTimeout(pending.timer);
  pendingAwareness.delete(projectId);
}

function stopAwarenessBatches(): void {
  for (const pending of pendingAwareness.values()) if (pending.timer) clearTimeout(pending.timer);
  pendingAwareness.clear();
  awarenessPolicies.clear();
}

// ---- the room (docs/038) ----

/**
 * Who a `/msg` may name.
 *
 * Connected members answer first, because they are already in hand. The account store is what makes an
 * offline member reachable at all: a private line to somebody who is not here is retained and replayed when
 * they arrive, exactly like any other line they missed. A server with no accounts has one member, so a name
 * that is not the person already on the socket is simply nobody.
 */
const directory: ChatDirectory = {
  async find(name: string): Promise<ChatWho | null> {
    const wanted = name.trim().toLowerCase();
    if (!wanted) return null;
    const here = liveSessions().find(session => session.member.username.toLowerCase() === wanted);
    if (here) return whoOf(here.member);
    if (!requiresAccounts()) return null;
    const users = await listUsers();
    const found = users.find(user => user.username === wanted);
    if (!found || found.disabled) return null;
    return { userId: found.id, username: found.username, role: found.role };
  },
};

/**
 * Which members are here, so arrivals and departures are announced once per person rather than once per tab.
 *
 * Read off presence rather than off the socket callbacks, because a session ends three ways — the socket
 * closed, the map was left, the sweep found it silent — and all three land in the same table.
 */
const here = new Map<string, { username: string; sessions: number }>();

// ---- joining a map ----

/** Why a tab may not write. A viewer follows read-only, and so does an install that would evaluate this
 *  mountain differently from everybody else on it (docs/039). */
function writeRefusal(member: SessionMember, project: ProjectManifest,
  versions: { doc?: number; core?: string }): string {
  if (!holds(member.role, 'editor')) return 'Following read-only: changing a map needs the editor role.';
  if (!canEditProject(project, member)) {
    return 'Following read-only: this map is restricted to editors selected by its owner.';
  }
  if (versions.doc !== undefined && versions.doc !== DOCUMENT_VERSION) {
    return `Following read-only: this build reads documents at version ${versions.doc}, and this server holds `
      + `version ${DOCUMENT_VERSION}.`;
  }
  if (versions.core !== undefined && versions.core !== CORE_VERSION) {
    return 'Following read-only: this build evaluates mountains differently from the rest of the room.';
  }
  return '';
}

/**
 * A tab has said which map it is on, where it left off, and what it evaluates documents with.
 *
 * Joining opens the room if nobody had it open, answers where the room is, and — for a tab that says it was
 * here before — hands back exactly what it missed, or the document when the tail no longer reaches that far.
 */
async function joinMap(sessionId: string, wanted: string | null,
  asked: { at?: number; doc?: number; core?: string }): Promise<void> {
  watchProject(sessionId, wanted);
  const session = sessionById(sessionId);
  if (!session || !wanted || session.projectId !== wanted) return;
  const project = await projectManifest(wanted);
  const refusal = writeRefusal(session.member, project, asked);
  session.writable = !refusal;
  session.managesProject = canManageProject(project, session.member);
  session.docVersion = asked.doc;
  session.coreVersion = asked.core;
  const room = await joinRoom(wanted);
  if (sessionById(sessionId) !== session || session.projectId !== wanted) return;
  send(sessionId, {
    t: 'joined', projectId: wanted, at: room.at, writable: session.writable,
    ...(refusal ? { reason: refusal } : {}),
  });
  if (asked.at === undefined) { session.at = room.at; return; }
  const missed = changesSince(room, asked.at);
  session.at = room.at;
  send(sessionId, missed === null
    ? { t: 'caught-up', projectId: wanted, at: room.at, changes: [], document: room.doc }
    : { t: 'caught-up', projectId: wanted, at: room.at, changes: onWire(missed) });
}

// ---- what a client says ----

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** An assignment list as it must arrive: pairs of a key and whatever value that register holds. */
function assignments(value: unknown): RegisterAssignment[] | null {
  if (!Array.isArray(value) || value.length > MAX_ASSIGNMENTS) return null;
  const out: RegisterAssignment[] = [];
  for (const change of value) {
    if (!Array.isArray(change) || typeof change[0] !== 'string') return null;
    out.push([change[0], change[1]]);
  }
  return out;
}

function onAssign(sessionId: string, message: Extract<ClientMessage, { t: 'assign' }>): void {
  const session = sessionById(sessionId);
  const projectId = session?.projectId;
  if (!session || !projectId) { send(sessionId, { t: 'error', message: 'Open a map before editing it.' }); return; }
  if (!session.writable) { send(sessionId, { t: 'error', message: 'This tab is following read-only.' }); return; }
  const changes = assignments(message.changes);
  if (!changes) { send(sessionId, { t: 'error', message: 'That was not a set of register assignments.' }); return; }
  const room = roomFor(projectId);
  if (!room) { send(sessionId, { t: 'error', message: 'This map is not open on the server.' }); return; }

  const renameKey = globalRegister('name');
  const refusedRename = session.managesProject ? [] : changes.filter(([key]) => key === renameKey);
  const allowed = refusedRename.length ? changes.filter(([key]) => key !== renameKey) : changes;
  const written = assign(room, allowed, session.member.username);
  session.at = written.at;
  send(sessionId, {
    t: 'landed', batch: message.batch ?? 0, at: written.at,
    retired: written.retired, refused: [...written.refused, ...refusedRename.map(([key]) => key)],
  });
  // Only what moved the document is relayed: an assignment for geometry somebody has deleted, or one that
  // wrote the value a register already held, is not news anybody else has to be told.
  if (!written.landed.length) return;
  noteWriter(sessionId);
  relay(projectId, sessionId,
    { t: 'sync', projectId, at: written.at, changes: onWire(written.landed), by: session.member.username });
}

function onClaim(sessionId: string, message: Extract<ClientMessage, { t: 'claim' }>): void {
  const session = sessionById(sessionId);
  const projectId = session?.projectId;
  if (!session || !projectId) { send(sessionId, { t: 'error', message: 'Open a map before editing it.' }); return; }
  if (!session.writable) { send(sessionId, { t: 'error', message: 'This tab is following read-only.' }); return; }
  const room = roomFor(projectId);
  if (!room) { send(sessionId, { t: 'error', message: 'This map is not open on the server.' }); return; }
  if (!message.document || typeof message.document !== 'object') {
    send(sessionId, { t: 'error', message: 'A topology claim carries the mountain it produced.' });
    return;
  }
  const ids = strings(message.ids);
  if (ids.length > MAX_CLAIM_IDS) {
    send(sessionId, { t: 'error', message: `A topology claim may name at most ${MAX_CLAIM_IDS} ids.` });
    return;
  }
  const document = session.managesProject
    ? message.document : { ...message.document, name: room.doc.name };
  const held = claimTopology(room, { ids, at: Number(message.at) || 0, document });
  session.at = held.at;
  if (!held.ok) {
    // The loser is handed what won, so it goes from its own optimistic geometry to the authoritative geometry
    // in one step rather than back through the geometry it started with.
    send(sessionId, { t: 'claim', batch: message.batch ?? 0, ok: false, at: held.at, document: held.document });
    return;
  }
  send(sessionId, { t: 'claim', batch: message.batch ?? 0, ok: true, at: held.at });
  noteWriter(sessionId);
  relay(projectId, sessionId, {
    t: 'topology', projectId, at: held.at, document: held.document, by: session.member.username,
  });
}

/**
 * The drift check, answered rather than adjudicated.
 *
 * The room hands back its own two-level digest and the client does the comparison, because the client is the
 * side that has to act on it: compare the roots, descend one level on a mismatch, and refetch exactly the
 * divergent chunk. What the caller sent is not read — it is a heartbeat that says a replica is idle enough to
 * be checked, and the answer would be the same digest either way.
 */
function onDigest(sessionId: string): void {
  const session = sessionById(sessionId);
  const room = session?.projectId ? roomFor(session.projectId) : undefined;
  if (!session?.projectId || !room) return;
  const mine: DocumentDigest = roomDigest(room);
  send(sessionId, {
    t: 'digest', projectId: session.projectId, at: room.at, root: mine.root, sections: mine.sections,
  });
}

function onFetch(sessionId: string, message: Extract<ClientMessage, { t: 'fetch' }>): void {
  const session = sessionById(sessionId);
  const room = session?.projectId ? roomFor(session.projectId) : undefined;
  if (!session?.projectId || !room) return;
  const registers: RegisterAssignment[] = [];
  let document: EditDoc | undefined;
  for (const section of strings(message.sections).slice(0, 64)) {
    const repair = roomSection(room, section);
    if ('document' in repair) document = repair.document;
    else registers.push(...repair.registers);
  }
  send(sessionId, {
    t: 'sections', projectId: session.projectId, at: room.at, registers: onWire(registers),
    ...(document ? { document } : {}),
  });
}

function onAware(sessionId: string, message: Extract<ClientMessage, { t: 'aware' }>): void {
  const session = sessionById(sessionId);
  if (!session?.projectId) return;
  const said = message.aware ?? {};
  const aware = setAwareness(sessionId, {
    // Pointer coordinates ride the observer-routed screen stream. Never rebroadcast a cursor to the room,
    // even if an older or modified client still includes one in general awareness.
    cursor: null,
    vertices: strings(said.vertices).slice(0, 512),
    quads: strings(said.quads).slice(0, 512),
    dragging: strings(said.dragging).slice(0, 512),
    player: sanitizePlayerPose(said.player, Date.now()),
  });
  if (!aware) return;
  queueAwareness(session.projectId, {
    sessionId,
    userId: session.member.id, username: session.member.username, deviceLabel: session.deviceLabel,
    color: colorFor(session.member.id),
    ...(session.member.snowboardTextureUrl ? { snowboardTextureUrl: session.member.snowboardTextureUrl } : {}),
    ...(session.member.skiTextureUrl ? { skiTextureUrl: session.member.skiTextureUrl } : {}),
    ...(session.member.equipmentEdgeColor ? { equipmentEdgeColor: session.member.equipmentEdgeColor } : {}),
    aware,
  });
}

function onJukebox(sessionId: string,
  message: Extract<ClientMessage, { t: 'jukebox-add' | 'jukebox-remove' | 'jukebox-skip'
    | 'jukebox-seek' | 'jukebox-playing' | 'jukebox-ended' }>, jukebox: ServerJukebox): void {
  const session = sessionById(sessionId);
  if (!session) return;
  const result = message.t === 'jukebox-add' ? jukebox.add(session.member, message.url)
    : message.t === 'jukebox-remove' ? jukebox.remove(session.member, message.id)
      : message.t === 'jukebox-skip' ? jukebox.skip(session.member, message.id)
        : message.t === 'jukebox-seek' ? jukebox.seek(message.id, message.position)
          : message.t === 'jukebox-playing' ? jukebox.setPlaying(message.id, message.playing)
            : jukebox.ended(message.id, message.mediaVersion);
  if (!result.ok) {
    // Every decoder can notice the same end. The first matching epoch advances; later reports are harmlessly
    // stale and should not turn into an error banner on otherwise healthy clients.
    if (message.t !== 'jukebox-ended') send(sessionId, { t: 'jukebox-error', message: result.error });
    return;
  }
  sendMany(liveSessions(), { t: 'jukebox-state', state: result.state });
}

function handleMessage(sessionId: string, raw: string, jukebox: ServerJukebox,
  onRideEvent: (message: Extract<ClientMessage, { t: 'ride-event' }>) => void): void {
  let parsed: ClientMessage;
  try { parsed = JSON.parse(raw) as ClientMessage; }
  catch { send(sessionId, { t: 'error', message: 'That was not a message this channel speaks.' }); return; }
  touchSession(sessionId);
  if (!sessionById(sessionId)) return;

  switch (parsed?.t) {
    case 'ping':
      send(sessionId, { t: 'pong', echo: Number.isFinite(parsed.at) ? parsed.at : undefined, serverTime: Date.now() });
      return;
    case 'idle':
      setSessionIdle(sessionId, parsed.idle === true);
      return;
    case 'watch': {
      const wanted = typeof parsed.projectId === 'string' && parsed.projectId ? parsed.projectId : null;
      void joinMap(sessionId, wanted, parsed)
        .catch(error => {
          log.error('joining a map failed', { error });
          send(sessionId, { t: 'error', message: 'That map could not be opened on the server.' });
        });
      return;
    }
    case 'reference': {
      const level = typeof parsed.level === 'string'
        // eslint-disable-next-line no-control-regex -- strips control characters from a client-supplied level name
        ? parsed.level.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 128) || null
        : null;
      watchReference(sessionId, level);
      return;
    }
    case 'playing':
      watchPlaying(sessionId, parsed.playing === 'authored' || parsed.playing === 'reference'
        ? parsed.playing : null);
      return;
    case 'screen-share': {
      const enabled = parsed.enabled === true;
      if (!enabled) endScreenStream(sessionId);
      watchScreenSharing(sessionId, enabled);
      if (enabled) notifyScreenWatcherCount(sessionId);
      return;
    }
    case 'screen-state':
      publishScreen(sessionId, parsed.state);
      return;
    case 'screen-observe':
      observeScreen(sessionId, typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
        parsed.active !== false);
      return;
    case 'assign':
      onAssign(sessionId, parsed);
      return;
    case 'claim':
      onClaim(sessionId, parsed);
      return;
    case 'digest':
      onDigest(sessionId);
      return;
    case 'fetch':
      onFetch(sessionId, parsed);
      return;
    case 'aware':
      onAware(sessionId, parsed);
      return;
    case 'jukebox-add':
    case 'jukebox-remove':
    case 'jukebox-skip':
    case 'jukebox-seek':
    case 'jukebox-playing':
    case 'jukebox-ended':
      onJukebox(sessionId, parsed, jukebox);
      return;
    case 'ride-event':
      onRideEvent(parsed);
      return;
    case 'chat':
      // Whatever a client sends is a line from whoever sent it. There is no shape of message here that
      // produces a system line, which is what makes one a fact rather than a claim.
      void submitChat(whoOf(sessionById(sessionId)!.member), parsed.text, directory)
        .catch(error => { log.error('a chat message failed', { error }); });
      return;
    default:
      send(sessionId, { t: 'error', message: 'That was not a message this channel speaks.' });
  }
}

/** Two replenishing buckets per socket. Applied before JSON.parse, so a burst is refused before it becomes a
 * burst of main-thread parsing and register work. */
function inboundAllowance(): (text: string) => boolean {
  let messageTokens = INBOUND_MESSAGE_BURST;
  let byteTokens = INBOUND_BYTE_BURST;
  let at = Date.now();
  return text => {
    const now = Date.now();
    const elapsed = Math.max(0, now - at) / 1000;
    at = now;
    messageTokens = Math.min(INBOUND_MESSAGE_BURST,
      messageTokens + elapsed * INBOUND_MESSAGES_PER_SECOND);
    byteTokens = Math.min(INBOUND_BYTE_BURST, byteTokens + elapsed * INBOUND_BYTES_PER_SECOND);
    const bytes = Buffer.byteLength(text);
    if (messageTokens < 1 || byteTokens < bytes) return false;
    messageTokens--;
    byteTokens -= bytes;
    return true;
  };
}

/** A separate, much smaller bucket than the editor transport: legitimate ride effects are crossings, not a
 * 25 Hz state stream. Kept per socket so one noisy participant cannot spend another's allowance. */
function rideEventAllowance(): () => boolean {
  let tokens = RIDE_EVENT_BURST;
  let at = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(RIDE_EVENT_BURST, tokens + Math.max(0, now - at) / 1000 * RIDE_EVENTS_PER_SECOND);
    at = now;
    if (tokens < 1) return false;
    tokens--;
    return true;
  };
}

// ---- attaching to the service ----

/**
 * Put the channel on a running server, and take it off again.
 *
 * The returned function is what `startApiService` calls on close: it stops the sweep, drops every session and
 * unsubscribes from the write feed, so a test that starts several services in turn does not leave the
 * previous one's listeners attached to this process.
 */
export function attachSessionChannel(server: Server): () => Promise<void> {
  const jukebox = createJukebox();
  // Account authority can change after a socket was upgraded. End the captured identity immediately and let
  // the browser reload through the ordinary auth path; a revoked cookie or old role must not keep editing
  // merely because its transport is long-lived.
  const stopWatchingAccess = onAccountAccessChanged(event => {
    const affected = liveSessions().filter(session => event.kind === 'session-revoked'
      ? session.accountSessionId === event.accountSessionId
      : session.member.id === (event.kind === 'role-changed' ? event.user.id : event.userId));
    const roleChanged = event.kind === 'role-changed';
    for (const session of affected) {
      session.close(roleChanged ? 4002 : 4001,
        roleChanged ? 'Your role changed; reloading access.' : 'This login session ended.');
    }
  });

  const stopWatchingLibraries = onLibraryChanged(change => {
    sendMany(liveSessions(), { t: 'library-changed', scope: change.scope });
  });

  const stopWatchingProfiles = onAccountProfileChanged(user => {
    // Presentation is not authority, so an open socket stays open; refresh its cached member shape so the next
    // awareness heartbeat carries the new immutable image URL/edge colour to every rider already in the room.
    for (const session of liveSessions()) if (session.member.id === user.id) {
      session.member.username = user.username;
      session.member.snowboardTextureUrl = user.snowboardTextureUrl;
      session.member.skiTextureUrl = user.skiTextureUrl;
      session.member.equipmentEdgeColor = user.equipmentEdgeColor;
    }
    sendMany(liveSessions(), { t: 'profile-changed', userId: user.id });
  });

  const stopWatchingStatus = onMemberStatusChanged(userId => {
    sendMany(liveSessions(), { t: 'status-changed', userId }, { coalesceKey: `status:${userId}` });
  });

  // A whole document that arrived outside the room: an import, a checkpoint restore, a script. The room
  // adopts it (`room.ts`) and everybody on the map replaces their replica with it, because that write
  // replaced the mountain rather than assigning to it. The room's own periodic snapshots are not announced,
  // so nothing here fires for them.
  const stopWatchingWrites = onProjectWritten(({ snapshot, by }) => {
    const message: ServerMessage = {
      t: 'revision', projectId: snapshot.project.id, project: snapshot.project, document: snapshot.document,
    };
    sendMany(sessionsOn(snapshot.project.id).filter(session => !session.clientId || session.clientId !== by), message);
  });

  const stopWatchingPermissions = onProjectPermissionsChanged(project => {
    const document = roomFor(project.id)?.doc;
    for (const session of sessionsOn(project.id)) {
      const versions = { doc: session.docVersion, core: session.coreVersion };
      const refusal = writeRefusal(session.member, project, versions);
      session.writable = !refusal;
      session.managesProject = canManageProject(project, session.member);
      send(session.sessionId, {
        t: 'project-access', projectId: project.id, project, writable: session.writable,
        ...(refusal ? { reason: refusal } : {}),
        ...(document ? { document } : {}),
      });
    }
  });

  // A map somebody deleted, and the tabs that were watching it (docs/038). Three things happen before any of
  // them is moved, and each is what keeps the next from writing into a folder that is gone: the room is
  // dropped rather than snapshotted, and the roster of who wrote on the map is forgotten so that settling the
  // last session out of it reports nobody rather than asking for a checkpoint of a project that has been
  // removed. Then each tab is told, by name, and left on no map at all.
  const stopWatchingDeletes = onProjectDeleted(project => {
    dropPendingAwareness(project.id);
    awarenessPolicies.delete(project.id);
    discardRoom(project.id);
    forgetWriters(project.id);
    const message: ServerMessage = { t: 'gone', projectId: project.id, name: project.name };
    const watching = sessionsOn(project.id);
    sendMany(watching, message);
    for (const session of watching) watchProject(session.sessionId, null);
  });

  const stopWatchingPresence = onPresenceChanged(change => {
    // HTTP activity refreshes this stamp while a session is in use; closing presence captures time spent in a
    // WebSocket-only editing session too. The accounts queue makes duplicate close paths harmless.
    if (change.kind === 'close' && requiresAccounts()) {
      void recordUserLastSeen(change.userId).catch(error => {
        log.error('could not persist a member last-seen time', { error });
      });
    }
    if (change.from) dropPendingAwareness(change.from.projectId, change.sessionId);
    // A delta is absolute for one session: clients remove that id wherever it was and then apply `to`. That
    // makes a newer move safe to coalesce over an older one for a slow peer.
    if (change.from || change.to) {
      sendMany(liveSessions(), { t: 'presence-delta', change }, {
        except: change.kind === 'open' ? change.sessionId : undefined,
        coalesceKey: `presence:${change.sessionId}`,
      });
    }
    // Membership is the input to awareness pacing. Departures may make the room cross a faster tier; an
    // arrival always needs the current policy itself, and makes everybody hear it only if the tier changed.
    if (change.kind !== 'update') {
      if (change.from) sendRoomPolicy(change.from.projectId);
      if (change.to) sendRoomPolicy(change.to.projectId, change.sessionId);
    }
    if (change.kind === 'open') {
      const session = sessionById(change.sessionId);
      if (!session) return;
      const held = here.get(change.userId);
      here.set(change.userId, {
        username: session.member.username,
        sessions: (held?.sessions ?? 0) + 1,
      });
      if (!held) systemEvent(`${session.member.username} joined`);
    } else if (change.kind === 'close') {
      const held = here.get(change.userId);
      if (!held) return;
      if (held.sessions > 1) here.set(change.userId, { ...held, sessions: held.sessions - 1 });
      else {
        here.delete(change.userId);
        systemEvent(`${held.username} left`);
      }
    }
  });

  // The room is server-wide, so a line goes to every connected session — filtered only by who a private one
  // was between. Which map anybody is on has nothing to do with it.
  const stopWatchingChat = onChatLine(({ line, audience }) => {
    const message: ServerMessage = { t: 'chat', line };
    sendMany(liveSessions().filter(session =>
      audience === 'everyone' || audience.includes(session.member.id)), message);
  });

  // The last client left a map: the room writes whatever it has not written and lets go, and the work of that
  // session is set aside whole rather than waiting on a timer that will not fire again (docs/038, docs/040).
  // Tracked so shutting the channel down waits for what it just started.
  const closing = new Set<Promise<unknown>>();
  const stopWatchingIdle = onProjectIdle((projectId, members) => {
    const settling = closeRoom(projectId)
      .then(() => members.length ? checkpointOnSessionEnd(projectId, members) : null)
      .catch(error => { log.error(`closing the room on ${projectId} failed`, { error }); })
      .finally(() => closing.delete(settling));
    closing.add(settling);
  });

  const sweep = setInterval(() => sweepSessions(), sessionPolicy.sweepMs);
  sweep.unref();

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.replace(/\/+$/, '') !== SESSION_PATH) return;
    if (!isWebSocketUpgrade(req)) { refuseUpgrade(socket, 400, 'This endpoint speaks WebSocket.'); return; }

    const authority = authorityRefusal(req);
    if (authority) { refuseUpgrade(socket, authority.status, String(authority.body.error)); return; }

    // Nothing in the handshake stops a page on another site opening a socket here; on a server with no
    // accounts there is not even a cookie whose absence would refuse it. The origin is what that page cannot hide.
    const crossSite = crossSiteRefusal(req);
    if (crossSite) { refuseUpgrade(socket, crossSite.status, String(crossSite.body.error)); return; }

    // The same table, the same guard and the same cookie every `/api/*` route goes through.
    const decision = await authorizeRequest(req, accessFor(SESSION_PATH)('GET', '/'));
    if (!decision.allowed) {
      refuseUpgrade(socket, decision.status, String(decision.body.error ?? 'Refused.'));
      return;
    }
    const member = memberOf(decision.identity);
    if (!member) { refuseUpgrade(socket, 401, 'Sign in to use this server.'); return; }

    const peer = acceptWebSocket(req, socket, head);
    if (!peer) return;
    const acceptsMessage = inboundAllowance();
    const acceptsRideEvent = rideEventAllowance();
    let lastRideEventId = -1;
    // The WebSocket is open as soon as the 101 reaches the client, while this server still has one async read
    // to do for that tab's remembered project. A fast client may send `watch` in that gap. Keep those already
    // rate-limited messages instead of silently delivering them to an empty listener list.
    const earlyMessages: string[] = [];
    let sessionReady = false;
    const receive = (text: string): void => {
      if (!acceptsMessage(text)) {
        peer.close(1008, 'channel rate limit exceeded');
        return;
      }
      if (!sessionReady) { earlyMessages.push(text); return; }
      try { handleMessage(sessionId, text, jukebox, rawEvent => {
        if (!acceptsRideEvent()) {
          peer.close(1008, 'ride event rate limit exceeded');
          return;
        }
        const serverAt = Date.now();
        const event = sanitizeRideEventMessage(rawEvent, serverAt);
        if (!event) {
          send(sessionId, { t: 'error', message: 'That was not a valid ride event.' });
          return;
        }
        // The id is sender-monotonic. Repeated/reordered delivery is harmless, and a reconnect receives a new
        // authenticated session id so its counter may begin again without colliding with the old connection.
        if (event.id <= lastRideEventId) return;
        const projectId = sessionById(sessionId)?.projectId;
        if (!projectId) {
          send(sessionId, { t: 'error', message: 'Open a map before sharing a ride interaction.' });
          return;
        }
        lastRideEventId = event.id;
        relay(projectId, sessionId, {
          t: 'ride-event', ...event, projectId, fromSessionId: sessionId, serverAt,
        });
      }); }
      catch (error) { log.error('a channel message failed', { error }); }
    };

    const sessionId = randomUUID();
    const clientId = (url.searchParams.get('client') ?? '').slice(0, 64) || sessionId;
    const deviceLabel = (url.searchParams.get('device') ?? 'device')
      // eslint-disable-next-line no-control-regex -- strips control characters from a client-supplied device label
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 32) || 'device';
    let accessCheck: ReturnType<typeof setInterval> | null = null;
    peer.onMessage(receive);
    peer.onClose(() => {
      if (accessCheck) clearInterval(accessCheck);
      closeScreenSession(sessionId);
      closeSession(sessionId);
    });
    // Which map this tab was on, off the record the activate route keeps — so presence is right from the
    // first push rather than only once the editor gets around to saying so.
    const projectId = await activeProjectFor(clientId).catch(() => null);
    if (peer.closed) return;

    // Capacity is reserved only after the remembered-project read, and no asynchronous work occurs between
    // this decision and `openSession` below. Concurrent upgrades therefore cannot both claim the final seat.
    // A refused viewer is already speaking WebSocket, so it receives the private close code the browser uses
    // to explain the wait and back off instead of seeing an opaque failed HTTP upgrade.
    if (!reservePlayerSeat(member, workspaceConfig().maxPlayers)) {
      peer.close(CAPACITY_CLOSE_CODE, CAPACITY_CLOSE_REASON);
      return;
    }

    // Welcome first, directly on the peer: a client learns who it is, what colour it wears and what this
    // server evaluates documents with before it is told who else is here.
    const welcome: ServerMessage = {
      t: 'welcome', sessionId, clientId, member, projectId, color: colorFor(member.id),
      serverTime: Date.now(),
      accounts: requiresAccounts() ? 'required' : 'open',
      versions: { doc: DOCUMENT_VERSION, core: CORE_VERSION },
    };
    peer.send(JSON.stringify(welcome));
    // What this member missed, before they are told anything new — so the box they open already reads as a
    // conversation rather than filling in from whatever happens next.
    const replay: ServerMessage = { t: 'chat-history', lines: scrollbackFor(member.id) };
    peer.send(JSON.stringify(replay));
    const live = openSession({
      sessionId, clientId, deviceLabel, member, projectId,
      ...(decision.identity.kind === 'member' ? { accountSessionId: decision.identity.sessionId } : {}),
      writable: holds(member.role, 'editor'),
      send: (message: unknown) => peer.send(JSON.stringify(message)),
      sendPrepared: (frame, coalesceKey) => peer.sendPrepared(frame, { coalesceKey }),
      close: (code, reason) => peer.close(code, reason),
    });
    if (decision.identity.kind === 'member') {
      const granted = decision.identity;
      accessCheck = setInterval(() => {
        void authorizeRequest(req, 'viewer').then(current => {
          if (peer.closed) return;
          if (!current.allowed || current.identity.kind !== 'member'
            || current.identity.sessionId !== granted.sessionId) {
            peer.close(4001, 'This login session ended.');
          } else if (current.identity.user.role !== member.role) {
            peer.close(4002, 'Your role changed; reloading access.');
          }
        }).catch(() => peer.close(4001, 'This login session could not be verified.'));
      }, ACCESS_RECHECK_MS);
      accessCheck.unref();
    }
    // Deltas begin after this point. The joiner receives the one complete table it needs to seed them; existing
    // sessions received this participant's `open` delta above.
    live.send({ t: 'presence', maps: presenceTable() } satisfies ServerMessage);
    live.send({ t: 'jukebox-state', state: jukebox.snapshot() } satisfies ServerMessage);
    sessionReady = true;
    for (const text of earlyMessages.splice(0)) {
      if (peer.closed) break;
      receive(text);
    }
    // A socket that went away between the handshake and here would otherwise sit in presence until it was
    // swept for silence.
    if (peer.closed) { closeScreenSession(sessionId); closeSession(sessionId); return; }
    if (projectId) {
      await joinMap(sessionId, projectId, {}).catch(error => {
        log.error('opening the seeded map failed', { error });
      });
    }
  }

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void onUpgrade(req, socket, head).catch(error => {
      log.error('an upgrade failed', { error });
      try { refuseUpgrade(socket, 500, 'This server could not open a session channel.'); } catch { socket.destroy(); }
    });
  };
  server.on('upgrade', upgrade);

  return async () => {
    server.off('upgrade', upgrade);
    clearInterval(sweep);
    stopWatchingWrites();
    stopWatchingPermissions();
    stopWatchingDeletes();
    stopWatchingPresence();
    stopWatchingChat();
    stopWatchingIdle();
    stopWatchingAccess();
    stopWatchingLibraries();
    stopWatchingProfiles();
    stopWatchingStatus();
    stopAwarenessBatches();
    here.clear();
    // Close the upgraded sockets themselves, not only their presence rows. Node's closeAllConnections does
    // not include sockets that left HTTP through an upgrade, so leaving these alive makes a service restart
    // wait until systemd's stop timeout. `peer.close` synchronously raises its close listener, which removes
    // the session through the table and starts the last-client checkpoint before we await it below.
    for (const session of liveSessions()) {
      try { session.close(1012, 'Slopesmith is restarting.'); }
      finally { closeScreenSession(session.sessionId); closeSession(session.sessionId); }
    }
    screenTargetByObserver.clear();
    screenObserversByTarget.clear();
    screenObserverActive.clear();
    latestScreenByTarget.clear();
    await Promise.all([...closing]);
  };
}
