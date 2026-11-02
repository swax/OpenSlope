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
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
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
  await page.waitForFunction(() => {
    const mesh = (window as any).fogViewport?.scene.getObjectByName('Custom ambient particle batch');
    const image = mesh?.material.uniforms.particleAtlas.value.image;
    return image && (image.naturalWidth || image.width) > 0;
  });
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
  assert.equal(fogRequests.length, signedInRequests, 'signed-out local maps never request server retail sprites');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(root, 'fog.png') });
  console.log(
    `FOG PASS: private server sprites with empty/populated ISO cache, public local sprite and no server retail reads. Artifacts: ${root}`,
  );
} catch (error) {
  await page.screenshot({ path: join(root, 'failure.png') });
  console.error('Fog test artifacts:', root);
  throw error;
} finally {
  await browser.close();
  await api.close();
  await vite.close();
}
