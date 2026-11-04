// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { encodePng } from '../src/server/routes/png';

const png = Array.from(encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 0, 255]) }));
const vite = await createServer({ root: process.cwd(), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = value => value');
  await page.route('**/audit.html', route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Legacy map test</title>' }),
  );
  await page.goto(`${origin}/audit.html`);
  const result = await page.evaluate(async pixels => {
    const cacheUrl = '/src/app/public/iso-cache.ts';
    const localUrl = '/src/app/public/lazy-local-map-data.ts';
    const apiUrl = '/src/app/public/local-asset-api.ts';
    const workspaceUrl = '/src/app/net/workspace.ts';
    const pinsUrl = '/src/app/net/asset-versions.ts';
    const projectsUrl = '/src/app/state/local-projects.ts';
    const mountainUrl = '/src/core/doc/mountain.ts';
    const propsUrl = '/src/shared/map-props.ts';
    const publicUrl = '/src/app/public/course-assets.ts';
    const compatibilityUrl = '/src/app/public/imported-assets.ts';
    const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = await import(cacheUrl);
    const { lazyLocalMapData: localMapData } = await import(localUrl);
    const { installLocalAssetApi } = await import(apiUrl);
    const { workspaceFetch } = await import(workspaceUrl);
    const { pinDocumentAssets, pinReferenceAssets } = await import(pinsUrl);
    const { openLocalProjects, readLocalProject } = await import(projectsUrl);
    const { defaultMountain } = await import(mountainUrl);
    const { readMaterialTables } = await import(propsUrl);
    const { publicMountainDocument } = await import(publicUrl);
    const { matchImportedAssets } = await import(compatibilityUrl);
    const fogUrl = '/api/particle-texture?name=fog0.png';
    const empty = await localMapData([]);
    const emptyParticleUrl = empty.resolveAsset(fogUrl);
    const emptyParticleRequest = await empty.resolveRequest(fogUrl);
    empty.dispose();
    const db = await openIsoCache();
    async function seed(course: string, files: Record<string, Blob>) {
      await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        for (const [path, blob] of Object.entries(files))
          store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
      });
      await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({ course, files: Object.keys(files).length, version: isoCourseCacheVersion(course) }),
      );
    }
    const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' });
    const files = {
      'Import.json': json({ Game: 'ssx-tricky', Course: 'TRICKY_GARI' }),
      'Patches.json': json({ Patches: [] }),
      'Models.json': json({
        Models: [
          { ModelName: 'Tree', ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
          {
            ModelName: 'Other tree',
            ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }],
          },
        ],
      }),
      'Materials.json': json({ Materials: [{ TexturePath: 'tile.png' }] }),
      'Instances.json': json({
        Instances: [
          { ModelID: 0, InstanceName: 'Tree', Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] },
          { ModelID: 1, InstanceName: 'Other tree', Location: [100, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] },
        ],
      }),
      'Physics.json': json({ Bodies: [], Note: 'collision alias' }),
      'Meshes/tree.obj': new Blob(['v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n']),
      'Textures/tile.png': new Blob([new Uint8Array(pixels)], { type: 'image/png' }),
      'Textures/prefixed-only.png': new Blob([new Uint8Array(pixels)], { type: 'image/png' }),
      'Textures/Particles/fog0.png': new Blob([new Uint8Array(pixels)], { type: 'image/png' }),
    };
    await seed('TRICKY_GARI', files);
    let cacheOpens = 0;
    const openDatabase = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name: string, version?: number) => {
      if (name === 'slopesmith-local-disc') cacheOpens++;
      return openDatabase(name, version);
    };
    const local = await localMapData(['TRICKY_GARI']);
    installLocalAssetApi(local, ['TRICKY_GARI'], false);
    const fogBytes = Array.from(
      new Uint8Array(await (await fetch(await local.resolveRequest(local.resolveAsset(fogUrl)))).arrayBuffer()),
    );
    const document = defaultMountain();
    document.name = 'LEGACY_ALIAS';
    document.quadTex = { 0: 'GARI/tile.png' };
    document.props = [{ id: 'tree', level: 'GARI', model: 0, name: 'Tree', pos: [0, 0, 0], yaw: 0, scale: 1 }];
    const projects = await openLocalProjects();
    const saved = await projects.seed(document);
    projects.close();
    const propResponse = await workspaceFetch('/api/props?level=local:GARI');
    const props = await propResponse.json();
    const texture = local.resolveAsset('/api/texture?level=local:GARI&name=tile.png');
    const textureBytes = Array.from(
      new Uint8Array(await (await fetch(await local.resolveRequest(texture))).arrayBuffer()),
    );
    const physics = await local.source.readJsonOr('GARI/Physics.json', null);
    const visible = publicMountainDocument(document, ['local:TRICKY_GARI']);
    const explicitServer = publicMountainDocument(
      { ...document, props: [{ ...document.props[0], level: 'server:GARI' }] },
      ['local:TRICKY_GARI'],
    );
    const serverUrl = '/api/texture?level=server:GARI&name=tile.png';
    const blockedServer = await workspaceFetch('/api/props?level=server:GARI');
    const pinned = structuredClone(document);
    await pinDocumentAssets(pinned);
    const version = pinned.props[0].level;
    const snapshot = await readLocalProject(saved.project.id);
    let meshReads = 0;
    const readText = local.source.readTextOrNull;
    local.source.readTextOrNull = async (path: string) => {
      if (path.endsWith('/Meshes/tree.obj')) meshReads++;
      return readText(path);
    };
    installLocalAssetApi(local, ['TRICKY_GARI'], false);
    const propPins = await pinReferenceAssets('local:TRICKY_GARI', 'prop', ['0', '1']);
    const manifestMeshReads = meshReads;
    const scopedModels = await Promise.all(
      [...propPins.values()].map(async id => {
        const response = await workspaceFetch(`/api/props?level=${encodeURIComponent(id)}`);
        if (!response.ok) throw new Error(`Pinned prop failed: ${await response.text()}`);
        const payload = await response.json();
        return {
          level: payload.level,
          models: payload.models.map((model: { id: number }) => model.id),
          instances: payload.instances.length,
        };
      }),
    );
    const pinMeshReads = meshReads;
    const staleBank = version.slice(0, version.lastIndexOf(':') + 1) + 'f'.repeat(64);
    const compatible = await matchImportedAssets({
      props: [{ level: staleBank, model: 0, name: 'Tree' }],
      quadTex: { 0: `${staleBank}/tile.png` },
    });
    const exactBank = await matchImportedAssets({ props: [{ level: version, model: 0, name: 'Tree' }] });
    const initial = {
      emptyParticleUrl,
      emptyParticleRequest,
      fogBytes,
      hasLegacy: local.hasLevel('GARI'),
      hasOtherGame: local.hasLevel('SSX_GARI'),
      propStatus: propResponse.status,
      modelCount: props.models.length,
      textureBytes,
      physics,
      visibleProps: visible.props.length,
      visibleTexture: visible.quadTex[0],
      explicitServerProps: explicitServer.props.length,
      serverUnchanged: local.resolveAsset(serverUrl) === serverUrl,
      blockedServer: blockedServer.status,
      pinnedVersion: version,
      pinnedTexture: pinned.quadTex[0],
      storedLevel: snapshot.document.props[0].level,
      manifestMeshReads,
      pinMeshReads,
      scopedModels,
      cacheOpens,
      compatibleProp: compatible.document.props[0].level,
      compatibleTexture: compatible.document.quadTex[0],
      exactBank: exactBank.document.props[0].level,
    };
    local.dispose();
    let disposedReadRejected = false;
    try {
      await local.source.readBytesOrNull('TRICKY_GARI/Textures/tile.png');
    } catch {
      disposedReadRejected = true;
    }
    indexedDB.open = openDatabase;
    await seed('TRICKY_GARI', { ...files, 'Physics.json': json({ Bodies: [], Note: 'changed bank' }) });
    const changed = await localMapData(['TRICKY_GARI']);
    installLocalAssetApi(changed, ['TRICKY_GARI'], false);
    const mismatch = await workspaceFetch(`/api/props?level=${encodeURIComponent(version)}`);
    changed.dispose();
    await seed('GARI', { 'Textures/tile.png': new Blob([new Uint8Array([42])]) });
    const both = await localMapData(['GARI', 'TRICKY_GARI']);
    const own = await both.source.readBytesOrNull('GARI/Textures/tile.png');
    const missing = await both.source.readBytesOrNull('GARI/Textures/prefixed-only.png');
    const tables = await readMaterialTables(both.source);
    const emptyExactTable = tables.get('gari')?.length;
    both.dispose();
    db.close();
    return {
      ...initial,
      mismatch: mismatch.status,
      own: Array.from(own),
      missing,
      emptyExactTable,
      disposedReadRejected,
    };
  }, png);
  assert.equal(
    result.emptyParticleUrl,
    '/api/particle-texture?name=fog0.png',
    'an empty ISO cache leaves shared fog on the server',
  );
  assert.equal(result.emptyParticleRequest, '/api/particle-texture?name=fog0.png');
  assert.deepEqual(result.fogBytes, png, 'local fog resolves from the extracted Particles directory');
  assert.equal(result.hasLegacy, true);
  assert.equal(result.hasOtherGame, false);
  assert.equal(result.propStatus, 200);
  assert(result.modelCount > 0);
  assert.deepEqual(result.textureBytes, png);
  assert.equal(result.physics.Note, 'collision alias');
  assert.equal(result.visibleProps, 1);
  assert.equal(result.visibleTexture, 'GARI/tile.png');
  assert.equal(result.explicitServerProps, 0);
  assert.equal(result.serverUnchanged, true);
  assert.equal(result.blockedServer, 404);
  assert(result.pinnedVersion.startsWith('asset1:ssx-tricky:TRICKY_GARI:'));
  assert.equal(result.pinnedTexture, `${result.pinnedVersion}/tile.png`);
  assert.equal(result.storedLevel, 'GARI', 'browser-local saved documents do not need rewriting');
  assert.equal(result.manifestMeshReads, 1, 'manifest creation parses shared model geometry once');
  assert.equal(
    result.pinMeshReads,
    result.manifestMeshReads,
    'individual pinned props reuse the manifest’s decoded bank',
  );
  assert.deepEqual(
    result.scopedModels.map(value => value.models),
    [[0], [1]],
    'each pinned response contains only its requested model',
  );
  assert(result.scopedModels.every(value => value.level.startsWith('asset2:') && value.instances === 0));
  assert.equal(result.cacheOpens, 1, 'metadata, geometry and texture reads share one IndexedDB connection');
  assert.equal(result.disposedReadRejected, true, 'a disposed workspace cannot open another database connection');
  assert(result.compatibleProp.startsWith('asset2:'), 'old bank-bound props use real per-asset imported identities');
  assert(result.compatibleTexture.startsWith('asset2:') && result.compatibleTexture.endsWith('/tile.png'));
  assert.equal(result.exactBank, result.pinnedVersion, 'an available exact bank remains preferred');
  assert.equal(result.mismatch, 404, 'a renamed bank with different content cannot satisfy a fingerprint');
  assert.deepEqual(result.own, [42]);
  assert.equal(result.missing, null, 'missing files in an existing bank never mix with its prefixed copy');
  assert.equal(result.emptyExactTable, 0);
  console.log(
    'Legacy Tricky browser storage, local assets, source isolation, public filtering and exact fingerprints PASS',
  );
} finally {
  await browser.close();
  await vite.close();
}
