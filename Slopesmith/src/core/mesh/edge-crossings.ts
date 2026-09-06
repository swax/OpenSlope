import type { QuadMeshDoc, V3 } from '../doc/types';
import { closestPointsBetweenSegments, type SegmentSegmentClosest } from '../math/segment';
import { SpatialHash3D } from '../math/spatial-hash';
import { buildMeshEdgeCurves, meshDiagnosticCellSize } from './edge-curves';

export const EDGE_CROSSING_TOLERANCE_M = 0.2;

export interface EdgeCrossing {
  edges: [[number, number], [number, number]];
  /** Closest parameters along the two authored cubic edges. */
  t: [number, number];
  points: [V3, V3];
  point: V3;
  distance: number;
  kind: 'crossing' | 'near-overlap';
}

/** Find non-connected cubic edges whose interiors cross or run within `tolerance` in true 3D. */
export function findEdgeCrossings(
  doc: QuadMeshDoc,
  tolerance = EDGE_CROSSING_TOLERANCE_M,
  onlyEdges?: readonly (readonly [number, number])[],
): EdgeCrossing[] {
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return [];
  const segments = 20;
  const only = onlyEdges ? new Set(onlyEdges.map(([a, b]) => a < b ? `${a},${b}` : `${b},${a}`)) : null;
  const { curves } = buildMeshEdgeCurves(doc, tolerance, segments);

  const grid = new SpatialHash3D<number>(meshDiagnosticCellSize(doc)), pairs = new Set<string>();
  curves.forEach((curve, index) => {
    const candidates = grid.queryBounds(curve.min, curve.max);
    if (!candidates) return;
    for (const other of candidates) {
      if (only && !only.has(curve.edge.join(',')) && !only.has(curves[other].edge.join(','))) continue;
      pairs.add(other < index ? `${other},${index}` : `${index},${other}`);
    }
    grid.insertBounds(curve.min, curve.max, index);
  });

  const out: EdgeCrossing[] = [], tolerance2 = tolerance * tolerance;
  for (const pair of pairs) {
    const [ia, ib] = pair.split(',').map(Number), a = curves[ia], b = curves[ib];
    if (a.edge.some(vertex => b.edge.includes(vertex))) continue;
    if ([0, 1, 2].some(axis => a.max[axis] < b.min[axis] || b.max[axis] < a.min[axis])) continue;
    let best: SegmentSegmentClosest | null = null, ai = 0, bi = 0, bestInterior = -1;
    for (let i = 0; i < segments; i++) for (let j = 0; j < segments; j++) {
      const closest = closestPointsBetweenSegments(a.samples![i], a.samples![i + 1], b.samples![j], b.samples![j + 1]);
      const ta = (i + closest.s) / segments, tb = (j + closest.t) / segments;
      const interior = Math.min(ta, 1 - ta, tb, 1 - tb);
      if (!best || closest.distance2 < best.distance2 - 1e-12
        || (Math.abs(closest.distance2 - best.distance2) <= 1e-12 && interior > bestInterior)) {
        best = closest; ai = i; bi = j; bestInterior = interior;
      }
    }
    if (!best || best.distance2 > tolerance2) continue;
    const ta = (ai + best.s) / segments, tb = (bi + best.t) / segments;
    if (ta <= 1e-3 || ta >= 1 - 1e-3 || tb <= 1e-3 || tb >= 1 - 1e-3) continue;
    const l1 = Math.hypot(...best.firstDirection), l2 = Math.hypot(...best.secondDirection);
    const alignment = l1 > 1e-9 && l2 > 1e-9
      ? Math.abs((best.firstDirection[0] * best.secondDirection[0]
        + best.firstDirection[1] * best.secondDirection[1]
        + best.firstDirection[2] * best.secondDirection[2]) / (l1 * l2)) : 1;
    out.push({
      edges: [a.edge, b.edge], t: [ta, tb], points: [best.first, best.second],
      point: [(best.first[0] + best.second[0]) / 2, (best.first[1] + best.second[1]) / 2,
        (best.first[2] + best.second[2]) / 2],
      distance: Math.sqrt(best.distance2), kind: alignment < Math.cos(Math.PI / 12) ? 'crossing' : 'near-overlap',
    });
  }
  return out;
}
