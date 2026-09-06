/** Clamp a scalar to the inclusive [lo, hi] interval. */
export const clamp = (value: number, lo: number, hi: number): number =>
  value < lo ? lo : value > hi ? hi : value;

/** Clamp a scalar to the inclusive unit interval. */
export const clamp01 = (value: number): number => clamp(value, 0, 1);

/** Linear interpolation between two scalars. */
export const lerpScalar = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Cubic Hermite easing over a clamped unit interval. */
export const smoothstep = (value: number): number => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};
