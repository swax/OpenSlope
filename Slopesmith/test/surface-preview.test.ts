// tier: fast
import assert from 'node:assert/strict';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { createSurfaceFromProfiles, refreshSurfaces, markSurfaceLayoutsPending } from '../src/core/mesh/surface-object';
import { moveMeshVertices, meshControlPoints, selectedControlPointPositions } from '../src/core/mesh/control-points';
import {
  createSurfacePreviewEvaluator,
  mergeSurfacePreview,
  type SurfacePreviewRequest,
  type SurfacePreviewResponse,
} from '../src/core/mesh/surface-preview';
import { buildMountainPreview, adoptPreviewPatches, previewMismatch } from '../src/core/mesh/tessellation';
import { createSurfacePreviewClient } from '../src/app/edit/surface-preview-client';
import { createSurfaceEditGuard } from '../src/app/edit/surface-edit-guard';
import { createSurfaceFromDrawnBoundary } from '../src/core/mesh/surface-boundary';
import { refreshPreviewPatches } from '../src/core/mesh/tessellation';
import type { V3 } from '../src/core/doc/types';

function fixture() {
  const doc = blankMountain('ASYNC', 15);
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) doc.vertices.push(x * 30, x === 1 && z === 1 ? 8 : 0, z * 30);
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
    [6, 7],
    [7, 8],
  ];
  const made = createSurfaceFromProfiles(
    doc,
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 15 },
  );
  assert(made.ok, made.ok ? '' : made.error);
  return made.doc;
}
const inputs = (doc: ReturnType<typeof fixture>) =>
  structuredClone({ vertices: doc.vertices, edgeHandles: doc.edgeHandles, quadTwist: doc.quadTwist });
{
  let doc = fixture();
  const id = doc.surfaces![0].controls[1][1],
    pv = buildMountainPreview(doc),
    evaluate = createSurfacePreviewEvaluator();
  for (let frame = 0; frame < 5; frame++) {
    moveMeshVertices(doc, [doc.vertexIds.indexOf(id)], [0, frame === 4 ? -8 : 2, 0]);
    const request = {
      epoch: 1,
      inputs: inputs(doc),
      change: { vertices: [doc.vertexIds.indexOf(id)] },
      ...(frame === 0 ? { initial: structuredClone(doc) } : {}),
    };
    const result = evaluate(request);
    assert.equal(result.kind, 'ready');
    if (result.kind !== 'ready') throw new Error('no result');
    doc = mergeSurfacePreview(doc, request.inputs, result.geometry, result.changed);
    markSurfaceLayoutsPending(doc, result.changed);
    assert(adoptPreviewPatches(doc, pv, result.patches));
    assert.equal(previewMismatch(doc, pv), null, 'worker patch buffers and raw seam inputs equal a full rebuild');
  }
  // Re-emitting only one patch after worker updates must still have every neighbor's correct raw normal.
  refreshPreviewPatches(doc, pv, [doc.quadIds.indexOf(doc.surfaces![0].patches[0].quad)]);
  assert.equal(previewMismatch(doc, pv), null);
  const full = refreshSurfaces(doc);
  assert(!full.surfaces!.some(s => s.error));
  const points = meshControlPoints(full),
    selected = selectedControlPointPositions(
      full,
      points.map(p => p.id),
    );
  assert.deepEqual(
    selected,
    points.map(({ id, pos }) => ({ id, pos })),
    'selection reads equal the complete cage enumerator',
  );
  console.log(
    '✓ worker samples retain incremental/full equivalence, raw seam normals, source lookup and final fitting',
  );
}

{
  let doc = fixture();
  const id = doc.surfaces![0].controls[1][1],
    at = doc.vertexIds.indexOf(id);
  moveMeshVertices(doc, [at], [0, 40, 0]);
  const baseline = inputs(doc),
    result = createSurfacePreviewEvaluator()({
      epoch: 1,
      initial: structuredClone(doc),
      inputs: baseline,
      change: { vertices: [at] },
    });
  assert(result.kind === 'ready');
  doc = mergeSurfacePreview(doc, baseline, result.geometry, result.changed);
  markSurfaceLayoutsPending(doc, result.changed);
  const final = refreshSurfaces(doc);
  assert.notEqual(
    final.surfaces![0],
    doc.surfaces![0],
    'the main thread remembers that the worker layout needs a final adaptive fit',
  );
  const fresh = refreshSurfaces({
    ...doc,
    surfaces: doc.surfaces!.map(s => ({ ...s, evaluated: { points: [], patchSizeM: 0 } })),
  });
  assert.deepEqual(final.surfaces![0].patches, fresh.surfaces![0].patches);
  const live = structuredClone(doc),
    key = Object.keys(live.edgeHandles!)[0],
    removed = Object.keys(live.edgeHandles!)[1];
  live.edgeHandles![key] = [7, 8, 9];
  delete live.edgeHandles![removed];
  const merged = mergeSurfacePreview(live, inputs(doc), result.geometry, result.changed);
  assert.deepEqual(merged.edgeHandles![key], [7, 8, 9], 'newer tangent edits survive older fits');
  assert.equal(merged.edgeHandles![removed], undefined, 'newer tangent removals survive older fits');
  console.log('✓ final adaptive fitting and newer tangent writes/removals survive the asynchronous boundary');
}

{
  const joined = createSurfaceFromDrawnBoundary(
    fixture(),
    [
      [60, 0, 0],
      [60, 0, 60],
      [120, 0, 60],
      [120, 0, 0],
    ].map(pos => ({ pos: pos as V3, vertex: null })),
    15,
  );
  assert(joined.ok, joined.ok ? '' : joined.error);
  assert(joined.surface.stitches?.length);
  const doc = joined.doc,
    pv = buildMountainPreview(doc),
    at = doc.vertexIds.indexOf(doc.surfaces![0].controls[2][1]);
  moveMeshVertices(doc, [at], [0, 2, 0]);
  const baseline = inputs(doc),
    result = createSurfacePreviewEvaluator()({
      epoch: 1,
      initial: structuredClone(doc),
      inputs: baseline,
      change: { vertices: [at] },
    });
  assert(result.kind === 'ready');
  assert(!result.geometry.surfaces!.some(s => s.error));
  const merged = mergeSurfacePreview(doc, baseline, result.geometry, result.changed);
  assert(adoptPreviewPatches(merged, pv, result.patches));
  assert.equal(
    previewMismatch(merged, pv),
    null,
    'stitched source and generated seam update consistently through the worker',
  );
  console.log('✓ worker evaluation and retained buffers preserve live stitched geometry');
}

class FakeWorker {
  requests: SurfacePreviewRequest[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<SurfacePreviewResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(request: SurfacePreviewRequest) {
    this.requests.push(structuredClone(request));
  }
  terminate() {
    this.terminated = true;
  }
  receive(response: SurfacePreviewResponse) {
    this.onmessage?.({ data: response } as MessageEvent<SurfacePreviewResponse>);
  }
}
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
{
  const guard = createSurfaceEditGuard();
  let doc = guard.refresh(fixture(), { authored: false }).doc;
  const accepted = structuredClone(doc),
    id = doc.surfaces![0].controls[1][1],
    at = doc.vertexIds.indexOf(id),
    workers: FakeWorker[] = [];
  let streamed = 0,
    installed = 0,
    fallbacks = 0,
    enabled = true;
  const client = createSurfacePreviewClient({
    getDoc: () => doc,
    enabled: () => enabled,
    beginPending: () => guard.beginPreview(),
    streamControls: () => {
      streamed++;
    },
    accept: (live, next) => {
      const result = guard.accept(live, next, { interactive: true });
      doc = result.doc;
      return result;
    },
    install: next => {
      doc = next;
      installed++;
      return true;
    },
    drawn: () => {},
    fallback: () => {
      fallbacks++;
    },
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  client.begin();
  moveMeshVertices(doc, [at], [0, 1, 0]);
  client.preview({ vertices: [at] });
  assert.equal(streamed, 1);
  assert.equal(workers.length, 0, 'the pointer callback never dispatches expensive work');
  assert.deepEqual(
    guard.forPersistence(doc).vertices,
    accepted.vertices,
    'even before the worker starts, saves see the accepted mesh',
  );
  await tick();
  const worker = workers[0];
  assert.equal(worker.requests.length, 1);
  const evaluate = createSurfacePreviewEvaluator(),
    first = evaluate(worker.requests[0]);
  for (let i = 0; i < 100; i++) {
    moveMeshVertices(doc, [at], [0, 0.01, 0]);
    client.preview({ vertices: [at] });
  }
  const newest = doc.vertices[at * 3 + 1];
  doc.name = 'Keep unrelated settings';
  assert.equal(worker.requests.length, 1, 'there is exactly one in-flight sample despite a burst of pointer events');
  worker.receive(first);
  assert.equal(doc.vertices[at * 3 + 1], newest, 'a completed older sample cannot pull source points backward');
  assert.equal(doc.name, 'Keep unrelated settings');
  assert.equal(installed, 1);
  await tick(100);
  assert.equal(worker.requests.length, 2, 'one replacement request carries the newest source');
  assert.equal(worker.requests[1].inputs.vertices[at * 3 + 1], newest);
  client.cancel();
  const before = structuredClone(doc);
  worker.receive(evaluate(worker.requests[1]));
  assert.deepEqual(doc, before, 'a late completion after release cannot overwrite final fitting/undo');
  assert(worker.terminated);
  assert(!client.pending());
  assert.equal(fallbacks, 0);
  doc = guard.refresh(doc).doc;
  assert(!guard.pending());
  assert.notDeepEqual(
    guard.forPersistence(doc).vertices,
    accepted.vertices,
    'release publishes the fully fitted latest source',
  );

  client.begin();
  moveMeshVertices(doc, [at], [0, 1, 0]);
  client.preview({ vertices: [at] });
  await tick();
  const stale = workers[1],
    request = stale.requests[0];
  doc = structuredClone(accepted);
  stale.receive(createSurfacePreviewEvaluator()(request));
  assert.deepEqual(doc, accepted, 'a restored/replaced document ignores the old gesture');
  client.cancel();

  client.begin();
  client.preview({ vertices: [at] });
  await tick();
  const modeJob = workers[2].requests[0];
  enabled = false;
  const modeDoc = structuredClone(doc);
  workers[2].receive(createSurfacePreviewEvaluator()(modeJob));
  assert.deepEqual(doc, modeDoc, 'switching away from mountain editing rejects pending samples');
  assert(!client.pending());
  enabled = true;

  client.begin();
  client.preview({ vertices: [at] });
  await tick();
  const topologyJob = workers[3].requests[0];
  doc.vertices.push(1, 2, 3);
  const topologyDoc = structuredClone(doc);
  workers[3].receive(createSurfacePreviewEvaluator()(topologyJob));
  assert.deepEqual(doc, topologyDoc, 'in-place topology changes also supersede a pending sample');
  assert(!client.pending());
  assert.equal(fallbacks, 0);
  console.log(
    '✓ immediate control feedback, bounded latest-wins work, newer edits, release, persistence and stale-result rejection',
  );
}
