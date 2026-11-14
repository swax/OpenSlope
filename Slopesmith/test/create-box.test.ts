// tier: fast
import assert from 'node:assert/strict';
import type { V3 } from '../src/core/doc/types';
import { appendBox, boxFromClicks, moveBoxBounds, planBox, resizeBox } from '../src/core/mesh/ops/box';
import { blankMountain } from '../src/core/doc/mountain';
import { add, cross, dot, len, mul, sub } from '../src/core/math/vec';
import { quadPerimeterEdges } from '../src/core/mesh/primitives';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { patchNormal } from '../src/core/math/bezier';
import { checkManifold } from '../src/core/mesh/ops/contract';

const draft = boxFromClicks([10, 20, 30], [100, 20, 30], [85, 20, 90], 30);
assert.deepEqual(draft.length, [90, 0, 0]);
assert.deepEqual(draft.width, [0, 0, 60]);
assert.deepEqual(draft.height, [0, 30, 0]);
const planned = planBox(draft);
assert(planned.ok);
assert.deepEqual(planned.plan.divisions, { length: 3, width: 2, height: 1 });
assert.equal(planned.plan.quads.length, 22);
assert.equal(planned.plan.points.length, 24);
assert.equal(new Set(planned.plan.points.map(p => p.join(','))).size, 24, 'seams share their vertices');

const source = blankMountain('BOX', 30);
const before = structuredClone(source);
const result = appendBox(source, planned.plan);
assert(result.ok);
assert.deepEqual(source, before, 'append preserves its input');
assert(checkManifold(result.doc.quads).ok);
const edges = new Map<string, [number, number][]>();
for (const quad of result.doc.quads)
  for (const edge of quadPerimeterEdges(quad)) {
    const key = [...edge].sort((a, b) => a - b).join(':');
    edges.set(key, [...(edges.get(key) ?? []), edge]);
  }
for (const uses of edges.values()) {
  assert.equal(uses.length, 2, 'every edge closes against another face');
  assert.deepEqual(uses[0], [...uses[1]].reverse(), 'shared edges run in opposite directions');
}
assert.equal(planned.plan.points.length - edges.size + result.doc.quads.length, 2, 'one closed shell');
const centre = add(draft.origin, mul(add(add(draft.length, draft.width), draft.height), 0.5));
const { mesh, edgeHandle } = meshFromDoc(result.doc);
for (let q = 0; q < result.doc.quads.length; q++) {
  const cp = quadControlPoints(mesh, edgeHandle, q);
  const normal = patchNormal(cp, 0.5, 0.5);
  const faceCentre = mul(
    cp.reduce((sum, p) => add(sum, p), [0, 0, 0]),
    1 / cp.length,
  );
  assert(dot(normal, sub(faceCentre, centre)) > 0, 'every patch faces outward');
  for (const p of cp) assert(Math.abs(dot(normal, sub(p, cp[0]))) < 1e-8, 'all sixteen controls stay on the flat face');
}
const second = appendBox(result.doc, planned.plan);
assert(second.ok);
assert.deepEqual(second.doc.vertexIds.slice(0, result.doc.vertexIds.length), result.doc.vertexIds);
assert.deepEqual(second.doc.quadIds.slice(0, result.doc.quadIds.length), result.doc.quadIds);
assert.equal(new Set(second.doc.vertexIds).size, second.doc.vertexIds.length);

const taller = resizeBox(draft, 'height', 90);
assert.equal(len(taller.height), 90);
assert.deepEqual(taller.length, draft.length);
assert.deepEqual(taller.width, draft.width);
const counted = planBox(taller, { patchSize: null, divisions: { length: 2, width: 3, height: 4 } });
assert(counted.ok);
assert.equal(counted.plan.quads.length, 52);
assert.deepEqual(counted.plan.dimensions, { length: 90, width: 60, height: 90 });
const vertical = planBox(boxFromClicks([0, 0, 0], [0, 60, 0], [0, 60, 90], 30));
assert(vertical.ok, 'vertical bases also form a box');
const reverse = planBox(boxFromClicks([100, 20, 30], [10, 20, 30], [10, 20, 90], 30));
assert(reverse.ok);
assert(
  reverse.plan.points.some(p => p[1] === 50),
  'reversing the base still raises height upward',
);

for (const bad of [0, -1, NaN, Infinity])
  assert.equal(planBox(draft, { patchSize: bad, divisions: { length: 1, width: 1, height: 1 } }).ok, false);
for (const bad of [0, -1, 1.5, 257, NaN])
  assert.equal(planBox(draft, { divisions: { length: bad, width: 1, height: 1 } }).ok, false);
assert.equal(planBox(draft, { divisions: { length: 256, width: 256, height: 256 } }).ok, false);
assert.equal(planBox(boxFromClicks([0, 0, 0], [0, 0, 0], [30, 0, 30])).ok, false);
assert.equal(planBox(boxFromClicks([0, 0, 0], [30, 0, 0], [60, 0, 0])).ok, false);
assert.equal(planBox({ ...draft, height: [1, 30, 0] }).ok, false, 'sheared axes are refused');
assert.equal(planBox({ ...draft, origin: [NaN, 0, 0] }).ok, false);
assert.equal(
  planBox({ ...draft, height: [0, Number.MAX_VALUE, Number.MAX_VALUE] }).ok,
  false,
  'overflowing dimensions are refused',
);
assert(dot(cross(draft.length, draft.height), draft.width) > 0);
const nearFace = moveBoxBounds(draft, { length: 0 }, [15, 100, 100]);
assert.deepEqual(nearFace.origin, [25, 20, 30]);
assert.deepEqual(nearFace.length, [75, 0, 0]);
assert.deepEqual(nearFace.width, draft.width);
assert.deepEqual(nearFace.height, draft.height);
const edge = moveBoxBounds(draft, { width: 1, height: 0 }, [100, 5, 20]);
assert.deepEqual(edge.origin, [10, 25, 30]);
assert.deepEqual(edge.width, [0, 0, 80]);
assert.deepEqual(edge.height, [0, 25, 0]);
assert.deepEqual(edge.length, draft.length);
const clamped = moveBoxBounds(draft, { height: 1 }, [0, -100, 0]);
assert.equal(len(clamped.height), 0.5, 'face drags stop before crossing the opposite boundary');
assert(planBox(clamped).ok);
const tilted = {
  origin: [0, 0, 0] as V3,
  length: [60, 0, 60] as V3,
  width: [-20, 0, 20] as V3,
  height: [0, -30, 0] as V3,
};
const resized = moveBoxBounds(tilted, { length: 1, height: 0 }, [10, 5, 10]);
assert.deepEqual(resized.origin, [0, 5, 0]);
assert(len(sub(resized.length, [70, 0, 70])) < 1e-8);
assert.deepEqual(resized.height, [0, -35, 0]);
assert(planBox(resized).ok, 'rotated boxes extruded downward keep perpendicular axes');
console.log('CREATE BOX: PASS (closed welded shell, outward normals, flat patches, sizing, guards, stable IDs)');
