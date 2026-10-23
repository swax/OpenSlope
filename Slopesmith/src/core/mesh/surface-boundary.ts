import type { QuadMeshDoc, V3 } from '../doc/types';
import { blankMountain } from '../doc/mountain';
import { appendMeshIds } from '../doc/ids';
import { add, cross, len, mul, sub } from '../math/vec';
import { cubicPolyline } from '../math/bezier';
import { meshFromDoc } from './topology';
import { readVertex, undirectedEdgeKey } from './primitives';
import { boundarySurfaceCharts, createSurfaceFromBoundary, type SurfaceResult } from './surface-object';

export type SurfaceBoundaryPoint = { pos: V3; vertex: number | null };
const EPS = 1e-6;
export const MAX_SURFACE_BOUNDARY_POINTS = 128;
const sources = new WeakMap<QuadMeshDoc, { edges: Set<string>; geometry: ReturnType<typeof meshFromDoc> }>();

function segmentHandles(doc: QuadMeshDoc, from: SurfaceBoundaryPoint, to: SurfaceBoundaryPoint): [V3, V3] {
  const ab = mul(sub(to.pos, from.pos), 1 / 3);
  if (from.vertex === null || to.vertex === null) return [ab, mul(ab, -1)];
  let source = sources.get(doc);
  if (!source) {
    const edges = new Set(doc.freeEdges?.map(([a, b]) => undirectedEdgeKey(a, b)));
    for (const [a, b, c, d] of doc.quads)
      for (const [x, y] of [
        [a, b],
        [b, d],
        [d, c],
        [c, a],
      ])
        edges.add(undirectedEdgeKey(x, y));
    source = { edges, geometry: meshFromDoc(doc) };
    sources.set(doc, source);
  }
  return source.edges.has(undirectedEdgeKey(from.vertex, to.vertex))
    ? [source.geometry.edgeHandle(from.vertex, to.vertex), source.geometry.edgeHandle(to.vertex, from.vertex)]
    : [ab, mul(ab, -1)];
}

/** The same boundary cubic the draft will use, including an existing curved edge copied by snapping. */
export function surfaceBoundarySegmentLength(doc: QuadMeshDoc, from: SurfaceBoundaryPoint, to: SurfaceBoundaryPoint) {
  if (from.vertex === null || to.vertex === null) return len(sub(to.pos, from.pos));
  const [ab, ba] = segmentHandles(doc, from, to),
    samples = cubicPolyline(from.pos, add(from.pos, ab), add(to.pos, ba), to.pos, 64);
  return samples.slice(1).reduce((length, p, i) => length + len(sub(p, samples[i])), 0);
}

function validate(points: readonly SurfaceBoundaryPoint[]) {
  if (points.length < 4) throw new Error('Place at least four boundary points, then close the loop or press Enter.');
  if (points.length > MAX_SURFACE_BOUNDARY_POINTS) throw new Error('A surface boundary can have at most 128 points.');
  if (points.some(p => p.pos.length !== 3 || p.pos.some(n => !Number.isFinite(n))))
    throw new Error('Use finite boundary points.');
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (len(sub(points[i].pos, points[j].pos)) < EPS)
        throw new Error('Keep the boundary points distinct. Click the first point to close the loop.');
  const origin = points[0].pos;
  let normal: V3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++)
    normal = add(normal, cross(sub(points[i].pos, origin), sub(points[(i + 1) % points.length].pos, origin)));
  if (len(normal) < EPS) throw new Error('The boundary needs to enclose a surface.');
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),
    axes = [0, 1, 2].filter(axis => axis !== drop),
    flat = points.map(p => axes.map(axis => p.pos[axis]));
  const orient = (a: number[], b: number[], c: number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < flat.length; i++)
    for (let j = i + 1; j < flat.length; j++) {
      if (j === i + 1 || (i === 0 && j === flat.length - 1)) continue;
      const a = flat[i],
        b = flat[(i + 1) % flat.length],
        c = flat[j],
        d = flat[(j + 1) % flat.length];
      const overlaps = [0, 1].every(
        axis =>
          Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) <=
          Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) + EPS,
      );
      if (overlaps && orient(a, b, c) * orient(a, b, d) <= 0 && orient(c, d, a) * orient(c, d, b) <= 0)
        throw new Error('The boundary crosses itself. Undo the last point and draw around the perimeter.');
    }
}

/** Choose four stations by boundary distance; extra clicks remain editable points along those four sides. */
function corners(points: readonly SurfaceBoundaryPoint[]) {
  const distances = [0];
  for (let i = 1; i <= points.length; i++)
    distances.push(distances[i - 1] + len(sub(points[i % points.length].pos, points[i - 1].pos)));
  const chosen = [0];
  for (let k = 1; k < 4; k++) {
    const target = (distances.at(-1)! * k) / 4;
    let best = chosen.at(-1)! + 1;
    for (let i = best + 1; i <= points.length - 4 + k; i++)
      if (Math.abs(distances[i] - target) < Math.abs(distances[best] - target)) best = i;
    chosen.push(best);
  }
  return chosen;
}

/** A small isolated sketch: hover never allocates terrain or changes the live mountain. Existing boundary
 * cubics are copied when snapping along an edge; new segments start straight and remain editable afterward. */
export function surfaceBoundaryDraft(doc: QuadMeshDoc, points: readonly SurfaceBoundaryPoint[]) {
  validate(points);
  const boundary = blankMountain('Surface boundary');
  boundary.vertices = points.flatMap(p => p.pos);
  Object.assign(boundary, appendMeshIds(boundary, points.length, 0));
  boundary.freeEdges = points.map((_, i) => [i, (i + 1) % points.length]);
  boundary.edgeHandles = {};
  points.forEach(p => {
    if (p.vertex !== null && (!doc.vertexIds[p.vertex] || len(sub(readVertex(doc.vertices, p.vertex), p.pos)) > EPS))
      throw new Error('A snapped point changed. Cancel and start the surface again.');
  });
  for (const [a, b] of boundary.freeEdges) {
    const [ab, ba] = segmentHandles(doc, points[a], points[b]);
    boundary.edgeHandles[`${a}>${b}`] = [...ab];
    boundary.edgeHandles[`${b}>${a}`] = [...ba];
  }
  const stops = corners(points);
  return { boundary, corners: stops, charts: boundarySurfaceCharts(boundary, boundary.freeEdges, stops) };
}

/** Install the sketch and its live Surface together as one document edit. Existing geometry is unchanged. */
export function createSurfaceFromDrawnBoundary(
  doc: QuadMeshDoc,
  points: readonly SurfaceBoundaryPoint[],
  patchSizeM = 25,
): SurfaceResult {
  try {
    const draft = surfaceBoundaryDraft(doc, points),
      start = doc.vertexIds.length;
    const out: QuadMeshDoc = {
      ...doc,
      ...appendMeshIds(doc, points.length, 0),
      vertices: [...doc.vertices, ...draft.boundary.vertices],
      freeEdges: [
        ...(doc.freeEdges ?? []),
        ...draft.boundary.freeEdges!.map(([a, b]) => [start + a, start + b] as [number, number]),
      ],
      edgeHandles: { ...doc.edgeHandles },
    };
    for (const [key, offset] of Object.entries(draft.boundary.edgeHandles!)) {
      const [a, b] = key.split('>').map(Number);
      out.edgeHandles![`${start + a}>${start + b}`] = offset;
    }
    return createSurfaceFromBoundary(
      out,
      draft.boundary.freeEdges!.map(([a, b]) => [start + a, start + b]),
      draft.corners.map(i => start + i),
      patchSizeM,
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
