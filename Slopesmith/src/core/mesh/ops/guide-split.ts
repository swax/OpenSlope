import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendMeshIds } from '../../doc/ids';
import { add, dot, len, norm, sub } from '../../math/vec';
import { cubicPoint, splitCubic } from '../../math/bezier';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import { readVertex } from '../primitives';
import { ekey } from './contract';

/** The most a path extrusion's guide may turn inside one band of patches. A bicubic patch follows a quarter
 *  turn well; a free guide edge that turns further is cut into pieces so no band sweeps through more than this. */
export const MAX_BAND_TURN = Math.PI / 4;

/** A free guide edge cut into pieces before a path extrusion sweeps along it: `ts` are the rising cubic
 *  parameters of the cuts on the edge from `from` to `to`. The new points append to the document in order. */
export type GuideSplit = { from: number; to: number; ts: number[] };

/**
 * Where to cut one guide cubic so each piece turns at most MAX_BAND_TURN: its total turning, sampled along the
 * curve, sets the piece count (at most `maxPieces`), and the cuts fall at equal arc length. None for a curve
 * that already turns little enough — a straight or gently bent guide edge stays one band, as it always was.
 */
export function guideCuts(p0: V3, p1: V3, p2: V3, p3: V3, maxPieces = 8): number[] {
  const N = 48, points: V3[] = [];
  for (let i = 0; i <= N; i++) points.push(cubicPoint(p0, p1, p2, p3, i / N));
  const lengths = [0];
  let turn = 0, previous: V3 | null = null;
  for (let i = 1; i <= N; i++) {
    const chord = sub(points[i], points[i - 1]), l = len(chord);
    lengths.push(lengths[i - 1] + l);
    if (l < 1e-9) continue;
    const dir = norm(chord);
    if (previous) turn += Math.acos(Math.max(-1, Math.min(1, dot(previous, dir))));
    previous = dir;
  }
  const pieces = Math.min(maxPieces, Math.ceil(turn / MAX_BAND_TURN - 1e-9));
  const total = lengths[N];
  if (pieces <= 1 || total < 1e-9) return [];
  return Array.from({ length: pieces - 1 }, (_, j) => {
    const target = total * (j + 1) / pieces;
    let i = 1;
    while (i < N && lengths[i] < target) i++;
    const span = lengths[i] - lengths[i - 1];
    return (i - 1 + (span > 1e-12 ? (target - lengths[i - 1]) / span : 0)) / N;
  });
}

/**
 * Cut each listed free guide edge into pieces on its own cubic — exact de Casteljau, so the curve does not move —
 * appending the new points in order and replacing the edge with its pieces. Every other edge at the cut edges'
 * ends keeps the handle it had: those ends gain a new neighbour, which would otherwise re-fit their Bessel
 * tangents. Pure; a document with nothing to cut comes back unchanged.
 */
export function splitGuideEdges(doc: QuadMeshDoc, splits: readonly GuideSplit[]): QuadMeshDoc {
  if (!splits.some(split => split.ts.length)) return doc;
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh);
  const handle = meshEdgeHandles(mesh, doc.edgeHandles);
  const vertices = doc.vertices.slice(), edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}) };
  for (const { from, to } of splits) for (const end of [from, to]) for (const neighbour of adj.neighbors[end] ?? []) {
    edgeHandles[`${end}>${neighbour}`] = [...handle(end, neighbour)] as V3;
  }
  const cut = new Set(splits.filter(split => split.ts.length).map(split => ekey(split.from, split.to)));
  const freeEdges = (doc.freeEdges ?? []).filter(([a, b]) => !cut.has(ekey(a, b)));
  let added = 0;
  for (const { from, to, ts } of splits) {
    if (!ts.length) continue;
    const p0 = readVertex(doc.vertices, from), p3 = readVertex(doc.vertices, to);
    let rest: [V3, V3, V3, V3] = [p0, add(p0, handle(from, to)), add(p3, handle(to, from)), p3];
    let a = from, done = 0;
    delete edgeHandles[`${from}>${to}`];
    delete edgeHandles[`${to}>${from}`];
    for (const t of ts) {
      const { left, right } = splitCubic(rest[0], rest[1], rest[2], rest[3], (t - done) / (1 - done));
      const m = vertices.length / 3;
      vertices.push(...left[3]);
      added++;
      edgeHandles[`${a}>${m}`] = sub(left[1], left[0]);
      edgeHandles[`${m}>${a}`] = sub(left[2], left[3]);
      freeEdges.push([a, m]);
      rest = right; a = m; done = t;
    }
    edgeHandles[`${a}>${to}`] = sub(rest[1], rest[0]);
    edgeHandles[`${to}>${a}`] = sub(rest[2], rest[3]);
    freeEdges.push([a, to]);
  }
  return { ...doc, vertices, edgeHandles, freeEdges, ...appendMeshIds(doc, added, 0) };
}
