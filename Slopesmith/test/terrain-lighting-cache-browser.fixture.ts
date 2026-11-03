import * as THREE from 'three';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { bakeTerrainParts, type TerrainBakeInput } from '../src/core/lighting/terrain-bake';
import { createTerrainLightingClient } from '../src/app/viewport/mesh/lighting-client';
import { createTerrainLightingCache } from '../src/app/viewport/mesh/lighting-cache';
import { createTerrainLayer, type TerrainLightOptions } from '../src/app/viewport/mesh/terrain';
import type { Stage } from '../src/app/viewport/stage';
import type { TileMaterials } from '../src/app/viewport/mesh/tile-materials';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';

function check(value: boolean, message: string) {
  if (!value) throw new Error(message);
}
function equalArrays(actual: ArrayLike<number> | undefined, expected: ArrayLike<number>, message: string) {
  check(
    !!actual && actual.length === expected.length && Array.from(expected).every((v, i) => Object.is(v, actual[i])),
    message,
  );
}

declare global {
  interface Window {
    checkTerrainLighting(): Promise<{ workers: number; heartbeat: number; vertices: number; elapsed: number }>;
    checkLightingEviction(): Promise<void>;
    checkBatchedPropLighting(): Promise<{ workers: number; heartbeat: number; updates: number }>;
    checkMaskedPropLighting(): Promise<{ workers: number; heartbeat: number }>;
  }
}

window.checkTerrainLighting = async () => {
  const doc = blankMountain('CACHE_LIGHT');
  doc.vertices = [0, 0, 0, 10, 0, 0, 0, 5, 10, 10, 5, 10, 0, 0, 20, 10, 0, 20];
  doc.quads = [
    [0, 1, 2, 3],
    [2, 3, 4, 5],
  ];
  Object.assign(doc, appendMeshIds(doc, 6, 2));
  const preview = buildMountainPreview(doc);
  const input: TerrainBakeInput = {
    positions: preview.positions,
    normals: preview.normals,
    indices: preview.indices,
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
          pos: [5, 10, 5],
          dir: [0, -1, 0],
          colorHex: '#fff0d0',
          intensity: 1,
          coneCos: 1,
          reach: 20,
        },
      ],
    },
    occluders: [
      {
        positions: new Float32Array([2, 10, 2, 8, 10, 2, 2, 10, 8, 8, 10, 8]),
        indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
        uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
        mask: { width: 2, height: 2, alpha: new Uint8Array([255, 0, 0, 255]), cutoff: 128 },
      },
    ],
  };
  let workers = 0;
  const client = createTerrainLightingClient({
    createWorker: () => {
      workers++;
      return new Worker('/worker.js', { type: 'module' });
    },
    fallback: () => {
      throw new Error('Browser must use the worker on a cache miss');
    },
  });
  let visible = false;
  const makeLayer = (cached: boolean) =>
    createTerrainLayer(
      { worldRoot: new THREE.Group() } as Stage,
      {} as TileMaterials,
      { shading: () => 'none', rigData: () => input.rig, rigVisible: () => visible, occluders: () => input.occluders! },
      { onGeometryRebuilt() {} },
      cached ? { lightingClient: client } : {},
    );
  const layer = makeLayer(true);
  layer.applyPreview(preview);
  const options: TerrainLightOptions = {
    dir: input.dir,
    ambient: 0.3,
    sun: 0.7,
    ao: 0.4,
    shadow: 0.5,
    sunTint: [1, 0.9, 0.8],
    skyTint: [0.7, 0.8, 1],
  };
  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 5);
  const start = performance.now();
  try {
    check(await layer.prepareLighting(options, true), 'lighting preparation finishes for the live geometry');
  } finally {
    clearInterval(timer);
  }
  const elapsed = performance.now() - start;
  // During boot the desired local-light preference precedes the effective visibility gate.
  layer.setTerrainLight(options);
  visible = true;
  layer.applyTerrainLight();

  const baseline = makeLayer(false);
  baseline.applyPreview(preview);
  baseline.setTerrainLight(options);
  for (const name of ['color', 'terrainSun', 'terrainSky', 'terrainGlow', 'terrainAlbedo', 'terrainLightOptions'])
    equalArrays(
      layer.terrain.geometry.getAttribute(name).array,
      baseline.terrain.geometry.getAttribute(name).array,
      `${name}: cached/worker lighting equals the original full-quality synchronous result`,
    );
  for (const point of [
    [2, 0, 2],
    [5, 5, 10],
  ] as [number, number, number][])
    check(
      layer.groundLightAt(point) === baseline.groundLightAt(point),
      'placed props inherit identical ground lighting',
    );
  // Check the worker's raw output separately from the viewport's color-space conversion/compositing.
  const prepared = await client.prepare(input, ['ao', 'shadow', 'glow']);
  const expected = bakeTerrainParts(input, ['ao', 'shadow', 'glow']);
  for (const part of ['ao', 'shadow', 'glow'] as const)
    equalArrays(prepared[part], expected[part]!, `${part}: exact raw output`);
  layer.release();
  baseline.release();
  return { workers, heartbeat, vertices: preview.positions.length / 3, elapsed };
};

window.checkBatchedPropLighting = async () => {
  const doc = blankMountain('BATCHED_PROPS');
  doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10];
  doc.quads = [[0, 2, 1, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  const preview = buildMountainPreview(doc);
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const occluders = [
    {
      positions: new Float32Array([2, 3, 2, 8, 3, 2, 2, 3, 8, 8, 3, 8]),
      indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
      matrix,
    },
  ];
  let workers = 0,
    heartbeat = 0,
    updates = 0;
  let updated!: () => void;
  let done = new Promise<void>(resolve => {
    updated = resolve;
  });
  const client = createTerrainLightingClient({
    cache: { get: async () => undefined, put: async () => {} },
    createWorker: () => {
      workers++;
      return new Worker('/worker.js', { type: 'module' });
    },
    fallback: () => {
      throw new Error('Prop edits must bake in a worker');
    },
  });
  const layer = createTerrainLayer(
    { worldRoot: new THREE.Group() } as Stage,
    {} as TileMaterials,
    { shading: () => 'none', rigData: () => null, rigVisible: () => false, occluders: () => occluders },
    {
      onGeometryRebuilt() {},
      onLightingUpdated() {
        updates++;
        updated();
      },
    },
    { deferLighting: true, lightingDelayMs: 40, lightingClient: client },
  );
  const timer = setInterval(() => heartbeat++, 1);
  try {
    layer.applyPreview(preview);
    layer.setTerrainLight({
      dir: [0, 1, 0],
      sun: 1,
      ambient: 0.2,
      shadow: 1,
      ao: 0.5,
      sunTint: [1, 1, 1],
      skyTint: [1, 1, 1],
    });
    for (let i = 0; i < 10; i++) {
      matrix[12] = (9 - i) * 2;
      layer.invalidateOccluders();
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    check(workers === 0, 'editing waits for a quiet interval');
    await done;
    check(workers === 1 && updates === 1, 'an edit burst produces exactly one worker bake and display update');
    const sun = layer.terrain.geometry.getAttribute('terrainSun');
    let center = 0;
    for (let i = 0; i < sun.count; i++)
      if (
        Math.hypot(preview.positions[i * 3] - 5, preview.positions[i * 3 + 2] - 5) <
        Math.hypot(preview.positions[center * 3] - 5, preview.positions[center * 3 + 2] - 5)
      )
        center = i;
    check(sun.getX(center) === 0, 'the final prop pose casts its shadow in the actual display buffers');
    done = new Promise(resolve => {
      updated = resolve;
    });
    matrix[12] = 30;
    layer.invalidateOccluders();
    await done;
    check(
      layer.terrain.geometry.getAttribute('terrainSun').getX(center) === 1,
      'moving the prop restores sunlight at its previous position',
    );
    check(workers === 2 && updates === 2, 'a later edit produces one new bake');
    return { workers, heartbeat, updates };
  } finally {
    clearInterval(timer);
    layer.release();
  }
};

window.checkMaskedPropLighting = async () => {
  const assets = createPropAssets();
  assets.registerPropModels({
    level: 'MASK_BROWSER',
    models: [
      {
        id: 0,
        name: 'Fence',
        subs: [
          {
            mat: 0,
            positions: new Float32Array([-1000, 0, 0, 0, 0, 0, -1000, -1000, 0, 0, -1000, 0]),
            indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
            uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
          },
        ],
      },
    ],
    materials: new Map([[0, { tex: 'mask.png', frames: [], pixelAlpha: true }]]),
    instances: [],
    crowdFrames: [],
  });
  let invalidations = 0;
  const props = createPropsLayer(
    {
      worldRoot: new THREE.Group(),
      scene: new THREE.Scene(),
      gizmo: { dragging: false },
      gizmoKind: null,
      cb: {},
      attachGizmo() {},
      detachGizmo() {},
    } as unknown as Stage,
    assets,
    { authoredRigData: null, authoredLightsVisible: false, authoredLights: [] } as never,
    () => invalidations++,
  );
  const placed = {
    id: 'mask-test',
    level: 'MASK_BROWSER',
    model: 0,
    name: 'Fence',
    pos: [0, 3, 0] as [number, number, number],
    yaw: 0,
    scale: 1,
  };
  let workers = 0,
    heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 1);
  try {
    props.setPlacedProps([placed], null);
    const readyMasks = props.prepareLightingOccluders();
    const cancellation = new AbortController();
    const canceled = props.prepareLightingOccluders(cancellation.signal).then(
      () => false,
      error => error instanceof DOMException && error.name === 'AbortError',
    );
    cancellation.abort();
    check(await canceled, 'superseded image preparation cancels without starting a bake');
    check(!props.lightingOccluders()[0].mask, 'pending texture starts with the solid fallback');
    const deadline = performance.now() + 5000;
    while (!props.lightingOccluders()[0]?.mask) {
      check(performance.now() < deadline, 'loaded texture reaches the shadow bake');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await readyMasks;
    check(invalidations === 2, 'texture arrival invalidates the provisional solid shadow exactly once');
    const originalMask = props.lightingOccluders()[0].mask;
    props.setPlacedProps([{ ...placed }], null);
    check(props.lightingOccluders()[0].mask === originalMask && invalidations === 2, 'unchanged pixels reuse the mask');
    const doc = blankMountain('MASK_BROWSER');
    doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10];
    doc.quads = [[0, 2, 1, 3]];
    Object.assign(doc, appendMeshIds(doc, 4, 1));
    const p = buildMountainPreview(doc);
    const input = {
      positions: p.positions,
      normals: p.normals,
      indices: p.indices,
      dir: [0, 1, 0] as [number, number, number],
      rig: null,
      occluders: props.lightingOccluders(),
    };
    const client = createTerrainLightingClient({
      cache: { get: async () => undefined, put: async () => {} },
      createWorker: () => {
        workers++;
        return new Worker('/worker.js', { type: 'module' });
      },
      fallback: () => {
        throw new Error('Masks must work in the actual worker');
      },
    });
    const result = await client.prepare(input, ['shadow', 'ao']);
    const sample = (x: number) => {
      let best = 0,
        dist = Infinity;
      for (let i = 0; i < p.positions.length / 3; i++) {
        const d = Math.hypot(p.positions[i * 3] - x, p.positions[i * 3 + 2] - 5);
        if (d < dist) {
          dist = d;
          best = i;
        }
      }
      return result.shadow![best];
    };
    check(sample(7.5) === 0 && sample(2.5) === 1, 'downloaded PNG alpha passes through the real prop layer and worker');
    const canvas = document.createElement('canvas');
    canvas.width = 4;
    canvas.height = 4;
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'white';
    context.fillRect(0, 0, 4, 4);
    const texture = assets.propTex.texture('MASK_BROWSER', 'mask.png');
    texture.image = canvas;
    texture.needsUpdate = true;
    props.setPlacedProps([placed], null);
    check(
      !props.lightingOccluders()[0].mask && invalidations === 3,
      'replacement pixels invalidate the previous cutout',
    );
    return { workers, heartbeat };
  } finally {
    clearInterval(timer);
    props.stopAssetWatching();
  }
};

window.checkLightingEviction = async () => {
  const cache = createTerrainLightingCache('lighting-eviction-test', 16);
  const now = Date.now;
  let clock = 0;
  Date.now = () => ++clock;
  try {
    await cache.put('a', new Float32Array([1, 2]));
    await cache.put('b', new Float32Array([3, 4]));
    await cache.get('a');
    await cache.put('c', new Float32Array([5, 6]));
    check((await cache.get('b')) === undefined, 'eviction removes the least recently used buffer');
    equalArrays(await cache.get('a'), new Float32Array([1, 2]), 'recently read buffer survives eviction');
    equalArrays(await cache.get('c'), new Float32Array([5, 6]), 'new buffer survives eviction');
    await cache.put('too-large', new Float32Array(5));
    check((await cache.get('too-large')) === undefined, 'oversized entries cannot fill the cache');
  } finally {
    Date.now = now;
  }
};
