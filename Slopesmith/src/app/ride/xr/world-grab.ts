/**
 * Grabbing the world for VR editing (docs/068). With ONE grip held the map is dragged along with that hand
 * (`solveOneHandGrab`). With BOTH grips held,
 *
 *  - pulling the hands apart makes the player SMALLER (the mountain reads bigger — zoom in, as if stretching the
 *    map out between the hands), and bringing them together makes the player bigger (zoom out). The first
 *    headset pass had it the other way round and read backwards. Size is the player's, not the camera's:
 *    stepping, flying and reaching all scale with it, so a giant crosses the map in a few steps;
 *  - turning the pair about each other turns the map with them;
 *  - moving both together drags the map along with the hands (pan, including up and down).
 *
 * All three are one solve against a single grab: the world point between the hands when the grips closed stays
 * between the hands, the map keeps the heading the hands gave it, and the size runs against the hands' spread. Solving
 * from the grab's start every frame, rather than accumulating per-frame deltas, means the map cannot drift while
 * the hands are held still.
 *
 * Pure: hands arrive in RIG-local space (the tracking space, before the rig's own position, yaw and size), and a
 * rig pose comes back. The session owns reading the controllers and seating the rig.
 */

export interface RigPose {
  /** World position of the rig origin (the tracking-space floor origin). */
  x: number; y: number; z: number;
  /** Rotation about world up, radians (three's convention: positive turns −Z toward −X). */
  yaw: number;
  /** Player size: 1 is life size, 10 a giant for whom the mountain is a tenth of the size. */
  scale: number;
}

export interface Vec3 { x: number; y: number; z: number }

export interface TwoHandGrab { pose: RigPose; a: Vec3; b: Vec3 }

/** Size limits: an ant's view of a rail to a sky-high look at a whole level. */
export const XR_EDIT_MIN_SCALE = 0.05;
export const XR_EDIT_MAX_SCALE = 1000;
/** Size runs inversely with the hands' spread to this power, so one comfortable pull (30 cm → 90 cm) is 9×, not 3×. */
export const XR_EDIT_ZOOM_EXPONENT = 2;
/** Below this horizontal separation (rig metres) the pair has no reliable heading; rotation holds. */
const MIN_TURN_SPAN = 0.05;
/** Below this spread the size ratio would explode; the size holds. */
const MIN_SPREAD = 0.02;

/** Rotate (x, z) about world up by `yaw`, three.js's sense. */
function yawed(x: number, z: number, yaw: number): [number, number] {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, -x * s + z * c];
}

/** The heading of a horizontal vector, in the angle `yawed` adds to. */
function heading(x: number, z: number): number { return Math.atan2(x, z); }

/** Where a rig-local point sits in the world under `pose`. */
export function rigToWorld(pose: RigPose, p: Vec3): Vec3 {
  const [x, z] = yawed(p.x * pose.scale, p.z * pose.scale, pose.yaw);
  return { x: pose.x + x, y: pose.y + p.y * pose.scale, z: pose.z + z };
}

/** The rig pose for hands at `a` and `b` (rig-local) during `grab`. */
export function solveTwoHandGrab(grab: TwoHandGrab, a: Vec3, b: Vec3): RigPose {
  const { pose: start } = grab;
  const spread0 = Math.hypot(grab.b.x - grab.a.x, grab.b.y - grab.a.y, grab.b.z - grab.a.z);
  const spread = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const scale = spread0 < MIN_SPREAD || spread < MIN_SPREAD ? start.scale
    : Math.min(XR_EDIT_MAX_SCALE, Math.max(XR_EDIT_MIN_SCALE,
      start.scale * Math.pow(spread0 / spread, XR_EDIT_ZOOM_EXPONENT)));
  const span0 = Math.hypot(grab.b.x - grab.a.x, grab.b.z - grab.a.z);
  const span = Math.hypot(b.x - a.x, b.z - a.z);
  // The map keeps the heading the hands gave it: world heading of (b − a) is yaw + its rig-local heading.
  const yaw = span0 < MIN_TURN_SPAN || span < MIN_TURN_SPAN ? start.yaw
    : start.yaw + heading(grab.b.x - grab.a.x, grab.b.z - grab.a.z) - heading(b.x - a.x, b.z - a.z);
  // The world point between the hands at the grab stays between them.
  const anchor = rigToWorld(start, {
    x: (grab.a.x + grab.b.x) / 2, y: (grab.a.y + grab.b.y) / 2, z: (grab.a.z + grab.b.z) / 2,
  });
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
  const [mx, mz] = yawed(mid.x * scale, mid.z * scale, yaw);
  return { x: anchor.x - mx, y: anchor.y - mid.y * scale, z: anchor.z - mz, yaw, scale };
}

export interface OneHandGrab { pose: RigPose; hand: Vec3 }

/** One grip held: the world point in the hand stays in it, so the map is dragged along with the hand — across,
 *  and up and down — at the size and heading it already had. Solved from the grab's start, like the pair. */
export function solveOneHandGrab(grab: OneHandGrab, hand: Vec3): RigPose {
  const { pose } = grab;
  const anchor = rigToWorld(pose, grab.hand);
  const [x, z] = yawed(hand.x * pose.scale, hand.z * pose.scale, pose.yaw);
  return { ...pose, x: anchor.x - x, y: anchor.y - hand.y * pose.scale, z: anchor.z - z };
}

/** Turn the rig by `turn` radians about a world point (the head), leaving that point where it is. */
export function turnRigAbout(pose: RigPose, pivot: Vec3, turn: number): RigPose {
  const [dx, dz] = yawed(pose.x - pivot.x, pose.z - pivot.z, turn);
  return { ...pose, x: pivot.x + dx, z: pivot.z + dz, yaw: pose.yaw + turn };
}
