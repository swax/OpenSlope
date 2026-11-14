// tier: fast
import assert from 'node:assert/strict';
import {
  bendPoints,
  bendSubdivisionCage,
  defaultBendSettings,
  type BendSettings,
} from '../src/core/mesh/subdivision-bend';
import { creaseSubdivisionSelection, subdivisionSource } from '../src/core/mesh/subdivision-object';
import { subdivisionEdges } from '../src/core/mesh/subdivision-topology';
import { serializeMountain } from '../src/core/doc/serialize';
import { bendFixture } from './subdivision-bend.fixture';
import type { V3 } from '../src/core/doc/types';

const near = (actual: readonly number[], expected: readonly number[], tolerance = 1e-8) =>
  assert(
    actual.every((n, i) => Math.abs(n - expected[i]) < tolerance),
    `${actual} != ${expected}`,
  );
const points: V3[] = [0, 30, 60, 90, 120].map(x => [x, 0, 0]);
const settings: BendSettings = { axis: 0, direction: 1, angle: 90, anchor: 'start' };
const quarter = bendPoints(points, settings),
  radius = 240 / Math.PI;
near(quarter.points[0], points[0]);
near(quarter.points[4], [radius, radius, 0]);
for (const p of quarter.points) assert(Math.abs(Math.hypot(p[0], p[1] - radius) - radius) < 1e-8);
near(bendPoints(points, { ...settings, angle: -90 }).points[4], [radius, -radius, 0]);
near(bendPoints(points, { ...settings, anchor: 'end' }).points[4], points[4]);
const arch = bendPoints(points, { ...settings, angle: -180, anchor: 'centre' });
near(arch.points[2], points[2]);
near(arch.points[0], [60 - 120 / Math.PI, -120 / Math.PI, 0]);
near(arch.points[4], [60 + 120 / Math.PI, -120 / Math.PI, 0]);
near(bendPoints(points, { ...settings, angle: 1e-8 }).points[4], points[4], 1e-7);
assert.deepEqual(bendPoints(points, { ...settings, angle: 0 }).points, points);
const crossSections: V3[] = points.flatMap(
  ([x]) =>
    [
      [x, -5, 3],
      [x, 5, 3],
    ] as V3[],
);
const bentSections = bendPoints(crossSections, settings);
for (let i = 0; i < bentSections.points.length; i += 2)
  assert(
    Math.abs(Math.hypot(...bentSections.points[i].map((n, a) => n - bentSections.points[i + 1][a])) - 10) < 1e-8,
    'section thickness stays fixed',
  );
for (const [axis, direction] of [
  [1, 2],
  [2, 0],
] as const) {
  const along: V3[] = points.map(([x]) => {
    const p: V3 = [0, 0, 0];
    p[axis] = x;
    return p;
  });
  const bent = bendPoints(along, { ...settings, axis, direction });
  assert(Math.abs(bent.points[4][axis] - radius) < 1e-8 && Math.abs(bent.points[4][direction] - radius) < 1e-8);
}
assert.deepEqual(defaultBendSettings(points), { ...settings, angle: 0 });
assert.throws(() => bendPoints(points, { ...settings, direction: 0 }), /different/);
assert.throws(() => bendPoints(points, { ...settings, angle: NaN }), /angle/);
assert.throws(() => bendPoints(points, { ...settings, angle: 181 }), /angle/);
assert.throws(
  () =>
    bendPoints(
      [
        [0, 0, 0],
        [0, 10, 0],
      ],
      settings,
    ),
  /length/,
);
assert.throws(
  () =>
    bendPoints(
      [
        [0, -100, 0],
        [120, 100, 0],
      ],
      settings,
    ),
  /thickness/,
);
assert.throws(() => bendPoints([points[0], points[4]], { ...settings, angle: 180 }), /more divisions/);

const fixture = bendFixture();
const marked = creaseSubdivisionSelection(fixture.doc, [fixture.surface.controls[0][0]], [], true)!;
const source = creaseSubdivisionSelection(marked, [], [subdivisionEdges(fixture.surface)[0]], true)!;
source.quadPaint = { 0: 7 };
source.quadLabels = { 0: ['label:bent'] };
const before = structuredClone(source);
const bent = bendSubdivisionCage(source, fixture.surface.id, settings);
assert.deepEqual(source, before, 'the frozen source remains untouched');
assert.deepEqual(bent.doc.vertexIds, source.vertexIds);
assert.deepEqual(bent.doc.quadIds, source.quadIds);
assert.deepEqual(bent.doc.quads, source.quads);
assert.deepEqual(
  bent.surface.subdivision,
  source.surfaces![0].subdivision,
  'sharp edges, corners, level and source topology survive',
);
assert.deepEqual(bent.doc.quadPaint, source.quadPaint);
assert.deepEqual(bent.doc.quadLabels, source.quadLabels);
assert.notDeepEqual(bent.doc.vertices, source.vertices, 'generated terrain follows the bent source');
near(
  subdivisionSource(bent.doc, bent.surface).points[0],
  bendPoints(subdivisionSource(source, fixture.surface).points, settings).points[0],
);
assert.equal(bendSubdivisionCage(source, fixture.surface.id, { ...settings, angle: 0 }).doc, source);
const serialized = serializeMountain(bent.doc);
assert.deepEqual(serialized.surfaces![0].subdivision, bent.surface.subdivision);
assert.throws(() => bendSubdivisionCage(source, 'missing', settings), /live subdivision/);
console.log(
  'SUBDIVISION BEND: PASS (quarter pipe, arch, signed axes, anchors, thickness, stable topology and metadata)',
);
