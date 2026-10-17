import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import { encodePng } from '../src/server/routes/png';
import { readMountainArchive, createMountainArchive } from '../src/app/mountain/archive';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-local-editor-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
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
const ready = async (page: Page) => {
  await page.waitForFunction(() => document.documentElement.dataset.projectSave === 'saved', undefined, {
    timeout: 90_000,
  });
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
};
async function fileAction(page: Page, label: string) {
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}
try {
  const enrolled = await call('/api/auth/bootstrap', 'POST', {
    code: api.adminCode,
    username: 'admin',
    password: 'local editor test password',
  });
  cookie = enrolled.headers.get('set-cookie')!.split(';')[0];
  const mountain = defaultMountain();
  mountain.name = 'PUBLIC_RUN';
  mountain.quadTex = { 0: 'Custom/snow.png' };
  const created = (await (await call('/api/projects', 'POST', { document: mountain })).json()) as any;
  const id = created.project.id as string;
  mkdirSync(join(created.project.folder, 'assets', 'textures'), { recursive: true });
  writeFileSync(
    join(created.project.folder, 'assets', 'textures', 'snow.png'),
    encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }),
  );
  await call(`/api/publication?kind=project&id=${id}`, 'PUT', { published: true });
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  const requests: string[] = [],
    sockets: string[] = [],
    errors: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname.startsWith('/api/')) sockets.push(socket.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/maps`);
  const edit = page.getByRole('link', { name: 'Edit PUBLIC RUN', exact: true });
  await edit.waitFor();
  assert.equal(new URL((await edit.getAttribute('href'))!).pathname, '/editor/PUBLIC_RUN');
  await edit.click();
  await ready(page);
  await page.getByRole('button', { name: 'Home', exact: true }).waitFor();
  assert.equal(await page.getByText('Local workspace', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
  assert.equal(await page.title(), 'PUBLIC_RUN_REV_1 - Slopesmith');
  const firstCopyId = new URL(page.url()).searchParams.get('local');
  assert(firstCopyId?.startsWith('local-'));
  assert.equal(await page.locator('.sp-login-card').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Users', exact: true }).isVisible(), false);
  assert.match((await page.locator('#save-status').getAttribute('aria-label'))!, /this browser/);
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  assert(
    await page.getByRole('button', { name: 'Save to folder…', exact: true }).isDisabled(),
    'unsupported browsers offer the mountain ZIP backup',
  );
  await page.keyboard.press('Escape');
  const bootstrapReads = requests.length;
  await page.setViewportSize({ width: 320, height: 700 });
  assert(
    await page.evaluate(() => document.body.scrollWidth <= innerWidth),
    'local editing fits the page on a narrow phone',
  );
  assert(await page.getByRole('button', { name: 'Home', exact: true }).isVisible());
  await page.waitForFunction(() => {
    const home = document.querySelector('[aria-label="Home"]')?.getBoundingClientRect();
    return home && home.left >= 0 && home.right <= innerWidth;
  });
  await page.screenshot({ path: join(root, 'local-editor-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert(
    requests.every(request => request.startsWith('GET ')),
    'guest startup sends no server mutation',
  );
  assert(
    requests.every(request => /GET \/api\/(auth\/session|public\/courses|public\/project|texture)$/.test(request)),
    `guest startup requests: ${requests}`,
  );

  await fileAction(page, 'Rename mountain…');
  await page.locator('.sp-ask input').fill('LOCAL_RUN');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.waitForFunction(() => document.title === 'LOCAL_RUN - Slopesmith');
  await ready(page);
  const download = page.waitForEvent('download');
  await fileAction(page, 'Export mountain…');
  const saved = await download;
  const bundle = await readMountainArchive(new Blob([readFileSync((await saved.path())!)]));
  assert.equal(bundle.document.name, 'LOCAL_RUN');
  assert.equal(
    bundle.assets.filter(asset => asset.kind === 'texture').length,
    1,
    'the editable export keeps custom art',
  );
  assert.equal(bundle.missing?.length ?? 0, 0);
  assert(bundle.blobs?.[bundle.assets[0].hash]);

  await fileAction(page, 'Export map…');
  await page
    .locator('.sp-export-modal')
    .getByText('reading the mountain…', { exact: false })
    .waitFor({ state: 'hidden' });
  assert(!/preflight failed/.test(await page.locator('.sp-export-modal').innerText()));
  await page.locator('.sp-export-modal').getByRole('checkbox', { name: 'bake lighting', exact: true }).uncheck();
  const mapDownload = page.waitForEvent('download', { timeout: 90_000 });
  await page.locator('.sp-export-modal').getByRole('button', { name: 'Export map', exact: true }).click();
  const map = await mapDownload;
  assert.equal(map.suggestedFilename(), 'LOCAL_RUN.zip');
  assert(
    readFileSync((await map.path())!).includes(Buffer.from('Patches.json')),
    'local map export writes the portable map files',
  );

  const imported = structuredClone(bundle);
  imported.document.name = 'IMPORTED_LOCAL';
  const archive = createMountainArchive(imported);
  const chooser = page.waitForEvent('filechooser');
  await fileAction(page, 'Import mountain…');
  await (
    await chooser
  ).setFiles({
    name: 'mountain.slopesmith.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await archive.blob.arrayBuffer()),
  });
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.waitForFunction(() => document.title === 'IMPORTED_LOCAL - Slopesmith');
  await ready(page);
  assert.equal(requests.length, bootstrapReads, 'editing, saving, export and import issue no API requests');
  assert.deepEqual(sockets, [], 'guest editing opens no server session');
  assert.deepEqual(errors, []);
  const server = (await (await call(`/api/public/project?id=${id}`)).json()) as any;
  assert.equal(server.document.name, 'PUBLIC_RUN', 'the public source is unchanged');
  assert.equal(
    ((await (await call('/api/projects')).json()) as any).projects.length,
    1,
    'local import creates no server project',
  );
  await page.reload();
  await ready(page);
  assert.equal(await page.title(), 'IMPORTED_LOCAL - Slopesmith', 'reload restores the browser project');
  const importedUrl = page.url();

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/maps`);
  const localMaps = page.locator('.public-saved-maps');
  await localMaps.getByRole('link', { name: 'Edit LOCAL_RUN', exact: true }).waitFor();
  assert.equal(await localMaps.locator('[data-kind=local]').count(), 2);
  await page.locator('.public-server-maps').getByRole('heading', { name: 'PUBLIC RUN', exact: true }).waitFor();
  await localMaps.getByRole('article', { name: 'LOCAL_RUN', exact: true }).click({ position: { x: 12, y: 12 } });
  await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('local'), firstCopyId);
  assert.equal(await page.title(), 'LOCAL_RUN - Slopesmith');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await edit.click();
  await ready(page);
  assert.equal(
    await page.title(),
    'PUBLIC_RUN_REV_2 - Slopesmith',
    'renaming a prior copy preserves revision numbering',
  );
  const secondCopyId = new URL(page.url()).searchParams.get('local');
  assert.notEqual(secondCopyId, firstCopyId);
  await page.reload();
  await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('local'), secondCopyId, 'reload reopens the existing copy');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('article', { name: 'New map', exact: true }).click({ position: { x: 12, y: 12 } });
  await ready(page);
  assert.equal(await page.title(), 'MOUNTAIN01 - Slopesmith');
  const newMapId = new URL(page.url()).searchParams.get('local');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await localMaps.getByRole('link', { name: 'Edit MOUNTAIN01', exact: true }).waitFor();
  await page.getByRole('link', { name: 'New map', exact: true }).click();
  await ready(page);
  assert.equal(await page.title(), 'MOUNTAIN02 - Slopesmith');
  assert.notEqual(new URL(page.url()).searchParams.get('local'), newMapId);
  await page.screenshot({ path: join(root, 'local-editor-home.png') });

  // ISO maps need no server publication or server-side extraction to be inspected.
  await page.goto(`${origin}/maps`);
  await localMaps.getByRole('link', { name: 'Edit MOUNTAIN02', exact: true }).waitFor();
  await page.locator('.public-server-maps').getByRole('heading', { name: 'PUBLIC RUN', exact: true }).waitFor();
  const deleteCopy = localMaps.getByRole('button', { name: 'Delete PUBLIC_RUN_REV_2', exact: true });
  const confirmation = page.getByRole('alertdialog', { name: 'Delete PUBLIC_RUN_REV_2?', exact: true });
  const beforeDelete = requests.length;
  await deleteCopy.click();
  await confirmation.waitFor();
  assert.equal(
    await confirmation
      .getByRole('button', { name: 'Cancel', exact: true })
      .evaluate(button => button === document.activeElement),
    true,
  );
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await localMaps.getByRole('link', { name: 'Edit PUBLIC_RUN_REV_2', exact: true }).count(), 1);
  await deleteCopy.click();
  await confirmation.waitFor();
  await page.keyboard.press('Escape');
  await confirmation.waitFor({ state: 'hidden' });
  assert.equal(await deleteCopy.count(), 1, 'Escape cancels deletion');
  await page.evaluate(async id => {
    const moduleUrl = '/src/app/state/local-projects.ts';
    const workspace = await (await import(/* @vite-ignore */ moduleUrl)).openLocalProjects();
    const bundle = await (await workspace.request(new URL(`/api/projects/${id}/download`, location.origin)))!.json();
    const project = workspace.list().find((project: { id: string }) => project.id === id);
    Object.assign(window, { localDeleteProbe: { workspace, document: bundle.document, revision: project.revision } });
  }, secondCopyId);
  await deleteCopy.click();
  await confirmation.waitFor();
  await page.screenshot({ path: join(root, 'local-map-delete-confirmation.png') });
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
  await deleteCopy.waitFor({ state: 'hidden' });
  assert.equal(await localMaps.locator('[data-kind=local]').count(), 4);
  assert.equal(await localMaps.getByRole('link', { name: 'Edit LOCAL_RUN', exact: true }).count(), 1);
  const staleSave = await page.evaluate(async id => {
    const { workspace, document, revision } = (window as any).localDeleteProbe;
    const response = await workspace.request(new URL(`/api/projects/${id}/document`, location.origin), {
      method: 'PUT',
      body: JSON.stringify({ document, baseRevision: revision }),
    });
    workspace.close();
    return { status: response.status, recovery: localStorage.getItem(`slopesmith.localRecovery:${id}`) };
  }, secondCopyId);
  assert.equal(staleSave.status, 404, 'a stale editor cannot restore a deleted local map');
  assert.equal(staleSave.recovery, null);
  assert.equal(requests.length, beforeDelete, 'local deletion sends no API requests');
  await page.reload();
  await localMaps.getByRole('link', { name: 'Edit MOUNTAIN02', exact: true }).waitFor();
  assert.equal(await localMaps.getByRole('link', { name: 'Edit PUBLIC_RUN_REV_2', exact: true }).count(), 0);
  assert.equal(await localMaps.locator('[data-kind=local]').count(), 4, 'deletion survives reload');
  assert.equal(((await (await call('/api/projects')).json()) as any).projects.length, 1, 'server maps are unaffected');
  await page.screenshot({ path: join(root, 'local-map-catalogue.png'), fullPage: true });
  await page.evaluate(async () => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { openIsoCache, cacheTransaction, ISO_CACHE_VERSION } = await import(/* @vite-ignore */ moduleUrl);
    const db = await openIsoCache();
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) =>
      store.put({
        key: 'GARI/patches.json',
        course: 'GARI',
        path: 'patches.json',
        blob: new Blob([
          JSON.stringify({
            Patches: [
              {
                SurfaceType: 1,
                Points: Array.from({ length: 16 }, (_, i) => [
                  (i % 4) * 1000,
                  Math.floor(i / 4) * 1000,
                  -Math.floor(i / 4) * 300,
                ]),
              },
            ],
          }),
        ]),
      }),
    );
    await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
      store.put({ course: 'GARI', version: ISO_CACHE_VERSION, files: 1 }),
    );
    db.close();
  });
  await page.reload();
  await page.getByRole('link', { name: 'Inspect Garibaldi', exact: true }).click();
  await ready(page);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await page
    .locator('#dock-right select')
    .filter({ has: page.locator('option').filter({ hasText: /^GARI$/ }) })
    .waitFor();
  const referenceSelect = page
    .locator('#dock-right select')
    .filter({ has: page.locator('option').filter({ hasText: /^GARI$/ }) })
    .first();
  assert.equal(await referenceSelect.locator('option:checked').textContent(), 'GARI');
  assert.deepEqual(await referenceSelect.locator('option').allTextContents(), ['(none)', 'GARI']);
  const referenceDownload = page.waitForEvent('download');
  await fileAction(page, 'Export mountain…');
  const referenceBundle = await readMountainArchive(
    new Blob([readFileSync((await (await referenceDownload).path())!)]),
  );
  assert.equal(referenceBundle.document.quads.length, 0, 'Inspect leaves an empty authored workspace');
  await page.screenshot({ path: join(root, 'local-inspect.png') });
  assert.deepEqual(errors, []);
  await page.goto(`${importedUrl}&reference=GARI`);
  await ready(page);
  assert.equal(
    await page.title(),
    'IMPORTED_LOCAL - Slopesmith',
    'a named local mountain can reopen beside the selected reference',
  );
  await context.addCookies([{ name: 'slopesmith_session', value: cookie.split('=')[1], url: origin }]);
  await page.goto(`${origin}/maps`);
  await localMaps.getByRole('link', { name: 'Edit IMPORTED_LOCAL', exact: true }).click();
  await ready(page);
  assert.equal(await page.title(), 'IMPORTED_LOCAL - Slopesmith');
  const accountMenu = page.getByRole('button', { name: 'Account menu', exact: true });
  await accountMenu.waitFor();
  assert.match(await accountMenu.innerText(), /admin/);
  assert.equal(await page.getByRole('button', { name: 'Home', exact: true }).count(), 0);
  assert.equal(await page.locator('.sp-settings-btn').count(), 0, 'signed-in editors retain the account dropdown');
  await accountMenu.click();
  await page.getByRole('button', { name: 'My profile', exact: true }).click();
  const profile = page.locator('.sp-user-profile');
  await profile.getByRole('heading', { name: 'admin', exact: true }).waitFor();
  await profile.getByRole('button', { name: 'Close', exact: true }).click();
  await accountMenu.click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  await settings.locator('#sp-settings-profile-bio').fill('A member editing a local mountain.');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Bio saved.', { exact: false }).waitFor();
  assert.equal(
    ((await (await call('/api/auth/session')).json()) as any).user.bio,
    'A member editing a local mountain.',
  );
  await settings.getByRole('button', { name: 'Close', exact: true }).click();
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  await accountMenu.click();
  await page.screenshot({ path: join(root, 'signed-in-local-account.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 700 });
  assert(await accountMenu.isVisible());
  await page.waitForFunction(() => {
    const account = document.querySelector('[aria-label="Account menu"]')?.getBoundingClientRect();
    return account && account.left >= 0 && account.right <= innerWidth;
  });
  await accountMenu.click();
  await page.screenshot({ path: join(root, 'signed-in-local-account-mobile.png') });
  await page.getByRole('button', { name: 'Exit editor', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.public-server-maps').getByRole('heading', { name: 'PUBLIC RUN', exact: true }).waitFor();
  const memberDeleteRequests = requests.length;
  const memberDelete = localMaps.getByRole('button', { name: 'Delete MOUNTAIN02', exact: true });
  await memberDelete.click();
  await page
    .getByRole('alertdialog', { name: 'Delete MOUNTAIN02?', exact: true })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await memberDelete.waitFor({ state: 'hidden' });
  assert.equal(requests.length, memberDeleteRequests, 'signed-in local deletion sends no API requests');
  assert.equal(
    ((await (await call('/api/projects')).json()) as any).projects.length,
    1,
    'a signed-in member opening a local tile still writes only to browser storage',
  );
  await page.goto(`${origin}/editor?reference=GARI`);
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.equal(
    await referenceSelect.locator('option:checked').textContent(),
    'GARI',
    'members can inspect device-local ISO maps without a server extraction',
  );
  assert.equal(await page.getByText('Local workspace', { exact: true }).count(), 0);
  assert.equal(
    ((await (await call('/api/projects')).json()) as any).projects.length,
    1,
    'member inspection leaves the authored workspace empty without creating a server project',
  );
  await page.goto(importedUrl);
  await ready(page);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.locator('.sp-login-card').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('signin'), '1', 'explicit sign-out returns to the account form');
  const signedOut = await context.request.get(`${origin}/api/auth/session`);
  assert(!('user' in (await signedOut.json())), 'sign-out revokes the server session even from a local workspace');
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    `LOCAL EDITOR PASS: revision copies, local catalogue/new/rename/reopen/delete, delete confirmation/cancel, import/export, ISO inspection, signed-in local account menu/profile/settings/logout and no server map writes. Screenshots: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') });
  console.error('Local editor artifacts:', root);
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
