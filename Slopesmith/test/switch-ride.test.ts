// tier: fast

// Riding switch, and the air spin that puts a rider there (docs/016).
//
// The board is a symmetric plank and the air spin can leave it pointing either way, so "forwards" cannot be the
// drawn nose. `st.lead` says which END of the deck is leading the travel, and every travel-relative term — the
// carve frame, the cruise drive's gate, the brake, the boost, the touchdown yaw band — reads that instead. What
// the checks below pin down is the whole user-visible claim: a held A/D in the air turns the board around, the
// landing takes it rather than punishing it, the deck stays where the air left it, and the same key still carves
// the same way round afterwards. The failure they exist for is the old behaviour, where a landed 180 paid the
// full 0.75 yaw band, lost its cruise drive, and was then whipped back to face front over about half a second.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  D2R, SURFACE_ROWS, SWITCH_LATCH_SPEED, createRideModel, groundRestDepth,
} from '../src/app/ride/physics';
import { AIR_TURN_RATE } from '../src/app/ride/physics-tuning';

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };
const SNOW = SURFACE_ROWS[1];
const UP = new THREE.Vector3(0, 1, 0);

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

/** Drop a rider onto the floor from `height`, facing `facing`, travelling `velocity`. Returns the speed on the
 *  last airborne tick and on the first grounded one, which is where the touchdown bands are spent. */
function drop(facing: THREE.Vector3, velocity: THREE.Vector3, height = 3) {
  const model = ride(0); // no cruise drive: the only thing moving the speed is the landing itself
  model.st.pos.set(0, height, 0);
  model.st.vel.copy(velocity);
  model.st.fwd.copy(facing).normalize();
  model.st.grounded = false;
  let airborne = model.st.vel.length();
  for (let i = 0; i < 600 && !model.st.grounded; i++) {
    airborne = Math.hypot(model.st.vel.x, model.st.vel.z);
    model.step(1 / 60);
  }
  assert.ok(model.st.grounded, 'the drop lands');
  return { model, airborne, landed: Math.hypot(model.st.vel.x, model.st.vel.z) };
}

const clearKeys = () => { keys.left = keys.right = keys.tuck = keys.brake = keys.boost = false; };
/** Signed turn from one travel direction to another about world up: positive = one way, negative = the other. */
const turnOf = (from: THREE.Vector3, to: THREE.Vector3) =>
  new THREE.Vector3().crossVectors(from.clone().normalize(), to.clone().normalize()).dot(UP);

// ---------------------------------------------------------------------------------------------------------
// The flip itself: airborne, a held steer yaws the deck at the traced air spin rate, and 40 ticks of it is a
// half turn. Nothing else in the air touches the facing, so this is the control the rider actually has.
{
  const model = ride(0);
  model.st.pos.set(0, 40, 0);
  model.st.vel.set(0, 0, 12);
  model.st.grounded = false;
  const before = model.st.fwd.clone();
  keys.right = true;
  const half = Math.round(180 / (AIR_TURN_RATE / 60)); // ticks the spin rate needs for a 180
  for (let i = 0; i < half; i++) model.step(1 / 60);
  clearKeys();
  assert.ok(!model.st.grounded, 'the spin runs entirely in the air');
  const turned = Math.acos(Math.min(1, Math.max(-1, before.dot(model.st.fwd)))) / D2R;
  assert.ok(Math.abs(turned - 180) < 6, `a held steer turns the board 180° in ${half} ticks (got ${turned.toFixed(1)}°)`);
  assert.equal(model.st.lead, 1, 'the lead is not touched in the air — the landing is what commits it');
}

// ---------------------------------------------------------------------------------------------------------
// Landing that 180: the deck arrives backwards, and because the touchdown measures the yaw to whichever END is
// leading, it is a square landing and keeps its speed. The control is the same drop landed nose-first.
{
  const square = drop(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 14));
  const switched = drop(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 14));
  assert.equal(square.model.st.lead, 1, 'a nose-first landing stays regular');
  assert.equal(switched.model.st.lead, -1, 'a backwards landing commits the tail as the leading end');
  assert.ok(switched.landed > switched.airborne * 0.9,
    `landing switch keeps its speed (${switched.airborne.toFixed(2)} → ${switched.landed.toFixed(2)} m/s)`);
  assert.ok(Math.abs(switched.landed - square.landed) < 0.15,
    `and costs exactly what landing straight costs (${switched.landed.toFixed(2)} vs ${square.landed.toFixed(2)} m/s)`);
  assert.ok(switched.model.st.fwd.z < -0.9, 'the deck is still pointing the way the air left it');
}

// Sideways is still sideways: the nearer end of a 90° slap is 90° off whichever way it is read, so the yaw band
// bites in full. This is the half of the band that riding switch must not soften.
{
  const slapped = drop(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 14));
  assert.ok(slapped.landed < slapped.airborne * 0.85,
    `a 90° landing still pays the yaw band (${slapped.airborne.toFixed(2)} → ${slapped.landed.toFixed(2)} m/s)`);
}

// ---------------------------------------------------------------------------------------------------------
// The controls do not invert. A switch rider's deck points backwards, so a carve frame built off the drawn nose
// would send the same key round the other way — the rider presses left and the mountain turns right.
{
  const regular = ride();
  regular.st.vel.set(0, 0, 12);
  const switched = ride();
  switched.st.vel.set(0, 0, 12);
  switched.st.fwd.set(0, 0, -1);
  switched.st.lead = -1;

  const from = new THREE.Vector3(0, 0, 1);
  keys.left = true;
  for (let i = 0; i < 60; i++) { regular.step(1 / 60); switched.step(1 / 60); }
  clearKeys();

  const turnR = turnOf(from, regular.st.vel);
  const turnS = turnOf(from, switched.st.vel);
  assert.ok(Math.abs(turnR) > 0.05, `a second of held carve bends the line (turn ${turnR.toFixed(3)})`);
  assert.ok(Math.sign(turnR) === Math.sign(turnS),
    `the same key carves the same way regular or switch (regular ${turnR.toFixed(3)}, switch ${turnS.toFixed(3)})`);
  assert.ok(Math.abs(turnS - turnR) < Math.abs(turnR) * 0.25,
    'and with the same authority — switch is a lead, not a different board');
  assert.equal(switched.st.lead, -1, 'carving does not right the lead');
  assert.ok(switched.st.fwd.dot(switched.st.vel) < 0, 'the deck stays reversed against its own travel');
}

// ---------------------------------------------------------------------------------------------------------
// The handover is continuous. `lean`, `bank` and `carveSlide` are signed in the ridden frame, so they turn over
// with the lead — otherwise the rider keeps the same numbers in a frame that just reversed, which puts the edge
// on the other side of the world and snaps the drawn deck through 90° of roll in one frame, mid-skid.
{
  const model = ride();
  model.st.vel.set(0, 0, 12);
  keys.left = true;
  for (let i = 0; i < 30; i++) model.step(1 / 60);
  model.st.bank = model.st.lean * 50; // pose state the physics never writes; stand it in to watch it turn over
  const leanBefore = model.st.lean * model.st.lead;   // the lean as the WORLD sees it
  const bankBefore = model.st.bank * model.st.lead;   // ...and the roll the deck is drawn with
  const slideBefore = model.st.carveSlide * model.st.lead;
  assert.ok(Math.abs(leanBefore) > 0.5, 'the rider is genuinely on an edge before the handover');

  // Spun round: the travel is now 180° off the end that was leading (the carve above has moved the heading).
  model.st.vel.copy(model.st.fwd).multiplyScalar(-12 * model.st.lead);
  model.step(1 / 60);
  clearKeys();
  assert.equal(model.st.lead, -1, 'the travel takes the lead to the other end');
  assert.ok(Math.abs(model.st.lean * model.st.lead - leanBefore) < 0.2,
    `the world-frame lean survives the handover (${leanBefore.toFixed(3)} → ${(model.st.lean * model.st.lead).toFixed(3)})`);
  assert.ok(Math.abs(model.st.bank * model.st.lead - bankBefore) < 1e-9, 'and the drawn roll does not jump');
  assert.ok(Math.abs(model.st.carveSlide * model.st.lead - slideBefore) < 0.05,
    'and the deck does not hop across its own carve offset');
}

// ---------------------------------------------------------------------------------------------------------
// The lead latch is deaf to noise. Flat ground's contact buzz can manufacture about a metre per second of
// backwards creep out of float noise; handing THAT the switch lead would hand it the cruise drive too and ride
// the rider away backwards from a standstill they never left.
{
  const model = ride(0);
  model.st.vel.set(0, 0, -(SWITCH_LATCH_SPEED - 0.5));
  for (let i = 0; i < 60; i++) model.step(1 / 60);
  assert.equal(model.st.lead, 1, 'creeping backwards under the latch speed is not a lead change');
}

// ---------------------------------------------------------------------------------------------------------
// End to end, through the real inputs: ride, ollie, hold the steer for a half turn, land, and keep riding. The
// claim is that the run CONTINUES — a rider who lands switch rides the mountain down, they do not skid to a halt
// waiting for the board to come back round.
{
  const model = ride();
  model.st.vel.set(0, 0, 12);
  for (let i = 0; i < 30; i++) model.step(1 / 60);

  model.ollieDown();
  model.step(1 / 60);
  model.ollieUp();
  // The launch joins the velocity in the tick's tail, so the ground/air state it forces is read on the NEXT one.
  model.step(1 / 60);
  model.step(1 / 60);
  assert.ok(!model.st.grounded, 'the ollie leaves the ground');

  keys.right = true;
  for (let i = 0; i < Math.round(180 / (AIR_TURN_RATE / 60)); i++) model.step(1 / 60);
  clearKeys();
  for (let i = 0; i < 240 && !model.st.grounded; i++) model.step(1 / 60);
  assert.ok(model.st.grounded, 'and lands again');
  assert.equal(model.st.lead, -1, 'a half turn off an ollie lands switch');

  const heading = model.st.fwd.clone();
  for (let i = 0; i < 180; i++) model.step(1 / 60);
  assert.equal(model.st.lead, -1, 'three seconds later it is still switch: nothing rights it but another turn');
  assert.ok(heading.dot(model.st.fwd) > 0.9, 'and the deck was never whipped back round to face front');
  assert.ok(model.st.vel.length() > SNOW.target - 1,
    `the switch rider drives on at the surface's cruise target (got ${model.st.vel.length().toFixed(2)} m/s)`);

  // ...and the way back is the way out: another half turn in the air puts the nose back in front.
  model.st.pos.y += 3;
  model.st.grounded = false;
  keys.right = true;
  for (let i = 0; i < Math.round(180 / (AIR_TURN_RATE / 60)); i++) model.step(1 / 60);
  clearKeys();
  for (let i = 0; i < 240 && !model.st.grounded; i++) model.step(1 / 60);
  assert.equal(model.st.lead, 1, 'a second half turn rides out regular again');
}

clearKeys();
console.log('SWITCH RIDE TESTS PASSED');
