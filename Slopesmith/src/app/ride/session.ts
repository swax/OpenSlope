import * as THREE from 'three';
import {
  createRideModel,
  rideForward,
  type PatchContact,
  type RideModel,
  type RideObstacleHit,
  type RideObstacleSource,
} from './physics';
import { MOUNT_AIM_RANGE, RIDER_HEAD_Y } from './physics-tuning';
import type { BoostVolume } from './boost-volumes';
import type { CrackedSurface, CrackedSurfaceRuntime } from './cracked-surfaces';
import { createFinishCrossing, type FinishCrossing, type FinishLine } from './laps';
import {
  clampThirdPersonZoom, createRideCamera, DEFAULT_THIRD_PERSON_ZOOM, keepThirdPersonCameraAboveGround, thirdPersonFollowEye,
  thirdPersonWheelZoomFactor, type RideCamera,
} from './camera';
import type { GrindRails } from './grind';
import { createRideHud, type RideHud } from './hud';
import { createRideInput, type RideInput, type RideInputOpts } from './input';
import { createRideGamepad, type RideGamepad } from './gamepad';
import { createRiderPose, type RiderPose } from './pose';
import { createBoardAudio, type BoardAudio } from './board-audio';
import type { EquipmentAppearance, RideGear, SnowboardStance } from './gear';
import type { BoardSoundMix } from '../../core/doc/types';
import {
  DEFAULT_RACE_MODE, raceModeIsTimed, scoringEffectsApplyInMode, type RaceMode,
} from '../../core/doc/race';
import type { RideEffectAction, RideEffectState } from './effect-actions';
import { downloadRideTelemetry, RideTelemetryCapture, type RideShovedBodySample } from './telemetry';
import { createCheckpointTracker, type CheckpointTracker, type RideCheckpoint } from './checkpoints';
import type { XrRideControls } from './xr/input';
import { createWalker, type WalkGroundQuery, type Walker } from './xr/walk';
import {
  recordRideFrameTimings, smoothRideMs, type RideFrameTimingSample,
} from './perf';
import { OnFootFacing } from './on-foot-facing';
import type {
  LocalPlayerPose, PlayerQuat, PlayerTransform, PlayerVec3,
} from '../../core/session/player-pose';
import { riderViewpoint, type RiderHandTarget } from './rider';
import { BoardFx } from './board-fx';
import { createBoardCoast, type BoardCoast } from './board-coast';
import { createBoardGrab, deckRayDistance, nearestDeckPoint, type BoardThrow } from './board-grab';
import { createRidePointerLock, type RidePointerLock } from './pointer-lock';
import {
  createRideScorer, rideTrickDisplay, type RideScoreSnapshot, type RideTrickDisplay,
} from './score';
import type { RideRunStatus } from './run-status';

export { SURFACE_ROWS, contactResponse } from './physics';
export type { PatchContact, SurfaceRow } from './physics';
export type { RideRunStatus } from './run-status';

export interface RideCountdown {
  holdSeconds: number;
  cues: readonly { at: number; label: string }[];
}

/** How often the DOM ride HUD refreshes while a headset owns the view: it is then a mirror for a spectator at
 *  the desk, and refreshing it per frame spends the headset's budget on something the rider cannot see. */
const VR_MIRROR_HUD_MS = 100;
/** Unity holds a landed/bailed trick result on its run panel for three seconds. */
const TRICK_RESULT_HOLD_SECONDS = 3;
/** Desktop walking uses the same feet-level controller as WebXR; this is only the camera above those feet. */
const WALK_EYE_HEIGHT = 1.65;
const WALK_CROUCH_EYE_HEIGHT = 1.30;
const WALK_CROUCH_RESPONSE = 12;
const WALK_THIRD_PERSON_DISTANCE = 3, WALK_THIRD_PERSON_HEIGHT = 1;
const WALK_LOOK_PER_PIXEL = 0.0026;
/** Full physical right-stick deflection turns at 120°/s. Walking has its own radians-per-pixel conversion;
 * riding uses the chase camera's 0.006-rad mouse yaw scale and retains its gentler vertical response. */
const WALK_LOOK_STICK_PIXELS_PER_SECOND = THREE.MathUtils.degToRad(120) / WALK_LOOK_PER_PIXEL;
const RIDE_LOOK_STICK_PIXELS_PER_SECOND = THREE.MathUtils.degToRad(120) / 0.006;
const WALK_PITCH_LIMIT = THREE.MathUtils.degToRad(85);
/** An unreachable point down the cursor direction gives the arm solver a stable fully-extended target. */
const DESKTOP_BOARD_AIM_DISTANCE = 1.15;
/**
 * Test ride (docs/016) — the playtest SESSION around the board physics. The physics model itself — the fixed
 * 60 Hz tick, the per-surface response table and the terrain probe — is `physics.ts`; the chase camera is
 * `camera.ts`; the HUD + touch overlay are `hud.ts`; the keyboard is `input.ts`; the drawn board and rider and
 * their pose are `pose.ts` (which the AI field, `ai.ts`, draws its riders with too). This host owns what is
 * left: the wiring that hands each module the state it reads, and the per-frame loop that steps them in order.
 */

export interface RideStartOpts {
  spawn: THREE.Vector3;
  heading?: THREE.Vector3;
  terrain: THREE.Mesh;
  scene: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  container: HTMLElement;
  /** Canvas that owns the desktop ride's captured cursor. Omitted for WebXR and headless callers. */
  pointerTarget?: HTMLElement;
  /** Whether the flat ride may reveal direct-touch controls. False for a headset browser's controller-ray view. */
  touchControls?: boolean;
  surfaceOf: (faceIndex: number) => number | null;
  /** The authored terrain's analytic Bezier contact; absent for a baked reference world. */
  patchContact?: PatchContact;
  /** The course's grind-rail network ([Trailmap: 350]); absent when the ridden world carries no rails. */
  rails?: GrindRails;
  /** Static prop collision geometry captured from the selected mountain at Play launch. */
  obstacles?: readonly RideObstacleSource[];
  /** Exact prop contact forwarded to collision sounds and SSF collision graphs. */
  onObstacleHit?: (hit: RideObstacleHit) => void;
  /** MainType-0 boost-family volumes in world space ([Trailmap: 360-node]). Unlike the collision graphs above
   *  these act on containment, every tick a rider is inside them. */
  boostVolumes?: readonly BoostVolume[];
  /** Cracked surfaces in world space ([Trailmap: 370-world-interaction]). The physics model owns their
   *  per-tick contact gate; the scene owns the visible shatter fired when a pool runs out. */
  crackedSurfaces?: readonly CrackedSurface[];
  /** Shared by all player locomotion states in a WebXR session; absent for ordinary self-owned rides. */
  crackedSurfaceRuntime?: CrackedSurfaceRuntime;
  onCrackedChange?: (key: string, cracked: boolean) => void;
  onCrackedBreak?: (key: string) => void;
  /** Live flight samples of shoved props, polled each render frame into the telemetry capture. */
  shovedBodies?: () => readonly RideShovedBodySample[];
  /** World Y below which an eligible scored run auto-recovers (terrain min − a margin). */
  oobFloorY: number;
  /** Short label for the HUD (which mountain is being ridden). */
  label: string;
  /** World-space main course used by MainType-13 reset volumes and by the AI field's progress ruler. */
  course?: readonly THREE.Vector3[];
  /** The mountain's own finish crossing in world space (`ride/laps.FinishLine`). */
  finish?: FinishLine | null;
  /** Passes from the start gate to the finish this course is raced over (core/doc/race); 1 counts no laps. */
  laps?: number;
  /** Which event this run is (core/doc/race). The engine keeps ONE clock field and lets the mode decide its
   *  direction, and so does the HUD: a race counts up from zero, a showoff run counts `showoffSeconds` down. */
  raceMode?: RaceMode;
  /** Seconds a showoff run starts with — the mountain's own, or the slot's ([Trailmap: 390-showoff-clock]).
   *  Zero rides with no clock at all, which is what retail's two non-event slots carry. */
  showoffSeconds?: number;
  /** Type-11 course-progress stations. Only showoff consumes their seconds payload. */
  checkpoints?: readonly RideCheckpoint[];
  /** Optional recovered race-start timeline. While it runs, the board and any AI field remain at the gate. */
  countdown?: RideCountdown | null;
  /** Record the full ride immediately; manual M/F8 capture is available even when this is false. */
  telemetry?: boolean;
  /** The mountain's authored board-sound mix (docs/034); absent rides silent. */
  boardSound?: BoardSoundMix;
  /** Selected server-wide character-library model id. */
  riderModel?: string;
  /** Selected riding-style id (docs/016) — how the rider stands. */
  riderStyle?: string;
  /** Selected ride gear (docs/016) — what they stand on. The physics is the same either way. */
  gear?: RideGear;
  /** Selected snowboard foot order. Retained while skiing and applied when a snowboard is selected. */
  snowboardStance?: SnowboardStance;
  /** This signed-in rider's account-owned board/ski presentation. */
  equipmentAppearance?: EquipmentAppearance;
  /** Draw the local board's carved wake and contact particles. Set explicitly by Test mode; AI riders never
   *  construct TestRide and therefore never receive this renderer. */
  boardFx?: boolean;
  /** Terrain-height query for seating the newest wake row on the actual snow behind the board. */
  boardFxGround?: WalkGroundQuery;
  /**
   * Who is driving the view. `chase` is the ordinary editor ride: the SSX `chase near` camera owns the editor
   * camera and runs its terrain-clearance pass every frame. `vr` (docs/048) hands the view to the headset rig
   * instead — the chase camera is not updated at all, which is not just a saved write but the several BVH casts
   * its clearance pass costs, on the platform with the least frame budget to spend on a camera nobody sees.
   */
  view?: 'chase' | 'vr';
  /** The rider's world-space gaze, for VR head steer. Passed straight to the model; see `RideModelOpts.gaze`. */
  gaze?: () => THREE.Vector3 | null;
  /** Desktop on-foot ground query. Omitted in WebXR, whose session owns its walker. */
  walkGround?: WalkGroundQuery;
  /** Desktop on-foot prop body resolver, paired with `walkGround`. */
  walkResolveMove?: (from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3) => void;
  /** Refresh the editor's standard key-mapping sheet after E or V changes its live context. */
  onControlContextChange?: () => void;
  onExit: () => void;
}

export class TestRide {
  private readonly o: RideStartOpts;
  private model!: RideModel;
  private cam!: RideCamera;
  private hud!: RideHud;
  private input!: RideInput;
  private gamepad!: RideGamepad;
  private pose!: RiderPose;
  private telemetry!: RideTelemetryCapture;
  private boardAudio: BoardAudio | null = null;
  private boardFx: BoardFx | null = null;
  private pointerLock: RidePointerLock | null = null;
  private walker: Walker | null = null;
  /** The board once nobody is on it (`board-coast.ts`). Built beside the walker: it exists exactly where
   *  getting off does. */
  private boardCoast: BoardCoast | null = null;
  /** Desktop uses the same rigid held-deck/throw arithmetic as WebXR, driven by a virtual hand on the aim ray. */
  private readonly desktopBoardGrab = createBoardGrab();
  private readonly desktopBoardThrow: BoardThrow = {
    velocity: new THREE.Vector3(), spin: new THREE.Vector3(),
  };
  private readonly desktopBoardAimNdc = new THREE.Vector2();
  private desktopBoardAimPresent = false;
  private desktopBoardActionable = false;
  private desktopBoardHitDistance = Infinity;
  /** Exact deck point under the pointer, used to retain the selected tail-to-nose edge location after pickup. */
  private readonly desktopBoardHitPoint = new THREE.Vector3();
  private readonly desktopBoardRaycaster = new THREE.Raycaster();
  /** Aim target fed to the arm solver; `desktopHandPosition` below is rewritten to the solver's actual wrist. */
  private readonly desktopHandAimTarget = new THREE.Vector3();
  private readonly desktopHandPosition = new THREE.Vector3();
  private readonly desktopHandQuaternion = new THREE.Quaternion();
  private readonly desktopHandX = new THREE.Vector3();
  private readonly desktopHandY = new THREE.Vector3();
  private readonly desktopHandZ = new THREE.Vector3();
  private readonly desktopCameraUp = new THREE.Vector3();
  private readonly desktopHandBasis = new THREE.Matrix4();
  private readonly desktopBoardUp = new THREE.Vector3();
  private readonly desktopBoardForward = new THREE.Vector3();
  private readonly desktopBoardNearest = new THREE.Vector3();
  private onFootFlag = false;
  private walkYaw = 0;
  private walkPitch = 0;
  private walkJumpHeld = false;
  private walkCrouch = 0;
  private walkThirdPerson = false;
  /** Desktop board view. False is the existing chase camera; true seats it at the solved rider eye bridge. */
  private rideFirstPerson = false;
  /** One retained boom scale shared by mobile/desktop riding and walking third person. */
  private thirdPersonZoom = DEFAULT_THIRD_PERSON_ZOOM;
  private walkPoseSeated = false;
  private readonly walkFacing = new OnFootFacing();
  private walkPhase = 0;
  private walkWeight = 0;
  private walkTurnWeight = 0;
  private walkTurnDirection = 1;
  private readonly walkForward = new THREE.Vector3(0, 0, -1);
  private readonly walkEye = new THREE.Vector3();
  private readonly walkTarget = new THREE.Vector3();
  private readonly walkBodyQuaternion = new THREE.Quaternion();
  private readonly walkHeadQuaternion = new THREE.Quaternion();
  private readonly walkAnkleA = new THREE.Vector3();
  private readonly walkAnkleB = new THREE.Vector3();
  private readonly walkFlatForward = new THREE.Vector3();
  private readonly walkAcceleration = new THREE.Vector3();
  /** Start of this desktop walking frame, retained so glass sees one allocation-free swept presence sample. */
  private readonly walkCrackFrom = new THREE.Vector3();
  private readonly boostDirection = new THREE.Vector3();
  private readonly rideEye = new THREE.Vector3();
  private readonly rideViewForward = new THREE.Vector3();
  private readonly walkLookMatrix = new THREE.Matrix4();
  private started = false;
  private pausedFlag = false;
  private countdownElapsed = 0;
  /**
   * THE RUN CLOCK, in ride seconds. It is one accumulator for both events because the engine's is one field
   * ([Trailmap: 390-showoff-clock]) — a race reads it as elapsed, a showoff run subtracts it from the seeded
   * budget. It advances on `rideDt`, so the start-gate countdown and a pause cost it nothing: it starts at GO.
   */
  private runSeconds = 0;
  /** WebXR prewarms this ride on foot, so a run is explicit rather than synonymous with `TestRide.start()`. */
  private runActive = false;
  private runVisible = false;
  private runResult: 'finished' | 'time-up' | null = null;
  private runScore = 0;
  /** One fixed-tick scorer shared by desktop, the WebXR wrist, and the finish result. */
  private readonly scorer = createRideScorer();
  private lastScoreResolution = 0;
  private lastTrickResolvedAt = -Infinity;
  private finishCrossing: FinishCrossing | null = null;
  /** Time added by crossed type-11 checkpoints during this showoff run. */
  private checkpointBonusSeconds = 0;
  private checkpointTracker: CheckpointTracker | null = null;
  /** When the DOM HUD last refreshed, for the VR mirror throttle above. */
  private lastHudMs = 0;
  /** Latched the tick a showoff countdown reaches zero. The board is deliberately NOT stopped — this is a test
   *  bench, and ejecting a rider mid-slope is worse for the job than letting the clock sit at zero (docs/016). */
  private timeUp = false;
  private readonly effects: RideEffectState = {
    speedBoostSeconds: 0, trickBoostSeconds: 0, scoreMultiplier: 1, boostMeter: null,
  };

  constructor(opts: RideStartOpts) { this.o = opts; }

  // ---- lifecycle ----

  start() {
    this.telemetry = new RideTelemetryCapture({ label: this.o.label });
    this.pose = createRiderPose({
      scene: this.o.scene, riderModel: this.o.riderModel, riderStyle: this.o.riderStyle, gear: this.o.gear,
      snowboardStance: this.o.snowboardStance, equipmentAppearance: this.o.equipmentAppearance,
    });
    if (this.o.boardFx) this.boardFx = new BoardFx(this.o.scene, this.o.boardFxGround);
    if (this.inVr) this.pose.setFirstPerson(true);
    // Shared one-shot actions; held controls and ollie ownership are aggregated by createRideInput below.
    const actions: RideInputOpts = {
      ollieDown: () => { if (this.canControl) this.model.ollieDown(); },
      ollieUp: () => { if (this.canControl) this.model.ollieUp(); },
      // R / the pad's respawn is the unconditional manual exit in either locomotion state. Restarting a run is
      // Stop and ▶ Play; this carry-back instead returns near the player's current course progress.
      respawn: () => this.manualRespawn(),
      telemetryToggle: () => this.toggleTelemetry(),
      telemetryMark: () => this.markTelemetry(),
      exit: () => this.o.onExit(),
      onFoot: () => this.onFootFlag,
      toggleBoard: () => this.toggleBoard(),
      // WebXR owns its view boom for the whole headset session, including the intervals with no TestRide while
      // the board is parked. Its capture-phase V listener therefore owns the toggle there.
      ...(this.inVr ? {} : { toggleThirdPerson: () => this.toggleThirdPerson() }),
    };
    this.input = createRideInput(actions);
    this.hud = createRideHud({
      container: this.o.container, label: this.o.label,
      setHold: this.input.setHold, setWalkHold: this.input.setWalkHold,
      setOllie: this.input.setOllie, releaseSource: this.input.releaseSource,
      look: (deltaX, deltaY) => this.orbitCamera(deltaX, deltaY),
      zoom: factor => this.zoomThirdPerson(factor),
      toggleView: () => this.toggleThirdPerson(),
      toggleBoard: () => this.toggleBoard(),
      respawn: () => this.manualRespawn(),
      exit: () => this.o.onExit(),
      touchControls: this.o.touchControls,
      persistentExit: !this.inVr,
    });
    this.gamepad = createRideGamepad({
      ...actions, setHold: this.input.setHold, setWalkHold: this.input.setWalkHold, setOllie: this.input.setOllie,
      releaseSource: this.input.releaseSource, stick: this.hud.stick, lookStick: this.hud.lookStick,
      togglePause: () => this.setPaused(!this.pausedFlag),
      zoom: factor => this.zoomThirdPerson(factor),
    });
    this.model = createRideModel({
      spawn: this.o.spawn, heading: this.o.heading, terrain: this.o.terrain,
      surfaceOf: this.o.surfaceOf, patchContact: this.o.patchContact, rails: this.o.rails, oobFloorY: this.o.oobFloorY,
      keys: this.input.keys, stick: this.hud.stick, gaze: this.o.gaze,
      // The meter belongs to a live timed/scored run, not to the retained board. A free ride, a finished event,
      // or a grounded dismount/remount has no running clock/score and therefore always accepts held boost.
      heldBoostAvailable: () => !this.runActive || this.scorer.hasBoost,
      // The same run boundary owns automatic recovery. Free riding keeps the result of crashes, wedges and OOB
      // falls until the player explicitly asks for the public/manual carry-back.
      automaticRespawnAvailable: () => this.runActive,
      onRespawn: () => { this.scorer.bail(); this.syncScoreState(); this.cam.resetAim(this.model.st.pos); },
      onTelemetryTick: tick => { this.telemetry.ingest(tick); this.scorer.ingest(tick); this.syncScoreState(); },
      obstacles: this.o.obstacles,
      onObstacleHit: this.o.onObstacleHit,
      boostVolumes: this.o.boostVolumes,
      crackedSurfaces: this.o.crackedSurfaces,
      crackedSurfaceRuntime: this.o.crackedSurfaceRuntime,
      onCrackedChange: this.o.onCrackedChange,
      onCrackedBreak: this.o.onCrackedBreak,
      course: this.o.course, finish: this.o.finish, laps: this.o.laps,
      onLap: remaining => this.onLap(remaining),
    });
    if (!this.inVr && this.o.walkGround) {
      this.walker = createWalker({
        ground: this.o.walkGround,
        resolveMove: this.o.walkResolveMove,
        oobFloorY: this.o.oobFloorY,
        onFell: () => { if (this.runActive) this.resetWalker(); },
      });
      // The loose deck rides the same floor the walker does — terrain plus every solid prop — so a board that
      // slid onto a roof settles on the roof rather than through it.
      this.boardCoast = createBoardCoast({
        ground: this.o.walkGround, oobFloorY: this.o.oobFloorY,
        // A bail over a cliff sends the deck over it too. Put it back at the run's start, which is somewhere a
        // rider on foot can actually walk to; the alternative is one board, parked under the world, forever.
        onLost: () => this.boardCoast?.park(this.o.spawn, this.o.heading ?? this.model.st.fwd),
      });
    }
    if (this.o.telemetry) {
      this.telemetry.start();
      this.hud.setTelemetry('● TELEM recording · M mark · F8 save', true);
    }
    this.cam = createRideCamera({
      camera: this.o.camera, castSeg: this.model.castSeg, toWorld: this.model.toWorld,
      initialThirdPersonZoom: this.thirdPersonZoom,
      castObstacleSeg: this.model.castCameraObstacle,
      closestTerrainPoint: this.model.closestCameraTerrain,
    });
    if (!this.inVr && this.o.pointerTarget) {
      this.pointerLock = createRidePointerLock({
        target: this.o.pointerTarget,
        onMove: (deltaX, deltaY) => this.orbitCamera(deltaX, deltaY),
      });
    }
    // The board bed (docs/034). Built here, after the launch click, so its AudioContext starts on a gesture.
    if (this.o.boardSound) this.boardAudio = createBoardAudio(this.o.boardSound);
    // On a touch device this hides the editor chrome for the run (index.html) — the ride is full-screen and draws
    // its own controls. Harmless on a fine pointer, where the top bar keeps its Stop button.
    document.body.classList.add('os-riding');
    this.pointerLock?.attach();
    this.input.attach();
    this.gamepad.attach();

    this.model.start();
    if (this.o.countdown) this.model.seatAtSpawn();
    const st = this.model.st;
    // The camera trails TRAVEL and falls back to the ridden direction, never the drawn nose: a switch rider at a
    // standstill is pointing backwards, and seeding the chase off that whips the view around behind them.
    const ride = rideForward(st, new THREE.Vector3());
    this.cam.setHeading(ride);
    this.cam.update(1, st.pos, st.vel, ride, st.grounded, this.model.boostActive());
    this.telemetry.ingestCamera(this.cam.telemetry(1));
    this.pose.update(st, 0, this.input.keys); // seat the board before the first render, not at the world origin
    this.started = true;
    // A desktop launch is already on its board. WebXR only PREWARMS here and starts the run on the first mount.
    if (!this.inVr) this.startRun();
    this.syncDesktopView();
    this.hud.setCountdown(this.countdownCue());
    this.showRunClock();
  }

  stop() {
    if (this.telemetry.active) this.saveTelemetry();
    document.body.classList.remove('os-riding');
    this.pointerLock?.detach();
    this.pointerLock = null;
    this.input.detach();
    this.gamepad.detach();
    this.pose.dispose();
    this.boardFx?.dispose();
    this.boardFx = null;
    this.boardAudio?.dispose();
    this.boardAudio = null;
    this.hud.dispose();
    this.walker = null;
    this.boardCoast = null;
    this.desktopBoardGrab.clear();
    this.desktopBoardAimPresent = false;
    this.desktopBoardActionable = false;
    this.onFootFlag = false;
    this.walkThirdPerson = false;
    this.rideFirstPerson = false;
    this.pausedFlag = false;
    this.started = false;
  }

  private toggleTelemetry() {
    if (this.telemetry.active) { this.saveTelemetry(); return; }
    this.telemetry.start();
    this.hud.setTelemetry('● TELEM recording · F8 save', true);
    console.info('[ride telemetry] recording started (three-second pre-roll included)');
  }

  private markTelemetry() {
    const marker = this.telemetry.mark();
    this.hud.setTelemetry(`● TELEM recording · MARK ${marker.index}`, true);
    console.info(`[ride telemetry] marker ${marker.index} at physics frame ${marker.frame}`);
  }

  private saveTelemetry() {
    const output = this.telemetry.finish();
    if (!output) return;
    downloadRideTelemetry(output);
    this.hud.setTelemetry(`TELEM saved · ${output.summary.frames} frames`);
    console.info('[ride telemetry] saved', output.summary);
  }

  // ---- per-frame step ----

  /**
   * Bank the frame's real time and spend it in whole 60 Hz physics ticks. The pose, camera and HUD are frame
   * things and run once, after; everything with a `dt` in it below is a *tick*.
   */
  step(dt: number) {
    if (!this.started) return;
    // Sample the pad every frame, including the countdown, so exit / respawn edges always land. The mirror keeps
    // any visible labelled diagram tracking the pad (controller diagnostics). A detected pad clears the diagram
    // once the screen has gone untouched long enough; touching the screen reveals it again temporarily.
    const pad = this.gamepad.poll(dt);
    this.hud.mirrorPad(pad);
    if (pad) this.hud.notePadPresent();
    if (dt <= 0) return;
    // The physical right stick is a continuous camera rate in every locomotion/view mode. Touch/mouse look is
    // already direct and reaches orbitCamera from its own event, so it does not pass through this frame scaler.
    if (this.hud.lookStick.active) {
      const rate = this.onFootFlag ? WALK_LOOK_STICK_PIXELS_PER_SECOND : RIDE_LOOK_STICK_PIXELS_PER_SECOND;
      this.orbitCamera(this.hud.lookStick.x * rate * dt, this.hud.lookStick.y * rate * dt);
    }
    if (this.onFootFlag) {
      let flightBoosting = false;
      if (!this.pausedFlag) { flightBoosting = this.stepWalker(dt); this.stepBoardCoast(dt); }
      else { this.updateWalkCamera(); this.updateWalkAvatar(0); this.stepBoardCoast(0); }
      this.boardAudio?.updateFlightBoost(flightBoosting, dt);
      return;
    }
    if (this.pausedFlag) {
      // Keep the rider-relative camera alive while the board, pose, countdown and telemetry clock are frozen.
      // This is what lets RMB inspect the held pose instead of requiring the simulation to resume first.
      const st = this.model.st, rs = this.model.renderState();
      this.cam.update(dt, rs.pos, rs.vel, rs.rideFwd, st.grounded, this.model.boostActive());
      this.boardAudio?.fadeSilent(dt); // a held pose makes no sound; the bed picks up where it left off
      return;
    }
    let rideDt = dt;
    const countdown = this.o.countdown;
    if (countdown) {
      const before = this.countdownElapsed;
      // The graph runner clamps its animation step to 100 ms so a resumed/background tab cannot skip a Wait
      // chain. Advance the gameplay gate on that same clock or a hitch would release the board before its light.
      this.countdownElapsed += Math.min(dt, 0.1);
      this.hud.setCountdown(this.countdownCue());
      if (before < countdown.holdSeconds) {
        rideDt = Math.max(0, this.countdownElapsed - countdown.holdSeconds);
        if (rideDt <= 0) return;
      }
    }
    // Only a live timed/scored run spends held boost. The retained board may be remounted after that run was
    // abandoned or finished; in that no-clock state boost is unlimited and no stale scorer meter may gate it.
    // If this frame empties an ACTIVE meter, no fixed tick receives held thrust. Course pads remain independent.
    if (this.runActive) this.scorer.stepBoost(rideDt, this.input.keys.boost);
    this.syncScoreState();
    this.tickRunClock(rideDt);
    this.model.step(rideDt);
    // The clock was advanced before physics; repaint once after the fixed ticks so its score is this frame's
    // live trick preview rather than one render behind it.
    this.showRunClock();
    this.tickRaceFinish();
    this.tickCheckpoints();
    const perf = this.model.perf;
    perf.physicsMs = smoothRideMs(perf.physicsMs, performance.now() - perf.stepT0);
    this.effects.speedBoostSeconds = this.model.padBoostSeconds;
    this.effects.trickBoostSeconds = Math.max(0, this.effects.trickBoostSeconds - rideDt);
    this.finishFrame(rideDt);
  }

  /**
   * A finish crossing counted as a lap. The run keeps going on the same clock — sending the rider back up the
   * mountain is the finish TUBE's job, not the counter's ([Trailmap: 390-lap-counter]), so a course authored
   * with laps and no lap-gated volume simply leaves them at the bottom, exactly as it would on the disc.
   */
  private onLap(remaining: number) {
    const laps = this.model.laps;
    if (laps) this.hud.setLaps(laps);
    // The announcer's own line: the counter as it lands — "3 LAPS LEFT" at MEGAPLEX's first crossing, then 2,
    // then the final lap ([Trailmap: 390-lap-rate]). The finish crossing never lands here (it is not a lap).
    this.hud.setCountdown(remaining === 1 ? 'FINAL LAP' : `${remaining} LAPS LEFT`);
    window.setTimeout(() => { if (this.started) this.hud.setCountdown(this.countdownCue()); }, 1400);
  }

  /** Advance the run clock and, in showoff, land it. The expiry cue borrows the countdown's own big label, so
   *  "TIME UP" arrives where READY / 3 / 2 / 1 / GO did — the same place the run's own moments are announced. */
  private tickRunClock(dt: number) {
    // A free ride has no clock to advance and no chip to repaint — the mountain with no event on it.
    if (!this.runActive || this.timeUp || !raceModeIsTimed(this.raceMode)) return;
    this.runSeconds += dt;
    // A mountain authored with NO showoff clock (retail's non-event slots carry zero) has nothing to expire, so
    // it rides on with no chip and no cue rather than reading TIME UP on its first tick.
    if (this.raceMode === 'showoff' && (this.o.showoffSeconds ?? 0) > 0 && this.showRunClockSeconds() <= 0) {
      this.finishRun('time-up');
      this.hud.setCountdown('TIME UP');
      window.setTimeout(() => { if (this.started) this.hud.setCountdown(this.countdownCue()); }, 1800);
    }
    this.showRunClock();
  }

  /** Query the forward course-progress interval crossed by this physics tick and apply its type-11 payload.
   *  Race/free ride still cross the same authored stations, but retail's handler only adds time in showoff. */
  private tickCheckpoints() {
    if (!this.runActive || this.raceMode !== 'showoff' || this.timeUp || !this.checkpointTracker) return;
    const awards = this.checkpointTracker.step(this.model.st.pos);
    if (!awards.length) return;
    const bonus = awards.reduce((sum, award) => sum + award.bonusSeconds, 0);
    this.checkpointBonusSeconds += bonus;
    const minutes = Math.floor(bonus / 60), seconds = bonus % 60;
    this.showRunClock();
    this.hud.showTimeBonus(`TIME BONUS +${minutes}:${String(seconds).padStart(2, '0')}`);
  }

  /** Which event this ride is; absent opts ride the bench's own default (core/doc/race). */
  private get raceMode(): RaceMode { return this.o.raceMode ?? DEFAULT_RACE_MODE; }

  /** What the clock READS: elapsed in a race, remaining in showoff. */
  private showRunClockSeconds(): number {
    return this.raceMode === 'showoff'
      ? (this.o.showoffSeconds ?? 0) + this.checkpointBonusSeconds - this.runSeconds
      : this.runSeconds;
  }

  /** Push the current reading to the HUD. Two runs show nothing: a FREE RIDE, which has no event to time, and a
   *  showoff run on a mountain authored at zero seconds — which is how retail's non-event slots read, so the
   *  chip is hidden rather than parked at 0:00.00 from the first tick. */
  private showRunClock() {
    const mode = this.raceMode;
    if (!this.runVisible || !raceModeIsTimed(mode) || (mode === 'showoff' && !(this.o.showoffSeconds ?? 0))) {
      this.hud.setRunClock(null);
      return;
    }
    this.hud.setRunClock(this.runStatus);
  }

  /** A single pass finishes immediately; a lap course finishes only once its shared counter says this was last. */
  private tickRaceFinish() {
    if (!this.runActive || this.raceMode !== 'race' || !this.finishCrossing?.step(this.model.st.pos)) return;
    if (this.model.laps && !this.model.laps.finished) return;
    this.finishRun('finished');
    this.hud.setCountdown('FINISHED');
    window.setTimeout(() => { if (this.started) this.hud.setCountdown(this.countdownCue()); }, 2200);
  }

  private finishRun(result: 'finished' | 'time-up') {
    this.runScore = this.scorer.finish();
    this.syncScoreState();
    this.runActive = false;
    this.runResult = result;
    this.timeUp = result === 'time-up';
    this.showRunClock();
  }

  /** Current race cue. GO lingers briefly after the hold releases, while the board is already moving. */
  private countdownCue(): string | null {
    const countdown = this.o.countdown;
    if (!countdown || !countdown.cues.length || this.countdownElapsed > countdown.holdSeconds + 0.7) return null;
    let cue: string | null = null;
    for (const item of countdown.cues) if (item.at <= this.countdownElapsed + 1e-6) cue = item.label;
    return cue;
  }

  // ---- frame finish: orientation + camera + hud ----

  private finishFrame(dt: number) {
    const st = this.model.st, perf = this.model.perf;
    // The pose and camera draw the model's between-ticks render view, not the raw tick state — on a display
    // faster than the 60 Hz simulation the raw state aliases whole-tick jumps into avatar judder.
    const rs = this.model.renderState();
    let started = performance.now();
    this.pose.update(st, dt, this.input.keys, rs);
    this.boardFx?.update({
      pos: rs.pos, fwd: rs.fwd, vel: rs.vel,
      normal: st.contactN, grounded: st.grounded, surfaceGap: st.error, grinding: st.railIdx >= 0,
      surf: st.surf, lean: st.lean,
      boardPosition: this.pose.board.position, boardQuaternion: this.pose.board.quaternion,
      // Retail's render gate reads held boost OR the pad request, independently of contact. The same gate makes
      // Slopesmith's board-pointed air thrust inherit this effect without a second airborne-only implementation.
      boostActive: this.model.boostActive(), boostEnergy: this.effects.boostMeter ?? 1,
      padBoost: this.model.padBoostSeconds > 0,
      // Ground/rail boost still follows ridden travel (including switch). Air boost follows the visible nose.
      // Naming the actual force direction lets the shared trail choose the exhaust end correctly in both cases.
      boostDirection: st.grounded ? this.boostDirection.copy(rs.rideFwd)
        : this.boostDirection.set(0, 0, 1).applyQuaternion(this.pose.board.quaternion),
    }, dt, this.pose.gear);
    perf.poseMs = smoothRideMs(perf.poseMs, performance.now() - started);
    started = performance.now();
    // In VR the headset rig owns the view (docs/048), so both desktop camera paths stand down entirely. On a
    // desktop V chooses between the retail chase boom and the live avatar's solved eye bridge.
    if (!this.inVr) {
      if (this.rideFirstPerson) this.updateRideFirstPersonCamera();
      else this.cam.update(dt, rs.pos, rs.vel, rs.rideFwd, st.grounded, this.model.boostActive());
    }
    perf.cameraMs = smoothRideMs(perf.cameraMs, performance.now() - started);
    // The board bed reads the TICK state, not the render view: it is performed by the physics, and the
    // interpolated pose would smear the touchdown/launch edges its transients are found on.
    this.boardAudio?.update(st, dt, this.model.boostThrustActive());
    // The camera performs its own terrain/prop clearance casts, so sample the shared accumulator only after it.
    perf.castMs = smoothRideMs(perf.castMs, perf.castAccum);
    started = performance.now();
    if (!this.inVr) this.telemetry.ingestCamera(this.cam.telemetry(dt));
    // After the camera so both carry the same frame/renderFrame pair; an empty poll is the common free case.
    const shoved = this.o.shovedBodies?.();
    if (shoved?.length) this.telemetry.ingestShovedBodies(shoved);
    perf.telemetryMs = smoothRideMs(perf.telemetryMs, performance.now() - started);
    started = performance.now();
    // In VR this HUD is on the DESKTOP MIRROR — nobody in the headset can see it, and it is a couple of dozen DOM
    // writes plus a rebuilt multi-line profiler string every frame, at 72–120 Hz, competing with the frame budget
    // that matters. So it drops to a readable few times a second and the headset reads its own wrist panel
    // (docs/048). A chase ride keeps every frame: there, this HUD IS the view.
    if (!this.inVr || started - this.lastHudMs >= VR_MIRROR_HUD_MS) {
      this.lastHudMs = started;
      this.hud.update(st, this.model.boostActive(), perf, this.effects);
      this.hud.setLaps(this.model.laps);
    }
    // The HUD necessarily displays its previous smoothed cost; measuring after the DOM writes avoids lying about
    // the work while keeping this profiler from scheduling a second layout/update pass.
    perf.hudMs = smoothRideMs(perf.hudMs, performance.now() - started);
  }

  /** Called after WebGL submission; the next HUD update displays this complete viewport-frame sample. */
  recordFramePerf(sample: RideFrameTimingSample) {
    if (this.started) recordRideFrameTimings(this.model.perf, sample);
  }

  /**
   * Apply the gameplay-bearing subset of an SSF graph to the live board — and, with it, the **cue** the game
   * plays from engine code on that same path. A gem chime and a pad hit are not sound nodes in the graph: the
   * node carries the multiplier or the boost, and the handler that applies it plays a fixed MAIN-bank slot
   * [Trailmap: 390-pickups-and-race]. So they belong here, at the apply, rather than in the effects runtime
   * that plays the graph's own authored sounds (docs/034).
   */
  applyEffect(action: RideEffectAction) {
    if (!this.started || this.pausedFlag) return;
    switch (action.kind) {
      // A graph/volume reset is world-driven too. Only the input callbacks above own unconditional manual reset.
      case 'reset': if (this.runActive) this.model.resetToCourse(); break;
      case 'hud-message':
        this.hud.showMessage(action.text, action.color, action.durationSeconds); break;
      case 'speed-boost':
        this.model.applyPadBoost(action.amount); this.boardAudio?.padCue('speed'); break;
      case 'trick-boost':
        this.effects.trickBoostSeconds = Math.max(this.effects.trickBoostSeconds, action.seconds);
        this.boardAudio?.padCue('trick'); break;
      case 'score-multiplier':
        // Native gems are Showoff-only, and the handler independently gates the score-state write too. Keep this
        // defensive check for custom/manual effect dispatch; its cue is meaningful only when that dispatch occurs.
        if (scoringEffectsApplyInMode(this.raceMode)) this.scorer.applyMultiplier(action.multiplier);
        this.syncScoreState();
        this.boardAudio?.gemChime(action.multiplier); break;
      case 'teleport':
        this.model.warpTo(action.position, action.heading, Math.max(8, this.model.st.vel.length())); break;
    }
  }

  /** Move this desktop participant beside another live player without rebuilding the Play session. Mounted
   * riders keep useful forward speed; an on-foot rider moves their body while their loose board remains where
   * they left it. This is an explicit UI relocation, so it is allowed while paused. */
  teleportTo(position: THREE.Vector3, heading: THREE.Vector3): boolean {
    if (!this.started || this.inVr) return false;
    const facing = heading.clone().setY(0);
    if (facing.lengthSq() < 1e-6) facing.copy(this.model.st.fwd).setY(0);
    if (facing.lengthSq() < 1e-6) facing.set(0, 0, 1);
    facing.normalize();

    if (this.onFootFlag && this.walker) {
      this.walker.placeAt(position);
      this.walkPitch = 0;
      this.walkYaw = Math.atan2(-facing.x, -facing.z);
      this.walkPoseSeated = false;
      this.walkFacing.clear();
      this.updateWalkCamera();
      this.updateWalkAvatar(0);
      return true;
    }

    this.model.warpTo(position, facing, Math.max(8, this.model.st.vel.length()));
    this.model.seatAtSpawn();
    this.boardFx?.clear();
    const st = this.model.st, view = this.model.renderState();
    this.cam.setHeading(view.rideFwd);
    this.cam.resetAim(view.pos);
    this.pose.update(st, 0, this.input.keys, view);
    if (this.rideFirstPerson) this.updateRideFirstPersonCamera();
    else this.cam.update(1, view.pos, view.vel, view.rideFwd, st.grounded, this.model.boostActive());
    return true;
  }

  /** The live physics state — the AI field reads it as its catch-up reference (the rider it races). */
  get state() { return this.model.st; }
  /** True while the headset rig owns the view instead of the chase camera (docs/048). */
  get inVr() { return this.o.view === 'vr'; }
  /** The live profiler — the VR wrist panel reads the same phases the desktop HUD's chip does (docs/048). */
  get perf() { return this.model.perf; }

  /**
   * The between-ticks render view — where the deck is actually DRAWN this frame, not the raw tick state. The VR
   * rig seats itself on this for the same reason the pose does: on a display faster than the 60 Hz simulation,
   * the raw state aliases whole-tick jumps, and a jump the head can feel is much worse than one it can see.
   */
  renderView() { return this.model.renderState(); }

  /** Desktop Play stays one session while E or pointer interaction parks/unparks its board. */
  get onFoot() { return this.onFootFlag; }
  get firstPerson() { return this.onFootFlag ? !this.walkThirdPerson : this.rideFirstPerson; }
  get activePosition() { return this.onFootFlag && this.walker ? this.walker.position() : this.model.st.pos; }
  get activeVelocity() { return this.onFootFlag && this.walker ? this.walker.velocity() : this.model.st.vel; }

  /** Owner-authoritative world pose for the disposable multiplayer stream. The chase camera is intentionally
   * absent while riding: another player should see the rider on the board, not a body floating behind it. */
  playerPose(): LocalPlayerPose {
    if (this.onFootFlag && this.walker) {
      const headP = this.o.camera.getWorldPosition(new THREE.Vector3());
      const headQ = this.walkHeadQuaternion.clone();
      if (this.walkThirdPerson) headP.copy(this.walkEye);
      const forward = this.walkForward.clone().setY(0);
      if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1); else forward.normalize();
      const bodyQ = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 1, 0), Math.atan2(forward.x, forward.z),
      );
      const coast = this.boardCoast!; // created with the desktop walker; dismount launches it before this branch
      const held = this.desktopBoardGrab.held;
      return {
        mode: 'walk', vr: false, gear: this.pose.gear, stance: this.pose.snowboardStance,
        body: playerTransform(this.walker.position(), bodyQ),
        velocity: playerVec(this.walker.velocity()),
        equipment: {
          state: held ? 'held' : 'loose',
          transform: playerTransform(this.pose.board.position, this.pose.board.quaternion),
          velocity: playerVec(held ? this.desktopBoardGrab.velocity : coast.vel), epoch: coast.epoch,
        },
        animation: {
          grounded: this.walker.isGrounded(), crouch: this.walkCrouch, lean: 0, bank: 0,
          ...(this.walker.isFlying() ? { flying: true } : {}),
        },
        head: playerTransform(headP, headQ),
      };
    }
    // On skis this quaternion is the FLAT frame: a pair does not roll as a unit, so the deck pose carries
    // facing and the `bank` below is what re-edges each ski on the receiving side (`gear.ts`).
    const board = playerTransform(this.pose.board.position, this.pose.board.quaternion);
    const velocity = playerVec(this.model.renderState().vel);
    return {
      mode: 'ride', vr: false, gear: this.pose.gear, stance: this.pose.snowboardStance, body: board,
      velocity,
      equipment: {
        state: 'mounted', transform: board, velocity,
        epoch: this.boardCoast?.epoch ?? 0,
      },
      animation: {
        grounded: this.model.st.grounded, crouch: this.model.st.crouch,
        lean: this.model.st.lean * this.model.st.lead, bank: this.model.st.bank * this.model.st.lead,
        lead: this.model.st.lead,
      },
    };
  }

  private toggleBoard() {
    if (!this.started || this.inVr || !this.walker) return;
    if (this.onFootFlag) this.mountBoard(); else this.dismountBoard();
  }

  private dismountBoard() {
    if (!this.walker || this.onFootFlag) return;
    const continuingFirstPerson = this.rideFirstPerson;
    const airborne = !this.model.st.grounded;
    this.desktopBoardGrab.clear();
    this.pose.highlightBoard(false);
    const view = this.model.renderState();
    // Match RideableBoard.Dismount: coast from the simulation velocity, not the interpolated render sample.
    // The latter may lag by a fixed step and can make a moving board visibly lose momentum when ownership flips.
    const coastVelocity = this.model.st.vel.clone();
    const carry = this.model.st.grounded ? undefined : coastVelocity.clone();
    // Getting off is not putting the board away: the deck keeps the complete velocity above, then coasts on its
    // own under 14 m/s² gravity (`board-coast.ts`). The rider uses 9.81 m/s², so the stronger equipment gravity
    // creates the separation without altering either half at the handoff.
    this.boardCoast?.launch(view.pos, coastVelocity, this.model.st.fwd, this.model.st.boardUp);
    this.o.camera.getWorldDirection(this.walkForward).normalize();
    this.walkPitch = Math.asin(THREE.MathUtils.clamp(this.walkForward.y, -1, 1));
    this.walkYaw = Math.atan2(-this.walkForward.x, -this.walkForward.z);
    this.onFootFlag = true;
    this.boardFx?.clear();
    this.input.releaseSource('keyboard');
    this.input.releaseSource('gamepad');
    this.input.releaseSource('touch');
    this.input.clearWalk();
    this.hud.stick.active = false;
    this.hud.stick.x = this.hud.stick.airX = this.hud.stick.y = 0;
    this.hud.lookStick.active = false;
    this.hud.lookStick.x = this.hud.lookStick.y = 0;
    // A held ollie belongs to the board being left behind; do not bank its release for the eventual remount.
    this.model.st.charging = false;
    this.model.st.charge = 0;
    // Keep the pose's head treatment current for model swaps and multiplayer sampling. The desktop view sync
    // below hides the complete local body; WebXR takes a separate path and keeps the body beneath the headset.
    this.pose.setFirstPerson(continuingFirstPerson);
    this.walker.placeAt(view.pos, carry);
    if (!airborne) this.abandonRun();
    this.walkJumpHeld = false;
    this.walkCrouch = 0;
    // Getting off changes locomotion, not perspective. Chase stays chase and first person stays first person.
    this.walkThirdPerson = !continuingFirstPerson;
    this.syncDesktopView();
    this.walkPoseSeated = false;
    this.walkFacing.clear();
    this.hud.setWalking(true);
    this.updateWalkCamera();
    this.updateWalkAvatar(0);
  }

  private mountBoard(atHighlightedBoard = false) {
    if (!this.onFootFlag || !this.walker) return;
    const continuingFirstPerson = !this.walkThirdPerson;
    this.desktopBoardGrab.clear();
    this.pose.highlightBoard(false);
    this.desktopBoardActionable = false;
    this.onFootFlag = false;
    // E/gamepad/touch remains the convenient in-place recall. Clicking a highlighted deck is spatial instead:
    // step onto the thing that was clicked, with its own facing and (if airborne) its carried arc.
    const coast = this.boardCoast;
    const at = atHighlightedBoard ? this.pose.board.position.clone() : this.walker.position();
    const heading = this.walkFlatForward.copy(atHighlightedBoard
      ? this.desktopBoardForward.set(0, 0, 1).applyQuaternion(this.pose.board.quaternion)
      : this.walkForward).setY(0);
    if (heading.lengthSq() < 1e-8) heading.copy(this.model.st.fwd).setY(0);
    const airborne = atHighlightedBoard ? coast?.grounded === false : !this.walker.isGrounded();
    const carry = airborne
      ? (atHighlightedBoard ? coast?.vel.clone() ?? null : this.walker.velocity().clone())
      : null;
    this.model.warpTo(at, heading, 0);
    if (carry) this.model.mountAirborne(carry, at);
    else this.model.seatAtMount(); // admit only the solid directly supporting this grounded remount
    coast?.stop();
    this.boardFx?.clear(); // a fresh track must not stitch back to the parked board's last sample
    this.input.clearWalk();
    this.walkJumpHeld = false;
    this.walkCrouch = 0;
    // Getting on changes locomotion, not perspective. Preserve the walking view on the mounted camera.
    this.rideFirstPerson = continuingFirstPerson;
    this.walkPoseSeated = false;
    this.pose.setFirstPerson(continuingFirstPerson);
    this.syncDesktopView();
    this.hud.setWalking(false);
    const st = this.model.st, view = this.model.renderState();
    this.cam.setHeading(view.rideFwd);
    if (continuingFirstPerson) {
      // The spatial LMB mount may be metres from the old walking body; solve the mounted eye before seating the
      // camera so there is no one-frame flash back at the abandoned walking position.
      this.pose.update(st, 0, this.input.keys, view);
      this.updateRideFirstPersonCamera();
    } else this.cam.update(1, view.pos, view.vel, view.rideFwd, st.grounded, this.model.boostActive());
  }

  private resetWalker() {
    if (!this.walker) return;
    this.walker.placeAt(this.o.spawn);
    this.updateWalkCamera();
  }

  /** R / gamepad / touch: unlike world-driven recovery, this is available in free ride and while on foot. */
  private manualRespawn() {
    if (!this.started || this.pausedFlag || this.countingDown) return;
    if (this.onFootFlag && this.walker) {
      this.model.resetToCourse(this.walker.position());
      this.walker.placeAt(this.model.st.pos);
      this.updateWalkCamera();
      return;
    }
    if (this.canControl) this.model.resetToCourse();
  }

  private stepWalker(dt: number): boolean {
    if (!this.walker) return false;
    this.walkCrackFrom.copy(this.walker.position());
    const keys = this.input.walkKeys;
    // The left virtual/physical stick is view-relative movement. Camera input was applied once at frame entry;
    // keyboard/mouse remains additive, so a held W survives a thumb briefly touching the movement stick.
    const analogX = this.hud.stick.active ? this.hud.stick.x : 0;
    const analogY = this.hud.stick.active ? this.hud.stick.y : 0;
    this.walkCrouch += (Number(keys.crouch) - this.walkCrouch)
      * (1 - Math.exp(-WALK_CROUCH_RESPONSE * Math.max(0, dt)));
    const jump = keys.jump && !this.walkJumpHeld;
    this.walkJumpHeld = keys.jump;
    this.walker.step(dt, {
      moveX: THREE.MathUtils.clamp(Number(keys.right) - Number(keys.left) + analogX, -1, 1),
      moveY: THREE.MathUtils.clamp(Number(keys.forward) - Number(keys.back) + analogY, -1, 1),
      forward: this.walkForward,
      jump,
      jumpHeld: keys.jump,
      crouch: keys.crouch,
      boost: keys.boost,
    });
    // The board model is intentionally idle while dismounted, but its glass pool is world/session state. Feed
    // the walker's full frame chord so ordinary walking, a jump, and Superman flight all retain crack contact —
    // with the standing body's height, so a chest-high pane registers on the torso and not only at the feet.
    this.model.stepCrackedSurfaces(
      this.walkCrackFrom, this.walker.position(), this.walker.velocity(), Math.min(Math.max(0, dt), 0.1),
      RIDER_HEAD_Y,
    );
    // A desktop jump-off follows the same run contract as WebXR: the clock and any held-deck grab continue in
    // the air, while touching down without the board abandons the gate result.
    this.stepRunOffBoard(dt, this.walker.isGrounded(), this.desktopBoardGrab.hand);
    this.updateWalkCamera();
    this.updateWalkAvatar(dt);
    return this.walker.isFlightBoosting();
  }

  /**
   * Advance the board the rider is no longer on and draw it there. The ride model is not stepped while walking
   * — nobody is driving it — so this is the only thing moving the deck, and the only thing posing it.
   *
   * Deliberately silent and trackless: `board-audio` is faded out above and `board-fx` was cleared at the
   * dismount, because a loose board sliding downhill is not performing a ride. The Unity board does keep laying
   * its wake here; matching that would mean handing this path a surface table it otherwise has no use for.
   */
  private stepBoardCoast(dt: number) {
    const coast = this.boardCoast;
    if (!coast) return;
    this.refreshDesktopBoardTarget();
    if (this.desktopBoardGrab.held) {
      this.desktopBoardGrab.follow(
        this.desktopHandPosition, this.desktopHandQuaternion, dt,
        this.pose.board.position, this.pose.board.quaternion,
      );
      this.pose.highlightBoard(false);
      return;
    }
    if (coast.active && dt > 0) {
      coast.step(dt);
      this.pose.seatBoard(coast.pos, coast.up, coast.fwd);
    }
    // The coast may have moved through the ray this frame; highlight the pose that was actually drawn.
    this.refreshDesktopBoardTarget();
  }

  /** Pose the same production body remote observers use. Keeping it warm in first person makes V a view toggle,
   * not a fresh animation start, and keeps held-equipment reach animation continuous across perspective changes. */
  private updateWalkAvatar(dt: number, carrying = this.desktopBoardGrab.held) {
    if (!this.walker) return;
    this.resolveWalkLook();
    if (carrying) {
      this.refreshDesktopBoardTarget();
      this.updateDesktopCarryAim();
    }
    const velocity = this.walker.velocity();
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const targetWalk = THREE.MathUtils.clamp(horizontalSpeed / 1.2, 0, 1);
    this.walkWeight += (targetWalk - this.walkWeight) * (1 - Math.exp(-10 * Math.max(0, dt)));
    if (horizontalSpeed > 0.05) {
      this.walkPhase += dt * Math.PI * 2 * (1.2 + Math.min(horizontalSpeed, 7) * 0.22);
      if (this.walkPhase > Math.PI * 2) this.walkPhase %= Math.PI * 2;
    }
    const facing = this.walkFacing.step(dt, this.walkBodyQuaternion, this.walkHeadQuaternion, horizontalSpeed);
    const turnDelta = this.walkFacing.turnDelta;
    if (Math.abs(turnDelta) > 1e-6) this.walkTurnDirection = Math.sign(turnDelta);
    this.walkTurnWeight += (Number(Math.abs(turnDelta) > 1e-6) - this.walkTurnWeight)
      * (1 - Math.exp(-16 * Math.max(0, dt)));
    if (horizontalSpeed <= 0.05 && this.walkTurnWeight > 0.01) {
      this.walkPhase += dt * Math.PI * 2 * 2.2;
      if (this.walkPhase > Math.PI * 2) this.walkPhase %= Math.PI * 2;
    }
    const root = this.walker.position();
    this.walkAnkleA.copy(this.pose.ankleFront).add(root);
    this.walkAnkleB.copy(this.pose.ankleRear).add(root);
    const input = {
      ankleFront: this.walkAnkleA, ankleRear: this.walkAnkleB,
      deckUp: THREE.Object3D.DEFAULT_UP, soleUp: THREE.Object3D.DEFAULT_UP, bank: 0,
      vel: velocity, accel: this.walkAcceleration, grounded: this.walker.isGrounded(), dt,
      crouch: this.walkCrouch, lean: 0,
      locomotion: {
        phase: this.walkPhase, weight: this.walkWeight, facing,
        turn: this.walkTurnDirection * this.walkTurnWeight,
        flying: this.walker.isFlying(),
      },
      pointTargets: carrying ? [{
        hand: 'right' as const,
        direction: this.desktopHandY,
        target: this.desktopHandAimTarget,
        weight: 1,
      }] : null,
      headTarget: { position: this.walkEye, quaternion: this.walkHeadQuaternion, exactPosition: false },
    };
    if (this.walkPoseSeated) this.pose.rider.pose(input);
    else { this.pose.rider.reset(input); this.walkPoseSeated = true; }
    // The arm solver owns the reachable wrist. Using it as the rigid grab hand keeps the glove and deck joined
    // instead of letting an arbitrary point on the camera ray pull the deck beyond a person's arm length.
    if (carrying) this.desktopHandPosition.copy(this.pose.rider.solved.handFront);
    // Desktop first person never draws the local body. The pose still solves while carrying so the reachable
    // wrist can anchor the board, but only WebXR keeps the embodied avatar visible from a first-person view.
    this.pose.rider.group.visible = this.walkThirdPerson;
  }

  private resolveWalkLook() {
    const horizontal = Math.cos(this.walkPitch);
    this.walkForward.set(
      -Math.sin(this.walkYaw) * horizontal,
      Math.sin(this.walkPitch),
      -Math.cos(this.walkYaw) * horizontal,
    ).normalize();
    this.walkHeadQuaternion.setFromRotationMatrix(this.walkLookMatrix.lookAt(
      this.walkEye, this.walkTarget.copy(this.walkEye).add(this.walkForward), THREE.Object3D.DEFAULT_UP,
    ));
    const flat = this.walkFlatForward.copy(this.walkForward).setY(0);
    if (flat.lengthSq() < 1e-8) flat.set(0, 0, -1); else flat.normalize();
    this.walkBodyQuaternion.setFromAxisAngle(
      THREE.Object3D.DEFAULT_UP, Math.atan2(flat.x, flat.z),
    );
  }

  private updateWalkCamera() {
    if (!this.walker) return;
    const eyeHeight = THREE.MathUtils.lerp(WALK_EYE_HEIGHT, WALK_CROUCH_EYE_HEIGHT, this.walkCrouch);
    this.walkEye.copy(this.walker.position()).addScaledVector(THREE.Object3D.DEFAULT_UP, eyeHeight);
    this.resolveWalkLook();
    this.o.camera.up.copy(THREE.Object3D.DEFAULT_UP);
    if (this.walkThirdPerson) {
      this.walkTarget.copy(this.walker.position()).addScaledVector(THREE.Object3D.DEFAULT_UP, 1.1);
      thirdPersonFollowEye(
        this.walkTarget, this.walkForward,
        WALK_THIRD_PERSON_DISTANCE * this.thirdPersonZoom, WALK_THIRD_PERSON_HEIGHT * this.thirdPersonZoom,
        this.o.camera.position,
      );
      if (this.o.walkGround)
        keepThirdPersonCameraAboveGround(this.o.camera.position, this.walkEye.y, this.o.walkGround);
      this.o.camera.lookAt(this.walkTarget);
    } else {
      this.o.camera.position.copy(this.walkEye);
      this.o.camera.quaternion.copy(this.walkHeadQuaternion);
    }
  }

  private toggleThirdPerson() {
    if (!this.started || this.inVr) return;
    if (!this.onFootFlag) {
      this.rideFirstPerson = !this.rideFirstPerson;
      this.pose.setFirstPerson(this.rideFirstPerson);
      this.syncDesktopView();
      if (this.rideFirstPerson) this.updateRideFirstPersonCamera();
      else {
        const st = this.model.st, rs = this.model.renderState();
        this.cam.update(0, rs.pos, rs.vel, rs.rideFwd, st.grounded, this.model.boostActive());
      }
      return;
    }
    this.walkThirdPerson = !this.walkThirdPerson;
    this.pose.setFirstPerson(!this.walkThirdPerson);
    this.syncDesktopView();
    this.updateWalkCamera();
  }

  private syncDesktopView() {
    if (this.inVr) return;
    const firstPerson = this.onFootFlag ? !this.walkThirdPerson : this.rideFirstPerson;
    this.pointerLock?.setFirstPerson(firstPerson);
    this.pose.rider.group.visible = !firstPerson;
    this.hud.setFirstPerson(firstPerson);
    this.o.onControlContextChange?.();
  }

  /** The pose is solved before the camera phase each frame, so this is the actual animated eye bridge rather
   * than a guessed height above the board. Imported and procedural riders therefore share the same viewpoint. */
  private updateRideFirstPersonCamera() {
    const solved = this.pose.rider.solved;
    this.rideViewForward.copy(this.model.renderState().rideFwd);
    if (this.rideViewForward.lengthSq() < 1e-8) this.rideViewForward.copy(solved.headForward);
    else this.rideViewForward.normalize();
    // The third-person avatar may glance around on its own. That animation must never commandeer a first-person
    // player's view, so the hidden head supplies the eye HEIGHT while the ridden board supplies view direction.
    this.cam.updateFirstPerson(
      riderViewpoint(solved, this.rideEye, this.rideViewForward), this.rideViewForward, solved.headUp,
    );
  }

  /** WebXR's session-wide view owner calls this after its V/right-stick toggle and after every mount. */
  setFirstPerson(firstPerson: boolean) {
    if (!this.started) return;
    this.pose.setFirstPerson(firstPerson);
    this.pose.rider.group.visible = true;
  }

  /**
   * A frame of WebXR controller input (docs/048). Held controls go through the same source-aware aggregate every
   * other device uses, so a keyboard held at the desk cannot cancel the rider's thumb and vice versa; the ollie
   * keeps its own aggregation, so the charge survives a controller dropping out mid-hold.
   */
  setXrControls(controls: XrRideControls) {
    if (!this.started) return;
    const live = this.canControl;
    this.input.setHold('xr', 'tuck', live && controls.tuck);
    this.input.setHold('xr', 'brake', live && controls.brake);
    this.input.setHold('xr', 'boost', live && controls.boost);
    this.input.setOllie('xr', live && controls.ollie);
    // The analog carve rides the same shared axis the pad and touch stick drive. Ownership is claimed only while
    // the thumb is off centre, so a centred stick hands the axis back rather than pinning it at zero.
    if (controls.steer !== 0) {
      this.hud.stick.active = true;
      this.hud.stick.x = controls.steer;
      this.hud.stick.airX = controls.spin;
    } else if (this.hud.stick.id === undefined || this.hud.stick.id === -1) {
      this.hud.stick.active = false;
      this.hud.stick.airX = 0;
    }
  }

  /**
   * Where the rider's hands are, in world space, when a headset is tracking them (docs/048). The drawn body's
   * arms go there instead of to the stance's own rest points — you look down and see your hands where you are
   * holding them. Null hands hand the arms back to the stance.
   */
  setXrHands(left: RiderHandTarget | null, right: RiderHandTarget | null) {
    if (!this.started) return;
    this.pose.setHandTargets(left, right);
    // XR samples the wrists only after the rig has been seated on this frame's rendered board position. The
    // ordinary pose pass necessarily happened before that seat, so without this late presentation-only solve
    // the visible gloves consume last frame's world targets and trail a fast board by one display frame. A zero
    // dt keeps physics and every eased pose clock single-stepped while rebuilding the body on the fresh tracking.
    if (this.inVr) this.pose.update(this.model.st, 0, this.input.keys, this.model.renderState());
  }

  /** Six-degree-of-freedom headset pose for the local rider. Unlike gaze steering, this is a body landmark: it
   * drives the hidden skull and the visible torso below it, so leaning and crouching are reflected on the board. */
  setXrHead(position: THREE.Vector3 | null, quaternion: THREE.Quaternion | null) {
    if (this.started) this.pose.setHeadTarget(position, quaternion);
  }

  /** Put the rider back on the course where they are — the ride's own out-of-play recovery, on a button. */
  resetToCourse(from?: THREE.Vector3) { if (this.canControl) this.model.resetToCourse(from); }

  /** Mirror scorer-owned values into the existing presentation effect state and frozen run field. */
  private syncScoreState() {
    const score = this.scorer.snapshot();
    this.runScore = score.score;
    this.effects.scoreMultiplier = score.multiplier;
    this.effects.boostMeter = this.scorer.active ? score.boostMeter : null;
    if (score.resolution !== this.lastScoreResolution) {
      this.lastScoreResolution = score.resolution;
      this.lastTrickResolvedAt = this.runSeconds;
    }
  }

  /** Unity's itemized trick block: special grind/grab timers, otherwise the four-factor rotation equation. */
  private trickDisplay(score: RideScoreSnapshot): RideTrickDisplay | null {
    if (this.raceMode !== 'showoff' || this.runResult) return null;
    return rideTrickDisplay(score, this.runSeconds - this.lastTrickResolvedAt < TRICK_RESULT_HOLD_SECONDS);
  }

  /**
   * Start the session's one gate run. Desktop calls this as part of `start`; WebXR calls it on the first actual
   * mount, after the prewarmed board has spent an arbitrary amount of time parked beside the rider.
   */
  startRun() {
    if (!this.started) return;
    const mode = this.raceMode;
    const visible = raceModeIsTimed(mode) && (mode !== 'showoff' || (this.o.showoffSeconds ?? 0) > 0);
    this.runSeconds = 0;
    this.runScore = 0;
    this.checkpointBonusSeconds = 0;
    this.timeUp = false;
    this.runResult = null;
    this.runVisible = visible;
    this.runActive = visible;
    if (visible) this.scorer.start(); else this.scorer.abandon();
    this.lastScoreResolution = this.scorer.snapshot().resolution;
    this.lastTrickResolvedAt = -Infinity;
    this.effects.speedBoostSeconds = 0;
    this.effects.trickBoostSeconds = 0;
    this.effects.scoreMultiplier = 1;
    this.effects.boostMeter = visible ? this.scorer.boostMeter : null;
    this.model.laps?.reset();
    this.finishCrossing = createFinishCrossing(this.o.course, this.o.finish);
    this.finishCrossing?.step(this.model.st.pos);
    this.checkpointTracker = createCheckpointTracker(this.o.course, this.o.checkpoints);
    // Starting below a checkpoint must not retroactively collect it on the first simulation tick.
    this.checkpointTracker?.step(this.model.st.pos);
    this.hud.setLaps(this.model.laps);
    this.showRunClock();
  }

  /** A grounded exit abandons the result entirely, matching Unity's gate-run lifecycle. */
  abandonRun() {
    if (!this.started) return;
    this.scorer.abandon();
    this.runScore = 0;
    this.runActive = false;
    this.runVisible = false;
    this.runResult = null;
    this.timeUp = false;
    this.lastScoreResolution = 0;
    this.lastTrickResolvedAt = -Infinity;
    this.effects.scoreMultiplier = 1;
    this.effects.boostMeter = null;
    this.hud.setRunClock(null);
    this.hud.setLaps(null);
    this.hud.setCountdown(null);
  }

  /** Keep an airborne hop/carry on the same clock, then clear it the instant the rider lands without the board. */
  stepRunOffBoard(dt: number, grounded: boolean, grabHand: 'left' | 'right' | null = null) {
    if (!this.started || !this.runVisible) return;
    if (grounded) { this.abandonRun(); return; }
    if (dt > 0) {
      this.tickRunClock(dt);
      this.scorer.stepOffBoard(dt, grabHand);
      this.syncScoreState();
      this.showRunClock();
    }
  }

  get runStatus(): RideRunStatus | null {
    const mode = this.raceMode;
    if (!this.runVisible || !raceModeIsTimed(mode)) return null;
    const score = this.scorer.snapshot();
    return {
      mode,
      phase: this.runResult ?? 'running',
      clockSeconds: this.showRunClockSeconds(),
      elapsedSeconds: this.runSeconds,
      score: this.runResult ? this.runScore : score.score,
      boostMeter: score.boostMeter,
      trick: this.trickDisplay(score),
    };
  }

  /**
   * STAND THE BOARD DOWN without tearing it down — the WebXR dismount (docs/016).
   *
   * Building a ride is not cheap: the prop-collision BVH alone is tens to hundreds of milliseconds on a
   * prop-heavy mountain, and it is paid again by every AI rider the field re-mounts behind it. A headset
   * session mounts and dismounts constantly — pick the deck up, throw it, catch it mid-jump — so it keeps ONE
   * board for the whole session and parks it between rides instead. Everything stays built and in the scene;
   * only the looking and the listening stop.
   *
   * The host stops stepping a parked ride, which is what actually freezes the physics; this is the rest of it.
   */
  park() {
    if (!this.started) return;
    this.pose.setVisible(false);
    this.boardFx?.clear();
    this.boardAudio?.fadeSilent(1); // a whole second of fade in one call: silent now, and its state survives
    this.pausedFlag = false;
    this.input.releaseSource('xr');
    this.hud.setCountdown(null);
  }

  /**
   * Hand the board back to a rider, at a pose. The counterpart to `park`, and the reason a WebXR remount costs
   * a warp rather than a rebuild. An airborne mount follows this with `resumeAirborne` to put the arc back.
   */
  seatAt(spawn: THREE.Vector3, heading: THREE.Vector3) {
    if (!this.started) return;
    this.model.warpTo(spawn, heading, 0);
    this.model.seatAtMount(); // includes the solid prop top that was supporting this grounded remount
    this.pose.setVisible(true);
    this.boardFx?.clear();    // a fresh track must not stitch back to wherever the last ride ended
    const view = this.model.renderState();
    this.cam.setHeading(view.rideFwd);
    this.cam.resetAim(view.pos);
    this.pose.update(this.model.st, 0, this.input.keys, view); // drawn on the new pose, not the old one
  }

  /**
   * This mount happened IN THE AIR and the rider brought an arc with them — the WebXR deck catch (docs/016).
   * A fresh ride starts at a standstill, which would stop them dead in the sky; this resumes the flight they
   * are in the middle of so the jump can be landed. No-op for every ordinary mount, which never calls it.
   */
  resumeAirborne(velocity: THREE.Vector3) {
    if (!this.started) return;
    this.model.mountAirborne(velocity);
    const view = this.model.renderState();
    this.cam.setHeading(view.rideFwd);
    this.cam.resetAim(view.pos);
  }

  boostActive() { return this.started && !this.onFootFlag && this.model.boostActive(); }
  /** Off-board Superman thrust reuses only the boost roar; the parked deck's other beds remain silent. */
  setFlightBoostAudio(active: boolean, dt: number) { this.boardAudio?.updateFlightBoost(active, dt); }
  /** Effect graphs can kill a different (often invisible) support object after colliders were captured. */
  retireObstacle(key: string) { if (this.started) this.model.retireObstacle(key); }
  /** Pickup pop cycles re-enable the same cached collider when the visual has fully grown back. */
  restoreObstacle(key: string) { if (this.started) this.model.restoreObstacle(key); }
  get effectState(): Readonly<RideEffectState> { return this.effects; }
  get paused() { return this.started && this.pausedFlag; }
  get countingDown() {
    return this.started && !!this.o.countdown && this.countdownElapsed < this.o.countdown.holdSeconds;
  }
  private get canControl() { return this.started && !this.onFootFlag && !this.pausedFlag && !this.countingDown; }

  setPaused(paused: boolean) {
    if (!this.started || this.pausedFlag === paused) return;
    this.pausedFlag = paused;
    this.hud.setCountdown(paused ? 'PAUSED' : this.countdownCue());
  }

  orbitCamera(deltaX: number, deltaY: number) {
    if (!this.started) return;
    if (this.onFootFlag) {
      this.walkYaw = Math.atan2(
        Math.sin(this.walkYaw - deltaX * WALK_LOOK_PER_PIXEL),
        Math.cos(this.walkYaw - deltaX * WALK_LOOK_PER_PIXEL),
      );
      this.walkPitch = THREE.MathUtils.clamp(
        this.walkPitch - deltaY * WALK_LOOK_PER_PIXEL, -WALK_PITCH_LIMIT, WALK_PITCH_LIMIT,
      );
      this.updateWalkCamera();
    } else this.cam.orbit(deltaX, deltaY);
  }

  /** Scale the active mobile/desktop third-person boom along its current avatar-to-camera line. */
  zoomThirdPerson(factor: number): boolean {
    if (!this.started || this.inVr || this.firstPerson || !Number.isFinite(factor) || factor <= 0) return false;
    this.thirdPersonZoom = clampThirdPersonZoom(this.thirdPersonZoom * factor);
    this.cam.setThirdPersonZoom(this.thirdPersonZoom);
    if (this.onFootFlag) this.updateWalkCamera();
    else {
      const st = this.model.st, view = this.model.renderState();
      this.cam.update(0, view.pos, view.vel, view.rideFwd, st.grounded, this.model.boostActive());
    }
    return true;
  }

  zoomThirdPersonWheel(deltaY: number, deltaMode = 0): boolean {
    return this.zoomThirdPerson(thirdPersonWheelZoomFactor(deltaY, deltaMode));
  }

  /** Cursor/view location in normalized device coordinates. The camera ray is rebuilt every frame so a held
   * board follows camera motion even when the mouse itself has not emitted another screen-coordinate event. */
  setDesktopBoardAim(ndc: readonly [number, number] | null) {
    this.desktopBoardAimPresent = !!ndc;
    if (ndc) this.desktopBoardAimNdc.set(ndc[0], ndc[1]);
    if (this.started && this.onFootFlag) this.refreshDesktopBoardTarget();
  }

  /** LMB uses the highlighted deck; RMB takes hold of it. Returns true only when the press became an action,
   * allowing an unconsumed RMB to retain third-person camera look. */
  beginDesktopPointer(button: number): boolean {
    if (!this.started || this.inVr || !this.onFootFlag || this.pausedFlag
      || !this.refreshDesktopBoardTarget()) return false;
    if (button === 0) { this.mountBoard(true); return true; }
    if (button !== 2) return false;
    const coast = this.boardCoast;
    if (!coast) return false;
    this.updateDesktopCarryAim();
    // Solve the right arm first and use its reachable wrist as the attachment point. In desktop first person
    // the body remains hidden; WebXR keeps its separately embodied view.
    this.updateWalkAvatar(0, true);
    coast.stop();
    this.desktopBoardGrab.grab(
      'right', this.desktopHandPosition, this.desktopHandQuaternion,
      this.pose.board.position, this.pose.board.quaternion, this.pose.boardGrabBox,
      false, this.desktopBoardHitPoint,
    );
    this.desktopBoardActionable = false;
    this.pose.highlightBoard(false);
    return true;
  }

  /** Releasing RMB drops/throws a held deck. Returns whether this release belonged to a grab. */
  endDesktopPointer(button: number): boolean {
    if (button !== 2 || !this.desktopBoardGrab.held) return false;
    const coast = this.boardCoast;
    if (!coast) {
      this.desktopBoardGrab.clear();
      this.pose.rider.group.visible = this.walkThirdPerson;
      return true;
    }
    const thrown = this.desktopBoardGrab.release(this.desktopBoardThrow);
    this.desktopBoardUp.set(0, 1, 0).applyQuaternion(this.pose.board.quaternion).normalize();
    this.desktopBoardForward.set(0, 0, 1).applyQuaternion(this.pose.board.quaternion).normalize();
    coast.throwFrom(
      this.pose.board.position, thrown.velocity,
      this.desktopBoardForward, this.desktopBoardUp, thrown.spin,
    );
    this.pose.rider.group.visible = this.walkThirdPerson;
    this.refreshDesktopBoardTarget();
    return true;
  }

  /** Rebuild the interaction ray and light the loose equipment only while the pointer actually reaches it. */
  private refreshDesktopBoardTarget(): boolean {
    if (!this.started || this.inVr || !this.onFootFlag || this.pausedFlag) {
      if (this.started) this.pose.highlightBoard(false);
      this.desktopBoardActionable = false;
      return false;
    }
    // A captured cursor is the centre reticle. Once Esc releases it, the visible cursor's stored NDC is honest.
    const centred = this.pointerLock?.locked === true;
    if (!centred && !this.desktopBoardAimPresent) {
      this.pose.highlightBoard(false);
      this.desktopBoardActionable = false;
      return false;
    }
    if (centred) this.desktopBoardAimNdc.set(0, 0);
    this.desktopBoardRaycaster.setFromCamera(this.desktopBoardAimNdc, this.o.camera);
    if (this.desktopBoardGrab.held) {
      this.pose.highlightBoard(false);
      this.desktopBoardActionable = false;
      return false;
    }
    const rayDistance = deckRayDistance(
      this.pose.boardGrabBox, this.pose.board.position, this.pose.board.quaternion,
      this.desktopBoardRaycaster.ray,
    );
    if (rayDistance !== null) {
      // The aiming box has a little usability padding. Clamp its intersection back onto the actual deck so the
      // cursor chooses an honest tail-to-nose position for the shared edge carry.
      this.desktopBoardRaycaster.ray.at(rayDistance, this.desktopBoardHitPoint);
      nearestDeckPoint(
        this.pose.boardGrabBox, this.pose.board.position, this.pose.board.quaternion,
        this.desktopBoardHitPoint, this.desktopBoardHitPoint,
      );
    }
    // Third-person's camera trails behind the person. Range belongs to the person/eye, not to that camera boom,
    // while the ray hit still belongs to the exact visible cursor.
    nearestDeckPoint(
      this.pose.boardGrabBox, this.pose.board.position, this.pose.board.quaternion,
      this.walkEye, this.desktopBoardNearest,
    );
    this.desktopBoardHitDistance = this.walkEye.distanceTo(this.desktopBoardNearest);
    this.desktopBoardActionable = rayDistance !== null && this.desktopBoardHitDistance <= MOUNT_AIM_RANGE;
    this.pose.highlightBoard(this.desktopBoardActionable);
    return this.desktopBoardActionable;
  }

  /** Build the cursor-directed arm target and carry orientation. The body solver supplies the reachable wrist
   * position separately; its +Y finger axis follows the view direction and its +Z axis follows camera up, so
   * looking around carries and turns the deck without arbitrary roll flips. */
  private updateDesktopCarryAim() {
    const ray = this.desktopBoardRaycaster.ray;
    this.desktopHandY.copy(ray.direction).normalize();
    this.desktopCameraUp.set(0, 1, 0).applyQuaternion(this.o.camera.quaternion).normalize();
    this.desktopHandZ.copy(this.desktopCameraUp)
      .addScaledVector(this.desktopHandY, -this.desktopCameraUp.dot(this.desktopHandY));
    if (this.desktopHandZ.lengthSq() < 1e-6) {
      this.desktopHandZ.set(0, 0, 1)
        .addScaledVector(this.desktopHandY, -this.desktopHandY.z);
      if (this.desktopHandZ.lengthSq() < 1e-6) this.desktopHandZ.set(1, 0, 0);
    }
    this.desktopHandZ.normalize();
    this.desktopHandX.crossVectors(this.desktopHandY, this.desktopHandZ).normalize();
    this.desktopHandZ.crossVectors(this.desktopHandX, this.desktopHandY).normalize();
    this.desktopHandQuaternion.setFromRotationMatrix(
      this.desktopHandBasis.makeBasis(this.desktopHandX, this.desktopHandY, this.desktopHandZ),
    );
    this.desktopHandAimTarget.copy(this.walkEye)
      .addScaledVector(this.desktopHandY, DESKTOP_BOARD_AIM_DISTANCE);
  }

  setRiderModel(modelId: string) {
    if (!this.started) return;
    this.pose.setRiderModel(modelId);
    const st = this.model.st;
    this.pose.update(st, 0, this.input.keys, this.model.renderState());
    this.syncDesktopView();
  }

  /** The stance swap needs no re-pose: the running frame loop crosses the body to the new style on its own. */
  setRiderStyle(styleId: string) {
    if (!this.started) return;
    this.pose.setRiderStyle(styleId);
  }

  /** Test-panel live toggle. Disabled means no retained ribbon, particles, geometry, or draw calls. */
  setBoardFxEnabled(on: boolean) {
    if (!this.started) return;
    if (on && !this.boardFx) this.boardFx = new BoardFx(this.o.scene, this.o.boardFxGround);
    else if (!on && this.boardFx) { this.boardFx.dispose(); this.boardFx = null; }
  }

  /** Swap the kit under a live ride. The physics keeps its position, speed and edge; the deck and the body are
   *  both rebuilt and re-posed on the spot, so the swap is visible in the frame it is asked for. */
  setGear(gear: RideGear) {
    if (!this.started) return;
    const loosePosition = this.onFootFlag ? this.pose.board.position.clone() : null;
    const looseRotation = this.onFootFlag ? this.pose.board.quaternion.clone() : null;
    this.pose.setGear(gear);
    this.model.st.riderSeated = false;   // the new body settles onto the deck rather than inheriting a stance
    const st = this.model.st;
    this.pose.update(st, 0, this.input.keys, this.model.renderState());
    if (this.onFootFlag) {
      this.walkPoseSeated = false;
      if (this.desktopBoardGrab.held && loosePosition && looseRotation) {
        this.pose.board.position.copy(loosePosition);
        this.pose.board.quaternion.copy(looseRotation);
      } else if (this.boardCoast?.launched) {
        this.pose.seatBoard(this.boardCoast.pos, this.boardCoast.up, this.boardCoast.fwd);
      }
      this.refreshDesktopBoardTarget();
    }
    this.syncDesktopView();
  }

  /** Mirror the snowboard body and bindings live; skis retain the choice for the next gear swap. */
  setSnowboardStance(stance: SnowboardStance) {
    if (!this.started) return;
    const loosePosition = this.onFootFlag ? this.pose.board.position.clone() : null;
    const looseRotation = this.onFootFlag ? this.pose.board.quaternion.clone() : null;
    this.pose.setSnowboardStance(stance);
    this.model.st.riderSeated = false;
    const st = this.model.st;
    this.pose.update(st, 0, this.input.keys, this.model.renderState());
    if (this.onFootFlag) {
      this.walkPoseSeated = false;
      if (this.desktopBoardGrab.held && loosePosition && looseRotation) {
        this.pose.board.position.copy(loosePosition);
        this.pose.board.quaternion.copy(looseRotation);
      } else if (this.boardCoast?.launched) {
        this.pose.seatBoard(this.boardCoast.pos, this.boardCoast.up, this.boardCoast.fwd);
      }
      this.refreshDesktopBoardTarget();
    }
    this.syncDesktopView();
  }

  /** Re-skin the local board in place after an account-settings save. */
  setEquipmentAppearance(appearance?: EquipmentAppearance) {
    this.o.equipmentAppearance = appearance;
    if (this.started) this.pose.setEquipmentAppearance(appearance);
  }
}

const playerVec = (v: THREE.Vector3): PlayerVec3 => [v.x, v.y, v.z];
const playerQuat = (q: THREE.Quaternion): PlayerQuat => [q.x, q.y, q.z, q.w];
const playerTransform = (p: THREE.Vector3, q: THREE.Quaternion): PlayerTransform =>
  ({ p: playerVec(p), q: playerQuat(q) });
