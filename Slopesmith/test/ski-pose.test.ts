// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ANKLE_ABOVE_BASE, createBoard } from '../src/app/ride/gear';
import { createRider, type Rider, type RiderInput } from '../src/app/ride/rider';
import { RIDING_STYLES, ridingStyleOptions } from '../src/app/ride/stances';
import { RIDE_GROUND_TANGENTIAL_PULL } from '../src/app/ride/ride-contract.generated';

/**
 * What a *skier* is, as opposed to a snowboarder standing on skis.
 *
 * `rider-pose.test.ts` defends the body itself — that nothing stretches, nothing inverts, and a carve is a
 * carve — against the snowboard's ankle layout. This file defends the ONE thing gear changes: the body has
 * turned ninety degrees, and every axis derived from the two boots has to have turned with it. A regression
 * here does not crash and does not stretch anything; it draws a rider gliding down the hill sideways, or
 * laying into a turn by folding forward instead. So the checks below are about DIRECTIONS, plus the same
 * anatomical floor the snowboard gets, run across all four ski styles.
 *
 * The deck frame throughout: +Z is the noses, +Y the tops, +X the rider's right. The gear is seated at the
 * ORIGIN, so `y = 0` is the flat snow and every height below is measured straight off it.
 */

const D2R = Math.PI / 180;
const NOSE = new THREE.Vector3(0, 0, 1);
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, 1, 0);

const skiModel = createBoard('skis');
const boardModel = createBoard('snowboard');

// ---------------------------------------------------------------- the gear itself
{
  // The whole ski body below only comes out facing forward because the two boots are side by side ACROSS the
  // deck rather than along it. That is a property of the model, so it is checked here rather than assumed.
  const span = skiModel.ankleFront.clone().sub(skiModel.ankleRear);
  assert(Math.abs(span.z) < 1e-9 && Math.abs(span.x) > 0.15,
    `a pair of skis should seat its two boots across the deck, not along it (got ${span.toArray()})`);
  assert(skiModel.ankleFront.x < 0,
    'ankleFront is the rider\'s anatomical LEFT when the feet face forward, which is the −X ski');
  const boardSpan = boardModel.ankleFront.clone().sub(boardModel.ankleRear);
  assert(Math.abs(boardSpan.x) < 1e-9 && boardSpan.z > 0.4,
    'a snowboard still seats its two bindings along the deck, nose-ward first');

  assert(boardModel.group.children.length === 1 && boardModel.group.children[0] instanceof THREE.Mesh,
    'the snowboard model should expose its topsheet without binding or proxy-boot meshes');
  assert(skiModel.group.children.every(pivot => pivot.children.length === 1
    && pivot.children[0] instanceof THREE.Mesh),
  'each ski model should expose its topsheet without binding or proxy-boot meshes');
  assert(!('carried' in skiModel) && !('hold' in skiModel),
    'ski gear should not create or place separate pole models');

  // Switching gear mid-run may not leave the body hovering or sunk: every generated and imported character is
  // modelled to one ankle height, and both stacks are built to reach exactly it.
  assert(Math.abs(skiModel.ankleFront.y - ANKLE_ABOVE_BASE) < 1e-12
    && Math.abs(boardModel.ankleFront.y - ANKLE_ABOVE_BASE) < 1e-12,
    'both gears must put the ankle joint the same height above the snow');
}

{
  // A carve, seated. A snowboard is ONE deck and takes the roll whole; a pair of skis may not, because rolled
  // about the pair's centre the outside ski leaves the snow. Each ski edges about its own centreline instead,
  // which is exactly the property measured here: both centrelines stay on the snow plane at any bank, and both
  // skis end up edged to the SAME angle.
  const bank = 44;
  const flat = new THREE.Quaternion();
  const rolled = new THREE.Quaternion().setFromAxisAngle(NOSE, -bank * D2R);
  const ankleA = new THREE.Vector3(), ankleB = new THREE.Vector3();
  skiModel.seat(new THREE.Vector3(), flat, rolled, ankleA, ankleB);
  skiModel.group.updateMatrixWorld(true);

  const pivots = skiModel.group.children;
  assert(pivots.length === 2, 'a pair of skis is two independently edged skis');
  const normals = pivots.map(pivot => {
    const world = new THREE.Vector3();
    pivot.getWorldPosition(world);
    assert(Math.abs(world.y) < 1e-9,
      `a ${bank}° carve left one ski's centreline ${(world.y * 100).toFixed(1)} cm off the snow`);
    return UP.clone().applyQuaternion(pivot.getWorldQuaternion(new THREE.Quaternion()));
  });
  assert(normals[0].angleTo(normals[1]) < 1e-9, 'both skis must edge in parallel, not against each other');
  assert(Math.abs(normals[0].angleTo(UP) / D2R - bank) < 1e-6,
    'each ski should carry the full carve angle about its own centreline');

  const boardAnkleA = new THREE.Vector3(), boardAnkleB = new THREE.Vector3();
  boardModel.seat(new THREE.Vector3(), flat, rolled, boardAnkleA, boardAnkleB);
  assert(boardModel.group.quaternion.angleTo(rolled) < 1e-9,
    'a snowboard is one rigid deck and takes the carve roll in its own transform');
  assert(skiModel.group.quaternion.angleTo(flat) < 1e-9,
    'a pair of skis carries facing only; the roll belongs to each ski');
  // The boots still go over with their own edge on both, so the ankle is lifted through the ROLLED frame.
  const expected = new THREE.Vector3(0, ANKLE_ABOVE_BASE, 0).applyQuaternion(rolled)
    .add(new THREE.Vector3(skiModel.ankleFront.x, 0, 0));
  assert(ankleA.distanceTo(expected) < 1e-9, 'a banked ski carries its own boot round with it');
}

// ---------------------------------------------------------------- the body's frame
let rider: Rider;
function point(name: string): THREE.Vector3 {
  const node = rider.group.getObjectByName(`rider.${name}`);
  assert(node, `missing named rider node ${name}`);
  return node.position;
}

const base: RiderInput = {
  ankleFront: new THREE.Vector3(), ankleRear: new THREE.Vector3(),
  deckUp: UP.clone(), soleUp: UP.clone(), bank: 0,
  vel: new THREE.Vector3(), accel: new THREE.Vector3(),
  grounded: true, dt: 1 / 60, crouch: 0, lean: 0,
};

/**
 * A carve built the way `pose.ts` builds one, on either kit: the deck takes its facing basis and the same
 * basis rolled onto its edge, the gear decides what to do with them, and the ankles come back out. The
 * centripetal load of a turn held at that angle rides along, because a rider decides which way is up from
 * apparent gravity and a carve with no load is a rider being flung sideways off a tilted deck.
 */
function carving(gear: 'snowboard' | 'skis', lean: number, bankDeg: number,
                 extra: Partial<RiderInput> = {}): RiderInput {
  const model = gear === 'skis' ? skiModel : boardModel;
  const flat = new THREE.Quaternion();
  const rolled = new THREE.Quaternion().setFromAxisAngle(NOSE, -bankDeg * D2R);
  const ankleFront = new THREE.Vector3(), ankleRear = new THREE.Vector3();
  model.seat(new THREE.Vector3(), flat, rolled, ankleFront, ankleRear);
  return {
    ...base, ankleFront, ankleRear,
    soleUp: UP.clone().applyQuaternion(rolled),
    bank: bankDeg, lean, vel: new THREE.Vector3(0, 0, 22),
    accel: new THREE.Vector3(RIDE_GROUND_TANGENTIAL_PULL * Math.tan(bankDeg * D2R), 0, 0),
    ...extra,
  };
}

const skiNeutral = carving('skis', 0, 0);
const boardNeutral = carving('snowboard', 0, 0);

/** Hold a ski stance for a few seconds, the way riding an edge does — long enough for the arm spring to
 *  settle onto it, starting from a fresh flat cruise each time so nothing carries over between stances. */
function settle(input: RiderInput, frames = 180) {
  rider.reset(skiNeutral);
  for (let frame = 0; frame < frames; frame++) rider.pose(input);
}

{
  // THE ONE THING GEAR CHANGES. A skier faces where they are going and spans their own shoulders across that;
  // a snowboarder faces the toe edge and spans their shoulders along the deck. Both fall out of the same two
  // cross products in `rider.ts`, so this is the check that the triad turned with the feet.
  rider = createRider(undefined, 'balanced', 'skis');
  rider.reset(skiNeutral);
  assert(rider.solved.feet === 'forward',
    'a skier\'s feet are side by side and point down the fall line, like a walker\'s');
  assert(rider.solved.toe.dot(NOSE) > 0.99,
    `a skier's chest and knees should face the fall line (toe·nose = ${rider.solved.toe.dot(NOSE).toFixed(3)})`);
  assert(Math.abs(rider.solved.along.dot(NOSE)) < 0.01 && rider.solved.along.dot(RIGHT) < -0.99,
    'a skier\'s hips and shoulders span their own lateral, front (left) toward −X');
  assert(rider.solved.headForward.dot(NOSE) > 0.98, 'and the face looks down the course, not across it');

  const shoulders = rider.solved.shoulderFront.clone().sub(rider.solved.shoulderRear);
  assert(Math.abs(shoulders.dot(NOSE)) < 0.03 * shoulders.length(),
    'a skier\'s shoulder line is square to travel, so the chase camera sees a back and not a shoulder');
  const hips = rider.solved.hipFront.clone().sub(rider.solved.hipRear);
  assert(hips.dot(RIGHT) < 0, 'the left hip belongs over the left ski; crossed hips means crossed legs');
  assert(Math.abs(rider.solved.ankleFront.x - skiNeutral.ankleFront.x) < 1e-9,
    'and the feet stay bolted to their own bindings');

  const board = createRider(undefined, 'balanced', 'snowboard');
  board.reset(boardNeutral);
  assert(board.solved.feet === 'bindings', 'a snowboarder\'s feet keep their binding angles');
  assert(board.solved.toe.dot(RIGHT) > 0.99 && board.solved.along.dot(NOSE) > 0.99,
    'a snowboarder still stands across the deck, chest to the toe edge');
  const boardShoulders = board.solved.shoulderFront.clone().sub(board.solved.shoulderRear);
  assert(Math.abs(boardShoulders.dot(NOSE)) > 0.6 * boardShoulders.length(),
    'and spans their shoulders along the board, which is what makes the two silhouettes different at all');
  board.dispose();
}

// ---------------------------------------------------------------- the two turns
const STYLE_IDS = ridingStyleOptions().map(style => style.id);
assert(STYLE_IDS.length === 4, 'the ski table is generated per style id; keep the two catalogues in step');

{
  // A skier's two turns ARE each other reflected — unlike a snowboarder's two edges, which are held
  // differently. `stances.ts` gets that by authoring one and mirroring it, so the tables must agree.
  for (const id of STYLE_IDS) {
    const { heel: left, toe: right, neutral: cruise } = RIDING_STYLES.skis[id];
    const same = (a: number, b: number, key: string) =>
      assert(Math.abs(a - b) < 1e-9, `ski ${id}: ${key} is not mirrored (${a} vs ${b})`);
    same(right.inclination, -left.inclination, 'inclination');
    same(right.hipFore, -left.hipFore, 'hipFore');
    same(right.chestFore, -left.chestFore, 'chestFore');
    same(right.counterRotation, -left.counterRotation, 'counterRotation');
    same(right.shoulderSlope, -left.shoulderSlope, 'shoulderSlope');
    same(right.headYaw, -left.headYaw, 'headYaw');
    same(right.kneeTrackFront, -left.kneeTrackRear, 'kneeTrackFront');
    same(right.leadUpperSwing, 180 - left.trailUpperSwing, 'leadUpperSwing');
    same(right.trailForeSwing, 180 - left.leadForeSwing, 'trailForeSwing');
    // A fold at the waist is the one signed quantity that does NOT flip: its axis turns over with its sense.
    same(right.angulation, left.angulation, 'angulation');
    same(right.hipHeight, left.hipHeight, 'hipHeight');
    // Cruising straight, a skier is not lopsided: the neutral has to be its own mirror.
    same(cruise.hipFore, 0, 'neutral hipFore');
    same(cruise.counterRotation, 0, 'neutral counterRotation');
    same(cruise.leadUpperSwing + cruise.trailUpperSwing, 180, 'neutral arm swings');
    same(cruise.leadForeSwing + cruise.trailForeSwing, 180, 'neutral forearm swings');
  }
}

const JOINTS = ['hips', 'upper-back', 'clavicle-root', 'head-bone', 'head',
  'hip-front', 'knee-front', 'hip-rear', 'knee-rear',
  'shoulder-front', 'elbow-front', 'hand-front',
  'shoulder-rear', 'elbow-rear', 'hand-rear'] as const;
/** Left and right are the same joint on opposite sides, so a mirrored pose swaps front for rear as well. */
const MIRROR_OF: Record<typeof JOINTS[number], typeof JOINTS[number]> = {
  hips: 'hips', 'upper-back': 'upper-back', 'clavicle-root': 'clavicle-root',
  'head-bone': 'head-bone', head: 'head',
  'hip-front': 'hip-rear', 'knee-front': 'knee-rear',
  'hip-rear': 'hip-front', 'knee-rear': 'knee-front',
  'shoulder-front': 'shoulder-rear', 'elbow-front': 'elbow-rear', 'hand-front': 'hand-rear',
  'shoulder-rear': 'shoulder-front', 'elbow-rear': 'elbow-front', 'hand-rear': 'hand-front',
};

// ---------------------------------------------------------------- every style, every stance
const H = 1.70;
const THIGH = 0.245 * H, SHIN = 0.246 * H, UPPER_ARM = 0.186 * H, FOREARM = 0.146 * H;
/** A ski's own waist is far narrower than a snowboard's, so an edged ski cuts a much shallower trench and the
 *  rider has correspondingly less room to reach into. Plus the few centimetres of spray any edge throws. */
const SKI_WAIST_HALF = 0.0645, SNOW_GRAZE = -0.03;
const JOINT_RADII: Record<string, number> = {
  'hip-front': 0.112, 'hip-rear': 0.112, 'knee-front': 0.102, 'knee-rear': 0.102,
  'shoulder-front': 0.085, 'shoulder-rear': 0.085, 'elbow-front': 0.06, 'elbow-rear': 0.06,
  'hand-front': 0.065, 'hand-rear': 0.065, 'head': 0.135,
};

const layIn: Array<{ style: string; degrees: number }> = [];

for (const id of STYLE_IDS) {
  rider = createRider(undefined, id, 'skis');

  // ------------------------------------------------------------- proportions
  rider.reset(skiNeutral);
  const leg = point('hip-front').distanceTo(point('knee-front'));
  assert(Math.abs(leg - THIGH) < 1e-5, `${id}: a ski stance may not stretch a thigh (${leg.toFixed(4)} m)`);
  assert(Math.abs(point('knee-front').distanceTo(skiNeutral.ankleFront) - SHIN) < 1e-5, `${id}: shin`);
  assert(Math.abs(point('shoulder-front').distanceTo(point('elbow-front')) - UPPER_ARM) < 1e-5, `${id}: arm`);
  assert(Math.abs(point('elbow-front').distanceTo(point('hand-front')) - FOREARM) < 1e-5, `${id}: forearm`);
  // A skier stands taller than a snowboarder — an upright ski stance spends less of its height on bent knees —
  // but is the same 1.70 m person, and the chase camera is framed for that. A hand's width either way.
  const silhouette = point('head').y + 0.135;
  assert(silhouette > 1.66 && silhouette < 1.80,
    `${id} skis ${silhouette.toFixed(3)} m tall on the snow, outside the sized silhouette`);

  // ------------------------------------------------------------- the stances a run actually holds
  const stances: Array<[string, RiderInput]> = [
    ['neutral', skiNeutral],
    ['left turn', carving('skis', -1, -44)],
    ['right turn', carving('skis', 1, 44)],
    ['half turn', carving('skis', 0.4, 18)],
    ['tuck', { ...skiNeutral, crouch: 1 }],
    ['coiled turn', carving('skis', 1, 44, { crouch: 1 })],
    ['popping', { ...skiNeutral, crouch: -1 }],
    ['airborne', { ...skiNeutral, grounded: false, vel: new THREE.Vector3(0, -8, 20) }],
    ['landing', { ...skiNeutral, accel: new THREE.Vector3(0, 240, 0), vel: new THREE.Vector3(0, -6, 20) }],
  ];
  for (const [name, input] of stances) {
    settle(input);
    const floor = -SKI_WAIST_HALF * Math.abs(Math.sin(input.bank * D2R)) + SNOW_GRAZE;
    for (const [joint, radius] of Object.entries(JOINT_RADII)) {
      const clearance = point(joint).y - radius;
      assert(clearance > floor,
        `${id} ${name}: the ${joint} is ${((floor - clearance) * 100).toFixed(1)} cm inside the snow`);
    }
    for (const joint of JOINTS) {
      const p = point(joint);
      assert(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
        `${id} ${name}: the ${joint} solved to a non-finite position`);
    }
  }

  // ------------------------------------------------------------- the turn itself
  // The body lays into the turn rather than merely riding on top of a tipped pair of skis, and it lays toward
  // the side the skis are edged onto. Measured off the ankle plane, which is where the legs start.
  const right = carving('skis', 1, 44);
  settle(right);
  const rightTurn = new Map(JOINTS.map(joint => [joint, point(joint).clone()]));
  const ankleMid = right.ankleFront.clone().add(right.ankleRear).multiplyScalar(0.5);
  const hipCentre = rightTurn.get('hips')!.clone().sub(ankleMid);
  const degrees = THREE.MathUtils.radToDeg(Math.atan2(hipCentre.x, hipCentre.y));
  assert(degrees > 20,
    `${id}: a committed turn should lay the hips into it, not sit them over the skis (${degrees.toFixed(1)}°)`);
  layIn.push({ style: id, degrees });

  // ...and the other way round is the same body reflected, which is what a skier's two turns are and a
  // snowboarder's two edges are not. The ankles, the load and the stance are all mirrored inputs, so any joint
  // that is not is a sign asymmetry somewhere in the frame.
  settle(carving('skis', -1, -44));
  for (const joint of JOINTS) {
    const here = point(joint);
    const there = rightTurn.get(MIRROR_OF[joint])!;
    const gap = Math.hypot(here.x + there.x, here.y - there.y, here.z - there.z);
    assert(gap < 2e-3,
      `${id}: the left turn's ${joint} is ${(gap * 1000).toFixed(1)} mm off the right turn's mirror image`);
  }

  rider.dispose();
}

// The four styles are one axis, realistic to arcade: each lays further into the turn than the last.
for (let i = 1; i < layIn.length; i++) {
  assert(layIn[i].degrees > layIn[i - 1].degrees + 1,
    `${layIn[i].style} should lay further into a turn than ${layIn[i - 1].style} `
    + `(${layIn[i - 1].degrees.toFixed(1)}° → ${layIn[i].degrees.toFixed(1)}°)`);
}

console.log(`SKI POSE TESTS PASSED — lay-in ${layIn.map(l => `${l.style} ${l.degrees.toFixed(1)}°`).join(', ')}`);
