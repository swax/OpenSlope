// tier: fast
import assert from 'node:assert/strict';
import {
  isOnTourBoundaryHelper,
  isOnTourCourseHelper,
  prepareOnTourCourseHelpers,
} from '../src/core/props/course-helpers';
import * as THREE from 'three';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { resolvePropDefaults } from '../src/core/props/defaults';
import { placedPropCollisionProfile } from '../src/core/props/contact';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { readReferenceEffects } from '../src/shared/map-effects';
import { decodeProps, type LevelProps } from '../src/core/reference/props';
import {
  decodeReferenceEffects,
  referenceEffectInstanceIndices,
  referenceInstanceBindings,
} from '../src/core/reference/effects';
import type { MapDataSource } from '../src/shared/map-data';
import type { EffectsDocument } from '../src/core/effects/document';

for (const name of ['mdl_er4_impassableleft_17', 'MDL_WR1_IMPASSABLERIGHT_1009', 'mdl_vh1_impassableleft'])
  assert(isOnTourBoundaryHelper('SSXOT_ER4_DAY', name));
for (const name of [
  'fence_proxy',
  'impassableleft',
  'mdl_er4_impassableleft_sign',
  'mdl_er4_impassableleft_',
  'mdl_er4_impassableleft_17_extra',
  'mdl_er44_impassableleft_17',
  'mdl_er4_impassableleftover_17',
])
  assert(!isOnTourBoundaryHelper('SSXOT_ER4_DAY', name));
assert(!isOnTourBoundaryHelper('SSX3_PEAK1', 'mdl_er4_impassableleft_17'));
assert(!isOnTourBoundaryHelper('MY_MAP', 'mdl_er4_impassableleft_17'));
for (const name of [
  'mdl_er4_trg_fw_archlights',
  'mdl_er4_trg_fw_archlights_4_1001',
  'mdl_er4_trg_fw_finish_1000',
  'mdl_er4_trg_fw_finish_final_9999',
  'MDL_ER4_TRG_FW_START_1000',
])
  assert(isOnTourCourseHelper('ssx-on-tour', name));
for (const name of [
  'mdl_er4_trg_fw_archlights_',
  'mdl_er4_trg_fw_finish_sign',
  'mdl_er4_emt_fw_archlights_1_1001',
  'mdl_er4_trg_fw_finish_finale_1000',
  'mdl_er4_trg_fw_archlights__4',
  'mdl_er4_trg_fw_archlights_4_',
])
  assert(!isOnTourCourseHelper('ssx-on-tour', name));
assert(!isOnTourCourseHelper('SSX3_PEAK1', 'mdl_er4_trg_fw_finish_1000'));

const graph: EffectsDocument = {
  kind: 'openslope-effects',
  version: 1,
  header: { U1: 0, U2: 0, U3: 0 },
  target: { game: 'ssx-on-tour', platform: 'ps2', region: 'unknown', level: 'SSXOT_ER4_DAY' },
  graphs: [{ id: 'authored-reset', nodes: [{ id: 'reset', mainType: 13, semanticType: 'rider.reset', payload: {} }] }],
  slots: [
    {
      id: 'slot',
      originalIndex: 0,
      circumstances: {
        persistent: 'authored-reset',
        collision: 'authored-reset',
        slot3: null,
        slot4: null,
        trigger: null,
        slot6: null,
        slot7: null,
      },
    },
  ],
  functions: [],
  instances: [],
  objectProperties: [],
  physics: [],
  collisionModels: [],
  splines: [],
};
const base = {
  ModelID: 0,
  Location: [0, 0, 0],
  Rotation: [0, 0, 0, 1],
  Scale: [1, 1, 1],
  Visable: true,
  PlayerCollision: true,
  PlayerBounce: true,
  U0: 1e30,
  CollsionMode: 2,
  EffectSlotIndex: 0,
};
const rows = [
  { ...base, InstanceName: 'mdl_er4_impassableleft_17' },
  { ...base, InstanceName: 'older_instance_name', ModelID: 1 },
  { ...base, InstanceName: 'fence_proxy' },
  { ...base, InstanceName: 'mdl_er4_trg_fw_archlights_4_1001', Location: [300, 0, 0] },
  { ...base, InstanceName: 'mdl_er4_trg_fw_finish_final_9999' },
  { ...base, InstanceName: 'mdl_er4_trg_fw_start_1000', CollsionMode: 0, EffectSlotIndex: -1 },
];
const modelObjects = [{ ParentID: -1, MeshData: [{ MeshPath: 'triangle.obj', MaterialID: 0 }] }];
const models = {
  Models: [
    { ModelName: 'ordinary', ModelObjects: modelObjects },
    { ModelName: 'mdl_er4_impassableright_30', ModelObjects: modelObjects },
  ],
};
const stored = JSON.stringify(rows);
const docs: Record<string, unknown> = {
  'Instances.json': { Instances: rows },
  'Models.json': models,
  'Effects.json': graph,
};
const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    return (docs[path.split('/').at(-1)!] as T) ?? fallback;
  },
  async readTextOrNull(path: string) {
    return path.endsWith('/triangle.obj') ? 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n' : null;
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
const payload = await buildLevelPropsUncached(io, 'SSXOT_ER4_DAY');
const props = decodeProps(payload);
for (const index of [0, 1, 3, 4]) {
  const helper = props.instances.find(row => row.sourceIndex === index);
  assert(helper && !helper.visible && helper.playerCollision && helper.contact === 'through' && helper.editorHelper);
  assert(!helper.playerBounce && helper.responseMass === 0 && helper.surface === -1);
}
assert.equal(props.instances.find(row => row.sourceIndex === 5)?.contact, 'ghost', 'No invented trigger shape');
const fence = props.instances.find(row => row.sourceIndex === 2)!;
assert(fence.visible && fence.playerCollision && fence.contact === 'solid');
const effects = decodeReferenceEffects(await readReferenceEffects(io, 'SSXOT_ER4_DAY'));
for (const helper of [effects.instances[0], effects.instances[1], effects.instances[3], effects.instances[4]]) {
  assert.equal(helper.visible, false);
  assert.equal(helper.contact, 'through');
  assert.equal(referenceInstanceBindings(effects, helper).length, 2, 'Keep authored common effect bindings');
}
assert.equal(referenceInstanceBindings(effects, effects.instances[2]).length, 2);
assert.equal(effects.instances[5].editorHelper, true, 'Effects selection receives the helper classification too');
assert(referenceEffectInstanceIndices(effects).includes(5), 'An untranslated helper stays in the Effects host set');
assert.equal(effects.instances[2].editorHelper, undefined, 'Ordinary scenery does not become a helper');
assert.equal(JSON.stringify(rows), stored, 'Source caches and reference geometry are never rewritten');
assert.equal(graph.slots[0].circumstances.collision, 'authored-reset');
assert.deepEqual(
  prepareOnTourCourseHelpers('GARI', rows, id => models.Models[id]?.ModelName),
  rows,
);

const library = { models: [{ id: 1, name: 'mdl_er4_impassableleft_17' }], instances: [] } as unknown as LevelProps;
const defaults = resolvePropDefaults('SSXOT_ER4_DAY', 1, library);
assert.equal(
  defaults.behaviour.nativeCollision.playerCollision,
  false,
  'A hidden helper never falls back to a solid stamp',
);
const explicit = { mode: 2 as const, playerCollision: true, playerBounce: true, responseMass: 1e30, bounceAmount: 0.5 };
assert.equal(
  placedPropCollisionProfile({ level: 'SSXOT_ER4_DAY', nativeCollision: explicit }),
  explicit,
  'Existing explicit authored collision profiles remain under author control',
);

// Exercise the actual renderer: untranslated hosts get a pickable Effects overlay, never ordinary art.
let picked = -1;
const refRoot = new THREE.Group();
const ray = new THREE.Raycaster();
const decor = createReferenceDecor(
  {
    refRoot,
    cb: {
      onSelectReferenceProp(_level: unknown, _model: unknown, _name: unknown, inst: { sourceIndex: number }) {
        picked = inst.sourceIndex;
      },
    },
  } as any,
  createPropAssets(),
);
decor.setEffectPropIndices([]);
decor.setProps(props);
decor.showProps(true);
const overlay = decor.effectPropGroups[2];
assert(!overlay.visible, 'Editor helpers start hidden outside Effects mode');
decor.showEffectProps(true);
assert(overlay.visible && overlay.children.length > 0);
const helpers = overlay.children.flatMap(child => (child.userData.propInsts as { sourceIndex: number }[]) ?? []);
assert.deepEqual(helpers.map(row => row.sourceIndex).sort(), [0, 1, 3, 4, 5]);
assert(decor.selectInstanceBySource(3) && picked === 3, 'Untranslated helper opens the normal prop inspector');
const normal = new THREE.Vector3(0, 0, 1).transformDirection(RAW_TO_EDITOR);
const point = new THREE.Vector3(333, 33, 0).applyMatrix4(RAW_TO_EDITOR);
ray.set(point.clone().addScaledVector(normal, 2), normal.negate());
refRoot.updateMatrixWorld(true);
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
const hit = picking.pick({ props: 'effects' });
assert(
  hit?.target === 'prop' && hit.source === 'reference' && hit.sourceIndex === 3,
  'A real editor raycast picks the untranslated helper by its original source index',
);
assert.equal(picking.pick({ props: 'standard' }), null, 'Hidden helper art is absent from ordinary world picking');
const sensors = decor.rideColliders().filter(row => row.object?.kind === 'reference' && row.object.index !== 2);
assert(
  sensors.length === 4 && sensors.every(row => !row.solid),
  'Browser Play exposes only pass-through helper contacts',
);
decor.showEffectProps(false);
assert(!overlay.visible, 'The existing Play/editor view gate hides helper wires');
assert.equal(picking.pick({ props: 'effects' }), null, 'Hidden overlay cannot intercept Play/world picks');
console.log(
  'PASS: On Tour helper classification, pass-through contacts, preserved bindings, editor wireframes and old-cache repair',
);
