// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { isSsx3SequenceHelper } from '../src/core/props/course-helpers';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { readReferenceEffects } from '../src/shared/map-effects';
import { decodeProps } from '../src/core/reference/props';
import { decodeReferenceEffects, referenceEffectInstanceIndices } from '../src/core/reference/effects';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { referencePropSlot } from '../src/app/viewport/scene/reference-prop-mesh';
import type { MapDataSource } from '../src/shared/map-data';

const names = [
  'mdl_ESS3_seqpop_1105',
  'mdl_ESS3_seqpopTimer_1000',
  'mdl_ESS3_seqgushTrig_1000',
  'ordinary-crate',
  'mdl_ESS3_seqpopcorn_1000',
  'mdl_ESS3_seqpop_sign',
];
for (const source of ['ssx-3', 'ssx-3-beta', 'SSX3_ESS3', 'SSX3B_ESS3']) {
  for (const name of [...names.slice(0, 3), 'mdl_CRA3_seqpopFlash_1004', 'MDL_ESS3_EZseqPop_1007'])
    assert(isSsx3SequenceHelper(source, name));
  for (const name of [...names.slice(3), 'mdl_ESS3_seqpop__1000', 'mdl_ESS3_seqpop_', 'mdl_er4_seqpop_1000'])
    assert(!isSsx3SequenceHelper(source, name));
  assert(
    !isSsx3SequenceHelper(source, 'ordinary-crate', names[0]),
    'Shared cube model names cannot override placement roles',
  );
  assert(isSsx3SequenceHelper(source, undefined, names[0]), 'An unnamed placement can use its model label');
}
for (const source of ['SSXOT_ER4_DAY', 'GARI', 'CUSTOM']) assert(!isSsx3SequenceHelper(source, names[0]));

for (const level of ['SSX3_ESS3', 'SSX3B_ESS3']) {
  const document = createEmptyEffectsDocument(level);
  document.target.game = level.startsWith('SSX3B_') ? 'ssx-3-beta' : 'ssx-3';
  const rows = names.map((InstanceName, index) => ({
    InstanceName,
    ModelID: 0,
    Location: [index * 300, 0, 0],
    Rotation: [0, 0, 0, 1],
    Scale: [1, 1, 1],
    Visable: true,
    PlayerCollision: true,
    PlayerBounce: true,
    CollsionMode: 2,
    U0: 1e30,
    EffectSlotIndex: -1,
  }));
  const docs: Record<string, unknown> = {
    'Effects.json': document,
    'Instances.json': { Instances: rows },
    'Models.json': {
      Models: [
        {
          ModelName: 'mdl_ESS3_seqpop_1104',
          ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'cube.obj', MaterialID: 0 }] }],
        },
      ],
    },
  };
  const original = JSON.stringify(docs);
  const io: MapDataSource = {
    root: 'maps',
    async readJsonOr<T>(path: string, fallback: T): Promise<T> {
      return (docs[path.split('/').at(-1)!] as T) ?? fallback;
    },
    async readTextOrNull(path) {
      return path.endsWith('.obj') ? 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n' : null;
    },
    async readBytesOrNull() {
      return null;
    },
    async listDir() {
      return [];
    },
    async listEntries() {
      return [];
    },
    async pathExists() {
      return false;
    },
  };
  const props = decodeProps(await buildLevelPropsUncached(io, level));
  const effects = decodeReferenceEffects(await readReferenceEffects(io, level));
  for (const index of [0, 1, 2]) {
    const prop = props.instances[index];
    assert(prop.editorHelper && !prop.visible && !prop.playerCollision && prop.contact === 'ghost');
    assert(effects.instances[index].editorHelper && !effects.instances[index].visible);
    assert.equal(
      effects.instances[index].contact,
      'through',
      'Effect metadata stays nonblocking; props supply contactability',
    );
  }
  assert(props.instances[3].visible && !props.instances[3].editorHelper, 'Shared scenery stays visible');
  assert.deepEqual(referenceEffectInstanceIndices(effects), [0, 1, 2]);
  assert.equal(JSON.stringify(docs), original, 'Old cache files and source geometry stay intact');
  assert.equal(effects.document.graphs.length, 0, 'Do not invent sequence behavior');
  const root = new THREE.Group(),
    ray = new THREE.Raycaster();
  const decor = createReferenceDecor({ refRoot: root, cb: {}, ray } as any, createPropAssets());
  decor.setProps(props);
  decor.setEffectPropIndices(referenceEffectInstanceIndices(effects));
  decor.showProps(true);
  decor.setRuntimeInstanceVisible(0, true);
  decor.setRuntimeInstanceWorldCopies(0, [new THREE.Matrix4()]);
  root.updateMatrixWorld(true);
  let hiddenHelperSlots = 0;
  for (const mesh of decor.propPickGroups[0].children as any[]) {
    const count = mesh.instanceCount ?? mesh.count ?? 0;
    for (let i = 0; i < count; i++)
      if (referencePropSlot(mesh, i)?.inst.editorHelper) {
        hiddenHelperSlots++;
        const matrix = new THREE.Matrix4();
        mesh.getMatrixAt(i, matrix);
        assert(
          [0, 1, 2, 4, 5, 6, 8, 9, 10].every(n => Math.abs(matrix.elements[n]) < 1e-8),
          'Runtime show commands cannot reveal editor-only helper art',
        );
      }
  }
  assert(hiddenHelperSlots >= 3, 'Check the retained helper draw slots');
  assert(
    !decor.propPickGroups[0].children.some(child => child.userData.runtimeInstanceCopies),
    'Helpers do not spawn ride-visible copies',
  );
  const picking = createScenePicking({ ray } as any, {
    authoredPropRoots: () => [],
    referencePropRoots: scope => (scope === 'effects' ? decor.effectPropGroups : decor.propPickGroups),
    lightRoots: () => [],
    sourceRoots: () => [],
    railRoots: () => [],
    gemRoots: () => [],
    knotTargets: () => [],
    surfaceTargets: () => [],
  });
  const normal = new THREE.Vector3(0, 0, 1).transformDirection(RAW_TO_EDITOR);
  const point = new THREE.Vector3(333, 33, 0).applyMatrix4(RAW_TO_EDITOR);
  ray.set(point.clone().addScaledVector(normal, 2), normal.clone().negate());
  assert.equal(picking.pick({ props: 'standard' }), null, 'Helpers are absent from ordinary ride/world picking');
  decor.showEffectProps(true);
  root.updateMatrixWorld(true);
  const hit = picking.pick({ props: 'effects' });
  assert(
    hit?.target === 'prop' && hit.source === 'reference' && hit.sourceIndex === 1,
    'Editor Effects overlay remains inspectable',
  );
  assert(
    decor.rideColliders().every(row => row.object?.kind !== 'reference' || row.object.index > 2),
    'Helpers cannot block riders',
  );
  decor.showEffectProps(false);
  assert.equal(picking.pick({ props: 'effects' }), null, 'Leaving the Effects editor hides the helper overlay');
}
console.log(
  'SSX 3/preview sequence helpers: hidden ride geometry, nonsolid contacts, inspectable Effects overlays and source preservation PASS',
);
