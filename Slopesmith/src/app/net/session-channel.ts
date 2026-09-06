import type { EditDoc } from '../../core/doc/doc-edit';
import type { PlayerPose } from '../../core/session/player-pose';
import type { JukeboxState } from '../../core/session/jukebox';
import type { RideEvent, SharedRideEvent } from '../../core/session/ride-event';
import type { ClientProject } from '../state/project-sync';
import type { SharedScreenFrame, SharedScreenState } from '../../core/session/screen-share';

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

export interface LibraryChange { scope: 'custom' | 'shared' }

export interface SessionWelcome {
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
  writable: boolean;
  /** Set when it may not: a viewer, or an install that would evaluate this mountain differently. */
  reason?: string;
}

export type ChannelStatus = 'connecting' | 'open' | 'closed';

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
  /** This tab's id — the same one every project request carries, so the server can tell a tab's own writes
   *  from somebody else's. */
  clientId: string;
  /** A browser-local name that distinguishes this participant from the same account on another device. */
  deviceLabel?: string;
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
  /** How a topology claim turned out. A loss carries the document that won. */
  onClaim?: (result: { batch: number; ok: boolean; at: number; document?: EditDoc }) => void;
  /** Somebody else's accepted topology, whole. */
  onTopology?: (push: { projectId: string; at: number; document: EditDoc; by: string }) => void;
  /** The room's digest, answering a drift check. */
  onDigest?: (answer: { projectId: string; at: number; root: string; sections: Record<string, string> }) => void;
  /** The repair for the sections that diverged. */
  onSections?: (repair: { projectId: string; at: number; registers: RegisterAssignment[]; document?: EditDoc }) => void;
  /** What this tab missed while it was away. */
  onCaughtUp?: (missed: { projectId: string; at: number; changes: RegisterAssignment[]; document?: EditDoc }) => void;
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
    projectId: string; project: ClientProject; writable: boolean; reason?: string; document?: EditDoc;
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

  const url = deps.url ?? ((): string => {
    const secure = location.protocol === 'https:';
    return `${secure ? 'wss' : 'ws'}://${location.host}/api/session`
      + `?client=${encodeURIComponent(deps.clientId)}`
      + `&device=${encodeURIComponent(deps.deviceLabel ?? 'device')}`;
  });

  const post = (message: unknown): boolean => {
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
    if (remaining > 0) { idleTimer = setTimeout(checkIdle, remaining); return; }
    if (!idle) { idle = true; post({ t: 'idle', idle: true }); }
  };
  const armIdleTimer = (): void => {
    if (!idleTimer) idleTimer = setTimeout(checkIdle, MEMBER_IDLE_AFTER_MS);
  };
  const noteActivity = (): void => {
    lastActivity = Date.now();
    if (idle) { idle = false; post({ t: 'idle', idle: false }); }
    armIdleTimer();
  };
  const activity = (): void => noteActivity();
  const visibilityActivity = (): void => { if (!document.hidden) noteActivity(); };
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
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  function handle(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome': {
        welcome = message as unknown as SessionWelcome;
        lastRideEventBySession.clear();
        capacityNoticeShown = false;
        if (Number.isFinite(welcome.serverTime)) {
          serverOffsetMs = welcome.serverTime - Date.now();
          clockReady = true;
        }
        backoff = RECONNECT_MIN_MS;
        // The server seeded this session from the map this tab was last on; tell it what the editor actually
        // has open, and where this replica left off, which is the authority once the editor is running.
        if (watching !== undefined) post({ t: 'watch', projectId: watching, at, ...versions() });
        post({ t: 'reference', level: referenceLevel });
        post({ t: 'playing', playing });
        post({ t: 'idle', idle });
        post({ t: 'screen-share', enabled: screenSharing });
        if (observedSessionId) post({
          t: 'screen-observe', sessionId: observedSessionId, active: screenObservationActive,
        });
        lastScreenState = '';
        deps.onWelcome?.(welcome);
        return;
      }
      case 'pong': {
        const echo = Number(message.echo), serverTime = Number(message.serverTime), received = Date.now();
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
        deps.onPresence?.(presenceMaps);
        return;
      case 'presence-delta': {
        const change = message.change as {
          sessionId?: string;
          to?: { projectId?: string; entry?: PresenceEntry } | null;
        } | undefined;
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
        deps.onPresence?.(presenceMaps);
        return;
      }
      case 'joined': {
        const view = message as unknown as JoinedView;
        if (view.projectId === watching) { at = view.at; writable = view.writable; }
        deps.onJoined?.(view);
        return;
      }
      case 'sync': {
        const push = message as unknown as
          { projectId: string; at: number; changes: RegisterAssignment[]; by: string };
        if (push.projectId === watching) at = Math.max(at, push.at);
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
        const result = message as unknown as { batch: number; ok: boolean; at: number; document?: EditDoc };
        at = Math.max(at, result.at);
        deps.onClaim?.(result);
        return;
      }
      case 'topology': {
        const push = message as unknown as { projectId: string; at: number; document: EditDoc; by: string };
        if (push.projectId === watching) at = Math.max(at, push.at);
        deps.onTopology?.(push);
        return;
      }
      case 'digest':
        deps.onDigest?.(message as unknown as
          { projectId: string; at: number; root: string; sections: Record<string, string> });
        return;
      case 'sections': {
        const repair = message as unknown as
          { projectId: string; at: number; registers: RegisterAssignment[]; document?: EditDoc };
        at = Math.max(at, repair.at);
        deps.onSections?.(repair);
        return;
      }
      case 'caught-up': {
        const missed = message as unknown as
          { projectId: string; at: number; changes: RegisterAssignment[]; document?: EditDoc };
        at = Math.max(at, missed.at);
        deps.onCaughtUp?.(missed);
        return;
      }
      case 'awareness-batch': {
        const projectId = typeof message.projectId === 'string' ? message.projectId : '';
        if (!projectId || !Array.isArray(message.peers)) return;
        for (const state of message.peers) {
          const peer = state as Omit<PeerAwareness, 'projectId'>;
          if (!peer || peer.sessionId === welcome?.sessionId) continue;
          deps.onAware?.({ ...peer, projectId });
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
        deps.onRevision?.(message as unknown as
          { projectId: string; project: ClientProject; document: EditDoc });
        return;
      case 'project-access': {
        const change = message as unknown as {
          projectId: string; project: ClientProject; writable: boolean; reason?: string; document?: EditDoc;
        };
        if (change.projectId === watching) writable = change.writable;
        deps.onProjectAccess?.(change);
        return;
      }
      case 'gone': {
        const map = message as unknown as { projectId: string; name: string };
        // The server has already taken this tab off the map. Forgetting it here as well is what keeps a
        // reconnection from asking to rejoin one that is not there.
        if (map.projectId === watching) { watching = null; at = 0; }
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
        if (!currentProject || event.projectId !== currentProject || typeof event.fromSessionId !== 'string'
          || !Number.isSafeInteger(event.id)) return;
        const previous = lastRideEventBySession.get(event.fromSessionId) ?? -1;
        if (event.id <= previous) return;
        lastRideEventBySession.set(event.fromSessionId, event.id);
        const serverNow = Date.now() + serverOffsetMs;
        if (!Number.isFinite(event.sentAt) || event.sentAt < serverNow - MAX_RIDE_EVENT_AGE_MS
          || event.sentAt > serverNow + 30_000) return;
        deps.onRideEvent?.(event);
        return;
      }
      case 'error':
        console.warn('[session]', message.message);
        return;
      default:
        return;
    }
  }

  /** What this build evaluates documents with, sent on every join so a mismatched install is told to follow
   *  rather than discovering it by writing geometry nobody else agrees with. */
  const versions = () => ({ doc: DOCUMENT_VERSION, core: CORE_VERSION });

  function connect(): void {
    if (!wanted || socket) return;
    deps.onStatus?.('connecting');
    let opened: WebSocket;
    try { opened = new WebSocket(url()); }
    catch { schedule(); return; }
    socket = opened;
    opened.onopen = () => {
      deps.onStatus?.('open');
      if (beat) clearInterval(beat);
      const ping = () => { post({ t: 'ping', at: Date.now() }); };
      ping();
      beat = setInterval(ping, PING_MS);
    };
    opened.onmessage = event => {
      try { handle(JSON.parse(String(event.data)) as ServerMessage); }
      catch { /* a message this client does not speak is not a reason to drop the channel */ }
    };
    opened.onclose = event => {
      if (socket !== opened) return;
      socket = null;
      welcome = null;
      if (beat) { clearInterval(beat); beat = null; }
      deps.onStatus?.('closed');
      if (event.code === 4001 || event.code === 4002) {
        wanted = false;
        deps.onAccessChanged?.(event.reason || (event.code === 4002
          ? 'Your access changed.' : 'This login session ended.'));
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
    opened.onerror = () => { /* onclose follows, and that is where reconnection is decided */ };
  }

  function schedule(): void {
    if (!wanted) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { socket = null; connect(); }, backoff);
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
  }

  return {
    /** Open the channel. Safe to call twice. */
    start(): void {
      wanted = true;
      closedByUs = false;
      startActivityTracking();
      connect();
    },
    /** Which map this tab is on. Presence is keyed by it, and so is everything the room relays. */
    watch(projectId: string | null, from = 0): void {
      if (watching === projectId) return;
      watching = projectId;
      at = from;
      lastScreenState = '';
      post({ t: 'watch', projectId, ...(from ? { at: from } : {}), ...versions() });
    },
    /** Say the same map again, from where this replica actually is — what a reconnection sends so the room
     *  hands back exactly what was missed. */
    rejoin(): void {
      if (watching === undefined) return;
      post({ t: 'watch', projectId: watching, at, ...versions() });
    },
    /** Publish the extracted mountain in this tab's read-only Reference slot. Retained for reconnects. */
    reference(level: string | null): boolean {
      referenceLevel = level?.trim() || null;
      lastScreenState = '';
      return post({ t: 'reference', level: referenceLevel });
    },
    /** Publish which world this tab is actively playing. Retained for reconnects. */
    setPlaying(target: 'authored' | 'reference' | null): boolean {
      playing = target;
      return post({ t: 'playing', playing });
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
        t: 'assign', batch,
        changes: changes.map(([key, value]) => (value === undefined ? [key] : [key, value])),
      });
    },
    /** A topology edit, compare-and-swapping the ids it consumes against where this replica last was. */
    claim(ids: string[], document: EditDoc, batch: number): boolean {
      return post({ t: 'claim', ids, at, document, batch });
    },
    /** Ask the room what it hashes to. */
    checkDrift(digest: { root: string; sections: Record<string, string> }): boolean {
      return post({ t: 'digest', ...digest });
    },
    /** Refetch exactly the sections that diverged. */
    fetchSections(sections: string[]): boolean { return post({ t: 'fetch', sections }); },
    /** What this tab is selecting and dragging, plus its player pose. */
    aware(aware: Partial<Awareness>): boolean { return post({ t: 'aware', aware }); },
    /** Relay an interaction only after it has already run locally. A closed socket simply means this disposable
     * cue is lost; unlike document edits it must never be queued and replayed into a later Play run. */
    rideEvent(event: RideEvent): boolean {
      return post({ t: 'ride-event', ...event, sentAt: Date.now() + serverOffsetMs });
    },
    /** Current session-server time, continuously refined by socket round trips. */
    serverNow(): number { return Date.now() + serverOffsetMs; },
    /** Say something in the room. Slash commands travel as typed: the server owns what `/msg` and `/r` mean,
     *  so a private line is relayed rather than assembled by whichever client happened to send it. */
    say(text: string): void { post({ t: 'chat', text }); },
    /** Add one public source identity. Every browser resolves it through its own local bridge. */
    addJukeboxVideo(url: string): boolean { return post({ t: 'jukebox-add', url }); },
    removeJukeboxVideo(id: string): boolean { return post({ t: 'jukebox-remove', id }); },
    skipJukeboxVideo(id: string): boolean { return post({ t: 'jukebox-skip', id }); },
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
      closedByUs = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (beat) { clearInterval(beat); beat = null; }
      stopActivityTracking();
      socket?.close();
      socket = null;
    },
    isOpen: (): boolean => socket?.readyState === WebSocket.OPEN,
    /** Whether this member may change a map at all. Moderators retain editor access; viewers follow read-only. */
    mayWrite: (): boolean => writable
      && (welcome?.member.role === 'editor' || welcome?.member.role === 'moderator'
        || welcome?.member.role === 'admin'),
    /** Every author may start a map of their own; the server records them as its owner. */
    mayCreateMountains: (): boolean => welcome?.member.role === 'editor'
      || welcome?.member.role === 'moderator' || welcome?.member.role === 'admin',
    /** Ownership grants map management; moderators/admins retain an operational override. */
    mayManageMountain: (project?: ClientProject | null): boolean => !!project && !!welcome
      && (project.ownerId === welcome.member.id
        || welcome.member.role === 'moderator' || welcome.member.role === 'admin'),
    mayDeleteMountains: (project?: ClientProject | null): boolean => !!project && !!welcome
      && (project.ownerId === welcome.member.id
        || welcome.member.role === 'moderator' || welcome.member.role === 'admin'),
    member: (): SessionMember | null => welcome?.member ?? null,
    /** This participant's own colour, the one everybody else draws them in. */
    color: (): string => welcome?.color ?? '#f2a33c',
    sessionId: (): string | null => welcome?.sessionId ?? null,
  };
}

export type SessionChannel = ReturnType<typeof createSessionChannel>;

/**
 * What this build's documents and core evaluate as (docs/039).
 *
 * Held here as well as on the server because the comparison is between two INSTALLS: a browser running an
 * older bundle against a service running a newer one is exactly the skew that would have one participant
 * tessellate a mountain differently from the rest of the room, and the join is where that is caught.
 */
export const DOCUMENT_VERSION = 3;
export const CORE_VERSION = '2';

/** Presence as a member list rather than a session list: one row per person, with however many tabs they
 *  have open. Keyed by session and displayed by user is the whole rule, and this is the second half of it. */
export function membersOn(entries: readonly PresenceEntry[]): Array<{
  userId: string; username: string; role: MemberRole; color: string;
  sessions: number; lastSeen: number;
}> {
  const byUser = new Map<string, { userId: string; username: string; role: MemberRole;
    color: string; sessions: number; lastSeen: number }>();
  for (const entry of entries) {
    const found = byUser.get(entry.userId);
    if (found) {
      found.sessions++;
      found.lastSeen = Math.max(found.lastSeen, entry.lastSeen);
    } else {
      byUser.set(entry.userId, {
        userId: entry.userId, username: entry.username, role: entry.role,
        color: entry.color, sessions: 1, lastSeen: entry.lastSeen,
      });
    }
  }
  return [...byUser.values()].sort((a, b) => a.username.localeCompare(b.username));
}
