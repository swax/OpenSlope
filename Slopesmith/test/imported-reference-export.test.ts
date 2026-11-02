// tier: fast
import assert from 'node:assert/strict';
import { referenceExportFolder } from '../src/core/export/reference';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const png = new Uint8Array([1, 2, 3]);
const source = [
  { path: 'Patches.json', bytes: encode({ Patches: [{ TexturePath: '0000.png', SourceRecord: 2 }] }) },
  {
    path: 'Materials.json',
    bytes: encode({ Materials: [{ TexturePath: '0000.png', TextureFlipbook: ['0000.png'], AlphaMode: 'cutout' }] }),
  },
  { path: 'Textures/0000.png', bytes: png },
  { path: 'Origin.json', bytes: encode({ RetailData: true, Game: 'ssx-tricky-gba' }) },
];
const folder = referenceExportFolder('GBA', source);
const read = (name: string) => JSON.parse(new TextDecoder().decode(folder.files.find(f => f.path === name)!.bytes));
assert.equal(read('Patches.json').Patches[0].TexturePath, 'source_0000.png');
assert.equal(read('Patches.json').Patches[0].SourceRecord, 2);
assert.deepEqual(read('Materials.json').Materials[0], {
  TexturePath: 'source_0000.png',
  TextureFlipbook: ['source_0000.png'],
  AlphaMode: 'cutout',
});
assert.deepEqual(read('Slopesmith.json').textures['source_0000.png'], {
  level: 'custom',
  name: 'source_0000.png',
  staged: 'source_0000.png',
});
assert(read('Origin.json').RetailData);
assert.equal(folder.files.find(f => f.path === 'Textures/source_0000.png')!.bytes, png);
assert(folder.files.some(f => f.path === 'Repack.md'));
assert.equal(JSON.parse(new TextDecoder().decode(source[0].bytes)).Patches[0].TexturePath, '0000.png');
console.log('Reference export: portable texture identities, original bytes and origin metadata PASS');
