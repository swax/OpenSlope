// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { canonicalJson } from '../src/core/doc/canonical';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { applyTopologyDelta, topologyDelta } from '../src/core/doc/topology-delta';
import { createLoftSurface } from '../src/core/mesh/loft-surface';
import { surfaceFitTolerance } from '../src/core/mesh/surface-fit';
import { findCoincidentVertices } from '../src/core/mesh/coincident-vertices';
import { findEdgeCrossings } from '../src/core/mesh/edge-crossings';
import {
  createSurfaceFromProfiles,
  createSurfaceFromBoundary,
  surfaceNet,
  rebuildSurface,
  refreshSurfaces,
  insertSurfaceRow,
  placeSurfaceGuide,
  placeSurfacePoint,
  removeSurfacePoint,
  deleteSurfaceRow,
  bakeSurface,
  deleteSurfaceObject,
  surfaceBoundaryLoop,
} from '../src/core/mesh/surface-object';
import {
  splinePoint,
  splineCharts,
  insertSplineRow,
  removeSplineKnot,
  compactSurfaceCharts,
} from '../src/core/math/spline-surface';
import {
  guideRows,
  readGuideCurves,
  curveAt,
  chartPoint,
  guideCharts,
  surfaceGuideEdgeEvaluator,
} from '../src/core/mesh/surface-guides';
import { patchPoint, patchNormal } from '../src/core/math/bezier';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { moveMeshVertices } from '../src/core/mesh/control-points';
import { setQuadsLocked } from '../src/core/mesh/locks';
import { createNetWatcher } from '../src/core/mesh/incremental';
import type { QuadMeshDoc, SurfaceObject, V3 } from '../src/core/doc/types';

function fixture() {
  const doc = blankMountain('SURFACE_TEST');
  const profiles: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const row: number[] = [];
    for (let s = 0; s < 3; s++) {
      row.push(doc.vertices.length / 3);
      doc.vertices.push(r * 30, r === 1 && s === 1 ? 12 : 0, s * 20);
    }
    profiles.push(row);
  }
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = profiles.flatMap(row => row.slice(1).map((b, i) => [row[i], b] as [number, number]));
  return { doc: migrateMountain(serializeMountain(doc)), profiles };
}
function create() {
  const { doc, profiles } = fixture(),
    before = structuredClone(doc);
  const result = createSurfaceFromProfiles(doc, profiles, { patchSizeM: 15 });
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(doc, before, 'creation is pure');
  return result;
}
function curvesLieOnSurface(doc: QuadMeshDoc, surface: SurfaceObject) {
  const charts = guideCharts(doc, surface);
  for (const [g, curve] of readGuideCurves(doc, surface).entries())
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const segment = Math.max(
        0,
        Math.min(curve.points.length - 1, curve.knots.findIndex((hi, j) => j > 0 && hi >= t - 1e-8) - 1),
      );
      const names = surface.controls[g];
      const evaluate = surfaceGuideEdgeEvaluator(
        doc,
        doc.vertexIds.indexOf(names[segment]),
        doc.vertexIds.indexOf(names[segment + 1]),
      );
      near(
        evaluate
          ? evaluate((t - curve.knots[segment]) / (curve.knots[segment + 1] - curve.knots[segment]))
          : curveAt(curve, t),
        curve.axis === 'U' ? chartPoint(charts, t, curve.at) : chartPoint(charts, curve.at, t),
      );
    }
}
const near = (a: V3, b: V3, eps = 1e-7) => assert(Math.hypot(...a.map((x, i) => x - b[i])) < eps, `${a} != ${b}`);
const samples = (doc: QuadMeshDoc, surface: SurfaceObject) => {
  const net = surfaceNet(doc, surface),
    u = net.knotsU.at(-1)!,
    v = net.knotsV.at(-1)!;
  return Array.from({ length: 81 }, (_, i) =>
    splinePoint(net, u * (0.02 + (i % 9) * 0.12), v * (0.03 + Math.floor(i / 9) * 0.12)),
  );
};
const terrainState = (doc: QuadMeshDoc, surface: SurfaceObject) => {
  const { mesh, edgeHandle } = meshFromDoc(doc);
  return {
    vertices: surface.vertices.map(id => [
      id,
      ...doc.vertices.slice(doc.vertexIds.indexOf(id) * 3, doc.vertexIds.indexOf(id) * 3 + 3),
    ]),
    patches: surface.patches.map(p => ({
      id: p.quad,
      corners: p.corners,
      domain: p.domain,
      controls: quadControlPoints(
        mesh,
        edgeHandle,
        doc.quadIds.indexOf(p.quad),
        doc.quadTwist?.[doc.quadIds.indexOf(p.quad)],
      ),
    })),
  };
};

{
  const start = create(),
    added = placeSurfaceGuide(start.doc, start.surface, 'V', 0.37);
  assert(added.ok);
  const removed = deleteSurfaceRow(added.doc, added.surface, 'V', 0);
  assert(removed.ok);
  const counts = removed.surface.controls.map(row => row.length),
    restored = placeSurfaceGuide(removed.doc, removed.surface, 'V', 0.37000002);
  assert(restored.ok);
  assert.equal(restored.surface.guides!.at(-1)!.at, 0.37, 'float32 pick jitter snaps to the existing crossing station');
  assert.deepEqual(
    restored.surface.controls.slice(0, -1).map(row => row.length),
    counts,
    'no microscopic source span is created',
  );
  assert(
    !placeSurfacePoint(restored.doc, restored.surface, 0, 0.37000002).ok,
    'near-duplicate control points are refused',
  );
  moveMeshVertices(
    restored.doc,
    restored.surface.controls.at(-1)!.map(id => restored.doc.vertexIds.indexOf(id)),
    [4, 0, 0],
  );
  const shaped = refreshSurfaces(restored.doc);
  assert(!shaped.surfaces![0].error);
  const baked = bakeSurface(shaped, restored.surface.id);
  assert.equal(findEdgeCrossings(baked).length, 0, 'moving a snapped cross-guide does not fold tiny spans');
}
{
  const { doc, surface } = create();
  // Another surface owns the original sketches, so baking this one must preserve them and their edges.
  const second = createSurfaceFromProfiles(
    doc,
    [
      [0, 1, 2],
      [3, 4, 5],
      [6, 7, 8],
    ],
    { patchSizeM: 20 },
  );
  assert(second.ok);
  const baked = bakeSurface(second.doc, surface.id);
  assert.equal(baked.surfaces!.length, 1);
  assert.deepEqual(terrainState(baked, second.surface), terrainState(second.doc, second.surface));
  assert(
    surface.inputs.every(id => baked.vertexIds.includes(id)),
    'shared sketches survive bake',
  );
  assert.equal(refreshSurfaces(baked), baked);
  const attached = create(),
    extra = attached.doc.vertexIds.length;
  Object.assign(attached.doc, appendMeshIds(attached.doc, 1, 0));
  attached.doc.vertices.push(-10, 0, -10);
  attached.doc.freeEdges!.push([attached.doc.vertexIds.indexOf(attached.surface.controls[0][0]), extra]);
  const kept = bakeSurface(attached.doc, attached.surface.id);
  assert(
    attached.surface.controls[0].every(id => kept.vertexIds.includes(id)),
    'externally attached guide components survive bake',
  );
  assert(kept.vertexIds.includes(attached.doc.vertexIds[extra]));
}
{
  const { doc, surface } = create(),
    watcher = createNetWatcher();
  watcher.note(doc);
  const domains = surface.patches.map(p => p.domain);
  const source = doc.vertexIds.indexOf(surface.controls[1][1]);
  moveMeshVertices(doc, [source], [0, 0.1, 0]);
  const preview = refreshSurfaces(doc, { interactive: true });
  assert.equal(preview.quads, doc.quads, 'a drag retains connectivity');
  assert.equal(preview.vertexIds, doc.vertexIds, 'a drag retains generated names');
  assert.notDeepEqual(
    preview.surfaces![0].patches.map(p => p.domain),
    domains,
    'a drag redistributes physical spacing while retaining connectivity',
  );
  assert.equal(refreshSurfaces(preview, { interactive: true }), preview, 'an unchanged drag frame is free');
  curvesLieOnSurface(preview, preview.surfaces![0]);
  const settled = refreshSurfaces(preview);
  assert.notEqual(settled, preview, 'release performs the pending redistribution');
  assert.equal(settled.quads, doc.quads, 'changed parameters retain the same grid connectivity');
  assert.deepEqual(settled.quadIds, doc.quadIds);
  assert.notDeepEqual(
    settled.surfaces![0].patches.map(p => p.domain),
    domains,
  );
  assert.equal(watcher.note(settled).kind, 'patches', 'source edits use incremental terrain updates');
  assert.equal(refreshSurfaces(settled), settled);
  // Compact only redundant polynomial seams, preserving every point, including creases and twists.
  const added = placeSurfaceGuide(settled, settled.surfaces![0], 'V', 0.37);
  assert(added.ok, added.ok ? '' : added.error);
  const charts = guideCharts(added.doc, added.surface),
    compact = compactSurfaceCharts(charts);
  assert(compact.length < charts.length, 'new guide stations do not force terrain seams');
  for (let i = 0; i <= 20; i++)
    for (let j = 0; j <= 20; j++) near(chartPoint(compact, i / 20, j / 20), chartPoint(charts, i / 20, j / 20));
}

{
  const start = create(),
    original = terrainState(start.doc, start.surface),
    points = samples(start.doc, start.surface);
  const added = placeSurfaceGuide(start.doc, start.surface, 'V', 0.37);
  assert(added.ok, added.ok ? '' : added.error);
  assert.deepEqual(
    terrainState(added.doc, added.surface),
    original,
    'adding at an arbitrary station leaves generated topology and all sixteen controls untouched',
  );
  assert.equal(refreshSurfaces(added.doc), added.doc);
  const replace = guideRows(added.surface, 'U')[1],
    moved = placeSurfaceGuide(added.doc, added.surface, 'U', 0.73, replace);
  assert(moved.ok, moved.ok ? '' : moved.error);
  assert.deepEqual(
    terrainState(moved.doc, moved.surface),
    original,
    'repositioning preserves the actual generated mesh',
  );
  assert.equal(moved.surface.guides!.length, 4);
  curvesLieOnSurface(moved.doc, moved.surface);
  samples(moved.doc, moved.surface).forEach((p, i) => near(p, points[i]));
  assert.equal(refreshSurfaces(moved.doc), moved.doc);
  const saved = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(moved.doc))));
  assert.equal(
    canonicalJson(saved),
    canonicalJson(moved.doc),
    'placing and splitting guides stores the canonical topology the server will reload',
  );
  assert.deepEqual(saved.surfaces, moved.doc.surfaces);
  assert.equal(refreshSurfaces(saved), saved);
  const transport = structuredClone(saved),
    a = transport.vertexIds.indexOf(transport.surfaces![0].controls[0][0]),
    b = transport.vertexIds.indexOf(transport.surfaces![0].controls[0][1]);
  transport.edgeHandles![`${a}>${b}`][0] += 1e-12;
  assert.equal(
    refreshSurfaces(transport),
    transport,
    'transport roundoff cannot trigger retessellation after placement',
  );
  const before = structuredClone(moved.doc);
  assert(!placeSurfaceGuide(moved.doc, moved.surface, 'U', 1, 3).ok, 'occupied stations are rejected');
  assert(!placeSurfaceGuide(moved.doc, moved.surface, 'V', -0.1).ok);
  assert.deepEqual(moved.doc, before, 'refused placements are pure');
  const source = moved.doc.vertexIds.indexOf(moved.surface.controls.at(-1)![1]);
  moveMeshVertices(moved.doc, [source], [0, 9, 0]);
  const shaped = refreshSurfaces(moved.doc);
  assert(!shaped.surfaces![0].error);
  assert.notDeepEqual(
    samples(shaped, shaped.surfaces![0]),
    points,
    'editing a repositioned guide still shapes the surface',
  );
  curvesLieOnSurface(shaped, shaped.surfaces![0]);
}

{
  const { doc, surface } = create();
  assert.equal(surface.guides!.length, 3, 'three profiles remain exactly three active curves');
  assert.equal(surface.controls.flat().length, 9, 'no control lattice is exposed');
  assert(surface.patches.length > 4);
  const net = surfaceNet(doc, surface),
    charts = splineCharts(net);
  const evaluated = meshFromDoc(doc);
  for (const chart of charts) {
    near(
      patchPoint(chart.controls, 0.31, 0.67),
      splinePoint(
        net,
        chart.domain[0] + (chart.domain[1] - chart.domain[0]) * 0.31,
        chart.domain[2] + (chart.domain[3] - chart.domain[2]) * 0.67,
      ),
    );
    assert(patchNormal(chart.controls, 0.5, 0.5)[1] > 0);
  }
  for (const p of surface.patches) {
    const q = doc.quadIds.indexOf(p.quad);
    near(
      patchPoint(quadControlPoints(evaluated.mesh, evaluated.edgeHandle, q, doc.quadTwist?.[q]), 0.31, 0.67),
      splinePoint(
        net,
        p.domain[0] + (p.domain[1] - p.domain[0]) * 0.31,
        p.domain[2] + (p.domain[3] - p.domain[2]) * 0.67,
      ),
      surfaceFitTolerance(surface.patchSizeM) + 1e-7,
    );
  }
  const output = doc.vertexIds.indexOf(surface.vertices[0]),
    before = [...doc.vertices];
  moveMeshVertices(doc, [output], [0, 30, 0]);
  assert.deepEqual(doc.vertices, before, 'generated terrain is not editable');
  const cell = doc.quadIds.indexOf(surface.patches[0].quad);
  assert.equal(setQuadsLocked(doc, [cell], false), 0, 'derived protection cannot be unlocked');
  const source = doc.vertexIds.indexOf(surface.controls[2][2]);
  moveMeshVertices(doc, [source], [0, 9, 0]);
  const refreshed = refreshSurfaces(doc);
  assert.notEqual(refreshed, doc);
  assert(!refreshed.surfaces![0].error);
  assert.equal(refreshSurfaces(refreshed), refreshed);
  assert.notDeepEqual(samples(refreshed, refreshed.surfaces![0]), samples({ ...doc, vertices: before }, surface));
  curvesLieOnSurface(refreshed, refreshed.surfaces![0]);
  const a = refreshed.vertexIds.indexOf(surface.controls[0][0]),
    b = refreshed.vertexIds.indexOf(surface.controls[0][1]);
  refreshed.edgeHandles![`${a}>${b}`][1] += 7;
  const tangentEdit = refreshSurfaces(refreshed);
  assert.notEqual(tangentEdit, refreshed, 'tangent handle edits rebuild the surface');
  curvesLieOnSurface(tangentEdit, tangentEdit.surfaces![0]);
}
{
  let result = create();
  const original = samples(result.doc, result.surface);
  for (const axis of ['U', 'V'] as const) {
    const count = guideRows(result.surface, axis).length;
    const next = insertSurfaceRow(result.doc, result.surface, axis, 1);
    assert(next.ok, next.ok ? '' : next.error);
    assert.equal(guideRows(next.surface, axis).length, count + 1);
    samples(next.doc, next.surface).forEach((p, i) => near(p, original[i]));
    result = next;
  }
  const finer = rebuildSurface(result.doc, { ...result.surface, patchSizeM: 5 });
  assert(finer.ok);
  samples(finer.doc, finer.surface).forEach((p, i) => near(p, original[i]));
  assert.deepEqual(finer.surface.controls, result.surface.controls, 'output density does not add source controls');
  curvesLieOnSurface(finer.doc, finer.surface);
  const V = guideRows(finer.surface, 'V')[0],
    names = finer.surface.controls[V];
  for (const u of guideRows(finer.surface, 'U'))
    assert(
      names.some(id => finer.surface.controls[u].includes(id)),
      'crossings share a source vertex',
    );
  const smaller = deleteSurfaceRow(finer.doc, finer.surface, 'U', 2);
  assert(smaller.ok);
  samples(smaller.doc, smaller.surface).forEach((p, i) => near(p, original[i], (smaller.deviationM ?? 0) + 1e-6));
  assert(deleteSurfaceRow(smaller.doc, smaller.surface, 'V', 0).ok);
  const saved = serializeMountain(finer.doc),
    loaded = migrateMountain(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded.surfaces, finer.doc.surfaces);
  assert.equal(refreshSurfaces(loaded), loaded);
  assert(documentRegisters(loaded).has(objectRegister('surface', finer.surface.id)));
  const baked = bakeSurface(loaded, finer.surface.id);
  assert(!baked.surfaces);
  assert.deepEqual(
    terrainState(baked, finer.surface),
    terrainState(loaded, finer.surface),
    'bake preserves all output ids and sixteen controls',
  );
  assert.equal(
    baked.vertexIds.length,
    finer.surface.vertices.length,
    'bake discards unused guides and original sketches',
  );
  assert.equal(baked.freeEdges?.length ?? 0, 0);
  assert.equal(findCoincidentVertices(baked).length, 0);
  assert.equal(findEdgeCrossings(baked).length, 0, 'bake produces one clean terrain quilt');
  assert(!Object.keys(baked.quadLocked ?? {}).length);
  // Reproduce the room's topology + register transport, rather than only testing the local operation.
  const sequenced = applyTopologyDelta(loaded, topologyDelta(loaded, baked));
  assert(sequenced.ok);
  const before = documentRegisters(loaded),
    after = documentRegisters(baked);
  applyRegisters(
    sequenced.applied.doc,
    [...new Set([...before.keys(), ...after.keys()])]
      .filter(key => canonicalJson(before.get(key)) !== canonicalJson(after.get(key)))
      .map(key => [key, after.get(key)]),
  );
  assert(!('surfaces' in sequenced.applied.doc), 'deleting the last Surface register removes its optional list');
  const roomReload = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(sequenced.applied.doc))));
  assert.equal(
    canonicalJson(roomReload),
    canonicalJson(sequenced.applied.doc),
    'a bake snapshot must not look like an external edit on reload',
  );
  const deleted = deleteSurfaceObject(loaded, finer.surface.id);
  assert(deleted.ok);
  assert(!deleted.doc.surfaces);
  assert.equal(deleted.doc.quads.length, 0);
  assert.equal(deleted.doc.vertexIds.length, 9, 'deleting a surface retains its original sketches');
}
{
  const result = create(),
    removed = deleteSurfaceRow(result.doc, result.surface, 'U', 1);
  assert(removed.ok);
  assert.equal(removed.surface.guides!.length, 2);
  assert.deepEqual(
    terrainState(removed.doc, removed.surface),
    terrainState(result.doc, result.surface),
    'removing a guide preserves every generated control and id',
  );
  samples(removed.doc, removed.surface).forEach((p, i) => near(p, samples(result.doc, result.surface)[i]));
  curvesLieOnSurface(removed.doc, removed.surface);
}
{
  const result = create(),
    original = terrainState(result.doc, result.surface),
    shape = samples(result.doc, result.surface);
  const added = placeSurfacePoint(result.doc, result.surface, 1, 0.37);
  assert(added.ok, added.ok ? '' : added.error);
  assert.equal(added.surface.controls[1].length, 4);
  assert.deepEqual(terrainState(added.doc, added.surface), original);
  const sparse = insertSurfaceRow(result.doc, result.surface, 'U', 0);
  assert(sparse.ok);
  assert.equal(
    sparse.surface.controls.at(-1)!.length,
    2,
    'a new guide starts with endpoints, not rest-surface span points',
  );
  assert.deepEqual(terrainState(sparse.doc, sparse.surface), original);
  const moved = placeSurfacePoint(added.doc, added.surface, 1, 0.71, 1);
  assert(moved.ok, moved.ok ? '' : moved.error);
  assert.deepEqual(terrainState(moved.doc, moved.surface), original);
  const removed = removeSurfacePoint(moved.doc, moved.surface, 1, 1);
  assert(removed.ok, removed.ok ? '' : removed.error);
  assert.deepEqual(terrainState(removed.doc, removed.surface), original);
  samples(removed.doc, removed.surface).forEach((p, i) => near(p, shape[i]));
  const saved = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(removed.doc))));
  assert.deepEqual(saved.surfaces, removed.doc.surfaces);
  assert.equal(refreshSurfaces(saved), saved);
  const crossed = insertSurfaceRow(removed.doc, removed.surface, 'V', 0);
  assert(crossed.ok, crossed.ok ? '' : crossed.error);
  assert.deepEqual(terrainState(crossed.doc, crossed.surface), original);
  const quilt = guideCharts(crossed.doc, crossed.surface);
  crossed.surface.controls.forEach((row, i) =>
    row.forEach((id, j) => {
      const g = crossed.surface.guides![i],
        t = g.knots[j],
        v = crossed.doc.vertexIds.indexOf(id);
      near(
        crossed.doc.vertices.slice(v * 3, v * 3 + 3) as V3,
        chartPoint(quilt, g.axis === 'U' ? t : g.at, g.axis === 'U' ? g.at : t),
      );
    }),
  );
  const point = saved.vertexIds.indexOf(saved.surfaces![0].controls[1][1]);
  moveMeshVertices(saved, [point], [0, 3, 0]);
  const shaped = refreshSurfaces(saved);
  assert(!shaped.surfaces![0].error);
  assert.notDeepEqual(
    samples(shaped, shaped.surfaces![0]),
    shape,
    'ordinary point drags still reshape a reorganized guide',
  );
  assert(!removeSurfacePoint(result.doc, result.surface, 1, 0).ok, 'curve endpoints remain protected');
}
{
  const doc = blankMountain('CROSSING_ARCHES');
  doc.vertices = [-30, 0, 0, 0, 20, 0, 30, 0, 0, 0, 0, -30, 0, 20, 0, 0, 0, 30];
  Object.assign(doc, appendMeshIds(doc, 6, 0));
  doc.freeEdges = [
    [0, 1],
    [1, 2],
    [3, 4],
    [4, 5],
  ];
  const result = createSurfaceFromProfiles(
    doc,
    [
      [0, 1, 2],
      [3, 4, 5],
    ],
    { patchSizeM: 12 },
  );
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(
    result.surface.guides!.map(g => g.axis),
    ['U', 'V'],
  );
  assert.equal(result.surface.guides!.length, 2);
  curvesLieOnSurface(result.doc, result.surface);
  near(splinePoint(surfaceNet(result.doc, result.surface), 0.5, 0.5), [0, 20, 0]);
  for (const u of [0, 1])
    for (const v of [0, 1])
      assert(Math.abs(chartPoint(result.surface.seed!, u, v)[1]) < 1e-6, 'hill footprint stays at the arch feet');
  const shared = result.surface.controls[0].find(id => result.surface.controls[1].includes(id))!;
  assert(shared, 'two arches share their peak');
  const index = result.doc.vertexIds.indexOf(shared);
  moveMeshVertices(result.doc, [index], [0, 6, 0]);
  const moved = refreshSurfaces(result.doc);
  assert(!moved.surfaces![0].error);
  curvesLieOnSurface(moved, moved.surfaces![0]);
  near(splinePoint(surfaceNet(moved, moved.surfaces![0]), 0.5, 0.5), [0, 26, 0]);
  for (const u of [0, 1])
    for (const v of [0, 1])
      assert(
        Math.abs(chartPoint(guideCharts(moved, moved.surfaces![0]), u, v)[1]) < 1e-6,
        'raising the peak leaves the automatic footprint level',
      );
  const translated = structuredClone(moved),
    beforeMove = samples(moved, moved.surfaces![0]);
  moveMeshVertices(
    translated,
    [...new Set(translated.surfaces![0].controls.flat())].map(id => translated.vertexIds.indexOf(id)),
    [11, 7, -9],
  );
  const carried = refreshSurfaces(translated);
  samples(carried, carried.surfaces![0]).forEach((p, i) =>
    near(p, [beforeMove[i][0] + 11, beforeMove[i][1] + 7, beforeMove[i][2] - 9]),
  );
  const single = deleteSurfaceRow(moved, moved.surfaces![0], 'U', 0);
  assert(single.ok);
  assert.deepEqual(terrainState(single.doc, single.surface), terrainState(moved, moved.surfaces![0]));
  assert(!deleteSurfaceRow(single.doc, single.surface, 'V', 0).ok, 'keep one editable curve');
  const added = insertSurfaceRow(moved, moved.surfaces![0], 'V', 0);
  assert(added.ok);
  samples(added.doc, added.surface).forEach((p, i) => near(p, samples(moved, moved.surfaces![0])[i]));
  curvesLieOnSurface(added.doc, added.surface);
}
{
  const doc = blankMountain('BOUNDARY');
  doc.vertices = [0, 0, 0, 40, 0, 0, 40, 12, 60, 0, 0, 60];
  Object.assign(doc, appendMeshIds(doc, 4, 0));
  doc.freeEdges = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ];
  doc.edgeHandles = {};
  for (const [a, b] of doc.freeEdges) {
    const delta = [0, 1, 2].map(i => (doc.vertices[b * 3 + i] - doc.vertices[a * 3 + i]) / 3) as V3;
    doc.edgeHandles[`${a}>${b}`] = delta;
    doc.edgeHandles[`${b}>${a}`] = delta.map(n => -n) as V3;
  }
  const result = createSurfaceFromBoundary(doc, doc.freeEdges);
  assert(result.ok, result.ok ? '' : result.error);
  near(splinePoint(surfaceNet(result.doc, result.surface), 0.5, 0.5), [20, 3, 30]);
  assert.equal(result.surface.controls.length, 4);
  assert.equal(result.surface.controls[0].length, 2);
  const net = surfaceNet(result.doc, result.surface);
  const movedBoundary = placeSurfaceGuide(result.doc, result.surface, 'U', 0.23, guideRows(result.surface, 'U')[0]);
  assert(movedBoundary.ok, movedBoundary.ok ? '' : movedBoundary.error);
  assert.deepEqual(
    terrainState(movedBoundary.doc, movedBoundary.surface),
    terrainState(result.doc, result.surface),
    'a boundary guide can move inward without trimming or reshaping the fill',
  );
  curvesLieOnSurface(movedBoundary.doc, movedBoundary.surface);
  for (const axis of ['U', 'V'] as const) {
    const inserted = insertSplineRow(net, axis, 0.4);
    const removed = removeSplineKnot(inserted, axis, 4);
    assert(removed.deviationM < 1e-7);
    assert(deleteSurfaceRow(result.doc, result.surface, axis, 1).ok, 'guide removal does not require four CV rows');
    near(splinePoint(removed.net, 0.31, 0.67), splinePoint(net, 0.31, 0.67));
  }
  assert(!surfaceBoundaryLoop(doc, [...doc.freeEdges, [0, 2]]).ok, 'branched boundaries are rejected');
  assert(!createSurfaceFromBoundary(doc, doc.freeEdges, [0, 0, 2, 3]).ok);
}
{
  const { doc, profiles } = fixture(),
    legacy = createLoftSurface(doc, profiles);
  assert(legacy.ok);
  legacy.doc.quadTwist![0][0][1] += 4;
  const upgraded = refreshSurfaces(legacy.doc);
  assert.equal(upgraded.lofts?.length ?? 0, 0);
  assert.equal(upgraded.surfaces?.length, 1);
  assert.equal(upgraded.surfaces![0].origin, 'legacy');
  assert(upgraded.surfaces![0].guides, 'older cages migrate to sparse curves');
  assert.equal(upgraded.surfaces![0].guides!.length, 3);
  const raw = JSON.parse(JSON.stringify(serializeMountain(upgraded)));
  raw.surfaces = [null, { id: 'bad' }];
  assert(!migrateMountain(raw).surfaces);
}
console.log(
  'SURFACE: minimal control curves, exact interpolation and U/V insertion, shared crossings, two-arch hills, source/tangent editing, derived protection, density, persistence, registers, legacy adoption and bake passed.',
);
