import type { V3 } from '../doc/types';
import { patchNormal } from '../math/bezier';

/** Reuse the four cubic rows and their derivatives across a tessellated patch. Scalar arithmetic keeps
 * the analytic evaluator's operation order, without allocating vector arrays at every surface sample. */
export function createPatchSampler(res: number) {
  const side = res + 1,
    basis = Array.from({ length: side }, (_, i) => {
      const t = i / res,
        s = 1 - t;
      return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
    }),
    derivative = Array.from({ length: side }, (_, i) => {
      const t = i / res,
        s = 1 - t;
      return [3 * s * s, 6 * s * t, 3 * t * t];
    }),
    rows = new Float64Array(side * 12),
    derivatives = new Float64Array(side * 12),
    du = new Float64Array(3),
    dv = new Float64Array(3);
  return (cp: V3[], positions: Float32Array, normals: Float32Array, offset: number) => {
    for (let v = 0; v < side; v++)
      for (let row = 0; row < 4; row++)
        for (let k = 0; k < 3; k++) {
          const a = cp[row * 4][k],
            b = cp[row * 4 + 1][k],
            c = cp[row * 4 + 2][k],
            d = cp[row * 4 + 3][k],
            w = basis[v],
            h = derivative[v],
            at = v * 12 + row * 3 + k;
          rows[at] = a * w[0] + b * w[1] + (c * w[2] + d * w[3]);
          derivatives[at] = (b - a) * h[0] + (c - b) * h[1] + (d - c) * h[2];
        }
    for (let u = 0; u < side; u++)
      for (let v = 0; v < side; v++) {
        const at = offset + (u * side + v) * 3,
          from = v * 12,
          w = basis[u],
          h = derivative[u];
        for (let k = 0; k < 3; k++) {
          const a = rows[from + k],
            b = rows[from + 3 + k],
            c = rows[from + 6 + k],
            d = rows[from + 9 + k];
          positions[at + k] = a * w[0] + b * w[1] + (c * w[2] + d * w[3]);
          du[k] = (b - a) * h[0] + (c - b) * h[1] + (d - c) * h[2];
          dv[k] =
            derivatives[from + k] * w[0] +
            derivatives[from + 3 + k] * w[1] +
            (derivatives[from + 6 + k] * w[2] + derivatives[from + 9 + k] * w[3]);
        }
        const x = dv[1] * du[2] - dv[2] * du[1],
          y = dv[2] * du[0] - dv[0] * du[2],
          z = dv[0] * du[1] - dv[1] * du[0],
          length = Math.hypot(x, y, z);
        if (length < 1e-9) normals.set(patchNormal(cp, u / res, v / res), at);
        else {
          const inverse = 1 / length;
          normals[at] = x * inverse;
          normals[at + 1] = y * inverse;
          normals[at + 2] = z * inverse;
        }
      }
  };
}
