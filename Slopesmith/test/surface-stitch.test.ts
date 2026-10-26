// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { documentRegisters, applyRegisters } from '../src/core/doc/registers';
import {
  createSurfaceFromProfiles,
  rebuildSurface,
  refreshSurfaces,
  bakeSurface,
  deleteSurfaceObject,
} from '../src/core/mesh/surface-object';
import {
  addSurfaceStitch,
  detachSurfaceStitches,
  selectedSurfaceBoundary,
  setSurfaceStitchContinuity,
  evaluateSurfaceStitches,
} from '../src/core/mesh/surface-stitch';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { checkManifold } from '../src/core/mesh/ops/contract';
import { quadPerimeterEdges, undirectedEdgeKey } from '../src/core/mesh/primitives';
import { patchNormal } from '../src/core/math/bezier';
import { createSurfaceFromDrawnBoundary, stitchTouchingSurfaceBoundaries } from '../src/core/mesh/surface-boundary';
import { chartPoint, guideCharts } from '../src/core/mesh/surface-guides';
import { canonicalJson } from '../src/core/doc/canonical';
import { findCoincidentVertices } from '../src/core/mesh/coincident-vertices';
import { findEdgeCrossings } from '../src/core/mesh/edge-crossings';
import { moveMeshVertices, setMeshControlPoints } from '../src/core/mesh/control-points';
import { surfaceSideControls } from '../src/core/mesh/surface-stitch-controls';
import { lockedVertexSet, lockedEdgeSet, setQuadsLocked } from '../src/core/mesh/locks';
import { cellMetrics } from '../src/core/mesh/measure';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';

function plain(count = 4) {
  const doc = blankMountain('STITCH');
  for (const x of [0, 40]) for (let i = 0; i <= count; i++) doc.vertices.push(x, 0, (80 * i) / count);
  doc.quads = Array.from({ length: count }, (_, i) => [i, i + 1, count + 1 + i, count + 2 + i]);
  Object.assign(doc, appendMeshIds(doc, 2 * (count + 1), count));
  return doc;
}
function surface(doc: QuadMeshDoc, x0 = 40, x1 = 100, rise = 0, size = 20, z0 = 0, z1 = 80) {
  const base = doc.vertices.length / 3;
  const input = {
    ...doc,
    vertices: [...doc.vertices, x0, 0, z0, x0, 0, z1, x1, rise, z0, x1, rise, z1],
    ...appendMeshIds(doc, 4, 0),
    freeEdges: [
      ...(doc.freeEdges ?? []),
      [base, base + 1] as [number, number],
      [base + 2, base + 3] as [number, number],
    ],
  };
  const result = createSurfaceFromProfiles(
    input,
    [
      [base, base + 1],
      [base + 2, base + 3],
    ],
    { patchSizeM: size },
  );
  assert(result.ok, result.ok ? '' : result.error);
  return result;
}
const controls = (doc: QuadMeshDoc, id: string) => {
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const i = doc.quadIds.indexOf(id);
  return quadControlPoints(mesh, edgeHandle, i, doc.quadTwist?.[i]);
};
const near = (a: V3, b: V3, eps = 1e-6) => assert(Math.hypot(...a.map((v, i) => v - b[i])) < eps, `${a} != ${b}`);
{
  // BLACK_SUN's nine-point fill from corner 328 joins an ordinary trail to an already stitched surface.
  // The shared corner can be picked through either cage; the transition rim becomes concave in UV.
  const { mesh, boundary, junction } = JSON.parse(
    readFileSync(new URL('./fixtures/surface-stitch-corner-fill.json', import.meta.url), 'utf8'),
  ) as { mesh: Partial<QuadMeshDoc>; boundary: string[]; junction: string };
  const seed = { ...blankMountain('CORNER_FILL'), ...mesh },
    rebuilt = rebuildSurface(seed, seed.surfaces![0]);
  assert(rebuilt.ok, rebuilt.ok ? '' : rebuilt.error);
  const doc = rebuilt.doc,
    before = structuredClone(doc),
    host = meshFromDoc(doc);
  for (const sharedCorner of [boundary[4], junction])
    for (const reverse of [false, true])
      for (const patchSizeM of [15, 25, 40]) {
        const names = boundary.map((id, i) => (i === 4 ? sharedCorner : id)),
          order = reverse ? [names[0], ...names.slice(1).reverse()] : names,
          points = order.map(id => {
            const vertex = doc.vertexIds.indexOf(id);
            return { vertex, pos: doc.vertices.slice(vertex * 3, vertex * 3 + 3) as V3 };
          }),
          made = createSurfaceFromDrawnBoundary(doc, points, patchSizeM, undefined, 'smooth');
        assert(made.ok, made.ok ? '' : `${sharedCorner}, reverse=${reverse}, size=${patchSizeM}: ${made.error}`);
        assert.deepEqual(doc, before, 'creating a preview cannot edit its host');
        assert.equal(made.surface.stitches?.length, 2, 'both complete host boundaries attach through either cage');
        const meshSeam = made.surface.stitches!.find(st => 'vertices' in st.target)!;
        assert('vertices' in meshSeam.target);
        assert.equal(meshSeam.target.vertices.length, 4, 'the coincident cage corner retains the final trail edge');
        assert(checkManifold(made.doc.quads).ok);
        const output = meshFromDoc(made.doc),
          generated = new Set(doc.surfaces!.flatMap(s => s.patches.map(p => p.quad)));
        for (let i = 0; i < doc.quads.length; i++) {
          if (generated.has(doc.quadIds[i])) continue;
          const at = made.doc.quadIds.indexOf(doc.quadIds[i]),
            original = quadControlPoints(host.mesh, host.edgeHandle, i, doc.quadTwist?.[i]),
            current = quadControlPoints(output.mesh, output.edgeHandle, at, made.doc.quadTwist?.[at]);
          original.forEach((p, j) => near(p, current[j]));
        }
        const reopened = refreshSurfaces(migrateMountain(serializeMountain(made.doc)));
        assert(!reopened.surfaces!.some(s => s.error));
        assert.deepEqual(reopened.surfaces, made.doc.surfaces);
        assert(checkManifold(reopened.quads).ok);
      }
  console.log(
    '✓ nine-point corner fill keeps both exact seams through coincident cage picks and either drawing direction',
  );
}
function hostChain(doc: QuadMeshDoc, count: number) {
  return Array.from({ length: count + 1 }, (_, i) => doc.vertexIds[count + 1 + i]);
}
{
  const draw = (doc: QuadMeshDoc, positions: V3[]) => {
    const result = createSurfaceFromDrawnBoundary(
      doc,
      positions.map(pos => ({ pos, vertex: null })),
      25,
    );
    assert(result.ok, result.ok ? '' : result.error);
    return result;
  };
  const a = draw(blankMountain('SHARED_CAGE_CORNER'), [
      [0, 0, 0],
      [80, 0, 0],
      [80, 0, 80],
      [0, 0, 80],
    ]),
    b = draw(a.doc, [
      [0, 0, 80],
      [80, 0, 80],
      [80, 0, 160],
      [0, 0, 160],
    ]),
    before = structuredClone(b.doc),
    c = draw(b.doc, [
      [80, 0, 0],
      [160, 0, 0],
      [160, 0, 160],
      [80, 0, 160],
      [80, 0, 80],
    ]);
  assert.deepEqual(b.doc, before);
  assert.deepEqual(
    new Set(c.surface.stitches?.map(st => ('surface' in st.target ? st.target.surface : 'mesh'))),
    new Set([a.surface.id, b.surface.id]),
    'a shared corner picked through the first cage also resolves on the second surface boundary',
  );
  assert(checkManifold(c.doc.quads).ok);
  assert.equal(findCoincidentVertices(c.doc).length, 0);
  assert.equal(findEdgeCrossings(c.doc).length, 0);
  const detached = detachSurfaceStitches(c.doc, c.surface.id),
    repaired = stitchTouchingSurfaceBoundaries(detached, c.surface.id),
    reopened = refreshSurfaces(migrateMountain(serializeMountain(repaired)));
  assert.equal(repaired.surfaces!.find(s => s.id === c.surface.id)!.stitches!.length, 2);
  assert(!reopened.surfaces!.some(s => s.error));
  assert.deepEqual(reopened.surfaces, repaired.surfaces);

  const skew = draw(blankMountain('SHEARED_SEAM'), [
      [0, 0, 0],
      [80, 0, 0],
      [180, 0, 80],
      [100, 0, 80],
    ]),
    neighbor = draw(skew.doc, [
      [0, 0, 0],
      [80, 0, 0],
      [180, 0, -80],
      [100, 0, -80],
    ]),
    copy = draw(skew.doc, [
      [0, 0, 0],
      [80, 0, 0],
      [180, 0, 80],
      [100, 0, 80],
    ]);
  assert.equal(neighbor.surface.stitches?.length, 1, 'tangential shear cannot make opposite sides look overlapping');
  assert.equal(copy.surface.stitches?.length ?? 0, 0, 'drawing over the same terrain still remains a copied fill');
  assert(checkManifold(neighbor.doc.quads).ok);
  console.log(
    '✓ shared-cage corners and sheared adjoining sides auto-stitch, explicit repair persists, and copied fills stay separate',
  );
}
{
  const made = surface(plain(2), 40, 100, 0),
    joined = addSurfaceStitch(
      made.doc,
      made.surface.id,
      { side: 'v0', range: [0, 1] },
      { vertices: hostChain(made.doc, 2) },
    ),
    row = joined.surfaces![0].controls[0].map(id => joined.vertexIds.indexOf(id)),
    doc = { ...joined, edgeHandles: { ...joined.edgeHandles } };
  // The editable guide bows a little into its attached trail and crosses a transverse host edge.
  // The evaluated seam is already connected; this construction curve is not another terrain sheet.
  doc.edgeHandles[`${row[0]}>${row[1]}`] = [-0.4, 0, 80 / 3];
  doc.edgeHandles[`${row[1]}>${row[0]}`] = [-0.4, 0, -80 / 3];
  const crossGuide = (x: ReturnType<typeof findEdgeCrossings>[number]) =>
    x.edges.some(e => e.includes(row[0]) && e.includes(row[1])) && x.edges.some(e => e.includes(1) && e.includes(4));
  assert(findEdgeCrossings({ ...doc, surfaces: doc.surfaces!.map(s => ({ ...s, stitches: [] })) }).some(crossGuide));
  assert(!findEdgeCrossings(doc).some(crossGuide), 'attached construction guides do not show false red X markers');
  const start = doc.vertexIds.length,
    unrelated = {
      ...doc,
      ...appendMeshIds(doc, 2, 0),
      vertices: [...doc.vertices, 20, 0, 20, 20, 0, 60],
      freeEdges: [...(doc.freeEdges ?? []), [start, start + 1] as [number, number]],
    };
  assert(
    findEdgeCrossings(unrelated).some(x => x.edges.some(e => e.includes(start) && e.includes(start + 1))),
    'real crossings by unrelated geometry remain visible',
  );
  console.log(
    '✓ diagnostics ignore construction guides against their stitched host patches while retaining unrelated crossings',
  );
}
function seamFaces(doc: QuadMeshDoc, chain: string[]) {
  return chain.slice(1).map((id, i) => {
    const key = undirectedEdgeKey(doc.vertexIds.indexOf(chain[i]), doc.vertexIds.indexOf(id));
    const faces = doc.quads.flatMap((q, j) =>
      quadPerimeterEdges(q).some(([a, b]) => undirectedEdgeKey(a, b) === key) ? [j] : [],
    );
    assert.equal(faces.length, 2, 'each seam edge is shared by exactly two real quads');
    return faces;
  });
}
function edgeNormal(doc: QuadMeshDoc, face: number, a: string, b: string, t: number) {
  const q = doc.quads[face].map(v => doc.vertexIds[v]),
    i = q.indexOf(a),
    j = q.indexOf(b);
  const uv: [number, number][] = [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ];
  const u = uv[i][0] * (1 - t) + uv[j][0] * t,
    v = uv[i][1] * (1 - t) + uv[j][1] * t;
  return patchNormal(controls(doc, doc.quadIds[face]), u, v);
}
function seamAngle(doc: QuadMeshDoc, chain: string[]) {
  return Math.max(
    ...seamFaces(doc, chain).flatMap(([a, b], i) =>
      [0, 0.25, 0.5, 0.75, 1].map(t => {
        const n = edgeNormal(doc, a, chain[i], chain[i + 1], t),
          m = edgeNormal(doc, b, chain[i], chain[i + 1], t);
        return Math.acos(Math.min(1, Math.abs(n.reduce((s, x, j) => s + x * m[j], 0))));
      }),
    ),
  );
}

{
  const host = surface(blankMountain('PARTIAL_RELOAD'), 0, 40, 0, 23, 0, 120),
    child = surface(host.doc, 40, 100, 25, 11, 24, 96),
    before = structuredClone(child.doc);
  let doc = addSurfaceStitch(
    child.doc,
    child.surface.id,
    { side: 'v0', range: [0, 1] },
    { surface: host.surface.id, side: 'v1', range: [0.2, 0.8] },
  );
  assert.deepEqual(child.doc, before, 'a valid smooth join must not mutate its input patch controls');
  assert(doc.surfaces![0].fitted, 'an incoming-only host retains its original fit');
  const layout = doc.surfaces!.map(s => s.patches.map(p => ({ domain: p.domain, uv: p.uv, base: p.base }))),
    fit = doc.surfaces!.map(s => s.fitted),
    counts = doc.surfaces!.map(s => s.patches.length);
  for (let reload = 0; reload < 4; reload++) {
    doc = evaluateSurfaceStitches(migrateMountain(serializeMountain(doc)));
    assert(!doc.surfaces!.some(s => s.error));
    assert.deepEqual(
      doc.surfaces!.map(s => s.patches.length),
      counts,
      'reload cannot add another transition band',
    );
    assert.deepEqual(
      doc.surfaces!.map(s => s.fitted),
      fit,
      'transition handles never feed back into the saved fit',
    );
    assert.deepEqual(
      doc.surfaces!.map(s => s.patches.map(p => ({ domain: p.domain, uv: p.uv, base: p.base }))),
      layout,
      'partial unequal-count joins keep their geometry through repeated reloads',
    );
  }
  console.log(
    '✓ partial unequal-count joins are pure and keep host fits, geometry and patch counts on repeated reloads',
  );
}

{
  const made = surface(plain(4), 40, 120),
    root = hostChain(made.doc, 4),
    doc = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: root }),
    far = made.surface.controls.flat().find(id => {
      const p = doc.vertices.slice(doc.vertexIds.indexOf(id) * 3, doc.vertexIds.indexOf(id) * 3 + 3);
      return p[0] === 120 && p[2] === 80;
    })!;
  assert(
    selectedSurfaceBoundary(doc, [[root.at(-1)!, far]]),
    'a span can mix a shared ordinary corner with a source-guide point',
  );
  const outline = [
    { pos: [0, 0, 80] as V3, vertex: 4 },
    { pos: [40, 0, 80] as V3, vertex: doc.vertexIds.indexOf(root.at(-1)!) },
    { pos: [120, 0, 80] as V3, vertex: doc.vertexIds.indexOf(far) },
    { pos: [120, 0, 160] as V3, vertex: null },
    { pos: [0, 0, 160] as V3, vertex: null },
  ];
  const joined = createSurfaceFromDrawnBoundary(doc, outline, 20);
  assert(joined.ok, joined.ok ? '' : joined.error);
  assert.equal(joined.surface.stitches?.length, 2, 'the same side attaches to ordinary terrain and a Surface');
  assert(joined.surface.stitches!.some(st => 'surface' in st.target && st.target.surface === made.surface.id));
  const meshJoin = joined.surface.stitches!.find(st => 'vertices' in st.target)!;
  assert('vertices' in meshJoin.target);
  seamFaces(joined.doc, meshJoin.target.vertices);
  assert.equal(findCoincidentVertices(joined.doc, 1e-6).length, 0);
  console.log(
    '✓ a drawn boundary switches from plain quads to a Surface at their shared corner and stitches both spans',
  );
}
{
  const doc = migrateMountain(
      JSON.parse(readFileSync(new URL('./fixtures/surface-stitch-mixed-gari.json', import.meta.url), 'utf8')),
    ),
    before = canonicalJson(doc),
    repaired = stitchTouchingSurfaceBoundaries(doc, 'surface:2'),
    follower = repaired.surfaces![1],
    added = follower.stitches!.find(st => 'surface' in st.target)!;
  assert.equal(follower.stitches?.length, 2);
  assert.deepEqual(
    follower.stitches![0],
    doc.surfaces![1].stitches![0],
    'repair preserves the existing plain-quad attachment',
  );
  assert(added && 'surface' in added.target);
  assert.equal(added.target.surface, 'surface:1');
  assert.deepEqual(added.range, [2 / 3, 1]);
  assert(!repaired.surfaces!.some(s => s.error));
  assert(checkManifold(repaired.quads).ok);
  const host = repaired.surfaces![0],
    side = added.target.side,
    stations = new Map<string, number>();
  host.patches.forEach(p =>
    p.corners.forEach((id, i) => {
      const uv = p.uv![i];
      if (Math.abs(uv[side[0] === 'u' ? 0 : 1] - Number(side[1])) < 1e-7) stations.set(id, uv[side[0] === 'u' ? 1 : 0]);
    }),
  );
  const seam = [...stations].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  seamFaces(repaired, seam);
  assert(seamAngle(repaired, seam) < Math.PI / 180, 'the repaired join is smooth along its whole span');
  assert.equal(findCoincidentVertices(repaired, 1e-6).length, 0);
  assert.equal(canonicalJson(doc), before, 'repair does not mutate the source document');
  assert.strictEqual(stitchTouchingSurfaceBoundaries(repaired, 'surface:2'), repaired, 'repeated discovery is a no-op');
  assert.strictEqual(
    stitchTouchingSurfaceBoundaries(repaired, 'surface:1'),
    repaired,
    'incoming connections are already occupied too',
  );
  const saved = refreshSurfaces(migrateMountain(serializeMountain(repaired)));
  assert.deepEqual(saved.surfaces, repaired.surfaces);
  const detached = refreshSurfaces(detachSurfaceStitches(repaired, 'surface:2'));
  assert(!detached.surfaces![1].stitches?.length, 'ordinary refresh leaves an explicitly detached object independent');
  console.log(
    '✓ saved mixed GARI joins repair explicitly, remain manifold and smooth, preserve existing attachments, and survive reload/detach',
  );
}

{
  const a = createSurfaceFromDrawnBoundary(
    blankMountain('SQUARE_NEIGHBORS'),
    [
      [0, 0, 0],
      [80, 0, 0],
      [80, 0, 80],
      [0, 0, 80],
    ].map(pos => ({ pos: pos as V3, vertex: null })),
    20,
  );
  assert(a.ok);
  const b = createSurfaceFromDrawnBoundary(
    a.doc,
    [
      [0, 0, 80],
      [80, 0, 80],
      [80, 0, 160],
      [0, 0, 160],
    ].map(pos => ({ pos: pos as V3, vertex: null })),
    25,
  );
  assert(b.ok, b.ok ? '' : b.error);
  assert.equal(
    b.surface.stitches?.length,
    1,
    'coincident square boundaries auto-stitch even without a captured snap id',
  );
  const st = b.surface.stitches![0];
  assert('surface' in st.target);
  const targetRef = st.target;
  let doc = refreshSurfaces(b.doc);
  const source = () =>
      surfaceSideControls(
        doc,
        doc.surfaces!.find(s => s.id === b.surface.id)!,
        st.side,
      ),
    host = () =>
      surfaceSideControls(
        doc,
        doc.surfaces!.find(s => s.id === a.surface.id)!,
        targetRef.side,
      ),
    position = (vertex: number) => doc.vertices.slice(vertex * 3, vertex * 3 + 3) as V3;
  const check = () => {
    assert(!doc.surfaces!.some(s => s.error), doc.surfaces!.map(s => s.error).join());
    for (const p of source()) {
      const at = targetRef.range[0] + p.at * (targetRef.range[1] - targetRef.range[0]),
        q = host().find(q => Math.abs(q.at - at) < 1e-7)!;
      near(position(p.vertex), position(q.vertex));
    }
    const first = doc.surfaces!.find(s => s.id === a.surface.id)!,
      second = doc.surfaces!.find(s => s.id === b.surface.id)!;
    assert(
      first.patches.some(p => p.corners.filter(id => second.patches.some(q => q.corners.includes(id))).length >= 2),
      'both surfaces share the terrain seam',
    );
  };
  check();
  for (const from of [source, host, () => [...source(), ...host()]]) {
    const before = host().map(p => position(p.vertex)),
      delta: V3 = [2, 3, -1];
    moveMeshVertices(
      doc,
      from().map(p => p.vertex),
      delta,
    );
    doc = refreshSurfaces(doc);
    host().forEach((p, i) => near(position(p.vertex), before[i].map((v, k) => v + delta[k]) as V3));
    check();
  }
  const point = source()[0],
    original = position(point.vertex);
  setMeshControlPoints(doc, [
    {
      id: { kind: 'vertex', vertex: doc.vertexIds[point.vertex] },
      pos: original.map((v, i) => v + [1, 2, 3][i]) as V3,
    },
  ]);
  doc = refreshSurfaces(doc);
  check();
  const saved = refreshSurfaces(migrateMountain(serializeMountain(doc)));
  assert.deepEqual(saved.surfaces, doc.surfaces, 'coupled source controls survive reload');
  doc = detachSurfaceStitches(doc, a.surface.id);
  const before = host().map(p => position(p.vertex));
  moveMeshVertices(
    doc,
    source().map(p => p.vertex),
    [0, 5, 0],
  );
  doc = refreshSurfaces(doc);
  host().forEach((p, i) => near(position(p.vertex), before[i]));
  console.log(
    '✓ adjacent squares auto-stitch; either source edge, combined selections and absolute point edits move both sides once; reload and detach work',
  );
}
{
  const made = surface(plain(4), 40, 120),
    chain = hostChain(made.doc, 4);
  let doc = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
  const points = surfaceSideControls(doc, doc.surfaces![0], 'v0'),
    before = chain.map(id => doc.vertices.slice(doc.vertexIds.indexOf(id) * 3, doc.vertexIds.indexOf(id) * 3 + 3)),
    delta: V3 = [0, 4, 2];
  moveMeshVertices(
    doc,
    points.map(p => p.vertex),
    delta,
  );
  doc = refreshSurfaces(doc);
  chain.forEach((id, i) =>
    near(
      doc.vertices.slice(doc.vertexIds.indexOf(id) * 3, doc.vertexIds.indexOf(id) * 3 + 3) as V3,
      before[i].map((v, k) => v + delta[k]) as V3,
    ),
  );
  seamFaces(doc, chain);
  assert(!doc.surfaces![0].error, doc.surfaces![0].error);
  setQuadsLocked(doc, [0], true);
  const lockedHost = doc.vertexIds.indexOf(chain[0]),
    point = surfaceSideControls(doc, doc.surfaces![0], 'v0').find(p =>
      doc.vertices
        .slice(p.vertex * 3, p.vertex * 3 + 3)
        .every((v, k) => Math.abs(v - doc.vertices[lockedHost * 3 + k]) < 1e-7),
    )!;
  const held = doc.vertices.slice();
  moveMeshVertices(doc, [point.vertex], [0, 3, 0]);
  assert.deepEqual(doc.vertices, held, 'explicit ordinary host locks protect their coupled source controls');
  console.log(
    '✓ a Surface guide carries every ordinary seam vertex across unequal counts, and explicit host locks win',
  );
}

{
  // Read-only extraction of GARI_FRESH Surface 1/2: 10 seam patches against 12.
  // The old whole-strip filler inserted a 26-vertex ellipse and wrapped the rows around it.
  const before = migrateMountain(
    JSON.parse(readFileSync(new URL('./fixtures/surface-stitch-gari.json', import.meta.url), 'utf8')),
  );
  assert(
    before.surfaces![1].outputKeys!.some(k => k.includes('/inner:')),
    'fixture reproduces the circular layout',
  );
  const doc = evaluateSurfaceStitches(before),
    host = doc.surfaces![0],
    follower = doc.surfaces![1],
    transition = follower.patches.filter(p => p.key?.startsWith('stitch:'));
  assert(checkManifold(doc.quads).ok);
  assert(
    !follower.outputKeys!.some(k => k.includes('/inner:')),
    'similar counts keep a strip instead of a circular ring',
  );
  assert.equal(
    follower.outputKeys!.filter(k => /:[xy]$/.test(k)).length,
    2,
    'one local block absorbs the two-patch difference',
  );
  const boundaryCount =
    new Set(host.patches.flatMap(p => p.corners.filter((_, i) => Math.abs(p.uv![i][1] - 1) < 1e-7))).size - 1;
  assert.equal(transition.length, 2 * boundaryCount + 3, 'one local transition strip follows the fitted host edges');
  assert.equal(
    Math.abs(follower.patches.length - follower.fitted!.length),
    1,
    'one local count transition avoids a ring of extra patches',
  );
  for (const p of transition) {
    const { width, length } = cellMetrics(p.base);
    assert(Math.max(width, length) / Math.min(width, length) < 2.3, 'the repaired join retains broad patches');
  }
  assert.deepEqual(
    host.guides,
    before.surfaces![0].guides!.map(({ axis, at, knots }) => ({ axis, at, knots })),
    'legacy repair preserves the visible guide layout and retires hidden references',
  );
  assert(!host.seed && !follower.seed);
  for (const id of host.controls.flat())
    near(
      doc.vertices.slice(doc.vertexIds.indexOf(id) * 3, doc.vertexIds.indexOf(id) * 3 + 3) as V3,
      before.vertices.slice(before.vertexIds.indexOf(id) * 3, before.vertexIds.indexOf(id) * 3 + 3) as V3,
    );
  const seam = [...new Set(host.patches.flatMap(p => p.corners))].filter(id =>
    follower.patches.some(p => p.corners.includes(id)),
  );
  assert.equal(
    seam.length,
    new Set(host.patches.flatMap(p => p.corners.filter((_, i) => Math.abs(p.uv![i][1] - 1) < 1e-7))).size,
    'every fitted host boundary edge is preserved',
  );
  const seamOrder = new Map<string, number>();
  for (const p of host.patches)
    p.corners.forEach((id, i) => {
      if (seam.includes(id) && Math.abs(p.uv![i][1] - 1) < 1e-7) seamOrder.set(id, p.uv![i][0]);
    });
  seam.sort((a, b) => seamOrder.get(a)! - seamOrder.get(b)!);
  // The fitted host itself has small tangent discontinuities between patches.
  assert(
    seamAngle(doc, seam) < Math.PI / 180,
    'the localized join stays smooth within one degree on the fitted terrain',
  );
  assert.deepEqual(
    evaluateSurfaceStitches(doc).surfaces,
    doc.surfaces,
    'repairing a saved ring stabilizes after one evaluation',
  );
  console.log('✓ GARI 10-to-12 join replaces the circular ring with one local transition and broad, smooth patches');
}
for (const count of [2, 3, 4, 5, 6]) {
  const made = surface(plain(count), 40, 120),
    doc = addSurfaceStitch(
      made.doc,
      made.surface.id,
      { side: 'v0', range: [0, 1] },
      { vertices: hostChain(made.doc, count) },
    );
  assert(
    !doc.surfaces![0].outputKeys!.some(k => k.includes('/inner:')),
    `a ${count}-to-4 join should keep the row direction`,
  );
  assert(checkManifold(doc.quads).ok);
  seamFaces(doc, hostChain(made.doc, count));
}
console.log('✓ strip transitions handle either count direction, equal counts and odd-count free rim splits');
for (const count of [5, 8])
  for (const width of [5, 20])
    for (const curved of [false, true]) {
      const host = plain(count);
      for (let i = 0; i < host.vertices.length; i += 3) {
        const z = 80 * (host.vertices[i + 2] / 80) ** 2;
        host.vertices[i + 2] = z;
        if (curved) host.vertices[i + 1] = 4 * Math.sin((Math.PI * z) / 80);
      }
      const made = surface(host, 40, 40 + width, 0, 30),
        before = structuredClone(made.doc),
        chain = hostChain(made.doc, count),
        joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
      assert.deepEqual(made.doc, before, 'smoothing retries never change the input document');
      assert(checkManifold(joined.quads).ok);
      assert(seamAngle(joined, chain) < 1e-5, 'reducing shear keeps the complete smooth tangent plane');
      for (const id of host.quadIds) controls(made.doc, id).forEach((p, i) => near(p, controls(joined, id)[i]));
      for (const patch of joined.surfaces![0].patches) {
        const cp = controls(joined, patch.quad);
        for (let u = 1; u < 20; u++)
          for (let v = 1; v < 20; v++)
            assert(
              patchNormal(cp, u / 20, v / 20)[1] > 0,
              `uneven seam spacing cannot invert the fitted terrain: ${count}/${width}/${curved}/${patch.key}/${u}/${v}`,
            );
      }
      const reopened = refreshSurfaces(migrateMountain(serializeMountain(joined)));
      assert(!reopened.surfaces!.some(s => s.error));
      assert.deepEqual(reopened.surfaces, joined.surfaces, 'automatic shear reduction survives save/reload');
    }
console.log('✓ narrow smooth joins adapt to uneven straight/curved host spacing without folds or host changes');
{
  const made = surface(plain(), 44, 120),
    doc = addSurfaceStitch(
      made.doc,
      made.surface.id,
      { side: 'v0', range: [0, 1] },
      { vertices: hostChain(made.doc, 4) },
    );
  for (const id of made.doc.quadIds.slice(0, 4))
    controls(made.doc, id).forEach((cp, i) => near(cp, controls(doc, id)[i]));
  console.log('✓ snapping an offset follower endpoint preserves the host boundary cubics');
}

{
  const made = surface(plain()),
    before = structuredClone(made.doc),
    chain = hostChain(made.doc, 4);
  const exact = made.doc.quadIds.slice(0, 4).map(id => controls(made.doc, id));
  let doc = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain }, 'smooth');
  assert.deepEqual(made.doc, before, 'stitch evaluation is pure');
  assert(checkManifold(doc.quads).ok);
  seamFaces(doc, chain);
  exact.forEach((cp, i) => cp.forEach((p, j) => near(p, controls(doc, made.doc.quadIds[i])[j])));
  assert.strictEqual(refreshSurfaces(doc), doc, 'unchanged renders do not regenerate topology');
  const selected = selectedSurfaceBoundary(doc, [[made.surface.controls[0][0], made.surface.controls[0][1]]]);
  assert.equal(selected?.surface, made.surface.id);
  assert.equal(selected?.side, 'v0');
  const saved = migrateMountain(serializeMountain(doc));
  assert.deepEqual(saved.surfaces?.[0].stitches, doc.surfaces?.[0].stitches);
  const afterLoad = refreshSurfaces(saved);
  assert.deepEqual(afterLoad.surfaces, doc.surfaces, 'reevaluation after loading is byte-stable');
  applyRegisters(saved, documentRegisters(doc));
  assert.deepEqual(saved.surfaces?.[0].stitches, doc.surfaces?.[0].stitches);
  const moved = {
    ...doc,
    vertices: doc.vertices.map((v, i) => (i % 3 === 1 && chain.includes(doc.vertexIds[Math.floor(i / 3)]) ? v + 5 : v)),
  };
  doc = refreshSurfaces(moved);
  assert(!doc.surfaces?.[0].error, doc.surfaces?.[0].error);
  seamFaces(doc, chain);
  const oldIds = doc.vertexIds,
    oldQuads = doc.quadIds;
  const movedAgain = {
    ...doc,
    vertices: doc.vertices.map((v, i) => (i % 3 === 1 && chain.includes(doc.vertexIds[Math.floor(i / 3)]) ? v + 2 : v)),
  };
  doc = refreshSurfaces(movedAgain);
  assert.deepEqual(doc.vertexIds, oldIds);
  assert.deepEqual(doc.quadIds, oldQuads);
  const detached = detachSurfaceStitches(doc, made.surface.id);
  assert(!detached.surfaces?.[0].stitches?.length);
  assert(checkManifold(detached.quads).ok);
  console.log('✓ live mesh seam, host preservation, stable drag identities, save/register roundtrip and detach');
}
{
  const made = surface(plain(2), 40, 120),
    chain = hostChain(made.doc, 2);
  let doc = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
  assert(checkManifold(doc.quads).ok);
  seamFaces(doc, chain);
  assert(
    doc.quads.every(q => new Set(q).size === 4),
    'density transitions use real quads',
  );
  assert(
    doc.surfaces![0].patches.some(p => p.key?.startsWith('stitch:')),
    'local transition patches are installed',
  );
  const next = rebuildSurface(doc, { ...doc.surfaces![0], patchSizeM: 16 });
  assert(next.ok, next.ok ? '' : next.error);
  doc = next.doc;
  seamFaces(doc, chain);
  assert(doc.quads.every(q => new Set(q).size === 4));
  console.log('✓ unequal counts produce local conforming quads and survive refitting');
}
{
  const a = surface(blankMountain('TWO'), 0, 40),
    b = surface(a.doc, 40, 100, 25, 10);
  let doc = addSurfaceStitch(
    b.doc,
    b.surface.id,
    { side: 'v0', range: [0, 1] },
    { surface: a.surface.id, side: 'v1', range: [0, 1] },
  );
  assert(checkManifold(doc.quads).ok);
  const seam = doc.surfaces!.find(s => s.id === b.surface.id)!;
  assert(
    seam.patches.some(p => p.corners.some(id => doc.surfaces![0].vertices.includes(id))),
    'surfaces share generated vertex identities',
  );
  doc = setSurfaceStitchContinuity(doc, b.surface.id, 'crease');
  assert.equal(doc.surfaces!.find(s => s.id === b.surface.id)!.stitches![0].continuity, 'crease');
  doc = refreshSurfaces({
    ...doc,
    surfaces: doc.surfaces!.map(s => (s.id === a.surface.id ? { ...s, patchSizeM: 16 } : s)),
  });
  assert(
    !doc.surfaces!.some(s => s.error),
    'a host density change refreshes dependents without using stale output topology',
  );
  const host = doc.surfaces!.find(s => s.id === a.surface.id)!;
  const changed = { ...doc, vertices: [...doc.vertices] };
  const at = doc.vertexIds.indexOf(host.controls[1][0]);
  changed.vertices[at * 3 + 1] += 8;
  doc = refreshSurfaces(changed);
  assert(!doc.surfaces!.some(s => s.error), doc.surfaces!.map(s => s.error).join());
  assert.throws(
    () =>
      addSurfaceStitch(
        doc,
        a.surface.id,
        { side: 'v1', range: [0, 1] },
        { surface: b.surface.id, side: 'v0', range: [0, 1] },
      ),
    /loop/,
  );
  doc = detachSurfaceStitches(doc, a.surface.id);
  assert(doc.surfaces!.every(s => !s.stitches?.length));
  console.log('✓ live surface dependency, continuity switching, refit, cycle rejection and detach from either side');
}
{
  const made = surface(plain(4), 40, 120, 30),
    chain = hostChain(made.doc, 4);
  const smooth = addSurfaceStitch(
    made.doc,
    made.surface.id,
    { side: 'v0', range: [0, 1] },
    { vertices: chain },
    'smooth',
  );
  assert(seamAngle(smooth, chain) < 1e-5, `smooth seam tangent mismatch ${seamAngle(smooth, chain)}`);
  const creased = setSurfaceStitchContinuity(smooth, made.surface.id, 'crease');
  assert(seamAngle(creased, chain) > 0.1, 'crease keeps the different source slope');
  console.log('✓ smooth aligns full boundary tangents; crease preserves the attached slope');
}
{
  const made = surface(plain(1), 44, 120, 15),
    chain = hostChain(made.doc, 1);
  const joined = addSurfaceStitch(
    made.doc,
    made.surface.id,
    { side: 'v0', range: [0, 1] },
    { vertices: chain },
    'crease',
  );
  const reloaded = refreshSurfaces(migrateMountain(serializeMountain(joined)));
  assert.deepEqual(reloaded.surfaces, joined.surfaces, 'curved transition evaluation is stable after reload');
  const canonical = JSON.parse(canonicalJson(serializeMountain(joined)));
  const migrated = migrateMountain(canonical),
    previous = JSON.stringify(migrated.surfaces);
  assert.equal(
    JSON.stringify(refreshSurfaces(migrated).surfaces),
    previous,
    'canonical register metadata keeps its JSON order across evaluation',
  );
  const beforeHandles = JSON.stringify(migrated.edgeHandles);
  assert.equal(
    JSON.stringify(refreshSurfaces(migrated).edgeHandles),
    beforeHandles,
    'evaluation preserves handle key order used by undo snapshots',
  );
}
{
  const made = surface(plain(3), 40, 120),
    chain = hostChain(made.doc, 3);
  const joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
  seamFaces(joined, chain);
  assert(joined.quads.every(q => new Set(q).size === 4));
  assert(checkManifold(joined.quads).ok);
  const normals = joined.surfaces![0].patches.flatMap(p =>
    [0.1, 0.5, 0.9].flatMap(u => [0.1, 0.5, 0.9].map(v => patchNormal(controls(joined, p.quad), u, v)[1])),
  );
  assert(
    normals.every(n => n > 0.999),
    `flat transition normals: ${Math.min(...normals)}`,
  );
  console.log('✓ odd count differences resolve through a free rim split without wedges or inversions');
}
{
  const doc = plain(1),
    boundary = [
      { vertex: 2, pos: [40, 0, 0] as V3 },
      { vertex: 3, pos: [40, 0, 80] as V3 },
      { vertex: null, pos: [120, 0, 80] as V3 },
      { vertex: null, pos: [120, 0, 0] as V3 },
    ];
  const made = createSurfaceFromDrawnBoundary(doc, boundary, 20);
  assert(made.ok, made.ok ? '' : made.error);
  assert.equal(made.surface.stitches?.length, 1, 'snapped boundary auto-attaches');
  seamFaces(made.doc, hostChain(doc, 1));
  console.log('✓ snapped creation establishes a persistent automatic stitch');
  assert.equal(
    findCoincidentVertices(made.doc, 1e-6).length,
    0,
    'shared terrain and independent source controls are intentional contacts',
  );
}
{
  const made = surface(plain(), 40, 120),
    chain = hostChain(made.doc, 4).slice(1, 4);
  const joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0.25, 0.75] }, { vertices: chain });
  seamFaces(joined, chain);
  assert(checkManifold(joined.quads).ok);
  console.log('✓ partial boundary attachment keeps the rest of the rim free');
}
{
  const a = surface(blankMountain('BAKE'), 0, 40),
    b = surface(a.doc, 40, 100, 10, 10);
  const joined = addSurfaceStitch(
    b.doc,
    b.surface.id,
    { side: 'v0', range: [0, 1] },
    { surface: a.surface.id, side: 'v1', range: [0, 1] },
  );
  for (const baked of [a.surface.id, b.surface.id]) {
    const doc = refreshSurfaces(bakeSurface(joined, baked));
    assert.equal(doc.surfaces!.length, 1);
    assert(!doc.surfaces![0].error, doc.surfaces![0].error);
    assert(doc.surfaces![0].stitches?.every(st => 'vertices' in st.target));
    assert(checkManifold(doc.quads).ok);
    const refit = rebuildSurface(doc, { ...doc.surfaces![0], patchSizeM: 16 });
    assert(refit.ok, refit.ok ? '' : refit.error);
  }
  const removed = deleteSurfaceObject(joined, a.surface.id);
  assert(removed.ok, removed.ok ? '' : removed.error);
  assert.equal(removed.doc.surfaces!.length, 1);
  assert(!removed.doc.surfaces![0].stitches?.length);
  assert(
    a.surface.inputs.every(id => !removed.doc.vertexIds.includes(id)),
    'deleting a stitched surface removes its unused source sketches',
  );
  console.log('✓ baking either side converts the live seam to plain geometry; deletion releases dependents');
}
{
  const a = surface(plain(), 40, 100),
    b = surface(a.doc, 40, 100, 0, 20, 80, 140);
  const first = addSurfaceStitch(b.doc, a.surface.id, { side: 'v0', range: [0, 1] }, { vertices: hostChain(b.doc, 4) });
  const side = (s: typeof a.surface) => {
    const cp = guideCharts(first, s);
    return Math.abs(chartPoint(cp, 0, 0.5)[2] - 80) < 1e-6 ? 'u0' : 'u1';
  };
  const both = addSurfaceStitch(
    first,
    a.surface.id,
    { side: side(a.surface), range: [0, 1] },
    { surface: b.surface.id, side: side(b.surface), range: [0, 1] },
  );
  assert(checkManifold(both.quads).ok);
  seamFaces(both, hostChain(both, 4));
  const corner = new Set(
    both.quads
      .flat()
      .filter(v => Math.abs(both.vertices[v * 3] - 40) < 1e-6 && Math.abs(both.vertices[v * 3 + 2] - 80) < 1e-6),
  );
  assert.equal(corner.size, 1, 'the three-way corner has one shared topology vertex');
  assert.equal(both.surfaces![0].stitches?.length, 2);
  console.log('✓ a surface can stitch two adjacent sides at a shared corner');
}
{
  const host = plain(4);
  host.vertices = host.vertices.map((v, i) => (i % 3 === 1 ? 5 * Math.sin((Math.PI * host.vertices[i + 1]) / 80) : v));
  const made = surface(host, 40, 120, 25, 10),
    chain = hostChain(made.doc, 4);
  const joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
  assert(seamAngle(joined, chain) < 1e-4, `curved host smooth join angle: ${seamAngle(joined, chain)}`);
  console.log('✓ curved host tangent planes match through unequal-count transitions');
}
{
  const made = surface(plain(), 40, 120),
    before = structuredClone(made.doc);
  assert.throws(
    () =>
      addSurfaceStitch(made.doc, made.surface.id, { side: 'v1', range: [0, 1] }, { vertices: hostChain(made.doc, 4) }),
    /fold|room/,
  );
  assert.deepEqual(made.doc, before, 'an invalid stitch cannot partially alter the source or host');
  const broken = structuredClone(made.doc);
  broken.surfaces![0].stitches = [
    { id: 'bad', side: 'v0', range: [0, 1], target: { vertices: ['missing', 'also-missing'] }, continuity: 'smooth' },
  ];
  const refreshed = refreshSurfaces(broken);
  assert(refreshed.surfaces![0].error);
  assert.deepEqual(refreshed.quads, broken.quads, 'missing targets keep the last evaluated geometry');
  console.log('✓ folded joins and missing targets preserve existing geometry');
}
{
  const made = surface(plain(2), 40, 120),
    chain = hostChain(made.doc, 2);
  const sourceQuads = new Set(made.surface.patches.map(p => p.quad));
  made.doc.quadPaint = Object.fromEntries(made.doc.quadIds.flatMap((id, i) => (sourceQuads.has(id) ? [[i, 7]] : [])));
  const joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
  assert(
    joined.surfaces![0].patches.every(p => joined.quadPaint?.[joined.quadIds.indexOf(p.quad)] === 7),
    'transition patches inherit surface paint',
  );
  const detached = detachSurfaceStitches(joined, made.surface.id);
  const resized = rebuildSurface(detached, { ...detached.surfaces![0], patchSizeM: 12 });
  assert(resized.ok, resized.ok ? '' : resized.error);
  assert(!resized.surface.outputKeys);
  const reloaded = refreshSurfaces(migrateMountain(serializeMountain(resized.doc)));
  assert.equal(reloaded.surfaces?.length, 1, 'detached surfaces remain live after density changes and reload');
  assert(!reloaded.surfaces![0].error);
  console.log('✓ transition paint and detached density edits survive saving');
}
{
  const made = surface(plain(), 40, 120),
    chain = hostChain(made.doc, 4);
  let joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain });
  const host = joined.vertexIds.indexOf(chain[2]);
  assert(!lockedVertexSet(joined).has(host), 'a follower cannot lock its ordinary master vertex');
  assert(
    !lockedEdgeSet(joined).has(undirectedEdgeKey(host, joined.vertexIds.indexOf(chain[1]))),
    'the master edge handles remain editable',
  );
  const old = joined.surfaces![0].patches.map(p => p.base);
  const moved = moveMeshVertices(joined, [host], [0, 5, 0]);
  assert(moved.vertices.includes(host));
  joined = refreshSurfaces(joined);
  assert(!joined.surfaces![0].error, joined.surfaces![0].error);
  seamFaces(joined, chain);
  assert.notDeepEqual(
    joined.surfaces![0].patches.map(p => p.base),
    old,
    'in-place host edits reevaluate the live surface',
  );
  setQuadsLocked(joined, [0, 1, 2, 3], true);
  assert(lockedVertexSet(joined).has(host), 'an explicit host lock still holds the seam');
  console.log('✓ plain master points/handles remain editable, live in-place edits propagate, and explicit locks win');
}
{
  const made = surface(plain(4)),
    chain = hostChain(made.doc, 4),
    joined = addSurfaceStitch(made.doc, made.surface.id, { side: 'v0', range: [0, 1] }, { vertices: chain }),
    loose = surface(joined, 200, 260),
    other = surface(loose.doc, 300, 360);
  let doc = refreshSurfaces(other.doc);
  const host = doc.surfaces![0],
    unrelated = doc.surfaces![2],
    topology = doc.quads,
    names = doc.vertexIds,
    hostShape = host.patches.map(p => controls(doc, p.quad)),
    loosePoint = loose.surface.controls[1][1];
  for (let frame = 0; frame < 3; frame++) {
    moveMeshVertices(doc, [doc.vertexIds.indexOf(loosePoint)], [0, 0.2, 0]);
    doc = refreshSurfaces(doc, { interactive: true });
    assert.equal(doc.surfaces![0], host, 'a disconnected drag retains stitched surface identity');
    assert.equal(doc.surfaces![2], unrelated, 'a disconnected drag retains other surface identity');
    assert.equal(doc.quads, topology, 'dragging preserves the retained viewport topology');
    assert.equal(doc.vertexIds, names, 'dragging preserves vertex indexing');
    assert.deepEqual(
      host.patches.map(p => controls(doc, p.quad)),
      hostShape,
    );
    assert(!doc.surfaces!.some(s => s.error));
  }
  // A cache hit for the unrelated surface must not hide an in-place ordinary host edit.
  const master = doc.vertexIds.indexOf(chain[2]);
  moveMeshVertices(doc, [master], [0, 3, 0]);
  moveMeshVertices(doc, [doc.vertexIds.indexOf(loosePoint)], [0, 0.2, 0]);
  doc = refreshSurfaces(doc, { interactive: true });
  assert.notDeepEqual(
    doc.surfaces![0].patches.map(p => p.base),
    host.patches.map(p => p.base),
  );
  assert.equal(doc.surfaces![2], unrelated, 'host motion does not dirty an unrelated surface');
  seamFaces(doc, chain);
  assert(!doc.surfaces!.some(s => s.error));
  console.log(
    '✓ disconnected drags retain unrelated surfaces and topology, while in-place host edits invalidate stitching',
  );
}
