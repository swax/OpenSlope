import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { MeshVertexClipboard } from '../../../core/mesh/clipboard';
import type { Stage } from '../stage';
import { createClipboardPlacementLayer, type ClipboardPlacementDeps } from './clipboard-placement';

/** A movable copy ghost. The document is untouched until the host accepts a nonzero release. */
export function createDuplicateLayer(stage: Stage, deps: ClipboardPlacementDeps) {
  const ghost = createClipboardPlacementLayer(stage, deps);
  const anchor = new THREE.Object3D();
  const origin = new THREE.Vector3();
  stage.scene.add(anchor);

  function cancel() {
    ghost.setClip(null);
    if (stage.gizmoKind === 'duplicate') stage.detachGizmo();
  }

  function begin(clip: MeshVertexClipboard): boolean {
    const rotation = stage.gizmo.space === 'local' ? stage.gizmo.object?.quaternion.clone() : undefined;
    cancel();
    if (!ghost.setClip(clip)) return false;
    origin.set(0, 0, 0);
    for (let i = 0; i < clip.vertices.length; i += 3)
      origin.add(new THREE.Vector3(clip.vertices[i], clip.vertices[i + 1], -clip.vertices[i + 2]));
    origin.multiplyScalar(3 / clip.vertices.length);
    anchor.position.copy(origin);
    anchor.quaternion.copy(rotation ?? new THREE.Quaternion());
    ghost.setTranslation([0, 0, 0]);
    stage.attachGizmo(anchor, 'duplicate', -1);
    return true;
  }

  function translation(): V3 {
    return [anchor.position.x - origin.x, anchor.position.y - origin.y, origin.z - anchor.position.z];
  }

  return {
    begin,
    cancel,
    changed() {
      if (ghost.active) ghost.setTranslation(translation());
    },
    release() {
      if (ghost.active) stage.cb.onDuplicateVertices?.(translation());
    },
    get active() {
      return ghost.active;
    },
  };
}

export type DuplicateLayer = ReturnType<typeof createDuplicateLayer>;
