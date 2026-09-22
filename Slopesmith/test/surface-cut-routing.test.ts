// tier: fast
import assert from 'node:assert/strict';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { cubicPoint } from '../src/core/math/bezier';
import { add, mul, sub } from '../src/core/math/vec';
import { meshFromDoc } from '../src/core/mesh/topology';
import { quadPerimeterEdges, readVertex } from '../src/core/mesh/primitives';
import { applySurfaceCut, routeSurfaceCutPath, validateSurfaceCutPath, type SurfaceCutPoint } from '../src/core/mesh/ops';

function grid(xs = [0, 10, 20, 30], rows = 2, omit: number[] = []): QuadMeshDoc {
  const corners: number[] = [];
  for (let row = 0; row < rows; row++) for (const x of xs) corners.push(x, 0, row * 10);
  const doc = meshFromNet({ rows, cols: xs.length, spacing: 10, corners, paint: {} },
    { name: 'CUT ROUTING', course: starterCourse(), baseSurface: 1 });
  doc.quads = doc.quads.filter((_, i) => !omit.includes(i));
  doc.quadIds = doc.quadIds.filter((_, i) => !omit.includes(i));
  // Straight cubics make the geometry of the openings explicit, independent of automatic pole smoothing.
  doc.edgeHandles = {};
  for (const quad of doc.quads) for (const [a, b] of quadPerimeterEdges(quad)) {
    const h = mul(sub(readVertex(doc.vertices, b), readVertex(doc.vertices, a)), 1 / 3);
    doc.edgeHandles[`${a}>${b}`] = h;
    doc.edgeHandles[`${b}>${a}`] = mul(h, -1);
  }
  return doc;
}

function point(doc: QuadMeshDoc, at: SurfaceCutPoint): V3 {
  if ('vertex' in at) return readVertex(doc.vertices, at.vertex);
  const { edgeHandle } = meshFromDoc(doc), [a, b] = at.edge;
  const p0 = readVertex(doc.vertices, a), p3 = readVertex(doc.vertices, b);
  return cubicPoint(p0, add(p0, edgeHandle(a, b)), add(p3, edgeHandle(b, a)), p3, at.t);
}

// Real cuts follow the drawn line, not equally spaced guesses across however many cells a BFS found.
for (const xs of [[0, 10, 20, 30], [0, 1, 7, 30]]) {
  const doc = grid(xs), before = structuredClone(doc);
  const ends: SurfaceCutPoint[] = [{ edge: [0, 4], t: 0.3 }, { edge: [3, 7], t: 0.7 }];
  for (const [start, end] of [ends, [...ends].reverse()]) {
    const route = routeSurfaceCutPath(doc, start, end);
    assert(route && route.length === 4, 'A stroke across three patches crosses the two shared edges');
    assert(validateSurfaceCutPath(doc, route).ok);
    for (const at of route) {
      const [x, , z] = point(doc, at);
      assert(Math.abs(z - (3 + 4 * x / 30)) < 1e-8, 'Every crossing lies on the drawn stroke');
    }
    const cut = applySurfaceCut(doc, route);
    assert(cut.ok && cut.edges.length === 3 && cut.doc.quads.length === 6);
  }
  assert.deepEqual(doc, before, 'Routing and dry-run cutting leave the source unchanged');
}

// Project using the surface orientation: a wall behaves like horizontal terrain, including curved boundaries.
for (const vertical of [false, true]) {
  const doc = grid();
  doc.edgeHandles!['1>5'] = [4, 0, 10 / 3];
  doc.edgeHandles!['5>1'] = [4, 0, -10 / 3];
  doc.edgeHandles!['2>6'] = [0, 0, 1];
  doc.edgeHandles!['6>2'] = [0, 0, -5];
  if (vertical) {
    const rotate = ([x, y, z]: V3): V3 => [x, z, -y];
    doc.vertices = Array.from({ length: doc.vertices.length / 3 }, (_, v) => rotate(readVertex(doc.vertices, v))).flat();
    doc.edgeHandles = Object.fromEntries(Object.entries(doc.edgeHandles!).map(([key, h]) => [key, rotate(h)]));
  }
  const route = routeSurfaceCutPath(doc, { edge: [0, 4], t: 0.5 }, { edge: [3, 7], t: 0.5 });
  assert(route && route.length === 4);
  assert(Math.abs(point(doc, route[1])[0] - 13) < 1e-8, 'The cut follows the true bowed cubic, not its endpoint chord');
  for (const at of route) assert(Math.abs(point(doc, at)[vertical ? 1 : 2] - 5) < 1e-8);
  assert(applySurfaceCut(doc, route).ok);
}

// The projected stroke may rise/fall with the terrain instead of requiring a 3D straight-line intersection.
{
  const doc = grid();
  for (let v = 0; v < doc.vertices.length / 3; v++) doc.vertices[v * 3 + 1] = [0, 3, -2, 0][v % 4];
  delete doc.edgeHandles;
  const route = routeSurfaceCutPath(doc, { edge: [0, 4], t: 0.5 }, { edge: [3, 7], t: 0.5 });
  assert(route && route.length === 4 && applySurfaceCut(doc, route).ok, 'A raised/depressed strip still accepts a surface cut');
}

// Regression: the two lips remain connected elsewhere, but the requested edge crosses empty space.
for (const rows of [3, 4]) {
  const doc = grid(undefined, rows, [4]), before = structuredClone(doc);
  const cases: SurfaceCutPoint[][] = [
    [{ vertex: 5 }, { vertex: 10 }],
    [{ edge: [4, 8], t: 0.5 }, { edge: [7, 11], t: 0.5 }],
  ];
  for (const ends of cases) for (const [start, end] of [ends, [...ends].reverse()])
    assert.equal(routeSurfaceCutPath(doc, start, end), null, 'Never detour around an open notch or an enclosed hole');
  assert.deepEqual(doc, before);
}

// A stroke along existing boundaries / through an intermediate corner must not invent nearby sliver cuts.
{
  const doc = grid([0, 10, 20], 3);
  assert.equal(routeSurfaceCutPath(doc, { vertex: 0 }, { vertex: 8 }), null);
  assert.equal(routeSurfaceCutPath(doc, { vertex: 0 }, { vertex: 2 }), null);
  assert.equal(routeSurfaceCutPath(doc, { vertex: 0 }, { vertex: 0 }), null);
}

console.log('Surface-cut stroke routing checks passed.');
