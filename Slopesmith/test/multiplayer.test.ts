import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'vite';
import { chromium, type Browser } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetAccounts } from '../src/server/accounts/store';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { defaultMountain } from '../src/core/doc/mountain';
import { liveSessions } from '../src/server/session/presence';
import { DOCUMENT_VERSION, CORE_VERSION } from '../src/core/session/protocol';
import { validatePlayClientMessage, validatePlayServerMessage } from '../src/core/session/play-validators.generated.js';
import { appRoot, cargo, run } from '../scripts/multiplayer.mjs';
import { playSocket } from './play-socket';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-multiplayer-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'maps');
process.env.SLOPESMITH_MULTIPLAYER_SECRET = randomBytes(32).toString('base64url');
forgetAccounts();
forgetWorkspaceConfig();
await run(cargo, ['build', '--manifest-path', 'multiplayer/Cargo.toml', '--locked', '--bin', 'slopesmith-multiplayer']);
const binary = join(
  appRoot,
  'multiplayer',
  'target',
  'debug',
  `slopesmith-multiplayer${process.platform === 'win32' ? '.exe' : ''}`,
);
async function startRelay(bind = '127.0.0.1:0') {
  const child = spawn(binary, [], {
    windowsHide: true,
    env: { ...process.env, SLOPESMITH_MULTIPLAYER_BIND: bind },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const address = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Relay startup timed out.')), 10_000);
    child.stdout.on('data', data => {
      output += String(data);
      const match = /listening on (127\.0\.0\.1:\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Relay exited (${code}): ${output}`));
    });
    child.stderr.on('data', data => {
      output += String(data);
    });
  });
  return { child, address };
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(done => {
    child.once('exit', () => done());
    child.kill();
  });
}
let relay = await startRelay();
process.once('exit', () => {
  relay.child.kill();
});
process.env.SLOPESMITH_MULTIPLAYER_URL = `http://${relay.address}`;
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const sockets: Awaited<ReturnType<typeof playSocket>>[] = [];
let browser: Browser | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
let admin = '';
async function call(path: string, body?: unknown, cookie = '', method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${api.url}${path}`, {
    method,
    headers: {
      origin: api.url,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function checked(path: string, body?: unknown, cookie = admin, method?: string): Promise<any> {
  const response = await call(path, body, cookie, method);
  assert(response.ok, `${path}: ${await response.clone().text()}`);
  return response.json();
}
try {
  const bootstrap = await call('/api/auth/bootstrap', {
    code: api.adminCode,
    username: 'admin',
    password: 'multiplayer fixture password',
  });
  assert.equal(bootstrap.status, 201);
  admin = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const created = await checked('/api/projects', { document: defaultMountain() });
  const courseId = created.project.id;
  const privateMap = await checked('/api/projects', { name: 'PRIVATE', document: defaultMountain() });
  await checked(`/api/publication?kind=project&id=${courseId}`, { published: true }, admin, 'PUT');
  const guest = await call('/api/public/guest', { name: 'Ada' });
  const cookie = guest.headers.get('set-cookie')!.split(';')[0];
  const request = { courseId, roomId: 'friends', clientId: 'guest-one', deviceLabel: 'test', publicPlay: true };
  assert.equal((await call('/api/play/ticket', { ...request, courseId: privateMap.project.id }, cookie)).status, 403);
  assert.equal((await call('/api/play/ticket', { ...request, roomId: '../private' }, cookie)).status, 403);
  const ticket = await checked('/api/play/ticket', request, cookie);
  const first = await playSocket(`ws://${relay.address}/api/play/session`, { origin: api.url, compressed: true });
  sockets.push(first);
  first.send({ t: 'hello', protocol: 1, ticket: ticket.ticket });
  const welcome = await first.expect(m => m.t === 'welcome');
  assert(first.compressed, 'permessage-deflate is negotiated');
  assert(validatePlayServerMessage(welcome), 'the welcome conforms to the generated schema');
  assert(welcome.t === 'welcome');
  const secondTicket = await checked('/api/play/ticket', { ...request, clientId: 'guest-two' }, cookie);
  const second = await playSocket(`ws://${relay.address}/api/play/session`, { origin: api.url });
  sockets.push(second);
  second.send({ t: 'hello', protocol: 1, ticket: secondTicket.ticket });
  await second.expect(m => m.t === 'welcome');
  const renewedTicket = await checked(
    '/api/play/ticket',
    { ...request, deviceLabel: 'renewed device', previousTicket: ticket.ticket },
    cookie,
  );
  first.send({ t: 'renew', ticket: renewedTicket.ticket });
  await second.expect(
    m =>
      m.t === 'presence' &&
      m.peers.some((peer: any) => peer.sessionId === welcome.sessionId && peer.deviceLabel === 'renewed device'),
  );
  const otherTicket = await checked(
    '/api/play/ticket',
    { ...request, roomId: 'another-room', clientId: 'guest-three' },
    cookie,
  );
  const other = await playSocket(`ws://${relay.address}/api/play/session`, { origin: api.url });
  sockets.push(other);
  other.send({ t: 'hello', protocol: 1, ticket: otherTicket.ticket });
  await other.expect(m => m.t === 'welcome');
  assert.equal(liveSessions().length, 0, 'guests occupy no editor sessions or player seats');
  const editor = await playSocket(`${api.url.replace('http', 'ws')}/api/session?client=editor`, {
    origin: api.url,
    cookie: admin,
  });
  sockets.push(editor);
  await editor.expect(m => m.t === 'welcome');
  editor.send({ t: 'watch', projectId: courseId, doc: DOCUMENT_VERSION, core: CORE_VERSION });
  await editor.expect(m => m.t === 'joined');
  const pose = {
    version: 2 as const,
    seq: 1,
    sampleAt: Date.now(),
    teleport: 0,
    mode: 'edit',
    vr: false,
    avatar: 'procedural',
    body: { p: [1, 2, 3], q: [0, 0, 0, 2] },
    velocity: [0, 0, 0],
  };
  assert(validatePlayClientMessage({ t: 'pose', player: pose }));
  assert(!validatePlayClientMessage({ t: 'pose', player: { ...pose, seq: -1 } }));
  for (let i = 1; i <= 100; i++)
    first.send({ t: 'pose', player: { ...pose, seq: i, body: { ...pose.body, p: [i, 2, 3] } } });
  editor.send({ t: 'assign', changes: [['g/aiSeed', 1234]], batch: 1 });
  await editor.expect(m => m.t === 'landed' && m.batch === 1);
  const batch = await second.expect(m => m.t === 'poses' && m.peers.some((p: any) => p.player.seq === 100));
  assert.deepEqual(batch.peers[0].player.body.q, [0, 0, 0, 1]);
  assert(validatePlayServerMessage(batch), 'Rust output conforms to the generated runtime schema');
  assert(!other.seen.some(m => m.t === 'poses' && m.peers.length), 'poses stay within the friends room');
  first.send({ t: 'pose', player: null });
  await second.expect(m => m.t === 'poses' && m.peers.length === 0);
  assert(!first.closed, 'clearing a pose keeps the room connection alive');
  const event = {
    target: { kind: 'authored' },
    mode: 'freeride',
    kind: 'trigger',
    key: 'gate',
    id: 1,
    riderSpeed: 10,
    sentAt: Date.now(),
  };
  first.send({ t: 'ride-event', event });
  first.send({ t: 'ride-event', event });
  await second.expect(m => m.t === 'ride-event');
  first.send({ t: 'chat', text: '<b>hello</b>' });
  first.send({ t: 'ping', at: Date.now() });
  await first.expect(m => m.t === 'pong');
  assert(!second.seen.some(m => m.t === 'chat'), 'Rust cannot bypass server-wide chat moderation');
  assert.equal(second.seen.filter(m => m.t === 'ride-event').length, 1, 'one-shots are deduplicated');
  assert(!editor.seen.some(m => m.t === 'ride-event'), 'play interactions never enter the editor socket');
  assert(!other.seen.some(m => m.t === 'chat'), 'movement rooms do not relay chat');
  const reused = await playSocket(`ws://${relay.address}/api/play/session`, { origin: api.url });
  sockets.push(reused);
  reused.send({ t: 'hello', protocol: 1, ticket: ticket.ticket });
  await reused.expect(m => m.t === 'closed');
  assert(!reused.seen.some(m => m.t === 'welcome'), 'admission tickets cannot be replayed');

  if (process.env.SLOPESMITH_MULTIPLAYER_LOAD === '1') {
    // Client generation/parsing runs in another process so the benchmark does not load Node's editor loop itself.
    const load = spawn(process.execPath, ['--import', 'tsx', 'scripts/multiplayer-load.ts'], {
      cwd: appRoot,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        SLOPESMITH_LOAD_API: api.url,
        SLOPESMITH_LOAD_COURSE: courseId,
        SLOPESMITH_LOAD_COOKIE: cookie,
        SLOPESMITH_LOAD_SOCKET: `ws://${relay.address}/api/play/session`,
      },
    });
    let batchId = 1000;
    try {
      await new Promise<void>((resolve, reject) => {
        load.once('error', reject);
        load.once('exit', code => (code === 0 ? resolve() : reject(new Error(`Load generator exited ${code}`))));
        load.on('message', raw => {
          void (async () => {
            const players = (raw as { players: number }).players;
            const latencies: number[] = [];
            for (let i = 0; i < 30; i++) {
              const batch = batchId++,
                at = performance.now();
              editor.send({ t: 'assign', changes: [['g/aiSeed', batch]], batch });
              await editor.expect(message => message.t === 'landed' && message.batch === batch);
              latencies.push(performance.now() - at);
              await new Promise(done => setTimeout(done, 30));
            }
            latencies.sort((a, b) => a - b);
            console.log(
              `Editor acknowledgement under ${players} moving riders (four rooms): median=${latencies[15].toFixed(1)}ms p95=${latencies[28].toFixed(1)}ms max=${latencies[29].toFixed(1)}ms`,
            );
            load.send({ next: true });
          })().catch(reject);
        });
      });
    } finally {
      await stop(load);
    }
  }

  // Exercise the actual browser adapter through a proxy, without starting a WebGL scene.
  process.env.PORT = String(api.port);
  vite = await createServer({
    root: appRoot,
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: {
        '/api/play/session': { target: process.env.SLOPESMITH_MULTIPLAYER_URL, ws: true },
        '/api': { target: api.url, ws: true },
      },
    },
  });
  await vite.listen();
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  let publicRelayWelcomes = 0;
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/play/session') return;
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.t === 'welcome' && message.roomId !== 'site') publicRelayWelcomes++;
      } catch {
        /* binary/non-JSON frame */
      }
    });
  });
  page.on('pageerror', error => console.log(`browser error: ${error.message}`));
  page.on('response', response => {
    if (response.url().includes('/api/play/') && response.status() >= 400)
      console.log(`play HTTP ${response.status()} ${new URL(response.url()).pathname}`);
  });
  await page.addInitScript('window.__name = value => value;');
  await page.goto(vite.resolvedUrls!.local[0]);
  await page.evaluate(
    async ({ courseId }) => {
      const presenceModulePath = '/src/app/net/site-presence.ts';
      const { ensureVisitor } = await import(presenceModulePath);
      await ensureVisitor();
      await fetch('/api/public/guest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'BrowserRider' }),
      });
      const modulePath = '/src/app/net/session-channel.ts';
      const { createSessionChannel } = await import(modulePath);
      const state = window as any;
      state.playFrames = [];
      state.channel = createSessionChannel({
        publicPlay: true,
        clientId: 'browser-guest',
        url: () => `${location.origin.replace('http', 'ws')}/api/public/session`,
        onWelcome: (m: any) => state.playFrames.push(m),
        onPresence: (m: any) => (state.presence = m),
        onAware: (m: any) => (state.latestPeer = m),
        onAccessChanged: (reason: string) => (state.accessChanged = reason),
      });
      state.channel.watch(courseId);
      state.channel.start();
    },
    { courseId },
  );
  await page.waitForFunction(() => (window as any).playFrames.length > 0, undefined, { timeout: 10_000 });
  assert.equal(liveSessions().length, 2, 'public riders open a restricted community socket alongside the editor');
  await page.evaluate(() => (window as any).channel.say('Hello from public play'));
  await editor.expect(m => m.t === 'chat' && m.line.text === 'Hello from public play');
  const editorContext = await browser.newContext();
  await editorContext.addCookies([
    { name: 'slopesmith_session', value: admin.slice(admin.indexOf('=') + 1), url: vite.resolvedUrls!.local[0] },
  ]);
  const editorPage = await editorContext.newPage();
  const editorSent: any[] = [];
  editorPage.on('websocket', socket => {
    const address = new URL(socket.url());
    if (address.pathname !== '/api/session' || address.searchParams.get('client') !== 'browser-editor') return;
    socket.on('framesent', frame => editorSent.push(JSON.parse(String(frame.payload))));
  });
  await editorPage.addInitScript('window.__name = value => value;');
  await editorPage.goto(vite.resolvedUrls!.local[0]);
  await editorPage.evaluate(
    async ({ courseId }) => {
      const modulePath = '/src/app/net/session-channel.ts';
      const { createSessionChannel } = await import(modulePath);
      const state = window as any;
      state.editorFrames = [];
      state.editorPeers = [];
      state.editorChannel = createSessionChannel({
        clientId: 'browser-editor',
        url: () => `${location.origin.replace('http', 'ws')}/api/session?client=browser-editor`,
        onWelcome: (m: any) => state.editorFrames.push(m),
        onAware: (m: any) => state.editorPeers.push(m),
        onLanded: (m: any) => (state.editorAck = m),
      });
      state.editorChannel.watch(courseId);
      state.editorChannel.start();
    },
    { courseId },
  );
  await editorPage.waitForFunction(() => (window as any).editorFrames.length > 0);
  await page.evaluate(
    ({ pose }) => {
      (window as any).channel.aware({ player: pose });
    },
    { pose },
  );
  await editorPage.waitForFunction(() => (window as any).editorPeers.some((peer: any) => peer.aware.player?.seq === 1));
  await editorPage.evaluate(() => {
    const state = window as any;
    state.guestId = state.editorPeers.find((peer: any) => peer.aware.player?.seq === 1).sessionId;
  });
  await page.evaluate(() => (window as any).channel.aware({ player: null }));
  await editorPage.waitForFunction(() => {
    const state = window as any;
    return state.editorPeers.some((peer: any) => peer.sessionId === state.guestId && peer.aware.player === null);
  });
  await editorPage.evaluate(
    ({ pose }) => {
      for (let seq = 1; seq <= 40; seq++)
        (window as any).editorChannel.aware({
          cursor: null,
          vertices: ['v/example'],
          quads: [],
          dragging: [],
          player: { ...pose, seq },
        });
    },
    { pose },
  );
  await page.waitForFunction(() => (window as any).latestPeer?.aware.player?.seq === 40);
  assert.equal(
    editorSent.filter(message => message.t === 'aware').length,
    1,
    'movement sends no repeated editor awareness',
  );
  assert.deepEqual(editorSent.find(message => message.t === 'aware').aware.vertices, ['v/example']);
  assert.equal(editorSent.find(message => message.t === 'aware').aware.player, null);
  await editorPage.evaluate(() => (window as any).editorChannel.assign([['g/aiSeed', 2222]], 99));
  await editorPage.waitForFunction(() => (window as any).editorAck?.batch === 99);
  const originalAddress = relay.address;
  await stop(relay.child);
  relay = await startRelay(originalAddress);
  const reconnectDeadline = Date.now() + 15_000;
  while (publicRelayWelcomes < 2 && Date.now() < reconnectDeadline) await new Promise(done => setTimeout(done, 50));
  assert(publicRelayWelcomes >= 2, 'public movement reconnects while its community socket stays open');
  assert.equal(
    await page.evaluate(() => (window as any).playFrames.length),
    1,
    'relay reconnects preserve chat and presence',
  );
  await editorPage.evaluate(() => (window as any).editorChannel.assign([['g/aiSeed', 3333]], 100));
  await editorPage.waitForFunction(() => (window as any).editorAck?.batch === 100);
  await checked(`/api/publication?kind=project&id=${courseId}`, { published: false }, admin, 'PUT');
  await page.waitForFunction(() => !!(window as any).accessChanged);
  assert(!editor.closed, 'unpublishing play does not disconnect the editor');
  await stop(relay.child);
  editor.send({ t: 'assign', changes: [['g/aiSeed', 5678]], batch: 2 });
  await editor.expect(m => m.t === 'landed' && m.batch === 2);
  relay = await startRelay(relay.address);
  editor.send({ t: 'assign', changes: [['g/aiSeed', 9012]], batch: 3 });
  await editor.expect(m => m.t === 'landed' && m.batch === 3);
  console.log(
    'Multiplayer: guest admission, contracts, compression, room isolation, browser transport, and editor independence PASS',
  );
} finally {
  for (const socket of sockets) socket.close();
  await browser?.close();
  await vite?.close();
  await api.close();
  await stop(relay.child);
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert(basename(root).startsWith('slopesmith-multiplayer-'));
  rmSync(root, { recursive: true, force: true });
}
