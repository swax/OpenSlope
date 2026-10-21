// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyXrHandCalibration,
  bodyHeightFromGripSpan,
  calibrationMatchesOrigin,
  captureXrBodyCalibration,
  captureXrHandCalibration,
  fallbackFloorOffset,
  XrHeightCalibration,
} from '../src/app/ride/xr/calibration';

const body = bodyHeightFromGripSpan(1.5);
assert(body, 'a human controller span should produce a body measurement');
assert(Math.abs(body.standingHeight - 1.74) < 1e-9, 'the T-pose adds both grip-to-fingertip reaches');
assert(Math.abs(body.eyeHeight - 1.62) < 1e-9, 'eye height sits one crown offset below stature');
assert.equal(bodyHeightFromGripSpan(0.2), null, 'folded arms are not accepted as a T-pose');

const captured = captureXrBodyCalibration(4.6, new THREE.Vector3(-0.75, 4.1, 0), new THREE.Vector3(0.75, 4.1, 0), 123);
assert(captured, 'a valid T-pose should capture');
assert(
  Math.abs(captured.floorOffset + 2.98) < 1e-9,
  'a 4.6 m raw head receives the correction that puts its eyes at 1.62 m',
);
assert(
  Math.abs(4.6 + captured.floorOffset - captured.eyeHeight) < 1e-9,
  'raw head plus correction is the inferred standing eye height',
);
assert(calibrationMatchesOrigin(captured, 4.0), 'a later seated pose retains the standing calibration');
assert(!calibrationMatchesOrigin(captured, 1.7), 'a replaced runtime origin rejects the stale correction');

assert(Math.abs(1.7 + fallbackFloorOffset(1.7) - 1.65) < 1e-9, 'ordinary standing height also normalizes to 1.65 m');
assert(
  Math.abs(4.6 + fallbackFloorOffset(4.6) - 1.65) < 1e-9,
  'an implausibly high origin is immediately brought to the standing fallback',
);
assert(Math.abs(0.2 + fallbackFloorOffset(0.2) - 1.65) < 1e-9, 'a head-origin runtime receives the same safe fallback');

// Native and WebXR follow the same policy, with opposite signs for origin vs rig lift.
for (const rawY of [0.2, 1.05, 1.65, 1.9, 4.6]) {
  const height = new XrHeightCalibration();
  assert(height.update(rawY));
  assert(Math.abs(rawY + height.floorOffset - 1.65) < 1e-9, 'calibration lifts or lowers eyes to exactly 1.65 m');
  assert.equal(height.seated, rawY < 1.4, 'posture is chosen only at calibration');
  const offset = height.floorOffset;
  assert(!height.update(rawY - 0.4), 'a physical crouch must not recalibrate height');
  assert.equal(height.floorOffset, offset);
  assert.equal(height.seated, rawY < 1.4, 'a standing crouch cannot switch posture mode');
  for (const placement of [new THREE.Vector3(), new THREE.Vector3(8, 15, -20), new THREE.Vector3(-200, 80, 90)]) {
    const rig = new THREE.Group();
    rig.position.copy(placement).y += offset;
    rig.rotateY(0.8);
    rig.updateMatrixWorld(true);
    const rawHead = new THREE.Vector3(0, rawY, 0),
      rawHand = new THREE.Vector3(0.25, rawY - 0.4, -0.3);
    const head = rawHead.clone().applyMatrix4(rig.matrixWorld),
      hand = rawHand.clone().applyMatrix4(rig.matrixWorld);
    assert(Math.abs(head.y - placement.y - 1.65) < 1e-9, 'mount/dismount/teleport placement retains eye height');
    assert(
      Math.abs(hand.distanceTo(head) - rawHand.distanceTo(rawHead)) < 1e-9,
      'hands and view share one rigid correction',
    );
    assert(!height.update(rawY + 0.5), 'world placement cannot redefine neutral height');
    assert.equal(height.floorOffset, offset);
  }
}
const height = new XrHeightCalibration();
height.update(1.05);
assert(!height.update(1.8) && height.seated, 'standing up keeps the seated offset until reset/recenter');
height.request();
assert(height.update(1.8) && !height.seated, 'reset reevaluates sitting-to-standing mode');
assert(Math.abs(1.8 + height.floorOffset - 1.65) < 1e-9);
height.request();
assert(height.update(4.6), 'recenter accepts a very high runtime origin');
assert(Math.abs(4.6 + height.floorOffset - 1.65) < 1e-9, 'recenter lowers an excessive eye height');
height.request();
assert(!height.update(Number.NaN) && !height.update(Infinity), 'lost tracking leaves calibration pending');
assert(height.update(1.05) && height.seated, 'a valid seated sample completes the pending correction');

// A T-pose supplies more than height: fingers are outward and both palms face body-forward. This calibrates
// controller-specific grip axes once, while retaining separate offsets for optical hands and controller grips.
const leftRaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.45, 0.8));
const rightRaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.6, -0.5));
const wristCalibration = captureXrHandCalibration(leftRaw, rightRaw, new THREE.Vector3(0, -0.2, -1), 'grip', 'grip');
assert(wristCalibration, 'a forward-facing T-pose should capture both wrist offsets');
const leftCorrected = applyXrHandCalibration(leftRaw, wristCalibration.left, 'grip');
const rightCorrected = applyXrHandCalibration(rightRaw, wristCalibration.right, 'grip');
assert(
  new THREE.Vector3(0, 1, 0).applyQuaternion(leftCorrected).distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-8,
  'the left T-pose fingers should point outward',
);
assert(
  new THREE.Vector3(0, 1, 0).applyQuaternion(rightCorrected).distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-8,
  'the right T-pose fingers should point outward',
);
for (const corrected of [leftCorrected, rightCorrected]) {
  assert(
    new THREE.Vector3(0, 0, 1).applyQuaternion(corrected).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-8,
    'both T-pose palms should face forward',
  );
}
const opticalUnchanged = applyXrHandCalibration(leftRaw, wristCalibration.left, 'hand');
assert(
  1 - Math.abs(opticalUnchanged.dot(leftRaw)) < 1e-9,
  'a controller-grip correction must not be applied after switching to optical hands',
);

console.log('XR CALIBRATION: PASS');
