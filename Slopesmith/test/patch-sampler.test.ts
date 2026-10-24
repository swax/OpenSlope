// tier: fast
import assert from 'node:assert/strict';
import type { V3 } from '../src/core/doc/types';
import { cubicPoint, patchDerivatives, patchNormal, patchPoint } from '../src/core/math/bezier';
import { createPatchSampler } from '../src/core/mesh/patch-sampler';
import { add, cross, len, mul, norm, sub } from '../src/core/math/vec';

// Independent oracle: the original vector evaluator, including its degenerate-boundary fallback.
function cubic(p: V3[], t: number): V3 {
  const s = 1 - t;
  return add(add(mul(p[0], s * s * s), mul(p[1], 3 * s * s * t)), add(mul(p[2], 3 * s * t * t), mul(p[3], t * t * t)));
}
function derivative(p: V3[], t: number): V3 {
  const s = 1 - t;
  return add(add(mul(sub(p[1], p[0]), 3 * s * s), mul(sub(p[2], p[1]), 6 * s * t)), mul(sub(p[3], p[2]), 3 * t * t));
}
function reference(cp: V3[], u: number, v: number) {
  const rows = [0, 4, 8, 12].map(i => cp.slice(i, i + 4));
  const du = derivative(
      rows.map(row => cubic(row, v)),
      u,
    ),
    dv = cubic(
      rows.map(row => derivative(row, v)),
      u,
    );
  return {
    point: cubic(
      rows.map(row => cubic(row, v)),
      u,
    ),
    du,
    dv,
  };
}
function normal(cp: V3[], u: number, v: number) {
  let { du, dv } = reference(cp, u, v),
    n = cross(dv, du);
  if (len(n) < 1e-9) {
    ({ du, dv } = reference(cp, Math.min(Math.max(u, 1e-3), 1 - 1e-3), Math.min(Math.max(v, 1e-3), 1 - 1e-3)));
    n = cross(dv, du);
  }
  return norm(n);
}

let seed = 147;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
for (const res of [4, 8, 12]) {
  const sample = createPatchSampler(res),
    size = (res + 1) ** 2 * 3,
    offset = 6;
  for (let test = 0; test < 24; test++) {
    const cp = Array.from({ length: 16 }, (_, i): V3 => [
      Math.floor(i / 4) * 15 + (random() - 0.5) * 8,
      (random() - 0.5) * 40,
      (i % 4) * 15 + (random() - 0.5) * 8,
    ]);
    if (test === 0) for (let i = 0; i < 16; i++) cp[i] = [0, 0, 0];
    if (test === 1) for (let i = 12; i < 16; i++) cp[i] = [30, 10, 20]; // Collapsed wedge edge.
    const positions = new Float32Array(size + offset).fill(-1),
      normals = positions.slice(),
      expectedP = positions.slice(),
      expectedN = positions.slice();
    for (let u = 0; u <= res; u++)
      for (let v = 0; v <= res; v++) {
        const at = offset + (u * (res + 1) + v) * 3;
        expectedP.set(reference(cp, u / res, v / res).point, at);
        expectedN.set(normal(cp, u / res, v / res), at);
      }
    sample(cp, positions, normals, offset);
    assert.deepEqual(positions, expectedP, `positions at res ${res}, case ${test}`);
    assert.deepEqual(normals, expectedN, `normals at res ${res}, case ${test}`);
    for (let i = 0; i < 12; i++) {
      const u = random(),
        v = random(),
        expected = reference(cp, u, v);
      assert.deepEqual(cubicPoint(cp[0], cp[1], cp[2], cp[3], u), cubic(cp.slice(0, 4), u));
      assert.deepEqual(patchPoint(cp, u, v), expected.point);
      assert.deepEqual(patchDerivatives(cp, u, v), { du: expected.du, dv: expected.dv });
      assert.deepEqual(patchNormal(cp, u, v), normal(cp, u, v));
    }
  }
}
console.log(
  'PATCH SAMPLER PASS: byte-identical analytic positions/normals across curved, degenerate and wedge patches.',
);
