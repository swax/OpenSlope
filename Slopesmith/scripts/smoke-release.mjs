import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { playSocket } from '../test/play-socket.ts';

const root = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
const fixture = await mkdtemp(join(tmpdir(), 'slopesmith-packaged-smoke-'));
const helpWorkspace = join(fixture, 'help-must-not-create');
execFileSync(join(root, 'runtime/bin/node'), [join(root, 'dist-server/main.js'), 'help'], {
  env: {
    ...process.env,
    SLOPESMITH_APP_ROOT: root,
    SLOPESMITH_WORKSPACE_ROOT: helpWorkspace,
    SLOPESMITH_MAPS_ROOT: join(helpWorkspace, 'maps'),
  },
  stdio: 'pipe',
});
assert(!existsSync(helpWorkspace), 'Packaged CLI help must not initialize workspace state.');
await mkdir(join(fixture, 'maps'));
Object.assign(process.env, {
  SLOPESMITH_APP_ROOT: root,
  SLOPESMITH_WORKSPACE_ROOT: join(fixture, 'workspace'),
  SLOPESMITH_MAPS_ROOT: join(fixture, 'maps'),
  SLOPESMITH_MULTIPLAYER_SECRET: randomBytes(48).toString('base64url'),
});
const relay = spawn(join(root, 'multiplayer', 'slopesmith-multiplayer'), [], {
  env: { ...process.env, SLOPESMITH_MULTIPLAYER_BIND: '127.0.0.1:0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let api;
const sockets = [];
try {
  const address = await new Promise((resolveAddress, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged relay did not start')), 10_000);
    relay.once('error', reject);
    relay.once('exit', code => reject(new Error(`Packaged relay exited ${code}`)));
    relay.stdout.on('data', chunk => {
      const match = /listening on (127\.0\.0\.1:\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolveAddress(match[1]);
      }
    });
  });
  process.env.SLOPESMITH_MULTIPLAYER_URL = `http://${address}`;
  const { startApiService } = await import(pathToFileURL(join(root, 'dist-server', 'main.js')).href);
  api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
  async function request(path, body, cookie, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${api.url}${path}`, {
      method,
      headers: { origin: api.url, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert(response.ok, `${path}: ${await response.clone().text()}`);
    return response;
  }
  const bootstrap = await request('/api/auth/bootstrap', {
    code: api.adminCode,
    username: 'packager',
    password: randomBytes(24).toString('hex'),
  });
  const admin = bootstrap.headers.get('set-cookie').split(';')[0];
  const created = await (await request('/api/projects', { name: 'PACKAGE_SMOKE' }, admin)).json();
  const courseId = created.project.id;
  await request(`/api/publication?kind=project&id=${courseId}`, { published: true }, admin, 'PUT');
  const guest = await request('/api/public/guest', { name: 'PackageRider' });
  const cookie = guest.headers.get('set-cookie').split(';')[0];
  for (let index = 0; index < 2; index++) {
    const admitted = await (
      await request(
        '/api/play/ticket',
        { courseId, roomId: 'smoke', clientId: `package-${index}`, deviceLabel: 'package smoke', publicPlay: true },
        cookie,
      )
    ).json();
    const socket = await playSocket(`ws://${address}/api/play/session`, { origin: api.url });
    sockets.push(socket);
    socket.send({ t: 'hello', protocol: manifest.playProtocol, ticket: admitted.ticket });
    await socket.expect(message => message.t === 'welcome');
  }
  const editor = await playSocket(`${api.url.replace('http', 'ws')}/api/session?client=packaged-editor`, {
    origin: api.url,
    cookie: admin,
  });
  sockets.push(editor);
  await editor.expect(message => message.t === 'welcome');
  editor.send({ t: 'watch', projectId: courseId, doc: manifest.documentProtocol, core: manifest.coreProtocol });
  await editor.expect(message => message.t === 'joined' && message.writable);
  for (let seq = 1; seq <= 40; seq++)
    sockets[0].send({
      t: 'pose',
      player: {
        version: 2,
        seq,
        sampleAt: Date.now(),
        teleport: 0,
        mode: 'edit',
        vr: false,
        avatar: 'procedural',
        body: { p: [seq, 0, 0], q: [0, 0, 0, 1] },
        velocity: [0, 0, 0],
      },
    });
  editor.send({ t: 'assign', changes: [['g/aiSeed', 321]], batch: 1 });
  await editor.expect(message => message.t === 'landed' && message.batch === 1);
  await sockets[1].expect(message => message.t === 'poses' && message.peers.some(peer => peer.player.seq === 40));
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g))
    assert((await readFile(join(root, 'dist', match[1]))).length > 0);
  console.log(
    'PACKAGED RELEASE PASS: bundled runtime, native dependencies, API, editor writes, guest tickets, Rust poses, and frontend assets',
  );
} finally {
  for (const socket of sockets) socket.close();
  await api?.close();
  if (relay.exitCode === null) {
    await new Promise(done => {
      relay.once('exit', done);
      relay.kill('SIGTERM');
    });
  }
  assert.equal(dirname(fixture), resolve(tmpdir()));
  assert(basename(fixture).startsWith('slopesmith-packaged-smoke-'));
  await rm(fixture, { recursive: true, force: true });
}
