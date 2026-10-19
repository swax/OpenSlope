/** Authenticated and guest map actions use the player route without publishing or editing private data. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-map-actions-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const vite = await createServer({
  root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Browser | undefined;
let page: Page | undefined;
const watchdog = setTimeout(() => { console.error(`Map actions timed out: ${root}`); process.exit(1); }, 150_000);
try {
  const bootstrap = await fetch(`${api.url}/api/auth/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: api.adminCode, username: 'admin', password: 'map actions test password' }),
  });
  assert.equal(bootstrap.status, 201);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  async function checked(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(`${api.url}${path}`, {
      method, headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  }
  const mountain = defaultMountain();
  const privateMap = await checked('/api/projects', 'POST', { name: 'PRIVATE_RUN', document: mountain });
  const publicMap = await checked('/api/projects', 'POST', { name: 'PUBLIC_RUN', document: mountain });
  await checked(`/api/publication?kind=project&id=${publicMap.project.id}`, 'PUT', { published: true });
  const before = await checked(`/api/projects/${privateMap.project.id}`);
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(), headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const member = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await member.addCookies([{ name: 'slopesmith_session', value: cookie.split('=')[1], url: origin }]);
  page = await member.newPage();
  page.setDefaultTimeout(60_000);
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/projects') && request.method() !== 'GET')
      writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(`${origin}/maps`);
  const privateCard = page.getByRole('article', { name: 'PRIVATE RUN', exact: true });
  const play = privateCard.getByRole('link', { name: 'Play PRIVATE RUN', exact: true });
  const edit = privateCard.getByRole('link', { name: 'Edit PRIVATE RUN', exact: true });
  await play.waitFor();
  assert.equal(new URL((await play.getAttribute('href'))!).pathname, '/play/PRIVATE_RUN');
  const editUrl = new URL((await edit.getAttribute('href'))!);
  assert.equal(editUrl.pathname, '/editor/PRIVATE_RUN');
  assert.equal(editUrl.searchParams.get('project'), privateMap.project.id);
  assert.equal(await privateCard.locator('.public-primary').count(), 1);
  assert(await play.evaluate(el => el.classList.contains('public-primary')));
  assert.equal(await edit.evaluate(el => el.classList.contains('public-primary')), false);
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  }
  await privateCard.click({ position: { x: 12, y: 12 } });
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/play/PRIVATE_RUN');
  assert.equal(await page.locator('#dock-right').isVisible(), false);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Edit map', exact: true }).isVisible());
  assert.equal(await page.getByRole('button', { name: 'Inspect map', exact: true }).count(), 0);
  assert.deepEqual(writes, [], 'playing and reopening a private map never write its document');
  assert.deepEqual((await checked(`/api/projects/${privateMap.project.id}`)).document, before.document);
  assert.equal((await fetch(`${api.url}/api/public/project?id=${privateMap.project.id}`)).status, 404);
  assert.equal((await fetch(`${api.url}/api/projects/${privateMap.project.id}`)).status, 401);
  await page.getByRole('button', { name: 'Edit map', exact: true }).click();
  await page.waitForFunction(() => document.title === 'PRIVATE_RUN - Slopesmith'
    && ['saved', 'shared', 'following'].includes(document.documentElement.dataset.projectSave ?? ''));
  assert.equal(new URL(page.url()).pathname, '/editor/PRIVATE_RUN');
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'server');
  assert.deepEqual(errors, []);

  const guest = await browser.newPage();
  await guest.goto(`${origin}/play/PRIVATE_RUN`);
  await guest.getByRole('heading', { name: 'Map unavailable', exact: true }).waitFor();
  await guest.goto(`${origin}/maps`);
  assert.equal(await guest.getByRole('link', { name: 'Play PRIVATE RUN', exact: true }).count(), 0);
  const publicCard = guest.getByRole('article', { name: 'PUBLIC RUN', exact: true });
  await publicCard.getByRole('button', { name: 'Play PUBLIC RUN', exact: true }).waitFor();
  await publicCard.click({ position: { x: 12, y: 12 } });
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor();
  assert(await guest.getByRole('button', { name: 'Edit map', exact: true }).isVisible());
  assert.equal(new URL(guest.url()).pathname, '/play/PUBLIC_RUN');
  await guest.goBack();
  await publicCard.waitFor();
  assert.equal(new URL(guest.url()).pathname, '/maps', 'Back returns to the catalogue');
  console.log('MAP ACTIONS PASS: Play/Edit routing, private solo playback, permissions, mobile layout and browser Back.');
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  console.error(`Map action failure artifacts: ${root}`);
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
  clearTimeout(watchdog);
}
