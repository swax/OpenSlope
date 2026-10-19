import type { ChatActivity } from '../../core/session/chat-activity';
import { element } from './dom';

import { startSitePresence, watchSitePresence } from '../net/site-presence';

export const refreshChatActivity = startSitePresence;
export function watchChatActivity(listener: (activity: ChatActivity | null) => void): () => void {
  return watchSitePresence(snapshot => listener(snapshot ? { online: snapshot.online, courses: snapshot.courses } : null));
}

export function activityCounter(kind: 'server' | 'map') {
  const el = element('span', kind === 'server' ? 'public-online' : 'public-map-online');
  const dot = element('span', 'public-online-dot'); dot.setAttribute('aria-hidden', 'true');
  const count = element('span', 'public-online-number');
  const label = element('span', 'public-online-label', kind === 'server' ? 'online' : 'players');
  el.append(dot, count, label);
  el.setAttribute('role', 'status');
  const set = (value: number | null): void => {
    const next = value === null ? 'unknown' : String(value);
    if (el.dataset.count === next) return;
    el.dataset.count = next;
    el.hidden = kind === 'map' && (value === null || value === 0);
    count.textContent = value === null ? '—' : String(value);
    count.hidden = kind === 'server' && value === null;
    if (kind === 'server') label.textContent = value === null ? 'Offline' : 'online';
    if (kind === 'map') label.textContent = value === 1 ? 'player' : 'players';
    el.classList.toggle('unavailable', value === null);
    el.setAttribute('aria-label', value === null ? kind === 'server' ? 'Offline' : 'Player activity unavailable'
      : `${value} ${value === 1 ? 'player' : 'players'} ${kind === 'server' ? 'online on the site' : 'online on this map'}`);
    el.title = value === null ? kind === 'server' ? 'Disconnected from live users and chat. Local maps and loaded ISO maps are still available.' : 'Player activity is temporarily unavailable.'
      : kind === 'server' ? 'Everyone connected to the site, including anonymous visitors. Each identity counts once across tabs.'
        : 'Players with this map open in the editor or Play, across all friend rooms. Each account or guest counts once.';
  };
  set(null);
  return { el, set };
}
