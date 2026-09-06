import type { EdgeEmbeddedTJunction, QuadMeshDoc, V3 } from '../doc/types';
import { cubicPoint, nearestCubicT } from '../math/bezier';
import { closestPointOnSegment } from '../math/segment';
import { SpatialHash3D } from '../math/spatial-hash';
import { add } from '../math/vec';
import { meshAdjacency, meshFromDoc } from './topology';
import { buildMeshEdgeCurves, meshDiagnosticCellSize } from './edge-curves';
import { readVertex, undirectedEdgeKey, writeVertex } from './primitives';

/** Legacy-import tolerance used only to convert pre-explicit geometric contacts, in editor metres. */
export const T_JUNCTION_TOLERANCE_M = 0.2;

export interface TJunction extends EdgeEmbeddedTJunction {
  /** The endpoint that geometrically touches, but is not topologically part of, `edge`. */
  vertex: number;
  edge: [number, number];
  point: V3;
  distance: number;
  /** Closest parameter on `edge`, used when a later cut resolves this junction into shared topology. */
  t: number;
}

/**
 * Infer geometric T-junctions while migrating a document saved before explicit T-node topology.
 *
 * A legitimate rim or internal hole is purely topological: its boundary edges meet through shared vertex ids,
 * so it never appears here. A T-junction is different: a used vertex lies within `tolerance` of the INTERIOR
 * of another cubic edge, but that edge does not name the vertex as an endpoint. The small geometric tolerance
 * catches hand-placed / imported near-contacts without mistaking ordinary nearby terrain for a junction.
 */
export function inferGeometricTJunctions(
  doc: QuadMeshDoc, tolerance = T_JUNCTION_TOLERANCE_M, onlyVertices?: readonly number[],
): TJunction[] {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return [];
  const { mesh, adjacency: adj, curves } = buildMeshEdgeCurves(doc, tolerance);
  if (!mesh.vertexCount) return [];

  // Bin conservative Bezier control-point bounds for a map-wide scan. A selection query checks its one/few
  // vertices directly against the curve bounds and avoids paying to build the spatial index on every click.
  const grid = new SpatialHash3D<number>(meshDiagnosticCellSize(doc)), global: number[] = [];
  if (!onlyVertices) curves.forEach((curve, index) => {
    if (!grid.insertBounds(curve.min, curve.max, index)) global.push(index);
  });

  const tolerance2 = tolerance * tolerance, segments = 48, out: TJunction[] = [];
  const vertices = onlyVertices ? [...new Set(onlyVertices)].filter(v => Number.isInteger(v) && v >= 0 && v < mesh.vertexCount)
    : Array.from({ length: mesh.vertexCount }, (_, vertex) => vertex);
  for (const vertex of vertices) {
    if (!(adj.neighbors[vertex]?.length)) continue; // unused/orphan points are not junction endpoints
    const point = readVertex(mesh.vertices, vertex);
    const candidates = onlyVertices
      ? curves.keys()
      : new Set([...grid.queryPoint(point), ...global]).values();
    for (const index of candidates) {
      const curve = curves[index], [a, b] = curve.edge;
      if (vertex === a || vertex === b) continue; // a real shared endpoint is conforming topology
      if (point.some((value, axis) => value < curve.min[axis] || value > curve.max[axis])) continue;
      let previous = curve.cp[0], bestDistance2 = Infinity, bestT = 0;
      for (let i = 1; i <= segments; i++) {
        const current = cubicPoint(curve.cp[0], curve.cp[1], curve.cp[2], curve.cp[3], i / segments);
        const closest = closestPointOnSegment(point, previous, current);
        if (closest.distance2 < bestDistance2) {
          bestDistance2 = closest.distance2;
          bestT = (i - 1 + closest.t) / segments;
        }
        previous = current;
      }
      // Endpoint-to-endpoint duplicate ids are a weld problem, not a T-junction; only edge-interior hits count.
      if (bestDistance2 <= tolerance2 && bestT > 1e-3 && bestT < 1 - 1e-3) {
        out.push({ vertex, edge: curve.edge, point: [...point] as V3, distance: Math.sqrt(bestDistance2), t: bestT });
      }
    }
  }
  return out;
}

/** Validate and deduplicate saved T-node topology without using geometric proximity. */
export function normalizeTJunctions(
  doc: QuadMeshDoc,
  records: readonly EdgeEmbeddedTJunction[] = doc.tJunctions ?? [],
): EdgeEmbeddedTJunction[] {
  const { mesh } = meshFromDoc(doc), adj = meshAdjacency(mesh), out: EdgeEmbeddedTJunction[] = [], seen = new Set<string>();
  for (const record of records) {
    if (!record || !Number.isInteger(record.vertex) || record.vertex < 0 || record.vertex >= mesh.vertexCount
      || !Array.isArray(record.edge) || record.edge.length !== 2) continue;
    const [a, b] = record.edge;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= mesh.vertexCount || b >= mesh.vertexCount
      || a === b || record.vertex === a || record.vertex === b || !Number.isFinite(record.t)
      || record.t <= 1e-3 || record.t >= 1 - 1e-3 || !(adj.neighbors[record.vertex]?.length)
      || !(adj.neighbors[a] ?? []).includes(b)) continue;
    const key = `${record.vertex}:${undirectedEdgeKey(a, b)}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ vertex: record.vertex, edge: [a, b], t: record.t });
  }
  return out;
}

/** Read explicit T-node records and enrich them for markers/panels. No distance tolerance creates topology. */
export function findTJunctions(
  doc: QuadMeshDoc, _tolerance = T_JUNCTION_TOLERANCE_M, onlyVertices?: readonly number[],
): TJunction[] {
  const selected = onlyVertices ? new Set(onlyVertices) : null;
  const { mesh, edgeHandle } = meshFromDoc(doc);
  return normalizeTJunctions(doc).filter(record => !selected || selected.has(record.vertex)).map(record => {
    const [a, b] = record.edge, p0 = readVertex(mesh.vertices, a), p3 = readVertex(mesh.vertices, b);
    const vertex = readVertex(mesh.vertices, record.vertex);
    const curve = cubicPoint(p0, add(p0, edgeHandle(a, b)), add(p3, edgeHandle(b, a)), p3, record.t);
    return {
      ...record, point: vertex,
      distance: Math.hypot(vertex[0] - curve[0], vertex[1] - curve[1], vertex[2] - curve[2]),
    };
  });
}

/** Carry explicit T nodes when an operation splits their host edge. A split at the T vertex resolves it;
 * otherwise the node transfers to the appropriate child edge with a renormalized parameter. */
export function remapTJunctionsForEdgeSplits(
  records: readonly EdgeEmbeddedTJunction[] | undefined,
  splits: readonly { edge: readonly [number, number]; vertex: number; t: number }[],
): EdgeEmbeddedTJunction[] {
  let out = (records ?? []).map(node => ({ ...node, edge: [...node.edge] as [number, number] }));
  for (const split of splits) {
    out = out.flatMap(node => {
      if (undirectedEdgeKey(node.edge[0], node.edge[1]) !== undirectedEdgeKey(split.edge[0], split.edge[1])) return [node];
      const s = node.edge[0] === split.edge[0] ? split.t : 1 - split.t;
      if (Math.abs(node.t - s) <= 1e-4) return [];
      return node.t < s
        ? [{ vertex: node.vertex, edge: [node.edge[0], split.vertex], t: node.t / s }]
        : [{ vertex: node.vertex, edge: [split.vertex, node.edge[1]], t: (node.t - s) / (1 - s) }];
    });
  }
  return out;
}

/** Whether normalization found the records a document already holds, entry for entry. */
const sameTJunctionRecords = (
  held: readonly EdgeEmbeddedTJunction[] | undefined, records: readonly EdgeEmbeddedTJunction[],
): boolean => (held?.length ?? 0) === records.length
  && records.every((record, at) => held![at].vertex === record.vertex && held![at].t === record.t
    && held![at].edge[0] === record.edge[0] && held![at].edge[1] === record.edge[1]);

/** Keep every embedded vertex seated on its saved host curve. If an edit moved the vertex or reshaped the
 * host, project the authored point back to the curve and update `t`; explicit topology remains authoritative.
 *
 * This runs on every render, so the document keeps the array it already holds whenever normalization found
 * nothing to change. WHICH array a document carries is what tells a topology edit from an ordinary one
 * (`app/net/register-sync.ts`); handing back a fresh one each render would report a topology edit nobody made,
 * and a topology edit costs a whole-document round trip. */
export function reconcileTJunctionGeometry(doc: QuadMeshDoc): number[] {
  const records = normalizeTJunctions(doc), { edgeHandle } = meshFromDoc(doc), changed: number[] = [];
  if (!sameTJunctionRecords(doc.tJunctions, records)) doc.tJunctions = records;
  for (const record of doc.tJunctions ?? records) {
    const [a, b] = record.edge, p0 = readVertex(doc.vertices, a), p3 = readVertex(doc.vertices, b);
    const current = readVertex(doc.vertices, record.vertex);
    const p1 = add(p0, edgeHandle(a, b)), p2 = add(p3, edgeHandle(b, a));
    let target = cubicPoint(p0, p1, p2, p3, record.t);
    if (Math.hypot(current[0] - target[0], current[1] - target[1], current[2] - target[2]) > 1e-6) {
      record.t = Math.min(0.999, Math.max(0.001, nearestCubicT(p0, p1, p2, p3, current, 64)));
      target = cubicPoint(p0, p1, p2, p3, record.t);
    }
    if (current[0] === target[0] && current[1] === target[1] && current[2] === target[2]) continue;
    writeVertex(doc.vertices, record.vertex, target); changed.push(record.vertex);
  }
  return changed;
}
