// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { createSurfaceFromProfiles, placeSurfaceGuide, rebuildSurface } from '../src/core/mesh/surface-object';
import { measureSurfaceObject } from '../src/core/mesh/surface-measure';
import { guideCharts, surfaceGuideSnapper, surfaceGuideSnapTargets } from '../src/core/mesh/surface-guides';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import type { V3 } from '../src/core/doc/types';

function fixture(slope = false) {
  const doc = blankMountain('SURFACE_MEASURE');
  for (let x = 0; x <= 2; x++)
    for (let z = 0; z <= 2; z++) doc.vertices.push(x * 30, slope ? z * 10 : x === 1 && z === 1 ? 12 : 0, z * 20);
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = [0, 3, 6].flatMap(
    i =>
      [
        [i, i + 1],
        [i + 1, i + 2],
      ] as [number, number][],
  );
  const result = createSurfaceFromProfiles(
    migrateMountain(serializeMountain(doc)),
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 15 },
  );
  assert(result.ok, result.ok ? '' : result.error);
  return result;
}
const near = (a: number, b: number, tolerance = 1e-6) => assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
{
  const result = fixture(true),
    measured = measureSurfaceObject(result.doc, result.surface);
  near(measured.area, 60 * Math.hypot(40, 20));
  near(measured.curveLength(1), Math.hypot(40, 20));
  assert(measured.averagePatchSize);
  const denseBefore = measured.averagePatchSize;
  const dense = rebuildSurface(result.doc, { ...result.surface, patchSizeM: 5 });
  assert(dense.ok);
  assert(dense.surface.patches.length > result.surface.patches.length);
  const denseMetrics = measureSurfaceObject(dense.doc, dense.surface);
  near(denseMetrics.area, measured.area);
  assert(denseMetrics.averagePatchSize);
  assert(denseMetrics.averagePatchSize.length < denseBefore.length);
  assert(denseMetrics.averagePatchSize.width < denseBefore.width);
  const rectangle = (length: number, width: number): V3[] =>
    Array.from({ length: 16 }, (_, i) => [(Math.floor(i / 4) * length) / 3, 0, ((i % 4) * width) / 3]);
  const patches = result.surface.patches.slice(0, 2).map((p, i) => ({
    ...p,
    base: rectangle(i ? 18 : 6, i ? 4 : 20),
  }));
  const custom = { ...result.surface, patches };
  const average = measureSurfaceObject(result.doc, custom).averagePatchSize!;
  near(average.length, 12);
  near(average.width, 12);
  patches[0].base = patches[0].base.map(([x, , z], i) => [x, i >= 4 && i < 12 ? 10 : 0, z]);
  const curved = measureSurfaceObject(result.doc, custom).averagePatchSize!;
  assert(curved.length > average.length, 'average dimensions follow patch curvature, not just corner distances');
  near(curved.width, average.width);
  assert.equal(measureSurfaceObject(result.doc, { ...result.surface, patches: [] }).averagePatchSize, null);
}
{
  const result = fixture(),
    before = structuredClone(result.doc),
    charts = guideCharts(result.doc, result.surface);
  const targets = surfaceGuideSnapTargets(result.doc, result.surface, 'V');
  assert.equal(targets.length, 9);
  const snap = surfaceGuideSnapper(charts, 'V', targets);
  const hit = snap(0.502, () => 0.25);
  near(hit.at, 0.5);
  assert.equal(hit.points.length, 3, 'preview highlights all existing crossing points that will be reused');
  assert.deepEqual(result.doc, before, 'hover and snap queries are read-only');
  assert.equal(snap(0.6, () => 0.25).points.length, 0, 'a distant point does not attract the curve');
  const expected = result.surface.controls.map(row => row[1]);
  assert.deepEqual(hit.points.map(p => p.id).sort(), [...expected].sort());
  const added = placeSurfaceGuide(result.doc, result.surface, 'V', hit.at);
  assert(added.ok, added.ok ? '' : added.error);
  assert.deepEqual(added.surface.controls.at(-1), expected, 'commit shares existing point IDs, not coincident copies');
  assert.equal(added.doc.vertexIds.length, result.doc.vertexIds.length);
  assert.deepEqual(added.surface.patches, result.surface.patches);
  const { mesh, edgeHandle } = meshFromDoc(added.doc),
    old = meshFromDoc(result.doc);
  result.surface.patches.forEach(p => {
    const q = result.doc.quadIds.indexOf(p.quad);
    assert.deepEqual(
      quadControlPoints(mesh, edgeHandle, q, added.doc.quadTwist?.[q]),
      quadControlPoints(old.mesh, old.edgeHandle, q, result.doc.quadTwist?.[q]),
    );
  });
  const measured = measureSurfaceObject(result.doc, result.surface);
  assert(measured.area > 60 * 40, 'area follows the curved hill, not its footprint');
  assert(measured.curveLength(1) > 40, 'length follows the curved guide, not its endpoint chord');
  near(measureSurfaceObject(added.doc, added.surface).area, measured.area);
  const saved = migrateMountain(serializeMountain(added.doc));
  assert.deepEqual(saved.surfaces![0].controls.at(-1), expected);
  // A newly inserted sparse guide still displays the complete curved section carried by the rest quilt.
  const sparse = placeSurfaceGuide(result.doc, result.surface, 'U', 0.25);
  assert(sparse.ok);
  assert.equal(sparse.surface.controls.at(-1)!.length, 2);
  assert(measureSurfaceObject(sparse.doc, sparse.surface).curveLength(sparse.surface.controls.length - 1) > 40);
}
console.log(
  'SURFACE METRICS/SNAP: curved 3D area, average fitted patch dimensions, visible guide length, density independence, transient snapping, shared point IDs, unchanged terrain and persistence passed.',
);
