// tier: fast
import assert from 'node:assert/strict';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { effectPlayCommand } from '../src/core/effects/play-runtime';
import { decodeProps } from '../src/core/reference/props';
import { decodeReferenceEffects } from '../src/core/reference/effects';
import { readMapEffectsDocument, readReferenceEffects } from '../src/shared/map-effects';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import type { MapDataSource } from '../src/shared/map-data';

const document = createEmptyEffectsDocument('NATIVE');
document.graphs = [{ id: 'graph:0', nodes: [{ id: 'roller', mainType: 0,
  payload: { type0: { SubType: 0, type0Sub0: { U0: 5, U1: 0, U2: 0, U3: 0, U4: 0, U5: 0 } } } }] }];
document.functions = [{ id: 'function:0', name: 'probe', nodes: [
  { id: 'unknown', mainType: 99, payload: {} },
  { id: 'control', mainType: 3, payload: { type3: { U0: 2, U1: 1 } } },
  { id: 'extension', mainType: 0, semanticType: 'x-project.roller', payload: { type0: { SubType: 0 } } },
] }];
document.slots = [{ id: 'slot:0', originalIndex: 0, circumstances: {
  persistent: null, collision: 'graph:0', slot3: null, slot4: null, trigger: null, slot6: null, slot7: null,
} }];
document.physics = [{ id: 'physics:0', originalIndex: 0, data: { ByteSize: 1, Count: 1 } }];
const body = { ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`UFloat${index}`, [15, 19, 23].includes(index) ? 0.0001 : 0])),
  UByteData: btoa(String.fromCharCode(255, 1, 0)),
  uPhysicsStruct0: [{ U0: 100, U1: 0, U2: 1 }, { U0: 50, U1: 50, U2: 8 }],
};
const files = new Map<string, unknown>([
  ['NATIVE/Effects.json', document], ['NATIVE/Physics.json', { PhysicsHeaders: [{ PhysicsDatas: [body] }] }],
  ['NATIVE/Instances.json', { Instances: [{ InstanceName: 'Crash bag', ModelID: -1, Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1],
    CollsionMode: 3, PhysicsIndex: 0, EffectSlotIndex: 0, PlayerCollision: true, PlayerBounce: true, U0: 1 }] }],
]);
const io: MapDataSource = { root: '',
  async readJsonOr<T>(path: string, fallback: T) { return structuredClone(files.has(path) ? files.get(path) : fallback) as T; },
  async readTextOrNull() { return null; }, async readBytesOrNull() { return null; },
  async listDir() { return []; }, async listEntries() { return []; }, async pathExists(path) { return files.has(path); },
};
const data = decodeReferenceEffects(await readReferenceEffects(io, 'NATIVE'));
assert.deepEqual(effectPlayCommand(data.document.graphs[0].nodes[0]), { kind: 'roller', mass: 5, direction: [0, 0, 0] },
  'the native opcode runs as the same Roller command as a Snowknife extract');
assert.equal(data.document.functions[0].nodes[0].semanticType, undefined, 'unknown opcodes remain unknown');
assert.equal(data.document.functions[0].nodes[1].semanticType, undefined, 'receiver-dependent controls are not guessed');
assert.equal(data.document.functions[0].nodes[2].semanticType, 'x-project.roller', 'explicit extensions are preserved');
const props = decodeProps(await buildLevelPropsUncached(io, 'NATIVE'));
assert.equal(props.instances[0].dynamicMass, 5, 'the collision snapshot receives Roller mass');
assert.deepEqual([...props.physicsBodies!.get(0)!], [-50, -50, -50, 50], 'the separate physics pool supplies native collision spheres');
assert(props.physicsMassProps!.get(0)!.invInertia[0] > 0, 'the shove receives the body inertia tensor');
assert.equal(document.graphs[0].nodes[0].semanticType, undefined, 'reading never rewrites the source files');
document.physics[0].data.PhysicsDatas = [{ marker: 'embedded' }];
assert.deepEqual((await readMapEffectsDocument(io, 'NATIVE'))!.physics[0].data.PhysicsDatas, [{ marker: 'embedded' }],
  'existing embedded Snowknife physics takes precedence over a sidecar');
console.log('NATIVE MAP EFFECTS PASS: Roller activation, sidecar shapes/inertia, embedded physics and unknown-node preservation.');
