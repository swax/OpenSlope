// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRideModel } from '../src/app/ride/physics';
import {
  boostMeterSegments, createRideScorer, rideTrickDisplay,
  RIDE_BOOST_CRASH_PENALTY, RIDE_BOOST_DRAIN_PER_SECOND, RIDE_BOOST_METER_START,
  type RideScorer,
} from '../src/app/ride/score';
import type {
  RideTelemetryEvent, RideTelemetryState, RideTelemetryTick, RideTelemetryVec3,
} from '../src/app/ride/telemetry';

/** Deterministic parity checks for Unity's `RideableBoard.Score.cs` arithmetic and combo lifecycle. */
let frame = 0;
const H = 1 / 60;

function state(overrides: Partial<RideTelemetryState> = {}): RideTelemetryState {
  return {
    position: [0, 0, 0], velocity: [0, 0, 10], speed: 10,
    forward: [0, 0, 1], deckForward: [0, 0, 1], lead: 1, flip: 0,
    boardUp: [0, 1, 0], contactNormal: [0, 1, 0],
    trajectoryPitchDeg: 0, boardPitchDeg: 0,
    grounded: true, forcedAir: false, railIndex: -1, airTime: 0,
    error: 0, surfaceType: 1, speedCap: 30,
    lean: 0, carveSlide: 0, charging: false, jumpCharge: 0, jumpGrace: 0, ollieCooldown: 0,
    ...overrides,
  };
}

function tick(scorer: RideScorer, opening: RideTelemetryState, closing: RideTelemetryState,
              dt = H, events: RideTelemetryEvent[] = []) {
  const sample: RideTelemetryTick = {
    kind: 'frame', frame: ++frame, dt,
    input: { steer: 0, left: false, right: false, tuck: false, brake: false, boost: false },
    opening, events, closing,
  };
  scorer.ingest(sample);
}

const launchEvent: RideTelemetryEvent = {
  type: 'launch', charge: 1, direction: [0, 1, 0], impulse: 6,
  velocityBefore: [0, 0, 10], velocityAfter: [0, 6, 10],
};

function launch(scorer: RideScorer) {
  tick(scorer, state(), state({ grounded: false, forcedAir: true }), H, [launchEvent, { type: 'takeoff' }]);
}

function direction(degrees: number): RideTelemetryVec3 {
  const radians = degrees * Math.PI / 180;
  return [Math.sin(radians), 0, Math.cos(radians)];
}

/** Add air rotation in retail-sized 4.5-degree fixed ticks and return the ending state. */
function rotateAir(scorer: RideScorer, degrees: number, flip = false): RideTelemetryState {
  const steps = Math.round(Math.abs(degrees) / 4.5);
  let angle = 0;
  let opening = state({ grounded: false, forcedAir: false });
  for (let i = 0; i < steps; i++) {
    const next = angle + Math.sign(degrees) * 4.5;
    const closing = state({
      grounded: false, forcedAir: false,
      forward: flip ? [0, 0, 1] : direction(next),
      deckForward: flip ? [0, 0, 1] : direction(next),
      flip: flip ? next : 0,
    });
    opening = state({
      grounded: false, forcedAir: false,
      forward: flip ? [0, 0, 1] : direction(angle),
      deckForward: flip ? [0, 0, 1] : direction(angle),
      flip: flip ? angle : 0,
    });
    tick(scorer, opening, closing);
    opening = closing;
    angle = next;
  }
  return opening;
}

function land(scorer: RideScorer, opening: RideTelemetryState, bad = false) {
  const closing = state({
    flip: bad ? opening.flip - 4.5 : opening.flip,
    contactNormal: [0, 1, 0],
  });
  tick(scorer, opening, closing, H, [{ type: 'touchdown' }]);
}

// A 360 contributes 0.25 style, multiplied by 6786.9 and rounded to Unity's nearest ten: 1700.
{
  const scorer = createRideScorer();
  scorer.start();
  assert.equal(scorer.boostMeter, RIDE_BOOST_METER_START, 'a scored run starts with Unity\'s quarter bar');
  launch(scorer);
  const finalAir = rotateAir(scorer, 360);
  assert.equal(scorer.score, 1700, 'a live 360 has Unity\'s 1700-point preview');
  assert.deepEqual(rideTrickDisplay(scorer.snapshot(), false), {
    state: 'live', kind: 'rotation', points: 1700, detail: '1.00 × 0.25 × 1 × 6787',
  }, 'the live trick exposes Unity\'s four-factor itemized equation');
  land(scorer, finalAir);
  const landed = scorer.snapshot();
  assert.equal(landed.banked, 1700, 'a clean landing banks the live trick');
  assert.equal(landed.resolution, 1, 'a landing advances the result identity');
  assert.deepEqual(rideTrickDisplay(landed, true), {
    state: 'landed', kind: 'result', points: 1700, detail: null,
  }, 'a banked trick becomes Unity\'s green held result');
  assert(Math.abs(scorer.boostMeter - 0.42) < 1e-12,
    'the 1700 BASE points fill seventeen percent of the boost bar');
  assert.equal(scorer.snapshot().multiplier, 1, 'landing consumes the combo multiplier');
}

// Spin and flip degrees share the same rotation-style accumulator.
{
  const scorer = createRideScorer();
  scorer.start();
  launch(scorer);
  const finalAir = rotateAir(scorer, 360, true);
  land(scorer, finalAir);
  assert.equal(scorer.score, 1700, 'a full flip scores through the same 0.25-per-rotation term');
}

// Gems take the greatest tier, multiply style only, survive bump-skips, and are consumed by the next real land.
{
  const scorer = createRideScorer();
  scorer.start();
  scorer.applyMultiplier(3);
  scorer.applyMultiplier(2);
  launch(scorer);
  const bump = state({ grounded: false, forward: direction(4.5), deckForward: direction(4.5) });
  tick(scorer, state({ grounded: false }), bump);
  land(scorer, bump);
  assert.equal(scorer.snapshot().multiplier, 3, 'a sub-grace bump preserves the strongest collected gem');

  launch(scorer);
  const finalAir = rotateAir(scorer, 360);
  land(scorer, finalAir);
  assert.equal(scorer.score, 5090, 'x3 multiplies the 360 style before nearest-ten rounding');
  assert(Math.abs(scorer.boostMeter - 0.42) < 1e-12,
    'a gem does not multiply the base points that fill boost');
  assert.equal(scorer.snapshot().multiplier, 1, 'the real landing consumes the gem');
}

// Four seconds opens the unmultiplied big-air add: (air - 3) * 1000.
{
  const scorer = createRideScorer();
  scorer.start();
  launch(scorer);
  let opening = state({ grounded: false });
  for (let i = 0; i < 241; i++) {
    const closing = state({ grounded: false });
    tick(scorer, opening, closing);
    opening = closing;
  }
  assert.equal(scorer.score, 1017, '4.0167 seconds of air earns Unity\'s 1017-point flat bonus');
  land(scorer, opening);
  assert.equal(scorer.score, 1017, 'big-air points bank on a clean landing even without rotation');
  assert.equal(scorer.boostMeter, RIDE_BOOST_METER_START, 'the flat big-air add fills no boost meter');
}

// Grinding is linear style at 0.15/s, with no separate hold ladder.
{
  const scorer = createRideScorer();
  scorer.start();
  const rail = state({ grounded: true, railIndex: 0 });
  for (let i = 0; i < 60; i++) tick(scorer, rail, rail);
  assert.equal(scorer.score, 1020, 'one grind second is 0.15 style = 1020 rounded points');
  assert.deepEqual(rideTrickDisplay(scorer.snapshot(), false), {
    state: 'live', kind: 'grind', points: 1020, detail: 'grind  1.0s',
  }, 'a live grind itemizes its held time instead of the rotation equation');
  tick(scorer, rail, state());
  assert.equal(scorer.snapshot().banked, 1020, 'leaving the rail onto snow banks the open grind');
}

// A one-second deck grab has a begin bump + held style (590) and tier 2's flat 4000.
{
  const scorer = createRideScorer();
  scorer.start();
  launch(scorer);
  scorer.stepOffBoard(1, 'left');
  assert.equal(scorer.score, 4590, 'one held-board second combines grab style and the tier-2 ladder');
  assert.deepEqual(rideTrickDisplay(scorer.snapshot(), false), {
    state: 'live', kind: 'grab', points: 4590, detail: 'left grab  1.0s',
  }, 'a deck grab itemizes its hand and tier time');
  const remounted = state({ grounded: false });
  tick(scorer, remounted, remounted);
  land(scorer, remounted);
  assert.equal(scorer.snapshot().banked, 4590, 'catching and landing banks the held-board grab');
  assert(Math.abs(scorer.boostMeter - 0.309) < 1e-12,
    'grab STYLE fills the meter while its flat 4000-point tier does not');
  assert.equal(scorer.snapshot().grabHand, null, 'a resolved grab clears its hand label');
}

// Sloppy landings and OOB resets wipe only the current preview; prior banked points survive.
{
  const scorer = createRideScorer();
  scorer.start();
  launch(scorer);
  land(scorer, rotateAir(scorer, 360));
  assert.equal(scorer.score, 1700);

  launch(scorer);
  const sideways = rotateAir(scorer, 90, true);
  land(scorer, sideways, true);
  assert.equal(scorer.score, 1700, 'a 90-degree unfinished flip loses the open trick but keeps the run total');
  assert.equal(scorer.snapshot().lastBailed, true, 'the sloppy landing is reported as a wiped trick');
  assert.equal(scorer.snapshot().lastBailReason, 'sloppy-landing');

  scorer.applyMultiplier(5);
  launch(scorer);
  rotateAir(scorer, 180);
  assert(scorer.score > 1700, 'the next live trick contributes a preview');
  scorer.bail();
  assert.equal(scorer.score, 1700, 'an OOB bail drops the preview and preserves banked score');
  assert.equal(scorer.snapshot().multiplier, 1, 'a bail also consumes the collected gem');
  assert.deepEqual(rideTrickDisplay(scorer.snapshot(), true), {
    state: 'bailed', kind: 'result', points: 4240, detail: 'out of bounds',
  }, 'an OOB reset holds the lost trick in red with Unity\'s reason');
  assert(Math.abs(scorer.boostMeter - (0.42 - RIDE_BOOST_CRASH_PENALTY)) < 1e-12,
    'a bail removes Unity\'s 0.1 crash penalty from the meter');
}

// Held boost drains at 0.045/s, stops at empty, and the visual readout exposes fifteen whole dots.
{
  const scorer = createRideScorer();
  scorer.start();
  scorer.stepBoost(1, false);
  assert.equal(scorer.boostMeter, RIDE_BOOST_METER_START, 'an unheld meter does not drain');
  scorer.stepBoost(1, true);
  assert.equal(scorer.boostMeter, RIDE_BOOST_METER_START - RIDE_BOOST_DRAIN_PER_SECOND,
    'one held second spends 0.045 of the bar');
  scorer.stepBoost(100, true);
  assert.equal(scorer.boostMeter, 0, 'held boost clamps at empty');
  assert.equal(scorer.hasBoost, false, 'an empty scored run gates held boost');
  assert.equal(boostMeterSegments(0.25), 3, 'a quarter bar lights three of Unity\'s fifteen whole dots');
  assert.equal(boostMeterSegments(1), 15, 'a full meter lights all fifteen dots');
  scorer.finish();
  assert.equal(scorer.hasBoost, true, 'outside an active scored run held boost is unlimited again');
}

// A finish reads the live preview before ending and then freezes it for the result display.
{
  const scorer = createRideScorer();
  scorer.start();
  launch(scorer);
  rotateAir(scorer, 180);
  assert.equal(scorer.finish(), 850, 'finishing mid-trick records banked score plus the live preview');
  assert.equal(scorer.score, 850, 'the final result remains frozen after later samples');
  tick(scorer, state({ grounded: false }), state());
  assert.equal(scorer.score, 850);
}

// The production physics callback drives the same scorer: a real 60 Hz full flip lands and banks 1700.
{
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -200, 0, -200, -200, 0, 200, 200, 0, -200,
    200, 0, -200, -200, 0, 200, 200, 0, 200,
  ], 3));
  const terrain = new THREE.Mesh(geometry);
  terrain.updateMatrixWorld(true);
  const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
  const scorer = createRideScorer();
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain,
    surfaceOf: () => 1, oobFloorY: -100, keys, stick: { active: false, x: 0 }, drive: 0,
    heldBoostAvailable: () => scorer.hasBoost,
    onRespawn: () => {}, onTelemetryTick: sample => scorer.ingest(sample),
  });
  model.start();
  model.st.pos.set(0, 30, 0);
  model.st.vel.set(0, 0, 12);
  model.st.fwd.set(0, 0, 1);
  model.st.boardUp.set(0, 1, 0);
  model.st.contactN.set(0, 1, 0);
  model.st.grounded = false;
  model.st.forcedAir = false;
  model.st.airTime = 0;
  model.st.flip = 0;
  scorer.start();
  keys.tuck = true;
  for (let i = 0; i < 80; i++) model.step(H);
  keys.tuck = false;
  assert(Math.abs(model.st.flip - 360) < 1e-6, 'production air ticks turn a full flip before touchdown');
  for (let i = 0; i < 300 && !model.st.grounded; i++) model.step(H);
  assert(model.st.grounded, 'the production flight reaches a real telemetry touchdown');
  assert.equal(scorer.snapshot().banked, 1700, 'the fixed-tick integration seam banks that full flip');
  scorer.stepBoost(100, true);
  keys.boost = true;
  assert.equal(model.boostActive(), false, 'the production held-boost path is gated when a scored run is empty');
  model.applyPadBoost(1);
  assert.equal(model.boostActive(), true, 'a course speed pad remains free when the held meter is empty');
  keys.boost = false;
  geometry.dispose();
}

console.log('ride score: all checks passed');
