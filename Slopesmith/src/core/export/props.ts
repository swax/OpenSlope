import type { AuthoredModel, PlacedProp, Rail, V3 } from '../doc/types';
import { authoredModelFrames, modelNumber, tiledPropUV } from '../doc/models';
import type { LocalBox } from '../lighting/sign-lights';
import { railSupportPosts, sweepRail } from '../rails/rail-mesh';
import { railHasTube, railStyle, RAIL_STYLE_WOOD } from '../rails/rails';
import { effectTriggerWorldSize, isEffectTriggerProp } from '../effects/trigger-volume';
import { placedPropSolid } from '../props/contact';
import { placementQuat, rotateByPlacement } from '../props/pose';
import { propModelAnimationHasIdentityRoot,
  type LevelProps, type PropModelAnimation, type PropModelAnimationObject } from '../reference/props';
import { safeDataName } from './names';
import type { MaterialCombiner } from './materials';

/**
 * The OBJ bakes an export appends to `Props.obj` (and `GemModels.obj`): placed reference props, authored
 * models, imported GLBs, effect trigger volumes, rail tubes and the gem tier crystals.
 *
 * All six are pure transforms over data handed in — geometry, a material combiner, a Scroll.json index —
 * because the bytes behind them arrive through the export's byte provider rather than from a filesystem.
 * `vertexOffset` / `uvOffset` are the v / vt lines already in the file being appended to, so the emitted
 * faces index into the combined result.
 */

/** The minimum a bake needs off a submesh. A level's parsed `Meshes/` and the imported catalogue's decoded
 *  `PropSub` (typed arrays, docs/032) both satisfy it. */
export interface GeomSub {
  /** MaterialID (index into the source level's Materials[]); -1 when the mesh has no material. */
  mat: number;
  positions: ArrayLike<number>;
  uvs: ArrayLike<number>;
  indices: ArrayLike<number>;
}

/** One source-level model's per-material submeshes, model-local raw cm. */
export interface ModelGeometry {
  subs: readonly GeomSub[];
}

/** A (level, model) → geometry lookup, resolved before the bake so the emission loops stay synchronous. */
export type GeometryLookup = (level: string, model: number) => ModelGeometry | null;

/** One model's local axis-aligned bounding box (raw cm, Z-up) — the geometry a sign light is derived from
 *  (core/lighting/sign-lights deriveSignLight). Null when the model carries no static geometry. */
export function modelGeometryBox(geom: ModelGeometry | null): LocalBox | null {
  if (!geom) return null;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of geom.subs) for (let k = 0; k < s.positions.length; k += 3) for (let j = 0; j < 3; j++) {
    const v = s.positions[k + j]; if (v < min[j]) min[j] = v; if (v > max[j]) max[j] = v;
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

// ---- placement transform ------------------------------------------------------------------------------

/** A 4×4 in the column-major layout `Matrix4.elements` uses, so a pose composes and applies identically to
 *  the transform the viewport renders a placement with. */
export type Mat4 = number[];

/** raw SSX cm → editor metres: the map a placed model's verts already ride under `worldRoot`. Emission
 *  undoes it (`toRaw`), so an identity placement bakes the model verbatim. */
const RAW_TO_EDITOR: Mat4 = [
  -0.01, 0, 0, 0,
  0, 0, -0.01, 0,
  0, 0.01, 0, 0,
  0, 0, 0, 1,
];

function composeMat4(px: number, py: number, pz: number,
                     qx: number, qy: number, qz: number, qw: number,
                     sx: number, sy: number, sz: number): Mat4 {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    px, py, pz, 1,
  ];
}

function multiplyMat4(ae: Mat4, be: Mat4): Mat4 {
  const a11 = ae[0], a12 = ae[4], a13 = ae[8], a14 = ae[12];
  const a21 = ae[1], a22 = ae[5], a23 = ae[9], a24 = ae[13];
  const a31 = ae[2], a32 = ae[6], a33 = ae[10], a34 = ae[14];
  const a41 = ae[3], a42 = ae[7], a43 = ae[11], a44 = ae[15];
  const b11 = be[0], b12 = be[4], b13 = be[8], b14 = be[12];
  const b21 = be[1], b22 = be[5], b23 = be[9], b24 = be[13];
  const b31 = be[2], b32 = be[6], b33 = be[10], b34 = be[14];
  const b41 = be[3], b42 = be[7], b43 = be[11], b44 = be[15];
  const te: Mat4 = new Array(16);
  te[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  te[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  te[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  te[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
  te[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  te[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  te[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  te[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
  te[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  te[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  te[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  te[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
  te[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  te[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  te[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  te[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
  return te;
}

/** A placement's model→world matrix, in the space the CLIENT renders it: `compose(pos, rotation, scale)`
 *  applied to raw model verts already mapped through RAW_TO_EDITOR under worldRoot. The rotation comes from
 *  the shared resolver, so a tilted prop bakes at the angle the viewport draws it. */
export function placementMatrix(p: PlacedProp): Mat4 {
  const [qx, qy, qz, qw] = placementQuat(p);
  return multiplyMat4(
    composeMat4(p.pos[0], p.pos[1], p.pos[2], qx, qy, qz, qw, p.scale, p.scale, p.scale),
    RAW_TO_EDITOR);
}

/**
 * The placement's rotation as a NATIVE instance quaternion (raw SSX space, `Instances[].Rotation`).
 *
 * `RAW_TO_EDITOR` is improper (it carries the X mirror), so conjugating a rotation through it negates the
 * axis as well as re-labelling it: an editor turn about axis `(x, y, z)` is a raw turn of the same angle
 * about `(x, z, −y)`. For a pure yaw that reduces to the familiar "editor +Y yaw = raw −Z yaw"; the general
 * form is what a tilted placement needs so its collision shape stands at the angle its geometry baked at.
 */
export function rawInstanceQuat(p: PlacedProp): number[] {
  const [qx, qy, qz, qw] = placementQuat(p);
  return [qx, qz, -qy, qw];
}

/** One model-local raw-cm point through a placement pose and back into world raw cm — the exact map every
 *  baked `v` line takes, shared so a clip pivot cannot land in a different frame from the geometry it turns. */
function posedRawPoint(pose: Mat4, x: number, y: number, z: number): [number, number, number] {
  const w = 1 / (pose[3] * x + pose[7] * y + pose[11] * z + pose[15]);
  const vx = (pose[0] * x + pose[4] * y + pose[8] * z + pose[12]) * w;   // → data-editor metres
  const vy = (pose[1] * x + pose[5] * y + pose[9] * z + pose[13]) * w;
  const vz = (pose[2] * x + pose[6] * y + pose[10] * z + pose[14]) * w;
  return [-100 * vx, -100 * vz, 100 * vy];                               // toRaw: raw cm
}

/**
 * Emit one posed model's submeshes as `usemtl` / `v` / `vt` / `f` lines, returning the advanced pools.
 *
 * Shared by the reference-prop and imported-GLB bakes: both hold per-material submeshes of indexed triangles
 * with real UVs, and both stand in raw cm at a composed pose, so the ONLY thing that differs is where the
 * material slot comes from (a source level's MaterialID vs. an imported record's tile ref). Keeping the
 * transform and the index bookkeeping in one place means a fix to either cannot land in just one of them.
 */
function emitPosedSubs<S extends GeomSub>(lines: string[], group: BakedPropGroup,
                                          subs: readonly S[], pose: Mat4,
                                          slotOf: (sub: S) => number, scrollIdx: number | null,
                                          vBase: number, vtBase: number,
                                          objectOf?: (sub: S) => number | null): { vBase: number; vtBase: number } {
  for (const sub of subs) {
    const slot = slotOf(sub);
    const scr = slot >= 0 ? scrollIdx : null;   // an untextured submesh has no tile to scroll
    // A model whose geometry MOVES splits into more than one native model object, and which object a
    // submesh belongs to is orthogonal to which material it wears — a spinning fan and the housing around
    // it can share one atlas page. So the object rides its own tag rather than being inferred from the
    // material, in the same `usemtl` dialect the scroll variant already uses.
    const obj = objectOf?.(sub) ?? null;
    const material = `${slot >= 0 ? `mat_${slot}${scr !== null ? `_scr${scr}` : ''}` : 'mat_untextured'}`
      + (obj !== null ? `_obj${obj}` : '');
    lines.push(`usemtl ${material}`);
    const positions: number[] = [];
    for (let k = 0; k < sub.positions.length; k += 3) {
      const [rx, ry, rz] = posedRawPoint(pose, sub.positions[k], sub.positions[k + 1], sub.positions[k + 2]);
      positions.push(rx, ry, rz);
      lines.push(`v ${rx.toFixed(3)} ${ry.toFixed(3)} ${rz.toFixed(3)}`);
    }
    for (let k = 0; k < sub.uvs.length; k += 2) lines.push(`vt ${sub.uvs[k].toFixed(6)} ${sub.uvs[k + 1].toFixed(6)}`);
    for (let k = 0; k < sub.indices.length; k += 3) {
      const a = sub.indices[k], b = sub.indices[k + 1], c = sub.indices[k + 2];
      lines.push(`f ${vBase + a + 1}/${vtBase + a + 1} ${vBase + b + 1}/${vtBase + b + 1} ${vBase + c + 1}/${vtBase + c + 1}`);
    }
    appendBakedSub(group, {
      material, slot, object: obj ?? 0, positions,
      uvs: Array.from(sub.uvs), indices: Array.from(sub.indices),
    });
    vBase += sub.positions.length / 3;
    vtBase += sub.uvs.length / 2;
  }
  return { vBase, vtBase };
}

// ---- the bakes ----------------------------------------------------------------------------------------

/** Placement stable id → the `o <group>` names it baked as (a group placement bakes one per member). The ISO
 *  packer joins Effects.json attachments to packed instances through these names (docs/026). */
export type BakedGroups = Record<string, string[]>;

/** One material/object draw in a SlopeSmith-authored prop model. Positions are the exact raw-centimetre
 * world-space values written to Props.obj; canonical export localizes them once into Meshes/*.obj while it
 * still has the placement metadata that produced them. */
export interface BakedPropSubmesh {
  material: string;
  slot: number;
  object: number;
  positions: number[];
  uvs: number[];
  indices: number[];
}

/** One authored placement/model in native model order. This is the structured counterpart of an `o` block
 * in Props.obj; it prevents a later tool from having to recover model identity from OBJ names. */
export interface BakedPropGroup {
  name: string;
  subs: BakedPropSubmesh[];
  /** Raw-space pivot this group declares for itself, when no authored placement supplies one: the canonical
   *  instance carries it as `Location` and the mesh localizes against it. The staging markers use this —
   *  their entire content IS where they sit, so an instance at the origin would say nothing. */
  origin?: number[];
}

/** Match native's one draw per (material alias, model object). Several source submeshes may share that draw;
 * append their local pools without welding so authored hard edges and UV seams remain intact. */
export function appendBakedSub(group: BakedPropGroup, sub: BakedPropSubmesh): void {
  const target = group.subs.find(item => item.material === sub.material && item.slot === sub.slot
    && item.object === sub.object);
  if (!target) {
    group.subs.push({ ...sub, positions: [...sub.positions], uvs: [...sub.uvs], indices: [...sub.indices] });
    return;
  }
  const vertexBase = target.positions.length / 3;
  target.positions.push(...sub.positions);
  target.uvs.push(...sub.uvs);
  target.indices.push(...sub.indices.map(index => vertexBase + index));
}

/**
 * The model→world-raw similarity a placement's geometry was baked through: `world = origin + scale·(rot·v)`.
 *
 * Read back off the SAME `posedRawPoint` map the `v` lines take — the model origin plus the images of its
 * three unit axes — rather than re-derived from the angles and scale, so a clip and the vertices it moves cannot
 * land in different frames. The packer needs it because a clip is authored in MODEL space while the packed
 * model stands in the instance's local space, and only the packer knows the second half of that change (an
 * effect host's pivot, or an explicit collision profile's full transform).
 */
export interface BakedPropPose {
  /** The model origin in world raw cm. */
  origin: number[];
  /** Unit quaternion (x, y, z, w) taking model axes onto world raw axes. */
  rotation: number[];
  /** Uniform scale. */
  scale: number;
}

/**
 * One native model object of a baked clip — a `PropModelAnimationObject` verbatim, in MODEL-LOCAL raw cm.
 *
 * `channels` is X/Y/Z translation then X/Y/Z rotation, each a list of `[a, b, c, d, startSec, endSec]`
 * cubics evaluated by Horner (cm for a translation, DEGREES for a rotation), or null when that component
 * simply keeps its base value. An object carrying any channel also carries `basePosition`/`baseEuler`: the
 * engine builds an animated object's local pose from the base plus its channels and does not consult the
 * rest transform, which is why the two are shipped separately rather than one being derived from the other.
 */
export interface BakedPropClipObject {
  /** Index into `objects`, or -1 for the root. Always less than this object's own index. */
  parent: number;
  restPosition: number[];
  restRotation: number[];
  restScale: number[];
  basePosition?: number[];
  /** Degrees, applied ZXY. */
  baseEuler?: number[];
  channels?: (number[][] | null)[];
}

/**
 * Placement stable id → the model clip its baked geometry moves under, joined to packed instances through
 * the same `bakedGroups` names every other authored join uses.
 *
 * The clip travels as the object hierarchy VERBATIM — the same one the editor previews and an extracted
 * level's `ModelObjects` decode to — rather than as a summary of it, so the packer transliterates instead of
 * reconstructing. Object 0 is an unanimated identity ROOT holding the model's static geometry, which is what
 * lets `_obj0` mean "the part that does not move"; every submesh's `_obj<k>` tag is an index into `objects`.
 * The native PAL ceiling is 27 total objects. The exporter normally keeps this exact object count (including
 * the root); only a moving host whose placement frame cannot live on its instance needs a mesh-less mount.
 * [Trailmap: 120-objects].
 */
export interface BakedPropClip {
  /** Native clip length in 30 fps frames. */
  clipFrames: number;
  pose: BakedPropPose;
  objects: BakedPropClipObject[];
}
export type BakedPropClips = Record<string, BakedPropClip>;

/** Unit quaternion (x, y, z, w) from an orthonormal basis given as `m[column][row]`. */
function quaternionFromColumns(m: number[][]): number[] {
  const m11 = m[0][0], m12 = m[1][0], m13 = m[2][0];
  const m21 = m[0][1], m22 = m[1][1], m23 = m[2][1];
  const m31 = m[0][2], m32 = m[1][2], m33 = m[2][2];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** The placement pose expressed as the similarity the packer changes frame with, measured through the very
 *  map the vertices took. `placementMatrix` composes a rotation and a uniform scale either side of a mirror, so
 *  the linear part is always an orthogonal basis times one scale — the shape a native rest matrix holds. */
export function placementSimilarity(pose: Mat4): BakedPropPose {
  const origin = posedRawPoint(pose, 0, 0, 0);
  const columns = [posedRawPoint(pose, 1, 0, 0), posedRawPoint(pose, 0, 1, 0), posedRawPoint(pose, 0, 0, 1)]
    .map(tip => [tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]]);
  const scale = Math.hypot(...columns[0]);
  const basis = columns.map(column => {
    const length = Math.hypot(...column) || 1;
    return column.map(v => v / length);
  });
  return { origin, rotation: quaternionFromColumns(basis), scale: scale > 0 ? scale : 1 };
}

/**
 * A model's clip in the shape the packer contracts to receive, plus the `_obj<k>` tag each submesh takes.
 *
 * The only reshaping is the guaranteed root. A clip built from declared spins already starts with an
 * unanimated identity object, but one recovered from an extracted level need not, so a clip that does not
 * gets one prepended and every index — parents and submesh tags alike — shifts with it. That keeps one
 * statement true for the packer whatever the clip came from: object 0 holds the geometry that stays put.
 */
export function bakedPropClip(animation: PropModelAnimation, pose: Mat4):
{ clip: BakedPropClip; tagOf: (object: number | undefined) => number } | null {
  if (!animation.objects.length || !(animation.clipFrames > 0)) return null;
  const identityRoot = propModelAnimationHasIdentityRoot(animation);
  const shift = identityRoot ? 0 : 1;
  const source: PropModelAnimationObject[] = identityRoot ? animation.objects
    : [{ parent: -1, restPosition: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1] },
      ...animation.objects];
  const objects: BakedPropClipObject[] = source.map((object, index) => {
    const moving = object.channels?.some(curve => !!curve?.length) ?? false;
    return {
      // Index 0 is the root; anything else that named no parent hangs off it, so the packed model is one
      // tree rather than a forest the engine would have to guess a draw order for.
      parent: index === 0 ? -1 : object.parent < 0 ? 0 : object.parent + shift,
      restPosition: [...object.restPosition],
      restRotation: [...object.restRotation],
      restScale: [...object.restScale],
      ...(moving ? {
        basePosition: [...(object.basePosition ?? object.restPosition)],
        ...(object.baseEuler ? { baseEuler: [...object.baseEuler] } : {}),
        channels: object.channels!.map(curve => curve?.length ? curve.map(segment => [...segment]) : null),
      } : {}),
    };
  });
  return {
    clip: { clipFrames: animation.clipFrames, pose: placementSimilarity(pose), objects },
    tagOf: object => object === undefined ? 0 : object + shift,
  };
}

/**
 * Bake a set of placed props so they IMPORT TEXTURED (docs/012).
 *
 * Geometry: each prop's model submeshes are transformed to raw SSX space (cm) at its authored pose — the
 * client renders `compose(pos, rotation, scale) · RAW_TO_EDITOR · vert` under worldRoot, so the raw vert is
 * `toRaw(that)`, and `toRaw(RAW_TO_EDITOR·v) = v`, so an identity placement bakes the model verbatim. UVs are
 * the model's own OBJ `vt`, emitted as-is (the same the shipped Props.obj carries).
 *
 * Materials: resolved through the shared MaterialCombiner — `usemtl mat_<id>` slots into one combined
 * Materials.json, exactly what the bundler resolves (MaterialBundle: mat_<id> → Materials[id].TexturePath →
 * a PNG in Textures/). Native TextureFlipbook frame lists and every referenced PNG are preserved, allowing
 * an attached texture-flip graph to survive through repackaging. A submesh whose material has no texture
 * emits `mat_untextured`, like the start gate.
 *
 * `scrollIndexOf` = the Scroll.json speed index for a prop carrying an authored UV-scroll effect, or null.
 * A scrolled prop's textured submeshes emit the shipped levels' scroll-variant tag (`mat_<id>_scr<k>`), the
 * dialect MaterialBundle already resolves into a per-material scroll speed (docs/008).
 */
export function bakePlacedProps(props: readonly PlacedProp[], geometryOf: GeometryLookup,
                                combiner: MaterialCombiner, vertexOffset = 0, uvOffset = 0,
                                scrollIndexOf?: (prop: PlacedProp) => number | null):
                                { obj: string; bakedGroups: BakedGroups; groups: BakedPropGroup[] } {
  const bakedGroups: BakedGroups = {};
  const groups: BakedPropGroup[] = [];
  if (!props.length) return { obj: '', bakedGroups, groups };

  const lines: string[] = ['# Slopesmith placed props'];
  let vBase = vertexOffset;
  let vtBase = uvOffset;
  props.forEach((p, i) => {
    const mg = geometryOf(p.level, p.model);
    if (!mg) return;
    // The group prefix supplies the default collision response: Prop_ is solid and PropGhost_ is non-solid.
    // A joined exact profile overrides that default on the canonical instance.
    const groupName = `${placedPropSolid(p) ? 'Prop' : 'PropGhost'}_${i}_${safeDataName(p.name)}`;
    if (p.id) (bakedGroups[p.id] ??= []).push(groupName);
    lines.push(`o ${groupName}`);
    const group: BakedPropGroup = { name: groupName, subs: [] };
    ({ vBase, vtBase } = emitPosedSubs(lines, group, mg.subs, placementMatrix(p),
      sub => combiner.resolveSlot(p.level, sub.mat), scrollIndexOf?.(p) ?? null, vBase, vtBase));
    if (group.subs.length) groups.push(group);
  });
  if (lines.length <= 1) return { obj: '', bakedGroups, groups };
  return { obj: '\n' + lines.join('\n') + '\n', bakedGroups, groups };
}

/** Bake Effects-authored trigger volumes as centred world-space boxes. Their `EffectTrigger_` group name is
 *  the packer contract: the model supplies the native mode-3 contact bounds, while canonical export keeps its
 *  instance invisible and stamps the attached collision slot through `bakedGroups`. */
export function bakeEffectTriggerProps(placements: readonly PlacedProp[], vertexOffset = 0): {
  obj: string; baked: number; bakedGroups: BakedGroups; groups: BakedPropGroup[];
} {
  const triggers = placements.filter(isEffectTriggerProp);
  const bakedGroups: BakedGroups = {};
  const groups: BakedPropGroup[] = [];
  if (!triggers.length) return { obj: '', baked: 0, bakedGroups, groups };
  const lines = ['# Slopesmith effect trigger volumes'];
  let vBase = vertexOffset;
  const faces = [
    [0, 2, 1], [0, 3, 2], // -Z
    [4, 5, 6], [4, 6, 7], // +Z
    [0, 1, 5], [0, 5, 4], // -Y
    [3, 7, 6], [3, 6, 2], // +Y
    [0, 4, 7], [0, 7, 3], // -X
    [1, 2, 6], [1, 6, 5], // +X
  ] as const;
  triggers.forEach((prop, index) => {
    const size = effectTriggerWorldSize(prop);
    const hx = size[0] / 2, hy = size[1] / 2, hz = size[2] / 2;
    const local: V3[] = [
      [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
      [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const groupName = `EffectTrigger_${index}_${safeDataName(prop.name) || 'Trigger'}`;
    if (prop.id) (bakedGroups[prop.id] ??= []).push(groupName);
    lines.push(`o ${groupName}`, 'usemtl mat_untextured');
    const positions: number[] = [];
    for (const corner of local) {
      const [rx, ry, rz] = rotateByPlacement(corner, prop);
      const wx = prop.pos[0] + rx;
      const wy = prop.pos[1] + ry;
      const wz = prop.pos[2] + rz;
      positions.push(-100 * wx, -100 * wz, 100 * wy);
      lines.push(`v ${(-100 * wx).toFixed(3)} ${(-100 * wz).toFixed(3)} ${(100 * wy).toFixed(3)}`);
    }
    for (const [a, b, c] of faces) lines.push(`f ${vBase + a + 1} ${vBase + b + 1} ${vBase + c + 1}`);
    groups.push({ name: groupName, subs: [{
      material: 'mat_untextured', slot: -1, object: 0, positions, uvs: [], indices: faces.flat(),
    }] });
    vBase += 8;
  });
  return { obj: '\n' + lines.join('\n') + '\n', baked: triggers.length, bakedGroups, groups };
}

/**
 * Bake AUTHORED-MODEL placements ('@models' level): each placement's polygon quads at its pose, per-quad
 * full-tile UVs at the model's tile orientation (wrap-continuous — the scroll-safe form the model preview
 * renders, through the `tiledPropUV` both bakes share), and the model's tile
 * resolved through the shared combiner's tile slot (alpha flag inherited from the tile's source level). A
 * placement carrying an authored UV-scroll attachment emits the `mat_<slot>_scr<k>` tag, exactly like a
 * scrolled reference-prop placement. Geometry: editor w = pos + R(scale·(v − anchor)), emitted raw like
 * every other bake; triangles are the same two-per-quad diagonal the viewport instances.
 */
export function bakeAuthoredModelProps(placements: readonly PlacedProp[], models: readonly AuthoredModel[],
  vertexOffset: number, uvOffset: number, combiner: MaterialCombiner,
  scrollIndexOf?: (prop: PlacedProp) => number | null):
  { obj: string; baked: number; bakedGroups: BakedGroups; groups: BakedPropGroup[]; warnings: string[] } {
  const lines: string[] = ['# Slopesmith authored models'];
  const bakedGroups: BakedGroups = {};
  const groups: BakedPropGroup[] = [];
  const warnings: string[] = [];
  let vBase = vertexOffset, vtBase = uvOffset, baked = 0;
  placements.forEach((pp, i) => {
    const model = models.find(m => modelNumber(m.id) === pp.model);
    if (!model?.quads.length) return;
    // Frames go bare because a state list resolves against the bank the tile already named, which is what
    // the combiner queues its copies from.
    const slot = model.texture
      ? combiner.resolveTileSlot(model.texture,
        authoredModelFrames(model).map(ref => ref.slice(ref.indexOf('/') + 1)), model.blend === true)
      : -1;
    const scr = slot >= 0 ? scrollIndexOf?.(pp) ?? null : null;
    // ModelSolid_ opts the placement into a baked collision mesh (the RailSolid_ convention — Snowknife's
    // canonical collision policy keys off the prefix); plain Model_ bakes a ghost.
    const groupName = `${placedPropSolid(pp) ? 'ModelSolid' : 'Model'}_${i}_${safeDataName(model.name) || 'Model'}`;
    if (pp.id) (bakedGroups[pp.id] ??= []).push(groupName);
    lines.push(`o ${groupName}`);
    const material = slot >= 0 ? `mat_${slot}${scr !== null ? `_scr${scr}` : ''}` : 'mat_untextured';
    lines.push(`usemtl ${material}`);
    const group: BakedPropGroup = { name: groupName, subs: [] };
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
    // Net face normal in raw space, accumulated over the emitted triangles: the PS2 lights props with
    // per-instance directional keys clamped against the mesh normal, so a sheet whose parametric front
    // (∂u×∂v — the ridable side, the side the bake winds toward) faces DOWN renders ambient-only (near
    // black). The double-sided viewport hides that; warn here where the consequence starts.
    let nnx = 0, nny = 0, nnz = 0;
    const world = (vid: number): [number, number, number] => {
      const local: V3 = [
        (model.vertices[vid * 3] - model.anchor[0]) * pp.scale,
        (model.vertices[vid * 3 + 1] - model.anchor[1]) * pp.scale,
        (model.vertices[vid * 3 + 2] - model.anchor[2]) * pp.scale,
      ];
      const r = rotateByPlacement(local, pp);
      return [pp.pos[0] + r[0], pp.pos[1] + r[1], pp.pos[2] + r[2]];
    };
    for (const quad of model.quads) {
      const wedge = quad[2] === quad[3];
      const corners = wedge ? 3 : 4;
      const raw: [number, number, number][] = [];
      for (let s = 0; s < corners; s++) {
        const [wx, wy, wz] = world(quad[s]);
        raw.push([-100 * wx, -100 * wz, 100 * wy]);
        positions.push(-100 * wx, -100 * wz, 100 * wy);
        lines.push(`v ${(-100 * wx).toFixed(3)} ${(-100 * wz).toFixed(3)} ${(100 * wy).toFixed(3)}`); // toRaw: raw cm
        const [u, v] = tiledPropUV(s, wedge, model.orient); // the full 0–1 rect, turned through the model's D4
        uvs.push(u, v);
        lines.push(`vt ${u.toFixed(6)} ${v.toFixed(6)}`);
      }
      const f = (a: number, b: number, c: number) => {
        const base = positions.length / 3 - corners;
        indices.push(base + a, base + b, base + c);
        lines.push(`f ${vBase + a + 1}/${vtBase + a + 1} ${vBase + b + 1}/${vtBase + b + 1} ${vBase + c + 1}/${vtBase + c + 1}`);
        const [A, B, C] = [raw[a], raw[b], raw[c]];
        const [ux, uy, uz] = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
        const [wx, wy, wz] = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        nnx += uy * wz - uz * wy; nny += uz * wx - ux * wz; nnz += ux * wy - uy * wx;
      };
      if (wedge) f(0, 2, 1); else { f(0, 2, 3); f(0, 3, 1); }
      vBase += corners; vtBase += corners;
    }
    // The game lights a sheet ONCE from its vertex normals and shows that same shading from either side
    // (no cull, no per-side re-light), so down-facing normals mean ambient-only dark from EVERY view.
    const nlen = Math.hypot(nnx, nny, nnz);
    if (nlen > 0 && nnz < -0.5 * nlen)
      warnings.push(`model "${model.name}" placement ${groupName} bakes mostly FRONT-DOWN (net normal `
        + `${(nnz / nlen).toFixed(2)} of straight down) — on PS2 it will render near-black (lit by ambient only). `
        + `If unintended: edit the model, select its patches, and use flip (ridable side reversed), then re-export.`);
    appendBakedSub(group, { material, slot, object: 0, positions, uvs, indices });
    groups.push(group);
    baked++;
  });
  return { obj: baked ? '\n' + lines.join('\n') + '\n' : '', baked, bakedGroups, groups, warnings };
}

/**
 * Bake IMPORTED-GLB placements ('@import' level, docs/032).
 *
 * This is the shortest of the three prop bakes, because an imported model is already in the shape the export
 * wants: `decodeProps` hands back per-material submeshes of indexed triangles in raw cm, model-local — the
 * same thing a source level's parsed `Meshes/` produces for a reference prop. So geometry goes out through
 * the shared `emitPosedSubs` with no conversion at all, and the only real difference is where a material
 * comes from.
 *
 * Materials resolve through the combiner's TILE slot rather than a source level's MaterialID: an imported
 * material's texture is a "Custom/<name>.png" ref into the mountain-local authored bank (docs/005), which is exactly
 * the ref form `resolveTileSlot` already takes for authored models. So the tile copies into Textures/,
 * inherits its alpha-blend flag, and counts against the custom-page VRAM budget with no new staging path.
 *
 * The `catalogue` is passed in rather than fetched here, so this stays a pure transform over data the caller
 * already holds — the bake is driven from one read of the imported-prop library rather than one per model.
 *
 * Grouping follows the AUTHORED-MODEL convention, not the reference-prop one — `Import_<i>` bakes a ghost and
 * `ImportSolid_<i>` opts into a collision mesh. An imported GLB is arbitrary user geometry, so forcing every
 * one solid (as `Prop_*` does) would wrap decorative art in walls the rider cannot pass. Distinct prefixes
 * rather than reusing `Model_`: both bakes number from 0, so sharing a prefix could collide on group names,
 * and those names are the join the ISO packer compiles effect attachments through (docs/026).
 */
export function bakeImportedProps(placements: readonly PlacedProp[], catalogue: LevelProps,
  vertexOffset: number, uvOffset: number, combiner: MaterialCombiner,
  scrollIndexOf?: (prop: PlacedProp) => number | null):
  { obj: string; baked: number; tris: number; bakedGroups: BakedGroups; propClips: BakedPropClips;
    groups: BakedPropGroup[]; warnings: string[] } {
  const lines: string[] = ['# Slopesmith imported models'];
  const bakedGroups: BakedGroups = {};
  const propClips: BakedPropClips = {};
  const groups: BakedPropGroup[] = [];
  const warnings: string[] = [];
  let vBase = vertexOffset, vtBase = uvOffset, baked = 0, tris = 0;
  const missing = new Set<string>();
  placements.forEach((pp, i) => {
    const model = catalogue.models.find(mo => mo.id === pp.model);
    // The record was deleted from the Custom catalogue while its placements stayed in the document. Name it:
    // a prop the user placed and can still see in the editor would otherwise just not be in the level.
    if (!model?.subs.length) { missing.add(pp.name || `model ${pp.model}`); return; }
    const groupName = `${placedPropSolid(pp) ? 'ImportSolid' : 'Import'}_${i}_${safeDataName(model.name) || 'Import'}`;
    if (pp.id) (bakedGroups[pp.id] ??= []).push(groupName);
    lines.push(`o ${groupName}`);
    const group: BakedPropGroup = { name: groupName, subs: [] };
    const pose = placementMatrix(pp);
    // A model that MOVES ships its object hierarchy alongside the geometry, and each submesh carries the
    // `_obj<k>` tag naming which object of that hierarchy owns it. The clip stays in model space and the
    // pose says where the model was put, because the packer alone knows the rest of the trip into the
    // packed instance's frame — and it applies the same change to the clip that it applies to a vertex.
    const motion = model.animation ? bakedPropClip(model.animation, pose) : null;
    if (motion && pp.id) propClips[pp.id] = motion.clip;
    ({ vBase, vtBase } = emitPosedSubs(lines, group, model.subs, pose,
      sub => {
        const material = catalogue.materials.get(sub.mat);
        return material?.tex
          ? combiner.resolveTileSlot(material.tex, material.frames, material.blend, material.alphaMode) : -1;
      }, scrollIndexOf?.(pp) ?? null, vBase, vtBase,
      motion ? sub => motion.tagOf(sub.object) : undefined));
    if (group.subs.length) groups.push(group);
    for (const sub of model.subs) tris += sub.indices.length / 3;
    baked++;
  });
  if (missing.size)
    warnings.push(`${missing.size} imported model(s) placed in the document are no longer in the Custom `
      + `catalogue (${[...missing].slice(0, 4).join(', ')}${missing.size > 4 ? ', …' : ''}) — their placements `
      + 'did not bake. Re-import the GLB under the same name to restore them, or delete the placements.');
  return { obj: baked ? '\n' + lines.join('\n') + '\n' : '', baked, tris, bakedGroups, propClips, groups, warnings };
}

/**
 * Bake the authored rails' VISUAL tubes (docs/014): each rail's grind curve swept into the same low-poly tube
 * the viewport previews (core/rails/rail-mesh — one sweep, so what you see is what ships), skinned with the
 * donor's own rail material. Wood-style rails emit untextured (they read as clay, like the start gate). The
 * tube is decoration — the ridable grind is Splines.json.
 *
 * Which is why a rail can decline one. A motion path never had a tube, and a BARE grind rail is a rail that
 * ships its spline and leaves the drawing to whatever prop it was laid over; both fall out here and both
 * still write their `Splines.json` row, since that row is the other, unrelated record (docs/014).
 *
 * Group prefixes carry the rail options to the packers: a `solid` rail's tube bakes as `RailSolid_<i>` (the
 * ISO repack gives it its mesh as a collider — the solid-tube configuration) instead of the ghost
 * `Rail_<i>`; a `supports` rail also bakes one `RailSupport_<i>` group of untextured posts under its node
 * points (core/rails/rail-mesh railSupportPosts — the same posts the viewport previews), always packed solid
 * like the shipped levels' rail supports.
 */
export function bakeRailTubes(rails: readonly Rail[], vertexOffset: number, uvOffset: number,
                              combiner: MaterialCombiner, skin: { level: string; material: number | null }):
                              { obj: string; tubes: number; posts: number; groups: BakedPropGroup[] } {
  if (!rails.some(railHasTube)) return { obj: '', tubes: 0, posts: 0, groups: [] };
  const skinSlot = skin.material !== null ? combiner.resolveSlot(skin.level, skin.material) : -1;
  const lines: string[] = ['# Slopesmith rail tubes'];
  let vBase = vertexOffset;
  let vtBase = uvOffset;
  let tubes = 0;
  let posts = 0;
  const groups: BakedPropGroup[] = [];
  rails.forEach((rail, i) => {
    if (!railHasTube(rail)) return; // a motion path or a bare rail is spline data with nothing to draw
    const swept = sweepRail(rail);
    if (!swept) return; // a half-drawn rail ships no tube, mirroring its empty spline
    const slot = railStyle(rail) === RAIL_STYLE_WOOD ? -1 : skinSlot;
    const groupName = `${rail.solid ? 'RailSolid' : 'Rail'}_${i}_${safeDataName(rail.name || 'Rail')}`;
    const material = slot >= 0 ? `mat_${slot}` : 'mat_untextured';
    lines.push(`o ${groupName}`);
    lines.push(`usemtl ${material}`);
    const positions: number[] = [];
    for (let k = 0; k < swept.positions.length; k += 3) {
      const x = swept.positions[k], y = swept.positions[k + 1], z = swept.positions[k + 2];
      positions.push(-100 * x, -100 * z, 100 * y);
      lines.push(`v ${(-100 * x).toFixed(3)} ${(-100 * z).toFixed(3)} ${(100 * y).toFixed(3)}`); // toRaw: editor m → raw cm
    }
    groups.push({ name: groupName, subs: [{ material, slot, object: 0, positions,
      uvs: Array.from(swept.uvs), indices: Array.from(swept.indices) }] });
    for (let k = 0; k < swept.uvs.length; k += 2) lines.push(`vt ${swept.uvs[k].toFixed(6)} ${swept.uvs[k + 1].toFixed(6)}`);
    for (let k = 0; k < swept.indices.length; k += 3) {
      const a = swept.indices[k], b = swept.indices[k + 1], c = swept.indices[k + 2];
      lines.push(`f ${vBase + a + 1}/${vtBase + a + 1} ${vBase + b + 1}/${vtBase + b + 1} ${vBase + c + 1}/${vtBase + c + 1}`);
    }
    vBase += swept.positions.length / 3;
    vtBase += swept.uvs.length / 2;
    tubes++;
    if (rail.supports) {
      const sp = railSupportPosts(rail);
      if (sp) {
        const supportName = `RailSupport_${i}_${safeDataName(rail.name || 'Rail')}`;
        lines.push(`o ${supportName}`);
        lines.push('usemtl mat_untextured');
        const positions: number[] = [];
        for (let k = 0; k < sp.positions.length; k += 3) {
          const x = sp.positions[k], y = sp.positions[k + 1], z = sp.positions[k + 2];
          positions.push(-100 * x, -100 * z, 100 * y);
          lines.push(`v ${(-100 * x).toFixed(3)} ${(-100 * z).toFixed(3)} ${(100 * y).toFixed(3)}`); // toRaw: editor m → raw cm
        }
        groups.push({ name: supportName, subs: [{ material: 'mat_untextured', slot: -1, object: 0,
          positions, uvs: [], indices: Array.from(sp.indices) }] });
        for (let k = 0; k < sp.indices.length; k += 3) { // untextured: position-only faces, like the start gate
          lines.push(`f ${vBase + sp.indices[k] + 1} ${vBase + sp.indices[k + 1] + 1} ${vBase + sp.indices[k + 2] + 1}`);
        }
        vBase += sp.positions.length / 3;
        posts += rail.nodes.length;
      }
    }
  });
  if (!tubes) return { obj: '', tubes: 0, posts: 0, groups: [] };
  return { obj: '\n' + lines.join('\n') + '\n', tubes, posts, groups };
}

/**
 * `GemModels.obj`: the donor's three tier crystals (Gem_TrickMultiplier_YellowX2 / OrangeX3 / RedX5 — the
 * SAME base mesh at three scales with flat colour tiles) as one `o GemTier<2|3|5>` group each, verts passed
 * through UNTRANSFORMED (the meshes are already model-local raw), materials through the shared combiner.
 * snowknife bakes this into per-tier gems.glb nodes the Unity importer instantiates for each authored gem —
 * the native-model half of the Gems.json channel (the ISO packer clones the same shipped models; docs/014).
 * Null when the donor carries no gem models (the importer falls back to its synthesized crystal).
 */
export function bakeGemModels(tiers: readonly { tier: number; model: number }[], level: string,
                              geometryOf: GeometryLookup, combiner: MaterialCombiner):
                              { obj: string; tiers: number[] } | null {
  if (!tiers.length) return null;
  const lines: string[] = ['# Slopesmith gem tier models (model-local raw verts)'];
  let vBase = 0, vtBase = 0;
  const baked: number[] = [];
  for (const { tier, model } of [...tiers].sort((a, b) => a.tier - b.tier)) {
    const mg = geometryOf(level, model);
    if (!mg) continue;
    lines.push(`o GemTier${tier}`);
    for (const sub of mg.subs) {
      const slot = combiner.resolveSlot(level, sub.mat);
      lines.push(`usemtl ${slot >= 0 ? `mat_${slot}` : 'mat_untextured'}`);
      for (let k = 0; k < sub.positions.length; k += 3) {
        lines.push(`v ${sub.positions[k].toFixed(3)} ${sub.positions[k + 1].toFixed(3)} ${sub.positions[k + 2].toFixed(3)}`);
      }
      for (let k = 0; k < sub.uvs.length; k += 2) lines.push(`vt ${sub.uvs[k].toFixed(6)} ${sub.uvs[k + 1].toFixed(6)}`);
      for (let k = 0; k < sub.indices.length; k += 3) {
        const a = sub.indices[k], b = sub.indices[k + 1], c = sub.indices[k + 2];
        lines.push(`f ${vBase + a + 1}/${vtBase + a + 1} ${vBase + b + 1}/${vtBase + b + 1} ${vBase + c + 1}/${vtBase + c + 1}`);
      }
      vBase += sub.positions.length / 3;
      vtBase += sub.uvs.length / 2;
    }
    baked.push(tier);
  }
  if (!baked.length) return null;
  return { obj: lines.join('\n') + '\n', tiers: baked };
}
