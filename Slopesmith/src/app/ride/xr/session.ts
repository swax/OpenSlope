import * as THREE from 'three';
import {
  createBoard, DEFAULT_RIDE_GEAR, DEFAULT_SNOWBOARD_STANCE, type BoardModel, type EquipmentAppearance,
  type RideGear, type SnowboardStance,
} from '../gear';
import { createRider, type RiderHandTarget } from '../rider';
import type { CharacterHandCurl } from '../character-rig';
import type { RideState } from '../physics';
import { createXrHud, type XrHudAction, type XrHudCalibration, type XrHudPerf } from './hud';
import {
  createRidePerf, estimatedRidePacingMs, measuredRideCpuMs, recordRideFrameTimings, unmeasuredRideFrameMs,
  type RideFrameTimingSample, type RidePerf,
} from '../perf';
import {
  controllerFingerCurls, footControls, grabControls, readPads, rideControls, smoothTurnRadians, viewToggleHeld,
  wristMenuToggleHeld,
  type XrPads, type XrRideControls,
} from './input';
import { trackedFingerCurls, type TrackedHand } from './hand-curl';
import { createWalker, downwardGroundQuery, type WalkGround, type Walker } from './walk';
import { createBoardCoast } from '../board-coast';
import {
  createBoardGrab, deckGrabDistance, deckRayDistance, handBehindHead, handGripPoint, nearestDeckPoint,
  type BoardThrow, type GrabHand,
} from '../board-grab';
import { GRAB_REACH, HAND_TRANSFER_REACH, MOUNT_AIM_RANGE } from '../physics-tuning';
import {
  maskXrLayersForThree, xrLayerKind, xrNativeRenderScale,
  type XrEyeBufferMeasurement, type XrLayerMode,
} from './config';
import {
  calibrationMatchesOrigin, captureXrBodyCalibration, captureXrHandCalibration, clearXrBodyCalibration,
  fallbackFloorOffset, FALLBACK_STANDING_EYE_HEIGHT, loadXrBodyCalibration, saveXrBodyCalibration,
  type XrBodyCalibration, type XrHandsCalibration, type XrTrackedHandSource,
} from './calibration';
import type { LocalPlayerPose, PlayerTransform } from '../../../core/session/player-pose';
import type { RideRunStatus } from '../run-status';
import { BoardBoostTrail } from '../boost-trail';

/**
 * VR play (docs/048): the WebXR session host, and the on-foot ↔ riding state machine inside it.
 *
 * What this owns is the RIG — one group in the scene holding the camera and the two controller spaces — and the
 * question of where that rig is each frame: standing on the mountain, or standing on the board. Everything
 * either state does with the mountain already exists. Riding is the ordinary `TestRide` with its chase camera
 * stood down and gaze handed to its head steering; walking is `walk.ts`; what the buttons mean is `input.ts`.
 *
 * The shape is the VRChat world's, because the ask is that the mountain plays the same in both headsets
 * (Unity docs/vrchat/017): you arrive on FOOT with the board parked at the gate, point at it and pull the TRIGGER
 * to get on, pull either trigger to get off again wherever you are — and the GRIP, throughout, carries the
 * board rather than riding it: pick it up, pass it hand to hand, throw it, take it off your own feet in mid-air,
 * or reach behind your head to call it back from across the mountain (`board-grab.ts`). Trigger rides, grip
 * carries; that split is why one deck needs no separate handle to aim at. The board is a vehicle you mount, not
 * a mode the editor is in — which is also why the seat is pinned and level here rather than welded to the deck:
 * a view that rolls with a carve is the fastest way to make someone take the headset off.
 *
 * The rig's yaw is ONE continuous quantity across both states. On foot the right stick turns it smoothly; riding,
 * the stick's turn intent carries it with the board (`RideState.seatYaw`). Neither mount nor dismount snaps it,
 * because an instant reorientation the inner ear did not ask for is exactly the thing to avoid.
 */

/** Both hands, in a fixed order, so the carry's per-hand rules are written once rather than twice. */
const GRAB_HANDS: readonly GrabHand[] = ['left', 'right'];
/** Resolve the single guide owner when both controllers can act on the same loose board. */
export function preferredBoardActionHand(left: boolean, right: boolean): GrabHand | null {
  return right ? 'right' : left ? 'left' : null;
}
/** Deck thickness: the rig origin is the rider's FEET, and their feet stand on top of the board, not in it. */
const DECK_STAND = 0.06;
/** X on foot puts the one session board within a comfortable step of the player. */
const BOARD_SPAWN_AHEAD = 1.4;
/** Close enough to bring a palm to the face without slicing it at the editor/chase camera's 15–50 cm plane. */
export const XR_NEAR_CLIP = 0.03;
/** Eye-height fallback if the device gives no floor-relative space, so a `local`-only runtime is still playable,
 *  and the height below which a reported eye is read as "this space has no floor in it" rather than a crouch. */
const FALLBACK_EYE_HEIGHT = FALLBACK_STANDING_EYE_HEIGHT;
/** A larger between-frame X/Z change is a tracking-origin reset/recovery, not a person crossing the room. */
const MAX_TRACKED_ROOM_STEP = 0.75;
/** Optical tracking moves by sub-millimetres even while a wearer stands still. Accumulate those deltas until a
 * real 2 mm room movement exists instead of launching a full capsule/BVH solve for sensor noise every frame. */
export const MIN_TRACKED_ROOM_MOVE = 0.002;
/**
 * Where the read-out board parks in the RIDER's own frame: 1.2 m (about four feet) ahead of them and this far
 * below their eyes, which puts it a ~25° glance down — under the run rather than across it.
 *
 * That frame is the point. Bolted to the head it swims with every glance, which is both unreadable and the
 * fastest route to motion sickness; left in the world it is a hundred metres behind you within four seconds.
 * Parked in the rider's frame it holds still relative to the body and travels with the board, so it behaves
 * like a dashboard: you look down, read it, and look back up.
 */
const READOUT_DISTANCE = 1.2, READOUT_DROP = 0.55;
/** How often the profiler line reaches the console, where whoever is debugging can actually copy it. */
const PERF_LOG_MS = 2000;
/** Frames to let a session settle before its fastest one is trusted as the display's cadence. */
const RATE_WARMUP_FRAMES = 30;
/** The rates a headset is actually built around, for snapping a measured cadence onto one of them. */
const KNOWN_DISPLAY_RATES = [60, 72, 80, 90, 96, 100, 120, 144];

/**
 * The display rate implied by the fastest frame a session managed, snapped to a real headset rate. Used only
 * when the runtime declines to report one — several desktop OpenXR runtimes do, because the rate is carried by
 * an optional extension rather than the core spec.
 *
 * Snapped rather than reported raw because the answer feeds a BUDGET, and "8.4 ms" is far less useful to read
 * than "120 Hz".
 *
 * ZERO means UNKNOWN, and that is the important case. If even the best frame is slower than the slowest display
 * anyone ships, the session has never once reached vsync — so the measurement says nothing about the display and
 * everything about us. Returning it as though it were the refresh rate would be the panel's worst possible lie:
 * a budget derived from our own slowness, against which we would always look comfortably inside it.
 */
export function estimateDisplayHz(bestMs: number): number {
  if (!Number.isFinite(bestMs) || bestMs <= 0) return 0;
  const measured = 1000 / bestMs;
  if (measured < KNOWN_DISPLAY_RATES[0] * 0.9) return 0; // never hit vsync — we do not know the rate
  let closest = KNOWN_DISPLAY_RATES[0];
  for (const rate of KNOWN_DISPLAY_RATES) {
    if (Math.abs(rate - measured) < Math.abs(closest - measured)) closest = rate;
  }
  return closest;
}

/** What the host's live board ride has to offer the rig. `TestRide` satisfies it. */
export interface XrBoardRide {
  readonly state: RideState;
  /** The gate run shown on the wrist; null before it starts or after a grounded abandonment. */
  readonly runStatus: RideRunStatus | null;
  /** The live ride profiler, which carries the drill-down phases only a running board produces. */
  readonly perf: Readonly<RidePerf>;
  /** The between-ticks render view the deck is drawn at — the seat rides this, not the raw tick state. */
  renderView(): { pos: THREE.Vector3; fwd: THREE.Vector3; vel: THREE.Vector3; flip: number };
  setXrControls(controls: XrRideControls): void;
  /** Exact world-space headset transform, so the visible body is built under the wearer rather than a pose. */
  setXrHead(position: THREE.Vector3 | null, quaternion: THREE.Quaternion | null): void;
  /** World-space wrist poses, so the drawn rider's arms and palms are the wearer's own. */
  setXrHands(left: RiderHandTarget | null, right: RiderHandTarget | null): void;
  /** Show/hide only the local head when the session moves its camera between first and third person. */
  setFirstPerson(firstPerson: boolean): void;
  setEquipmentAppearance(appearance?: EquipmentAppearance): void;
  resetToCourse(from?: THREE.Vector3): void;
  /** Begin a fresh gate run after initial entry or an explicit wrist-menu restart. */
  startRun(): void;
  /** Clear a grounded abandonment, including its wrist readout. */
  abandonRun(): void;
  /** Keep an airborne exit/grab scoring and clear it if the rider lands on foot. */
  stepRunOffBoard(dt: number, grounded: boolean, grabHand?: GrabHand | null): void;
  /** Resume an arc the rider arrived with — the mid-air deck catch. Never called for a grounded mount. */
  resumeAirborne(velocity: THREE.Vector3): void;
  boostActive(): boolean;
  /** The board/body sample before tracked headset and controller transforms are layered over it. */
  playerPose(): LocalPlayerPose;
}

export interface XrPlayDeps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  /** A world-space segment cast against the ridden mountain — the walker's floor, and the board's parking spot. */
  groundCast(from: THREE.Vector3, to: THREE.Vector3): WalkGround | null;
  /** World-prop body collision for the on-foot controller. */
  resolveWalkMove?(from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3): void;
  /** Full-frame on-foot presence, including tracked-room movement, walking, jumping, and Superman flight. */
  stepFootContact?(from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3, dt: number): void;
  /** World Y below which the rider has fallen off the mountain. */
  oobFloorY: number;
  /** Which mountain this is, for the wrist panel. */
  label: string;
  /** Where the run starts (world) and which way it faces. The board is parked here and the rider beside it. */
  spawn: THREE.Vector3;
  heading: THREE.Vector3;
  /** Eye-buffer scale, 0.5–3 (docs/048). Fixed at session start: WebXR sizes the buffer once, when the layer is
   *  made, and three refuses the change afterwards. */
  renderScale: number;
  /** MSAA request for this session (four samples on Three's projection path; runtime-owned on WebGL layers). */
  antialias: boolean;
  /** Complete adapter/context restoration before Three installs any session state. */
  prepareContext(): Promise<void>;
  /** Temporarily changes the attribute record Three reads while constructing the XR layer. */
  prepareAntialias(enabled: boolean): { applied: boolean; restore: () => void };
  /** Which XR render path to request. The wrist panel reports the effective path independently. */
  layerMode: XrLayerMode;
  /** Initial state of the diagnostic readout and its console samples. The wrist menu can change it live. */
  showStats: boolean;
  /** Keep the Test toolbox's persisted starting state in sync with a live wrist-menu change. */
  onStatsChanged?(enabled: boolean): void;
  /** Retain the actual per-eye viewport once the first frame reveals it, so setup can explain what 1x means. */
  onEyeBufferMeasured?(measurement: XrEyeBufferMeasurement): XrEyeBufferMeasurement | void;
  /** The same selected body/style/gear used when this on-foot session mounts its board. */
  riderModel?: string;
  riderStyle?: string;
  gear?: RideGear;
  snowboardStance?: SnowboardStance;
  equipmentAppearance?: EquipmentAppearance;
  /** Build and park the session's board once XR is established, before the rider can reach it. This keeps the
   * expensive ride/collision initialization out of the first mount while preserving an on-foot start. */
  prepareRide?(gaze: () => THREE.Vector3 | null): XrBoardRide | null;
  /** Put the rider on the board. Null when the ride could not start; the rig then stays on foot. */
  startRide(spawn: THREE.Vector3, heading: THREE.Vector3,
    gaze: () => THREE.Vector3 | null): XrBoardRide | null;
  /** Take them off it again. */
  stopRide(): void;
  /** Put any opponent field back on its gates and hold it for the next fresh mount. */
  restartField?(): void;
  /** Perform only the retained boost roar while off-board flight receives boosted directional thrust. */
  setFlightBoostAudio(active: boolean, dt: number): void;
  /** The session ended — headset off, system menu, or Stop. The host restores the editor. */
  onExit(): void;
}

/** Whether this browser can present at all; false everywhere without a headset runtime. */
export async function xrSupported(): Promise<boolean> {
  const xr = navigator.xr;
  if (!xr?.isSessionSupported) return false;
  try { return await xr.isSessionSupported('immersive-vr'); } catch { return false; }
}

export function createXrPlay(deps: XrPlayDeps) {
  const rig = new THREE.Group();
  rig.name = 'xr-rig';
  // Three applies an XR viewer pose through the CAMERA'S IMMEDIATE parent. This separate child offsets the
  // rendered eyes and physical hand previews together in third person; avatar IK is explicitly rebased back to
  // `rig` below, so the body stays on the board while controllers and wrist UI remain beside the real wearer.
  const viewRig = new THREE.Group();
  viewRig.name = 'xr-view-rig';
  rig.add(viewRig);
  const hands = createHands(deps.renderer, rig, viewRig);
  // The watch always exists because it owns body calibration. The profiler canvas exists so the wrist can turn
  // it on mid-session, but stays detached and undrawn while disabled (no texture upload or timing queries).
  const hud = createXrHud(deps.label, false);
  const profiler = createXrHud(deps.label, true);
  let statsEnabled = deps.showStats;
  let controlsOpen = false;
  /** Left Y hides the complete wrist watch until the next Y edge. Starts visible on every headset session. */
  let watchVisible = true;

  let session: XRSession | null = null;
  let cameraHome: THREE.Object3D | null = null;
  let cameraNearHome: number | null = null;
  let ride: XrBoardRide | null = null;
  /** The one prewarmed board runtime, retained while its visible loose-board counterpart is on foot. */
  let retainedRide: XrBoardRide | null = null;
  /** A run survives only the airborne interval between leaving the deck and catching it again. */
  let offBoardRun: XrBoardRide | null = null;
  /** Initial entry and wrist Restart arm a fresh mode-appropriate run for the next mount. */
  let runArmed = true;
  /** Whether the per-session Layers-API shadow needed to steer Three onto XRWebGLLayer was accepted. */
  let layerOverrideApplied = false;
  let thirdPerson = false;
  let viewKeyAttached = false;
  let eyeBufferReported = false;
  let appliedRenderScale = deps.renderScale;
  let nativeRenderScale: number | null = null;
  let maxRenderScale: number | null = null;
  let antialiasApplied = false;

  // ---- rig pose ----
  /** The seat's own heading, world-horizontal. Continuous across mount and dismount; never snapped. */
  const rigFwd = new THREE.Vector3();
  /** Head pose in RIG space, straight off the frame's viewer pose, plus its world resolution. */
  const headLocal = new THREE.Vector3(0, FALLBACK_EYE_HEIGHT, 0);
  const previousHeadLocal = new THREE.Vector3();
  const seatHeadAnchor = new THREE.Vector3();
  const trackedRoomMove = new THREE.Vector3();
  const pendingTrackedRoomMove = new THREE.Vector3();
  const footContactFrom = new THREE.Vector3();
  let previousHeadTracked = false;
  const headLocalQuat = new THREE.Quaternion();
  const headWorld = new THREE.Vector3();
  const headQuat = new THREE.Quaternion();
  const headFwd = new THREE.Vector3(0, 0, -1);
  /**
   * How far to lift the rig so the wearer's eyes land at a person's height.
   *
   * Normally zero: `local-floor` measures from the play-space floor, so the viewer pose already carries the
   * wearer's real height and using anything else would make a tall rider short. But a runtime can hand back a
   * `local-floor` that is really head-origin — or metres below the real floor. A saved T-pose supplies the exact
   * correction; before one exists, an implausible first pose is brought to the safe standing fallback.
   */
  let calibration: XrBodyCalibration | null = loadXrBodyCalibration();
  let eyeLift = calibration?.floorOffset ?? 0;
  let eyeCalibrated = false;
  let calibrationRun: { startedAt: number } | null = null;
  let calibrationNotice: { phase: 'saved' | 'error'; until: number; message?: string } | null = null;

  // ---- the parked board, and the rider on foot ----
  const parked: BoardModel = createBoard(
    deps.gear ?? DEFAULT_RIDE_GEAR, deps.snowboardStance ?? DEFAULT_SNOWBOARD_STANCE, deps.equipmentAppearance,
  );
  const parkedFacing = new THREE.Vector3(0, 0, 1);
  parked.group.visible = false;
  parked.group.traverse(object => { object.raycast = () => {}; });
  const footRider = createRider(
    deps.riderModel, deps.riderStyle, deps.gear ?? DEFAULT_RIDE_GEAR,
    deps.snowboardStance ?? DEFAULT_SNOWBOARD_STANCE,
  );
  footRider.setFirstPerson(true);
  footRider.group.visible = false;
  footRider.group.traverse(object => { object.raycast = () => {}; });
  let footRiderPlaced = false, footFrameDt = 0, footWalkPhase = 0, footWalkWeight = 0;
  const footGround = downwardGroundQuery(deps.groundCast);
  const walker: Walker = createWalker({
    ground: footGround,
    resolveMove: deps.resolveWalkMove,
    oobFloorY: deps.oobFloorY,
    onFell: () => { if (scoredRunActive()) resetOnFoot(); },
  });
  /** Where the deck is whenever nobody is on it: sliding away from a dismount, or lying at its post. */
  const boardCoast = createBoardCoast({
    ground: footGround, oobFloorY: deps.oobFloorY,
    // A bail over a cliff sends the deck over it too, and there is only one board in this session. Back to the
    // gate post it goes, which is the one place a rider on foot can always reach.
    onLost: () => parkBoardAt(deps.spawn, rigFwd),
  });
  const coastRight = new THREE.Vector3(), coastBasis = new THREE.Matrix4();
  /**
   * The board IN A HAND (`board-grab.ts`) — the third thing that can own the deck, beside the ride and the
   * coast, and never at the same time as either. The grip picks it up off the snow, passes it between hands,
   * snatches it off your feet in mid-air and throws it; the trigger puts it back under you.
   */
  const boardGrab = createBoardGrab();
  /** Off-board only: the same seven-pose retail trail, attached to the physical deck being used as a jetpack. */
  const heldBoardBoostTrail = new BoardBoostTrail();
  const thrown: BoardThrow = { velocity: new THREE.Vector3(), spin: new THREE.Vector3() };
  const grabbedUp = new THREE.Vector3(), grabbedFwd = new THREE.Vector3();
  /** Whether `handA` / `handB` carry a real pose. They are written at the END of a frame, so a grab decided in
   *  `beginFrame` reads the previous frame's wrists — millimetres at arm speed, and the alternative is
   *  resolving them against a rig that has not been seated for this frame yet. */
  let wristsTracked = false;
  /**
   * Raw button state, tracked in EVERY state rather than per branch. The trigger mounts, dismounts and re-equips,
   * while A jumps in either locomotion state. An edge read only inside one branch would see a button still held
   * from the other as a fresh press — step off with the trigger down and you would step straight back on.
   */
  const held = { trigger: false, rightTrigger: false, a: false, x: false, view: false, menu: false };
  /** The grips, tracked beside the rest for the same reason and kept apart only so `edge` stays a flat lookup. */
  const heldGrab = { left: false, right: false };
  let seatYawRead = 0;

  const scratch = new THREE.Vector3(), scratchB = new THREE.Vector3();
  const handA: RiderHandTarget = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const handB: RiderHandTarget = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const calibrationGripA = new THREE.Vector3(), calibrationGripB = new THREE.Vector3();
  const footAnkleA = new THREE.Vector3(), footAnkleB = new THREE.Vector3();
  const footFacing = new THREE.Vector3(), footAcceleration = new THREE.Vector3();
  const watchRaycaster = new THREE.Raycaster();
  watchRaycaster.far = 1.5;
  /** The pointing ray a trigger mounts along. */
  const mountRay = new THREE.Ray();
  const boardBoostRay = new THREE.Ray();
  const watchPointer = createWatchPointer();
  const boardActionGuides = {
    left: createBoardActionGuide('left'), right: createBoardActionGuide('right'),
  };
  const boardActionRay = new THREE.Ray();
  const boardActionStarts = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  const boardActionTargets = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  const boardActionGrip = new THREE.Vector3();
  const heldBoardBoostDirection = new THREE.Vector3();

  // ---- the profiler (docs/048) ----
  /**
   * The session's own broad-phase timings, so the wrist panel still profiles while the rider is ON FOOT and
   * there is no board to own a `RidePerf`. A running board keeps its own, with the drill-down phases this one
   * cannot see, and the panel reads whichever is live.
   */
  const footPerf: RidePerf = createRidePerf();
  /** The last second's slowest frame, and when that window started. An average buries the hitch that actually
   *  breaks presence — one 60 ms frame in a second of good ones is felt, and reads as 68 fps. */
  let worstMs = 0, worstSince = 0, worstShown = 0;
  /**
   * The fastest frame the session has ever turned in. When the runtime will not say what the display rate is,
   * this is the honest estimate of it: a frame cannot complete faster than the display's own cadence, so the
   * quickest one seen is the budget (the first frames are skipped — a session's opening frames are long while
   * the scene warms, and one of them would peg this far too high).
   */
  let bestMs = Infinity, framesSeen = 0;
  /** Next console dump (see `logPerf`). */
  let nextLog = 0;

  // ---------------------------------------------------------------------------------------------------------
  // lifecycle

  /**
   * Ask for the headset. MUST be called straight out of a user gesture — `requestSession` is gated on user
   * activation, and any await before it spends that activation — so the caller does its own preparation after
   * this resolves, not before it. False when the request is refused or no runtime answers.
   */
  async function enter(): Promise<boolean> {
    if (session || !navigator.xr) return false;
    let requested: XRSession;
    try {
      requested = await navigator.xr.requestSession('immersive-vr', {
        // `local-floor` is what puts the rig origin at the rider's FEET, so the walker's ground contact and the
        // board's deck are both real heights rather than guesses about how tall the wearer is.
        //
        optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
      });
    } catch (error) {
      console.warn('[Slopesmith XR] Session request failed:', error);
      return false;
    }
    session = requested;
    controlsOpen = false;
    watchVisible = true;
    held.menu = false;
    hud.invalidate();
    nativeRenderScale = xrNativeRenderScale(requested);
    // Native scale is useful context but not a ceiling: several runtimes accept supersampling above it. Hand
    // Three the user's full request and let the measured viewport decide whether it was actually capped.
    appliedRenderScale = deps.renderScale;
    session.addEventListener('end', onSessionEnd);
    cameraNearHome = deps.camera.near;
    setXrNearPlane();

    deps.scene.add(rig);
    cameraHome = deps.camera.parent;
    viewRig.add(deps.camera); // the immediate parent offsets only the rendered XR eyes; the body stays on `rig`
    deps.scene.add(parked.group);
    deps.scene.add(heldBoardBoostTrail.mesh);
    deps.scene.add(footRider.group);
    deps.scene.add(watchPointer.object);
    deps.scene.add(boardActionGuides.left.object, boardActionGuides.right.object);
    if (statsEnabled) viewRig.add(profiler.object); // full profiler follows the presented headset, not avatar IK
    // Avoid one frame at the rig origin before a wrist space has supplied its first tracked transform.
    hud.object.visible = false;

    const xr = deps.renderer.xr;
    xr.enabled = true;
    // Before `setSession`, because that is when the layer — and with it the eye buffer's size — is made.
    xr.setFramebufferScaleFactor(appliedRenderScale);
    // Fixed policy rather than a controller toggle: Three retains this request and applies it as the XR layer is
    // constructed. Runtimes without fixed foveation may ignore it; the profiler continues to report the layer's
    // actual value rather than pretending the request succeeded.
    xr.setFoveation(1);
    // `local-floor` is not merely preferred: the rig origin IS the rider's feet throughout, so a space measured
    // from the head instead would stand the walker a head's height inside the snow. A runtime that cannot serve
    // one is refused here rather than played wrong.
    xr.setReferenceSpaceType('local-floor');
    // Three selects its projection path from the binding's createProjectionLayer capability. Temporarily
    // hide it for the WebGL comparison and restore it even if session setup fails (see config.ts).
    layerOverrideApplied = false;
    try {
      await deps.prepareContext();
      if (session !== requested) throw new Error('XR session ended during context preparation');
      const antialias = deps.prepareAntialias(deps.antialias);
      antialiasApplied = antialias.applied;
      const restoreLayers = deps.layerMode === 'webgl' ? maskXrLayersForThree() : null;
      try {
        await xr.setSession(session);
      } finally {
        // Restore browser capabilities before failure cleanup can await session.end() or notify listeners.
        restoreLayers?.();
        antialias.restore();
      }
      layerOverrideApplied = !!restoreLayers && xrLayerKind(xr.getBaseLayer()) === 'webgl';
    } catch (error) {
      console.error('[Slopesmith XR] Initialization failed:', error);
      session = null;
      requested.removeEventListener('end', onSessionEnd);
      await requested.end().catch(() => {});
      teardownScene();
      return false;
    }

    void requestBestFrameRate(session);
    thirdPerson = false;
    applyViewMode();
    window.addEventListener('keydown', onViewKey, true);
    viewKeyAttached = true;
    // Start on foot at the gate, with the board parked where the ride would have dropped it.
    rigFwd.set(deps.heading.x, 0, deps.heading.z);
    if (rigFwd.lengthSq() < 1e-6) rigFwd.set(0, 0, 1);
    rigFwd.normalize();
    parkBoardAt(deps.spawn, rigFwd);
    resetOnFoot();
    // Do this only after requestSession/setSession have succeeded: building a TestRide before those awaits can
    // consume the click's transient user activation and make WebXR reject the request. The opening transition
    // is also the least disruptive place to pay the one unavoidable synchronous collision/BVH build.
    retainedRide = deps.prepareRide?.(gaze) ?? null;
    return true;
  }

  /**
   * Ask the runtime for its FASTEST supported rate.
   *
   * A session does not automatically run at the headset's configured refresh: WebXR starts it at the runtime's
   * default — commonly 72 — and an application that wants more has to say so. A test ride is exactly the case
   * that wants more, because judder is the thing being judged.
   *
   * Best-effort throughout: `supportedFrameRates` is an optional part of the spec, several desktop runtimes ship
   * neither it nor `updateTargetFrameRate`, and a runtime may simply decline. None of that is worth failing a
   * session over, so every step is guarded and a refusal leaves the default rate standing.
   */
  async function requestBestFrameRate(target: XRSession) {
    const rates = target.supportedFrameRates;
    if (!rates?.length || typeof target.updateTargetFrameRate !== 'function') return;
    let best = 0;
    for (const rate of rates) if (rate > best) best = rate;
    if (best <= (target.frameRate ?? 0)) return;
    try { await target.updateTargetFrameRate(best); } catch { /* the runtime kept its own rate */ }
  }

  /** Leave VR. The `end` event does the teardown, whichever side asked for it. Safe to call twice: Esc at the
   *  desk reaches both the mounted board's own exit and the editor's Escape ladder, and a session already on its
   *  way out rejects a second `end`. */
  function exit() { session?.end().catch(() => {}); }

  function onSessionEnd() {
    session?.removeEventListener('end', onSessionEnd);
    session = null;
    if (ride) { ride = null; deps.stopRide(); }
    offBoardRun = null;
    boardGrab.clear(); // whatever was in a hand is not in a hand any more; there is no hand
    wristsTracked = false;
    teardownScene();
    deps.onExit();
  }

  /** Take the rig, the board and the camera back out of the scene. Shared by a clean end and a refused start. */
  function teardownScene() {
    if (viewKeyAttached) {
      window.removeEventListener('keydown', onViewKey, true);
      viewKeyAttached = false;
    }
    hud.object.removeFromParent();
    profiler.object.removeFromParent();
    parked.group.removeFromParent();
    heldBoardBoostTrail.mesh.removeFromParent();
    footRider.group.removeFromParent();
    watchPointer.object.removeFromParent();
    boardActionGuides.left.hide();
    boardActionGuides.right.hide();
    boardActionGuides.left.object.removeFromParent();
    boardActionGuides.right.object.removeFromParent();
    rig.removeFromParent();
    if (deps.camera.parent !== viewRig) return; // never taken, or already handed back
    deps.camera.removeFromParent();
    cameraHome?.add(deps.camera);           // usually nothing: the editor camera lives outside the scene graph
    // The rig carried the camera's world placement; hand it back at identity so the restored editor view — which
    // writes world position and quaternion directly — is not silently offset by a stale parent transform.
    deps.camera.position.set(0, 0, 0);
    deps.camera.quaternion.identity();
    if (cameraNearHome !== null) {
      deps.camera.near = cameraNearHome;
      deps.camera.updateProjectionMatrix();
      cameraNearHome = null;
    }
    cameraHome = null;
  }

  /** A mounted TestRide configures its chase-camera near plane while it starts, so reclaim the XR value after
   * every mount as well as at session entry. Three forwards this camera range to XRSession.renderState. */
  function setXrNearPlane() {
    if (deps.camera.near === XR_NEAR_CLIP) return;
    deps.camera.near = XR_NEAR_CLIP;
    deps.camera.updateProjectionMatrix();
  }

  function dispose() {
    if (session) { exit(); return; }
    hud.dispose();
    profiler.dispose();
    parked.dispose();
    heldBoardBoostTrail.dispose();
    footRider.dispose();
    watchPointer.dispose();
    boardActionGuides.left.dispose();
    boardActionGuides.right.dispose();
    hands.dispose();
  }

  // ---------------------------------------------------------------------------------------------------------
  // per-frame

  /**
   * Before the world steps: read the headset and the controllers, then let the state the rider is in act on
   * them. Riding, that is handing the frame's controls to the board so the physics ticks on them; on foot it is
   * the walker's own step, which happens here because nothing downstream simulates it.
   */
  function beginFrame(frame: XRFrame | null | undefined, dt: number) {
    if (!session) return;
    footFrameDt = Math.min(Math.max(0, dt), 0.1);
    if (!ride) footContactFrom.copy(walker.position());
    stepCoastingBoard(footFrameDt);
    readHead(frame);
    const pads = readPads(session.inputSources);
    // Optical joints win where they exist; a controller hand falls back to its grip and trigger.
    handA.curl = hands.fingerCurls('left') ?? controllerFingerCurls(pads.left);
    handB.curl = hands.fingerCurls('right') ?? controllerFingerCurls(pads.right);
    hands.updateControllers(pads, !!ride);
    const trigger = !!pads.left?.trigger || !!pads.right?.trigger;
    const pressTrigger = trigger && !held.trigger;
    const rightTrigger = !!pads.right?.trigger;
    const pressRightTrigger = rightTrigger && !held.rightTrigger;
    const pressA = !!pads.right?.a && !held.a;
    const pressX = !!pads.left?.a && !held.x;
    const viewHeld = viewToggleHeld(pads);
    const pressView = viewHeld && !held.view;
    const menuHeld = wristMenuToggleHeld(pads);
    const pressMenu = menuHeld && !held.menu;
    // The grip's two edges are both meaningful and they are not the same event: closing a hand takes the deck,
    // opening the one that HAS it throws it. Read in every state for the same reason the others are — the grip
    // that snatches the board off your feet is the grip that then throws it, so an edge seen in only one branch
    // would read a hand still closed from the other as a fresh squeeze.
    const grab = grabControls(pads);
    const pressGrab = { left: grab.left && !heldGrab.left, right: grab.right && !heldGrab.right };
    const releaseGrab = { left: !grab.left && heldGrab.left, right: !grab.right && heldGrab.right };
    heldGrab.left = grab.left;
    heldGrab.right = grab.right;
    held.trigger = trigger;
    held.rightTrigger = rightTrigger;
    held.a = !!pads.right?.a;
    held.x = !!pads.left?.a;
    held.view = viewHeld;
    held.menu = menuHeld;
    if (pressView) toggleView();
    if (pressMenu) {
      watchVisible = !watchVisible;
      // Hide immediately, before this frame can acquire a stale watch action. Showing is placed against the
      // freshly tracked wrist in `endFrame`, after the rig has reached its final pose.
      if (!watchVisible) {
        hud.object.visible = false;
        watchPointer.hide();
      } else hud.invalidate();
    }

    const watchAction = pressRightTrigger ? watchTriggeredAction() : null;
    if (watchAction === 'exit') { exit(); return; }
    if (watchAction === 'stats') setStatsEnabled(!statsEnabled);
    if (watchAction === 'view') toggleView();
    if (watchAction === 'controls') {
      controlsOpen = !controlsOpen;
      hud.invalidate();
    }
    if (watchAction === 'restart') {
      restartAtGate();
      deps.setFlightBoostAudio(false, dt);
      deps.stepFootContact?.(footContactFrom, walker.position(), walker.velocity(), footFrameDt);
      return;
    }
    if (watchAction === 'calibrate') startCalibration(performance.now());
    if (calibrationRun) {
      // Stand still while the three-second capture is live; no trigger edge from clicking the watch may also
      // mount the board, and stick drift must not walk the floor out from beneath the T-pose.
      walker.step(dt, { moveX: 0, moveY: 0, forward: headFwd, jump: false });
      deps.setFlightBoostAudio(false, dt);
      deps.stepFootContact?.(footContactFrom, walker.position(), walker.velocity(), footFrameDt);
      return;
    }

    if (ride) {
      const controls = rideControls(pads);
      if (watchAction) controls.ollie = false;
      ride.setXrControls(controls);
      if (pressX && controls.courseRespawn) { ride.resetToCourse(); return; }
      if (!watchAction && pressTrigger) { dismount(); return; }
      // The grip, WHILE RIDING: snatch the deck out from under you. Air only — on the snow it would rip the
      // board out of a carve every time a hand strayed, and this wants to be a trick, not a hazard.
      if (pressGrab.left && takeFromFeet('left')) return;
      if (pressGrab.right && takeFromFeet('right')) return;
      return;
    }

    const controls = footControls(pads);
    if (pressX && controls.spawnBoard) {
      spawnBoardAhead();
      deps.setFlightBoostAudio(false, dt);
      deps.stepFootContact?.(footContactFrom, walker.position(), walker.velocity(), footFrameDt);
      return;
    }
    const turn = smoothTurnRadians(controls.turn, dt);
    if (turn) rigFwd.applyAxisAngle(WORLD_UP, turn).normalize();
    walker.step(dt, {
      moveX: controls.moveX, moveY: controls.moveY, forward: headFwd,
      jump: pressA,
      jumpHeld: controls.jump,
      // Off-board boost never spends the retained run meter. A held deck replaces the controller ray with its
      // own +Z nose and becomes a floor-launching jetpack; empty-handed flight keeps its existing aimed control.
      boost: controls.boost,
      boostDirection: controls.boost ? offBoardBoostDirection() : undefined,
      boardJetpack: controls.boost && boardGrab.held,
    });
    deps.setFlightBoostAudio(walker.isFlightBoosting(), dt);
    deps.stepFootContact?.(footContactFrom, walker.position(), walker.velocity(), footFrameDt);
    // The grip CARRIES, and that is the whole of what it does. The behind-head sword draw has first claim, so a
    // nearby board on the snow still enters the authored summon pose instead of becoming a contact-point grab.
    // Otherwise a closing hand takes a deck it can reach — including out of the other hand — and opening the
    // holding hand throws it exactly as hard as it was being swung.
    for (const hand of GRAB_HANDS) {
      if (pressGrab[hand]) { if (!summonToHand(hand)) takeInHand(hand); }
      else if (releaseGrab[hand] && boardGrab.hand === hand) releaseBoard();
    }
    // The trigger RIDES. Holding the deck, that means putting it back under your feet — which in the air is the
    // catch that lands the trick. Empty-handed it means the board you are POINTING at, still ground-gated so an
    // airborne trigger cannot unexpectedly recall a distant board into the flight path.
    if (!watchAction && pressTrigger) {
      if (boardGrab.held) mountFromHand();
      else if (walker.isGrounded() && aimedAtDeck()) mount();
    }
  }

  /** After the world steps: seat the rig on whatever the rider is standing on, and repaint the wrist panel. */
  function endFrame() {
    if (!session) return;
    if (!ride && offBoardRun) {
      offBoardRun.stepRunOffBoard(footFrameDt, walker.isGrounded(), boardGrab.hand);
      if (!offBoardRun.runStatus) offBoardRun = null;
    }
    if (ride) {
      const view = ride.renderView();
      // The seat carries the STICK's turn intent with the board; the accumulator is monotonic, so the frame
      // takes the delta over however many 60 Hz ticks it happened to spend.
      const yaw = ride.state.seatYaw;
      if (yaw !== seatYawRead) {
        rigFwd.applyAxisAngle(WORLD_UP, yaw - seatYawRead).normalize();
        seatYawRead = yaw;
      }
      // Feet on the DECK, which is where the pose draws it: the physics point plus the surface's own visual lift
      // along the board's up. The head's X/Z at mount is the station anchor; later room-scale displacement is
      // therefore carried 1:1 without an initial jump caused by where the runtime's play-space origin happened
      // to be.
      rig.position.copy(view.pos)
        .addScaledVector(ride.state.boardUp, ride.state.lift)
        .addScaledVector(WORLD_UP, DECK_STAND + eyeLift);
      setRigYaw();
      scratch.set(seatHeadAnchor.x, 0, seatHeadAnchor.z).applyQuaternion(rig.quaternion);
      rig.position.sub(scratch);
    } else {
      // The walker has already advanced by this frame's accepted physical head delta. Canceling the current
      // local offset here therefore does NOT erase room-scale motion: it leaves the rig origin stable while the
      // head and walker advance together, and makes a smooth turn rotate in place rather than around the room.
      setRigYaw();
      scratch.set(headLocal.x, 0, headLocal.z).applyQuaternion(rig.quaternion);
      rig.position.copy(walker.position()).sub(scratch);
      rig.position.y = walker.position().y + eyeLift;
    }
    rig.updateMatrixWorld(true);
    resolveHeadWorld();
    if (statsEnabled) placeReadout(profiler.object);
    if (watchVisible) hands.placeWatch(hud.object);
    else hud.object.visible = false;
    updateWatchPointer();
    // After the rig has moved, so the hands are read at this frame's seat rather than the last one's, and the
    // arms do not trail the board down the hill.
    const tracked = hands.worldTargets(handA, handB);
    wristsTracked = tracked;
    finishCalibration(performance.now(), tracked);
    if (tracked) hands.applyCalibration(handA, handB, calibration?.hands);
    // With the wrists re-read at this frame's seat: the carried deck goes on the hand, and a loose one lights
    // up if a hand could take it.
    updateHeldBoard();
    updateBoardActionGuides();
    if (ride) {
      footRider.group.visible = false;
      ride.setXrHead(headWorld, headQuat);
      ride.setXrHands(tracked ? handA : null, tracked ? handB : null);
    } else updateFootRider(tracked);
    paintHud(performance.now());
  }

  /** Right-controller pointer against an enabled canvas-space action on the left-wrist watch. */
  function watchActionHit(): { hit: THREE.Intersection<THREE.Object3D>; action: XrHudAction } | null {
    if (!hud.object.visible || !hands.presentationAimRay('right', watchRaycaster.ray)) return null;
    hud.object.updateWorldMatrix(true, false);
    const hit = watchRaycaster.intersectObject(hud.object, false)[0];
    const action = hit?.uv ? hud.actionAt(hit.uv, controlsOpen) : null;
    if (!hit || !action || !watchActionEnabled(action)) return null;
    return { hit, action };
  }

  function watchActionEnabled(action: XrHudAction): boolean {
    return action === 'restart' || action === 'stats' || action === 'view' || action === 'controls'
      || action === 'exit'
      || (!ride && !calibrationRun);
  }

  function watchTriggeredAction(): XrHudAction | null { return watchActionHit()?.action ?? null; }

  /** Attach/detach every diagnostic cost as one live switch, and remember the choice for the next session. */
  function setStatsEnabled(enabled: boolean) {
    if (statsEnabled === enabled) return;
    statsEnabled = enabled;
    if (enabled) {
      viewRig.add(profiler.object);
      nextLog = 0;
    } else profiler.object.removeFromParent();
    deps.onStatsChanged?.(enabled);
  }

  /** The beam appears only once the padded button target is acquired, so it confirms exactly what a trigger
   * will press without leaving a permanent laser floating through play. */
  function updateWatchPointer() {
    const target = watchActionHit();
    if (target) watchPointer.show(watchRaycaster.ray.origin, target.hit.point);
    else watchPointer.hide();
  }

  function startCalibration(now: number) {
    if (ride || calibrationRun) return;
    calibrationRun = { startedAt: now };
    calibrationNotice = null;
  }

  /** Land the T-pose after its three full seconds. Controller span is independent of the bad floor origin; the
   * resulting floor offset is applied on the next rig seat and persisted for later standing or seated play. */
  function finishCalibration(now: number, handsTracked: boolean) {
    if (!calibrationRun || now - calibrationRun.startedAt < 3000) return;
    calibrationRun = null;
    const gripsTracked = handsTracked && hands.worldTrackerPositions(calibrationGripA, calibrationGripB);
    const captured = gripsTracked
      ? captureXrBodyCalibration(headLocal.y, calibrationGripA, calibrationGripB)
      : null;
    if (!captured) {
      calibrationNotice = { phase: 'error', until: now + 4000, message: 'EXTEND BOTH HANDS' };
      return;
    }
    const sources = hands.trackingSources();
    const capturedHands = sources && captureXrHandCalibration(
      handA.quaternion, handB.quaternion, headFwd, sources.left, sources.right,
    );
    if (!capturedHands) {
      calibrationNotice = { phase: 'error', until: now + 4000, message: 'LOOK FORWARD' };
      return;
    }
    captured.hands = capturedHands;
    calibration = captured;
    saveXrBodyCalibration(captured);
    eyeLift = captured.floorOffset;
    eyeCalibrated = true;
    calibrationNotice = { phase: 'saved', until: now + 4000 };
    console.info(`[xr calibration] body ${captured.standingHeight.toFixed(2)}m`
      + ` · eyes ${captured.eyeHeight.toFixed(2)}m · grips ${captured.gripSpan.toFixed(2)}m`
      + ` · rawY ${captured.rawStandingEyeY.toFixed(2)}m · floor ${captured.floorOffset.toFixed(2)}m`);
  }

  function calibrationHud(now: number): XrHudCalibration {
    if (calibrationRun) {
      const elapsed = Math.max(0, now - calibrationRun.startedAt);
      return { phase: 'countdown', count: Math.max(1, 3 - Math.floor(elapsed / 1000)) };
    }
    if (calibrationNotice && now < calibrationNotice.until) {
      return calibrationNotice.phase === 'saved'
        ? { phase: 'saved', standingHeight: calibration?.standingHeight }
        : { phase: 'error', message: calibrationNotice.message };
    }
    calibrationNotice = null;
    return { phase: 'ready', standingHeight: calibration?.standingHeight };
  }

  /** The local body while no board exists. It uses the same production three-point solver as remote VR players:
   * feet on the walker, eye bridge at the HMD, hands at the grips, with only the wearer's own head chopped. */
  function updateFootRider(handsTracked: boolean) {
    const velocity = walker.velocity();
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const targetWalk = THREE.MathUtils.clamp(horizontalSpeed / 1.2, 0, 1);
    footWalkWeight += (targetWalk - footWalkWeight) * (1 - Math.exp(-10 * footFrameDt));
    if (horizontalSpeed > 0.05) {
      footWalkPhase += footFrameDt * Math.PI * 2 * (1.2 + Math.min(horizontalSpeed, 7) * 0.22);
      if (footWalkPhase > Math.PI * 2) footWalkPhase %= Math.PI * 2;
    }
    footAnkleA.copy(parked.ankleFront).add(walker.position());
    footAnkleB.copy(parked.ankleRear).add(walker.position());
    // Physical headset yaw owns the local body's facing. Keep the last horizontal heading while looking almost
    // straight up/down, where projecting gaze onto the floor has no stable yaw.
    headsetBodyFacing(headQuat, footFacing.lengthSq() > 1e-8 ? footFacing : rigFwd, scratchB);
    footFacing.copy(scratchB);
    const input = {
      ankleFront: footAnkleA, ankleRear: footAnkleB,
      deckUp: WORLD_UP, soleUp: WORLD_UP, bank: 0,
      vel: velocity, accel: footAcceleration, grounded: walker.isGrounded(), dt: footFrameDt,
      crouch: 0, lean: 0,
      locomotion: {
        phase: footWalkPhase, weight: footWalkWeight, facing: footFacing, flying: walker.isFlying(),
      },
      handTargets: handsTracked ? { a: handA, b: handB } : null,
      headTarget: { position: headWorld, quaternion: headQuat, exactPosition: true },
    };
    if (footRiderPlaced) footRider.pose(input);
    else { footRider.reset(input); footRiderPlaced = true; }
    footRider.group.visible = true;
  }

  /**
   * Level, and yawed so the rider FACES the seat heading. The rig is the wearer's frame, and a wearer looks
   * down −Z — so the yaw solves `q·(0,0,−1) = rigFwd`, not `q·(0,0,1)`. Getting that backwards seats the rider
   * facing up the mountain with every control mirrored, which is exactly as confusing as it sounds.
   *
   * Built from the angle rather than a between-vectors rotation, so an exactly-reversed heading cannot pick an
   * arbitrary perpendicular axis and roll the horizon.
   */
  function setRigYaw() {
    rig.quaternion.setFromAxisAngle(WORLD_UP, viewerYaw(rigFwd));
  }

  /** V at the desk remains useful to an emulator/mirrored headset; capture phase makes this session the sole
   * owner even while a mounted TestRide has its ordinary keyboard listener attached. */
  function onViewKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (event.key.toLowerCase() !== 'v' || event.repeat || target?.matches?.('input, textarea, select')) return;
    toggleView();
    event.preventDefault();
    event.stopPropagation();
  }

  function toggleView() {
    thirdPerson = !thirdPerson;
    applyViewMode();
  }

  function applyViewMode() {
    xrViewOffset(thirdPerson, viewRig.position);
    viewRig.updateMatrixWorld(true);
    footRider.setFirstPerson(!thirdPerson);
    ride?.setFirstPerson(!thirdPerson);
  }

  /**
   * Park the read-out ahead of and below the rider, aimed at their eyes.
   *
   * Held at the HEAD's horizontal offset under the presentation root, so a wearer standing off-centre in their
   * play space finds it in front of themselves rather than in front of the room. In third person that root moves
   * with the headset/controllers, not the avatar head. Aimed by position alone (`lookAt`), so turning your head
   * does not turn the board — it re-aims only when you actually move, which keeps it parked rather than chasing.
   */
  function placeReadout(object: THREE.Object3D) {
    object.position.set(
      headLocal.x, headLocal.y - READOUT_DROP, headLocal.z - READOUT_DISTANCE, // rig −Z is the seat's forward
    );
    object.lookAt(scratch.copy(headLocal).applyMatrix4(viewRig.matrixWorld));
  }

  // ---------------------------------------------------------------------------------------------------------
  // head, rig yaw

  /**
   * The viewer pose, taken from the frame rather than from the renderer's XR camera: this runs BEFORE the render
   * that updates that camera, and steering off a pose one frame stale is exactly the kind of lag a rider feels
   * as the board lagging their look. Without a pose (tracking lost) the last one stands, which is what the
   * runtime itself does with the view.
   */
  function readHead(frame: XRFrame | null | undefined) {
    const space = deps.renderer.xr.getReferenceSpace();
    const pose = frame && space ? frame.getViewerPose(space) : null;
    if (pose) {
      const t = pose.transform;
      const nextHead = trackedRoomMove.set(t.position.x, t.position.y, t.position.z);
      if (previousHeadTracked) {
        const accepted = trackedRoomDelta(previousHeadLocal, nextHead, rig.quaternion, scratchB);
        if (accepted) {
          if (!ride && trackedRoomMoveReady(pendingTrackedRoomMove, scratchB)) {
            walker.moveTracked(pendingTrackedRoomMove);
            pendingTrackedRoomMove.set(0, 0, 0);
          }
        } else {
          pendingTrackedRoomMove.set(0, 0, 0);
          if (ride) {
            // A runtime recenter moves both the current pose and the station anchor, preserving the visible seat.
            seatHeadAnchor.x += nextHead.x - previousHeadLocal.x;
            seatHeadAnchor.z += nextHead.z - previousHeadLocal.z;
          }
        }
      }
      previousHeadLocal.copy(nextHead);
      previousHeadTracked = true;
      headLocal.set(t.position.x, t.position.y, t.position.z);
      headLocalQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      if (!eyeCalibrated) {
        eyeCalibrated = true;
        if (calibration && calibrationMatchesOrigin(calibration, headLocal.y)) {
          eyeLift = calibration.floorOffset;
        } else {
          // A runtime can repair/change its origin between launches. A stale 15-foot correction must not put a
          // newly-correct local-floor session underground, so reject it and fall back until the next T-pose.
          if (calibration) { clearXrBodyCalibration(); calibration = null; }
          eyeLift = fallbackFloorOffset(headLocal.y);
          if (Math.abs(eyeLift) > 1e-4) console.warn(`[xr calibration] implausible raw eye Y `
            + `${headLocal.y.toFixed(2)}m; applying temporary ${eyeLift.toFixed(2)}m floor correction. `
            + 'Use the wrist T-POSE button to calibrate.');
        }
      }
    }
    resolveHeadWorld();
  }

  function resolveHeadWorld() {
    rig.updateMatrixWorld(true);
    headWorld.copy(headLocal).applyMatrix4(rig.matrixWorld);
    headQuat.copy(rig.quaternion).multiply(headLocalQuat);
    // A VIEWER looks down its own −Z, like every camera: this is the direction the rider is actually facing, and
    // it is what walking, mount reach and the independently posed avatar head are measured against.
    headFwd.copy(VIEW_FORWARD).applyQuaternion(headQuat).normalize();
  }

  /** Raw headset look direction for the mounted board's head steering. The tracked avatar head consumes the
   * same quaternion independently, while its chest and shoulders face the board heading produced from this. */
  function gaze(): THREE.Vector3 | null { return session ? headFwd : null; }

  /** Empty-handed off-board boost retains the right-controller ray. A deck in either hand supersedes this. */
  function controllerBoostAim(): THREE.Vector3 | null {
    return session && hands.aimRay('right', boardBoostRay) ? boardBoostRay.direction : null;
  }

  /** The physical board's nose is the jetpack nozzle axis, independent of which hand carries it. */
  function offBoardBoostDirection(): THREE.Vector3 | null {
    if (!boardGrab.held) return controllerBoostAim();
    return heldBoardBoostDirection.set(0, 0, 1).applyQuaternion(parked.group.quaternion).normalize();
  }

  /** Off-board auto-recovery follows the same live scoring phase as the mounted board. */
  function scoredRunActive(): boolean {
    return (ride ?? offBoardRun ?? retainedRide)?.runStatus?.phase === 'running';
  }

  /** Everything another browser can actually observe: the board or walker root, plus real headset/controller
   * tracking when the runtime supplies it. Controller slots stay unnamed; the rider IK assigns by shoulder. */
  function playerPose(): LocalPlayerPose | null {
    if (!session) return null;
    // A viewer faces local −Z; the avatar/board convention faces local +Z. The half-turn converts between them
    // so an on-foot remote body faces the same direction as its tracked head instead of walking backwards.
    const bodyQ = rig.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(WORLD_UP, Math.PI));
    const base: LocalPlayerPose = ride ? ride.playerPose() : {
      mode: 'walk', vr: true, gear: deps.gear ?? DEFAULT_RIDE_GEAR,
      stance: deps.snowboardStance ?? DEFAULT_SNOWBOARD_STANCE,
      body: transform(walker.position(), bodyQ), velocity: vector(walker.velocity()),
      equipment: {
        state: boardGrab.held ? 'held' : 'loose',
        transform: transform(parked.group.position, parked.group.quaternion),
        velocity: vector(boardGrab.held ? boardGrab.velocity : boardCoast.vel),
        epoch: boardCoast.epoch,
      },
      animation: {
        grounded: walker.isGrounded(), crouch: 0, lean: 0, bank: 0,
        ...(walker.isFlying() ? { flying: true } : {}),
      },
    };
    const tracked = hands.worldTransforms(calibration?.hands);
    return {
      ...base, vr: true,
      ...(ride && base.equipment ? { equipment: { ...base.equipment, epoch: boardCoast.epoch } } : {}),
      head: transform(headWorld, headQuat),
      ...(tracked[0] || tracked[1] ? { hands: tracked } : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------------------
  // mount / dismount

  /**
   * POINTING at the board — the trigger's target. A ray from either controller against the deck's own outline,
   * which is what the shipped board's mount is too (`Interact` is VRChat's use-ray). Aiming rather than
   * proximity is what keeps the trigger and the grip meaning two different things standing in the same place:
   * point at the deck to get ON it, put a hand on the deck to pick it UP.
   */
  function aimedAtDeck(): boolean {
    if (!parked.group.visible || boardGrab.held) return false;
    for (const hand of GRAB_HANDS) {
      if (!hands.aimRay(hand, mountRay)) continue;
      const distance = deckRayDistance(parked.grabBox, parked.group.position, parked.group.quaternion, mountRay);
      if (distance !== null && distance <= MOUNT_AIM_RANGE) return true;
    }
    return false;
  }

  /**
   * Step onto the board you are POINTING at, wherever it is lying. It keeps its parked facing — a deck is
   * symmetric and switch is a real way to ride — except that a rider looking at it from behind gets the near
   * end as the nose, which is what stepping on actually does. The seat is NOT reoriented: it is pinned, and it
   * was already pointing where you look.
   */
  function mount() {
    scratchB.copy(parkedFacing);
    if (scratchB.dot(headFwd) < 0) scratchB.negate();
    const started = deps.startRide(parked.group.position.clone(), scratchB.clone(), gaze);
    if (!started) return;
    pendingTrackedRoomMove.set(0, 0, 0);
    setXrNearPlane();
    ride = started;
    retainedRide = started;
    offBoardRun = null;
    if (runArmed) { started.startRun(); runArmed = false; }
    ride.setFirstPerson(!thirdPerson);
    footRider.group.visible = false;
    seatYawRead = started.state.seatYaw;
    seatHeadAnchor.set(headLocal.x, 0, headLocal.z);
    boardCoast.stop(); // the deck belongs to a rider again; the coast has nothing left to say about it
    parked.highlight(false);
    parked.group.visible = false;
    setHudHint('Hold A jump · B boost · trigger get off · grip take it off');
  }

  /**
   * Get off, wherever you are. A rider who jumps off in mid-air keeps the board's arc rather than being stranded
   * in the sky — the board's own `CarryTrajectoryOnExit` (Unity docs/vrchat/017), which exists because a seated
   * passenger has no velocity of their own. The rider takes the full velocity and point in the air they left
   * from, so the jump carries on instead of resuming on the snow below it. The loose board takes the complete
   * velocity too, then its stronger 14 m/s² gravity separates it from the rider's 9.81 m/s² arc.
   *
   * The deck is not put away either. It takes the same arc and coasts off on its own (`board-coast.ts`) — falls,
   * lands, slides on down the hill and settles — which is what makes stepping off mid-flight cost something:
   * you have to go and find it.
   */
  function dismount() {
    if (!ride) return;
    pendingTrackedRoomMove.set(0, 0, 0);
    const view = ride.renderView();
    const departing = ride;
    const airborne = !departing.state.grounded;
    const at = view.pos.clone();
    // Unity transfers RideableBoard._vel here, not its interpolated presentation pose. Using renderView().vel
    // can hand both halves of a dismount an older (occasionally near-zero) sample, making the loose deck appear
    // to stop at the exact moment the rider gets off. Keep the rendered position for a seamless visual handoff,
    // and hand that authoritative physics velocity to both board and rider without modifying either one.
    const coastVelocity = departing.state.vel.clone();
    const carry = airborne ? coastVelocity.clone() : undefined;
    // Launched off the board's OWN axes, so a deck let go of on a bank starts lying on that bank.
    boardCoast.launch(at, coastVelocity, departing.state.fwd, departing.state.boardUp);
    offBoardRun = airborne && departing.runStatus ? departing : null;
    if (!offBoardRun) departing.abandonRun();
    ride = null;
    deps.stopRide();
    footRiderPlaced = false;
    footRider.group.visible = true;
    drawCoastingBoard();
    // Leave the feet under the physically displaced head rather than snapping back to the board's station root.
    scratch.copy(headWorld).setY(at.y);
    walker.placeAt(scratch, carry);
  }

  // ---------------------------------------------------------------------------------------------------------
  // the board in a hand

  /** That hand's wrist this frame, or null while tracking is out (a controller asleep, a hand out of view). */
  function wrist(hand: GrabHand): RiderHandTarget | null {
    if (!wristsTracked) return null;
    return hand === 'left' ? handA : handB;
  }

  /** How far that hand's closing fist is from the deck as it lies right now. Infinite with no wrist to measure. */
  function reachToDeck(hand: GrabHand): number {
    const at = wrist(hand);
    if (!at) return Infinity;
    return deckGrabDistance(parked.grabBox, parked.group.position, parked.group.quaternion,
      at.position, at.quaternion);
  }

  /**
   * A hand closed. What that means depends only on where the deck is: in the other hand it is a PASS, anywhere
   * else within reach it is a pick-up — off the snow, out of a coast, or out of a throw still in the air.
   *
   * Either way it enters the same upright palm-edge carry: right hand/right edge, left hand/left edge. The fist
   * only selects where along that edge, from tail to nose, the hand closes (`board-grab.ts`).
   */
  function takeInHand(hand: GrabHand): boolean {
    if (ride || boardGrab.hand === hand) return false;
    const at = wrist(hand);
    // Taking it off the snow is an arm's length; taking it out of the other hand means being ON the deck, or
    // every stray squeeze while carrying would flip the board between hands.
    if (!at || reachToDeck(hand) > (boardGrab.held ? HAND_TRANSFER_REACH : GRAB_REACH)) return false;
    // A pass hands it over without a throw: the old hand is no longer the holding hand, so its own release
    // edge lands on nothing.
    boardCoast.stop();
    boardGrab.grab(hand, at.position, at.quaternion,
      parked.group.position, parked.group.quaternion, parked.grabBox);
    parked.group.visible = true;
    parked.highlight(false); // it is in your hand; there is nothing left to point at
    return true;
  }

  /**
   * THE OVER-THE-SHOULDER SUMMON: reach behind your head and squeeze, and your board comes to your hand from
   * wherever it lies on the mountain (`BoardSummon`, Unity docs/vrchat/017). It is the sword-draw pose, and it is
   * the one thing that makes a board you threw off a cliff — or left at the gate three runs ago — not a walk.
   *
   * The outer waist edge comes just behind the controller in a controller-relative ready carry: from the palm
   * origin the gear is shifted 2 in toward the controller and 1.5 in toward the wearer. Its long edge follows the
   * controller's physical up/down edge, its topsheet faces the wearer, and the rest extends inward. Left and
   * right are mirrored. It snaps there on the closing grip without measuring the cross-map move as throw speed.
   */
  function summonToHand(hand: GrabHand): boolean {
    if (ride || boardGrab.held || !parked.group.visible) return false;
    const grip = wrist(hand);
    if (!grip || !handBehindHead(headWorld, headQuat, grip.position)) return false;
    boardCoast.stop();
    boardGrab.grab(hand, grip.position, grip.quaternion,
      parked.group.position, parked.group.quaternion, parked.grabBox, true);
    parked.highlight(false);
    return true;
  }

  /**
   * The grip WHILE RIDING: take the board off your feet and into your hand — the exact inverse of putting it
   * back. Boost off a lip, snatch the deck out from under you mid-flight, and land back on it.
   *
   * Air only. On the snow the grip would rip the board out from under a carve any time a hand strayed.
   *
   * Get off the ride FIRST, for the same reason the mount gets on it last: the rider stands on the board's own
   * pose, so pulling the deck up to a hand while still standing on it drags the body along after it. The rider
   * keeps the arc they were flying, exactly as a jump-off does, so this costs no speed — that is what makes
   * catching it again a trick rather than a recovery.
   */
  function takeFromFeet(hand: GrabHand): boolean {
    if (!ride || ride.state.grounded) return false;
    const grip = wrist(hand);
    if (!grip) return false;
    pendingTrackedRoomMove.set(0, 0, 0);
    const departing = ride;
    const view = departing.renderView();
    const at = view.pos.clone();
    const carry = view.vel.clone();
    // Seat the deck on the pose it was FLYING at before taking hold, so the fist selects the honest tail-to-nose
    // contact location. The shared grab then puts that chosen edge point into the standard upright palm pose.
    seatLooseBoard(at, departing.state.boardUp, view.fwd);
    boardCoast.stop();
    offBoardRun = departing.runStatus ? departing : null;
    ride = null;
    deps.stopRide();
    footRiderPlaced = false;
    footRider.group.visible = true;
    // The feet land under the physically displaced head, at the height and speed the board was carrying.
    scratch.copy(headWorld).setY(at.y);
    walker.placeAt(scratch, carry);
    boardGrab.grab(hand, grip.position, grip.quaternion,
      parked.group.position, parked.group.quaternion, parked.grabBox);
    parked.group.visible = true;
    return true;
  }

  /**
   * Open the holding hand. The deck leaves with the arc and the tumble it was being swung through, and flies
   * that out as a THROW — full ballistic arc, turning over — until it hits something, at which point it is an
   * ordinary loose board that slides and settles (`board-coast.ts`). Set it down gently and it simply lands.
   */
  function releaseBoard() {
    if (!boardGrab.held) return;
    boardGrab.release(thrown);
    // The flight continues from the pose it was let go of at: the coast's axes are seeded off the released
    // deck, or it would snap out of the hand's orientation at the very instant of release.
    grabbedUp.set(0, 1, 0).applyQuaternion(parked.group.quaternion);
    grabbedFwd.set(0, 0, 1).applyQuaternion(parked.group.quaternion);
    boardCoast.throwFrom(parked.group.position, thrown.velocity, grabbedFwd, grabbedUp, thrown.spin);
  }

  /**
   * The trigger, on a board already in your hand: set it down under your feet and ride it away.
   *
   * IN THE AIR this is the catch — the trick the whole carry exists for. The rider is flying the arc the board
   * handed them on the way off, so the ride has to resume THAT arc as it goes back under them; a fresh mount
   * starts at a standstill, which would stop them dead in the sky and drop them straight down.
   */
  function mountFromHand() {
    if (!boardGrab.held) return;
    const carry = walker.isGrounded() ? null : walker.velocity().clone();
    // Under the feet, facing the way the rider faces — a deck put back on is put on straight, whatever angle
    // it happened to be held at.
    scratchB.copy(headFwd).setY(0);
    if (scratchB.lengthSq() < 1e-6) scratchB.copy(rigFwd).setY(0);
    const started = deps.startRide(walker.position().clone(), scratchB.normalize().clone(), gaze);
    if (!started) return;
    pendingTrackedRoomMove.set(0, 0, 0);
    boardGrab.clear();
    boardCoast.stop();
    setXrNearPlane();
    ride = started;
    retainedRide = started;
    offBoardRun = null;
    if (runArmed) { started.startRun(); runArmed = false; }
    ride.setFirstPerson(!thirdPerson);
    if (carry) ride.resumeAirborne(carry);
    footRider.group.visible = false;
    seatYawRead = started.state.seatYaw;
    seatHeadAnchor.set(headLocal.x, 0, headLocal.z);
    parked.highlight(false);
    parked.group.visible = false;
    setHudHint('Hold A jump · B boost · trigger get off · grip take it off');
  }

  /**
   * Draw the carried deck on the wrist, and light a loose one up while a hand could take it. Runs at the END
   * of the frame, once the rig has been seated and the wrists re-read, so the board is on this frame's hand
   * rather than trailing the previous one's down the mountain.
   */
  function updateHeldBoard() {
    if (ride) { heldBoardBoostTrail.clear(); return; }
    const hand = boardGrab.hand;
    if (hand) {
      const at = wrist(hand);
      if (at) {
        boardGrab.follow(at.position, at.quaternion, footFrameDt,
          parked.group.position, parked.group.quaternion);
        // The heading a mount would step onto, kept live: put the deck down from a hand held sideways and the
        // ride starts pointing where the deck was actually pointing.
        parkedFacing.set(0, 0, 1).applyQuaternion(parked.group.quaternion).setY(0);
        if (parkedFacing.lengthSq() < 1e-6) parkedFacing.set(0, 0, 1); else parkedFacing.normalize();
      } // tracking dropped mid-carry: both deck and its last valid jet direction hold instead of jumping to zero
    } else parked.highlight(deckActionable());
    heldBoardBoostTrail.update({
      position: parked.group.position, quaternion: parked.group.quaternion, velocity: walker.velocity(),
      thrustDirection: heldBoardBoostDirection.set(0, 0, 1)
        .applyQuaternion(parked.group.quaternion).normalize(),
      active: boardGrab.held && walker.isFlightBoosting(), energy: 1, pad: false,
      gear: deps.gear ?? DEFAULT_RIDE_GEAR,
    }, footFrameDt);
  }

  /** Left X recalls the one session board to the snow ahead without moving or turning the walker. */
  function spawnBoardAhead() {
    scratchB.copy(headFwd).setY(0);
    if (scratchB.lengthSq() < 1e-6) scratchB.copy(rigFwd).setY(0);
    if (scratchB.lengthSq() < 1e-6) scratchB.set(0, 0, 1); else scratchB.normalize();
    scratch.copy(walker.position()).addScaledVector(scratchB, BOARD_SPAWN_AHEAD);
    // Ground queries cast down from the supplied height; start above nearby uphill terrain rather than at feet.
    scratch.y += FALLBACK_EYE_HEIGHT;
    parkBoardAt(scratch, scratchB);
    parked.highlight(false);
  }

  /**
   * Wrist Restart is deliberately not course respawn. It abandons the current result, returns the rider and
   * loose board to their gate arrangement, resets opponents, and arms the NEXT mount to start a new run in the
   * ride's configured Race/Showoff/free mode.
   */
  function restartAtGate() {
    (ride ?? offBoardRun ?? retainedRide)?.abandonRun();
    if (ride) deps.stopRide();
    ride = null;
    offBoardRun = null;
    runArmed = true;
    pendingTrackedRoomMove.set(0, 0, 0);
    rigFwd.set(deps.heading.x, 0, deps.heading.z);
    if (rigFwd.lengthSq() < 1e-6) rigFwd.set(0, 0, 1); else rigFwd.normalize();
    parkBoardAt(deps.spawn, rigFwd);
    resetOnFoot();
    deps.restartField?.();
    setHudHint('Board ahead · trigger to ride · next mount starts a fresh run');
    hud.invalidate();
  }

  /** Put the walker back at the gate — the fall-off-the-mountain and full Restart placement. */
  function resetOnFoot() {
    // Beside the board rather than inside it, so the reset does not land the rider standing in the deck.
    scratch.copy(deps.spawn).addScaledVector(rigFwd, -1.2);
    pendingTrackedRoomMove.set(0, 0, 0);
    walker.placeAt(scratch);
    footRiderPlaced = false;
    footRider.group.visible = true;
  }

  /** Lay the board on the snow at a world point, facing `facing`, at rest — the gate post, and a reset. */
  function parkBoardAt(at: THREE.Vector3, facing: THREE.Vector3) {
    boardGrab.clear(); // a board put back on its post is out of whatever hand was holding it
    heldBoardBoostTrail.clear();
    boardCoast.park(at, facing);
    drawCoastingBoard();
  }

  /**
   * Advance a deck nobody is on, and draw it where it has got to. Stepped ahead of every branch of the frame so
   * a wrist-menu click or a three-second calibration pose cannot leave a board hanging in mid-air; a no-op the
   * moment it settles, and while the rider is on it.
   */
  function stepCoastingBoard(dt: number) {
    if (!boardCoast.active) return;
    boardCoast.step(dt);
    drawCoastingBoard();
  }

  /** Seat the visible deck on the coast's pose. */
  function drawCoastingBoard() {
    seatLooseBoard(boardCoast.pos, boardCoast.up, boardCoast.fwd);
  }

  /** Put the loose deck at an explicit pose. `parkedFacing` follows it, because that is the heading the next
   *  mount steps onto — a board that slid round now points where it ended up. */
  function seatLooseBoard(at: THREE.Vector3, up: THREE.Vector3, facing: THREE.Vector3) {
    parked.group.position.copy(at);
    coastRight.crossVectors(up, facing).normalize();
    parked.group.quaternion.setFromRotationMatrix(coastBasis.makeBasis(coastRight, up, facing));
    parkedFacing.copy(facing).setY(0);
    if (parkedFacing.lengthSq() < 1e-6) parkedFacing.set(0, 0, 1); else parkedFacing.normalize();
    parked.group.visible = true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // hud

  /**
   * The viewport's per-frame timing sample, taken after submission. Fed here as well as to the board so the
   * profiler survives a dismount, and so the worst-frame window keeps running while the rider walks.
   */
  function recordFramePerf(sample: RideFrameTimingSample, now: number) {
    if (!session) return;
    if (!eyeBufferReported) {
      const measurement = eyeBufferMeasurement();
      if (measurement.eyeWidth > 0 && measurement.eyeHeight > 0) {
        eyeBufferReported = true;
        const reconciled = deps.onEyeBufferMeasured?.(measurement);
        if (reconciled) {
          appliedRenderScale = reconciled.renderScale;
          maxRenderScale = reconciled.maxRenderScale;
        }
      }
    }
    if (!statsEnabled) return;
    recordRideFrameTimings(footPerf, sample);
    if (now - worstSince >= 1000) { worstShown = worstMs; worstMs = 0; worstSince = now; }
    worstMs = Math.max(worstMs, sample.frameMs);
    if (++framesSeen > RATE_WARMUP_FRAMES && sample.frameMs > 1) bestMs = Math.min(bestMs, sample.frameMs);
  }

  /** Read one eye's real viewport. The layer texture itself may pack two eyes side by side or use an array, so
   *  only the sub-camera viewport is authoritative; the layer dimensions are a first-frame fallback. */
  function eyeBufferMeasurement(): XrEyeBufferMeasurement {
    const xr = deps.renderer.xr;
    const layer = xr.getBaseLayer() as (XRWebGLLayer & {
      textureWidth?: number; textureHeight?: number;
    }) | null;
    const cameras = xr.getCamera().cameras;
    const views = cameras.length || 1;
    const viewport = cameras[0]?.viewport;
    const packed = layer?.framebufferWidth ?? layer?.textureWidth ?? 0;
    return {
      eyeWidth: viewport ? viewport.z : Math.round(packed / views),
      eyeHeight: viewport ? viewport.w : (layer?.framebufferHeight ?? layer?.textureHeight ?? 0),
      views,
      renderScale: appliedRenderScale,
      requestedScale: deps.renderScale,
      nativeRenderScale,
      maxRenderScale,
    };
  }

  /** The headset-side numbers the shared profiler cannot know: what the display is asking for, and how many
   *  pixels it is asking for them in. The eye buffer is the fill cost and it is NOT the canvas size — a headset
   *  routinely requests well over twice the monitor's pixels, per eye. */
  function hudPerf(): XrHudPerf {
    const xr = deps.renderer.xr;
    const layer = xr.getBaseLayer() as (XRWebGLLayer & {
      textureWidth?: number; textureHeight?: number; ignoreDepthValues?: boolean;
      fixedFoveation?: number | null; antialias?: boolean;
    }) | null;
    const layerKind = xrLayerKind(layer);
    /**
     * One eye's pixels, taken from the sub-camera's own VIEWPORT rather than from the layer.
     *
     * The layer cannot answer this: both an `XRWebGLLayer` framebuffer and three's default projection layer pack
     * the two eyes side by side into one texture, so its width is the pair — but a projection layer built as a
     * texture array would report one eye instead, and nothing on the layer says which shape it is. The viewport
     * is what the renderer actually draws into per eye, so it is right in every case. Reading the layer was
     * reporting a 3000 px eye as 6000.
     */
    const eyeBuffer = eyeBufferMeasurement();
    // The runtime's own answer where there is one, and an honest measurement where there is not. Never a
    // constant: an invented rate silently mis-scales the budget every other number on this panel is judged
    // against, which is worse than admitting we do not know.
    const reported = session?.frameRate;
    const rateKnown = typeof reported === 'number' && reported > 0;
    const displayHz = rateKnown ? reported : estimateDisplayHz(bestMs);
    const gl = deps.renderer.getContext();
    const attributes = gl.getContextAttributes();
    const contextAntialias = attributes?.antialias === true;
    const layerAntialias = layerKind === 'webgl' && typeof layer?.antialias === 'boolean'
      ? layer.antialias
      // Three r170 gives its projection target four samples exactly when the context requested AA.
      : layerKind === 'projection' ? antialiasApplied : null;
    // Three r170 creates only WebGL2 contexts, although its public return type still carries the old WebGL1 arm.
    const maxSamples = Number(gl.getParameter((gl as WebGL2RenderingContext).MAX_SAMPLES));
    const samples = layerKind === 'projection'
      ? (antialiasApplied ? Math.min(4, Number.isFinite(maxSamples) ? maxSamples : 4) : 0)
      : layerAntialias === false ? 0 : null; // XRWebGLLayer owns the count when its boolean says AA is on
    return {
      perf: ride?.perf ?? footPerf,
      worstMs: worstShown,
      budgetMs: displayHz > 0 ? 1000 / displayHz : 0, // 0 = unknown; the panel declines to colour against a guess
      displayHz,
      rateKnown,
      bestMs: Number.isFinite(bestMs) ? bestMs : 0,
      eyeWidth: eyeBuffer.eyeWidth,
      eyeHeight: eyeBuffer.eyeHeight,
      views: eyeBuffer.views,
      layerRequested: deps.layerMode,
      layerKind,
      layerOverrideApplied,
      depthIgnored: typeof layer?.ignoreDepthValues === 'boolean' ? layer.ignoreDepthValues : null,
      contextAntialias,
      layerAntialias,
      samples,
      powerPreference: attributes?.powerPreference ?? 'default',
      gpu: webGlRendererLabel(gl),
      renderScale: appliedRenderScale,
      // The LAYER's value, not the one we asked three for. Fixed foveation is largely a standalone-headset
      // feature: on PCVR the runtime commonly ignores it, and reporting the request back would have the panel
      // reporting the requested 1 while nothing at all happens to the frame. Reading the layer keeps the fixed
      // policy honest — it either reports the runtime's effective level or says the control is unavailable.
      foveation: typeof layer?.fixedFoveation === 'number' ? layer.fixedFoveation : null,
      rawHeadY: headLocal.y,
      correctedHeadY: headLocal.y + eyeLift,
      floorOffset: eyeLift,
      standingHeight: calibration?.standingHeight ?? null,
      nearClip: session?.renderState.depthNear ?? deps.camera.near,
      handTracking: hands.trackingLabel(calibration?.hands),
    };
  }

  /**
   * The same line the board shows, on the CONSOLE, once every couple of seconds while a session is up.
   *
   * Not redundant with the board: the board is inside the headset, and the person who has to act on these
   * numbers is at the desk with the devtools open — reading them off a panel and typing them out is the slowest
   * possible way to move a profiler reading two feet. One short string every 2 s is nothing next to a frame.
   */
  function logPerf(now: number, stats: XrHudPerf) {
    if (now < nextLog) return;
    nextLog = now + PERF_LOG_MS;
    const p = stats.perf;
    const one = (value: number) => value.toFixed(1);
    const gpu = p.gpuTimerState === 'unsupported' ? 'n/a'
      : p.gpuTimerState === 'disjoint' ? 'reset'
        : p.gpuMs === null ? 'pending' : one(p.gpuMs);
    const pacing = estimatedRidePacingMs(p);
    const outsideCpu = unmeasuredRideFrameMs(p);
    console.info(`[xr perf] ${Math.round(p.fps)} fps · frame ${one(p.frameMs)} of ${one(stats.budgetMs)}`
      + ` · ${Math.round(stats.displayHz)}Hz${stats.rateKnown ? '' : '(est)'} · best ${one(stats.bestMs)}`
      + ` · worst ${one(stats.worstMs)} · CPU ${one(measuredRideCpuMs(p))} · GPU ${gpu}`
      + ` · non-CPU ${one(outsideCpu)}`
      + (pacing === null ? ` · pacing≤ ${one(outsideCpu)}` : ` · pacing~ ${one(pacing)}`)
      + ` · XR ${one(p.xrBeginMs)}+${one(p.xrEndMs)}`
      + ` · walk ${one(p.walkCollisionMs)}ms/${p.walkGroundCasts}g/${p.walkSweeps}s/${p.walkTriangleTests}t/${p.walkLiveRefits}r`
      + ` · ride ${one(p.rideMs)} (phys ${one(p.physicsMs)} cast ${one(p.castMs)} AI ${one(p.aiMs)})`
      + ` · scene ${one(p.sceneMs)} world ${one(p.worldMs)} FX ${one(p.effectsMs)}`
      + ` render ${one(p.renderMs)}(${one(p.renderPrepMs)}p+${one(p.renderSubmitMs)}s)`
      + ` post ${one(p.postFrameMs)}`
      + ` · draw ${p.drawCalls} · ${p.renderTriangles} tris · ${p.programs} prog`
      + ` · list ${p.renderOpaqueItems}o/${p.renderTransparentItems}a/${p.renderTransmissiveItems}x`
      + ` trans(ref ${p.renderTransparentRefBatches}b+${p.renderTransparentRefIsolated}i`
      + `/auth ${p.renderTransparentAuthoredProps}/other ${p.renderTransparentOther}`
      + `${p.renderTransparentOtherSources ? `:${p.renderTransparentOtherSources}` : ''})`
      + ` · eye ${stats.eyeWidth}x${stats.eyeHeight} x${stats.views}`
      + ` = ${((stats.eyeWidth * stats.eyeHeight * stats.views) / 1e6).toFixed(1)} Mpix`
      + ` · layer requested ${stats.layerRequested} -> ${stats.layerKind}`
      + `${stats.layerRequested === 'webgl' ? (stats.layerOverrideApplied ? ' (forced)' : ' (FORCE FAILED)') : ''}`
      + ` · depth ${stats.depthIgnored === null ? 'unknown' : stats.depthIgnored ? 'ignored' : 'used'}`
      + ` · AA context ${stats.contextAntialias ? 'on' : 'off'}`
      + ` layer ${stats.layerAntialias === null ? 'unknown' : stats.layerAntialias ? 'on' : 'off'}`
      + ` samples ${stats.samples ?? 'runtime'}`
      + ` · power ${stats.powerPreference} · GPU ${stats.gpu}`
      + ` · foveation ${stats.foveation === null ? 'n/a' : stats.foveation.toFixed(2)}`
      + ` · scale ${appliedRenderScale}${appliedRenderScale === deps.renderScale ? '' : ` (requested ${deps.renderScale})`}`
      + ` · viewY ${stats.rawHeadY.toFixed(2)} -> ${stats.correctedHeadY.toFixed(2)}`
      + ` · floor ${stats.floorOffset.toFixed(2)}`
      + ` · body ${stats.standingHeight === null ? 'uncalibrated' : stats.standingHeight.toFixed(2) + 'm'}`
      + ` · near ${stats.nearClip.toFixed(2)}m`
      + ` · hands ${stats.handTracking}`
      + `${ride ? '' : ' · on foot'}`);
  }

  function paintHud(now: number) {
    const stats = statsEnabled ? hudPerf() : null;
    const run = (ride ?? offBoardRun)?.runStatus ?? null;
    if (stats) logPerf(now, stats);
    if (ride) {
      const st = ride.state;
      const state = {
        speed: st.vel.length(), grounded: st.grounded, lead: st.lead,
        grinding: st.railIdx >= 0, boosting: ride.boostActive(), charge: st.charging ? st.charge : 0,
      };
      hud.draw(now, state, null, calibrationHud(now), statsEnabled, thirdPerson, run,
        controlsOpen, 'ride', false);
      if (statsEnabled) profiler.draw(now, state, stats);
      return;
    }
    setHudHint(footHint());
    hud.draw(now, null, null, calibrationHud(now), statsEnabled, thirdPerson, run,
      controlsOpen, 'foot', !!boardGrab.held);
    if (statsEnabled) profiler.draw(now, null, stats);
  }

  function setHudHint(text: string) { hud.setHint(text); profiler.setHint(text); }

  /**
   * What the hands can do RIGHT NOW, on foot. Recomputed every frame rather than latched at each transition,
   * because the things worth prompting about are not transitions the rider made: the deck sliding into reach,
   * or a walk up to a board lying on the snow.
   */
  function footHint(): string {
    if (calibrationRun) return 'Hold still · arms straight out';
    if (boardGrab.held) return 'Trigger ride it · grip let go · other grip pass';
    const reachable = deckInHandReach(), aimed = aimedAtDeck();
    if (reachable && aimed) return 'Grip to pick it up · trigger to get on';
    if (reachable) return 'Grip to pick up the board';
    if (aimed) return 'Trigger to get on the board';
    return 'Point + trigger to ride · reach behind your head + grip to summon';
  }

  /** Either hand close enough to take the loose deck. */
  function deckInHandReach(): boolean {
    if (!parked.group.visible || boardGrab.held) return false;
    return reachToDeck('left') <= GRAB_REACH || reachToDeck('right') <= GRAB_REACH;
  }

  /**
   * Whether the loose deck should be lit up: either verb being live counts, because what the highlight says is
   * "this board is answering you right now" and the wrist prompt says which button it is answering.
   */
  function deckActionable(): boolean {
    return deckInHandReach() || aimedAtDeck();
  }

  /**
   * Connect one visible controller to the loose deck while that hand has a live board action. An aimed trigger
   * gets the exact ray hit; otherwise a grip inside arm's reach gets the nearest point on the deck. If both are
   * eligible, right wins so the same board never grows two tethers. The guide is deliberately absent while
   * riding or already carrying: it is an acquisition cue, not a permanent tether.
   */
  function boardActionTargetFor(hand: GrabHand, target: THREE.Vector3): boolean {
    let actionable = false;
    if (walker.isGrounded() && hands.aimRay(hand, boardActionRay)) {
      const distance = deckRayDistance(
        parked.grabBox, parked.group.position, parked.group.quaternion, boardActionRay,
      );
      if (distance !== null && distance <= MOUNT_AIM_RANGE) {
        boardActionRay.at(distance, target);
        nearestDeckPoint(
          parked.grabBox, parked.group.position, parked.group.quaternion, target, target,
        );
        actionable = true;
      }
    }
    if (actionable) return true;
    const at = wrist(hand);
    if (!at || reachToDeck(hand) > GRAB_REACH) return false;
    handGripPoint(at.position, at.quaternion, boardActionGrip);
    nearestDeckPoint(
      parked.grabBox, parked.group.position, parked.group.quaternion, boardActionGrip, target,
    );
    return true;
  }

  function updateBoardActionGuides() {
    if (ride || boardGrab.held || calibrationRun || !parked.group.visible) {
      for (const hand of GRAB_HANDS) boardActionGuides[hand].hide();
      return;
    }
    const canShow = { left: false, right: false };
    for (const hand of GRAB_HANDS) {
      canShow[hand] = boardActionTargetFor(hand, boardActionTargets[hand])
        && hands.presentationControllerPosition(hand, boardActionStarts[hand]);
    }
    const preferred = preferredBoardActionHand(canShow.left, canShow.right);
    for (const hand of GRAB_HANDS) {
      if (hand === preferred) boardActionGuides[hand].show(boardActionStarts[hand], boardActionTargets[hand]);
      else boardActionGuides[hand].hide();
    }
  }

  return {
    get presenting() { return !!session; },
    get riding() { return !!ride; },
    get diagnosticsEnabled() { return statsEnabled; },
    /** The effects world follows the local participant, not the optional board beneath them. These references
     * remain valid only until the next frame and are consumed synchronously by the viewport. */
    get activePosition() { return ride ? ride.state.pos : walker.position(); },
    get activeVelocity() { return ride ? ride.state.vel : walker.velocity(); },
    enter, exit, dispose, beginFrame, endFrame, recordFramePerf, gaze, playerPose,
    setEquipmentAppearance(appearance?: EquipmentAppearance) {
      deps.equipmentAppearance = appearance;
      parked.setAppearance(appearance);
      ride?.setEquipmentAppearance(appearance);
    },
  };
}

export type XrPlay = ReturnType<typeof createXrPlay>;

/** Browser/GPU identity belongs beside the timing: a native game on the discrete adapter and Chrome on an
 * integrated adapter are not comparable runs. Browsers may intentionally mask it; the ordinary renderer string
 * is still more honest than leaving the field blank. */
function webGlRendererLabel(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const debug = gl.getExtension('WEBGL_debug_renderer_info') as {
    UNMASKED_RENDERER_WEBGL: number;
  } | null;
  const value = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
  return String(value || 'unknown').replace(/^ANGLE \((.*)\)$/, '$1');
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** Third-person is a camera-only boom in the rider's level frame. Local +Z is behind a viewer who faces −Z;
 * local +Y lifts the headset view above the complete avatar rather than leaving it level with the avatar head. */
export const XR_THIRD_PERSON_DISTANCE = 2, XR_THIRD_PERSON_HEIGHT = 1;
export function xrViewOffset(thirdPerson: boolean, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(0, thirdPerson ? XR_THIRD_PERSON_HEIGHT : 0, thirdPerson ? XR_THIRD_PERSON_DISTANCE : 0);
}

/** Move a tracker matrix from the camera/presentation root onto the avatar/body root. Third person uses this to
 * draw the controller beside the displaced headset while feeding the same physical pose to the unshifted body. */
export function rebaseXrPresentationMatrix(
  trackedWorld: THREE.Matrix4, presentationWorld: THREE.Matrix4, bodyWorld: THREE.Matrix4,
  out = new THREE.Matrix4(),
): THREE.Matrix4 {
  return out.copy(presentationWorld).invert().multiply(trackedWorld).premultiply(bodyWorld);
}
/** A viewer's own forward. −Z, like every camera in three — and the source of the sign every rig gets wrong once. */
const VIEW_FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * The world-up yaw that makes a rig FACE `forward` — the angle solving `rotY(θ)·(0,0,−1) = forward`, because a
 * rig carries a viewer and a viewer looks down its own −Z.
 *
 * Exported for its own test. It is one `atan2` and it was wrong once: with the +Z sign the rider is seated
 * facing backwards, at which point walking, the mount reach and head steer are all mirrored at the same time,
 * and each of them looks like its own bug.
 */
export function viewerYaw(forward: THREE.Vector3): number {
  return Math.atan2(-forward.x, -forward.z);
}

const _headsetFacing = new THREE.Vector3();

/**
 * Convert one headset X/Z displacement from the runtime's local-floor space into world space. False means the
 * jump was too large to be human between adjacent XR frames and should be treated as a recenter/tracking reset.
 */
export function trackedRoomDelta(previous: THREE.Vector3, current: THREE.Vector3,
  rigRotation: THREE.Quaternion, out: THREE.Vector3): boolean {
  out.set(current.x - previous.x, 0, current.z - previous.z);
  if (out.lengthSq() > MAX_TRACKED_ROOM_STEP * MAX_TRACKED_ROOM_STEP) {
    out.set(0, 0, 0);
    return false;
  }
  out.applyQuaternion(rigRotation);
  return true;
}

/** Add one accepted world-space tracking delta and report when it is large enough to justify collision work.
 * The caller consumes and clears `pending` on true, preserving slow real movement without reacting to jitter. */
export function trackedRoomMoveReady(pending: THREE.Vector3, delta: THREE.Vector3,
  threshold = MIN_TRACKED_ROOM_MOVE): boolean {
  pending.add(delta);
  return pending.lengthSq() >= threshold * threshold;
}

/** Flatten physical HMD gaze into a body heading. Looking vertically retains the previous heading because yaw
 * is undefined there; every ordinary real-world turn immediately rotates the body under the viewer. */
export function headsetBodyFacing(headRotation: THREE.Quaternion, fallback: THREE.Vector3,
                                  out = new THREE.Vector3()): THREE.Vector3 {
  _headsetFacing.copy(VIEW_FORWARD).applyQuaternion(headRotation).setY(0);
  if (_headsetFacing.lengthSq() >= 1e-8) out.copy(_headsetFacing);
  else out.copy(fallback).setY(0);
  if (out.lengthSq() < 1e-8) out.set(0, 0, 1); else out.normalize();
  return out;
}

const _xrFinger = new THREE.Vector3(), _xrPalm = new THREE.Vector3(), _xrAcross = new THREE.Vector3();
const _xrHandBasis = new THREE.Matrix4();

/** Convert device-specific WebXR pose axes into the rider's one wrist convention: local +Y toward the fingers,
 * local +Z out of the palm. Optical wrist axes come from the Hand Input spec; controller grips use the inward
 * palm side of the held grip. Either source then drives the same avatar-hand retargeter. */
export function canonicalXrHandRotation(raw: THREE.Quaternion, handedness: 'left' | 'right',
                                        source: 'hand' | 'grip', out = new THREE.Quaternion()): THREE.Quaternion {
  _xrFinger.set(0, 0, -1).applyQuaternion(raw).normalize();
  if (source === 'hand') _xrPalm.set(0, -1, 0).applyQuaternion(raw);
  else _xrPalm.set(handedness === 'left' ? 1 : -1, 0, 0).applyQuaternion(raw);
  _xrPalm.addScaledVector(_xrFinger, -_xrPalm.dot(_xrFinger));
  if (_xrPalm.lengthSq() < 1e-8) _xrPalm.set(0, 1, 0); else _xrPalm.normalize();
  _xrAcross.crossVectors(_xrFinger, _xrPalm).normalize();
  _xrPalm.crossVectors(_xrAcross, _xrFinger).normalize();
  return out.setFromRotationMatrix(_xrHandBasis.makeBasis(_xrAcross, _xrFinger, _xrPalm));
}

/**
 * The two controller spaces are presented under the same camera-only root as the XR eyes. First person leaves
 * that root at identity; third person moves it behind/above the avatar, keeping the controller previews and
 * wrist menu where the wearer's real hands are relative to the headset. Body/peer poses are rebased onto `rig`
 * before they leave this helper, so the avatar remains at the board instead of reaching back toward its camera.
 */
function createHands(renderer: THREE.WebGLRenderer, rig: THREE.Group, viewRig: THREE.Group) {
  // Keep a small controller on the UNCALIBRATED WebXR grip. In first person its seat against the avatar palm is
  // an immediate calibration check; in third person it deliberately remains with the wearer's physical hand.
  const tracked = [0, 1].map(index => {
    const controller = renderer.xr.getController(index);
    const grip = renderer.xr.getControllerGrip(index);
    const hand = renderer.xr.getHand(index);
    const visual = createVirtualController();
    grip.add(visual.group);
    viewRig.add(controller, grip, hand);
    // Three owns a persistent input-source -> controller-slot table. `XRSession.inputSources`, by contrast, is
    // only the runtime's current enumeration and may return the same sources in another order after a controller
    // reconnects. Record the source on the slot's own connection event so wrist ownership can never drift away
    // from the pose that Three is actually writing into this controller/grip/hand trio.
    const slot = {
      controller, grip, hand, visual,
      source: null as XRInputSource | null,
      handedness: 'none' as XRHandedness,
    };
    const onConnected = (event: { data: XRInputSource }) => {
      slot.source = event.data;
      slot.handedness = event.data.handedness;
    };
    const onDisconnected = (event: { data: XRInputSource }) => {
      // Ignore a stale disconnect if this reusable slot has already received its replacement source.
      if (slot.source !== event.data) return;
      slot.source = null;
      slot.handedness = 'none';
    };
    controller.addEventListener('connected', onConnected);
    controller.addEventListener('disconnected', onDisconnected);
    return Object.assign(slot, { onConnected, onDisconnected });
  });
  const aimRotation = new THREE.Quaternion();
  const rawHandRotation = new THREE.Quaternion();
  const savedHandOffset = new THREE.Quaternion();
  const bodyPoseMatrix = new THREE.Matrix4(), bodyPoseScale = new THREE.Vector3();
  const networkTargets = [0, 1].map((): RiderHandTarget => ({
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(),
  }));
  const node = (index: number): THREE.Object3D | null => {
    const { grip, hand } = tracked[index];
    const wrist = hand.joints.wrist;
    if (hand.visible && wrist?.visible) return wrist;
    return grip.visible ? grip : null;
  };
  const sourceAt = (index: number): 'hand' | 'grip' | null => {
    const { grip, hand } = tracked[index];
    if (hand.visible && hand.joints.wrist?.visible) return 'hand';
    return grip.visible ? 'grip' : null;
  };
  const indexFor = (handedness: 'left' | 'right', fallback: number): number => {
    const found = tracked.findIndex(slot => slot.handedness === handedness);
    return found >= 0 ? found : fallback;
  };
  /** Resolve a presented tracker at the avatar/body root, deliberately removing the third-person view offset. */
  const bodyPose = (object: THREE.Object3D, position: THREE.Vector3, rotation: THREE.Quaternion) => {
    object.updateWorldMatrix(true, false);
    rig.updateWorldMatrix(true, false);
    viewRig.updateWorldMatrix(true, false);
    rebaseXrPresentationMatrix(
      object.matrixWorld, viewRig.matrixWorld, rig.matrixWorld, bodyPoseMatrix,
    ).decompose(position, rotation, bodyPoseScale);
  };
  const writeTarget = (index: number, handedness: 'left' | 'right', out: RiderHandTarget): boolean => {
    const object = node(index), source = sourceAt(index);
    if (!object || !source) return false;
    bodyPose(object, out.position, rawHandRotation);
    canonicalXrHandRotation(rawHandRotation, handedness, source, out.quaternion);
    out.source = source;
    out.handedness = handedness;
    return true;
  };
  const applySaved = (target: RiderHandTarget, handedness: 'left' | 'right', index: number,
                      calibration: XrHandsCalibration | undefined) => {
    const saved = calibration?.[handedness], source = sourceAt(index);
    if (!saved || saved.source !== source) return;
    savedHandOffset.set(...saved.offset);
    target.quaternion.multiply(savedHandOffset).normalize();
  };
  return {
    updateControllers(pads: XrPads, riding: boolean) {
      for (let index = 0; index < tracked.length; index++) {
        const slot = tracked[index];
        const handedness = slot.handedness === 'left' || slot.handedness === 'right'
          ? slot.handedness : index === 0 ? 'left' : 'right';
        slot.visual.setHandedness(handedness);
        slot.visual.setBoardAction(riding);
        slot.visual.setInput(pads[handedness]);
        slot.visual.group.visible = sourceAt(index) === 'grip';
      }
    },
    /** Body-space target ray for avatar gameplay (mounting/boost), unaffected by a presentation-only view boom. */
    aimRay(handedness: 'left' | 'right', ray: THREE.Ray): boolean {
      const index = indexFor(handedness, handedness === 'left' ? 0 : 1);
      const aim = tracked[index]?.controller;
      if (!aim?.visible) return false;
      bodyPose(aim, ray.origin, aimRotation);
      ray.direction.set(0, 0, -1).applyQuaternion(aimRotation).normalize();
      return true;
    },
    /** Presented centre of a visible physical controller, for a guide that must meet the drawn hardware. */
    presentationControllerPosition(handedness: 'left' | 'right', out: THREE.Vector3): boolean {
      const index = indexFor(handedness, handedness === 'left' ? 0 : 1);
      if (sourceAt(index) !== 'grip') return false;
      tracked[index].grip.getWorldPosition(out);
      return true;
    },
    /** Camera-relative target ray for the wrist UI and its visible pointer beside the physical controller. */
    presentationAimRay(handedness: 'left' | 'right', ray: THREE.Ray): boolean {
      const index = indexFor(handedness, handedness === 'left' ? 0 : 1);
      const aim = tracked[index]?.controller;
      if (!aim?.visible) return false;
      aim.getWorldPosition(ray.origin);
      aim.getWorldQuaternion(aimRotation);
      ray.direction.set(0, 0, -1).applyQuaternion(aimRotation).normalize();
      return true;
    },
    /** Wear the compact HUD above the left wrist/controller. Parenting gives it the tracked six-degree-of-
     * freedom pose for free; the local quarter-turn makes the plane's face the top of the wrist like a watch. */
    placeWatch(object: THREE.Object3D): boolean {
      const wrist = node(indexFor('left', 0));
      if (!wrist) { object.visible = false; return false; }
      if (object.parent !== wrist) wrist.add(object);
      object.position.set(0, 0.045, 0.015);
      object.rotation.set(-Math.PI / 2, 0, 0);
      object.visible = true;
      return true;
    },
    /** Both canonical WORLD wrist poses this frame. The body needs both for stable shoulder assignment. */
    worldTargets(a: RiderHandTarget, b: RiderHandTarget): boolean {
      return writeTarget(indexFor('left', 0), 'left', a)
        && writeTarget(indexFor('right', 1), 'right', b);
    },
    /** Body-space tracker centres keep calibration independent of the presentation-only third-person boom. */
    worldTrackerPositions(a: THREE.Vector3, b: THREE.Vector3): boolean {
      const left = node(indexFor('left', 0)), right = node(indexFor('right', 1));
      if (!left || !right) return false;
      bodyPose(left, a, rawHandRotation); bodyPose(right, b, rawHandRotation);
      return true;
    },
    /** Apply the T-pose's device-specific palm corrections after a raw sample has had a chance to be captured. */
    applyCalibration(a: RiderHandTarget, b: RiderHandTarget, calibration: XrHandsCalibration | undefined) {
      applySaved(a, 'left', indexFor('left', 0), calibration);
      applySaved(b, 'right', indexFor('right', 1), calibration);
    },
    /**
     * Digit curls from the OPTICAL joints, or null for a side that is on a controller — where the caller
     * keeps the grip/trigger pose instead. A tracked hand carries no gamepad, so without this the avatar's
     * fingers stay open however the rider's real hand is held.
     */
    fingerCurls(handedness: 'left' | 'right'): CharacterHandCurl | null {
      const index = indexFor(handedness, handedness === 'left' ? 0 : 1);
      if (sourceAt(index) !== 'hand') return null;
      return trackedFingerCurls(tracked[index].hand as unknown as TrackedHand);
    },
    trackingSources(): { left: XrTrackedHandSource; right: XrTrackedHandSource } | null {
      const left = sourceAt(indexFor('left', 0)), right = sourceAt(indexFor('right', 1));
      return left && right ? { left, right } : null;
    },
    /** Short profiler answer to whether this frame uses optical wrists, controller grips, or has lost a side. */
    trackingLabel(calibration: XrHandsCalibration | undefined): string {
      const left = sourceAt(indexFor('left', 0)) ?? 'off';
      const right = sourceAt(indexFor('right', 1)) ?? 'off';
      const label = left === right ? `2×${left}` : `L ${left} · R ${right}`;
      const calibrated = calibration?.left.source === left && calibration?.right.source === right;
      const controllers = left === 'grip' || right === 'grip';
      return `${label}${calibrated ? ' calibrated' : ''}${controllers ? ' · ctrl visible' : ''}`;
    },
    /** Absolute canonical wrist transforms for peers. One hand may be absent while the other remains tracked. */
    worldTransforms(calibration: XrHandsCalibration | undefined): [PlayerTransform | null, PlayerTransform | null] {
      return (['left', 'right'] as const).map((handedness, fallback) => {
        const index = indexFor(handedness, fallback);
        const target = networkTargets[fallback];
        if (!writeTarget(index, handedness, target)) return null;
        applySaved(target, handedness, index, calibration);
        return transform(target.position, target.quaternion);
      }) as [PlayerTransform | null, PlayerTransform | null];
    },
    dispose() {
      for (const { controller, grip, hand, visual, onConnected, onDisconnected } of tracked) {
        controller.removeEventListener('connected', onConnected);
        controller.removeEventListener('disconnected', onDisconnected);
        visual.dispose();
        controller.removeFromParent(); grip.removeFromParent(); hand.removeFromParent();
      }
    },
  };
}

/**
 * A low-poly Meta Quest Touch Plus, rebuilt from Meta's own reference art (the `oculus-controller-art` package's
 * `MetaQuestTouchPlus_*.fbx` + base-colour maps) rather than eyeballed: every dimension below was measured off
 * that mesh. None of Meta's geometry, textures or marks ship here — this is our own ~650-triangle stand-in with
 * their proportions, which is what the licence for those files allows and what a fill-rate-bound XR path wants.
 * (No Meta logo either: their licence covers the product art but explicitly not the mark, so the system button
 * is left as a plain cap.)
 *
 * WHY THE NUMBERS LOOK LIKE THEY DO. Meta authors that FBX in a device frame whose origin sits up inside the
 * faceplate, so it is NOT WebXR grip space. The input-profiles asset contract is explicit about what grip space
 * means — "the center of the controller's handle should be at the scene's origin, and the handle should point
 * straight down the Y axis (the glTF export will automatically convert this to the -Z axis, as WebXR requires)"
 * — so the reference was rigidly re-anchored onto that before anything was measured: handle centre at the
 * origin, handle running +Z (butt) to -Z (deck end), button deck on +Y. Everything below is metres in that frame.
 *
 * The one consequence worth knowing: on real hardware the deck is NOT square to the handle. It leans 32° forward
 * of +Y (`DECK_TILT`), which is why the plate reads as a tilted disc rather than a lid — the single detail that
 * most makes the silhouette look like a Quest 3 controller instead of a generic wand.
 *
 * Only the RIGHT layout is built. A left controller is the same mesh mirrored through X (`setHandedness`), which
 * is what the hardware is, and it puts the grip pad on the correct inward side for free.
 */

/** Deck plane tilt off +Y, forward toward -Z. Measured: the deck normal is (0, 0.849, -0.529). */
const DECK_TILT = -0.5568;
/** Disc centre in grip space, and its radius. */
const DECK_AT = new THREE.Vector3(-0.0008, 0.0060, -0.0552);
const DECK_RADIUS = 0.0332;

/**
 * The shell as a run of oval cross-sections along grip Z: the wide wedge under the deck at the front, the palm
 * swell, then the taper into the rounded butt. `w`/`h` are half-extents across X and Y; `x`/`y` move the ring's
 * centre, which is how the handle leans out of the deck's shadow toward the butt.
 */
const SHELL_RINGS: readonly { z: number; x: number; y: number; w: number; h: number }[] = [
  { z: -0.0782, x: -0.0018, y: -0.0172, w: 0.0122, h: 0.0022 },
  { z: -0.0724, x: -0.0008, y: -0.0188, w: 0.0232, h: 0.0032 },
  { z: -0.0660, x: -0.0014, y: -0.0185, w: 0.0300, h: 0.0068 },
  { z: -0.0540, x: -0.0016, y: -0.0200, w: 0.0330, h: 0.0155 },
  { z: -0.0420, x: -0.0022, y: -0.0120, w: 0.0315, h: 0.0150 },
  { z: -0.0300, x: -0.0018, y: -0.0035, w: 0.0250, h: 0.0140 },
  { z: -0.0240, x: +0.0000, y: +0.0022, w: 0.0210, h: 0.0198 },
  { z: -0.0130, x: -0.0010, y: +0.0013, w: 0.0190, h: 0.0207 },
  { z: +0.0015, x: +0.0000, y: +0.0000, w: 0.0153, h: 0.0212 },
  { z: +0.0165, x: -0.0034, y: -0.0015, w: 0.0142, h: 0.0200 },
  { z: +0.0315, x: -0.0058, y: -0.0016, w: 0.0124, h: 0.0170 },
  { z: +0.0420, x: -0.0071, y: -0.0019, w: 0.0075, h: 0.0100 },
  { z: +0.0465, x: -0.0075, y: -0.0020, w: 0.0026, h: 0.0036 },
];
const SHELL_SIDES = 10;

/**
 * The head cap as two lathes sharing one axis and one segment count, given as (radius, height above the deck
 * plane): the charcoal plate — near-flat top, then the rim rolling under — and the white collar carrying on
 * below it. The collar is what makes the rim sit ON something from every angle. A swept body alone cannot do
 * that: its cross-sections peak in the middle, while the real shell rides HIGHEST at the plate's left and right
 * edges, so one sweep either pokes through the plate or leaves it a disc floating over a gap when seen side-on.
 */
const PLATE_PROFILE: readonly [number, number][] = [
  [0.0000, 0.0026], [0.0210, 0.0020], [0.0305, -0.0008], [DECK_RADIUS, -0.0050],
];
const COLLAR_PROFILE: readonly [number, number][] = [
  [DECK_RADIUS, -0.0050], [0.0322, -0.0128], [0.0286, -0.0196],
];
const DECK_SEGMENTS = 18;

/**
 * Face controls, positioned on the deck rather than in grip space: `u` runs right across the plate and `v` runs
 * forward along it, both from the disc centre, with `n` the height above the plate. Measured off the reference's
 * own control bones, so the A/B/stick triangle and the system button's corner are the hardware's spacing.
 */
const CONTROLS = {
  stick: { u: +0.0141, v: +0.0049, r: 0.0060, n: +0.0080 },
  a: { u: -0.0019, v: -0.0081, r: 0.0058, n: +0.0031 },
  b: { u: -0.0079, v: +0.0071, r: 0.0058, n: +0.0030 },
  system: { u: +0.0131, v: -0.0147, r: 0.0042, n: +0.0022 },
} as const;

/** Index trigger and grip button, in grip space: the reference's hinge bones, with the pads hung off them. */
const TRIGGER_HINGE = new THREE.Vector3(-0.0024, -0.0149, -0.0731);
const GRIP_HINGE = new THREE.Vector3(-0.0026, -0.0219, -0.0507);

/**
 * A closed tube lofted through `SHELL_RINGS`, with both ends capped by a fan. This is one buffer for the whole
 * white body — deck skirt, palm swell and butt — because they are one moulding on the real thing and splitting
 * them would only add a seam to hide.
 */
function lowPolyShell(rings: readonly { z: number; x: number; y: number; w: number; h: number }[], sides: number) {
  const position: number[] = [], index: number[] = [];
  for (const ring of rings) {
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      position.push(ring.x + Math.cos(a) * ring.w, ring.y + Math.sin(a) * ring.h, ring.z);
    }
  }
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let s = 0; s < sides; s++) {
      const s1 = (s + 1) % sides;
      const a = r * sides + s, b = r * sides + s1, c = (r + 1) * sides + s, d = (r + 1) * sides + s1;
      index.push(a, c, b, b, c, d);
    }
  }
  const last = (rings.length - 1) * sides;
  for (let s = 1; s + 1 < sides; s++) {
    index.push(0, s + 1, s);                       // front cap, wound to face -Z
    index.push(last, last + s, last + s + 1);      // butt cap
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

export function createVirtualController() {
  const group = new THREE.Group();
  group.name = 'xr-controller-visual';
  // One mirror node under the root: a left controller is the right one through X. Every material is double-sided
  // because that mirror reverses winding, and at ~650 triangles the extra fill is not worth a second mesh set.
  const mirror = new THREE.Group();
  mirror.name = 'xr-controller.mirror';
  group.add(mirror);

  const materials: THREE.Material[] = [];
  const material = (color: number, roughness: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
    const made = new THREE.MeshStandardMaterial({ color, roughness, side: THREE.DoubleSide, ...extra });
    materials.push(made);
    return made;
  };
  // Albedo sampled from Meta's own base-colour maps: #E2E2E2 shell, #232323 deck, #5E6165 caps. The deck is
  // lifted a little from its measured value so it still reads as charcoal rather than a hole in a night scene.
  const shellMaterial = material(0xe4e4e2, 0.55, { metalness: 0.02 });
  const deckMaterial = material(0x2c2d30, 0.62, { metalness: 0.06 });
  const capMaterial = material(0x5e6165, 0.5, { metalness: 0.08 });
  const stickMaterial = material(0x1d1e20, 0.85, { metalness: 0.04 });
  const activeMaterial = material(0x6d7075, 0.42, { metalness: 0.08, emissive: 0x123842 });
  const activeUpperMaterial = material(0x6d7075, 0.42, { metalness: 0.08, emissive: 0x123842 });

  const part = (geometry: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = `xr-controller.${name}`;
    mesh.raycast = () => {};
    parent.add(mesh);
    return mesh;
  };

  part(lowPolyShell(SHELL_RINGS, SHELL_SIDES), shellMaterial, 'handle', mirror);

  // The deck carries the plate and everything on it, so face controls are placed in the plate's own u/v rather
  // than solved against the tilt at every site.
  const deck = new THREE.Group();
  deck.name = 'xr-controller.deck';
  deck.position.copy(DECK_AT);
  deck.rotation.x = DECK_TILT;
  mirror.add(deck);
  const lathe = (profile: readonly [number, number][]) =>
    new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), DECK_SEGMENTS);
  part(lathe(PLATE_PROFILE), deckMaterial, 'face', deck);
  part(lathe(COLLAR_PROFILE), shellMaterial, 'collar', deck);

  /** Deck-local placement: +X is across the plate, -Z is forward along it, +Y stands off its surface. */
  const onDeck = (mesh: THREE.Object3D, at: { u: number; v: number }, y: number) =>
    mesh.position.set(at.u, y, -at.v);

  const buttonGeometry = new THREE.CylinderGeometry(CONTROLS.a.r, CONTROLS.a.r * 0.94, 0.0042, 10);
  const button = part(buttonGeometry, activeMaterial, 'button', deck);
  onDeck(button, CONTROLS.a, CONTROLS.a.n - 0.0021);
  const buttonUpper = part(buttonGeometry.clone(), activeUpperMaterial, 'button-upper', deck);
  onDeck(buttonUpper, CONTROLS.b, CONTROLS.b.n - 0.0021);
  const systemButton = part(
    new THREE.CylinderGeometry(CONTROLS.system.r, CONTROLS.system.r * 0.94, 0.0034, 8), capMaterial,
    'button-system', deck,
  );
  onDeck(systemButton, CONTROLS.system, CONTROLS.system.n - 0.0017);

  // The stick tilts with the physical thumbstick, which makes it the one part of this model that reads as live
  // telemetry rather than decoration — useful when a stick is drifting and the rider cannot see their own hand.
  const stickPivot = new THREE.Group();
  stickPivot.name = 'xr-controller.stick-pivot';
  onDeck(stickPivot, CONTROLS.stick, -0.0060);
  deck.add(stickPivot);
  const well = part(new THREE.CylinderGeometry(0.0088, 0.0082, 0.0028, 10), deckMaterial, 'stick-well', deck);
  onDeck(well, CONTROLS.stick, 0.0016);
  const stick = part(new THREE.CylinderGeometry(0.0060, 0.0042, 0.0104, 10), stickMaterial, 'stick', stickPivot);
  stick.position.y = 0.0088;

  const trigger = part(new THREE.BoxGeometry(0.0168, 0.0072, 0.0104), shellMaterial, 'trigger', mirror);
  const triggerPivot = new THREE.Group();
  triggerPivot.name = 'xr-controller.trigger-pivot';
  triggerPivot.position.copy(TRIGGER_HINGE);
  mirror.add(triggerPivot);
  triggerPivot.add(trigger);
  // Hang the pad fully below the shell. Its previous -2.2 mm offset buried the button and its label inside the
  // front handle rings; -13.2 mm leaves the inner edge just touching the housing like the physical trigger.
  trigger.position.set(0.0004, -0.0132, 0.0038);
  trigger.rotation.x = 0.26;

  // Only the inward pad exists, as on the hardware — and because the whole model mirrors, "inward" is correct on
  // both hands without a second mesh or a visibility toggle. Seat its inner face against the shell rather than
  // through it, and lower it enough that the printed outer face clears the hand/body silhouette. Tucked 2.5 mm
  // closer to the handle than the first measurement: in the headset the paddle read as standing off its own
  // controller toward the other hand.
  const gripPadRestX = GRIP_HINGE.x - 0.0240;
  const gripPad = part(new THREE.BoxGeometry(0.0044, 0.0150, 0.0250), shellMaterial, 'grip-pad', mirror);
  gripPad.position.set(gripPadRestX, GRIP_HINGE.y + 0.0040, GRIP_HINGE.z + 0.0175);
  gripPad.rotation.set(0.10, 0.16, 0.0);

  // Bound face buttons carry glyphs and light: A jumps, B boosts, left X recovers, and left Y toggles the watch.
  // The complete state-aware action map is on the wrist's CONTROLS page.
  const glyphMaterial = new THREE.LineBasicMaterial({ color: 0xf4fbff, depthTest: true, depthWrite: false });
  const glyphSegments: Record<'A' | 'B' | 'X' | 'Y', number[][]> = {
    A: [[-0.5, -0.5, 0, 0.5], [0, 0.5, 0.5, -0.5], [-0.28, -0.05, 0.28, -0.05]],
    B: [[-0.4, -0.5, -0.4, 0.5], [-0.4, 0.5, 0.22, 0.5], [0.22, 0.5, 0.42, 0.25],
      [0.42, 0.25, -0.4, 0], [-0.4, 0, 0.25, 0], [0.25, 0, 0.43, -0.25], [0.43, -0.25, -0.4, -0.5]],
    X: [[-0.45, -0.5, 0.45, 0.5], [-0.45, 0.5, 0.45, -0.5]],
    Y: [[-0.45, 0.5, 0, 0], [0.45, 0.5, 0, 0], [0, 0, 0, -0.5]],
  };
  const glyph = (letter: 'A' | 'B' | 'X' | 'Y', at: THREE.Vector3) => {
    const vertices: number[] = [];
    for (const [x1, z1, x2, z2] of glyphSegments[letter]) {
      vertices.push(x1 * 0.0072, 0, z1 * 0.0072, x2 * 0.0072, 0, z2 * 0.0072);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const lines = new THREE.LineSegments(geometry, glyphMaterial);
    lines.name = `xr-controller.label-${letter}`;
    lines.userData.label = letter;
    lines.position.copy(at).setY(at.y + 0.0026);
    lines.renderOrder = 31;
    lines.raycast = () => {};
    deck.add(lines);
    return lines;
  };
  const labels = {
    A: glyph('A', button.position), B: glyph('B', buttonUpper.position),
    X: glyph('X', button.position), Y: glyph('Y', buttonUpper.position),
  };
  // The controller is viewed with its forward (-Z) edge at the top. The original marks used +Z as glyph-up,
  // which made both letters read upside down in the hand; flip only their vertical axis, preserving left/right.
  labels.A.scale.z = labels.B.scale.z = labels.X.scale.z = labels.Y.scale.z = -1;
  labels.X.visible = labels.Y.visible = false;

  type SurfaceStroke = readonly [number, number, number, number];
  const surfaceFont: Readonly<Record<string, readonly SurfaceStroke[]>> = {
    A: [[0, 1, 0.5, 0], [0.5, 0, 1, 1], [0.2, 0.58, 0.8, 0.58]],
    B: [[0, 0, 0, 1], [0, 0, 0.68, 0], [0.68, 0, 0.92, 0.18], [0.92, 0.18, 0.68, 0.48],
      [0.68, 0.48, 0, 0.48], [0.68, 0.48, 0.96, 0.7], [0.96, 0.7, 0.68, 1], [0.68, 1, 0, 1]],
    D: [[0, 0, 0, 1], [0, 0, 0.66, 0], [0.66, 0, 1, 0.28], [1, 0.28, 1, 0.72],
      [1, 0.72, 0.66, 1], [0.66, 1, 0, 1]],
    E: [[1, 0, 0, 0], [0, 0, 0, 1], [0, 0.5, 0.78, 0.5], [0, 1, 1, 1]],
    G: [[1, 0.18, 0.78, 0], [0.78, 0, 0.18, 0], [0.18, 0, 0, 0.2], [0, 0.2, 0, 0.8],
      [0, 0.8, 0.18, 1], [0.18, 1, 0.78, 1], [0.78, 1, 1, 0.8], [1, 0.8, 1, 0.56],
      [1, 0.56, 0.54, 0.56]],
    I: [[0, 0, 1, 0], [0.5, 0, 0.5, 1], [0, 1, 1, 1]],
    J: [[0, 0, 1, 0], [0.72, 0, 0.72, 0.78], [0.72, 0.78, 0.5, 1], [0.5, 1, 0.12, 0.82]],
    M: [[0, 1, 0, 0], [0, 0, 0.5, 0.55], [0.5, 0.55, 1, 0], [1, 0, 1, 1]],
    N: [[0, 1, 0, 0], [0, 0, 1, 1], [1, 1, 1, 0]],
    O: [[0.18, 0, 0.82, 0], [0.82, 0, 1, 0.2], [1, 0.2, 1, 0.8], [1, 0.8, 0.82, 1],
      [0.82, 1, 0.18, 1], [0.18, 1, 0, 0.8], [0, 0.8, 0, 0.2], [0, 0.2, 0.18, 0]],
    P: [[0, 1, 0, 0], [0, 0, 0.72, 0], [0.72, 0, 1, 0.22], [1, 0.22, 0.72, 0.5],
      [0.72, 0.5, 0, 0.5]],
    Q: [[0.18, 0, 0.82, 0], [0.82, 0, 1, 0.2], [1, 0.2, 1, 0.8], [1, 0.8, 0.82, 1],
      [0.82, 1, 0.18, 1], [0.18, 1, 0, 0.8], [0, 0.8, 0, 0.2], [0, 0.2, 0.18, 0],
      [0.58, 0.62, 1.08, 1.08]],
    R: [[0, 1, 0, 0], [0, 0, 0.72, 0], [0.72, 0, 1, 0.22], [1, 0.22, 0.72, 0.5],
      [0.72, 0.5, 0, 0.5], [0.5, 0.5, 1, 1]],
    S: [[0.92, 0.12, 0.7, 0], [0.7, 0, 0.18, 0], [0.18, 0, 0, 0.22], [0, 0.22, 0.18, 0.48],
      [0.18, 0.48, 0.78, 0.52], [0.78, 0.52, 1, 0.78], [1, 0.78, 0.82, 1], [0.82, 1, 0.18, 1],
      [0.18, 1, 0, 0.88]],
    T: [[0, 0, 1, 0], [0.5, 0, 0.5, 1]],
    U: [[0, 0, 0, 0.78], [0, 0.78, 0.22, 1], [0.22, 1, 0.78, 1], [0.78, 1, 1, 0.78], [1, 0.78, 1, 0]],
    W: [[0, 0, 0.18, 1], [0.18, 1, 0.5, 0.55], [0.5, 0.55, 0.82, 1], [0.82, 1, 1, 0]],
  };
  const actionMaterial = new THREE.LineBasicMaterial({
    color: 0xc9dfef, transparent: true, opacity: 0.9, depthTest: true, depthWrite: false,
  });
  // Trigger and grip are white shell parts, so their printing needs dark ink rather than the pale deck ink.
  const controlActionMaterial = new THREE.LineBasicMaterial({
    color: 0x123842, depthTest: true, depthWrite: false,
  });
  /** Tiny single-stroke lettering laid directly on a control surface. It follows the tracked controller and
   * never billboards toward the viewer, so it reads as printing on the hardware rather than a floating callout. */
  type SurfaceLayout = 'deck' | 'trigger' | 'grip';
  const surfaceText = (text: string, x: number, z: number, height = 0.0024,
                       parent: THREE.Object3D = deck, y = 0.0031, layout: SurfaceLayout = 'deck',
                       ink: THREE.LineBasicMaterial = actionMaterial) => {
    const width = height * 0.62, gap = height * 0.22;
    const total = text.length * width + Math.max(0, text.length - 1) * gap;
    const vertices: number[] = [];
    let cursor = -total / 2;
    for (const letter of text) {
      for (const [x1, y1, x2, y2] of surfaceFont[letter] ?? []) {
        const u1 = cursor + x1 * width, u2 = cursor + x2 * width;
        const v1 = (y1 - 0.5) * height, v2 = (y2 - 0.5) * height;
        if (layout === 'trigger') vertices.push(u1, -v1, 0, u2, -v2, 0); // exposed forward XY face
        else if (layout === 'grip') vertices.push(0, -v1, u1, 0, -v2, u2); // exposed outer YZ face
        else vertices.push(u1, 0, v1, u2, 0, v2);                         // top deck XZ face
      }
      cursor += width + gap;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const lines = new THREE.LineSegments(geometry, ink);
    lines.name = `xr-controller.action-${text.toLowerCase().replaceAll(' ', '-')}`;
    lines.userData.surfaceLabel = text;
    lines.position.set(x, y, z);
    lines.renderOrder = 31;
    lines.raycast = () => {};
    parent.add(lines);
    return lines;
  };
  // Both button legends sit on the SAME edge of the plate, the one beside B/Y, stacked like a two-line key: the
  // A/X legend used to sit on the far edge beyond the button, where the thumb reaching across the deck covers it
  // exactly when the rider looks down to check what the button does. The stick legend names what the stick does
  // in the current state on each hand — riding, only the left stick does anything.
  const actionLabels = {
    jump: surfaceText('JUMP', -0.0210, +0.0085),
    boost: surfaceText('BOOST', -0.0210, -0.0070),
    steer: surfaceText('STEER', CONTROLS.stick.u, -0.0180),
    move: surfaceText('MOVE', CONTROLS.stick.u, -0.0180),
    look: surfaceText('LOOK', CONTROLS.stick.u, -0.0180),
    reset: surfaceText('RESET', -0.0210, +0.0085),
    spawn: surfaceText('SPAWN', -0.0210, +0.0085),
    menu: surfaceText('MENU', -0.0210, -0.0070),
    // A 0.1 mm stand-off keeps depth testing honest without z-fighting the button surface.
    equip: surfaceText('EQUIP', 0, -0.0053, 0.0025, trigger, 0, 'trigger', controlActionMaterial),
    unequip: surfaceText('UNEQUIP', 0, -0.0053, 0.0024, trigger, 0, 'trigger', controlActionMaterial),
    grabBoard: surfaceText('GRAB BOARD', -0.0023, 0, 0.0024, gripPad, 0, 'grip', controlActionMaterial),
  };
  // Built right-handed and on foot: the right stick LOOKs; the left-hand and riding legends wait for their state.
  actionLabels.steer.visible = actionLabels.move.visible = actionLabels.reset.visible = actionLabels.spawn.visible
    = actionLabels.menu.visible = actionLabels.unequip.visible = false;
  // This text is seen from the trigger's exposed -Z face, so its reading direction is opposite the deck labels.
  actionLabels.equip.scale.x = actionLabels.unequip.scale.x = -1;

  let rightHanded = true;
  let boardRiding = false;
  group.visible = false;
  return {
    group,
    setHandedness(handedness: 'left' | 'right') {
      const wantRight = handedness === 'right';
      if (wantRight === rightHanded) return;
      rightHanded = wantRight;
      mirror.scale.x = wantRight ? 1 : -1;
      // The mirror would also reverse each glyph, so un-mirror the live alphabet back to readable text.
      labels.A.scale.x = labels.B.scale.x = labels.X.scale.x = labels.Y.scale.x = mirror.scale.x;
      labels.A.visible = labels.B.visible = wantRight;
      labels.X.visible = labels.Y.visible = !wantRight;
      actionLabels.jump.scale.x = actionLabels.boost.scale.x = actionLabels.steer.scale.x
        = actionLabels.move.scale.x = actionLabels.look.scale.x
        = actionLabels.reset.scale.x = actionLabels.spawn.scale.x = actionLabels.menu.scale.x = mirror.scale.x;
      actionLabels.equip.scale.x = actionLabels.unequip.scale.x = -mirror.scale.x;
      // The grip print lies in Y/Z, so viewing the left controller from its mirrored outside reverses local Z.
      actionLabels.grabBoard.scale.z = mirror.scale.x;
      actionLabels.jump.visible = actionLabels.boost.visible = wantRight;
      actionLabels.menu.visible = !wantRight;
      actionLabels.reset.visible = !wantRight && boardRiding;
      actionLabels.spawn.visible = !wantRight && !boardRiding;
      actionLabels.steer.visible = !wantRight && boardRiding;
      actionLabels.move.visible = !wantRight && !boardRiding;
      actionLabels.look.visible = wantRight && !boardRiding;
      // Both face buttons are live on both hands: right A/B and left X/Y.
      button.material = activeMaterial;
      buttonUpper.material = activeUpperMaterial;
    },
    setBoardAction(riding: boolean) {
      boardRiding = riding;
      actionLabels.equip.visible = !riding;
      actionLabels.unequip.visible = riding;
      actionLabels.reset.visible = !rightHanded && riding;
      actionLabels.spawn.visible = !rightHanded && !riding;
      // The sticks change job with the state: left STEERs a board and MOVEs a walker; right LOOKs on foot only.
      actionLabels.steer.visible = !rightHanded && riding;
      actionLabels.move.visible = !rightHanded && !riding;
      actionLabels.look.visible = rightHanded && !riding;
    },
    setInput(hand: XrPads['left']) {
      const triggerValue = hand?.triggerValue ?? 0, squeeze = hand?.squeezeValue ?? 0;
      const lower = !!hand?.a;
      const upper = !!hand?.b;
      // Negative: the tab hangs BELOW its hinge, so a positive roll about +X would throw it forward, away
      // from the finger pulling it. A pulled trigger travels back toward the palm, which is grip +Z.
      triggerPivot.rotation.x = -triggerValue * 0.44;
      gripPad.position.x = gripPadRestX + squeeze * 0.0022;
      button.position.y = CONTROLS.a.n - 0.0021 - (lower ? 0.0011 : 0);
      buttonUpper.position.y = CONTROLS.b.n - 0.0021 - (upper ? 0.0011 : 0);
      labels.A.position.y = button.position.y + 0.0026;
      labels.B.position.y = buttonUpper.position.y + 0.0026;
      labels.X.position.y = button.position.y + 0.0026;
      labels.Y.position.y = buttonUpper.position.y + 0.0026;
      // Stick throw is the physical axis, not the shaped riding curve: this is a picture of the hardware. The
      // X-mirror reverses a roll about Z (but not a pitch about X), so a left stick pushed right would lean left
      // without this sign — `mirror.scale.x` is exactly the correction, and it is already ±1.
      stickPivot.rotation.z = -(hand?.x ?? 0) * 0.34 * mirror.scale.x;
      stickPivot.rotation.x = (hand?.y ?? 0) * 0.34;
      stick.position.y = 0.0088 - (hand?.stickPressed ? 0.0012 : 0);
      activeMaterial.emissiveIntensity = 0.25 + Number(lower) * 0.9;
      activeUpperMaterial.emissiveIntensity = 0.25 + Number(upper) * 0.9;
    },
    dispose() {
      group.removeFromParent();
      const geometries = new Set<THREE.BufferGeometry>();
      group.traverse(object => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) geometries.add(object.geometry);
      });
      geometries.forEach(geometry => geometry.dispose());
      for (const made of materials) made.dispose();
      glyphMaterial.dispose();
      actionMaterial.dispose();
      controlActionMaterial.dispose();
    },
  };
}

/** World-space hover beam plus a small endpoint on the button. Both ignore depth so a wrist or sleeve cannot
 * hide the acquisition confirmation after the controller ray has already reached the panel. */
function createWatchPointer() {
  const positions = new Float32Array(6);
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute('position', position);
  const material = new THREE.LineBasicMaterial({
    color: 0x74d7ff, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
  });
  const line = new THREE.Line(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = 40;
  const dotGeometry = new THREE.SphereGeometry(0.012, 10, 6);
  const dotMaterial = new THREE.MeshBasicMaterial({
    color: 0xd8f5ff, depthTest: false, depthWrite: false,
  });
  const dot = new THREE.Mesh(dotGeometry, dotMaterial);
  dot.renderOrder = 41;
  const object = new THREE.Group();
  object.name = 'xr-watch-pointer';
  object.visible = false;
  object.add(line, dot);
  return {
    object,
    show(from: THREE.Vector3, to: THREE.Vector3) {
      positions[0] = from.x; positions[1] = from.y; positions[2] = from.z;
      positions[3] = to.x; positions[4] = to.y; positions[5] = to.z;
      position.needsUpdate = true;
      dot.position.copy(to);
      object.visible = true;
    },
    hide() { object.visible = false; },
    dispose() {
      object.removeFromParent();
      geometry.dispose(); material.dispose(); dotGeometry.dispose(); dotMaterial.dispose();
    },
  };
}

/** A short-lived controller-to-board tether. A narrow shader-dashed tube stays visibly thicker than WebGL's
 * implementation-limited one-pixel lines, and starts beyond the controller shell instead of inside the hand. */
export function createBoardActionGuide(hand: GrabHand = 'right') {
  const geometry = new THREE.CylinderGeometry(0.00225, 0.00225, 1, 8, 1, true);
  const material = new THREE.ShaderMaterial({
    uniforms: {
      colour: { value: new THREE.Color(0x74d7ff) },
      opacity: { value: 0.5 },
      lineLength: { value: 1 },
      dashSize: { value: 0.075 },
      gapSize: { value: 0.045 },
    },
    vertexShader: `
      varying float vAlong;
      void main() {
        vAlong = uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 colour;
      uniform float opacity;
      uniform float lineLength;
      uniform float dashSize;
      uniform float gapSize;
      varying float vAlong;
      void main() {
        if (mod(vAlong * lineLength, dashSize + gapSize) > dashSize) discard;
        gl_FragColor = vec4(colour, opacity);
      }
    `,
    transparent: true, opacity: 0.5, depthTest: false, depthWrite: false,
    side: THREE.DoubleSide, toneMapped: false,
  });
  const object = new THREE.Mesh(geometry, material);
  object.name = `xr-board-action-guide-${hand}`;
  object.visible = false;
  object.frustumCulled = false;
  object.renderOrder = 39;
  object.raycast = () => {};
  const direction = new THREE.Vector3(), start = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  return {
    object,
    show(from: THREE.Vector3, to: THREE.Vector3) {
      direction.subVectors(to, from);
      const totalLength = direction.length();
      if (totalLength <= 0.11) { object.visible = false; return; }
      direction.multiplyScalar(1 / totalLength);
      start.copy(from).addScaledVector(direction, 0.09);
      const visibleLength = totalLength - 0.09;
      object.position.copy(start).addScaledVector(direction, visibleLength / 2);
      object.quaternion.setFromUnitVectors(up, direction);
      object.scale.set(1, visibleLength, 1);
      material.uniforms.lineLength.value = visibleLength;
      object.visible = true;
    },
    hide() { object.visible = false; },
    dispose() { object.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}

const vector = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];
const transform = (p: THREE.Vector3, q: THREE.Quaternion): PlayerTransform =>
  ({ p: vector(p), q: [q.x, q.y, q.z, q.w] });
