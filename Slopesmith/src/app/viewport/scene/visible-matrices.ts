import * as THREE from 'three';

const stockUpdateMatrixWorld = THREE.Object3D.prototype.updateMatrixWorld;

/**
 * Three updates the complete scene hierarchy before its render traversal, including every descendant of an
 * invisible editor group. During Play those branches cannot reach the render list, so updating their world
 * matrices is pure CPU cost. This is Object3D.updateMatrixWorld with the same visible-subtree early-out used by
 * WebGLRenderer.projectObject. A skipped root stays dirty so revealing it on a later frame cannot expose stale
 * descendants.
 *
 * The caller must temporarily disable Scene.matrixWorldAutoUpdate for the render that immediately follows.
 */
export function updateVisibleWorldMatrices(object: THREE.Object3D, force = false): void {
  if (!object.visible) {
    object.matrixWorldNeedsUpdate = true;
    return;
  }

  // Subclasses hang real work off this hook, not just matrix math: PositionalAudio and AudioListener push
  // their world pose into the WebAudio graph from it, Camera refreshes matrixWorldInverse. Composing their
  // matrixWorld inline updates the field while silently dropping that side effect — a Play collision one-shot
  // then sounds from the panner's default origin, kilometres of rolloff away. Delegate the whole subtree; the
  // overriders in this scene are leaves or near-leaves, so no meaningful pruning is lost.
  if (object.updateMatrixWorld !== stockUpdateMatrixWorld) {
    object.updateMatrixWorld(force);
    return;
  }

  if (object.matrixAutoUpdate) object.updateMatrix();

  if (object.matrixWorldNeedsUpdate || force) {
    if (object.matrixWorldAutoUpdate) {
      if (object.parent === null) object.matrixWorld.copy(object.matrix);
      else object.matrixWorld.multiplyMatrices(object.parent.matrixWorld, object.matrix);
    }
    object.matrixWorldNeedsUpdate = false;
    force = true;
  }

  for (const child of object.children) updateVisibleWorldMatrices(child, force);
}
