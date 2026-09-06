import type { EditDoc } from '../../core/doc/doc-edit';
import { canonicalNumber } from '../../core/doc/canonical';
import { digestDocument, divergentSections, textHash, type DocumentDigest } from '../../core/doc/digest';
import {
  applyRegisters, documentRegisters, registerGeometry, writeRegister, type RegisterKey, type RegisterValue,
} from '../../core/doc/registers';
import type { RegisterAssignment } from './session-channel';

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
 * compare-and-swap the ids the operation consumed, having already applied it locally. Winning costs nothing
 * more; losing hands back the document that won, and this replica goes from its own optimistic geometry
 * straight to the authoritative geometry — one rebuild, never back through the state it started in.
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
  claim(ids: string[], document: EditDoc, batch: number): boolean;
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
}

const structureOf = (doc: EditDoc): Structure => ({
  vertexIds: doc.vertexIds, quadIds: doc.quadIds, quads: doc.quads,
  freeEdges: doc.freeEdges, tJunctions: doc.tJunctions, nextId: doc.nextId,
});

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
  /** The document changed underneath, so whatever renders it should. */
  onApplied?: (what: 'registers' | 'document') => void;
  onStatus?: (status: SyncStatus) => void;
  /** Somebody else overrode a register this tab had touched — the one place per-element indication earns its
   *  place, where the element flashes in their colour (docs/039). */
  onOverride?: (keys: RegisterKey[], by: string) => void;
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
  let batches = 0;
  /** Batches sent and not yet acknowledged, with the keys each carried. */
  const inFlight = new Map<number, RegisterKey[]>();
  /** Registers changed while the channel was down. Coalesced by key, because the last value is the only one
   *  worth replaying. */
  const holding = new Map<RegisterKey, RegisterValue>();
  /** What the room held for each of those when this tab took it away, so a summary can say which are
   *  contested. */
  let holdingFrom = new Map<RegisterKey, RegisterValue>();
  /** Registers this tab has changed, so somebody else changing one of them is worth pointing at. */
  const touchedKeys = new Set<RegisterKey>();
  /** Mesh geometry this tab has just written, and when — what awareness says it is working on. Corners and
   *  faces are held apart because the room is told them apart. */
  const editingVertices = new Map<string, number>();
  const editingQuads = new Map<string, number>();
  /** An outstanding topology claim. While one is out nothing else is sent, because everything else would be
   *  built on a structure that may not survive. */
  let claiming: { batch: number } | null = null;
  /** The step being accumulated, and whether steps are being recorded at all. */
  let step: { priors: Map<RegisterKey, RegisterValue>; afters: Map<RegisterKey, RegisterValue> } | null = null;
  let recording = true;
  let lastChangeAt = 0;
  let checkedAt = 0;
  let digest: DocumentDigest | null = null;
  let ticker: ReturnType<typeof setInterval> | null = null;

  const status = (): SyncStatus => ({
    landed: !inFlight.size && !holding.size && !dirty && !claiming,
    inFlight: [...inFlight.values()].reduce((sum, keys) => sum + keys.length, 0),
    held: holding.size,
    connected,
  });
  const report = () => deps.onStatus?.(status());

  /** This replica now believes the room holds this value for this register. */
  function remember(key: RegisterKey, value: RegisterValue): void {
    if (value === undefined) shadow.delete(key); else shadow.set(key, clone(value));
  }

  /**
   * Write a set of assignments onto the document and remember exactly what it took.
   *
   * Every arrival goes through here — somebody else's registers, what a reconnection missed, the repair for a
   * divergent section — because what the room holds and what the document holds are the same statement, and a
   * key the document could not take is not part of it. A key naming geometry this replica has already lost
   * writes nothing and is remembered as nothing, so a late edit for deleted geometry cannot leave a name
   * standing that the document has no way to answer for.
   */
  function absorb(changes: readonly RegisterAssignment[]): void {
    const doc = deps.getDoc();
    for (const [key, value] of changes) {
      if (writeRegister(doc, key, value) === 'landed') remember(key, value); else shadow.delete(key);
    }
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

  /** The registers that differ from what the room holds, with what they held before — the whole of an
   *  ordinary edit, read off the document rather than described by the tool that made it. */
  function differences(): { changes: RegisterAssignment[]; priors: RegisterValue[] } {
    const registers = documentRegisters(deps.getDoc());
    const changes: RegisterAssignment[] = [];
    const priors: RegisterValue[] = [];
    for (const [key, value] of registers) {
      if (shadow.has(key) && sameValue(shadow.get(key), value)) continue;
      changes.push([key, clone(value)]);
      priors.push(shadow.has(key) ? clone(shadow.get(key)) : undefined);
    }
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

  function sendAssignments(changes: RegisterAssignment[]): void {
    const batch = ++batches;
    if (deps.channel.assign(changes, batch)) inFlight.set(batch, changes.map(([key]) => key));
    else for (const [key, value] of changes) holding.set(key, value);
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

  /** A topology edit: claim the ids it consumed, having already applied it locally. */
  function claimTopology(ids: string[]): void {
    const doc = deps.getDoc();
    const batch = ++batches;
    claiming = { batch };
    // The claim carries the mountain it produced, because topology renumbers and nothing smaller would say
    // what happened. Whatever this replica had not yet sent is already in it.
    if (!deps.channel.claim(ids, clone(doc), batch)) claiming = null;
    // Either way the local document stands: this replica applies at once and reverts only if it lost.
    rebase(doc);
    report();
  }

  /** Ask the room what it hashes to, once this replica has been idle long enough to be worth checking. */
  function maybeCheckDrift(): void {
    if (!connected || claiming || inFlight.size || holding.size) return;
    const at = clockNow();
    if (at - lastChangeAt < IDLE_CHECK_MS || at - checkedAt < IDLE_CHECK_MS) return;
    checkedAt = at;
    deps.channel.checkDrift(digestNow());
  }

  const digestNow = (): DocumentDigest => (digest ??= digestDocument(deps.getDoc(), textHash));

  /** One coalescing tick. */
  function tick(): void {
    if (!active || claiming) return;
    const shape = structureOf(deps.getDoc());
    if (!sameStructure(structure, shape)) {
      const ids = topologyClaimIds(structure, shape);
      // A claim naming nothing, over a mesh nothing was added to or taken from, claims nothing: no id changed
      // hands, so there is no race to compare-and-swap and no geometry a whole document would carry that an
      // assignment cannot. What is left is the derived T-node bookkeeping, which every replica works out for
      // itself. Take the new structure as the baseline and let the edit go as the ordinary one it is.
      if (!ids.length && sameMesh(structure, shape)) structure = shape;
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
    for (const [key] of changes) { touchedKeys.add(key); noteEditing(key); }
    digest = null;
    if (!connected) {
      changes.forEach(([key, value], at) => {
        if (!holding.has(key)) holdingFrom.set(key, priors[at]);
        holding.set(key, value);
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
    holding.clear();
    holdingFrom = new Map();
    awayAt = 0;
    if (!changes.length) { report(); return; }
    absorb(changes);
    sendAssignments(changes);
    deps.onApplied?.('registers');
    report();
  }

  function discardHeld(): void {
    holding.clear();
    holdingFrom = new Map();
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
      step = null;
      touchedKeys.clear();
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
      report();
    },
    /** This document is not shared: a project nobody else has open, or one this tab follows read-only. */
    detach(): void {
      active = false;
      connected = false;
      holding.clear();
      inFlight.clear();
      report();
    },
    /** The channel went down. Changes go on being collected — they are simply held. */
    disconnect(): void {
      if (connected) awayAt = clockNow();
      connected = false;
      // Anything in flight was never acknowledged, so it is held rather than assumed to have landed.
      for (const keys of inFlight.values()) {
        for (const key of keys) if (!holding.has(key)) holding.set(key, shadow.get(key));
      }
      inFlight.clear();
      report();
    },

    // ---- what arrives ----

    /** Somebody else's registers. Absolute, so they are simply written; nothing about them can be refused. */
    applySync(changes: readonly RegisterAssignment[], by: string): void {
      absorb(changes);
      digest = null;
      const overridden = changes.map(([key]) => key).filter(key => touchedKeys.has(key));
      if (overridden.length) deps.onOverride?.(overridden, by);
      deps.onApplied?.('registers');
    },
    /** Somebody else's topology, whole. Whatever this replica had not yet sent is re-asserted onto the new
     *  structure afterwards; anything naming geometry the operation removed retires quietly. */
    applyTopology(document: EditDoc): void {
      const unsent = claiming ? [] : collect().changes;
      adopt(document);
      if (unsent.length) {
        absorb(unsent);
        if (connected) sendAssignments(unsent);
        else for (const [key, value] of unsent) holding.set(key, value);
      }
      deps.onApplied?.('document');
      report();
    },
    /** How a batch of this tab's assignments turned out. Nothing here can have been rejected for losing a
     *  race; a retired key named geometry somebody removed and is dropped without a word. */
    landed(ack: { batch: number }): void {
      inFlight.delete(ack.batch);
      report();
    },
    /** How this tab's topology claim turned out. */
    claimed(result: { batch: number; ok: boolean; document?: EditDoc }): void {
      if (!claiming || claiming.batch !== result.batch) return;
      claiming = null;
      if (!result.ok && result.document) {
        // Lost. The winner's document is already in hand, so this goes from its own optimistic geometry to the
        // authoritative geometry in one step rather than back through the geometry it started with.
        adopt(result.document);
        step = null;
        deps.onApplied?.('document');
        lastChangeAt = 0;
        checkedAt = 0;
        maybeCheckDrift();
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
     */
    caughtUp(missed: { changes: readonly RegisterAssignment[]; document?: EditDoc }): void {
      connected = true;
      if (missed.document) {
        // A fresh page starts its room sequence at zero, so a room whose retained tail begins later answers
        // with the whole mountain. Very often that is the same durable snapshot boot just rendered. Rebase the
        // replica without replacing the live object in that case: replacing an identical document would make
        // the editor display its full progressive loader again for a mountain that did not change.
        const currentRoot = digestDocument(deps.getDoc(), textHash).root;
        const incomingRoot = digestDocument(missed.document, textHash).root;
        if (currentRoot === incomingRoot) rebase(deps.getDoc());
        else { adopt(missed.document); deps.onApplied?.('document'); }
      }
      else if (missed.changes.length) {
        absorb(missed.changes);
        digest = null;
        deps.onApplied?.('registers');
      }
      if (!holding.size) { awayAt = 0; report(); return; }
      const awayMs = awayAt ? clockNow() - awayAt : 0;
      if (awayMs <= REPLAY_THRESHOLD_MS) { replayHeld(); return; }
      const moved = new Set(missed.changes.map(([key]) => key));
      deps.onReconcile?.({
        awayMs,
        changes: [...holding].map(([key, value]) => [key, value] as RegisterAssignment),
        contested: [...holding.keys()]
          .filter(key => moved.has(key) || !sameValue(holdingFrom.get(key), shadow.get(key))),
      });
      report();
    },
    replayHeld,
    discardHeld,

    // ---- drift ----

    /** Check now, whatever the idle timer says — what a reconnection does. */
    checkDrift(): void {
      if (!connected) return;
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
     *  because the topology section is not register-shaped. */
    repair(payload: { registers: readonly RegisterAssignment[]; document?: EditDoc }): void {
      if (payload.document) { adopt(payload.document); deps.onApplied?.('document'); report(); return; }
      if (!payload.registers.length) return;
      absorb(payload.registers);
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
      for (const keys of inFlight.values()) {
        for (const key of keys) {
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
