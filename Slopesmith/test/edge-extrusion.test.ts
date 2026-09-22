// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { seedMeshIds } from '../src/core/doc/ids';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { len, sub } from '../src/core/math/vec';
import {
  applyPlannedEdgeExtrusion, edgeChainExtrusionPlacement, edgeExtrusionPlacementPreviewDoc,
  edgeExtrusionSegmentCount, pathEdgeExtrusionPlacement, planEdgeExtrusion, translatedEdgeExtrusionPlacement,
} from '../src/core/mesh/ops';
import { meshFromDoc, meshAdjacency, quadControlPoints } from '../src/core/mesh/topology';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { meshEdgeSegments } from '../src/core/mesh/selection';
import { BRIDGE_RAIL_COLORS } from '../src/app/viewport/constants';
import { createEdgeExtrusionLayer } from '../src/app/viewport/tools/edge-extrusion';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import type { Stage } from '../src/app/viewport/stage';
import type { NamedEdge } from '../src/app/state/mesh-names';

function fixture(): QuadMeshDoc {
  const doc = meshFromNet({ rows: 2, cols: 2, spacing: 10,
    corners: [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10], paint: {} },
  { name: 'EXTRUDE', course: starterCourse(), baseSurface: 1 });
  doc.vertices.push(20, 0, 10, 30, 1, 14, 38, 3, 21);
  doc.freeEdges = [[3, 4], [4, 5], [5, 6]];
  Object.assign(doc, seedMeshIds(0, 7, 1));
  doc.quadPaint = { 0: 7 };
  doc.quadTex = { 0: 'TEST/SNOW.png' };
  doc.rails = [{ id: 'path:0000', kind: 'motion', height: 0, nodes: [[0, 0, 0], [15, 0, 0], [25, 2, 10]] }];
  return doc;
}

const source = fixture(), before = structuredClone(source);
const planned = planEdgeExtrusion(source, [[1, 3]]);
assert(planned.ok, planned.ok ? '' : planned.error);
const plan = planned.plan;

// Pull: changing target length changes actual topology, with preview and commit using the same bands.
for (const [segmentLength, expected] of [[20, 2], [5, 7], [1, 35]]) {
  const configured = { ...plan, segmentLength };
  const placement = translatedEdgeExtrusionPlacement(source, configured, [35, 0, 0]);
  assert.equal(edgeExtrusionSegmentCount(source, configured, placement), expected);
  const preview = edgeExtrusionPlacementPreviewDoc(source, configured, placement);
  const result = applyPlannedEdgeExtrusion(source, configured, placement);
  assert(result.ok, result.ok ? '' : result.error);
  assert.equal(result.quads.length, expected);
  assert.equal(preview.quads.length, expected);
}
for (const segmentLength of [0, -1, NaN, Infinity]) {
  const configured = { ...plan, segmentLength };
  assert(!applyPlannedEdgeExtrusion(source, configured, translatedEdgeExtrusionPlacement(source, plan, [10, 0, 0])).ok);
}

// Mesh path: edge order/direction do not matter; path vertices and handles become the shared side of the quilt.
const chain = edgeChainExtrusionPlacement(source, plan, [[6, 5], [4, 3], [5, 4]]);
assert(chain.ok, chain.ok ? '' : chain.error);
assert.deepEqual(chain.placement.guide?.vertices, [3, 4, 5, 6]);
const result = applyPlannedEdgeExtrusion(source, plan, chain.placement);
assert(result.ok, result.ok ? '' : result.error);
assert.deepEqual(source, before);
assert.equal(result.quads.length, 3);
assert.equal(result.vertices.length, 3, 'Only the opposite side gets new vertices; guide vertices are reused');
assert.equal(result.doc.vertices.length, source.vertices.length + 9);
assert(!result.doc.freeEdges?.length, 'Guide free edges are consumed when they become patch boundaries');
assert.deepEqual(result.doc.vertices.slice(0, source.vertices.length), source.vertices);
assert.deepEqual(result.doc.vertexIds.slice(0, source.vertexIds.length), source.vertexIds);
const original = meshFromDoc(source), output = meshFromDoc(result.doc), adj = meshAdjacency(output.mesh);
for (const [a, b] of source.freeEdges!) {
  assert.equal(adj.edgeQuads.get(`${a},${b}`)?.length, 1);
  assert.deepEqual(output.edgeHandle(a, b), original.edgeHandle(a, b));
  assert.deepEqual(output.edgeHandle(b, a), original.edgeHandle(b, a));
}
for (const quad of result.quads) {
  assert.equal(result.doc.quadPaint?.[quad], 7);
  assert.equal(result.doc.quadTex?.[quad], 'TEST/SNOW.png');
}
const previewDoc = edgeExtrusionPlacementPreviewDoc(source, plan, chain.placement), preview = meshFromDoc(previewDoc);
for (let i = 0; i < preview.mesh.quads.length; i++) {
  const a = quadControlPoints(preview.mesh, preview.edgeHandle, i);
  const b = quadControlPoints(output.mesh, output.edgeHandle, result.quads[i]);
  assert(a.every((point, k) => len(sub(point, b[k])) < 1e-9), 'Preview and committed curved patches agree');
}
assert(buildMountainPreview(result.doc).positions.every(Number.isFinite));

// A path already bordering another patch is joined by shared IDs and keeps that patch's shape unchanged.
{
  const joinedSource = fixture();
  joinedSource.vertices.push(10, 0, 20, 20, 0, 20);
  joinedSource.quads.push([3, 4, 7, 8]);
  joinedSource.freeEdges = [[4, 5], [5, 6]];
  Object.assign(joinedSource, seedMeshIds(0, 9, 2));
  const p = planEdgeExtrusion(joinedSource, [[1, 3]]);
  assert(p.ok);
  const follow = edgeChainExtrusionPlacement(joinedSource, p.plan, [[3, 4], [4, 5]]);
  assert(follow.ok, follow.ok ? '' : follow.error);
  const joined = applyPlannedEdgeExtrusion(joinedSource, p.plan, follow.placement);
  assert(joined.ok, joined.ok ? '' : joined.error);
  const ctx = meshFromDoc(joined.doc), originalCtx = meshFromDoc(joinedSource);
  assert.equal(meshAdjacency(ctx.mesh).edgeQuads.get('3,4')?.length, 2);
  const cp = quadControlPoints(originalCtx.mesh, originalCtx.edgeHandle, 1);
  assert(quadControlPoints(ctx.mesh, ctx.edgeHandle, 1).every((point, i) => len(sub(point, cp[i])) < 1e-9));
}
for (const edges of [[], [[1, 3]], [[4, 5]], [[3, 4], [5, 6]], [[3, 4], [4, 5], [4, 6]]] as [number, number][][])
  assert(!edgeChainExtrusionPlacement(source, plan, edges).ok);

// Two captured edges sweep either side of a guide starting at their shared middle vertex.
for (const freeSource of [false, true]) {
  const middle = meshFromNet({ rows: 2, cols: 3, spacing: 10,
    corners: [0, 0, 0, 10, 0, 0, 20, 0, 0, 0, 0, 10, 10, 0, 10, 20, 0, 10], paint: {} },
  { name: 'MIDDLE', course: starterCourse(), baseSurface: 1 });
  middle.vertices.push(10, 0, 20, 15, 2, 30, 20, 3, 40);
  middle.freeEdges = [[4, 6], [6, 7], [7, 8]];
  if (freeSource) { middle.quads = []; middle.freeEdges.push([3, 4], [4, 5]); }
  Object.assign(middle, seedMeshIds(0, 9, middle.quads.length));
  const saved = structuredClone(middle), p = planEdgeExtrusion(middle, [[3, 4], [4, 5]]);
  assert(p.ok);
  const guide = edgeChainExtrusionPlacement(middle, p.plan, [[8, 7], [6, 4], [7, 6]]);
  assert(guide.ok, guide.ok ? '' : guide.error);
  assert.deepEqual(guide.placement.guide?.vertices, [4, 6, 7, 8]);
  const applied = applyPlannedEdgeExtrusion(middle, p.plan, guide.placement);
  assert(applied.ok, applied.ok ? '' : applied.error);
  assert.equal(applied.quads.length, 6, 'Two source edges times three guide segments');
  assert.equal(applied.vertices.length, 6, 'Only the two outer tracks get new vertices');
  assert(!applied.doc.freeEdges?.length);
  assert.deepEqual(applied.doc.vertices.slice(0, middle.vertices.length), middle.vertices);
  const ctx = meshFromDoc(applied.doc), originalCtx = meshFromDoc(middle);
  const previewCtx = meshFromDoc(edgeExtrusionPlacementPreviewDoc(middle, p.plan, guide.placement));
  const adjacency = meshAdjacency(ctx.mesh);
  for (let quad = 0; quad < middle.quads.length; quad++) {
    const cp = quadControlPoints(originalCtx.mesh, originalCtx.edgeHandle, quad);
    assert(quadControlPoints(ctx.mesh, ctx.edgeHandle, quad).every((point, j) => len(sub(point, cp[j])) < 1e-9),
      'The captured source patches keep their existing curved shape');
  }
  for (const [a, b] of [[4, 6], [6, 7], [7, 8]]) {
    assert.equal(adjacency.edgeQuads.get(`${a},${b}`)?.length, 2, 'Both strips share the existing guide');
    assert.deepEqual(ctx.edgeHandle(a, b), originalCtx.edgeHandle(a, b));
    assert.deepEqual(ctx.edgeHandle(b, a), originalCtx.edgeHandle(b, a));
  }
  for (const [i, quad] of applied.quads.entries()) {
    const cp = quadControlPoints(previewCtx.mesh, previewCtx.edgeHandle, i);
    assert(quadControlPoints(ctx.mesh, ctx.edgeHandle, quad).every((point, j) => len(sub(point, cp[j])) < 1e-9));
  }
  assert(buildMountainPreview(applied.doc).positions.every(Number.isFinite));
  assert.deepEqual(middle, saved);

  // An existing patch would be a third face along the centre seam; explain why it cannot be used.
  middle.vertices.push(30, 0, 10, 30, 0, 20);
  middle.quads.push([4, 9, 6, 10]);
  Object.assign(middle, seedMeshIds(0, 11, middle.quads.length));
  const rejected = edgeChainExtrusionPlacement(middle, p.plan, [[4, 6]]);
  assert(!rejected.ok);
  assert.match(rejected.error, /middle.*both sides.*free path edges/);
}

// An authored curved path sweeps through intermediate stations instead of bridging directly to the end.
const path: V3[] = [[100, 0, 100], [115, 0, 100], [130, 2, 105], [140, 4, 120]];
const swept = pathEdgeExtrusionPlacement(source, { ...plan, segmentLength: 5 }, path);
assert(swept.ok, swept.ok ? '' : swept.error);
assert(swept.placement.stations!.length > 2);
const sweptDoc = applyPlannedEdgeExtrusion(source, plan, swept.placement);
assert(sweptDoc.ok, sweptDoc.ok ? '' : sweptDoc.error);
assert.equal(sweptDoc.quads.length, swept.placement.stations!.length);
assert(buildMountainPreview(sweptDoc.doc).positions.every(Number.isFinite));
for (const ring of swept.placement.stations!)
  assert(Math.abs(len(sub(ring.vertices[1], ring.vertices[3])) - 10) < 1e-9, 'Sweeping preserves the cross-section width');
assert(!pathEdgeExtrusionPlacement(source, plan, [[0, 0, 0], [0, 0, 0]]).ok);
assert(!pathEdgeExtrusionPlacement(source, plan, [[0, 0, 0], [Infinity, 0, 0]]).ok);
assert(!pathEdgeExtrusionPlacement(source, { ...plan, segmentLength: 0.001 }, path).ok);

// Drive the actual staged layer: Pull defaults, settings update preview, mesh picks supply the path, cancel is pure.
let selection: NamedEdge[] = [[source.vertexIds[1], source.vertexIds[3]]];
let currentDoc = source;
let committed = 0, lastError = '';
const stageMock = {
  scene: new THREE.Scene(), worldRoot: new THREE.Group(), gizmoKind: null as string | null,
  container: { clientWidth: 800, clientHeight: 600 },
  attachGizmo(_anchor: THREE.Object3D, kind: string) { this.gizmoKind = kind; },
  detachGizmo() { this.gizmoKind = null; },
  cb: {
    onExtrudeStageChange() {},
    onExtrudeEdgeSelection(edges: readonly NamedEdge[]) { selection = edges.map(edge => [...edge]); },
    onExtrudeEdgesInvalid(error: string) { lastError = error; },
    onCommitExtrudeEdges(p: typeof plan, placement: typeof chain.placement) {
      const applied = applyPlannedEdgeExtrusion(source, p, placement);
      assert(applied.ok, applied.ok ? '' : applied.error); committed++;
      selection = applied.outerEdges.map(([a, b]) => [applied.doc.vertexIds[a], applied.doc.vertexIds[b]]);
    },
  },
};
const stage = stageMock as unknown as Stage;
const layer = createEdgeExtrusionLayer(stage, {
  canBegin: () => true, selectedEdges: () => selection, selectedQuads: () => [], meshDoc: () => currentDoc,
  cornerPos: vertex => source.vertices.slice(vertex * 3, vertex * 3 + 3) as V3,
  snap: () => ({ enabled: false, step: 1 }), hideOtherPreview() {}, restoreOtherPreview() {}, suppressSourceQuads() {},
});

// Route actual pointer down/up events too: a staged extrusion must not swallow guide clicks as pull-drag releases.
const handlers = new Map<string, ((event: PointerEvent) => void)[]>();
const dom = {
  style: {}, setPointerCapture() {}, releasePointerCapture() {},
  addEventListener(type: string, handler: (event: PointerEvent) => void) {
    handlers.set(type, [...handlers.get(type) ?? [], handler]);
  },
};
let pickedGuide: [number, number] = [3, 4];
Object.assign(stageMock, {
  renderer: { domElement: dom }, controls: { enabled: true },
  container: { ...dom, clientWidth: 800, clientHeight: 600 },
  marqueeEl: { style: {} },
  gizmo: { enabled: true, axis: null }, castAt() {},
});
Object.assign(stageMock.cb, {
  onSelectKnot() {},
  onSelectEdge(edge: [number, number], mode: string) {
    const named: NamedEdge = [source.vertexIds[edge[0]], source.vertexIds[edge[1]]];
    selection = mode === 'replace' ? [named] : [...selection, named];
    layer.refreshPath();
  },
});
const routerLayers = {
  edgeExtrusion: layer, rideCtl: { riding: false },
  cameraCtl: { activePointers: new Set(), touchPts: new Map(), orbiting: false, flying: false },
  picking: { vertexSourceAtPointer: () => 'authored', pickCorner: () => null, pickFreeEdgeAt: () => pickedGuide },
  selection: { clearRefLoops() {}, referenceMeshSelectionActive: () => false, cageHandleMeshes: [] },
  cage: { cage: true, subCage: false, visibleNubs: () => [] }, transforms: { mode: 'move' },
  clipboardPlacement: { active: false }, surgery: { tool: null, onCommit: () => false },
  tubeTool: { active: false }, trailTool: { active: false }, patchTool: { active: false }, weldTool: { active: false },
  createEdge: { armed: false, pickCoincidentVertices: () => null, pickEdgeCrossing: () => null },
  gems: { gemLine: null },
} as unknown as Parameters<typeof createPointerRouter>[2];
createPointerRouter(stage, { editPickKinds: { point: true, edge: true, patch: true, prop: false } } as Parameters<typeof createPointerRouter>[1],
  routerLayers, {
    mode: () => 'edit', isMountain: () => true, reference: () => null, refData: () => null,
    preview: () => ({}), pickAnchor: () => undefined, pickKnot: () => undefined,
  } as Parameters<typeof createPointerRouter>[3], { selectReference() {}, clearRefSelection() {} });
function guideClick(edge: [number, number], ctrlKey = false, pointerType = 'mouse') {
  pickedGuide = edge;
  for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
    const event = { type, button: 0, pointerId: 1, pointerType, clientX: 400, clientY: 300,
      ctrlKey, shiftKey: false, metaKey: false, altKey: false, target: dom,
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
    } as unknown as PointerEvent;
    for (const handler of handlers.get(type) ?? []) handler(event);
  }
}
assert(layer.beginStage());
assert.equal(layer.mode, 'pull');
layer.setSegmentLength(2);
assert.equal(layer.segmentLength, 2);
assert.equal(layer.segments, 5);
guideClick([3, 4]);
assert.deepEqual(selection, [[source.vertexIds[1], source.vertexIds[3]]], 'Pull mode keeps the source selection while placing');
layer.setMode('path');
const highlight = stageMock.worldRoot.getObjectByName('edge-extrusion-source')!;
assert.deepEqual(selection, [], 'Path entry clears the yellow selection for picking a separate guide');
assert(highlight.visible && highlight.children.length === 1, 'Source stays highlighted before choosing a guide');
const sourceLine = highlight.children[0] as LineSegments2;
assert.equal(sourceLine.material.color.getHex(), BRIDGE_RAIL_COLORS[0]);
assert.equal(sourceLine.material.depthTest, false);
const sourceSegments = meshEdgeSegments(original.mesh, original.edgeHandle, [[1, 3]]);
assert.deepEqual(Array.from((sourceLine.geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute).data.array), Array.from(new Float32Array(sourceSegments)));
layer.setMode('pull');
assert.deepEqual(selection, [[source.vertexIds[1], source.vertexIds[3]]]);
assert(!highlight.visible && !highlight.children.length);
assert.equal(layer.segments, 5, 'Returning to Pull restores the staged pull geometry');
assert.equal(stageMock.gizmoKind, 'edgeextrusion');
layer.setMode('path');
layer.commitStage();
assert.match(lastError, /Select the path edges/);
assert.equal(committed, 0);
guideClick([3, 4]);
guideClick([4, 5], true);
assert.deepEqual(selection, [[source.vertexIds[3], source.vertexIds[4]], [source.vertexIds[4], source.vertexIds[5]]],
  'A staged Path extrusion allows click and Ctrl-click guide selection through the pointer router');
assert.equal(layer.error, '');
assert.equal(layer.segments, 2);
assert(highlight.visible && highlight.children.length === 1);
layer.commitStage();
assert.equal(committed, 1);
assert.equal(layer.staged, false);
assert.equal(layer.mode, 'pull');
assert(!highlight.visible && !highlight.children.length);
assert.notDeepEqual(selection, [[source.vertexIds[1], source.vertexIds[3]]], 'Commit preserves the new outer-edge selection');
selection = [[source.vertexIds[1], source.vertexIds[3]]];
assert(layer.beginStage());
assert.equal(layer.segmentLength, 2, 'A configured length is remembered for the next extrusion');
layer.setMode('path');
guideClick([3, 4], false, 'touch');
assert.equal(layer.segments, 1, 'A touch tap also selects a guide while Path is staged');
layer.cancel();
assert.equal(layer.staged, false);
assert.deepEqual(selection, [[source.vertexIds[1], source.vertexIds[3]]], 'Cancel restores captured source, not guide edges');
assert(!highlight.visible && !highlight.children.length);
assert(layer.beginStage());
layer.setMode('path');
layer.setPath('path:0000');
assert.equal(layer.error, '');
assert(layer.segments > 1);
layer.setReversePath(true);
assert.equal(layer.error, '');
layer.commitStage();
assert.equal(committed, 2);
selection = [[source.vertexIds[1], source.vertexIds[3]]];
assert(layer.beginStage());
layer.setMode('path');
currentDoc = { ...source, vertexIds: source.vertexIds.map(id => `renamed:${id}`) };
layer.refreshPath();
assert.match(layer.error, /geometry this mountain has since changed/);
assert(!highlight.visible && !highlight.children.length);
layer.commitStage();
assert.equal(layer.staged, false);
assert.equal(committed, 2, 'A stale source never commits');
assert.deepEqual(source, before);

console.log('Edge extrusion Pull / Path checks passed.');
