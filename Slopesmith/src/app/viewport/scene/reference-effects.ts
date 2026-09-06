import * as THREE from 'three';
import type { PlacedProp } from '../../../core/doc/types';
import type { EffectGraph, EffectNode, EffectsDocument } from '../../../core/effects/document';
import {
  ANIMATED_PROP_AUTO_RESET_SECONDS, BREAKABLE_RESPAWN_SECONDS, MOVABLE_PROP_RESPAWN_SECONDS,
  effectConditionPasses, effectPlayCommand, pickupPopScale, rollerPreviewImpact, runScheduledEffectGraphs,
  scheduleEffectGraph, stepSplineMotionDistance, PICKUP_POP_SECONDS,
  type EffectGraphTask, type EffectPlayCommand,
} from '../../../core/effects/play-runtime';
import {
  applyEffectCounterInput,
  effectCounterInstall,
  effectCounterMarkInput,
  isEffectCounterInput,
  newEffectCounter,
  type EffectCounterState,
} from '../../../core/effects/counter';
import {
  animComboFromNode, animObjectFromNode, materialWorldEffectsFromNode, type AnimObjectEffect,
} from '../../../core/effects/world-effects';
import { resolveCollisionSound, type CollisionSoundBank } from '../../../core/effects/collision-sound';
import { authoredEffectBindings, createEmptyEffectsDocument, effectGraphHasTimerEmitter, effectNodeSoundFile, emitterWorldPosition, particleEmitterFields } from '../../../core/effects/authoring';
import {
  PARTICLE_SPRITE_NAMES,
  collisionEmitterContactVelocityBase,
  emitterBlendKeepsColor,
  emitterBlendMode,
  timerEmitterPreviewLaw,
  timerEmitterPreviewLifetime,
  timerEmitterPreviewOpacity,
  timerEmitterPreviewSample,
  timerEmitterPreviewSizeRange,
  timerEmitterPreviewStartDelay,
  type EmitterBlendMode,
  type RgbaColor,
  type TimerEmitterPreviewLaw,
} from '../../../core/effects/emitter-preview';
import {
  attachedReferenceInstances,
  referenceRaceCountdown,
  referenceInstanceBindings,
  referenceInstanceByStableId,
  type ReferenceEffectInstance,
  type ReferenceEffectsData,
} from '../../../core/reference/effects';
import { placementQuat } from '../../../core/props/pose';
import { placedPropContactState } from '../../../core/props/contact';
import { RAW_TO_EDITOR } from '../constants';
import { createBoostArrowLayer, type BoostArrow } from './boost-arrows';
import { createParticleBatches } from './particle-batches';
import { editorFromRaw } from '../../../core/reference/terrain';
import type { RideEffectAction } from '../../ride/effect-actions';
import type { BoostVolumeSpec } from '../../ride/boost-volumes';
import type { CrackedSurfaceSpec } from '../../ride/cracked-surfaces';
import type { RideObstacleHit, RideObstacleObject } from '../../ride/physics';
import type { RideShovedBodySample } from '../../ride/telemetry';
import type { RaceMode } from '../../../core/doc/race';
import {
  sameRideEventTarget, type RideEvent, type RideEventKind, type RideEventTarget,
} from '../../../core/session/ride-event';
import {
  effectHostIsPresentInMode, effectModeDisabledSplineIds, effectModeFunction, effectModeHiddenInstanceIds,
  effectModeNodes,
  nativeInstanceIsShowoffOnly,
} from '../../../core/effects/mode-functions';
import type { Stage } from '../stage';
import { customSoundUrl } from '../../net/asset-paths';
import {
  gameAudioDestination, preloadAudio, resumeSharedAudio, sharedAudioBuffer, sharedAudioContext,
} from '../../audio/runtime';
import { ambientSoundUrl, type AmbientSoundSource } from './ambient-sound';
import {
  COLLISION_SOUND_DEBOUNCE_SECONDS, createPropSoundLayer, referencePropSoundSources, type PropSoundSource,
} from './prop-sound';
import type { PropInstance } from '../../../core/reference/props';
import {
  boostVolumeSpec, crackedBreakTombstonesCollider, crackedSurfaceSpec, numberField,
  playProximityRadius,
} from './reference-effects-nodes';
import {
  applyInvInertia, composeMotion, mulberry32, randomUnitVector, sampleSplinePath, splinePoseMatrices,
} from './reference-effects-motion';

export { boostVolumeSpec, crackedBreakTombstonesCollider, crackedSurfaceSpec, playProximityRadius };

const MAX_PARTICLE_HEADS = 2400;
// P6 draws U1 trail copies for every logical particle. The largest retail volley is seven launchers x 200 heads
// x eight copies = 11,200 sprites; reserve enough draw slots for it plus a modest ambient layer.
const MAX_PARTICLE_SPRITES = 16000;
const EVENT_PARTICLE_HEAD_RESERVE = 1400;
const AMBIENT_PARTICLE_LIMIT = MAX_PARTICLE_HEADS - EVENT_PARTICLE_HEAD_RESERVE;
const EVENT_BURST_PARTICLE_CAP = 200;
const PARTICLE_ATLAS_COLUMNS = 8;
const PARTICLE_ATLAS_CELL = 128;
const MAX_PULSES = 128;
const MAX_GRAPH_DEPTH = 6;
const TRIGGER_SCAN_SECONDS = 0.12;
const AMBIENT_SCAN_SECONDS = 0.15;
/**
 * The shoved-body simulation ([Trailmap: 370-world-interaction] `[[370-bodysim]]`). The activity decay ≈0.95 per
 * tick and the settle-and-sleep behaviour are traced; the solver carries no inverse-mass term because the shipped
 * bodies' authored inertia tensors invert to unit mass over their own occupancy leaves. The contact restitution,
 * friction and skin are the solver coefficients the spec names but does not give values for — they are set here
 * to let a struck body tip over its ground contact and settle rather than skid or jitter.
 */
const RIGID_ACTIVITY_DECAY = 0.95;
// Sleep at 0.4 (v² + ω²): a captured run showed grounded bodies creeping at 0.3-0.5 m/s for seconds with their
// energy hovering just over the old 0.2 — a body moving under ~0.6 m/s with little spin reads as stopped.
const RIGID_RESTITUTION = 0.35, RIGID_FRICTION = 0.55, RIGID_CONTACT_SKIN = 0.08, RIGID_SLEEP_ENERGY = 0.4;
/** Depenetration cap, metres per tick at 60 Hz: contacts nudge, they never teleport a body into the camera. */
const RIGID_MAX_CORRECTION = 0.06;
/** In-contact scrub per tick: the traced 0.9648 the terrain response applies to velocity and angular alike. */
const RIGID_ROLLING_DECAY = 0.9648;
const AMBIENT_REPEAT_SECONDS = 1.4;
/** Native contact-emitter gate recovered from the UNTRACK SnowGhost particle.collision graph (30 frames). */
const COLLISION_EMITTER_REPEAT_SECONDS = 30 / 60;
const AMBIENT_MAX_DISTANCE = 180;
const MAX_AMBIENT_EMITTERS = 48;
const ROLLER_PREVIEW_SECONDS = 5;

type RunSource = 'ambient' | 'preview' | 'play';
/** `remote` runs the sender's world graph but is deliberately not a rider on this client. */
type RunSubject = number | null | 'remote';
/** Translate an execution subject onto the strictly local rider API. Undefined is the deliberate remote guard. */
export function localRideEffectSubject(subject: RunSubject): number | null | undefined {
  return subject === 'remote' ? undefined : subject;
}
/** A Cracked node's Trigger chain gives DeadNodeMode 2 one additional, measured job: on a called invisible
 * support twin it tombstones that twin's collision. Keep the cause on the thread so ordinary tombstones in
 * unrelated collision graphs retain their existing node-lifetime meaning. */
type RunCause = 'ordinary' | 'cracked-break';
export type EffectRuntimeObject = { kind: 'reference'; index: number } | { kind: 'authored'; id: string };
const runtimeObjectKey = (object: EffectRuntimeObject | RideObstacleObject) => object.kind === 'reference'
  ? `reference:${object.index}` : `authored:${object.id}`;

interface RuntimeHost {
  key: string;
  document: EffectsDocument;
  position: (node?: EffectNode) => THREE.Vector3;
  vector: (raw: THREE.Vector3) => THREE.Vector3;
  /** Native-frame vectors that are already world space, so only the native→editor basis applies and the host
   *  instance's own rotation must not. The boost push axis is the one such field ([Trailmap: 360-node-fields]). */
  worldVector: (raw: THREE.Vector3) => THREE.Vector3;
  /** The same frame as `worldVector` but for a POINT, so the ridden world's own offset is carried rather than
   *  dropped. The vertical lift's target altitude is the only field in the effect payloads that needs it — an
   *  absolute native world Z, which a basis-only map silently reads in the wrong frame the moment the ridden
   *  world is not sitting at the native origin. */
  worldPoint: (raw: THREE.Vector3) => THREE.Vector3;
  matrix: () => THREE.Matrix4;
  sizeScale: number;
  object: EffectRuntimeObject;
  reference?: { data: ReferenceEffectsData; instance: ReferenceEffectInstance };
}

export interface EffectsPlayHooks {
  /** `subject` names the rider the action lands on: null is the player's board, a number is that AI slot. A
   *  boost pad boosts whoever rode over it, which on a course full of opponents is most of the time not you. */
  applyRideEffect?(action: RideEffectAction, subject: number | null): void;
  /** A locally accepted human-rider interaction, already started in this runtime and ready for room relay. */
  onRideEvent?(event: RideEvent): void;
  setReferenceInstanceVisible?(index: number, visible: boolean | null): void;
  setReferenceInstanceWorldMatrix?(index: number, matrix: THREE.Matrix4 | null): void;
  /** Additional render-only poses made by a native spline mover's InstanceCount. The original placement remains
   * copy zero and is updated through setReferenceInstanceWorldMatrix. */
  setReferenceInstanceWorldCopies?(index: number, matrices: readonly THREE.Matrix4[] | null): void;
  referenceInstancePieceIds?(index: number): readonly number[];
  setReferenceInstancePieceMotions?(index: number, motions: readonly EffectPieceMotion[] | null): void;
  authoredPropPieceIds?(id: string): readonly number[];
  setAuthoredPropPieceMotions?(id: string, motions: readonly EffectPieceMotion[] | null): void;
  setAuthoredPropVisible?(id: string, visible: boolean | null): void;
  setAuthoredPropWorldMatrix?(id: string, matrix: THREE.Matrix4 | null): void;
  /** Remove an effect-killed object's launch-time Play collider. Visibility alone cannot change that snapshot. */
  retireRideObject?(object: EffectRuntimeObject): void;
  /** Re-enable a temporarily retired prop's cached Play collider once its reset finishes. */
  restoreRideObject?(object: EffectRuntimeObject): void;
  /** Restore one host's material/animation receivers without rewinding any other live interaction. */
  resetObjectEffects?(object: EffectRuntimeObject): void;
  resetSceneRuntime?(): void;
  groundAt?(object: EffectRuntimeObject, position: THREE.Vector3): THREE.Vector3 | null;
  objectRadius?(object: EffectRuntimeObject): number | null;
  /** World bounds of the rendered body — the shove reads its centre to place a strike low/off-centre on it. */
  objectSphere?(object: EffectRuntimeObject): THREE.Sphere | null;
  referenceEmitterMuzzle?(index: number): { position: THREE.Vector3; direction: THREE.Vector3 } | null;
  resolveSpline?(object: EffectRuntimeObject, stableId: string): EffectSplinePath | null;
  controlProperty?(object: EffectRuntimeObject, command: number, value: number): boolean;
  /** True when the material property installed on this object is a one-shot that puts the placed material
   *  back by itself — a finite-Length TextureFlip. Preview may run those controls; every other receiver keeps
   *  what it is given until a Test reset, which Preview never performs. */
  hasPulseProperty?(object: EffectRuntimeObject): boolean;
  /** True when this object carries an AnimCombo receiver, so its trigger command has somewhere to land.
   *  Unlike the material receivers above, a combo restores ITSELF — the window runs once and ends — which is
   *  why Preview is allowed to fire one without owning a reset. */
  hasTriggerableCombo?(object: EffectRuntimeObject): boolean;
  /** Inspector-only model-clip preview, owned by the prop renderer that has the recovered model curves. */
  previewAnimObject?(object: EffectRuntimeObject, effect: AnimObjectEffect,
    autoReturnDelay?: number | null): boolean;
  /** Inspector-only material preview: run this object's installed UV scroll / free-running flipbook outside
   *  the Effects toggle. False when the renderer built no such law for it, which keeps Preview honest. */
  previewMaterialEffect?(object: EffectRuntimeObject): boolean;
  clearMaterialEffectPreviews?(): boolean;
  /** Test-mode persistent model clip. The scene reset clears the renderer-owned player. */
  startAnimObject?(object: EffectRuntimeObject, effect: AnimObjectEffect): boolean;
  clearAnimObjectPreviews?(): boolean;
}

/** A spline route plus the coordinate frame its cubic controls use. Reference routes are native raw
 * centimetres under refRoot; authored routes are editor metres under worldRoot. */
export interface EffectSplinePath {
  originalIndex: number;
  style: number;
  segments: number[][][];
  space: 'raw' | 'editor';
}

interface PersistentEmitter {
  key: string;
  host: RuntimeHost;
  graph: EffectGraph;
}

interface Particle {
  pos: THREE.Vector3;
  origin: THREE.Vector3;
  linear: THREE.Vector3;
  curved: THREE.Vector3;
  colors: readonly RgbaColor[];
  age: number;
  life: number;
  timeScale: number;
  trailCopies: number;
  trailStep: number;
  size: number;
  spriteIndex: number;
  /** The layer's authored blend, resolved through the engine's remap. Decides which draw batch the sprite
   *  joins, and whether its colour survives to the framebuffer at all. */
  blend: EmitterBlendMode;
  source: RunSource;
}

interface ContinuousEmitter {
  key: string;
  host: RuntimeHost;
  node: EffectNode;
  law: TimerEmitterPreviewLaw;
  source: RunSource;
  accumulator: number;
  expiresAt: number;
}

interface Pulse { mesh: THREE.Mesh; age: number; life: number; source: RunSource }
interface ScheduledMeta {
  source: RunSource;
  continuous: boolean;
  subject: RunSubject;
  cause: RunCause;
  /** Present on a shared interaction so conditions use the sender's inputs and deterministic event random. */
  rideEvent: RideEvent | null;
  /** Live frame carried by a collision thread. SubType-2 consumes both components; other nodes ignore it. */
  collisionContact: CollisionEmitterContact | null;
  /** A graph containing a break operation restores every host it touches at this common hit-relative time. */
  breakableResetAt: number | null;
}
type Scheduled = EffectGraphTask<RuntimeHost, ScheduledMeta>;
interface CollisionEmitterContact { position: THREE.Vector3; normal: THREE.Vector3 }

interface InteractionReset { host: RuntimeHost; at: number; kind: 'breakable' | 'movable' }

interface DynamicBody {
  key: string; host: RuntimeHost; matrix: THREE.Matrix4; basis: THREE.Matrix4;
  position: THREE.Vector3; velocity: THREE.Vector3; spinAxis: THREE.Vector3; spin: number;
  rotation: THREE.Quaternion; age: number; duration: number; hideOnEnd: boolean;
  /** Present only on a SHOVED body, which runs the rigid solve below instead of the fixed-spin visual path.
   *  The CENTRE OF MASS is the integrated state — velocity moves it and the body rotates about it; the instance
   *  origin is derived each frame as `com − R·comOffset`, so the mesh tumbles about its own weight rather than
   *  orbiting whatever corner the modeller left the origin at. `radius` is the support distance: the CoM's
   *  height above the ground at launch, NOT a bounding radius — the body was resting when it was struck, so
   *  that clearance is exactly how far its underside sits below its centre of mass. */
  angular?: THREE.Vector3;
  invInertia?: Float32Array;
  /** The body's inverse mass (1/RollerMass); 1 when the shove predates recovered effect mass. */
  invMass?: number;
  com?: THREE.Vector3;
  comOffset?: THREE.Vector3;
  radius?: number;
  /** Decaying activity accumulator behind the sleep test; see stepRigidBody. */
  activity?: number;
  asleep?: boolean;
  /** Set once the flight sampler has reported the settled body, so a rest costs one record, not a stream. */
  asleepReported?: boolean;
}

export interface EffectPieceMotion {
  piece: number;
  offset: THREE.Vector3;
  rotation: THREE.Quaternion;
}

interface MeshPieceBody extends EffectPieceMotion {
  velocity: THREE.Vector3;
  spinAxis: THREE.Vector3;
  spin: number;
}

interface PieceThrow {
  key: string;
  host: RuntimeHost;
  pieces: MeshPieceBody[];
  age: number;
  duration: number;
}

interface FlexMotion {
  key: string; host: RuntimeHost; matrix: THREE.Matrix4; basis: THREE.Matrix4;
  position: THREE.Vector3; amplitude: number; phase: number; velocity: number;
  kind: 'flag' | 'fence';
}

interface SplineMotion {
  key: string; host: RuntimeHost; basis: THREE.Matrix4;
  points: THREE.Vector3[]; cumulative: number[]; length: number; distance: number; direction: number;
  speed: number; endMode: number; orientationMode: number; instanceCount: number; yawOffset: number;
  stopped: boolean; finished: boolean; source: RunSource; splineLine: THREE.LineSegments | null;
}

export type SplineMotionCommand = Extract<EffectPlayCommand, { kind: 'spline-motion' }>;

export interface ReferenceSplineMotionInfo {
  splineId: string;
  originalIndex: number;
  style: number;
  segments: number;
  length: number;
  segmentDistances: number[];
}

/**
 * A deliberately bounded effect preview/runtime. It executes the mapped graph structure (Wait,
 * function/instance calls and timer emitters), draws lightweight particles/pulses, runs camera-near persistent
 * emitters on both mountains while the Effects view toggle is on, dispatches exact collision contacts, and
 * approximates trigger volumes by proximity during a reference test ride. It is an authoring visualization,
 * not a claim to emulate the PS2 particle renderer byte-for-byte.
 */
export function createReferenceEffectsLayer(stage: Stage, hooks: EffectsPlayHooks = {}) {
  const root = new THREE.Group();
  root.name = 'World effects preview';
  // Particles from authored + reference emitters share one geometry and one global budget. Keeping that
  // geometry at scene root also lets both chirality roots feed it ordinary world-space spawn positions.
  stage.scene.add(root);

  const splineInspectGroup = new THREE.Group();
  splineInspectGroup.name = 'Selected spline animation path';
  splineInspectGroup.visible = false;
  root.add(splineInspectGroup);
  const splineInspectCurveMat = new THREE.LineBasicMaterial({
    color: 0xb26cff, transparent: true, opacity: 0.95, depthTest: false,
  });
  const splineInspectHandleMat = new THREE.LineBasicMaterial({
    color: 0x744994, transparent: true, opacity: 0.7, depthTest: false,
  });
  const splineInspectKeyMat = new THREE.PointsMaterial({
    color: 0xe1bfff, size: 5, sizeAttenuation: false, depthTest: false,
  });
  const splineInspectPlayheadMat = new THREE.MeshBasicMaterial({ color: 0xffc45a, depthTest: false });
  const splineInspectTangentMat = new THREE.LineBasicMaterial({ color: 0xffc45a, depthTest: false });

  // Install the page-owned low-latency context before Three asks for one. Board audio connects to this same
  // device graph, and its decoded buffers share the same page-lifetime cache as these positional voices.
  sharedAudioContext();
  const audioListener = new THREE.AudioListener();
  // Three connects listeners straight to AudioContext.destination. Put its positional voices on the same Test
  // master as board/music so Game volume also governs emitters and collision/effect sounds.
  audioListener.gain.disconnect();
  audioListener.gain.connect(gameAudioDestination());
  stage.camera.add(audioListener);
  const soundGenerations: Record<RunSource, number> = { ambient: 0, preview: 0, play: 0 };
  const activeSounds = new Set<{ sound: THREE.PositionalAudio; source: RunSource }>();

  function resumeEffectsAudio() {
    resumeSharedAudio();
  }

  /** Any sound URL's page-cached decoded buffer — shared with the board and retained between Test runs. */
  const soundBuffer = (url: string): Promise<AudioBuffer | null> => sharedAudioBuffer(url);

  const effectSoundUrl = (level: string, slot: number, bank: CollisionSoundBank = 'course'): string =>
    `/api/effect-sound?level=${encodeURIComponent(level)}&slot=${slot}`
      + (bank === 'crowd' ? '&bank=crowd' : '');

  function effectSoundBuffer(level: string, slot: number,
    bank: CollisionSoundBank = 'course'): Promise<AudioBuffer | null> {
    return soundBuffer(effectSoundUrl(level, slot, bank));
  }

  /**
   * Everything a PROP sounds — the placed ambience of its `Sounds.ExternalSounds` records and the one-shot its
   * `Sounds.CollisonSound` row fires — lives in `prop-sound`, which this dispatches contacts into. The audio
   * graph above stays here because effect-graph PlaySound nodes share it.
   *
   * Built before `stopSounds`, which tears it down: a `const` referenced from a hoisted function declaration
   * would throw if anything called that function while this was still in its temporal dead zone.
   */
  const ambienceMatrix = new THREE.Matrix4();
  /** Raw centimetres through the reference holder — exactly the transform `soundRangeObject` draws the same
   *  record with, so what is heard and what is outlined in the Props panel are one volume. */
  function ambienceRawToWorld(): THREE.Matrix4 {
    stage.refRoot.updateWorldMatrix(true, false);
    return ambienceMatrix.multiplyMatrices(stage.refRoot.matrixWorld, RAW_TO_EDITOR);
  }
  const propSound = createPropSoundLayer({
    playOneShot: (buffer, position, volume) => playBufferOneShot(buffer, position, 'play', volume),
    bankBuffer: (level, slot, bank) => effectSoundBuffer(level, slot, bank),
    fileBuffer: file => customSoundBuffer(file),
    riderSpeed: () => riderVelocity.length(),
    ambient: {
      listener: audioListener,
      root,
      rawToWorld: raw => new THREE.Vector3(raw[0], raw[1], raw[2]).applyMatrix4(ambienceRawToWorld()),
      worldToRaw: world => {
        const raw = world.clone().applyMatrix4(ambienceRawToWorld().clone().invert());
        return [raw.x, raw.y, raw.z];
      },
      // Authored placements hang off worldRoot; the reference hangs off refRoot, which adds the comparison
      // OFFSET. Routing an authored centre out to world space and back in through the same inverse the
      // listener uses is what makes the two frames agree, whatever that offset currently is.
      editorToRaw: editor => {
        stage.worldRoot.updateWorldMatrix(true, false);
        const world = new THREE.Vector3(editor[0], editor[1], editor[2])
          .applyMatrix4(stage.worldRoot.matrixWorld);
        const raw = world.applyMatrix4(ambienceRawToWorld().clone().invert());
        return [raw.x, raw.y, raw.z];
      },
      loadBuffer: url => { resumeEffectsAudio(); return soundBuffer(url); },
    },
  });

  /** Retire a one-shot completely. Three's `Audio` connects its gain to the listener in its own constructor
   *  and never undoes that edge, so stopping and unparenting alone left a live node chain per prop hit for
   *  the life of the page — invisible, but it accumulates across a long session of collisions. */
  function releaseSound(sound: THREE.PositionalAudio) {
    sound.onEnded = () => {};
    if (sound.isPlaying) { try { sound.stop(); } catch { /* the context stopped it already */ } }
    try { sound.disconnect(); } catch { /* never connected: nothing to undo */ }
    try { sound.gain.disconnect(); } catch { /* already detached */ }
    sound.removeFromParent();
  }

  function stopSounds(source?: RunSource) {
    if (source) soundGenerations[source]++;
    else for (const key of Object.keys(soundGenerations) as RunSource[]) soundGenerations[key]++;
    for (const active of [...activeSounds]) {
      if (source && active.source !== source) continue;
      releaseSound(active.sound);
      activeSounds.delete(active);
    }
    if (!source || source === 'ambient') propSound.stopAmbient();
  }

  function playBufferOneShot(pending: Promise<AudioBuffer | null>, position: THREE.Vector3,
    source: RunSource, volume: number) {
    resumeEffectsAudio();
    const generation = soundGenerations[source];
    void pending.then(buffer => {
      if (!buffer || generation !== soundGenerations[source]) return;
      const sound = new THREE.PositionalAudio(audioListener);
      const active = { sound, source };
      sound.setBuffer(buffer);
      sound.setRefDistance(12);
      sound.setMaxDistance(220);
      sound.setRolloffFactor(1);
      sound.setVolume(volume);
      sound.position.copy(position);
      sound.onEnded = () => { releaseSound(sound); activeSounds.delete(active); };
      root.add(sound);
      activeSounds.add(active);
      sound.play();
    });
  }

  function playPositionalOneShot(level: string, bank: CollisionSoundBank, slot: number,
    position: THREE.Vector3, source: RunSource, volume: number) {
    playBufferOneShot(effectSoundBuffer(level, slot, bank), position, source, volume);
  }

  /** An uploaded WAV's decoded buffer, cached by URL alongside the bank slots. */
  const customSoundBuffer = (file: string): Promise<AudioBuffer | null> => soundBuffer(customSoundUrl(file));

  /** Warm every PlaySound node as soon as its document arrives. Reference nodes address their course bank;
   * authored nodes carry uploaded files, which already have stable project-scoped URLs. */
  function preloadDocumentAudio(document: EffectsDocument | null | undefined, level?: string): void {
    if (!document) return;
    const urls: string[] = [];
    for (const graph of document.graphs)
      for (const node of graph.nodes) {
        if (node.mainType !== 8) continue;
        const file = effectNodeSoundFile(node);
        if (file) { urls.push(customSoundUrl(file)); continue; }
        const slot = node.payload.SoundPlay;
        if (level && typeof slot === 'number' && Number.isFinite(slot))
          urls.push(effectSoundUrl(level, Math.trunc(slot)));
      }
    preloadAudio(urls);
  }

  /** Collision rows are independent of Effects.json, so warm them from the same prop payload that builds the
   * collider rather than hoping an effects document happened to repeat them. */
  function preloadPropAudio(sources: Iterable<PropSoundSource>): void {
    const urls: string[] = [];
    for (const source of sources) {
      if (source.file) { urls.push(customSoundUrl(source.file)); continue; }
      const resolved = resolveCollisionSound(source.event, source.level);
      if (resolved) urls.push(effectSoundUrl(source.level, resolved.slot, resolved.bank));
    }
    preloadAudio(urls);
  }

  /** A PlaySound node fires either an authored WAV or the course-bank slot its payload names. The custom
   *  clip is previewed from its source file: export only picks the slot it will occupy at repack time. */
  function playEffectSound(host: RuntimeHost, node: EffectNode, source: RunSource) {
    const file = effectNodeSoundFile(node);
    if (file) { playBufferOneShot(customSoundBuffer(file), host.position(), source, 0.9); return; }
    const level = host.reference?.data.level;
    const rawSlot = node.payload.SoundPlay;
    if (!level || typeof rawSlot !== 'number' || !Number.isFinite(rawSlot)) return;
    playPositionalOneShot(level, 'course', Math.trunc(rawSlot), host.position(), source, 0.9);
  }

  const selected = new THREE.Group();
  const selectedMat = new THREE.MeshBasicMaterial({ color: 0xb66cff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false });
  const selectedRing = new THREE.Mesh(new THREE.RingGeometry(2.8, 3.35, 32), selectedMat);
  selectedRing.rotation.x = -Math.PI / 2;
  const selectedHalo = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.35, 24), selectedMat.clone());
  selectedHalo.rotation.x = -Math.PI / 2;
  selected.add(selectedRing, selectedHalo);
  selected.traverse(o => { o.raycast = () => {}; });
  selected.visible = false;
  stage.refRoot.add(selected);

  // Boost push arrows ride the same Effects overlay the purple effect-prop outlines do: an outline says the
  // prop carries an effect, the arrow says which way that effect pushes (boost-arrows.ts). Reference-local,
  // so a dragged comparison offset carries them with their props.
  const boostArrowLayer = createBoostArrowLayer(stage.refRoot);
  /** Boost nodes per reference instance, resolved once per data install — the scan walks every graph. */
  let boostArrowCache: { index: number; arrow: BoostArrow }[] | null = null;

  const particleAtlasRows = Math.ceil(PARTICLE_SPRITE_NAMES.length / PARTICLE_ATLAS_COLUMNS);
  const particleAtlasCanvas = document.createElement('canvas');
  particleAtlasCanvas.width = PARTICLE_ATLAS_COLUMNS * PARTICLE_ATLAS_CELL;
  particleAtlasCanvas.height = particleAtlasRows * PARTICLE_ATLAS_CELL;
  const particleAtlasContext = particleAtlasCanvas.getContext('2d');
  // Every slot starts as a soft white point, so a slow/missing native image remains visible instead of making
  // the whole event disappear. Successfully loaded PARTICLE.SSH sprites replace their own cell in place.
  if (particleAtlasContext) for (let index = 0; index < PARTICLE_SPRITE_NAMES.length; index++) {
    const x = (index % PARTICLE_ATLAS_COLUMNS) * PARTICLE_ATLAS_CELL;
    const y = Math.floor(index / PARTICLE_ATLAS_COLUMNS) * PARTICLE_ATLAS_CELL;
    const gradient = particleAtlasContext.createRadialGradient(
      x + 64, y + 64, 4, x + 64, y + 64, 62,
    );
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.82)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    particleAtlasContext.fillStyle = gradient;
    particleAtlasContext.fillRect(x, y, PARTICLE_ATLAS_CELL, PARTICLE_ATLAS_CELL);
  }
  const particleAtlas = new THREE.CanvasTexture(particleAtlasCanvas);
  particleAtlas.colorSpace = THREE.SRGBColorSpace;
  particleAtlas.flipY = false;
  particleAtlas.generateMipmaps = false;
  particleAtlas.minFilter = THREE.LinearFilter;
  particleAtlas.magFilter = THREE.LinearFilter;
  const requestedParticleSprites = new Set<number>();
  function ensureParticleSprite(spriteIndex: number): number {
    const index = Math.max(0, Math.min(PARTICLE_SPRITE_NAMES.length - 1, Math.trunc(spriteIndex)));
    if (requestedParticleSprites.has(index) || !particleAtlasContext) return index;
    requestedParticleSprites.add(index);
    const image = new Image();
    image.onload = () => {
      const x = (index % PARTICLE_ATLAS_COLUMNS) * PARTICLE_ATLAS_CELL;
      const y = Math.floor(index / PARTICLE_ATLAS_COLUMNS) * PARTICLE_ATLAS_CELL;
      const scale = Math.min(PARTICLE_ATLAS_CELL / image.width, PARTICLE_ATLAS_CELL / image.height);
      const width = image.width * scale, height = image.height * scale;
      particleAtlasContext.clearRect(x, y, PARTICLE_ATLAS_CELL, PARTICLE_ATLAS_CELL);
      particleAtlasContext.drawImage(image, x + (PARTICLE_ATLAS_CELL - width) * 0.5,
        y + (PARTICLE_ATLAS_CELL - height) * 0.5, width, height);
      particleAtlas.needsUpdate = true;
    };
    const level = data?.level ? `&level=${encodeURIComponent(data.level)}` : '';
    image.src = `/api/particle-texture?name=${encodeURIComponent(PARTICLE_SPRITE_NAMES[index])}.png${level}`;
    return index;
  }

  const particleBatches = createParticleBatches(particleAtlas, PARTICLE_ATLAS_COLUMNS, particleAtlasRows,
    MAX_PARTICLE_SPRITES);
  const {
    position: positionBuffer, color: colorBuffer, alpha: alphaBuffer,
    size: sizeBuffer, sprite: spriteBuffer,
  } = particleBatches.buffers;
  root.add(particleBatches.additivePoints, particleBatches.alphaPoints);

  let data: ReferenceEffectsData | null = null;
  let authoredDocument: EffectsDocument | null = null;
  let authoredProps: readonly PlacedProp[] = [];
  let inspectVisible = false;
  let worldEffectsEnabled = false;
  let selectedInstance = -1;
  let elapsed = 0;
  let scanElapsed = 0;
  let ambientScanElapsed = 0;
  let playWasRunning = false;
  let activePlayTarget: 'authored' | 'reference' | null = null;
  const riderVelocity = new THREE.Vector3();
  let playMode: RaceMode = 'freeride';
  /** Never reset with a Play run: the authenticated socket session + this monotonic id is the dedupe identity. */
  let nextRideEventId = 1;
  const previewLoops = new Map<string, PersistentEmitter>();
  let previewLoopNext = 0;
  const particles: Particle[] = [];
  const continuousEmitters = new Map<string, ContinuousEmitter>();
  const pulses: Pulse[] = [];
  const scheduled: Scheduled[] = [];
  const inside = new Set<string>();
  const persistentNext = new Map<string, number>();
  const dynamicBodies = new Map<string, DynamicBody>();
  const pieceThrows = new Map<string, PieceThrow>();
  const flexMotions = new Map<string, FlexMotion>();
  const splineMotions = new Map<string, SplineMotion>();
  /** Per-host transient restores. Re-arming the same host replaces its prior due time. */
  const interactionResets = new Map<string, InteractionReset>();
  /** Pickup hosts currently inside Unity's snap-away / hold / grow-back cycle. */
  const pickupPops = new Map<string, { host: RuntimeHost; base: THREE.Matrix4; hitAt: number }>();
  interface SplineInspectorState {
    key: string;
    host: RuntimeHost;
    command: SplineMotionCommand;
    info: ReferenceSplineMotionInfo;
    points: THREE.Vector3[];
    cumulative: number[];
    length: number;
    playhead: THREE.Mesh;
    tangent: THREE.Line;
    basis: THREE.Matrix4;
    engaged: boolean;
  }
  let splineInspector: SplineInspectorState | null = null;
  const previewSceneHosts = new Map<string, RuntimeHost>();
  let previewSceneResetAt = -1;
  let referencePersistentEmitters: PersistentEmitter[] = [];
  let authoredPersistentEmitters: PersistentEmitter[] = [];
  const collisionGraphNext = new Map<string, number>();
  const playCounters = new Map<string, EffectCounterState>();
  /**
   * Counter tracing for Play, where the Effects toolbox cannot be open to watch the inspector's readout —
   * leaving Play tears the runtime down, so the counter is gone by the time the panel is back. Enable with
   * `localStorage['slopesmith:counter-debug'] = '1'`.
   *
   * At `log` rather than `debug` level deliberately: DevTools hides `debug` behind its Verbose filter, so a
   * tracer written that way reads as "the code never ran" to anyone who has not changed that setting — which
   * cost a full test round when this one was first switched on.
   */
  const counterLog = (message: string): void => {
    try {
      if (localStorage.getItem('slopesmith:counter-debug') !== '1') return;
    } catch { /* storage can be unavailable in a privacy-restricted frame; tracing stays optional */ }
    console.log('[Slopesmith counter]', message);
  };
  /**
   * The same opt-in trace the counter path carries, for the OTHER half of the bound-node control family.
   *
   * A MainType-3/9 command is addressed to whatever property node the bound instance is carrying, and the
   * receiver decides what it means [Trailmap: 150-logic §control]. So a command that lands on a prop with no
   * matching receiver is silent by construction — nothing draws, nothing errors — and that is
   * indistinguishable from a command that never arrived. This says which: no line at all means the collision
   * graph never ran, `no receiver` means it ran and found nothing to talk to.
   */
  const controlLog = (message: string): void => {
    try {
      if (localStorage.getItem('slopesmith:control-debug') !== '1') return;
    } catch { /* storage can be unavailable in a privacy-restricted frame; tracing stays optional */ }
    console.log('[Slopesmith control]', message);
  };
  const raw = new THREE.Matrix4();
  const edit = new THREE.Matrix4();
  const combined = new THREE.Matrix4();
  const vectorMatrix = new THREE.Matrix3();
  const drawingBufferSize = new THREE.Vector2();
  const yAxis = new THREE.Vector3(0, 1, 0);
  // Shoved-body solver scratch: this runs per body per frame and must not feed the GC.
  const WORLD_UP_VEC = new THREE.Vector3(0, 1, 0);
  const rigidQuat = new THREE.Quaternion(), rigidAxis = new THREE.Vector3();
  const rigidOffset = new THREE.Vector3(), rigidR = new THREE.Vector3();
  const rigidRxN = new THREE.Vector3(), rigidTmp = new THREE.Vector3(), rigidTmp2 = new THREE.Vector3();
  const rigidContactV = new THREE.Vector3();
  const rigidTmp3 = new THREE.Vector3(), rigidTmp4 = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  function preloadEmitterSprites(document: EffectsDocument | null | undefined) {
    if (!document) return;
    for (const owner of [...document.graphs, ...document.functions]) for (const node of owner.nodes) {
      const law = timerEmitterPreviewLaw(node);
      if (law) ensureParticleSprite(law.spriteIndex);
    }
  }

  function instanceMatrix(instance: ReferenceEffectInstance): THREE.Matrix4 {
    raw.compose(
      pos.set(instance.loc[0], instance.loc[1], instance.loc[2]),
      quat.set(instance.rot[0], instance.rot[1], instance.rot[2], instance.rot[3]),
      scale.set(instance.scale[0], instance.scale[1], instance.scale[2]),
    );
    return edit.multiplyMatrices(RAW_TO_EDITOR, raw);
  }

  function instanceLocalPosition(instance: ReferenceEffectInstance, node?: EffectNode): THREE.Vector3 {
    const fields = node ? particleEmitterFields(node) : null;
    const local = new THREE.Vector3(
      numberField(fields, 'U9', 0), numberField(fields, 'U10', 0), numberField(fields, 'U11', 0),
    );
    return local.applyMatrix4(instanceMatrix(instance));
  }

  function instanceWorldPosition(instance: ReferenceEffectInstance, node?: EffectNode): THREE.Vector3 {
    stage.refRoot.updateWorldMatrix(true, false);
    return instanceLocalPosition(instance, node).applyMatrix4(stage.refRoot.matrixWorld);
  }

  function referenceHost(referenceData: ReferenceEffectsData,
    instance: ReferenceEffectInstance): RuntimeHost {
    return {
      key: `reference:${instance.index}`,
      document: referenceData.document,
      position: node => instanceWorldPosition(instance, node),
      matrix: () => {
        stage.refRoot.updateWorldMatrix(true, false);
        return new THREE.Matrix4().multiplyMatrices(stage.refRoot.matrixWorld, instanceMatrix(instance));
      },
      object: { kind: 'reference', index: instance.index },
      sizeScale: Math.cbrt(Math.abs(instance.scale[0] * instance.scale[1] * instance.scale[2])) || 1,
      vector: value => {
        stage.refRoot.updateWorldMatrix(true, false);
        combined.multiplyMatrices(stage.refRoot.matrixWorld, instanceMatrix(instance));
        vectorMatrix.setFromMatrix4(combined);
        return value.clone().applyMatrix3(vectorMatrix);
      },
      worldVector: value => {
        stage.refRoot.updateWorldMatrix(true, false);
        combined.multiplyMatrices(stage.refRoot.matrixWorld, RAW_TO_EDITOR);
        vectorMatrix.setFromMatrix4(combined);
        return value.clone().applyMatrix3(vectorMatrix);
      },
      worldPoint: value => {
        stage.refRoot.updateWorldMatrix(true, false);
        combined.multiplyMatrices(stage.refRoot.matrixWorld, RAW_TO_EDITOR);
        return value.clone().applyMatrix4(combined);
      },
      reference: { data: referenceData, instance },
    };
  }

  function authoredHost(document: EffectsDocument, prop: PlacedProp): RuntimeHost {
    return {
      key: `authored:${prop.id}`,
      document,
      sizeScale: Math.abs(prop.scale) || 1,
      object: { kind: 'authored', id: prop.id! },
      matrix: () => {
        stage.worldRoot.updateWorldMatrix(true, false);
        raw.compose(
          pos.set(prop.pos[0], prop.pos[1], prop.pos[2]),
          quat.fromArray(placementQuat(prop)),
          scale.setScalar(prop.scale),
        );
        return new THREE.Matrix4().multiplyMatrices(stage.worldRoot.matrixWorld, raw);
      },
      position: node => {
        const point = node ? emitterWorldPosition(node, prop) : prop.pos;
        stage.worldRoot.updateWorldMatrix(true, false);
        return new THREE.Vector3(point?.[0] ?? prop.pos[0], point?.[1] ?? prop.pos[1], point?.[2] ?? prop.pos[2])
          .applyMatrix4(stage.worldRoot.matrixWorld);
      },
      vector: value => {
        stage.worldRoot.updateWorldMatrix(true, false);
        raw.compose(
          pos.set(prop.pos[0], prop.pos[1], prop.pos[2]),
          quat.fromArray(placementQuat(prop)),
          scale.setScalar(prop.scale),
        );
        combined.multiplyMatrices(stage.worldRoot.matrixWorld, raw).multiply(RAW_TO_EDITOR);
        vectorMatrix.setFromMatrix4(combined);
        return value.clone().applyMatrix3(vectorMatrix);
      },
      worldVector: value => {
        stage.worldRoot.updateWorldMatrix(true, false);
        combined.multiplyMatrices(stage.worldRoot.matrixWorld, RAW_TO_EDITOR);
        vectorMatrix.setFromMatrix4(combined);
        return value.clone().applyMatrix3(vectorMatrix);
      },
      worldPoint: value => {
        stage.worldRoot.updateWorldMatrix(true, false);
        combined.multiplyMatrices(stage.worldRoot.matrixWorld, RAW_TO_EDITOR);
        return value.clone().applyMatrix4(combined);
      },
    };
  }

  /** Resolve the stable instance row used by an authored MainType-7/24 node back to the placement the editor
   * owns. Export performs the same placement -> baked instance join later; Test must follow it now, before a
   * native instance index exists, or an authored hop/call appears to work in PCSX2 but is inert while authoring. */
  function authoredHostByInstance(document: EffectsDocument, stableId: string | null | undefined): RuntimeHost | null {
    const instance = stableId ? document.instances.find(candidate => candidate.id === stableId) : null;
    const extension = instance?.extensions?.slopesmith;
    const placement = typeof extension === 'object' && extension !== null && !Array.isArray(extension)
      && typeof extension.placement === 'string' ? extension.placement : null;
    const prop = placement ? authoredProps.find(candidate => candidate.id === placement) : null;
    return prop ? authoredHost(document, prop) : null;
  }

  /** Mode is provenance on a shared event, not a room partition. Check the receiving world's actual object
   * presence instead: common doors, fireworks and breakables cross Race/Showoff, while gems and explicit
   * HideShowOff/HideRace targets cannot be replayed into a mode where they were never instantiated. */
  function hostIsPresentInPlayMode(host: RuntimeHost, mode: RaceMode): boolean {
    const hidden = effectModeHiddenInstanceIds(host.document, mode);
    const hiddenByMode = host.reference
      ? hidden.has(`instance:${host.reference.instance.index}`)
      : [...hidden].some(stableId => authoredHostByInstance(host.document, stableId)?.key === host.key);
    let showoffOnly = false;
    if (host.reference) showoffOnly = nativeInstanceIsShowoffOnly(host.reference.instance);
    else if (host.object.kind === 'authored') {
      const id = host.object.id;
      showoffOnly = authoredProps.find(prop => prop.id === id)?.modePresence === 'showoff';
    }
    return effectHostIsPresentInMode(mode, { showoffOnly, hiddenByMode });
  }

  function calledInstance(host: RuntimeHost, node: EffectNode): { host: RuntimeHost; graph: EffectGraph } | null {
    const graph = node.references?.effectGraph
      ? host.document.graphs.find(item => item.id === node.references!.effectGraph) ?? null : null;
    if (!graph) return null;
    const target = host.reference
      ? referenceInstanceByStableId(host.reference.data, node.references?.instance)
      : null;
    const calledHost = target && host.reference
      ? referenceHost(host.reference.data, target)
      : authoredHostByInstance(host.document, node.references?.instance);
    return calledHost ? { host: calledHost, graph } : null;
  }

  function destinationHost(host: RuntimeHost, stableId: string | null | undefined): RuntimeHost | null {
    const target = host.reference ? referenceInstanceByStableId(host.reference.data, stableId) : null;
    return target && host.reference
      ? referenceHost(host.reference.data, target)
      : authoredHostByInstance(host.document, stableId);
  }

  function rebuildAuthoredCollisionSounds() {
    const sources = new Map<string, PropSoundSource>();
    let document = authoredDocument;
    for (const prop of authoredProps) {
      if (!prop.id || (typeof prop.collisionSound !== 'number' && !prop.collisionSoundFile)) continue;
      // The host's document only feeds graph lookups the sound path never makes; a lazily created empty one
      // keeps sound-only props working on mountains that have no effects document yet.
      document ??= createEmptyEffectsDocument('');
      sources.set(prop.id, {
        key: authoredHost(document, prop).key,
        level: prop.level,
        event: prop.collisionSound ?? -1,
        contact: placedPropContactState(prop, false, true) === 'solid' ? 'solid' : 'through',
        file: prop.collisionSoundFile,
      });
    }
    preloadPropAudio(sources.values());
    propSound.setAuthoredSources(sources);
  }

  function rebuildReferencePersistentEmitters() {
    referencePersistentEmitters = [];
    if (!data) return;
    const emitterGraph = new Map<string, boolean>();
    const graphCanEmit = (graph: EffectGraph) => {
      const cached = emitterGraph.get(graph.id);
      if (cached !== undefined) return cached;
      const result = effectGraphHasTimerEmitter(data!.document, graph);
      emitterGraph.set(graph.id, result);
      return result;
    };
    for (const instance of attachedReferenceInstances(data)) {
      const binding = referenceInstanceBindings(data, instance)
        .find(item => item.circumstance === 'persistent' && graphCanEmit(item.graph));
      if (!binding) continue;
      const host = referenceHost(data, instance);
      referencePersistentEmitters.push({ key: `${host.key}:${binding.graph.id}`, host, graph: binding.graph });
    }
  }

  function rebuildAuthoredPersistentEmitters() {
    authoredPersistentEmitters = [];
    const document = authoredDocument;
    if (!document) return;
    const emitterGraph = new Map<string, boolean>();
    for (const { prop, circumstance, graph } of authoredEffectBindings(document, authoredProps)) {
      if (circumstance !== 'persistent') continue;
      const hasEmitter = emitterGraph.get(graph.id) ?? effectGraphHasTimerEmitter(document, graph);
      emitterGraph.set(graph.id, hasEmitter);
      if (!hasEmitter) continue;
      const host = authoredHost(document, prop);
      authoredPersistentEmitters.push({ key: `${host.key}:${graph.id}`, host, graph });
    }
  }

  function clearAmbientRuntime() {
    for (let i = scheduled.length - 1; i >= 0; i--)
      if (scheduled[i].meta.source === 'ambient') scheduled.splice(i, 1);
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].source === 'ambient') particles.splice(i, 1);
    for (let i = pulses.length - 1; i >= 0; i--) if (pulses[i].source === 'ambient') disposePulse(i);
    for (const [key, emitter] of continuousEmitters) if (emitter.source === 'ambient') continuousEmitters.delete(key);
    clearSplineMotions('ambient');
    persistentNext.clear();
    stopSounds('ambient');
    syncParticles();
  }

  function clearRuntimeSource(source: RunSource) {
    for (let i = scheduled.length - 1; i >= 0; i--)
      if (scheduled[i].meta.source === source) scheduled.splice(i, 1);
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].source === source) particles.splice(i, 1);
    for (let i = pulses.length - 1; i >= 0; i--) if (pulses[i].source === source) disposePulse(i);
    for (const [key, emitter] of continuousEmitters) if (emitter.source === source) continuousEmitters.delete(key);
    clearSplineMotions(source);
    stopSounds(source);
    syncParticles();
  }

  function clearSplineMotions(source: RunSource) {
    for (const [key, motion] of splineMotions) {
      if (motion.source !== source) continue;
      disposeSplineLine(motion);
      if (!splineInspector?.engaged || splineInspector.host.key !== motion.host.key) {
        setHostWorldMatrix(motion.host, null);
        setHostWorldCopies(motion.host, null);
        setHostVisible(motion.host, null);
      }
      splineMotions.delete(key);
    }
  }

  function setHostVisible(host: RuntimeHost, visible: boolean | null) {
    if (host.object.kind === 'reference') hooks.setReferenceInstanceVisible?.(host.object.index, visible);
    else hooks.setAuthoredPropVisible?.(host.object.id, visible);
  }

  function setHostWorldMatrix(host: RuntimeHost, matrix: THREE.Matrix4 | null) {
    if (host.object.kind === 'reference') hooks.setReferenceInstanceWorldMatrix?.(host.object.index, matrix);
    else hooks.setAuthoredPropWorldMatrix?.(host.object.id, matrix);
  }

  function setHostWorldCopies(host: RuntimeHost, matrices: readonly THREE.Matrix4[] | null) {
    if (host.object.kind === 'reference') hooks.setReferenceInstanceWorldCopies?.(host.object.index, matrices);
  }

  /**
   * Gem and speed/trick-pad feedback follows the Unity implementation: snap away immediately, keep the collider
   * retired through the blackout and grow-back, then restore both. A second hit during the cycle restarts it.
   */
  function popPickup(host: RuntimeHost, source: RunSource) {
    if (source !== 'play') return;
    const prior = pickupPops.get(host.key);
    pickupPops.set(host.key, { host, base: prior?.base ?? host.matrix(), hitAt: elapsed });
    setHostVisible(host, false);
    hooks.retireRideObject?.(host.object);
  }

  function stepPickupPops() {
    for (const [key, pop] of pickupPops) {
      const age = elapsed - pop.hitAt;
      if (age >= PICKUP_POP_SECONDS) {
        setHostWorldMatrix(pop.host, null);
        setHostVisible(pop.host, null);
        hooks.restoreRideObject?.(pop.host.object);
        pickupPops.delete(key);
        continue;
      }
      const scale = pickupPopScale(age);
      if (scale <= 0) {
        setHostVisible(pop.host, false);
        continue;
      }
      setHostVisible(pop.host, true);
      setHostWorldMatrix(pop.host, pop.base.clone().scale(new THREE.Vector3(scale, scale, scale)));
    }
  }

  function clearPickupPops() {
    for (const pop of pickupPops.values()) {
      setHostWorldMatrix(pop.host, null);
      setHostVisible(pop.host, null);
      hooks.restoreRideObject?.(pop.host.object);
    }
    pickupPops.clear();
  }

  function setHostPieceMotions(host: RuntimeHost, motions: readonly EffectPieceMotion[] | null) {
    if (host.object.kind === 'reference')
      hooks.setReferenceInstancePieceMotions?.(host.object.index, motions);
    else hooks.setAuthoredPropPieceMotions?.(host.object.id, motions);
  }

  function armInteractionReset(host: RuntimeHost, at: number, kind: InteractionReset['kind']): void {
    if (!Number.isFinite(at)) return;
    const prior = interactionResets.get(host.key);
    interactionResets.set(host.key, {
      host, at,
      kind: prior?.kind === 'breakable' || kind === 'breakable' ? 'breakable' : 'movable',
    });
  }

  /** Restore exactly one interaction-owned host. Mode presence remains authoritative: a timer may repair state,
   * but it cannot instantiate a Showoff-only gem or an explicitly hidden Race/Showoff target. */
  function restoreInteractionHost(reset: InteractionReset): void {
    const { host } = reset;
    dynamicBodies.delete(host.key);
    pieceThrows.delete(host.key);
    flexMotions.delete(host.key);
    const spline = splineMotions.get(host.key);
    if (spline) disposeSplineLine(spline);
    splineMotions.delete(host.key);
    setHostPieceMotions(host, null);
    setHostWorldMatrix(host, null);
    setHostWorldCopies(host, null);
    // A plain Roller only owns the temporary transform above. Breakables also own visibility, renderer
    // receivers and collision retirement, so only their broader reset may touch those independent states.
    if (reset.kind === 'movable') return;
    hooks.resetObjectEffects?.(host.object);
    if (hostIsPresentInPlayMode(host, playMode)) {
      setHostVisible(host, null);
      hooks.restoreRideObject?.(host.object);
    } else {
      setHostVisible(host, false);
      hooks.retireRideObject?.(host.object);
    }
  }

  function stepInteractionResets(): void {
    let expiredBreakableChain = false;
    for (const [key, reset] of interactionResets) {
      if (elapsed < reset.at) continue;
      interactionResets.delete(key);
      if (reset.kind === 'breakable') expiredBreakableChain = true;
      restoreInteractionHost(reset);
    }
    // A long authored Wait must not wake an already-restored breakable later and make it divergent again.
    if (expiredBreakableChain) for (let i = scheduled.length - 1; i >= 0; i--) {
      const deadline = scheduled[i].meta.breakableResetAt;
      if (scheduled[i].meta.source === 'play' && deadline !== null && deadline <= elapsed)
        scheduled.splice(i, 1);
    }
  }

  function markPreviewSceneHost(host: RuntimeHost, holdSeconds: number) {
    previewSceneHosts.set(host.key, host);
    previewSceneResetAt = Math.max(previewSceneResetAt, elapsed + holdSeconds);
  }

  function clearPreviewSceneRuntime() {
    for (const host of previewSceneHosts.values()) {
      dynamicBodies.delete(host.key);
      pieceThrows.delete(host.key);
      setHostPieceMotions(host, null);
      setHostWorldMatrix(host, null);
      setHostWorldCopies(host, null);
      setHostVisible(host, null);
    }
    previewSceneHosts.clear();
    previewSceneResetAt = -1;
  }

  function clearPlayRuntime(resetScene = true) {
    clearRuntimeSource('play');
    // A full scene/data reset also drops ambient or direct-preview movers. Their host transforms are reset by the
    // renderer hook below, but renderer-owned route-line geometry still needs explicit GPU disposal here.
    for (const motion of splineMotions.values()) disposeSplineLine(motion);
    dynamicBodies.clear(); pieceThrows.clear(); flexMotions.clear(); splineMotions.clear(); interactionResets.clear();
    clearPickupPops();
    inside.clear(); scanElapsed = 0;
    collisionGraphNext.clear(); playCounters.clear();
    // Prop audio is permanent within a run but not across one: this is Slopesmith's full audio reset, so a
    // hydrant burst in the last Test starts the next one silent. [Trailmap: 420-interactive-ambient]
    propSound.resetRun();
    if (resetScene) hooks.resetSceneRuntime?.();
  }

  /**
   * Test is over: drop everything the ride's dispatch built — moved bodies, thrown pieces, fence flexes,
   * movers, hidden kills, material control state, counters, debounces — and put the ambient world back.
   *
   * The step loop below already does this when a PLAYER ride ends, and that is where it belongs: the runtime
   * follows the rider. But a rider is not the only thing that dispatches. An AI field runs the same collision
   * graphs — a dropped opponent in Play setup, or a spectated field — and it does so with `riding` false, so
   * the loop never saw a play target to lose. Leaving Test has to say so itself, or a knocked-over prop and a
   * button left lit follow the author back into Edit.
   */
  function resetPlayRuntime(): void {
    clearPlayRuntime();
    installWorldPersistentMotions();
    playWasRunning = false;
    activePlayTarget = null;
  }

  function endPlay(): void { resetPlayRuntime(); }

  /**
   * A Test run is STARTING — the same reset, at the other boundary.
   *
   * It cannot be left to the step loop, which rebuilds only when the play TARGET changes. A field that was
   * spectating or dropped during Play setup has already armed the runtime for that target, so a run started
   * afterwards would inherit whatever it left behind: counters part-marked or spent, props knocked over,
   * buttons lit. Merquer's strike counter makes that obvious — the sign would be flipped before the run
   * began, and the ten cans would have nothing to count.
   *
   * Nothing is installed here. Clearing drops the target too, so the first dispatcher of the new run arms it
   * fresh: the step loop when the player mounts, `ensurePlayRuntime` when a field gets there first.
   */
  function beginPlay(target?: 'authored' | 'reference', mode: RaceMode = 'freeride'): void {
    // This entry point is called synchronously from the desktop/VR Play button. Resume while the browser still
    // recognizes that user gesture; waiting until a collision frame is too late on Quest and leaves every
    // positional one-shot — ordinary prop hits and effect-graph sounds alike — in a suspended AudioContext.
    resumeEffectsAudio();
    if (target === 'reference') preloadDocumentAudio(data?.document, data?.level);
    else if (target === 'authored') preloadDocumentAudio(authoredDocument);
    resetPlayRuntime();
    playMode = mode;
    if (target) ensurePlayRuntime(target);
  }

  /**
   * The engine invokes RaceMode / ShowoffMode / FreerideMode by name on an unowned effect thread. RuntimeHost
   * represents a concrete placement, so borrow one only as the coordinate/document frame for dispatch; the mode
   * functions themselves reach their real recipients through MainType-7 instance calls. Prefer one of those
   * recipients, then fall back to any placement for a function containing only nested calls or rail toggles.
   */
  function schedulePlayMode(target: 'authored' | 'reference', mode: RaceMode): void {
    const document = target === 'reference' ? data?.document : authoredDocument;
    if (!document) return;
    const fn = effectModeFunction(document, mode);
    if (!fn) return;
    const referencedInstance = effectModeNodes(document, mode)
      .map(node => node.references?.instance).find((id): id is string => !!id);
    let host: RuntimeHost | null = null;
    if (target === 'reference' && data) {
      const instance = referenceInstanceByStableId(data, referencedInstance) ?? data.instances[0];
      if (instance) host = referenceHost(data, instance);
    } else {
      host = authoredHostByInstance(document, referencedInstance)
        ?? (authoredProps[0] ? authoredHost(document, authoredProps[0]) : null);
    }
    if (host) scheduleGraph(host, { id: fn.id, name: fn.name, nodes: fn.nodes }, elapsed, 0, 'play');
  }

  /**
   * Apply the instance-presence half of the selected mode immediately. The retail mode leaves call a
   * DeadNodeMode-2 graph on every prop to remove; dispatching that graph alone cannot drive this renderer's
   * explicit visibility override, while the MainType-7 target set says exactly which placed objects it owns.
   * Keep scheduling the full entry point above as well so waits, rail toggles, and any authored side effects
   * retain their normal graph execution.
   */
  function applyPlayModeVisibility(target: 'authored' | 'reference', mode: RaceMode): void {
    const document = target === 'reference' ? data?.document : authoredDocument;
    // LTG GemIndex is the native Showoff object layer that is not enumerated by HideShowOff. It contains the
    // multiplier pickups AND their Gem_RailSupport geometry; retail omits the whole set in Race and Freeride.
    if (target === 'reference' && data && mode !== 'showoff') {
      for (const instance of data.instances) {
        if (!nativeInstanceIsShowoffOnly(instance)) continue;
        const host = referenceHost(data, instance);
        setHostVisible(host, false);
        hooks.retireRideObject?.(host.object);
      }
    }
    // Authored placements expose the same proven layer semantically. This path is independent of Effects:
    // a fresh mountain with no Effects.json must still hide both the model and its ride collider in setup.
    if (target === 'authored' && mode !== 'showoff') {
      const hostDocument = document ?? createEmptyEffectsDocument('');
      for (const prop of authoredProps) {
        if (!prop.id || prop.modePresence !== 'showoff') continue;
        const host = authoredHost(hostDocument, prop);
        setHostVisible(host, false);
        hooks.retireRideObject?.(host.object);
      }
    }
    if (!document) return;
    for (const stableId of effectModeHiddenInstanceIds(document, mode)) {
      let host: RuntimeHost | null = null;
      if (target === 'reference' && data) {
        const instance = referenceInstanceByStableId(data, stableId);
        if (instance) host = referenceHost(data, instance);
      } else host = authoredHostByInstance(document, stableId);
      if (!host) continue;
      setHostVisible(host, false);
      hooks.retireRideObject?.(host.object);
    }
  }

  /** Rail resource keys whose MainType-25 candidacy is cleared by this level's selected mode function. */
  function modeDisabledRails(target: 'authored' | 'reference', mode: RaceMode): Set<number | string> {
    const document = target === 'reference' ? data?.document : authoredDocument;
    if (!document) return new Set();
    const ids = effectModeDisabledSplineIds(document, mode);
    const out = new Set<number | string>();
    for (const spline of document.splines) {
      if (!ids.has(spline.id)) continue;
      if (target === 'reference') {
        if (typeof spline.originalIndex === 'number') out.add(spline.originalIndex);
      } else if (spline.id.startsWith('spline:')) out.add(spline.id.slice('spline:'.length));
    }
    return out;
  }

  /**
   * Arm the Play runtime for a target that has started dispatching, and the setup half of the asymmetry
   * `endPlay` describes above.
   *
   * The step loop mounts the runtime only under `playTarget && riderWorld`, and the host passes both only
   * while the PLAYER is on a board. An AI-only field — spectated, or dropped by hand in Play setup — never
   * satisfies that, yet its contacts run collision graphs through `propCollision` all the same, whose own
   * guard passes freely while `activePlayTarget` is null. So those graphs ran against a runtime in which
   * nothing persistent had ever been installed: no Counters, no movers, no property receivers. Merquer's
   * strike counter is how it surfaced — all ten cans delivered their mark and every one of them landed on a
   * counter that was never built.
   */
  function ensurePlayRuntime(target: 'authored' | 'reference'): void {
    if (activePlayTarget === target) return;
    clearPlayRuntime();
    activePlayTarget = target;
    installPlayPersistent(target);
    applyPlayModeVisibility(target, playMode);
    schedulePlayMode(target, playMode);
  }

  function setData(next: ReferenceEffectsData | null) {
    // Entering Test intentionally does not block on the reference's Effects.json. Remember that Test already
    // owns this target so the selected mode can be installed once the late data arrives instead of leaving the
    // setup world in its ungated import state until a ride is launched.
    const resumePlay = activePlayTarget === 'reference' && next !== null;
    hideSplineInspector();
    clearPlayRuntime();
    activePlayTarget = null; playWasRunning = false;
    data = next;
    preloadDocumentAudio(next?.document, next?.level);
    selectedInstance = -1;
    selected.visible = false;
    // A reference swap invalidates every scheduled host closure. Manual / Play previews are reference-only,
    // so clear those too; authored ambient candidates are rebuilt separately and resume on the next scan.
    scheduled.length = 0;
    particles.length = 0;
    continuousEmitters.clear();
    clearPulses();
    previewLoops.clear();
    stopSounds();
    previewSceneHosts.clear(); previewSceneResetAt = -1;
    inside.clear();
    persistentNext.clear();
    preloadEmitterSprites(next?.document);
    rebuildReferencePersistentEmitters();
    if (resumePlay) ensurePlayRuntime('reference');
    installWorldPersistentMotions();
    syncParticles();
    boostArrowCache = null;
    refreshBoostArrows();
  }

  function setAuthoredData(props: readonly PlacedProp[], document: EffectsDocument | null | undefined) {
    const resumePlay = activePlayTarget === 'authored' && document != null;
    if (activePlayTarget === 'authored') { clearPlayRuntime(); activePlayTarget = null; playWasRunning = false; }
    authoredProps = props;
    authoredDocument = document ?? null;
    preloadDocumentAudio(authoredDocument);
    preloadEmitterSprites(authoredDocument);
    clearAmbientRuntime();
    rebuildAuthoredPersistentEmitters();
    rebuildAuthoredCollisionSounds();
    if (resumePlay) ensurePlayRuntime('authored');
    installWorldPersistentMotions();
  }

  function setWorldEffectsEnabled(on: boolean) {
    worldEffectsEnabled = on;
    ambientScanElapsed = AMBIENT_SCAN_SECONDS; // turning on produces feedback on the next animation frame
    if (on) installWorldPersistentMotions();
    else clearAmbientRuntime();
  }

  function setInspecting(on: boolean) {
    inspectVisible = on;
    selected.visible = on && selectedInstance >= 0;
    refreshBoostArrows();
  }

  function selectInstance(index: number | null) {
    selectedInstance = index ?? -1;
    const instance = data?.instances.find(x => x.index === selectedInstance);
    refreshBoostArrows();
    if (!instance) { selected.visible = false; return; }
    selected.position.copy(instanceLocalPosition(instance));
    selected.visible = inspectVisible;
  }

  function graphById(graphId: string): EffectGraph | null {
    return data?.document.graphs.find(x => x.id === graphId) ?? null;
  }

  /** Identify a Unity BreakableLogoU-style interaction from its graph rather than from the transport kind:
   * collision events also carry doors, buttons and boosts. Calls are followed so an intact prop's roll clip and
   * its called shard/tombstone graph share one twelve-second restore cycle. */
  function graphHasBreakableAction(host: RuntimeHost, graph: EffectGraph, seen = new Set<string>()): boolean {
    const visitKey = `${host.key}:${graph.id}`;
    if (seen.has(visitKey)) return false;
    seen.add(visitKey);
    for (const node of graph.nodes) {
      const command = effectPlayCommand(node);
      if (command?.kind === 'instance-hide' || command?.kind === 'mesh-throw'
        || crackedBreakTombstonesCollider(node)) return true;
      if (node.mainType === 7) {
        const called = calledInstance(host, node);
        if (called && graphHasBreakableAction(called.host, called.graph, seen)) return true;
      }
      if ((node.mainType === 21 || node.mainType === 26) && node.references?.function) {
        const fn = host.document.functions.find(candidate => candidate.id === node.references!.function);
        if (fn && graphHasBreakableAction(host, { id: fn.id, name: fn.name, nodes: fn.nodes }, seen)) return true;
      }
    }
    return false;
  }

  function scheduleGraph(host: RuntimeHost, graph: EffectGraph, startAt = elapsed, depth = 0,
    source: RunSource = 'preview', continuous = false, subject: RunSubject = null,
    cause: RunCause = 'ordinary', rideEvent: RideEvent | null = null,
    inheritedBreakableResetAt: number | null | undefined = undefined,
    collisionContact: CollisionEmitterContact | null = null) {
    if (depth > MAX_GRAPH_DEPTH) return;
    const breakableResetAt = inheritedBreakableResetAt !== undefined ? inheritedBreakableResetAt
      : source === 'play' && (cause === 'cracked-break' || graphHasBreakableAction(host, graph))
        ? startAt + BREAKABLE_RESPAWN_SECONDS : null;
    scheduleEffectGraph(scheduled, host, graph, startAt, depth,
      { source, continuous, subject, cause, rideEvent, collisionContact, breakableResetAt });
  }

  /** Stable per event/node sample, so a probability condition takes the same branch on every participant. */
  function rideEventRandom(event: RideEvent, node: EffectNode): number {
    const text = `${event.id}:${event.key}:${node.id}`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    return (hash >>> 0) / 0x1_0000_0000;
  }

  function conditionPass(host: RuntimeHost, node: EffectNode, event: RideEvent | null): boolean {
    return effectConditionPasses(node, {
      riderSpeed: event?.riderSpeed ?? riderVelocity.length(),
      ...(event ? { random: () => rideEventRandom(event, node) } : {}),
      humanRider: true,
      hostIdle: !dynamicBodies.has(host.key) && !pieceThrows.has(host.key)
        && !flexMotions.has(host.key) && !splineMotions.has(host.key),
    });
  }

  function executeNode(host: RuntimeHost, node: EffectNode, depth: number, source: RunSource,
    continuous: boolean, subject: RunSubject = null, cause: RunCause = 'ordinary',
    rideEvent: RideEvent | null = null, breakableResetAt: number | null = null,
    collisionContact: CollisionEmitterContact | null = null) {
    if (source === 'play' && breakableResetAt !== null)
      armInteractionReset(host, breakableResetAt, 'breakable');
    if (source === 'play' && cause === 'cracked-break' && crackedBreakTombstonesCollider(node))
      hooks.retireRideObject?.(host.object);
    if (node.mainType === 2 && particleEmitterFields(node)) {
      spawnEmitter(host, node, source, continuous, collisionContact); return;
    }
    if (node.mainType === 8) {
      if (!continuous && source !== 'ambient') playEffectSound(host, node, source);
      return;
    }
    if (node.mainType === 7) {
      const called = calledInstance(host, node);
      if (called && (subject !== 'remote' || hostIsPresentInPlayMode(called.host, playMode)))
        scheduleGraph(called.host, called.graph, elapsed, depth + 1, source, continuous,
          subject, cause, rideEvent, breakableResetAt, collisionContact);
      else if (source === 'preview') spawnPulse(host.position(), 0x9a6bff, 0.9, source);
      return;
    }
    if ((node.mainType === 21 || node.mainType === 26) && node.references?.function) {
      const fn = host.document.functions.find(x => x.id === node.references!.function);
      if (fn) scheduleGraph(host, { id: fn.id, name: fn.name, nodes: fn.nodes }, elapsed, depth + 1, source,
        continuous, subject, cause, rideEvent, breakableResetAt, collisionContact);
      return;
    }
    if (source === 'play') {
      // A Counter reached here rather than through the Play-start installer — a persistent graph that also
      // carries an emitter, say. Seed it only if it is not already installed: re-running the graph must not
      // wipe the inputs already ticked off.
      const install = effectCounterInstall(node);
      if (install !== null && !playCounters.has(host.key)) {
        playCounters.set(host.key, newEffectCounter(install));
        counterLog(`${host.key} installed late from a scheduled graph · needs ${install}`);
      }
      if (isEffectCounterInput(node)) {
        // No counter on this prop means nothing to count down and nothing to fire. Reading a missing counter
        // as zero-remaining ran the trigger column on the FIRST mark, which is how Merquer's strike sign lit
        // on one garbage can instead of ten.
        const state = playCounters.get(host.key);
        const input = effectCounterMarkInput(node);
        if (!state) {
          counterLog(`${host.key} ${input === null ? 'decrement' : `input ${input}`} arrived with NO counter `
            + 'installed — nothing counted, nothing fired');
        } else {
          const before = state.remaining;
          const fired = applyEffectCounterInput(state, node);
          counterLog(`${host.key} ${input === null ? 'decrement' : `input ${input}`}`
            + `${state.remaining === before ? ' ALREADY MARKED (no change)' : ''}`
            + ` · ${state.remaining} to go · marked [${[...state.marked].sort((a, b) => a - b).join(',')}]`);
          if (fired) {
            // Reaching zero fires the trigger column and retires the counter.
            playCounters.delete(host.key);
            const trigger = playBindings(host.reference ? 'reference' : 'authored').find(binding =>
              binding.circumstance === 'trigger' && runtimeObjectKey(binding.host.object) === host.key);
            counterLog(`${host.key} REACHED ZERO · ${trigger
              ? `firing trigger column ${trigger.graph.id} (${trigger.graph.nodes.length} nodes)`
              : 'but this prop has NO trigger effect bound — nothing to fire'}`);
            if (trigger) scheduleGraph(trigger.host, trigger.graph, elapsed, depth + 1, source, false, subject,
              cause, rideEvent, breakableResetAt ?? undefined, collisionContact);
          }
        }
      }
    }
    // A combo node's PERSISTENT behaviour is its idle window, which is an ordinary model clip; the reaction
    // belongs to the trigger command, not to this node. So Preview runs the idle half and nothing else, the
    // same split Model clip (budgeted) and Grant clip budget already have.
    const animObject = animObjectFromNode(node) ?? animComboFromNode(node);
    if (animObject && (source === 'preview' || source === 'play')) {
      // Unity holds an ordinary triggered prop at its far pose for eight seconds, then runs it backward to rest.
      // Break-owned animation is different: its enclosing BreakableLogo restore rewinds it at twelve seconds.
      const autoReturnDelay = source === 'play' && breakableResetAt === null
        ? ANIMATED_PROP_AUTO_RESET_SECONDS : null;
      if (!hooks.previewAnimObject?.(host.object, animObject, autoReturnDelay) && source === 'preview')
        spawnPulse(host.position(), 0xb66cff, 0.9, source);
      return;
    }
    // A material property is a render-layer clock rather than an action to dispatch, so Preview runs it by
    // ungating the host's own material — the law the renderer already built from this node. Test and the
    // ambient toggle keep their existing owners; this is the manual Preview's half of the same wiring the
    // model clip above has, and without it a UV scroll answers ▶ Preview effect with nothing but a ring.
    if (source === 'preview' && materialWorldEffectsFromNode(node)) {
      if (!hooks.previewMaterialEffect?.(host.object)) spawnPulse(host.position(), 0xb66cff, 0.9, source);
      return;
    }
    const playCommand = effectPlayCommand(node);
    const previewVisual = source === 'preview' && playCommand
      && (playCommand.kind === 'instance-hide' || playCommand.kind === 'mesh-throw'
        || playCommand.kind === 'roller' || playCommand.kind === 'spline-motion');
    // A bound-node command is addressed to whatever material property is installed on the host, and Preview
    // may run one exactly when the scene can put that material back afterwards. Two ways it can: a one-shot
    // flip expires on its own — a megaplex button's red flash — and any other receiver is rested by Stop once
    // Preview owns it, which is what claiming it here arranges. Merqury City's strike sign is the second
    // case: its receiver is a phase-only UV scroll, and the phase this writes is the whole visible effect.
    const previewControl = source === 'preview' && playCommand?.kind === 'property-control'
      && (!!hooks.hasPulseProperty?.(host.object) || !!hooks.previewMaterialEffect?.(host.object)
        || (playCommand.command === 3 && !!hooks.hasTriggerableCombo?.(host.object)));
    if (playCommand && (source === 'play' || previewVisual || previewControl)) {
      if (previewVisual) markPreviewSceneHost(host,
        playCommand.kind === 'mesh-throw' ? Math.max(0.6, playCommand.duration + 0.35)
          : playCommand.kind === 'roller' ? ROLLER_PREVIEW_SECONDS
            : playCommand.kind === 'spline-motion' ? Number.POSITIVE_INFINITY : 3);
      executePlayCommand(host, playCommand, source, subject, breakableResetAt);
      return;
    }
    // Rings are editor diagnostics for manual Preview. Play and ambient execution should show only
    // visuals we can actually approximate, rather than exposing effect-node markers in the world.
    if (source !== 'preview') return;
    const color = node.mainType === 17 ? 0x5bd6ff : node.mainType === 18 ? 0xffc24a
      : node.mainType === 8 || node.mainType === 16 ? 0xff66be : 0xb66cff;
    spawnPulse(host.position(), color, 0.9, source);
  }

  function executePlayCommand(host: RuntimeHost, command: EffectPlayCommand, source: RunSource,
    subject: RunSubject = null, breakableResetAt: number | null = null) {
    const localSubject = localRideEffectSubject(subject);
    switch (command.kind) {
      case 'rider-reset':
        if (localSubject !== undefined) hooks.applyRideEffect?.({ kind: 'reset' }, localSubject); return;
      case 'hud-message':
        if (localSubject !== undefined) hooks.applyRideEffect?.({ kind: 'hud-message', text: command.text,
          color: command.color, durationSeconds: command.durationSeconds }, localSubject); return;
      case 'score-multiplier':
        popPickup(host, source);
        if (localSubject !== undefined) hooks.applyRideEffect?.({ kind: 'score-multiplier',
          multiplier: command.multiplier }, localSubject); return;
      case 'speed-boost':
        popPickup(host, source);
        if (localSubject !== undefined) hooks.applyRideEffect?.({ kind: 'speed-boost',
          amount: command.amount }, localSubject); return;
      case 'trick-boost':
        popPickup(host, source);
        if (localSubject !== undefined) hooks.applyRideEffect?.({ kind: 'trick-boost',
          seconds: command.seconds }, localSubject); return;
      case 'directional-boost':
        // NOTHING, and that is the whole of how a boost node reaches the rider correctly.
        //
        // The MainType-0 boost family is CONTAINMENT-driven: the engine re-tests which riders are inside the
        // volume every tick and pushes each of them once per tick ([Trailmap: 360-node-apply]). That is what
        // `boostVolumeSpecs` below hands the ride, and what `ride/boost-volumes.ts` runs. A collision
        // dispatch cannot express it — this runtime rate-limits a chain to one firing per debounce interval,
        // so the only way to deliver a whole interval's push from here is to integrate the lag in closed form
        // and apply the result in a single frame.
        //
        // Which is what it used to do, and the magnitude says why it cannot: over a 50/60 s debounce a rate-3
        // node reaches `1 - e^(-3 x 0.833)` = 92% of its target in one tick. On Megaplex's own exhaust vent
        // (rate 3, target 100 m/s, straight up) that is a 91 m/s launch from a node measured on PS2 at 13.6
        // to 21.5 m/s, and it landed ON TOP OF the per-tick push rather than instead of it, because every
        // host that gets a volume also runs its collision graph. Measured both ways in `tools/ride-study/boost-throw.ts`.
        //
        // The command itself stays: it describes the node's authored data, which is what the effects editor
        // reads it for. What it must not be is a second way to move the rider.
        return;
      case 'property-control': {
        const taken = hooks.controlProperty?.(host.object, command.command, command.value) ?? false;
        controlLog(`${host.key} command ${command.command} value ${command.value} (${source})`
          + ` · ${taken ? 'delivered' : 'NO RECEIVER on this prop — nothing took it'}`);
        return;
      }
      case 'teleport': {
        if (localSubject === undefined) return;
        const target = destinationHost(host, command.instance);
        if (!target) return;
        const destination = target.position();
        const heading = destination.clone().sub(host.position()).setY(0);
        if (heading.lengthSq() < 1e-6) heading.set(0, 0, 1); else heading.normalize();
        hooks.applyRideEffect?.({ kind: 'teleport',
          position: destination.add(new THREE.Vector3(0, 0.5, 0)), heading }, localSubject);
        return;
      }
      case 'instance-hide':
        setHostVisible(host, false);
        if (source === 'play') hooks.retireRideObject?.(host.object);
        return;
      case 'roller':
        if (source === 'play' && breakableResetAt === null)
          armInteractionReset(host, elapsed + MOVABLE_PROP_RESPAWN_SECONDS, 'movable');
        startRoller(host, command, source);
        return;
      case 'mesh-throw': startMeshThrow(host, command); return;
      case 'fence-flex': startFenceFlex(host, command.amount); return;
      case 'flag-wave': startFlagWave(host, command.amplitude, command.wavelength); return;
      case 'spline-motion': startSplineMotion(host, command, source); return;
    }
  }

  function motionBasis(host: RuntimeHost) {
    const matrix = host.matrix();
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    const basis = matrix.clone(); basis.setPosition(0, 0, 0);
    return { matrix, position, basis };
  }

  function startRoller(host: RuntimeHost, command: Extract<EffectPlayCommand, { kind: 'roller' }>,
    source: RunSource) {
    let direction = new THREE.Vector3(...command.direction);
    const authoredDirection = direction.lengthSq() > 1e-8;
    if (authoredDirection) direction = host.vector(direction).normalize();
    else direction = host.vector(new THREE.Vector3(0, 1, 0)).normalize();
    const speed = authoredDirection ? 10 : Math.min(6, 50 / command.mass + 1);

    /**
     * A Roller-activated instance's collision slot authors exactly this node — the GARI crash bags are slot 47 →
     * effect 107, a lone Roller (mass 5, direction 0/0/0) — so the hit that ran the rigid-body shove ALSO
     * schedules this command against the same host one frame later. Retail runs BOTH: the boarder impulse and
     * the Roller launch. The Roller's contribution matters experientially — its up-kick is what vaults a struck
     * bag out of the rider's corridor. Without it the bag leaves along the rider's own travel at close to the
     * rider's own speed (a captured hit: bag 13.5 m/s vs rider 12.9), paces the run for a second and gets ridden
     * through. So the launch MERGES into the flying body rather than replacing it: replacement re-seated the bag
     * at its authored transform and hopped it in place, and suppression kept it underfoot. An asleep or visual
     * body is left alone — re-seating a settled prop at its origin is the one wrong answer — and a standalone
     * Roller with no body in flight (fire-hydrant lids, scripted knock-offs) behaves as it always has.
     */
    const existing = dynamicBodies.get(host.key);
    if (existing) {
      if ((source === 'preview' || existing.invInertia && existing.angular) && !existing.asleep)
        existing.velocity.addScaledVector(direction, speed);
      return;
    }

    setHostVisible(host, true);
    const { matrix, position, basis } = motionBasis(host);
    if (source === 'preview') {
      // Preview stands in for a rider collision without adding UI or a fake projectile: one fixed-strength
      // horizontal hit from a fresh direction on every click, plus the Roller node's own launch vector.
      const impact = new THREE.Vector3(...rollerPreviewImpact());
      const velocity = impact.clone().addScaledVector(direction, speed);
      const spinAxis = new THREE.Vector3().crossVectors(yAxis, impact).normalize();
      dynamicBodies.set(host.key, {
        key: host.key, host, matrix, basis, position, velocity, spinAxis, spin: 6,
        rotation: new THREE.Quaternion(), age: 0, duration: ROLLER_PREVIEW_SECONDS, hideOnEnd: false,
      });
      return;
    }
    dynamicBodies.set(host.key, {
      key: host.key, host, matrix, basis, position, velocity: direction.multiplyScalar(speed),
      spinAxis: new THREE.Vector3(0.7, 0.25, 0.5).normalize(), spin: authoredDirection ? 6 : 3,
      rotation: new THREE.Quaternion(), age: 0, duration: 10, hideOnEnd: false,
    });
  }

  function startMeshThrow(host: RuntimeHost, command: Extract<EffectPlayCommand, { kind: 'mesh-throw' }>) {
    const { matrix, position, basis } = motionBasis(host);
    let direction = new THREE.Vector3(...command.direction);
    if (direction.lengthSq() > 1e-8) direction = host.vector(direction).normalize();
    else if (riderVelocity.lengthSq() > 1e-8) direction.copy(riderVelocity).normalize();
    else direction.set(0, 1, 0);
    const velocityScale = new THREE.Vector3(...command.velocityScale).multiplyScalar(0.01);
    const velocity = new THREE.Vector3(
      direction.x * velocityScale.x, direction.y * velocityScale.y, direction.z * velocityScale.z,
    ).multiplyScalar(command.directionScale || 1);
    if (velocity.lengthSq() < 0.25) velocity.copy(direction).multiplyScalar(7).add(new THREE.Vector3(0, 4, 0));
    if (velocity.length() > 60) velocity.setLength(60);
    setHostVisible(host, true);
    const pieceIds = host.object.kind === 'reference'
      ? hooks.referenceInstancePieceIds?.(host.object.index) ?? []
      : hooks.authoredPropPieceIds?.(host.object.id) ?? [];
    if (pieceIds.length > 1) {
      const seedBase = host.object.kind === 'reference' ? host.object.index + 1 : 1;
      const spread = THREE.MathUtils.clamp(velocity.length() * 0.45, 2.5, 9);
      const pieces = pieceIds.map(piece => {
        // Deterministic variation keeps previews repeatable while still breaking the model into visibly independent
        // trajectories. The authored velocity remains the common impulse and the fan/spin approximate native debris.
        const random = mulberry32(Math.imul(seedBase, 0x9e3779b1) ^ Math.imul(piece + 1, 0x85ebca6b));
        const fan = randomUnitVector(random).multiplyScalar(spread * (0.45 + random() * 0.75));
        fan.y += spread * (0.2 + random() * 0.45);
        const pieceVelocity = velocity.clone().multiplyScalar(0.72 + random() * 0.55).add(fan);
        if (pieceVelocity.length() > 60) pieceVelocity.setLength(60);
        return {
          piece,
          offset: new THREE.Vector3(),
          rotation: new THREE.Quaternion(),
          velocity: pieceVelocity,
          spinAxis: randomUnitVector(random),
          spin: (2.5 + random() * 6.5) * (random() < 0.5 ? -1 : 1),
        };
      });
      pieceThrows.set(host.key, {
        key: host.key, host, pieces, age: 0, duration: Math.max(0.2, command.duration),
      });
      setHostPieceMotions(host, pieces);
      return;
    }
    dynamicBodies.set(host.key, {
      key: host.key, host, matrix, basis, position, velocity,
      spinAxis: new THREE.Vector3(0.35, 0.8, 0.45).normalize(), spin: 5,
      rotation: new THREE.Quaternion(), age: 0, duration: Math.max(0.2, command.duration), hideOnEnd: true,
    });
  }

  function flexMotion(host: RuntimeHost, kind: 'flag' | 'fence', amplitude: number): FlexMotion {
    const prior = flexMotions.get(host.key);
    if (prior) return prior;
    const { matrix, position, basis } = motionBasis(host);
    const motion = { key: host.key, host, matrix, basis, position, amplitude, phase: 0, velocity: 0, kind };
    flexMotions.set(host.key, motion);
    return motion;
  }

  function startFenceFlex(host: RuntimeHost, amount: number) {
    const motion = flexMotion(host, 'fence', THREE.MathUtils.clamp(amount * 0.002, 0.04, 0.22));
    motion.velocity = Math.max(motion.velocity, 4.5);
  }

  function startFlagWave(host: RuntimeHost, amplitude: number, wavelength: number) {
    const motion = flexMotion(host, 'flag', THREE.MathUtils.clamp(Math.abs(amplitude) * 0.002, 0.025, 0.16));
    motion.velocity = Math.max(1.2, Math.min(5, Math.abs(wavelength) * 0.01));
  }

  function splineWorldControls(segment: number[][], space: EffectSplinePath['space']): THREE.Vector3[] {
    const root = space === 'raw' ? stage.refRoot : stage.worldRoot;
    return segment.map(point => {
      const e = space === 'raw' ? editorFromRaw(point) : point;
      return new THREE.Vector3(e[0], e[1], e[2]).applyMatrix4(root.matrixWorld);
    });
  }

  function splineSamples(spline: EffectSplinePath): {
    points: THREE.Vector3[]; cumulative: number[]; length: number; segmentDistances: number[];
  } | null {
    (spline.space === 'raw' ? stage.refRoot : stage.worldRoot).updateWorldMatrix(true, false);
    const points: THREE.Vector3[] = [];
    const boundaryIndices: number[] = [];
    for (const segment of spline.segments) {
      if (segment.length !== 4) continue;
      const controls = splineWorldControls(segment, spline.space);
      const curve = new THREE.CubicBezierCurve3(controls[0], controls[1], controls[2], controls[3]);
      if (!boundaryIndices.length) boundaryIndices.push(points.length);
      for (let i = points.length ? 1 : 0; i <= 16; i++) points.push(curve.getPoint(i / 16));
      boundaryIndices.push(points.length - 1);
    }
    if (points.length < 2) return null;
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + points[i].distanceTo(points[i - 1]));
    return {
      points, cumulative, length: cumulative.at(-1) ?? 0,
      segmentDistances: boundaryIndices.map(index => cumulative[index] ?? 0),
    };
  }

  /** The specified spline mover can draw its route as an untextured one-pixel line. It emits ten cubic samples
   * per segment (nine straight pairs); LineSegments keeps discontinuous/malformed cubics from inventing a join. */
  function splineLinePoints(spline: EffectSplinePath): THREE.Vector3[] {
    (spline.space === 'raw' ? stage.refRoot : stage.worldRoot).updateWorldMatrix(true, false);
    const points: THREE.Vector3[] = [];
    for (const segment of spline.segments) {
      if (segment.length !== 4) continue;
      const controls = splineWorldControls(segment, spline.space);
      const curve = new THREE.CubicBezierCurve3(controls[0], controls[1], controls[2], controls[3]);
      let previous = curve.getPoint(0);
      for (let i = 1; i <= 9; i++) {
        const current = curve.getPoint(i / 9);
        points.push(previous, current);
        previous = current;
      }
    }
    return points;
  }

  function createSplineLine(spline: EffectSplinePath, command: SplineMotionCommand): THREE.LineSegments | null {
    if (!command.splineLine.enabled) return null;
    const alpha = THREE.MathUtils.clamp(command.splineLine.color[3], 0, 1);
    if (alpha <= 0) return null;
    const points = splineLinePoints(spline);
    if (points.length < 2) return null;
    const color = new THREE.Color().setRGB(
      THREE.MathUtils.clamp(command.splineLine.color[0], 0, 1),
      THREE.MathUtils.clamp(command.splineLine.color[1], 0, 1),
      THREE.MathUtils.clamp(command.splineLine.color[2], 0, 1),
      THREE.SRGBColorSpace,
    );
    const material = new THREE.LineBasicMaterial({
      color, opacity: alpha, transparent: alpha < 1, depthTest: true, depthWrite: alpha >= 1, toneMapped: false,
    });
    const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(points), material);
    line.name = `Spline route line ${command.spline ?? ''}`.trim();
    line.raycast = () => {};
    root.add(line);
    return line;
  }

  function disposeSplineLine(motion: SplineMotion) {
    if (!motion.splineLine) return;
    root.remove(motion.splineLine);
    motion.splineLine.geometry.dispose();
    (motion.splineLine.material as THREE.Material).dispose();
    motion.splineLine = null;
  }

  function clearSplineInspectorGeometry() {
    for (const child of [...splineInspectGroup.children]) child.traverse(object => {
      if (object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Mesh)
        object.geometry.dispose();
    });
    splineInspectGroup.clear();
  }

  function hideSplineInspector(): boolean {
    const had = splineInspector !== null;
    if (splineInspector?.engaged) {
      setHostWorldMatrix(splineInspector.host, null);
      setHostWorldCopies(splineInspector.host, null);
      if (![...splineMotions.values()].some(motion => motion.host.key === splineInspector!.host.key))
        setHostVisible(splineInspector.host, null);
    }
    splineInspector = null;
    clearSplineInspectorGeometry();
    splineInspectGroup.visible = false;
    return had;
  }

  function showSplineInspector(sourceIndex: number, command: SplineMotionCommand): ReferenceSplineMotionInfo | null {
    if (!data || !command.spline) return null;
    const key = `${sourceIndex}:${command.spline}:${command.endMode}:${command.orientationMode}:${command.speed}:${command.yawOffset}`;
    if (splineInspector?.key === key) return splineInspector.info;
    hideSplineInspector();
    const instance = data.instances.find(candidate => candidate.index === sourceIndex);
    const spline = hooks.resolveSpline?.({ kind: 'reference', index: sourceIndex }, command.spline);
    const sampled = spline ? splineSamples(spline) : null;
    if (!instance || !spline || !sampled || sampled.length <= 0) return null;
    const host = referenceHost(data, instance);
    const { basis } = motionBasis(host);
    const curve = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sampled.points), splineInspectCurveMat);
    curve.frustumCulled = false; curve.renderOrder = 994;
    splineInspectGroup.add(curve);

    const handles: THREE.Vector3[] = [];
    const boundaries: THREE.Vector3[] = [];
    (spline.space === 'raw' ? stage.refRoot : stage.worldRoot).updateWorldMatrix(true, false);
    for (const [index, segment] of spline.segments.entries()) {
      if (segment.length !== 4) continue;
      const controls = splineWorldControls(segment, spline.space);
      handles.push(controls[0], controls[1], controls[2], controls[3]);
      if (index === 0) boundaries.push(controls[0]);
      boundaries.push(controls[3]);
    }
    if (handles.length) {
      const handleLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(handles), splineInspectHandleMat);
      handleLines.frustumCulled = false; handleLines.renderOrder = 993;
      splineInspectGroup.add(handleLines);
    }
    if (boundaries.length) {
      const keys = new THREE.Points(new THREE.BufferGeometry().setFromPoints(boundaries), splineInspectKeyMat);
      keys.frustumCulled = false; keys.renderOrder = 995;
      splineInspectGroup.add(keys);
    }
    const playhead = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 7), splineInspectPlayheadMat);
    playhead.renderOrder = 997;
    const tangent = new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(0, 0, 1),
    ]), splineInspectTangentMat);
    tangent.frustumCulled = false; tangent.renderOrder = 996;
    splineInspectGroup.add(playhead, tangent);
    const info: ReferenceSplineMotionInfo = {
      splineId: command.spline,
      originalIndex: spline.originalIndex,
      style: spline.style,
      segments: spline.segments.length,
      length: sampled.length,
      segmentDistances: sampled.segmentDistances,
    };
    splineInspector = {
      key, host, command, info, basis,
      points: sampled.points, cumulative: sampled.cumulative, length: sampled.length,
      playhead, tangent, engaged: false,
    };
    splineInspectGroup.visible = true;
    updateSplineInspectorPose(splineInspector, 0);
    return info;
  }

  function updateSplineInspectorPose(inspector: SplineInspectorState, distance: number) {
    const direction = inspector.command.speed < 0 ? -1 : 1;
    const { position, travelTangent } = sampleSplinePath(
      inspector.points, inspector.cumulative, inspector.length, distance, direction);
    inspector.playhead.position.copy(position);
    const tangentEnd = position.clone().addScaledVector(travelTangent, 6);
    inspector.tangent.geometry.setFromPoints([position, tangentEnd]);
    inspector.tangent.geometry.attributes.position.needsUpdate = true;
  }

  function setSplineInspectorDistance(sourceIndex: number, command: SplineMotionCommand,
    distance: number | null): boolean {
    if (distance === null) {
      if (!splineInspector || splineInspector.host.object.kind !== 'reference'
        || splineInspector.host.object.index !== sourceIndex) return false;
      if (splineInspector.engaged) {
        setHostWorldMatrix(splineInspector.host, null);
        setHostWorldCopies(splineInspector.host, null);
        if (![...splineMotions.values()].some(motion => motion.host.key === splineInspector!.host.key))
          setHostVisible(splineInspector.host, null);
      }
      splineInspector.engaged = false;
      return true;
    }
    if (!showSplineInspector(sourceIndex, command) || !splineInspector) return false;
    const clamped = THREE.MathUtils.clamp(distance, 0, splineInspector.length);
    const direction = command.speed < 0 ? -1 : 1;
    const matrices = splinePoseMatrices(
      splineInspector.points, splineInspector.cumulative, splineInspector.length, clamped, direction,
      command.endMode, command.orientationMode, command.yawOffset, command.instanceCount, splineInspector.basis);
    setHostVisible(splineInspector.host, true);
    setHostWorldMatrix(splineInspector.host, matrices[0] ?? null);
    setHostWorldCopies(splineInspector.host, matrices.length > 1 ? matrices.slice(1) : null);
    splineInspector.engaged = true;
    updateSplineInspectorPose(splineInspector, clamped);
    return true;
  }

  function startSplineMotion(host: RuntimeHost, command: SplineMotionCommand, source: RunSource) {
    if (!command.spline) return;
    const prior = splineMotions.get(host.key);
    if (prior) {
      // Test owns the motion once it starts. Turning the Effects view off during a ride must not remove a mover
      // that Play also installed; stopping Play restores/reinstalls the ambient copy when appropriate.
      if (source === 'play' && prior.source === 'ambient') prior.source = 'play';
      return;
    }
    const spline = hooks.resolveSpline?.(host.object, command.spline);
    const sampled = spline ? splineSamples(spline) : null;
    if (!sampled || sampled.length <= 0) return;
    const { basis } = motionBasis(host);
    const direction = command.speed < 0 ? -1 : 1;
    setHostVisible(host, true);
    splineMotions.set(host.key, {
      key: host.key, host, basis, ...sampled, distance: 0, direction,
      speed: Math.abs(command.speed), endMode: command.endMode, orientationMode: command.orientationMode,
      instanceCount: command.instanceCount, yawOffset: command.yawOffset,
      stopped: false, finished: false, source,
      splineLine: spline ? createSplineLine(spline, command) : null,
    });
  }

  function spawnEmitter(host: RuntimeHost, node: EffectNode, source: RunSource, continuous: boolean,
    collisionContact: CollisionEmitterContact | null = null) {
    const law = timerEmitterPreviewLaw(node);
    if (!law) return;
    // Sitting on a persistent chain does NOT make an emitter stream: the emission window's SIGN is the
    // mode selector [Trailmap: 180-particles-data]. Negative is an unbounded stream — the form every
    // always-on retail prop authors — while a non-negative window releases its count ONCE over those
    // seconds and then stops. Streaming a positive-window emitter here would show an author a plume
    // that a repacked disc never draws, which is exactly how a one-shot snow gun reached hardware.
    if (continuous && law.emissionDuration < 0) {
      const key = `${source}:${host.key}:${node.id}`;
      const prior = continuousEmitters.get(key);
      if (prior) prior.expiresAt = elapsed + AMBIENT_REPEAT_SECONDS + AMBIENT_SCAN_SECONDS * 2;
      else continuousEmitters.set(key, {
        key, host, node, law, source, accumulator: 1,
        expiresAt: elapsed + AMBIENT_REPEAT_SECONDS + AMBIENT_SCAN_SECONDS * 2,
      });
      return;
    }
    ensureParticleSprite(law.spriteIndex);
    const total = Math.min(EVENT_BURST_PARTICLE_CAP, law.count);
    // P6 receives all U0 particles in one record. Their starts are staggered by U2/U0 and U1 is the number of
    // closely spaced trail copies per particle, not a CPU spawn-batch size.
    emitParticles(host, node, law, source, total, false, true, collisionContact);
  }

  function emitParticles(host: RuntimeHost, node: EffectNode, law: TimerEmitterPreviewLaw, source: RunSource,
    requested: number, persistent: boolean, diagnosticPulse = false,
    collisionContact: CollisionEmitterContact | null = null): number {
    const limit = source === 'ambient' ? AMBIENT_PARTICLE_LIMIT : MAX_PARTICLE_HEADS;
    const count = Math.max(0, Math.min(requested, limit - particles.length));
    if (!count) return 0;
    const fields = particleEmitterFields(node);
    const zeroOrigin = Math.abs(numberField(fields, 'U9', 0)) < 1e-6
      && Math.abs(numberField(fields, 'U10', 0)) < 1e-6 && Math.abs(numberField(fields, 'U11', 0)) < 1e-6;
    const fireworkHost = host.reference && /firework|flashpot|bomb/i.test(host.reference.instance.modelName);
    const muzzle = !persistent && zeroOrigin && fireworkHost
      ? hooks.referenceEmitterMuzzle?.(host.reference!.instance.index) ?? null : null;
    // U9-U11 are only a stored seed on SubType-2. Hardware replaces them with this hit's exact point.
    // An isolated editor preview has no hit, so it deliberately uses the prop origin as a stable stand-in.
    const collisionEmitter = node.semanticType === 'particle.collision';
    const origin = collisionEmitter ? collisionContact?.position.clone() ?? host.position()
      : muzzle?.position ?? host.position(node);
    const size = timerEmitterPreviewSizeRange(law, host.sizeScale, persistent);
    const spriteIndex = ensureParticleSprite(law.spriteIndex);
    const nativeAim = muzzle ? host.vector(new THREE.Vector3(0, 0, 1)).normalize() : null;
    const correction = muzzle && nativeAim && nativeAim.lengthSq() > 0.5
      ? new THREE.Quaternion().setFromUnitVectors(nativeAim, muzzle.direction.clone().normalize()) : null;
    const worldVector = (value: readonly number[]) => {
      const result = host.vector(new THREE.Vector3(value[0], value[1], value[2]));
      return correction ? result.applyQuaternion(correction) : result;
    };
    const authoredWorldBase = worldVector(law.velocityBase);
    const contactNormal = collisionContact?.normal.clone().normalize() ?? null;
    const collisionWorldBase = collisionEmitter && contactNormal
      ? new THREE.Vector3(...collisionEmitterContactVelocityBase(
        [authoredWorldBase.length(), 0, 0], contactNormal.toArray())) : null;
    const acceleration = worldVector(law.gravity);
    const timeScale = Math.abs(law.timeScale) < 1e-6 ? 1 : law.timeScale;
    const linear = acceleration.clone().multiplyScalar(1 / (timeScale * timeScale));
    for (let i = 0; i < count; i++) {
      const sampled = timerEmitterPreviewSample(law);
      let velocity = worldVector(sampled.velocity);
      if (collisionWorldBase) {
        // Native replaces only U18-U20; U21-U29's three centered variation axes remain authored.
        const variation = velocity.sub(authoredWorldBase);
        velocity = collisionWorldBase.clone().add(variation);
      }
      const particleOrigin = origin.clone().add(worldVector(sampled.spawnOffset));
      const curved = linear.clone().addScaledVector(velocity, -1 / timeScale);
      particles.push({
        pos: particleOrigin.clone(),
        origin: particleOrigin,
        linear: linear.clone(),
        curved,
        colors: law.colors,
        age: persistent ? 0 : -timerEmitterPreviewStartDelay(law, i),
        life: timerEmitterPreviewLifetime(law, persistent, Math.random()),
        timeScale,
        trailCopies: law.trailCopies,
        trailStep: law.trailStep,
        size: size.min + Math.random() * (size.max - size.min),
        spriteIndex,
        blend: emitterBlendMode(law.blendSelector),
        source,
      });
    }
    if (diagnosticPulse && source === 'preview') {
      const first = law.colors[0];
      const color = new THREE.Color(first?.[0] ?? 0.7, first?.[1] ?? 0.5, first?.[2] ?? 1);
      spawnPulse(origin, color.getHex(), 0.55, source);
    }
    return count;
  }

  function stepContinuousEmitters(dt: number) {
    for (const [key, emitter] of continuousEmitters) {
      if (elapsed > emitter.expiresAt) { continuousEmitters.delete(key); continue; }
      emitter.accumulator += emitter.law.rate * dt;
      const requested = Math.min(24, Math.floor(emitter.accumulator));
      if (!requested) continue;
      ensureParticleSprite(emitter.law.spriteIndex);
      emitParticles(emitter.host, emitter.node, emitter.law, emitter.source, requested, true);
      // A full global budget drops this frame's excess instead of banking a giant burst for later.
      emitter.accumulator = Math.max(0, Math.min(1, emitter.accumulator - requested));
    }
  }

  function spawnPulse(at: THREE.Vector3, color: number, life = 0.9, source: RunSource = 'preview') {
    if (pulses.length >= MAX_PULSES) return;
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.65, 1, 28), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(at);
    mesh.raycast = () => {};
    root.add(mesh);
    pulses.push({ mesh, age: 0, life, source });
  }

  function disposePulse(index: number) {
    const pulse = pulses[index];
    root.remove(pulse.mesh);
    pulse.mesh.geometry.dispose();
    (pulse.mesh.material as THREE.Material).dispose();
    pulses.splice(index, 1);
  }

  function clearPulses() {
    for (let i = pulses.length - 1; i >= 0; i--) disposePulse(i);
  }

  /** Preview one timer node in isolation. A synthetic one-node graph lets the ordinary scheduler preserve the
   * exact emitter transform/law while excluding sibling layers, sounds, waits, and property actions. */
  function previewTimerNode(host: RuntimeHost, node: EffectNode, continuous: boolean): boolean {
    if (!particleEmitterFields(node)) return false;
    resumeEffectsAudio();
    stopPreview();
    const graph: EffectGraph = { id: `preview:timer:${node.id}`, nodes: [node] };
    scheduleGraph(host, graph, elapsed, 0, 'preview', continuous);
    if (continuous) {
      const key = `${host.key}:${graph.id}`;
      previewLoops.set(key, { key, host, graph });
      previewLoopNext = elapsed + AMBIENT_REPEAT_SECONDS;
      for (const [emitterKey, emitter] of continuousEmitters)
        if (emitter.source === 'ambient' && emitter.host.key === host.key) continuousEmitters.delete(emitterKey);
    }
    return true;
  }

  function previewReferenceTimerNode(instanceIndex: number, node: EffectNode, continuous = false): boolean {
    const instance = data?.instances.find(candidate => candidate.index === instanceIndex);
    if (!instance || !data) return false;
    selectInstance(instanceIndex);
    return previewTimerNode(referenceHost(data, instance), node, continuous);
  }

  function previewAuthoredTimerNode(propId: string, node: EffectNode, continuous = false): boolean {
    const document = authoredDocument;
    const prop = authoredProps.find(candidate => candidate.id === propId);
    return document && prop ? previewTimerNode(authoredHost(document, prop), node, continuous) : false;
  }

  function preview(instanceIndex: number, graphId: string, loop = false): boolean {
    return previewGraphs(instanceIndex, [graphId], loop ? [graphId] : []);
  }

  /** Preview an authored prop graph through the same scheduler as a reference graph. */
  function previewAuthored(propId: string, graphId: string, loop = false): boolean {
    const document = authoredDocument;
    const prop = authoredProps.find(candidate => candidate.id === propId);
    const graph = document?.graphs.find(candidate => candidate.id === graphId);
    if (!document || !prop || !graph) return false;
    resumeEffectsAudio();
    stopPreview();
    const host = authoredHost(document, prop);
    scheduleGraph(host, graph, elapsed, 0, 'preview', loop);
    if (loop) {
      previewLoops.set(`${host.key}:${graph.id}`, { key: `${host.key}:${graph.id}`, host, graph });
      previewLoopNext = elapsed + AMBIENT_REPEAT_SECONDS;
    }
    return true;
  }

  /** Start a model-root preview as one transaction. Every graph runs immediately; timer-persistent members
   * remain in the preview loop without displacing their sibling collision/trigger graphs. */
  function previewGraphs(instanceIndex: number, graphIds: readonly string[], loopGraphIds: readonly string[] = []): boolean {
    const instance = data?.instances.find(x => x.index === instanceIndex);
    if (!instance) return false;
    const graphs = [...new Set(graphIds)].map(graphById).filter((graph): graph is EffectGraph => !!graph);
    if (!graphs.length) return false;
    const loops = new Set(loopGraphIds);
    resumeEffectsAudio();
    selectInstance(instanceIndex);
    stopPreview();
    const host = referenceHost(data!, instance);
    for (const graph of graphs) {
      const loop = loops.has(graph.id);
      scheduleGraph(host, graph, elapsed, 0, 'preview', loop);
      if (loop) previewLoops.set(`${host.key}:${graph.id}`, { key: `${host.key}:${graph.id}`, host, graph });
    }
    if (previewLoops.size) {
      previewLoopNext = elapsed + AMBIENT_REPEAT_SECONDS;
      for (const [key, emitter] of continuousEmitters)
        if (emitter.source === 'ambient' && emitter.host.key === host.key) continuousEmitters.delete(key);
    }
    return true;
  }

  function stopPreview(): boolean {
    const hadAnimObjectPreview = hooks.clearAnimObjectPreviews?.() ?? false;
    const hadMaterialPreview = hooks.clearMaterialEffectPreviews?.() ?? false;
    const wasPlaying = previewLoops.size > 0 || scheduled.some(item => item.meta.source === 'preview')
      || particles.some(item => item.source === 'preview') || pulses.some(item => item.source === 'preview')
      || previewSceneHosts.size > 0 || [...activeSounds].some(item => item.source === 'preview')
      || [...splineMotions.values()].some(item => item.source === 'preview')
      || hadAnimObjectPreview || hadMaterialPreview;
    const loopKeys = [...previewLoops.keys()];
    previewLoops.clear();
    clearRuntimeSource('preview');
    clearPreviewSceneRuntime();
    for (const key of loopKeys) persistentNext.delete(key);
    return wasPlaying;
  }

  function isPreviewing(instanceIndex: number, graphId: string): boolean {
    return previewLoops.has(`reference:${instanceIndex}:${graphId}`);
  }

  /** The live state of a prop's Counter during Play, for the inspector's readout. Null when Play is not
   * running it at all, which is itself the answer to "why has nothing counted?" — a Counter that was never
   * installed reads as absent rather than as full. Copied out so the panel cannot mutate the runtime. */
  function playCounter(key: string): { remaining: number; marked: number[] } | null {
    const state = playCounters.get(key);
    return state ? { remaining: state.remaining, marked: [...state.marked].sort((a, b) => a - b) } : null;
  }

  interface PlayBinding { key: string; host: RuntimeHost; circumstance: string; graph: EffectGraph }

  function collisionBindingRepeatSeconds(binding: PlayBinding): number {
    return binding.graph.nodes.some(node => node.semanticType === 'particle.collision')
      ? COLLISION_EMITTER_REPEAT_SECONDS
      : COLLISION_SOUND_DEBOUNCE_SECONDS;
  }

  /**
   * The MainType-0 boost family, resolved into editor world space for the ride's containment runtime
   * ([Trailmap: 360-node]). Built once at Play launch: these volumes act every tick a rider is inside them, and
   * the debounced collision dispatch below cannot express that — see boost-volumes.ts.
   *
   * Every axis goes through `worldVector`, never `vector`: these are world-space directions and the host's own
   * rotation must not turn them ([Trailmap: 360-node-fields]).
   */
  function boostVolumeSpecs(): Map<string, BoostVolumeSpec> {
    const specs = new Map<string, BoostVolumeSpec>();
    for (const binding of [...playBindings('reference'), ...playBindings('authored')]) {
      if (binding.circumstance !== 'collision') continue;
      for (const node of binding.graph.nodes) {
        const spec = boostVolumeSpec(node, binding.host.worldVector, binding.host.vector,
          binding.host.worldPoint);
        if (spec) { specs.set(runtimeObjectKey(binding.host.object), spec); break; }
      }
    }
    return specs;
  }

  /**
   * The CRACKED surfaces: which hosts carry a `property.cracked` on their collision graph, with the pool and
   * lifetime they were authored with ([Trailmap: 370-world-interaction]).
   *
   * Like the boost volumes above, this cannot go through the debounced collision dispatch: the pool is spent
   * by contacts that keep arriving while the rider is CARRIED, one every 30 frames, and a chain that fired
   * once per debounce interval would break a pane in a single touch. So the ride layer owns the drain
   * (`ride/cracked-surfaces.ts`) and this only resolves what was authored.
   *
   * The break itself comes back through `onCrackedBreak`, which does the two things the level data cannot say.
   * It runs the slot's own TRIGGER column — the shatter sound, the kill and the reveals live there, and it is
   * the only authored use of that column by anything other than a Counter — and it HIDES the host, because no
   * retail pane's chain carries a `DeadNodeMode 4` and yet the pane disappears and the rider drops through.
   */
  function crackedSurfaceSpecs(): Map<string, CrackedSurfaceSpec> {
    const out = new Map<string, CrackedSurfaceSpec>();
    for (const binding of [...playBindings('reference'), ...playBindings('authored')]) {
      if (binding.circumstance !== 'collision') continue;
      for (const node of binding.graph.nodes) {
        const spec = crackedSurfaceSpec(node);
        if (!spec) continue;
        const key = runtimeObjectKey(binding.host.object);
        if (!out.has(key)) out.set(key, { strength: spec.strength, lifetimeSeconds: spec.lifetimeSeconds });
        break;
      }
    }
    return out;
  }

  /** Resolve only a host whose collision graph actually authors a Cracked node. This is also the trust boundary
   * for a peer event: an arbitrary collision key must not be allowed to drive property command 2. */
  function crackedSurfaceTarget(key: string): RuntimeHost | null {
    for (const binding of [...playBindings('reference'), ...playBindings('authored')]) {
      if (runtimeObjectKey(binding.host.object) !== key) continue;
      if (binding.circumstance !== 'collision') continue;
      if (binding.graph.nodes.some(node => crackedSurfaceSpec(node) !== null)) return binding.host;
    }
    return null;
  }

  /** The cracked host and its trigger column, for a key the crack runtime reports as broken. */
  function crackedBreakTarget(key: string): { host: RuntimeHost; graph: EffectGraph | null } | null {
    const host = crackedSurfaceTarget(key);
    if (!host) return null;
    const trigger = [...playBindings('reference'), ...playBindings('authored')].find(other =>
      other.circumstance === 'trigger' && runtimeObjectKey(other.host.object) === key);
    return { host, graph: trigger?.graph ?? null };
  }

  /** Run the shatter: the slot's trigger column, then the hide the authored data never carries. */
  function applyCrackedBreak(key: string, subject: RunSubject, event: RideEvent | null): boolean {
    const target = crackedBreakTarget(key);
    if (!target) return false;
    if (target.graph) scheduleGraph(target.host, target.graph, elapsed, 0, 'play', false, subject,
      'cracked-break', event);
    armInteractionReset(target.host, elapsed + BREAKABLE_RESPAWN_SECONDS, 'breakable');
    setHostVisible(target.host, false);
    hooks.retireRideObject?.(target.host.object);
    return true;
  }

  function onCrackedBreak(key: string, subject: number | null = null): void {
    const event = subject === null ? newRideEvent('cracked-break', key) : null;
    if (applyCrackedBreak(key, subject, event) && event) hooks.onRideEvent?.(event);
  }

  /** The native Crack handler selects model-material frame 1 on first damage and frame 0 if a finite crack
   * heals. The graph deliberately carries no TextureFlip node: this is per-instance model state. */
  function onCrackedChange(key: string, cracked: boolean, subject: number | null = null): void {
    const host = crackedSurfaceTarget(key);
    if (host) {
      hooks.controlProperty?.(host.object, 2, cracked ? 1 : 0);
      if (subject === null) {
        const event = newRideEvent(cracked ? 'cracked' : 'cracked-heal', key);
        if (event) hooks.onRideEvent?.(event);
      }
    }
    // Containment is a real first contact even when a flush horizontal pane never enters the blocking obstacle
    // solver. Run its collision column once through the same debounce, or Test creates the crack pool but omits
    // the marker/side effects the native contact walk constructs on PS2.
    const fired: PlayBinding[] = [];
    if (cracked) for (const binding of [...playBindings('reference'), ...playBindings('authored')]) {
      if (binding.circumstance !== 'collision' || runtimeObjectKey(binding.host.object) !== key) continue;
      if (elapsed < (collisionGraphNext.get(binding.key) ?? 0)) continue;
      collisionGraphNext.set(binding.key, elapsed + collisionBindingRepeatSeconds(binding));
      fired.push(binding);
    }
    runSharedBindings(fired, 'collision', key, subject);
  }

  /**
   * The MainType-13 RESET volumes: which hosts carry a `rider.reset` on their collision graph
   * ([Trailmap: 390-pickups-and-race], and one of the traced arming sites for the course reset,
   * [Trailmap: 395-reset-arm]). These are the boundary the level's author drew around the run — MEGAPLEX lines
   * its course with 137 m walls of them, MERQUER floors its subway with 15 m pads — and touching one is what
   * carries a rider that has left the course back onto it.
   *
   * The player takes them through the graph runtime below, which dispatches from its own board. The AI field
   * cannot: nothing tracks an opponent's position through this runtime. So the keys travel to the ride layer
   * as a set and each AI rider tests them against its own prop contacts (`ride/ai.ts`), which is the same
   * event through the same collider — a field that could not see these volumes is a field that stays wherever
   * the mountain dropped it.
   */
  function resetVolumeKeys(): Set<string> {
    const keys = new Set<string>();
    for (const binding of [...playBindings('reference'), ...playBindings('authored')]) {
      if (binding.circumstance !== 'collision') continue;
      if (binding.graph.nodes.some(node => node.semanticType === 'rider.reset')) {
        keys.add(runtimeObjectKey(binding.host.object));
      }
    }
    return keys;
  }

  /** The raw→editor basis on its own: a push axis is already world space in the native frame, so inside
   *  refRoot only that frame change applies — no instance rotation, no reference placement offset. */
  const rawBasis = new THREE.Matrix3().setFromMatrix4(RAW_TO_EDITOR);
  const rawAxis = (raw: THREE.Vector3) => raw.applyMatrix3(rawBasis);

  /**
   * Every boost node in the loaded reference, as arrows anchored on their host instance. The scan covers all
   * circumstances rather than the ride's collision-only set: the arrow describes the node's authored data, and
   * the inspector is what says when it fires.
   */
  function boostArrows(): { index: number; arrow: BoostArrow }[] {
    if (boostArrowCache) return boostArrowCache;
    const out: { index: number; arrow: BoostArrow }[] = [];
    if (data) for (const instance of attachedReferenceInstances(data)) {
      const origin = instanceLocalPosition(instance);
      const hostBasis = new THREE.Matrix3().setFromMatrix4(instanceMatrix(instance));
      const hostAxis = (raw: THREE.Vector3) => raw.applyMatrix3(hostBasis);
      for (const binding of referenceInstanceBindings(data, instance)) {
        for (const node of binding.graph.nodes) {
          const spec = boostVolumeSpec(node, rawAxis, hostAxis);
          if (!spec) continue;
          for (const arrow of specArrows(spec, origin)) out.push({ index: instance.index, arrow });
        }
      }
    }
    boostArrowCache = out;
    return out;
  }

  /** One arrow per push the node can deliver: the tube-end launch has three, numbered by their stage. */
  function specArrows(spec: BoostVolumeSpec, origin: THREE.Vector3): BoostArrow[] {
    const arrows: BoostArrow[] = spec.kind === 'tube-end'
      ? spec.stages.map((stage, index) => ({ origin, dir: stage.dir, speed: stage.speed, barbs: index + 1 }))
      : [{ origin, dir: spec.dir, speed: spec.target, barbs: 1 }];
    // The tube end authors its inherited base axis as all-zero, and a stage it never launches the same way.
    return arrows.filter(arrow => arrow.dir.lengthSq() > 1e-8);
  }

  /** Redraw the arrow overlay for the current data and selection. Cheap: a level holds a handful of boosts. */
  function refreshBoostArrows() {
    const arrows = inspectVisible ? boostArrows() : [];
    boostArrowLayer.setArrows(
      arrows.filter(entry => entry.index !== selectedInstance).map(entry => entry.arrow),
      arrows.filter(entry => entry.index === selectedInstance).map(entry => entry.arrow),
    );
    boostArrowLayer.setVisible(arrows.length > 0);
  }

  function playBindings(target: 'authored' | 'reference'): PlayBinding[] {
    if (target === 'reference') {
      if (!data) return [];
      return attachedReferenceInstances(data).flatMap(instance => {
        const host = referenceHost(data!, instance);
        return referenceInstanceBindings(data!, instance).map(binding => ({
          key: `${host.key}:${binding.circumstance}:${binding.graph.id}`,
          host, circumstance: binding.circumstance, graph: binding.graph,
        }));
      });
    }
    const document = authoredDocument;
    if (!document) return [];
    const out: PlayBinding[] = [];
    for (const { prop, circumstance, graph } of authoredEffectBindings(document, authoredProps)) {
      const host = authoredHost(document, prop);
      out.push({ key: `${host.key}:${circumstance}:${graph.id}`, host, circumstance, graph });
    }
    return out;
  }

  function activeRideEventTarget(): RideEventTarget | null {
    if (activePlayTarget === 'authored') return { kind: 'authored' };
    if (activePlayTarget === 'reference' && data?.level) return { kind: 'reference', level: data.level };
    return null;
  }

  function newRideEvent(kind: RideEventKind, key: string,
    collisionContact: CollisionEmitterContact | null = null): RideEvent | null {
    const target = activeRideEventTarget();
    if (!target || !Number.isSafeInteger(nextRideEventId)) return null;
    const event: RideEvent = {
      target, mode: playMode, kind, key, id: nextRideEventId,
      riderSpeed: THREE.MathUtils.clamp(riderVelocity.length(), 0, 500),
      ...(kind === 'collision' && collisionContact ? { contact: {
        point: collisionContact.position.toArray() as [number, number, number],
        normal: collisionContact.normal.clone().normalize().toArray() as [number, number, number],
      } } : {}),
    };
    nextRideEventId++;
    return event;
  }

  /** Start every local graph first, then publish the one interaction that owns them. AI fields still mutate
   * this browser's throwaway world, but only the human rider is an authority for multiplayer crossings. */
  function runSharedBindings(bindings: readonly PlayBinding[], kind: 'collision' | 'trigger', key: string,
    subject: number | null, collisionContact: CollisionEmitterContact | null = null): boolean {
    if (!bindings.length) return false;
    const event = subject === null ? newRideEvent(kind, key, collisionContact) : null;
    for (const binding of bindings)
      scheduleGraph(binding.host, binding.graph, elapsed, 0, 'play', false, subject, 'ordinary', event,
        undefined, collisionContact);
    if (event) hooks.onRideEvent?.(event);
    return true;
  }

  /** Replay another participant's accepted root against this client's copy of the same Play world. The special
   * subject preserves every world-side command while making rider resets, boosts, scores and teleports no-ops. */
  function applyRideEvent(event: RideEvent): boolean {
    const target = activeRideEventTarget();
    if (!target || !sameRideEventTarget(target, event.target)) return false;
    if (event.kind === 'cracked' || event.kind === 'cracked-heal') {
      const host = crackedSurfaceTarget(event.key);
      if (!host || !hostIsPresentInPlayMode(host, playMode)) return false;
      hooks.controlProperty?.(host.object, 2, event.kind === 'cracked' ? 1 : 0);
      return true;
    }
    if (event.kind === 'cracked-break') {
      const host = crackedSurfaceTarget(event.key);
      return !!host && hostIsPresentInPlayMode(host, playMode)
        && applyCrackedBreak(event.key, 'remote', event);
    }
    if (!activePlayTarget) return false;
    if (event.kind === 'collision') {
      const bindings = playBindings(activePlayTarget).filter(binding => binding.circumstance === 'collision'
        && runtimeObjectKey(binding.host.object) === event.key
        && hostIsPresentInPlayMode(binding.host, playMode));
      if (!bindings.length) return false;
      const collisionContact = event.contact ? {
        position: new THREE.Vector3(...event.contact.point), normal: new THREE.Vector3(...event.contact.normal),
      } : null;
      for (const binding of bindings)
        scheduleGraph(binding.host, binding.graph, elapsed, 0, 'play', false, 'remote', 'ordinary', event,
          undefined, collisionContact);
      // Collision audio is prop-owned rather than graph-owned. Use the stable host position and the sender's
      // speed as the best available impact intensity; gameplay-only board cues remain suppressed above.
      const host = bindings[0].host;
      propSound.contact(host.object, collisionContact?.position ?? host.position(), event.riderSpeed, elapsed);
      return true;
    }
    const binding = playBindings(activePlayTarget).find(candidate => candidate.circumstance === 'trigger'
      && candidate.key === event.key && hostIsPresentInPlayMode(candidate.host, playMode));
    if (!binding) return false;
    scheduleGraph(binding.host, binding.graph, elapsed, 0, 'play', false, 'remote', 'ordinary', event);
    return true;
  }

  /** Exact contact entry point from the fixed-tick board sweep. Collision graphs and prop-hit sounds are
   * contact-only: listener range gates an already-detected hit; it never substitutes for one. */
  /**
   * Send a shoved rigid body on its way. The ride model has already taken the rider's side of the momentum
   * exchange and handed us the prop's launch velocity; the body then rides the same integrator the Roller and
   * mesh-throw effects use, so it arcs under gravity, bounces on the terrain and settles where it stops.
   *
   * The Play collision set is a launch-time snapshot, so the bag's collider stays at its original transform while
   * the visible body flies. That is the same standing limitation the Roller effect has and it is the right trade
   * here: a crash bag exists to be ploughed through once, and re-fitting a prop collider mid-ride is the separate
   * piece of work that limitation names.
   */
  /**
   * Send a shoved rigid body on its way. The ride model has already solved the impulse and handed us both halves
   * of what it did to the prop: a world linear velocity and a world angular velocity about the body's own centre
   * of mass. There is deliberately nothing to add here - [Trailmap: 370-world-interaction] is explicit that the
   * impulse carries no vertical bias and no hard-coded upward kick, and that a struck body's loft comes instead
   * from spinning over its own ground contact, which `stepRigidBody` resolves.
   *
   * The Play collision set is a launch-time snapshot, so the body's collider stays at its original transform
   * while the visible body flies. Retail keeps a moved body collidable; that divergence is the standing snapshot
   * limitation, not a property of the shove.
   */
  function shoveProp(object: RideObstacleObject, shove: NonNullable<RideObstacleHit['shove']>) {
    if (object.kind !== 'reference' || !data) return;
    const instance = data.instances.find(candidate => candidate.index === object.index);
    if (!instance) return;
    const host = referenceHost(data, instance);
    if (dynamicBodies.has(host.key)) return; // already in flight - a second hit must not re-seat it at its origin
    const { matrix, position, basis } = motionBasis(host);
    const sphere = hooks.objectSphere?.(host.object) ?? null;
    const radius = Math.max(sphere?.radius ?? 1, 0.25);
    const speed = shove.linear.length();
    if (speed < 1e-6) return;

    // A body that reached Play without mass properties still has to LEAVE. It cannot run the rigid contact solve,
    // so it takes the simple bodies' arc with a tumble scaled off its own launch - visibly worse than the solved
    // path, but a prop welded to the rider's nose is the one outcome that reads as broken.
    const rigid = shove.body;
    if (!rigid) {
      const axis = new THREE.Vector3().crossVectors(shove.linear, yAxis);
      dynamicBodies.set(host.key, {
        key: host.key, host, matrix, basis, position, velocity: shove.linear.clone(),
        spinAxis: axis.lengthSq() > 1e-8 ? axis.normalize() : new THREE.Vector3(1, 0, 0),
        spin: THREE.MathUtils.clamp(speed * 0.35, 1.5, 9),
        rotation: new THREE.Quaternion(), age: 0, duration: 12, hideOnEnd: false,
      });
      return;
    }

    // The support distance is the CoM's ground clearance AT LAUNCH — the body is resting on the snow when it is
    // struck, so that clearance is exactly how far its underside hangs below its centre of mass. The render
    // bounding sphere is NOT that measure: on the wide GARI crash-bag row it is 2.78 m against a real clearance
    // of 1.59 m, and using it stood the bag on a phantom sphere — the first contact frame lifted it 1.3 m into
    // the chase camera, where it hovered gyrating on an oversized lever instead of tumbling away.
    const com = rigid.com.clone();
    const groundAtLaunch = hooks.groundAt?.(host.object, com) ?? null;
    const support = groundAtLaunch
      ? THREE.MathUtils.clamp(com.y - groundAtLaunch.y, 0.2, radius)
      : Math.min(radius, 1.2); // no ground read: a conservative stand-in beats a bounding-sphere stilt

    dynamicBodies.set(host.key, {
      key: host.key, host, matrix, basis, position,
      velocity: shove.linear.clone(), angular: shove.angular.clone(),
      invInertia: rigid.invInertia, invMass: rigid.invMass, com, comOffset: com.clone().sub(position),
      radius: support,
      spinAxis: yAxis.clone(), spin: 0,
      rotation: new THREE.Quaternion(), age: 0, duration: 20, hideOnEnd: false,
    });
  }

  function propCollision(object: RideObstacleObject, position: THREE.Vector3, normal: THREE.Vector3,
    impactSpeed: number,
    shove: RideObstacleHit['shove'] = null, subject: number | null = null) {
    const target = object.kind === 'reference' ? 'reference' : 'authored';
    if (activePlayTarget && activePlayTarget !== target) return;
    ensurePlayRuntime(target);
    if (shove) shoveProp(object, shove);
    try {
      if (localStorage.getItem('slopesmith:collision-debug') === '1') console.debug('[Slopesmith prop contact]', {
        object, impactSpeed: Number(impactSpeed.toFixed(3)),
        position: position.toArray().map(value => Number(value.toFixed(3))),
        normal: normal.toArray().map(value => Number(value.toFixed(3))),
        playSeconds: Number(elapsed.toFixed(3)),
        // The shove's whole story in one line: `shove: null` means the ride model never saw a Roller-activated
        // dynamic body [Trailmap: 370-world-interaction], while `hasBody: false` means it did but the
        // instance reached Play with no authored mass properties, so it cannot run the rigid solve.
        shove: shove ? {
          hasBody: !!shove.body,
          linear: shove.linear.toArray().map(v => Number(v.toFixed(3))),
          angular: shove.angular.toArray().map(v => Number(v.toFixed(3))),
          launchSpeed: Number(shove.linear.length().toFixed(3)),
          spinRate: Number(shove.angular.length().toFixed(3)),
        } : null,
      });
    } catch { /* storage can be unavailable in a privacy-restricted frame; diagnostics stay optional */ }
    const objectKey = runtimeObjectKey(object);
    const fired: PlayBinding[] = [];
    for (const binding of playBindings(target)) {
      if (binding.circumstance !== 'collision' || runtimeObjectKey(binding.host.object) !== objectKey) continue;
      if (elapsed < (collisionGraphNext.get(binding.key) ?? 0)) continue;
      collisionGraphNext.set(binding.key, elapsed + collisionBindingRepeatSeconds(binding));
      fired.push(binding);
    }
    const collisionContact = { position: position.clone(), normal: normal.clone().normalize() };
    runSharedBindings(fired, 'collision', objectKey, subject, collisionContact);

    // What the PROP sounds — its hit-gated ambience and its collision one-shot, in that order — belongs to
    // `prop-sound`; this only says that a contact happened and where.
    propSound.contact(object, position, impactSpeed, elapsed, shove ? 'movable' : undefined);
  }

  function installPersistentGraph(host: RuntimeHost, graph: EffectGraph, depth = 0,
    source: RunSource = 'play') {
    if (depth > MAX_GRAPH_DEPTH) return;
    for (const node of graph.nodes) {
      // A Counter is a constructor like the rest of this family, and it is the one with no motion to install,
      // which is why it was missed here: a Counter-only persistent graph is never scheduled (nothing in it
      // emits), so the map stayed empty and the first Mark against it read as already finished.
      const counter = source === 'play' ? effectCounterInstall(node) : null;
      if (counter !== null) {
        playCounters.set(host.key, newEffectCounter(counter));
        counterLog(`${host.key} installed at Play start · needs ${counter} inputs`);
        continue;
      }
      const animObject = animObjectFromNode(node) ?? animComboFromNode(node);
      if (animObject && hooks.startAnimObject?.(host.object, animObject)) continue;
      const command = effectPlayCommand(node);
      if (command?.kind === 'flag-wave' || command?.kind === 'spline-motion'
        || command?.kind === 'property-control') {
        executePlayCommand(host, command, source);
        continue;
      }
      if (node.mainType === 7) {
        const called = calledInstance(host, node);
        if (called) installPersistentGraph(called.host, called.graph, depth + 1, source);
        continue;
      }
      if ((node.mainType === 21 || node.mainType === 26) && node.references?.function) {
        const fn = host.document.functions.find(item => item.id === node.references!.function);
        if (fn) installPersistentGraph(host, { id: fn.id, name: fn.name, nodes: fn.nodes }, depth + 1, source);
      }
    }
  }

  /** The Effects visibility toggle runs passive world visuals without entering Test. Follow the same persistent
   * instance/function hand-offs as Play, but install only spline movers here: model/material effects have their
   * own render-layer clocks and control messages remain gameplay/runtime operations. */
  function installAmbientSplineGraph(host: RuntimeHost, graph: EffectGraph, depth = 0) {
    if (depth > MAX_GRAPH_DEPTH) return;
    for (const node of graph.nodes) {
      const command = effectPlayCommand(node);
      if (command?.kind === 'spline-motion') {
        executePlayCommand(host, command, 'ambient');
        continue;
      }
      if (node.mainType === 7) {
        const called = calledInstance(host, node);
        if (called) installAmbientSplineGraph(called.host, called.graph, depth + 1);
        continue;
      }
      if ((node.mainType === 21 || node.mainType === 26) && node.references?.function) {
        const fn = host.document.functions.find(item => item.id === node.references!.function);
        if (fn) installAmbientSplineGraph(host, { id: fn.id, name: fn.name, nodes: fn.nodes }, depth + 1);
      }
    }
  }

  function installWorldPersistentMotions() {
    if (!worldEffectsEnabled) return;
    for (const target of ['reference', 'authored'] as const) for (const binding of playBindings(target))
      if (binding.circumstance === 'persistent') installAmbientSplineGraph(binding.host, binding.graph);
  }

  /** Persistent property nodes are constructors/installers in SSX. Install the motion-bearing subset once when
   * Play begins, following nested graph/function calls; particle graphs keep their distance/budget scheduler below. */
  function installPlayPersistent(target: 'authored' | 'reference') {
    const bindings = playBindings(target);
    for (const binding of bindings)
      if (binding.circumstance === 'persistent') installPersistentGraph(binding.host, binding.graph);
    // Always one line, so an absent install reads as "this level has no Counter bound" rather than as
    // "the tracer never ran" — the two look identical when the only signal is silence.
    counterLog(`Play started on ${target}: ${playCounters.size} counter(s) installed`
      + ` from ${bindings.filter(binding => binding.circumstance === 'persistent').length} persistent effect(s)`
      + `${playCounters.size ? ` — ${[...playCounters].map(([key, state]) => `${key} needs ${state.remaining}`).join(', ')}` : ''}`);
  }

  /** External race code invokes named SSF functions that are not attached to any prop slot. StartCountDown is
   * the one lifecycle entry point Play can currently prove and reproduce: it installs the start-light
   * TextureFlip receiver, then selects frames 1..4 through the authored 1.0/0.5/0.5/0.5 second waits. */
  function scheduleReferenceStartCountdown() {
    if (!data) return;
    const start = data.document.functions.find(fn => fn.name.toLowerCase() === 'startcountdown')
      ?? data.document.functions.find(fn => fn.name.toLowerCase() === 'countdownstart');
    if (!start) return;

    const seen = new Set<string>();
    const referencedInstance = (fn: EffectGraph): ReferenceEffectInstance | null => {
      if (seen.has(fn.id)) return null;
      seen.add(fn.id);
      for (const node of fn.nodes) {
        const instance = referenceInstanceByStableId(data!, node.references?.instance);
        if (instance) return instance;
      }
      for (const node of fn.nodes) {
        const child = node.references?.function
          ? data!.document.functions.find(candidate => candidate.id === node.references!.function) : null;
        if (child) {
          const instance = referencedInstance({ id: child.id, name: child.name, nodes: child.nodes });
          if (instance) return instance;
        }
      }
      return null;
    };
    const hostInstance = referencedInstance({ id: start.id, name: start.name, nodes: start.nodes })
      ?? data.instances[0];
    if (!hostInstance) return;
    scheduleGraph(referenceHost(data, hostInstance), { id: start.id, name: start.name, nodes: start.nodes },
      elapsed, 0, 'play');
  }

  function scanPlayTriggers(riderWorld: THREE.Vector3, target: 'authored' | 'reference') {
    const radiusCache = new Map<string, number>();
    const bindings = playBindings(target);
    // A Cracked collision node owns its same-slot Trigger column. That graph is the break callback, not a
    // proximity volume; running it here shattered the next Megaplex panes merely because their large rendered
    // bounds came within range of the rider. The crack runtime invokes it explicitly through onCrackedBreak.
    //
    // A persistent Counter owns its slot's Trigger column the same way, and those are the only two things that
    // can fire one [Trailmap: 150-logic §150-counter-elapse]. Counters were missing here, and the host is
    // typically far LARGER than a pane: Merquer's strike counter sits on a building, so its column fired as
    // soon as the rider came within the building's rendered bounds — the sign flipped to its strike face on
    // approach, and knocking all ten cans afterwards then had nothing left to change.
    const dispatchedHosts = new Set<string>();
    for (const binding of bindings) {
      const dispatched = binding.circumstance === 'collision'
        ? binding.graph.nodes.some(node => crackedSurfaceSpec(node))
        : binding.circumstance === 'persistent'
          && binding.graph.nodes.some(node => effectCounterInstall(node) !== null);
      if (dispatched) dispatchedHosts.add(runtimeObjectKey(binding.host.object));
    }
    for (const binding of bindings) {
      const distance = binding.host.position().distanceTo(riderWorld);
      if (binding.circumstance === 'persistent') {
        // Camera-near ambient scheduling already owns emitters when the editor Effects toggle is on. With it off,
        // Play still runs only rider-near particle graphs; property installers were handled once above.
        if (!worldEffectsEnabled && distance <= 120
          && effectGraphHasTimerEmitter(binding.host.document, binding.graph)
          && elapsed >= (persistentNext.get(binding.key) ?? 0)) {
          scheduleGraph(binding.host, binding.graph, elapsed, 0, 'play', true);
          persistentNext.set(binding.key, elapsed + AMBIENT_REPEAT_SECONDS);
        }
        continue;
      }
      // Collision circumstances are dispatched only by propCollision's exact swept contact. A mode-0 visual
      // host has no collision event in retail, regardless of how close its rendered bounds are to the rider.
      if (binding.circumstance !== 'trigger') continue;
      let radius = radiusCache.get(binding.host.key);
      if (radius === undefined) {
        radius = hooks.objectRadius?.(binding.host.object) ?? 0;
        radiusCache.set(binding.host.key, radius);
      }
      const explicitlyDispatched = dispatchedHosts.has(runtimeObjectKey(binding.host.object));
      const proximityRadius = playProximityRadius(binding.circumstance, radius, explicitlyDispatched);
      if (proximityRadius === null) continue;
      const near = distance <= proximityRadius;
      if (near && !inside.has(binding.key)) {
        inside.add(binding.key);
        runSharedBindings([binding], 'trigger', binding.key, null);
      } else if (!near) inside.delete(binding.key);
    }
  }

  /** Run only the nearest persistent particle graphs. Sorting before scheduling makes the shared active-particle
   * cap deterministic in the useful direction: when a dense vista exceeds the budget, nearby emitters claim it
   * first and distant candidates wait for a later scan instead of winning by Instances.json order. */
  function scanAmbientEmitters(cameraWorld: THREE.Vector3) {
    if (!worldEffectsEnabled) return;
    const maxDistance2 = AMBIENT_MAX_DISTANCE * AMBIENT_MAX_DISTANCE;
    const candidates = [...authoredPersistentEmitters, ...referencePersistentEmitters]
      .map(binding => ({ binding, distance2: binding.host.position().distanceToSquared(cameraWorld) }))
      .filter(item => !previewLoops.has(item.binding.key) && item.distance2 <= maxDistance2
        && elapsed >= (persistentNext.get(item.binding.key) ?? 0))
      .sort((a, b) => a.distance2 - b.distance2)
      .slice(0, MAX_AMBIENT_EMITTERS);
    for (const { binding } of candidates) {
      scheduleGraph(binding.host, binding.graph, elapsed, 0, 'ambient', true);
      persistentNext.set(binding.key, elapsed + AMBIENT_REPEAT_SECONDS);
    }
  }

  /**
   * The moved-body simulation for a SHOVED prop ([Trailmap: 370-world-interaction] `[[370-bodysim]]`): gravity
   * 9.8 m/s², the fixed tick, terrain contact, an activity decay of ≈0.95 each tick, and sleep below a threshold
   * so a knocked prop settles instead of jittering forever.
   *
   * The rotational half is the point. The shove hands this body angular velocity because the rider's impulse
   * landed BELOW its centre of mass, and the contact solve here is what converts that spin into the launch a
   * crash bag actually makes: an impulse at the ground contact, solved against the same authored inverse inertia,
   * so a tipping body pushes off the snow and lofts. The spec is explicit that this is where the height comes
   * from — the impulse itself carries no vertical bias at all.
   */
  function stepRigidBody(body: DynamicBody, dt: number) {
    const inv = body.invInertia!, angular = body.angular!;
    const invMass = body.invMass ?? 1;
    // The CENTRE OF MASS is the integrated state: velocity translates it and the rotation turns about it. The
    // instance origin is derived at the end — integrating the origin instead swings the CoM around whatever
    // corner the modeller anchored the model at, and the visible body orbits rather than tumbles.
    const com = body.com!;
    body.velocity.y -= 9.8 * dt;
    com.addScaledVector(body.velocity, dt);

    const rate = angular.length();
    if (rate > 1e-6) body.rotation.premultiply(rigidQuat
      .setFromAxisAngle(rigidAxis.copy(angular).divideScalar(rate), rate * dt));

    const ground = hooks.groundAt?.(body.host.object, com) ?? null;
    const radius = body.radius ?? 0.5;
    if (ground) {
      // Rate-limited: a depenetration is a small positional nudge, never a teleport. The launch-time support
      // radius should make large corrections impossible, but a bad ground read must not fling the body upward
      // into the chase camera — that failure mode shipped once, when the support was read off the render
      // bounding sphere (2.78 m on the GARI crash bag) and the first contact frame lifted the bag 1.3 m.
      const penetration = Math.min(ground.y + RIGID_CONTACT_SKIN - (com.y - radius), RIGID_MAX_CORRECTION * dt * 60);
      if (penetration > 0) {
        com.y += penetration;
        // Contact at the body's lowest point, so an off-centre spin has a real lever against the snow.
        // `contactVelocity` holds its own scratch for the whole clause: it used to alias rigidTmp, and the
        // angular write below overwrote it with (0, impulse, 0) before friction read it — the tangent came out
        // zero every frame and the ground had NO friction at all.
        const r = rigidR.set(0, -radius, 0);
        const contactVelocity = rigidContactV.copy(angular).cross(r).add(body.velocity);
        if (contactVelocity.y < 0) {
          const rxn = rigidRxN.copy(r).cross(WORLD_UP_VEC);
          const rotational = applyInvInertia(inv, rxn, rigidTmp).cross(r).dot(WORLD_UP_VEC);
          const impulse = -(1 + RIGID_RESTITUTION) * contactVelocity.y
            / (invMass + Math.max(0, rotational));
          body.velocity.y += impulse * invMass;
          angular.add(applyInvInertia(inv, rigidTmp.copy(r).cross(rigidTmp2.set(0, impulse, 0)), rigidTmp3));

          // Coulomb friction on the same contact: this is what trades a sliding bag's travel for tumble.
          const tangent = rigidTmp.set(contactVelocity.x, 0, contactVelocity.z);
          const slide = tangent.length();
          if (slide > 1e-4) {
            tangent.divideScalar(slide);
            const rxt = rigidRxN.copy(r).cross(tangent);
            const tangentRotational = applyInvInertia(inv, rxt, rigidTmp2).cross(r).dot(tangent);
            const friction = Math.max(-RIGID_FRICTION * impulse,
              -slide / (invMass + Math.max(0, tangentRotational)));
            body.velocity.addScaledVector(tangent, friction * invMass);
            angular.add(applyInvInertia(inv,
              rigidTmp2.copy(r).cross(rigidTmp3.copy(tangent).multiplyScalar(friction)), rigidTmp4));
          }
        }
        // A sphere contact rolls without loss forever; a real bag scrubs against the snow. The RE names the
        // moved-body solver's coefficients without giving values, so this is the one term set by feel: a mild
        // in-contact decay that lets a rolling body coast, slow, and hand itself to the sleep test.
        const scrub = Math.pow(RIGID_ROLLING_DECAY, dt * 60);
        body.velocity.x *= scrub;
        body.velocity.z *= scrub;
        angular.multiplyScalar(scrub);
      }
    }

    // The traced ≈0.95 decays an ACTIVITY ACCUMULATOR that decides when to sleep — it is not velocity damping.
    // Damping the motion with it instead costs a body 95% of its speed per second and drops it dead at the
    // rider's feet; what actually slows a knocked prop is its own ground friction, solved above.
    const energy = body.velocity.lengthSq() + angular.lengthSq();
    const decay = Math.pow(RIGID_ACTIVITY_DECAY, dt * 60);
    body.activity = (body.activity ?? energy) * decay + energy * (1 - decay);
    // Settle rather than creep, but only once actually resting: a body still in the air is never asleep.
    if (ground && com.y - radius <= ground.y + RIGID_CONTACT_SKIN * 2 && body.activity < RIGID_SLEEP_ENERGY) {
      body.velocity.set(0, 0, 0);
      angular.set(0, 0, 0);
      body.asleep = true;
    }

    // Derive the instance origin the renderer needs from the CoM the physics owns.
    const offset = rigidOffset.copy(body.comOffset!).applyQuaternion(body.rotation);
    body.position.copy(com).sub(offset);
  }

  function stepDynamicBodies(dt: number) {
    for (const [key, body] of dynamicBodies) {
      body.age += dt;
      if (body.age >= body.duration) {
        dynamicBodies.delete(key);
        if (body.hideOnEnd) setHostVisible(body.host, false);
        continue;
      }
      if (body.invInertia && body.angular) {
        // A settled body holds its final pose; re-composing it every frame buys nothing.
        if (!body.asleep) {
          stepRigidBody(body, dt);
          setHostWorldMatrix(body.host, composeMotion(body.matrix, body.basis, body.position, body.rotation));
        }
        continue;
      }
      body.velocity.y -= 9.8 * dt;
      body.position.addScaledVector(body.velocity, dt);
      const ground = hooks.groundAt?.(body.host.object, body.position) ?? null;
      if (ground && body.position.y < ground.y + 0.08 && body.velocity.y < 0) {
        body.position.y = ground.y + 0.08;
        body.velocity.y *= -0.5;
        body.velocity.x *= 0.82; body.velocity.z *= 0.82; body.spin *= 0.86;
        if (body.velocity.lengthSq() < 0.15) { body.velocity.set(0, 0, 0); body.spin = 0; }
      }
      if (body.spin) body.rotation.premultiply(new THREE.Quaternion()
        .setFromAxisAngle(body.spinAxis, body.spin * dt));
      setHostWorldMatrix(body.host, composeMotion(body.matrix, body.basis, body.position, body.rotation));
    }
  }

  function stepPieceThrows(dt: number) {
    for (const [key, body] of pieceThrows) {
      body.age += dt;
      if (body.age >= body.duration) {
        pieceThrows.delete(key);
        setHostPieceMotions(body.host, null);
        setHostVisible(body.host, false);
        continue;
      }
      for (const piece of body.pieces) {
        piece.velocity.y -= 9.8 * dt;
        piece.offset.addScaledVector(piece.velocity, dt);
        piece.rotation.premultiply(new THREE.Quaternion()
          .setFromAxisAngle(piece.spinAxis, piece.spin * dt));
      }
      setHostPieceMotions(body.host, body.pieces);
    }
  }

  function stepFlexMotions(dt: number) {
    const worldUp = new THREE.Vector3(0, 1, 0);
    for (const motion of flexMotions.values()) {
      let angle: number;
      if (motion.kind === 'flag') {
        motion.phase += motion.velocity * dt;
        angle = Math.sin(motion.phase + motion.position.x * 0.07 + motion.position.z * 0.05) * motion.amplitude;
      } else {
        motion.velocity += (-32 * motion.phase - 7 * motion.velocity) * dt;
        motion.phase += motion.velocity * dt;
        angle = THREE.MathUtils.clamp(motion.phase * motion.amplitude, -0.28, 0.28);
        if (Math.abs(motion.phase) < 0.001 && Math.abs(motion.velocity) < 0.001) {
          setHostWorldMatrix(motion.host, null); flexMotions.delete(motion.key); continue;
        }
      }
      const rotation = new THREE.Quaternion().setFromAxisAngle(worldUp, angle);
      setHostWorldMatrix(motion.host, composeMotion(motion.matrix, motion.basis, motion.position, rotation));
    }
  }

  function stepSplineMotions(dt: number) {
    for (const motion of splineMotions.values()) {
      if (!motion.stopped) {
        const next = stepSplineMotionDistance(motion.distance, motion.direction, motion.speed,
          dt, motion.length, motion.endMode);
        motion.distance = next.distance;
        motion.direction = next.direction;
        motion.stopped = next.stopped;
        motion.finished = next.finished;
      }
      // The read-only timeline owns this prop while its scrub pose is engaged. Keep ambient/Play clocks moving
      // underneath so releasing the timeline can return cleanly to the running world effect.
      if (splineInspector?.engaged && splineInspector.host.key === motion.host.key) continue;
      // Native mover hosts may be authored invisible (Snowdream's Chair_4000 is; Chair_3000/1000 are not).
      // A progressive reference rebuild can clear the one-time override installed at start, while motion and copy
      // clocks remain live. Reassert ownership every frame just as we already reassert the moving matrices.
      setHostVisible(motion.host, !motion.finished);
      const matrices = splinePoseMatrices(
        motion.points, motion.cumulative, motion.length, motion.distance, motion.direction,
        motion.endMode, motion.orientationMode, motion.yawOffset, motion.instanceCount, motion.basis);
      setHostWorldMatrix(motion.host, matrices[0] ?? null);
      setHostWorldCopies(motion.host, matrices.length > 1 ? matrices.slice(1) : null);
      if (motion.finished) {
        disposeSplineLine(motion);
      }
      if (splineInspector?.host.key === motion.host.key) updateSplineInspectorPose(splineInspector, motion.distance);
    }
  }

  function stepSceneMotions(dt: number) {
    stepDynamicBodies(dt); stepPieceThrows(dt); stepFlexMotions(dt); stepSplineMotions(dt);
  }

  /** Write one sprite into the shared buffers at `cursor`, and say whether it took the slot. */
  function writeParticleSprite(particle: Particle, trail: number, cursor: number): boolean {
    const sampleAge = particle.age - trail * particle.trailStep;
    if (sampleAge < 0 || sampleAge >= particle.life) return false;
    const internalAge = sampleAge * particle.timeScale;
    const curvedAge = Math.min(2.7, internalAge);
    const curve = -0.73 * curvedAge + 0.113 * curvedAge * curvedAge;
    const at = particle.pos.copy(particle.origin)
      .addScaledVector(particle.linear, internalAge).addScaledVector(particle.curved, curve);
    const k = cursor * 3;
    positionBuffer[k] = at.x; positionBuffer[k + 1] = at.y; positionBuffer[k + 2] = at.z;
    const t = Math.max(0, Math.min(1, sampleAge / particle.life));
    const scaled = t * Math.max(0, particle.colors.length - 1);
    const si = Math.min(Math.max(0, particle.colors.length - 1), Math.floor(scaled));
    const sj = Math.min(Math.max(0, particle.colors.length - 1), si + 1);
    const f = scaled - si;
    const a = particle.colors[si], b = particle.colors[sj];
    // A darkening layer's colour never reaches the framebuffer on hardware, so the authored RGB is dropped
    // here exactly as the Unity importer drops it and alpha alone carries the plume.
    const keepColor = emitterBlendKeepsColor(particle.blend);
    colorBuffer[k] = keepColor ? THREE.MathUtils.lerp(a?.[0] ?? 0.7, b?.[0] ?? 0.7, f) : 0;
    colorBuffer[k + 1] = keepColor ? THREE.MathUtils.lerp(a?.[1] ?? 0.7, b?.[1] ?? 0.7, f) : 0;
    colorBuffer[k + 2] = keepColor ? THREE.MathUtils.lerp(a?.[2] ?? 0.7, b?.[2] ?? 0.7, f) : 0;
    const authoredAlpha = THREE.MathUtils.lerp(a?.[3] ?? 0.8, b?.[3] ?? 0.8, f);
    const previewAlpha = timerEmitterPreviewOpacity(authoredAlpha, particle.source !== 'ambient');
    const lifeFade = t < 0.08 ? t / 0.08 : t > 0.9 ? (1 - t) / 0.1 : 1;
    const trailFade = 1 - trail / Math.max(1, particle.trailCopies);
    alphaBuffer[cursor] = Math.max(0, Math.min(1.5, previewAlpha * lifeFade * trailFade));
    sizeBuffer[cursor] = particle.size;
    spriteBuffer[cursor] = particle.spriteIndex;
    return true;
  }

  function syncParticles() {
    stage.renderer.getDrawingBufferSize(drawingBufferSize);
    particleBatches.uniforms.halfViewportHeight.value = Math.max(1, drawingBufferSize.y * 0.5);
    // Two passes over the same list, because a draw range has to be contiguous: additive sprites first, then
    // the alpha-blended and darkening ones behind them.
    let cursor = 0;
    for (const particle of particles) {
      if (particle.blend !== 'additive') continue;
      for (let trail = 0; trail < particle.trailCopies && cursor < MAX_PARTICLE_SPRITES; trail++)
        if (writeParticleSprite(particle, trail, cursor)) cursor++;
    }
    const additiveCount = cursor;
    for (const particle of particles) {
      if (particle.blend === 'additive') continue;
      for (let trail = 0; trail < particle.trailCopies && cursor < MAX_PARTICLE_SPRITES; trail++)
        if (writeParticleSprite(particle, trail, cursor)) cursor++;
    }
    particleBatches.setDrawRanges(additiveCount, cursor - additiveCount);
  }

  function step(dt: number, cameraWorld: THREE.Vector3, riderWorld: THREE.Vector3 | null,
    playTarget: 'authored' | 'reference' | null, riderWorldVelocity?: THREE.Vector3 | null,
    riderCanTrigger = true) {
    dt = Math.max(0, Math.min(dt, 0.1));
    if (audioListener.parent !== stage.camera) stage.camera.add(audioListener);
    elapsed += dt;
    if (previewLoops.size && elapsed >= previewLoopNext) {
      for (const loop of previewLoops.values())
        scheduleGraph(loop.host, loop.graph, elapsed, 0, 'preview', true);
      previewLoopNext = elapsed + AMBIENT_REPEAT_SECONDS;
    }
    ambientScanElapsed += dt;
    if (ambientScanElapsed >= AMBIENT_SCAN_SECONDS) {
      ambientScanElapsed = 0;
      scanAmbientEmitters(cameraWorld);
    }
    if (playTarget && riderWorld) {
      if (activePlayTarget !== playTarget) {
        clearPlayRuntime(); activePlayTarget = playTarget; installPlayPersistent(playTarget);
        if (playTarget === 'reference') scheduleReferenceStartCountdown();
      }
      playWasRunning = true;
      riderVelocity.copy(riderWorldVelocity ?? new THREE.Vector3());
      if (riderCanTrigger) {
        scanElapsed += dt;
        if (scanElapsed >= TRIGGER_SCAN_SECONDS) { scanElapsed = 0; scanPlayTriggers(riderWorld, playTarget); }
      } else scanElapsed = 0;
    } else {
      // Only a PLAYER ride is torn down here, and the target is dropped with it rather than on every frame the
      // player happens not to be aboard. A field armed by `ensurePlayRuntime` has no rider to lose, so nulling
      // it unconditionally re-armed it on each AI contact — which cleared the runtime and rebuilt every counter
      // from scratch between one can and the next. That field is put away by endPlay(), on leaving Test.
      //
      // Equivalent for the player path: the branch above sets `activePlayTarget` and `playWasRunning` together,
      // so before this the flag was already true whenever the target was set.
      if (playWasRunning) {
        clearPlayRuntime();
        installWorldPersistentMotions();
        activePlayTarget = null;
      }
      playWasRunning = false;
    }
    // AFTER the block above, which is where `activePlayTarget` is established. Read before it, the first frame
    // of a Test run still saw the previous null and started the bed one frame late — and `setPlacedProps`
    // during a run drops the target, so the stale read could hold the bed silent rather than restarting it.
    //
    // Test only: placed ambience is a continuing bed of dozens of voices, and running it while the author is
    // building — panning the camera, dragging a gizmo — is noise nobody asked for. Hearing ONE emitter on
    // purpose is what the Props panel's loop button is for; the whole mountain sounding is a run-time fact.
    propSound.setAmbientEnabled(activePlayTarget !== null);
    propSound.step(dt, cameraWorld);
    runScheduledEffectGraphs(scheduled, elapsed, {
      condition: (host, node, meta) => conditionPass(host, node, meta.rideEvent),
      execute: (host, node, depth, meta) =>
        executeNode(host, node, depth, meta.source, meta.continuous, meta.subject, meta.cause, meta.rideEvent,
          meta.breakableResetAt, meta.collisionContact),
    });
    stepContinuousEmitters(dt);
    stepInteractionResets();
    stepSceneMotions(dt);
    stepPickupPops();
    if (previewSceneResetAt >= 0 && elapsed >= previewSceneResetAt) clearPreviewSceneRuntime();
    for (let i = particles.length - 1; i >= 0; i--) {
      const particle = particles[i];
      particle.age += dt;
      if (particle.age >= particle.life) { particles.splice(i, 1); continue; }
    }
    syncParticles();
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pulse = pulses[i];
      pulse.age += dt;
      if (pulse.age >= pulse.life) {
        disposePulse(i); continue;
      }
      const t = pulse.age / pulse.life;
      pulse.mesh.scale.setScalar(1 + t * 7);
      (pulse.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * 0.85;
    }
    selectedRing.rotation.z += dt * 0.7;
    selectedHalo.rotation.z -= dt * 1.1;
    // The reference may be dragged in Info mode while its effect stays selected.
    const selectedSource = data?.instances.find(instance => instance.index === selectedInstance);
    if (selectedSource) selected.position.copy(instanceLocalPosition(selectedSource));
  }

  /** Flight telemetry for shoved bodies: one sample per awake rigid body, plus one final sample as it sleeps.
   *  The ride session polls this each render frame while a capture may want it; an empty answer is free. */
  function shovedBodySamples(): RideShovedBodySample[] {
    const out: RideShovedBodySample[] = [];
    for (const body of dynamicBodies.values()) {
      if (!body.invInertia || !body.angular || !body.com) continue;
      if (body.asleepReported) continue;
      if (body.asleep) body.asleepReported = true;
      const ground = hooks.groundAt?.(body.host.object, body.com) ?? null;
      out.push({
        key: body.key, age: Math.round(body.age * 1000) / 1000,
        com: [body.com.x, body.com.y, body.com.z],
        velocity: [body.velocity.x, body.velocity.y, body.velocity.z],
        angular: [body.angular.x, body.angular.y, body.angular.z],
        groundY: ground ? ground.y : null,
        radius: body.radius ?? 0,
        asleep: !!body.asleep,
      });
    }
    return out;
  }

  return {
    /** Fat lines rasterise in pixels; the viewport's resize() feeds them the live canvas resolution. */
    get boostArrowMaterials() { return boostArrowLayer.materials; },
    setData, setAuthoredData, setWorldEffectsEnabled, setInspecting, selectInstance,
    /** Impact sources come from the same prop payload as the colliders. Effects data is deliberately not in
     * this path: it can arrive later or be absent while props and their native collision rows remain valid. */
    setReferencePropSounds(level: string, instances: readonly PropInstance[]) {
      const sources = referencePropSoundSources(level, instances);
      preloadPropAudio(sources.values());
      propSound.setReferenceSources(sources);
    },
    /** Install the reference level's placed-ambience emitters (`Sounds.ExternalSounds`). Cleared with a
     *  null/empty list when the reference is swapped out. */
    setPlacedAmbience(level: string, list: readonly AmbientSoundSource[]) {
      preloadAudio(list.map(source => ambientSoundUrl(level, source)).filter((url): url is string => !!url));
      propSound.setPlacedAmbience(level, list);
    },
    /** What the ambient bed is sounding right now, loudest first — Play diagnostics. */
    placedAmbienceVoices: () => propSound.ambientVoices(),
    preview, previewGraphs, previewAuthored, previewReferenceTimerNode, previewAuthoredTimerNode,
    stopPreview, isPreviewing, showSplineInspector, setSplineInspectorDistance, hideSplineInspector,
    referencePlayCounter: (instanceIndex: number) => playCounter(`reference:${instanceIndex}`),
    authoredPlayCounter: (propId: string) => playCounter(`authored:${propId}`),
    /** Whether Play owns the runtime right now, so a missing Counter can be reported as "Play is not
     *  running" rather than as "this Counter was never installed". */
    isPlaying: () => activePlayTarget !== null,
    step, beginPlay, endPlay, applyRideEvent, propCollision, shovedBodySamples, boostVolumeSpecs, resetVolumeKeys,
    modeDisabledRails,
    crackedSurfaceSpecs, onCrackedChange, onCrackedBreak,
    raceCountdown: () => referenceRaceCountdown(data),
    instanceWorldPosition(index: number): THREE.Vector3 | null {
      const instance = data?.instances.find(x => x.index === index);
      return instance ? instanceWorldPosition(instance) : null;
    },
  };
}

export type ReferenceEffectsLayer = ReturnType<typeof createReferenceEffectsLayer>;
