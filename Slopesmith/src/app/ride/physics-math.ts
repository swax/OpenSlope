import * as THREE from 'three';
import { RIDE_SURFACE_ROWS, type RideContractSurfaceRow } from './ride-contract.generated';
import { clamp01 } from '../../core/math/scalar';

/**
 * The stateless half of the ride model (`physics.ts`): the per-surface response table and the pure functions
 * the fixed 60 Hz tick calls on it. Nothing here reads or writes rider state, so nothing here is
 * order-dependent — each function is a value in, a value out, exactly as the tick evaluates it.
 */

// ---- the per-surface response table ([Trailmap: 310], all 20 measured rows) ----
/**
 * One row of the engine's global response table, indexed by the painted SurfaceType. Almost everything that makes
 * one surface ride differently from another is this data, not code — there is no `if powder` anywhere below.
 *
 * `A` is the surface's **contact-response and grounded-load scale**, in engine units/s². `P` is the contact
 * damping. `bog` is the width of the soft give; because A drives both sides on level ground, its equilibrium is
 * `bog · cos(slope)` at zero lean. `budget` is the depth past which the capped pushout intervenes;
 * `thresh` is the
 * clearance at which the grounded state ends and the rider is airborne. `lift` raises the *drawn* deck back;
 * `drag` is the carve drag that eats lateral slip; `target`/`mult` are the cruise drive's speed target and
 * response multiplier ([Trailmap: 360]). `tilt` is the carve-tilt angle in DEGREES ([Trailmap: 310]): the
 * grounded update applies the contact response along a frame banked `tilt·lean` off the normal, so leaning
 * tilts the whole normal force into the turn — 58.3° on every row except ice's 45.0 and rock's 21.34.
 *
 * Depths are metres (the engine's 100-units-per-metre ÷ 100) and `target` is m/s. Every type gets its own row —
 * folding families together (7 and 11 onto ice, 8 and 16 onto snow, 13 and 14 onto wall) reads plausibly and is
 * wrong in every case: type 7 has a 13.8 cm give on an A≈980 dead contact, nothing like ice's 5 mm; type 8's give
 * is 14.4 cm, not snow's 5 mm; and type 14 carries the fastest speed target in the game, ahead of ice. The generic
 * A≈980 / P=30 / 14.58 m/s row is shared by 6 bounce, 10 wall, 16 sand, 17 no-collision and the spare 20th
 * record; type 15 differs in forward resistance. Its `A` of 980 units/s² means a 9.8 m/s² response at
 * the bog floor, independently of the grounded pull.
 */
export type SurfaceRow = RideContractSurfaceRow;
export const SURFACE_ROWS = RIDE_SURFACE_ROWS;
/** Out-of-range SurfaceTypes fall on row 15, the table's own "standard" generic bucket. */
export function surfaceFor(t: number): SurfaceRow {
  return (t >= 0 && t < SURFACE_ROWS.length) ? SURFACE_ROWS[t] : SURFACE_ROWS[15];
}

/** Zero-lean equilibrium penetration inside the response row's linear bog zone. */
export function groundRestDepth(s: SurfaceRow, normalY = 1): number {
  return s.bog * clamp01(normalY);
}

/**
 * The specified three-zone contact response, as an outward
 * acceleration (m/s²) along the contact normal. `error` is the deck reference's signed clearance (negative =
 * penetrating); `vn` is the outward normal speed; `bog` and `budget` are the rider's *slewed* copies of the
 * surface's two depth fields. The grounded update is this function's only caller anywhere in the engine.
 *
 * Units are the subtlety, and the reason the model was misread for so long. The engine's scalar is in
 * units/s² at 100 units = 1 m, so the bog and deep zones return an **acceleration** ≈ `A/100` m/s² — 13.0 m/s²
 * at the bog floor on snow. Only the above-surface zone's `A/30` is a *stiffness* (1/s², = a bog-zone term with
 * a 30 cm scale instead of a 5 mm one). Its damping is **one-sided**: `−P·vn` applies only while separating.
 *
 * The same row A supplies the grounded world-down load, so the bog-zone equilibrium is
 * `error = −bog · cos(slope)` at zero lean. The budget is where the capped pushout starts to intervene.
 *
 * The response cap is deliberately not applied here. It bounds the term applied on the banked carve frame,
 * and its residual normal term; groundTick composes them [Trailmap: 330-bank-force].
 */
export function contactResponse(A: number, P: number, error: number, vn: number, bog: number, budget: number): number {
  const accel = A / 100;                                       // engine units/s² → m/s²
  if (error > 0) return -(A / 30) * error - (vn > 0 ? P * vn : 0); // above: soft pull, damped only if separating
  if (error > -bog) return -accel * (error / bog) - P * vn;     // bog zone: 0 → A across the soft give
  const span = Math.max(budget - bog, 1e-4);                   // guard the slewed fields' degenerate start
  return accel * (1 - 2 * (Math.max(error, -budget) + bog) / span) - P * vn; // deep: A at −bog, 3A at −budget
}

// ---- small vector helpers ----
export function moveTowards(cur: number, target: number, maxDelta: number): number {
  const d = target - cur;
  return Math.abs(d) <= maxDelta ? target : cur + Math.sign(d) * maxDelta;
}
/** v projected onto the plane with unit normal n. */
export function projectOnPlane(v: THREE.Vector3, n: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(v).addScaledVector(n, -v.dot(n));
}
/** Rotate unit `cur` toward unit `target` by at most `maxRad`. */
export function rotateTowards(cur: THREE.Vector3, target: THREE.Vector3, maxRad: number): THREE.Vector3 {
  const ang = cur.angleTo(target);
  if (ang < 1e-6) return cur.clone();
  if (ang <= maxRad) return target.clone();
  const axis = new THREE.Vector3().crossVectors(cur, target).normalize();
  return cur.clone().applyAxisAngle(axis, maxRad);
}

/**
 * How far past a leaf's own radius the union-normal smoothing gathers neighbours, in leaf radii. An occupancy
 * lattice spaces its leaves wider apart than they are round (the GARI bodies sit at radius 24.2 cm on a 34.2 cm
 * pitch), so the union is genuinely bumpy at leaf scale and one leaf's radial normal is a poor read of the face.
 * Measured over 86 rider-like contacts on the GARI crash-bag body, against the body's own macroscopic radial:
 * one leaf gives mean 37.7 deg / max 75.8 deg with 31 contacts beyond 45 deg; x2 gives 26.0 / 47.4 with 6; x3
 * gives 23.9 / 46.8 with 2; x4 gives 21.9 / 40.4 with none. Three leaf radii takes nearly all of the outlier
 * reduction while still averaging over well under half the body, so real shape is not flattened away.
 */
const UNION_NORMAL_BAND = 3;

/**
 * The outward normal of a sphere tree's UNION at a boundary point, not of the one leaf the segment happened to
 * enter. An occupancy tree voxelises a body into hundreds of small leaves — a GARI crash bag is 452 of them at
 * a 24 cm leaf radius — so a single leaf's radial normal is a bump normal at voxel scale, not the surface the
 * body actually presents. Clipping the shoulder of one leaf returns a normal tens of degrees off the real
 * face; a live capture caught one 83° off, which turned the rigid-body shove almost entirely tangential and
 * drove a struck crash bag DOWN into the snow instead of away from the rider.
 *
 * Averaging the radial directions of every leaf whose surface passes near the point recovers the macroscopic
 * face: leaves straddling the same patch of boundary pull the sum toward their shared outward direction, while
 * the hit leaf alone would report its own curvature. Weighted by how near each leaf's surface lies to the
 * point, so a distant leaf never drags the normal off the face it belongs to.
 */
export function unionLeafNormal(leaves: Float32Array, point: THREE.Vector3, hitIndex: number, out: THREE.Vector3,
  band = UNION_NORMAL_BAND) {
  const hitRadius = Math.max(1e-4, leaves[hitIndex + 3]);
  const reach = hitRadius * band;
  out.set(0, 0, 0);
  for (let i = 0; i + 3 < leaves.length; i += 4) {
    const r = leaves[i + 3];
    if (r <= 0) continue;
    const dx = point.x - leaves[i], dy = point.y - leaves[i + 1], dz = point.z - leaves[i + 2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance < 1e-9) continue;
    // How far this leaf's own surface sits from the point; only leaves sharing this stretch of boundary count.
    const surfaceGap = Math.abs(distance - r);
    if (surfaceGap > reach) continue;
    const weight = 1 - surfaceGap / reach;
    out.x += (dx / distance) * weight;
    out.y += (dy / distance) * weight;
    out.z += (dz / distance) * weight;
  }
  // A lone leaf (or a degenerate sum) falls back to the plain radial normal it would have reported anyway.
  if (out.lengthSq() < 1e-12) out.set(
    point.x - leaves[hitIndex], point.y - leaves[hitIndex + 1], point.z - leaves[hitIndex + 2]);
}
