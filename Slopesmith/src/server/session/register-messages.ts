import type { EditDoc } from '../../core/doc/doc-edit';
import { objectFieldOf, readRegister } from '../../core/doc/registers';
import { CORE_VERSION } from '../../core/session/protocol';
import { sessionsOn } from './presence';
import { onWire, type AssignResult, type RegisterAssignment, type Room } from './room';
import { prepareWebSocketText, type PreparedText } from './socket';

/** A mismatched bundle follows read-only, using whole objects and whole topology documents. */
export const olderCore = (session: { coreVersion?: string }): boolean =>
  session.coreVersion !== undefined && session.coreVersion !== CORE_VERSION;

/** Collapse field edits to the objects as they stand at this sequence, including later clears or replacements
 *  in a catch-up batch. Replaying an earlier whole value after a field's snapshot would undo that field. */
export function legacyAssignments(doc: EditDoc, changes: readonly RegisterAssignment[]): RegisterAssignment[] {
  const objects = new Set(changes.flatMap(([key]) => {
    const field = objectFieldOf(key);
    return field ? [field.object] : [];
  }));
  const sent = new Set<string>();
  const result: RegisterAssignment[] = [];
  for (const change of changes) {
    const key = objectFieldOf(change[0])?.object ?? change[0];
    if (!objects.has(key)) { result.push(change); continue; }
    if (sent.has(key)) continue;
    sent.add(key);
    result.push([key, readRegister(doc, key)]);
  }
  return result;
}

/** Call immediately after assigning, before awaiting persistence: legacy snapshots and the sequence must
 *  describe the same state, and relays must leave in the order the room accepted them. */
export function broadcastRegisters(room: Room, written: AssignResult, by: string, except?: string): void {
  if (!written.landed.length) return;
  let current: PreparedText | undefined, legacy: PreparedText | undefined;
  const frame = (changes: readonly RegisterAssignment[]): PreparedText => prepareWebSocketText(JSON.stringify({
    t: 'sync', projectId: room.projectId, at: written.at, changes: onWire(changes), by,
  }));
  for (const session of sessionsOn(room.projectId)) {
    if (session.sessionId === except) continue;
    session.sendPrepared(olderCore(session)
      ? legacy ??= frame(legacyAssignments(room.doc, written.landed))
      : current ??= frame(written.landed));
  }
}
