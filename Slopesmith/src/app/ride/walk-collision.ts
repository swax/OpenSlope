import * as THREE from 'three';
import { INTERSECTED, MeshBVH, NOT_INTERSECTED } from 'three-mesh-bvh';
import type { RideObstacleHit, RideObstacleSource } from './physics';
import { MOVABLE_MIN_IMPACT, RIDER_MASS_TERM, SHOVE_RESTITUTION } from './physics-tuning';
import { unionLeafNormal } from './physics-math';
import type { WalkGround } from './xr/walk';

/**
 * Prop collision for the on-foot character controller.
 *
 * The board has a deliberately specialised collision law in `physics.ts`; walking needs the ordinary game-world
 * contract instead: every solid collider is a floor/wall regardless of its snowboard SurfaceType, Rollers are
 * touched rather than treated as walls, and trigger-style colliders still report the crossing. This launch-time
 * world consumes the exact same `RideObstacleSource` snapshot as the board, so authored and reference props use
 * one set of placements, live transforms and object identities.
 */

const WALK_RADIUS = 0.30;
const WALK_PADDING = 0.015;
/** The controller may step over everything below this height; its first wall sample begins just above it. */
const WALK_SAMPLE_Y = [0.58, 1.12, 1.62] as const;
const MIN_GROUND_NY = 0.4;
const MAX_SLIDE_PLANES = 4;
const HIT_COOLDOWN_MS = 50 / 60 * 1000;

interface ObstacleMeta {
  source: RideObstacleSource;
  enabled: boolean;
  body: { com: THREE.Vector3; invInertia: Float32Array } | null;
}

interface LiveMesh {
  meta: ObstacleMeta;
  local: Float32Array;
  start: number;
  applied: THREE.Matrix4;
  poseVersion?: () => number;
  appliedVersion?: number;
  /** Only these BVH nodes enclose this moving triangle run; used for an incremental refit. */
  nodes?: Set<number>;
}

interface SphereBody {
  meta: ObstacleMeta;
  spheres: Float32Array;
  matrixWorld: THREE.Matrix4;
  toLocal: THREE.Matrix4;
  normalMatrix: THREE.Matrix3;
  localCenter: THREE.Vector3;
  localRadius: number;
  bound: THREE.Sphere;
  liveMatrix?: () => THREE.Matrix4;
  poseVersion?: () => number;
  appliedVersion?: number;
}

interface WalkTouch {
  meta: ObstacleMeta;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  impactSpeed: number;
  distance: number;
}

interface WalkBarrier {
  distance: number;
  normal: THREE.Vector3;
}

export interface WalkObstacleWorld {
  /** Start one rendered frame. Live transforms are synchronized at most once until the next call. */
  beginFrame(): void;
  /** Nearest standable prop face on this (normally downward) segment. */
  groundCast(from: THREE.Vector3, to: THREE.Vector3): WalkGround | null;
  /** Resolve the feet-root move in place and dispatch any prop contacts it reaches. */
  resolveMove(from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3): void;
  retire(key: string): void;
  restore(key: string): void;
  /** Current-frame diagnostic drill-down. `ms` is already part of XR begin/ride CPU and must not be added twice. */
  readonly perf: Readonly<WalkCollisionPerf>;
  dispose(): void;
}

export interface WalkCollisionPerf {
  ms: number;
  groundCasts: number;
  sweeps: number;
  triangleTests: number;
  liveRefits: number;
}

export function createWalkObstacleWorld(
  sources: readonly RideObstacleSource[],
  onHit?: (hit: RideObstacleHit) => void,
): WalkObstacleWorld {
  const metas: ObstacleMeta[] = [];
  const faceMeta: number[] = [];
  const positions: number[] = [];
  const lives: LiveMesh[] = [];
  const sphereBodies: SphereBody[] = [];
  const vertex = new THREE.Vector3();

  for (const source of sources) {
    const meta: ObstacleMeta = { source, enabled: true, body: worldMassProps(source) };
    const metaIndex = metas.length;
    metas.push(meta);

    const attr = source.geometry?.getAttribute('position');
    const index = source.geometry?.getIndex();
    const triangles = attr ? Math.floor((index?.count ?? attr.count) / 3) : 0;
    if (attr && triangles) {
      const start = positions.length / 3;
      const local = source.liveMatrix ? new Float32Array(triangles * 9) : null;
      for (let face = 0; face < triangles; face++) {
        for (let corner = 0; corner < 3; corner++) {
          const offset = face * 3 + corner;
          const vi = index ? index.getX(offset) : offset;
          vertex.fromBufferAttribute(attr, vi);
          if (local) local.set([vertex.x, vertex.y, vertex.z], offset * 3);
          vertex.applyMatrix4(source.matrixWorld);
          positions.push(vertex.x, vertex.y, vertex.z);
        }
        faceMeta.push(metaIndex);
      }
      if (local && source.liveMatrix) lives.push({
        meta, local, start, applied: source.matrixWorld.clone(),
        poseVersion: source.poseVersion, appliedVersion: source.poseVersion?.(),
      });
    }

    if (source.spheres && source.spheres.length >= 4) {
      const localBox = new THREE.Box3();
      for (let i = 0; i + 3 < source.spheres.length; i += 4) {
        const r = Math.max(0, source.spheres[i + 3]);
        localBox.expandByPoint(vertex.set(source.spheres[i] - r, source.spheres[i + 1] - r, source.spheres[i + 2] - r));
        localBox.expandByPoint(vertex.set(source.spheres[i] + r, source.spheres[i + 1] + r, source.spheres[i + 2] + r));
      }
      const localCenter = localBox.getCenter(new THREE.Vector3());
      let localRadius = 0;
      for (let i = 0; i + 3 < source.spheres.length; i += 4) {
        vertex.fromArray(source.spheres, i);
        localRadius = Math.max(localRadius, localCenter.distanceTo(vertex) + Math.max(0, source.spheres[i + 3]));
      }
      const body: SphereBody = {
        meta, spheres: source.spheres, matrixWorld: new THREE.Matrix4(), toLocal: new THREE.Matrix4(),
        normalMatrix: new THREE.Matrix3(), localCenter, localRadius, bound: new THREE.Sphere(),
        liveMatrix: source.liveMatrix, poseVersion: source.poseVersion, appliedVersion: source.poseVersion?.(),
      };
      placeSphereBody(body, source.matrixWorld);
      sphereBodies.push(body);
    }
  }

  const geometry = new THREE.BufferGeometry();
  const position = new THREE.Float32BufferAttribute(positions, 3);
  geometry.setAttribute('position', position);
  const bvh = faceMeta.length ? new MeshBVH(geometry, { indirect: true }) : null;
  const refitNodes = new Set<number>();
  assignLiveRefitNodes();
  const ray = new THREE.Ray();
  const rayHit = new THREE.Vector3(), rayBoxHit = new THREE.Vector3();
  const motion = new THREE.Vector3(), direction = new THREE.Vector3(), right = new THREE.Vector3();
  const root = new THREE.Vector3(), remaining = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const sampleFrom = Array.from({ length: WALK_SAMPLE_Y.length * 3 }, () => new THREE.Vector3());
  const sampleTo = Array.from({ length: WALK_SAMPLE_Y.length * 3 }, () => new THREE.Vector3());
  const sweepBounds = new THREE.Box3();
  const localFrom = new THREE.Vector3(), localTo = new THREE.Vector3(), localDir = new THREE.Vector3();
  const localHit = new THREE.Vector3(), localNormal = new THREE.Vector3();
  const worldNormal = new THREE.Vector3(), worldPoint = new THREE.Vector3();
  const touches = new Map<string, WalkTouch>();
  const hitNext = new Map<string, number>();
  const perf: WalkCollisionPerf = { ms: 0, groundCasts: 0, sweeps: 0, triangleTests: 0, liveRefits: 0 };
  let frame = 0, syncedFrame = -1;

  /** Map each moving triangle run to its leaf nodes and ancestors. A full refit on a reference course can touch
   * hundreds of thousands of static triangles just because one lift or breakable moved; the riding collider
   * already uses this same targeted-node scheme. */
  function assignLiveRefitNodes() {
    if (!bvh || !lives.length) return;
    const liveOfTriangle = new Int32Array(faceMeta.length).fill(-1);
    lives.forEach((live, at) =>
      liveOfTriangle.fill(at, live.start / 3, live.start / 3 + live.local.length / 9));
    const path: number[] = [0];
    bvh.shapecast({
      intersectsBounds: (_box, _isLeaf, _score, depth, nodeIndex) => {
        path[depth] = nodeIndex;
        return INTERSECTED;
      },
      intersectsRange: (at, count, _contained, depth, nodeIndex) => {
        path[depth] = nodeIndex;
        for (let i = at; i < at + count; i++) {
          const liveAt = liveOfTriangle[bvh.resolveTriangleIndex(i)];
          if (liveAt < 0) continue;
          const nodes = (lives[liveAt].nodes ??= new Set<number>());
          for (let d = 0; d <= depth; d++) nodes.add(path[d]);
        }
        return false;
      },
    });
  }

  function beginFrame() {
    frame++;
    perf.ms = 0;
    perf.groundCasts = 0;
    perf.sweeps = 0;
    perf.triangleTests = 0;
    perf.liveRefits = 0;
  }

  function syncLive() {
    if (syncedFrame === frame) return;
    syncedFrame = frame;
    let meshMoved = false, refitAll = false;
    refitNodes.clear();
    for (const live of lives) {
      if (live.poseVersion) {
        const version = live.poseVersion();
        if (version === live.appliedVersion) continue;
        live.appliedVersion = version;
      }
      const matrix = live.meta.source.liveMatrix!();
      if (matrix.equals(live.applied)) continue;
      live.applied.copy(matrix);
      const target = position.array as Float32Array;
      for (let v = 0; v < live.local.length; v += 3) {
        vertex.set(live.local[v], live.local[v + 1], live.local[v + 2]).applyMatrix4(matrix);
        const out = live.start * 3 + v;
        target[out] = vertex.x; target[out + 1] = vertex.y; target[out + 2] = vertex.z;
      }
      live.meta.body = worldMassProps(live.meta.source, matrix);
      meshMoved = true;
      if (!live.nodes?.size) refitAll = true;
      else for (const node of live.nodes) refitNodes.add(node);
    }
    if (meshMoved && bvh) {
      position.needsUpdate = true;
      bvh.refit(refitAll ? undefined : refitNodes);
      perf.liveRefits++;
    }

    for (const body of sphereBodies) {
      if (!body.liveMatrix) continue;
      if (body.poseVersion) {
        const version = body.poseVersion();
        if (version === body.appliedVersion) continue;
        body.appliedVersion = version;
      }
      const matrix = body.liveMatrix();
      if (matrix.equals(body.matrixWorld)) continue;
      placeSphereBody(body, matrix);
      body.meta.body = worldMassProps(body.meta.source, matrix);
    }
  }

  function groundCast(from: THREE.Vector3, to: THREE.Vector3): WalkGround | null {
    const started = performance.now();
    perf.groundCasts++;
    syncLive();
    const far = from.distanceTo(to);
    if (far < 1e-9) { perf.ms += performance.now() - started; return null; }
    motion.copy(to).sub(from);
    let best: { distance: number; y: number; normal: THREE.Vector3; point: THREE.Vector3 } | null = null;

    if (bvh) {
      ray.origin.copy(from);
      ray.direction.copy(motion).divideScalar(far);
      // Walk the tree in ray-entry order and retain the nearest VALID floor directly. `bvh.raycast()` allocated,
      // returned and sorted every face on the 202 m probe before metadata could reject triggers/disabled props.
      bvh.shapecast({
        boundsTraverseOrder: box => rayEntryDistance(box),
        intersectsBounds: (_box, _isLeaf, score) =>
          score !== undefined && score <= far && score <= (best?.distance ?? far)
            ? INTERSECTED : NOT_INTERSECTED,
        intersectsTriangle: (triangle, faceIndex) => {
          perf.triangleTests++;
          const meta = metas[faceMeta[faceIndex]];
          if (!meta?.enabled || !meta.source.solid) return false;
          const hit = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, rayHit);
          if (!hit) return false;
          const distance = hit.distanceTo(from);
          if (distance > far || distance >= (best?.distance ?? Infinity)) return false;
          triangle.getNormal(worldNormal);
          if (worldNormal.y < 0) worldNormal.negate();
          if (worldNormal.y < MIN_GROUND_NY) return false;
          best = { distance, y: hit.y, normal: worldNormal.clone(), point: hit.clone() };
          return false;
        },
      });
    }

    for (const body of sphereBodies) {
      if (!body.meta.enabled || !body.meta.source.solid || body.bound.distanceToPoint(from) > far) continue;
      const hit = castSphereBody(body, from, to, motion, false);
      if (!hit || hit.normal.y < MIN_GROUND_NY || (best && hit.distance >= best.distance)) continue;
      best = { distance: hit.distance, y: hit.point.y, normal: hit.normal, point: hit.point.clone() };
    }
    perf.ms += performance.now() - started;
    return best ? { y: best.y, normal: best.normal, point: best.point } : null;
  }

  /** Ray-entry distance is a lower bound used both to visit near nodes first and to prune nodes past a hit. */
  function rayEntryDistance(box: THREE.Box3): number {
    if (box.containsPoint(ray.origin)) return 0;
    const hit = ray.intersectBox(box, rayBoxHit);
    return hit ? hit.distanceTo(ray.origin) : Infinity;
  }

  function resolveMove(from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3): void {
    const started = performance.now();
    syncLive();
    root.copy(from);
    remaining.copy(to).sub(from);
    touches.clear();

    for (let iteration = 0; iteration < MAX_SLIDE_PLANES; iteration++) {
      const length = remaining.length();
      if (length < 1e-8) break;
      direction.copy(remaining).divideScalar(length);
      right.set(direction.z, 0, -direction.x);
      if (right.lengthSq() < 1e-8) right.set(1, 0, 0); else right.normalize();
      prepareSweepSamples(root, remaining, direction, right);
      const earliest = castSweptBarriers(length, remaining, velocity, touches);
      if (!earliest) { root.add(remaining); remaining.set(0, 0, 0); break; }

      // Keep the full skin even when already close. Halving it asymptotically walks the leading sample onto the
      // plane; once float error puts that sample a hair inside a closed mesh, a short next bite sees no exit and
      // the controller leaks through the wall.
      const allowed = Math.max(0, earliest.distance - WALK_PADDING);
      root.addScaledVector(direction, allowed);
      remaining.addScaledVector(direction, -allowed);
      const intoMove = remaining.dot(earliest.normal);
      if (intoMove < 0) remaining.addScaledVector(earliest.normal, -intoMove);
      const intoVelocity = velocity.dot(earliest.normal);
      if (intoVelocity < 0) velocity.addScaledVector(earliest.normal, -intoVelocity);
    }

    to.copy(root);
    reportTouches(touches, velocity);
    perf.ms += performance.now() - started;
  }

  /** Build the same nine leading capsule rails the original resolver cast independently, plus one conservative
   * swept bound that lets all nine share a single BVH traversal. */
  function prepareSweepSamples(at: THREE.Vector3, move: THREE.Vector3,
    forward: THREE.Vector3, lateral: THREE.Vector3) {
    sweepBounds.makeEmpty();
    let sample = 0;
    for (const y of WALK_SAMPLE_Y) for (const side of [-WALK_RADIUS, 0, WALK_RADIUS]) {
      offset.copy(forward).multiplyScalar(WALK_RADIUS).addScaledVector(lateral, side).setY(y);
      sampleFrom[sample].copy(at).add(offset);
      sampleTo[sample].copy(sampleFrom[sample]).add(move);
      sweepBounds.expandByPoint(sampleFrom[sample]);
      sweepBounds.expandByPoint(sampleTo[sample]);
      sample++;
    }
  }

  /** One traversal for the walking capsule's nine rails. Candidate triangles are tested against all rails while
   * hot in cache; the old path traversed the whole BVH and allocated/sorted a hit array nine times per plane. */
  function castSweptBarriers(far: number, move: THREE.Vector3,
    velocity: THREE.Vector3, out: Map<string, WalkTouch>): WalkBarrier | null {
    perf.sweeps++;
    let earliest: WalkBarrier | null = null;

    if (bvh) {
      ray.direction.copy(direction);
      bvh.shapecast({
        boundsTraverseOrder: box => sweepNodeDistance(box),
        intersectsBounds: (box, _isLeaf, score) =>
          box.intersectsBox(sweepBounds)
          && score !== undefined && score <= far && score <= (earliest?.distance ?? far)
            ? INTERSECTED : NOT_INTERSECTED,
        intersectsTriangle: (triangle, faceIndex) => {
          perf.triangleTests++;
          const meta = metas[faceMeta[faceIndex]];
          if (!meta?.enabled) return false;
          triangle.getNormal(worldNormal);
          if (worldNormal.dot(move) > 0) worldNormal.negate();
          if (worldNormal.dot(move) >= -1e-6) return false;
          let nearest = Infinity;
          const point = worldPoint;
          for (let i = 0; i < sampleFrom.length; i++) {
            ray.origin.copy(sampleFrom[i]);
            const hit = ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, rayHit);
            if (!hit) continue;
            const distance = hit.distanceTo(sampleFrom[i]);
            if (distance < 1e-5 || distance > far || distance >= nearest) continue;
            nearest = distance;
            point.copy(hit);
          }
          if (!Number.isFinite(nearest)) return false;
          keepNearest(out, {
            meta, point: point.clone(), normal: worldNormal.clone(),
            impactSpeed: Math.max(0, -velocity.dot(worldNormal)), distance: nearest,
          });
          if (meta.source.solid && (meta.source.dynamicMass ?? 0) <= 0 && worldNormal.y < MIN_GROUND_NY
            && nearest < (earliest?.distance ?? Infinity)) {
            earliest = { distance: nearest, normal: worldNormal.clone() };
          }
          return false;
        },
      });
    }

    // Packed sphere bodies share the same outer body/sample traversal. Their leaf math is analytic rather than
    // BVH-backed, but moving the body loop outside the nine rails still removes eight repeated broad phases.
    for (const body of sphereBodies) {
      if (!body.meta.enabled || !body.bound.intersectsBox(sweepBounds)) continue;
      let nearest: ReturnType<typeof castSphereBody> = null;
      for (let i = 0; i < sampleFrom.length; i++) {
        const hit = castSphereBody(body, sampleFrom[i], sampleTo[i], move, true);
        if (hit && (!nearest || hit.distance < nearest.distance)) nearest = hit;
      }
      if (nearest) {
        keepNearest(out, {
          meta: body.meta, point: nearest.point.clone(), normal: nearest.normal.clone(),
          impactSpeed: Math.max(0, -velocity.dot(nearest.normal)), distance: nearest.distance,
        });
        if (body.meta.source.solid && (body.meta.source.dynamicMass ?? 0) <= 0
          && nearest.normal.y < MIN_GROUND_NY && nearest.distance < (earliest?.distance ?? Infinity)) {
          earliest = { distance: nearest.distance, normal: nearest.normal.clone() };
        }
      }
    }
    return earliest;
  }

  function sweepNodeDistance(box: THREE.Box3): number {
    let nearest = Infinity;
    for (const at of sampleFrom) nearest = Math.min(nearest, box.distanceToPoint(at));
    return nearest;
  }

  function castSphereBody(body: SphereBody, from: THREE.Vector3, to: THREE.Vector3,
    move: THREE.Vector3, incomingOnly: boolean): { distance: number; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const far = from.distanceTo(to);
    localFrom.copy(from).applyMatrix4(body.toLocal);
    localTo.copy(to).applyMatrix4(body.toLocal);
    localDir.copy(localTo).sub(localFrom);
    const aa = localDir.lengthSq();
    if (aa < 1e-16) return null;
    let best: { u: number; leaf: number } | null = null;
    for (let i = 0; i + 3 < body.spheres.length; i += 4) {
      const mx = localFrom.x - body.spheres[i];
      const my = localFrom.y - body.spheres[i + 1];
      const mz = localFrom.z - body.spheres[i + 2];
      const r = Math.max(0, body.spheres[i + 3]);
      const bb = 2 * (mx * localDir.x + my * localDir.y + mz * localDir.z);
      const cc = mx * mx + my * my + mz * mz - r * r;
      const disc = bb * bb - 4 * aa * cc;
      if (disc < 0) continue;
      const rootDisc = Math.sqrt(disc), inv = 1 / (2 * aa);
      const enter = (-bb - rootDisc) * inv, exit = (-bb + rootDisc) * inv;
      const u = enter >= 1e-6 ? enter : exit >= 1e-6 ? exit : -1;
      if (u < 0 || u > 1 || (best && u >= best.u)) continue;
      localHit.copy(localDir).multiplyScalar(u).add(localFrom);
      unionLeafNormal(body.spheres, localHit, i, localNormal);
      if (localNormal.lengthSq() < 1e-16) continue;
      worldNormal.copy(localNormal).applyNormalMatrix(body.normalMatrix).normalize();
      if (incomingOnly && worldNormal.dot(move) >= -1e-6) continue;
      best = { u, leaf: i };
    }
    if (!best) return null;
    localHit.copy(localDir).multiplyScalar(best.u).add(localFrom);
    unionLeafNormal(body.spheres, localHit, best.leaf, localNormal);
    const normal = localNormal.clone().applyNormalMatrix(body.normalMatrix).normalize();
    return {
      distance: far * best.u,
      point: localHit.clone().applyMatrix4(body.matrixWorld),
      normal,
    };
  }

  function reportTouches(found: Map<string, WalkTouch>, velocity: THREE.Vector3) {
    const now = performance.now();
    for (const touch of found.values()) {
      if (now < (hitNext.get(touch.meta.source.key) ?? 0)) continue;
      hitNext.set(touch.meta.source.key, now + HIT_COOLDOWN_MS);
      onHit?.({
        key: touch.meta.source.key,
        object: touch.meta.source.object,
        point: touch.point.clone(),
        normal: touch.normal.clone(),
        impactSpeed: touch.impactSpeed,
        shove: shoveMovable(touch, velocity),
      });
    }
  }

  function retire(key: string) {
    for (const meta of metas) if (meta.source.key === key) meta.enabled = false;
    hitNext.delete(key);
  }

  function restore(key: string) {
    for (const meta of metas) if (meta.source.key === key) meta.enabled = true;
    hitNext.delete(key);
  }

  function dispose() { geometry.dispose(); }

  return { beginFrame, groundCast, resolveMove, retire, restore, perf, dispose };
}

function keepNearest(out: Map<string, WalkTouch>, touch: WalkTouch) {
  const previous = out.get(touch.meta.source.key);
  if (!previous || touch.distance < previous.distance) out.set(touch.meta.source.key, touch);
}

function placeSphereBody(body: SphereBody, matrix: THREE.Matrix4) {
  body.matrixWorld.copy(matrix);
  body.toLocal.copy(matrix).invert();
  body.normalMatrix.getNormalMatrix(matrix);
  const e = matrix.elements;
  const maxScale = Math.max(
    Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]),
  );
  body.bound.center.copy(body.localCenter).applyMatrix4(matrix);
  body.bound.radius = body.localRadius * maxScale;
}

function worldMassProps(source: RideObstacleSource, matrix = source.matrixWorld):
  { com: THREE.Vector3; invInertia: Float32Array } | null {
  if (!source.body || source.body.invInertia.length < 9) return null;
  const m = matrix.elements;
  const linear = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = linear[0] * (linear[4] * linear[8] - linear[5] * linear[7])
    - linear[1] * (linear[3] * linear[8] - linear[5] * linear[6])
    + linear[2] * (linear[3] * linear[7] - linear[4] * linear[6]);
  const scale = Math.cbrt(Math.abs(det));
  if (!(scale > 1e-12)) return null;
  const r = linear.map(value => value / scale);
  const local = source.body.invInertia;
  const world = new Float32Array(9);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    let value = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      value += r[row * 3 + i] * local[i * 3 + j] * r[col * 3 + j];
    world[row * 3 + col] = value / (scale * scale);
  }
  return { com: new THREE.Vector3(...source.body.com).applyMatrix4(matrix), invInertia: world };
}

function shoveMovable(touch: WalkTouch, velocity: THREE.Vector3): RideObstacleHit['shove'] {
  const mass = touch.meta.source.dynamicMass ?? 0;
  if (!(mass > 0) || touch.impactSpeed <= MOVABLE_MIN_IMPACT) return null;
  const invMass = 1 / mass;
  const body = touch.meta.body;
  const offset = body ? touch.point.clone().sub(body.com) : null;
  let rotational = 0;
  if (body && offset) {
    const rxn = offset.clone().cross(touch.normal);
    rotational = applyInvInertia(body.invInertia, rxn, new THREE.Vector3()).cross(offset).dot(touch.normal);
    if (!Number.isFinite(rotational) || rotational < 0) rotational = 0;
  }
  const denominator = invMass + RIDER_MASS_TERM + rotational;
  if (!(denominator > 1e-9)) return null;
  const impulse = SHOVE_RESTITUTION * touch.impactSpeed / denominator;
  velocity.addScaledVector(touch.normal, impulse * RIDER_MASS_TERM);
  const applied = touch.normal.clone().multiplyScalar(-impulse);
  return {
    linear: applied.clone().multiplyScalar(invMass),
    angular: body && offset
      ? applyInvInertia(body.invInertia, offset.clone().cross(applied), new THREE.Vector3())
      : new THREE.Vector3(),
    body: body ? { invInertia: body.invInertia, com: body.com.clone(), invMass } : null,
  };
}

function applyInvInertia(tensor: Float32Array, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  return out.set(
    tensor[0] * v.x + tensor[1] * v.y + tensor[2] * v.z,
    tensor[3] * v.x + tensor[4] * v.y + tensor[5] * v.z,
    tensor[6] * v.x + tensor[7] * v.y + tensor[8] * v.z,
  );
}
