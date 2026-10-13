import type { MeshControlPointId } from './control-point-types';
import type { QuadMeshDoc } from '../doc/types';
import { meshFromDoc } from './topology';
import { liveQuadEdges, undirectedEdgeKey } from './primitives';

/** Whether one live patch is protected. Only literal `true` is accepted so malformed saved values cannot
 * accidentally turn a patch into an uneditable region. */
export const quadIsLocked = (doc: QuadMeshDoc, quad: number): boolean => doc.quadLocked?.[quad] === true;

/** The two ends of one `edgeLocked` key, or null when the key names no edge between two distinct vertices. */
export function edgeLockEnds(key: string): [number, number] | null {
  const cut = key.indexOf(',');
  const a = Number(key.slice(0, cut)), b = Number(key.slice(cut + 1));
  return cut > 0 && Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 && a !== b ? [a, b] : null;
}

/** Whether this edge carries a lock of its own — as opposed to being locked because a locked patch uses it. */
export const edgeLockIsSet = (doc: QuadMeshDoc, a: number, b: number): boolean =>
  doc.edgeLocked?.[undirectedEdgeKey(a, b)] === true;

/** Every edge locked on its own, as its two ends. */
export function explicitLockedEdges(doc: QuadMeshDoc): [number, number][] {
  const out: [number, number][] = [];
  for (const key in doc.edgeLocked ?? {}) {
    const ends = doc.edgeLocked![key] === true ? edgeLockEnds(key) : null;
    if (ends) out.push(ends);
  }
  return out;
}

/** Every corner a lock holds: the corners of locked patches and the ends of locked edges. A shared corner must
 * stay put or the protected patch or curve would move along with an otherwise-unlocked neighbour. */
export function lockedVertexSet(doc: QuadMeshDoc): Set<number> {
  const out = new Set<number>();
  if (doc.quadLocked) {
    for (const key of Object.keys(doc.quadLocked)) {
      const quad = +key;
      if (!quadIsLocked(doc, quad)) continue;
      for (const vertex of doc.quads[quad] ?? []) out.add(vertex);
    }
  }
  if (doc.edgeLocked) for (const [a, b] of explicitLockedEdges(doc)) { out.add(a); out.add(b); }
  return out;
}

/** Every locked topology edge, in canonical endpoint order: each edge of a locked patch, and each edge locked on
 * its own. Both directed Bézier controls on such an edge shape the protected curve and are protected together. */
export function lockedEdgeSet(doc: QuadMeshDoc): Set<string> {
  const out = new Set<string>();
  if (doc.quadLocked) {
    for (const key of Object.keys(doc.quadLocked)) {
      const quad = +key, corners = doc.quads[quad];
      if (!quadIsLocked(doc, quad) || !corners) continue;
      for (const [a, b] of liveQuadEdges(corners)) out.add(undirectedEdgeKey(a, b));
    }
  }
  if (doc.edgeLocked) for (const [a, b] of explicitLockedEdges(doc)) out.add(undirectedEdgeKey(a, b));
  return out;
}

export function vertexIsLocked(doc: QuadMeshDoc, vertex: number, locked = lockedVertexSet(doc)): boolean {
  return locked.has(vertex);
}

export function edgeIsLocked(doc: QuadMeshDoc, a: number, b: number, locked = lockedEdgeSet(doc)): boolean {
  return locked.has(undirectedEdgeKey(a, b));
}

/** Numeric control-point protection used at the write boundary. */
export function controlPointIsLocked(
  doc: QuadMeshDoc,
  id: MeshControlPointId<number>,
  vertices = lockedVertexSet(doc),
  edges = lockedEdgeSet(doc),
): boolean {
  if (id.kind === 'vertex') return vertices.has(id.vertex);
  if (id.kind === 'edge') return edgeIsLocked(doc, id.from, id.to, edges);
  return quadIsLocked(doc, id.quad);
}

/**
 * Write every effective handle these edges carry as an explicit override, both directions.
 *
 * Automatic Bessel handles read neighbouring vertices, so sculpting one row outside a lock could reshape the
 * supposedly frozen curve without moving any of its own corners. Keeping the current offsets explicit severs
 * that hidden dependency. Every value is read before any is written: extraordinary-pole automatic tangents can
 * read the complete fan, so a partially materialized fan must not become the source for the next edge.
 */
function materializeHandles(doc: QuadMeshDoc, edges: Iterable<readonly [number, number]>): void {
  const { edgeHandle } = meshFromDoc(doc);
  const captured = [...edges].flatMap(([a, b]) => [
    { from: a, to: b, offset: edgeHandle(a, b) },
    { from: b, to: a, offset: edgeHandle(b, a) },
  ]);
  if (!captured.length) return;
  const handles = (doc.edgeHandles ??= {});
  for (const handle of captured) handles[`${handle.from}>${handle.to}`] = [...handle.offset];
}

/** Lock or unlock patches without changing their current surface.
 *
 * Locking first materializes every effective boundary handle used by the new protected patches
 * (`materializeHandles`). Unlocking retains the offsets: protection changes editability, never shape. */
export function setQuadsLocked(doc: QuadMeshDoc, quads: readonly number[], locked: boolean): number {
  const valid = [...new Set(quads)]
    .filter(quad => Number.isInteger(quad) && quad >= 0 && quad < doc.quads.length)
    .sort((a, b) => a - b);
  if (!valid.length) return 0;

  if (locked) {
    const edges = new Map<string, [number, number]>();
    for (const quad of valid) for (const [a, b] of liveQuadEdges(doc.quads[quad])) {
      if (a !== b) edges.set(undirectedEdgeKey(a, b), a < b ? [a, b] : [b, a]);
    }
    materializeHandles(doc, edges.values());
    const map = { ...(doc.quadLocked ?? {}) };
    for (const quad of valid) map[quad] = true;
    doc.quadLocked = map;
  } else if (doc.quadLocked) {
    const map = { ...doc.quadLocked };
    for (const quad of valid) delete map[quad];
    if (Object.keys(map).length) doc.quadLocked = map; else delete doc.quadLocked;
  }
  return valid.length;
}

/** Every edge the mesh carries — patch sides and free edges — keyed canonically. */
function liveEdgeKeys(doc: QuadMeshDoc): Set<string> {
  const live = new Set<string>();
  for (const quad of doc.quads) for (const [a, b] of liveQuadEdges(quad)) if (a !== b) live.add(undirectedEdgeKey(a, b));
  for (const [a, b] of doc.freeEdges ?? []) if (a !== b) live.add(undirectedEdgeKey(a, b));
  return live;
}

/** Lock or unlock single edges without changing their current curve — the edge twin of `setQuadsLocked`.
 * Only edges the mesh carries can be locked; unlocking only clears a lock the edge holds on its own (an edge of
 * a locked patch stays locked with its patch). Returns how many edges changed state. */
export function setEdgesLocked(doc: QuadMeshDoc, edges: readonly (readonly [number, number])[], locked: boolean): number {
  const named = new Map<string, [number, number]>();
  for (const [a, b] of edges) {
    if (Number.isInteger(a) && Number.isInteger(b) && a !== b && a >= 0 && b >= 0) {
      named.set(undirectedEdgeKey(a, b), a < b ? [a, b] : [b, a]);
    }
  }
  if (locked) {
    const live = liveEdgeKeys(doc);
    const fresh = [...named].filter(([key]) => live.has(key) && doc.edgeLocked?.[key] !== true);
    if (!fresh.length) return 0;
    materializeHandles(doc, fresh.map(([, ends]) => ends));
    const map = { ...(doc.edgeLocked ?? {}) };
    for (const [key] of fresh) map[key] = true;
    doc.edgeLocked = map;
    return fresh.length;
  }
  if (!doc.edgeLocked) return 0;
  const map = { ...doc.edgeLocked };
  let changed = 0;
  for (const key of named.keys()) if (map[key] === true) { delete map[key]; changed++; }
  if (Object.keys(map).length) doc.edgeLocked = map; else delete doc.edgeLocked;
  return changed;
}

/** A selection as the lock model reads it: corners, edges and patches by index. */
export interface LockSelection {
  vertices?: readonly number[];
  edges?: readonly (readonly [number, number])[];
  quads?: readonly number[];
}

/**
 * The locks that hold any part of a selection in place — exactly what has to go for every selected element to
 * be free: a selected patch's own lock; for a selected edge, its own lock and every locked patch it borders;
 * for a selected corner, every locked patch and locked edge meeting there. A patch held only along its border
 * by a neighbour's lock is not itself locked, and that neighbour is left alone.
 */
export function locksHolding(doc: QuadMeshDoc, selection: LockSelection): { quads: number[]; edges: [number, number][] } {
  const quads = new Set<number>(), edges = new Map<string, [number, number]>();
  const vertices = new Set(selection.vertices ?? []);
  const selectedEdges = new Set((selection.edges ?? []).map(([a, b]) => undirectedEdgeKey(a, b)));
  for (const quad of selection.quads ?? []) if (quadIsLocked(doc, quad)) quads.add(quad);
  if (doc.quadLocked && (vertices.size || selectedEdges.size)) {
    for (const key of Object.keys(doc.quadLocked)) {
      const quad = +key, corners = doc.quads[quad];
      if (!quadIsLocked(doc, quad) || !corners) continue;
      if (corners.some(vertex => vertices.has(vertex))
        || liveQuadEdges(corners).some(([a, b]) => selectedEdges.has(undirectedEdgeKey(a, b)))) quads.add(quad);
    }
  }
  for (const [a, b] of explicitLockedEdges(doc)) {
    const key = undirectedEdgeKey(a, b);
    if (selectedEdges.has(key) || vertices.has(a) || vertices.has(b)) edges.set(key, a < b ? [a, b] : [b, a]);
  }
  return { quads: [...quads].sort((a, b) => a - b), edges: [...edges.values()] };
}

/**
 * Edges locked on their own that a Delete or Dissolve would take with it: a named edge, any edge at a named
 * corner, and any edge whose every patch is among `removedQuads`. A lock is a promise the curve stays, so the
 * caller refuses rather than letting the lock vanish with its edge.
 */
export function edgeLocksTaken(doc: QuadMeshDoc, selection: Pick<LockSelection, 'vertices' | 'edges'>,
  removedQuads: readonly number[] = []): [number, number][] {
  const locked = explicitLockedEdges(doc);
  if (!locked.length) return [];
  const vertices = new Set(selection.vertices ?? []);
  const named = new Set((selection.edges ?? []).map(([a, b]) => undirectedEdgeKey(a, b)));
  const removed = new Set(removedQuads);
  const bordering = new Map<string, number[]>();
  if (removed.size) {
    doc.quads.forEach((corners, quad) => {
      for (const [a, b] of liveQuadEdges(corners)) {
        const key = undirectedEdgeKey(a, b), held = bordering.get(key);
        if (held) held.push(quad); else bordering.set(key, [quad]);
      }
    });
  }
  return locked.filter(([a, b]) => {
    const key = undirectedEdgeKey(a, b), quads = bordering.get(key);
    return named.has(key) || vertices.has(a) || vertices.has(b) || (!!quads?.length && quads.every(quad => removed.has(quad)));
  });
}

/** Carry an edge lock onto the halves of a split edge. `keepParent` is a T-junction's split, where the unsplit
 * host edge lives on beside its halves and keeps its own lock. A lock the parent did not hold adds nothing. */
export function splitEdgeLock(edgeLocked: Record<string, true> | undefined, from: number, to: number, vertex: number,
  keepParent = false): void {
  const parent = undirectedEdgeKey(from, to);
  if (edgeLocked?.[parent] !== true) return;
  if (!keepParent) delete edgeLocked[parent];
  edgeLocked[undirectedEdgeKey(from, vertex)] = true;
  edgeLocked[undirectedEdgeKey(vertex, to)] = true;
}
