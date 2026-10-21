// tier: fast
import assert from 'node:assert/strict';
import { isoCourseCacheVersion } from '../src/app/public/iso-cache';
import { readLevelLightRig } from '../src/shared/map-levels';
import type { MapDataSource } from '../src/shared/map-data';
import { bakeRigLighting, decodeLightRig } from '../src/core/reference/lights';
import { rigGlints } from '../src/core/lighting/glints';

const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(_path: string, _fallback: T): Promise<T> {
    return {
      Lights: [
        {
          LightName: 'Legacy streamed spotlight',
          Type: 1,
          Colour: [1, 1, 1],
          Direction: [0, 0, -1],
          Position: [0, 0, 1000],
          LowestXYZ: [-1000, -1000, -1000],
          HighestXYZ: [1000, 1000, 2000],
          OuterConeCosine: 0.75,
        },
        {
          LightName: 'Shared cone takes precedence',
          Type: 1,
          Colour: [1, 1, 1],
          UnknownFloat2: 0,
          OuterConeCosine: 0.75,
        },
        {
          LightName: 'Halo',
          Type: 2,
          Colour: [1, 0.5, 0.25],
          SpriteRes: 32,
          Position: [0, 0, 1000],
          LowestXYZ: [0, 0, 1000],
          HighestXYZ: [0, 0, 1000],
        },
      ],
    } as T;
  },
  async readTextOrNull() {
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
  async readBytesOrNull() {
    return null;
  },
};
const payload = await readLevelLightRig(io, 'SSX3_A');
assert(payload);
const rig = decodeLightRig(payload);
assert.equal(rig.lights[0].coneCos, 0.75);
assert.equal(rig.lights[1].coneCos, 0);
const positions = new Float32Array([0, 0, 0, 20, 0, 0]);
const normals = new Float32Array([0, 1, 0, 0, 1, 0]);
const lit = bakeRigLighting(positions, normals, { ...rig, lights: [rig.lights[0]] });
assert(lit[0] > 0, 'The decoded spotlight must illuminate the surface below it');
assert.equal(lit[3], 0, 'The spotlight must leave surfaces outside its cone unlit');
const haloRig = { ...rig, lights: [rig.lights[2]] };
assert.equal(rigGlints(haloRig).length, 1, 'A halo must retain its sparkle');
assert(
  bakeRigLighting(positions, normals, haloRig).every(value => value === 0),
  'A halo must not add diffuse light',
);
assert.equal(isoCourseCacheVersion('SSX3_A'), 7);
assert.equal(isoCourseCacheVersion('SSXOT_ER1_DAY'), 7);
assert.equal(isoCourseCacheVersion('SSX_SNOW'), 3);
assert.equal(isoCourseCacheVersion('GARI'), 1);
console.log('Streamed world fidelity: legacy/shared spotlight cones, halo reach and selective cache refresh PASS');
