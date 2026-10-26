// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { createSurfaceFromProfiles, rebuildSurface, refreshSurfaces } from '../src/core/mesh/surface-object';
import { chartPoint, guideCharts } from '../src/core/mesh/surface-guides';
import { patchPoint } from '../src/core/math/bezier';
import type { V3 } from '../src/core/doc/types';

{
  const doc = blankMountain(),
    across = [0, 0.1, 1],
    knots = [
      [0, 0.15, 1],
      [0, 0.3, 0.8, 1],
      [0, 1],
    ],
    profiles: number[][] = [];
  doc.edgeHandles = {};
  for (let row = 0; row < across.length; row++) {
    const ids: number[] = [];
    for (const t of knots[row]) {
      ids.push(doc.vertices.length / 3);
      doc.vertices.push(across[row] * 100, across[row] * 10 + t * 5, t * 100);
    }
    profiles.push(ids);
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1],
        b = ids[i];
      doc.freeEdges!.push([a, b]);
      const d = [0, 1, 2].map(k => (doc.vertices[b * 3 + k] - doc.vertices[a * 3 + k]) / 3) as V3;
      doc.edgeHandles[`${a}>${b}`] = d;
      doc.edgeHandles[`${b}>${a}`] = d.map(n => -n) as V3;
    }
  }
  Object.assign(doc, appendMeshIds(doc, doc.vertices.length / 3, 0));
  const before = structuredClone(doc),
    options = { patchSizeM: 25, profileStations: across, pointStations: knots },
    made = createSurfaceFromProfiles(doc, profiles, options);
  assert(made.ok, made.ok ? '' : made.error);
  assert.deepEqual(doc, before);
  assert(made.surface.patches.length <= 25, 'nonuniform point counts do not introduce artificial fitting boundaries');
  const charts = guideCharts(made.doc, made.surface);
  for (const u of [0, 0.1, 0.35, 0.8, 1])
    for (const v of [0, 0.1, 0.5, 1]) {
      const p = chartPoint(charts, u, v);
      assert(Math.abs(p[0] - v * 100) < 1e-7, 'profile spacing follows the supplied correspondence');
      assert(Math.abs(p[1] - p[0] * 0.1 - p[2] * 0.05) < 1e-7);
    }
  for (const invalid of [
    { ...options, profileStations: [0, 0, 1] },
    { ...options, profileStations: [0, 0.1] },
    { ...options, pointStations: [[0, 1]] },
    { ...options, pointStations: [[0, 0.5, 0.4], ...knots.slice(1)] },
  ])
    assert(!createSurfaceFromProfiles(doc, profiles, invalid).ok);
  console.log('✓ nonuniform profile/point correspondence stays planar, sparse, validated and pure');
}

{
  const doc = blankMountain(),
    profiles: number[][] = [];
  for (let x = 0; x < 3; x++) {
    const row: number[] = [];
    for (let z = 0; z < 5; z++) {
      row.push(doc.vertices.length / 3);
      doc.vertices.push(x * 30, x === 1 && z % 2 ? 3 : 0, z * 20);
    }
    profiles.push(row);
    doc.freeEdges!.push(...row.slice(1).map((b, i) => [row[i], b] as [number, number]));
  }
  Object.assign(doc, appendMeshIds(doc, 15, 0));
  const precise = createSurfaceFromProfiles(doc, profiles, { patchSizeM: 45, fitToleranceM: 0.05 });
  assert(precise.ok, precise.ok ? '' : precise.error);
  const changed = { ...precise.doc, surfaces: [{ ...precise.surface, fitToleranceM: 3 }] },
    relaxed = refreshSurfaces(changed),
    surface = relaxed.surfaces![0];
  assert.equal(surface.fitToleranceM, 3);
  assert.equal(surface.evaluated.fitToleranceM, 3, 'changing only the allowance triggers a fresh fit');
  assert(surface.patches.length < precise.surface.patches.length, 'a generous terrain allowance permits fewer patches');
  const charts = guideCharts(relaxed, surface);
  for (const patch of surface.patches)
    for (const u of [0, 0.2, 0.5, 0.8, 1])
      for (const v of [0, 0.2, 0.5, 0.8, 1]) {
        const target = chartPoint(
            charts,
            patch.domain[0] + u * (patch.domain[1] - patch.domain[0]),
            patch.domain[2] + v * (patch.domain[3] - patch.domain[2]),
          ),
          actual = patchPoint(patch.base, u, v);
        assert(Math.hypot(...actual.map((n, i) => n - target[i])) <= 3 + 1e-7);
      }
  const reopened = migrateMountain(serializeMountain(relaxed));
  assert.equal(reopened.surfaces![0].fitToleranceM, 3);
  assert.equal(refreshSurfaces(reopened), reopened, 'the saved evaluation stamp preserves the chosen allowance');
  const reset = rebuildSurface(relaxed, { ...surface, fitToleranceM: undefined });
  assert(reset.ok);
  for (const fitToleranceM of [0, -1, NaN, Infinity, 46])
    assert(!rebuildSurface(relaxed, { ...surface, fitToleranceM }).ok);
  console.log('✓ explicit fitting error reduces geometry, respects the error bound, round-trips and resets');
}
