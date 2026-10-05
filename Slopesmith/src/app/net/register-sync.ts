import type { EditDoc } from '../../core/doc/doc-edit';
import { canonicalNumber } from '../../core/doc/canonical';
import {
  TOPOLOGY_SECTION, digestDocument, divergentSections, textHash, type DocumentDigest,
} from '../../core/doc/digest';
import { nameIndex } from '../../core/doc/ids';
import {
  applyRegisters, documentRegisters, objectFieldChanges, objectFieldOf, registerGeometry, registerShell,
  vertexRegister, writeRegister,
  type RegisterKey, type RegisterValue,
} from '../../core/doc/registers';
import {
  applyTopologyDelta, detachedDocument, topologyDelta, type TopologyDelta,
} from '../../core/doc/topology-delta';
import type { ClaimAnswer, RegisterAssignment, SyncStep, TopologyPush } from './session-channel';

/** A claim's answer as this module reads it: the sequence it carries is the channel's business. */
type ClaimOutcome = Pick<ClaimAnswer, 'batch' | 'ok' | 'refused' | 'steps' | 'document'>;

/**
 * This tab's half of register sync (docs/039): what it sends, what it holds, and what it can put back.
 *
 * The document is edited exactly as it always was — tools mutate it in place and the render funnel says so —
 * and this watches the result. Every tick it compares the document against the last values it believes the
 * room holds and sends the difference as ABSOLUTE assignments: "these registers now hold these values", never
 * "I performed this operation". That is what makes the relative tools — smooth, extrude, nudge-by-delta,
 * subdivide, the bulk crease operations — free: they resolve into the values they produce before anything is
 * sent, because what is sent is read off the document afterwards rather than described in advance.
 *
 * ## Coalescing
 *
 * Comparing at a tick rather than per edit IS the coalescing, and it is exact: the intermediate positions of a
 * drag never enter a buffer to be dropped from, because only the value the document holds when the tick fires
 * is ever read. A sixty-frame drag of one corner is one assignment per tick, whatever happened in between.
 *
 * ## Topology
 *
 * Registers do not own which vertices and quads exist. When the structure changes, this asks the room to
 * compare-and-swap the ids the operation consumed, having already applied it locally, and sends what the
 * operation did as a DELTA named by stable id plus the registers it produced (docs/039, *Topology travels as a
 * delta*). Winning costs nothing more; losing hands back what the room sequenced since this replica's base,
 * and this replica rebuilds that base and goes straight to the authoritative geometry — one rebuild, never
 * back through the state it started in. Somebody else's topology arrives the same way and is applied to the
 * live document rather than replacing it, so nothing this replica holds is rebuilt from scratch.
 *
 * ## In flight
 *
 * Arrival order at the room decides every register, so this replica has to resolve concurrent writes the way
 * the room did. A relayed value for a register this replica has written and the room has not acknowledged was
 * sequenced BEFORE that write — on one ordered socket, the relay arriving first proves it — so the room ends on
 * this replica's value, and the relay is skipped rather than written over it.
 *
 * ## Undo
 *
 * Whole-document snapshots cannot survive shared editing: restoring one would erase everybody else's work
 * along with your own. So a step records the registers it changed together with their prior values, and undo
 * RE-ASSERTS those priors as a fresh change. It can therefore put back a value somebody else has since
 * changed — that is the accepted meaning of "put back what I had", and it stays consistent because the
 * re-assertion is an ordinary write like any other.
 */

/** What this module needs of a channel, so it can be exercised without a socket. */
export interface RegisterTransport {
  assign(changes: RegisterAssignment[], batch: number): boolean;
  claim(ids: string[], delta: TopologyDelta, changes: RegisterAssignment[], batch: number): boolean;
  checkDrift(digest: { root: string; sections: Record<string, string> }): boolean;
  fetchSections(sections: string[]): boolean;
}

/**
 * How often the document is compared against what the room holds: 25 Hz.
 *
 * The band is 20–30 Hz, and 25 sits in the middle at an exact 40 ms — three or two frames of a 60 Hz drag per
 * tick, evenly enough that no tick is ever skipped for arriving a fraction early. Below 20 Hz somebody else's
 * drag stops reading as a drag; above 30 Hz the extra messages carry positions that are already superseded by
 * the time they are drawn. It cuts a 60 Hz drag's traffic by well over half, and it costs one comparison pass
 * over a mountain's registers, which is only paid while something has actually changed.
 */
export const COALESCE_MS = 40;

/**
 * Quiet time after the last local change before the replica checks itself against the room.
 *
 * Drift comes from bugs rather than from design, so the detector has to be always-on and free when nothing is
 * happening. Five seconds with no local edit and nothing in flight is idle by any editor's reckoning, and far
 * longer than the gap between two strokes of continuous work, so a busy session never pays for it.
 */
export const IDLE_CHECK_MS = 5_000;

/**
 * How long a disconnection may last before held changes are summarised rather than replayed.
 *
 * Replaying what you did while you were away overwrites whatever anybody else did to exactly those registers
 * in the meantime. That is obviously right for thirty seconds — nobody has looked at your corner of the
 * mountain yet — and obviously wrong for an hour, where it silently undoes an afternoon. Ninety seconds is the
 * server's presence TTL: past it the room has already swept this session out of presence and told everybody
 * you left, so replaying blind would be a participant the room has stopped expecting reaching back in. One
 * number for both means there is one threshold rather than two that can disagree, and it comfortably covers
 * every ordinary interruption — a Wi-Fi handover, a lid closed for a moment, a service restart — since the
 * reconnect backoff itself tops out at fifteen seconds and three failed attempts still fit inside it.
 */
export const REPLAY_THRESHOLD_MS = 90_000;

/**
 * How long geometry this tab has just written goes on counting as geometry it is working on.
 *
 * This is what awareness draws a participant's live edit from, so it has to outlast the gap between two faces
 * of a paint stroke and two frames of a drag — one coalescing tick, 40 ms — with enough margin that a hand
 * pausing to aim does not blink out from under everybody else's cursor, and it has to be short enough that
 * the marks clear when the hand stops rather than a beat later. Half a second is both, and it is roughly how
 * long a person reads as "still doing that".
 */
export const EDITING_MS = 600;

/** Where this tab's changes have got to. One chip carries this beside the save state; the mesh is never
 *  decorated with it (docs/039). */
export interface SyncStatus {
  /** Everything this tab has changed is in the room's document. */
  landed: boolean;
  /** Assignments sent and not yet acknowledged. */
  inFlight: number;
  /** Registers changed while the channel was down, waiting on a decision. */
  held: number;
  connected: boolean;
}

/** What a disconnection long enough to matter left behind, in the words a summary is written from. */
export interface Reconciliation {
  awayMs: number;
  /** The registers this tab changed while it was away, with the values a replay would re-assert. */
  changes: RegisterAssignment[];
  /** Which of those the room has changed underneath — the ones a replay would overwrite. */
  contested: RegisterKey[];
}

/** One step of this participant's own history: what it changed, and what those registers held before. */
export interface RegisterStep {
  /** The registers as they were — what undo re-asserts. */
  priors: RegisterAssignment[];
  /** The registers as this step left them — what redo re-asserts. */
  afters: RegisterAssignment[];
}

const clone = <T>(value: T): T =>
  value === undefined || value === null || typeof value !== 'object' ? value
    : JSON.parse(JSON.stringify(value)) as T;

/**
 * Whether two register values are the same value.
 *
 * Numbers compare through the canonical text rather than by bits, for the reason the canonical form exists:
 * the same authored position reached by a drag, an undo and a nudge differs from itself in the last bit or
 * two, and a difference nobody made is not a change worth sending. Everything else is structural, and the
 * identity check in front of it is what makes a pass over a mountain's registers cost almost nothing when one
 * corner moved.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return canonicalNumber(a) === canonicalNumber(b);
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, at) => sameValue(item, b[at]));
  }
  const one = a as Record<string, unknown>, two = b as Record<string, unknown>;
  const keys = Object.keys(one).filter(key => one[key] !== undefined);
  const others = Object.keys(two).filter(key => two[key] !== undefined);
  return keys.length === others.length && keys.every(key => sameValue(one[key], two[key]));
}

/** The parts of a document the register model does not own, held by reference. */
interface Structure {
  vertexIds: string[];
  quadIds: string[];
  quads: EditDoc['quads'];
  freeEdges: EditDoc['freeEdges'];
  tJunctions: EditDoc['tJunctions'];
  nextId: number;
  tombstones: EditDoc['tombstones'];
}

const structureOf = (doc: EditDoc): Structure => ({
  vertexIds: doc.vertexIds, quadIds: doc.quadIds, quads: doc.quads,
  freeEdges: doc.freeEdges, tJunctions: doc.tJunctions, nextId: doc.nextId, tombstones: doc.tombstones,
});

/** What the room held when this replica last agreed with it: a structure and every register's value. Enough to
 *  rebuild that document whole, which is what a lost claim and a lost race rewind to. */
interface RoomBase {
  structure: Structure;
  shadow: Map<RegisterKey, RegisterValue>;
}

const sameList = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined,
  each: (one: T, two: T) => boolean): boolean =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((item, at) => each(item, b![at]));

/** Whether two structures hold the same MESH: which vertices and quads exist, how the quads are wired, the
 *  free edges between them, and the counter the next id is minted from. This is the whole of what a claim can
 *  be about — everything geometry can be created out of, consumed from, or rewired within. */
const sameMesh = (a: Structure, b: Structure): boolean =>
  a.nextId === b.nextId
  && sameList(a.vertexIds, b.vertexIds, (one, two) => one === two)
  && sameList(a.quadIds, b.quadIds, (one, two) => one === two)
  && sameList(a.quads, b.quads, (one, two) => sameList(one, two, (x, y) => x === y))
  && sameList(a.freeEdges, b.freeEdges, (one, two) => one[0] === two[0] && one[1] === two[1]);

/** Whether the T-node records match. Held apart from the mesh above because they are DERIVED: every replica
 *  re-seats them from the geometry it already holds (`core/mesh/t-junctions.ts`), so a difference here on its
 *  own is bookkeeping rather than an operation anybody has to be told about. */
const sameTNodes = (a: Structure, b: Structure): boolean =>
  sameList(a.tJunctions, b.tJunctions, (one, two) =>
    one.vertex === two.vertex && one.t === two.t && one.edge[0] === two.edge[0] && one.edge[1] === two.edge[1]);

/**
 * Whether the document still holds the structure this replica last took as the room's.
 *
 * Every mesh operation hands back fresh arrays, so the identity check is what answers a real topology edit
 * immediately and costs nothing on the frames where nothing structural happened. It is a FAST PATH rather
 * than the whole answer: a rebuild that re-derives one of these arrays without changing what it holds swaps a
 * reference the mesh never moved, and believing that would spend a whole-document round trip on an edit that
 * moved one face. So a mismatch is confirmed against the contents before it is acted on, and only a mismatch
 * ever pays for the walk.
 */
const sameStructure = (a: Structure, b: Structure): boolean =>
  (a.vertexIds === b.vertexIds && a.quadIds === b.quadIds && a.quads === b.quads
    && a.freeEdges === b.freeEdges && a.tJunctions === b.tJunctions && a.nextId === b.nextId)
  || (sameMesh(a, b) && sameTNodes(a, b));

/**
 * Which ids a topology edit consumes — the set a claim compares against.
 *
 * It is the geometry the operation took away or rewired, not the geometry it made: an id this build mints is
 * globally unique, so nobody else's claim can name one. What can collide is what was already there. Every id
 * the mesh has lost, every quad whose corners are no longer the same four, and the corners of any such quad on
 * both sides — because inserting a vertex along an edge is exactly what two people subdividing neighbouring
 * quads would each do to the edge they share, and a set naming only the quads would let both of them win.
 */
export function topologyClaimIds(before: Structure, after: Structure): string[] {
  const ids = new Set<string>();
  const heldVertices = new Set(after.vertexIds);
  const heldQuads = new Set(after.quadIds);
  for (const id of before.vertexIds) if (!heldVertices.has(id)) ids.add(id);
  for (const id of before.quadIds) if (!heldQuads.has(id)) ids.add(id);

  const shapes = (side: Structure): Map<string, string> => {
    const out = new Map<string, string>();
    side.quadIds.forEach((id, at) => {
      const quad = side.quads[at];
      out.set(id, quad ? quad.map(corner => side.vertexIds[corner] ?? '?').join(',') : '');
    });
    return out;
  };
  const was = shapes(before), now = shapes(after);
  const corners = (side: Structure, id: string): void => {
    ids.add(id);
    const at = side.quadIds.indexOf(id);
    for (const corner of side.quads[at] ?? []) {
      const named = side.vertexIds[corner];
      if (named) ids.add(named);
    }
  };
  for (const [id, shape] of was) {
    // Rewired, or gone: both leave the corners it held contested, because they are what a neighbouring
    // operation would attach to.
    if (!now.has(id) || now.get(id) !== shape) corners(before, id);
  }
  for (const [id, shape] of now) if (was.has(id) && was.get(id) !== shape) corners(after, id);
  return [...ids];
}

export function createRegisterSync(deps: {
  /** The live document this replica edits. */
  getDoc: () => EditDoc;
  /** Replace it, after a topology push or a resync. The host renders what it is handed. */
  setDoc: (doc: EditDoc) => void;
  channel: RegisterTransport;
  /** The document changed underneath, so whatever renders it should: registers written in place, a document
   *  replaced whole, or somebody else's topology applied to it — the last keeps register undo (docs/039). */
  onApplied?: (what: 'registers' | 'document' | 'topology') => void;
  onStatus?: (status: SyncStatus) => void;
  /** Somebody else overrode a register this tab had touched — the one place per-element indication earns its
   *  place, where the element flashes in their colour (docs/039). */
  onOverride?: (keys: RegisterKey[], by: string) => void;
  /** This tab's topology edit lost — its claim was refused, or somebody else's was sequenced before it was
   *  claimed. Called once; ordinary remote edits and duplicate acknowledgements stay quiet. */
  onTopologyRejected?: () => void;
  /** A disconnection long enough that replaying blind would be wrong. Nothing is replayed until the host
   *  answers with `replayHeld` or `discardHeld`. */
  onReconcile?: (summary: Reconciliation) => void;
  now?: () => number;
}) {
  const clockNow = deps.now ?? (() => Date.now());
  /**
   * What this replica believes the room holds, register by register.
   *
   * Values are copies, so an object the document mutates in place still shows up as a change. And a register
   * holding NOTHING is held as the ABSENCE of its key, which is how `documentRegisters` states the same fact —
   * an unpainted face and a deleted prop are omitted from the decomposition rather than listed as holding
   * undefined. The two have to say it the same way, because the comparison below is between them: a key one
   * side carries and the other does not is a difference every tick would find, and re-sending it would restore
   * it, so the pair would never settle. `remember` is the only way in, which is what keeps that true.
   */
  let shadow = new Map<RegisterKey, RegisterValue>();
  let structure: Structure = structureOf(deps.getDoc());
  let dirty = false;
  /**
   * Whether this document is shared at all.
   *
   * A tab that has never joined a room — the editor talking to no service, or one following read-only — never
   * compares anything: the tick returns before it touches the document, so editing alone costs exactly what it
   * always did. It stays true across a disconnection, because that is precisely when changes must go on being
   * collected so they can be held.
   */
  let active = false;
  let connected = false;
  let awayAt = 0;
  /**
   * The name of the count this replica numbers its batches by, and the count.
   *
   * The count starts again at every page load, and the tab id outlives a reload and is copied into a duplicated
   * tab. So the room is told this name rather than the tab id when it remembers how far it got with the batches
   * (`caughtUp`). Otherwise a reloaded page's batch 3 would read as landed because the page before it got to 500.
   */
  const replica = `replica-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  let batches = 0;
  /** Batches sent and not yet acknowledged, with the assignments each carried, oldest first — the values too,
   *  because a relayed object replaced whole gets them back on top, and a whole document that arrives meanwhile
   *  was produced before they landed and has them written back onto it. */
  const inFlight = new Map<number, RegisterAssignment[]>();
  /** The last relayed value skipped for each register this replica had in flight, kept in case the room
   *  refuses this replica's write — then the relayed value is what the room holds after all. */
  const skipped = new Map<RegisterKey, RegisterValue>();
  /** Registers changed while the channel was down. Coalesced by key, because the last value is the only one
   *  worth replaying. */
  const holding = new Map<RegisterKey, RegisterValue>();
  /** For held registers whose batch went out and was never acknowledged: the batch the held value went out in.
   *  The room may have landed it and lost only the acknowledgement, which `caughtUp` finds out. A register held
   *  for a change never sent is not in here, because nothing the room says can account for that one. */
  const heldBatches = new Map<RegisterKey, number>();
  /** What the room held for each of those when this tab took it away, so a summary can say which are
   *  contested. */
  let holdingFrom = new Map<RegisterKey, RegisterValue>();
  /** Registers this tab has changed, so somebody else changing one of them is worth pointing at. */
  const touchedKeys = new Set<RegisterKey>();
  /** The objects some field of which this tab changed, so an object arriving whole can be told from them at
   *  once rather than by walking every key this tab has touched. */
  const touchedObjects = new Set<RegisterKey>();
  /** Mesh geometry this tab has just written, and when — what awareness says it is working on. Corners and
   *  faces are held apart because the room is told them apart. */
  const editingVertices = new Map<string, number>();
  const editingQuads = new Map<string, number>();
  /**
   * An outstanding topology claim. While one is out nothing else is sent, because everything else would be
   * built on a structure that may not survive. It keeps what the room held when it was made, so losing can
   * rebuild that and replay what was sequenced since; the structure it claimed, so edits made meanwhile are
   * kept only if nothing structural moved under them; and the registers it carried, which are in flight.
   */
  let claiming: {
    batch: number;
    base: RoomBase;
    claimed: Structure;
    carried: RegisterAssignment[];
    /** A whole document was adopted from outside the register path meanwhile, so the answer can no longer be
     *  applied to what this replica holds and the claim is settled with the document instead. */
    superseded?: boolean;
  } | null = null;
  /** Waiting on the whole document after a topology step failed to apply. Nothing is sent meanwhile. */
  let resyncing = false;
  /** The step being accumulated, and whether steps are being recorded at all. */
  let step: { priors: Map<RegisterKey, RegisterValue>; afters: Map<RegisterKey, RegisterValue> } | null = null;
  let recording = true;
  let lastChangeAt = 0;
  let checkedAt = 0;
  let digest: DocumentDigest | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const status = (): SyncStatus => ({
    landed: !inFlight.size && !holding.size && !dirty && !claiming && !resyncing,
    inFlight: [...inFlight.values()].reduce((sum, changes) => sum + changes.length, 0),
    held: holding.size,
    connected,
  });
  const report = () => deps.onStatus?.(status());

  /**
   * This replica now believes the room holds this value for this register.
   *
   * The shadow is keyed by whole register, as the document decomposes, so one FIELD of an object (docs/039)
   * is remembered by updating the object it belongs to — a copy, so no earlier value handed out is changed
   * under its holder. A field of an object the shadow does not hold has nothing to update: the room only
   * assigns fields of objects it holds, so this replica has removed the object and is about to say so.
   */
  function remember(key: RegisterKey, value: RegisterValue): void {
    const field = objectFieldOf(key);
    if (field) {
      const held = shadow.get(field.object) as Record<string, unknown> | undefined;
      if (!held) return;
      const next = { ...held };
      if (value === undefined) delete next[field.field]; else next[field.field] = clone(value);
      shadow.set(field.object, next);
      return;
    }
    if (value === undefined) shadow.delete(key); else shadow.set(key, clone(value));
  }

  /** Whether an arriving key replaces something this tab changed: the same register, the object a field of
   *  which this tab changed, or a field of an object this tab assigned whole. Another field of the same object
   *  is not an override — that is the edit field assignment exists to let stand. */
  function overrides(key: RegisterKey): boolean {
    if (touchedKeys.has(key)) return true;
    const field = objectFieldOf(key);
    return field ? touchedKeys.has(field.object) : touchedObjects.has(key);
  }

  /** Every write of this tab's the room has not acknowledged: its unacknowledged batches, oldest first, then
   *  the registers an outstanding topology claim carries. */
  function pendingWrites(): Map<RegisterKey, RegisterValue> {
    const pending = new Map<RegisterKey, RegisterValue>();
    for (const sent of inFlight.values()) for (const [key, value] of sent) pending.set(key, value);
    if (claiming) for (const [key, value] of claiming.carried) pending.set(key, value);
    return pending;
  }

  /**
   * Absorb values the room sequenced before this tab's unacknowledged writes (`applySync` says why), keeping
   * what those writes carry: a register this tab has in flight keeps this tab's value, and an object replaced
   * whole gets this tab's in-flight fields back on top of it. What is skipped is remembered, in case the room
   * refuses the write that superseded it. Hands back what was actually written.
   */
  function absorbArriving(changes: readonly RegisterAssignment[], doc = deps.getDoc()): readonly RegisterAssignment[] {
    const pending = pendingWrites();
    if (!pending.size) { absorb(changes, doc); return changes; }
    const arriving = changes.filter(([key, value]) => {
      if (!inFlightCovers(pending, key)) return true;
      skipped.set(key, value);
      return false;
    });
    absorb(arriving, doc);
    const replaced = new Set(arriving.map(([key]) => key));
    const restored = [...pending].filter(([key]) => {
      const field = objectFieldOf(key);
      return !!field && replaced.has(field.object);
    });
    if (restored.length) absorb(restored, doc);
    return arriving;
  }

  /** Whether this tab has a write in flight that the room will land after an arriving key: the same register,
   *  or the whole object an arriving field belongs to. */
  function inFlightCovers(pending: ReadonlyMap<RegisterKey, RegisterValue>, key: RegisterKey): boolean {
    if (pending.has(key)) return true;
    const field = objectFieldOf(key);
    return !!field && pending.has(field.object);
  }

  /** What this replica believes the room holds for a key, whether it names a whole register or one field. */
  function shadowRead(key: RegisterKey): RegisterValue {
    const field = objectFieldOf(key);
    if (!field) return shadow.get(key);
    return (shadow.get(field.object) as Record<string, unknown> | undefined)?.[field.field];
  }

  /**
   * Write a set of assignments onto the document and remember exactly what it took.
   *
   * Every arrival goes through here — somebody else's registers, what a reconnection missed, the repair for a
   * divergent section — because what the room holds and what the document holds are the same statement, and a
   * key the document could not take is not part of it. A key naming geometry this replica has already lost
   * writes nothing and is remembered as nothing, so a late edit for deleted geometry cannot leave a name
   * standing that the document has no way to answer for.
   *
   * A field is the exception. The room landed it on an object it holds, so it is remembered whatever this
   * document did with it: if this replica has deleted the object without saying so yet, the deletion is still
   * found and sent, and if it has not, the shadow goes on describing the room.
   */
  function absorb(changes: readonly RegisterAssignment[], doc = deps.getDoc()): void {
    for (const [key, value] of changes) {
      const landed = writeRegister(doc, key, value) === 'landed';
      if (landed || objectFieldOf(key)) remember(key, value); else shadow.delete(key);
    }
  }

  /**
   * The room answered for some writes of this replica's: forget what was skipped for registers no longer in
   * flight, and where the room REFUSED this replica's write, put back the relayed values it skipped — that is
   * what the room holds after all. A refused whole object releases the fields of it that were skipped too.
   */
  function settleSkipped(keys: Iterable<RegisterKey>, refused: readonly RegisterKey[]): void {
    if (!skipped.size) return;
    const pending = pendingWrites();
    const settled = (key: RegisterKey): boolean => !inFlightCovers(pending, key);
    const refusedKeys = new Set(refused);
    const restored = [...skipped].filter(([key]) => settled(key)
      && (refusedKeys.has(key) || refusedKeys.has(objectFieldOf(key)?.object ?? '')));
    const answered = new Set([...keys, ...refused]);
    for (const key of [...skipped.keys()]) {
      if (settled(key) && (answered.has(key) || answered.has(objectFieldOf(key)?.object ?? ''))) skipped.delete(key);
    }
    if (!restored.length) return;
    absorb(restored);
    // The refused write was in flight when an outstanding claim took its base, so that base believed the room
    // held it. It did not; a lost claim rebuilding from that base must not put it back.
    if (claiming) {
      for (const [key, value] of restored) {
        if (value === undefined) claiming.base.shadow.delete(key); else claiming.base.shadow.set(key, clone(value));
      }
    }
    digest = null;
    deps.onApplied?.('registers');
  }

  /** Write the batches still in flight back onto a document the room produced before they landed. */
  function reassertInFlight(): void {
    for (const changes of inFlight.values()) absorb(changes);
  }

  /** Rebuild the shadow from a document: this replica now believes the room holds exactly this. */
  function rebase(doc: EditDoc): void {
    shadow = new Map();
    for (const [key, value] of documentRegisters(doc)) remember(key, value);
    structure = structureOf(doc);
    digest = null;
    dirty = false;
  }

  /** Take a document as the whole truth, replacing whatever this replica held. */
  function adopt(doc: EditDoc): void {
    deps.setDoc(doc);
    rebase(doc);
  }

  /**
   * Take a whole document from the room — a repair, a catch-up, a refusal. Broadcasts, rejected claims and
   * drift repairs can carry the same snapshot, so compare the LIVE document, not the shadow (which may predate
   * an unsent edit), before replacing the editor's objects. A batch still in flight when it arrives landed
   * after the room produced it, so it is written back on top.
   */
  function adoptChanged(doc: EditDoc): boolean {
    resyncing = false;
    if (digestDocument(deps.getDoc(), textHash).root === digestDocument(doc, textHash).root) {
      rebase(deps.getDoc());
      return false;
    }
    adopt(doc);
    reassertInFlight();
    return true;
  }

  /** Install a document this replica built from the room's own changes as the live one. */
  function install(doc: EditDoc): void {
    deps.setDoc(doc);
    structure = structureOf(doc);
    digest = null;
  }

  /** Ask for the whole document: a topology step did not land on this replica's structure, which is drift. */
  function resync(): void {
    resyncing = true;
    if (connected) deps.channel.fetchSections([TOPOLOGY_SECTION]);
  }

  /**
   * The document the room held at `base`, rebuilt whole: its structure, and every register at the value this
   * replica believed it held. Values are copied in, because the shadow must never share an object the editor
   * will go on to edit in place.
   */
  function rewound(base: RoomBase): EditDoc {
    const s = base.structure;
    const shell = registerShell({
      ...deps.getDoc(), vertexIds: s.vertexIds, quadIds: s.quadIds, quads: s.quads, freeEdges: s.freeEdges,
      tJunctions: s.tJunctions, nextId: s.nextId, tombstones: s.tombstones,
      vertices: new Array<number>(s.vertexIds.length * 3).fill(0),
    });
    applyRegisters(shell, [...base.shadow].map(([key, value]) => [key, clone(value)] as const));
    return shell;
  }

  /** One topology step onto a document, producing a new one, with the shadow following what the delta removed
   *  and placed. Null when it does not land — this replica's base is not the one it was written against. */
  function landDelta(doc: EditDoc, delta: TopologyDelta | undefined, changes: readonly RegisterAssignment[],
    relayed: boolean): EditDoc | null {
    const applied = applyTopologyDelta(doc, delta);
    if (!applied.ok) return null;
    for (const key of applied.applied.cleared) shadow.delete(key);
    for (const [key, value] of applied.applied.placed) remember(key, value);
    if (relayed) absorbArriving(changes, applied.applied.doc); else absorb(changes, applied.applied.doc);
    return applied.applied.doc;
  }

  /** Steps the room sequenced, in order, onto a document that nobody else holds. */
  function landSteps(doc: EditDoc, steps: readonly SyncStep[], relayed: boolean): EditDoc | null {
    let held: EditDoc | null = doc;
    for (const step of steps) {
      if (step.delta) held = landDelta(held, step.delta, step.changes, relayed);
      else if (relayed) absorbArriving(step.changes, held); else absorb(step.changes, held);
      if (!held) return null;
    }
    return held;
  }

  /**
   * What the room sequenced — a relay, or a reconnection's catch-up — onto the live document.
   *
   * Assignments alone are written in place, as they always were. A topology step is applied to a copy so the
   * editor can still compare the document it had with the one it has now. A local topology edit this replica
   * had not claimed yet was sequenced after the arrival, so it lost: the replica rewinds to what the room held
   * and applies the arrival there, and says so. Its register edits from the same tick go with it, because they
   * cannot be told apart from what the operation produced.
   */
  function landRoomSteps(steps: readonly SyncStep[]): void {
    const doc = deps.getDoc();
    if (!steps.some(step => step.delta)) {
      const changes = steps.flatMap(step => step.changes);
      if (!changes.length) return;
      absorbArriving(changes, doc);
      digest = null;
      deps.onApplied?.('registers');
      return;
    }
    const unclaimed = !sameMesh(structure, structureOf(doc));
    const from = unclaimed ? rewound({ structure, shadow }) : steps[0].delta ? doc : detachedDocument(doc);
    const landed = landSteps(from, steps, true);
    if (!landed) { resync(); return; }
    install(landed);
    if (unclaimed) step = null;
    deps.onApplied?.('topology');
    if (unclaimed) deps.onTopologyRejected?.();
  }

  /** The registers that differ from what the room holds, with what they held before — the whole of an
   *  ordinary edit, read off the document rather than described by the tool that made it. */
  function differences(): { changes: RegisterAssignment[]; priors: RegisterValue[] } {
    const registers = documentRegisters(deps.getDoc());
    const changes: RegisterAssignment[] = [];
    const priors: RegisterValue[] = [];
    // The shadow never holds undefined — `remember` deletes instead — so one lookup answers both "does the room
    // hold this register" and "with what". Counting the registers it does hold is what lets the deletion pass
    // below be skipped: the decomposition's keys are distinct, so when every shadow key was met there, none of
    // them can be missing from it.
    let held = 0;
    for (const [key, value] of registers) {
      const prior = shadow.get(key);
      if (prior !== undefined) {
        held++;
        if (sameValue(prior, value)) continue;
        // An object the room already holds is edited by the fields that changed, so somebody else's edit to
        // another field of it stands (docs/039). One it does not hold yet travels whole: that is a creation.
        const fields = objectFieldChanges(key, prior, value, sameValue);
        if (fields) {
          for (const [field, now, was] of fields) {
            changes.push([field, clone(now)]);
            priors.push(clone(was));
          }
          continue;
        }
      }
      changes.push([key, clone(value)]);
      priors.push(clone(prior));
    }
    if (held === shadow.size) return { changes, priors };
    for (const key of shadow.keys()) {
      if (registers.has(key)) continue;
      // A register the document no longer holds is cleared rather than left standing: an unpainted face and a
      // deleted prop are both "this register now holds nothing".
      changes.push([key, undefined]);
      priors.push(clone(shadow.get(key)));
    }
    return { changes, priors };
  }

  /** The same, taken: the difference is what goes to the room, so the shadow now says the room holds it. */
  function collect(): { changes: RegisterAssignment[]; priors: RegisterValue[] } {
    const found = differences();
    for (const [key, value] of found.changes) remember(key, value);
    return found;
  }

  function record(changes: RegisterAssignment[], priors: RegisterValue[]): void {
    if (!recording || !changes.length) return;
    step ??= { priors: new Map(), afters: new Map() };
    changes.forEach(([key, value], at) => {
      // The first prior seen for a key in a step is the one undo puts back: a step is one gesture, and what a
      // register held before the gesture is where the gesture started.
      if (!step!.priors.has(key)) step!.priors.set(key, priors[at]);
      step!.afters.set(key, value);
    });
  }

  /** Hold a change this tab has not sent. It is newer than whatever batch the register was held from before, so
   *  that batch no longer says anything about it. */
  function hold(key: RegisterKey, value: RegisterValue): void {
    holding.set(key, value);
    heldBatches.delete(key);
  }

  function release(): void {
    holding.clear();
    heldBatches.clear();
    holdingFrom = new Map();
  }

  function sendAssignments(changes: RegisterAssignment[]): void {
    const batch = ++batches;
    if (deps.channel.assign(changes, batch)) inFlight.set(batch, changes);
    else for (const [key, value] of changes) hold(key, value);
  }

  /** Remember the geometry a key this tab just wrote stands on, so awareness can say what it is working on. */
  function noteEditing(key: RegisterKey): void {
    const at = clockNow(), named = registerGeometry(key);
    for (const id of named.vertices) editingVertices.set(id, at);
    for (const id of named.quads) editingQuads.set(id, at);
  }

  /** The ids still fresh enough to report, forgetting the rest on the way past. */
  function stillEditing(held: Map<string, number>, at: number): string[] {
    const live: string[] = [];
    for (const [id, when] of held) {
      if (at - when <= EDITING_MS) live.push(id); else held.delete(id);
    }
    return live;
  }

  /**
   * A topology edit: claim the ids it consumed, having already applied it locally.
   *
   * What travels is the delta from the structure the room holds to the one this document has, and the register
   * difference the tick would have sent anyway — less what the delta already says: the positions of the
   * vertices it writes, and clears of registers naming geometry it removed. Whatever this replica had not yet
   * sent is in that difference, and so is everything the operation produced in registers.
   */
  function claimTopology(ids: string[]): void {
    const doc = deps.getDoc();
    const base: RoomBase = { structure, shadow: new Map(shadow) };
    const { changes } = collect();
    const delta = topologyDelta(structure, doc);
    const written = new Set(delta.vertices.flatMap(run => typeof run[0] === 'string' ? [vertexRegister(run[0])] : []));
    const vertexAt = nameIndex(doc.vertexIds), quadAt = nameIndex(doc.quadIds);
    const carried = changes.filter(([key, value]) => {
      if (written.has(key)) return false;
      if (value !== undefined) return true;
      // A clear naming an id the delta removed is already said by the delta. One naming only surviving ids — a
      // crease whose edge went while both its corners stayed — has to travel.
      const named = registerGeometry(key);
      return named.vertices.every(id => vertexAt.has(id)) && named.quads.every(id => quadAt.has(id));
    });
    structure = structureOf(doc);
    digest = null;
    const batch = ++batches;
    claiming = { batch, base, claimed: structure, carried };
    // Either way the local document stands: this replica applies at once and reverts only if it lost.
    if (!deps.channel.claim(ids, delta, carried, batch)) claiming = null;
    report();
  }

  /**
   * This replica's claim lost. The room handed back what it sequenced since the claim's base, so the base is
   * rebuilt and those steps replayed onto it; or the room's whole document, when the log could not say it.
   *
   * Register edits made while the claim was out were held back by the tick, so they are exactly what the
   * document holds that the shadow does not, and they are put back onto the result — unless the structure moved
   * after the claim, when they belong to an operation the rebuild has discarded and would half-apply it.
   */
  function lose(answer: ClaimOutcome, base: RoomBase, claimed: Structure): void {
    const doc = deps.getDoc();
    const later = answer.steps && sameMesh(claimed, structureOf(doc)) ? differences().changes : [];
    let changed: 'topology' | 'document' | null = null;
    if (answer.steps) {
      const from = rewound(base);
      shadow = base.shadow;
      structure = base.structure;
      const landed = landSteps(from, answer.steps, false);
      if (landed) {
        applyRegisters(landed, later);
        install(landed);
        if (later.length) dirty = true;
        changed = 'topology';
      } else resync();
    } else if (answer.document && adoptChanged(answer.document)) changed = 'document';
    step = null;
    if (changed) deps.onApplied?.(changed);
    // Edits put back onto the rebuilt document go out first: a drift check taken over them now would find them
    // missing from the room and repair them away before they were ever sent.
    if (later.length && !resyncing) tick();
    else {
      lastChangeAt = 0;
      checkedAt = 0;
      maybeCheckDrift();
    }
    deps.onTopologyRejected?.();
  }

  /** Ask the room what it hashes to, once this replica has been idle long enough to be worth checking. */
  function maybeCheckDrift(): void {
    if (!connected || claiming || resyncing || inFlight.size || holding.size) return;
    const at = clockNow();
    if (at - lastChangeAt < IDLE_CHECK_MS || at - checkedAt < IDLE_CHECK_MS) return;
    checkedAt = at;
    deps.channel.checkDrift(digestNow());
  }

  const digestNow = (): DocumentDigest => (digest ??= digestDocument(deps.getDoc(), textHash));

  /** One coalescing tick. */
  function tick(): void {
    if (!active || claiming || resyncing) return;
    const shape = structureOf(deps.getDoc());
    if (!sameStructure(structure, shape)) {
      const ids = topologyClaimIds(structure, shape);
      // A claim naming nothing, over a mesh nothing was added to or taken from, claims nothing: no id changed
      // hands, so there is no race to compare-and-swap and no geometry a delta would carry that an assignment
      // cannot. What is left is the derived T-node bookkeeping, which every replica works out for itself. Take
      // the new structure as the baseline and let the edit go as the ordinary one it is.
      if (!ids.length && sameMesh(structure, shape)) structure = shape;
      // A claim waits for the decision about held changes, so it can never leave them out of the room.
      else if (connected && holding.size) return;
      else {
        dirty = false;
        lastChangeAt = clockNow();
        claimTopology(ids);
        return;
      }
    }
    if (!dirty) { maybeCheckDrift(); return; }
    dirty = false;
    const { changes, priors } = collect();
    if (!changes.length) { maybeCheckDrift(); return; }
    lastChangeAt = clockNow();
    record(changes, priors);
    for (const [key] of changes) {
      touchedKeys.add(key);
      const field = objectFieldOf(key);
      if (field) touchedObjects.add(field.object);
      noteEditing(key);
    }
    digest = null;
    if (!connected) {
      changes.forEach(([key, value], at) => {
        if (!holding.has(key)) holdingFrom.set(key, priors[at]);
        hold(key, value);
      });
      report();
      return;
    }
    sendAssignments(changes);
    report();
  }

  /** Put the held changes back, as a fresh assignment like any other. */
  function replayHeld(): void {
    const changes = [...holding].map(([key, value]) => [key, value] as RegisterAssignment);
    release();
    awayAt = 0;
    if (!changes.length) { report(); return; }
    absorb(changes);
    sendAssignments(changes);
    deps.onApplied?.('registers');
    report();
  }

  function discardHeld(): void {
    release();
    awayAt = 0;
    report();
  }

  rebase(deps.getDoc());

  return {
    /** Start comparing. The interval is the only timer this module owns. */
    start(): void {
      if (ticker) return;
      ticker = setInterval(tick, COALESCE_MS);
      (ticker as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (ticker) clearInterval(ticker);
      ticker = null;
    },
    /** The render funnel says the document changed. */
    noteEdit(): void { dirty = true; },
    /** Compare and send right now — what a flush before a switch wants, and what a test drives. */
    flush(): void { tick(); },
    /** This replica now holds exactly this document and owes the room nothing. */
    adopt(doc: EditDoc): void {
      adopt(doc);
      // An outstanding claim's answer is about the document this replaced, so it settles with the room's.
      if (claiming) claiming.superseded = true;
      resyncing = false;
      step = null;
      touchedKeys.clear();
      touchedObjects.clear();
      // The names came off a document this replica no longer holds, so nothing is being worked on until
      // something is written to this one.
      editingVertices.clear();
      editingQuads.clear();
      report();
    },
    /** The channel is up, and this document is one the room holds. */
    connect(): void {
      active = true;
      connected = true;
      // A resync asked before this room was open — just after a project switch — went unanswered.
      if (resyncing) deps.channel.fetchSections([TOPOLOGY_SECTION]);
      report();
    },
    /** This document is not shared: a project nobody else has open, or one this tab follows read-only. */
    detach(): void {
      active = false;
      connected = false;
      claiming = null;
      resyncing = false;
      release();
      inFlight.clear();
      skipped.clear();
      report();
    },
    /** The channel went down. Changes go on being collected — they are simply held. */
    disconnect(): void {
      if (connected) awayAt = clockNow();
      connected = false;
      // Anything in flight was never acknowledged, so it is held rather than assumed to have landed, together
      // with the last batch that carried it, because the room may have landed that batch and lost only the
      // acknowledgement. A register already held keeps its value and where it came from.
      const fromFlight = new Set<RegisterKey>();
      for (const [batch, sent] of inFlight) {
        for (const [key] of sent) {
          if (holding.has(key) && !fromFlight.has(key)) continue;
          fromFlight.add(key);
          holding.set(key, shadowRead(key));
          heldBatches.set(key, batch);
        }
      }
      inFlight.clear();
      skipped.clear();
      report();
    },

    // ---- what arrives ----

    /**
     * Somebody else's registers. Absolute, so they are written — except where this tab's own write to the same
     * register will land AFTER them.
     *
     * The room acknowledges a batch on the same socket, in the same order, as it relays everybody else's: a
     * relay that arrives while one of this tab's batches is still unacknowledged was sequenced BEFORE that
     * batch, so the room is about to hold this tab's value, not the one arriving. Writing it would leave this
     * replica holding a value the room has already replaced — divergence until the drift check repaired it.
     * So a register this tab has in flight keeps this tab's value, and an object replaced whole keeps the
     * fields this tab has in flight on top of it, exactly as the room will. What this tab has changed and not
     * yet sent is sent first, which puts it in flight, so a local edit is never overwritten by an older one.
     */
    applySync(changes: readonly RegisterAssignment[], by: string): void {
      if (dirty) tick();
      const arriving = absorbArriving(changes);
      digest = null;
      const overridden = arriving.map(([key]) => key).filter(overrides);
      if (overridden.length) deps.onOverride?.(overridden, by);
      deps.onApplied?.('registers');
    },
    /**
     * Somebody else's topology: a delta and the registers it carried, applied to the live document so that
     * whatever this replica holds on surviving geometry stays where it is.
     *
     * Ignored while this replica's own claim is out: the room answers on one ordered socket, so this was
     * sequenced first, that claim will lose, and its answer carries this among its steps. Ignored while the whole
     * document is on its way, too. A server on an older core sends the document instead of a delta.
     */
    applyTopology(push: Pick<TopologyPush, 'delta' | 'changes' | 'document'>): void {
      if (claiming || resyncing) return;
      if (push.document) {
        const unsent = collect().changes;
        const changed = adoptChanged(push.document);
        if (unsent.length) {
          absorb(unsent);
          if (connected) sendAssignments(unsent);
          else for (const [key, value] of unsent) hold(key, value);
        }
        if (changed) deps.onApplied?.('document');
      } else landRoomSteps([{ delta: push.delta, changes: push.changes ?? [] }]);
      report();
    },
    /** How a batch of this tab's assignments turned out. Nothing here can have been rejected for losing a race;
     *  a retired key named geometry somebody removed and is dropped without a word. A refused one leaves the
     *  room holding whatever it was relayed instead, which this replica skipped and now puts back. */
    landed(ack: { batch: number; retired?: readonly string[]; refused?: readonly string[] }): void {
      const sent = inFlight.get(ack.batch);
      inFlight.delete(ack.batch);
      settleSkipped((sent ?? []).map(([key]) => key), [...ack.refused ?? [], ...ack.retired ?? []]);
      report();
    },
    /** How this tab's topology claim turned out. */
    claimed(result: ClaimOutcome): void {
      if (!claiming || claiming.batch !== result.batch) return;
      const { base, claimed, carried, superseded } = claiming;
      claiming = null;
      if (superseded) {
        // The document this claim was made on was replaced meanwhile; the room's says how it turned out.
        if (!result.ok) deps.onTopologyRejected?.();
        resync();
      } else if (result.ok) settleSkipped(carried.map(([key]) => key), result.refused ?? []);
      else {
        skipped.clear();
        lose(result, base, claimed);
      }
      report();
    },
    /**
     * What this tab missed while it was away, and the decision about what it did.
     *
     * Under the threshold the held changes are replayed: nobody has had time to build on the registers this
     * tab was holding, and re-asserting them is what "I kept editing" means. Past it they are summarised
     * instead, because replaying blind would silently overwrite however long somebody else has spent on
     * exactly those registers.
     *
     * Neither applies to a batch the room had already landed when the old socket died taking only its
     * acknowledgement. Its value is in what just arrived, along with whatever anybody wrote over it since, and
     * replaying it would undo that later write. `landed` is the highest batch the room had answered from this
     * replica, and a held value that went out at or below it is let go. Whatever is left was never landed, and
     * now that its socket is gone it never will be, so it is held like a change that was never sent.
     *
     * A claim still out when the socket dropped lost its answer with it, and the room may or may not have
     * taken it, so the whole document settles it — asked for after any replay, so it includes the replay.
     */
    caughtUp(missed: {
      steps?: readonly SyncStep[]; changes?: readonly RegisterAssignment[]; document?: EditDoc; landed?: number;
    }): void {
      connected = true;
      const steps: readonly SyncStep[] = missed.steps ?? (missed.changes ? [{ changes: [...missed.changes] }] : []);
      // A claim's answer, or the document a resync asked for, went with the socket. Either way the whole document
      // settles it, and the steps are left to that document rather than applied to a base it is about to replace.
      const unsettled = !!claiming || resyncing;
      claiming = null;
      if (unsettled) resyncing = true;
      if (missed.document) {
        // The room answers with the whole mountain when its log cannot reach back to the sequence this tab named:
        // a tail that has moved on, an outside write, or a sequence from an earlier room on this map. Very often
        // that is the same document this tab already renders. Rebase the replica without replacing the live
        // object in that case: replacing an identical document would make the editor display its full
        // progressive loader again for a mountain that did not change.
        if (adoptChanged(missed.document)) deps.onApplied?.('document');
      } else if (!unsettled) landRoomSteps(steps); // which asks for the document itself if a step fails
      const settle = () => { if (unsettled && resyncing) resync(); };
      const landed = missed.landed ?? 0;
      for (const [key, batch] of heldBatches) {
        if (batch > landed) continue;
        holding.delete(key);
        holdingFrom.delete(key);
      }
      heldBatches.clear();
      if (!holding.size) { awayAt = 0; settle(); report(); return; }
      const awayMs = awayAt ? clockNow() - awayAt : 0;
      if (awayMs <= REPLAY_THRESHOLD_MS) { replayHeld(); settle(); return; }
      const moved = new Set(steps.flatMap(step => step.changes.map(([key]) => key)));
      deps.onReconcile?.({
        awayMs,
        changes: [...holding].map(([key, value]) => [key, value] as RegisterAssignment),
        contested: [...holding.keys()]
          .filter(key => moved.has(key) || !sameValue(holdingFrom.get(key), shadowRead(key))),
      });
      settle();
      report();
    },
    replayHeld,
    discardHeld,

    // ---- drift ----

    /** Check now, whatever the idle timer says — what a reconnection does. */
    checkDrift(): void {
      if (!connected || resyncing) return;
      checkedAt = clockNow();
      deps.channel.checkDrift(digestNow());
    },
    /** The room's digest. Roots first; only a mismatch costs a descent, and only the divergent sections are
     *  refetched. */
    compareDigest(theirs: { root: string; sections: Record<string, string> }): string[] {
      const mine = digestNow();
      if (mine.root === theirs.root) return [];
      const diverged = divergentSections(mine, { root: theirs.root, sections: theirs.sections });
      if (diverged.length) deps.channel.fetchSections(diverged);
      return diverged;
    },
    /** The repair. A divergent section arrives as its registers; a divergent topology arrives as the document,
     *  because the topology section is not register-shaped. A document that arrives while a claim is out is
     *  left alone: the claim's answer settles this replica, and the document predates it. */
    repair(payload: { registers: readonly RegisterAssignment[]; document?: EditDoc }): void {
      if (payload.document) {
        if (claiming) return;
        if (adoptChanged(payload.document)) deps.onApplied?.('document');
        report();
        return;
      }
      if (!payload.registers.length) return;
      // A section is read when the room answers the fetch, so a batch this tab sent after asking lands after
      // it — the same ordering a relay has, and the same rule.
      absorbArriving(payload.registers);
      digest = null;
      deps.onApplied?.('registers');
    },

    // ---- undo, as inverse assignments ----

    /** Close the step being accumulated and hand it over, or nothing when nothing changed. */
    sealStep(): RegisterStep | null {
      const sealed = step;
      step = null;
      if (!sealed?.afters.size) return null;
      return {
        priors: [...sealed.priors].map(([key, value]) => [key, value] as RegisterAssignment),
        afters: [...sealed.afters].map(([key, value]) => [key, value] as RegisterAssignment),
      };
    },
    /**
     * Re-assert a set of values as a fresh change.
     *
     * This is the whole of undo and redo. It is an ordinary write, so it can put back a value somebody else
     * has since changed, and the room resolves it exactly as it resolves any other assignment. It is not
     * recorded as a step of its own — the stack it came from is what remembers it.
     */
    reassert(changes: readonly RegisterAssignment[]): void {
      recording = false;
      applyRegisters(deps.getDoc(), changes);
      dirty = true;
      tick();
      recording = true;
      deps.onApplied?.('registers');
    },
    /** Forget the step in progress — a project switch, or a document replaced whole. */
    resetSteps(): void { step = null; },

    status,
    /** The name the channel gives the room for the count this replica's batches are numbered by. */
    replica,
    /**
     * The mesh this tab is working on right now — what awareness tells the room (`app/net/awareness.ts`).
     *
     * Read off the assignments this replica is sending rather than off any tool or any selection, because the
     * most ordinary edit there is selects nothing at all: a paint stroke drops the paint selection on its
     * first face and then writes tiles. The faces whose registers it just wrote ARE what it is touching, and
     * reading it here covers every tool at once without one of them having to declare anything.
     *
     * `dragging` is the part of that the room has not acknowledged yet — the "hands off for a second" half,
     * and the reason it names faces as readily as corners.
     */
    editing(): { vertices: string[]; quads: string[]; dragging: string[] } {
      const at = clockNow();
      const dragging = new Set<string>();
      for (const sent of inFlight.values()) {
        for (const [key] of sent) {
          const named = registerGeometry(key);
          for (const id of [...named.vertices, ...named.quads]) dragging.add(id);
        }
      }
      return {
        vertices: stillEditing(editingVertices, at),
        quads: stillEditing(editingQuads, at),
        dragging: [...dragging],
      };
    },
    /** This replica's digest, for a caller that wants to compare two documents itself. */
    digest: digestNow,
    /**
     * What this replica would send the room if it were asked right now — and, once everything it has done has
     * been collected and acknowledged, the invariant that it is EMPTY.
     *
     * The shadow says what the room holds and the document's decomposition says what this replica holds, and
     * they have to describe the same registers the same way. When they do not, the difference is one neither
     * side can resolve: it is found on every tick, sent on every tick, and restored by its own echo, so the
     * replica talks for ever about a register nobody touched while both DOCUMENTS agree perfectly — which is
     * exactly the state a hash over documents cannot see. Asserting this is empty at rest is how that is
     * caught, and it costs one pass over the registers, so it is asked for rather than taken continuously.
     */
    pending: (): RegisterAssignment[] => differences().changes,
  };
}

export type RegisterSync = ReturnType<typeof createRegisterSync>;
