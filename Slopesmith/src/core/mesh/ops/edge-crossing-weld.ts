import type { QuadMeshDoc, V3 } from '../../doc/types';
import { splitCubic } from '../../math/bezier';
import { add } from '../../math/vec';
import type { EdgeCrossing } from '../edge-crossings';
import { findEdgeCrossings } from '../edge-crossings';
import { remapTJunctionsForEdgeSplits } from '../t-junctions';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import {
  checkManifold, createQuadSurfaceMaps, ekey, finishMeshRewrite,
  inheritQuadSurface, locateVertex, looseVertexIds,
} from './contract';
import { edgePointAt } from './cut-primitives';
import { readVertex } from '../primitives';
import { cellsFromPerimeter } from './surface-cut';
import { applyVertexWeld } from './weld';

export type EdgeCrossingWeldResult =
  | { ok: true; doc: QuadMeshDoc; vertex: number; splitEdges: [[[number, number], [number, number]], [[number, number], [number, number]]] }
  | { ok: false; error: string };

/** Insert one shared vertex into two close, non-connected edge interiors. Surface edges split every incident
 * patch; free edges become two free edges. Both curves meet at the midpoint of their closest points. */
export function applyEdgeCrossingWeld(doc: QuadMeshDoc, crossing: EdgeCrossing): EdgeCrossingWeldResult {
  const { mesh, edgeHandle } = (() => {
    const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
    return { mesh, edgeHandle: meshEdgeHandles(mesh, doc.edgeHandles) };
  })();
  const adj = meshAdjacency(mesh), [first, second] = crossing.edges;
  const validEdge = ([a, b]: [number, number]) => a !== b && (adj.neighbors[a] ?? []).includes(b);
  if (!validEdge(first) || !validEdge(second)) return { ok: false, error: 'Those diagnostic edges are stale — select the crossing again.' };
  if (first.some(vertex => second.includes(vertex))) return { ok: false, error: 'The edges already share a vertex.' };
  const q1 = adj.edgeQuads.get(ekey(first[0], first[1])) ?? [], q2 = adj.edgeQuads.get(ekey(second[0], second[1])) ?? [];
  if (q1.some(quad => q2.includes(quad)))
    return { ok: false, error: 'Both crossing edges belong to the same patch; split that patch manually first.' };
  if (crossing.t.some(t => !Number.isFinite(t) || t <= 1e-3 || t >= 1 - 1e-3))
    return { ok: false, error: 'The crossing is too close to an existing endpoint.' };

  const pos = (id: number): V3 => readVertex(doc.vertices, id);
  const edgePoints = [first, second].map((edge, i) => edgePointAt(edge[0], edge[1], crossing.t[i], edgeHandle, pos)) as [V3, V3];
  const point: V3 = [(edgePoints[0][0] + edgePoints[1][0]) / 2, (edgePoints[0][1] + edgePoints[1][1]) / 2,
    (edgePoints[0][2] + edgePoints[1][2]) / 2];
  const vertices = [...doc.vertices, ...point], vertex = doc.vertices.length / 3;
  const edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}) };
  for (const [edge, t] of [[first, crossing.t[0]], [second, crossing.t[1]]] as [[number, number], number][]) {
    const [a, b] = edge, p0 = pos(a), p3 = pos(b);
    const split = splitCubic(p0, add(p0, edgeHandle(a, b)), add(p3, edgeHandle(b, a)), p3, t);
    edgeHandles[`${a}>${vertex}`] = [split.left[1][0] - p0[0], split.left[1][1] - p0[1], split.left[1][2] - p0[2]];
    edgeHandles[`${vertex}>${a}`] = [split.left[2][0] - point[0], split.left[2][1] - point[1], split.left[2][2] - point[2]];
    edgeHandles[`${vertex}>${b}`] = [split.right[1][0] - point[0], split.right[1][1] - point[1], split.right[1][2] - point[2]];
    edgeHandles[`${b}>${vertex}`] = [split.right[2][0] - p3[0], split.right[2][1] - p3[1], split.right[2][2] - p3[2]];
    delete edgeHandles[`${a}>${b}`]; delete edgeHandles[`${b}>${a}`];
  }

  const targets = new Set([ekey(first[0], first[1]), ekey(second[0], second[1])]);
  const surfaceMaps = createQuadSurfaceMaps(doc);
  const { quadPaint, quadTex, quadOrient, quadLocked, quadLabels } = surfaceMaps;
  const quadTwist: Record<number, [V3, V3, V3, V3]> | undefined = doc.quadTwist ? {} : undefined;
  const quads: number[][] = [];
  // Every patch is re-emitted, so identity travels with the source: an unsplit patch and the FIRST piece of a
  // split one are the same patch still, and each further piece is new.
  const quadIds: (string | null)[] = [];
  for (let qid = 0; qid < doc.quads.length; qid++) {
    const q = doc.quads[qid], base = [q[0], q[1], q[3], q[2]], perimeter: number[] = [];
    let splits = 0;
    for (let i = 0; i < base.length; i++) {
      const a = base[i], b = base[(i + 1) % base.length];
      perimeter.push(a);
      if (targets.has(ekey(a, b))) { perimeter.push(vertex); splits++; }
    }
    if (splits > 1) return { ok: false, error: 'Both crossing edges enter the same patch; split it manually first.' };
    const emitted = splits ? cellsFromPerimeter(perimeter) : [q.slice()];
    for (let piece = 0; piece < emitted.length; piece++) {
      const target = quads.length; quads.push(emitted[piece]); inheritQuadSurface(doc, surfaceMaps, qid, target);
      quadIds.push(piece === 0 ? doc.quadIds[qid] ?? null : null);
    }
    if (!splits && quadTwist && doc.quadTwist?.[qid]) quadTwist[quads.length - 1] = doc.quadTwist[qid];
  }

  const freeEdges: [number, number][] = [];
  for (const edge of doc.freeEdges ?? []) {
    if (!targets.has(ekey(edge[0], edge[1]))) freeEdges.push(edge);
    else freeEdges.push([edge[0], vertex], [vertex, edge[1]]);
  }
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };
  const tJunctions = remapTJunctionsForEdgeSplits(doc.tJunctions, [
    { edge: first, vertex, t: crossing.t[0] }, { edge: second, vertex, t: crossing.t[1] },
  ]);
  const { doc: out, ...identity } = finishMeshRewrite(doc, {
    vertices, quads, quadIds, keepVertices: looseVertexIds(doc), freeEdges,
    tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels,
  });
  // The weld point and the four ends it split are stated in the rewrite's own numbering; each is found again
  // by the name it carries, the freshly minted one included.
  const remap = (source: number) => locateVertex(identity, source)!;
  const remappedVertex = remap(vertex);
  return { ok: true, doc: out, vertex: remappedVertex, splitEdges: [
    [[Math.min(remap(first[0]), remappedVertex), Math.max(remap(first[0]), remappedVertex)], [Math.min(remappedVertex, remap(first[1])), Math.max(remappedVertex, remap(first[1]))]],
    [[Math.min(remap(second[0]), remappedVertex), Math.max(remap(second[0]), remappedVertex)], [Math.min(remappedVertex, remap(second[1])), Math.max(remappedVertex, remap(second[1]))]],
  ] };
}

export const AUTO_WELD_CROSSING_TOLERANCE_M = 0.01;

/** Resolve only transverse crossings involving edges created by the current authoring action. The deliberately
 * tight tolerance avoids turning the broader diagnostic's near misses into surprising topology edits. */
export function autoWeldCreatedEdgeCrossings(
  initial: QuadMeshDoc,
  createdEdges: readonly (readonly [number, number])[],
  tolerance = AUTO_WELD_CROSSING_TOLERANCE_M,
): { doc: QuadMeshDoc; edges: [number, number][]; welded: number } {
  let doc = initial, welded = 0;
  const tracked = new Map(createdEdges.map(([a, b]) => [ekey(a, b), [Math.min(a, b), Math.max(a, b)] as [number, number]]));
  const rejected = new Set<string>();
  const connectionVertices = [...new Set(createdEdges.flatMap(edge => [...edge]))];
  const pos = (source: QuadMeshDoc, vertex: number): V3 => readVertex(source.vertices, vertex);
  for (let pass = 0; pass < 32; pass++) {
    // A chain may deliberately finish on an existing red crossing. In that case the new endpoint supplies the
    // vertex that the two old edges were missing: split the crossing, then merge its temporary point into it.
    const endpointConnection = findEdgeCrossings(doc, tolerance).flatMap(crossing => crossing.kind === 'crossing'
      ? connectionVertices.map(vertex => ({ crossing, vertex })) : [])
      .find(({ crossing, vertex }) => crossing.points.every(point => {
        const p = pos(doc, vertex);
        return (point[0] - p[0]) ** 2 + (point[1] - p[1]) ** 2 + (point[2] - p[2]) ** 2 <= tolerance * tolerance;
      }) && !rejected.has(`endpoint:${vertex}:${crossing.edges.map(edge => ekey(edge[0], edge[1])).sort().join('|')}`));
    if (endpointConnection) {
      const { crossing, vertex } = endpointConnection;
      const key = `endpoint:${vertex}:${crossing.edges.map(edge => ekey(edge[0], edge[1])).sort().join('|')}`;
      const split = applyEdgeCrossingWeld(doc, crossing);
      const connected = split.ok ? applyVertexWeld(split.doc, [[split.vertex, vertex]]) : split;
      if (!connected.ok) { rejected.add(key); continue; }
      doc = connected.doc; welded++;
      continue;
    }
    const crossing = findEdgeCrossings(doc, tolerance, [...tracked.values()]).find(candidate => candidate.kind === 'crossing'
      && candidate.edges.some(edge => tracked.has(ekey(edge[0], edge[1])))
      && !rejected.has(candidate.edges.map(edge => ekey(edge[0], edge[1])).sort().join('|')));
    if (!crossing) break;
    const result = applyEdgeCrossingWeld(doc, crossing);
    if (!result.ok) {
      rejected.add(crossing.edges.map(edge => ekey(edge[0], edge[1])).sort().join('|'));
      continue;
    }
    for (let side = 0; side < 2; side++) {
      const oldKey = ekey(crossing.edges[side][0], crossing.edges[side][1]);
      if (!tracked.delete(oldKey)) continue;
      for (const edge of result.splitEdges[side]) tracked.set(ekey(edge[0], edge[1]), edge);
    }
    doc = result.doc;
    welded++;
  }
  return { doc, edges: [...tracked.values()], welded };
}
