// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, meshCreaseVertices, meshSmoothVertices, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { createSurfaceFromProfiles, placeSurfaceGuide, refreshSurfaces } from '../src/core/mesh/surface-object';
import { guideCharts, readGuideCurves, sectionCurve, type GuideCurve } from '../src/core/mesh/surface-guides';
import { setEdgesLocked } from '../src/core/mesh/locks';
import { len, mul, sub } from '../src/core/math/vec';

function fixture() {
  const doc = blankMountain('SURFACE_SMOOTH');
  for (let x = 0; x < 3; x++)
    for (let z = 0; z < 3; z++) doc.vertices.push(x * 30, x === 1 && z === 1 ? 12 : 0, z * 20);
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = [0, 3, 6].flatMap(
    i =>
      [
        [i, i + 1],
        [i + 1, i + 2],
      ] as [number, number][],
  );
  let result = createSurfaceFromProfiles(
    doc,
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 15 },
  );
  assert(result.ok);
  for (const at of [0.2, 0.73]) {
    result = placeSurfaceGuide(result.doc, result.surface, 'V', at);
    assert(result.ok, result.ok ? '' : result.error);
  }
  return result;
}

function assertSmooth(curve: GuideCurve) {
  for (let i = 1; i < curve.knots.length - 1; i++) {
    const before = curve.points[i - 1],
      after = curve.points[i],
      incoming = mul(sub(before[3], before[2]), 3 / (curve.knots[i] - curve.knots[i - 1])),
      outgoing = mul(sub(after[1], after[0]), 3 / (curve.knots[i + 1] - curve.knots[i]));
    assert(
      len(sub(incoming, outgoing)) < 1e-6,
      `guide ${curve.axis} at ${curve.at} has a tangent break at ${curve.knots[i]}`,
    );
  }
}

{
  const { doc, surface } = fixture(),
    selected = [...new Set(surface.controls.flat())].map(id => doc.vertexIds.indexOf(id)),
    positions = [...doc.vertices],
    paths = structuredClone(surface.controls);
  meshCreaseVertices(doc, selected);
  // The previous generic Smooth also failed after overrides had already been cleared at a crossing.
  doc.edgeHandles = undefined;
  meshSmoothVertices(doc, selected);
  const smoothed = readGuideCurves(doc, surface);
  smoothed.forEach(assertSmooth);
  meshSmoothVertices(doc, selected);
  assert.deepEqual(readGuideCurves(doc, surface), smoothed, 'smoothing again preserves the result');
  const refreshed = refreshSurfaces(doc),
    next = refreshed.surfaces![0];
  const charts = guideCharts(refreshed, next);
  next.guides!.forEach(g => assertSmooth(sectionCurve(charts, g.axis, g.at)));
  for (const id of paths.flat()) {
    const i = doc.vertexIds.indexOf(id),
      nextIndex = refreshed.vertexIds.indexOf(id);
    assert.deepEqual(
      refreshed.vertices.slice(nextIndex * 3, nextIndex * 3 + 3),
      positions.slice(i * 3, i * 3 + 3),
      'Smooth keeps the source points fixed',
    );
  }
  assert.deepEqual(next.controls, paths, 'all internal U/V guides keep their identities');
  const saved = migrateMountain(serializeMountain(refreshed));
  readGuideCurves(saved, saved.surfaces![0]).forEach(assertSmooth);
}
{
  const { doc, surface } = fixture();
  meshCreaseVertices(
    doc,
    [...new Set(surface.controls.flat())].map(id => doc.vertexIds.indexOf(id)),
  );
  const before = readGuideCurves(doc, surface),
    selected = surface.controls[1][1];
  meshSmoothVertices(doc, [doc.vertexIds.indexOf(selected)]);
  const after = readGuideCurves(doc, surface);
  surface.controls.forEach((path, i) => {
    if (!path.includes(selected))
      assert.deepEqual(after[i].points, before[i].points, 'unselected curves remain unchanged');
  });
  assert.notDeepEqual(after[1].points, before[1].points, 'a selected crossing smooths its incident guide segments');
}
{
  const { doc, surface } = fixture(),
    path = surface.controls[1],
    a = doc.vertexIds.indexOf(path[1]),
    b = doc.vertexIds.indexOf(path[2]);
  meshCreaseVertices(doc, [a, b]);
  setEdgesLocked(doc, [[a, b]], true);
  const forward = [...doc.edgeHandles![`${a}>${b}`]],
    reverse = [...doc.edgeHandles![`${b}>${a}`]];
  meshSmoothVertices(
    doc,
    [...new Set(surface.controls.flat())].map(id => doc.vertexIds.indexOf(id)),
  );
  assert.deepEqual(doc.edgeHandles![`${a}>${b}`], forward, 'locked guide tangents are retained');
  assert.deepEqual(doc.edgeHandles![`${b}>${a}`], reverse);
}
console.log(
  'SURFACE SMOOTH: all U/V guides, crossing continuity, nonuniform knots, local scope, fixed control points, locks and persistence passed.',
);
