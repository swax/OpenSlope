import * as THREE from 'three';
import { samplePropModelCurve, type PropModelAnimation } from '../../../core/reference/props';

/**
 * Pure pose arithmetic for the reference decor's recovered model clips, split out of `reference-decor.ts`
 * because it touches none of that factory's live scene state: every function here is a deterministic
 * function of its arguments. `hierarchyPose` memoizes per animation object (keyed weakly, so a dropped
 * reference level's clips are collectable) — the cache is a derived value, identical for equal inputs.
 */
interface HierarchyPoseCache {
  restWorld: THREE.Matrix4[];
  restInverse: THREE.Matrix4[];
  frame: number | null;
  poseWorld: THREE.Matrix4[];
  deltas: THREE.Matrix4[];
}
const hierarchyPoseCache = new WeakMap<PropModelAnimation, HierarchyPoseCache>();

/** One (frame, basis) pair of a running AnimCombo. Combos are rare and short-lived, so this holds the ONE
 *  pair each clip is currently drawing rather than growing a table the way the ambient pose cache does. */
interface ComboPoseCache {
  frame: number;
  basis: number;
  deltas: THREE.Matrix4[];
}
const comboPoseCache = new WeakMap<PropModelAnimation, ComboPoseCache>();

function hierarchyLocalMatrix(animation: PropModelAnimation, objectIndex: number,
  frame: number | null): THREE.Matrix4 {
  const object = animation.objects[objectIndex];
  if (!object) return new THREE.Matrix4();
  if (frame === null || !object.channels?.some(curve => !!curve?.length)) {
    return new THREE.Matrix4().compose(
      new THREE.Vector3(...object.restPosition), new THREE.Quaternion(...object.restRotation),
      new THREE.Vector3(...object.restScale));
  }
  // An animated object's ROTATION comes from its channels alone: a component with no curve is ZERO, not
  // its base value and not its rest value [Trailmap: 120-objects]. Translation still starts from the base.
  const position = new THREE.Vector3(...(object.basePosition ?? object.restPosition));
  const eulerDegrees = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    const translation = object.channels[axis];
    const rotation = object.channels[axis + 3];
    if (translation?.length) position.setComponent(axis, samplePropModelCurve(translation, frame));
    if (rotation?.length) eulerDegrees.setComponent(axis, samplePropModelCurve(rotation, frame));
  }
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(eulerDegrees.x), THREE.MathUtils.degToRad(eulerDegrees.y),
    THREE.MathUtils.degToRad(eulerDegrees.z), 'ZYX');
  return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(...object.restScale));
}

function hierarchyWorldMatrices(animation: PropModelAnimation, frame: number | null,
  basis?: readonly THREE.Matrix4[]): THREE.Matrix4[] {
  const world: (THREE.Matrix4 | undefined)[] = new Array(animation.objects.length);
  const visiting = new Set<number>();
  const resolve = (index: number): THREE.Matrix4 => {
    const cached = world[index];
    if (cached) return cached;
    // An AnimCombo composes its triggered pose onto the one the object was holding when it fired, and it does
    // so PER OBJECT before the hierarchy is walked — the engine rewrites each part's own matrix in place
    // [Trailmap: 230-level-ssf type 0 sub 258]. Pre-multiplying here rather than at the root is what keeps a
    // child's reaction relative to its own rest instead of to the model origin.
    const own = hierarchyLocalMatrix(animation, index, frame);
    const held = basis?.[index];
    const local = held ? held.clone().multiply(own) : own;
    if (visiting.has(index)) return local;
    visiting.add(index);
    const parent = animation.objects[index]?.parent ?? -1;
    const result = parent >= 0 && parent < animation.objects.length && parent !== index
      ? resolve(parent).clone().multiply(local) : local;
    visiting.delete(index);
    world[index] = result;
    return result;
  };
  return animation.objects.map((_, index) => resolve(index));
}

export function hierarchyPose(animation: PropModelAnimation, frame: number): HierarchyPoseCache {
  let cache = hierarchyPoseCache.get(animation);
  if (!cache) {
    const restWorld = hierarchyWorldMatrices(animation, null);
    cache = {
      restWorld,
      restInverse: restWorld.map(matrix => matrix.clone().invert()),
      frame: null,
      poseWorld: restWorld,
      deltas: restWorld.map(() => new THREE.Matrix4()),
    };
    hierarchyPoseCache.set(animation, cache);
  }
  if (cache.frame === frame) return cache;
  cache.frame = frame;
  cache.poseWorld = hierarchyWorldMatrices(animation, frame);
  cache.deltas = cache.poseWorld.map((matrix, index) => matrix.clone().multiply(cache!.restInverse[index]));
  return cache;
}

/**
 * Render deltas for a clip whose triggered combo window is playing over a held idle pose.
 *
 * `basisFrame` is the idle frame the receiver snapshotted when the trigger arrived, and `frame` the combo
 * clock. The result is the ordinary animated-world x inverse-rest delta of `snapshot x comboPose`, so a
 * caller applies it exactly as it applies `hierarchyPose`'s.
 */
export function hierarchyComboPose(animation: PropModelAnimation, frame: number,
  basisFrame: number): THREE.Matrix4[] {
  const cached = comboPoseCache.get(animation);
  if (cached && cached.frame === frame && cached.basis === basisFrame) return cached.deltas;
  const { restInverse } = hierarchyPose(animation, basisFrame);
  const basis = hierarchyLocalMatrices(animation, basisFrame);
  const deltas = hierarchyWorldMatrices(animation, frame, basis)
    .map((matrix, index) => matrix.clone().multiply(restInverse[index]));
  comboPoseCache.set(animation, { frame, basis: basisFrame, deltas });
  return deltas;
}

/** Every object's own animated transform at one frame, before the parent chain is applied. This is the
 *  quantity an AnimCombo snapshots: the engine saves each part's matrix, not the model's world pose. */
export function hierarchyLocalMatrices(animation: PropModelAnimation, frame: number | null): THREE.Matrix4[] {
  return animation.objects.map((_, index) => hierarchyLocalMatrix(animation, index, frame));
}

export function hiddenMatrix(matrix: THREE.Matrix4): THREE.Matrix4 {
  const out = matrix.clone(), e = out.elements;
  e[0] = e[1] = e[2] = e[4] = e[5] = e[6] = e[8] = e[9] = e[10] = 0;
  return out;
}
