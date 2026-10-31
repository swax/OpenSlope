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
import { discCourseName } from '../src/core/reference/disc-courses';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-local-editor-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
const serverReference = join(root, 'Maps', 'SERVER_REFERENCE');
mkdirSync(join(serverReference, 'Textures'), { recursive: true });
writeFileSync(
  join(serverReference, 'Patches.json'),
  JSON.stringify({
    Patches: [
      {
        SurfaceType: 1,
        TexturePath: '0000.png',
        Points: Array.from({ length: 16 }, (_, i) => [
          (i % 4) * 1000,
          Math.floor(i / 4) * 1000,
          -Math.floor(i / 4) * 300,
        ]),
      },
    ],
  }),
);
writeFileSync(
  join(serverReference, 'Textures', '0000.png'),
  encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }),
);
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
  await page.waitForFunction(
    () => ['saved', 'shared', 'following'].includes(document.documentElement.dataset.projectSave ?? ''),
    undefined,
    { timeout: 90_000 },
  );
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
};
async function fileAction(page: Page, label: string) {
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  await page.getByRole('button', { name: label, exact: true }).click();
}
async function chooseReference(page: Page, level: string) {
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  const source = page.getByRole('combobox', { name: 'Reference source', exact: true });
  if (await source.isVisible()) await source.selectOption(level === 'GARI' ? 'local' : 'server');
  await page
    .getByRole('combobox', { name: 'Reference game', exact: true })
    .selectOption(level === 'GARI' ? 'ssx-tricky' : 'unknown');
  const picker = page.getByRole('combobox', { name: 'Reference map', exact: true });
  await picker.selectOption({ label: '(none)' });
  await picker.selectOption({ label: discCourseName(level) });
  await page.getByRole('button', { name: 'Load reference', exact: true }).click();
  await page.waitForFunction(
    async expected => {
      const storageUrl = '/src/app/state/storage.ts';
      const { REF_KEY } = await import(/* @vite-ignore */ storageUrl);
      return JSON.parse(localStorage.getItem(REF_KEY) ?? 'null')?.level === expected;
    },
    await picker.inputValue(),
  );
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
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
  const starterContext = await browser.newContext();
  const starter = await starterContext.newPage();
  await starter.goto(origin);
  await starter.getByRole('navigation', { name: 'Primary' }).waitFor();
  assert.equal(new URL(starter.url()).pathname, '/', 'signed-out root visits open the map catalogue');
  await starter.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Editor', exact: true }).click();
  await ready(starter);
  assert.equal(
    await starter.title(),
    'MOUNTAIN01 - Slopesmith',
    'Editor opens the default course when no map is current',
  );
  assert(new URL(starter.url()).searchParams.get('local')?.startsWith('local-'));
  await starterContext.close();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  const requests: string[] = [],
    sockets: string[] = [],
    errors: string[] = [];
  const referenceReads: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (
      /^\/api\/(level|props|texture|lightmap|effects|lightrig|reference-music)$/.test(path) &&
      (url.searchParams.get('level') ?? url.searchParams.get('name')) === 'GARI'
    )
      referenceReads.push(request.url());
    // Site presence is independent of browser storage; it never reads or writes this mountain.
    if (request.method() === 'GET' && path === '/api/play/config') return;
    if (request.method() === 'POST' && path === '/api/public/visitor') return;
    if (path.startsWith('/api/')) requests.push(`${request.method()} ${path}`);
  });
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    // Without a Rust relay, the Maps page uses Node's anonymous public presence channel.
    if (url.pathname === '/api/public/session' && url.searchParams.get('anonymous') === '1') return;
    if (url.pathname.startsWith('/api/')) sockets.push(socket.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/maps`);
  const edit = page.getByRole('link', { name: 'Edit PUBLIC RUN', exact: true });
  await edit.waitFor();
  assert.equal(new URL((await edit.getAttribute('href'))!).pathname, '/editor/PUBLIC_RUN');
  await edit.click();
  await ready(page);
  await page.getByRole('button', { name: 'Home', exact: true }).waitFor();
  const editorBrand = page.locator('#dock-top').getByRole('link', { name: 'Slopesmith', exact: true });
  assert.equal(await editorBrand.getAttribute('href'), '/', 'the editor logo and label link to the root');
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
  assert(await editorBrand.isVisible(), 'the editor logo remains a link on narrow screens');
  await page.waitForFunction(() => {
    const home = document.querySelector('[aria-label="Home"]')?.getBoundingClientRect();
    return home && home.left >= 0 && home.right <= innerWidth;
  });
  await page.screenshot({ path: join(root, 'local-editor-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert(
    requests.every(request => request.startsWith('GET ')),
    `guest startup sends no map mutation: ${requests}`,
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
  const importedCopyId = new URL(page.url()).searchParams.get('local');
  assert(importedCopyId);
  for (const [projectId, name] of [
    [firstCopyId!, 'LOCAL_RUN'],
    [importedCopyId, 'IMPORTED_LOCAL'],
  ]) {
    await fileAction(page, 'Open mountain…');
    const openMountain = page.locator('.sp-modal').filter({ hasText: 'Open mountain' });
    assert.equal(
      await openMountain.locator('.sp-modal-note').innerText(),
      'Local mountains — saved in this browser on this device.',
    );
    const option = await openMountain
      .locator('option')
      .filter({ hasText: `${name} —` })
      .textContent();
    assert(option);
    await openMountain.getByRole('combobox', { name: 'Saved mountain', exact: true }).selectOption({ label: option });
    if (projectId === firstCopyId) await page.screenshot({ path: join(root, 'open-local-mountain.png') });
    await openMountain.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForFunction(expected => document.title === `${expected} - Slopesmith`, name);
    await ready(page);
    assert.equal(
      new URL(page.url()).searchParams.get('local'),
      projectId,
      'Open mountain follows the selected local map',
    );
  }
  assert.equal(requests.length, bootstrapReads, 'editing, saving, export and import issue no map-data API requests');
  assert.deepEqual(sockets, [], 'guest editing opens no editor or named chat session');
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

  await editorBrand.click();
  await page.waitForURL(`${origin}/`);
  const localMaps = page.locator('.public-saved-maps');
  await localMaps.getByRole('link', { name: 'Edit LOCAL_RUN', exact: true }).waitFor();
  assert.equal(await localMaps.locator('[data-kind=local]').count(), 2);
  await page.locator('.public-server-maps').getByRole('heading', { name: 'PUBLIC RUN', exact: true }).waitFor();
  await localMaps.getByRole('article', { name: 'LOCAL_RUN', exact: true }).click({ position: { x: 12, y: 12 } });
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/play/LOCAL_RUN', 'the saved map tile defaults to Play');
  assert.equal(new URL(page.url()).searchParams.get('local'), firstCopyId);
  const editorTab = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Editor', exact: true });
  assert.equal(new URL((await editorTab.getAttribute('href'))!).searchParams.get('local'), firstCopyId);
  await page.getByRole('link', { name: 'Library', exact: true }).click();
  await editorTab.waitFor();
  assert.equal(new URL((await editorTab.getAttribute('href'))!).searchParams.get('local'), firstCopyId);
  await page.goto(`${origin}/maps`);
  await editorTab.click();
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
  assert.equal(requests.length, beforeDelete, 'local deletion sends no map-data API requests');
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
  const referenceSelect = page.getByRole('combobox', { name: 'Reference map', exact: true });
  await referenceSelect.waitFor();
  assert.equal(await referenceSelect.locator('option:checked').textContent(), 'Garibaldi');
  assert.deepEqual(await referenceSelect.locator('option').allTextContents(), ['(none)', 'Garibaldi']);
  const referenceDownload = page.waitForEvent('download');
  await fileAction(page, 'Export mountain…');
  const referenceBundle = await readMountainArchive(
    new Blob([readFileSync((await (await referenceDownload).path())!)]),
  );
  assert.equal(referenceBundle.document.quads.length, 0, 'Inspect leaves an empty authored workspace');
  await page.screenshot({ path: join(root, 'local-inspect.png') });
  assert.deepEqual(errors, []);
  await page.goto(importedUrl);
  await ready(page);
  await chooseReference(page, 'GARI');
  assert.equal(
    await page.title(),
    'IMPORTED_LOCAL - Slopesmith',
    'a named local mountain can select a loaded ISO from Scene without an Inspect link',
  );
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  await context.addCookies([{ name: 'slopesmith_session', value: cookie.split('=')[1], url: origin }]);
  await page.goto(`${origin}/maps`);
  await localMaps.getByRole('link', { name: 'Edit IMPORTED_LOCAL', exact: true }).click();
  await ready(page);
  assert.equal(await page.title(), 'IMPORTED_LOCAL - Slopesmith');
  assert.deepEqual(
    await page.getByRole('combobox', { name: 'Reference source', exact: true }).locator('option').allTextContents(),
    ['Local', 'Server'],
  );
  await chooseReference(page, 'SERVER_REFERENCE');
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  assert.equal(new URL(page.url()).searchParams.get('local'), importedCopyId);
  await chooseReference(page, 'GARI');
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
  assert.equal(
    requests.length,
    memberDeleteRequests,
    `signed-in local deletion sends no map-data API requests: ${requests.slice(memberDeleteRequests).join(', ')}`,
  );
  assert.equal(
    ((await (await call('/api/projects')).json()) as any).projects.length,
    1,
    'a signed-in member opening a local tile still writes only to browser storage',
  );
  await page.goto(`${origin}/editor?reference=GARI`);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  await referenceSelect
    .locator('option:checked')
    .filter({ hasText: /^Garibaldi$/ })
    .waitFor({ state: 'attached' });
  await page.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  assert.equal(await page.locator('#save-status').getAttribute('data-state'), 'idle');
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'none');
  await page.locator('#save-status').click();
  const referenceSaveDetails = page.getByRole('region', { name: 'Save location' });
  assert.match(await referenceSaveDetails.innerText(), /Viewing reference mountain/);
  assert.doesNotMatch(
    await referenceSaveDetails.innerText(),
    /Saving to server|Opening mountain|No completed save yet/,
  );
  await page.keyboard.press('Escape');
  await page.goto(`${origin}/editor/PUBLIC_RUN?project=${id}`);
  await ready(page);
  await page.getByRole('button', { name: 'Scene', exact: true }).click();
  assert.deepEqual(
    await page.getByRole('combobox', { name: 'Reference source', exact: true }).locator('option').allTextContents(),
    ['Local', 'Server'],
  );
  await chooseReference(page, 'SERVER_REFERENCE');
  const serverTexture = await page.evaluate(async () => {
    const moduleUrl = '/src/app/net/asset-paths.ts';
    const { textureUrl } = await import(/* @vite-ignore */ moduleUrl);
    return textureUrl('SERVER_REFERENCE', '0000.png');
  });
  assert(serverTexture.startsWith('/api/texture?'), 'ISO references do not intercept server reference textures');
  await chooseReference(page, 'GARI');
  assert.equal(
    await referenceSelect.locator('option:checked').textContent(),
    'Garibaldi',
    'members can choose device-local ISO references while editing a server mountain',
  );
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'server');
  assert.equal(await page.title(), 'PUBLIC_RUN - Slopesmith');
  assert.deepEqual(referenceReads, [], 'reference terrain and art from a loaded ISO never request server map bytes');
  await page.screenshot({ path: join(root, 'server-editor-local-iso-reference.png') });
  assert.equal(await page.getByText('Local workspace', { exact: true }).count(), 0);
  await fileAction(page, 'Open mountain…');
  const serverMountains = page.locator('.sp-modal').filter({ hasText: 'Open mountain' });
  assert.equal(
    await serverMountains.locator('.sp-modal-note').innerText(),
    `Server mountains — saved on ${new URL(origin).host}.`,
  );
  await serverMountains
    .getByRole('combobox', { name: 'Mountain source', exact: true })
    .selectOption({ label: 'Local' });
  const localOption = await serverMountains.locator('option').filter({ hasText: 'IMPORTED_LOCAL —' }).textContent();
  assert(localOption, 'the server editor lists browser mountains for signed-in members');
  assert.equal(await page.title(), 'PUBLIC_RUN - Slopesmith', 'changing the source does not open a mountain');
  await serverMountains
    .getByRole('combobox', { name: 'Saved mountain', exact: true })
    .selectOption({ label: localOption });
  assert.equal(
    await serverMountains.locator('.sp-modal-note').innerText(),
    'Local mountains — saved in this browser on this device.',
    'the location follows the selected mountain',
  );
  await page.screenshot({ path: join(root, 'open-server-mountain.png') });
  await serverMountains.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('local') === importedCopyId);
  await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('local'), importedCopyId);
  assert.equal(await page.title(), 'IMPORTED_LOCAL - Slopesmith');
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  await fileAction(page, 'Open mountain…');
  const localMountains = page.locator('.sp-modal').filter({ hasText: 'Open mountain' });
  await localMountains
    .getByRole('combobox', { name: 'Mountain source', exact: true })
    .selectOption({ label: 'Server' });
  const serverOption = await localMountains.locator('option').filter({ hasText: 'PUBLIC_RUN —' }).textContent();
  assert(serverOption, 'the signed-in local editor also lists server mountains');
  await localMountains
    .getByRole('combobox', { name: 'Saved mountain', exact: true })
    .selectOption({ label: serverOption });
  assert.equal(
    await localMountains.locator('.sp-modal-note').innerText(),
    `Server mountains — saved on ${new URL(origin).host}.`,
  );
  await localMountains.getByRole('button', { name: 'Open', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('project') === id && !url.searchParams.has('local'));
  await ready(page);
  assert.equal(new URL(page.url()).searchParams.get('project'), id);
  assert.equal(new URL(page.url()).searchParams.has('local'), false);
  assert.equal(await page.title(), 'PUBLIC_RUN - Slopesmith');
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'server');
  await editorBrand.click();
  await page.waitForURL(`${origin}/`);
  await page.getByRole('navigation', { name: 'Primary' }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/', 'the signed-in editor logo resolves the root to Maps');
  await page.locator('.public-server-maps').getByRole('heading', { name: 'PUBLIC RUN', exact: true }).waitFor();
  const rootCatalogue = page.waitForResponse(response => new URL(response.url()).pathname === '/api/public/courses');
  await page.locator('.public-brand').click();
  await rootCatalogue;
  await page.waitForURL(`${origin}/`);
  await page.locator('.public-server-maps').getByRole('heading', { name: 'PUBLIC RUN', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/', 'the signed-in public logo resolves the root to Maps');
  assert.equal(
    ((await (await call('/api/projects')).json()) as any).projects.length,
    1,
    'switching between browser and server mountains does not create a server project',
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
    `LOCAL EDITOR PASS: revision copies, local catalogue/new/rename/reopen/delete, delete confirmation/cancel, import/export, ISO inspection, signed-in local/server switching, logo routing, local account menu/profile/settings/logout and no server map writes. Screenshots: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') });
  console.error('Local editor artifacts:', root);
  console.error(await page?.locator('#toast, #log-text').allTextContents());
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
