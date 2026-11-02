// tier: fast
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fs from '../src/server/fs-async';
import { readAssetManifest } from '../src/shared/map-asset-manifest';
import { readAssetVersion } from '../src/shared/map-asset-version';
import { manifestAsset, referenceAssetId } from '../src/core/reference/asset-manifest';
import { parseAssetVersion, assetVersionsIn } from '../src/core/reference/asset-version';
import { previewAssetMigration, applyAssetMigration } from '../src/core/reference/asset-migration';
import { createAssetReader } from '../src/app/net/asset-reader';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { safeDataName } from '../src/core/export/names';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-asset-manifest-'));
let catalogueAttempts = 0;
const retryingCatalogue = createAssetReader(async () =>
  ++catalogueAttempts === 1 ? new Response('', { status: 503 }) : Response.json({ levels: ['server:TRICKY_GARI'] }),
);
assert.deepEqual(await retryingCatalogue.maps(), []);
assert.equal((await retryingCatalogue.maps()).length, 1, 'a failed catalogue read is not a permanent empty result');
const level = 'TRICKY_GARI',
  bank = join(root, level),
  io = { root, ...fs };
await mkdir(join(bank, 'Textures'), { recursive: true });
await mkdir(join(bank, 'Meshes'));
const save = (path: string, value: unknown) => writeFile(join(bank, path), JSON.stringify(value));
await save('Import.json', { Game: 'ssx-tricky' });
await save('Models.json', {
  Models: [
    { ModelName: 'Tree', ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
  ],
});
await save('Instances.json', {
  Instances: [{ ModelID: 0, Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] }],
});
await save('Materials.json', { Materials: [{ TexturePath: 'tile.png' }] });
await writeFile(join(bank, 'Meshes/tree.obj'), 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n');
await writeFile(join(bank, 'Textures/tile.png'), new Uint8Array([1, 2, 3]));
const originalBank = await readAssetVersion(io, level),
  original = await readAssetManifest(io, level);
const tile = manifestAsset(original, 'texture', 'tile.png')!,
  prop = manifestAsset(original, 'prop', '0')!;
assert(tile && prop);
assert.deepEqual(assetVersionsIn({ tile: `${tile.id}/tile.png`, props: [{ level: prop.id }] }), [tile.id, prop.id]);
assert.equal(parseAssetVersion(prop.id)?.kind, 'prop');
assert.equal(
  parseAssetVersion(referenceAssetId('ssx-tricky', level, 'texture', '../bad.png', 'a'.repeat(64))),
  undefined,
);
await writeFile(join(bank, 'Textures/unused.png'), new Uint8Array([7]));
await save('Instances.json', {
  Instances: [{ ModelID: 0, Location: [500, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] }],
});
const changedBank = await readAssetVersion(io, level),
  current = await readAssetManifest(io, level);
assert.notEqual(changedBank.id, originalBank.id);
assert.equal(manifestAsset(current, 'texture', 'tile.png')?.id, tile.id);
assert.equal(
  manifestAsset(current, 'prop', '0')?.id,
  prop.id,
  'unrelated art and source placement changes do not revise a reusable prop',
);
await save('Materials.json', { Materials: [{ TexturePath: 'tile.png', UnknownInt18: 256 }] });
assert.notEqual(
  manifestAsset(await readAssetManifest(io, level), 'prop', '0')?.id,
  prop.id,
  'raw export material fields are in the closure',
);
await save('Materials.json', { Materials: [{ TexturePath: 'tile.png' }] });
await writeFile(join(bank, 'Textures/tile.png'), new Uint8Array([4]));
assert.notEqual(
  manifestAsset(await readAssetManifest(io, level), 'prop', '0')?.id,
  prop.id,
  'used textures are in the closure',
);
await writeFile(join(bank, 'Textures/tile.png'), new Uint8Array([1, 2, 3]));

const document = {
  note: 'GARI/tile.png',
  quadTex: { a: `${originalBank.id}/tile.png`, b: 'GARI/tile.png', c: 'Custom/mine.png', d: 'GARI/missing.png' },
  props: [{ level: originalBank.id, model: 0 }],
};
const before = structuredClone(document);
const maps = [{ name: 'server:TRICKY_GARI', source: 'server' as const }];
const sources = { maps: async () => maps, manifest: async () => current, version: async () => changedBank };
const preview = await previewAssetMigration(document, sources);
assert.deepEqual(document, before, 'preview is read-only');
assert.equal(preview.rows.filter(row => row.status === 'replacement').length, 2);
assert.equal(preview.rows.filter(row => row.status === 'current').length, 1);
assert.equal(preview.rows.filter(row => row.status === 'missing').length, 1);
const selected = preview.rows.filter(row => row.status === 'current').map(row => row.id);
const result = applyAssetMigration(document, preview, selected);
assert.equal(result.quadTex.b, tile.id);
assert.equal(result.quadTex.a, before.quadTex.a, 'an unavailable old bank is not replaced without selection');
assert.equal(result.quadTex.c, before.quadTex.c);
assert.deepEqual(document, before);
assert.throws(() => applyAssetMigration({ ...document, name: 'edited' }, preview, selected), /changed/);
const exact = await previewAssetMigration(document, { ...sources, version: async () => originalBank });
assert.equal(exact.rows.filter(row => row.status === 'verified').length, 2);
const unavailableBank = await previewAssetMigration(document, {
  ...sources,
  version: async () => {
    throw new Error('unrelated broken bank data');
  },
});
assert.equal(
  unavailableBank.rows.filter(row => row.status === 'replacement').length,
  2,
  'valid individual assets remain reviewable when the whole-bank descriptor is unavailable',
);
const namedCustom = await previewAssetMigration(
  { quadTex: { a: 'Custom_GARI/tile.png', b: 'Custom/mine.png' } },
  { ...sources, maps: async () => [{ name: 'server:Custom_GARI', source: 'server' as const }] },
);
assert.equal(namedCustom.rows.length, 1, 'only the reserved Custom level is project-owned');
assert.equal(namedCustom.rows[0].status, 'current');
const requests: string[] = [];
let corrupted = false;
const reader = createAssetReader(async input => {
  const url = new URL(String(input), 'http://localhost');
  requests.push(url.pathname);
  if (url.pathname === '/api/levels') return Response.json({ levels: maps.map(map => map.name), maps });
  if (url.pathname === '/api/map-asset-manifest')
    return url.searchParams.get('level')?.startsWith('local:')
      ? new Response('', { status: 404 })
      : Response.json(current);
  return new Response(new Uint8Array(corrupted ? [9] : [1, 2, 3]));
});
assert.deepEqual(
  Array.from(new Uint8Array(await (await reader.fetch(`/api/texture?level=${tile.id}&name=tile.png`)).arrayBuffer())),
  [1, 2, 3],
);
corrupted = true;
assert.equal(
  (await reader.fetch(`/api/texture?level=${tile.id}&name=tile.png`)).status,
  404,
  'matching metadata never certifies different returned bytes',
);
assert.equal(
  (await reader.fetch(`/api/groups?level=${tile.id}`)).status,
  404,
  'an individual identity cannot expose unrelated bank resources',
);
const propPayload = await buildLevelPropsUncached(io, level);
const propReader = createAssetReader(async input => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/levels') return Response.json({ levels: maps.map(map => map.name), maps });
  if (url.pathname === '/api/map-asset-manifest')
    return url.searchParams.get('level')?.startsWith('local:')
      ? new Response('', { status: 404 })
      : Response.json(current);
  if (url.pathname === '/api/props/materials')
    return Response.json({
      tables: {
        servertricky_gari: ['verified server table'],
        localtricky_gari: ['other local table'],
        TRICKY_GARI: ['ambiguous table'],
      },
    });
  return Response.json(propPayload);
});
const propResponse = await propReader.fetch(`/api/props?level=${encodeURIComponent(prop.id)}`);
assert.equal(propResponse.status, 200);
const scoped = await propResponse.json();
assert.equal(scoped.level, prop.id);
assert.deepEqual(
  scoped.models.map((model: { id: number }) => model.id),
  [0],
);
assert.deepEqual(scoped.instances, [], 'reusable prop responses do not import donor placements');
const tables = await (await propReader.fetch(`/api/props/materials?level=${encodeURIComponent(prop.id)}`)).json();
assert.deepEqual(
  tables.tables[safeDataName(prop.id)],
  ['verified server table'],
  'scoped exports bind materials from the verified physical source',
);
await writeFile(join(bank, 'Models.json'), 'broken model table');
assert.equal(
  manifestAsset(await readAssetManifest(io, level), 'texture', 'tile.png')?.id,
  tile.id,
  'a broken prop table cannot hide an independent texture',
);
console.log(
  'Asset manifests: stable textures, complete prop dependencies, exact reads and preview-only migration PASS',
);
