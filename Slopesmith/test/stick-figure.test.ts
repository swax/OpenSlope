// tier: fast

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Bone, Group, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STICK_FIGURE_CHARACTER_ID, builtinCharacter } from '../src/core/characters/builtins';
import { REQUIRED_CHARACTER_BONES, normalizedCharacterBoneName } from '../src/core/characters/contract';
import { shapeVolume } from '../tools/character-models/figure';
import {
  BIND, BONES, DIGITS, PALETTE, PARTS, exportStickFigureGlb,
} from '../tools/character-models/stick-figure';
import { checkCharacterGlb } from '../tools/character-models/check';

/**
 * The tracking stick figure is generated source plus a byte-identical GLB. These checks pin both halves of
 * its job: canonical rider proportions for runtime retargeting, and visual landmarks that expose bad body,
 * hand, and foot tracking instead of hiding it inside a costume.
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

// The runtime rotates these authored segments without resizing them, so their lengths are functional data.
const RIDER_H = 1.70;
close(length('UpperLeg.L'), 0.245 * RIDER_H, 'thigh');
close(length('LowerLeg.L'), 0.246 * RIDER_H, 'shank');
close(length('UpperArm.L'), 0.186 * RIDER_H, 'upper arm');
close(length('LowerArm.L'), 0.146 * RIDER_H, 'forearm');
close(length('Hips'), 0.14, 'lower spine');
close(length('Hips') + length('Spine'), 0.192, 'hips to upper back');
close(length('Chest'), 0.242, 'upper back to clavicle root');
close(length('Neck'), 0.075, 'neck');
close(length('Head'), 0.105, 'head bone');
for (const segment of ['UpperArm', 'LowerArm', 'UpperLeg', 'LowerLeg', 'Foot', 'Clavicle', 'Pelvis']) {
  close(length(`${segment}.R`), length(`${segment}.L`), `${segment} mirroring`);
}
assert.equal(BIND.armSpread, 18, 'the bind pose opens the hands away from the body');

/* ── Every diagnostic landmark is present ─────────────────────────────────────────────────────────── */

const names = new Set<string>();
for (const entry of PARTS) {
  assert(!names.has(entry.name), `${entry.name} is declared once`);
  names.add(entry.name);
  bone(entry.bone);
  assert(shapeVolume(entry.shape) > 1e-10,
    `${entry.name} is a closed outward solid (volume ${shapeVolume(entry.shape).toExponential(2)})`);
}

// This debug character shows every bone, including the connector and digit bones ordinary costumes hide.
for (const spec of BONES) {
  assert(PARTS.some(entry => entry.bone === spec.name), `${spec.name} has visible geometry`);
}

const materialNames = new Set<string>(PALETTE.map(entry => entry.name));
for (const entry of PARTS) assert(materialNames.has(entry.material), `${entry.name} has a known material`);

for (const side of ['L', 'R'] as const) {
  const sideMaterial = side === 'L' ? 'Left' : 'Right';
  for (const segment of ['UpperArm', 'LowerArm', 'UpperLeg', 'LowerLeg']) {
    assert(PARTS.some(entry => entry.name === `${segment}.${side}.Stick` && entry.material === sideMaterial),
      `${segment}.${side} carries its anatomical side colour`);
    assert(PARTS.some(entry => entry.name === `${segment}.${side}.FrontRail` && entry.material === 'FrontPalm'),
      `${segment}.${side} has a cyan front rail`);
    assert(PARTS.some(entry => entry.name === `${segment}.${side}.RearRail` && entry.material === 'RearBack'),
      `${segment}.${side} has a magenta rear rail`);
  }
  assert(names.has(`Hand.${side}.PalmFace`) && names.has(`Hand.${side}.HandBack`),
    `${side} hand distinguishes its palm from its back`);
  assert(names.has(`Foot.${side}.Toe`) && names.has(`Foot.${side}.Heel`),
    `${side} foot distinguishes toe from heel`);
}
for (const target of ['Head.Face', 'Head.Rear', 'Head.Crown', 'Chest.FrontTarget', 'Chest.RearTarget']) {
  assert(names.has(target), `${target} makes head/torso orientation readable at a distance`);
}

/* ── Articulated hands ────────────────────────────────────────────────────────────────────────────── */

assert.deepEqual(DIGITS.map(entry => [entry.digit, entry.segments.length]), [
  ['thumb', 2], ['index', 3], ['middle', 3], ['ring', 3], ['pinky', 3],
], 'the thumb uses two driven segments and each finger uses three');
const runtimeDigit = /^(left|right)hand(thumb|index|middle|ring|pinky)([1-4])$/;
const fingerBones = BONES.filter(spec => runtimeDigit.test(normalizedCharacterBoneName(spec.name)));
assert.equal(fingerBones.length, 28, 'both hands expose all 28 driven digit bones');
for (const side of ['Left', 'Right'] as const) {
  for (const digit of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const) {
    let segment = 1;
    while (BONES.some(spec => spec.name === `${side}Hand${digit}${segment}`)) {
      assert(names.has(`${side}Hand${digit}${segment}.Stick`), `${side} ${digit} ${segment} is visible`);
      segment++;
    }
    assert(names.has(`${side}Hand${digit}${segment - 1}.Tip`), `${side} ${digit} has a fingertip target`);
  }
  assert(BONES.some(spec => spec.name === `${side}HandMiddle1`), `${side} palm frame has a middle base`);
  assert(BONES.some(spec => spec.name === `${side}HandThumb1`), `${side} palm frame has a thumb base`);
}

// Ground contact is explicit: both soles, and no other marker, may drift below y = 0.
const lowest = Math.min(...PARTS.flatMap(entry => {
  const y: number[] = [];
  for (let index = 1; index < entry.shape.positions.length; index += 3) y.push(entry.shape.positions[index]);
  return y;
}));
assert(Math.abs(lowest) < 1e-9, `the diagnostic soles sit on y = 0, not ${lowest}`);

/* ── Exported contract and provenance ─────────────────────────────────────────────────────────────── */

const glb = await exportStickFigureGlb();
const report = checkCharacterGlb(glb, 'stick-figure (generated)');
assert.equal(report.valid, true, report.errors.join('\n'));
assert.equal(report.skinnedMeshes, 1);
assert.equal(report.bones, 49, '21 body/connector bones plus 28 digit bones');
assert.equal(report.unweightedVertices, 0);
assert.equal(report.images, 0, 'the diagnostic uses flat colours and carries no image dependency');
assert.equal(report.animations, 0);
assert.equal(report.maxInfluencesPerVertex, 1, 'every diagnostic solid follows exactly one reported bone');
assert.equal(report.materials, PALETTE.length);
const triangles = PARTS.reduce((sum, entry) => sum + entry.shape.indices.length / 3, 0);
assert.equal(report.triangles, triangles, 'the GLB contains only the declared diagnostic solids');
assert(report.heightMetres !== null && report.heightMetres > 1.70 && report.heightMetres < 1.90,
  `standing height is a canonical rider plus its head marker, not ${report.heightMetres} m`);
assert(Math.abs(report.boundsMin?.[1] ?? 1) < 1e-6, 'the exported soles begin on the ground plane');

// Loader round-trip the exact bone names the browser driver will resolve.
const gltf = await new GLTFLoader().parseAsync(
  glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '');
const root = gltf.scene as Group;
const loaded = new Map<string, Bone>();
root.traverse(object => {
  if (object instanceof Bone) loaded.set(normalizedCharacterBoneName(object.name), object);
});
for (const spec of BONES) {
  assert(root.getObjectByName(spec.name) instanceof Bone || loaded.has(normalizedCharacterBoneName(spec.name)),
    `the runtime resolves ${spec.name} after GLTFLoader`);
}

const character = builtinCharacter(STICK_FIGURE_CHARACTER_ID);
assert(character, 'the stick figure is a registered built-in');
const tracked = await readFile(new URL(`../public/characters/${character.file}`, import.meta.url));
assert(tracked.equals(Buffer.from(glb)),
  `public/characters/${character.file} is stale (${tracked.byteLength} bytes on disk, ${glb.byteLength} generated); `
  + 're-run tools/character-models/stick-figure.ts');

console.log(`STICK FIGURE: PASS (${PARTS.length} solids, ${triangles} triangles, ${glb.byteLength} bytes)`);
