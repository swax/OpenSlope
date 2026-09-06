// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRider, type RiderInput } from '../src/app/ride/rider';
import { ridingStyleOptions } from '../src/app/ride/stances';

/**
 * Which way a resting palm faces.
 *
 * `handFrontPalm` / `handRearPalm` are the direction the palm FACES, and they drive both the procedural
 * gloves and — through the character rig's hand retargeting — every skinned avatar's wrists. They used to be
 * handed the body's UP axis, which is the same vector pointing the wrong way, so every character rode and
 * walked with its palms turned to the sky. Nobody stands like that.
 *
 * What is asserted is the resting case only. A tracked VR wrist owns its own orientation and must keep it,
 * which is the last check here: a rider whose real palm is up should have an avatar whose palm is up.
 */

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const facing = new THREE.Vector3(0, 0, 1);

const board = (over: Partial<RiderInput> = {}): RiderInput => ({
  ankleFront: new THREE.Vector3(0, 0, 0.27),
  ankleRear: new THREE.Vector3(0, 0, -0.27),
  deckUp: new THREE.Vector3(0, 1, 0), soleUp: new THREE.Vector3(0, 1, 0),
  bank: 0, vel: new THREE.Vector3(), accel: new THREE.Vector3(),
  grounded: true, dt: 1 / 60, crouch: 0, lean: 0, ...over,
});
const onFoot = (phase: number, weight: number, speed = 0): RiderInput => ({
  ...board(),
  ankleFront: new THREE.Vector3(0, 0.144, 0.27),
  ankleRear: new THREE.Vector3(0, 0.144, -0.27),
  vel: new THREE.Vector3(0, 0, speed),
  locomotion: { phase, weight, facing, turn: 0 },
});

const settle = (rider: ReturnType<typeof createRider>, input: RiderInput) => {
  for (let frame = 0; frame < 90; frame++) rider.pose(input);
};

/** Both palms, as (facing direction, the hand it belongs to, the body midline beside it). */
function palms(rider: ReturnType<typeof createRider>) {
  const p = rider.solved;
  return [
    { what: 'front', palm: p.handFrontPalm, hand: p.handFront, midline: p.clavicleRoot },
    { what: 'rear', palm: p.handRearPalm, hand: p.handRear, midline: p.clavicleRoot },
  ];
}

/* ── On the board ──────────────────────────────────────────────────────────────────────────────────────
 * Hands carried out for balance: these rest palm-down, in every style and on both edges.
 */
for (const style of ridingStyleOptions()) {
  const rider = createRider();
  rider.setStyle(style.id);
  for (const [stance, over] of [
    ['neutral', {}],
    ['crouched', { crouch: 1 }],
    ['toe carve', { bank: 0.6, vel: new THREE.Vector3(0, 0, 14), accel: new THREE.Vector3(9, 0, 0) }],
    ['heel carve', { bank: -0.6, vel: new THREE.Vector3(0, 0, 14), accel: new THREE.Vector3(-9, 0, 0) }],
    ['airborne', { grounded: false, vel: new THREE.Vector3(0, 4, 14) }],
  ] as [string, Partial<RiderInput>][]) {
    settle(rider, board(over));
    for (const { what, palm } of palms(rider)) {
      const vertical = palm.dot(WORLD_UP);
      assert(vertical < -0.15,
        `${style.id} ${stance} ${what}: the palm faces ${vertical > 0 ? 'UP' : 'sideways'} `
        + `(up ${vertical.toFixed(2)}) — a carried hand rests palm-down`);
      assert(Math.abs(palm.length() - 1) < 1e-6, `${style.id} ${stance} ${what}: the palm normal is a unit`);
    }
  }
  rider.dispose();
}

/* ── On foot ───────────────────────────────────────────────────────────────────────────────────────────
 * Standing, the arms hang, and "down" is then along the forearm rather than out of the palm — so the answer
 * that matters is the sideways one: a relaxed palm faces the thigh. Never up, in any gait.
 */
const walker = createRider();
for (const [gait, input] of [
  ['standing', onFoot(0, 0)],
  ['walking', onFoot(0.3, 1, 1.6)],
  ['running', onFoot(0.7, 1, 4.2)],
] as [string, RiderInput][]) {
  settle(walker, input);
  for (const { what, palm } of palms(walker)) {
    assert(palm.dot(WORLD_UP) < 0, `on foot ${gait} ${what}: the palm still faces up`);
  }
}

// Standing specifically: hanging arms turn their palms INWARD, toward the body, rather than outward.
settle(walker, onFoot(0, 0));
for (const { what, palm, hand, midline } of palms(walker)) {
  const inward = new THREE.Vector3().subVectors(midline, hand);
  inward.addScaledVector(WORLD_UP, -inward.dot(WORLD_UP));
  assert(inward.lengthSq() > 1e-6, `${what} hand hangs off the midline`);
  assert(palm.dot(inward.normalize()) > 0.2,
    `on foot standing ${what}: a hanging palm faces the body, not away from it `
    + `(inward ${palm.dot(inward).toFixed(2)})`);
}
walker.dispose();

/* ── Tracked hands are not overridden ────────────────────────────────────────────────────────────────── */
{
  const rider = createRider();
  // Palms deliberately turned UP, the pose the resting rule exists to prevent. A tracked wrist still wins:
  // the avatar's hand belongs to the rider wearing the headset, not to the stance model.
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), WORLD_UP);
  const target = () => ({ position: new THREE.Vector3(0.3, 1.1, 0.2), quaternion: quaternion.clone() });
  settle(rider, board({ handTargets: { a: target(), b: target() } }));
  for (const { what, palm } of palms(rider)) {
    assert(palm.dot(WORLD_UP) > 0.9,
      `${what}: a tracked wrist keeps its own palm direction (up ${palm.dot(WORLD_UP).toFixed(2)})`);
  }
  rider.dispose();
}

console.log('PALM FACING: PASS');
