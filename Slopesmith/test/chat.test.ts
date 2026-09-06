import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { issueAdminCode } from '../src/server/accounts/bootstrap';
import { mintInvite } from '../src/server/accounts/invites';
import { configureAccounts } from '../src/server/accounts/policy';
import { forgetRateLimits } from '../src/server/accounts/rate-limit';
import { forgetAccounts } from '../src/server/accounts/store';
import { accessFor } from '../src/server/app';
import { startApiService, type ApiService } from '../src/server/main';
import { configureCheckpoints } from '../src/server/projects';
import { configureChat, forgetChat } from '../src/server/session/chat';
import { configureSessions, forgetSessions } from '../src/server/session/presence';
import { defaultMountain } from '../src/core/doc/mountain';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { check, failures, recordFailure } from './check';

/**
 * The room and the roster (docs/038), over real sockets and real routes.
 *
 * What is under test is the path a browser actually takes: chat frames over the same authenticated WebSocket
 * presence rides, the system events the server generates from what it already knows, and the roster route the
 * Users mode reads — which lists every member of the server rather than only the connected ones.
 *
 * The channel client below is its own implementation of RFC 6455 rather than the server's, for the same
 * reason `sessions.test.ts` writes one: a codec asserted against itself proves nothing.
 *
 * The last section leaves the server behind and drives `app/shortcuts.ts` directly, because the rule that
 * bites if it is missed is a keyboard rule: while the chat box holds focus, nothing reaches the editor.
 */

const root = mkdtempSync(join(tmpdir(), 'slopesmith-chat-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
forgetAccounts();

configureSessions({ presenceTtlMs: 120_000, sweepMs: 50 });
configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });
// Room enough that the ordinary assertions never trip the limit; the rate limit is exercised by shrinking it.
configureChat({ burst: 100, refillMs: 20 });

const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

// ---- plain HTTP, for the roster beside the channel ----

interface Reply { status: number; headers: IncomingHttpHeaders; json: any; cookies: string[] }

function call(service: ApiService, method: string, path: string,
  options: { body?: unknown; cookie?: string; client?: string } = {}): Promise<Reply> {
  return new Promise((settle, fail) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = request({
      host: '127.0.0.1', port: service.port, path, method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.client ? { 'x-slopesmith-client': options.client } : {}),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* not every route answers JSON */ }
        settle({
          status: response.statusCode ?? 0, headers: response.headers, json,
          cookies: response.headers['set-cookie'] ?? [],
        });
      });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

const sessionCookie = (reply: Reply): string => {
  const line = reply.cookies.find(cookie => cookie.startsWith('slopesmith_session='));
  return line ? line.split(';')[0] : '';
};

// ---- a WebSocket client, written against the specification rather than against the server ----

interface Channel {
  send(message: unknown): void;
  seen: any[];
  mark(): number;
  expect(want: (message: any) => boolean, what: string,
    options?: { from?: number; timeoutMs?: number }): Promise<any>;
  /** Every chat line delivered since `from`, in order. */
  linesSince(from: number): any[];
  close(): void;
}

function openChannel(service: ApiService, options: { client: string; cookie?: string }): Promise<Channel> {
  return new Promise((settle, fail) => {
    const key = randomBytes(16).toString('base64');
    const req = request({
      host: '127.0.0.1', port: service.port, method: 'GET',
      path: `/api/session?client=${encodeURIComponent(options.client)}`,
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': key, 'sec-websocket-version': '13',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
    req.on('error', fail);
    req.on('response', response => { response.resume(); fail(new Error(`upgrade refused with ${response.statusCode}`)); });
    req.on('upgrade', (response, socket: Duplex, head: Buffer) => {
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (response.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        fail(new Error('the server did not answer the handshake key'));
        return;
      }
      const seen: any[] = [];
      let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) break;
          const opcode = buffer[0] & 0x0f;
          if (buffer[1] & 0x80) { socket.destroy(); return; } // a server frame is never masked
          let length = buffer[1] & 0x7f;
          let at = 2;
          if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); at = 4; }
          else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
          if (buffer.length < at + length) break;
          const payload = buffer.subarray(at, at + length);
          buffer = buffer.subarray(at + length);
          if (opcode === 0x8) { socket.destroy(); return; }
          if (opcode === 0x1) {
            try { seen.push(JSON.parse(payload.toString('utf8'))); } catch { /* not a message this test reads */ }
          }
        }
      });

      const write = (text: string) => {
        const payload = Buffer.from(text, 'utf8');
        const mask = randomBytes(4);
        const header = payload.length < 126 ? Buffer.alloc(2) : Buffer.alloc(4);
        header[0] = 0x81;
        if (payload.length < 126) header[1] = 0x80 | payload.length;
        else { header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
        const masked = Buffer.from(payload);
        for (let index = 0; index < masked.length; index++) masked[index] ^= mask[index & 3];
        socket.write(Buffer.concat([header, mask, masked]));
      };

      settle({
        seen,
        mark: () => seen.length,
        send: (message: unknown) => write(JSON.stringify(message)),
        close: () => socket.destroy(),
        linesSince: (from: number) => seen.slice(from).filter(message => message.t === 'chat').map(message => message.line),
        async expect(want, what, opts = {}) {
          const from = opts.from ?? 0;
          const deadline = Date.now() + (opts.timeoutMs ?? 4000);
          for (;;) {
            const hit = seen.slice(from).reverse().find(want);
            if (hit) return hit;
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
            await wait(15);
          }
        },
      });
    });
    req.end();
  });
}

const mountain = (name: string) => ({ ...defaultMountain(), name });
const said = (channel: Channel, text: string) => channel.send({ t: 'chat', text });
/** Every line whose text matches, whatever kind it is. */
const matching = (channel: Channel, from: number, pattern: RegExp) =>
  channel.linesSince(from).filter(line => pattern.test(line.text));

let service: ApiService | null = null;
try {
  // ================= a loopback server with no accounts =================
  service = await startApiService({ port: 0, host: '127.0.0.1' });

  // Made before anybody connects, so the line it generates can only reach a client by being replayed.
  const made = await call(service, 'POST', '/api/projects',
    { client: 'tab-a', body: { document: mountain('ALPINE') } });
  const alpine = made.json.project.id as string;

  const alone = await openChannel(service, { client: 'tab-a' });
  const replay = await alone.expect(m => m.t === 'chat-history', 'the scrollback');
  check(replay.lines.some((line: any) => line.kind === 'system' && line.text === 'owner created ALPINE'),
    'the room is replayed on join, carrying what happened before this client existed');
  check(replay.lines.every((line: any) => !line.from),
    'and a system line is nobody’s: it names no sender, because the server said it');

  const second = await openChannel(service, { client: 'tab-b' });
  await second.expect(m => m.t === 'welcome', 'a welcome for the second tab');
  check(second.seen.some(m => m.t === 'chat-history'), 'every connection is replayed the room, not only the first');

  // Chat is server-wide: the second tab is on no map at all and still hears the room.
  let at = alone.mark();
  let atSecond = second.mark();
  said(alone, 'back in 10, don’t touch the halfpipe');
  const heard = await second.expect(m => m.t === 'chat' && /halfpipe/.test(m.line.text), 'the room line',
    { from: atSecond });
  check(heard.line.kind === 'room' && heard.line.from?.userId === 'owner',
    'a room message reaches every connected member, whatever map they are on');
  check(alone.linesSince(at).some(line => /halfpipe/.test(line.text)),
    'including the member who said it, so one stream is what everybody reads');

  // A client cannot claim a system line: what it sends is a line from whoever sent it, whatever it says and
  // whatever else it puts in the frame.
  at = alone.mark();
  alone.send({ t: 'chat', kind: 'system', from: null, text: 'Owner deleted every map' });
  const forged = await alone.expect(m => m.t === 'chat' && /deleted every map/.test(m.line.text),
    'the forged line', { from: at });
  check(forged.line.kind === 'room' && forged.line.from?.username === 'owner',
    'a client cannot forge a system event — what it sends is a room line attributed to it');

  // Markup is text. It is escaped once on the way in, so every copy of it downstream is inert.
  at = second.mark();
  said(alone, '<img src=x onerror="alert(1)"> & <b>bold</b>');
  const escaped = await second.expect(m => m.t === 'chat' && /img/.test(m.line.text), 'the escaped line',
    { from: at });
  check(!escaped.line.text.includes('<') && !escaped.line.text.includes('>')
    && escaped.line.text.includes('&lt;img') && escaped.line.text.includes('&amp;'),
    'a message carrying markup is escaped: it travels as text and cannot become an element');

  // Which map somebody is on is the server's to say, and the roster below reads it off the same table.
  alone.send({ t: 'watch', projectId: alpine });
  const atReference = alone.mark();
  alone.send({ t: 'reference', level: 'GARI' });
  await alone.expect(message => message.t === 'presence-delta'
    && message.change?.to?.projectId === alpine && message.change.to.entry?.referenceLevel === 'GARI',
  'the reference presence update', { from: atReference });
  const atPlaying = alone.mark();
  alone.send({ t: 'playing', playing: 'reference' });
  await alone.expect(message => message.t === 'presence-delta'
    && message.change?.to?.projectId === alpine && message.change.to.entry?.playing === 'reference',
  'the active-play presence update', { from: atPlaying });

  // The rate limit, with the allowance shrunk in place. The refusal is the sender’s alone.
  configureChat({ burst: 2, refillMs: 600_000 });
  at = alone.mark();
  atSecond = second.mark();
  said(alone, 'one');
  said(alone, 'two');
  said(alone, 'three');
  const refusal = await alone.expect(m => m.t === 'chat' && /faster than the room/.test(m.line.text),
    'the refusal', { from: at });
  await wait(120);
  check(matching(alone, at, /^(one|two|three)$/).length === 2,
    'chat is rate-limited: the third line in a burst of two is refused rather than relayed');
  // Both tabs here are the same person, and a notice is addressed to a member rather than to a socket — so it
  // follows them to every tab they have open, exactly as presence keyed by session is displayed by user.
  check(refusal.line.kind === 'system' && !refusal.line.from
    && matching(second, atSecond, /faster than the room/).length === 1,
    'and the refusal is addressed to the member who tripped it, on whichever tabs they have open');
  configureChat({ burst: 100, refillMs: 20 });

  // The roster, on a server that has no accounts: a room of one, and nothing prompting.
  const solo = await call(service, 'GET', '/api/members', { client: 'tab-a' });
  check(solo.status === 200 && solo.json.accounts === 'open' && solo.json.members.length === 1
    && solo.json.members[0].username === 'owner' && solo.json.members[0].online
    && solo.json.members[0].maps.some((map: any) => map.id === alpine && map.name === 'ALPINE'
      && map.reference === 'GARI' && map.playing?.includes('reference')),
    'the roster shows its connected owner on the map / reference pair and marks the Reference as being played');
  check(solo.json.admin === true && Array.isArray(solo.json.maps),
    'and the owner is its admin, so the panel offers the map actions');
  const atStopPlaying = alone.mark();
  alone.send({ t: 'playing', playing: null });
  await alone.expect(message => message.t === 'presence-delta'
    && message.change?.to?.projectId === alpine && message.change.to.entry?.playing === undefined,
  'the end of active play', { from: atStopPlaying });
  const stoppedPlaying = await call(service, 'GET', '/api/members', { client: 'tab-a' });
  check(stoppedPlaying.json.members[0].maps.every((map: any) => map.playing === undefined),
    'ending play removes the green marker from the roster map');

  alone.close();
  second.close();
  await service.close();
  service = null;
  forgetSessions();
  forgetChat();

  // ================= a server that requires accounts =================
  forgetAccounts();
  forgetRateLimits();
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: true });

  const code = await issueAdminCode();
  const enrolled = await call(service, 'POST', '/api/auth/bootstrap',
    { body: { code, username: 'ada', password: 'first admin password' } });
  const adminCookie = sessionCookie(enrolled);
  const cookieFor = async (username: string, role: 'editor' | 'viewer') => {
    const invite = await mintInvite({ role, handle: `discord:${username}`, by: 'ada' });
    const joined = await call(service!, 'POST', '/api/auth/redeem',
      { body: { token: invite.token, username, password: `${username} password one` } });
    return sessionCookie(joined);
  };
  const editorCookie = await cookieFor('grace', 'editor');
  const viewerCookie = await cookieFor('sam', 'viewer');
  // Enrolled and never connected — the member the presence table can say nothing at all about.
  const offlineCookie = await cookieFor('jo', 'viewer');

  const ada = await openChannel(service, { client: 'ada-1', cookie: adminCookie });
  const grace = await openChannel(service, { client: 'grace-1', cookie: editorCookie });
  const sam = await openChannel(service, { client: 'sam-1', cookie: viewerCookie });
  for (const channel of [ada, grace, sam]) await channel.expect(m => m.t === 'chat-history', 'a scrollback');

  // ---- the roster: every member, not only the connected ones ----
  const roster = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  const byName = Object.fromEntries((roster.json.members as any[]).map(member => [member.username, member]));
  check(roster.status === 200 && roster.json.members.length === 4,
    'the roster lists every member of the server');
  check(byName.jo && !byName.jo.online && byName.jo.role === 'viewer' && byName.jo.maps.length === 0,
    'including a member who has never connected — which is why it is a roster and not the presence table');
  check(byName.ada.online && byName.grace.online && byName.sam.online,
    'and marks the connected ones online');

  const viewerRoster = await call(service, 'GET', '/api/members', { cookie: viewerCookie });
  check(viewerRoster.status === 200 && viewerRoster.json.admin === false
    && viewerRoster.json.maps === undefined && viewerRoster.json.members.length === 4,
    'a viewer sees the same room and nothing administrative — not even the list of maps to act on');
  const editorRoster = await call(service, 'GET', '/api/members', { cookie: editorCookie });
  check(editorRoster.json.admin === false, 'and neither does an editor: administration is the admin role');
  const refusedRole = await call(service, 'POST', '/api/members/sam/role',
    { cookie: editorCookie, body: { role: 'admin' } });
  const refusedInvite = await call(service, 'POST', '/api/members/invite',
    { cookie: viewerCookie, body: { role: 'admin' } });
  check(refusedRole.status === 403 && refusedInvite.status === 403,
    'and the actions themselves are refused, so the panel hiding them is a courtesy rather than the gate');
  check(accessFor('/api/members')('GET', '/') === 'viewer'
    && accessFor('/api/members')('POST', '/invite') === 'moderator'
    && accessFor('/api/members')('GET', '/invites') === 'admin',
    'the access table lets any member read the roster, moderators reach narrow actions, and invite records stay admin-only');

  // ---- the two slash commands ----
  let atAda = ada.mark();
  let atSam = sam.mark();
  let atGrace = grace.mark();
  said(grace, '/msg ada the halfpipe is yours');
  const toAda = await ada.expect(m => m.t === 'chat' && /halfpipe is yours/.test(m.line.text),
    'the private line', { from: atAda });
  await wait(120);
  check(toAda.line.kind === 'private' && toAda.line.from?.username === 'grace'
    && toAda.line.to?.username === 'ada',
    '/msg sends a private line, drawn as one rather than as room traffic');
  check(matching(grace, atGrace, /halfpipe is yours/).length === 1,
    'the sender is sent their own private line, so they can see what they said');
  check(matching(sam, atSam, /halfpipe is yours/).length === 0,
    'and nobody else on the server receives it');

  atGrace = grace.mark();
  atSam = sam.mark();
  said(ada, '/r taking it now');
  const reply = await grace.expect(m => m.t === 'chat' && /taking it now/.test(m.line.text), 'the reply',
    { from: atGrace });
  await wait(120);
  check(reply.line.kind === 'private' && reply.line.from?.username === 'ada'
    && reply.line.to?.username === 'grace',
    '/r replies to whoever messaged you last, without naming them again');
  check(matching(sam, atSam, /taking it now/).length === 0, 'and it is as private as the line it answers');

  atAda = ada.mark();
  atGrace = grace.mark();
  said(grace, '/msg nobody are you there');
  const missing = await grace.expect(m => m.t === 'chat' && /nobody/.test(m.line.text), 'the refusal',
    { from: atGrace });
  await wait(120);
  check(missing.line.kind === 'system' && /There is nobody called nobody/.test(missing.line.text),
    'a /msg to a name nobody has is refused in the sender’s own words');
  check(matching(ada, atAda, /are you there|nobody/).length === 0,
    'and the refusal is the sender’s alone — the room never sees somebody else’s mistyped command');

  // A private line to a member who is not connected is retained for them, not dropped.
  atSam = sam.mark();
  said(grace, '/msg jo the start gate moved');
  await wait(150);
  check(matching(sam, atSam, /start gate moved/).length === 0,
    'a private line to an offline member reaches nobody else in the meantime');
  const jo = await openChannel(service, { client: 'jo-1', cookie: offlineCookie });
  const joReplay = await jo.expect(m => m.t === 'chat-history', 'a scrollback for the member it was sent to');
  check(joReplay.lines.some((line: any) => line.kind === 'private' && /start gate moved/.test(line.text)),
    'and is replayed to them when they arrive — a /msg is retained for its target, not only relayed');
  const stranger = await openChannel(service,
    { client: 'jo2-1', cookie: await cookieFor('jo2', 'viewer') });
  const strangerReplay = await stranger.expect(m => m.t === 'chat-history', 'a scrollback for a new arrival');
  check(!strangerReplay.lines.some((line: any) => /start gate moved/.test(line.text)),
    'while somebody else arriving is not replayed it: retention is per audience, not per server');

  // Every arrival is announced, which is a fact the server holds rather than a claim anybody made.
  check(ada.seen.some(m => m.t === 'chat' && m.line.text === 'jo2 joined'),
    'somebody joining the server is announced into the same stream');

  // ---- what an admin does from the panel, which is what the CLI does from a terminal ----
  const minted = await call(service, 'POST', '/api/members/invite',
    { cookie: adminCookie, body: { role: 'viewer', handle: 'discord:next-rider', days: 2 } });
  check(minted.status === 201 && typeof minted.json.token === 'string'
    && minted.json.invite.handle === 'discord:next-rider',
    'an admin mints an invite from inside the editor, and the token is handed back once');
  const promoted = await call(service, 'POST', '/api/members/sam/role',
    { cookie: adminCookie, body: { role: 'editor' } });
  const disabled = await call(service, 'POST', '/api/members/jo/disabled',
    { cookie: adminCookie, body: { disabled: true } });
  check(promoted.status === 200 && promoted.json.user.role === 'editor'
    && disabled.status === 200 && disabled.json.user.disabled,
    'and sets a role or disables an account, in force on that member’s very next request');
  const selfDemotion = await call(service, 'POST', '/api/members/ada/role',
    { cookie: adminCookie, body: { role: 'viewer' } });
  check(selfDemotion.status === 400 && /CLI/.test(String(selfDemotion.json?.error)),
    'but not on themselves — locking yourself out from a panel inside the editor has no way back but the CLI');
  const signedOut = await call(service, 'POST', '/api/members/jo/sign-out', { cookie: adminCookie });
  check(signedOut.status === 200 && typeof signedOut.json.sessions === 'number',
    'and an action carrying no body at all is not refused for being exactly what it should be');

  jo.close();
  stranger.close();
  ada.close();
  grace.close();
  sam.close();
} catch (error) {
  recordFailure();
  console.error('FAIL', error);
} finally {
  await service?.close();
  forgetSessions();
  forgetChat();
  configureAccounts({ required: false, behindProxy: false });
  forgetAccounts();
  forgetRateLimits();
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  forgetWorkspaceConfig();
  rmSync(root, { recursive: true, force: true });
}

// ================= the focus rule, against the real shortcut layer =================
//
// The editor binds bare single keys for modes and tools, so a chat box typed into without holding focus turns
// a sentence into a burst of mode switches. This drives `installShortcuts` itself with a stub window rather
// than a browser: what is being asserted is the routing rule, and the rule is the whole of the danger.
try {
  let onKeyDown: ((event: any) => void) | null = null;
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, listener: (event: any) => void) => {
      if (type === 'keydown') onKeyDown = listener;
    },
  };
  const { installShortcuts } = await import('../src/app/shortcuts');

  let chatFocused = false;
  const called: string[] = [];
  const noop = new Proxy({}, { get: () => () => undefined }) as any;
  installShortcuts({
    ...noop,
    store: { currentMode: 'edit' },
    viewport: { riding: false },
    edit: noop,
    trickTools: noop,
    propOps: noop,
    effects: noop,
    sculptBrush: { op: 'raise', radius: 40 },
    setMode: (mode: string) => called.push(`mode:${mode}`),
    undo: () => called.push('undo'),
    redo: () => called.push('redo'),
    focusActive: () => called.push('focus'),
    chatFocused: () => chatFocused,
    openChat: (prefill?: string) => called.push(`chat:${prefill ?? ''}`),
  });

  const press = (key: string, mod = false) => onKeyDown?.({
    key, ctrlKey: mod, metaKey: false, altKey: false, shiftKey: false, repeat: false,
    target: null, preventDefault: () => undefined,
  });

  press('t');
  check(called.join(',') === 'chat:', 'T opens the chat box, which is how it takes focus in the first place');
  press('/');
  check(called.includes('chat:/'), 'and / opens it on a command, the way a slash command is normally typed');

  called.length = 0;
  chatFocused = true;
  for (const key of ['3', 'f', 'h', 't', 'Escape', 'Delete']) press(key);
  press('z', true);
  check(called.length === 0,
    'while the chat box holds focus NOTHING reaches the editor — not a mode digit, not F, not even Ctrl+Z');

  chatFocused = false;
  press('3');
  press('z', true);
  check(called.join(',') === 'mode:sculpt,undo',
    'and closing it hands the very same keys straight back to the viewport');
} catch (error) {
  recordFailure();
  console.error('FAIL', error);
}

if (failures) process.exitCode = 1;
else console.log('CHAT PASS');
