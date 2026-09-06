// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { axialTwist, createCharacterDriver } from '../src/app/ride/character-rig';
import { createRider, type RiderInput } from '../src/app/ride/rider';
import { ridingStyleOptions } from '../src/app/ride/stances';
import { buildAlpineExo } from '../tools/character-models/alpine-exo';

/**
 * How much twist any one arm joint is asked to absorb.
 *
 * A rider's hands are almost never in the orientation their bind pose left them, so between the arm's
 * neutral roll and the tracked palm there is routinely 120 degrees or more of pronation. Whichever joint
 * takes that alone is the one that pinches: the elbow's vertices are blended between the upper arm and the
 * forearm, and wrapping them around their own axis collapses them into the candy-wrapper every skinned arm
 * is prone to. It was all landing on the elbow — 100 to 177 degrees there against 1 at the wrist — which is
 * exactly what a pinched, sausage-twisted elbow looks like.
 *
 * The driver now shares it, so this measures the sharing rather than trusting it. It runs against every
 * riding style and a spread of stances, because the pronation is a property of where a style carries the
 * hands and a new one must not be able to reintroduce the collapse.
 */

/** Comfortably inside what linear blend skinning handles without visible collapse. */
const JOINT_LIMIT_DEG = 75;

const base: RiderInput = {
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

const STANCES: [string, Partial<RiderInput>][] = [
  ['neutral', {}],
  ['crouched', { crouch: 1 }],
  ['toe carve', { bank: 0.6, vel: new THREE.Vector3(0, 0, 14), accel: new THREE.Vector3(9, 0, 0) }],
  ['heel carve', { bank: -0.6, vel: new THREE.Vector3(0, 0, 14), accel: new THREE.Vector3(-9, 0, 0) }],
  ['airborne', { grounded: false, vel: new THREE.Vector3(0, 4, 14) }],
];

/* ── The measure itself ────────────────────────────────────────────────────────────────────────────── */

const axis = new THREE.Vector3(0, 1, 0);
assert.equal(axialTwist(axis, new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 1)), 0);
// Signed, so a check can tell "shared out" from "cancelled by going the other way".
assert(Math.abs(axialTwist(axis, new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)) - Math.PI / 2) < 1e-9);
assert(Math.abs(axialTwist(axis, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)) + Math.PI / 2) < 1e-9);
// Whatever either vector does ALONG the axis is not twist and must not register as any.
assert(Math.abs(axialTwist(axis, new THREE.Vector3(0, 5, 1), new THREE.Vector3(0, -3, 1))) < 1e-9);
assert.equal(axialTwist(axis, new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)), 0,
  'a reference with nothing perpendicular to the axis has no measurable twist');

/* ── The arms, driven ──────────────────────────────────────────────────────────────────────────────── */

const figure = buildAlpineExo();
figure.updateMatrixWorld(true);
const driver = createCharacterDriver(figure);
const bones = new Map<string, THREE.Bone>();
figure.traverse(object => { if (object instanceof THREE.Bone) bones.set(object.name, object); });

const roll = (name: string) =>
  new THREE.Vector3(0, 0, 1).applyQuaternion(bones.get(name)!.getWorldQuaternion(new THREE.Quaternion()));
const boneAxis = (name: string) =>
  new THREE.Vector3(0, 1, 0).applyQuaternion(bones.get(name)!.getWorldQuaternion(new THREE.Quaternion()));
const degrees = (radians: number) => (radians * 180) / Math.PI;

let worstElbow = 0, worstWrist = 0;
for (const style of ridingStyleOptions()) {
  const rider = createRider();
  rider.setStyle(style.id);
  for (const [stance, override] of STANCES) {
    const input = { ...base, ...override };
    // Long enough for the absorber, the arm sway and the style cross to settle: a twist measured mid-blend
    // would be measuring the transition rather than the stance.
    for (let frame = 0; frame < 90; frame++) rider.pose(input);
    driver.pose(rider.solved);
    figure.updateMatrixWorld(true);

    for (const side of ['L', 'R'] as const) {
      const where = `${style.id} ${stance} ${side}`;
      const elbow = Math.abs(degrees(axialTwist(boneAxis(`LowerArm.${side}`),
        roll(`UpperArm.${side}`), roll(`LowerArm.${side}`))));
      const wrist = Math.abs(degrees(axialTwist(boneAxis(`Hand.${side}`),
        roll(`LowerArm.${side}`), roll(`Hand.${side}`))));
      assert(Number.isFinite(elbow) && Number.isFinite(wrist), `${where}: twist is a number`);
      assert(elbow < JOINT_LIMIT_DEG, `${where}: elbow twists ${elbow.toFixed(0)}°, over ${JOINT_LIMIT_DEG}°`);
      assert(wrist < JOINT_LIMIT_DEG, `${where}: wrist twists ${wrist.toFixed(0)}°, over ${JOINT_LIMIT_DEG}°`);
      // The failure being defended against is not "some twist" but "all of it in one place". A forearm given
      // the hand's whole delta reads 130° at the elbow against 1° at the wrist; sharing keeps them in step.
      assert(elbow < wrist + 20,
        `${where}: the elbow carries ${elbow.toFixed(0)}° against the wrist's ${wrist.toFixed(0)}° — `
        + 'the pronation is being dumped at the elbow rather than shared along the arm');
      worstElbow = Math.max(worstElbow, elbow);
      worstWrist = Math.max(worstWrist, wrist);
    }
  }
  rider.dispose();
}

console.log(`ARM TWIST: PASS (worst elbow ${worstElbow.toFixed(0)}°, worst wrist ${worstWrist.toFixed(0)}°)`);
