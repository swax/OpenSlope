// tier: fast

import assert from 'node:assert/strict';
import { forwardResistance } from '../src/app/ride/ride-response';
import * as THREE from 'three';
import { SURFACE_ROWS, createRideModel, groundRestDepth } from '../src/app/ride/physics';
import { advanceBoardOrientation } from '../src/app/ride/pose';
import {
  RIDE_TELEMETRY_SCHEMA,
  RideTelemetryCapture,
  type RideTelemetryEvent,
  type RideTelemetryState,
  type RideTelemetryTick,
} from '../src/app/ride/telemetry';

const zero: [number, number, number] = [0, 0, 0];

function state(frame: number, grounded: boolean): RideTelemetryState {
  return {
    position: [0, frame, 0], velocity: [0, 0, frame], speed: frame,
    forward: [0, 0, 1], deckForward: [0, 0, 1], lead: 1, flip: 0, boardUp: [0, 1, 0], contactNormal: [0, 1, 0],
    trajectoryPitchDeg: 0, boardPitchDeg: 0,
    grounded, forcedAir: false, railIndex: -1, airTime: grounded ? 0 : frame / 60,
    error: grounded ? -0.005 : 2, surfaceType: 1, speedCap: 27.888,
    lean: 0, carveSlide: 0,
    charging: false, jumpCharge: 0, jumpGrace: 0, ollieCooldown: 0,
  };
}

function tick(frame: number, events: RideTelemetryEvent[] = [], grounded = true): RideTelemetryTick {
  return {
    kind: 'frame', frame, dt: 1 / 60,
    input: { steer: 0, left: false, right: false, tuck: false, brake: false, boost: false },
    opening: state(frame - 1, grounded), acceleration: zero, events, closing: state(frame, grounded),
  };
}

const capture = new RideTelemetryCapture({
  label: 'Riding: telemetry test', preRollTicks: 2, now: () => new Date('2026-07-14T12:34:56.000Z'),
});

capture.ingest(tick(1));
capture.ingest(tick(2));
capture.ingest(tick(3));
capture.ingestCamera({
  renderDt: 1 / 60,
  subjectPosition: [0, 0, 0], candidatePosition: [0, 2, -5], position: [0, 2.4, -5],
  lookTarget: [0, 1.7, 0], forward: [0, -0.1, 0.99], up: [0, 0.99, 0.1], targetHeading: [0, 0, 1],
  trajectoryPitchDeg: -2, targetTrajectoryPitchDeg: -5, fovYDeg: 78.145, nearClipM: 0.15, aspect: 16 / 9,
  boost: false, clearance: 'ground', correctionDistanceM: 0.4, originUnburied: false,
  probes: [{
    kind: 'ground', from: [0, 2.4, -5], to: [0, 1.6, -5], segmentLength: 0.8, hit: true,
    hitDistance: 0.4, point: [0, 2, -5], normal: [0, 1, 0], source: 'terrain',
  }],
});
const marker = capture.mark('bad lip'); // arms capture and retains only frames 2–3
assert.equal(marker.frame, 3);
assert.equal(marker.index, 1);
assert.equal(capture.active, true);

capture.ingest(tick(4, [
  { type: 'takeoff' },
  { type: 'floor-crossing-deferred', distance: 0.2, normal: [0, 1, 0] },
], false));
capture.ingestShovedBodies([{
  key: 'reference:149', age: 0.016, com: [0, 1.6, 0], velocity: [-3.6, 2.3, 6.4], angular: [-2.8, 0, -1.6],
  groundY: 0, radius: 1.59, asleep: false,
}]);
capture.ingest(tick(5, [
  { type: 'touchdown' },
  { type: 'barrier-resolved', distance: 0.1, normal: [0, 0, -1] },
], true));
capture.ingestShovedBodies([{
  key: 'reference:149', age: 1.2, com: [-2, 1.7, 4], velocity: [-1, 0.2, 2], angular: [-1, 0, -0.5],
  groundY: 0, radius: 1.59, asleep: false,
}]);
capture.ingestShovedBodies([{
  key: 'reference:149', age: 3.9, com: [-4, 1.62, 7.1], velocity: [0, 0, 0], angular: [0, 0, 0],
  groundY: 0, radius: 1.59, asleep: true,
}]);

const output = capture.finish();
assert.ok(output);
assert.equal(output.summary.schema, RIDE_TELEMETRY_SCHEMA);
assert.equal(output.summary.frames, 4);
assert.equal(output.summary.cameraFrames, 1);
assert.equal(output.summary.firstFrame, 2);
assert.equal(output.summary.lastFrame, 5);
assert.equal(output.summary.markers, 1);
assert.equal(output.summary.takeoffs, 1);
assert.equal(output.summary.touchdowns, 1);
assert.equal(output.summary.barrierResolutions, 1);
assert.equal(output.summary.deferredFloorCrossings, 1);
assert.deepEqual(output.summary.takeoffSamples, [
  { frame: 4, speed: 4, trajectoryPitchDeg: 0, boardPitchDeg: 0 },
]);
// The flight digest a stuck bag is diagnosed from: where it launched, where it ended, its true travel, how high
// its underside got above the ground read, and whether it actually went to sleep.
assert.equal(output.summary.shovedBodySamples, 3);
assert.deepEqual(output.summary.shovedBodies, [{
  key: 'reference:149', samples: 3, settled: true,
  launch: [0, 1.6, 0], rest: [-4, 1.62, 7.1], travelM: 8.15, peakUndersideM: 0.11,
}]);
assert.equal(output.baseName, 'riding-telemetry-test-2026-07-14T12-34-56-000Z');
assert.equal(output.jsonl.trimEnd().split('\n').length, 11); // header + 4 frames + camera + marker + 3 flights + footer
assert.equal(JSON.parse(output.jsonl.split('\n')[0]).schema, RIDE_TELEMETRY_SCHEMA);
const cameraRecord = output.jsonl.trimEnd().split('\n').map(line => JSON.parse(line))
  .find(record => record.kind === 'camera');
assert.equal(cameraRecord.frame, 3);
assert.equal(cameraRecord.clearance, 'ground');
assert.equal(cameraRecord.probes[0].source, 'terrain');
assert.equal(capture.active, false);
assert.equal(capture.finish(), null);

// A completed segment returns to pre-roll standby and can immediately capture another independent window.
capture.ingest(tick(6));
capture.start();
const second = capture.finish();
assert.ok(second);
assert.equal(second.summary.frames, 2);
assert.equal(second.summary.firstFrame, 5);
assert.equal(second.summary.lastFrame, 6);

// Regression from a Snowdream trace: an airborne board can meet a rising kicker mostly laterally. Its upward
// face is rideable ground even though world velocity is not descending; the obstacle sweep must hand it to the
// contact probe instead of projecting velocity off it like a wall and manufacturing a launch.
const rampSlope = 1.2;
const rampGeometry = new THREE.BufferGeometry();
rampGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  -5, -5 * rampSlope, -5,  5, -5 * rampSlope, -5,
  -5,  5 * rampSlope,  5,  5,  5 * rampSlope,  5,
], 3));
rampGeometry.setIndex([0, 2, 1, 1, 2, 3]); // up-facing plane y = rampSlope * z
const rampTerrain = new THREE.Mesh(rampGeometry);
rampTerrain.updateMatrixWorld(true);
const rampTicks: RideTelemetryTick[] = [];
const rampModel = createRideModel({
  spawn: new THREE.Vector3(0, 1.2, 0), heading: new THREE.Vector3(0, 0, 1), terrain: rampTerrain,
  surfaceOf: () => 1, oobFloorY: -100, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: false, x: 0 }, onRespawn: () => {}, onTelemetryTick: frame => rampTicks.push(frame),
});
rampModel.start();
rampModel.st.pos.set(0, 1.2, 0);
rampModel.st.vel.set(0, 0, 60);
rampModel.st.grounded = false;
rampModel.step(1 / 60);
const rampTick = rampTicks.at(-1)!;
const deferredRamp = rampTick.events.find(event => event.type === 'floor-crossing-deferred');
assert.ok(deferredRamp && 'normal' in deferredRamp,
  'a lateral crossing into an up-facing ramp must be deferred to ground contact');
assert.ok(deferredRamp.normal[1] > 0.5, 'the regression fixture must exercise the rideable-normal branch');
assert.equal(rampTick.events.some(event => event.type === 'barrier-resolved'), false,
  'an up-facing ramp must never run wall collision response');

// The Snowdream gold trace enters ordinary ground with contact error zero and preserves the transition speed even
// when 15–20 m/s of the arriving velocity points into the landing. The penetration transient starts on following
// ground ticks. Starting pushout from the discovery probe's already-negative error instead projects the impact in
// one frame and creates the conspicuous landing-speed cliff seen in the first Slopesmith comparison run.
const floorGeometry = new THREE.BufferGeometry();
const floorVertices = [
  new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 0, -20),
  new THREE.Vector3(-20, 0, 20), new THREE.Vector3(20, 0, 20),
];
const floorIndices = [0, 2, 1, 1, 2, 3];
floorGeometry.setAttribute('position', new THREE.Float32BufferAttribute(floorVertices.flatMap(v => v.toArray()), 3));
floorGeometry.setIndex(floorIndices);
const floorTerrain = new THREE.Mesh(floorGeometry);
floorTerrain.updateMatrixWorld(true);

// Ground motion has no generic terminal drag in the traced engine. On flat snow, above the cruise target and
// below the shared cap, an aligned rider has no longitudinal force at all and must carry speed unchanged. The
// former port-only `0.012 * speed^2` term lost 0.08 m/s on this single tick and accumulated a 3.2 m/s deficit
// before Snowdream's first lip, making the slower deck follow the convex far side long after the gold run left it.
const carryTicks: RideTelemetryTick[] = [];
const carryModel = createRideModel({
  spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(1, 0, 0), terrain: floorTerrain,
  surfaceOf: () => 1, oobFloorY: -100, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: false, x: 0 }, onRespawn: () => {}, onTelemetryTick: frame => carryTicks.push(frame),
});
carryModel.start();
carryModel.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 0);
carryModel.st.vel.set(20, 0, 0);
carryModel.st.fwd.set(1, 0, 0);
carryModel.st.contactN.set(0, 1, 0);
carryModel.st.boardUp.set(0, 1, 0);
carryModel.st.grounded = true;
carryModel.step(1 / 60);
const carryAcceleration = forwardResistance(SURFACE_ROWS[1], 20, -SURFACE_ROWS[1].bog, SURFACE_ROWS[1].budget, 0, 0);
assert.ok(Math.abs(carryTicks.at(-1)!.closing.velocity[0] - (20 + carryAcceleration / 60)) < 1e-6,
  'coasting applies the recovered forward resistance exactly once');

// The banked residual lowers the normal projection for a given response. Flat ice must build a
// larger scalar response to support the same load while carving. Keep the production path free
// of optional assistance and compare its settled side force to that force-balance prediction.
const iceTicks: RideTelemetryTick[] = [];
const iceModel = createRideModel({
  spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(1, 0, 0), terrain: floorTerrain,
  surfaceOf: () => 5, oobFloorY: -100,
  keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: true, x: 1 }, onRespawn: () => {}, onTelemetryTick: frame => iceTicks.push(frame),
  // Exactly the "free of any ice-only multiplier" the comment above requires. The low-grip assist is a rider
  // aid that lifts ice's carve tilt (and damps the self-centring yaw, and recovers uncommanded slip); with it
  // on, this fixture reads 14.31 m/s² and ~61°/s. Those are the assist working, not the contact law holding,
  // and folding them into the bounds would let a regression in the law itself hide behind the aid.
  lowGripAssist: false,
});
iceModel.start();
iceModel.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[5]), 0);
iceModel.st.vel.set(14, 0, 0);
iceModel.st.fwd.set(1, 0, 0);
iceModel.st.contactN.set(0, 1, 0);
iceModel.st.boardUp.set(0, 1, 0);
iceModel.st.grounded = true;
for (let i = 0; i < 90; i++) iceModel.step(1 / 60);
const travelHeading = (tick: RideTelemetryTick) =>
  Math.atan2(tick.closing.velocity[2], tick.closing.velocity[0]);
let iceTravelDelta = travelHeading(iceTicks[89]) - travelHeading(iceTicks[59]);
while (iceTravelDelta > Math.PI) iceTravelDelta -= 2 * Math.PI;
while (iceTravelDelta < -Math.PI) iceTravelDelta += 2 * Math.PI;
const iceTravelYawRate = Math.abs(iceTravelDelta) / (30 / 60) * 180 / Math.PI;
const iceLateralAccel = iceTicks.slice(60, 90).reduce((sum, tick) => {
  const n = new THREE.Vector3().fromArray(tick.opening.contactNormal);
  const f = new THREE.Vector3().fromArray(tick.opening.forward);
  const side = new THREE.Vector3().crossVectors(n, f).normalize();
  return sum + Math.abs(side.dot(new THREE.Vector3().fromArray(tick.acceleration!)));
}, 0) / 30;
const iceTheta = 45 * Math.PI / 180 * 0.9051856;
const iceSupportResponse = (SURFACE_ROWS[5].A / 100) / (2 - 1 / Math.cos(iceTheta));
const iceSidePrediction = iceSupportResponse * Math.tan(iceTheta);
assert.ok(Math.abs(iceLateralAccel - iceSidePrediction) < 0.25,
  `banked force balance predicts ${iceSidePrediction.toFixed(2)} m/s² (got ${iceLateralAccel.toFixed(2)})`);
assert.ok(iceTravelYawRate > 60 && iceTravelYawRate < 95,
  `the force bends travel at this fixture's speed (got ${iceTravelYawRate.toFixed(1)}°/s)`);
assert.ok(iceTicks.at(-1)!.closing.error < -SURFACE_ROWS[5].bog,
  'a banked contact penetrates beyond the neutral bog floor to build supporting response');

// Snowdream supplies a historical net-energy
// measurement independent of elapsed time: from course Z -640 to -572.15 the surface drops 22.74 m while retail
// carries 14.32 -> 20.49 m/s. Compare the reconstructed load and resistance on this simplified slope.
const goldDrop = 22.74;
const goldRun = 67.85;
const goldSlope = goldDrop / goldRun;
const slopeGeometry = new THREE.BufferGeometry();
slopeGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
  -20, 100 * goldSlope, -100, 20, 100 * goldSlope, -100,
  -20, -100 * goldSlope, 100, 20, -100 * goldSlope, 100,
], 3));
slopeGeometry.setIndex([0, 2, 1, 1, 2, 3]);
const slopeTerrain = new THREE.Mesh(slopeGeometry);
slopeTerrain.updateMatrixWorld(true);
const slopeModel = createRideModel({
  spawn: new THREE.Vector3(0, 80 * goldSlope + 1, -80), heading: new THREE.Vector3(0, -goldSlope, 1),
  terrain: slopeTerrain, surfaceOf: () => 1, oobFloorY: -100,
  keys: { left: false, right: false, tuck: false, brake: false, boost: false }, stick: { active: false, x: 0 },
  onRespawn: () => {},
});
slopeModel.start();
const slopeNormal = new THREE.Vector3(0, 1, goldSlope).normalize();
const slopeTangent = new THREE.Vector3(0, -goldSlope, 1).normalize();
slopeModel.st.pos.set(0, 80 * goldSlope, -80)
  .addScaledVector(slopeNormal, -groundRestDepth(SURFACE_ROWS[1], slopeNormal.y));
slopeModel.st.vel.copy(slopeTangent).multiplyScalar(14.32);
slopeModel.st.fwd.copy(slopeTangent);
slopeModel.st.contactN.copy(slopeNormal);
slopeModel.st.boardUp.copy(slopeNormal);
slopeModel.st.grounded = true;
while (slopeModel.st.pos.z < -80 + goldRun) slopeModel.step(1 / 60);
assert.ok(Math.abs(slopeModel.st.vel.length() - 20.49) < 0.4,
  `the measured Snowdream drop must reach gold speed without ground drag (got ${slopeModel.st.vel.length()})`);

// Gold pose response is deliberately nonlinear: tiny contact-basis differences move almost imperceptibly, while
// a fast-changing lip lets the deck catch up without ever snapping to the fresh normal. The measured first-lip
// curve is ≈0.10° at 6° error and ≈0.80° at 12° error per 60 Hz tick. Neutral air levels at ≈9°/s.
carryModel.st.grounded = true;
carryModel.st.boardUp.set(0, 1, 0);
carryModel.st.contactN.set(0, Math.cos(6 * Math.PI / 180), Math.sin(6 * Math.PI / 180));
advanceBoardOrientation(carryModel.st, 1 / 60);
assert.ok(Math.abs(carryModel.st.boardUp.angleTo(new THREE.Vector3(0, 1, 0)) * 180 / Math.PI - 0.099) < 0.005,
  'six-degree ground orientation error must advance by the measured slow end of the cubic response');
carryModel.st.boardUp.set(0, 1, 0);
carryModel.st.contactN.set(0, Math.cos(12 * Math.PI / 180), Math.sin(12 * Math.PI / 180));
advanceBoardOrientation(carryModel.st, 1 / 60);
assert.ok(Math.abs(carryModel.st.boardUp.angleTo(new THREE.Vector3(0, 1, 0)) * 180 / Math.PI - 0.790) < 0.005,
  'twelve-degree ground orientation error must advance by the measured fast end of the cubic response');
carryModel.st.grounded = false;
carryModel.st.airTime = 1;
carryModel.st.boardUp.set(0, Math.cos(20 * Math.PI / 180), Math.sin(20 * Math.PI / 180));
carryModel.st.airUp.set(0, 1, 0);
advanceBoardOrientation(carryModel.st, 1 / 60);
assert.ok(Math.abs(carryModel.st.boardUp.angleTo(new THREE.Vector3(0, 1, 0)) * 180 / Math.PI - 19.85) < 0.005,
  'neutral airborne deck must level at the gold-derived nine degrees per second');

const landingTicks: RideTelemetryTick[] = [];
const landingModel = createRideModel({
  spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(1, 0, 0), terrain: floorTerrain,
  surfaceOf: () => 1, oobFloorY: -100, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: false, x: 0 }, onRespawn: () => {}, onTelemetryTick: frame => landingTicks.push(frame),
});
landingModel.start();
landingModel.st.pos.set(0, 0.05, 0);
landingModel.st.vel.set(10, -20, 0);
landingModel.st.fwd.set(1, 0, 0);
landingModel.st.boardUp.set(0, 1, 0);
landingModel.st.grounded = false;
landingModel.step(1 / 60); // cross the floor while still running the air tick
landingModel.step(1 / 60); // discover contact and enter ground
const hardTouchdown = landingTicks.at(-1)!;
assert.ok(hardTouchdown.events.some(event => event.type === 'touchdown'), 'the landing fixture must touch down');
const expectedLandingVelocity = new THREE.Vector3().fromArray(hardTouchdown.opening.velocity)
  .addScaledVector(new THREE.Vector3().fromArray(hardTouchdown.acceleration!), 1 / 60);
assert.ok(expectedLandingVelocity.distanceTo(new THREE.Vector3().fromArray(hardTouchdown.closing.velocity)) < 1e-6,
  'touchdown integrates the full response once, without a separate blanket impact scrub');
assert.ok(hardTouchdown.closing.velocity[1] < 0, 'normal impact is retained for the compliant contact to resolve');
assert.equal(hardTouchdown.closing.error, 0,
  'a clean touchdown seeds contact error at the surface; penetration begins on following ground ticks');

// Analytic contact is the engine path, so its fresh normal is also the cached probe/frame normal with no temporal
// filter. Keep smoothing only for the explicitly faceted fallback.
const analyticNormal = new THREE.Vector3(0, 0.8, 0.6).normalize();
const analyticModel = createRideModel({
  spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(1, 0, 0), terrain: floorTerrain,
  surfaceOf: () => 1, oobFloorY: -100, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: false, x: 0 }, onRespawn: () => {},
  patchContact: (faceIndex, bary, outPoint, outNormal) => {
    const i = faceIndex * 3;
    outPoint.set(0, 0, 0)
      .addScaledVector(floorVertices[floorIndices[i]], bary.x)
      .addScaledVector(floorVertices[floorIndices[i + 1]], bary.y)
      .addScaledVector(floorVertices[floorIndices[i + 2]], bary.z);
    outNormal.copy(analyticNormal);
    return true;
  },
});
analyticModel.start();
analyticModel.st.pos.set(0, -0.01, 0);
analyticModel.st.vel.set(5, 0, 0);
analyticModel.st.grounded = true;
analyticModel.st.contactN.set(0, 1, 0);
analyticModel.step(1 / 60);
assert.ok(analyticModel.st.contactN.distanceTo(analyticNormal) < 1e-9,
  'analytic contact must cache the exact current patch normal without a low-pass');

// A triangle hit supplies only a seed for analytic contact. On a normal-aimed ray, evaluating a curved/slanted
// patch at that unchanged barycentric coordinate can put the reported "contact" far sideways from the ray. The
// second Snowdream lip measured 0.96 m off-ray and then followed that unrelated far-side point down to -74°.
// This fixture exaggerates the same geometry: a flat collision chord seeds a slanted analytic plane.
const refinedTicks: RideTelemetryTick[] = [];
const refinedNormal = new THREE.Vector3(0, 1, 0.5).normalize();
const refinedPoint = new THREE.Vector3(0, -1, 2);
const refinedModel = createRideModel({
  spawn: refinedPoint.clone().addScaledVector(refinedNormal, 1), heading: new THREE.Vector3(0, -0.5, 1),
  terrain: floorTerrain, surfaceOf: () => 1, oobFloorY: -100,
  keys: { left: false, right: false, tuck: false, brake: false, boost: false }, stick: { active: false, x: 0 },
  onRespawn: () => {}, onTelemetryTick: frame => refinedTicks.push(frame),
  patchContact: (faceIndex, bary, outPoint, outNormal) => {
    const i = faceIndex * 3;
    const flat = new THREE.Vector3()
      .addScaledVector(floorVertices[floorIndices[i]], bary.x)
      .addScaledVector(floorVertices[floorIndices[i + 1]], bary.y)
      .addScaledVector(floorVertices[floorIndices[i + 2]], bary.z);
    outPoint.set(flat.x, -0.5 * flat.z, flat.z);
    outNormal.copy(refinedNormal);
    return true;
  },
});
refinedModel.start();
refinedModel.st.pos.copy(refinedPoint).addScaledVector(refinedNormal, 0.02);
refinedModel.st.vel.set(0, 0, 0);
refinedModel.st.fwd.set(0, -0.5, 1).normalize();
refinedModel.st.contactN.copy(refinedNormal);
refinedModel.st.boardUp.copy(refinedNormal);
refinedModel.st.grounded = true;
refinedModel.step(1 / 60);
const refinedProbe = refinedTicks.at(-1)!.probe!;
const refinedHit = new THREE.Vector3(...refinedProbe.point);
const refinedAim = new THREE.Vector3(...refinedProbe.aim);
const refinedBase = new THREE.Vector3(...refinedTicks.at(-1)!.opening.position);
const offRay = refinedHit.clone().sub(refinedBase)
  .addScaledVector(refinedAim, -refinedHit.clone().sub(refinedBase).dot(refinedAim)).length();
assert.ok(refinedHit.distanceTo(refinedPoint) < 1e-3,
  `analytic contact must Newton-refine to the actual ray/patch intersection (miss ${refinedHit.distanceTo(refinedPoint)})`);
assert.ok(offRay < 1e-4, `analytic contact must lie on its probe ray (off by ${offRay} m)`);

// Crossing a surface while moving OUT of it is not an air→ground transition. This is the one-tick false landing
// from Snowdream's first lip: the down probe found the steep far side 1.2 cm behind the deck, but velocity was
// separating along its normal at 11.8 m/s. Accepting it pitches the cached frame down before taking off again.
const separatingTicks: RideTelemetryTick[] = [];
const separatingModel = createRideModel({
  spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(1, 0, 0), terrain: floorTerrain,
  surfaceOf: () => 1, oobFloorY: -100, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: false, x: 0 }, onRespawn: () => {}, onTelemetryTick: frame => separatingTicks.push(frame),
});
separatingModel.start();
separatingModel.st.pos.set(0, -0.01, 0);
separatingModel.st.vel.set(5, 0.5, 0); // above the small transition-noise tolerance, still below the plane this tick
separatingModel.st.fwd.set(1, 0, 0);
separatingModel.st.grounded = false;
separatingModel.step(1 / 60);
const separatingTick = separatingTicks.at(-1)!;
assert.equal(separatingTick.closing.grounded, false,
  'an airborne rider separating from a penetrating far-side probe must stay airborne');
assert.equal(separatingTick.events.some(event => event.type === 'touchdown'), false,
  'a separating contact crossing must not manufacture a one-tick touchdown');

// The wall/bounce rows have a broad 20 cm band for their non-gameplay response. It must not let grounded redirect
// turn a rider DOWN a newly-hit far-side wall while they are already leaving it; genuine wall approach/riding has
// non-positive or near-zero normal speed and remains eligible.
const wallTicks: RideTelemetryTick[] = [];
const wallModel = createRideModel({
  spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(1, 0, 0), terrain: floorTerrain,
  surfaceOf: () => 10, oobFloorY: -100, keys: { left: false, right: false, tuck: false, brake: false, boost: false },
  stick: { active: false, x: 0 }, onRespawn: () => {}, onTelemetryTick: frame => wallTicks.push(frame),
  patchContact: (faceIndex, bary, outPoint, outNormal) => {
    const i = faceIndex * 3;
    outPoint.set(0, 0, 0)
      .addScaledVector(floorVertices[floorIndices[i]], bary.x)
      .addScaledVector(floorVertices[floorIndices[i + 1]], bary.y)
      .addScaledVector(floorVertices[floorIndices[i + 2]], bary.z);
    outNormal.copy(analyticNormal);
    return true;
  },
});
wallModel.start();
wallModel.st.pos.set(0, -0.01, 0);
wallModel.st.contactN.copy(analyticNormal);
wallModel.st.vel.copy(analyticNormal).multiplyScalar(5).add(new THREE.Vector3(5, 0, 0));
wallModel.st.grounded = true;
wallModel.step(1 / 60);
const leavingWall = wallTicks.at(-1)!;
assert.ok(leavingWall.events.some(event => event.type === 'takeoff'),
  'a rider separating from a wall/bounce face must leave its broad contact band');
assert.equal(leavingWall.redirect, undefined,
  'ground redirect must not rotate outward velocity down a newly-hit far-side wall');

console.log('RIDE TELEMETRY: PASS');
