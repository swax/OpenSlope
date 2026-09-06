import type * as THREE from 'three';
import type { CharacterHandCurl } from '../character-rig';

/**
 * Digit curls read from OPTICAL hand tracking (docs/030, docs/048).
 *
 * Controllers report a grip and a trigger, which `controllerFingerCurls` turns into a hand pose directly.
 * A tracked hand reports no gamepad at all — `readHand` returns null for it — so before this the avatar's
 * fingers stayed in their open bind pose no matter what the rider's real hand was doing. What a tracked
 * hand DOES report is 25 joint poses, and a curl is recoverable from those.
 *
 * The measure is the total TURN along each digit's chain: the angle between consecutive bone segments,
 * summed. That is deliberately not "distance from fingertip to palm", which changes with hand size, nor a
 * single joint's angle, which misses whether the rest of the finger followed. A sum of angles is
 * scale-free — it is the same number for a large hand and a small one making the same shape.
 */

/** WebXR joint names per digit, root to tip. The thumb has no intermediate phalanx. */
export const DIGIT_JOINTS = {
  thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate',
    'index-finger-phalanx-distal', 'index-finger-tip'],
  middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate',
    'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate',
    'ring-finger-phalanx-distal', 'ring-finger-tip'],
  pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate',
    'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
} as const satisfies Record<keyof CharacterHandCurl, readonly string[]>;

/**
 * Where a hand shape lands on 0..1, in radians of total turn along the chain.
 *
 * A flat hand is not quite straight and a fist is not quite a circle, so both ends are set inside the
 * anatomical extremes: `REST` is the slack a relaxed open hand carries, and `FULL` is a firm rather than a
 * crushing fist, so an ordinary grip reaches 1 instead of asymptotically approaching it. The thumb has one
 * fewer joint and far less range, hence its own pair.
 *
 * These four numbers are the tuning surface of this file. They are set from anatomy rather than measured off
 * a headset, so they are the first thing to adjust if tracked hands read consistently over- or under-closed.
 */
export const FINGER_REST = 0.45, FINGER_FULL = 3.8;
export const THUMB_REST = 0.25, THUMB_FULL = 2.0;

/** The minimal shape of a `THREE.XRHandSpace`, so this is testable without a headset or a WebXR polyfill. */
export interface TrackedJoint {
  position: THREE.Vector3;
  visible?: boolean;
}
export interface TrackedHand {
  joints: Partial<Record<string, TrackedJoint | undefined>>;
  visible?: boolean;
}

/**
 * Total turn along a chain of joint positions, with the number of joints it was measured across, or null if
 * too little of the chain is being tracked to say anything.
 *
 * The joint COUNT comes back because the totals above are whole-chain references: measure a finger across
 * two joints instead of three and the same shape reads as two thirds closed. Dividing by what was actually
 * measured lets a hand with a joint missing degrade to a slightly-off answer instead of a badly wrong one,
 * which matters because the caller's fallback for "no optical curl" is the controller pose — and a tracked
 * hand has no controller, so the fallback is an open hand.
 *
 * Segments shorter than a millimetre are skipped rather than normalized: a runtime that has not yet resolved
 * a joint reports it coincident with its neighbour, and the angle to a zero-length segment is meaningless
 * rather than zero.
 */
export function chainTurn(points: readonly (THREE.Vector3 | null)[]): { total: number; joints: number } | null {
  const segments: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i], to = points[i + 1];
    if (!from || !to) continue;
    const x = to.x - from.x, y = to.y - from.y, z = to.z - from.z;
    const length = Math.hypot(x, y, z);
    if (length < 1e-3) continue;
    segments.push({ x: x / length, y: y / length, z: z / length });
  }
  if (segments.length < 2) return null;
  let total = 0;
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = segments[i], b = segments[i + 1];
    total += Math.acos(Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z)));
  }
  return { total, joints: segments.length - 1 };
}

const unit = (value: number, rest: number, full: number) =>
  Math.min(1, Math.max(0, (value - rest) / (full - rest)));

/**
 * Curls for one optically tracked hand, or null when it is not being tracked — in which case the caller
 * keeps whatever the controllers said, so a rider who puts a controller down and picks it up again does not
 * get a frame of splayed fingers in between.
 */
export function trackedFingerCurls(hand: TrackedHand | null | undefined): CharacterHandCurl | null {
  if (!hand || hand.visible === false) return null;
  const wrist = hand.joints.wrist;
  if (!wrist || wrist.visible === false) return null;
  const curls: Partial<CharacterHandCurl> = {};
  for (const [digit, names] of Object.entries(DIGIT_JOINTS) as [keyof CharacterHandCurl, readonly string[]][]) {
    const points = names.map(name => {
      const joint = hand.joints[name];
      return joint && joint.visible !== false ? joint.position : null;
    });
    const measured = chainTurn(points);
    if (!measured) return null;
    // Per joint, against the same reference divided by the joints a complete digit has: `names.length - 2`
    // is three for a finger and two for the thumb.
    const perJoint = measured.total / measured.joints;
    const reference = names.length - 2;
    curls[digit] = digit === 'thumb'
      ? unit(perJoint, THUMB_REST / reference, THUMB_FULL / reference)
      : unit(perJoint, FINGER_REST / reference, FINGER_FULL / reference);
  }
  return curls as CharacterHandCurl;
}
