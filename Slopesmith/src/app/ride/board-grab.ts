import * as THREE from 'three';
import {
  GRAB_HAND_FORWARD, GRAB_REACH, MOUNT_AIM_PAD, SUMMON_BEHIND, SUMMON_MIN_HEIGHT, SUMMON_RADIUS,
  THROW_MAX_SPEED, THROW_MAX_SPIN, THROW_SAMPLE_MIX, THROW_SCALE,
} from './physics-tuning';
import type { DeckBox } from './gear';

/**
 * THE BOARD IN YOUR HAND — shared carry arithmetic for WebXR and desktop
 * (`RideableBoard.Grab.cs`, Unity docs/vrchat/017).
 *
 * A board is a thing you hold, not a mode you are in. Walk up to one lying on the snow and squeeze the grip and
 * it is in your hand; pass it to the other hand; pull the trigger and it goes back under your feet; open your
 * hand and it flies, tumbling, exactly as hard as you threw it. Mid-run the same grip snatches the deck out from
 * under you in the air, which is a trick you land by catching it again.
 *
 * Every path puts it into the same palm-edge carry:
 *
 *  - The right hand takes the visible right edge and the left hand the visible left edge.
 *  - A nearby ground/air grab retains where the hand met the deck ALONG its length, from tail to nose; a summon
 *    uses the waist because there was no physical contact point.
 *  - The edge is seated 2 in toward the controller and 1.5 in toward the wearer from the palm. The long edge
 *    follows controller up/down, the topsheet faces the wearer, and the gear hangs inward.
 *
 * Together those make the grab a rigid attachment captured at one moment: the whole of the hold is a position
 * offset and a rotation offset, both in hand space, and both frozen at the grab.
 *
 * No scene, no DOM, no WebXR: two poses in, one pose out. A headset supplies a tracked hand and desktop supplies
 * a virtual hand on its pointer ray; the session host reads that hand and writes the deck.
 * everything here is arithmetic, which is what keeps it checkable headlessly (`test/board-grab.test.ts`).
 */

/** The hand's own frame is `+Y` toward the fingers and `+Z` out of the palm (`canonicalXrHandRotation`). */
const HAND_FINGERS = new THREE.Vector3(0, 1, 0);

/** Where the hand actually closes: a little forward of the tracked wrist, in the middle of the fist. */
export function handGripPoint(handPosition: THREE.Vector3, handRotation: THREE.Quaternion,
                              out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(HAND_FINGERS).applyQuaternion(handRotation)
    .multiplyScalar(GRAB_HAND_FORWARD).add(handPosition);
}

/**
 * The point of the deck nearest `point`, in world space — the box's own nearest point, so a hand beside the
 * nose is nearest the nose and a hand under the waist is nearest the waist.
 */
export function nearestDeckPoint(box: DeckBox, deckPosition: THREE.Vector3, deckRotation: THREE.Quaternion,
                                 point: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  local.copy(point).sub(deckPosition).applyQuaternion(inverse.copy(deckRotation).invert()).sub(box.center);
  local.set(
    THREE.MathUtils.clamp(local.x, -box.half.x, box.half.x),
    THREE.MathUtils.clamp(local.y, -box.half.y, box.half.y),
    THREE.MathUtils.clamp(local.z, -box.half.z, box.half.z),
  ).add(box.center);
  return out.copy(local).applyQuaternion(deckRotation).add(deckPosition);
}

/** How far the closing fist is from the deck itself. Zero once the hand is inside its outline. */
export function deckGrabDistance(box: DeckBox, deckPosition: THREE.Vector3, deckRotation: THREE.Quaternion,
                                 handPosition: THREE.Vector3, handRotation: THREE.Quaternion): number {
  handGripPoint(handPosition, handRotation, grip);
  nearestDeckPoint(box, deckPosition, deckRotation, grip, nearest);
  return grip.distanceTo(nearest);
}

/** Close enough to take hold of — and, before that, close enough for the deck to light up and say so. */
export function deckWithinReach(box: DeckBox, deckPosition: THREE.Vector3, deckRotation: THREE.Quaternion,
                                handPosition: THREE.Vector3, handRotation: THREE.Quaternion,
                                reach = GRAB_REACH): boolean {
  return deckGrabDistance(box, deckPosition, deckRotation, handPosition, handRotation) <= reach;
}

/**
 * Where a POINTED ray meets the deck, in metres along it, or null for a miss — the trigger's half of the split.
 * The outline is padded, because a board is 14 cm thick and pointing at one should be aiming, not threading a
 * needle. Exact against the deck's own box in its own frame, so a board standing on its tail is pointed at
 * end-on exactly as it looks.
 */
export function deckRayDistance(box: DeckBox, deckPosition: THREE.Vector3, deckRotation: THREE.Quaternion,
                                ray: THREE.Ray, pad = MOUNT_AIM_PAD): number | null {
  inverse.copy(deckRotation).invert();
  aimRay.origin.copy(ray.origin).sub(deckPosition).applyQuaternion(inverse);
  aimRay.direction.copy(ray.direction).applyQuaternion(inverse).normalize();
  aimBox.min.copy(box.center).sub(box.half).subScalar(pad);
  aimBox.max.copy(box.center).add(box.half).addScalar(pad);
  return aimRay.intersectBox(aimBox, local) ? local.distanceTo(aimRay.origin) : null;
}

/**
 * THE SWORD-DRAW REACH: is that hand up behind the head? Measured in a YAW-ONLY head frame, because using the
 * head's full rotation would tip "behind me" toward "below me" the moment the wearer looked down — and a rider
 * glancing at their own board would then summon by letting a hand drop.
 *
 * `headRotation` is a VIEWER's: it looks down its own −Z, like every camera and like the session's own head
 * pose. The shipped board reads +Z instead, because that is what VRChat's tracking data hands it — the same
 * gesture, one sign apart, and getting it backwards makes the summon fire whenever a hand is out in front.
 */
export function handBehindHead(headPosition: THREE.Vector3, headRotation: THREE.Quaternion,
                               handPosition: THREE.Vector3): boolean {
  local.copy(handPosition).sub(headPosition);
  flat.set(0, 0, -1).applyQuaternion(headRotation).setY(0);
  if (flat.lengthSq() < 1e-4) return false; // straight up or straight down: no usable facing this frame
  flat.normalize();
  if (-local.dot(flat) < SUMMON_BEHIND) return false;   // in front of the head, or barely past it
  if (local.y < SUMMON_MIN_HEIGHT) return false;        // down at the hips, not up at the shoulder blades
  return local.lengthSq() <= SUMMON_RADIUS * SUMMON_RADIUS; // over the shoulder, not an arm trailing behind
}

export type GrabHand = 'left' | 'right';

/** Fine placement shared by every carry, in metres: into the controller and back toward the wearer. */
export const CARRY_TOWARD_CONTROLLER = 2 * 0.0254;
export const CARRY_TOWARD_PLAYER = 1.5 * 0.0254;

/**
 * The held deck's authored carry orientation. Deck +Z (nose/length) follows the physical controller's
 * up/down edge: canonical +X for the right hand and -X for the mirrored left hand. Deck +Y (topsheet) faces
 * back toward the player along canonical -Y. The remaining axis points the gear's width inward.
 */
export function heldDeckRotation(which: GrabHand, handRotation: THREE.Quaternion,
                                 out = new THREE.Quaternion()): THREE.Quaternion {
  return out.copy(handRotation).multiply(which === 'right' ? RIGHT_DECK_IN_HAND : LEFT_DECK_IN_HAND);
}

/** A point on the hand-appropriate local side edge. `along` retains a physical grab's tail-to-nose location. */
export function heldDeckEdgePoint(box: DeckBox, which: GrabHand, along = box.center.z,
                                  out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(box.center)
    .setX(box.center.x + (which === 'right' ? -box.half.x : box.half.x))
    .setZ(THREE.MathUtils.clamp(along, box.center.z - box.half.z, box.center.z + box.half.z));
}

/** What a released board leaves the hand with: the arc, and the tumble. */
export interface BoardThrow {
  velocity: THREE.Vector3;
  /** World axis × degrees per second, as the coast's thrown flight wants it. */
  spin: THREE.Vector3;
}

export function createBoardGrab() {
  let hand: GrabHand | null = null;
  /** The deck's pose RELATIVE TO THE HAND, captured at the grab and never recomputed: the whole of the hold. */
  const gripOffset = new THREE.Vector3();
  const gripRotation = new THREE.Quaternion();
  /** Measured off the DECK, not the wrist, so a flick that whips a long nose round throws it that fast. */
  const velocity = new THREE.Vector3();
  const spin = new THREE.Vector3();
  const lastPosition = new THREE.Vector3();
  const lastRotation = new THREE.Quaternion();
  let measured = false;

  /**
   * Take hold in the shared controller-relative edge carry. An ordinary grab keeps the hand's tail-to-nose
   * location on that edge; a behind-head summon uses the waist. From there either path is welded to the wrist.
   *
   * `summon` is the over-the-shoulder summon. It snaps directly into the hand on the closing grip; a cross-map
   * move must never be rendered as travel or sampled as throw velocity.
   * `contactPoint`, when supplied by a pointer, selects the physical tail-to-nose location instead of the fist.
   */
  function grab(which: GrabHand, handPosition: THREE.Vector3, handRotation: THREE.Quaternion,
                deckPosition: THREE.Vector3, deckRotation: THREE.Quaternion, box: DeckBox, summon = false,
                contactPoint?: THREE.Vector3) {
    hand = which;
    handGripPoint(handPosition, handRotation, grip);
    let along = box.center.z;
    if (!summon) {
      // Preserve only WHERE ALONG the board the physical hand met it. Width is selected by handedness below;
      // height disappears into the standard palm pose rather than inheriting a board lying on the ground.
      local.copy(contactPoint ?? grip).sub(deckPosition).applyQuaternion(inverse.copy(deckRotation).invert());
      along = THREE.MathUtils.clamp(local.z, box.center.z - box.half.z, box.center.z + box.half.z);
    }
    grip.copy(handPosition); // every held edge seats from the tracked palm/controller grip origin
    heldDeckRotation(which, handRotation, heldRotation);
    heldDeckEdgePoint(box, which, along, nearest).applyQuaternion(heldRotation).add(deckPosition);
    // Where the deck ends up: itself, slid by however far its chosen edge point was from the palm.
    held.copy(deckPosition).add(grip).sub(nearest);
    // Canonical -Z is from the board back toward either mirrored controller; -Y is toward the wearer for this
    // upright carry. Captured below in hand space, so both offsets rotate rigidly with the controller.
    carryOffset.set(0, -CARRY_TOWARD_PLAYER, -CARRY_TOWARD_CONTROLLER).applyQuaternion(handRotation);
    held.add(carryOffset);
    inverse.copy(handRotation).invert();
    gripOffset.copy(held).sub(handPosition).applyQuaternion(inverse);
    gripRotation.copy(inverse).multiply(heldRotation);
    velocity.set(0, 0, 0);
    spin.set(0, 0, 0);
    lastPosition.copy(held);
    lastRotation.copy(heldRotation);
    measured = false;
  }

  /**
   * Where the deck is this frame, and how fast it is being swung. The throw is measured here rather than at
   * release, because release is one frame and a throw is the motion that led up to it; the low-pass is what
   * stops a single dropped tracking frame becoming the whole throw.
   */
  function follow(handPosition: THREE.Vector3, handRotation: THREE.Quaternion, dt: number,
                  outPosition: THREE.Vector3, outRotation: THREE.Quaternion) {
    if (!hand) return;
    outPosition.copy(gripOffset).applyQuaternion(handRotation).add(handPosition);
    outRotation.copy(handRotation).multiply(gripRotation);
    if (dt > 1e-4 && measured) {
      sampled.copy(outPosition).sub(lastPosition).divideScalar(dt);
      velocity.lerp(sampled, THROW_SAMPLE_MIX);
      angularVelocity(lastRotation, outRotation, dt, sampled);
      spin.lerp(sampled, THROW_SAMPLE_MIX);
    }
    lastPosition.copy(outPosition);
    lastRotation.copy(outRotation);
    measured = true;
  }

  /** Let go. The arc and the tumble the hand built, capped so a flick cannot fire the deck across the level. */
  function release(out: BoardThrow = { velocity: new THREE.Vector3(), spin: new THREE.Vector3() }): BoardThrow {
    hand = null;
    measured = false;
    out.velocity.copy(velocity).multiplyScalar(THROW_SCALE).clampLength(0, THROW_MAX_SPEED);
    out.spin.copy(spin).clampLength(0, THROW_MAX_SPIN);
    velocity.set(0, 0, 0);
    spin.set(0, 0, 0);
    return out;
  }

  /** The deck left the hand without being let go of — put back under the feet, or the session ending. */
  function clear() {
    hand = null;
    measured = false;
    velocity.set(0, 0, 0);
    spin.set(0, 0, 0);
  }

  return {
    grab, follow, release, clear,
    /** Which hand has it, or null. */
    get hand() { return hand; },
    get held() { return hand !== null; },
    /** Current measured deck velocity while held, for remote equipment dead reckoning. Read-only by contract. */
    get velocity() { return velocity; },
  };
}

export type BoardGrab = ReturnType<typeof createBoardGrab>;

/**
 * The rotation from `from` to `to` as a world axis scaled by degrees per second. Angle-axis by hand rather
 * than through Euler angles: a tumbling deck passes straight through the gimbal poles those have.
 */
function angularVelocity(from: THREE.Quaternion, to: THREE.Quaternion, dt: number,
                         out: THREE.Vector3): THREE.Vector3 {
  delta.copy(to).multiply(inverse.copy(from).invert());
  // The short way round: a delta and its negation are the same rotation, and only one of them is under 180°.
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const half = Math.acos(THREE.MathUtils.clamp(delta.w, -1, 1));
  const sinHalf = Math.sin(half);
  if (sinHalf < 1e-4) return out.set(0, 0, 0); // near-identity: no spin, rather than a degenerate axis
  return out.set(delta.x, delta.y, delta.z)
    .multiplyScalar(THREE.MathUtils.radToDeg(half * 2) / (sinHalf * dt));
}

// Module scratch: a carry runs every frame in the tightest budget on the platform and allocates nothing.
const local = new THREE.Vector3(), grip = new THREE.Vector3(), nearest = new THREE.Vector3();
const held = new THREE.Vector3(), sampled = new THREE.Vector3(), flat = new THREE.Vector3();
const carryOffset = new THREE.Vector3();
const inverse = new THREE.Quaternion(), delta = new THREE.Quaternion(), heldRotation = new THREE.Quaternion();
const aimRay = new THREE.Ray(), aimBox = new THREE.Box3();

// Deck-local axes expressed in each MIRRORED canonical hand frame. For both hands the long edge follows the
// controller's physical up/down edge, the topsheet faces the wearer, and width runs inward from the caught edge.
const RIGHT_DECK_IN_HAND = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0),
));
const LEFT_DECK_IN_HAND = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
  new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0),
));
