/** LiveKit signal HTTP and WebSocket traffic through Slopesmith's existing `/api` TLS route. */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk, fetchForTest, removeTestTree } from './http-test-support';
import { acceptWebSocket } from '../src/server/session/socket';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-voice-proxy-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
process.env.SLOPESMITH_LIVEKIT_URL = 'ws://slopesmith.test/api/livekit';
process.env.SLOPESMITH_LIVEKIT_API_KEY = 'proxy-test-key';
process.env.SLOPESMITH_LIVEKIT_API_SECRET = 'proxy-test-secret-long-enough';
delete process.env.SLOPESMITH_LIVEKIT_ROOM;

const seen: string[] = [];
const mock = createServer((req, res) => {
  seen.push(req.url ?? '');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
});
mock.on('upgrade', (req, socket, head) => {
  seen.push(req.url ?? '');
  const peer = acceptWebSocket(req, socket, head);
  peer?.send('proxied');
});
await new Promise<void>((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(0, '127.0.0.1', () => { mock.off('error', reject); resolve(); });
});
const mockAddress = mock.address();
if (!mockAddress || typeof mockAddress === 'string') throw new Error('mock LiveKit did not bind');
process.env.SLOPESMITH_LIVEKIT_UPSTREAM = `http://127.0.0.1:${mockAddress.port}`;

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
const { forgetRateLimits } = await import('../src/server/accounts/rate-limit');
const { configureAccounts } = await import('../src/server/accounts/policy');
forgetWorkspaceConfig();
forgetAccounts();
const { startApiService } = await import('../src/server/main');

/** The status an upgrade is answered with — 101 once accepted, otherwise the refusal's own — for a client that
 *  can carry a cookie, which the WebSocket global cannot. The accepted socket is dropped at once. */
function upgradeStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((settle, fail) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'GET',
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13',
        ...headers,
      },
    });
    req.on('error', fail);
    req.on('response', response => { response.resume(); settle(response.statusCode ?? 0); });
    req.on('upgrade', (_response, socket) => { socket.destroy(); settle(101); });
    req.end();
  });
}

let service: Awaited<ReturnType<typeof startApiService>> | undefined;
try {
  service = await startApiService({ port: 0, host: '127.0.0.1' });
  const response = await (await expectOk(fetchForTest(
    `${service.url}/api/livekit/rtc/v1/validate?access_token=short-lived`,
  ), 'proxying LiveKit validation')).json() as { path?: string; host?: string };
  check(response.path === '/rtc/v1/validate?access_token=short-lived',
    'the HTTP proxy removes only Slopesmith’s public prefix and preserves LiveKit’s path and query');
  check(response.host === `127.0.0.1:${mockAddress.port}`,
    'and addresses the configured loopback listener rather than forwarding the public Host');

  const message = await new Promise<string>((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${service!.port}/api/livekit/rtc/v1?access_token=short-lived`,
    );
    const timeout = setTimeout(() => { socket.close(); reject(new Error('voice proxy WebSocket timed out')); }, 5_000);
    socket.addEventListener('message', event => {
      clearTimeout(timeout);
      resolve(String(event.data));
      socket.close();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('voice proxy WebSocket failed'));
    }, { once: true });
  });
  check(message === 'proxied' && seen.includes('/rtc/v1?access_token=short-lived'),
    'the WebSocket upgrade reaches LiveKit with the same stripped path');

  const ordinary = await fetchForTest(`${service.url}/api/not-livekit`);
  check(ordinary.status === 404, 'the signalling proxy does not claim neighbouring Slopesmith API paths');

  // A page on another site is refused before anything is relayed, on a server with or without accounts.
  check(await upgradeStatus(service.port, '/api/livekit/rtc/v1', { origin: 'https://evil.example' }) === 403,
    'a socket opened from a page on another site is refused at the door');

  await service.close();
  service = undefined;

  // ---- the same proxy on a server that requires accounts: the door is the same one every route has ----
  forgetAccounts();
  forgetRateLimits();
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: true });
  const enrolled = await fetchForTest(`${service.url}/api/auth/bootstrap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: service.adminCode, username: 'ada', password: 'first admin password' }),
  });
  const cookie = enrolled.headers.getSetCookie().find(line => line.startsWith('slopesmith_session='))?.split(';')[0] ?? '';
  check(enrolled.status === 201 && cookie !== '', 'the first admin enrols and holds a session cookie');

  seen.length = 0;
  const anonymous = await fetchForTest(`${service.url}/api/livekit/rtc/v1/validate?access_token=guess`);
  check(anonymous.status === 401 && seen.length === 0,
    'an anonymous validation request is refused, and LiveKit never hears about it');
  const member = await fetchForTest(`${service.url}/api/livekit/rtc/v1/validate?access_token=minted`,
    { headers: { cookie } });
  check(member.status === 200 && seen.includes('/rtc/v1/validate?access_token=minted'),
    'a signed-in member\'s request is relayed as before');

  seen.length = 0;
  check(await upgradeStatus(service.port, '/api/livekit/rtc/v1?access_token=guess') === 401 && seen.length === 0,
    'an anonymous signalling socket is refused before it reaches LiveKit');
  check(await upgradeStatus(service.port, '/api/livekit/rtc/v1?access_token=minted', { cookie }) === 101
    && seen.includes('/rtc/v1?access_token=minted'),
    'while a member\'s socket, carrying the same cookie a fetch would, is relayed');
} finally {
  if (service) await service.close();
  await new Promise<void>(resolve => mock.close(() => resolve()));
  configureAccounts({ required: false, behindProxy: false });
  forgetAccounts();
  forgetRateLimits();
  delete process.env.SLOPESMITH_LIVEKIT_URL;
  delete process.env.SLOPESMITH_LIVEKIT_API_KEY;
  delete process.env.SLOPESMITH_LIVEKIT_API_SECRET;
  delete process.env.SLOPESMITH_LIVEKIT_ROOM;
  delete process.env.SLOPESMITH_LIVEKIT_UPSTREAM;
  removeTestTree(root);
}

if (failures) process.exitCode = 1;
