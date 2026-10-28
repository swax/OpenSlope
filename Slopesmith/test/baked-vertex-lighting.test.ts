// tier: fast
import assert from 'node:assert/strict';
import {
  buildReferenceMesh,
  applyReferenceLightmaps,
  patchLightColor,
  type RawPatch,
} from '../src/core/reference/terrain';
import { readLevelPatches } from '../src/shared/map-levels';
import type { MapDataSource } from '../src/shared/map-data';

const patch: RawPatch = {
  Points: Array.from({ length: 16 }, (_, j) => [Math.floor(j / 4) * 100, (j % 4) * 100, 0]),
  SurfaceType: 1,
  LightmapID: -1,
  LightMapPoint: [0, 0, 0, 0],
  LightColorPoints: Array.from({ length: 16 }, (_, j) => [0.25 + Math.floor(j / 4) / 32, 0.5 + (j % 4) / 16, 1]),
};
const source: MapDataSource = {
  root: 'maps',
  readJsonOr: async <T>(path: string, fallback: T): Promise<T> =>
    path.endsWith('/Patches.json') ? ({ Patches: [patch] } as T) : fallback,
  readTextOrNull: async () => null,
  readBytesOrNull: async () => null,
  listDir: async () => [],
  listEntries: async () => [],
  pathExists: async () => false,
};
const { patches } = await readLevelPatches(source, 'FIXTURE');
assert.deepEqual(
  patches[0].LightColorPoints,
  patch.LightColorPoints,
  'Server and local readers retain baked RGB controls',
);
const mesh = buildReferenceMesh(patches, undefined, 4);
assert.equal(mesh.lightingSource, 'vertex');
assert.deepEqual(
  Array.from(mesh.lightColor!.slice(24, 27)),
  [0.2734375, 0.640625, 1],
  'Geometry axes and color axes agree',
);
assert(Math.abs(mesh.intensity![8] - (0.2734375 * 0.2126 + 0.640625 * 0.7152 + 0.0722)) < 1e-7);
const before = mesh.lightColor;
assert(applyReferenceLightmaps(mesh, patches, new Map()));
assert.equal(mesh.lightColor, before, 'Public Play and study loads preserve source colors without PNG lightmaps');
const signed = patch.LightColorPoints!.map(rgb => [...rgb]);
signed[5] = [-1, 4, 1];
assert.deepEqual(
  patchLightColor(signed, 0.5, 0.5),
  [0.11669921875, 1.0771484375, 1],
  'Signed handles interpolate before clipping',
);
assert.deepEqual(
  patchLightColor(
    Array.from({ length: 16 }, () => [-1, 8, 1]),
    0.5,
    0.5,
  ),
  [0, 255 / 128, 1],
);

const ordinary = { ...patch, LightColorPoints: undefined };
assert.equal(buildReferenceMesh([ordinary]).lightColor, undefined, 'Other games retain their existing lighting path');
const mixed = buildReferenceMesh([patch, ordinary], undefined, 1);
assert.deepEqual(
  Array.from(mixed.lightColor!.slice(12)),
  new Array(12).fill(1),
  'Uncolored patches remain neutral in a mixed quilt',
);
for (const controls of [
  [],
  [[1, 2, 3]],
  Array.from({ length: 16 }, () => [NaN, 0, 0]),
  Array.from({ length: 16 }, () => [17, 0, 0]),
  Array.from({ length: 16 }, () => [0, 0]),
])
  assert.equal(
    buildReferenceMesh([{ ...patch, LightColorPoints: controls }], undefined, 1).lightColor,
    undefined,
    'Malformed controls never contaminate the render buffer',
  );
console.log('PASS: baked terrain RGB reader, bicubic sampling, signed handles, bounds and lightmap independence');
