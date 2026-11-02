// tier: fast
import assert from 'node:assert/strict';
import { previewAssetMigration } from '../src/core/reference/asset-migration';
import { referenceAssetId, type AssetManifest, type ReferenceAssetKind } from '../src/core/reference/asset-manifest';
import { assetVersion } from '../src/core/reference/asset-version';
import type { MapSourceChoice } from '../src/core/reference/map-game';

const game = 'ssx-tricky',
  map = 'TRICKY_GARI';
function manifest(hash: string): AssetManifest {
  const asset = (kind: ReferenceAssetKind, key: string) => ({
    id: referenceAssetId(game, map, kind, key, hash),
    game,
    map,
    kind,
    key,
    hash,
    files: {},
  });
  return {
    schema: 'openslope-assets/v1',
    game,
    map,
    assets: [asset('texture', 'tile.png'), asset('prop', '0'), asset('body', '0')],
  };
}
const local = manifest('a'.repeat(64)),
  server = manifest('b'.repeat(64));
const original = assetVersion(game, map, 'c'.repeat(64));
const copies: MapSourceChoice[] = [
  { name: 'server:TRICKY_GARI', source: 'server' },
  { name: 'local:TRICKY_GARI', source: 'local' },
];
const sources = {
  maps: async () => copies,
  manifest: async (location: string) => (location.startsWith('local:') ? local : server),
  version: async () => original,
};
const document = {
  quadTex: { neutral: 'GARI/tile.png', local: 'local:GARI/tile.png', server: 'server:GARI/tile.png' },
  props: [{ level: 'GARI', model: 0, nativeCollision: { physicsSource: { level: 'GARI', body: 0 } } }],
};
const before = structuredClone(document);
const preview = await previewAssetMigration(document, sources);
const row = (from: string) => preview.rows.find(row => row.from === from)!;
assert.equal(row('GARI/tile.png').source, 'local:TRICKY_GARI', 'a server workspace pins the local copy it renders');
assert.equal(row('GARI/tile.png').to, local.assets[0].id);
assert.equal(row('local:GARI/tile.png').source, 'local:TRICKY_GARI');
assert.equal(row('server:GARI/tile.png').source, 'server:TRICKY_GARI');
const modelRows = preview.rows.filter(row => row.from === 'GARI');
assert.equal(modelRows.length, 2);
assert(modelRows.every(row => row.source === 'local:TRICKY_GARI'));
assert.deepEqual(document, before, 'discovering different copies does not change the map');

const partial = await previewAssetMigration(document, {
  ...sources,
  manifest: async location => (location.startsWith('local:') ? { ...local, assets: [] } : server),
});
assert.equal(
  partial.rows.find(row => row.from === 'GARI/tile.png')?.source,
  'server:TRICKY_GARI',
  'missing local assets fall back to server',
);
assert.equal(
  partial.rows.find(row => row.from === 'local:GARI/tile.png')?.status,
  'missing',
  'explicit local references never switch to server',
);

const unavailable = await previewAssetMigration(document, {
  ...sources,
  manifest: async location => {
    if (location.startsWith('local:')) throw new Error('local copy unavailable');
    return server;
  },
});
assert.equal(unavailable.rows.find(row => row.from === 'GARI/tile.png')?.source, 'server:TRICKY_GARI');
assert.equal(unavailable.rows.find(row => row.from === 'local:GARI/tile.png')?.status, 'missing');

const localOnly = await previewAssetMigration(document, { ...sources, maps: async () => [copies[1]] });
assert.equal(localOnly.rows.find(row => row.from === 'server:GARI/tile.png')?.status, 'missing');
const serverOnly = await previewAssetMigration(document, { ...sources, maps: async () => [copies[0]] });
assert.equal(serverOnly.rows.find(row => row.from === 'GARI/tile.png')?.source, 'server:TRICKY_GARI');
assert.equal(serverOnly.rows.find(row => row.from === 'local:GARI/tile.png')?.status, 'missing');

const aliases = await previewAssetMigration(
  { quadTex: { a: 'GARI/tile.png' } },
  {
    ...sources,
    maps: async () => [{ name: 'server:GARI', source: 'server' }, copies[1]],
  },
);
assert.equal(
  aliases.rows[0].source,
  'local:TRICKY_GARI',
  'resolve bank aliases within each source before falling back to server',
);

const pinnedDocument = { quadTex: { a: `${original.id}/tile.png` } };
const pinned = await previewAssetMigration(pinnedDocument, { ...sources, manifest: async () => server });
assert.equal(pinned.rows[0].source, 'local:TRICKY_GARI');
assert.equal(pinned.rows[0].status, 'verified');
const exactServer = await previewAssetMigration(pinnedDocument, {
  ...sources,
  version: async location => (location.startsWith('local:') ? assetVersion(game, map, 'd'.repeat(64)) : original),
});
assert.equal(exactServer.rows[0].source, 'server:TRICKY_GARI', 'an exact server bank beats a different local version');
assert.equal(exactServer.rows[0].status, 'verified');
console.log(
  'ASSET MIGRATION SOURCES PASS: local-first textures/props/bodies, explicit sources, aliases, missing copies and exact bank versions.',
);
