// tier: fast

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Bone, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FINGER_CURL_ANGLES, fingerCurlAxis } from '../src/app/ride/character-rig';
import { ALPINE_EXO_CHARACTER_ID, builtinCharacter } from '../src/core/characters/builtins';
import { REQUIRED_CHARACTER_BONES, normalizedCharacterBoneName } from '../src/core/characters/contract';
import { ShapeMesh, UV_SCROLL_KEY, V3, shapeBounds, shapeVolume } from '../tools/character-models/figure';
import {
  ALPINE_EXO, BIND, BONES, PARTS, buildAlpineExo, exportAlpineExoGlb,
} from '../tools/character-models/alpine-exo';
import { decodeGreyPng } from '../tools/character-models/embed-texture';
import { checkCharacterGlb } from '../tools/character-models/check';

/**
 * The armoured built-in. It shares a skeleton and an exporter with the blocky rider, so this covers what is
 * different about it: solids that are lofted rings rather than boxes (and can therefore be inside out or
 * open, which a box cannot), a bind A-pose, and a great deal more geometry to get wrong.
 *
 * As with the blocky rider, the two things a Blender-authored character has no way to check are here too:
 * the tracked GLB is still what its source produces, and the skeleton inside it still measures a 1.70 m
 * rider. The driver rotates an imported skeleton without re-proportioning it (docs/030), so a segment that
 * drifts is boots through the deck at ride time, silently.
 */

const bone = (name: string) => {
  const found = BONES.find(entry => entry.name === name);
  assert(found, `the figure declares bone ${name}`);
  return found;
};
const length = (name: string) => new Vector3(...bone(name).tail).distanceTo(new Vector3(...bone(name).head));
const close = (actual: number, expected: number, what: string) =>
  assert(Math.abs(actual - expected) < 5e-4, `${what} is ${actual.toFixed(4)} m, expected ${expected.toFixed(4)} m`);

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
 * The bind A-pose. It is what gives arms this thick somewhere to hang, and the parts table is written
 * against it, so a change here silently moves every arm plate off its bone.
 */
assert.equal(BIND.armSpread, 17, 'the arms hang 17 degrees out from vertical in bind');
for (const side of ['L', 'R'] as const) {
  const sign = side === 'L' ? 1 : -1;
  const shoulder = new Vector3(...bone(`UpperArm.${side}`).head);
  const wrist = new Vector3(...bone(`Hand.${side}`).head);
  assert((wrist.x - shoulder.x) * sign > 0.15,
    `${side} wrist hangs outboard of its shoulder (a straight-down arm has no room beside this waist)`);
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
 * plate that OWNS each bone must contain both of that bone's ends — that overlap is the only thing keeping
 * a bent knee or elbow from opening a hole. Every other solid here is a cop, a seal, a rim or a marking
 * that rides on top of one of these.
 */
const PRIMARY = new Map<string, string>([
  ['Head', 'Helm'], ['Neck', 'Gorget'], ['Chest', 'Cuirass'], ['Spine', 'Waist'], ['Hips', 'Pelvis'],
  ...['L', 'R'].flatMap((side): [string, string][] => [
    [`UpperArm.${side}`, `Rerebrace.${side}`], [`LowerArm.${side}`, `Vambrace.${side}`],
    [`Hand.${side}`, `Palm.${side}`], [`UpperLeg.${side}`, `Cuisse.${side}`],
    [`LowerLeg.${side}`, `Greave.${side}`], [`Foot.${side}`, `Sabaton.${side}`],
  ]),
]);
for (const [boneName, partName] of PRIMARY) {
  const entry = PARTS.find(candidate => candidate.name === partName);
  assert(entry, `the parts table declares ${partName}`);
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

/* ── Hands ─────────────────────────────────────────────────────────────────────────────────────────────
 * Finger bones are named MIXAMO's way, not this rig's, because that is what the runtime's digit matcher and
 * its palm-frame lookup expect (app/ride/character-rig.ts). A rig that invents its own finger names gets a
 * hand that silently never closes, so the naming is asserted against the same shape the runtime matches.
 */
const RUNTIME_DIGIT = /^(left|right)hand(thumb|index|middle|ring|pinky)([1-4])$/;
const fingerBoneNames = BONES.map(spec => spec.name)
  .filter(name => RUNTIME_DIGIT.test(normalizedCharacterBoneName(name)));
assert.equal(fingerBoneNames.length, 28, 'both hands carry a thumb of two segments and four fingers of three');
for (const side of ['Left', 'Right'] as const) {
  // The two the driver looks up BY NAME to build the hand's palm frame. Without them it falls back to the
  // bind axes, and every digit's curl axis comes out of that fallback instead of the actual thumb.
  for (const required of [`${side}HandMiddle1`, `${side}HandThumb1`]) {
    assert(BONES.some(spec => spec.name === required), `the driver can find ${required}`);
  }
  for (const spec of BONES) {
    const match = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(\d)$/.exec(spec.name);
    if (!match || match[1] !== side) continue;
    const segment = Number(match[3]);
    const parent = segment === 1 ? `Hand.${side === 'Left' ? 'L' : 'R'}` : `${side}Hand${match[2]}${segment - 1}`;
    assert.equal(spec.parent, parent, `${spec.name} hangs off ${parent}`);
    assert(segment <= 4, `${spec.name} is within the four segments the driver bends`);
  }
}
// The wrist-to-knuckle length the driver reads as `palmLength`, which sets where a WebXR grip puts the
// wrist. Outside this range it is clamped, and the gauntlet stops sitting in the tracked hand.
const palmLength = new Vector3(...bone('LeftHandMiddle1').head)
  .distanceTo(new Vector3(...bone('Hand.L').head));
assert(palmLength > 0.045 && palmLength < 0.14, `palm length is ${palmLength.toFixed(3)} m`);

// The sole is the origin of the standing figure: nothing may hang below it, and the boots must reach it.
const lowest = Math.min(...PARTS.map(entry => shapeBounds(entry.shape).min[1]));
assert(Math.abs(lowest) < 1e-9, `the lowest solid sits on the ground plane, not at ${lowest}`);

/* ── The A-pose earns its keep ─────────────────────────────────────────────────────────────────────────
 * The whole reason for a 17-degree bind is that Alpine Exo's forearm and gauntlet are wider than the gap
 * between a human shoulder and a human hip. Assert the result rather than the angle: no vertex of the arm
 * BELOW THE ELBOW may sit inside a plate of the torso or the near thigh.
 *
 * Below the elbow, and not the whole arm, because on a chest 0.46 m across the shoulder joint is inside the
 * torso volume — a 0.33 m shoulder span is anatomy and the breadth is the design, so the upper arm emerges
 * from under the side of the cuirass and is meant to. What the A-pose is actually for is everything hanging
 * off that joint: hung straight down, this arm's vambrace reaches 9 cm inside the pelvis and its gauntlet
 * 13 cm inside the thigh plate, which is what this loop fails on.
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
 * Close the fist the way the runtime will, and check where the fingertips land.
 *
 * This is the one part of the figure whose correctness is not visible in the parts table: the driver bends
 * each segment by a FIXED angle it does not let a model choose, so whether a hand closes is a property of
 * the digit lengths and rest directions together with those angles. It is posed here with the driver's own
 * `fingerCurlAxis` and its own `FINGER_CURL_ANGLES` rather than a copy of them, so a change to either shows
 * up here rather than in a headset.
 */
{
  const figure = buildAlpineExo();
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
  // lift it out of the palm plane and the recovered normal tilts, taking every finger's curl plane with it.
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
  const open = Object.fromEntries(['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].map(d => [d, tipInHand(d)]));

  for (const [name, bone] of posed) {
    const match = /^LeftHand(Thumb|Index|Middle|Ring|Pinky)(\d)$/.exec(name);
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
  for (const digit of ['Index', 'Middle', 'Ring', 'Pinky']) {
    const extended = open[digit], closed = tipInHand(digit);
    assert(extended.y > 0.11, `${digit} reaches out when open, not ${extended.y.toFixed(3)} m`);
    assert(closed.y < extended.y - 0.05, `${digit} actually curls: ${extended.y.toFixed(3)} → ${closed.y.toFixed(3)}`);
    // Toward the palm and stopping ON it. A tip that overshoots into negative x has folded straight through
    // the back of the hand, which is what a segment count or a rest direction gets wrong.
    assert(closed.x > palmSurface * 0.8 && closed.x < palmSurface + 0.030,
      `${digit} closes onto the palm, not through it (x ${closed.x.toFixed(3)} against a surface at ${palmSurface})`);
    // And it closes STRAIGHT. A finger that slides across the palm as it shuts is the visible symptom of a
    // tilted palm normal, which is a property of the thumb's base rather than of this finger at all.
    assert(Math.abs(closed.z - extended.z) < 0.012,
      `${digit} curls in its own plane (across ${extended.z.toFixed(3)} → ${closed.z.toFixed(3)})`);
  }
  // The thumb tucks under the fingers rather than lying over them — two segments against the driver's fixed
  // 1.15 + 1.45 rad is more fold than a thumb has, and this is where that lands. What matters is that it
  // stays inside the fist: not out through the back of the hand, and not floating off the palm.
  const thumb = tipInHand('Thumb');
  assert(thumb.x > 0.015 && thumb.x < palmSurface + 0.030,
    `the thumb folds into the fist (x ${thumb.x.toFixed(3)})`);
  assert(thumb.y > 0 && thumb.y < 0.06,
    `the thumb lands across the palm rather than past the wrist (y ${thumb.y.toFixed(3)})`);
  assert(Math.abs(thumb.z) < 0.05, `the thumb comes in over the palm (z ${thumb.z.toFixed(3)})`);
}

/* ── The exported bytes ────────────────────────────────────────────────────────────────────────────── */

const glb = await exportAlpineExoGlb();
const report = checkCharacterGlb(glb, 'alpine-exo (generated)');
assert.equal(report.valid, true, report.errors.join('\n'));
assert.equal(report.skinnedMeshes, 1);
assert.equal(report.unweightedVertices, 0);
assert.equal(report.images, 2, 'the two emissive masks travel inside the file');
assert.equal(report.embeddedImages, 2, 'a built-in character carries no image it would have to fetch');
assert.deepEqual(report.externalImages, []);
assert.equal(report.animations, 0);
assert.equal(report.maxInfluencesPerVertex, 1, 'every plate is rigidly bound to one bone');
const triangles = PARTS.reduce((sum, entry) => sum + entry.shape.indices.length / 3, 0);
assert.equal(report.triangles, triangles, 'the mesh is exactly the parts table, with no stray geometry');
assert(report.heightMetres !== null && report.heightMetres > 1.6 && report.heightMetres < 2.1,
  `standing height is ${report.heightMetres} m`);
assert(Math.abs(report.boundsMin?.[1] ?? 1) < 1e-6, 'the skinned figure starts at the ground plane');
// Breadth is the whole design; a change that quietly narrows it has changed the character.
const width = (report.boundsMax?.[0] ?? 0) - (report.boundsMin?.[0] ?? 0);
assert(width > 0.8 && width < 1.0, `the figure is ${width.toFixed(3)} m across the pauldrons`);

/* ── The emissive layer ────────────────────────────────────────────────────────────────────────────────
 * Two masks, greyscale, embedded. A light's shape comes from the texture and its colour from the material,
 * so the things worth pinning are the ones that silently produce a figure that looks fine in daylight and
 * wrong at night: a part that samples the wrong window, an atlas that got mipmapped or wrapped, and a
 * scroll rate that no longer reaches the runtime.
 */
const litMaterials = new Set(ALPINE_EXO.palette.filter(entry => entry.emissiveTexture).map(e => e.name));
assert.deepEqual([...litMaterials], ['Lens', 'Lamp', 'Core'], 'the emissive materials are the expected three');
for (const entry of ALPINE_EXO.palette) {
  if (!entry.emissiveTexture) continue;
  const texture = ALPINE_EXO.textures?.find(one => one.name === entry.emissiveTexture);
  assert(texture, `${entry.name} names a texture the figure provides`);
  assert(entry.emissive !== undefined, `${entry.name} has an emissive colour for its mask to tint`);
}
for (const entry of PARTS) {
  if (!litMaterials.has(entry.material)) continue;
  // A part on a lit material with no tile would land on UNLIT and simply not glow — the kind of omission
  // that reads as "the light is broken" rather than as a missing line in a table.
  assert(entry.tile, `${entry.name} is on the lit material ${entry.material} and must name a tile`);
  const texture = ALPINE_EXO.textures?.find(one =>
    one.name === ALPINE_EXO.palette.find(p => p.name === entry.material)?.emissiveTexture);
  if (texture?.wrap === 'clamp') {
    for (const value of entry.tile) {
      assert(value >= 0 && value <= 1, `${entry.name} samples outside a clamped atlas at ${value}`);
    }
  }
}
// UNLIT points at the first texel, so it has to actually be dark, or every untiled part on a lit material
// would glow instead of failing visibly.
const atlas = ALPINE_EXO.textures![0];
assert.equal(atlas.name, 'lights');
assert.equal(atlas.pixels[0], 0, 'the atlas texel UNLIT points at is black');
assert(atlas.pixels.some(value => value > 200), 'the atlas has something bright in it');

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
  const source = ALPINE_EXO.textures![index];
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
const core = gltfJson.materials.find((entry: { name?: string }) => entry.name === 'Core');
assert(core, 'the exported file has a Core material');
assert.deepEqual(core.extras?.[UV_SCROLL_KEY], [0, -0.55], 'Core declares its scroll rate to the runtime');
assert(core.emissiveTexture, 'Core samples a mask');

/**
 * Read the bytes back the way the browser will, and resolve them the way `app/ride/character-rig.ts` does:
 * authored name first, punctuation-stripped name second, because a glTF loader may drop the `.L`.
 */
/**
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
 * hand or a wrong boot at ride time rather than a load failure.
 *
 * Hands: with no finger hierarchy the driver reads local +Y as the fingers and local ±X as the palm. The
 * A-pose puts the fingers down the arm rather than straight down, so that is what is asserted — but both
 * palms must still face the body, which is the half of the convention the driver actually depends on.
 * Feet: the importer's mirrored roll, `Foot.L` local +X sole-up and `Foot.R` local −X (docs/030), with
 * local +Y running out over the toes.
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
  assert(new Vector3(0, 1, 0).applyQuaternion(bind).z > 0.99, `${name} bind +Y runs out over the toes`);
  assert(new Vector3(up, 0, 0).applyQuaternion(bind).y > 0.99, `${name} bind roll is sole-up`);
}

// The checked-in asset is a build product of the source above, so it must be byte-identical to it. If this
// is the only failure, `npx tsx tools/character-models/alpine-exo.ts` is the fix.
const character = builtinCharacter(ALPINE_EXO_CHARACTER_ID);
assert(character, 'Alpine Exo is a registered built-in');
const tracked = await readFile(new URL(`../public/characters/${character.file}`, import.meta.url));
// Compared as buffers rather than with deepEqual: the failure that matters is "stale", and a byte-by-byte
// diff of a third of a megabyte buries that one-line instruction under the whole model.
assert(tracked.equals(Buffer.from(glb)),
  `public/characters/${character.file} is stale (${tracked.byteLength} bytes on disk, ${glb.byteLength} generated); `
  + 're-run tools/character-models/alpine-exo.ts');

console.log(`ALPINE EXO: PASS (${PARTS.length} solids, ${triangles} triangles, ${glb.byteLength} bytes)`);
