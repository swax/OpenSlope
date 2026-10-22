import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { appRoot, cargo, run } from '../scripts/multiplayer.mjs';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import { retailExtractOrigin } from '../src/core/export/origin';
import { chromiumExecutable } from './browser-test-support';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-site-presence-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'maps');
process.env.SLOPESMITH_MULTIPLAYER_SECRET = 'site presence fixture secret with at least 32 bytes';
forgetWorkspaceConfig();
forgetAccounts();
const relayTarget = join(appRoot, 'multiplayer/target/site-presence');
await run(cargo, [
  'build',
  '--manifest-path',
  'multiplayer/Cargo.toml',
  '--locked',
  '--bin',
  'slopesmith-multiplayer',
  '--target-dir',
  relayTarget,
]);
const relay = spawn(
  join(relayTarget, 'debug', process.platform === 'win32' ? 'slopesmith-multiplayer.exe' : 'slopesmith-multiplayer'),
  [],
  {
    windowsHide: true,
    env: { ...process.env, SLOPESMITH_MULTIPLAYER_BIND: '127.0.0.1:0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
process.once('exit', () => relay.kill());
relay.stderr.on('data', chunk => process.stderr.write(chunk));
const address = await new Promise<string>((done, fail) => {
  let output = '';
  const timer = setTimeout(() => fail(new Error('Relay startup timed out.')), 10_000);
  relay.stdout.on('data', chunk => {
    output += String(chunk);
    const match = /listening on (127\.0\.0\.1:\d+)/.exec(output);
    if (match) {
      clearTimeout(timer);
      done(match[1]);
    }
  });
  relay.once('error', fail);
  relay.once('exit', code => {
    clearTimeout(timer);
    fail(new Error(`Relay exited (${code}).`));
  });
});
process.env.SLOPESMITH_MULTIPLAYER_URL = `http://${address}`;
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
process.env.PORT = String(api.port);
let browser: Browser | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let admin = '';
async function call(path: string, body?: unknown, cookie = admin, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${path}: ${await response.clone().text()}`);
  return response;
}
async function data(path: string, body?: unknown, cookie = admin, method?: string): Promise<any> {
  return (await call(path, body, cookie, method)).json();
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail(`Timed out: ${label}`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null)
    await new Promise<void>(done => {
      child.once('exit', () => done());
      child.kill();
    });
}
const frames = new Map<Page, any[]>();
async function page(context: Awaited<ReturnType<Browser['newContext']>>) {
  const result = await context.newPage();
  frames.set(result, []);
  await result.addInitScript('window.__name = value => value;');
  result.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/play/session') return;
    socket.on('framereceived', frame => {
      try {
        frames.get(result)!.push(JSON.parse(String(frame.payload)));
      } catch {
        /* control frame */
      }
    });
  });
  return result;
}
try {
  const enrolled = await call(
    '/api/auth/bootstrap',
    { code: api.adminCode, username: 'admin', password: 'a site presence fixture password' },
    '',
  );
  admin = enrolled.headers.get('set-cookie')!.split(';')[0];
  const publicMap = (await data('/api/projects', { document: { ...defaultMountain(), name: 'PUBLIC_PEAK' } })).project;
  const privateMap = (await data('/api/projects', { document: { ...defaultMountain(), name: 'PRIVATE_PEAK' } }))
    .project;
  await data(`/api/publication?kind=project&id=${publicMap.id}`, { published: true }, admin, 'PUT');
  mkdirSync(join(root, 'maps', 'FIXTURE'), { recursive: true });
  writeFileSync(join(root, 'maps', 'FIXTURE', 'Patches.json'), JSON.stringify({ Patches: [] }));
  writeFileSync(join(root, 'maps', 'FIXTURE', 'Origin.json'), JSON.stringify(retailExtractOrigin('FIXTURE')));
  await data('/api/publication?kind=reference&id=FIXTURE', { published: true }, admin, 'PUT');
  assert.equal(
    (await data('/api/public/activity', undefined, '')).online,
    0,
    'HTTP visits and account records do not inflate Rust online presence',
  );
  assert.equal(
    (await fetch(`http://${address}/site`)).status,
    403,
    'the unfiltered internal snapshot requires the service secret',
  );
  vite = await createServer({
    root: appRoot,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: {
        '/api/play/session': { target: `http://${address}`, ws: true },
        '/api': { target: api.url, ws: true },
      },
    },
  });
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0];
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const firstContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const first = await page(firstContext);
  await first.goto(`${origin}maps`);
  await first.locator('.public-online[data-count="1"]').waitFor();
  await first
    .getByRole('article', { name: 'PUBLIC PEAK', exact: true })
    .locator('.public-map-online[data-count="0"]')
    .waitFor({ state: 'attached' });
  assert(
    await first.getByRole('article', { name: 'PUBLIC PEAK', exact: true }).locator('.public-map-online').isHidden(),
    'empty map counters stay hidden',
  );
  assert(
    frames.get(first)!.some(message => message.t === 'site-activity' && message.online === 1),
    'browsing receives small count updates without subscribing to the full roster',
  );
  const snapshotResponse = await fetch(`http://${address}/site`, {
    headers: { authorization: `Bearer ${process.env.SLOPESMITH_MULTIPLAYER_SECRET}` },
  });
  assert.equal(
    snapshotResponse.headers.get('connection'),
    'close',
    'bounded relay HTTP connections must not be reused by pooled clients',
  );
  const snapshot = (await snapshotResponse.json()) as any;
  assert(snapshot.members[0].member.anonymous);
  assert.match(snapshot.members[0].member.username, /^guest[1-9]\d?$/);
  const firstId = snapshot.members[0].member.id;
  const duplicate = await page(firstContext);
  await duplicate.goto(`${origin}isos`);
  await duplicate.locator('.public-online[data-count="1"]').waitFor();
  await duplicate.close();
  await first.locator('.public-online[data-count="1"]').waitFor();
  assert.equal(
    (await data('/api/public/activity')).online,
    1,
    'a second tab with the same visitor cookie is not a second player',
  );
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const second = await page(secondContext);
  await second.goto(`${origin}isos`);
  await first.locator('.public-online[data-count="2"]').waitFor();
  assert.equal((await data('/api/public/activity')).courses[publicMap.id] ?? 0, 0);
  await first.getByRole('button', { name: 'Play PUBLIC PEAK', exact: true }).click();
  await until(
    async () => (await data('/api/public/activity')).courses[publicMap.id] === 1,
    'opening Play counts the map before chatting or riding',
  );
  await first.locator('body.public-ready').waitFor({ timeout: 30_000 });
  await first.getByRole('button', { name: 'Online users', exact: true }).click();
  await first.getByRole('tab', { name: 'Users (2)', exact: true }).click();
  await first.locator('.sp-chat-users').getByRole('link', { name: 'PUBLIC_PEAK', exact: true }).waitFor();
  assert(
    (await first
      .locator('.sp-chat-users')
      .getByText(/^guest[1-9]\d? #[A-F0-9]{4}$/)
      .count()) >= 2,
    'anonymous visitors appear in the member list without joining chat',
  );
  assert.equal(await first.getByRole('textbox', { name: 'Chat message' }).isVisible(), false);
  await second.goto(`${origin}play/PUBLIC_PEAK`);
  await second.locator('body.public-ready').waitFor({ timeout: 30_000 });
  await until(
    async () => (await data('/api/public/activity')).courses[publicMap.id] === 2,
    'both anonymous map visitors count before a ride begins',
  );
  await until(
    () => frames.get(first)!.some(message => message.t === 'poses' && message.peers.length > 0),
    'anonymous visitors receive other anonymous positions',
  );
  await until(
    async () => (await first.getByText('Same play room', { exact: true }).count()) === 2,
    'the roster marks both confirmed participants in the same play room',
  );
  assert.equal(await first.getByText('Server map', { exact: true }).count(), 2);
  await second.goto(`${origin}play/PUBLIC_PEAK?room=fixture-friends`);
  await second.locator('body.public-ready').waitFor({ timeout: 30_000 });
  await first.getByText('Different play room', { exact: true }).waitFor();
  assert.equal(await first.getByText('Same play room', { exact: true }).count(), 1);
  const inviteLink = first.locator('.sp-chat-user-map').filter({ hasText: 'Different play room' }).getByRole('link');
  assert.equal(
    new URL((await inviteLink.getAttribute('href'))!, origin).searchParams.get('room'),
    'fixture-friends',
    'map links preserve the listed play room',
  );
  const anotherRoom = await page(secondContext);
  await anotherRoom.goto(`${origin}play/PUBLIC_PEAK`);
  await anotherRoom.locator('body.public-ready').waitFor({ timeout: 30_000 });
  await until(
    async () => (await first.getByText('Same play room', { exact: true }).count()) === 2,
    'one visitor can be listed in both a shared and a separate room',
  );
  assert.equal(await first.getByText('Different play room', { exact: true }).count(), 1);
  assert.equal(
    (await data('/api/public/activity')).courses[publicMap.id],
    2,
    'two rooms in two tabs do not double-count a visitor on the map',
  );
  await anotherRoom.close();
  await second.goto(`${origin}play/PUBLIC_PEAK`);
  await second.locator('body.public-ready').waitFor({ timeout: 30_000 });
  await until(
    async () => (await first.getByText('Same play room', { exact: true }).count()) === 2,
    'returning to the default room updates the badge',
  );

  // Source is independent of the room key, including two tabs with the same course ID.
  const sourceContext = await browser.newContext();
  const isoSource = await page(sourceContext);
  await isoSource.goto(`${origin}maps`);
  await isoSource.locator('.public-online').waitFor();
  await isoSource.evaluate(async () => {
    const moduleUrl = '/src/app/net/site-presence.ts';
    const { setSiteCourse } = await import(/* @vite-ignore */ moduleUrl);
    setSiteCourse('@reference:GARI', 'iso');
  });
  await first
    .locator('.sp-chat-user-map')
    .filter({ hasText: 'ISO' })
    .getByRole('link', { name: 'Garibaldi', exact: true })
    .waitFor();
  const isoLink = first.locator('.sp-chat-user-map').filter({ hasText: 'ISO' }).getByRole('link');
  assert.equal(new URL((await isoLink.getAttribute('href'))!, origin).searchParams.get('source'), 'iso');
  const serverSource = await page(sourceContext);
  await serverSource.goto(`${origin}maps`);
  await serverSource.locator('.public-online').waitFor();
  await serverSource.evaluate(async () => {
    const moduleUrl = '/src/app/net/site-presence.ts';
    const { setSiteCourse } = await import(/* @vite-ignore */ moduleUrl);
    setSiteCourse('@reference:GARI', 'server');
  });
  await first
    .locator('.sp-chat-user-map')
    .filter({ hasText: 'Server map' })
    .getByRole('link', { name: 'Garibaldi', exact: true })
    .waitFor();
  assert.equal((await data('/api/public/activity')).courses['@reference:GARI'], 1);
  assert.equal(
    await first.getByRole('link', { name: 'Garibaldi', exact: true }).count(),
    2,
    'ISO and server sources stay distinct without splitting or inflating the course count',
  );
  const importedSource = await page(sourceContext);
  await importedSource.goto(`${origin}maps`);
  await importedSource.locator('.public-online').waitFor();
  await importedSource.evaluate(async () => {
    const moduleUrl = '/src/app/net/site-presence.ts';
    const { setSiteCourse } = await import(/* @vite-ignore */ moduleUrl);
    setSiteCourse('@reference:FIXTURE', 'iso');
  });
  await first
    .locator('.sp-chat-user-map')
    .filter({ hasText: 'ISO' })
    .getByRole('link', { name: 'FIXTURE', exact: true })
    .waitFor();
  assert.equal(
    (await data('/api/public/activity')).courses['@reference:FIXTURE'],
    1,
    'published imported ISO slots outside the built-in list retain source metadata',
  );
  await first.setViewportSize({ width: 320, height: 700 });
  assert(
    await first.evaluate(() => document.body.scrollWidth <= innerWidth),
    'source and room badges fit narrow phones',
  );
  mkdirSync(resolve('temp'), { recursive: true });
  await first.screenshot({ path: resolve('temp/site-presence-source-mobile.png') });
  await first.setViewportSize({ width: 1280, height: 900 });
  await sourceContext.close();
  await first.locator('.public-online[data-count="2"]').waitFor();
  const editorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await editorContext.addCookies([{ name: 'slopesmith_session', value: admin.split('=')[1], url: origin }]);
  const editor = await page(editorContext);
  await editor.goto(`${origin}editor/PRIVATE_PEAK?project=${privateMap.id}`);
  await editor.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await until(
    async () => (await data('/api/public/activity')).courses[privateMap.id] === 1,
    'an open editor map counts without Test or Play',
  );
  await first.locator('.public-online[data-count="3"]').waitFor();
  const anonymousSnapshot = await data('/api/public/activity', undefined, '');
  assert(!Object.hasOwn(anonymousSnapshot.courses, privateMap.id), 'anonymous counters do not expose private map IDs');
  const roster = await data('/api/members');
  assert(
    roster.members.some(
      (member: any) =>
        member.id === firstId &&
        member.online &&
        member.anonymous &&
        member.maps.some((map: any) => map.id === publicMap.id),
    ),
    'the editor roster includes anonymous map visitors and their map',
  );
  await second.goto(`${origin}maps`);
  await second
    .getByRole('article', { name: 'PUBLIC PEAK', exact: true })
    .locator('.public-map-online[data-count="1"]')
    .waitFor();
  assert.equal(
    (await data('/api/public/activity')).online,
    3,
    'returning to Maps removes map membership but keeps the visitor online',
  );
  await first.locator('.public-chat-join input[name="name"]').fill('NamedRider');
  await first.locator('.public-chat-join button').click();
  await first.getByRole('textbox', { name: 'Chat message' }).waitFor();
  await until(
    async () =>
      (await data('/api/members')).members.some(
        (member: any) => member.id === firstId && !member.anonymous && member.username === 'NamedRider (guest)',
      ),
    'joining chat publishes the chosen nickname without changing visitor identity',
  );
  await first.getByRole('button', { name: 'Leave chat', exact: true }).click();
  await until(
    async () => (await data('/api/members')).members.some((member: any) => member.id === firstId && member.anonymous),
    'leaving chat restores the anonymous label',
  );
  assert.equal((await data('/api/public/activity')).courses[publicMap.id], 1, 'leaving chat keeps map membership');
  await first.getByRole('tab', { name: 'Users (3)', exact: true }).click();
  assert((await data('/api/members')).members.some((member: any) => member.id === firstId && member.anonymous));
  for (const width of [390, 768, 1280]) {
    await second.setViewportSize({ width, height: 900 });
    const box = await second.locator('.public-online').boundingBox();
    assert(box && box.x >= 0 && box.x + box.width <= width, `online count fits the ${width}px header`);
  }
  mkdirSync(resolve('temp'), { recursive: true });
  await second.screenshot({ path: resolve('temp/site-presence-maps.png') });
  await first.screenshot({ path: resolve('temp/site-presence-users.png') });
  await firstContext.close();
  await second.locator('.public-online[data-count="2"]').waitFor();
  await until(
    async () => (await data('/api/public/activity')).courses[publicMap.id] === undefined,
    'closing the last tab removes map membership',
  );
  assert(
    !(await data('/api/members')).members.some((member: any) => member.id === firstId),
    'anonymous users disappear instead of becoming offline accounts',
  );
  await editorContext.close();
  await second.locator('.public-online[data-count="1"]').waitFor();
  const localContext = await browser.newContext();
  const localEditor = await page(localContext);
  const localTickets: string[] = [];
  localEditor.on('request', request => {
    if (new URL(request.url()).pathname === '/api/play/ticket') localTickets.push(request.postDataJSON().courseId);
  });
  await localEditor.goto(`${origin}editor?local=new`);
  await localEditor.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
  await second.locator('.public-online[data-count="2"]').waitFor();
  assert(
    !localTickets.some(id => id.startsWith('local-')),
    'browser-only maps never replace valid site admission with an unknown server room',
  );
  assert.deepEqual(
    (await data('/api/public/activity')).courses,
    {},
    'browser-only maps do not advertise server map attendance',
  );
  await localContext.close();
  await second.locator('.public-online[data-count="1"]').waitFor();
  console.log(
    'SITE PRESENCE PASS: Rust visitors, stable guests, unique counts, ISO/server sources, shared and separate rooms, room links, imported slots, editor and Play attendance, anonymous poses, private-map filtering, chat independence and responsive lists.',
  );
} finally {
  await browser?.close();
  await vite?.close();
  await api.close();
  await stop(relay);
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert(basename(root).startsWith('slopesmith-site-presence-'));
  rmSync(root, { recursive: true, force: true });
}
