// tier: fast
import assert from 'node:assert/strict';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { seedMeshIds } from '../src/core/doc/ids';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { fillSelectedEdgeHoles, checkManifold, ekey } from '../src/core/mesh/ops';
import { liveQuadEdges } from '../src/core/mesh/primitives';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { normalsAgreeAcrossSeams } from './meshops.fixture';

type Edge = [number, number];
const ring = (ids: number[]): Edge[] => ids.map((id, i) => [id, ids[(i + 1) % ids.length]]);
function grid(): QuadMeshDoc {
  const corners: number[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) corners.push(col * 10, Math.sin(row + col), row * 10);
  return meshFromNet({ rows: 5, cols: 5, spacing: 10, corners, paint: {} },
    { name: 'FILL', course: starterCourse(), baseSurface: 1 });
}
function wire(points: V3[], edges: Edge[]): QuadMeshDoc {
  return { ...grid(), vertices: points.flat(), quads: [], freeEdges: edges, ...seedMeshIds(0, points.length, 0) };
}
function fill(doc: QuadMeshDoc, selected: Edge[]) {
  const before = structuredClone(doc), result = fillSelectedEdgeHoles(doc, selected);
  assert.deepEqual(doc, before, 'the operation never mutates the source');
  assert(result.ok, result.ok ? '' : result.error);
  assert(checkManifold(result.doc.quads).ok);
  assert(normalsAgreeAcrossSeams(result.doc));
  assert.deepEqual(result.doc.vertices, doc.vertices, 'no extra corners');
  assert.deepEqual(result.doc.vertexIds, doc.vertexIds, 'existing corner identities survive');
  assert.deepEqual(result.doc.quadIds.slice(0, doc.quads.length), doc.quadIds);
  assert(!buildMountainPreview(result.doc).positions.some(v => !Number.isFinite(v)));
  return result;
}

// Two non-planar openings in a quilt, selected out of order alongside an existing face and an open chain.
{
  const doc = grid(), holes = [5, 10];
  const edges = holes.flatMap(q => liveQuadEdges(doc.quads[q]));
  const existing = liveQuadEdges(doc.quads[0]);
  doc.quads = doc.quads.filter((_, q) => !holes.includes(q));
  doc.quadIds = doc.quadIds.filter((_, q) => !holes.includes(q));
  doc.quadPaint = { 0: 7 }; doc.quadTex = { 0: 'TEST/SNOW.png' };
  doc.edgeHandles = { '6>7': [2, 0.3, 1] };
  const before = meshFromDoc(doc), controls = doc.quads.map((_, q) => quadControlPoints(before.mesh, before.edgeHandle, q));
  const selected = [...edges, ...existing, [3, 4] as Edge].reverse().map(([a, b]): Edge => [b, a]);
  const result = fill(doc, selected);
  assert.deepEqual(result.quads, [14, 15]);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.doc.quadPaint, doc.quadPaint);
  assert.deepEqual(result.doc.quadTex, doc.quadTex);
  assert.deepEqual(result.doc.edgeHandles?.['6>7'], doc.edgeHandles['6>7']);
  const after = meshFromDoc(result.doc);
  controls.forEach((points, q) => assert.deepEqual(quadControlPoints(after.mesh, after.edgeHandle, q), points,
    'existing patch curves are frozen exactly'));
  assert.deepEqual(fill(doc, [...selected].reverse()).doc, result.doc, 'selection ordering does not change results');
  assert(!fillSelectedEdgeHoles(result.doc, selected).ok, 'repeated filling cannot duplicate faces');
}

// A wire quilt: adjoining holes can share a selected free edge; duplicates and dangling edges are harmless.
{
  const points: V3[] = [];
  for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) points.push([x * 10, 0, z * 10]);
  const edges: Edge[] = [];
  for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
    if (x < 2) edges.push([z * 3 + x, z * 3 + x + 1]);
    if (z < 2) edges.push([z * 3 + x, (z + 1) * 3 + x]);
  }
  points.push([-10, 0, 0]); edges.push([0, 9]);
  const doc = wire(points, edges), result = fill(doc, [...edges, [1, 0]]);
  assert.equal(result.quads.length, 4);
  assert.deepEqual(result.doc.freeEdges, [[0, 9]]);
}

// Disconnected triangle + quad are filled together; a triangular wedge retains three real edges.
{
  const edges = [...ring([0, 1, 2]), ...ring([3, 4, 5, 6])];
  const doc = wire([[0, 0, 0], [10, 0, 0], [5, 0, 10], [20, 0, 0], [30, 0, 0], [30, 0, 10], [20, 0, 10]], edges);
  const result = fill(doc, edges);
  assert.equal(result.quads.length, 2);
  assert.equal(new Set(result.doc.quads[0]).size, 3);
  assert.equal(result.doc.quads[0][2], result.doc.quads[0][3]);
  assert(!result.doc.freeEdges?.length);
}

// Fill outward from existing terrain so its normal propagates through an entire wire strip, even when
// the first numbered hole is far away and the existing terrain faces opposite the standalone default.
{
  const points: V3[] = [];
  for (let z = 0; z < 2; z++) for (let x = 0; x < 5; x++) points.push([x * 10, 0, z * 10]);
  const edges = [0, 1, 2].flatMap(x => ring([x, x + 1, x + 6, x + 5]));
  const doc = wire(points, edges.filter(([a, b]) => ekey(a, b) !== '3,8'));
  doc.quads = [[3, 4, 8, 9]];
  Object.assign(doc, seedMeshIds(0, 10, 1));
  assert.equal(fill(doc, edges).quads.length, 3);
}

// A bad loop doesn't stop another valid hole from being filled in the same selection.
{
  const edges = [...ring([0, 1, 2]), ...ring([3, 4, 5])];
  const result = fill(wire([[0, 0, 0], [10, 0, 0], [5, 0, 10], [20, 0, 0], [30, 0, 0], [40, 0, 0]], edges), edges);
  assert.equal(result.quads.length, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.doc.freeEdges?.length, 3);
}

const square: V3[] = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
// A selected diagonal creates two triangular holes, never an overlapping outer quad. If the diagonal is
// unselected there is no complete selected hole; the outer cycle must not conceal it.
{
  const edges = [...ring([0, 1, 2, 3]), [0, 2] as Edge], doc = wire(square, edges);
  assert(!fillSelectedEdgeHoles(doc, edges.slice(0, 4)).ok);
  const result = fill(doc, edges);
  assert.equal(result.quads.length, 2);
  assert(result.doc.quads.every(q => new Set(q).size === 3));
  assert(!fillSelectedEdgeHoles(result.doc, edges.slice(0, 4)).ok);
}

// A flat, already-filled fan must not be covered by a second large patch. A genuinely open 3D bowl can
// be capped, however: its internal vertex lies away from the opening plane.
for (const depth of [0, -10]) {
  const doc = wire([...square, [5, depth, 5]], []);
  doc.quads = [[0, 1, 4, 4], [1, 2, 4, 4], [2, 3, 4, 4], [3, 0, 4, 4]];
  Object.assign(doc, seedMeshIds(0, 5, 4));
  if (depth === 0) assert(!fillSelectedEdgeHoles(doc, ring([0, 1, 2, 3])).ok);
  else assert.equal(fill(doc, ring([0, 1, 2, 3])).quads.length, 1);
}

// Vertical and mildly nonplanar outlines are supported (not restricted to an X/Z ground projection).
for (const points of [square.map(([x, , z]): V3 => [x, z, 0]), square.map(([x, , z], i): V3 => [x, i === 2 ? 3 : 0, z])]) {
  const edges = ring([0, 1, 2, 3]);
  assert.equal(fill(wire(points, edges), edges).quads.length, 1);
}

// Invalid / incomplete outlines do not change the source or fabricate unselected sides.
for (const [points, ids] of [
  [[[0, 0, 0], [5, 0, 0], [10, 0, 0]], [0, 1, 2]],
  [square, [0, 2, 1, 3]],
  [[[0, 0, 0], [10, 0, 0], [10, 0, 10], [5, 0, 15], [0, 0, 10]], [0, 1, 2, 3, 4]],
] as [V3[], number[]][]) {
  const edges = ring(ids), doc = wire(points, edges), before = structuredClone(doc);
  assert(!fillSelectedEdgeHoles(doc, edges).ok);
  assert.deepEqual(doc, before);
}
{
  const edges = ring([0, 1, 2, 3]), doc = wire(square, edges);
  for (const selected of [[], edges.slice(0, 2), edges.slice(0, 3), [...edges, [0, 99] as Edge]])
    assert(!fillSelectedEdgeHoles(doc, selected).ok);
}

// The two-face capacity guard is respected even if every edge on the whole quilt is selected.
{
  const doc = grid(), edges = [...new Map(doc.quads.flatMap(liveQuadEdges).map(edge => [ekey(...edge), edge])).values()];
  assert(!fillSelectedEdgeHoles(doc, edges).ok);
}

// Dense arbitrary graphs fail with a bounded, understandable error rather than locking the editor.
{
  const points = Array.from({ length: 90 }, (_, i): V3 => [i, 0, i % 3]), edges: Edge[] = [];
  for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++) edges.push([a, b]);
  const result = fillSelectedEdgeHoles(wire(points, edges), edges);
  assert(!result.ok && /smaller group/.test(result.error));
}
console.log('EDGE HOLE FILL: PASS');
