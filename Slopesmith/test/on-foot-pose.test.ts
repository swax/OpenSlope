// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OnFootFacing } from '../src/app/ride/on-foot-facing';
import { createRider, type RiderInput } from '../src/app/ride/rider';

const rider = createRider();
const facing = new THREE.Vector3(0, 0, 1);
const input = (phase: number, weight: number, speed = 0, turn = 0, flying = false): RiderInput => ({
  // On foot the midpoint is the ankle-height body root; the old binding separation is intentionally ignored.
  ankleFront: new THREE.Vector3(0, 0.144, 0.27),
  ankleRear: new THREE.Vector3(0, 0.144, -0.27),
  deckUp: new THREE.Vector3(0, 1, 0), soleUp: new THREE.Vector3(0, 1, 0),
  bank: 0, vel: new THREE.Vector3(0, 0, speed), accel: new THREE.Vector3(),
  grounded: true, dt: 1 / 60, crouch: 0, lean: 0,
  locomotion: { phase, weight, facing, turn, flying },
});

function node(name: string): THREE.Object3D {
  const found = rider.group.getObjectByName(`rider.${name}`);
  assert(found, `missing named rider node ${name}`);
  return found;
}

/** Cylinder shells span local y=0..1, so this is the joint at the far end of one solved limb. */
function limbEnd(name: string): THREE.Vector3 {
  rider.group.updateMatrixWorld(true);
  return node(name).localToWorld(new THREE.Vector3(0, 1, 0));
}

rider.reset(input(0, 0));
const idleFront = limbEnd('shin-front'), idleRear = limbEnd('shin-rear');
const idleHandDrop = node('shoulder-front').position.y - node('hand-front').position.y;
const idleHipY = node('hip-front').position.y;
assert(idleFront.x < -0.09 && idleRear.x > 0.09,
  'a standing character should place feet side-by-side across the body');
assert(Math.abs(idleFront.z - idleRear.z) < 1e-5,
  'a standing character should not retain the snowboard stance\'s staggered bindings');
assert(Math.abs(node('hip-front').position.z - node('hip-rear').position.z) < 1e-5,
  'standing hips should be lateral rather than nose-to-tail');
assert(node('hand-front').position.y < node('shoulder-front').position.y
  && node('hand-rear').position.y < node('shoulder-rear').position.y,
  'idle arms should hang naturally below the shoulders');
assert(node('shoulder-front').position.y - node('hand-front').position.y > 0.49
  && node('shoulder-rear').position.y - node('hand-rear').position.y > 0.49,
  'idle hands should hang nearly at full arm length');
assert(Math.abs(node('hand-front').position.x) - Math.abs(node('shoulder-front').position.x) < 0.025
  && Math.abs(node('hand-rear').position.x) - Math.abs(node('shoulder-rear').position.x) < 0.025,
  'idle arms may sit a touch outside the shoulders but should not flare');
assert(node('elbow-front').position.z < -0.02 && node('elbow-rear').position.z < -0.02,
  'relaxed elbows should bend behind the torso rather than jutting forward');

rider.pose(input(Math.PI / 2, 1, 3));
const forwardFront = limbEnd('shin-front'), forwardRear = limbEnd('shin-rear');
assert(forwardFront.z > 0.18 && forwardRear.z < -0.18,
  'walking should alternate the feet along travel');
assert(forwardFront.y > forwardRear.y + 0.07, 'the swinging foot should lift off the ground');
assert(node('hand-front').position.z < node('hand-rear').position.z,
  'arms should counter-swing against the advancing leg');
assert(node('shoulder-front').position.y - node('hand-front').position.y < idleHandDrop - 0.05,
  'walking hands should rise relative to the lowered walking torso');
assert(node('hip-front').position.y < idleHipY - 0.04,
  'walking should lower the pelvis and bend the legs from their tall idle stance');

rider.pose(input(Math.PI / 2, 1, 300, 0, true));
const flyingFront = limbEnd('shin-front'), flyingRear = limbEnd('shin-rear');
assert(flyingFront.distanceTo(idleFront) < 1e-8 && flyingRear.distanceTo(idleRear) < 1e-8,
  'Superman flight should hold both legs in the neutral stance regardless of horizontal airspeed');
assert(Math.abs(node('hip-front').position.y - idleHipY) < 1e-8,
  'Superman flight should not retain the lowered walking pelvis');

rider.pose(input(Math.PI * 3 / 2, 1, 3));
const reverseFront = limbEnd('shin-front'), reverseRear = limbEnd('shin-rear');
assert(reverseFront.z < -0.18 && reverseRear.z > 0.18,
  'the other foot should advance in the second half of the walk cycle');
assert(reverseRear.y > reverseFront.y + 0.07, 'the opposite swinging foot should lift');

rider.pose(input(Math.PI / 2, 0, 0, 1));
const turnFront = limbEnd('shin-front'), turnRear = limbEnd('shin-rear');
assert(turnFront.z > 0.1 && turnRear.z < -0.1,
  'a right turn-in-place should step opposite feet around the planted body');
assert(turnFront.y > turnRear.y + 0.07, 'the leading turn foot should visibly lift');
assert(node('hip-front').position.y < idleHipY - 0.04,
  'turning in place should soften the knees instead of twisting locked legs');
assert(node('shoulder-front').position.y - node('hand-front').position.y > 0.49,
  'turning in place should retain the relaxed idle arm hang');
rider.pose(input(Math.PI / 2, 0, 0, -1));
const leftTurnFront = limbEnd('shin-front'), leftTurnRear = limbEnd('shin-rear');
assert(leftTurnFront.z < -0.1 && leftTurnRear.z > 0.1,
  'left turns should reverse which foot leads');

const lookQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.25, 0.8, 0.1));
const proxyPosition = new THREE.Vector3(50, 50, 50);
rider.pose(input(0, 0));
const handsBeforeLook = [node('hand-front').position.clone(), node('hand-rear').position.clone()];
rider.pose({ ...input(0, 0), headTarget: {
  position: proxyPosition, quaternion: lookQ, exactPosition: false,
} });
rider.group.updateMatrixWorld(true);
const actualLook = new THREE.Vector3(0, 0, 1).applyQuaternion(
  node('head').getWorldQuaternion(new THREE.Quaternion()),
);
const expectedLook = new THREE.Vector3(0, 0, -1).applyQuaternion(lookQ);
assert(actualLook.angleTo(expectedLook) < 1e-5,
  'the character head should retain the desktop camera yaw and pitch');
assert(node('head').position.distanceTo(proxyPosition) > 10,
  'a desktop camera should steer the head without stretching the neck to the camera proxy');
assert(node('hand-front').position.distanceTo(handsBeforeLook[0]) < 1e-8
  && node('hand-rear').position.distanceTo(handsBeforeLook[1]) < 1e-8,
  'looking around must not move either resting hand');

const pointDirection = new THREE.Vector3(-0.25, 0.3, 1).normalize();
const restingRight = node('hand-front').position.clone();
rider.pose({ ...input(0, 0), headTarget: {
  position: proxyPosition, quaternion: lookQ, exactPosition: false,
}, pointTargets: [{ hand: 'left', direction: pointDirection, weight: 1 }] });
const pointed = node('hand-rear').position.clone().sub(node('shoulder-rear').position).normalize();
assert(pointed.angleTo(pointDirection) < 0.01,
  'a left click should extend the anatomical left arm along its captured world ray');
assert(node('hand-front').position.distanceTo(restingRight) < 1e-8,
  'pointing the left arm must not disturb the right resting hand');

const groundTarget = node('shoulder-rear').position.clone().add(new THREE.Vector3(-0.15, -1.2, 0.1));
rider.pose({ ...input(0, 0), pointTargets: [{
  hand: 'left', direction: new THREE.Vector3(0, 0, 1), target: groundTarget, weight: 1,
}] });
const pointedAtGround = node('hand-rear').position.clone().sub(node('shoulder-rear').position).normalize();
const shoulderToGround = groundTarget.clone().sub(node('shoulder-rear').position).normalize();
assert(pointedAtGround.angleTo(shoulderToGround) < 0.01,
  'a nearby surface target should aim from the shoulder at that point instead of reusing the camera ray');

const heldLeft = new THREE.Vector3(-0.2, 0.15, 1).normalize();
const heldRight = new THREE.Vector3(0.25, 0.1, 1).normalize();
rider.pose({ ...input(0, 0), pointTargets: [
  { hand: 'left', direction: heldLeft, weight: 1 },
  { hand: 'right', direction: heldRight, weight: 1 },
] });
const pointedLeft = node('hand-rear').position.clone().sub(node('shoulder-rear').position).normalize();
const pointedRight = node('hand-front').position.clone().sub(node('shoulder-front').position).normalize();
assert(pointedLeft.angleTo(heldLeft) < 0.01 && pointedRight.angleTo(heldRight) < 0.01,
  'simultaneous mouse holds should extend both anatomical arms at once');

const trackedPosition = new THREE.Vector3(1, 2, 3);
rider.pose({ ...input(0, 0), headTarget: {
  position: trackedPosition, quaternion: lookQ, exactPosition: true,
} });
rider.group.updateMatrixWorld(true);
const trackedEyeCentre = node('eye-left').getWorldPosition(new THREE.Vector3())
  .add(node('eye-right').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
assert(trackedEyeCentre.distanceTo(trackedPosition) < 1e-6,
  'a tracked WebXR viewpoint should land exactly between the avatar’s eyes');
assert(node('head').position.distanceTo(trackedPosition) > 0.1,
  'the headset viewpoint should not be mistaken for the avatar’s helmet centre');

// Tracked wrist orientation, not the arm chord, owns the visible glove/palm rotation. Targets are kept at the
// current solved hands so this isolates rotation from the already-covered arm-position IK.
const trackedFrontQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, -0.4, 1.1));
const trackedRearQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0.65, -0.75));
const trackedFrontPosition = node('hand-front').position.clone();
const trackedRearPosition = node('hand-rear').position.clone();
rider.pose({ ...input(0, 0), handTargets: {
  a: { position: trackedFrontPosition, quaternion: trackedFrontQ },
  b: { position: trackedRearPosition, quaternion: trackedRearQ },
} });
for (const [name, expected] of [['hand-front', trackedFrontQ], ['hand-rear', trackedRearQ]] as const) {
  const actual = node(name).quaternion;
  const actualFinger = new THREE.Vector3(0, 1, 0).applyQuaternion(actual);
  const actualPalm = new THREE.Vector3(0, 0, 1).applyQuaternion(actual);
  const expectedFinger = new THREE.Vector3(0, 1, 0).applyQuaternion(expected);
  const expectedPalm = new THREE.Vector3(0, 0, 1).applyQuaternion(expected);
  assert(actualFinger.angleTo(expectedFinger) < 1e-6,
    `${name} should point its fingers with the tracked wrist`);
  assert(actualPalm.angleTo(expectedPalm) < 1e-6,
    `${name} should roll its visible palm with the tracked wrist`);
}

rider.pose(input(0, 0));
const standingHeadY = node('head').position.y;
rider.pose({ ...input(0, 0), crouch: 1 });
assert(node('head').position.y < standingHeadY - 0.2,
  'Ctrl crouch should visibly lower the on-foot body and head');
assert(node('knee-front').position.y < node('hip-front').position.y - 0.1
  && node('knee-rear').position.y < node('hip-rear').position.y - 0.1,
  'the crouched body should retain bent, anatomical legs');

// A stationary head gets one independent 30-degree cone. Crossing it turns the body all the way to the new
// gaze and resets the cone, so a second small look remains head-only until it crosses 30 degrees in turn.
const turn = new OnFootFacing();
const bodyQ = new THREE.Quaternion();
const headAt = (degrees: number) => new THREE.Quaternion().setFromUnitVectors(
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(Math.sin(THREE.MathUtils.degToRad(degrees)), 0,
    Math.cos(THREE.MathUtils.degToRad(degrees))),
);
const facingDegrees = () => THREE.MathUtils.radToDeg(Math.atan2(turn.facing.x, turn.facing.z));
turn.step(1 / 60, bodyQ, headAt(0), 0);
turn.step(1, bodyQ, headAt(29), 0);
assert(Math.abs(facingDegrees()) < 1e-5, 'a 29-degree stationary look should not move the torso');
assert.equal(turn.turnDelta, 0, 'head-only look should not request a foot pivot');
turn.step(0.1, bodyQ, headAt(31), 0);
assert(facingDegrees() > 10 && facingDegrees() < 31,
  'crossing 30 degrees should begin a bounded turn-in-place rather than snap');
assert(turn.turnDelta > 0, 'a right body catch-up should expose a rightward foot-pivot delta');
for (let i = 0; i < 20; i++) turn.step(1 / 60, bodyQ, headAt(31), 0);
assert(Math.abs(facingDegrees() - 31) < 1e-5, 'the torso should finish on the new gaze heading');
turn.step(1, bodyQ, headAt(59), 0);
assert(Math.abs(facingDegrees() - 31) < 1e-5,
  'after resetting, another sub-30-degree look should remain head-only');
turn.step(0.1, bodyQ, headAt(63), 0);
assert(facingDegrees() > 31, 'a second look beyond the reset cone should turn the torso again');
turn.step(1 / 60, bodyQ, headAt(63), 2);
assert(Math.abs(facingDegrees()) < 1e-5, 'walking should reset the cone to the transmitted body heading');

rider.dispose();
console.log('ON-FOOT POSE: PASS');
