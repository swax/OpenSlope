import type { MeshControlPointId } from './control-point-types';
import type { QuadMeshDoc } from '../doc/types';
import { meshFromDoc } from './topology';
import { liveQuadEdges } from './primitives';

/** Whether one live patch is protected. Only literal `true` is accepted so malformed saved values cannot
 * accidentally turn a patch into an uneditable region. */
export const quadIsLocked = (doc: QuadMeshDoc, quad: number): boolean => doc.quadLocked?.[quad] === true;

/** Every corner shared by at least one locked patch. A shared corner must stay put or the protected patch
 * would move along with an otherwise-unlocked neighbour. */
export function lockedVertexSet(doc: QuadMeshDoc): Set<number> {
  const out = new Set<number>();
  if (!doc.quadLocked) return out;
  for (const key of Object.keys(doc.quadLocked)) {
    const quad = +key;
    if (!quadIsLocked(doc, quad)) continue;
    for (const vertex of doc.quads[quad] ?? []) out.add(vertex);
  }
  return out;
}

/** Every topology edge used by a locked patch, in canonical endpoint order. Both directed Bézier controls on
 * such an edge shape the protected surface and are therefore protected together. */
export function lockedEdgeSet(doc: QuadMeshDoc): Set<string> {
  const out = new Set<string>();
  if (!doc.quadLocked) return out;
  for (const key of Object.keys(doc.quadLocked)) {
    const quad = +key, corners = doc.quads[quad];
    if (!quadIsLocked(doc, quad) || !corners) continue;
    for (const [a, b] of liveQuadEdges(corners)) out.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  return out;
}

export function vertexIsLocked(doc: QuadMeshDoc, vertex: number, locked = lockedVertexSet(doc)): boolean {
  return locked.has(vertex);
}

export function edgeIsLocked(doc: QuadMeshDoc, a: number, b: number, locked = lockedEdgeSet(doc)): boolean {
  return locked.has(a < b ? `${a},${b}` : `${b},${a}`);
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

/** Lock or unlock patches without changing their current surface.
 *
 * Locking first materializes every effective boundary handle used by the new protected patches. Automatic
 * Bessel handles otherwise read neighbouring vertices, so sculpting one row outside a lock could reshape the
 * supposedly frozen patch without moving any of its own corners. Keeping those current offsets explicit
 * severs that hidden dependency. Unlocking retains the offsets: protection changes editability, never shape. */
export function setQuadsLocked(doc: QuadMeshDoc, quads: readonly number[], locked: boolean): number {
  const valid = [...new Set(quads)]
    .filter(quad => Number.isInteger(quad) && quad >= 0 && quad < doc.quads.length)
    .sort((a, b) => a - b);
  if (!valid.length) return 0;

  if (locked) {
    const { edgeHandle } = meshFromDoc(doc);
    const handles = (doc.edgeHandles ??= {});
    const edges = new Map<string, [number, number]>();
    for (const quad of valid) for (const [a, b] of liveQuadEdges(doc.quads[quad])) {
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, a < b ? [a, b] : [b, a]);
    }
    // Read every effective value before writing any override: extraordinary-pole automatic tangents can read
    // the complete fan, so a partially materialized fan must not become the source for the next edge.
    const captured = [...edges.values()].flatMap(([a, b]) => [
      { from: a, to: b, offset: edgeHandle(a, b) },
      { from: b, to: a, offset: edgeHandle(b, a) },
    ]);
    for (const handle of captured) handles[`${handle.from}>${handle.to}`] = [...handle.offset];
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
