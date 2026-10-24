// tier: fast
import assert from 'node:assert/strict';
import { bakeSunShadow, bakeAO } from '../src/core/lighting/occlusion';

const plane = new Float32Array([0, 0, 0, 100, 300, 0, 0, 0, 100, 100, 300, 100]),
  triangles = new Uint32Array([0, 2, 1, 1, 2, 3]),
  points = new Float32Array(
    Array.from({ length: 40 * 40 }, (_, i) => {
      const x = 10 + (i % 40) * 2,
        z = 10 + Math.floor(i / 40) * 2;
      return [x, 3 * x, z];
    }).flat(),
  );
for (const resolution of [32, 128])
  for (const direction of [
    [0.3, 0.95, 0],
    [0.31, 0.95, 0.02],
    [0, 1, 0],
    [-0.8, 0.5, 0.2],
  ]) {
    const length = Math.hypot(...direction),
      dir = direction.map(n => n / length) as [number, number, number],
      shadow = bakeSunShadow(plane, triangles, dir, resolution, points);
    assert(
      shadow.every(v => v > 0.99999),
      'an unobstructed plane must not shadow itself, including at grazing angles',
    );
  }
const normal = [-3 / Math.sqrt(10), 1 / Math.sqrt(10), 0],
  normals = new Float32Array(Array.from({ length: 4 }, () => normal).flat()),
  queryNormals = new Float32Array(Array.from({ length: points.length / 3 }, () => normal).flat()),
  ao = bakeAO(plane, triangles, normals, 16, 64, { positions: points, normals: queryNormals });
assert(
  ao.every(v => v > 0.99999),
  'an open sloped plane sees the sky without blotchy self occlusion',
);

// Independent geometry: a raised square casts a real shadow on an unconnected receiver plane.
const blocker = new Float32Array([-10, 20, -10, 10, 20, -10, -10, 20, 10, 10, 20, 10]),
  query = new Float32Array(Array.from({ length: 801 }, (_, i) => [-20 + i * 0.05, 0, 0]).flat()),
  shadow = bakeSunShadow(blocker, triangles, [0, 1, 0], 32, query);
assert.equal(shadow[400], 0, 'a real blocker still casts a dark shadow');
assert.equal(shadow[0], 1, 'points beyond the projected blocker remain lit');
assert.equal(shadow.at(-1), 1);
const left = Array.from(shadow.slice(0, 400));
assert(
  left.some(v => v > 0.05 && v < 0.95),
  'the shadow edge is filtered',
);
assert(
  left.every((v, i) => !i || v <= left[i - 1] + 1e-6),
  'a straight shadow edge has no isolated dark/light spots',
);
assert(
  Math.max(...left.slice(1).map((v, i) => Math.abs(v - left[i]))) < 0.15,
  'sub-texel movement changes visibility smoothly',
);
const combined = new Float32Array([...query, 1e7, 0, 1e7]),
  probes = bakeSunShadow(blocker, triangles, [0, 1, 0], 32, combined);
assert.deepEqual(probes.slice(0, shadow.length), shadow, 'adding a far-away prop probe cannot coarsen terrain shadows');
assert.equal(probes.at(-1), 1);
console.log(
  'OCCLUSION PASS: unshadowed grazing planes, open-sky AO, real blockers, filtered edges and independent prop queries.',
);
