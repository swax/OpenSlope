import type { CoursePath, QuadMeshDoc, V3 } from './types';
import type { EffectsDocument } from '../effects/document';
import { nameIndex, tombstoned } from './ids';
import { directedEdgeEnds, directedEdgeName } from './serialize';
import { readVertex, writeVertex } from '../mesh/primitives';

/**
 * The document as independently versioned REGISTERS (docs/039).
 *
 * The project service holds one revision and one hash over the whole document, which makes the document one
 * conflict domain: any two concurrent edits collide, whether they touched the same vertex or opposite ends of
 * the mountain. A register is the smallest thing worth versioning on its own — one vertex's position, one
 * crease, one face's paint, one prop, the run, one global — so two people working on different parts never
 * write the same register and never need merging.
 *
 * | Domain                                  | Key                    | Value              |
 * |-----------------------------------------|------------------------|--------------------|
 * | Vertex position                         | `v/<vertex id>`        | xyz                |
 * | Edge handle                             | `h/<from id>><to id>`  | offset             |
 * | Quad attributes, one register per field | `q/<quad id>/<field>`  | paint/tex/…        |
 * | Props, lights, rails, gems, models, volumes, screens, effects | `o/<family>/<id>` | the whole object |
 * | Course path                             | `course`               | every knot         |
 * | Globals — name, sun, skybox, music, …   | `g/<field>`            | the field's value  |
 *
 * Two things are deliberately outside it. TOPOLOGY — which vertices and quads exist, how quads name their
 * corners, the free edges and the T-nodes — is not a register: two people subdividing one quad do not produce
 * a merge, they produce non-manifold geometry, so topology takes an exclusive claim instead and this module
 * never writes it (`structuralDocument` is the whole of what it leaves alone). And this is a PROJECTION, not
 * a storage format: `mountain.slope.json` stays the durable document the export pipeline reads, and the
 * registers are derived from it and written back onto it.
 *
 * A register key names geometry the way the document's own files do — by stable id, never by array index — so
 * a key survives every renumbering, and a key naming something the document has deleted resolves to nothing
 * and is discarded rather than resurrecting geometry (`tombstones`, docs/039).
 */

/** How a register is addressed: an opaque string, built here and compared as a whole. */
export type RegisterKey = string;

/** What a register holds: an absolute value — a position, one field, or a whole object. Handed out as the
 *  document's own value rather than a copy, so read it, do not edit it in place. */
export type RegisterValue = unknown;

/** A set of registers and their values, in document order. Ordered because array order is data: the props a
 *  full resync replays have to land in the order the document lists them. */
export type RegisterMap = Map<RegisterKey, RegisterValue>;

/** How a write turned out. Only the first is an ordinary outcome; the other two are the two ways a key can
 *  name nothing, and they are not the same thing (docs/039). */
export type RegisterWrite =
  /** The register now holds the value. */
  | 'landed'
  /** The key names geometry this document has deleted — an edit that was merely late. Discarded quietly. */
  | 'retired'
  /** The key names nothing this document has ever had, or the value is not one this register can hold. */
  | 'refused';

/** The independently written attributes of one face. */
export type QuadField = 'paint' | 'tex' | 'orient' | 'lock' | 'twist' | 'labels';

/** The object families whose members are each one whole register. */
export type ObjectFamily =
  'prop' | 'light' | 'rail' | 'gem' | 'model' | 'volume' | 'screen' | 'label' | 'effect' | 'effect-node';

const VERTEX_PREFIX = 'v/';
const HANDLE_PREFIX = 'h/';
const QUAD_PREFIX = 'q/';
const OBJECT_PREFIX = 'o/';
const GLOBAL_PREFIX = 'g/';

export const vertexRegister = (vertex: string): RegisterKey => `${VERTEX_PREFIX}${vertex}`;
export const handleRegister = (from: string, to: string): RegisterKey =>
  `${HANDLE_PREFIX}${directedEdgeName(from, to)}`;
export const quadRegister = (quad: string, field: QuadField): RegisterKey =>
  `${QUAD_PREFIX}${quad}/${field}`;
export const objectRegister = (family: ObjectFamily, id: string): RegisterKey =>
  `${OBJECT_PREFIX}${family}/${id}`;
export const globalRegister = (field: string): RegisterKey => `${GLOBAL_PREFIX}${field}`;

/** The run is one register holding every knot: knots are an ordered list of free positions rather than
 *  id-keyed members, and course edits belong to whoever is shaping the run (docs/039, *Ordered data*). */
export const COURSE_REGISTER: RegisterKey = 'course';

/** The mesh a register key stands on: a corner, a crease's two ends, or a face. */
export interface RegisterGeometry {
  vertices: string[];
  quads: string[];
}

/**
 * Which mesh geometry a key names, read back out of the key itself.
 *
 * A key IS the name of what it addresses, so what a participant is touching can be read off the assignments
 * they are sending rather than declared by whichever tool made them — which is what lets awareness (docs/039)
 * cover every edit at once, including the paint stroke that selects nothing at all. Object, global and course
 * keys name no geometry: there is no corner of the mountain to stand on for a prop's own record.
 */
export function registerGeometry(key: RegisterKey): RegisterGeometry {
  if (key.startsWith(VERTEX_PREFIX)) return { vertices: [key.slice(VERTEX_PREFIX.length)], quads: [] };
  if (key.startsWith(HANDLE_PREFIX)) {
    const ends = directedEdgeEnds(key.slice(HANDLE_PREFIX.length));
    return { vertices: ends ? [...ends] : [], quads: [] };
  }
  if (key.startsWith(QUAD_PREFIX)) {
    const cut = key.lastIndexOf('/');
    return { vertices: [], quads: cut > QUAD_PREFIX.length ? [key.slice(QUAD_PREFIX.length, cut)] : [] };
  }
  return { vertices: [], quads: [] };
}

/** What a document IS rather than what it holds: its format markers and its topology. Nothing here is a
 *  register — `vertices` appears only as the buffer vertex registers are read out of and written into. */
const STRUCTURAL: ReadonlySet<string> = new Set([
  'kind', 'version', 'vertices', 'vertexIds', 'quads', 'quadIds', 'nextId', 'tombstones',
  'freeEdges', 'tJunctions',
]);

/** The fields that decompose into registers of their own rather than being held whole as one global. */
const DECOMPOSED: ReadonlySet<string> = new Set([
  'edgeHandles', 'quadPaint', 'quadTex', 'quadOrient', 'quadLocked', 'quadTwist', 'quadLabels',
  'course', 'props', 'lights', 'rails', 'gems', 'models', 'particleVolumes', 'screens', 'labels', 'effects',
]);

/** The per-quad channel behind each attribute field, in the order a quad's registers are emitted. */
const QUAD_CHANNELS: readonly (readonly [QuadField, 'quadPaint' | 'quadTex' | 'quadOrient' | 'quadLocked' | 'quadTwist' | 'quadLabels'])[] = [
  ['paint', 'quadPaint'], ['tex', 'quadTex'], ['orient', 'quadOrient'], ['lock', 'quadLocked'], ['twist', 'quadTwist'],
  ['labels', 'quadLabels'],
];

/** The effects document's own tables, each a list of rows named by their own id. */
const EFFECT_TABLES = [
  'slots', 'graphs', 'functions', 'objectProperties', 'instances', 'physics', 'collisionModels', 'splines',
] as const;
type EffectTable = typeof EFFECT_TABLES[number];
const effectTables: ReadonlySet<string> = new Set(EFFECT_TABLES);

/** The two tables whose rows own effect nodes, which are registers in their own right. */
const EFFECT_NODE_TABLES: readonly EffectTable[] = ['graphs', 'functions'];
const ownsNodes = (table: EffectTable): boolean => EFFECT_NODE_TABLES.includes(table);

/** The effects document's own fields, held as one register beside its tables. No table is called this, which
 *  is what tells `o/effect/document` from `o/effect/<table>/<row>`. */
const EFFECT_DOCUMENT = 'document';

/** An effects table row as the register model sees it: an opaque record named by its own id, with the nodes a
 *  graph or a function owns split out into registers of their own. `core/effects/document.ts` is what gives
 *  the fields meaning; here they are a value. */
type EffectRow = { id: string; nodes?: { id: string }[] } & Record<string, unknown>;

/** Every field held whole as one global register: the complement of the structural and decomposed sets, so a
 *  field the document grows later is carried by the projection rather than silently dropped from it. */
export function globalFields(doc: QuadMeshDoc): string[] {
  return Object.keys(doc).filter(field => !STRUCTURAL.has(field) && !DECOMPOSED.has(field));
}

/**
 * The part of the document the register model does not own — format markers, identity, and the topology a
 * claim covers instead.
 *
 * `vertices` is left out because a vertex position is a register; what remains of the position buffer is its
 * length, which `vertexIds` already states.
 */
export function structuralDocument(doc: QuadMeshDoc): Record<string, unknown> {
  const record = doc as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of STRUCTURAL) {
    if (field !== 'vertices' && record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

// ---- decomposition ----------------------------------------------------------------------------------------

type Emit = (key: RegisterKey, value: RegisterValue) => void;

/** An id that cannot be taken apart again is an id two registers would answer to — the collapse
 *  `doc/serialize.ts` refuses for the same reason, raised here rather than merged out of sight. */
function keyable(what: string, id: string | undefined, forbidden?: string): string {
  if (!id) throw new Error(`This mountain carries ${what} with no id, which nothing can address.`);
  if (forbidden && id.includes(forbidden)) {
    throw new Error(`This mountain carries ${what} whose id contains '${forbidden}', so it cannot be named: ${id}`);
  }
  return id;
}

function emitVertices(doc: QuadMeshDoc, emit: Emit, from = 0, to = doc.vertexIds.length): void {
  const last = Math.min(to, doc.vertexIds.length);
  for (let at = Math.max(from, 0); at < last; at++) {
    emit(vertexRegister(doc.vertexIds[at]), readVertex(doc.vertices, at));
  }
}

/**
 * Creases, in register-key order.
 *
 * `edgeHandles` is a map, so the order it enumerates in is the order it was built in — which differs between a
 * document read off disk and the same document rebuilt by applying registers to it. Ordering by the id-named
 * key instead makes the section one function of the creases it holds rather than of how they got there.
 * A key whose ends the mesh no longer carries addresses nothing and has shaped no terrain for as long as that
 * was true, so it is dropped exactly as storing the document drops it.
 */
function emitHandles(doc: QuadMeshDoc, emit: Emit, from = 0, to = Infinity): void {
  const handles = doc.edgeHandles;
  if (!handles) return;
  const named: [RegisterKey, V3][] = [];
  for (const key in handles) {
    const ends = directedEdgeEnds(key);
    if (!ends) throw new Error(`This mountain carries a crease under a key that names no edge: ${key}`);
    const at = Number(ends[0]);
    const fromId = doc.vertexIds[at], toId = doc.vertexIds[Number(ends[1])];
    if (fromId === undefined || toId === undefined || at < from || at >= to) continue;
    named.push([handleRegister(fromId, toId), handles[key]]);
  }
  named.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (const [key, value] of named) emit(key, value);
}

function emitQuads(doc: QuadMeshDoc, emit: Emit, from = 0, to = doc.quadIds.length): void {
  const record = doc as unknown as Record<string, Record<number, unknown> | undefined>;
  const last = Math.min(to, doc.quadIds.length);
  for (let at = Math.max(from, 0); at < last; at++) {
    for (const [field, channel] of QUAD_CHANNELS) {
      const value = record[channel]?.[at];
      if (value !== undefined) emit(quadRegister(doc.quadIds[at], field), value);
    }
  }
}

function emitObjects(doc: QuadMeshDoc, emit: Emit, only?: ObjectFamily): void {
  const list = <T>(family: ObjectFamily, objects: readonly T[] | undefined,
    name: (object: T, at: number) => string): void => {
    if (only && only !== family) return;
    objects?.forEach((object, at) => emit(objectRegister(family, name(object, at)), object));
  };
  list('prop', doc.props, prop => keyable('a prop', prop.id));
  list('light', doc.lights, light => keyable('a light', light.id));
  list('rail', doc.rails, rail => keyable('a rail', rail.id));
  list('gem', doc.gems, gem => keyable('a gem', gem.id));
  list('model', doc.models, model => keyable('a model', model.id));
  list('volume', doc.particleVolumes, volume => keyable('a particle volume', volume.id));
  list('screen', doc.screens, screen => keyable('a screen', screen.id));
  list('label', doc.labels, label => keyable('a label', label.id));
  emitEffects(doc.effects, emit, only);
}

/** The effect graph: its own fields as one register, each table row as another, and each node a graph or a
 *  function owns as one more — the grain docs/039 gives an effect node. */
function emitEffects(effects: EffectsDocument | undefined, emit: Emit, only?: ObjectFamily): void {
  if (!effects) return;
  const record = effects as unknown as Record<string, unknown>;
  if (!only || only === 'effect') {
    const header: Record<string, unknown> = {};
    for (const field of Object.keys(record)) if (!effectTables.has(field)) header[field] = record[field];
    emit(objectRegister('effect', EFFECT_DOCUMENT), header);
    for (const table of EFFECT_TABLES) {
      for (const row of tableRows(effects, table)) {
        const { nodes: _nodes, ...withoutNodes } = row;
        emit(objectRegister('effect', `${table}/${keyable(`an effects ${table} row`, row.id, '/')}`),
          ownsNodes(table) ? withoutNodes : row);
      }
    }
  }
  if (!only || only === 'effect-node') {
    for (const table of EFFECT_NODE_TABLES) {
      for (const row of tableRows(effects, table)) {
        const owner = keyable(`an effects ${table} row`, row.id, '/');
        for (const node of row.nodes ?? []) {
          emit(objectRegister('effect-node', `${table}/${owner}/${keyable('an effect node', node.id)}`), node);
        }
      }
    }
  }
}

const effectTable = (effects: EffectsDocument, table: EffectTable): EffectRow[] | undefined =>
  (effects as unknown as Record<string, EffectRow[] | undefined>)[table];
const tableRows = (effects: EffectsDocument, table: EffectTable): EffectRow[] => effectTable(effects, table) ?? [];

const emitCourse = (doc: QuadMeshDoc, emit: Emit): void => emit(COURSE_REGISTER, doc.course);

function emitGlobals(doc: QuadMeshDoc, emit: Emit, only?: string): void {
  const record = doc as unknown as Record<string, unknown>;
  for (const field of globalFields(doc)) {
    if ((only !== undefined && only !== field) || record[field] === undefined) continue;
    emit(globalRegister(field), record[field]);
  }
}

/** Every register the document holds, in document order. */
export function documentRegisters(doc: QuadMeshDoc): RegisterMap {
  const out: RegisterMap = new Map();
  const emit: Emit = (key, value) => out.set(key, value);
  emitVertices(doc, emit);
  emitHandles(doc, emit);
  emitQuads(doc, emit);
  emitObjects(doc, emit);
  emitCourse(doc, emit);
  emitGlobals(doc, emit);
  return out;
}

// ---- sections: how the registers are grouped for hashing ---------------------------------------------------

/**
 * Registers per section, so a hash that disagrees says WHERE (docs/039).
 *
 * A thousand or so is the size at which a section is worth refetching whole: small enough that repairing one
 * is invisible next to refetching the mountain, large enough that a mesh of a few thousand vertices carries a
 * handful of sections rather than a hash per corner.
 */
export const REGISTER_CHUNK = 1024;

/** A chunked section's name — zero-padded so a plain sort over section names is an ordering over the mesh. */
const chunkSection = (kind: string, at: number): string =>
  `${kind}/${String(Math.floor(at / REGISTER_CHUNK)).padStart(6, '0')}`;

const chunkRange = (section: string): [number, number] => {
  const chunk = Number(section.slice(section.indexOf('/') + 1));
  return [chunk * REGISTER_CHUNK, (chunk + 1) * REGISTER_CHUNK];
};

const families: ReadonlySet<string> =
  new Set<ObjectFamily>(['prop', 'light', 'rail', 'gem', 'model', 'volume', 'screen', 'label', 'effect', 'effect-node']);

/**
 * Which section hashes a register — vertices and quads by the chunk their index falls in, a crease by the
 * chunk of the end that owns it, everything else by what it is.
 *
 * Null for a key this document cannot place: a name it has never carried, or one it has since deleted. Both
 * mean the numbering has moved and the chunks with it, which is a full rehash rather than a maintained one.
 */
export function registerSection(doc: QuadMeshDoc, key: RegisterKey): string | null {
  if (key === COURSE_REGISTER) return COURSE_REGISTER;
  if (key.startsWith(VERTEX_PREFIX)) {
    const at = nameIndex(doc.vertexIds).get(key.slice(VERTEX_PREFIX.length));
    return at === undefined ? null : chunkSection('vertices', at);
  }
  if (key.startsWith(HANDLE_PREFIX)) {
    const ends = directedEdgeEnds(key.slice(HANDLE_PREFIX.length));
    if (!ends) return null;
    const at = nameIndex(doc.vertexIds).get(ends[0]);
    return at === undefined ? null : chunkSection('handles', at);
  }
  if (key.startsWith(QUAD_PREFIX)) {
    const cut = key.lastIndexOf('/');
    const at = cut <= QUAD_PREFIX.length
      ? undefined : nameIndex(doc.quadIds).get(key.slice(QUAD_PREFIX.length, cut));
    return at === undefined ? null : chunkSection('quads', at);
  }
  if (key.startsWith(OBJECT_PREFIX)) {
    const cut = key.indexOf('/', OBJECT_PREFIX.length);
    const family = cut < 0 ? '' : key.slice(OBJECT_PREFIX.length, cut);
    return families.has(family) ? `objects/${family}` : null;
  }
  if (key.startsWith(GLOBAL_PREFIX)) {
    const field = key.slice(GLOBAL_PREFIX.length);
    return field && !STRUCTURAL.has(field) && !DECOMPOSED.has(field) ? `globals/${field}` : null;
  }
  return null;
}

/**
 * One section's registers, collected without walking the rest of the document — what makes maintaining a
 * section hash cost the section rather than the mountain.
 *
 * Creases are the one section read by scanning: they are a sparse map keyed off their owning vertex, so the
 * chunk they belong to is found by looking rather than by subscript. That scan is over the creases a mountain
 * carries, not over its corners.
 */
export function sectionRegisters(doc: QuadMeshDoc, section: string): RegisterMap {
  const out: RegisterMap = new Map();
  const emit: Emit = (key, value) => out.set(key, value);
  if (section === COURSE_REGISTER) { emitCourse(doc, emit); return out; }
  const cut = section.indexOf('/');
  const kind = cut < 0 ? section : section.slice(0, cut);
  const rest = cut < 0 ? '' : section.slice(cut + 1);
  if (kind === 'vertices') emitVertices(doc, emit, ...chunkRange(section));
  else if (kind === 'handles') emitHandles(doc, emit, ...chunkRange(section));
  else if (kind === 'quads') emitQuads(doc, emit, ...chunkRange(section));
  else if (kind === 'objects' && families.has(rest)) emitObjects(doc, emit, rest as ObjectFamily);
  else if (kind === 'globals') emitGlobals(doc, emit, rest);
  return out;
}

/** Every register the document holds, grouped by the section that hashes it. */
export function documentSections(doc: QuadMeshDoc): Map<string, RegisterMap> {
  const sections = new Map<string, RegisterMap>();
  for (const [key, value] of documentRegisters(doc)) {
    const section = registerSection(doc, key);
    if (section === null) continue;
    const held = sections.get(section) ?? new Map<RegisterKey, RegisterValue>();
    held.set(key, value);
    sections.set(section, held);
  }
  return sections;
}

// ---- the inverse: writing a register back onto the document ------------------------------------------------

/** One register resolved onto a document — the read and the write of one addressable value. */
interface Register {
  read(): RegisterValue;
  /** Take the value; false when this register cannot hold it. */
  write(value: RegisterValue): boolean;
}

const isPoint = (value: unknown): value is V3 =>
  Array.isArray(value) && value.length === 3 && value.every(part => typeof part === 'number');

/** A register inside a sparse channel, where assigning nothing removes the entry — which is exactly what an
 *  unpainted face or an uncreased edge is. */
function inChannel(owner: Record<string, unknown> | undefined, make: () => Record<string, unknown>,
  key: string): Register {
  return {
    read: () => owner?.[key],
    write: value => {
      if (value === undefined) { if (owner) delete owner[key]; return true; }
      make()[key] = value;
      return true;
    },
  };
}

/**
 * A whole-object register in a list keyed by the object's own id: an id the list does not carry is an insert,
 * and assigning nothing is a delete.
 *
 * `make` answers with the list to insert into, or nothing when the document has nowhere to put one — an
 * effect node whose graph is not here. Reading never creates the list, so asking about an object a document
 * does not have leaves the document as it was.
 */
function byIdentity<T>(read: () => T[] | undefined, make: () => T[] | undefined,
  name: (object: T) => string | undefined, want: string): Register {
  const at = (): number => read()?.findIndex(object => name(object) === want) ?? -1;
  return {
    read: () => { const found = at(); return found < 0 ? undefined : read()![found]; },
    write: value => {
      const found = at();
      if (value === undefined) { if (found >= 0) read()!.splice(found, 1); return true; }
      if (found >= 0) { read()![found] = value as T; return true; }
      const made = make();
      if (!made) return false;
      made.push(value as T);
      return true;
    },
  };
}

/** The effects document with its eight tables and nothing else — what the header register is written onto. */
const emptyEffects = (): EffectsDocument =>
  Object.fromEntries(EFFECT_TABLES.map(table => [table, []])) as unknown as EffectsDocument;

function effectRegister(doc: QuadMeshDoc, family: 'effect' | 'effect-node', path: string): Register | null {
  const cut = path.indexOf('/');
  const table = (cut < 0 ? path : path.slice(0, cut)) as EffectTable;
  const rest = cut < 0 ? '' : path.slice(cut + 1);
  const grow = (): EffectRow[] => {
    const effects = (doc.effects ??= emptyEffects()) as unknown as Record<string, EffectRow[] | undefined>;
    return (effects[table] ??= []);
  };
  const rows = (): EffectRow[] | undefined => doc.effects && effectTable(doc.effects, table);

  if (family === 'effect' && path === EFFECT_DOCUMENT) {
    return {
      read: () => {
        if (!doc.effects) return undefined;
        const record = doc.effects as unknown as Record<string, unknown>;
        return Object.fromEntries(Object.keys(record).filter(field => !effectTables.has(field))
          .map(field => [field, record[field]]));
      },
      write: value => {
        if (value === undefined) { delete doc.effects; return true; }
        if (!value || typeof value !== 'object') return false;
        // Replaced whole rather than merged, so a field the previous holder carried and this one does not is
        // gone — which is what last-writer-wins over one value means. The tables are not the header's to move.
        const held = doc.effects ?? emptyEffects();
        const tables = Object.fromEntries(EFFECT_TABLES.map(named => [named, tableRows(held, named)]));
        doc.effects = { ...(value as Record<string, unknown>), ...tables } as unknown as EffectsDocument;
        return true;
      },
    };
  }
  if (!effectTables.has(table) || !rest) return null;

  if (family === 'effect') {
    // The nodes belong to registers of their own, so replacing the row they hang off leaves them where they
    // are: a renamed graph is not an emptied one.
    const carried = (row: EffectRow | undefined): EffectRow | undefined => {
      if (!row || !ownsNodes(table)) return row;
      const { nodes: _nodes, ...withoutNodes } = row;
      return withoutNodes as EffectRow;
    };
    return {
      read: () => carried(rows()?.find(held => held.id === rest)),
      write: value => {
        const held = rows();
        const found = held?.findIndex(row => row.id === rest) ?? -1;
        if (value === undefined) { if (found >= 0) held!.splice(found, 1); return true; }
        if (!value || typeof value !== 'object') return false;
        const nodes = ownsNodes(table) ? { nodes: found >= 0 ? held![found].nodes ?? [] : [] } : {};
        const row = { ...(value as EffectRow), ...nodes };
        if (found >= 0) held![found] = row; else grow().push(row);
        return true;
      },
    };
  }

  const split = rest.indexOf('/');
  const owner = split < 0 ? rest : rest.slice(0, split);
  const node = split < 0 ? '' : rest.slice(split + 1);
  if (!node) return null;
  const holder = (list?: EffectRow[]): EffectRow | undefined => list?.find(row => row.id === owner);
  return byIdentity<{ id: string }>(() => holder(rows())?.nodes,
    () => { const row = holder(rows()); return row && (row.nodes ??= []); }, held => held.id, node);
}

/**
 * The register a key names on this document, or how it fails to name one.
 *
 * The two failures are the two the keying boundary already tells apart: a name the document has retired is an
 * edit that arrived late and is discarded quietly, and a name it has never carried is nonsense the caller
 * should hear about.
 */
function locate(doc: QuadMeshDoc, key: RegisterKey): Register | Exclude<RegisterWrite, 'landed'> {
  const record = doc as unknown as Record<string, unknown>;
  const missing = (id: string): 'retired' | 'refused' => tombstoned(doc, id) ? 'retired' : 'refused';

  if (key === COURSE_REGISTER) {
    return {
      read: () => doc.course,
      write: value => {
        if (!value || typeof value !== 'object') return false;
        doc.course = value as CoursePath;
        return true;
      },
    };
  }
  if (key.startsWith(VERTEX_PREFIX)) {
    const id = key.slice(VERTEX_PREFIX.length);
    const at = nameIndex(doc.vertexIds).get(id);
    if (at === undefined) return missing(id);
    return {
      read: () => readVertex(doc.vertices, at),
      write: value => {
        if (!isPoint(value)) return false;
        writeVertex(doc.vertices, at, value);
        return true;
      },
    };
  }
  if (key.startsWith(HANDLE_PREFIX)) {
    const ends = directedEdgeEnds(key.slice(HANDLE_PREFIX.length));
    if (!ends) return 'refused';
    const at = nameIndex(doc.vertexIds);
    const from = at.get(ends[0]), to = at.get(ends[1]);
    if (from === undefined) return missing(ends[0]);
    if (to === undefined) return missing(ends[1]);
    return inChannel(doc.edgeHandles, () => (doc.edgeHandles ??= {}), directedEdgeName(from, to));
  }
  if (key.startsWith(QUAD_PREFIX)) {
    const cut = key.lastIndexOf('/');
    if (cut <= QUAD_PREFIX.length) return 'refused';
    const id = key.slice(QUAD_PREFIX.length, cut);
    const field = key.slice(cut + 1);
    const channel = QUAD_CHANNELS.find(([named]) => named === field)?.[1];
    if (!channel) return 'refused';
    const at = nameIndex(doc.quadIds).get(id);
    if (at === undefined) return missing(id);
    return inChannel(record[channel] as Record<string, unknown> | undefined,
      () => (record[channel] ??= {}) as Record<string, unknown>, String(at));
  }
  if (key.startsWith(OBJECT_PREFIX)) {
    const cut = key.indexOf('/', OBJECT_PREFIX.length);
    if (cut < 0) return 'refused';
    const family = key.slice(OBJECT_PREFIX.length, cut) as ObjectFamily;
    const id = key.slice(cut + 1);
    if (!id) return 'refused';
    const list = <T>(field: 'props' | 'lights' | 'rails' | 'gems' | 'models' | 'particleVolumes' | 'screens' | 'labels') => ({
      read: () => record[field] as T[] | undefined,
      make: () => (record[field] ??= []) as T[],
    });
    switch (family) {
      case 'prop': {
        const held = list<{ id?: string }>('props');
        return byIdentity(held.read, held.make, prop => prop.id, id);
      }
      case 'rail': {
        const held = list<{ id?: string }>('rails');
        return byIdentity(held.read, held.make, rail => rail.id, id);
      }
      case 'model': {
        const held = list<{ id: string }>('models');
        return byIdentity(held.read, held.make, model => model.id, id);
      }
      case 'volume': {
        const held = list<{ id: string }>('particleVolumes');
        return byIdentity(held.read, held.make, volume => volume.id, id);
      }
      case 'light': {
        const held = list<{ id?: string }>('lights');
        return byIdentity(held.read, held.make, light => light.id, id);
      }
      case 'gem': {
        const held = list<{ id?: string }>('gems');
        return byIdentity(held.read, held.make, gem => gem.id, id);
      }
      case 'screen': {
        const held = list<{ id?: string }>('screens');
        return byIdentity(held.read, held.make, screen => screen.id, id);
      }
      case 'label': {
        const held = list<{ id: string }>('labels');
        return byIdentity(held.read, held.make, label => label.id, id);
      }
      case 'effect': case 'effect-node':
        return effectRegister(doc, family, id) ?? 'refused';
      default:
        return 'refused';
    }
  }
  if (key.startsWith(GLOBAL_PREFIX)) {
    const field = key.slice(GLOBAL_PREFIX.length);
    if (!field || STRUCTURAL.has(field) || DECOMPOSED.has(field)) return 'refused';
    return inChannel(record, () => record, field);
  }
  return 'refused';
}

/** What a register holds now, or undefined when it holds nothing or names nothing. */
export function readRegister(doc: QuadMeshDoc, key: RegisterKey): RegisterValue {
  const at = locate(doc, key);
  return typeof at === 'string' ? undefined : at.read();
}

/**
 * Assign one register — the whole of what an ordinary edit sends (docs/039).
 *
 * Assignments are absolute and idempotent, so the same value arriving twice, or out of order with an older
 * one, has a defined outcome and nothing here can be rejected for having lost a race. Only structural
 * impossibility refuses: a name this document has retired, or one it has never had.
 */
export function writeRegister(doc: QuadMeshDoc, key: RegisterKey, value: RegisterValue): RegisterWrite {
  const at = locate(doc, key);
  if (typeof at === 'string') return at;
  return at.write(value) ? 'landed' : 'refused';
}

/** How a batch of assignments turned out. */
export interface RegisterWriteCount { landed: number; retired: number; refused: number }

/** Assign a set of registers in the order given — a full resync, or one participant's batch of changes. */
export function applyRegisters(doc: QuadMeshDoc,
  registers: Iterable<readonly [RegisterKey, RegisterValue]>): RegisterWriteCount {
  const count: RegisterWriteCount = { landed: 0, retired: 0, refused: 0 };
  for (const [key, value] of registers) count[writeRegister(doc, key, value)]++;
  return count;
}

/**
 * The document with everything the register model owns emptied out: the shell a full resync fills, and the
 * statement of what the model owns given as its complement.
 *
 * Containers are kept while their contents go, because whether a mountain carries an empty prop list or no
 * prop list at all is the document's own shape rather than something a register holds. Topology is untouched:
 * the mesh a shell describes is the mesh it came from, down to the numbering.
 */
export function registerShell(doc: QuadMeshDoc): QuadMeshDoc {
  const shell = { ...doc } as QuadMeshDoc;
  const record = shell as unknown as Record<string, unknown>;
  shell.vertices = new Array<number>(doc.vertices.length).fill(0);
  shell.vertexIds = [...doc.vertexIds];
  shell.quadIds = [...doc.quadIds];
  shell.quads = doc.quads.map(quad => [...quad]);
  if (doc.freeEdges) shell.freeEdges = doc.freeEdges.map(([a, b]) => [a, b]);
  if (doc.tJunctions) shell.tJunctions = doc.tJunctions.map(node => ({ ...node, edge: [...node.edge] }));
  if (doc.tombstones) shell.tombstones = [...doc.tombstones];
  for (const channel of ['edgeHandles', 'quadPaint', 'quadTex', 'quadOrient', 'quadLocked', 'quadTwist', 'quadLabels']) {
    if (channel in record) record[channel] = {};
  }
  for (const family of ['props', 'lights', 'rails', 'gems', 'models', 'particleVolumes', 'screens', 'labels']) {
    if (family in record) record[family] = [];
  }
  // The effects document's presence is itself carried by a register, so it goes with the rest of them.
  delete record.effects;
  for (const field of globalFields(shell)) delete record[field];
  shell.name = '';
  shell.spacing = 0;
  shell.baseSurface = 0;
  shell.course = { knots: [], blend: 0, surface: 0 };
  return shell;
}
