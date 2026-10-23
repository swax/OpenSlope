// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { canonicalJson } from '../src/core/doc/canonical';
import {
  createSurfaceFromProfiles,
  deleteSurfaceControls,
  deleteSurfaceRow,
  placeSurfaceGuide,
} from '../src/core/mesh/surface-object';
import { chartPoint, guideCharts, guideRows } from '../src/core/mesh/surface-guides';
import { surfaceEdgeSelection, surfacePointRange } from '../src/core/mesh/surface-selection';

function fixture(count = 3) {
  const doc = blankMountain('CONTROL_DELETE'),
    profiles: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const row: number[] = [];
    for (let p = 0; p < count; p++) {
      row.push(doc.vertices.length / 3);
      doc.vertices.push(r * 30, r === 1 && p > 0 && p < count - 1 ? 12 : 0, (p * 40) / (count - 1));
    }
    profiles.push(row);
  }
  Object.assign(doc, appendMeshIds(doc, count * 3, 0));
  doc.freeEdges = profiles.flatMap(row => row.slice(1).map((b, i) => [row[i], b] as [number, number]));
  const result = createSurfaceFromProfiles(migrateMountain(serializeMountain(doc)), profiles, { patchSizeM: 15 });
  assert(result.ok, result.ok ? '' : result.error);
  return result;
}
const peak = (result: ReturnType<typeof fixture>) => chartPoint(guideCharts(result.doc, result.surface), 0.5, 0.5)[1];
{
  const start = fixture(),
    before = structuredClone(start.doc),
    removed = deleteSurfaceControls(start.doc, start.surface, { curves: [1] });
  assert(removed.ok, removed.ok ? '' : removed.error);
  assert(peak(start) > 10);
  assert(
    Math.abs(peak(removed)) < 1e-7,
    'deleting the middle profile removes the hill rather than baking it into the seed',
  );
  assert.equal(removed.surface.guides!.length, 2);
  assert.deepEqual(start.doc, before, 'shape deletion is pure');
  const preserved = deleteSurfaceRow(start.doc, start.surface, 'U', 1);
  assert(preserved.ok);
  assert(Math.abs(peak(preserved) - peak(start)) < 1e-7, 'guide removal still preserves the hill');
  const loaded = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(removed.doc))));
  assert.equal(canonicalJson(loaded), canonicalJson(removed.doc));
  const boundary = deleteSurfaceControls(start.doc, start.surface, { curves: [0] });
  assert(boundary.ok, boundary.ok ? '' : boundary.error);
  const oldShape = guideCharts(start.doc, start.surface),
    newShape = guideCharts(boundary.doc, boundary.surface);
  for (const v of [0.5, 1])
    for (let i = 0; i <= 20; i++) {
      const a = chartPoint(oldShape, i / 20, v),
        b = chartPoint(newShape, i / 20, v);
      assert(Math.hypot(...a.map((n, j) => n - b[j])) < 1e-6, 'remaining visible guide curves retain their shape');
    }
}
{
  const start = fixture(),
    id = start.surface.controls[1][1],
    removed = deleteSurfaceControls(start.doc, start.surface, { points: [id] });
  assert(removed.ok, removed.ok ? '' : removed.error);
  assert(!removed.doc.vertexIds.includes(id));
  assert.equal(removed.surface.controls[1].length, 2);
  assert(Math.abs(peak(removed)) < 1e-7, 'deleting the peak reconnects the remaining points smoothly');
  const many = fixture(5),
    ids = many.surface.controls[1].slice(1, -1),
    batch = deleteSurfaceControls(many.doc, many.surface, { points: ids });
  assert(batch.ok, batch.ok ? '' : batch.error);
  assert.equal(batch.surface.controls[1].length, 2);
  assert(Math.abs(peak(batch)) < 1e-7);
}
{
  const start = fixture(),
    added = placeSurfaceGuide(start.doc, start.surface, 'V', 0.37);
  assert(added.ok);
  const row = added.surface.controls.at(-1)!,
    curves = added.surface.guides!;
  const shared = added.surface.controls[1].find(id => row.includes(id))!;
  const before = structuredClone(added.doc);
  assert(
    !deleteSurfaceControls(added.doc, added.surface, { points: [shared] }).ok,
    'shared crossing points require deleting the curve',
  );
  assert(
    !deleteSurfaceControls(added.doc, added.surface, { points: [added.surface.controls[1][0]] }).ok,
    'endpoints stay protected',
  );
  assert(!deleteSurfaceControls(added.doc, added.surface, { curves: curves.map((_, i) => i) }).ok);
  assert.deepEqual(added.doc, before, 'refused deletes cannot partially change source geometry');
  // Keep one perpendicular curve and preserve its shape and the automatic footprint.
  const onlyV = deleteSurfaceControls(added.doc, added.surface, { curves: guideRows(added.surface, 'U') });
  assert(onlyV.ok, onlyV.ok ? '' : onlyV.error);
  assert.equal(onlyV.surface.guides!.length, 1);
  assert.equal(onlyV.surface.guides![0].axis, 'V');
  assert(onlyV.surface.patches.length > 0);
}
{
  const start = fixture(5),
    added = placeSurfaceGuide(start.doc, start.surface, 'V', 0.37);
  assert(added.ok);
  const row = added.surface.controls[1],
    edges = row.slice(1).map((b, i) => [row[i], b] as [string, string]);
  const selected = surfaceEdgeSelection(added.doc, [], null, edges[1], 'loop');
  assert.deepEqual(selected?.edges, edges, 'double-click selects one whole guide through shared crossings');
  const ranged = surfaceEdgeSelection(added.doc, [edges[0]], edges[0], edges[3], 'range');
  assert.deepEqual(ranged?.edges, edges.slice(0, 4));
  const reverse = surfaceEdgeSelection(added.doc, [], edges[3], edges[0], 'range');
  assert.deepEqual(reverse?.edges, edges.slice(0, 4));
  assert.deepEqual(surfacePointRange(added.doc, row[1], row[4]), row.slice(1, 5));
  const outer = added.surface.controls[2],
    end: [string, string] = [outer.at(-2)!, outer.at(-1)!],
    band = surfaceEdgeSelection(added.doc, [edges[0]], edges[0], end, 'range');
  assert(band && band.edges.length > edges.length, 'Shift spans control edges across parallel guide rows');
  const deleted = deleteSurfaceControls(added.doc, added.surface, { curves: [1] });
  assert(deleted.ok);
  assert(
    added.surface.controls[0].every(id => deleted.doc.vertexIds.includes(id)),
    'unrelated source controls survive',
  );
}
console.log(
  'SURFACE CONTROL DELETE: shape-changing point/curve deletion, preserved guide removal, batch edits, guarded crossings/endpoints, persistence, curve double-click and Shift ranges passed.',
);
