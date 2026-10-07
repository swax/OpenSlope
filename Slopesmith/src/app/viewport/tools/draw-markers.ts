import * as THREE from 'three';
import type { Stage } from '../stage';

/** The unit sphere the drawing tools' point markers share; `scaleDrawMarkers` sizes it on screen each frame. */
export const DRAW_POINT_GEO = new THREE.SphereGeometry(1, 10, 8);

/** Point-marker radius, px, for Create Edge / Patch / Tube: the points placed and the ghost under the cursor. A
 *  world-sized ball swelled as the camera closed in, until it buried the very point or edge being aimed at. */
export const DRAW_POINT_PX = 4;

const scratch = new THREE.Vector3();

/** Keep the visible markers `px` on screen at their own depth (a headset's minimum where one is presenting). */
export function scaleDrawMarkers(stage: Stage, markers: readonly THREE.Object3D[], px = DRAW_POINT_PX) {
  for (const marker of markers) {
    if (marker.visible) marker.scale.setScalar(Math.max(1e-4, stage.pointMarkerRadius(marker.getWorldPosition(scratch), px)));
  }
}
