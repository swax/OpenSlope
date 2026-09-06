import type { V3 } from '../doc/types';

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 1, 0];
};
export const lerp = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Rotate a vector about a unit axis with Rodrigues' formula. */
export function rotateAroundAxis(v: V3, axis: V3, angle: number): V3 {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const crossTerm = cross(axis, v), projection = dot(axis, v) * (1 - cosine);
  return [
    v[0] * cosine + crossTerm[0] * sine + axis[0] * projection,
    v[1] * cosine + crossTerm[1] * sine + axis[1] * projection,
    v[2] * cosine + crossTerm[2] * sine + axis[2] * projection,
  ];
}
