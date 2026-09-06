// tier: fast

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  characterModelUrl, customSkyUrl, referenceSkyUrl, registerReferenceSkyRevisions,
  registerReferenceTextureRevisions, skyPageUrl, textureUrl,
} from '../src/app/net/asset-paths';
import { setClientProjectId } from '../src/app/net/client';
import { defaultMountain } from '../src/core/doc/mountain';
import { createStore } from '../src/app/state/store';
import {
  DEFAULT_RIDER_MODEL_ID, PROCEDURAL_RIDER_MODEL_ID, riderModelOptions,
} from '../src/app/ride/rider-models';
import {
  ALPINE_EXO_CHARACTER_ID, BUILTIN_CHARACTERS, DEFAULT_CHARACTER_MODEL_ID, builtinCharacter,
} from '../src/core/characters/builtins';
import { checkCharacterGlb } from '../tools/character-models/check';

const names = [
  'Hips', 'Chest', 'Head',
  'UpperArm.L', 'LowerArm.L', 'Hand.L',
  'UpperArm.R', 'LowerArm.R', 'Hand.R',
  'UpperLeg.L', 'LowerLeg.L', 'Foot.L',
  'UpperLeg.R', 'LowerLeg.R', 'Foot.R',
];

function syntheticCharacter(change?: (document: Record<string, unknown>) => void): Uint8Array {
  const positions = Buffer.from(new Float32Array([
    0, 0, 0,
    0.2, 1, 0,
    -0.2, 1.75, 0,
  ]).buffer);
  const joints = Buffer.from(new Uint8Array([
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]).buffer);
  const weights = Buffer.from(new Float32Array([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]).buffer);
  const indices = Buffer.from(new Uint16Array([0, 1, 2]).buffer);
  const binaryLength = positions.length + joints.length + weights.length + indices.length;
  const binary = Buffer.alloc((binaryLength + 3) & ~3);
  let offset = 0;
  const views = [positions, joints, weights, indices].map(bytes => {
    const view = { buffer: 0, byteOffset: offset, byteLength: bytes.length };
    bytes.copy(binary, offset);
    offset += bytes.length;
    return view;
  });

  const nodes = names.map(name => ({ name, children: [] as number[] }));
  nodes[0].children.push(1, 9, 12);
  nodes[1].children.push(2, 3, 6);
  nodes[3].children.push(4); nodes[4].children.push(5);
  nodes[6].children.push(7); nodes[7].children.push(8);
  nodes[9].children.push(10); nodes[10].children.push(11);
  nodes[12].children.push(13); nodes[13].children.push(14);
  const document: Record<string, unknown> = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 15] }],
    nodes: [...nodes, { name: 'CharacterMesh', mesh: 0, skin: 0 }],
    skins: [{ joints: names.map((_, index) => index), skeleton: 0 }],
    meshes: [{ name: 'CharacterMesh', primitives: [{
      attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 }, indices: 3, mode: 4,
    }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: binary.length }],
  };
  change?.(document);

  const encoded = Buffer.from(JSON.stringify(document), 'utf8');
  const json = Buffer.alloc((encoded.length + 3) & ~3, 0x20);
  encoded.copy(json);
  const glb = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(json.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  json.copy(glb, 20);
  const binHeader = 20 + json.length;
  glb.writeUInt32LE(binary.length, binHeader);
  glb.writeUInt32LE(0x004e4942, binHeader + 4);
  binary.copy(glb, binHeader + 8);
  return glb;
}

const valid = checkCharacterGlb(syntheticCharacter(), 'synthetic.glb');
assert.equal(valid.valid, true, valid.errors.join('\n'));
assert.equal(valid.skinnedMeshes, 1);
assert.equal(valid.vertices, 3);
assert.equal(valid.maxInfluencesPerVertex, 1);
assert.equal(valid.heightMetres, 1.75);

const missing = checkCharacterGlb(syntheticCharacter(document => {
  const nodes = document.nodes as { name: string }[];
  nodes[2].name = 'Skull';
}), 'missing-head.glb');
assert.equal(missing.valid, false);
assert(missing.errors.includes('missing required bone Head'));

const external = checkCharacterGlb(syntheticCharacter(document => {
  document.images = [{ uri: 'face.png' }];
}), 'external-image.glb');
assert.equal(external.valid, false);
assert(external.errors.some(error => error.includes('external images')));

// Every shipped character, not just the default one: a built-in is part of the client build, so an
// incompatible re-export has no library step to fail in and would only show up as a rider that never loads.
assert(BUILTIN_CHARACTERS.length > 0, 'the client build ships at least one character');
for (const character of BUILTIN_CHARACTERS) {
  const bytes = await readFile(new URL(`../public/characters/${character.file}`, import.meta.url));
  const builtIn = checkCharacterGlb(bytes, character.file);
  assert.equal(builtIn.valid, true, `${character.file}: ${builtIn.errors.join('\n')}`);
  assert.equal(builtIn.skinnedMeshes, 1, `${character.file} is one skinned mesh`);
  assert.equal(builtIn.unweightedVertices, 0, `${character.file} has no unweighted vertices`);
  assert.equal(character.revision, createHash('sha256').update(bytes).digest('hex'),
    `${character.file} URL revision matches its bytes`);
  assert.equal(characterModelUrl(character.id), `/characters/${character.file}?v=${character.revision}`);
}
assert(BUILTIN_CHARACTERS.some(character => character.id === DEFAULT_CHARACTER_MODEL_ID),
  'the default rider is one of the built-ins');
assert.equal(characterModelUrl('custom-rider.glb'), '/api/character-model?name=custom-rider.glb');
assert.equal(textureUrl('MESA', '0059.png'), '/api/texture?level=MESA&name=0059.png',
  'an older response without revisions keeps a stable shared texture URL');
registerReferenceTextureRevisions('MESA', { '0059.png': 'tile-content' });
assert.equal(textureUrl('MESA', '0059.png'), '/api/texture?level=MESA&name=0059.png&v=tile-content',
  'a reference tile URL carries its content revision');
assert.equal(skyPageUrl('MESA', 4), '/api/skybox/page?level=MESA&index=4',
  'an older ring response keeps a stable shared sky-page URL');
assert.equal(skyPageUrl('MESA', 4, 'page-content'), '/api/skybox/page?level=MESA&index=4&v=page-content',
  'a reference sky-page URL carries its content revision');
registerReferenceSkyRevisions({ MESA: { panorama: 'pano-content', ground: 'ground-content' } });
assert.equal(referenceSkyUrl('MESA', 'panorama'), '/api/skypano?level=MESA&v=pano-content');
assert.equal(referenceSkyUrl('MESA', 'ground'), '/api/skyground?level=MESA&v=ground-content');
setClientProjectId('mountain-one');
assert.equal(textureUrl('Custom', 'powder.png'),
  '/api/texture?level=Custom&name=powder.png&project=mountain-one',
  'authored texture URLs use the durable mountain id instead of a random tab id');
assert.equal(customSkyUrl('bluebird', 'panorama'), '/api/skypano?sky=bluebird&project=mountain-one',
  'authored sky URLs are stable across tabs on the same mountain');
assert.equal(riderModelOptions()[0]?.id, DEFAULT_RIDER_MODEL_ID);
// A saved choice of a NON-default built-in must survive: the picker offers them all, so the sanitizer
// cannot quietly reset every browser that picked the other one.
for (const character of BUILTIN_CHARACTERS) {
  const stored = createStore({ mdoc: defaultMountain(), currentMode: 'edit', storedUi: { playRiderModel: character.id } });
  assert.equal(stored.playRiderModel, character.id, `${character.id} survives a reload`);
}
assert.equal(builtinCharacter('builtin:space-marine')?.id, ALPINE_EXO_CHARACTER_ID,
  'the previous built-in id resolves to Alpine Exo without reappearing in the picker');
const renamedStore = createStore({
  mdoc: defaultMountain(), currentMode: 'edit', storedUi: { playRiderModel: 'builtin:space-marine' },
});
assert.equal(renamedStore.playRiderModel, ALPINE_EXO_CHARACTER_ID,
  'a saved selection migrates to Alpine Exo');

const freshStore = createStore({ mdoc: defaultMountain(), currentMode: 'edit', storedUi: {} });
assert.equal(freshStore.playRiderModel, DEFAULT_RIDER_MODEL_ID);
const proceduralStore = createStore({
  mdoc: defaultMountain(), currentMode: 'edit', storedUi: { playRiderModel: PROCEDURAL_RIDER_MODEL_ID },
});
assert.equal(proceduralStore.playRiderModel, PROCEDURAL_RIDER_MODEL_ID);

console.log('CHARACTER CHECK: PASS');
