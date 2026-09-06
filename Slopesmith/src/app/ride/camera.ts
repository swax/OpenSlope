import * as THREE from 'three';
import { WORLD_UP } from './physics';
import type {
  RideCameraClearance,
  RideCameraProbe,
  RideCameraProbeKind,
  RideCameraState,
  RideTelemetryVec3,
} from './telemetry';

// ---- tuning ----

// Slopesmith uses SSX Tricky's `chase near` follow response ([Trailmap: 400-camera]). The authored camera-local
// boom is 180 + 30*boost engine units. Directly tracing the outer camera driver found the missing translation
// filter: the live three-metre-ish eye/rider separation is the MOVING, FILTERED result, not a static boom to feed
// that filter. At 100 units/m the pre-filter boom is therefore 1.8 m (2.1 m at full boost), projected through the
// followed camera pitch below. The associated subject remains 1.0 m above the rider root. The 35 is a local-vector
// component, not a field of view.
const CAM_BOOM = 1.8, CAM_TARGET_HEIGHT = 1.0;
const CAM_PITCH = -0.16 - Math.atan2(35, 180);
const CAM_BOOST_SCALE = 1 + 30 / 180;
// The authored boost seat is 30 units / 0.3 m farther back, but switching that boom in one render frame makes the
// rider appear to lurch toward/away from the player on the button edges. Ease only the framing multiplier; the
// subject and physics remain immediate. Eight inverse-seconds reaches 98% of the authored seat in 0.5 seconds.
const CAM_BOOST_FOLLOW_RATE = 8;
// The live render-gather record carries 0.825 rad as the HORIZONTAL half-angle. The PS2 projection builder
// takes tan(0.825), then applies its fixed 4:3 display correction; Three's PerspectiveCamera wants a vertical
// full-angle, so convert explicitly. This is ≈78.145° vertical (≈94.538° horizontal at retail 4:3).
const RETAIL_HALF_FOV_X = 0.825, RETAIL_ASPECT = 4 / 3;
const CAM_FOV_Y_DEG = THREE.MathUtils.radToDeg(
  2 * Math.atan(Math.tan(RETAIL_HALF_FOV_X) / RETAIL_ASPECT),
);
// The adjacent live projection scalar is 15 engine units = 0.15 m. This matters to wall clearance: the
// editor's normal 0.5 m near plane can cross a surface even while the eye is correctly padded 0.4 m from it.
const CAM_NEAR = 0.15;
/** The eye is inside the local avatar in first person, so use the same close plane as WebXR hands/headgear. */
const CAM_FIRST_PERSON_NEAR = 0.03;
// The camera routine closes one sixteenth of the remaining follow-angle error each 60 Hz update. Express the
// same recurrence as a frame-rate-independent exponential so Slopesmith remains stable on variable-rate renders.
const CAM_FOLLOW_RATE = -60 * Math.log(15 / 16);
// The ordinary retail camera driver retains 80% of the previous corrected eye and admits 20% of the new one on
// each 60 Hz update ([Trailmap: 400-camera-eye-follow]). Keep the same exponential response at variable browser
// refresh rates. This is deliberately separate from the slower 15/16 angular follow above: it damps translation and,
// crucially, clearance-branch/triangle changes after the authored collision pass has produced its candidate.
const CAM_EYE_RETAIN_60HZ = 0.8;
const CAM_EYE_FOLLOW_RATE = -60 * Math.log(CAM_EYE_RETAIN_60HZ);
// Terrain clearance ([Trailmap: 400-camera-terrain]): the original runs a world-collision pass on the candidate
// eye every frame, and every correction it makes offsets the eye ALONG THE HIT SURFACE'S NORMAL — never a
// vertical lift, never a boom shortening. Riding downhill this is the whole feel: the eye is pinned at a minimum
// clearance measured perpendicular to the snow, which also pushes it horizontally off the hill face. `chase
// near` ships the small constants (its authored boom 180 is under the 500-unit threshold): 0.4 m sight-line pad,
// 0.4 m slope/lateral clearance, and the cast origin unburies through a 1.5 m up-window with a 0.2 m pad.
const CAM_LOS_PAD = 0.4, CAM_CLEARANCE = 0.4, CAM_UNBURY_WINDOW = 1.5, CAM_UNBURY_PAD = 0.2;
// The retail-style axis casts reproduce the traced response, but a point eye plus three segments can miss a
// diagonal face and a single normal correction can remain inside the neighbouring face of a concave bank. The
// rendered near-plane corners fit inside this eye-centred shell, so a bounded closest-surface post-pass closes
// both holes without changing unobstructed framing. Keep 5 cm beyond retail's 0.4 m point-eye response: the marked
// Garibaldi side-wall trace was geometrically correct at exactly 0.400 m, but the active 2:1 projection plane
// still scraped the faceted wall at its outer edge. Four projections solve the same practical corner depth used
// by the rider's collide-and-slide pass.
const CAM_VOLUME_CLEARANCE = 0.45, CAM_VOLUME_ITERATIONS = 4;
// The sight line starts above the deck, on the rider's torso — and the unbury step keeps a dip's own floor from
// false-blocking it.
const CAM_BLOCK_ANCHOR_Y = 1.25;
// The rider root supplies the chase bearing in the original. Slopesmith's closest equivalent is travel: it stays
// stable while the visible deck spins in the air or yaws across a rail. At walking speed facing is the fallback.
const CAM_TRAVEL_MIN = 1.5;
// A ride owns the editor camera, but the player can still inspect the rider by orbiting the chase seat with
// RMB. These offsets are deliberately layered over the followed travel bearing / trajectory pitch: physics
// keeps supplying the moving subject, while the pointer supplies only a view-relative yaw and pitch.
const CAM_ORBIT_YAW_PER_PIXEL = 0.006, CAM_ORBIT_PITCH_PER_PIXEL = 0.004;
const CAM_ORBIT_PITCH_MIN = -0.8, CAM_ORBIT_PITCH_MAX = 0.55;
// Desktop third-person wheel/pinch zoom scales the existing camera-to-subject boom, preserving its exact line.
// The bounds keep the near seat outside the avatar and the far seat useful without turning the rider into a dot.
export const THIRD_PERSON_ZOOM_MIN = 0.35, THIRD_PERSON_ZOOM_MAX = 4;
/** Slopesmith's user-facing playtest preset. The camera core keeps scale 1 available for retail trace checks. */
export const DEFAULT_THIRD_PERSON_ZOOM = 2;
// The walking follow camera has no terrain line-of-sight/volume pass of its own. Its desired eye can therefore
// land deeper than a short local probe on a steep bank, so it retains a long-range vertical hard floor.
const CAM_FLOOR_CLEARANCE = 0.4, CAM_FLOOR_LOOKUP_ABOVE = 4;

export type ThirdPersonCameraGroundQuery = (
  x: number, z: number, fromY: number,
) => { y: number; normal: THREE.Vector3 } | null;

export function clampThirdPersonZoom(scale: number): number {
  return THREE.MathUtils.clamp(Number.isFinite(scale) ? scale : 1, THIRD_PERSON_ZOOM_MIN, THIRD_PERSON_ZOOM_MAX);
}

/** Convert a browser wheel sample into a multiplicative boom scale: up/in is < 1, down/out is > 1. */
export function thirdPersonWheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const units = deltaY * (deltaMode === 1 ? 30 : deltaMode === 2 ? 800 : 1);
  return Math.exp(THREE.MathUtils.clamp(units * 0.0016, -0.4, 0.4));
}

/** Place a neutral third-person eye behind and above its subject. `forward` may include an orbit pitch; callers
 * layer the fixed rise over it so a level view never settles directly behind the character at torso height. */
export function thirdPersonFollowEye(
  target: THREE.Vector3, forward: THREE.Vector3, distance: number, height: number,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  return out.copy(target).addScaledVector(forward, -distance).addScaledVector(WORLD_UP, height);
}

/** Mutates a third-person eye only when it has fallen below the ground at its horizontal position. */
export function keepThirdPersonCameraAboveGround(
  eye: THREE.Vector3, anchorY: number, groundAt: ThirdPersonCameraGroundQuery,
): boolean {
  const ground = groundAt(eye.x, eye.z, Math.max(anchorY, eye.y) + CAM_FLOOR_LOOKUP_ABOVE);
  if (!ground) return false;
  const minimumY = ground.y + CAM_FLOOR_CLEARANCE;
  if (eye.y >= minimumY) return false;
  eye.y = minimumY;
  return true;
}

export interface RideCameraDeps {
  camera: THREE.PerspectiveCamera;
  /** Initial user framing scale; playtest sessions start wider while trace harnesses may retain scale 1. */
  initialThirdPersonZoom?: number;
  /** A world segment cast against the ride BVH (LOCAL-space hit + geometric normal), for the clearance pass. */
  castSeg(from: THREE.Vector3, to: THREE.Vector3): { point: THREE.Vector3; faceIndex: number; normal: THREE.Vector3 } | null;
  /** terrain local → world, for the hit points. */
  toWorld: THREE.Matrix4;
  /** A world-space segment cast against solid prop/collision geometry. */
  castObstacleSeg?(from: THREE.Vector3, to: THREE.Vector3): {
    point: THREE.Vector3; normal: THREE.Vector3; key: string;
  } | null;
  /** Closest rendered terrain surface within maxDistance, in world space. */
  closestTerrainPoint?(point: THREE.Vector3, maxDistance: number): {
    point: THREE.Vector3; normal: THREE.Vector3; distance: number;
  } | null;
}

/** The SSX `chase near` framing with its terrain clearance pass ([Trailmap: 400-camera-terrain]). */
export function createRideCamera(o: RideCameraDeps) {
  o.camera.fov = CAM_FOV_Y_DEG;
  o.camera.near = CAM_NEAR;
  o.camera.updateProjectionMatrix();
  const camHeading = new THREE.Vector3(0, 0, 1); // flattened travel direction, smoothed
  let camTrajectoryPitch = 0;                    // smoothed rider flight-path contribution
  let targetTrajectoryPitch = 0;
  let orbitYaw = 0, orbitPitch = 0;
  let thirdPersonZoom = clampThirdPersonZoom(o.initialThirdPersonZoom ?? 1);
  const camTmp = new THREE.Vector3();
  const orbitHeading = new THREE.Vector3();
  const firstForward = new THREE.Vector3(), firstUp = new THREE.Vector3(), firstRight = new THREE.Vector3();
  const camSubject = new THREE.Vector3(), camCandidate = new THREE.Vector3(), camLook = new THREE.Vector3();
  const camEye = new THREE.Vector3(), camSafetyStart = new THREE.Vector3();
  let camEyeValid = false;
  let camBoost = false, camBoostBlend = 0;
  let camClearance: RideCameraClearance = 'none', camOriginUnburied = false;
  let camCorrectionDistance = 0;
  let camProbes: RideCameraProbe[] = [];
  // Normals cross local→world through the inverse-transpose, because the terrain matrix may carry scale and a
  // chirality mirror that a point transform would smear into the normal.
  const camNormalMat = new THREE.Matrix3().getNormalMatrix(o.toWorld);

  /**
   * Where the chase cam wants to look: the board's **travel**, flattened — never its facing. Airborne, `fwd` is
   * yawed by the spin at up to 270°/s, and a camera bolted to it rides the rider around the circle instead of
   * showing him the landing. Horizontal velocity, meanwhile, IS the landing bearing: nothing in the air model
   * steers it (`340`), so it points at the ground you're going to hit from the moment you leave.
   */
  function camTargetHeading(out: THREE.Vector3, vel: THREE.Vector3, grounded: boolean, fwd: THREE.Vector3): THREE.Vector3 {
    out.set(vel.x, 0, vel.z);
    if (out.lengthSq() > CAM_TRAVEL_MIN * CAM_TRAVEL_MIN) return out.normalize();
    // Too slow to carry a direction. Grounded, the facing is the next best thing — it's within a slip angle of the
    // travel anyway. Airborne it is the WORST: a vertical pop with a spin on it is exactly the case being fixed,
    // so the board keeps the bearing it took off with.
    if (grounded) {
      out.set(fwd.x, 0, fwd.z);
      if (out.lengthSq() > 1e-6) return out.normalize();
    }
    return out.copy(camHeading);
  }

  function update(t: number, pos: THREE.Vector3, vel: THREE.Vector3, fwd: THREE.Vector3, grounded: boolean, boost: boolean) {
    setNear(CAM_NEAR);
    o.camera.up.copy(WORLD_UP);
    camProbes = [];
    const kFollow = t >= 1 ? 1 : 1 - Math.exp(-CAM_FOLLOW_RATE * t);

    const tgt = camTargetHeading(camTmp, vel, grounded, fwd);
    const headingYaw = Math.atan2(camHeading.x, camHeading.z);
    const targetYaw = Math.atan2(tgt.x, tgt.z);
    const yawError = Math.atan2(Math.sin(targetYaw - headingYaw), Math.cos(targetYaw - headingYaw));
    const followedYaw = headingYaw + yawError * kFollow;
    camHeading.set(Math.sin(followedYaw), 0, Math.cos(followedYaw));

    // SSX derives the landing reveal directly from the motion vector: elevation = atan2(vertical, horizontal),
    // full strength while rising and half strength while falling, then the same 1/16-at-60-Hz angular follow.
    // There is no ledge/air timer. Gravity bends the target downward after takeoff and the camera follows slowly.
    const horizontalSpeed = Math.hypot(vel.x, vel.z);
    const flightPitch = Math.atan2(vel.y, horizontalSpeed);
    targetTrajectoryPitch = flightPitch / (vel.y < 0 ? 2 : 1);
    camTrajectoryPitch += (targetTrajectoryPitch - camTrajectoryPitch) * kFollow;

    // Reconstruct the authored pre-filter framing. Its 35/180 component and the associated -0.16 rad bias set the
    // pitch; translation filtering below produces the larger, speed-dependent separation seen in live output.
    // No invented look-ahead or descent timer: `chase near` keeps the one-metre subject offset and adds the traced
    // trajectory response directly.
    const kBoost = t >= 1 ? 1 : 1 - Math.exp(-CAM_BOOST_FOLLOW_RATE * Math.max(0, t));
    camBoostBlend += (Number(boost) - camBoostBlend) * kBoost;
    const boom = CAM_BOOM * thirdPersonZoom * THREE.MathUtils.lerp(1, CAM_BOOST_SCALE, camBoostBlend);
    const baseYaw = Math.atan2(camHeading.x, camHeading.z);
    orbitHeading.set(Math.sin(baseYaw + orbitYaw), 0, Math.cos(baseYaw + orbitYaw));
    // Keep the final boom away from tan()'s singularity even during a steep jump plus a full user orbit.
    const boomPitch = THREE.MathUtils.clamp(CAM_PITCH + camTrajectoryPitch + orbitPitch, -1.15, 0.35);
    // `boom` is the authored full vector length. Project it into a horizontal trail and a vertical rise around
    // the one-metre subject rather than treating 1.8 as an already-horizontal distance.
    const distance = Math.cos(boomPitch) * boom;
    const height = CAM_TARGET_HEIGHT - Math.sin(boomPitch) * boom;
    const desired = thirdPersonFollowEye(pos, orbitHeading, distance, height);
    camSubject.copy(pos);
    camCandidate.copy(desired);
    camBoost = boost;
    const anchor = pos.clone().addScaledVector(WORLD_UP, CAM_BLOCK_ANCHOR_Y);
    const clearance = clearancePass(anchor, desired);
    camCorrectionDistance = desired.distanceTo(camCandidate);
    // Retail order: authored eye -> authored clearance -> retained translation. `t <= 0` is an explicit reseat
    // used by view toggles/zoom; long gaps and invalidated state are cuts, not a slow flight from stale history.
    const kEye = !camEyeValid || t <= 0 || t >= 1
      ? 1
      : 1 - Math.exp(-CAM_EYE_FOLLOW_RATE * t);
    if (!camEyeValid) camEye.copy(desired);
    else camEye.lerp(desired, kEye);
    camEyeValid = true;

    // These are Slopesmith render-safety guards rather than the authored point-eye response. Run them after
    // interpolation: both endpoints can be collision-safe while their segment crosses a concave bank or wall.
    // A blocked filtered sight line pulls in immediately; unobstructed movement and release retain the damping.
    // Mutating the retained eye makes a hard safety projection the next frame's history instead of fighting it.
    camSafetyStart.copy(camEye);
    const filteredBlocked = filteredLineOfSightPass(clearance.origin, camEye);
    const volumeCorrected = volumePass(anchor, camEye);
    camClearance = volumeCorrected ? 'volume'
      : filteredBlocked ? 'line-of-sight' : clearance.kind;
    camOriginUnburied = clearance.originUnburied;
    // Keep this metric about collision response rather than counting intentional follow lag as a correction.
    camCorrectionDistance = Math.max(camCorrectionDistance, camEye.distanceTo(camSafetyStart));
    o.camera.position.copy(camEye);

    const look = pos.clone().addScaledVector(WORLD_UP, CAM_TARGET_HEIGHT);
    camLook.copy(look);
    o.camera.lookAt(look);
  }

  /** Seat the desktop camera at the live avatar's eye bridge. The same retained orbit offsets used by the chase
   * view become head-look offsets here, so toggling V changes distance without discarding where the player was
   * looking. No terrain boom exists in this mode, hence no chase clearance casts. */
  function updateFirstPerson(eye: THREE.Vector3, forward: THREE.Vector3, up: THREE.Vector3) {
    // Returning to third person is a camera cut. Never interpolate from a stale chase eye that may now be metres
    // away or on the other side of world collision.
    camEyeValid = false;
    setNear(CAM_FIRST_PERSON_NEAR);
    camProbes = [];
    camSubject.copy(eye);
    camCandidate.copy(eye);
    camClearance = 'none';
    camOriginUnburied = false;
    camCorrectionDistance = 0;
    camBoost = false;

    firstUp.copy(up);
    if (firstUp.lengthSq() < 1e-8) firstUp.copy(WORLD_UP); else firstUp.normalize();
    firstForward.copy(forward);
    if (firstForward.lengthSq() < 1e-8) firstForward.copy(camHeading); else firstForward.normalize();
    // Chase orbit treats the pointer as dragging the camera seat around the subject. First person treats it as
    // direct mouse-look, which is the opposite operation: mouse right looks right and mouse down looks down.
    // `orbitYaw` decreases when the mouse moves right. Applying it directly turns toward the camera's LOCAL
    // right (`forward × up`) for either +Z- or -Z-facing riders; negating it made +Z courses feel reversed.
    if (orbitYaw) firstForward.applyAxisAngle(WORLD_UP, orbitYaw).normalize();
    firstRight.crossVectors(firstUp, firstForward);
    if (firstRight.lengthSq() > 1e-8 && orbitPitch)
      firstForward.applyAxisAngle(firstRight.normalize(), -orbitPitch).normalize();

    o.camera.up.copy(firstUp);
    o.camera.position.copy(eye);
    camLook.copy(eye).add(firstForward);
    o.camera.lookAt(camLook);
  }

  function setNear(near: number) {
    if (o.camera.near === near) return;
    o.camera.near = near;
    o.camera.updateProjectionMatrix();
  }

  /** A segment cast with the hit lifted to world space: point via the terrain matrix, normal via its
   *  inverse-transpose, still as authored (unflipped). */
  function castWorld(kind: RideCameraProbeKind, from: THREE.Vector3, to: THREE.Vector3): {
    point: THREE.Vector3; normal: THREE.Vector3;
  } | null {
    const terrainHit = o.castSeg(from, to);
    const terrain = terrainHit ? {
      point: terrainHit.point.clone().applyMatrix4(o.toWorld),
      normal: terrainHit.normal.applyMatrix3(camNormalMat).normalize(),
      source: 'terrain' as const,
      obstacleKey: undefined,
    } : null;
    const obstacleHit = o.castObstacleSeg?.(from, to) ?? null;
    const obstacle = obstacleHit ? {
      point: obstacleHit.point.clone(), normal: obstacleHit.normal.clone().normalize(),
      source: 'obstacle' as const, obstacleKey: obstacleHit.key,
    } : null;
    const hit = terrain && obstacle
      ? (from.distanceToSquared(terrain.point) <= from.distanceToSquared(obstacle.point) ? terrain : obstacle)
      : terrain ?? obstacle;
    const probe: RideCameraProbe = {
      kind, from: tuple(from), to: tuple(to), segmentLength: from.distanceTo(to), hit: !!hit,
    };
    if (hit) {
      probe.hitDistance = from.distanceTo(hit.point);
      probe.point = tuple(hit.point);
      probe.normal = tuple(hit.normal);
      probe.source = hit.source;
      if (hit.obstacleKey) probe.obstacleKey = hit.obstacleKey;
    }
    camProbes.push(probe);
    return hit ? { point: hit.point, normal: hit.normal } : null;
  }

  /** The authored normal, oriented to face the side the segment came from — the side the eye must stay on. */
  function towardOrigin(normal: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    return normal.dot(camTmp.copy(to).sub(from)) > 0 ? normal.negate() : normal;
  }

  /**
   * [Trailmap: 400-camera-terrain] the original's per-frame clearance pass, in its priority order. Blocked
   * sight line wins and ends the pass; otherwise the ground probe; otherwise the lateral probe. Every response
   * is the same shape — the eye lands on the hit surface padded out along its normal — which on a descent
   * reads as the camera gliding a constant 0.4 m off the snow instead of digging into the uphill face.
   */
  function clearancePass(origin: THREE.Vector3, eye: THREE.Vector3): {
    kind: RideCameraClearance; originUnburied: boolean; origin: THREE.Vector3;
  } {
    let originUnburied = false;
    // Unbury the cast origin: an up-facing surface within the window above it means the origin sits under the
    // snow (a dip, a steep crest behind the rider) and would false-block its own sight line. Local move only.
    const bury = castWorld('origin-unbury', origin, camTmp.copy(origin).addScaledVector(WORLD_UP, CAM_UNBURY_WINDOW));
    if (bury && bury.normal.y > 0) {
      origin = bury.point.addScaledVector(bury.normal, CAM_UNBURY_PAD);
      originUnburied = true;
    }

    // Sight line origin → eye: blocked puts the eye ON the blocking surface, padded toward the rider's side.
    const block = castWorld('line-of-sight', origin, eye);
    if (block) {
      eye.copy(block.point).addScaledVector(towardOrigin(block.normal, origin, eye), CAM_LOS_PAD);
      return { kind: 'line-of-sight', originUnburied, origin };
    }

    // Slope clearance, the downhill behavior: a short vertical window through the eye; the moment the snow
    // crosses it, the eye rides the surface at CAM_CLEARANCE along the slope NORMAL.
    const above = eye.clone().addScaledVector(WORLD_UP, CAM_CLEARANCE);
    const below = eye.clone().addScaledVector(WORLD_UP, -CAM_CLEARANCE);
    const ground = castWorld('ground', above, below);
    if (ground) {
      eye.copy(ground.point).addScaledVector(towardOrigin(ground.normal, above, below), CAM_CLEARANCE);
      return { kind: 'ground', originUnburied, origin };
    }

    // Lateral clearance, only when the vertical window is clear: the same test across the boom keeps the eye
    // off banks and walls beside the camera path.
    const axis = camTmp.copy(eye).sub(origin).normalize();
    axis.crossVectors(WORLD_UP, axis).multiplyScalar(CAM_CLEARANCE);
    if (axis.lengthSq() < 1e-6) return { kind: 'none', originUnburied, origin };
    const side = eye.clone().add(axis), farSide = eye.clone().sub(axis);
    const wall = castWorld('lateral', side, farSide);
    if (wall) {
      eye.copy(wall.point).addScaledVector(towardOrigin(wall.normal, side, farSide), CAM_CLEARANCE);
      return { kind: 'lateral', originUnburied, origin };
    }
    return { kind: 'none', originUnburied, origin };
  }

  /** A final obstruction check for the interpolated eye. The original point-eye path filters after clearance;
   * Slopesmith additionally guarantees that interpolation itself cannot carry the render camera through a wall. */
  function filteredLineOfSightPass(origin: THREE.Vector3, eye: THREE.Vector3): boolean {
    const block = castWorld('filtered-line-of-sight', origin, eye);
    if (!block) return false;
    eye.copy(block.point).addScaledVector(towardOrigin(block.normal, origin, eye), CAM_LOS_PAD);
    return true;
  }

  /**
   * Keep the whole retail near-plane footprint outside the rendered terrain. This deliberately follows the
   * authored ray response: the closest face is padded along its geometric normal, oriented toward the rider's
   * side. Re-querying after each move handles a neighbouring wall/floor face in a concave or curved bank.
   */
  function volumePass(origin: THREE.Vector3, eye: THREE.Vector3): boolean {
    if (!o.closestTerrainPoint) return false;
    let corrected = false;
    for (let iteration = 0; iteration < CAM_VOLUME_ITERATIONS; iteration++) {
      const query = eye.clone();
      const hit = o.closestTerrainPoint(query, CAM_VOLUME_CLEARANCE);
      const probe: RideCameraProbe = {
        kind: 'volume', iteration, from: tuple(query), to: tuple(hit?.point ?? query),
        segmentLength: hit?.distance ?? 0, hit: !!hit,
      };
      if (hit) {
        const normal = hit.normal.clone().normalize();
        if (normal.dot(camTmp.copy(origin).sub(hit.point)) < 0) normal.negate();
        probe.hitDistance = hit.distance;
        probe.point = tuple(hit.point);
        probe.normal = tuple(normal);
        probe.source = 'terrain';
        if (hit.distance < CAM_VOLUME_CLEARANCE - 1e-5) {
          eye.copy(hit.point).addScaledVector(normal, CAM_VOLUME_CLEARANCE);
          corrected = true;
        }
      }
      camProbes.push(probe);
      if (!hit || hit.distance >= CAM_VOLUME_CLEARANCE - 1e-5) break;
    }
    return corrected;
  }

  function setHeading(fwd: THREE.Vector3) { camHeading.copy(fwd); }

  function resetAim(_pos: THREE.Vector3) {
    camTrajectoryPitch = 0;
    camEyeValid = false;
  }

  function setThirdPersonZoom(scale: number) { thirdPersonZoom = clampThirdPersonZoom(scale); }

  /** Add a desktop RMB-look delta to the rider-relative camera seat. The view stays where it was aimed after
   * release, making pause + orbit useful for inspecting a character pose from any side. */
  function orbit(deltaX: number, deltaY: number) {
    orbitYaw = Math.atan2(Math.sin(orbitYaw - deltaX * CAM_ORBIT_YAW_PER_PIXEL),
      Math.cos(orbitYaw - deltaX * CAM_ORBIT_YAW_PER_PIXEL));
    orbitPitch = THREE.MathUtils.clamp(
      orbitPitch - deltaY * CAM_ORBIT_PITCH_PER_PIXEL,
      CAM_ORBIT_PITCH_MIN,
      CAM_ORBIT_PITCH_MAX,
    );
  }

  const tuple = (v: THREE.Vector3): RideTelemetryVec3 => [v.x, v.y, v.z];

  /** Exact render-frame state used for retail-vs-Slopesmith camera trace comparison. */
  function telemetry(renderDt: number): RideCameraState {
    const forward = camLook.clone().sub(o.camera.position).normalize();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(o.camera.quaternion).normalize();
    return {
      renderDt,
      subjectPosition: tuple(camSubject),
      candidatePosition: tuple(camCandidate),
      position: tuple(o.camera.position),
      lookTarget: tuple(camLook),
      forward: tuple(forward),
      up: tuple(up),
      targetHeading: tuple(camHeading),
      trajectoryPitchDeg: THREE.MathUtils.radToDeg(camTrajectoryPitch),
      targetTrajectoryPitchDeg: THREE.MathUtils.radToDeg(targetTrajectoryPitch),
      fovYDeg: o.camera.fov,
      nearClipM: o.camera.near,
      aspect: o.camera.aspect,
      boost: camBoost,
      clearance: camClearance,
      correctionDistanceM: camCorrectionDistance,
      originUnburied: camOriginUnburied,
      probes: camProbes,
    };
  }

  return { update, updateFirstPerson, setHeading, resetAim, setThirdPersonZoom, orbit, telemetry };
}

export type RideCamera = ReturnType<typeof createRideCamera>;
