import type { V3 } from '../../doc/types';
import { bilinear, type Raster } from './contour-raster';
import { curveLength, resampleCurve, type LevelCurve } from './contour-levels';

/** Contour flow, stage 3 (SWEEP), mesh half: the growable candidate builder and every knit that lays
 *  quads between two rows, rings or chains, plus the ring geometry they share. See ./contour.ts. */

/** A closed row with this many vertices or fewer is capped with a centre fan instead of swept on. */
export const CAP_LIMIT = 12;

// ---- mesh assembly ---------------------------------------------------------------------------------------

/**
 * Growable candidate under construction. The candidate projects one-to-one onto XZ, so per-face clockwise
 * XZ winding (negative shoelace, the editor's skyward orientation) is automatically globally consistent.
 */
export class Builder {
  vertices: V3[] = [];
  faces: number[][] = [];
  /** Progress marker naming the construction stage, so duplicate emissions identify their source. */
  stage = 'sweep';
  /** Stage each face was emitted under, parallel to `faces`. */
  faceStage: string[] = [];
  private seen = new Map<string, number>();
  addVertex(x: number, y: number, z: number): number {
    this.vertices.push([x, y, z]);
    return this.vertices.length - 1;
  }
  private shoelace(ring: number[]): number {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = this.vertices[ring[i]], q = this.vertices[ring[(i + 1) % ring.length]];
      area += p[0] * q[2] - q[0] * p[2];
    }
    return area;
  }
  addFace(ring: number[]): void {
    if (new Set(ring).size !== ring.length) return;
    const key = [...ring].sort((a, b) => a - b).join(',');
    const previous = this.seen.get(key);
    if (previous !== undefined) {
      const at = ring.map(id => {
        const p = this.vertices[id];
        return `${id}(${p[0].toFixed(0)},${p[2].toFixed(0)})`;
      }).join(' ');
      throw new Error(`duplicate face during ${this.stage}: [${at}] repeats face #${previous} `
        + `[${this.faces[previous].join(',')}]`);
    }
    this.seen.set(key, this.faces.length);
    this.faceStage.push(this.stage);
    this.faces.push(this.shoelace(ring) > 0 ? [...ring].reverse() : ring);
  }
  addQuad(a: number, b: number, c: number, d: number): void { this.addFace([a, b, c, d]); }
  addTri(a: number, b: number, c: number): void { this.addFace([a, b, c]); }
  /** A collapsed-edge wedge in the integrator's own encoding: a 4-ring repeating its last corner. One
   *  wedge is the legal price of an odd locked rim on an isolated island, where parity cannot route. */
  addWedge(a: number, b: number, c: number): void {
    if (new Set([a, b, c]).size !== 3) return;
    this.faceStage.push(this.stage);
    this.faces.push(this.shoelace([a, b, c]) > 0 ? [c, b, a, a] : [a, b, c, c]);
  }
  /** Drop tombstoned (emptied) faces, keeping the stage record aligned. */
  compact(): void {
    const kept = this.faces.map((face, slot) => ({ face, stage: this.faceStage[slot] }))
      .filter(({ face }) => face.length > 0);
    this.faces = kept.map(({ face }) => face);
    this.faceStage = kept.map(({ stage }) => stage);
  }
}

export interface Row {
  ids: number[];
  closed: boolean;
}

/**
 * Knit one open row to the next; kite quads absorb the vertex-count difference two columns at a time
 * (one 3/5-pole pair each), so open rows must share parity for the ends to pin one-to-one. Each narrow
 * edge takes its exact share of kites before its regular quad, so every edge of both rows is consumed
 * exactly once at any count ratio.
 */
function knitChain(builder: Builder, from: Row, to: Row): void {
  const a = from.ids, b = to.ids;
  const shrink = a.length > b.length;
  const wide = shrink ? a : b, narrow = shrink ? b : a;
  const wideEdges = wide.length - 1, narrowEdges = narrow.length - 1;
  const kites = (wideEdges - narrowEdges) / 2;
  if (!Number.isInteger(kites) || kites < 0) throw new Error('open contour rows must share parity');
  let iw = 0;
  for (let ik = 0; ik < narrowEdges; ik++) {
    const share = Math.floor(((ik + 1) * kites) / narrowEdges) - Math.floor((ik * kites) / narrowEdges);
    for (let laid = 0; laid < share; laid++) {
      builder.addQuad(wide[iw], wide[iw + 1], wide[iw + 2], narrow[ik]);
      iw += 2;
    }
    builder.addQuad(wide[iw], wide[iw + 1], narrow[ik + 1], narrow[ik]);
    iw += 1;
  }
  if (iw !== wideEdges) throw new Error(`chain knit consumed ${iw} of ${wideEdges} wide edges`);
}

/**
 * Knit two closed rings into one cyclic band of quads by monotone arc-length correspondence: every wide
 * vertex projects onto the narrow ring's polyline, wide edges gather into per-narrow-edge buckets, and
 * each bucket emits its surplus as kites (two wide edges anchored on the narrow vertex — a 3/5-pole pair
 * each) before one regular quad carries the narrow edge itself. Buckets are rebalanced to odd sizes so
 * the arithmetic closes; when the two counts differ in parity the last bucket closes with exactly one
 * triangle, which the caller later cancels against another odd ring's. Projection-driven pairing is what
 * keeps a heterogeneous ring — a bridged multi-target composite against a swept loop that detours around
 * holes — knitting to the geometry that actually faces it. Both rings must wind the same way.
 */
export function knitRings(builder: Builder, narrow: number[], wide: number[]): number {
  const N = narrow.length, W = wide.length;
  if (W < N) throw new Error('knitRings requires the wide ring to carry at least as many vertices');
  // narrow arc-length parameterization
  const narrowPoints = narrow.map(id => builder.vertices[id]);
  const s = [0];
  for (let i = 1; i <= N; i++) {
    const a = narrowPoints[i - 1], b = narrowPoints[i % N];
    s.push(s[i - 1] + Math.hypot(a[0] - b[0], a[2] - b[2]));
  }
  const total = s[N] || 1;
  const paramOf = (id: number): { param: number; distance: number } => {
    const p = builder.vertices[id];
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < N; i++) {
      const a = narrowPoints[i], b = narrowPoints[(i + 1) % N];
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-12
        ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
      const d = Math.hypot(p[0] - a[0] - t * abx, p[2] - a[2] - t * abz);
      if (d < bestDistance) { bestDistance = d; best = s[i] + t * Math.sqrt(len2); }
    }
    return { param: best, distance: bestDistance };
  };
  // rotate the wide ring to start at its lowest projection parameter, then unwrap monotonically; a
  // handful of shallow twisted quads can survive near bays, and integrate's guarded relaxation opens
  // those downstream (its zero-inverted gate is the arbiter)
  const projected = wide.map(paramOf);
  const rawParams = projected.map(entry => entry.param);
  let start = 0;
  for (let j = 1; j < W; j++) if (rawParams[j] < rawParams[start]) start = j;
  const rotated = [...wide.slice(start), ...wide.slice(0, start)];
  const params = [...rawParams.slice(start), ...rawParams.slice(0, start)];
  for (let j = 1; j < W; j++) {
    while (params[j] < params[j - 1] - total / 2) params[j] += total;
    if (params[j] < params[j - 1]) params[j] = params[j - 1];
  }
  // bucket each wide edge by its midpoint's narrow edge, walking both monotonically
  const buckets = new Array<number>(N).fill(0);
  for (let j = 0; j < W; j++) {
    const next = j + 1 < W ? params[j + 1] : params[0] + total;
    const mid = ((params[j] + next) / 2) % total;
    let low = 0, high = N;
    while (low < high - 1) {
      const middle = (low + high) >> 1;
      if (s[middle] <= mid) low = middle; else high = middle;
    }
    buckets[low]++;
  }
  // rebalance to odd bucket sizes (a bucket must hold 2k+1 wide edges: k kites and one regular); the
  // last bucket keeps whatever parity remains and pays it as the closing triangle
  let carry = 0;
  const assigned = new Array<number>(N).fill(0);
  for (let i = 0; i < N; i++) {
    const available = buckets[i] + carry;
    if (i === N - 1) { assigned[i] = available; break; }
    const odd = available < 1 ? 1 : available % 2 ? available : available - 1;
    assigned[i] = odd;
    carry = available - odd;
  }
  if (assigned[N - 1] < 1) {
    // starved tail: pull back from earlier buckets
    for (let i = N - 2; i >= 0 && assigned[N - 1] < 1; i--) {
      while (assigned[i] > 1 && assigned[N - 1] < 1) { assigned[i] -= 2; assigned[N - 1] += 2; }
    }
    if (assigned[N - 1] < 1) throw new Error('ring knit could not distribute its wide edges');
  }
  const triangle = 1 - (assigned[N - 1] % 2);
  let iw = 0;
  const w = (k: number) => rotated[k % W];
  for (let i = 0; i < N; i++) {
    const n0 = narrow[i], n1 = narrow[(i + 1) % N];
    let remaining = assigned[i];
    while (remaining >= 3) {
      builder.addQuad(n0, w(iw), w(iw + 1), w(iw + 2));
      iw += 2; remaining -= 2;
    }
    if (remaining === 2) {
      // even tail bucket: regular quad plus the parity triangle
      builder.addQuad(n0, w(iw), w(iw + 1), n1);
      iw += 1;
      builder.addTri(n1, w(iw), w(iw + 1));
      iw += 1;
    } else {
      builder.addQuad(n0, w(iw), w(iw + 1), n1);
      iw += 1;
    }
  }
  if (iw !== W) throw new Error(`ring knit consumed ${iw} of ${W} wide edges`);
  return triangle;
}

/**
 * Chain arc rows into open composites. Two arcs chain only when the connector chord between their
 * endpoints stays on covered ground clear of the region boundary — a chord across a corner of the moat is
 * fine (its single-quad edge falls to the join ring), a chord across a locked hole would drape quads over
 * the feature and is refused, which is exactly what splits a contour interrupted by a trail into separate
 * chains either side of it.
 */
export function chainArcSets(builder: Builder, raster: Raster, moat: number, arcRows: Row[], cell: number): number[][] {
  const admissible = (a: number, b: number): boolean => {
    const pa = builder.vertices[a], pb = builder.vertices[b];
    const length = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
    if (length > 3 * cell) return false;
    const samples = Math.max(2, Math.ceil(length / (raster.step * 2)));
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const clearance = bilinear(raster, raster.clearance,
        pa[0] + (pb[0] - pa[0]) * t, pa[2] + (pb[2] - pa[2]) * t);
      if (!(clearance >= moat * .5)) return false;
    }
    return true;
  };
  const chains = arcRows.map(row => [...row.ids]);
  for (let guard = 0; guard < arcRows.length * arcRows.length + 4; guard++) {
    let bestA = -1, bestB = -1, bestFlipA = false, bestFlipB = false, bestDistance = Infinity;
    for (let i = 0; i < chains.length; i++) for (let j = 0; j < chains.length; j++) {
      if (i === j) continue;
      // consider joining i's tail to j's head, flipping either chain
      for (const flipI of [false, true]) for (const flipJ of [false, true]) {
        const tail = flipI ? chains[i][0] : chains[i][chains[i].length - 1];
        const head = flipJ ? chains[j][chains[j].length - 1] : chains[j][0];
        const pa = builder.vertices[tail], pb = builder.vertices[head];
        const d = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
        if (d < bestDistance && admissible(tail, head)) {
          bestDistance = d; bestA = i; bestB = j; bestFlipA = flipI; bestFlipB = flipJ;
        }
      }
    }
    if (bestA < 0) break;
    const merged = [
      ...(bestFlipA ? [...chains[bestA]].reverse() : chains[bestA]),
      ...(bestFlipB ? [...chains[bestB]].reverse() : chains[bestB]),
    ];
    const removed = Math.max(bestA, bestB), kept = Math.min(bestA, bestB);
    chains.splice(removed, 1);
    chains[kept] = merged;
  }
  return chains;
}

/**
 * Knit an open chain against the matching sub-arc of an already-composed cycle. Every chain vertex
 * projects onto the cycle and the params unwrap monotonically, so the sub-arc's span AND direction come
 * from the geometry rather than an endpoint guess — a chain wrapping most of a figure-eight claims the
 * long way around because its own vertices trace it. The cycle stretch the chain does not face keeps
 * single-sided edges for the join ring; the sub-arc trims to agree with the chain's parity, and `used`
 * marks cycle edges already claimed by another chain.
 */
export function knitChainToCycle(
  builder: Builder, chain: number[], cycle: number[], used: boolean[],
): boolean {
  const n = cycle.length;
  const cyclePoints = cycle.map(id => builder.vertices[id]);
  const s = [0];
  for (let i = 1; i <= n; i++) {
    const a = cyclePoints[i - 1], b = cyclePoints[i % n];
    s.push(s[i - 1] + Math.hypot(a[0] - b[0], a[2] - b[2]));
  }
  const total = s[n] || 1;
  const paramOf = (id: number): number => {
    const p = builder.vertices[id];
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < n; i++) {
      const a = cyclePoints[i], b = cyclePoints[(i + 1) % n];
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-12
        ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
      const d = Math.hypot(p[0] - a[0] - t * abx, p[2] - a[2] - t * abz);
      if (d < bestDistance) { bestDistance = d; best = s[i] + t * Math.sqrt(len2); }
    }
    return best;
  };
  const params = chain.map(paramOf);
  // unwrap in whichever direction the chain actually advances
  let forwardVotes = 0;
  for (let i = 1; i < params.length; i++) {
    let diff = params[i] - params[i - 1];
    if (diff > total / 2) diff -= total;
    if (diff < -total / 2) diff += total;
    forwardVotes += Math.sign(diff);
  }
  const oriented = forwardVotes >= 0 ? chain : [...chain].reverse();
  const orientedParams = forwardVotes >= 0 ? params : [...params].reverse();
  for (let i = 1; i < orientedParams.length; i++) {
    while (orientedParams[i] < orientedParams[i - 1] - total / 2) orientedParams[i] += total;
    if (orientedParams[i] < orientedParams[i - 1]) orientedParams[i] = orientedParams[i - 1];
  }
  const spanFrom = orientedParams[0], spanTo = orientedParams[orientedParams.length - 1];
  // cycle vertex indices covering [spanFrom, spanTo]
  const indexAt = (param: number): number => {
    const wrapped = ((param % total) + total) % total;
    let low = 0, high = n;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (s[mid] <= wrapped) low = mid; else high = mid;
    }
    return low;
  };
  const first = indexAt(spanFrom), last = indexAt(spanTo);
  const subArc: number[] = [];
  if (spanTo - spanFrom >= total) {
    // the chain wraps the whole cycle (an arc circling the first closed loop above it): open the cycle
    // at the chain's start and ladder against all of it — the shared first vertex becomes a pole
    if (used.some(Boolean)) return false;
    for (let i = 0; i <= n; i++) subArc.push(cycle[(first + i) % n]);
  } else {
    for (let i = first; ; i = (i + 1) % n) {
      subArc.push(cycle[i]);
      if (i === (last + 1) % n && subArc.length > 1) break;
      if (subArc.length > n) break;
    }
  }
  if (subArc.length < 2) return false;
  let sub = subArc;
  if (sub.length % 2 !== oriented.length % 2) {
    if (sub.length <= 2) return false;
    sub = sub.slice(0, -1);
  }
  const indexOfIn = new Map(cycle.map((id, index) => [id, index]));
  const arcEdges: number[] = [];
  for (let i = 0; i + 1 < sub.length; i++) {
    const a = indexOfIn.get(sub[i])!, b = indexOfIn.get(sub[i + 1])!;
    arcEdges.push((Math.min(a, b) === 0 && Math.max(a, b) === n - 1) ? n - 1 : Math.min(a, b));
  }
  if (arcEdges.some(edge => used[edge])) return false;
  for (const edge of arcEdges) used[edge] = true;
  knitOrientedChains(builder, sub, oriented);
  return true;
}

/**
 * Knit a guest chain into the matching sub-range of a longer host chain, claiming the host's edges so
 * several guests (a contour splitting or merging across the band) share one host without overlap. The
 * host's unclaimed stretches stay open for other guests or the join ring.
 */
export function knitChainIntoHost(
  builder: Builder, guest: number[], host: number[], used: boolean[], why?: string[],
): boolean {
  const nearestIndex = (id: number): number => {
    const p = builder.vertices[id];
    let best = 0, bestDistance = Infinity;
    for (let i = 0; i < host.length; i++) {
      const q = builder.vertices[host[i]];
      const d = Math.hypot(p[0] - q[0], p[2] - q[2]);
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  };
  // The guest's footprint on the host is NOT one interval when the guest hooks — a contour chopped by
  // a hole has both ends at the hole's moat, facing the host's two ends with far ground between. Split
  // the guest wherever its projections jump, and knit each piece to its own host interval; the cut edge
  // between pieces stays open for the join ring.
  const nearest = guest.map(nearestIndex);
  const jump = Math.max(4, Math.round(host.length / 4));
  const pieces: [number, number][] = [];
  let pieceStart = 0;
  for (let i = 1; i <= guest.length; i++) {
    if (i === guest.length || Math.abs(nearest[i] - nearest[i - 1]) > jump) {
      pieces.push([pieceStart, i - 1]);
      pieceStart = i;
    }
  }
  let any = false;
  for (const [gFrom, gTo] of pieces) {
    if (gTo - gFrom < 1) continue;
    const piece = guest.slice(gFrom, gTo + 1);
    let from = host.length, to = -1;
    for (let i = gFrom; i <= gTo; i++) {
      if (nearest[i] < from) from = nearest[i];
      if (nearest[i] > to) to = nearest[i];
    }
    if (to === from) to = Math.min(host.length - 1, from + 1);
    // another guest may already hold part of this stretch (their parity extensions overlap by an edge);
    // keep the longest unclaimed run instead of giving up on the whole knit
    let runFrom = -1, bestFrom = -1, bestTo = -1;
    for (let e = from; e < to; e++) {
      if (used[e]) { runFrom = -1; continue; }
      if (runFrom < 0) runFrom = e;
      if (bestFrom < 0 || e - runFrom > bestTo - bestFrom) { bestFrom = runFrom; bestTo = e; }
    }
    if (bestFrom < 0) { why?.push(`host span ${from}..${to} fully claimed`); continue; }
    from = bestFrom; to = bestTo + 1;
    let sub = host.slice(from, to + 1);
    if (sub.length % 2 !== piece.length % 2) {
      if (to + 1 < host.length && !used[to]) { to++; sub = host.slice(from, to + 1); }
      else if (from > 0 && !used[from - 1]) { from--; sub = host.slice(from, to + 1); }
      else if (sub.length > 2) { to--; sub = host.slice(from, to + 1); }
      else { why?.push(`parity trim impossible on span ${from}..${to}`); continue; }
    }
    if (Array.from({ length: to - from }, (_ignored, i) => used[from + i]).some(Boolean)) {
      why?.push(`claim clash inside span ${from}..${to}`);
      continue;
    }
    for (let i = from; i < to; i++) used[i] = true;
    knitOrientedChains(builder, sub, piece);
    any = true;
  }
  return any;
}

/** Median distance from one open chain's sampled vertices to another chain's polyline — median, because
 *  a chain whose tail wraps a feature its partner does not reach would inflate a mean beyond pairing. */
export function medianChainDistance(builder: Builder, from: number[], to: number[]): number {
  const stride = Math.max(1, Math.floor(from.length / 16));
  const distances: number[] = [];
  for (let i = 0; i < from.length; i += stride) {
    const p = builder.vertices[from[i]];
    let best = Infinity;
    for (let j = 0; j + 1 < to.length; j++) {
      const a = builder.vertices[to[j]], b = builder.vertices[to[j + 1]];
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const len2 = abx * abx + abz * abz;
      const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
      best = Math.min(best, Math.hypot(p[0] - a[0] - t * abx, p[2] - a[2] - t * abz));
    }
    distances.push(best);
  }
  if (!distances.length) return Infinity;
  distances.sort((a, b) => a - b);
  return distances[Math.floor(distances.length / 2)];
}

/** Knit two open chains, flipping for endpoint agreement; a parity mismatch trades the upper chain's end
 *  vertex (its dropped edge sits on the coastline, where the join ring closes anyway). */
function knitOrientedChains(builder: Builder, lower: number[], upper: number[]): void {
  let b = upper;
  if (lower.length % 2 !== b.length % 2) b = b.slice(0, -1);
  if (lower.length < 2 || b.length < 2) return;
  const p0 = builder.vertices[lower[0]], p1 = builder.vertices[lower[lower.length - 1]];
  const q0 = builder.vertices[b[0]], q1 = builder.vertices[b[b.length - 1]];
  const straight = Math.hypot(p0[0] - q0[0], p0[2] - q0[2]) + Math.hypot(p1[0] - q1[0], p1[2] - q1[2]);
  const flipped = Math.hypot(p0[0] - q1[0], p0[2] - q1[2]) + Math.hypot(p1[0] - q0[0], p1[2] - q0[2]);
  knitChain(builder, { ids: lower, closed: false },
    { ids: straight <= flipped ? b : [...b].reverse(), closed: false });
}

/** Cap a closed even row with a centre-vertex quad fan (pairing consecutive edges: a count/2 pole). */
export function capRow(builder: Builder, row: number[], raster: Raster): void {
  if (row.length % 2) throw new Error('cap rows must be even');
  let cx = 0, cz = 0;
  for (const id of row) { cx += builder.vertices[id][0]; cz += builder.vertices[id][2]; }
  cx /= row.length; cz /= row.length;
  const y = bilinear(raster, raster.height, cx, cz);
  const centre = builder.addVertex(cx, Number.isNaN(y) ? builder.vertices[row[0]][1] : y, cz);
  for (let i = 0; i < row.length; i += 2) {
    builder.addQuad(row[i], row[(i + 1) % row.length], row[(i + 2) % row.length], centre);
  }
}

// ---- composite cycles (saddles, merged joins) ------------------------------------------------------------

interface RingAttachment { child: number; at: number; childAt: number }

/** Minimum spanning tree over the rings' closest XZ approaches, as parent-ring attachment records. */
function ringSpanningTree(builder: Builder, rings: number[][]): Map<number, RingAttachment[]> {
  interface Pair { ai: number; bi: number; d: number }
  const pairs = new Map<string, Pair>();
  const pair = (i: number, j: number): Pair => {
    const key = `${Math.min(i, j)},${Math.max(i, j)}`;
    let found = pairs.get(key);
    if (!found) {
      const [ra, rb] = [rings[Math.min(i, j)], rings[Math.max(i, j)]];
      found = { ai: 0, bi: 0, d: Infinity };
      for (let a = 0; a < ra.length; a++) for (let b = 0; b < rb.length; b++) {
        const pa = builder.vertices[ra[a]], pb = builder.vertices[rb[b]];
        const d = Math.hypot(pa[0] - pb[0], pa[2] - pb[2]);
        if (d < found.d) found = { ai: a, bi: b, d };
      }
      pairs.set(key, found);
    }
    return i < j ? found : { ai: found.bi, bi: found.ai, d: found.d };
  };
  const inTree = new Set<number>([0]);
  const children = new Map<number, RingAttachment[]>();
  while (inTree.size < rings.length) {
    let best: { from: number; to: number; d: number } | null = null;
    for (const from of inTree) for (let to = 0; to < rings.length; to++) {
      if (inTree.has(to)) continue;
      const d = pair(from, to).d;
      if (!best || d < best.d) best = { from, to, d };
    }
    const { from, to } = best!;
    inTree.add(to);
    const bridgePair = pair(from, to);
    const list = children.get(from) ?? [];
    list.push({ child: to, at: bridgePair.ai, childAt: bridgePair.bi });
    children.set(from, list);
  }
  return children;
}

/** Euler tour of a ring tree. `enterShift` picks the child entry relative to its attachment vertex and
 *  `visitChild` renders one child excursion. */
function ringTour(
  rings: number[][],
  children: Map<number, RingAttachment[]>,
  enterShift: number,
  visitChild: (out: number[], parent: number[], attachment: RingAttachment, sub: number[]) => void,
): number[] {
  const tour = (ring: number, enterAt: number): number[] => {
    const ids = rings[ring], n = ids.length;
    const attachments = [...(children.get(ring) ?? [])]
      .sort((a, b) => ((a.at - enterAt + n) % n) - ((b.at - enterAt + n) % n));
    const out: number[] = [];
    let cursor = enterAt;
    const walkTo = (target: number) => {
      for (let i = cursor; ; i = (i + 1) % n) {
        out.push(ids[i]);
        if (i === target) break;
      }
      cursor = (target + 1) % n;
    };
    for (const attachment of attachments) {
      walkTo(attachment.at);
      const childRing = rings[attachment.child];
      visitChild(out, ids, attachment,
        tour(attachment.child, (attachment.childAt + enterShift) % childRing.length));
    }
    walkTo((enterAt - 1 + n) % n);
    return out;
  };
  return tour(0, 0);
}

/**
 * Weld rows that split or merge across a band into one cycle for the saddle knit: the nearest vertex pair
 * of each spanning-tree edge is REPLACED by one shared col vertex, mutating the rows in place so the bands
 * above knit the very same vertex, then the cycle opens each ring at its shared vertex (the figure-eight).
 * Every ring edge appears exactly once, so each still receives its one quad from the neighbouring band.
 */
export function weldCycle(builder: Builder, raster: Raster, rows: Row[]): number[] {
  const rings = rows.map(row => row.ids);
  if (rings.length === 1) return rings[0];
  const children = ringSpanningTree(builder, rings);
  for (const [parent, attachments] of children) for (const attachment of attachments) {
    const pa = builder.vertices[rings[parent][attachment.at]];
    const pb = builder.vertices[rings[attachment.child][attachment.childAt]];
    const x = (pa[0] + pb[0]) / 2, z = (pa[2] + pb[2]) / 2;
    const y = bilinear(raster, raster.height, x, z);
    const col = builder.addVertex(x, Number.isNaN(y) ? (pa[1] + pb[1]) / 2 : y, z);
    rings[parent][attachment.at] = col;
    rings[attachment.child][attachment.childAt] = col;
  }
  // sub starts one past the shared col and ends on it, so the parent's copy flows into the child's arc
  // and the child's closing edge returns to the shared col before the parent resumes
  return ringTour(rings, children, 1, (out, _parent, _attachment, sub) => out.push(...sub));
}

/**
 * Compose target rims into one cycle without touching their vertices: each spanning-tree hop crosses the
 * nearest-pair edge twice (once out, once back), which leaves that hop an interior edge of the knit while
 * every rim edge keeps exactly one knit quad — rims stay the candidate's entire boundary.
 */
export function bridgeCycle(builder: Builder, rings: number[][]): number[] {
  if (rings.length === 1) return rings[0];
  const children = ringSpanningTree(builder, rings);
  return ringTour(rings, children, 0, (out, parent, attachment, sub) => {
    // sub = child from its paired vertex fully around; re-push that vertex to close the child's own
    // ring, then return across the same hop so the hop edge is traversed exactly twice
    out.push(...sub, sub[0], parent[attachment.at]);
  });
}

// ---- ring geometry helpers -------------------------------------------------------------------------------

const ringShoelace = (builder: Builder, ids: number[]): number => {
  let area = 0;
  for (let i = 0; i < ids.length; i++) {
    const p = builder.vertices[ids[i]], q = builder.vertices[ids[(i + 1) % ids.length]];
    area += p[0] * q[2] - q[0] * p[2];
  }
  return area;
};

/** Normalize a ring to the winding whose XZ shoelace is negative (the editor's skyward orientation). */
export const skyward = (builder: Builder, ids: number[]): number[] =>
  ringShoelace(builder, ids) > 0 ? [...ids].reverse() : ids;

/** Knit two closed rings, winding-normalized. Returns the parity-triangle count. */
export function knitAligned(builder: Builder, ringA: number[], ringB: number[]): number {
  const a = skyward(builder, ringA), b = skyward(builder, ringB);
  const [narrow, wide] = a.length <= b.length ? [a, b] : [b, a];
  return knitRings(builder, narrow, wide);
}

export function pointInRing(builder: Builder, ids: number[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) {
    const a = builder.vertices[ids[i]], b = builder.vertices[ids[j]];
    if ((a[2] > z) !== (b[2] > z) && x < a[0] + ((b[0] - a[0]) * (z - a[2])) / (b[2] - a[2])) inside = !inside;
  }
  return inside;
}

export const ringCentroid = (builder: Builder, ids: number[]): [number, number] => {
  let x = 0, z = 0;
  for (const id of ids) { x += builder.vertices[id][0]; z += builder.vertices[id][2]; }
  return [x / ids.length, z / ids.length];
};

/** Shrink a closed ring toward its centroid and register the smaller (even, strictly shorter) ring. */
function shrunkRing(builder: Builder, raster: Raster, ring: number[], cell: number): number[] {
  const [cx, cz] = ringCentroid(builder, ring);
  const points: [number, number][] = ring.map(id => {
    const p = builder.vertices[id];
    return [p[0] + (cx - p[0]) * .5, p[2] + (cz - p[2]) * .5];
  });
  const curve: LevelCurve = { points, closed: true };
  const perimeter = curveLength(curve);
  let count = Math.max(6, Math.round(perimeter / cell));
  if (count % 2) count++;
  while (count >= ring.length && count > 6) count -= 2;
  const positions = resampleCurve(curve, perimeter / count);
  return positions.map(([x, z]) => {
    const y = bilinear(raster, raster.height, x, z);
    return builder.addVertex(x, Number.isNaN(y) ? builder.vertices[ring[0]][1] : y, z);
  });
}

/** Cap a closed ring, knitting shrinking rings until a centre fan fits. */
export function shrinkCap(builder: Builder, raster: Raster, ring: number[], cell: number): void {
  let current = ring;
  for (let guard = 0; guard < 24 && current.length > CAP_LIMIT; guard++) {
    const inner = shrunkRing(builder, raster, current, cell);
    knitAligned(builder, inner, current);
    current = inner;
  }
  capRow(builder, skyward(builder, current), raster);
}
