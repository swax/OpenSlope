// tier: fast
import assert from 'node:assert/strict';
import { normalizeReusedReferences, hasAsset1References } from '../src/app/net/reference-reuse';
import { assetVersion } from '../src/core/reference/asset-version';
import { referenceAssetId, type AssetManifest } from '../src/core/reference/asset-manifest';
import type { AssetMigrationSources } from '../src/core/reference/asset-migration';

const bank = assetVersion('ssx-tricky', 'TRICKY_GARI', 'a'.repeat(64));
const current = assetVersion(bank.game, bank.map, 'b'.repeat(64));
const assets = (['texture', 'prop', 'body'] as const).map(kind => {
  const key = kind === 'texture' ? 'tile.png' : '7';
  return {
    game: bank.game,
    map: bank.map,
    kind,
    key,
    hash: '1'.repeat(64),
    files: {},
    id: referenceAssetId(bank.game, bank.map, kind, key, '1'.repeat(64)),
  };
});
const manifest: AssetManifest = { schema: 'openslope-assets/v1', game: bank.game, map: bank.map, assets };
let version = bank;
let matches: boolean | undefined;
const sources: AssetMigrationSources = {
  async maps() {
    return [{ name: 'local:GARI', source: 'local' }];
  },
  async version() {
    return version;
  },
  async manifest() {
    return manifest;
  },
  async verify() {
    return matches;
  },
};
const original = {
  texture: `${bank.id}/tile.png`,
  entries: [{ prop: { level: bank.id, model: 7, nativeCollision: { physicsSource: { level: bank.id, body: 7 } } } }],
  template: { level: bank.id, model: 7 },
  custom: { texture: 'Custom/my.png' },
};
assert(hasAsset1References(original));
const pinned = await normalizeReusedReferences(original, sources);
assert.equal(pinned.texture, assets[0].id);
assert.equal(pinned.entries[0].prop.level, assets[1].id);
assert.equal(pinned.entries[0].prop.nativeCollision.physicsSource.level, assets[2].id);
assert.equal(pinned.template.level, assets[1].id);
assert.equal(original.template.level, bank.id);
assert.equal(pinned.custom.texture, 'Custom/my.png');
assert(!hasAsset1References(pinned));
version = current;
assert.deepEqual(
  await normalizeReusedReferences(original, sources),
  original,
  'a replacement is never an automatic upgrade',
);
matches = false;
assert.deepEqual(await normalizeReusedReferences(original, sources), original, 'known different assets stay unchanged');
matches = true;
assert.deepEqual(
  await normalizeReusedReferences(original, sources),
  pinned,
  'exact bytes can verify assets after unrelated bank changes',
);
const offline = {
  ...sources,
  async maps(): Promise<never> {
    throw new Error('offline');
  },
};
assert.deepEqual(await normalizeReusedReferences(original, offline), original);
console.log(
  'Reference reuse: exact model/texture/body pins, independent copies, changed banks, unavailable originals and offline preservation PASS',
);
