// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportBlockyRiderGlb } from '../tools/character-models/blocky-rider';
import { createCharacterDriver } from '../src/app/ride/character-rig';
import { createRider, type RiderInput } from '../src/app/ride/rider';

/**
 * A tracked hand is the wearer's controller, and the wearer can see both it and the glove that is meant to be
 * on it. The imported skeleton copies the landmark solver's bone DIRECTIONS, which lands its hand wherever its
 * own proportions put it — exactly right only while its shoulder happens to coincide with the landmark
 * shoulder, and the tracked torso (spanned hips-to-skull afresh each frame, against a spine that keeps its
 * bind lengths) moves that by up to 7 cm as the wearer crouches. So a tracked arm is re-solved from the imported
 * shoulder with the imported bone lengths (`character-rig.ts`, `poseArm`). This measures the hand bone against
 * its controller on the generated built-in, and confirms nothing was rescaled to get it there.
 */

const glb = await exportBlockyRiderGlb();
const gltf = await new GLTFLoader().parseAsync(
  glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '');
const root = gltf.scene as THREE.Group;
root.updateMatrixWorld(true);
const bone = (name: string): THREE.Bone => {
  const found = root.getObjectByName(name) ?? root.getObjectByName(name.replace('.', ''));
  assert(found instanceof THREE.Bone, `the driver can resolve ${name}`);
  return found;
};
const at = (name: string) => bone(name).getWorldPosition(new THREE.Vector3());
const restUpper = at('UpperArm.L').distanceTo(at('LowerArm.L'));
const restFore = at('LowerArm.L').distanceTo(at('Hand.L'));
const driver = createCharacterDriver(root);

const neutral: RiderInput = {
  ankleFront: new THREE.Vector3(0, 0, 0.27),
  ankleRear: new THREE.Vector3(0, 0, -0.27),
  deckUp: new THREE.Vector3(0, 1, 0),
  soleUp: new THREE.Vector3(0, 1, 0),
  bank: 0,
  vel: new THREE.Vector3(),
  accel: new THREE.Vector3(),
  grounded: true,
  dt: 1 / 60,
  crouch: 0,
  lean: 0,
};
const rider = createRider('procedural');
rider.reset(neutral);
rider.group.updateMatrixWorld(true);
const eyeOf = (name: string) => rider.group.getObjectByName(`rider.${name}`)!.getWorldPosition(new THREE.Vector3());
const eye = eyeOf('eye-left').add(eyeOf('eye-right')).multiplyScalar(0.5);
const look = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // a viewer faces +Z
const tracked = (headDrop: number): RiderInput => ({
  ...neutral,
  headTarget: { position: eye.clone().add(new THREE.Vector3(0, -headDrop, 0)), quaternion: look, exactPosition: true },
});
const ctl = (a: THREE.Vector3, b: THREE.Vector3) => ({
  a: { position: a, quaternion: new THREE.Quaternion() },
  b: { position: b, quaternion: new THREE.Quaternion() },
});
rider.reset(tracked(0));
const shF = rider.solved.shoulderFront.clone(), shR = rider.solved.shoulderRear.clone();

function skinnedHands(): THREE.Vector3[] {
  driver.pose(rider.solved);
  return [at('Hand.L'), at('Hand.R')];
}
const nearest = (target: THREE.Vector3, hands: THREE.Vector3[]) =>
  Math.min(...hands.map(hand => hand.distanceTo(target)));

// Crouched a quarter metre, the landmark shoulder is ~7 cm from the imported one. The tracked hand bones must
// still land on their controllers, on the board and on foot, and the arm must still measure what it did at bind.
for (const [label, input] of [
  ['upright', tracked(0)],
  ['crouched 25 cm', tracked(0.25)],
  ['leaning 15 cm', { ...tracked(0), headTarget: { ...tracked(0).headTarget!, position: eye.clone().add(new THREE.Vector3(0, 0, 0.15)) } }],
] as const) {
  const a = shF.clone().add(new THREE.Vector3(0, -0.2, 0.3)), b = shR.clone().add(new THREE.Vector3(0, -0.2, 0.3));
  rider.pose({ ...input, handTargets: ctl(a, b) });
  const hands = skinnedHands();
  assert(nearest(a, hands) < 5e-3 && nearest(b, hands) < 5e-3,
    `${label}: tracked hand bones land on their controllers (${(nearest(a, hands) * 100).toFixed(1)} / ${(nearest(b, hands) * 100).toFixed(1)} cm off)`);
  assert(Math.abs(at('UpperArm.L').distanceTo(at('LowerArm.L')) - restUpper) < 1e-6
    && Math.abs(at('LowerArm.L').distanceTo(at('Hand.L')) - restFore) < 1e-6,
    `${label}: the re-solve writes rotations only, so the imported arm keeps its bind lengths`);
}

// On foot the imported shoulder is 3 cm from the landmark's even standing straight.
const footTracked: RiderInput = {
  ...neutral, ankleFront: new THREE.Vector3(0.105, 0, 0), ankleRear: new THREE.Vector3(-0.105, 0, 0),
  locomotion: { phase: 0, weight: 0, facing: new THREE.Vector3(0, 0, 1) },
  headTarget: { position: eye.clone().add(new THREE.Vector3(0, -0.1, 0)), quaternion: look, exactPosition: true },
};
rider.reset(footTracked);
{
  const a = rider.solved.shoulderFront.clone().add(new THREE.Vector3(0, -0.2, 0.3));
  const b = rider.solved.shoulderRear.clone().add(new THREE.Vector3(0, -0.2, 0.3));
  rider.pose({ ...footTracked, handTargets: ctl(a, b) });
  const hands = skinnedHands();
  assert(nearest(a, hands) < 5e-3 && nearest(b, hands) < 5e-3, 'on foot the tracked hand bones land on their controllers');
}

// Past full extension the arm straightens toward the controller and falls short along the line to it, exactly
// as the landmark solver's own arm does; it never stretches to get there.
rider.reset(tracked(0));
{
  const far = shF.clone().add(new THREE.Vector3(0, -0.1, 0.75));
  const b = shR.clone().add(new THREE.Vector3(0, -0.2, 0.3));
  rider.pose({ ...tracked(0), handTargets: ctl(far, b) });
  const hands = skinnedHands();
  const side = hands[0].distanceTo(far) < hands[1].distanceTo(far) ? 'L' : 'R';
  const shoulder = at(`UpperArm.${side}`), hand = at(`Hand.${side}`);
  assert(Math.abs(shoulder.distanceTo(hand) - (restUpper + restFore)) < 0.01,
    'an unreachable controller straightens the imported arm without stretching it');
  const toHand = hand.clone().sub(shoulder).normalize(), toTarget = far.clone().sub(shoulder).normalize();
  assert(toHand.angleTo(toTarget) < 3 * Math.PI / 180, 'the straightened arm points at the controller');
}

console.log('TRACKED ARM RETARGET: PASS');
