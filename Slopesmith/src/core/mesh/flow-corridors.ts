/**
 * The navigable strips `flow.ts` lays its cells between: a surveyed run framed by arc length, that run seen
 * leaving one of its ends, and the merge of two such strips into the shared ground a wye rips apart. See
 * `flow.ts` for what the builder does with them.
 */
import type { SheetPoint } from './sheet';
import { cross2 } from './flow-plane';

export interface FlowRun {
  line: SheetPoint[];
  /** Half of the cleared width at each `line` vertex. */
  half: number[];
  from: number;
  to: number;
}

/**
 * One navigable strip of the network, parameterised by distance from a node: a run seen from one of its ends,
 * or two corridors sharing their ground until their rims separate. Everything a wye needs to nest — a merged
 * pair is itself a corridor, so three trails peeling off one shoulder are just a merge of a merge.
 */
export interface Corridor {
  pointAt(s: number): SheetPoint;
  tangentAt(s: number): SheetPoint;
  halfAt(s: number): number;
  /** How far `s` may be read before the corridor's geometry runs out. */
  limit: number;
  /** Cells across — always even, so a junction patch can pair its edges. */
  columns: number;
  kind: 'leaf' | 'merged';
  /** For a leaf: which run end this is. */
  run?: number;
  end?: 'from' | 'to';
  /** For a merge: the two children and the arc distance where their rims part. */
  left?: Corridor;
  right?: Corridor;
  split?: number;
}

export interface RunFrame {
  cumulative: number[];
  length: number;
  pointAt(s: number): SheetPoint;
  tangentAt(s: number): SheetPoint;
  halfAt(s: number): number;
}

export function frameRun(run: FlowRun): RunFrame {
  const cumulative = [0];
  for (let i = 1; i < run.line.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(run.line[i].x - run.line[i - 1].x, run.line[i].z - run.line[i - 1].z));
  }
  const length = cumulative[cumulative.length - 1];
  const locate = (s: number): { i: number; t: number } => {
    const at = Math.max(0, Math.min(length, s));
    let low = 0, high = cumulative.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (cumulative[middle] <= at) low = middle; else high = middle;
    }
    const span = cumulative[high] - cumulative[low];
    return { i: low, t: span > 1e-9 ? (at - cumulative[low]) / span : 0 };
  };
  const pointAt = (s: number): SheetPoint => {
    const { i, t } = locate(s);
    const a = run.line[i], b = run.line[Math.min(i + 1, run.line.length - 1)];
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  };
  return {
    cumulative, length, pointAt,
    tangentAt(s: number): SheetPoint {
      // A window either side irons out survey-polyline jitter that would wobble every row it seeds.
      const h = Math.min(6, Math.max(1, length / 4));
      const a = pointAt(s - h), b = pointAt(s + h);
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      return d > 1e-9 ? { x: (b.x - a.x) / d, z: (b.z - a.z) / d } : { x: 1, z: 0 };
    },
    halfAt(s: number): number {
      const { i, t } = locate(s);
      const a = run.half[i], b = run.half[Math.min(i + 1, run.half.length - 1)];
      return a + (b - a) * t;
    },
  };
}

/** The run as seen leaving one of its ends: `s` counts inward from that end whichever end it is. */
export function leafCorridor(run: FlowRun, frame: RunFrame, end: 'from' | 'to', index: number, columns: number): Corridor {
  const flip = end === 'to';
  const inward = (s: number) => flip ? frame.length - s : s;
  return {
    kind: 'leaf', run: index, end, columns,
    limit: Math.max(0, frame.length),
    pointAt: s => frame.pointAt(inward(s)),
    tangentAt(s) {
      const t = frame.tangentAt(inward(s));
      return flip ? { x: -t.x, z: -t.z } : t;
    },
    halfAt: s => frame.halfAt(inward(s)),
  };
}

/** The rim of `corridor` on the side away from `other` — the edge of the shared ground a merge keeps. */
export function outerRim(corridor: Corridor, other: Corridor, s: number): SheetPoint {
  const p = corridor.pointAt(s), t = corridor.tangentAt(s);
  const nx = -t.z, nz = t.x;
  // At the node itself both spines sit on the same point, so which side is "away" is read a little further
  // out, where the corridors have actually parted.
  let sign = 0;
  for (let probe = s; sign === 0 && probe <= s + 8.5; probe += 2) {
    const a = corridor.pointAt(Math.min(probe, corridor.limit));
    const b = other.pointAt(Math.min(probe, other.limit));
    const dot = (a.x - b.x) * nx + (a.z - b.z) * nz;
    if (Math.abs(dot) > 1e-6) sign = dot > 0 ? 1 : -1;
  }
  const h = corridor.halfAt(s);
  return { x: p.x + nx * h * (sign || 1), z: p.z + nz * h * (sign || 1) };
}

/** The rim of `corridor` on the side toward `other` — where the pinch vertex lives when the rims part. */
export function innerRim(corridor: Corridor, other: Corridor, s: number): SheetPoint {
  const p = corridor.pointAt(s), outer = outerRim(corridor, other, s);
  return { x: 2 * p.x - outer.x, z: 2 * p.z - outer.z };
}

export function mergeCorridors(a: Corridor, b: Corridor, cell: number, notes: string[], label: string, trace = false): Corridor {
  // Where the rims part: spines far enough apart that the two swaths no longer overlap.
  const reach = Math.max(cell, Math.min(a.limit, b.limit) - cell);
  let split = reach;
  for (let s = cell * 0.5; s <= reach; s += cell / 4) {
    const p = a.pointAt(s), q = b.pointAt(s);
    if (trace && (s < cell * 2 || Math.abs(s % cell) < 1e-9)) {
      notes.push(`DEBUG merge ${label} s=${s.toFixed(1)}: apart ${Math.hypot(p.x - q.x, p.z - q.z).toFixed(1)}`
        + ` vs ${(a.halfAt(s) + b.halfAt(s)).toFixed(1)} (reach ${reach.toFixed(0)})`);
    }
    if (Math.hypot(p.x - q.x, p.z - q.z) >= a.halfAt(s) + b.halfAt(s)) { split = s; break; }
    if (s + cell / 4 > reach) {
      notes.push(`${label}: rims never part inside the shared ground — wye clamped at ${reach.toFixed(0)} m`);
      split = reach;
    }
  }
  // A child that is itself a merge must still be merged where this wye rips into it.
  for (const child of [a, b]) {
    if (child.kind === 'merged' && child.split! < split) {
      notes.push(`${label}: nested wye order clamped (${child.split!.toFixed(0)} m < ${split.toFixed(0)} m)`);
      split = Math.max(cell * 0.75, child.split! - cell * 0.5);
    }
  }
  // Left is the child that sits counterclockwise of the merged direction, so row order stays consistent.
  const probe = Math.min(split, Math.min(a.limit, b.limit)) * 0.5 + cell * 0.25;
  const ta = a.tangentAt(probe), pa = a.pointAt(probe), pb = b.pointAt(Math.min(probe, b.limit));
  const aLeft = cross2(ta.x, ta.z, pb.x - pa.x, pb.z - pa.z) < 0;
  const left = aLeft ? a : b, right = aLeft ? b : a;

  const merged: Corridor = {
    kind: 'merged', left, right, split,
    columns: left.columns + right.columns,
    limit: split,
    pointAt(s) {
      const lo = outerRim(left, right, s), ro = outerRim(right, left, s);
      return { x: (lo.x + ro.x) / 2, z: (lo.z + ro.z) / 2 };
    },
    tangentAt(s) {
      const h = Math.min(6, Math.max(1, split / 4));
      const p = this.pointAt(Math.max(0, s - h)), q = this.pointAt(Math.min(split, s + h));
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      return d > 1e-9 ? { x: (q.x - p.x) / d, z: (q.z - p.z) / d } : left.tangentAt(s);
    },
    halfAt(s) {
      const lo = outerRim(left, right, s), ro = outerRim(right, left, s);
      return Math.hypot(lo.x - ro.x, lo.z - ro.z) / 2;
    },
  };
  return merged;
}
