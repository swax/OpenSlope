import type { V3 } from '../../doc/types';
import type { InterfaceCurve } from './benchmark';
import type { PolygonMesh } from './obj';
import { boundaryLoops } from './prescribe';
import { curveLength, resampleCurve, type LevelCurve } from './contour-levels';

/** Contour flow, stage 4 (JOIN) inputs: the region-boundary targets the swept sheet knits to, and the
 *  free-rim resampling that gives one of them its vertex count. See ./contour.ts. */

// ---- join targets ----------------------------------------------------------------------------------------

export interface JoinTarget {
  positions: V3[];
  locked: boolean;
  centroid: [number, number];
  /** Builder vertex ids once realized. */
  ids?: number[];
}

/**
 * The join boundaries. LOCKED targets assemble directly from the interface curves — each curve is one
 * authored rim edge, chained end-to-end into the feature's closed loops — so they are exact whether the
 * terrain is welded to the feature or floats clear of it (a document whose lattice was cut back leaves an
 * open moat between its cut rim and the trail). Proxy boundary loops that lie ON a locked rim are the
 * same loops (skipped in favour of the authored ones); loops NEAR a locked rim are a cut-back terrain
 * edge the candidate must pave past (not a boundary to preserve); the rest — the mountain's outer rim —
 * are free targets.
 */
export function joinTargets(proxy: PolygonMesh, curves: InterfaceCurve[], cell: number, notes: string[]): JoinTarget[] {
  const quantum = 0.25;
  const keyOf = (point: V3): string =>
    `${Math.round(point[0] / quantum)},${Math.round(point[1] / quantum)},${Math.round(point[2] / quantum)}`;
  // chain the authored rim edges into loops
  const positionByKey = new Map<string, V3>();
  const adjacency = new Map<string, string[]>();
  for (const curve of curves) {
    const a = curve.samples[0], b = curve.samples[curve.samples.length - 1];
    const ka = keyOf(a), kb = keyOf(b);
    if (ka === kb) continue;
    positionByKey.set(ka, a);
    positionByKey.set(kb, b);
    (adjacency.get(ka) ?? adjacency.set(ka, []).get(ka)!).push(kb);
    (adjacency.get(kb) ?? adjacency.set(kb, []).get(kb)!).push(ka);
  }
  for (const [key, list] of adjacency) {
    if (list.length !== 2) {
      const p = positionByKey.get(key)!;
      throw new Error(`the locked rim is not a set of closed loops: corner at `
        + `${p[0].toFixed(0)},${p[2].toFixed(0)} joins ${list.length} rim edge(s)`);
    }
  }
  const targets: JoinTarget[] = [];
  const visited = new Set<string>();
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const loop: V3[] = [];
    let previous = '', at = start;
    for (let guard = 0; guard <= adjacency.size; guard++) {
      loop.push(positionByKey.get(at)!);
      visited.add(at);
      const [n1, n2] = adjacency.get(at)!;
      const next = n1 === previous ? n2 : n1;
      previous = at;
      at = next;
      if (at === start) break;
    }
    let cx = 0, cz = 0;
    for (const point of loop) { cx += point[0]; cz += point[2]; }
    targets.push({ positions: loop, locked: true, centroid: [cx / loop.length, cz / loop.length] });
  }
  // classify the proxy's own boundary loops
  for (const loop of boundaryLoops(proxy)) {
    const positions = loop.map(vertex => proxy.vertices[vertex]);
    const onLocked = positions.every(point => positionByKey.has(keyOf(point)));
    if (onLocked && positions.length) continue;
    const meanTo = (target: JoinTarget): number => {
      let sum = 0, count = 0;
      const stride = Math.max(1, Math.floor(positions.length / 16));
      for (let i = 0; i < positions.length; i += stride) {
        const p = positions[i];
        let best = Infinity;
        for (let j = 0; j < target.positions.length; j++) {
          const a = target.positions[j], b = target.positions[(j + 1) % target.positions.length];
          const abx = b[0] - a[0], abz = b[2] - a[2];
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12
            ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
          best = Math.min(best, Math.hypot(p[0] - a[0] - t * abx, p[2] - a[2] - t * abz));
        }
        sum += best; count++;
      }
      return count ? sum / count : Infinity;
    };
    const nearest = targets.length ? Math.min(...targets.map(meanTo)) : Infinity;
    if (nearest < 4.5 * cell) {
      notes.push(`a terrain cut rim (${positions.length}v) stands ${nearest.toFixed(0)} m off a locked rim; `
        + 'the candidate paves past it to the feature');
      continue;
    }
    let cx = 0, cz = 0;
    for (const point of positions) { cx += point[0]; cz += point[2]; }
    targets.push({ positions, locked: false, centroid: [cx / positions.length, cz / positions.length] });
  }
  return targets;
}

/** Resample a free rim at the cell size, keeping sharp corners in place; `parity` adjusts one arc. */
export function resampleFreeRim(positions: V3[], cell: number, parity: number): [number, number][] {
  const n = positions.length;
  const sharp: number[] = [];
  for (let i = 0; i < n; i++) {
    const previous = positions[(i - 1 + n) % n], here = positions[i], next = positions[(i + 1) % n];
    const a = Math.atan2(here[2] - previous[2], here[0] - previous[0]);
    const b = Math.atan2(next[2] - here[2], next[0] - here[0]);
    let turn = Math.abs(b - a) % (2 * Math.PI);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn > Math.PI / 6) sharp.push(i);
  }
  if (!sharp.length) {
    const curve: LevelCurve = { points: positions.map(point => [point[0], point[2]]), closed: true };
    const out = resampleCurve(curve, cell);
    if (out.length % 2 !== parity) {
      const total = curveLength(curve);
      return resampleCurve(curve, total / (out.length + 1));
    }
    return out;
  }
  const arcs: [number, number][][] = [];
  for (let s = 0; s < sharp.length; s++) {
    const from = sharp[s], to = sharp[(s + 1) % sharp.length];
    const points: [number, number][] = [];
    for (let i = from; ; i = (i + 1) % n) {
      points.push([positions[i][0], positions[i][2]]);
      if (i === to && points.length > 1) break;
    }
    arcs.push(points);
  }
  const counts = arcs.map(points => {
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(
      points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    return Math.max(1, Math.round(length / cell));
  });
  if (counts.reduce((a, b) => a + b, 0) % 2 !== parity) counts[0]++;
  const out: [number, number][] = [];
  for (let s = 0; s < arcs.length; s++) {
    // resample the open arc at exactly counts[s] edges (the arc's end vertex is the next arc's start)
    const points = arcs[s];
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1]
      + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const total = cumulative[cumulative.length - 1];
    for (let k = 0; k < counts[s]; k++) {
      const target = (k * total) / counts[s];
      let low = 0, high = points.length - 1;
      while (low < high - 1) {
        const mid = (low + high) >> 1;
        if (cumulative[mid] <= target) low = mid; else high = mid;
      }
      const span = cumulative[low + 1] - cumulative[low];
      const t = span > 1e-12 ? (target - cumulative[low]) / span : 0;
      out.push([points[low][0] + (points[low + 1][0] - points[low][0]) * t,
        points[low][1] + (points[low + 1][1] - points[low][1]) * t]);
    }
  }
  return out;
}
