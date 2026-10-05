// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRideModel, groundRestDepth, SURFACE_ROWS } from '../src/app/ride/physics';
import { HEAD_LEAN_FULL_ANGLE, HEAD_LOOK_DEADZONE, STEER_SIGN } from '../src/app/ride/physics-tuning';

const UP = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

function riding(surface: number, lead: 1 | -1, grade: number, stick: { active: boolean; x: number },
  gaze?: () => THREE.Vector3 | null) {
  const normal = UP.clone().applyAxisAngle(X, grade);
  const forward = new THREE.Vector3(0, 0, 1).applyAxisAngle(X, grade);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -2000, 0, -2000, -2000, 0, 2000, 2000, 0, -2000,
    2000, 0, -2000, -2000, 0, 2000, 2000, 0, 2000,
  ], 3));
  geometry.rotateX(grade);
  const terrain = new THREE.Mesh(geometry);
  terrain.updateMatrixWorld(true);
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: forward, terrain, surfaceOf: () => surface,
    oobFloorY: -1000, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
    stick, gaze, onRespawn: () => {},
  });
  model.start();
  model.st.pos.copy(normal).multiplyScalar(-groundRestDepth(SURFACE_ROWS[surface]));
  model.st.vel.copy(forward).multiplyScalar(16);
  model.st.fwd.copy(forward).multiplyScalar(lead);
  model.st.lead = lead;
  model.st.contactN.copy(normal);
  model.st.boardUp.copy(normal);
  model.st.grounded = true;
  return model;
}

// Equivalent head/stick commands must carve the same path and carry the same speed. Previously gaze both
// supplied lean AND replaced the yaw reference, turning the board farther across travel and scrubbing speed.
// Looking ahead of the current travel represents a rider continuing to look into a curve. Reverse the curve,
// then look straight along travel to release it; include banked contact and switch so the frame matters.
for (const surface of [1, 3, 5]) for (const lead of [1, -1] as const) {
  for (const grade of [0, Math.PI / 9]) for (const amount of [0.25, 0.5, 1]) {
    const controls = { active: true, x: 0 }, handsOff = { active: false, x: 0 };
    const desktop = riding(surface, lead, grade, controls);
    const look = new THREE.Vector3();
    let intent = 0;
    const head: ReturnType<typeof riding> = riding(surface, lead, grade, handsOff, () => {
      const n = head.st.contactN;
      look.copy(head.st.vel).addScaledVector(n, -head.st.vel.dot(n)).normalize();
      const angle = intent === 0 ? 0 : Math.sign(intent) * (HEAD_LOOK_DEADZONE + Math.abs(intent) * HEAD_LEAN_FULL_ANGLE);
      return look.applyAxisAngle(n, angle * Math.PI / 180);
    });
    let velocityError = 0, positionError = 0, headingError = 0;
    for (let tick = 0; tick < 180; tick++) {
      intent = tick < 60 ? amount : tick < 120 ? -amount : 0;
      controls.x = intent / STEER_SIGN;
      desktop.step(1 / 60);
      head.step(1 / 60);
      velocityError = Math.max(velocityError, head.st.vel.distanceTo(desktop.st.vel));
      positionError = Math.max(positionError, head.st.pos.distanceTo(desktop.st.pos));
      headingError = Math.max(headingError, head.st.fwd.distanceTo(desktop.st.fwd));
    }
    const label = `surface ${surface}, lead ${lead}, grade ${grade}, steer ${amount}`;
    assert.ok(velocityError < 1e-7, `head steering preserves desktop velocity (${label}: ${velocityError} m/s)`);
    assert.ok(positionError < 1e-7, `head steering follows the desktop curve (${label}: ${positionError} m)`);
    assert.ok(headingError < 1e-7, `head steering uses the desktop board alignment (${label}: ${headingError})`);
    assert.equal(head.st.seatYaw, 0, 'head steering never rotates the headset seat');
  }
}

// Manual VR steering owns the whole carve even if the rider looks elsewhere. Include a small, already-shaped
// stick value: XR's physical deadzone has already decided ownership before the physics receives the axis.
for (const amount of [0.02, 0.5, -0.5]) {
  const controls = { active: true, x: amount };
  const reference = riding(1, 1, 0, controls, () => null);
  const looked = riding(1, 1, 0, controls, () => new THREE.Vector3(1, 0, -1));
  for (let tick = 0; tick < 120; tick++) { reference.step(1 / 60); looked.step(1 / 60); }
  assert.ok(looked.st.vel.distanceTo(reference.st.vel) < 1e-9,
    `looking elsewhere cannot add a skid while manual steering owns the carve (${amount})`);
  assert.ok(looked.st.fwd.distanceTo(reference.st.fwd) < 1e-9, 'manual steering also owns board alignment');
  assert.equal(looked.st.seatYaw, reference.st.seatYaw, 'manual steering retains the same headset carry');
}

console.log('HEAD STEER TESTS PASSED');
