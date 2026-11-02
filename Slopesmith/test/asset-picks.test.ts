// tier: fast
import assert from 'node:assert/strict';
import { assetVersion } from '../src/core/reference/asset-version';
import { referenceAssetId, type ReferenceAssetKind, type AssetManifest } from '../src/core/reference/asset-manifest';
import {
  assetLocation,
  configureAssetTransport,
  pinReferenceAsset,
  pinReferenceAssets,
  referenceLibraryBank,
  clearAssetCatalogue,
} from '../src/app/net/asset-versions';
import {
  collisionSoundLevel,
  registerCollisionSoundIndex,
  resolveCollisionSound,
  collisionSoundSource,
} from '../src/core/effects/collision-sound';
import { effectSoundUrl } from '../src/app/net/asset-paths';

const game = 'ssx-tricky',
  map = 'TRICKY_GARI';
function manifest(hash: string): AssetManifest {
  const asset = (kind: ReferenceAssetKind, key: string) => ({
    kind,
    key,
    hash,
    files: {},
    game,
    map,
    id: referenceAssetId(game, map, kind, key, hash),
  });
  return {
    schema: 'openslope-assets/v1',
    game,
    map,
    assets: [asset('texture', 'tile.png'), asset('prop', '0'), asset('body', '0')],
  };
}
let localBank = assetVersion(game, map, 'a'.repeat(64)),
  local = manifest('1'.repeat(64));
const serverBank = assetVersion(game, map, 'b'.repeat(64)),
  server = manifest('2'.repeat(64));
const requests: string[] = [];
let manifestUnavailable = false;
configureAssetTransport(async input => {
  const url = new URL(String(input), 'http://localhost');
  requests.push(url.pathname);
  if (url.pathname === '/api/levels') return Response.json({ levels: ['server:TRICKY_GARI', 'local:TRICKY_GARI'] });
  const isLocal = url.searchParams.get('level')?.startsWith('local:');
  if (url.pathname === '/api/map-asset-version') return Response.json(isLocal ? localBank : serverBank);
  if (url.pathname === '/api/map-asset-manifest')
    return manifestUnavailable ? new Response('', { status: 503 }) : Response.json(isLocal ? local : server);
  throw new Error(`Unexpected request ${url}`);
});
assert.equal(await pinReferenceAsset('local:GARI', 'texture', 'tile.png'), local.assets[0].id);
assert.equal(await pinReferenceAsset('server:GARI', 'texture', 'tile.png'), server.assets[0].id);
assert.equal(await pinReferenceAsset('GARI', 'prop', '0'), local.assets[1].id);
assert.equal(await pinReferenceAsset(localBank.id, 'body', '0'), local.assets[2].id);
assert.equal(assetLocation(local.assets[1].id), 'local:TRICKY_GARI');
assert.equal((await pinReferenceAssets(localBank.id, 'texture', ['tile.png'])).get('tile.png'), local.assets[0].id);
assert.equal(await pinReferenceAsset(local.assets[0].id, 'texture', 'tile.png'), local.assets[0].id);
await assert.rejects(pinReferenceAsset(local.assets[0].id, 'prop', '0'), /does not cover/);
await assert.rejects(pinReferenceAsset(localBank.id, 'texture', 'missing.png'), /unavailable/);

const originalTexture = local.assets[0].id;
localBank = assetVersion(game, map, 'c'.repeat(64));
assert.equal(
  await referenceLibraryBank(originalTexture),
  localBank.id,
  'sampling an unchanged individual texture uses the current surrounding bank',
);
local = manifest('3'.repeat(64));
localBank = assetVersion(game, map, 'd'.repeat(64));
assert.equal(await pinReferenceAsset('local:GARI', 'texture', 'tile.png'), local.assets[0].id);
await assert.rejects(
  pinReferenceAsset(assetVersion(game, map, 'a'.repeat(64)).id, 'prop', '0'),
  /unavailable/,
  'an old bank cannot silently select a new different prop',
);
requests.length = 0;
for (const level of ['Custom', '@models', '@import']) assert.equal(await pinReferenceAsset(level, 'prop', '0'), level);
assert.deepEqual(requests, [], 'project-owned assets never need a retail manifest');
manifestUnavailable = true;
clearAssetCatalogue();
await assert.rejects(
  pinReferenceAsset('local:GARI', 'texture', 'tile.png'),
  /unavailable/,
  'manifest failures do not fall back to unversioned picks',
);
manifestUnavailable = false;
assert.equal(
  await pinReferenceAsset('local:GARI', 'texture', 'tile.png'),
  local.assets[0].id,
  'failed reads can retry',
);

registerCollisionSoundIndex({
  Schema: 'openslope-sound-index/v1',
  Level: 'GARI',
  Banks: { '2': 'garibaldi' },
  CollisionEvents: { '7': { Group: 2, Slot: 3, Bank: 'garibaldi', Clip: 'Audio/SFX/garibaldi/003.wav' } },
});
const prop = local.assets[1].id;
assert.equal(collisionSoundLevel(prop), 'GARI');
assert.deepEqual(resolveCollisionSound(7, prop), { bank: 'course', slot: 3 });
assert.equal(collisionSoundSource(prop, 7), 'GARI/garibaldi/003.wav');
assert.equal(new URL(effectSoundUrl(prop, 3, 'course'), 'http://localhost').searchParams.get('level'), 'GARI');
assert.equal(collisionSoundLevel(serverBank.id), serverBank.id, 'existing bank audio references are unchanged');
console.log(
  'ASSET PICKS PASS: automatic texture/prop/body identities, exact previews, source choices, refreshed banks, failure recovery, project assets and native sound routing.',
);
