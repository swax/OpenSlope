// tier: integration
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { encodePng } from '../src/server/routes/png';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-selected-browser-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: { '/api': { target: api.url, ws: true } },
  },
});
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = value => value');
  await page.route('**/audit.html', route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Selected assets</title>' }),
  );
  await page.goto(`${origin}/audit.html`);
  const seeded = await page.evaluate(
    async pixels => {
      const cacheUrl = '/src/app/public/iso-cache.ts',
        localUrl = '/src/app/public/lazy-local-map-data.ts',
        apiUrl = '/src/app/public/local-asset-api.ts',
        matchUrl = '/src/app/public/imported-assets.ts',
        workspaceUrl = '/src/app/net/workspace.ts',
        versionsUrl = '/src/app/net/asset-versions.ts',
        mountainUrl = '/src/core/doc/mountain.ts',
        projectsUrl = '/src/app/state/local-projects.ts';
      const cache = await import(/* @vite-ignore */ cacheUrl);
      const { lazyLocalMapData } = await import(/* @vite-ignore */ localUrl);
      const { installLocalAssetApi } = await import(/* @vite-ignore */ apiUrl);
      const { matchImportedAssets } = await import(/* @vite-ignore */ matchUrl);
      const { workspaceFetch, exactWorkspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
      const { reportImportedAssetReplacements } = await import(/* @vite-ignore */ versionsUrl);
      const { defaultMountain } = await import(/* @vite-ignore */ mountainUrl);
      const course = 'SSX3_ABC1',
        db = await cache.openIsoCache();
      const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' });
      const files = {
        'Import.json': json({ Game: 'ssx-3', Course: course }),
        'Patches.json': json({ Patches: [] }),
        'Models.json': json({
          Models: ['Tree', 'Unrelated'].map((ModelName, id) => ({
            ModelName,
            ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: `${id}.obj`, MaterialID: id }] }],
          })),
        }),
        'Instances.json': json({
          Instances: [0, 1].map(ModelID => ({
            ModelID,
            Location: [0, 0, 0],
            Rotation: [0, 0, 0, 1],
            Scale: [1, 1, 1],
          })),
        }),
        'Materials.json': json({ Materials: [{ TexturePath: 'snow_o.png' }, { TexturePath: 'unused.png' }] }),
        'Meshes/0.obj': new Blob(['v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n']),
        'Meshes/1.obj': new Blob(['v 0 0 0\nv 200 0 0\nv 0 200 0\nf 1 2 3\n']),
        'Textures/snow_o.png': new Blob([new Uint8Array(pixels)], { type: 'image/png' }),
        'Textures/unused.png': new Blob([new Uint8Array(pixels)], { type: 'image/png' }),
      };
      await cache.cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        for (const [path, blob] of Object.entries(files))
          store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
      });
      await cache.cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({
          course,
          version: cache.isoCourseCacheVersion(course),
          files: Object.keys(files).length,
          revision: 'first-import',
        }),
      );
      const doc = defaultMountain();
      const oldTexture = `asset2:ssx-3:SSX3_PEAK1:texture:snow.png:${'a'.repeat(64)}`;
      const oldProp = `asset2:ssx-3:SSX3_PEAK1:prop:17:${'b'.repeat(64)}`;
      doc.name = 'COMPAT_EDITOR';
      doc.quadTex = {
        ...Object.fromEntries(Object.keys(doc.quadTex ?? {}).map(key => [key, `${oldTexture}/snow.png`])),
        0: `${oldTexture}/snow.png`,
      };
      doc.props = [{ id: 'tree', level: oldProp, model: 17, name: 'Tree', pos: [0, 0, 0], yaw: 0, scale: 1 }];
      const saved = JSON.stringify(doc);
      async function load() {
        const local = await lazyLocalMapData([course]);
        const reads: string[] = [];
        const read = local.source.readTextOrNull;
        local.source.readTextOrNull = async (path: string) => {
          if (path.endsWith('.obj')) reads.push(path);
          return read(path);
        };
        installLocalAssetApi(local, [course], false);
        const matched = await matchImportedAssets(doc);
        reportImportedAssetReplacements(matched.replacements);
        return { local, reads, matched };
      }
      const cold = await load();
      const propResponse = await workspaceFetch(`/api/props?level=${encodeURIComponent(oldProp)}`);
      const prop = await propResponse.json();
      const textureResponse = await workspaceFetch(
        `/api/texture?level=${encodeURIComponent(oldTexture)}&name=snow.png`,
      );
      const textureBytes = Array.from(new Uint8Array(await textureResponse.arrayBuffer()));
      const coldReads = [...cold.reads];
      cold.local.dispose();
      const warm = await load(),
        warmReads = [...warm.reads];
      const previous = warm.matched.document.quadTex[0];
      const strict = await exactWorkspaceFetch(`/api/texture?level=${encodeURIComponent(oldTexture)}&name=snow.png`);
      warm.local.dispose();
      // Reimported bytes under the same course/cache version must invalidate the derived catalogue.
      await cache.cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({
          course,
          version: cache.isoCourseCacheVersion(course),
          files: Object.keys(files).length,
          revision: 'second-import',
        }),
      );
      await cache.cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        const path = 'Textures/snow_o.png',
          blob = new Blob([new Uint8Array([...pixels, 0])], { type: 'image/png' });
        store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
      });
      const reimported = await load();
      const invalidated = reimported.matched.document.quadTex[0] !== previous;
      const reimportReads = [...reimported.reads];
      reimported.local.dispose();
      db.close();
      const projects = await (await import(/* @vite-ignore */ projectsUrl)).openLocalProjects();
      const project = await projects.seed(doc);
      projects.close();
      return {
        id: project.project.id,
        name: project.project.name,
        oldProp,
        oldTexture,
        coldReads,
        warmReads,
        replacements: cold.matched.replacements.length,
        propStatus: propResponse.status,
        propModel: prop.models[0]?.id,
        textureBytes,
        strict: strict.status,
        unchanged: JSON.stringify(doc) === saved,
        invalidated,
        reimportReads,
      };
    },
    Array.from(encodePng({ w: 1, h: 1, data: new Uint8Array([245, 245, 245, 255]) })),
  );
  assert.equal(seeded.replacements, 2);
  assert.equal(seeded.propStatus, 200);
  assert.equal(seeded.propModel, 17);
  assert.equal(
    seeded.coldReads.length,
    1,
    'only the named model is baked, even when its old slot belongs to another bank',
  );
  assert.equal(seeded.warmReads.length, 0, 'a new editor/player workspace reuses the persisted selected-model bake');
  assert.equal(seeded.strict, 404, 'rendering replacements cannot certify old bytes for automatic migration');
  assert(seeded.unchanged && seeded.invalidated);
  assert.equal(seeded.reimportReads.length, 1);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/editor/${encodeURIComponent(seeded.name)}?local=${encodeURIComponent(seeded.id)}`);
  await page.waitForFunction(
    () => window.document.getElementById('load-status')?.getAttribute('aria-busy') === 'false',
    null,
    { timeout: 90_000 },
  );
  const editor = await page.evaluate(async ({ oldProp, oldTexture, id }) => {
    const workspaceUrl = '/src/app/net/workspace.ts',
      versionsUrl = '/src/app/net/asset-versions.ts',
      projectsUrl = '/src/app/state/local-projects.ts';
    const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
    const { importedAssetReplacements } = await import(/* @vite-ignore */ versionsUrl);
    const { readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
    const props = await workspaceFetch(`/api/props?level=${encodeURIComponent(oldProp)}`);
    const texture = await workspaceFetch(`/api/texture?level=${encodeURIComponent(oldTexture)}&name=snow.png`);
    const bitmap = texture.ok ? await createImageBitmap(await texture.blob()) : undefined;
    const stored = await readLocalProject(id);
    return {
      count: importedAssetReplacements().length,
      props: props.status,
      models: (await props.json()).models?.map((model: { id: number }) => model.id),
      width: bitmap?.width,
      storedProp: stored.document.props[0].level,
      storedTexture: stored.document.quadTex[0],
    };
  }, seeded);
  assert.equal(editor.count, 2, 'actual editor startup prepares compatible imports');
  assert.equal(editor.props, 200);
  assert.deepEqual(editor.models, [17]);
  assert.equal(editor.width, 1, 'the editor can decode the replacement texture');
  assert.equal(editor.storedProp, seeded.oldProp);
  assert.equal(editor.storedTexture, `${seeded.oldTexture}/snow.png`);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(root, 'editor.png') });
  console.log(
    `Selected asset browser PASS: cold/warm/reimport reads ${seeded.coldReads.length}/${seeded.warmReads.length}/${seeded.reimportReads.length}, real editor models/textures, unchanged saved references. Artifacts: ${root}`,
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
