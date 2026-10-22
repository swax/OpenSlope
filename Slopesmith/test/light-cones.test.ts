// tier: fast
import assert from 'node:assert/strict';
import { readLevelLightRig } from '../src/shared/map-levels';
import type { MapDataSource } from '../src/shared/map-data';
import { authoredReferenceLight, decodeLightRig } from '../src/core/reference/lights';
import { freeLightToPlaced } from '../src/core/lighting/sign-lights';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';

const position = [100, 200, 300];
const rows = [{ Type: 1, Colour: [1, 0.5, 0.25], Position: position, UnknownFloat2: undefined as number | undefined }];
const bytes = new Uint8Array(144 + 92),
  pbd = new DataView(bytes.buffer);
pbd.setUint32(28, 1, true);
pbd.setUint32(88, 144, true);
pbd.setUint32(144, 1, true);
position.forEach((value, i) => pbd.setFloat32(144 + 40 + i * 4, value, true));
pbd.setFloat32(144 + 76, Math.cos((85 * Math.PI) / 180), true);
let files: Record<string, Uint8Array> = { 'WORLD.PBD': bytes };
let reads = 0;
const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>() {
    return { Lights: rows } as T;
  },
  async listDir() {
    return Object.keys(files);
  },
  async readBytesOrNull(path) {
    ++reads;
    return files[path.split('/').at(-1)!] ?? null;
  },
  async readTextOrNull() {
    return null;
  },
  async listEntries() {
    return [];
  },
  async pathExists() {
    return true;
  },
};
const rig = async () => decodeLightRig((await readLevelLightRig(io, 'TEST'))!);
let result = await rig();
assert.equal(result.lights[0].coneSource, 'source');
assert(Math.abs((Math.acos(result.lights[0].coneCos) * 180) / Math.PI - 85) < 0.001);
const copy = authoredReferenceLight(result.lights[0])!;
assert(copy && copy.kind === 'spot' && copy.cone! > 84.99);
copy.cone = 27.5;
assert.equal(freeLightToPlaced(copy, 0).coneCos, Math.cos((27.5 * Math.PI) / 180));
const mountain = defaultMountain();
mountain.lights = [copy];
const restored = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(mountain))));
assert.equal(restored.lights?.[0].cone, 27.5, 'A saved and reopened mountain retains its edited cone');
assert.notDeepEqual(copy.pos, position, 'Reference coordinates are converted into editor metres');
copy.pos[0] += 3;
assert.notEqual(copy.pos[0], result.lights[0].pos[0], 'Copy edits cannot mutate the reference rig');
rows[0].UnknownFloat2 = 0.75;
reads = 0;
result = await rig();
assert.equal(result.lights[0].coneCos, 0.75);
assert.equal(result.lights[0].coneSource, 'export');
assert.equal(reads, 0, 'Existing exported angles do not read source assets');
rows[0].UnknownFloat2 = undefined;
const index = new Uint8Array(88),
  world = new Uint8Array(816 + 76);
const idx = new DataView(index.buffer),
  cell = new DataView(world.buffer);
for (const offset of [40, 44, 48]) idx.setUint32(offset, 1, true);
idx.setUint32(84, world.length, true);
cell.setUint16(40, 1, true);
cell.setUint32(816, 1, true);
position.forEach((value, i) => cell.setFloat32(816 + 36 + i * 4, value, true));
cell.setFloat32(816 + 72, 0.625, true);
files = { 'WORLD.WDX': index, 'WORLD.WDF': world };
result = await rig();
assert.equal(result.lights[0].coneCos, 0.625);
assert.equal(result.lights[0].coneSource, 'source');
rows[0].Position = [900, 200, 300];
assert.equal((await rig()).lights[0].coneSource, 'preview', 'Moved records do not inherit unrelated source angles');
rows[0].Position = position;
files['WORLD.WDF'] = world.subarray(0, 100);
assert.equal((await rig()).lights[0].coneSource, 'preview', 'Damaged optional sources leave the JSON rig usable');
assert.equal(authoredReferenceLight({ ...result.lights[0], negative: true }), null);
console.log('Light cones: PBD/WDF recovery, exported precedence, safe fallback and editable copy PASS');
