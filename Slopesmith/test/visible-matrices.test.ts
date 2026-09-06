// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { updateVisibleWorldMatrices } from '../src/app/viewport/scene/visible-matrices';

const scene = new THREE.Scene();
const visible = new THREE.Group();
const visibleChild = new THREE.Object3D();
const hidden = new THREE.Group();
const hiddenChild = new THREE.Object3D();
scene.add(visible, hidden);
visible.add(visibleChild);
hidden.add(hiddenChild);

visible.position.x = 10;
visibleChild.position.y = 4;
hidden.position.x = 20;
hiddenChild.position.y = 8;
hidden.visible = false;
updateVisibleWorldMatrices(scene);

assert.deepEqual(visibleChild.getWorldPosition(new THREE.Vector3()).toArray(), [10, 4, 0],
  'visible descendants receive the same composed world matrix as the stock traversal');
assert.deepEqual(hiddenChild.matrixWorld.elements, new THREE.Matrix4().elements,
  'an invisible subtree is not traversed merely to prepare a render list it cannot enter');
assert.equal(hidden.matrixWorldNeedsUpdate, true, 'a pruned root remains dirty for a later reveal');

hidden.visible = true;
updateVisibleWorldMatrices(scene);
assert.deepEqual(hiddenChild.getWorldPosition(new THREE.Vector3()).toArray(), [20, 8, 0],
  'revealing a previously pruned subtree refreshes every descendant before it can render');

// An overridden updateMatrixWorld is a side-effect hook, not just matrix math: PositionalAudio and
// AudioListener position the WebAudio graph from it, Camera maintains matrixWorldInverse. The walker must
// delegate to it — inlining the composition once left every Play collision one-shot's panner at the WebAudio
// origin, audible only as a faint tick. Camera is the overrider constructible without an AudioContext.
const camera = new THREE.PerspectiveCamera();
camera.position.set(3, 0, 0);
visible.add(camera);
class SideEffectNode extends THREE.Object3D {
  updates = 0;
  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    this.updates++;
  }
}
const effectNode = new SideEffectNode();
camera.add(effectNode);
const hiddenEffectNode = new SideEffectNode();
hidden.visible = false;
hidden.add(hiddenEffectNode);
updateVisibleWorldMatrices(scene);
assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).toArray(), [13, 0, 0],
  'a delegated overrider still receives the composed world matrix');
assert.deepEqual(camera.matrixWorldInverse.elements,
  camera.matrixWorld.clone().invert().elements,
  'Camera.updateMatrixWorld ran, so matrixWorldInverse tracks the fresh matrixWorld');
assert.equal(effectNode.updates, 1,
  'descendants of a delegated overrider run their own overridden hook');
assert.equal(hiddenEffectNode.updates, 0, 'an overrider inside a pruned subtree stays skipped');

console.log('VISIBLE MATRICES: PASS');
