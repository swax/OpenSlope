// tier: fast
import assert from 'node:assert/strict';
import { readCrowdFrames } from '../src/shared/map-crowd';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { decodeProps } from '../src/core/reference/props';
import type { MapDataSource } from '../src/shared/map-data';

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
console.log('NATIVE CROWD TEXTURES PASS: local payload, profile order, legacy banks and invalid profiles.');
