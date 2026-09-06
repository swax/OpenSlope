import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendMeshIds } from '../../doc/ids';
import { add, cross, dot, mul, norm, sub } from '../../math/vec';
import { buildQuadMesh, meshEdgeHandles, meshAdjacency } from '../topology';
import { ekey, checkManifold } from './contract';
import { orderEdgeChain } from './edge-chains';
import { readVertex, writeVertex } from '../primitives';

/**
 * The rip: un-stitch a connected interior edge path into two boundary lips separated by a gap, the inverse of
 * a weld. Quad ids stay stable — only the consistently-wound side of each split vertex's fan is reassigned.
 */

export type EdgeRipResult = {
  ok: true;
  doc: QuadMeshDoc;
  /** The two new boundary chains, in path order. They share only the pinned endpoints. */
  lips: [[number, number][], [number, number][]];
  /** Original interior path vertices and their duplicated partners, in path order. */
  splitVertices: [number, number][];
} | { ok: false; error: string };

/**
 * RIP — un-stitch a connected interior edge path into two boundary lips. The path endpoints stay pinned; every
 * interior path vertex is duplicated and the consistently-wound side of its incident quad fan is reassigned to
 * that duplicate. The two copies move half of `gap` in opposite directions across the surface, perpendicular to
 * the local path tangent, so the resulting opening is `gap` metres wide.
 *
 * Effective handles touching the path are materialised before the neighbour rings change, then copied onto the
 * matching edge on each lip. Quad ids and all quad-keyed paint / texture / orientation / twist maps stay stable.
 */
export function applyEdgeRip(doc: QuadMeshDoc, edges: readonly [number, number][], gap = 1): EdgeRipResult {
  if (edges.length < 2) return { ok: false, error: 'Rip needs at least two selected edges.' };
  if (!Number.isFinite(gap) || gap <= 0) return { ok: false, error: 'Rip gap must be greater than zero.' };
  const chain = orderEdgeChain(edges);
  if (!chain) return { ok: false, error: 'Rip needs one connected open edge path — not separate runs, a ring, or a branch.' };

  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const adj = meshAdjacency(mesh), effectiveHandle = meshEdgeHandles(mesh, doc.edgeHandles);
  const selected = new Set(edges.map(([a, b]) => ekey(a, b)));
  const pos = (id: number): V3 => readVertex(doc.vertices, id);

  // Every selected edge needs two surface neighbours. Do not infer left/right from quad winding: imported and
  // hand-edited charts can carry locally reversed storage while still being a perfectly usable manifold.
  const edgeQuads: number[][] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1], incident = adj.edgeQuads.get(ekey(a, b)) ?? [];
    if (incident.length !== 2)
      return { ok: false, error: 'Rip only works on interior surface edges with a patch on both sides.' };
    edgeQuads.push(incident);
  }

  /** The quad-fan sector at path vertex `chain[i]` reached from `seed` without crossing either selected path
   * edge. This remains well-defined at ordinary 3/5 poles: valence changes the sector size, not which side it is. */
  const sectorFrom = (i: number, seed: number): Set<number> => {
    const vertex = chain[i];
    const incident = new Set<number>();
    for (const neighbor of adj.neighbors[vertex] ?? [])
      for (const q of adj.edgeQuads.get(ekey(vertex, neighbor)) ?? []) incident.add(q);
    const component = new Set<number>(), pending = [seed];
    while (pending.length) {
      const q = pending.pop()!;
      if (component.has(q)) continue;
      component.add(q);
      for (const neighbor of adj.neighbors[vertex] ?? []) {
        if (selected.has(ekey(vertex, neighbor))) continue;
        const around = adj.edgeQuads.get(ekey(vertex, neighbor)) ?? [];
        if (around.includes(q)) for (const other of around) if (incident.has(other) && !component.has(other)) pending.push(other);
      }
    }
    return component;
  };

  // Pick either side of the first edge, then continue through the SAME local fan sector at each path vertex.
  // Try both starts: a rim-adjacent or unusually folded fan may make only one direction traceable, and neither
  // choice should depend on arbitrary quad ids or winding.
  const traceSide = (start: number): Map<number, Set<number>> | null => {
    const result = new Map<number, Set<number>>();
    let previousSideQuad = start;
    for (let i = 1; i < chain.length - 1; i++) {
      const component = sectorFrom(i, previousSideQuad);
      const next = edgeQuads[i].filter(q => component.has(q));
      if (next.length !== 1) return null;
      result.set(chain[i], component);
      previousSideQuad = next[0];
    }
    return result;
  };
  const starts = [...edgeQuads[0]].sort((a, b) => a - b);
  const sideAtVertex = traceSide(starts[0]) ?? traceSide(starts[1]);
  if (!sideAtVertex)
    return { ok: false, error: 'Rip could not trace one continuous side through the selected edge path.' };

  const directions = new Map<number, V3>();
  for (let i = 1; i < chain.length - 1; i++) {
    const vertex = chain[i], prev = chain[i - 1], next = chain[i + 1], component = sideAtVertex.get(vertex)!;
    const incident = new Set<number>();
    for (const neighbor of adj.neighbors[vertex] ?? [])
      for (const q of adj.edgeQuads.get(ekey(vertex, neighbor)) ?? []) incident.add(q);
    const p = pos(vertex), tangent = norm(sub(pos(next), pos(prev)));
    let normal: V3 = [0, 0, 0], toward: V3 = [0, 0, 0];
    for (const q of incident) {
      const [A, B, C, D] = doc.quads[q], pa = pos(A), pb = pos(B), pc = pos(C), pd = pos(D);
      normal = add(normal, add(cross(sub(pd, pa), sub(pc, pa)), cross(sub(pb, pa), sub(pd, pa))));
    }
    for (const q of component) {
      const center = doc.quads[q].reduce<V3>((sum, corner) => add(sum, pos(corner)), [0, 0, 0]);
      toward = add(toward, sub(mul(center, 1 / doc.quads[q].length), p));
    }
    let across = cross(norm(normal), tangent);
    if (Math.hypot(across[0], across[1], across[2]) < 1e-8)
      across = sub(toward, mul(tangent, dot(toward, tangent)));
    if (Math.hypot(across[0], across[1], across[2]) < 1e-8)
      return { ok: false, error: 'Rip could not determine a perpendicular direction at one of the path vertices.' };
    across = norm(across);
    if (dot(across, toward) < 0) across = mul(across, -1);
    directions.set(vertex, across);
  }

  const vertices = doc.vertices.slice(), duplicate = new Map<number, number>();
  for (const vertex of chain.slice(1, -1)) {
    const copy = vertices.length / 3, p = pos(vertex), across = directions.get(vertex)!;
    duplicate.set(vertex, copy);
    const half = mul(across, gap / 2);
    writeVertex(vertices, vertex, sub(p, half));
    vertices.push(...add(p, half));
  }

  const quads = doc.quads.map((corners, q) => corners.map(vertex =>
    sideAtVertex.get(vertex)?.has(q) ? duplicate.get(vertex)! : vertex));
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };

  // Rebuild sparse handles over the new edge set. An edge touching a split vertex receives its frozen effective
  // handle even when it was automatic before; otherwise changing the neighbour fan would reshape the untouched
  // parts of the two source sheets. Both copies of a ripped edge inherit the same original boundary curve.
  const origin = (vertex: number): number => {
    for (const [old, copy] of duplicate) if (copy === vertex) return old;
    return vertex;
  };
  const surfaceEdges = new Map<string, [number, number]>();
  for (const [A, B, C, D] of quads) for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][])
    surfaceEdges.set(ekey(a, b), [a, b]);
  for (const [a, b] of doc.freeEdges ?? []) surfaceEdges.set(ekey(a, b), [a, b]);
  const edgeHandles: Record<string, V3> = {};
  const splitSet = new Set(chain.slice(1, -1));
  for (const [a, b] of surfaceEdges.values()) for (const [from, to] of [[a, b], [b, a]] as [number, number][]) {
    const oldFrom = origin(from), oldTo = origin(to);
    const stored = doc.edgeHandles?.[`${oldFrom}>${oldTo}`];
    if (stored) edgeHandles[`${from}>${to}`] = [...stored] as V3;
    else if (splitSet.has(oldFrom) || splitSet.has(oldTo)) {
      const h = effectiveHandle(oldFrom, oldTo);
      edgeHandles[`${from}>${to}`] = [h[0], h[1], h[2]];
    }
  }

  const originalLip: [number, number][] = [], duplicateLip: [number, number][] = [];
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1], da = duplicate.get(a) ?? a, db = duplicate.get(b) ?? b;
    originalLip.push(a < b ? [a, b] : [b, a]);
    duplicateLip.push(da < db ? [da, db] : [db, da]);
  }
  const out: QuadMeshDoc = {
    ...doc, vertices, quads, ...appendMeshIds(doc, duplicate.size, 0),
  };
  if (Object.keys(edgeHandles).length) out.edgeHandles = edgeHandles; else delete out.edgeHandles;
  return {
    ok: true,
    doc: out,
    lips: [originalLip, duplicateLip],
    splitVertices: chain.slice(1, -1).map(vertex => [vertex, duplicate.get(vertex)!]),
  };
}
