import type { AuthoredTrail, V3 } from '../../core/doc/types';
import { pathCuts, pathKnots } from '../../core/mesh/trail-object';
import { railBezierSegments } from '../../core/rails/rails';
import {
  RIDE_AIR_GRAVITY_FALLING, RIDE_AIR_GRAVITY_RISING, RIDE_AIR_HORIZONTAL_DRAG, RIDE_BOOST_CAP_DECAY, RIDE_BOOST_MAX_SPEED,
  RIDE_CONTACT_REDIRECT, RIDE_CRUISE_DEFICIT_MAX, RIDE_MAX_SPEED, RIDE_RIDER_DRIVE, RIDE_SIMULATION_HZ,
  type RideContractSurfaceRow,
} from './ride-contract.generated';
import * as RESPONSE from './ride-response.generated';
import { forwardResistance } from './ride-response';
import { surfaceFor } from './physics-math';

/**
 * The speed a rider would carry along a trail network (docs/023 · Predicted speed): each path's centre spline ridden
 * from rest at the network's starts, the way the ride's own ground model would carry it — the surface row's
 * world-down load `A/100`, its forward resistance, the automatic cruise drive toward the row's target speed, and the
 * shared speed cap ([Trailmap: 330, 360]) — integrated at the ride's fixed 60 Hz.
 *
 * Leaving the ground is not a rule here any more than it is in the ride (docs/016 · Air + lips): the clearance the
 * surface opens as it falls away under the travel is integrated against gravity's share along the normal, the
 * above-surface pull and the grounded redirect, and the rider takes off once it passes the row's ground threshold.
 * Gentle crests stay glued and sharp ones throw, near `R = v² / (g·n̂)`. Flight is ballistic with the air
 * integrator's two-stage gravity and horizontal damping until the arc meets the trail again, which keeps the speed
 * along the surface it lands on.
 *
 * A diagnostic, not a replay: the rider rides the centre line square to it — no steering, carving, braking, boost,
 * ollies or tricks — and the profile is the path unrolled into its vertical plane, so a turn costs nothing and a jump
 * follows the path round in plan. A path runs from its first point to its last. One starting at a point other paths
 * reach starts with the fastest of them; one ending on another path where it runs on lifts it there if it is faster.
 */

/** Sample spacing along a path's spline, in metres. */
const SAMPLE_M = 0.5;
/** The ride's fixed tick, seconds. */
export const RIDE_TICK = 1 / RIDE_SIMULATION_HZ;
const H = RIDE_TICK;
/** Ten minutes of riding: a path not finished by then is reported where the rider got to. */
const MAX_TICKS = RIDE_SIMULATION_HZ * 600;
/** A rider this slow that the slope still pushes back has stalled: it cannot climb on. */
export const STALL_SPEED = 0.05;

// ---- the rider, tick by tick: shared with the mountain-wide prediction (mountain-speed.ts) --------------------

/** A surface row as the prediction rides it: its world-down load, the soft pull above it, and the grounded redirect
 *  — none on the two powders, whose deep give is a stable spring on its own; the ride exempts them. */
export interface RideSurface { row: RideContractSurfaceRow; g: number; pull: number; redirect: number }

export function rideSurface(row: RideContractSurfaceRow): RideSurface {
  return {
    row, g: row.A / RESPONSE.UNITS_CENTIMETRES_PER_METRE, pull: row.A / RESPONSE.CONTACT_ABOVE_LENGTH_CM,
    redirect: row.type === 3 || row.type === 4 ? 0 : RIDE_CONTACT_REDIRECT,
  };
}

/** The rider on the ground: its speed along the surface and off it, the clearance opened under it, and the shared
 *  speed cap. */
export interface GroundRider { v: number; vn: number; gap: number; cap: number }

/** The rider in the air: plan position along the travel and height, plan and vertical velocity. */
export interface Flight { x: number; y: number; vx: number; vy: number }

/** [Trailmap: 360] The shared cap eases back down on the ground, and holds the speed under it. */
export function easeCap(r: GroundRider, h = H): void {
  r.cap = Math.max(RIDE_MAX_SPEED, r.cap - RIDE_BOOST_CAP_DECAY * h);
  r.v = Math.min(r.v, r.cap);
}

/**
 * One ground tick of `h` seconds on a surface climbing at `theta`, velocity and clearance only — the caller has moved
 * the rider with the tick's opening velocity. Returns the acceleration along the surface it applied.
 */
export function groundTick(surface: RideSurface, r: GroundRider, theta: number, h = H): number {
  const { row, g, pull, redirect } = surface;
  // [Trailmap: 320-redirect] 40% of the normal velocity goes, and the speed is scaled back: a rotation, not a loss.
  if (redirect > 0 && r.vn !== 0) {
    const before = Math.hypot(r.v, r.vn);
    r.vn *= h === H ? 1 - redirect : Math.pow(1 - redirect, h / H);
    if (r.v > 0) { const keep = before / Math.hypot(r.v, r.vn); r.v *= keep; r.vn *= keep; }
  }
  // [Trailmap: 330] along the surface: the row's world-down load, forward resistance, and the cruise drive.
  let a = -g * Math.sin(theta) + forwardResistance(row, r.v, 0, row.budget, 0, 0);
  const deficit = Math.min(row.target - Math.hypot(r.v, r.vn), RIDE_CRUISE_DEFICIT_MAX);
  if (deficit > 0) a += RIDE_RIDER_DRIVE * row.mult * deficit;
  // Along the normal: gravity's share, and above the surface its soft pull, damped only while separating.
  const an = -g * Math.cos(theta) - (r.gap > 0 ? pull * r.gap + (r.vn > 0 ? row.P * r.vn : 0) : 0);
  r.gap += r.vn * h;
  r.v += a * h;
  r.vn += an * h;
  return a;
}

/**
 * The travel goes straight on while the surface under it turns down by `turn` radians: the velocity is the same,
 * seen from the new surface frame — on a crest, some of it now points off the surface. Pressed into the surface,
 * the pushout takes the normal speed out.
 */
export function turnSurface(r: GroundRider, turn: number): void {
  const c = Math.cos(turn), sn = Math.sin(turn), v = r.v * c - r.vn * sn;
  r.vn = r.vn * c + r.v * sn;
  r.v = v;
  if (r.gap <= 0) { r.gap = 0; r.vn = Math.max(0, r.vn); }
}

/** The probe past the ground band (docs/016 · Air + lips): the rider at plan `x` over the surface at height `y`,
 *  climbing at `theta`, leaves it with its velocity, and the cap snaps up to the air's. */
export function takeoff(r: GroundRider, theta: number, x: number, y: number): Flight {
  const c = Math.cos(theta), sn = Math.sin(theta);
  r.cap = RIDE_BOOST_MAX_SPEED;
  return { x, y: y + r.gap, vx: r.v * c - r.vn * sn, vy: r.v * sn + r.vn * c };
}

/** [Trailmap: 340] One air tick: position first, then velocity — two-stage gravity, horizontal damping, under the air
 *  speed tier. */
export function airTick(f: Flight, h = H): void {
  const sp = Math.hypot(f.vx, f.vy);
  if (sp > RIDE_BOOST_MAX_SPEED) { f.vx *= RIDE_BOOST_MAX_SPEED / sp; f.vy *= RIDE_BOOST_MAX_SPEED / sp; }
  f.x += f.vx * h;
  f.y += f.vy * h;
  f.vx -= RIDE_AIR_HORIZONTAL_DRAG * f.vx * h;
  f.vy -= (f.vy > 0 ? RIDE_AIR_GRAVITY_RISING : RIDE_AIR_GRAVITY_FALLING) * h;
}

/**
 * [Trailmap: 340] Touchdown on a surface climbing at `theta`: the first grounded tick's redirect turns 40% of the
 * arrival's normal speed into the surface, keeping its magnitude, and the pushout takes out what normal speed is left
 * — so a steep landing on a steep face carries more than the arrival's share along it. Assumed square: no orientation
 * bands. Returns the speed kept along the surface.
 */
export function touchdown(f: Flight, theta: number, redirect: number): number {
  const c = Math.cos(theta), sn = Math.sin(theta);
  const along = f.vx * c + f.vy * sn, off = f.vy * c - f.vx * sn;
  const kept = Math.hypot(along, (1 - redirect) * off);
  return along > 0 && kept > 1e-9 ? along * Math.hypot(f.vx, f.vy) / kept : 0;
}

/** One path's centre spline, densely sampled: positions, 3-D and plan arc length, height and climb angle. */
interface Profile {
  n: number;
  pos: Float64Array;
  /** Arc length from the path's start, along the spline and in plan. */
  s: Float64Array;
  x: Float64Array;
  /** The tangent's climb above the horizontal, radians. */
  pitch: Float64Array;
  /** Each knot's sample. */
  knots: number[];
}

/** A rider arriving somewhere: its speed and, in the air, its flight — plan and vertical velocity and its height
 *  above the trail there. */
export interface RiderArrival {
  speed: number;
  air: { vx: number; vy: number; height: number } | null;
}

/** The ride predicted along one path, sample by sample from its first point. */
export interface PathSpeeds {
  /** Samples. */
  n: number;
  /** Positions, xyz per sample, in data space. */
  pos: Float64Array;
  /** Speed at each sample in m/s; NaN where the rider never gets — beyond a stall, or off the end in the air. */
  speed: Float32Array;
  /** 1 where the rider is in the air over the sample. */
  air: Uint8Array;
  /** The rider's state as it passes each knot (null at the first, and where it never gets). */
  arrivals: (RiderArrival | null)[];
  /** Fastest speed reached on the ground, m/s. */
  topSpeed: number;
  /** Separate flights, and the trail they pass over, in metres along it. */
  jumps: number;
  airborneM: number;
  /** The rider stops short: the slope beat the cruise drive before the path's end. */
  stalled: boolean;
}

/** Every path's predicted ride, index-parallel with the trail's paths; null for a path that does not cut. */
export interface TrailSpeeds { paths: (PathSpeeds | null)[] }

const cubicAt = (b: readonly V3[], t: number, k: number): number => {
  const u = 1 - t;
  return u * u * u * b[0][k] + 3 * u * u * t * b[1][k] + 3 * u * t * t * b[2][k] + t * t * t * b[3][k];
};
const cubicSlope = (b: readonly V3[], t: number, k: number): number => {
  const u = 1 - t;
  return 3 * (u * u * (b[1][k] - b[0][k]) + 2 * u * t * (b[2][k] - b[1][k]) + t * t * (b[3][k] - b[2][k]));
};

function sampleProfile(knots: readonly V3[], handles: Parameters<typeof railBezierSegments>[1]): Profile {
  const segs = railBezierSegments(knots, handles);
  const steps = segs.map(b => {
    const hull = Math.hypot(b[1][0] - b[0][0], b[1][1] - b[0][1], b[1][2] - b[0][2])
      + Math.hypot(b[2][0] - b[1][0], b[2][1] - b[1][1], b[2][2] - b[1][2])
      + Math.hypot(b[3][0] - b[2][0], b[3][1] - b[2][1], b[3][2] - b[2][2]);
    return Math.max(2, Math.ceil(hull / SAMPLE_M));
  });
  const n = steps.reduce((sum, count) => sum + count, 0) + 1;
  const pos = new Float64Array(n * 3), s = new Float64Array(n), x = new Float64Array(n), pitch = new Float64Array(n);
  const knotAt: number[] = [];
  let at = 0;
  const put = (b: readonly V3[], t: number) => {
    for (let k = 0; k < 3; k++) pos[at * 3 + k] = cubicAt(b, t, k);
    const dx = cubicSlope(b, t, 0), dy = cubicSlope(b, t, 1), dz = cubicSlope(b, t, 2);
    pitch[at] = Math.hypot(dx, dy, dz) > 1e-9 ? Math.atan2(dy, Math.hypot(dx, dz)) : NaN;
    if (at > 0) {
      const ex = pos[at * 3] - pos[at * 3 - 3], ey = pos[at * 3 + 1] - pos[at * 3 - 2], ez = pos[at * 3 + 2] - pos[at * 3 - 1];
      s[at] = s[at - 1] + Math.hypot(ex, ey, ez);
      x[at] = x[at - 1] + Math.hypot(ex, ez);
    }
    at++;
  };
  segs.forEach((b, i) => {
    knotAt.push(at);
    for (let j = 0; j < steps[i]; j++) put(b, j / steps[i]);
  });
  knotAt.push(at);
  put(segs[segs.length - 1], 1);
  // A zero-length handle has no tangent of its own there: take the chord's.
  for (let i = 0; i < n; i++) {
    if (!Number.isNaN(pitch[i])) continue;
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dy = pos[b * 3 + 1] - pos[a * 3 + 1], plan = x[b] - x[a];
    pitch[i] = plan > 1e-9 || Math.abs(dy) > 1e-9 ? Math.atan2(dy, plan) : 0;
  }
  return { n, pos, s, x, pitch, knots: knotAt };
}

/** Where `q` falls between samples `i` and `i + 1` of `along`, as the fraction past `i`. */
function fraction(along: Float64Array, i: number, q: number): number {
  const span = along[i + 1] - along[i];
  return span > 1e-12 ? Math.min(1, Math.max(0, (q - along[i]) / span)) : 0;
}

/**
 * Ride one path from `entry`, `inflow(knot)` saying how fast riders merge in at each later knot. The cursor walks
 * the samples forward, stamping each with the rider's speed and whether it is in the air as it passes.
 */
function ridePath(p: Profile, row: RideContractSurfaceRow, entry: RiderArrival, inflow: (knot: number) => number): PathSpeeds {
  const { n } = p;
  const speed = new Float32Array(n).fill(NaN), air = new Uint8Array(n);
  const arrivals: (RiderArrival | null)[] = p.knots.map(() => null);
  const surface = rideSurface(row);
  const y = (i: number) => p.pos[i * 3 + 1];
  const pitchAt = (i: number, t: number) => i + 1 < n ? p.pitch[i] + (p.pitch[i + 1] - p.pitch[i]) * t : p.pitch[n - 1];

  let i = 0, s = 0;
  const r: GroundRider = { v: entry.speed, vn: 0, gap: 0, cap: RIDE_MAX_SPEED };
  let flight: Flight | null = null;
  if (entry.air) { flight = { x: 0, y: y(0) + entry.air.height, vx: entry.air.vx, vy: entry.air.vy }; r.cap = RIDE_BOOST_MAX_SPEED; }
  let nextKnot = 1, topSpeed = flight ? 0 : r.v, jumps = 0, airborneM = 0, stalled = false;
  speed[0] = flight ? Math.hypot(flight.vx, flight.vy) : r.v;
  air[0] = flight ? 1 : 0;

  /** The rider as it is now, for a knot it passes. */
  const arrival = (): RiderArrival => {
    if (!flight) return { speed: r.v, air: null };
    const t = i + 1 < n ? fraction(p.x, i, flight.x) : 0;
    const under = i + 1 < n ? y(i) + (y(i + 1) - y(i)) * t : y(i);
    return { speed: Math.hypot(flight.vx, flight.vy), air: { vx: flight.vx, vy: flight.vy, height: flight.y - under } };
  };
  /** Stamp the samples up to `last` as passed now, settling each knot passed. */
  const pass = (last: number) => {
    while (i < last) {
      i++;
      const flying = flight !== null;
      speed[i] = flying ? Math.hypot(flight!.vx, flight!.vy) : r.v;
      air[i] = flying ? 1 : 0;
      if (flying) airborneM += p.s[i] - p.s[i - 1];
      else topSpeed = Math.max(topSpeed, r.v);
      while (nextKnot < p.knots.length && p.knots[nextKnot] <= i) {
        if (!flying) r.v = Math.max(r.v, inflow(nextKnot));
        arrivals[nextKnot++] = arrival();
      }
    }
  };

  for (let tick = 0; tick < MAX_TICKS && i < n - 1; tick++) {
    if (flight) {
      airTick(flight);
      let j = i;
      while (j + 1 < n && p.x[j + 1] <= flight.x) j++;
      if (j + 1 >= n) { pass(n - 1); break; } // flown off the path's end
      const t = fraction(p.x, j, flight.x);
      if (flight.y > y(j) + (y(j + 1) - y(j)) * t) { pass(j); continue; }
      r.v = touchdown(flight, pitchAt(j, t), surface.redirect);
      s = p.s[j] + (p.s[j + 1] - p.s[j]) * t;
      pass(j);
      flight = null;
      r.gap = 0; r.vn = 0;
      continue;
    }
    easeCap(r);
    const t0 = fraction(p.s, i, s), theta = pitchAt(i, t0);
    // The probe: past the ground band, this tick is an air tick (docs/016 · Air + lips).
    if (r.gap > row.thresh) {
      flight = takeoff(r, theta, p.x[i] + (p.x[i + 1] - p.x[i]) * t0, y(i) + (y(i + 1) - y(i)) * t0);
      jumps++;
      continue;
    }
    // Position first, with the tick's opening velocity; then velocity.
    const s1 = Math.min(p.s[n - 1], s + r.v * H);
    const a = groundTick(surface, r, theta);
    let j = i;
    while (j + 1 < n && p.s[j + 1] <= s1) j++;
    turnSurface(r, theta - (j + 1 < n ? pitchAt(j, fraction(p.s, j, s1)) : p.pitch[n - 1]));
    s = s1;
    if (r.v <= STALL_SPEED && a <= 0) { r.v = 0; stalled = true; pass(j); break; }
    r.v = Math.min(r.cap, Math.max(0, r.v));
    pass(j);
  }
  return { n, pos: p.pos, speed, air, arrivals, topSpeed, jumps, airborneM, stalled };
}

/**
 * Predict the ride over every path of `trail`, each on the surface `surfaceOf(path)` names (standard snow unless
 * told). Paths are ridden in an order that has a path's feeders done first: those reaching its first point, then
 * those merging into it; a loop is broken at its lowest path, which rides with what has arrived so far.
 */
export function predictTrailSpeeds(trail: Pick<AuthoredTrail, 'points' | 'paths'>, surfaceOf: (path: number) => number = () => 1):
TrailSpeeds {
  const { paths } = trail;
  const live = paths.map(pathCuts);
  const starts = paths.map(() => new Set<number>()), merges = paths.map(() => new Set<number>());
  paths.forEach((path, i) => {
    if (!live[i]) return;
    paths.forEach((other, j) => {
      if (j === i || !live[j]) return;
      if (other.points.indexOf(path.points[0], 1) > 0) starts[i].add(j);
      if (path.points.indexOf(other.points.at(-1)!, 1) > 0) merges[i].add(j);
    });
  });
  const out: (PathSpeeds | null)[] = paths.map(() => null);
  /** What has arrived at each point: by which path, and whether that path ends there. */
  const arrived = new Map<number, { path: number; end: boolean; at: RiderArrival }[]>();
  const done = new Set<number>();
  const fed = (i: number, feeders: readonly Set<number>[][]) => feeders.every(kind => [...kind[i]].every(j => done.has(j)));
  const pending = () => paths.map((_, i) => i).filter(i => live[i] && !done.has(i));
  for (let left = pending(); left.length; left = pending()) {
    const i = left.find(k => fed(k, [starts, merges])) ?? left.find(k => fed(k, [starts])) ?? left[0];
    const path = paths[i];
    const entry = (arrived.get(path.points[0]) ?? []).filter(from => from.path !== i)
      .reduce<RiderArrival>((best, from) => from.at.speed > best.speed ? from.at : best, { speed: 0, air: null });
    const inflow = (knot: number) => (arrived.get(path.points[knot]) ?? [])
      .reduce((best, from) => from.end && from.path !== i && !from.at.air ? Math.max(best, from.at.speed) : best, 0);
    const ride = ridePath(sampleProfile(pathKnots(trail, path), path.handles), surfaceFor(surfaceOf(i)), entry, inflow);
    ride.arrivals.forEach((at, knot) => {
      if (!at || knot === 0) return;
      const point = path.points[knot], list = arrived.get(point) ?? [];
      list.push({ path: i, end: knot === path.points.length - 1, at });
      arrived.set(point, list);
    });
    out[i] = ride;
    done.add(i);
  }
  return { paths: out };
}

/**
 * The sample of `ride` nearest `point`: along the whole path, or — given a sample `near` a point close by — walked
 * from there while the samples come closer, which keeps a hairpin's other leg out of it.
 */
export function nearestSample(ride: PathSpeeds, point: V3, near?: number): number {
  const d = (i: number) => {
    const dx = ride.pos[i * 3] - point[0], dy = ride.pos[i * 3 + 1] - point[1], dz = ride.pos[i * 3 + 2] - point[2];
    return dx * dx + dy * dy + dz * dz;
  };
  if (near === undefined) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < ride.n; i++) { const di = d(i); if (di < bestD) { bestD = di; best = i; } }
    return best;
  }
  let best = Math.min(ride.n - 1, Math.max(0, near)), bestD = d(best);
  for (const step of [-1, 1]) {
    for (let i = best + step; i >= 0 && i < ride.n; i += step) {
      const di = d(i);
      if (di >= bestD) break;
      bestD = di; best = i;
    }
  }
  return best;
}

/** The top of the colour scale: the ride's ordinary speed cap. */
export const TRAIL_SPEED_SCALE_MAX = RIDE_MAX_SPEED;
