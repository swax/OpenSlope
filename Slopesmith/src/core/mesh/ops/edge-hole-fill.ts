import type { QuadMeshDoc, V3 } from '../../doc/types';
import { add, cross, dot, len, mul, sub } from '../../math/vec';
import { liveQuadEdges, readVertex } from '../primitives';
import { appendPatchFromCorners, type PatchCorners } from './append';
import { ekey } from './contract';

export type EdgeHoleFillResult =
  | { ok: true; doc: QuadMeshDoc; quads: number[]; skipped: number }
  | { ok: false; error: string };

type P2 = [number, number];
const turn = (a: P2, b: P2, c: P2) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Reject degenerate/crossed outlines and coplanar outlines enclosing other mesh geometry. A 3D opening
 * may still cap a bowl or a tube: geometry away from the outline's plane is not an obstruction. */
function openPerimeter(doc: QuadMeshDoc, loop: number[], liveVertices: ReadonlySet<number>): number[] | null {
  const points = loop.map(v => readVertex(doc.vertices, v));
  const origin = points[0], local = points.map(p => sub(p, origin));
  if (points.some(p => !p.every(Number.isFinite))) return null;
  const scale = Math.max(...local.map(len)), tolerance = Math.max(1e-6, scale * 1e-6);
  let normal: V3 = [0, 0, 0];
  for (let i = 0; i < local.length; i++) normal = add(normal, cross(local[i], local[(i + 1) % local.length]));
  const magnitude = len(normal);
  if (magnitude <= tolerance * scale) return null;
  normal = mul(normal, 1 / magnitude);
  const axis = [0, 1, 2].sort((a, b) => Math.abs(normal[b]) - Math.abs(normal[a]))[0];
  const axes = [0, 1, 2].filter(a => a !== axis);
  const project = (p: V3): P2 => [p[axes[0]], p[axes[1]]];
  const polygon = local.map(project), areaTolerance = tolerance * scale;
  // Each corner must have a real turn; a collinear fourth point belongs to a larger boundary, not a quad.
  if (polygon.some((p, i) => Math.abs(turn(polygon[(i + polygon.length - 1) % polygon.length], p,
    polygon[(i + 1) % polygon.length])) <= areaTolerance)) return null;
  if (polygon.length === 4) {
    const intersects = (a: P2, b: P2, c: P2, d: P2) =>
      turn(a, b, c) * turn(a, b, d) <= 0 && turn(c, d, a) * turn(c, d, b) <= 0;
    if (intersects(polygon[0], polygon[1], polygon[2], polygon[3])
      || intersects(polygon[1], polygon[2], polygon[3], polygon[0])) return null;
  }
  const inside = (p: P2) => {
    let contained = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j], b = polygon[i];
      // Points on a side also obstruct filling: don't introduce a T-junction over an unsplit edge.
      if (Math.abs(turn(a, b, p)) <= areaTolerance
        && p[0] >= Math.min(a[0], b[0]) - tolerance && p[0] <= Math.max(a[0], b[0]) + tolerance
        && p[1] >= Math.min(a[1], b[1]) - tolerance && p[1] <= Math.max(a[1], b[1]) + tolerance) return true;
      if ((a[1] > p[1]) !== (b[1] > p[1])
        && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) contained = !contained;
    }
    return contained;
  };
  for (const v of liveVertices) {
    if (loop.includes(v)) continue;
    const p = sub(readVertex(doc.vertices, v), origin);
    if (Math.abs(dot(p, normal)) <= tolerance && inside(project(p))) return null;
  }
  // Disconnected terrain faces start skyward (vertical faces use their dominant normal). The append
  // primitive overrides this choice to match every existing shared boundary when there is one.
  const facing = Math.abs(normal[1]) > 1e-6 ? normal[1] : normal[axis];
  return facing < 0 ? [loop[0], ...loop.slice(1).reverse()] : loop;
}

/** Fill every complete selected three-/four-edge hole, not just one ordered chain. All sides must
 * already exist and be selected. Chorded cycles are larger regions, not single patch openings.
 * Appending through the ordinary Create Patch primitive preserves seam curves, ids and winding. */
export function fillSelectedEdgeHoles(
  doc: QuadMeshDoc, selected: readonly (readonly [number, number])[],
): EdgeHoleFillResult {
  const uses = new Map<string, number>(), liveVertices = new Set<number>();
  for (const q of doc.quads) for (const [a, b] of liveQuadEdges(q)) {
    const key = ekey(a, b);
    uses.set(key, (uses.get(key) ?? 0) + 1);
    liveVertices.add(a); liveVertices.add(b);
  }
  for (const [a, b] of doc.freeEdges ?? []) {
    const key = ekey(a, b);
    if (!uses.has(key)) uses.set(key, 0);
    liveVertices.add(a); liveVertices.add(b);
  }
  const picked = new Set<string>(), neighbors = new Map<number, number[]>();
  for (const [a, b] of selected) {
    const key = ekey(a, b);
    if (a === b || !Number.isInteger(a) || !Number.isInteger(b) || !uses.has(key))
      return { ok: false, error: 'Some selected edges no longer exist — select the hole boundaries again.' };
    if (picked.has(key)) continue;
    picked.add(key);
    if (uses.get(key)! >= 2) continue;
    for (const [from, to] of [[a, b], [b, a]]) {
      const adjacent = neighbors.get(from) ?? [];
      adjacent.push(to); neighbors.set(from, adjacent);
    }
  }
  if (picked.size < 3)
    return { ok: false, error: 'Select all three or four edges around a hole, then Create Patches.' };
  for (const adjacent of neighbors.values()) adjacent.sort((a, b) => a - b);
  const loops: number[][] = [];
  let steps = 0, exceeded = false;
  const walk = (path: number[]) => {
    for (const next of neighbors.get(path[path.length - 1]) ?? []) {
      if (++steps > 250_000) { exceeded = true; return; }
      if (next === path[0]) {
        // The minimum vertex starts every cycle; retain only one of its two traversal directions.
        if (path.length >= 3 && path[1] < path[path.length - 1]) loops.push(path);
      } else if (path.length < 4 && next > path[0] && !path.includes(next)) walk([...path, next]);
      if (exceeded) return;
    }
  };
  for (const start of [...neighbors.keys()].sort((a, b) => a - b)) {
    walk([start]);
    if (exceeded) return { ok: false, error: 'Too many connected edge combinations — select a smaller group of holes.' };
  }
  loops.sort((a, b) => a.length - b.length || a.reduce((order, v, i) => order || v - b[i], 0));
  const faceKey = (ids: readonly number[]) => [...new Set(ids)].sort((a, b) => a - b).join(',');
  const faces = new Set(doc.quads.map(faceKey));
  let out = doc, skipped = 0, reason = '';
  const candidates: { perimeter: number[]; edges: string[]; distance: number }[] = [];
  const byEdge = new Map<string, number[]>(), queue: number[] = [];
  for (const loop of loops) {
    if (faces.has(faceKey(loop))) continue;
    if (loop.length === 4 && (uses.has(ekey(loop[0], loop[2])) || uses.has(ekey(loop[1], loop[3])))) continue;
    const perimeter = openPerimeter(doc, loop, liveVertices);
    if (!perimeter) { skipped++; continue; }
    const edges = loop.map((v, i) => ekey(v, loop[(i + 1) % loop.length])), index = candidates.length;
    const connected = edges.some(edge => uses.get(edge) === 1);
    candidates.push({ perimeter, edges, distance: connected ? 0 : Infinity });
    if (connected) queue.push(index);
    for (const edge of edges) {
      const adjacent = byEdge.get(edge) ?? [];
      adjacent.push(index); byEdge.set(edge, adjacent);
    }
  }
  // Grow outward from existing faces before filling standalone wire components, so their winding is
  // propagated through a run of holes instead of arbitrarily choosing an isolated face's normal first.
  let at = 0;
  const expandQueue = () => {
    for (; at < queue.length; at++) {
      const candidate = candidates[queue[at]];
      for (const edge of candidate.edges) {
        for (const next of byEdge.get(edge) ?? []) if (candidates[next].distance === Infinity) {
          candidates[next].distance = candidate.distance + 1;
          queue.push(next);
        }
        byEdge.delete(edge);
      }
    }
  };
  expandQueue();
  candidates.forEach((candidate, index) => {
    if (candidate.distance !== Infinity) return;
    candidate.distance = 0; queue.push(index); expandQueue();
  });
  const quads: number[] = [];
  for (const index of queue) {
    const { perimeter } = candidates[index];
    const corners: PatchCorners = perimeter.length === 3
      ? [perimeter[0], perimeter[1], perimeter[2]]
      : [perimeter[0], perimeter[1], perimeter[2], perimeter[3]];
    const result = appendPatchFromCorners(out, corners);
    if (!result.ok) { skipped++; reason ||= result.error; continue; }
    out = result.doc;
    quads.push(result.quad);
  }
  if (!quads.length) return { ok: false, error: reason
    ? `No patches created. ${reason}`
    : 'No empty 3- or 4-sided holes found. Select every edge around each hole; filled, crossed or subdivided outlines are skipped.' };
  return { ok: true, doc: out, quads, skipped };
}
