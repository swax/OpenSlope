// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import { appendMeshIds } from '../src/core/doc/ids';
import {
  createSurfaceFromDrawnBoundary,
  surfaceBoundaryDraft,
  surfaceBoundaryCorners,
} from '../src/core/mesh/surface-boundary';
import { inferSurfaceCorners } from '../src/core/mesh/surface-corners';
import {
  rebuildSurfaceCorners,
  surfaceCornerBoundary,
  remapSurfaceCornerStitches,
} from '../src/core/mesh/surface-corner-edit';
import { addSurfaceStitch } from '../src/core/mesh/surface-stitch';
import {
  insertSurfaceRow,
  deleteSurfaceControls,
  rebuildSurface,
  refreshSurfaces,
  boundarySurfaceInput,
} from '../src/core/mesh/surface-object';
import { chartPoint, guideCharts } from '../src/core/mesh/surface-guides';
import { checkManifold } from '../src/core/mesh/ops/contract';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { quadPerimeterEdges, undirectedEdgeKey, readVertex } from '../src/core/mesh/primitives';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';

const rectangle: V3[] = [
  [40, 0, 0],
  [40, 0, 20],
  [40, 0, 40],
  [40, 0, 80],
  [40, 0, 140],
  [40, 0, 200],
  [120, 0, 200],
  [120, 0, 0],
];
{
  // The BLACK_SUN gap: a geometric corner fit used to stop one point before a snapped trail ended.
  const { boundary, corners, ...mesh } = JSON.parse(
    readFileSync(new URL('./fixtures/surface-stitch-trail-gap.json', import.meta.url), 'utf8'),
  ) as Pick<QuadMeshDoc, 'vertices' | 'quads' | 'edgeHandles' | 'quadTwist'> & {
    boundary: number[];
    corners: number[];
  };
  const doc = { ...blankMountain('TRAIL_GAP'), ...mesh };
  Object.assign(doc, appendMeshIds(doc, mesh.vertices.length / 3, mesh.quads.length));
  const points = boundary.map(vertex => ({ vertex, pos: readVertex(doc.vertices, vertex) })),
    before = structuredClone(doc);
  assert.notDeepEqual(inferSurfaceCorners(points.map(p => p.pos)), corners);
  for (const reverse of [false, true])
    for (let offset = 0; offset < points.length; offset++) {
      const order = points.map((_, i) => (i + offset) % points.length);
      if (reverse) order.reverse();
      assert.deepEqual(
        surfaceBoundaryCorners(
          order.map(i => points[i]),
          doc,
        ),
        corners.map(c => order.indexOf(c)).sort((a, b) => a - b),
        'snapped run endpoints define the same four corners in either drawing direction',
      );
    }
  assert.deepEqual(surfaceBoundaryDraft(doc, points).corners, corners);
  const manual = inferSurfaceCorners(points.map(p => p.pos));
  assert.deepEqual(surfaceBoundaryDraft(doc, points, manual).corners, manual, 'manual picks retain priority');
  const host = meshFromDoc(doc);
  for (const patchSizeM of [15, 25, 40, 60]) {
    const made = createSurfaceFromDrawnBoundary(doc, points, patchSizeM, undefined, 'smooth');
    assert(made.ok, made.ok ? '' : made.error);
    assert.deepEqual(doc, before);
    assert.equal(made.surface.stitches?.length, 2, 'both trails attach without manual corner changes');
    assert(checkManifold(made.doc.quads).ok);
    const counts = new Map<string, number>();
    for (const q of made.doc.quads)
      for (const [a, b] of quadPerimeterEdges(q)) {
        const key = undirectedEdgeKey(a, b);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    for (let i = 0; i < boundary.length; i++) {
      if (corners.includes((i + 1) % boundary.length) && corners.includes(i)) continue;
      const a: number = made.doc.vertexIds.indexOf(doc.vertexIds[boundary[i]]),
        b: number = made.doc.vertexIds.indexOf(doc.vertexIds[boundary[(i + 1) % boundary.length]]);
      assert.equal(counts.get(undirectedEdgeKey(a, b)), 2, 'the seam shares every original trail edge');
    }
    const output = meshFromDoc(made.doc);
    for (let i = 0; i < doc.quads.length; i++) {
      const a = quadControlPoints(host.mesh, host.edgeHandle, i, doc.quadTwist?.[i]),
        at = made.doc.quadIds.indexOf(doc.quadIds[i]),
        b = quadControlPoints(output.mesh, output.edgeHandle, at, made.doc.quadTwist?.[at]);
      a.forEach((p, j) => assert(Math.hypot(...p.map((v, k) => v - b[j][k])) < 1e-6));
    }
    const reopened = refreshSurfaces(migrateMountain(serializeMountain(made.doc)));
    assert(!reopened.surfaces!.some(s => s.error));
    assert.deepEqual(reopened.surfaces, made.doc.surfaces);
  }
  console.log('✓ filling a curved trail gap keeps snapped-run corners, both exact seams and manual picks');
}
const boundaryPoints = (points: V3[]) => points.map(pos => ({ pos, vertex: null }));
function make(doc: QuadMeshDoc, points: V3[], corners?: number[]) {
  const result = createSurfaceFromDrawnBoundary(doc, boundaryPoints(points), 20, corners);
  assert(result.ok, result.ok ? '' : result.error);
  return result.doc;
}
function fixture(incoming = false) {
  let doc = make(blankMountain('CORNERS', 20), [
    [0, 0, 0],
    [0, 0, 80],
    [40, 0, 80],
    [40, 0, 0],
  ]);
  doc = make(doc, rectangle, [0, 3, 6, 7]);
  const [host, follower] = doc.surfaces!;
  return incoming
    ? addSurfaceStitch(
        doc,
        host.id,
        { side: 'v1', range: [0, 1] },
        { surface: follower.id, side: 'v0', range: [0, 1] },
        'crease',
      )
    : addSurfaceStitch(
        doc,
        follower.id,
        { side: 'v0', range: [0, 1] },
        { surface: host.id, side: 'v1', range: [0, 1] },
      );
}
const inferredNames = (doc: QuadMeshDoc, surface = doc.surfaces![1]) => {
  const boundary = surfaceCornerBoundary(doc, surface);
  return inferSurfaceCorners(boundary.loop.map(i => doc.vertices.slice(i * 3, i * 3 + 3) as V3)).map(
    i => doc.vertexIds[boundary.loop[i]],
  );
};
function sharedEdges(doc: QuadMeshDoc) {
  const [a, b] = doc.surfaces!;
  return a.patches.reduce(
    (n, p) => n + Number(p.corners.filter(id => b.patches.some(q => q.corners.includes(id))).length >= 2),
    0,
  );
}
{
  assert.deepEqual(inferSurfaceCorners(rectangle), [0, 5, 6, 7]);
  for (let offset = 0; offset < rectangle.length; offset++) {
    const shifted = [...rectangle.slice(offset), ...rectangle.slice(0, offset)];
    assert.deepEqual(
      inferSurfaceCorners(shifted)
        .map(i => (i + offset) % rectangle.length)
        .sort((a, b) => a - b),
      [0, 5, 6, 7],
    );
  }
  const tilted = rectangle.map(([x, _y, z]) => [1000 + x, 30 + z * 0.4, -500 + z] as V3);
  assert.deepEqual(inferSurfaceCorners(tilted), [0, 5, 6, 7]);
  const skinny: V3[] = [
    [0, 0, 0],
    [0, 0, 10],
    [0, 0, 1000],
    [1, 0, 1000],
    [1, 0, 0],
  ];
  assert.deepEqual(inferSurfaceCorners(skinny), [0, 2, 3, 4]);
  // The eight clicks from the reported rectangle, with elevation changes along its attached side.
  const gari: V3[] = [
    [-472.48, 216.25, -683.47],
    [-471.08, 231.47, -614.77],
    [-468.75, 236.98, -573.14],
    [-467.46, 198.12, -497.58],
    [-467.46, 197.11, -389.57],
    [-467.43, 197.25, -328.22],
    [-346.94, 197.25, -330.44],
    [-352.94, 197.25, -689.59],
  ];
  assert.deepEqual(inferSurfaceCorners(gari), [0, 5, 6, 7]);
  assert.throws(
    () => surfaceBoundaryDraft(blankMountain('INVALID'), boundaryPoints(rectangle), [0, 0, 6, 7]),
    /distinct/,
  );
  assert.throws(() => surfaceBoundaryDraft(blankMountain('INVALID'), boundaryPoints(rectangle), [0, 6, 5, 7]), /order/);
  console.log(
    '✓ corners follow rectangle turns through uneven sampling, first-click rotation, slopes and thin outlines',
  );
}
for (const incoming of [false, true]) {
  const doc = fixture(incoming),
    before = structuredClone(doc),
    surface = doc.surfaces![1],
    names = surfaceCornerBoundary(doc, surface).loop.map(v => doc.vertexIds[v]),
    result = rebuildSurfaceCorners(doc, surface, inferredNames(doc));
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(doc, before, 'preview cannot mutate the authored document');
  assert(checkManifold(result.doc.quads).ok);
  assert(sharedEdges(result.doc) > 0, 'the evaluated seam is still shared topology');
  assert(!result.doc.surfaces!.some(s => s.error));
  for (const id of names) {
    const a = doc.vertexIds.indexOf(id) * 3,
      b: number = result.doc.vertexIds.indexOf(id) * 3;
    assert.deepEqual(
      result.doc.vertices.slice(b, b + 3),
      doc.vertices.slice(a, a + 3),
      'boundary controls keep their identities and positions',
    );
  }
  const st = result.doc.surfaces![incoming ? 0 : 1].stitches![0];
  assert.equal(st.continuity, incoming ? 'crease' : 'smooth');
  assert.equal(
    st.target && 'surface' in st.target ? st.target.surface : '',
    incoming ? surface.id : doc.surfaces![0].id,
  );
  const restored = refreshSurfaces(migrateMountain(serializeMountain(result.doc)));
  assert(!restored.surfaces!.some(s => s.error));
  assert(sharedEdges(restored) > 0);
  assert.deepEqual(surfaceCornerBoundary(restored, restored.surfaces![1]).corners, [0, 5, 6, 7]);
  console.log(
    `✓ ${incoming ? 'incoming crease' : 'outgoing smooth'} surface stitch survives corner changes and serialization`,
  );
}
{
  let doc = blankMountain('PLAIN', 20);
  for (const x of [0, 40]) for (const z of [0, 20, 40, 80]) doc.vertices.push(x, 0, z);
  doc.quads = [
    [0, 1, 4, 5],
    [1, 2, 5, 6],
    [2, 3, 6, 7],
  ];
  Object.assign(doc, appendMeshIds(doc, 8, 3));
  doc = make(doc, rectangle, [0, 3, 6, 7]);
  assert.equal(doc.surfaces![0].stitches?.length, 1);
  const before = structuredClone(doc),
    result = rebuildSurfaceCorners(doc, doc.surfaces![0], inferredNames(doc, doc.surfaces![0]));
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(doc, before);
  assert.deepEqual(result.surface.stitches![0].target, before.surfaces![0].stitches![0].target);
  assert(checkManifold(result.doc.quads).ok);
  console.log('✓ a plain-quad host remains stitched when its source-side corner moves');
}
for (const incoming of [false, true]) {
  const doc = fixture(incoming),
    surface = doc.surfaces![1],
    { loop } = surfaceCornerBoundary(doc, surface),
    edges = loop.map((v, i) => [v, loop[(i + 1) % loop.length]]),
    { paths, curves } = boundarySurfaceInput(
      doc,
      edges,
      [0, 2, 6, 7].map(i => loop[i]),
    ),
    after = {
      ...surface,
      controls: paths.map(p => p.map(v => doc.vertexIds[v])),
      guides: curves.map(c => ({ axis: c.axis, at: c.at, knots: c.knots })),
    },
    mapped = remapSurfaceCornerStitches(doc, surface, after),
    stitches = mapped[incoming ? 0 : 1].stitches!;
  assert.equal(stitches.length, 2, 'a stitch crossing the new corner becomes two constrained spans');
  assert.equal(new Set(stitches.map(st => st.id)).size, 2);
  const ranges = stitches.map(st => (incoming ? st.range : 'surface' in st.target ? st.target.range : [0, 0]));
  assert(
    Math.abs(ranges.reduce((n, r) => n + Math.abs(r[1] - r[0]), 0) - 1) < 1e-8,
    'the entire prior connection remains covered',
  );
  assert(stitches.every(st => st.continuity === (incoming ? 'crease' : 'smooth')));
}
{
  let doc = make(blankMountain('HILL', 20), rectangle, [0, 3, 6, 7]);
  const addedU = insertSurfaceRow(doc, doc.surfaces![0], 'U', 0);
  assert(addedU.ok);
  const addedV = insertSurfaceRow(addedU.doc, addedU.surface, 'V', 0);
  assert(addedV.ok);
  doc = addedV.doc;
  const s = addedV.surface,
    crossing = s.controls[4].find(id => s.controls[5].includes(id));
  assert(crossing);
  doc.vertices[doc.vertexIds.indexOf(crossing) * 3 + 1] += 10;
  const shaped = rebuildSurface(doc, s);
  assert(shaped.ok);
  const old = guideCharts(shaped.doc, shaped.surface),
    result = rebuildSurfaceCorners(shaped.doc, shaped.surface, inferredNames(shaped.doc, shaped.surface));
  assert(result.ok, result.ok ? '' : result.error);
  assert(
    result.surface.guides!.length >= s.guides!.length,
    'interior guides survive and extra visible curves describe the preserved shape',
  );
  assert(
    !result.surface.seed && !result.surface.guides!.some(g => g.reference),
    'corner changes cannot retain an invisible shape',
  );
  const interior = result.surface.guides!.flatMap((g, i) => (g.at > 0 && g.at < 1 ? [i] : []));
  const cleared = deleteSurfaceControls(result.doc, result.surface, { curves: interior });
  assert(cleared.ok, cleared.ok ? '' : cleared.error);
  assert(
    Math.abs(chartPoint(guideCharts(cleared.doc, cleared.surface), 0.5, 0.5)[1]) < 1e-6,
    'deleting all recreated interior guides removes the preserved hill',
  );
  const next = guideCharts(result.doc, result.surface);
  const oldPeak = Math.max(...old.flatMap(p => p.controls.map(p => p[1]))),
    peak = Math.max(...next.flatMap(p => p.controls.map(p => p[1])));
  assert(peak > 5 && Math.abs(peak - oldPeak) < 2, `the interior hill is retained (${oldPeak} → ${peak})`);
  const refilled = rebuildSurfaceCorners(shaped.doc, shaped.surface, inferredNames(shaped.doc, shaped.surface), false);
  assert(refilled.ok, refilled.ok ? '' : refilled.error);
  assert(
    Math.abs(chartPoint(guideCharts(refilled.doc, refilled.surface), 0.5, 0.5)[1]) < 1e-6,
    'explicit refill starts from the boundary',
  );
  const invalid = rebuildSurfaceCorners(shaped.doc, shaped.surface, ['missing', 'missing', 'missing', 'missing']);
  assert(!invalid.ok);
  console.log(
    '✓ preserving corners retains interior relief and rebuilds its guides; explicit refill removes that relief',
  );
}
