import type { SiteCourse } from './play-protocol.generated';

export type ChatRole = 'viewer' | 'editor' | 'moderator' | 'admin';
export type ChatMap = SiteCourse & { sameRoom?: boolean; sameMap?: boolean };

export function chatMapRoomLabel(map: ChatMap): string {
  if (map.sameRoom) return 'Same play room';
  if (!map.roomId) return 'Viewing map';
  if (map.sameMap) return 'Different play room';
  return map.roomId === 'lodge' ? 'Public play room' : 'Invite room';
}

/** Public, server-attributed chat identity. The keyed digest never contains the network address. */
export interface ChatMember {
  id: string;
  username: string;
  role: ChatRole;
  chatId?: string;
  anonymous?: boolean;
  maps?: ChatMap[];
}

export const isGuest = (member: { id: string }): boolean => member.id.startsWith('guest:');
export const shortChatId = (hash: string): string => hash.slice(0, 4).toUpperCase();
export const chatName = (member: ChatMember): string =>
  isGuest(member) && member.chatId
    ? `${member.username.replace(/ \(guest\)$/, '')} #${shortChatId(member.chatId)}`
    : member.username;

export function trailMarker(member: ChatMember): { label: string; shape: string; color: string } {
  if (isGuest(member)) return { label: 'Guest', shape: 'guest', color: '#67d88a' };
  switch (member.role) {
    case 'viewer':
      return { label: 'Viewer', shape: 'circle', color: '#67d88a' };
    case 'editor':
      return { label: 'Editor', shape: 'square', color: '#62b2f5' };
    case 'moderator':
      return { label: 'Moderator', shape: 'diamond', color: '#111820' };
    case 'admin':
      return { label: 'Admin', shape: 'double-diamond', color: '#111820' };
  }
}
