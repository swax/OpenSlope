// tier: integration
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { responseCache } from '../src/server/response-cache';
import { encodePng } from '../src/server/routes/png';
import type { AssetVersion } from '../src/core/reference/asset-version';
import { prepareServerAssetVersions, resolveVersionedApiUrl } from '../src/server/asset-versions';
import { serverMapName } from '../src/core/reference/map-source';
import { defaultMountain } from '../src/core/doc/mountain';
import { exportLevel } from '../src/server/routes/export';
import { projectIsoCourses } from '../src/server/public-courses';
import type { IncomingMessage, ServerResponse } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-version-server-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
const bank = join(root, 'Maps', 'TRICKY_GARI');
mkdirSync(join(bank, 'Textures'), { recursive: true });
mkdirSync(join(bank, 'Meshes'));
writeFileSync(join(bank, 'Meshes/tree.obj'), 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n');
for (const [file, value] of Object.entries({
  'Import.json': { Game: 'ssx-tricky', DisplayName: 'Garibaldi' },
  'Models.json': {
    Models: [
      { ModelName: 'Tree', ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
    ],
  },
  'Instances.json': { Instances: [] },
  'Materials.json': { Materials: [{ TexturePath: 'tile.png' }] },
}))
  writeFileSync(join(bank, file), JSON.stringify(value));
const png = (r: number) => encodePng({ w: 1, h: 1, data: new Uint8Array([r, 0, 0, 255]) });
writeFileSync(join(bank, 'Textures/tile.png'), png(255));
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const get = (path: string) => fetch(api.url + path);
try {
  const descriptor = async () => {
    const response = await get('/api/map-asset-version?level=TRICKY_GARI');
    assert.equal(response.status, 200);
    return (await response.json()) as AssetVersion;
  };
  const first = await descriptor();
  const texture = (id: string) => `/api/texture?level=${encodeURIComponent(id)}&name=tile.png`;
  assert.equal((await get('/api/texture?level=TRICKY_GARI&name=tile.png')).status, 200);
  assert.deepEqual(Buffer.from(await (await get(texture(first.id))).arrayBuffer()), png(255));
  await prepareServerAssetVersions({ props: [{ level: first.id, model: 0 }] });
  assert.equal(serverMapName(first.id), 'TRICKY_GARI', 'server exports resolve the neutral bank identity');
  const document = defaultMountain();
  document.name = 'VERSIONED_EXPORT';
  document.quadTex = { 0: `${first.id}/tile.png` };
  document.props = [{ id: 'tree', level: first.id, model: 0, name: 'Tree', pos: [0, 0, 0], yaw: 0, scale: 1 }];
  assert.deepEqual(
    projectIsoCourses(document),
    ['TRICKY_GARI'],
    'public ISO requirements contain readable courses, not opaque version IDs',
  );
  const out = join(root, 'export');
  await exportLevel(document, { outDir: out, lighting: false });
  const models = JSON.parse(readFileSync(join(out, 'Models.json'), 'utf8')) as { Models: unknown[] };
  assert(models.Models.length > 0, 'versioned source geometry is exported');
  const textures = readdirSync(join(out, 'Textures')).map(name => readFileSync(join(out, 'Textures', name)));
  assert(
    textures.some(bytes => bytes.equals(png(255))),
    'versioned terrain and material art is copied into the export',
  );
  const sidecar = readFileSync(join(out, 'Slopesmith.json'), 'utf8');
  assert(sidecar.includes(first.id), 'the round-trip export preserves content identity');
  writeFileSync(join(bank, 'Textures/tile.png'), png(128));
  responseCache.clear();
  assert.equal((await get(texture(first.id))).status, 404, 'changed texture bytes cannot answer an older pinned URL');
  assert.equal(
    (await get(`/api/props?level=${encodeURIComponent(first.id)}`)).status,
    404,
    'changed banks cannot answer old prop versions',
  );
  await assert.rejects(prepareServerAssetVersions({ props: [{ level: first.id }] }), /Matching asset version/);
  const second = await descriptor();
  assert.notEqual(second.id, first.id);
  assert.deepEqual(Buffer.from(await (await get(texture(second.id))).arrayBuffer()), png(128));
  assert.equal((await get(`/api/props?level=${encodeURIComponent(second.id)}`)).status, 200);
  await assert.rejects(
    responseCache.json(
      { url: `/?assetVersion=${encodeURIComponent(second.id)}`, headers: {} } as IncomingMessage,
      {} as ServerResponse,
      'version-race',
      async () => {
        writeFileSync(join(bank, 'Materials.json'), JSON.stringify({ Materials: [] }));
        return { changedDuringBuild: true };
      },
    ),
    /Matching asset version/,
    'a map replaced while generating JSON cannot be cached under the previous version',
  );
  assert.equal(
    new URL(
      await resolveVersionedApiUrl(`/api/props?level=TRICKY_GARI&assetVersion=${encodeURIComponent(first.id)}`),
      api.url,
    ).searchParams.has('assetVersion'),
    false,
    'unverified query parameters cannot poison versioned caches',
  );
  assert.equal((await get('/api/map-asset-version?level=..%2F..')).status, 404);
  console.log(
    'Server asset versions: current content, immutable image validation, JSON cache isolation, exports and path safety PASS',
  );
} finally {
  await api.close();
}
