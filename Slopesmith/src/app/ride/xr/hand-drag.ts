import * as THREE from 'three';

/**
 * The hand's third dimension for the editor's move gizmo (docs/068).
 *
 * Every prop and point move in the editor is a TransformControls translate, and a mouse drives one across a
 * plane: an arrow's or square's plane turned toward the eye, or for the free centre a plane facing the eye. So
 * nothing a mouse does can carry a prop or a point toward or away from the viewer. A hand can. While the trigger
 * holds a translate, the grabbed point rides the controller ray at the distance it was grabbed from, and pushing
 * the hand out along the ray, or pulling it in, carries that distance with it. The motion is then masked to the
 * grabbed handle exactly as TransformControls masks a mouse drag (an arrow along its axis, a square in its plane,
 * the centre anywhere) and snapped the same way, so frames, snapping and every host callback behave as for a
 * mouse.
 *
 * Depth scales with distance: pushing the hand `XR_HAND_DEPTH_REACH` further out doubles the grabbed point's
 * distance from where the hand began, and pulling back as far brings the point to where the hand began. Pointing
 * already sweeps a far point further than a near one; a 1:1 push would leave anything more than a few metres away
 * all but fixed in depth. Near the hand the push is never less than 1:1.
 *
 * Pure three.js math, headless-tested; the session reads the controller and the editor applies the result.
 */

/** Rig metres of push that double the grabbed point's distance (from where the hand began). */
export const XR_HAND_DEPTH_REACH = 0.5;
/** However far the hand is pulled back, the grabbed point stays at least this far out (rig metres). */
const MIN_DISTANCE = 0.05;

export type GizmoAxis = 'X' | 'Y' | 'Z' | 'XY' | 'YZ' | 'XZ' | 'XYZ';

/** A translate as the hand took hold of it. World space throughout. */
export interface HandGrab {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  /** From the hand to the grabbed anchor, when the drag began. */
  distance: number;
  /** The anchor's world position and orientation when the drag began: the gizmo's frame. */
  anchor: THREE.Vector3;
  frame: THREE.Quaternion;
}

export function beginHandGrab(ray: THREE.Ray, anchor: THREE.Vector3, frame: THREE.Quaternion): HandGrab {
  return {
    origin: ray.origin.clone(), dir: ray.direction.clone().normalize(), distance: ray.origin.distanceTo(anchor),
    anchor: anchor.clone(), frame: frame.clone(),
  };
}

const push = new THREE.Vector3();

/** Where the grabbed point is now, on the current ray. `scale` is the player's size (rig metres → world). */
export function handGrabPoint(grab: HandGrab, ray: THREE.Ray, scale: number, out: THREE.Vector3): THREE.Vector3 {
  // How far the hand has moved along the ray it grabbed with. The ray origin carries that push 1:1 already; the
  // distance adds the rest of the gain.
  const along = push.subVectors(ray.origin, grab.origin).dot(grab.dir);
  const gain = Math.max(1, grab.distance / (XR_HAND_DEPTH_REACH * scale));
  const distance = Math.max(MIN_DISTANCE * scale, grab.distance + along * (gain - 1));
  return out.copy(ray.origin).addScaledVector(ray.direction, distance);
}

const inverse = new THREE.Quaternion();

/** The space TransformControls moves a translate in: its own, except that the free centre is always world. */
function moveSpace(axis: GizmoAxis, space: 'local' | 'world'): 'local' | 'world' {
  return axis === 'XYZ' ? 'world' : space;
}

/**
 * The anchor's new world position for a hand that has moved the grabbed point by `delta`: masked to the handle,
 * and snapped, as TransformControls' own pointer move does. Anchors are scene-root objects (no parent
 * transform), which is what lets world and parent space be one here.
 */
export function handTranslateTarget(grab: HandGrab, delta: THREE.Vector3, axis: GizmoAxis, space: 'local' | 'world',
                                    snap: number | null, out: THREE.Vector3): THREE.Vector3 {
  const local = moveSpace(axis, space) === 'local';
  out.copy(delta);
  if (local) out.applyQuaternion(inverse.copy(grab.frame).invert());
  if (!axis.includes('X')) out.x = 0;
  if (!axis.includes('Y')) out.y = 0;
  if (!axis.includes('Z')) out.z = 0;
  if (local) out.applyQuaternion(grab.frame);
  out.add(grab.anchor);
  if (!snap) return out;
  const round = (value: number) => Math.round(value / snap) * snap;
  if (local) out.applyQuaternion(inverse.copy(grab.frame).invert());
  if (axis.includes('X')) out.x = round(out.x);
  if (axis.includes('Y')) out.y = round(out.y);
  if (axis.includes('Z')) out.z = round(out.z);
  if (local) out.applyQuaternion(grab.frame);
  return out;
}
