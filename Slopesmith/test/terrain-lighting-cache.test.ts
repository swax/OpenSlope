// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createTerrainLightingClient,
  terrainLightingKeys,
  type TerrainBakeRequest,
} from '../src/app/viewport/mesh/lighting-client';
import type { TerrainLightingCache } from '../src/app/viewport/mesh/lighting-cache';
import { type TerrainBakeInput, type TerrainBakePart, type TerrainBakeResult } from '../src/core/lighting/terrain-bake';
import { createTerrainLayer } from '../src/app/viewport/mesh/terrain';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import type { Stage } from '../src/app/viewport/stage';
import type { TileMaterials } from '../src/app/viewport/mesh/tile-materials';

const input: TerrainBakeInput = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 10]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 2, 1]),
  dir: [0, 1, 0],
  rig: {
    level: 'test',
    counts: {},
    lights: [
      {
        name: 'lamp',
        kind: 'point',
        category: 'point',
        negative: false,
        pos: [0, 5, 0],
        dir: [0, -1, 0],
        colorHex: '#ffffff',
        intensity: 1,
        coneCos: 1,
        reach: 20,
      },
    ],
  },
};
const original = structuredClone(input);
const parts: TerrainBakePart[] = ['ao', 'shadow', 'glow'];
const keys = await terrainLightingKeys(input);
const turned = structuredClone(input);
turned.dir = [1, 0, 0];
const turnedKeys = await terrainLightingKeys(turned);
assert.equal(keys.ao, turnedKeys.ao, 'sun direction preserves ambient occlusion');
assert.equal(keys.glow, turnedKeys.glow, 'sun direction preserves local lighting');
assert.notEqual(keys.shadow, turnedKeys.shadow, 'sun direction invalidates cast shadows');
const relit = structuredClone(input);
relit.rig!.lights[0].intensity = 2;
const relitKeys = await terrainLightingKeys(relit);
assert.equal(keys.ao, relitKeys.ao);
assert.equal(keys.shadow, relitKeys.shadow);
assert.notEqual(keys.glow, relitKeys.glow, 'local-light changes invalidate only rig glow');
for (const field of ['positions', 'normals', 'indices'] as const) {
  const changed = structuredClone(input);
  changed[field][0] += 1;
  const changedKeys = await terrainLightingKeys(changed);
  for (const part of parts) assert.notEqual(keys[part], changedKeys[part], `${field} invalidates ${part}`);
}
const backed = new Float32Array(input.positions.length + 5);
backed.set(input.positions, 2);
assert.deepEqual(
  await terrainLightingKeys({ ...input, positions: backed.subarray(2, 2 + input.positions.length) }),
  keys,
  'keys cover the view contents rather than unrelated backing-buffer bytes',
);

const rows = new Map<string, Float32Array>();
const cache: TerrainLightingCache = {
  async get(key) {
    return rows.get(key)?.slice();
  },
  async put(key, values) {
    rows.set(key, values.slice());
  },
};
const computations: { input: TerrainBakeInput; parts: TerrainBakePart[] }[] = [];
const compute = (snapshot: TerrainBakeInput, requested: readonly TerrainBakePart[]): TerrainBakeResult => {
  computations.push({ input: snapshot, parts: [...requested] });
  return Object.fromEntries(
    requested.map(part => [part, new Float32Array(snapshot.positions.length / (part === 'glow' ? 1 : 3)).fill(0.5)]),
  );
};
const client = () =>
  createTerrainLightingClient({
    cache,
    createWorker() {
      throw new Error('Worker unavailable');
    },
    fallback: compute,
  });
const cold = await client().prepare(input, parts);
assert.equal(computations.length, 1);
assert.deepEqual(computations[0].parts, parts);
assert.deepEqual(await client().prepare(input, parts), cold, 'a new client restores exact persisted buffers');
assert.equal(computations.length, 1, 'warm restore performs no bake');
await client().prepare(turned, parts);
assert.deepEqual(computations.at(-1)!.parts, ['shadow']);
await client().prepare(relit, parts);
assert.deepEqual(computations.at(-1)!.parts, ['glow']);
rows.set(keys.ao, new Float32Array([NaN, 1, 1]));
await client().prepare(input, parts);
assert.deepEqual(computations.at(-1)!.parts, ['ao'], 'corrupt cache values are recomputed');

const failingCache: TerrainLightingCache = {
  get: async () => {
    throw new Error('blocked');
  },
  put: async () => {
    throw new Error('quota');
  },
};
assert.deepEqual(
  await createTerrainLightingClient({
    cache: failingCache,
    createWorker() {
      throw new Error('blocked');
    },
    fallback: compute,
  }).prepare(input, parts),
  cold,
  'unavailable storage and workers preserve loading through the exact fallback',
);

let terminateCount = 0;
const broken = createTerrainLightingClient({
  cache: failingCache,
  fallback: compute,
  createWorker: () => {
    const worker = {
      onmessage: null as Worker['onmessage'],
      onerror: null as Worker['onerror'],
      onmessageerror: null as Worker['onmessageerror'],
      terminate() {
        terminateCount++;
      },
      postMessage(_request: TerrainBakeRequest) {
        queueMicrotask(() => worker.onmessage?.call(worker as unknown as Worker, { data: null } as MessageEvent));
      },
    };
    return worker;
  },
});
assert.deepEqual(await broken.prepare(input, parts), cold, 'malformed worker responses fall back instead of hanging');
assert.equal(terminateCount, 1);

const cancellation = new AbortController();
let workerStarted!: () => void;
const started = new Promise<void>(resolve => {
  workerStarted = resolve;
});
let canceledWorkers = 0;
const beforeCancel = computations.length;
const cancellable = createTerrainLightingClient({
  cache: failingCache,
  fallback: compute,
  createWorker: () => ({
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage() {
      workerStarted();
    },
    terminate() {
      canceledWorkers++;
    },
  }),
});
const canceled = cancellable.prepare(original, parts, cancellation.signal);
await started;
cancellation.abort();
await assert.rejects(canceled, { name: 'AbortError' });
assert.equal(canceledWorkers, 1, 'superseded worker jobs are terminated');
assert.equal(computations.length, beforeCancel, 'cancellation must not trigger the blocking fallback');

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
try {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  assert.deepEqual(
    await client().prepare(original, parts),
    cold,
    'missing Web Crypto disables caching without blocking lighting',
  );
} finally {
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else Reflect.deleteProperty(globalThis, 'crypto');
}

let releaseReads!: () => void;
const wait = new Promise<void>(resolve => {
  releaseReads = resolve;
});
const held = createTerrainLightingClient({
  cache: {
    get: async () => {
      await wait;
      return undefined;
    },
    put: async () => {},
  },
  createWorker() {
    throw new Error('unavailable');
  },
  fallback: compute,
});
const pending = held.prepare(input, parts);
input.positions[0] = 99;
input.rig!.lights[0].pos[1] = 99;
releaseReads();
await pending;
assert.deepEqual(
  computations.at(-1)!.input,
  original,
  'hashing and computation use one snapshot despite concurrent edits',
);

const doc = blankMountain('ASYNC_LIGHT');
doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10];
doc.quads = [[0, 1, 2, 3]];
Object.assign(doc, appendMeshIds(doc, 4, 1));
const preview = buildMountainPreview(doc);
let finish!: (result: TerrainBakeResult) => void;
const layer = createTerrainLayer(
  { worldRoot: new THREE.Group() } as Stage,
  {} as TileMaterials,
  { shading: () => 'none', rigData: () => null, rigVisible: () => false },
  { onGeometryRebuilt() {} },
  {
    lightingClient: {
      prepare: async () =>
        new Promise<TerrainBakeResult>(resolve => {
          finish = resolve;
        }),
    },
  },
);
layer.applyPreview(preview);
const options = {
  dir: [0, 1, 0] as [number, number, number],
  ambient: 1,
  sun: 0,
  shadow: 0,
  ao: 1,
  sunTint: [1, 1, 1] as [number, number, number],
  skyTint: [1, 1, 1] as [number, number, number],
};
const warming = layer.prepareLighting(options);
layer.release();
finish({ ao: new Float32Array(preview.positions.length / 3) });
assert.equal(await warming, false, 'a result for a released document cannot enter the new terrain');
layer.applyPreview(preview);
const edited = layer.prepareLighting(options);
layer.updatePatches(new Set([0]), [[0, preview.positions.length / 3]], { geometry: true, materials: false });
finish({ ao: new Float32Array(preview.positions.length / 3) });
assert.equal(await edited, false, 'in-place geometry changes invalidate an in-flight result');
const lightChanged = layer.prepareLighting(options);
layer.invalidateRigGlow();
finish({ ao: new Float32Array(preview.positions.length / 3) });
assert.equal(await lightChanged, false, 'light edits invalidate an in-flight result');
layer.release();
let masksReady!: () => void;
let prematureBakes = 0;
const masksPending = new Promise<void>(resolve => {
  masksReady = resolve;
});
const waitingLayer = createTerrainLayer(
  { worldRoot: new THREE.Group() } as Stage,
  {} as TileMaterials,
  { shading: () => 'none', rigData: () => null, rigVisible: () => false, prepareOccluders: () => masksPending },
  { onGeometryRebuilt() {} },
  {
    lightingClient: {
      prepare: async () => {
        prematureBakes++;
        return {};
      },
    },
  },
);
waitingLayer.applyPreview(preview);
const waitingForMasks = waitingLayer.prepareLighting(options);
waitingLayer.release();
masksReady();
assert.equal(await waitingForMasks, false, 'document replacement while textures load cannot start a stale bake');
assert.equal(prematureBakes, 0, 'the bake waits for required mask pixels');
console.log(
  'TERRAIN LIGHTING CACHE PASS: exact keys, selective invalidation, warm reuse, failures, input snapshots and stale-result rejection',
);
