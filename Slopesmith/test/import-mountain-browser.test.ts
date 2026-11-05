// tier: integration
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { blankMountain } from '../src/core/doc/mountain';
import { createMountainArchive } from '../src/app/mountain/archive';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser } from '../src/server/accounts/users';
import { startSession } from '../src/server/accounts/sessions';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-import-mountain-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
await mkdir(process.env.SLOPESMITH_MAPS_ROOT);
forgetWorkspaceConfig();
forgetAccounts();
await addUser({
  username: 'admin',
  password: 'mountain import admin password',
  role: 'admin',
  inviteHandle: 'test:admin',
});
const member = await addUser({
  username: 'editor',
  password: 'mountain import browser password',
  role: 'editor',
  inviteHandle: 'test:editor',
});
const session = await startSession(member.id);
const canvas = createCanvas(2, 2);
canvas.getContext('2d').fillRect(0, 0, 2, 2);
const pixels = canvas.toBuffer('image/png');
const hash = createHash('sha256').update(pixels).digest('hex');
const archive = createMountainArchive({
  kind: 'slopesmith-project',
  schema: 1,
  name: 'INSIDE_MANIFEST',
  revision: 4,
  takenAt: '2026-10-31T12:00:00Z',
  document: blankMountain('INSIDE_DOCUMENT'),
  assets: [{ kind: 'texture', name: 'tile.png', hash, size: pixels.length }],
  blobs: { [hash]: pixels.toString('base64') },
  missing: ['texture missing.png'],
  isoAliases: { OLD_GARI: 'TRICKY_GARI' },
});
const payload = Buffer.from(await archive.blob.arrayBuffer());
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
const errors: string[] = [];
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import mountain', exact: true });
async function loadFromFile(page: Page) {
  const trigger = page.getByRole('button', { name: 'Load map', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await trigger.click();
  await page.getByRole('button', { name: 'Import from file', exact: true }).click();
}
async function open(page: Page) {
  await page.goto(origin);
  await loadFromFile(page);
  await dialog(page).waitFor();
}
async function choose(page: Page, filename = 'FROM_FILE.slopesmith.zip') {
  await dialog(page)
    .getByLabel('Mountain file')
    .setInputFiles({ name: filename, mimeType: 'application/zip', buffer: payload });
  await dialog(page).getByRole('status').filter({ hasText: 'Archive ready.' }).waitFor();
}
async function locals(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/app/state/local-projects.ts';
    return (await import(/* @vite-ignore */ path)).listLocalProjects();
  });
}
try {
  const guest = await browser.newContext({ viewport: { width: 375, height: 900 } });
  const page = await guest.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let guestTransfers = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects/transfer') guestTransfers++;
  });
  await open(page);
  assert.equal(await dialog(page).getByLabel('Save location').locator('option[value="server"]').count(), 0);
  const submit = dialog(page).getByRole('button', { name: 'Import mountain', exact: true });
  assert(await submit.isDisabled(), 'nothing imports until a valid file and name have been chosen');
  await dialog(page)
    .getByLabel('Mountain file')
    .setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('invalid') });
  await dialog(page).getByRole('alert').filter({ hasText: /ZIP/ }).waitFor();
  assert(await submit.isDisabled());
  await choose(page);
  assert.equal(
    await dialog(page).getByLabel('Map name').inputValue(),
    'FROM_FILE',
    'filename takes precedence over names inside the archive',
  );
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await locals(page)).length, 0, 'cancelling creates no local map');
  await loadFromFile(page);
  await choose(page);
  await page.keyboard.press('Escape');
  assert.equal((await locals(page)).length, 0, 'Escape creates no local map');
  await loadFromFile(page);
  await choose(page);
  await dialog(page).getByLabel('Map name').fill('bad/name');
  assert(await submit.isDisabled());
  await dialog(page).getByLabel('Map name').fill('LOCAL_IMPORTED');
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await dialog(page).screenshot({ path: join(root, 'import-local-mobile.png') });
  await submit.click();
  await page.waitForURL('**/editor/LOCAL_IMPORTED?local=*');
  const localId = new URL(page.url()).searchParams.get('local');
  assert(localId);
  await page.getByText('Imported LOCAL_IMPORTED, with 1 missing asset.', { exact: true }).waitFor({ timeout: 90_000 });
  const localBundle = await page.evaluate(async id => {
    const path = '/src/app/state/local-projects.ts';
    return (await import(/* @vite-ignore */ path)).readLocalProject(id);
  }, localId);
  assert.equal(localBundle.document.name, 'LOCAL_IMPORTED');
  assert.equal(localBundle.assets[0].hash, hash);
  assert.equal(localBundle.blobs[hash], pixels.toString('base64'));
  assert.deepEqual(localBundle.isoAliases, { OLD_GARI: 'TRICKY_GARI' });
  assert.equal(guestTransfers, 0, 'local import never uploads the archive');
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Import mountain…', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await open(page);
  await choose(page, 'local_imported.zip');
  assert(await submit.isDisabled(), 'local duplicate names are checked without regard to case');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  const signedIn = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await signedIn.addCookies([{ name: 'slopesmith_session', value: session, url: origin }]);
  const server = await signedIn.newPage();
  server.on('pageerror', error => errors.push(error.message));
  await server.goto(origin);
  for (const width of [320, 375, 600]) {
    await server.setViewportSize({ width, height: 900 });
    assert.equal((await server.locator('.public-header').boundingBox())?.height, 48);
    const targets = await server
      .locator(
        '.public-header a.public-brand, .public-navigation > a, .public-about > summary, .public-users-toggle, .public-header > .sp-account-menu',
      )
      .evaluateAll(items =>
        items
          .map(item => item.getBoundingClientRect())
          .filter(rect => rect.width > 0)
          .map(rect => ({ left: rect.left, right: rect.right, bottom: rect.bottom })),
      );
    assert(
      targets.every(
        (rect, index) =>
          rect.left >= 0 &&
          rect.right <= width &&
          rect.bottom <= 48 &&
          (!index || rect.left >= targets[index - 1].right),
      ),
      `member header targets fit at ${width}`,
    );
  }
  await server.setViewportSize({ width: 375, height: 900 });
  await server.getByRole('button', { name: 'Account menu', exact: true }).click();
  assert.equal(await server.getByRole('button', { name: 'Open editor', exact: true }).count(), 0);
  assert.equal(await server.getByRole('button', { name: 'Exit editor', exact: true }).count(), 0);
  assert(await server.evaluate(() => document.body.scrollWidth <= innerWidth));
  await server.screenshot({ path: join(root, 'member-library-menu-mobile.png') });
  await server.keyboard.press('Escape');
  await server.setViewportSize({ width: 1280, height: 900 });
  await loadFromFile(server);
  await choose(server, 'SERVER_IMPORTED.slopesmith.zip');
  assert.equal(await dialog(server).getByLabel('Save location').inputValue(), 'local');
  await dialog(server).getByLabel('Save location').selectOption('server');
  await dialog(server).screenshot({ path: join(root, 'import-server.png') });
  let fail = true;
  await server.route('**/api/projects/transfer', route => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, json: { error: 'Temporary import failure' } });
    }
    return route.continue();
  });
  await dialog(server).getByRole('button', { name: 'Import mountain', exact: true }).click();
  await dialog(server).getByRole('alert').filter({ hasText: 'Temporary import failure' }).waitFor();
  assert.equal(await dialog(server).getByLabel('Map name').inputValue(), 'SERVER_IMPORTED');
  await dialog(server).getByRole('button', { name: 'Import mountain', exact: true }).click();
  await server.waitForURL('**/editor/SERVER_IMPORTED?project=*');
  const projectId = new URL(server.url()).searchParams.get('project');
  const snapshot = await (await server.request.get(`${origin}/api/projects/${projectId}`)).json();
  assert.equal(snapshot.project.ownerId, member.id);
  assert.equal(snapshot.document.name, 'SERVER_IMPORTED');
  const downloaded = await (
    await server.request.get(`${origin}/api/projects/${projectId}/download?assets=bytes`)
  ).json();
  const texture = downloaded.assets.find((asset: { kind: string }) => asset.kind === 'texture');
  assert(texture, 'the server keeps the imported texture in the mountain’s own library');
  const storedPixels = Buffer.from(downloaded.blobs[texture.hash], 'base64');
  assert.equal(createHash('sha256').update(storedPixels).digest('hex'), texture.hash);
  const image = await loadImage(storedPixels);
  const restored = createCanvas(image.width, image.height);
  restored.getContext('2d').drawImage(image, 0, 0);
  assert.deepEqual([image.width, image.height], [2, 2]);
  assert.deepEqual(
    restored.getContext('2d').getImageData(0, 0, 2, 2).data,
    canvas.getContext('2d').getImageData(0, 0, 2, 2).data,
    'server PNG normalization preserves the artwork',
  );
  assert.equal((await locals(server)).length, 0, 'server import creates no local copy');
  await open(server);
  await choose(server, 'SERVER_IMPORTED.zip');
  await dialog(server).getByRole('button', { name: 'Import mountain', exact: true }).click();
  await server.waitForURL('**/editor/SERVER_IMPORTED?local=*');
  assert.equal((await locals(server)).length, 1, 'signed-in users can import locally with the same server map name');
  assert.equal((await (await server.request.get(`${origin}/api/projects`)).json()).projects.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    `Mountain import: filename default, editable names, local/server ownership and asset bytes, aliases, missing feedback, validation, retry, cancellation and mobile dialog PASS. ${root}`,
  );
} catch (error) {
  let number = 0;
  for (const context of browser.contexts())
    for (const page of context.pages()) await page.screenshot({ path: join(root, `failure-${++number}.png`) });
  console.error(root, errors);
  throw error;
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
