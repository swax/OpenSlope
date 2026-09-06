// tier: fast

// Flips: W and S held in the AIR somersault the deck forward over the nose or backward over the tail (docs/016).
//
// The flip is a rotation of the DRAWN deck and the rider bolted to it, not a rotational degree of freedom in the
// contact model — `boardUp` stays the contact-chased basis the pre-landing alignment is steering, so a rider can
// go all the way over without the model losing track of where the snow is. The one place it reaches the physics
// is the touchdown tilt band, where an unfinished rotation is priced as exactly what it is: a rider that many
// degrees off their own base. What these checks pin down is that a completed flip costs nothing, an unfinished
// one costs the band, the deck rocks back onto its base afterwards rather than riding on inverted, and the two
// keys still tuck and brake on the ground.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SURFACE_ROWS, createRideModel, groundRestDepth } from '../src/app/ride/physics';
import { createRiderPose, FLIP_PIVOT_RISE } from '../src/app/ride/pose';
import { AIR_TURN_RATE, CROUCH_AIR, FLIP_RECOVER_RATE, LAND_TILT_SCALE } from '../src/app/ride/physics-tuning';

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };
const SNOW = SURFACE_ROWS[1];
const PER_TICK = AIR_TURN_RATE / 60; // 4.5° of rotation a physics tick

function floorAt(y = 0, extent = 600): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -extent, y, -extent, -extent, y, extent, extent, y, -extent,
    extent, y, -extent, -extent, y, extent, extent, y, extent,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function ride(drive?: number) {
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, oobFloorY: -100, keys, stick, drive, onRespawn: () => {},
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SNOW), 0);
  model.st.vel.set(0, 0, 0);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  return model;
}

/** Drop a rider onto the floor already `flip` degrees through a rotation; report the landing's speed cost. */
function landWith(flip: number, height = 3) {
  const model = ride(0); // no cruise drive: the only thing moving the speed is the landing itself
  model.st.pos.set(0, height, 0);
  model.st.vel.set(0, 0, 14);
  model.st.grounded = false;
  model.st.flip = flip;
  let airborne = 0;
  for (let i = 0; i < 600 && !model.st.grounded; i++) {
    airborne = Math.hypot(model.st.vel.x, model.st.vel.z);
    model.step(1 / 60);
  }
  assert.ok(model.st.grounded, 'the drop lands');
  return { model, kept: Math.hypot(model.st.vel.x, model.st.vel.z) / airborne };
}

const clearKeys = () => { keys.left = keys.right = keys.tuck = keys.brake = keys.boost = false; };

// ---------------------------------------------------------------------------------------------------------
// The control: held in the air, W turns the deck forward over the nose and S backward over the tail, both at the
// spin's own rate — [Trailmap: 340] rotates every axis alike, so a flip is not a second tuning knob.
{
  const model = ride(0);
  model.st.pos.set(0, 60, 0);
  model.st.vel.set(0, 0, 12);
  model.st.grounded = false;

  keys.tuck = true;
  for (let i = 0; i < 40; i++) model.step(1 / 60);
  clearKeys();
  assert.ok(!model.st.grounded, 'the rotation runs entirely in the air');
  assert.ok(Math.abs(model.st.flip - 40 * PER_TICK) < 1e-6,
    `holding W turns the deck forward at ${AIR_TURN_RATE}°/s (got ${model.st.flip.toFixed(1)}° in 40 ticks)`);
  assert.ok(Math.abs(model.st.flip - 180) < 1e-6, 'which is a half rotation in two thirds of a second');

  const forward = model.st.flip;
  keys.brake = true;
  for (let i = 0; i < 40; i++) model.step(1 / 60);
  clearKeys();
  assert.ok(Math.abs(model.st.flip) < 1e-6, 'and S turns it back the other way, at the same rate');

  for (let i = 0; i < 40; i++) model.step(1 / 60);
  assert.ok(Math.abs(model.st.flip) < 1e-6, 'released, the rotation stops — a flip is held, not thrown');
  assert.ok(forward > 0, 'forward is the positive direction (over the nose)');
}

// On the ground the same two keys are still only the tuck and the brake. The flip costs no key and no mode
// precisely because neither of them has ever reached the air update.
{
  const model = ride();
  model.st.vel.set(0, 0, 12);
  keys.tuck = true;
  for (let i = 0; i < 30; i++) model.step(1 / 60);
  assert.equal(model.st.flip, 0, 'W on the snow is a tuck, not a somersault');
  clearKeys();

  const braking = ride(0);
  braking.st.vel.set(0, 0, 12);
  keys.brake = true;
  for (let i = 0; i < 30; i++) braking.step(1 / 60);
  clearKeys();
  assert.equal(braking.st.flip, 0, 'and S on the snow is still the brake...');
  assert.ok(braking.st.vel.length() < 12, '...which still scrubs speed');
}

// ---------------------------------------------------------------------------------------------------------
// Landing one. A completed rotation is back on its base and costs exactly what landing without one costs; an
// unfinished one is a rider off their base by that much, and pays the touchdown tilt band for it.
{
  const flat = landWith(0);
  const whole = landWith(360);
  const three = landWith(-1080);
  const quarter = landWith(90);

  assert.ok(Math.abs(whole.kept - flat.kept) < 1e-9,
    `a completed flip lands exactly as a straight air does (${whole.kept.toFixed(4)} vs ${flat.kept.toFixed(4)})`);
  assert.ok(Math.abs(three.kept - flat.kept) < 1e-9, 'and so do three of them the other way');
  assert.ok(quarter.kept < flat.kept * 0.9,
    `a quarter short of one pays the tilt band (kept ${quarter.kept.toFixed(3)} of its speed)`);
  assert.ok(Math.abs(quarter.kept / flat.kept - LAND_TILT_SCALE) < 0.02,
    'and 90° off the base is past the band\'s 50° clamp, so it pays the whole of it');
}

// ---------------------------------------------------------------------------------------------------------
// ...and then the rider gets up. The residual rocks back onto the NEAREST whole rotation — not to zero, which
// would take the long way round from 350° — so the value stays continuous for the render lerp and the deck is
// level again within a fraction of a second. Riding on visibly inverted is a second punishment for one landing.
{
  const short = landWith(90);
  const ticks = Math.ceil((90 / FLIP_RECOVER_RATE) * 60) + 1;
  for (let i = 0; i < ticks; i++) short.model.step(1 / 60);
  assert.equal(short.model.st.flip, 0, `an under-rotation rocks back to level in ${ticks} ticks`);

  const over = landWith(350);
  assert.ok(over.model.st.flip > 350, 'a rotation all but finished is carried FORWARD to whole, not unwound');
  for (let i = 0; i < 20; i++) over.model.step(1 / 60);
  assert.equal(over.model.st.flip, 360, 'and settles exactly on it, which draws as level');
}

// ---------------------------------------------------------------------------------------------------------
// The drawn deck, which is the whole point: the rotation has to actually take the board over, and take it over
// the way the key says. A quarter turn forward puts the nose at the snow and the deck's own up down the hill.
{
  // The rider's calm-riding glance draws its timing from Math.random, and this fixture cruises at 12 m/s on
  // the ground for the switch-landing recovery at the end of the block: calm by the glance's own definition,
  // so about one run in ten had the face turned toward the mountain on the final frame. Pin the draws for the
  // whole block (the wait is drawn when the rider is created and again on each fresh pose) the way
  // rider-pose.test.ts does; the production capped-exponential path still runs, it just stops being a coin flip.
  const nativeRandom = Math.random;
  Math.random = () => 0.5;
  const scene = new THREE.Group();
  const pose = createRiderPose({ scene });
  const model = ride(0);
  const st = model.st;
  st.grounded = false;
  st.boardUp.set(0, 1, 0);
  st.fwd.set(0, 0, 1);
  st.vel.set(0, 0, 12);

  const deckUp = new THREE.Vector3(), nose = new THREE.Vector3();
  const draw = () => {
    pose.update(st, 0, { tuck: false, brake: false }); // dt 0: nothing eases, so this frame IS the state
    deckUp.set(0, 1, 0).applyQuaternion(pose.board.quaternion);
    nose.set(0, 0, 1).applyQuaternion(pose.board.quaternion);
  };

  st.flip = 0;
  draw();
  assert.ok(deckUp.y > 0.99, 'level: the deck stands on its base');
  const goofyFace = pose.rider.solved.toe.clone();
  assert.ok(goofyFace.x > 0.99, 'goofy keeps the original left-facing snowboard body');
  assert.ok(pose.rider.solved.headForward.z > 0.99, 'goofy keeps its face looking downhill');
  pose.setSnowboardStance('standard');
  draw();
  assert.ok(pose.rider.solved.toe.x < -0.99, 'standard mirrors the snowboard body to face right');
  assert.ok(pose.rider.solved.headForward.z > 0.99,
    'standard changes the body side without turning the face away from downhill');
  pose.setSnowboardStance('goofy');
  draw();

  // W/S are posture only while ground/rail owns the rider. In the air the shared holds rotate the full character;
  // their old tuck/brake pose must not layer on top of that trick (the neutral automatic air crouch still does).
  st.crouch = 0;
  pose.update(st, 1, { tuck: true, brake: false });
  assert.equal(st.crouch, CROUCH_AIR, 'airborne forward input is flip-only, not a full tuck');
  st.grounded = true;
  st.crouch = 0;
  pose.update(st, 1, { tuck: true, brake: false });
  assert.equal(st.crouch, 1, 'the same forward input remains a full tuck on ground/rail');
  st.grounded = false;
  st.crouch = 0;

  st.flip = 90;
  draw();
  assert.ok(nose.y < -0.99, 'a quarter forward puts the nose straight down');
  assert.ok(deckUp.z > 0.99, 'and the deck up out along the travel — the rider is going over the front');

  st.flip = 180;
  draw();
  assert.ok(deckUp.y < -0.99, 'a half turn is fully inverted');

  st.flip = 360;
  draw();
  assert.ok(deckUp.y > 0.99, 'and a whole one is back on its base');

  // The somersault's fixed point is the WAIST, not the bindings: `board.position + deckUp·FLIP_PIVOT_RISE`
  // must not move through the rotation — the deck orbits the body's centre, never the other way round — and a
  // whole rotation reseats the deck exactly where the physics put it. Pivoting at the seat instead reads as
  // the rider being thrown in a circle around their own feet.
  const waist = new THREE.Vector3(), waist0 = new THREE.Vector3(), seat0 = new THREE.Vector3();
  st.flip = 0;
  draw();
  seat0.copy(pose.board.position);
  waist0.copy(pose.board.position).addScaledVector(deckUp, FLIP_PIVOT_RISE);
  for (const angle of [90, 180, 270, 360]) {
    st.flip = angle;
    draw();
    waist.copy(pose.board.position).addScaledVector(deckUp, FLIP_PIVOT_RISE);
    assert.ok(waist.distanceTo(waist0) < 1e-9,
      `${angle}°: the waist stays the rotation's fixed point (moved ${waist.distanceTo(waist0).toFixed(4)} m)`);
  }
  assert.ok(pose.board.position.distanceTo(seat0) < 1e-9,
    'a whole rotation puts the deck back exactly on the physics seat');
  st.flip = 180;
  draw();
  assert.ok(Math.abs(pose.board.position.y - (seat0.y + 2 * FLIP_PIVOT_RISE)) < 1e-9,
    'half-way over, the deck hangs a body above the arc the waist is riding');

  // Riding switch, the deck points backwards — so the flip is signed in the RIDDEN frame like the bank is, and
  // W throws the rider forward along their travel either way. Without that, a switch rider's W back-flips them.
  st.flip = 90;
  st.fwd.set(0, 0, -1);
  st.lead = -1;
  draw();
  assert.ok(deckUp.z > 0.99, 'switch: W still takes the rider over forwards, down the hill they are riding');
  st.flip = 0;
  draw();
  st.grounded = true;
  for (let frame = 0; frame < 60; frame++) {
    pose.update(st, 1 / 60, { tuck: false, brake: false });
  }
  assert.ok(pose.rider.solved.headForward.z > 0.95,
    'after a switch landing the shoulders and face settle onto the ridden tail downhill, not the nose uphill');

  Math.random = nativeRandom;
  pose.dispose();
}

clearKeys();
console.log('FLIP RIDE TESTS PASSED');
