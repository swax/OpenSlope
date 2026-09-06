import * as THREE from 'three';

/** Stable authoring identity carried from a prop collider into the Play effects/audio runtime. */
export type RideObstacleObject =
  | { kind: 'reference'; index: number }
  | { kind: 'authored'; id: string };

/** One native prop collision source. Triangle proxies are flattened into one world-space BVH at launch;
 * mode-3 bodies retain their packed local leaf spheres and affine transform so ray/sphere tests stay analytic
 * (including non-uniform instance scale) instead of becoming a huge tessellated approximation; mode-2 bounds
 * keep their min/max, because the native box test is neither a mesh nor a general convex test
 * ([Trailmap: 370-sphere-box]). */
export interface RideObstacleSource {
  key: string;
  object: RideObstacleObject;
  /** Mode-1 triangle proxy, mode-2 box, or authored collision geometry. */
  geometry?: THREE.BufferGeometry;
  /** Marks `geometry` as a native mode-2 bounding box rather than real collision geometry. The rider meets a box
   *  through a different, much coarser law than a proxy mesh ([Trailmap: 370-probe-modes]), so it cannot be
   *  baked into the triangle BVH without becoming a mesh the rider collides with edge-first. */
  nativeBox?: boolean;
  /** Mode-3 packed model-local x/y/z/r leaves. Exactly one of `geometry` / `spheres` is normally present. */
  spheres?: Float32Array;
  matrixWorld: THREE.Matrix4;
  /** False is the specified foliage/trigger-style touch [Trailmap: 130-collision-data]: report contact,
   *  but do not change rider motion. */
  solid: boolean;
  /** Restitution applied only to a solid impact. Zero is collide-and-slide; 0.5 is the common prop kickback. */
  bounce: number;
  /** The native response gate. Native props with this off remain contact-capable but are not solid; this field
   *  also keeps the generic/manual solid fallback distinct from the restitution/eject branch. */
  playerBounce?: boolean;
  /** A non-negative native surface type makes upward faces rideable; -1 keeps the whole prop an obstacle. */
  surface: number;
  /** Dynamic scalar mass from the activating Roller payload [Trailmap: 130-collision-data, 370-world-interaction].
   *  Positive selects the rigid-body shove path; unrelated instance response mass never enters this solver. */
  dynamicMass?: number;
  /** The instance's physics-body mass properties, model-local, for the shove's impulse solve. Absent for a body
   *  that authored no usable tensor, which falls back to a translation-only shove. */
  body?: { com: readonly [number, number, number]; invInertia: Float32Array };
  /** Current world pose for a prop that MOVES during the run — a model clip, an effect matrix override, or a
   *  piece throw. Read once per rendered frame; the returned matrix may be a scratch the provider reuses, so it
   *  is consumed immediately and never retained. Without one the source stays frozen in the launch bake, which
   *  is what the static majority want. */
  liveMatrix?: () => THREE.Matrix4;
  /** Monotonic stamp that CHANGES whenever `liveMatrix` may have a new answer. Optional fast path: with one,
   *  the per-frame refit recomposes this source's pose only after the stamp moves, instead of recomposing
   *  thousands of unchanged matrix chains a frame; without one the pose is polled every frame as before.
   *  The provider owns the guarantee — a stamp that misses a mutation freezes the collider at the stale pose. */
  poseVersion?: () => number;
}

export interface RideObstacleHit {
  key: string;
  object: RideObstacleObject;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  impactSpeed: number;
  /** The shove the rider just paid for, as the impulse leaves the prop: world linear velocity and world angular
   *  velocity about its own centre of mass. Null for every immovable solid and ride-through touch, which the
   *  scene leaves standing. The angular half is not decoration — [Trailmap: 370-world-interaction] is explicit
   *  that the impulse carries no vertical bias and that a struck body's loft comes from spinning over its own
   *  ground contact, so this is what actually throws a crash bag. */
  shove: {
    linear: THREE.Vector3; angular: THREE.Vector3;
    /** The body's world mass properties, so the scene's moved-body sim can solve its ground contacts with the
     *  same authored tensor and the same inverse mass. Absent when the instance shipped none. */
    body: { invInertia: Float32Array; com: THREE.Vector3; invMass: number } | null;
  } | null;
}
