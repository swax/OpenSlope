// tier: fast
/** Rip endpoints: a boundary-to-boundary cut separates the quilt, including a one-edge cut. */
import assert from 'node:assert/strict';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { getVertex } from '../src/core/doc/doc-edit';
import type { QuadMeshDoc } from '../src/core/doc/types';
import { add, dot, len, mul, norm, sub } from '../src/core/math/vec';
import { applyEdgeRip, applyEdgeWeldSets, checkManifold, ekey } from '../src/core/mesh/ops';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../src/core/mesh/topology';
import { buildMountainPreview } from '../src/core/mesh/tessellation';

function quilt(rows: number, cols: number): QuadMeshDoc {
  const corners: number[] = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) corners.push(c * 10, 0, r * 10);
  return meshFromNet({ rows: rows + 1, cols: cols + 1, spacing: 10, corners, paint: {} },
    { name: 'RIP', course: starterCourse(), baseSurface: 1 });
}

function adjacency(doc: QuadMeshDoc) {
  return meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges));
}

/** Count connectivity through vertices too: halves still joined at an endpoint are not separate quilts. */
function connectedPieces(doc: QuadMeshDoc): number {
  const adj = adjacency(doc), remaining = new Set(doc.quads.flat());
  let pieces = 0;
  while (remaining.size) {
    pieces++;
    const pending = [remaining.values().next().value!];
    while (pending.length) {
      const vertex = pending.pop()!;
      if (!remaining.delete(vertex)) continue;
      pending.push(...adj.neighbors[vertex]);
    }
  }
  return pieces;
}

function ripAndCheck(source: QuadMeshDoc, edges: [number, number][], split: number[], gap = 1) {
  const before = structuredClone(source), result = applyEdgeRip(source, edges, gap);
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(source, before, 'Rip must not mutate its input');
  assert.deepEqual(result.splitVertices.map(([vertex]) => vertex).sort((a, b) => a - b), split.slice().sort((a, b) => a - b));
  assert.equal(result.doc.vertices.length, source.vertices.length + split.length * 3);
  assert.equal(result.doc.quads.length, source.quads.length);
  assert.deepEqual(result.doc.quadIds, source.quadIds);
  assert.deepEqual(result.doc.vertexIds.slice(0, source.vertexIds.length), source.vertexIds);
  assert.equal(new Set(result.doc.vertexIds).size, result.doc.vertices.length / 3);
  assert.equal(result.doc.nextId, source.nextId + split.length);
  const adj = adjacency(result.doc);
  for (const lip of result.lips) {
    assert.equal(lip.length, edges.length);
    for (const [a, b] of lip) assert.equal(adj.edgeQuads.get(ekey(a, b))?.length, 1, 'Every lip is a surface boundary');
  }
  const tangent = norm(sub(getVertex(source, edges[0][1]), getVertex(source, edges[0][0])));
  for (const [original, copy] of result.splitVertices) {
    const a = getVertex(result.doc, original), b = getVertex(result.doc, copy), opening = sub(b, a);
    assert(Math.abs(len(opening) - gap) < 1e-10, 'Every split opens by the requested gap');
    assert(Math.abs(dot(opening, tangent)) < 1e-10, 'Endpoint openings use the path tangent');
    assert(len(sub(mul(add(a, b), 0.5), getVertex(source, original))) < 1e-10, 'Each lip moves by half the gap');
  }
  assert(checkManifold(result.doc.quads).ok);
  assert(buildMountainPreview(result.doc).positions.every(Number.isFinite), 'Ripped patches must still tessellate');
  return result;
}

// The requested 2x2 quilt: all three vertices across the middle split, including both rim endpoints.
for (const edges of [[[1, 4], [4, 7]], [[7, 4], [4, 1]], [[3, 4], [4, 5]]] as [number, number][][]) {
  const source = quilt(2, 2), path = [...new Set(edges.flat())];
  const result = ripAndCheck(source, edges, path);
  assert.equal(connectedPieces(result.doc), 2, 'A rip across a 2x2 quilt must separate it completely');
  const firstLip = new Set(result.lips[0].flat());
  assert(result.lips[1].flat().every(vertex => !firstLip.has(vertex)), 'Through-rip lips share no endpoints');
  assert.equal([...adjacency(result.doc).edgeQuads.values()].filter(quads => quads.length === 1).length, 12);
  const welded = applyEdgeWeldSets(result.doc, result.lips[0], result.lips[1]);
  assert(welded.ok, welded.ok ? '' : welded.error);
  assert.equal(connectedPieces(welded.doc), 1, 'Both halves can be welded back together');
  assert.equal(welded.doc.vertices.length, source.vertices.length);
}

// Either orientation of a single edge from the rim opens just that end; the interior endpoint stays pinned.
for (const edge of [[1, 4], [4, 1], [4, 7], [7, 4]] as [number, number][]) {
  const source = quilt(2, 2), rim = edge.find(vertex => vertex !== 4)!;
  const result = ripAndCheck(source, [edge], [rim]);
  assert.deepEqual(getVertex(result.doc, 4), getVertex(source, 4));
  assert.equal(connectedPieces(result.doc), 1);
  assert.equal([...adjacency(result.doc).edgeQuads.values()].filter(quads => quads.length === 1).length, 10);
}

// A one-edge cut across two adjacent patches splits both rim endpoints.
{
  const source = quilt(1, 2), result = ripAndCheck(source, [[1, 4]], [1, 4], 2);
  assert.equal(connectedPieces(result.doc), 2);
}

// Longer cuts reaching only one rim split that endpoint and keep the endpoint inside the sheet pinned.
for (const edges of [[[2, 7], [7, 12]], [[12, 17], [17, 22]]] as [number, number][][]) {
  const source = quilt(4, 4), split = [...new Set(edges.flat())].filter(vertex => vertex !== 12);
  const result = ripAndCheck(source, edges, split);
  assert.deepEqual(getVertex(result.doc, 12), getVertex(source, 12));
  assert.equal(connectedPieces(result.doc), 1);
}

// Multi-edge slits wholly inside the quilt still pin their ends, even with a free wire attached.
{
  const source = quilt(4, 4);
  source.freeEdges = [[6, 24]];
  const result = ripAndCheck(source, [[6, 7], [7, 8]], [7]);
  for (const vertex of [6, 8]) assert.deepEqual(getVertex(result.doc, vertex), getVertex(source, vertex));
  assert.deepEqual(result.doc.freeEdges, source.freeEdges);
  assert.equal(connectedPieces(result.doc), 1);
}

// Boundary fan tracing follows topology, including a locally reversed patch and explicitly authored handles.
{
  const source = quilt(2, 2);
  const [A, B, C, D] = source.quads[2];
  source.quads[2] = [A, C, B, D];
  source.edgeHandles = { '1>4': [0, 0.5, 3], '4>1': [0, -0.5, -3] };
  source.quadPaint = { 0: 7, 2: 9 };
  source.quadTex = { 1: 'TEST/SNOW.png' };
  source.quadOrient = { 1: { rot: 1, mirror: true } };
  source.quadLocked = { 3: true };
  source.quadLabels = { 2: ['snow'] };
  source.quadTwist = { 0: [[0, 0.1, 0], [0, 0.2, 0], [0, 0.3, 0], [0, 0.4, 0]] };
  const effectiveHandle = meshEdgeHandles(buildQuadMesh(source.vertices, source.quads), source.edgeHandles);
  const result = ripAndCheck(source, [[1, 4], [4, 7]], [1, 4, 7]);
  assert.equal(connectedPieces(result.doc), 2);
  for (const field of ['quadPaint', 'quadTex', 'quadOrient', 'quadLocked', 'quadLabels', 'quadTwist'] as const)
    assert.deepEqual(result.doc[field], source[field]);
  const origins = new Map(result.splitVertices.map(([old, copy]) => [copy, old]));
  for (const [key, incident] of adjacency(result.doc).edgeQuads) {
    assert(incident.length > 0);
    const [a, b] = key.split(',').map(Number);
    for (const [from, to] of [[a, b], [b, a]]) {
      const oldFrom = origins.get(from) ?? from, oldTo = origins.get(to) ?? to;
      if ([1, 4, 7].includes(oldFrom) || [1, 4, 7].includes(oldTo))
        assert.deepEqual(result.doc.edgeHandles?.[`${from}>${to}`], effectiveHandle(oldFrom, oldTo), 'Boundary copies preserve effective handles');
    }
  }
}

// Invalid selections still fail without altering the document.
{
  const interior = quilt(4, 4), beforeInterior = structuredClone(interior);
  const result = applyEdgeRip(interior, [[6, 7]]);
  assert(!result.ok, 'A single edge entirely inside the quilt stays unsupported');
  assert.match(result.error, /at least two connected edges/);
  assert.match(result.error, /quilt boundary/);
  assert.deepEqual(interior, beforeInterior);

  const source = quilt(2, 2), before = structuredClone(source);
  for (const edges of [[], [[0, 1]], [[1, 4], [4, 7], [4, 3]], [[1, 4], [5, 8]], [[1, 4], [4, 5], [5, 2], [2, 1]]] as [number, number][][])
    assert(!applyEdgeRip(source, edges).ok);
  for (const gap of [0, -1, NaN, Infinity]) assert(!applyEdgeRip(source, [[1, 4]], gap).ok);
  assert.deepEqual(source, before);
}

console.log('Rip boundary and single-edge regressions passed.');
