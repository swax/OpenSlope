// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyXrHandCalibration, bodyHeightFromGripSpan, calibrationMatchesOrigin, captureXrBodyCalibration,
  captureXrHandCalibration, fallbackFloorOffset,
} from '../src/app/ride/xr/calibration';

const body = bodyHeightFromGripSpan(1.5);
assert(body, 'a human controller span should produce a body measurement');
assert(Math.abs(body.standingHeight - 1.74) < 1e-9, 'the T-pose adds both grip-to-fingertip reaches');
assert(Math.abs(body.eyeHeight - 1.62) < 1e-9, 'eye height sits one crown offset below stature');
assert.equal(bodyHeightFromGripSpan(0.2), null, 'folded arms are not accepted as a T-pose');

const captured = captureXrBodyCalibration(
  4.6, new THREE.Vector3(-0.75, 4.1, 0), new THREE.Vector3(0.75, 4.1, 0), 123,
);
assert(captured, 'a valid T-pose should capture');
assert(Math.abs(captured.floorOffset + 2.98) < 1e-9,
  'a 4.6 m raw head receives the correction that puts its eyes at 1.62 m');
assert(Math.abs(4.6 + captured.floorOffset - captured.eyeHeight) < 1e-9,
  'raw head plus correction is the inferred standing eye height');
assert(calibrationMatchesOrigin(captured, 4.0), 'a later seated pose retains the standing calibration');
assert(!calibrationMatchesOrigin(captured, 1.7), 'a replaced runtime origin rejects the stale correction');

assert.equal(fallbackFloorOffset(1.7), 0, 'a plausible local-floor height is trusted before calibration');
assert(Math.abs(4.6 + fallbackFloorOffset(4.6) - 1.6) < 1e-9,
  'an implausibly high origin is immediately brought to the standing fallback');
assert(Math.abs(0.2 + fallbackFloorOffset(0.2) - 1.6) < 1e-9,
  'a head-origin runtime receives the same safe fallback');

// A T-pose supplies more than height: fingers are outward and both palms face body-forward. This calibrates
// controller-specific grip axes once, while retaining separate offsets for optical hands and controller grips.
const leftRaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.45, 0.8));
const rightRaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.6, -0.5));
const wristCalibration = captureXrHandCalibration(
  leftRaw, rightRaw, new THREE.Vector3(0, -0.2, -1), 'grip', 'grip',
);
assert(wristCalibration, 'a forward-facing T-pose should capture both wrist offsets');
const leftCorrected = applyXrHandCalibration(leftRaw, wristCalibration.left, 'grip');
const rightCorrected = applyXrHandCalibration(rightRaw, wristCalibration.right, 'grip');
assert(new THREE.Vector3(0, 1, 0).applyQuaternion(leftCorrected)
  .distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-8,
'the left T-pose fingers should point outward');
assert(new THREE.Vector3(0, 1, 0).applyQuaternion(rightCorrected)
  .distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-8,
'the right T-pose fingers should point outward');
for (const corrected of [leftCorrected, rightCorrected]) {
  assert(new THREE.Vector3(0, 0, 1).applyQuaternion(corrected)
    .distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-8,
  'both T-pose palms should face forward');
}
const opticalUnchanged = applyXrHandCalibration(leftRaw, wristCalibration.left, 'hand');
assert(1 - Math.abs(opticalUnchanged.dot(leftRaw)) < 1e-9,
  'a controller-grip correction must not be applied after switching to optical hands');

console.log('XR CALIBRATION: PASS');
