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
assert.throws(() => bendPoints(points, { ...settings, angle: Infinity }), /angle/);
assert.throws(() => bendPoints(points, { ...settings, risePerTurn: NaN }), /rise/);
const longPoints: V3[] = Array.from({ length: 17 }, (_, i) => [i * 7.5, 0, 0]);
const loop = bendPoints(longPoints, { ...settings, angle: 360 });
near(loop.points[0], loop.points[16]);
assert.equal(loop.radiusM, 120 / (2 * Math.PI));
const springSettings: BendSettings = { ...settings, direction: 2, angle: 720, risePerTurn: -12 };
const spring = bendPoints(longPoints, springSettings);
near(spring.points[0], [0, 0, 0]);
near(spring.points[8], [0, -12, 0]);
near(spring.points[16], [0, -24, 0]);
near(bendPoints(longPoints, { ...springSettings, angle: -720 }).points[16], [0, -24, 0]);
near(bendPoints(longPoints, { ...springSettings, anchor: 'centre' }).points[8], longPoints[8]);
near(bendPoints(longPoints, { ...springSettings, anchor: 'end' }).points[16], longPoints[16]);
const springBox = bendFixture('SPRING', 16);
springBox.doc.vertices = springBox.doc.vertices.map((n, i) => (i % 3 === 0 ? n * 3 : n));
const coiledBox = bendSubdivisionCage(springBox.doc, springBox.surface.id, springSettings);
const springSource = subdivisionSource(springBox.doc, springBox.surface);
const springEnd = springSource.points.findIndex(p => p[0] === 360);
near(coiledBox.points[springEnd], [0, springSource.points[springEnd][1] - 24, springSource.points[springEnd][2]]);
assert(
  coiledBox.doc.vertices.every(Number.isFinite),
  'a thick source cage regenerates as a descending horizontal coil',
);
assert(bendPoints(longPoints, { ...settings, angle: 270 }).points.every(p => p.every(Number.isFinite)));
assert.throws(() => bendPoints(points, { ...settings, angle: 720 }), /more divisions/);
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
const cagePoints = subdivisionSource(source, fixture.surface).points;
const offsets: V3[] = cagePoints.map((_, i) => (i === 0 ? [0, 12, 3] : [0, 0, 0]));
const manual = bendSubdivisionCage(source, fixture.surface.id, { ...settings, angle: 0 }, offsets);
near(subdivisionSource(manual.doc, manual.surface).points[0], [
  cagePoints[0][0],
  cagePoints[0][1] + 12,
  cagePoints[0][2] + 3,
]);
assert.notDeepEqual(
  manual.doc.vertices,
  source.vertices,
  'manual point edits regenerate the terrain without requiring an angle',
);
assert.deepEqual(manual.surface.subdivision, source.surfaces![0].subdivision);
assert.throws(() => bendSubdivisionCage(source, fixture.surface.id, settings, []), /offset/);
assert.deepEqual(source, before, 'manual offsets also leave the frozen source untouched');
const serialized = serializeMountain(bent.doc);
assert.deepEqual(serialized.surfaces![0].subdivision, bent.surface.subdivision);
assert.throws(() => bendSubdivisionCage(source, 'missing', settings), /live subdivision/);
console.log(
  'SUBDIVISION BEND: PASS (arcs, full turns, descending springs, manual points, anchors, thickness and stable topology)',
);
