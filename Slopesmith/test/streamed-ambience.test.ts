// tier: fast
import assert from 'node:assert/strict';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { decodeProps } from '../src/core/reference/props';
import { ambientSoundUrl } from '../src/app/viewport/scene/ambient-sound';
import type { MapDataSource } from '../src/shared/map-data';

const sound = {
  U0: 0,
  SoundIndex: 57,
  U2: 10,
  U3: 20,
  U4: 30,
  U5: 8000,
  U6: 2,
  SoundBank: 'openslope_ambient',
  SoundSlot: 0,
  Activation: 'Proximity',
};
const instance = {
  ModelID: 0,
  InstanceName: 'lift',
  Location: [100, 200, 300],
  Rotation: [0, 0, 0, 1],
  Scale: [1, 1, 1],
  PlayerCollision: false,
  CollsionMode: 0,
  IncludeSound: true,
  Sounds: { CollisonSound: -1, ExternalSounds: [sound] },
};
const docs: Record<string, unknown> = {
  'maps/SSXOT_A/Instances.json': {
    Instances: [
      instance,
      { ...instance, Sounds: { ExternalSounds: [{ ...sound, SoundBank: '../escape' }] } },
      { ...instance, IncludeSound: false },
    ],
  },
};
const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    return (docs[path] as T) ?? fallback;
  },
  async readTextOrNull() {
    return null;
  },
  async readBytesOrNull() {
    return null;
  },
  async pathExists() {
    return false;
  },
  async listDir() {
    return [];
  },
  async listEntries() {
    return [];
  },
};
const payload = await buildLevelPropsUncached(io, 'SSXOT_A');
assert.equal(payload.instances.length, 2, 'Audio-only placements survive without drawable geometry');
assert.equal(payload.instances[0].xs?.[0].b, 'openslope_ambient');
assert.equal(payload.instances[1].xs?.length ?? 0, 0, 'Invalid explicit routes cannot fall through to legacy IDs');
const decoded = decodeProps(payload);
const emitter = decoded.instances[0].externalSounds[0];
assert.deepEqual(emitter.route, { bank: 'openslope_ambient', slot: 0 });
assert.deepEqual(emitter.offset, [10, 20, 30]);
assert.equal(
  ambientSoundUrl(decoded.level, { key: 'lift', owner: 'ref:0', center: [100, 200, 300], emitter }),
  '/api/effect-sound?level=SSXOT_A&bank=openslope_ambient&slot=0&loop=1',
);
console.log(
  'PASS: common-map emitter packing, geometry-free anchors, explicit bank routing and malformed-route silence',
);
