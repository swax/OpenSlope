import * as THREE from 'three';
import type { RideObstacleSource } from '../../ride/physics';
import { RIDER_BODY_R, RIDER_BARRIER_PAD, WORLD_UP } from '../../ride/physics-tuning';
import { RIDER_DECK_SAMPLES, RIDER_PROBE_SAMPLES, riderBodyCentre, riderProbeOffsets } from '../../ride/rider-volume';

/**
 * Test mode's collider overlay: what the ride is actually colliding with, and what it is colliding AS.
 *
 * Two things are drawn, because a prop contact is a question about both of them and the shapes are nothing like
 * the art. On the world side, the native collision shapes ([Trailmap: 130-collision-data]) — the mode-1 proxy
 * mesh rather than the render mesh, the mode-2 bounding box, the mode-3 leaf spheres. On the rider side, the
 * probe volume that meets them ([Trailmap: 370-probe-volume]): the board footprint, the torso and head samples,
 * and the **body sphere**, which is the only thing a bounding box ever touches. Seeing the two together is what
 * explains a pass-through that looks like a hit — and this is why the rider shapes come from
 * `ride/rider-volume.ts`, the module the contact solver itself reads.
 *
 * The world side is rebuilt from whatever is NEAR the rider rather than for the whole mountain: a reference
 * level carries thousands of colliders and a hundred thousand proxy triangles, which is both unreadable and
 * unaffordable as wireframe. It re-gathers only once the rider has left the slab it was built for.
 */

/** Solid props, the ones that can stop you. */
const SOLID_COLOR = 0x4fc3f7;
/** Contact-only props — triggers, foliage, breakables: they report and dispatch, but never change your motion. */
const THROUGH_COLOR = 0x9575cd;
/** The rider's own probe body. */
const RIDER_COLOR = 0xffb74d;
/** The body sphere, called out from the rest of the rider because it is the one that answers a box. */
const BODY_SPHERE_COLOR = 0xff7043;

/** How far around the rider colliders are gathered, and how far they may move before a re-gather. */
const NEAR_RADIUS = 70;
const REGATHER_DISTANCE = 20;

/** Everything the overlay needs of a rider. `RideState` satisfies it structurally, and so can a fixture. */
export interface RideProbePose {
  pos: THREE.Vector3;
  fwd: THREE.Vector3;
  boardUp: THREE.Vector3;
}

function lineMaterial(color: number, opacity: number) {
  return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false });
}

export function createRideColliderOverlay(parent: THREE.Object3D) {
  const group = new THREE.Group();
  group.name = 'Ride collider overlay';
  group.visible = false;
  group.renderOrder = 120;
  parent.add(group);

  const materials = {
    solid: lineMaterial(SOLID_COLOR, 0.85),
    through: lineMaterial(THROUGH_COLOR, 0.7),
    rider: lineMaterial(RIDER_COLOR, 0.95),
    body: lineMaterial(BODY_SPHERE_COLOR, 0.95),
  };
  const worldGroup = new THREE.Group();
  const riderGroup = new THREE.Group();
  group.add(worldGroup, riderGroup);

  let sources: readonly RideObstacleSource[] = [];
  let visible = false;
  interface LiveSourcePose { matrix: THREE.Matrix4; version?: number }
  // `matrixWorld` is the launch snapshot used to seed collision. The solver subsequently consumes liveMatrix,
  // so the debug view needs its own consumed snapshots too or it keeps drawing the very ghost pose it is meant
  // to diagnose. A WeakMap avoids retaining retired ride sources after the overlay changes targets.
  let liveSourcePoses = new WeakMap<RideObstacleSource, LiveSourcePose>();
  /** Where the world half was last gathered, or null when it has never been built for the current sources. */
  let gatheredAt: THREE.Vector3 | null = null;
  // The two halves are rebuilt on different clocks — the rider every frame, the world only on a re-gather — so
  // their buffers are owned separately. One shared list would leak a frame's worth of rider geometry per frame.
  const ownedWorld: THREE.BufferGeometry[] = [];
  const ownedRider: THREE.BufferGeometry[] = [];

  const scratchSphere = new THREE.Sphere();
  const scratchVec = new THREE.Vector3(), scratchCentre = new THREE.Vector3();
  const probeOffsets = Array.from({ length: RIDER_PROBE_SAMPLES }, () => new THREE.Vector3());
  const riderForward = new THREE.Vector3(), riderRight = new THREE.Vector3(), riderUp = new THREE.Vector3();

  function dispose(bucket: THREE.BufferGeometry[]) {
    for (const geometry of bucket) geometry.dispose();
    bucket.length = 0;
  }

  function addLines(positions: number[], material: THREE.LineBasicMaterial, into: THREE.Group,
    bucket: THREE.BufferGeometry[]) {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    bucket.push(geometry);
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 120;
    lines.frustumCulled = false;
    lines.raycast = () => { /* display-only overlay */ };
    into.add(lines);
  }

  /** Twelve edges of a box given in some local frame, transformed into world space by `matrix`. */
  function pushOrientedBox(out: number[], min: THREE.Vector3, max: THREE.Vector3, matrix: THREE.Matrix4) {
    const xs = [min.x, max.x], ys = [min.y, max.y], zs = [min.z, max.z];
    const corner = (i: number) => scratchVec
      .set(xs[i & 1], ys[(i >> 1) & 1], zs[(i >> 2) & 1]).applyMatrix4(matrix);
    for (let i = 0; i < 8; i++) {
      for (const bit of [1, 2, 4]) {
        const j = i | bit;
        if (j === i) continue;
        const a = corner(i).clone(), b = corner(j);
        out.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  }

  /** Three great circles of a world-space sphere — enough to read a radius without a shaded ball in the way. */
  function pushSphere(out: number[], centre: THREE.Vector3, radius: number, segments = 20) {
    if (radius <= 0) return;
    for (const [ax, ay] of [[0, 1], [0, 2], [1, 2]] as const) {
      for (let i = 0; i < segments; i++) {
        const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments;
        for (const angle of [a, b]) {
          const point = [centre.x, centre.y, centre.z];
          point[ax] += Math.cos(angle) * radius;
          point[ay] += Math.sin(angle) * radius;
          out.push(point[0], point[1], point[2]);
        }
      }
    }
  }

  /** The triangle edges of one source's proxy geometry, transformed into world space. */
  function pushMesh(out: number[], source: RideObstacleSource, matrix: THREE.Matrix4) {
    const geometry = source.geometry;
    const attribute = geometry?.getAttribute('position');
    if (!geometry || !attribute) return;
    const index = geometry.getIndex();
    const count = Math.floor((index?.count ?? attribute.count) / 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let face = 0; face < count; face++) {
      const at = face * 3;
      const [ia, ib, ic] = index ? [index.getX(at), index.getX(at + 1), index.getX(at + 2)] : [at, at + 1, at + 2];
      a.fromBufferAttribute(attribute, ia).applyMatrix4(matrix);
      b.fromBufferAttribute(attribute, ib).applyMatrix4(matrix);
      c.fromBufferAttribute(attribute, ic).applyMatrix4(matrix);
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, b.x, b.y, b.z, c.x, c.y, c.z, c.x, c.y, c.z, a.x, a.y, a.z);
    }
  }

  /** Is any part of this source within `NEAR_RADIUS` of `centre`? Cheap and conservative. */
  function nearby(source: RideObstacleSource, centre: THREE.Vector3, matrix: THREE.Matrix4): boolean {
    if (source.spheres?.length) {
      scratchVec.setFromMatrixPosition(matrix);
      let reach = 0;
      for (let i = 0; i + 3 < source.spheres.length; i += 4)
        reach = Math.max(reach, Math.hypot(source.spheres[i], source.spheres[i + 1], source.spheres[i + 2])
          + Math.max(0, source.spheres[i + 3]));
      const elements = matrix.elements;
      const scale = Math.max(Math.hypot(elements[0], elements[1], elements[2]),
        Math.hypot(elements[4], elements[5], elements[6]), Math.hypot(elements[8], elements[9], elements[10]));
      return scratchVec.distanceTo(centre) <= NEAR_RADIUS + reach * scale;
    }
    const geometry = source.geometry;
    if (!geometry) return false;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!geometry.boundingSphere) return false;
    scratchSphere.copy(geometry.boundingSphere).applyMatrix4(matrix);
    return scratchSphere.center.distanceTo(centre) <= NEAR_RADIUS + scratchSphere.radius;
  }

  const sourceMatrix = (source: RideObstacleSource) => liveSourcePoses.get(source)?.matrix ?? source.matrixWorld;

  /** Consume changed live poses before deciding whether the rider has moved far enough for a re-gather. */
  function syncLiveSources(centre: THREE.Vector3): boolean {
    let changedNearRider = false;
    for (const source of sources) {
      if (!source.liveMatrix) continue;
      let state = liveSourcePoses.get(source);
      if (!state) {
        // Initialize lazily while the overlay is visible: rebuilding thousands of reference matrices at ride
        // launch would charge for a diagnostic that is normally off. The first gather below consumes this pose.
        state = { matrix: source.liveMatrix().clone(), version: source.poseVersion?.() };
        liveSourcePoses.set(source, state);
        continue;
      }
      const version = source.poseVersion?.();
      if (source.poseVersion && version === state.version) continue;
      const wasNearby = nearby(source, centre, state.matrix);
      const now = source.liveMatrix();
      state.version = version;
      if (now.equals(state.matrix)) continue;
      state.matrix.copy(now);
      if (wasNearby || nearby(source, centre, state.matrix)) changedNearRider = true;
    }
    return changedNearRider;
  }

  /** Rebuild the world half around `centre`. Solid and pass-through shapes go into separate buffers so the two
   *  read apart at a glance — a rider stopped by something purple is looking at a bug. */
  function gatherWorld(centre: THREE.Vector3) {
    worldGroup.clear();
    dispose(ownedWorld);
    const solid: number[] = [], through: number[] = [];
    for (const source of sources) {
      const matrix = sourceMatrix(source);
      if (!nearby(source, centre, matrix)) continue;
      const out = source.solid ? solid : through;
      if (source.spheres?.length) {
        for (let i = 0; i + 3 < source.spheres.length; i += 4) {
          scratchVec.fromArray(source.spheres, i).applyMatrix4(matrix);
          // Non-uniform placement scale turns a leaf into an ellipsoid; the wire ball uses the mean axis, which
          // is what a reader needs from an overlay rather than an exact silhouette.
          const elements = matrix.elements;
          const scale = (Math.hypot(elements[0], elements[1], elements[2])
            + Math.hypot(elements[4], elements[5], elements[6])
            + Math.hypot(elements[8], elements[9], elements[10])) / 3;
          pushSphere(out, scratchVec, Math.max(0, source.spheres[i + 3]) * scale, 14);
        }
        continue;
      }
      if (source.nativeBox) {
        const geometry = source.geometry;
        if (!geometry) continue;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const local = geometry.boundingBox;
        if (!local) continue;
        // Drawn ORIENTED, because that is what it is: the model's own local box turned with the placement
        // ([Trailmap: 130-mode2-oriented]). An axis-aligned drawing here would be a picture of the cull box.
        pushOrientedBox(out, local.min, local.max, matrix);
        continue;
      }
      pushMesh(out, source, matrix);
    }
    addLines(solid, materials.solid, worldGroup, ownedWorld);
    addLines(through, materials.through, worldGroup, ownedWorld);
    gatheredAt = (gatheredAt ?? new THREE.Vector3()).copy(centre);
  }

  /** Redraw the rider's own probe volume for this pose. Cheap enough to run every frame. */
  function drawRider(state: RideProbePose) {
    riderGroup.clear();
    dispose(ownedRider);
    riderUp.copy(state.boardUp.lengthSq() > 1e-6 ? state.boardUp : WORLD_UP).normalize();
    riderForward.copy(state.fwd).addScaledVector(riderUp, -state.fwd.dot(riderUp));
    if (riderForward.lengthSq() < 1e-6) riderForward.set(0, 0, 1); else riderForward.normalize();
    riderRight.crossVectors(riderUp, riderForward).normalize();
    riderProbeOffsets(riderForward, riderRight, riderUp, probeOffsets);

    // The nine deck samples drawn as their footprint outline plus the cross that ties the middle row together,
    // so the shape reads as the board it stands for rather than as nine loose dots.
    const rider: number[] = [];
    const world = (index: number) => scratchVec.copy(state.pos).add(probeOffsets[index]);
    const corners = [0, 2, 8, 6, 0];
    for (let at = 0; at + 1 < corners.length; at++) {
      const a = world(corners[at]).clone();
      const b = world(corners[at + 1]);
      rider.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    // The upper samples are marks rather than a body: what matters is where they are, not a fictional silhouette.
    for (let index = RIDER_DECK_SAMPLES; index < RIDER_PROBE_SAMPLES; index++) {
      const at = world(index).clone();
      for (const axis of [[RIDER_BARRIER_PAD, 0, 0], [0, RIDER_BARRIER_PAD, 0], [0, 0, RIDER_BARRIER_PAD]]) {
        rider.push(at.x - axis[0], at.y - axis[1], at.z - axis[2]);
        rider.push(at.x + axis[0], at.y + axis[1], at.z + axis[2]);
      }
    }
    addLines(rider, materials.rider, riderGroup, ownedRider);

    const body: number[] = [];
    pushSphere(body, riderBodyCentre(state.pos, riderUp, scratchCentre), RIDER_BODY_R, 24);
    addLines(body, materials.body, riderGroup, ownedRider);
  }

  return {
    group,
    /** Hand over the ride's collider set. Passing an empty list retires the overlay's world half. */
    setSources(next: readonly RideObstacleSource[]) {
      sources = next;
      liveSourcePoses = new WeakMap();
      gatheredAt = null;
      worldGroup.clear();
      dispose(ownedWorld);
    },
    setVisible(on: boolean) {
      visible = on;
      group.visible = on;
      if (!on) {
        worldGroup.clear(); riderGroup.clear();
        dispose(ownedWorld); dispose(ownedRider);
        gatheredAt = null;
      }
    },
    get visible() { return visible; },
    /** Called once a frame while a ride is running. No-op when the toggle is off. */
    update(state: RideProbePose | null) {
      if (!visible || !state) return;
      const liveChanged = syncLiveSources(state.pos);
      if (!gatheredAt || liveChanged || gatheredAt.distanceTo(state.pos) > REGATHER_DISTANCE) gatherWorld(state.pos);
      drawRider(state);
    },
    dispose() {
      group.removeFromParent();
      worldGroup.clear(); riderGroup.clear();
      dispose(ownedWorld); dispose(ownedRider);
      for (const material of Object.values(materials)) material.dispose();
    },
  };
}

export type RideColliderOverlay = ReturnType<typeof createRideColliderOverlay>;
