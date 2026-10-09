import type { CoursePath, V3 } from '../../core/doc/types';
import { aiPathLines, startStation } from '../../core/doc/course';
import { paramsAt, sampleSpine } from '../../core/math/spine';
import { surfaceFor } from './physics-math';
import { RIDE_MAX_SPEED, RIDE_SIMULATION_HZ } from './ride-contract.generated';
import {
  RIDE_TICK, STALL_SPEED, airTick, easeCap, groundTick, rideSurface, takeoff, touchdown, turnSurface,
  type Flight, type GroundRider, type RideSurface,
} from './trail-speed';

/**
 * The speed a rider carries over a mountain's course (docs/023 · Predicted speed, the mountain): the trail
 * prediction's rider (trail-speed.ts) sent down the course's own lines — the course line and every AI path — rather
 * than loose on the terrain, so it rides the way the course runs, with the heading and the lead-in a real rider has.
 *
 * Each line is widened into parallel lanes `LANE_SPACING_M` apart, out to its half-width, and each lane is draped on
 * the terrain under it: the surface the lane's own height leads it to, read off the quilt lattice's tangent planes,
 * the slope along the lane read off their normals. A lane is ridden like a trail path, at the ride's 60 Hz with its
 * ground terms and its clearance-against-gravity liftoff, but over the surface each stretch actually wears; and a
 * lane may leave the ground altogether — over a gap between two pieces of the quilt, off a cliff, off the end of a
 * kicker — flying on along it until the arc meets ground again. Ground nobody rides is no ground to a lane: a face
 * steeper than `WALL_DEG`, and the surfaces the ride itself does not ride (`UNRIDDEN`) — out of bounds, which carries
 * a rider back to the course the moment it stands there, the bounce and wall rows, and no collision.
 *
 * The lines starting at the gate set off from rest; a line leaving another starts with the speed the other carries
 * where it leaves. A rider that stalls, comes down on ground nobody rides, or slams into the far side of a gap it did
 * not clear starts again from rest at the next ground that does not climb — as an AI is put back on the course, and
 * as though it had set off a little up the course from what follows.
 *
 * Every point of the terrain then shows the nearest lane's ride over it, in the air where the lane is a clear
 * `AIR_CLEARANCE_M` above it; ground no lane comes near is left bare. A diagnostic, not a replay: the rider rides
 * square to its lane, without steering, carving, braking, boost or tricks, and a lane's turns cost nothing.
 */

/** Sample spacing along a lane, metres of plan. */
const SAMPLE_M = 0.5;
/** Lanes across a line, metres apart. */
const LANE_SPACING_M = 3;
/** A line's heading is taken over this much of it either side, so its offsets do not kink at every vertex. */
const HEADING_M = 4;
/** A lane follows the surface its height leads it to, no further above or below it than this. */
const DRAPE_M = 20;
/** Faces steeper than this are walls: their ride is a wall-ride, sideways and banked, which a lane cannot make. */
const WALL_DEG = 70;
const WALL_NY = Math.cos(WALL_DEG * Math.PI / 180);
/** Slopes are read off normals; one this steep is ridden as one no steeper than this. */
const MAX_SLOPE = Math.tan(85 * Math.PI / 180);
/** Surface types nobody rides (core/reference/surface-types.ts): 0 out of bounds — the ride's reset on contact —
 *  6 bounce and 10 wall, the rows the ride lets go of, and 17 no collision. */
const UNRIDDEN = new Set([0, 6, 10, 17]);
/** Lattice points closer than this are one point: the shared border of two patches, evaluated from each side. */
const WELD_M = 0.005;
/** A rider crawling slower than this per tick steps this far at a time instead, up to `MAX_STEP_S`: the slow end
 *  of a climb, or a surface without a cruise drive, would otherwise take hundreds of ticks a metre. */
const MIN_STEP_M = 0.1;
const MAX_STEP_S = 0.1;
/** Fifteen minutes of riding: a lane not finished by then is reported where its rider got to. */
const MAX_TICKS = RIDE_SIMULATION_HZ * 900;
/** A flight comes down on ground it has sunk no further below than its fall this tick and this much more; deeper,
 *  it has hit the far side of what it did not clear. */
const LANDING_DEPTH_M = 0.5;
/** Twenty seconds in the air, or this far below every bit of a lane's ground, and a flight has gone wrong — off
 *  backwards over a wall, say, from a takeoff up a face too steep to carry on along: the rider is put back on the
 *  course. */
const MAX_FLIGHT_TICKS = RIDE_SIMULATION_HZ * 20;
const FALLEN_M = 50;
/** A flight is in the air over a point once it is this far above the ground there: a skim along it is not. */
const AIR_CLEARANCE_M = 0.25;
/** A rider put back on the course starts on the next ground that climbs no more than this (slope). */
const RESTART_SLOPE = 0.05;
/** A line starting within this of another's lane (plan; and a fifth of it in height) leaves that lane there. */
const FEED_M = 15;
/** A point takes a lane's ride within this of it at least, so the gaps between lanes are covered. */
const SPLAT_M = 0.6 * LANE_SPACING_M;
/** A point takes a lane's ride on the ground only from a lane running this close to its height: the same layer. */
const LAYER_M = 2;
/** What a lane sample tells (`LaneRide.told`). */
const TOLD = 1, TOLD_AFTER_RESTART = 2;
/** Added to a restarted sample's distance when points weigh lanes, so any unbroken ride near enough wins. */
const RESTARTED_RANK = 1e6;

/** The quilt the terrain is drawn from: patch-major, `side²` lattice points per patch. */
export interface SpeedQuilt {
  /** Lattice positions, xyz flat, in data space. */
  positions: ArrayLike<number>;
  /** Unit surface normals, index-parallel. */
  normals: ArrayLike<number>;
  /** Each patch's surface type. */
  cellSurf: ArrayLike<number>;
  /** Lattice points along a patch's side. */
  side: number;
}

/** One of the course's lines, in data space, in riding order. */
export interface SpeedLine {
  points: readonly V3[];
  /** Ridden in lanes out to this either side, metres. */
  halfWidth: number;
  /** Set off from at the gate, from rest. A line that is not starts with the speed of the line it leaves. */
  start: boolean;
}

/** The ride predicted over every lattice point of the quilt, index-parallel with its positions. */
export interface MountainSpeeds {
  /** Speed in m/s; NaN on ground a lane crosses but never reaches — past a stall. */
  speed: Float32Array;
  /** 1 where the lane over the point is in the air. */
  air: Uint8Array;
  /** 1 where nothing is shown: no lane comes near, or nobody rides the ground and no lane flies over it. */
  bare: Uint8Array;
  /** How far the first gate line's head is from any ground to ride, metres; Infinity with no ground or no line. */
  startGap: number;
}

/** The quilt welded into one surface: its points, their normals, and what is ridden where. */
interface Network {
  count: number;
  pos: Float64Array;
  normal: Float64Array;
  /** 1 where nobody rides: too steep, or every patch the point is on wears a surface nobody rides. */
  unridden: Uint8Array;
  /** The surface a lane rides at the point: a ridden patch's it is on, else any. */
  surf: Int32Array;
  /** How far in plan the point stands for the surface around it: a little over half way to its farthest neighbour,
   *  diagonals included — so every spot on a patch is within reach of one of its points. */
  reach: Float32Array;
  /** Each lattice point's network point. */
  pointOf: Int32Array;
  grid: PlanGrid;
}

/** Points binned into plan cells `cell` metres square from `x0, z0`, `nx × nz` of them, each in every cell its
 *  reach overlaps: CSR, cell `c`'s points are `items[first[c] .. first[c + 1])`. */
interface PlanGrid { cell: number; x0: number; z0: number; nx: number; nz: number; first: Int32Array; items: Int32Array }

function weld(quilt: SpeedQuilt): Network {
  const { positions, normals, cellSurf, side } = quilt;
  const lattice = positions.length / 3, perPatch = side * side;
  const pointOf = new Int32Array(lattice);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < lattice; i++) {
    minX = Math.min(minX, positions[i * 3]); maxX = Math.max(maxX, positions[i * 3]);
    minY = Math.min(minY, positions[i * 3 + 1]); maxY = Math.max(maxY, positions[i * 3 + 1]);
    minZ = Math.min(minZ, positions[i * 3 + 2]); maxZ = Math.max(maxZ, positions[i * 3 + 2]);
  }
  // Buckets a few welds wide: a point looks in every bucket its weld radius reaches, which is nearly always one.
  const bucket = WELD_M * 8;
  const nx = Math.floor((maxX - minX) / bucket) + 2, ny = Math.floor((maxY - minY) / bucket) + 2;
  const key = (ix: number, iy: number, iz: number) => ix + nx * (iy + ny * iz);
  const buckets = new Map<number, number[]>();
  const pos: number[] = [], nsum: number[] = [];
  for (let i = 0; i < lattice; i++) {
    const x = positions[i * 3] - minX, y = positions[i * 3 + 1] - minY, z = positions[i * 3 + 2] - minZ;
    let found = -1;
    for (let iz = Math.floor((z - WELD_M) / bucket); found < 0 && iz <= Math.floor((z + WELD_M) / bucket); iz++) {
      for (let iy = Math.floor((y - WELD_M) / bucket); found < 0 && iy <= Math.floor((y + WELD_M) / bucket); iy++) {
        for (let ix = Math.floor((x - WELD_M) / bucket); found < 0 && ix <= Math.floor((x + WELD_M) / bucket); ix++) {
          for (const p of buckets.get(key(ix, iy, iz)) ?? []) {
            const dx = pos[p * 3] - x, dy = pos[p * 3 + 1] - y, dz = pos[p * 3 + 2] - z;
            if (dx * dx + dy * dy + dz * dz <= WELD_M * WELD_M) { found = p; break; }
          }
        }
      }
    }
    if (found < 0) {
      found = pos.length / 3;
      pos.push(x, y, z);
      nsum.push(0, 0, 0);
      const k = key(Math.floor(x / bucket), Math.floor(y / bucket), Math.floor(z / bucket));
      const list = buckets.get(k);
      if (list) list.push(found); else buckets.set(k, [found]);
    }
    pointOf[i] = found;
    // The skyward side: a patch wound the other way still faces up here.
    const flip = normals[i * 3 + 1] < 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) nsum[found * 3 + k] += flip * normals[i * 3 + k];
  }
  const count = pos.length / 3;
  for (let p = 0; p < count; p++) {
    const len = Math.hypot(nsum[p * 3], nsum[p * 3 + 1], nsum[p * 3 + 2]) || 1;
    for (let k = 0; k < 3; k++) nsum[p * 3 + k] /= len;
    pos[p * 3] += minX; pos[p * 3 + 1] += minY; pos[p * 3 + 2] += minZ;
  }

  // A point is ridden on the surface of a ridden patch it is on; it stands for the ground half way and a little to
  // its farthest neighbour in any of them.
  const surf = new Int32Array(count).fill(-1), reach = new Float32Array(count);
  const patches = Math.floor(lattice / perPatch);
  for (let q = 0; q < patches; q++) {
    const base = q * perPatch, type = cellSurf[q] ?? 1;
    const near = (a: number, b: number) => {
      const pa = pointOf[base + a], pb = pointOf[base + b];
      const d = 0.55 * Math.hypot(pos[pa * 3] - pos[pb * 3], pos[pa * 3 + 2] - pos[pb * 3 + 2]);
      reach[pa] = Math.max(reach[pa], d); reach[pb] = Math.max(reach[pb], d);
    };
    for (let iu = 0; iu < side; iu++) {
      for (let iv = 0; iv < side; iv++) {
        const at = iu * side + iv, p = pointOf[base + at];
        if (surf[p] < 0 || (UNRIDDEN.has(surf[p]) && !UNRIDDEN.has(type))) surf[p] = type;
        if (iv + 1 < side) near(at, at + 1);
        if (iu + 1 < side) {
          near(at, at + side);
          if (iv + 1 < side) near(at, at + side + 1);
          if (iv > 0) near(at, at + side - 1);
        }
      }
    }
  }
  const unridden = new Uint8Array(count);
  for (let p = 0; p < count; p++) unridden[p] = nsum[p * 3 + 1] < WALL_NY || UNRIDDEN.has(surf[p]) ? 1 : 0;
  const posArray = Float64Array.from(pos);
  return {
    count, pos: posArray, normal: Float64Array.from(nsum), unridden, surf, reach, pointOf,
    grid: planGrid(posArray, reach, minX, minZ, maxX, maxZ),
  };
}

function planGrid(pos: Float64Array, reach: Float32Array, minX: number, minZ: number, maxX: number, maxZ: number): PlanGrid {
  const count = reach.length;
  const sorted = Array.from(reach).filter(r => r > 0).sort((a, b) => a - b);
  // Cells about twice a typical point's reach, and never under a point's splat: most points sit in four.
  const cell = Math.max(1, 2 * (sorted[sorted.length >> 1] ?? 1), SPLAT_M);
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1), nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const each = (p: number, visit: (c: number) => void) => {
    const r = Math.max(reach[p], SPLAT_M);
    const x0 = Math.max(0, Math.floor((pos[p * 3] - r - minX) / cell));
    const x1 = Math.min(nx - 1, Math.floor((pos[p * 3] + r - minX) / cell));
    const z0 = Math.max(0, Math.floor((pos[p * 3 + 2] - r - minZ) / cell));
    const z1 = Math.min(nz - 1, Math.floor((pos[p * 3 + 2] + r - minZ) / cell));
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) visit(iz * nx + ix);
  };
  const first = new Int32Array(nx * nz + 1);
  for (let p = 0; p < count; p++) each(p, c => { first[c + 1]++; });
  for (let c = 0; c < nx * nz; c++) first[c + 1] += first[c];
  const fill = first.slice(0, nx * nz), items = new Int32Array(first[nx * nz]);
  for (let p = 0; p < count; p++) each(p, c => { items[fill[c]++] = p; });
  return { cell, x0: minX, z0: minZ, nx, nz, first, items };
}

/** The grid cell over plan `x, z`, or -1 off the quilt. */
function cellAt(grid: PlanGrid, x: number, z: number): number {
  const cx = Math.floor((x - grid.x0) / grid.cell), cz = Math.floor((z - grid.z0) / grid.cell);
  return cx < 0 || cz < 0 || cx >= grid.nx || cz >= grid.nz ? -1 : cz * grid.nx + cx;
}

/** The ground's height at plan `x, z` as point `p`'s tangent plane has it — a wall's, its own height. */
function groundAt(net: Network, p: number, x: number, z: number): number {
  const { pos, normal } = net, ny = normal[p * 3 + 1];
  if (ny < WALL_NY) return pos[p * 3 + 1];
  return pos[p * 3 + 1] - (normal[p * 3] * (x - pos[p * 3]) + normal[p * 3 + 2] * (z - pos[p * 3 + 2])) / ny;
}

/** A line resampled every `SAMPLE_M` of plan: positions, and its plan heading smoothed over `HEADING_M`. */
interface Track { n: number; p: Float64Array; hx: Float64Array; hz: Float64Array }

function track(points: readonly V3[]): Track | null {
  const arc = [0];
  for (let i = 1; i < points.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][2] - points[i - 1][2]));
  }
  const total = arc[arc.length - 1];
  if (!(total > SAMPLE_M)) return null;
  const n = Math.floor(total / SAMPLE_M) + 1;
  const p = new Float64Array(n * 3);
  for (let k = 0, seg = 0; k < n; k++) {
    const s = Math.min(total, k * SAMPLE_M);
    while (seg + 1 < points.length - 1 && arc[seg + 1] < s) seg++;
    const span = arc[seg + 1] - arc[seg], t = span > 1e-9 ? (s - arc[seg]) / span : 0;
    for (let c = 0; c < 3; c++) p[k * 3 + c] = points[seg][c] + (points[seg + 1][c] - points[seg][c]) * t;
  }
  const hx = new Float64Array(n), hz = new Float64Array(n), span = Math.max(1, Math.round(HEADING_M / SAMPLE_M));
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - span), b = Math.min(n - 1, k + span);
    const dx = p[b * 3] - p[a * 3], dz = p[b * 3 + 2] - p[a * 3 + 2], len = Math.hypot(dx, dz) || 1;
    hx[k] = dx / len; hz[k] = dz / len;
  }
  return { n, p, hx, hz };
}

/** One lane draped on the terrain: per sample, its plan position and arc length, and the ground under it — the
 *  point it lies on (-1: none), whether that is a wall, its height and climb angle along the lane, and the surface
 *  ridden there (-1: none to ride). A wall is no more ground to come down on than none is: a flight passes it by. */
interface Lane {
  n: number;
  px: Float64Array; pz: Float64Array; x: Float64Array;
  node: Int32Array; wall: Uint8Array; y: Float64Array; pitch: Float64Array; surf: Int32Array;
}

/** Lay the lane `offset` metres to the left of `t` and drape it on the terrain: on the layer the lane's height leads
 *  it to, the height and normal there blended from every lattice point of that layer whose reach covers the spot —
 *  so the ground runs smooth under the lane rather than stepping from one point's tangent plane to the next, each step
 *  a kink a rider at speed would be thrown off. */
function drapeLane(net: Network, t: Track, offset: number): Lane {
  const { n } = t, { grid, pos, normal, reach } = net;
  const lane: Lane = {
    n, px: new Float64Array(n), pz: new Float64Array(n), x: new Float64Array(n), node: new Int32Array(n).fill(-1),
    wall: new Uint8Array(n), y: new Float64Array(n).fill(NaN), pitch: new Float64Array(n), surf: new Int32Array(n).fill(-1),
  };
  // The lane keeps to the layer it is on: each sample looks for ground near where the last one found it, carried
  // along the line's own climb.
  let lift = 0;
  for (let k = 0; k < n; k++) {
    const x = t.p[k * 3] - t.hz[k] * offset, z = t.p[k * 3 + 2] + t.hx[k] * offset;
    lane.px[k] = x; lane.pz[k] = z;
    if (k) lane.x[k] = lane.x[k - 1] + Math.hypot(x - lane.px[k - 1], z - lane.pz[k - 1]);
    const guess = t.p[k * 3 + 1] + lift, c = cellAt(grid, x, z);
    if (c < 0) continue;
    let best = -1, bestErr = DRAPE_M, bestY = NaN;
    for (let j = grid.first[c]; j < grid.first[c + 1]; j++) {
      const p = grid.items[j];
      if (Math.hypot(pos[p * 3] - x, pos[p * 3 + 2] - z) > reach[p]) continue;
      const y = groundAt(net, p, x, z), err = Math.abs(y - guess);
      if (err < bestErr) { bestErr = err; best = p; bestY = y; }
    }
    if (best < 0) continue;
    let sum = 0, height = 0, nx = 0, ny = 0, nz = 0;
    for (let j = grid.first[c]; j < grid.first[c + 1]; j++) {
      const p = grid.items[j], d = Math.hypot(pos[p * 3] - x, pos[p * 3 + 2] - z);
      if (d > reach[p]) continue;
      const y = groundAt(net, p, x, z);
      if (Math.abs(y - bestY) > LAYER_M) continue;
      const w = (1 - d / reach[p]) ** 2 + 1e-6;
      sum += w; height += w * y;
      nx += w * normal[p * 3]; ny += w * normal[p * 3 + 1]; nz += w * normal[p * 3 + 2];
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const y = height / sum, along = -(nx * t.hx[k] + nz * t.hz[k]) / Math.max(ny, 1e-6);
    lane.node[k] = best; lane.y[k] = y;
    lane.wall[k] = ny < WALL_NY ? 1 : 0;
    lift = y - t.p[k * 3 + 1];
    lane.pitch[k] = Math.atan(Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, along)));
    if (!net.unridden[best] && !lane.wall[k]) lane.surf[k] = net.surf[best];
  }
  return lane;
}

/** What a lane's rider did at each sample: its speed (NaN where it never got), whether it was clear in the air, and
 *  how high it flew there; and what the sample tells (`told`): nothing where the rider left the course and was put
 *  back on it, which is no ride anyone takes (though where it stalled short of a climb is); `TOLD` riding on from the
 *  gate or the line it left; `TOLD_AFTER_RESTART` set off again from rest, which only speaks for ground no unbroken
 *  ride does. */
interface LaneRide { speed: Float32Array; air: Uint8Array; flyY: Float64Array; told: Uint8Array }

/**
 * Ride `lane` from its first ground, setting off at `entry` m/s, the way trail-speed.ts rides a path: the cursor
 * walks the samples forward, stamping each with the rider as it passes.
 */
function rideLane(lane: Lane, entry: number, surfaceOf: (type: number) => RideSurface): LaneRide {
  const { n, x: along, y, pitch, surf } = lane;
  /** Ground a flight can come down on, ridden or not: a sample on some, and not a wall. */
  const floor = (k: number) => lane.node[k] >= 0 && !lane.wall[k];
  const ride: LaneRide = {
    speed: new Float32Array(n).fill(NaN), air: new Uint8Array(n), flyY: new Float64Array(n).fill(NaN), told: new Uint8Array(n).fill(TOLD),
  };
  const ground = (k: number) => surf[k] >= 0;
  const pitchAt = (k: number, t: number) => k + 1 < n && ground(k + 1) ? pitch[k] + (pitch[k + 1] - pitch[k]) * t : pitch[k];
  const fraction = (k: number, q: number) => {
    const span = along[k + 1] - along[k];
    return span > 1e-12 ? Math.min(1, Math.max(0, (q - along[k]) / span)) : 0;
  };
  /** The next sample from `k` on where a rider put back on the course can get going: ground that does not climb. */
  const restartFrom = (k: number) => {
    for (let m = k; m < n; m++) if (ground(m) && Math.tan(pitch[m]) <= RESTART_SLOPE) return m;
    return -1;
  };

  let i = 0, lowest = Infinity;
  for (let k = 0; k < n; k++) if (floor(k)) lowest = Math.min(lowest, y[k]);
  while (i < n && !ground(i)) i++;
  if (i >= n) return ride;
  const r: GroundRider = { v: entry, vn: 0, gap: 0, cap: RIDE_MAX_SPEED };
  let x = along[i], flight: Flight | null = null, flown = 0, leftAt = 0;
  ride.speed[i] = entry;
  /** Put the rider back on the course at sample `k`, at rest. A flight that ended off the course, and the ground
   *  between, tell nothing: other lanes speak for it, or no one does. */
  const stand = (k: number) => {
    if (flight) ride.told.fill(0, leftAt + 1, k);
    ride.told.fill(TOLD_AFTER_RESTART, k);
    i = k; x = along[k]; flight = null;
    r.v = 0; r.vn = 0; r.gap = 0; r.cap = RIDE_MAX_SPEED;
    ride.speed[k] = 0;
  };

  for (let tick = 0; tick < MAX_TICKS && i < n - 1; tick++) {
    if (flight) {
      const f: Flight = flight;
      airTick(f);
      if (++flown > MAX_FLIGHT_TICKS || f.y < lowest - FALLEN_M) {
        const m = restartFrom(i + 1);
        if (m < 0) { ride.told.fill(0, leftAt + 1); break; }
        stand(m);
        continue;
      }
      let j = i;
      while (j + 1 < n && along[j + 1] <= f.x) {
        j++;
        ride.speed[j] = Math.hypot(f.vx, f.vy);
        ride.air[j] = !floor(j) || f.y - y[j] > AIR_CLEARANCE_M ? 1 : 0;
        ride.flyY[j] = f.y;
      }
      i = j;
      if (j + 1 >= n) break; // flown off the lane's end
      // Ground under the flight where there is some either side, ridden or not.
      if (!floor(j) || !floor(j + 1)) continue;
      const t = fraction(j, f.x), under = y[j] + (y[j + 1] - y[j]) * t;
      if (f.y > under) continue;
      // Down on ground nobody rides, or into the far side of what it did not clear: put back on the course.
      if (!ground(j) || !ground(j + 1) || under - f.y > Math.abs(f.vy) * RIDE_TICK + LANDING_DEPTH_M) {
        const m = restartFrom(j + 1);
        if (m < 0) { ride.told.fill(0, leftAt + 1); break; }
        stand(m);
        continue;
      }
      r.v = touchdown(f, pitchAt(j, t), surfaceOf(surf[j]).redirect);
      r.gap = 0; r.vn = 0;
      x = f.x;
      flight = null;
      continue;
    }
    const t0 = fraction(i, x), theta = pitchAt(i, t0), surface = surfaceOf(surf[i]);
    // The probe past the ground band (docs/016 · Air + lips) — or the ground ends ahead, at a gap, a drop or ground
    // nobody rides, and the rider rides on off it.
    if (!ground(i + 1) || r.gap > surface.row.thresh) {
      easeCap(r);
      flight = takeoff(r, theta, x, y[i] + (ground(i + 1) ? (y[i + 1] - y[i]) * t0 : 0));
      flown = 0; leftAt = i;
      continue;
    }
    const opening = r.v * Math.cos(theta);
    const h = opening > 1e-9 ? Math.max(RIDE_TICK, Math.min(MAX_STEP_S, MIN_STEP_M / opening)) : MAX_STEP_S;
    easeCap(r, h);
    const x1 = Math.min(along[n - 1], x + opening * h);
    const accel = groundTick(surface, r, theta, h);
    let j = i;
    while (j + 1 < n && along[j + 1] <= x1 && ground(j + 1)) j++;
    turnSurface(r, theta - pitchAt(j, fraction(j, x1)));
    x = j + 1 < n ? Math.min(x1, along[j + 1]) : x1;
    const stalled = r.v <= STALL_SPEED && accel <= 0;
    r.v = stalled ? 0 : Math.min(r.cap, Math.max(0, r.v));
    for (let k = i + 1; k <= j; k++) ride.speed[k] = r.v;
    i = j;
    if (stalled) {
      // Stopped short on a climb: the rest of the climb is never reached, and the rider is put back where it levels.
      let m = i + 1;
      while (m < n && ground(m) && Math.tan(pitch[m]) > RESTART_SLOPE) m++;
      m = restartFrom(m);
      if (m < 0) break;
      stand(m);
    }
  }
  return ride;
}

/** A prediction ridden a slice at a time: `run(more)` rides on while `more()` allows, and hands back the result once
 *  every lane is ridden — null until then. */
export interface MountainSpeedSolver { run(more: () => boolean): MountainSpeeds | null }

/**
 * Predict the ride over the quilt along `lines`: the gate's lines first, then each line leaving one already ridden,
 * then any left, from rest. The quilt is read once, on the first slice; the solver holds its own copy from then on.
 */
export function mountainSpeedSolver(quilt: SpeedQuilt, lines: readonly SpeedLine[]): MountainSpeedSolver {
  const surfaces = new Map<number, RideSurface>();
  const surfaceOf = (type: number) => {
    let surface = surfaces.get(type);
    if (!surface) surfaces.set(type, surface = rideSurface(surfaceFor(type)));
    return surface;
  };
  let net: Network | null = null, startGap = Infinity;
  let nearest = new Float32Array(0), speed = new Float32Array(0), air = new Uint8Array(0);
  /** What is left to ride, and the lanes still to ride of the line under way. */
  const left: { line: SpeedLine; track: Track }[] = [];
  for (const line of lines) { const t = track(line.points); if (t) left.push({ line, track: t }); }
  let current: { entry: number; track: Track; offsets: number[] } | null = null;
  /** The ridden lines' centre lanes, every few samples, xyz and speed: where a line leaving one picks up its speed. */
  const centres: number[] = [];

  function begin(): Network {
    const welded = weld(quilt);
    net = welded;
    nearest = new Float32Array(welded.count).fill(Infinity);
    speed = new Float32Array(welded.count).fill(NaN);
    air = new Uint8Array(welded.count);
    const head = lines.find(line => line.start && line.points.length)?.points[0];
    if (head) {
      for (let p = 0; p < welded.count; p++) {
        if (welded.unridden[p]) continue;
        const d = Math.hypot(welded.pos[p * 3] - head[0], welded.pos[p * 3 + 1] - head[1], welded.pos[p * 3 + 2] - head[2]);
        startGap = Math.min(startGap, d);
      }
    }
    return welded;
  }

  /** The next line to ride, with the speed it sets off at: a gate line from rest, else one leaving a ridden lane at
   *  that lane's speed there, else any, from rest. */
  function nextLine(): { entry: number; track: Track; line: SpeedLine } | null {
    if (!left.length) return null;
    let pick = left.findIndex(l => l.line.start), entry = 0;
    for (let k = 0; pick < 0 && k < left.length; k++) {
      const head = left[k].track.p;
      for (let c = 0; c < centres.length; c += 4) {
        const dx = centres[c] - head[0], dy = centres[c + 1] - head[1], dz = centres[c + 2] - head[2];
        if (Math.hypot(dx, dz) < FEED_M && Math.abs(dy) < FEED_M / 5) { pick = k; entry = centres[c + 3]; break; }
      }
    }
    const [l] = left.splice(Math.max(0, pick), 1);
    return { entry: Number.isFinite(entry) ? entry : 0, track: l.track, line: l.line };
  }

  /** Ride one lane, and give each point near it the lane's ride there when the lane is the nearest yet. */
  function rideOne(network: Network, t: Track, offset: number, entry: number) {
    const lane = drapeLane(network, t, offset), ride = rideLane(lane, entry, surfaceOf);
    const { grid, pos, reach } = network;
    for (let k = 0; k < lane.n; k++) {
      const told = ride.told[k];
      if (!told) continue;
      const inAir = ride.air[k] === 1;
      if (offset === 0 && k % 4 === 0 && lane.node[k] >= 0) centres.push(lane.px[k], lane.y[k], lane.pz[k], ride.speed[k]);
      if (!inAir && lane.node[k] < 0) continue;
      const c = cellAt(grid, lane.px[k], lane.pz[k]);
      if (c < 0) continue;
      for (let j = grid.first[c]; j < grid.first[c + 1]; j++) {
        const p = grid.items[j];
        const d = Math.hypot(pos[p * 3] - lane.px[k], pos[p * 3 + 2] - lane.pz[k]);
        // Nearest wins, an unbroken ride over one set off again from rest.
        const rank = d + (told === TOLD ? 0 : RESTARTED_RANK);
        if (d > Math.max(reach[p], SPLAT_M) || rank >= nearest[p]) continue;
        const under = groundAt(network, p, lane.px[k], lane.pz[k]);
        // In the air, over whatever is below it; on the ground, only the ridden ground of the layer the lane is on.
        if (inAir ? under >= ride.flyY[k] : network.unridden[p] || Math.abs(under - lane.y[k]) > LAYER_M) continue;
        nearest[p] = rank; speed[p] = ride.speed[k]; air[p] = inAir ? 1 : 0;
      }
    }
  }

  return {
    run(more) {
      const network = net ?? begin();
      for (;;) {
        if (!current) {
          const next = nextLine();
          if (!next) break;
          const offsets = [0];
          for (let k = 1; k <= Math.floor(next.line.halfWidth / LANE_SPACING_M); k++) offsets.push(k * LANE_SPACING_M, -k * LANE_SPACING_M);
          current = { entry: next.entry, track: next.track, offsets };
        }
        rideOne(network, current.track, current.offsets.shift()!, current.entry);
        if (!current.offsets.length) current = null;
        if (!more()) return null;
      }
      const lattice = network.pointOf.length, perPatch = quilt.side * quilt.side;
      const result: MountainSpeeds = {
        speed: new Float32Array(lattice).fill(NaN), air: new Uint8Array(lattice), bare: new Uint8Array(lattice), startGap,
      };
      for (let i = 0; i < lattice; i++) {
        const p = network.pointOf[i];
        // A lattice point on a patch nobody rides shows only a lane flying over it, whatever its neighbours wear.
        const unridden = network.unridden[p] || UNRIDDEN.has(quilt.cellSurf[Math.floor(i / perPatch)]);
        if (nearest[p] === Infinity || (unridden && !air[p])) { result.bare[i] = 1; continue; }
        result.speed[i] = speed[p];
        result.air[i] = air[p];
      }
      return result;
    },
  };
}

/** An AI path's lanes either side: the network's own spread covers the course between them. */
const AI_HALF_WIDTH = 3;
/** A shipped level's main course line's, its floor width unrecorded. */
const REFERENCE_COURSE_HALF_WIDTH = 12;

/** An authored mountain's lines: its run from where the field is staged, across its floor and walls, and the six AI
 *  lines it exports from the gates (core/doc/course). */
export function courseSpeedLines(course: CoursePath, aiSeed: number): SpeedLine[] {
  if (course.knots.length < 2) return [];
  const s0 = startStation(course);
  const run = sampleSpine(course.knots).filter(sample => sample.s >= s0);
  const halfWidth = Math.max(...course.knots.map((_, k) => { const at = paramsAt(course.knots, k); return at.width / 2 + at.wall; }));
  return [
    { points: run.map(sample => sample.pos), halfWidth, start: true },
    ...aiPathLines(course, aiSeed).map(points => ({ points, halfWidth: AI_HALF_WIDTH, start: true })),
  ];
}

/** A shipped level's lines: its AI-path network, the gate's paths flagged, and its main course line, which the
 *  gate's paths feed unless there are none. */
export function referenceSpeedLines(course: readonly V3[] | null, aiPaths: readonly { points: V3[]; start: boolean }[] | null): SpeedLine[] {
  const paths = (aiPaths ?? []).filter(path => path.points.length >= 2);
  const lines: SpeedLine[] = paths.map(path => ({ points: path.points, halfWidth: AI_HALF_WIDTH, start: path.start }));
  if (course && course.length >= 2) {
    lines.push({ points: course, halfWidth: REFERENCE_COURSE_HALF_WIDTH, start: !paths.some(path => path.start) });
  }
  return lines;
}

/** The whole prediction at once. */
export function predictMountainSpeeds(quilt: SpeedQuilt, lines: readonly SpeedLine[]): MountainSpeeds {
  return mountainSpeedSolver(quilt, lines).run(() => true)!;
}
