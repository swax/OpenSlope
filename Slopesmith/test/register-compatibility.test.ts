import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { applyRegisters } from '../src/core/doc/registers';
import { CORE_VERSION } from '../src/core/session/protocol';
import { forgetAccounts } from '../src/server/accounts/store';
import { startApiService, type ApiService } from '../src/server/main';
import { checkpointNow, createProject } from '../src/server/projects';
import { configureRooms, forgetRooms, roomFor } from '../src/server/session/room';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';

// Core 2 understands whole objects only. Exercise socket edits, HTTP edits, seating, reverts, and catch-up with
// both versions connected, checking the actual wire keys before applying them to the older replica.
interface Message {
  t: string;
  at: number;
  room: string;
  writable: boolean;
  changes: [string, unknown?][];
  steps?: unknown;
}
interface Client { socket: WebSocket; messages: Message[] }

const root = mkdtempSync(join(tmpdir(), 'slopesmith-register-compatibility-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
forgetAccounts();
configureRooms({ snapshotIdleMs: 60_000, snapshotChanges: 1 << 30 });
const clients: Client[] = [];
let service: ApiService | undefined;

async function message(client: Client, type: string, from = 0): Promise<Message> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const found = client.messages.slice(from).find(entry => entry.t === type);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${type}`);
    await new Promise<void>(done => setTimeout(done, 10));
  }
}

try {
  const document = migrateMountain(defaultMountain());
  const corners = document.quads[0];
  const x = corners.reduce((sum, at) => sum + document.vertices[at * 3], 0) / corners.length;
  const z = corners.reduce((sum, at) => sum + document.vertices[at * 3 + 2], 0) / corners.length;
  document.props = [{ id: 'prop:compat', level: 'Custom', model: 0, name: 'Compatibility',
    pos: [x, 1_000_000, z], yaw: 0, scale: 1 }];
  const created = await createProject(document);
  const projectId = created.project.id;
  const checkpoint = await checkpointNow(projectId, { reason: 'named', note: 'Before editing' });
  assert(checkpoint);
  const olderReplica = structuredClone(created.document);
  service = await startApiService({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${service.port}`;

  async function open(core: string): Promise<Client> {
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}/api/session?client=compat-${clients.length}`);
    const client: Client = { socket, messages: [] };
    clients.push(client);
    socket.addEventListener('message', event => client.messages.push(JSON.parse(String(event.data)) as Message));
    await message(client, 'welcome');
    socket.send(JSON.stringify({ t: 'watch', projectId, doc: 3, core }));
    await message(client, 'joined');
    return client;
  }
  async function post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${url}/api/projects/${projectId}/${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, await response.text());
  }
  function followLegacy(update: Message): void {
    assert(update.changes.every(([key]) => !key.startsWith('o/') || !key.slice(2, key.indexOf('/', 2)).includes('.')),
      'a legacy client must never receive object-field keys');
    const applied = applyRegisters(olderReplica, update.changes.map(([key, value]) => [key, value]));
    assert.equal(applied.refused, 0);
    assert.deepEqual(olderReplica.props, roomFor(projectId)!.doc.props);
  }

  const writer = await open(CORE_VERSION);
  const current = await open(CORE_VERSION);
  const older = await open(String(Number(CORE_VERSION) - 1));
  const joined = await message(older, 'joined');
  assert.equal(joined.writable, false);
  assert.equal((await message(current, 'joined')).writable, true);
  let oldFrom = older.messages.length;
  const currentFrom = current.messages.length;
  const writerFrom = writer.messages.length;
  writer.socket.send(JSON.stringify({ t: 'assign', batch: 1, changes: [
    ['o/prop.yaw/prop:compat', 45], ['o/prop.scale/prop:compat', 2],
  ] }));
  const live = await message(older, 'sync', oldFrom);
  assert.deepEqual(live.changes.map(([key]) => key), ['o/prop/prop:compat'], 'one whole object covers both fields');
  followLegacy(live);
  assert.deepEqual((await message(current, 'sync', currentFrom)).changes,
    [['o/prop.yaw/prop:compat', 45], ['o/prop.scale/prop:compat', 2]], 'current clients keep field updates');
  assert(!writer.messages.slice(writerFrom).some(entry => entry.t === 'sync'), 'the sender does not receive its own relay');

  oldFrom = older.messages.length;
  await post('registers', { changes: [{ key: 'o/prop.yaw/prop:compat', value: 90 }] });
  followLegacy(await message(older, 'sync', oldFrom));
  assert.equal(olderReplica.props![0].yaw, 90, 'HTTP field edits reach older clients');

  oldFrom = older.messages.length;
  await post('seat', { ids: ['prop:compat'] });
  followLegacy(await message(older, 'sync', oldFrom));
  assert(olderReplica.props![0].pos[1] < 1_000_000, 'seating reaches older clients too');
  assert.equal(olderReplica.props![0].yaw, 90, 'seating keeps the other fields');

  oldFrom = older.messages.length;
  older.socket.send(JSON.stringify({ t: 'watch', projectId, at: joined.at, room: joined.room, doc: 3, core: '2' }));
  const caughtUp = await message(older, 'caught-up', oldFrom);
  assert.equal(caughtUp.steps, undefined, 'older clients receive flat assignments');
  assert.deepEqual(caughtUp.changes.map(([key]) => key), ['o/prop/prop:compat']);
  followLegacy(caughtUp);

  oldFrom = older.messages.length;
  await post(`checkpoints/${encodeURIComponent(checkpoint.file)}/revert`, {});
  followLegacy(await message(older, 'sync', oldFrom));
  assert.deepEqual(olderReplica.props, created.document.props, 'checkpoint reverts reach older clients');

  oldFrom = older.messages.length;
  writer.socket.send(JSON.stringify({ t: 'assign', batch: 2, changes: [['o/prop/prop:compat']] }));
  const deleted = await message(older, 'sync', oldFrom);
  assert.deepEqual(deleted.changes, [['o/prop/prop:compat']], 'a deletion is still encoded as a key alone');
  followLegacy(deleted);
  oldFrom = older.messages.length;
  older.socket.send(JSON.stringify({ t: 'watch', projectId, at: joined.at, room: joined.room, doc: 3, core: '2' }));
  const afterDelete = await message(older, 'caught-up', oldFrom);
  assert.deepEqual(afterDelete.changes, [['o/prop/prop:compat']], 'catch-up does not recreate an object edited then deleted');
  followLegacy(afterDelete);
  console.log('Legacy object updates, current field updates, HTTP edits, seating, reverts, and catch-up passed.');
} finally {
  for (const client of clients) client.socket.close();
  await service?.close();
  forgetRooms();
  const target = resolve(root);
  assert(target.startsWith(resolve(tmpdir()) + sep) && target.includes('slopesmith-register-compatibility-'));
  rmSync(target, { recursive: true, force: true });
}
