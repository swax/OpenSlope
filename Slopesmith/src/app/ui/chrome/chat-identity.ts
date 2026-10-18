import { chatName, shortChatId, trailMarker, type ChatMember } from '../../../core/session/chat-member';
import type { MenuItem } from '../components/controls';
import { toast } from '../components/toast';

const STORAGE = 'slopesmith.chat-mutes.v1';
const changed = new Set<() => void>();
let fallback: Record<string, string> = {};
let cachedMutes: Record<string, string> | null = null;

export function mutedChatIds(): Record<string, string> {
  if (cachedMutes) return { ...cachedMutes };
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? '{}');
    if (value && typeof value === 'object' && !Array.isArray(value))
      return {
        ...(cachedMutes = Object.fromEntries(
          Object.entries(value).filter(([key, name]) => /^[a-f0-9]{64}$/.test(key) && typeof name === 'string'),
        )),
      };
  } catch {
    /* private browsing may disable storage */
  }
  return fallback;
}
export const chatMuted = (hash?: string): boolean => !!hash && Object.hasOwn(cachedMutes ?? mutedChatIds(), hash);
export function muteChat(hash: string, name: string, muted: boolean): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) return;
  const ids = mutedChatIds();
  if (muted) ids[hash] = name;
  else delete ids[hash];
  fallback = ids;
  cachedMutes = ids;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(ids));
  } catch {
    /* retain this tab's mute */
  }
  for (const listener of changed) listener();
}
export function onChatMutesChanged(listener: () => void): () => void {
  changed.add(listener);
  return () => changed.delete(listener);
}
if (typeof window !== 'undefined')
  window.addEventListener('storage', event => {
    if (event.key === STORAGE || event.key === null) {
      cachedMutes = null;
      for (const listener of changed) listener();
    }
  });

/** Fixed SVG geometry, never user-supplied markup. The outline makes black trails visible on dark UI. */
export function roleMarker(member: ChatMember): HTMLElement {
  const marker = trailMarker(member);
  const el = document.createElement('span');
  el.className = `sp-role-marker sp-role-${marker.shape}`;
  el.title = marker.label;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', marker.label);
  el.style.cssText =
    'display:inline-flex;align-items:center;justify-content:center;width:24px;min-width:24px;height:16px;vertical-align:-3px;margin-right:3px';
  const shape =
    marker.shape === 'square'
      ? '<rect x="8" y="3" width="10" height="10" rx="1"/>'
      : marker.shape === 'diamond'
        ? '<path d="M13 1 20 8 13 15 6 8Z"/>'
        : marker.shape === 'double-diamond'
          ? '<path d="M6.5 2 12 8 6.5 14 1 8ZM19.5 2 25 8 19.5 14 14 8Z"/>'
          : '<circle cx="13" cy="8" r="5"/>';
  el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 16" width="24" height="16" aria-hidden="true" fill="${marker.shape === 'guest' ? 'none' : marker.color}" stroke="${marker.shape.includes('diamond') ? '#dce7ed' : marker.color}" stroke-width="1.5">${shape}</svg>`;
  return el;
}

export async function bannedChatIds(): Promise<string[]> {
  const response = await fetch('/api/chat/moderation', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not read chat moderation.');
  return ((await response.json()) as { hashes: string[] }).hashes;
}
export async function shadowBanChat(hash: string, banned: boolean): Promise<void> {
  const response = await fetch('/api/chat/moderation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash, banned }),
  });
  if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error ?? 'Chat moderation failed.');
}

export async function chatActions(member: ChatMember, me: ChatMember | null): Promise<MenuItem[]> {
  if (!member.chatId || member.id === me?.id) return [];
  const hash = member.chatId;
  const items: MenuItem[] = [
    {
      label: chatMuted(hash) ? 'Unmute chat' : 'Mute chat',
      desc: `Applies to network #${shortChatId(hash)}, including other rider names. Saved in this browser.`,
      onClick: () => muteChat(hash, chatName(member), !chatMuted(hash)),
    },
  ];
  if (
    me &&
    (me.role === 'admin' || me.role === 'moderator') &&
    member.role !== 'admin' &&
    (me.role === 'admin' || member.role !== 'moderator')
  ) {
    try {
      const banned = (await bannedChatIds()).includes(hash);
      items.push({
        label: banned ? 'Remove chat shadow ban' : 'Shadow-ban chat',
        desc: `Server drops chat from network #${shortChatId(hash)} under every name.`,
        onClick: () => {
          void shadowBanChat(hash, !banned)
            .then(() => toast(banned ? 'Chat shadow ban removed.' : 'Chat shadow ban saved.', 'info'))
            .catch(error => toast(String(error.message ?? error), 'err'));
        },
      });
    } catch (error) {
      toast(String(error instanceof Error ? error.message : error), 'err');
    }
  }
  return items;
}
