import type { V3 } from '../../doc/types';
import { cross, dot, len, norm, sub } from '../../math/vec';
import type { InterfaceCurve } from './benchmark';
import type { PolygonMesh } from './obj';

export interface TrailFieldOptions {
  /** 0 is purely harmonic; larger values keep the nearest trail tangent influential across the whole domain. */
  globalTrailWeight?: number;
  iterations?: number;
}

interface BoundaryEdge { face: number; edge: number; a: number; b: number }
interface Segment2 { ax: number; az: number; bx: number; bz: number; angle: number }

const edgeKey = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`;
const positionKey = (point: V3): string => point.map(value => Math.round(value * 100_000)).join(',');
const positionEdgeKey = (a: V3, b: V3): string => {
  const ka = positionKey(a), kb = positionKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};
const angleField = (angle: number): [number, number] => [Math.cos(4 * angle), Math.sin(4 * angle)];
const fieldAngle = ([x, y]: [number, number]): number => Math.atan2(y, x) / 4;
const normalized2 = (x: number, y: number): [number, number] => {
  const length = Math.hypot(x, y);
  return length > 1e-12 ? [x / length, y / length] : [1, 0];
};

function meshEdges(mesh: PolygonMesh): { boundary: BoundaryEdge[]; all: BoundaryEdge[]; neighbors: number[][] } {
  const occurrences = new Map<string, BoundaryEdge[]>();
  for (let face = 0; face < mesh.faces.length; face++) {
    const polygon = mesh.faces[face];
    for (let edge = 0; edge < polygon.length; edge++) {
      const a = polygon[edge], b = polygon[(edge + 1) % polygon.length];
      const record = { face, edge, a, b };
      const key = edgeKey(a, b), found = occurrences.get(key);
      if (found) found.push(record); else occurrences.set(key, [record]);
    }
  }
  const boundary: BoundaryEdge[] = [], all: BoundaryEdge[] = [], neighbors = mesh.faces.map(() => [] as number[]);
  for (const records of occurrences.values()) {
    all.push(...records);
    if (records.length === 1) boundary.push(records[0]);
    else if (records.length === 2) {
      neighbors[records[0].face].push(records[1].face);
      neighbors[records[1].face].push(records[0].face);
    }
  }
  return { boundary, all, neighbors };
}

function trailSegments(curves: InterfaceCurve[]): Segment2[] {
  const segments: Segment2[] = [];
  for (const curve of curves) for (let i = 1; i < curve.samples.length; i++) {
    const a = curve.samples[i - 1], b = curve.samples[i];
    const dx = b[0] - a[0], dz = b[2] - a[2];
    if (Math.hypot(dx, dz) > 1e-8) segments.push({ ax: a[0], az: a[2], bx: b[0], bz: b[2], angle: Math.atan2(dz, dx) });
  }
  if (!segments.length) throw new Error('Trail flow requires at least one non-degenerate protected-interface segment');
  return segments;
}

function nearestSegment(x: number, z: number, segments: Segment2[]): { segment: Segment2; distance: number } {
  let best = segments[0], bestDistance2 = Infinity;
  for (const segment of segments) {
    const dx = segment.bx - segment.ax, dz = segment.bz - segment.az;
    const denominator = dx * dx + dz * dz;
    const t = denominator > 1e-12 ? Math.max(0, Math.min(1,
      ((x - segment.ax) * dx + (z - segment.az) * dz) / denominator)) : 0;
    const sx = segment.ax + dx * t, sz = segment.az + dz * t;
    const distance2 = (x - sx) ** 2 + (z - sz) ** 2;
    if (distance2 < bestDistance2) { bestDistance2 = distance2; best = segment; }
  }
  return { segment: best, distance: Math.sqrt(bestDistance2) };
}

function faceCentroid(mesh: PolygonMesh, face: number): V3 {
  const polygon = mesh.faces[face], sum: V3 = [0, 0, 0];
  for (const vertex of polygon) {
    const point = mesh.vertices[vertex];
    sum[0] += point[0]; sum[1] += point[1]; sum[2] += point[2];
  }
  return [sum[0] / polygon.length, sum[1] / polygon.length, sum[2] / polygon.length];
}

function faceNormal(mesh: PolygonMesh, face: number): V3 {
  const polygon = mesh.faces[face];
  const normal = norm(cross(sub(mesh.vertices[polygon[1]], mesh.vertices[polygon[0]]),
    sub(mesh.vertices[polygon[2]], mesh.vertices[polygon[0]])));
  return len(normal) > 1e-8 ? normal : [0, 1, 0];
}

function tangentOnFace(angle: number, normal: V3): V3 {
  const horizontal: V3 = [Math.cos(angle), 0, Math.sin(angle)];
  const projected: V3 = [
    horizontal[0] - normal[0] * dot(horizontal, normal),
    horizontal[1] - normal[1] * dot(horizontal, normal),
    horizontal[2] - normal[2] * dot(horizontal, normal),
  ];
  return len(projected) > 1e-8 ? norm(projected) : norm(cross(normal, [0, 1, 0]));
}

/** Every open edge is a hard QuadWild feature. The supplied field path bypasses automatic feature discovery. */
export function quadWildSharp(mesh: PolygonMesh, curves: InterfaceCurve[] = []): string {
  const { boundary, all } = meshEdges(mesh);
  const trailEdges = new Set(curves.flatMap(curve => [
    ...curve.samples.slice(0, -1).map((sample, index) => positionEdgeKey(sample, curve.samples[index + 1])),
    // Resolution-1 topology proxies carry one chord for the full authored cubic rather than one triangle
    // edge per constraint sample. Preserve that exact endpoint edge too; the later Bezier fitter restores the
    // curved geometry while the quadrangulator sees only the intended control-patch density.
    positionEdgeKey(curve.samples[0], curve.samples[curve.samples.length - 1]),
  ]));
  const records = [...boundary];
  const seen = new Set(boundary.map(edge => edgeKey(edge.a, edge.b)));
  for (const edge of all) {
    const key = edgeKey(edge.a, edge.b);
    if (seen.has(key) || !trailEdges.has(positionEdgeKey(mesh.vertices[edge.a], mesh.vertices[edge.b]))) continue;
    seen.add(key); records.push(edge);
  }
  // QuadWild's legacy parser expects comma-delimited triples (its README shows spaces, but SaveSharpFeatures
  // and fscanf both use commas).
  return `${records.length}\n${records.map(edge => `1,${edge.face},${edge.edge}`).join('\n')}\n`;
}

/**
 * Build a smooth global 4-RoSy field. Trail tangents are hard constraints; an optional weak
 * nearest-trail prior keeps the course influential far beyond a narrow collar without making direction signed.
 */
export function quadWildTrailField(
  mesh: PolygonMesh,
  curves: InterfaceCurve[],
  options: TrailFieldOptions = {},
): string {
  if (mesh.faces.some(face => face.length !== 3)) throw new Error('QuadWild .rosy guidance requires triangles');
  const segments = trailSegments(curves), { all, neighbors } = meshEdges(mesh);
  const centroids = mesh.faces.map((_face, index) => faceCentroid(mesh, index));
  const nearest = centroids.map(point => nearestSegment(point[0], point[2], segments));
  let field = nearest.map(item => angleField(item.segment.angle));
  const hard = new Map<number, [number, number]>();
  const trailEdges = new Set(curves.flatMap(curve => [
    ...curve.samples.slice(0, -1).map((sample, index) => positionEdgeKey(sample, curve.samples[index + 1])),
    positionEdgeKey(curve.samples[0], curve.samples[curve.samples.length - 1]),
  ]));

  // Only the retained trail is a field constraint. The earlier prototype constrained the much longer outer
  // mountain border too, which overwhelmed the trail and recreated grid-like flow. The outer border remains a
  // hard geometric feature in .sharp; it simply does not dictate the mountain-wide direction field.
  for (const edge of all) {
    const a = mesh.vertices[edge.a], b = mesh.vertices[edge.b];
    if (!trailEdges.has(positionEdgeKey(a, b))) continue;
    const direction = angleField(Math.atan2(b[2] - a[2], b[0] - a[0]));
    const previous = hard.get(edge.face);
    hard.set(edge.face, previous ? normalized2(previous[0] + direction[0], previous[1] + direction[1]) : direction);
  }
  if (!hard.size) throw new Error('No protected trail edges matched the topology input boundary');

  const priorWeight = Math.max(0, options.globalTrailWeight ?? 0.08);
  for (let iteration = 0; iteration < Math.max(1, options.iterations ?? 400); iteration++) {
    const next = field.map((current, face) => {
      const fixed = hard.get(face);
      if (fixed) return fixed;
      let x = priorWeight * Math.cos(4 * nearest[face].segment.angle);
      let y = priorWeight * Math.sin(4 * nearest[face].segment.angle);
      for (const neighbor of neighbors[face]) { x += field[neighbor][0]; y += field[neighbor][1]; }
      return normalized2(x, y);
    });
    field = next;
  }

  const vectors = field.map((value, face) => tangentOnFace(fieldAngle(value), faceNormal(mesh, face)));
  return `${mesh.faces.length}\n4\n${vectors.map(vector => vector.join(' ')).join('\n')}\n`;
}
