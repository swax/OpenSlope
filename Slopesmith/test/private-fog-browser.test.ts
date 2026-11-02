// tier: integration
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser } from '../src/server/accounts/users';
import { createProject } from '../src/server/projects';
import { defaultMountain } from '../src/core/doc/mountain';
import { createFogVolume } from '../src/core/particles/volumes';
import { retailExtractOrigin } from '../src/core/export/origin';
import { encodePng } from '../src/server/routes/png';
import type { ProjectBundle } from '../src/core/project/transfer';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-private-fog-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const admin = await addUser({ username: 'admin', password: 'fog test password', role: 'admin', inviteHandle: 'test' });
const bank = join(root, 'Maps', 'GARI');
mkdirSync(join(bank, 'Textures', 'Particles'), { recursive: true });
const white = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
const blue = encodePng({ w: 1, h: 1, data: new Uint8Array([0, 0, 255, 255]) });
writeFileSync(join(bank, 'Textures', 'tile.png'), white);
writeFileSync(join(bank, 'Textures', 'Particles', 'fog0.png'), white);
writeFileSync(join(bank, 'Origin.json'), JSON.stringify(retailExtractOrigin('GARI')));
writeFileSync(join(bank, 'Patches.json'), JSON.stringify({ Patches: [] }));
const project = await createProject(
  { ...defaultMountain(), name: 'FOG_RUN', particleVolumes: [createFogVolume([0, 2, 0])] },
  undefined,
  false,
  admin.id,
);
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
const errors: string[] = [],
  fogRequests: string[] = [];
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  const url = new URL(request.url());
  if (url.pathname === '/api/particle-texture' && url.searchParams.get('name') === 'fog0.png')
    fogRequests.push(url.href);
});
await page.addInitScript('globalThis.__name = value => value');
await page.addInitScript(async () => {
  const moduleUrl = '/src/app/viewport/viewport.ts';
  const { Viewport } = await import(/* @vite-ignore */ moduleUrl);
  const setParticles = Viewport.prototype.setParticleVolumes;
  Viewport.prototype.setParticleVolumes = function (...args: any[]) {
    (window as any).fogViewport = this;
    return setParticles.apply(this, args);
  };
});
async function fogPixels(path = '/play/FOG_RUN') {
  await page.goto(origin + path);
  if (path.startsWith('/editor/'))
    await page.waitForFunction(() => document.documentElement.dataset.projectSave === 'saved', undefined, {
      timeout: 90_000,
    });
  else await page.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await page.waitForFunction(
    () => {
      const mesh = (window as any).fogViewport?.scene.getObjectByName('Custom ambient particle batch');
      const image = mesh?.material.uniforms.particleAtlas.value.image;
      return image && (image.naturalWidth || image.width) > 0;
    },
    undefined,
    { timeout: 90_000 },
  );
  return page.evaluate(() => {
    const mesh = (window as any).fogViewport.scene.getObjectByName('Custom ambient particle batch');
    const texture = mesh.material.uniforms.particleAtlas.value;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.drawImage(texture.image, 0, 0);
    return { missing: !!texture.userData.missingAsset, pixel: Array.from(context.getImageData(0, 0, 1, 1).data) };
  });
}
try {
  assert(
    (
      await page.request.post(`${origin}/api/auth/login`, {
        data: { username: 'admin', password: 'fog test password' },
      })
    ).ok(),
  );
  assert.deepEqual(
    await fogPixels(),
    { missing: false, pixel: [255, 255, 255, 255] },
    'private fog uses server art with no ISO loaded',
  );
  assert(fogRequests.length > 0, 'private fog requests the server sprite');
  const initialRequests = fogRequests.length;
  await page.evaluate(async png => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    const course = 'TRICKY_GARI';
    const files = {
      'Import.json': new Blob([JSON.stringify({ Game: 'ssx-tricky', Course: course })], { type: 'application/json' }),
      'Textures/Particles/fog0.png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
    };
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
      for (const [path, blob] of Object.entries(files))
        store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
    });
    await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
      store.put({ course, files: 2, version: isoCourseCacheVersion(course) }),
    );
    db.close();
  }, Array.from(blue));
  assert.deepEqual(
    await fogPixels(),
    { missing: false, pixel: [255, 255, 255, 255] },
    'private fog keeps the server source when a different local sprite exists',
  );
  assert(fogRequests.length > initialRequests);
  assert(fogRequests.every(url => new URL(url).searchParams.get('mapSource') !== 'local'));
  const privateRequests = fogRequests.length;
  assert(
    (
      await page.request.put(`${origin}/api/publication?kind=project&id=${project.project.id}`, {
        data: { published: true },
      })
    ).ok(),
  );
  assert.deepEqual(
    await fogPixels(),
    { missing: false, pixel: [0, 0, 255, 255] },
    'public fog uses the loaded ISO sprite',
  );
  assert.equal(fogRequests.length, privateRequests, 'public fog never requests server game art');
  const localEditorPath = await page.evaluate(async () => {
    const projectsUrl = '/src/app/state/local-projects.ts';
    const mountainUrl = '/src/core/doc/mountain.ts';
    const particlesUrl = '/src/core/particles/volumes.ts';
    const { openLocalProjects } = await import(/* @vite-ignore */ projectsUrl);
    const { defaultMountain } = await import(/* @vite-ignore */ mountainUrl);
    const { createFogVolume } = await import(/* @vite-ignore */ particlesUrl);
    const document = defaultMountain();
    document.name = 'LOCAL_FOG';
    document.particleVolumes = [createFogVolume([0, 2, 0])];
    const projects = await openLocalProjects();
    const saved = await projects.seed(document);
    return `/editor/LOCAL_FOG?local=${saved.project.id}`;
  });
  assert.deepEqual(
    await fogPixels(localEditorPath),
    { missing: false, pixel: [0, 0, 255, 255] },
    'a signed-in member editing a local mountain resolves fog from the local ISO cache',
  );
  await page.evaluate(async png => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    const course = 'TRICKY_GARI';
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
      store.delete(`${course}/textures/particles/fog0.png`);
      store.put({
        key: `${course}/textures/tile.png`,
        course,
        path: 'Textures/tile.png',
        blob: new Blob([new Uint8Array(png)], { type: 'image/png' }),
      });
    });
    db.close();
  }, Array.from(blue));
  assert.deepEqual(
    await fogPixels(localEditorPath),
    { missing: false, pixel: [255, 255, 255, 255] },
    'an unqualified fog sprite falls back to the signed-in server when loaded local assets lack that sprite',
  );
  assert.equal(
    await page.evaluate(async () => {
      const moduleUrl = '/src/app/net/workspace.ts';
      const { workspaceFetch } = await import(/* @vite-ignore */ moduleUrl);
      return (await workspaceFetch('/api/particle-texture?name=fog0.png&mapSource=local')).status;
    }),
    404,
    'an explicitly local sprite never falls through to server art',
  );
  const signedInRequests = fogRequests.length;
  await page.context().clearCookies();
  assert.equal(
    (await fogPixels(localEditorPath)).missing,
    true,
    'signed-out local editing still requires local game assets',
  );
  assert.deepEqual(
    await page.evaluate(async () => {
      const moduleUrl = '/src/app/net/workspace.ts';
      const { workspaceFetch } = await import(/* @vite-ignore */ moduleUrl);
      return Promise.all(
        [
          '/api/particle-texture?name=fog0.png&mapSource=local',
          '/api/particle-texture?name=fog0.png&level=TRICKY_GARI',
          '/api/particle-texture?name=missing.png',
          '/api/texture?level=Custom&name=missing-fog.png',
        ].map(async path => (await workspaceFetch(path)).status),
      );
    }),
    [404, 404, 404, 404],
    'missing fog and explicitly selected textures stay unavailable without their original bytes',
  );
  await page.evaluate(async png => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
      store.put({
        key: 'TRICKY_GARI/textures/particle-fog0.png',
        course: 'TRICKY_GARI',
        path: 'Textures/particle-fog0.png',
        blob: new Blob([new Uint8Array(png)], { type: 'image/png' }),
      });
      store.put({
        key: 'TRICKY_GARI/ridingeffects.json',
        course: 'TRICKY_GARI',
        path: 'RidingEffects.json',
        blob: new Blob([
          JSON.stringify({
            Schema: 'openslope-riding-effects/v1',
            Enabled: true,
            Profile: 'native-riding-effects/v3',
            SpriteBank: { fog0: 'particle-fog0.png' },
          }),
        ]),
      });
    });
    db.close();
  }, Array.from(blue));
  assert.deepEqual(
    await fogPixels(localEditorPath),
    { missing: false, pixel: [0, 0, 255, 255] },
    'signed-out local editing resolves the original sprite through the native importer SpriteBank mapping',
  );
  const exported = await page.evaluate(async () => {
    const providerUrl = '/src/app/export/provider.ts';
    const sourceUrl = '/src/app/public/course-export-source.ts';
    const folderUrl = '/src/core/export/folder.ts';
    const mountainUrl = '/src/core/doc/mountain.ts';
    const volumesUrl = '/src/core/particles/volumes.ts';
    const { browserExportProvider } = await import(/* @vite-ignore */ providerUrl);
    const { courseExportSource } = await import(/* @vite-ignore */ sourceUrl);
    const { buildExportFolder } = await import(/* @vite-ignore */ folderUrl);
    const { blankMountain } = await import(/* @vite-ignore */ mountainUrl);
    const { createFogVolume } = await import(/* @vite-ignore */ volumesUrl);
    const document = {
      ...blankMountain('FOG_EXPORT'),
      environmentBed: null,
      particleVolumes: [createFogVolume([0, 2, 0])],
    };
    const options = { folderName: document.name, existingFile: async () => false };
    const editor = browserExportProvider(options);
    const folder = await buildExportFolder(document, editor, { lighting: false });
    const source = await courseExportSource({
      kind: 'slopesmith-project',
      schema: 1,
      name: document.name,
      revision: 0,
      takenAt: new Date().toISOString(),
      document,
      assets: [],
    });
    try {
      const library = await buildExportFolder(
        document,
        browserExportProvider({ ...options, request: source.request }),
        { lighting: false },
      );
      const sprite = (files: { path: string; bytes: Uint8Array }[]) =>
        Array.from(files.find(file => file.path === 'Textures/Particles/fog0.png')?.bytes ?? []);
      return {
        editor: sprite(folder.files),
        library: sprite(library.files),
        donor: Array.from(await editor.particleTexture('fog0.png', 'local:GARI')),
        missing: [folder.log, library.log].some(log => log.includes('WARN: shared fog0.png missing')),
      };
    } finally {
      source.dispose();
    }
  });
  assert.deepEqual(
    exported,
    { editor: Array.from(blue), library: Array.from(blue), donor: Array.from(blue), missing: false },
    'signed-out editor and library folder exports stage the exact original PNG, including legacy donor names',
  );
  await page.getByRole('button', { name: 'Props', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add fog volume', exact: true }).click();
  const localId = new URL(localEditorPath, origin).searchParams.get('local')!;
  await page.waitForFunction(
    async id => {
      const projectsUrl = '/src/app/state/local-projects.ts';
      const { readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
      const bundle = await readLocalProject(id);
      return (
        bundle?.document.particleVolumes?.length === 2 &&
        bundle.document.particleVolumes[1].texture?.startsWith('asset2:')
      );
    },
    localId,
    { timeout: 90_000 },
  );
  const sourceInfo = page.locator('.sp-effects-editor .sp-asset-source-info');
  const sourceContent = sourceInfo.locator('.sp-fog-source-details');
  assert.equal(
    await sourceInfo.evaluate(info => (info as HTMLDetailsElement).open),
    false,
    'fog source info starts collapsed',
  );
  assert.equal(await sourceContent.isVisible(), false);
  await sourceInfo.locator('summary').press('Enter');
  await sourceContent.waitFor();
  await sourceContent.locator('[data-detail="status"]').filter({ hasText: 'Ready' }).waitFor();
  assert.match(await sourceContent.locator('[data-detail="source"]').innerText(), /Cache → local → server/);
  assert.match(await sourceContent.locator('[data-detail="game"]').innerText(), /SSX Tricky/);
  assert.match(await sourceContent.locator('[data-detail="map"]').innerText(), /Garibaldi/);
  const fogReference = await sourceContent.locator('[data-detail="filepath"] .sp-fog-source-value').innerText();
  assert.match(fogReference, /^asset2:.*:texture:particle-fog0\.png:/);
  const changeFogStatus = async (state: 'ready' | 'missing') =>
    page.evaluate(
      async ({ ref, state }) => {
        const loadsUrl = '/src/app/state/asset-loads.ts';
        const pathsUrl = '/src/app/net/asset-paths.ts';
        const { reportTextureLoad } = await import(/* @vite-ignore */ loadsUrl);
        const { textureRefUrl } = await import(/* @vite-ignore */ pathsUrl);
        reportTextureLoad(textureRefUrl(ref), state);
      },
      { ref: fogReference, state },
    );
  await changeFogStatus('missing');
  await sourceContent.locator('[data-detail="status"]').filter({ hasText: 'Missing texture' }).waitFor();
  assert.equal(
    await sourceInfo.evaluate(info => (info as HTMLDetailsElement).open),
    true,
    'load-status updates preserve the expanded source disclosure',
  );
  await changeFogStatus('ready');
  await sourceContent.locator('[data-detail="status"]').filter({ hasText: 'Ready' }).waitFor();
  await sourceInfo.locator('summary').press('Space');
  assert.equal(await sourceContent.isVisible(), false, 'fog source info collapses with the keyboard');
  // Fork the exact saved snapshot we waited for, rather than rereading during background saves/recovery updates.
  const savedFog = await page.waitForFunction(
    async ({ id, texture }) => {
      const projectsUrl = '/src/app/state/local-projects.ts';
      const { readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
      const bundle: ProjectBundle | null = await readLocalProject(id);
      return bundle?.document.particleVolumes?.[1]?.texture === texture ? JSON.stringify(bundle) : null;
    },
    { id: localId, texture: fogReference },
    { timeout: 90_000 },
  );
  const pinned = await page.evaluate(
    async serialized => {
      const bundle = JSON.parse(serialized) as ProjectBundle;
      const projectsUrl = '/src/app/state/local-projects.ts';
      const versionsUrl = '/src/core/reference/asset-version.ts';
      const mountainUrl = '/src/core/doc/mountain.ts';
      const { openLocalProjects } = await import(/* @vite-ignore */ projectsUrl);
      const { parseAssetVersion } = await import(/* @vite-ignore */ versionsUrl);
      const { blankMountain } = await import(/* @vite-ignore */ mountainUrl);
      const volume = bundle.document.particleVolumes![1];
      const document = { ...blankMountain('PINNED_FOG'), particleVolumes: [volume] };
      const projects = await openLocalProjects();
      const saved = await projects.seed(document);
      projects.close();
      return {
        id: volume.texture,
        version: parseAssetVersion(volume.texture),
        originalLegacy: bundle.document.particleVolumes![0].texture,
        path: `/editor/PINNED_FOG?local=${saved.project.id}`,
      };
    },
    (await savedFog.jsonValue())!,
  );
  assert.equal(pinned.originalLegacy, undefined, 'opening a legacy map does not silently rewrite its fog references');
  assert.equal(pinned.version.kind, 'texture');
  assert.equal(pinned.version.key, 'particle-fog0.png');
  assert.equal(pinned.version.map, 'TRICKY_GARI');
  assert.equal(pinned.version.hash, await (await import('../src/core/reference/asset-hash')).sha256(blue));
  assert.deepEqual(
    await fogPixels(pinned.path),
    { missing: false, pixel: [0, 0, 255, 255] },
    'a saved asset2 fog texture reloads through the shared texture resolver',
  );
  assert.deepEqual(
    await fogPixels('/play/FOG_RUN'),
    { missing: false, pixel: [0, 0, 255, 255] },
    'public play resolves the native SpriteBank mapping without a server sprite request',
  );
  await page.evaluate(async png => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
      store.delete('TRICKY_GARI/textures/particle-fog0.png');
      store.put({
        key: 'TRICKY_GARI/textures/particles/fog0.png',
        course: 'TRICKY_GARI',
        path: 'Textures/Particles/fog0.png',
        blob: new Blob([new Uint8Array(png)], { type: 'image/png' }),
      });
    });
    db.close();
  }, Array.from(white));
  assert.equal(
    (await fogPixels(localEditorPath)).missing,
    true,
    'a missing declared sprite is not replaced by another image with a conventional fog filename',
  );
  assert.deepEqual(
    await fogPixels(pinned.path),
    { missing: false, pixel: [0, 0, 255, 255] },
    'a pinned fog texture keeps working from the shared cache after its local source is unavailable',
  );
  await page.evaluate(async () => {
    for (const name of await caches.keys()) await caches.delete(name);
  });
  assert.equal(
    (await fogPixels(pinned.path)).missing,
    true,
    'an unavailable asset2 texture is not replaced by the different conventional fog image',
  );
  await page.evaluate(async () => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    for (const name of ['courses', 'files'])
      await cacheTransaction(db, name, 'readwrite', (store: IDBObjectStore) => store.clear());
    db.close();
  });
  assert.equal((await fogPixels(localEditorPath)).missing, true, 'empty caches never produce generated fog');
  const manual = await page.evaluate(async () => {
    const projectsUrl = '/src/app/state/local-projects.ts';
    const mountainUrl = '/src/core/doc/mountain.ts';
    const { openLocalProjects } = await import(/* @vite-ignore */ projectsUrl);
    const { blankMountain } = await import(/* @vite-ignore */ mountainUrl);
    const projects = await openLocalProjects();
    const saved = await projects.seed({ ...blankMountain('CUSTOM_FOG'), environmentBed: null });
    projects.close();
    return { id: saved.project.id, path: `/editor/CUSTOM_FOG?local=${saved.project.id}` };
  });
  await page.goto(origin + manual.path);
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await page.getByRole('button', { name: 'Props', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add fog volume', exact: true }).click();
  const manualInfo = page.locator('.sp-effects-editor .sp-asset-source-info');
  await manualInfo.locator('summary').click();
  await manualInfo.locator('[data-detail="status"]').filter({ hasText: 'Missing texture' }).waitFor();
  const texturePicker = page.locator('#texture-library.sp-picking');
  await page.getByRole('button', { name: 'Choose fog texture', exact: true }).click();
  await texturePicker.waitFor();
  await texturePicker.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    await manualInfo.locator('[data-detail="status"] .sp-fog-source-value').innerText(),
    'Missing texture',
    'cancelling the fog picker preserves an unresolved sprite',
  );
  await page.getByRole('button', { name: 'Choose fog texture', exact: true }).click();
  await texturePicker.waitFor();
  const red = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 0, 128]) });
  await texturePicker
    .locator('input[type="file"]')
    .setInputFiles({ name: 'manual-fog.png', mimeType: 'image/png', buffer: red });
  await texturePicker.waitFor({ state: 'hidden' });
  await manualInfo.locator('[data-detail="filepath"]').filter({ hasText: 'Custom/manual-fog.png' }).waitFor();
  await manualInfo.locator('[data-detail="status"]').filter({ hasText: 'Ready' }).waitFor();
  assert(
    await page.getByRole('button', { name: 'Choose fog texture', exact: true }).isVisible(),
    'uploading through the picker keeps the fog inspector active',
  );
  await page.getByRole('button', { name: 'Choose fog texture', exact: true }).click();
  await texturePicker.getByRole('button', { name: 'Shared', exact: true }).click();
  await manualInfo.locator('[data-detail="status"]').filter({ hasText: 'Missing texture' }).waitFor();
  await page.getByRole('button', { name: 'Choose fog texture', exact: true }).click();
  await texturePicker.locator('[data-ref="Custom/manual-fog.png"]').click();
  await manualInfo.locator('[data-detail="filepath"]').filter({ hasText: 'Custom/manual-fog.png' }).waitFor();
  await page.waitForFunction(
    async id => {
      const projectsUrl = '/src/app/state/local-projects.ts';
      const { readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
      return (await readLocalProject(id))?.document.particleVolumes?.[0].texture === 'Custom/manual-fog.png';
    },
    manual.id,
    { timeout: 90_000 },
  );
  const customExport = await page.evaluate(async id => {
    const projectsUrl = '/src/app/state/local-projects.ts';
    const sourceUrl = '/src/app/public/course-export-source.ts';
    const providerUrl = '/src/app/export/provider.ts';
    const folderUrl = '/src/core/export/folder.ts';
    const { readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
    const { courseExportSource } = await import(/* @vite-ignore */ sourceUrl);
    const { browserExportProvider } = await import(/* @vite-ignore */ providerUrl);
    const { buildExportFolder } = await import(/* @vite-ignore */ folderUrl);
    const bundle: ProjectBundle = await readLocalProject(id);
    const asset = bundle.assets.find(asset => asset.kind === 'texture' && asset.name === 'manual-fog.png');
    if (!asset || !bundle.blobs) throw new Error('The custom fog image was not persisted.');
    const original = Array.from(atob(bundle.blobs[asset.hash]), char => char.charCodeAt(0));
    const source = await courseExportSource(bundle);
    try {
      const options = { folderName: bundle.name, existingFile: async () => false };
      const bytes = (folder: { files: { path: string; bytes: Uint8Array }[] }) =>
        Array.from(folder.files.find(file => file.path === 'Textures/Particles/fog0.png')?.bytes ?? []);
      const editor = await buildExportFolder(bundle.document, browserExportProvider(options), { lighting: false });
      const library = await buildExportFolder(
        bundle.document,
        browserExportProvider({ ...options, request: source.request }),
        { lighting: false },
      );
      return {
        original,
        editor: bytes(editor),
        library: bytes(library),
        texture: bundle.document.particleVolumes?.[0]?.texture,
      };
    } finally {
      source.dispose();
    }
  }, manual.id);
  assert.equal(customExport.texture, 'Custom/manual-fog.png');
  assert.deepEqual(
    customExport.editor,
    customExport.original,
    'editor export includes the exact stored custom fog PNG',
  );
  assert.deepEqual(
    customExport.library,
    customExport.original,
    'library export includes the exact stored custom fog PNG',
  );
  assert.deepEqual(
    await fogPixels(manual.path),
    { missing: false, pixel: [255, 0, 0, 128] },
    'a custom fog texture survives reload and renders without any ISO or server asset',
  );
  await page.evaluate(async id => {
    const projectsUrl = '/src/app/state/local-projects.ts';
    const { openLocalProjects } = await import(/* @vite-ignore */ projectsUrl);
    const projects = await openLocalProjects();
    projects.close();
    const db = await new Promise<IDBDatabase>(resolve => {
      const request = indexedDB.open('slopesmith-local-workspace', 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const read = store.get(id);
      read.onsuccess = () => {
        const row = read.result;
        row.bundle.assets = [];
        row.bundle.blobs = {};
        store.put(row);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, manual.id);
  assert.equal((await fogPixels(manual.path)).missing, true, 'a removed custom PNG remains visibly missing');
  assert.equal(
    await page.evaluate(async id => {
      const projectsUrl = '/src/app/state/local-projects.ts';
      const { readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
      return (await readLocalProject(id)).document.particleVolumes[0].texture;
    }, manual.id),
    'Custom/manual-fog.png',
    'a broken custom reference is preserved for manual repair',
  );
  assert.equal(fogRequests.length, signedInRequests, 'signed-out local maps never request server retail sprites');
  assert(
    fogRequests.every(url => new URL(url).searchParams.get('reference') === '1'),
    'fog preview and export use the legacy endpoint only to discover an asset2 identity',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(root, 'fog.png') });
  console.log(
    `FOG PASS: private server sprites with empty/populated ISO cache, public local sprite and no server retail reads. Artifacts: ${root}`,
  );
} catch (error) {
  console.error(
    'Fog resolution diagnostic:',
    await page
      .evaluate(async () => {
        try {
          const fogUrl = '/src/app/net/fog-texture.ts';
          const pathsUrl = '/src/app/net/asset-paths.ts';
          const workspaceUrl = '/src/app/net/workspace.ts';
          const { resolveFogTexture } = await import(/* @vite-ignore */ fogUrl);
          const { textureRefUrl } = await import(/* @vite-ignore */ pathsUrl);
          const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
          const texture = await resolveFogTexture();
          const response = await workspaceFetch(textureRefUrl(texture));
          return { texture, status: response.status, error: response.ok ? undefined : await response.text() };
        } catch (error) {
          return { error: String(error) };
        }
      })
      .catch(String),
  );
  await page.screenshot({ path: join(root, 'failure.png') });
  console.error('Fog test artifacts:', root);
  throw error;
} finally {
  await browser.close();
  await api.close();
  await vite.close();
}
