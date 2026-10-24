// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import { appendMeshIds } from '../src/core/doc/ids';
import {
  surfaceBoundaryDraft,
  surfaceBoundarySegmentLength,
  createSurfaceFromDrawnBoundary,
  type SurfaceBoundaryPoint,
} from '../src/core/mesh/surface-boundary';
import { chartPoint, guideCharts } from '../src/core/mesh/surface-guides';
import { refreshSurfaces, bakeSurface } from '../src/core/mesh/surface-object';
import { measureSurfaceObject } from '../src/core/mesh/surface-measure';
import { len, sub } from '../src/core/math/vec';
import type { V3 } from '../src/core/doc/types';

const points = (positions: V3[]): SurfaceBoundaryPoint[] => positions.map(pos => ({ pos, vertex: null }));
const rectangle = points([
  [0, 0, 0],
  [60, 0, 0],
  [60, 0, 40],
  [0, 0, 40],
]);
const near = (a: V3, b: V3) => assert(len(sub(a, b)) < 1e-7, `${a} != ${b}`);
for (const boundary of [
  rectangle,
  [...rectangle].reverse(),
  points([
    [0, 0, 0],
    [30, 0, 0],
    [60, 0, 0],
    [60, 12, 40],
    [0, 4, 40],
  ]),
]) {
  const doc = blankMountain('DRAWN_SURFACE'),
    before = structuredClone(doc),
    draft = surfaceBoundaryDraft(doc, boundary),
    created = createSurfaceFromDrawnBoundary(doc, boundary, 15);
  assert(created.ok, created.ok ? '' : created.error);
  assert.deepEqual(doc, before, 'preview and commit are pure');
  assert.equal(draft.boundary.quads.length, 0, 'preview never generates terrain');
  assert.equal(created.surface.origin, 'boundary');
  assert.equal(created.surface.guides!.length, 4);
  const field = guideCharts(created.doc, created.surface);
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++) near(chartPoint(draft.charts, i / 10, j / 10), chartPoint(field, i / 10, j / 10));
  for (const point of boundary)
    assert(
      created.surface.controls.flat().some(id => {
        const index = created.doc.vertexIds.indexOf(id);
        return len(sub(created.doc.vertices.slice(index * 3, index * 3 + 3) as V3, point.pos)) < 1e-7;
      }),
      'every clicked point becomes an editable source control',
    );
  const saved = migrateMountain(serializeMountain(created.doc));
  assert.equal(refreshSurfaces(saved), saved);
  assert.deepEqual(saved.surfaces, created.doc.surfaces);
  const baked = bakeSurface(saved, saved.surfaces![0].id);
  assert(!baked.surfaces?.length);
  assert.equal(baked.freeEdges?.length ?? 0, 0, 'bake removes isolated sketch and guide edges');
}
{
  const doc = blankMountain('HOST');
  doc.vertices = [0, 0, 0, 0, 0, 40, 60, 0, 0, 60, 0, 40];
  doc.quads = [[0, 1, 2, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  doc.edgeHandles = { '0>1': [0, 8, 40 / 3], '1>0': [0, 8, -40 / 3] };
  const before = structuredClone(doc),
    boundary = [0, 2, 3, 1].map(vertex => ({ vertex, pos: doc.vertices.slice(vertex * 3, vertex * 3 + 3) as V3 }));
  const draft = surfaceBoundaryDraft(doc, boundary);
  assert(draft.boundary.edgeHandles!['0>3'][1] > 0, 'snapped existing curved edges retain their handles');
  assert(
    surfaceBoundarySegmentLength(doc, boundary[3], boundary[0]) > 42,
    'snapped segment measures the curved edge, not its chord',
  );
  assert.equal(surfaceBoundarySegmentLength(doc, boundary[0], boundary[1]), 60);
  assert.equal(
    surfaceBoundarySegmentLength(doc, { ...boundary[3], vertex: null }, boundary[0]),
    40,
    'moving a copied point releases the original curve',
  );
  const result = createSurfaceFromDrawnBoundary(doc, boundary, 15);
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(doc, before);
  assert.deepEqual(result.doc.vertices.slice(0, 12), doc.vertices);
  assert.deepEqual(result.doc.quads[0], doc.quads[0]);
  assert.deepEqual(result.doc.edgeHandles!['0>1'], doc.edgeHandles['0>1']);
}
{
  const doc = blankMountain('INVALID');
  for (const boundary of [
    rectangle.slice(0, 3),
    [rectangle[0], rectangle[1], rectangle[0], rectangle[3]],
    points([
      [0, 0, 0],
      [20, 0, 20],
      [0, 0, 20],
      [20, 0, 0],
    ]),
    points([
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
      [30, 0, 0],
    ]),
  ]) {
    const before = structuredClone(doc);
    assert(!createSurfaceFromDrawnBoundary(doc, boundary).ok);
    assert.deepEqual(doc, before);
  }
  const result = createSurfaceFromDrawnBoundary(doc, rectangle);
  assert(result.ok);
  assert(Math.abs(measureSurfaceObject(result.doc, result.surface).area - 2400) < 1e-6);
}

{
  const doc = blankMountain('BOUNDARY_STYLES'),
    boundary = points([
      [0, 0, 0],
      [20, 10, -8],
      [60, 0, 0],
      [60, 0, 40],
      [0, 0, 40],
    ]),
    corners = [0, 2, 3, 4];
  const smooth = surfaceBoundaryDraft(doc, boundary, corners, 'smooth'),
    crease = surfaceBoundaryDraft(doc, boundary, corners, 'creased');
  near(smooth.boundary.edgeHandles!['1>0'], smooth.boundary.edgeHandles!['1>2'].map(n => -n) as V3);
  near(crease.boundary.edgeHandles!['1>0'], [-20 / 3, -10 / 3, 8 / 3]);
  near(crease.boundary.edgeHandles!['1>2'], [40 / 3, -10 / 3, 8 / 3]);
  assert.notDeepEqual(
    smooth.boundary.edgeHandles,
    crease.boundary.edgeHandles,
    'the option changes actual source handles',
  );
  for (const key of ['2>3', '3>2', '3>4', '4>3', '4>0', '0>4'])
    near(smooth.boundary.edgeHandles![key], crease.boundary.edgeHandles![key]);
  assert.equal(smooth.outline.length, boundary.length * 12 + 1);
  near(smooth.outline[0], smooth.outline.at(-1)!);
  for (const style of ['smooth', 'creased'] as const) {
    const draft = style === 'smooth' ? smooth : crease,
      made = createSurfaceFromDrawnBoundary(doc, boundary, 15, corners, style);
    assert(made.ok, made.ok ? '' : made.error);
    const shape = guideCharts(made.doc, made.surface);
    for (const u of [0, 0.2, 0.5, 0.8, 1])
      for (const v of [0, 0.2, 0.5, 0.8, 1]) near(chartPoint(draft.charts, u, v), chartPoint(shape, u, v));
  }
  const host = blankMountain('COPIED_STYLE');
  host.vertices = rectangle.flatMap(p => p.pos);
  Object.assign(host, appendMeshIds(host, 4, 0));
  host.freeEdges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ];
  host.edgeHandles = { '0>1': [15, 8, 0], '1>0': [-15, 8, 0] };
  const snapped = rectangle.map((p, vertex) => ({ ...p, vertex })),
    before = structuredClone(host);
  const copied = surfaceBoundaryDraft(host, snapped, undefined, 'smooth');
  near(copied.boundary.edgeHandles!['0>1'], host.edgeHandles['0>1']);
  near(copied.boundary.edgeHandles!['1>0'], host.edgeHandles['1>0']);
  assert.deepEqual(host, before, 'smoothing a draft never edits its snapped host');
}
console.log(
  'DRAWN SURFACE: exact transient fill, perimeter controls, orientation, nonplanar/multi-edge loops, existing-edge preservation, invalid loops, persistence and bake passed.',
);
