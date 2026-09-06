import * as THREE from 'three';
import type { BoardSoundMix, RaceMusicArrangement, Rail, V3 } from '../../../core/doc/types';
import {
  editorFromRaw, referenceSplineIsGrindRail, type ReferenceMesh, type RefAiPath, type RefSplineRaw,
} from '../../../core/reference/terrain';
import { isMotionPath, railBezierSegments, railHasTube, railStartsOff, railStyle } from '../../../core/rails/rails';
import { RAIL_TUBE_RADIUS } from '../../../core/rails/rail-mesh';
import { createAiRiders, type AiPathDef, type AiRiders } from '../../ride/ai';
import { DEFAULT_LINE_RATING } from '../../../core/doc/course';
import { createGrindRails, type GrindRails } from '../../ride/grind';
import { buildBoostVolumes, type BoostVolume, type BoostVolumeSpec } from '../../ride/boost-volumes';
import {
  buildCrackedSurfaces, createCrackedSurfaceRuntime,
  type CrackedSurface, type CrackedSurfaceRuntime, type CrackedSurfaceSpec,
} from '../../ride/cracked-surfaces';
import { authoredPatchContact, referencePatchContact } from '../../ride/patch-contact';
import { RIDER_HEAD_Y } from '../../ride/physics-tuning';
import type { RideObstacleHit, RideObstacleObject, RideObstacleSource, RideState } from '../../ride/physics';
import { createRideColliderOverlay } from './ride-collider-overlay';
import type { RideEffectAction } from '../../ride/effect-actions';
import type { RaceMode } from '../../../core/doc/race';
import type { RideShovedBodySample } from '../../ride/telemetry';
import { TestRide, type RideCountdown } from '../../ride/session';
import type { RideCheckpoint } from '../../ride/checkpoints';
import { createXrPlay, type XrPlay } from '../../ride/xr/session';
import { DEFAULT_XR_RENDER_SCALE, type XrEyeBufferMeasurement, type XrLayerMode } from '../../ride/xr/config';
import { downwardGroundQuery, type WalkGround } from '../../ride/xr/walk';
import type { PreviewData } from '../../../core/mesh/tessellation';
import { pickTree, type TreeGeometry } from '../mesh/surface-trees';
import type { Stage } from '../stage';
import {
  DEFAULT_RIDE_GEAR, DEFAULT_SNOWBOARD_STANCE, type EquipmentAppearance, type RideGear,
  type SnowboardStance,
} from '../../ride/gear';
import { DEFAULT_RIDER_MODEL_ID } from '../../ride/rider-models';
import { DEFAULT_RIDING_STYLE } from '../../ride/stances';
import type { RideFrameTimingSample } from '../../ride/perf';
import type { LocalPlayerPose } from '../../../core/session/player-pose';
import { createWalkObstacleWorld, type WalkObstacleWorld } from '../../ride/walk-collision';
import { RideMusicRuntime } from '../../audio/ride-music';
import type { AuthoredEnvironmentBed } from '../../../core/audio/environment';

/** The shell-held state the ride layer reads at play time (terrain / reference / preview live in the shell
 *  until those clusters are their own controllers; the ride layer pulls the current values through getters). */
export interface RideDeps {
  /** The authored ground mesh (the ride target + spawn-pick surface for 'authored'). */
  getTerrain(): THREE.Mesh;
  /** The loaded reference mesh, or null when none is loaded. */
  getReference(): THREE.Mesh | null;
  /** The reference's decoded surface record (per-patch surface types), or null. */
  getRefData(): ReferenceMesh | null;
  /** The loaded reference level name (ride HUD label). */
  getRefLevel(): string;
  /** The authored mountain name (ride HUD label). */
  getMountainName(): string;
  /** The authored terrain's preview data (per-cell surface types) for the ride's surface lookup. */
  getPreview(): PreviewData | null;
  /** The doc's authored grind rails, ridable during an authored-mountain playtest ([Trailmap: 350]). */
  getRails(): Rail[];
  /** The loaded reference level's native spline table; this ride layer selects its grind styles. */
  getRefSplines(): RefSplineRaw[] | null;
  /** The loaded reference level's recovered main SOP/AIP course line (native editor frame), or null. */
  getRefCourse(): V3[] | null;
  /** Authored knot stations carrying a positive showoff bonus, in data space. */
  getCourseCheckpoints(): ReadonlyArray<{ pos: V3; bonusSeconds: number }>;
  /** Recovered SOP type-11 stations, including route-equivalent group ids, in reference data space. */
  getRefCheckpoints(): ReadonlyArray<{ pos: V3; bonusSeconds: number; group: number; dtf: number }>;
  /** Where that level's own `Mdl_StageArea_Start_0` stages its riders (native editor frame), or null when it
   *  carries no marker. This is the start; no end of the recovered line is. */
  getRefStart(): V3 | null;
  /** And its finish CROSSING with the racing direction through it (native editor frame) — the DTF-zero point,
   *  which on a lap course is nowhere near either end of the recovered line either. Null without one. */
  getRefFinish(): { pos: V3; fwd: V3 } | null;
  /** The authored mountain's derived AI lines (data space — core/doc/course aiPathLines over the doc's seed). */
  getAiLines(): V3[][];
  /** Their line ratings, in the same order — the same ones the AIP export ships ([Trailmap: 395]). */
  getAiRatings(): number[];
  /** The authored mountain's course spine (data space): the field's progress ruler, and the exported race line. */
  getCourseLine(): V3[];
  /** Its finish crossing + heading (data space) — the placed anchor, or the run's tail when none was dropped. */
  getCourseFinish(): { pos: V3; fwd: V3 } | null;
  /** The loaded reference level's AI-path network (native editor frame, off its AIP.json), or null. */
  getRefAiPaths(): RefAiPath[] | null;
  /** The authored mountain's board-sound mix — the bed a test ride performs on either target (docs/034). */
  getBoardSound(): BoardSoundMix;
  /** Authored race master. Reference Test ignores it and follows the loaded level's own PathFinder playlist. */
  getRaceMusic(): string | null;
  getRaceMusicArrangement(): RaceMusicArrangement;
  /** Authored off-board silence filler; reference Test reads the loaded map's Audio/Environment.json. */
  getEnvironmentBed(): AuthoredEnvironmentBed | null;
  /** Passes each Play target is raced over (core/doc/race): the document's own count, and the loaded
   *  reference level's. What the ride counts down, and what gates its lap-gated boost volumes. */
  getLaps(): number;
  getRefLaps(): number;
  /** Which event the next ride is (core/doc/race) — a Play setting rather than a property of either mountain,
   *  since the same mountain hosts both. It is what decides the run clock's direction. */
  getRaceMode(): RaceMode;
  /** Rail ids/native indices whose MainType-25 candidacy the selected mode function clears. */
  getModeDisabledRails?(target: 'authored' | 'reference', mode: RaceMode): ReadonlySet<number | string>;
  /** Seconds a showoff run on each target starts with: the document's own, and the loaded reference level's
   *  (its slot's, from retail's table). Unused by a race, which counts up from zero. */
  getShowoffSeconds(): number;
  getRefShowoffSeconds(): number;
  /** Prop collision geometry for the two Play targets, captured only when a ride actually launches. */
  getAuthoredPropColliders(): RideObstacleSource[];
  getReferencePropColliders(): RideObstacleSource[];
  /** Exact collision hand-off to the effects/audio runtime. `subject` is the rider that made the contact:
   *  null for the player's board, an AI slot index otherwise — so a boost pad boosts whoever rode over it. */
  onPropCollision?(hit: RideObstacleHit, subject: number | null): void;
  /** MainType-0 boost-family volumes for this launch, already in editor world space ([Trailmap: 360-node]). */
  getBoostVolumeSpecs?(): ReadonlyMap<string, BoostVolumeSpec>;
  /** Object keys of the MainType-13 RESET volumes — the boundary the level's author drew around its run. */
  getResetVolumeKeys?(): ReadonlySet<string>;
  /** Cracked surfaces for this launch: the hosts that wear down under a rider and then give way
   *  ([Trailmap: 370-world-interaction]). The drain is per-tick, so it cannot ride the collision dispatch. */
  getCrackedSurfaceSpecs?(): ReadonlyMap<string, CrackedSurfaceSpec>;
  /** First crack / finite-lifetime heal selects the model's per-instance intact or cracked material frame. */
  onCrackedChange?(key: string, cracked: boolean, subject?: number | null): void;
  /** A cracked surface has given way: run its trigger column and hide it, which is what drops the rider. */
  onCrackedBreak?(key: string, subject?: number | null): void;
  /** Flight samples of props the shove has set moving, polled per render frame for the telemetry capture. */
  shovedBodySamples?(): RideShovedBodySample[];
}

/**
 * Test ride (docs/016): an in-editor playtest, plus Play SETUP (choose a target + place an editable start
 * marker). Setup leaves both mountains' editor visibility untouched. While a ride runs it owns the camera +
 * input and temporarily hides only the non-target mountain; stop restores that mountain along with the saved
 * editor camera, controls and gizmo.
 *
 * The same field can also run WITHOUT a board — the spectate mode below, where the AI riders race the mountain
 * and the editor keeps its own camera so you can orbit around them while they run. And it can run without a
 * *race*: in Play setup a click on the slope drops a single AI rider there and it sets off (`dropAiRider`), which
 * is how you look at one stretch of terrain, or one AI line, without riding the whole mountain to reach it.
 */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

export function createRideLayer(stage: Stage, deps: RideDeps) {
  const music = new RideMusicRuntime();
  let musicEnabled = true;
  let ride: TestRide | null = null;
  /**
   * The WebXR session's board, which OUTLIVES its mounts. A headset session mounts and dismounts constantly —
   * pick the deck up, throw it, catch it mid-jump — and building a ride costs tens to hundreds of milliseconds
   * (the prop-collision BVH, plus every AI rider the field would re-mount behind it). So session entry builds and
   * parks one, and every mount re-seats that same board. `ride` above still flips per mount: it is what the frame
   * loop steps and what everything else reads as "there is a rider out there".
   */
  let vrRide: TestRide | null = null;
  /** The player's board wherever it currently is — being ridden, or standing down between WebXR mounts. What
   *  CONFIGURES a board (its character, stance, gear, FX, and the colliders it knows about) goes here, so a
   *  parked board is not left holding the settings of the ride before last. What ACTS on a rider stays on
   *  `ride`, because a parked board has no rider to act on. */
  const board = () => ride ?? vrRide;
  let aiField: AiRiders | null = null; // ghost opponents on the AI paths, riding alongside when the count is positive
  /** A prewarmed XR field is built but held at its gate until the player actually mounts for the first time. */
  let vrFieldStarted = false;
  let aiMax = 0; // zero = off; the host restores Test's persisted AI rider count immediately after construction
  let riderModel = DEFAULT_RIDER_MODEL_ID; // built-in/library character id used by newly mounted player/AI riders
  let riderStyle: string = DEFAULT_RIDING_STYLE; // riding style used by newly mounted player/AI riders
  let rideGear: RideGear = DEFAULT_RIDE_GEAR;    // snowboard or skis, for the player and the whole AI field
  let snowboardStance: SnowboardStance = DEFAULT_SNOWBOARD_STANCE; // snowboard foot order, retained on skis
  let equipmentAppearance: EquipmentAppearance | undefined; // signed-in local rider only; AI keeps stock gear
  // Local-player wake/spray only. AI riders are built by mountAiField and never receive a BoardFx instance.
  let boardFxEnabled = true;
  let watching = false; // ...or racing alone, with no board and the editor's own camera (spectate)
  let rideRestore: {
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    pos: THREE.Vector3; quat: THREE.Quaternion; target: THREE.Vector3;
    perspFov: number; perspNear: number;
    controls: boolean; gizmoOn: boolean; gizmoVis: boolean;
  } | null = null;
  // Test mode: which mountain is being set up + the world-space start marker. Mountain visibility is not part
  // of setup: the non-target mountain is hidden only for the lifetime of an actual ride.
  let playTarget: 'authored' | 'reference' = 'authored';
  let playMarker: THREE.Group | null = null;
  let playMarkerScale = 4; // sized to the target mountain so the flag reads at the editor's framing
  let rideVis: { o: THREE.Object3D; v: boolean }[] | null = null;
  let aiFrameMs = 0;
  /** The live headset session (docs/048), or null. It outlives any one board: the rider mounts and dismounts
   *  inside it, and only ending the session gives the editor its view and its other mountain back. */
  let xr: XrPlay | null = null;
  /** One local-player glass pool for the whole headset session. The board comes and goes; broken panes do not. */
  let xrCrackedSurfaces: CrackedSurfaceRuntime | null = null;
  const xrBrokenSurfaces = new Set<string>();
  /** The on-foot view of the selected target's prop snapshot. Built lazily on first walk query so an ordinary
   * board-only run pays nothing for it, and retained across VR mount/dismount transitions. */
  let walkObstacles: WalkObstacleWorld | null = null;
  let walkObstacleReference: boolean | null = null;
  /** Test mode's collider overlay (docs/016). Parented at the scene root because ride collision is solved in
   *  world space, which is the frame the obstacle sources are already in. */
  const colliderOverlay = createRideColliderOverlay(stage.scene);
  const castRay = new THREE.Ray(), castFrom = new THREE.Vector3(), castTo = new THREE.Vector3();
  const castInverse = new THREE.Matrix4(), castNormals = new THREE.Matrix3();

  function ensureWalkObstacles(t: RideTarget): WalkObstacleWorld {
    if (walkObstacles && walkObstacleReference === t.reference) return walkObstacles;
    walkObstacles?.dispose();
    walkObstacleReference = t.reference;
    walkObstacles = createWalkObstacleWorld(t.obstacles, hit => deps.onPropCollision?.(hit, null));
    return walkObstacles;
  }

  function disposeWalkObstacles() {
    walkObstacles?.dispose();
    walkObstacles = null;
    walkObstacleReference = null;
  }

  /** Step the running test ride + its AI field — or a field on its own, whether it is being spectated or was
   *  simply dropped onto the slope click by click. The shell's render loop calls this every frame; with neither a
   *  ride nor a field out there it does nothing. */
  function step(dt: number) {
    // WebXR opens its collision frame before this call because on-foot simulation lives in beginXrFrame.
    // Desktop walking lives below, so it opens the frame here instead. Do not reset XR's counters between its
    // expensive begin phase and the profiler sample after rendering.
    if (!xr?.presenting) walkObstacles?.beginFrame();
    aiFrameMs = 0;
    // A recovered race countdown holds the entire gate, not just the human board. The frame that releases the
    // player leaves the AI seated until the next frame, avoiding a full-dt head start when the timer is crossed.
    if (ride?.countingDown) {
      ride.step(dt);
      colliderOverlay.update(ride.state);
      stepMusic(dt);
      return;
    }
    ride?.step(dt);
    colliderOverlay.update(ride?.state ?? null);
    if (!ride?.paused && aiField && (!xr || vrFieldStarted)) {
      const started = performance.now();
      aiField.step(dt);
      aiFrameMs = performance.now() - started;
    }
    stepMusic(dt);
  }

  /** Unity keeps intro music alive for the whole local session, then RaceMusicDirector crossfades on the
   * board's actual seat state. Desktop E and WebXR both surface here as the same mounted boolean. */
  function stepMusic(dt: number) {
    const state = ride?.state;
    music.step(dt, {
      active: musicEnabled && (!!ride || !!xr?.presenting),
      target: playTarget,
      referenceLevel: deps.getRefLevel(),
      authoredTrack: deps.getRaceMusic(),
      authoredArrangement: deps.getRaceMusicArrangement(),
      authoredEnvironment: deps.getEnvironmentBed(),
      mounted: !!ride && !ride.onFoot,
      speed: state?.vel.length() ?? 0,
      grounded: state?.grounded ?? true,
      airTime: state?.airTime ?? 0,
      boosting: ride?.boostActive() ?? false,
    });
  }

  /** Complete timings arrive after render; AI is timed here because it is nested inside the broad ride phase.
   *  The headset takes the same sample: its wrist profiler has to keep running between boards (docs/048). */
  function recordFramePerf(sample: Omit<RideFrameTimingSample,
    'aiMs' | 'walkCollisionMs' | 'walkGroundCasts' | 'walkSweeps' | 'walkTriangleTests' | 'walkLiveRefits'>) {
    const walk = walkObstacles?.perf;
    const full = {
      ...sample,
      aiMs: aiFrameMs,
      walkCollisionMs: walk?.ms ?? 0,
      walkGroundCasts: walk?.groundCasts ?? 0,
      walkSweeps: walk?.sweeps ?? 0,
      walkTriangleTests: walk?.triangleTests ?? 0,
      walkLiveRefits: walk?.liveRefits ?? 0,
    };
    ride?.recordFramePerf(full);
    xr?.recordFramePerf(full, performance.now());
  }

  /** The headset's read of the frame, before the world steps on it (docs/048). No-op without a session. */
  function beginXrFrame(frame: XRFrame | null | undefined, dt: number) {
    walkObstacles?.beginFrame();
    xr?.beginFrame(frame, dt);
  }
  /** ...and the rig's seat, after it. */
  function endXrFrame() { xr?.endFrame(); }

  /**
   * The authored mountain's AI field in world space (the world root's chirality flip applied) — the same lines
   * the AIP.json export ships and the Info overlay draws, with the same line ratings ([Trailmap: 395]).
   *
   * Every one of them is a gate line running the whole course, so nobody ever hands off; what the ratings buy is
   * the *re-choice* — a leading rider drifts onto the straight line (the safe fast one) and a trailing one onto
   * the wide-swinging line (the risky one), which is what stops six riders sharing one groove. The course spine
   * rides along as the progress ruler the standings sort on.
   */
  function authoredAiWorldPaths(): { paths: AiPathDef[]; starts: number[]; course: THREE.Vector3[] } {
    stage.worldRoot.updateWorldMatrix(true, false);
    const m = stage.worldRoot.matrixWorld;
    const ratings = deps.getAiRatings();
    // No jump markers: the authored mountain has no equivalent of the AIP's type-100 events yet, so its field
    // never ollies ([Trailmap: 395]). Every derived line IS the course, so all of them are respawnable.
    const paths = deps.getAiLines().map((line, i) => ({
      rating: ratings[i] ?? DEFAULT_LINE_RATING,
      respawnable: true,
      points: line.map(p => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m)),
    }));
    const course = deps.getCourseLine().map(p => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m));
    return { paths, starts: paths.map((_p, i) => i), course };
  }

  /** The loaded reference's AI network in world space, through the reference mesh's own world matrix like every
   *  other reference dataset, with its `StartPosList` gate paths naming the riders the engine seeds. A level
   *  that flags no start paths fields the first six of its network instead. */
  function referenceAiWorldPaths(): { paths: AiPathDef[]; starts: number[]; course: THREE.Vector3[] } {
    const raw = deps.getRefAiPaths();
    const reference = deps.getReference();
    if (!raw?.length || !reference) return { paths: [], starts: [], course: [] };
    reference.updateWorldMatrix(true, false);
    const m = reference.matrixWorld;
    // The WHOLE network, not just the gate lines: a level's AI paths are short overlapping segments and the
    // riders chain through them ([Trailmap: 395]). Handing over only the six `StartPosList` stubs (GARI's are
    // ~350 m) leaves every rider running off the end of its gate a few seconds in.
    // The whole record, not just the points: its rating decides who rides it, its `respawnable` flag decides
    // whether a fallen rider may be put back on it, and its markers are the only reason an AI rider ever jumps
    // ([Trailmap: 395]). The level authored all three; we were throwing two of them away.
    const paths = raw.map(p => ({
      rating: p.rating,
      respawnable: p.respawnable,
      markers: p.markers,
      points: p.points.map(q => new THREE.Vector3(q[0], q[1], q[2]).applyMatrix4(m)),
    }));
    const gates = raw.map((p, i) => (p.start ? i : -1)).filter(i => i >= 0).slice(0, 6);
    // Its recovered main course line is the progress ruler the standings sort on ([Trailmap: 140]).
    const course = (deps.getRefCourse() ?? []).map(p => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m));
    return { paths, starts: gates.length ? gates : paths.slice(0, 6).map((_p, i) => i), course };
  }

  /**
   * The two mountains' FINISH CROSSINGS in world space — where a lap is counted ([Trailmap: 390-lap-counter]).
   * Each is the anchor its own model carries, never an end of a course line: MEGAPLEX's recovered line stops
   * 320 m above its finish, so a countdown taken off that tail counts a plane the finish tube throws the rider
   * permanently past. Null leaves the countdown on the line's tail, which is right for a run that ends where it
   * finishes and is all a mountain with no anchor can offer.
   */
  function referenceFinishLine(): { pos: THREE.Vector3; fwd: THREE.Vector3 } | null {
    const anchor = deps.getRefFinish();
    const reference = deps.getReference();
    if (!anchor || !reference) return null;
    reference.updateWorldMatrix(true, false);
    const m = reference.matrixWorld;
    return {
      pos: new THREE.Vector3(anchor.pos[0], anchor.pos[1], anchor.pos[2]).applyMatrix4(m),
      // A direction, so the placement offset must not travel with it — only the frame's basis.
      fwd: new THREE.Vector3(anchor.fwd[0], anchor.fwd[1], anchor.fwd[2]).transformDirection(m),
    };
  }

  function authoredFinishLine(): { pos: THREE.Vector3; fwd: THREE.Vector3 } | null {
    const frame = deps.getCourseFinish();
    if (!frame) return null;
    stage.worldRoot.updateWorldMatrix(true, false);
    const m = stage.worldRoot.matrixWorld;
    return {
      pos: new THREE.Vector3(frame.pos[0], frame.pos[1], frame.pos[2]).applyMatrix4(m),
      fwd: new THREE.Vector3(frame.fwd[0], frame.fwd[1], frame.fwd[2]).transformDirection(m),
    };
  }

  function rideCheckpoints(reference: boolean): RideCheckpoint[] {
    const root = reference ? deps.getReference() : stage.worldRoot;
    if (!root) return [];
    root.updateWorldMatrix(true, false);
    if (reference) return deps.getRefCheckpoints().map(checkpoint => ({
      pos: new THREE.Vector3(checkpoint.pos[0], checkpoint.pos[1], checkpoint.pos[2]).applyMatrix4(root.matrixWorld),
      bonusSeconds: checkpoint.bonusSeconds, group: checkpoint.group, dtf: checkpoint.dtf,
    }));
    return deps.getCourseCheckpoints().map(checkpoint => ({
      pos: new THREE.Vector3(checkpoint.pos[0], checkpoint.pos[1], checkpoint.pos[2]).applyMatrix4(root.matrixWorld),
      bonusSeconds: checkpoint.bonusSeconds,
    }));
  }

  /**
   * The authored course's grind rails as the ride's rail network ([Trailmap: 350]): each doc rail's
   * Catmull-Rom nodes become the SAME cubic-Bézier chain the export writes to `Splines.json` (core/rails),
   * pushed through the world root's chirality flip so the physics grinds exactly the curve the visible tube
   * is swept along. Null when the course has no rails.
   *
   * A `startsOff` rail is left out for the same reason it exports at a non-grind style: it is not in the rail
   * query until an effect switches it in, and no preview here runs a MainType-25 toggle. So the test ride
   * refuses it exactly as the console would on the same run — untick "starts off" to grind it while authoring.
   */
  function authoredGrindRails(): GrindRails | null {
    stage.worldRoot.updateWorldMatrix(true, false);
    const m = stage.worldRoot.matrixWorld;
    const disabled = deps.getModeDisabledRails?.('authored', deps.getRaceMode()) ?? new Set();
    const railsIn = deps.getRails()
      .filter(r => !isMotionPath(r) && !railStartsOff(r) && (!r.id || !disabled.has(r.id)))
      .map(r => ({
        surf: railStyle(r),
        // Only Slopesmith's generated pipe is centred on its spline. Bare curves are laid directly on the
        // intended contact line, just like extracted retail splines.
        seat: railHasTube(r) ? RAIL_TUBE_RADIUS : 0,
        segments: railBezierSegments(r.nodes).map(seg =>
          seg.map(p => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(m)) as
            [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]),
      }))
      .filter(r => r.segments.length > 0);
    return railsIn.length ? createGrindRails(railsIn) : null;
  }

  /**
   * The loaded reference level's ORIGINAL grind rails ([Trailmap: 350]): its `Splines.json` cubics (served
   * raw with the level payload), mapped through the same raw→editor transform every reference dataset uses
   * and then through the reference mesh's own world matrix — preserving the retail curve's authored clearance
   * over the rail props. The spline's style rides along as the grind surface (normally 13 metal / 12 wood, plus
   * named exceptions such as Alaska's style-5 IceRails). Null when the level ships no Splines.json.
   */
  function referenceGrindRails(): GrindRails | null {
    const raw = deps.getRefSplines();
    const reference = deps.getReference();
    if (!raw?.length || !reference) return null;
    reference.updateWorldMatrix(true, false);
    const m = reference.matrixWorld;
    const disabled = deps.getModeDisabledRails?.('reference', deps.getRaceMode()) ?? new Set();
    const railsIn = raw
      .filter(s => referenceSplineIsGrindRail(s) && !disabled.has(s.originalIndex))
      .map(s => ({
        surf: s.style,
        // Retail authored the rider clearance into the spline itself; the engine adds no fixed rail height.
        seat: 0,
        segments: s.segments
          .filter(seg => seg.length === 4)
          .map(seg => seg.map(p => {
            const e = editorFromRaw(p);
            return new THREE.Vector3(e[0], e[1], e[2]).applyMatrix4(m);
          }) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]),
      }))
      .filter(r => r.segments.length > 0);
    return railsIn.length ? createGrindRails(railsIn) : null;
  }

  /** True when the loaded reference world can be ridden (its terrain + surface data are present). */
  function canRide() { return !!(deps.getReference() && deps.getRefData()); }

  /**
   * A default world-space start point for the reference: a slot on the START ROW, the head of one of the six
   * `StartPosList` paths. Those sit 2.6-4.4 m off the gate prop at the retail ~1.4 m pitch on every shipped
   * level — the row riders line up in — so dropping in on one puts you on the grid facing down the course.
   *
   * `Mdl_StageArea_Start_0` is the level's staging ANCHOR and is drawn as such, but it is 17-19 m behind that
   * row, which on Tokyo Megaplex is inside the start structure. It stands in only for a level with no start
   * list. Below that: a few metres down the recovered course, then the terrain-centre probe.
   */
  function referenceSpawn(): { pos: V3; heading: V3 | null } | null {
    const reference = deps.getReference();
    if (!reference) return null;
    reference.updateWorldMatrix(true, false);
    const toWorld = (p: V3): V3 => {
      const w = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(reference.matrixWorld);
      return [w.x, w.y, w.z];
    };
    /**
     * Down-course at a slot: where its path has got to after a real distance, in world space. Courses do not
     * agree on a compass direction — Tokyo Megaplex leaves its gate the opposite way from Garibaldi — so a
     * rider handed no heading faces the board's default and is backwards on half the mountain.
     *
     * Over a BASELINE rather than the first step, because a start path's first delta is a metre or two of
     * staging jog: Elysium's climbs steeply enough to read as "up the hill" on its own.
     */
    const HEADING_BASELINE = 15;   // m of path to average the facing over
    const pathHeading = (points: V3[]): V3 | null => {
      const a = toWorld(points[0]);
      let far = a, run = 0;
      for (let i = 1; i < points.length && run < HEADING_BASELINE; i++) {
        const b = toWorld(points[i]);
        run += Math.hypot(b[0] - far[0], b[1] - far[1], b[2] - far[2]);
        far = b;
      }
      const d: V3 = [far[0] - a[0], far[1] - a[1], far[2] - a[2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      return len > 1e-3 ? [d[0] / len, d[1] / len, d[2] / len] : null;
    };
    // The middle slot, so a drop-in is centred on the gate rather than on an outside lane. Deterministic:
    // retail deals the player a slot at random, but a test ride wants to land in the same place twice.
    const slots = (deps.getRefAiPaths() ?? []).filter(p => p.start && p.points.length >= 2);
    if (slots.length) {
      const slot = slots[Math.floor(slots.length / 2)];
      return { pos: toWorld(slot.points[0]), heading: pathHeading(slot.points) };
    }
    const marker = deps.getRefStart();
    if (marker) return { pos: toWorld(marker), heading: null };
    const course = deps.getRefCourse();
    if (course && course.length >= 2) {
      let total = 0;
      for (let i = 1; i < course.length; i++) {
        const a = course[i - 1], b = course[i];
        total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      }
      let along = Math.min(4, total * 0.03); // same intent as the authored start: just clear of the gate
      for (let i = 1; i < course.length; i++) {
        const a = course[i - 1], b = course[i];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (len <= 1e-6) continue;
        if (along <= len) {
          const t = along / len;
          const world = new THREE.Vector3(
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
          ).applyMatrix4(reference.matrixWorld);
          return { pos: [world.x, world.y, world.z], heading: pathHeading([a, b]) }; // face on down the line
        }
        along -= len;
      }
    }
    const box = new THREE.Box3().setFromObject(reference);
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    // This is an internal vertical probe, not a pointer cast. A dedicated raycaster is important: mutating
    // Stage's shared picker (especially its `far`) made subsequent camera clicks beyond that range miss, so
    // Play's click-to-place start appeared broken after the reference default had been calculated.
    const ray = new THREE.Raycaster(
      new THREE.Vector3(cx, box.max.y + 10, cz), new THREE.Vector3(0, -1, 0),
      0, (box.max.y - box.min.y) + 100,
    );
    const hit = ray.intersectObject(reference, false)[0];
    return {
      pos: hit ? [hit.point.x, hit.point.y, hit.point.z] : [cx, (box.min.y + box.max.y) / 2, cz],
      heading: null,
    };
  }

  /** Enter / leave Play SETUP: select the marker's target without touching either mountain's visibility. Riders
   *  dropped by hand belong to the mountain they were dropped on, so leaving Play — or switching to the other
   *  mountain — puts them away. */
  function setPlayActive(on: boolean, target: 'authored' | 'reference') {
    if (!on || target !== playTarget) clearAiField();
    playTarget = target;
    if (!on) { showRideSpawn(null); return; }
    const reference = target === 'reference';
    // size the start marker to the mountain (a few % of its span) so it reads from the editor's framing
    const mesh = reference ? deps.getReference() : deps.getTerrain();
    if (mesh) {
      mesh.updateWorldMatrix(true, false);
      const d = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3()).length();
      playMarkerScale = Math.max(1, d * 0.012);
      if (playMarker) playMarker.scale.setScalar(playMarkerScale);
    }
  }

  /** Show / move the world-space start marker (a green flag on the ground). Null hides it. */
  function showRideSpawn(world: V3 | null) {
    if (!world) { if (playMarker) playMarker.visible = false; return; }
    if (!playMarker) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3, 8), new THREE.MeshBasicMaterial({ color: 0x35e06a }));
      pole.position.y = 1.5;
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 4), new THREE.MeshBasicMaterial({ color: 0x35e06a }));
      flag.position.y = 3.1; flag.rotation.y = Math.PI / 4;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.1, 24), new THREE.MeshBasicMaterial({ color: 0x35e06a, side: THREE.DoubleSide, transparent: true, opacity: 0.7 }));
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.05;
      g.add(pole, flag, ring);
      g.traverse(o => { o.raycast = () => {}; });
      stage.scene.add(g); // world space, like the board
      playMarker = g;
    }
    playMarker.visible = true;
    playMarker.scale.setScalar(playMarkerScale);
    playMarker.position.set(world[0], world[1], world[2]);
  }

  /** Test mode: resolve a click on the current target mountain to a world point and hand it to the host, which
   *  decides what a slope click means right now — dropping an AI rider, or (once) placing the ride start. */
  function pickPlaySurface() {
    const mesh = playTarget === 'reference' ? deps.getReference() : deps.getTerrain();
    if (!mesh) return;
    // setFromCamera updates the ray but intentionally retains Raycaster near/far. Pointer placement must always
    // span the camera's full view even if another subsystem previously used a bounded probe.
    stage.ray.near = 0;
    stage.ray.far = Infinity;
    const hit = stage.ray.intersectObject(mesh, false)[0];
    if (hit) stage.cb.onPlayClick?.([hit.point.x, hit.point.y, hit.point.z]);
  }

  /**
   * Everything a rider — the player's or the AI's — needs from the mountain it is dropped on: the mesh its
   * physics collides against, the floor below which it is out of bounds, its face → surface-type lookup, and the
   * analytic patch contact / grind rails when the target carries them. Null when the reference is the target but
   * none is loaded. Both entry points below start from this, so a spectated field rides exactly what a player
   * would ride on the same mountain.
   */
  function rideTarget(target: 'authored' | 'reference') {
    const reference = target === 'reference';
    if (reference && !canRide()) return null;
    const mesh = reference ? deps.getReference()! : deps.getTerrain();
    mesh.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(mesh);
    const rd = deps.getRefData(), pv = deps.getPreview();
    const surfaceOf = reference
      ? (faceIndex: number): number | null => (rd ? (rd.patchSurf[Math.floor(faceIndex / rd.facesPerPatch)] ?? null) : null)
      : (faceIndex: number): number | null => (pv ? (pv.cellSurf[Math.floor(faceIndex / pv.facesPerCell)] ?? null) : null);
    // The level's colliders and the volumes built over them are shared by whoever mounts on this target — a
    // spectated field meets the same architecture and the same boost volumes a ridden board would, which is the
    // whole point of the field being the player's own model. Gathered LAZILY and once: `rideTarget` is also what
    // a slope click goes through, and walking a reference level's instance table on every click to drop one
    // rider onto an already-mounted field is work nobody asked for.
    let obstacles: RideObstacleSource[] | null = null;
    let volumes: BoostVolume[] | null = null;
    let cracked: CrackedSurface[] | null = null;
    const captureObstacles = () => (obstacles ??=
      reference ? deps.getReferencePropColliders() : deps.getAuthoredPropColliders());
    return {
      reference, mesh, surfaceOf,
      get obstacles() { return captureObstacles(); },
      get boostVolumes() {
        return volumes ??= buildBoostVolumes(captureObstacles(), deps.getBoostVolumeSpecs?.());
      },
      resetVolumes: deps.getResetVolumeKeys?.() ?? EMPTY_KEYS,
      get crackedSurfaces() {
        return cracked ??= buildCrackedSurfaces(captureObstacles(), deps.getCrackedSurfaceSpecs?.());
      },
      onCrackedChange: deps.onCrackedChange,
      onCrackedBreak: deps.onCrackedBreak,
      finish: reference ? referenceFinishLine() : authoredFinishLine(),
      laps: reference ? deps.getRefLaps() : deps.getLaps(),
      showoffSeconds: reference ? deps.getRefShowoffSeconds() : deps.getShowoffSeconds(),
      checkpoints: rideCheckpoints(reference),
      oobFloorY: box.min.y - 100,
      patchContact: (reference ? referencePatchContact(deps.getRefData())
        : authoredPatchContact(deps.getPreview())) ?? undefined,
      rails: (reference ? referenceGrindRails() : authoredGrindRails()) ?? undefined,
    };
  }
  type RideTarget = NonNullable<ReturnType<typeof rideTarget>>;

  /**
   * Field the AI riders on the target's AI network ([Trailmap: 395]). They get exactly what the player's model
   * gets — same terrain, contact, rails and floor — because they ARE the same model; only the input differs.
   * `player`, when a board is out there, is the human's live state: a competitor in the standings like anyone
   * else. False when the mountain has no AI network to ride.
   *
   * `gates` overrides which lines riders are fielded on; **an empty list is meaningful** — that is a field with a
   * network to ride and nobody on it yet, which is what Play's click-to-drop starts from. Any field already out
   * there is put away first: a mountain gets one field, and mounting a second would leave the first one's boards
   * on the snow with nothing stepping them.
   */
  function mountAiField(t: RideTarget, player?: RideState, gates?: number[]): boolean {
    const { paths, starts, course } = t.reference ? referenceAiWorldPaths() : authoredAiWorldPaths();
    if (!paths.length) return false;
    const seeded = gates ?? starts;
    if (!gates && !starts.length) return false;
    aiField?.dispose();
    aiField = createAiRiders({
      paths, starts: seeded, course, terrain: t.mesh, scene: stage.scene,
      surfaceOf: t.surfaceOf, oobFloorY: t.oobFloorY, patchContact: t.patchContact, rails: t.rails,
      obstacles: t.obstacles, boostVolumes: t.boostVolumes, resetVolumes: t.resetVolumes,
      crackedSurfaces: t.crackedSurfaces,
      onCrackedChange: (slot, key, cracked) => t.onCrackedChange?.(key, cracked, slot),
      onCrackedBreak: (slot, key) => t.onCrackedBreak?.(key, slot),
      finish: t.finish, laps: t.laps,
      // An opponent's prop contacts run the level's collision graphs like the player's do: the button it rides
      // over lights up, the door it hits opens, and the pad's speed boost lands on IT rather than on you.
      onPropCollision: (slot, hit) => deps.onPropCollision?.(hit, slot),
      maxRiders: aiMax, player, riderModel, riderStyle, gear: rideGear, snowboardStance,
    });
    return true;
  }

  /** The field's size cap. Zero disables/clears it; lowering a live field retires its oldest riders first. */
  function setAiMax(n: number) {
    aiMax = Math.max(0, Math.floor(n));
    aiField?.setMax(aiMax);
  }

  /** Select the character for future and already-running riders without disturbing their live physics state. */
  function setRiderModel(modelId: string) {
    const next = modelId || DEFAULT_RIDER_MODEL_ID;
    if (next === riderModel) return;
    riderModel = next;
    board()?.setRiderModel(next);
    aiField?.setRiderModel(next);
  }

  /** Select how the player and every AI rider stand, for future and already-running riders alike. Unlike a
   *  character swap this rebuilds nothing at all: each body simply crosses to the new stance where it is. */
  function setRiderStyle(styleId: string) {
    const next = styleId || DEFAULT_RIDING_STYLE;
    if (next === riderStyle) return;
    riderStyle = next;
    board()?.setRiderStyle(next);
    aiField?.setRiderStyle(next);
  }

  /** Put the player and the whole field on a snowboard or on skis, for future and already-running riders
   *  alike. The physics is identical on either, so a live swap costs the run nothing: the same rider is on the
   *  same line at the same speed, standing a different way on different kit. */
  function setRideGear(gear: RideGear) {
    if (gear === rideGear) return;
    rideGear = gear;
    board()?.setGear(gear);
    aiField?.setGear(gear);
  }

  /** Set the snowboard foot order for future and live player/AI riders. Skis retain it without visual change. */
  function setSnowboardStance(stance: SnowboardStance) {
    if (stance === snowboardStance) return;
    snowboardStance = stance;
    board()?.setSnowboardStance(stance);
    aiField?.setSnowboardStance(stance);
  }

  /** Account presentation changes are visual-only and apply to ridden and parked local gear immediately. */
  function setEquipmentAppearance(appearance?: EquipmentAppearance) {
    equipmentAppearance = appearance;
    board()?.setEquipmentAppearance(appearance);
    xr?.setEquipmentAppearance(appearance);
  }

  /** Test panel's live local-board visual toggle. It never touches the separately owned AI field. */
  function setBoardFxEnabled(on: boolean) {
    boardFxEnabled = on;
    board()?.setBoardFxEnabled(on);
  }

  /**
   * Play setup: drop one AI rider where the slope was clicked and let it ride (docs/016). The field is created on
   * first drop — a mountain with no riders on it yet is still a mountain with an AI network — so a click is all it
   * takes to watch the real controller read a stretch of terrain you are working on. A full field recycles its
   * oldest rider into the new spot, which is what makes repeat clicks a probe rather than a pile-up.
   *
   * False when there is nothing for a rider to follow (no course to derive lines from, a reference with no AIP
   * paths, or no ridable target at all) — the caller says so; a rider dropped with no line would just stand there.
   */
  function dropAiRider(world: V3): boolean {
    if (ride) return false; // a running ride owns the pointer anyway; this cannot be reached mid-ride
    const t = rideTarget(playTarget);
    if (!t) return false;
    if (!aiField && !mountAiField(t, undefined, [])) return false;
    return aiField!.spawnAt(new THREE.Vector3(world[0], world[1], world[2]));
  }

  /** Put the field away (leaving Play, switching the ride target, starting or stopping a ride / watch). */
  function clearAiField() {
    aiField?.dispose();
    aiField = null;
    vrFieldStarted = false;
  }

  /** Setup deliberately preserves the editor view; only a running field hides the other mountain. For a reference
   *  target, hide every authored child under worldRoot — not just the terrain solid — so its cage / box / overlays
   *  cannot remain behind as a "wireframe mountain". The reference has its own refRoot child and stays visible. */
  function hideOtherMountain(reference: boolean) {
    const other = reference
      ? stage.worldRoot.children.filter(o => o !== stage.refRoot)
      : [stage.refRoot];
    rideVis = other.map(o => ({ o, v: o.visible }));
    for (const { o } of rideVis) o.visible = false;
  }

  function restoreMountains() {
    if (!rideVis) return;
    for (const { o, v } of rideVis) o.visible = v;
    rideVis = null;
  }

  /** Save the editor's view and stand it down: whatever comes next — a chase ride or a headset — owns the
   *  camera, the orbit controls and the gizmo until it gives them back through `restoreEditorView`. */
  function takeEditorView() {
    if (rideRestore) return;
    rideRestore = {
      camera: stage.camera,
      pos: stage.camera.position.clone(),
      quat: stage.camera.quaternion.clone(),
      target: stage.controls.target.clone(),
      perspFov: stage.perspCam.fov,
      perspNear: stage.perspCam.near,
      controls: stage.controls.enabled,
      gizmoOn: stage.gizmo.enabled,
      gizmoVis: stage.gizmo.getHelper().visible,
    };
    stage.camera = stage.perspCam; // a ride always drives the perspective camera
    stage.controls.enabled = false;
    stage.gizmo.enabled = false;
    stage.gizmo.getHelper().visible = false;
    showRideSpawn(null); // the flag is out of the way while riding
  }

  function restoreEditorView() {
    const r = rideRestore;
    if (!r) return;
    stage.camera = r.camera;
    stage.camera.position.copy(r.pos);
    stage.camera.quaternion.copy(r.quat);
    stage.perspCam.fov = r.perspFov;
    stage.perspCam.near = r.perspNear;
    stage.perspCam.updateProjectionMatrix();
    stage.controls.target.copy(r.target);
    stage.controls.enabled = r.controls;
    stage.gizmo.enabled = r.gizmoOn;
    stage.gizmo.getHelper().visible = r.gizmoVis;
    stage.controls.update();
    rideRestore = null;
  }

  /** Launch the actual ride from a WORLD-space `spawn`, on the `target` mountain.
   *  This hides the other mountain + the marker and drives the board.
   *  `ai` fields the ghost opponents on the target's AI paths. `onExit` fires when the rider presses Esc.
   *  Saves + restores the editor camera / controls / gizmo. */
  function startRide(target: 'authored' | 'reference', spawn: V3, heading: V3 | null, onExit: () => void,
    ai = false, countdown: RideCountdown | null = null, telemetry = false, touchControls = true) {
    if (ride || watching) return;
    const t = rideTarget(target);
    if (!t) return;
    takeEditorView();
    mountBoard(t, spawn, heading, onExit, ai, countdown, telemetry, touchControls);
  }

  /** Seat a board on an already-prepared target. Split out of `startRide` because a VR session mounts and
   *  dismounts repeatedly inside ONE held editor view, and must not re-save it each time. */
  function mountBoard(t: RideTarget, spawn: V3, heading: V3 | null, onExit: () => void,
    ai: boolean, countdown: RideCountdown | null, telemetry: boolean,
    touchControls = true, view: 'chase' | 'vr' = 'chase', gaze?: () => THREE.Vector3 | null) {
    const reference = t.reference, rideMesh = t.mesh;
    const boardFxGround = downwardGroundQuery((from, to) => castTerrain(t, from, to));
    const walkGround = downwardGroundQuery((from, to) => castWalkGround(t, from, to));

    ride = new TestRide({
      spawn: new THREE.Vector3(spawn[0], spawn[1], spawn[2]),
      heading: heading ? new THREE.Vector3(heading[0], heading[1], heading[2]) : undefined,
      terrain: rideMesh, scene: stage.scene, camera: stage.perspCam, container: stage.container,
      pointerTarget: view === 'chase' ? stage.renderer.domElement : undefined,
      touchControls: view === 'chase' && touchControls,
      surfaceOf: t.surfaceOf, oobFloorY: t.oobFloorY, patchContact: t.patchContact, rails: t.rails,
      obstacles: t.obstacles, onObstacleHit: hit => deps.onPropCollision?.(hit, null),
      boostVolumes: t.boostVolumes,
      crackedSurfaces: t.crackedSurfaces,
      crackedSurfaceRuntime: view === 'vr' ? xrCrackedSurfaces ?? undefined : undefined,
      onCrackedChange: t.onCrackedChange, onCrackedBreak: t.onCrackedBreak,
      shovedBodies: deps.shovedBodySamples,
      course: (reference ? referenceAiWorldPaths() : authoredAiWorldPaths()).course,
      finish: t.finish, laps: t.laps,
      raceMode: deps.getRaceMode(), showoffSeconds: t.showoffSeconds,
      checkpoints: t.checkpoints,
      countdown,
      telemetry,
      boardSound: deps.getBoardSound(),
      riderModel, riderStyle, gear: rideGear, snowboardStance, equipmentAppearance,
      boardFx: boardFxEnabled, boardFxGround,
      view, gaze,
      walkGround: view === 'chase' ? walkGround : undefined,
      walkResolveMove: view === 'chase'
        ? (from, to, velocity) => ensureWalkObstacles(t).resolveMove(from, to, velocity)
        : undefined,
      onControlContextChange: () => stage.cb.onRideControlContextChange?.(),
      label: `Riding: ${reference ? deps.getRefLevel() || 'Reference' : deps.getMountainName() || 'Mountain'}`, onExit,
    });
    ride.start();
    colliderOverlay.setSources(t.obstacles);
    hideOtherMountain(reference);
    // A ride starts a fresh field: any riders dropped by hand during setup were a look at the terrain, not a race.
    clearAiField();
    // The AI field mounts after ride.start() so it reuses the geometry's freshly built ride BVH, and it takes the
    // player's live state: the human is a competitor in the standings like anyone else ([Trailmap: 395]).
    if (ai) mountAiField(t, ride.state);
    return ride;
  }

  /**
   * Spectate the AI field ([Trailmap: 395]): the riders race the mountain with **no board out there** and the
   * editor keeps everything of its own — camera, orbit controls, gizmo, overlays. Nothing is saved or restored
   * because nothing is taken: the render loop simply steps the field, so you can orbit and zoom around them
   * while they work the course, which is what a chase camera welded to one board cannot show you. The standings
   * ladder just closes on itself with no human rung in it.
   *
   * False when the target mountain has no AI network to ride (no course to derive lines from, or a reference
   * level that ships no AIP paths).
   */
  function startWatch(target: 'authored' | 'reference'): boolean {
    if (ride || watching) return false;
    const t = rideTarget(target);
    if (!t || !mountAiField(t)) return false;
    hideOtherMountain(t.reference);
    watching = true;
    return true;
  }

  /** Put the spectated field away, restoring the other mountain. The editor's view was never touched. */
  function stopWatch() {
    if (!watching) return;
    clearAiField();
    restoreMountains();
    watching = false;
  }

  /** Leave the test ride, restoring the other mountain and the saved editor camera / controls / gizmo. */
  function stopRide() {
    if (!ride) return;
    ride.stop();
    ride = null;
    colliderOverlay.setSources([]);
    clearAiField();
    // A VR session outlives its board: stepping off leaves the rider standing on the same hidden-away mountain,
    // still in the headset, so the world and the editor view stay exactly as the session left them.
    if (xr) return;
    disposeWalkObstacles();
    restoreMountains();
    restoreEditorView();
  }

  // ---- VR play (docs/048) ----

  /**
   * Enter the headset on `target`, on FOOT, with the board parked at `spawn`.
   *
   * The session, not the board, is the thing that owns the run here: it holds the editor view and the hidden
   * other mountain for as long as the rider is wearing the headset, and mounts and dismounts boards inside that.
   * So this takes the view once and gives it back once, in `stopXrPlay` — `stopRide` deliberately does neither
   * while a session is up.
   *
   * `enter` must be reached from a user gesture (WebXR gates `requestSession` on user activation), so the caller
   * awaits nothing before calling this. False when the headset refused, leaving the editor untouched.
   */
  async function startXrPlay(target: 'authored' | 'reference', spawn: V3, heading: V3 | null,
    onExit: () => void, ai = false, telemetry = false, renderScale = DEFAULT_XR_RENDER_SCALE,
    layerMode: XrLayerMode = 'webgl', antialias = false, showStats = true,
    onStatsChanged?: (enabled: boolean) => void,
    onEyeBufferMeasured?: (measurement: XrEyeBufferMeasurement) => XrEyeBufferMeasurement | void): Promise<boolean> {
    if (ride || watching || xr) return false;
    const t = rideTarget(target);
    if (!t) return false;
    const at = new THREE.Vector3(spawn[0], spawn[1], spawn[2]);
    const facing = heading
      ? new THREE.Vector3(heading[0], heading[1], heading[2])
      : new THREE.Vector3(0, 0, 1);
    xrBrokenSurfaces.clear();
    xrCrackedSurfaces = t.crackedSurfaces.length
      ? createCrackedSurfaceRuntime(t.crackedSurfaces, {
        onCrack: key => t.onCrackedChange?.(key, true),
        onHeal: key => t.onCrackedChange?.(key, false),
        onBreak: key => {
          xrBrokenSurfaces.add(key);
          t.onCrackedBreak?.(key);
        },
      })
      : null;
    const session = createXrPlay({
      renderer: stage.renderer, scene: stage.scene, camera: stage.perspCam,
      groundCast: (from, to) => castWalkGround(t, from, to),
      resolveWalkMove: (from, to, velocity) => ensureWalkObstacles(t).resolveMove(from, to, velocity),
      // The walker's standing height rides along so a chest-high pane registers on the torso, not the feet.
      stepFootContact: (from, to, velocity, dt) => xrCrackedSurfaces?.step(from, to, velocity, dt, RIDER_HEAD_Y),
      oobFloorY: t.oobFloorY,
      label: t.reference ? deps.getRefLevel() || 'Reference' : deps.getMountainName() || 'Mountain',
      spawn: at, heading: facing, renderScale, antialias,
      prepareAntialias: enabled => stage.prepareXrAntialias(enabled),
      layerMode, showStats, onStatsChanged, onEyeBufferMeasured,
      riderModel, riderStyle, gear: rideGear, snowboardStance, equipmentAppearance,
      // Build the session-owned board during the headset's opening transition, then stand it down. Its visible
      // loose-board counterpart remains the XR session's parked deck; this retained TestRide is only the warm
      // physics/pose/audio runtime that the first mount will re-seat and reveal.
      prepareRide: gaze => prepareVrBoard(t, at, facing, gaze, ai, telemetry),
      // Every mount is an ordinary `TestRide` on the same prepared target — same contact model, same rails, same
      // volumes, same collision dispatch. Only the view and the input differ, which is the whole design.
      startRide: (from, into, gaze) => seatVrBoard(
        t, from, into, gaze, ai, telemetry,
      ),
      stopRide: () => parkVrBoard(),
      restartField: () => restartVrField(t, ai),
      setFlightBoostAudio: (active, dt) => vrRide?.setFlightBoostAudio(active, dt),
      onExit: () => finishXrPlay(onExit),
    });
    xr = session;
    // The setup flag goes away for the whole session, as `takeEditorView` puts it away for a desktop ride: the
    // rider stands at the gate on foot, and a pole scaled to the mountain would be right on top of them. Hidden
    // BEFORE the request so the headset's first frame is clean; `onExit` (play.ts `exitVr`) brings it back.
    showRideSpawn(null);
    if (await session.enter()) return true;
    xr = null;
    session.dispose();
    xrCrackedSurfaces = null;
    xrBrokenSurfaces.clear();
    disposeWalkObstacles();
    showRideSpawn(spawn); // the headset refused: setup continues with its marker where it was
    return false;
  }

  /**
   * Build the retained WebXR board during session entry and immediately park it. Construction is not cheap: the
   * prop-collision BVH alone can cost tens to hundreds of milliseconds, plus the AI field when enabled. Paying
   * that during the headset's opening transition keeps it out of the first trigger press / step onto the deck.
   */
  function prepareVrBoard(t: RideTarget, at: THREE.Vector3, facing: THREE.Vector3,
    gaze: () => THREE.Vector3 | null, ai: boolean, telemetry: boolean): TestRide | null {
    if (!vrRide) {
      seatVrBoard(t, at, facing, gaze, ai, telemetry);
      parkVrBoard();
      // `mountBoard` builds the requested opponents too. Retain that work, but do not give them a head start while
      // the player is learning the on-foot controls at the gate.
      vrFieldStarted = false;
      aiField?.setVisible(false);
    }
    return vrRide;
  }

  /** Re-field XR opponents at their start gates and hold them there until the restarted player mounts. */
  function restartVrField(t: RideTarget, ai: boolean) {
    if (ai && vrRide) mountAiField(t, vrRide.state);
    vrFieldStarted = false;
    aiField?.setVisible(false);
  }

  /**
   * Seat the WebXR rider on their already-prepared board. The lazy construction branch is retained as a safe
   * fallback if a future XR host elects not to prewarm. Every later mount is only a warp: the expensive ride
   * runtime and AI field remain alive until the headset session ends.
   */
  function seatVrBoard(t: RideTarget, from: THREE.Vector3, into: THREE.Vector3,
    gaze: () => THREE.Vector3 | null, ai: boolean, telemetry: boolean): TestRide | null {
    if (!vrRide) {
      vrRide = mountBoard(t, [from.x, from.y, from.z], [into.x, into.y, into.z],
        () => xr?.exit(), ai, null, telemetry, false, 'vr', gaze) ?? null;
      for (const key of xrBrokenSurfaces) vrRide?.retireObstacle(key);
      vrFieldStarted = !!vrRide;
      aiField?.setVisible(vrFieldStarted);
      return vrRide;
    }
    ride = vrRide;
    ride.seatAt(from, into);
    vrFieldStarted = true;
    aiField?.setVisible(true);
    colliderOverlay.setSources(t.obstacles);
    return ride;
  }

  /** The WebXR rider stepped off. The board stands down where it is; nothing is torn down until the session
   *  itself ends, so the next mount is a warp rather than a rebuild. */
  function parkVrBoard() {
    if (!ride) return;
    ride.park();
    ride = null;
    colliderOverlay.setSources([]);
  }

  /** Leave VR (the Stop button, or Esc). The session's own `end` runs the teardown either way. */
  function stopXrPlay() { xr?.exit(); }

  /** The session has actually ended: put the board away, the mountains back, and the editor's view back. */
  function finishXrPlay(onExit: () => void) {
    const session = xr;
    xr = null;              // cleared FIRST so the stopRide below takes its ordinary restore path
    // The session's board outlived every one of its mounts; this is where it finally goes. A rider who left the
    // headset while ON the board takes the ordinary teardown, which is the same object either way.
    if (!ride && vrRide) ride = vrRide;
    vrRide = null;
    if (ride) stopRide();
    session?.dispose();
    xrCrackedSurfaces = null;
    xrBrokenSurfaces.clear();
    disposeWalkObstacles();
    restoreMountains();
    restoreEditorView();
    onExit();
  }

  /** A world-space downward cast against the ridden mountain, for the walker's floor and the board's parking
   *  spot. The BVH the picker keeps for this mesh is the same one the editor's own hover casts use. */
  function castTerrain(t: RideTarget, from: THREE.Vector3, to: THREE.Vector3): WalkGround | null {
    const bvh = pickTree(t.mesh.geometry as TreeGeometry);
    if (!bvh) return null;
    t.mesh.updateWorldMatrix(true, false);
    castInverse.copy(t.mesh.matrixWorld).invert();
    castFrom.copy(from).applyMatrix4(castInverse);
    castTo.copy(to).applyMatrix4(castInverse);
    const far = castFrom.distanceTo(castTo);
    if (far < 1e-9) return null;
    castRay.origin.copy(castFrom);
    castRay.direction.copy(castTo).sub(castFrom).divideScalar(far);
    // DoubleSide because every terrain material is: the world root's chirality mirror inverts triangle winding.
    const hit = bvh.raycastFirst(castRay, THREE.DoubleSide, 0, far);
    if (!hit?.face) return null;
    const point = (hit.point as THREE.Vector3).applyMatrix4(t.mesh.matrixWorld);
    castNormals.getNormalMatrix(t.mesh.matrixWorld);
    const normal = hit.face.normal.clone().applyMatrix3(castNormals).normalize();
    if (normal.y < 0) normal.negate(); // a mirrored face can report its normal pointing into the mountain
    return { y: point.y, normal, point };
  }

  /** Nearest on-foot floor across terrain and every solid prop collider. Unlike the snowboard contact probe,
   * walking deliberately ignores SurfaceType: a hut roof, box or Roller shell is ordinary character ground. */
  function castWalkGround(t: RideTarget, from: THREE.Vector3, to: THREE.Vector3): WalkGround | null {
    const terrain = castTerrain(t, from, to);
    const prop = ensureWalkObstacles(t).groundCast(from, to);
    if (!terrain) return prop;
    if (!prop) return terrain;
    return prop.y > terrain.y ? prop : terrain;
  }

  /** SSF Play runtime entry point: the action lands on the rider that earned it — the player's board for a
   *  null subject, otherwise that AI slot. A spectated field has no board and every subject is an opponent. */
  function applyEffect(action: RideEffectAction, subject: number | null = null) {
    if (subject === null) ride?.applyEffect(action);
    else aiField?.applyEffect(subject, action);
  }

  /** Retire an object killed by an effect from the active ride's immutable collider snapshot. */
  function retireObstacle(object: RideObstacleObject) {
    const key = object.kind === 'reference' ? `reference:${object.index}` : `authored:${object.id}`;
    board()?.retireObstacle(key);
    aiField?.retireObstacle(key);
    walkObstacles?.retire(key);
  }

  /** Re-arm a temporarily popped pickup for the player and every AI rider. */
  function restoreObstacle(object: RideObstacleObject) {
    const key = object.kind === 'reference' ? `reference:${object.index}` : `authored:${object.id}`;
    board()?.restoreObstacle(key);
    aiField?.restoreObstacle(key);
    walkObstacles?.restore(key);
    // WebXR keeps its crack pool above any one board mount, so a breakable respawn must re-arm that owner too.
    xrCrackedSurfaces?.restore(key);
    xrBrokenSurfaces.delete(key);
  }

  function togglePause() { if (ride) ride.setPaused(!ride.paused); }

  /** Test ▸ Position player join. Desktop Play keeps the current ride runtime and relocates its active body. */
  function teleportPlayer(position: THREE.Vector3, heading: THREE.Vector3): boolean {
    return ride?.teleportTo(position, heading) ?? false;
  }

  /** Pointer deltas from captured mouse-look or the third-person RMB fallback; the camera stays rider-centered. */
  function orbitCamera(deltaX: number, deltaY: number) { ride?.orbitCamera(deltaX, deltaY); }
  function zoomThirdPersonWheel(deltaY: number, deltaMode = 0): boolean {
    return ride?.zoomThirdPersonWheel(deltaY, deltaMode) ?? false;
  }
  function setDesktopBoardAim(ndc: readonly [number, number] | null) { ride?.setDesktopBoardAim(ndc); }
  function beginDesktopPointer(button: number): boolean { return ride?.beginDesktopPointer(button) ?? false; }
  function endDesktopPointer(button: number): boolean { return ride?.endDesktopPointer(button) ?? false; }

  return {
    get riding() { return !!ride; },
    get paused() { return !!ride?.paused; },
    /** Live participant position for effects. A headset session retains it while its board is parked. */
    get riderPosition() { return ride?.activePosition ?? (xr?.presenting ? xr.activePosition : null); },
    get riderVelocity() { return ride?.activeVelocity ?? (xr?.presenting ? xr.activeVelocity : null); },
    /** Collision/proximity graphs stay dormant only while the race gate or pause holds the participant. Walking
     * and flight are still Play states and must not tear down counters, sounds, or persistent world effects. */
    get riderCanTrigger() {
      return xr?.presenting ? !ride?.countingDown && !ride?.paused
        : !!ride && !ride.countingDown && !ride.paused;
    },
    /** Desktop Play is still active on foot; this says whether its board is currently parked. */
    get walking() { return !!ride?.onFoot; },
    /** Desktop view context for the lower-left Test key-mapping sheet. */
    get firstPerson() { return !!ride?.firstPerson; },
    get watching() { return watching; },
    get canRideReference() { return canRide(); },
    get playTarget() { return playTarget; },
    /** A headset session is up — the rider is in VR, on foot or on the board (docs/048). */
    get xrPresenting() { return !!xr?.presenting; },
    /** GPU timing follows the visible profiler: desktop rides always show it; VR can switch it live at the wrist. */
    get perfDiagnostics() { return xr ? xr.presenting && xr.diagnosticsEnabled : !!ride; },
    /** Local participant pose, whichever Play state owns it. WebXR adds tracked head/hands over the board. */
    get playerPose(): LocalPlayerPose | null { return xr?.playerPose() ?? ride?.playerPose() ?? null; },
    /** How many AI riders are out on the mountain right now (gate riders + hand-dropped ones). */
    get aiRiderCount() { return aiField?.count ?? 0; },
    step, recordFramePerf, referenceSpawn, setPlayActive, showRideSpawn, pickPlaySurface,
    startRide, stopRide, startWatch, stopWatch, dropAiRider, setAiMax, setRiderModel, setRiderStyle,
    setRideGear, setSnowboardStance, setEquipmentAppearance, setBoardFxEnabled,
    startXrPlay, stopXrPlay, beginXrFrame, endXrFrame,
    applyEffect, retireObstacle, restoreObstacle, teleportPlayer,
    /** Test mode's collider overlay toggle — world collision shapes plus the rider's own probe volume. */
    setCollidersVisible(on: boolean) { colliderOverlay.setVisible(on); },
    /** Test's live music master: environment off-board and race track on-board. */
    setMusicEnabled(on: boolean) { musicEnabled = on; if (!on) music.stop(); },
    get collidersVisible() { return colliderOverlay.visible; },
    togglePause, orbitCamera, zoomThirdPersonWheel, setDesktopBoardAim, beginDesktopPointer, endDesktopPointer,
  };
}

export type RideLayer = ReturnType<typeof createRideLayer>;
