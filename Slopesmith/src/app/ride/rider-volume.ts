import * as THREE from 'three';
import {
  BOARD_COLLISION_Y, BOARD_HALF_LENGTH, BOARD_HALF_WIDTH, RIDER_BODY_Y, RIDER_HEAD_Y, RIDER_SHOULDER_R,
  RIDER_TORSO_Y, WORLD_UP,
} from './physics-tuning';

/**
 * What shape the rider is, in one place.
 *
 * The engine carries a collision volume — a body sphere plus eighteen limb spheres posed from the character's
 * skeleton — and each collision mode consumes a different part of it ([Trailmap: 370-probe-volume,
 * 370-probe-modes]). This ride approximates the limb set with a swept sample body and reproduces the body
 * sphere exactly, and BOTH the contact solver and the Test-mode collider overlay read the shape from here, so
 * what is drawn is what collides.
 */

/** The nine board-footprint samples come first: they are the ones a ride-through sensor may report from. */
export const RIDER_DECK_SAMPLES = 9;
/** …then the torso pair, the shoulder pair's centre, and the head. */
export const RIDER_PROBE_SAMPLES = 13;

/**
 * Fill `out` with this pose's probe offsets from the rider origin.
 *
 * A 3×3 board footprint is the authority — centre, all four sides, and all four corners — because earlier
 * independent nose/tail/side rays left diagonal gaps a fast banked board could thread through. The upper
 * samples keep the tied rider on the board inside low tunnels; board collision remains the earliest authority
 * for ordinary walls because its forward corners lead the torso.
 */
export function riderProbeOffsets(
  forward: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, out: readonly THREE.Vector3[],
): void {
  let at = 0;
  for (let ai = -1; ai <= 1; ai++) {
    const along = ai * BOARD_HALF_LENGTH;
    for (let bi = -1; bi <= 1; bi++) {
      out[at++].copy(forward).multiplyScalar(along)
        .addScaledVector(right, bi * BOARD_HALF_WIDTH).addScaledVector(up, BOARD_COLLISION_Y);
    }
  }
  out[9].copy(WORLD_UP).multiplyScalar(RIDER_TORSO_Y);
  out[10].copy(right).multiplyScalar(RIDER_SHOULDER_R).addScaledVector(WORLD_UP, RIDER_TORSO_Y);
  out[11].copy(right).multiplyScalar(-RIDER_SHOULDER_R).addScaledVector(WORLD_UP, RIDER_TORSO_Y);
  out[12].copy(WORLD_UP).multiplyScalar(RIDER_HEAD_Y);
}

/** Where the body sphere sits for a rider origin and physics up — the only thing a mode-2 box ever meets. */
export function riderBodyCentre(pos: THREE.Vector3, up: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(pos).addScaledVector(up, RIDER_BODY_Y);
}
