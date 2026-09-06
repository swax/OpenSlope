import * as THREE from 'three';
import { INTERSECTED, MeshBVH, NOT_INTERSECTED } from 'three-mesh-bvh';
import { rideTree, type TreeGeometry } from '../viewport/mesh/surface-trees';
import { RAIL_ENTRY_SCALE, RAIL_GRACE, railWindows, type GrindRails } from './grind';
import { createBoostVolumeRuntime, type BoostVolume, type BoostVolumeRuntime } from './boost-volumes';
import { createCrackedSurfaceRuntime, type CrackedSurface, type CrackedSurfaceRuntime } from './cracked-surfaces';
import { createLapCounter, type FinishLine, type LapCounter } from './laps';
import { sphereVsNativeBox, sweptSphereVsNativeBox } from '../../core/collision/native-box';
import { RIDER_DECK_SAMPLES, RIDER_PROBE_SAMPLES, riderBodyCentre, riderProbeOffsets } from './rider-volume';
import type { RideKeys } from './input';
import type { RideObstacleHit, RideObstacleObject, RideObstacleSource } from './obstacles';
// The tuning table and the stateless contact/vector math live beside this file; both are re-exported below so
// every symbol this module has always published still resolves through `app/ride/physics`.
import {
  AIR_BOOST_ACCEL, AIR_BOOST_CAP_BLEND, AIR_BOOST_TURN_RATE, AIR_H_DRAG, AIR_TRICK_BOOST_SPIN_MUL,
  AIR_TURN_RATE, BOARD_COLLISION_Y, BOARD_SENSOR_BELOW,
  BOOST_ACCEL, BOOST_CAP_DECAY, BOOST_LEAN_WINDOW, BOOST_MAX_SPEED, BRAKE_STRENGTH, CARVE_BITE,
  CARVE_SLIDE_SCALE, CARVE_SLIDE_SLEW, CARVE_SLIDE_SPEED_GATE, CHARGE_RATE, CONTACT_SEPARATION_SPEED,
  CONTACT_SLEW, CRUISE_DEFICIT_MAX, CRUISE_HEADING_FLOOR, D2R, FLIP_RECOVER_RATE, GRAVITY, GRAVITY_RISING,
  GRIP_SCALE,
  GROUND_REDIRECT, GROUND_TANGENTIAL_PULL, GROUND_TURN_RATE,
  HEAD_LEAN_FULL_ANGLE, HEAD_LOOK_DEADZONE, HEAD_STICK_OVERRIDE,
  ICE_SELF_CENTER_DAMP, ICE_SLIP_RECOVER,
  iceAssistFor, iceCarveTilt,
  JUMP_COYOTE_TIME, JUMP_MIN, JUMP_RIDER_CURVE,
  JUMP_SPEED_FACTOR_MAX, LAND_TILT_FREE, LAND_TILT_MAX, LAND_TILT_SCALE, LAND_YAW_FREE, LAND_YAW_MAX,
  LAND_YAW_SCALE, LAUNCH_FALLBACK_TANGENT, LAUNCH_TANGENT_MIX, MAX_SPEED, MAX_TICKS, MOVABLE_MIN_IMPACT,
  NATIVE_DEPENETRATION, NORMAL_SMOOTHING, OLLIE_COOLDOWN, ORIENT_GRACE,
  POP_MIN, POP_TIME, PREALIGN_HORIZON, PREALIGN_STEP, PROBE_ABOVE,
  PROBE_BELOW, PROP_BOUNCE_EJECT_FLOOR, PUSHOUT_CAP, RAIL_ATTACH_CLAMP, RAIL_BOOST_ACCEL, RAIL_GRAVITY,
  RAIL_RELOCK_TIME, RAIL_TANGENT_SLEW, RECOVER_NY, RECOVER_TICKS_MAX,
  REDIRECT_TANGENT_FLOOR, RIDER_BARRIER_PAD, RIDER_BODY_R, RIDER_DRIVE, RIDER_HEAD_Y,
  RIDER_MASS_TERM, SHOVE_RESTITUTION, STEER_SIGN, STEER_STRENGTH, SWITCH_LATCH_ANGLE, SWITCH_LATCH_SPEED,
  TICK_H, WALL_NY, WORLD_UP, XR_GROUND_STICK_VIEW_CARRY,
} from './physics-tuning';
import {
  contactResponse, groundRestDepth, moveTowards, projectOnPlane, surfaceFor, unionLeafNormal,
  type SurfaceRow,
} from './physics-math';
export {
  AIR_LEVEL_RATE, BANK_MAX, CONTACT_SEPARATION_SPEED, CROUCH_AIR, CROUCH_BRAKE, CROUCH_FOLD, CROUCH_POP,
  CROUCH_REACH, D2R, GROUND_ORIENT_GAIN, GROUND_TANGENTIAL_PULL, LAND_REACH_ETA, LAUNCH_LEVEL_SPEED,
  ORIENT_GRACE, PREALIGN_HORIZON, PREALIGN_LEAD, RIDER_DRIVE_MIN, RIDER_DRIVE_SPAN, SWITCH_LATCH_ANGLE,
  SWITCH_LATCH_SPEED, TILT_RATE, WORLD_UP, riderDrive,
} from './physics-tuning';
export {
  SURFACE_ROWS, contactResponse, groundRestDepth, moveTowards, projectOnPlane, rotateTowards, unionLeafNormal,
} from './physics-math';
export type { SurfaceRow } from './physics-math';
import type {
  RideTelemetryEvent,
  RideTelemetryProbe,
  RideTelemetryRedirect,
  RideTelemetryState,
  RideTelemetryTick,
  RideTelemetryVec3,
} from './telemetry';
import { createRidePerf } from './perf';
import { clamp, clamp01 } from '../../core/math/scalar';

export { clamp, clamp01 } from '../../core/math/scalar';

/**
 * Test ride (docs/016) — a "get a feel for it" playtest inside the editor. The board physics are a faithful
 * port of the shipped SSX ground model, taken from the Unity board (`Basis/Riding/BasisBoard.Ride.cs`
 * + `.Surface.cs`, itself a verbatim port of the VRChat `RideableBoard`) and the functional spec
 * [Trailmap: 310-surface-response / 320-ground-contact / 330-carving / 360-speed-and-boost]. The relative
 * per-surface orderings and the carve math are the real values; the model is stepped in world metres.
 *
 * The heart of the feel (330): steering is a smoothed **lean** signal that yaws the board's *facing* about the
 * contact normal (auto-centring onto the travel direction via the slip term) — it does NOT rotate the velocity.
 * The velocity is then split in the contact frame and its **lateral slip is carved away** by the surface's
 * grip, so an edged board bends its path; ice keeps sliding. Down-slope speed is **shaped** (360): there is no
 * bare g·sinθ runaway — a per-surface **speed target** re-accelerates the board, bounded by a decaying speed cap.
 *
 * Under the deck the contact is a **free error**, not a snap ([Trailmap: 320]). The deck reference carries a
 * signed clearance along the contact normal; the measured grounded pull draws it in, the surface's three-zone
 * response pushes back, and the deck settles wherever those balance. Nothing re-seats it at a hover height,
 * nothing clamps gravity's into-surface component, and nothing projects velocity except at touchdown. Every
 * signature then falls out of the table rather than being coded: the powders bury and the hard surfaces stay
 * crisp because their response saturates at different depths; the landing plunge is the response's own
 * transient; and the board crests a roll exactly when gravity can no longer supply the centripetal
 * acceleration the surface demands (`R = v²/(g·n̂)`) — there is no liftoff test anywhere below.
 *
 * The physics runs a **fixed 60 Hz tick**, because the engine's does (`dt = +0x12c/60`) and its contact model
 * is a per-tick discrete system: the pushout adds a *length* to velocity once per tick, and the contact fields
 * slew 1.6667 units per tick. A dt-scaled port is a different game at every frame rate.
 *
 * Coordinates are WORLD space (post-chirality): the board parents under the top scene, gravity is world −Y, and
 * the terrain down-raycasts read straight. The host (viewport) flips the data-space spawn/heading to world.
 */

const DOWN = new THREE.Vector3(0, -1, 0);
/** Cosine of the swing that hands the lead to the other end of the deck; see SWITCH_LATCH_ANGLE. */
const SWITCH_LATCH_COS = Math.cos(SWITCH_LATCH_ANGLE * D2R);

/**
 * Which way the rider is **riding**, as against which way the deck is **drawn** (docs/016, riding switch).
 * `fwd` is the board's nose; `lead` says which of its two ends currently leads the travel — `+1` regular,
 * `−1` switch. Every term that means "along the travel" reads this: the carve frame and its lateral, the cruise
 * drive's alignment gate, the brake, the boost thrust, the touchdown yaw band and the chase camera's standstill
 * fallback. Only the drawn deck reads `fwd` itself. That split is the whole feature — landing backwards changes
 * what the rider *looks* like and nothing about how the board rides.
 */
export function rideForward(st: { fwd: THREE.Vector3; lead: number }, out: THREE.Vector3): THREE.Vector3 {
  return out.copy(st.fwd).multiplyScalar(st.lead);
}

const boardPointingRight = new THREE.Vector3();
/**
 * The direction the drawn deck's nose actually points. `fwd` carries heading/pitch and `boardUp` carries the
 * contact-chased deck plane; the visible flip is layered over both in `pose.ts`, so it belongs here too. Carve
 * bank is a rotation ABOUT this axis and therefore cannot change it.
 */
export function boardPointingDirection(
  st: { fwd: THREE.Vector3; boardUp: THREE.Vector3; flip: number; lead: number }, out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(st.fwd).addScaledVector(st.boardUp, -st.fwd.dot(st.boardUp));
  if (out.lengthSq() < 1e-8) out.copy(st.fwd);
  if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
  out.normalize();
  boardPointingRight.crossVectors(st.boardUp, out);
  if (boardPointingRight.lengthSq() > 1e-8 && st.flip !== 0) {
    boardPointingRight.normalize();
    out.applyAxisAngle(boardPointingRight, st.flip * st.lead * D2R);
  }
  return out.normalize();
}

/**
 * How far an accumulated flip is from having the deck back on its base, folded onto (−180°, 180°]. Whole
 * rotations are spent and forgotten: three somersaults and a bit land exactly as well as the bit does.
 */
export function flipResidual(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

/**
 * The signed angle from `from` to `to` about `axis`, in radians over (−π, π]. All three are expected unit, with
 * `from` and `to` already in the axis's plane. This is the one frame every slip, lead and gaze offset in the
 * steering model is measured in, so they compose: positive is the same rotation sense throughout.
 */
export function angleAbout(from: THREE.Vector3, to: THREE.Vector3, axis: THREE.Vector3): number {
  return Math.atan2(angleAboutTmp.crossVectors(from, to).dot(axis), from.dot(to));
}
const angleAboutTmp = new THREE.Vector3();

/**
 * Evaluate the exact surface a faceted hit approximates. The face plus arbitrary barycentric weights select a
 * surface parameter; the callee writes the analytic point + normal there in terrain LOCAL space. Physics first
 * calls it at the triangle seed, then at Newton iterates until patch(u,v) actually lies on the probe ray.
 * `false` = no patch data for this face; the faceted fallback stands.
 */
export type PatchContact = (
  faceIndex: number, bary: THREE.Vector3, outPoint: THREE.Vector3, outNormal: THREE.Vector3,
) => boolean;

export type { RideObstacleHit, RideObstacleObject, RideObstacleSource } from './obstacles';

/** The speed a rider is set down at by ANY course reset ([Trailmap: 395]: the engine's warp state writes a
 *  speed-along-the-path velocity into the boarder record — 833.33 u/s). It is a fixed push and deliberately not
 *  the speed the rider arrived with: they are wedged and stopped as often as they are falling and fast, and
 *  neither number has anything to do with how a reset should let go of them. */
export const RESET_SPEED = 8.3333;
/** How far above and below a course point the reset looks for real ground (`resetGroundAt`). */
const RESET_GROUND_ABOVE = 220, RESET_GROUND_BELOW = 240;

/** A contact probe result. `point` is the world contact point; `n` its outward surface normal. */
interface Probe {
  found: boolean; point: THREE.Vector3; n: THREE.Vector3; surf: number;
  /** The prop this contact seated on; absent for terrain, which owns no obstacle identity. */
  key?: string;
}

export interface RideModelOpts {
  spawn: THREE.Vector3;
  heading?: THREE.Vector3;
  terrain: THREE.Mesh;
  surfaceOf: (faceIndex: number) => number | null;
  /** Exact Bezier contact for authored or extracted-reference terrain; absent only for a faceted fallback. */
  patchContact?: PatchContact;
  /** The course's grind-rail network ([Trailmap: 350]); absent when the ridden world carries no rails. */
  rails?: GrindRails;
  /** Static prop collision pieces on the selected Play target, captured at ride launch. */
  obstacles?: readonly RideObstacleSource[];
  /** MainType-0 boost-family volumes in editor world space (`buildBoostVolumes`). Read-only geometry shared by
   *  every rider on the mountain; this model builds its own latch state over them. */
  boostVolumes?: readonly BoostVolume[];
  /** Cracked surfaces on this mountain ([Trailmap: 370-world-interaction]). Like the boost volumes, the drain
   *  is per-tick rather than per-contact: the pool is spent by charges that keep arriving while the rider is
   *  CARRIED, one every 30 frames, so a debounced dispatch would break a pane on first touch. */
  crackedSurfaces?: readonly CrackedSurface[];
  /** A player-session-owned crack pool. WebXR keeps this alive while the board is parked so walking and
   *  Superman flight charge the same panes as riding; ordinary rides and AI omit it and build their own. */
  crackedSurfaceRuntime?: CrackedSurfaceRuntime;
  /** First damage selects the model's cracked material frame; a finite crack lifetime restores intact. */
  onCrackedChange?(key: string, cracked: boolean): void;
  /** A cracked surface has given way. The caller runs the slot's trigger column and hides the host. */
  onCrackedBreak?(key: string): void;
  /** The ridden world's main course line in world space. */
  course?: readonly THREE.Vector3[];
  /** The mountain's own finish crossing in world space, for the lap countdown. Absent falls back to the tail
   *  of `course`, which is only right on a course that ends where it finishes. */
  finish?: FinishLine | null;
  /** Passes from the start gate to the finish this course is raced over (core/doc/race). One (or absent) is a
   *  single pass and counts nothing. */
  laps?: number;
  /** Fires on the tick a finish crossing is counted as a lap, with the counter as it lands — the number the
   *  crossing announces ("3 laps to go" = 3), never zero: the crossing that lands zero is the finish. */
  onLap?: (remaining: number) => void;
  /** World Y below which the rider is out of bounds and may automatically recover (terrain min − a margin). */
  oobFloorY: number;
  /** Whether a rider that goes out of play is CARRIED BACK onto the course near where they left it (the default,
   *  `resetToCourse` below), or simply re-seated at the saved spawn point. The AI field takes the second: it runs
   *  its own rubber-banded reset over the respawnable AIP network (`ride/ai.courseReset`), placing the rider with
   *  the pack rather than where it fell — and that reset is armed by exactly this model's plain respawn, so a
   *  carry-back here would only warp every reset rider twice. */
  carryBack?: boolean;
  /** The live OR-aggregate of keyboard, touch, and gamepad holds (`input` owns it). */
  keys: RideKeys;
  /** The active touch/gamepad analog axis. Ground/rail use centre-softened `x`; air may supply linear `airX`. */
  stick: { readonly active: boolean; readonly x: number; readonly airX?: number };
  /**
   * VR HEAD STEER (docs/048): the rider's world-space gaze direction, or null while nothing is looking. Supplied
   * only by a headset ride; absent — every desktop, touch and pad ride — the heading stays referenced to travel
   * and not one term below changes, which is what keeps the retail traces this model is pinned to intact.
   *
   * With one, the model does what the shipped VRChat board does (Unity docs/vrchat/017): grounded, the yaw closure
   * leads the GAZE instead of the travel and the gaze offset drives the same input→lean slew a stick would, so a
   * head-steered turn edges the board and carries the real banked force; airborne, the heading turns toward the
   * gaze at the air rate and stops there. It is a REFERENCE swap, not a second steering path: every rate, gate
   * and cap is the one the stick runs through.
   */
  gaze?: () => THREE.Vector3 | null;
  /** Run-scoped held-boost gate. Omitted means unlimited; TestRide supplies the Unity boost-meter charge check. */
  heldBoostAvailable?: () => boolean;
  /** Whether world-driven out-of-play recovery may fire. Omitted preserves retail/AI automatic recovery.
   *  TestRide limits it to a live scored run; the public `resetToCourse` method remains manual and unconditional. */
  automaticRespawnAvailable?: () => boolean;
  /** This rider's cruise-drive factor — its speed statistic ([Trailmap: 360], `riderDrive`). Omitted = the
   *  mid-band `RIDER_DRIVE` the player rides at. */
  drive?: number;
  /**
   * Low-grip steering assist, on unless explicitly disabled (mirrors the Unity board's `lowGripAssist` field).
   * `false` rides exact retail ice — no tilt lift, no yaw damping, no slip recovery — which is what a test
   * pinning the shared CONTACT LAW has to do: the banked-frame assertion in `test/ride-telemetry.test.ts`
   * measures `A/100 · tan(45°·lean)` to catch a regression in the contact response itself, and an ice-only
   * multiplier folded into that number would let such a regression hide inside the assist.
   */
  lowGripAssist?: boolean;
  /** Fires at the end of every respawn (spawn included), after the state is re-seated on the spawn point. */
  onRespawn: () => void;
  /** Optional observer called once per completed fixed physics tick with an immutable, JSON-safe trace. */
  onTelemetryTick?: (tick: RideTelemetryTick) => void;
  /** Exact swept prop contact (solid or ride-through), debounced per prop by the ride model. */
  onObstacleHit?: (hit: RideObstacleHit) => void;
}

/**
 * The live board: the physics state record, the fixed-tick integrator, and the terrain contact queries under
 * it (BVH probe rays, analytic patch refinement, barrier sweeps). The host poses the drawn board and rider
 * straight off `st` each frame and drives the chase camera from the same fields; `castSeg` /
 * `toWorld` serve the camera's terrain clearance through the same perf-accounted raycast path the probe uses.
 */
export function createRideModel(o: RideModelOpts) {
  // Probe rays answer through a BVH — the accelerated closest-hit query PhysX serves the Unity board's
  // RaycastNonAlloc — instead of three's per-triangle scan (which is the whole frame on a six-figure-tri
  // mesh). Queried directly in the terrain's local space with an explicit DoubleSide (all the terrain
  // materials are DoubleSide — the chirality flip needs it), so the hits match THREE.Raycaster exactly.
  let bvh!: MeshBVH;
  const toLocal = new THREE.Matrix4();  // world → terrain local, for the probe rays
  const toWorld = new THREE.Matrix4();  // terrain local → world, for the hit points
  const normalMat = new THREE.Matrix3(); // terrain local → world, for the analytic patch normal
  const localRay = new THREE.Ray();
  const localRayHit = new THREE.Vector3(), localRayBoxHit = new THREE.Vector3();
  const terrainWorldHit = new THREE.Vector3();
  const cameraTerrainLocal = new THREE.Vector3(), cameraTerrainWorld = new THREE.Vector3();
  const cameraTerrainNearHit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  // analytic-contact scratch: the hit's triangle + barycentric weights, and Newton's exact ray/patch solve
  let geoPos!: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  let geoIndex: ArrayLike<number> | null = null;
  const triA = new THREE.Vector3(); const triB = new THREE.Vector3(); const triC = new THREE.Vector3();
  const baryTmp = new THREE.Vector3();
  const patchP = new THREE.Vector3(); const patchN = new THREE.Vector3();
  const patchSeed = new THREE.Vector3(); const patchDxP = new THREE.Vector3(); const patchDyP = new THREE.Vector3();
  const patchTmpN = new THREE.Vector3(); const patchResidual = new THREE.Vector3(); const patchStep = new THREE.Vector3();
  const patchDx = new THREE.Vector3(); const patchDy = new THREE.Vector3();
  const patchJacobian = new THREE.Matrix3(); const patchInverse = new THREE.Matrix3();
  // Props are flattened into world space once per ride. `indirect` preserves triangle order, so a BVH hit's
  // faceIndex remains a direct lookup into obstacleFaceMeta and therefore back to the exact placement whose
  // sound/effect/contact tuning it carries.
  interface ObstacleMeta {
    key: string;
    object: RideObstacleObject;
    /** False once an effect has killed this launch-time collider. The BVH can retain its immutable faces. */
    enabled: boolean;
    solid: boolean;
    bounce: number;
    playerBounce: boolean;
    surface: number;
    /** Non-zero selects the rigid-body shove path and supplies the Roller's scalar mass. */
    dynamicMass: number;
    /** World-space mass properties for the shove solve: centre of mass, and the inverse inertia tensor rotated
     *  and rescaled out of model space (row-major 9, 1/(mass·m²)). Absent when the body authored no tensor. */
    body?: { com: THREE.Vector3; invInertia: Float32Array } | null;
  }
  interface ObstacleTouch {
    meta: ObstacleMeta;
    point: THREE.Vector3;
    normal: THREE.Vector3;
    impactSpeed: number;
    /** Distance along this iteration's common movement vector; comparable across all body samples. */
    distance: number;
  }
  interface ObstacleSphereBody {
    meta: ObstacleMeta;
    spheres: Float32Array;
    matrixWorld: THREE.Matrix4;
    toLocal: THREE.Matrix4;
    normalMatrix: THREE.Matrix3;
    /** Conservative world bound for the once-per-tick broad phase. */
    bound: THREE.Sphere;
    /** Model-local bound, so a moved body re-places `bound` without rescanning its leaves. */
    localCenter: THREE.Vector3;
    localRadius: number;
    /** The body sphere's radius carried into this body's local space, for the contact gate below. Derived from
     *  the transform's SMALLEST axis scale, so a non-uniformly scaled body never under-states it. */
    localBodyRadius: number;
    /** Set once per collide-and-slide iteration: did the rider's body sphere reach this body at all? A native
     *  mode-3 contact is gated on that before any limb is considered ([Trailmap: 370-probe-modes]). */
    reachedByBody: boolean;
    liveMatrix?: () => THREE.Matrix4;
    poseVersion?: () => number;
    appliedVersion?: number;
  }
  /** A native mode-2 instance, kept as the box it is. The rider meets it through the face-only sphere law
   *  ([Trailmap: 370-sphere-box]) rather than as eight tessellated corners, so it never enters the BVH. */
  interface ObstacleBox {
    meta: ObstacleMeta;
    /** The box itself, in the MODEL's own local frame — this is the collider [Trailmap: 130-mode2-oriented]. */
    localMin: THREE.Vector3;
    localMax: THREE.Vector3;
    matrixWorld: THREE.Matrix4;
    toLocal: THREE.Matrix4;
    normalMatrix: THREE.Matrix3;
    /** The placement's linear part, for carrying a local-frame DISPLACEMENT back out to world exactly. */
    linear: THREE.Matrix3;
    /** The rider's body-sphere radius carried into this box's local frame, from the smallest axis scale. */
    localRadius: number;
    /** Conservative world bound for the once-per-tick broad phase. */
    bound: THREE.Sphere;
    liveMatrix?: () => THREE.Matrix4;
    poseVersion?: () => number;
    appliedVersion?: number;
  }
  /** One moving source's triangle run inside the baked obstacle buffer. Keeping the run's model-local vertices
   *  lets a pose change rewrite just those positions rather than rebuild the whole level's tree. */
  interface LiveObstacleMesh {
    liveMatrix: () => THREE.Matrix4;
    /** De-indexed model-local vertices, in the exact order they were baked into `obstaclePos`. */
    local: Float32Array;
    /** First vertex of the run in `obstaclePos`. */
    start: number;
    /** The pose the baked vertices currently hold. */
    applied: THREE.Matrix4;
    /** BVH nodes covering this run — its leaves plus their ancestors, the subtree a refit must re-derive. */
    nodes: Set<number> | null;
    /** The provider's pose stamp (`RideObstacleSource.poseVersion`) and the value last consumed. */
    poseVersion?: () => number;
    appliedVersion?: number;
  }
  let obstacleBVH: MeshBVH | null = null;
  let obstaclePos: THREE.BufferAttribute | null = null;
  let obstacleFaceMeta: number[] = [];
  let obstacleMetas: ObstacleMeta[] = [];
  let obstacleSphereBodies: ObstacleSphereBody[] = [];
  let obstacleBoxes: ObstacleBox[] = [];
  let liveObstacleMeshes: LiveObstacleMesh[] = [];
  const liveVertex = new THREE.Vector3();
  /** Frame scratch: the union of this frame's moved subtrees, handed to `MeshBVH.refit`. */
  const refitNodes = new Set<number>();
  const obstacleRay = new THREE.Ray();
  const obstacleRayHit = new THREE.Vector3(), obstacleRayBoxHit = new THREE.Vector3();
  const obstacleNormal = new THREE.Vector3();
  const cameraObstacleMotion = new THREE.Vector3();
  const boxWorldBounds = new THREE.Box3(), boxCorner = new THREE.Vector3();
  const bodySphereFrom = new THREE.Vector3(), bodySphereTo = new THREE.Vector3();
  const boxEnd = new THREE.Vector3();
  const boxNormal = new THREE.Vector3(), boxPoint = new THREE.Vector3();
  const boxLocalFrom = new THREE.Vector3(), boxLocalTo = new THREE.Vector3();
  const boxPush = new THREE.Vector3();
  const obstacleNearHit = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const obstacleHitNext = new Map<string, number>();

  /** The lap countdown, or null on a single-pass course. Built before the volumes below because the lap-gated
   *  one reads it: counting laps and honouring that gate are one feature ([Trailmap: 390-lap-counter]). */
  const lapCounter = createLapCounter(o.course, o.laps ?? 1, o.finish);

  /** The crack drain. Charged from per-tick surface containment, which is the CARRIED regime, and from a
   *  blocking obstacle hit, which is the IMPACT one — the two costs differ by two orders of magnitude. */
  function retireObstacle(key: string): void {
    for (const meta of obstacleMetas) if (meta.key === key) meta.enabled = false;
    barrierTouches.delete(key);
    barrierIterationTouches.delete(key);
    barrierSensorTouches.delete(key);
    obstacleHitNext.delete(key);
  }

  /**
   * Re-arm a temporarily retired pickup without rebuilding the launch-time obstacle BVH. Clear every contact
   * latch just as retirement does so the next crossing is a fresh hit, including when the object returned while
   * the rider was still close to its cached faces.
   */
  function restoreObstacle(key: string): void {
    for (const meta of obstacleMetas) if (meta.key === key) meta.enabled = true;
    barrierTouches.delete(key);
    barrierIterationTouches.delete(key);
    barrierSensorTouches.delete(key);
    obstacleHitNext.delete(key);
    crackedSurfaces?.restore(key);
  }

  const crackedSurfaces: CrackedSurfaceRuntime | null = o.crackedSurfaceRuntime ?? (o.crackedSurfaces?.length
    ? createCrackedSurfaceRuntime(o.crackedSurfaces, {
      onCrack: key => o.onCrackedChange?.(key, true),
      onHeal: key => o.onCrackedChange?.(key, false),
      onBreak: key => {
        // THE PANE STOPS BEING THERE, which is the half of the break the caller cannot do. Hiding the host is a
        // render change and this model never consults visibility, so a hidden pane would still hold the rider up
        // — and falling through is the whole point of a glass floor giving way. Every collision gate in here
        // reads the enabled bit, so retiring the broken host removes it from every query without rebuilding the
        // launch-time BVH. The Trigger graph may subsequently retire a DIFFERENT solid support twin as well.
        retireObstacle(key);
        o.onCrackedBreak?.(key);
      },
    })
    : null);

  /** Feed presence from a locomotion controller that temporarily owns this rider instead of the board.
   *  `height` extends the presence up from the chord — the on-foot walker passes its standing body so a
   *  chest-high pane registers on the torso; the board's own tick keeps the retail point presence. */
  function stepCrackedSurfaces(from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3, dt: number,
    height = 0) {
    crackedSurfaces?.step(from, to, velocity, dt, height);
  }
  /** This rider's own latch state over the mountain's shared volumes ([Trailmap: 360-node-apply]) — the engine
   *  keeps its classification and captured launch axis per rider, so an opponent already climbing the tube can
   *  never hand its stage to the board beside it. */
  const boostVolumes: BoostVolumeRuntime | null = o.boostVolumes?.length
    ? createBoostVolumeRuntime(o.boostVolumes, lapCounter ? {
      // The lap-gated volume's mouth is a crossing station of its own (laps.ts) — on MEGAPLEX the one every
      // mid-race pass actually ends at — so entry counts the crossing, announces it, and hands the gate the
      // value the engine's gate reads: post-decrement ([Trailmap: 360-lapboost-gate, 390-lap-field]).
      enterLapVolume: () => {
        if (lapCounter.enterLapVolume()) o.onLap?.(lapCounter.remaining);
        return lapCounter.remaining;
      },
    } : {})
    : null;
  const sphereLocalFrom = new THREE.Vector3(), sphereLocalTo = new THREE.Vector3();
  const sphereLocalDir = new THREE.Vector3(), sphereLocalHit = new THREE.Vector3();
  const sphereLocalNormal = new THREE.Vector3(), sphereWorldPoint = new THREE.Vector3();
  const sphereWorldNormal = new THREE.Vector3();
  interface SphereHitCandidate { u: number; index: number }
  // Reused and grown only to the largest intersected leaf count seen in a ride. The hot cast orders candidates
  // before asking for the expensive union normal, avoiding one full leaf scan for every overlapping sphere.
  const sphereHitCandidatePool: SphereHitCandidate[] = [];
  const sphereHitCandidates: SphereHitCandidate[] = [];
  // Barrier sweep scratch. This path runs on every grounded tick when props exist; keeping its 13 body offsets,
  // iteration vectors and touch maps stable avoids feeding hundreds of short-lived Vector3/Array objects to the
  // browser GC every second even when every BVH query is a cheap miss.
  const shoveZero = new THREE.Vector3();
  const shoveOffset = new THREE.Vector3(), shoveRxN = new THREE.Vector3();
  const shoveTmp = new THREE.Vector3(), shoveApplied = new THREE.Vector3();
  const barrierMovement = new THREE.Vector3(), barrierUp = new THREE.Vector3();
  const barrierForward = new THREE.Vector3(), barrierRight = new THREE.Vector3();
  const barrierPosition = new THREE.Vector3(), barrierRemaining = new THREE.Vector3();
  const barrierDirection = new THREE.Vector3(), barrierFrom = new THREE.Vector3(), barrierTo = new THREE.Vector3();
  /** The body sphere's end point for this iteration, kept off the per-sample ray scratch above. */
  const barrierBodyTo = new THREE.Vector3();
  const barrierSensorMotion = new THREE.Vector3();
  const integrationPrevious = new THREE.Vector3();
  const probeTmp = new THREE.Vector3(), probeLatTmp = new THREE.Vector3(), probeRideTmp = new THREE.Vector3();
  const barrierOffsets = Array.from({ length: RIDER_PROBE_SAMPLES }, () => new THREE.Vector3());
  const barrierTouches = new Map<string, ObstacleTouch>();
  const barrierIterationTouches = new Map<string, ObstacleTouch>();
  const barrierSensorTouches = new Map<string, ObstacleTouch>();
  /** Per-ray staging prevents an out-of-order BVH visit from reporting a trigger beyond the eventual wall. */
  const barrierMeshTouches = new Map<string, ObstacleTouch>();
  let rideElapsed = 0;
  /** Where the rider was at the last boost-volume update — the back end of that pass's swept presence query.
   *  A teleport re-seats it, so a warp across the mountain never reads as travel through everything between. */
  const boostFrom = new THREE.Vector3();
  /** Where the rider was when the crack drain last ran, so a fast pass cannot step over a thin pane. */
  const crackFrom = new THREE.Vector3();
  let crackSeeded = false;

  /**
   * The WEDGE INTEGRATOR ([Trailmap: 395-reset-arm]) — the engine's "stuck against the level" detector, and the
   * reason it needs no stuck timer. It decays every tick and is fed on every frame the rider is in contact with
   * a prop; five or so consecutive contact frames carry it over the threshold and the rider goes out of play,
   * which for an AI rider is the course reset and for the player is the ordinary respawn.
   *
   * The feed is `+= (dot < 0) ? 1 : 1 − dot`, where `dot` is board-up · contact-normal. That behavior makes
   * the mechanism coherent [Trailmap: 395-reset-arm]: a rider standing ON a prop
   * has its board up along the contact normal and feeds ZERO, so a rideable prop surface never accumulates,
   * while a rider shoved by a wall — board up across the normal — feeds a full 1 every frame. The engine's second,
   * slower integrator over the same feed (decay 0.97836, threshold 12.0021) can only ever fire later than this
   * one on a rider this one has not already reset, so it is not fielded.
   */
  const WEDGE_DECAY = 0.95614;   // per 60 Hz tick
  const WEDGE_FIRE = 4.4920;     // ≈ five consecutive contact frames of a square-on shove
  let wedge = 0;

  /** One frame's contribution, from the normal of a prop contact that actually pushed the rider back. */
  function wedgeContribution(normal: THREE.Vector3): number {
    const up = st.boardUp.lengthSq() > 1e-6 ? st.boardUp : WORLD_UP;
    const dot = up.dot(normal) / Math.max(1e-6, up.length() * normal.length());
    return dot < 0 ? 1 : 1 - dot;
  }

  /**
   * THE CARRY-BACK TRAIL — the second answer to a rider who has gone out of play, behind the course line itself
   * (`resetToCourse`). A ring of recent positions, taken only on frames the rider was genuinely ON a rideable
   * piece of the mountain, so a mountain with no authored course still has somewhere honest to put a rider back
   * down. Crumbs are dropped on TERRAIN only: a prop can be shoved or retired between the crumb and the reset.
   */
  const CRUMB_SPACING = 3;       // metres between crumbs; 48 of them is ~140 m of trail
  const CRUMB_BACK_DISTANCE = 6; // how far back UP the trail a crumb reset lands — clear of whatever stopped you
  const crumbPos = Array.from({ length: 48 }, () => new THREE.Vector3());
  const crumbFwd = Array.from({ length: 48 }, () => new THREE.Vector3(0, 0, 1));
  let crumbWrite = 0, crumbFilled = 0;
  /** Past this the nearest course point is not the line the rider left — it is some other part of the mountain
   *  the course happens to fold back past — so the trail is the better answer. */
  const COURSE_RESET_MAX_DIST = 150;
  /** Resets this close together mean the reset TARGET is the trap: the carry-back keeps putting the rider
   *  somewhere that puts them straight back out of play, and only leaving it entirely breaks the loop. */
  const RESET_STREAK_WINDOW = 4, RESET_STREAK_LIMIT = 3;
  let lastResetAt = -999, resetStreak = 0;
  // Perf breakdown (docs/016). The physics owns cast accumulation because every query site lives here; the
  // session and viewport fill the other drill-down/broad phases around it. Displayed values are smoothed ms.
  const perf = createRidePerf();

  // physics state (mirrors BasisBoard)
  const st = {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    /**
     * The board's own acceleration, world m/s² — the rider's arms read it and nothing else does.
     *
     * It is measured, not taken from `groundTick`'s `accel` vector, because half of what a rider feels never
     * passes through that vector: the pushout kills the normal velocity outright, the ollie adds its launch as an
     * impulse, a crooked touchdown scales the whole velocity down and the speed cap clips it. Δv across the ticks
     * that actually ran catches every one of them, and a frame that ran no tick holds the last value rather than
     * reporting a spurious zero.
     */
    accel: new THREE.Vector3(),
    fwd: new THREE.Vector3(0, 0, 1),      // board heading (unit), yawed about the contact normal
    /**
     * Which end of the deck leads: `+1` the nose (regular), `−1` the tail (switch). The board is symmetric and
     * the air spin can leave it pointing either way, so the *lead* — not the drawn facing — is what the ground
     * model rides on (`rideForward`). It is latched by the travel, never by input: a landing commits to whichever
     * end is already leading, and grounded travel that swings past `SWITCH_LATCH_ANGLE` hands the lead over.
     */
    lead: 1 as 1 | -1,
    boardUp: new THREE.Vector3(0, 1, 0),  // physics up, blends toward the contact normal
    contactN: new THREE.Vector3(0, 1, 0), // smoothed contact normal
    airUp: new THREE.Vector3(0, 1, 0),
    lean: 0,
    bank: 0,
    /**
     * Accumulated flip about the deck's lateral axis, degrees, signed in the RIDDEN frame — positive is forward
     * over the nose (W), negative backward over the tail (S). It accumulates freely in the air and is never
     * folded back, so it stays continuous for the render lerp; grounded it eases to the NEAREST whole rotation,
     * which draws identically to zero. The contact model does not read it: this is a rotation of the drawn deck
     * (and the rider it carries), and the only place it reaches the physics is the touchdown tilt band, where an
     * unfinished rotation is priced exactly like the crooked landing it is.
     */
    flip: 0,
    /** Slewed lateral carve slide, metres along the contact-frame lateral ([Trailmap: 330]); the deck and the
     *  ground probe both carry it, so a carve on concave terrain reads a deeper error and builds its response. */
    carveSlide: 0,
    slip: 0,
    /**
     * VR SEAT CARRY (docs/016), radians about world up, accumulated and never wrapped so a reader can take plain
     * deltas across a frame that spent several ticks. Nothing in this model reads it: a seat is not a physics
     * quantity, and the board's own heading is `fwd`. It is banked here because it is the STICK's turn intent —
     * `turnLean` before the closure and the low-grip damping touch it — measured inside the tick that formed it.
     *
     * A headset seat has to be pinned or it spins the wearer (Unity docs/vrchat/017): head-steer therefore contributes
     * nothing, since a gaze that dragged the seat would read as a further gaze offset and feed back. Only the
     * thumb turns the view with the board, and only while it is actually deflected: 25% carry on snow, full carry
     * in air and on rails.
     */
    seatYaw: 0,
    crouch: 0,          // −1 driving, 0 standing, 1 coiled; drives the rider's legs, nothing physical
    popTime: 0,         // what is left of the leg drive out of a launch
    popDrive: 0,        // how hard it drives, in the charge that fed the launch
    riderSeated: false, // false until the absorber has been snapped onto a fresh pose (spawn, respawn)
    speedCap: MAX_SPEED,
    grounded: false,
    airTime: 0,
    /** Total flight seconds predicted at air-state entry. Retail keeps this separately from elapsed airtime and
     * uses it to gate the focused-rider MAIN/032 wind voice at >1.5 s. Zero means no landing was found. */
    predictedAirTime: 0,
    /** Predicted seconds until the falling deck meets the surface ahead ([Trailmap: 340] pre-landing alignment).
     *  Infinity while rising, grounded, grinding, or when nothing sits inside the lookahead horizon. */
    landEta: Infinity,
    /** Signed clearance of the deck reference along the contact normal; negative = penetrating. The whole model. */
    error: 0,
    /** The rider's rate-limited copies of the surface's two depth fields ([Trailmap: 310]); they slew in every tick. */
    sinkBudget: 0, sinkBog: 0,
    lift: 0, // per-surface render lift of the drawn deck; slews to zero off the ground
    surf: 1,
    /** Key of the prop the deck is seated on this tick, null on terrain or in the air. Read only by the barrier
     *  sweep's roof clause, which must not force air against the rider's own ground. */
    groundKey: null as string | null,
    /** An ollie forces motion state 1 until the deck has actually cleared the surface ([Trailmap: 300]). */
    forcedAir: false,
    /** Index of the rail being ground, −1 riding terrain/air ([Trailmap: 350]: motion state 3). */
    railIdx: -1,
    railTime: 0, // grind duration; the first 0.6 s hold the widest acceptance windows (the attach grace)
    railYaw: 0,  // signed current deck angle to rail travel (deg, wrapped); steering itself is continuous
    // charged ollie (RideableBoard InputUse / LaunchOllie): hold Space to build charge, release to launch
    charging: false,
    charge: 0,          // 0..1; squared into launch power on release
    jumpGrace: 0,       // coyote window after leaving the ground
    ollieCooldown: 0,   // swallows a re-pop right after a launch
  };
  /**
   * A grounded in-place mount may start on an ordinary solid prop whose native SurfaceType is absent. Walking
   * can stand on that shell, but the board's normal contact probe quite deliberately cannot: `surface < 0`
   * means obstacle handling for every ordinary landing. Remember only the shell directly under that mount and
   * let the contact/barrier pair treat it as readable until the board's probe leaves it. A later landing on the
   * same prop is therefore still an obstacle impact, not a silently reclassified ride surface.
   */
  let mountSupportKey: string | null = null;
  const obstacleIsProbeReadable = (meta: ObstacleMeta, allowUntyped = false): boolean =>
    meta.enabled && meta.solid && meta.dynamicMass <= 0
      && (meta.surface >= 0 || meta.key === mountSupportKey || allowUntyped);
  // Aimed-air-boost scratch is stable across ticks: this path is live at 60 Hz and must not manufacture four
  // short-lived vectors every time the trigger is held.
  const airAim = new THREE.Vector3(), airVelocityDir = new THREE.Vector3();
  const airAimPerp = new THREE.Vector3(), airTurnAxis = new THREE.Vector3();

  const tickV0 = new THREE.Vector3(); const dv = new THREE.Vector3(); let dvTicks = 0;
  let recoverTicks = 0; // consecutive ticks the seam recovery supplied the contact; reset by any ray find
  let railCooldown = 0; // rail re-lock lockout, armed by a jump off a rail
  let releaseQueued = false;
  let accum = 0; // real time banked toward the next fixed physics tick
  // Render interpolation: the state at the START of the newest tick, plus the banked fraction toward the next.
  // The visible rider draws at `prev + (current − prev)·(accum/TICK_H)`, so a display outrunning the 60 Hz
  // simulation (a 120 Hz phone) samples smooth motion instead of aliasing whole-tick jumps into judder.
  const prevPos = new THREE.Vector3(), prevFwd = new THREE.Vector3(0, 0, 1), prevVel = new THREE.Vector3();
  let prevFlip = 0;
  // `fwd` is the drawn nose (the pose seats the deck along it); `rideFwd` is the direction that nose is actually
  // travelling in, which is what the chase camera falls back to when there is no speed to read a bearing off.
  const renderOut = {
    pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), vel: new THREE.Vector3(),
    rideFwd: new THREE.Vector3(0, 0, 1), flip: 0,
  };
  // MainType-17 pads reuse the ordinary boosted cap/thrust path for a bounded window. The editor maps the
  // authored magnitude to seconds at the same 0.5 s/unit hand-off used by the Unity runtime.
  let padBoostTimer = 0;
  /** Whether the held air boost changed acceleration or bent velocity on the last physics tick. Kept honest so
   * the boost roar stops when an at-cap aim points exactly along travel and the cap would discard the thrust. */
  let airBoostActive = false;
  let telemetryFrame = 0;
  let tickTrace: {
    opening: RideTelemetryState;
    probe?: RideTelemetryProbe;
    redirect?: RideTelemetryRedirect;
    acceleration?: RideTelemetryVec3;
    events: RideTelemetryEvent[];
  } | null = null;

  const spawn = new THREE.Vector3();
  const spawnFwd = new THREE.Vector3(0, 0, 1);
  /** The run's own start gate, which no warp ever moves. `spawn` is only *where the next respawn lands*, and a
   *  course reset rewrites it ([Trailmap: 395] — the engine's warp state writes the boarder record); this is the
   *  one place left to send a rider whose carry-back target has itself become the thing resetting them. */
  const runStart = new THREE.Vector3();
  const runStartFwd = new THREE.Vector3(0, 0, 1);

  // ---- lifecycle ----

  /** Derive a sphere body's world state from `matrix`. Shared by the launch bake and the per-frame refit, so a
   *  moved body's broad-phase bound and normal basis can never drift from the transform they describe. */
  function placeSphereBody(body: ObstacleSphereBody, matrix: THREE.Matrix4) {
    body.matrixWorld.copy(matrix);
    body.toLocal.copy(matrix).invert();
    body.normalMatrix.getNormalMatrix(matrix);
    const e = matrix.elements;
    const scales = [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])];
    const maxScale = Math.max(...scales), minScale = Math.min(...scales);
    body.bound.center.copy(body.localCenter).applyMatrix4(matrix);
    body.bound.radius = body.localRadius * maxScale;
    body.localBodyRadius = minScale > 1e-9 ? RIDER_BODY_R / minScale : RIDER_BODY_R;
  }

  /** Derive an oriented box's world state from `matrix`, the counterpart to `placeSphereBody`. */
  function placeBox(box: ObstacleBox, matrix: THREE.Matrix4) {
    box.matrixWorld.copy(matrix);
    box.toLocal.copy(matrix).invert();
    box.normalMatrix.getNormalMatrix(matrix);
    box.linear.setFromMatrix4(matrix);
    const e = matrix.elements;
    const scales = [Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])];
    const maxScale = Math.max(...scales), minScale = Math.min(...scales);
    box.localRadius = minScale > 1e-9 ? RIDER_BODY_R / minScale : RIDER_BODY_R;
    // A world sphere around the whole oriented box, for the cheap distance reject.
    boxWorldBounds.makeEmpty();
    for (let corner = 0; corner < 8; corner++) {
      boxCorner.set(
        (corner & 1) ? box.localMax.x : box.localMin.x,
        (corner & 2) ? box.localMax.y : box.localMin.y,
        (corner & 4) ? box.localMax.z : box.localMin.z,
      );
      boxWorldBounds.expandByPoint(boxCorner);
    }
    boxWorldBounds.getBoundingSphere(box.bound);
    box.bound.center.applyMatrix4(matrix);
    box.bound.radius = box.bound.radius * maxScale + RIDER_BODY_R;
  }

  function buildObstacleBVH() {
    obstacleBVH = null; obstaclePos = null; obstacleFaceMeta = []; obstacleMetas = []; obstacleSphereBodies = [];
    obstacleBoxes = []; liveObstacleMeshes = [];
    const positions: number[] = [];
    const vertex = new THREE.Vector3();
    for (const source of o.obstacles ?? []) {
      // A source can be captured before its model finishes moving, then handed to another rider later (the AI
      // field and the player share one captured set). Bake a live source from its CURRENT provider pose, not
      // from the capture-time snapshot. The matching version is sampled after the matrix so the first refit
      // cannot accept a new stamp over geometry baked at the old pose.
      const sourceMatrix = source.liveMatrix ? source.liveMatrix().clone() : source.matrixWorld;
      const appliedVersion = source.liveMatrix ? source.poseVersion?.() : undefined;
      const playerBounce = source.playerBounce ?? source.bounce > 0;
      const meta: ObstacleMeta = {
        key: source.key, object: source.object, enabled: true, solid: source.solid,
        bounce: playerBounce ? clamp(Number.isFinite(source.bounce) ? source.bounce : 0, 0, 1) : 0,
        playerBounce,
        surface: Number.isFinite(source.surface) ? Math.trunc(source.surface) : -1,
        dynamicMass: Number.isFinite(source.dynamicMass) && source.dynamicMass! > 0 ? source.dynamicMass! : 0,
        body: worldMassProps(source, sourceMatrix),
      };
      let metaIndex = -1;
      if (source.nativeBox && source.geometry) {
        // The donor geometry is the shared unit box the scene poses per placement; the collision shape is its
        // world bounds, exactly the min/max the instance record stores natively.
        if (!source.geometry.boundingBox) source.geometry.computeBoundingBox();
        const local = source.geometry.boundingBox;
        if (local && !local.isEmpty()) {
          obstacleMetas.push(meta);
          const box: ObstacleBox = {
            meta, localMin: local.min.clone(), localMax: local.max.clone(),
            matrixWorld: new THREE.Matrix4(), toLocal: new THREE.Matrix4(),
            normalMatrix: new THREE.Matrix3(), linear: new THREE.Matrix3(),
            localRadius: RIDER_BODY_R, bound: new THREE.Sphere(),
            ...(source.liveMatrix ? { liveMatrix: source.liveMatrix, poseVersion: source.poseVersion,
              appliedVersion } : {}),
          };
          placeBox(box, sourceMatrix);
          obstacleBoxes.push(box);
        }
        continue;
      }
      if (source.geometry) {
        const attr = source.geometry.getAttribute('position');
        const index = source.geometry.getIndex();
        const triangles = attr ? Math.floor((index?.count ?? attr.count) / 3) : 0;
        if (attr && triangles) {
          metaIndex = obstacleMetas.length;
          obstacleMetas.push(meta);
          const start = positions.length / 3;
          // A moving source keeps its own de-indexed local copy: the refit re-transforms that instead of
          // re-walking the donor geometry's index every frame.
          const local = source.liveMatrix ? new Float32Array(triangles * 9) : null;
          for (let face = 0; face < triangles; face++) {
            for (let corner = 0; corner < 3; corner++) {
              const offset = face * 3 + corner;
              const vi = index ? index.getX(offset) : offset;
              vertex.fromBufferAttribute(attr, vi);
              if (local) local.set([vertex.x, vertex.y, vertex.z], offset * 3);
              vertex.applyMatrix4(sourceMatrix);
              positions.push(vertex.x, vertex.y, vertex.z);
            }
            obstacleFaceMeta.push(metaIndex);
          }
          if (local && source.liveMatrix) liveObstacleMeshes.push({
            liveMatrix: source.liveMatrix, local, start, applied: sourceMatrix.clone(), nodes: null,
            poseVersion: source.poseVersion, appliedVersion });
        }
      }
      if (source.spheres && source.spheres.length >= 4) {
        if (metaIndex < 0) obstacleMetas.push(meta);
        const localBox = new THREE.Box3();
        for (let i = 0; i + 3 < source.spheres.length; i += 4) {
          const x = source.spheres[i], y = source.spheres[i + 1], z = source.spheres[i + 2];
          const r = Math.max(0, source.spheres[i + 3]);
          localBox.expandByPoint(new THREE.Vector3(x - r, y - r, z - r));
          localBox.expandByPoint(new THREE.Vector3(x + r, y + r, z + r));
        }
        const localCenter = localBox.getCenter(new THREE.Vector3());
        let localRadius = 0;
        for (let i = 0; i + 3 < source.spheres.length; i += 4)
          localRadius = Math.max(localRadius, localCenter.distanceTo(vertex.fromArray(source.spheres, i))
            + Math.max(0, source.spheres[i + 3]));
        const body: ObstacleSphereBody = {
          meta, spheres: source.spheres, matrixWorld: new THREE.Matrix4(), toLocal: new THREE.Matrix4(),
          normalMatrix: new THREE.Matrix3(), bound: new THREE.Sphere(), localCenter, localRadius,
          localBodyRadius: RIDER_BODY_R, reachedByBody: true,
          ...(source.liveMatrix ? { liveMatrix: source.liveMatrix, poseVersion: source.poseVersion,
            appliedVersion } : {}),
        };
        placeSphereBody(body, sourceMatrix);
        obstacleSphereBodies.push(body);
      }
    }
    if (!obstacleFaceMeta.length) return;
    const geometry = new THREE.BufferGeometry();
    obstaclePos = new THREE.Float32BufferAttribute(positions, 3);
    geometry.setAttribute('position', obstaclePos);
    obstacleBVH = new MeshBVH(geometry, { indirect: true });
    assignLiveRefitNodes();
    perf.rideTris += obstacleFaceMeta.length;
  }

  /**
   * Map each moving source's triangle run to the BVH nodes whose bounds cover it: the leaves the build's
   * indirect sort scattered its triangles into, plus every ancestor down the path from the root. Refit then
   * descends only those paths. Without this, `refit()` re-derives every leaf bound from the whole level's
   * triangles — measured ~22 ms a frame at a reference mountain's 177k obstacle triangles, paid every frame,
   * because its lift/gondola props are effect-animated and never stop rewriting their matrices.
   */
  function assignLiveRefitNodes() {
    const bvh = obstacleBVH;
    if (!bvh || !liveObstacleMeshes.length) return;
    // Triangle → owning live-source ordinal (−1 static); leaf runs resolve through the indirect buffer into this.
    const liveOfTri = new Int32Array(obstacleFaceMeta.length).fill(-1);
    liveObstacleMeshes.forEach((live, at) =>
      liveOfTri.fill(at, live.start / 3, live.start / 3 + live.local.length / 9));
    const path: number[] = [0]; // node ids down the current DFS branch; the root is always node 0
    bvh.shapecast({
      intersectsBounds: (_box, _isLeaf, _score, depth, nodeIndex) => {
        path[depth] = nodeIndex;
        return INTERSECTED; // a one-time walk of the whole tree at bake, not a spatial query
      },
      intersectsRange: (offset, count, _contained, depth, nodeIndex) => {
        path[depth] = nodeIndex;
        for (let at = offset; at < offset + count; at++) {
          const live = liveOfTri[bvh.resolveTriangleIndex(at)];
          if (live < 0) continue;
          const nodes = (liveObstacleMeshes[live].nodes ??= new Set());
          for (let d = 0; d <= depth; d++) nodes.add(path[d]);
        }
        return false; // never early-out: every leaf must be classified
      },
    });
  }

  /**
   * Carry the moving props' colliders with them inside the launch bake. A deploying ramp, a retracting pillar or
   * a thrown break piece rewrites only its own vertices and then refits the tree — refit widens the baked bounds
   * in place rather than re-sorting, so the level's one BVH survives the whole run for a fraction of a rebuild.
   * Only the movers' own subtrees (`nodes`) are re-derived: a whole-tree refit re-reads every leaf's triangles,
   * and costs a reference level ~22 ms a frame while a single gondola swings. Sources without a `liveMatrix`,
   * which is nearly all of them, are never touched.
   *
   * Called once per rendered FRAME rather than per tick: the clip players advance in the same frame loop, one
   * step ahead of the ride, so a second read inside the tick loop would return the identical pose.
   */
  function refitObstacles() {
    let moved = false;
    let refitAll = false;
    refitNodes.clear();
    for (const live of liveObstacleMeshes) {
      // The stamp gate: a provider that vouches for its pose is only recomposed after a bump says it may have
      // moved — the poll below otherwise recomposes thousands of unchanged matrix chains to discover nothing.
      if (live.poseVersion) {
        const version = live.poseVersion();
        if (version === live.appliedVersion) continue;
        live.appliedVersion = version;
      }
      const now = live.liveMatrix();
      if (now.equals(live.applied) || !obstaclePos) continue;
      live.applied.copy(now);
      const target = obstaclePos.array as Float32Array;
      const local = live.local;
      for (let v = 0; v < local.length; v += 3) {
        liveVertex.set(local[v], local[v + 1], local[v + 2]).applyMatrix4(now);
        const out = live.start * 3 + v;
        target[out] = liveVertex.x; target[out + 1] = liveVertex.y; target[out + 2] = liveVertex.z;
      }
      moved = true;
      // Union the movers' subtree nodes; a run that somehow owns none falls back to the full-tree walk.
      if (live.nodes) { for (const node of live.nodes) refitNodes.add(node); } else refitAll = true;
    }
    if (moved && obstaclePos && obstacleBVH) {
      obstaclePos.needsUpdate = true;
      obstacleBVH.refit(refitAll ? undefined : refitNodes);
    }
    for (const body of obstacleSphereBodies) {
      if (!body.liveMatrix) continue;
      if (body.poseVersion) {
        const version = body.poseVersion();
        if (version === body.appliedVersion) continue;
        body.appliedVersion = version;
      }
      const now = body.liveMatrix();
      if (!now.equals(body.matrixWorld)) placeSphereBody(body, now);
    }
    for (const box of obstacleBoxes) {
      if (!box.liveMatrix) continue;
      if (box.poseVersion) {
        const version = box.poseVersion();
        if (version === box.appliedVersion) continue;
        box.appliedVersion = version;
      }
      placeBox(box, box.liveMatrix());
    }
  }

  function start() {
    const geo = o.terrain.geometry as TreeGeometry;
    perf.rideTris = (geo.index ? geo.index.count : (geo.getAttribute('position')?.count ?? 0)) / 3;
    // The contact tree, shared with the effect bodies' floor probe and cached on the geometry itself
    // (viewport/mesh/surface-trees.ts). It indexes the terrain's own buffers, so it follows an edit rather
    // than outliving one, and `indirect` keeps the shared index untouched — `faceIndex` still maps
    // face → cell / patch for the surface lookup below.
    const tree = rideTree(geo);
    if (!tree) throw new Error('the ride has nothing to ride: the terrain mesh carries no positions');
    bvh = tree;
    o.terrain.updateWorldMatrix(true, false);
    toWorld.copy(o.terrain.matrixWorld);
    toLocal.copy(toWorld).invert();
    normalMat.getNormalMatrix(toWorld); // inverse-transpose: correct through the chirality mirror
    // The analytic contact reads the hit triangle straight out of the shared buffers (`indirect` left the index
    // untouched, so `faceIndex` still indexes it).
    geoPos = geo.getAttribute('position');
    geoIndex = geo.getIndex()?.array ?? null;
    buildObstacleBVH();

    spawn.copy(o.spawn);
    st.pos.copy(spawn);
    const g0 = probe(spawn, WORLD_UP);
    let h = o.heading ? o.heading.clone() : null;
    if ((!h || h.lengthSq() < 1e-6) && g0.found) h = new THREE.Vector3(g0.n.x, 0, g0.n.z); // downhill ∝ (n.x, n.z)
    if (!h || h.lengthSq() < 1e-6) h = new THREE.Vector3(0, 0, 1);
    h.y = 0;
    if (h.lengthSq() < 1e-6) h.set(0, 0, 1);
    h.normalize();
    spawnFwd.copy(h);
    runStart.copy(spawn); runStartFwd.copy(spawnFwd);
    respawn();
  }

  function respawn() {
    mountSupportKey = null;
    st.pos.copy(spawn);
    const g = probe(st.pos, WORLD_UP);
    if (g.found) st.pos.copy(g.point).addScaledVector(g.n, 1.0); // drop in from a metre up; the model lands it
    st.vel.set(0, 0, 0);
    // A teleport is not an acceleration: drop whatever this frame's earlier ticks banked, so the arms are handed
    // a clean zero rather than the velocity the rider died with.
    st.accel.set(0, 0, 0); dv.set(0, 0, 0); dvTicks = 0;
    st.fwd.copy(spawnFwd);
    st.lead = 1; // a fresh drop always stands regular; the ride is what puts a rider switch, not the flag
    st.boardUp.set(0, 1, 0); st.contactN.copy(g.found ? g.n : WORLD_UP); st.airUp.set(0, 1, 0);
    st.lean = 0; st.bank = 0; st.flip = 0; st.carveSlide = 0; st.slip = 0; st.speedCap = MAX_SPEED;
    st.airTime = 0; st.predictedAirTime = 0; st.landEta = Infinity; st.forcedAir = false; accum = 0;
    st.railIdx = -1; st.railTime = 0; st.railYaw = 0; railCooldown = 0;
    st.grounded = false; st.error = 1.0; st.groundKey = null;
    // Seat the contact fields on the spawn surface rather than slewing them up from zero: a zero budget makes
    // the pushout fire on the very first contact tick and shove the deck straight back out.
    st.surf = g.found ? g.surf : 1;
    const s = surfaceFor(st.surf);
    st.sinkBudget = s.budget; st.sinkBog = s.bog; st.lift = 0;
    st.charging = false; st.charge = 0; releaseQueued = false; st.jumpGrace = 0; st.ollieCooldown = 0;
    st.crouch = 0; st.popTime = 0; st.popDrive = 0;
    padBoostTimer = 0;
    boostFrom.copy(st.pos); // a teleport is not travel: never sweep the line between where it was and here
    crackFrom.copy(st.pos); // and it must not crack every pane on the line either
    wedge = 0; // the warp is the answer to being wedged; carrying the count over would re-fire immediately
    crumbFilled = 0; crumbWrite = 0; // and a teleport orphans the trail: it leads back to where the rider ISN'T
    obstacleHitNext.clear();
    st.riderSeated = false; // the rider is re-seated on the next pose, never dragged there
    snapRender();
    o.onRespawn();
  }

  /** Apply the shared exact rest-depth seat after a caller has selected an eligible contact. */
  function seatOnProbe(g: Probe): true {
    st.surf = g.surf;
    const s = surfaceFor(st.surf);
    const restDepth = groundRestDepth(s, g.n.y);
    st.pos.copy(g.point).addScaledVector(g.n, -restDepth);
    st.vel.set(0, 0, 0); st.accel.set(0, 0, 0);
    st.contactN.copy(g.n); st.boardUp.copy(g.n); st.airUp.set(0, 1, 0);
    st.grounded = true; st.error = -restDepth; st.sinkBudget = s.budget; st.sinkBog = s.bog; st.lift = s.lift;
    st.groundKey = g.key ?? null;
    st.airTime = 0; st.predictedAirTime = 0; st.landEta = Infinity; st.forcedAir = false; accum = 0;
    st.riderSeated = false;
    snapRender();
    return true;
  }

  /** Seat a race-gate start directly at the surface's recovered rest depth. Ordinary starts/respawns deliberately
   * drop in from one metre up; a countdown hold cannot use that pose or the rider would hover above the gate for
   * its entire Wait chain. This changes only the current state—the saved respawn point keeps its normal drop-in. */
  function seatAtSpawn(): boolean {
    mountSupportKey = null;
    // `respawn()` has already moved `st.pos` one metre above the hit; probe the saved surface click instead of
    // balancing on that probe's lower endpoint (which is numerically fragile on an inclined facet).
    const g = probe(spawn, WORLD_UP);
    return g.found ? seatOnProbe(g) : false;
  }

  /**
   * Seat a board recalled to a grounded walker. This is the one boundary where an untyped solid prop can be
   * temporary ground: it fixes the walk -> board handoff without changing how a board that lands on that prop
   * is classified. The permissive probe still rejects pass-through and movable bodies and still requires an
   * upward-facing hit directly inside the ordinary contact segment.
   */
  function seatAtMount(): boolean {
    mountSupportKey = null;
    const g = probe(spawn, WORLD_UP, true);
    if (!g.found) return false;
    if (g.key && g.surf < 0) mountSupportKey = g.key;
    return seatOnProbe(g);
  }

  /**
   * THE MID-AIR CATCH (`RideableBoard.ApplyAirRemount`, Unity docs/vrchat/017) — the other half of taking the deck
   * off your feet in the air. A mount is otherwise a FRESH mount: velocity zeroed, contact seeded on the
   * surface below, exactly right for stepping onto a parked board and fatal here, because the rider arrives
   * with an arc of their own and would stop dead in the sky and drop straight down.
   *
   * So put the arc back and tell the model it is AIRBORNE: past the orientation grace, so the deck orients for
   * flight instead of chasing a surface it is nowhere near, and out of the forced-air latch, which has nothing
   * to force this far off the ground. The cap is raised to the arriving speed for the same reason a boost
   * volume's push raises it — a rider who caught the deck out of a Superman flight is travelling faster than
   * the board's own tier, and the tier is a cliff where the air drag is a slope.
   */
  function mountAirborne(velocity: THREE.Vector3, position?: THREE.Vector3) {
    mountSupportKey = null;
    // A flat-screen in-place recall can happen during a walking jump. `warpTo` prepares a clean mount state but
    // may find the nearby ground and seat there; restore the exact airborne handoff point and reset the two
    // world-space sweep origins so neither boost volumes nor cracked surfaces trace the short warp behind it.
    if (position) {
      st.pos.copy(position);
      boostFrom.copy(position);
      crackFrom.copy(position);
    }
    st.vel.copy(velocity);
    st.accel.set(0, 0, 0); dv.set(0, 0, 0); dvTicks = 0;
    st.grounded = false;
    st.forcedAir = false;
    st.error = 1;
    st.airTime = ORIENT_GRACE + 0.01;
    st.landEta = Infinity;
    st.predictedAirTime = predictAirDuration();
    st.airUp.copy(st.boardUp);
    const speed = st.vel.length();
    if (speed > st.speedCap) st.speedCap = speed;
    snapRender();
  }

  // ---- per-frame step ----

  function step(dt: number) {
    perf.stepT0 = performance.now(); perf.castAccum = 0; // perf breakdown for this frame

    rideElapsed += dt;
    refitObstacles(); // the frame's clip/effect poses are already applied; the ticks below ride the current ones
    accum = Math.min(accum + dt, MAX_TICKS * TICK_H); // a hitch runs the ride slow, never teleports it
    dv.set(0, 0, 0); dvTicks = 0;
    while (accum >= TICK_H) {
      accum -= TICK_H;
      prevPos.copy(st.pos); prevFwd.copy(st.fwd); prevVel.copy(st.vel); // the render lerp's trailing edge
      prevFlip = st.flip;
      tick(TICK_H);
    }
    if (dvTicks > 0) st.accel.copy(dv).divideScalar(dvTicks * TICK_H);
  }

  /** The between-ticks view of the rider: position/facing/velocity lerped by the banked-time fraction. The
   *  physics never reads this — it is for the pose and the chase camera, which sample once per rendered frame. */
  function renderState() {
    const a = accum / TICK_H; // < 1: the step loop spent every whole tick
    renderOut.pos.lerpVectors(prevPos, st.pos, a);
    renderOut.vel.lerpVectors(prevVel, st.vel, a);
    renderOut.fwd.lerpVectors(prevFwd, st.fwd, a);
    if (renderOut.fwd.lengthSq() > 1e-9) renderOut.fwd.normalize(); else renderOut.fwd.copy(st.fwd);
    // The lead is discrete: it is stamped on the interpolated facing rather than lerped through zero.
    renderOut.rideFwd.copy(renderOut.fwd).multiplyScalar(st.lead);
    // The flip turns 4.5° a tick, which a display faster than the simulation would otherwise show as steps.
    renderOut.flip = prevFlip + (st.flip - prevFlip) * a;
    return renderOut;
  }

  /** A teleport must not be interpolated across: seat the render lerp exactly on the new state. */
  function snapRender() { prevPos.copy(st.pos); prevFwd.copy(st.fwd); prevVel.copy(st.vel); prevFlip = st.flip; }

  /**
   * One 60 Hz physics tick.
   *
   * Contact is a *state of the deck*, not a decision. The probe writes the signed clearance, and the rider is
   * grounded while that clearance stays under the surface's own `ground_threshold` — 2.7 cm on snow, 15 cm in
   * powder. Nothing here tests a velocity threshold to leave the ground, and nothing tests for a lip: a rider
   * crests a roll when gravity can no longer supply the centripetal acceleration the surface demands, the
   * clearance simply climbs past the threshold, and the next tick is an air tick.
   *
   * That band is also what keeps the response's above-surface pull from welding the board down. `−(A/30)·error`
   * reaches 21 m/s² half a metre up, but the grounded state never extends that far: at the band edge on snow it
   * is 1.2 m/s². An ollie crosses the band in two ticks.
   */
  function tick(h: number) {
    if (!o.onTelemetryTick) { tickCore(h); return; }
    const trace: NonNullable<typeof tickTrace> = { opening: telemetryState(), events: [] };
    tickTrace = trace;
    tickCore(h);
    const closing = telemetryState();
    if (trace.opening.grounded && !closing.grounded) trace.events.push({ type: 'takeoff' });
    else if (!trace.opening.grounded && closing.grounded) trace.events.push({ type: 'touchdown' });
    const record: RideTelemetryTick = {
      kind: 'frame', frame: ++telemetryFrame, dt: h,
      input: {
        steer: steerInput(), left: o.keys.left, right: o.keys.right,
        tuck: o.keys.tuck, brake: o.keys.brake, boost: o.keys.boost,
      },
      opening: trace.opening, probe: trace.probe, redirect: trace.redirect, acceleration: trace.acceleration,
      events: trace.events, closing,
    };
    tickTrace = null; // the observer cannot accidentally attach work to the tick that just closed
    o.onTelemetryTick(record);
  }

  function tickCore(h: number) {
    tickV0.copy(st.vel); // banked into `dv` at the close; a respawn returns before that and is not an acceleration
    airBoostActive = false; // ground and rail ticks never leave the aimed-air-thrust audio gate armed
    st.landEta = Infinity; // only a falling air tick predicts a landing; every other motion state has none ahead
    if (padBoostTimer > 0) padBoostTimer = Math.max(0, padBoostTimer - h);
    wedge *= WEDGE_DECAY; // decays every tick, so only CONSECUTIVE contact frames ever reach the threshold

    /**
     * Rails ([Trailmap: 350]). Acquisition runs from BOTH the air and the ground states through the same
     * candidate query the grind re-runs every tick — and the grind's own integrator then replaces the terrain
     * probe / response / redirect wholesale (motion state 3 is a separate update routine, [Trailmap: 300]).
     * The lockout covers a fresh jump's first ticks, when the deck is still inside the positional acceptance
     * windows; `forcedAir` covers the launch tick itself.
     */
    if (railCooldown > 0) railCooldown -= h;
    if (o.rails && st.railIdx < 0 && !st.forcedAir && railCooldown <= 0) tryEnterRail();
    if (st.railIdx >= 0) {
      const accel = new THREE.Vector3();
      if (!railTick(h, accel)) return; // went out of bounds → respawned; a teleport is not an acceleration
      finishTick(h, accel, st.railIdx >= 0); // a lost rail finished as an air tick and caps/integrates as one
      return;
    }

    // Boost volumes run here, ahead of the motion integration below, because that is their order in the engine:
    // the effect nodes update and write the boarder's carried velocity, and the motion step then integrates
    // whatever they left ([Trailmap: 360-node-apply]). They are containment-driven rather than contact-driven —
    // see boost-volumes.ts for why a debounced contact event cannot stand in for a per-tick lift. Presence is
    // the SWEPT segment since the last update, so a thin plate cannot pass between two samples of a fast rider.
    if (boostVolumes) {
      boostVolumes.step(st.pos, st.vel, h, boostFrom);
      boostFrom.copy(st.pos);
    }

    // The crack drain is CONTAINMENT, not ground contact, and that distinction is the whole of whether it
    // works on retail's own panes. A Megaplex pane is response mass 0 — pass-through — so it can never be the
    // rider's ground; what holds the rider up is the invisible SOLID twin beside it, and the pane the crack
    // lives on is only ever overlapped. Charging off `groundKey` therefore drained the twin's key, which
    // carries no crack, and left the pane untouched however long you rode it.
    // Seeded from the CURRENT position the first time through, never from the zero vector a fresh Vector3
    // holds: an unseeded sweep runs from the world origin to the rider and overlaps every cracked surface on
    // the mountain, which broke every pane in Megaplex on the first tick of a run. `step` clamps an
    // implausible span too, so a teleport cannot do the same thing later.
    if (!crackSeeded) { crackFrom.copy(st.pos); crackSeeded = true; }
    stepCrackedSurfaces(crackFrom, st.pos, st.vel, h);
    crackFrom.copy(st.pos);

    // The lap countdown reads the same tick's position. It runs AFTER the volumes so a crossing counted this
    // tick cannot retract a lift the tube began on it — the engine's order too, where the finish is a game
    // event dispatched past the effect update ([Trailmap: 390-lap-counter]).
    if (lapCounter?.step(st.pos)) o.onLap?.(lapCounter.remaining);

    // The carve slide slews every tick from the lean ([Trailmap: 330]): out of the turn, full magnitude at any
    // riding speed, easing home through zero lean. It reads the PREVIOUS tick's lean/frame exactly as the probe
    // below reads the previous normal — the pose and the contact move together, one tick behind the steer.
    const slideGate = Math.min(1, st.vel.length() * CARVE_SLIDE_SPEED_GATE);
    st.carveSlide = moveTowards(st.carveSlide, -CARVE_SLIDE_SCALE * st.lean * slideGate, CARVE_SLIDE_SLEW * h);

    // Grounded, the probe aims along the PREVIOUS tick's contact normal — that is how the engine keeps contact
    // continuous around a curve without filtering. Airborne it aims down: `contactN` is a memory of whatever
    // surface was last touched, and after a steep lip it points sideways, so a segment along it would sweep past
    // the ground the rider is falling toward and never see it.
    const probeAim = st.grounded ? st.contactN : WORLD_UP;
    // The probe base is the deck's DRAWN station, not the rider: position offset by the carve slide along the
    // previous contact frame's lateral ([Trailmap: 320] "the surface is always measured under where the deck is
    // actually drawn"). This is the carve's curvature sensor — the slid sample reads concave terrain as a deeper
    // error and the response builds; grounded only, so a stale frame cannot shift touchdown detection sideways.
    const probeBase = probeTmp.copy(st.pos);
    let probeSlid = false;
    if (st.grounded && Math.abs(st.carveSlide) > 1e-4) {
      // The lateral is the RIDDEN frame's, like the lean that fed the slide — on a switch rider the drawn nose
      // points backwards, and probing off it would slide the sample INTO the turn instead of out of it.
      const latPrev = probeLatTmp.crossVectors(st.contactN, rideForward(st, probeRideTmp));
      if (latPrev.lengthSq() > 1e-6) { probeBase.addScaledVector(latPrev.normalize(), st.carveSlide); probeSlid = true; }
    }
    let probeSource: RideTelemetryProbe['source'] = o.patchContact ? 'analytic-ray' : 'faceted-ray';
    let p = probe(probeBase, probeAim);
    if (p.found) recoverTicks = 0;
    // Seam recovery: the ray missed while riding a steep face — a chord gap on a tight curve, exactly where wall
    // rides live, and where the down-reversion a miss causes cannot see the wall beside the deck. Ask the BVH
    // for the closest surface point instead and read contact THERE. (The Unity board marches the patch (u,v)
    // for the same recovery, Unity docs/021 — PhysX has no closest-point query; MeshBVH does.)
    else if (st.grounded && st.contactN.y < RECOVER_NY && recoverTicks < RECOVER_TICKS_MAX) {
      const r = closestContact(probeBase);
      if (r) { p = r; recoverTicks++; probeSource = 'recovery'; }
    }
    if (!p.found) probeSource = 'none';
    // Signed clearance of the deck reference along the contact normal. Out of the probe's reach = airborne.
    let error = p.found ? probeBase.clone().sub(p.point).dot(p.n) : PROBE_BELOW + 1;
    // The slide is a RESPONSE sensor, not a contact gate — it must never itself end contact. On a wall the
    // lateral lies in the face plane, so the slid sample walks up to half a metre across it: a convex shoulder
    // reads past the ground band (2.78 cm on ice) and a faceted lip misses outright, peeling a carving wall
    // ride into the air that retail's continuous patches would hold. If the slid read would end grounded
    // contact, re-read at the unoffset deck and ride THAT tick on it; every tick the slid read keeps contact
    // is untouched, so the concave response build stands.
    if (probeSlid && (!p.found || error > surfaceFor(p.found ? p.surf : st.surf).thresh)) {
      let fallback = probe(st.pos, probeAim);
      if (!fallback.found && st.contactN.y < RECOVER_NY && recoverTicks < RECOVER_TICKS_MAX) {
        const recovered = closestContact(st.pos);
        if (recovered) { fallback = recovered; recoverTicks++; probeSource = 'recovery'; }
      }
      if (fallback.found) {
        p = fallback;
        if (probeSource === 'none') probeSource = o.patchContact ? 'analytic-ray' : 'faceted-ray';
        error = st.pos.clone().sub(p.point).dot(p.n);
      }
    }
    // The exceptional prop is readable only for this continuous mount contact. Once another surface wins the
    // probe (or the probe misses at the edge), restore its normal obstacle-only meaning before the barrier sweep.
    if (mountSupportKey && p.key !== mountSupportKey) mountSupportKey = null;
    st.error = error;

    if (p.found) st.surf = p.surf;
    const s = surfaceFor(st.surf);

    /**
     * The grounded redirect — the tail of the engine's ground update, and the term that keeps the stiff contact
     * quiet. After integrating, the engine re-probes at the new position (this tick's probe above IS that
     * re-probe), removes 40% of the velocity's normal component along the fresh normal — both signs, every
     * grounded tick, no gate — and then scales the whole velocity back to its previous magnitude. No speed is
     * lost: it is a *rotation* of the velocity toward the contact plane, not damping, which is also why a
     * landing converts impact into carried speed instead of bleeding it.
     *
     * Without it, snow's 5 mm bog is an unstable spring under explicit Euler (`|λ| = 1.28` per tick) and the
     * deck buzzes on perfectly smooth ground; with it the normal channel contracts at riding speed. Standing
     * dead still it does nothing — the rescale exactly undoes the kill when velocity is all normal — and the
     * two powders are exempt entirely: their 15–25 cm bogs are stable springs on their own, and the mush is
     * the point. Runs before the ground ⇄ air state write, exactly where the engine has it, but only while this
     * tick's probe still ACCEPTS grounded contact. The old port gated on the previous state alone: a probe beyond
     * the ground band could return the next patch's sharply different normal and rotate an otherwise good lip
     * velocity downward on the very tick that rejected that patch. The retail traces carry takeoff velocity; a
     * rejected contact is not the tail of a ground update. The ollie tick also skips it because the pop has
     * already joined the velocity by the time this tick opens.
     */
    const normalSpeed = p.found ? st.vel.dot(p.n) : 0;
    // Types 6/10 are the non-riding bounce/wall rows. Their deliberately broad 20 cm contact band must not hold a
    // rider that is already moving OUT of the face: at Snowdream's early lips that accepts the far-side wall for
    // one tick, and redirect rotates 17–20 m/s of separation down it before ordinary ground exit can run.
    const leavingUnrideable = st.grounded && (p.surf === 6 || p.surf === 10)
      && normalSpeed > CONTACT_SEPARATION_SPEED;
    const redirectContact = p.found && error <= s.thresh && !leavingUnrideable;
    if (st.grounded && redirectContact && !st.forcedAir && st.surf !== 3 && st.surf !== 4) {
      const rn = p.found ? p.n : st.contactN;
      const vn = st.vel.dot(rn);
      const spd0 = st.vel.length();
      const velocityBefore = tickTrace ? telemetryVec(st.vel) : null;
      // Measured BEFORE the removal, which only rescales this component — the question is whether the deck had
      // any travel to rotate into on the way in, not what the redirect leaves behind.
      const tangentSpeed = Math.sqrt(Math.max(0, spd0 * spd0 - vn * vn));
      st.vel.addScaledVector(rn, -GROUND_REDIRECT * vn);
      const spd1 = st.vel.length();
      // No travel to rotate into: contract the normal channel (the spring's stabilizer, the half of this term
      // that keeps a stiff bog quiet) but skip the speed conversion, which would only amplify noise.
      if (spd1 > 1e-8 && tangentSpeed > REDIRECT_TANGENT_FLOOR) st.vel.multiplyScalar(spd0 / spd1);
      if (tickTrace) tickTrace.redirect = {
        normal: telemetryVec(rn), normalVelocity: vn, speed: spd0,
        velocityBefore: velocityBefore!, velocityAfter: telemetryVec(st.vel),
      };
    }

    /**
     * Ground ⇄ air, with the hysteresis the engine's two state machines give it for free: the grounded state
     * ends when the clearance passes `ground_threshold`, and it resumes on contact (`error ≤ 0`), not on
     * re-entering the band. The ollie forces the air state outright ([Trailmap: 300]: the launch fires with no
     * contact check at all), so the pop is never spent against the response the deck has not yet climbed out of.
     */
    if (st.forcedAir && error > s.thresh) st.forcedAir = false;
    // Air contact has an approach gate independent of grounded liftoff: a penetrating far-side probe while the
    // velocity is strongly SEPARATING is not a touchdown. The gold run admits near-zero numerical separation,
    // hence the small tolerance rather than a brittle sign test.
    const approachingContact = st.grounded || normalSpeed <= CONTACT_SEPARATION_SPEED;
    const onGround = p.found && !st.forcedAir && approachingContact && !leavingUnrideable
      && (st.grounded ? error <= s.thresh : error <= 0);
    if (tickTrace) tickTrace.probe = {
      source: probeSource, found: p.found, aim: telemetryVec(probeAim), point: telemetryVec(p.point),
      normal: telemetryVec(p.n), surfaceType: p.surf, error, groundThreshold: s.thresh,
      normalSpeed, acceptedGround: onGround,
    };

    // Out of bounds: standing on a Reset (Surf_0) surface, fell below the floor, or wedged on the level. During
    // a scored run these take the shared carry-back. Free riding deliberately leaves the rider where physics
    // puts them until the manual reset button is used.
    if (((onGround && p.surf === 0) || st.pos.y < o.oobFloorY || wedge > WEDGE_FIRE)
      && automaticResetToCourse()) return;

    // The trail the carry-back falls back on. Only frames that were genuinely ON the mountain qualify: Surf_0 is
    // the out-of-bounds skirt itself, and a prop contact (`p.key`) is a body that may be gone by the reset.
    if (onGround && p.surf > 0 && !p.key) recordCrumb();

    // The contact fields ease in on EVERY motion state ([Trailmap: 310] slews in the shared update), so a fall
    // toward powder has its ~30 cm budget already easing in by the time the deck arrives. Only the visual lift
    // is ground-gated. Off the probe's reach there is no surface to read, so the last row stands.
    const slew = CONTACT_SLEW * h;
    st.sinkBudget = moveTowards(st.sinkBudget, s.budget, slew);
    st.sinkBog = moveTowards(st.sinkBog, s.bog, slew);
    st.lift = moveTowards(st.lift, onGround ? s.lift : 0, slew);

    // Jump coyote grace: "grounded for an ollie" = on the ground OR within the grace window of leaving it, so a
    // pop released during a bump-skip still fires; past it a pending charge is cancelled (no mid-air double-jump).
    if (onGround) st.jumpGrace = JUMP_COYOTE_TIME;
    else if (st.jumpGrace > 0) st.jumpGrace -= h;
    if (!onGround && st.jumpGrace <= 0) { st.charging = false; releaseQueued = false; st.charge = 0; }

    // Which body the deck is seated on, for the barrier sweep's roof clause later this same tick.
    st.groundKey = onGround ? (p.key ?? null) : null;

    const accel = new THREE.Vector3();
    if (onGround) {
      // Analytic terrain writes the exact fresh normal into the cached contact frame every tick ([Trailmap: 320]);
      // smoothing is solely a compensation for callers that can provide only a faceted collision mesh.
      if (!st.grounded || o.patchContact) st.contactN.copy(p.n);
      else st.contactN.lerp(p.n, h / (NORMAL_SMOOTHING + h)).normalize();

      // The clean air→ground transition seeds its contact error at the surface. The original Snowdream gold trace
      // repeatedly enters ground with error = 0 while carrying 15–20 m/s of into-surface velocity at unchanged
      // total speed; only the FOLLOWING grounded ticks build penetration and let redirect/pushout absorb it. Feeding
      // this tick's already-penetrating discovery straight into pushout projects the impact immediately and turns a
      // several-tick landing into one harsh speed loss.
      const responseError = st.grounded ? error : 0;
      if (!st.grounded) { touchdown(p); st.error = 0; }
      groundTick(h, s, responseError, accel);
      st.airTime = 0;
      st.predictedAirTime = 0;
    } else {
      if (st.grounded) st.predictedAirTime = predictAirDuration();
      airTick(h, accel);
    }
    st.grounded = onGround;
    finishTick(h, accel, onGround);
  }

  /**
   * The tick's shared tail, run by every motion state ([Trailmap: 300]: the shared per-tick update runs for
   * every state and maintains the cross-state fields): the charged ollie, the decaying speed cap, and the
   * explicit-Euler integration. `onGround` covers the rail too — a grind caps and poses as grounded travel.
   */
  function finishTick(h: number, accel: THREE.Vector3, onGround: boolean) {
    if (tickTrace) tickTrace.acceleration = telemetryVec(accel);
    // Back on something — snow or a rail — the deck rocks onto the NEAREST whole rotation, which draws as level.
    // Easing toward the nearest rather than folding to zero is what keeps the value continuous for the render
    // lerp: a fold would sweep the drawn deck the long way round on the one frame it happened.
    if (onGround && st.flip !== 0) {
      st.flip = moveTowards(st.flip, Math.round(st.flip / 360) * 360, FLIP_RECOVER_RATE * h);
    }
    // Charged ollie: build while held, launch on the queued release — decoupled from the live ground/air state
    // so a coyote-frame release still pops.
    if (st.ollieCooldown > 0) st.ollieCooldown -= h;
    if (st.charging) st.charge = Math.min(1, st.charge + CHARGE_RATE * h);
    if (releaseQueued) {
      if (st.ollieCooldown <= 0) launchOllie();
      releaseQueued = false; // consume the release even while cooling
      st.charge = 0;
    }

    // Speed cap ([Trailmap: 360]): a shared cap that only ever bounds speed from above. Boost selects the top tier
    // and the airborne integrator re-arms at that same top tier, so a jump never bleeds carried speed. It snaps up
    // and eases DOWN, so an expiring boost bleeds off smoothly instead of clipping.
    const capTarget = (boostActive() || !onGround) ? BOOST_MAX_SPEED : MAX_SPEED;
    if (capTarget >= st.speedCap) st.speedCap = capTarget;
    else st.speedCap = moveTowards(st.speedCap, capTarget, BOOST_CAP_DECAY * h);
    const spd = st.vel.length();
    if (spd > st.speedCap) st.vel.multiplyScalar(st.speedCap / spd);

    /**
     * The integration follows [Trailmap: 320-spring-accel]: **position first, with the tick's opening velocity,
     * then velocity, with an acceleration frozen at the tick's opening state**. That is
     * plain explicit Euler, and it survives snow's 5 mm bog — a spring this step cannot integrate stably on its
     * own (`A/(100·bog) = 2602 s⁻²` against `P = 5.01` is `|λ| = 1.28` per tick) — because the grounded redirect
     * at the top of the next tick rotates the ringing back into the contact plane. The spring, the step and the
     * redirect are one mechanism split across the tick; port any one of them alone and the contact is a
     * different game (the spring without the redirect buzzes; a semi-implicit step without either is quiet but
     * mushier than the original).
     */
    const previousPos = integrationPrevious.copy(st.pos);
    st.pos.addScaledVector(st.vel, h);
    // Terrain needs the airborne barrier sweep only (upward faces belong to its ground probe). Props need it in
    // every motion state, but most ticks on a two-million-triangle reference are nowhere near one: one bounded
    // closest-point broad phase avoids constructing/raycasting all 13 body segments on those empty-space ticks.
    const includeTerrainBarrier = st.forcedAir || !onGround;
    const includeObstacleBarrier = obstacleNearSweptBody(previousPos, previousPos.distanceTo(st.pos));
    if (includeObstacleBarrier || includeTerrainBarrier)
      resolveBarrierHit(previousPos, st.pos, includeTerrainBarrier, includeObstacleBarrier);
    st.vel.addScaledVector(accel, h);

    dv.add(st.vel).sub(tickV0); // everything the tick did to the velocity, impulses and all
    dvTicks++;
  }

  /**
   * Air → ground ([Trailmap: 340] Touchdown). A clean landing enters the grounded state directly — the full
   * contact-plane velocity projection belongs to the *wipeout* state, not to an ordinary landing, so it is not
   * here. The arriving normal speed is taken out by the pushout's `vel -= vn·n` the moment the deck passes its
   * budget, and the plunge that follows is the response's own transient.
   *
   * What does apply are the two orientation error bands: square landings keep their speed. They need no "is
   * this a real landing" gate — after a bump-skip both error angles are ≈ 0 and the deck arrives square, so
   * they multiply by 1 and cost nothing. A cartwheel pays.
   *
   * The landing is also where the **lead** is committed (docs/016). The deck is an axis, so the arriving rider
   * takes whichever of its two ends is already leading the travel and the yaw band is measured to THAT end: a
   * clean 180 lands switch at ≈ 0° and keeps every metre per second it came in with, where scoring the nose alone
   * called it 180° off and took the full 0.75 for a trick the rider actually landed. Sideways is still sideways —
   * the nearer end of a 90° slap is still 90° off and pays in full, which is the band doing its job.
   */
  function touchdown(p: Probe) {
    const band = (err: number, free: number, hard: number, floor: number) =>
      1 - (1 - floor) * clamp01((err - free) / (hard - free));
    const deckTilt = Math.acos(clamp(st.boardUp.dot(p.n), -1, 1)) / D2R; // deck up vs the contact normal
    // An unfinished flip arrives as deck tilt, because that is what it is — the rider is that many degrees off
    // their own base. The WORSE of the two is taken rather than the sum: one rider cannot be 40° off the surface
    // and 90° through a rotation and pay for both, and a completed flip reads zero here and costs nothing at all.
    const tilt = Math.max(deckTilt, Math.abs(flipResidual(st.flip)));
    const travel = projectOnPlane(st.vel, p.n, new THREE.Vector3());
    const travelSpeed = travel.length();
    let yaw = 0;
    if (travelSpeed > 1e-2) {
      travel.divideScalar(travelSpeed);
      const face = projectOnPlane(st.fwd, p.n, new THREE.Vector3());
      if (face.lengthSq() > 1e-6) {
        const along = face.normalize().dot(travel);
        // Below the latch speed there is no readable travel to commit to, so the lead carries and the band is
        // measured against the end the rider already had.
        if (travelSpeed > SWITCH_LATCH_SPEED) setLead(along >= 0 ? 1 : -1);
        yaw = Math.acos(clamp(along * st.lead, -1, 1)) / D2R;
      }
    }
    st.vel.multiplyScalar(band(tilt, LAND_TILT_FREE, LAND_TILT_MAX, LAND_TILT_SCALE)
                        * band(yaw, LAND_YAW_FREE, LAND_YAW_MAX, LAND_YAW_SCALE));
  }

  /**
   * Hand the lead to an end of the deck (docs/016). `lean`, `bank` and `carveSlide` are all signed in the RIDDEN
   * frame, so they turn over with it: the rider keeps the same edge on the same side of the *world*, and both the
   * drawn roll (`bank · lead`) and the probe's lateral offset stay continuous across the handover. Flipping the
   * lead alone would snap the deck to its own mirror pose — 90° of visible roll in one frame, mid-skid.
   */
  function setLead(lead: 1 | -1) {
    if (lead === st.lead) return;
    st.lead = lead;
    st.lean = -st.lean;
    st.bank = -st.bank;
    st.carveSlide = -st.carveSlide;
  }

  /** Fills `accel` with the tick's grounded acceleration and applies the pushout. `tick` integrates. */
  function groundTick(dt: number, s: SurfaceRow, error: number, accel: THREE.Vector3) {
    const n = st.contactN;
    const surf = st.surf;
    // The tick's opening RIDDEN direction: the nose while regular, the tail while switch. Everything below that
    // means "forwards" is this vector, never `st.fwd` — see `rideForward`.
    const ride = rideForward(st, new THREE.Vector3());
    const vn = st.vel.dot(n); // the tick's opening normal speed; the response and the pushout both read it

    /**
     * The contact response, plus the active row's A/100 grounded load straight down. The Gari keyboard trace
     * resolves the former 4.73 m/s² inference: neutral ice settles at the row's 13.5093 m/s² response, while a
     * full carve drives it higher as the contact follows the curved path. Nothing clamps the into-surface
     * component on an ordinary tick, and that is the
     * load-bearing line in this file: that pull is the only force holding the deck against convex ground.
     * Remove it and outward normal speed accumulates every tick on any convex surface with nothing to take it
     * away, until the deck floats off perfectly smooth terrain. (A faceted collision mesh hides this — its
     * noise keeps resetting the accumulation.) The crest of a roll then falls out as `R = v²/(g·n̂)`, with no
     * code testing for it.
     */
    /**
     * And the response rides a BANKED contact frame, not the plain normal ([Trailmap: 310] carve tilt;
     * [Trailmap: 320]): `θ = tilt°·lean`, and the scalar — clamped at `2A` — is applied along
     * `n·cosθ + side·sinθ` after a `/cosθ`, so the normal component stays the response and the lateral
     * component is `response·tanθ`. Leaning tilts the whole normal force into the turn, and THAT is the carve
     * force — `response·tanθ` of lateral drive, ≈17.1 m/s² at flat-ground equilibrium on snow, 11.6 on ice,
     * 3.4 on rock.
     * It is entirely independent of `drag`: ice turns with real authority and *drifts* doing it, because its
     * 0.0025 carve drag never damps the lateral slip the tilt builds. Drop the tilt term and ice degrades to a
     * straight-line slide under a freely spinning heading — a drag-only carve model has nothing else to bend
     * the velocity with.
     */
    const response = Math.min(contactResponse(s.A, s.P, error, vn, st.sinkBog, st.sinkBudget), 2 * s.A / 100);
    const assist = o.lowGripAssist === false ? 0 : iceAssistFor(s.drag);
    const theta = iceCarveTilt(s.tilt, assist) * D2R * st.lean;
    const lat = new THREE.Vector3().crossVectors(n, ride);
    accel.copy(n).multiplyScalar(response);
    if (Math.abs(theta) > 1e-4 && lat.lengthSq() > 1e-6) accel.addScaledVector(lat.normalize(), response * Math.tan(theta));
    // The normal and tangential loads are independently constrained. Neutral retail ice sits at the A/100
    // spring response, while Snowdream's matched descent gains only 4.73 m/s² per vertical metre. Decompose the
    // port load so its normal projection follows A/100 and its contact-plane projection preserves that measured
    // effective pull. This is a shared contact law, not an ice force; the unresolved retail tangent helper may
    // be where the engine produces the same net split.
    accel.addScaledVector(DOWN, GROUND_TANGENTIAL_PULL);
    accel.addScaledVector(n, (GROUND_TANGENTIAL_PULL - s.A / 100) * n.y);

    /**
     * The capped, one-sided pushout — the backstop, not the spring. It fires only once penetration passes the
     * surface's budget, and then it does three things at once: shoves the deck back out along the normal (by
     * the overshoot, at most 10 cm a tick), bleeds that much out of the stored error, and **zeroes the normal
     * velocity** (`vel -= vn·n`, not `vel -= excess·n` — the scalar is the normal speed).
     *
     * The acceleration clamp lives inside this same branch, and only inside it: with the deck already deeper
     * than its budget, any residual into-surface acceleration is removed before integration. Clamping that
     * unconditionally — the pre-rework boards' mistake — deletes gravity from every ordinary tick.
     */
    // The cap is a GROUND backstop; a steep face (WALL_NY) ejects fully — see the PUSHOUT_CAP note above.
    const excess = n.y >= WALL_NY ? Math.max(st.sinkBudget + error, -PUSHOUT_CAP) : st.sinkBudget + error;
    if (excess < 0) {
      st.pos.addScaledVector(n, -excess);
      st.vel.addScaledVector(n, -vn);
      st.error = error - excess;
      const into = accel.dot(n);
      if (into < 0) accel.addScaledVector(n, -into);
    }

    // Steering: a stick "lean" yaws the heading toward the VELOCITY (auto-centre), leading it by the lean angle.
    const vmag = st.vel.length();
    const fwdN = projectOnPlane(ride, n, new THREE.Vector3());
    if (fwdN.lengthSq() > 1e-6) fwdN.normalize(); else fwdN.copy(ride);
    const velN = projectOnPlane(st.vel, n, new THREE.Vector3());
    const travelSpeedN = velN.length();
    const velDir = travelSpeedN > 1e-2 ? velN.divideScalar(travelSpeedN) : fwdN.clone();

    /**
     * The lead latch (docs/016). The auto-centre below closes the heading error onto the travel, and it closes
     * it onto the NEARER end of the deck — so once the travel has swung past `SWITCH_LATCH_ANGLE` of the end that
     * was leading, the other one takes over and the same closure rights the rider into switch instead of whipping
     * the board 180° around to face the way it started. This is the only place the ground model changes what
     * "forwards" means, and it is driven by the travel alone: no key rotates the board on the snow.
     *
     * The speed floor is load-bearing, not a tidy-up. Under it a rider is not travelling in any direction the
     * lead could be read from, and flat ground's contact buzz can manufacture a metre or so of backwards creep
     * out of float noise — handing that the switch lead would hand it the cruise drive too, and ride the rider
     * away backwards from a standstill they never left.
     */
    if (travelSpeedN > SWITCH_LATCH_SPEED && velDir.dot(fwdN) < SWITCH_LATCH_COS) {
      setLead(st.lead > 0 ? -1 : 1);
      fwdN.negate();
    }

    /**
     * WHICH DIRECTION THE HEADING HOMES ONTO. Ordinarily the travel: let go of the stick and the board
     * straightens onto where it is already going. Under VR head steer (docs/048) it is the GAZE instead, so the
     * nose turns to match where the rider looks and stops there — inside `HEAD_LOOK_DEADZONE` the reference is
     * the heading itself, which is the "stop there" (a glance at the scenery must not walk the board round).
     */
    const gazeDir = o.gaze?.();
    const gaze = gazeDir ? projectOnPlane(gazeDir, n, groundGaze) : null;
    let refDir = velDir;
    let headSteer = 0; // gaze-derived steer intent: 0 inside the deadzone, ±1 at HEAD_LEAN_FULL_ANGLE past it
    if (gaze && gaze.lengthSq() > 1e-5) {
      gaze.normalize();
      const deadzone = HEAD_LOOK_DEADZONE * D2R;
      refDir = Math.abs(angleAbout(fwdN, gaze, n)) <= deadzone ? fwdN : gaze;
      /**
       * ...and the gaze also EDGES the board, by driving the same input→lean slew a stick drives. Measured
       * against TRAVEL, never the nose: the closure below parks the nose on the gaze within ~0.1 s (leading it
       * by `turnLean`, which flips a nose-referenced offset's sign), so a nose-referenced lean cancels itself
       * before its banked force can act — and on ice that force is the only thing that bends the path at all.
       * Against travel it mirrors the stick's own loop: the lean holds while the PATH still points away from
       * the gaze, and ebbs as the carve brings it round.
       */
      const offTravel = angleAbout(velDir, gaze, n);
      if (Math.abs(offTravel) > deadzone) {
        headSteer = Math.sign(offTravel)
          * clamp01((Math.abs(offTravel) - deadzone) / (HEAD_LEAN_FULL_ANGLE * D2R));
      }
    }
    // The thumb owns the lean whenever it is deflected; a centred stick hands it to the gaze. `headSteer` is
    // already signed in this frame's own rotation sense, so it takes no STEER_SIGN — that constant exists to map
    // a stick AXIS onto the frame, and there is no axis here.
    const stickSteer = steerInput();
    const stickActive = stickInputActive(stickSteer);
    const steer = stickActive ? STEER_SIGN * stickSteer : headSteer;
    const leanTarget = clamp(steer, -1, 1) * 0.9051856 * Math.min(1, vmag / 11.19);
    let leanRate = clamp(Math.abs(leanTarget - st.lean) * 7.017359, 0.1, 8.018349);
    if (surf === 3 || surf === 4) leanRate *= 0.5999726; // powder steers into the lean slower
    st.lean = moveTowards(st.lean, leanTarget, leanRate * dt);
    // turnLean = lean · c7 · (1 + 0.5·c0·(1 − lean²)) on the (c0, c7) = (0.4, 0.5240) cruise curve, then stiffened
    // by a charged jump — holding the ollie makes the board hold its line.
    let turnLean = st.lean * 0.5239824 * (1 + 0.2 * (1 - st.lean * st.lean)) * STEER_STRENGTH;
    turnLean /= 1 + st.charge * 0.01;

    // slip = signed angle from the REFERENCE direction to the facing, about the contact normal (self-centring).
    // `slipVel` is the same angle measured from the travel — the board's actual DRIFT. They alias on every ride
    // that hands in no gaze, and part company under head steer, where the closure is aimed at the gaze while the
    // low-grip assist below still has to gate on the drift.
    const slipRef = angleAbout(refDir, fwdN, n);
    const slipVel = refDir === velDir ? slipRef : angleAbout(velDir, fwdN, n);

    const speedGate = Math.min(1, vmag * vmag * 0.0033383);
    let align = 40 * Math.min(1, vmag / 5.5556) * (1 - Math.abs(Math.sin(slipVel)));
    align = Math.min(1, Math.max(0, align) + 0.01004205);
    const postMult = Math.max(Math.abs(st.lean), align);

    // The engine closes a fraction `speedGate · max(|lean|, align)` of the heading error every 60 Hz tick, then
    // clamps the result to 6°/tick. On a fixed 60 Hz tick both are simply themselves: `dt` inside a tick is
    // always 1/60 s, so no exponential-closure rewrite is needed to keep the closure frame-rate invariant.
    // Nothing scales either: a gain on top of the closure would over-rotate, and a tighter clamp caps the carve
    // long before the game does (full stick on snow should only reach the cap from ≈8 m/s up).
    const hClose = clamp01(speedGate * postMult);
    const capFrame = GROUND_TURN_RATE * D2R * dt;
    // Low-grip assist term 1 of 2 ([Trailmap: 330-carving] is untouched; see `iceAssistFor`). Damp the yaw
    // only while it is UN-COMMITTING — the commanded lead has fallen inside the slip the board is already
    // carrying, and on the same side of it, so the closure is walking the heading out onto its own drift.
    // Entering a carve (lead outside the slip) and reversing one (opposite signs) both keep full retail
    // authority, so the carve's response is untouched and only the hands-off re-alignment is slowed.
    //
    // The condition has to be the yaw's DIRECTION, not "is the input centred": the lean slews to zero over
    // ~0.14 s while three quarters of the re-alignment is already done, so a lean-gated damp arrives too late
    // to matter (measured: 77/23 → 73/27, i.e. nothing). Applied AFTER the clamp, because the re-alignment
    // runs into the 6°/tick cap and scaling the pre-clamp fraction would not reach it.
    // Reads slipVel (the DRIFT), not slipRef: under head steer the yaw is referenced to the GAZE and the two part
    // company, while the gate has to stay on the drift. Keeping the same variable in both files keeps the ports
    // diffable (`RideableBoard.cs`, same three terms).
    const unCommitting = turnLean * slipVel >= 0 && Math.abs(turnLean) < Math.abs(slipVel);
    const selfCentre = unCommitting ? 1 - assist * ICE_SELF_CENTER_DAMP : 1;
    const yawRad = clamp((turnLean - slipRef) * hClose, -capFrame, capFrame) * selfCentre;
    // VR seat carry (docs/016): the STICK's turn INTENT rotates the upright headset seat with the board, but only
    // by the headset-tested 25% on snow. The quarter is applied AFTER the retail clamp, matching Unity; putting it
    // before the clamp still lets a full-stick high-speed turn hit 6°/tick. Never carry the gaze's share, because
    // a seat that chased the gaze would read as a further gaze offset and spin the wearer.
    if (stickActive) {
      const carry = o.gaze ? XR_GROUND_STICK_VIEW_CARRY : 1;
      st.seatYaw += clamp(turnLean * hClose, -capFrame, capFrame) * carry;
    }
    // The carve yaws the RIDDEN direction; the drawn nose is that direction stamped with the lead, so a switch
    // rider carves exactly as a regular one does and the deck stays pointing the way the air left it.
    const rideDir = fwdN.clone().applyAxisAngle(n, yawRad);
    projectOnPlane(rideDir, n, rideDir);
    if (rideDir.lengthSq() < 1e-6) rideDir.copy(fwdN);
    rideDir.normalize();
    st.fwd.copy(rideDir).multiplyScalar(st.lead);

    // Split velocity in the contact frame; carve away only the LATERAL slip (preserve forward + normal lift).
    const side = new THREE.Vector3().crossVectors(n, rideDir);
    let vF = st.vel.dot(rideDir);
    let vS = st.vel.dot(side);
    const vN = st.vel.dot(n);
    st.slip = Math.abs(vS);
    // The surface's own carve drag bites the edge, straight off the table rather than through a hand-fit 0..1
    // grip: ice (0.0025) is two to three ORDERS below every other rideable surface — that ratio is the ice skid,
    // and a remapped grip flattens it away. Implicit decay so a stiff surface stays stable at any frame rate.
    vS *= 1 / (1 + s.drag * CARVE_BITE * GRIP_SCALE * dt);
    // Low-grip assist term 2 of 2: bleed the slip nobody asked for. `vS = −v·sin(slipRef)` in this frame, and
    // the settled slip is the heading's lead angle, so the COMMANDED lateral is −v·sin(turnLean) — a held lean
    // sits at its own equilibrium and is left alone, while a centred input (turnLean → 0) has its residual
    // drift pulled out. Implicit decay, like the drag line above, so it stays stable at any frame rate.
    if (assist > 0) {
      const wantS = -Math.hypot(vF, vS) * Math.sin(turnLean);
      vS = wantS + (vS - wantS) / (1 + ICE_SLIP_RECOVER * assist * dt);
    }

    // Scrubs toward a standstill from either direction and stops there. An unclamped subtraction drives the
    // forward component negative without limit, so holding the brake on flat ground ACCELERATES the rider
    // backwards — and travelling backwards shuts the cruise drive's alignment gate below.
    if (o.keys.brake) vF = moveTowards(vF, 0, BRAKE_STRENGTH * dt);

    // Surface cruise drive ([Trailmap: 360]): a positive-only deficit toward the surface's speed target, gated by
    // how square the board is to its TRAVEL (full within 30°, fading to nothing at 60° — a sideways skid does not
    // re-accelerate). The deficit is measured against the speed magnitude, not the forward component, and capped.
    const speedNow = Math.sqrt(vF * vF + vS * vS + vN * vN);
    const deficit = Math.min(s.target - speedNow, CRUISE_DEFICIT_MAX);
    if (deficit > 0) {
      // The gate is a HEADING delta ([Trailmap: 360] reads two heading fields, +0x1b0 against +0x370), so it is
      // measured in the contact plane. Taking the angle off the full 3D velocity instead lets the normal channel
      // decide it: a deck settling out of a landing carries normal velocity and little else, which reads as 90°
      // across its own travel and shuts the drive on the exact tick a rider needs it.
      const travelSpeed = Math.hypot(vF, vS);
      // A heading persists through a standstill; an instantaneous velocity direction does not. Under the floor
      // the travel heading is unreadable, so the board's own heading stands in and the delta is zero — the drive
      // pulls the rider up to the surface's target from rest, which is what makes flat ground rideable at all.
      // Refusing to drive here instead makes low speed ABSORBING: nothing else acts along the contact plane at
      // zero slope, so a rider who drops under the floor can never climb back over it.
      const offDeg = travelSpeed > CRUISE_HEADING_FLOOR ? Math.acos(clamp(vF / travelSpeed, -1, 1)) / D2R : 0;
      const driveAlign = clamp01((60 - offDeg) / 30);
      if (driveAlign > 0) vF += (o.drive ?? RIDER_DRIVE) * driveAlign * s.mult * deficit * dt;
    }

    // Held boost ([Trailmap: 360]): a ground-only forward thrust that fires only while the board is ridden nearly
    // FLAT — the lean window is narrow (0.08 against a lean clamp of 0.905), so edging while boosting throws the
    // thrust away. It is not surface-scaled: the surface's character reaches boost only through the cruise target.
    if (boostActive()) {
      const straight01 = clamp01(1 - Math.abs(st.lean) / BOOST_LEAN_WINDOW);
      if (straight01 > 0) vF += BOOST_ACCEL * straight01 * dt;
    }

    st.vel.copy(rideDir).multiplyScalar(vF).addScaledVector(side, vS).addScaledVector(n, vN);
  }

  /** Rebuild the landing-predictor field retail constructs on motion-state-1 entry. The vertical path follows
   * the ride's two gravity phases; horizontal travel follows its exponential drag. Descending chords are cast
   * against the same terrain BVH as contact, once per takeoff rather than every tick. */
  function predictAirDuration(): number {
    const step = 0.1;
    const horizon = 8;
    const rise = st.vel.y > 0 ? st.vel.y / GRAVITY_RISING : 0;
    const riseHeight = st.vel.y > 0 ? st.vel.y * rise - 0.5 * GRAVITY_RISING * rise * rise : 0;
    const horizontalScale = (t: number): number => AIR_H_DRAG > 1e-9
      ? (1 - Math.exp(-AIR_H_DRAG * t)) / AIR_H_DRAG : t;
    const pathPoint = (t: number, out: THREE.Vector3): THREE.Vector3 => {
      const horizontal = horizontalScale(t);
      out.copy(st.pos);
      out.x += st.vel.x * horizontal;
      out.z += st.vel.z * horizontal;
      if (t <= rise) out.y += st.vel.y * t - 0.5 * GRAVITY_RISING * t * t;
      else out.y += riseHeight - 0.5 * GRAVITY * (t - rise) * (t - rise);
      return out;
    };
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    pathPoint(0, from);
    for (let t = step; t <= horizon + 1e-6; t += step) {
      pathPoint(t, to);
      // Do not let the first chord rediscover the lip the deck just left. Only the descending half can land.
      const falling = t > rise + step * 0.5;
      if (falling && t >= 0.2) {
        const hit = castSeg(from, to);
        if (hit) {
          const world = hit.point.clone().applyMatrix4(toWorld);
          const fraction = clamp(from.distanceTo(world) / Math.max(from.distanceTo(to), 1e-9), 0, 1);
          return Math.max(0, t - step + step * fraction);
        }
      }
      from.copy(to);
    }
    return 0;
  }

  /**
   * The air integrator ([Trailmap: 340]) — a separate integrator with no contact term at all, which is why the
   * grounded response's above-surface pull can never reach a rider who has left the band. Two-stage gravity
   * (weak rising, strong falling) is the whole vertical model, and it is roughly twice the grounded pull;
   * horizontal velocity is only damped, never rebuilt, so takeoff carry survives to the landing.
   */
  function airTick(dt: number, accel: THREE.Vector3) {
    accel.set(-AIR_H_DRAG * st.vel.x, -(st.vel.y > 0 ? GRAVITY_RISING : GRAVITY), -AIR_H_DRAG * st.vel.z);
    st.airTime += dt;
    st.slip = 0;

    // AIR BOOST follows the deck's visible nose — the same axis the new board trail leaves behind. Below the cap
    // this is ordinary 8 m/s² thrust. Across the last 2 m/s, where the shared cap would erase a sideways
    // push, it cross-fades into (a) real braking for an against-travel aim and (b) a magnitude-preserving turn
    // toward the perpendicular deck axis at up to 40°/s. Pointing with travel at the cap honestly does nothing.
    if (heldBoostActive()) {
      boardPointingDirection(st, airAim);
      const speed = st.vel.length();
      const capness = clamp01((speed - (st.speedCap - AIR_BOOST_CAP_BLEND)) / AIR_BOOST_CAP_BLEND);
      if (capness < 1) {
        accel.addScaledVector(airAim, AIR_BOOST_ACCEL * (1 - capness));
        airBoostActive = true;
      }
      if (capness > 0 && speed > 1e-6) {
        airVelocityDir.copy(st.vel).divideScalar(speed);
        const parallel = airAim.dot(airVelocityDir);
        if (parallel < 0) {
          accel.addScaledVector(airVelocityDir, parallel * AIR_BOOST_ACCEL * capness);
          airBoostActive = true;
        }
        airAimPerp.copy(airAim).addScaledVector(airVelocityDir, -parallel);
        const perpendicular = airAimPerp.length();
        if (perpendicular > 1e-6) {
          airTurnAxis.crossVectors(airVelocityDir, airAimPerp).normalize();
          st.vel.applyAxisAngle(airTurnAxis, AIR_BOOST_TURN_RATE * capness * perpendicular * D2R * dt);
          airBoostActive = true;
        }
      }
    }

    // Unity lifts the game's x1.6 trick-boost number onto both rider-controlled air rotations. Head/gaze follow
    // stays at the ordinary rate so it still turns toward its target and stops there instead of overshooting.
    const spinBoostMul = boostActive() ? AIR_TRICK_BOOST_SPIN_MUL : 1;
    const steer = STEER_SIGN * airSteerInput();
    const yawAir = steer * AIR_TURN_RATE * spinBoostMul * D2R * dt;
    st.fwd.applyAxisAngle(st.boardUp, yawAir).normalize();
    st.seatYaw += yawAir; // VR: the air spin carries the seat with it at full strength (docs/016)
    // ...and then the gaze aims what is left, at the same air rate, stopping when the nose reaches it. The
    // misalignment is measured IN THE DECK PLANE — in the air `fwd` keeps its takeoff pitch while `boardUp`
    // levels back toward world up, so a raw 3D angle stays inflated, never reaches the deadzone, and jitters
    // around the gaze azimuth. The rotation still spins the unflattened `fwd`, preserving that pitch (docs/048).
    // A centred XR stick hands heading to gaze. While any manual left/right source owns the spin, gaze must stand
    // down; following the still-forward head at the same 270°/s otherwise cancels the stick rotation tick-for-tick.
    if (!(o.stick.active || o.keys.left || o.keys.right))
      headFollow(st.fwd, st.boardUp, AIR_TURN_RATE * D2R * dt);
    st.airUp.set(0, 1, 0);
    // The flip (docs/016): W over the nose, S over the tail, at the same rate the spin turns — [Trailmap: 340]
    // rotates every axis alike. It is the only thing either key does off the ground: the brake reaches motion
    // solely through `groundTick`, and the tuck was never anything but the rider's legs.
    st.flip += ((o.keys.tuck ? 1 : 0) - (o.keys.brake ? 1 : 0))
      * AIR_TURN_RATE * spinBoostMul * dt;

    // [Trailmap: 340] pre-landing alignment, the "while falling" half of the air update: march the ballistic
    // path in bounded chords and take the first terrain crossing as the upcoming landing. Drag is ignored over
    // the sub-second horizon (it moves the prediction centimetres), and `forcedAir` skips the march while an
    // ollie is still climbing out of the surface it fired inside — a chord starting underground would read the
    // lip it just left as an imminent landing. The crossing's exact analytic contact then aims `airUp` (pose
    // turns the deck toward it in the time `landEta` has left) and refreshes the contact fields for the surface
    // the deck is about to hit — a fall toward powder has its sink budget easing in before arrival.
    if (st.vel.y < 0 && !st.forcedAir) {
      const chordFrom = new THREE.Vector3().copy(st.pos);
      const chordTo = new THREE.Vector3();
      for (let t = PREALIGN_STEP; t <= PREALIGN_HORIZON + 1e-6; t += PREALIGN_STEP) {
        chordTo.copy(st.pos).addScaledVector(st.vel, t);
        chordTo.y -= 0.5 * GRAVITY * t * t;
        const hit = castSeg(chordFrom, chordTo);
        if (hit) {
          const world = hit.point.applyMatrix4(toWorld);
          // Ratios along a segment survive any affine terrain matrix, so the fraction reads in world space.
          const frac = chordFrom.distanceTo(world) / Math.max(chordFrom.distanceTo(chordTo), 1e-9);
          st.landEta = t - PREALIGN_STEP * (1 - frac);
          // A conservative state-entry scan can miss a very near/complex landing. Once the ordinary falling
          // predictor sees it, retain the recovered total so the retail threshold still has the right meaning.
          st.predictedAirTime = Math.max(st.predictedAirTime, st.airTime + st.landEta);
          const p = probe(world, WORLD_UP);
          if (p.found) { st.airUp.copy(p.n); st.surf = p.surf; }
          break;
        }
        chordFrom.copy(chordTo);
      }
    }
  }

  /**
   * The charged launch ([Trailmap: 340]) — an impulse ADDED to the carried velocity, never replacing it, built in
   * the contact frame off the CACHED contact normal (so a release on a coyote frame still pops off the slope it
   * just left).
   *
   * Direction: `steep` measures how far past 50° the ground has tipped, and is NEGATIVE on ordinary ground — flat
   * ground gives ≈ −1.19, not zero. That negative is not a clamp to be swallowed; it selects a different blend.
   * Ordinary flat-to-gentle launches take the fixed fallback `normalize(n + 0.2·tangent)`, leaning the pop slightly
   * down-course (≈ 6.19 m/s vertical at the minimum launch, off the √1.04 the fallback normalizes away). Only past
   * 50°, with the travel tangent pointing up, does the weighted normal↔tangent blend take over and throw the rider
   * down the lip. There is no ramp-surface special case: a booter is its table row plus this geometry.
   *
   * Magnitude: `charge² · riderCurve · speedFactor`, floored at 6.309 m/s. The floor means a tap is already a real
   * pop; the charge pays quadratically and a faster approach jumps higher, until speedFactor saturates at ≈9 m/s
   * worth. At mid rider stat the product never clears the floor, so charge only buys height for a high-stat rider.
   */
  function launchOllie() {
    const n = st.contactN.lengthSq() > 1e-6 ? st.contactN.clone().normalize() : WORLD_UP.clone();
    const ride = rideForward(st, new THREE.Vector3());
    const travel = st.vel.lengthSq() > 1e-4 ? st.vel : ride;
    const tangent = projectOnPlane(travel, n, new THREE.Vector3());
    const flatTangent = tangent.lengthSq() <= 1e-6;
    if (flatTangent) tangent.copy(ride); else tangent.normalize();

    const steep = (0.642788 - n.y) / 0.300768;  // (cos50° − n·up) / (cos50° − cos70°); < 0 on ordinary ground
    const dir = n.clone();
    if (steep <= 0 || flatTangent) dir.addScaledVector(tangent, LAUNCH_FALLBACK_TANGENT); // the ordinary case
    else dir.addScaledVector(tangent, clamp(steep * (tangent.y / 0.342020) * LAUNCH_TANGENT_MIX, 0, 0.9));
    if (dir.lengthSq() > 1e-6) dir.normalize(); else dir.copy(n);

    const speedFactor = Math.min(0.88093346 * st.vel.length() + 0.24678448, JUMP_SPEED_FACTOR_MAX);
    const launch = Math.max(JUMP_MIN, st.charge * st.charge * JUMP_RIDER_CURVE * speedFactor);
    const velocityBefore = tickTrace ? telemetryVec(st.vel) : null;
    st.vel.addScaledVector(dir, launch);
    if (tickTrace) tickTrace.events.push({
      type: 'launch', charge: st.charge, direction: telemetryVec(dir), impulse: launch,
      velocityBefore: velocityBefore!, velocityAfter: telemetryVec(st.vel),
    });
    st.ollieCooldown = OLLIE_COOLDOWN;
    // Spend the coil. The rider's legs drive out in the charge that fed them, not in the launch speed — the spec's
    // floor means a tap and a full charge leave the lip within 1.7 m/s of each other, so the *speed* would show
    // nothing. What a watcher reads is how deep he was and how hard he stood up.
    st.popDrive = POP_MIN + (1 - POP_MIN) * clamp01(st.charge);
    st.popTime = POP_TIME;
    // The launch forces motion state 1 ([Trailmap: 300]): it fires with no contact check, and the deck is still
    // inside the surface on the tick it fires. Without this the pop is spent against the contact response that
    // the deck has not yet climbed out of.
    st.forcedAir = true;
    // A jump leaves the rail through this same shared launch — there is no rail-specific exit pop
    // ([Trailmap: 350]). `contactN` above was the rail-local vertical, so the pop stands off the rail plane;
    // the lockout keeps the positional entry windows from re-accepting the first ticks of the rising deck.
    if (st.railIdx >= 0) { st.railIdx = -1; railCooldown = RAIL_RELOCK_TIME; }
  }

  /**
   * Rail acquisition ([Trailmap: 350]): the same candidate query as staying on, accepted when the rider sits
   * inside the rail-local snap windows scaled 0.9 — entry is slightly stricter. Entry preserves the carried
   * velocity (the grind re-aims it, never resets it) and clears the carve lean.
   */
  function tryEnterRail() {
    const q = o.rails!.query(st.pos);
    if (!q || !railWindows(q, 0, RAIL_ENTRY_SCALE)) return;
    st.railIdx = q.rail;
    st.railTime = 0;
    st.lean = 0;
    // The deck facing carries over exactly: the rail yaw picks up wherever the catch left the board pointing.
    // This mirrors Unity's freely steered rail deck, including catches beyond the old retail ±80° pose window.
    const travel = st.vel.dot(q.tangent) >= 0 ? q.tangent.clone() : q.tangent.clone().negate();
    const fwdP = projectOnPlane(st.fwd, q.up, new THREE.Vector3());
    let yaw = 0;
    if (fwdP.lengthSq() > 1e-6) {
      fwdP.normalize();
      // The catch commits the lead the same way a landing does: whichever end of the deck is already leading
      // the rail's travel. A switch catch measured off the nose alone reads as a 180° boardslide, which the ±80°
      // clamp then snaps most of the way out of — the rider would be spun straight on the rail.
      setLead(fwdP.dot(travel) >= 0 ? 1 : -1);
      fwdP.multiplyScalar(st.lead);
      const crossV = new THREE.Vector3().crossVectors(travel, fwdP);
      yaw = Math.atan2(crossV.dot(q.up), travel.dot(fwdP)) / D2R;
    }
    st.railYaw = yaw;
  }

  /**
   * One grind tick ([Trailmap: 350]) — motion state 3's integrator, replacing the terrain probe / response /
   * redirect wholesale. The grind continues only while this tick's rail query re-ACCEPTS contact: the windows
   * hold their widest for the first 0.6 s (the attach grace), and the ways off are no candidate (the rail
   * ended), a window failure (drifted / sank off the attachment), or the shared jump launch. Chaining onto a
   * following rail is just this same query accepting a different candidate. Returns false only when the rider
   * went out of bounds (respawned).
   */
  function railTick(h: number, accel: THREE.Vector3): boolean {
    if (st.pos.y < o.oobFloorY && automaticResetToCourse()) return false;
    st.railTime += h;
    const q = o.rails!.query(st.pos);
    if (!q || !railWindows(q, st.railTime < RAIL_GRACE ? 1 : 0)) {
      // lost contact: transition to air with carried velocity, this very tick — nothing is bled or zeroed
      st.railIdx = -1;
      st.airTime = 0;
      st.predictedAirTime = predictAirDuration();
      st.grounded = false;
      airTick(h, accel);
      return true;
    }
    st.railIdx = q.rail;
    // The rail's surface REPLACES the terrain's in the rider's contact fields while grinding, so ride feel —
    // and the row the fields slew back from at touchdown — keys off the rail's material ([Trailmap: 350]).
    st.surf = q.surf;
    const s = surfaceFor(st.surf);
    const slew = CONTACT_SLEW * h;
    st.sinkBudget = moveTowards(st.sinkBudget, s.budget, slew);
    st.sinkBog = moveTowards(st.sinkBog, s.bog, slew);
    st.lift = moveTowards(st.lift, 0, slew); // rail splines own contact height; ground-only visual lift fades out
    st.error = 0;
    st.contactN.copy(q.up);          // the pose's deck-up and the ollie's launch normal both read this
    st.jumpGrace = JUMP_COYOTE_TIME; // the ollie fires the shared jump launch from the rail ([Trailmap: 350])

    // Tangent capture: velocity slews toward its projection on the curve tangent at 30/s, KEEPING its
    // magnitude — entry speed becomes grind speed, and a crooked catch is re-aimed, not bled.
    const T = q.tangent;
    const spd0 = st.vel.length();
    const proj = new THREE.Vector3().copy(T).multiplyScalar(st.vel.dot(T));
    st.vel.lerp(proj, Math.min(1, RAIL_TANGENT_SLEW * h));
    const spd1 = st.vel.length();
    if (spd1 > 1e-8) st.vel.multiplyScalar(spd0 / spd1);

    // The three speed terms and no drag: slope gravity dotted onto the tangent (downhill rails accelerate,
    // uphill rails bleed), and the held boost's thrust signed by the current travel direction.
    accel.copy(T).multiplyScalar(-RAIL_GRAVITY * T.y);
    if (boostActive()) accel.addScaledVector(T, RAIL_BOOST_ACCEL * Math.sign(st.vel.dot(T) || 1));

    // The lateral attachment correction: position only, never speed. Retail and bare curves already author the
    // rider/contact line (`q.seat == 0`); only a generated pipe lifts from its centreline to its crown. Inside
    // the windows the spec's ±2.9 m clamp is a full re-seat, leaving along-tangent motion alone.
    const seat = q.point.clone().addScaledVector(q.up, q.seat).sub(st.pos);
    seat.addScaledVector(T, -seat.dot(T));
    const cl = seat.length();
    if (cl > RAIL_ATTACH_CLAMP) seat.multiplyScalar(RAIL_ATTACH_CLAMP / cl);
    st.pos.add(seat);

    // Deck spin never steers the rail-locked travel. Every input path mirrors the shipped Unity board: held
    // steering rotates the carried facing continuously at the air spin rate (trick-boost multiplier included),
    // so it can pass through a full 360 without a target-angle clamp. WebXR additionally carries stick yaw into
    // the upright view; centring its stick hands the deck to target-based head steering while the view remains
    // pinned. Lean stays cleared: there is no carve on a rail.
    const spinBoostMul = boostActive() ? AIR_TRICK_BOOST_SPIN_MUL : 1;
    const stickSteer = steerInput();
    const steer = STEER_SIGN * stickSteer;
    const travel = st.vel.dot(T) >= 0 ? T.clone() : T.clone().negate();
    if (o.gaze) {
      if (stickInputActive(stickSteer)) {
        const yaw = steer * AIR_TURN_RATE * spinBoostMul * h;
        st.seatYaw += yaw * D2R;
        // Rotate the carried facing itself, not a yaw rebuilt from the rail tangent. That keeps the deck world-free
        // through a curved rail exactly as Unity does; travel alone follows the spline.
        st.fwd.applyAxisAngle(q.up, yaw * D2R).normalize();
        const riddenFwd = st.fwd.clone().multiplyScalar(st.lead);
        st.railYaw = angleAbout(travel, riddenFwd, q.up) / D2R;
      } else {
        // HeadFollow works on the ridden end; stamp the switch lead back onto the visible nose afterward.
        const riddenFwd = st.fwd.clone().multiplyScalar(st.lead);
        headFollow(riddenFwd, q.up, AIR_TURN_RATE * D2R * h);
        st.railYaw = angleAbout(travel, riddenFwd, q.up) / D2R;
        st.fwd.copy(riddenFwd).multiplyScalar(st.lead).normalize();
      }
    } else {
      // Rotate the carried facing, as Unity does, instead of rebuilding it from a bounded angle to the tangent.
      // The drawn nose already includes the switch lead, so both regular and switch grinds spin continuously.
      st.fwd.applyAxisAngle(q.up, steer * AIR_TURN_RATE * spinBoostMul * h * D2R).normalize();
      const riddenFwd = st.fwd.clone().multiplyScalar(st.lead);
      st.railYaw = angleAbout(travel, riddenFwd, q.up) / D2R;
    }
    st.lean = 0;
    st.slip = 0;
    st.grounded = true;
    st.airTime = 0;
    st.predictedAirTime = 0;
    return true;
  }

  function heldBoostActive() { return o.keys.boost && (o.heldBoostAvailable?.() ?? true); }

  function boostActive() { return heldBoostActive() || padBoostTimer > 0; }

  /** World/failure-driven recovery gate. Manual callers use `resetToCourse` directly and never pass here. */
  function automaticResetToCourse(): boolean {
    if (!(o.automaticRespawnAvailable?.() ?? true)) return false;
    resetToCourse();
    return true;
  }

  /** The Unity boost-roar gate: held boost on snow, or a board-pointed air boost that performed real work. Pads have
   * their own cue and a rail only sustains the cap, so neither runs the held roar. */
  function boostThrustActive() {
    return heldBoostActive() && (st.grounded ? st.railIdx < 0 : airBoostActive);
  }

  /** MainType-17 speed pads grant an amount, not an impulse. Keep the strongest remaining window. */
  function applyPadBoost(amount: number) {
    if (Number.isFinite(amount) && amount > 0) padBoostTimer = Math.max(padBoostTimer, amount * 0.5);
  }

  /**
   * The signed stick axis the lean shaping reads ([Trailmap: 330] takes a stick, not a button). A held touch owns
   * it and reports the thumb's deflection through the response curve; otherwise the keys stand in at full throw.
   * That difference is visible in the ride: a key pins `lean` at its ±0.905 clamp within about a tenth of a second,
   * and the held boost's lean window is ±0.08 — so on a keyboard, *any* steering input kills the boost thrust
   * outright. Only a thumb reaches the band, and only the curve makes it wide enough to sit in.
   */
  function steerInput(): number {
    if (o.stick.active) return o.stick.x;
    return (o.keys.right ? 1 : 0) - (o.keys.left ? 1 : 0);
  }

  /** Air tricks need proportional throw, not the precision curve designed to hold a carve line near centre. */
  function airSteerInput(): number {
    if (o.stick.active) return o.stick.airX ?? o.stick.x;
    return (o.keys.right ? 1 : 0) - (o.keys.left ? 1 : 0);
  }

  /**
   * Unity chooses stick ownership from the RAW axis before applying `x²`. WebXR's input layer has already applied
   * its physical dead zone and exposes that decision as `stick.active`, so a small curved result must still beat
   * head steering. Non-XR keeps the model's existing magnitude threshold and therefore stays bit-for-bit unchanged.
   */
  function stickInputActive(value: number): boolean {
    return o.gaze ? o.stick.active : Math.abs(value) > HEAD_STICK_OVERRIDE;
  }

  /**
   * VR head steer, the AIR half (docs/048): turn `fwd` toward the gaze about `planeN` by at most `maxStep`
   * radians, and stop on arrival rather than overshooting past it. A no-op without a gaze, which is every
   * non-headset ride. `fwd` is rotated in place and keeps whatever pitch it left the lip with.
   */
  function headFollow(fwd: THREE.Vector3, planeN: THREE.Vector3, maxStep: number) {
    const gazeDir = o.gaze?.();
    if (!gazeDir || maxStep <= 0) return;
    const gaze = projectOnPlane(gazeDir, planeN, headGaze);
    if (gaze.lengthSq() < 1e-6) return;         // looking straight along the normal: no yaw to follow
    const flat = projectOnPlane(fwd, planeN, headFlat);
    if (flat.lengthSq() < 1e-6) return;         // ...nor if the heading itself has no in-plane part
    const off = angleAbout(flat.normalize(), gaze.normalize(), planeN);
    const reach = Math.abs(off) - HEAD_LOOK_DEADZONE * D2R;
    if (reach <= 0) return;                     // already pointed where you look → stop turning
    fwd.applyAxisAngle(planeN, Math.sign(off) * Math.min(maxStep, reach)).normalize();
  }
  const headGaze = new THREE.Vector3(), headFlat = new THREE.Vector3(), groundGaze = new THREE.Vector3();

  /** Ollie press / release, shared by Space and the touch button. A press only takes if the cooldown has run out;
   *  the release queues the launch, which `step` fires (possibly on a coyote frame). */
  function ollieDown() { if (st.ollieCooldown <= 0 && !st.charging) { st.charging = true; st.charge = 0; } }
  function ollieUp() { if (st.charging) { st.charging = false; releaseQueued = true; } }

  // ---- terrain probe ----

  /**
   * Cast the world segment `from → to`. Returns the hit in the terrain's LOCAL space (where the BVH lives) plus
   * its face. Both endpoints are mapped to local first, so the segment length stays exact under whatever scale
   * or chirality mirror the terrain's world matrix carries.
   */
  function castSeg(from: THREE.Vector3, to: THREE.Vector3): { point: THREE.Vector3; faceIndex: number; normal: THREE.Vector3 } | null {
    const t = performance.now();
    const a = from.clone().applyMatrix4(toLocal);
    const b = to.clone().applyMatrix4(toLocal);
    const far = a.distanceTo(b);
    if (far < 1e-9) return null;
    localRay.origin.copy(a);
    localRay.direction.copy(b).sub(a).divideScalar(far);
    const hit = bvh.raycastFirst(localRay, THREE.DoubleSide, 0, far);
    perf.castAccum += performance.now() - t; // accumulate the raycast cost this frame
    if (!hit || hit.faceIndex == null) return null;
    // `normal` is the LOCAL geometric face normal, unflipped — a DoubleSide cast reports the face as authored,
    // so a caller that needs it oriented (toward the segment origin, or up-facing) decides that itself.
    return { point: hit.point as THREE.Vector3, faceIndex: hit.faceIndex, normal: (hit.face?.normal ?? WORLD_UP).clone() };
  }

  /**
   * Closest point on the exact terrain mesh the ride renders. Camera axis rays can miss diagonal faces, while a
   * correction against one face of a concave bank can leave the eye inside its neighbour. This BVH query gives
   * the camera a spherical post-pass over the visual mesh; distance is checked in world space so mirrored or
   * scaled terrain matrices remain correct.
   */
  function closestCameraTerrain(point: THREE.Vector3, maxDistance: number): {
    point: THREE.Vector3; normal: THREE.Vector3; distance: number;
  } | null {
    const started = performance.now();
    cameraTerrainLocal.copy(point).applyMatrix4(toLocal);
    const hit = bvh.closestPointToPoint(cameraTerrainLocal, cameraTerrainNearHit);
    if (!hit || hit.faceIndex == null) {
      perf.castAccum += performance.now() - started;
      return null;
    }
    cameraTerrainWorld.copy(hit.point).applyMatrix4(toWorld);
    const distance = point.distanceTo(cameraTerrainWorld);
    if (distance > maxDistance + 1e-5) {
      perf.castAccum += performance.now() - started;
      return null;
    }
    const i = hit.faceIndex * 3;
    let normal = WORLD_UP.clone();
    if (geoIndex && i + 2 < geoIndex.length) {
      triA.fromBufferAttribute(geoPos, geoIndex[i]);
      triB.fromBufferAttribute(geoPos, geoIndex[i + 1]);
      triC.fromBufferAttribute(geoPos, geoIndex[i + 2]);
      normal = triB.clone().sub(triA).cross(triC.clone().sub(triA)).applyMatrix3(normalMat).normalize();
    }
    perf.castAccum += performance.now() - started;
    return { point: cameraTerrainWorld.clone(), normal, distance };
  }

  /** Sweep a compact rider/board volume over this tick. Up-facing hits belong to the contact probe; walls and
   * ceilings run the same bounded four-plane collide-and-slide as the Unity board, so a concave corner is solved
   * in one tick instead of alternating faces and pinning the rider across many ticks. */
  function obstacleNearSweptBody(base: THREE.Vector3, movementLength: number): boolean {
    const reach = RIDER_HEAD_Y + movementLength + RIDER_BARRIER_PAD;
    const t = performance.now();
    const hit = obstacleBVH?.closestPointToPoint(base, obstacleNearHit, 0, reach);
    const sphereHit = !hit && obstacleSphereBodies.some(body => body.bound.distanceToPoint(base) <= reach);
    // A native box's own reach is the body sphere's, which sits inside the head-height span above.
    const boxHit = !hit && !sphereHit && obstacleBoxes.some(box => box.bound.distanceToPoint(base) <= reach);
    perf.castAccum += performance.now() - t;
    return !!hit || sphereHit || boxHit;
  }

  function resolveBarrierHit(previousPos: THREE.Vector3, nextPos: THREE.Vector3, includeTerrain: boolean,
    includeObstacles: boolean) {
    barrierMovement.copy(nextPos).sub(previousPos);
    if (barrierMovement.lengthSq() < 1e-16) return;
    barrierTouches.clear();
    let wedgeFrame = 0;

    const up = barrierUp.copy(st.boardUp.lengthSq() > 1e-6 ? st.boardUp : WORLD_UP).normalize();
    const forward = projectOnPlane(st.fwd, up, barrierForward);
    if (forward.lengthSq() < 1e-6) projectOnPlane(barrierMovement, up, forward);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1); else forward.normalize();
    const right = barrierRight.crossVectors(up, forward).normalize();
    // The sample body is shared with Test mode's collider overlay (`ride/rider-volume.ts`) so what is drawn is
    // what collides.
    riderProbeOffsets(forward, right, up, barrierOffsets);

    // A grind runs the narrowest prop probe in the game: the engine drops all but two of the rider's collision
    // spheres before the object pass, and those two are the TORSO and the HEAD — read off the live sphere set,
    // they are the only limbs posed above the pelvis ([Trailmap: 350-probe]). Legs, feet and all four board
    // spheres are masked off, which is exactly right for a grind: the board is locked to the spline, so the
    // only thing that still has to meet world props is the rider standing on it. So on a rail the deck
    // footprint does NOT participate in prop collision and the upper-body samples do.
    const obstacleFirst = st.railIdx >= 0 ? RIDER_DECK_SAMPLES : 0;

    const position = barrierPosition.copy(previousPos);
    const remaining = barrierRemaining.copy(barrierMovement);
    const direction = barrierDirection;
    // Four iterations is the established board collide-and-slide bound. Two solve an ordinary corner; the extra
    // pair cover a third face or a tiny seam without making malformed geometry an unbounded physics loop.
    for (let iteration = 0; iteration < 4; iteration++) {
      const length = remaining.length();
      if (length < 1e-8) break;
      direction.copy(remaining).divideScalar(length);
      barrierIterationTouches.clear();

      // The mode-3 gate and the mode-2 sweep are both body-sphere tests, so they are established once for the
      // whole rider rather than being repeated thirteen times. Both span this iteration's remaining
      // displacement, the same vector every sample ray uses, which keeps their distances comparable.
      barrierBodyTo.copy(position).add(remaining);
      if (includeObstacles) gateSphereBodiesByBodySphere(position, barrierBodyTo, up);

      let earliest: { distance: number; normal: THREE.Vector3; meta?: ObstacleMeta } | null = null;
      for (let sampleIndex = 0; sampleIndex < barrierOffsets.length; sampleIndex++) {
        const offset = barrierOffsets[sampleIndex];
        barrierFrom.copy(position).add(offset);
        barrierTo.copy(barrierFrom).add(remaining);
        const terrainHit = includeTerrain ? castTerrainBarrier(barrierFrom, barrierTo, remaining) : null;
        if (terrainHit && (!earliest || terrainHit.distance < earliest.distance)) earliest = terrainHit;
        // Native ride-through triggers are board/ground contacts. Reporting them from the added torso/head
        // tunnel samples makes a 2 m lifted panel fire as the rider passes beneath it (the PS2 negative control
        // does not). Solid geometry still uses all thirteen samples so walls and low roofs retain body collision.
        // The elevated pass-through case a grounded BODY does meet — GARI's smash-through Lcd_ScreenLogo — is
        // the grounded body stab after the solve below, whose fixed reach keeps that same negative intact.
        const obstacleHit = includeObstacles && sampleIndex >= obstacleFirst
          ? castObstacleBarrier(barrierFrom, barrierTo, remaining, barrierIterationTouches,
            sampleIndex < RIDER_DECK_SAMPLES) : null;
        if (obstacleHit && (!earliest || obstacleHit.distance < earliest.distance)) earliest = obstacleHit;
      }
      const touchLimit = earliest?.distance ?? length;
      for (const [key, touch] of barrierIterationTouches) {
        // All samples share the same movement vector, so their ray distances are comparable. A hit beyond the
        // earliest blocking plane was never reached after collide-and-slide clipped this iteration; accepting it
        // was the source of "phantom" sounds from props just behind the actual obstacle.
        if (touch.distance > touchLimit + 1e-5) continue;
        const previous = barrierTouches.get(key);
        if (!previous || touch.impactSpeed > previous.impactSpeed) barrierTouches.set(key, touch);
      }
      if (!earliest) { position.add(remaining); remaining.set(0, 0, 0); break; }

      const padding = Math.min(RIDER_BARRIER_PAD, earliest.distance * 0.5);
      const allowed = Math.max(0, earliest.distance - padding);
      position.addScaledVector(direction, allowed);
      // Spend the advance, then slide all of the leftover displacement along this plane. A second iteration can
      // now discover and clip a neighbouring face during the same tick instead of bouncing between them at 60 Hz.
      remaining.addScaledVector(direction, -allowed);
      remaining.addScaledVector(earliest.normal, -remaining.dot(earliest.normal));

      const velocityBefore = tickTrace ? telemetryVec(st.vel) : null;
      const into = st.vel.dot(earliest.normal);
      if (into < 0) {
        const bounceDelta = -into * (1 + (earliest.meta?.bounce ?? 0));
        // Terrain and generic/manual solid fallbacks only cancel the inward component. The native PlayerBounce
        // branch additionally guarantees a 2 km/h outward component: delta = -into + max(b*speed, floor).
        const responseDelta = earliest.meta?.playerBounce
          ? Math.max(bounceDelta, -into + PROP_BOUNCE_EJECT_FLOOR)
          : bounceDelta;
        st.vel.addScaledVector(earliest.normal, responseDelta);
        // Props only ([Trailmap: 395-reset-arm] arms on contact with an OBJECT); terrain is what a rider carves
        // on all day, and counting it would reset every rider on the mountain.
        if (earliest.meta) wedgeFrame = Math.max(wedgeFrame, wedgeContribution(earliest.normal));
      }
      // The roof clause only applies to a surface the contact probe can actually READ. Terrain always qualifies;
      // a prop qualifies when it has a ride surface or is the temporary shell supporting an in-place mount.
      // Firing it on any other solid prop buys nothing — the probe was never going to seat the board on that
      // shell — and costs everything: forcedAir suppresses the terrain contact the rider is standing on, and the
      // terrain barrier sweep defers every up-facing face to that same probe, so no authority is left to stop the
      // deck sinking through the floor. The underside of a roller is not a roof.
      const probeReadable = !earliest.meta || obstacleIsProbeReadable(earliest.meta);
      // ...and never against the body the deck is seated on. `forcedAir` releases only UPWARD (the `error >
      // threshold` clear in the contact tick), so latching it on the rider's own ground cannot be undone: the
      // probe that would clear it is the one forcedAir just switched off, and the deck sinks until the OOB floor
      // catches it. A genuine ceiling is never the surface being ridden, so the tunnel case is untouched.
      // Terrain carries no key and keeps the original behaviour: its roofs and its floors are separate faces of
      // one body, which the analytic barrier normal already tells apart.
      const ownGround = st.grounded && !!st.groundKey && earliest.meta?.key === st.groundKey;
      if (probeReadable && earliest.normal.y < -0.35) {
        st.vel.y = Math.min(0, st.vel.y);
        // This is the underside of a roof, not a landing. Keep forcedAir set until the deck has fallen clear of
        // the roof probe: clearing it here lets next tick's down-probe read the same shell from above — the
        // reference's faceted path orients its normal along the aim and would seat the board on the roof's far
        // side. Gravity carries the stopped board back into the tube; the usual clearance rule releases
        // forcedAir once the roof is out of probe range, before the real floor is reached.
        if (!ownGround) st.forcedAir = true;
      }
      if (tickTrace) recordBarrierEvent({
        type: 'barrier-resolved', distance: earliest.distance, normal: telemetryVec(earliest.normal),
        velocityBefore: velocityBefore!, velocityAfter: telemetryVec(st.vel),
      });
    }
    // Bounding-box props resolve AFTER the movement solve, because the engine does not clip a rider against one
    // — it completes the move and pushes back out. Its touches join this tick's report like any other.
    if (includeObstacles) {
      barrierIterationTouches.clear();
      wedgeFrame = Math.max(wedgeFrame, resolveBoxContacts(previousPos, position, up, barrierIterationTouches));
      for (const [key, touch] of barrierIterationTouches) {
        const previous = barrierTouches.get(key);
        if (!previous || touch.impactSpeed > previous.impactSpeed) barrierTouches.set(key, touch);
      }
    }
    nextPos.copy(position); // after four planes any unsolved remainder is deliberately discarded, as in Unity

    // A flush ride-through prop is contactable but can never be selected by the ground probe (`solid === false`).
    // The swept barrier rays do not see it either: their board samples are deliberately 14 cm above the deck, so
    // they run parallel to a floor panel instead of crossing it. Read the short band immediately UNDER the nine
    // board-footprint samples after the movement solve, and merge only pass-through touches into this tick's
    // report. Solid ground remains owned by the contact probe, and an overhead plate lies outside this one-sided
    // sensor — preserving the native negative where a rider passes beneath a lifted trigger.
    if (includeObstacles) {
      barrierSensorTouches.clear();
      barrierSensorMotion.copy(up).multiplyScalar(-(BOARD_COLLISION_Y + BOARD_SENSOR_BELOW));
      for (let sampleIndex = 0; sampleIndex < RIDER_DECK_SAMPLES; sampleIndex++) {
        barrierFrom.copy(position).add(barrierOffsets[sampleIndex]);
        barrierTo.copy(barrierFrom).add(barrierSensorMotion);
        castObstacleBarrier(barrierFrom, barrierTo, barrierSensorMotion, barrierSensorTouches, true);
      }
      // The grounded BODY COLUMN, upward: one stab from the deck to head height, pass-through touches only.
      // An elevated smash-through panel (GARI's Lcd_ScreenLogo, a mode-2 response-mass-0 box whose underside
      // rides above the board sweep) is met by the rider's TORSO, and with no report from up here it only ever
      // broke for a rider who jumped into it board-first. The PS2 evidence brackets the reach: contact
      // detection extends ~2 m above the board — a mode-1 gate lifted 2 m does NOT dispatch riding beneath
      // (auth-gate-m1-lifted, the negative the swept torso/head samples above must not report for). Head
      // height keeps ~30 cm under that bound, and GROUNDED-ONLY is what makes the margin robust: any loft
      // switches the stab off rather than carrying it up into a lifted trigger.
      if (st.grounded) {
        barrierFrom.copy(position).addScaledVector(up, BOARD_COLLISION_Y);
        barrierSensorMotion.copy(up).multiplyScalar(RIDER_HEAD_Y - BOARD_COLLISION_Y);
        barrierTo.copy(barrierFrom).add(barrierSensorMotion);
        castObstacleBarrier(barrierFrom, barrierTo, barrierSensorMotion, barrierSensorTouches, true);
      }
      for (const [key, touch] of barrierSensorTouches) {
        if (touch.meta.solid) continue;
        const previous = barrierTouches.get(key);
        if (!previous || touch.impactSpeed > previous.impactSpeed) barrierTouches.set(key, touch);
      }
    }

    // One contact frame for the wedge integrator, worth the hardest push a prop landed this tick. Fed from the
    // BLOCKING response above, never from the debounced report below: a ride-through touch shoves nobody, and a
    // debounce is exactly what a rider grinding against a wall would never trip.
    if (wedgeFrame > 0) wedge += wedgeFrame;
    for (const touch of barrierTouches.values()) {
      // The IMPACT regime, charged ahead of the reporting debounce on purpose: the crack keeps its own
      // 30-frame gate, and letting the slower report interval govern it would under-charge a rider who is
      // repeatedly striking a pane. A hard arrival is worth ~87 against the ~1 of being carried.
      crackedSurfaces?.impact(touch.meta.key, touch.impactSpeed);
      if (rideElapsed < (obstacleHitNext.get(touch.meta.key) ?? 0)) continue;
      obstacleHitNext.set(touch.meta.key, rideElapsed + 50 / 60);
      // Solved BEFORE the optional call, not inside its argument list: `?.` short-circuits the whole argument
      // expression, so inlining this made the rider's own shove response depend on whether anything happened to
      // be listening for prop hits. The impulse is physics; the callback only reports it.
      const shove = shoveMovable(touch);
      o.onObstacleHit?.({
        key: touch.meta.key, object: touch.meta.object,
        point: touch.point.clone(), normal: touch.normal.clone(), impactSpeed: touch.impactSpeed,
        shove,
      });
    }
  }

  /**
   * Lift a body's authored mass properties into world space once, at BVH build time, alongside the shape snapshot.
   * The tensor is model-local and in raw centimetres; the instance matrix carries the rotation, the raw→editor
   * mirror, and the cm→m scale together. An inertia tensor transforms as `R·I·Rᵀ` under any orthogonal map,
   * reflections included, and carries 1/length² besides, so the matrix's own uniform scale divides out of it.
   */
  function worldMassProps(source: RideObstacleSource, matrix = source.matrixWorld):
    { com: THREE.Vector3; invInertia: Float32Array } | null {
    if (!source.body || source.body.invInertia.length < 9) return null;
    const m = matrix.elements;
    const linear = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // row-major 3x3
    const det = linear[0] * (linear[4] * linear[8] - linear[5] * linear[7])
      - linear[1] * (linear[3] * linear[8] - linear[5] * linear[6])
      + linear[2] * (linear[3] * linear[7] - linear[4] * linear[6]);
    const scale = Math.cbrt(Math.abs(det));
    if (!(scale > 1e-12)) return null;
    const r = linear.map(value => value / scale); // orthogonal (possibly improper — a mirror is still valid here)
    const local = source.body.invInertia;
    // world = R · local · Rᵀ, then / scale² for the length units the tensor's inverse carries.
    const invInertia = new Float32Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) sum += r[i * 3 + a] * local[a * 3 + b] * r[j * 3 + b];
      invInertia[i * 3 + j] = sum / (scale * scale);
    }
    const com = new THREE.Vector3(source.body.com[0], source.body.com[1], source.body.com[2])
      .applyMatrix4(matrix);
    return { com, invInertia };
  }

  /** `I⁻¹ · v` for the row-major inverse inertia tensor. */
  function applyInvInertia(invInertia: Float32Array, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return out.set(
      invInertia[0] * v.x + invInertia[1] * v.y + invInertia[2] * v.z,
      invInertia[3] * v.x + invInertia[4] * v.y + invInertia[5] * v.z,
      invInertia[6] * v.x + invInertia[7] * v.y + invInertia[8] * v.z,
    );
  }

  /**
   * The rigid-body shove ([Trailmap: 370-world-interaction]). A Roller-activated instance resolves through a real
   * impulse rather than the static bounce path; the instance's authored restitution is deliberately not read here.
   *
   *   impulse = 1.3 · closingSpeed / (propInverseMass + riderMassTerm + rotationalEffectiveMass)
   *
   * applied along the solved contact normal AT THE CONTACT OFFSET, so the body picks up angular velocity as well
   * as linear. That offset is the whole mechanism: the spec is explicit that there is no hard-coded upward kick
   * and no vertical bias in the impulse direction, and that a struck body's loft instead comes from spinning over
   * its own ground contact. A board meets a standing crash bag well below its centre of mass, so the bag tips as
   * it goes.
   *
   * `rotationalEffectiveMass` is the standard `n · ((I⁻¹(r × n)) × r)`, and its `I⁻¹` is the authored per-body
   * tensor — the term that makes a chunky near-isotropic crash bag shove differently from a thin path marker that
   * spins away about its flag axis. Scalar dynamic mass is supplied by the Roller payload, outside the pool body.
   */
  function shoveMovable(touch: ObstacleTouch): RideObstacleHit['shove'] {
    if (touch.meta.dynamicMass <= 0 || touch.impactSpeed <= MOVABLE_MIN_IMPACT) return null;
    const n = touch.normal;
    const body = touch.meta.body ?? null;
    const invMass = 1 / touch.meta.dynamicMass; // Roller dynamic mass becomes body inverse mass at activation.

    let rotational = 0;
    let offset: THREE.Vector3 | null = null;
    if (body) {
      offset = shoveOffset.copy(touch.point).sub(body.com);
      const rxn = shoveRxN.copy(offset).cross(n);
      rotational = applyInvInertia(body.invInertia, rxn, shoveTmp).cross(offset).dot(n);
      if (!Number.isFinite(rotational) || rotational < 0) rotational = 0;
    }
    const denominator = invMass + RIDER_MASS_TERM + rotational;
    if (!(denominator > 1e-9)) return null;
    const impulse = SHOVE_RESTITUTION * touch.impactSpeed / denominator;

    const riderBefore = tickTrace ? telemetryVec(st.vel) : null;
    // `normal` faces against travel, so advancing the rider ALONG it is what removes the into-prop component.
    st.vel.addScaledVector(n, impulse * RIDER_MASS_TERM);

    // ...and the prop takes the same impulse the other way, along the rider's travel.
    const applied = shoveApplied.copy(n).multiplyScalar(-impulse);
    const angular = body && offset
      ? applyInvInertia(body.invInertia, shoveTmp.copy(offset).cross(applied), new THREE.Vector3())
      : new THREE.Vector3();
    const linear = applied.clone().multiplyScalar(invMass);
    // Pushed directly rather than through recordBarrierEvent: that one keeps only the nearest of its kind per
    // tick, and two different props shoved in one tick are two separate events, not a closer read of one.
    if (tickTrace) tickTrace.events.push({
      type: 'prop-shove', key: touch.meta.key, hasBody: !!body,
      closingSpeed: touch.impactSpeed, rotational, impulse, denominator,
      offset: telemetryVec(offset ?? shoveZero), normal: telemetryVec(n),
      propLinear: telemetryVec(linear), propAngular: telemetryVec(angular),
      riderVelocityBefore: riderBefore!, riderVelocityAfter: telemetryVec(st.vel),
    });
    return {
      linear, angular,
      body: body ? { invInertia: body.invInertia, com: body.com.clone(), invMass } : null,
    };
  }

  /** Lower-bound distance from a ray origin to a BVH node. Used to visit near nodes first and prune nodes that
   * cannot beat the nearest valid hit without materializing an all-hit array. */
  function rayBoxEntryDistance(ray: THREE.Ray, box: THREE.Box3, scratch: THREE.Vector3): number {
    if (box.containsPoint(ray.origin)) return 0;
    const hit = ray.intersectBox(box, scratch);
    return hit ? hit.distanceTo(ray.origin) : Infinity;
  }

  /** Return the first wall/ceiling hit on a body sample. Unlike castSeg this examines all intersections, because
   * a sample near the deck may touch a floor first and still encounter a wall later in the same fast tick. */
  function castTerrainBarrier(from: THREE.Vector3, to: THREE.Vector3, motion: THREE.Vector3): { distance: number; normal: THREE.Vector3 } | null {
    const t = performance.now();
    const worldFar = from.distanceTo(to);
    const a = from.clone().applyMatrix4(toLocal), b = to.clone().applyMatrix4(toLocal);
    const far = a.distanceTo(b);
    if (far < 1e-9) return null;
    localRay.origin.copy(a);
    localRay.direction.copy(b).sub(a).divideScalar(far);
    let earliest: { localDistance: number; distance: number; normal: THREE.Vector3 } | null = null;
    const deferred = tickTrace ? [] as { localDistance: number; distance: number; normal: THREE.Vector3 }[] : null;
    bvh.shapecast({
      boundsTraverseOrder: box => rayBoxEntryDistance(localRay, box, localRayBoxHit),
      intersectsBounds: (_box, _isLeaf, score) =>
        score !== undefined && score <= far && score <= (earliest?.localDistance ?? far)
          ? INTERSECTED : NOT_INTERSECTED,
      intersectsTriangle: (triangle, faceIndex) => {
        const hit = localRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, localRayHit);
        if (!hit) return false;
        const localDistance = hit.distanceTo(a);
        if (localDistance < 1e-5 || localDistance > far) return false;
        const { normal, leaving } = barrierNormal(faceIndex, hit, motion);
        if (normal.dot(motion) >= -1e-6) return false;
        const distance = Math.min(worldFar, from.distanceTo(terrainWorldHit.copy(hit).applyMatrix4(toWorld)));
        // The Unity obstacle sweep always leaves an up-facing hit to the ride probe. Gating this on world-down
        // movement made a board travelling laterally into a kicker treat its 0.94-up normal as a wall and
        // ricochet into flight. A leaving facet uses |y| so exiting a floor is not misread as a roof.
        if ((leaving ? Math.abs(normal.y) : normal.y) > WALL_NY) {
          deferred?.push({ localDistance, distance, normal });
          return false;
        }
        if (localDistance < (earliest?.localDistance ?? Infinity))
          earliest = { localDistance, distance, normal };
        return false;
      },
    });
    perf.castAccum += performance.now() - t;
    // TypeScript does not follow assignments made from the synchronous shapecast callback.
    const result = earliest as { localDistance: number; distance: number; normal: THREE.Vector3 } | null;
    if (deferred) {
      deferred.sort((x, y) => x.localDistance - y.localDistance);
      for (const floor of deferred) {
        if (result && floor.localDistance > result.localDistance) break;
        recordBarrierEvent({
          type: 'floor-crossing-deferred', distance: floor.distance, normal: telemetryVec(floor.normal),
        });
      }
    }
    return result ? { distance: result.distance, normal: result.normal } : null;
  }

  /**
   * Nearest zero-thickness segment hit among the native boxes — the slab test a native LINE query runs against
   * a mode-2 instance. This is the right shape for the camera occlusion ray and for the rideable-surface stab,
   * both of which are line probes; the RIDER's own box contact is the body sphere in `castBoxObstacleBarrier`,
   * which is a different law ([Trailmap: 370-probe-modes]).
   */
  function castBoxRay(from: THREE.Vector3, to: THREE.Vector3, accept: (meta: ObstacleMeta) => boolean):
    { distance: number; point: THREE.Vector3; normal: THREE.Vector3; meta: ObstacleMeta } | null {
    if (!obstacleBoxes.length) return null;
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    let best: { distance: number; point: THREE.Vector3; normal: THREE.Vector3; meta: ObstacleMeta } | null = null;
    for (const box of obstacleBoxes) {
      if (!box.meta.enabled || !accept(box.meta)) continue;
      // The collider is oriented with its placement, so the segment goes into the box's own frame first.
      boxLocalFrom.copy(from).applyMatrix4(box.toLocal);
      boxLocalTo.copy(to).applyMatrix4(box.toLocal);
      let near = 0, farT = 1, axis = -1, sign = 0;
      let missed = false;
      for (let k = 0; k < 3 && !missed; k++) {
        const component = k === 0 ? 'x' : k === 1 ? 'y' : 'z';
        const origin = boxLocalFrom[component], delta = boxLocalTo[component] - boxLocalFrom[component];
        const lo = box.localMin[component], hi = box.localMax[component];
        if (Math.abs(delta) < 1e-12) { if (origin < lo || origin > hi) missed = true; continue; }
        let t0 = (lo - origin) / delta, t1 = (hi - origin) / delta;
        let entering = -1;
        if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; entering = 1; }
        if (t0 > near) { near = t0; axis = k; sign = entering; }
        if (t1 < farT) farT = t1;
        if (near > farT) missed = true;
      }
      if (missed || near > farT || near > 1) continue;
      const distance = far * near;
      if (best && distance >= best.distance) continue;
      const normal = new THREE.Vector3();
      if (axis >= 0) normal.setComponent(axis, sign).applyNormalMatrix(box.normalMatrix).normalize();
      else normal.copy(to).sub(from).normalize().negate(); // started inside: face the probe
      best = {
        distance, normal,
        point: new THREE.Vector3().copy(to).sub(from).multiplyScalar(near).add(from),
        meta: box.meta,
      };
    }
    return best;
  }

  /** Prop counterpart to the terrain barrier cast. Ride-through geometry reports an exact touch and is skipped;
   * solid geometry becomes the collide-and-slide plane. An upward face with a surface type is likewise reported
   * and skipped here because the ordinary contact probe owns riding on it. */
  function castMeshObstacleBarrier(from: THREE.Vector3, to: THREE.Vector3, motion: THREE.Vector3,
    touches: Map<string, ObstacleTouch>, reportSensors = true): {
      distance: number; normal: THREE.Vector3; meta: ObstacleMeta;
    } | null {
    if (!obstacleBVH || !obstaclePos) return null;
    const t = performance.now();
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    obstacleRay.origin.copy(from);
    obstacleRay.direction.copy(to).sub(from).divideScalar(far);
    let earliest: { distance: number; normal: THREE.Vector3; meta: ObstacleMeta } | null = null;
    barrierMeshTouches.clear();
    // Keep the nearest VALID plane while traversing near-to-far. The former raycast allocated and sorted every
    // intersected face for each of 13 body samples (and again for slide iterations) before metadata could reject
    // triggers, Rollers or rideable floor faces.
    obstacleBVH.shapecast({
      boundsTraverseOrder: box => rayBoxEntryDistance(obstacleRay, box, obstacleRayBoxHit),
      intersectsBounds: (_box, _isLeaf, score) =>
        score !== undefined && score <= far && score <= (earliest?.distance ?? far)
          ? INTERSECTED : NOT_INTERSECTED,
      intersectsTriangle: (triangle, faceIndex) => {
        const meta = obstacleMetas[obstacleFaceMeta[faceIndex]];
        if (!meta?.enabled) return false;
        const hit = obstacleRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, obstacleRayHit);
        if (!hit) return false;
        const distance = hit.distanceTo(from);
        if (distance < 1e-5 || distance > far) return false;
        triangle.getNormal(obstacleNormal);
        if (obstacleNormal.lengthSq() < 1e-12) return false;
        // Prop meshes are a two-sided practical collider. Face the plane against travel so mixed source winding
        // and the reference world's chirality mirror cannot turn a visible fence into a one-way wall.
        const leaving = obstacleNormal.dot(motion) > 0;
        if (leaving) obstacleNormal.negate();
        if (obstacleNormal.dot(motion) >= -1e-6) return false;
        const impactSpeed = Math.max(0, -st.vel.dot(obstacleNormal));
        if (reportSensors || meta.solid) {
          const previous = barrierMeshTouches.get(meta.key);
          if (!previous || distance < previous.distance) barrierMeshTouches.set(meta.key, {
            meta, point: hit.clone(), normal: obstacleNormal.clone(), impactSpeed, distance,
          });
        }
        if (!meta.solid || meta.dynamicMass > 0) return false;
        // The contact probe owns a rideable near-horizontal face. Which side was crossed cannot turn its top
        // into a roof, but near-vertical faces retain the two-sided flip above.
        if (obstacleIsProbeReadable(meta)
          && (leaving ? Math.abs(obstacleNormal.y) : obstacleNormal.y) > WALL_NY) return false;
        if (distance < (earliest?.distance ?? Infinity))
          earliest = { distance, normal: obstacleNormal.clone(), meta };
        return false;
      },
    });
    perf.castAccum += performance.now() - t;
    // TypeScript does not follow assignments made from the synchronous shapecast callback.
    const result = earliest as { distance: number; normal: THREE.Vector3; meta: ObstacleMeta } | null;
    const reached = result?.distance ?? far;
    for (const [key, touch] of barrierMeshTouches) {
      if (touch.distance > reached) continue;
      const previous = touches.get(key);
      if (!previous || touch.distance < previous.distance) touches.set(key, touch);
    }
    return result;
  }

  /** Analytic segment-vs-native-sphere-tree contact. The segment is transformed into body-local space, so an
   * affine instance transform (including non-uniform scale) naturally turns the leaves into exact ellipsoids;
   * the segment parameter remains valid in world space and normals return through the inverse transpose. */
  function castSphereObstacleBarrier(from: THREE.Vector3, to: THREE.Vector3, motion: THREE.Vector3,
    touches: Map<string, ObstacleTouch>, reportSensors = true): {
      distance: number; normal: THREE.Vector3; meta: ObstacleMeta;
    } | null {
    if (!obstacleSphereBodies.length) return null;
    const started = performance.now();
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    let earliest: { distance: number; normal: THREE.Vector3; meta: ObstacleMeta } | null = null;
    for (const body of obstacleSphereBodies) {
      if (!body.meta.enabled || !body.reachedByBody) continue;
      if (body.bound.distanceToPoint(from) > far + RIDER_BARRIER_PAD) continue;
      sphereLocalFrom.copy(from).applyMatrix4(body.toLocal);
      sphereLocalTo.copy(to).applyMatrix4(body.toLocal);
      sphereLocalDir.copy(sphereLocalTo).sub(sphereLocalFrom);
      const aa = sphereLocalDir.lengthSq();
      if (aa < 1e-16) continue;
      const leaves = body.spheres;
      let candidateCount = 0;
      for (let i = 0; i + 3 < leaves.length; i += 4) {
        const cx = leaves[i], cy = leaves[i + 1], cz = leaves[i + 2], r = Math.max(0, leaves[i + 3]);
        const mx = sphereLocalFrom.x - cx, my = sphereLocalFrom.y - cy, mz = sphereLocalFrom.z - cz;
        const bb = 2 * (mx * sphereLocalDir.x + my * sphereLocalDir.y + mz * sphereLocalDir.z);
        const cc = mx * mx + my * my + mz * mz - r * r;
        const disc = bb * bb - 4 * aa * cc;
        if (disc < 0) continue;
        const root = Math.sqrt(disc), inv = 1 / (2 * aa);
        const enter = (-bb - root) * inv, exit = (-bb + root) * inv;
        const u = enter >= 1e-6 ? enter : exit >= 1e-6 ? exit : -1;
        if (u < 0 || u > 1) continue;
        const candidate = sphereHitCandidatePool[candidateCount]
          ?? (sphereHitCandidatePool[candidateCount] = { u: 0, index: 0 });
        candidate.u = u; candidate.index = i; candidateCount++;
        sphereHitCandidates[candidateCount - 1] = candidate;
      }
      // Geometric order is the useful order: normally the first entry supplies both touch and barrier, so the
      // O(leaves) union-normal calculation runs once. Starting inside a leaf yields an EXIT normal; a rideable
      // up-face may likewise defer to the ground probe, so keep walking ordered candidates until one is valid.
      sphereHitCandidates.length = candidateCount;
      sphereHitCandidates.sort((a, b) => a.u - b.u || a.index - b.index);
      let foundTouch = false;
      const canBlock = body.meta.solid && body.meta.dynamicMass <= 0;
      for (const candidate of sphereHitCandidates) {
        sphereLocalHit.copy(sphereLocalDir).multiplyScalar(candidate.u).add(sphereLocalFrom);
        unionLeafNormal(leaves, sphereLocalHit, candidate.index, sphereLocalNormal);
        if (sphereLocalNormal.lengthSq() < 1e-16) continue;
        sphereWorldNormal.copy(sphereLocalNormal).applyNormalMatrix(body.normalMatrix).normalize();
        if (sphereWorldNormal.dot(motion) >= -1e-6) continue; // exiting/tangent, not an impact
        sphereWorldPoint.copy(sphereLocalHit).applyMatrix4(body.matrixWorld);
        const distance = far * candidate.u;
        const impactSpeed = Math.max(0, -st.vel.dot(sphereWorldNormal));
        if (!foundTouch && (reportSensors || body.meta.solid)) {
          const previous = touches.get(body.meta.key);
          if (!previous || distance < previous.distance) touches.set(body.meta.key, {
            meta: body.meta, point: sphereWorldPoint.clone(), normal: sphereWorldNormal.clone(), impactSpeed, distance,
          });
          foundTouch = true;
        }
        // Response eligibility is body-wide. Once its nearest incoming touch is known, a ride-through or Roller
        // body cannot produce a later blocking candidate. A static rideable body can: skip an up-face owned by
        // the contact probe but retain a later wall/underside hit from the same sphere union.
        if (!canBlock) break;
        if (obstacleIsProbeReadable(body.meta) && sphereWorldNormal.y > WALL_NY) continue;
        if (!earliest || distance < earliest.distance)
          earliest = { distance, normal: sphereWorldNormal.clone(), meta: body.meta };
        break;
      }
    }
    perf.castAccum += performance.now() - started;
    return earliest;
  }

  function castObstacleBarrier(from: THREE.Vector3, to: THREE.Vector3, motion: THREE.Vector3,
    touches: Map<string, ObstacleTouch>, reportSensors = true): {
      distance: number; normal: THREE.Vector3; meta: ObstacleMeta;
    } | null {
    const mesh = castMeshObstacleBarrier(from, to, motion, touches, reportSensors);
    const spheres = castSphereObstacleBarrier(from, to, motion, touches, reportSensors);
    if (!mesh) return spheres;
    if (!spheres) return mesh;
    return mesh.distance <= spheres.distance ? mesh : spheres;
  }

  /**
   * The native mode-3 gate, run once per collide-and-slide iteration. A physics body is only *considered* when
   * the rider's body sphere reaches it; a miss rejects the whole contact before any limb is tested
   * ([Trailmap: 370-probe-modes]). That is what lets a rider clear a low member their deck passes through, and
   * it is why gateway bodies read as hollow to the torso rather than to the board.
   *
   * The test is deliberately conservative — the segment against each leaf grown by the body sphere's radius —
   * so it can only ever let a body through to the real per-sample sweep, never invent a contact.
   */
  function gateSphereBodiesByBodySphere(previousPos: THREE.Vector3, nextPos: THREE.Vector3, up: THREE.Vector3) {
    if (!obstacleSphereBodies.length) return;
    riderBodyCentre(previousPos, up, bodySphereFrom);
    riderBodyCentre(nextPos, up, bodySphereTo);
    const far = bodySphereFrom.distanceTo(bodySphereTo);
    for (const body of obstacleSphereBodies) {
      body.reachedByBody = false;
      if (!body.meta.enabled) continue;
      if (body.bound.distanceToPoint(bodySphereFrom) > far + RIDER_BODY_R + RIDER_BARRIER_PAD) continue;
      sphereLocalFrom.copy(bodySphereFrom).applyMatrix4(body.toLocal);
      sphereLocalTo.copy(bodySphereTo).applyMatrix4(body.toLocal);
      sphereLocalDir.copy(sphereLocalTo).sub(sphereLocalFrom);
      const aa = sphereLocalDir.lengthSq();
      const leaves = body.spheres;
      for (let i = 0; i + 3 < leaves.length && !body.reachedByBody; i += 4) {
        const cx = leaves[i], cy = leaves[i + 1], cz = leaves[i + 2];
        const r = Math.max(0, leaves[i + 3]) + body.localBodyRadius;
        const mx = sphereLocalFrom.x - cx, my = sphereLocalFrom.y - cy, mz = sphereLocalFrom.z - cz;
        const cc = mx * mx + my * my + mz * mz - r * r;
        if (cc <= 0) { body.reachedByBody = true; break; } // already overlapping at the start of the move
        if (aa < 1e-16) continue;
        const bb = 2 * (mx * sphereLocalDir.x + my * sphereLocalDir.y + mz * sphereLocalDir.z);
        const disc = bb * bb - 4 * aa * cc;
        if (disc < 0) continue;
        const enter = (-bb - Math.sqrt(disc)) / (2 * aa);
        if (enter >= 0 && enter <= 1) body.reachedByBody = true;
      }
    }
  }

  /**
   * Native mode-2 contact and its response, run ONCE for the whole rider after the movement solve.
   *
   * Two things are ported here and the second is the one that decides how a prop FEELS. The engine answers a
   * bounding-box prop with the rider's body sphere and nothing else — the deck, the shoulders and the head have
   * no say ([Trailmap: 370-probe-modes]) — and it does **not clip the rider's movement** against the box. It
   * lets the move happen, tests statically at the new pose, and pushes the rider back out along the contact
   * normal by 1.1x the reported penetration before touching velocity ([Trailmap: 370-depenetrate]). Clipping
   * instead is what makes a grazing corner read as catching on something, and what leaves a rider stuck inside
   * a shape they are already within — so boxes resolve here rather than inside the collide-and-slide loop.
   *
   * The one deliberate departure is an anti-tunnel guard. The engine tests statically once per 60 Hz tick and a
   * fast enough rider crosses a thin box between two of them. The swept entry is kept, so a box crossed
   * entirely within one tick still reports its contact and still resolves — from the entry pose rather than
   * from a pose already out the far side.
   *
   * Returns this tick's wedge contribution, which only the caller can fold into its own accumulator.
   */
  function resolveBoxContacts(previousPos: THREE.Vector3, position: THREE.Vector3, up: THREE.Vector3,
    touches: Map<string, ObstacleTouch>): number {
    if (!obstacleBoxes.length) return 0;
    const started = performance.now();
    boxEnd.copy(position);
    riderBodyCentre(previousPos, up, bodySphereFrom);
    riderBodyCentre(boxEnd, up, bodySphereTo);
    const far = bodySphereFrom.distanceTo(bodySphereTo);
    // The engine responds to ONE contact per probe. Every touch is still reported, so the sound and effect
    // graphs see each prop brushed past, but only the first one met is resolved.
    let first: { u: number; box: ObstacleBox } | null = null;
    for (const box of obstacleBoxes) {
      if (!box.meta.enabled) continue;
      if (box.bound.distanceToPoint(bodySphereFrom) > far) continue;
      // Into the model's own frame, where the collider is an ordinary axis-aligned box.
      boxLocalFrom.copy(bodySphereFrom).applyMatrix4(box.toLocal);
      boxLocalTo.copy(bodySphereTo).applyMatrix4(box.toLocal);
      const swept = sweptSphereVsNativeBox(box.localMin, box.localMax, boxLocalFrom, boxLocalTo, box.localRadius);
      if (!swept) continue;
      boxNormal.set(swept.contact.normal.x, swept.contact.normal.y, swept.contact.normal.z)
        .applyNormalMatrix(box.normalMatrix).normalize();
      boxPoint.set(swept.contact.point.x, swept.contact.point.y, swept.contact.point.z)
        .applyMatrix4(box.matrixWorld);
      const distance = far * swept.u;
      const previous = touches.get(box.meta.key);
      if (!previous || distance < previous.distance) touches.set(box.meta.key, {
        meta: box.meta, point: boxPoint.clone(), normal: boxNormal.clone(),
        impactSpeed: Math.max(0, -st.vel.dot(boxNormal)), distance,
      });
      if (!box.meta.solid || box.meta.dynamicMass > 0) continue;
      // A rideable box's up-face belongs to the contact probe, exactly as it does for a proxy mesh or a body.
      if (obstacleIsProbeReadable(box.meta) && boxNormal.y > WALL_NY) continue;
      if (!first || swept.u < first.u) first = { u: swept.u, box };
    }
    perf.castAccum += performance.now() - started;
    if (!first) return 0;

    const box = first.box;
    riderBodyCentre(boxEnd, up, bodySphereTo);
    boxLocalTo.copy(bodySphereTo).applyMatrix4(box.toLocal);
    let resolved = sphereVsNativeBox(box.localMin, box.localMax, boxLocalTo, box.localRadius);
    if (!resolved) {
      // Crossed clean through inside one tick. Set the rider down at the entry parameter — where a 60 Hz engine
      // tick would have caught them — and resolve there rather than let the crossing go unanswered.
      position.lerpVectors(previousPos, boxEnd, first.u);
      riderBodyCentre(position, up, bodySphereTo);
      boxLocalTo.copy(bodySphereTo).applyMatrix4(box.toLocal);
      resolved = sphereVsNativeBox(box.localMin, box.localMax, boxLocalTo, box.localRadius);
      if (!resolved) return 0;
    }
    // The push-out is a DISPLACEMENT in the box's own frame, so it comes back to world through the linear
    // part of the placement rather than through a normal matrix or a single scale factor — those are right for
    // a direction and for a uniform scale respectively, and wrong for the general case.
    boxPush.set(resolved.normal.x, resolved.normal.y, resolved.normal.z)
      .multiplyScalar(NATIVE_DEPENETRATION * resolved.depth).applyMatrix3(box.linear);
    position.add(boxPush);
    boxNormal.copy(boxPush).normalize();

    const velocityBefore = tickTrace ? telemetryVec(st.vel) : null;
    const into = st.vel.dot(boxNormal);
    let wedge = 0;
    if (into < 0) {
      const bounceDelta = -into * (1 + box.meta.bounce);
      st.vel.addScaledVector(boxNormal, box.meta.playerBounce
        ? Math.max(bounceDelta, -into + PROP_BOUNCE_EJECT_FLOOR)
        : bounceDelta);
      wedge = wedgeContribution(boxNormal);
    }
    if (tickTrace) recordBarrierEvent({
      type: 'barrier-resolved', distance: far * first.u, normal: telemetryVec(boxNormal),
      velocityBefore: velocityBefore!, velocityAfter: telemetryVec(st.vel),
    });
    return wedge;
  }

  /** Camera counterpart to the terrain segment query. Only solid native collision geometry blocks the view;
   * ride-through foliage remains transparent to the camera just as it is to the rider. Mesh proxies and native
   * sphere trees share one nearest-hit result in WORLD space so the camera can compare it directly with terrain. */
  function castCameraObstacle(from: THREE.Vector3, to: THREE.Vector3): {
    point: THREE.Vector3; normal: THREE.Vector3; key: string;
  } | null {
    const started = performance.now();
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    const motion = cameraObstacleMotion.copy(to).sub(from);
    type CameraObstacleHit = { point: THREE.Vector3; normal: THREE.Vector3; key: string; distance: number };
    let earliest: CameraObstacleHit | null = null;

    if (obstacleBVH && obstaclePos) {
      obstacleRay.origin.copy(from);
      obstacleRay.direction.copy(motion).divideScalar(far);
      let meshEarliest: CameraObstacleHit | null = null;
      obstacleBVH.shapecast({
        boundsTraverseOrder: box => rayBoxEntryDistance(obstacleRay, box, obstacleRayBoxHit),
        intersectsBounds: (_box, _isLeaf, score) =>
          score !== undefined && score <= far && score <= (meshEarliest?.distance ?? far)
            ? INTERSECTED : NOT_INTERSECTED,
        intersectsTriangle: (triangle, faceIndex) => {
          const meta = obstacleMetas[obstacleFaceMeta[faceIndex]];
          // A shoveable body is transparent to the camera for the same reason foliage is: the rider passes clean
          // through it, so the view must too. A launch-time ghost collider must not pull the camera after a shove.
          if (!meta?.enabled || !meta.solid || meta.dynamicMass > 0) return false;
          const hit = obstacleRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, obstacleRayHit);
          if (!hit) return false;
          const distance = hit.distanceTo(from);
          if (distance < 1e-5 || distance > far || distance >= (meshEarliest?.distance ?? Infinity)) return false;
          triangle.getNormal(obstacleNormal);
          if (obstacleNormal.lengthSq() < 1e-12) return false;
          if (obstacleNormal.dot(motion) > 0) obstacleNormal.negate();
          meshEarliest = {
            point: hit.clone(), normal: obstacleNormal.clone(), key: meta.key, distance,
          };
          return false;
        },
      });
      earliest = meshEarliest as CameraObstacleHit | null;
    }

    for (const body of obstacleSphereBodies) {
      // Movable bodies are excluded for the same reasons as the mesh path above — and the crash bags whose
      // ghost colliders were caught shoving the camera are exactly these mode-3 sphere trees.
      if (!body.meta.enabled || !body.meta.solid || body.meta.dynamicMass > 0
        || body.bound.distanceToPoint(from) > far) continue;
      sphereLocalFrom.copy(from).applyMatrix4(body.toLocal);
      sphereLocalTo.copy(to).applyMatrix4(body.toLocal);
      sphereLocalDir.copy(sphereLocalTo).sub(sphereLocalFrom);
      const aa = sphereLocalDir.lengthSq();
      if (aa < 1e-16) continue;
      const leaves = body.spheres;
      for (let i = 0; i + 3 < leaves.length; i += 4) {
        const cx = leaves[i], cy = leaves[i + 1], cz = leaves[i + 2], r = Math.max(0, leaves[i + 3]);
        const mx = sphereLocalFrom.x - cx, my = sphereLocalFrom.y - cy, mz = sphereLocalFrom.z - cz;
        const bb = 2 * (mx * sphereLocalDir.x + my * sphereLocalDir.y + mz * sphereLocalDir.z);
        const cc = mx * mx + my * my + mz * mz - r * r;
        const disc = bb * bb - 4 * aa * cc;
        if (disc < 0) continue;
        const root = Math.sqrt(disc), inv = 1 / (2 * aa);
        const enter = (-bb - root) * inv, exit = (-bb + root) * inv;
        const u = enter >= 1e-6 ? enter : exit >= 1e-6 ? exit : -1;
        if (u < 0 || u > 1) continue;
        const distance = far * u;
        if (earliest && distance >= earliest.distance) continue;
        sphereLocalHit.copy(sphereLocalDir).multiplyScalar(u).add(sphereLocalFrom);
        sphereLocalNormal.set(sphereLocalHit.x - cx, sphereLocalHit.y - cy, sphereLocalHit.z - cz);
        if (sphereLocalNormal.lengthSq() < 1e-16) continue;
        const normal = sphereLocalNormal.clone().applyNormalMatrix(body.normalMatrix).normalize();
        if (normal.dot(motion) > 0) normal.negate();
        earliest = {
          point: sphereLocalHit.clone().applyMatrix4(body.matrixWorld),
          normal, key: body.meta.key, distance,
        };
      }
    }
    const boxHit = castBoxRay(from, to,
      meta => meta.solid && meta.dynamicMass <= 0);
    if (boxHit && (!earliest || boxHit.distance < earliest.distance)) {
      if (boxHit.normal.dot(motion) > 0) boxHit.normal.negate();
      earliest = { point: boxHit.point, normal: boxHit.normal, key: boxHit.meta.key, distance: boxHit.distance };
    }

    perf.castAccum += performance.now() - started;
    return earliest ? { point: earliest.point, normal: earliest.normal, key: earliest.key } : null;
  }

  /** Collision normal at a BVH hit, using analytic patch contact where available and the triangle facet
   * otherwise. A fallback facet is faced against `motion`, so removing a negative velocity component always
   * pushes inward. The analytic patch normal keeps its authored sign: a crossing from the BACK face then reads
   * as motion WITH the normal and the caller's into-the-face test skips it — a flipped wall is no wall, the
   * same one-sided law the ground probe applies.
   *
   * `leaving` reports that the FACET branch had to flip, i.e. the sample crossed the face along its own outward
   * side and therefore started inside the surface. The caller needs it to keep classifying floors by the side
   * the geometry says is solid; the analytic branch never flips, so it never sets it. */
  function barrierNormal(faceIndex: number, localPoint: THREE.Vector3, motion: THREE.Vector3):
    { normal: THREE.Vector3; leaving: boolean } {
    let normal: THREE.Vector3 | null = null;
    let analytic = false;
    if (o.patchContact && baryOf(faceIndex, localPoint, baryTmp)
        && o.patchContact(faceIndex, baryTmp, patchP, patchN)) {
      normal = patchN.clone().applyMatrix3(normalMat).normalize();
      analytic = true;
    }
    if (!normal) {
      const i = faceIndex * 3;
      if (geoIndex && i + 2 < geoIndex.length) {
        triA.fromBufferAttribute(geoPos, geoIndex[i]);
        triB.fromBufferAttribute(geoPos, geoIndex[i + 1]);
        triC.fromBufferAttribute(geoPos, geoIndex[i + 2]);
        normal = triB.clone().sub(triA).cross(triC.clone().sub(triA))
          .applyMatrix3(normalMat).normalize();
      } else normal = WORLD_UP.clone().negate();
    }
    const leaving = !analytic && normal.dot(motion) > 0;
    if (leaving) normal.negate();
    return { normal, leaving };
  }

  /** Barycentric weights of a LOCAL-space hit point within its face. False if the face is degenerate. */
  function baryOf(faceIndex: number, local: THREE.Vector3, out: THREE.Vector3): boolean {
    const i = faceIndex * 3;
    if (!geoIndex || i + 2 >= geoIndex.length) return false;
    triA.fromBufferAttribute(geoPos, geoIndex[i]);
    triB.fromBufferAttribute(geoPos, geoIndex[i + 1]);
    triC.fromBufferAttribute(geoPos, geoIndex[i + 2]);
    return THREE.Triangle.getBarycoord(local, triA, triB, triC, out) !== null;
  }

  /**
   * Refine the coarse triangle hit into the actual intersection of this probe segment and its bicubic patch.
   * The tessellated hit only seeds two barycentric surface coordinates. Solving
   * `patch(bx, by) = rayOrigin + rayDirection*t` in all three axes is essential on a normal-aimed probe: merely
   * evaluating the patch at the triangle seed can return a smooth point a metre sideways from the ray on a tight
   * Snowdream lip, which is not contact at all. Patch derivatives are finite differences in the seed triangle's
   * affine parameterization; the callback's exact patch normal is retained for the final response basis.
   */
  function refinePatchRay(
    faceIndex: number, seed: THREE.Vector3, rayOrigin: THREE.Vector3, rayDirection: THREE.Vector3, far: number,
  ): boolean {
    if (!o.patchContact) return false;
    patchSeed.copy(seed);
    if (!o.patchContact(faceIndex, patchSeed, patchP, patchN)) return false;
    let rayT = patchResidual.copy(patchP).sub(rayOrigin).dot(rayDirection);
    const eps = 1e-4;
    for (let iteration = 0; iteration < 8; iteration++) {
      patchResidual.copy(patchP).sub(rayOrigin).addScaledVector(rayDirection, -rayT);
      if (patchResidual.lengthSq() < 1e-10) break;

      baryTmp.set(patchSeed.x + eps, patchSeed.y, patchSeed.z - eps);
      if (!o.patchContact(faceIndex, baryTmp, patchDxP, patchTmpN)) return false;
      baryTmp.set(patchSeed.x, patchSeed.y + eps, patchSeed.z - eps);
      if (!o.patchContact(faceIndex, baryTmp, patchDyP, patchTmpN)) return false;
      patchDx.copy(patchDxP).sub(patchP).multiplyScalar(1 / eps);
      patchDy.copy(patchDyP).sub(patchP).multiplyScalar(1 / eps);
      patchJacobian.set(
        patchDx.x, patchDy.x, -rayDirection.x,
        patchDx.y, patchDy.y, -rayDirection.y,
        patchDx.z, patchDy.z, -rayDirection.z,
      );
      if (Math.abs(patchJacobian.determinant()) < 1e-10) return false;
      patchStep.copy(patchResidual).multiplyScalar(-1).applyMatrix3(patchInverse.copy(patchJacobian).invert());
      if (![patchStep.x, patchStep.y, patchStep.z].every(Number.isFinite)) return false;
      const uvStep = Math.max(Math.abs(patchStep.x), Math.abs(patchStep.y));
      if (uvStep > 0.5) patchStep.multiplyScalar(0.5 / uvStep);
      patchSeed.x += patchStep.x;
      patchSeed.y += patchStep.y;
      patchSeed.z = 1 - patchSeed.x - patchSeed.y;
      rayT += patchStep.z;
      if (!o.patchContact(faceIndex, patchSeed, patchP, patchN)) return false;
    }
    patchResidual.copy(patchP).sub(rayOrigin).addScaledVector(rayDirection, -rayT);
    const nearbySeed = patchSeed.x >= -0.5 && patchSeed.y >= -0.5 && patchSeed.z >= -0.5
      && patchSeed.x <= 1.5 && patchSeed.y <= 1.5 && patchSeed.z <= 1.5;
    return patchResidual.lengthSq() < 1e-6 && rayT >= -1e-4 && rayT <= far + 1e-4 && nearbySeed;
  }

  /**
   * Closest point on the terrain to `base` — the seam-recovery discovery for a contact-ray miss on a steep face.
   * The BVH answers closest-point directly (a raycast cannot); the returned face then takes the SAME analytic
   * patch refine the ray path takes, so analytic terrain recovers onto the true surface and a fallback mesh
   * onto its facet's plane (flat is fine for the few bridged ticks). A fallback facet's normal is oriented
   * toward the deck — a wall's is nowhere near skyward, and the facet carries no authored side. The analytic
   * patch normal keeps its authored sign instead: a deck on a patch's BACK side has genuinely lost the
   * surface, and recovery must not stick it to a face the one-sided contact would fall through.
   */
  function closestContact(base: THREE.Vector3): Probe | null {
    const t = performance.now();
    const local = base.clone().applyMatrix4(toLocal);
    const hit = bvh.closestPointToPoint(local, { point: new THREE.Vector3(), distance: 0, faceIndex: 0 }, 0, 4);
    perf.castAccum += performance.now() - t;
    if (!hit) return null;
    const surf = o.surfaceOf(hit.faceIndex) ?? 1;
    if (!baryOf(hit.faceIndex, hit.point, baryTmp)) return null; // also loads triA/B/C for the flat plane
    let point: THREE.Vector3, n: THREE.Vector3, analytic = false;
    if (o.patchContact && o.patchContact(hit.faceIndex, baryTmp, patchP, patchN)) {
      point = patchP.applyMatrix4(toWorld).clone();
      n = patchN.applyMatrix3(normalMat).normalize().clone();
      analytic = true;
    } else {
      point = hit.point.applyMatrix4(toWorld).clone();
      n = triB.clone().sub(triA).cross(triC.clone().sub(triA))
        .applyMatrix3(normalMat).normalize();
    }
    if (point.distanceToSquared(base) > 16) return null;  // implausibly far — lost the surface, no fake contact
    if (base.clone().sub(point).dot(n) < 0) {
      if (analytic) return null; // the deck is behind the ridable side — no fake contact on a back face
      n.negate();                // fallback facet: face the deck, like the probe normals
    }
    return { found: true, point, n, surf };
  }

  /**
   * The contact under the deck reference: one segment along the CACHED contact normal, from `PROBE_ABOVE` above
   * the base to `PROBE_BELOW` below it ([Trailmap: 320]). Aiming the next probe along the last normal is how the
   * engine keeps contact continuous on a curved surface without any temporal filtering, and the segment's reach
   * below the deck *is* the ground/air band — a miss means airborne, and nothing else decides.
   *
   * ANALYTIC path (authored and extracted-reference terrain): the collision mesh is a res×res tessellation of
   * each bicubic patch (PREVIEW_RES for authored, the snowknife bake for reference), and a facet
   * is a chord UNDER the arc. Reading contact off it drops the deck into the sag mid-facet and pops it back at
   * every vertex — 6–16 cm at 4–8 Hz on a 20 m cell, against a 0.11 m deck, on terrain that is perfectly smooth.
   * The engine never rode facets. The triangle hit seeds a Newton solve of patch(u,v) = ray(t), giving the actual
   * point on this probe plus the exact normal. The whole class of artifact — sag, off-ray contact, and facet-edge
   * normal steps that spike the response — is simply not there. It is also cheaper than extra terrain casts: the
   * solve is patch arithmetic, and the exact normal replaces four central-difference rays.
   *
   * FACETED fallback (no control net): a central difference across the contact plane, low-passed downstream —
   * the compensation `320` explicitly allows a faceted reimplementation.
   *
   * ONE-SIDED (analytic terrain): the engine's contact acts along the patch's parametric normal treated as
   * outward — the spring, the pushout and the redirect all read `∂P/∂u × ∂P/∂v` ([Trailmap: 320]), so a patch
   * supplies ground to one side only and a deck on its back side falls through. The analytic path therefore
   * keeps `patchNormal`'s authored sign (the ridable side, the same side the viewport tints magenta from
   * behind) and marches the segment's hits in order, taking the first whose ridable side faces the approach;
   * a back-face crossing is simply not ground. The faceted fallback stays two-sided because a triangle mesh with
   * no patch data carries no authored analytic side to respect.
   */
  function probe(base: THREE.Vector3, aim: THREE.Vector3, allowUntypedObstacle = false): Probe {
    const n0 = aim.lengthSq() > 1e-6 ? aim : WORLD_UP;
    const terrain = probeTerrain(base, n0);
    const obstacle = probeObstacleSurface(base, n0, allowUntypedObstacle);
    if (!obstacle) return terrain;
    if (!terrain.found) return obstacle;
    const from = base.clone().addScaledVector(n0, PROBE_ABOVE);
    return from.distanceToSquared(obstacle.point) < from.distanceToSquared(terrain.point) ? obstacle : terrain;
  }

  /** Nearest readable prop face along the same contact segment used for terrain. Obstacle-only props keep
   * `surface = -1`, so their upward faces remain bounce/slide barriers except for the one continuous mount
   * support explicitly admitted by `seatAtMount`. */
  function probeObstacleSurface(base: THREE.Vector3, aim: THREE.Vector3,
    allowUntyped = false): Probe | null {
    const n0 = aim.lengthSq() > 1e-6 ? aim : WORLD_UP;
    const from = base.clone().addScaledVector(n0, PROBE_ABOVE);
    let best: Probe | null = null;
    for (const probe of [probeMeshObstacleSurface(base, aim, allowUntyped),
      probeSphereObstacleSurface(base, aim, allowUntyped), probeBoxObstacleSurface(base, aim, allowUntyped)]) {
      if (!probe) continue;
      if (!best || from.distanceToSquared(probe.point) < from.distanceToSquared(best.point)) best = probe;
    }
    return best;
  }

  /** Rideable mode-2 counterpart. A box that carries a real surface type is stood on through the same downward
   * stab the terrain and the other prop shapes use, so its top face becomes ground rather than a wall. */
  function probeBoxObstacleSurface(base: THREE.Vector3, aim: THREE.Vector3,
    allowUntyped = false): Probe | null {
    if (!obstacleBoxes.length) return null;
    const n0 = aim.lengthSq() > 1e-6 ? aim : WORLD_UP;
    const from = base.clone().addScaledVector(n0, PROBE_ABOVE);
    const to = base.clone().addScaledVector(n0, -PROBE_BELOW);
    const started = performance.now();
    const hit = castBoxRay(from, to, meta => obstacleIsProbeReadable(meta, allowUntyped));
    perf.castAccum += performance.now() - started;
    if (!hit) return null;
    if (hit.normal.dot(n0) <= 1e-6) return null; // an under- or side-face is not something to stand on
    return { found: true, point: hit.point, n: hit.normal, surf: hit.meta.surface, key: hit.meta.key };
  }

  function probeMeshObstacleSurface(base: THREE.Vector3, aim: THREE.Vector3,
    allowUntyped = false): Probe | null {
    if (!obstacleBVH || !obstaclePos) return null;
    const n0 = aim.lengthSq() > 1e-6 ? aim : WORLD_UP;
    const from = base.clone().addScaledVector(n0, PROBE_ABOVE);
    const to = base.clone().addScaledVector(n0, -PROBE_BELOW);
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    const t = performance.now();
    obstacleRay.origin.copy(from);
    obstacleRay.direction.copy(to).sub(from).divideScalar(far);
    let best: Probe | null = null;
    let bestDistance = far;
    obstacleBVH.shapecast({
      boundsTraverseOrder: box => rayBoxEntryDistance(obstacleRay, box, obstacleRayBoxHit),
      intersectsBounds: (_box, _isLeaf, score) =>
        score !== undefined && score <= bestDistance ? INTERSECTED : NOT_INTERSECTED,
      intersectsTriangle: (triangle, faceIndex) => {
        const meta = obstacleMetas[obstacleFaceMeta[faceIndex]];
        // A shoveable body is never ground: the barrier sweep lets the rider straight through it, so seating the
        // deck on one would stand the rider on something they can also pass clean through.
        if (!meta || !obstacleIsProbeReadable(meta, allowUntyped)) return false;
        const hit = obstacleRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, obstacleRayHit);
        if (!hit) return false;
        const distance = hit.distanceTo(from);
        if (distance > bestDistance) return false;
        triangle.getNormal(obstacleNormal);
        if (obstacleNormal.lengthSq() < 1e-12) return false;
        if (obstacleNormal.dot(n0) < 0) obstacleNormal.negate();
        if (obstacleNormal.dot(n0) <= 1e-6) return false;
        bestDistance = distance;
        best = { found: true, point: hit.clone(), n: obstacleNormal.clone(), surf: meta.surface, key: meta.key };
        return false;
      },
    });
    perf.castAccum += performance.now() - t;
    return best as Probe | null;
  }

  /** Rideable mode-3 counterpart to the mesh probe. Most native sphere bodies are obstacle-only, but keeping
   * this path makes a recovered non-negative SurfaceType obey the same contact contract as every other shape. */
  function probeSphereObstacleSurface(base: THREE.Vector3, aim: THREE.Vector3,
    allowUntyped = false): Probe | null {
    if (!obstacleSphereBodies.length) return null;
    const n0 = aim.lengthSq() > 1e-6 ? aim : WORLD_UP;
    const from = base.clone().addScaledVector(n0, PROBE_ABOVE);
    const to = base.clone().addScaledVector(n0, -PROBE_BELOW);
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    const started = performance.now();
    let best:
      { u: number; point: THREE.Vector3; normal: THREE.Vector3; surface: number; key: string } | null = null;
    for (const body of obstacleSphereBodies) {
      if (!obstacleIsProbeReadable(body.meta, allowUntyped)
        || body.bound.distanceToPoint(from) > far) continue;
      sphereLocalFrom.copy(from).applyMatrix4(body.toLocal);
      sphereLocalTo.copy(to).applyMatrix4(body.toLocal);
      sphereLocalDir.copy(sphereLocalTo).sub(sphereLocalFrom);
      const aa = sphereLocalDir.lengthSq();
      if (aa < 1e-16) continue;
      const leaves = body.spheres;
      for (let i = 0; i + 3 < leaves.length; i += 4) {
        const cx = leaves[i], cy = leaves[i + 1], cz = leaves[i + 2], r = Math.max(0, leaves[i + 3]);
        const mx = sphereLocalFrom.x - cx, my = sphereLocalFrom.y - cy, mz = sphereLocalFrom.z - cz;
        const bb = 2 * (mx * sphereLocalDir.x + my * sphereLocalDir.y + mz * sphereLocalDir.z);
        const cc = mx * mx + my * my + mz * mz - r * r;
        const disc = bb * bb - 4 * aa * cc;
        if (disc < 0) continue;
        const root = Math.sqrt(disc), inv = 1 / (2 * aa);
        const enter = (-bb - root) * inv, exit = (-bb + root) * inv;
        const u = enter >= 0 ? enter : exit >= 0 ? exit : -1;
        if (u < 0 || u > 1 || (best && u >= best.u)) continue;
        sphereLocalHit.copy(sphereLocalDir).multiplyScalar(u).add(sphereLocalFrom);
        sphereLocalNormal.set(sphereLocalHit.x - cx, sphereLocalHit.y - cy, sphereLocalHit.z - cz);
        if (sphereLocalNormal.lengthSq() < 1e-16) continue;
        sphereWorldNormal.copy(sphereLocalNormal).applyNormalMatrix(body.normalMatrix).normalize();
        if (sphereWorldNormal.dot(n0) <= 1e-6) continue;
        best = {
          u, point: sphereWorldPoint.copy(sphereLocalHit).applyMatrix4(body.matrixWorld).clone(),
          normal: sphereWorldNormal.clone(), surface: body.meta.surface, key: body.meta.key,
        };
      }
    }
    perf.castAccum += performance.now() - started;
    return best
      ? { found: true, point: best.point, n: best.normal, surf: best.surface, key: best.key }
      : null;
  }

  function probeTerrain(base: THREE.Vector3, aim: THREE.Vector3): Probe {
    const n0 = aim.lengthSq() > 1e-6 ? aim : WORLD_UP;
    const from = base.clone().addScaledVector(n0, PROBE_ABOVE);
    const to = base.clone().addScaledVector(n0, -PROBE_BELOW);
    let h: { point: THREE.Vector3; faceIndex: number } | null = null;
    if (o.patchContact) {
      const t = performance.now();
      const a = from.clone().applyMatrix4(toLocal), b = to.clone().applyMatrix4(toLocal);
      const far = a.distanceTo(b);
      localRay.origin.copy(a);
      localRay.direction.copy(b).sub(a).divideScalar(far);
      let bestLocalDistance = far;
      let analytic: Probe | null = null;
      bvh.shapecast({
        boundsTraverseOrder: box => rayBoxEntryDistance(localRay, box, localRayBoxHit),
        intersectsBounds: (_box, _isLeaf, score) =>
          score !== undefined && score <= bestLocalDistance ? INTERSECTED : NOT_INTERSECTED,
        intersectsTriangle: (triangle, faceIndex) => {
          const hit = localRay.intersectTriangle(triangle.a, triangle.b, triangle.c, false, localRayHit);
          if (!hit) return false;
          const distance = hit.distanceTo(a);
          if (distance > bestLocalDistance) return false;
          if (!baryOf(faceIndex, hit, baryTmp)
              || !o.patchContact!(faceIndex, baryTmp, patchP, patchN)) {
            bestLocalDistance = distance;
            h = { point: hit.clone(), faceIndex }; // no patch data — faceted read below
            analytic = null;
            return false;
          }
          if (!refinePatchRay(faceIndex, baryTmp, a, localRay.direction, far)) return false;
          const n = patchN.clone().applyMatrix3(normalMat).normalize();
          if (n.dot(n0) <= 0) return false; // back face: not ground, the segment passes through
          bestLocalDistance = distance;
          h = null;
          analytic = {
            found: true, point: patchP.clone().applyMatrix4(toWorld), n, surf: o.surfaceOf(faceIndex) ?? 1,
          };
          return false;
        },
      });
      perf.castAccum += performance.now() - t;
      const analyticResult = analytic as Probe | null;
      if (analyticResult) return analyticResult;
      h = h as { point: THREE.Vector3; faceIndex: number } | null;
      if (!h) return { found: false, point: base.clone(), n: n0.clone(), surf: st.surf };
    } else {
      h = castSeg(from, to);
      if (!h) return { found: false, point: base.clone(), n: n0.clone(), surf: st.surf };
    }
    const surf = o.surfaceOf(h.faceIndex) ?? 1;

    // Sample the surface either side of the hit along two in-plane axes, measuring each sample's offset ALONG
    // the aim normal — the same central difference the vertical probe used, written so it survives a steep wall.
    const point = h.point.applyMatrix4(toWorld);
    const t1 = new THREE.Vector3().crossVectors(n0, Math.abs(n0.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : WORLD_UP).normalize();
    const t2 = new THREE.Vector3().crossVectors(n0, t1).normalize();
    const d = 0.9;
    const along = (t: THREE.Vector3, s: number): number => {
      const b = point.clone().addScaledVector(t, s * d);
      const hit = castSeg(b.clone().addScaledVector(n0, PROBE_ABOVE), b.clone().addScaledVector(n0, -PROBE_ABOVE));
      return hit ? hit.point.applyMatrix4(toWorld).sub(point).dot(n0) : 0;
    };
    const n = n0.clone()
      .addScaledVector(t1, -(along(t1, 1) - along(t1, -1)) / (2 * d))
      .addScaledVector(t2, -(along(t2, 1) - along(t2, -1)) / (2 * d))
      .normalize();
    return { found: true, point, n, surf };
  }

  /**
   * The engine's COURSE RESET ([Trailmap: 395]): put the rider down somewhere else on the mountain, facing
   * down-course and already moving. The engine's warp state writes the position and a `speed`-along-the-path
   * velocity straight into the boarder record; everything else re-seats exactly as a respawn does, so this is a
   * respawn with a new spawn point and an exit velocity rather than a second teleport path.
   *
   * The AI arms it when a rider is out of play; the reset target is a point on a *respawnable* path.
   */
  function warpTo(pos: THREE.Vector3, fwd: THREE.Vector3, speed: number) {
    spawn.copy(pos);
    const h = fwd.clone(); h.y = 0;
    if (h.lengthSq() > 1e-6) spawnFwd.copy(h.normalize());
    respawn(); // re-seats the contact fields on the new surface and zeroes the velocity...
    st.vel.copy(st.fwd).multiplyScalar(speed); // ...which the reset then replaces with its down-course push
  }

  /** Drop a crumb where the rider is standing, throttled so the trail sits ~`CRUMB_SPACING` apart. The heading
   *  recorded is the direction of TRAVEL (`fwd·lead`), not the drawn nose: a rider put back down facing the way
   *  a switch landing happened to leave the deck would be pointing back up their own trail. */
  function recordCrumb() {
    if (o.carryBack === false) return;
    const len = crumbPos.length;
    if (crumbFilled > 0
      && crumbPos[(crumbWrite - 1 + len) % len].distanceToSquared(st.pos) < CRUMB_SPACING * CRUMB_SPACING) return;
    crumbPos[crumbWrite].copy(st.pos);
    const f = crumbFwd[crumbWrite].copy(st.fwd).multiplyScalar(st.lead).setY(0);
    if (f.lengthSq() > 1e-6) f.normalize(); else f.set(0, 0, 1);
    crumbWrite = (crumbWrite + 1) % len;
    if (crumbFilled < len) crumbFilled++;
  }

  /**
   * CARRY-BACK — when automatic recovery is enabled, the wedge integrator, out-of-bounds floor and authored
   * Reset surface end here; reset volumes are gated by the host. The rider's manual reset always ends here too.
   * The rider is put back down ON THE COURSE near where they left it,
   * facing down-course and already moving; the start gate is a last resort, not the answer. Three tiers, best
   * first — the same three the Unity board runs (`RideableBoard.OutOfBounds.ResetToTrack`, Unity docs/031):
   *
   *   1. **The nearest point on the authored course line.** Its own height is not trusted: a course is a race
   *      LINE and not a surface — it floats over the jumps it crosses and dips tens of metres under the terrain
   *      elsewhere — so the ground under it is cast for separately, and a Reset (Surf_0) patch under it is
   *      passed over, or the carry-back would set the rider straight back down in the skirt they just left.
   *   2. **A breadcrumb a few metres back up the trail**, for a mountain that carries no authored course.
   *   3. **The run's start gate** — which is also where a rider goes who has been reset `RESET_STREAK_LIMIT`
   *      times inside `RESET_STREAK_WINDOW` seconds, because by then the carry-back target is the trap.
   */
  function resetToCourse(from: THREE.Vector3 = st.pos) {
    // An AI rider's model does not carry itself back: the field's own reset, armed by this respawn, places it
    // with the pack instead ([Trailmap: 395], `ride/ai.courseReset`).
    if (o.carryBack === false) { respawn(); return; }
    resetStreak = rideElapsed - lastResetAt < RESET_STREAK_WINDOW ? resetStreak + 1 : 1;
    lastResetAt = rideElapsed;
    const trapped = resetStreak >= RESET_STREAK_LIMIT;

    // 1) The course line, measured HORIZONTALLY. How far the rider fell is not a measure of how far off the
    // course they are — and it is the whole measurement on the exit that matters most, since the out-of-bounds
    // floor sits a hundred metres under the terrain by construction, so any 3D radius tight enough to mean
    // anything would reject the course line for every rider who left the world through it.
    const course = o.course;
    if (!trapped && course && course.length >= 2) {
      let bestDistance2 = Infinity;
      const best = new THREE.Vector3(), tangent = new THREE.Vector3();
      const ab = new THREE.Vector3(), candidate = new THREE.Vector3();
      for (let i = 1; i < course.length; i++) {
        const a = course[i - 1], b = course[i];
        ab.copy(b).sub(a);
        const len2 = ab.x * ab.x + ab.z * ab.z; // the segment's ground run; a vertical drop parameterizes nothing
        if (len2 < 1e-8) continue;
        const t = clamp(((from.x - a.x) * ab.x + (from.z - a.z) * ab.z) / len2, 0, 1);
        candidate.copy(a).addScaledVector(ab, t);
        const dx = candidate.x - from.x, dz = candidate.z - from.z;
        const distance2 = dx * dx + dz * dz;
        if (distance2 < bestDistance2) { bestDistance2 = distance2; best.copy(candidate); tangent.copy(ab); }
      }
      if (bestDistance2 <= COURSE_RESET_MAX_DIST * COURSE_RESET_MAX_DIST) {
        if (tangent.lengthSq() > 1e-12) tangent.normalize();
        const ground = resetGroundAt(best);
        // Drop in just above the ground the way an ordinary respawn does and let the contact model land it. With
        // no ground found the line's own height is all there is, so leave the usual metre of clearance.
        const target = ground
          ? new THREE.Vector3(best.x, ground.point.y + 0.1, best.z)
          : new THREE.Vector3(best.x, best.y + 1.0, best.z);
        warpTo(target, resetFacing(tangent, ground), RESET_SPEED);
        return;
      }
    }

    // 2) The trail, a few metres back from the newest crumb.
    if (!trapped && crumbFilled > 0) {
      const len = crumbPos.length;
      const back = Math.min(crumbFilled - 1, Math.ceil(CRUMB_BACK_DISTANCE / CRUMB_SPACING));
      const i = ((crumbWrite - 1 - back) % len + len) % len;
      const at = crumbPos[i].clone(); at.y += 0.5;
      warpTo(at, crumbFwd[i].clone(), RESET_SPEED);
      return;
    }

    // 3) Nothing to be put back onto, or the carry-back is itself what keeps resetting the rider.
    resetStreak = 0;
    spawn.copy(runStart); spawnFwd.copy(runStartFwd);
    respawn();
  }

  /** Which way a carry-back faces. Down-course where the course line says so; down the ground's own fall line
   *  where it does not, because a race line crossing a drop is near-vertical and reads no bearing at all; and
   *  never uphill — the sign is forced against the slope, so no reset sets a rider down facing back up it. */
  function resetFacing(tangent: THREE.Vector3, ground: Probe | null): THREE.Vector3 {
    const fall = projectOnPlane(new THREE.Vector3(0, -1, 0), ground?.n ?? WORLD_UP, new THREE.Vector3()).setY(0);
    const face = new THREE.Vector3(tangent.x, 0, tangent.z);
    if (face.lengthSq() < 0.0625) face.copy(fall);                 // under 0.25 horizontal: unreadable
    if (face.lengthSq() < 1e-4) face.set(st.fwd.x, 0, st.fwd.z);   // level ground under it too: the rider's own
    if (face.lengthSq() < 1e-6) return new THREE.Vector3(0, 0, 1); // ...and finally anything at all
    if (fall.lengthSq() > 1e-4 && face.dot(fall) < 0) face.negate();
    return face.normalize();
  }

  /**
   * The real ground under a world point, found the way a reset needs it rather than the way contact does: ONE
   * long vertical cast, because the contact probe's 2 m / 1 m reach is a contact reach and a course line can
   * hang a hundred metres over the terrain it crosses. Each hit is then re-read through the ordinary probe, so
   * the normal the facing is derived from is the refined (patch or central-difference) one and not a raw
   * triangle. Reset patches are passed over: landing back on the skirt is how a reset loop starts.
   */
  function resetGroundAt(at: THREE.Vector3): Probe | null {
    const from = new THREE.Vector3(at.x, at.y + RESET_GROUND_ABOVE, at.z).applyMatrix4(toLocal);
    const to = new THREE.Vector3(at.x, at.y - RESET_GROUND_BELOW, at.z).applyMatrix4(toLocal);
    const far = from.distanceTo(to);
    if (far < 1e-9) return null;
    const started = performance.now();
    localRay.origin.copy(from);
    localRay.direction.copy(to).sub(from).divideScalar(far);
    const hits = bvh.raycast(localRay, THREE.DoubleSide, 0, far)
      .filter(hit => hit.faceIndex != null)
      .sort((x, y) => x.distance - y.distance);
    perf.castAccum += performance.now() - started;
    for (const hit of hits) {
      const g = probe((hit.point as THREE.Vector3).clone().applyMatrix4(toWorld), WORLD_UP);
      if (g.found && g.surf > 0) return g;
    }
    return null;
  }

  function telemetryState(): RideTelemetryState {
    const deckForward = projectOnPlane(st.fwd, st.boardUp, new THREE.Vector3());
    if (deckForward.lengthSq() > 1e-8) deckForward.normalize(); else deckForward.copy(st.fwd);
    const pitch = (v: THREE.Vector3) => v.lengthSq() > 1e-8
      ? Math.atan2(v.y, Math.hypot(v.x, v.z)) / D2R : 0;
    return {
      position: telemetryVec(st.pos), velocity: telemetryVec(st.vel), speed: st.vel.length(),
      forward: telemetryVec(st.fwd), deckForward: telemetryVec(deckForward), lead: st.lead, flip: st.flip,
      boardUp: telemetryVec(st.boardUp), contactNormal: telemetryVec(st.contactN),
      trajectoryPitchDeg: pitch(st.vel), boardPitchDeg: pitch(deckForward),
      grounded: st.grounded, forcedAir: st.forcedAir, railIndex: st.railIdx, airTime: st.airTime,
      error: st.error, surfaceType: st.surf, speedCap: st.speedCap,
      lean: st.lean, carveSlide: st.carveSlide,
      charging: st.charging, jumpCharge: st.charge, jumpGrace: st.jumpGrace, ollieCooldown: st.ollieCooldown,
    };
  }

  /** Keep only the nearest observation of each crossing class; the 13 body samples otherwise report duplicates. */
  function recordBarrierEvent(event: Extract<RideTelemetryEvent, { type: 'barrier-resolved' | 'floor-crossing-deferred' }>) {
    if (!tickTrace) return;
    const i = tickTrace.events.findIndex(item => item.type === event.type);
    if (i < 0) tickTrace.events.push(event);
    else {
      const previous = tickTrace.events[i] as typeof event;
      if (event.distance < previous.distance) tickTrace.events[i] = event;
    }
  }

  return { st, perf, toWorld, start, step, respawn, resetToCourse, seatAtSpawn, seatAtMount, mountAirborne, warpTo,
    applyPadBoost,
    retireObstacle, restoreObstacle, stepCrackedSurfaces,
    /** The run's lap countdown, or null on a single-pass course — read by the HUD. */
    get laps(): LapCounter | null { return lapCounter; },
    get padBoostSeconds() { return padBoostTimer; }, ollieDown, ollieUp, boostActive, boostThrustActive,
    castSeg, castCameraObstacle, closestCameraTerrain, renderState };
}

export type RideModel = ReturnType<typeof createRideModel>;
export type RideState = RideModel['st'];
export type { RidePerf } from './perf';

function telemetryVec(v: THREE.Vector3): RideTelemetryVec3 { return [v.x, v.y, v.z]; }
