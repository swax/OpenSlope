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
  assert(Math.abs(peak(preserved)) < 1e-7, 'all curve deletion paths remove the deleted influence');
  assert(!preserved.surface.seed && !preserved.surface.guides!.some(g => g.reference));
  const loaded = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(removed.doc))));
  assert.equal(canonicalJson(loaded), canonicalJson(removed.doc));
  const boundary = deleteSurfaceControls(start.doc, start.surface, { curves: [0] });
  assert(!boundary.ok && /boundary curves/.test(boundary.error), 'outer shape constraints cannot be deleted');
  assert(!deleteSurfaceRow(start.doc, start.surface, 'U', 0).ok, 'guide-only removal protects the same boundary');
  assert(
    !placeSurfaceGuide(start.doc, start.surface, 'U', 0.2, 0).ok,
    'a boundary guide cannot slide into the interior',
  );
  assert(!deleteSurfaceControls(start.doc, start.surface, { curves: [1, 0] }).ok, 'mixed deletes are atomic');
  assert.deepEqual(start.doc, before, 'refusing a boundary edit keeps source and terrain intact');
  const point = deleteSurfaceControls(start.doc, start.surface, { points: [start.surface.controls[0][1]] });
  assert(point.ok, point.ok ? '' : point.error);
  assert.equal(point.surface.guides![0].at, 0, 'intermediate boundary points remain editable');
  assert.equal(point.surface.controls[0].length, 2);
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
  const interior = guideRows(added.surface, 'U').filter(i => curves[i].at > 0 && curves[i].at < 1);
  const remaining = deleteSurfaceControls(added.doc, added.surface, { curves: interior });
  assert(remaining.ok, remaining.ok ? '' : remaining.error);
  assert.equal(
    remaining.surface.guides!.length,
    3,
    'interior curves can be deleted while both boundary profiles remain',
  );
  assert(remaining.surface.guides!.some(g => g.axis === 'V'));
  assert(remaining.surface.patches.length > 0);
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
  'SURFACE CONTROL DELETE: shape-changing point/curve deletion, curve removal rebuilt from remaining controls, batch edits, guarded crossings/endpoints, persistence, curve double-click and Shift ranges passed.',
);
