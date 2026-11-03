// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { DEFAULT_SUN, type PlacedProp } from '../src/core/doc/types';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { bakeTerrainParts } from '../src/core/lighting/terrain-bake';
import { lightingGeometry } from '../src/core/lighting/occluders';
import { placedPropOccluders, type ModelGeometry } from '../src/core/export/props';
import { buildLevelFiles } from '../src/core/export/level';
import { terrainLightingKeys } from '../src/app/viewport/mesh/lighting-client';
import { expandGroupProps, type GroupDef } from '../src/core/reference/groups';
import { placementQuat } from '../src/core/props/pose';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import { buildExportFolder } from '../src/core/export/folder';
import type { ExportProvider } from '../src/core/export/provider';
import { textureShadowMask } from '../src/core/lighting/shadow-mask';

const doc = blankMountain('PROP_SHADOW');
doc.vertices = [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10];
doc.quads = [[0, 2, 1, 3]];
Object.assign(doc, appendMeshIds(doc, 4, 1));
doc.sun = { ...DEFAULT_SUN, on: true, el: 90, shadow: 1, ao: 0.5 };
const terrain = buildMountainPreview(doc);
const model: ModelGeometry = {
  subs: [
    {
      mat: -1,
      uvs: [],
      positions: new Float32Array([-300, -300, 0, 300, -300, 0, -300, 300, 0, 300, 300, 0]),
      indices: new Uint32Array([0, 2, 1, 1, 2, 3]),
    },
  ],
};
const prop: PlacedProp = { id: 'prop:0000', level: 'TEST', model: 0, name: 'Canopy', pos: [5, 3, 5], scale: 1, yaw: 0 };
const input = {
  positions: terrain.positions,
  normals: terrain.normals,
  indices: terrain.indices,
  dir: [0, 1, 0] as [number, number, number],
  rig: null,
};
const blockers = placedPropOccluders([prop], () => model);
const baked = bakeTerrainParts({ ...input, occluders: blockers }, ['ao', 'shadow']);
const clear = bakeTerrainParts(input, ['ao', 'shadow']);
let center = 0;
for (let i = 0; i < terrain.positions.length / 3; i++)
  if (
    Math.hypot(terrain.positions[i * 3] - 5, terrain.positions[i * 3 + 2] - 5) <
    Math.hypot(terrain.positions[center * 3] - 5, terrain.positions[center * 3 + 2] - 5)
  )
    center = i;
assert.equal(baked.shadow![center], 0, 'a placed canopy casts a real ground shadow');
assert.equal(clear.shadow![center], 1, 'removing the prop restores direct sun');
assert(
  baked.ao![center] < clear.ao![center] - 0.2,
  `the same prop also blocks ambient sky light: ${baked.ao![center]} vs ${clear.ao![center]}, normal ${terrain.normals.slice(center * 3, center * 3 + 3)}`,
);
assert.equal(baked.ao!.length, terrain.positions.length / 3, 'blockers never add lighting output vertices');
const moved = placedPropOccluders([{ ...prop, pos: [30, 3, 5] }], () => model);
assert.equal(
  bakeTerrainParts({ ...input, occluders: moved }, ['shadow']).shadow![center],
  1,
  'moving the prop moves its shadow off the receiver',
);
const a = await terrainLightingKeys({ ...input, occluders: blockers });
for (const changed of [moved, [], [{ ...blockers[0], positions: blockers[0].positions.map(v => v * 0.5) }]]) {
  const b = await terrainLightingKeys({ ...input, occluders: changed });
  assert.notEqual(a.ao, b.ao);
  assert.notEqual(a.shadow, b.shadow);
  assert.equal(a.glow, b.glow, 'prop occluders preserve the independently cached local-light glow');
}
const group: GroupDef = {
  id: 'pair',
  name: 'Pair',
  props: [
    { model: 0, name: 'Canopy', relPos: [2, 1, 3], relYaw: 40 },
    { model: 0, name: 'Canopy2', relPos: [-2, 1, 3], relYaw: 0 },
  ],
  lights: [],
} as unknown as GroupDef;
const tilted = { ...prop, yaw: 35, pitch: 20, roll: -15, scale: 2 };
const grouped = placedPropOccluders(expandGroupProps(tilted, group), () => model);
assert.equal(grouped[0].positions, grouped[1].positions, 'instances share model buffers');
const rawToEditor = new THREE.Matrix4().set(-0.01, 0, 0, 0, 0, 0, 0.01, 0, 0, -0.01, 0, 0, 0, 0, 0, 1);
const expectedMatrix = new THREE.Matrix4()
  .compose(new THREE.Vector3(...tilted.pos), new THREE.Quaternion(...placementQuat(tilted)), new THREE.Vector3(2, 2, 2))
  .multiply(
    new THREE.Matrix4().compose(
      new THREE.Vector3(2, 1, 3),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (40 * Math.PI) / 180),
      new THREE.Vector3(1, 1, 1),
    ),
  )
  .multiply(rawToEditor);
const expected = new THREE.Vector3(-300, -300, 0).applyMatrix4(expectedMatrix);
const actual = lightingGeometry({ positions: new Float32Array(), indices: new Uint32Array() }, grouped);
assert(
  Math.hypot(actual.positions[0] - expected.x, actual.positions[1] - expected.y, actual.positions[2] - expected.z) <
    1e-5,
  'group offset/yaw and placement tilt/scale match the rendered pose',
);
assert.deepEqual(Array.from(actual.indices.slice(6, 12)), [4, 6, 5, 5, 6, 7], 'instance indices are rebased');

const clearMaps = buildLevelFiles(doc).lightmaps;
const shadowMaps = buildLevelFiles(doc, [], { propOccluders: blockers }).lightmaps;
assert.notDeepEqual(shadowMaps, clearMaps, 'the exported lightmap includes prop shadows and AO');
assert.deepEqual(
  buildLevelFiles(doc, [], { lighting: false, propOccluders: blockers }).lightmaps,
  {},
  'the export lighting toggle still gates the bake',
);

const assets = createPropAssets();
let invalidations = 0;
const propsLayer = createPropsLayer(
  {
    worldRoot: new THREE.Group(),
    scene: new THREE.Scene(),
    gizmo: { dragging: false },
    gizmoKind: null,
    cb: {},
    attachGizmo() {},
    detachGizmo() {},
  } as never,
  assets,
  { authoredRigData: null, authoredLightsVisible: false, authoredLights: [] } as never,
  () => invalidations++,
);
propsLayer.setPlacedProps([prop], null);
assert.equal(propsLayer.lightingOccluders().length, 0, 'loading placeholders cannot cast shadows');
assets.registerPropModels({
  level: prop.level,
  materials: new Map(),
  instances: [],
  crowdFrames: [],
  models: [
    {
      id: 0,
      name: 'Canopy',
      subs: [{ mat: -1, positions: blockers[0].positions, indices: blockers[0].indices, uvs: new Float32Array(8) }],
    },
  ],
});
await Promise.resolve();
assert.equal(propsLayer.lightingOccluders().length, 1, 'late-arriving model geometry enters the bake');
assert.equal(invalidations, 1);
propsLayer.setPlacedProps([{ ...prop }], null);
propsLayer.relightGround();
assert.equal(invalidations, 1, 'selection/re-lighting and unchanged poses never invalidate shadows');
prop.pos[0] += 1;
propsLayer.setPlacedProps([prop], null);
assert.equal(invalidations, 2, 'in-place prop moves invalidate the bake');
const positionAttribute = assets.propGeom.get('TEST:0')![0].geometry.getAttribute('position') as THREE.BufferAttribute;
positionAttribute.needsUpdate = true;
propsLayer.setPlacedProps([prop], null);
assert.equal(invalidations, 3, 'in-place model geometry updates also invalidate the bake');
propsLayer.setPlacedProps([], null);
assert.equal(invalidations, 4, 'deleting props invalidates their shadows');
propsLayer.stopAssetWatching();
prop.pos[0] -= 1;

const provider = {
  groupDefs: async () => new Map(),
  modelGeometry: async () => () => model,
  materialTables: async () => new Map(),
  importedProps: async () => ({ models: [], instances: [] }),
  nativeArt: async () => ({ gemLevel: '', gemTiers: [], railSkins: {} }),
  referenceTexture: async () => new Uint8Array(),
  particleTexture: async () => new Uint8Array(),
  customSound: async () => new Uint8Array(),
  soundIndex: async () => null,
  courseEffectSound: async () => new Uint8Array(),
  namedEffectSound: async () => new Uint8Array(),
  environmentEffectSound: async () => new Uint8Array(),
  skybox: async () => ({ files: [], log: [] }),
  discRecipePaths: async () => ({ exportDir: 'PROP_SHADOW', levelData: 'Maps/TEST', levelDataRelative: '../TEST' }),
  stageRaceMusic: async () => ({ status: 'cleared', files: [], remove: [] }),
  encodePng: async (image: { data: Uint8Array }) => image.data,
} as unknown as ExportProvider;
doc.props = [prop];
const folder = await buildExportFolder(doc, provider);
const mapFile = folder.files.find(file => file.path.startsWith('Lightmaps/'))!;
assert(mapFile, 'full folder export emits a lightmap');
assert.deepEqual(
  mapFile.bytes,
  Object.values(shadowMaps)[0].data,
  'folder export resolves and poses real prop geometry before baking the same terrain shadows',
);
const alphaImage = { w: 2, h: 1, data: new Uint8Array([20, 80, 20, 255, 20, 80, 20, 0]) };
const maskedModel = {
  subs: model.subs.map(sub => ({ ...sub, mat: 0, uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) })),
};
const maskedFolder = await buildExportFolder(doc, {
  ...provider,
  modelGeometry: async () => () => maskedModel,
  materialTables: async () => new Map([['TEST', [{ TexturePath: 'leaves.png', UnknownInt18: 0x40000 }]]]),
  referenceTexture: async () => new Uint8Array([1]),
  decodePng: async () => alphaImage,
});
const maskedBlockers = placedPropOccluders(
  [prop],
  () => maskedModel,
  () => textureShadowMask(alphaImage, { alphaPass: true }),
);
const maskedMaps = buildLevelFiles(doc, [], { propOccluders: maskedBlockers }).lightmaps;
assert.notDeepEqual(maskedMaps, shadowMaps, 'transparent texture holes change exported ground lighting');
assert.deepEqual(
  maskedFolder.files.find(file => file.path.startsWith('Lightmaps/'))!.bytes,
  Object.values(maskedMaps)[0].data,
  'folder export resolves native material alpha and bakes the same cutout mask',
);
console.log(
  'PROP SHADOW BAKE PASS: sun, AO, movement/removal, cache identity, instanced/group poses and exported lightmaps',
);
