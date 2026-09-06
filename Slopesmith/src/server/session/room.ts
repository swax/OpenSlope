import type { EditDoc } from '../../core/doc/doc-edit';
import { canonicalJson } from '../../core/doc/canonical';
import { documentDiff, revertAssignments, type RevertScope } from '../../core/doc/compare';
import {
  digestDocument, textHash, updateDigest, TOPOLOGY_SECTION, type DocumentDigest,
} from '../../core/doc/digest';
import {
  applyRegisters, globalRegister, readRegister, sectionRegisters, writeRegister,
  type RegisterKey, type RegisterValue,
} from '../../core/doc/registers';
import {
  ProjectConflictError, onProjectWritten, openProject, saveRoomDocument, type ProjectSnapshot,
} from '../projects';
import { createLogger } from '../log';

const log = createLogger('room');

/**
 * The register room: one map's document, held in memory, with everybody's changes landing on it in arrival
 * order (docs/039).
 *
 * The unit of concurrency here is a register, not the document. Ordinary editing is a free-for-all of absolute
 * assignments — a drag sets a position, a paint stroke sets a surface type — so two people working on
 * different parts never write the same register and never need merging, and two people writing the SAME
 * register get last-writer-wins with a defined outcome. Nothing an assignment can say is refusable for having
 * lost a race; the only refusals are structural, and they are the two the register model already tells apart:
 * a key naming geometry this document has retired is discarded quietly, and a key naming nothing it has ever
 * had is reported.
 *
 * TOPOLOGY is the exception, because two people subdividing one quad do not produce a merge, they produce
 * non-manifold geometry. It takes an implicit compare-and-swap over the ids it consumes rather than a lease:
 * one round trip, nothing held, nothing to release.
 *
 * ## One sequence, not a version vector
 *
 * The room is the sequencer. Every accepted change — an assignment batch or a topology claim — takes the next
 * number, and a participant's whole idea of "where I am" is that one number. It is what a topology claim is
 * compared against, what a rebase replays from, and what a reconnecting client says it last saw. There is no
 * per-participant clock anywhere, which is deliberate: writing version vectors is the signal to stop building
 * this by hand and adopt Yjs instead (docs/039).
 *
 * ## Durability
 *
 * The room, not the file, is the authoritative document while it is open. `saveRoomDocument` writes a
 * revisioned snapshot on the cadence below, so the stored format, the revision line and the checkpoint ring
 * keep working as they always have. Those snapshots are not pushed to anybody — every participant already
 * holds the values they contain. A write from OUTSIDE the room — an import, a checkpoint restore, a script —
 * is announced, and the room adopts it, which is what keeps the two paths from drifting apart.
 */

/** How the durable snapshot is paced. */
export interface RoomPolicy {
  /**
   * Quiet time after the last accepted change before the room writes a snapshot.
   *
   * 450 ms is the editor's own autosave debounce, which stops being the transport the moment registers exist
   * and becomes exactly this: the cadence at which a shared document is made durable. One flush per drag, per
   * paint stroke, per nudge — the same rhythm the single author already had.
   */
  snapshotIdleMs: number;
  /** Changes that force a snapshot even while the room stays busy, so a continuous drag cannot postpone
   *  durability indefinitely. Two hundred is about eight seconds of one person dragging at the coalescing
   *  rate, which is as much work as a crash is allowed to cost. */
  snapshotChanges: number;
  /**
   * How many accepted batches the room keeps, so a topology claim taken against a slightly stale replica can
   * be rebased onto what has landed since. Five hundred batches is twenty seconds of one person dragging;
   * a claim older than that is answered with the document instead, which is a resync rather than a rebase.
   */
  logLimit: number;
}

export const roomPolicy: RoomPolicy = {
  snapshotIdleMs: 450,
  snapshotChanges: 200,
  logLimit: 500,
};

/** Retune the cadence — the seam a test uses to exercise snapshots without waiting one out. */
export function configureRooms(patch: Partial<RoomPolicy>): RoomPolicy {
  return Object.assign(roomPolicy, patch);
}

/** One assignment on the wire: a register key and the absolute value it now holds. `undefined` — which JSON
 *  carries as an absent value — clears the register, which is what an unpainted face or a deleted prop is. */
export type RegisterAssignment = readonly [RegisterKey, RegisterValue];

/**
 * Assignments as they go out.
 *
 * A register holding NOTHING is a real value — an unpainted face, an uncreased edge, a deleted prop — and JSON
 * cannot carry `undefined` inside an array: `["q/1/tex", undefined]` serialises as `["q/1/tex", null]`, which
 * is a different assignment that would set the register to null rather than clear it. So a clear travels as
 * the key alone, and a reader takes a missing second element as nothing. `null` therefore still means null.
 */
export const onWire = (changes: readonly RegisterAssignment[]): RegisterAssignment[] =>
  changes.map(([key, value]) => (value === undefined ? [key] : [key, value]) as RegisterAssignment);

/** How a batch of assignments turned out, in the words the sender needs: the sequence it landed at, the keys
 *  that named geometry already gone, and the keys that named nothing at all. */
export interface AssignResult {
  at: number;
  /** The assignments that MOVED the document — what the sequence counted, and the whole of what is worth
   *  relaying. An assignment of the value a register already held is not one of them. */
  landed: RegisterAssignment[];
  retired: RegisterKey[];
  refused: RegisterKey[];
}

/** A topology claim's outcome. Losing hands back the document that won, so the loser moves from its
 *  optimistic state straight to the authoritative one rather than back through the state it started in. */
export type ClaimResult =
  | { ok: true; at: number; document: EditDoc }
  | { ok: false; at: number; document: EditDoc };

export interface Room {
  projectId: string;
  doc: EditDoc;
  digest: DocumentDigest;
  /** The room's one sequence. Every accepted change takes the next number. */
  at: number;
  /** Which sequence last consumed each mesh id — the whole of what a topology claim compares against. */
  stamps: Map<string, number>;
  /**
   * Who last landed each register, by username — the whole of what "everything Bob changed" is read off
   * (docs/040).
   *
   * This is the crediting the room already does for a session-end checkpoint (`noteWriter`), kept at register
   * grain instead of per map, and it is deliberately memory-only: it describes the session rather than the
   * mountain, so a restart is allowed to forget it, and writing it down would mean a document whose bytes
   * change because of who touched them. LAST writer, not every writer, which is what makes a scoped revert
   * safe — a register Bob moved and Ada moved after him belongs to Ada, and reverting it would discard her
   * work, which is the exact thing a scoped revert exists to avoid.
   */
  authors: Map<RegisterKey, string>;
  /** The sequence the last accepted topology change took, so a claim built on an older structure is told to
   *  resync rather than having two structures merged. */
  topologyAt: number;
  /** The accepted batches still retained, oldest first, for rebasing a claim onto what landed under it. */
  log: { at: number; changes: RegisterAssignment[] }[];
  /** Changed since the last durable snapshot, and the timer that will take one. */
  since: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A snapshot in flight, so closing the room waits for it rather than leaving a half-written revision. */
  writing: Promise<unknown> | null;
  /** The revision the room last wrote itself, so the write it hears back is not read as somebody else's. */
  wrote: number;
}

const rooms = new Map<string, Room>();
const opening = new Map<string, Promise<Room>>();

/** Somebody else's document arriving through the file: an import, a checkpoint restore, a script. The room
 *  adopts it whole, because that write replaced the mountain rather than assigning to it. */
let watchingWrites: (() => void) | null = null;

function watchExternalWrites(): void {
  watchingWrites ??= onProjectWritten(({ snapshot }) => {
    const room = rooms.get(snapshot.project.id);
    if (!room || snapshot.project.revision <= room.wrote) return;
    adopt(room, snapshot.document);
    // The revision the room now stands on, not just the document. `takeSnapshot` writes AGAINST `wrote`, so a
    // room that adopted the new document while still claiming the old revision conflicts with the very write
    // it just adopted — and its conflict path drops the snapshot, silently discarding every assignment made
    // since. Adopting in-process has to leave the room in the same state the conflict path leaves it in.
    room.wrote = snapshot.project.revision;
    room.at++;
  });
}

function adopt(room: Room, doc: EditDoc): void {
  room.doc = doc;
  room.digest = digestDocument(doc, textHash);
}

/** The room for a map, opening it from disk on first use. Concurrent joins share one open. */
export async function joinRoom(projectId: string): Promise<Room> {
  const held = rooms.get(projectId);
  if (held) return held;
  const already = opening.get(projectId);
  if (already) return already;
  watchExternalWrites();
  const open = openProject(projectId).then(snapshot => {
    const made: Room = {
      projectId, doc: snapshot.document, digest: digestDocument(snapshot.document, textHash),
      at: 0, stamps: new Map(), authors: new Map(), topologyAt: 0, log: [], since: 0, timer: null,
      writing: null, wrote: snapshot.project.revision,
    };
    rooms.set(projectId, made);
    return made;
  }).finally(() => opening.delete(projectId));
  opening.set(projectId, open);
  return open;
}

/** The room a map already has open, or none — the read every relay takes, so a message for a map nobody has
 *  joined costs no disk. */
export const roomFor = (projectId: string): Room | undefined => rooms.get(projectId);

// ---- ordinary editing: absolute assignments --------------------------------------------------------------

/**
 * Whether a register already holds the value being assigned to it.
 *
 * Values compare through the canonical text rather than by bits, for the reason the canonical form exists: the
 * same authored position reached by a drag, an undo and a nudge differs from itself in the last bit or two,
 * and a difference nobody made is not a difference. Holding NOTHING is kept apart from holding `null`, because
 * they are two states of the document rather than one — the decomposition omits the first and lists the
 * second, and they hash as different sections.
 */
const holdsAlready = (held: RegisterValue, value: RegisterValue): boolean =>
  (held === undefined) === (value === undefined) && canonicalJson(held) === canonicalJson(value);

/**
 * Land a batch of assignments.
 *
 * Applied in the order they arrived and immediately: an assignment is idempotent and absolute, so arrival
 * order IS the resolution, and there is no state in which a later value has to wait for an earlier one.
 *
 * The sequence counts what the document HOLDS, which is what makes it the one thing every replica measures
 * itself against, so an assignment that leaves a register holding what it already held is applied and
 * acknowledged and counts for nothing else: it takes no sequence number, enters no log, is relayed to nobody
 * and debits no snapshot. An assignment that changes the value is untouched by that, however many times the
 * same value has been written before — what is declined is the claim that the mountain moved, not the write.
 * It also bounds the damage a confused replica can do: a client re-sending an identical assignment cannot
 * drive the room's sequence, its snapshots or everybody else's inboxes from a value nobody changed.
 *
 * `by` is whoever landed it, credited per register as well as per map, which is what lets a scoped revert
 * name one person's work later without an authorship trail being written anywhere. Crediting follows the same
 * rule: the last person to CHANGE a register owns it, so a revert scoped to one person puts back what they
 * did rather than what somebody else did to a register they wrote the same value to.
 */
export function assign(room: Room, changes: readonly RegisterAssignment[], by = ''): AssignResult {
  const retired: RegisterKey[] = [];
  const refused: RegisterKey[] = [];
  const landed: RegisterAssignment[] = [];
  for (const [key, value] of changes) {
    const held = readRegister(room.doc, key);
    const outcome = writeRegister(room.doc, key, value);
    if (outcome === 'retired') { retired.push(key); continue; }
    if (outcome === 'refused') { refused.push(key); continue; }
    if (holdsAlready(held, value)) continue;
    landed.push([key, value]);
    if (by) room.authors.set(key, by);
  }
  // A batch that changed nothing does not move the sequence, so a stale edit for deleted geometry and a
  // re-assertion of what is already there both leave everybody's idea of where the room is exactly where it
  // was.
  if (landed.length) {
    room.at++;
    room.digest = updateDigest(room.doc, room.digest, landed.map(([key]) => key), textHash);
    room.log.push({ at: room.at, changes: landed });
    if (room.log.length > roomPolicy.logLimit) room.log.shift();
    room.since += landed.length;
    scheduleSnapshot(room);
  }
  return { at: room.at, landed, retired, refused };
}

/** The assignments the room has accepted since a given sequence — what a reconnecting participant is caught
 *  up with, or null when the tail no longer reaches back that far and it needs the document instead. */
export function changesSince(room: Room, at: number): RegisterAssignment[] | null {
  if (at >= room.at) return [];
  if (at < room.topologyAt) return null;
  const retained = room.log.length ? room.log[0].at - 1 : room.at;
  if (at < retained) return null;
  return room.log.filter(entry => entry.at > at).flatMap(entry => entry.changes);
}

// ---- scoped revert: putting part of a map back (docs/040) -------------------------------------------------

/** Which registers one participant last landed, matched on the username the room credits them under. */
export function registersWrittenBy(room: Room, by: string): RegisterKey[] {
  const wanted = by.trim().toLowerCase();
  if (!wanted) return [];
  return [...room.authors].flatMap(([key, writer]) => writer.toLowerCase() === wanted ? [key] : []);
}

/** Everybody the room has credited a register to since it opened — who a revert may be scoped to. */
export const roomWriters = (room: Room): string[] => [...new Set(room.authors.values())].sort();

/** How far a revert reaches: one person's work, a selection of geometry, or both. */
export interface RevertRequest {
  /** Revert everything this participant changed. */
  by?: string;
  /** Revert this selection — bounded by the corners and faces it names. */
  vertices?: readonly string[];
  quads?: readonly string[];
}

/**
 * The assignments that put part of this room's mountain back to a checkpoint (docs/040).
 *
 * *"Revert everything Bob changed since r120"* is two facts already in hand: the registers whose values differ
 * from the checkpoint at r120, and the registers the room credits to Bob. Their intersection, assigned the
 * checkpoint's values, IS the revert — no new storage, no new refusal path, and no history format, because the
 * checkpoint is a whole document that was already on disk and the difference is computed rather than recorded.
 *
 * Whole-document restore stays the blunt instrument beside it: rolling an hour back to undo one person's
 * mistake discards everyone else's good work from that hour, and this is the answer to that.
 */
export function planRevert(room: Room, was: EditDoc, request: RevertRequest = {}): RegisterAssignment[] {
  const scope: RevertScope = {
    ...(request.by ? { keys: registersWrittenBy(room, request.by) } : {}),
    ...(request.vertices?.length ? { vertices: request.vertices } : {}),
    ...(request.quads?.length ? { quads: request.quads } : {}),
  };
  return revertAssignments(documentDiff(was, room.doc), scope);
}

// ---- topology: an implicit compare-and-swap ---------------------------------------------------------------

/**
 * Take the ids a topology edit consumes, or lose the race.
 *
 * The comparison is one scalar against one map: the claimant says which sequence it last saw, and the claim
 * stands unless some id it names has been consumed by a topology edit since. That is what makes the claim
 * cover exactly the geometry the operation touches — two people subdividing quads at opposite ends of the
 * mountain name disjoint ids and both win — without anybody holding anything.
 *
 * A winner's document is its own replica, which may be a few coalescing ticks behind. So it is adopted as the
 * new base and the assignments that landed under it are replayed on top; an assignment for something the
 * topology edit removed retires quietly, which is exactly what a late edit for deleted geometry is. A claim
 * older than the retained log cannot be rebased and is refused with the room's document, which resyncs it.
 */
export function claimTopology(room: Room,
  claim: { ids: readonly string[]; at: number; document: EditDoc }): ClaimResult {
  const lost = (): ClaimResult => ({ ok: false, at: room.at, document: room.doc });
  // The claim itself: an id this operation consumes that another operation has consumed since.
  for (const id of claim.ids) {
    const stamped = room.stamps.get(id);
    if (stamped !== undefined && stamped > claim.at) return lost();
  }
  // And the limit of what a claim can be rebased onto. A base that predates a topology change the claimant
  // never saw is a second structure, and reconciling two structures is the merge engine docs/039 says to
  // adopt Yjs for rather than write; the same goes for a base older than the retained tail. Both are answered
  // with the document, which is a resync rather than a merge.
  const retained = room.log.length ? room.log[0].at - 1 : room.at;
  if (claim.at < room.topologyAt || claim.at < retained) return lost();

  const replaying = changesSince(room, claim.at) ?? [];
  adopt(room, claim.document);
  // The claimant's document is its own replica, so whatever landed under it is replayed on top. An assignment
  // naming geometry this operation removed retires quietly, which is exactly what a late edit for deleted
  // geometry is.
  applyRegisters(room.doc, replaying);
  room.at++;
  room.topologyAt = room.at;
  for (const id of claim.ids) room.stamps.set(id, room.at);
  room.digest = digestDocument(room.doc, textHash);
  // The tail described a structure that no longer exists, so it is not something a later claim may replay.
  room.log = [];
  room.since = roomPolicy.snapshotChanges;
  scheduleSnapshot(room);
  return { ok: true, at: room.at, document: room.doc };
}

// ---- drift detection and repair (docs/039) ----------------------------------------------------------------

/** The room's two-level digest — the roots two replicas compare, and the section hashes they descend to. */
export const roomDigest = (room: Room): DocumentDigest => room.digest;

/** One section's registers, for a replica repairing exactly the chunk that diverged. The topology section is
 *  not register-shaped, so a divergence there is answered with the document instead. */
export function roomSection(room: Room, section: string):
  { registers: RegisterAssignment[] } | { document: EditDoc } {
  if (section === TOPOLOGY_SECTION) return { document: room.doc };
  return { registers: [...sectionRegisters(room.doc, section)] };
}

// ---- durability -------------------------------------------------------------------------------------------

function scheduleSnapshot(room: Room): void {
  if (room.since >= roomPolicy.snapshotChanges) { void takeSnapshot(room); return; }
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => { void takeSnapshot(room); }, roomPolicy.snapshotIdleMs);
  room.timer.unref?.();
}

/** Write the document as it stands. Serialised against itself, so a busy room writes one revision at a time
 *  rather than racing its own snapshots.
 *
 *  The snapshot is written AGAINST the revision the room last saw. A write that reached the file from outside
 *  this process — a headless recipe, a second server, a restored backup — is invisible to `onProjectWritten`,
 *  which is an in-process event, so without that check the room would write its older document over the newer
 *  one under a higher revision and the outside write would simply be gone. On a conflict the room takes the
 *  newer document instead of writing: the same thing it does when it hears an external write in-process, and
 *  the same reason — that write replaced the mountain rather than assigning to it. */
export function takeSnapshot(room: Room): Promise<unknown> {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (!room.since) return room.writing ?? Promise.resolve();
  const taking = (room.writing ?? Promise.resolve())
    .then(async () => {
      if (!room.since) return;
      const pending = room.since;
      room.since = 0;
      let snapshot: ProjectSnapshot;
      try {
        snapshot = await saveRoomDocument(room.projectId, room.doc, room.wrote);
      } catch (error) {
        if (!(error instanceof ProjectConflictError)) { room.since = pending; throw error; }
        adopt(room, error.snapshot.document);
        room.wrote = error.snapshot.project.revision;
        room.at++;                       // participants resync onto what landed rather than onto what we held
        log.warn(`${room.projectId} moved on to revision ${room.wrote} outside this server — `
          + 'adopted it and dropped this snapshot');
        return;
      }
      room.wrote = snapshot.project.revision;
      // A map's name never overwrites another map's (docs/038), so a room renamed onto a name somebody else
      // holds is stored under a suffixed one. The room adopts what was stored: a room that went on holding
      // the name it asked for would ask for it again on its next snapshot, be suffixed again, and go on
      // climbing for as long as anybody kept editing.
      if (room.doc.name !== snapshot.project.name) {
        room.doc.name = snapshot.project.name;
        room.digest = updateDigest(room.doc, room.digest, [globalRegister('name')], textHash);
      }
    })
    .catch(error => { log.error(`the snapshot for ${room.projectId} failed`, { error }); })
    .finally(() => { if (room.writing === taking) room.writing = null; });
  room.writing = taking;
  return taking;
}

/**
 * The map is gone: let the room go without writing it out (docs/038).
 *
 * The counterpart to `closeRoom`, and the difference is the whole point — there is no folder left to write a
 * snapshot into, so the pending changes go with the map they described. Clearing what is outstanding as well
 * as the timer is what stops a snapshot already queued behind an in-flight one from running after this.
 */
export function discardRoom(projectId: string): void {
  const room = rooms.get(projectId);
  if (!room) return;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  room.since = 0;
  rooms.delete(projectId);
}

/** Nobody is left on this map: take whatever has not been written and let the room go. */
export async function closeRoom(projectId: string): Promise<void> {
  const room = rooms.get(projectId);
  if (!room) return;
  rooms.delete(projectId);
  await takeSnapshot(room);
}

/** Everything the rooms hold, discarded — for a test that wants a server to start with none. */
export function forgetRooms(): void {
  for (const room of rooms.values()) if (room.timer) clearTimeout(room.timer);
  rooms.clear();
  opening.clear();
  watchingWrites?.();
  watchingWrites = null;
}
