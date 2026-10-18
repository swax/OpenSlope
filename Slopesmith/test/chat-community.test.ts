import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { configureAccounts } from '../src/server/accounts/policy';
import { chatIdentity, forgetChatIdentity } from '../src/server/accounts/chat-identity';
import { systemEvent } from '../src/server/session/chat';
import { chatName, trailMarker } from '../src/core/session/chat-member';
import { playSocket } from './play-socket';
import { chromiumExecutable } from './browser-test-support';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-chat-community-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'maps');
process.env.SLOPESMITH_MULTIPLAYER_URL = 'http://127.0.0.1:9';
process.env.SLOPESMITH_MULTIPLAYER_SECRET = 'community test relay secret with 32 bytes';
forgetWorkspaceConfig();
forgetAccounts();
const api = await startApiService({ port: 0, accounts: true, behindProxy: true });
const sockets: Awaited<ReturnType<typeof playSocket>>[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let vite: Awaited<ReturnType<typeof createServer>> | undefined;
const cookieOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0];
async function call(path: string, cookie = '', body?: unknown, ip = '198.51.100.10') {
  return fetch(`${api.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin: api.url,
      'x-forwarded-for': ip,
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function open(cookie: string, ip: string, publicPlay = true) {
  const socket = await playSocket(
    `${api.url.replace('http', 'ws')}/api/${publicPlay ? 'public/session?community=1' : 'session'}&client=${sockets.length}`.replace(
      '/session&',
      '/session?',
    ),
    {
      cookie,
      origin: api.url,
      headers: { 'x-forwarded-for': ip },
    },
  );
  sockets.push(socket);
  await socket.expect(m => m.t === 'welcome');
  return socket;
}
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
try {
  const enrolled = await call('/api/auth/bootstrap', '', {
    code: api.adminCode,
    username: 'admin',
    password: 'a community fixture password',
  });
  assert.equal(enrolled.status, 201);
  const admin = cookieOf(enrolled);
  const editor = await open(admin, '198.51.100.10', false);
  const first = await call('/api/public/guest', '', { name: 'Maple' }, '198.51.100.20');
  const firstCookie = cookieOf(first),
    firstMember = (await first.json()).member;
  const alias = await call('/api/public/guest', '', { name: 'Pine' }, '198.51.100.20');
  const aliasCookie = cookieOf(alias),
    aliasMember = (await alias.json()).member;
  const other = await call('/api/public/guest', '', { name: 'Maple' }, '198.51.100.30');
  const otherCookie = cookieOf(other),
    otherMember = (await other.json()).member;
  assert.match(firstMember.chatId, /^[a-f0-9]{64}$/);
  assert.equal(
    firstMember.chatId,
    aliasMember.chatId,
    'clearing cookies and changing names keeps the network identity',
  );
  assert.notEqual(firstMember.id, aliasMember.id, 'guest participants remain ephemeral and distinct');
  assert.notEqual(firstMember.chatId, otherMember.chatId);
  const guest = await open(firstCookie, '198.51.100.20');
  const renamed = await open(aliasCookie, '198.51.100.20');
  const peer = await open(otherCookie, '198.51.100.30');
  const roster = await editor.expect(m => m.t === 'chat-roster' && m.members.length === 4);
  assert(roster.members.some((m: any) => m.id === firstMember.id && m.chatId === firstMember.chatId));
  assert(!JSON.stringify(roster).includes('198.51.100.'), 'the roster never reveals addresses');
  guest.send({ t: 'chat', text: '<b>server-wide</b>', from: { role: 'admin', chatId: otherMember.chatId } });
  for (const socket of [editor, peer, renamed]) {
    const received = await socket.expect(m => m.t === 'chat' && m.line.text === '&lt;b&gt;server-wide&lt;/b&gt;');
    assert.equal(received.line.from.chatId, firstMember.chatId, 'server identity overrides forged client metadata');
    assert.equal(received.line.from.role, 'viewer');
  }
  peer.send({ t: 'chat', text: `/msg ${JSON.stringify(chatName(firstMember))} hash-specific private message` });
  await guest.expect(
    m => m.t === 'chat' && m.line.kind === 'private' && m.line.text === 'hash-specific private message',
  );
  assert(
    !renamed.seen.some(m => m.t === 'chat' && m.line.text === 'hash-specific private message'),
    'shared hashes do not merge private-message audiences',
  );
  guest.send({ t: 'chat', text: '/r hash-specific reply' });
  await peer.expect(m => m.t === 'chat' && m.line.kind === 'private' && m.line.text === 'hash-specific reply');
  guest.send({ t: 'chat', text: '/msg Nobody a private message' });
  await guest.expect(m => m.t === 'chat' && m.line.kind === 'system' && m.line.text.includes('nobody called'));
  systemEvent('private editor project title');
  await editor.expect(m => m.t === 'chat' && m.line.text === 'private editor project title');
  assert(!peer.seen.some(m => m.t === 'chat' && m.line.text === 'private editor project title'));
  const members = await (await call('/api/members', admin)).json();
  assert(members.members.some((m: any) => m.id === firstMember.id && m.online && m.chatId === firstMember.chatId));
  assert.equal((await call('/api/chat/moderation', firstCookie)).status, 401);
  assert.equal(
    (await call('/api/chat/moderation', firstCookie, { hash: firstMember.chatId, banned: true })).status,
    401,
  );
  const minted = await (await call('/api/members/invite', admin, { role: 'moderator', handle: 'test' })).json();
  const moderatorResponse = await call(
    '/api/auth/redeem',
    '',
    { token: minted.token, username: 'moderator', password: 'another fixture password' },
    '198.51.100.40',
  );
  assert.equal(moderatorResponse.status, 201);
  const moderator = cookieOf(moderatorResponse);
  const moderatorSocket = await open(moderator, '198.51.100.40', false);
  const viewerInvite = await (
    await call('/api/members/invite', admin, { role: 'viewer', handle: 'viewer test' })
  ).json();
  const viewerResponse = await call('/api/auth/redeem', '', {
    token: viewerInvite.token,
    username: 'viewer',
    password: 'viewer fixture password',
  });
  const viewer = cookieOf(viewerResponse);
  assert.equal((await call('/api/chat/moderation', viewer)).status, 403, 'signed-in viewers cannot inspect moderation');
  assert.equal((await call('/api/chat/moderation', viewer, { hash: firstMember.chatId, banned: true })).status, 403);
  assert.equal((await call('/api/chat/moderation', moderator, { hash: firstMember.chatId, banned: true })).status, 200);
  const afterBan = peer.seen.length;
  guest.send({ t: 'chat', text: 'blocked room message' });
  renamed.send({ t: 'chat', text: '/msg admin blocked private message' });
  await sleep(100);
  peer.send({ t: 'ping', at: Date.now() });
  await peer.expect(m => m.t === 'pong', afterBan);
  assert(
    !sockets.some(s => s.seen.some(m => m.t === 'chat' && m.line.text.includes('blocked'))),
    'shadow bans drop room and private messages including sender echo',
  );
  forgetChatIdentity();
  assert(
    (await (await call('/api/chat/moderation', moderator)).json()).hashes.includes(firstMember.chatId),
    'bans survive a policy reload',
  );
  const afterRestart = await call('/api/public/guest', '', { name: 'NewAlias' }, '198.51.100.20');
  assert.equal((await afterRestart.json()).member.chatId, firstMember.chatId, 'the hash survives a policy reload');
  assert(!readFileSync(join(root, 'accounts', 'chat-policy.json'), 'utf8').includes('198.51.100.20'));
  const adminHash = (await editor.expect(m => m.t === 'welcome')).member.chatId;
  assert.equal((await call('/api/chat/moderation', moderator, { hash: adminHash, banned: true })).status, 403);
  assert.equal(
    (await call('/api/chat/moderation', moderator, { hash: firstMember.chatId, banned: false })).status,
    200,
  );
  renamed.send({ t: 'chat', text: 'unbanned alias' });
  await editor.expect(m => m.t === 'chat' && m.line.text === 'unbanned alias');
  const departed = peer.seen.length;
  guest.close();
  renamed.close();
  await peer.expect(
    m =>
      m.t === 'chat-roster' &&
      !m.members.some((member: any) => member.id === firstMember.id || member.id === aliasMember.id),
    departed,
  );
  const withoutGuests = await (await call('/api/members', admin)).json();
  assert(
    !withoutGuests.members.some((m: any) => m.id === firstMember.id || m.id === aliasMember.id),
    'departed guests never become offline entries',
  );
  assert(
    withoutGuests.members.some((m: any) => m.username === 'viewer' && !m.online),
    'offline registered viewers remain in the editor roster',
  );
  moderatorSocket.close();
  assert.equal(trailMarker(firstMember).shape, 'guest');
  assert.equal(trailMarker({ ...firstMember, id: 'account', role: 'editor' }).shape, 'square');
  assert.match(chatName(firstMember), /^Maple #[A-F0-9]{4}$/);

  // Trusted proxy handling: attacker-controlled first entries cannot choose the hash.
  const fake = (address: string, forwarded: string) =>
    ({ socket: { remoteAddress: address }, headers: { 'x-forwarded-for': forwarded } }) as unknown as Parameters<
      typeof chatIdentity
    >[0];
  assert.equal(await chatIdentity(fake('127.0.0.1', 'forged, 198.51.100.20')), firstMember.chatId);
  configureAccounts({ behindProxy: false });
  assert.equal(await chatIdentity(fake('::ffff:198.51.100.20', '198.51.100.30')), firstMember.chatId);
  assert.equal(await chatIdentity(fake('2001:db8:0:0:0:0:0:1', '')), await chatIdentity(fake('2001:db8::1', '')));
  configureAccounts({ behindProxy: true });

  vite = await createServer({
    configFile: false,
    root: resolve('.'),
    logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
    plugins: [
      {
        name: 'community-fixture',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== '/community-fixture') return next();
            res.setHeader('content-type', 'text/html');
            res.end(
              '<!doctype html><html><head><title>Community</title></head><body style="background:#182936;color:white"></body></html>',
            );
          });
        },
      },
    ],
  });
  await vite.listen();
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page
    .context()
    .addCookies([{ name: 'slopesmith_session', value: admin.split('=')[1], url: vite.resolvedUrls!.local[0] }]);
  await page.addInitScript('window.__name = value => value;');
  await page.goto(`${vite.resolvedUrls!.local[0]}community-fixture`);
  const setupUi = async () =>
    page.evaluate(
      async ({ firstMember, aliasMember, otherMember, adminHash }) => {
        const path = '/src/app/ui/chrome/chat-box.ts';
        const { createChatBox } = await import(path);
        const state = window as any;
        state.chat = createChatBox({
          docked: true,
          say() {},
          me: () => ({ id: 'admin-fixture', username: 'admin', role: 'admin', chatId: adminHash }),
        });
        state.chat.setUsers([
          firstMember,
          aliasMember,
          otherMember,
          { id: 'viewer', username: 'Viewer', role: 'viewer' },
          { id: 'editor', username: 'Editor', role: 'editor' },
          { id: 'moderator', username: 'Moderator', role: 'moderator' },
          { id: 'admin-fixture', username: 'Admin', role: 'admin' },
        ]);
        state.chat.replay([
          {
            id: 1,
            at: Date.now(),
            kind: 'room',
            text: 'first identity message',
            from: { ...firstMember, userId: firstMember.id },
          },
          {
            id: 2,
            at: Date.now(),
            kind: 'room',
            text: 'same network alias',
            from: { ...aliasMember, userId: aliasMember.id },
          },
          {
            id: 3,
            at: Date.now(),
            kind: 'room',
            text: 'other network message',
            from: { ...otherMember, userId: otherMember.id },
          },
        ]);
      },
      { firstMember, aliasMember, otherMember, adminHash },
    );
  await setupUi();
  await page.getByRole('tab', { name: 'Chat', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: 'Users (7)', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.getByRole('tab', { name: 'Chat', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Users (7)', exact: true }).click();
  assert.equal(await page.locator('.sp-role-marker').filter({ visible: true }).count(), 7);
  await page.getByRole('button', { name: `Options for ${chatName(firstMember)}`, exact: true }).click();
  await page.getByText('Mute chat', { exact: true }).click();
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  assert.equal(await page.getByText('first identity message', { exact: true }).isVisible(), false);
  assert.equal(await page.getByText('same network alias', { exact: true }).isVisible(), false);
  assert(await page.getByText('other network message', { exact: true }).isVisible());
  await page.reload();
  await setupUi();
  assert.equal(
    await page.getByText('same network alias', { exact: true }).isVisible(),
    false,
    'mutes survive page reloads',
  );
  await page.getByRole('tab', { name: 'Users (7)', exact: true }).click();
  await page.getByRole('button', { name: `Options for ${chatName(firstMember)}`, exact: true }).click();
  await page.getByText('Unmute chat', { exact: true }).click();
  await page.getByRole('button', { name: `Options for ${chatName(otherMember)}`, exact: true }).click();
  await page.getByText('Shadow-ban chat', { exact: true }).click();
  await page.getByText('Chat shadow ban saved.', { exact: true }).waitFor();
  assert((await (await call('/api/chat/moderation', admin)).json()).hashes.includes(otherMember.chatId));
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  assert(await page.getByText('same network alias', { exact: true }).isVisible());
  await page.getByRole('tab', { name: 'Users (7)', exact: true }).click();
  await page.getByText('Chat shadow bans (1)', { exact: true }).click();
  await page
    .getByRole('button', { name: `Remove #${otherMember.chatId.slice(0, 4).toUpperCase()}`, exact: true })
    .click();
  await page.waitForFunction(async () => (await (await fetch('/api/chat/moderation')).json()).hashes.length === 0);
  mkdirSync(resolve('temp'), { recursive: true });
  await page.screenshot({ path: join(resolve('temp'), 'community-users.png') });
  console.log(
    'COMMUNITY PASS: shared chat, private messages, trusted IP hashes, live-only guests, moderation permissions and persistence, role markers, roster tabs and browser mute controls.',
  );
} finally {
  await browser?.close();
  await vite?.close();
  for (const socket of sockets) socket.close();
  await api.close();
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert(basename(root).startsWith('slopesmith-chat-community-'));
  rmSync(root, { recursive: true, force: true });
}
