import type { EditDoc } from '../../core/doc/doc-edit';
import type { TopologyDelta } from '../../core/doc/topology-delta';
import type { PlayerPose } from '../../core/session/player-pose';
import type { JukeboxState } from '../../core/session/jukebox';
import type { RideEvent, SharedRideEvent } from '../../core/session/ride-event';
import type { ClientProject } from '../state/project-sync';
import type { SharedScreenFrame, SharedScreenState } from '../../core/session/screen-share';
import { CORE_VERSION, DOCUMENT_VERSION } from '../../core/session/protocol';
import { referenceRoom } from '../../core/session/public-courses';
import { createPlayChannel } from './play-channel';
import type { PlayConfig, PlayPeer, PlayChatLine } from '../../core/session/play-protocol.generated';

export { CORE_VERSION, DOCUMENT_VERSION } from '../../core/session/protocol';

/** A suspended/background tab must not replay an old one-shot into a later run when it wakes. */
const MAX_RIDE_EVENT_AGE_MS = 10_000;

/**
 * The browser's end of the session channel (docs/038, docs/039): one long-lived socket per tab, carrying
 * presence, awareness, register changes, topology claims and the room.
 *
 * It authenticates with nothing at all — the same httpOnly session cookie an ordinary fetch sends goes up
 * with the upgrade, so there is no token in a URL and no second sign-in. On a server with no accounts the
 * upgrade resolves to the owner, presence shows one member, this tab may write, and this module asks the
 * author nothing.
 *
 * Everything that travels is register-shaped and absolute: "these registers now hold these values", never "I
 * performed this operation". This module is the transport for that and holds none of the policy — the
 * coalescing, the undo journal, the drift check and what to do with changes held across a disconnection all
 * live in `register-sync.ts`, which is where they can be exercised without a socket.
 *
 * Browser activity tracking is guarded behind the existence of `window`/`document`, so the same client still
 * runs under a headless test harness against a real service.
 */

export type MemberRole = 'admin' | 'moderator' | 'editor' | 'viewer';

export interface SessionMember {
  id: string;
  username: string;
  role: MemberRole;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
}

/** One tab of one member, on one map. Presence is keyed by session and displayed by user, because a person
 *  with two tabs open is one member in the list and two entries in this table. */
export interface PresenceEntry {
  userId: string;
  sessionId: string;
  clientId: string;
  deviceLabel: string;
  username: string;
  role: MemberRole;
  snowboardTextureUrl?: string;
  skiTextureUrl?: string;
  equipmentEdgeColor?: string;
  /** This participant's colour, everywhere they appear — derived from their user id by the server, so every
   *  client picks the same one for the same person. */
  color: string;
  /** The extracted mountain loaded in this tab's read-only Reference slot, when there is one. */
  referenceLevel?: string;
  /** Which world this tab is actively playing. */
  playing?: 'authored' | 'reference';
  /** This exact browser tab is offering a live view stream. */
  screenSharing?: boolean;
  /** Exact shared-screen session this tab actively follows. */
  screenWatchingSessionId?: string;
  lastSeen: number;
}

/** What one participant is doing right now, named the way the document names its geometry. */
export interface Awareness {
  /** Legacy room-wide slot, kept null. Shared-screen frames privately carry a sharer's cursor. */
  cursor: [number, number, number] | null;
  /** The corners they have picked or are writing to. */
  vertices: string[];
  /** The faces they have picked or are painting. */
  quads: string[];
  /** The geometry they are holding at this moment — whatever they have written that the room has not
   *  acknowledged yet, corners and faces alike — drawn softer than a selection. */
  dragging: string[];
  /** Their camera/rider in world space. Disposable like a cursor; null only before the first pose. */
  player: PlayerPose | null;
  at: number;
}

/** A peer's awareness as it arrives: who, in what colour, doing what. */
export interface PeerAwareness {
  projectId: string;
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

/** The disposable-state cadence selected for this room by its current participant count. */
export interface RoomPolicy {
  projectId: string;
  awarenessMs: number;
}

export interface LibraryChange {
  scope: 'custom' | 'shared';
}

export interface SessionWelcome {
  play?: PlayConfig;
  sessionId: string;
  clientId: string;
  accounts: 'open' | 'required';
  member: SessionMember;
  projectId: string | null;
  color: string;
  /** Wall clock at serialization, used as the first server-clock estimate before the first ping round trip. */
  serverTime: number;
  /** What this server evaluates documents with. A build that disagrees follows read-only rather than writing
   *  geometry the rest of the room would evaluate differently (docs/039). */
  versions: { doc: number; core: string };
}

/** A member as a chat line names them. */
export interface ChatWho {
  userId: string;
  username: string;
  role: MemberRole;
}

/**
 * One line of the server-wide room.
 *
 * `room` is what everybody said, `private` is a `/msg` between two members, and `system` is the server's own —
 * who joined, who restored a checkpoint, who made a map. They share one stream because they answer the same
 * question. `text` arrives escaped, which is why it is drawn as characters rather than as markup.
 */
export interface ChatLine {
  id: number;
  at: number;
  kind: 'room' | 'private' | 'system';
  text: string;
  from?: ChatWho;
  to?: ChatWho;
}

/** One register assignment on the wire: a key and the absolute value it now holds. */
export type RegisterAssignment = [string, unknown];

/** Where the room is on this map, and whether this tab may change it. */
export interface JoinedView {
  projectId: string;
  at: number;
  /** The room `at` is counted in. A room counts from 0 each time it opens (docs/039). */
  room?: string;
  writable: boolean;
  /** Set when it may not: a viewer, or an install that would evaluate this mountain differently. */
  reason?: string;
}

export type ChannelStatus = 'connecting' | 'open' | 'closed';

/** One change the room sequenced, as a catch-up or a lost claim replays it (docs/039). */
export interface SyncStep {
  changes: RegisterAssignment[];
  delta?: TopologyDelta;
}

/** How this tab's topology claim turned out. */
export interface ClaimAnswer {
  batch: number;
  ok: boolean;
  at: number;
  /** Keys of the claim's registers the room did not take. */
  refused?: string[];
  /** A loss the log can describe: everything sequenced since the claim's base. */
  steps?: SyncStep[];
  /** A loss it cannot: the room's whole document. */
  document?: EditDoc;
}

/** Somebody else's accepted topology. A server on an older core sends the document instead of a delta. */
export interface TopologyPush {
  projectId: string;
  at: number;
  delta?: TopologyDelta;
  changes?: RegisterAssignment[];
  document?: EditDoc;
  by: string;
}

/** What a reconnecting tab missed. A server on an older core sends flat `changes` rather than `steps`. */
export interface CaughtUp {
  projectId: string;
  at: number;
  /** The room `at` is counted in — another than the one the rejoin named, when that is why `document` came. */
  room?: string;
  steps?: SyncStep[];
  changes?: RegisterAssignment[];
  document?: EditDoc;
  /** The highest of this replica's batches the room had answered before it rejoined. */
  landed?: number;
}

interface ServerMessage {
  t: string;
  [key: string]: unknown;
}

/** A keep-alive, so a tab that is watching rather than editing does not lapse out of presence. Comfortably
 *  inside the server's 90-second presence TTL, so two missed beats still leave it here. */
const PING_MS = 25_000;
/** No human input for this long makes this tab idle. Only transitions cross the wire. */
export const MEMBER_IDLE_AFTER_MS = 5 * 60_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
/** Private server close code: this account is valid, but its tab does not currently hold a player seat. */
const CAPACITY_CLOSE_CODE = 4003;

export function createSessionChannel(deps: {
  /** Public riding omits editor-only subscriptions from its handshake. */
  publicPlay?: boolean;
  /** This tab's id — the same one every project request carries, so the server can tell a tab's own writes
   *  from somebody else's. */
  clientId: string;
  /** A browser-local name that distinguishes this participant from the same account on another device. */
  deviceLabel?: string;
  /** Whose batch numbers `assign` carries — the register sync's `replica`. The room remembers how far it got
   *  with them, so a reconnection does not replay a batch whose acknowledgement died with the socket. */
  replica?: string;
  /** Where the channel connects. Defaults to this page's own origin. */
  url?: () => string;
  onWelcome?: (welcome: SessionWelcome) => void;
  onPresence?: (maps: Record<string, PresenceEntry[]>) => void;
  /** The room on this map is open, and this is where it is. */
  onJoined?: (view: JoinedView) => void;
  /** Somebody else's registers, absolute. */
  onSync?: (push: { projectId: string; at: number; changes: RegisterAssignment[]; by: string }) => void;
  /** How a batch of this tab's own assignments turned out. */
  onLanded?: (ack: { batch: number; at: number; retired: string[]; refused: string[] }) => void;
  /** How a topology claim turned out. A loss carries what was sequenced since its base, or the document. */
  onClaim?: (result: ClaimAnswer) => void;
  /** Somebody else's accepted topology: the delta and the registers that came with it. */
  onTopology?: (push: TopologyPush) => void;
  /** The room's digest, answering a drift check. */
  onDigest?: (answer: { projectId: string; at: number; root: string; sections: Record<string, string> }) => void;
  /** The repair for the sections that diverged. */
  onSections?: (repair: { projectId: string; at: number; registers: RegisterAssignment[]; document?: EditDoc }) => void;
  /** What this tab missed while it was away — steps to replay, or the document — and the highest of its batches
   *  the room had answered. */
  onCaughtUp?: (missed: CaughtUp) => void;
  /** A peer's live selection, drag, and player pose. */
  onAware?: (peer: PeerAwareness) => void;
  /** A subscribed sharer's latest camera and display state. */
  onScreenState?: (frame: SharedScreenFrame) => void;
  /** The target withdrew sharing or disconnected. */
  onScreenObserveEnded?: (targetSessionId: string) => void;
  /** How many non-paused observers are consuming this tab's shared view. */
  onScreenWatchers?: (count: number) => void;
  /** Retune how often this tab publishes awareness as the room grows or shrinks. */
  onRoomPolicy?: (policy: RoomPolicy) => void;
  /** A server-side asset catalogue changed and should be refetched. */
  onLibraryChanged?: (change: LibraryChange) => void;
  /** Somebody changed their account picture; an open server roster should be re-read. */
  onProfileChanged?: (userId: string) => void;
  /** A connected tab crossed the automatic idle boundary. */
  onStatusChanged?: (userId: string) => void;
  /** A whole document that arrived outside the room — an import, a checkpoint restore, a script. */
  onRevision?: (push: { projectId: string; project: ClientProject; document: EditDoc }) => void;
  /** Ownership/edit policy changed without replacing the document. */
  onProjectAccess?: (change: {
    projectId: string;
    project: ClientProject;
    writable: boolean;
    reason?: string;
    document?: EditDoc;
  }) => void;
  /** The map this tab was on has been deleted on the server, so there is nothing left to watch or write to. */
  onGone?: (map: { projectId: string; name: string }) => void;
  /** One line of the room, as it happens. */
  onChat?: (line: ChatLine) => void;
  /** What this member missed, replayed once per connection — so the box opens on a conversation. */
  onChatHistory?: (lines: ChatLine[]) => void;
  /** The server-wide queue and authoritative playhead. */
  onJukebox?: (state: JukeboxState) => void;
  /** A queue or transport action this member attempted was refused. */
  onJukeboxError?: (message: string) => void;
  /** Another participant's live-only interaction on the project Play world. */
  onRideEvent?: (event: SharedRideEvent) => void;
  onStatus?: (status: ChannelStatus) => void;
  /** The login ended or its role changed while this socket was open. */
  onAccessChanged?: (reason: string) => void;
  /** The server is full, or this viewer was displaced so an operational role could connect. */
  onCapacityRefused?: (reason: string) => void;
}) {
  let socket: WebSocket | null = null;
  let welcome: SessionWelcome | null = null;
  /** `undefined` until the editor has said which map it has open, which is different from having said "none":
   *  before it does, the map the server seeded this session from stands. */
  let watching: string | null | undefined;
  /** Where this tab is in the room's sequence, so a reconnection says what it last saw rather than starting
   *  over. One number: there is no per-participant clock anywhere in this design (docs/039). */
  let at = 0;
  /** The room `at` was counted in, said with it: rooms count from 0 each time they open, so the room this tab
   *  rejoins may not be the one it left. Undefined until a room or a served map has said. */
  let room: string | undefined;
  /**
   * Relays held back while a rejoin waits for its catch-up, or null when none is pending.
   *
   * Between a `watch` that names a sequence and the `caught-up` that answers it, the room may relay changes the
   * catch-up then repeats — and that it sequenced after steps the catch-up has not delivered yet. Applying
   * them as they arrive would put a change ahead of what came before it, and a repeated topology delta does not
   * apply cleanly, so they wait. The catch-up covers them; a failed join, answered with `error`, releases them
   * in order instead.
   */
  let catchingUp: ServerMessage[] | null = null;
  let writable = true;
  let closedByUs = false;
  let wanted = false;
  let backoff = RECONNECT_MIN_MS;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let presenceMaps: Record<string, PresenceEntry[]> = {};
  /** Kept across reconnects so the replacement socket can restore this tab's Reference presence. */
  let referenceLevel: string | null = null;
  /** Kept across reconnects for the green Play marker in Users. */
  let playing: 'authored' | 'reference' | null = null;
  /** Both survive reconnect: sharing resumes, while observing deliberately asks the replacement socket again. */
  let screenSharing = false;
  let observedSessionId: string | null = null;
  let screenObservationActive = false;
  let lastScreenState = '';
  let serverOffsetMs = 0;
  let clockReady = false;
  /** The server already suppresses repeated ids; retain the same boundary here so a duplicated frame can never
   * restart a one-shot after reconnect/backpressure changes in a future transport implementation. */
  const lastRideEventBySession = new Map<string, number>();
  /** Prevent one toast per retry while a full server keeps this tab waiting. Reset by the next welcome. */
  let capacityNoticeShown = false;
  let idle = false;
  let lastActivity = Date.now();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let trackingActivity = false;
  let relayConfig: PlayConfig | null = null;
  let friendRoomOverride: string | null = null;
  let publicStarting = false;
  let startGeneration = 0;
  let relayPresence: Record<string, PresenceEntry[]> = {};
  const editorAwareness = new Map<string, PeerAwareness>();
  const relayAwareness = new Map<string, PeerAwareness>();
  let lastEditorAwareness = '';

  const url =
    deps.url ??
    ((): string => {
      const secure = location.protocol === 'https:';
      return (
        `${secure ? 'wss' : 'ws'}://${location.host}/api/session` +
        `?client=${encodeURIComponent(deps.clientId)}` +
        `&device=${encodeURIComponent(deps.deviceLabel ?? 'device')}`
      );
    });
  /** Where the socket connects. The replica is added to whichever address is used, so a caller that supplies its
   *  own still says whose batches it carries. */
  const address = (): string => {
    const base = url();
    if (!deps.replica) return base;
    return `${base}${base.includes('?') ? '&' : '?'}replica=${encodeURIComponent(deps.replica)}`;
  };

  const baseUrl = () => {
    const parsed = new URL(url());
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
    return parsed.origin;
  };
  function reportPresence() {
    if (!relayConfig?.enabled) {
      deps.onPresence?.(presenceMaps);
      return;
    }
    const relayed = new Set(
      Object.values(relayPresence)
        .flat()
        .map(peer => peer.sessionId),
    );
    const combined: Record<string, PresenceEntry[]> = {};
    for (const [key, rows] of Object.entries(presenceMaps))
      combined[key] = rows.filter(row => !relayed.has(row.sessionId));
    for (const [key, rows] of Object.entries(relayPresence)) (combined[key] ??= []).push(...rows);
    const present = new Set(
      Object.values(combined)
        .flat()
        .map(row => row.sessionId),
    );
    for (const id of editorAwareness.keys()) if (!present.has(id)) editorAwareness.delete(id);
    deps.onPresence?.(combined);
  }
  const emptyAware = (): Awareness => ({
    cursor: null,
    vertices: [],
    quads: [],
    dragging: [],
    player: null,
    at: Date.now(),
  });
  const peerFields = (peer: PlayPeer) => ({
    sessionId: peer.sessionId,
    userId: peer.member.id,
    username: peer.member.username,
    deviceLabel: peer.deviceLabel,
    color: peer.color,
    ...(peer.member.snowboardTextureUrl ? { snowboardTextureUrl: peer.member.snowboardTextureUrl } : {}),
    ...(peer.member.skiTextureUrl ? { skiTextureUrl: peer.member.skiTextureUrl } : {}),
    ...(peer.member.equipmentEdgeColor ? { equipmentEdgeColor: peer.member.equipmentEdgeColor } : {}),
  });
  const chatLine = (line: PlayChatLine): ChatLine => ({
    id: line.id,
    at: line.at,
    kind: 'room',
    text: line.text,
    from: { userId: line.member.id, username: line.member.username, role: line.member.role },
  });
  const play = createPlayChannel({
    clientId: deps.clientId,
    deviceLabel: deps.deviceLabel ?? 'device',
    publicPlay: !!deps.publicPlay,
    baseUrl,
    onStatus(status) {
      if (status === 'closed') {
        relayPresence = {};
        for (const [id, peer] of relayAwareness)
          deps.onAware?.({ ...peer, aware: editorAwareness.get(id)?.aware ?? emptyAware() });
        relayAwareness.clear();
        reportPresence();
      }
      if (deps.publicPlay) deps.onStatus?.(status);
    },
    onAccessChanged: reason => {
      if (deps.publicPlay) deps.onAccessChanged?.(reason);
    },
    onCapacityRefused: reason => deps.onCapacityRefused?.(reason),
    onMessage(message) {
      switch (message.t) {
        case 'welcome':
          if (deps.publicPlay)
            handle({
              t: 'welcome',
              sessionId: message.sessionId,
              clientId: deps.clientId,
              member: message.member,
              color: message.color,
              serverTime: message.serverTime,
              projectId: message.courseId,
              accounts: 'open',
              versions: { doc: DOCUMENT_VERSION, core: CORE_VERSION },
            });
          deps.onRoomPolicy?.({ projectId: message.courseId, awarenessMs: message.publishMs });
          break;
        case 'presence': {
          const reference = message.courseId.startsWith('@reference:') ? message.courseId.slice(11) : null;
          relayPresence = {
            [message.courseId]: message.peers.map(peer => ({
              ...peerFields(peer),
              clientId: peer.clientId,
              role: peer.member.role,
              lastSeen: Date.now(),
              playing: reference ? 'reference' : 'authored',
              ...(reference ? { referenceLevel: reference } : {}),
            })),
          };
          const present = new Set(message.peers.map(peer => peer.sessionId));
          for (const id of relayAwareness.keys()) if (!present.has(id)) relayAwareness.delete(id);
          reportPresence();
          break;
        }
        case 'poses': {
          const posed = new Set(message.peers.map(peer => peer.sessionId));
          for (const [id, peer] of relayAwareness) {
            if (posed.has(id)) continue;
            deps.onAware?.({ ...peer, aware: editorAwareness.get(id)?.aware ?? emptyAware() });
            relayAwareness.delete(id);
          }
          for (const entry of message.peers) {
            if (entry.sessionId === welcome?.sessionId) continue;
            const peer = play.peer(entry.sessionId);
            if (!peer) continue;
            const editing = editorAwareness.get(entry.sessionId);
            const awareness = editing?.projectId === message.courseId ? editing.aware : emptyAware();
            const merged: PeerAwareness = {
              ...peerFields(peer),
              projectId: message.courseId,
              aware: { ...awareness, player: entry.player, at: Date.now() },
            };
            relayAwareness.set(entry.sessionId, merged);
            deps.onAware?.(merged);
          }
          break;
        }
        case 'ride-event':
          deps.onRideEvent?.({
            ...message.event,
            projectId: message.courseId,
            fromSessionId: message.fromSessionId,
            serverAt: message.serverAt,
          });
          break;
        case 'chat':
          if (deps.publicPlay) deps.onChat?.(chatLine(message.line));
          break;
        case 'chat-history':
          if (deps.publicPlay) deps.onChatHistory?.(message.lines.map(chatLine));
          break;
        case 'error':
          console.warn('[play]', message.message);
          break;
      }
    },
  });
  function syncPlayRoom() {
    if (!relayConfig?.enabled) return;
    const target =
      playing === 'reference' && referenceLevel
        ? referenceRoom(referenceLevel)
        : watching === undefined
          ? (welcome?.projectId ?? null)
          : watching;
    const requested = typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('room');
    const friendRoom =
      friendRoomOverride ?? (requested && /^[a-zA-Z0-9_-]{1,64}$/.test(requested) ? requested : 'lodge');
    play.watch(target, friendRoom, deps.publicPlay ? undefined : welcome?.sessionId);
    if (wanted) play.start(relayConfig);
  }

  const post = (message: unknown): boolean => {
    if (relayConfig?.enabled) {
      const command = message as { t: string; aware?: Partial<Awareness>; text?: string };
      if (command.t === 'ride-event') {
        const { t: _tag, ...event } = message as { t: string } & SharedRideEvent;
        return play.send({ t: 'ride-event', event });
      }
      if (command.t === 'aware') {
        const poseSent = command.aware?.player === undefined ? true : play.pose(command.aware.player);
        if (deps.publicPlay) return poseSent;
        const aware = { ...command.aware, player: null };
        const encoded = JSON.stringify(aware);
        if (encoded === lastEditorAwareness) return poseSent;
        if (socket?.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify({ t: 'aware', aware }));
        lastEditorAwareness = encoded;
        return poseSent;
      }
      if (deps.publicPlay) {
        if (command.t === 'chat') return play.send({ t: 'chat', text: command.text ?? '' });
        if (command.t === 'watch' || command.t === 'reference' || command.t === 'playing') syncPlayRoom();
        return true;
      }
    }
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  /**
   * Track human input locally and send only active/idle edges. Transport pings cannot stand in for this: they
   * continue while a browser is untouched, because their job is to keep its connection alive.
   */
  const checkIdle = (): void => {
    idleTimer = null;
    const remaining = MEMBER_IDLE_AFTER_MS - (Date.now() - lastActivity);
    if (remaining > 0) {
      idleTimer = setTimeout(checkIdle, remaining);
      return;
    }
    if (!idle) {
      idle = true;
      post({ t: 'idle', idle: true });
    }
  };
  const armIdleTimer = (): void => {
    if (!idleTimer) idleTimer = setTimeout(checkIdle, MEMBER_IDLE_AFTER_MS);
  };
  const noteActivity = (): void => {
    lastActivity = Date.now();
    if (idle) {
      idle = false;
      post({ t: 'idle', idle: false });
    }
    armIdleTimer();
  };
  const activity = (): void => noteActivity();
  const visibilityActivity = (): void => {
    if (!document.hidden) noteActivity();
  };
  const startActivityTracking = (): void => {
    if (trackingActivity || typeof window === 'undefined' || typeof document === 'undefined') return;
    trackingActivity = true;
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(event, activity, { passive: true });
    }
    window.addEventListener('focus', activity);
    document.addEventListener('visibilitychange', visibilityActivity);
    noteActivity();
  };
  const stopActivityTracking = (): void => {
    if (!trackingActivity || typeof window === 'undefined' || typeof document === 'undefined') return;
    trackingActivity = false;
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
      window.removeEventListener(event, activity);
    }
    window.removeEventListener('focus', activity);
    document.removeEventListener('visibilitychange', visibilityActivity);
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  function handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome': {
        welcome = message as unknown as SessionWelcome;
        lastEditorAwareness = '';
        if (welcome.play?.enabled) {
          relayConfig = welcome.play;
          syncPlayRoom();
        }
        lastRideEventBySession.clear();
        capacityNoticeShown = false;
        if (Number.isFinite(welcome.serverTime)) {
          serverOffsetMs = welcome.serverTime - Date.now();
          clockReady = true;
        }
        backoff = RECONNECT_MIN_MS;
        // The server seeded this session from the map this tab was last on; tell it what the editor actually
        // has open, and where this replica left off, which is the authority once the editor is running.
        if (watching !== undefined) rewatch();
        post({ t: 'reference', level: referenceLevel });
        post({ t: 'playing', playing });
        post({ t: 'idle', idle });
        if (!deps.publicPlay) post({ t: 'screen-share', enabled: screenSharing });
        if (observedSessionId)
          post({
            t: 'screen-observe',
            sessionId: observedSessionId,
            active: screenObservationActive,
          });
        lastScreenState = '';
        deps.onWelcome?.(welcome);
        return;
      }
      case 'pong': {
        const echo = Number(message.echo),
          serverTime = Number(message.serverTime),
          received = Date.now();
        if (Number.isFinite(echo) && Number.isFinite(serverTime) && echo <= received) {
          // NTP's midpoint estimate: symmetric delay is the best information a browser socket can provide. Ease
          // later samples so a route change corrects clock drift without moving every remote player in one cut.
          const estimate = serverTime - (echo + received) / 2;
          serverOffsetMs = clockReady ? serverOffsetMs + (estimate - serverOffsetMs) * 0.2 : estimate;
          clockReady = true;
        }
        return;
      }
      case 'presence':
        presenceMaps = (message.maps ?? {}) as Record<string, PresenceEntry[]>;
        reportPresence();
        return;
      case 'presence-delta': {
        const change = message.change as
          | {
              sessionId?: string;
              to?: { projectId?: string; entry?: PresenceEntry } | null;
            }
          | undefined;
        const sessionId = change?.sessionId;
        if (!sessionId) return;
        // A delta is absolute for this session. Remove it wherever an older delivery left it, then place the
        // newest entry. This also makes backpressure coalescing safe across several rapid map moves.
        const next: Record<string, PresenceEntry[]> = {};
        for (const [projectId, entries] of Object.entries(presenceMaps)) {
          const kept = entries.filter(entry => entry.sessionId !== sessionId);
          if (kept.length) next[projectId] = kept;
        }
        const projectId = change.to?.projectId;
        const entry = change.to?.entry;
        if (projectId && entry) (next[projectId] ??= []).push(entry);
        presenceMaps = next;
        reportPresence();
        return;
      }
      case 'joined': {
        const view = message as unknown as JoinedView;
        // A rejoin stays at the sequence it asked from until its catch-up lands: the replica does not hold what
        // lies between, and a claim or a reconnection measured from the room's head would skip it.
        if (view.projectId === watching) {
          if (!catchingUp) {
            at = view.at;
            room = view.room;
          }
          writable = view.writable;
        }
        deps.onJoined?.(view);
        return;
      }
      case 'sync': {
        const push = message as unknown as { projectId: string; at: number; changes: RegisterAssignment[]; by: string };
        // A relay for the map this tab just left belongs to a document it no longer holds.
        if (watching !== undefined && push.projectId !== watching) return;
        if (catchingUp) {
          catchingUp.push(message);
          return;
        }
        at = Math.max(at, push.at);
        deps.onSync?.(push);
        return;
      }
      case 'landed': {
        const ack = message as unknown as { batch: number; at: number; retired: string[]; refused: string[] };
        at = Math.max(at, ack.at);
        deps.onLanded?.(ack);
        return;
      }
      case 'claim': {
        const result = message as unknown as ClaimAnswer;
        at = Math.max(at, result.at);
        deps.onClaim?.(result);
        return;
      }
      case 'topology': {
        const push = message as unknown as TopologyPush;
        if (watching !== undefined && push.projectId !== watching) return;
        if (catchingUp) {
          catchingUp.push(message);
          return;
        }
        at = Math.max(at, push.at);
        deps.onTopology?.(push);
        return;
      }
      case 'digest':
        deps.onDigest?.(
          message as unknown as { projectId: string; at: number; root: string; sections: Record<string, string> },
        );
        return;
      case 'sections': {
        const repair = message as unknown as {
          projectId: string;
          at: number;
          registers: RegisterAssignment[];
          document?: EditDoc;
        };
        at = Math.max(at, repair.at);
        deps.onSections?.(repair);
        return;
      }
      case 'caught-up': {
        const missed = message as unknown as CaughtUp;
        const held = missed.projectId === watching ? catchingUp : null;
        if (held) catchingUp = null;
        if (missed.projectId === watching && missed.room !== undefined && missed.room !== room) {
          // Counted in another room than the one this tab named: the room it knew closed, or the server restarted,
          // or it read the map off the file. The count starts over from this room's, rather than carrying on from
          // a number this room may never reach.
          at = missed.at;
          room = missed.room;
        } else at = Math.max(at, missed.at);
        deps.onCaughtUp?.(missed);
        // Whatever was held back is covered by the catch-up unless the room sequenced it later.
        for (const relay of held ?? []) if (Number(relay.at) > missed.at) handle(relay);
        return;
      }
      case 'awareness-batch': {
        const projectId = typeof message.projectId === 'string' ? message.projectId : '';
        if (!projectId || !Array.isArray(message.peers)) return;
        for (const state of message.peers) {
          const peer = state as Omit<PeerAwareness, 'projectId'>;
          if (!peer || peer.sessionId === welcome?.sessionId) continue;
          const current = { ...peer, projectId };
          if (relayConfig?.enabled) {
            editorAwareness.set(peer.sessionId, current);
            const relayed = relayAwareness.get(peer.sessionId);
            deps.onAware?.({
              ...current,
              aware: { ...current.aware, player: relayed?.projectId === projectId ? relayed.aware.player : null },
            });
          } else deps.onAware?.(current);
        }
        return;
      }
      case 'screen-state': {
        const frame = message as unknown as SharedScreenFrame;
        if (frame.sessionId === observedSessionId) deps.onScreenState?.(frame);
        return;
      }
      case 'screen-observe-ended': {
        const targetSessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        if (targetSessionId && targetSessionId === observedSessionId) {
          observedSessionId = null;
          screenObservationActive = false;
          deps.onScreenObserveEnded?.(targetSessionId);
        }
        return;
      }
      case 'screen-watchers': {
        const count = Number(message.count);
        if (Number.isInteger(count) && count >= 0) deps.onScreenWatchers?.(count);
        return;
      }
      case 'room-policy': {
        const policy = message as unknown as RoomPolicy;
        const currentProject = watching === undefined ? welcome?.projectId : watching;
        if (policy.projectId === currentProject && Number.isFinite(policy.awarenessMs)) {
          deps.onRoomPolicy?.(policy);
        }
        return;
      }
      case 'library-changed': {
        if (message.scope === 'custom' || message.scope === 'shared') {
          deps.onLibraryChanged?.({ scope: message.scope });
        }
        return;
      }
      case 'profile-changed':
        if (typeof message.userId === 'string') deps.onProfileChanged?.(message.userId);
        return;
      case 'status-changed':
        if (typeof message.userId === 'string') deps.onStatusChanged?.(message.userId);
        return;
      case 'revision':
        deps.onRevision?.(message as unknown as { projectId: string; project: ClientProject; document: EditDoc });
        return;
      case 'project-access': {
        const change = message as unknown as {
          projectId: string;
          project: ClientProject;
          writable: boolean;
          reason?: string;
          document?: EditDoc;
        };
        if (change.projectId === watching) writable = change.writable;
        deps.onProjectAccess?.(change);
        return;
      }
      case 'gone': {
        const map = message as unknown as { projectId: string; name: string };
        // The server has already taken this tab off the map. Forgetting it here as well is what keeps a
        // reconnection from asking to rejoin one that is not there.
        if (map.projectId === watching) {
          watching = null;
          at = 0;
          room = undefined;
        }
        deps.onGone?.(map);
        return;
      }
      case 'chat-history':
        deps.onChatHistory?.((message.lines ?? []) as ChatLine[]);
        return;
      case 'chat':
        deps.onChat?.(message.line as ChatLine);
        return;
      case 'jukebox-state':
        deps.onJukebox?.(message.state as JukeboxState);
        return;
      case 'jukebox-error':
        deps.onJukeboxError?.(String(message.message ?? 'The jukebox action was refused.'));
        return;
      case 'ride-event': {
        const event = message as unknown as SharedRideEvent;
        const currentProject = watching === undefined ? welcome?.projectId : watching;
        const referenceEvent =
          playing === 'reference' && referenceLevel && event.projectId === referenceRoom(referenceLevel);
        if ((!currentProject || event.projectId !== currentProject) && !referenceEvent) return;
        if (typeof event.fromSessionId !== 'string' || !Number.isSafeInteger(event.id)) return;
        const previous = lastRideEventBySession.get(event.fromSessionId) ?? -1;
        if (event.id <= previous) return;
        lastRideEventBySession.set(event.fromSessionId, event.id);
        const serverNow = Date.now() + serverOffsetMs;
        if (
          !Number.isFinite(event.sentAt) ||
          event.sentAt < serverNow - MAX_RIDE_EVENT_AGE_MS ||
          event.sentAt > serverNow + 30_000
        )
          return;
        deps.onRideEvent?.(event);
        return;
      }
      case 'error': {
        console.warn('[session]', message.message);
        // A join that fails is answered with this instead of a catch-up: release what was held, in order.
        const held = catchingUp;
        catchingUp = null;
        for (const relay of held ?? []) handle(relay);
        return;
      }
      default:
        return;
    }
  }

  /** What this build evaluates documents with, sent on every join so a mismatched install is told to follow
   *  rather than discovering it by writing geometry nobody else agrees with. */
  const versions = () => ({ doc: DOCUMENT_VERSION, core: CORE_VERSION });

  /** Say the map again from where this replica is, and hold relays back until the room's catch-up answers. */
  function rewatch(): void {
    if (watching === undefined) return;
    catchingUp = post({ t: 'watch', projectId: watching, at, room, ...versions() }) ? [] : null;
  }

  function connect(): void {
    if (!wanted || socket) return;
    deps.onStatus?.('connecting');
    let opened: WebSocket;
    try {
      opened = new WebSocket(address());
    } catch {
      schedule();
      return;
    }
    socket = opened;
    opened.onopen = () => {
      deps.onStatus?.('open');
      if (beat) clearInterval(beat);
      const ping = () => {
        post({ t: 'ping', at: Date.now() });
      };
      ping();
      beat = setInterval(ping, PING_MS);
    };
    opened.onmessage = event => {
      try {
        handle(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        /* a message this client does not speak is not a reason to drop the channel */
      }
    };
    opened.onclose = event => {
      if (socket !== opened) return;
      socket = null;
      welcome = null;
      lastEditorAwareness = '';
      if (relayConfig?.enabled) play.close();
      catchingUp = null;
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      deps.onStatus?.('closed');
      if (event.code === 4001 || event.code === 4002) {
        wanted = false;
        deps.onAccessChanged?.(
          event.reason || (event.code === 4002 ? 'Your access changed.' : 'This login session ended.'),
        );
        return;
      }
      if (event.code === CAPACITY_CLOSE_CODE) {
        if (!capacityNoticeShown) {
          capacityNoticeShown = true;
          deps.onCapacityRefused?.(event.reason || 'This Slopesmith is full; waiting for a player slot.');
        }
        if (!closedByUs) schedule();
        return;
      }
      if (!closedByUs) schedule();
    };
    opened.onerror = () => {
      /* onclose follows, and that is where reconnection is decided */
    };
  }

  function schedule(): void {
    if (!wanted) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      socket = null;
      connect();
    }, backoff);
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
  }

  function startPublic(): void {
    if (publicStarting) return;
    publicStarting = true;
    const version = ++startGeneration;
    void fetch(new URL('/api/play/config', baseUrl()), { signal: AbortSignal.timeout(5000) })
      .then(async response => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error('Play configuration is unavailable.');
        return (await response.json()) as PlayConfig;
      })
      .catch(() => undefined)
      .then(config => {
        if (!wanted || version !== startGeneration) return;
        if (config === undefined) {
          publicStarting = false;
          reconnectTimer = setTimeout(startPublic, backoff);
          backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
        } else if (config?.enabled) {
          relayConfig = config;
          syncPlayRoom();
        } else connect();
      });
  }

  return {
    /** Open the channel. Safe to call twice. */
    start(): void {
      wanted = true;
      closedByUs = false;
      startActivityTracking();
      if (deps.publicPlay) {
        startPublic();
        return;
      }
      connect();
    },
    /** Which map this tab is on. Presence is keyed by it, and so is everything the room relays. `from` is the
     *  room sequence the replica's document stands at, when it is known — 0 included, which is a room's start —
     *  so the room hands back whatever it sequenced after that document rather than joining it at the head.
     *  `counted` is the room that sequence belongs to, as the map was served with it. */
    watch(projectId: string | null, from?: number, counted?: string): void {
      if (watching === projectId) return;
      watching = projectId;
      lastEditorAwareness = '';
      syncPlayRoom();
      at = from ?? 0;
      room = from === undefined ? undefined : counted;
      lastScreenState = '';
      if (from !== undefined) rewatch();
      else {
        catchingUp = null;
        post({ t: 'watch', projectId, ...versions() });
      }
    },
    /** Say the same map again, from where this replica actually is — what a reconnection sends so the room
     *  hands back exactly what was missed. */
    rejoin(): void {
      rewatch();
    },
    /** Publish the extracted mountain in this tab's read-only Reference slot. Retained for reconnects. */
    reference(level: string | null): boolean {
      referenceLevel = level?.trim() || null;
      syncPlayRoom();
      lastScreenState = '';
      return post({ t: 'reference', level: referenceLevel });
    },
    /** Publish which world this tab is actively playing. Retained for reconnects. */
    setPlaying(target: 'authored' | 'reference' | null): boolean {
      playing = target;
      syncPlayRoom();
      return post({ t: 'playing', playing });
    },
    /** Friend rooms are independent play sessions on the same course; editing remains on its original room. */
    setPlayRoom(id: string): boolean {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return false;
      friendRoomOverride = id;
      syncPlayRoom();
      return true;
    },
    /** Offer or withdraw this tab's live view. The server exposes the flag through presence. */
    setScreenSharing(enabled: boolean): boolean {
      screenSharing = enabled;
      lastScreenState = '';
      return post({ t: 'screen-share', enabled });
    },
    screenSharing: (): boolean => screenSharing,
    /** Publish only changed view frames; project and reference identity come from the authenticated session. */
    shareScreen(state: SharedScreenState): boolean {
      if (!screenSharing) return false;
      const text = JSON.stringify(state);
      if (text === lastScreenState) return true;
      if (!post({ t: 'screen-state', state })) return false;
      lastScreenState = text;
      return true;
    },
    /** Subscribe to one exact sharing tab, or null to stop. Inactive retains end notifications without frames. */
    observeScreen(sessionId: string | null, active = true): boolean {
      observedSessionId = sessionId?.trim() || null;
      screenObservationActive = !!observedSessionId && active;
      return post({ t: 'screen-observe', sessionId: observedSessionId, active: screenObservationActive });
    },
    /** These registers now hold these values. Returns false when the socket is not up, which is the caller's
     *  cue to hold the change rather than lose it. */
    assign(changes: RegisterAssignment[], batch: number): boolean {
      // A register holding NOTHING travels as the key alone: JSON cannot carry `undefined` inside an array,
      // and `["q/1/tex", null]` is a different assignment from "this face is unpainted".
      return post({
        t: 'assign',
        batch,
        changes: changes.map(([key, value]) => (value === undefined ? [key] : [key, value])),
      });
    },
    /** A topology edit, compare-and-swapping the ids it consumes against where this replica last was: the
     *  delta it made, and the registers that came with it. */
    claim(ids: string[], delta: TopologyDelta, changes: RegisterAssignment[], batch: number): boolean {
      return post({
        t: 'claim',
        ids,
        at,
        delta,
        batch,
        changes: changes.map(([key, value]) => (value === undefined ? [key] : [key, value])),
      });
    },
    /** Ask the room what it hashes to. */
    checkDrift(digest: { root: string; sections: Record<string, string> }): boolean {
      return post({ t: 'digest', ...digest });
    },
    /** Refetch exactly the sections that diverged. */
    fetchSections(sections: string[]): boolean {
      return post({ t: 'fetch', sections });
    },
    /** What this tab is selecting and dragging, plus its player pose. */
    aware(aware: Partial<Awareness>): boolean {
      return post({ t: 'aware', aware });
    },
    /** Relay an interaction only after it has already run locally. A closed socket simply means this disposable
     * cue is lost; unlike document edits it must never be queued and replayed into a later Play run. */
    rideEvent(event: RideEvent): boolean {
      return post({ t: 'ride-event', ...event, sentAt: Date.now() + serverOffsetMs });
    },
    /** Current session-server time, continuously refined by socket round trips. */
    serverNow(): number {
      return relayConfig?.enabled ? play.serverNow() : Date.now() + serverOffsetMs;
    },
    /** Say something in the room. Slash commands travel as typed: the server owns what `/msg` and `/r` mean,
     *  so a private line is relayed rather than assembled by whichever client happened to send it. */
    say(text: string): void {
      post({ t: 'chat', text });
    },
    /** Add one public source identity. Every browser resolves it through its own local bridge. */
    addJukeboxVideo(url: string): boolean {
      return post({ t: 'jukebox-add', url });
    },
    removeJukeboxVideo(id: string): boolean {
      return post({ t: 'jukebox-remove', id });
    },
    skipJukeboxVideo(id: string): boolean {
      return post({ t: 'jukebox-skip', id });
    },
    seekJukeboxVideo(id: string, position: number): boolean {
      return post({ t: 'jukebox-seek', id, position });
    },
    setJukeboxVideoPlaying(id: string, playing: boolean): boolean {
      return post({ t: 'jukebox-playing', id, playing });
    },
    jukeboxVideoEnded(id: string, mediaVersion: number): boolean {
      return post({ t: 'jukebox-ended', id, mediaVersion });
    },
    close(): void {
      wanted = false;
      startGeneration++;
      publicStarting = false;
      play.close();
      closedByUs = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (beat) {
        clearInterval(beat);
        beat = null;
      }
      stopActivityTracking();
      socket?.close();
      socket = null;
    },
    isOpen: (): boolean =>
      deps.publicPlay && relayConfig?.enabled ? play.isOpen() : socket?.readyState === WebSocket.OPEN,
    usesPlayRelay: (): boolean => !!relayConfig?.enabled,
    /** Whether this member may change a map at all. Moderators retain editor access; viewers follow read-only. */
    mayWrite: (): boolean =>
      writable &&
      (welcome?.member.role === 'editor' || welcome?.member.role === 'moderator' || welcome?.member.role === 'admin'),
    /** Every author may start a map of their own; the server records them as its owner. */
    mayCreateMountains: (): boolean =>
      welcome?.member.role === 'editor' || welcome?.member.role === 'moderator' || welcome?.member.role === 'admin',
    /** Ownership grants map management; moderators/admins retain an operational override. */
    mayManageMountain: (project?: ClientProject | null): boolean =>
      !!project &&
      !!welcome &&
      (project.ownerId === welcome.member.id || welcome.member.role === 'moderator' || welcome.member.role === 'admin'),
    mayDeleteMountains: (project?: ClientProject | null): boolean =>
      !!project &&
      !!welcome &&
      (project.ownerId === welcome.member.id || welcome.member.role === 'moderator' || welcome.member.role === 'admin'),
    member: (): SessionMember | null => welcome?.member ?? null,
    /** This participant's own colour, the one everybody else draws them in. */
    color: (): string => welcome?.color ?? '#f2a33c',
    sessionId: (): string | null => welcome?.sessionId ?? null,
  };
}

export type SessionChannel = ReturnType<typeof createSessionChannel>;

/** Presence as a member list rather than a session list: one row per person, with however many tabs they
 *  have open. Keyed by session and displayed by user is the whole rule, and this is the second half of it. */
export function membersOn(entries: readonly PresenceEntry[]): Array<{
  userId: string;
  username: string;
  role: MemberRole;
  color: string;
  sessions: number;
  lastSeen: number;
}> {
  const byUser = new Map<
    string,
    { userId: string; username: string; role: MemberRole; color: string; sessions: number; lastSeen: number }
  >();
  for (const entry of entries) {
    const found = byUser.get(entry.userId);
    if (found) {
      found.sessions++;
      found.lastSeen = Math.max(found.lastSeen, entry.lastSeen);
    } else {
      byUser.set(entry.userId, {
        userId: entry.userId,
        username: entry.username,
        role: entry.role,
        color: entry.color,
        sessions: 1,
        lastSeen: entry.lastSeen,
      });
    }
  }
  return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username));
}
