import * as THREE from 'three';

/** Browser-local standing calibration. Raw tracker values are retained because future hip/foot calibration and
 * runtime-origin diagnostics need the measurement, not merely the correction derived from it. */
export interface XrBodyCalibration {
  version: 1;
  capturedAt: number;
  gripSpan: number;
  standingHeight: number;
  eyeHeight: number;
  rawStandingEyeY: number;
  floorOffset: number;
  /** Device/source-specific wrist corrections learned from palms-forward T-pose. Older saves omit this. */
  hands?: XrHandsCalibration;
}

export type XrTrackedHandSource = 'hand' | 'grip';
export type XrQuatTuple = [number, number, number, number];
export interface XrHandOrientationCalibration {
  source: XrTrackedHandSource;
  /** Local post-rotation: canonical raw wrist * offset = avatar wrist. */
  offset: XrQuatTuple;
}
export interface XrHandsCalibration {
  left: XrHandOrientationCalibration;
  right: XrHandOrientationCalibration;
}

const KEY = 'slopesmith-xr-body-calibration-v1';
const MIN_GRIP_SPAN = 0.75, MAX_GRIP_SPAN = 2.25;
const MIN_STANDING_HEIGHT = 1.2, MAX_STANDING_HEIGHT = 2.35;
/** Approximate controller-grip centre to fingertip, on each outstretched hand. */
const GRIP_TO_FINGERTIP = 0.12;
/** Crown above the eye bridge. Subtracting this turns stature into standing eye height. */
const CROWN_ABOVE_EYES = 0.12;
/** A seated pose may legitimately be well below the standing capture; a larger change is a new XR origin. */
const MAX_SAME_ORIGIN_DELTA = 1.5;
export const FALLBACK_STANDING_EYE_HEIGHT = 1.6;

/** Infer body height from a T-pose without trusting the runtime's floor origin. */
export function bodyHeightFromGripSpan(gripSpan: number): { standingHeight: number; eyeHeight: number } | null {
  if (!Number.isFinite(gripSpan) || gripSpan < MIN_GRIP_SPAN || gripSpan > MAX_GRIP_SPAN) return null;
  const standingHeight = THREE.MathUtils.clamp(
    gripSpan + GRIP_TO_FINGERTIP * 2, MIN_STANDING_HEIGHT, MAX_STANDING_HEIGHT,
  );
  return { standingHeight, eyeHeight: standingHeight - CROWN_ABOVE_EYES };
}

/** Capture the persistent floor correction. Grip distance is translation-invariant, so a wildly wrong origin
 * (for example a headset reporting 4.5 m above its "floor") cannot contaminate the inferred body height. */
export function captureXrBodyCalibration(rawHeadY: number, leftGrip: THREE.Vector3, rightGrip: THREE.Vector3,
                                         capturedAt = Date.now()): XrBodyCalibration | null {
  if (!Number.isFinite(rawHeadY)) return null;
  const gripSpan = leftGrip.distanceTo(rightGrip);
  const body = bodyHeightFromGripSpan(gripSpan);
  if (!body) return null;
  return {
    version: 1, capturedAt, gripSpan,
    standingHeight: body.standingHeight,
    eyeHeight: body.eyeHeight,
    rawStandingEyeY: rawHeadY,
    floorOffset: body.eyeHeight - rawHeadY,
  };
}

/** A stored offset belongs to the same reference origin while standing or sitting, but not after a runtime has
 * replaced a bogus origin with a real floor between sessions. */
export function calibrationMatchesOrigin(calibration: XrBodyCalibration, rawHeadY: number): boolean {
  return Number.isFinite(rawHeadY)
    && Math.abs(rawHeadY - calibration.rawStandingEyeY) <= MAX_SAME_ORIGIN_DELTA;
}

/** Safe first-frame behavior before explicit calibration: preserve plausible local-floor heights, otherwise
 * put the eyes at a normal standing height instead of accepting a head-origin or fifteen-foot floor. */
export function fallbackFloorOffset(rawHeadY: number): number {
  if (!Number.isFinite(rawHeadY)) return 0;
  return rawHeadY >= 0.9 && rawHeadY <= 2.5 ? 0 : FALLBACK_STANDING_EYE_HEIGHT - rawHeadY;
}

const _up = new THREE.Vector3(0, 1, 0), _forward = new THREE.Vector3();
const _left = new THREE.Vector3(), _right = new THREE.Vector3(), _across = new THREE.Vector3();
const _basis = new THREE.Matrix4(), _desired = new THREE.Quaternion(), _inverse = new THREE.Quaternion();

/** The T-pose's known anatomy makes the runtime/controller's arbitrary grip axes calibratable: left/right
 * fingers point outward along the shoulder line and both palms face forward. */
export function captureXrHandCalibration(leftRaw: THREE.Quaternion, rightRaw: THREE.Quaternion,
                                         bodyForward: THREE.Vector3, leftSource: XrTrackedHandSource,
                                         rightSource: XrTrackedHandSource): XrHandsCalibration | null {
  _forward.copy(bodyForward).setY(0);
  if (_forward.lengthSq() < 1e-8) return null;
  _forward.normalize();
  _left.crossVectors(_up, _forward).normalize();
  _right.copy(_left).negate();
  return {
    left: { source: leftSource, offset: handOffset(leftRaw, _left, _forward) },
    right: { source: rightSource, offset: handOffset(rightRaw, _right, _forward) },
  };
}

function handOffset(raw: THREE.Quaternion, fingers: THREE.Vector3, palm: THREE.Vector3): XrQuatTuple {
  _across.crossVectors(fingers, palm).normalize();
  _desired.setFromRotationMatrix(_basis.makeBasis(_across, fingers, palm));
  _inverse.copy(raw).invert().multiply(_desired).normalize();
  return [_inverse.x, _inverse.y, _inverse.z, _inverse.w];
}

/** Apply a saved correction only to the input source kind it was learned from. Switching between controller
 * grips and optical hands therefore cannot inherit a device-inappropriate offset. */
export function applyXrHandCalibration(raw: THREE.Quaternion, saved: XrHandOrientationCalibration | undefined,
                                       source: XrTrackedHandSource, out = new THREE.Quaternion()): THREE.Quaternion {
  out.copy(raw);
  if (!saved || saved.source !== source) return out;
  return out.multiply(new THREE.Quaternion(...saved.offset)).normalize();
}

export function loadXrBodyCalibration(): XrBodyCalibration | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<XrBodyCalibration> | null;
    if (!parsed || parsed.version !== 1) return null;
    const values = [parsed.capturedAt, parsed.gripSpan, parsed.standingHeight, parsed.eyeHeight,
      parsed.rawStandingEyeY, parsed.floorOffset];
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    if (!bodyHeightFromGripSpan(parsed.gripSpan!)) return null;
    if (parsed.hands !== undefined && !validHands(parsed.hands)) return null;
    return parsed as XrBodyCalibration;
  } catch { return null; }
}

function validHands(value: unknown): value is XrHandsCalibration {
  if (!value || typeof value !== 'object') return false;
  const hands = value as Partial<XrHandsCalibration>;
  return validHand(hands.left) && validHand(hands.right);
}

function validHand(value: unknown): value is XrHandOrientationCalibration {
  if (!value || typeof value !== 'object') return false;
  const hand = value as Partial<XrHandOrientationCalibration>;
  return (hand.source === 'hand' || hand.source === 'grip')
    && Array.isArray(hand.offset) && hand.offset.length === 4
    && hand.offset.every(n => typeof n === 'number' && Number.isFinite(n));
}

export function saveXrBodyCalibration(calibration: XrBodyCalibration): void {
  try { localStorage.setItem(KEY, JSON.stringify(calibration)); } catch { /* disabled/full storage */ }
}

export function clearXrBodyCalibration(): void {
  try { localStorage.removeItem(KEY); } catch { /* disabled storage */ }
}
