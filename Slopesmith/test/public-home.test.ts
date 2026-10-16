import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import { retailExtractOrigin } from '../src/core/export/origin';
import { addUser } from '../src/server/accounts/users';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { createFogVolume, particleVolumesToNative } from '../src/core/particles/volumes';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-public-home-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig(); forgetAccounts();
mkdirSync(join(root, 'Maps', 'FIXTURE'), { recursive: true });
writeFileSync(join(root, 'Maps', 'FIXTURE', 'Patches.json'), JSON.stringify({ Patches: [] }));
writeFileSync(join(root, 'Maps', 'FIXTURE', 'Origin.json'), JSON.stringify(retailExtractOrigin('FIXTURE')));
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
process.env.PORT = String(api.port);
const vite = await createServer({ root: process.cwd(), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } } });
let browser: Browser | undefined;
let failurePage: Page | undefined;
let adminCookie = '';
async function call(path: string, method = 'GET', body?: unknown, cookie = '') {
  return fetch(`${api.url}${path}`, { method, headers: { ...(cookie ? { cookie } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function checked(path: string, method = 'GET', body?: unknown, cookie = adminCookie): Promise<any> {
  const response = await call(path, method, body, cookie);
  assert(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
try {
  const bootstrap = await call('/api/auth/bootstrap', 'POST', { code: api.adminCode, username: 'admin', password: 'public home test password' });
  assert.equal(bootstrap.status, 201); adminCookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const mountain = defaultMountain(); mountain.name = 'PUBLIC_RUN';
  const created = await checked('/api/projects', 'POST', { document: mountain });
  const privateMap = await checked('/api/projects', 'POST', { name: 'PRIVATE_RUN', document: mountain });
  const id = created.project.id;
  assert.equal((await checked('/api/public/courses', 'GET', undefined, '')).courses.length, 0, 'publication defaults to private');
  await checked(`/api/publication?kind=project&id=${id}`, 'PUT', { published: true });
  await checked('/api/publication?kind=reference&id=FIXTURE', 'PUT', { published: true });
  const imported = defaultMountain(); imported.effects = createEmptyEffectsDocument('FIXTURE');
  imported.effects.source = { fileName: 'fixture.ssf' };
  const importedMap = await checked('/api/projects', 'POST', { name: 'IMPORTED_EFFECTS', document: imported });
  assert.equal((await call(`/api/publication?kind=project&id=${importedMap.project.id}`, 'PUT', { published: true }, adminCookie)).status, 403,
    'an imported retail graph cannot be streamed through a public mountain document');
  assert.equal((await call(`/api/public/project?id=${privateMap.project.id}`)).status, 404);
  assert.equal((await call('/api/level?name=FIXTURE')).status, 401, 'public retail metadata does not expose retail terrain');
  assert.equal((await call('/api/texture?level=FIXTURE&name=0000.png')).status, 401, 'retail art remains authenticated');
  await addUser({ username: 'viewer', password: 'viewer public home password', role: 'viewer', inviteHandle: 'test' });
  const viewer = await call('/api/auth/login', 'POST', { username: 'viewer', password: 'viewer public home password' });
  const viewerCookie = viewer.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call(`/api/publication?kind=project&id=${id}`, 'PUT', { published: false }, viewerCookie)).status, 403);
  assert.equal((await call('/api/public/guest', 'POST', { name: '' })).status, 400);
  assert.equal((await call('/api/public/guest', 'POST', { name: 'visitor' })).status, 200);
  const crossSite = await fetch(`${api.url}/api/public/guest`, { method: 'POST', headers: { origin: 'https://other.example',
    'content-type': 'application/json' }, body: JSON.stringify({ name: 'visitor' }) });
  assert.equal(crossSite.status, 403);
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const guest = await guestContext.newPage(); failurePage = guest;
  const errors: string[] = [], retailRequests: string[] = [], received: any[] = [], sent: any[] = [];
  guest.on('pageerror', error => errors.push(error.message));
  guest.on('request', request => {
    const url = new URL(request.url());
    if (['/api/level', '/api/particle-texture', '/api/board-audio', '/api/board-sound', '/api/announcer-audio',
      '/api/reference-music', '/api/reference-music-sample', '/api/environment-sound'].includes(url.pathname)
      || ['FIXTURE', 'GARI'].includes(url.searchParams.get('level') ?? '')) retailRequests.push(url.pathname);
  });
  guest.on('websocket', socket => {
    socket.on('framereceived', event => {
      try { received.push(JSON.parse(String(event.payload))); } catch { /* control frames */ }
    });
    socket.on('framesent', event => {
      try { sent.push(JSON.parse(String(event.payload))); } catch { /* control frames */ }
    });
  });
  await guest.goto(origin);
  await guest.getByRole('heading', { name: 'The mountain is open.' }).waitFor();
  await guest.getByRole('button', { name: /PUBLIC RUN/ }).waitFor();
  assert.equal(await guest.getByRole('button', { name: /PRIVATE RUN/ }).count(), 0);
  await guest.setViewportSize({ width: 390, height: 844 });
  assert(await guest.evaluate(() => document.querySelector('.public-home')!.getBoundingClientRect().right <= innerWidth));
  const mobileChat = await guest.locator('.sp-chat-docked').boundingBox();
  assert(mobileChat && mobileChat.height === 210 && mobileChat.width === 390, 'mobile chat docks below the course');
  await guest.setViewportSize({ width: 1440, height: 1000 });
  await guest.getByRole('link', { name: /Member sign in/ }).click();
  await guest.locator('.sp-login-card').waitFor();
  assert.equal(await guest.title(), 'Sign in · Slopesmith');
  await guest.goto(origin);
  await guest.getByLabel('Your rider name').fill('Ada');
  await guest.getByRole('button', { name: 'Join the lodge' }).click();
  await guest.getByText('Riding as Ada (guest)', { exact: true }).waitFor();
  await guest.getByRole('textbox', { name: 'Chat message' }).fill('<b>hello lodge</b>');
  await guest.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await guest.getByText('<b>hello lodge</b>', { exact: true }).waitFor();
  assert.equal(await guest.locator('.sp-chat-log b').count(), 0, 'chat stays plain text');
  const cookie = (await guestContext.cookies()).find(cookie => cookie.name === 'slopesmith_guest')!;
  assert(cookie.httpOnly && cookie.sameSite === 'Strict');
  assert.equal((await call('/api/projects', 'GET', undefined, `${cookie.name}=${cookie.value}`)).status, 401, 'guest cookie grants no editor access');
  const hostile = await guest.evaluate(async privateId => {
    const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/public/session`);
    const messages: any[] = [];
    return await new Promise<any[]>(resolve => {
      ws.onmessage = event => {
        const message = JSON.parse(event.data); messages.push(message);
        if (message.t === 'welcome') {
          ws.send(JSON.stringify({ t: 'watch', projectId: privateId }));
          ws.send(JSON.stringify({ t: 'assign', changes: [['g/name', 'HACKED']] }));
          ws.send(JSON.stringify({ t: 'fetch', sections: ['globals'] }));
        }
        if (messages.filter(message => message.t === 'error').length === 3) { ws.close(); resolve(messages); }
      };
      setTimeout(() => { ws.close(); resolve(messages); }, 5000);
    });
  }, privateMap.project.id);
  assert.equal(hostile.filter(message => message.t === 'error').length, 3);
  assert(!hostile.some(message => message.document || message.changes || message.t === 'joined'));
  assert(!JSON.stringify(hostile).includes('PRIVATE_RUN'), 'guest roster and history omit private editor state');

  await guest.getByRole('button', { name: /PUBLIC RUN/ }).click();
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  await guest.getByRole('button', { name: 'Ride', exact: true }).click();
  await guest.getByRole('button', { name: 'Stop riding' }).waitFor();
  const memberContext = await browser.newContext();
  await memberContext.addCookies([{ name: 'slopesmith_session', value: adminCookie.split('=')[1], url: origin }]);
  const member = await memberContext.newPage();
  await member.goto(`${origin}/?play`);
  await member.getByRole('button', { name: /PUBLIC RUN/ }).click();
  await member.getByRole('button', { name: 'Load course', exact: true }).click();
  await member.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  await member.getByRole('button', { name: 'Ride', exact: true }).click();
  await member.getByRole('textbox', { name: 'Chat message' }).fill('Member riding with guests');
  await member.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await guest.getByText('Member riding with guests', { exact: true }).waitFor();
  await guest.waitForFunction(() => document.querySelector('canvas') !== null);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert(received.some(message => message.t === 'awareness-batch' && message.peers.some((peer: any) => peer.username === 'admin' && peer.aware.player)),
    'member rider poses reach the guest on the same mountain');
  await guest.keyboard.press('Enter');
  await guest.getByRole('textbox', { name: 'Chat message' }).fill('Chat while riding');
  await guest.getByRole('textbox', { name: 'Chat message' }).press('Enter');
  await member.getByText('Chat while riding', { exact: true }).waitFor();
  assert(await guest.getByRole('button', { name: 'Stop riding' }).isVisible(), 'chat does not stop the ride');
  const chatBox = await guest.locator('.sp-chat-entry').boundingBox();
  assert(chatBox && chatBox.y > 800, 'chat input stays docked at the bottom of the right rail');
  await guest.screenshot({ path: join(root, 'guest-riding.png') });
  await memberContext.close();

  async function assertReferencePeers(level: string) {
    const context = await browser!.newContext();
    await context.addCookies([{ name: 'slopesmith_session', value: adminCookie.split('=')[1], url: origin }]);
    const member = await context.newPage();
    await member.goto(`${origin}/api`);
    const sample = [...sent].reverse().find(message => message.t === 'aware' && message.aware.player)?.aware.player;
    assert(sample, 'the public rider publishes a real pose');
    const before = received.length;
    await member.evaluate(async ({ projectId, pose, level }) => {
      const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/api/session?client=reference-editor`);
      await new Promise<void>(resolve => {
        ws.onmessage = event => {
          if (JSON.parse(event.data).t !== 'welcome') return;
          for (const message of [{ t: 'watch', projectId }, { t: 'reference', level }, { t: 'playing', playing: 'reference' }]) ws.send(JSON.stringify(message));
          setTimeout(() => {
            ws.send(JSON.stringify({ t: 'aware', aware: { player: { ...pose, sampleAt: Date.now() } } }));
            setTimeout(() => { ws.close(); resolve(); }, 300);
          }, 100);
        };
      });
    }, { projectId: privateMap.project.id, pose: sample, level });
    assert(received.slice(before).some(message => message.t === 'awareness-batch' && message.projectId === `@reference:${level}`
      && message.peers.some((peer: any) => peer.username === 'admin')), 'guest shares a reference world with a member editing a different project');
    assert(!JSON.stringify(received.slice(before)).includes('PRIVATE_RUN'), 'reference multiplayer reveals no private map name');
    await context.close();
  }

  // Generate an independent tiny ISO using Native's existing synthetic fixture, then test worker -> IDB -> renderer.
  const fixture = join(root, 'synthetic.iso');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); from import_test import iso,big,course_members; Path(sys.argv[2]).write_bytes(iso(big(course_members())))',
    resolve('../Native/tests'), fixture], { windowsHide: true });
  const localFixture = join(root, 'local-gari.iso');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', [
    'import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1])',
    'from import_test import iso,big,course_members,record',
    "archive=big({name.replace('fixture','gari'):data for name,data in course_members().items()})",
    'image=iso(archive)',
    "rows=record(b'\\0',26,2048,True)+record(b'\\1',26,2048,True)+record('GARI.BIG;1',28,len(archive))",
    'image[26*2048:27*2048]=rows+bytes(2048-len(rows))',
    'Path(sys.argv[2]).write_bytes(image)',
  ].join('\n'), resolve('../Native/tests'), localFixture], { windowsHide: true });
  const soundRepairFixture = join(root, 'sound-repair.iso');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', [
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
  ].join('\n'), resolve('../Native/tests'), soundRepairFixture], { windowsHide: true });

  // A local disc is sufficient: no GARI map or publication exists on this server.
  await guest.goto(origin);
  assert.equal(await guest.getByRole('button', { name: /Garibaldi/ }).count(), 0);
  await guest.locator('#public-iso').setInputFiles(localFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 course found' }).waitFor();
  const localCard = guest.getByRole('button', { name: /Garibaldi/ });
  await localCard.waitFor();
  assert.match(await localCard.innerText(), /FROM YOUR ISO/);
  await guest.getByText('No courses cached yet', { exact: true }).waitFor();
  assert.equal((await checked('/api/public/courses', 'GET', undefined, '')).courses.some((course: any) => course.id === 'GARI'), false);
  assert.equal((await call('/api/level?name=GARI')).status, 401, 'local ISO rooms grant no access to server map files');
  await guest.screenshot({ path: join(root, 'iso-discovered.png') });
  await localCard.click();
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  await guest.getByRole('button', { name: 'Ride', exact: true }).click();
  await guest.getByRole('button', { name: 'Stop riding' }).waitFor();
  assert(received.some(message => message.t === 'joined' && message.projectId === '@reference:GARI'), 'ISO-only riding joins the shared retail reference room');
  await assertReferencePeers('GARI');
  // The tiny disc has no SSF or fog models. Add independent canonical effect files to its local cache to
  // exercise the same cache -> shared reader -> live scene path used by a real extracted retail course.
  const fog = particleVolumesToNative([createFogVolume([0, 2, 0])]);
  await guest.evaluate(async text => {
    const files = JSON.parse(text) as Record<string, unknown>;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('slopesmith-local-disc', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('files', 'readwrite');
        for (const [path, data] of Object.entries(files)) transaction.objectStore('files').put({
          key: `GARI/${path.toLowerCase()}`, course: 'GARI', path, blob: new Blob([JSON.stringify(data)], { type: 'application/json' }),
        });
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  }, JSON.stringify({ 'Effects.json': createEmptyEffectsDocument('GARI'), 'ParticleInstances.json': fog.instances, 'ParticleModels.json': fog.models,
    'Audio/SoundIndex.json': { Schema: 'openslope-sound-index/v1', Level: 'GARI', Banks: { 2: 'tone', 3: 'crowd' }, CollisionEvents: {}, ResolverState: 'Deferred' } }));
  await guest.reload();
  await guest.evaluate(async () => {
    const moduleUrl = '/src/app/viewport/viewport.ts';
    const { Viewport } = await import(/* @vite-ignore */ moduleUrl);
    const setReference = Viewport.prototype.setReference;
    Viewport.prototype.setReference = function (...args: any[]) {
      (window as any).publicTestViewport = this;
      return setReference.apply(this, args);
    };
  });
  await guest.getByRole('button', { name: /Garibaldi/ }).waitFor();
  await guest.getByText('1 course cached on this device', { exact: true }).waitFor();
  await guest.getByRole('button', { name: /Garibaldi/ }).click();
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.locator('.public-status').filter({ hasText: 'Choose your ISO once more to restore collision sounds' }).waitFor();
  await guest.locator('#public-iso').setInputFiles(soundRepairFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 course found' }).waitFor();
  assert.deepEqual(await guest.evaluate(async () => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { readCachedCourse } = await import(/* @vite-ignore */ moduleUrl);
    const files = await readCachedCourse('GARI');
    const index = JSON.parse(await files.get('audio/soundindex.json')!.text());
    return { state: index.ResolverState, event: index.CollisionEvents['2'], fogKept: files.has('particleinstances.json') };
  }), { state: 'Resolved', event: { Group: 2, Slot: 13, Bank: 'tone', Clip: 'Audio/SFX/tone/013.wav' }, fogKept: true },
  'selecting the ISO repairs old audio metadata through Wasm without replacing cached course assets');
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  assert.deepEqual(await guest.evaluate(() => {
    const group = (window as any).publicTestViewport.scene.getObjectByName('Reference ambient particles');
    return { visible: group.visible, puffs: group.children[0]?.geometry.instanceCount };
  }), { visible: true, puffs: 9 }, 'local course fog is visible by default, with all nine puffs ready to draw');
  await guest.getByRole('button', { name: 'Ride', exact: true }).click();
  await guest.getByRole('button', { name: 'Stop riding' }).waitFor();
  assert(await guest.evaluate(() => (window as any).publicTestViewport.scene.getObjectByName('Reference ambient particles').visible),
    'local effects stay enabled while riding');
  await guest.reload();
  await guest.getByRole('list', { name: 'Cached courses' }).getByRole('listitem').filter({ hasText: 'Garibaldi' }).getByRole('button', { name: 'Unload', exact: true }).click();
  await guest.getByText('No courses cached yet', { exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: /Garibaldi/ }).count(), 0, 'per-course unload removes an ISO-only course until the ISO is selected again');
  await guest.locator('#public-iso').setInputFiles(localFixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 course found' }).waitFor();
  await guest.getByRole('button', { name: /Garibaldi/ }).click();
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  assert(await guest.evaluate(async () => {
    const moduleUrl = '/src/app/public/iso-cache.ts';
    const { readCachedCourse } = await import(/* @vite-ignore */ moduleUrl);
    const files = await readCachedCourse('GARI');
    return files.has('patches.json') && !files.has('particleinstances.json');
  }), 'reload extracts fresh course files without retaining the previously injected fog sidecars');
  await guest.reload();
  await guest.getByRole('button', { name: 'Clear local assets' }).click();
  await guest.getByText('No courses cached yet', { exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: /Garibaldi/ }).count(), 0, 'clearing cache removes courses without a selected ISO or publication');

  await guest.locator('#public-iso').setInputFiles({ name: 'invalid.iso', mimeType: 'application/octet-stream', buffer: Buffer.from('not a disc') });
  await guest.locator('.public-iso-status').filter({ hasText: /ISO|disc|read|format/i }).waitFor();
  await guest.waitForFunction(() => !(document.querySelector('#public-iso') as HTMLInputElement).disabled);
  assert.equal(await guest.getByRole('button', { name: /Garibaldi/ }).count(), 0, 'invalid discs produce no stale local cards');
  await guest.goto(origin);
  await guest.getByRole('button', { name: /FIXTURE/ }).click();
  await guest.locator('#public-iso').setInputFiles(fixture);
  await guest.locator('.public-iso-status').filter({ hasText: '1 course found' }).waitFor();
  assert.equal(await guest.getByRole('button', { name: /FIXTURE/ }).count(), 1, 'published reference and ISO discovery do not duplicate a course');
  await guest.getByText('No courses cached yet', { exact: true }).waitFor();
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  await guest.reload();
  await guest.getByText('1 course cached on this device', { exact: true }).waitFor();
  await guest.getByRole('button', { name: /FIXTURE/ }).click();
  await guest.getByRole('button', { name: 'Load course', exact: true }).click();
  await guest.getByRole('button', { name: 'Ride', exact: true }).waitFor({ timeout: 90_000 });
  await guest.getByRole('button', { name: 'Ride', exact: true }).click();
  await guest.getByRole('button', { name: 'Stop riding' }).waitFor();
  await assertReferencePeers('FIXTURE');
  assert.deepEqual(retailRequests, [], 'retail maps load entirely from local ISO data, including cache reload');
  assert.deepEqual(errors, []);
  await checked('/api/publication?kind=reference&id=FIXTURE', 'PUT', { published: false });
  assert.equal((await checked('/api/public/courses', 'GET', undefined, '')).courses.some((course: any) => course.id === 'FIXTURE'), false);
  console.log(`PUBLIC HOME PASS: publishing, guest isolation, desktop ride, member multiplayer/chat, local ISO and cache reload. Screenshots: ${root}`);
} catch (error) {
  await failurePage?.screenshot({ path: join(root, 'failure.png') });
  console.error('Public homepage failure artifacts:', root);
  if (failurePage) console.error(await failurePage.locator('.public-status').textContent().catch(() => ''));
  throw error;
} finally {
  await browser?.close(); await api.close(); await vite.close();
}
