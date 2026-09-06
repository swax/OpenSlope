// tier: fast

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Bone, Group, Quaternion, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BLOCKY_RIDER_CHARACTER_ID, builtinCharacter } from '../src/core/characters/builtins';
import { REQUIRED_CHARACTER_BONES, normalizedCharacterBoneName } from '../src/core/characters/contract';
import { BONES, PARTS, exportBlockyRiderGlb } from '../tools/character-models/blocky-rider';
import { checkCharacterGlb } from '../tools/character-models/check';

/**
 * The blocky rider is generated, not modelled, so this covers the two things a Blender-authored character
 * has no way to check: that the tracked GLB is still what its source produces, and that the skeleton inside
 * it still measures a 1.70 m rider. The driver rotates an imported skeleton without re-proportioning it
 * (docs/030), so a segment that drifts here is boots through the deck at ride time, silently.
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

// Every box is a real box, on a bone that exists.
for (const part of PARTS) {
  bone(part.bone);
  for (let axis = 0; axis < 3; axis++) {
    assert(part.max[axis] > part.min[axis], `${part.name} is inside out on axis ${axis}`);
  }
}

/**
 * The no-gap rule. One influence per vertex means a joint has no smooth deformation to bridge it, so each
 * bone's primary block must contain BOTH ends of the bone it rides — that overlap is the only thing keeping
 * a bent knee or elbow from opening a hole, and it is also what keeps the geometry attached to the skeleton
 * if the proportions are ever re-derived. The head's decoration (hat, goggles, mouth) is exempt: it hangs
 * off the head block rather than bridging a joint.
 */
const ENCLOSING = new Set(['Pelvis', 'Jacket', 'Collar', 'Head',
  ...['UpperArm', 'LowerArm', 'UpperLeg', 'LowerLeg', 'Mitt', 'Boot']
    .flatMap(part => [`${part}.L`, `${part}.R`])]);
for (const part of PARTS) {
  if (!ENCLOSING.delete(part.name)) continue;
  const spec = bone(part.bone);
  for (const [end, point] of [['head', spec.head], ['tail', spec.tail]] as const) {
    for (let axis = 0; axis < 3; axis++) {
      assert(point[axis] >= part.min[axis] - 1e-9 && point[axis] <= part.max[axis] + 1e-9,
        `${part.name} does not enclose its bone's ${end} on axis ${axis}`);
    }
  }
}
assert.equal(ENCLOSING.size, 0, `the parts table is missing ${[...ENCLOSING].join(', ')}`);

// The sole is the origin of the standing figure: nothing may hang below it, and the boots must reach it.
const lowest = Math.min(...PARTS.map(part => part.min[1]));
assert.equal(lowest, 0, 'the lowest part sits exactly on the ground plane');

const glb = await exportBlockyRiderGlb();
const report = checkCharacterGlb(glb, 'blocky-rider (generated)');
assert.equal(report.valid, true, report.errors.join('\n'));
assert.equal(report.skinnedMeshes, 1);
assert.equal(report.unweightedVertices, 0);
assert.equal(report.images, 0, 'a built-in character carries no images');
assert.equal(report.animations, 0);
assert.equal(report.maxInfluencesPerVertex, 1, 'every box is rigidly bound to one bone');
assert.equal(report.triangles, PARTS.length * 12, 'twelve triangles per box, and no stray geometry');
assert(report.heightMetres !== null && report.heightMetres > 1.6 && report.heightMetres < 2.1,
  `standing height is ${report.heightMetres} m`);
assert(Math.abs(report.boundsMin?.[1] ?? 1) < 1e-6, 'the skinned figure starts at the ground plane');

/**
 * Read the bytes back the way the browser will, and resolve them the way `app/ride/character-rig.ts` does:
 * authored name first, punctuation-stripped name second, because a glTF loader may drop the `.L`.
 */
const gltf = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer, '');
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
 * Hands: with no finger hierarchy the driver reads local +Y as the fingers and local ±X as the palm, so a
 * hanging arm has to put both palms toward the body. Feet: the importer's mirrored roll, `Foot.L` local +X
 * sole-up and `Foot.R` local −X (docs/030), with local +Y running out over the toes.
 */
for (const [name, side, inward] of [['Hand.L', 1, -1], ['Hand.R', -1, 1]] as const) {
  const bind = driven(name).getWorldQuaternion(new Quaternion());
  const fingers = new Vector3(0, 1, 0).applyQuaternion(bind);
  const palm = new Vector3(side, 0, 0).applyQuaternion(bind);
  assert(fingers.y < -0.99, `${name} bind fingers hang downward`);
  assert(palm.x * inward > 0.99, `${name} bind palm faces the body`);
}
for (const [name, up] of [['Foot.L', 1], ['Foot.R', -1]] as const) {
  const bind = driven(name).getWorldQuaternion(new Quaternion());
  assert(new Vector3(0, 1, 0).applyQuaternion(bind).z > 0.99, `${name} bind +Y runs out over the toes`);
  assert(new Vector3(up, 0, 0).applyQuaternion(bind).y > 0.99, `${name} bind roll is sole-up`);
}

// The checked-in asset is a build product of the source above, so it must be byte-identical to it. If this
// is the only failure, `npx tsx tools/character-models/blocky-rider.ts` is the fix.
const character = builtinCharacter(BLOCKY_RIDER_CHARACTER_ID);
assert(character, 'the blocky rider is a registered built-in');
const tracked = await readFile(new URL(`../public/characters/${character.file}`, import.meta.url));
// Compared as buffers rather than with deepEqual: the failure that matters is "stale", and a 34 kB
// byte-by-byte diff buries that one-line instruction under the whole model.
assert(tracked.equals(Buffer.from(glb)),
  `public/characters/${character.file} is stale (${tracked.byteLength} bytes on disk, ${glb.byteLength} generated); `
  + 're-run tools/character-models/blocky-rider.ts');

console.log('BLOCKY RIDER: PASS');
