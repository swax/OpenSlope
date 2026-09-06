/**
 * Shared machinery for Slopesmith's GENERATED built-in characters.
 *
 * A generated character is a table of numbers plus this file: the rider's skeleton, a handful of solid
 * builders, and one skinning/export path. `blocky-rider.ts`, `stick-figure.ts`, and `alpine-exo.ts` each
 * own a parts table and nothing else, so the figures cannot drift apart on the things that have to agree — where the joints
 * are, how a bone's bind frame is built, and what a valid GLB looks like.
 *
 * ## The one constraint that is not negotiable
 *
 * The runtime driver (app/ride/character-rig.ts) anchors Hips at the solver's landmark and then only ROTATES
 * the imported skeleton: every descendant keeps the bind offset it was authored with. A model's own segment
 * lengths therefore decide where its boots land, so the joint layout below is the procedural rider's own
 * anthropometry (app/ride/rider.ts: Winter's stature fractions on a 1.70 m rider) rather than whatever
 * proportions a given figure would like. Everything the driver never measures — plate thickness, helmet size,
 * boots, pauldrons — is free, and that is where a character's silhouette actually comes from.
 *
 * What the driver does NOT care about is bind ORIENTATION: `aim()` sets each driven bone's world rotation
 * outright from the solver's direction, and hands and feet retarget through their own bind frame. So a bind
 * A-pose costs nothing at ride time and buys a bulky figure the room to keep its arms out of its own hips.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  Bone, BufferGeometry, Color, Float32BufferAttribute, Group, Matrix3, Matrix4, MeshStandardMaterial,
  Quaternion, Skeleton, SkinnedMesh, Uint16BufferAttribute, Uint32BufferAttribute, Vector3,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { CHARACTER_UV_SCROLL_KEY } from '../../src/core/characters/contract';
import { checkCharacterGlb } from './check';
import { attachEmissiveTextures, type EmbeddedTexture } from './embed-texture';

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

/* ── Proportions ───────────────────────────────────────────────────────────────────────────────────────
 * Keep these in step with `app/ride/rider.ts` if that body is ever re-proportioned; the character checks pin
 * them, so a drift shows up as a failed test rather than as boots through the board.
 */
export const RIDER_H = 1.70;
export const THIGH = 0.245 * RIDER_H, SHIN = 0.246 * RIDER_H;
export const UPPER_ARM = 0.186 * RIDER_H, FOREARM = 0.146 * RIDER_H;
export const PELVIS_RISE = 0.051 * RIDER_H;         // sacral pivot above the femoral heads
export const LUMBAR = 0.192, THORACIC = 0.242;      // hips → upper back → clavicle root
export const HIPS_SEGMENT = 0.14;                   // the lower-spine bone the driver aims (docs/030)
export const SHOULDER_DROP = 0.075, NECK_LEN = 0.075, HEAD_BONE_TO_HELMET = 0.105;
export const HIP_HALF = 0.11, SHOULDER_HALF = 0.165;
/** Sole to ankle: the one leg number that is ours rather than the solver's. The ride seats the ankle joint
 *  14.4 cm above the board's base (14 mm deck + 18 mm binding pad + boot), so a boot this deep puts the sole
 *  on the binding rather than through the deck or hovering over it. All generated built-ins use it, so they
 *  stand at the same height on the board. */
export const ANKLE_RISE = 0.115;

export const ANKLE_Y = ANKLE_RISE;
export const KNEE_Y = ANKLE_Y + SHIN;
export const HIP_SOCKET_Y = KNEE_Y + THIGH;
export const HIPS_Y = HIP_SOCKET_Y + PELVIS_RISE;
export const SPINE_Y = HIPS_Y + HIPS_SEGMENT;
export const UPPER_BACK_Y = HIPS_Y + LUMBAR;
export const CLAVICLE_Y = HIPS_Y + LUMBAR + THORACIC;
export const SHOULDER_Y = CLAVICLE_Y - SHOULDER_DROP;
export const HEAD_BONE_Y = CLAVICLE_Y + NECK_LEN;
export const HELMET_Y = HEAD_BONE_Y + HEAD_BONE_TO_HELMET;
/** Elbow and wrist heights for arms hanging straight down. A figure with an A-pose bind reads its joints off
 *  `armChain()` instead, because those heights are no longer the whole story. */
export const ELBOW_Y = SHOULDER_Y - UPPER_ARM;
export const WRIST_Y = ELBOW_Y - FOREARM;

/* ── Skeleton ──────────────────────────────────────────────────────────────────────────────────────── */

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** Bind world position of the joint. */
  head: V3;
  /** Bind world position the bone's local +Y points at — its head-to-tail axis (docs/030). */
  tail: V3;
  /** World direction local +Z leans toward. Default is the character's facing, which is what the Mixamo
   *  importer rolls every bone but the feet toward, so the built-ins read the same way in Blender. */
  roll?: V3;
}

export const FORWARD: V3 = [0, 0, 1];
/** Feet keep the importer's mirrored boot roll: `Foot.L` local +X is sole-up, `Foot.R` local −X is
 *  (docs/030). The runtime retargets a foot through its own bind frame, so this is convention rather than
 *  arithmetic — but a hand-authored rig that disagrees with the imported ones is a trap for the next model. */
export const FOOT_ROLL_L: V3 = [1, 0, 0], FOOT_ROLL_R: V3 = [-1, 0, 0];

export interface ArmChain {
  shoulder: V3; elbow: V3; wrist: V3; fingertip: V3;
  /** Unit head-to-tail direction shared by all three arm bones. */
  direction: V3;
}
export interface LegChain { hip: V3; knee: V3; ankle: V3; toe: V3 }

/**
 * Where one arm's joints sit in bind. `spreadDegrees` swings the whole chain out from vertical about the
 * shoulder — a bind A-pose, which the driver overwrites at ride time and which exists purely so a wide
 * figure's forearms and gauntlets clear its own belt and thighs.
 */
export function armChain(side: 'L' | 'R', spreadDegrees = 0, handLength = 0.12): ArmChain {
  const x = side === 'L' ? 1 : -1;
  const angle = spreadDegrees * Math.PI / 180;
  const direction: V3 = [x * Math.sin(angle), -Math.cos(angle), 0];
  const step = (from: V3, distance: number): V3 => [
    from[0] + direction[0] * distance, from[1] + direction[1] * distance, from[2] + direction[2] * distance,
  ];
  const shoulder: V3 = [x * SHOULDER_HALF, SHOULDER_Y, 0];
  const elbow = step(shoulder, UPPER_ARM);
  const wrist = step(elbow, FOREARM);
  return { shoulder, elbow, wrist, fingertip: step(wrist, handLength), direction };
}

export function legChain(side: 'L' | 'R', footLength = 0.16): LegChain {
  const x = side === 'L' ? 1 : -1;
  return {
    hip: [x * HIP_HALF, HIP_SOCKET_Y, 0],
    knee: [x * HIP_HALF, KNEE_Y, 0],
    ankle: [x * HIP_HALF, ANKLE_Y, 0],
    toe: [x * HIP_HALF, ANKLE_Y, footLength],
  };
}

export interface RiderSkeletonOptions {
  /** Ankle to toe. Orientation is what the driver uses, so this is the boot's look, not its reach. */
  footLength?: number;
  /** Wrist to knuckles, likewise. */
  handLength?: number;
  /** Degrees the arms hang out from vertical in bind. */
  armSpread?: number;
  /** Finger chains for both hands. Omit for a mitten. */
  digits?: readonly DigitSpec[];
}

export type Digit = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

export interface DigitSpec {
  digit: Digit;
  /**
   * Where the digit starts, in the HAND BONE's own frame: +X is the way the palm faces, +Y runs down the
   * fingers toward the tip, +Z crosses the palm toward the thumb. Authoring in that frame rather than in
   * world is what lets one table serve both hands — the right hand's frame is the mirror of the left's, so
   * the same numbers land in the mirrored place without a second set.
   */
  base: V3;
  /** Direction the digit points, in the same frame. Normalized here. */
  direction: V3;
  /** Segment lengths, root to tip. */
  segments: readonly number[];
}

/**
 * Finger bone names are MIXAMO's, not this rig's.
 *
 * The runtime matches digits with `/^(left|right)hand(thumb|index|middle|ring|pinky)([1-4])$/` against a
 * punctuation-stripped name, and reads the hand's own palm frame from `…handmiddle1` and `…handthumb1`
 * (app/ride/character-rig.ts). That convention exists because imported Mixamo characters keep their source
 * finger names while their driven humanoid bones get renamed, so `Hand.L` and `LeftHandIndex1` sitting in
 * one skeleton is the contract rather than an inconsistency. A hand-authored rig that invents its own finger
 * names gets a hand that never closes, and nothing anywhere reports why.
 */
const DIGIT_LABEL: Record<Digit, string> = {
  thumb: 'Thumb', index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Pinky',
};

/** The chain of bones for one hand's digits, in the frame of the hand bone they hang from. */
export function fingerBones(hand: BoneSpec, side: 'L' | 'R', digits: readonly DigitSpec[]): BoneSpec[] {
  const frame = boneWorldMatrix(hand);
  const origin = new Vector3().setFromMatrixPosition(frame);
  const axes = [0, 1, 2].map(column => new Vector3().setFromMatrixColumn(frame, column));
  const toWorld = (local: Vector3): V3 => {
    const point = origin.clone();
    for (let axis = 0; axis < 3; axis++) point.addScaledVector(axes[axis], local.getComponent(axis));
    return [point.x, point.y, point.z];
  };
  // Local +X — the way the palm faces — as the roll for every digit. It is perpendicular to any sensible
  // finger direction, and it makes each segment's own local frame agree with the hand's, so a plate offset
  // "toward the back of the hand" means that on both hands without a second sign to get wrong.
  const roll: V3 = [axes[0].x, axes[0].y, axes[0].z];
  const prefix = side === 'L' ? 'LeftHand' : 'RightHand';
  const bones: BoneSpec[] = [];
  for (const spec of digits) {
    const direction = new Vector3(...spec.direction);
    if (direction.lengthSq() < 1e-12) throw new Error(`digit ${spec.digit} has no direction`);
    direction.normalize();
    const at = new Vector3(...spec.base);
    let parent = hand.name;
    spec.segments.forEach((length, index) => {
      const next = at.clone().addScaledVector(direction, length);
      const name = `${prefix}${DIGIT_LABEL[spec.digit]}${index + 1}`;
      bones.push({ name, parent, head: toWorld(at), tail: toWorld(next), roll });
      parent = name;
      at.copy(next);
    });
  }
  return bones;
}

/**
 * The canonical Slopesmith rig on the rider's own anthropometry. `.L` and `.R` are anatomical; the driver
 * decides at ride time which one lands on the front binding, so nothing here needs to know the stance.
 */
export function riderBones(options: RiderSkeletonOptions = {}): BoneSpec[] {
  const { footLength = 0.16, handLength = 0.12, armSpread = 0, digits } = options;
  const limbs = (side: 'L' | 'R'): BoneSpec[] => {
    const arm = armChain(side, armSpread, handLength);
    const leg = legChain(side, footLength);
    const hand: BoneSpec = { name: `Hand.${side}`, parent: `LowerArm.${side}`, head: arm.wrist, tail: arm.fingertip };
    return [
      { name: `Clavicle.${side}`, parent: 'Chest', head: [0, CLAVICLE_Y, 0], tail: arm.shoulder },
      { name: `UpperArm.${side}`, parent: `Clavicle.${side}`, head: arm.shoulder, tail: arm.elbow },
      { name: `LowerArm.${side}`, parent: `UpperArm.${side}`, head: arm.elbow, tail: arm.wrist },
      // With no finger hierarchy the driver reads a hand's local +Y as the fingers and local ±X as the palm.
      // Continuing the arm's own direction therefore hangs both palms toward the body, as hanging hands do —
      // and when there ARE fingers, it reads the palm from where the thumb and middle finger actually sit.
      hand,
      ...(digits ? fingerBones(hand, side, digits) : []),
      { name: `Pelvis.${side}`, parent: 'Hips', head: [0, HIPS_Y, 0], tail: leg.hip },
      { name: `UpperLeg.${side}`, parent: `Pelvis.${side}`, head: leg.hip, tail: leg.knee },
      { name: `LowerLeg.${side}`, parent: `UpperLeg.${side}`, head: leg.knee, tail: leg.ankle },
      {
        name: `Foot.${side}`, parent: `LowerLeg.${side}`, head: leg.ankle, tail: leg.toe,
        roll: side === 'L' ? FOOT_ROLL_L : FOOT_ROLL_R,
      },
    ];
  };
  return [
    { name: 'Hips', parent: null, head: [0, HIPS_Y, 0], tail: [0, SPINE_Y, 0] },
    { name: 'Spine', parent: 'Hips', head: [0, SPINE_Y, 0], tail: [0, UPPER_BACK_Y, 0] },
    { name: 'Chest', parent: 'Spine', head: [0, UPPER_BACK_Y, 0], tail: [0, CLAVICLE_Y, 0] },
    { name: 'Neck', parent: 'Chest', head: [0, CLAVICLE_Y, 0], tail: [0, HEAD_BONE_Y, 0] },
    { name: 'Head', parent: 'Neck', head: [0, HEAD_BONE_Y, 0], tail: [0, HELMET_Y, 0] },
    ...limbs('L'),
    ...limbs('R'),
  ];
}

/** Head-to-tail basis with a chosen roll, matching how the Mixamo importer normalizes a driven bone. */
export function boneWorldMatrix(spec: BoneSpec): Matrix4 {
  const head = new Vector3(...spec.head);
  const axisY = new Vector3(...spec.tail).sub(head);
  if (axisY.lengthSq() < 1e-10) throw new Error(`bone ${spec.name} has zero length`);
  axisY.normalize();
  const axisZ = new Vector3(...(spec.roll ?? FORWARD));
  axisZ.addScaledVector(axisY, -axisZ.dot(axisY));
  if (axisZ.lengthSq() < 1e-10) throw new Error(`bone ${spec.name} has a roll parallel to its own axis`);
  axisZ.normalize();
  const axisX = new Vector3().crossVectors(axisY, axisZ).normalize();
  axisZ.crossVectors(axisX, axisY).normalize();
  return new Matrix4().compose(
    head, new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(axisX, axisY, axisZ)), new Vector3(1, 1, 1),
  );
}

/* ── Solids ────────────────────────────────────────────────────────────────────────────────────────────
 * Every builder emits its own vertices per face, so shading is flat by construction and no builder has to
 * know what any other one produced. Concatenation at build time is an index offset and nothing else.
 *
 * WINDING. A face is wound counter-clockwise seen from OUTSIDE, which is the front face glTF and three both
 * assume; get it backwards and the solid renders inside out. Rings — profile polygons and the four corners
 * of a hexahedron's base — are ordered so that (p1 − p0) × (p2 − p1) points along the stacking axis, i.e.
 * toward the far end of the extrusion. `chamferProfile` and `box` are the worked examples.
 */

/**
 * A finished solid. `uvs` parameterize the surface in [0, 1]²: v runs from the START of a stack to its end —
 * a bone's head to its tail for `limb`, the first level to the last for `extrude`, the bottom to the top of
 * a box face — and u runs around the ring. A part maps that square into a texture through `FigurePart.tile`,
 * so the same solid can sample an atlas cell, a repeating strip, or nothing at all.
 */
export interface ShapeMesh { positions: number[]; normals: number[]; uvs: number[]; indices: number[] }

/** The six faces as (normal, u, v) with u × v = normal. */
const FACES: readonly { normal: V3; u: V3; v: V3 }[] = [
  { normal: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { normal: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { normal: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { normal: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/** An axis-aligned box, given as corners rather than centre and size: what has to be legible in a parts
 *  table is where a solid STOPS relative to the joint it crosses. */
export function box(min: V3, max: V3): ShapeMesh {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const face of FACES) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let axis = 0; axis < 3; axis++) {
        // normal, u and v are an axis-aligned orthonormal set, so exactly one of them decides each axis:
        // its sign picks the low or the high corner.
        const corner = face.normal[axis] + su * face.u[axis] + sv * face.v[axis];
        positions.push(corner > 0 ? max[axis] : min[axis]);
      }
      normals.push(...face.normal);
      uvs.push((su + 1) / 2, (sv + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

const COINCIDENT = 1e-7;
const samepoint = (a: V3, b: V3) =>
  Math.abs(a[0] - b[0]) < COINCIDENT && Math.abs(a[1] - b[1]) < COINCIDENT && Math.abs(a[2] - b[2]) < COINCIDENT;

/**
 * Append one convex, planar face. Repeated corners are dropped first, so a ring that collapses to a point
 * (a tapered tip, a closed cap) silently becomes a triangle or nothing at all instead of a sliver — which
 * matters because a degenerate triangle is a hole in the closed-solid check, not just wasted geometry.
 */
function pushFace(mesh: ShapeMesh, corners: readonly V3[], cornerUvs: readonly V2[]) {
  const ring: V3[] = [], ringUvs: V2[] = [];
  for (let i = 0; i < corners.length; i++) {
    if (ring.length && samepoint(ring[ring.length - 1], corners[i])) continue;
    ring.push(corners[i]);
    ringUvs.push(cornerUvs[i]);
  }
  while (ring.length > 1 && samepoint(ring[0], ring[ring.length - 1])) { ring.pop(); ringUvs.pop(); }
  if (ring.length < 3) return;
  // Newell's method: the area-weighted normal of a polygon, which follows the ring's own winding and stays
  // stable on the near-degenerate rings a taper produces.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-12) return;
  const base = mesh.positions.length / 3;
  for (let i = 0; i < ring.length; i++) {
    mesh.positions.push(ring[i][0], ring[i][1], ring[i][2]);
    mesh.normals.push(nx / length, ny / length, nz / length);
    mesh.uvs.push(ringUvs[i][0], ringUvs[i][1]);
  }
  for (let i = 2; i < ring.length; i++) mesh.indices.push(base, base + i - 1, base + i);
}

const empty = (): ShapeMesh => ({ positions: [], normals: [], uvs: [], indices: [] });

/**
 * Stack rings into a closed solid: side faces between neighbours, caps on the two ends.
 *
 * u follows the ring index and v the level, so a strip's pattern runs along its length whatever shape the
 * strip is. The caps take the v of the end they close, which keeps them continuous with the side they meet
 * rather than sampling somewhere unrelated in the atlas.
 */
function loft(rings: readonly V3[][], capStart = true, capEnd = true): ShapeMesh {
  const mesh = empty();
  const count = rings[0].length;
  for (const ring of rings) if (ring.length !== count) throw new Error('every ring needs the same corner count');
  const levels = Math.max(1, rings.length - 1);
  const around = (i: number): number => i / count;
  if (capStart) {
    const uv = capUvs(rings[0]);
    pushFace(mesh, [...rings[0]].reverse(), [...uv].reverse());
  }
  for (let level = 0; level + 1 < rings.length; level++) {
    const low = rings[level], high = rings[level + 1];
    const vLow = level / levels, vHigh = (level + 1) / levels;
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      pushFace(mesh, [low[i], low[next], high[next], high[i]],
        [[around(i), vLow], [around(i + 1), vLow], [around(i + 1), vHigh], [around(i), vHigh]]);
    }
  }
  const last = rings[rings.length - 1];
  if (capEnd) pushFace(mesh, last, capUvs(last));
  return mesh;
}

/**
 * Flatten an end ring onto its own two widest axes and normalize it into [0, 1]².
 *
 * The sides get (around, along), which is right for a strip but useless for a cap: every corner would land
 * on one horizontal line of the texture, so a lamp's round lens would sample a slice instead of a disc. A
 * cap is planar by construction, so projecting it is exact rather than an approximation.
 */
function capUvs(ring: readonly V3[]): V2[] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const corner of ring) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], corner[axis]);
      max[axis] = Math.max(max[axis], corner[axis]);
    }
  }
  const spans = [0, 1, 2].map(axis => max[axis] - min[axis]);
  const order = [0, 1, 2].sort((a, b) => spans[b] - spans[a]);
  // The two widest axes, kept in their natural order so a cap is not mirrored relative to its neighbours.
  const [u, v] = [order[0], order[1]].sort((a, b) => a - b);
  const fraction = (value: number, axis: number) => spans[axis] > 1e-9 ? (value - min[axis]) / spans[axis] : 0.5;
  return ring.map(corner => [fraction(corner[u], u), fraction(corner[v], v)] as V2);
}

/** Eight corners: base ring then top ring, each in the winding described above. Slanted plates, wedges and
 *  tapered blocks that no amount of scaling a box will produce. */
export function hexahedron(corners: readonly V3[]): ShapeMesh {
  if (corners.length !== 8) throw new Error('a hexahedron needs exactly eight corners');
  return loft([corners.slice(0, 4), corners.slice(4, 8)]);
}

/**
 * A unit rectangle in the local cross-section plane with its corners cut off — the profile nearly every
 * armour plate here is extruded from, because it keeps flat facets exactly at ±1 on both axes (so a table
 * can still say where a solid stops) while reading as a bevelled plate rather than as a box.
 *
 * `cut` is the fraction of the half-width each corner removes; 0 gives a plain rectangle.
 */
export function chamferProfile(cut = 0.3): V2[] {
  const c = Math.max(0, Math.min(1, cut));
  if (c <= 0) return [[-1, -1], [-1, 1], [1, 1], [1, -1]];
  return [
    [-1, -1 + c], [-1, 1 - c], [-1 + c, 1], [1 - c, 1], [1, 1 - c], [1, -1 + c], [1 - c, -1], [-1 + c, -1],
  ];
}

/** A regular polygon in the same winding — pistons, exhaust stacks, and anything meant to read as round. */
export function roundProfile(sides: number, phaseDegrees = 0): V2[] {
  const phase = phaseDegrees * Math.PI / 180;
  return Array.from({ length: sides }, (_, i) => {
    const angle = phase + (i / sides) * Math.PI * 2;
    return [Math.cos(angle), -Math.sin(angle)] as V2;
  });
}

export interface Level {
  y: number;
  /** Half-extents applied to the unit profile: one number for both axes, or [x, z]. */
  scale: number | V2;
  /** Centre of this ring in the cross-section plane. */
  offset?: V2;
  /** Use a different profile at this level. Must have the same corner count. */
  profile?: readonly V2[];
}

const pair = (value: number | V2): V2 => (typeof value === 'number' ? [value, value] : value);

/** Extrude a profile up the world Y axis through a series of levels. */
export function extrude(profile: readonly V2[], levels: readonly Level[],
                        options: { capBottom?: boolean; capTop?: boolean } = {}): ShapeMesh {
  if (levels.length < 2) throw new Error('an extrusion needs at least two levels');
  const rings = levels.map(level => {
    const [sx, sz] = pair(level.scale);
    const [ox, oz] = level.offset ?? [0, 0];
    return (level.profile ?? profile).map(([px, pz]): V3 => [ox + px * sx, level.y, oz + pz * sz]);
  });
  return loft(rings, options.capBottom ?? true, options.capTop ?? true);
}

export interface Section {
  /** Position along the bone: 0 is its head, 1 its tail. Values outside that range overhang the joint, which
   *  is how a rigidly skinned limb avoids opening a gap when it bends. */
  t: number;
  scale: number | V2;
  offset?: V2;
  profile?: readonly V2[];
}

/**
 * Extrude a profile along a bone rather than along world Y — the builder for anything that has to follow a
 * limb, and the reason an A-pose costs nothing to author. The cross-section plane is the bone's own local
 * X/Z, so `offset` moves a plate outboard or forward the way the bone will carry it.
 */
export function limb(head: V3, tail: V3, profile: readonly V2[], sections: readonly Section[],
                     roll: V3 = FORWARD): ShapeMesh {
  const origin = new Vector3(...head);
  const axisY = new Vector3(...tail).sub(origin);
  const length = axisY.length();
  if (length < 1e-9) throw new Error('a limb solid needs a non-zero bone');
  axisY.divideScalar(length);
  const axisZ = new Vector3(...roll);
  axisZ.addScaledVector(axisY, -axisZ.dot(axisY));
  if (axisZ.lengthSq() < 1e-10) throw new Error('a limb solid needs a roll off its own axis');
  axisZ.normalize();
  const axisX = new Vector3().crossVectors(axisY, axisZ).normalize();
  const rings = sections.map(section => {
    const [sx, sz] = pair(section.scale);
    const [ox, oz] = section.offset ?? [0, 0];
    return (section.profile ?? profile).map(([px, pz]): V3 => {
      const x = ox + px * sx, z = oz + pz * sz, y = section.t * length;
      return [
        origin.x + axisX.x * x + axisY.x * y + axisZ.x * z,
        origin.y + axisX.y * x + axisY.y * y + axisZ.y * z,
        origin.z + axisX.z * x + axisY.z * y + axisZ.z * z,
      ];
    });
  });
  return loft(rings);
}

export interface Placement {
  /** Point the rotations turn about. Defaults to the origin. */
  pivot?: V3;
  /** Degrees, applied X then Y then Z. Degrees because a parts table is read, not evaluated. */
  rotateX?: number;
  rotateY?: number;
  rotateZ?: number;
  move?: V3;
}

/** Rotate and translate a finished solid. */
export function placed(shape: ShapeMesh, placement: Placement): ShapeMesh {
  const { pivot = [0, 0, 0] as V3, rotateX = 0, rotateY = 0, rotateZ = 0, move = [0, 0, 0] as V3 } = placement;
  const radians = Math.PI / 180;
  const matrix = new Matrix4()
    .makeTranslation(move[0] + pivot[0], move[1] + pivot[1], move[2] + pivot[2])
    .multiply(new Matrix4().makeRotationZ(rotateZ * radians))
    .multiply(new Matrix4().makeRotationY(rotateY * radians))
    .multiply(new Matrix4().makeRotationX(rotateX * radians))
    .multiply(new Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]));
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const result: ShapeMesh = { positions: [], normals: [], uvs: [...shape.uvs], indices: [...shape.indices] };
  const point = new Vector3(), normal = new Vector3();
  for (let i = 0; i < shape.positions.length; i += 3) {
    point.fromArray(shape.positions, i).applyMatrix4(matrix);
    normal.fromArray(shape.normals, i).applyMatrix3(normalMatrix).normalize();
    result.positions.push(point.x, point.y, point.z);
    result.normals.push(normal.x, normal.y, normal.z);
  }
  return result;
}

/** The same solid on the other side of the body. Negating x reverses every face, so the winding flips too. */
export function mirroredX(shape: ShapeMesh): ShapeMesh {
  // UVs are carried across unchanged: the mirrored solid samples the same texel for the same corner, so a
  // pattern reads the same on both sides of the body rather than reversing on one of them.
  const result: ShapeMesh = { positions: [], normals: [], uvs: [...shape.uvs], indices: [] };
  for (let i = 0; i < shape.positions.length; i += 3) {
    result.positions.push(-shape.positions[i], shape.positions[i + 1], shape.positions[i + 2]);
    result.normals.push(-shape.normals[i], shape.normals[i + 1], shape.normals[i + 2]);
  }
  for (let i = 0; i < shape.indices.length; i += 3) {
    result.indices.push(shape.indices[i], shape.indices[i + 2], shape.indices[i + 1]);
  }
  return result;
}

export function shapeBounds(shape: ShapeMesh): { min: V3; max: V3 } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < shape.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], shape.positions[i + axis]);
      max[axis] = Math.max(max[axis], shape.positions[i + axis]);
    }
  }
  return { min, max };
}

/**
 * Signed volume by the divergence theorem. Positive means every face is wound outward, which is the whole
 * point of computing it: an inside-out solid is invisible from outside and impossible to see in a diff.
 */
export function shapeVolume(shape: ShapeMesh): number {
  let total = 0;
  for (let i = 0; i < shape.indices.length; i += 3) {
    const a = shape.indices[i] * 3, b = shape.indices[i + 1] * 3, c = shape.indices[i + 2] * 3;
    const p = shape.positions;
    total += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return total / 6;
}

/* ── Figures ───────────────────────────────────────────────────────────────────────────────────────── */

export interface PaletteEntry {
  name: string;
  color: number;
  /** Lit-from-within surfaces — visors, indicator lights. Exported as glTF `emissiveFactor`, and multiplied
   *  by `emissiveTexture` when the entry names one, so a mask supplies the shape and this the colour. */
  emissive?: number;
  /** Name of a `FigureSpec.textures` entry used as this material's emissive mask. */
  emissiveTexture?: string;
  /** Texture-units per second this material's mask scrolls, as [u, v]. Exported as glTF material `extras`
   *  so the ANIMATION is a property of the file rather than of a name the runtime happens to recognise:
   *  `app/ride/character-glow.ts` drives whatever declares one, including a hand-authored GLB. */
  scroll?: readonly [number, number];
  metalness?: number;
  roughness?: number;
}

export { CHARACTER_UV_SCROLL_KEY as UV_SCROLL_KEY };

/** Where in a texture a part's [0, 1]² surface lands: `[u0, v0, u1, v1]`. A range outside 0..1 tiles the
 *  pattern, which is what a repeating conduit strip wants; the default is `UNLIT`. */
export type Tile = readonly [number, number, number, number];

/** The default tile: the centre of the first texel, which every atlas here keeps black. Only parts on a
 *  material that samples nothing ever land here — a material WITH a mask has a real tile on every part that
 *  uses it, because "glowing by accident" is not a state worth being one omission away from. */
export const UNLIT: Tile = [0.0078125, 0.0078125, 0.0078125, 0.0078125];

export type { EmbeddedTexture };

export interface FigurePart {
  name: string;
  /** The single bone this solid is rigidly bound to, at weight 1. */
  bone: string;
  material: string;
  shape: ShapeMesh;
  tile?: Tile;
}

export interface FigureSpec {
  name: string;
  meshName: string;
  /** Stamped into the exported node so a file opened in Blender says what generated it. */
  rigProfile: string;
  generatedBy: string;
  bones: readonly BoneSpec[];
  palette: readonly PaletteEntry[];
  parts: readonly FigurePart[];
  /** Emissive masks embedded in the GLB. A figure with none exports no UV attribute at all. */
  textures?: readonly EmbeddedTexture[];
}

/**
 * Build a figure: one skinned mesh, one bone per joint, one draw group per colour.
 *
 * Solids are authored in BIND WORLD space and the mesh node stays at the identity, so `calculateInverses`
 * turns the parts table into the skin unchanged — what the numbers say is what the standing model is.
 *
 * One bone per solid at a single weight of 1 is what makes armour read as armour rather than as a deforming
 * sausage, and it leaves a joint no smooth deformation to fall back on. Overlapping the joint from both
 * sides is the entire mitigation, which is why `limb()` sections are allowed to run past t = 0 and t = 1.
 */
export function buildFigure(spec: FigureSpec): Group {
  const group = new Group();
  group.name = spec.name;
  group.userData = { rig_profile: spec.rigProfile, generated_by: spec.generatedBy };

  const bones = new Map<string, Bone>();
  const order: Bone[] = [];
  for (const bone of spec.bones) {
    const object = new Bone();
    object.name = bone.name;
    const world = boneWorldMatrix(bone);
    if (bone.parent) {
      const parent = bones.get(bone.parent);
      if (!parent) throw new Error(`bone ${bone.name} names unknown parent ${bone.parent}`);
      parent.add(object);
      parent.updateWorldMatrix(true, false);
      world.premultiply(new Matrix4().copy(parent.matrixWorld).invert());
    } else group.add(object);
    world.decompose(object.position, object.quaternion, object.scale);
    object.updateMatrixWorld(true);
    bones.set(bone.name, object);
    order.push(object);
  }
  const boneIndex = new Map(order.map((bone, index) => [bone.name, index]));

  const positions: number[] = [], normals: number[] = [], indices: number[] = [], uvs: number[] = [];
  const skinIndices: number[] = [], skinWeights: number[] = [];
  const groups: { start: number; count: number; material: number }[] = [];
  const used = new Set<string>();
  const textured = !!spec.textures?.length;
  // One draw group per material, so a parts table can list a solid wherever it belongs anatomically rather
  // than wherever its colour happens to be needed.
  spec.palette.forEach((material, materialIndex) => {
    const start = indices.length;
    for (const part of spec.parts) {
      if (part.material !== material.name) continue;
      used.add(part.name);
      const joint = boneIndex.get(part.bone);
      if (joint === undefined) throw new Error(`part ${part.name} names unknown bone ${part.bone}`);
      const base = positions.length / 3;
      positions.push(...part.shape.positions);
      normals.push(...part.shape.normals);
      const [u0, v0, u1, v1] = part.tile ?? UNLIT;
      for (let vertex = 0; vertex < part.shape.positions.length / 3; vertex++) {
        skinIndices.push(joint, 0, 0, 0);
        skinWeights.push(1, 0, 0, 0);
        // The solid's own [0, 1]² parameterization, remapped into whatever window of the texture this part
        // was given. A part that names no tile lands on `UNLIT`, which every atlas keeps black.
        if (textured) {
          uvs.push(u0 + part.shape.uvs[vertex * 2] * (u1 - u0), v0 + part.shape.uvs[vertex * 2 + 1] * (v1 - v0));
        }
      }
      for (const index of part.shape.indices) indices.push(base + index);
    }
    if (indices.length > start) groups.push({ start, count: indices.length - start, material: materialIndex });
  });
  const orphans = spec.parts.filter(part => !used.has(part.name));
  if (orphans.length) {
    throw new Error(`parts name colours the palette does not have: ${orphans.map(p => `${p.name}/${p.material}`).join(', ')}`);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  // Only when something samples them. A figure with no textures would otherwise pay eight bytes a vertex for
  // an attribute no material reads — and its exported bytes would change, which the built-ins are pinned on.
  if (textured) geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(new Uint32BufferAttribute(indices, 1));
  for (const { start, count, material } of groups) geometry.addGroup(start, count, material);

  // The hard edge on every corner comes from the per-face normals written above, not from `flatShading` —
  // that flag is a three-side hint with no glTF counterpart, and is set only so a caller rendering this
  // group directly gets the same shading the exported file does.
  const materials = spec.palette.map(entry => {
    const material = new MeshStandardMaterial({
      name: entry.name, color: new Color(entry.color),
      metalness: entry.metalness ?? 0, roughness: entry.roughness ?? 0.85, flatShading: true,
    });
    if (entry.emissive !== undefined) material.emissive = new Color(entry.emissive);
    if (entry.scroll) material.userData = { [CHARACTER_UV_SCROLL_KEY]: [entry.scroll[0], entry.scroll[1]] };
    return material;
  });

  const mesh = new SkinnedMesh(geometry, materials);
  mesh.name = spec.meshName;
  group.add(mesh);
  // Bind only once the hierarchy is placed: the skeleton takes its inverse binds from the bones' current
  // world matrices and the mesh takes its bind matrix from its own, which is what makes the authored
  // world-space corners the standing pose.
  group.updateMatrixWorld(true);
  mesh.bind(new Skeleton(order));
  return group;
}

/* ── Export ────────────────────────────────────────────────────────────────────────────────────────── */

/** GLTFExporter's binary path reads its own Blob back through `FileReader`, which Node has no reason to
 *  have. This is the whole browser surface a texture-free character export touches. */
function installFileReader() {
  const globals = globalThis as unknown as { FileReader?: unknown };
  globals.FileReader ??= class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); });
    }
  };
}

export async function exportFigureGlb(figure: Group): Promise<Uint8Array> {
  installFileReader();
  const exported = await new GLTFExporter().parseAsync(figure, { binary: true, animations: [] });
  if (!(exported instanceof ArrayBuffer)) throw new Error('exporter returned JSON instead of a binary GLB');
  return new Uint8Array(exported);
}

/**
 * Build a figure and export it as the bytes that ship: geometry through `GLTFExporter`, then any emissive
 * masks embedded afterwards (see `embed-texture.ts` for why the images are not the exporter's job). A figure
 * that declares no textures gets back exactly what the exporter produced.
 */
export async function exportCharacterGlb(spec: FigureSpec): Promise<Uint8Array> {
  const glb = await exportFigureGlb(buildFigure(spec));
  const assignments = spec.palette
    .filter(entry => entry.emissiveTexture)
    .map(entry => ({ material: entry.name, texture: entry.emissiveTexture! }));
  return attachEmissiveTextures(glb, spec.textures ?? [], assignments);
}

/**
 * The command every generated character exposes: build, report, validate, and write only if the bytes pass
 * the same contract the gate and the character library run — so a regenerated built-in can never land in a
 * state the runtime would refuse to load.
 */
export async function runCharacterBuild(defaultOutput: string, glb: () => Promise<Uint8Array>) {
  const out = resolve(process.argv[2] ?? defaultOutput);
  const bytes = await glb();
  const report = checkCharacterGlb(bytes, out);
  console.log(`${report.skinnedMeshes} skinned mesh, ${report.vertices} vertices, ${report.triangles} triangles, `
    + `${report.bones} bones, ${report.materials} materials`);
  console.log(`height ${report.heightMetres?.toFixed(3) ?? '?'} m, bounds ${JSON.stringify(report.boundsMin)} → `
    + `${JSON.stringify(report.boundsMax)}, ${bytes.byteLength} bytes`);
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  for (const error of report.errors) console.log(`  error: ${error}`);
  if (!report.valid) throw new Error('generated character failed the character contract; nothing was written');
  await writeFile(out, bytes);
  console.log(`wrote ${out}`);
}
