// tier: fast
import assert from 'node:assert/strict';
import { compatibleImportedAssets } from '../src/core/reference/asset-compatibility';
import { referenceAssetId, type AssetManifest, type ReferenceAsset } from '../src/core/reference/asset-manifest';

function asset(
  game: string,
  map: string,
  kind: 'texture' | 'prop' | 'body',
  key: string,
  fingerprint: string,
  name?: string,
): ReferenceAsset {
  const hash = fingerprint.repeat(64);
  return {
    id: referenceAssetId(game, map, kind, key, hash),
    game,
    map,
    kind,
    key,
    hash,
    files: {},
    ...(name ? { name } : {}),
  };
}
const original = asset('ssx-3', 'SSX3_PEAK1', 'texture', '0197.png', 'a');
const imported = asset('ssx-3', 'SSX3_ABC1', 'texture', '0197_o.png', 'b');
const oldProp = asset('ssx-3', 'SSX3_PEAK1', 'prop', '7', 'c', 'tree');
const newProp = asset('ssx-3', 'SSX3_ABC1', 'prop', '42', 'd', 'tree');
newProp.compatibilityHash = 'e'.repeat(64);
const bank = (assets: ReferenceAsset[]): AssetManifest => ({
  schema: 'openslope-assets/v1',
  game: assets[0].game,
  map: assets[0].map,
  assets,
});
const document = {
  name: original.id,
  note: original.id,
  quadTex: { a: `${original.id}/0197.png`, b: imported.id },
  props: [{ level: oldProp.id, name: 'Tree', model: 7, pos: [1, 2, 3] }],
};
const before = structuredClone(document);
const matched = compatibleImportedAssets(document, [bank([imported, newProp])]);
assert.equal(
  matched.document.quadTex.a,
  `${imported.id}/0197_o.png`,
  'legacy bank and opacity suffix can use an unambiguous imported texture',
);
assert.equal(matched.document.props[0].level, newProp.id);
assert.equal(matched.document.props[0].model, 42, 'model numbering follows the replacement identity');
assert.deepEqual(matched.document.props[0].pos, [1, 2, 3]);
assert.equal(matched.document.quadTex.b, imported.id, 'exact references stay exact');
assert.equal(matched.document.name, original.id);
assert.equal(matched.document.note, original.id);
assert.deepEqual(document, before, 'compatibility does not rewrite saved content');
assert.equal(matched.replacements.length, 2);
assert.deepEqual(
  compatibleImportedAssets({ sprite: { level: original.id, name: '0197.png' } }, [bank([imported])]).document.sprite,
  { level: imported.id, name: '0197_o.png' },
  'structured texture sources keep their identity and filename together',
);
const importedModel = {
  document: {},
  importedProps: { level: '@import', materials: [{ tex: `${original.id}/0197.png` }] },
};
assert.equal(
  compatibleImportedAssets(importedModel, [bank([imported])]).document.importedProps.materials[0].tex,
  `${imported.id}/0197_o.png`,
  'game textures borrowed by custom models use the same imported identities',
);
const renumbered = asset('ssx-3', 'SSX3_ESS3', 'prop', '98', 'f', 'tree');
renumbered.compatibilityHash = newProp.compatibilityHash;
assert.equal(
  compatibleImportedAssets(document, [bank([newProp]), bank([renumbered])]).replacements.length,
  1,
  'identical reusable definitions can agree despite different local model numbers',
);
assert.equal(compatibleImportedAssets(document, [bank([original, imported, oldProp, newProp])]).replacements.length, 0);
assert.equal(
  compatibleImportedAssets(document, [bank([imported, newProp])], [original.id, oldProp.id]).replacements.length,
  0,
  'an exact server copy wins over imported replacements',
);

const ambiguous = asset('ssx-3', 'SSX3_ERA5', 'texture', '0197_o.png', 'e');
assert.equal(
  compatibleImportedAssets(document, [bank([imported]), bank([ambiguous])]).document.quadTex.a,
  document.quadTex.a,
  'different definitions with the same index are ambiguous',
);
const alpha = asset('ssx-3', 'SSX3_ABC1', 'texture', '0197_a.png', 'e');
assert.equal(
  compatibleImportedAssets(document, [bank([imported, alpha])]).document.quadTex.a,
  document.quadTex.a,
  'different opacity variants are ambiguous',
);
const beta = asset('ssx-3-beta', 'SSX3B_ABC1', 'texture', '0197_o.png', 'b');
assert.equal(
  compatibleImportedAssets(document, [bank([beta])]).replacements.length,
  0,
  'imports never cross game boundaries',
);
const custom = asset('slopesmith', 'PRIVATE_SOURCE', 'texture', '0197.png', 'a');
assert.equal(
  compatibleImportedAssets({ quadTex: { a: custom.id } }, [bank([{ ...imported, game: 'slopesmith' }])]).replacements
    .length,
  0,
  'original source-map assets cannot be guessed from retail art',
);
const own = asset('ssx-3', 'SSX3_PEAK1', 'texture', '0197_o.png', 'e');
assert.equal(
  compatibleImportedAssets(document, [bank([own]), bank([imported])]).document.quadTex.a,
  `${own.id}/0197_o.png`,
  'an available original bank is preferred to unrelated maps',
);
assert.equal(
  compatibleImportedAssets({ props: [{ level: oldProp.id, name: 'My renamed prop', model: 7 }] }, [bank([newProp])])
    .replacements.length,
  0,
  'an unrecognized custom label cannot guess a model',
);
const wrongMap = asset('ssx-3', 'SSX3_ESS3', 'texture', '0197.png', 'a');
assert.equal(
  compatibleImportedAssets({ quadTex: { a: wrongMap.id } }, [bank([imported])]).replacements.length,
  0,
  'an absent ordinary course cannot borrow an unrelated course’s numeric texture index',
);
const explicitOpacity = asset('ssx-3', 'SSX3_PEAK1', 'texture', '0197_o.png', 'a');
assert.equal(
  compatibleImportedAssets({ quadTex: { a: explicitOpacity.id } }, [bank([alpha])]).replacements.length,
  0,
  'an explicitly opaque reference cannot silently select the alpha variant',
);
const oldBody = asset('ssx-tricky', 'TRICKY_GARI', 'body', '21', 'a');
const newBody = asset('ssx-tricky', 'TRICKY_GARI', 'body', '21', 'b');
const collision = { props: [{ nativeCollision: { physicsSource: { level: oldBody.id, body: 21 } } }] };
assert.equal(
  compatibleImportedAssets(collision, [bank([newBody])]).document.props[0].nativeCollision.physicsSource.level,
  newBody.id,
  'a collision resource can use the matching original-course body index',
);
const unrelatedBody = asset('ssx-tricky', 'TRICKY_SNOW', 'body', '21', 'b');
assert.equal(
  compatibleImportedAssets(collision, [bank([unrelatedBody])]).replacements.length,
  0,
  'collision body indices never cross source maps',
);
const oldBank = `asset1:ssx-3:SSX3_PEAK1:${'a'.repeat(64)}`;
const legacy = { quadTex: { a: `${oldBank}/0197.png` }, props: [{ level: oldBank, model: 7, name: 'Tree' }] };
const legacyMatched = compatibleImportedAssets(legacy, [bank([imported, newProp])]);
assert.equal(legacyMatched.document.quadTex.a, `${imported.id}/0197_o.png`);
assert.equal(
  legacyMatched.document.props[0].level,
  newProp.id,
  'old bank bindings can choose individual imported definitions',
);
assert.equal(legacyMatched.document.props[0].model, 42);
assert.equal(
  compatibleImportedAssets(legacy, [bank([imported, newProp])], [oldBank]).replacements.length,
  0,
  'exact whole-bank versions are preserved too',
);
const mislabeled = asset('ssx-3', 'SSX3_ABC1', 'prop', '42', 'a', 'rock');
assert.equal(
  compatibleImportedAssets({ props: [{ level: mislabeled.id, model: 42, name: 'Rock' }] }, [
    bank([newProp, asset('ssx-3', 'SSX3_ABC1', 'prop', '43', 'f', 'rock')]),
  ]).replacements.length,
  0,
  'a renamed placement cannot select a different model when its original source index still exists',
);
assert.equal(
  compatibleImportedAssets({ note: original.id }, [bank([imported])]).replacements.length,
  0,
  'asset ids in notes do not count as playback replacements',
);
console.log(
  'Imported asset compatibility: explicit identities, source isolation, ambiguity refusal and unchanged saved references PASS',
);
