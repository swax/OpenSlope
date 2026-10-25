// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { decodeProps, type LevelProps, type PropModel } from '../src/core/reference/props';
import { recordFromReferenceProp } from '../src/core/props/adopt';
import { resolvePropDefaults } from '../src/core/props/defaults';
import { bakePlacedProps, bakeImportedProps, placementMatrix, placementSimilarity } from '../src/core/export/props';
import { buildMaterialCombiner } from '../src/core/export/materials';
import { buildCanonicalProps } from '../src/core/export/canonical-props';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import type { PlacedProp } from '../src/core/doc/types';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import type { MapDataSource } from '../src/shared/map-data';

const model: PropModel = {
  id: 1,
  name: 'Tree with decorative leaves',
  subs: [
    {
      mat: -1,
      positions: new Float32Array([-1000, 0, 1000, 1000, 0, 1000, 0, 1000, 2000]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    },
  ],
  collision: { positions: new Float32Array([-10, 0, 0, 10, 0, 0, 0, 0, 1000]), indices: new Uint32Array([0, 1, 2]) },
  defaults: {
    nativeCollision: { mode: 1, playerCollision: true, responseMass: 1e30, playerBounce: true, bounceAmount: 0 },
  },
};
const props: LevelProps = {
  level: 'AVALANCHE_TEST',
  models: [model],
  instances: [],
  materials: new Map(),
  crowdFrames: [],
};
assert.equal(
  resolvePropDefaults(props.level, 1, props).behaviour.nativeCollision.mode,
  1,
  'source placement policy wins over the static reference collision gate',
);
const adopted = recordFromReferenceProp(props, model, model.name).record;
const decoded = decodeProps({ level: '@import', models: [{ ...adopted, id: 1 }], materials: [], instances: [] });
assert.deepEqual(decoded.models[0].collision, model.collision, 'revise and persistence retain the separate hull');
const assets = createPropAssets();
assets.registerPropModels(props);
assert.equal(assets.propCollision.get('AVALANCHE_TEST:1')?.getIndex()?.count, 3);
const prop: PlacedProp = {
  id: 'tree',
  level: props.level,
  model: 1,
  name: model.name,
  pos: [23, 5, -17],
  yaw: 90,
  pitch: 12,
  roll: 5,
  scale: 2,
  nativeCollision: model.defaults!.nativeCollision,
};
const stage = {
  worldRoot: new THREE.Group(),
  scene: new THREE.Scene(),
  gizmo: { dragging: false },
  gizmoKind: null,
  snapDataPoint: (p: unknown) => p,
  attachGizmo() {},
  detachGizmo() {},
  cb: {},
};
const layer = createPropsLayer(stage as never, assets, {
  authoredRigData: null,
  authoredLightsVisible: false,
  authoredLights: [],
} as never);
layer.setPlacedProps([prop], null);
const colliders = layer.rideColliders();
assert.equal(colliders.length, 1, 'one trunk hull supplies Test collision, regardless of leaf draw meshes');
assert.equal(colliders[0].geometry, assets.propCollision.get('AVALANCHE_TEST:1'));
const before = colliders[0].matrixWorld!.clone();
layer.setPlacedProps([{ ...prop, pos: [33, 5, -17] }], null);
assert(
  Math.abs(layer.rideColliders()[0].matrixWorld!.elements[12] - before.elements[12] - 10) < 1e-6,
  'moving a placed prop moves its hull',
);
const combiner = buildMaterialCombiner(new Map());
for (const bake of [
  bakePlacedProps([prop], () => model, combiner),
  bakeImportedProps([{ ...prop, level: '@import' }], decoded, 0, 0, combiner),
]) {
  assert.equal(bake.groups[0].collision?.positions.length, 9);
  const out = buildCanonicalProps(bake.groups, {
    bakedGroups: bake.bakedGroups,
    propClips: {},
    propPoses: { tree: placementSimilarity(placementMatrix(prop)) },
    collisionSounds: {},
    collisionSoundClips: {},
    ambientSounds: {},
    propBounce: {},
    propSurfaces: {},
    propModePresence: {},
    nativeCollisions: {
      tree: {
        ...prop.nativeCollision!,
        transform: {
          location: placementSimilarity(placementMatrix(prop)).origin,
          rotation: placementSimilarity(placementMatrix(prop)).rotation,
          scale: [2, 2, 2],
        },
      },
    },
    propLighting: {},
    effects: null,
  });
  const proxy = out.text['Collision/prop_0000.obj'];
  assert(proxy);
  const points = proxy
    .split('\n')
    .filter(l => l.startsWith('v '))
    .map(l => l.split(/\s+/).slice(1).map(Number));
  assert.equal(points.length, 3);
  const box = new THREE.Box3().setFromPoints(points.map(p => new THREE.Vector3(...(p as [number, number, number]))));
  assert(
    box.getSize(new THREE.Vector3()).length() < 2100,
    'only the scaled trunk hull reaches native export; the canopy cannot become collision',
  );
  assert(out.text['PropsCollision.obj'].includes('v '), 'the same hull reaches the world collision export');
}
const ghost: PropModel = {
  ...model,
  id: 2,
  collision: undefined,
  defaults: {
    nativeCollision: { mode: 0, playerCollision: false, responseMass: 0, playerBounce: false, bounceAmount: 0 },
  },
};
assert.equal(
  resolvePropDefaults(props.level, 2, { ...props, models: [ghost] }).behaviour.nativeCollision.playerCollision,
  false,
  'standalone foliage remains decorative',
);
assets.propCollision.get('AVALANCHE_TEST:1')?.dispose();
// Loading a real model table keeps the source reference ghost while publishing
// independent authoring defaults/hulls, rather than changing course collision.
const files = new Map<string, string>([
  [
    'TEST/Models.json',
    JSON.stringify({
      Models: [
        {
          ModelName: 'Tree',
          PlacementDefaults: model.defaults,
          PlacementCollisionPath: 'trunk.obj',
          ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }],
        },
      ],
    }),
  ],
  [
    'TEST/Instances.json',
    JSON.stringify({
      Instances: [
        {
          InstanceName: 'Tree reference',
          ModelID: 0,
          Location: [0, 0, 0],
          Rotation: [0, 0, 0, 1],
          Scale: [1, 1, 1],
          Visable: true,
          PlayerCollision: false,
          CollsionMode: 0,
        },
      ],
    }),
  ],
  ['TEST/Materials.json', JSON.stringify({ Materials: [{ TexturePath: null }] })],
  ['TEST/Meshes/tree.obj', 'v -1000 0 1000\nv 1000 0 1000\nv 0 1000 2000\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n'],
  ['TEST/Collision/trunk.obj', 'v -10 0 0\nv 10 0 0\nv 0 0 1000\nf 1 2 3\n'],
]);
const io: MapDataSource = {
  root: '',
  readJsonOr: async <T>(path: string, fallback: T): Promise<T> =>
    files.has(path) ? JSON.parse(files.get(path)!) : fallback,
  readTextOrNull: async path => files.get(path) ?? null,
  listDir: async () => [],
  listEntries: async () => [],
  pathExists: async path => files.has(path),
  readBytesOrNull: async () => null,
};
const loaded = decodeProps(await buildLevelPropsUncached(io, 'TEST'));
assert.equal(loaded.instances[0].contact, 'ghost');
assert.deepEqual(loaded.models[0].collision, model.collision);
assert.equal(resolvePropDefaults('TEST', 0, loaded).source, 'extraction');
const groupAssets = createPropAssets();
groupAssets.registerPropModels({ ...props, models: [model, { ...model, id: 3, name: 'Rock', collision: undefined }] });
groupAssets.registerGroupDefs(props.level, [
  {
    id: 'tree-and-rock',
    name: 'Tree and rock',
    level: props.level,
    occurrences: 1,
    lights: [],
    props: [
      { model: 1, name: model.name, relPos: [0, 0, 0], relYaw: 0 },
      { model: 3, name: 'Rock', relPos: [20, 0, 0], relYaw: 0 },
    ],
  },
]);
const groupLayer = createPropsLayer(stage as never, groupAssets, {
  authoredRigData: null,
  authoredLightsVisible: false,
  authoredLights: [],
} as never);
groupLayer.setPlacedProps([{ ...prop, group: 'tree-and-rock' }], null);
assert.equal(
  groupLayer.rideColliders().length,
  2,
  'a trunk hull must not suppress another group member’s ordinary collision',
);
console.log(
  'PASS: authored copies retain independent hulls through adopt, cache, transform, native export and decorative defaults',
);
