import {
  PLAY_PROTOCOL_VERSION,
  type PlayClientMessage,
  type PlayServerMessage,
  type PlayConfig,
  type PlayPeer,
  type PlayerPose,
  type TicketRequest,
  type TicketResponse,
} from '../../core/session/play-protocol.generated';
import { validatePlayServerMessage, validateTicketResponse } from '../../core/session/play-validators.generated.js';

export interface PlayChannelOptions {
  clientId: string;
  deviceLabel: string;
  publicPlay: boolean;
  baseUrl: () => string;
  onMessage: (message: PlayServerMessage) => void;
  onStatus: (status: 'connecting' | 'open' | 'closed') => void;
  onAccessChanged: (reason: string) => void;
  onCapacityRefused: (reason: string) => void;
}

/** Owns the disposable play connection only. It never queues a pose or interaction across a reconnect. */
export function createPlayChannel(options: PlayChannelOptions) {
  let config: PlayConfig | null = null;
  let wanted = false,
    generation = 0,
    connecting = false;
  let courseId: string | null = null,
    roomId = 'lodge',
    editorSessionId: string | undefined;
  let socket: WebSocket | null = null,
    ready = false;
  let ticket: TicketResponse | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let admission: AbortController | null = null;
  let backoff = 1000,
    renewing = false;
  let offset = 0,
    clockReady = false;
  const peers = new Map<string, PlayPeer>();
  const lastEvents = new Map<string, number>();

  function clear() {
    generation++;
    connecting = false;
    ready = false;
    renewing = false;
    admission?.abort();
    admission = null;
    if (retry) clearTimeout(retry);
    retry = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    const old = socket;
    socket = null;
    old?.close();
    ticket = null;
    peers.clear();
    lastEvents.clear();
  }
  function send(message: PlayClientMessage): boolean {
    if (!ready || socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256 * 1024) return false;
    socket.send(JSON.stringify(message));
    return true;
  }
  function schedule() {
    if (!wanted || !courseId || retry) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, backoff);
    backoff = Math.min(backoff * 2, 15_000);
  }
  async function getTicket(): Promise<TicketResponse> {
    const input: TicketRequest = {
      courseId: courseId!,
      roomId,
      clientId: options.clientId,
      deviceLabel: options.deviceLabel,
      publicPlay: options.publicPlay,
      ...(editorSessionId ? { editorSessionId } : {}),
      ...(ticket ? { previousTicket: ticket.ticket } : {}),
    };
    admission = new AbortController();
    const response = await fetch(new URL(config!.ticketPath, options.baseUrl()), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(input),
      signal: AbortSignal.any([admission.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(failure.error ?? `Play admission failed (${response.status}).`);
    }
    const result: unknown = await response.json();
    if (!validateTicketResponse(result)) throw new Error('Invalid play admission.');
    return result;
  }
  function handle(message: PlayServerMessage) {
    switch (message.t) {
      case 'welcome':
        if (message.protocol !== PLAY_PROTOCOL_VERSION || message.courseId !== courseId) {
          wanted = false;
          clear();
          options.onAccessChanged('Multiplayer was updated. Refresh this page.');
          return;
        }
        ready = true;
        backoff = 1000;
        offset = message.serverTime - Date.now();
        clockReady = true;
        options.onStatus('open');
        break;
      case 'presence':
        peers.clear();
        for (const peer of message.peers) peers.set(peer.sessionId, peer);
        for (const id of lastEvents.keys()) if (!peers.has(id)) lastEvents.delete(id);
        break;
      case 'pong': {
        const received = Date.now();
        if (Number.isFinite(message.echo) && Number.isFinite(message.serverTime) && message.echo <= received) {
          const next = message.serverTime - (message.echo + received) / 2;
          offset = clockReady ? offset + (next - offset) * 0.2 : next;
          clockReady = true;
        }
        break;
      }
      case 'ride-event': {
        const previous = lastEvents.get(message.fromSessionId) ?? -1;
        if (
          message.courseId !== courseId ||
          message.event.id <= previous ||
          message.event.sentAt < Date.now() + offset - 10_000 ||
          message.event.sentAt > Date.now() + offset + 30_000
        )
          return;
        lastEvents.set(message.fromSessionId, message.event.id);
        break;
      }
      case 'closed':
        if (message.code === 4003) options.onCapacityRefused(message.reason);
        else if (message.code === 4001) {
          wanted = false;
          options.onAccessChanged(message.reason);
        }
        socket?.close();
        return;
    }
    options.onMessage(message);
  }
  async function renew(version: number) {
    if (renewing || !ready) return;
    renewing = true;
    try {
      const fresh = await getTicket();
      if (generation !== version || !ready) return;
      ticket = fresh;
      send({ t: 'renew', ticket: fresh.ticket });
    } catch {
      // The relay enforces expiry. A transient API outage must not close the editor socket.
    } finally {
      if (generation === version) renewing = false;
    }
  }
  async function connect() {
    if (!wanted || !courseId || !config || socket || connecting) return;
    connecting = true;
    const version = generation;
    options.onStatus('connecting');
    try {
      const fresh = await getTicket();
      if (generation !== version || !wanted) return;
      ticket = fresh;
      const address = new URL(config.socketPath, options.baseUrl());
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:';
      const opened = new WebSocket(address.href);
      socket = opened;
      opened.onopen = () => {
        if (generation !== version) {
          opened.close();
          return;
        }
        opened.send(
          JSON.stringify({
            t: 'hello',
            protocol: PLAY_PROTOCOL_VERSION,
            ticket: fresh.ticket,
          } satisfies PlayClientMessage),
        );
        heartbeat = setInterval(() => {
          send({ t: 'ping', at: Date.now() });
          void renew(version);
        }, 20_000);
      };
      opened.onmessage = event => {
        if (generation !== version || socket !== opened) return;
        try {
          const message: unknown = JSON.parse(String(event.data));
          if (validatePlayServerMessage(message)) handle(message);
        } catch {
          /* Invalid server frame. */
        }
      };
      opened.onerror = () => {};
      opened.onclose = () => {
        if (generation !== version || socket !== opened) return;
        clear();
        options.onStatus('closed');
        schedule();
      };
    } catch (error) {
      if (generation !== version) return;
      options.onStatus('closed');
      // Admission failures are visible, while connection retries retain exponential backoff.
      options.onMessage({ t: 'error', message: error instanceof Error ? error.message : String(error) });
      schedule();
    } finally {
      if (generation === version) connecting = false;
    }
  }
  return {
    start(next: PlayConfig) {
      config = next;
      wanted = true;
      void connect();
    },
    watch(course: string | null, friendRoom = 'lodge', editorId?: string) {
      if (courseId === course && roomId === friendRoom && editorSessionId === editorId) return;
      clear();
      courseId = course;
      roomId = friendRoom;
      editorSessionId = editorId;
      options.onStatus('closed');
      void connect();
    },
    close() {
      wanted = false;
      clear();
      options.onStatus('closed');
    },
    pose(player: PlayerPose | null) {
      return send({ t: 'pose', player });
    },
    send,
    isOpen: () => ready && socket?.readyState === WebSocket.OPEN,
    serverNow: () => Date.now() + offset,
    peer: (id: string) => peers.get(id),
  };
}
