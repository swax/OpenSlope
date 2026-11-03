// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createTerrainLayer, type TerrainLightOptions } from '../src/app/viewport/mesh/terrain';
import type { TerrainBakeInput, TerrainBakeResult } from '../src/core/lighting/terrain-bake';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import type { Stage } from '../src/app/viewport/stage';
import type { TileMaterials } from '../src/app/viewport/mesh/tile-materials';

async function until(check: () => boolean) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    assert(performance.now() < deadline, 'deferred lighting completed before the deadline');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
const doc = blankMountain('BATCH_LIGHT');
doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10];
doc.quads = [[0, 1, 2, 3]];
Object.assign(doc, appendMeshIds(doc, 4, 1));
const preview = buildMountainPreview(doc);
const jobs: { input: TerrainBakeInput; signal?: AbortSignal; finish(result: TerrainBakeResult): void }[] = [];
let applied = 0;
const layer = createTerrainLayer(
  { worldRoot: new THREE.Group() } as Stage,
  {} as TileMaterials,
  { shading: () => 'none', rigData: () => null, rigVisible: () => false },
  {
    onGeometryRebuilt() {},
    onLightingUpdated() {
      applied++;
    },
  },
  {
    deferLighting: true,
    lightingDelayMs: 20,
    lightingClient: {
      prepare: (input, _parts, signal) => new Promise(resolve => jobs.push({ input, signal, finish: resolve })),
    },
  },
);
const options: TerrainLightOptions = {
  dir: [0, 1, 0],
  ambient: 0.2,
  sun: 0.6,
  ao: 1,
  shadow: 1,
  sunTint: [1, 1, 1],
  skyTint: [1, 1, 1],
};
layer.applyPreview(preview);
for (let i = 0; i < 12; i++) layer.setTerrainLight({ ...options, dir: [i / 20, 1, 0] });
assert.equal(jobs.length, 0, 'slider changes never synchronously bake');
await until(() => jobs.length === 1);
assert.deepEqual(jobs[0].input.dir, [11 / 20, 1, 0], 'one batch uses the last slider value');
for (let i = 0; i < 12; i++) layer.invalidateOccluders();
assert(jobs[0].signal!.aborted, 'editing a prop aborts the active bake');
const values = new Float32Array(preview.positions.length / 3).fill(0.75);
jobs[0].finish({ ao: values, shadow: values });
await Promise.resolve();
await Promise.resolve();
assert.equal(applied, 0, 'a superseded result cannot overwrite current lighting');
await until(() => jobs.length === 2);
jobs[1].finish({ ao: values, shadow: values });
await until(() => applied === 1);
assert(Math.abs(layer.terrain.geometry.getAttribute('terrainSun').getX(0) - 0.45) < 1e-6);
for (let i = 0; i < 10; i++) layer.setTerrainLight({ ...options, dir: [11 / 20, 1, 0], sun: i / 10 });
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(jobs.length, 2, 'strength/color changes reuse the prepared occlusion');
layer.updatePatches(new Set([0]), [[0, preview.positions.length / 3]], { geometry: true, materials: false });
assert.equal(jobs.length, 2, 'terrain edits also defer their expensive bake');
await until(() => jobs.length === 3);
layer.setTerrainLight(null);
assert.equal(layer.lightingStale, false, 'the sun-off view never waits for a background lighting bake');
assert(jobs[2].signal!.aborted, 'turning the sun off cancels lighting work');
jobs[2].finish({ ao: values, shadow: values });
await Promise.resolve();
assert.equal(applied, 1);
layer.setTerrainLight(options);
layer.release();
await new Promise(resolve => setTimeout(resolve, 40));
assert.equal(jobs.length, 3, 'releasing a document cancels its scheduled bake');
console.log(
  'TERRAIN LIGHTING UPDATES PASS: trailing batches, current inputs, active cancellation, stale rejection and cheap slider reuse',
);
