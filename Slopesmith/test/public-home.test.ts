import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import { MAP_ORIGIN_SCHEMA, retailExtractOrigin } from '../src/core/export/origin';
import { addUser } from '../src/server/accounts/users';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { createFogVolume, particleVolumesToNative } from '../src/core/particles/volumes';
import { encodePng } from '../src/server/routes/png';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-public-home-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
mkdirSync(join(root, 'Maps', 'FIXTURE'), { recursive: true });
writeFileSync(join(root, 'Maps', 'FIXTURE', 'Patches.json'), JSON.stringify({ Patches: [] }));
writeFileSync(join(root, 'Maps', 'FIXTURE', 'Origin.json'), JSON.stringify(retailExtractOrigin('FIXTURE')));
mkdirSync(join(root, 'Maps', 'FIXTURE', 'Textures'), { recursive: true });
const tile = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) });
writeFileSync(join(root, 'Maps', 'FIXTURE', 'Textures', '0000.png'), tile);
mkdirSync(join(root, 'Maps', 'ORIGINAL', 'Textures'), { recursive: true });
writeFileSync(join(root, 'Maps', 'ORIGINAL', 'Patches.json'), JSON.stringify({ Patches: [] }));
writeFileSync(join(root, 'Maps', 'ORIGINAL', 'Textures', 'snow.png'), tile);
writeFileSync(
  join(root, 'Maps', 'ORIGINAL', 'Origin.json'),
  JSON.stringify({
    Schema: MAP_ORIGIN_SCHEMA,
    Origin: 'slopesmith',
    RetailData: false,
    Reasons: [],
  }),
);
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
process.env.PORT = String(api.port);
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
let browser: Browser | undefined;
let failurePage: Page | undefined;
let adminCookie = '';
async function call(path: string, method = 'GET', body?: unknown, cookie = '') {
  return fetch(`${api.url}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function checked(path: string, method = 'GET', body?: unknown, cookie = adminCookie): Promise<any> {
  const response = await call(path, method, body, cookie);
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
const usersButtonName = /^(?:Online users|Offline — users and chat)$/;
async function openCommunity(page: Page) {
  const toggle = page.getByRole('button', { name: usersButtonName });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.locator('.public-community-panel').waitFor();
  await page.waitForFunction(
    () => Math.abs(document.querySelector('.public-community-panel')!.getBoundingClientRect().right - innerWidth) < 1,
  );
}
async function closeCommunity(page: Page) {
  if ((await page.getByRole('button', { name: usersButtonName }).getAttribute('aria-expanded')) === 'true')
    await page.getByRole('link', { name: 'Hide', exact: true }).click();
}
async function joinChat(page: Page, nickname = 'Ada') {
  await openCommunity(page);
  const setup = page.locator('.public-chat-join');
  if (await setup.isHidden()) {
    await page.getByRole('tab', { name: 'Chat', exact: true }).click();
    await page.locator('.public-chat-status').filter({ hasText: 'Connected as' }).waitFor();
    return;
  }
  await setup.waitFor();
  const name = setup.getByLabel('Your rider name');
  if (await name.isVisible()) await name.fill(nickname);
  await setup.getByRole('button').click();
  await page.locator('.public-chat-status').filter({ hasText: 'Connected as' }).waitFor();
}
function primaryStyle(control: Locator) {
  return control.evaluate(el => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      color: style.color,
      font: style.font,
      padding: style.padding,
      border: style.borderRadius,
    };
  });
}
try {
  const bootstrap = await call('/api/auth/bootstrap', 'POST', {
    code: api.adminCode,
    username: 'admin',
    password: 'public home test password',
  });
  assert.equal(bootstrap.status, 201);
  adminCookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const mountain = defaultMountain();
  mountain.name = 'PUBLIC_RUN';
  const created = await checked('/api/projects', 'POST', { document: mountain });
  writeFileSync(join(created.project.folder, 'assets', 'skies', 'fixture-sky.png'), tile);
  const privateMap = await checked('/api/projects', 'POST', { name: 'PRIVATE_RUN', document: mountain });
  const id = created.project.id;
  assert.equal(
    (await checked('/api/public/courses', 'GET', undefined, '')).courses.length,
    0,
    'publication defaults to private',
  );
  await checked(`/api/publication?kind=project&id=${id}`, 'PUT', { published: true });
  await checked('/api/publication?kind=reference&id=FIXTURE', 'PUT', { published: true });
  await checked('/api/publication?kind=reference&id=ORIGINAL', 'PUT', { published: true });
  assert.equal(
    (await call('/api/texture?level=ORIGINAL&name=snow.png')).status,
    200,
    'original reference art is public',
  );
  assert.equal(
    (await call('/api/texture?level=ORIGINAL&name=FIXTURE/0000.png', 'GET', undefined, adminCookie)).status,
    200,
    'members can resolve cross-bank texture references',
  );
  assert.equal(
    (await call('/api/texture?level=ORIGINAL&name=FIXTURE/0000.png')).status,
    401,
    'a public original map cannot proxy another bank, even when its bytes are in the response cache',
  );
  const imported = defaultMountain();
  imported.effects = createEmptyEffectsDocument('FIXTURE');
  imported.effects.source = { fileName: 'fixture.ssf' };
  const importedMap = await checked('/api/projects', 'POST', { name: 'IMPORTED_EFFECTS', document: imported });
  await checked(`/api/publication?kind=project&id=${importedMap.project.id}`, 'PUT', { published: true });
  const publicImported = await checked(`/api/public/project?id=${importedMap.project.id}`, 'GET', undefined, '');
  assert.equal(
    publicImported.document.effects,
    undefined,
    'public terrain can be ridden without streaming an imported retail graph',
  );
  const borrowed = defaultMountain();
  borrowed.name = 'BORROWED_RUN';
  borrowed.quadTex = { 0: 'FIXTURE/0000.png' };
  borrowed.quadTex[1] = 'Custom/snow.png';
  borrowed.props = [{ id: 'prop:0', name: 'Disc prop', level: 'FIXTURE', model: 0, pos: [0, 0, 0], yaw: 0, scale: 1 }];
  borrowed.props.push({
    id: 'prop:1',
    name: 'Garibaldi prop',
    level: 'GARI',
    model: 0,
    pos: [2, 0, 0],
    yaw: 0,
    scale: 1,
  });
  const borrowedMap = await checked('/api/projects', 'POST', { document: borrowed });
  mkdirSync(join(borrowedMap.project.folder, 'assets', 'textures'), { recursive: true });
  writeFileSync(join(borrowedMap.project.folder, 'assets', 'textures', 'snow.png'), tile);
  await checked(`/api/publication?kind=project&id=${borrowedMap.project.id}`, 'PUT', { published: true });
  const publicBorrowed = (await checked('/api/public/courses', 'GET', undefined, '')).courses.find(
    (course: any) => course.id === borrowedMap.project.id,
  );
  assert(
    publicBorrowed.retailData && publicBorrowed.isoCourses.includes('FIXTURE'),
    'published maps declare their borrowed assets',
  );
  assert.equal((await call(`/api/public/project?id=${privateMap.project.id}`)).status, 404);
  assert.equal(
    (await call('/api/level?name=FIXTURE')).status,
    401,
    'public retail metadata does not expose retail terrain',
  );
  assert.equal(
    (await call('/api/texture?level=FIXTURE&name=0000.png')).status,
    401,
    'retail art remains authenticated',
  );
  for (const path of [
    `/api/texture?project=${id}&name=FIXTURE/0000.png`,
    `/api/texture?project=${id}&level=FIXTURE&name=0000.png`,
    `/api/props?project=${id}&level=FIXTURE`,
    `/api/props/index?project=${id}&level=FIXTURE`,
    `/api/skypano?project=${id}&level=FIXTURE`,
    `/api/skyground?project=${id}&level=FIXTURE`,
    `/api/skybox/page?project=${id}&level=FIXTURE&index=0`,
    `/api/custom-props/anything?project=${id}`,
  ])
    assert.equal(
      (await call(path)).status,
      401,
      `${path} cannot use publication to obtain retail assets or unlisted routes`,
    );
  assert.equal(
    (await call(`/api/custom-props?project=${id}`)).status,
    200,
    'published custom props are accessible without signing in',
  );
  assert.equal(
    (await call(`/api/texture?project=${borrowedMap.project.id}&level=Custom&name=snow.png`)).status,
    200,
    'published custom texture bytes are accessible without signing in',
  );
  assert.equal(
    (await call(`/api/custom-props?project=${privateMap.project.id}`)).status,
    401,
    'private map assets remain private',
  );
  await addUser({ username: 'viewer', password: 'viewer public home password', role: 'viewer', inviteHandle: 'test' });
  const viewer = await call('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer public home password' });
  const viewerCookie = viewer.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (await call(`/api/publication?kind=project&id=${id}`, 'PUT', { published: false }, viewerCookie)).status,
    403,
  );
  assert.equal((await call('/api/public/guest', 'POST', { name: '' })).status, 400);
  for (const name of ['admin', ' AdMiN ', 'ＡＤＭＩＮ', 'ad\u200bmin', 'viewer']) {
    const refused = await call('/api/public/guest', 'POST', { name });
    assert.equal(refused.status, 400, `account name ${name} cannot be used by a guest`);
    assert.match(((await refused.json()) as { error: string }).error, /belongs to an account/);
    assert.equal(refused.headers.get('set-cookie'), null, 'reserved names create no guest cookie');
  }
  const visitor = await call('/api/public/guest', 'POST', { name: 'visitor' });
  assert.equal(visitor.status, 200);
  const visitorCookie = visitor.headers.get('set-cookie')!.split(';')[0];
  await addUser({ username: 'visitor', password: 'visitor account password', role: 'viewer', inviteHandle: 'test' });
  assert.equal(
    (await checked('/api/public/courses', 'GET', undefined, visitorCookie)).guest,
    null,
    'a guest cookie stops being accepted when its nickname becomes an account',
  );
  const crossSite = await fetch(`${api.url}/api/public/guest`, {
    method: 'POST',
    headers: { origin: 'https://other.example', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'visitor' }),
  });
  assert.equal(crossSite.status, 403);
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const editorContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await editorContext.addCookies([{ name: 'slopesmith_session', value: adminCookie.split('=')[1], url: origin }]);
  const editor = await editorContext.newPage();
  failurePage = editor;
  await editor.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(value: string) {
          (window as any).copiedPublicLink = value;
        },
      },
    });
  });
  await editor.goto(`${origin}/editor/PUBLIC_RUN?agent=1`);
  await editor.waitForFunction(
    () => document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 90_000 },
  );
  assert.equal(
    new URL(editor.url()).pathname,
    '/editor/PUBLIC_RUN',
    'direct editor routes open the requested mountain',
  );
  assert.equal(new URL(editor.url()).searchParams.get('agent'), '1', 'editor URL updates preserve query options');
  await editor.getByRole('button', { name: 'File menu', exact: true }).click();
  assert.equal(
    await editor.getByRole('button', { name: /Public (courses|reference maps)…/ }).count(),
    0,
    'reference-map publication is hidden from the File menu',
  );
  await editor.keyboard.press('Escape');
  await editor.getByRole('button', { name: 'File menu', exact: true }).focus();
  await editor.evaluate(async () => {
    const moduleUrl = '/src/app/ui/chrome/public-courses-dialog.ts';
    const { openPublicReferenceMapsDialog } = await import(/* @vite-ignore */ moduleUrl);
    await openPublicReferenceMapsDialog();
  });
  const publication = editor.getByRole('dialog', { name: 'Public reference maps', exact: true });
  const publishReference = publication.getByRole('switch', { name: 'Share ORIGINAL publicly', exact: true });
  await publishReference.waitFor();
  assert(await publishReference.isChecked());
  assert.equal(await publication.getByRole('region', { name: 'Current mountain', exact: true }).count(), 0);
  assert.equal(
    await publication.getByRole('switch', { name: 'Share PUBLIC_RUN publicly', exact: true }).count(),
    0,
    'authored-map sharing stays in Users',
  );
  assert(
    await publication.evaluate(el => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'),
    'sharing controls have an opaque panel background',
  );
  assert.equal(
    await publication.getByRole('region', { name: 'Reference maps', exact: true }).getByRole('switch').count(),
    2,
  );
  await editor.screenshot({ path: join(root, 'public-courses-desktop.png') });
  await publishReference.focus();
  await editor.keyboard.press('Space');
  await publication.getByRole('status').filter({ hasText: 'ORIGINAL is private.' }).waitFor();
  assert.equal(
    (await checked('/api/public/courses', 'GET', undefined, '')).courses.some(
      (course: any) => course.id === 'ORIGINAL',
    ),
    false,
  );
  await publishReference.check();
  await publication.getByRole('status').filter({ hasText: 'ORIGINAL is public.' }).waitFor();
  const failedPublication = '**/api/publication?kind=reference*';
  await editor.route(failedPublication, route =>
    route.fulfill({ status: 503, json: { error: 'Sharing is temporarily unavailable.' } }),
  );
  await publishReference.uncheck();
  await publication.getByRole('status').filter({ hasText: 'Sharing is temporarily unavailable.' }).waitFor();
  assert(await publishReference.isChecked(), 'failed sharing changes restore the saved switch state');
  await editor.unroute(failedPublication);
  await publishReference.uncheck();
  await publication.getByRole('status').filter({ hasText: 'ORIGINAL is private.' }).waitFor();
  await publishReference.check();
  await publication.getByRole('status').filter({ hasText: 'ORIGINAL is public.' }).waitFor();
  await editor.setViewportSize({ width: 375, height: 700 });
  assert(
    await publication.evaluate(
      el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth,
    ),
    'sharing fits a phone without horizontal scrolling',
  );
  await editor.screenshot({ path: join(root, 'public-courses-mobile.png') });
  await editor.setViewportSize({ width: 375, height: 420 });
  assert(
    await publication.getByRole('button', { name: 'Done', exact: true }).evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    }),
    'Done stays reachable while the map list scrolls',
  );
  await publication.getByRole('button', { name: 'Done', exact: true }).focus();
  await editor.keyboard.press('Tab');
  assert(
    await publication.getByRole('button', { name: 'Close', exact: true }).evaluate(el => el === document.activeElement),
    'keyboard focus stays inside the sharing dialog',
  );
  await editor.keyboard.press('Escape');
  await publication.waitFor({ state: 'hidden' });
  assert(
    await editor.getByRole('button', { name: 'File menu', exact: true }).evaluate(el => el === document.activeElement),
    'closing restores focus to File',
  );
  await editor.setViewportSize({ width: 1440, height: 1000 });
  await editor.getByRole('button', { name: 'Users', exact: true }).click();
  const jukebox = editor.locator('#dock-right .lil-title').filter({ hasText: /^Jukebox/ });
  await jukebox.waitFor();
  assert.match(await jukebox.innerText(), /Off/, 'fresh browser playback is off');
  assert.equal(await jukebox.getAttribute('aria-expanded'), 'false', 'Jukebox is collapsed and off in a fresh browser');
  await editor
    .locator('#dock-right .lil-title')
    .filter({ hasText: /^Map permissions/ })
    .click();
  const shared = editor.getByRole('checkbox', { name: 'share publicly', exact: true });
  await shared.waitFor();
  await shared.click({ trial: true });
  assert(await shared.isChecked(), 'Map permissions reflects existing publication');
  const copyLink = editor.getByRole('button', { name: 'Copy public link', exact: true });
  await copyLink.click();
  const publicLink = await editor.evaluate(() => (window as any).copiedPublicLink as string);
  assert.equal(publicLink, `${origin}/play/PUBLIC_RUN`, 'the copied guest link uses the map name and public player');
  assert(!publicLink.includes(id), 'public links contain no map guid');
  assert(await shared.isChecked(), 'copying the link does not toggle publication');
  await Promise.all([
    editor.waitForResponse(
      response => response.url().includes('/api/publication?') && response.request().method() === 'PUT',
    ),
    shared.uncheck(),
  ]);
  assert.equal(
    (await checked('/api/public/courses', 'GET', undefined, '')).courses.some((course: any) => course.id === id),
    false,
    'unchecking public sharing removes the homepage listing',
  );
  assert(await copyLink.isDisabled(), 'private maps do not offer a public play link');
  await Promise.all([
    editor.waitForResponse(
      response => response.url().includes('/api/publication?') && response.request().method() === 'PUT',
    ),
    shared.check(),
  ]);
  assert.equal(
    (await checked('/api/public/courses', 'GET', undefined, '')).courses.some((course: any) => course.id === id),
    true,
    'checking public sharing publishes the homepage listing',
  );
  await copyLink.click({ trial: true });
  await editor.mouse.move(600, 400);
  await editor.screenshot({ path: join(root, 'map-permissions.png') });
  await editor.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText() {
          throw new Error('Clipboard unavailable');
        },
      },
    });
  });
  await copyLink.click();
  const manualLink = editor.getByRole('textbox', { name: 'Public play link', exact: true });
  await manualLink.waitFor();
  assert.equal(await manualLink.inputValue(), publicLink, 'clipboard failures offer the same link for manual copying');
  assert(await manualLink.evaluate((field: HTMLInputElement) => field.readOnly));
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await editor.getByRole('button', { name: 'Test', exact: true }).click();
  await editor
    .locator('#dock-right')
    .getByRole('button', { name: /Play PUBLIC_RUN/ })
    .click();
  const stopTest = editor.locator('#dock-right').getByRole('button', { name: '■ Stop', exact: true });
  await stopTest.waitFor();
  assert(await editor.locator('#dock-right').isVisible(), 'Test tools remain visible during an editor ride');
  assert.equal(await editor.locator('.sp-chat-docked').count(), 0, 'editor rides keep the editor chat overlay');
  assert.equal(await editor.locator('.sp-chat').evaluate(el => getComputedStyle(el).left), '10px');
  await editor.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await editor.keyboard.press('Enter');
  const testChat = editor.getByRole('textbox', { name: 'Chat message', exact: true });
  await testChat.waitFor();
  assert(await testChat.evaluate(el => el === document.activeElement), 'Enter focuses editor chat during a ride');
  assert(await stopTest.isVisible(), 'opening editor chat keeps the Test controls visible');
  await editor.screenshot({ path: join(root, 'editor-test-chat.png') });
  await testChat.fill('Chat from the editor Test ride');
  await testChat.press('Enter');
  await editor.getByText('Chat from the editor Test ride', { exact: true }).waitFor();
  assert(await testChat.isHidden(), 'sending returns the keyboard to the ride');
  await editor.keyboard.press('Enter');
  await testChat.waitFor();
  await testChat.press('Escape');
  assert(await testChat.isHidden());
  assert(await stopTest.isVisible(), 'closing chat leaves the editor ride running');
  await stopTest.click();
  await editor
    .locator('#dock-right')
    .getByRole('button', { name: /Play PUBLIC_RUN/ })
    .waitFor();
  const editorLogo = await editor.locator('#dock-top .sp-brand img').getAttribute('src');
  await editor.getByRole('button', { name: 'File menu', exact: true }).click();
  await editor.getByRole('button', { name: 'Exit editor', exact: true }).click();
  await editor.getByRole('heading', { name: 'Maps', level: 1 }).waitFor();
  assert.equal(new URL(editor.url()).pathname, '/maps', 'File → Exit editor returns to the canonical homepage');
  const privateMaps = editor.getByRole('region', { name: 'Private server maps', exact: true });
  await privateMaps.getByRole('heading', { name: 'PRIVATE RUN', exact: true }).waitFor();
  assert.equal(
    await privateMaps.getByRole('article').count(),
    1,
    'published mountains are not duplicated in private server maps',
  );
  assert(await privateMaps.getByText('Private', { exact: true }).isVisible());
  assert(await privateMaps.getByText('Saved on server', { exact: true }).isVisible());
  const privateEdit = privateMaps.getByRole('link', { name: 'Edit PRIVATE RUN', exact: true });
  const privateEditorUrl = new URL((await privateEdit.getAttribute('href'))!, origin);
  assert.equal(privateEditorUrl.pathname, '/editor/PRIVATE_RUN');
  assert.equal(privateEditorUrl.searchParams.get('project'), privateMap.project.id);
  assert.equal(
    new URL((await privateMaps.getByRole('link', { name: 'Play PRIVATE RUN', exact: true }).getAttribute('href'))!)
      .pathname,
    '/play/PRIVATE_RUN',
  );
  assert.equal(await privateEdit.evaluate(el => el.classList.contains('public-primary')), false);
  assert.equal(
    await editor.locator('.public-brand .sp-brand img').getAttribute('src'),
    editorLogo,
    'the homepage reuses the editor logo',
  );
  assert.equal(await editor.locator('.public-brand .sp-brand > span').innerText(), 'Slopesmith');
  const homeAccount = editor.getByRole('button', { name: 'Account menu', exact: true });
  assert.match(await homeAccount.innerText(), /admin/);
  assert(
    (await homeAccount.boundingBox())!.x > 1200,
    'the signed-in menu sits at the far right of the full-width header',
  );
  await editor.screenshot({ path: join(root, 'member-home-header.png') });
  await homeAccount.click();
  await editor.getByRole('button', { name: 'Open editor', exact: true }).click();
  await editor.waitForFunction(
    () => document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 90_000 },
  );
  assert.equal(
    new URL(editor.url()).pathname,
    '/editor/PUBLIC_RUN',
    'Open editor expands the base editor route to the active map',
  );
  await editor.getByRole('button', { name: 'Account menu', exact: true }).click();
  await editor.getByRole('button', { name: 'Exit editor', exact: true }).click();
  await editor.getByRole('heading', { name: 'Maps', level: 1 }).waitFor();
  assert.equal(new URL(editor.url()).pathname, '/maps', 'the editor profile menu provides the same exit action');
  await homeAccount.click();
  await editor.getByRole('button', { name: 'My profile', exact: true }).click();
  await editor
    .locator('.sp-user-profile')
    .getByRole('heading', { name: 'admin', exact: true })
    .waitFor({ timeout: 90_000 });
  await editor.locator('.sp-user-profile').getByRole('button', { name: 'Close', exact: true }).click();
  assert(
    !new URL(editor.url()).searchParams.has('account'),
    'account panel navigation is consumed after opening the editor',
  );
  await editor.getByRole('button', { name: 'File menu', exact: true }).click();
  await editor.getByRole('button', { name: 'Exit editor', exact: true }).click();
  await editor.getByRole('heading', { name: 'Maps', level: 1 }).waitFor();
  await homeAccount.click();
  await editor.getByRole('button', { name: 'Settings…', exact: true }).click();
  const accountSettings = editor.getByRole('dialog', { name: 'Settings', exact: true });
  await accountSettings.waitFor({ timeout: 90_000 });
  await accountSettings.getByRole('button', { name: 'Close', exact: true }).click();
  await editor.goto(`${origin}/maps`);
  await privateEdit.waitFor();
  await editor.setViewportSize({ width: 375, height: 700 });
  assert(await privateEdit.isVisible());
  assert(await editor.evaluate(() => document.body.scrollWidth <= innerWidth), 'private server map tiles fit a phone');
  await editor.screenshot({ path: join(root, 'private-server-maps-mobile.png'), fullPage: true });
  await privateMaps.getByRole('article', { name: 'PRIVATE RUN', exact: true }).click({ position: { x: 12, y: 12 } });
  await editor.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(editor.url()).pathname, '/play/PRIVATE_RUN', 'the private tile defaults to Play');
  await editor.getByRole('button', { name: 'Play', exact: true }).click();
  await editor.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  await editor.goto(`${origin}/maps`);
  await privateEdit.click();
  await editor.waitForFunction(
    () =>
      document.title === 'PRIVATE_RUN - Slopesmith' &&
      ['saved', 'shared', 'following'].includes(document.documentElement.dataset.projectSave ?? ''),
    undefined,
    { timeout: 90_000 },
  );
  await editor.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  assert.equal(
    new URL(editor.url()).searchParams.has('local'),
    false,
    'a private tile opens the existing server mountain',
  );
  assert.equal(await editor.locator('#save-status').getAttribute('data-destination'), 'server');
  assert.equal(
    (await call(`/api/public/project?id=${privateMap.project.id}`)).status,
    404,
    'opening a private map never publishes it',
  );
  await editorContext.close();

  const signInContext = await browser.newContext();
  const signIn = await signInContext.newPage();
  failurePage = signIn;
  await signIn.goto(`${origin}/editor/PUBLIC_RUN?signin=1`);
  await signIn.locator('.sp-login-card').waitFor();
  assert.equal(
    new URL(signIn.url()).pathname,
    '/editor/PUBLIC_RUN',
    'an editor link keeps its target while asking for credentials',
  );
  assert.equal(await signIn.locator('.public-home').count(), 0, 'editor routes do not boot the public player');
  await signIn.locator('input[autocomplete="username"]').fill('admin');
  await signIn.locator('input[autocomplete="current-password"]').fill('public home test password');
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await signIn.waitForFunction(
    () => document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
    undefined,
    { timeout: 90_000 },
  );
  assert.equal(new URL(signIn.url()).pathname, '/editor/PUBLIC_RUN', 'signing in resumes the requested editor map');
  await signIn.getByRole('button', { name: 'File menu', exact: true }).waitFor();
  await signInContext.close();

  const linkContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const linked = await linkContext.newPage();
  failurePage = linked;
  // Exercise a real custom panorama without changing the catalogue fixture's ISO requirements.
  await linked.route('**/api/public/project?*', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.document.skybox = { source: { kind: 'custom', name: 'fixture-sky' }, on: true };
    await route.fulfill({ response, json: snapshot });
  });
  let linkSockets = 0,
    linkGuestRequests = 0;
  linked.on('websocket', socket => {
    if (new URL(socket.url()).pathname === '/api/public/session') linkSockets++;
  });
  linked.on('request', request => {
    if (new URL(request.url()).pathname === '/api/public/guest') linkGuestRequests++;
  });
  await linked.goto(`${origin}/isos`);
  await linked.getByRole('heading', { name: 'ISO', level: 1, exact: true }).waitFor();
  assert.equal(new URL(linked.url()).pathname, '/isos', 'the ISO manager has its own route');
  assert.equal(await linked.getByRole('link', { name: 'ISO', exact: true }).getAttribute('aria-current'), 'page');
  await linked.goto(publicLink);
  await linked.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(
    await linked.locator('.sp-login-card').count(),
    0,
    'a fresh public link never asks for member credentials',
  );
  assert.equal(await linked.locator('.public-card-actions button[aria-label="Play PUBLIC RUN"]').count(), 1);
  assert.equal(
    await linked.getByRole('heading', { name: 'Choose your next run', exact: true }).count(),
    0,
    'a shared link goes directly to its map instead of showing the course picker',
  );
  const mapTab = linked
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'PUBLIC RUN', exact: true });
  assert.equal(await mapTab.getAttribute('aria-current'), 'page', 'the open map is the selected tab');
  assert.equal(await linked.getByRole('link', { name: 'Maps', exact: true }).getAttribute('aria-current'), null);
  assert(
    await linked.getByRole('link', { name: 'ISO', exact: true }).isVisible(),
    'ISO remains available in the player',
  );
  assert(await linked.locator('.sp-navgizmo').isHidden(), 'the public player hides the editor navigation gizmo');
  assert.equal(
    (await linked.locator('.public-header').boundingBox())?.height,
    40,
    'the player uses a lower profile header',
  );
  assert(
    await linked.getByRole('button', { name: usersButtonName }).isVisible(),
    'the connection indicator opens the shared panel',
  );
  assert.equal(
    await linked.locator('.public-header').getByRole('button', { name: 'Play', exact: true }).count(),
    0,
    'launch choices appear over the map instead of in the header',
  );
  const choices = linked.getByRole('group', { name: 'Play options', exact: true });
  assert(await choices.getByRole('button', { name: 'Play', exact: true }).isVisible());
  assert(await choices.getByRole('button', { name: 'Play in VR', exact: true }).isVisible());
  const exitPlay = linked.getByRole('button', { name: 'Exit play', exact: true });
  assert(await exitPlay.isHidden(), 'Exit stays hidden while previewing the map');
  const mouseControls = linked.getByRole('region', { name: 'Mouse controls', exact: true });
  assert(await mouseControls.isHidden(), 'the movement legend starts hidden');
  await linked.evaluate(async () => {
    const moduleUrl = '/src/app/viewport/viewport.ts';
    const { Viewport } = await import(/* @vite-ignore */ moduleUrl);
    const showStart = Viewport.prototype.showRideSpawn;
    Viewport.prototype.showRideSpawn = function (point: any) {
      (window as any).startTestViewport = this;
      (window as any).selectedStart = point ? [...point] : null;
      return showStart.call(this, point);
    };
    const startRide = (Viewport.prototype as any).startRide;
    (Viewport.prototype as any).startRide = function (...args: any[]) {
      (window as any).launchedStart = [...args[1]];
      return startRide.apply(this, args);
    };
  });
  await choices.getByRole('button', { name: 'View map', exact: true }).click();
  await mouseControls.waitFor();
  await linked.waitForFunction(() => (window as any).startTestViewport.sky.loaded);
  const skyVisible = () =>
    linked.evaluate(
      () => (window as any).startTestViewport.scene.children.find((node: any) => node.renderOrder === -1000).visible,
    );
  assert.equal(await skyVisible(), false, 'the loaded sky stays hidden while viewing a public map');
  assert(
    await linked.evaluate(() => {
      const viewport = (window as any).startTestViewport;
      return viewport.ownBox?.visible === false && viewport.ownBoxVisible === false && viewport.refBoxVisible === false;
    }),
    'public viewing hides both authored and reference terrain bounds',
  );
  assert.match(
    await mouseControls.innerText(),
    /Right drag.*Orbit.*Middle drag.*Pan.*Scroll.*Zoom.*Hold Alt \+ WASD.*Move/s,
  );
  assert.equal(
    await choices.getByRole('button', { name: 'View map', exact: true }).getAttribute('aria-expanded'),
    'true',
  );
  const pickStart = await linked.evaluate(() => {
    const viewport = (window as any).startTestViewport;
    const mesh = viewport.terrainLayer.terrain;
    const positions = mesh.geometry.attributes.position;
    const index = mesh.geometry.index;
    const count = index ? index.count : positions.count;
    const rect = document.querySelector('#viewport canvas')!.getBoundingClientRect();
    mesh.updateMatrixWorld(true);
    for (let i = 0; i < count; i += Math.max(3, Math.floor(count / 600) * 3)) {
      const ids = [0, 1, 2].map(offset => (index ? index.getX(i + offset) : i + offset));
      const point = viewport.camera.position.clone().set(0, 0, 0);
      for (const id of ids) {
        point.x += positions.getX(id) / 3;
        point.y += positions.getY(id) / 3;
        point.z += positions.getZ(id) / 3;
      }
      point.applyMatrix4(mesh.matrixWorld).project(viewport.camera);
      if (Math.abs(point.x) > 0.55 || point.y < -0.1 || point.y > 0.6 || Math.abs(point.z) > 1) continue;
      return { x: rect.x + ((point.x + 1) * rect.width) / 2, y: rect.y + ((1 - point.y) * rect.height) / 2 };
    }
    throw new Error('No visible terrain point found for start placement');
  });
  const resetStart = linked.getByRole('button', { name: 'Reset start', exact: true });
  assert(await resetStart.isHidden());
  await linked.mouse.click(pickStart.x, pickStart.y);
  await resetStart.waitFor();
  const customStart = await linked.evaluate(() => (window as any).selectedStart);
  assert(Array.isArray(customStart) && customStart.length === 3, 'a terrain click places a world-space start');
  await resetStart.click();
  assert(await resetStart.isHidden(), 'reset restores the default and clears the custom-start action');
  assert.notDeepEqual(await linked.evaluate(() => (window as any).selectedStart), customStart);
  await linked.mouse.click(pickStart.x, pickStart.y);
  await resetStart.waitFor();
  const launchStart = await linked.evaluate(() => (window as any).selectedStart);
  const mouseLegendBox = await mouseControls.boundingBox();
  const mapBounds = await linked.locator('#viewport').boundingBox();
  assert(
    mouseLegendBox &&
      mapBounds &&
      mouseLegendBox.x < mapBounds.x + 24 &&
      Math.abs(mouseLegendBox.y + mouseLegendBox.height - (mapBounds.y + mapBounds.height - 12)) < 1,
    'the map movement legend stays on the bottom-left edge even with a custom start',
  );
  await linked.screenshot({ path: join(root, 'view-map-controls.png') });
  assert.equal(
    await linked.locator('.public-home input[autocomplete="nickname"]').count(),
    0,
    'nickname setup lives in chat',
  );
  await linked.setViewportSize({ width: 320, height: 700 });
  assert(await linked.evaluate(() => document.body.scrollWidth <= innerWidth), 'ride setup controls fit narrow phones');
  assert.equal(
    await linked.locator('.public-in-world').evaluate(el => el.getBoundingClientRect().height),
    0,
    'the compact mobile header leaves no empty panel over the mountain',
  );
  assert(await linked.getByRole('button', { name: 'Play in VR', exact: true }).isVisible());
  const overlayBounds = await choices.boundingBox(),
    viewportBounds = await linked.locator('#viewport').boundingBox();
  assert(
    overlayBounds &&
      viewportBounds &&
      overlayBounds.x >= viewportBounds.x &&
      overlayBounds.x + overlayBounds.width <= viewportBounds.x + viewportBounds.width &&
      overlayBounds.y + overlayBounds.height <= viewportBounds.y + viewportBounds.height,
    'all three choices fit over the map on a narrow phone',
  );
  const mobileMouseLegend = await mouseControls.boundingBox();
  assert(
    mobileMouseLegend &&
      viewportBounds &&
      Math.abs(mobileMouseLegend.y + mobileMouseLegend.height - (viewportBounds.y + viewportBounds.height - 12)) < 1,
    'the mobile view legend remains anchored to the bottom of the mountain',
  );
  assert(
    mobileMouseLegend && overlayBounds && mobileMouseLegend.y >= overlayBounds.y + overlayBounds.height,
    'the launch toolbar sits above the corner legend on narrow screens without covering it',
  );
  await linked.screenshot({ path: join(root, 'map-options-mobile.png') });
  await linked.setViewportSize({ width: 1440, height: 1000 });
  await linked.getByRole('button', { name: 'Play', exact: true }).click();
  await linked.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  assert.equal(await skyVisible(), true, 'desktop play shows the course sky');
  const checkExitCorner = async () => {
    assert(await exitPlay.locator('.public-stop-label').isVisible(), 'Exit keeps its text label on every screen size');
    const button = await exitPlay.boundingBox(),
      header = await linked.locator('.public-header').boundingBox();
    assert(
      button &&
        header &&
        Math.abs(button.x + button.width - (header.x + header.width - 8)) < 1 &&
        button.y >= header.y &&
        button.y + button.height <= header.y + header.height,
      'Exit stays in the upper-right corner throughout play',
    );
  };
  await checkExitCorner();
  assert.equal(await linked.locator('[data-fs]').count(), 0, 'public rides have no fullscreen toggle');
  await linked.locator('[data-clocktime]').waitFor();
  const clockTopInset = () =>
    linked
      .locator('[data-clocktime]')
      .evaluate(
        el =>
          el.parentElement!.getBoundingClientRect().top -
          document.querySelector('#viewport')!.getBoundingClientRect().top,
      );
  assert.equal(await clockTopInset(), 8, 'the run clock and score sit directly below the public header by default');
  await linked.keyboard.press('Alt+Enter');
  assert.equal(await clockTopInset(), 8, 'editor fullscreen shortcuts cannot change the public HUD layout');
  assert.deepEqual(
    await linked.evaluate(() => (window as any).launchedStart),
    launchStart,
    'Play launches at the clicked start point',
  );
  assert(await resetStart.isHidden(), 'start placement controls stay out of the active ride');
  assert(await choices.isHidden(), 'launch overlays clear away while riding');
  assert(await mouseControls.isHidden(), 'mouse movement help clears away while riding');
  const rideControls = linked.getByRole('region', { name: 'Ride controls', exact: true });
  await rideControls.waitFor();
  const rideLegendBox = await rideControls.boundingBox();
  assert(
    rideLegendBox &&
      mapBounds &&
      rideLegendBox.x < mapBounds.x + 24 &&
      Math.abs(rideLegendBox.y + rideLegendBox.height - (mapBounds.y + mapBounds.height - 12)) < 1,
    'the ride legend stays on the bottom-left edge',
  );
  assert.match(
    await rideControls.innerText(),
    /A \/ D.*carve.*Shift.*boost.*Space.*ollie/s,
    'riding shows the shared movement, boost and jump legend',
  );
  await linked.getByRole('button', { name: 'About Slopesmith', exact: true }).click();
  await linked.getByRole('region', { name: 'About Slopesmith', exact: true }).waitFor();
  assert.equal(await linked.locator('[data-offline-status]').innerText(), 'Offline access is disabled in development');
  await linked.getByRole('button', { name: 'About Slopesmith', exact: true }).press('Escape');
  assert(
    await linked.getByRole('button', { name: 'Exit play', exact: true }).isVisible(),
    'closing About keeps the ride running',
  );
  await linked.keyboard.press('e');
  await rideControls.getByRole('heading', { name: /on foot/ }).waitFor();
  assert.match(
    await rideControls.innerText(),
    /W \/ A \/ S \/ D.*walk.*recall \+ get on board/s,
    'getting off the board switches the legend to walking controls',
  );
  await linked.keyboard.press('v');
  await rideControls.getByRole('heading', { name: /first person/ }).waitFor();
  assert.match(await rideControls.innerText(), /Mouse.*look/s, 'first-person help follows the live camera');
  await linked.keyboard.press('v');
  await rideControls.getByRole('heading', { name: /third person/ }).waitFor();
  await linked.keyboard.press('e');
  await rideControls.getByRole('heading', { name: /riding/ }).waitFor();
  assert(linkSockets > 0, 'opening a public map connects anonymous multiplayer before joining chat');
  assert.equal(linkGuestRequests, 0, 'anonymous riding does not choose a chat nickname');
  assert(
    (await linkContext.cookies()).some(cookie => cookie.name === 'slopesmith_guest'),
    'anonymous riding has an ephemeral visitor cookie',
  );
  await linked.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await linked.keyboard.press('Enter');
  assert(
    !(await linked.getByRole('textbox', { name: 'Chat message' }).isVisible()),
    'local chat shortcuts do not expose a disconnected input',
  );
  // Walking can end the scored run. Start a fresh run to check its visible mobile clock.
  await exitPlay.click();
  await choices.waitFor();
  await choices.getByRole('button', { name: 'Play', exact: true }).click();
  await exitPlay.waitFor();
  await linked.locator('[data-clocktime]').waitFor();
  await linked.setViewportSize({ width: 320, height: 700 });
  assert(
    await linked.evaluate(() => document.body.scrollWidth <= innerWidth),
    'compact player controls fit narrow phones',
  );
  assert(await linked.getByRole('button', { name: usersButtonName }).isVisible());
  assert(await mapTab.isVisible(), 'the selected map tab stays visible in the mobile header');
  await checkExitCorner();
  assert.equal(await linked.locator('[data-fs]').count(), 0, 'mobile public rides also omit fullscreen');
  assert.equal(await clockTopInset(), 8, 'mobile public rides keep the score below the header');
  assert(await linked.getByRole('link', { name: 'ISO', exact: true }).isVisible(), 'mobile play retains the ISO tab');
  await linked.waitForFunction(() => !(document.querySelector('.public-ride-controls') as HTMLDetailsElement).open);
  assert.equal(await rideControls.getAttribute('open'), null, 'narrow screens show a compact expandable ride legend');
  await rideControls.locator('summary').click();
  assert.match(await rideControls.innerText(), /carve.*ollie/s, 'the mobile legend expands to show ride bindings');
  await rideControls.locator('summary').click();
  const compactRideLegend = await rideControls.boundingBox(),
    rideStats = await linked.locator('[data-ride-stats]').boundingBox();
  assert(
    compactRideLegend && rideStats && compactRideLegend.y >= rideStats.y + rideStats.height,
    'the speed readout stays above the bottom-left legend',
  );
  const boostMeter = await linked.locator('[data-boost-meter]').boundingBox();
  assert(
    !boostMeter || (compactRideLegend && compactRideLegend.y >= boostMeter.y + boostMeter.height),
    'the boost meter also leaves the bottom-left legend clear',
  );
  await linked.screenshot({ path: join(root, 'local-player-mobile.png') });
  await linked.setViewportSize({ width: 1440, height: 1000 });
  await linked.screenshot({ path: join(root, 'public-link-riding.png') });
  await linked.getByRole('button', { name: 'Exit play', exact: true }).click();
  await choices.waitFor();
  assert.equal(await skyVisible(), false, 'leaving a ride hides the sky again');
  assert(await resetStart.isVisible(), 'a custom start can still be reset after stopping');
  assert(await mouseControls.isHidden(), 'stopping returns to the launch choices without a stale legend');
  assert(await rideControls.isHidden(), 'stopping clears the ride legend');
  assert(await exitPlay.isHidden(), 'exiting clears the Exit button with the active ride');
  // Simulate the headset session boundary: VR starts on foot, before a board/HUD exists.
  await linked.evaluate(`(() => {
    const viewport = window.startTestViewport;
    let presenting = false;
    let onExit;
    Object.defineProperty(viewport, 'xrPlaying', { get: () => presenting });
    viewport.startXrPlay = async (_target, _spawn, _heading, exit) => {
      presenting = true; onExit = exit; return true;
    };
    viewport.stopXrPlay = () => { presenting = false; onExit(); };
  })()`);
  await choices.getByRole('button', { name: 'Play in VR', exact: true }).click();
  await exitPlay.waitFor();
  assert.equal(await skyVisible(), true, 'the sky also appears during VR play');
  await checkExitCorner();
  assert(await choices.isHidden(), 'VR keeps Exit available even before mounting the board');
  await exitPlay.click();
  await choices.waitFor();
  assert.equal(await skyVisible(), false, 'leaving VR restores the map preview without its sky');
  assert(await exitPlay.isHidden(), 'Exit ends the VR session and returns to map preview');
  await linked.getByRole('link', { name: 'Maps', exact: true }).click();
  await linked.getByRole('button', { name: 'Play PUBLIC RUN', exact: true }).waitFor();
  assert.equal(new URL(linked.url()).pathname, '/maps', 'Maps returns from the selected map tab to the catalogue');
  await linked.goto(publicLink);
  await linked.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(
    new URL(linked.url()).pathname,
    '/play/PUBLIC_RUN',
    'a direct visit reopens the named public player route',
  );
  assert(
    await linked.getByRole('link', { name: 'Sign in', exact: true }).isVisible(),
    'returning guests auto-load the map without a member login',
  );
  const privateLink = new URL('/play/PRIVATE_RUN', origin);
  await linked.goto(privateLink.href);
  await linked.getByRole('heading', { name: 'Map unavailable', exact: true }).waitFor();
  assert.match(await linked.locator('.public-status').innerText(), /private or deleted/);
  assert.equal(
    await linked.getByRole('button', { name: /PRIVATE RUN/ }).count(),
    0,
    'a direct link reveals no private map',
  );
  assert.equal(await linked.getByRole('button', { name: 'Load course', includeHidden: true }).count(), 0);
  assert(
    await linked.getByRole('button', { name: 'Exit play', exact: true }).isHidden(),
    'unavailable maps do not show player controls',
  );
  await linked.setViewportSize({ width: 390, height: 844 });
  await linked.route(/\/api\/public\/project\?/, route => route.fulfill({ status: 503, body: '{}' }));
  await linked.goto(publicLink);
  const loadError = linked.locator('.public-status').filter({ hasText: 'Course data could not be loaded (503)' });
  await loadError.waitFor();
  assert.match(await loadError.innerText(), /Return to Maps/);
  assert(
    await linked.getByRole('link', { name: 'Maps', exact: true }).isVisible(),
    'load failures keep a mobile route back to Maps',
  );
  assert(await linked.locator('.sp-chat-docked').isHidden(), 'failed loads do not open chat');
  await linkContext.close();
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const guest = await guestContext.newPage();
  failurePage = guest;
  let guestProjectRequests = 0;
  const errors: string[] = [],
    retailRequests: string[] = [],
    received: any[] = [],
    sent: any[] = [];
  guest.on('pageerror', error => errors.push(error.message));
  guest.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/projects')) guestProjectRequests++;
    if (
      [
        '/api/level',
        '/api/particle-texture',
        '/api/board-audio',
        '/api/board-sound',
        '/api/announcer-audio',
        '/api/reference-music',
        '/api/reference-music-sample',
        '/api/environment-sound',
      ].includes(url.pathname) ||
      ['FIXTURE', 'GARI'].includes(url.searchParams.get('level') ?? '')
    )
      retailRequests.push(url.pathname);
  });
  guest.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/public/session') return;
    socket.on('framereceived', event => {
      try {
        received.push(JSON.parse(String(event.payload)));
      } catch {
        /* control frames */
      }
    });
    socket.on('framesent', event => {
      try {
        sent.push(JSON.parse(String(event.payload)));
      } catch {
        /* control frames */
      }
    });
  });
  await guest.goto(origin);
  await guest.getByRole('heading', { name: 'Maps', level: 1 }).waitFor();
  assert.equal(new URL(guest.url()).pathname, '/maps', 'signed-out root visits land on /maps');
  const primaryNav = guest.getByRole('navigation', { name: 'Primary' });
  assert.equal(await primaryNav.getByRole('link', { name: 'Maps', exact: true }).getAttribute('aria-current'), 'page');
  assert.equal(await primaryNav.getByRole('link', { name: 'ISO', exact: true }).getAttribute('aria-current'), null);
  await guest.getByRole('button', { name: /PUBLIC RUN/ }).waitFor();
  const publicCard = guest.getByRole('article', { name: 'PUBLIC RUN', exact: true });
  assert(await publicCard.getByRole('button', { name: 'Play PUBLIC RUN', exact: true }).isEnabled());
  await guest.mouse.move(1, 1);
  const mapPrimaryStyle = await primaryStyle(publicCard.locator('.public-primary'));
  await publicCard.hover({ position: { x: 12, y: 12 } });
  assert(
    await publicCard.locator('.public-primary').evaluate(el => el.matches(':hover')),
    'hovering a tile highlights its actual primary button',
  );
  await publicCard.getByRole('link', { name: 'Edit PUBLIC RUN', exact: true }).hover();
  assert.equal(
    await publicCard.locator('.public-primary').evaluate(el => el.matches(':hover')),
    false,
    'secondary actions retain their own hover target',
  );
  assert(
    await guest
      .locator('.public-map-tile:not(.public-new-map)')
      .evaluateAll(tiles => tiles.every(tile => tile.querySelectorAll('.public-primary').length === 1)),
    'every map tile identifies exactly one primary action',
  );
  assert.equal(
    await publicCard.getByRole('link', { name: 'Load ISO maps', exact: true }).count(),
    0,
    'maps with no missing assets only show their Play action',
  );
  const missingReference = guest.getByRole('article', { name: 'FIXTURE', exact: true });
  assert(await missingReference.getByRole('button', { name: 'Play FIXTURE', exact: true }).isDisabled());
  await missingReference.click({ position: { x: 12, y: 12 } });
  assert.equal(new URL(guest.url()).pathname, '/maps', 'a disabled primary action also disables the tile background');
  const referenceIsoUrl = new URL(
    (await missingReference.getByRole('link', { name: 'Load ISO maps', exact: true }).getAttribute('href'))!,
  );
  assert.equal(referenceIsoUrl.searchParams.get('reference'), 'FIXTURE');
  assert.equal(referenceIsoUrl.pathname, '/isos', 'a missing map links directly to the ISO manager');
  assert.equal(
    await guest.getByRole('button', { name: 'Load course', includeHidden: true }).count(),
    0,
    'the map browser has no separate selection or load panel',
  );
  assert(await guest.locator('.public-requirements-host').isHidden());
  assert(await guest.getByRole('heading', { name: 'Public maps', exact: true }).isVisible());
  assert(await guest.getByRole('heading', { name: 'From your ISO', exact: true }).isVisible());
  assert.equal(await guest.locator('#public-iso').count(), 0, 'ISO management lives on its own page');
  assert.equal(await guest.getByRole('button', { name: /PRIVATE RUN/ }).count(), 0);
  assert.equal(await guest.getByRole('region', { name: 'Private server maps', exact: true }).count(), 0);
  assert.equal(await guest.getByRole('link', { name: 'Edit PRIVATE RUN', exact: true }).count(), 0);
  assert.equal(guestProjectRequests, 0, 'guest catalogues never request the authenticated server project list');
  await guest.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    (await guest.locator('.public-header').boundingBox())?.height,
    40,
    'mobile navigation matches the play header height',
  );
  assert(await primaryNav.getByRole('link', { name: 'ISO', exact: true }).isVisible());
  assert(await primaryNav.getByRole('link', { name: 'Maps', exact: true }).isVisible());
  assert(
    await guest.evaluate(() => document.querySelector('.public-home')!.getBoundingClientRect().right <= innerWidth),
  );
  assert(await guest.locator('.sp-chat-docked').isHidden(), 'the map browser has no chat panel');
  assert(await guest.getByLabel('Your rider name').isHidden(), 'browsing does not ask for a nickname');
  assert.equal(await guest.locator('.public-home').evaluate(el => getComputedStyle(el).marginRight), '0px');
  assert(
    !sent.some(message => message.t === 'aware' && message.aware.player),
    'browsing does not publish a player pose',
  );
  await guest.setViewportSize({ width: 320, height: 700 });
  assert(
    await guest.evaluate(() => document.body.scrollWidth <= innerWidth),
    'cards and icon navigation fit narrow phones',
  );
  assert(await primaryNav.getByRole('link', { name: 'Maps', exact: true }).isVisible());
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.locator('#load-status').waitFor({ state: 'hidden' });
  await guest.screenshot({ path: join(root, 'maps-mobile.png') });
  await guest.setViewportSize({ width: 1440, height: 1000 });
  await guest.getByRole('link', { name: 'Sign in', exact: true }).click();
  await guest.locator('.sp-login-card').waitFor();
  assert.equal(await guest.title(), 'Sign in · Slopesmith');
  assert.equal(new URL(guest.url()).pathname, '/editor', 'Sign in enters through the editor route');
  await guest.screenshot({ path: join(root, 'login-home-link.png') });
  await guest.getByRole('link', { name: '← Back to homepage', exact: true }).click();
  await guest.getByRole('heading', { name: 'Maps', level: 1, exact: true }).waitFor();
  await publicCard.click({ position: { x: 12, y: 12 } });
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  assert(
    sent.some(message => message.t === 'aware' && message.aware.player),
    'anonymous riders publish positions before choosing a chat nickname',
  );
  await guest.setViewportSize({ width: 390, height: 844 });
  await openCommunity(guest);
  const mobileChat = await guest.locator('.sp-chat-docked').boundingBox();
  assert(
    mobileChat &&
      mobileChat.height > 700 &&
      mobileChat.width <= 390 &&
      Math.abs(mobileChat.x + mobileChat.width - 390) < 1,
    'the user/chat drawer stays on the right on mobile',
  );
  await guest.setViewportSize({ width: 1440, height: 1000 });
  await guest.getByLabel('Your rider name').fill('AdMiN');
  await guest.locator('.public-chat-join').getByRole('button').click();
  await guest.getByText('That name belongs to an account. Sign in or choose another name.', { exact: true }).waitFor();
  assert(!sent.some(message => message.t === 'chat'), 'reserved account names do not enable chat');
  await joinChat(guest);
  assert(
    await guest.getByRole('button', { name: 'Exit play', exact: true }).isVisible(),
    'joining chat preserves the current ride',
  );
  await guest.getByRole('textbox', { name: 'Chat message' }).fill('<b>hello lodge</b>');
  await guest.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await guest.getByText('<b>hello lodge</b>', { exact: true }).waitFor();
  assert.equal(await guest.locator('.sp-chat-log b').count(), 0, 'chat stays plain text');
  const cookie = (await guestContext.cookies()).find(cookie => cookie.name === 'slopesmith_guest')!;
  assert(cookie.httpOnly && cookie.sameSite === 'Strict');
  assert.equal(
    (await call('/api/projects', 'GET', undefined, `${cookie.name}=${cookie.value}`)).status,
    401,
    'guest cookie grants no editor access',
  );
  const hostile = await guest.evaluate(async privateId => {
    const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/public/session`);
    const messages: any[] = [];
    return await new Promise<any[]>(resolve => {
      ws.onmessage = event => {
        const message = JSON.parse(event.data);
        messages.push(message);
        if (message.t === 'welcome') {
          ws.send(JSON.stringify({ t: 'watch', projectId: privateId }));
          ws.send(JSON.stringify({ t: 'assign', changes: [['g/name', 'HACKED']] }));
          ws.send(JSON.stringify({ t: 'fetch', sections: ['globals'] }));
        }
        if (messages.filter(message => message.t === 'error').length === 3) {
          ws.close();
          resolve(messages);
        }
      };
      setTimeout(() => {
        ws.close();
        resolve(messages);
      }, 5000);
    });
  }, privateMap.project.id);
  assert.equal(hostile.filter(message => message.t === 'error').length, 3);
  assert(!hostile.some(message => message.document || message.changes || message.t === 'joined'));
  assert(!JSON.stringify(hostile).includes('PRIVATE_RUN'), 'guest roster and history omit private editor state');

  await guest.goto(origin);
  await guest.getByRole('heading', { name: 'Maps', level: 1, exact: true }).waitFor();
  await openCommunity(guest);
  await guest.locator('.public-chat-status').filter({ hasText: 'Connected as' }).waitFor();
  await closeCommunity(guest);
  const borrowedCard = guest.getByRole('article', { name: 'BORROWED RUN', exact: true });
  assert.match(await borrowedCard.innerText(), /ISO optional/);
  assert(
    await borrowedCard.getByRole('button', { name: 'Play BORROWED RUN', exact: true }).isEnabled(),
    'authored maps can be played while optional ISO assets are missing',
  );
  assert.equal(await borrowedCard.locator('.public-iso-badge').count(), 1);
  const borrowedRequirements = borrowedCard.locator('.public-iso-summary.missing');
  assert.equal(await borrowedRequirements.innerText(), 'Requirements unfulfilled (2)');
  await borrowedRequirements.hover();
  assert.match(await guest.locator('.sp-tip.show').innerText(), /Garibaldi.*Not loaded/);
  assert.match(await guest.locator('.sp-tip.show').innerText(), /FIXTURE.*Not loaded/);
  assert.equal(
    new URL((await borrowedCard.getByRole('link', { name: 'Load ISO maps', exact: true }).getAttribute('href'))!)
      .pathname,
    '/isos',
  );
  await borrowedCard.getByRole('button', { name: 'Play BORROWED RUN', exact: true }).click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(guest.url()).pathname, '/play/BORROWED_RUN', 'opening a map card enters its named player route');
  assert.equal(
    await guest.getByRole('link', { name: 'BORROWED RUN', exact: true }).getAttribute('aria-current'),
    'page',
  );
  assert(
    await guest.getByRole('link', { name: 'ISO', exact: true }).isVisible(),
    'the ISO tab stays beside Maps and the current map',
  );
  assert.equal(
    await guest.locator('.public-in-world').evaluate(el => el.getBoundingClientRect().height),
    0,
    'ISO requirements no longer create a second header above the map',
  );
  const assetsMenu = guest.locator('.public-header .public-requirements-host');
  await assetsMenu.locator('summary').click();
  assert.match(await assetsMenu.innerText(), /ISO textures\/props omitted/);
  await guest.screenshot({ path: join(root, 'combined-map-header.png') });
  await assetsMenu.locator('summary').click();
  await guest.setViewportSize({ width: 320, height: 700 });
  assert(
    await guest.evaluate(() => document.body.scrollWidth <= innerWidth),
    'the combined map header fits a narrow phone',
  );
  await assetsMenu.locator('summary').click();
  const isoPopup = await assetsMenu.getByRole('region', { name: 'Required ISO maps' }).boundingBox();
  assert(isoPopup && isoPopup.x >= 0 && isoPopup.x + isoPopup.width <= 320, 'the ISO details menu stays on screen');
  await guest.screenshot({ path: join(root, 'combined-map-header-mobile.png') });
  await assetsMenu.locator('summary').press('Escape');
  assert.equal(await assetsMenu.getAttribute('open'), null, 'Escape closes the header assets menu');
  await guest.setViewportSize({ width: 1440, height: 1000 });
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play' }).waitFor();
  await guest.screenshot({ path: join(root, 'guest-without-iso.png') });
  assert.deepEqual(retailRequests, [], 'a borrowed-assets mountain rides without requesting retail bytes');
  await guest.goto(origin);

  await guest.getByRole('button', { name: /PUBLIC RUN/ }).click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play' }).waitFor();
  assert(
    await guest.getByRole('button', { name: usersButtonName }).isVisible(),
    'public pages retain the shared community control',
  );
  await joinChat(guest);
  const memberContext = await browser.newContext();
  await memberContext.addCookies([{ name: 'slopesmith_session', value: adminCookie.split('=')[1], url: origin }]);
  const member = await memberContext.newPage();
  await member.goto(publicLink);
  await member.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await member.getByRole('button', { name: 'Play', exact: true }).click();
  await joinChat(member);
  await member.setViewportSize({ width: 320, height: 700 });
  assert(
    await member.evaluate(() => document.body.scrollWidth <= innerWidth),
    'member navigation fits a narrow player header',
  );
  assert(await member.getByRole('link', { name: 'ISO', exact: true }).isVisible());
  assert(await member.getByRole('link', { name: 'PUBLIC RUN', exact: true }).isVisible());
  await member.setViewportSize({ width: 1280, height: 720 });
  await member.getByRole('textbox', { name: 'Chat message' }).fill('Member riding with guests');
  await member.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await guest.getByText('Member riding with guests', { exact: true }).waitFor();
  await guest.waitForFunction(() => document.querySelector('canvas') !== null);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert(
    received.some(
      message =>
        message.t === 'awareness-batch' &&
        message.peers.some((peer: any) => peer.username === 'admin' && peer.aware.player),
    ),
    'member rider poses reach the guest on the same mountain',
  );
  await guest.evaluate(async () => {
    const moduleUrl = '/src/app/viewport/viewport.ts';
    const { Viewport } = await import(/* @vite-ignore */ moduleUrl);
    const goTo = Viewport.prototype.goToMapPlayer;
    Viewport.prototype.goToMapPlayer = function (this: any, sessionId: string) {
      const target = this.remotePlayers.navigationTarget(sessionId);
      const riding = this.riding;
      const moved = goTo.call(this, sessionId);
      (window as any).playerNavigation = {
        moved,
        riding,
        expected: (riding ? target.join : target.eye).toArray(),
        actual: riding ? this.playerPose('stick-figure.glb', Date.now()).body.p : this.camera.position.toArray(),
      };
      (window as any).navigationViewport = this;
      return moved;
    };
  });
  async function goToMember() {
    await guest.getByRole('tab', { name: /^Users \(/ }).click();
    await guest.getByRole('button', { name: 'Options for admin', exact: true }).click();
    await guest.getByRole('button', { name: 'Go to player', exact: true }).click();
    const navigation = await guest.evaluate(() => (window as any).playerNavigation);
    assert.equal(navigation.moved, true, 'the public user menu reaches a live player');
    assert(
      Math.hypot(navigation.actual[0] - navigation.expected[0], navigation.actual[2] - navigation.expected[2]) < 0.1,
      'the public menu uses the same rider/camera destination as the editor',
    );
    await guest.getByRole('tab', { name: 'Chat', exact: true }).click();
    return navigation;
  }
  assert.equal((await goToMember()).riding, true, 'Go to player teleports without ending the ride');
  assert(await guest.getByRole('button', { name: 'Exit play', exact: true }).isVisible());
  await guest.getByRole('button', { name: 'Exit play', exact: true }).click();
  assert.equal((await goToMember()).riding, false, 'Go to player also moves the map preview camera');
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play', exact: true }).waitFor();
  await guest.keyboard.press('Enter');
  await guest.getByRole('textbox', { name: 'Chat message' }).fill('Chat while riding');
  await guest.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await member.getByText('Chat while riding', { exact: true }).waitFor();
  assert(await guest.getByRole('button', { name: 'Exit play' }).isVisible(), 'chat does not stop the ride');
  const chatBox = await guest.locator('.sp-chat-entry').boundingBox();
  assert(chatBox && chatBox.y > 800, 'chat input stays docked at the bottom of the right rail');
  await guest.screenshot({ path: join(root, 'guest-riding.png') });
  await guest.getByRole('button', { name: 'Leave chat', exact: true }).click();
  assert(await guest.getByLabel('Your rider name').isVisible(), 'leaving chat returns to nickname entry');
  assert(
    await guest.getByRole('button', { name: 'Exit play', exact: true }).isVisible(),
    'turning chat off keeps the ride running',
  );
  assert.equal(
    await guest.locator('#viewport').evaluate(el => getComputedStyle(el).right),
    '0px',
    'turning chat off restores the full viewport',
  );
  const framesAfterHide = sent.length;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert(sent.length > framesAfterHide, 'leaving chat keeps anonymous multiplayer positions publishing');
  await member.getByRole('textbox', { name: 'Chat message' }).fill('Only connected riders see this');
  await member.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  assert.equal(
    await guest.getByText('Only connected riders see this', { exact: true }).count(),
    0,
    'chat off disconnects the feed',
  );
  assert(await guest.locator('.public-chat-join').isVisible(), 'showing chat offers an explicit rejoin');
  assert(
    !sent.slice(framesAfterHide).some(message => message.t === 'chat'),
    'showing the join form leaves outgoing chat disabled',
  );
  await joinChat(guest);
  await guest.getByText('Only connected riders see this', { exact: true }).waitFor();
  assert(
    sent.slice(framesAfterHide).some(message => message.t === 'playing' && message.playing === 'authored'),
    'rejoining restores the current multiplayer world without restarting',
  );
  await memberContext.close();
  await guest.waitForFunction(
    () => !(window as any).navigationViewport.activeMapPlayers().some((p: any) => p.username === 'admin'),
  );
  await guest.locator('.sp-chat-who').filter({ hasText: 'admin:' }).first().click({ button: 'right' });
  await guest.getByRole('button', { name: 'Mute chat', exact: true }).waitFor();
  assert.equal(
    await guest.getByRole('button', { name: 'Go to player', exact: true }).count(),
    0,
    'a departed player cannot be visited through an old chat message',
  );
  await guest.keyboard.press('Escape');

  async function assertReferencePeers(level: string) {
    const context = await browser!.newContext();
    await context.addCookies([{ name: 'slopesmith_session', value: adminCookie.split('=')[1], url: origin }]);
    const member = await context.newPage();
    await member.goto(`${origin}/api`);
    const sample = [...sent].reverse().find(message => message.t === 'aware' && message.aware.player)?.aware.player;
    assert(sample, 'the public rider publishes a real pose');
    const before = received.length;
    await member.evaluate(
      async ({ projectId, pose, level }) => {
        const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/session?client=reference-editor`);
        await new Promise<void>(resolve => {
          ws.onmessage = event => {
            if (JSON.parse(event.data).t !== 'welcome') return;
            for (const message of [
              { t: 'watch', projectId },
              { t: 'reference', level },
              { t: 'playing', playing: 'reference' },
            ])
              ws.send(JSON.stringify(message));
            setTimeout(() => {
              ws.send(JSON.stringify({ t: 'aware', aware: { player: { ...pose, sampleAt: Date.now() } } }));
              setTimeout(() => {
                ws.close();
                resolve();
              }, 300);
            }, 100);
          };
        });
      },
      { projectId: privateMap.project.id, pose: sample, level },
    );
    assert(
      received
        .slice(before)
        .some(
          message =>
            message.t === 'awareness-batch' &&
            message.projectId === `@reference:${level}` &&
            message.peers.some((peer: any) => peer.username === 'admin'),
        ),
      'guest shares a reference world with a member editing a different project',
    );
    assert(
      !JSON.stringify(received.slice(before)).includes('PRIVATE_RUN'),
      'reference multiplayer reveals no private map name',
    );
    await context.close();
  }

  // Generate an independent tiny ISO using Native's existing synthetic fixture, then test worker -> IDB -> renderer.
  const fixture = join(root, 'synthetic.iso');
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from import_test import iso,big,course_members; Path(sys.argv[2]).write_bytes(iso(big(course_members())))',
      resolve('../Native/tests'),
      fixture,
    ],
    { windowsHide: true },
  );
  const localFixture = join(root, 'local-gari.iso');
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      [
        'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
        'from import_test import iso,big,course_members,record',
        "archive=big({name.replace('fixture','gari'):data for name,data in course_members().items()})",
        'image=iso(archive)',
        "rows=record(b'\\0',26,2048,True)+record(b'\\1',26,2048,True)+record('GARI.BIG;1',28,len(archive))",
        'image[26*2048:27*2048]=rows+bytes(2048-len(rows))',
        'Path(sys.argv[2]).write_bytes(image)',
      ].join('\n'),
      resolve('../Native/tests'),
      localFixture,
    ],
    { windowsHide: true },
  );
  const soundRepairFixture = join(root, 'sound-repair.iso');
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      [
        'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
        'from audio_import_test import disc,fixture',
        'from import_test import big,course_members',
        'from audio_resolver_fixture import boot_program',
        'files=fixture()',
        "files.pop('DATA/MODELS/FIXTURE.BIG')",
        "files['DATA/MODELS/GARI.BIG']=big({name.replace('fixture','gari'):data for name,data in course_members().items()})",
        "files['SYSTEM.CNF']=b'BOOT2 = cdrom0:\\\\AUTHORED.ELF;1\\r\\n'",
        "files['AUTHORED.ELF']=boot_program()",
        'Path(sys.argv[2]).write_bytes(disc(files))',
      ].join('\n'),
      resolve('../Native/tests'),
      soundRepairFixture,
    ],
    { windowsHide: true },
  );

  // Choosing an ISO does not load anything until the visitor chooses a map on the management page.
  await guest.goto(origin);
  assert.equal(await guest.getByRole('button', { name: /Garibaldi/ }).count(), 0);
  await guest.getByRole('link', { name: 'ISO', exact: true }).click();
  await closeCommunity(guest);
  await guest.getByRole('heading', { name: 'ISO', level: 1, exact: true }).waitFor();
  assert.equal(await primaryNav.getByRole('link', { name: 'ISO', exact: true }).getAttribute('aria-current'), 'page');
  await guest.setViewportSize({ width: 800, height: 1000 });
  assert.equal(
    (await guest.locator('.public-header').boundingBox())?.width,
    800,
    'ISO navigation spans tablet screens without a chat sidebar',
  );
  await guest.setViewportSize({ width: 1440, height: 1000 });
  await guest.locator('#public-iso').setInputFiles(localFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  const managerGari = guest.locator('.public-iso-map[data-course="GARI"]');
  assert.match(await managerGari.innerText(), /Garibaldi.*Not loaded/s);
  await guest.getByText('0 loaded', { exact: true }).waitFor();
  assert.equal(
    (await checked('/api/public/courses', 'GET', undefined, '')).courses.some((course: any) => course.id === 'GARI'),
    false,
  );
  assert.equal((await call('/api/level?name=GARI')).status, 401, 'local ISO rooms grant no access to server map files');
  await guest.screenshot({ path: join(root, 'iso-manager.png') });
  await managerGari.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  await managerGari.locator('.public-iso-badge.loaded').waitFor();
  await guest.mouse.move(1, 1);
  assert.deepEqual(
    await primaryStyle(managerGari.getByRole('link', { name: 'Play Garibaldi', exact: true })),
    mapPrimaryStyle,
    'ISO and Maps tiles use the same primary Play style',
  );
  await managerGari.hover({ position: { x: 12, y: 12 } });
  assert(await managerGari.locator('.public-primary').evaluate(el => el.matches(':hover')));
  await guest.getByText('1 loaded', { exact: true }).waitFor();
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  const localCard = guest.locator('.public-local-maps').getByRole('article', { name: 'Garibaldi', exact: true });
  await localCard.waitFor();
  assert(await localCard.getByRole('button', { name: 'Play Garibaldi', exact: true }).isEnabled());
  assert.equal(
    await localCard.getByRole('link', { name: 'Load ISO maps', exact: true }).count(),
    0,
    'loaded maps offer Play without an unnecessary load-assets action',
  );
  await guest
    .locator('.public-server-maps')
    .getByRole('button', { name: /PUBLIC RUN/ })
    .waitFor();
  assert.equal(
    await guest
      .locator('.public-server-maps')
      .getByRole('button', { name: /Garibaldi/ })
      .count(),
    0,
  );
  await guest.locator('#load-status').waitFor({ state: 'hidden' });
  await guest.screenshot({ path: join(root, 'separate-map-lists.png'), fullPage: true });
  await localCard.click({ position: { x: 12, y: 12 } });
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await joinChat(guest);
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play' }).waitFor();
  assert(
    received.some(message => message.t === 'joined' && message.projectId === '@reference:GARI'),
    'ISO-only riding joins the shared retail reference room',
  );
  await assertReferencePeers('GARI');
  const fog = particleVolumesToNative([createFogVolume([0, 2, 0])]);
  await guest.evaluate(
    async text => {
      const files = JSON.parse(text) as Record<string, unknown>;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('slopesmith-local-disc', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('files', 'readwrite');
          for (const [path, data] of Object.entries(files))
            transaction.objectStore('files').put({
              key: `GARI/${path.toLowerCase()}`,
              course: 'GARI',
              path,
              blob: new Blob([JSON.stringify(data)], { type: 'application/json' }),
            });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    },
    JSON.stringify({
      'Effects.json': createEmptyEffectsDocument('GARI'),
      'ParticleInstances.json': fog.instances,
      'ParticleModels.json': fog.models,
      'Audio/SoundIndex.json': {
        Schema: 'openslope-sound-index/v1',
        Level: 'GARI',
        Banks: { 2: 'tone', 3: 'crowd' },
        CollisionEvents: {},
        ResolverState: 'Deferred',
      },
    }),
  );
  await guest.goto(origin);
  await guest
    .locator('.public-local-maps')
    .getByRole('button', { name: /Garibaldi/ })
    .click();
  const repairStatus = guest.locator('.public-status').filter({
    hasText: 'Choose your ISO once more to restore collision sounds',
  });
  await repairStatus.waitFor();
  assert.equal(new URL(guest.url()).pathname, '/play/Garibaldi', 'audio repair stays on the named player route');
  await repairStatus.getByRole('link', { name: 'Load ISO maps', exact: true }).click();
  assert.equal(new URL(guest.url()).searchParams.get('reference'), 'GARI', 'audio repair retains the ISO map');
  assert.equal(new URL(guest.url()).searchParams.get('source'), 'iso', 'audio repair retains the local ISO source');
  await closeCommunity(guest);
  await guest.locator('#public-iso').setInputFiles(soundRepairFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  assert.deepEqual(
    await guest.evaluate(async () => {
      const moduleUrl = '/src/app/public/iso-cache.ts';
      const { readCachedCourse } = await import(/* @vite-ignore */ moduleUrl);
      const files = await readCachedCourse('GARI');
      const index = JSON.parse(await files.get('audio/soundindex.json')!.text());
      return {
        state: index.ResolverState,
        event: index.CollisionEvents['2'],
        fogKept: files.has('particleinstances.json'),
      };
    }),
    { state: 'Resolved', event: { Group: 2, Slot: 13, Bank: 'tone', Clip: 'Audio/SFX/tone/013.wav' }, fogKept: true },
    'the manager repairs old audio metadata through Wasm without replacing loaded map assets',
  );
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  await guest.getByRole('heading', { name: 'Maps', level: 1 }).waitFor();
  await guest.addInitScript(async () => {
    if (!location.pathname.startsWith('/play/')) return;
    const moduleUrl = '/src/app/viewport/viewport.ts';
    const { Viewport } = await import(/* @vite-ignore */ moduleUrl);
    const setReference = Viewport.prototype.setReference;
    Viewport.prototype.setReference = function (...args: any[]) {
      (window as any).publicTestViewport = this;
      return setReference.apply(this, args);
    };
  });
  await guest
    .locator('.public-local-maps')
    .getByRole('button', { name: /Garibaldi/ })
    .click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.deepEqual(
    await guest.evaluate(() => {
      const group = (window as any).publicTestViewport.scene.getObjectByName('Reference ambient particles');
      return { visible: group.visible, puffs: group.children[0]?.geometry.instanceCount };
    }),
    { visible: true, puffs: 9 },
    'local course fog is visible by default',
  );
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play' }).waitFor();

  await guest.goto(`${origin}/isos`);
  await closeCommunity(guest);
  await guest.getByRole('button', { name: 'Unload Garibaldi', exact: true }).click();
  await guest.getByText('0 loaded', { exact: true }).waitFor();
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  assert.equal(
    await guest
      .locator('.public-local-maps')
      .getByRole('button', { name: /Garibaldi/ })
      .count(),
    0,
  );
  await guest.getByRole('link', { name: 'ISO', exact: true }).click();
  await closeCommunity(guest);
  await guest.locator('#public-iso').setInputFiles(localFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  await guest.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  await guest.getByText('1 loaded', { exact: true }).waitFor();
  assert(
    await guest.evaluate(async () => {
      const moduleUrl = '/src/app/public/iso-cache.ts';
      const { readCachedCourse } = await import(/* @vite-ignore */ moduleUrl);
      const files = await readCachedCourse('GARI');
      return files.has('patches.json') && !files.has('particleinstances.json');
    }),
    'reloading extracts fresh files without stale sidecars',
  );
  await guest.getByRole('button', { name: 'Clear local assets', exact: true }).click();
  await guest.getByText('0 loaded', { exact: true }).waitFor();
  await guest
    .locator('#public-iso')
    .setInputFiles({ name: 'invalid.iso', mimeType: 'application/octet-stream', buffer: Buffer.from('not a disc') });
  await guest
    .locator('.public-iso-status')
    .filter({ hasText: /ISO|disc|read|format/i })
    .waitFor();
  await guest.waitForFunction(() => !(document.querySelector('#public-iso') as HTMLInputElement).disabled);
  assert.equal(await guest.locator('.public-iso-map').count(), 0, 'an invalid ISO creates no stale rows');

  // A named shared link summarizes requirements and shows each donor on hover.
  await guest.goto(`${origin}/play/BORROWED_RUN`);
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await guest.locator('.public-header .public-assets-summary').click();
  const deps = guest.getByRole('region', { name: 'Required ISO maps', exact: true });
  assert.equal(await deps.locator('.public-iso-badge').count(), 1);
  await deps.locator('.public-iso-summary').hover();
  assert.match(await guest.locator('.sp-tip.show').innerText(), /Garibaldi.*Not loaded/);
  assert.match(await guest.locator('.sp-tip.show').innerText(), /FIXTURE.*Not loaded/);
  await deps.getByRole('link', { name: 'Load ISO maps', exact: true }).click();
  await closeCommunity(guest);
  assert.equal(new URL(guest.url()).pathname, '/isos');
  assert.equal(
    new URL(guest.url()).searchParams.get('map'),
    'BORROWED_RUN',
    'the ISO route keeps the target map requirements',
  );
  await guest.getByRole('heading', { name: 'Required maps', exact: true }).waitFor();
  await guest.locator('#public-iso').setInputFiles(fixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 map found' }).waitFor();
  await guest.getByRole('button', { name: 'Load required maps', exact: true }).click();
  await guest.locator('.public-iso-map[data-course="FIXTURE"] .public-iso-badge.loaded').waitFor();
  assert.match(await guest.locator('.public-iso-map[data-course="GARI"]').innerText(), /Not found in the selected ISO/);
  const isoTileBoxes = await guest
    .locator('.public-iso-map')
    .evaluateAll(tiles => tiles.map(tile => tile.getBoundingClientRect().top));
  assert.equal(isoTileBoxes[0], isoTileBoxes[1], 'ISO maps use the same tile grid as the Maps page');
  await guest.screenshot({ path: join(root, 'required-iso-maps.png') });
  await guest.setViewportSize({ width: 390, height: 844 });
  assert(await guest.evaluate(() => document.body.scrollWidth <= innerWidth), 'ISO tiles fit mobile screens');
  await guest.screenshot({ path: join(root, 'iso-mobile.png') });
  await guest.setViewportSize({ width: 1440, height: 1000 });
  await guest.getByRole('link', { name: '← BORROWED RUN', exact: true }).click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(
    new URL(guest.url()).pathname,
    '/play/BORROWED_RUN',
    'the ISO manager returns to the named player route',
  );
  await guest.locator('.public-header .public-assets-summary').click();
  assert.equal(await deps.locator('.public-iso-summary.missing').innerText(), 'Requirements unfulfilled (1)');
  await deps.locator('.public-iso-summary').hover();
  assert.match(await guest.locator('.sp-tip.show').innerText(), /FIXTURE · Loaded/);
  assert.match(await guest.locator('.sp-tip.show').innerText(), /Garibaldi.*Not loaded/);
  await guest.screenshot({ path: join(root, 'map-dependency-badges.png') });

  await guest.goto(origin);
  await guest
    .locator('.public-local-maps')
    .getByRole('button', { name: /FIXTURE/ })
    .waitFor();
  await guest
    .locator('.public-server-maps')
    .getByRole('button', { name: /FIXTURE/ })
    .waitFor();
  assert.equal(
    await guest
      .locator('.public-server-maps')
      .getByRole('button', { name: /FIXTURE/ })
      .count(),
    1,
  );
  assert.equal(
    await guest
      .locator('.public-local-maps')
      .getByRole('button', { name: /FIXTURE/ })
      .count(),
    1,
    'a published reference and a loaded ISO map appear in their own sections',
  );
  await guest
    .locator('.public-local-maps')
    .getByRole('button', { name: /FIXTURE/ })
    .click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  await joinChat(guest);
  await guest.getByRole('button', { name: 'Play', exact: true }).click();
  await guest.getByRole('button', { name: 'Exit play' }).waitFor();
  await assertReferencePeers('FIXTURE');
  await guest.reload();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(
    await guest.getByRole('link', { name: 'FIXTURE', exact: true }).getAttribute('aria-current'),
    'page',
    'reloading the named map URL keeps the same ISO map open',
  );
  assert.deepEqual(retailRequests, [], 'ISO maps, prop donors, sounds and textures stay local, including reload');
  assert.deepEqual(errors, []);
  await checked('/api/publication?kind=reference&id=FIXTURE', 'PUT', { published: false });
  await guest.goto(origin);
  await guest.getByRole('heading', { name: 'Maps', level: 1 }).waitFor();
  await guest
    .locator('.public-server-maps')
    .getByRole('button', { name: /PUBLIC RUN/ })
    .waitFor();
  assert.equal(
    await guest
      .locator('.public-server-maps')
      .getByRole('button', { name: /FIXTURE/ })
      .count(),
    0,
  );
  assert.equal(
    await guest
      .locator('.public-local-maps')
      .getByRole('button', { name: /FIXTURE/ })
      .count(),
    1,
    'unpublishing a server map keeps the visitor’s loaded ISO map',
  );

  // Queue real imports from a two-map disc; hold the storage permission step to inspect waiting cards.
  const queueFixture = join(root, 'two-maps.iso');
  execFileSync(
    process.platform === 'win32' ? 'python' : 'python3',
    [
      '-c',
      [
        'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
        'from audio_import_test import disc',
        'from import_test import big,course_members',
        "files={f'DATA/MODELS/{slot.upper()}.BIG':big({name.replace('fixture',slot):data for name,data in course_members().items()}) for slot in ['gari','snow']}",
        'Path(sys.argv[2]).write_bytes(disc(files))',
      ].join('\n'),
      resolve('../Native/tests'),
      queueFixture,
    ],
    { windowsHide: true },
  );
  await guest.goto(`${origin}/isos`);
  await closeCommunity(guest);
  await guest.getByRole('button', { name: 'Clear local assets', exact: true }).click();
  await guest.getByText('0 loaded', { exact: true }).waitFor();
  await guest.locator('#public-iso').setInputFiles(queueFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '2 maps found' }).waitFor();
  await guest.evaluate(`(() => {
    const persist = navigator.storage.persist.bind(navigator.storage);
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: async () => { await ready; return persist(); } });
    window.releaseIsoImports = release;
  })()`);
  const queuedGari = guest.locator('.public-iso-map[data-course="GARI"]');
  const queuedSnow = guest.locator('.public-iso-map[data-course="SNOW"]');
  await guest.setViewportSize({ width: 390, height: 844 });
  const tileGeometry = () =>
    guest.locator('.public-iso-map').evaluateAll(tiles =>
      tiles.map(tile => {
        const { x, y, width, height } = tile.getBoundingClientRect();
        return { slot: (tile as HTMLElement).dataset.course, x, y, width, height };
      }),
    );
  const beforeLoading = await tileGeometry();
  const originalGari = await queuedGari.elementHandle(),
    originalSnow = await queuedSnow.elementHandle();
  await guest.evaluate(() => {
    (window as any).isoCardReplacements = 0;
    new MutationObserver(changes => {
      (window as any).isoCardReplacements += changes.reduce(
        (count, change) => count + change.addedNodes.length + change.removedNodes.length,
        0,
      );
    }).observe(document.querySelector('.public-iso-map-list')!, { childList: true });
  });
  await guest.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  assert.equal(await queuedGari.getAttribute('data-state'), 'loading');
  assert(await queuedGari.getByRole('progressbar', { name: 'Loading Garibaldi' }).isVisible());
  assert.equal(await guest.locator('.public-iso-status').innerText(), '', 'map loading progress stays in its card');
  assert.deepEqual(await tileGeometry(), beforeLoading, 'starting an import does not move or resize any card');
  await guest.getByRole('button', { name: 'Load Snowdream', exact: true }).click();
  assert.equal(await queuedSnow.getAttribute('data-state'), 'queued');
  assert.match(await queuedSnow.innerText(), /Queued/);
  assert(await guest.locator('#public-iso').isDisabled(), 'the selected ISO stays stable until queued imports finish');
  assert.deepEqual(await tileGeometry(), beforeLoading, 'queued cards keep their original position and dimensions');
  await guest.screenshot({ path: join(root, 'queued-map-imports.png') });
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  const leaveIso = guest.getByRole('alertdialog', { name: 'Leave while ISO is loading?', exact: true });
  await leaveIso.waitFor();
  assert.match(await leaveIso.innerText(), /cancel the active ISO load and any queued maps/);
  await leaveIso.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(new URL(guest.url()).pathname, '/isos', 'dismissing the warning stays on ISO management');
  assert.equal(await queuedGari.getAttribute('data-state'), 'loading', 'staying keeps the current import running');
  assert.equal(await queuedSnow.getAttribute('data-state'), 'queued', 'staying preserves queued maps');
  const unloadWarning = guest.waitForEvent('dialog');
  await guest.evaluate(() => {
    setTimeout(() => location.reload(), 0);
  });
  const unloadDialog = await unloadWarning;
  assert.equal(unloadDialog.type(), 'beforeunload', 'refresh also warns during an ISO import');
  await unloadDialog.dismiss();
  assert.equal(
    await queuedGari.getAttribute('data-state'),
    'loading',
    'cancelling refresh preserves the active import',
  );
  await queuedSnow.getByRole('button', { name: 'Cancel loading Snowdream', exact: true }).click();
  assert.equal(await queuedSnow.getAttribute('data-state'), 'missing');
  assert.equal(
    await queuedGari.getAttribute('data-state'),
    'loading',
    'cancelling a waiting map leaves the active import alone',
  );
  assert.deepEqual(await tileGeometry(), beforeLoading, 'cancellation does not reshape neighboring cards');
  await guest.getByRole('button', { name: 'Load Snowdream', exact: true }).click();
  await guest.evaluate(() => (window as any).releaseIsoImports());
  await queuedGari.locator('.public-iso-badge.loaded').waitFor();
  await queuedSnow.locator('.public-iso-badge.loaded').waitFor();
  await guest.getByText('2 loaded', { exact: true }).waitFor();
  assert.deepEqual(await tileGeometry(), beforeLoading, 'progress messages and completed imports preserve card layout');
  assert(
    (await originalGari!.evaluate(el => el.isConnected)) && (await originalSnow!.evaluate(el => el.isConnected)),
    'loading updates the same card elements',
  );
  assert.equal(
    await guest.evaluate(() => (window as any).isoCardReplacements),
    0,
    'progress updates never rebuild or reinsert the cards',
  );
  await guest.screenshot({ path: join(root, 'loaded-map-cards-mobile.png') });
  assert.equal(
    await guest.getByRole('progressbar').count(),
    0,
    'completed maps replace progress with their loaded state',
  );
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  await guest.getByRole('heading', { name: 'Maps', level: 1, exact: true }).waitFor();
  assert.equal(await leaveIso.count(), 0, 'completed imports do not block navigation');
  await guest.goto(`${origin}/isos`);
  await closeCommunity(guest);
  await guest.getByRole('button', { name: 'Unload Garibaldi', exact: true }).click();
  await guest.getByText('1 loaded', { exact: true }).waitFor();
  await guest.locator('#public-iso').setInputFiles(queueFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '2 maps found' }).waitFor();
  await guest.evaluate(`(() => {
    Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: () => new Promise(() => {}) });
  })()`);
  await guest.getByRole('button', { name: 'Load Garibaldi', exact: true }).click();
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  await leaveIso.getByRole('button', { name: 'Leave page', exact: true }).click();
  await guest.getByRole('heading', { name: 'Maps', level: 1, exact: true }).waitFor();
  assert.equal(new URL(guest.url()).pathname, '/maps', 'confirming leaves without a second browser prompt');
  await guest.goBack();
  await guest.getByText('1 loaded', { exact: true }).waitFor();
  assert(
    await guest.getByRole('button', { name: 'Unload Snowdream', exact: true }).isVisible(),
    'leaving an active import preserves previously completed maps',
  );
  assert.equal(
    await guest.locator('.public-iso-map[data-state="loading"], .public-iso-map[data-state="queued"]').count(),
    0,
    'leaving cancels active and queued ISO imports',
  );
  const snow = guest.locator('.public-iso-map[data-course="SNOW"]');
  assert.match(
    (await snow.getByRole('link', { name: 'Inspect Snowdream', exact: true }).getAttribute('href'))!,
    /\/editor\?reference=SNOW$/,
  );
  await snow.getByRole('link', { name: 'Play Snowdream', exact: true }).click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(guest.url()).pathname, '/play/Snowdream', 'ISO Play goes directly to the loaded map');
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  const lastMap = guest
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Snowdream', exact: true });
  await lastMap.waitFor();
  assert.equal(
    await lastMap.getAttribute('aria-current'),
    null,
    'the saved map does not replace the selected Maps tab',
  );
  await lastMap.click();
  await guest.getByRole('button', { name: 'Play', exact: true }).waitFor({ timeout: 90_000 });
  assert.equal(new URL(guest.url()).searchParams.get('reference'), 'SNOW', 'the header reopens the last ISO map');
  await guest.getByRole('link', { name: 'ISO', exact: true }).click();
  await joinChat(guest);
  await guest.getByRole('tab', { name: 'Chat', exact: true }).click();
  await guest.getByRole('button', { name: 'Leave chat', exact: true }).click();
  assert.equal(
    await guest.getByRole('tab', { name: 'Chat', exact: true }).count(),
    0,
    'only Users is available before joining',
  );
  await joinChat(guest, 'RenamedRider');
  await guest.getByRole('textbox', { name: 'Chat message' }).fill('Renamed from ISO');
  await guest.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await guest.getByText('Renamed from ISO', { exact: true }).waitFor();
  assert.match(await guest.getByText('Renamed from ISO', { exact: true }).locator('..').innerText(), /RenamedRider #/);
  await closeCommunity(guest);
  await guest.getByRole('link', { name: 'Maps', exact: true }).click();
  await openCommunity(guest);
  await guest.locator('.public-chat-status').filter({ hasText: 'Connected as RenamedRider' }).waitFor();
  assert(
    await guest.getByRole('button', { name: 'Leave chat', exact: true }).isVisible(),
    'closing the drawer and changing public pages preserves membership',
  );
  await guest.getByRole('tab', { name: /^Users/ }).click();
  for (const width of [320, 390, 768, 1280]) {
    await guest.setViewportSize({ width, height: 900 });
    const panel = await guest.locator('.public-community-panel').boundingBox();
    assert(
      panel && panel.x >= 0 && Math.abs(panel.x + panel.width - width) < 1 && panel.height > 800,
      'the shared drawer fits on the right at every screen size',
    );
    assert(
      await guest.evaluate(() => document.body.scrollWidth <= innerWidth),
      'the public header fits narrow screens',
    );
  }
  await guest.screenshot({ path: join(root, 'shared-community-users.png') });
  await closeCommunity(guest);
  assert.deepEqual(retailRequests, []);
  assert.deepEqual(errors, []);

  console.log(
    `PUBLIC HOME PASS: publishing, named links, compact player, anonymous multiplayer, opt-in chat, chat off/rejoin, mobile load errors, ISO management and queued imports. Screenshots: ${root}`,
  );
} catch (error) {
  await failurePage?.screenshot({ path: join(root, 'failure.png') });
  console.error('Public homepage failure artifacts:', root);
  if (failurePage)
    console.error(
      await failurePage
        .locator('.public-status')
        .textContent({ timeout: 1000 })
        .catch(() => ''),
    );
  throw error;
} finally {
  await browser?.close();
  await api.close();
  await vite.close();
}
