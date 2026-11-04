import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { addUser, setUserRole } from '../src/server/accounts/users';
import { startSession } from '../src/server/accounts/sessions';
import { createAccessToken } from '../src/server/accounts/tokens';
import { isPublished, setPublished } from '../src/server/public-courses';
import { REFERENCE_CHUNK_BYTES, type ReferenceManifest } from '../src/shared/reference-transfer';
import { prepareReferenceMusic } from '../src/app/public/reference-music-preparation';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-reference-maps-'));
const maps = join(root, 'Maps');
await mkdir(maps);
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = maps;
forgetWorkspaceConfig();
forgetAccounts();
const cookies = new Map<string, string>();
let adminId = '';
for (const role of ['admin', 'moderator', 'editor', 'viewer'] as const) {
  const user = await addUser({
    username: role,
    password: 'reference test password',
    role,
    inviteHandle: `test:${role}`,
  });
  cookies.set(role, `slopesmith_session=${await startSession(user.id)}`);
  if (role === 'admin') adminId = user.id;
}
const service = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
async function call(method: string, path = '', body?: unknown, cookie = cookies.get('admin'), headers = {}) {
  const raw = body instanceof Uint8Array;
  const response = await fetch(`${service.url}/api/reference-maps${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? new Uint8Array(body) : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
function fixture(music = false) {
  const files = new Map<string, Buffer>([
    [
      'Patches.json',
      json({
        Patches: [{ Points: Array.from({ length: 16 }, (_, i) => [i, 0, 0]), TexturePath: 'snow.png', LightmapID: -1 }],
      }),
    ],
    [
      'Origin.json',
      json({
        Schema: 'openslope-origin/v1',
        Origin: 'retail',
        RetailData: true,
        Course: 'GARI',
        Game: 'ssx-tricky',
        Reasons: ['retail-extract'],
      }),
    ],
    [
      'Import.json',
      json({
        Schema: 'openslope-native-import/v1',
        Course: 'TRICKY_GARI',
        Game: 'ssx-tricky',
        Complete: false,
        DisplayName: 'Garibaldi',
      }),
    ],
    ['Textures/snow.png', createCanvas(2, 2).toBuffer('image/png')],
    ['Source/GARI.PBD', Buffer.from('retained source sidecar')],
    ['Source/empty.bin', Buffer.alloc(0)],
  ]);
  if (music) files.set('Audio/Music/playlist.json', json([]));
  return files;
}
function manifest(files: Map<string, Buffer>, music = false): ReferenceManifest {
  return {
    course: 'TRICKY_GARI',
    music,
    files: [...files].map(([path, bytes]) => ({
      path,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  };
}
async function upload(files: Map<string, Buffer>, music = false) {
  const started = await call('POST', '/uploads', manifest(files, music));
  assert.equal(started.status, 201, JSON.stringify(started));
  const path = `/uploads/${started.body.id}`;
  const bytes = Buffer.concat([...files.values()]);
  const first = await call('PUT', `${path}?offset=0`, bytes.subarray(0, 17));
  assert.equal(first.body.offset, 17);
  assert.equal(
    (await call('PUT', `${path}?offset=0`, bytes.subarray(0, 17))).status,
    409,
    'duplicate chunks cannot append twice',
  );
  assert.equal((await call('POST', `${path}/complete`)).status, 409, 'incomplete uploads cannot publish');
  assert.equal((await call('GET', path)).body.offset, 17);
  assert.equal((await call('PUT', `${path}?offset=17`, bytes.subarray(17))).status, 200);
  assert.deepEqual((await call('GET')).body.maps, [], 'staging is never advertised');
  return { path, result: await call('POST', `${path}/complete`) };
}
try {
  for (const role of ['moderator', 'editor', 'viewer', 'anonymous'])
    for (const [method, path] of [
      ['GET', ''],
      ['POST', '/uploads'],
      ['POST', '/music'],
      ['PUT', '/uploads/00000000-0000-0000-0000-000000000000?offset=0'],
      ['POST', '/uploads/00000000-0000-0000-0000-000000000000/complete'],
      ['DELETE', '/maps/TRICKY_GARI'],
    ])
      assert.equal(
        (await call(method, path, undefined, cookies.get(role) ?? '')).status,
        role === 'anonymous' ? 401 : 403,
      );
  const key = await createAccessToken(adminId, 'test');
  assert.equal((await call('GET', '', undefined, '', { authorization: `Bearer ${key.token}` })).status, 403);
  assert.equal(
    (await call('POST', '/uploads', manifest(fixture()), undefined, { origin: 'https://elsewhere.invalid' })).status,
    403,
  );
  const bad = manifest(fixture());
  bad.files.push({ ...bad.files[0], path: 'Source/../../escape.json' });
  assert.equal((await call('POST', '/uploads', bad)).status, 400);
  assert.deepEqual(await readdir(maps), []);

  const started = await call('POST', '/uploads', manifest(fixture()));
  const path = `/uploads/${started.body.id}`;
  assert.equal((await call('PUT', `${path}?offset=0`, Buffer.alloc(REFERENCE_CHUNK_BYTES + 1))).status, 413);
  const other = await addUser({
    username: 'otheradmin',
    password: 'another reference password',
    role: 'admin',
    inviteHandle: 'test:other',
  });
  const otherCookie = `slopesmith_session=${await startSession(other.id)}`;
  assert.equal(
    (await call('GET', path, undefined, otherCookie)).status,
    404,
    'uploads belong to their initiating admin',
  );
  await setUserRole('admin', 'viewer');
  assert.equal(
    (await call('PUT', `${path}?offset=0`, Buffer.from('a'))).status,
    403,
    'role changes apply during an upload',
  );
  await setUserRole('admin', 'admin');
  assert.equal((await call('DELETE', path)).status, 200);
  assert.deepEqual(await readdir(maps), [], 'cancellation cleans up');

  const corruptManifest = manifest(fixture());
  corruptManifest.files[0].sha256 = '0'.repeat(64);
  const corrupt = await call('POST', '/uploads', corruptManifest);
  const corruptPath = `/uploads/${corrupt.body.id}`;
  await call('PUT', `${corruptPath}?offset=0`, Buffer.concat([...fixture().values()]));
  assert.match((await call('POST', `${corruptPath}/complete`)).body.error, /hash check/);
  assert.deepEqual(await readdir(maps), [], 'hash failures remove all staging');

  const reserved = await Promise.all([
    call('POST', '/uploads', manifest(fixture())),
    call('POST', '/uploads', manifest(fixture())),
  ]);
  assert(reserved.every(result => result.status === 201));
  assert.equal((await call('POST', '/uploads', manifest(fixture()))).status, 429);
  for (const upload of reserved) await call('DELETE', `/uploads/${upload.body.id}`);

  const broken = fixture();
  broken.set('Patches.json', json({ Patches: [{ Points: [[0, 0, 0]] }] }));
  assert.equal((await upload(broken)).result.status, 400);
  assert.deepEqual(await readdir(maps), [], 'failed validation removes staging');
  const missing = fixture();
  missing.delete('Textures/snow.png');
  assert.match((await upload(missing)).result.body.error, /missing Textures/);
  assert.deepEqual(await readdir(maps), []);

  const uploaded = await upload(fixture());
  assert.equal(uploaded.result.status, 201, JSON.stringify(uploaded.result));
  assert.equal((await readFile(join(maps, 'TRICKY_GARI', 'Source/GARI.PBD'))).toString(), 'retained source sidecar');
  assert.deepEqual(await readdir(join(maps, 'TRICKY_GARI')), [
    'Import.json',
    'Origin.json',
    'Patches.json',
    'Source',
    'Textures',
  ]);
  assert.equal(
    (await call('POST', '/uploads', manifest(fixture()))).status,
    409,
    'existing courses are never overwritten',
  );
  const installed = (await call('GET')).body.maps.find((map: { name: string }) => map.name === 'TRICKY_GARI');
  assert(installed);
  assert.equal(installed.game, 'ssx-tricky');
  assert.equal(installed.origin, 'retail');
  assert.equal(installed.retailData, true);
  const level = await fetch(`${service.url}/api/level?name=TRICKY_GARI`, {
    headers: { cookie: cookies.get('viewer')! },
  });
  assert.equal(level.status, 200, 'the published folder feeds the normal reference readers');
  await setPublished('reference', 'TRICKY_GARI', true, { id: adminId, role: 'admin' });
  assert(await isPublished('reference', 'TRICKY_GARI'));
  assert.equal((await call('DELETE', '/maps/TRICKY_GARI')).status, 200);
  assert(!(await isPublished('reference', 'TRICKY_GARI')), 'removal retires publication');
  assert.deepEqual((await call('GET')).body.maps, []);
  assert.deepEqual(await readdir(maps), []);

  const withMusic = await upload(fixture(true), true);
  assert.equal(withMusic.result.status, 201, JSON.stringify(withMusic.result));
  assert.equal((await readFile(join(maps, 'TRICKY_GARI/Audio/Music/playlist.json'))).toString(), '[]');
  assert.equal((await call('DELETE', '/maps/TRICKY_GARI')).status, 200);
  const target = fixture(true);
  target.set('Source/another-copy.bin', target.get('Source/GARI.PBD')!);
  const donor = new Map(target);
  donor.set(
    'Origin.json',
    json({ Schema: 'openslope-origin/v1', Origin: 'retail', RetailData: true, Course: 'SNOW', Game: 'ssx-tricky' }),
  );
  donor.set(
    'Import.json',
    json({ Schema: 'openslope-native-import/v1', Course: 'SNOW', Game: 'ssx-tricky', Complete: false }),
  );
  donor.set('Source/different-name.bin', donor.get('Source/GARI.PBD')!);
  donor.delete('Source/GARI.PBD');
  donor.delete('Source/another-copy.bin');
  for (const [path, bytes] of donor) {
    const destination = join(maps, 'DONOR', path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
  }
  const reuseManifest = { ...manifest(target, true), reuse: true };
  async function negotiated() {
    const begun = await call('POST', '/uploads', reuseManifest);
    assert.equal(begun.status, 201, JSON.stringify(begun));
    const missing = begun.body.missing as number[];
    const values = [...target.values()];
    const content = Buffer.concat(missing.map(index => values[index]));
    const path = `/uploads/${begun.body.id}`;
    if (content.length) assert.equal((await call('PUT', `${path}?offset=0`, content)).status, 200);
    const result = await call('POST', `${path}/complete`);
    assert.equal(result.status, 201, JSON.stringify(result));
    return { missing, content, plan: begun.body };
  }
  const reused = await negotiated();
  assert(reused.plan.reusedFiles >= 4);
  assert(reused.content.length < Buffer.concat([...target.values()]).length);
  assert(
    !reused.missing.includes([...target.keys()].indexOf('Source/GARI.PBD')),
    'content can be reused under a different filename',
  );
  assert(
    !reused.missing.includes([...target.keys()].indexOf('Source/another-copy.bin')),
    'duplicate content within one upload is sent once',
  );
  assert.equal((await call('DELETE', '/maps/DONOR')).status, 200);
  assert.equal((await readFile(join(maps, 'TRICKY_GARI/Source/GARI.PBD'))).toString(), 'retained source sidecar');
  assert.deepEqual(await readFile(join(maps, 'TRICKY_GARI/Source/another-copy.bin')), target.get('Source/GARI.PBD'));
  for (const [path, bytes] of target) {
    const destination = join(maps, 'Shared', 'depot', path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, bytes);
  }
  assert.equal((await call('DELETE', '/maps/TRICKY_GARI')).status, 200);
  const fullyReused = await negotiated();
  assert.equal(fullyReused.content.length, 0, 'an entirely reusable reference needs no byte upload');
  await rm(join(maps, 'Shared'), { recursive: true, force: true });
  assert.deepEqual(
    await readFile(join(maps, 'TRICKY_GARI/Audio/Music/playlist.json')),
    target.get('Audio/Music/playlist.json'),
  );
  assert.equal((await call('DELETE', '/maps/TRICKY_GARI')).status, 200);

  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'Patches.json'), '{}');
  await writeFile(join(outside, 'outside-source.bin'), target.get('Source/GARI.PBD')!);
  await symlink(outside, join(maps, 'LINKED'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.notEqual((await call('DELETE', '/maps/LINKED')).status, 200, 'removal cannot follow a directory link');
  assert.equal((await readFile(join(outside, 'Patches.json'))).toString(), '{}');
  const noLinks = await call('POST', '/uploads', reuseManifest);
  assert(
    (noLinks.body.missing as number[]).includes([...target.keys()].indexOf('Source/GARI.PBD')),
    'linked files outside the library are not reuse candidates',
  );
  await call('DELETE', `/uploads/${noLinks.body.id}`);
  const sourceIndex = [...target.keys()].indexOf('Source/GARI.PBD');
  await mkdir(join(maps, 'Shared'), { recursive: true });
  const changing = join(maps, 'Shared/changing.dat');
  await writeFile(changing, target.get('Source/GARI.PBD')!);
  const beforeEdit = await call('POST', '/uploads', reuseManifest);
  assert(!(beforeEdit.body.missing as number[]).includes(sourceIndex));
  await call('DELETE', `/uploads/${beforeEdit.body.id}`);
  await writeFile(changing, Buffer.alloc(target.get('Source/GARI.PBD')!.length, 42));
  const afterEdit = await call('POST', '/uploads', reuseManifest);
  assert(
    (afterEdit.body.missing as number[]).includes(sourceIndex),
    'changed donor bytes cannot be reused through a stale hash cache',
  );
  await call('DELETE', `/uploads/${afterEdit.body.id}`);

  const fresh = fixture();
  const freshBytes = Buffer.from('new source bytes that are absent from the server');
  fresh.set('Source/GARI.PBD', freshBytes);
  fresh.set('Source/repeated.bin', freshBytes);
  const freshPlan = await call('POST', '/uploads', { ...manifest(fresh), reuse: true });
  const freshMissing = freshPlan.body.missing as number[];
  assert(freshMissing.includes([...fresh.keys()].indexOf('Source/GARI.PBD')));
  assert(
    !freshMissing.includes([...fresh.keys()].indexOf('Source/repeated.bin')),
    'new repeated content needs only one copy over the network',
  );
  const freshPath = `/uploads/${freshPlan.body.id}`;
  await call('PUT', `${freshPath}?offset=0`, Buffer.concat(freshMissing.map(index => [...fresh.values()][index])));
  assert.equal((await call('POST', `${freshPath}/complete`)).status, 201);
  assert.deepEqual(await readFile(join(maps, 'TRICKY_GARI/Source/repeated.bin')), freshBytes);
  await call('DELETE', '/maps/TRICKY_GARI');
  // Browser SSX 3/beta/On Tour imports already contain Opus, without an upload encoding index.
  const nativeMusic = fixture(true);
  const opus = Buffer.alloc(64);
  opus.write('OggS');
  opus.write('OpusHead', 28);
  nativeMusic.set('Audio/Music/song/chunk_000.opus', opus);
  nativeMusic.set('Audio/Intro/song-C1.opus', opus);
  const unindexed = await upload(nativeMusic, true);
  assert.equal(unindexed.result.status, 400, 'compressed uploads still require their validated index');
  assert.match(unindexed.result.body.error, /missing Audio\/Music\/encoding\.json/);
  const unexpectedConversion = async (): Promise<never> => {
    throw new Error('Native Opus must not be encoded or looked up as WAV.');
  };
  const prepared = await prepareReferenceMusic(
    manifest(nativeMusic, true).files.map(file => ({
      ...file,
      blob: new Blob([new Uint8Array(nativeMusic.get(file.path)!)]),
    })),
    unexpectedConversion,
    unexpectedConversion,
    new AbortController().signal,
    () => {},
  );
  const indexedMusic = new Map(
    await Promise.all(
      (await prepared.files()).map(async file => [file.path, Buffer.from(await file.blob!.arrayBuffer())] as const),
    ),
  );
  const compressedUpload = await upload(indexedMusic, true);
  assert.equal(compressedUpload.result.status, 201, JSON.stringify(compressedUpload.result));
  assert.deepEqual(await readFile(join(maps, 'TRICKY_GARI/Audio/Music/song/chunk_000.opus')), opus);
  assert.deepEqual(await readFile(join(maps, 'TRICKY_GARI/Audio/Intro/song-C1.opus')), opus);
  await call('DELETE', '/maps/TRICKY_GARI');
  assert.notEqual((await call('DELETE', '/maps/..%2Foutside')).status, 200);
  console.log('Admin-only reference upload, chunk recovery, validation, source/music preservation and removal PASS');
} finally {
  await service.close();
  await rm(root, { recursive: true, force: true });
}
