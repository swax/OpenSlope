/**
 * Pure motion maths for the reference effects runtime: deterministic debris sampling, the spline path sampler
 * and pose composition. Every function here takes its whole input as arguments and returns (or writes into) what
 * it was given, so none of it reaches the live scene graph, the emitter registry or the runtime's shared state.
 */
import * as THREE from 'three';
import { splineOrientationAngles, splineMotionCopyDistances } from '../../../core/effects/play-runtime';

/** Tommy Ettinger's mulberry32 PRNG (public domain), in the JavaScript form popularised by bryc's PRNG survey. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

export function randomUnitVector(random: () => number): THREE.Vector3 {
  const y = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  return new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
}

export function sampleSplinePath(points: THREE.Vector3[], cumulative: number[], length: number,
  distance: number, direction: number) {
  const d = THREE.MathUtils.clamp(distance, 0, length);
  let hi = 1;
  while (hi < cumulative.length - 1 && cumulative[hi] < d) hi++;
  const lo = Math.max(0, hi - 1), span = cumulative[hi] - cumulative[lo];
  const t = span > 1e-8 ? (d - cumulative[lo]) / span : 0;
  const position = points[lo].clone().lerp(points[hi], t);
  const tangent = points[hi].clone().sub(points[lo]).normalize();
  const travelTangent = tangent.clone().multiplyScalar(direction);
  return { position, tangent, travelTangent };
}

export function composeMotion(matrix: THREE.Matrix4, basis: THREE.Matrix4, position: THREE.Vector3,
  rotation: THREE.Quaternion) {
  matrix.compose(position, rotation, new THREE.Vector3(1, 1, 1)).multiply(basis);
  return matrix;
}

/** `I⁻¹ · v` for a row-major inverse inertia tensor. */
export function applyInvInertia(inv: Float32Array, v: THREE.Vector3, out: THREE.Vector3) {
  return out.set(
    inv[0] * v.x + inv[1] * v.y + inv[2] * v.z,
    inv[3] * v.x + inv[4] * v.y + inv[5] * v.z,
    inv[6] * v.x + inv[7] * v.y + inv[8] * v.z,
  );
}

export function splinePoseMatrices(points: THREE.Vector3[], cumulative: number[], length: number, distance: number,
  direction: number, endMode: number, orientationMode: number, yawOffset: number, instanceCount: number,
  basis: THREE.Matrix4): THREE.Matrix4[] {
  // Native retail tops out at chairlift-sized counts (15 in Snowdream). Keep malformed documents from asking
  // the editor to allocate an unbounded number of draw poses while retaining ample authoring headroom.
  const count = Math.min(256, Math.max(1, Math.trunc(instanceCount)));
  return splineMotionCopyDistances(distance, length, count).map(sampleDistance => {
    const { position, tangent } = sampleSplinePath(points, cumulative, length, sampleDistance, direction);
    const { yaw, pitch } = splineOrientationAngles(
      [tangent.x, tangent.y, tangent.z], direction, endMode, orientationMode, yawOffset);
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
    return new THREE.Matrix4().compose(position, rotation, new THREE.Vector3(1, 1, 1)).multiply(basis);
  });
}
