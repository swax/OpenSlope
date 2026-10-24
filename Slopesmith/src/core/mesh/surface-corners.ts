import type { V3 } from '../doc/types';

/** Four-sided approximation of the whole outline. Arc-length weighted line error makes extra samples on
 *  a straight side irrelevant; no click (including the first) is forced to be a corner. */
export function inferSurfaceCorners(points: readonly V3[]): number[] {
  const n = points.length;
  if (n < 4) return [];
  if (n === 4) return [0, 1, 2, 3];
  const normal = [0, 0, 0];
  points.forEach((p, i) => {
    const a = p.map((x, k) => x - points[0][k]),
      b = points[(i + 1) % n].map((x, k) => x - points[0][k]);
    normal[0] += a[1] * b[2] - a[2] * b[1];
    normal[1] += a[2] * b[0] - a[0] * b[2];
    normal[2] += a[0] * b[1] - a[1] * b[0];
  });
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),
    axes = [0, 1, 2].filter(k => k !== drop),
    flat = points.map(p => axes.map(k => p[k] - points[0][k]));
  // Integrate 1, x, y, x², xy, y² along the polygon. Prefix moments give each candidate side's exact
  // squared line error in constant time instead of rescanning its points in the circular DP below.
  const moments = Array.from({ length: 2 * n + 1 }, () => new Float64Array(6));
  for (let i = 0; i < 2 * n; i++) {
    const [x, y] = flat[i % n],
      [X, Y] = flat[(i + 1) % n],
      w = Math.hypot(X - x, Y - y);
    const values = [
      w,
      (w * (x + X)) / 2,
      (w * (y + Y)) / 2,
      (w * (x * x + x * X + X * X)) / 3,
      (w * (2 * x * y + x * Y + X * y + 2 * X * Y)) / 6,
      (w * (y * y + y * Y + Y * Y)) / 3,
    ];
    moments[i + 1] = Float64Array.from(values, (v, k) => v + moments[i][k]);
  }
  const scale = Math.max(1e-12, moments[n][0] ** 3),
    errors = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let a = 0; a < n; a++)
    for (let span = 1; span < n; span++) {
      const b = a + span,
        [x, y] = flat[a],
        [X, Y] = flat[b % n],
        length = Math.hypot(X - x, Y - y);
      if (length < 1e-12) {
        errors[a][span] = Infinity;
        continue;
      }
      const nx = (Y - y) / length,
        ny = (x - X) / length,
        c = -nx * x - ny * y,
        m = moments[b].map((v, k) => v - moments[a][k]);
      errors[a][span] =
        Math.max(
          0,
          nx * nx * m[3] + 2 * nx * ny * m[4] + ny * ny * m[5] + 2 * c * (nx * m[1] + ny * m[2]) + c * c * m[0],
        ) / scale;
    }
  let best = Infinity,
    corners: number[] = [];
  for (let start = 0; start < n; start++) {
    let costs = new Float64Array(n + 1).fill(Infinity);
    costs[0] = 0;
    const parents = Array.from({ length: 5 }, () => new Int32Array(n + 1).fill(-1));
    for (let side = 1; side <= 4; side++) {
      const next = new Float64Array(n + 1).fill(Infinity);
      for (let end = side; end <= n - 4 + side; end++)
        for (let from = side - 1; from < end; from++) {
          const value = costs[from] + errors[(start + from) % n][end - from];
          if (value < next[end]) {
            next[end] = value;
            parents[side][end] = from;
          }
        }
      costs = next;
    }
    if (costs[n] < best - 1e-14) {
      best = costs[n];
      corners = [];
      let end = n;
      for (let side = 4; side > 0; side--) {
        end = parents[side][end];
        corners.unshift((start + end) % n);
      }
      corners.sort((a, b) => a - b);
    }
  }
  return corners.length === 4 ? corners : [0, 1, 2, 3].map(i => Math.floor((i * n) / 4));
}

export function validateSurfaceCorners(count: number, corners: readonly number[]): number[] {
  if (
    corners.length !== 4 ||
    new Set(corners).size !== 4 ||
    corners.some(i => !Number.isInteger(i) || i < 0 || i >= count)
  )
    throw new Error('Choose four distinct boundary points as corners.');
  const relative = corners.map(i => (i - corners[0] + count) % count);
  if (relative.some((i, k) => k > 0 && i <= relative[k - 1]))
    throw new Error('Choose corners A–D in order around the boundary.');
  return [...corners];
}
