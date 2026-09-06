import * as THREE from 'three';
import { MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import type { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { V3 } from '../../../core/doc/types';
import {
  isPropModelAnimation, propModelAnimationChannels, samplePropModelRotation,
  samplePropModelTranslation, type LevelProps, type PropInstance, type PropModelClip,
} from '../../../core/reference/props';
import {
  referenceAnimComboEffects, referenceAnimDeltaEffects, referenceAnimObjectEffects, referenceMaterialControls,
  referenceMaterialWorldEffects,
  referenceImmediateBreakInstances, referenceInstanceBindings, referenceSlot,
  type ReferenceEffectsData, type ReferenceMaterialControl,
} from '../../../core/reference/effects';
import {
  animObjectEffectKey, crackedMaterialControlFromGraph, createAnimComboPlayback, createAnimDeltaPlayback,
  createAnimObjectPlayback, createTriggeredAnimObjectPlayback, grantAnimDeltaPlayback, isAnimComboEffect,
  isTextureFlipPulse, materialWorldEffectsKey, retriggerTriggeredAnimObjectPlayback,
  stepAnimComboPlayback, stepAnimDeltaPlayback,
  stepAnimObjectPlayback, stepTriggeredAnimObjectPlayback, triggerAnimComboPlayback,
  type AnimComboEffect, type AnimComboPlayback,
  type AnimDeltaPlayback, type AnimObjectEffect, type AnimObjectPlayback, type MaterialWorldEffects,
  type TriggeredAnimObjectPlayback,
} from '../../../core/effects/world-effects';
import { propRigGlow, type LightRig } from '../../../core/reference/lights';
import { editorFromRaw } from '../../../core/reference/terrain';
import {
  EDIT_EDGE_SEL_COLOR, EFFECT_PROP_OVERLAY_RENDER_ORDER, RAW_TO_EDITOR, REF_TRICK_MODEL_RE, PROP_RIG_MAX_BOOST,
} from '../constants';
import { addLightGizmo, lightAimTarget } from '../gizmo/geometry';
import type { PropAssets } from './prop-assets';
import { facingArrowMaterial, facingArrowSegments } from './facing-arrows';
import type { Stage } from '../stage';
import type { RefPropSurfaceDetails, ShadeMode } from '../types';
import { isAnimatedPropMaterial, isSingleFacingSheet, propLightIndexColor } from '../../props/textures';
import { applyPropShade, disposePropShade, propContactTint, PROP_CLAY_COLOR, PROP_SHADE_TINT } from './prop-shade';
import { collisionProfileContactState, collisionProfileFromSourceInstance } from '../../../core/props/contact';
import type { RideObstacleSource } from '../../ride/physics';
import { soundRangeMaterial, soundRangeObject } from './sound-ranges';
import { disposeSourceMarkerPoints, setSourceMarkerSelected, sourceMarkerPoints, type SourceMarkerKind } from './source-markers';
import {
  createCollisionOverlay, UNITY_COLLISION_OVERLAY_COLOR, type CollisionOverlayMeshPiece,
} from './collision-overlay';
import { scaleBodyShape, unityBodyRecipeKind } from '../../../core/collision/unity-body';
import {
  isReferencePropMesh, MergedStaticPropMesh, referencePropGeometry, referencePropSlot,
  type ReferencePropMesh, type ReferencePropSlot,
} from './reference-prop-mesh';
import { createReferenceCourseDecor } from './reference-decor-course';
import { hiddenMatrix, hierarchyComboPose, hierarchyPose } from './reference-decor-pose';

/**
 * The loaded reference world's DECORATIONS — everything placed IN the reference level, parented under
 * `stage.refRoot` so it rides the reference terrain's chirality flip + placement offset: its scenery props and
 * rail/gem trick models (static opaque submeshes batched by material, split by name so the Props / Tricks view filters
 * govern their own halves), its light/sound source icons + selected rig/range, the
 * per-instance rig tint (a sign light warming the billboard it aims at), its recovered main course line
 * (drawn in the authored guide's style, shown with the Info-mode course guide), its AI-path network
 * (AIP.json, on the Info "Show AI paths" toggle), and the read-only amber outline on a clicked reference
 * prop. Purely a renderer of the reference's own data — it reads the shared PropAssets cache
 * but owns no view-mode / selection orchestration (the shell's selectReferenceProp clears the other selections
 * and calls `selectPropInstance`). The reference TERRAIN view (mesh / cage / F) lives in the shell.
 */
export function createReferenceDecor(stage: Stage, assets: PropAssets) {
  // BatchedMesh only collapses CPU submissions when the browser exposes WEBGL_multi_draw. Three otherwise loops
  // every heterogeneous slot, often producing MORE calls than the former model-level InstancedMeshes. Tests and
  // small embedders without a renderer retain the native path; a real unsupported renderer gets a merged fallback.
  const nativeMultiDraw = stage.renderer ? stage.renderer.extensions.has('WEBGL_multi_draw') : true;
  const refPropsGroup = new THREE.Group();       // scenery instances (Props filter)
  const refTrickModelsGroup = new THREE.Group(); // rail / gem models (Tricks filter)
  const refEffectPropsGroup = new THREE.Group(); // faint, pickable attached-effect hosts in Reference Effects
  const refAnimPathGroup = new THREE.Group();    // read-only recovered model-clip trajectory in Effects
  const refEffectPropMat = new THREE.MeshBasicMaterial({
    color: 0xb66cff, wireframe: true, transparent: true, opacity: 0.72, depthWrite: false,
  });
  const refAnimPathMat = new THREE.LineBasicMaterial({
    color: 0x56c9ff, transparent: true, opacity: 0.9, depthTest: false,
  });
  const refAnimKeyMat = new THREE.PointsMaterial({
    color: 0xa8e8ff, size: 5, sizeAttenuation: false, depthTest: false,
  });
  const refAnimPlayheadMat = new THREE.MeshBasicMaterial({ color: 0xffc45a, depthTest: false });
  let refAnimPathSource: number | null = null;
  let refAnimPlayhead: THREE.Mesh | null = null;
  const refSourcesGroup = new THREE.Group();     // clickable Lights.json bulbs + prop-attached sound speakers
  const refSourceDetailGroup = new THREE.Group();// the one selected light rig or listener range
  let refLightMarkers: THREE.Points | null = null;
  let refSoundMarkers: THREE.Points | null = null;
  const refPropSel = new THREE.Group();          // amber outline seated at the selected reference prop instance
  const collisionOverlay = createCollisionOverlay(stage.refRoot);
  const unityCollisionOverlay = createCollisionOverlay(stage.refRoot, {
    name: 'Selected Unity collider', activeColor: UNITY_COLLISION_OVERLAY_COLOR,
    inactiveColor: UNITY_COLLISION_OVERLAY_COLOR, unity: true,
  });
  let selectedColliderInstance: PropInstance | null = null;
  // The always-on Effects proxy occupies the same surface as this outline. Give the selected reference prop a
  // dedicated top-layer material so its amber state cannot be depth-merged back into the purple map overlay.
  const refPropSelectionMat = assets.propOutlineMat.clone();
  refPropSelectionMat.depthTest = false;
  const refArrowMat = facingArrowMaterial();     // facing arrows over the highlighted instance (F toggle)
  let refArrowGeos: THREE.BufferGeometry[] = [];
  let refArrowObjs: THREE.Object3D[] = [];
  let refArrowsOn = false;
  // Paint-mode surface inspection: a selection-yellow outline around JUST the clicked material submesh (a model can
  // carry several, one texture each — this marks which one the palette readout describes). A reference hit
  // seats the lines at the clicked instance's matrix; an authored placed prop attaches them as a child of
  // the hit mesh instead, so they ride its pose and a props rebuild discards them with it.
  const surfInspectMat = new THREE.LineBasicMaterial({ color: EDIT_EDGE_SEL_COLOR, transparent: true, opacity: 0.95, depthTest: false });
  const surfInspectGroup = new THREE.Group();
  let surfInspectObjs: THREE.LineSegments[] = [];
  let surfInspectGeos: THREE.BufferGeometry[] = [];
  const externalSoundRangeMat = soundRangeMaterial();
  const rideBoxGeo = new THREE.BoxGeometry(1, 1, 1); // shared mode-2 Play collider; pose supplies centre + size
  let refPropHighlightOwner: 'props' | 'effects' | null = null;
  let refPropMeshes: ReferencePropMesh[] = []; // every prop draw batch (for rig re-tint and disposal)
  let refEffectPropMeshes: ReferencePropMesh[] = [];
  interface RuntimeInstanceEntry {
    sourceIndex: number;
    mesh: ReferencePropMesh;
    instanceId: number;
    geometry: THREE.BufferGeometry;
    level: string;
    model: number;
    name: string;
    object: number | null;
    base: THREE.Matrix4;
    defaultVisible: boolean;
    proxy: boolean;
    piece: number | null;
    piecePivot: THREE.Vector3 | null;
    /** Model-space pose delta applied after the instance transform. Null is the exact baked rest pose. */
    animationDelta: THREE.Matrix4 | null;
  }
  interface RuntimePieceMotion {
    piece: number;
    offset: THREE.Vector3;
    rotation: THREE.Quaternion;
  }
  const runtimeEntries = new Map<number, RuntimeInstanceEntry[]>();
  /**
   * Native mode-1 proxy meshes follow the model's non-empty ModelObjects in object order. A hierarchical clip
   * keeps that object id on every rendered submesh, so collapse repeated material entries to one pose carrier
   * per object and bind the proxy list to those carriers. Require an exact count: compact/static models do not
   * retain object ids, and an incomplete extraction is safer on the established whole-instance fallback than on
   * a guessed partial alignment.
   */
  function collisionModelEntries(entries: readonly RuntimeInstanceEntry[], count: number): RuntimeInstanceEntry[] | null {
    const byObject = new Map<number, RuntimeInstanceEntry>();
    for (const entry of entries) if (entry.object !== null && !byObject.has(entry.object))
      byObject.set(entry.object, entry);
    if (byObject.size !== count) return null;
    return [...byObject].sort(([a], [b]) => a - b).map(([, entry]) => entry);
  }
  const runtimeVisibility = new Map<number, boolean>();
  const runtimeMatrices = new Map<number, THREE.Matrix4>();
  const runtimePieceMotions = new Map<number, Map<number, RuntimePieceMotion>>();
  /** Monotonic per-instance pose stamps, bumped by the two funnels every live-pose mutation runs through
   *  (`applyRuntimeInstance`, `setAnimatedFrame`). The ride's collider refit reads the stamp instead of
   *  recomposing thousands of unchanged world matrices a frame to discover that nothing moved. */
  const runtimePoseVersions = new Map<number, number>();
  const bumpRuntimePose = (sourceIndex: number) =>
    runtimePoseVersions.set(sourceIndex, (runtimePoseVersions.get(sourceIndex) ?? 0) + 1);
  interface RuntimeInstanceCopyDraw {
    entry: RuntimeInstanceEntry;
    mesh: THREE.InstancedMesh;
  }
  interface RuntimeInstanceCopies {
    count: number;
    worldMatrices: THREE.Matrix4[];
    draws: RuntimeInstanceCopyDraw[];
  }
  /** Render-only copies made by a spline effect's InstanceCount. They intentionally have no native source ids,
   * collision bodies, or pick targets: all copies belong to the one Instances.json placement that owns the model. */
  const runtimeInstanceCopies = new Map<number, RuntimeInstanceCopies>();
  interface AnimatedMesh {
    mesh: THREE.InstancedMesh;
    sourceIndices: number[];
    clip: PropModelClip;
    /** Native ModelObjects[] index for a hierarchical clip; null for the compact merged clip. */
    object: number | null;
    /** Ambient receiver law when the instance owns one; null still leaves the recovered model clip previewable. */
    effect: AnimObjectEffect | null;
    deltaGated: boolean;
    playbacks: Array<AnimObjectPlayback | AnimDeltaPlayback | AnimComboPlayback | null>;
  }
  let refAnimatedMeshes: AnimatedMesh[] = [];
  let refPropData: LevelProps | null = null;
  let refMaterialEffects = new Map<number, MaterialWorldEffects>();
  let refMaterialControls = new Map<number, ReferenceMaterialControl>();
  const refControlledMaterials = new Map<number, Set<THREE.Material>>();
  // Every instance's animated materials, shared bucket entries included — what Preview ungates to run a
  // native scroller such as the Merqury City river without turning the whole mountain's motion on.
  const refEffectMaterials = new Map<number, Set<THREE.Material>>();
  let refAnimObjectEffects = new Map<number, AnimObjectEffect>();
  let refAnimDeltaEffects = new Map<number, AnimObjectEffect>();
  let refAnimComboEffects = new Map<number, AnimComboEffect>();
  let refImmediateBreaks = new Set<number>();
  /** Instances whose slot populates the Effect-end latch (column 4): a finished play-once clip keeps its
   * node, so the pose holds at the last frame instead of reverting [Trailmap: 150-logic §slot-columns]. */
  let refHoldAtEnd = new Set<number>();
  const animObjectPreviews = new Map<number, TriggeredAnimObjectPlayback>();
  const animObjectScrubs = new Map<number, number>();
  let worldEffectsEnabled = false;
  let refLightData: LightRig | null = null;
  let refLightSources: LightRig['lights'] = [];
  interface RefSoundSource {
    inst: PropInstance;
    emitter: PropInstance['externalSounds'][number];
    modelName: string;
  }
  let refSoundSources: RefSoundSource[] = [];
  interface RefHiddenProp {
    inst: PropInstance;
    modelName: string;
  }
  let refHiddenProps: RefHiddenProp[] = []; // placements with nothing visible to click (hidden / surfaceless)
  let refPropMarkers: THREE.Points | null = null;
  let selectedSource: { kind: SourceMarkerKind; index: number } | null = null;
  let refPropsVisible = false;
  let refTricksVisible = false;
  let refEffectPropsVisible = false;
  interface PropRenderStats {
    batchDraws: number;
    batchSlots: number;
    isolatedDraws: number;
    isolatedSlots: number;
    isolatedByKind: Map<string, number>;
  }
  const emptyRenderStats = (): PropRenderStats => ({
    batchDraws: 0, batchSlots: 0, isolatedDraws: 0, isolatedSlots: 0, isolatedByKind: new Map(),
  });
  let propsRenderStats = emptyRenderStats(), tricksRenderStats = emptyRenderStats();
  let decorShade: ShadeMode = 'textured'; // the props/tricks groups follow the shade view like the terrains
  let effectPropIndices = new Set<number>();
  let refLightsVisible = false;                  // retained persistence name; now gates the Sources layer
  let propRig: LightRig | null = null;           // the reference level's own rig, tinting its props
  let propRigStrength = 0;
  const tintedPropMeshes = new WeakSet<ReferencePropMesh>();
  interface HighlightedProp {
    mesh: ReferencePropMesh;
    instanceId: number;
    sourceIndex: number;
    outline: THREE.Group;
  }
  let highlightedProps: HighlightedProp[] = [];
  let propsBuildGeneration = 0;

  /**
   * Show the loaded reference's placed props, or clear them with `null`. One InstancedMesh per prop model; each
   * instance's matrix is RAW_TO_EDITOR × compose(Location, Rotation, Scale), so a prop lands in the same native
   * editor frame as the reference terrain (refRoot then supplies the game-chirality flip for both). Model
   * vertices stay model-local cm — RAW_TO_EDITOR's 1/100 scales them to metres along with the placement.
   *
   * A model is routed by name: rail / gem models (the trick layer — REF_TRICK_MODEL_RE) go to the Tricks-gated
   * refTrickModelsGroup, the scenery (trees / boulders / banners / fences / …) to refPropsGroup, so the Props
   * and Tricks view filters govern their own halves. Each group's visibility follows its last show* toggle.
   */
  function* setPropsSteps(props: LevelProps | null, generation: number, deferMergedBounds = false): Generator<void> {
    const replacingLevel = props !== refPropData;
    const hadPropSelection = refPropHighlightOwner === 'props';
    clearSourceSelection();
    clearPropHighlight(); // the outlined instance (if any) is going away with the rebuild
    clearSurfaceInspection(); // so is any paint-mode inspected submesh
    if (hadPropSelection) stage.cb.onSelectReferenceProp?.(null, null, null);
    clearAllRuntimeInstanceCopies();
    disposePropShade(refPropsGroup);
    disposePropShade(refTrickModelsGroup);
    for (const mesh of [...refPropMeshes, ...refEffectPropMeshes]) {
      if (mesh instanceof THREE.BatchedMesh || mesh instanceof MergedStaticPropMesh) mesh.dispose();
      else mesh.geometry.dispose();
    }
    refPropsGroup.clear();
    refTrickModelsGroup.clear();
    refEffectPropsGroup.clear();
    propsRenderStats = emptyRenderStats();
    tricksRenderStats = emptyRenderStats();
    refPropMeshes = [];
    refEffectPropMeshes = [];
    refAnimatedMeshes = [];
    animObjectPreviews.clear();
    animObjectScrubs.clear();
    showAnimObjectPath(null);
    refControlledMaterials.clear();
    refEffectMaterials.clear();
    runtimeEntries.clear();
    if (replacingLevel) { runtimeVisibility.clear(); runtimeMatrices.clear(); runtimePieceMotions.clear(); }
    refPropData = props;
    assets.propTex.setNativeLighting(props?.instances ?? null);
    rebuildSoundMarkers();
    rebuildHiddenPropMarkers();
    if (!props) return;

    // The Surface view's contact colour for a SHIPPED instance, through the same derivation an authored
    // placement uses — the extracted facts compile to a native profile, the profile to a contact state
    // (`core/props/contact.ts`), so retail scenery and your own props are keyed by one rule rather than two.
    // Uniform per draw is a real constraint: it is why the batching below partitions on this value.
    const contactTint = (inst: PropInstance): number => propContactTint(
      collisionProfileContactState(collisionProfileFromSourceInstance(props.level, inst)), inst.surface);

    const byModel = new Map<number, PropInstance[]>();
    for (const inst of props.instances) {
      const a = byModel.get(inst.model);
      if (a) a.push(inst); else byModel.set(inst.model, [inst]);
    }
    const modelById = new Map(props.models.map(m => [m.id, m]));
    const raw = new THREE.Matrix4(), edit = new THREE.Matrix4();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    interface PendingStaticItem {
      geometry: THREE.BufferGeometry;
      instances: PropInstance[];
      model: number;
      name: string;
      bucket: string;
      object: number | null;
      piece: number | null;
      piecePivot: V3 | null;
      surface: RefPropSurfaceDetails | null;
      shadeTint: number;
    }
    interface PendingStaticBatch {
      target: THREE.Group;
      material: THREE.Material;
      shadeTint: number;
      items: PendingStaticItem[];
      instances: number;
      vertices: number;
      indices: number;
      expandedVertices: number;
      expandedIndices: number;
    }
    const pendingStaticBatches = new Map<string, PendingStaticBatch>();
    const queueStatic = (target: THREE.Group, material: THREE.Material, item: PendingStaticItem) => {
      const targetKey = target === refTrickModelsGroup ? 'tricks' : 'props';
      // Contact class joins the material in the batch key: a BatchedMesh carries ONE material, so the Surface
      // view's contact colour can only be per batch. Splitting here costs at most one extra draw per material
      // per class actually present, against the alternative of retail scenery being the one thing in the view
      // that cannot state its contact.
      const key = `${targetKey}:${material.uuid}:${item.shadeTint}`;
      let batch = pendingStaticBatches.get(key);
      if (!batch) {
        batch = { target, material, shadeTint: item.shadeTint, items: [], instances: 0, vertices: 0, indices: 0,
          expandedVertices: 0, expandedIndices: 0 };
        pendingStaticBatches.set(key, batch);
      }
      batch.items.push(item);
      batch.instances += item.instances.length;
      batch.vertices += item.geometry.getAttribute('position').count;
      batch.indices += item.geometry.getIndex()?.count ?? 0;
      batch.expandedVertices += item.geometry.getAttribute('position').count * item.instances.length;
      batch.expandedIndices += (item.geometry.getIndex()?.count ?? 0) * item.instances.length;
    };
    for (const [id, insts] of byModel) {
      const model = modelById.get(id);
      if (!model) continue;
      // rails + gems are placed as props in the extracted data, but they're the TRICK layer, not scenery:
      // route them to the Tricks-gated group so the Tricks filter shows / hides them (the Props filter keeps
      // just the scenery). Classified by the extractor's own model name (Mdl_Rail* / Gem* / …).
      const target = REF_TRICK_MODEL_RE.test(model.name) ? refTrickModelsGroup : refPropsGroup;
      // Hidden instances still need ordinary textured geometry so a graph can reveal a pre-authored broken twin.
      // They enter the batch with a zero-scale matrix; this costs no fragments and avoids rebuilding geometry at
      // the moment of impact.
      const visibleInsts = insts;
      const effectInsts = insts.filter(inst => effectPropIndices.has(inst.sourceIndex));
      // One InstancedMesh can only carry one material phase. Partition placements by their full recovered
      // material law; dwell flipbooks include an instance seed and therefore remain independently timed.
      const visibleBuckets = new Map<string, { instances: PropInstance[]; effect: MaterialWorldEffects | null;
        animation: AnimObjectEffect | null; deltaGated: boolean; controlSourceIndex: number | null;
        effectControlled: boolean; shadeTint: number }>();
      for (const inst of visibleInsts) {
        const effect = refMaterialEffects.get(inst.sourceIndex) ?? null;
        const controlled = refMaterialControls.has(inst.sourceIndex);
        const effectControlled = effectPropIndices.has(inst.sourceIndex);
        const deltaAnimation = refAnimDeltaEffects.get(inst.sourceIndex) ?? null;
        const animation = refAnimObjectEffects.get(inst.sourceIndex)
          ?? refAnimComboEffects.get(inst.sourceIndex) ?? deltaAnimation;
        const deltaGated = !!deltaAnimation;
        // Contact class partitions alongside the material law for the same reason it does: one draw carries
        // one material, so instances that must wear different Surface-view colours cannot share one. The key
        // is built ONCE per model and reused across its submeshes, which is what keeps sibling submeshes on
        // the identical instance ordering `propBucket` promises.
        const shadeTint = contactTint(inst);
        const key = `${materialWorldEffectsKey(effect)}|anim:${deltaGated ? 'delta:' : ''}${animObjectEffectKey(animation)}`
          + (controlled ? `|control:${inst.sourceIndex}` : '') + `|effect-host:${effectControlled}`
          + `|contact:${shadeTint}`;
        const bucket = visibleBuckets.get(key);
        if (bucket) bucket.instances.push(inst);
        else visibleBuckets.set(key, { instances: [inst], effect, animation, deltaGated,
          controlSourceIndex: controlled ? inst.sourceIndex : null, effectControlled, shadeTint });
      }
      const effectBuckets = new Map<string, { instances: PropInstance[]; animation: AnimObjectEffect | null;
        deltaGated: boolean }>();
      for (const inst of effectInsts) {
        const deltaAnimation = refAnimDeltaEffects.get(inst.sourceIndex) ?? null;
        const animation = refAnimObjectEffects.get(inst.sourceIndex)
          ?? refAnimComboEffects.get(inst.sourceIndex) ?? deltaAnimation;
        const deltaGated = !!deltaAnimation;
        const key = `${deltaGated ? 'delta:' : ''}${animObjectEffectKey(animation)}`;
        const bucket = effectBuckets.get(key);
        if (bucket) bucket.instances.push(inst);
        else effectBuckets.set(key, { instances: [inst], animation, deltaGated });
      }
      // Static submeshes are queued into one heterogeneous BatchedMesh per material. Transparent materials
      // naturally form separate batches and retain depth sorting; independently animated/effect-controlled
      // material or pose state stays on the narrower InstancedMesh path.
      for (const sub of model.subs) {
        const sheet = isSingleFacingSheet(sub.normals); // decides depth write for a blend material
        const addInstances = (drawInsts: PropInstance[], drawTarget: THREE.Group, material: THREE.Material,
          bucket: ReferencePropMesh[], bucketKey: string, animation: AnimObjectEffect | null, deltaGated: boolean,
          proxy = false, controlSourceIndex: number | null = null,
          surface: RefPropSurfaceDetails | null = null, staticBatch = false, isolatedKind = 'other',
          shadeTint = PROP_CLAY_COLOR, arraySlice: number | null = null) => {
          if (!drawInsts.length) return;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(sub.positions, 3));
          g.setAttribute('uv', new THREE.BufferAttribute(sub.uvs, 2));
          g.setIndex(new THREE.BufferAttribute(sub.indices, 1));
          if (sub.normals?.length === sub.positions.length)
            g.setAttribute('normal', new THREE.BufferAttribute(sub.normals, 3));
          else g.computeVertexNormals();
          // Keep the exact model-local normal separately. Instanced/Batched draws leave both attributes in
          // model space; MergedStaticPropMesh transforms `normal` for display but deliberately preserves this
          // one so the native instance record still dots two values expressed in the same local frame.
          g.setAttribute('ps2StoredNormal', g.getAttribute('normal'));
          // Which layer of the packed page bank this submesh samples — Unity's `UV0.z`, and the reason props
          // wearing different pages can share one draw at all. Constant across the submesh: a submesh IS one
          // material. Only array-material draws carry it, and a batch never mixes the two because the array
          // material is itself the batch key.
          if (arraySlice !== null) g.setAttribute('texArraySlice',
            new THREE.BufferAttribute(new Uint16Array(g.getAttribute('position').count).fill(arraySlice), 1));
          if (staticBatch && g.getAttribute('position').count && g.getIndex()?.count) {
            queueStatic(drawTarget, material, {
              geometry: g, instances: drawInsts, model: id, name: model.name, bucket: bucketKey,
              object: sub.object ?? null, piece: sub.piece ?? null, piecePivot: sub.piecePivot ?? null, surface,
              shadeTint,
            });
            return;
          }
          const im = new THREE.InstancedMesh(g, material, drawInsts.length);
          const nativeLighting = assets.propTex.isNative(material);
          if (proxy) im.renderOrder = EFFECT_PROP_OVERLAY_RENDER_ORDER;
          im.name = model.name;
          im.userData.propModel = id;          // clicking a reference prop arms this model for placement
          im.userData.propLevel = props.level;
          im.userData.propInsts = drawInsts;   // preserves the native source index for picking/effect joins
          im.userData.propBucket = bucketKey;  // sibling submeshes must share this exact instance ordering
          im.userData.propBatchKind = proxy ? 'effect-proxy' : isolatedKind;
          im.userData.propObject = sub.object ?? null; // full-hierarchy clips move object submeshes independently
          im.userData.propTex = surface?.tex ?? null; // this submesh's frame-zero texture file — the paint
          im.userData.propTexLevel = props.level;     // the paint sampler reads both straight off a raycast hit
          im.userData.propSurface = surface;   // full appearance identity (alpha pass / decal prio / anim)
          im.userData.propNativeLighting = nativeLighting;
          im.userData[PROP_SHADE_TINT] = shadeTint;   // uniform across this draw by construction (bucket key)
          const slots: ReferencePropSlot[] = [];
          im.userData.propSlots = slots;
          for (let k = 0; k < drawInsts.length; k++) {
            const inst = drawInsts[k];
            raw.compose(
              pos.set(inst.loc[0], inst.loc[1], inst.loc[2]),
              quat.set(inst.rot[0], inst.rot[1], inst.rot[2], inst.rot[3]),
              scl.set(inst.scale[0], inst.scale[1], inst.scale[2]),
            );
            edit.multiplyMatrices(RAW_TO_EDITOR, raw);
            const base = edit.clone();
            const entry: RuntimeInstanceEntry = {
              sourceIndex: inst.sourceIndex, mesh: im, instanceId: k, base, defaultVisible: inst.visible, proxy,
              geometry: g, level: props.level, model: id, name: model.name, object: sub.object ?? null,
              piece: sub.piece ?? null,
              piecePivot: sub.piecePivot ? new THREE.Vector3(...sub.piecePivot) : null,
              animationDelta: null,
            };
            slots[k] = {
              inst, level: props.level, model: id, name: model.name, bucket: bucketKey,
              object: sub.object ?? null, tex: surface?.tex ?? null, surface, geometry: g, faceStart: 0,
            };
            const entries = runtimeEntries.get(inst.sourceIndex);
            if (entries) entries.push(entry); else runtimeEntries.set(inst.sourceIndex, [entry]);
            im.setMatrixAt(k, displayMatrix(entry, base));
            if (nativeLighting) im.setColorAt(k, propLightIndexColor(inst.sourceIndex));
          }
          im.instanceMatrix.needsUpdate = true;
          if (nativeLighting && im.instanceColor) im.instanceColor.needsUpdate = true;
          im.computeBoundingSphere(); // frustum-cull each instanced submesh against the (large) reference span
          drawTarget.add(im);
          bucket.push(im);
          if (!proxy && controlSourceIndex !== null) {
            const controlledMaterials = refControlledMaterials.get(controlSourceIndex);
            if (controlledMaterials) controlledMaterials.add(material);
            else refControlledMaterials.set(controlSourceIndex, new Set([material]));
          }
          // Build a clip-capable entry even without a persistent receiver. Called one-shot graphs such as
          // MERQUER Effect 756 supply their AnimObject law only when Preview executes; the model curves are
          // still present and must not be discarded merely because the instance's persistent slot is empty.
          const clip = model.animation ?? model.rotation;
          if (clip) {
            const sourceIndices = drawInsts.map(inst => inst.sourceIndex);
            refAnimatedMeshes.push({
              mesh: im, sourceIndices, clip, object: sub.object ?? null, effect: animation, deltaGated,
              playbacks: sourceIndices.map(sourceIndex => animation
                ? isAnimComboEffect(animation)
                  ? createAnimComboPlayback(animation, clip.clipFrames, sourceIndex + 1)
                  : deltaGated
                    ? createAnimDeltaPlayback(animation, clip.clipFrames, sourceIndex + 1)
                    : createAnimObjectPlayback(animation, clip.clipFrames, sourceIndex + 1)
                : null),
            });
          }
        };
        for (const [bucketKey, bucket] of visibleBuckets) {
          const materialData = props.materials.get(sub.mat);
          const frames = bucket.effect?.crowd ? props.crowdFrames : materialData?.frames ?? [];
          const texFile = frames[0] ?? materialData?.tex ?? null;
          const runtimeMaterialKey = bucket.controlSourceIndex === null ? undefined
            : `${props.level}:${bucket.controlSourceIndex}`;
          // Owning an effect graph does not itself make the geometry unbatchable. BatchedMesh retains a mutable
          // matrix per source slot, so collision/sound/particle hosts, Rollers, spline movers, hide/show, and piece
          // throws can all update in Play without spending one draw per submesh. Only continuously animated pose or
          // private material state needs the narrower InstancedMesh path.
          const staticBatch = !bucket.animation
            && !(model.animation ?? model.rotation)
            && bucket.controlSourceIndex === null;
          const native = !!bucket.instances[0]?.lighting;
          // The packed bank, when this submesh can use one: a static draw on a plain page. A scroller or a
          // flipbook owns its Texture's offset and Source, neither of which means anything for one slice of a
          // shared array, so those keep the per-page material `material()` builds for them.
          const packed = staticBatch && !isAnimatedPropMaterial(bucket.effect, frames)
            ? assets.propTex.propArraySlot(texFile) : undefined;
          const materialOpts = { blend: materialData?.blend, priority: materialData?.prio,
            pixelAlpha: !!bucket.effect?.crowd || materialData?.pixelAlpha,
            alphaMode: materialData?.alphaMode, sheet, native };
          const arrayMaterial = packed
            ? assets.propTex.propArrayMaterial(packed.array, props.level, texFile!, materialOpts)
            : null;
          const baseMaterial = arrayMaterial ?? assets.propTex.material(props.level, texFile, bucket.effect,
            frames, runtimeMaterialKey, materialOpts);
          const drawMaterial = arrayMaterial ? arrayMaterial
            : native ? assets.propTex.native(baseMaterial) : baseMaterial;
          if (bucket.effect) for (const inst of bucket.instances) {
            const animated = refEffectMaterials.get(inst.sourceIndex);
            if (animated) animated.add(drawMaterial);
            else refEffectMaterials.set(inst.sourceIndex, new Set([drawMaterial]));
          }
          const isolatedKind = bucket.controlSourceIndex !== null ? 'material-control'
            : bucket.animation ? 'effect-animation'
            : (model.animation ?? model.rotation) ? 'model-animation'
            : bucket.effect ? 'material-effect'
            : bucket.effectControlled ? 'effect-host' : 'other';
          addInstances(bucket.instances, target, drawMaterial,
            refPropMeshes, bucketKey, bucket.animation, bucket.deltaGated, false, bucket.controlSourceIndex,
            { tex: texFile, blend: !!materialData?.blend,
              ...(materialData?.alphaMode ? { alphaMode: materialData.alphaMode } : {}),
              prio: !!materialData?.prio,
              frames: frames.length, ...(frames.length ? { frameFiles: [...frames] } : {}),
              ...(bucket.effect?.textureFlip ? { flipbook: { ...bucket.effect.textureFlip } } : {}),
              scroll: !!bucket.effect?.uvScroll }, staticBatch, isolatedKind, bucket.shadeTint,
            arrayMaterial ? packed!.slice : null);
        }
        for (const [bucketKey, bucket] of effectBuckets)
          addInstances(bucket.instances, refEffectPropsGroup, refEffectPropMat, refEffectPropMeshes,
            `effect-proxy:${bucketKey}`, bucket.animation, bucket.deltaGated, true);
      }
      if (effectBuckets.size && !model.subs.some(s => s.indices.length)) {
        // a SURFACELESS effect host (no renderable submesh — invisible in the world, and a wireframe of
        // nothing in the overlay) draws a stand-in box proxy instead, so the model a trigger is attached
        // to can still be seen, clicked and inspected in Reference Effects. Raw cm, Z-up, base-seated at
        // the instance origin; the instance transform scales/turns it like real geometry.
        for (const [bucketKey, bucket] of effectBuckets) {
          const g = new THREE.BoxGeometry(100, 100, 100).translate(0, 0, 50);
          const im = new THREE.InstancedMesh(g, refEffectPropMat, bucket.instances.length);
          im.renderOrder = EFFECT_PROP_OVERLAY_RENDER_ORDER;
          im.name = model.name;
          im.userData.propModel = id;
          im.userData.propLevel = props.level;
          im.userData.propInsts = bucket.instances;
          im.userData.propBucket = `effect-proxy:${bucketKey}`;
          im.userData.propBatchKind = 'effect-proxy';
          const slots: ReferencePropSlot[] = [];
          im.userData.propSlots = slots;
          for (let k = 0; k < bucket.instances.length; k++) {
            const inst = bucket.instances[k];
            raw.compose(
              pos.set(inst.loc[0], inst.loc[1], inst.loc[2]),
              quat.set(inst.rot[0], inst.rot[1], inst.rot[2], inst.rot[3]),
              scl.set(inst.scale[0], inst.scale[1], inst.scale[2]),
            );
            edit.multiplyMatrices(RAW_TO_EDITOR, raw);
            const base = edit.clone();
            const entry: RuntimeInstanceEntry = { sourceIndex: inst.sourceIndex, mesh: im, instanceId: k,
              geometry: g, level: props.level, model: id, name: model.name, object: null,
              base, defaultVisible: inst.visible, proxy: true, piece: null, piecePivot: null, animationDelta: null };
            slots[k] = {
              inst, level: props.level, model: id, name: model.name, bucket: `effect-proxy:${bucketKey}`,
              object: null, tex: null, surface: null, geometry: g, faceStart: 0,
            };
            const entries = runtimeEntries.get(inst.sourceIndex);
            if (entries) entries.push(entry); else runtimeEntries.set(inst.sourceIndex, [entry]);
            im.setMatrixAt(k, displayMatrix(entry, base));
          }
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          refEffectPropsGroup.add(im);
          refEffectPropMeshes.push(im);
        }
      }
      yield;
      if (generation !== propsBuildGeneration) return;
    }
    for (const batch of pendingStaticBatches.values()) {
      if (!batch.instances || !batch.vertices || !batch.indices) continue;
      // Transparent batches keep BatchedMesh's per-object depth sort even on the extension fallback. Opaque
      // materials can be physically merged safely, yielding one draw per material on every WebGL2 renderer.
      const mergedFallback = !nativeMultiDraw && !batch.material.transparent;
      const mergedMaterial = mergedFallback ? assets.propTex.variant(batch.material) : batch.material;
      if (mergedFallback) mergedMaterial.vertexColors = true;
      const mesh: THREE.BatchedMesh | MergedStaticPropMesh = mergedFallback
        ? new MergedStaticPropMesh(batch.expandedVertices, batch.expandedIndices, mergedMaterial)
        : new THREE.BatchedMesh(batch.instances, batch.vertices, batch.indices, batch.material);
      mesh.name = batch.target === refTrickModelsGroup ? 'Static reference tricks' : 'Static reference props';
      mesh.userData.propLevel = props.level;
      mesh.userData.propBucket = mergedFallback ? 'static-merged' : 'static-batched';
      mesh.userData.propBatchKind = batch.material.transparent ? 'static-transparent'
        : mergedFallback ? 'static-opaque-merged' : 'static-opaque';
      const nativeLighting = assets.propTex.isNative(mergedMaterial);
      mesh.userData.propNativeLighting = nativeLighting;
      mesh.userData[PROP_SHADE_TINT] = batch.shadeTint; // the batch key partitions on it, so this is exact
      if (mesh instanceof THREE.BatchedMesh) {
        mesh.sortObjects = batch.material.transparent; // transparent batches need per-object back-to-front sort
        mesh.perObjectFrustumCulled = true; // tight per-slot culling when native multi-draw is available
      }
      const slots: ReferencePropSlot[] = [];
      mesh.userData.propSlots = slots;
      let installedInstances = 0;
      for (const item of batch.items) {
        const geometryId = mesh.addGeometry(item.geometry);
        // A material batch can contain well over a thousand model geometries. Expose both geometry and
        // placement boundaries to the progressive driver instead of treating the whole material as one step.
        yield;
        if (generation !== propsBuildGeneration) return;
        for (const inst of item.instances) {
          const instanceId = mesh.addInstance(geometryId);
          const faceStart = mesh instanceof THREE.BatchedMesh
            ? (mesh.getGeometryRangeAt(geometryId)?.start ?? 0) / 3
            : mesh.getFaceStartAt(instanceId);
          raw.compose(
            pos.set(inst.loc[0], inst.loc[1], inst.loc[2]),
            quat.set(inst.rot[0], inst.rot[1], inst.rot[2], inst.rot[3]),
            scl.set(inst.scale[0], inst.scale[1], inst.scale[2]),
          );
          edit.multiplyMatrices(RAW_TO_EDITOR, raw);
          const base = edit.clone();
          const entry: RuntimeInstanceEntry = {
            sourceIndex: inst.sourceIndex, mesh, instanceId, geometry: item.geometry,
            level: props.level, model: item.model, name: item.name, object: item.object,
            base, defaultVisible: inst.visible, proxy: false, piece: item.piece,
            piecePivot: item.piecePivot ? new THREE.Vector3(...item.piecePivot) : null, animationDelta: null,
          };
          slots[instanceId] = {
            inst, level: props.level, model: item.model, name: item.name, bucket: item.bucket,
            object: item.object, tex: item.surface?.tex ?? null, surface: item.surface,
            geometry: item.geometry, faceStart,
          };
          const entries = runtimeEntries.get(inst.sourceIndex);
          if (entries) entries.push(entry); else runtimeEntries.set(inst.sourceIndex, [entry]);
          mesh.setMatrixAt(instanceId, displayMatrix(entry, base));
          if (nativeLighting) mesh.setColorAt(instanceId, propLightIndexColor(inst.sourceIndex));
          if (++installedInstances % 16 === 0) {
            yield;
            if (generation !== propsBuildGeneration) return;
          }
        }
      }
      mesh.userData.propInsts = slots.map(slot => slot.inst);
      if (mesh instanceof MergedStaticPropMesh) mesh.finalize(!deferMergedBounds);
      else mesh.computeBoundingSphere();
      batch.target.add(mesh);
      refPropMeshes.push(mesh);
      yield;
      if (generation !== propsBuildGeneration) return;
    }
    const census = (group: THREE.Group): PropRenderStats => {
      const stats = emptyRenderStats();
      for (const object of group.children) {
        if (!isReferencePropMesh(object)) continue;
        if (object instanceof THREE.BatchedMesh || object instanceof MergedStaticPropMesh) {
          stats.batchDraws++;
          stats.batchSlots += object.instanceCount;
        } else {
          const instanced = object as THREE.InstancedMesh;
          stats.isolatedDraws++;
          stats.isolatedSlots += instanced.count;
          const kind = typeof instanced.userData.propBatchKind === 'string'
            ? instanced.userData.propBatchKind : 'other';
          stats.isolatedByKind.set(kind, (stats.isolatedByKind.get(kind) ?? 0) + 1);
        }
      }
      return stats;
    };
    propsRenderStats = census(refPropsGroup);
    tricksRenderStats = census(refTrickModelsGroup);
    refPropsGroup.visible = refPropsVisible && refPropsGroup.children.length > 0;
    refTrickModelsGroup.visible = refTricksVisible && refTrickModelsGroup.children.length > 0;
    refEffectPropsGroup.visible = refEffectPropsVisible && refEffectPropsGroup.children.length > 0;
    applyPropRigTint(); // re-tint the fresh meshes if a rig is loaded
    if (decorShade !== 'textured') { applyPropShade(refPropsGroup, decorShade); applyPropShade(refTrickModelsGroup, decorShade); }
  }

  function setProps(props: LevelProps | null) {
    const generation = ++propsBuildGeneration;
    if (!props) assets.propTex.disposePropArrayBank();
    for (const _ of setPropsSteps(props, generation)) { /* exhaust synchronously for existing callers */ }
  }

  /**
   * Every texture page the level's prop materials rest on — the set the array bank packs. Flipbook frames
   * past the first are deliberately absent: a flipbook keeps its own material, so a bank layer for its later
   * frames would only be a layer nothing samples.
   */
  function propTexturePages(props: LevelProps): string[] {
    const pages = new Set<string>();
    for (const material of props.materials.values()) {
      const resting = material.frames?.[0] ?? material.tex;
      if (resting) pages.add(resting);
    }
    if (props.crowdFrames?.[0]) pages.add(props.crowdFrames[0]); // a crowd bucket rests on this one instead
    return [...pages];
  }

  /** Build large reference prop sets without holding the main thread through every model/material batch.
   * A later set/clear invalidates this generator; that newer build owns cleanup and the old one stops at its
   * next model boundary. */
  async function setPropsProgressive(props: LevelProps | null, yieldControl: () => Promise<void>, budgetMs = 10) {
    // Claimed BEFORE the wait below, exactly as it was before there was a wait: a clear or a newer level
    // arriving mid-pack must win, and it can only do that if this build has already staked a generation to be
    // superseded. The visible cost is that the OUTGOING level's props stay up for the length of the wait
    // rather than blanking first — and only on a switch, since clearing does not wait at all.
    const generation = ++propsBuildGeneration;
    // The bank has to exist BEFORE any mesh does: which pages share an array is what decides which submeshes
    // can share a BatchedMesh, and that partition cannot be revised without rebuilding every batch. The wait
    // is bounded inside buildPropArrayBank — a page that never answers costs the level its bank, not its props.
    if (props) await assets.propTex.buildPropArrayBank(props.level, propTexturePages(props));
    else assets.propTex.disposePropArrayBank();
    if (generation !== propsBuildGeneration) return;
    const budget = Math.max(0, budgetMs);
    let chunkStarted = globalThis.performance?.now?.() ?? Date.now();
    for (const _ of setPropsSteps(props, generation, true)) {
      if (generation !== propsBuildGeneration) return;
      const now = globalThis.performance?.now?.() ?? Date.now();
      if (now - chunkStarted >= budget) {
        await yieldControl();
        if (generation !== propsBuildGeneration) return;
        chunkStarted = globalThis.performance?.now?.() ?? Date.now();
      }
    }
    if (generation !== propsBuildGeneration || typeof Worker === 'undefined') return;

    // The no-multi-draw renderer physically merges opaque props. Its BVH was the last indivisible main-thread
    // task (hundreds of ms on MERQUER). Build against copied geometry in one reusable worker: the live render
    // arrays remain attached, and deserialization back onto the live geometry is small and deterministic.
    const merged = [...refPropMeshes, ...refEffectPropMeshes]
      .filter((mesh): mesh is MergedStaticPropMesh => mesh instanceof MergedStaticPropMesh);
    if (!merged.length) return;
    const worker = new GenerateMeshBVHWorker();
    try {
      for (const mesh of merged) {
        await yieldControl();
        if (generation !== propsBuildGeneration) return;
        const workerGeometry = new THREE.BufferGeometry();
        const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
        const index = mesh.geometry.getIndex();
        const positionArray = position.array.slice(0) as Float32Array;
        workerGeometry.setAttribute('position', new THREE.BufferAttribute(positionArray, 3));
        if (index) workerGeometry.setIndex(new THREE.BufferAttribute(index.array.slice(0), 1));
        let serialized: SerializedBVH;
        try {
          const tree = await worker.generate(workerGeometry, { indirect: true });
          serialized = MeshBVH.serialize(tree);
        } finally {
          workerGeometry.dispose();
        }
        if (generation !== propsBuildGeneration) return;
        mesh.installBoundsTree(serialized);
      }
    } catch (error) {
      // Rendering is complete without a tree and acceleratedRaycast has a correct built-in fallback. A worker
      // restriction should degrade picking speed, never fail the reference load or strand its progress modal.
      console.warn('[reference-props] background picking acceleration unavailable', error);
    } finally {
      worker.dispose();
    }
  }

  /** Supply the graph/slot side of the native prop join. setEffectPropIndices performs the paired rebuild. */
  function setEffectsData(data: ReferenceEffectsData | null) {
    refMaterialEffects = referenceMaterialWorldEffects(data);
    refMaterialControls = referenceMaterialControls(data);
    // Crack's frame selection is performed by the engine's Crack handler, so the retail graph contains no
    // TextureFlip receiver to discover. Give each cracked host the same private material path as an explicit
    // control node; otherwise all 77 Megaplex panes would share one material and crack together.
    if (data) for (const instance of data.instances) {
      if (refMaterialControls.has(instance.index)) continue;
      const collision = referenceInstanceBindings(data, instance)
        .find(binding => binding.circumstance === 'collision')?.graph;
      const control = crackedMaterialControlFromGraph(collision);
      if (control) refMaterialControls.set(instance.index, control);
    }
    // Dynamically installed receivers (notably StartCountDown's unattached start-light instance) still need
    // their flipbook/scroll material prepared before the first delayed command arrives.
    for (const [sourceIndex, control] of refMaterialControls) if (!refMaterialEffects.has(sourceIndex)) {
      const effect = control.effect.textureFlip?.dwell
        ? { ...control.effect, textureFlip: { ...control.effect.textureFlip, seed: sourceIndex + 1 } }
        : control.effect;
      refMaterialEffects.set(sourceIndex, effect);
    }
    refAnimObjectEffects = referenceAnimObjectEffects(data);
    refAnimComboEffects = referenceAnimComboEffects(data);
    refAnimDeltaEffects = referenceAnimDeltaEffects(data);
    refImmediateBreaks = referenceImmediateBreakInstances(data);
    refHoldAtEnd = new Set();
    if (data) for (const instance of data.instances)
      if (referenceSlot(data.document, instance.effectSlotIndex)?.circumstances.slot4)
        refHoldAtEnd.add(instance.index);
  }

  const rotationAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(0, 0, 1)] as const;
  const animationRotation = new THREE.Matrix4(), animationTranslation = new THREE.Matrix4();
  const animationTransform = new THREE.Matrix4();

  /** The compact recovered clip for one native placement, when its model carries the supported animation
   * subset. The editor reads this directly rather than copying model curves into the effects payload. */
  function referenceAnimObjectClip(sourceIndex: number): PropModelClip | null {
    const instance = refPropData?.instances.find(candidate => candidate.sourceIndex === sourceIndex);
    if (!instance) return null;
    const model = refPropData?.models.find(candidate => candidate.id === instance.model);
    return model?.animation ?? model?.rotation ?? null;
  }

  /** Native multi-model props can use co-located instances for independently textured pieces (the Merqury
   * blimp body/screen pair). Keep exact-transform peers with the same player law and clip length synchronized. */
  function animObjectScrubSources(sourceIndex: number): number[] {
    const source = refPropData?.instances.find(instance => instance.sourceIndex === sourceIndex);
    const sourceClip = referenceAnimObjectClip(sourceIndex);
    const sourceEffect = refAnimObjectEffects.get(sourceIndex);
    if (!source || !sourceClip || !sourceEffect || !refPropData) return [sourceIndex];
    const same = (a: readonly number[], b: readonly number[]) => a.length === b.length
      && a.every((value, index) => value === b[index]);
    const effectKey = animObjectEffectKey(sourceEffect);
    return refPropData.instances.filter(candidate => {
      const clip = referenceAnimObjectClip(candidate.sourceIndex);
      const effect = refAnimObjectEffects.get(candidate.sourceIndex);
      return !!clip && clip.clipFrames === sourceClip.clipFrames && !!effect
        && animObjectEffectKey(effect) === effectKey
        && same(candidate.loc, source.loc) && same(candidate.rot, source.rot) && same(candidate.scale, source.scale);
    }).map(candidate => candidate.sourceIndex);
  }

  function clearAnimObjectPathGeometry() {
    for (const child of [...refAnimPathGroup.children]) {
      if (child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Mesh)
        child.geometry.dispose();
    }
    refAnimPathGroup.clear();
    refAnimPlayhead = null;
  }

  function animObjectPathPoint(sourceIndex: number, clip: PropModelClip, frame: number): THREE.Vector3 | null {
    const entry = (runtimeEntries.get(sourceIndex) ?? []).find(candidate => !candidate.proxy)
      ?? (runtimeEntries.get(sourceIndex) ?? [])[0];
    if (!entry) return null;
    if (isPropModelAnimation(clip)) {
      const objectIndex = clip.objects.findIndex(object => object.channels?.slice(0, 3).some(curve => !!curve?.length));
      if (objectIndex < 0) return null;
      return new THREE.Vector3().setFromMatrixPosition(hierarchyPose(clip, frame).poseWorld[objectIndex])
        .applyMatrix4(entry.base);
    }
    const translation = samplePropModelTranslation(clip, frame);
    return new THREE.Vector3(translation[0], translation[1], translation[2]).applyMatrix4(entry.base);
  }

  function updateAnimObjectPathPlayhead(sourceIndex: number, frame: number) {
    if (refAnimPathSource !== sourceIndex || !refAnimPlayhead) return;
    const clip = referenceAnimObjectClip(sourceIndex);
    const point = clip ? animObjectPathPoint(sourceIndex, clip, frame) : null;
    if (point) refAnimPlayhead.position.copy(point);
  }

  /** Show the selected clip's model-local translation after its instance transform. Small dots mark the union
   * of recovered translation-segment boundaries; the amber bead follows timeline scrubbing/playback. */
  function showAnimObjectPath(sourceIndex: number | null): boolean {
    if (sourceIndex === refAnimPathSource) return sourceIndex !== null;
    clearAnimObjectPathGeometry();
    refAnimPathSource = sourceIndex;
    refAnimPathGroup.visible = false;
    if (sourceIndex === null) return false;
    const clip = referenceAnimObjectClip(sourceIndex);
    if (!clip) return false;
    const translationChannels = propModelAnimationChannels(clip).filter(channel => channel.kind === 'translate');
    if (!translationChannels.length) return false;
    const sampleCount = Math.max(48, Math.min(160, Math.ceil(clip.clipFrames / 2)));
    const path: THREE.Vector3[] = [];
    for (let i = 0; i <= sampleCount; i++) {
      const point = animObjectPathPoint(sourceIndex, clip, clip.clipFrames * i / sampleCount);
      if (point) path.push(point);
    }
    if (!path.length) return false;
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), refAnimPathMat);
    line.frustumCulled = false; line.renderOrder = 990;
    refAnimPathGroup.add(line);
    const boundaryFrames = [...new Set(translationChannels.flatMap(channel => channel.boundaryFrames))]
      .sort((a, b) => a - b);
    const boundaries = boundaryFrames.flatMap(frame => {
      const point = animObjectPathPoint(sourceIndex, clip, frame);
      return point ? [point] : [];
    });
    if (boundaries.length) {
      const keys = new THREE.Points(new THREE.BufferGeometry().setFromPoints(boundaries), refAnimKeyMat);
      keys.frustumCulled = false; keys.renderOrder = 991;
      refAnimPathGroup.add(keys);
    }
    refAnimPlayhead = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 7), refAnimPlayheadMat);
    refAnimPlayhead.renderOrder = 992;
    refAnimPathGroup.add(refAnimPlayhead);
    updateAnimObjectPathPlayhead(sourceIndex, animObjectScrubs.get(sourceIndex) ?? 0);
    refAnimPathGroup.visible = true;
    return true;
  }

  function displayMatrix(entry: RuntimeInstanceEntry, matrix: THREE.Matrix4): THREE.Matrix4 {
    const visible = entry.proxy || (runtimeVisibility.get(entry.sourceIndex) ?? entry.defaultVisible);
    return visible ? matrix : hiddenMatrix(matrix);
  }

  function clearRuntimeInstanceCopies(sourceIndex: number) {
    const copies = runtimeInstanceCopies.get(sourceIndex);
    if (!copies) return;
    for (const draw of copies.draws) {
      disposePropShade(draw.mesh);
      draw.mesh.removeFromParent();
      // InstancedMesh.dispose releases its per-instance GPU attributes. Geometry and materials are deliberately
      // shared with the native source draw and remain owned by the ordinary prop teardown.
      draw.mesh.dispose();
    }
    runtimeInstanceCopies.delete(sourceIndex);
  }

  function clearAllRuntimeInstanceCopies() {
    for (const sourceIndex of [...runtimeInstanceCopies.keys()]) clearRuntimeInstanceCopies(sourceIndex);
  }

  function runtimeCopySourceEntries(sourceIndex: number): RuntimeInstanceEntry[] {
    return (runtimeEntries.get(sourceIndex) ?? []).filter(entry => !entry.proxy && !!entry.mesh.parent);
  }

  function createRuntimeInstanceCopies(sourceIndex: number, count: number): RuntimeInstanceCopies {
    const draws: RuntimeInstanceCopyDraw[] = [];
    for (const entry of runtimeCopySourceEntries(sourceIndex)) {
      const parent = entry.mesh.parent;
      if (!parent) continue;
      const texturedMaterial = (entry.mesh.userData.texturedMaterial ?? entry.mesh.material) as
        THREE.Material | THREE.Material[];
      const materials = Array.isArray(texturedMaterial) ? texturedMaterial : [texturedMaterial];
      // The no-multi-draw fallback's merged geometry owns its white tint attribute, while this entry retains the
      // original submesh geometry. Supply the equivalent white vertex colour before sharing that material with an
      // InstancedMesh; otherwise WebGL's missing-attribute default would multiply the transient copies to black.
      if (materials.some(material => material.vertexColors) && !entry.geometry.getAttribute('color')) {
        const vertices = entry.geometry.getAttribute('position')?.count ?? 0;
        entry.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(vertices * 3).fill(1), 3));
      }
      const mesh = new THREE.InstancedMesh(entry.geometry, texturedMaterial, count);
      mesh.name = `${entry.name} spline copies`;
      mesh.userData.runtimeInstanceCopies = true;
      mesh.userData[PROP_SHADE_TINT] = entry.mesh.userData[PROP_SHADE_TINT]; // a copy shares its source's class
      const nativeLighting = materials.some(material => assets.propTex.isNative(material));
      mesh.userData.propNativeLighting = nativeLighting;
      if (nativeLighting) {
        for (let index = 0; index < count; index++) mesh.setColorAt(index, propLightIndexColor(sourceIndex));
        mesh.instanceColor!.needsUpdate = true;
      }
      mesh.renderOrder = entry.mesh.renderOrder;
      mesh.castShadow = entry.mesh.castShadow;
      mesh.receiveShadow = entry.mesh.receiveShadow;
      mesh.raycast = () => { /* cosmetic copies share the native source placement; pick that placement instead */ };
      parent.add(mesh);
      if (decorShade !== 'textured') applyPropShade(mesh, decorShade);
      draws.push({ entry, mesh });
    }
    const copies = { count, worldMatrices: [], draws };
    runtimeInstanceCopies.set(sourceIndex, copies);
    return copies;
  }

  function applyRuntimeInstanceCopies(sourceIndex: number) {
    const copies = runtimeInstanceCopies.get(sourceIndex);
    if (!copies) return;
    const visibleOverride = runtimeVisibility.get(sourceIndex);
    const parentInverse = new THREE.Matrix4();
    for (const { entry, mesh } of copies.draws) {
      const parent = mesh.parent;
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      parentInverse.copy(parent.matrixWorld).invert();
      const visible = visibleOverride ?? entry.defaultVisible;
      for (let index = 0; index < copies.count; index++) {
        const world = copies.worldMatrices[index];
        const posed = entry.animationDelta ? world.clone().multiply(entry.animationDelta) : world;
        const local = parentInverse.clone().multiply(posed);
        mesh.setMatrixAt(index, visible ? local : hiddenMatrix(local));
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  /** Install the render-only poses after copy zero. Matrices arrive in world space, matching the existing single
   * placement mutation hook; each draw converts them to the visibility group's local frame. */
  function setRuntimeInstanceWorldCopies(sourceIndex: number, matrices: readonly THREE.Matrix4[] | null) {
    if (!matrices?.length) { clearRuntimeInstanceCopies(sourceIndex); return; }
    let copies = runtimeInstanceCopies.get(sourceIndex);
    let created = false;
    const sourceEntries = runtimeCopySourceEntries(sourceIndex);
    const entriesChanged = !!copies && (copies.draws.length !== sourceEntries.length
      || copies.draws.some((draw, index) => draw.entry !== sourceEntries[index]));
    // Ambient Effects may start while the progressive reference-prop build is between yields. An empty copy set
    // created before this model's entries exist must not become permanent: reconcile it as entries arrive. Manual
    // Preview naturally starts after the build and therefore did not expose this refresh-order race.
    if (!copies || copies.count !== matrices.length || entriesChanged) {
      clearRuntimeInstanceCopies(sourceIndex);
      copies = createRuntimeInstanceCopies(sourceIndex, matrices.length);
      created = true;
    }
    copies.worldMatrices = matrices.map(matrix => matrix.clone());
    applyRuntimeInstanceCopies(sourceIndex);
    if (created) applyRuntimeCopyTint(sourceIndex, copies);
  }

  function runtimeEntryMatrix(entry: RuntimeInstanceEntry): THREE.Matrix4 {
    const outer = runtimeMatrices.get(entry.sourceIndex) ?? entry.base;
    const base = entry.animationDelta ? outer.clone().multiply(entry.animationDelta) : outer;
    if (entry.piece === null || !entry.piecePivot) return base;
    const motion = runtimePieceMotions.get(entry.sourceIndex)?.get(entry.piece);
    if (!motion) return base;

    // The preserved piece pivot is model-local, while effect simulation runs in editor world space. Rotate around
    // that pivot in world space, then return the result to refRoot-local space for the InstancedMesh matrix.
    stage.refRoot.updateWorldMatrix(true, false);
    const rootWorld = stage.refRoot.matrixWorld;
    const worldBase = rootWorld.clone().multiply(base);
    const worldPivot = entry.piecePivot.clone().applyMatrix4(worldBase);
    const worldMotion = new THREE.Matrix4().compose(
      worldPivot.clone().add(motion.offset), motion.rotation, new THREE.Vector3(1, 1, 1),
    ).multiply(new THREE.Matrix4().makeTranslation(-worldPivot.x, -worldPivot.y, -worldPivot.z));
    return rootWorld.clone().invert().multiply(worldMotion).multiply(worldBase);
  }

  function applyRuntimeInstance(sourceIndex: number) {
    bumpRuntimePose(sourceIndex);
    const changedMeshes = new Set<ReferencePropMesh>();
    for (const entry of runtimeEntries.get(sourceIndex) ?? []) {
      entry.mesh.setMatrixAt(entry.instanceId, displayMatrix(entry, runtimeEntryMatrix(entry)));
      changedMeshes.add(entry.mesh);
    }
    for (const mesh of changedMeshes) {
      if (mesh instanceof THREE.InstancedMesh) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      } else if (mesh instanceof MergedStaticPropMesh) mesh.computeBoundingSphere();
      // BatchedMesh.setMatrixAt writes its matrix texture immediately. Its initial level-wide outer bound still
      // contains the ordinary Play motions, while perObjectFrustumCulled reads each updated slot every frame;
      // recomputing a material batch's union sphere here would turn one moving prop into an O(all slots) update.
    }
    syncPropHighlightMatrix();
  }

  /** Scene mutation boundary for Play effects. The override is world-space so the graph runtime never needs to
   * know which chirality/reference root owns the rendered instance. */
  function setRuntimeInstanceWorldMatrix(sourceIndex: number, matrix: THREE.Matrix4 | null) {
    if (matrix) {
      stage.refRoot.updateWorldMatrix(true, false);
      runtimeMatrices.set(sourceIndex, stage.refRoot.matrixWorld.clone().invert().multiply(matrix));
    } else runtimeMatrices.delete(sourceIndex);
    applyRuntimeInstance(sourceIndex);
  }

  function setRuntimeInstanceVisible(sourceIndex: number, visible: boolean | null) {
    if (visible === null) runtimeVisibility.delete(sourceIndex); else runtimeVisibility.set(sourceIndex, visible);
    applyRuntimeInstance(sourceIndex);
    applyRuntimeInstanceCopies(sourceIndex);
  }

  function runtimeInstancePieceIds(sourceIndex: number): number[] {
    return [...new Set((runtimeEntries.get(sourceIndex) ?? [])
      .filter(entry => !entry.proxy && entry.piece !== null)
      .map(entry => entry.piece!))];
  }

  function setRuntimeInstancePieceMotions(sourceIndex: number, motions: readonly RuntimePieceMotion[] | null) {
    if (!motions) runtimePieceMotions.delete(sourceIndex);
    else runtimePieceMotions.set(sourceIndex, new Map(motions.map(motion => [motion.piece, motion])));
    applyRuntimeInstance(sourceIndex);
  }

  function resetRuntimeInstances() {
    const changed = new Set([...runtimeVisibility.keys(), ...runtimeMatrices.keys(), ...runtimePieceMotions.keys(),
      ...runtimeInstanceCopies.keys()]);
    clearAllRuntimeInstanceCopies();
    runtimeVisibility.clear(); runtimeMatrices.clear(); runtimePieceMotions.clear();
    for (const sourceIndex of changed) applyRuntimeInstance(sourceIndex);
  }

  /** The compact merged clip's own pose at one frame — the quantity an AnimCombo composes onto. Written into
   *  `animationTransform`, which the caller must consume before the next call. */
  function compactClipPose(clip: Exclude<PropModelClip, { objects: unknown }>, frame: number): THREE.Matrix4 {
    const translation = samplePropModelTranslation(clip, frame);
    animationTranslation.makeTranslation(translation[0], translation[1], translation[2]);
    const axis = clip.axis;
    if (axis === undefined) animationRotation.identity();
    else animationRotation.makeRotationAxis(rotationAxes[axis],
      THREE.MathUtils.degToRad(samplePropModelRotation(clip, frame)));
    return animationTransform.multiplyMatrices(animationTranslation, animationRotation);
  }

  /** Apply either the compact merged-model clip or one object's full hierarchy delta after the instance pose.
   * Hierarchy geometry is already baked in its rest world transform, so animated-world × inverse-rest moves it
   * exactly while retaining static siblings and inherited parent motion.
   *
   * `basis` is the AnimCombo case and nothing else: the idle frame whose pose the sampled one is composed onto,
   * so a triggered reaction plays from wherever the idle animation had reached [Trailmap: 230-level-ssf sub 258]. */
  function setAnimatedFrame(animated: AnimatedMesh, index: number, frame: number | null, basis: number | null = null) {
    const sourceIndex = animated.sourceIndices[index];
    const entry = (runtimeEntries.get(sourceIndex) ?? []).find(candidate => candidate.mesh === animated.mesh
      && candidate.instanceId === index);
    if (!entry) return;
    bumpRuntimePose(sourceIndex);
    entry.animationDelta = null;
    if (frame !== null) {
      if (isPropModelAnimation(animated.clip)) {
        if (animated.object !== null) {
          const deltas = basis === null
            ? hierarchyPose(animated.clip, frame).deltas
            : hierarchyComboPose(animated.clip, frame, basis);
          entry.animationDelta = deltas[animated.object]?.clone() ?? null;
        }
      } else if (basis === null) {
        entry.animationDelta = compactClipPose(animated.clip, frame).clone();
      } else {
        const held = compactClipPose(animated.clip, basis).clone();
        entry.animationDelta = held.multiply(compactClipPose(animated.clip, frame));
      }
    }
    animated.mesh.setMatrixAt(index, displayMatrix(entry, runtimeEntryMatrix(entry)));
  }

  /** Hold one compatible reference placement at an exact native clip frame. Passing null releases the hold and
   * restores its ambient/preview pose. This is independent of the global Effects visibility toggle. */
  function setAnimObjectScrubFrame(sourceIndex: number, frame: number | null): boolean {
    const clip = referenceAnimObjectClip(sourceIndex);
    if (!clip) return false;
    const sources = new Set(animObjectScrubSources(sourceIndex));
    const clamped = Math.min(clip.clipFrames, Math.max(0, frame ?? 0));
    for (const index of sources) {
      if (frame === null) animObjectScrubs.delete(index); else animObjectScrubs.set(index, clamped);
    }
    let handled = false;
    for (const animated of refAnimatedMeshes) {
      for (let i = 0; i < animated.sourceIndices.length; i++) {
        const animatedSourceIndex = animated.sourceIndices[i];
        if (!sources.has(animatedSourceIndex)) continue;
        const scrub = animObjectScrubs.get(animatedSourceIndex);
        const preview = animObjectPreviews.get(animatedSourceIndex);
        const ambientPlayback = animated.playbacks[i];
        const restored = preview?.playback.frame
          ?? (animated.effect && (animated.deltaGated || worldEffectsEnabled) ? ambientPlayback?.frame ?? null : null);
        setAnimatedFrame(animated, i, scrub ?? restored);
        animated.mesh.instanceMatrix.needsUpdate = true;
        handled = true;
      }
    }
    updateAnimObjectPathPlayhead(sourceIndex, animObjectScrubs.get(sourceIndex) ?? 0);
    syncPropHighlightMatrix();
    return handled;
  }

  function resetAnimatedMeshes(deltaGated: boolean | null = null) {
    for (const animated of refAnimatedMeshes) {
      if (deltaGated !== null && animated.deltaGated !== deltaGated) continue;
      animated.playbacks = animated.sourceIndices.map(sourceIndex => animated.effect
        ? isAnimComboEffect(animated.effect)
          ? createAnimComboPlayback(animated.effect, animated.clip.clipFrames, sourceIndex + 1)
          : animated.deltaGated
            ? createAnimDeltaPlayback(animated.effect, animated.clip.clipFrames, sourceIndex + 1)
            : createAnimObjectPlayback(animated.effect, animated.clip.clipFrames, sourceIndex + 1)
        : null);
      for (let i = 0; i < animated.sourceIndices.length; i++) setAnimatedFrame(animated, i, null);
      animated.mesh.instanceMatrix.needsUpdate = true;
    }
    syncPropHighlightMatrix();
  }

  /** The toolbar's Effects toggle controls model-clip motion alongside material UV/flipbook effects. */
  function setWorldEffectsEnabled(on: boolean) {
    if (worldEffectsEnabled === on) return;
    worldEffectsEnabled = on;
    // The ambient toggle owns free-running AnimObject clips. Play-triggered AnimDelta receivers keep their
    // current pose/budget when the user changes that unrelated view toggle.
    resetAnimatedMeshes(false);
  }

  /** Deliver a bound property-node control message to this native instance. The receiver—not the command
   * number—selects between controlled texture/UV state and AnimDelta clip budget. */
  function controlRuntimeInstanceProperty(sourceIndex: number, command: number, value: number): boolean {
    const materialControl = refMaterialControls.get(sourceIndex);
    if (materialControl) {
      let handled = false;
      for (const material of refControlledMaterials.get(sourceIndex) ?? [])
        handled = assets.propTex.controlMaterial(material, materialControl.receiver, command, value) || handled;
      return handled;
    }
    if (command !== 2 && command !== 3) return false;
    let handled = false;
    for (const animated of refAnimatedMeshes) {
      const combo = isAnimComboEffect(animated.effect);
      if (combo ? command !== 3 : !animated.deltaGated || command !== 2) continue;
      for (let i = 0; i < animated.sourceIndices.length; i++) {
        if (animated.sourceIndices[i] !== sourceIndex) continue;
        const playback = animated.playbacks[i];
        if (!playback) continue;
        if (combo) {
          const started = triggerAnimComboPlayback(playback as AnimComboPlayback);
          const state = playback as AnimComboPlayback;
          comboLog(`${sourceIndex} arm ${started ? 'OK' : 'REFUSED (running or latched)'}`
            + ` · window ${state.comboStart}..${state.comboEnd} · snapshot idle frame ${state.snapshotFrame.toFixed(1)}`
            + ` · mesh ${animated.mesh.name || animated.mesh.type} object ${animated.object}`);
          if (started) comboTraced.delete(state);
          handled = started || handled;
        }
        else { grantAnimDeltaPlayback(playback as AnimDeltaPlayback, value); handled = true; }
      }
    }
    return handled;
  }

  /**
   * The receiver half of the `slopesmith:control-debug` trace the graph runner writes.
   *
   * A delivered command and a VISIBLE result are two different claims: the runner can only report that a
   * receiver took the message, and an AnimCombo that arms but never reaches a drawn mesh looks identical from
   * there. This says which mesh actually got posed, so the two halves of the trace meet in the middle.
   */
  const comboLog = (message: string): void => {
    try {
      if (localStorage.getItem('slopesmith:control-debug') !== '1') return;
    } catch { /* storage can be unavailable in a privacy-restricted frame; tracing stays optional */ }
    console.log('[Slopesmith combo]', message);
  };
  /** Combo playbacks whose first posed tick has already been traced, so the log is per RUN, not per frame. */
  const comboTraced = new WeakSet<object>();

  /** Does this native instance carry an AnimCombo the trigger command can actually start? Preview asks before
   *  running a bound-node control, because a command with no receiver should draw a ring rather than nothing. */
  function instanceHasTriggerableCombo(sourceIndex: number): boolean {
    return refAnimatedMeshes.some(animated => isAnimComboEffect(animated.effect)
      && animated.sourceIndices.includes(sourceIndex));
  }

  /** Does this native instance's installed material property expire on its own? Only a finite-Length
   *  TextureFlip does, and the graph runner uses it to decide what Preview may run outside Test. */
  function instanceHasPulseProperty(sourceIndex: number): boolean {
    const control = refMaterialControls.get(sourceIndex);
    return control?.receiver === 'texture-flip' && isTextureFlipPulse(control.effect.textureFlip);
  }

  function resetRuntimePropertyControls() {
    resetAnimatedMeshes(true);
    for (const [sourceIndex, materials] of refControlledMaterials) {
      const receiver = refMaterialControls.get(sourceIndex)?.receiver;
      if (receiver) for (const material of materials) assets.propTex.resetMaterialControl(material, receiver);
    }
  }

  /** Restore one interaction-owned material/animation receiver without rewinding unrelated live props. */
  function resetRuntimeInstanceEffects(sourceIndex: number): boolean {
    let handled = animObjectPreviews.delete(sourceIndex);
    const control = refMaterialControls.get(sourceIndex);
    if (control) for (const material of refControlledMaterials.get(sourceIndex) ?? []) {
      assets.propTex.resetMaterialControl(material, control.receiver);
      handled = true;
    }
    for (const animated of refAnimatedMeshes) {
      for (let i = 0; i < animated.sourceIndices.length; i++) {
        if (animated.sourceIndices[i] !== sourceIndex) continue;
        animated.playbacks[i] = animated.effect
          ? isAnimComboEffect(animated.effect)
            ? createAnimComboPlayback(animated.effect, animated.clip.clipFrames, sourceIndex + 1)
            : animated.deltaGated
              ? createAnimDeltaPlayback(animated.effect, animated.clip.clipFrames, sourceIndex + 1)
              : createAnimObjectPlayback(animated.effect, animated.clip.clipFrames, sourceIndex + 1)
          : null;
        setAnimatedFrame(animated, i, null);
        animated.mesh.instanceMatrix.needsUpdate = true;
        handled = true;
      }
    }
    if (handled) syncPropHighlightMatrix();
    return handled;
  }

  /** Run one native instance's installed material law — its UV scroll or free-running flipbook — for the
   *  inspector's Preview action, independently of the global Effects toggle. */
  function previewMaterialEffect(sourceIndex: number): boolean {
    let started = false;
    for (const material of refEffectMaterials.get(sourceIndex) ?? [])
      started = assets.propTex.previewMaterialEffect(material) || started;
    return started;
  }

  /** Restart one reference instance's compatible AnimObject clip for the inspector's Preview action. The
   * temporary player is independent of the global Effects toggle and runs one complete wrap/ping-pong cycle. */
  function previewAnimObject(sourceIndex: number, effect: AnimObjectEffect,
    autoReturnDelay: number | null = null): boolean {
    const animated = refAnimatedMeshes.find(candidate => !candidate.deltaGated
      && candidate.sourceIndices.includes(sourceIndex));
    if (!animated) return false;
    const existing = animObjectPreviews.get(sourceIndex);
    if (autoReturnDelay !== null && existing && retriggerTriggeredAnimObjectPlayback(existing)) return true;
    // A play-once clip on an Effect-end-latched slot keeps its finished node in the game, so its final frame
    // holds (the iris door stays open) until the player is cleared [Trailmap: 150-logic §slot-columns].
    const holdAtEnd = refHoldAtEnd.has(sourceIndex) && effect.loopMode !== 1 && effect.loopMode !== 2;
    animObjectPreviews.set(sourceIndex, createTriggeredAnimObjectPlayback(effect, animated.clip.clipFrames,
      sourceIndex + 1, holdAtEnd, autoReturnDelay));
    return true;
  }

  function clearAnimObjectPreviews(): boolean {
    if (!animObjectPreviews.size) return false;
    const cleared = new Set(animObjectPreviews.keys());
    animObjectPreviews.clear();
    for (const animated of refAnimatedMeshes) {
      let changed = false;
      for (let i = 0; i < animated.sourceIndices.length; i++) {
        if (!cleared.has(animated.sourceIndices[i])) continue;
        const sourceIndex = animated.sourceIndices[i];
        const ambientPlayback = animated.playbacks[i];
        setAnimatedFrame(animated, i, animObjectScrubs.get(sourceIndex)
          ?? (worldEffectsEnabled && animated.effect ? ambientPlayback?.frame ?? null : null));
        changed = true;
      }
      if (changed) animated.mesh.instanceMatrix.needsUpdate = true;
    }
    syncPropHighlightMatrix();
    return true;
  }

  /** Advance every compatible instance through its attached persistent AnimObject player. The native model
   * curves are applied in raw model-local space before RAW_TO_EDITOR, preserving axes and handedness. */
  function stepWorldEffects(dt: number) {
    if (dt <= 0) return;
    const previewFrames = new Map<number, number>();
    const endedPreviews = new Set<number>();
    for (const [sourceIndex, preview] of animObjectPreviews) {
      const sample = stepTriggeredAnimObjectPlayback(preview, dt);
      if (sample.done) { animObjectPreviews.delete(sourceIndex); endedPreviews.add(sourceIndex); }
      else previewFrames.set(sourceIndex, sample.frame);
    }
    for (const animated of refAnimatedMeshes) {
      let changed = false;
      for (let i = 0; i < animated.playbacks.length; i++) {
        const sourceIndex = animated.sourceIndices[i];
        const previewFrame = previewFrames.get(sourceIndex);
        const scrubFrame = animObjectScrubs.get(sourceIndex);
        let frame: number | null;
        let basis: number | null = null;
        const comboPlayback = isAnimComboEffect(animated.effect)
          ? animated.playbacks[i] as AnimComboPlayback | null : null;
        if (scrubFrame !== undefined) frame = scrubFrame;
        else if (previewFrame !== undefined) frame = previewFrame;
        // A triggered combo runs whether or not the ambient Effects toggle is on, for the same reason an
        // AnimDelta grant does: it is a one-shot something in the world asked for, not free-running motion.
        // Its IDLE half still answers to the toggle, which is why the untriggered case falls through.
        else if (comboPlayback && animated.effect
          && (worldEffectsEnabled || comboPlayback.active || comboPlayback.latched)) {
          const sample = stepAnimComboPlayback(comboPlayback, animated.effect as AnimComboEffect, dt);
          frame = sample.frame;
          basis = sample.basis;
          if (basis !== null && !comboTraced.has(comboPlayback)) {
            comboTraced.add(comboPlayback);
            const posed = (runtimeEntries.get(sourceIndex) ?? []).some(candidate =>
              candidate.mesh === animated.mesh && candidate.instanceId === i);
            comboLog(`${sourceIndex} posing frame ${frame.toFixed(1)} onto basis ${basis.toFixed(1)}`
              + ` · drawn entry ${posed ? 'FOUND' : 'MISSING — nothing to move'}`
              + ` · object ${animated.object} · effects toggle ${worldEffectsEnabled ? 'on' : 'off'}`);
          }
        } else if (animated.deltaGated && animated.effect && animated.playbacks[i])
          frame = stepAnimDeltaPlayback(animated.playbacks[i] as AnimDeltaPlayback, animated.effect, dt);
        else if (worldEffectsEnabled && animated.effect && animated.playbacks[i])
          frame = stepAnimObjectPlayback(animated.playbacks[i] as AnimObjectPlayback, animated.effect, dt);
        else if (endedPreviews.has(sourceIndex)) frame = null;
        else continue;
        setAnimatedFrame(animated, i, frame, basis);
        if (refAnimPathSource === sourceIndex && frame !== null) updateAnimObjectPathPlayhead(sourceIndex, frame);
        changed = true;
      }
      if (changed) animated.mesh.instanceMatrix.needsUpdate = true;
    }
    syncPropHighlightMatrix();
  }

  /** Tint the reference props by the light rig: set each instance's `instanceColor` to a warm multiply where
   *  a local light strikes it (a sign light lighting up the billboard it aims at), or white (no change) when
   *  the rig is off. Reference-only — the authored map has no rig. `null` / strength 0 clears the tint. */
  function setPropRigLighting(rig: LightRig | null, strength: number) {
    propRig = rig;
    propRigStrength = strength;
    applyPropRigTint();
  }

  function applyPropRigTint() {
    const active = !!propRig && propRigStrength > 0;
    const white = new THREE.Color(1, 1, 1);
    const cache = new Map<PropInstance[], THREE.Color[]>(); // one colour set per model (shared across its submeshes)
    for (const mesh of refPropMeshes) {
      if (mesh.userData.propNativeLighting) continue; // RGB carries the exact native-light table index
      const insts = mesh.userData.propInsts as PropInstance[] | undefined;
      if (!insts) continue;
      // BatchedMesh represents instance colour with a texture. Do not allocate one per material batch merely
      // to write the default white tint; once a rig has used it, white is required to clear that prior state.
      if (!active && !tintedPropMeshes.has(mesh)) continue;
      let colors = cache.get(insts);
      if (active && !colors) { colors = computePropTint(insts, propRig, propRigStrength); cache.set(insts, colors); }
      for (let k = 0; k < insts.length; k++) mesh.setColorAt(k, colors?.[k] ?? white);
      if (active) tintedPropMeshes.add(mesh);
      if (mesh instanceof THREE.InstancedMesh && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const [sourceIndex, copies] of runtimeInstanceCopies) applyRuntimeCopyTint(sourceIndex, copies);
  }

  function applyRuntimeCopyTint(sourceIndex: number, copies: RuntimeInstanceCopies) {
    const instance = refPropData?.instances.find(candidate => candidate.sourceIndex === sourceIndex);
    if (!instance) return;
    const active = !!propRig && propRigStrength > 0;
    const color = active ? computePropTint([instance], propRig, propRigStrength)[0] : new THREE.Color(1, 1, 1);
    for (const { mesh } of copies.draws) {
      if (mesh.userData.propNativeLighting) continue;
      if (!active && !tintedPropMeshes.has(mesh)) continue;
      for (let index = 0; index < copies.count; index++) mesh.setColorAt(index, color);
      mesh.instanceColor!.needsUpdate = true;
      if (active) tintedPropMeshes.add(mesh);
    }
  }

  /** Per-instance tint colours for one model: a saturating multiply `1 + MAX·(1 − e^(−strength·glow))` per
   *  channel (so overlapping lights bound to 1 + MAX× instead of blowing out), or white where the rig is off
   *  / a prop catches no light. Sampled at each placement's origin in editor space. */
  function computePropTint(insts: PropInstance[], rig: LightRig | null, strength: number): THREE.Color[] {
    const out: THREE.Color[] = [];
    const M = PROP_RIG_MAX_BOOST;
    for (const inst of insts) {
      if (rig && strength > 0) {
        const [gr, gg, gb] = propRigGlow(editorFromRaw(inst.loc), rig);
        out.push(new THREE.Color(
          1 + M * (1 - Math.exp(-strength * gr)),
          1 + M * (1 - Math.exp(-strength * gg)),
          1 + M * (1 - Math.exp(-strength * gb)),
        ));
      } else {
        out.push(new THREE.Color(1, 1, 1)); // untinted
      }
    }
    return out;
  }

  /** Show / hide the loaded reference's SCENERY props — trees / boulders / banners / fences / … (the group is
   *  built lazily by setProps; its rail / gem models live in the Tricks group instead). */
  function showProps(on: boolean) {
    refPropsVisible = on;
    refPropsGroup.visible = on && refPropsGroup.children.length > 0;
  }

  /** Show / hide the loaded reference's TRICK layer — its rail / gem prop models AND its grind curves, split
   *  out of the scenery so the Tricks view filter governs them (mirrors showProps for the Props toggle). */
  function showTricks(on: boolean) {
    refTricksVisible = on;
    refTrickModelsGroup.visible = on && refTrickModelsGroup.children.length > 0;
    courseDecor.showRailSplines(effectRailSplinesOn && on);
  }

  /** Effects mode asked for the grind curves; the Tricks filter still decides whether they are drawn, exactly
   *  as it does for the authored rails. Two independent gates, composed here so neither can clobber the other. */
  let effectRailSplinesOn = false;
  function showRailSplines(on: boolean) {
    effectRailSplinesOn = on;
    courseDecor.showRailSplines(on && refTricksVisible);
  }

  /** The reference props/tricks follow the shade view like the terrains: textured / neutral solid /
   *  triangle wires (the view filters above gate visibility independently). */
  function setShadeMode(m: ShadeMode) {
    if (m === decorShade) return;
    decorShade = m;
    applyPropShade(refPropsGroup, m);
    applyPropShade(refTrickModelsGroup, m);
    refPropSel.traverse(object => {
      const topology = object.userData.propSelectionTopology;
      if (topology === 'feature' || topology === 'wire')
        object.visible = topology === (decorShade === 'none' ? 'wire' : 'feature');
    });
  }

  /** Reveal every geometric effect host as a thin pickable wireframe while Reference Effects is active. */
  function showEffectProps(on: boolean) {
    refEffectPropsVisible = on;
    refEffectPropsGroup.visible = on && refEffectPropsGroup.children.length > 0;
  }

  /** Limit the map overlay to native instances that genuinely own a resolvable effect slot. */
  function setEffectPropIndices(indices: Iterable<number>) {
    effectPropIndices = new Set(indices);
    if (refPropData) setProps(refPropData);
  }

  async function setEffectPropIndicesProgressive(indices: Iterable<number>, yieldControl: () => Promise<void>) {
    effectPropIndices = new Set(indices);
    if (refPropData) await setPropsProgressive(refPropData, yieldControl);
  }

  /** Whether the loaded reference currently has its props built — scenery AND rail/gem models come from one
   *  payload, so this is the built check for either overlay (the host can then skip a re-fetch). */
  function hasProps(): boolean { return !!refPropData; }

  // ---- transparent draw order ------------------------------------------------------------------
  // The game ranks translucent object meshes by QUANTIZED CAMERA DEPTH and draws them back to front
  // ([Trailmap: 400-rendering] "Draw order" — descriptor +0x0e=2 selects a per-object ordinal, ~39 world
  // units per bucket). three.js sorts its transparent pass the same way in principle, but it measures each
  // object's ORIGIN, and every prop batch sits at the world origin with the placement in per-instance
  // matrices — so all batches score the same depth and the sort falls through to creation order. Rank them
  // here by the distance to their own bounds instead. Batch granularity is coarser than the game's per-object
  // ordinal (one rank for every instance sharing a material), but it recovers the ordering the tie was losing.
  const sortScratch = new THREE.Vector3();
  const sortRanking: { mesh: ReferencePropMesh; far: number }[] = [];
  /** `eye` is the camera's WORLD position — a VR ride parents the camera to the headset rig, so its own
   *  position is head-relative and would rank every prop against the wearer's play space instead. */
  function sortTransparentProps(eye: THREE.Vector3) {
    let count = 0;
    for (const mesh of refPropMeshes) {
      const material = mesh.material;
      const transparent = Array.isArray(material) ? material.some(m => m.transparent) : material.transparent;
      if (!transparent) continue;
      const sphere = mesh instanceof MergedStaticPropMesh ? mesh.geometry.boundingSphere : mesh.boundingSphere;
      sortScratch.set(0, 0, 0);
      if (sphere) sortScratch.copy(sphere.center);
      sortScratch.applyMatrix4(mesh.matrixWorld);   // props never move, so last frame's world matrix is exact
      const ranked = sortRanking[count] ?? { mesh, far: 0 };
      ranked.mesh = mesh;
      ranked.far = sortScratch.distanceToSquared(eye);
      sortRanking[count++] = ranked;
    }
    sortRanking.length = count;
    // Negative orders keep the whole prop set ahead of the renderOrder-0 scene transparents (gizmos, ghosts),
    // which is where they belong: world geometry composites before the overlays drawn on top of it.
    sortRanking.sort((a, b) => b.far - a.far);
    for (let i = 0; i < sortRanking.length; i++) sortRanking[i].mesh.renderOrder = i - sortRanking.length;
  }

  /** Live draw-object census for the Play profiler. Slots explain how much source geometry each draw covers. */
  const combinedRenderStats = {
    batchDraws: 0, batchSlots: 0, isolatedDraws: 0, isolatedSlots: 0, isolation: '',
  };
  const combinedIsolationByKind = new Map<string, number>();
  let combinedPropsSource: PropRenderStats | null = null, combinedTricksSource: PropRenderStats | null = null;
  let combinedPropsVisible = false, combinedTricksVisible = false;
  function renderStats() {
    const propsVisible = refPropsGroup.visible, tricksVisible = refTrickModelsGroup.visible;
    if (combinedPropsSource === propsRenderStats && combinedTricksSource === tricksRenderStats
      && combinedPropsVisible === propsVisible && combinedTricksVisible === tricksVisible) return combinedRenderStats;
    combinedPropsSource = propsRenderStats; combinedTricksSource = tricksRenderStats;
    combinedPropsVisible = propsVisible; combinedTricksVisible = tricksVisible;
    let batchDraws = 0, batchSlots = 0, isolatedDraws = 0, isolatedSlots = 0;
    combinedIsolationByKind.clear();
    const add = (stats: PropRenderStats) => {
      batchDraws += stats.batchDraws; batchSlots += stats.batchSlots;
      isolatedDraws += stats.isolatedDraws; isolatedSlots += stats.isolatedSlots;
      for (const [kind, draws] of stats.isolatedByKind)
        combinedIsolationByKind.set(kind, (combinedIsolationByKind.get(kind) ?? 0) + draws);
    };
    if (propsVisible) add(propsRenderStats);
    if (tricksVisible) add(tricksRenderStats);
    const isolation = [...combinedIsolationByKind].sort((a, b) => b[1] - a[1])
      .map(([kind, draws]) => `${kind} ${draws}`).join(' · ');
    Object.assign(combinedRenderStats, { batchDraws, batchSlots, isolatedDraws, isolatedSlots, isolation });
    return combinedRenderStats;
  }

  // ---- reference LIGHT + SOUND SOURCES ---------------------------------------------------------

  function syncSourcesVisibility() {
    refSourcesGroup.visible = refLightsVisible
      && (refLightSources.length > 0 || refSoundSources.length > 0 || refHiddenProps.length > 0);
  }

  function clearSourceDetail() {
    refSourceDetailGroup.traverse(object => {
      if (object instanceof THREE.LineSegments) object.geometry.dispose();
      if (object.userData.ownsSourceDetailMaterial && object instanceof THREE.LineSegments)
        (object.material as THREE.Material).dispose();
    });
    refSourceDetailGroup.clear();
    refSourceDetailGroup.visible = false;
  }

  function clearSourceSelection() {
    const hadReferenceLight = selectedSource?.kind === 'light';
    const hadReferenceProp = selectedSource?.kind === 'sound' || selectedSource?.kind === 'prop';
    selectedSource = null;
    setSourceMarkerSelected(refLightMarkers, null);
    setSourceMarkerSelected(refSoundMarkers, null);
    setSourceMarkerSelected(refPropMarkers, null);
    clearSourceDetail();
    if (hadReferenceProp) {
      selectedColliderInstance = null;
      collisionOverlay.clear();
      unityCollisionOverlay.clear();
    }
    if (hadReferenceLight) stage.cb.onSelectReferenceLight?.(null, null);
  }

  function rebuildLightMarkers() {
    if (refLightMarkers) refSourcesGroup.remove(refLightMarkers);
    disposeSourceMarkerPoints(refLightMarkers);
    refLightSources = (refLightData?.lights ?? []).filter(light => light.kind !== 'ambient');
    refLightMarkers = refLightSources.length
      ? sourceMarkerPoints(stage, 'light', 'reference', refLightSources.map(light => new THREE.Vector3(...light.pos)), {
          colors: refLightSources.map(light => light.colorHex),
          icons: refLightSources.map(light => light.kind === 'spot' ? 'spotlight' : 'bulb'),
          aimTargets: refLightSources.map(light => lightAimTarget(light)),
          selectedIndex: selectedSource?.kind === 'light' ? selectedSource.index : null,
        })
      : null;
    if (refLightMarkers) refSourcesGroup.add(refLightMarkers);
    syncSourcesVisibility();
  }

  function rebuildSoundMarkers() {
    if (selectedSource?.kind === 'sound') clearSourceSelection();
    if (refSoundMarkers) refSourcesGroup.remove(refSoundMarkers);
    disposeSourceMarkerPoints(refSoundMarkers);
    refSoundSources = [];
    if (refPropData) {
      const modelNames = new Map(refPropData.models.map(model => [model.id, model.name]));
      for (const inst of refPropData.instances) for (const emitter of inst.externalSounds) {
        if (emitter.sound === 0) continue; // event zero is the native silent sentinel, not an audible source
        refSoundSources.push({ inst, emitter, modelName: modelNames.get(inst.model) ?? inst.name });
      }
    }
    refSoundMarkers = refSoundSources.length ? sourceMarkerPoints(stage, 'sound', 'reference', refSoundSources.map(source =>
      new THREE.Vector3(...editorFromRaw([
        source.inst.loc[0] + source.emitter.offset[0],
        source.inst.loc[1] + source.emitter.offset[1],
        source.inst.loc[2] + source.emitter.offset[2],
      ]))), { selectedIndex: selectedSource?.kind === 'sound' ? selectedSource.index : null }) : null;
    if (refSoundMarkers) {
      // per-index identity for the dev agent layer's a11y mirror: owning-model names + effect-join keys
      refSoundMarkers.userData.sourceLabels = refSoundSources.map(s => s.modelName);
      refSoundMarkers.userData.sourceSourceIndices = refSoundSources.map(s => s.inst.sourceIndex);
      refSourcesGroup.add(refSoundMarkers);
    }
    syncSourcesVisibility();
  }

  /** Icon markers (Sources view, like the bulbs/speakers) at placements with nothing visible to click —
   *  hidden instances (triggers, reset zones, collision proxies, pre-broken junk twins) and instances of
   *  surfaceless models. Clicking one opens the same Prop Details a visible reference prop click shows,
   *  so an invisible trigger's model can finally be inspected. */
  function rebuildHiddenPropMarkers() {
    if (selectedSource?.kind === 'prop') clearSourceSelection();
    if (refPropMarkers) refSourcesGroup.remove(refPropMarkers);
    disposeSourceMarkerPoints(refPropMarkers);
    refPropMarkers = null;
    refHiddenProps = [];
    if (refPropData) {
      const modelNames = new Map(refPropData.models.map(model => [model.id, model.name]));
      const surfaceless = new Set(refPropData.models
        .filter(model => !model.subs.some(s => s.indices.length)).map(model => model.id));
      for (const inst of refPropData.instances) {
        if (inst.visible && !surfaceless.has(inst.model)) continue;
        refHiddenProps.push({ inst, modelName: modelNames.get(inst.model) ?? inst.name });
      }
    }
    if (refHiddenProps.length) {
      refPropMarkers = sourceMarkerPoints(stage, 'prop', 'reference',
        refHiddenProps.map(hidden => new THREE.Vector3(...editorFromRaw(hidden.inst.loc))));
      // per-index identity for the dev agent layer's a11y mirror: model names + effect-join keys
      refPropMarkers.userData.sourceLabels = refHiddenProps.map(hidden => hidden.modelName);
      refPropMarkers.userData.sourceSourceIndices = refHiddenProps.map(hidden => hidden.inst.sourceIndex);
      refSourcesGroup.add(refPropMarkers);
    }
    syncSourcesVisibility();
  }

  /** Keep only compact source icons resident. Clicking a bulb builds that one recovered rig on demand. */
  function setLights(rig: LightRig | null) {
    if (selectedSource?.kind === 'light') clearSourceSelection();
    refLightData = rig;
    rebuildLightMarkers();
  }

  /** Show the selected marker's full rig/range and, for a sound or hidden prop, identify its owning prop
   *  in Prop Details. */
  function selectSource(kind: SourceMarkerKind, index: number): boolean {
    const source = kind === 'light' ? refLightSources[index]
      : kind === 'sound' ? refSoundSources[index] : refHiddenProps[index];
    if (!source) return false;
    clearSourceSelection();
    selectedSource = { kind, index };
    setSourceMarkerSelected(kind === 'light' ? refLightMarkers
      : kind === 'sound' ? refSoundMarkers : refPropMarkers, index);
    if (kind === 'prop') {
      // an invisible placement (hidden trigger/proxy instance or surfaceless model): route the click to the
      // ordinary reference-prop details flow — any zero-scaled/proxy entry still resolves the highlight seat
      const hidden = source as RefHiddenProp;
      const target = effectHighlightTarget(hidden.inst.sourceIndex);
      if (target) highlightPropInstance(target.mesh, target.instanceId, 'props');
      selectedColliderInstance = hidden.inst;
      rebuildSelectedCollisionOverlay();
      showExternalSoundRanges(hidden.inst);
      stage.cb.onSelectReferenceProp?.(refPropData?.level ?? null, hidden.inst.model, hidden.modelName, hidden.inst);
      refSourceDetailGroup.visible = refSourceDetailGroup.children.length > 0;
      return true;
    }
    if (kind === 'light') {
      const light = source as LightRig['lights'][number];
      const positions: number[] = [], colors: number[] = [];
      addLightGizmo(positions, colors, light, new THREE.Color());
      if (positions.length) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
          vertexColors: true, transparent: light.negative, opacity: light.negative ? 0.7 : 1, depthWrite: false,
        }));
        lines.userData.ownsSourceDetailMaterial = true;
        lines.raycast = () => { /* the selected rig never steals clicks from source icons */ };
        refSourceDetailGroup.add(lines);
      }
      stage.cb.onSelectReferenceLight?.(refLightData?.level ?? null, light);
    } else {
      const sound = source as RefSoundSource;
      const target = effectHighlightTarget(sound.inst.sourceIndex);
      if (target) highlightPropInstance(target.mesh, target.instanceId, 'props');
      selectedColliderInstance = sound.inst;
      rebuildSelectedCollisionOverlay();
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(RAW_TO_EDITOR);
      const range = soundRangeObject(sound.emitter, sound.inst.loc, 1, externalSoundRangeMat);
      if (range) holder.add(range);
      if (holder.children.length) refSourceDetailGroup.add(holder);
      stage.cb.onSelectReferenceProp?.(refPropData?.level ?? null, sound.inst.model, sound.modelName, sound.inst);
    }
    refSourceDetailGroup.visible = refSourceDetailGroup.children.length > 0;
    return true;
  }

  /** The persisted Light-rig switch now means source discovery: bulbs + speakers, plus one selected detail. */
  function showLights(on: boolean) {
    refLightsVisible = on;
    syncSourcesVisibility();
  }

  /** Whether the loaded reference currently has its light rig built (so the host can skip a re-fetch). */
  function hasLights(): boolean { return !!refLightData; }

  /** Draw one or more shared read-only prop outlines without changing either editor's semantic selection. */
  function highlightPropInstances(targets: readonly { mesh: ReferencePropMesh; instanceId: number }[],
    owner: 'props' | 'effects') {
    clearPropHighlight();
    for (const { mesh, instanceId } of targets) {
      const slot = referencePropSlot(mesh, instanceId);
      if (!slot) continue;
      const allEntries = runtimeEntries.get(slot.inst.sourceIndex) ?? [];
      const targetEntry = allEntries.find(entry => entry.mesh === mesh && entry.instanceId === instanceId);
      if (!targetEntry) continue;
      const entries = targetEntry.proxy
        ? allEntries.filter(entry => entry.proxy)
        : allEntries.filter(entry => !entry.proxy);
      if (!entries.length) continue;
      const edgeGeometries = assets.propEdges(slot.level, slot.model, entries.map(entry => entry.geometry));
      const wireGeometries = assets.propWireEdges(slot.level, slot.model, entries.map(entry => entry.geometry));
      const addSelectionLines = (outline: THREE.Group, geometry: LineSegmentsGeometry | undefined,
        topology: 'feature' | 'wire') => {
        if (!geometry) return;
        const lines = new LineSegments2(geometry, refPropSelectionMat);
        lines.userData.propSelectionTopology = topology;
        lines.visible = topology === (decorShade === 'none' ? 'wire' : 'feature');
        lines.renderOrder = 100;
        lines.raycast = () => { /* never a pick target */ };
        outline.add(lines);
      };
      const hierarchy = entries.some(entry => entry.object !== null);
      const outlines: HighlightedProp[] = [];
      if (hierarchy) for (let sibling = 0; sibling < entries.length; sibling++) {
        const edge = edgeGeometries[sibling], entry = entries[sibling];
        const wire = wireGeometries[sibling];
        if (!edge && !wire) continue;
        const outline = new THREE.Group();
        outline.matrixAutoUpdate = false;
        entry.mesh.getMatrixAt(entry.instanceId, outline.matrix);
        addSelectionLines(outline, edge, 'feature');
        addSelectionLines(outline, wire, 'wire');
        refPropSel.add(outline);
        outlines.push({ mesh: entry.mesh, instanceId: entry.instanceId,
          sourceIndex: slot.inst.sourceIndex, outline });
      } else {
        const outline = new THREE.Group();
        outline.matrixAutoUpdate = false;
        targetEntry.mesh.getMatrixAt(targetEntry.instanceId, outline.matrix);
        for (let i = 0; i < Math.max(edgeGeometries.length, wireGeometries.length); i++) {
          addSelectionLines(outline, edgeGeometries[i], 'feature');
          addSelectionLines(outline, wireGeometries[i], 'wire');
        }
        refPropSel.add(outline);
        outlines.push({ mesh: targetEntry.mesh, instanceId: targetEntry.instanceId,
          sourceIndex: slot.inst.sourceIndex, outline });
      }
      // facing arrows over the selected retail instance (facing-arrows.ts, riding the F toggle): this is
      // the parity read — select a shipped prop and see the normals an authored model should match
      const arrowPts = hierarchy ? [] : facingArrowSegments(entries.map(entry => entry.geometry),
        assets.propLocalBox(slot.level, slot.model));
      if (arrowPts.length) {
        const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(arrowPts, 3));
        refArrowGeos.push(g);
        const arrows = new THREE.LineSegments(g, refArrowMat);
        arrows.renderOrder = 101;
        arrows.visible = refArrowsOn;
        arrows.raycast = () => { /* never a pick target */ };
        refArrowObjs.push(arrows);
        outlines[0]?.outline.add(arrows);
      }
      highlightedProps.push(...outlines.filter(item => item.outline.children.length));
    }
    refPropHighlightOwner = highlightedProps.length ? owner : null;
    refPropSel.visible = highlightedProps.length > 0;
  }

  /** The tile-orientation F toggle's reference half: facing arrows on the highlighted retail instance. */
  function setNormalArrows(on: boolean) {
    refArrowsOn = on;
    for (const o of refArrowObjs) o.visible = on;
  }

  function highlightPropInstance(mesh: ReferencePropMesh, instanceId: number, owner: 'props' | 'effects') {
    highlightPropInstances([{ mesh, instanceId }], owner);
  }

  function syncPropHighlightMatrix() {
    if (!highlightedProps.length || !refPropHighlightOwner) return;
    let anyVisible = false;
    for (const highlighted of highlightedProps) {
      if (runtimePieceMotions.has(highlighted.sourceIndex)) {
        // The outline geometry is one combined model silhouette, not independently partitioned like the rendered
        // shards. Hide that misleading rigid ghost during a piece throw and restore it when the throw resets.
        highlighted.outline.visible = false;
        continue;
      }
      highlighted.outline.visible = true;
      highlighted.mesh.getMatrixAt(highlighted.instanceId, highlighted.outline.matrix);
      highlighted.outline.matrixWorldNeedsUpdate = true;
      anyVisible = true;
    }
    refPropSel.visible = anyVisible;
  }

  /** Draw every recovered ADL listener region on the selected instance. These records are raw WORLD-space:
   *  their center is instance Location + U2/U3/U4 without model rotation/scale, so they live in a dedicated
   *  RAW_TO_EDITOR holder instead of under the model-local outline. */
  function showExternalSoundRanges(inst: PropInstance) {
    if (!inst.externalSounds.length) return;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(RAW_TO_EDITOR);
    for (const emitter of inst.externalSounds) {
      const range = soundRangeObject(emitter, inst.loc, 1, externalSoundRangeMat);
      if (range) holder.add(range);
    }
    if (holder.children.length) refPropSel.add(holder);
  }

  /** Draw the selected reference placement's native contact shape from the exact Test-mode resources. */
  function rebuildSelectedCollisionOverlay() {
    collisionOverlay.clear();
    unityCollisionOverlay.clear();
    const inst = selectedColliderInstance;
    if (!inst || !refPropData || inst.shape === 0) return;
    const active = inst.playerCollision;
    const entries = (runtimeEntries.get(inst.sourceIndex) ?? []).filter(entry => !entry.proxy);
    stage.refRoot.updateWorldMatrix(true, false);
    const parentInverse = stage.refRoot.matrixWorld.clone().invert();
    const raw = new THREE.Matrix4(), edit = new THREE.Matrix4(), world = new THREE.Matrix4();
    const baseWorldMatrix = (entry = entries[0]) => {
      if (entry) {
        entry.mesh.updateWorldMatrix(true, false);
        return world.multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry)).clone();
      }
      raw.compose(new THREE.Vector3(...inst.loc), new THREE.Quaternion(...inst.rot), new THREE.Vector3(...inst.scale));
      edit.multiplyMatrices(RAW_TO_EDITOR, raw);
      refPropsGroup.updateWorldMatrix(true, false);
      return world.multiplyMatrices(refPropsGroup.matrixWorld, edit).clone();
    };
    const parentMatrix = (matrixWorld: THREE.Matrix4) => parentInverse.clone().multiply(matrixWorld);

    if (inst.shape === 1) {
      const sourceGeometries: THREE.BufferGeometry[] = [];
      const pieces: CollisionOverlayMeshPiece[] = [];
      const collisionModels = inst.collisionModels ?? [];
      const pieceEntries = collisionModelEntries(entries, collisionModels.length);
      for (let index = 0; index < collisionModels.length; index++) {
        const id = collisionModels[index];
        const source = refPropData.collisionMeshes?.get(id);
        if (!source) continue;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
        sourceGeometries.push(geometry);
        pieces.push({ geometry, matrix: parentMatrix(baseWorldMatrix(pieceEntries?.[index])) });
      }
      collisionOverlay.showMeshes(pieces, active);
      for (const geometry of sourceGeometries) geometry.dispose();
      return;
    }
    if (inst.shape === 2) {
      // The collider is the MODEL's own box turned with the placement, not the axis-aligned envelope of the
      // turned result ([Trailmap: 130-mode2-oriented]) — so this unions the raw local bounds and draws them
      // under the placement, the same way the mode-3 branches below do.
      const local = new THREE.Box3();
      for (const entry of entries) {
        if (!entry.geometry.boundingBox) entry.geometry.computeBoundingBox();
        if (entry.geometry.boundingBox) local.union(entry.geometry.boundingBox);
      }
      if (!local.isEmpty()) {
        collisionOverlay.showPrimitives({
          boxes: [{ center: local.getCenter(new THREE.Vector3()).toArray() as V3,
            size: local.getSize(new THREE.Vector3()).toArray() as V3 }],
          capsules: [],
        }, parentMatrix(baseWorldMatrix()), active);
      }
      return;
    }
    if (inst.shape === 3 && inst.physicsBody >= 0) {
      const spheres = refPropData.physicsBodies?.get(inst.physicsBody);
      if (spheres?.length) collisionOverlay.showSpheres(spheres, parentMatrix(baseWorldMatrix()), active);
      if (!active) return; // disabled native geometry is diagnostic only; the exporter emits no Unity collider
      const recipe = refPropData.unityBodyRecipes?.get(inst.physicsBody);
      if (inst.dynamicMass > 0) {
        // Roller props are diverted to their own Rigidbody + visible-mesh BoxCollider in PropBuilder.
        const local = new THREE.Box3();
        for (const entry of entries) {
          if (!entry.geometry.boundingBox) entry.geometry.computeBoundingBox();
          if (entry.geometry.boundingBox) local.union(entry.geometry.boundingBox);
        }
        if (!local.isEmpty()) {
          const shape = { boxes: [{ center: local.getCenter(new THREE.Vector3()).toArray() as V3,
            size: local.getSize(new THREE.Vector3()).toArray() as V3 }], capsules: [] };
          unityCollisionOverlay.showPrimitives(shape, parentMatrix(baseWorldMatrix()));
        }
      } else {
        const kind = recipe ? unityBodyRecipeKind(recipe, inst.rot, inst.scale) : 'bounds';
        if (kind === 'bounds') {
          const box = new THREE.Box3();
          for (const entry of entries) {
            if (!entry.geometry.boundingBox) entry.geometry.computeBoundingBox();
            if (!entry.geometry.boundingBox) continue;
            entry.mesh.updateWorldMatrix(true, false);
            const matrix = world.multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry));
            box.union(entry.geometry.boundingBox.clone().applyMatrix4(parentMatrix(matrix)));
          }
          unityCollisionOverlay.showBox(box, true);
        } else if (recipe) {
          raw.compose(new THREE.Vector3(...inst.loc), new THREE.Quaternion(...inst.rot), new THREE.Vector3(1, 1, 1));
          edit.multiplyMatrices(RAW_TO_EDITOR, raw);
          refPropsGroup.updateWorldMatrix(true, false);
          const pose = parentMatrix(world.multiplyMatrices(refPropsGroup.matrixWorld, edit).clone());
          unityCollisionOverlay.showPrimitives(scaleBodyShape(recipe[kind], inst.scale), pose);
        }
      }
    }
  }

  function setCollisionOverlayVisible(on: boolean) {
    collisionOverlay.setVisible(on);
    unityCollisionOverlay.setVisible(on);
    if (on && !collisionOverlay.group.children.length && !unityCollisionOverlay.group.children.length)
      rebuildSelectedCollisionOverlay();
  }

  /** Drop the paint-mode surface-inspection outline (disposes its edge geometry). Safe when none shows. */
  function clearSurfaceInspection() {
    for (const lines of surfInspectObjs) lines.parent?.remove(lines);
    for (const geometry of surfInspectGeos) geometry.dispose();
    surfInspectObjs = [];
    surfInspectGeos = [];
    surfInspectGroup.visible = false;
  }

  /** Paint-mode inspect: outline the clicked SURFACE so the viewport marks exactly what the palette
   *  readout describes. `faces` = the connected face group (UV island) under the cursor — one wall, one
   *  leaf quad — outlined via its feature/boundary edges; null falls back to the whole submesh. `object`
   *  is the raycast hit — a reference InstancedMesh (seat at `instanceId`'s matrix) or an authored
   *  placed-prop Mesh (attach as its child). Replaces any previous inspection outline. */
  function inspectSurface(object: THREE.Object3D, instanceId = 0, faces: number[] | null = null) {
    clearSurfaceInspection();
    const geometry = referencePropGeometry(object, instanceId);
    if (!geometry) return;
    let source = geometry;
    if (faces?.length && geometry.getIndex()) {
      // subset geometry for just the clicked face group: shares the position attribute, owns a tiny index.
      // Never rendered or uploaded — EdgesGeometry reads it and the temp is dropped, so no dispose needed.
      const idx = geometry.getIndex()!;
      const sub = new Uint32Array(faces.length * 3);
      faces.forEach((t, i) => {
        sub[i * 3] = idx.getX(t * 3);
        sub[i * 3 + 1] = idx.getX(t * 3 + 1);
        sub[i * 3 + 2] = idx.getX(t * 3 + 2);
      });
      source = new THREE.BufferGeometry();
      source.setAttribute('position', geometry.getAttribute('position'));
      source.setIndex(new THREE.BufferAttribute(sub, 1));
    }
    const edges = new THREE.EdgesGeometry(source, 30);
    const lines = new THREE.LineSegments(edges, surfInspectMat);
    lines.renderOrder = 100;
    lines.raycast = () => { /* never a pick target */ };
    surfInspectGeos.push(edges);
    surfInspectObjs.push(lines);
    if (isReferencePropMesh(object)) {
      object.getMatrixAt(instanceId, surfInspectGroup.matrix);
      surfInspectGroup.matrixWorldNeedsUpdate = true;
      surfInspectGroup.add(lines);
      surfInspectGroup.visible = true;
    } else {
      object.add(lines); // authored placement: the outline rides the mesh's own pose
    }
  }

  /** Select a native instance as the Props-mode read-only pick by original Instances.json index — the
   *  programmatic twin of clicking it (Effects mode's "Go to prop" jump). False when the instance has no
   *  built entry yet (props not loaded). */
  function selectInstanceBySource(sourceIndex: number): boolean {
    const target = effectHighlightTarget(sourceIndex);
    if (!target) return false;
    selectPropInstance(target.mesh, target.instanceId);
    return true;
  }

  /** Outline a clicked reference prop instance READ-ONLY and notify Props, which owns the preview-card state. */
  function selectPropInstance(im: ReferencePropMesh, instanceId: number) {
    clearSourceSelection();
    highlightPropInstance(im, instanceId, 'props');
    const slot = referencePropSlot(im, instanceId);
    const level = slot?.level ?? null, model = slot?.model ?? null;
    const inst = slot?.inst;
    if (inst) {
      selectedColliderInstance = inst;
      rebuildSelectedCollisionOverlay();
      showExternalSoundRanges(inst);
    }
    // PropInstance satisfies RefPropPickDetails. Material-submesh identity belongs to Paint/texture inspection.
    stage.cb.onSelectReferenceProp?.(level, model, slot?.name ?? im.name, inst);
  }

  function effectHighlightTarget(sourceIndex: number): { mesh: ReferencePropMesh; instanceId: number } | null {
    const entries = runtimeEntries.get(sourceIndex) ?? [];
    const runtimeVisible = runtimeVisibility.get(sourceIndex);
    // A hidden trigger still has a normal textured entry, but its matrix is intentionally zero-scaled. Prefer a
    // genuinely visible normal entry; otherwise seat the amber outline on the full-size purple Effects proxy.
    const target = entries.find(entry => !entry.proxy && (runtimeVisible ?? entry.defaultVisible))
      ?? entries.find(entry => entry.proxy)
      ?? entries.find(entry => !entry.proxy);
    return target ? { mesh: target.mesh, instanceId: target.instanceId } : null;
  }

  /** Highlight an Effects host set through original Instances.json indices without mutating Props selection. */
  function highlightEffectPropSourceIndices(sourceIndices: Iterable<number>): boolean {
    const targets: { mesh: ReferencePropMesh; instanceId: number }[] = [];
    const seen = new Set<string>();
    for (const sourceIndex of sourceIndices) {
      const target = effectHighlightTarget(sourceIndex);
      if (!target) continue;
      const key = `${target.mesh.uuid}:${target.instanceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
    if (!targets.length) { clearEffectPropHighlight(); return false; }
    highlightPropInstances(targets, 'effects');
    return true;
  }

  /** World-space bounds for one original Instances.json placement, accumulated across every material submesh.
   *  Effect-only/animated hosts have no static mesh and return null so callers can fall back to their origin. */
  function propWorldSphere(sourceIndex: number): THREE.Sphere | null {
    const box = new THREE.Box3();
    const worldMatrix = new THREE.Matrix4();
    let found = false;
    for (const entry of runtimeEntries.get(sourceIndex) ?? []) {
      // Prefer textured geometry; fall back to the Effects proxy for effect-only hosts.
      if (entry.proxy && (runtimeEntries.get(sourceIndex) ?? []).some(candidate => !candidate.proxy)) continue;
      if (!entry.geometry.boundingBox) entry.geometry.computeBoundingBox();
      const localBox = entry.geometry.boundingBox;
      if (!localBox) continue;
      entry.mesh.updateWorldMatrix(true, false);
      worldMatrix.multiplyMatrices(entry.mesh.matrixWorld, runtimeMatrices.get(sourceIndex) ?? entry.base);
      box.union(localBox.clone().applyMatrix4(worldMatrix));
      found = true;
    }
    return found && !box.isEmpty() ? box.getBoundingSphere(new THREE.Sphere()) : null;
  }

  /** Snapshot native prop collision pieces for a reference Play run. Authored/default visibility is deliberately
   * irrelevant: retail's hidden utility/twin placements remain collidable when PlayerCollision says they are.
   * An explicit runtime hide (including a selected mode function) does retire contact. Mode 1 reads Collision/*.obj,
   * mode 2 builds the native raw-world AABB, and mode 3 keeps the decoded sphere tree analytic instead of
   * tessellating thousands of leaves into an approximate mesh. */
  function rideColliders(): RideObstacleSource[] {
    if (!refPropData) return [];
    refPropsGroup.updateWorldMatrix(true, false);
    const out: RideObstacleSource[] = [];
    const worldMatrix = new THREE.Matrix4();
    const raw = new THREE.Matrix4(), edit = new THREE.Matrix4();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
    const geometryCache = new Map<string, THREE.BufferGeometry>();
    // Live poses for the instances that MOVE during a run. `runtimeEntryMatrix` is the one reading that already
    // folds in the model clip, an effect matrix override and a piece throw, so re-reading it each frame is all a
    // deploying ramp or a retracting pillar needs to carry its collider along. The scratch is consumed
    // immediately by the ride's refit — the documented contract for `RideObstacleSource.liveMatrix`.
    const livePose = new THREE.Matrix4();
    const entryPose = (entry: RuntimeInstanceEntry) => () => {
      entry.mesh.updateWorldMatrix(true, false);
      return livePose.multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry));
    };
    // Mode 2 tests the instance's world AABB, so its live pose is that box re-derived rather than one transform.
    const instanceBox = new THREE.Box3(), localBox = new THREE.Box3();
    const boxMatrix = new THREE.Matrix4(), boxCenter = new THREE.Vector3(), boxSize = new THREE.Vector3();
    const boxRotation = new THREE.Quaternion();
    const composeInstanceBox = (boxEntries: RuntimeInstanceEntry[], target: THREE.Matrix4) => {
      instanceBox.makeEmpty();
      for (const entry of boxEntries) {
        if (!entry.geometry.boundingBox) entry.geometry.computeBoundingBox();
        if (!entry.geometry.boundingBox) continue;
        entry.mesh.updateWorldMatrix(true, false);
        boxMatrix.multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry));
        instanceBox.union(localBox.copy(entry.geometry.boundingBox).applyMatrix4(boxMatrix));
      }
      return instanceBox.isEmpty() ? null
        : target.compose(instanceBox.getCenter(boxCenter), boxRotation, instanceBox.getSize(boxSize));
    };
    const nativeGeometry = (id: string) => {
      const cached = geometryCache.get(id);
      if (cached) return cached;
      const source = refPropData?.collisionMeshes?.get(id);
      if (!source) return null;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
      geometryCache.set(id, geometry);
      return geometry;
    };
    for (const instance of refPropData.instances) {
      if (instance.contact === 'ghost') continue;
      const sourceIndex = instance.sourceIndex;
      if (runtimeVisibility.get(sourceIndex) === false) continue;
      const allEntries = runtimeEntries.get(sourceIndex) ?? [];
      const entries = allEntries.filter(entry => !entry.proxy);
      const entry = entries[0];
      // The rendered entry's own transform, animation delta included — the same reading the collision overlay
      // draws, so what you inspect and what you ride into agree even mid-clip.
      const pose = entry ? entryPose(entry) : null;
      // The stamp gate for that pose: the ride only recomposes it after a funnel bump says it may have moved.
      const poseVersion = () => runtimePoseVersions.get(sourceIndex) ?? 0;
      if (entry) {
        entry.mesh.updateWorldMatrix(true, false);
        worldMatrix.multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry));
      } else {
        raw.compose(pos.fromArray(instance.loc), quat.fromArray(instance.rot), scale.fromArray(instance.scale));
        edit.multiplyMatrices(RAW_TO_EDITOR, raw);
        worldMatrix.multiplyMatrices(refPropsGroup.matrixWorld, edit);
      }
      const key = `reference:${sourceIndex}`;
      // Rider response and dynamic activation are orthogonal [Trailmap: 130-collision-data, 370-world-interaction].
      // Response mass and PlayerBounce decide whether this contact is solid; a collision Roller with a finite
      // positive mass independently activates the body's motion.
      const movable = Number.isFinite(instance.dynamicMass) && instance.dynamicMass > 0;
      // An inline DeadNodeMode-4 collision graph is the breakable's native ride-through response: keep the
      // collider as a sensor so the contact still pops/hides it, but do not bounce the rider before that dispatch.
      const solid = instance.contact === 'solid' && !refImmediateBreaks.has(sourceIndex);
      const common = {
        key, object: { kind: 'reference' as const, index: sourceIndex }, solid,
        bounce: solid ? (instance.bounce >= 0 ? instance.bounce : 0.5) : 0,
        playerBounce: instance.playerBounce,
        surface: solid ? instance.surface : -1,
        dynamicMass: movable ? instance.dynamicMass : 0,
        // Only the shove path consumes these, and only a body that authored a tensor has them.
        ...(movable ? (() => {
          const props = refPropData.physicsMassProps?.get(instance.physicsBody);
          return props ? { body: { com: props.com, invInertia: props.invInertia } } : {};
        })() : {}),
      };
      if (instance.shape === 1) {
        let added = false;
        const collisionModels = instance.collisionModels ?? [];
        const pieceEntries = collisionModelEntries(entries, collisionModels.length);
        for (let index = 0; index < collisionModels.length; index++) {
          const id = collisionModels[index];
          const geometry = nativeGeometry(id);
          if (!geometry) continue;
          // A multi-object animated model owns one proxy per non-empty ModelObject. Bind each proxy to its own
          // rendered object's matrix; sharing `entries[0]` leaves every sibling at the first object's pose (the
          // Elysium iris door's object 0 is its stationary frame, which produced the closed invisible wall).
          const pieceEntry = pieceEntries?.[index] ?? entry;
          const piecePose = pieceEntry ? entryPose(pieceEntry) : null;
          if (pieceEntry) {
            pieceEntry.mesh.updateWorldMatrix(true, false);
            worldMatrix.multiplyMatrices(pieceEntry.mesh.matrixWorld, runtimeEntryMatrix(pieceEntry));
          }
          out.push({ ...common, geometry, matrixWorld: worldMatrix.clone(),
            ...(piecePose ? { liveMatrix: piecePose, poseVersion } : {}) });
          added = true;
        }
        if (added) continue;
        // Malformed/older extraction fallback: preserve contact rather than silently dropping it, but normal
        // extracted levels always take the dedicated Collision/*.obj path above.
      }
      if (instance.shape === 3 && instance.physicsBody >= 0) {
        const spheres = refPropData.physicsBodies?.get(instance.physicsBody);
        if (spheres?.length) {
          out.push({ ...common, spheres, matrixWorld: worldMatrix.clone(),
            ...(pose ? { liveMatrix: pose, poseVersion } : {}) });
          continue;
        }
        // Same defensive fallback as mode 1 for an incomplete extraction.
      }
      if (instance.shape === 2) {
        if (!entries.length) continue;
        const boxWorld = composeInstanceBox(entries, new THREE.Matrix4());
        // An empty re-derivation leaves the box where it was rather than collapsing it onto the origin.
        if (boxWorld) out.push({ ...common, geometry: rideBoxGeo, matrixWorld: boxWorld,
          liveMatrix: () => composeInstanceBox(entries, livePose) ?? boxWorld, poseVersion });
        continue;
      }
      if (!entries.length) continue;
      for (const entry of entries) {
        entry.mesh.updateWorldMatrix(true, false);
        out.push({ ...common, geometry: entry.geometry, liveMatrix: entryPose(entry), poseVersion,
          matrixWorld: new THREE.Matrix4().multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry)) });
      }
    }
    return out;
  }

  /** Geometry-derived world muzzle for particle emitters hosted by a reference prop. The model-local principal
   *  extent comes from the shared prop cache; the live runtime matrix keeps the answer correct for animated or
   *  effect-moved instances too. */
  function runtimeEmitterMuzzle(sourceIndex: number): { position: THREE.Vector3; direction: THREE.Vector3 } | null {
    const entry = (runtimeEntries.get(sourceIndex) ?? []).find(candidate => !candidate.proxy);
    if (!entry) return null;
    const extent = assets.propPrincipalExtent(entry.level, entry.model);
    if (!extent) return null;
    entry.mesh.updateWorldMatrix(true, false);
    const worldMatrix = new THREE.Matrix4().multiplyMatrices(entry.mesh.matrixWorld, runtimeEntryMatrix(entry));
    return {
      position: new THREE.Vector3(...extent.muzzle).applyMatrix4(worldMatrix),
      direction: new THREE.Vector3(...extent.axis).transformDirection(worldMatrix),
    };
  }

  /** Drop a visual outline owned by one editor. An owner guard prevents one mode clearing the other's state. */
  function clearPropHighlight(owner?: 'props' | 'effects'): boolean {
    if (owner && refPropHighlightOwner !== owner) return false;
    const had = refPropHighlightOwner !== null;
    refPropSel.visible = false;
    refPropSel.clear();
    for (const g of refArrowGeos) g.dispose();
    refArrowGeos = [];
    refArrowObjs = [];
    refPropHighlightOwner = null;
    highlightedProps = [];
    selectedColliderInstance = null;
    collisionOverlay.clear();
    unityCollisionOverlay.clear();
    return had;
  }

  /** Clear the semantic Props selection and notify its preview-card state. */
  function clearPropSelection() {
    const sourceOwnedProp = selectedSource?.kind === 'sound';
    clearSourceSelection();
    if (clearPropHighlight('props') || sourceOwnedProp) stage.cb.onSelectReferenceProp?.(null, null, null);
  }

  /** Clear only Effects' visual host highlight; never touches Props selection or callbacks. */
  function clearEffectPropHighlight(): boolean { return clearPropHighlight('effects'); }

  refPropsGroup.visible = false;     // shown only while the reference's "show props" toggle is on
  stage.refRoot.add(refPropsGroup);  // props ride the reference's chirality flip + placement offset
  refPropSel.matrixAutoUpdate = false; // seated by the selected instance's own matrix
  refPropSel.visible = false;
  stage.refRoot.add(refPropSel);     // the read-only selection outline rides the reference frame too
  surfInspectGroup.matrixAutoUpdate = false; // seated by the inspected instance's own matrix
  surfInspectGroup.visible = false;
  stage.refRoot.add(surfInspectGroup); // the paint-mode surface inspection rides the reference frame too
  refSourceDetailGroup.visible = false;
  refSourcesGroup.add(refSourceDetailGroup);
  refSourcesGroup.visible = false;    // shown only while the Sources toggle is on
  stage.refRoot.add(refSourcesGroup); // light/sound sources ride the same reference frame as terrain + props
  refTrickModelsGroup.visible = false;   // shown only while the Tricks filter is on (with a reference loaded)
  stage.refRoot.add(refTrickModelsGroup); // reference rail / gem models ride the same frame as the props
  refEffectPropsGroup.visible = false;
  stage.refRoot.add(refEffectPropsGroup); // attached native effects are exposed only for Effects-mode picking
  refAnimPathGroup.visible = false;
  stage.refRoot.add(refAnimPathGroup);     // selected recovered model trajectory uses the reference's own frame
  // the recovered course line + AI network (reference-decor-course.ts); they add their own refRoot groups here,
  // in the same order they were added when they lived inline
  const courseDecor = createReferenceCourseDecor(stage);
  const { setCourse, showCourse, setAiPaths, showAiPaths, setRailSplines, selectRailSpline,
    railSplineMaterials } = courseDecor;

  return {
    get selectionOutlineMat() { return refPropSelectionMat; },
    /** Visible native geometry ordinary Props-mode picking may select. The Effects-only proxy stays excluded. */
    get propPickGroups() { return [refPropsGroup, refTrickModelsGroup] as const; },
    /** Every prop draw, for a consumer that gates or measures them wholesale (the ride's range cull reads
     *  this to reach the batched slots). Live array — a props rebuild replaces its contents. */
    get propDrawMeshes() { return refPropMeshes as readonly ReferencePropMesh[]; },
    get effectPropGroups() { return [refPropsGroup, refTrickModelsGroup, refEffectPropsGroup] as const; },
    get sourcePickGroups() { return [refSourcesGroup] as const; },
    setProps, setPropsProgressive, setEffectsData, setLights, showProps, showTricks, showEffectProps, setShadeMode,
    setEffectPropIndices, setEffectPropIndicesProgressive,
    setWorldEffectsEnabled, stepWorldEffects, previewAnimObject, previewMaterialEffect, clearAnimObjectPreviews,
    referenceAnimObjectClip, setAnimObjectScrubFrame, showAnimObjectPath,
    setRuntimeInstanceWorldMatrix, setRuntimeInstanceWorldCopies, setRuntimeInstanceVisible, runtimeInstancePieceIds,
    setRuntimeInstancePieceMotions, resetRuntimeInstances,
    controlRuntimeInstanceProperty, resetRuntimePropertyControls, resetRuntimeInstanceEffects, instanceHasPulseProperty,
    instanceHasTriggerableCombo,
    showLights, hasProps, hasLights, renderStats, sortTransparentProps, selectSource, clearSourceSelection,
    setCourse, showCourse, setAiPaths, showAiPaths,
    setRailSplines, showRailSplines, selectRailSpline, railSplineMaterials,
    get railSplineGroup() { return courseDecor.railSplineGroup; },
    setPropRigLighting, selectPropInstance, selectInstanceBySource, inspectSurface, clearSurfaceInspection,
    highlightEffectPropSourceIndices, propWorldSphere, runtimeEmitterMuzzle,
    rideColliders,
    clearPropSelection, clearEffectPropHighlight, setNormalArrows, setCollisionOverlayVisible,
  };
}

export type ReferenceDecor = ReturnType<typeof createReferenceDecor>;
