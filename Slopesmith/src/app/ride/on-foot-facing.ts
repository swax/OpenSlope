import * as THREE from 'three';

const TURN_THRESHOLD = THREE.MathUtils.degToRad(30);
const TURN_RESET = THREE.MathUtils.degToRad(2);
const TURN_RATE = THREE.MathUtils.degToRad(180);
const MOVING_SPEED = 0.15;

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const yawOf = (v: THREE.Vector3) => Math.atan2(v.x, v.z);

/**
 * Remote on-foot turn-in-place presentation. While stationary, gaze owns a 30-degree cone about the current
 * torso heading. Crossing it starts one finite catch-up: the torso turns to the gaze, establishes that as the
 * new neutral, then arms a fresh 30-degree cone. Translation always resets the cone to the transmitted body.
 */
export class OnFootFacing {
  readonly facing = new THREE.Vector3(0, 0, 1);
  /** Signed torso rotation performed by the latest frame; zero while the head is inside its free-look cone. */
  turnDelta = 0;
  private readonly bodyForward = new THREE.Vector3();
  private readonly lookForward = new THREE.Vector3();
  private yaw = 0;
  private ready = false;
  private turning = false;

  clear(): void { this.ready = false; this.turning = false; this.turnDelta = 0; }

  step(dt: number, bodyQuaternion: THREE.Quaternion, headQuaternion: THREE.Quaternion | null,
       horizontalSpeed: number): THREE.Vector3 {
    this.turnDelta = 0;
    this.bodyForward.set(0, 0, 1).applyQuaternion(bodyQuaternion).setY(0);
    if (this.bodyForward.lengthSq() < 1e-8) this.bodyForward.set(0, 0, 1); else this.bodyForward.normalize();
    const bodyYaw = yawOf(this.bodyForward);
    if (!this.ready || horizontalSpeed > MOVING_SPEED || !headQuaternion) {
      this.yaw = bodyYaw;
      this.ready = true;
      this.turning = false;
      return this.resolve();
    }

    this.lookForward.set(0, 0, -1).applyQuaternion(headQuaternion).setY(0);
    if (this.lookForward.lengthSq() < 1e-8) return this.resolve();
    this.lookForward.normalize();
    const lookYaw = yawOf(this.lookForward);
    let error = wrap(lookYaw - this.yaw);
    if (!this.turning && Math.abs(error) > TURN_THRESHOLD) this.turning = true;
    if (this.turning) {
      const amount = Math.min(Math.abs(error), TURN_RATE * Math.max(0, dt));
      this.turnDelta = Math.sign(error) * amount;
      this.yaw = wrap(this.yaw + this.turnDelta);
      error = wrap(lookYaw - this.yaw);
      if (Math.abs(error) <= TURN_RESET) {
        this.yaw = lookYaw;
        this.turning = false;
      }
    }
    return this.resolve();
  }

  private resolve(): THREE.Vector3 { return this.facing.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
}
