import * as THREE from 'three';
import type { V3 } from '../../core/doc/types';

/** Data-space point to the unparented Three.js scene frame (the WYSIWYG root mirrors Z). */
export function dataToScene(point: V3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(point[0], point[1], -point[2]);
}

/** Unparented Three.js scene/world point back to authored data space. */
export function sceneToData(point: Pick<THREE.Vector3, 'x' | 'y' | 'z'>): V3 {
  return [point.x, point.y, -point.z];
}

/** Seat an unparented scene object at a data-space point. */
export function setScenePositionFromData(target: THREE.Vector3, point: V3): void {
  target.set(point[0], point[1], -point[2]);
}
