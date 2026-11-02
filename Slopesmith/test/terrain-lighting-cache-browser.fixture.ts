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
      { shading: () => 'none', rigData: () => input.rig, rigVisible: () => visible },
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
