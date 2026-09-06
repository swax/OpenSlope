// tier: fast

import * as THREE from 'three';
import type { LevelProps } from '../src/core/reference/props';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import { MergedStaticPropMesh, referencePropSlot } from '../src/app/viewport/scene/reference-prop-mesh';
import { check, failures } from './check';

const refRoot = new THREE.Group();
const selections: Array<{ model: number | null; name: string | null; instanceName: string | null;
  sourceIndex: number | null }> = [];
const ray = new THREE.Raycaster();
const stage: any = {
  refRoot, ray,
  cb: { onSelectReferenceProp(_level: string | null, model: number | null, name: string | null,
    inst?: { sourceIndex: number; name?: string }) {
    selections.push({ model, name, instanceName: inst?.name ?? null, sourceIndex: inst?.sourceIndex ?? null });
  } },
};
const assets = createPropAssets();
const opaque = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
const transparent = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
const scrolling = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
// Keep this fixture independent of TextureLoader/DOM while still exercising the renderer's material classes.
(assets.propTex as any).material = (_level: string, _file: string | null, _effect: unknown,
  _frames: readonly string[], _runtimeKey: string | undefined, opts: { blend?: boolean } | undefined) =>
  _effect ? scrolling : opts?.blend ? transparent : opaque;

const triangle = (mat: number) => ({
  mat,
  positions: new Float32Array([-50, -50, 0, 50, -50, 0, 0, 50, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
  indices: new Uint32Array([0, 1, 2]),
});
const instance = (sourceIndex: number, model: number, x: number) => ({
  sourceIndex, ltgState: 0, model, loc: [x, 0, 0] as [number, number, number],
  rot: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number],
  name: `source-${sourceIndex}`, visible: true, playerCollision: false, playerBounce: false,
  collisionSound: -1, contact: 'ghost' as const, bounce: -1, surface: -1, shape: 0,
  responseMass: 0, dynamicMass: -1, physicsBody: -1, collisionModels: [], externalSounds: [],
});

const fixture: LevelProps = {
  level: 'BATCH',
  models: [
    { id: 1, name: 'static-triangle', subs: [triangle(-1)] },
    { id: 2, name: 'static-wedge', subs: [triangle(-1)] },
    { id: 3, name: 'transparent-card', subs: [triangle(1)] },
    { id: 4, name: 'effect-host', subs: [triangle(-1)] },
    { id: 5, name: 'animated-sign', subs: [triangle(-1)],
      rotation: { clipFrames: 60, axis: 2, segments: [[0, 0, 180, 0, 0, 1]] } },
    { id: 6, name: 'scrolling-banner', subs: [triangle(2)] },
  ],
  instances: [
    instance(900, 1, 0), instance(901, 2, 300), instance(902, 3, 600),
    instance(903, 4, 900), instance(904, 5, 1200), instance(905, 6, 1500),
  ],
  materials: new Map([
    [-1, { tex: null, frames: [] }],
    [1, { tex: null, frames: [], blend: true }],
    [2, { tex: 'scroll.png', frames: [] }],
  ]),
  crowdFrames: [], collisionMeshes: new Map(), physicsBodies: new Map(),
};
const effectsData = {
  document: {
    slots: [{ originalIndex: 0, circumstances: { persistent: 'graph:scroll' } }],
    graphs: [{ id: 'graph:scroll', nodes: [{
      id: 'graph:scroll/node:0', mainType: 0, semanticType: 'property.uv-scroll', references: {},
      payload: { type0: { SubType: 10, UVScroll: { U0: 0, U1: 0.01, U2: 0, U3: 1, U4: 1 } } },
    }] }],
    functions: [],
  },
  instances: [{ index: 905, effectSlotIndex: 0 }],
} as any;
const decor = createReferenceDecor(stage, assets);
decor.setEffectsData(effectsData);
decor.setEffectPropIndices([903]);
decor.setProps(fixture);
decor.showProps(true);
refRoot.updateMatrixWorld(true);

const scenery = decor.propPickGroups[0];
const staticBatches = scenery.children.filter(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh[];
const isolated = scenery.children.filter(child => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh[];
const staticBatch = staticBatches.find(batch => batch.userData.propBatchKind === 'static-opaque')!;
const transparentBatch = staticBatches.find(batch => batch.userData.propBatchKind === 'static-transparent')!;
const materialEffectBatch = staticBatches.find(batch => batch.material === scrolling)!;
check(staticBatches.length === 3 && staticBatch?.instanceCount === 3,
  'static opaque geometry from different models and a non-visual effect host shares one material BatchedMesh');
check(materialEffectBatch?.instanceCount === 1,
  'an ambient scrolling material keeps its live material while entering a heterogeneous batch');
check(transparentBatch?.instanceCount === 1 && transparentBatch.sortObjects && !staticBatch.sortObjects,
  'static transparent geometry uses a separate depth-sorted material batch');
check(isolated.length === 1,
  'only genuinely animated props remain in independent InstancedMesh batches');

const texturedStaticMaterial = staticBatch.material;
decor.setShadeMode('none');
const staticWirePasses = staticBatch.children.filter(child => child.userData.propWireframePass) as THREE.BatchedMesh[];
const hiddenStaticPass = staticWirePasses.find(child =>
  (child.material as THREE.MeshBasicMaterial).depthFunc === THREE.GreaterDepth);
const visibleStaticPass = staticWirePasses.find(child =>
  (child.material as THREE.MeshBasicMaterial).depthFunc !== THREE.GreaterDepth);
check((staticBatch.material as THREE.MeshBasicMaterial).colorWrite === false
  && staticWirePasses.length === 2
  && staticWirePasses.every(pass => pass instanceof THREE.BatchedMesh
    && pass.geometry.getAttribute('propBarycentric')?.count === pass.geometry.getAttribute('position')?.count)
  && (hiddenStaticPass?.material as THREE.MeshBasicMaterial | undefined)?.wireframe === false
  && (hiddenStaticPass?.material as THREE.MeshBasicMaterial | undefined)?.opacity === 0.08
  && (visibleStaticPass?.material as THREE.MeshBasicMaterial | undefined)?.wireframe === false,
  'Wireframe keeps heterogeneous props in two geometry-correct barycentric BatchedMesh passes');
const isolatedWirePasses = isolated[0].children.filter(child => child.userData.propWireframePass) as THREE.InstancedMesh[];
check(isolatedWirePasses.length === 2
  && isolatedWirePasses.every(pass => pass instanceof THREE.InstancedMesh
    && pass.instanceMatrix === isolated[0].instanceMatrix),
  'animated InstancedMesh wire passes share the live instance transform buffer');
decor.setShadeMode('textured');
check(staticBatch.material === texturedStaticMaterial && staticWirePasses.every(pass => !pass.visible),
  'leaving Wireframe restores prop paint and hides the auxiliary passes');

const batchSources = Array.from({ length: staticBatch.instanceCount }, (_, id) =>
  referencePropSlot(staticBatch, id)?.inst.sourceIndex);
check([...batchSources].sort((a, b) => (a ?? 0) - (b ?? 0)).join(',') === '900,901,903',
  'each heterogeneous batch slot retains its original source-instance identity');

const picking = createScenePicking(stage, {
  authoredPropRoots: () => [], referencePropRoots: () => decor.propPickGroups,
  lightRoots: () => [], sourceRoots: () => [], railRoots: () => [], gemRoots: () => [],
  knotTargets: () => [], surfaceTargets: () => [],
});
const pointAtRawX = (x: number) => {
  ray.ray.set(new THREE.Vector3(-x / 100, 10, 0), new THREE.Vector3(0, -1, 0));
  refRoot.updateMatrixWorld(true);
  return picking.pick({ props: 'standard' });
};
let pick = pointAtRawX(300);
check(pick?.target === 'prop' && pick.source === 'reference' && pick.sourceIndex === 901
  && pick.model === 2 && pick.name === 'static-wedge',
  'BatchedMesh raycasts decode batchId into the correct source, model, and name');

if (pick?.target === 'prop' && pick.source === 'reference') decor.selectPropInstance(pick.instance, pick.instanceId);
const selected = selections.at(-1);
check(selected?.sourceIndex === 901 && selected?.model === 2 && selected?.name === 'static-wedge'
  && selected.instanceName === 'source-901',
  'reference selection preserves separate model and instance labels in a heterogeneous batch');

decor.setRuntimeInstanceVisible(901, false);
check(pointAtRawX(300) === null, 'Play visibility updates hide only the addressed BatchedMesh slot');
decor.setRuntimeInstanceVisible(901, true);
check((pointAtRawX(300) as any)?.sourceIndex === 901,
  'resetting Play visibility restores the same source-instance pick');
decor.setRuntimeInstanceVisible(903, false);
check(pointAtRawX(900) === null, 'an effect host can hide through its preserved BatchedMesh source slot');
decor.setRuntimeInstanceVisible(903, true);
check((pointAtRawX(900) as any)?.sourceIndex === 903,
  'an effect host can reveal again without leaving its material batch');

const source900Id = batchSources.indexOf(900);
const moved = staticBatch.getMatrixAt(source900Id, new THREE.Matrix4());
moved.setPosition(-20, 0, 0);
decor.setRuntimeInstanceWorldMatrix(900, moved);
pick = pointAtRawX(2000);
check(pick?.target === 'prop' && pick.source === 'reference' && pick.sourceIndex === 900,
  'Play matrix updates move only the addressed heterogeneous batch slot');
const movedWire = new THREE.Matrix4();
staticWirePasses[0].getMatrixAt(source900Id, movedWire);
check(Math.abs(movedWire.elements[12] - moved.elements[12]) < 1e-6,
  'barycentric wire batches share Play-time matrix updates without a CPU synchronization pass');

// Browsers without WEBGL_multi_draw must not silently expand BatchedMesh back into one call per source slot.
const fallbackRoot = new THREE.Group();
const fallbackRay = new THREE.Raycaster();
const fallbackStage: any = {
  refRoot: fallbackRoot, ray: fallbackRay, cb: {},
  renderer: { extensions: { has: () => false } },
};
const fallback = createReferenceDecor(fallbackStage, assets);
fallback.setEffectsData(effectsData);
fallback.setEffectPropIndices([903]);
fallback.setProps(fixture);
fallback.showProps(true);
fallbackRoot.updateMatrixWorld(true);
const fallbackScenery = fallback.propPickGroups[0];
const fallbackMerged = fallbackScenery.children.filter(child =>
  child instanceof MergedStaticPropMesh) as MergedStaticPropMesh[];
const merged = fallbackMerged.find(child => child.instanceCount === 3)!;
const fallbackTransparent = fallbackScenery.children.find(child => child instanceof THREE.BatchedMesh) as THREE.BatchedMesh;
check(fallbackMerged.length === 2 && merged?.userData.propBatchKind === 'static-opaque-merged'
  && fallbackMerged.some(child => child.instanceCount === 1),
  'no-multi-draw renderer physically merges each static opaque material into one mesh');
check(fallbackTransparent?.userData.propBatchKind === 'static-transparent' && fallbackTransparent.sortObjects,
  'no-multi-draw renderer retains a separately sorted transparent batch');
fallback.setShadeMode('none');
const mergedWirePasses = merged.children.filter(child => child.userData.propWireframePass) as THREE.Mesh[];
check(mergedWirePasses.length === 2 && mergedWirePasses.every(pass => pass.geometry === merged.geometry),
  'merged fallback props use the same depth-aware wire passes without duplicating geometry');
const fallbackPicking = createScenePicking(fallbackStage, {
  authoredPropRoots: () => [], referencePropRoots: () => fallback.propPickGroups,
  lightRoots: () => [], sourceRoots: () => [], railRoots: () => [], gemRoots: () => [],
  knotTargets: () => [], surfaceTargets: () => [],
});
fallbackRay.ray.set(new THREE.Vector3(-3, 10, 0), new THREE.Vector3(0, -1, 0));
const fallbackPick = fallbackPicking.pick({ props: 'standard' });
check(fallbackPick?.target === 'prop' && fallbackPick.source === 'reference'
  && fallbackPick.sourceIndex === 901 && fallbackPick.model === 2,
  'merged fallback raycasts recover the original source slot and model');
fallback.setRuntimeInstanceVisible(901, false);
check(fallbackPicking.pick({ props: 'standard' }) === null,
  'merged fallback keeps per-source Play visibility addressable and refits picking');

const progressiveRoot = new THREE.Group();
const progressive = createReferenceDecor({ refRoot: progressiveRoot, ray: new THREE.Raycaster(), cb: {} } as any, assets);
progressive.setEffectsData(effectsData);
progressive.setEffectPropIndices([903]);
let progressiveYields = 0;
await progressive.setPropsProgressive(fixture, async () => { progressiveYields++; }, 0);
progressive.showProps(true);
const progressiveStats = progressive.renderStats();
const originalStats = decor.renderStats();
check(progressiveYields >= fixture.models.length + fixture.instances.length
  && progressiveStats.batchDraws === originalStats.batchDraws
  && progressiveStats.batchSlots === originalStats.batchSlots
  && progressiveStats.isolatedDraws === originalStats.isolatedDraws
  && progressiveStats.isolatedSlots === originalStats.isolatedSlots,
  'progressive prop construction yields inside large material batches and preserves the synchronous draw census');

if (failures) process.exitCode = 1;
else console.log('REFERENCE PROP BATCHING TESTS PASSED');
