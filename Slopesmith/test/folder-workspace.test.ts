import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import { encodePng } from '../src/server/routes/png';
import { readMountainArchive } from '../src/app/mountain/archive';
import { MOUNTAIN_FOLDER_FILE } from '../src/app/mountain/folder';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-folder-workspace-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: { '/api': { target: api.url, ws: true } },
  },
});
let browser: Browser | undefined, page: Page | undefined;
let cookie = '';
async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function ready() {
  await page!.waitForFunction(() => document.documentElement.dataset.projectSave === 'saved', undefined, {
    timeout: 90_000,
  });
  await page!.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
}
async function fileAction(name: string) {
  await page!.getByRole('button', { name: 'File menu', exact: true }).click();
  await page!.getByRole('button', { name, exact: true }).click();
}
async function folderSaved() {
  await page!.waitForFunction(() => {
    const icon = document.querySelector<HTMLElement>('#save-status');
    return icon?.dataset.destination === 'folder' && icon.dataset.state === 'saved';
  });
}
async function rename(name: string) {
  await fileAction('Rename mountain…');
  await page!.locator('.sp-ask input').fill(name);
  await page!.getByRole('button', { name: 'Rename', exact: true }).click();
  await page!.waitForFunction(name => document.title === `${name} - Slopesmith`, name);
}
async function disk() {
  const bytes = await page!.evaluate(async filename => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    return [...new Uint8Array(await (await (await folder.getFileHandle(filename)).getFile()).arrayBuffer())];
  }, MOUNTAIN_FOLDER_FILE);
  return readMountainArchive(new Blob([new Uint8Array(bytes)]));
}
async function diskNamed(name: string) {
  const deadline = Date.now() + 20_000;
  let bundle = await disk();
  while (bundle.document.name !== name && Date.now() < deadline) {
    await setTimeout(200);
    bundle = await disk();
  }
  assert.equal(bundle.document.name, name);
  return bundle;
}
try {
  const enrolled = await call('/api/auth/bootstrap', 'POST', {
    code: api.adminCode,
    username: 'admin',
    password: 'folder workspace test password',
  });
  cookie = enrolled.headers.get('set-cookie')!.split(';')[0];
  const mountain = defaultMountain();
  mountain.name = 'FOLDER_SOURCE';
  mountain.quadTex = { 0: 'Custom/snow.png' };
  const created = (await (await call('/api/projects', 'POST', { document: mountain })).json()) as any;
  mkdirSync(join(created.project.folder, 'assets', 'textures'), { recursive: true });
  writeFileSync(
    join(created.project.folder, 'assets', 'textures', 'snow.png'),
    encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }),
  );
  await call(`/api/publication?kind=project&id=${created.project.id}`, 'PUT', { published: true });
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // A real serializable browser handle exercises IndexedDB and writable streams without an OS dialog.
  // OPFS is only the test picker stand-in; production uses the user's external directory picker.
  await page.addInitScript(`(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
        return handle;
      },
    });
    Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', {
      configurable: true,
      value: async () => (sessionStorage.getItem('folder-permission') === 'prompt' ? 'prompt' : 'granted'),
    });
    Object.defineProperty(FileSystemHandle.prototype, 'requestPermission', {
      configurable: true,
      value: async () => {
        sessionStorage.removeItem('folder-permission');
        return 'granted';
      },
    });
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const output = await create.call(this, options);
      if (sessionStorage.getItem('folder-fail') === '1')
        output.write = async () => {
          throw new Error('Simulated disk write failure');
        };
      return output;
    };
  })();`);
  const mutations: string[] = [],
    errors: string[] = [];
  page.on('request', request => {
    // Anonymous site presence is allowed; all other server mutations remain forbidden.
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/public/visitor') return;
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      mutations.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page.getByRole('link', { name: 'Edit FOLDER SOURCE', exact: true }).click();
  await ready();
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  await page.locator('#save-status').click();
  await page.getByRole('region', { name: 'Save location' }).waitFor();
  assert.match(await page.locator('.sp-save-details').innerText(), /Clearing site data removes these maps/);
  await page.getByRole('button', { name: 'Save to folder…', exact: true }).click();
  await folderSaved();
  const initial = await diskNamed('FOLDER_SOURCE_REV_1');
  assert.equal(initial.assets[0]?.name, 'snow.png');
  assert(initial.blobs?.[initial.assets[0].hash], 'the folder includes the custom texture bytes');
  await fileAction('Save to folder…');
  await page.getByText('This folder already contains a mountain.', { exact: false }).waitFor();
  assert.equal(
    (await disk()).document.name,
    initial.document.name,
    'selecting an occupied folder does not overwrite it',
  );
  await rename('FOLDER_RUN');
  await diskNamed('FOLDER_RUN');
  await folderSaved();
  await page.locator('#save-status').click();
  assert(
    await page.locator('.sp-menu-pop').evaluate(pop => pop.scrollWidth <= pop.clientWidth),
    'save details fit their popup',
  );
  await page.screenshot({ path: join(root, 'folder-saved.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 700 });
  await page.locator('#save-status').click();
  assert(
    await page
      .locator('.sp-menu-pop')
      .evaluate(pop => pop.getBoundingClientRect().right <= innerWidth && pop.scrollWidth <= pop.clientWidth),
    'folder save details fit a phone',
  );
  await page.screenshot({ path: join(root, 'folder-mobile.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.evaluate(() => sessionStorage.setItem('folder-permission', 'prompt'));
  await page.reload();
  await ready();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#save-status')?.dataset.state === 'reconnecting',
  );
  await rename('WAITING_FOR_ACCESS');
  assert.equal((await disk()).document.name, 'FOLDER_RUN', 'paused permission preserves the disk copy');
  await page.locator('#save-status').click();
  await page.getByRole('button', { name: 'Resume folder autosave', exact: true }).click();
  await diskNamed('WAITING_FOR_ACCESS');
  await folderSaved();

  await page.evaluate(() => sessionStorage.setItem('folder-fail', '1'));
  await rename('BROWSER_AHEAD');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#save-status')?.dataset.state === 'error');
  assert.equal(
    (await disk()).document.name,
    'WAITING_FOR_ACCESS',
    'a failed write keeps the last complete disk snapshot',
  );
  await page.locator('#save-status').click();
  assert.match(await page.locator('.sp-save-details').innerText(), /Simulated disk write failure/);
  await page.evaluate(() => sessionStorage.removeItem('folder-fail'));
  await page.getByRole('button', { name: 'Resume folder autosave', exact: true }).click();
  await diskNamed('BROWSER_AHEAD');
  await folderSaved();

  await page.reload();
  await ready();
  await folderSaved();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  await page.getByRole('link', { name: 'New map', exact: true }).click();
  await ready();
  assert.equal(
    await page.locator('#save-status').getAttribute('data-destination'),
    'browser',
    'folder bindings belong to one project',
  );
  assert.equal((await disk()).document.name, 'BROWSER_AHEAD');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`);

  // Remove application databases, preserving the stand-in disk directory, as external folders survive site clearing.
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    for (const name of ['slopesmith-local-workspace', 'slopesmith-mountain-folders'])
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
  });
  await page.reload();
  assert.equal(await page.getByRole('link', { name: 'Edit BROWSER_AHEAD', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Open mountain folder…', exact: true }).click();
  await page.waitForURL('**/editor/BROWSER_AHEAD?*');
  await ready();
  await folderSaved();
  const restored = await diskNamed('BROWSER_AHEAD');
  assert.equal(restored.assets[0]?.hash, initial.assets[0].hash, 'recovery retains custom assets');
  await rename('RESTORED_FROM_FOLDER');
  await diskNamed('RESTORED_FROM_FOLDER');
  await folderSaved();

  // Changing the file outside this editor must never be silently overwritten by its next autosave.
  await page.evaluate(async filename => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const output = await (await folder.getFileHandle(filename)).createWritable();
    await output.write('changed externally');
    await output.close();
  }, MOUNTAIN_FOLDER_FILE);
  await rename('KEEP_BROWSER_EDIT');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#save-status')?.dataset.state === 'error');
  await page.locator('#save-status').click();
  assert.match(await page.locator('.sp-save-details').innerText(), /changed in another editor/);
  const external = await page.evaluate(async filename => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    return (await (await folder.getFileHandle(filename)).getFile()).text();
  }, MOUNTAIN_FOLDER_FILE);
  assert.equal(external, 'changed externally');
  await page.getByRole('button', { name: 'Stop folder autosave', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#save-status')?.dataset.destination === 'browser',
  );
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  assert.deepEqual(mutations, [], 'the entire folder workspace performs no server map mutation');
  assert.deepEqual(errors, []);
  console.log(
    `FOLDER WORKSPACE PASS: autosave/assets, permission resume, atomic failure, reload, project isolation, storage recovery and external-change protection. Artifacts: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') });
  console.error('Folder workspace artifacts:', root);
  console.error(
    'Last status:',
    await page?.locator('#toast').textContent(),
    await page
      ?.locator('#save-status')
      .getAttribute('aria-label', { timeout: 1000 })
      .catch(() => null),
  );
  console.error(
    await page
      ?.locator('#load-status')
      .innerText()
      .catch(() => ''),
  );
  throw error;
} finally {
  await browser?.close();
  await api.close();
  await vite.close();
}
