// browser: smoke
// tier: integration
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser } from '../src/server/accounts/users';
import { startSession } from '../src/server/accounts/sessions';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-new-map-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
await mkdir(process.env.SLOPESMITH_MAPS_ROOT);
forgetWorkspaceConfig();
forgetAccounts();
await addUser({ username: 'admin', password: 'new map browser password', role: 'admin', inviteHandle: 'test:admin' });
const editor = await addUser({
  username: 'editor',
  password: 'new map browser password',
  role: 'editor',
  inviteHandle: 'test:editor',
});
const session = await startSession(editor.id);
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
const dialog = (page: Page) => page.getByRole('dialog', { name: 'New map', exact: true });
async function open(page: Page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await dialog(page).waitFor();
}
async function locals(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/app/state/local-projects.ts';
    return (await import(/* @vite-ignore */ path)).listLocalProjects();
  });
}
async function localDocument(page: Page) {
  const id = new URL(page.url()).searchParams.get('local');
  return page.evaluate(async id => {
    const path = '/src/app/state/local-projects.ts';
    return (await (await import(/* @vite-ignore */ path)).readLocalProject(id))?.document;
  }, id);
}
try {
  const guest = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const page = await guest.newPage();
  page.on('pageerror', error => errors.push(error.message));
  let guestWrites = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/projects') guestWrites++;
  });
  await open(page);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'hidden' });
  assert.equal((await locals(page)).length, 0, 'native Escape dismisses without creating a map');
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await dialog(page).getByLabel('Map name').fill('HOME_LOCAL');
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await dialog(page).screenshot({ path: join(root, 'new-map-local.png') });
  await dialog(page).getByLabel('Map name').press('Enter');
  await page.waitForURL('**/editor/HOME_LOCAL?local=*');
  const localId = new URL(page.url()).searchParams.get('local');
  assert(localId?.startsWith('local-'));
  assert.equal(guestWrites, 0, 'local creation sends no server create request');
  await page.reload();
  await page.getByRole('button', { name: 'File menu', exact: true }).waitFor();
  const localBlank = await localDocument(page);
  assert.equal(localBlank.spacing, 30);
  assert.equal(localBlank.vertices.length, 0);
  assert.equal(localBlank.quads.length, 0);
  assert.equal((await locals(page)).find((project: { id: string }) => project.id === localId)?.name, 'HOME_LOCAL');
  await page.getByRole('button', { name: 'File menu', exact: true }).click();
  for (const name of ['New mountain…', 'Open mountain…', 'Import mountain…'])
    assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
  assert(await page.getByRole('button', { name: 'Export…', exact: true }).isVisible());
  const library = page.locator('.sp-menu-pop').getByRole('button').first();
  assert.equal(await library.innerText(), 'Library');
  await library.click();
  await page.waitForURL(origin + '/');
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await dialog(page).getByLabel('Map name').fill('home_local');
  assert(await dialog(page).getByRole('button', { name: 'Create map', exact: true }).isDisabled());
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  const member = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await member.addCookies([{ name: 'slopesmith_session', value: session, url: origin }]);
  const signedIn = await member.newPage();
  signedIn.on('pageerror', error => errors.push(error.message));
  await open(signedIn);
  const form = dialog(signedIn);
  await form.getByLabel('Map name').fill('HOME_SERVER');
  await form.getByLabel('Terrain', { exact: true }).selectOption('generated');
  await form.getByLabel('Save location').selectOption('server');
  await form.getByRole('button', { name: 'Create map', exact: true }).click();
  await signedIn.waitForURL('**/editor/HOME_SERVER?project=*');
  const projectId = new URL(signedIn.url()).searchParams.get('project');
  assert(projectId);
  const snapshot = await (await signedIn.request.get(origin + '/api/projects/' + projectId)).json();
  assert.equal(snapshot.project.ownerId, editor.id, 'authenticated UI creation owns its real API project');
  assert.equal(snapshot.document.name, 'HOME_SERVER');
  assert(snapshot.document.quads.length > 0, 'generated terrain travels from the native form to storage');
  assert.equal((await locals(signedIn)).length, 0, 'server creation makes no local copy');
  assert.deepEqual(errors, []);
  console.log(
    'PASS mobile map creation, native form submission, editor navigation/reload, library return and authenticated server persistence',
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
