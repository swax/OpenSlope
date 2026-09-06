import type { V3 } from '../doc/types';
import type { BodyShape, UnityBodyRecipe } from '../collision/unity-body';
import type { ExternalSoundEmitter } from '../effects/external-sound';
import { registerCollisionSoundIndex, type CollisionSoundIndex } from '../effects/collision-sound';
import type { UvScrollEffect } from '../effects/world-effects';
export { NATIVE_COLLISION_MODE } from '../collision/native';

/** A material law authored explicitly rather than inferred from native flags or texture pixels. */
export type PropAlphaMode = 'opaque' | 'cutout' | 'blend' | 'glow';

/** Narrow untrusted JSON / glTF-derived values to the material modes every renderer and exporter supports. */
export function propAlphaMode(value: unknown): PropAlphaMode | undefined {
  return value === 'opaque' || value === 'cutout' || value === 'blend' || value === 'glow' ? value : undefined;
}

/** One render state must cover every frame of a material. Use the same strongest-state precedence as the
 * viewport's pixel classifier when page-specific overrides disagree across a flipbook. */
export function combinePropAlphaModes(modes: readonly (PropAlphaMode | undefined)[]): PropAlphaMode | undefined {
  return modes.includes('cutout') ? 'cutout'
    : modes.includes('glow') ? 'glow'
      : modes.includes('blend') ? 'blend'
        : modes.includes('opaque') ? 'opaque' : undefined;
}

/**
 * Read-only reference PROPS: the placed static objects (trees, boulders, banners, scaffolding, …) of an
 * extracted level, so they can be shown on the reference terrain in the viewport. This is the prop-side
 * companion to terrain.ts — where that tessellates a level's Patches.json, this decodes its Models.json +
 * Instances.json + per-mesh geometry. The server (server/routes/props.ts) does the disk reading and OBJ parsing;
 * this decodes the compact payload it sends into typed arrays the viewport can instance.
 *
 * Everything stays in the SAME raw SSX space (cm, Z-up, X-mirrored) as the terrain: model vertices are
 * model-local cm, an instance's Location/Rotation/Scale places the model in that raw world, and the viewport
 * maps each instance through the same raw→editor transform the terrain uses (ref-level.editorFromRaw as a
 * matrix), so props and terrain co-register by construction. Each model is split into per-material submeshes
 * carrying UVs, so props render textured from the same Textures/ the paint palette reads.
 */

/** One material group of a model: its texture (via `mat`) + indexed geometry with UVs (model-local cm). */
export interface PropSub {
  /** MaterialID — index into LevelProps.materials (→ texture file); -1 when the mesh is untextured. */
  mat: number;
  /** Model-local vertex positions (cm), xyz-interleaved. */
  positions: Float32Array;
  /** Texture coords (u, v) per vertex — raw OBJ vt (bottom-left origin), interleaved. */
  uvs: Float32Array;
  /** Native model-local vertex normals. Retail instance light vectors are stored in this exact frame. */
  normals?: Float32Array;
  /** Triangle indices into positions / uvs. */
  indices: Uint32Array;
  /** Native model-object index when this submesh is an independently throwable piece. */
  piece?: number;
  /** Native model-local rotation pivot shared by every material submesh belonging to this piece. */
  piecePivot?: V3;
  /** Native ModelObjects[] index for geometry driven by a full object-hierarchy animation. The vertices are
   *  still baked into that object's rest pose; the renderer applies an animated-world × inverse-rest delta. */
  object?: number;
}

export type PropModelCurve = [number, number, number, number, number, number][];

/** Conservative model-clip subset the merged reference renderer can animate without reconstructing the full
 * object hierarchy: every visible mesh belongs to one animated subtree, with at most one moving rotation
 * channel. Translation channels are retained as well; this is the shape used by Merqury City's blimp, whose
 * body and screen travel together while turning about raw model Z. */
export interface PropModelRotation {
  /** Native clip length in 30 fps frames. */
  clipFrames: number;
  /** Raw model-local rotation axis (0 = X, 1 = Y, 2 = Z), absent for a translation-only clip. */
  axis?: 0 | 1 | 2;
  /** Piecewise cubic [a,b,c,d,startSeconds,endSeconds], evaluated by Horner at absolute clip time. */
  segments?: PropModelCurve;
  /** Optional raw model-local X/Y/Z translations. Null entries are fixed at zero. */
  translation?: [PropModelCurve | null, PropModelCurve | null, PropModelCurve | null];
}

export type PropModelTransformChannel = 'translate-x' | 'translate-y' | 'translate-z'
  | 'rotate-x' | 'rotate-y' | 'rotate-z';
export type PropModelAnimationChannelId = PropModelTransformChannel | `object-${number}-${PropModelTransformChannel}`;

/** One native ModelObject in a general model clip. `rest*` is the exact Models.json transform used to bake its
 * geometry. Animated objects also carry the engine's six-component base pose and one cubic curve per enabled
 * AnimationAction bit; unanimated descendants still move because their parent relation is retained. */
export interface PropModelAnimationObject {
  parent: number;
  restPosition: V3;
  restRotation: [number, number, number, number];
  restScale: V3;
  basePosition?: V3;
  /** Native animation Euler base in degrees. Unity and the reference renderer apply it in ZXY order. */
  baseEuler?: V3;
  /** X/Y/Z translation then X/Y/Z rotation. Null means that component keeps its base pose. */
  channels?: [PropModelCurve | null, PropModelCurve | null, PropModelCurve | null,
    PropModelCurve | null, PropModelCurve | null, PropModelCurve | null];
}

/** Full object-hierarchy clip used when a model cannot be reduced to the compact merged-renderer subset.
 * The PAL runtime is safe through 27 total native objects [Trailmap: 120-objects]. */
export interface PropModelAnimation {
  /** Native clip length in 30 fps frames. */
  clipFrames: number;
  objects: PropModelAnimationObject[];
}

export type PropModelClip = PropModelRotation | PropModelAnimation;

export function isPropModelAnimation(clip: PropModelClip): clip is PropModelAnimation {
  return 'objects' in clip;
}

/** PAL SSX Tricky's fixed animated-model matrix workspace holds this many TOTAL native ModelObjects.
 * Unity has no corresponding limit, so editor/export callers use this as a warning threshold, never a
 * document-validation cap [Trailmap: 120-model-object-limit]. */
export const SSX_TRICKY_MAX_NATIVE_MODEL_OBJECTS = 27;

/** Whether the clip already carries the unanimated identity root the export/packer contract requires. */
export function propModelAnimationHasIdentityRoot(animation: PropModelAnimation): boolean {
  const first = animation.objects[0];
  return !!first && first.parent < 0
    && !first.channels?.some(curve => !!curve?.length)
    && first.restPosition.every(v => v === 0)
    && Math.abs(first.restRotation[3]) === 1
    && Math.hypot(first.restRotation[0], first.restRotation[1], first.restRotation[2]) === 0
    && first.restScale.every(v => v === 1);
}

/** Project the ordinary final native ModelObjects count without packing geometry. `bakedPropClip` guarantees
 * one identity root; the canonical exporter does not add identity placement mounts above its children.
 * A rare animated spline mover can still require a real orientation/scale mount, which export validates from
 * the final packed count. Invalid/empty clips pack as the ordinary one-object static model. */
export function projectedNativeModelObjectCount(animation: PropModelAnimation): number {
  if (!animation.objects.length || !(animation.clipFrames > 0)) return 1;
  const rootShift = propModelAnimationHasIdentityRoot(animation) ? 0 : 1;
  return animation.objects.length + rootShift;
}

/** Read-only timeline metadata derived from the compact model curves. These markers are the boundaries of
 * recovered cubic segments, not necessarily the source DCC application's original animation keys. */
export interface PropModelAnimationChannel {
  id: PropModelAnimationChannelId;
  label: string;
  unit: 'cm' | 'deg';
  kind: 'translate' | 'rotate';
  axis: 0 | 1 | 2;
  /** Native ModelObjects[] index for a hierarchical clip. */
  object?: number;
  segments: number;
  /** Native 30 fps clip frames at which a recovered cubic segment starts or ends. */
  boundaryFrames: number[];
}

/** One distinct prop model: its per-material submeshes and its display name. */
export interface PropModel {
  /** ModelID — the index into the level's Models[] that instances reference. */
  id: number;
  name: string;
  subs: PropSub[];
  rotation?: PropModelRotation;
  animation?: PropModelAnimation;
  /** Particle emitters the source MODEL declared for itself (an imported GLB's glTF `extras`, docs/032),
   *  as native `type2Sub0` payloads with their spawn point already in model-local raw cm. Placing such a
   *  model auto-attaches them; extracted levels never set this, because they have graphs of their own. */
  emitters?: { fields: Record<string, number> }[];
}

/** One placement of a model in the level: a raw-space transform + which model it draws. */
export interface PropInstance {
  /** Original zero-based Instances.json index; stable across the effects/props reference join. */
  sourceIndex: number;
  /** Native LTG spatial-list membership: -1 unlisted, 0 common InstanceIndex, 1 RaceInstanceIndex,
   *  2 GemIndex (the retail Showoff-only object layer). */
  ltgState: number;
  /** ModelID → PropModel.id. */
  model: number;
  /** Raw-space Location (cm). */
  loc: V3;
  /** Raw-space Rotation quaternion (x, y, z, w). */
  rot: [number, number, number, number];
  /** Per-axis Scale. */
  scale: V3;
  /** InstanceName (kept for later picking / the prop library). */
  name: string;
  /** Native Instances.json visibility. Hidden placements are retained for Effects-mode wireframe picking. */
  visible: boolean;
  /** Exact native contact gate, preserved separately from the derived contact preview class. */
  playerCollision: boolean;
  /** Exact native bounce gate, preserved separately from PlayerBounceAmmount. */
  playerBounce: boolean;
  /** ADL collision-sound event id (`Sounds.CollisonSound`), -1 when the instance ships none — the sound
   *  played on a prop hit, resolved through core/effects/collision-sound.ts [Trailmap: 420-audio-runtime]. */
  collisionSound: number;
  /** How the rider meets this instance [Trailmap: 130-collision-data]: `solid` for nonzero response mass with
   *  PlayerBounce enabled, `through` for contact-only response, or `ghost` when no native contact exists. */
  contact: 'ghost' | 'through' | 'movable' | 'solid';
  /** Kickback on a solid hit [Trailmap: 130-collision-data]: -1 = n/a (ghost/through), else
   *  PlayerBounceAmmount (retail 0.03 soft – 0.6 springy, 0.5 common). */
  bounce: number;
  /** Rideable SurfaceType (ride feel + board-audio family, [Trailmap: 120-objects]); -1 = none (obstacle). */
  surface: number;
  /** Collision shape (`NATIVE_COLLISION_MODE`; serialized as the native `CollsionMode` value). */
  shape: number;
  /** Collision response mass (`U0` on disc): exact zero pass-through; nonzero admits mode-specific response. */
  responseMass: number;
  /** Dynamic scalar mass from a collision property.roller payload; -1 when no Roller activates the body. */
  dynamicMass: number;
  /** Rigid-body record in the level's physics pool (PhysicsIndex, -1 none): the sphere-tree body the sim
   *  shoves when a movable prop is hit — the piece custom props lack [Trailmap: 130-collision-data]. */
  physicsBody: number;
  /** Native mode-1 collision OBJ ids (`CollsionModelPaths`). These are intentionally independent of the
   * visible model: retail keeps invisible collision twins and simplified contact hulls as first-class data. */
  collisionModels?: string[];
  /** Native ADL listener-region records (`Sounds.ExternalSounds`), with their type-specific payload intact. */
  externalSounds: ExternalSoundEmitter[];
  /** Native per-instance PS2 lighting. Retail placements carry this already; authored placements omit it
   * because their preview/export lighting is derived live from the authored sun and terrain bake. */
  lighting?: {
    ambient: V3;
    keys: { color: V3; direction: V3 }[];
  };
}

export interface PropMaterial {
  /** Frame-zero texture in the level's Textures/ folder. */
  tex: string | null;
  /** Native TextureFlipbook frames, empty for an ordinary material. */
  frames: string[];
  /** The appearance word's alpha-pass flag (UnknownInt18 bit 18, [Trailmap: 220]). Pixel classification
   * separates alpha-test cutouts from translucent/glow draws. */
  blend?: boolean;
  /** The native flag word is a neutral placeholder (authored/imported props), so PNG pixels decide alpha. */
  pixelAlpha?: boolean;
  /** Explicit authoring/sidecar verdict. Wins over native flags and pixel heuristics. */
  alphaMode?: PropAlphaMode;
  /** The appearance word's opaque draw-priority flag (bit 17): the coplanar-decal z-fight tiebreaker.
   *  Slopesmith does not reorder it, but uses its mask pixels to select cutout state ([Trailmap: 170-materials]). */
  prio?: boolean;
  /** Material motion the SOURCE MODEL declared for itself, rather than motion an effect graph attached to
   *  a placement. Only imported GLBs set it, from their own glTF `extras` (docs/032). */
  scroll?: UvScrollEffect;
}

export interface LevelProps {
  level: string;
  models: PropModel[];
  instances: PropInstance[];
  /** MaterialID → frame-zero texture plus any native flipbook frames. */
  materials: Map<number, PropMaterial>;
  /** Shared CROWD.SSH frames extracted as cd00.png … cd15.png. */
  crowdFrames: string[];
  /** Collision-model id → model-local raw-cm triangle proxy used by `triangleProxy`. */
  collisionMeshes?: Map<string, { positions: Float32Array; indices: Uint32Array }>;
  /** PhysicsIndex → packed model-local raw-cm leaf spheres (x, y, z, radius) used by `physicsBodySpheres`. */
  physicsBodies?: Map<number, Float32Array>;
  /** PhysicsIndex → the body-level box/capsule candidates used by the Unity bundle exporter. */
  unityBodyRecipes?: Map<number, UnityBodyRecipe>;
  /** PhysicsIndex → the same body's rigid-body mass properties, when it authored a usable tensor. */
  physicsMassProps?: Map<number, PhysicsBodyMassProps>;
}

/**
 * A mode-3 body's rigid-body mass properties [Trailmap: 130-collision-data]. The level authors the centre of
 * mass and the inertia tensor with its inverse, but no scalar mass: a Roller effect supplies that separately and
 * its constructor writes the body's runtime inverse mass. The
 * inverse inertia is the term the retail shove solver consumes directly [Trailmap: 370-world-interaction] — it
 * is what decides how a struck body divides an impulse between spin and travel.
 */
export interface PhysicsBodyMassProps {
  /** Centre of mass, model-local raw cm. */
  com: [number, number, number];
  /** Row-major inverse inertia tensor, 1/(mass·cm²). */
  invInertia: Float32Array;
}

/** The compact JSON the server sends: geometry as base64 Float32/Uint32 to keep the payload small + fast. */
export interface PropsPayload {
  level: string;
  /** Snowknife's map-local, user-generated audio resolver sidecar. */
  soundIndex?: CollisionSoundIndex;
  models: { id: number; name: string; subs: { mat: number; pos: string; uv: string; nor?: string; idx: string;
    piece?: number; piecePivot?: number[]; object?: number }[];
    rotation?: PropModelRotation; animation?: PropModelAnimation;
    /** Emitters the SOURCE MODEL declared (an imported GLB's glTF `extras`, docs/032). */
    emitters?: { fields: Record<string, number> }[] }[];
  /** `scroll` is material motion the SOURCE MODEL declared for itself — an imported GLB reading its own
   *  glTF `extras`. Extracted levels leave it unset and get their motion from the level's effect graphs
   *  instead; this exists because an imported prop has no graph to be attached to. */
  materials: { id: number; tex: string | null; frames?: string[]; blend?: boolean; pixelAlpha?: boolean;
    alphaMode?: PropAlphaMode; prio?: boolean;
    scroll?: UvScrollEffect }[];
  crowdFrames?: string[];
  /** Native mode-1 collision proxies, packed independently from visible prop models. */
  collisionMeshes?: { id: string; pos: string; idx: string }[];
  /** Native mode-3 sphere-tree leaves, packed x/y/z/r as Float32 values, plus the body's mass properties:
   *  `com` the model-local raw-cm centre of mass and `ii` the row-major inverse inertia tensor as 9 Float32s.
   *  Both are omitted for a body that authored no usable tensor. */
  physicsBodies?: { id: number; sph: string; com?: number[]; ii?: string;
    /** Unity body recipe: doorway/sparse selector, body bounds, body shape, and compact-tilt shape. */
    up?: { d: boolean; bb: number[]; b?: number[]; c?: number[]; tb?: number[]; tc?: number[] } }[];
  instances: { i: number; m: number; p: number[]; q: number[]; s: number[]; n: string; v?: boolean;
    /** Native LTG list state; omitted for the common state 0. */ ls?: number;
    /** Native ambient RGB plus three flattened key RGB / direction vectors. */
    la?: number[]; lk?: number[]; lv?: number[];
    /** exact PlayerCollision / PlayerBounce gates */ pc?: boolean; pb?: boolean;
    /** collision-sound event id; omitted when the instance ships no sound record */ hs?: number;
    /** contact class: 0 ghost, 1 ride-through touch, 2 solid; 3 is accepted from older cached payloads */ c?: number;
    /** bounce kickback: 0 for contact-only, else PlayerBounceAmmount */ bn?: number;
    /** rideable SurfaceType; omitted when -1 (obstacle handling) */ st?: number;
    /** collision shape (`NATIVE_COLLISION_MODE`); omitted when none */ cm?: number;
    /** configured collision response mass; retained even while PlayerCollision gates the shape off */ rm?: number;
    /** Roller payload scalar mass; omitted when no collision Roller activates this instance */ dm?: number;
    /** physics-pool rigid-body record; omitted when the instance has none (PhysicsIndex -1) */ px?: number;
    /** native mode-1 Collision/*.obj ids; omitted when the instance carries no collision proxy */ cp?: string[];
    /** ExternalSounds: type, event, world-axis offset, and type-specific U5+ tail. */
    xs?: { t: number; s: number; o: number[]; p: number[] }[] }[];
  error?: string;
}

/** base64 → bytes (browser atob). The server writes typed-array buffers, so the length is 4-aligned. */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * What a MODEL declares for itself rather than getting from a level's effect graphs (docs/032): scrolling
 * materials and particle emitters carried in an imported GLB's own glTF `extras`.
 *
 * Only imported models ever report anything here — an extracted level's props get their motion from the
 * graphs that shipped with it, so there is nothing self-declared to find. The prop library badges the
 * difference, because "this prop arrives already animated" is not otherwise visible until it is placed.
 */
export function modelDeclaredEffects(props: LevelProps, model: PropModel): {
  scroll: number; emitters: number; any: boolean;
} {
  let scroll = 0;
  for (const sub of model.subs) if (props.materials.get(sub.mat)?.scroll) scroll++;
  const emitters = model.emitters?.length ?? 0;
  return { scroll, emitters, any: scroll > 0 || emitters > 0 };
}

/** One material a model actually draws with, and how much of the model wears it. */
export interface PropModelMaterialUse {
  /** The model's own material id — what a submesh's `mat` names and what an edit addresses. */
  mat: number;
  material: PropMaterial | null;
  /** Submeshes drawn with it. A prop wearing one page on its body and another on a moving part is the
   *  reason material is the unit here: the two are separately assignable and separately animated. */
  subs: number;
  triangles: number;
}

/**
 * Which materials one model draws with, in material-id order.
 *
 * The join is model → submesh → material rather than anything per PLACEMENT, and that is the whole point:
 * a material belongs to the model, so editing one changes every placement of it at once. That matches the
 * native table — `Materials.json` is a level-wide array a model's meshes index into — and it is why the prop
 * panel presents this as a property of the model the placement borrows rather than of the placement.
 */
export function propModelMaterials(props: LevelProps, model: PropModel): PropModelMaterialUse[] {
  const used = new Map<number, PropModelMaterialUse>();
  for (const sub of model.subs) {
    let entry = used.get(sub.mat);
    if (!entry) used.set(sub.mat, entry = {
      mat: sub.mat, material: props.materials.get(sub.mat) ?? null, subs: 0, triangles: 0,
    });
    entry.subs++;
    entry.triangles += sub.indices.length / 3;
  }
  return [...used.values()].sort((a, b) => a.mat - b.mat);
}

/** Decode the server payload into typed-array models + instances the viewport can instance directly. */
export function decodeProps(payload: PropsPayload): LevelProps {
  registerCollisionSoundIndex(payload.soundIndex);
  const models: PropModel[] = payload.models.map(m => ({
    id: m.id,
    name: m.name,
    ...(m.rotation ? { rotation: m.rotation } : {}),
    ...(m.animation ? { animation: m.animation } : {}),
    ...(m.emitters?.length ? { emitters: m.emitters } : {}),
    subs: m.subs.map(s => {
      const pb = b64ToBytes(s.pos);
      const ub = b64ToBytes(s.uv);
      const nb = s.nor ? b64ToBytes(s.nor) : null;
      const ib = b64ToBytes(s.idx);
      return {
        mat: s.mat,
        positions: new Float32Array(pb.buffer, 0, pb.byteLength / 4),
        uvs: new Float32Array(ub.buffer, 0, ub.byteLength / 4),
        ...(nb ? { normals: new Float32Array(nb.buffer, 0, nb.byteLength / 4) } : {}),
        indices: new Uint32Array(ib.buffer, 0, ib.byteLength / 4),
        ...(Number.isInteger(s.piece) ? { piece: s.piece } : {}),
        ...(s.piecePivot?.length === 3
          ? { piecePivot: [s.piecePivot[0], s.piecePivot[1], s.piecePivot[2]] as V3 } : {}),
        ...(Number.isInteger(s.object) ? { object: s.object } : {}),
      };
    }),
  }));
  const instances: PropInstance[] = payload.instances.map(i => ({
    sourceIndex: i.i,
    ltgState: typeof i.ls === 'number' && Number.isInteger(i.ls) ? i.ls : 0,
    model: i.m,
    loc: [i.p[0], i.p[1], i.p[2]],
    rot: [i.q[0], i.q[1], i.q[2], i.q[3]],
    scale: [i.s[0], i.s[1], i.s[2]],
    name: i.n,
    visible: i.v !== false,
    playerCollision: i.pc !== false,
    playerBounce: i.pb !== false,
    collisionSound: typeof i.hs === 'number' ? i.hs : -1,
    contact: i.c === 2 ? 'solid' : i.c === 3 ? 'movable' : i.c === 0 ? 'ghost' : 'through',
    bounce: typeof i.bn === 'number' ? i.bn : -1,
    surface: typeof i.st === 'number' ? i.st : -1,
    shape: typeof i.cm === 'number' ? i.cm : 0,
    responseMass: typeof i.rm === 'number' ? i.rm : -1,
    dynamicMass: typeof i.dm === 'number' ? i.dm : -1,
    physicsBody: typeof i.px === 'number' ? i.px : -1,
    ...(i.cp?.length ? { collisionModels: i.cp } : {}),
    externalSounds: (i.xs ?? []).map(x => ({
      type: x.t,
      sound: x.s,
      offset: [x.o[0] ?? 0, x.o[1] ?? 0, x.o[2] ?? 0],
      params: x.p.filter(Number.isFinite),
    })),
    ...(i.la?.length === 3 ? {
      lighting: {
        ambient: [i.la[0], i.la[1], i.la[2]] as V3,
        keys: [0, 1, 2].flatMap(index => {
          const color = i.lk?.slice(index * 3, index * 3 + 3);
          const direction = i.lv?.slice(index * 3, index * 3 + 3);
          return color?.length === 3 && direction?.length === 3
            ? [{ color: [color[0], color[1], color[2]] as V3,
              direction: [direction[0], direction[1], direction[2]] as V3 }]
            : [];
        }),
      },
    } : {}),
  }));
  const materials = new Map<number, PropMaterial>(payload.materials.map(x => {
    const alphaMode = propAlphaMode(x.alphaMode);
    return [x.id, {
      tex: x.tex,
      frames: x.frames ?? [],
      ...(x.blend ? { blend: true } : {}),
      ...(x.pixelAlpha ? { pixelAlpha: true } : {}),
      ...(alphaMode ? { alphaMode } : {}),
      ...(x.prio ? { prio: true } : {}),
      ...(x.scroll ? { scroll: x.scroll } : {}),
    }];
  }));
  const collisionMeshes = new Map((payload.collisionMeshes ?? []).map(mesh => {
    const pb = b64ToBytes(mesh.pos);
    const ib = b64ToBytes(mesh.idx);
    return [mesh.id, {
      positions: new Float32Array(pb.buffer, 0, pb.byteLength / 4),
      indices: new Uint32Array(ib.buffer, 0, ib.byteLength / 4),
    }];
  }));
  const physicsBodies = new Map((payload.physicsBodies ?? []).map(body => {
    const sb = b64ToBytes(body.sph);
    return [body.id, new Float32Array(sb.buffer, 0, sb.byteLength / 4)];
  }));
  const decodeBodyShape = (boxes: number[] | undefined, capsules: number[] | undefined): BodyShape => ({
    boxes: Array.from({ length: Math.floor((boxes?.length ?? 0) / 6) }, (_, index) => ({
      center: boxes!.slice(index * 6, index * 6 + 3) as [number, number, number],
      size: boxes!.slice(index * 6 + 3, index * 6 + 6) as [number, number, number],
    })),
    capsules: Array.from({ length: Math.floor((capsules?.length ?? 0) / 7) }, (_, index) => ({
      a: capsules!.slice(index * 7, index * 7 + 3) as [number, number, number],
      b: capsules!.slice(index * 7 + 3, index * 7 + 6) as [number, number, number],
      radius: capsules![index * 7 + 6],
    })),
  });
  const unityBodyRecipes = new Map((payload.physicsBodies ?? []).flatMap(body => {
    const recipe = body.up;
    if (!recipe || recipe.bb.length < 6) return [];
    return [[body.id, {
      doorwayOrSparse: recipe.d,
      bounds: { center: recipe.bb.slice(0, 3) as [number, number, number],
        size: recipe.bb.slice(3, 6) as [number, number, number] },
      body: decodeBodyShape(recipe.b, recipe.c),
      tilt: decodeBodyShape(recipe.tb, recipe.tc),
    } satisfies UnityBodyRecipe] as const];
  }));
  const physicsMassProps = new Map((payload.physicsBodies ?? []).flatMap(body => {
    if (!body.ii || !body.com || body.com.length < 3) return [];
    const ib = b64ToBytes(body.ii);
    const invInertia = new Float32Array(ib.buffer, 0, ib.byteLength / 4);
    if (invInertia.length < 9) return [];
    return [[body.id, {
      com: [body.com[0], body.com[1], body.com[2]] as [number, number, number], invInertia,
    }] as const];
  }));
  return {
    level: payload.level, models, instances, materials, crowdFrames: payload.crowdFrames ?? [],
    collisionMeshes, physicsBodies, unityBodyRecipes, physicsMassProps,
  };
}

/** Sample one recovered model-local rotation curve at an absolute native clip frame. */
export function samplePropModelRotation(rotation: PropModelRotation, frame: number): number {
  if (!rotation.segments?.length) return 0;
  const seconds = frame / 30;
  const segment = rotation.segments.find(s => seconds >= s[4] && seconds <= s[5])
    ?? (seconds < rotation.segments[0][4] ? rotation.segments[0] : rotation.segments[rotation.segments.length - 1]);
  const t = Math.min(segment[5], Math.max(segment[4], seconds));
  return ((segment[0] * t + segment[1]) * t + segment[2]) * t + segment[3];
}

/** Sample the optional raw model-local translation channels at one absolute native clip frame. */
export function samplePropModelTranslation(rotation: PropModelRotation, frame: number): V3 {
  const seconds = frame / 30;
  const sample = (segments: PropModelCurve | null): number => {
    if (!segments?.length) return 0;
    const segment = segments.find(s => seconds >= s[4] && seconds <= s[5])
      ?? (seconds < segments[0][4] ? segments[0] : segments[segments.length - 1]);
    const t = Math.min(segment[5], Math.max(segment[4], seconds));
    return ((segment[0] * t + segment[1]) * t + segment[2]) * t + segment[3];
  };
  return [sample(rotation.translation?.[0] ?? null), sample(rotation.translation?.[1] ?? null),
    sample(rotation.translation?.[2] ?? null)];
}

/** Sorted, de-duplicated segment boundaries expressed on the model clip's native 30 fps frame axis. */
export function propModelCurveBoundaryFrames(curve: PropModelCurve, clipFrames: number): number[] {
  const end = Math.max(0, clipFrames);
  const frames = curve.flatMap(segment => [segment[4] * 30, segment[5] * 30])
    .filter(Number.isFinite)
    .map(frame => Math.min(end, Math.max(0, frame)))
    .sort((a, b) => a - b);
  return frames.filter((frame, index) => index === 0 || Math.abs(frame - frames[index - 1]) > 1e-6);
}

/** The animated channels available to a reference clip, in the same order the timeline presents them. */
export function propModelAnimationChannels(rotation: PropModelClip): PropModelAnimationChannel[] {
  const channels: PropModelAnimationChannel[] = [];
  if (isPropModelAnimation(rotation)) {
    const components = ['translate-x', 'translate-y', 'translate-z', 'rotate-x', 'rotate-y', 'rotate-z'] as const;
    const axes = ['X', 'Y', 'Z'] as const;
    for (const [object, modelObject] of rotation.objects.entries()) {
      for (let component = 0; component < 6; component++) {
        const curve = modelObject.channels?.[component];
        if (!curve?.length) continue;
        const kind = component < 3 ? 'translate' as const : 'rotate' as const;
        const axis = (component % 3) as 0 | 1 | 2;
        channels.push({
          id: `object-${object}-${components[component]}`,
          label: `Object ${object} · ${kind === 'translate' ? 'Position' : 'Rotation'} ${axes[axis]}`,
          unit: kind === 'translate' ? 'cm' : 'deg', kind, axis, object,
          segments: curve.length,
          boundaryFrames: propModelCurveBoundaryFrames(curve, rotation.clipFrames),
        });
      }
    }
    return channels;
  }
  const translation = rotation.translation ?? [null, null, null];
  const axes = ['X', 'Y', 'Z'] as const;
  for (let axis = 0; axis < 3; axis++) {
    const curve = translation[axis];
    if (!curve?.length) continue;
    channels.push({
      id: `translate-${axes[axis].toLowerCase()}` as PropModelAnimationChannelId,
      label: `Position ${axes[axis]}`,
      unit: 'cm',
      kind: 'translate',
      axis: axis as 0 | 1 | 2,
      segments: curve.length,
      boundaryFrames: propModelCurveBoundaryFrames(curve, rotation.clipFrames),
    });
  }
  if (rotation.axis !== undefined && rotation.segments?.length) {
    channels.push({
      id: `rotate-${axes[rotation.axis].toLowerCase()}` as PropModelAnimationChannelId,
      label: `Rotation ${axes[rotation.axis]}`,
      unit: 'deg',
      kind: 'rotate',
      axis: rotation.axis,
      segments: rotation.segments.length,
      boundaryFrames: propModelCurveBoundaryFrames(rotation.segments, rotation.clipFrames),
    });
  }
  return channels;
}

/** Sample one timeline channel without making the UI understand the compact curve storage layout. */
export function samplePropModelAnimationChannel(rotation: PropModelClip,
  channel: PropModelAnimationChannelId, frame: number): number {
  if (isPropModelAnimation(rotation)) {
    const match = /^object-(\d+)-(translate|rotate)-([xyz])$/.exec(channel);
    if (!match) return 0;
    const object = rotation.objects[Number(match[1])];
    const axis = match[3] === 'x' ? 0 : match[3] === 'y' ? 1 : 2;
    const component = (match[2] === 'translate' ? 0 : 3) + axis;
    return samplePropModelCurve(object?.channels?.[component] ?? null, frame);
  }
  if (channel.startsWith('translate-')) {
    const axis = channel.endsWith('x') ? 0 : channel.endsWith('y') ? 1 : 2;
    return samplePropModelTranslation(rotation, frame)[axis];
  }
  return samplePropModelRotation(rotation, frame);
}

/** Sample one recovered model curve at an absolute native clip frame. */
export function samplePropModelCurve(curve: PropModelCurve | null | undefined, frame: number): number {
  if (!curve?.length) return 0;
  const seconds = frame / 30;
  const segment = curve.find(s => seconds >= s[4] && seconds <= s[5])
    ?? (seconds < curve[0][4] ? curve[0] : curve[curve.length - 1]);
  const t = Math.min(segment[5], Math.max(segment[4], seconds));
  return ((segment[0] * t + segment[1]) * t + segment[2]) * t + segment[3];
}
