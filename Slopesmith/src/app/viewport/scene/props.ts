import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { PlacedProp, V3 } from '../../../core/doc/types';
import type { EffectsDocument } from '../../../core/effects/document';
import {
  authoredPropHasEffectCircumstance,
  authoredPropHoldsAtEnd,
  authoredPropMaterialControl,
  authoredPropMaterialEffects,
  effectAttachments,
} from '../../../core/effects/authoring';
import {
  animComboFromNode, animObjectFromNode, createAnimComboPlayback, createAnimObjectPlayback,
  createTriggeredAnimObjectPlayback, isAnimComboEffect,
  isTextureFlipPulse, retriggerTriggeredAnimObjectPlayback, stepAnimComboPlayback, stepAnimObjectPlayback,
  stepTriggeredAnimObjectPlayback, triggerAnimComboPlayback,
  type AnimComboPlayback, type AnimComboSample,
  type AnimObjectEffect, type AnimObjectPlayback, type MaterialControl, type TriggeredAnimObjectPlayback,
} from '../../../core/effects/world-effects';
import {
  isPropModelAnimation, samplePropModelCurve, samplePropModelRotation, samplePropModelTranslation,
  type PropModelAnimation, type PropModelClip,
} from '../../../core/reference/props';
import { facingArrowMaterial, facingArrowSegments } from './facing-arrows';
import type { GroupPropDef } from '../../../core/reference/groups';
import { propRigGlow } from '../../../core/reference/lights';
import { EFFECT_PROP_OVERLAY_RENDER_ORDER, PROP_RIG_MAX_BOOST } from '../constants';
import { placementQuat } from '../../../core/props/pose';
import type { PropAssets } from './prop-assets';
import type { LightsLayer } from './lights';
import type { Stage } from '../stage';
import type { ShadeMode } from '../types';
import { applyPropShade, disposePropShade, propContactTint, PROP_SHADE_TINT } from './prop-shade';
import type { RideObstacleSource } from '../../ride/physics';
import {
  authoredAmbientEmitter, authoredAmbientEvent, AUTHORED_AMBIENT_DEFAULT_M,
} from '../../../core/effects/external-sound';
import { soundRangeMaterial, soundRangeObject } from './sound-ranges';
import { clampEffectTriggerSize, isEffectTriggerProp } from '../../../core/effects/trigger-volume';
import { NATIVE_COLLISION_MODE, nativeContactState } from '../../../core/collision/native';
import { collisionProfileContactState, placedPropCollisionProfile, placedPropSolid } from '../../../core/props/contact';
import {
  createCollisionOverlay, UNITY_COLLISION_OVERLAY_COLOR, type CollisionOverlayMeshPiece,
} from './collision-overlay';
import type { EffectPieceMotion } from './reference-effects';

type PropArm = { level: string; model: number; baseOffset: number; group?: string };
type AnimatedPropMesh = { mesh: THREE.Mesh; object: number | null };
interface AnimatedPropTrack {
  clip: PropModelClip;
  meshes: AnimatedPropMesh[];
  ambient: { effect: AnimObjectEffect; playback: AnimObjectPlayback } | null;
  runtime: { effect: AnimObjectEffect; playback: AnimObjectPlayback } | null;
  preview: TriggeredAnimObjectPlayback | null;
  /** An explicit frame held by the Effects inspector's clip timeline. It outranks every player — scrubbing
   *  is the author asking to see one pose, so nothing may advance it out from under them. */
  scrub: number | null;
}
interface RuntimeProp {
  group: THREE.Group;
  base: THREE.Matrix4;
  tracks: AnimatedPropTrack[];
}

/**
 * Authored placed props (Props mode): one Group per placement (a per-member child Group of textured submeshes)
 * under `stage.worldRoot` in data coords, plus the armed model's translucent ghost, the single/multi selection
 * handles and the identify flash. Submesh geometry / group defs / outline edges come from the shared PropAssets
 * cache; the authored light rig (LightsLayer) tints billboards + lamps. The shell owns the input dispatch
 * (pickOrPlaceProp / the MMB prop-copy / the wheel-turn), reading this layer's public ghost + selection state.
 */
export function createPropsLayer(stage: Stage, assets: PropAssets, lights: LightsLayer) {
  const placedPropGroup = new THREE.Group();
  const collisionOverlay = createCollisionOverlay(stage.worldRoot);
  const unityCollisionOverlay = createCollisionOverlay(stage.worldRoot, {
    name: 'Selected Unity collider', activeColor: UNITY_COLLISION_OVERLAY_COLOR,
    inactiveColor: UNITY_COLLISION_OVERLAY_COLOR, unity: true,
  });
  let collisionOverlayWanted = true;
  let propsVisible = true;
  const soundRangeGroup = new THREE.Group();       // selected type-0 ambient listener radius (display only)
  const soundRangeMat = soundRangeMaterial();
  // A SURFACELESS model (an authored model with every quad carved away, or a retail model with no renderable
  // submeshes) would place as nothing — invisible and unclickable. Its placements render this stand-in
  // wireframe box instead (the Effects trigger-volume look, in a neutral grey), base-seated at the placement
  // origin in editor metres so the pose's yaw/scale apply like real geometry. Wireframe is a render mode
  // only — raycasts still hit the box faces, so the mesh carries userData.propIndex and picking/selection
  // work; it is never a Play collider.
  const placeholderGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const placeholderMat = new THREE.MeshBasicMaterial({ color: 0x9fb3c8, wireframe: true, transparent: true,
    opacity: 0.55, depthWrite: false, side: THREE.DoubleSide });
  const placeholderEdgeGeo = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(placeholderGeo));
  // Effects-authored trigger volumes are real generated box geometry (unlike the surfaceless-model stand-in):
  // the viewport uses it for selection and Test-mode contact, and export bakes the same centred unit box at
  // the authored size. Purple keeps it in the Effects visual language while the packed instance stays hidden.
  const effectTriggerGeo = new THREE.BoxGeometry(1, 1, 1);
  const effectTriggerMat = new THREE.MeshBasicMaterial({ color: 0x9b63ff, wireframe: true, transparent: true,
    opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
  const effectTriggerEdgeGeo = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(effectTriggerGeo));
  // Effects-mode decoration is deliberately outside placedPropGroup. Props-mode picking raycasts only
  // placedPropGroup, so showing/hiding effect hosts can never replace or intercept the normal prop meshes.
  const effectPropOutlineGroup = new THREE.Group();
  const effectRuntimeOutlines = new Map<string, { group: THREE.Group; base: THREE.Matrix4 }>();
  let placedPropMeshes: THREE.Object3D[] = [];      // per placement: its Group (sparse until geom loads)
  const runtimeProps = new Map<string, RuntimeProp>();
  const runtimePropVisibility = new Map<string, boolean>();
  // Mesh-throw is authored against native model-object ids. Keep its transient offsets outside the document
  // and outside userData: rebuilding Props discards these weak keys, while a Test reset can restore the exact
  // animation pose each shard had before the collision.
  const runtimePieceMotions = new WeakMap<THREE.Mesh, EffectPieceMotion>();
  const runtimePieceBases = new WeakMap<THREE.Mesh, THREE.Matrix4>();
  // Placements whose graph installs a material receiver, and the private material variants built for them.
  // A control message must reach only the prop it was sent to, so these never share the ambient cache entry.
  let controlledProps = new Map<string, MaterialControl>();
  const controlledPropMaterials = new Map<string, Set<THREE.Material>>();
  // Every placement's animated materials, controlled or shared. Preview needs to reach the shared ones too:
  // an ordinary scrolling prop keeps the ambient cache entry, and that entry is what its clock lives on.
  const effectPropMaterials = new Map<string, Set<THREE.Material>>();
  let worldEffectsEnabled = false;
  let selectedProp: number | null = null;
  let multiSelProps: number[] = [];
  let lastPlacedProps: PlacedProp[] = [];           // the doc props last rendered (marquee projection + centroid)
  /** The mountain's hit-gated claim order, so an uploaded WAV's region is drawn for the event it took over
   *  rather than for the -1 a file-backed emitter would otherwise read as. */
  let hitGatedClaims: readonly string[] = [];
  let effectPropsVisible = false;
  let effectPropIds = new Set<string>();
  let selectedEffectPropIds = new Set<string>();
  let effectTriggerMeshes: THREE.Mesh[] = [];        // authored trigger boxes draw only in Effects mode
  const multiHandleLast = new THREE.Vector3();      // the centre handle's data-space pos at the last gizmo report

  // Props placement mode: the armed model + a translucent ghost of it under the cursor, seated at the exact
  // pose a click will commit. The wheel turns the ghost (Shift+wheel resizes); a click places and the tool
  // stays armed (stamp more). Null = select mode.
  let propArm: PropArm | null = null;
  let propGhost: THREE.Group | null = null;         // the ghost meshes (under worldRoot, data coords)
  let propGhostHit: THREE.Vector3 | null = null;    // last terrain hit under the ghost (world coords)
  let pendingYaw = 0;                               // ghost turn — random per arm / drop, wheel adjusts
  let pendingScale = 1;                             // ghost size — Shift+wheel adjusts, kept across drops
  let yawManual = false;                            // wheel touched: keep the yaw across drops (no re-roll)

  let propGhostMats: THREE.Material[] = [];         // translucent material clones, disposed on rebuild
  const propMoveHandle = new THREE.Object3D();      // scene-root gizmo anchor for the selected prop
  let signTintMats: THREE.Material[] = [];          // per-rebuild billboard-tint material clones, disposed on rebuild
  // Where a prop reads the light on the ground beneath it; null = sun preview off, props on the studio rig.
  let groundLightAt: ((p: V3) => number | null) | null = null;
  // The last full rebuild's arguments, so a re-light can reproduce it without the caller re-supplying
  // selection / effects state it has no reason to still be holding.
  let lastPlacedArgs: {
    props: PlacedProp[]; selIdx: number | null; multiSel: number[];
    effects?: EffectsDocument | null; hiddenIndices?: ReadonlySet<number>;
  } | null = null;
  let flashBox: THREE.Box3Helper | null = null;     // the identify flash (a white box around one placement)
  let flashTimer = 0;

  // Face-normal arrows on the SELECTED placement (facing-arrows.ts) — the orientation instrument for
  // authored models AND the parity reference for retail ones. They ride the tile-orientation F toggle
  // (setNormalArrows): arrows are still built with each selection, only their visibility follows the flag,
  // so toggling F never forces a placement rebuild.
  const normalArrowMat = facingArrowMaterial();
  let normalArrowGeos: THREE.BufferGeometry[] = [];  // per-rebuild line buffers, disposed on rebuild
  let normalArrowObjs: THREE.Object3D[] = [];        // the live arrow objects, for the F-toggle flip
  let normalArrowsOn = false;

  /** The tile-orientation F toggle's prop half: facing arrows on the selected placement. */
  function setNormalArrows(on: boolean) {
    normalArrowsOn = on;
    for (const o of normalArrowObjs) o.visible = on;
  }

  /**
   * Arm placement mode with a model (or put it down with null). While armed, a translucent ghost of the
   * model rides the cursor over the terrain — seated by `baseOffset`×scale like the real drop — and a click
   * commits it at the ghost's exact pose (onPlaceProp). The turn starts random and re-rolls per drop until the
   * wheel takes manual control; the size persists across drops. (The shell drops the read-only ref selection.)
   */
  function setArmed(arm: PropArm | null) {
    const rearming = !!arm && (!propArm || propArm.level !== arm.level || propArm.model !== arm.model || propArm.group !== arm.group);
    propArm = arm;
    if (rearming) { pendingYaw = Math.random() * 360; yawManual = false; pendingScale = 1; }
    disposePropGhost();
    if (arm) buildPropGhost(); // hidden until the cursor hovers the terrain (seatPropGhost)
  }

  /** Build the armed model's ghost: its cached submeshes under translucent clones of their real materials,
   *  so the preview is the textured prop at half strength — for a group, the whole assembly. Never pickable. */
  function buildPropGhost() {
    if (!propArm) return;
    const members = assets.membersOf(propArm.level, propArm.model, '', propArm.group);
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    g.visible = false;
    let tris = 0; // renderable triangles across the members — 0 with cached geometry = surfaceless model
    for (const member of members) {
      const subs = assets.propGeom.get(`${propArm.level}:${member.model}`);
      if (!subs) continue; // the host loads geometry before arming; a miss just means no ghost for that member
      const child = new THREE.Group();
      child.matrixAutoUpdate = false;
      child.matrix.copy(assets.memberLocalMatrix(member));
      for (const sub of subs) {
        tris += sub.geometry.index?.count ?? 0;
        // A ghost deliberately owns translucent/no-depth state; do not let a later texture-alpha decode
        // replace that overlay state with the source material's opaque/cutout state.
        const m = assets.propTex.variant(assets.propTex.material(sub.level, sub.tex,
          undefined, [], undefined, { blend: sub.blend, priority: sub.prio,
            pixelAlpha: sub.pixelAlpha, alphaMode: sub.alphaMode,
            sheet: sub.sheet }), false); // shares the (maybe still loading) map
        m.transparent = true;
        m.opacity = 0.55;
        m.depthWrite = false;
        m.alphaHash = false; // opacity belongs to the ghost blend, not to cutout coverage
        m.needsUpdate = true;
        propGhostMats.push(m);
        const mesh = new THREE.Mesh(sub.geometry, m);
        mesh.raycast = () => { /* the ghost is never a pick target */ };
        child.add(mesh);
      }
      g.add(child);
    }
    if (!g.children.length) return;
    if (!tris) {
      // the armed model has no surfaces — preview the same stand-in box its placement will render
      const m = placeholderMat.clone();
      m.opacity = 0.3;
      propGhostMats.push(m);
      const mesh = new THREE.Mesh(placeholderGeo, m);
      mesh.raycast = () => { /* the ghost is never a pick target */ };
      g.add(mesh);
    }
    stage.worldRoot.add(g);
    propGhost = g;
    propGhostHit = null;
  }

  function disposePropGhost() {
    if (propGhost) { stage.worldRoot.remove(propGhost); propGhost = null; }
    for (const m of propGhostMats) m.dispose();
    propGhostMats = [];
    propGhostHit = null;
  }

  /** Seat the ghost at the last terrain hit under the cursor with the pending turn / size — the exact
   *  pose the committed placement will render with (its members already carry their local matrices). */
  function seatPropGhost() {
    const g = propGhost, arm = propArm, hit = propGhostHit;
    if (!g) return;
    if (!arm || !hit) { g.visible = false; return; }
    g.matrix.copy(placementPose({ pos: seatedDropPos(hit), yaw: pendingYaw, scale: pendingScale }));
    g.visible = true;
  }

  /** The seated data-space origin a drop at this terrain hit (world coords) commits: the click point with
   *  the model's base offset (scaled) taken out of the height, Z negated back to data. */
  function seatedDropPos(hit: THREE.Vector3): V3 {
    return stage.snapDataPoint([hit.x, hit.y - (propArm?.baseOffset ?? 0) * pendingScale, -hit.z]);
  }

  /** Props-mode hover (pointer already cast): track the terrain under the cursor and re-seat the ghost. */
  function updateGhost() {
    if (!propArm || !propGhost || !stage.terrainMesh) return;
    propGhostHit = stage.groundHit(); // BVH-accelerated: this runs on every pointer move (see Stage.groundHit)
    seatPropGhost();
  }

  // The placed props' materials follow the shade view — textured, neutral clay in Surface, triangle wires
  // in Wireframe. Visibility stays with the global props toggle alone, so wireframe view shows wire props.
  let shade: ShadeMode = 'textured';
  let placedPropDrawCount = 0;

  /** Show / hide the authored placed props (the global props toggle drives this alongside the reference props). */
  function setVisible(on: boolean) {
    propsVisible = on;
    placedPropGroup.visible = on;
    soundRangeGroup.visible = on;
    collisionOverlay.setVisible(on && collisionOverlayWanted);
    unityCollisionOverlay.setVisible(on && collisionOverlayWanted);
  }

  /** Visible authored prop submeshes; each is currently one ordinary draw object. */
  const currentRenderStats = { draws: 0 };
  function renderStats() {
    currentRenderStats.draws = placedPropGroup.visible ? placedPropDrawCount : 0;
    return currentRenderStats;
  }

  /** Props follow the shade view like the terrain: textured / neutral solid / triangle wires. */
  function setShadeMode(m: ShadeMode) {
    if (m === shade) return;
    shade = m;
    applyPropShade(placedPropGroup, shade);
    placedPropGroup.traverse(object => {
      const topology = object.userData.propSelectionTopology;
      if (topology === 'feature' || topology === 'wire') object.visible = topology === (shade === 'none' ? 'wire' : 'feature');
    });
  }

  /** A placement's authored pose (position + rotation + uniform scale) in data space, rendered under
   *  worldRoot. The rotation comes from the shared resolver (core/props/pose), the same one the export bake
   *  and the canonical instance read, so a tilted prop draws where it ships. */
  function placementPose(pp: { pos: V3; yaw: number; pitch?: number; roll?: number; scale: number }): THREE.Matrix4 {
    const [qx, qy, qz, qw] = placementQuat(pp);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(pp.pos[0], pp.pos[1], pp.pos[2]),
      new THREE.Quaternion(qx, qy, qz, qw),
      new THREE.Vector3(pp.scale, pp.scale, pp.scale),
    );
  }

  function propAnimObjectEffect(document: EffectsDocument | null | undefined,
    propId: string | undefined): AnimObjectEffect | null {
    if (!document || !propId) return null;
    const attachment = effectAttachments(document).find(item => item.enabled && item.target.id === propId);
    const slot = attachment ? document.slots.find(item => item.id === attachment.slot) : null;
    const graphId = slot?.circumstances.persistent;
    const graph = graphId ? document.graphs.find(item => item.id === graphId) : null;
    for (const node of graph?.nodes ?? []) {
      // A combo's idle window is an ordinary ambient clip; what makes it a combo is the SECOND window, which
      // waits for control command 3 [Trailmap: 230-level-ssf sub 258]. So it installs down the same path.
      const effect = animObjectFromNode(node) ?? animComboFromNode(node);
      if (effect) return effect;
    }
    return null;
  }

  interface HierarchyPoseCache {
    restInverse: THREE.Matrix4[];
    frame: number | null;
    deltas: THREE.Matrix4[];
  }
  const hierarchyPoseCache = new WeakMap<PropModelAnimation, HierarchyPoseCache>();

  function hierarchyLocalMatrix(animation: PropModelAnimation, objectIndex: number,
    frame: number | null): THREE.Matrix4 {
    const object = animation.objects[objectIndex];
    if (!object) return new THREE.Matrix4();
    if (frame === null || !object.channels?.some(curve => !!curve?.length))
      return new THREE.Matrix4().compose(new THREE.Vector3(...object.restPosition),
        new THREE.Quaternion(...object.restRotation), new THREE.Vector3(...object.restScale));
    // An animated object's ROTATION comes from its channels alone: a component with no curve is ZERO, not
    // its base value and not its rest value [Trailmap: 120-objects]. Translation still starts from the base.
    const position = new THREE.Vector3(...(object.basePosition ?? object.restPosition));
    const euler = new THREE.Vector3();
    for (let axis = 0; axis < 3; axis++) {
      const translation = object.channels[axis], rotation = object.channels[axis + 3];
      if (translation?.length) position.setComponent(axis, samplePropModelCurve(translation, frame));
      if (rotation?.length) euler.setComponent(axis, samplePropModelCurve(rotation, frame));
    }
    return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(euler.x), THREE.MathUtils.degToRad(euler.y), THREE.MathUtils.degToRad(euler.z), 'ZYX')),
    new THREE.Vector3(...object.restScale));
  }

  function hierarchyWorldMatrices(animation: PropModelAnimation, frame: number | null,
    basis?: readonly THREE.Matrix4[]): THREE.Matrix4[] {
    const world: (THREE.Matrix4 | undefined)[] = new Array(animation.objects.length);
    const visiting = new Set<number>();
    const resolve = (index: number): THREE.Matrix4 => {
      if (world[index]) return world[index]!;
      // An AnimCombo composes its triggered pose onto the one each part was holding when it fired, per part
      // and before the hierarchy is walked, exactly as the engine rewrites each part matrix in place.
      const own = hierarchyLocalMatrix(animation, index, frame);
      const held = basis?.[index];
      const local = held ? held.clone().multiply(own) : own;
      if (visiting.has(index)) return local;
      visiting.add(index);
      const parent = animation.objects[index]?.parent ?? -1;
      const result = parent >= 0 && parent < animation.objects.length && parent !== index
        ? resolve(parent).clone().multiply(local) : local;
      visiting.delete(index);
      return world[index] = result;
    };
    return animation.objects.map((_, index) => resolve(index));
  }

  function hierarchyDeltas(animation: PropModelAnimation, frame: number): THREE.Matrix4[] {
    let cache = hierarchyPoseCache.get(animation);
    if (!cache) {
      const rest = hierarchyWorldMatrices(animation, null);
      cache = { restInverse: rest.map(matrix => matrix.clone().invert()), frame: null,
        deltas: rest.map(() => new THREE.Matrix4()) };
      hierarchyPoseCache.set(animation, cache);
    }
    if (cache.frame !== frame) {
      cache.frame = frame;
      cache.deltas = hierarchyWorldMatrices(animation, frame)
        .map((matrix, index) => matrix.clone().multiply(cache!.restInverse[index]));
    }
    return cache.deltas;
  }

  /** The one (frame, basis) pair a running combo is drawing. Combos are one-shots, so this holds a single
   *  pair per clip rather than growing the table `hierarchyDeltas` keeps for ambient motion. */
  const comboDeltaCache = new WeakMap<PropModelAnimation, { frame: number; basis: number; deltas: THREE.Matrix4[] }>();

  function hierarchyComboDeltas(animation: PropModelAnimation, frame: number, basis: number): THREE.Matrix4[] {
    const cached = comboDeltaCache.get(animation);
    if (cached && cached.frame === frame && cached.basis === basis) return cached.deltas;
    hierarchyDeltas(animation, basis); // seeds restInverse
    const restInverse = hierarchyPoseCache.get(animation)!.restInverse;
    const held = animation.objects.map((_, index) => hierarchyLocalMatrix(animation, index, basis));
    const deltas = hierarchyWorldMatrices(animation, frame, held)
      .map((matrix, index) => matrix.clone().multiply(restInverse[index]));
    comboDeltaCache.set(animation, { frame, basis, deltas });
    return deltas;
  }

  const animationAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)] as const;
  function animationDelta(clip: PropModelClip, object: number | null, frame: number,
    basis: number | null = null): THREE.Matrix4 | null {
    if (isPropModelAnimation(clip)) {
      if (object === null) return null;
      const deltas = basis === null ? hierarchyDeltas(clip, frame) : hierarchyComboDeltas(clip, frame, basis);
      return deltas[object] ?? null;
    }
    const pose = (at: number) => {
      const translation = samplePropModelTranslation(clip, at);
      const move = new THREE.Matrix4().makeTranslation(translation[0], translation[1], translation[2]);
      return clip.axis === undefined ? move
        : move.multiply(new THREE.Matrix4().makeRotationAxis(animationAxes[clip.axis],
          THREE.MathUtils.degToRad(samplePropModelRotation(clip, at))));
    };
    return basis === null ? pose(frame) : pose(basis).multiply(pose(frame));
  }

  function applyAnimationTrack(track: AnimatedPropTrack, frame: number | null, basis: number | null = null) {
    for (const entry of track.meshes) {
      const base = frame === null ? new THREE.Matrix4()
        : animationDelta(track.clip, entry.object, frame, basis) ?? new THREE.Matrix4();
      const motion = runtimePieceMotions.get(entry.mesh);
      if (motion) {
        runtimePieceBases.set(entry.mesh, base.clone());
        applyRuntimePieceMotion(entry.mesh, base, motion);
      } else entry.mesh.matrix.copy(base);
      entry.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  /** Apply one mesh-throw sample in world space, then bring it back under the placed prop's parent. Geometry
   * stays authored in model coordinates, so rotating around its bounds centre makes a shard tumble around
   * itself instead of orbiting the placement origin. The full matrix conversion also preserves arbitrary
   * placement yaw and scale. */
  function applyRuntimePieceMotion(mesh: THREE.Mesh, base: THREE.Matrix4, motion: EffectPieceMotion) {
    const parent = mesh.parent;
    if (!parent) { mesh.matrix.copy(base); return; }
    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const localCentre = geometry.boundingSphere?.center ?? new THREE.Vector3();
    parent.updateWorldMatrix(true, false);
    const parentWorld = parent.matrixWorld.clone();
    const baseWorld = parentWorld.clone().multiply(base);
    const pivot = localCentre.clone().applyMatrix4(baseWorld);
    const effect = new THREE.Matrix4().makeTranslation(motion.offset.x, motion.offset.y, motion.offset.z)
      .multiply(new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z))
      .multiply(new THREE.Matrix4().makeRotationFromQuaternion(motion.rotation))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    mesh.matrix.copy(parentWorld.invert().multiply(effect).multiply(baseWorld));
  }

  /** Rig-glow tint for a placement without a billboard sign light: sample the authored rig at the leader
   *  member's bbox centre — so a group's own fixture light lights its lamp, and a free light colours the
   *  props near it. Undefined (no material clones) when the glow is negligible. */
  function placementGlowTint(pp: PlacedProp, leader: GroupPropDef): THREE.Color | undefined {
    const box = assets.propLocalBox(pp.level, leader.model);
    if (!box) return undefined;
    const c = new THREE.Vector3(
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ).applyMatrix4(assets.memberLocalMatrix(leader)).applyMatrix4(placementPose(pp));
    const [gr, gg, gb] = propRigGlow([c.x, c.y, c.z], lights.authoredRigData!);
    const M = PROP_RIG_MAX_BOOST;
    const t = new THREE.Color(
      1 + M * (1 - Math.exp(-gr)),
      1 + M * (1 - Math.exp(-gg)),
      1 + M * (1 - Math.exp(-gb)),
    );
    return t.r > 1.02 || t.g > 1.02 || t.b > 1.02 ? t : undefined;
  }

  /** Drop only the lightweight decoration attached to the existing placement meshes. The amber edge
   *  geometry comes from PropAssets and stays cached; only selected-facing arrow buffers are owned here. */
  function clearSelectionVisuals() {
    for (const root of placedPropMeshes) {
      if (!root) continue;
      for (const child of [...root.children]) {
        if (child.userData.propSelectionDecoration) root.remove(child);
      }
    }
    for (const g of normalArrowGeos) g.dispose();
    normalArrowGeos = [];
    normalArrowObjs = [];
    soundRangeGroup.clear();
    collisionOverlay.clear();
    unityCollisionOverlay.clear();
  }

  /** Draw the selected authored placement's configured contact shape using the same resources as Test mode. */
  function rebuildSelectedCollisionOverlay() {
    collisionOverlay.clear();
    unityCollisionOverlay.clear();
    if (selectedProp === null) return;
    const prop = lastPlacedProps[selectedProp], root = placedPropMeshes[selectedProp];
    if (!prop || !root) return;
    const effects = lastPlacedArgs?.effects;
    const collisionEffect = authoredPropHasEffectCircumstance(effects, prop.id, 'collision');
    const hitSound = typeof prop.collisionSound === 'number' || !!prop.collisionSoundFile;
    const profile = placedPropCollisionProfile(prop, collisionEffect, hitSound);
    const active = profile.playerCollision;
    if (profile.mode === NATIVE_COLLISION_MODE.none) return;

    stage.worldRoot.updateWorldMatrix(true, false);
    root.updateWorldMatrix(true, true);
    const parentInverse = stage.worldRoot.matrixWorld.clone().invert();
    const relativeMatrix = (world: THREE.Matrix4) => parentInverse.clone().multiply(world);
    const visualBounds = () => {
      const box = new THREE.Box3();
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)
          || (object as THREE.Mesh & { isLineSegments2?: boolean }).isLineSegments2) return;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (!object.geometry.boundingBox) return;
        object.updateWorldMatrix(true, false);
        box.union(object.geometry.boundingBox.clone().applyMatrix4(relativeMatrix(object.matrixWorld)));
      });
      return box;
    };

    if (profile.mode === NATIVE_COLLISION_MODE.triangleProxy) {
      const pieces: CollisionOverlayMeshPiece[] = [];
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)
          || (object as THREE.Mesh & { isLineSegments2?: boolean }).isLineSegments2
          || object.userData.propPlaceholder) return;
        object.updateWorldMatrix(true, false);
        pieces.push({ geometry: object.geometry, matrix: relativeMatrix(object.matrixWorld) });
      });
      collisionOverlay.showMeshes(pieces, active);
      return;
    }
    if (profile.mode === NATIVE_COLLISION_MODE.boundingBox) {
      // The collider is the MODEL's own box turned with the placement, not the axis-aligned envelope of the
      // turned result ([Trailmap: 130-mode2-oriented]). Drawing the envelope here was the picture that made a
      // grazing prop contact look inexplicable — it shows a shape metres bigger than the thing that collides.
      const local = new THREE.Box3();
      let placement: THREE.Matrix4 | null = null;
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)
          || (object as THREE.Mesh & { isLineSegments2?: boolean }).isLineSegments2
          || object.userData.propPlaceholder) return;
        if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
        if (!object.geometry.boundingBox) return;
        object.updateWorldMatrix(true, false);
        placement ??= relativeMatrix(object.matrixWorld);
        local.union(object.geometry.boundingBox);
      });
      if (placement && !local.isEmpty()) {
        collisionOverlay.showPrimitives({
          boxes: [{ center: local.getCenter(new THREE.Vector3()).toArray() as V3,
            size: local.getSize(new THREE.Vector3()).toArray() as V3 }],
          capsules: [],
        }, placement, active);
      }
      return;
    }
    if (profile.mode === NATIVE_COLLISION_MODE.physicsBodySpheres && profile.physicsSource) {
      const spheres = assets.physicsBody(profile.physicsSource.level, profile.physicsSource.body);
      if (spheres?.length) {
        let bodyMatrix: THREE.Matrix4 | null = null;
        root.traverse(object => {
          if (bodyMatrix || !(object instanceof THREE.Mesh)
            || (object as THREE.Mesh & { isLineSegments2?: boolean }).isLineSegments2
            || object.userData.propPlaceholder) return;
          object.updateWorldMatrix(true, false);
          bodyMatrix = relativeMatrix(object.matrixWorld);
        });
        if (bodyMatrix) collisionOverlay.showSpheres(spheres, bodyMatrix, active);
      }
      if (active) {
        // Unity represents this mode-3 placement with the baked visual bounds as an explicit proxy. Match its
        // 20 cm minimum thickness in the editor overlay.
        const box = visualBounds();
        if (!box.isEmpty()) {
          const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
          size.set(Math.max(size.x, 0.2), Math.max(size.y, 0.2), Math.max(size.z, 0.2));
          unityCollisionOverlay.showBox(new THREE.Box3().setFromCenterAndSize(center, size), true);
        }
      }
    }
  }

  function setCollisionOverlayVisible(on: boolean) {
    collisionOverlayWanted = on;
    collisionOverlay.setVisible(propsVisible && on);
    unityCollisionOverlay.setVisible(propsVisible && on);
    if (on && !collisionOverlay.group.children.length && !unityCollisionOverlay.group.children.length)
      rebuildSelectedCollisionOverlay();
  }

  /** Add the amber outline (and, for the single selection, facing arrows) beneath an already-built
   *  placement. Keeping this as a decoration child means it follows live gizmo movement without forcing the
   *  prop's textured submeshes or the rest of the mountain to be recreated. */
  function decorateSelection(index: number, single: boolean) {
    const pp = lastPlacedProps[index], root = placedPropMeshes[index];
    if (!pp || !root) return;
    const decoration = new THREE.Group();
    decoration.userData.propSelectionDecoration = true;
    if (isEffectTriggerProp(pp)) {
      const size = clampEffectTriggerSize(pp.effectTrigger.size);
      const line = new LineSegments2(effectTriggerEdgeGeo, assets.propOutlineMat);
      line.scale.set(size[0], size[1], size[2]);
      line.raycast = () => { /* clicks resolve on the trigger box, never its outline */ };
      decoration.add(line);
    }
    for (const m of isEffectTriggerProp(pp) ? [] : assets.membersOf(pp.level, pp.model, pp.name, pp.group)) {
      const subs = assets.propGeom.get(`${pp.level}:${m.model}`);
      if (!subs) continue;
      const child = new THREE.Group();
      child.matrixAutoUpdate = false;
      child.matrix.copy(assets.memberLocalMatrix(m));
      const geoms = subs.map(s => s.geometry);
      const featureEdges = assets.propEdges(pp.level, m.model, geoms);
      const triangleWires = assets.propWireEdges(pp.level, m.model, geoms);
      for (let i = 0; i < Math.max(featureEdges.length, triangleWires.length); i++) {
        for (const [geometry, topology] of [[featureEdges[i], 'feature'], [triangleWires[i], 'wire']] as const) {
          if (!geometry) continue;
          const line = new LineSegments2(geometry, assets.propOutlineMat);
          line.userData.propSelectionTopology = topology;
          line.visible = topology === (shade === 'none' ? 'wire' : 'feature');
          line.raycast = () => { /* clicks resolve on the prop meshes, never their outline */ };
          child.add(line);
        }
      }
      if (single) {
        const pts = facingArrowSegments(subs.map(s => s.geometry), assets.propLocalBox(pp.level, m.model));
        if (pts.length) {
          const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
          normalArrowGeos.push(g);
          const arrows = new THREE.LineSegments(g, normalArrowMat);
          arrows.renderOrder = 3;
          arrows.visible = normalArrowsOn;
          arrows.raycast = () => { /* never a pick target */ };
          normalArrowObjs.push(arrows);
          child.add(arrows);
        }
      }
      if (child.children.length) decoration.add(child);
    }
    if (root.userData.propPlaceholder) {
      // a surfaceless model has no mesh edges to outline — the amber selection edge rides its stand-in box
      const line = new LineSegments2(placeholderEdgeGeo, assets.propOutlineMat);
      line.raycast = () => { /* clicks resolve on the box mesh, never its outline */ };
      decoration.add(line);
    }
    if (decoration.children.length) root.add(decoration);
  }

  /** Change only prop-selection state and decoration. Selection is editor state, not a document mutation, so
   *  it must not enter renderDoc (which rebuilds terrain, every prop, lighting, persistence, and undo state). */
  function setSelection(selIdx: number | null, multiSel: number[] = []) {
    clearSelectionVisuals();
    selectedProp = selIdx !== null && selIdx >= 0 && selIdx < lastPlacedProps.length ? selIdx : null;
    multiSelProps = [...new Set(multiSel.filter(i => i >= 0 && i < lastPlacedProps.length && i !== selectedProp))];
    for (const i of multiSelProps) decorateSelection(i, false);
    if (selectedProp !== null) {
      decorateSelection(selectedProp, true);
      showAuthoredSoundRange(lastPlacedProps[selectedProp]);
      rebuildSelectedCollisionOverlay();
    }
    if (multiSelProps.length) {
      // Don't yank the handle mid-drag — the gizmo owns its position until the document render catches up.
      // A mixed Edit marquee owns a different shared centroid even between render frames; keep its prop
      // outlines current without letting the ordinary Props-family anchor replace it.
      if (stage.gizmoKind !== 'editmixed' && !(stage.gizmoKind === 'props' && stage.gizmo.dragging)) {
        placeMultiHandle();
        propMoveHandle.visible = true;
        if (stage.gizmoKind !== 'props') stage.attachGizmo(propMoveHandle, 'props', -1);
      }
    } else if (selectedProp !== null && placedPropMeshes[selectedProp]) {
      if (stage.gizmoKind !== 'editmixed' && !(stage.gizmoKind === 'prop' && stage.gizmo.dragging)) {
        placePropHandle(selectedProp);
        propMoveHandle.visible = true;
        if (stage.gizmoKind !== 'prop') stage.attachGizmo(propMoveHandle, 'prop', selectedProp);
      }
    } else {
      propMoveHandle.visible = false;
      if (stage.gizmoKind === 'prop' || stage.gizmoKind === 'props') stage.detachGizmo();
    }
  }

  /**
   * Re-read every placed prop's ground light and re-pick its material — the cheap path, so that dragging a
   * sun slider (which re-lights the terrain every frame) keeps props in step without rebuilding the scene.
   * Swapping to an already-cached bucket material is a pointer assignment; the rebuild it replaces would
   * re-walk every member model's submeshes.
   */
  function relightGround() {
    const placed = lastPlacedArgs?.props;
    if (!placed) return;
    for (const g of placedPropMeshes) {
      if (!g) continue;
      const pp = placed[g.userData.propIndex as number];
      if (!pp) continue;
      const gl = groundLightAt?.(pp.pos) ?? null;
      g.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (mesh.userData.propFullBright) return;   // emits; there is no key on it to re-scale
        const base = mesh.userData.propGroundBase as THREE.MeshLambertMaterial | null | undefined;
        if (base) mesh.material = gl !== null ? assets.propTex.groundLit(base, gl) : base;
        // a tinted billboard keeps its private variant either way; 1 is the unlit/no-sun value
        else assets.propTex.setKeyScale(mesh.material as THREE.Material, gl ?? 1);
      });
    }
  }

  /** Rebuild the placed-prop meshes from the doc, and keep the selected prop's gizmo + glow in sync. A prop
   *  whose model geometry isn't cached yet is skipped (the host re-renders once registerPropModels lands).
   *  A GROUP placement builds every member model under the one pose (docs/015). */
  function setPlacedProps(props: PlacedProp[], selIdx: number | null, multiSel: number[] = [],
    effects?: EffectsDocument | null, hiddenIndices?: ReadonlySet<number>) {
    clearSelectionVisuals();
    lastPlacedProps = props;
    lastPlacedArgs = { props, selIdx, multiSel, effects, hiddenIndices };
    disposePropShade(placedPropGroup);
    for (const m of placedPropMeshes) if (m) placedPropGroup.remove(m);
    placedPropMeshes = [];
    placedPropDrawCount = 0;
    effectTriggerMeshes = [];
    runtimeProps.clear();
    runtimePropVisibility.clear();
    controlledProps = new Map(props.flatMap(pp => {
      const control = pp.id ? authoredPropMaterialControl(effects, pp.id) : null;
      return control ? [[pp.id!, control] as const] : [];
    }));
    controlledPropMaterials.clear();
    effectPropMaterials.clear();
    for (const m of signTintMats) m.dispose();
    signTintMats = [];
    // a billboard lit by its sign light gets its tiles multiplied by a warm tint (sampled where the light
    // aims); every other placement samples the rig at its leader's bbox centre, so a free light colours the
    // props near it and a group's fixture light lights its own lamp — an unlit prop keeps shared materials
    const tintOf = new Map<number, THREE.Color>();
    const rigOn = !!lights.authoredRigData && lights.authoredLightsVisible;
    if (rigOn) {
      for (const L of lights.authoredLights) if (L.ofProp !== undefined && L.aimAt) tintOf.set(L.ofProp, lights.signTint(L.aimAt));
    }
    for (let i = 0; i < props.length; i++) {
      const pp = props[i];
      if (hiddenIndices?.has(i)) continue; // e.g. the edited model's own placements, which the substrate shows
      const worldEffect = authoredPropMaterialEffects(effects, pp.id);
      const members = assets.membersOf(pp.level, pp.model, pp.name, pp.group);
      // a placement is a pose Group of per-member child Groups of textured submeshes; the selected prop
      // keeps its tiles and gains an amber edge outline over them (lines ride the gizmo drag / rebuilds)
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(placementPose(pp));
      group.userData.propIndex = i;
      // The Surface view's contact colour for this placement, stamped once here so every submesh under it
      // follows (prop-shade.ts). Read straight off the authored profile: attachments only ever influenced
      // the LEGACY inference for documents saved before placements carried one, and re-deriving them per
      // frame here would cost an effects walk per prop to change nothing on a modern map.
      group.userData[PROP_SHADE_TINT] = propContactTint(
        collisionProfileContactState(placedPropCollisionProfile(pp)), pp.surface);
      const tint = tintOf.get(i) ?? (rigOn ? placementGlowTint(pp, members[0]) : undefined);
      // The light on the ground this prop stands on — the same field the export reads its per-instance key
      // from (docs/032 · lighting), so a prop in a cliff's shade previews as it ships. Null when the sun
      // preview is off, which leaves every prop on the studio rig.
      //
      // Sampled at `pos`, the model's ORIGIN, rather than the standing point the export seats probes at.
      // The two agree wherever the ground is a single sheet, because the sampler takes the nearest terrain
      // vertex in 3D rather than casting down: a tree whose origin sits 15 m inside the mountain still
      // resolves to the surface vertex above it. They can only diverge where the quilt folds over itself.
      const groundLight = groundLightAt?.(pp.pos) ?? null;
      let tris = 0; // renderable triangles across the members — 0 with cached geometry = surfaceless model
      const tracksByClip = new Map<PropModelClip, AnimatedPropMesh[]>();
      if (isEffectTriggerProp(pp)) {
        const size = clampEffectTriggerSize(pp.effectTrigger.size);
        const box = new THREE.Mesh(effectTriggerGeo, effectTriggerMat);
        box.scale.set(size[0], size[1], size[2]);
        box.userData.propIndex = i;
        box.userData.effectTrigger = true;
        box.visible = effectPropsVisible;
        effectTriggerMeshes.push(box);
        group.userData.effectTrigger = true;
        group.add(box);
        tris = 12;
      }
      for (const m of isEffectTriggerProp(pp) ? [] : members) {
        const modelKey = `${pp.level}:${m.model}`;
        const subs = assets.propGeom.get(modelKey);
        if (!subs) continue;
        const clip = assets.propClips.get(modelKey);
        const child = new THREE.Group();
        child.matrixAutoUpdate = false;
        child.matrix.copy(assets.memberLocalMatrix(m));
        for (const sub of subs) {
          tris += sub.geometry.index?.count ?? 0;
          const frames = worldEffect?.crowd ? sub.crowdFrames : sub.frames;
          const texture = frames[0] ?? sub.tex;
          const opts = { blend: sub.blend, priority: sub.prio,
            pixelAlpha: !!worldEffect?.crowd || sub.pixelAlpha, alphaMode: sub.alphaMode, sheet: sub.sheet };
          let mat: THREE.Material;
          // Resolved per MATERIAL, not per placement: a graph node may name the material it drives, which
          // is how one submesh of a multi-material prop scrolls while the rest stay still. An unscoped node
          // still covers everything, so every retail graph behaves exactly as before.
          // The ambient law first; failing that, the law of a receiver a graph installs on contact. A
          // ride-over button has only the latter, and it still needs the frames its pulse selects between.
          const control = pp.id ? controlledProps.get(pp.id) ?? null : null;
          const subEffect = authoredPropMaterialEffects(effects, pp.id, sub.mat) ?? control?.effect ?? null;
          // A controlled placement takes a material of its own, so a frame select paints the button that was
          // crossed rather than every prop that happens to share its texture — retail's per-node override.
          const base = assets.propTex.material(sub.level, texture, subEffect, frames,
            control ? pp.id : undefined, opts);
          if (control && pp.id) {
            const owned = controlledPropMaterials.get(pp.id);
            if (owned) owned.add(base); else controlledPropMaterials.set(pp.id, new Set([base]));
          }
          if (subEffect && pp.id) {
            const animated = effectPropMaterials.get(pp.id);
            if (animated) animated.add(base); else effectPropMaterials.set(pp.id, new Set([base]));
          }
          // Self-lit wins over both: the surface emits, so neither the sun's key nor a neighbouring sign
          // light's tint has anything to add to it — which is what the shipped instances say too, since a
          // full-bright one carries no key at all.
          if (pp.fullBright) mat = assets.propTex.fullBright(base);
          else if (tint) {
            const c = assets.propTex.variant(base);
            c.color.copy(tint);
            if (groundLight !== null) assets.propTex.setKeyScale(c, groundLight);
            signTintMats.push(mat = c);
          } else mat = groundLight !== null ? assets.propTex.groundLit(base, groundLight) : base;
          const mesh = new THREE.Mesh(sub.geometry, mat);
          if (clip) {
            mesh.matrixAutoUpdate = false;
            const animated = tracksByClip.get(clip) ?? [];
            animated.push({ mesh, object: sub.object ?? null });
            tracksByClip.set(clip, animated);
          }
          // The SHARED material this submesh would wear unlit, so a re-light can re-pick its ground-light
          // bucket without rebuilding the scene. Null for a tinted billboard: that one owns its variant
          // privately, and re-lighting it means setting its own key scale rather than swapping materials.
          mesh.userData.propGroundBase = tint || pp.fullBright ? null : base;
          mesh.userData.propFullBright = !!pp.fullBright; // a re-light must leave a self-lit surface alone
          mesh.userData.propIndex = i; // a raycast hit resolves the placement straight off the mesh
          mesh.userData.propTex = texture ?? null; // this submesh's frame-zero texture file — the paint
          mesh.userData.propTexLevel = sub.level;  // the paint sampler reads both straight off a raycast hit
          mesh.userData.propSurface = { tex: texture ?? null, blend: !!sub.blend,
            ...(sub.alphaMode ? { alphaMode: sub.alphaMode } : {}), prio: !!sub.prio,
            frames: frames.length, ...(frames.length ? { frameFiles: [...frames] } : {}),
            ...(subEffect?.textureFlip ? { flipbook: { ...subEffect.textureFlip } } : {}),
            // This describes the SUBMESH under the cursor, so it reports the submesh's own effect: on a
            // multi-material prop the plume scrolls and the bodywork does not, and clicking each should say so.
            scroll: !!subEffect?.uvScroll }; // appearance identity for inspection
          child.add(mesh);
        }
        group.add(child);
      }
      if (!group.children.length) continue; // geometry not cached yet — the host re-renders once it lands
      if (!tris) {
        // the model IS registered but has no surfaces — the stand-in box keeps the placement present:
        // visible, pickable (propIndex rides the mesh), flashable, and focusable like any other prop
        const box = new THREE.Mesh(placeholderGeo, placeholderMat);
        box.userData.propIndex = i;
        box.userData.propPlaceholder = true;
        group.userData.propPlaceholder = true;
        group.add(box);
      }
      placedPropGroup.add(group);
      placedPropMeshes[i] = group;
      if (pp.id) {
        const effect = propAnimObjectEffect(effects, pp.id);
        const tracks: AnimatedPropTrack[] = [...tracksByClip].map(([clip, meshes]) => ({
          clip, meshes, preview: null, runtime: null, scrub: null,
          ambient: effect ? { effect, playback: isAnimComboEffect(effect)
            ? createAnimComboPlayback(effect, clip.clipFrames, i + 1)
            : createAnimObjectPlayback(effect, clip.clipFrames, i + 1) } : null,
        }));
        runtimeProps.set(pp.id, { group, base: group.matrix.clone(), tracks });
      }
    }
    placedPropGroup.traverse(object => {
      if ((object as THREE.Mesh).isMesh) placedPropDrawCount++;
    });
    if (shade !== 'textured') applyPropShade(placedPropGroup, shade); // fresh meshes arrive textured
    rebuildEffectPropOutlines(props);
    setSelection(selIdx, multiSel);
  }

  /** The authored region, drawn from the authored numbers directly: `authoredAmbientEmitter` reads in editor
   *  metres, which is the space `prop.pos` is already in, so this needs no unit conversion (`unitScale` 1) and
   *  an ellipsoid's half-extents cannot land on the wrong axes on the way to the screen. */
  function showAuthoredSoundRange(prop: PlacedProp | undefined) {
    if (!prop || (!(typeof prop.ambientSound === 'number' && prop.ambientSound >= 0) && !prop.ambientSoundFile)) return;
    const emitter = authoredAmbientEmitter({
      event: authoredAmbientEvent(prop.ambientSound, prop.ambientSoundFile, hitGatedClaims),
      radius: prop.ambientRadius ?? AUTHORED_AMBIENT_DEFAULT_M,
      falloff: prop.ambientFalloff,
      halfExtents: prop.ambientHalfExtents,
    });
    const range = soundRangeObject(emitter, prop.pos, 1, soundRangeMat);
    if (range) soundRangeGroup.add(range);
  }

  /** Seat the scene-root gizmo handle at the multi-selection's centroid (data positions, Z negated onto the
   *  flip) and reset the delta baseline the next gizmo drag measures from. */
  function placeMultiHandle() {
    const sel = multiSelProps;
    if (!sel.length) return;
    let x = 0, y = 0, z = 0;
    for (const i of sel) { const p = lastPlacedProps[i].pos; x += p[0]; y += p[1]; z += p[2]; }
    x /= sel.length; y /= sel.length; z /= sel.length;
    propMoveHandle.position.set(x, y, -z);
    multiHandleLast.set(x, y, z);
  }

  /** Seat the scene-root gizmo handle on placed prop `i`'s origin (its data pos, Z negated onto the flip). */
  function placePropHandle(i: number) {
    const m = placedPropMeshes[i];
    if (!m) return;
    m.updateWorldMatrix(true, false);
    propMoveHandle.position.setFromMatrixPosition(m.matrixWorld); // world origin = (pos.x, pos.y, -pos.z)
  }

  /** Seat the translate gizmo on placed prop `i` and tell the host (which outlines it). The shell has
   *  cleared the other scene-object selections. */
  function seatProp(i: number) {
    setSelection(i);
    stage.cb.onSelectProp?.(i);
  }

  /** Drop any placed-prop selection (single or multi): hide the handle and release the gizmo if it was on it. */
  function clearSelection() {
    if (selectedProp === null && !multiSelProps.length && stage.gizmoKind !== 'prop' && stage.gizmoKind !== 'props') return;
    setSelection(null);
  }

  /** Identify flash: box placed prop `index` in white for a moment, so a click in the multi-selection list
   *  points out which placement in 3D it is. A new flash replaces the previous one. */
  function flashProp(index: number) {
    clearFlash();
    const m = placedPropMeshes[index];
    if (!m) return; // geometry not cached yet — nothing to box
    const box = new THREE.Box3().setFromObject(m); // world space, so the helper sits at scene root
    if (box.isEmpty()) return;
    flashBox = new THREE.Box3Helper(box, new THREE.Color(0xffffff));
    (flashBox.material as THREE.LineBasicMaterial).depthTest = false; // always readable, even into the slope
    flashBox.renderOrder = 15;
    stage.scene.add(flashBox);
    flashTimer = window.setTimeout(() => clearFlash(), 900);
  }

  function clearFlash() {
    clearTimeout(flashTimer);
    if (!flashBox) return;
    stage.scene.remove(flashBox);
    flashBox.geometry.dispose();
    (flashBox.material as THREE.Material).dispose();
    flashBox = null;
  }

  /** Rebuild the display-only effect outlines without touching the prop meshes used by normal picking. */
  function rebuildEffectPropOutlines(props: PlacedProp[]) {
    effectPropOutlineGroup.clear();
    effectRuntimeOutlines.clear();
    for (const pp of props) {
      if (!pp.id || !effectPropIds.has(pp.id)) continue;
      const group = new THREE.Group();
      group.matrixAutoUpdate = false;
      group.matrix.copy(placementPose(pp));
      const selected = selectedEffectPropIds.has(pp.id);
      let tris = 0; // renderable triangles across the members — 0 with cached geometry = surfaceless model
      if (isEffectTriggerProp(pp)) {
        const size = clampEffectTriggerSize(pp.effectTrigger.size);
        const line = new LineSegments2(effectTriggerEdgeGeo, selected ? assets.propOutlineMat : assets.effectOutlineMat);
        line.scale.set(size[0], size[1], size[2]);
        line.renderOrder = selected ? 100 : EFFECT_PROP_OVERLAY_RENDER_ORDER;
        line.raycast = () => { /* display-only sibling; never a prop pick target */ };
        group.add(line);
        tris = 12;
      }
      for (const m of isEffectTriggerProp(pp) ? [] : assets.membersOf(pp.level, pp.model, pp.name, pp.group)) {
        const subs = assets.propGeom.get(`${pp.level}:${m.model}`);
        if (!subs) continue;
        const child = new THREE.Group();
        child.matrixAutoUpdate = false;
        child.matrix.copy(assets.memberLocalMatrix(m));
        for (const sub of subs) tris += sub.geometry.index?.count ?? 0;
        for (const eg of assets.propEdges(pp.level, m.model, subs.map(s => s.geometry))) {
          const line = new LineSegments2(eg, selected ? assets.propOutlineMat : assets.effectOutlineMat);
          line.renderOrder = selected ? 100 : EFFECT_PROP_OVERLAY_RENDER_ORDER;
          line.raycast = () => { /* display-only sibling; never a prop pick target */ };
          child.add(line);
        }
        if (child.children.length) group.add(child);
      }
      if (group.children.length && !tris) {
        // a surfaceless placement has no mesh edges — the effect marker rides its stand-in box instead
        const line = new LineSegments2(placeholderEdgeGeo, selected ? assets.propOutlineMat : assets.effectOutlineMat);
        line.renderOrder = selected ? 100 : EFFECT_PROP_OVERLAY_RENDER_ORDER;
        line.raycast = () => { /* display-only sibling; never a prop pick target */ };
        group.add(line);
      }
      if (group.children.length) {
        effectPropOutlineGroup.add(group);
        effectRuntimeOutlines.set(pp.id, { group, base: group.matrix.clone() });
      }
    }
    effectPropOutlineGroup.visible = effectPropsVisible && effectPropOutlineGroup.children.length > 0;
  }

  /** Show every authored prop carrying an effect attachment as a thin purple map outline. */
  function showEffectProps(on: boolean, propIds: Iterable<string>, selectedPropIds: Iterable<string> = []) {
    const next = new Set(propIds);
    const selected = new Set(selectedPropIds);
    if (effectPropsVisible === on && next.size === effectPropIds.size
      && [...next].every(id => effectPropIds.has(id))
      && selected.size === selectedEffectPropIds.size
      && [...selected].every(id => selectedEffectPropIds.has(id))) return;
    effectPropsVisible = on;
    for (const mesh of effectTriggerMeshes) mesh.visible = on;
    effectPropIds = next;
    selectedEffectPropIds = selected;
    rebuildEffectPropOutlines(lastPlacedProps);
  }

  /** Play effects mutate only the rendered instance; authored document transforms remain untouched. */
  function setRuntimePropVisible(propId: string, visible: boolean | null) {
    const target = runtimeProps.get(propId);
    if (!target) return;
    if (visible === null) runtimePropVisibility.delete(propId); else runtimePropVisibility.set(propId, visible);
    target.group.visible = visible ?? true;
  }

  function setRuntimePropWorldMatrix(propId: string, matrix: THREE.Matrix4 | null) {
    const target = runtimeProps.get(propId);
    if (!target) return;
    if (matrix) {
      stage.worldRoot.updateWorldMatrix(true, false);
      target.group.matrix.copy(stage.worldRoot.matrixWorld.clone().invert().multiply(matrix));
    } else target.group.matrix.copy(target.base);
    target.group.matrixWorldNeedsUpdate = true;
    const outline = effectRuntimeOutlines.get(propId);
    if (outline) {
      outline.group.matrix.copy(matrix ? target.group.matrix : outline.base);
      outline.group.matrixWorldNeedsUpdate = true;
    }
  }

  /** Native model-object ids represented by this authored placement. Imported breakables deliberately carry
   * a one-frame hierarchy so each shard survives canonical export as a separate object and is addressable here. */
  function runtimePropPieceIds(propId: string): readonly number[] {
    const target = runtimeProps.get(propId);
    if (!target) return [];
    const ids = new Set<number>();
    for (const track of target.tracks) for (const entry of track.meshes)
      if (entry.object !== null) ids.add(entry.object);
    return [...ids].sort((a, b) => a - b);
  }

  /** Render-only shard poses for Test/Preview. Passing null restores the last underlying model-animation pose;
   * none of this mutates the placement, imported model, or exported effect graph. */
  function setRuntimePropPieceMotions(propId: string, motions: readonly EffectPieceMotion[] | null) {
    const target = runtimeProps.get(propId);
    if (!target) return;
    const byPiece = motions ? new Map(motions.map(motion => [motion.piece, motion])) : null;
    for (const track of target.tracks) for (const entry of track.meshes) {
      const motion = entry.object === null ? undefined : byPiece?.get(entry.object);
      if (motion) {
        if (!runtimePieceMotions.has(entry.mesh)) runtimePieceBases.set(entry.mesh, entry.mesh.matrix.clone());
        runtimePieceMotions.set(entry.mesh, motion);
        applyRuntimePieceMotion(entry.mesh, runtimePieceBases.get(entry.mesh) ?? new THREE.Matrix4(), motion);
      } else if (runtimePieceMotions.has(entry.mesh)) {
        entry.mesh.matrix.copy(runtimePieceBases.get(entry.mesh) ?? new THREE.Matrix4());
        runtimePieceMotions.delete(entry.mesh);
        runtimePieceBases.delete(entry.mesh);
      }
      entry.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  function resetRuntimeProps() {
    for (const [propId, { group, base }] of runtimeProps) {
      setRuntimePropPieceMotions(propId, null);
      group.visible = true; group.matrix.copy(base); group.matrixWorldNeedsUpdate = true;
    }
    for (const { group, base } of effectRuntimeOutlines.values()) {
      group.matrix.copy(base); group.matrixWorldNeedsUpdate = true;
    }
    for (const [propId, materials] of controlledPropMaterials) {
      const receiver = controlledProps.get(propId)?.receiver;
      if (receiver) for (const material of materials) assets.propTex.resetMaterialControl(material, receiver);
    }
    runtimePropVisibility.clear();
  }

  /** Reset one interaction-owned receiver without disturbing another prop whose timer is still live. */
  function resetRuntimePropEffects(propId: string): boolean {
    const target = runtimeProps.get(propId);
    if (!target) return false;
    let handled = false;
    const control = controlledProps.get(propId);
    if (control) for (const material of controlledPropMaterials.get(propId) ?? []) {
      assets.propTex.resetMaterialControl(material, control.receiver);
      handled = true;
    }
    for (const [index, track] of target.tracks.entries()) {
      if (track.preview) { track.preview = null; handled = true; }
      if (track.ambient && isAnimComboEffect(track.ambient.effect)) {
        track.ambient.playback = createAnimComboPlayback(track.ambient.effect, track.clip.clipFrames, index + 1);
        handled = true;
      }
      applyAnimationTrack(track, track.scrub ?? track.runtime?.playback.frame
        ?? (worldEffectsEnabled && track.ambient ? track.ambient.playback.frame : null));
    }
    return handled;
  }

  /** Deliver a bound property-node control message to one placed prop. The receiver its graph installed —
   *  not the command number — decides what the message means. */
  function controlRuntimePropProperty(propId: string, command: number, value: number): boolean {
    if (command === 3 && triggerPropCombo(propId)) return true;
    const control = controlledProps.get(propId);
    if (!control) return false;
    let handled = false;
    for (const material of controlledPropMaterials.get(propId) ?? [])
      handled = assets.propTex.controlMaterial(material, control.receiver, command, value) || handled;
    return handled;
  }

  /** Native control command 3: snapshot the pose and start the triggered window. Every track of the placement
   *  fires together — they are one prop's submeshes sharing one receiver, not independent players. */
  function triggerPropCombo(propId: string): boolean {
    const target = runtimeProps.get(propId);
    if (!target) return false;
    let handled = false;
    for (const track of target.tracks) {
      if (!track.ambient || !isAnimComboEffect(track.ambient.effect)) continue;
      handled = triggerAnimComboPlayback(track.ambient.playback as AnimComboPlayback) || handled;
    }
    return handled;
  }

  function propHasTriggerableCombo(propId: string): boolean {
    return !!runtimeProps.get(propId)?.tracks.some(track => isAnimComboEffect(track.ambient?.effect));
  }

  /** Does this placement's installed material property expire on its own? Only a finite-Length TextureFlip
   *  does, and the graph runner uses it to decide what Preview may run outside Test. */
  function propHasPulseProperty(propId: string): boolean {
    const control = controlledProps.get(propId);
    return control?.receiver === 'texture-flip' && isTextureFlipPulse(control.effect.textureFlip);
  }

  /** Run one placed prop's installed material law — its UV scroll or free-running flipbook — independently of
   *  the global Effects visibility toggle, the material half of the same Preview the model clip gets. */
  function previewMaterialEffect(propId: string): boolean {
    let started = false;
    for (const material of effectPropMaterials.get(propId) ?? [])
      started = assets.propTex.previewMaterialEffect(material) || started;
    return started;
  }

  /** Run one placed prop's embedded model clip independently of the global Effects visibility toggle. */
  function previewAnimObject(propId: string, effect: AnimObjectEffect,
    autoReturnDelay: number | null = null): boolean {
    const target = runtimeProps.get(propId);
    if (!target?.tracks.length) return false;
    // A play-once clip on an Effect-end-latched slot keeps its finished node in the game, so its final frame
    // holds until the player is explicitly cleared [Trailmap: 150-logic §slot-columns].
    const holdAtEnd = authoredPropHoldsAtEnd(lastPlacedArgs?.effects, propId)
      && effect.loopMode !== 1 && effect.loopMode !== 2;
    let seed = 0x811c9dc5;
    for (let i = 0; i < propId.length; i++) seed = Math.imul(seed ^ propId.charCodeAt(i), 0x01000193);
    for (const [index, track] of target.tracks.entries()) {
      if (autoReturnDelay !== null && track.preview
        && retriggerTriggeredAnimObjectPlayback(track.preview)) continue;
      track.preview = createTriggeredAnimObjectPlayback(effect, track.clip.clipFrames,
        (seed + index) >>> 0, holdAtEnd, autoReturnDelay);
    }
    return true;
  }

  function clearAnimObjectPreviews(): boolean {
    let had = false;
    for (const target of runtimeProps.values()) for (const track of target.tracks) {
      if (!track.preview) continue;
      track.preview = null; had = true;
      applyAnimationTrack(track, track.scrub ?? track.runtime?.playback.frame
        ?? (worldEffectsEnabled && track.ambient ? track.ambient.playback.frame : null));
    }
    return had;
  }

  function setWorldEffectsEnabled(on: boolean) {
    if (worldEffectsEnabled === on) return;
    worldEffectsEnabled = on;
    for (const target of runtimeProps.values()) for (const track of target.tracks) {
      if (track.preview || track.runtime || track.scrub !== null) continue;
      applyAnimationTrack(track, on && track.ambient ? track.ambient.playback.frame : null);
    }
  }

  function startRuntimeAnimObject(propId: string, effect: AnimObjectEffect): boolean {
    const target = runtimeProps.get(propId);
    if (!target?.tracks.length) return false;
    for (const [index, track] of target.tracks.entries()) track.runtime = {
      effect, playback: createAnimObjectPlayback(effect, track.clip.clipFrames, index + 1),
    };
    return true;
  }

  function clearRuntimeAnimObjects(): boolean {
    let had = false;
    for (const target of runtimeProps.values()) for (const track of target.tracks) {
      if (!track.runtime) continue;
      track.runtime = null; had = true;
      if (!track.preview) applyAnimationTrack(track, track.scrub
        ?? (worldEffectsEnabled && track.ambient ? track.ambient.playback.frame : null));
    }
    return had;
  }

  function stepWorldEffects(dt: number) {
    if (dt <= 0) return;
    for (const target of runtimeProps.values()) for (const track of target.tracks) {
      let frame: number | null;
      if (track.scrub !== null) continue;   // a held pose is the author's; no player may advance it
      if (track.preview) {
        const sample = stepTriggeredAnimObjectPlayback(track.preview, dt);
        frame = sample.frame;
        if (sample.done) {
          track.preview = null;
          frame = track.runtime?.playback.frame
            ?? (worldEffectsEnabled && track.ambient ? track.ambient.playback.frame : null);
        }
      } else if (track.runtime)
        frame = stepAnimObjectPlayback(track.runtime.playback, track.runtime.effect, dt);
      else if (track.ambient && isAnimComboEffect(track.ambient.effect)) {
        // A triggered combo runs whether or not the ambient Effects toggle is on: it is a one-shot the graph
        // asked for, not free-running motion. Its IDLE half still answers to the toggle.
        const playback = track.ambient.playback as AnimComboPlayback;
        if (!worldEffectsEnabled && !playback.active && !playback.latched) continue;
        const sample: AnimComboSample = stepAnimComboPlayback(playback, track.ambient.effect, dt);
        applyAnimationTrack(track, sample.frame, sample.basis);
        continue;
      } else if (worldEffectsEnabled && track.ambient)
        frame = stepAnimObjectPlayback(track.ambient.playback, track.ambient.effect, dt);
      else continue;
      applyAnimationTrack(track, frame);
    }
  }

  function propAnimObjectClip(propId: string): PropModelClip | null {
    return runtimeProps.get(propId)?.tracks[0]?.clip ?? null;
  }

  /**
   * Hold one placement's clip at an explicit frame for the Effects inspector's timeline, or release it
   * (`null`) back to whatever player owns the track — the graph preview, a Test run, or the always-on
   * ambient one. Returns false for a placement with no clip, which is what tells the inspector there is
   * no timeline to show.
   */
  function setPropAnimObjectScrubFrame(propId: string, frame: number | null): boolean {
    const target = runtimeProps.get(propId);
    if (!target?.tracks.length) return false;
    for (const track of target.tracks) {
      track.scrub = frame === null ? null
        : Math.min(track.clip.clipFrames, Math.max(0, frame));
      applyAnimationTrack(track, track.scrub ?? track.preview?.playback.frame
        ?? track.runtime?.playback.frame
        ?? (worldEffectsEnabled && track.ambient ? track.ambient.playback.frame : null));
    }
    return true;
  }

  function propWorldSphere(propId: string): THREE.Sphere | null {
    const target = runtimeProps.get(propId);
    if (!target) return null;
    target.group.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(target.group);
    return box.isEmpty() ? null : box.getBoundingSphere(new THREE.Sphere());
  }

  /** Snapshot the authored mountain's prop collision pieces for a Play run. Exact profiles follow
   * [Trailmap: 130-collision-data] unchanged; legacy placements retain their inferred Solid/effect behavior
   * until edited. Contact exists only when the selected shape and gates produce an eligible result. */
  function rideColliders(): RideObstacleSource[] {
    const out: RideObstacleSource[] = [];
    const effects = lastPlacedArgs?.effects;
    placedPropGroup.updateWorldMatrix(true, true);
    // A running clip writes each member's local matrix (applyAnimationTrack), so the member's own world
    // transform IS its live pose. Re-reading it per frame is what carries a moving prop's collider with it.
    const objectPose = (object: THREE.Object3D) => () => {
      object.updateWorldMatrix(true, false);
      return object.matrixWorld;
    };
    for (let i = 0; i < lastPlacedProps.length; i++) {
      const prop = lastPlacedProps[i], root = placedPropMeshes[i];
      if (!root) continue;
      const id = prop.id ?? `prop:${i}`;
      if (runtimePropVisibility.get(id) === false) continue;
      const native = prop.nativeCollision;
      if (native) {
        const donor = native.physicsSource;
        const spheres = donor ? assets.physicsBody(donor.level, donor.body) : null;
        const contact = nativeContactState({
          visible: true, playerCollision: native.playerCollision, playerBounce: native.playerBounce,
          mode: native.mode, responseMass: native.responseMass, hasTriangleProxy: native.mode === NATIVE_COLLISION_MODE.triangleProxy,
          hasPhysicsBody: !!spheres?.length,
        });
        if (contact === 'none') continue;
        const common = {
          key: `authored:${id}`, object: { kind: 'authored' as const, id },
          solid: contact === 'solid',
          bounce: native.playerBounce ? native.bounceAmount : 0,
          playerBounce: native.playerBounce,
          surface: typeof prop.surface === 'number' ? prop.surface : -1,
          // NativeCollisionProfile carries response state only. Per [Trailmap: 370-world-interaction], an authored Roller effect activates motion
          // separately; until that graph is joined here this collider remains static/pass-through as authored.
          dynamicMass: 0,
        };
        if (native.mode === NATIVE_COLLISION_MODE.physicsBodySpheres && spheres?.length) {
          let bodyObject: THREE.Object3D | null = null;
          root.traverse(object => {
            if (bodyObject || !(object instanceof THREE.Mesh) || object.userData.propPlaceholder
              || object.userData.propIndex !== i) return;
            object.updateWorldMatrix(true, false); bodyObject = object;
          });
          const body = bodyObject as THREE.Object3D | null;
          if (body) out.push({ ...common, spheres, matrixWorld: body.matrixWorld.clone(), liveMatrix: objectPose(body) });
          continue;
        }
        if (native.mode === NATIVE_COLLISION_MODE.boundingBox) {
          // A mode-2 collider is the MODEL's own local bounding box, held per model object and tested in the
          // placement's local frame — an oriented box tight to the art, not the instance's world AABB
          // [Trailmap: 130-mode2-oriented]. So this emits one box per mesh with its own geometry and world
          // matrix, exactly as the triangle-proxy branch below does, and the ride derives the local bounds.
          root.traverse(object => {
            if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
            // Selection outlines use LineSegments2, which inherits from Mesh. Only the authored render
            // submeshes carry this placement index; editor decoration must never become ride collision.
            if (object.userData.propPlaceholder || object.userData.propIndex !== i) return;
            object.updateWorldMatrix(true, false);
            out.push({ ...common, geometry: object.geometry, nativeBox: true,
              matrixWorld: object.matrixWorld.clone(), liveMatrix: objectPose(object) });
          });
          continue;
        }
        if (native.mode === NATIVE_COLLISION_MODE.triangleProxy) {
          root.traverse(object => {
            if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
            if (object.userData.propPlaceholder || object.userData.propIndex !== i) return;
            object.updateWorldMatrix(true, false);
            out.push({ ...common, geometry: object.geometry, matrixWorld: object.matrixWorld.clone(),
              liveMatrix: objectPose(object) });
          });
        }
        continue;
      }
      const trigger = isEffectTriggerProp(prop);
      const collisionEffect = authoredPropHasEffectCircumstance(effects, prop.id, 'collision');
      const hitSound = typeof prop.collisionSound === 'number' || !!prop.collisionSoundFile;
      const solid = !trigger && placedPropSolid(prop);
      if (!solid && !collisionEffect && !hitSound) continue;
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh) || !(object.geometry instanceof THREE.BufferGeometry)) return;
        // The empty-model stand-in and editor-owned Mesh subclasses are not authored collision geometry.
        if (object.userData.propPlaceholder || object.userData.propIndex !== i) return;
        object.updateWorldMatrix(true, false);
        out.push({
          key: `authored:${id}`, object: { kind: 'authored', id }, geometry: object.geometry,
          matrixWorld: object.matrixWorld.clone(), solid, liveMatrix: objectPose(object),
          bounce: solid ? (typeof prop.bounce === 'number' ? prop.bounce : 0.5) : 0,
          surface: solid && typeof prop.surface === 'number' ? prop.surface : -1,
        });
      });
    }
    return out;
  }

  stage.worldRoot.add(placedPropGroup); // authored placed props, data coords like the terrain
  stage.worldRoot.add(soundRangeGroup); // selected ambient range, in the same data-space frame
  effectPropOutlineGroup.visible = false;
  stage.worldRoot.add(effectPropOutlineGroup); // display-only Effects overlay, never part of prop picking
  propMoveHandle.visible = false;
  stage.scene.add(propMoveHandle); // scene-root anchor, Z negated by hand like the other nodes

  return {
    /** Point props at the terrain's baked ground light (null to put them back on the studio rig). */
    setGroundLightSource(fn: ((p: V3) => number | null) | null): void {
      groundLightAt = fn;
      relightGround();
    },
    relightGround,
    get placedPropGroup() { return placedPropGroup; },
    get placedPropMeshes() { return placedPropMeshes; },
    get selectedProp() { return selectedProp; },
    get multiSelProps() { return multiSelProps; },
    get lastPlacedProps() { return lastPlacedProps; },
    get multiHandleLast() { return multiHandleLast; },
    get propArm() { return propArm; },
    get propGhost() { return propGhost; },
    get propGhostHit() { return propGhostHit; },
    set propGhostHit(v: THREE.Vector3 | null) { propGhostHit = v; },
    get pendingYaw() { return pendingYaw; },
    set pendingYaw(v: number) { pendingYaw = v; },
    get pendingScale() { return pendingScale; },
    set pendingScale(v: number) { pendingScale = v; },
    get yawManual() { return yawManual; },
    set yawManual(v: boolean) { yawManual = v; },
    setArmed, seatPropGhost, seatedDropPos, updateGhost, setVisible, setShadeMode, placementPose, rideColliders,
    renderStats,
    /** Install the mountain's hit-gated claim order; the selected prop's region redraws against it. */
    setHitGatedSounds(claims: readonly string[] | undefined) { hitGatedClaims = claims ?? []; },
    setPlacedProps, setSelection, seatProp, clearSelection, flashProp, showEffectProps, setCollisionOverlayVisible,
    setRuntimePropVisible, setRuntimePropWorldMatrix, runtimePropPieceIds, setRuntimePropPieceMotions,
    resetRuntimeProps,
    controlRuntimePropProperty, resetRuntimePropEffects, propHasPulseProperty, propHasTriggerableCombo,
    previewAnimObject, previewMaterialEffect, clearAnimObjectPreviews, startRuntimeAnimObject, clearRuntimeAnimObjects,
    setWorldEffectsEnabled, stepWorldEffects, propAnimObjectClip, setPropAnimObjectScrubFrame,
    propWorldSphere, setNormalArrows,
  };
}

export type PropsLayer = ReturnType<typeof createPropsLayer>;
