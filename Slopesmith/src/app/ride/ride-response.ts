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
  linearStat: 0.5, quadraticStat: 0.5, skidStat: 0.5, lateralStat: 0.5,
  mode: 1, edge: 0, preferredEdge: 0, loadRatio: 1, skid: 0,
});

export function responseStance(t: GroundResponseTuning): number {
  return t.edge === t.preferredEdge || t.mode === 1 ? 1
    : t.mode === 0 ? 0.8499836326 : 0.6998783350;
}

/** [Trailmap: 330-resistance] Signed forward acceleration; velocities/lengths use metres. */
export function forwardResistance(s: RideContractSurfaceRow, u: number, error: number, budget: number,
  charge: number, boost: number, t: GroundResponseTuning = DEFAULT_GROUND_RESPONSE): number {
  const stance = responseStance(t);
  const rA = (t.mode === 2 ? 0.7076424360 - 0.3019791245 * t.linearStat
    : 1.0649821758 - 0.3084552288 * t.linearStat) * stance;
  const rC = (1.2848105431 - 0.2903534174 * t.quadraticStat) * stance;
  const rS = (0.6150994897 + 0.9181777835 * t.skidStat) * stance;
  const q = Math.max(1, t.loadRatio);
  const x = Math.abs(u) * 0.1;
  const depth = s.type === 3 || s.type === 4 ? 0.5 - error / Math.max(budget, 1e-6) : 1;
  return -u * depth * (q * s.resistanceA * rA + (1 - charge) * 0.1057286412
    + (1 + boost * 1.2153687477) * 1.7513076067 * t.skid * t.skid * rS
    + x * (q * s.resistanceB + x * q * s.resistanceC * rC));
}

/** [Trailmap: 330-lateral] Depends on forward speed, not total speed. */
export function lateralSpeedGain(forwardSpeed: number): number {
  const speed = Math.abs(forwardSpeed);
  if (speed < 5.555555419922) return 0.2010370344 + speed * 0.08899726090;
  if (speed < 13.888887939453) return 0.6954662800 + (speed - 5.555555419922) * 0.03612979490;
  return 0.9965478778 - (speed - 13.888887939453) * 0.01044131714;
}

/** [Trailmap: 330-lateral] Signed lateral acceleration in m/s², integrated explicitly by the caller. */
export function lateralResistance(drag: number, u: number, w: number, lean: number, boost: number,
  t: GroundResponseTuning = DEFAULT_GROUND_RESPONSE): number {
  const rider = (0.0010000000475 + 1.1412174702 * t.lateralStat) * responseStance(t);
  const boostGain = boost > 0 ? 1 / (1 + 3.4999945164 * boost) : 1;
  return -w * drag * lateralSpeedGain(u) * Math.max(1, Math.abs(lean) * 1.0001484156) * rider * boostGain;
}

/** [Trailmap: 330-yaw] Requested lead in radians; mode is the curve selector. */
export function headingLead(lean: number, charge: number, mode = 1): number {
  const c0 = mode === 2 ? 0.2083389610 : mode === 0 ? 0.3001891971 : 0.4000000060;
  const c7 = mode === 2 ? 0.2622103095 : mode === 0 ? 0.3491855264 : 0.5239824057;
  return lean * c7 * (1 + 0.5 * c0 * (1 - lean * lean)) / (1 + charge * 0.01);
}

/** [Trailmap: 330-yaw] Full speed in m/s; signed slip projection is the triple product / full speed.
 * fallLineSpeed is the projection onto the downhill contact direction (forward fallback on flat ground). */
export function headingYaw(lean: number, lead: number, slipProjection: number, speed: number,
  forwardSpeed: number, fallLineSpeed: number, dt: number): number {
  if (speed < 1e-6 || dt <= 0) return 0;
  let candidate = lead - Math.asin(clamp(slipProjection, -0.99999, 0.99999));
  if (forwardSpeed < 0) candidate = -candidate;
  const gate = Math.min(1, speed * speed * 0.2002984729 * dt);
  const align = Math.min(1, Math.max(0, 40 * Math.min(1, speed / 5.555555419922)
    * (0.5 - Math.abs(fallLineSpeed) / speed)) + 0.01004204992);
  const gain = Math.max(candidate > 0 ? lean : -lean, align);
  return clamp(candidate * gate * gain, -0.1047197580, 0.1047197580);
}

/** [Trailmap: 330-bank-force] Normal component after the capped banked response and residual are combined. */
export function bankedNormalResponse(response: number, cappedResponse: number, theta: number): number {
  return response + cappedResponse - cappedResponse / Math.cos(theta);
}
