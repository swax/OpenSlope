// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { appendFreeEdge, autoWeldCreatedEdgeCrossings } from '../src/core/mesh/ops';
import { buildMountainPreview, refreshPreviewConstruction, previewMismatch } from '../src/core/mesh/tessellation';

const raw = blankMountain('CONSTRUCTION_PREVIEW');
raw.vertices = [0, 0, 0, 0, 0, 30, 30, 8, 0, 30, 0, 30];
raw.quads = [[0, 1, 2, 3]];
Object.assign(raw, appendMeshIds(raw, 4, 1));
let doc = migrateMountain(serializeMountain(raw));
const preview = buildMountainPreview(doc),
  positions = preview.positions,
  indices = preview.indices;
const original = positions.slice();
for (let i = 0; i < 6; i++) {
  const appended = appendFreeEdge(doc, i ? doc.vertices.length / 3 - 1 : [100, 0, 0], [110 + i * 10, i, 0]);
  assert(appended.ok, appended.ok ? '' : appended.error);
  const automatic = autoWeldCreatedEdgeCrossings(appended.doc, [appended.edge]);
  assert.equal(automatic.welded, 0);
  doc = automatic.doc;
  const dirty = refreshPreviewConstruction(doc, preview);
  assert(dirty);
  assert.equal(dirty.size, 0, 'a loose chain does not retessellate terrain');
  assert.equal(preview.positions, positions);
  assert.equal(preview.indices, indices);
  assert.deepEqual(preview.positions, original);
  assert.equal(preview.mesh.vertexCount, doc.vertices.length / 3);
  assert.equal(previewMismatch(doc, preview), null);
}
// Joining a terrain vertex pins its old boundaries. Its new graph still does not change the quilt.
const attached = appendFreeEdge(doc, 0, [-20, 2, 0]);
assert(attached.ok);
assert.equal(refreshPreviewConstruction(attached.doc, preview)?.size, 0);
assert.equal(previewMismatch(attached.doc, preview), null);
// A real shape change in the same action must reach the retained buffers.
attached.doc.vertices[2 * 3 + 1] += 4;
assert.equal(refreshPreviewConstruction(attached.doc, preview)?.size, 1);
assert.equal(previewMismatch(attached.doc, preview), null);
assert.equal(refreshPreviewConstruction({ ...attached.doc, quads: [[0, 2, 1, 3]] }, preview), null);
attached.doc.quadTwist = {
  0: [
    [0, 2, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ],
};
assert.equal(refreshPreviewConstruction(attached.doc, preview)?.size, 1);
assert.equal(previewMismatch(attached.doc, preview), null);
attached.doc.quadTwist[0][0][1] += 3;
assert.equal(
  refreshPreviewConstruction(attached.doc, preview)?.size,
  1,
  'in-place interior edits invalidate the terrain input snapshot',
);
assert.equal(previewMismatch(attached.doc, preview), null);
console.log(
  'CONSTRUCTION PREVIEW: chain topology reuses terrain buffers; attached and changed patches match a full rebuild.',
);
