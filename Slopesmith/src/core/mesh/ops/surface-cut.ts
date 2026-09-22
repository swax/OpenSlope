import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from '../../doc/types';
import { buildQuadMesh, meshEdgeHandles, meshAdjacency } from '../topology';
import { cubicPoint } from '../../math/bezier';
import { add, cross, dot, len, mul, norm, sub } from '../../math/vec';
import {
  ekey, checkManifold, createQuadSurfaceMaps, finishMeshRewrite,
  inheritQuadSurface, locateVertex, looseVertexIds,
} from './contract';
import { edgePointAt, splitEdgeHandlesExact } from './cut-primitives';
import { findTJunctions, remapTJunctionsForEdgeSplits, type TJunction } from '../t-junctions';
import { readVertex, writeVertex } from '../primitives';

/**
 * The surface cut (Create Edge across patch interiors): validates a click-by-click path over the surface,
 * then commits it atomically — every crossed edge is bisected at one shared vertex and each traversed polygon
 * is re-decomposed into quads plus parity wedges. Endpoints never propagate into untraversed patches; an
 * internal endpoint intentionally becomes an explicit T-junction.
 */

/** A point in a provisional surface cut. Existing vertices terminate a cut; an edge point records the exact
 * fraction along its cubic boundary so the eventual commit can split every incident patch at one shared id. */
export type SurfaceCutPoint = { vertex: number } | { edge: [number, number]; t: number };

export type SurfaceCutPathResult =
  | { ok: true; complete: boolean; cells: number[] }
  | { ok: false; error: string };

const pointVertex = (point: SurfaceCutPoint): number | null => 'vertex' in point ? point.vertex : null;
const pointEdge = (point: SurfaceCutPoint): [number, number] | null => 'edge' in point ? point.edge : null;

/** Validate a click-by-click surface path without changing the document. A path starts on a surface vertex or
 * any surface edge, traverses each patch at most once, and closes on any other edge or existing vertex. An
 * interior-edge endpoint is valid and becomes a T-junction when its other incident patch is not traversed;
 * validation only proves that the drawn route crosses an unambiguous sequence of patches. */
export function validateSurfaceCutPath(doc: QuadMeshDoc, path: readonly SurfaceCutPoint[]): SurfaceCutPathResult {
  if (!path.length) return { ok: false, error: 'Start the surface cut on an existing point or surface edge.' };
  const count = doc.vertices.length / 3;
  const validVertex = (v: number) => Number.isInteger(v) && v >= 0 && v < count;
  const adj = meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges));
  const junctionsByVertex = new Map<number, TJunction[]>();
  for (const junction of findTJunctions(doc, undefined, path.flatMap(point => 'vertex' in point ? [point.vertex] : []))) {
    const list = junctionsByVertex.get(junction.vertex) ?? [];
    list.push(junction); junctionsByVertex.set(junction.vertex, list);
  }
  const first = pointVertex(path[0]), firstEdge = pointEdge(path[0]);
  const validFirstVertex = first !== null && validVertex(first) && doc.quads.some(q => q.includes(first));
  const validFirstEdge = firstEdge !== null
    && (adj.edgeQuads.get(ekey(firstEdge[0], firstEdge[1]))?.length ?? 0) > 0
    && Number.isFinite((path[0] as { t?: number }).t)
    && (path[0] as { t: number }).t > 0 && (path[0] as { t: number }).t < 1;
  if (!validFirstVertex && !validFirstEdge)
    return { ok: false, error: 'A surface cut must start on an existing surface point or surface edge.' };
  const cellsFor = (point: SurfaceCutPoint): number[] => {
    if ('vertex' in point) {
      if (!validVertex(point.vertex)) return [];
      const cells = new Set(doc.quads.flatMap((q, i) => q.includes(point.vertex) ? [i] : []));
      // A T vertex is a valid boundary point for the patch across its unresolved host edge. This lets a later
      // Create Edge stroke complete the missing half of a split instead of forcing another coincident point.
      for (const junction of junctionsByVertex.get(point.vertex) ?? [])
        for (const cell of adj.edgeQuads.get(ekey(junction.edge[0], junction.edge[1])) ?? []) cells.add(cell);
      return [...cells];
    }
    const [a, b] = point.edge;
    if (!validVertex(a) || !validVertex(b) || a === b || !Number.isFinite(point.t) || point.t <= 0 || point.t >= 1) return [];
    return [...(adj.edgeQuads.get(ekey(a, b)) ?? [])];
  };
  const seenEdgePoints = new Set<string>();
  for (let i = 0; i < path.length; i++) {
    const edge = pointEdge(path[i]);
    if (!edge) continue;
    const key = ekey(edge[0], edge[1]);
    if (seenEdgePoints.has(key)) return { ok: false, error: 'A surface cut cannot cross the same edge twice.' };
    seenEdgePoints.add(key);
  }
  const cells: number[] = [], used = new Set<number>();
  for (let i = 1; i < path.length; i++) {
    const previousVertex = pointVertex(path[i - 1]), currentVertex = pointVertex(path[i]);
    const previousEdge = pointEdge(path[i - 1]), currentEdge = pointEdge(path[i]);
    if (previousVertex !== null && currentVertex !== null && (adj.edgeQuads.get(ekey(previousVertex, currentVertex))?.length ?? 0) > 0)
      return { ok: false, error: 'That segment follows an existing edge; cross a patch instead.' };
    if ((previousVertex !== null && currentEdge?.includes(previousVertex))
      || (currentVertex !== null && previousEdge?.includes(currentVertex)))
      return { ok: false, error: 'That segment follows part of an existing edge; cross the patch interior instead.' };
    const previousCells = new Set(cellsFor(path[i - 1]));
    const candidates = cellsFor(path[i]).filter(cell => previousCells.has(cell) && !used.has(cell));
    if (candidates.length !== 1)
      return { ok: false, error: candidates.length ? 'That segment follows an existing edge; cross a patch instead.' : 'The next point must lie across the current patch.' };
    const cell = candidates[0];
    if (new Set(doc.quads[cell]).size !== 4)
      return { ok: false, error: 'Create Edge cannot route a new surface cut through a wedge yet.' };
    cells.push(cell); used.add(cell);
  }
  if (path.length === 1) return { ok: true, complete: false, cells };
  const last = path[path.length - 1];
  if ('vertex' in last) {
    if (first !== null && last.vertex === first) return { ok: false, error: 'Finish the cut on a different existing point.' };
    return { ok: true, complete: true, cells };
  }
  return { ok: true, complete: true, cells };
}

/** Follow the straight stroke across an unambiguous strip of quads, projected along the endpoints' average
 * surface normal. Every transition must cross a real cubic boundary in stroke order. Connectivity alone is
 * not sufficient: a shortest topological path can detour around a hole and cut unrelated terrain instead of
 * creating the requested free edge across the gap. Ambiguous/folded routes require explicit edge picks. */
export function routeSurfaceCutPath(
  doc: QuadMeshDoc, start: SurfaceCutPoint, end: SurfaceCutPoint,
): SurfaceCutPoint[] | null {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh);
  const edgeHandle = meshEdgeHandles(mesh, doc.edgeHandles);
  const pos = (vertex: number): V3 => readVertex(doc.vertices, vertex);
  const pointPos = (point: SurfaceCutPoint): V3 => 'vertex' in point ? pos(point.vertex)
    : edgePointAt(point.edge[0], point.edge[1], point.t, edgeHandle, pos);
  const junctions = findTJunctions(doc);
  const cellsFor = (point: SurfaceCutPoint, preferUnresolvedSide: boolean): number[] => {
    if ('edge' in point) return [...(adj.edgeQuads.get(ekey(point.edge[0], point.edge[1])) ?? [])];
    const direct = doc.quads.flatMap((quad, id) => quad.includes(point.vertex) ? [id] : []);
    const host = junctions.filter(node => node.vertex === point.vertex)
      .flatMap(node => adj.edgeQuads.get(ekey(node.edge[0], node.edge[1])) ?? [])
      .filter(id => !doc.quads[id].includes(point.vertex));
    return preferUnresolvedSide && host.length ? [...new Set(host)] : [...new Set([...direct, ...host])];
  };
  const proper = (cell: number) => cell >= 0 && cell < doc.quads.length && new Set(doc.quads[cell]).size === 4;
  const starts = cellsFor(start, true).filter(proper), targets = new Set(cellsFor(end, true).filter(proper));
  if (!starts.length || !targets.size) return null;
  const a = pointPos(start), delta = sub(pointPos(end), a);
  let normal: V3 = [0, 0, 0];
  for (const cell of new Set([...starts, ...targets])) {
    const [A, B, C, D] = doc.quads[cell];
    let n = cross(sub(pos(D), pos(A)), sub(pos(C), pos(B)));
    if (len(n) < 1e-9) continue;
    n = norm(n);
    normal = add(normal, dot(n, normal) < 0 ? mul(n, -1) : n);
  }
  if (len(normal) < 1e-9 || len(delta) < 1e-9) return null;
  normal = norm(normal);
  const along = sub(delta, mul(normal, dot(delta, normal))), length = len(along);
  if (length < 1e-6 * len(delta)) return null;
  const forward = norm(along), sideways = norm(cross(forward, normal));
  const epsilon = 1e-7, distanceEpsilon = epsilon * Math.max(1, length);
  type Crossing = { edge: [number, number]; t: number; station: number };
  const cache = new Map<string, Crossing[] | null>();
  const crossings = (edge: [number, number]): Crossing[] | null => {
    const key = ekey(edge[0], edge[1]);
    if (cache.has(key)) return cache.get(key)!;
    const p0 = pos(edge[0]), p3 = pos(edge[1]);
    const controls = [p0, add(p0, edgeHandle(edge[0], edge[1])), add(p3, edgeHandle(edge[1], edge[0])), p3] as [V3, V3, V3, V3];
    const stations = controls.map(p => dot(sub(p, a), forward) / length);
    const distances = controls.map(p => dot(sub(p, a), sideways));
    const signs = distances.filter(d => Math.abs(d) > distanceEpsilon).map(Math.sign);
    let result: Crossing[] | null = [];
    if (Math.max(...stations) > epsilon && Math.min(...stations) < 1 - epsilon) {
      const changes = signs.slice(1).filter((sign, i) => sign !== signs[i]).length;
      // A coplanar edge or multiple possible roots has no unique crossing. Do not guess, clamp a miss to a
      // corner, or skip a boundary and search for another way around it.
      if (!signs.length || changes > 1) result = null;
      else if (Math.abs(distances[0]) <= distanceEpsilon || Math.abs(distances[3]) <= distanceEpsilon || changes === 1) {
        let lo = 0, hi = 1;
        if (Math.abs(distances[0]) <= distanceEpsilon) hi = 0;
        else if (Math.abs(distances[3]) <= distanceEpsilon) lo = 1;
        else for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) / 2, distance = dot(sub(cubicPoint(...controls, mid), a), sideways);
          if (Math.sign(distance) === Math.sign(distances[0])) lo = mid; else hi = mid;
        }
        const t = (lo + hi) / 2, station = dot(sub(cubicPoint(...controls, t), a), forward) / length;
        if (station > epsilon && station < 1 - epsilon)
          result = t <= epsilon || t >= 1 - epsilon ? null : [{ edge, t, station }];
      }
    }
    cache.set(key, result);
    return result;
  };
  for (const first of starts) {
    let cell = first, station = 0;
    const visited = new Set<number>(), path: SurfaceCutPoint[] = [start];
    while (!visited.has(cell)) {
      visited.add(cell);
      const [A, B, C, D] = doc.quads[cell];
      const exits = ([[A, B], [B, D], [D, C], [C, A]] as [number, number][]).map(crossings);
      if (exits.some(exit => exit === null)) break;
      const ahead = exits.flatMap(exit => exit!).filter(exit => exit.station > station + epsilon)
        .sort((x, y) => x.station - y.station);
      if (!ahead.length) {
        if (targets.has(cell) && path.length > 1) {
          path.push(end);
          if (validateSurfaceCutPath(doc, path).ok) return path;
        }
        break;
      }
      if (ahead.length > 1 && ahead[1].station - ahead[0].station < epsilon) break;
      const next = ahead[0];
      const neighbors = (adj.edgeQuads.get(ekey(...next.edge)) ?? []).filter(id => id !== cell);
      if (neighbors.length !== 1 || !proper(neighbors[0])) break; // The stroke leaves the quilt; never go around the gap.
      path.push({ edge: next.edge, t: next.t });
      cell = neighbors[0]; station = next.station;
    }
  }
  return null;
}

export type ApplySurfaceCutResult =
  | { ok: true; doc: QuadMeshDoc; edges: [number, number][]; endVertex: number; wedges: number }
  | { ok: false; error: string };

/** Split a polygonal perimeter into the fewest quad/wedge cells using a fan. Odd perimeters contribute one
 * wedge; even perimeters remain all quads. Cell storage is converted from perimeter order to [A,B,C,D]. */
export function cellsFromPerimeter(perimeter: readonly number[]): number[][] {
  if (perimeter.length < 3) return [];
  const cell = (p: readonly number[]) => p.length === 3
    ? [p[0], p[1], p[2], p[2]]
    : [p[0], p[1], p[3], p[2]];
  if (perimeter.length <= 4) return [cell(perimeter)];
  const out: number[][] = [];
  let rest = [...perimeter];
  if (rest.length % 2 === 1) {
    out.push(cell([rest[0], rest[1], rest[2]]));
    rest = [rest[0], ...rest.slice(2)];
  }
  while (rest.length > 4) {
    out.push(cell([rest[0], rest[1], rest[2], rest[3]]));
    rest = [rest[0], ...rest.slice(3)];
  }
  out.push(cell(rest));
  return out;
}

/** Commit a complete surface cut atomically. Crossed edges use one shared inserted vertex id. Only patches the
 * authored route actually traverses are split; an endpoint on an edge with an untraversed incident patch becomes
 * an explicit T-junction instead of silently propagating topology into that neighboring patch. */
export function applySurfaceCut(doc: QuadMeshDoc, path: readonly SurfaceCutPoint[]): ApplySurfaceCutResult {
  const plan = validateSurfaceCutPath(doc, path);
  if (!plan.ok) return plan;
  if (!plan.complete) return { ok: false, error: 'Continue the cut to a boundary edge or an existing point.' };

  const beforeMesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const beforeWedges = doc.quads.filter(q => new Set(q).size === 3).length;
  const beforeAdj = meshAdjacency(beforeMesh);
  const beforeHandle = meshEdgeHandles(beforeMesh, doc.edgeHandles);
  const pos = (id: number): V3 => readVertex(doc.vertices, id);
  const vertices = doc.vertices.slice();
  const splitIds = new Map<string, { id: number; edge: [number, number]; t: number }>();
  for (const point of path) if ('edge' in point) {
    const key = ekey(point.edge[0], point.edge[1]);
    if (splitIds.has(key)) continue;
    const id = vertices.length / 3, p = edgePointAt(point.edge[0], point.edge[1], point.t, beforeHandle, pos);
    vertices.push(...p);
    splitIds.set(key, { id, edge: point.edge, t: point.t });
  }
  const idFor = (point: SurfaceCutPoint) => 'vertex' in point ? point.vertex : splitIds.get(ekey(point.edge[0], point.edge[1]))!.id;
  const resolvedJunctions = new Map<string, TJunction>();
  const pathVertices = path.flatMap(point => 'vertex' in point ? [point.vertex] : []);
  for (const junction of findTJunctions(doc, undefined, pathVertices)) {
    const hostCells = beforeAdj.edgeQuads.get(ekey(junction.edge[0], junction.edge[1])) ?? [];
    if (!hostCells.some(cell => plan.cells.includes(cell) && !doc.quads[cell].includes(junction.vertex))) continue;
    const key = ekey(junction.edge[0], junction.edge[1]), previous = resolvedJunctions.get(key);
    if (previous && previous.vertex !== junction.vertex)
      return { ok: false, error: 'That cut would resolve multiple T-junctions on the same edge at once.' };
    resolvedJunctions.set(key, junction);
  }

  // Pin the existing surface curves before new diagonal neighbours change automatic Bessel valence.
  const edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}) };
  for (let a = 0; a < beforeMesh.vertices.length; a++) for (const b of beforeAdj.neighbors[a] ?? []) {
    const h = beforeHandle(a, b); edgeHandles[`${a}>${b}`] = [h[0], h[1], h[2]];
  }
  for (const { id, edge: [a, b], t } of splitIds.values()) {
    const midpoint = readVertex(vertices, id);
    const incident = beforeAdj.edgeQuads.get(ekey(a, b)) ?? [];
    const unresolved = incident.some(cell => !plan.cells.includes(cell));
    splitEdgeHandlesExact(edgeHandles, a, b, id, t, midpoint, beforeHandle, pos, unresolved);
  }
  for (const { vertex, edge: [a, b], t } of resolvedJunctions.values()) {
    const midpoint = edgePointAt(a, b, t, beforeHandle, pos);
    writeVertex(vertices, vertex, midpoint);
    splitEdgeHandlesExact(edgeHandles, a, b, vertex, t, midpoint, beforeHandle, pos);
  }

  const traversed = new Map<number, [number, number]>();
  for (let i = 0; i < plan.cells.length; i++) traversed.set(plan.cells[i], [idFor(path[i]), idFor(path[i + 1])]);
  const hostSplits = [
    ...[...splitIds.values()].filter(split => {
      const incident = beforeAdj.edgeQuads.get(ekey(split.edge[0], split.edge[1])) ?? [];
      return incident.every(cell => plan.cells.includes(cell));
    }).map(split => ({ edge: split.edge, vertex: split.id, t: split.t })),
    ...[...resolvedJunctions.values()].map(node => ({ edge: node.edge, vertex: node.vertex, t: node.t })),
  ];
  const tJunctions: EdgeEmbeddedTJunction[] = remapTJunctionsForEdgeSplits(doc.tJunctions, hostSplits);
  for (const split of splitIds.values()) {
    const incident = beforeAdj.edgeQuads.get(ekey(split.edge[0], split.edge[1])) ?? [];
    if (incident.some(cell => !plan.cells.includes(cell)))
      tJunctions.push({ vertex: split.id, edge: [...split.edge], t: split.t });
  }
  const surfaceMaps = createQuadSurfaceMaps(doc);
  const { quadPaint, quadTex, quadOrient, quadLocked, quadLabels } = surfaceMaps;
  const quadTwist: Record<number, [V3, V3, V3, V3]> | undefined = doc.quadTwist ? {} : undefined;
  const quads: number[][] = [];
  // The cut re-emits every patch, so identity travels with the source rather than the index: an untraversed
  // patch and the FIRST piece of a split one are the same patch still, and each further piece is new.
  const quadIds: (string | null)[] = [];
  for (let qid = 0; qid < doc.quads.length; qid++) {
    const q = doc.quads[qid], base = [q[0], q[1], q[3], q[2]];
    const perimeter: number[] = [];
    for (let i = 0; i < base.length; i++) {
      const a = base[i], b = base[(i + 1) % base.length];
      perimeter.push(a);
      const split = splitIds.get(ekey(a, b));
      if (split && traversed.has(qid)) perimeter.push(split.id);
      const resolved = resolvedJunctions.get(ekey(a, b));
      if (resolved && traversed.has(qid)) perimeter.push(resolved.vertex);
    }
    const chord = traversed.get(qid);
    let emitted: number[][];
    if (chord) {
      const ia = perimeter.indexOf(chord[0]), ib = perimeter.indexOf(chord[1]);
      if (ia < 0 || ib < 0 || ia === ib) return { ok: false, error: 'The cut lost a patch boundary point.' };
      const walk = (from: number, to: number) => {
        const p: number[] = [];
        for (let i = from; ; i = (i + 1) % perimeter.length) { p.push(perimeter[i]); if (i === to) return p; }
      };
      const sides = [walk(ia, ib), walk(ib, ia)];
      if (sides.some(side => side.length < 3)) return { ok: false, error: 'That cut would duplicate a patch boundary.' };
      emitted = sides.flatMap(cellsFromPerimeter);
    } else emitted = [q.slice()];
    for (let piece = 0; piece < emitted.length; piece++) {
      const target = quads.length; quads.push(emitted[piece]); inheritQuadSurface(doc, surfaceMaps, qid, target);
      quadIds.push(piece === 0 ? doc.quadIds[qid] ?? null : null);
      if (quadTwist && emitted.length === 1 && perimeter.length === 4 && doc.quadTwist?.[qid]) quadTwist[target] = doc.quadTwist[qid];
    }
  }
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };
  const { doc: out, ...identity } = finishMeshRewrite(doc, {
    vertices, quads, quadIds, keepVertices: looseVertexIds(doc), freeEdges: doc.freeEdges,
    tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels,
  });
  // The cut path is stated in the rewrite's own numbering, which compaction has just moved; each point is
  // found again by the name it carries, minted ones included.
  const at = (raw: number) => locateVertex(identity, raw)!;
  const edges: [number, number][] = [];
  for (let i = 1; i < path.length; i++) {
    const a = at(idFor(path[i - 1])), b = at(idFor(path[i]));
    edges.push(a < b ? [a, b] : [b, a]);
  }
  return {
    ok: true, doc: out, edges, endVertex: at(idFor(path[path.length - 1])),
    wedges: Math.max(0, quads.filter(q => new Set(q).size === 3).length - beforeWedges),
  };
}
