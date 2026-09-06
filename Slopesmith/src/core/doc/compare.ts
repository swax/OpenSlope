import type { QuadMeshDoc } from './types';
import { canonicalJson } from './canonical';
import {
  COURSE_REGISTER, documentRegisters,
  type ObjectFamily, type QuadField, type RegisterKey, type RegisterValue,
} from './registers';
import { directedEdgeEnds } from './serialize';

/**
 * What two documents disagree about, register by register (docs/040).
 *
 * Two questions are answered here and they are the same question read twice. *What changed?* is a checkpoint
 * beside the live mountain and a sentence saying how many corners moved, which faces were repainted, which
 * objects appeared and which globals differ — far better than reading a JSON diff, and cheap now that a
 * document decomposes into registers. *Put that part back* is the same set of registers assigned the values
 * the older document holds for them: a scoped revert is an ORDINARY WRITE and needs no storage of its own,
 * because the older document is already on disk as a whole checkpoint and the difference is computed rather
 * than recorded.
 *
 * TOPOLOGY is outside both. Which vertices and quads exist is not a register (docs/039), so a corner somebody
 * deleted cannot be brought back by assigning to it — that assignment names retired geometry and is discarded
 * quietly. A scoped revert therefore covers values, not structure, and the summary says so by counting the
 * corners and faces the two documents differ over rather than pretending an assignment could restore them.
 */

/** How one register differs between two documents. */
export type ChangeKind =
  /** The later document holds a value the earlier one did not: a placed prop, a painted face, a crease. */
  | 'added'
  /** The earlier document held one and the later does not. */
  | 'removed'
  /** Both hold one, and they are not the same value. */
  | 'changed';

export interface RegisterChange {
  key: RegisterKey;
  kind: ChangeKind;
  /** What the earlier document holds — the value a revert assigns. */
  before: RegisterValue;
  after: RegisterValue;
}

/** Every register two documents disagree about, in the later document's own order. */
export type DocumentDiff = Map<RegisterKey, RegisterChange>;

/**
 * Compare two documents as registers.
 *
 * Values compare through the canonical text rather than by reference or by bits, for the reason the canonical
 * form exists: the same authored position reached by a drag, an undo and a nudge differs from itself in the
 * last bit or two, and a difference nobody made is not a change worth reporting or reverting.
 */
export function documentDiff(before: QuadMeshDoc, after: QuadMeshDoc): DocumentDiff {
  const was = documentRegisters(before);
  const now = documentRegisters(after);
  const diff: DocumentDiff = new Map();
  for (const [key, value] of now) {
    if (!was.has(key)) { diff.set(key, { key, kind: 'added', before: undefined, after: value }); continue; }
    const held = was.get(key);
    if (canonicalJson(held) !== canonicalJson(value)) {
      diff.set(key, { key, kind: 'changed', before: held, after: value });
    }
  }
  for (const [key, value] of was) {
    if (!now.has(key)) diff.set(key, { key, kind: 'removed', before: value, after: undefined });
  }
  return diff;
}

// ---- what changed, in words ---------------------------------------------------------------------------------

/** One object family's tally. Absent from a summary when the family is untouched, so a listing reads as what
 *  moved rather than as a table of zeros. */
export interface ObjectChanges {
  family: ObjectFamily;
  added: number;
  removed: number;
  changed: number;
}

/** How two documents differ, at the grain somebody choosing between checkpoints reads. */
export interface ChangeSummary {
  /** Every register that differs — the total the counts below partition. */
  registers: number;
  /** Corners: how many moved, and how many the two documents do not both carry. The last two are topology,
   *  which no assignment can put back (docs/039). */
  vertices: { moved: number; added: number; removed: number };
  creases: { added: number; removed: number; changed: number };
  /** Faces: how many differ in each attribute, and how many distinct faces that is. `added` and `removed`
   *  count the faces themselves, which is topology rather than paint. */
  quads: { paint: number; tex: number; orient: number; lock: number; twist: number; labels: number; faces: number; added: number; removed: number };
  objects: ObjectChanges[];
  /** Whether the run differs. It is one register holding every knot, so there is nothing finer to say. */
  course: boolean;
  /** Which globals differ, by field name — the whole answer, since a mountain carries a handful. */
  globals: string[];
}

const OBJECT_FAMILIES: readonly ObjectFamily[] =
  ['prop', 'light', 'rail', 'gem', 'model', 'volume', 'label', 'effect', 'effect-node'];

/** Which family an `o/<family>/<id>` key names, or null when it names none. */
function objectFamily(key: RegisterKey): ObjectFamily | null {
  const cut = key.indexOf('/', 2);
  const family = cut < 0 ? '' : key.slice(2, cut);
  return OBJECT_FAMILIES.find(named => named === family) ?? null;
}

/** The quad and the field a `q/<id>/<field>` key names. */
function quadField(key: RegisterKey): { quad: string; field: QuadField } | null {
  const cut = key.lastIndexOf('/');
  if (cut <= 2) return null;
  const field = key.slice(cut + 1);
  return field === 'paint' || field === 'tex' || field === 'orient' || field === 'lock' || field === 'twist' || field === 'labels'
    ? { quad: key.slice(2, cut), field } : null;
}

/**
 * Read the diff back as counts.
 *
 * The documents are handed in as well as their difference, because corners and faces the two do not both
 * carry are topology and the registers cannot say so: every corner has a position register, so a corner that
 * appeared shows up as an added register — but a face nobody painted has no register at all, and counting only
 * what the diff holds would report a freshly subdivided quilt as no change to the faces.
 */
export function summarizeDiff(before: QuadMeshDoc, after: QuadMeshDoc, diff: DocumentDiff): ChangeSummary {
  const summary: ChangeSummary = {
    registers: diff.size,
    vertices: { moved: 0, added: 0, removed: 0 },
    creases: { added: 0, removed: 0, changed: 0 },
    quads: { paint: 0, tex: 0, orient: 0, lock: 0, twist: 0, labels: 0, faces: 0, added: 0, removed: 0 },
    objects: [],
    course: false,
    globals: [],
  };
  const faces = new Set<string>();
  const families = new Map<ObjectFamily, ObjectChanges>();
  for (const change of diff.values()) {
    const { key, kind } = change;
    if (key === COURSE_REGISTER) { summary.course = true; continue; }
    if (key.startsWith('v/')) { if (kind === 'changed') summary.vertices.moved++; continue; }
    if (key.startsWith('h/')) { summary.creases[kind]++; continue; }
    if (key.startsWith('q/')) {
      const named = quadField(key);
      if (!named) continue;
      summary.quads[named.field]++;
      faces.add(named.quad);
      continue;
    }
    if (key.startsWith('o/')) {
      const family = objectFamily(key);
      if (!family) continue;
      const tally = families.get(family) ?? { family, added: 0, removed: 0, changed: 0 };
      tally[kind]++;
      families.set(family, tally);
      continue;
    }
    if (key.startsWith('g/')) summary.globals.push(key.slice(2));
  }
  summary.quads.faces = faces.size;
  summary.globals.sort();
  summary.objects = OBJECT_FAMILIES.flatMap(family => families.get(family) ?? []);

  // Topology, counted off the id lists rather than off the registers, for the reason above.
  const missing = (ids: readonly string[], from: readonly string[]): number => {
    const there = new Set(from);
    return ids.reduce((count, id) => count + (there.has(id) ? 0 : 1), 0);
  };
  summary.vertices.added = missing(after.vertexIds, before.vertexIds);
  summary.vertices.removed = missing(before.vertexIds, after.vertexIds);
  summary.quads.added = missing(after.quadIds, before.quadIds);
  summary.quads.removed = missing(before.quadIds, after.quadIds);
  return summary;
}

/** Both halves at once: what differs, and what that adds up to. */
export function changeSummary(before: QuadMeshDoc, after: QuadMeshDoc): ChangeSummary {
  return summarizeDiff(before, after, documentDiff(before, after));
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** What each object family is called when it is being counted. */
const FAMILY_NOUN: Record<ObjectFamily, string> = {
  prop: 'prop', light: 'light', rail: 'rail', gem: 'gem', model: 'model',
  volume: 'particle volume', screen: 'video screen', label: 'label', effect: 'effect',
  'effect-node': 'effect node',
};

/**
 * The summary as phrases — "12 corners moved", "4 faces repainted", "a prop vanished".
 *
 * Given rather than formatted at each call site, so the History panel, a toast and the room's own announcement
 * all say the same thing about the same pair of documents. Empty when the two documents hold the same values,
 * which is the caller's cue to say so in its own words.
 */
export function describeChanges(summary: ChangeSummary): string[] {
  const said: string[] = [];
  const { vertices, creases, quads } = summary;
  if (vertices.moved) said.push(`${plural(vertices.moved, 'corner')} moved`);
  if (vertices.added) said.push(`${plural(vertices.added, 'corner')} added`);
  if (vertices.removed) said.push(`${plural(vertices.removed, 'corner')} gone`);
  if (quads.added) said.push(`${plural(quads.added, 'face')} added`);
  if (quads.removed) said.push(`${plural(quads.removed, 'face')} gone`);
  if (quads.paint) said.push(`${plural(quads.paint, 'face')} repainted`);
  if (quads.tex) said.push(`${plural(quads.tex, 'face')} retextured`);
  if (quads.lock) said.push(`${plural(quads.lock, 'face')} lock changed`);
  if (quads.labels) said.push(`${plural(quads.labels, 'face')} relabelled`);
  if (quads.orient || quads.twist) {
    said.push(`${plural(quads.orient + quads.twist, 'face')} reshaped`);
  }
  const creaseCount = creases.added + creases.removed + creases.changed;
  if (creaseCount) said.push(`${plural(creaseCount, 'crease')} changed`);
  for (const tally of summary.objects) {
    const noun = FAMILY_NOUN[tally.family];
    if (tally.added) said.push(`${plural(tally.added, noun)} appeared`);
    if (tally.removed) said.push(`${plural(tally.removed, noun)} vanished`);
    if (tally.changed) said.push(`${plural(tally.changed, noun)} edited`);
  }
  if (summary.course) said.push('the run changed');
  if (summary.globals.length) said.push(`${summary.globals.join(', ')} differ${summary.globals.length === 1 ? 's' : ''}`);
  return said;
}

// ---- putting part of it back --------------------------------------------------------------------------------

/**
 * Which registers a revert covers.
 *
 * Every field narrows: a scope naming both a key set and a selection reverts what is in both. A scope naming
 * nothing reverts every register that differs, which is a whole-document restore expressed as assignments.
 */
export interface RevertScope {
  /** Only these registers — "everything Bob changed", as the room credits them. */
  keys?: Iterable<RegisterKey>;
  /** Bounded by geometry: these corners and faces, and the creases running between two named corners.
   *  A scope naming any geometry covers geometry only — props, the run and the globals are not part of a
   *  selection of vertices and quads. */
  vertices?: Iterable<string>;
  quads?: Iterable<string>;
}

/** Whether a key names geometry inside the selection. */
function inSelection(key: RegisterKey, vertices: Set<string>, quads: Set<string>): boolean {
  if (key.startsWith('v/')) return vertices.has(key.slice(2));
  if (key.startsWith('h/')) {
    const ends = directedEdgeEnds(key.slice(2));
    // A crease belongs to the edge, so it moves with a selection only when both of its corners are in one.
    return !!ends && vertices.has(ends[0]) && vertices.has(ends[1]);
  }
  if (key.startsWith('q/')) {
    const named = quadField(key);
    return !!named && quads.has(named.quad);
  }
  return false;
}

/**
 * The assignments that put a scope back to what the earlier document holds — the whole of a scoped revert
 * (docs/040).
 *
 * Every entry is an ordinary absolute assignment, so a revert travels the path any other edit travels, is
 * resolved last-writer-wins like any other, is undone by re-asserting what it replaced, and needs no new
 * conflict handling and no storage of its own. A register the earlier document did not hold reverts to
 * nothing, which is what clearing a face somebody painted or removing a prop somebody placed already is.
 */
export function revertAssignments(diff: DocumentDiff, scope: RevertScope = {}):
  [RegisterKey, RegisterValue][] {
  const keys = scope.keys ? new Set(scope.keys) : null;
  const vertices = new Set(scope.vertices ?? []);
  const quads = new Set(scope.quads ?? []);
  const bounded = vertices.size > 0 || quads.size > 0;
  const out: [RegisterKey, RegisterValue][] = [];
  for (const change of diff.values()) {
    if (keys && !keys.has(change.key)) continue;
    if (bounded && !inSelection(change.key, vertices, quads)) continue;
    out.push([change.key, change.before]);
  }
  return out;
}
