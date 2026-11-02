// tier: fast
import assert from 'node:assert/strict';
import { makeTexRef, parseTexRef, resolveTerrainTexRef, resolvePropTex, texDestName } from '../src/core/paint/textures';
import { referenceAssetId, assetRequestCovered } from '../src/core/reference/asset-manifest';
import { parseAssetVersion } from '../src/core/reference/asset-version';
import { buildMaterialCombiner } from '../src/core/export/materials';
import { textureRefUrl } from '../src/app/net/asset-paths';

const hash = 'a'.repeat(64);
const texture = referenceAssetId('ssx-tricky', 'TRICKY_GARI', 'texture', '0031.png', hash);
const legacy = `${texture}/0031.png`;
assert.equal(makeTexRef(texture, '0031.png'), texture);
assert.equal(makeTexRef('Custom', texture), texture, 'an individual image is already fully qualified');
assert.deepEqual(parseTexRef(texture), { level: texture, name: '0031.png' });
assert.deepEqual(parseTexRef(legacy), parseTexRef(texture), 'existing suffixed references remain readable');
assert.equal(resolveTerrainTexRef('Custom', texture), texture);
assert.deepEqual(resolvePropTex('@models', texture), parseTexRef(texture));
assert.deepEqual(resolvePropTex('@models', legacy), parseTexRef(texture));
assert.equal(texDestName(texture), texDestName(legacy), 'portable filenames do not change with reference spelling');
assert.equal(textureRefUrl(texture), textureRefUrl(legacy), 'both spellings resolve the same cached resource');
assert.equal(makeTexRef('GARI', '0031.png'), 'GARI/0031.png');
assert.equal(makeTexRef('Custom', 'snow.png'), 'Custom/snow.png');
assert.deepEqual(parseTexRef('0031.png'), { level: '', name: '0031.png' });
assert.deepEqual(resolvePropTex('GARI', '0031.png'), { level: 'GARI', name: '0031.png' });
const prop = referenceAssetId('ssx-tricky', 'TRICKY_GARI', 'prop', '7', hash);
assert.equal(makeTexRef(prop, 'leaves.png'), `${prop}/leaves.png`, 'multi-image prop dependencies still select a file');
const nested = referenceAssetId('ssx-tricky', 'TRICKY_GARI', 'texture', 'tiles/snow.png', hash);
assert(!nested.includes('/'));
assert.deepEqual(parseTexRef(nested), { level: nested, name: 'tiles/snow.png' });
assert.equal(makeTexRef(nested, 'tiles/snow.png'), nested);
assert.notEqual(
  makeTexRef(texture, 'different.png'),
  texture,
  'a mismatched filename must not silently become the pinned image',
);
assert(
  !assetRequestCovered(parseAssetVersion(texture)!, '/api/texture', new URLSearchParams({ name: 'different.png' })),
);

const materials = buildMaterialCombiner(new Map(), new Map([[texture, { kind: 'cutout' as const, glow: false }]]));
const slot = materials.resolveTileSlot(texture, [], false, undefined, true);
assert(slot >= 0, 'authored models/rail skins accept standalone references');
assert.equal(materials.resolveTileSlot(legacy, [], false, undefined, true), slot);
assert.equal(materials.texCopies.length, 1);
assert.deepEqual({ level: materials.texCopies[0].level, name: materials.texCopies[0].name }, parseTexRef(texture));
assert.equal(
  materials.alphaOverrides[materials.texCopies[0].dest],
  'cutout',
  'pixel alpha survives canonical reference keys',
);
console.log(
  'TEXTURE REFERENCES PASS: standalone IDs, old suffixes, terrain/props, URL/cache identity, portable copies and alpha policy.',
);
