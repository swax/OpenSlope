// tier: fast
import assert from 'node:assert/strict';
import { decodeReferenceLightmap, referenceLightmapEncoding } from '../src/core/reference/lightmap';
import { decodeLightmapTexel } from '../src/core/lighting/bake';
import type { RawPatch } from '../src/core/reference/terrain';
import { readLevelPatches } from '../src/shared/map-levels';
import type { MapDataSource } from '../src/shared/map-data';

const patch = (encoding?: RawPatch['LightmapEncoding']): RawPatch => ({
  Points: [],
  SurfaceType: 1,
  LightmapID: 3,
  ...(encoding ? { LightmapEncoding: encoding } : {}),
});
assert.equal(referenceLightmapEncoding([patch()], 3), 'gs');
assert.equal(referenceLightmapEncoding([patch('rgb-multiply')], 3), 'rgb-multiply');
assert.throws(() => referenceLightmapEncoding([patch(), patch('rgb-multiply')], 3), /Mixed encodings/);
const pixel = [64, 128, 192, 255];
const gs = decodeReferenceLightmap(pixel, 'gs');
const original = decodeLightmapTexel(...(pixel as [number, number, number, number]));
for (let i = 0; i < 3; i++) assert(Math.abs(gs.rgb[i] - original[i]) < 1e-7);
const direct = decodeReferenceLightmap(pixel, 'rgb-multiply');
for (let i = 0; i < 3; i++) assert(Math.abs(direct.rgb[i] - pixel[i] / 255) < 1e-7);
assert(direct.a[0] > 0.4 && direct.a[0] < 0.6);
// Public ISO Play and the server API both trim imported patches through this reader.
const io = {
  root: '',
  async readJsonOr(path: string, fallback: unknown) {
    return path.endsWith('Patches.json') ? { Patches: [patch('rgb-multiply'), patch()] } : fallback;
  },
} as MapDataSource;
const loaded = await readLevelPatches(io, 'AVALANCHE_CRS02_02');
assert.equal(loaded.patches[0].LightmapEncoding, 'rgb-multiply', 'Map reader must retain RGB lightmap encoding');
assert.equal(loaded.patches[1].LightmapEncoding, undefined, 'Legacy encoding must remain optional');
const publicEncoding = referenceLightmapEncoding([loaded.patches[0]], 3);
assert.deepEqual(
  Array.from(decodeReferenceLightmap([255, 255, 255, 255], publicEncoding).rgb),
  [1, 1, 1],
  'White imported lighting must stay white through the public map reader and decoder',
);
console.log('Reference residual/RGB lightmap decoding, default compatibility and mixed-page rejection: PASS');
