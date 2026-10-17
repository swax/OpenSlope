// tier: fast
/**
 * Create Grid (src/core/mesh/ops/grid.ts): a flat lattice from three clicked corners, divided by counts or by a
 * target patch size, whose free corners can then be moved; it attaches to an open run of edges it is snapped
 * along and takes that run's divisions as its own.
 * Run: `npx tsx test/create-grid.test.ts`
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { seedMeshIds } from '../src/core/doc/ids';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import {
  appendGrid,
  checkManifold,
  gridCornersFromClicks,
  gridDivisionsForSize,
  gridHinge,
  gridLengthFixed,
  gridSideChain,
  gridWidthFixed,
  planGrid,
  resizeGridLength,
  resizeGridWidth,
  type GridCorner,
  type GridCorners,
  type GridOptions,
} from '../src/core/mesh/ops';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { patchNormal } from '../src/core/math/bezier';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import { resolvePlacementEndpoint } from '../src/app/viewport/input/placement';
import { normalsAgreeAcrossSeams, watertight } from './meshops.fixture';

const base = () =>
  meshFromNet(
    { rows: 2, cols: 2, spacing: 10, corners: [0, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10], paint: {} },
    { name: 'GRID', course: starterCourse(), baseSurface: 1 },
  );

/** A level quilt of the listed cells, corner (r, c) at x = 10r, z = 10c. Its front, (B−A)×(C−A) = +z × +x,
 *  faces up. Only corners a kept cell uses exist, so a missing cell leaves a real notch. */
function quilt(cells: [number, number][]): QuadMeshDoc {
  const index = new Map<string, number>(),
    vertices: number[] = [];
  const v = (r: number, c: number) => {
    const key = `${r},${c}`;
    if (!index.has(key)) {
      index.set(key, vertices.length / 3);
      vertices.push(r * 10, 0, c * 10);
    }
    return index.get(key)!;
  };
  const quads = cells.map(([r, c]) => [v(r, c), v(r, c + 1), v(r + 1, c), v(r + 1, c + 1)]);
  return { ...base(), vertices, quads, edgeHandles: {}, ...seedMeshIds(0, vertices.length / 3, quads.length) };
}
const vertexAt = (doc: QuadMeshDoc, x: number, z: number) => {
  for (let i = 0; i < doc.vertices.length / 3; i++)
    if (Math.abs(doc.vertices[i * 3] - x) < 1e-9 && Math.abs(doc.vertices[i * 3 + 2] - z) < 1e-9) return i;
  throw new Error(`no vertex at ${x}, ${z}`);
};
const free = (pos: V3): GridCorner => ({ pos, vertex: null });
const snapped = (doc: QuadMeshDoc, vertex: number): GridCorner => ({
  pos: [doc.vertices[vertex * 3], doc.vertices[vertex * 3 + 1], doc.vertices[vertex * 3 + 2]],
  vertex,
});

const clicks = (first: GridCorner, second: GridCorner, third: GridCorner) =>
  gridCornersFromClicks(first, second, third);
const near = (a: readonly number[], b: readonly number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

function grow(doc: QuadMeshDoc, corners: GridCorners, options: GridOptions) {
  const before = structuredClone(doc);
  const planned = planGrid(doc, corners, options);
  assert(planned.ok, planned.ok ? '' : planned.error);
  const result = appendGrid(doc, planned.plan);
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(doc, before, 'planning and appending never mutate the source');
  assert(checkManifold(result.doc.quads).ok && watertight(result.doc).ok);
  assert(normalsAgreeAcrossSeams(result.doc), 'shared seams run opposite ways');
  assert.deepEqual(result.doc.vertexIds.slice(0, doc.vertexIds.length), doc.vertexIds, 'existing identities survive');
  assert(!buildMountainPreview(result.doc).positions.some(x => !Number.isFinite(x)));
  return { plan: planned.plan, result };
}
const fronts = (doc: QuadMeshDoc, quads: number[]) => {
  const { mesh, edgeHandle } = meshFromDoc(doc);
  return quads.map(q => patchNormal(quadControlPoints(mesh, edgeHandle, q), 0.5, 0.5));
};

// A free grid: the third corner is squared off against the first side, and the counts cut it evenly.
{
  const empty: QuadMeshDoc = { ...base(), vertices: [], quads: [], ...seedMeshIds(0, 0, 0) };
  const corners = clicks(free([0, 0, 0]), free([30, 0, 0]), free([24, 0, 20]));
  assert.deepEqual(
    corners.map(c => c.pos),
    [
      [0, 0, 0],
      [30, 0, 0],
      [30, 0, 20],
      [0, 0, 20],
    ],
    'the third click is squared off',
  );
  const { plan, result } = grow(empty, corners, { columns: 3, rows: 2, eye: [15, 100, 10] });
  assert.equal(plan.columns, 3);
  assert.equal(plan.rows, 2);
  assert(!plan.inheritedColumns && !plan.inheritedRows && !gridLengthFixed(corners) && !gridWidthFixed(corners));
  assert.equal(result.doc.vertices.length / 3, 12);
  assert.equal(result.doc.quads.length, 6);
  assert.equal(watertight(result.doc).boundary, 10);
  assert.deepEqual(
    [plan.points[0], plan.points[3], plan.points[11], plan.points[8]],
    [
      [0, 0, 0],
      [30, 0, 0],
      [30, 0, 20],
      [0, 0, 20],
    ],
  );
  assert.equal(plan.length, 30);
  assert.equal(plan.width, 20);
  assert(
    result.doc.vertices.every((x, i) => i % 3 !== 1 || x === 0),
    'the grid is flat',
  );
  assert(
    fronts(result.doc, result.quads).every(n => n[1] > 0.99),
    'drawn from above, it faces up',
  );
  const below = grow(empty, corners, { columns: 3, rows: 2, eye: [15, -100, 10] });
  assert(
    fronts(below.result.doc, below.result.quads).every(n => n[1] < -0.99),
    'drawn from below, it faces down',
  );

  assert.deepEqual(
    resizeGridLength(corners, 50).map(c => c.pos),
    [
      [0, 0, 0],
      [50, 0, 0],
      [50, 0, 20],
      [0, 0, 20],
    ],
    "a typed length moves the first side's far end and carries the side across from it",
  );
  assert.deepEqual(
    resizeGridWidth(corners, 8).map(c => c.pos),
    [
      [0, 0, 0],
      [30, 0, 0],
      [30, 0, 8],
      [0, 0, 8],
    ],
    'a typed width moves both far corners',
  );
  assert(
    !planGrid(empty, clicks(free([0, 0, 0]), free([0, 0, 0]), free([5, 0, 5])), { columns: 2, rows: 2 }).ok,
    'a zero-length side is refused',
  );
  assert(
    !planGrid(empty, clicks(free([0, 0, 0]), free([10, 0, 0]), free([20, 0, 0])), { columns: 2, rows: 2 }).ok,
    'a zero width is refused',
  );
  assert(!planGrid(empty, corners, { columns: 0, rows: 2 }).ok, 'a count below one is refused');
  assert(!planGrid(empty, corners, { columns: 2.5, rows: 2 }).ok, 'a fractional count is refused');
}

// Snapped along a patch rim: the rim becomes the first side and its edge count overrides the columns asked for.
{
  const doc = quilt([
    [0, 0],
    [0, 1],
  ]);
  const a = vertexAt(doc, 0, 0),
    mid = vertexAt(doc, 0, 10),
    b = vertexAt(doc, 0, 20);
  assert.deepEqual(gridSideChain(doc, a, b), [a, mid, b]);
  assert.deepEqual(gridSideChain(doc, b, a), [b, mid, a]);
  const before = meshFromDoc(doc),
    shape = doc.quads.map((_, q) => quadControlPoints(before.mesh, before.edgeHandle, q));
  const corners = clicks(snapped(doc, a), snapped(doc, b), free([-12, 0, 20]));
  const { plan, result } = grow(doc, corners, { columns: 7, rows: 3, eye: [0, -100, 0] });
  assert(plan.inheritedColumns && !plan.inheritedRows && gridLengthFixed(corners));
  assert.equal(resizeGridLength(corners, 99), corners, 'a pinned side cannot be resized');
  assert.equal(plan.columns, 2);
  assert.equal(plan.rows, 3);
  assert.deepEqual(plan.reuse.slice(0, 3), [a, mid, b], "the rim's own points are the first row");
  assert.equal(result.vertices.length, 3 * 4 - 3);
  assert.equal(result.quads.length, 6);
  assert.equal(watertight(result.doc).boundary, 6 + 10 - 2 * 2, 'the two rim edges are now interior seams');
  assert(
    fronts(result.doc, result.quads).every(n => n[1] > 0.99),
    'the attached patches face the way their neighbours do',
  );
  const after = meshFromDoc(result.doc);
  assert.deepEqual(
    doc.quads.map((_, q) => quadControlPoints(after.mesh, after.edgeHandle, q)),
    shape,
    'the existing patches keep their shape',
  );
}

// Snapped into a notch on two rims: each side takes its rim's divisions, and the grid closes the notch.
{
  const cells: [number, number][] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (r < 2 || c < 2) cells.push([r, c]);
  const doc = quilt(cells);
  const a = vertexAt(doc, 20, 40),
    b = vertexAt(doc, 20, 20),
    c = vertexAt(doc, 40, 20);
  const corners = clicks(snapped(doc, a), snapped(doc, b), snapped(doc, c));
  const { plan, result } = grow(doc, corners, { columns: 5, rows: 5, patchSize: 3 });
  assert(
    plan.inheritedColumns && plan.inheritedRows && gridWidthFixed(corners),
    'attached sides keep their divisions, even by size',
  );
  assert.equal(plan.columns, 2);
  assert.equal(plan.rows, 2);
  assert.equal(result.vertices.length, 4);
  assert.equal(result.quads.length, 4);
  assert.equal(watertight(result.doc).boundary, 16, 'only the outer rim of a full 4 × 4 is left open');
}

// A rim that wanders far from the straight line between the two points is not taken as the side.
{
  const doc = quilt([
    [0, 0],
    [0, 1],
  ]);
  const a = vertexAt(doc, 0, 0),
    b = vertexAt(doc, 10, 20);
  assert.equal(gridSideChain(doc, a, b), null);
  const planned = planGrid(doc, clicks(snapped(doc, a), snapped(doc, b), free([30, 0, 0])), { columns: 3, rows: 1 });
  assert(planned.ok && !planned.plan.inheritedColumns && planned.plan.columns === 3);
  assert(planned.plan.reuse[0] === a && planned.plan.reuse[3] === b, 'the snapped ends are still reused');
  // Two points across an interior edge: a one-column grid would stack a third patch on it.
  const across = planGrid(
    doc,
    clicks(snapped(doc, vertexAt(doc, 0, 10)), snapped(doc, vertexAt(doc, 10, 10)), free([5, 0, -10])),
    { columns: 1, rows: 1 },
  );
  assert(!across.ok && /interior edge/.test(across.error));
}

// Free construction edges attach too, and the grid consumes them as its patch sides.
{
  const points: V3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [20, 0, 0],
  ];
  const doc: QuadMeshDoc = {
    ...base(),
    vertices: points.flat(),
    quads: [],
    freeEdges: [
      [0, 1],
      [1, 2],
    ],
    ...seedMeshIds(0, 3, 0),
  };
  const { plan, result } = grow(doc, clicks(snapped(doc, 0), snapped(doc, 2), free([20, 0, 10])), {
    columns: 6,
    rows: 1,
  });
  assert(plan.inheritedColumns && plan.columns === 2);
  assert.equal(result.doc.freeEdges, undefined, 'the attached free edges became patch sides');
}

// Divided by a patch size: each side takes the count whose patches come closest to it.
{
  assert.equal(gridDivisionsForSize(10, 4), 3, '3.33 m patches beat 5 m ones for a 4 m target');
  assert.equal(gridDivisionsForSize(10, 4.2), 2, '5 m patches beat 3.33 m ones for a 4.2 m target');
  assert.equal(gridDivisionsForSize(1, 10), 1, 'a side shorter than the size still gets one patch');
  const empty: QuadMeshDoc = { ...base(), vertices: [], quads: [], ...seedMeshIds(0, 0, 0) };
  const planned = planGrid(empty, clicks(free([0, 0, 0]), free([30, 0, 0]), free([30, 0, 20])), {
    columns: 1,
    rows: 1,
    patchSize: 7,
  });
  assert(planned.ok);
  assert.equal(planned.plan.columns, 4);
  assert.equal(planned.plan.rows, 3);
  assert.equal(planned.plan.cellLength, 7.5);
  assert(
    !planGrid(empty, clicks(free([0, 0, 0]), free([30, 0, 0]), free([30, 0, 20])), {
      columns: 1,
      rows: 1,
      patchSize: 0,
    }).ok,
    'a zero patch size is refused',
  );
}

// A moved corner bends the lattice bilinearly, leaving attached sides exactly where they are; a fold is refused.
{
  const empty: QuadMeshDoc = { ...base(), vertices: [], quads: [], ...seedMeshIds(0, 0, 0) };
  const [a, b, c] = clicks(free([0, 0, 0]), free([30, 0, 0]), free([30, 0, 20]));
  const { plan } = grow(empty, [a, b, c, free([-10, 0, 20])], { columns: 3, rows: 2, eye: [0, 100, 0] });
  assert(near(plan.points[2 * 4], [-10, 0, 20]), 'the lattice reaches the moved corner');
  assert(near(plan.points[1 * 4 + 1], [20 / 3, 0, 10]), 'inside, it is the bilinear blend of the four corners');
  assert(near(plan.points[3], [30, 0, 0]) && near(plan.points[11], [30, 0, 20]), 'the other corners stay put');
  const folded = planGrid(empty, [a, b, c, free([40, 0, -5])], { columns: 3, rows: 2 });
  assert(!folded.ok && /fold/.test(folded.error), 'a corner dragged across the grid is refused');

  const doc = quilt([
    [0, 0],
    [0, 1],
  ]);
  const rim = [vertexAt(doc, 0, 0), vertexAt(doc, 0, 10), vertexAt(doc, 0, 20)];
  const [ra, rb, rc] = clicks(snapped(doc, rim[0]), snapped(doc, rim[2]), free([-12, 0, 20]));
  const bent = grow(doc, [ra, rb, rc, free([-20, 0, -5])], { columns: 1, rows: 2 });
  assert.deepEqual(bent.plan.reuse.slice(0, 3), rim, 'the attached rim is still the first row');
  assert(near(bent.plan.points[2 * 3], [-20, 0, -5]), 'and the free far corner went where it was dragged');
}

// A draft drawn off an edge — one side snapped, its far side free — hinges on that side, and swung on it the grid
// still attaches along the rim.
{
  const doc = quilt([
    [0, 0],
    [0, 1],
  ]);
  const rim = [vertexAt(doc, 0, 0), vertexAt(doc, 0, 10), vertexAt(doc, 0, 20)],
    c = vertexAt(doc, 10, 20);
  const off = clicks(snapped(doc, rim[0]), snapped(doc, rim[2]), free([-12, 0, 20]));
  assert.deepEqual(gridHinge(off), [0, 1], 'the first side snapped: it hinges there');
  assert.deepEqual(
    gridHinge(clicks(free([0, 0, 30]), snapped(doc, rim[2]), snapped(doc, c))),
    [1, 2],
    'the second side',
  );
  assert.deepEqual(
    gridHinge([off[0], free([0, 0, -9]), free([9, 0, -9]), { pos: [9, 0, 0], vertex: c }]),
    [3, 0],
    'the last side, round the rim to the first corner',
  );
  assert.equal(
    gridHinge(clicks(free([0, 0, -40]), free([0, 0, -10]), free([-10, 0, -10]))),
    null,
    'a free draft has none',
  );
  assert.equal(
    gridHinge(clicks(snapped(doc, rim[0]), free([0, 0, -20]), free([-10, 0, -20]))),
    null,
    'nor one snapped corner',
  );
  assert.equal(
    gridHinge([off[0], free([-9, 0, 0]), { pos: [10, 0, 20], vertex: c }, free([0, 0, 20])]),
    null,
    'nor two snapped across a diagonal',
  );
  assert.equal(
    gridHinge(clicks(snapped(doc, rim[0]), snapped(doc, rim[2]), snapped(doc, c))),
    null,
    'nor a notch, snapped on two sides',
  );
  // Swung up a quarter turn about the rim, the far side stands over it.
  const swung = grow(doc, [off[0], off[1], free([0, 12, 20]), free([0, 12, 0])], { columns: 1, rows: 2 });
  assert.deepEqual(swung.plan.reuse.slice(0, 3), rim, 'the rim is still the first row');
  assert(near(swung.plan.points[2 * 3], [0, 12, 0]) && near(swung.plan.points[2 * 3 + 2], [0, 12, 20]), 'over the rim');
}

// Placement: a later corner lands on the level plane through the previous one, snapped across it but never off it.
{
  const raycaster = new THREE.Raycaster();
  const stage = {
    ray: raycaster,
    pickSurface: () => null,
    screenPlanePoint: () => new THREE.Vector3(2, 8, -3),
    snapDataPoint: (p: V3) => p.map(v => Math.round(v / 5) * 5) as V3,
  } as unknown as Parameters<typeof resolvePlacementEndpoint>[0]['stage'];
  let vertex: { pos: V3; vertex: number } | null = null;
  const resolver = { stage, terrain: () => new THREE.Mesh(), pickVertex: () => vertex };
  const aim = (direction: [number, number, number]) =>
    raycaster.ray.set(new THREE.Vector3(0, 50, 0), new THREE.Vector3(...direction).normalize());
  const at = (anchor: V3) => resolvePlacementEndpoint(resolver, anchor, { levelPlane: true })?.pos.join(',');
  aim([1, -1, 1]); // meets y = 10.3 at scene (39.7, 10.3, 39.7): data z is −scene z
  assert.equal(at([0, 10.3, 0]), '40,10.3,-40', 'the level plane through the anchor, snapped across it only');
  aim([1, 1, 0]);
  assert.equal(at([0, 10.3, 0]), '0,10,5', 'a ray that never meets the plane falls back to the screen-facing one');
  aim([1, -0.001, 0]);
  assert.equal(at([0, 10.3, 0]), '0,10,5', 'a hit grazing the horizon falls back too');
  vertex = { pos: [4, 4, 4], vertex: 7 };
  assert.equal(at([0, 10.3, 0]), '4,4,4', 'a vertex snap still wins');
}

console.log('CREATE GRID: PASS');
