// tier: fast
import assert from 'node:assert/strict';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { serializeMountain } from '../src/core/doc/serialize';
import { documentRegisters, objectRegister, writeRegister } from '../src/core/doc/registers';
import {
  createLoftSurface,
  refreshLoftSurfaces,
  rebuildLoftSurface,
  bakeLoftSurface,
  rebaseLoftTransforms,
} from '../src/core/mesh/loft-surface';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { meshControlPoints, setMeshControlPoints, controlPointKey } from '../src/core/mesh/control-points';
import { patchPoint, patchNormal } from '../src/core/math/bezier';
import { findCoincidentVertices } from '../src/core/mesh/coincident-vertices';
import { findEdgeCrossings } from '../src/core/mesh/edge-crossings';
import { inferGeometricTJunctions } from '../src/core/mesh/t-junctions';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';

function fixture() {
  const doc = blankMountain('LOFT_TEST');
  const profiles: number[][] = [];
  for (let r = 0; r < 3; r++) {
    const points: number[] = [];
    for (let s = 0; s < 3; s++) {
      points.push(doc.vertices.length / 3);
      doc.vertices.push(r * 30, r === 1 && s === 1 ? 12 : 0, s * 20);
    }
    profiles.push(points);
  }
  Object.assign(doc, appendMeshIds(doc, 9, 0));
  doc.freeEdges = profiles.flatMap(
    p =>
      [
        [p[0], p[1]],
        [p[1], p[2]],
      ] as [number, number][],
  );
  return { doc, profiles };
}
function create() {
  const { doc, profiles } = fixture(),
    before = structuredClone(doc);
  const result = createLoftSurface(doc, profiles, { patchSizeM: 15 });
  assert(result.ok, result.ok ? '' : result.error);
  assert.deepEqual(doc, before, 'creation is pure');
  return { ...result, profiles };
}
function at(doc: QuadMeshDoc, u: number, v: number): V3 {
  const loft = doc.lofts![0];
  const patch = loft.patches.find(
    p => u >= p.domain[0] - 1e-9 && u <= p.domain[1] + 1e-9 && v >= p.domain[2] - 1e-9 && v <= p.domain[3] + 1e-9,
  )!;
  assert(patch, 'chart location exists');
  const q = doc.quadIds.indexOf(patch.quad),
    { mesh, edgeHandle } = meshFromDoc(doc);
  const cp = quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
  return patchPoint(
    cp,
    (u - patch.domain[0]) / (patch.domain[1] - patch.domain[0]),
    (v - patch.domain[2]) / (patch.domain[3] - patch.domain[2]),
  );
}
const near = (a: V3, b: V3) => assert(Math.hypot(...a.map((x, i) => x - b[i])) < 1e-7, `${a} != ${b}`);
const samples = (doc: QuadMeshDoc) => Array.from({ length: 31 }, (_, i) => at(doc, 0.07 + i * 0.06, 0.13 + i * 0.05));

{
  const { doc, profiles } = create(),
    loft = doc.lofts![0];
  assert(loft.patches.length > 4);
  assert(!doc.quadLocked || !Object.keys(doc.quadLocked).length, 'output is editable');
  assert.equal(doc.freeEdges!.length, 6, 'construction curves survive');
  assert(
    loft.vertices.every(id => !loft.profiles.flat().includes(id)),
    'source and output have separate identities',
  );
  near(at(doc, 1, 1), [30, 12, 20]);
  const evaluated = meshFromDoc(doc);
  for (const p of loft.patches) {
    const q = doc.quadIds.indexOf(p.quad);
    assert(
      patchNormal(quadControlPoints(evaluated.mesh, evaluated.edgeHandle, q, doc.quadTwist?.[q]), 0.5, 0.5)[1] > 0,
      'terrain faces upward',
    );
  }
  assert.equal(findCoincidentVertices(doc).length, 0, 'intentional construction controls are not unwelded terrain');
  assert.equal(findEdgeCrossings(doc).length, 0, 'source profiles are not crossing-terrain warnings');
  assert.equal(inferGeometricTJunctions(doc).length, 0, 'source controls are not T-junctions');
  const q = doc.quadIds.indexOf(loft.patches[0].quad),
    quad = doc.quads[q];
  doc.quadTwist![q][0][1] += 3;
  doc.quadTex = { [q]: 'TEST/snow.png' };
  const old = samples(doc);
  const dense = rebuildLoftSurface(doc, { ...loft, patchSizeM: 7 });
  assert(dense.ok, dense.ok ? '' : dense.error);
  samples(dense.doc).forEach((p, i) => near(p, old[i]));
  assert(Object.values(dense.doc.quadTex ?? {}).includes('TEST/snow.png'), 'paint follows source coordinates');
  const denser = structuredClone(dense.doc);
  denser.vertices[profiles[1][1] * 3 + 1] += 9;
  const updated = refreshLoftSurfaces(denser);
  assert.notEqual(updated, denser, 'source edits trigger history');
  assert(at(updated, 1, 1)[1] > 20, 'profile edits reach the evaluated surface');
  assert.equal(refreshLoftSurfaces(updated), updated, 'evaluation is idempotent');
  let moving = updated;
  const canonical = structuredClone(updated.lofts![0].detail);
  const limit = updated.lofts![0].patches.length * 3;
  for (let frame = 0; frame < 18; frame++) {
    const next = structuredClone(moving);
    next.vertices[next.vertexIds.indexOf(next.lofts![0].profiles[1][1]) * 3 + 1] += 0.3;
    moving = refreshLoftSurfaces(next);
    assert(!moving.lofts![0].error);
    assert.deepEqual(moving.lofts![0].detail, canonical, 'source drags retain the original detail domains');
    assert(moving.lofts![0].patches.length < limit, 'density cuts do not accumulate each drag frame');
  }
  const restored = migrateMountain(JSON.parse(JSON.stringify(serializeMountain(moving))));
  assert.deepEqual(restored.lofts, moving.lofts, 'canonical finishing detail survives save/load');
  assert.equal(refreshLoftSurfaces(restored), restored);
  assert(quad.every(i => Number.isInteger(i)));
}
{
  const { doc, loft } = create();
  const before = samples(doc);
  const fine = rebuildLoftSurface(doc, { ...loft, patchSizeM: 6 });
  assert(fine.ok);
  samples(fine.doc).forEach((p, i) => near(p, before[i]));
  const coarse = rebuildLoftSurface(fine.doc, { ...fine.loft, patchSizeM: 60 });
  assert(coarse.ok);
  assert(coarse.loft.patches.length < fine.loft.patches.length);
  samples(coarse.doc).forEach((p, i) => near(p, before[i]));
  const saved = serializeMountain(doc),
    loaded = migrateMountain(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(loaded.lofts, doc.lofts, 'save/load retains construction history');
  samples(loaded).forEach((p, i) => near(p, before[i]));
  const registers = documentRegisters(doc);
  assert(registers.has(objectRegister('loft', loft.id)), 'lofts participate in shared editing and undo');
  const copy = structuredClone(doc);
  assert.equal(writeRegister(copy, objectRegister('loft', loft.id), { ...loft, name: 'Renamed' }), 'landed');
  assert.equal(copy.lofts![0].name, 'Renamed');
  const baked = bakeLoftSurface(doc, loft.id);
  assert(!baked.lofts);
  assert.deepEqual(baked.quads, doc.quads);
  assert.deepEqual(baked.vertices, doc.vertices);
}
{
  const { doc, profiles } = fixture();
  profiles[1] = [profiles[1][0], profiles[1][2]];
  doc.freeEdges!.push([profiles[1][0], profiles[1][1]]);
  const result = createLoftSurface(doc, profiles);
  assert(result.ok, 'profiles with different edge counts are made compatible');
}
{
  // One complete selection transforms the source, generated cage and authored relief together.
  const { doc } = create();
  doc.quadTwist![0][0][1] += 3;
  const old = samples(doc);
  const transform = ([x, y, z]: V3): V3 => [20 - z * 2, y * 2 + 4, x * 2 - 12];
  setMeshControlPoints(
    doc,
    meshControlPoints(doc).map(p => ({ id: p.id, pos: transform(p.pos) })),
    {
      independent: true,
    },
  );
  const carried = rebaseLoftTransforms(
    doc,
    doc.vertexIds.map((_, i) => i),
  );
  assert.notEqual(carried, doc);
  assert.equal(refreshLoftSurfaces(carried), carried, 'whole-object drag keeps stable topology until release');
  samples(carried).forEach((p, i) => near(p, transform(old[i])));
  const result = rebuildLoftSurface(carried, carried.lofts![0]);
  assert(result.ok);
  samples(result.doc).forEach((p, i) => near(p, transform(old[i])));
  const changed = structuredClone(result.doc);
  const loft = changed.lofts![0];
  changed.vertices[changed.vertexIds.indexOf(loft.profiles[0][0]) * 3 + 1] += 5;
  assert.equal(
    rebaseLoftTransforms(
      changed,
      loft.vertices.map(id => changed.vertexIds.indexOf(id)),
    ),
    changed,
    'surface-only selections cannot consume a source deformation',
  );
}
{
  // A density change compacts indices; every unrelated cage and channel must survive that remapping.
  const { doc, loft } = create();
  const start = doc.vertexIds.length,
    q = doc.quads.length;
  doc.vertices.push(100, 0, 0, 100, 0, 20, 120, 4, 0, 120, 4, 20, 200, 3, 200);
  doc.quads.push([start, start + 1, start + 2, start + 3]);
  Object.assign(doc, appendMeshIds(doc, 5, 1));
  const unrelated = doc.quadIds[q],
    loose = doc.vertexIds[start + 4];
  doc.quadTex = { [q]: 'other/snow.png' };
  doc.quadPaint = { [q]: 2 };
  doc.quadOrient = { [q]: { rot: 2, mirror: true } };
  doc.quadLabels = { [q]: ['finish'] };
  doc.quadLocked = { [q]: true };
  doc.edgeLocked = { [`${start},${start + 1}`]: true };
  doc.edgeHandles![`${start}>${start + 1}`] = [1, 2, 3];
  doc.quadTwist![q] = [
    [1, 2, 3],
    [4, 5, 6],
    [0, 1, 0],
    [2, 0, 1],
  ];
  const points = (mesh: QuadMeshDoc) =>
    meshControlPoints(mesh)
      .filter(p =>
        p.id.kind === 'twist'
          ? p.id.quad === unrelated
          : doc.vertexIds.slice(start).includes(p.id.kind === 'vertex' ? p.id.vertex : p.id.from),
      )
      .map(p => [controlPointKey(p.id), p.pos]);
  const before = points(doc),
    original = structuredClone(doc);
  const result = rebuildLoftSurface(doc, { ...loft, patchSizeM: 6 });
  assert(result.ok);
  assert.deepEqual(doc, original, 'rebuild does not mutate unrelated input channels');
  assert.deepEqual(points(result.doc), before);
  assert(result.doc.vertexIds.includes(loose), 'unrelated loose point survives');
  const at = result.doc.quadIds.indexOf(unrelated);
  for (const field of ['quadTex', 'quadPaint', 'quadOrient', 'quadLabels', 'quadLocked', 'quadTwist'] as const)
    assert.deepEqual(result.doc[field]?.[at], doc[field]?.[q], field);
  const a = result.doc.vertexIds.indexOf(doc.vertexIds[start]);
  const b = result.doc.vertexIds.indexOf(doc.vertexIds[start + 1]);
  assert(result.doc.edgeLocked?.[`${Math.min(a, b)},${Math.max(a, b)}`]);
}
{
  const { doc, loft } = create();
  const original = JSON.stringify(doc);
  assert(!rebuildLoftSurface(doc, { ...loft, patchSizeM: NaN }).ok);
  assert(!rebuildLoftSurface(doc, { ...loft, profiles: [['missing', 'gone'], loft.profiles[1]] }).ok);
  assert.equal(JSON.stringify(doc), original, 'invalid history cannot partially mutate the mesh');
  doc.quadLocked = { [doc.quadIds.indexOf(loft.patches[0].quad)]: true };
  assert(!rebuildLoftSurface(doc, loft).ok, 'explicit user locks are respected');
}
{
  const { doc, loft } = create();
  const changed = structuredClone(doc);
  changed.freeEdges!.shift();
  const held = refreshLoftSurfaces(changed);
  assert.match(held.lofts![0].error!, /source profile lost an edge/);
  assert.deepEqual(held.quads, doc.quads, 'a missing source leaves the last valid terrain intact');
  const attached = structuredClone(doc);
  const vertex = attached.vertexIds.indexOf(loft.vertices[0]);
  attached.freeEdges!.push([vertex, 0]);
  const result = rebuildLoftSurface(attached, loft);
  assert(!result.ok && /attached/.test(result.error), 'attached geometry cannot be discarded by resampling');
}

{
  const { doc, loft } = create();
  const changed = structuredClone(doc);
  changed.quads.shift();
  changed.quadIds.shift();
  const held = refreshLoftSurfaces(changed);
  assert.match(held.lofts![0].error!, /removed/);
  assert.equal(held.quads.length, changed.quads.length, 'deleted output is never resurrected');
  assert.equal(refreshLoftSurfaces(held), held, 'paused history is idempotent');
  const locked = structuredClone(doc),
    q = locked.quads[locked.quadIds.indexOf(loft.patches[0].quad)];
  locked.edgeLocked = { [`${Math.min(q[0], q[1])},${Math.max(q[0], q[1])}`]: true };
  assert(!rebuildLoftSurface(locked, loft).ok, 'explicit edge locks are respected');
  const raw = JSON.parse(JSON.stringify(serializeMountain(doc)));
  raw.lofts = [null, { id: 'bad' }];
  assert(!migrateMountain(raw).lofts, 'malformed history cannot break an otherwise valid terrain file');
}

console.log(
  'loft surface: creation, exact density changes, sculpt retention, profile history, persistence, registers and bake passed',
);
