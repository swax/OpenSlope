// tier: fast
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readReferenceEffects } from '../src/shared/map-effects';
import type { MapDataSource } from '../src/shared/map-data';
import { decodeReferenceEffects, referenceInstanceBindings } from '../src/core/reference/effects';
import type { EffectsDocument } from '../src/core/effects/document';

const circumstances = (collision: string) => ({
  persistent: null,
  collision,
  slot3: null,
  slot4: null,
  trigger: null,
  slot6: null,
  slot7: null,
});
const old: EffectsDocument = {
  kind: 'openslope-effects',
  version: 1,
  header: { U1: 0, U2: 0, U3: 0 },
  target: { game: 'ssx-3', platform: 'ps2', region: 'unknown', level: 'SSX3_EBA3' },
  graphs: ['openslope-playtest:reset', 'authored-reset'].map(id => ({
    id,
    nodes: [{ id: `${id}:node`, mainType: 13, semanticType: 'rider.reset', payload: {} }],
  })),
  slots: [
    { id: 'openslope-playtest:reset:slot', originalIndex: 0, circumstances: circumstances('openslope-playtest:reset') },
    { id: 'authored-slot', originalIndex: 1, circumstances: circumstances('authored-reset') },
  ],
  functions: [],
  objectProperties: [],
  instances: [],
  physics: [],
  collisionModels: [],
  splines: [],
};
const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    if (path.endsWith('/Effects.json')) return structuredClone(old) as T;
    if (path.endsWith('/Instances.json'))
      return {
        Instances: [
          {
            InstanceName: 'mdl_E_EBA3_reset_plane_1011',
            ModelID: 0,
            EffectSlotIndex: 0,
            Visable: false,
            PlayerCollision: true,
            PlayerBounce: false,
            U0: 0,
            CollsionMode: 2,
          },
          { InstanceName: 'Authored recovery', ModelID: 0, EffectSlotIndex: 1, PlayerCollision: true, CollsionMode: 2 },
        ],
      } as T;
    return fallback;
  },
  async readTextOrNull() {
    return null;
  },
  async readBytesOrNull() {
    return null;
  },
  async listDir() {
    return [];
  },
  async listEntries() {
    return [];
  },
  async pathExists() {
    return true;
  },
};
const data = decodeReferenceEffects(await readReferenceEffects(io, 'SSX3_EBA3'));
assert.deepEqual(
  referenceInstanceBindings(data, data.instances[0]),
  [],
  'A former reset box at spawn cannot dispatch resets',
);
const real = referenceInstanceBindings(data, data.instances[1]);
assert.equal(real.length, 1);
assert.equal(real[0].graph.nodes[0].semanticType, 'rider.reset', 'Authored reset behavior survives retirement');
assert.equal(
  old.slots[0].circumstances.collision,
  'openslope-playtest:reset',
  'Stored/imported document is not rewritten',
);
assert.deepEqual(
  data.document.slots.map(slot => slot.id),
  old.slots.map(slot => slot.id),
  'Stable slot ordering survives',
);

// Optional scratch extraction checks the actual course data without loading a device-local mountain draft.
if (process.argv[2]) {
  const root = resolve(process.argv[2]);
  const disk: MapDataSource = {
    ...io,
    root,
    async readJsonOr<T>(path: string, fallback: T): Promise<T> {
      try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
        throw error;
      }
    },
  };
  const raw = JSON.parse(await readFile(join(root, 'SSX3_EBA3/Instances.json'), 'utf8'));
  const actual = decodeReferenceEffects(await readReferenceEffects(disk, 'SSX3_EBA3'));
  const inferred = actual.instances.filter(instance => raw.Instances[instance.index].EffectSlotIndex >= 0);
  assert(inferred.length > 0, 'Scratch fixture must contain the earlier generated boxes');
  assert(inferred.every(instance => referenceInstanceBindings(actual, instance).length === 0));
  console.log(`PASS: ${inferred.length} old SSX3_EBA3 reset boxes cannot dispatch recovery`);
}
console.log('PASS: inferred reset retirement preserves authored effects and cached documents');
