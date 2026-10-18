import type { ChatActivity } from '../../core/session/chat-activity';
import { referenceInRoom, referenceRoom } from '../../core/session/public-courses';
import { publicRoomKnown } from '../public-courses';
import { liveSessions, sessionPolicy } from './presence';

/** Reading activity never joins chat. Multiple tabs count once per identity, not once per network hash. */
export function chatActivity(includePrivate: boolean, now = Date.now()): ChatActivity {
  const online = new Set<string>();
  const courses = new Map<string, Set<string>>();
  for (const session of liveSessions()) {
    if (now - session.lastSeen >= sessionPolicy.presenceTtlMs) continue;
    const id = session.member.id;
    online.add(id);
    let course = session.projectId ?? (session.referenceLevel ? referenceRoom(session.referenceLevel) : null);
    if (!course) continue;
    const reference = referenceInRoom(course);
    if (reference !== null) course = referenceRoom(reference);
    if (!includePrivate && !publicRoomKnown(course)) continue;
    const members = courses.get(course) ?? new Set<string>();
    members.add(id);
    courses.set(course, members);
  }
  return { online: online.size, courses: Object.fromEntries([...courses].map(([id, members]) => [id, members.size])) };
}
