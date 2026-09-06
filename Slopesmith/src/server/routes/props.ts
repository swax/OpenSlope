import {
  listDir, listEntries, mapLimit, pathExists, readJsonOr, readTextOrNull, READ_CONCURRENCY,
} from '../fs-async';
import { basename, join } from 'node:path';
import * as THREE from 'three';
import { mapsRoot, workspaceConfig } from '../workspace-config';
import { runInWorker } from '../worker-pool';
import type { EffectFunction, EffectGraph, EffectNode, EffectsDocument } from '../../core/effects/document';
import {
  combinePropAlphaModes, propAlphaMode,
  type PropAlphaMode, type PropModelAnimation, type PropModelCurve, type PropModelRotation, type PropsPayload,
} from '../../core/reference/props';
import { NATIVE_COLLISION_MODE, nativeContactState, type NativeCollisionMode } from '../../core/collision/native';
import type { V3 } from '../../core/doc/types';
import type { CollisionSoundIndex } from '../../core/effects/collision-sound';
import { CUSTOM_TEX_LEVEL } from '../../core/paint/textures';
import type { LocalBox } from '../../core/lighting/sign-lights';
import { buildMaterialCombiner, type MaterialCombiner, type SourceMaterial } from '../../core/export/materials';
import { modelGeometryBox } from '../../core/export/props';
import type { NativeArt } from '../../core/export/provider';
import { safeDataName } from './safe-name';
import {
  buildUnityBodyRecipe, decodePhysicsBodyTree, type DecodedPhysicsBody, type PhysicsTreeLevel,
  type UnityBodyRecipe,
} from '../../core/collision/unity-body';
import {
  readPersistentPropsJson, type PersistentPropsJson, type PersistentPropsPayload,
} from '../props-payload-cache';

/**
 * Serve an extracted level's PROPS to the editor's reference layer: the placed static objects (trees,
 * boulders, banners, scaffolding, …). Reads Maps/<level>/Models.json (the model table),
 * Instances.json (where each model is placed), Meshes/*.obj (per-mesh geometry) and Materials.json (each
 * mesh's texture) straight off disk — the same folder `snowknife import` writes. Each model's meshes are
 * grouped by material into UV'd submeshes and sent as base64 typed arrays; the placements are sent as
 * raw-space transforms. The client (core/refprops + viewport) maps them through the same raw→editor
 * transform as the terrain, so they co-register, and textures them from the same Textures/ the paint palette
 * reads (via /api/texture).
 */

/** Level folders that carry reusable extracted prop tables. Authored exports are intentionally absent from
 * this catalogue: their Props.obj is a world-space reference visual, not a model library or rail/gem donor. */
export async function levelsWithProps(): Promise<string[]> {
  const dirs = (await listEntries(mapsRoot())).filter(entry => entry.isDirectory).map(entry => entry.name);
  const usable = await mapLimit(dirs, READ_CONCURRENCY, async name => {
    const dir = join(mapsRoot(), name);
    const present = await Promise.all(['Models.json', 'Instances.json', 'Meshes']
      .map(part => pathExists(join(dir, part))));
    return present.every(Boolean);
  });
  return dirs.filter((_name, index) => usable[index]).sort();
}

/** A parsed OBJ mesh: separate vertex / UV / normal pools and each triangle's indexed corners. */
interface RawMesh {
  /** Vertex positions (cm, model-local), xyz-interleaved. */
  v: number[];
  /** Texture coords (u, v), interleaved — raw OBJ vt (bottom-left origin), tiling values allowed. */
  vt: number[];
  /** Model-local vertex normals, xyz-interleaved. These are the normals the PS2 instance-light record shades. */
  vn: number[];
  /** Triangle corners flat as [vIdx0, tIdx0, nIdx0, …]; absent texture/normal indices are -1. */
  corners: number[];
}

/**
 * Parse an OBJ mesh into its vertex / UV / normal pools and triangle corners. Faces are `a/b/c` triples,
 * already triangulated in these exports, but
 * any polygon is fan-triangulated defensively. OBJ indices are 1-based; negatives are relative to the running
 * count. A face token is `v`, `v/vt`, `v//vn` or `v/vt/vn` — the vt slot may be absent (then tIdx = -1).
 */
function parseObj(text: string): RawMesh {
  const v: number[] = [];
  const vt: number[] = [];
  const vn: number[] = [];
  const corners: number[] = [];
  let vCount = 0;
  let vtCount = 0;
  let vnCount = 0;
  for (const line of text.split('\n')) {
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */) {
      const c1 = line.charCodeAt(1);
      if (c1 === 32 /* space */) {
        const p = line.split(/\s+/);
        v.push(+p[1], +p[2], +p[3]);
        vCount++;
      } else if (c1 === 116 /* t */) {
        const p = line.split(/\s+/);
        vt.push(+p[1], +p[2]);
        vtCount++;
      } else if (c1 === 110 /* n */) {
        const p = line.split(/\s+/);
        vn.push(+p[1], +p[2], +p[3]);
        vnCount++;
      }
    } else if (c0 === 102 /* f */ && line.charCodeAt(1) === 32 /* space */) {
      const t = line.split(/\s+/);
      const fv: number[] = [];
      const ft: number[] = [];
      const fn: number[] = [];
      for (let i = 1; i < t.length; i++) {
        if (!t[i]) continue; // trailing empty from a \r or double space
        const tok = t[i];
        const slash = tok.indexOf('/');
        const vi = parseInt(slash < 0 ? tok : tok.slice(0, slash), 10);
        if (Number.isNaN(vi)) continue;
        let ti = -1;
        let ni = -1;
        if (slash >= 0) {
          const rest = tok.slice(slash + 1); // "vt" or "vt/vn" or "/vn"
          const slash2 = rest.indexOf('/');
          const tiTok = slash2 < 0 ? rest : rest.slice(0, slash2);
          if (tiTok) { const tt = parseInt(tiTok, 10); if (!Number.isNaN(tt)) ti = tt < 0 ? vtCount + tt : tt - 1; }
          if (slash2 >= 0) {
            const niTok = rest.slice(slash2 + 1);
            if (niTok) { const nn = parseInt(niTok, 10); if (!Number.isNaN(nn)) ni = nn < 0 ? vnCount + nn : nn - 1; }
          }
        }
        fv.push(vi < 0 ? vCount + vi : vi - 1); // 1-based → 0-based; negatives are relative
        ft.push(ti);
        fn.push(ni);
      }
      for (let i = 2; i < fv.length; i++) // fan-triangulate
        corners.push(fv[0], ft[0], fn[0], fv[i - 1], ft[i - 1], fn[i - 1], fv[i], ft[i], fn[i]);
    }
  }
  return { v, vt, vn, corners };
}

/** One material group of a model: its OBJ MaterialID + indexed geometry with UVs (model-local cm). */
export interface ModelSub {
  /** MaterialID (index into the level's Materials[]); -1 when the mesh has no material. */
  mat: number;
  positions: number[];
  uvs: number[];
  /** Complete native normal stream when every contributing OBJ corner supplied one. */
  normals?: number[];
  indices: number[];
  piece?: number;
  piecePivot?: V3;
  object?: number;
}
/** One merged model: its name + per-material submeshes and an optional simple rotation clip. */
export interface ModelGeom { name: string; subs: ModelSub[]; rotation?: PropModelRotation; animation?: PropModelAnimation }

/** Weld a mesh's (vIdx, tIdx, nIdx) corners into `sub`, baking its model-object rest transform before several objects
 *  sharing a material are merged. This is load-bearing for multi-object models such as the LCD's broken shards. */
function addMeshToSub(sub: ModelSub, mesh: RawMesh, transform: THREE.Matrix4) {
  const map = new Map<string, number>(); // "vIdx/tIdx/nIdx" → new vertex index within the submesh
  const c = mesh.corners;
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(transform);
  const meshHasNormals = c.length > 0 && c.every((value, index) => index % 3 !== 2 || value >= 0);
  const hadVertices = sub.positions.length > 0;
  if (!hadVertices) sub.normals = meshHasNormals ? [] : undefined;
  else if (!meshHasNormals) sub.normals = undefined;
  for (let k = 0; k < c.length; k += 3) {
    const vi = c[k], ti = c[k + 1], ni = c[k + 2];
    const key = `${vi}/${ti}/${ni}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = sub.positions.length / 3;
      point.fromArray(mesh.v, vi * 3).applyMatrix4(transform);
      sub.positions.push(point.x, point.y, point.z);
      sub.uvs.push(ti >= 0 ? mesh.vt[ti * 2] : 0, ti >= 0 ? mesh.vt[ti * 2 + 1] : 0);
      if (sub.normals) {
        normal.fromArray(mesh.vn, ni * 3).applyMatrix3(normalMatrix).normalize();
        sub.normals.push(normal.x, normal.y, normal.z);
      }
      map.set(key, idx);
    }
    sub.indices.push(idx);
  }
}

interface ModelAnimationMath {
  Value1: number; Value2: number; Value3: number; Value4: number; Value5: number; Value6: number;
}
interface ModelAnimation {
  U1?: number; U2?: number; U3?: number; U4?: number; U5?: number; U6?: number;
  AnimationAction: number;
  AnimationEntries: ({ AnimationMaths: ModelAnimationMath[] | null } | null)[] | null;
}
interface ModelsJsonModelObject {
  ParentID?: number;
  Position?: number[] | null;
  Rotation?: number[] | null;
  Scale?: number[] | null;
  MeshData: ({ MeshPath: string; MaterialID?: number } | null)[] | null;
  Animation?: ModelAnimation | null;
}
interface ModelsJsonModel { ModelName: string; AnimTime?: number; ModelObjects: (ModelsJsonModelObject | null)[] | null }
interface ModelsJson { Models: ModelsJsonModel[] }
interface RawExternalSound {
  U0?: number;
  SoundIndex?: number;
  U2?: number; U3?: number; U4?: number;
  U5?: number; U6?: number; U7?: number; U8?: number; U9?: number; U10?: number; U11?: number;
}
interface InstancesJson {
  Instances: {
    InstanceName: string;
    Location: number[];
    Rotation: number[];
    Scale: number[];
    ModelID: number;
    /** Native spatial-list membership: -1 unlisted, 0 common, 1 RaceInstanceIndex, 2 GemIndex. */
    LTGState?: number;
    LightVector1?: number[];
    LightVector2?: number[];
    LightVector3?: number[];
    LightColour1?: number[];
    LightColour2?: number[];
    LightColour3?: number[];
    AmbentLightColour?: number[];
    EffectSlotIndex?: number;
    Visable?: boolean;
    IncludeSound?: boolean;
    /** Variable-sized ADL listener-region records. Type 0/1/2/3 carry U2..U6/U11/U11/U5 respectively. */
    Sounds?: { CollisonSound?: number; ExternalSounds?: (RawExternalSound | null)[] | null } | null;
    PlayerCollision?: boolean;
    /** Rider-response mass [Trailmap: 130-collision-data]: exact 0 suppresses solid response; every nonzero
     *  value takes the common response branch. Dynamic movement is activated separately by property.roller. */
    U0?: number;
    /** Kickback gate + magnitude [Trailmap: 130-collision-data]: flag off suppresses the physical rider
     *  response while contact effects remain eligible. */
    PlayerBounce?: boolean;
    PlayerBounceAmmount?: number;
    /** Rideable surface type ([Trailmap: 120-objects]); -1 = none (object handling — obstacle, not surface). */
    SurfaceType?: number;
    /** Collision SHAPE selector: 1 = triangle proxy mesh, 2 = bounding box, 3 = physics-body spheres. */
    CollsionMode?: number;
    /** Dedicated mode-1 collision proxy files under Collision/. The misspelling is native to the format. */
    CollsionModelPaths?: string[] | null;
    /** Rigid-body record in the level's physics pool (-1 none): the sphere-tree body the sim shoves when a
     *  MOVABLE prop is hit — the piece custom props lack [Trailmap: 130-collision-data]. */
    PhysicsIndex?: number;
  }[];
}
/** A level material record — only the fields props need: textures and the alpha-blend flag word. */
type SsxMaterial = SourceMaterial;

interface EffectPiecePlacement { model: number; effectSlotIndex: number }

/** The native extraction stores effect graphs and prop physics in one document. Keep one parsed copy in the
 * scope of a prop build so the 9-10 MB files used by large retail levels are not reparsed for every body. */
async function readEffectsDocument(levelDir: string): Promise<EffectsDocument | null> {
  const document = await readJsonOr<EffectsDocument | null>(join(levelDir, 'Effects.json'), null);
  return document && Array.isArray(document.slots) && Array.isArray(document.graphs)
    && Array.isArray(document.functions) ? document : null;
}

/** Models whose geometry must remain partitioned for a decoded Sub20 mesh throw. Most reference props are
 * intentionally merged by material, but that would weld a mailbox's 21 loose letters into one immovable clump.
 * Resolve both ordinary slot-owned graphs and MainType-7 cross-instance calls; nested functions keep the same
 * receiver, so they participate in the graph's mesh-throw classification too. */
export function meshThrowModelIds(document: EffectsDocument,
  instances: readonly EffectPiecePlacement[]): Set<number> {
  const functions = new Map(document.functions.map(fn => [fn.id, fn]));
  const graphs = new Map(document.graphs.map(graph => [graph.id, graph]));
  const memo = new Map<string, boolean>();
  const active = new Set<string>();
  const ownerHasMeshThrow = (kind: 'graph' | 'function', owner: EffectGraph | EffectFunction): boolean => {
    const key = `${kind}:${owner.id}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    if (active.has(key)) return false;
    active.add(key);
    const found = owner.nodes.some(node => {
      if (node.semanticType === 'property.mesh-animation') return true;
      const called = node.references?.function ? functions.get(node.references.function) : null;
      return !!called && ownerHasMeshThrow('function', called);
    });
    active.delete(key);
    memo.set(key, found);
    return found;
  };
  const graphHasMeshThrow = (id: string | null | undefined) => {
    const graph = id ? graphs.get(id) : null;
    return !!graph && ownerHasMeshThrow('graph', graph);
  };
  const out = new Set<number>();
  const slots = new Map(document.slots.map((slot, index) => [slot.originalIndex ?? index, slot]));
  for (const instance of instances) {
    const slot = slots.get(instance.effectSlotIndex);
    if (slot && Object.values(slot.circumstances).some(graphHasMeshThrow) && instance.model >= 0)
      out.add(instance.model);
  }
  const instanceIndex = (reference: string | null | undefined): number | null => {
    const match = reference?.match(/^instance:(\d+)$/);
    return match ? Number(match[1]) : null;
  };
  const collectCallTarget = (node: EffectNode) => {
    if (!graphHasMeshThrow(node.references?.effectGraph)) return;
    const index = instanceIndex(node.references?.instance);
    const model = index === null ? -1 : instances[index]?.model ?? -1;
    if (model >= 0) out.add(model);
  };
  for (const graph of document.graphs) for (const node of graph.nodes) collectCallTarget(node);
  for (const fn of document.functions) for (const node of fn.nodes) collectCallTarget(node);
  return out;
}

function readMeshThrowModelIds(document: EffectsDocument | null,
  instances: InstancesJson['Instances']): Set<number> {
  if (!document) return new Set();
  try {
    return meshThrowModelIds(document, instances.map(instance => ({
      model: instance.ModelID,
      effectSlotIndex: Number.isInteger(instance.EffectSlotIndex) ? instance.EffectSlotIndex! : -1,
    })));
  } catch {
    // Props remain usable for an older extraction without a valid portable effects document.
    return new Set();
  }
}

/** Collision Roller targets and their effect-authored scalar masses, keyed by Instances.json index. */
export function rollerInstanceMasses(document: EffectsDocument,
  instances: readonly Pick<InstancesJson['Instances'][number], 'EffectSlotIndex'>[]): Map<number, number> {
  const out = new Map<number, number>();
  const graphs = new Map(document.graphs.map(graph => [graph.id, graph]));
  const slots = new Map(document.slots.map((slot, index) => [slot.originalIndex ?? index, slot]));
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const rollerMass = (node: EffectNode): number | null => {
    if (node.semanticType !== 'property.roller') return null;
    const type0 = record(node.payload.type0);
    const roller = record(type0?.type0Sub0);
    const mass = roller?.U0;
    return typeof mass === 'number' && Number.isFinite(mass) && mass > 0 ? mass : null;
  };
  const graphMass = (id: string | null | undefined): number | null => {
    const graph = id ? graphs.get(id) : null;
    if (!graph) return null;
    for (const node of graph.nodes) {
      const mass = rollerMass(node);
      if (mass !== null) return mass;
    }
    return null;
  };
  const instanceIndex = (id: string | null | undefined): number | null => {
    const match = id?.match(/^instance:(\d+)$/);
    return match ? Number(match[1]) : null;
  };
  for (let owner = 0; owner < instances.length; owner++) {
    const slotIndex = instances[owner].EffectSlotIndex;
    const slot = Number.isInteger(slotIndex) ? slots.get(slotIndex!) : null;
    const graph = slot?.circumstances.collision ? graphs.get(slot.circumstances.collision) : null;
    if (!graph) continue;
    const inline = graphMass(graph.id);
    if (inline !== null) out.set(owner, inline);
    for (const node of graph.nodes) {
      const target = instanceIndex(node.references?.instance);
      const mass = graphMass(node.references?.effectGraph);
      if (target !== null && target >= 0 && target < instances.length && mass !== null) out.set(target, mass);
    }
  }
  return out;
}

function readRollerInstanceMasses(document: EffectsDocument | null,
  instances: InstancesJson['Instances']): Map<number, number> {
  if (!document) return new Map();
  try { return rollerInstanceMasses(document, instances); }
  catch { return new Map(); }
}

/** Resolve each Models.json object's local rest pose through ParentID into model space. Per-object OBJ files are
 * object-local; omitting these matrices collapses every child pivot onto the model origin. */
export function modelObjectRestMatrices(model: ModelsJsonModel): THREE.Matrix4[] {
  const objects = model.ModelObjects ?? [];
  const local = objects.map(obj => {
    const p = obj?.Position;
    const r = obj?.Rotation;
    const s = obj?.Scale;
    const position = new THREE.Vector3(p?.[0] ?? 0, p?.[1] ?? 0, p?.[2] ?? 0);
    const rotation = new THREE.Quaternion(r?.[0] ?? 0, r?.[1] ?? 0, r?.[2] ?? 0, r?.[3] ?? 1);
    if (rotation.lengthSq() < 1e-12) rotation.identity(); else rotation.normalize();
    const scale = new THREE.Vector3(s?.[0] ?? 1, s?.[1] ?? 1, s?.[2] ?? 1);
    return new THREE.Matrix4().compose(position, rotation, scale);
  });
  const world: (THREE.Matrix4 | undefined)[] = new Array(objects.length);
  const visiting = new Set<number>();
  const resolve = (index: number): THREE.Matrix4 => {
    const cached = world[index];
    if (cached) return cached;
    const own = local[index] ?? new THREE.Matrix4();
    if (visiting.has(index)) return own;
    visiting.add(index);
    const parent = objects[index]?.ParentID ?? -1;
    const resolved = parent >= 0 && parent < objects.length && parent !== index
      ? resolve(parent).clone().multiply(own) : own.clone();
    visiting.delete(index);
    world[index] = resolved;
    return resolved;
  };
  return objects.map((_, index) => resolve(index));
}

/** Apply a per-page sidecar to the material table it qualifies. Exported for the fixture check that keeps
 * this contract independent of a developer's extracted Maps library. */
export function materialsWithAlphaOverrides(materials: readonly SsxMaterial[],
  raw: Readonly<Record<string, unknown>>): SsxMaterial[] {
  const overrides = new Map<string, PropAlphaMode>();
  for (const [file, value] of Object.entries(raw)) {
    const mode = propAlphaMode(typeof value === 'string' ? value.toLowerCase() : value);
    if (mode) overrides.set(basename(file).toLowerCase(), mode);
  }
  return materials.map(material => {
    const files = [material.TexturePath, ...(material.TextureFlipbook ?? [])]
      .filter((file): file is string => typeof file === 'string' && !!file);
    const mode = combinePropAlphaModes(files.map(file => overrides.get(basename(file).toLowerCase())));
    return mode ? { ...material, AlphaMode: mode } : material;
  });
}

/** A level's Materials[] (MaterialID = array index), enriched with any explicit per-page alpha verdict.
 * Cached-free; callers read it once per bake / payload. */
async function readLevelMaterials(level: string): Promise<SsxMaterial[]> {
  const [document, overrides] = await Promise.all([
    readJsonOr<{ Materials?: SsxMaterial[] }>(join(mapsRoot(), safeDataName(level), 'Materials.json'), {}),
    readJsonOr<Record<string, unknown>>(
      join(mapsRoot(), safeDataName(level), 'TextureAlpha.overrides.json'), {}),
  ]);
  return materialsWithAlphaOverrides(document.Materials ?? [], overrides);
}

/**
 * Every source level's Materials[], keyed by sanitised level name — what an export's material combiner
 * resolves a `usemtl` slot through.
 *
 * The tables are read up front, together, because a combiner's `resolveSlot` is called from inside the
 * synchronous geometry loops of every bake step: threading a promise through those loops would serialize the
 * bake on one file read per material. The whole library's tables are a fraction of a megabyte.
 */
export async function readMaterialTables(): Promise<ReadonlyMap<string, readonly SsxMaterial[]>> {
  const levels = [...new Set([...await levelsWithProps(), CUSTOM_TEX_LEVEL].map(safeDataName))];
  const tables = await mapLimit(levels, READ_CONCURRENCY, level => readLevelMaterials(level));
  return new Map(levels.map((level, index) => [level, tables[index]]));
}

/** The merged renderer cannot preserve a general animated object hierarchy. It can safely retain the subset
 * where every visible mesh is in one animated subtree and at most one rotation channel carries motion. Applying
 * that subtree's transform to the merged model is then exact. This includes single-channel gems, Elysium's
 * six-channel-bitmask kickers, and Merqury City's translating/turning blimp plus its screen twin. */
export function simpleModelRotation(model: ModelsJsonModel): PropModelRotation | undefined {
  const objects = model.ModelObjects ?? [];
  const meshObjectIndices = objects.flatMap((obj, index) => obj?.MeshData?.some(mesh => !!mesh) ? [index] : []);
  if (!meshObjectIndices.length || !(model.AnimTime && model.AnimTime > 0)) return undefined;
  const animatedObjectIndices = objects.flatMap((obj, index) =>
    obj?.Animation?.AnimationEntries?.length && obj.Animation.AnimationAction ? [index] : []);
  if (animatedObjectIndices.length !== 1) return undefined;
  const animatedObjectIndex = animatedObjectIndices[0];
  const descendsFromAnimatedObject = (index: number): boolean => {
    const seen = new Set<number>();
    for (let current = index; current >= 0 && current < objects.length && !seen.has(current);) {
      if (current === animatedObjectIndex) return true;
      seen.add(current);
      current = objects[current]?.ParentID ?? -1;
    }
    return false;
  };
  if (!meshObjectIndices.every(descendsFromAnimatedObject)) return undefined;
  const animation = objects[animatedObjectIndex]?.Animation;
  // The compact renderer applies the animated subtree's local transform directly at model root. Keep that
  // exact by requiring an identity path above the animated object; a translated/rotated parent needs the full
  // hierarchy player used by the Unity export instead. Descendant rest offsets are already baked into geometry
  // and move correctly with the subtree (the blimp's offset tail is the worked example).
  const identityPose = (object: ModelsJsonModelObject | null | undefined): boolean => {
    const p = object?.Position, r = object?.Rotation, s = object?.Scale;
    return (!p || p.every(value => Math.abs(value) < 1e-9))
      && (!r || (Math.abs(r[0] ?? 0) < 1e-9 && Math.abs(r[1] ?? 0) < 1e-9
        && Math.abs(r[2] ?? 0) < 1e-9 && Math.abs((r[3] ?? 1) - 1) < 1e-9))
      && (!s || s.every(value => Math.abs(value - 1) < 1e-9));
  };
  for (let current = animatedObjectIndex; current >= 0 && current < objects.length;) {
    if (!identityPose(objects[current])) return undefined;
    current = objects[current]?.ParentID ?? -1;
  }
  if ([animation?.U1, animation?.U2, animation?.U3, animation?.U4, animation?.U5, animation?.U6]
    .some(value => typeof value === 'number' && Math.abs(value) > 1e-9)) return undefined;
  const action = animation?.AnimationAction ?? 0;
  const channelBits = [1, 2, 4, 8, 16, 32] as const;
  const activeBits = channelBits.filter(bit => (action & bit) !== 0);
  const entries = animation?.AnimationEntries ?? [];
  if (!activeBits.length || entries.length !== activeBits.length) return undefined;
  const channels: { bit: number; segments: PropModelRotation['segments']; moving: boolean }[] = [];
  for (let i = 0; i < activeBits.length; i++) {
    const maths = entries[i]?.AnimationMaths;
    if (!maths?.length) return undefined;
    const segments: PropModelRotation['segments'] = [];
    for (const value of maths) {
      const segment: [number, number, number, number, number, number] =
        [value.Value1, value.Value2, value.Value3, value.Value4, value.Value5, value.Value6];
      if (!segment.every(Number.isFinite) || segment[5] < segment[4]) return undefined;
      segments.push(segment);
    }
    channels.push({ bit: activeBits[i], segments,
      moving: segments.some(segment => segment.slice(0, 4).some(value => Math.abs(value) > 1e-9)) });
  }
  const translations = ([1, 2, 4] as const).map(bit => channels.find(channel => channel.bit === bit));
  let rotations = channels.filter(channel => channel.bit >= 8 && channel.moving);
  // Preserve the original single-axis/static-curve behavior even when its coefficients happen to be zero.
  if (!rotations.length && channels.length === 1 && channels[0].bit >= 8) rotations = [channels[0]];
  if (rotations.length > 1) return undefined;
  const rotation = rotations[0];
  const hasTranslation = translations.some(channel => channel?.moving);
  if (!rotation && !hasTranslation) return undefined;
  return {
    clipFrames: model.AnimTime,
    ...(rotation ? {
      axis: rotation.bit === 8 ? 0 as const : rotation.bit === 16 ? 1 as const : 2 as const,
      segments: rotation.segments,
    } : {}),
    ...(hasTranslation ? { translation: translations.map(channel => channel?.segments ?? null) as
      PropModelRotation['translation'] } : {}),
  };
}

/** Preserve a general native object-hierarchy clip in the same shape the Unity bundle player consumes. The
 * renderer keeps geometry baked in its exact rest pose and applies each object's animated-world × inverse-rest
 * delta, so unanimated parents/siblings and animated descendants can coexist without duplicating mesh data. */
export function hierarchicalModelAnimation(model: ModelsJsonModel): PropModelAnimation | undefined {
  if (!(model.AnimTime && model.AnimTime > 0)) return undefined;
  let animated = false;
  const objects: PropModelAnimation['objects'] = [];
  for (const [index, object] of (model.ModelObjects ?? []).entries()) {
    const position = object?.Position;
    const rotation = object?.Rotation;
    const scale = object?.Scale;
    const restRotation: [number, number, number, number] = [
      rotation?.[0] ?? 0, rotation?.[1] ?? 0, rotation?.[2] ?? 0, rotation?.[3] ?? 1,
    ];
    const qLength = Math.hypot(...restRotation);
    if (qLength > 1e-12) for (let axis = 0; axis < 4; axis++) restRotation[axis] /= qLength;
    else restRotation[3] = 1;
    const entry: PropModelAnimation['objects'][number] = {
      parent: object?.ParentID !== undefined && object.ParentID >= 0 && object.ParentID < (model.ModelObjects?.length ?? 0)
        && object.ParentID !== index ? object.ParentID : -1,
      restPosition: [position?.[0] ?? 0, position?.[1] ?? 0, position?.[2] ?? 0],
      restRotation,
      restScale: [scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1],
    };
    const animation = object?.Animation;
    const action = animation?.AnimationAction ?? 0;
    const activeBits = [1, 2, 4, 8, 16, 32].filter(bit => (action & bit) !== 0);
    const rawChannels = animation?.AnimationEntries ?? [];
    if (activeBits.length && rawChannels.length === activeBits.length) {
      const channels: NonNullable<PropModelAnimation['objects'][number]['channels']> =
        [null, null, null, null, null, null];
      let valid = true;
      for (let channel = 0; channel < activeBits.length; channel++) {
        const maths = rawChannels[channel]?.AnimationMaths;
        const component = Math.log2(activeBits[channel]);
        if (!maths?.length || !Number.isInteger(component) || component < 0 || component > 5) { valid = false; break; }
        const curve: PropModelCurve = maths.map(value =>
          [value.Value1, value.Value2, value.Value3, value.Value4, value.Value5, value.Value6]);
        if (curve.some(segment => !segment.every(Number.isFinite) || segment[5] < segment[4])) { valid = false; break; }
        channels[component] = curve;
      }
      if (valid) {
        entry.basePosition = [animation?.U1 ?? 0, animation?.U2 ?? 0, animation?.U3 ?? 0];
        entry.baseEuler = [animation?.U4 ?? 0, animation?.U5 ?? 0, animation?.U6 ?? 0]
          .map(value => THREE.MathUtils.radToDeg(value)) as V3;
        entry.channels = channels;
        animated = true;
      }
    }
    objects.push(entry);
  }
  return animated ? { clipFrames: model.AnimTime, objects } : undefined;
}

/**
 * Merge the meshes of the given models (by ModelID = index into Models[]) into per-material submeshes, parsed
 * from the level's Meshes/*.obj. A mesh shared by several models is parsed once; each model's meshes are
 * grouped by their MeshData.MaterialID (so one draw per texture) and welded on (vIdx, tIdx). A model with no
 * static geometry (animated / effect only) is omitted.
 */
export async function readModelGeometries(level: string, ids: Set<number>,
  effectPieceModels = new Set<number>()): Promise<Map<number, ModelGeom>> {
  const lvl = safeDataName(level);
  const dir = join(mapsRoot(), lvl);
  const modelsJson = await readJsonOr<ModelsJson | null>(join(dir, 'Models.json'), null);
  if (!modelsJson) return new Map();
  const meshDir = join(dir, 'Meshes');

  // Every mesh the requested models name, read and parsed up front. A level's models share meshes heavily, so
  // the set is deduplicated first; reading them together is what keeps a large bake from becoming a few
  // thousand sequential round trips to a cold filesystem.
  const wanted = new Set<string>();
  modelsJson.Models.forEach((m, id) => {
    if (!ids.has(id)) return;
    for (const obj of m.ModelObjects ?? [])
      for (const md of obj?.MeshData ?? []) if (md) wanted.add(md.MeshPath);
  });
  const paths = [...wanted];
  const parsed = await mapLimit(paths, READ_CONCURRENCY, async path => {
    const text = await readTextOrNull(join(meshDir, safeDataName(path.replace(/\.obj$/i, '')) + '.obj'));
    return text === null ? null : parseObj(text);
  });
  const meshCache = new Map(paths.map((path, index) => [path, parsed[index]]));
  const readMesh = (path: string): RawMesh | null => meshCache.get(path) ?? null;

  const out = new Map<number, ModelGeom>();
  // ModelID indexes directly into Models[] (see Instances[].ModelID), so the array index IS the id.
  modelsJson.Models.forEach((m, id) => {
    if (!ids.has(id)) return;
    const objectMatrices = modelObjectRestMatrices(m);
    const rotation = simpleModelRotation(m);
    // Keep the proven compact player for models it can represent exactly. Complex clips retain the complete
    // hierarchy instead (MESA's mine cart has a static shell plus a six-channel animated child subtree).
    const animation = rotation ? undefined : hierarchicalModelAnimation(m);
    const meshObjectIndices = (m.ModelObjects ?? []).flatMap((obj, index) =>
      obj?.MeshData?.some(mesh => !!mesh) ? [index] : []);
    // Keep transformed multi-object models partitioned, and also preserve every object of a decoded Sub20 target.
    // The latter is load-bearing for identity-transform models such as MERQUER's loose mailbox letters: material
    // batching would otherwise weld all 21 independently thrown objects into one clump.
    const effectPieces = effectPieceModels.has(id);
    const splitPieces = meshObjectIndices.length > 1 && (effectPieces || !!animation || meshObjectIndices.some(index => {
      const e = objectMatrices[index]?.elements;
      return !!e && (Math.abs(e[12]) > 1e-6 || Math.abs(e[13]) > 1e-6 || Math.abs(e[14]) > 1e-6);
    }));
    const byMat = new Map<string, ModelSub>(); // piece/material → submesh, first-seen order
    for (const [objectIndex, obj] of (m.ModelObjects ?? []).entries()) {
      for (const md of obj?.MeshData ?? []) {
        if (!md) continue;
        const g = readMesh(md.MeshPath);
        if (!g) continue;
        const mat = md.MaterialID ?? -1;
        const key = splitPieces ? `${objectIndex}:${mat}` : String(mat);
        let sub = byMat.get(key);
        if (!sub) byMat.set(key, (sub = { mat, positions: [], uvs: [], indices: [],
          ...(splitPieces ? { piece: objectIndex } : {}),
          ...(animation ? { object: objectIndex } : {}) }));
        addMeshToSub(sub, g, objectMatrices[objectIndex] ?? new THREE.Matrix4());
      }
    }
    const subs = [...byMat.values()].filter(s => s.indices.length);
    if (splitPieces) {
      const pieceCentroids = new Map<number, V3>();
      if (effectPieces) for (const piece of meshObjectIndices) {
        const pieceSubs = subs.filter(sub => sub.piece === piece);
        const sum: V3 = [0, 0, 0];
        let count = 0;
        for (const sub of pieceSubs) for (let k = 0; k + 2 < sub.positions.length; k += 3) {
          sum[0] += sub.positions[k]; sum[1] += sub.positions[k + 1]; sum[2] += sub.positions[k + 2]; count++;
        }
        if (count) pieceCentroids.set(piece, [sum[0] / count, sum[1] / count, sum[2] / count]);
      }
      for (const sub of subs) {
        if (sub.piece === undefined) continue;
        // A thrown shard tumbles around its own recovered vertex centroid. Other transformed multi-object models
        // retain their authored object origin, which is the correct pivot for ordinary hierarchy animation.
        sub.piecePivot = pieceCentroids.get(sub.piece)
          ?? new THREE.Vector3().setFromMatrixPosition(objectMatrices[sub.piece]).toArray() as V3;
      }
    }
    if (subs.length) out.set(id, { name: m.ModelName, subs,
      ...(rotation ? { rotation } : {}), ...(animation ? { animation } : {}) });
  });
  return out;
}

/** The prop bake itself, on whichever thread calls it. The worker pool's entry point calls this directly;
 *  ordinary server code goes through `readLevelPropsWithCacheInfo`, which routes it off the main thread. */
export async function buildLevelPropsUncached(level: string): Promise<PropsPayload> {
  const lvl = safeDataName(level);
  const levelDir = join(mapsRoot(), lvl);
  // Instances.json and Effects.json are the two large reads here and are independent of one another.
  const [instJson, effectsDocument] = await Promise.all([
    readJsonOr<InstancesJson | null>(join(levelDir, 'Instances.json'), null),
    readEffectsDocument(levelDir),
  ]);
  if (!instJson) throw new Error(`no Instances.json for level "${lvl}"`);
  const rollerMasses = readRollerInstanceMasses(effectsDocument, instJson.Instances);

  // only models that are actually placed need geometry sent
  const used = new Set<number>();
  for (const i of instJson.Instances) if (i.ModelID >= 0) used.add(i.ModelID);
  const [geoms, mats] = await Promise.all([
    readModelGeometries(lvl, used, readMeshThrowModelIds(effectsDocument, instJson.Instances)),
    readLevelMaterials(lvl),
  ]);

  const models: PropsPayload['models'] = [...geoms].map(([id, g]) => ({
    id,
    name: g.name,
    ...(g.rotation ? { rotation: g.rotation } : {}),
    ...(g.animation ? { animation: g.animation } : {}),
    subs: g.subs.map(s => ({
      mat: s.mat,
      pos: Buffer.from(new Float32Array(s.positions).buffer).toString('base64'),
      uv: Buffer.from(new Float32Array(s.uvs).buffer).toString('base64'),
      ...(s.normals?.length === s.positions.length
        ? { nor: Buffer.from(new Float32Array(s.normals).buffer).toString('base64') } : {}),
      idx: Buffer.from(new Uint32Array(s.indices).buffer).toString('base64'),
      ...(s.piece === undefined ? {} : { piece: s.piece }),
      ...(s.piecePivot ? { piecePivot: s.piecePivot } : {}),
      ...(s.object === undefined ? {} : { object: s.object }),
    })),
  }));

  // the textures those submeshes reference (MaterialID → file), so the client can fetch them from /api/texture
  const matIds = new Set<number>();
  for (const g of geoms.values()) for (const s of g.subs) if (s.mat >= 0) matIds.add(s.mat);
  const materials = [...matIds].map(id => ({
    id,
    tex: mats[id]?.TexturePath || null,
    frames: mats[id]?.TextureFlipbook?.filter(name => typeof name === 'string') ?? [],
    // The appearance word's bit 18 selects the game's alpha pass ([Trailmap: 220]); the client combines it
    // with the served PNG histogram to separate alpha-test holes from real blend/glow surfaces.
    ...((Number(mats[id]?.UnknownInt18 ?? 0) & 0x40000) !== 0 ? { blend: true } : {}),
    ...(mats[id]?.AlphaMode ? { alphaMode: mats[id].AlphaMode } : {}),
    // bit 17 = opaque draw-order priority: the coplanar-decal z-fight tiebreaker (Mdl_Lcdscan, the firework
    // cylinder, Finish_Coral). The editor does not reorder draws, but the client still uses this policy to
    // alpha-test binary-mask pages ([Trailmap: 170]).
    ...((Number(mats[id]?.UnknownInt18 ?? 0) & 0x20000) !== 0 ? { prio: true } : {}),
  }));
  const crowdFrames = (await listDir(join(mapsRoot(), lvl, 'Textures')))
    .filter(name => /^cd\d+\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // Collision is its own native asset stream, not the visible model. Pack each referenced proxy once even when
  // hundreds of placements share it (tree leaves are the common case).
  const collisionIds = new Set<string>();
  for (const instance of instJson.Instances) {
    if (instance.CollsionMode !== NATIVE_COLLISION_MODE.triangleProxy) continue;
    for (const path of instance.CollsionModelPaths ?? []) collisionIds.add(safeDataName(path.replace(/\.obj$/i, '')));
  }
  const collisionTexts = await mapLimit([...collisionIds], READ_CONCURRENCY,
    id => readTextOrNull(join(mapsRoot(), lvl, 'Collision', `${id}.obj`)));
  const collisionMeshes: NonNullable<PropsPayload['collisionMeshes']> = [];
  for (const [index, id] of [...collisionIds].entries()) {
    const text = collisionTexts[index];
    if (text === null) continue;
    const raw = parseObj(text);
    const indices = new Uint32Array(raw.corners.length / 3);
    for (let corner = 0; corner < indices.length; corner++) indices[corner] = raw.corners[corner * 3];
    if (!raw.v.length || !indices.length) continue;
    collisionMeshes.push({
      id,
      pos: Buffer.from(new Float32Array(raw.v).buffer).toString('base64'),
      idx: Buffer.from(indices.buffer).toString('base64'),
    });
  }

  const physicsIds = new Set<number>();
  for (const instance of instJson.Instances) if (instance.CollsionMode === NATIVE_COLLISION_MODE.physicsBodySpheres
    && typeof instance.PhysicsIndex === 'number' && instance.PhysicsIndex >= 0)
    physicsIds.add(instance.PhysicsIndex);
  const physicsBodies: NonNullable<PropsPayload['physicsBodies']> = [];
  for (const id of physicsIds) {
    const body = await readPhysicsBody(lvl, id, effectsDocument);
    if (!body?.decoded.spheres.length) continue;
    // The mass properties ride along with the shape: the shove solver needs the inverse inertia to divide an
    // impulse between spin and travel, and a body can legitimately ship a shape without a usable tensor.
    const mass = decodePhysicsBodyMassProps(effectsDocument, id);
    physicsBodies.push({
      id, sph: Buffer.from(new Float32Array(body.decoded.spheres).buffer).toString('base64'),
      ...(body.recipe ? { up: encodeUnityBodyRecipe(body.recipe) } : {}),
      ...(mass ? {
        com: mass.com,
        ii: Buffer.from(new Float32Array(mass.invInertia).buffer).toString('base64'),
      } : {}),
    });
  }

  const instances = instJson.Instances
    .map((instance, sourceIndex) => ({ instance, sourceIndex }))
    // A hidden/native collision utility can legitimately have no drawable model. Keep it in the reference data;
    // the renderer simply has no mesh to instance, while Play can still consume its collision proxy/body.
    .filter(({ instance }) => geoms.has(instance.ModelID)
      || (instance.PlayerCollision !== false
        && (instance.CollsionMode ?? NATIVE_COLLISION_MODE.none) > NATIVE_COLLISION_MODE.none))
    .map(({ instance, sourceIndex }) => {
      const shape = instance.CollsionMode ?? NATIVE_COLLISION_MODE.none;
      const touchable = instance.PlayerCollision !== false
        && shape !== NATIVE_COLLISION_MODE.none
        && (shape !== NATIVE_COLLISION_MODE.triangleProxy || !!instance.CollsionModelPaths?.length)
        && (shape !== NATIVE_COLLISION_MODE.physicsBodySpheres
          || (typeof instance.PhysicsIndex === 'number' && instance.PhysicsIndex >= 0));
      const contact = nativeContactState({
        visible: instance.Visable !== false,
        playerCollision: instance.PlayerCollision !== false,
        playerBounce: instance.PlayerBounce !== false,
        mode: shape as NativeCollisionMode,
        responseMass: typeof instance.U0 === 'number' ? instance.U0 : 1e30,
        hasTriangleProxy: !!instance.CollsionModelPaths?.length,
        hasPhysicsBody: typeof instance.PhysicsIndex === 'number' && instance.PhysicsIndex >= 0,
      });
      // Preserve the whole variable-sized ExternalSound record in compact form. `p` starts at U5; only the
      // fields actually present are carried, so an old extraction's truncated type-1 row is visible as such
      // instead of silently manufacturing five zero values.
      const externalSounds = (instance.IncludeSound !== false ? instance.Sounds?.ExternalSounds ?? [] : [])
        .flatMap(record => {
          if (!record || !Number.isInteger(record.SoundIndex) || !Number.isInteger(record.U0)) return [];
          const type = Number(record.U0);
          const expected = type === 0 ? 2 : type === 1 || type === 2 ? 7 : type === 3 ? 1 : 7;
          const tail = [record.U5, record.U6, record.U7, record.U8, record.U9, record.U10, record.U11];
          const params: number[] = [];
          for (const value of tail.slice(0, expected)) {
            if (typeof value !== 'number' || !Number.isFinite(value)) break;
            params.push(value);
          }
          return [{ t: type, s: Number(record.SoundIndex),
            o: [Number(record.U2) || 0, Number(record.U3) || 0, Number(record.U4) || 0], p: params }];
        });
      return {
        i: sourceIndex, m: instance.ModelID, p: instance.Location, q: instance.Rotation,
        s: instance.Scale, n: instance.InstanceName, v: instance.Visable !== false,
        // State 0 is the overwhelmingly common case; omission keeps the payload compact while decodeProps
        // restores it. The other values are authoring/provenance facts and must survive into Prop Details.
        ...(Number.isInteger(instance.LTGState) && instance.LTGState !== 0
          ? { ls: Number(instance.LTGState) } : {}),
        ...(instance.AmbentLightColour?.length ? {
          la: instance.AmbentLightColour.slice(0, 3),
          lk: [instance.LightColour1, instance.LightColour2, instance.LightColour3]
            .flatMap(value => value?.slice(0, 3) ?? [0, 0, 0]),
          lv: [instance.LightVector1, instance.LightVector2, instance.LightVector3]
            .flatMap(value => value?.slice(0, 3) ?? [0, 0, 0]),
        } : {}),
        pc: instance.PlayerCollision !== false, pb: instance.PlayerBounce !== false,
        // the instance's ADL collision-sound event id (the prop-hit one-shot), omitted when none ships
        ...(instance.IncludeSound !== false && instance.Sounds && Number.isInteger(instance.Sounds.CollisonSound)
          ? { hs: Number(instance.Sounds.CollisonSound) } : {}),
        // Shape eligibility, response mass, and PlayerBounce implement [Trailmap: 130-collision-data,
        // 370-world-interaction]. Live mode-1 and mode-2 flag-off controls both dispatched contact and passed through.
        // Dynamic movement does not change this class; dm below comes from the collision Roller effect.
        c: contact === 'none' ? 0 : contact === 'solid' ? 2 : 1,
        // Touchable instances also carry their contact response: zero kickback represents a contact-only
        // flag-off state; otherwise it is the authored restitution. Shape remains independent.
        ...(touchable ? {
          bn: instance.PlayerBounce === false ? 0
            : Math.round((typeof instance.PlayerBounceAmmount === 'number' ? instance.PlayerBounceAmmount : 0.5) * 1000) / 1000,
        } : {}),
        // Preserve configured geometry even while PlayerCollision gates it off: the Props inspector renders
        // the disabled shape in slate so the stored mode/body is diagnosable instead of disappearing.
        ...(typeof instance.CollsionMode === 'number'
          && instance.CollsionMode > NATIVE_COLLISION_MODE.none ? { cm: instance.CollsionMode } : {}),
        ...(typeof instance.U0 === 'number' ? { rm: instance.U0 } : {}),
        ...(rollerMasses.has(sourceIndex) ? { dm: rollerMasses.get(sourceIndex)! } : {}),
        ...(typeof instance.PhysicsIndex === 'number' && instance.PhysicsIndex >= 0 ? { px: instance.PhysicsIndex } : {}),
        ...(instance.CollsionMode === NATIVE_COLLISION_MODE.triangleProxy && instance.CollsionModelPaths?.length
          ? { cp: instance.CollsionModelPaths.map(path => safeDataName(path.replace(/\.obj$/i, ''))) } : {}),
        // the rare rideable prop's surface type (ride feel + board-audio family, [Trailmap: 120-objects])
        ...(typeof instance.SurfaceType === 'number' && instance.SurfaceType >= 0 ? { st: instance.SurfaceType } : {}),
        ...(externalSounds.length ? { xs: externalSounds } : {}),
      };
    });

  const soundIndex = await readJsonOr<CollisionSoundIndex | null>(
    join(mapsRoot(), lvl, 'Audio', 'SoundIndex.json'), null);
  return { level: lvl, ...(soundIndex ? { soundIndex } : {}), models, materials, crowdFrames, collisionMeshes, physicsBodies, instances };
}

/** Persist the expensive extracted OBJ/material/physics bake across dev-server and application restarts. The
 * source metadata fingerprint changes whenever an input changes, while the ordinary response cache still owns
 * in-flight sharing, compression, ETags, and hot-process LRU behavior. */
export function readLevelPropsJsonWithCacheInfo(level: string): Promise<PersistentPropsJson> {
  const lvl = safeDataName(level);
  const levelDir = join(mapsRoot(), lvl);
  // A cold build is tens of seconds of parsing and encoding, so it runs on a worker thread; a cache hit stays
  // here, because reading the finished payload is far cheaper than shipping the request across threads.
  return readPersistentPropsJson(lvl, levelDir, async () => {
    const { workspaceRoot } = workspaceConfig();
    return await runInWorker({ kind: 'props', level: lvl, mapsRoot: mapsRoot(), workspaceRoot }) as Uint8Array;
  });
}

export async function readLevelPropsWithCacheInfo(level: string): Promise<PersistentPropsPayload> {
  const stored = await readLevelPropsJsonWithCacheInfo(level);
  return {
    payload: JSON.parse(stored.json.toString('utf8')) as PropsPayload,
    cache: stored.cache,
    fingerprint: stored.fingerprint,
  };
}

export async function readLevelProps(level: string): Promise<PropsPayload> {
  return (await readLevelPropsWithCacheInfo(level)).payload;
}

/**
 * Decode a `physicsBodySpheres` body's LEAF SPHERES — the engine's actual prop collision volume for
 * those instances (signs, rocks, gateways, crash bags), so the viewport can draw the true tested shape on select.
 * The SSF payload (the extracted level's Effects.json physics[PhysicsIndex].data.PhysicsDatas[0]) is a
 * depth-5 base-8 OCCUPANCY TREE over a cube at the body origin (UFloat0-2, model-local raw cm)
 * [Trailmap: 130-collision-data, 230-level-ssf]; this mirrors the validated Snowknife decoder
 * (Bundle/SsxPhysicsBodies.cs) but emits the runtime's leaf spheres instead of lattice cells:
 *   - UByteData = RLE child masks (ctrl<0 copy −ctrl literals, >0 repeat next byte ctrl+1×, 0 stop),
 *   - child mask offset = parent + (bit+1)·U2[depth] (the +1 is load-bearing),
 *   - child center = parent + octant(bit)·U1[depth+1], set bit = +axis (x=bit&4, y=bit&2, z=bit&1),
 *   - a node whose mask is 0, or at max depth, is a LEAF sphere of radius U0[depth].
 * Returns [x, y, z, r][] in model-local raw cm, or null when the level/body ships none.
 */
interface PhysicsBodyPreview { decoded: DecodedPhysicsBody; recipe?: UnityBodyRecipe }

interface NativePhysicsData extends Record<string, unknown> {
  UFloat0?: number;
  UFloat1?: number;
  UFloat2?: number;
  UByteData?: string;
  uPhysicsStruct0?: PhysicsTreeLevel[];
}

function nativePhysicsData(document: EffectsDocument | null, index: number): NativePhysicsData | null {
  if (!document || index < 0) return null;
  const records = document.physics?.[index]?.data?.PhysicsDatas;
  const data = Array.isArray(records) ? records[0] : null;
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as NativePhysicsData : null;
}

function encodeBodyShape(shape: UnityBodyRecipe['body']) {
  return {
    boxes: shape.boxes.flatMap(box => [...box.center, ...box.size]),
    capsules: shape.capsules.flatMap(capsule => [...capsule.a, ...capsule.b, capsule.radius]),
  };
}

function encodeUnityBodyRecipe(recipe: UnityBodyRecipe): NonNullable<NonNullable<PropsPayload['physicsBodies']>[number]['up']> {
  const body = encodeBodyShape(recipe.body), tilt = encodeBodyShape(recipe.tilt);
  return {
    d: recipe.doorwayOrSparse, bb: [...recipe.bounds.center, ...recipe.bounds.size],
    ...(body.boxes.length ? { b: body.boxes } : {}), ...(body.capsules.length ? { c: body.capsules } : {}),
    ...(tilt.boxes.length ? { tb: tilt.boxes } : {}), ...(tilt.capsules.length ? { tc: tilt.capsules } : {}),
  };
}

async function readPhysicsBody(level: string, index: number,
  parsedDocument?: EffectsDocument | null): Promise<PhysicsBodyPreview | null> {
  const document = parsedDocument === undefined
    ? await readEffectsDocument(join(mapsRoot(), safeDataName(level))) : parsedDocument;
  const decode = (): PhysicsBodyPreview | null => {
    const data = nativePhysicsData(document, index);
    const levels = data?.uPhysicsStruct0;
    if (!data || !levels || levels.length < 2 || typeof data.UByteData !== 'string'
      || !Number.isFinite(data.UFloat0) || !Number.isFinite(data.UFloat1) || !Number.isFinite(data.UFloat2)) return null;
    const rle = Buffer.from(data.UByteData, 'base64');
    const masks: number[] = [];
    for (let i = 0; i < rle.length;) {
      const ctrl = rle.readInt8(i++);
      if (ctrl === 0) break;
      if (ctrl < 0) for (let k = 0; k < -ctrl && i < rle.length; k++) masks.push(rle[i++]);
      else { const byte = rle[i++]; for (let k = 0; k <= ctrl; k++) masks.push(byte); }
    }
    const decoded = decodePhysicsBodyTree([data.UFloat0!, data.UFloat1!, data.UFloat2!], levels, masks);
    if (!decoded) return null;
    // A malformed edge-case body must never take away the exact native sphere overlay. Keep the decoded shape
    // even when the Unity simplification cannot be derived.
    let recipe: UnityBodyRecipe | undefined;
    try { recipe = buildUnityBodyRecipe(decoded); } catch { /* native spheres remain available */ }
    return { decoded, ...(recipe ? { recipe } : {}) };
  };
  try { return decode(); } catch { return null; }
}

/**
 * The same body record's leading RIGID-BODY MASS PROPERTIES [Trailmap: 130-collision-data]: `UFloat0-2` centre of
 * mass, `UFloat3-5` a second reference point, `UFloat6-14` the symmetric inertia tensor row-major, and
 * `UFloat15-23` its inverse — the matrix the retail solver consumes directly on the shove path
 * [Trailmap: 370-world-interaction]. Lengths are model-local raw cm, so the inverse inertia carries 1/(m·cm²)
 * and its consumer converts.
 *
 * The record ships no scalar mass: a Roller effect supplies that separately and its constructor writes the
 * body's runtime inverse mass. The inertia is what the level authored, and it is the term that decides how a
 * struck body divides an impulse between spin and travel.
 */
export interface PhysicsBodyMassProps {
  /** Centre of mass, model-local raw cm. */
  com: [number, number, number];
  /** Inverse inertia tensor, row-major 9, 1/(mass·cm²). */
  invInertia: number[];
}

function decodePhysicsBodyMassProps(document: EffectsDocument | null, index: number): PhysicsBodyMassProps | null {
  // physics[] is in native order, so PhysicsIndex indexes it directly.
  const data = nativePhysicsData(document, index);
  if (!data) return null;
  const at = (n: number) => {
    const value = data[`UFloat${n}`];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const com = [at(0), at(1), at(2)];
  const invInertia = [15, 16, 17, 18, 19, 20, 21, 22, 23].map(at);
  if (com.some(v => v === null) || invInertia.some(v => v === null)) return null;
  // A degenerate/absent tensor decodes as all-zero; that is not a body the solver can divide an impulse with.
  if (!invInertia.some(v => Math.abs(v!) > 0)) return null;
  return { com: com as [number, number, number], invInertia: invInertia as number[] };
}

export async function readPhysicsBodyMassProps(level: string, index: number): Promise<PhysicsBodyMassProps | null> {
  const document = await readEffectsDocument(join(mapsRoot(), safeDataName(level)));
  return decodePhysicsBodyMassProps(document, index);
}

export async function readPhysicsBodySpheres(level: string, index: number):
  Promise<[number, number, number, number][] | null> {
  const packed = (await readPhysicsBody(level, index))?.decoded.spheres;
  if (!packed?.length) return null;
  const spheres: [number, number, number, number][] = [];
  for (let offset = 0; offset + 3 < packed.length; offset += 4)
    spheres.push([packed[offset], packed[offset + 1], packed[offset + 2], packed[offset + 3]]);
  return spheres;
}

/** One model's local axis-aligned bounding box (raw cm, Z-up), read off the level's Meshes/ — the geometry a
 *  sign light is derived from (core/signlights.deriveSignLight). Null if the model has no static geometry or
 *  its source level is missing. */
export async function modelLocalBox(level: string, model: number): Promise<LocalBox | null> {
  let g: Map<number, ModelGeom>;
  try { g = await readModelGeometries(level, new Set([model])); } catch { return null; }
  return modelGeometryBox(g.get(model) ?? null);
}

/**
 * A material combiner over the whole extracted library: every source level's `Materials[]` in hand, so a
 * bake's `resolveSlot` stays synchronous. The combining itself is core (`buildMaterialCombiner`); this is the
 * read that feeds it.
 */
export async function createMaterialCombiner(): Promise<MaterialCombiner> {
  return buildMaterialCombiner(await readMaterialTables());
}

/**
 * Which extracted level supplies the native art a from-scratch mountain borrows — the rail tube's skin and
 * the three gem tier crystals — and which of its models carry it.
 *
 * The donor is the first extracted level with prop tables, and both answers come off its `Models.json`: the
 * rail skin from the shipped `Mdl_Rail_Metal*` models' own MeshData (first textured binding wins — data
 * derived, no filename guess), the crystals from `Gem_TrickMultiplier_YellowX2 / OrangeX3 / RedX5` (the same
 * base mesh at three scales; the first model of each tier wins, since copies are identical geometry).
 */
export async function nativeArtSource(): Promise<NativeArt> {
  const level = (await levelsWithProps())[0] ?? '';
  const modelsJson = await readJsonOr<ModelsJson | null>(
    join(mapsRoot(), safeDataName(level), 'Models.json'), null);
  const models = modelsJson?.Models ?? [];

  const railMaterial = railSkinMaterial(models);

  const gemTiers: NativeArt['gemTiers'] = [];
  models.forEach((m, id) => {
    const nm = m.ModelName ?? '';
    if (!nm.startsWith('Gem_TrickMultiplier')) return;
    const tier = nm.includes('YellowX2') ? 2 : nm.includes('OrangeX3') ? 3 : nm.includes('RedX5') ? 5 : 0;
    if (tier && !gemTiers.some(t => t.tier === tier)) gemTiers.push({ tier, model: id });
  });

  return { level, railMaterial, gemTiers };
}

/** The donor's rail-tube material: the first textured MeshData binding of its first `Mdl_Rail_Metal*` model.
 *  Null when the donor ships no rail-tube models, which bakes the tubes untextured. */
function railSkinMaterial(models: readonly ModelsJsonModel[]): number | null {
  for (const m of models) {
    if (!/^Mdl_Rail_Metal/.test(m.ModelName ?? '')) continue;
    for (const obj of m.ModelObjects ?? []) for (const md of obj?.MeshData ?? []) {
      if (md && (md.MaterialID ?? -1) >= 0) return md.MaterialID!;
    }
  }
  return null;
}
