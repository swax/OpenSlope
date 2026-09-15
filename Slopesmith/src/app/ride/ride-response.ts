import * as RESPONSE from './ride-response.generated';
import { clamp } from '../../core/math/scalar';
import type { RideContractSurfaceRow } from './ride-contract.generated';

/** [Trailmap: 330-resistance] Normalized response tuning, independent of a character identity.
 * Defaults are the port's neutral profile, not recovered character statistics. */
export interface GroundResponseTuning {
  linearStat: number;
  quadraticStat: number;
  skidStat: number;
  lateralStat: number;
  mode: number;
  edge: number;
  preferredEdge: number;
  loadRatio: number;
  skid: number;
}
export const DEFAULT_GROUND_RESPONSE: Readonly<GroundResponseTuning> = Object.freeze({
  linearStat: RESPONSE.DEFAULTS_NORMALIZED_STAT,
  quadraticStat: RESPONSE.DEFAULTS_NORMALIZED_STAT,
  skidStat: RESPONSE.DEFAULTS_NORMALIZED_STAT,
  lateralStat: RESPONSE.DEFAULTS_NORMALIZED_STAT,
  mode: RESPONSE.DEFAULTS_MODE,
  edge: RESPONSE.DEFAULTS_EDGE,
  preferredEdge: RESPONSE.DEFAULTS_EDGE,
  loadRatio: RESPONSE.DEFAULTS_LOAD_RATIO,
  skid: RESPONSE.DEFAULTS_SKID,
});

export function responseStance(t: GroundResponseTuning): number {
  return t.edge === t.preferredEdge || t.mode === 1 ? 1
    : t.mode === 0 ? RESPONSE.STANCE_MODE0_MISMATCH : RESPONSE.STANCE_OTHER_MISMATCH;
}

/** [Trailmap: 330-resistance] Signed forward acceleration; velocities/lengths use metres. */
export function forwardResistance(s: RideContractSurfaceRow, u: number, error: number, budget: number,
  charge: number, boost: number, t: GroundResponseTuning = DEFAULT_GROUND_RESPONSE): number {
  const stance = responseStance(t);
  const rA = (t.mode === 2 ? RESPONSE.FORWARD_MODE2_LINEAR_BASE - RESPONSE.FORWARD_MODE2_LINEAR_STAT_SCALE * t.linearStat
    : RESPONSE.FORWARD_LINEAR_BASE - RESPONSE.FORWARD_LINEAR_STAT_SCALE * t.linearStat) * stance;
  const rC = (RESPONSE.FORWARD_QUADRATIC_BASE - RESPONSE.FORWARD_QUADRATIC_STAT_SCALE * t.quadraticStat) * stance;
  const rS = (RESPONSE.FORWARD_SKID_BASE + RESPONSE.FORWARD_SKID_STAT_SCALE * t.skidStat) * stance;
  const q = Math.max(1, t.loadRatio);
  const x = Math.abs(u) * RESPONSE.FORWARD_SPEED_SCALE;
  const depth = s.type === 3 || s.type === 4
    ? RESPONSE.FORWARD_POWDER_DEPTH_BASE - error / Math.max(budget, RESPONSE.GUARDS_BUDGET_METRES) : 1;
  return -u * depth * (q * s.resistanceA * rA + (1 - charge) * RESPONSE.FORWARD_UNCHARGED_DRAG
    + (1 + boost * RESPONSE.FORWARD_BOOST_SKID_SCALE) * RESPONSE.FORWARD_SKID_DRAG * t.skid * t.skid * rS
    + x * (q * s.resistanceB + x * q * s.resistanceC * rC));
}

/** [Trailmap: 330-lateral] Depends on forward speed, not total speed. */
export function lateralSpeedGain(forwardSpeed: number): number {
  const speed = Math.abs(forwardSpeed);
  if (speed < RESPONSE.LATERAL_LOW_SPEED_MPS)
    return RESPONSE.LATERAL_LOW_BASE + speed * RESPONSE.LATERAL_LOW_SLOPE;
  if (speed < RESPONSE.LATERAL_MID_SPEED_MPS)
    return RESPONSE.LATERAL_MID_BASE + (speed - RESPONSE.LATERAL_LOW_SPEED_MPS) * RESPONSE.LATERAL_MID_SLOPE;
  return RESPONSE.LATERAL_HIGH_BASE - (speed - RESPONSE.LATERAL_MID_SPEED_MPS) * RESPONSE.LATERAL_HIGH_FALLOFF;
}

/** [Trailmap: 330-lateral] Signed lateral acceleration in m/s², integrated explicitly by the caller. */
export function lateralResistance(drag: number, u: number, w: number, lean: number, boost: number,
  t: GroundResponseTuning = DEFAULT_GROUND_RESPONSE): number {
  const rider = (RESPONSE.LATERAL_RIDER_BASE + RESPONSE.LATERAL_RIDER_STAT_SCALE * t.lateralStat) * responseStance(t);
  const boostGain = boost > 0 ? 1 / (1 + RESPONSE.LATERAL_BOOST_SCALE * boost) : 1;
  return -w * drag * lateralSpeedGain(u) * Math.max(1, Math.abs(lean) * RESPONSE.LATERAL_LEAN_SCALE) * rider * boostGain;
}

/** [Trailmap: 330-yaw] Requested lead in radians; mode is the curve selector. */
export function headingLead(lean: number, charge: number, mode: number = RESPONSE.DEFAULTS_MODE): number {
  const shape = mode === 2 ? RESPONSE.LEAD_MODE2_SHAPE
    : mode === 0 ? RESPONSE.LEAD_MODE0_SHAPE : RESPONSE.LEAD_DEFAULT_SHAPE;
  const angleRad = mode === 2 ? RESPONSE.LEAD_MODE2_ANGLE_RAD
    : mode === 0 ? RESPONSE.LEAD_MODE0_ANGLE_RAD : RESPONSE.LEAD_DEFAULT_ANGLE_RAD;
  return lean * angleRad * (1 + RESPONSE.LEAD_SHAPE_SCALE * shape * (1 - lean * lean))
    / (1 + charge * RESPONSE.LEAD_CHARGE_SCALE);
}

/** [Trailmap: 330-yaw] Full speed in m/s; signed slip projection is the triple product / full speed.
 * fallLineSpeed is the projection onto the downhill contact direction (forward fallback on flat ground). */
export function headingYaw(lean: number, lead: number, slipProjection: number, speed: number,
  forwardSpeed: number, fallLineSpeed: number, dt: number): number {
  if (speed < RESPONSE.GUARDS_SPEED_MPS || dt <= 0) return 0;
  let candidate = lead - Math.asin(clamp(slipProjection,
    -RESPONSE.YAW_SLIP_PROJECTION_LIMIT, RESPONSE.YAW_SLIP_PROJECTION_LIMIT));
  if (forwardSpeed < 0) candidate = -candidate;
  const gate = Math.min(1, speed * speed * RESPONSE.YAW_SPEED_GATE * dt);
  const align = Math.min(1, Math.max(0, RESPONSE.YAW_ALIGN_SCALE * Math.min(1, speed / RESPONSE.YAW_ALIGN_SPEED_MPS)
    * (RESPONSE.YAW_ALIGN_RATIO - Math.abs(fallLineSpeed) / speed)) + RESPONSE.YAW_ALIGN_BASE);
  const gain = Math.max(candidate > 0 ? lean : -lean, align);
  return clamp(candidate * gate * gain, -RESPONSE.YAW_CAP_RAD_PER_TICK, RESPONSE.YAW_CAP_RAD_PER_TICK);
}

/** [Trailmap: 330-bank-force] Normal component after the capped banked response and residual are combined. */
export function bankedNormalResponse(response: number, cappedResponse: number, theta: number): number {
  return response + cappedResponse - cappedResponse / Math.cos(theta);
}
