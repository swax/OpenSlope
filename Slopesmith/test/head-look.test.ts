// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { riderLookTarget } from '../src/app/ride/pose';
import { GRAVITY } from '../src/app/ride/physics-tuning';
import { createRider, type Rider, type RiderInput } from '../src/app/ride/rider';

const DEG = 180 / Math.PI;
const up = new THREE.Vector3(0, 1, 0);
const downhill = new THREE.Vector3(0, 0, 1);
const velocity = new THREE.Vector3(0, 0, 18);

const yawDeg = (v: THREE.Vector3) => Math.atan2(v.x, v.z) * DEG;
const pitchDeg = (v: THREE.Vector3) => Math.asin(THREE.MathUtils.clamp(v.clone().normalize().y, -1, 1)) * DEG;
const chestFrame = (rider: Rider) => {
  const spine = rider.solved.clavicleRoot.clone().sub(rider.solved.upperBack).normalize();
  const shoulders = rider.solved.shoulderFront.clone().sub(rider.solved.shoulderRear).normalize();
  const forward = new THREE.Vector3().crossVectors(spine, shoulders).normalize();
  return { spine, forward };
};
const neckYawDeg = (rider: Rider) => {
  const { spine, forward } = chestFrame(rider);
  const face = rider.solved.headForward.clone().addScaledVector(
    spine, -rider.solved.headForward.dot(spine),
  ).normalize();
  return forward.angleTo(face) * DEG;
};

// A committed edge puts the eyes comfortably ahead of the deck instead of leaving them fixed on its centreline.
const throughTurn = riderLookTarget(
  { grounded: true, lean: 0.85, landEta: Infinity }, velocity, downhill, up,
);
assert(yawDeg(throughTurn) > 30 && yawDeg(throughTurn) < 34,
  `a held carve looks about 32° through the turn (got ${yawDeg(throughTurn).toFixed(1)}°)`);
const otherTurn = riderLookTarget(
  { grounded: true, lean: -0.85, landEta: Infinity }, velocity, downhill, up,
);
assert(Math.abs(yawDeg(otherTurn) + yawDeg(throughTurn)) < 1e-9,
  'the other edge leads the eyes by the same amount in the other direction');

// Once the edge is released in the air, attention is the displacement to the predicted terrain crossing — not
// merely the board nose and not merely the instantaneous velocity tangent.
const eta = 0.8;
const fallingVelocity = new THREE.Vector3(-5, -2, 17);
const duringAirTurn = riderLookTarget(
  { grounded: false, lean: 0, landEta: eta }, fallingVelocity, downhill, up,
  new THREE.Vector3(), new THREE.Vector3(), 1,
);
assert(yawDeg(duringAirTurn) > 9 && yawDeg(duringAirTurn) < 11,
  'while an airborne yaw is still moving, the head naturally leads the rider\'s front by about 10°');
const landing = riderLookTarget(
  { grounded: false, lean: 0, landEta: eta }, fallingVelocity, downhill, up,
);
const exactLandingChord = fallingVelocity.clone().multiplyScalar(eta);
exactLandingChord.y -= 0.5 * GRAVITY * eta * eta;
exactLandingChord.normalize();
assert(landing.distanceTo(exactLandingChord) < 1e-12,
  'released in falling air, the eyes acquire the same ballistic landing chord as the predictor');
assert(pitchDeg(landing) < -20, 'the landing target is visibly below the horizon');

// A complete airborne yaw has two readable landmarks in the chase view. The head travels with the rider's own
// front while rotation is held: halfway around it faces back toward the camera, and at the completed turn it is
// downhill again. Only then may releasing the rotation hand it to the landing target.
{
  const spinRider = createRider();
  const frontSeat = new THREE.Vector3(0, 0, 0.27);
  const rearSeat = new THREE.Vector3(0, 0, -0.27);
  const spinForward = downhill.clone();
  const spinLook = downhill.clone(), spinScratch = new THREE.Vector3();
  const spinInput: RiderInput = {
    ankleFront: frontSeat.clone(), ankleRear: rearSeat.clone(),
    deckUp: up, soleUp: up, bank: 0,
    vel: fallingVelocity, accel: new THREE.Vector3(),
    rideForward: spinForward, lookForward: spinForward,
    grounded: false, dt: 1 / 60, crouch: 0, lean: 0,
  };
  spinRider.reset(spinInput);
  const turnTo = (angle: number) => {
    spinInput.ankleFront.copy(frontSeat).applyAxisAngle(up, angle);
    spinInput.ankleRear.copy(rearSeat).applyAxisAngle(up, angle);
    spinForward.copy(downhill).applyAxisAngle(up, angle);
    spinInput.lookForward = riderLookTarget(
      { grounded: false, lean: 0, landEta: eta }, fallingVelocity, spinForward, up,
      spinLook, spinScratch, 1,
    );
    spinRider.pose(spinInput);
  };
  for (let frame = 1; frame <= 40; frame++) turnTo(Math.PI * frame / 40);
  assert(spinRider.solved.headForward.dot(new THREE.Vector3(0, 0, -1)) > 0.98,
    'at 180° the face is back toward the chase camera, not prematurely fixed downhill');
  for (let frame = 41; frame <= 80; frame++) turnTo(Math.PI * 2 * frame / 80);
  assert(spinRider.solved.headForward.dot(downhill) > 0.98,
    'at 360° the face has naturally travelled all the way back downhill');
  spinInput.lookForward = landing;
  spinRider.pose(spinInput);
  assert(spinRider.solved.headForward.dot(downhill) > 0.97,
    'releasing at the completed turn begins the landing look without snapping away from downhill');
  spinRider.dispose();
}

// The reported failure: finish only half the yaw, hand the lead to the tail, and land travelling downhill with
// the board/body still backwards. The face may acquire downhill only by sharing the turn with the shoulders;
// at no transitional frame may the rendered chest→face yaw exceed the neck stop.
{
  const switchRider = createRider();
  const frontSeat = new THREE.Vector3(0, 0, 0.27);
  const rearSeat = new THREE.Vector3(0, 0, -0.27);
  const switchForward = downhill.clone(), switchLook = downhill.clone(), switchScratch = new THREE.Vector3();
  const switchInput: RiderInput = {
    ankleFront: frontSeat.clone(), ankleRear: rearSeat.clone(),
    deckUp: up, soleUp: up, bank: 0,
    vel: fallingVelocity, accel: new THREE.Vector3(),
    rideForward: switchForward, lookForward: switchLook,
    grounded: false, dt: 1 / 60, crouch: 0, lean: 0,
  };
  switchRider.reset(switchInput);
  for (let frame = 1; frame <= 40; frame++) {
    const angle = Math.PI * frame / 40;
    switchInput.ankleFront.copy(frontSeat).applyAxisAngle(up, angle);
    switchInput.ankleRear.copy(rearSeat).applyAxisAngle(up, angle);
    switchForward.copy(downhill).applyAxisAngle(up, angle);
    switchInput.lookForward = riderLookTarget(
      { grounded: false, lean: 0, landEta: eta }, fallingVelocity, switchForward, up,
      switchLook, switchScratch, 1,
    );
    switchRider.pose(switchInput);
  }
  // Touchdown latches the tail as the leading end: travel/attention return downhill while the body stays at 180°.
  switchForward.copy(downhill);
  switchInput.lookForward = switchForward;
  switchInput.grounded = true;
  // This fixture measures only the switch-landing recovery. Park its presentation velocity below the calm-glance
  // gate so the rider's intentionally random sightseeing cannot replace the downhill target just before the
  // final assertion (the landing direction itself is supplied explicitly above).
  switchInput.vel = new THREE.Vector3();
  let worstSwitchNeckYaw = 0;
  for (let frame = 0; frame < 90; frame++) {
    switchRider.pose(switchInput);
    worstSwitchNeckYaw = Math.max(worstSwitchNeckYaw, neckYawDeg(switchRider));
  }
  assert(worstSwitchNeckYaw <= 65.15,
    `a backwards landing never exceeds 65° chest→face yaw (worst ${worstSwitchNeckYaw.toFixed(2)}°)`);
  assert(switchRider.solved.headForward.dot(downhill) > 0.95,
    'the bounded shoulder-and-neck recovery still finishes with the face downhill');
  switchRider.dispose();
}

const rider = createRider();
const input: RiderInput = {
  ankleFront: new THREE.Vector3(0, 0, 0.27),
  ankleRear: new THREE.Vector3(0, 0, -0.27),
  deckUp: up,
  soleUp: up,
  bank: 0,
  vel: velocity,
  accel: new THREE.Vector3(),
  rideForward: downhill,
  lookForward: downhill,
  grounded: true,
  dt: 1 / 60,
  crouch: 0,
  lean: 0,
};
rider.reset(input);

// The target changes immediately, but the head does not: it rotates over several frames and arrives naturally.
input.lookForward = throughTurn;
input.lean = 0.85; // suppress the unrelated calm-riding glance while measuring the authored look
rider.pose(input);
const firstTurnYaw = yawDeg(rider.solved.headForward);
assert(firstTurnYaw > 0 && firstTurnYaw < 10,
  `the first turn frame begins moving without snapping to 32° (got ${firstTurnYaw.toFixed(1)}°)`);
for (let i = 0; i < 35; i++) rider.pose(input);
const settledTurnYaw = yawDeg(rider.solved.headForward);
assert(settledTurnYaw > 20 && settledTurnYaw < 35,
  `the eased head settles through the turn (got ${settledTurnYaw.toFixed(1)}°)`);

input.grounded = false;
input.lean = 0;
input.vel = fallingVelocity;
input.lookForward = landing;
rider.pose(input);
const firstLandingYaw = yawDeg(rider.solved.headForward);
assert(Math.abs(firstLandingYaw - settledTurnYaw) < 10,
  'releasing the turn starts a continuous landing look rather than snapping across the neck');
for (let i = 0; i < 50; i++) rider.pose(input);
assert(yawDeg(rider.solved.headForward) < -10, 'after the turn, the face reaches across toward the landing');
assert(pitchDeg(rider.solved.headForward) < -20, 'after the turn, the face lowers toward the touchdown point');

// Even deliberately impossible targets recruit the shoulders and cannot turn the procedural or imported head
// past its comfortable stop. The measurement is CHEST→FACE, not board→face: that distinction is the switch bug.
input.lookForward = downhill;
for (let i = 0; i < 180; i++) rider.pose(input);
const chestBeforeImpossibleLook = chestFrame(rider).forward;
input.lookForward = chestBeforeImpossibleLook.clone().negate();
for (let i = 0; i < 180; i++) rider.pose(input);
const limitedYaw = neckYawDeg(rider);
const sharedTorsoYaw = chestBeforeImpossibleLook.angleTo(chestFrame(rider).forward) * DEG;
assert(limitedYaw > 64 && limitedYaw <= 65.15,
  `a behind-the-back target stops at 65° of visible neck yaw (got ${limitedYaw.toFixed(2)}°)`);
assert(sharedTorsoYaw > 30 && sharedTorsoYaw < 80,
  `the shoulders materially share the impossible look instead of leaving it all to the neck `
  + `(moved ${sharedTorsoYaw.toFixed(2)}° between targets)`);

input.lookForward = downhill;
for (let i = 0; i < 180; i++) rider.pose(input);
const neutralHeadForward = rider.solved.headForward.clone();
const neutralHeadUp = rider.solved.headUp.clone();
input.lookForward = neutralHeadUp.clone().negate(); // straight down in the neck's own frame
for (let i = 0; i < 180; i++) rider.pose(input);
const limitedPitch = pitchDeg(rider.solved.headForward);
const neckPitch = neutralHeadForward.angleTo(rider.solved.headForward) * DEG;
assert(neckPitch > 44 && neckPitch <= 45.01,
  `a target under the rider stops at 45° down from the neutral neck (got ${neckPitch.toFixed(2)}°)`);
assert(limitedPitch < -40, 'the limited landing look still reads visibly downward in world space');
assert(Math.abs(rider.solved.headForward.dot(rider.solved.headUp)) < 1e-9,
  'pitch rotates the complete head frame; forward and up remain orthogonal for imported rigs');

rider.dispose();
console.log('HEAD LOOK TESTS PASSED');
