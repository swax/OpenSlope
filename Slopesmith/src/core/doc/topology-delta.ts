import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from './types';
import { nameIndex } from './ids';
import { textHash, topologyDigest } from './digest';
import { directedEdgeEnds, directedEdgeName } from './serialize';
import {
  OBJECT_LISTS, QUAD_CHANNELS, handleRegister, quadRegister, vertexRegister,
  type RegisterKey,
} from './registers';
import { readVertex } from '../mesh/primitives';
import { isValidCell } from '../mesh/ops/contract';

/**
 * A topology edit as a statement about names (docs/039, *Topology travels as a delta*).
 *
 * Before stable ids a claim had to carry the whole document, because nothing smaller could say what a
 * renumbering did. With ids it can: which names went, which arrived, and how the survivors are wired — relative
 * to a structure every replica already agrees on, because the topology section of the drift digest says so.
 *
 * Array order is data. Digest sections chunk vertices and quads by index and `Patches.json` is ordinal, so two
 * replicas holding the same ids in a different order have drifted. The new order is therefore spelled as RUNS
 * over the old one: `[from, count]` keeps a stretch of the previous order as it stood, and a run that starts
 * with a string writes one element whole — a vertex with its position, or a quad with its corners named by
 * vertex id. Every operation today compacts survivors in order and appends what it mints, so a delete is two
 * or three runs; one that shuffled everything would degrade to a run per element and still be correct.
 *
 * Removal is implicit — whatever the runs do not keep is gone — and what the document RECORDS about removal,
 * its tombstones, is carried as the length of the old list that stands plus the names appended. Undoing an
 * operation restores a document whose tombstones are a prefix of the current ones, which this states as a
 * shorter `keep` and nothing added.
 *
 * A delta checks itself: `structure` is the topology-section hash its result must have. A mismatch means it
 * was applied to a different base from the one it was written against, which is drift, and is answered as
 * drift always is — with the whole document.
 */

/** One stretch of the new vertex order: a run of the previous order kept as it stood, or one vertex written
 *  whole with its position. A surviving vertex is never written; its position travels as a register. */
export type VertexRun = readonly [from: number, count: number] | readonly [id: string, x: number, y: number, z: number];

/** One stretch of the new quad order: a run of the previous order kept as it stood (corners remapped), or one
 *  quad written whole with its four corners named by vertex id — one this delta adds, or one it rewired. */
export type QuadRun = readonly [from: number, count: number] | readonly [id: string, a: string, b: string, c: string, d: string];

/** A T-node named by id rather than by index. */
export interface NamedTJunction {
  vertex: string;
  edge: [string, string];
  t: number;
}

/**
 * Presence is part of the structure: in every optional field `null` means the result has no such field, `[]`
 * means it has an empty one, and an absent key means "as the base had it". `structuralDocument` keeps an empty
 * list and drops an absent one, so the two hash differently, and real code produces both.
 */
export interface TopologyDelta {
  /** The new vertex order. */
  vertices: VertexRun[];
  /** The new quad order. */
  quads: QuadRun[];
  /** The whole free-edge list by vertex id, every time, or null when there is none. It is short, and carrying
   *  it means the result never depends on the claimant's base holding exactly the room's list. */
  freeEdges: [string, string][] | null;
  /** The whole T-node list, every time, or null when there is none. Every replica re-seats T-nodes from its
   *  own geometry, so its list can differ from the room's between claims; carrying the claimant's makes its
   *  seating the result's rather than leaving the result to depend on whose base the delta landed on. */
  tJunctions: NamedTJunction[] | null;
  /** The old tombstones that stand and the names after them; absent when unchanged. */
  tombstones?: { keep: number; add: string[] } | null;
  nextId: number;
  /** The topology-section hash the result must have. */
  structure: string;
}

/** The structure a delta is written against — what a replica last took as the room's. */
export interface TopologyBase {
  vertexIds: readonly string[];
  quadIds: readonly string[];
  quads: readonly (readonly number[])[];
  tombstones?: readonly string[];
}

/** A delta applied: the new document, and the register bookkeeping a replica's shadow needs. */
export interface AppliedDelta {
  doc: QuadMeshDoc;
  /** Registers that went with the geometry the delta removed, which a shadow forgets. */
  cleared: RegisterKey[];
  /** The vertex positions the delta wrote, which a shadow learns. */
  placed: [RegisterKey, V3][];
}

// ---- writing one ------------------------------------------------------------------------------------------

const cornerNames = (quad: readonly number[], vertexIds: readonly string[]): string[] =>
  quad.map(corner => vertexIds[corner]);

const sameNames = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, at) => name === b[at]);

const namedEdges = (edges: readonly (readonly [number, number])[], vertexIds: readonly string[]): [string, string][] =>
  edges.map(([a, b]) => [vertexIds[a], vertexIds[b]]);

/** Extend the last kept run when `from` continues it, or open a new one. */
function keep(runs: (VertexRun | QuadRun)[], from: number): void {
  const last = runs[runs.length - 1] as [number, number] | undefined;
  if (last && typeof last[0] === 'number' && last[0] + last[1] === from) last[1]++;
  else runs.push([from, 1]);
}

/**
 * The delta that takes `base` to `doc`'s structure.
 *
 * `base` is held by the caller rather than rebuilt here: a replica keeps the structure it last took as the
 * room's, and every mesh operation hands back fresh arrays, so the old ones are still intact afterwards.
 */
export function topologyDelta(base: TopologyBase, doc: QuadMeshDoc): TopologyDelta {
  const oldVertex = nameIndex(base.vertexIds);
  const vertices: VertexRun[] = [];
  doc.vertexIds.forEach((id, at) => {
    const was = oldVertex.get(id);
    if (was !== undefined) keep(vertices, was);
    else {
      const [x, y, z] = readVertex(doc.vertices, at);
      vertices.push([id, x, y, z]);
    }
  });

  const oldQuad = nameIndex(base.quadIds);
  const quads: QuadRun[] = [];
  doc.quadIds.forEach((id, at) => {
    const was = oldQuad.get(id);
    const corners = cornerNames(doc.quads[at], doc.vertexIds);
    if (was !== undefined && sameNames(cornerNames(base.quads[was], base.vertexIds), corners)) keep(quads, was);
    else quads.push([id, ...corners] as unknown as QuadRun);
  });

  const delta: TopologyDelta = {
    vertices, quads,
    freeEdges: doc.freeEdges === undefined ? null : namedEdges(doc.freeEdges, doc.vertexIds),
    tJunctions: doc.tJunctions === undefined ? null : doc.tJunctions.map(node => ({
      vertex: doc.vertexIds[node.vertex],
      edge: [doc.vertexIds[node.edge[0]], doc.vertexIds[node.edge[1]]],
      t: node.t,
    })),
    nextId: doc.nextId,
    structure: topologyDigest(doc, textHash),
  };

  const was = base.tombstones, now = doc.tombstones;
  if (now === undefined) { if (was !== undefined) delta.tombstones = null; }
  else {
    let stands = 0;
    if (was) while (stands < was.length && stands < now.length && was[stands] === now[stands]) stands++;
    if (was === undefined || stands !== was.length || stands !== now.length) {
      delta.tombstones = { keep: stands, add: now.slice(stands) };
    }
  }
  return delta;
}

// ---- applying one -----------------------------------------------------------------------------------------

/** Give a document copy its own object lists, their members and its effects graph — what a register write
 *  mutates in place that a structural rewrite does not already rebuild. A whole object is replaced in its list,
 *  and one of its fields is written onto the member itself (docs/039, *Objects*), so both are copied; the field
 *  values are replaced whole, never edited, so a member's own copy is shallow. */
function detachLists(doc: QuadMeshDoc): void {
  const record = doc as unknown as Record<string, unknown>;
  for (const list of OBJECT_LISTS) {
    const held = record[list];
    if (Array.isArray(held)) record[list] = held.map(member => member && typeof member === 'object' ? { ...member } : member);
  }
  if (doc.effects) doc.effects = structuredClone(doc.effects);
}

/**
 * A copy of a document that registers and deltas can be written onto while the original stays exactly as it
 * was — what lets a replica land several steps and still hand its editor a before and an after.
 *
 * Shallow wherever nothing is written in place: values are replaced whole by a register write, never edited, so
 * only the containers that hold them are copied.
 */
export function detachedDocument(doc: QuadMeshDoc): QuadMeshDoc {
  const copy = { ...doc, vertices: [...doc.vertices] } as QuadMeshDoc;
  const record = copy as unknown as Record<string, unknown>;
  if (doc.edgeHandles) copy.edgeHandles = { ...doc.edgeHandles };
  for (const [, channel] of QUAD_CHANNELS) {
    const held = record[channel];
    if (held && typeof held === 'object') record[channel] = { ...(held as object) };
  }
  detachLists(copy);
  return copy;
}

/** Why a delta could not be applied. Carried as a value rather than thrown, because the caller's answer to
 *  every one of them is the same — this replica's base is not the one the delta was written against. */
export class DeltaRefused extends Error {}

function refuse(why: string): never { throw new DeltaRefused(why); }

const isCount = (value: unknown, below: number): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= below;

const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isCoordinate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Apply a delta to a document, producing a new one, or say why it cannot be applied.
 *
 * The result is a new document object that shares no container a register write mutates in place with `doc`:
 * the structural arrays, the vertex buffer and the index-keyed channels are rebuilt, the object lists are
 * copied and the effects graph is cloned. That is what lets a replica write the delta's register changes onto
 * the result and still compare the document it had with the one it has now.
 *
 * Every check here is about refusing malformed input instead of throwing on it. The guarantee that the result
 * is exactly the structure the claimant holds is the `structure` hash, checked last.
 */
export function applyTopologyDelta(doc: QuadMeshDoc, input: unknown): { ok: true; applied: AppliedDelta } | { ok: false; error: string } {
  try {
    return { ok: true, applied: applyOrRefuse(doc, input) };
  } catch (error) {
    if (error instanceof DeltaRefused) return { ok: false, error: error.message };
    throw error;
  }
}

function applyOrRefuse(doc: QuadMeshDoc, input: unknown): AppliedDelta {
  if (!input || typeof input !== 'object') refuse('a topology delta has to be an object');
  const delta = input as Partial<TopologyDelta>;
  if (!Array.isArray(delta.vertices) || !Array.isArray(delta.quads)) refuse('a topology delta names its vertices and quads');
  if (!Number.isSafeInteger(delta.nextId) || delta.nextId! < doc.nextId) {
    refuse('a topology delta carries the next id, and never moves it backwards');
  }
  if (!isName(delta.structure)) refuse('a topology delta names the structure it produces');

  // Vertices: kept runs carry their position across, written ones bring their own.
  const oldVertexIds = doc.vertexIds;
  const oldVertexCount = oldVertexIds.length;
  const oldVertex = nameIndex(oldVertexIds);
  const vertexTo = new Int32Array(oldVertexCount).fill(-1);
  const vertexIds: string[] = [];
  const vertices: number[] = [];
  const placed: [RegisterKey, V3][] = [];
  for (const run of delta.vertices as readonly unknown[]) {
    if (!Array.isArray(run)) refuse('a vertex run has to be a list');
    if (typeof run[0] === 'number') {
      const [from, count] = run as unknown[];
      if (run.length !== 2 || !isCount(from, oldVertexCount) || !isCount(count, oldVertexCount - (from as number))
        || count === 0) refuse('a kept vertex run reaches outside the vertices this document has');
      for (let at = from as number, end = at + (count as number); at < end; at++) {
        if (vertexTo[at] !== -1) refuse(`vertex ${oldVertexIds[at]} is kept twice`);
        vertexTo[at] = vertexIds.length;
        vertexIds.push(oldVertexIds[at]);
        vertices.push(doc.vertices[at * 3], doc.vertices[at * 3 + 1], doc.vertices[at * 3 + 2]);
      }
    } else {
      const [id, x, y, z] = run as unknown[];
      if (run.length !== 4 || !isName(id) || !isCoordinate(x) || !isCoordinate(y) || !isCoordinate(z)) {
        refuse('a written vertex is an id and a position');
      }
      // A vertex this document still holds keeps its place in a run and moves through its register; writing it
      // here would drop the creases that hang off it.
      if (oldVertex.has(id as string)) refuse(`vertex ${id as string} is written although this document has it`);
      vertexIds.push(id as string);
      vertices.push(x as number, y as number, z as number);
      placed.push([vertexRegister(id as string), [x as number, y as number, z as number]]);
    }
  }
  const vertexAt = new Map<string, number>();
  vertexIds.forEach((id, at) => {
    if (vertexAt.has(id)) refuse(`vertex ${id} appears twice`);
    vertexAt.set(id, at);
  });
  const corner = (name: unknown): number => {
    const at = isName(name) ? vertexAt.get(name) : undefined;
    return at === undefined ? refuse(`the delta names a vertex the result does not have: ${String(name)}`) : at;
  };

  // Quads: kept runs remap their corners, written ones name them. A written quad the document already has is
  // one the operation rewired, and its attributes follow its id.
  const oldQuadIds = doc.quadIds;
  const oldQuadCount = oldQuadIds.length;
  const oldQuad = nameIndex(oldQuadIds);
  const quadTo = new Int32Array(oldQuadCount).fill(-1);
  const quadIds: string[] = [];
  const quads: number[][] = [];
  for (const run of delta.quads as readonly unknown[]) {
    if (!Array.isArray(run)) refuse('a quad run has to be a list');
    if (typeof run[0] === 'number') {
      const [from, count] = run as unknown[];
      if (run.length !== 2 || !isCount(from, oldQuadCount) || !isCount(count, oldQuadCount - (from as number))
        || count === 0) refuse('a kept quad run reaches outside the quads this document has');
      for (let at = from as number, end = at + (count as number); at < end; at++) {
        if (quadTo[at] !== -1) refuse(`quad ${oldQuadIds[at]} is kept twice`);
        quadTo[at] = quadIds.length;
        quadIds.push(oldQuadIds[at]);
        quads.push(doc.quads[at].map(was => {
          const now = vertexTo[was] ?? -1;
          return now < 0 ? refuse(`quad ${oldQuadIds[at]} is kept but a corner of it is not`) : now;
        }));
      }
    } else {
      const [id, ...corners] = run as unknown[];
      if (!isName(id) || corners.length !== 4) refuse('a written quad is an id and its four corners');
      const was = oldQuad.get(id as string);
      if (was !== undefined) {
        if (quadTo[was] !== -1) refuse(`quad ${id as string} is kept twice`);
        quadTo[was] = quadIds.length;
      }
      const cell = corners.map(corner);
      if (!isValidCell(cell)) refuse(`quad ${id as string} is neither a quad nor an [A,B,C,C] wedge`);
      quadIds.push(id as string);
      quads.push(cell);
    }
  }
  const quadSeen = new Set<string>();
  for (const id of quadIds) {
    if (quadSeen.has(id)) refuse(`quad ${id} appears twice`);
    quadSeen.add(id);
  }

  const cleared: RegisterKey[] = [];
  for (let at = 0; at < oldVertexCount; at++) if (vertexTo[at] < 0) cleared.push(vertexRegister(oldVertexIds[at]));

  const next = { ...doc, vertices, vertexIds, quads, quadIds, nextId: delta.nextId! } as QuadMeshDoc;
  const record = next as unknown as Record<string, unknown>;

  // Creases follow both their ends; one whose end went goes with it.
  if (doc.edgeHandles) {
    const handles: Record<string, V3> = {};
    let carried = 0, held = 0;
    for (const key in doc.edgeHandles) {
      held++;
      const ends = directedEdgeEnds(key);
      const from = ends ? Number(ends[0]) : NaN, to = ends ? Number(ends[1]) : NaN;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0
        || from >= oldVertexCount || to >= oldVertexCount) continue;
      const nowFrom = vertexTo[from], nowTo = vertexTo[to];
      if (nowFrom >= 0 && nowTo >= 0) { handles[directedEdgeName(nowFrom, nowTo)] = doc.edgeHandles[key]; carried++; }
      else cleared.push(handleRegister(oldVertexIds[from], oldVertexIds[to]));
    }
    // A channel the delta empties goes, as an operation's own rewrite drops it; one that was already empty
    // stays exactly as the document had it.
    if (carried || !held) next.edgeHandles = handles; else delete next.edgeHandles;
  }
  for (const [field, channel] of QUAD_CHANNELS) {
    const old = doc[channel] as Record<number, unknown> | undefined;
    if (!old) continue;
    const out: Record<number, unknown> = {};
    let carried = 0, held = 0;
    for (const key in old) {
      held++;
      const was = Number(key);
      if (!Number.isInteger(was) || was < 0 || was >= oldQuadCount) continue;
      const now = quadTo[was];
      if (now >= 0) { out[now] = old[was]; carried++; }
      else cleared.push(quadRegister(oldQuadIds[was], field));
    }
    if (carried || !held) record[channel] = out; else delete record[channel];
  }

  // Free edges and T-nodes travel whole, every time.
  if (delta.freeEdges === null) delete next.freeEdges;
  else {
    if (!Array.isArray(delta.freeEdges)) refuse('a topology delta carries its free edges');
    next.freeEdges = delta.freeEdges.map(edge => {
      if (!Array.isArray(edge) || edge.length !== 2) refuse('a free edge is two vertex ids');
      return [corner(edge[0]), corner(edge[1])] as [number, number];
    });
  }

  if (delta.tJunctions === null) delete next.tJunctions;
  else {
    if (!Array.isArray(delta.tJunctions)) refuse('a topology delta carries its T-nodes');
    next.tJunctions = delta.tJunctions.map((node): EdgeEmbeddedTJunction => {
      if (!node || typeof node !== 'object' || !Array.isArray(node.edge) || node.edge.length !== 2 || !isCoordinate(node.t)) {
        refuse('a T-node is a vertex, a host edge and a parameter');
      }
      return { vertex: corner(node.vertex), edge: [corner(node.edge[0]), corner(node.edge[1])], t: node.t };
    });
  }

  if (delta.tombstones === null) delete next.tombstones;
  else if (delta.tombstones !== undefined) {
    const { keep: stands, add } = delta.tombstones as { keep?: unknown; add?: unknown };
    const old = doc.tombstones ?? [];
    if (!isCount(stands, old.length) || !Array.isArray(add) || !add.every(isName)) {
      refuse('tombstones are a prefix of the old list and the names appended');
    }
    next.tombstones = [...old.slice(0, stands as number), ...(add as string[])];
  }

  if (next.tombstones?.some(id => vertexAt.has(id) || quadSeen.has(id))) {
    refuse('the delta leaves a name both live and tombstoned');
  }
  detachLists(next);
  if (topologyDigest(next, textHash) !== delta.structure) {
    refuse('the delta did not produce the structure it names, so it was written against another base');
  }
  return { doc: next, cleared, placed };
}
