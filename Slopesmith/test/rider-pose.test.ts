// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBoard } from '../src/app/ride/gear';
import { createRider, type Rider, type RiderInput } from '../src/app/ride/rider';
import { fingerCurlAxis, gripToWristOffset, retargetHandWorldRotation } from '../src/app/ride/character-rig';
import { ridingStyleOptions } from '../src/app/ride/stances';
import { RIDE_GROUND_TANGENTIAL_PULL } from '../src/app/ride/ride-contract.generated';

/**
 * What a *correct* rider pose is — not what some other rider's pose was.
 *
 * There is no reference pose to match here and deliberately so: the stance model generates a body from named
 * riding quantities, so what these checks defend is that the generated body is anatomically a body (nothing
 * stretches, nothing inverts, the proportions are a person's), that it does what the named quantities say it
 * does (a carve inclines and angulates, a coil folds, a pop drives out), and that the two edges stay genuinely
 * distinct rather than collapsing into one reflected shape.
 *
 * Every one of those runs against **every** riding style, so a new or retuned style cannot ship a broken body.
 */

const neutral: RiderInput = {
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

// Imported hands are mirrored and their bind +Z commonly runs toward the thumb rather than out of the palm.
// Retarget the measured anatomical frame, so the visual palm and thumb land correctly without assuming axes.
{
  const restRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 0.4));
  const localFinger = new THREE.Vector3(0, 1, 0), localPalm = new THREE.Vector3(-1, 0, 0);
  const restFinger = localFinger.clone().applyQuaternion(restRotation);
  const restPalm = localPalm.clone().applyQuaternion(restRotation);
  const targetFinger = new THREE.Vector3(1, 0, 0), targetPalm = new THREE.Vector3(0, 0, -1);
  const posed = retargetHandWorldRotation(
    restRotation, restFinger, restPalm, targetFinger, targetPalm,
  );
  assert(localFinger.clone().applyQuaternion(posed).angleTo(targetFinger) < 1e-8,
    'hand retargeting should preserve the imported finger axis');
  assert(localPalm.clone().applyQuaternion(posed).angleTo(targetPalm) < 1e-8,
    'hand retargeting should put the imported visual palm forward instead of its back');

  const curlAxis = fingerCurlAxis(targetFinger, targetPalm);
  const firstCurl = targetFinger.clone().applyAxisAngle(curlAxis, 0.2);
  assert(firstCurl.dot(targetPalm) > 0,
    'a positive controller curl should bend a finger toward the open palm face, not backward');

  const smallPalm = gripToWristOffset(new THREE.Quaternion(), 0.06);
  const largePalm = gripToWristOffset(new THREE.Quaternion(), 0.14);
  assert(smallPalm.y < 0 && smallPalm.z < 0,
    'the wrist should sit behind the palm-centred controller along both the fingers and palm normal');
  assert(Math.abs(largePalm.y) > Math.abs(smallPalm.y),
    'controller seating should use the selected avatar palm length rather than a global offset');
}

let rider: Rider;
function point(name: string): THREE.Vector3 {
  const node = rider.group.getObjectByName(`rider.${name}`);
  assert(node, `missing named rider node ${name}`);
  return node.position;
}
function node(name: string): THREE.Object3D {
  const found = rider.group.getObjectByName(`rider.${name}`);
  assert(found, `missing named rider node ${name}`);
  return found;
}
function near(actual: number, expected: number, tolerance: number, message: string) {
  assert(Math.abs(actual - expected) <= tolerance,
    `${message}: got ${actual.toFixed(4)}, expected ${expected.toFixed(4)} ± ${tolerance}`);
}
function length(a: THREE.Vector3, b: THREE.Vector3, expected: number, label: string) {
  near(a.distanceTo(b), expected, 1e-5, `${label} length`);
}

/** Settle the figure into a stance, the way holding an edge for a few seconds does. Long enough that a style
 *  change (a 0.25 s half-life) has fully landed, not merely got close. */
function settle(input: RiderInput, frames = 180) {
  rider.reset(neutral);
  for (let frame = 0; frame < frames; frame++) rider.pose(input);
}

/**
 * A carve the way `pose.ts` actually builds one: the deck rolls about its own nose axis, and the **bindings
 * roll with it**. Passing a bank angle while leaving the ankles flat describes a board that rolled without
 * taking its bindings along, which is not a configuration the ride can ever be in — and it is exactly the case
 * where a knee looks fine on paper and goes through the snow on screen.
 *
 * The board sits at the origin, so the snow is the y = 0 plane. (The banked deck's own lower edge dips below it:
 * the roll is a pure rotation about the deck origin with no lift, which is what the ride does.)
 *
 * It also carries the **centripetal load a carve at that angle actually has** — `pull · tan(bank)`, into the
 * turn. That is not decoration: the rider decides which way is up from apparent gravity, and in a real carve
 * gravity plus the turn's own load points down the deck's normal, which is the whole reason a carve can be held
 * at all. Carving at this angle with zero acceleration describes a rider being flung sideways off a tilted
 * board, and it makes the balance stack stand the torso bolt upright against a deck it should be aligned with.
 */
const boardModel = createBoard();
function carving(lean: number, bankDeg: number, extra: Partial<RiderInput> = {}): RiderInput {
  const faceDir = new THREE.Vector3(0, 0, 1), deckUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(deckUp, faceDir).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, deckUp, faceDir));
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(faceDir, -bankDeg * Math.PI / 180));
  return {
    ...neutral,
    ankleFront: boardModel.ankleFront.clone().applyQuaternion(q),
    ankleRear: boardModel.ankleRear.clone().applyQuaternion(q),
    soleUp: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    bank: bankDeg, lean, vel: new THREE.Vector3(0, 0, 22),
    accel: new THREE.Vector3(RIDE_GROUND_TANGENTIAL_PULL * Math.tan(bankDeg * Math.PI / 180), 0, 0),
    ...extra,
  };
}

/** The drawn radius of each joint blob, so "is it in the snow" asks about the rider's surface, not a point. */
const JOINT_RADII: Record<string, number> = {
  'hip-front': 0.112, 'hip-rear': 0.112, 'knee-front': 0.102, 'knee-rear': 0.102,
  'shoulder-front': 0.085, 'shoulder-rear': 0.085, 'elbow-front': 0.06, 'elbow-rear': 0.06,
  'hand-front': 0.065, 'hand-rear': 0.065, 'head': 0.135,
};
/**
 * A knee or a hip may *graze* the snow at full commitment — that is the look the arcade end is going for — but
 * no part of the rider may be buried in it.
 *
 * The fixture's ankles sit on the deck's own roll axis, so they stay at y = 0 whatever the bank: this frame's
 * origin is the **ankle plane**, and the snow is a board, a binding and a boot sole below it. Measuring
 * clearance against y = 0 asks the rider to keep his knees above his own ankles, which no carve does — retail's
 * own toe-side knee sits about 10 cm below the ankle plane.
 */
/**
 * How deep the engaged edge itself is cutting, below the flat snow plane: the trench the rider is carving.
 *
 * A banked deck's lower edge dips by its own half-width, so the flat plane is a fiction on the inside of the
 * turn — the snow there has been cut away. The rider may therefore reach the depth of his own edge and a few
 * centimetres of spray beyond, but no further: past that he is inside undisturbed snow. Scaling the bound with
 * the bank is what lets a deeply committed carve drag a knee without letting a shallow one bury it.
 */
const WAIST_HALF = 0.175;
const SNOW_GRAZE = -0.03;
function trenchFloor(input: RiderInput) {
  return -WAIST_HALF * Math.abs(Math.sin(input.bank * Math.PI / 180)) + SNOW_GRAZE;
}
function lowestSurface() {
  let low = Infinity, name = '';
  for (const [joint, radius] of Object.entries(JOINT_RADII)) {
    const y = point(joint).y - radius + ANKLE_ABOVE_BASE;
    if (y < low) { low = y; name = joint; }
  }
  return { low, name };
}

/** Signed lean toward the engaged edge, in degrees off vertical: how far this segment has committed. */
function tiltToward(segment: THREE.Vector3, edge: number) {
  return THREE.MathUtils.radToDeg(Math.atan2(segment.x * edge, segment.y));
}

/**
 * A joint in the board's own frame: metres from the ankle midpoint, +x toe, +y deck up, +z noseward.
 *
 * Every carve measurement below is taken here rather than in world axes, and that is not a detail. Under a 44°
 * deck a lateral world distance is mostly the deck's own roll, so a rider whose body barely moves on the board
 * and one being thrown around by it measure nearly the same — which is how a rider whose hips leaned the *wrong
 * way entirely* once passed as correct. Retail's rider was measured in this same frame
 * ([Trailmap: 240-models-mpf]), which is what lets the two be compared at all.
 */
function boardFrame(input: RiderInput) {
  const origin = input.ankleFront.clone().add(input.ankleRear).multiplyScalar(0.5);
  const nose = input.ankleFront.clone().sub(input.ankleRear).normalize();
  const up = input.soleUp.clone().normalize();
  const toe = new THREE.Vector3().crossVectors(up, nose).normalize();
  return (world: THREE.Vector3) => {
    const local = world.clone().sub(origin);
    return new THREE.Vector3(local.dot(toe), local.dot(up), local.dot(nose));
  };
}

/** The included hip angle, knee → hip → neck. 180° is a straight body; a carve should show a visible bend. */
function hipAngle(hip: string, knee: string) {
  return THREE.MathUtils.radToDeg(
    point(knee).clone().sub(point(hip)).angleTo(point('clavicle-root').clone().sub(point(hip))));
}

const JOINTS = ['hips', 'upper-back', 'clavicle-root', 'head-bone', 'head',
  'hip-front', 'knee-front', 'hip-rear', 'knee-rear',
  'shoulder-front', 'elbow-front', 'hand-front',
  'shoulder-rear', 'elbow-rear', 'hand-rear'] as const;
const snapshot = () => new Map(JOINTS.map(n => [n, point(n).clone()]));
const farthest = (a: Map<string, THREE.Vector3>, b: Map<string, THREE.Vector3>) =>
  Math.max(...JOINTS.map(n => a.get(n)!.distanceTo(b.get(n)!)));

// The segments are standard anthropometric fractions of a 1.70 m stature, so the figure is proportioned like a
// person rather than to any particular model's bone table. They are the body, not the stance, so no style
// changes them — and femur and tibia come out the same length, which is what a human is.
const H = 1.70;
const THIGH = 0.245 * H, SHIN = 0.246 * H, UPPER_ARM = 0.186 * H, FOREARM = 0.146 * H;
const REACH = (THIGH + SHIN) * 0.998, ARM_REACH = (UPPER_ARM + FOREARM) * 0.998;
const ANKLE_ABOVE_BASE = 0.144;   // board, binding and boot under the ankle joint
assert(Math.abs(THIGH - SHIN) < 0.003, 'femur and tibia should be the same length');

const STANCES: Array<[string, RiderInput]> = [
  ['neutral', neutral],
  ['heel carve', carving(-1, -44)],
  ['toe carve', carving(1, 44)],
  ['half heel', carving(-0.4, -18)],
  ['coiled', { ...neutral, crouch: 1 }],
  ['coiled heel carve', carving(-1, -44, { crouch: 1 })],
  ['coiled toe carve', carving(1, 44, { crouch: 1 })],
  ['popping', { ...neutral, crouch: -1 }],
  ['airborne', { ...neutral, grounded: false, vel: new THREE.Vector3(0, -8, 20) }],
  ['landing', { ...neutral, accel: new THREE.Vector3(0, 240, 0), vel: new THREE.Vector3(0, -6, 20) }],
  ['hard carve accel', carving(1, 44, { accel: new THREE.Vector3(20, 0, 0) })],
];

const styles = ridingStyleOptions();
assert(styles.length >= 2, 'there should be more than one riding style to choose between');
const carvePoses = new Map<string, Map<string, THREE.Vector3>>();
const axis: Array<{ style: string; edge: string; inside: number; up: number; hip: number;
  head: number; hips: number }> = [];
let worstMirror = 0;

for (const style of styles) {
  rider = createRider(undefined, style.id);
  const s = style.label;

  // ------------------------------------------------------------- proportions
  rider.reset(neutral);
  length(point('hip-front'), point('knee-front'), THIGH, `${s} front thigh`);
  length(point('knee-front'), neutral.ankleFront, SHIN, `${s} front shin`);
  length(point('shoulder-front'), point('elbow-front'), UPPER_ARM, `${s} front upper arm`);
  length(point('elbow-front'), point('hand-front'), FOREARM, `${s} front forearm`);
  // A style may ride taller or lower, but it may not turn the rider into a different person: the on-board
  // silhouette the deck and chase camera are sized for stays within a few centimetres of 1.70 m.
  const silhouette = point('head').y + 0.135 + ANKLE_ABOVE_BASE;
  assert(silhouette > 1.63 && silhouette < 1.78,
    `${s} rides ${silhouette.toFixed(3)} m tall on the snow, outside the sized silhouette`);
  // Realistic is where the figure's own proportions are defined, so it is the one pinned to the 1.70 m the deck
  // and the chase camera are sized for. The arcade end cruises a couple of centimetres lower and is allowed to.
  if (style.id === 'realistic') near(silhouette, 1.70, 0.012, 'the reference style on the snow');

  // ------------------------------------------------------- a body, in every stance
  for (const [label, input] of STANCES) {
    const what = `${s} ${label}`;
    settle(input);

    length(point('hip-front'), point('knee-front'), THIGH, `${what} front thigh`);
    length(point('knee-front'), input.ankleFront, SHIN, `${what} front shin`);
    length(point('hip-rear'), point('knee-rear'), THIGH, `${what} rear thigh`);
    length(point('knee-rear'), input.ankleRear, SHIN, `${what} rear shin`);
    length(point('shoulder-front'), point('elbow-front'), UPPER_ARM, `${what} front upper arm`);
    length(point('elbow-front'), point('hand-front'), FOREARM, `${what} front forearm`);
    length(point('shoulder-rear'), point('elbow-rear'), UPPER_ARM, `${what} rear upper arm`);
    length(point('elbow-rear'), point('hand-rear'), FOREARM, `${what} rear forearm`);

    for (const [hip, ankle, knee, side] of [
      [point('hip-front'), input.ankleFront, point('knee-front'), 'front'],
      [point('hip-rear'), input.ankleRear, point('knee-rear'), 'rear'],
    ] as const) {
      assert(hip.distanceTo(ankle) <= REACH + 1e-6,
        `${what} ${side} hip is beyond the leg's reach (${hip.distanceTo(ankle).toFixed(4)} m)`);
      // The knee must be genuinely off the hip→ankle chord — a straight leg here would mean the solver gave up.
      const chord = ankle.clone().sub(hip);
      const offset = knee.clone().sub(hip);
      offset.addScaledVector(chord, -offset.dot(chord) / chord.lengthSq());
      assert(offset.length() > 0.02, `${what} ${side} knee is locked straight`);
      // And it bends over the toes, never backwards into the heel edge.
      const toe = new THREE.Vector3(1, 0, 0)
        .applyAxisAngle(new THREE.Vector3(0, 0, 1), -(input.bank ?? 0) * Math.PI / 180);
      assert(offset.dot(toe) > 0, `${what} ${side} knee bends the wrong way`);
    }
    assert(point('hand-front').distanceTo(point('shoulder-front')) <= ARM_REACH + 1e-6,
      `${what} front hand is beyond the arm's reach`);
    assert(point('hand-rear').distanceTo(point('shoulder-rear')) <= ARM_REACH + 1e-6,
      `${what} rear hand is beyond the arm's reach`);

    near(point('shoulder-front').distanceTo(point('shoulder-rear')), 0.33, 1e-6, `${what} shoulder span`);
    near(node('torso-lower').scale.y, point('hips').distanceTo(point('upper-back')), 1e-5,
      `${what} lower torso on the skeleton`);
    near(node('torso-upper').scale.y, point('upper-back').distanceTo(point('clavicle-root')), 1e-5,
      `${what} upper torso on the skeleton`);
    near(node('clavicle-front').scale.y, point('clavicle-root').distanceTo(point('shoulder-front')), 1e-5,
      `${what} front clavicle on the skeleton`);
    near(node('clavicle-rear').scale.y, point('clavicle-root').distanceTo(point('shoulder-rear')), 1e-5,
      `${what} rear clavicle on the skeleton`);
    near(node('neck').scale.y, point('clavicle-root').distanceTo(point('head')), 1e-5,
      `${what} neck on the skeleton`);
    near(point('head-bone').distanceTo(point('head')), 0.105, 1e-5, `${what} head shell offset`);
    if (input.grounded !== false) {
      // The eyes stay near the horizon: under a 44° deck the head keeps well under a third of that, so a rider
      // in the deepest coiled carve tips their head a little into it rather than lying over with the board.
      const headUp = point('head').clone().sub(point('head-bone'));
      const headTilt = THREE.MathUtils.radToDeg(headUp.angleTo(new THREE.Vector3(0, 1, 0)));
      assert(headTilt < 15,
        `${what} head should reject most of the board's roll (tilted ${headTilt.toFixed(1)}°)`);
      // The rider may put a knee or a hip *on* the snow at full commitment — that is what the arcade end of the
      // axis is for — but never inside it. This is the bound that replaced the old "a body may not incline
      // further than its own edge angle" rule, which was real-world carving technique rather than physics.
      const { low, name } = lowestSurface();
      const floor = trenchFloor(input);
      assert(low > floor,
        `${what} buries its ${name} ${(-low * 100).toFixed(0)} cm down, past the `
        + `${(-floor * 100).toFixed(0)} cm its own edge is cutting`);
    }
  }

  // The neck is a neck: the helmet swallows most of the neck-base → head-centre span, and what is left is the
  // few centimetres that should show above a collar.
  rider.reset(neutral);
  const visibleNeck = node('neck').scale.y - node('helmet').scale.x;
  assert(visibleNeck > 0.02 && visibleNeck < 0.09, `${s} has ${(visibleNeck * 100).toFixed(1)} cm of visible neck`);

  // ----------------------------------------------------------------- the carves
  // The deck rolls by lean · 50° about its nose, so negative lean edges onto the heels and positive onto the
  // toes. What every style owes is only that it commits *into* its own turn; how far, and how much of that the
  // upper body takes, is the axis's business and is checked across the styles below.
  const heelInput = carving(-1, -44), toeInput = carving(1, 44);
  settle(heelInput);
  const heel = snapshot();
  settle(toeInput);
  const toe = snapshot();
  rider.reset(neutral);
  const rest = snapshot();
  carvePoses.set(style.id, heel);

  for (const [label, pose, input, edge] of [
    ['heel', heel, heelInput, -1], ['toe', toe, toeInput, 1],
  ] as const) {
    const what = `${s} ${label} carve`;
    const toBoard = boardFrame(input);
    const hips = toBoard(pose.get('hips')!), head = toBoard(pose.get('head')!);
    // **A carving rider's hips are inside the turn.** Measured across the board from the ankle line they sit
    // toward the edge that is engaged, and retail's do on both edges. Hips on the *outside* mean the legs fell
    // short of the deck's own roll, which on screen is the body being thrown about by its own board — the one
    // failure this whole set of measurements exists to catch.
    const inside = hips.x * edge;
    assert(inside > 0.10,
      `a committed ${what} should carry the hips inside the turn, over the engaged edge `
      + `(got ${Math.abs(inside * 100).toFixed(1)} cm ${inside < 0 ? 'outside — the legs fell short of the '
        + 'deck instead of laying past it' : 'inside'})`);
    // The same statement as an angle: how far past the deck's own normal the legs have laid.
    const past = tiltToward(hips, edge);
    assert(past > 8 && past < 45,
      `${what} should lay the legs past the deck without folding flat (got ${past.toFixed(1)}° past the normal)`);
    assert(pose.get('head')!.distanceTo(rest.get('head')!) > 0.10, `a committed ${what} should move the head`);
    settle(input);
    axis.push({ style: s, edge: label, inside, up: hips.y, head: head.x, hips: hips.x,
      hip: (hipAngle('hip-front', 'knee-front') + hipAngle('hip-rear', 'knee-rear')) / 2 });
  }

  // The two edges are authored independently, because a snowboarder's are: a toe edge is held by extending the
  // ankle and a heel edge by sitting back and folding, so one is not the other reflected. Mirror the settled
  // heel pose across the board's long axis and it must not land on the toe pose.
  let mirrorMax = 0, mirrorMin = Infinity;
  for (const name of JOINTS) {
    const mirrored = heel.get(name)!.clone().setX(-heel.get(name)!.x);
    const divergence = mirrored.distanceTo(toe.get(name)!);
    mirrorMax = Math.max(mirrorMax, divergence);
    mirrorMin = Math.min(mirrorMin, divergence);
  }
  assert(mirrorMax > 0.10, `${s}'s edges have collapsed into one mirrored pose `
    + `(largest joint divergence ${(mirrorMax * 100).toFixed(1)} cm)`);
  assert(mirrorMin > 0.01, `${s} poses some joint identically on both edges`);
  worstMirror = Math.max(worstMirror, mirrorMax);

  // ------------------------------------------------------------- coil, and pop
  // The coil is a fold at the waist, not an elevator: the shoulders travel much further than the hips, and the
  // chest moves across the deck on the way down rather than straight down it.
  settle({ ...neutral, crouch: 1 });
  const coiled = snapshot();
  const hipDrop = rest.get('hips')!.y - coiled.get('hips')!.y;
  const shoulderDrop = rest.get('clavicle-root')!.y - coiled.get('clavicle-root')!.y;
  assert(hipDrop > 0.15, `${s}'s coil should drop the hips (got ${(hipDrop * 100).toFixed(1)} cm)`);
  assert(shoulderDrop > hipDrop * 1.3, `${s}'s coil should fold, not translate `
    + `(hips ${(hipDrop * 100).toFixed(1)} cm, shoulders ${(shoulderDrop * 100).toFixed(1)} cm)`);
  assert(Math.abs(coiled.get('clavicle-root')!.x - rest.get('clavicle-root')!.x) > 0.04,
    `${s}'s coil should carry the chest across the deck, not only down`);

  // The pop drives the legs out past standing — and still never locks one straight.
  settle({ ...neutral, crouch: -1 });
  assert(point('hips').y - rest.get('hips')!.y > 0.05,
    `${s}'s full pop should drive the hips above their standing height`);
  assert(point('hip-front').distanceTo(neutral.ankleFront) <= REACH + 1e-6,
    `${s}'s pop straightened the front leg past reach`);
  assert(point('hip-rear').distanceTo(neutral.ankleRear) <= REACH + 1e-6,
    `${s}'s pop straightened the rear leg past reach`);

  rider.dispose();
}

// No two styles may be the same rider. The comparison is a committed edge, not a neutral cruise: standing on a
// flat base is nearly the same in every style by design, and it is the carve the axis is about.
for (let a = 0; a < styles.length; a++) {
  for (let b = a + 1; b < styles.length; b++) {
    const apart = farthest(carvePoses.get(styles[a].id)!, carvePoses.get(styles[b].id)!);
    assert(apart > 0.04, `${styles[a].label} and ${styles[b].label} carve the same `
      + `(largest joint difference ${(apart * 100).toFixed(1)} cm)`);
  }
}

// ------------------------------------------------------------------- the axis
// The styles are declared in one order and that order means something: realistic → arcade is **how far the body
// lays into the turn, past the board's own roll**. Every style lays past it; what separates them is how far,
// how low the hips end up, and how much of the motion the head inherits. The four are a *dial*, and each step
// has to move it the same way. Break the ordering and the dropdown stops meaning anything.
for (const edge of ['heel', 'toe']) {
  const along = axis.filter(a => a.edge === edge);
  assert(along.length === styles.length, `every style should have contributed a ${edge} carve`);
  for (let i = 1; i < along.length; i++) {
    const prev = along[i - 1], here = along[i];
    assert(here.inside > prev.inside + 0.02,
      `${here.style} should lay further into the ${edge} turn than ${prev.style} does `
      + `(hips ${(here.inside * 100).toFixed(1)} cm inside vs ${(prev.inside * 100).toFixed(1)} cm)`);
    assert(here.up < prev.up + 0.005,
      `${here.style} should carve no taller than ${prev.style} does `
      + `(hips ${(here.up * 100).toFixed(1)} cm up vs ${(prev.up * 100).toFixed(1)} cm)`);
  }
  // A body laid over could still be a straight plank. It has to fold at the hip instead — that bend is the
  // sitting posture a carve is read by, and a straight one is the "flopping about" look.
  for (const a of along) {
    assert(a.hip > 80 && a.hip < 165,
      `${a.style}'s ${edge} carve should hold a hip bend, not a straight body (got ${a.hip.toFixed(0)}°)`);
  }
}

// **How much of the turn the head inherits is the other half of the dial.** A snowboarder turns from the feet
// up, and how far the head is allowed to follow is a matter of technique: a trained rider actively stabilises
// it and lets the lower body swing beneath, while the arcade read simply lays the whole body over together.
// Retail sits at the arcade end, with the head travelling a little further than the hips rather than less —
// what makes its rider read as steady is that both travel *far less* than a body thrown out of the turn does,
// not that the head is the quieter joint. So this checks the ordering and a sane band, not a fixed ratio.
const ratios = styles.map(style => {
  const heel = axis.find(a => a.style === style.label && a.edge === 'heel')!;
  const toe = axis.find(a => a.style === style.label && a.edge === 'toe')!;
  return { style: style.label, ratio: Math.abs(toe.head - heel.head) / Math.abs(toe.hips - heel.hips) };
});
for (let i = 1; i < ratios.length; i++) {
  assert(ratios[i].ratio > ratios[i - 1].ratio,
    `${ratios[i].style} should let the head follow the turn more than ${ratios[i - 1].style} does `
    + `(${ratios[i].ratio.toFixed(2)}× the hips' travel vs ${ratios[i - 1].ratio.toFixed(2)}×)`);
}
assert(ratios[0].ratio < 1,
  `the realistic end should hold the head steadier than the hips it stands on `
  + `(got ${ratios[0].ratio.toFixed(2)}×)`);
assert(ratios[ratios.length - 1].ratio < 2,
  `even the arcade end should not whip the head around at multiples of its hips `
  + `(got ${ratios[ratios.length - 1].ratio.toFixed(2)}×)`);

// ------------------------------------------------------------------ style changes
// A style can be handed over mid-run. Nothing is rebuilt, so the body must *cross* to it — and it must arrive
// exactly where being created in that style would have put it, or the dropdown and a fresh ride disagree.
// Held on an edge, which is where styles differ — on a flat base they are nearly the same figure by design —
// and between the two ends of the axis, which is the largest change the dropdown can ask for.
const first = styles[0], second = styles[styles.length - 1];
const onEdge = carving(-1, -44);
rider = createRider(undefined, first.id);
for (let frame = 0; frame < 180; frame++) rider.pose(onEdge);
const before = snapshot();
rider.setStyle(second.id);
rider.pose(onEdge);
const afterOneFrame = snapshot();
for (let frame = 0; frame < 300; frame++) rider.pose(onEdge);
const crossed = snapshot();
rider.dispose();

rider = createRider(undefined, second.id);
for (let frame = 0; frame < 180; frame++) rider.pose(onEdge);
const built = snapshot();
rider.dispose();

const styleTravel = farthest(before, crossed);
assert(styleTravel > 0.03, 'the style fixture must produce a visible change');
assert(farthest(before, afterOneFrame) < styleTravel * 0.25, 'a style change snaps instead of crossing');
// A tenth of a millimetre, not zero: the arm spring and the absorber settle asymptotically under a real carve
// load, so both riders are still converging on the same pose rather than sitting exactly on it.
assert(farthest(crossed, built) < 1e-4,
  `crossing to ${second.label} lands ${(farthest(crossed, built) * 1000).toFixed(3)} mm from being built in it`);

// Re-selecting the style already being ridden must not restart a crossing.
rider = createRider(undefined, first.id);
for (let frame = 0; frame < 180; frame++) rider.pose(neutral);
const held = snapshot();
rider.setStyle(first.id);
rider.pose(neutral);
assert(farthest(held, snapshot()) < 1e-9, 'reselecting the live style disturbed the pose');

// ------------------------------------------------------------------ transitions
// Physics may reverse the requested edge in one tick; a body crosses between stances on a 140 ms half-life,
// which is about as long as a rider takes to change edges. Everything outside this model stays immediate.
//
// Progress is measured as distance *remaining* to the settled pose, not as distance covered: a shoulder crossing
// between edges swings through an arc, so how far it has come from where it started is not monotone and says
// nothing useful about whether the crossing is easing.
function crossing(from: RiderInput, to: RiderInput, joint: string) {
  rider.reset(from);
  for (let frame = 0; frame < 120; frame++) rider.pose(from);
  const start = point(joint).clone();
  const trace: THREE.Vector3[] = [];
  for (let frame = 0; frame < 120; frame++) { rider.pose(to); trace.push(point(joint).clone()); }
  const settled = trace[119];
  const remaining = (frames: number) => trace[frames - 1].distanceTo(settled) / start.distanceTo(settled);
  return { travel: start.distanceTo(settled), remaining };
}

rider = createRider();
for (const joint of ['shoulder-front', 'head']) {
  const reversal = crossing({ ...neutral, bank: 40, lean: 1 }, { ...neutral, bank: -40, lean: -1 }, joint);
  assert(reversal.travel > 0.2, `an edge reversal must move the ${joint} visibly`);
  assert(reversal.remaining(1) > 0.7, `the ${joint} teleports on the first frame of a reversal`);
  assert(reversal.remaining(28) < 0.3, `the ${joint} has not crossed within the 0.47 s a stance change takes`);
  assert(reversal.remaining(60) < 0.05, `the ${joint} never settles onto the opposite stance`);

  const engage = crossing(neutral, { ...neutral, bank: 40, lean: 1 }, joint);
  assert(engage.travel > 0.1, `engaging an edge must move the ${joint} visibly`);
  assert(engage.remaining(1) > 0.7, `the ${joint} teleports on the first frame of an edge engagement`);
  assert(engage.remaining(60) < 0.05, `the ${joint} never settles onto the engaged edge`);
}

// ---------------------------------------------------------------- tracked local body
// A WebXR head is the top of the rider, not an ornamental node on the default animation. Translating it must
// carry the pelvis and shoulders while the feet remain on their bindings; otherwise looking down still shows a
// canned rider beneath a correctly positioned (and first-person-hidden) skull.
rider.reset(neutral);
const untrackedHips = point('hips').clone();
const untrackedShoulders = point('shoulder-front').clone().add(point('shoulder-rear')).multiplyScalar(0.5);
rider.group.updateMatrixWorld(true);
const untrackedView = node('eye-left').getWorldPosition(new THREE.Vector3())
  .add(node('eye-right').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
const trackedView = untrackedView.clone().add(new THREE.Vector3(0.24, -0.28, 0.16));
const trackedLook = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
rider.reset({
  ...neutral,
  headTarget: { position: trackedView, quaternion: trackedLook, exactPosition: true },
});
rider.group.updateMatrixWorld(true);
const trackedEyeCentre = node('eye-left').getWorldPosition(new THREE.Vector3())
  .add(node('eye-right').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
assert(trackedEyeCentre.distanceTo(trackedView) < 1e-8,
  'the local HMD must land exactly at the rider’s eye-bridge viewpoint');
assert(point('head').distanceTo(trackedView) > 0.1,
  'the HMD viewpoint must not be mistaken for the helmet centre');
assert(point('hips').distanceTo(untrackedHips) > 0.08,
  'tracked head translation should carry the pelvis instead of stretching an invisible neck');
const trackedShoulders = point('shoulder-front').clone().add(point('shoulder-rear')).multiplyScalar(0.5);
assert(trackedShoulders.distanceTo(untrackedShoulders) > 0.12,
  'tracked head translation should rebuild the visible shoulders beneath it');
const trackedSpine = point('clavicle-root').clone().sub(point('upper-back')).normalize();
const trackedShoulderSpan = point('shoulder-front').clone().sub(point('shoulder-rear')).normalize();
const trackedChestForward = new THREE.Vector3().crossVectors(trackedSpine, trackedShoulderSpan).normalize();
assert(trackedChestForward.dot(new THREE.Vector3(0, 0, 1)) > 0.95,
  'a mounted tracked upper body should face the board nose even while its head looks elsewhere');
assert(point('hip-front').distanceTo(neutral.ankleFront) <= REACH + 1e-8
  && point('hip-rear').distanceTo(neutral.ankleRear) <= REACH + 1e-8,
  'three-point body tracking must keep both legs within reach of their board bindings');

// The mounted solver assigns physical hands by shoulder, but their canonical wrist frames must travel with the
// selected positions: rolling a controller is a palm rotation, not merely another arm-end point.
const boardHandF = point('hand-front').clone(), boardHandR = point('hand-rear').clone();
const boardWristF = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.5, 1.15));
const boardWristR = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0.25, -0.8));
rider.pose({ ...neutral, handTargets: {
  a: { position: boardHandF, quaternion: boardWristF },
  b: { position: boardHandR, quaternion: boardWristR },
} });
for (const [name, expected] of [['hand-front', boardWristF], ['hand-rear', boardWristR]] as const) {
  const actual = node(name).quaternion;
  assert(new THREE.Vector3(0, 1, 0).applyQuaternion(actual)
    .angleTo(new THREE.Vector3(0, 1, 0).applyQuaternion(expected)) < 1e-6,
  `${name} fingers should follow the mounted tracked wrist`);
  assert(new THREE.Vector3(0, 0, 1).applyQuaternion(actual)
    .angleTo(new THREE.Vector3(0, 0, 1).applyQuaternion(expected)) < 1e-6,
  `${name} palm should roll with the mounted tracked wrist`);
}

// Controller targets are grip origins, not wrists. Keep the controller at that source-of-truth point and move
// the mounted avatar wrist behind it using the same calibrated anatomical frame that owns its palm rotation.
rider.reset(neutral);
const neutralHandF = point('hand-front').clone(), neutralHandR = point('hand-rear').clone();
const gripOffsetF = gripToWristOffset(boardWristF);
const gripOffsetR = gripToWristOffset(boardWristR);
const seatedWristF = point('shoulder-front').clone().lerp(neutralHandF, 0.8);
const seatedWristR = point('shoulder-rear').clone().lerp(neutralHandR, 0.8);
rider.pose({ ...neutral, handTargets: {
  a: {
    position: seatedWristF.clone().sub(gripOffsetF), quaternion: boardWristF,
    source: 'grip', handedness: 'left',
  },
  b: {
    position: seatedWristR.clone().sub(gripOffsetR), quaternion: boardWristR,
    source: 'grip', handedness: 'right',
  },
} });
assert(point('hand-front').distanceTo(seatedWristF) < 1e-6,
  'a mounted avatar wrist should be seated from its raw front controller grip');
assert(point('hand-rear').distanceTo(seatedWristR) < 1e-6,
  'a mounted avatar wrist should be seated from its raw rear controller grip');

// A tracked wrist is a hard VR landmark, even when a riding pose puts the authored shoulder more than one arm
// away. The old generic reach clamp moved each glove toward the shoulder here — over 40 cm off its controller.
// Instead, solve backward from the controller and let only the shoulder girdle yield enough to reach it.
const trackedRidingInput = {
  ...neutral,
  headTarget: { position: trackedView, quaternion: trackedLook, exactPosition: true as const },
};
rider.reset(trackedRidingInput);
const unreachableWristF = point('shoulder-front').clone().add(new THREE.Vector3(0, -ARM_REACH - 0.42, 0));
const unreachableWristR = point('shoulder-rear').clone().add(new THREE.Vector3(0, -ARM_REACH - 0.42, 0));
const authoredShoulderF = point('shoulder-front').clone();
const authoredShoulderR = point('shoulder-rear').clone();
rider.pose({ ...trackedRidingInput, handTargets: {
  a: { position: unreachableWristF, quaternion: boardWristF },
  b: { position: unreachableWristR, quaternion: boardWristR },
} });
assert(point('hand-front').distanceTo(unreachableWristF) < 1e-8
  && point('hand-rear').distanceTo(unreachableWristR) < 1e-8,
  'mounted tracked wrists must stay exactly on unreachable controller targets instead of snapping toward the body');
assert(point('shoulder-front').distanceTo(authoredShoulderF) > 0.4
  && point('shoulder-rear').distanceTo(authoredShoulderR) > 0.4,
  'the shoulder girdle should yield backward from unreachable controller targets');
assert(point('shoulder-front').distanceTo(point('hand-front')) <= ARM_REACH + 1e-8
  && point('shoulder-rear').distanceTo(point('hand-rear')) <= ARM_REACH + 1e-8,
  'backward tracked-arm IK must preserve anatomical arm reach');

// ------------------------------------------------------------ the wearer's torso, not the deck's
// The VR seat is pinned for comfort: on snow it carries a quarter of a stick turn and none of the gaze steer,
// so the deck routinely swings most of a carve under a wearer who has not turned at all. The tracked shoulder
// line therefore belongs to the WEARER (headset yaw, pulled toward held-out hands). Built across the deck, it
// swept away from the controllers through every turn, and past 90° each hand was nearer the OTHER shoulder: the
// two arms swapped controllers — a jump of the whole distance between the hands — on every carve.
{
  const ctlLeft = trackedView.clone().add(new THREE.Vector3(0.18, -0.35, 0.30));   // facing +Z, +X is the left
  const ctlRight = trackedView.clone().add(new THREE.Vector3(-0.18, -0.35, 0.30));
  const ctl = (a: THREE.Vector3, b: THREE.Vector3) => ({
    a: { position: a, quaternion: new THREE.Quaternion() },
    b: { position: b, quaternion: new THREE.Quaternion() },
  });
  const yawed = (deg: number): RiderInput => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), deg * Math.PI / 180);
    return {
      ...trackedRidingInput,
      ankleFront: neutral.ankleFront.clone().applyQuaternion(q),
      ankleRear: neutral.ankleRear.clone().applyQuaternion(q),
      rideForward: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
      handTargets: ctl(ctlLeft, ctlRight),
    };
  };
  const chestForward = () => new THREE.Vector3().crossVectors(
    point('clavicle-root').clone().sub(point('upper-back')),
    point('shoulder-front').clone().sub(point('shoulder-rear'))).normalize();

  rider.reset(yawed(0));
  const frontOnRight = point('hand-front').distanceTo(ctlRight) < 1e-6;
  assert(frontOnRight || point('hand-front').distanceTo(ctlLeft) < 1e-6, 'the front arm takes a controller');
  const frontCtl = frontOnRight ? ctlRight : ctlLeft, rearCtl = frontOnRight ? ctlLeft : ctlRight;
  const squareShoulder = point('shoulder-front').clone();
  for (const deg of [30, 60, 90, 105, 120, 150, 180]) {
    for (let k = 0; k < 30; k++) rider.pose(yawed(deg));
    assert(point('hand-front').distanceTo(frontCtl) < 1e-6 && point('hand-rear').distanceTo(rearCtl) < 1e-6,
      `at ${deg}° of deck yaw each arm still holds its own controller`);
    assert(chestForward().z > 0.95, `at ${deg}° of deck yaw the tracked chest still faces the wearer`);
    const drift = point('shoulder-front').distanceTo(squareShoulder);
    assert(drift < 0.06, `at ${deg}° of deck yaw the shoulder stays with the wearer (moved ${drift.toFixed(3)} m)`);
  }

  // Two hands brought together are equidistant from both shoulders, and tracking jitters. The pairing HOLDS.
  rider.reset(yawed(0));
  const together = trackedView.clone().add(new THREE.Vector3(0, -0.35, 0.32));
  for (let k = 0; k < 6; k++) {
    const jitter = new THREE.Vector3(0.004 * (k % 2 ? 1 : -1), 0, 0);
    rider.pose({ ...yawed(0), handTargets: ctl(together.clone().add(jitter), together.clone().sub(jitter)) });
    const frontTarget = frontOnRight ? together.clone().sub(jitter) : together.clone().add(jitter);
    assert(point('hand-front').distanceTo(frontTarget) < 1e-6,
      `hands held together do not flap between the arms (frame ${k})`);
  }
  // A wearer who really crosses their hands still crosses the arms: that pairing is shorter by far more.
  rider.pose({ ...yawed(0), handTargets: ctl(ctlRight, ctlLeft) });
  assert(point('hand-front').distanceTo(frontCtl) < 1e-6, 'a genuine hand cross still crosses the arms');

  // A standard-stance body puts its FRONT foot at the tail (`gear.ts`). Built across the deck axis the tracked
  // chest faced the tail; built across the wearer's facing it looks the wearer's way on either stance.
  const boardRider = rider;
  rider = createRider(undefined, undefined, 'snowboard', 'standard');
  rider.reset({
    ...trackedRidingInput, ankleFront: neutral.ankleRear, ankleRear: neutral.ankleFront,
    handTargets: ctl(ctlLeft, ctlRight),
  });
  assert(chestForward().z > 0.95, 'a standard-stance tracked chest faces the wearer, not the tail');
  rider.dispose();
  rider = boardRider;

  // On foot, a controller held out in front used to lie along the rest elbow pole (straight behind), where the
  // solve has no side to choose: raising the hand a centimetre flipped the elbow from one side to the other. A
  // tracked arm hangs its elbow beneath the chord and moves it continuously.
  const footBase: RiderInput = {
    ...neutral, ankleFront: new THREE.Vector3(0.105, 0, 0), ankleRear: new THREE.Vector3(-0.105, 0, 0),
    locomotion: { phase: 0, weight: 0, facing: new THREE.Vector3(0, 0, 1) },
  };
  rider.reset(footBase);
  rider.group.updateMatrixWorld(true);
  const footView = node('eye-left').getWorldPosition(new THREE.Vector3())
    .add(node('eye-right').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
  const footTracked: RiderInput = {
    ...footBase, headTarget: { position: footView, quaternion: trackedLook, exactPosition: true },
  };
  rider.reset(footTracked);
  const footShF = point('shoulder-front').clone(), footShR = point('shoulder-rear').clone();
  let previousElbow: THREE.Vector3 | null = null;
  for (const lift of [-0.04, -0.02, 0, 0.02, 0.04]) {
    const a = footShF.clone().add(new THREE.Vector3(0, -0.05 + lift, 0.42));
    const b = footShR.clone().add(new THREE.Vector3(0, -0.05 + lift, 0.42));
    rider.pose({ ...footTracked, handTargets: ctl(a, b) });
    assert(point('hand-front').distanceTo(a) < 1e-6 && point('hand-rear').distanceTo(b) < 1e-6,
      'on foot each tracked hand sits on its controller');
    const elbow = point('elbow-front').clone();
    const chordMid = point('shoulder-front').clone().add(point('hand-front')).multiplyScalar(0.5);
    assert(elbow.y < chordMid.y - 0.02, `an arm held out in front hangs its elbow below the chord (lift ${lift})`);
    if (previousElbow) {
      const step = elbow.distanceTo(previousElbow);
      assert(step < 0.06, `raising the hand 2 cm moves the elbow ${step.toFixed(3)} m, which is a snap`);
    }
    previousElbow = elbow;
  }
  rider.reset(neutral);
}

// ------------------------------------------------------- desktop first-person carry
// Desktop uses the ordinary anatomical right arm, then attaches the deck to the wrist the solver could really
// reach. First person reveals this same head-hidden body rather than drawing a disconnected overlay arm.
const walking = {
  ...neutral,
  locomotion: { phase: 0, weight: 0, facing: new THREE.Vector3(0, 0, 1) },
};
rider.reset(walking);
const carryShoulder = point('shoulder-front').clone();
const carryTarget = carryShoulder.clone().add(new THREE.Vector3(0.2, 0.1, 2));
rider.pose({
  ...walking,
  pointTargets: [{ hand: 'right', direction: new THREE.Vector3(0, 0, 1), target: carryTarget, weight: 1 }],
});
const solvedCarry = point('hand-front').clone().sub(point('shoulder-front'));
assert(solvedCarry.clone().normalize().angleTo(carryTarget.clone().sub(point('shoulder-front')).normalize()) < 1e-6,
  'desktop carry should aim the anatomical right arm at its cursor target');
near(solvedCarry.length(), ARM_REACH * 0.97, 1e-6,
  'desktop carry should expose the reachable wrist used to attach the deck');
rider.setFirstPerson(true);
assert.equal(node('head').visible, false, 'first-person carry should suppress the local head at the camera');
assert.equal(node('upper-arm-front').visible && node('forearm-front').visible && node('hand-front').visible, true,
  'first-person carry should retain the player’s visible right arm and glove');
rider.setFirstPerson(false);

// --------------------------------------------------------------------- the face
rider.reset(neutral);
for (const feature of ['eye-left', 'eye-right', 'pupil-left', 'pupil-right', 'mouth',
  'headphone-left', 'headphone-right', 'headphone-band']) node(feature);
rider.group.updateMatrixWorld(true);
const eyeCentre = node('eye-left').getWorldPosition(new THREE.Vector3())
  .add(node('eye-right').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
assert(eyeCentre.sub(point('head')).z > 0.1, 'eyes should mark the head gaze down-course');

// ----------------------------------------------------------------- the glance
// The glance is gated on travel, which is also what keeps this file deterministic: every fixture above rides at
// zero velocity, so a parked rider must hold its gaze on the nose indefinitely. A cruising rider draws
// exponential waits, but they are capped at 20 s, so it must check the mountain — even the smallest 15° look
// deflects the gaze past 0.2 — and bring its eyes back down-course, all inside a 25 s ride.
rider.reset(neutral);
const gaze = () => Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(node('head').quaternion).x);
let parkedMax = 0;
for (let frame = 0; frame < 720; frame++) { rider.pose(neutral); parkedMax = Math.max(parkedMax, gaze()); }
assert(parkedMax < 0.02, `a parked rider glanced (gaze deflection ${parkedMax.toFixed(3)})`);

const cruising = { ...neutral, vel: new THREE.Vector3(0, 0, 12) };
let glanced = false, returned = false;
// This is a timing/envelope contract, not a randomness test. Pin the draws so a near-minimum yaw combined with
// a near-cap wait cannot turn the suite into a coin flip while retaining the production capped-exponential path.
const nativeRandom = Math.random;
try {
  Math.random = () => 0.5;
  rider.reset(cruising);
  for (let frame = 0; frame < 1500 && !returned; frame++) {
    rider.pose(cruising);
    const off = gaze();
    if (!glanced) glanced = off > 0.2;
    else if (off < 0.02) returned = true;
  }
} finally {
  Math.random = nativeRandom;
}
assert(glanced, 'a cruising rider should glance at the mountain within the capped wait');
assert(returned, 'the glance should ease back down-course after its hold');

rider.dispose();
console.log(`RIDER POSE: PASS (${styles.length} styles, edges diverge up to `
  + `${(worstMirror * 100).toFixed(1)} cm from a mirror)`);
