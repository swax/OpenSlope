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
import { setUserRole } from '../src/server/accounts/users';
import { invalidateSharedLibrary } from '../src/server/api/common';
import { accessFor } from '../src/server/app';
import { startApiService, type ApiService } from '../src/server/main';
import type { ProjectBundle } from '../src/server/project-transfer';
import { configureCheckpoints, listCheckpoints, openProject } from '../src/server/projects';
import { withProjectAssets } from '../src/server/project-assets';
import { encodePng } from '../src/server/routes/png';
import { saveCustomTexture } from '../src/server/routes/textures';
import { configureSessions, forgetSessions } from '../src/server/session/presence';
import { trimPlayerSeats } from '../src/server/session/capacity';
import { configureRooms, forgetRooms } from '../src/server/session/room';
import { defaultMountain } from '../src/core/doc/mountain';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { check, failures, recordFailure } from './check';

/**
 * The session channel (docs/038, docs/039), over real sockets.
 *
 * Everything here runs against `startApiService`, so what is under test is the path a browser actually takes:
 * the WebSocket upgrade through the same route table and the same cookie every `/api/*` request goes through,
 * the presence table the service holds in memory, the register room everybody's changes land in, and the
 * whole-document pushes an import or a checkpoint restore still produces.
 *
 * The channel client below is its own implementation of RFC 6455 rather than the server's — a codec asserted
 * against itself proves nothing. It masks everything it sends, which every client must, and reads back frames
 * that must not be masked.
 *
 * Two servers are exercised in turn: one nobody configured for accounts, which has to behave as a single
 * admin and ask nothing, and one that requires them, where the roles that decide who may write are real.
 */

const root = mkdtempSync(join(tmpdir(), 'slopesmith-sessions-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
forgetAccounts();

/** Long enough that a test's own steps never race the sweep. */
configureSessions({ presenceTtlMs: 120_000, sweepMs: 25 });
// Every accepted change is worth a durable snapshot here, so the revision line is exercised rather than waited on.
configureRooms({ snapshotIdleMs: 20, snapshotChanges: 1 });
// Every save is worth a checkpoint here, so the session-end one is not the only entry the ring has ever seen.
configureCheckpoints({ intervalMs: 0, changeBytes: 0 });

const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));

// ---- plain HTTP, for the routes the channel sits beside ----

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
  /** Every message this client has been sent, in order. */
  seen: any[];
  /** How many messages have arrived so far — the point an `expect` should look forward from, so a later
   *  assertion cannot be satisfied by an earlier message that happened to match. */
  mark(): number;
  expect(want: (message: any) => boolean, what: string,
    options?: { from?: number; timeoutMs?: number }): Promise<any>;
  close(): void;
  readonly closed: boolean;
  readonly closeCode: number;
  readonly closeReason: string;
}

class UpgradeRefused extends Error {
  constructor(public readonly status: number) { super(`upgrade refused with ${status}`); }
}

function openChannel(service: ApiService,
  options: { client: string; cookie?: string; device?: string; immediate?: unknown }): Promise<Channel> {
  return new Promise((settle, fail) => {
    const key = randomBytes(16).toString('base64');
    const req = request({
      host: '127.0.0.1', port: service.port, method: 'GET',
      path: `/api/session?client=${encodeURIComponent(options.client)}`
        + `${options.device ? `&device=${encodeURIComponent(options.device)}` : ''}`,
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': key, 'sec-websocket-version': '13',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
    });
    req.on('error', fail);
    // A refusal never becomes a socket: it answers in the HTTP the client is still speaking.
    req.on('response', response => { response.resume(); fail(new UpgradeRefused(response.statusCode ?? 0)); });
    req.on('upgrade', (response, socket: Duplex, head: Buffer) => {
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (response.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        fail(new Error('the server did not answer the handshake key'));
        return;
      }
      const seen: any[] = [];
      let presenceMaps: Record<string, any[]> = {};
      let closed = false;
      let closeCode = 0;
      let closeReason = '';
      let buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
      const shut = (code = 0, reason = '') => {
        closed = true;
        if (code) closeCode = code;
        if (reason) closeReason = reason;
      };

      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          if (buffer.length < 2) break;
          const opcode = buffer[0] & 0x0f;
          // A server frame is never masked, which is the rule from its side.
          if (buffer[1] & 0x80) { socket.destroy(); shut(); return; }
          let length = buffer[1] & 0x7f;
          let at = 2;
          if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); at = 4; }
          else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); at = 10; }
          if (buffer.length < at + length) break;
          const payload = buffer.subarray(at, at + length);
          buffer = buffer.subarray(at + length);
          if (opcode === 0x8) {
            const code = payload.length >= 2 ? payload.readUInt16BE(0) : 0;
            const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
            socket.destroy(); shut(code, reason); return;
          }
          if (opcode === 0x1) {
            try {
              const message = JSON.parse(payload.toString('utf8'));
              seen.push(message);
              if (message.t === 'presence') presenceMaps = message.maps ?? {};
              if (message.t === 'presence-delta' && message.change?.sessionId) {
                const next: Record<string, any[]> = {};
                for (const [projectId, entries] of Object.entries(presenceMaps)) {
                  const kept = entries.filter((entry: any) => entry.sessionId !== message.change.sessionId);
                  if (kept.length) next[projectId] = kept;
                }
                const to = message.change.to;
                if (to?.projectId && to.entry) (next[to.projectId] ??= []).push(to.entry);
                presenceMaps = next;
                // Assertions below read the materialized view exactly as the browser callback does. The raw
                // delta remains in `seen` as well, so protocol-specific checks can still inspect it.
                seen.push({ t: 'presence', maps: presenceMaps, materializedFromDelta: true });
              }
            } catch { /* not a message this test reads */ }
          }
        }
      });
      socket.on('close', shut);
      socket.on('end', shut);
      socket.on('error', shut);

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

      // Exercise the legal edge where the client writes as soon as the 101 upgrade arrives, before it has
      // received welcome. The server still has an async remembered-project lookup in that interval.
      if (options.immediate !== undefined) write(JSON.stringify(options.immediate));

      settle({
        seen,
        get closed() { return closed; },
        get closeCode() { return closeCode; },
        get closeReason() { return closeReason; },
        mark: () => seen.length,
        send: (message: unknown) => write(JSON.stringify(message)),
        close: () => { socket.destroy(); shut(); },
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

/**
 * Write a whole document, against the revision the project holds right now.
 *
 * A live register room writes revisions of its own on its cadence, so the revision a test read a moment ago is
 * not necessarily the one on disk when the request lands. Re-reading immediately before the write is what a
 * caller outside the room does anyway; the retry covers the room writing between the two.
 */
async function saveDocument(service: ApiService, id: string, document: unknown,
  options: { client?: string; cookie?: string } = {}): Promise<Reply> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await call(service, 'GET', `/api/projects/${id}`, { cookie: options.cookie });
    const wrote = await call(service, 'PUT', `/api/projects/${id}/document`,
      { ...options, body: { baseRevision: current.json.project.revision, document } });
    if (wrote.status !== 409) return wrote;
    await wait(60);
  }
  throw new Error('the document could not be written against a current revision');
}

/** A tiny solid PNG, so a transfer has real custom art to carry. */
function tile(r: number, g: number, b: number): Buffer {
  const data = new Uint8Array(8 * 8 * 4);
  for (let at = 0; at < 8 * 8; at++) {
    data[at * 4] = r; data[at * 4 + 1] = g; data[at * 4 + 2] = b; data[at * 4 + 3] = 255;
  }
  return encodePng({ w: 8, h: 8, data });
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

let service: ApiService | null = null;
try {
  // ================= a loopback server with no accounts =================
  service = await startApiService({ port: 0, host: '127.0.0.1' });

  const made = await call(service, 'POST', '/api/projects',
    { client: 'tab-a', body: { document: mountain('ALPINE') } });
  check(made.status === 201, 'a map is created on a server nobody configured for accounts');
  const alpine = made.json.project.id as string;

  const alone = await openChannel(service, { client: 'tab-a' });
  const welcome = await alone.expect(m => m.t === 'welcome', 'a welcome');
  check(welcome.accounts === 'open' && welcome.member.role === 'admin' && welcome.member.id === 'owner',
    'the channel connects with nothing asked, and answers that the caller is the owner, as admin');
  check(welcome.projectId === alpine,
    'and seeds this tab from the map it already had open, so presence is right before the editor says anything');

  const solo = await alone.expect(m => m.t === 'presence' && m.maps?.[alpine]?.length === 1, 'presence');
  check(solo.maps[alpine][0].userId === 'owner' && solo.maps[alpine][0].clientId === 'tab-a',
    'presence shows exactly one member: editing alone is a room of one');

  const joined = await alone.expect(m => m.t === 'joined' && m.projectId === alpine, 'the room');
  check(joined.writable === true && joined.at === 0 && !joined.reason,
    'the room on this map opens with nothing asked: there is no lease to take, and this tab may write');
  const corner = (made.json.document.vertexIds as string[])[0];
  let at = alone.mark();
  alone.send({ t: 'assign', changes: [[`v/${corner}`, [1, 2, 3]]], batch: 1 });
  const landed = await alone.expect(m => m.t === 'landed' && m.batch === 1, 'the acknowledgement', { from: at });
  check(landed.retired.length === 0 && landed.refused.length === 0 && landed.at === 1,
    'an absolute assignment lands, and moves the room on by one');
  const wrote = await saveDocument(service, alpine, made.json.document, { client: 'tab-a' });
  check(wrote.status === 200, 'and a whole document still writes exactly as it always did');

  // One person, two tabs: one member in the list, two entries in the table.
  at = alone.mark();
  const second = await openChannel(service,
    { client: 'tab-b', immediate: { t: 'watch', projectId: alpine } });
  const secondWelcome = await second.expect(m => m.t === 'welcome', 'a welcome for the second tab');
  check(Number.isFinite(secondWelcome.serverTime),
    'the welcome anchors the shared clock used to age multiplayer pose samples');
  const joinedImmediately = await second.expect(m => m.t === 'joined' && m.projectId === alpine,
    'the watch sent with the upgrade');
  check(joinedImmediately.writable,
    'a watch sent immediately after the WebSocket upgrade is queued until the session is ready, not dropped');
  const twoTabs = await alone.expect(m => m.t === 'presence' && m.maps?.[alpine]?.length === 2, 'two entries',
    { from: at });
  const entries = twoTabs.maps[alpine] as Array<{ userId: string; sessionId: string; clientId: string }>;
  check(new Set(entries.map(entry => entry.userId)).size === 1
    && new Set(entries.map(entry => entry.sessionId)).size === 2
    && new Set(entries.map(entry => entry.clientId)).size === 2,
    'presence is keyed by session: one user with two tabs is one member holding two entries');
  const presencePushes = alone.seen.slice(at);
  check(presencePushes.some(message => message.t === 'presence-delta' && message.change?.to?.projectId === alpine)
    && !presencePushes.some(message => message.t === 'presence' && !message.materializedFromDelta),
  'an existing tab receives one participant delta, not another copy of the whole presence table');
  check(!presencePushes.some(message => message.t === 'room-policy'),
    'a join inside the same awareness tier tells only the newcomer, not the whole room again');
  const mirrored = await second.expect(m => m.t === 'presence' && m.maps?.[alpine]?.length === 2,
    'presence at the second tab');
  check(!!mirrored, 'and both tabs are told the same table — presence is pushed to every client, not polled by one');

  // Screen sharing is opt-in presence plus an observer-routed disposable view stream. The server supplies
  // project/reference identity from the target session rather than trusting those names from a browser.
  const sharingAt = alone.mark();
  second.send({ t: 'reference', level: 'GARI' });
  second.send({ t: 'screen-share', enabled: true });
  const sharingPresence = await alone.expect(m => m.t === 'presence-delta'
    && m.change?.sessionId === secondWelcome.sessionId && m.change?.to?.entry?.screenSharing === true,
  'screen-sharing presence', { from: sharingAt });
  check(sharingPresence.change.to.entry.referenceLevel === 'GARI',
    'a sharing tab advertises its exact map/reference pair in presence');
  const sharingRoster = await call(service, 'GET', '/api/members');
  check(sharingRoster.json.members?.[0]?.maps?.some((map: any) =>
    map.id === alpine && map.reference === 'GARI' && map.sharingSessionId === secondWelcome.sessionId),
  'the Users roster names the exact sharing tab so its view-screen button has an unambiguous target');

  const sharedState = {
    cursor: [7, 8, 9],
    view: {
      pos: [10, 20, 30], target: [1, 2, 3], up: [0, 0.8, 0.2],
      ortho: false, zoom: 1, orthoHalfH: 200, fov: 78.145, near: 0.03,
    },
    options: {
      shadeMode: 'textured', cage: false, viewGrid: true, orientation: false,
      courseGuide: true, normals: true, aiPaths: false, props: true, tricks: true,
      effects: true, sources: false, propLights: true, sun: true, skybox: true,
    },
  };
  const screenAt = alone.mark();
  const watcherAt = second.mark();
  alone.send({ t: 'screen-observe', sessionId: secondWelcome.sessionId });
  const watcherCount = await second.expect(m => m.t === 'screen-watchers' && m.count === 1,
    'the active watcher count', { from: watcherAt });
  check(watcherCount.count === 1,
    'a sharer is told how many distinct people are actively consuming the stream');
  const watchingPresence = await alone.expect(m => m.t === 'presence-delta'
    && m.change?.sessionId === welcome.sessionId
    && m.change?.to?.entry?.screenWatchingSessionId === secondWelcome.sessionId,
  'active screen-watching presence', { from: screenAt });
  check(watchingPresence.change.to.entry.screenWatchingSessionId === secondWelcome.sessionId,
    'an active observer is marked with its exact group for the Users-list icon and avatar suppression');
  const watchingRoster = await call(service, 'GET', '/api/members');
  check(watchingRoster.json.members?.[0]?.watching === true,
    'the roster aggregates active observation into the member row');
  second.send({ t: 'screen-state', state: sharedState });
  const screen = await alone.expect(m => m.t === 'screen-state'
    && m.sessionId === secondWelcome.sessionId, 'a shared-screen frame', { from: screenAt });
  check(screen.projectId === alpine && screen.referenceLevel === 'GARI'
    && screen.userId === secondWelcome.member.id && screen.username === secondWelcome.member.username
    && screen.cursor.join(',') === '7,8,9'
    && screen.view.pos.join(',') === '10,20,30' && screen.view.up.join(',') === '0,0.8,0.2'
    && screen.view.fov === 78.145 && screen.view.near === 0.03 && screen.options.propLights === true
    && screen.options.skybox === true,
  'an observer receives the target’s authenticated mountain/reference plus cursor, camera, and view options');

  const pausedAt = alone.mark();
  const pausedCountAt = second.mark();
  alone.send({ t: 'screen-observe', sessionId: secondWelcome.sessionId, active: false });
  await second.expect(m => m.t === 'screen-watchers' && m.count === 0,
    'the paused watcher count', { from: pausedCountAt });
  const pausedPresence = await alone.expect(m => m.t === 'presence-delta'
    && m.change?.sessionId === welcome.sessionId && !m.change?.to?.entry?.screenWatchingSessionId,
  'paused screen-watching presence', { from: pausedAt });
  check(!pausedPresence.change.to.entry.screenWatchingSessionId,
    'pausing retains the subscription but removes the active-watching roster marker');
  const whilePausedAt = alone.mark();
  second.send({ t: 'screen-state', state: {
    ...sharedState, cursor: [4, 5, 6], view: { ...sharedState.view, target: [4, 5, 6] },
  } });
  await wait(60);
  check(!alone.seen.slice(whilePausedAt).some(message => message.t === 'screen-state'),
    'a paused observer receives no disposable view frames');

  const replayAt = alone.mark();
  const resumedCountAt = second.mark();
  alone.send({ t: 'screen-observe', sessionId: secondWelcome.sessionId, active: true });
  await second.expect(m => m.t === 'screen-watchers' && m.count === 1,
    'the resumed watcher count', { from: resumedCountAt });
  const replayedScreen = await alone.expect(m => m.t === 'screen-state'
    && m.sessionId === secondWelcome.sessionId, 'the latest shared-screen frame', { from: replayAt });
  check(replayedScreen.view.target.join(',') === '4,5,6' && replayedScreen.cursor.join(',') === '4,5,6',
    'continuing observation replays the target’s latest camera and cursor frame and becomes active again');

  const invalidScreenAt = alone.mark();
  second.send({ t: 'screen-state', state: { ...sharedState, view: { ...sharedState.view, pos: [NaN, 0, 0] } } });
  await wait(60);
  check(!alone.seen.slice(invalidScreenAt).some(message => message.t === 'screen-state'),
    'a malformed shared camera is discarded instead of reaching an observer');

  const stoppedScreenAt = alone.mark();
  second.send({ t: 'screen-share', enabled: false });
  const stoppedScreen = await alone.expect(m => m.t === 'screen-observe-ended'
    && m.sessionId === secondWelcome.sessionId, 'the screen-share withdrawal', { from: stoppedScreenAt });
  check(!!stoppedScreen, 'withdrawing screen sharing immediately releases every observer');
  second.send({ t: 'reference', level: null });

  const atLibrary = alone.mark();
  invalidateSharedLibrary('Custom');
  const libraryChanged = await alone.expect(m => m.t === 'library-changed', 'an authored-library change',
    { from: atLibrary });
  check(libraryChanged.scope === 'custom',
    'an asset catalogue changed on one device is pushed to the others instead of waiting for a reload');

  const policy = await alone.expect(m => m.t === 'room-policy' && m.projectId === alpine,
    'the awareness policy for the room');
  check(policy.awarenessMs === 80,
    'a small room keeps the normal 12.5 Hz awareness publishing ceiling');

  // Awareness is absolute, disposable state. Several positions from one participant inside the room window
  // become their newest position in one batch, whose identical bytes also go back to its author.
  const atAwareness = alone.mark();
  const atOwnAwareness = second.mark();
  second.send({ t: 'aware', aware: { cursor: [1, 2, 3], vertices: ['old'], quads: [], dragging: [] } });
  second.send({ t: 'aware', aware: {
    cursor: [4, 5, 6], vertices: ['new'], quads: [], dragging: ['new'],
    player: {
      version: 2, seq: 7, sampleAt: secondWelcome.serverTime, teleport: 0,
      mode: 'ride', vr: true, avatar: 'procedural',
      body: { p: [10, 20, 30], q: [0, 0, 0, 2] }, velocity: [40, 0, 0],
      head: { p: [10, 21.6, 30], q: [0, 0, 0, 1] },
      hands: [{ p: [9.5, 21, 30], q: [0, 0, 0, 1] }, { p: [10.5, 21, 30], q: [0, 0, 0, 1] }],
      equipment: {
        state: 'mounted', transform: { p: [10, 20, 30], q: [0, 0, 0, 1] },
        velocity: [40, 0, 0], teleport: 0,
      },
      animation: { grounded: true, crouch: 0.4, lean: -0.25, bank: -12 },
      gesture: { kind: 'point', hand: 'left', direction: [0, 0, 0.5], target: [10, 20, 31], id: 3 },
    },
  } });
  const awarenessBatch = await alone.expect(m => m.t === 'awareness-batch'
    && m.peers?.some((peer: any) => peer.sessionId === secondWelcome.sessionId),
  'a room awareness batch', { from: atAwareness });
  const newestAwareness = awarenessBatch.peers.find((peer: any) => peer.sessionId === secondWelcome.sessionId);
  check(awarenessBatch.peers.filter((peer: any) => peer.sessionId === secondWelcome.sessionId).length === 1
    && newestAwareness.cursor === undefined
    && newestAwareness.aware.cursor === null
    && newestAwareness.aware.vertices.join(',') === 'new'
    && newestAwareness.aware.player?.avatar === 'procedural'
    && newestAwareness.aware.player?.body.q.join(',') === '0,0,0,1'
    && newestAwareness.aware.player?.hands?.length === 2
    && newestAwareness.aware.player?.equipment?.state === 'mounted'
    && newestAwareness.aware.player?.gesture?.direction.join(',') === '0,0,1'
    && newestAwareness.aware.player?.gesture?.target.join(',') === '10,20,31',
  'a room window carries only the newest absolute non-cursor state for each participant');
  const ownBatch = await second.expect(m => m.t === 'awareness-batch'
    && m.peers?.some((peer: any) => peer.sessionId === secondWelcome.sessionId),
  'the same shared batch reaching its author', { from: atOwnAwareness });
  check(ownBatch.projectId === awarenessBatch.projectId
    && JSON.stringify(ownBatch.peers) === JSON.stringify(awarenessBatch.peers),
  'every socket receives the same room batch, leaving the browser to ignore its own entry');

  // Moving away is an immediate barrier: a state still waiting in the old room must not arrive after the
  // presence delta has said that participant left it.
  const beforeMove = alone.mark();
  second.send({ t: 'aware', aware: { cursor: [7, 8, 9], vertices: ['stale'], quads: [], dragging: [] } });
  second.send({ t: 'watch', projectId: null });
  await alone.expect(m => m.t === 'presence-delta' && m.change?.sessionId === secondWelcome.sessionId
    && !m.change?.to, 'the second tab leaving the map', { from: beforeMove });
  await wait(80);
  check(!alone.seen.slice(beforeMove).some(message => message.t === 'awareness-batch'
    && message.peers?.some((peer: any) => peer.sessionId === secondWelcome.sessionId)),
  'a pending awareness state is discarded when its participant leaves the room');
  const beforeRejoin = second.mark();
  second.send({ t: 'watch', projectId: alpine });
  await second.expect(m => m.t === 'joined' && m.projectId === alpine,
    'the second tab rejoining after the awareness barrier', { from: beforeRejoin });

  // Ride interactions are disposable facts about this Play run: local prediction means the sender must not
  // hear an echo, while peers on the same project need the stable target/key and the sender's clock sample.
  const rideAt = alone.mark();
  const ownRideAt = second.mark();
  const rideEvent = {
    t: 'ride-event', target: { kind: 'reference', level: 'MEGAPLE' }, mode: 'showoff',
    kind: 'collision', key: 'reference:42', id: 1, riderSpeed: 31.5, sentAt: secondWelcome.serverTime,
  };
  second.send(rideEvent);
  const sharedRide = await alone.expect(m => m.t === 'ride-event' && m.id === 1,
    'a transient Play interaction', { from: rideAt });
  check(sharedRide.projectId === alpine && sharedRide.fromSessionId === secondWelcome.sessionId
    && sharedRide.target?.kind === 'reference' && sharedRide.target.level === 'MEGAPLE'
    && sharedRide.key === 'reference:42' && sharedRide.riderSpeed === 31.5
    && sharedRide.sentAt === secondWelcome.serverTime && Number.isFinite(sharedRide.serverAt),
  'the server scopes a ride event from the socket while preserving its stable replay data');
  await wait(60);
  check(!second.seen.slice(ownRideAt).some(message => message.t === 'ride-event'),
    'the locally predicted interaction is not echoed to its sender');

  const repeatedRideAt = alone.mark();
  second.send(rideEvent);
  await wait(60);
  check(!alone.seen.slice(repeatedRideAt).some(message => message.t === 'ride-event'),
    'a repeated or reordered sender event id cannot restart a one-shot');

  const invalidRideAt = alone.mark();
  const invalidRideReplyAt = second.mark();
  second.send({ ...rideEvent, id: 2, target: { kind: 'reference', level: '' } });
  await second.expect(m => m.t === 'error' && /valid ride event/i.test(String(m.message)),
    'the malformed ride-event response', { from: invalidRideReplyAt });
  await wait(60);
  check(!alone.seen.slice(invalidRideAt).some(message => message.t === 'ride-event'),
    'a malformed interaction is rejected rather than relayed');

  const nextRideAt = alone.mark();
  second.send({ ...rideEvent, id: 2, kind: 'trigger', key: 'reference:42:trigger:fx-1' });
  const nextRide = await alone.expect(m => m.t === 'ride-event' && m.id === 2,
    'the next valid Play interaction', { from: nextRideAt });
  check(nextRide.kind === 'trigger' && nextRide.key === 'reference:42:trigger:fx-1',
    'an invalid packet does not consume the sender sequence or poison the next event');

  // Two tabs on one map both write. There is nothing to hold and nothing to be refused.
  await second.expect(m => m.t === 'joined' && m.projectId === alpine && m.writable, 'the room at the second tab');
  at = alone.mark();
  const atOther = second.mark();
  second.send({ t: 'assign', changes: [['g/aiSeed', 1234]], batch: 7 });
  const bothLanded = await second.expect(m => m.t === 'landed' && m.batch === 7, 'the second tab landing',
    { from: atOther });
  check(bothLanded.refused.length === 0,
    'a second tab assigns a register of its own and is not refused: there is no lease for it to be behind');
  const relayed = await alone.expect(m => m.t === 'sync' && m.changes?.[0]?.[0] === 'g/aiSeed', 'the relay',
    { from: at });
  check(relayed.changes[0][1] === 1234 && relayed.by === 'owner',
    'and everybody else on the map is sent the value, absolute, with no operation named');

  // A whole document written outside the room — an import, a restore, a script — still reaches everybody as a
  // document, because that write replaced the mountain rather than assigning to it.
  const followed = mountain('ALPINE');
  followed.aiSeed = 4242;
  at = second.mark();
  const aloneBeforePush = alone.mark();
  const saved = await saveDocument(service, alpine, followed, { client: 'tab-a' });
  check(saved.status === 200, 'a whole document is written outside the room');
  const push = await second.expect(m => m.t === 'revision' && m.projectId === alpine, 'a pushed revision',
    { from: at });
  check(push.project.revision === saved.json.project.revision && push.document.aiSeed === 4242,
    'everybody else on the map is pushed it whole, which is what they replace their replica with');
  check(!alone.seen.slice(aloneBeforePush).some(m => m.t === 'revision'),
    'and the tab that wrote it is not sent its own edit back');

  // A key naming nothing this mountain has ever had is reported rather than applied — and it is the only
  // shape of ordinary edit that can be refused at all.
  at = second.mark();
  second.send({ t: 'assign', changes: [['q/local:99999/paint', 4]], batch: 8 });
  const nowhere = await second.expect(m => m.t === 'landed' && m.batch === 8, 'the outcome', { from: at });
  check(nowhere.refused.length === 1 && nowhere.retired.length === 0,
    'a key naming geometry this mountain never carried is refused, and nothing else about it is');

  // The durable snapshot: the room, not the file, is the authoritative document while it is open, and it
  // writes a revision on its own cadence without pushing anybody a document they already hold.
  at = alone.mark();
  alone.send({ t: 'assign', changes: [['g/spacing', 21]], batch: 9 });
  await alone.expect(m => m.t === 'landed' && m.batch === 9, 'the first tab landing', { from: at });
  const atLast = second.mark();
  second.send({ t: 'assign', changes: [[`v/${corner}`, [4, 5, 6]]], batch: 10 });
  await second.expect(m => m.t === 'landed' && m.batch === 10, 'the second tab landing', { from: atLast });
  await wait(300);
  const durable = await call(service, 'GET', `/api/projects/${alpine}`);
  check(durable.json.document.spacing === 21 && durable.json.document.vertices.slice(0, 3).join(',') === '4,5,6',
    'the room writes what it holds as an ordinary revision, carrying the work of both tabs');

  // A disconnect is simply a session going: nothing is queued for it and nothing waits for it to come back.
  at = alone.mark();
  second.close();
  const released = await alone.expect(m => m.t === 'presence' && m.maps?.[alpine]?.length === 1,
    'presence after a disconnect', { from: at });
  check(released.maps[alpine][0].clientId === 'tab-a', 'a disconnect removes that session from presence');

  // The last writer leaving sets the session's work aside, credited to whoever actually changed the map.
  alone.close();
  await wait(600);
  const ring = await listCheckpoints(alpine);
  const closing = ring.checkpoints.find(entry => entry.reason === 'idle');
  check(!!closing && closing.members.join(',') === 'owner',
    'the last writer leaving takes a checkpoint carrying the members whose work it holds');

  // ---- moving a mountain between servers (docs/038) ----
  const painted = mountain('PAINTED');
  painted.quadTex = { 0: 'Custom/slope.png' };
  const paintedMade = await call(service, 'POST', '/api/projects', { client: 'tab-a', body: { document: painted } });
  const paintedId = paintedMade.json.project.id as string;
  const stored = await withProjectAssets(await openProject(paintedId), () =>
    saveCustomTexture('slope', tile(20, 120, 200)));
  check(stored === 'slope.png', 'a mountain stores its custom texture inside its own project assets');

  const portableCheckpoint = await call(service, 'POST', `/api/projects/${paintedId}/checkpoints`,
    { client: 'tab-a', body: { note: 'portable checkpoint' } });
  const portableFile = portableCheckpoint.json.checkpoint.file as string;
  const checkpointDownload = await call(service, 'GET',
    `/api/projects/${paintedId}/checkpoints/${encodeURIComponent(portableFile)}/download?assets=bytes`);
  const checkpointBundle = checkpointDownload.json as ProjectBundle;
  check(checkpointDownload.status === 200 && checkpointBundle.kind === 'slopesmith-project'
    && checkpointBundle.revision === portableCheckpoint.json.checkpoint.revision
    && checkpointBundle.document.name === 'PAINTED' && checkpointBundle.assets.length === 1
    && !!checkpointBundle.blobs?.[checkpointBundle.assets[0].hash],
  'a history checkpoint downloads as the same self-contained mountain bundle as the live revision');

  const listed = await call(service, 'GET', '/api/projects');
  check(listed.status === 200 && listed.json.projects.some((entry: any) => entry.id === paintedId),
    'every map on the server is listed to any member');

  const downloaded = await call(service, 'GET', `/api/projects/${paintedId}/download?assets=bytes`);
  const bundle = downloaded.json as ProjectBundle;
  check(downloaded.status === 200 && bundle.kind === 'slopesmith-project' && bundle.assets.length === 1
    && bundle.assets[0].kind === 'texture' && bundle.assets[0].name === stored
    && !!bundle.blobs?.[bundle.assets[0].hash],
    'download takes the current revision as a bundle: the document, plus its custom assets by content hash');

  const negotiated = await call(service, 'POST', '/api/projects/transfer/manifest',
    { body: { assets: bundle.assets } });
  check(negotiated.status === 200 && negotiated.json.missing.length === bundle.assets.length
    && Object.keys(negotiated.json.have).length === 0,
    'a fresh project needs every declared asset because authored libraries are mountain-local');

  const forked = await call(service, 'POST',
    `/api/projects/${paintedId}/duplicate?name=${encodeURIComponent('PAINTED_COPY')}`, { client: 'tab-a' });
  check(forked.status === 201 && forked.json.project.name === 'PAINTED_COPY'
    && forked.json.document.quadTex['0'] === `Custom/${stored}`
    && forked.json.stored.length === 1,
    'same-server duplicate copies the mountain-local asset library without a browser round trip');

  // The same bundle carrying different art creates another isolated mountain. Its own `slope.png` is free:
  // equal names in two project folders are not a collision and do not see one another.
  const fresh = tile(220, 40, 40);
  const arriving: ProjectBundle = {
    ...bundle,
    assets: [{ ...bundle.assets[0], hash: sha256(fresh), size: fresh.length }],
    blobs: { [sha256(fresh)]: fresh.toString('base64') },
  };
  const brought = await call(service, 'POST', '/api/projects/transfer',
    { client: 'tab-a', body: { bundle: arriving, name: 'BROUGHT_OVER' } });
  check(brought.status === 201 && brought.json.project.name === 'BROUGHT_OVER'
    && brought.json.stored.length === 1
    && brought.json.stored[0].to === 'slope.png'
    && brought.json.document.quadTex['0'] === 'Custom/slope.png',
    'an imported asset lands under its original name inside the fresh mountain ownership boundary');

  const bare = await call(service, 'POST', '/api/projects/transfer',
    { client: 'tab-a', body: { bundle: { kind: 'slopesmith-project', document: mountain('ASSET_FREE'), assets: [] } } });
  check(bare.status === 201 && bare.json.project.name === 'ASSET_FREE',
    'and an asset-free mountain remains a valid internal transfer bundle');

  check(accessFor('/api/projects')('DELETE', '/x') === 'editor'
    && accessFor('/api/projects')('POST', '/') === 'editor'
    && accessFor('/api/projects')('POST', '/transfer') === 'editor'
    && accessFor('/api/projects')('PUT', '/x/document') === 'editor'
    && accessFor('/api/session')('GET', '/') === 'viewer',
    'map mutations reach the editor gate before map ownership/policy, and any member may join');
  const removed = await call(service, 'DELETE', `/api/projects/${paintedId}`);
  check(removed.status === 200 && removed.json.deleted.name === 'PAINTED', 'an admin deletes a map');

  // A map deleted out from under the people on it. Everything the channel holds for it goes: the tab is told
  // by name and left on no map, so nothing is still watching a folder that has been removed.
  const doomed = await call(service, 'POST', '/api/projects',
    { client: 'tab-doomed', body: { document: mountain('DOOMED') } });
  const doomedId = doomed.json.project.id as string;
  const watcher = await openChannel(service, { client: 'tab-doomed' });
  await watcher.expect(m => m.t === 'welcome', 'a welcome for the watcher');
  await watcher.expect(m => m.t === 'joined' && m.projectId === doomedId, 'the watcher joining the doomed map');
  // Somebody's change, so the map has a roster of writers to credit a session-end checkpoint to — which is
  // exactly the checkpoint that must NOT be attempted once there is no project left to write it into.
  const doomedCorner = (doomed.json.document.vertexIds as string[])[0];
  const atWatcher = watcher.mark();
  watcher.send({ t: 'assign', changes: [[`v/${doomedCorner}`, [7, 7, 7]]], batch: 1 });
  await watcher.expect(m => m.t === 'landed' && m.batch === 1, 'the watcher landing', { from: atWatcher });
  // Let the room's own snapshot of that change land before the map goes, so what is listened for below is the
  // deletion path rather than a write that was already in flight.
  await wait(200);

  // Nothing may be attempted against the project once it is gone: the room is dropped rather than snapshotted,
  // and the roster of who wrote on the map is forgotten before the sessions move off it, so settling the last
  // one out asks for no session-end checkpoint. That failure used to be audible — an `Unknown project` landing
  // in the one catch the channel has — so what is asserted is that nothing is said at all.
  const complaints: string[] = [];
  const wasErroring = console.error;
  console.error = (...parts: unknown[]) => { complaints.push(parts.map(String).join(' ')); };
  let wiped: Reply | null = null;
  let told: any = null;
  let emptied: any = null;
  let stillUp = false;
  // The socket is dropped whatever happens, so a timeout here reports itself rather than holding the service
  // open on a connection nothing is going to close.
  try {
    const atGone = watcher.mark();
    wiped = await call(service, 'DELETE', `/api/projects/${doomedId}`);
    told = await watcher.expect(m => m.t === 'gone' && m.projectId === doomedId, 'the map going',
      { from: atGone });
    emptied = await watcher.expect(m => m.t === 'presence' && !m.maps?.[doomedId],
      'presence without the map', { from: atGone });
    stillUp = !watcher.closed;
    // Longer than the room's snapshot cadence, so anything the deletion failed to stop has had time to fire.
    await wait(400);
  } finally { console.error = wasErroring; watcher.close(); }
  check(wiped?.status === 200 && told?.name === 'DOOMED',
    'a tab watching a deleted map is told it is gone, by the name the map was called');
  check(!!emptied && stillUp,
    'and is moved off it rather than left in presence on a map that is not there — its socket stays up');
  check(!complaints.length, 'and nothing is attempted against the deleted project to fail and be logged');
  let ringGone = false;
  try { await listCheckpoints(doomedId); } catch { ringGone = true; }
  check(ringGone, 'least of all a session-end checkpoint, which has no ring left to be written into');

  const flood = await openChannel(service, { client: 'tab-flood' });
  await flood.expect(m => m.t === 'welcome', 'a welcome for the rate-limit client');
  for (let index = 0; index < 400; index++) flood.send({ t: 'ping' });
  const floodDeadline = Date.now() + 2_000;
  while (!flood.closed && Date.now() < floodDeadline) await wait(10);
  check(flood.closed, 'a socket that floods beyond the channel burst is disconnected before it monopolises the loop');
  flood.close();

  const lingering = await openChannel(service, { client: 'shutdown-hold' });
  await lingering.expect(m => m.t === 'welcome', 'a welcome for the live shutdown client');
  // Welcome is written just before the server seats the live-session record. Presence is written just after;
  // waiting for it closes the narrow handshake race so this specifically tests an established upgrade.
  await lingering.expect(m => m.t === 'presence', 'the live shutdown client to enter the session table');
  let rescuedShutdown = false;
  const rescueShutdown = setTimeout(() => {
    rescuedShutdown = true;
    lingering.close();
  }, 1_000);
  const shutdownStarted = Date.now();
  await service.close();
  const shutdownElapsed = Date.now() - shutdownStarted;
  clearTimeout(rescueShutdown);
  const clientCloseDeadline = Date.now() + 250;
  while (!lingering.closed && Date.now() < clientCloseDeadline) await wait(5);
  check(!rescuedShutdown && shutdownElapsed < 1_000,
    'closing the service closes an upgraded session itself instead of waiting on the HTTP server forever');
  check(lingering.closed, 'the upgraded client observes that graceful service close');
  service = null;
  forgetSessions();
  forgetRooms();

  // ================= a server that requires accounts =================
  forgetAccounts();
  forgetRateLimits();
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: true });

  const code = await issueAdminCode();
  const enrolled = await call(service, 'POST', '/api/auth/bootstrap',
    { body: { code, username: 'Ada', password: 'first admin password' } });
  const adminCookie = sessionCookie(enrolled);
  const editorInvite = await mintInvite({ role: 'editor', handle: 'discord:grace', by: 'ada' });
  const editorJoined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: editorInvite.token, username: 'grace', password: 'grace password one' } });
  const editorCookie = sessionCookie(editorJoined);
  const viewerInvite = await mintInvite({ role: 'viewer', handle: 'discord:sam', by: 'ada' });
  const viewerJoined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: viewerInvite.token, username: 'sam', password: 'sam password one' } });
  const viewerCookie = sessionCookie(viewerJoined);
  const secondViewerInvite = await mintInvite({ role: 'viewer', handle: 'discord:pat', by: 'ada' });
  const secondViewerJoined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: secondViewerInvite.token, username: 'pat', password: 'pat password one' } });
  const secondViewerCookie = sessionCookie(secondViewerJoined);
  const moderatorInvite = await mintInvite({ role: 'moderator', handle: 'discord:lin', by: 'ada' });
  const moderatorJoined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: moderatorInvite.token, username: 'lin', password: 'lin password one' } });
  const moderatorCookie = sessionCookie(moderatorJoined);
  const secondAdminInvite = await mintInvite({ role: 'admin', handle: 'discord:max', by: 'ada' });
  const secondAdminJoined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: secondAdminInvite.token, username: 'max', password: 'max password one' } });
  const secondAdminCookie = sessionCookie(secondAdminJoined);

  let unauthenticated = 0;
  try { await openChannel(service, { client: 'nobody' }); }
  catch (error) { unauthenticated = error instanceof UpgradeRefused ? error.status : -1; }
  check(unauthenticated === 401,
    'the channel is authenticated by the same session cookie every route uses — no cookie, no socket');

  // Player capacity is a live server setting. Accounts are the unit even though presence remains session-shaped:
  // one account can use several tabs/devices without consuming several seats, and role rank decides displacement.
  // This integration check redirects the setting through its environment override so it never writes the
  // checkout's real machine-local config. Persistence and range validation have their own isolated check.
  process.env.SLOPESMITH_MAX_PLAYERS = '2';
  forgetWorkspaceConfig();

  const viewerSeatOne = await openChannel(service, { client: 'capacity-viewer-1', cookie: viewerCookie });
  const viewerSeatTwo = await openChannel(service, { client: 'capacity-viewer-2', cookie: viewerCookie });
  const otherViewerSeat = await openChannel(service,
    { client: 'capacity-other-viewer-1', cookie: secondViewerCookie });
  await viewerSeatOne.expect(m => m.t === 'welcome', 'the first viewer account capacity seat');
  await viewerSeatTwo.expect(m => m.t === 'welcome', 'another tab on the first viewer account');
  await otherViewerSeat.expect(m => m.t === 'welcome', 'the second viewer account capacity seat');
  check(!viewerSeatOne.closed && !viewerSeatTwo.closed && !otherViewerSeat.closed,
    'two tabs for one account consume one seat, so two viewer accounts fit a limit of two');
  process.env.SLOPESMITH_MAX_PLAYERS = '1';
  forgetWorkspaceConfig();
  trimPlayerSeats(1);
  const trimmedDeadline = Date.now() + 1_000;
  while ((!viewerSeatOne.closed || !viewerSeatTwo.closed) && Date.now() < trimmedDeadline) await wait(10);
  check(viewerSeatOne.closed && viewerSeatTwo.closed
    && viewerSeatOne.closeCode === 4003 && viewerSeatTwo.closeCode === 4003 && !otherViewerSeat.closed,
    'lowering the live limit removes every tab of the oldest viewer account, freeing one unique-account seat');

  const otherViewerTab = await openChannel(service,
    { client: 'capacity-other-viewer-2', cookie: secondViewerCookie });
  await otherViewerTab.expect(m => m.t === 'welcome', 'an extra tab for the viewer who still holds a seat');
  check(!otherViewerTab.closed,
    'a full server still admits another tab/device for an account that already occupies a seat');

  const refusedViewer = await openChannel(service, { client: 'capacity-viewer-3', cookie: viewerCookie });
  const refusedDeadline = Date.now() + 1_000;
  while (!refusedViewer.closed && Date.now() < refusedDeadline) await wait(10);
  check(refusedViewer.closed && refusedViewer.closeCode === 4003
    && /full/i.test(refusedViewer.closeReason) && !refusedViewer.seen.some(message => message.t === 'welcome'),
    'another viewer receives an explicit full-server close instead of entering presence');

  const editorSeat = await openChannel(service, { client: 'capacity-editor', cookie: editorCookie });
  await editorSeat.expect(m => m.t === 'welcome', 'an editor taking a full seat');
  const displacedDeadline = Date.now() + 1_000;
  while ((!otherViewerSeat.closed || !otherViewerTab.closed) && Date.now() < displacedDeadline) await wait(10);
  check(otherViewerSeat.closed && otherViewerTab.closed
    && otherViewerSeat.closeCode === 4003 && otherViewerTab.closeCode === 4003
    && /editor/i.test(otherViewerSeat.closeReason),
    'an editor connects by displacing every session of the oldest remaining viewer account');

  const moderatorSeat = await openChannel(service, { client: 'capacity-moderator', cookie: moderatorCookie });
  const moderatorWelcome = await moderatorSeat.expect(m => m.t === 'welcome', 'a moderator taking an editor seat');
  const editorBumpedDeadline = Date.now() + 1_000;
  while (!editorSeat.closed && Date.now() < editorBumpedDeadline) await wait(10);
  check(moderatorWelcome.member.role === 'moderator' && editorSeat.closed
    && /moderator/i.test(editorSeat.closeReason),
    'a moderator connects by bumping an editor when no viewer remains');

  const adminSeat = await openChannel(service, { client: 'capacity-admin', cookie: adminCookie });
  const adminWelcome = await adminSeat.expect(m => m.t === 'welcome', 'an admin taking a moderator seat');
  const moderatorBumpedDeadline = Date.now() + 1_000;
  while (!moderatorSeat.closed && Date.now() < moderatorBumpedDeadline) await wait(10);
  check(adminWelcome.member.role === 'admin' && moderatorSeat.closed && /admin/i.test(moderatorSeat.closeReason),
    'an admin connects by bumping a moderator');

  const secondAdminSeat = await openChannel(service,
    { client: 'capacity-second-admin', cookie: secondAdminCookie });
  const secondAdminWelcome = await secondAdminSeat.expect(m => m.t === 'welcome', 'an unbounded second admin');
  check(secondAdminWelcome.member.role === 'admin' && !adminSeat.closed && !secondAdminSeat.closed,
    'admin accounts are unbounded when a full server contains only admins');

  const blockedEditor = await openChannel(service, { client: 'capacity-blocked-editor', cookie: editorCookie });
  const blockedEditorDeadline = Date.now() + 1_000;
  while (!blockedEditor.closed && Date.now() < blockedEditorDeadline) await wait(10);
  check(blockedEditor.closed && blockedEditor.closeCode === 4003,
    'an editor cannot bump admins or exceed the unique-account limit');
  adminSeat.close();
  secondAdminSeat.close();
  blockedEditor.close();
  refusedViewer.close();
  process.env.SLOPESMITH_MAX_PLAYERS = '16';
  forgetWorkspaceConfig();

  const shared = await call(service, 'POST', '/api/projects',
    { cookie: adminCookie, client: 'ada-1', body: { document: mountain('SHARED') } });
  const sharedId = shared.json.project.id as string;

  const ada = await openChannel(service, { client: 'ada-1', cookie: adminCookie });
  const graceOne = await openChannel(service,
    { client: 'grace-1', cookie: editorCookie, device: 'Computer' });
  const graceTwo = await openChannel(service,
    { client: 'grace-2', cookie: editorCookie, device: 'Phone' });
  const sam = await openChannel(service, { client: 'sam-1', cookie: viewerCookie });
  for (const [channel, who] of [[ada, 'ada'], [graceOne, 'grace'], [graceTwo, 'grace'], [sam, 'sam']] as const) {
    const hello = await channel.expect(m => m.t === 'welcome', `a welcome for ${who}`);
    check(hello.member.username === who && hello.accounts === 'required',
      `${who} joins the channel as themselves, over the cookie they signed in with`);
    channel.send({ t: 'watch', projectId: sharedId });
  }

  const room = await ada.expect(m => m.t === 'presence' && m.maps?.[sharedId]?.length === 4, 'a room of four');
  const people = room.maps[sharedId] as Array<{
    userId: string; sessionId: string; username: string; deviceLabel?: string;
  }>;
  check(new Set(people.map(entry => entry.userId)).size === 3
    && new Set(people.map(entry => entry.sessionId)).size === 4
    && people.filter(entry => entry.username === 'grace').length === 2
    && people.filter(entry => entry.username === 'grace').map(entry => entry.deviceLabel).sort().join(',')
      === 'Computer,Phone',
    'two devices see each other, and Grace’s computer and phone are labelled sessions of the same member');
  const rosterWithDevices = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  const graceRoster = rosterWithDevices.json.members.find((member: any) => member.username === 'grace');
  check(graceRoster.devices.slice().sort().join(',') === 'Computer,Phone',
    'the member roster exposes those device labels instead of collapsing them into an unexplained count');

  // Idle is tab-local but status is member-shaped: an untouched phone cannot turn an active desktop yellow.
  let atStatus = ada.mark();
  graceOne.send({ t: 'idle', idle: true });
  await ada.expect(message => message.t === 'status-changed'
    && message.userId === editorJoined.json.user.id, 'Grace’s first idle tab', { from: atStatus });
  let statusRoster = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  let graceStatus = statusRoster.json.members.find((member: any) => member.username === 'grace');
  check(graceStatus.status === 'online' && graceStatus.availability === 'available',
    'one idle tab leaves the member Online while another tab is active');

  atStatus = ada.mark();
  graceTwo.send({ t: 'idle', idle: true });
  await ada.expect(message => message.t === 'status-changed'
    && message.userId === editorJoined.json.user.id, 'all of Grace’s tabs becoming idle', { from: atStatus });
  statusRoster = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  graceStatus = statusRoster.json.members.find((member: any) => member.username === 'grace');
  check(graceStatus.online && graceStatus.status === 'idle',
    'the connected member becomes Idle only when every live tab is idle');

  atStatus = ada.mark();
  graceOne.send({ t: 'idle', idle: false });
  await ada.expect(message => message.t === 'status-changed'
    && message.userId === editorJoined.json.user.id, 'Grace becoming active again', { from: atStatus });
  statusRoster = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  graceStatus = statusRoster.json.members.find((member: any) => member.username === 'grace');
  check(graceStatus.status === 'online', 'activity in any tab returns an available member to Online');

  const beforeAvailability = ada.mark();
  const away = await call(service, 'POST', '/api/auth/availability', {
    cookie: editorCookie, body: { availability: 'away' },
  });
  await ada.expect(message => message.t === 'profile-changed'
    && message.userId === editorJoined.json.user.id, 'Grace setting Away', { from: beforeAvailability });
  statusRoster = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  graceStatus = statusRoster.json.members.find((member: any) => member.username === 'grace');
  check(away.status === 200 && away.json.user.availability === 'away' && graceStatus.status === 'away',
    'manual Away persists on the account and overrides active tabs');
  const dnd = await call(service, 'POST', '/api/auth/availability', {
    cookie: editorCookie, body: { availability: 'dnd' },
  });
  const invalidAvailability = await call(service, 'POST', '/api/auth/availability', {
    cookie: editorCookie, body: { availability: 'idle' },
  });
  statusRoster = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  graceStatus = statusRoster.json.members.find((member: any) => member.username === 'grace');
  check(dnd.json.user.availability === 'dnd' && graceStatus.status === 'dnd'
    && invalidAvailability.status === 400,
  'Do Not Disturb is durable too, while the automatic Idle value is refused as a manual choice');
  const beforeAvailable = ada.mark();
  await call(service, 'POST', '/api/auth/availability', {
    cookie: editorCookie, body: { availability: 'available' },
  });
  await ada.expect(message => message.t === 'profile-changed'
    && message.userId === editorJoined.json.user.id, 'Grace returning to Available', { from: beforeAvailable });

  const beforeProfile = ada.mark();
  const profilePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const changedProfile = await call(service, 'POST', '/api/auth/profile-picture', {
    cookie: editorCookie, body: { profilePicture: `data:image/png;base64,${profilePng}` },
  });
  const profilePush = await ada.expect(message => message.t === 'profile-changed'
    && message.userId === editorJoined.json.user.id, 'a live profile change', { from: beforeProfile });
  check(changedProfile.status === 200 && !!profilePush,
    'changing a picture tells connected browsers to refresh an open roster without reconnecting anyone');

  const graceJoined = await graceOne.expect(m => m.t === 'joined' && m.projectId === sharedId, 'Grace joining');
  check(graceJoined.writable === true, 'an editor joins the room able to write');
  const samJoined = await sam.expect(m => m.t === 'joined' && m.projectId === sharedId, 'Sam joining');
  check(samJoined.writable === false && /editor role/i.test(String(samJoined.reason)),
    'a viewer joins read-only — that is the whole of what the viewer role means here');

  // The jukebox is server-wide rather than map-shaped: every role may contribute and seek, while ownership
  // (or moderator/admin rank) gates removal and skip. Its URL is public state; nobody's local bridge account is.
  let atJukebox = ada.mark();
  sam.send({ t: 'jukebox-add', url: 'https://youtu.be/dQw4w9WgXcQ' });
  const samPlaying = await ada.expect(m => m.t === 'jukebox-state' && m.state?.current?.username === 'sam',
    'Sam adding a shared video', { from: atJukebox });
  check(samPlaying.state.current.url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    && samPlaying.state.queue.length === 0,
  'a viewer may add, and the server broadcasts a canonical public URL without any bridge credentials');

  atJukebox = ada.mark();
  graceOne.send({ t: 'jukebox-add', url: 'M7lc1UVf-VE' });
  const graceQueued = await ada.expect(m => m.t === 'jukebox-state'
    && m.state?.queue?.some((entry: any) => entry.username === 'grace'),
  'Grace joining the shared queue', { from: atJukebox });
  const graceVideo = graceQueued.state.queue.find((entry: any) => entry.username === 'grace');
  check(!!graceVideo, 'an editor’s queued row carries their username and URL to everybody');

  const atForbiddenSkip = graceOne.mark();
  graceOne.send({ t: 'jukebox-skip', id: samPlaying.state.current.id });
  const forbiddenSkip = await graceOne.expect(m => m.t === 'jukebox-error', 'an unowned skip being refused',
    { from: atForbiddenSkip });
  check(/queuer|moderator|admin/i.test(forbiddenSkip.message),
    'an ordinary member cannot skip somebody else’s current video');

  atJukebox = ada.mark();
  sam.send({ t: 'jukebox-seek', id: samPlaying.state.current.id, position: 37.25 });
  const soughtVideo = await ada.expect(m => m.t === 'jukebox-state' && m.state?.position === 37.25,
    'the shared seek', { from: atJukebox });
  check(soughtVideo.state.mediaVersion === graceQueued.state.mediaVersion
    && soughtVideo.state.changedAt >= graceQueued.state.changedAt,
  'any participant may seek, re-anchoring the server clock without forcing a decoder reload');

  atJukebox = ada.mark();
  graceOne.send({ t: 'jukebox-playing', id: samPlaying.state.current.id, playing: false });
  const pausedVideo = await ada.expect(m => m.t === 'jukebox-state' && m.state?.playing === false,
    'the shared pause', { from: atJukebox });
  check(pausedVideo.state.mediaVersion === soughtVideo.state.mediaVersion && pausedVideo.state.position >= 37.25,
    'any participant may pause while preserving the shared decoder epoch and current playhead');

  atJukebox = ada.mark();
  sam.send({ t: 'jukebox-playing', id: samPlaying.state.current.id, playing: true });
  const resumedVideo = await ada.expect(m => m.t === 'jukebox-state' && m.state?.playing === true,
    'the shared resume', { from: atJukebox });
  check(resumedVideo.state.mediaVersion === pausedVideo.state.mediaVersion,
    'resuming advances the shared clock without reloading the video');

  const lateJukebox = await openChannel(service, { client: 'late-jukebox', cookie: viewerCookie });
  await lateJukebox.expect(m => m.t === 'welcome', 'a late jukebox viewer welcome');
  const lateState = await lateJukebox.expect(m => m.t === 'jukebox-state', 'the current jukebox for a late joiner');
  check(lateState.state.current.id === samPlaying.state.current.id
    && lateState.state.position >= pausedVideo.state.position && lateState.state.playing,
  'a late joiner receives the current source, queue, and latest shared transport state immediately');
  lateJukebox.close();

  atJukebox = ada.mark();
  sam.send({ t: 'jukebox-skip', id: samPlaying.state.current.id });
  const gracePlaying = await ada.expect(m => m.t === 'jukebox-state'
    && m.state?.current?.id === graceVideo.id, 'the queuer skipping their own video', { from: atJukebox });
  check(gracePlaying.state.queue.length === 0,
    'the current queuer may skip it and the next queued item is promoted for everybody');

  atJukebox = sam.mark();
  ada.send({ t: 'jukebox-skip', id: graceVideo.id });
  const adminCleared = await sam.expect(m => m.t === 'jukebox-state' && m.state?.current === null,
    'an admin skipping somebody else’s video', { from: atJukebox });
  check(adminCleared.state.queue.length === 0 && !adminCleared.state.playing,
    'an admin can skip another member’s item and empty the shared queue');

  const sharedCorner = (shared.json.document.vertexIds as string[])[0];
  let atGrace = graceOne.mark();
  graceOne.send({ t: 'assign', changes: [[`v/${sharedCorner}`, [4, 5, 6]]], batch: 1 });
  const graceLanded = await graceOne.expect(m => m.t === 'landed' && m.batch === 1, 'Grace landing',
    { from: atGrace });
  check(graceLanded.refused.length === 0, 'and an editor writes without asking anybody');

  const beforeRestriction = graceOne.mark();
  const restricted = await call(service, 'PUT', `/api/projects/${sharedId}/permissions`,
    { cookie: adminCookie, body: { editorIds: [] } });
  const graceRestricted = await graceOne.expect(
    m => m.t === 'project-access' && m.projectId === sharedId, 'Grace receiving restricted access',
    { from: beforeRestriction });
  const blockedByMap = graceOne.mark();
  graceOne.send({ t: 'assign', changes: [['g/aiSeed', 44]], batch: 101 });
  const mapRefusal = await graceOne.expect(m => m.t === 'error', 'the restricted editor being told',
    { from: blockedByMap });
  const beforeAdmission = graceOne.mark();
  const admitted = await call(service, 'PUT', `/api/projects/${sharedId}/permissions`, {
    cookie: adminCookie, body: { editorIds: [editorJoined.json.user.id] },
  });
  const graceAdmitted = await graceOne.expect(
    m => m.t === 'project-access' && m.projectId === sharedId, 'Grace receiving restored access',
    { from: beforeAdmission });
  check(restricted.status === 200 && graceRestricted.writable === false
    && /selected by its owner/i.test(String(graceRestricted.reason))
    && /read-only/i.test(String(mapRefusal.message))
    && admitted.status === 200 && graceAdmitted.writable === true,
    'changing a map allow-list immediately revokes and restores an already-open editor tab');
  const beforeRename = graceOne.mark();
  graceOne.send({ t: 'assign', changes: [['g/name', 'GRACE_RENAME']], batch: 102 });
  const renameRefusal = await graceOne.expect(m => m.t === 'landed' && m.batch === 102,
    'Grace rename refusal', { from: beforeRename });
  check(renameRefusal.refused.includes('g/name'),
    'an admitted editor still cannot rename a map they do not own');

  const atSam = sam.mark();
  sam.send({ t: 'assign', changes: [[`v/${sharedCorner}`, [9, 9, 9]]], batch: 1 });
  const samRefused = await sam.expect(m => m.t === 'error', 'the viewer being told', { from: atSam });
  check(/read-only/i.test(String(samRefused.message)), 'a viewer is told rather than quietly ignored');

  // A scoped revert is a change to the map like any other (docs/040), so it sits behind the same editor gate
  // every other write does — declared once in `ROUTE_ACCESS`, not as a check of its own.
  const beforeRevert = await call(service, 'POST', `/api/projects/${sharedId}/checkpoints`,
    { cookie: editorCookie, client: 'grace-1', body: { reason: 'named', note: 'before a revert' } });
  const revertFile = encodeURIComponent(beforeRevert.json.checkpoint.file as string);
  const samReverting = await call(service, 'POST',
    `/api/projects/${sharedId}/checkpoints/${revertFile}/revert`,
    { cookie: viewerCookie, client: 'sam-1', body: {} });
  check(samReverting.status === 403,
    'and may not revert one either — reverting is a write, so the viewer role refuses it before it is read');
  check(accessFor('/api/projects')('POST', `/${sharedId}/checkpoints/x/revert`) === 'editor',
    'which is the route table saying so rather than the handler: a revert is an editor action like a save');

  const atGraceTwo = graceTwo.mark();
  graceTwo.send({ t: 'assign', changes: [['g/aiSeed', 55]], batch: 2 });
  const otherTab = await graceTwo.expect(m => m.t === 'landed' && m.batch === 2, 'the second tab landing',
    { from: atGraceTwo });
  check(otherTab.refused.length === 0,
    'and one person’s second tab writes like anybody else: two tabs are two participants, not two claimants');
  const mismatched = await openChannel(service, { client: 'skewed-1', cookie: editorCookie });
  await mismatched.expect(m => m.t === 'welcome', 'a welcome for the mismatched build');
  const atSkew = mismatched.mark();
  mismatched.send({ t: 'watch', projectId: sharedId, core: 'from-the-future' });
  const skewed = await mismatched.expect(m => m.t === 'joined', 'the skewed join', { from: atSkew });
  check(skewed.writable === false && /evaluates mountains differently/i.test(String(skewed.reason)),
    'and an install that would evaluate this mountain differently joins read-only rather than writing geometry '
    + 'the rest of the room disagrees with');
  mismatched.close();

  const edited = mountain('SHARED');
  edited.aiSeed = 77;
  const atAda = ada.mark();
  const atSamPush = sam.mark();
  const byGrace = await saveDocument(service, sharedId, edited,
    { cookie: editorCookie, client: 'grace-1' });
  check(byGrace.status === 200, 'an editor writes a whole document');
  const toAda = await ada.expect(m => m.t === 'revision', 'the push to Ada', { from: atAda });
  const toSam = await sam.expect(m => m.t === 'revision', 'the push to Sam', { from: atSamPush });
  check(toAda.document.aiSeed === 77 && toSam.document.aiSeed === 77
    && toAda.project.revision === byGrace.json.project.revision,
    'everybody else — admin and viewer alike — is pushed the whole revision to replace their replica with');
  atGrace = ada.mark();
  ada.send({ t: 'assign', changes: [['g/spacing', 12]], batch: 3 });
  const adaWrote = await ada.expect(m => m.t === 'landed' && m.batch === 3, 'Ada landing', { from: atGrace });
  check(adaWrote.refused.length === 0,
    'an admin writes while an editor is writing: concurrency is per register, not per document');

  await setUserRole('grace', 'viewer');
  const graceCloseDeadline = Date.now() + 2_000;
  while ((!graceOne.closed || !graceTwo.closed) && Date.now() < graceCloseDeadline) await wait(15);
  check(graceOne.closed && graceTwo.closed,
    'a role change immediately closes every live device authenticated as that member');

  const graceViewer = await openChannel(service,
    { client: 'grace-viewer', cookie: editorCookie, device: 'Phone' });
  const graceViewerWelcome = await graceViewer.expect(m => m.t === 'welcome', 'Grace returning as a viewer');
  graceViewer.send({ t: 'watch', projectId: sharedId });
  const graceViewerJoined = await graceViewer.expect(m => m.t === 'joined' && m.projectId === sharedId,
    'Grace joining under the changed role');
  check(graceViewerWelcome.member.role === 'viewer' && graceViewerJoined.writable === false,
    'the still-valid login reconnects under its current role and can only follow read-only');
  await setUserRole('grace', 'editor');
  const restoredRoleDeadline = Date.now() + 2_000;
  while (!graceViewer.closed && Date.now() < restoredRoleDeadline) await wait(15);
  check(graceViewer.closed, 'restoring a role also replaces the live connection’s captured authority');

  const signedSamOut = await call(service, 'POST', '/api/members/sam/sign-out', { cookie: adminCookie });
  const samCloseDeadline = Date.now() + 2_000;
  while (!sam.closed && Date.now() < samCloseDeadline) await wait(15);
  check(signedSamOut.status === 200 && sam.closed,
    'sign out everywhere closes that member’s already-open WebSocket as well as deleting HTTP sessions');

  graceOne.close();
  graceTwo.close();
  sam.close();
  ada.close();
  await wait(600);
  const sharedRing = await listCheckpoints(sharedId);
  const sessionEnd = sharedRing.checkpoints.find(entry => entry.reason === 'idle');
  check(!!sessionEnd && sessionEnd.members.join(',') === 'ada,grace',
    'the last writer leaving takes one checkpoint crediting everybody who changed the map, and nobody who watched');
} catch (error) {
  recordFailure();
  console.error('FAIL', error);
} finally {
  await service?.close();
  forgetSessions();
  forgetRooms();
  configureAccounts({ required: false, behindProxy: false });
  forgetAccounts();
  forgetRateLimits();
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  delete process.env.SLOPESMITH_MAX_PLAYERS;
  forgetWorkspaceConfig();
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log('SESSIONS PASS');
