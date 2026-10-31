// tier: fast
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from '../src/server/fs-async';
import { assetBankFiles, readAssetVersion } from '../src/shared/map-asset-version';
import { assetVersion, assetVersionsIn, parseAssetVersion } from '../src/core/reference/asset-version';
import { bindMapPayload } from '../src/app/net/map-source';
import { safeDataName } from '../src/core/export/names';
import {
  clearAssetCatalogue,
  configureAssetTransport,
  fetchVersionedAsset,
  pinAssetMap,
  pinDocumentAssets,
  assetPreference,
} from '../src/app/net/asset-versions';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-asset-versions-'));
const io = { root, ...fs };
for (const level of ['GARI', 'TRICKY_GARI']) {
  await mkdir(join(root, level, 'Textures'), { recursive: true });
  await mkdir(join(root, level, 'Meshes'));
  await mkdir(join(root, level, 'Source'));
  await writeFile(join(root, level, 'Textures/tile.png'), new Uint8Array([1, 2, 3]));
  await writeFile(join(root, level, 'Meshes/tree.obj'), level === 'GARI' ? 'v 0 0 0\r\n' : 'v 0 0 0\n');
  await writeFile(join(root, level, 'Models.json'), level === 'GARI' ? '{"a":1,"b":[2]}' : '{\n "b": [2], "a": 1\n}');
  await writeFile(
    join(root, level, 'Import.json'),
    JSON.stringify({ Game: 'ssx-tricky', DisplayName: level, Complete: level === 'GARI' }),
  );
  await writeFile(join(root, level, 'Source/raw.BIG'), level);
}
const first = await readAssetVersion(io, 'GARI');
const equivalent = await readAssetVersion(io, 'TRICKY_GARI');
assert.equal(first.id, equivalent.id, 'metadata, JSON formatting and line endings do not create different versions');
assert.equal(parseAssetVersion(first.id)?.map, 'TRICKY_GARI');
assert.deepEqual(assetVersionsIn({ props: [{ level: first.id }], tile: `${first.id}/tile.png` }), [first.id]);
await writeFile(join(root, 'TRICKY_GARI/Textures/tile.png'), new Uint8Array([4, 5, 6]));
assert.notEqual((await readAssetVersion(io, 'TRICKY_GARI')).id, first.id);
await writeFile(join(root, 'TRICKY_GARI/Textures/tile.png'), new Uint8Array([1, 2, 3]));
await writeFile(join(root, 'TRICKY_GARI/Models.json'), '{"a":2,"b":[2]}');
assert.notEqual((await readAssetVersion(io, 'TRICKY_GARI')).id, first.id);
assert((await assetBankFiles(io, 'GARI')).every(path => !path.startsWith('Source/')));

const other = assetVersion(first.game, first.map, 'b'.repeat(64));
let localVersion = first;
let serverVersion = first;
let serverAvailable = true;
let localAvailable = true;
const resources: string[] = [];
configureAssetTransport(async input => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost');
  if (url.pathname === '/api/levels')
    return Response.json({
      levels: ['local:TRICKY_GARI', 'server:TRICKY_GARI'],
      maps: [
        { name: 'local:TRICKY_GARI', game: 'ssx-tricky' },
        { name: 'server:TRICKY_GARI', game: 'ssx-tricky' },
      ],
    });
  if (url.pathname === '/api/map-asset-version') {
    const local = url.searchParams.get('level')!.startsWith('local:');
    return local
      ? localAvailable
        ? Response.json(localVersion)
        : new Response('', { status: 404 })
      : serverAvailable
        ? Response.json(serverVersion)
        : new Response('', { status: 404 });
  }
  const source = url.searchParams.get('mapSource')!;
  resources.push(source);
  return source === 'server' && !serverAvailable
    ? new Response('', { status: 404 })
    : Response.json({ level: url.searchParams.get('level'), source });
});
assert.equal(await pinAssetMap('local:TRICKY_GARI'), first.id);
assert.equal(await pinAssetMap('server:TRICKY_GARI'), first.id);
assert.equal(assetPreference(first.id), 'server');
let response = await fetchVersionedAsset(`/api/props?level=${encodeURIComponent(first.id)}`);
assert.equal((await response.json()).source, 'server');
serverAvailable = false;
response = await fetchVersionedAsset(`/api/props?level=${encodeURIComponent(first.id)}`);
assert.equal((await response.json()).source, 'local', 'a missing preferred server can use identical local assets');
localVersion = other;
clearAssetCatalogue();
resources.length = 0;
response = await fetchVersionedAsset(`/api/props?level=${encodeURIComponent(first.id)}`);
assert.equal(response.status, 404);
assert.deepEqual(resources, [], 'a different local version is never returned');
assert.equal(await pinAssetMap('local:TRICKY_GARI'), other.id);
serverAvailable = true;
serverVersion = other;
localAvailable = false;
clearAssetCatalogue();
response = await fetchVersionedAsset(`/api/texture?level=${encodeURIComponent(other.id)}&name=tile.png`);
assert.equal((await response.json()).source, 'server', 'a missing preferred local version can use the matching server');
const legacy = { props: [{ level: 'local:TRICKY_GARI', model: 0 }], quadTex: { a: 'Custom/mine.png' } };
await pinDocumentAssets(legacy);
assert.equal(
  legacy.props[0].level,
  'local:TRICKY_GARI',
  'missing original legacy data cannot be guessed from a different source',
);
assert.equal(legacy.quadTex.a, 'Custom/mine.png');
localAvailable = true;
await pinAssetMap('local:TRICKY_GARI');
const table = bindMapPayload(`/api/props/materials?level=${encodeURIComponent(other.id)}`, {
  tables: {
    TRICKY_GARI: ['server material'],
    localtricky_gari: ['local material'],
  },
}) as { tables: Record<string, string[]> };
assert.deepEqual(
  table.tables[safeDataName(other.id)],
  ['local material'],
  'a local version aliases its own material table, including case-insensitive local folder keys',
);
const upgrade = {
  props: [
    {
      level: 'local:TRICKY_GARI',
      model: 0,
      nativeCollision: { physicsSource: { level: 'local:TRICKY_GARI', body: 0 } },
    },
  ],
  quadTex: { a: 'local:TRICKY_GARI/tile.png' },
};
await pinDocumentAssets(upgrade);
assert.equal(upgrade.props[0].level, other.id);
assert.equal(upgrade.props[0].nativeCollision.physicsSource.level, other.id);
assert.equal(upgrade.quadTex.a, `${other.id}/tile.png`);
console.log(
  'Asset-bank fingerprints, canonical identity, both fallback directions, version mismatch rejection and legacy safety PASS',
);
