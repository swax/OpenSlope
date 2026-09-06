// tier: fast

import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  DIGIT_JOINTS, FINGER_FULL, FINGER_REST, THUMB_FULL, THUMB_REST,
  chainTurn, trackedFingerCurls, type TrackedHand,
} from '../src/app/ride/xr/hand-curl';

/**
 * Digit curls recovered from WebXR hand-tracking joints (docs/030).
 *
 * A tracked hand carries no gamepad, so before this the avatar's fingers stayed open no matter what the
 * rider's real hand did. The joints are synthesized here rather than replayed from a headset, which is the
 * only way to state what a shape SHOULD read as: a straight chain is zero curl by construction, and a chain
 * folded through known angles is a known fraction of a fist whatever hand it came from.
 */

/** A digit as joint positions: `count` segments of `length`, each turned `turn` radians from the last. */
function chain(count: number, length: number, turn: number): Vector3[] {
  const points = [new Vector3()];
  const direction = new Vector3(0, 1, 0);
  const axis = new Vector3(0, 0, 1);
  for (let i = 0; i < count; i++) {
    if (i > 0) direction.applyAxisAngle(axis, turn);
    points.push(points[points.length - 1].clone().addScaledVector(direction, length));
  }
  return points;
}

// A straight chain has turned through nothing, however long it is or however it is oriented.
assert.deepEqual(chainTurn(chain(4, 0.03, 0)), { total: 0, joints: 3 });
const turned = chainTurn(chain(4, 0.03, 0.5));
assert(turned && Math.abs(turned.total - 1.5) < 1e-9, `three joints at 0.5 rad sum to 1.5, not ${turned?.total}`);
assert.equal(turned.joints, 3, 'and it says how many joints that was measured across');

// Too little of a digit tracked to say anything. Returning null rather than 0 matters: 0 is a claim that the
// hand is OPEN, which would snap an avatar's fingers straight the moment a joint dropped out.
assert.equal(chainTurn([new Vector3(), new Vector3(0, 1, 0)]), null, 'one segment cannot have turned');
assert.equal(chainTurn([new Vector3(), null, new Vector3(0, 1, 0)]), null);
// A runtime that has not resolved a joint reports it on top of its neighbour; the angle to a zero-length
// segment is meaningless, so it is skipped rather than counted as straight.
assert.equal(chainTurn([new Vector3(), new Vector3(), new Vector3(0, 1, 0)]), null);

/** Build a hand whose every digit is folded through `turn` radians per joint. */
function hand(turn: number, options: { drop?: string; visible?: boolean } = {}): TrackedHand {
  const joints: Record<string, { position: Vector3; visible?: boolean }> = {
    wrist: { position: new Vector3() },
  };
  for (const names of Object.values(DIGIT_JOINTS)) {
    const points = chain(names.length - 1, 0.03, turn);
    names.forEach((name, index) => { joints[name] = { position: points[index] }; });
  }
  if (options.drop) delete joints[options.drop];
  return { joints, visible: options.visible };
}

// A flat hand reads as open. Anything at or under the rest slack clamps to exactly 0 rather than going
// negative, so a rider holding their hand deliberately flat cannot bend the avatar's fingers backwards.
const open = trackedFingerCurls(hand(0));
assert(open, 'a fully tracked hand reports curls');
for (const digit of ['thumb', 'index', 'middle', 'ring', 'pinky'] as const) {
  assert.equal(open[digit], 0, `${digit} reads open`);
}

// A fist reads closed. Three finger joints at the full reference share the total between them.
const closed = trackedFingerCurls(hand(FINGER_FULL / 3));
assert(closed, 'a fist reports curls');
for (const digit of ['index', 'middle', 'ring', 'pinky'] as const) {
  assert.equal(closed[digit], 1, `${digit} reads closed`);
}
// The thumb has one joint fewer and its own reference, so the same per-joint angle is not the same fraction
// of a thumb's range — which is the entire reason it does not share the fingers' constants.
const thumbClosed = trackedFingerCurls(hand(THUMB_FULL / 2));
assert(thumbClosed && thumbClosed.thumb === 1, 'the thumb closes on its own reference');

// Halfway between the two references is halfway closed, and monotonic in between.
const half = trackedFingerCurls(hand((FINGER_REST + (FINGER_FULL - FINGER_REST) / 2) / 3));
assert(half && Math.abs(half.index - 0.5) < 1e-6, `half a fist reads ${half?.index}`);
let previous = -1;
for (let step = 0; step <= 10; step++) {
  const sample = trackedFingerCurls(hand((FINGER_FULL * step) / 10 / 3));
  assert(sample && sample.index >= previous, 'curl rises with the angle rather than folding back');
  previous = sample.index;
}
assert(THUMB_REST < THUMB_FULL && FINGER_REST < FINGER_FULL, 'the references are the right way round');

// Not tracked is not the same as open: a hand that has gone missing returns null so the caller can keep the
// controller pose, rather than reporting a splayed hand for the frames the tracking dropped.
assert.equal(trackedFingerCurls(null), null);
assert.equal(trackedFingerCurls(undefined), null);
assert.equal(trackedFingerCurls(hand(0, { visible: false })), null, 'a hidden hand reports nothing');
assert.equal(trackedFingerCurls(hand(0, { drop: 'wrist' })), null, 'no wrist, no hand');
assert.equal(trackedFingerCurls({ joints: {} }), null);

/**
 * A digit missing one joint still reports close to the right answer.
 *
 * This is the case the per-joint normalization exists for. Measured against the whole-chain reference a
 * two-joint finger reads two thirds closed whatever it is doing; measured per joint it lands within a few
 * percent of the truth. It matters because the caller's fallback when this returns null is the CONTROLLER
 * pose, and a tracked hand has no controller — so "I don't know" renders as a splayed hand.
 */
const whole = trackedFingerCurls(hand(FINGER_FULL / 3 * 0.6));
const partial = trackedFingerCurls(hand(FINGER_FULL / 3 * 0.6, { drop: 'index-finger-tip' }));
assert(whole && partial, 'a digit missing its tip still reports');
assert(Math.abs(partial.index - whole.index) < 0.02,
  `a dropped joint costs accuracy, not correctness (${whole.index.toFixed(3)} → ${partial.index.toFixed(3)})`);
assert.equal(partial.middle, whole.middle, 'and it does not disturb the digits that are fully tracked');

console.log('HAND CURL: PASS');
