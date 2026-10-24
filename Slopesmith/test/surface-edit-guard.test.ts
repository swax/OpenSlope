// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { createSurfaceFromDrawnBoundary, stitchTouchingSurfaceBoundaries } from '../src/core/mesh/surface-boundary';
import { refreshSurfaces } from '../src/core/mesh/surface-object';
import { moveMeshVertices } from '../src/core/mesh/control-points';
import { createSurfaceEditGuard } from '../src/app/edit/surface-edit-guard';
import { createRegisterSync } from '../src/app/net/register-sync';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';

function stitched() {
  const doc = blankMountain('GUARD', 20);
  doc.vertices = [0, 0, 0, 0, 0, 80, 40, 0, 0, 40, 0, 80];
  doc.quads = [[0, 1, 2, 3]];
  Object.assign(doc, appendMeshIds(doc, 4, 1));
  const made = createSurfaceFromDrawnBoundary(
    doc,
    [
      [40, 0, 0],
      [40, 0, 80],
      [120, 0, 80],
      [120, 0, 0],
    ].map(pos => ({ pos: pos as V3, vertex: null })),
    20,
  );
  assert(made.ok, made.ok ? '' : made.error);
  assert(made.surface.stitches?.length);
  return made.doc;
}

const farSide = (doc: QuadMeshDoc) =>
  [...new Set(doc.surfaces![0].controls.flat())]
    .map(id => doc.vertexIds.indexOf(id))
    .filter(v => doc.vertices[v * 3] > 100);

function mixedSeams() {
  return stitchTouchingSurfaceBoundaries(
    migrateMountain(
      JSON.parse(readFileSync(new URL('./fixtures/surface-stitch-mixed-gari.json', import.meta.url), 'utf8')),
    ),
    'surface:2',
  );
}
// Shared source corner at the intersection of the fixture's two stitched boundaries.
const seamCorner = (doc: QuadMeshDoc) => doc.vertexIds.indexOf('local:137637');

{
  const guard = createSurfaceEditGuard();
  const doc = guard.refresh(stitched(), { authored: false }).doc,
    before = structuredClone(doc);
  const invalid = { ...doc, surfaces: doc.surfaces!.map(s => ({ ...s, patchSizeM: 0.1 })) };
  const rejected = guard.refresh(invalid, { interactive: true });
  assert.match(rejected.rejected!, /at least 0.5 metres/);
  assert.deepEqual(rejected.doc, before, 'stitch refresh must not hide a failed source fit behind the previous output');
  console.log('✓ a failed source fit reaches the rollback guard without a second stitch assembly');
}

{
  const guard = createSurfaceEditGuard();
  let doc = guard.refresh(mixedSeams(), { authored: false }).doc;
  moveMeshVertices(doc, [seamCorner(doc)], [0, 1, 0]);
  doc = guard.refresh(doc).doc;
  assert(!doc.surfaces![0].error);
  const before = structuredClone(doc);
  moveMeshVertices(doc, [seamCorner(doc)], [-30, 0, 0]);
  assert(
    refreshSurfaces(structuredClone(doc)).surfaces!.some(s => s.error),
    'the edit really fails the stitch fitter',
  );
  const rejected = guard.refresh(doc, { interactive: true });
  assert.match(rejected.rejected!, /Surface 1/);
  assert.deepEqual(rejected.doc.vertices, before.vertices, 'source, host and generated vertices roll back together');
  assert.deepEqual(rejected.doc.edgeHandles, before.edgeHandles, 'source and seam tangents roll back');
  assert.deepEqual(rejected.doc.quads, before.quads);
  assert.deepEqual(rejected.doc.surfaces, before.surfaces, 'no stale error/evaluation is accepted');
  assert.deepEqual(rejected.doc, before, 'a rejected drag leaves no document change for undo to record');
  assert.equal(JSON.stringify(rejected.doc), JSON.stringify(before), 'JSON history sees no phantom edit either');
  assert(!guard.pending());
  const retry = rejected.doc;
  moveMeshVertices(retry, [seamCorner(retry)], [0, 1, 0]);
  const valid = guard.refresh(retry);
  assert(!valid.rejected && !valid.doc.surfaces![0].error, 'a valid reshape still works after a rejection');
  console.log('✓ failed live reshapes restore the last accepted source, host and generated terrain');
}
{
  // A preview reuses the old patch layout; release does an adaptive fit. Exercise the second failure
  // boundary separately so accepting previews can never replace the fully validated checkpoint.
  let rejectFinal = false;
  const guard = createSurfaceEditGuard((doc, options) => {
    const next = refreshSurfaces(doc, options);
    return rejectFinal && !options?.interactive
      ? { ...next, surfaces: next.surfaces!.map(s => ({ ...s, error: 'Final fitting failed' })) }
      : next;
  });
  let doc = guard.refresh(stitched(), { authored: false }).doc;
  const before = structuredClone(doc);
  moveMeshVertices(doc, farSide(doc), [0, 5, 0]);
  doc = guard.refresh(doc, { interactive: true }).doc;
  assert(guard.pending());
  assert.notDeepEqual(doc.vertices, before.vertices);
  doc.name = 'Keep this unrelated setting';
  const saving = guard.forPersistence(doc);
  assert.deepEqual(saving.vertices, before.vertices, 'a save timer during the preview reads the accepted mesh');
  assert.deepEqual(saving.surfaces, before.surfaces);
  assert.equal(saving.name, doc.name);
  rejectFinal = true;
  const final = guard.refresh(doc);
  assert.match(final.rejected!, /Final fitting failed/);
  assert.deepEqual(final.doc.vertices, before.vertices);
  assert.deepEqual(final.doc.surfaces, before.surfaces);
  assert.equal(final.doc.name, doc.name);
  assert(!guard.pending(), 'the rejected preview cannot enter a later commit');
  console.log('✓ final-fit failures also roll back successful previews without discarding map settings');
}
{
  const guard = createSurfaceEditGuard();
  const broken = mixedSeams();
  moveMeshVertices(broken, [seamCorner(broken)], [-30, 0, 0]);
  const loaded = guard.refresh(broken, { authored: false });
  assert(!loaded.rejected && loaded.doc.surfaces![0].error, 'loading does not repair existing broken geometry');
  assert.deepEqual(loaded.doc.vertices, broken.vertices);
  const unrelated = guard.refresh({ ...loaded.doc, name: 'Renamed' });
  assert(!unrelated.rejected, 'pre-existing errors do not block unrelated work');
  guard.reset();
  const replacement = guard.refresh(stitched());
  assert(!replacement.rejected && !replacement.doc.surfaces![0].error);
  console.log('✓ document adoption/reset never restores geometry from an older map or undo state');
}
{
  const guard = createSurfaceEditGuard();
  let doc = guard.refresh(stitched(), { authored: false }).doc;
  let sent = 0;
  const sync = createRegisterSync({
    getDoc: () => doc,
    setDoc: next => {
      doc = next;
    },
    canPublish: () => !guard.pending(),
    channel: {
      assign: () => {
        sent++;
        return true;
      },
      claim: () => {
        sent++;
        return true;
      },
      checkDrift: () => true,
      fetchSections: () => true,
    },
  });
  sync.connect();
  moveMeshVertices(doc, farSide(doc), [0, 5, 0]);
  doc = guard.refresh(doc, { interactive: true }).doc;
  sync.noteEdit();
  sync.flush();
  assert.equal(sent, 0, 'a sync tick cannot publish provisional source/terrain geometry');
  assert.equal(sync.sealStep(), null, 'nor can it enter register undo history');
  doc = guard.refresh(doc).doc;
  sync.flush();
  assert(sent > 0, 'successful final fitting releases the edit for publication');
  console.log('✓ shared editing waits for final surface validation before sending or recording changes');
}
