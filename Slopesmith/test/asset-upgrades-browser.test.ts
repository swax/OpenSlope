// tier: integration
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { encodePng } from '../src/server/routes/png';
import { serverMapAssetVersion } from '../src/server/asset-versions';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import type { EditDoc } from '../src/core/doc/doc-edit';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-asset-upgrades-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
const bank = join(root, 'Maps/TRICKY_GARI');
const files: Record<string, string | Uint8Array> = {
  'Import.json': JSON.stringify({ Game: 'ssx-tricky' }),
  'Patches.json': JSON.stringify({ Patches: [] }),
  'Models.json': JSON.stringify({
    Models: [
      { ModelName: 'Tree', ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
    ],
  }),
  'Materials.json': JSON.stringify({ Materials: [{ TexturePath: 'tile.png' }] }),
  'Instances.json': JSON.stringify({ Instances: [] }),
  'Meshes/tree.obj': 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n',
  'Textures/tile.png': encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }),
};
mkdirSync(join(bank, 'Textures'), { recursive: true });
mkdirSync(join(bank, 'Meshes'));
for (const [path, bytes] of Object.entries(files)) writeFileSync(join(bank, path), bytes);
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript('globalThis.__name = value => value');
const errors: string[] = [];
page.on('pageerror', error => errors.push(error.message));
const original = await serverMapAssetVersion('TRICKY_GARI');
const missing = `asset1:ssx-tricky:TRICKY_GARI:${'f'.repeat(64)}/tile.png`;
const mountain = meshFromNet(
  {
    rows: 2,
    cols: 4,
    spacing: 20,
    corners: Array.from({ length: 8 }, (_, i) => [(i % 4) * 20, 0, Math.floor(i / 4) * 20]).flat(),
    paint: {},
  },
  { name: 'AUTO_ASSETS', course: starterCourse(), baseSurface: 1 },
);
mountain.quadTex = { 0: `${original.id}/tile.png`, 1: missing, 2: 'GARI/tile.png' };
mountain.props = [{ id: 'prop:auto', level: original.id, model: 0, name: 'Tree', pos: [5, 0, 5], yaw: 0, scale: 1 }];
try {
  const created = await fetch(`${api.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ document: mountain }),
  });
  assert(created.ok, await created.clone().text());
  const { project } = (await created.json()) as { project: { id: string } };
  await page.goto(`${origin}/editor/AUTO_ASSETS?project=${project.id}`);
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await page.waitForFunction(
    async id => {
      const response = await fetch(`/api/projects/${id}`);
      const body = await response.json();
      return (
        body.document?.quadTex?.[0]?.startsWith('asset2:') && body.document?.props?.[0]?.level?.startsWith('asset2:')
      );
    },
    project.id,
    { timeout: 90_000 },
  );
  const saved = (await (await fetch(`${api.url}/api/projects/${project.id}`)).json()) as { document: EditDoc };
  assert(saved.document.quadTex![2].startsWith('asset2:'), 'unversioned assets also upgrade after their bytes match');
  assert.equal(saved.document.quadTex![1], missing, 'a same-name replacement is never automatically selected');
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  await page.getByRole('button', { name: 'Review asset references…', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  for (const role of ['editor', 'moderator', 'viewer', 'admin']) {
    await page.evaluate(async role => {
      const url = '/src/app/net/account.ts';
      const { adoptAccount } = await import(/* @vite-ignore */ url);
      adoptAccount({
        id: 'menu-test',
        username: 'Menu test',
        bio: '',
        role,
        createdAt: '',
        lastSeenAt: '',
        availability: 'available',
        disabled: false,
      });
    }, role);
    await page.getByRole('button', { name: 'File menu', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Review asset references…', exact: true }).count(),
      role === 'admin' ? 1 : 0,
      `${role} menu visibility`,
    );
    await page.keyboard.press('Escape');
    if (role !== 'admin') {
      await page.evaluate(async () => {
        const url = '/src/app/ui/chrome/asset-migration.ts';
        const { showAssetMigration } = await import(/* @vite-ignore */ url);
        await showAssetMigration({
          getDoc() {
            throw new Error('Non-admin review must not read the map.');
          },
          setDoc() {},
          isWritable: () => true,
          checkpoint: async () => {},
          reload() {},
        });
      });
      assert.equal(await page.getByRole('dialog', { name: 'Review asset references' }).count(), 0);
    }
  }
  // Install the same original bank and an old mountain in IndexedDB, then remove every server API.
  const localId = await page.evaluate(
    async ({ entries, document }) => {
      const cacheUrl = '/src/app/public/iso-cache.ts',
        projectsUrl = '/src/app/state/local-projects.ts';
      const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = await import(/* @vite-ignore */ cacheUrl);
      const { openLocalProjects } = await import(/* @vite-ignore */ projectsUrl);
      const db = await openIsoCache(),
        course = 'TRICKY_GARI';
      await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        for (const [path, bytes] of entries)
          store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob: new Blob([new Uint8Array(bytes)]) });
      });
      await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({ course, files: entries.length, version: isoCourseCacheVersion(course) }),
      );
      db.close();
      const projects = await openLocalProjects();
      const saved = await projects.seed({ ...JSON.parse(document), name: 'LOCAL_AUTO_ASSETS' });
      projects.close();
      return saved.project.id;
    },
    {
      entries: Object.keys(files).map(path => [path, Array.from(readFileSync(join(bank, path)))] as [string, number[]]),
      document: JSON.stringify(mountain),
    },
  );
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
  await page.route('**/api/**', route => route.abort());
  await page.goto(`${origin}/editor/LOCAL_AUTO_ASSETS?local=${localId}`);
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await page.waitForFunction(
    async id => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('slopesmith-local-workspace', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const row = await new Promise<any>((resolve, reject) => {
        const request = db.transaction('projects').objectStore('projects').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      const bundle = row?.bundle;
      return (
        bundle?.document.quadTex?.[0]?.startsWith('asset2:') &&
        bundle?.document.props?.[0]?.level?.startsWith('asset2:')
      );
    },
    localId,
    { timeout: 90_000 },
  );
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: 'Review asset references…', exact: true }).count(),
    0,
    'signed-out offline users have no manual migration menu',
  );
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  const reloaded = await page.evaluate(async id => {
    const url = '/src/app/state/local-projects.ts';
    const { readLocalProject } = await import(/* @vite-ignore */ url);
    return (await readLocalProject(id))?.document;
  }, localId);
  assert.equal(
    reloaded?.quadTex?.[0],
    saved.document.quadTex![0],
    'the local upgrade survives reload with no server API',
  );
  assert.equal(reloaded?.quadTex?.[1], missing);
  assert.equal(reloaded?.props?.[0].level, saved.document.props![0].level);
  assert.deepEqual(errors, [], 'automatic upgrades must not raise browser errors');
  await page.screenshot({ path: join(root, 'local-upgraded.png') });
  console.log(
    `ASSET UPGRADES BROWSER PASS: real shared/server save, local IndexedDB save and reload without APIs, exact/matching-only selection, props, and admin-only review menu. Artifacts: ${root}`,
  );
} catch (error) {
  await page.screenshot({ path: join(root, 'failed.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
