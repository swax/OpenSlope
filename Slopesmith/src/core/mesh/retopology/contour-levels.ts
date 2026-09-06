import { bilinear, type Raster } from './contour-raster';

/** Contour flow, stage 3 (SWEEP), scalar half: the level schedule, the marching-squares iso-curves,
 *  their clearance clip and resampling, and the band component labelling. See ./contour.ts. */

/** Slope floor for the level schedule, so a dead-flat bench cannot demand unbounded loop counts. */
const MINIMUM_GRADE = 0.04;

// ---- level curves ----------------------------------------------------------------------------------------

export interface LevelCurve {
  /** XZ polyline; a closed curve repeats no point, an open curve ends on the moat line. */
  points: [number, number][];
  closed: boolean;
}

/**
 * Extract the level's iso-curves of the graded height over covered nodes. Segments connect by exact
 * cell-edge identity (no positional fuzz); crossings interpolate linearly along node edges.
 */
export function marchLevel(raster: Raster, level: number): LevelCurve[] {
  const { width, depth, height } = raster;
  const crossings = new Map<number, [number, number]>();
  const key = (node: number, vertical: boolean): number => node * 2 + (vertical ? 1 : 0);
  const crossing = (node: number, vertical: boolean): [number, number] | null => {
    const id = key(node, vertical);
    const found = crossings.get(id);
    if (found) return found;
    const a = height[node], b = height[vertical ? node + width : node + 1];
    if (Number.isNaN(a) || Number.isNaN(b) || (a < level) === (b < level)) return null;
    const t = (level - a) / (b - a);
    const ix = node % width, iz = (node - ix) / width;
    const point: [number, number] = vertical
      ? [raster.x0 + ix * raster.step, raster.z0 + (iz + t) * raster.step]
      : [raster.x0 + (ix + t) * raster.step, raster.z0 + iz * raster.step];
    crossings.set(id, point);
    return point;
  };
  const links = new Map<number, number[]>();
  const link = (a: number, b: number) => {
    const la = links.get(a); if (la) la.push(b); else links.set(a, [b]);
    const lb = links.get(b); if (lb) lb.push(a); else links.set(b, [a]);
  };
  for (let iz = 0; iz + 1 < depth; iz++) for (let ix = 0; ix + 1 < width; ix++) {
    const node = iz * width + ix;
    const h00 = height[node], h10 = height[node + 1], h01 = height[node + width], h11 = height[node + width + 1];
    if (Number.isNaN(h00) || Number.isNaN(h10) || Number.isNaN(h01) || Number.isNaN(h11)) continue;
    const bottom = crossing(node, false) ? key(node, false) : -1;
    const top = crossing(node + width, false) ? key(node + width, false) : -1;
    const left = crossing(node, true) ? key(node, true) : -1;
    const right = crossing(node + 1, true) ? key(node + 1, true) : -1;
    const ends = [bottom, right, top, left].filter(id => id >= 0);
    if (ends.length === 2) link(ends[0], ends[1]);
    else if (ends.length === 4) {
      // the ambiguous saddle cell pairs edges so the curve separates the corner on the centre's side
      const centreAbove = (h00 + h10 + h01 + h11) / 4 >= level;
      if (centreAbove === !(h00 < level)) { link(bottom, right); link(top, left); }
      else { link(bottom, left); link(top, right); }
    }
  }
  const curves: LevelCurve[] = [];
  const consumed = new Set<number>();
  const walk = (start: number, first: number): number[] => {
    const path = [start, first];
    consumed.add(start); consumed.add(first);
    for (;;) {
      const at = path[path.length - 1], previous = path[path.length - 2];
      const next = (links.get(at) ?? []).find(id => id !== previous && !consumed.has(id));
      if (next === undefined) return path;
      consumed.add(next);
      path.push(next);
    }
  };
  for (const [id, neighbors] of links) {
    if (consumed.has(id) || neighbors.length !== 1) continue;
    curves.push({ points: walk(id, neighbors[0]).map(edge => crossings.get(edge)!), closed: false });
  }
  for (const [id, neighbors] of links) {
    if (consumed.has(id)) continue;
    const path = walk(id, neighbors[0]);
    const back = links.get(path[path.length - 1]) ?? [];
    curves.push({ points: path.map(edge => crossings.get(edge)!), closed: back.includes(id) });
  }
  return curves;
}

/** Keep the parts of a curve standing at least `moat` off the boundary; ends interpolate onto the moat line. */
export function clipToClearance(raster: Raster, curve: LevelCurve, moat: number): LevelCurve[] {
  const inside = curve.points.map(([x, z]) => bilinear(raster, raster.clearance, x, z) >= moat);
  if (inside.every(Boolean)) return [curve];
  const cut = (a: [number, number], b: [number, number]): [number, number] => {
    let lo = 0, hi = 1;
    const fromInside = bilinear(raster, raster.clearance, a[0], a[1]) >= moat;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      const value = bilinear(raster, raster.clearance,
        a[0] + (b[0] - a[0]) * mid, a[1] + (b[1] - a[1]) * mid) >= moat;
      if (value === fromInside) lo = mid; else hi = mid;
    }
    const t = (lo + hi) / 2;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const points = curve.closed ? [...curve.points, curve.points[0]] : curve.points;
  const flags = curve.closed ? [...inside, inside[0]] : inside;
  const pieces: LevelCurve[] = [];
  let run: [number, number][] | null = null;
  for (let i = 0; i < points.length; i++) {
    if (flags[i]) {
      if (!run) {
        run = [];
        if (i > 0) run.push(cut(points[i], points[i - 1]));
      }
      run.push(points[i]);
    } else if (run) {
      run.push(cut(points[i - 1], points[i]));
      if (run.length >= 2) pieces.push({ points: run, closed: false });
      run = null;
    }
  }
  if (run && run.length >= 2) pieces.push({ points: run, closed: false });
  // a clipped closed curve wraps across its seam: merge the last piece into the first when they meet there
  if (curve.closed && pieces.length >= 2 && inside[0]) {
    const first = pieces[0], last = pieces[pieces.length - 1];
    const tail = last.points[last.points.length - 1];
    if (Math.hypot(first.points[0][0] - tail[0], first.points[0][1] - tail[1]) < raster.step * .01) {
      pieces.pop();
      pieces[0] = { points: [...last.points.slice(0, -1), ...first.points], closed: false };
    }
  }
  return pieces;
}

export const curveLength = (curve: LevelCurve): number => {
  let length = 0;
  const n = curve.points.length;
  for (let i = 1; i < n; i++) length += Math.hypot(
    curve.points[i][0] - curve.points[i - 1][0], curve.points[i][1] - curve.points[i - 1][1]);
  if (curve.closed) length += Math.hypot(
    curve.points[0][0] - curve.points[n - 1][0], curve.points[0][1] - curve.points[n - 1][1]);
  return length;
};

/**
 * Evenly resample a curve at approximately the cell size. Closed rows always take an even count so caps
 * and saddle rows stay all-quad by construction; open rows take the parity the caller needs.
 */
export function resampleCurve(curve: LevelCurve, cell: number, parity?: number): [number, number][] {
  const closed = curve.closed;
  const total = curveLength(curve);
  let count = Math.max(closed ? 6 : 2, Math.round(total / cell) + (closed ? 0 : 1));
  if (closed && count % 2) count++;
  if (!closed && parity !== undefined && count % 2 !== parity) count++;
  const source = closed ? [...curve.points, curve.points[0]] : curve.points;
  const cumulative = [0];
  for (let i = 1; i < source.length; i++) cumulative.push(cumulative[i - 1]
    + Math.hypot(source[i][0] - source[i - 1][0], source[i][1] - source[i - 1][1]));
  const steps = closed ? count : count - 1;
  const out: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const s = steps ? (k * total) / steps : 0;
    let low = 0, high = source.length - 1;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] <= s) low = mid; else high = mid;
    }
    const span = cumulative[low + 1] - cumulative[low];
    const t = span > 1e-12 ? (s - cumulative[low]) / span : 0;
    out.push([source[low][0] + (source[low + 1][0] - source[low][0]) * t,
      source[low][1] + (source[low + 1][1] - source[low][1]) * t]);
  }
  return out;
}

// ---- band sweep ------------------------------------------------------------------------------------------

/** Contour levels walked so consecutive loops stand about one cell apart on the surface: the elevation
 *  gap tracks the mean gradient of the band being crossed, floored so a bench cannot demand unbounded
 *  loop counts. */
export function scheduleLevels(raster: Raster, cell: number): number[] {
  const { width, depth, height, step } = raster;
  let minY = Infinity, maxY = -Infinity;
  for (const value of height) {
    if (Number.isNaN(value)) continue;
    if (value < minY) minY = value;
    if (value > maxY) maxY = value;
  }
  if (!Number.isFinite(minY) || maxY - minY < 1e-6) return [];
  const bins = 256;
  const gradientSum = new Float64Array(bins), gradientCount = new Float64Array(bins);
  for (let iz = 1; iz + 1 < depth; iz++) for (let ix = 1; ix + 1 < width; ix++) {
    const at = iz * width + ix;
    const here = height[at], west = height[at - 1], east = height[at + 1];
    const north = height[at - width], south = height[at + width];
    if ([here, west, east, north, south].some(Number.isNaN)) continue;
    const magnitude = Math.hypot((east - west) / (2 * step), (south - north) / (2 * step));
    const bin = Math.min(bins - 1, Math.floor(((here - minY) / (maxY - minY)) * bins));
    gradientSum[bin] += magnitude; gradientCount[bin]++;
  }
  const gradeAt = (y: number): number => {
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(((y - minY) / (maxY - minY)) * bins)));
    for (let reach = 0; reach < bins; reach++) {
      for (const candidate of [bin - reach, bin + reach]) {
        if (candidate >= 0 && candidate < bins && gradientCount[candidate]) {
          return gradientSum[candidate] / gradientCount[candidate];
        }
      }
    }
    return MINIMUM_GRADE;
  };
  const levels: number[] = [];
  let y = minY;
  for (let guard = 0; guard < 500; guard++) {
    y += cell * Math.max(MINIMUM_GRADE, Math.min(3, gradeAt(y)));
    if (y >= maxY) break;
    levels.push(y);
  }
  return levels;
}

export interface BandComponents {
  labels: Int32Array;
  count: number;
}

/** 4-connected components of nodes inside the band and off the moat. */
export function bandComponents(raster: Raster, low: number, high: number, moat: number): BandComponents {
  const { width, height, clearance } = raster;
  const labels = new Int32Array(height.length).fill(-1);
  let count = 0;
  const stack: number[] = [];
  const eligible = (at: number): boolean => {
    const value = height[at];
    return !Number.isNaN(value) && value >= low && value <= high && clearance[at] >= moat;
  };
  for (let seed = 0; seed < labels.length; seed++) {
    if (labels[seed] >= 0 || !eligible(seed)) continue;
    labels[seed] = count;
    stack.push(seed);
    while (stack.length) {
      const at = stack.pop()!;
      const ix = at % width;
      for (const next of [ix > 0 ? at - 1 : -1, ix < width - 1 ? at + 1 : -1,
        at - width, at + width]) {
        if (next < 0 || next >= labels.length || labels[next] >= 0 || !eligible(next)) continue;
        labels[next] = count;
        stack.push(next);
      }
    }
    count++;
  }
  return { labels, count };
}

/** Which band component a curve borders, probing points nudged into the band along the gradient. */
export function componentOf(
  raster: Raster, components: BandComponents, curve: LevelCurve, uphill: boolean,
): number {
  const votes = new Map<number, number>();
  const samples = Math.min(7, curve.points.length);
  for (let k = 0; k < samples; k++) {
    const [x, z] = curve.points[Math.floor((k * (curve.points.length - 1)) / Math.max(1, samples - 1))];
    const gx = bilinear(raster, raster.height, x + raster.step, z)
      - bilinear(raster, raster.height, x - raster.step, z);
    const gz = bilinear(raster, raster.height, x, z + raster.step)
      - bilinear(raster, raster.height, x, z - raster.step);
    const length = Math.hypot(gx, gz);
    if (!(length > 1e-12)) continue;
    const sign = uphill ? 1 : -1;
    for (const reach of [1, 2]) {
      const px = x + (sign * reach * raster.step * gx) / length;
      const pz = z + (sign * reach * raster.step * gz) / length;
      const ix = Math.round((px - raster.x0) / raster.step), iz = Math.round((pz - raster.z0) / raster.step);
      if (ix < 0 || ix >= raster.width || iz < 0 || iz >= raster.depth) continue;
      const label = components.labels[iz * raster.width + ix];
      if (label >= 0) { votes.set(label, (votes.get(label) ?? 0) + 1); break; }
    }
  }
  let best = -1, bestVotes = 0;
  for (const [label, count] of votes) if (count > bestVotes) { best = label; bestVotes = count; }
  return best;
}
