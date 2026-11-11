// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { canonicalJson } from '../src/core/doc/canonical';
import { applyRegisters, documentRegisters, objectRegister } from '../src/core/doc/registers';
import { applyTopologyDelta, topologyDelta } from '../src/core/doc/topology-delta';
import { buildMountainLevel } from '../src/core/export/level';
import {
  subdivisionPatches,
  subdivisionLimitPoints,
  subdivideCage,
  validateSubdivisionMesh,
  type SubdivisionMesh,
} from '../src/core/math/subdivision';
import { patchPoint } from '../src/core/math/bezier';
import {
  createSubdivisionCage,
  creaseSubdivisionSelection,
  rebuildSubdivision,
} from '../src/core/mesh/subdivision-object';
import { subdivisionEdges } from '../src/core/mesh/subdivision-topology';
import { subdivisionEdgeSelection } from '../src/core/mesh/subdivision-selection';
import {
  bakeSurface,
  deleteSurfaceObject,
  refreshSurfaces,
  revertSubdivisionCage,
} from '../src/core/mesh/surface-object';
import { applyPlannedEdgeExtrusion, planEdgeExtrusion, translatedEdgeExtrusionPlacement } from '../src/core/mesh/ops';
import { createSurfaceFromDrawnBoundary, stitchTouchingSurfaceBoundaries } from '../src/core/mesh/surface-boundary';
import { addSurfaceStitch, evaluateSurfaceStitches } from '../src/core/mesh/surface-stitch';
import { moveMeshVertices } from '../src/core/mesh/control-points';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { finishMeshRewrite } from '../src/core/mesh/ops/contract';
import { createSurfacePreviewEvaluator } from '../src/core/mesh/surface-preview';
import { createSurfaceEditGuard } from '../src/app/edit/surface-edit-guard';
import type { V3 } from '../src/core/doc/types';

const near = (a: readonly number[], b: readonly number[], eps = 1e-7) =>
  assert(a.length === b.length && a.every((n, i) => Math.abs(n - b[i]) < eps), `${a} != ${b}`);
function grid(size = 3) {
  const doc = blankMountain('SUBDIVISION', 20);
  doc.vertices = [];
  doc.quads = [];
  for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) doc.vertices.push(x * 20, x * x + z * z, z * 20);
  for (let x = 0; x < size - 1; x++)
    for (let z = 0; z < size - 1; z++) {
      const a = x * size + z;
      doc.quads.push([a, a + 1, a + size, a + size + 1]);
    }
  Object.assign(doc, appendMeshIds(doc, size * size, doc.quads.length));
  return doc;
}
const cube: SubdivisionMesh = {
  points: [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ],
  faces: [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [3, 7, 6, 2],
    [0, 4, 7, 3],
    [1, 2, 6, 5],
  ],
  creases: [],
};
// Range selection follows source faces, even though their displayed links are free edges in the document.
{
  const source = grid(6),
    { doc, surface } = createSubdivisionCage(
      source,
      source.quads.map((_, i) => i),
      1,
    ),
    before = structuredClone(doc);
  const point = (x: number, z: number) =>
    surface.controls[0].find(id => {
      const at = doc.vertexIds.indexOf(id) * 3;
      return doc.vertices[at] === x * 20 && doc.vertices[at + 2] === z * 20;
    })!;
  const edge = (x: number, z: number): [string, string] => [point(x, z), point(x, z + 1)].sort() as [string, string];
  const keys = (edges: readonly [string, string][]) => edges.map(e => [...e].sort().join('>')).sort();
  const first = edge(2, 0),
    last = edge(2, 4),
    unrelated = edge(3, 3);
  const run = subdivisionEdgeSelection(doc, [unrelated, first], first, last, 'range')!;
  assert.deepEqual(keys(run.edges), keys([unrelated, ...Array.from({ length: 5 }, (_, z) => edge(2, z))]));
  assert.deepEqual(run.anchor, first, 'Repeated Shift picks keep the original edge anchor');
  assert.deepEqual(
    keys(subdivisionEdgeSelection(doc, [], last, edge(2, 1), 'range')!.edges),
    keys(Array.from({ length: 4 }, (_, z) => edge(2, z + 1))),
  );
  assert.deepEqual(
    subdivisionEdgeSelection(doc, [first], first, unrelated, 'range')!.edges,
    [first],
    'A different cage loop cannot divert the range',
  );
  assert.deepEqual(subdivisionEdgeSelection(doc, [], null, first, 'range'), { edges: [first], anchor: first });
  assert.equal(
    subdivisionEdgeSelection(doc, [], null, [surface.patches[0].corners[0], surface.patches[0].corners[1]], 'range'),
    null,
    'Generated terrain edges use the ordinary mesh selection',
  );
  const boundary = edge(0, 0),
    aroundCorner: [string, string] = [point(1, 0), point(2, 0)],
    corner: [string, string] = [point(0, 0), point(1, 0)];
  assert.deepEqual(
    keys(subdivisionEdgeSelection(doc, [boundary], boundary, aroundCorner, 'range')!.edges),
    keys([boundary, corner, aroundCorner]),
    'A closed cage rim takes the shorter arc, including its corner',
  );
  assert.equal(subdivisionEdgeSelection(doc, [], null, first, 'loop')!.edges.length, 5);
  assert.equal(subdivisionEdgeSelection(doc, [], null, boundary, 'loop')!.edges.length, 20);
  assert.deepEqual(doc, before, 'Range and loop picks only change selection');
}
{
  validateSubdivisionMesh(cube);
  const split = subdivideCage(cube);
  assert.equal(split.faces.length, 24);
  assert.equal(split.points.length, 26);
  near(split.points[0], [-5 / 9, -5 / 9, -5 / 9]);
  near(split.points[8], [-0.75, 0, -0.75]);
  const sharp = {
    ...cube,
    creases: [
      ...new Map(
        cube.faces.flatMap(f =>
          f.map((a, i) => {
            const e: [number, number] = [a, f[(i + 1) % 4]];
            return [[...e].sort().join(','), e] as const;
          }),
        ),
      ).values(),
    ],
  };
  const smooth = subdivisionPatches(cube, 1),
    hard = subdivisionPatches(sharp, 1);
  const zero = subdivisionPatches(cube, 0);
  assert.equal(zero.faces.length, cube.faces.length, 'Level 0 uses one bicubic patch per source face');
  assert.equal(zero.points.length, cube.points.length);
  assert(zero.controls.every(cp => cp.length === 16 && cp.flat().every(Number.isFinite)));
  assert(
    zero.points.every(p => p.every(n => Math.abs(n) < 1)),
    'Level 0 still evaluates the curved limit surface',
  );
  near(subdivisionPatches({ ...cube, corners: [0] }, 0).points[0], cube.points[0]);
  subdivisionPatches(sharp, 0).points.forEach((p, i) => near(p, cube.points[i]));
  const pinned = subdivisionPatches({ ...cube, corners: [0] }, 1);
  near(pinned.points[0], cube.points[0]);
  near(subdivisionLimitPoints(subdivideCage({ ...cube, corners: [0] }))[0], cube.points[0]);
  assert.throws(() => subdivisionPatches({ ...cube, corners: [100] }, 1), /missing cage point/);
  assert(smooth.points.every(p => p.every(n => Math.abs(n) < 1)));
  sharp.points.forEach((p, i) => near(hard.points[i], p));
  const dart = { ...cube, creases: [[0, 1]] as [number, number][] };
  const limits = subdivisionLimitPoints(dart),
    refined = subdivisionLimitPoints(subdivideCage(dart));
  limits.forEach((p, i) => near(p, refined[i], 1e-12));
  for (const shape of [cube, sharp, dart])
    for (const level of [0, 1]) {
      const generated = subdivisionPatches(shape, level);
      generated.faces.forEach((face, i) =>
        face.forEach((v, j) => near(generated.controls[i][[0, 3, 12, 15][j]], generated.points[v])),
      );
      const edges = new Map<string, V3[]>();
      generated.faces.forEach(([a, b, c, d], i) => {
        const cp = generated.controls[i];
        for (const [A, B, slots] of [
          [a, b, [0, 1, 2, 3]],
          [b, d, [3, 7, 11, 15]],
          [d, c, [15, 14, 13, 12]],
          [c, a, [12, 8, 4, 0]],
        ] as [number, number, number[]][]) {
          const k = [A, B].sort((x, y) => x - y).join(','),
            curve = slots.map(j => cp[j]);
          if (A > B) curve.reverse();
          const previous = edges.get(k);
          if (previous) curve.forEach((p, j) => near(p, previous[j]));
          else edges.set(k, curve);
        }
      });
    }
  assert.throws(() => subdivisionPatches(cube, 5), /level/);
  assert.throws(() => subdivisionPatches(cube, -1), /level/);
  assert.throws(() => subdivisionPatches(cube, 0.5), /level/);
  assert.throws(() => subdivisionPatches({ ...cube, faces: Array(1024).fill(cube.faces[0]) }, 4), /manifold|Orient/);
}
{
  const doc = grid(6),
    cage: SubdivisionMesh = {
      points: Array.from({ length: 36 }, (_, i) => doc.vertices.slice(i * 3, i * 3 + 3) as V3),
      faces: doc.quads.map(([a, b, c, d]) => [a, b, d, c]),
      creases: [],
    };
  const zero = subdivisionPatches(cage, 0),
    coarse = subdivisionPatches(cage, 1),
    fine = subdivisionPatches(cage, 2);
  assert.throws(() => subdivisionPatches(cage, 4), /4,096/);
  const parent = 12 * 4;
  for (const u of [0, 0.2, 0.7, 1])
    for (const v of [0, 0.3, 0.8, 1]) {
      near(patchPoint(zero.controls[12], u / 2, v / 2), patchPoint(coarse.controls[parent], u, v));
      near(patchPoint(coarse.controls[parent], u / 2, v / 2), patchPoint(fine.controls[parent * 4], u, v));
    }
  // Every output edge is one identical cubic even when two face charts have different orientations.
  const edges = new Map<string, V3[]>();
  fine.faces.forEach(([a, b, c, d], i) => {
    const cp = fine.controls[i];
    for (const [A, B, indices] of [
      [a, b, [0, 1, 2, 3]],
      [b, d, [3, 7, 11, 15]],
      [d, c, [15, 14, 13, 12]],
      [c, a, [12, 8, 4, 0]],
    ] as [number, number, number[]][]) {
      const key = [A, B].sort((x, y) => x - y).join(','),
        values = indices.map(j => cp[j]);
      if (A > B) values.reverse();
      const previous = edges.get(key);
      if (previous) values.forEach((p, j) => near(p, previous[j]));
      else edges.set(key, values);
    }
  });
  assert.throws(() => validateSubdivisionMesh({ ...cage, faces: [cage.faces[0], cage.faces.at(-1)!] }), /connected/);
  assert.throws(() => validateSubdivisionMesh({ ...cage, faces: [[0, 1, 2, 2]] }), /proper quad/);
}
{
  const original = grid(),
    before = structuredClone(original);
  original.quadPaint = { 0: 2 };
  original.quadTex = { 0: 'test/snow' };
  Object.assign(before, { quadPaint: { 0: 2 }, quadTex: { 0: 'test/snow' } });
  const created = createSubdivisionCage(original, [0, 1, 2, 3]);
  assert.deepEqual(before, original, 'creation does not mutate its input');
  let { doc, surface } = created;
  assert.equal(surface.subdivision!.level, 1, 'New cages default to subdivision level 1');
  assert.equal(surface.patches.length, 16);
  assert.equal(doc.quadPaint?.[0], 2);
  assert.equal(doc.quadTex?.[0], 'test/snow');
  assert.equal(refreshSurfaces(doc), doc, 'an unchanged cage does not regenerate');
  const zero = rebuildSubdivision(doc, { ...surface, subdivision: { ...surface.subdivision!, level: 0 } });
  assert.equal(zero.surface.patches.length, 4);
  assert.deepEqual(zero.surface.controls, surface.controls, 'Lowering the level retains the original source cage');
  assert.equal(refreshSurfaces(zero.doc), zero.doc, 'An unchanged level-0 cage does not regenerate');
  const savedZero = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(zero.doc))));
  assert.equal(savedZero.surfaces![0].subdivision!.level, 0);
  assert.equal(canonicalJson(savedZero), canonicalJson(zero.doc), 'Level 0 survives save and load');
  const restoredLevel = rebuildSubdivision(zero.doc, {
    ...zero.surface,
    subdivision: { ...zero.surface.subdivision!, level: 1 },
  });
  assert.equal(restoredLevel.surface.patches.length, 16);
  assert.deepEqual(restoredLevel.surface.controls, surface.controls);
  assert.equal(
    createSubdivisionCage(original, [0, 1, 2, 3], 0).surface.patches.length,
    4,
    'Cages can also be created directly at level 0',
  );
  const saved = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(doc))));
  assert.equal(canonicalJson(saved), canonicalJson(doc), 'cage and terrain round-trip through saved documents');
  assert(
    documentRegisters(saved).has(objectRegister('surface', surface.id)),
    'cage is a normal synchronized authoring object',
  );
  const ids = doc.vertexIds,
    quads = doc.quads,
    quadIds = doc.quadIds,
    positions = [...doc.vertices];
  const v = doc.vertexIds.indexOf(surface.controls[0][4]);
  moveMeshVertices(doc, [v], [0, 10, 0]);
  doc = refreshSurfaces(doc);
  assert.equal(doc.vertexIds, ids);
  assert.equal(doc.quads, quads);
  assert.equal(doc.quadIds, quadIds);
  assert.notDeepEqual(doc.vertices, positions);
  surface = doc.surfaces![0];
  const edge = subdivisionEdges(surface)[0];
  const marked = refreshSurfaces(creaseSubdivisionSelection(doc, [edge[0]], [], true)!);
  assert.deepEqual(marked.surfaces![0].subdivision!.corners, [edge[0]]);
  assert.equal(marked.surfaces![0].subdivision!.creases.length, 0, 'point sharpness does not crease adjacent edges');
  const cornerPoint = marked.vertexIds.indexOf(edge[0]);
  const cornerPosition = marked.vertices.slice(cornerPoint * 3, cornerPoint * 3 + 3);
  assert(
    marked.surfaces![0].patches.some(p =>
      p.corners.some(id => {
        const v = marked.vertexIds.indexOf(id);
        return cornerPosition.every((n, d) => Math.abs(n - marked.vertices[v * 3 + d]) < 1e-9);
      }),
    ),
    'a sharp corner pulls the terrain to the selected cage point',
  );
  const reloadedMark = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(marked))));
  assert.deepEqual(reloadedMark.surfaces![0].subdivision!.corners, [edge[0]]);
  const edgeAndCorner = refreshSurfaces(creaseSubdivisionSelection(marked, [], [edge], true)!);
  const clearedCorner = refreshSurfaces(creaseSubdivisionSelection(edgeAndCorner, [edge[0]], [], false)!);
  assert(!clearedCorner.surfaces![0].subdivision!.corners?.length);
  assert.equal(
    clearedCorner.surfaces![0].subdivision!.creases.length,
    1,
    'smoothing a corner retains explicit edge creases',
  );
  const invalidCorners = JSON.parse(JSON.stringify(serializeMountain(marked)));
  invalidCorners.surfaces[0].subdivision.corners = ['missing'];
  assert(
    !migrateMountain(invalidCorners).surfaces?.length,
    'invalid sharp-corner history leaves terrain available as ordinary geometry',
  );
  const creased = creaseSubdivisionSelection(doc, [], [edge], true)!;
  doc = refreshSurfaces(creased);
  surface = doc.surfaces![0];
  assert.equal(surface.subdivision!.creases.length, 1);
  assert.equal(
    refreshSurfaces(creaseSubdivisionSelection(doc, [], [edge], false)!).surfaces![0].subdivision!.creases.length,
    0,
  );
  const higher = rebuildSubdivision(doc, { ...surface, subdivision: { ...surface.subdivision!, level: 2 } });
  assert.equal(higher.surface.patches.length, 64);
  assert(higher.doc.quadTex && Object.values(higher.doc.quadTex).includes('test/snow'));
  const preview = createSurfacePreviewEvaluator();
  const initial = preview({ epoch: 1, initial: doc, inputs: doc, change: {} });
  assert.equal(initial.kind, 'ready');
  const changed = { ...doc, vertices: doc.vertices.slice() };
  changed.vertices[v * 3 + 1] += 1;
  const next = preview({ epoch: 2, inputs: changed, change: { vertices: [v] } });
  assert.equal(next.kind, 'ready');
  if (next.kind === 'ready') assert.deepEqual(next.changed, [surface.id]);
  const guard = createSurfaceEditGuard();
  guard.refresh(doc, { authored: false });
  const invalid = { ...doc, surfaces: [{ ...surface, subdivision: { ...surface.subdivision!, level: 9 } }] };
  assert.match(guard.refresh(invalid).rejected!, /level/);
  assert.throws(() => finishMeshRewrite(doc, { ...doc, freeEdges: [] }), /Bake the subdivision/);
  assert.throws(() => addSurfaceStitch(doc, surface.id, { side: 'u0', range: [0, 1] }, { vertices: edge }), /Bake/);
  assert.throws(() => stitchTouchingSurfaceBoundaries(doc, surface.id), /Bake/);
  const mixed = createSurfaceFromDrawnBoundary(
    doc,
    [
      [100, 0, 0],
      [100, 0, 20],
      [120, 0, 20],
      [120, 0, 0],
    ].map(pos => ({ pos: pos as V3, vertex: null })),
    20,
  );
  assert(mixed.ok, mixed.ok ? '' : mixed.error);
  const assembled = evaluateSurfaceStitches(mixed.doc);
  assert.deepEqual(
    assembled.surfaces!.find(s => s.id === surface.id),
    surface,
    'unrelated stitching preserves cage charts',
  );
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const expected = surface.patches.map(p =>
    quadControlPoints(mesh, edgeHandle, doc.quadIds.indexOf(p.quad), doc.quadTwist?.[doc.quadIds.indexOf(p.quad)]),
  );
  const baked = bakeSurface(doc, surface.id);
  assert(!baked.surfaces?.length);
  assert(!baked.freeEdges?.length);
  assert.equal(baked.vertexIds.length, surface.vertices.length, 'baking removes construction and source controls');
  const derived = meshFromDoc(baked);
  baked.quads.forEach((_, q) =>
    quadControlPoints(derived.mesh, derived.edgeHandle, q, baked.quadTwist?.[q]).forEach((p, i) =>
      near(p, expected[q][i]),
    ),
  );
  assert(!baked.quadLocked || !Object.values(baked.quadLocked).some(Boolean));
  const reverted = revertSubdivisionCage(doc, surface.id);
  assert(reverted.ok, reverted.ok ? '' : reverted.error);
  assert(!reverted.doc.surfaces?.length);
  assert(!reverted.doc.freeEdges?.length);
  assert.equal(reverted.doc.quads.length, surface.subdivision!.faces.length, 'Revert restores the coarse cage faces');
  assert.equal(
    reverted.doc.vertexIds.length,
    surface.controls[0].length,
    'Revert removes generated terrain and hidden construction points',
  );
  assert(!reverted.doc.quadLocked || !Object.values(reverted.doc.quadLocked).some(Boolean));
  const revertedMesh = meshFromDoc(reverted.doc);
  surface.subdivision!.faces.forEach(([a, b, c, d], i) => {
    const expected = [a, b, d, c].map(id => {
      const at = doc.vertexIds.indexOf(id) * 3;
      return doc.vertices.slice(at, at + 3);
    });
    reverted.doc.quads[i].forEach((v, j) => near(reverted.doc.vertices.slice(v * 3, v * 3 + 3), expected[j]));
    const cp = quadControlPoints(revertedMesh.mesh, revertedMesh.edgeHandle, i, reverted.doc.quadTwist?.[i]);
    near(
      patchPoint(cp, 0.5, 0.5),
      expected[0].map((_, axis) => expected.reduce((sum, p) => sum + p[axis], 0) / 4),
    );
  });
  assert.equal(reverted.doc.quadPaint?.[0], 2);
  assert.equal(reverted.doc.quadTex?.[0], 'test/snow');
  const appendPlan = planEdgeExtrusion(reverted.doc, [[reverted.doc.quads[0][0], reverted.doc.quads[0][1]]]);
  assert(appendPlan.ok, appendPlan.ok ? '' : appendPlan.error);
  const appended = applyPlannedEdgeExtrusion(
    reverted.doc,
    appendPlan.plan,
    translatedEdgeExtrusionPlacement(reverted.doc, appendPlan.plan, [0, 10, 0]),
  );
  assert(appended.ok, appended.ok ? '' : appended.error);
  assert.equal(appended.doc.quads.length, reverted.doc.quads.length + 1, 'Reverted patches support appending geometry');
  const recaged = createSubdivisionCage(
    appended.doc,
    appended.doc.quads.map((_, i) => i),
    1,
  );
  assert.equal(
    recaged.surface.subdivision!.faces.length,
    appended.doc.quads.length,
    'The extended mesh can become a subdivision cage again',
  );
  const otherBefore = mixed.doc.surfaces!.find(s => s.id === mixed.surface.id);
  const revertedMixed = revertSubdivisionCage(mixed.doc, surface.id);
  assert(revertedMixed.ok, revertedMixed.ok ? '' : revertedMixed.error);
  assert.deepEqual(revertedMixed.doc.surfaces, [otherBefore], 'Reverting one cage preserves other surface objects');
  const reloadedRevert = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(reverted.doc))));
  assert.equal(canonicalJson(reloadedRevert), canonicalJson(reverted.doc));
  const exported = buildMountainLevel({ ...baked, quadTex: undefined }, [], { lighting: false });
  const records = JSON.parse(exported.text['Patches.json']).Patches as { Points: number[][] }[];
  assert.equal(records.length, surface.patches.length, 'baked cages export through the existing terrain path');
  assert(records.every(p => p.Points.length === 16 && p.Points.flat().every(Number.isFinite)));
  for (const [start, end] of [
    [original, created.doc],
    [doc, zero.doc],
    [doc, higher.doc],
    [doc, baked],
    [doc, reverted.doc],
  ]) {
    const sequenced = applyTopologyDelta(start, topologyDelta(start, end));
    assert(sequenced.ok);
    const oldRegisters = documentRegisters(start),
      newRegisters = documentRegisters(end);
    applyRegisters(
      sequenced.applied.doc,
      [...new Set([...oldRegisters.keys(), ...newRegisters.keys()])]
        .filter(k => canonicalJson(oldRegisters.get(k)) !== canonicalJson(newRegisters.get(k)))
        .map(k => [k, newRegisters.get(k)]),
    );
    const restored = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(sequenced.applied.doc))));
    // Register deletion can retain an empty sparse lock map; it has the same unlocked behavior.
    assert.deepEqual(restored.quadLocked ?? {}, end.quadLocked ?? {});
    const differences = [...new Set([...Object.keys(restored), ...Object.keys(end)])]
      .filter(k => k !== 'quadLocked')
      .filter(k => canonicalJson(restored[k as keyof typeof restored]) !== canonicalJson(end[k as keyof typeof end]));
    assert.deepEqual(differences, [], 'create, level changes, bake and revert survive topology/register transport');
  }
  const deleted = deleteSurfaceObject(doc, surface.id);
  assert(deleted.ok, deleted.ok ? '' : deleted.error);
  assert.equal(deleted.doc.vertices.length, 0);
  assert.equal(deleted.doc.quads.length, 0);
}
console.log(
  '✓ Catmull-Clark cages, shared cubic seams, exact regular spans, persistence, preview, creases, guards and baking',
);
