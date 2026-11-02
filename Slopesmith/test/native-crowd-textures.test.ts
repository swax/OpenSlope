// tier: fast
import assert from 'node:assert/strict';
import { readCrowdFrames } from '../src/shared/map-crowd';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { decodeProps } from '../src/core/reference/props';
import type { MapDataSource } from '../src/shared/map-data';
import { createAssetReader } from '../src/app/net/asset-reader';
import { crowdAssetManifest, referenceAssetId, type AssetManifest } from '../src/core/reference/asset-manifest';

const native = Array.from({ length: 16 }, (_, i) => `crowd-cd${String(i).padStart(2, '0')}.png`);
const legacy = Array.from({ length: 16 }, (_, i) => `cd${i}.png`);
const files = new Map<string, unknown>([
  ['LOCAL/Models.json', { Models: [] }],
  ['LOCAL/Instances.json', { Instances: [] }],
  ['LOCAL/Crowd.json', { Schema: 'openslope-crowd/v1', Frames: native }],
]);
let listing = [...native, 'placeholder.png'].reverse();
const source: MapDataSource = {
  root: '',
  async readJsonOr<T>(path: string, fallback: T) {
    return structuredClone(files.has(path) ? files.get(path) : fallback) as T;
  },
  async readTextOrNull() {
    return null;
  },
  async readBytesOrNull() {
    return null;
  },
  async listDir() {
    return listing;
  },
  async listEntries() {
    return [];
  },
  async pathExists(path) {
    return files.has(path);
  },
};
assert.deepEqual(
  decodeProps(await buildLevelPropsUncached(source, 'LOCAL')).crowdFrames,
  native,
  'the same prop payload used by local ISO play receives all sixteen native crowd textures',
);
const customOrder = [...native].reverse().map(name => name.replace('crowd-cd', 'authored-frame-'));
customOrder[0] = 'Authored frame.15.PNG';
files.set('LOCAL/Crowd.json', { Schema: 'openslope-crowd/v1', Frames: customOrder });
assert.deepEqual(await readCrowdFrames(source, 'LOCAL'), customOrder, 'the profile owns frame names and display order');
files.delete('LOCAL/Crowd.json');
assert.deepEqual(
  await readCrowdFrames(source, 'LOCAL'),
  native,
  'older native folders without a profile can still discover their crowd bank',
);
listing = [...native, ...legacy].reverse();
assert.deepEqual(
  await readCrowdFrames(source, 'LOCAL'),
  legacy,
  'legacy server maps retain numeric order without mixing two banks',
);
for (const profile of [
  { Schema: 'unknown', Frames: native },
  { Schema: 'openslope-crowd/v1', Frames: native.slice(1) },
  { Schema: 'openslope-crowd/v1', Frames: ['../other.png', ...native.slice(1)] },
]) {
  files.set('LOCAL/Crowd.json', profile);
  await assert.rejects(readCrowdFrames(source, 'LOCAL'), /Invalid crowd frame profile/);
}
const propId = referenceAssetId('ssx-tricky', 'TRICKY_MERQUER', 'prop', '48', 'a'.repeat(64));
const crowdIds = native.map((name, i) =>
  referenceAssetId('ssx-tricky', 'TRICKY_MERQUER', 'texture', name, i.toString(16).padStart(64, '0')),
);
const manifest: AssetManifest = {
  schema: 'openslope-assets/v1',
  game: 'ssx-tricky',
  map: 'TRICKY_MERQUER',
  assets: [propId, ...crowdIds].map((id, i) => ({
    id,
    game: 'ssx-tricky',
    map: 'TRICKY_MERQUER',
    kind: i ? 'texture' : 'prop',
    key: i ? native[i - 1] : '48',
    hash: i ? (i - 1).toString(16).padStart(64, '0') : 'a'.repeat(64),
    files: {},
  })),
};
const reader = createAssetReader(async input => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/levels')
    return Response.json({ levels: ['server:MERQUER'], maps: [{ name: 'server:MERQUER', course: 'TRICKY_MERQUER' }] });
  if (url.pathname === '/api/map-asset-manifest') return Response.json(manifest);
  throw new Error('Crowd resolution must not download prop geometry or image bytes.');
});
assert.deepEqual(
  await reader.crowdFrames(propId, native),
  crowdIds,
  'old prop IDs resolve frames through independent texture identities',
);
assert.deepEqual(await reader.crowdFrames(propId, crowdIds), crowdIds, 'already resolved frames remain stable');
const compact = crowdAssetManifest(manifest);
assert.deepEqual(compact.props, { 48: 'a'.repeat(64) });
assert.deepEqual(Object.values(compact.frames), crowdIds);
assert(!('assets' in compact), 'the crowd view omits full asset dependency records');
const otherProp = referenceAssetId('ssx-tricky', 'TRICKY_MERQUER', 'prop', '49', 'b'.repeat(64));
Object.assign(compact.props, { 49: 'b'.repeat(64) });
let compactReads = 0;
const compactReader = createAssetReader(async input => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/levels') return Response.json({ levels: ['server:TRICKY_MERQUER'] });
  if (url.searchParams.get('level')?.startsWith('local:')) return new Response('', { status: 404 });
  assert.equal(url.searchParams.get('crowd'), '1', 'cached props never need the full server manifest');
  compactReads++;
  return Response.json(compact);
});
const resolved = await Promise.all([
  compactReader.crowdFrames(propId, native),
  compactReader.crowdFrames(
    otherProp,
    [...native].reverse().map(name => name.toUpperCase()),
  ),
]);
assert.deepEqual(resolved, [crowdIds, [...crowdIds].reverse()], 'compact lookup preserves frame identity and order');
assert.equal(compactReads, 1, 'different props share one compact bank lookup');
const unavailable = referenceAssetId('ssx-tricky', 'TRICKY_MERQUER', 'prop', '48', 'f'.repeat(64));
assert.deepEqual(
  await compactReader.crowdFrames(unavailable, native),
  native,
  'a different prop version cannot supply frames',
);
const offline = createAssetReader(async () => {
  throw new Error('Resolved frame identities must not need any metadata or catalogue request.');
});
assert.deepEqual(await offline.crowdFrames(propId, crowdIds), crowdIds);
compactReader.clear();
assert.deepEqual(await compactReader.crowdFrames(propId, native), crowdIds);
assert.equal(compactReads, 2, 'workspace changes refresh the compact descriptor');
const olderServer = createAssetReader(async input => {
  const url = new URL(String(input), 'http://localhost');
  if (url.pathname === '/api/levels') return Response.json({ levels: ['server:TRICKY_MERQUER'] });
  if (url.searchParams.get('level')?.startsWith('local:')) return new Response('', { status: 404 });
  return Response.json(manifest); // Older servers ignore the new query and return the full manifest.
});
assert.deepEqual(
  await olderServer.crowdFrames(propId, native),
  crowdIds,
  'older servers retain full-manifest fallback',
);
console.log('NATIVE CROWD TEXTURES PASS: local payload, profile order, legacy banks and invalid profiles.');
