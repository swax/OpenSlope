import * as THREE from 'three';
import type { Stage } from '../stage';
import type { SnapStep } from '../types';

const GRID_SIZE = 6000;
const AXIS_LOCK = 0.9999;
const VIEW_DIRECTION = new THREE.Vector3();

export type ViewAxis = 'x' | 'y' | 'z';

/** Return the world axis an exactly snapped camera is looking along, independent of projection mode. */
export function lockedViewAxis(camera: THREE.Camera): ViewAxis | null {
  const direction = camera.getWorldDirection(VIEW_DIRECTION);
  const ax = Math.abs(direction.x), ay = Math.abs(direction.y), az = Math.abs(direction.z);
  const best = Math.max(ax, ay, az);
  if (best < AXIS_LOCK) return null;
  return best === ax ? 'x' : best === ay ? 'y' : 'z';
}

/**
 * Orthographic axis-view overlay grid. Unlike terrain / cage geometry, it follows the camera target and draws
 * without a depth test, so it reads as a drafting overlay rather than a plane sitting somewhere in the world.
 * It appears only while the camera looks exactly down X, Y or Z, selecting the perpendicular YZ, XZ or XY plane.
 */
export function createViewGridLayer(stage: Stage) {
  let step: SnapStep = 5;
  const grid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE / step, 0x7f8da0, 0x7f8da0);
  grid.name = 'view-grid';
  grid.visible = false;
  grid.renderOrder = 1000;
  grid.frustumCulled = false;
  grid.raycast = () => { /* screen overlay, never a pick target */ };

  const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
  for (const material of materials) {
    material.transparent = true;
    material.opacity = 0.24;
    material.depthTest = false;
    material.depthWrite = false;
    material.toneMapped = false;
  }

  // Scene root, not worldRoot: this follows the rendered camera axes directly and avoids inheriting the authored
  // world's Z reflection. Its position is refreshed every frame, snapped in-plane so the chosen phase stays stable.
  stage.scene.add(grid);

  const snap = (v: number) => Math.round(v / step) * step;

  /** Rebuild only the helper's coloured line geometry when its resolution changes; material / scene identity
   *  stay stable so visibility and overlay styling do not flicker. */
  function setStep(next: SnapStep) {
    if (next === step) return;
    step = next;
    const replacement = new THREE.GridHelper(GRID_SIZE, GRID_SIZE / step, 0x7f8da0, 0x7f8da0);
    grid.geometry.dispose();
    grid.geometry = replacement.geometry;
    const mats = Array.isArray(replacement.material) ? replacement.material : [replacement.material];
    for (const material of mats) material.dispose();
  }

  /** Follow the current ortho view. A free-angle camera hides the overlay until an axis nub locks it again. */
  function update(camera: THREE.Camera, target: THREE.Vector3, ortho: boolean, enabled: boolean) {
    const axis = ortho && enabled ? lockedViewAxis(camera) : null;
    grid.visible = axis !== null;
    if (axis === null) return;

    grid.rotation.set(0, 0, 0);
    if (axis === 'x') {            // looking down X → YZ grid
      grid.rotation.z = Math.PI / 2;
      grid.position.set(target.x, snap(target.y), snap(target.z));
    } else if (axis === 'y') {     // looking down Y → XZ grid (GridHelper's native plane)
      grid.position.set(snap(target.x), target.y, snap(target.z));
    } else {                       // looking down Z → XY grid
      grid.rotation.x = Math.PI / 2;
      grid.position.set(snap(target.x), snap(target.y), target.z);
    }
  }

  return { grid, update, setStep, get step() { return step; }, get visible() { return grid.visible; } };
}

export type ViewGridLayer = ReturnType<typeof createViewGridLayer>;
