import * as THREE from 'three';
import type { PlayerPose, PlayerTransform, PlayerVec3 } from '../../core/session/player-pose';

export const REMOTE_SMOOTH_TIME = 0.12;
export const REMOTE_FOLLOW_RATE = 12;
export const REMOTE_MAX_EXTRAPOLATION = 1.5;
export const REMOTE_MAX_ACCELERATION = 20;
export const REMOTE_MAX_ROTATION_INTERVALS = 1.5;
export const REMOTE_SNAP_DISTANCE = 50;

/** Unity-compatible critically damped chase, including its rational exponential approximation. */
export function smoothDampVector(
  current: THREE.Vector3, target: THREE.Vector3, velocity: THREE.Vector3, smoothTime: number, dt: number,
): THREE.Vector3 {
  const time = Math.max(0.0001, smoothTime), omega = 2 / time, x = omega * Math.max(0, dt);
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current.clone().sub(target);
  const temp = velocity.clone().addScaledVector(change, omega).multiplyScalar(dt);
  velocity.sub(temp.clone().multiplyScalar(omega)).multiplyScalar(decay);
  return target.clone().add(change.add(temp).multiplyScalar(decay));
}

function extrapolatedRotation(base: THREE.Quaternion, delta: THREE.Quaternion, fraction: number) {
  const d = delta.clone().normalize();
  if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
  const angle = 2 * Math.acos(THREE.MathUtils.clamp(d.w, -1, 1));
  const sin = Math.sqrt(Math.max(0, 1 - d.w * d.w));
  if (angle < 1e-6 || sin < 1e-6) return base.clone();
  const axis = new THREE.Vector3(d.x / sin, d.y / sin, d.z / sin);
  return new THREE.Quaternion().setFromAxisAngle(axis, angle * fraction).multiply(base).normalize();
}

/**
 * The VRC board's carrot/stick follower, expressed against browser time. A packet is converted from server to
 * local monotonic time before it enters here; after that the algorithm is deterministic and transport-agnostic.
 */
export class RemotePlayerMotion {
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  readonly acceleration = new THREE.Vector3();

  private samplePosition = new THREE.Vector3();
  private sampleRotation = new THREE.Quaternion();
  private sampleAt = 0;
  private seq = -1;
  private teleport = -1;
  private smoothVelocity = new THREE.Vector3();
  private rotationDelta = new THREE.Quaternion();
  private rotationInterval = 0.1;
  private rotationValid = false;
  private initialized = false;
  private snapPending = false;

  push(frame: PlayerPose, localSampleAtSeconds: number): boolean {
    return this.pushTransform(frame.seq, frame.teleport, frame.body, frame.velocity, localSampleAtSeconds);
  }

  /** Feed another owner-authoritative moving object (currently loose equipment) through the same follower. */
  pushTransform(seq: number, teleport: number, transform: PlayerTransform, velocity: PlayerVec3,
    localSampleAtSeconds: number): boolean {
    if (seq <= this.seq) return false;
    const nextPosition = new THREE.Vector3(...transform.p);
    const nextRotation = new THREE.Quaternion(...transform.q).normalize();
    const nextVelocity = new THREE.Vector3(...velocity);
    const interval = localSampleAtSeconds - this.sampleAt;

    if (nextVelocity.lengthSq() < 1e-4) this.acceleration.set(0, 0, 0);
    else if (this.initialized && interval > 0.04 && interval < 1) {
        const measured = nextVelocity.clone().sub(this.velocity).divideScalar(interval);
        if (nextVelocity.dot(this.velocity) < 0) measured.set(0, 0, 0);
        measured.clampLength(0, REMOTE_MAX_ACCELERATION);
        this.acceleration.lerp(measured, 0.35);
    }
    if (this.initialized && interval > 0.04 && interval < 1) {
      const delta = nextRotation.clone().multiply(this.sampleRotation.clone().invert()).normalize();
      this.rotationDelta.copy(this.rotationValid ? this.rotationDelta.slerp(delta, 0.5) : delta);
      this.rotationInterval = interval;
      this.rotationValid = true;
    }

    this.samplePosition.copy(nextPosition);
    this.sampleRotation.copy(nextRotation);
    this.velocity.copy(nextVelocity);
    this.sampleAt = localSampleAtSeconds;
    this.seq = seq;
    if (!this.initialized || teleport !== this.teleport) {
      this.snapPending = true;
      if (this.initialized) { this.acceleration.set(0, 0, 0); this.rotationValid = false; }
    }
    this.teleport = teleport;
    this.initialized = true;
    return true;
  }

  step(dt: number, nowSeconds: number): void {
    if (!this.initialized) return;
    const age = THREE.MathUtils.clamp(nowSeconds - this.sampleAt, 0, REMOTE_MAX_EXTRAPOLATION);
    const accelAge = Math.min(age, 0.5);
    const target = this.samplePosition.clone().addScaledVector(this.velocity, age)
      .addScaledVector(this.acceleration, 0.5 * accelAge * accelAge);
    if (this.snapPending || this.position.distanceToSquared(target) > REMOTE_SNAP_DISTANCE ** 2) {
      this.snapPending = false;
      this.position.copy(target);
      this.quaternion.copy(this.sampleRotation);
      this.smoothVelocity.set(0, 0, 0);
      return;
    }
    this.position.copy(smoothDampVector(
      this.position, target, this.smoothVelocity, REMOTE_SMOOTH_TIME, dt,
    ));
    let targetRotation = this.sampleRotation;
    if (this.rotationValid && this.rotationInterval > 1e-3) {
      targetRotation = extrapolatedRotation(
        this.sampleRotation, this.rotationDelta,
        Math.min(REMOTE_MAX_ROTATION_INTERVALS, age / this.rotationInterval),
      );
    }
    this.quaternion.slerp(targetRotation, 1 - Math.exp(-REMOTE_FOLLOW_RATE * Math.max(0, dt))).normalize();
  }
}
