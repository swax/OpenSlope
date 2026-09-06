// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlayerPosePublisher } from '../src/app/net/player-publisher';
import { RemotePlayerMotion, smoothDampVector } from '../src/app/net/remote-player-motion';
import {
  PLAYER_JOIN_DISTANCE, PLAYER_VIEW_DISTANCE, playerNavigationTarget,
} from '../src/app/viewport/scene/remote-players';
import { sanitizePlayerPose, type LocalPlayerPose, type PlayerPose } from '../src/core/session/player-pose';
import { ALPINE_EXO_CHARACTER_ID, BUILTIN_CHARACTERS } from '../src/core/characters/builtins';

const source = (x = 0, velocity = 0): LocalPlayerPose => ({
  mode: 'edit', vr: false,
  body: { p: [x, 0, 0], q: [0, 0, 0, 1] },
  head: { p: [x, 1.65, 0], q: [0, 0, 0, 1] },
  velocity: [velocity, 0, 0],
});
const equipment = (state: 'mounted' | 'loose' | 'held', x = 0, velocity = 0, epoch = 0) => ({
  state, transform: { p: [x, 0, 0] as [number, number, number], q: [0, 0, 0, 1] as [number, number, number, number] },
  velocity: [velocity, 0, 0] as [number, number, number], epoch,
});

// Still participants reuse an identical sample between sparse heartbeats; motion changes immediately.
const publisher = createPlayerPosePublisher();
const first = publisher.sample(source(), 'stick-figure.glb', 1_000);
assert.equal(publisher.sample(source(), 'stick-figure.glb', 1_080), first,
  'an idle camera does not turn disposable awareness into a continuous stream');
const heartbeat = publisher.sample(source(), 'stick-figure.glb', 2_001);
assert.equal(heartbeat.seq, first.seq + 1, 'a still player occasionally refreshes its authoritative pose');
const moved = publisher.sample(source(2, 25), 'stick-figure.glb', 2_081);
assert.equal(moved.seq, heartbeat.seq + 1, 'a moving player publishes at the room cadence');
const jumped = publisher.sample(source(40), 'stick-figure.glb', 2_161);
assert.equal(jumped.teleport, moved.teleport + 1, 'an unexplained owner jump advances the teleport epoch');
const pointing = publisher.sample({ ...source(40), gesture: {
  kind: 'point', hand: 'right', direction: [0.2, 0.3, 0.9327379], target: [41.23456, 0, -2], id: 4,
} }, 'stick-figure.glb', 2_241);
assert.equal(pointing.gesture?.hand, 'right', 'the pointing hand survives publisher preparation');
assert(Math.abs(Math.hypot(...pointing.gesture!.direction) - 1) < 1e-5,
  'the published pointing ray remains normalized');
assert.deepEqual(pointing.gesture?.target, [41.235, 0, -2], 'the clicked world target is position-quantized');

const bothPoints = publisher.sample({
  ...source(40),
  gesture: { kind: 'point', hand: 'left', direction: [-0.2, 0.1, 0.97], id: 5 },
  gestures: [
    { kind: 'point', hand: 'left', direction: [-0.2, 0.1, 0.97], id: 5 },
    { kind: 'point', hand: 'right', direction: [0.2, 0.1, 0.97], id: 6 },
  ],
}, 'stick-figure.glb', 2_321);
assert.deepEqual(bothPoints.gestures?.map(point => point.hand), ['left', 'right'],
  'both independently held hands survive publisher preparation');
assert.deepEqual(sanitizePlayerPose(bothPoints, 2_321)?.gestures?.map(point => point.hand), ['left', 'right'],
  'server validation preserves a valid two-hand hold');
assert.equal(sanitizePlayerPose({
  ...bothPoints, gestures: [bothPoints.gestures![0], { ...bothPoints.gestures![1], hand: 'left' }],
}, 2_321), null, 'server validation rejects two holds claiming the same anatomical hand');

const flightPublisher = createPlayerPosePublisher();
const flying = flightPublisher.sample({
  ...source(), mode: 'walk',
  equipment: equipment('loose', 4, 0, 2),
  animation: { grounded: false, crouch: 0, lean: 0, bank: 0, flying: true },
}, 'stick-figure.glb', 1_000);
assert.equal(flying.animation?.flying, true, 'Superman state survives publisher preparation for remote gait');
assert.equal(sanitizePlayerPose(flying, 1_000)?.animation?.flying, true,
  'server validation preserves a valid Superman animation state');
assert.equal(sanitizePlayerPose({
  ...flying, animation: { ...flying.animation!, flying: 'yes' },
}, 1_000), null, 'server validation rejects a malformed Superman animation state');

const stancePublisher = createPlayerPosePublisher();
const standardSwitch = stancePublisher.sample({
  ...source(), mode: 'ride', gear: 'snowboard', stance: 'standard',
  equipment: equipment('mounted'),
  animation: { grounded: true, crouch: 0, lean: 0, bank: 0, lead: -1 },
}, 'stick-figure.glb', 1_000);
assert.equal(standardSwitch.gear, 'snowboard', 'the selected ride gear survives publisher preparation');
assert.equal(standardSwitch.stance, 'standard', 'standard/goofy footing survives publisher preparation');
assert.equal(sanitizePlayerPose(standardSwitch, 1_000)?.animation?.lead, -1,
  'the ridden end survives validation so a remote switch rider also looks downhill');
const switchTarget = playerNavigationTarget(standardSwitch);
assert(switchTarget.heading.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9,
  'player navigation follows the ridden end rather than the fixed deck nose');
assert.equal(switchTarget.position.distanceTo(switchTarget.join), PLAYER_JOIN_DISTANCE,
  'joining a live ride lands at the requested three-metre follow distance');
assert.equal(Math.hypot(
  switchTarget.eye.x - switchTarget.focus.x,
  switchTarget.eye.z - switchTarget.focus.z,
), PLAYER_VIEW_DISTANCE, 'the setup camera takes a wide horizontal view ahead of the moving player');

// Untrusted transforms are normalized and malformed/extreme values are rejected before rendering.
const accepted = sanitizePlayerPose({ ...first, body: { ...first.body, q: [0, 0, 0, 2] } }, 1_000);
assert.deepEqual(accepted?.body.q, [0, 0, 0, 1]);
for (const character of BUILTIN_CHARACTERS) {
  assert.equal(sanitizePlayerPose({ ...first, avatar: character.id }, 1_000)?.avatar, character.id,
    `the ${character.id} avatar survives server validation`);
}
assert.equal(sanitizePlayerPose({ ...first, avatar: 'builtin:space-marine' }, 1_000)?.avatar,
  ALPINE_EXO_CHARACTER_ID, 'an older peer avatar id is normalized to Alpine Exo');
assert.equal(sanitizePlayerPose({ ...first, avatar: 'builtin:nothing-like-it' }, 1_000), null,
  'an unknown builtin: id is not a file name and is rejected');
assert.equal(sanitizePlayerPose({ ...first, velocity: [Infinity, 0, 0] }, 1_000), null);
assert.equal(sanitizePlayerPose({ ...first, avatar: 'x'.repeat(161) }, 1_000), null);
const acceptedPoint = sanitizePlayerPose({ ...first, gesture: {
  kind: 'point', hand: 'left', direction: [0, 0, 0.5], target: [1, 2, 3], id: 8,
} }, 1_000);
assert.deepEqual(acceptedPoint?.gesture?.direction, [0, 0, 1], 'server validation normalizes a pointing ray');
assert.deepEqual(acceptedPoint?.gesture?.target, [1, 2, 3], 'server validation preserves a finite world target');
assert.equal(sanitizePlayerPose({ ...first, gesture: {
  kind: 'point', hand: 'middle', direction: [0, 0, 1], id: 8,
} }, 1_000), null, 'server validation rejects an unknown pointing hand');
assert.equal(sanitizePlayerPose({ ...first, version: 1 }, 1_000), null,
  'the replaced mounted-only version-1 pose is rejected rather than ambiguously interpreted');

// Equipment is an independently moving owner object: it survives validation, causes an awareness update while
// the walker stands still, and advances its own teleport epoch only when its local lifecycle says it relocated.
const equipmentPublisher = createPlayerPosePublisher();
const loose = equipmentPublisher.sample({
  ...source(), mode: 'walk', gear: 'skis', equipment: equipment('loose', 12, 6, 4),
}, 'procedural', 4_000);
assert.equal(loose.version, 2, 'the current player pose publishes protocol version 2');
assert.equal(loose.equipment?.state, 'loose', 'a loose pair of skis remains visible in the wire pose');
assert.deepEqual(loose.equipment?.transform.p, [12, 0, 0], 'equipment keeps its own world transform');
assert.deepEqual(loose.equipment?.velocity, [6, 0, 0], 'equipment keeps its own velocity for prediction');
assert(!('epoch' in loose.equipment!), 'the local lifecycle counter is not leaked onto the wire');
const coasted = equipmentPublisher.sample({
  ...source(), mode: 'walk', gear: 'skis', equipment: equipment('loose', 12.5, 6, 4),
}, 'procedural', 4_080);
assert.equal(coasted.seq, loose.seq + 1, 'equipment motion publishes even while its walking owner is still');
assert.equal(coasted.equipment?.teleport, loose.equipment?.teleport,
  'ordinary coasting retains one smooth equipment epoch');
const reparked = equipmentPublisher.sample({
  ...source(), mode: 'walk', gear: 'skis', equipment: equipment('loose', -30, 0, 5),
}, 'procedural', 4_160);
assert.equal(reparked.equipment!.teleport, coasted.equipment!.teleport + 1,
  'an explicit equipment re-park advances its independent teleport epoch');
assert.equal(sanitizePlayerPose(reparked, 4_160)?.equipment?.state, 'loose',
  'server validation preserves valid independently moving equipment');
assert.equal(sanitizePlayerPose({
  ...reparked, equipment: { ...reparked.equipment!, state: 'pocketed' },
}, 4_160), null, 'server validation rejects an unknown equipment ownership state');
assert.equal(sanitizePlayerPose({
  ...reparked, equipment: { ...reparked.equipment!, velocity: [Infinity, 0, 0] },
}, 4_160), null, 'server validation rejects an unsafe loose-equipment velocity');

// Unity-style SmoothDamp approaches without overshooting its moving carrot.
const dampVelocity = new THREE.Vector3();
let damped = new THREE.Vector3();
for (let frame = 0; frame < 60; frame++) {
  const next = smoothDampVector(damped, new THREE.Vector3(10, 0, 0), dampVelocity, 0.12, 1 / 60);
  assert(next.x >= damped.x && next.x <= 10, 'critical damping may approach but never overshoot');
  damped = next;
}
assert(damped.x > 9.9);

const packet = (seq: number, sampleAt: number, x: number, velocity: number, teleport = 0): PlayerPose => ({
  version: 2, seq, sampleAt, teleport, mode: 'ride', vr: false, avatar: 'procedural',
  body: { p: [x, 0, 0], q: [0, 0, 0, 1] },
  velocity: [velocity, 0, 0],
  equipment: {
    state: 'mounted', transform: { p: [x, 0, 0], q: [0, 0, 0, 1] },
    velocity: [velocity, 0, 0], teleport,
  },
});

const remote = new RemotePlayerMotion();
remote.push(packet(0, 0, 0, 20), 0);
remote.step(1 / 60, 0.2);
assert.equal(remote.position.x, 4, 'the first sample snaps to its latency-aged, velocity-extrapolated position');
remote.push(packet(1, 100, 1, 20), 0.1); // a packet landing behind the earlier prediction
remote.step(1 / 60, 0.2);
assert(remote.position.x < 4 && remote.position.x > 3,
  'a late correction bleeds backward smoothly instead of snapping the ghost');

const accelerating = new RemotePlayerMotion();
accelerating.push(packet(0, 0, 0, 10), 0);
accelerating.step(1 / 60, 0);
accelerating.push(packet(1, 100, 1.1, 12), 0.1);
assert(Math.abs(accelerating.acceleration.x - 7) < 1e-6,
  'consecutive velocities reconstruct the same clamped, low-passed acceleration as Unity');
accelerating.push(packet(2, 200, 100, 0, 1), 0.2);
accelerating.step(1 / 60, 0.2);
assert.equal(accelerating.position.x, 100, 'an explicit teleport epoch cuts directly to the new pose');

const remoteEquipment = new RemotePlayerMotion();
remoteEquipment.pushTransform(coasted.seq, coasted.equipment!.teleport,
  coasted.equipment!.transform, coasted.equipment!.velocity, 4.08);
remoteEquipment.step(1 / 60, 4.18);
assert(Math.abs(remoteEquipment.position.x - 13.1) < 1e-9,
  'loose equipment dead-reckons from its own pose and velocity, independently of its still owner');
remoteEquipment.pushTransform(reparked.seq, reparked.equipment!.teleport,
  reparked.equipment!.transform, reparked.equipment!.velocity, 4.16);
remoteEquipment.step(1 / 60, 4.16);
assert.equal(remoteEquipment.position.x, -30, 'an equipment-only teleport snaps directly to its re-parked pose');

console.log('multiplayer motion: publisher, validation, dead reckoning, damping, teleport passed');
