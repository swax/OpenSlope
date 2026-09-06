// tier: fast

// Unity parity for held boost after takeoff, with Slopesmith's deck-as-thruster direction. RideableBoard.AirTick
// uses an 8 m/s² thrust below the shared cap, cross-fades its sideways component to a 40°/s velocity bend at
// the cap, and applies the game's x1.6 trick-boost number to stick spin/flip. These checks keep those mechanics
// while pinning the new control contract: the force follows the visible board nose, including a live flip.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { boardPointingDirection, createRideModel, type RideModel, type RideModelOpts } from '../src/app/ride/physics';
import { createRideInput, type RideKeys } from '../src/app/ride/input';
import {
  AIR_BOOST_ACCEL, AIR_BOOST_TURN_RATE, AIR_TRICK_BOOST_SPIN_MUL, AIR_TURN_RATE, BOOST_MAX_SPEED, D2R,
} from '../src/app/ride/physics-tuning';

const DT = 1 / 60;

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

interface AirRideOpts {
  velocity?: THREE.Vector3;
  fwd?: THREE.Vector3;
  boardUp?: THREE.Vector3;
  flip?: number;
  lead?: 1 | -1;
  boost?: boolean;
  right?: boolean;
  tuck?: boolean;
  keys?: RideKeys;
}

function airRide(opts: AirRideOpts = {}): RideModel {
  const keys = opts.keys ?? {
    left: false, right: !!opts.right, tuck: !!opts.tuck, brake: false, boost: !!opts.boost,
  };
  const modelOpts: RideModelOpts = {
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, oobFloorY: -100, keys, stick: { active: false, x: 0 }, onRespawn: () => {},
  };
  const model = createRideModel(modelOpts);
  model.start();
  model.st.pos.set(0, 50, 0);
  model.st.vel.copy(opts.velocity ?? new THREE.Vector3(0, 0, 10));
  model.st.fwd.copy(opts.fwd ?? new THREE.Vector3(0, 0, 1));
  model.st.boardUp.copy(opts.boardUp ?? new THREE.Vector3(0, 1, 0));
  model.st.flip = opts.flip ?? 0;
  model.st.lead = opts.lead ?? 1;
  model.st.grounded = false;
  model.st.forcedAir = false;
  model.st.speedCap = BOOST_MAX_SPEED;
  return model;
}

function step(model: RideModel, ticks = 1) {
  for (let i = 0; i < ticks; i++) model.step(DT);
}

// Shift and the standard gamepad's R1 feed the same aggregate Boost key. Direction belongs to the deck, not to
// whichever input device happened to press it.
{
  const actions = {
    ollieDown: () => {}, ollieUp: () => {}, respawn: () => {}, telemetryToggle: () => {},
    telemetryMark: () => {}, exit: () => {},
  };
  const keyboard = createRideInput(actions);
  const gamepad = createRideInput(actions);
  keyboard.setHold('keyboard', 'boost', true);
  gamepad.setHold('gamepad', 'boost', true);
  const deckNose = new THREE.Vector3(1, 0, 0);
  const shiftRide = airRide({ keys: keyboard.keys, fwd: deckNose });
  const controllerRide = airRide({ keys: gamepad.keys, fwd: deckNose });
  step(shiftRide); step(controllerRide);
  assert.ok(shiftRide.st.vel.x > 0, 'desktop Shift boosts toward the deck nose');
  assert.ok(controllerRide.st.vel.distanceTo(shiftRide.st.vel) < 1e-9,
    'a non-VR controller boost uses the identical deck direction and acceleration');
}

// Below the cap, pitching/flipping the board up stretches the jump and pitching it down steepens the descent by
// exactly the Unity acceleration relative to an otherwise identical ballistic tick.
{
  const coast = airRide();
  const up = airRide({ flip: -90, boost: true });
  const down = airRide({ flip: 90, boost: true });
  step(coast); step(up); step(down);
  assert.ok(Math.abs((up.st.vel.y - coast.st.vel.y) - AIR_BOOST_ACCEL * DT) < 1e-9,
    'an upward-pointed deck adds the Unity 8 m/s² air thrust');
  assert.ok(Math.abs((down.st.vel.y - coast.st.vel.y) + AIR_BOOST_ACCEL * DT) < 1e-9,
    'a downward-pointed deck applies that thrust downward');
  assert.ok(up.boostThrustActive(), 'real below-cap air thrust opens the boost-roar gate');

  const nose = boardPointingDirection({
    fwd: new THREE.Vector3(0, 0, 1), boardUp: new THREE.Vector3(0, 1, 0), flip: -90, lead: 1,
  }, new THREE.Vector3());
  assert.ok(nose.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9,
    'the boost direction includes the visible deck flip rather than only its base heading');
}

// At the shared cap, a sideways acceleration would be normalized away on the following clamp. Unity instead
// bends the carried velocity without changing its magnitude, while a forward aim honestly does nothing and an
// against-travel aim remains a real brake for soft landings.
{
  const sideways = airRide({ velocity: new THREE.Vector3(0, 0, BOOST_MAX_SPEED),
    fwd: new THREE.Vector3(1, 0, 0), boost: true });
  step(sideways);
  const turnDeg = Math.atan2(sideways.st.vel.x, sideways.st.vel.z) / D2R;
  const expected = AIR_BOOST_TURN_RATE * DT;
  assert.ok(Math.abs(turnDeg - expected) < 0.03,
    `a sideways-pointed deck bends the arc at ${AIR_BOOST_TURN_RATE}°/s (${turnDeg.toFixed(3)}° this tick)`);
  assert.ok(sideways.boostThrustActive(), 'the magnitude-preserving bend is audible boost work');

  const forward = airRide({ velocity: new THREE.Vector3(0, 0, BOOST_MAX_SPEED), boost: true });
  const coast = airRide({ velocity: new THREE.Vector3(0, 0, BOOST_MAX_SPEED) });
  const reverse = airRide({ velocity: new THREE.Vector3(0, 0, BOOST_MAX_SPEED),
    fwd: new THREE.Vector3(0, 0, -1), boost: true });
  step(forward); step(coast); step(reverse);
  assert.ok(forward.st.vel.distanceTo(coast.st.vel) < 1e-9,
    'an at-cap deck pointing along travel adds nothing the cap would only discard');
  assert.ok(!forward.boostThrustActive(), 'the no-op at-cap board thrust keeps the boost roar silent');
  assert.ok(reverse.st.vel.length() < coast.st.vel.length() - AIR_BOOST_ACCEL * DT * 0.9,
    'an against-travel deck at the cap remains a real braking flare');
}

// Air spin and flip use Unity's x1.6 trick-boost presentation multiplier. It is keyed from the shared boost state,
// so a timed speed pad boosts the spin as Unity's BoostActive does, but a pad never becomes board thrust.
{
  const ticks = 10;
  const boosted = airRide({ boost: true, right: true, tuck: true });
  step(boosted, ticks);
  const expected = AIR_TURN_RATE * AIR_TRICK_BOOST_SPIN_MUL * ticks * DT;
  const yaw = Math.acos(THREE.MathUtils.clamp(boosted.st.fwd.z, -1, 1)) / D2R;
  assert.ok(Math.abs(yaw - expected) < 1e-8, `held boost spins at x${AIR_TRICK_BOOST_SPIN_MUL}`);
  assert.ok(Math.abs(boosted.st.flip - expected) < 1e-8, `held boost flips at x${AIR_TRICK_BOOST_SPIN_MUL}`);

  const pad = airRide({ right: true });
  const padCoast = airRide({ right: true });
  pad.applyPadBoost(5);
  step(pad, ticks); step(padCoast, ticks);
  const padYaw = Math.acos(THREE.MathUtils.clamp(pad.st.fwd.z, -1, 1)) / D2R;
  assert.ok(Math.abs(padYaw - expected) < 1e-8, 'a timed pad uses the same boosted air-spin state');
  assert.ok(Math.abs(pad.st.vel.y - padCoast.st.vel.y) < 1e-9,
    'a timed pad does not fire the board-thrust path');
  assert.ok(!pad.boostThrustActive(), 'the pad-only boost state stays outside the board-thrust audio gate');
}

console.log('AIR BOOST TESTS PASSED');
