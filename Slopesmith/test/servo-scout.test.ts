// tier: fast

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Bone, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FINGER_CURL_ANGLES, fingerCurlAxis } from '../src/app/ride/character-rig';
import { SERVO_SCOUT_CHARACTER_ID, builtinCharacter } from '../src/core/characters/builtins';
import { REQUIRED_CHARACTER_BONES, normalizedCharacterBoneName } from '../src/core/characters/contract';
import { ShapeMesh, UV_SCROLL_KEY, V3, shapeBounds, shapeVolume } from '../tools/character-models/figure';
import {
  BIND, BONES, PARTS, SERVO_SCOUT, buildServoScout, exportServoScoutGlb,
} from '../tools/character-models/servo-scout';
import { LIGHT_CELL } from '../tools/character-models/servo-scout-lights';
import { decodeGreyPng } from '../tools/character-models/embed-texture';
import { checkCharacterGlb } from '../tools/character-models/check';

/**
 * The treaded built-in. It shares a skeleton and an exporter with the other generated characters, so this
 * covers what is different about it: a THREE-digit gripper instead of a hand, tracks instead of boots, and a
 * head large enough that it is the silhouette.
 *
 * As with the others, the two things a Blender-authored character has no way to check are here too: the
 * tracked GLB is still what its source produces, and the skeleton inside it still measures a 1.70 m rider.
 * The driver rotates an imported skeleton without re-proportioning it (docs/030), so a segment that drifts
 * is boots — here, tracks — through the deck at ride time, silently.
 */

const bone = (name: string) => {
  const found = BONES.find(entry => entry.name === name);
  assert(found, `the figure declares bone ${name}`);
  return found;
};
const length = (name: string) => new Vector3(...bone(name).tail).distanceTo(new Vector3(...bone(name).head));
const close = (actual: number, expected: number, what: string) =>
  assert(Math.abs(actual - expected) < 5e-4, `${what} is ${actual.toFixed(4)} m, expected ${expected.toFixed(4)} m`);
const named = (partName: string) => {
  const found = PARTS.find(entry => entry.name === partName);
  assert(found, `the parts table declares ${partName}`);
  return found;
};

for (const name of REQUIRED_CHARACTER_BONES) bone(name);
for (const spec of BONES) {
  if (spec.parent) bone(spec.parent);
  assert(new Vector3(...spec.head).distanceTo(new Vector3(...spec.tail)) > 1e-3, `${spec.name} has a length`);
}

// Winter's stature fractions on the procedural rider's 1.70 m, which is what `app/ride/rider.ts` solves.
const RIDER_H = 1.70;
close(length('UpperLeg.L'), 0.245 * RIDER_H, 'thigh');
close(length('LowerLeg.L'), 0.246 * RIDER_H, 'shank');
close(length('UpperArm.L'), 0.186 * RIDER_H, 'upper arm');
close(length('LowerArm.L'), 0.146 * RIDER_H, 'forearm');
close(length('Hips'), 0.14, 'the driven lower-spine segment');
close(length('Hips') + length('Spine'), 0.192, 'hips to upper back');
close(length('Chest'), 0.242, 'upper back to clavicle root');
close(length('Neck'), 0.075, 'clavicle root to skull base');
close(length('Head'), 0.105, 'skull base to head centre');
// Both sides must measure the same, or the rider's front and rear legs disagree about where the deck is.
for (const segment of ['UpperArm', 'LowerArm', 'UpperLeg', 'LowerLeg', 'Foot', 'Clavicle', 'Pelvis']) {
  close(length(`${segment}.R`), length(`${segment}.L`), `${segment} mirroring`);
}

/**
 * The bind A-pose. It is what keeps the forearm rods and the grippers out of the hip frame, and the parts
 * table is written against it, so a change here silently moves every arm solid off its bone.
 */
assert.equal(BIND.armSpread, 14, 'the arms hang 14 degrees out from vertical in bind');
for (const side of ['L', 'R'] as const) {
  const sign = side === 'L' ? 1 : -1;
  const shoulder = new Vector3(...bone(`UpperArm.${side}`).head);
  const wrist = new Vector3(...bone(`Hand.${side}`).head);
  assert((wrist.x - shoulder.x) * sign > 0.12,
    `${side} wrist hangs outboard of its shoulder (a straight-down arm has no room beside this hip frame)`);
  assert(Math.abs(wrist.z - shoulder.z) < 1e-9, `${side} arm swings in the frontal plane only`);
}

/* ── Every solid is a solid ────────────────────────────────────────────────────────────────────────────
 * A box cannot be inside out or open; a lofted ring stack can be both, and neither shows up as an error —
 * an inverted solid is simply invisible from outside and a missing cap is a hole you have to be standing
 * in the right place to see. So each shape is checked for what makes it a closed orientable surface.
 */
const key = (shape: ShapeMesh, vertex: number) => [0, 1, 2]
  // `+ 0` normalizes the negative zero `mirroredX` produces, which would otherwise key as its own corner.
  .map(axis => Number(shape.positions[vertex * 3 + axis].toFixed(6)) + 0).join(',');

function assertClosed(name: string, shape: ShapeMesh) {
  const directed = new Map<string, number>();
  for (let i = 0; i < shape.indices.length; i += 3) {
    const corners = [shape.indices[i], shape.indices[i + 1], shape.indices[i + 2]].map(v => key(shape, v));
    assert(new Set(corners).size === 3, `${name} has a degenerate triangle`);
    for (let c = 0; c < 3; c++) {
      const edge = `${corners[c]}|${corners[(c + 1) % 3]}`;
      directed.set(edge, (directed.get(edge) ?? 0) + 1);
    }
  }
  for (const [edge, count] of directed) {
    assert.equal(count, 1, `${name} uses the edge ${edge} ${count} times in the same direction`);
    const [from, to] = edge.split('|');
    assert.equal(directed.get(`${to}|${from}`), 1, `${name} has an unpaired edge — the solid is not closed`);
  }
}

const names = new Set<string>();
for (const entry of PARTS) {
  assert(!names.has(entry.name), `${entry.name} is declared twice`);
  names.add(entry.name);
  bone(entry.bone);
  assertClosed(entry.name, entry.shape);
  // Positive by the divergence theorem means every face is wound outward. Backwards, the solid renders as a
  // hole through the character on any renderer that culls back faces — which is all of them.
  assert(shapeVolume(entry.shape) > 1e-9,
    `${entry.name} is wound inside out (signed volume ${shapeVolume(entry.shape).toExponential(2)})`);
}

/**
 * The no-gap rule. One influence per vertex means a joint has no smooth deformation to bridge it, so the
 * solid that OWNS each bone must contain both of that bone's ends — that overlap is the only thing keeping
 * a bent knee or elbow from opening a hole. Every other solid here is a hinge can, a cap, a rail or a light
 * that rides on top of one of these.
 */
const PRIMARY = new Map<string, string>([
  ['Head', 'Skull'], ['Neck', 'NeckColumn'], ['Chest', 'Chassis'], ['Spine', 'Waist'], ['Hips', 'Hip'],
  ...['L', 'R'].flatMap((side): [string, string][] => [
    [`UpperArm.${side}`, `UpperArmFrame.${side}`], [`LowerArm.${side}`, `ForearmFrame.${side}`],
    [`Hand.${side}`, `Palm.${side}`], [`UpperLeg.${side}`, `ThighFrame.${side}`],
    [`LowerLeg.${side}`, `ShinFrame.${side}`], [`Foot.${side}`, `Track.${side}`],
  ]),
]);
for (const [boneName, partName] of PRIMARY) {
  const entry = named(partName);
  assert.equal(entry.bone, boneName, `${partName} is bound to ${boneName}`);
  const { min, max } = shapeBounds(entry.shape);
  const spec = bone(boneName);
  for (const [end, point] of [['head', spec.head], ['tail', spec.tail]] as const) {
    for (let axis = 0; axis < 3; axis++) {
      assert(point[axis] >= min[axis] - 1e-9 && point[axis] <= max[axis] + 1e-9,
        `${partName} does not enclose ${boneName}'s ${end} on axis ${axis}`);
    }
  }
}
// Every driven bone carries geometry: an unused one is a limb that vanishes rather than a limb that moves.
for (const spec of BONES) {
  if (spec.name.startsWith('Clavicle') || spec.name.startsWith('Pelvis.')) continue; // pure connectors
  assert(PARTS.some(entry => entry.bone === spec.name), `${spec.name} has geometry bound to it`);
}

/* ── The tracks ────────────────────────────────────────────────────────────────────────────────────────
 * A track unit is not a boot with a different silhouette: the ankle joint lives INSIDE it, which only works
 * because `ANKLE_RISE` is 11.5 cm and the unit is 13.2 cm tall. Both halves of that are asserted, because a
 * unit that grew would put its underside below the deck and one that shrank would leave the ankle in the
 * open air with the shin ending in nothing.
 */
close(BIND.trackHeight, 0.132, 'the track unit height');
for (const side of ['L', 'R'] as const) {
  const track = shapeBounds(named(`Track.${side}`).shape);
  const ankle = bone(`Foot.${side}`).head;
  assert(Math.abs(track.min[1]) < 1e-9, `Track.${side} rides on the ground plane, not at ${track.min[1]}`);
  assert(ankle[1] > track.min[1] + 0.02 && ankle[1] < track.max[1] - 0.01,
    `the ankle at ${ankle[1]} sits inside Track.${side} (${track.min[1]}..${track.max[1]})`);
  // The frame shows past the rubber band on BOTH faces of the unit — that is the whole read, and centring it
  // inside the band instead would spend two hundred triangles on a solid nobody can see.
  const frame = shapeBounds(named(`TrackFrame.${side}`).shape);
  assert(frame.min[0] < track.min[0] - 1e-9 && frame.max[0] > track.max[0] + 1e-9,
    `TrackFrame.${side} is wider than the band it carries`);
  assert(frame.min[1] > track.min[1] + 1e-9, `TrackFrame.${side} stays inside the band's own tread line`);
}
// Nothing at all may hang below the tread line: standing height is measured off it and the driver seats it
// on the binding, so a solid authored under it is daylight under the rider.
const lowest = Math.min(...PARTS.map(entry => shapeBounds(entry.shape).min[1]));
assert(Math.abs(lowest) < 1e-9, `the lowest solid sits on the ground plane, not at ${lowest}`);

/**
 * The head IS the silhouette, and that is a claim worth pinning rather than a note in a comment: this figure
 * spends the whole free budget on a sensor housing nearly as wide as the chest under it. Narrow that and the
 * character becomes a thin robot with a helmet on.
 */
const skullWidth = shapeBounds(named('Skull').shape).max[0] - shapeBounds(named('Skull').shape).min[0];
const chestWidth = shapeBounds(named('Chassis').shape).max[0] - shapeBounds(named('Chassis').shape).min[0];
assert(skullWidth / chestWidth > 0.8,
  `the sensor head is ${skullWidth.toFixed(3)} m across against a ${chestWidth.toFixed(3)} m chest`);

/* ── Hands ─────────────────────────────────────────────────────────────────────────────────────────────
 * Finger bones are named MIXAMO's way, not this rig's, because that is what the runtime's digit matcher and
 * its palm-frame lookup expect (app/ride/character-rig.ts). A rig that invents its own finger names gets a
 * hand that silently never closes, so the naming is asserted against the same shape the runtime matches.
 */
const RUNTIME_DIGIT = /^(left|right)hand(thumb|index|middle|ring|pinky)([1-4])$/;
const fingerBoneNames = BONES.map(spec => spec.name)
  .filter(name => RUNTIME_DIGIT.test(normalizedCharacterBoneName(name)));
assert.equal(fingerBoneNames.length, 16, 'both hands carry a two-segment thumb and two three-segment fingers');
// Three digits is the design, not an omission, and the runtime simply never finds the other two. Asserting
// their ABSENCE is what stops a well-meaning edit from quietly turning a gripper back into a hand.
for (const absent of ['ring', 'pinky']) {
  assert(!fingerBoneNames.some(name => normalizedCharacterBoneName(name).includes(absent)),
    `the gripper has no ${absent} finger`);
}
for (const side of ['Left', 'Right'] as const) {
  // The two the driver looks up BY NAME to build the hand's palm frame. Without them it falls back to the
  // bind axes, and every digit's curl axis comes out of that fallback instead of the actual thumb.
  for (const required of [`${side}HandMiddle1`, `${side}HandThumb1`]) {
    assert(BONES.some(spec => spec.name === required), `the driver can find ${required}`);
  }
  for (const spec of BONES) {
    const match = /^(Left|Right)Hand(Thumb|Index|Middle)(\d)$/.exec(spec.name);
    if (!match || match[1] !== side) continue;
    const segment = Number(match[3]);
    const parent = segment === 1 ? `Hand.${side === 'Left' ? 'L' : 'R'}` : `${side}Hand${match[2]}${segment - 1}`;
    assert.equal(spec.parent, parent, `${spec.name} hangs off ${parent}`);
    assert(segment <= 4, `${spec.name} is within the four segments the driver bends`);
  }
}
// The wrist-to-knuckle length the driver reads as `palmLength`, which sets where a WebXR grip puts the
// wrist. Outside this range it is clamped, and the gripper stops sitting in the tracked hand.
const palmLength = new Vector3(...bone('LeftHandMiddle1').head)
  .distanceTo(new Vector3(...bone('Hand.L').head));
assert(palmLength > 0.045 && palmLength < 0.14, `palm length is ${palmLength.toFixed(3)} m`);

/* ── The A-pose earns its keep ─────────────────────────────────────────────────────────────────────────
 * Assert the result rather than the angle: no vertex of the arm BELOW THE ELBOW may sit inside a solid of
 * the torso, the hip frame or the near thigh. Below the elbow, and not the whole arm, because the shoulder
 * hinge is meant to overlap the yoke it hangs from — what the A-pose is actually for is everything below it.
 */
function inside(point: V3, shape: ShapeMesh): boolean {
  const { min, max } = shapeBounds(shape);
  for (let axis = 0; axis < 3; axis++) if (point[axis] < min[axis] || point[axis] > max[axis]) return false;
  // Parity of a ray cast against the closed surface checked above. The direction is oblique so it cannot
  // graze an axis-aligned facet, which is the only case this would answer unstably.
  const direction: V3 = [0.7962, 0.5238, 0.3021];
  let crossings = 0;
  for (let i = 0; i < shape.indices.length; i += 3) {
    const at = (slot: number, axis: number) => shape.positions[shape.indices[i + slot] * 3 + axis];
    const e1 = [0, 1, 2].map(axis => at(1, axis) - at(0, axis));
    const e2 = [0, 1, 2].map(axis => at(2, axis) - at(0, axis));
    const cross = [
      direction[1] * e2[2] - direction[2] * e2[1],
      direction[2] * e2[0] - direction[0] * e2[2],
      direction[0] * e2[1] - direction[1] * e2[0],
    ];
    const determinant = e1[0] * cross[0] + e1[1] * cross[1] + e1[2] * cross[2];
    if (Math.abs(determinant) < 1e-12) continue;
    const offset = [0, 1, 2].map(axis => point[axis] - at(0, axis));
    const u = (offset[0] * cross[0] + offset[1] * cross[1] + offset[2] * cross[2]) / determinant;
    if (u < 0 || u > 1) continue;
    const q = [
      offset[1] * e1[2] - offset[2] * e1[1],
      offset[2] * e1[0] - offset[0] * e1[2],
      offset[0] * e1[1] - offset[1] * e1[0],
    ];
    const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / determinant;
    if (v < 0 || u + v > 1) continue;
    if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / determinant > 1e-9) crossings++;
  }
  return crossings % 2 === 1;
}

const ARM_BONES = new Set(['LowerArm.L', 'Hand.L']);
const CORE_BONES = new Set(['Hips', 'Spine', 'Chest', 'UpperLeg.L']);
const armPlates = PARTS.filter(entry => ARM_BONES.has(entry.bone));
const corePlates = PARTS.filter(entry => CORE_BONES.has(entry.bone));
for (const plate of armPlates) {
  for (let vertex = 0; vertex < plate.shape.positions.length / 3; vertex++) {
    const point = [0, 1, 2].map(axis => plate.shape.positions[vertex * 3 + axis]) as unknown as V3;
    for (const core of corePlates) {
      assert(!inside(point, core.shape),
        `${plate.name} has a corner inside ${core.name} at ${point.map(v => v.toFixed(3)).join(', ')}`);
    }
  }
}

/**
 * Close the gripper the way the runtime will, and check where the claw tips land.
 *
 * This is the one part of the figure whose correctness is not visible in the parts table: the driver bends
 * each segment by a FIXED angle it does not let a model choose, so whether a gripper closes is a property of
 * the digit lengths and rest directions together with those angles. It is posed here with the driver's own
 * `fingerCurlAxis` and its own `FINGER_CURL_ANGLES` rather than a copy of them, so a change to either shows
 * up here rather than in a headset.
 */
{
  const figure = buildServoScout();
  figure.updateMatrixWorld(true);
  const posed = new Map<string, Bone>();
  figure.traverse(object => { if (object instanceof Bone) posed.set(object.name, object); });

  const hand = posed.get('Hand.L')!;
  const wrist = hand.getWorldPosition(new Vector3());
  const along = posed.get('LeftHandMiddle1')!.getWorldPosition(new Vector3()).sub(wrist).normalize();
  const thumbAt = posed.get('LeftHandThumb1')!.getWorldPosition(new Vector3()).sub(wrist);
  // The driver's own palm construction for a left hand: fingers × thumb, squared up against the fingers.
  const palm = new Vector3().crossVectors(along, thumbAt);
  palm.addScaledVector(along, -palm.dot(along)).normalize();
  // It must come out as the hand's local +X — the axis the parts table calls "the way the palm faces".
  const localX = new Vector3().setFromMatrixColumn(hand.matrixWorld, 0).normalize();
  // The driver builds this from `middle1 × thumb1`, so it is really a check on where the thumb's BASE sits:
  // lift it out of the palm plane and the recovered normal tilts, taking both fingers' curl planes with it.
  assert(palm.dot(localX) > 0.98,
    `the driver recovers the palm normal the digits were authored against (dot ${palm.dot(localX).toFixed(3)})`);

  const tipInHand = (digit: string): Vector3 => {
    let last: Bone | undefined, segment = 1;
    while (posed.get(`LeftHand${digit}${segment}`)) last = posed.get(`LeftHand${digit}${segment++}`)!;
    const length = new Vector3().setFromMatrixPosition(last!.matrixWorld)
      .distanceTo(new Vector3().setFromMatrixPosition(last!.parent!.matrixWorld));
    return new Vector3(0, length, 0).applyMatrix4(last!.matrixWorld)
      .applyMatrix4(new Matrix4().copy(hand.matrixWorld).invert());
  };
  const open = Object.fromEntries(['Thumb', 'Index', 'Middle'].map(d => [d, tipInHand(d)]));

  for (const [name, bone] of posed) {
    const match = /^LeftHand(Thumb|Index|Middle)(\d)$/.exec(name);
    if (!match) continue;
    const segment = Number(match[2]);
    const next = posed.get(`LeftHand${match[1]}${segment + 1}`);
    const head = bone.getWorldPosition(new Vector3());
    const rotation = bone.getWorldQuaternion(new Quaternion());
    const direction = next
      ? next.getWorldPosition(new Vector3()).sub(head).normalize()
      : new Vector3(0, 1, 0).applyQuaternion(rotation);
    const axis = fingerCurlAxis(direction, palm).normalize().applyQuaternion(rotation.clone().invert());
    const angle = FINGER_CURL_ANGLES[Math.min(segment - 1, FINGER_CURL_ANGLES.length - 1)];
    bone.quaternion.multiply(new Quaternion().setFromAxisAngle(axis, angle));
    bone.updateMatrix();
  }
  figure.updateMatrixWorld(true);

  const palmSurface = 0.060; // the outer face of `PalmPad`, in the hand's own frame
  for (const digit of ['Index', 'Middle']) {
    const extended = open[digit], closed = tipInHand(digit);
    assert(extended.y > 0.14, `${digit} reaches out when open, not ${extended.y.toFixed(3)} m`);
    assert(closed.y < extended.y - 0.05, `${digit} actually curls: ${extended.y.toFixed(3)} → ${closed.y.toFixed(3)}`);
    // Toward the pad and stopping ON it. A tip that overshoots into negative x has folded straight through
    // the back of the hand, which is what a segment count or a rest direction gets wrong.
    assert(closed.x > palmSurface * 0.8 && closed.x < palmSurface + 0.030,
      `${digit} closes onto the pad, not through it (x ${closed.x.toFixed(3)} against a surface at ${palmSurface})`);
    // And it closes STRAIGHT. A finger that slides across the pad as it shuts is the visible symptom of a
    // tilted palm normal, which is a property of the thumb's base rather than of this finger at all.
    assert(Math.abs(closed.z - extended.z) < 0.012,
      `${digit} curls in its own plane (across ${extended.z.toFixed(3)} → ${closed.z.toFixed(3)})`);
  }
  // The two fingers must stay on their own sides of the pad. They start symmetric about its centre-line and
  // a gripper whose jaws cross is worse than one that does not quite meet.
  assert(tipInHand('Index').z > 0.010 && tipInHand('Middle').z < -0.010,
    'the two jaws close on opposite sides of the pad centre-line');
  // The thumb tucks under the fingers rather than lying over them — two segments against the driver's fixed
  // 1.15 + 1.45 rad is more fold than a thumb has, and this is where that lands. What matters is that it
  // stays inside the closed gripper: not out through the back of the hand, and not floating off the pad.
  const thumb = tipInHand('Thumb');
  assert(thumb.x > 0.015 && thumb.x < palmSurface + 0.030,
    `the thumb folds into the gripper (x ${thumb.x.toFixed(3)})`);
  assert(thumb.y > 0 && thumb.y < 0.06,
    `the thumb lands across the pad rather than past the wrist (y ${thumb.y.toFixed(3)})`);
  assert(Math.abs(thumb.z) < 0.05, `the thumb comes in over the pad (z ${thumb.z.toFixed(3)})`);
}

/* ── The exported bytes ────────────────────────────────────────────────────────────────────────────── */

const glb = await exportServoScoutGlb();
const report = checkCharacterGlb(glb, 'servo-scout (generated)');
assert.equal(report.valid, true, report.errors.join('\n'));
assert.equal(report.skinnedMeshes, 1);
assert.equal(report.unweightedVertices, 0);
assert.equal(report.images, 2, 'the two emissive masks travel inside the file');
assert.equal(report.embeddedImages, 2, 'a built-in character carries no image it would have to fetch');
assert.deepEqual(report.externalImages, []);
assert.equal(report.animations, 0);
assert.equal(report.maxInfluencesPerVertex, 1, 'every solid is rigidly bound to one bone');
const triangles = PARTS.reduce((sum, entry) => sum + entry.shape.indices.length / 3, 0);
assert.equal(report.triangles, triangles, 'the mesh is exactly the parts table, with no stray geometry');
assert(report.heightMetres !== null && report.heightMetres > 1.80 && report.heightMetres < 2.00,
  `standing height is ${report.heightMetres} m — the antenna is part of it`);
assert(Math.abs(report.boundsMin?.[1] ?? 1) < 1e-6, 'the skinned figure starts at the ground plane');
assert.equal(report.bones, 37, '21 rider bones plus a three-digit gripper on each hand');

/* ── The emissive layer ────────────────────────────────────────────────────────────────────────────────
 * Two masks, greyscale, embedded. A light's shape comes from the texture and its colour from the material,
 * so the things worth pinning are the ones that silently produce a figure that looks fine in daylight and
 * wrong at night: a part that samples the wrong window, an atlas that got mipmapped or wrapped, and a
 * scroll rate that no longer reaches the runtime.
 */
const litMaterials = new Set(SERVO_SCOUT.palette.filter(entry => entry.emissiveTexture).map(e => e.name));
assert.deepEqual([...litMaterials], ['Iris', 'Signal', 'Feed'], 'the emissive materials are the expected three');
for (const entry of SERVO_SCOUT.palette) {
  if (!entry.emissiveTexture) continue;
  const texture = SERVO_SCOUT.textures?.find(one => one.name === entry.emissiveTexture);
  assert(texture, `${entry.name} names a texture the figure provides`);
  assert(entry.emissive !== undefined, `${entry.name} has an emissive colour for its mask to tint`);
}
for (const entry of PARTS) {
  if (!litMaterials.has(entry.material)) continue;
  // A part on a lit material with no tile would land on UNLIT and simply not glow — the kind of omission
  // that reads as "the light is broken" rather than as a missing line in a table.
  assert(entry.tile, `${entry.name} is on the lit material ${entry.material} and must name a tile`);
  const texture = SERVO_SCOUT.textures?.find(one =>
    one.name === SERVO_SCOUT.palette.find(p => p.name === entry.material)?.emissiveTexture);
  if (texture?.wrap === 'clamp') {
    for (const value of entry.tile) {
      assert(value >= 0 && value <= 1, `${entry.name} samples outside a clamped atlas at ${value}`);
    }
  }
}
// UNLIT points at the first texel, so it has to actually be dark, or every untiled part on a lit material
// would glow instead of failing visibly.
const atlas = SERVO_SCOUT.textures![0];
assert.equal(atlas.name, 'optics');
assert.equal(atlas.pixels[0], 0, 'the atlas texel UNLIT points at is black');
assert(atlas.pixels.some(value => value > 200), 'the atlas has something bright in it');

/**
 * The pupil. It is the one feature that separates this figure's eyes from two glowing discs, and it lives
 * entirely inside a 16-texel cell where a careless edit to the falloff would smooth it away without changing
 * anything a daylight render shows. Read it off the mask the way the shader will: the iris cell's centre is
 * lit but dimmer than the annulus around it.
 */
{
  const [u0, v0, u1] = LIGHT_CELL.iris;
  const at = (u: number, v: number) =>
    atlas.pixels[Math.floor(v * atlas.height) * atlas.width + Math.floor(u * atlas.width)];
  const centre = at((u0 + u1) / 2, v0 + (u1 - u0) / 2);
  const annulus = at(u0 + (u1 - u0) * 0.78, v0 + (u1 - u0) / 2);
  assert(centre > 0, `the pupil is lit, not a hole (${centre})`);
  assert(annulus > centre + 60, `the iris is brighter than the pupil inside it (${annulus} against ${centre})`);
}

/** Split a GLB the way the browser will, so the images can be read out of the bytes that actually ship. */
function glbChunks(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let json: Record<string, any> = {};
  let bin: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for (let offset = 12; offset < bytes.byteLength;) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004e4942) bin = body;
    offset += 8 + length;
  }
  return { json, bin };
}

const { json: gltfJson, bin } = glbChunks(glb);
assert.equal(gltfJson.images.length, 2);
for (let index = 0; index < 2; index++) {
  const source = SERVO_SCOUT.textures![index];
  const image = gltfJson.images[index];
  assert.equal(image.mimeType, 'image/png');
  const bufferView = gltfJson.bufferViews[image.bufferView];
  const decoded = decodeGreyPng(bin.subarray(bufferView.byteOffset, bufferView.byteOffset + bufferView.byteLength));
  assert.equal(decoded.width, source.width, `${source.name} width survives the round trip`);
  assert.equal(decoded.height, source.height);
  assert.deepEqual([...decoded.pixels], [...source.pixels], `${source.name} decodes to the mask it was built from`);
  // Clamped, and never mipmapped: an atlas cannot be reduced without blending its neighbouring cells, which
  // at distance lights up plates that are supposed to be dark. 9729 is LINEAR, 33071 CLAMP, 10497 REPEAT.
  const sampler = gltfJson.samplers[gltfJson.textures[index].sampler];
  assert.equal(sampler.minFilter, 9729, `${source.name} is not mipmapped`);
  assert.equal(sampler.wrapT, source.wrap === 'repeat' ? 10497 : 33071, `${source.name} wrap mode`);
}
// The scroll rate has to survive as glTF `extras`, because that is the entire channel between the model and
// `app/ride/character-glow.ts` — the runtime looks for this key and nothing else.
const feed = gltfJson.materials.find((entry: { name?: string }) => entry.name === 'Feed');
assert(feed, 'the exported file has a Feed material');
assert.deepEqual(feed.extras?.[UV_SCROLL_KEY], [0, -0.62], 'Feed declares its scroll rate to the runtime');
assert(feed.emissiveTexture, 'Feed samples a mask');

/**
 * Read the bytes back the way the browser will, and resolve them the way `app/ride/character-rig.ts` does:
 * authored name first, punctuation-stripped name second, because a glTF loader may drop the `.L`.
 *
 * GLTFLoader decodes an embedded image the way a browser does: `self.URL.createObjectURL`, then a fetch of
 * that blob, then `createImageBitmap`. Node has neither `self` nor the decoder, so both are stubbed. What
 * this round trip is for is the SKELETON that comes back; the pixels were already checked above, read
 * straight out of the shipped bytes rather than through a decoder.
 */
const browserish = globalThis as Record<string, unknown>;
browserish.self ??= globalThis;
browserish.createImageBitmap ??= async () => ({ width: 1, height: 1, close() { /* stub */ } });

const gltf = await new GLTFLoader().parseAsync(
  glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '');
const root = gltf.scene as Group;
root.updateMatrixWorld(true);
const loadedBones = new Map<string, Bone>();
root.traverse(object => {
  if (object instanceof Bone) loadedBones.set(normalizedCharacterBoneName(object.name), object);
});
const driven = (name: string) => {
  const found = root.getObjectByName(name) ?? loadedBones.get(normalizedCharacterBoneName(name));
  assert(found instanceof Bone, `the driver can resolve ${name} after a loader round trip`);
  return found;
};
for (const spec of BONES) driven(spec.name);

/**
 * The two bind frames the driver retargets THROUGH rather than measures, so an error in either is a wrong
 * hand or a wrong track at ride time rather than a load failure.
 *
 * Hands: with no finger hierarchy the driver reads local +Y as the fingers and local ±X as the palm. The
 * A-pose puts the fingers down the arm rather than straight down, so that is what is asserted — but both
 * palms must still face the body, which is the half of the convention the driver actually depends on.
 * Feet: the importer's mirrored roll, `Foot.L` local +X sole-up and `Foot.R` local −X (docs/030), with
 * local +Y running out over the front of the track.
 */
const spread = BIND.armSpread * Math.PI / 180;
for (const [name, side, inward] of [['Hand.L', 1, -1], ['Hand.R', -1, 1]] as const) {
  const bind = driven(name).getWorldQuaternion(new Quaternion());
  const fingers = new Vector3(0, 1, 0).applyQuaternion(bind);
  const palm = new Vector3(side, 0, 0).applyQuaternion(bind);
  assert(Math.abs(fingers.y + Math.cos(spread)) < 1e-3 && fingers.x * side > 0,
    `${name} bind fingers run down its own A-posed arm`);
  assert(palm.x * inward > 0.9, `${name} bind palm faces the body`);
}
for (const [name, up] of [['Foot.L', 1], ['Foot.R', -1]] as const) {
  const bind = driven(name).getWorldQuaternion(new Quaternion());
  assert(new Vector3(0, 1, 0).applyQuaternion(bind).z > 0.99, `${name} bind +Y runs out over the track's front`);
  assert(new Vector3(up, 0, 0).applyQuaternion(bind).y > 0.99, `${name} bind roll is tread-down`);
}

// The checked-in asset is a build product of the source above, so it must be byte-identical to it. If this
// is the only failure, `npx tsx tools/character-models/servo-scout.ts` is the fix.
const character = builtinCharacter(SERVO_SCOUT_CHARACTER_ID);
assert(character, 'Servo Scout is a registered built-in');
const tracked = await readFile(new URL(`../public/characters/${character.file}`, import.meta.url));
// Compared as buffers rather than with deepEqual: the failure that matters is "stale", and a byte-by-byte
// diff of half a megabyte buries that one-line instruction under the whole model.
assert(tracked.equals(Buffer.from(glb)),
  `public/characters/${character.file} is stale (${tracked.byteLength} bytes on disk, ${glb.byteLength} generated); `
  + 're-run tools/character-models/servo-scout.ts');

console.log(`SERVO SCOUT: PASS (${PARTS.length} solids, ${triangles} triangles, ${glb.byteLength} bytes)`);
