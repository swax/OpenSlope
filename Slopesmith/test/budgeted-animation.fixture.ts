import * as THREE from 'three';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import { createReferenceEffectsLayer } from '../src/app/viewport/scene/reference-effects';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import type { LevelProps } from '../src/core/reference/props';
import type { ReferenceEffectsData } from '../src/core/reference/effects';

/** Exercise the graph-to-renderer boundary with real scene meshes and deterministic frame ticks. */
export function budgetedAnimationScene(props: LevelProps, data: ReferenceEffectsData) {
  const stage: any = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    refRoot: new THREE.Group(), worldRoot: new THREE.Group(), cb: {} };
  stage.scene.add(stage.camera, stage.refRoot, stage.worldRoot);
  const assets = createPropAssets();
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  assets.propTex.material = () => material;
  const decor = createReferenceDecor(stage, assets);
  const runtime = createReferenceEffectsLayer(stage, {
    setReferenceInstanceVisible: (index, value) => decor.setRuntimeInstanceVisible(index, value),
    setObjectEffectsStopped: (object, stopped) => {
      if (object.kind === 'reference') decor.setInstanceEffectsStopped(object.index, stopped);
    },
    resetObjectEffects: object => {
      if (object.kind === 'reference') decor.resetRuntimeInstanceEffects(object.index);
    },
    resetSceneRuntime: () => {
      decor.resetRuntimeInstances(); decor.resetRuntimePropertyControls(); decor.clearAnimObjectPreviews();
    },
    startAnimDelta: (object, effect) => object.kind === 'reference' && decor.startAnimDelta(object.index, effect),
    hasBudgetedAnimation: object => object.kind === 'reference' && decor.instanceHasBudgetedAnimation(object.index),
    controlProperty: (object, command, value) => object.kind === 'reference'
      && decor.controlRuntimeInstanceProperty(object.index, command, value),
  });
  runtime.setData(data);
  decor.setEffectsData(data);
  decor.setProps(props);
  decor.showProps(true);
  let playing = false;
  const camera = new THREE.Vector3();
  const tick = (frames: number) => {
    for (let i = 0; i < frames; i++) {
      runtime.step(1 / 60, camera, playing ? camera : null, playing ? 'reference' : null);
      decor.stepWorldEffects(1 / 60);
    }
  };
  const poses = (index: number) => {
    const result: number[][] = [];
    for (const group of decor.propPickGroups) group.traverse(child => {
      if (!(child instanceof THREE.InstancedMesh)) return;
      const slot = child.userData.propInsts?.findIndex((inst: { sourceIndex: number }) => inst.sourceIndex === index);
      if (slot === undefined || slot < 0) return;
      const matrix = new THREE.Matrix4(); child.getMatrixAt(slot, matrix); result.push(matrix.toArray());
    });
    return result;
  };
  return { stage, decor, runtime, tick, poses,
    beginPlay: () => { playing = true; runtime.beginPlay('reference'); },
    endPlay: () => { playing = false; runtime.endPlay(); },
    hit: (index: number) => runtime.propCollision({ kind: 'reference', index }, camera,
      new THREE.Vector3(0, 0, 1), 10),
  };
}
