import { createPlayChannel } from './play-channel';
import type { MapSource, PlayConfig, PlayServerMessage, SiteCourse } from '../../core/session/play-protocol.generated';
import type { ChatMember } from '../../core/session/chat-member';
import { clientId } from './client';

export type SitePresence = Extract<PlayServerMessage, { t: 'site-presence' }>;
const listeners = new Set<(state: SitePresence | null) => void>();
let state: SitePresence | null = null;
let config: PlayConfig | null = null;
let starting: Promise<void> | null = null;
let visitor: Promise<ChatMember> | null = null;
let course: string | null = null;
let source: MapSource = 'server';
let playRoom: { courseId: string; roomId: string } | null = null;
let chatEnabled = false;
let rosterEnabled = false;
let retry: ReturnType<typeof setTimeout> | null = null;
let startVersion = 0;
const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const publish = (next: SitePresence | null) => {
  if (browserOffline()) next = null;
  state = next;
  for (const listener of listeners) listener(state);
};

export function ensureVisitor(): Promise<ChatMember> {
  if (!visitor)
    visitor = fetch('/api/public/visitor', { method: 'POST', signal: AbortSignal.timeout(5000) })
      .then(async response => {
        if (!response.ok) throw new Error('Visitor identity is unavailable.');
        return ((await response.json()) as { member: ChatMember }).member;
      })
      .catch(error => {
        visitor = null;
        throw error;
      });
  return visitor;
}

const channel = createPlayChannel({
  clientId,
  deviceLabel: 'site',
  publicPlay: true,
  sitePresence: true,
  chatEnabled: () => chatEnabled,
  siteContext: () => ({ mapSource: source, ...(playRoom?.courseId === course ? { playRoomId: playRoom.roomId } : {}) }),
  baseUrl: () => location.origin,
  onMessage(message) {
    if (message.t === 'site-presence') publish(message);
    if (message.t === 'site-activity') publish({ ...message, t: 'site-presence', members: state?.members ?? [] });
    if (message.t === 'welcome' && rosterEnabled) channel.send({ t: 'site-roster', enabled: true });
  },
  onStatus(status) {
    if (status === 'closed') publish(null);
  },
  onAccessChanged() {
    course = null;
    channel.watch('@site', 'site');
    channel.start(config!);
  },
  onCapacityRefused() {
    publish(null);
  },
});

export function startSitePresence(): Promise<void> {
  if (browserOffline()) {
    publish(null);
    return Promise.resolve();
  }
  if (starting) return starting;
  const version = ++startVersion;
  starting = (async () => {
    const response = await fetch('/api/play/config', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Site presence is unavailable.');
    const next = (await response.json()) as PlayConfig;
    if (version !== startVersion) return;
    config = next;
    if (!config.enabled) {
      publish(null);
      return;
    }
    await ensureVisitor();
    if (version !== startVersion) return;
    channel.watch(course ?? '@site', 'site');
    channel.start(config);
  })().catch(() => {
    if (version !== startVersion) return;
    publish(null);
    starting = null;
    if (!browserOffline() && !retry)
      retry = setTimeout(() => {
        retry = null;
        void startSitePresence();
      }, 5000);
  });
  return starting;
}

export function watchSitePresence(listener: (state: SitePresence | null) => void): () => void {
  listeners.add(listener);
  listener(state);
  void startSitePresence();
  return () => listeners.delete(listener);
}
export function siteMembers(snapshot: SitePresence): ChatMember[] {
  return snapshot.members.map(entry => ({
    ...entry.member,
    maps: entry.maps.map(map => ({ ...map, ...siteMapContext(map) })),
  }));
}
export function siteMapContext(map: Pick<SiteCourse, 'id' | 'roomId'>) {
  return {
    sameMap: !!playRoom && map.id === playRoom.courseId,
    sameRoom: !!playRoom && map.id === playRoom.courseId && map.roomId === playRoom.roomId,
  };
}
export function setSiteCourse(next: string | null, mapSource: MapSource = 'server'): void {
  if (course === next && source === mapSource) return;
  const sameCourse = course === next;
  course = next;
  source = mapSource;
  channel.watch(course ?? '@site', 'site');
  if (sameCourse) channel.refreshIdentity();
}
/** Only a confirmed movement-room welcome marks this tab as sharing a play room. */
export function setSitePlayRoom(next: typeof playRoom): void {
  if (playRoom?.courseId === next?.courseId && playRoom?.roomId === next?.roomId) return;
  playRoom = next;
  channel.refreshIdentity();
  if (state) publish(state);
}
export function setSiteChat(enabled: boolean): void {
  if (chatEnabled === enabled) return;
  chatEnabled = enabled;
  channel.refreshIdentity();
}
export function setSiteRoster(enabled: boolean): void {
  rosterEnabled = enabled;
  channel.send({ t: 'site-roster', enabled });
}
if (typeof window !== 'undefined') {
  const disconnect = () => {
    startVersion++;
    starting = null;
    if (retry) clearTimeout(retry);
    retry = null;
    channel.close();
  };
  window.addEventListener('offline', disconnect);
  window.addEventListener('online', () => {
    void startSitePresence();
  });
  document.addEventListener('chat-tab-change', event => setSiteRoster((event as CustomEvent<boolean>).detail));
  window.addEventListener('pagehide', () => {
    disconnect();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) void startSitePresence();
  });
}
