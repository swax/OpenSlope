// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import type { MapDataSource } from '../src/shared/map-data';
import { decodeProps } from '../src/core/reference/props';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';

const box = (lo: number, hi: number) =>
  [
    ...[
      [-5, lo, 0],
      [5, lo, 0],
      [5, hi, 0],
      [-5, hi, 0],
      [-5, lo, 200],
      [5, lo, 200],
      [5, hi, 200],
      [-5, hi, 200],
    ].map(v => `v ${v.join(' ')}`),
    ...[
      [1, 2, 3],
      [1, 3, 4],
      [5, 7, 6],
      [5, 8, 7],
      [1, 5, 6],
      [1, 6, 2],
      [4, 3, 7],
      [4, 7, 8],
      [1, 4, 8],
      [1, 8, 5],
      [2, 6, 7],
      [2, 7, 3],
    ].map(f => `f ${f.join(' ')}`),
  ].join('\n');
const half = Math.SQRT1_2;
const object = (mesh: string, Position = [0, 0, 0], Rotation = [0, 0, 0, 1], ParentID = -1) => ({
  Position,
  Rotation,
  Scale: [1, 1, 1],
  ParentID,
  MeshData: [{ MeshPath: mesh, MaterialID: 0 }],
});
const doors = [
  { ...object('a.obj', [500, 0, 0]), MeshData: [] },
  object('a.obj', [-500, 300, 0], [0, 0, half, half], 0),
  object('b.obj', [0, -300, 0], [0, 0, -half, half]),
];
const models = {
  Models: [
    { ModelName: 'two-open-doors', ModelObjects: doors },
    { ModelName: 'identity-panel', ModelObjects: [object('a.obj')] },
    { ModelName: 'another-rest-pose', ModelObjects: [object('a.obj', [-1000, 0, 0])] },
    { ModelName: 'ambiguous-legacy-proxies', ModelObjects: doors },
  ],
};
const rows = [0, 0, 1, 2, 3].map((ModelID, index) => ({
  ModelID,
  InstanceName: `fixture-${index}`,
  Location: [index * 2000, 0, 0],
  Rotation: [0, 0, 0, 1],
  Scale: [1, 1, 1],
  Visable: true,
  PlayerCollision: true,
  PlayerBounce: true,
  U0: 1e30,
  CollsionMode: 1,
  EffectSlotIndex: -1,
  CollsionModelPaths:
    ModelID === 0 ? ['a.obj', 'b.obj'] : ModelID === 3 ? ['a.obj', 'b.obj', 'a.obj', 'b.obj'] : ['a.obj'],
}));
const docs: Record<string, unknown> = {
  'Models.json': models,
  'Instances.json': { Instances: rows },
  'Effects.json': createEmptyEffectsDocument('REST'),
};
const stored = JSON.stringify(docs);
const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    return (docs[path.split('/').at(-1)!] as T) ?? fallback;
  },
  async readTextOrNull(path) {
    return path.endsWith('/a.obj') ? box(0, 300) : path.endsWith('/b.obj') ? box(-300, 0) : null;
  },
  async readBytesOrNull() {
    return null;
  },
  async listEntries() {
    return [];
  },
  async listDir() {
    return [];
  },
  async pathExists() {
    return false;
  },
};
const props = decodeProps(await buildLevelPropsUncached(io, 'REST'));
const open = props.instances.find(row => row.sourceIndex === 0)!;
const keys = open.collisionModels!;
assert.deepEqual(props.instances[1].collisionModels, keys, 'Repeated placements share transformed proxies');
assert.deepEqual(props.instances[2].collisionModels, ['a'], 'An identity rest keeps the source proxy key');
assert.notEqual(
  props.instances[3].collisionModels![0],
  keys[0],
  'A shared source proxy with another model rest cannot overwrite the door',
);
assert.deepEqual(
  props.instances[4].collisionModels,
  ['a', 'b', 'a', 'b'],
  'An ambiguous legacy layout retains the existing whole-instance fallback',
);
const bounds = (positions: Float32Array) =>
  new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(positions, 3));
for (const [index, key] of keys.entries()) {
  const proxy = props.collisionMeshes!.get(key)!;
  const visual = props.models.find(model => model.id === 0)!.subs.find(sub => sub.piece === index + 1)!;
  const a = bounds(proxy.positions),
    b = bounds(visual.positions);
  assert(
    a.min.distanceTo(b.min) < 1e-4 && a.max.distanceTo(b.max) < 1e-4,
    'Each collision panel matches its rendered object, including parent rest transforms',
  );
}
const first = bounds(props.collisionMeshes!.get(keys[0])!.positions);
assert(first.min.distanceTo(new THREE.Vector3(-300, 295, 0)) < 1e-4);
assert(first.max.distanceTo(new THREE.Vector3(0, 305, 200)) < 1e-4);
const other = bounds(props.collisionMeshes!.get(props.instances[3].collisionModels![0])!.positions);
assert.equal(other.min.x, -1005);
const refRoot = new THREE.Group();
const decor = createReferenceDecor({ refRoot, cb: {} } as any, createPropAssets());
decor.setProps(props);
refRoot.updateMatrixWorld(true);
const colliders = decor
  .rideColliders()
  .filter(source => source.object?.kind === 'reference' && source.object.index === 0);
assert(colliders.length === 2 && colliders.every(source => source.solid), 'Door panels retain normal solid collision');
function hits(start: number[], end: number[], sources = colliders): boolean {
  const from = new THREE.Vector3(...start).applyMatrix4(RAW_TO_EDITOR),
    to = new THREE.Vector3(...end).applyMatrix4(RAW_TO_EDITOR);
  const ray = new THREE.Raycaster(from, to.clone().sub(from).normalize(), 0, from.distanceTo(to));
  return sources.some(source => {
    const mesh = new THREE.Mesh(source.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorld.copy(source.matrixWorld);
    return ray.intersectObject(mesh).length > 0;
  });
}
assert(!hits([-100, 100, 100], [100, 100, 100]), 'The open doorway no longer contains the closed-pose wall');
assert(hits([-350, 300, 100], [50, 300, 100]), 'An open door panel still collides at its visible position');
const closed = new THREE.BufferGeometry();
const raw = props.collisionMeshes!.get('a')!;
closed.setAttribute('position', new THREE.BufferAttribute(raw.positions, 3));
closed.setIndex(new THREE.BufferAttribute(raw.indices, 1));
assert(
  hits([-100, 100, 100], [100, 100, 100], [{ ...colliders[0], geometry: closed, matrixWorld: RAW_TO_EDITOR }]),
  'The same passage was blocked by the old untransformed proxy',
);
assert.equal(JSON.stringify(docs), stored, 'Loading preserves stored map geometry, flags and effects');
console.log(
  'PASS: reference proxy rest hierarchy, visible-panel collision, open passage, shared geometry and legacy fallback',
);
