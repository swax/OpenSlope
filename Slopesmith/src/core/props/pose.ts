import type { V3 } from '../doc/types';

/**
 * A placed prop's authored ORIENTATION, and the one place it turns into numbers.
 *
 * A placement stores three angles in degrees — `yaw` about vertical, `pitch` about the placement's own X,
 * `roll` about its own Z — composed in YXZ order: `R = Ry(yaw) · Rx(pitch) · Rz(roll)`. Yaw comes first
 * because it is the angle placement authors: the wheel turns it, the Tools slider names it "turn", and a
 * document that never tilts anything (pitch and roll absent, the default) resolves to exactly `Ry(yaw)` —
 * bit-for-bit the rotation every placement had before tilt existed.
 *
 * Everything that poses a placement — the viewport matrix, the export bake, the canonical instance
 * quaternion, sign lights, attached emitter frames, group members — reads the rotation from here rather
 * than re-deriving a `cos`/`sin` pair from `yaw`, so a tilted prop cannot render at one angle and bake at
 * another. Quaternion layout is `(x, y, z, w)` and the conventions match Three's, because the viewport
 * hands its gizmo quaternions straight in.
 */

/** Unit quaternion `(x, y, z, w)`. */
export type Quat = [number, number, number, number];

/** The rotation fields of a `PlacedProp`. Absent pitch / roll are zero — an upright prop. */
export interface PropRotation {
  yaw: number;
  pitch?: number;
  roll?: number;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];

/** True when the placement carries any tilt — the cheap guard that keeps the yaw-only fast paths exact. */
export function isTilted(r: PropRotation): boolean {
  return !!r.pitch || !!r.roll;
}

/** The placement's data-space rotation, YXZ (see the module note). */
export function placementQuat(r: PropRotation): Quat {
  const x = (r.pitch ?? 0) * D2R / 2, y = r.yaw * D2R / 2, z = (r.roll ?? 0) * D2R / 2;
  const c1 = Math.cos(x), s1 = Math.sin(x);
  const c2 = Math.cos(y), s2 = Math.sin(y);
  const c3 = Math.cos(z), s3 = Math.sin(z);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

/** Recover the authored angles from a rotation. Yaw normalizes to [0, 360) — the range the turn slider and
 *  every stored placement already use; pitch / roll stay signed about zero, where upright lives. */
export function propRotationFromQuat(q: Quat): { yaw: number; pitch: number; roll: number } {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const m11 = 1 - (yy + zz), m13 = xz + wy;
  const m21 = xy + wz, m22 = 1 - (xx + zz), m23 = yz - wx;
  const m31 = xz - wy, m33 = 1 - (xx + yy);
  const pitch = Math.asin(-Math.min(1, Math.max(-1, m23)));
  // At |m23| ≈ 1 the prop points straight up or straight down and yaw / roll turn about the same axis
  // (gimbal lock); attribute the whole turn to yaw, which is the angle authors reach for.
  const locked = Math.abs(m23) >= 0.9999999;
  const yaw = locked ? Math.atan2(-m31, m11) : Math.atan2(m13, m33);
  const roll = locked ? 0 : Math.atan2(m21, m22);
  return { yaw: ((yaw * R2D) % 360 + 360) % 360, pitch: pitch * R2D, roll: roll * R2D };
}

/** `a · b` — apply b, then a. */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
    a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** The inverse rotation (a unit quaternion's conjugate). */
export function conjugateQuat(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function applyQuat(v: V3, q: Quat): V3 {
  const [qx, qy, qz, qw] = q, [vx, vy, vz] = v;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

/** A model-local (data-space) direction turned into world by the placement's rotation. */
export function rotateByPlacement(v: V3, r: PropRotation): V3 {
  return r.pitch || r.roll ? applyQuat(v, placementQuat(r)) : rotateY(v, r.yaw);
}

/** The inverse: a world direction expressed in the placement's own frame. */
export function unrotateByPlacement(v: V3, r: PropRotation): V3 {
  return r.pitch || r.roll ? applyQuat(v, conjugateQuat(placementQuat(r))) : rotateY(v, -r.yaw);
}

/** Yaw alone about +Y. Kept as its own function because it is exact for the untilted majority and is the
 *  frame group members and mined rigs are authored in. */
export function rotateY(v: V3, deg: number): V3 {
  const t = deg * D2R, c = Math.cos(t), s = Math.sin(t);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

/** Compose a relative yaw (a group member's own turn) onto a placement's rotation. */
export function composeYaw(r: PropRotation, relYaw: number): { yaw: number; pitch: number; roll: number } {
  if (!isTilted(r)) return { yaw: ((r.yaw + relYaw) % 360 + 360) % 360, pitch: 0, roll: 0 };
  return propRotationFromQuat(multiplyQuat(placementQuat(r), placementQuat({ yaw: relYaw })));
}

/** Spread the tilt fields onto a placement record, omitting the zeros so an upright placement serializes
 *  exactly as it always has (and a saved document only grows where an author actually tilted something). */
export function tiltFields(r: { pitch?: number; roll?: number }): { pitch?: number; roll?: number } {
  return { ...(r.pitch ? { pitch: r.pitch } : {}), ...(r.roll ? { roll: r.roll } : {}) };
}

/** Write a rotation onto an existing placement, DELETING zero tilt rather than storing it. An untilted prop
 *  therefore round-trips through a rotate drag with the same fields it had before tilt existed — and a
 *  `-0` that `Math.asin` can hand back never reaches a saved document. */
export function writePropRotation(target: { yaw: number; pitch?: number; roll?: number },
                                  rot: PropRotation): void {
  target.yaw = rot.yaw;
  if (rot.pitch) target.pitch = rot.pitch; else delete target.pitch;
  if (rot.roll) target.roll = rot.roll; else delete target.roll;
}
