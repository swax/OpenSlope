import type { V3 } from '../../../core/doc/types';
import type { ViewState } from '../../viewport/types';

export interface CameraValues {
  position: V3;
  target: V3;
  ortho: boolean;
  fov: number;
  height: number;
}

/** Display the editor's Y-up coordinates; rendering mirrors Z. Origins are in editor space. */
export const cameraPointToData = (point: V3, origin: V3): V3 =>
  [point[0] - origin[0], point[1] - origin[1], -point[2] - origin[2]];
export const cameraPointToWorld = (point: V3, origin: V3): V3 =>
  [point[0] + origin[0], point[1] + origin[1], -(point[2] + origin[2])];

export function cameraValues(view: ViewState, origin: V3): CameraValues {
  const distance = Math.hypot(...view.pos.map((v, i) => v - view.target[i]));
  const fov = view.fov ?? 55;
  return {
    position: cameraPointToData(view.pos, origin), target: cameraPointToData(view.target, origin),
    ortho: view.ortho, fov,
    height: view.ortho ? 2 * view.orthoHalfH / view.zoom : 2 * distance * Math.tan(fov * Math.PI / 360),
  };
}

/** Validate a whole draft before moving anything, so a partial/empty entry cannot blank the viewport. */
export function cameraView(values: CameraValues, origin: V3, current: ViewState): ViewState {
  if (![...values.position, ...values.target, ...origin, values.fov, values.height].every(Number.isFinite))
    throw new Error('Enter a finite number in every camera field.');
  if (Math.hypot(...values.position.map((v, i) => v - values.target[i])) < 0.01)
    throw new Error('Position and look-at must be at least 0.01 m apart.');
  if (values.fov < 1 || values.fov > 175) throw new Error('Field of view must be between 1° and 175°.');
  if (values.height < 0.01) throw new Error('View height must be at least 0.01 m.');
  return {
    ...current, pos: cameraPointToWorld(values.position, origin), target: cameraPointToWorld(values.target, origin),
    up: [0, 1, 0], ortho: values.ortho, fov: values.fov,
    ...(values.ortho ? { zoom: 1, orthoHalfH: values.height / 2 } : {}),
  };
}
