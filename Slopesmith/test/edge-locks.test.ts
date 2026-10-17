// tier: fast
/**
 * Headless checks for EDGE locks (core/mesh/locks.ts): one curve frozen on its own while the patches either side
 * stay editable — the lock itself, what it holds, how it survives saving, the register model and every topology
 * operation, and what a Delete or an Unlock of a selection does to it.
 * Run: `npx tsx test/edge-locks.test.ts`
 */
import { applyBrush } from '../src/core/doc/mountain';
import { getVertex } from '../src/core/doc/doc-edit';
import { keyMountainByIndex, serializeMountain, edgeLockName } from '../src/core/doc/serialize';
import {
  applyRegisters,
  documentRegisters,
  edgeLockRegister,
  registerSection,
  registerShell,
  sectionRegisters,
  writeRegister,
} from '../src/core/doc/registers';
import { applyTopologyDelta, detachedDocument, topologyDelta } from '../src/core/doc/topology-delta';
import { changeSummary, describeChanges } from '../src/core/doc/compare';
import { cubicPoint } from '../src/core/math/bezier';
import { add } from '../src/core/math/vec';
import { copyMeshVertices, pasteMeshVertices } from '../src/core/mesh/clipboard';
import { meshControlPoints, moveMeshControlPoints, moveMeshVertices } from '../src/core/mesh/control-points';
import { createNetWatcher } from '../src/core/mesh/incremental';
import {
  edgeLockIsSet,
  edgeLocksTaken,
  lockedEdgeSet,
  lockedVertexSet,
  locksHolding,
  setEdgesLocked,
  setQuadsLocked,
} from '../src/core/mesh/locks';
import { applyLoopCut, applyMeshDelete, applyVertexWeld, meshContext, planLoopCut } from '../src/core/mesh/ops';
import { INDEX_NAMING } from '../src/core/mesh/selection';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { freshGrid } from './meshops.fixture';
import { check, failures } from './check';

/** A strip of three patches along x, rising and twisting so no handle is trivial. Interior edges: 2-3 and 4-5. */
function strip(): QuadMeshDoc {
  const heights = [0, 1, 3, 2, 5, 4, 2, 1];
  const vertices: number[] = [];
  for (let i = 0; i < 8; i++) vertices.push(10 * Math.floor(i / 2), heights[i], 10 * (i % 2));
  return {
    ...freshGrid(),
    vertices,
    quads: [
      [0, 1, 2, 3],
      [2, 3, 4, 5],
      [4, 5, 6, 7],
    ],
    vertexIds: Array.from({ length: 8 }, (_, i) => `strip-v${i}`),
    quadIds: ['strip-q0', 'strip-q1', 'strip-q2'],
    nextId: 11,
    edgeHandles: undefined,
    edgeLocked: undefined,
    quadPaint: undefined,
    quadTex: undefined,
    quadOrient: undefined,
    quadLocked: undefined,
    quadTwist: undefined,
    quadLabels: undefined,
    freeEdges: undefined,
    tJunctions: [],
    tombstones: undefined,
  };
}

const controls = (doc: QuadMeshDoc, quad: number) => {
  const { mesh, edgeHandle } = meshFromDoc(doc);
  return quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null);
};
/** The cubic a mesh edge traces, at t. */
const curvePoint = (doc: QuadMeshDoc, a: number, b: number, t: number): V3 => {
  const { edgeHandle } = meshFromDoc(doc),
    p0 = getVertex(doc, a),
    p3 = getVertex(doc, b);
  return cubicPoint(p0, add(p0, edgeHandle(a, b)), add(p3, edgeHandle(b, a)), p3, t);
};
const near = (a: V3, b: V3, eps = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps;
/** The locked edges by the names of their ends — what survives a renumbering. */
const lockNames = (doc: QuadMeshDoc) =>
  Object.keys(doc.edgeLocked ?? {})
    .map(key => {
      const [a, b] = key.split(',').map(Number);
      return [doc.vertexIds[a], doc.vertexIds[b]].sort().join('|');
    })
    .sort();
const lockedStrip = () => {
  const doc = strip();
  setEdgesLocked(doc, [[3, 2]], true);
  return doc;
};

// ---- the lock: one curve, shape-neutral, the patches beside it still editable ------------------------------
{
  const doc = strip(),
    before = [controls(doc, 0), controls(doc, 1)];
  check(
    setEdgesLocked(doc, [[3, 2]], true) === 1 && doc.edgeLocked?.['2,3'] === true,
    'edge lock: locking an edge stores it once, under its canonical key, whichever way it was named',
  );
  check(
    [...lockedVertexSet(doc)].sort().join(',') === '2,3' && [...lockedEdgeSet(doc)].join(';') === '2,3',
    'edge lock: it holds its two corners and its own curve — nothing else',
  );
  check(
    JSON.stringify([controls(doc, 0), controls(doc, 1)]) === JSON.stringify(before) &&
      doc.edgeHandles?.['2>3'] !== undefined &&
      doc.edgeHandles?.['3>2'] !== undefined,
    "edge lock: locking is shape-neutral and pins both of the edge's effective handles",
  );
  check(
    setEdgesLocked(doc, [[2, 3]], true) === 0 && setEdgesLocked(doc, [[0, 3]], true) === 0,
    'edge lock: an edge already locked, or a pair the mesh has no edge between, locks nothing',
  );

  const curve = [0.25, 0.5, 0.75].map(t => curvePoint(doc, 2, 3, t));
  const moved = moveMeshVertices(doc, [0, 1, 2, 3, 4, 5, 6, 7], [0, 6, 0]);
  check(
    moved.vertices.join(',') === '0,1,4,5,6,7' && near(getVertex(doc, 0), [0, 6, 0]),
    'edge lock: a group move leaves the locked corners and moves every other corner, both neighbours included',
  );
  check(
    [0.25, 0.5, 0.75].every((t, i) => near(curvePoint(doc, 2, 3, t), curve[i])),
    'edge lock: moving both neighbouring patches cannot reshape the locked curve',
  );

  const tangents = meshControlPoints(doc)
    .filter(
      cp => cp.id.kind === 'edge' && [cp.id.from, cp.id.to].sort().join() === ['strip-v2', 'strip-v3'].sort().join(),
    )
    .map(cp => cp.id);
  const free = meshControlPoints(doc)
    .filter(cp => cp.id.kind === 'twist' && cp.id.quad === 'strip-q0')
    .map(cp => cp.id);
  check(
    tangents.length === 2 && moveMeshControlPoints(doc, tangents, [1, 2, 3]) === 0,
    'edge lock: both tangent handles of the locked edge refuse a drag',
  );
  check(
    moveMeshControlPoints(doc, free, [0, 1, 0]) === free.length,
    'edge lock: the interiors of the patches beside it still move — they are not locked',
  );

  const brushed = lockedStrip(),
    lip = [0.3, 0.6].map(t => curvePoint(brushed, 2, 3, t)),
    far = getVertex(brushed, 6)[1];
  applyBrush(brushed, 'raise', [15, 0, 5], 40, 2, 1, 'constant');
  check(
    lip.every((p, i) => near(curvePoint(brushed, 2, 3, [0.3, 0.6][i]), p)) && getVertex(brushed, 6)[1] > far,
    'edge lock: a sculpt stroke across the edge leaves the curve exact and raises the terrain around it',
  );

  check(
    setEdgesLocked(doc, [[2, 3]], false) === 1 && doc.edgeLocked === undefined && lockedVertexSet(doc).size === 0,
    'edge lock: unlocking clears the channel; the captured handles stay, so the shape does not move',
  );
}

// ---- unlock-all: the locks holding a selection -------------------------------------------------------------
{
  const doc = lockedStrip();
  setQuadsLocked(doc, [2], true);
  const held = (selection: Parameters<typeof locksHolding>[1]) => {
    const found = locksHolding(doc, selection);
    return `${found.quads.join(',')}|${found.edges.map(edge => edge.join('-')).join(',')}`;
  };
  check(held({ vertices: [3] }) === '|2-3', 'unlock: a selected corner is held by the edge lock that ends there');
  check(held({ vertices: [5] }) === '2|', 'unlock: a selected corner of a locked patch is held by that patch');
  check(held({ edges: [[5, 4]] }) === '2|', 'unlock: a selected edge of a locked patch is held by the patch');
  check(
    held({ quads: [1] }) === '|',
    "unlock: a patch held only along its borders by its neighbours' locks is not itself locked",
  );
  check(
    held({ vertices: [2], edges: [[4, 5]], quads: [2] }) === '2|2-3',
    'unlock: a mixed selection gathers every lock holding any of it, once',
  );
}

// ---- Delete / Dissolve refuse to take a locked edge --------------------------------------------------------
{
  const doc = lockedStrip();
  check(
    edgeLocksTaken(doc, {}, [0]).length === 0,
    'delete: removing the patch on one side leaves the locked edge standing on the other',
  );
  check(edgeLocksTaken(doc, {}, [0, 1]).length === 1, 'delete: removing both patches beside it would take the lock');
  check(
    edgeLocksTaken(doc, { vertices: [2] }).length === 1 && edgeLocksTaken(doc, { edges: [[3, 2]] }).length === 1,
    'delete / dissolve: naming the edge or a corner of it would take the lock',
  );
}

// ---- topology operations carry the lock by the names of its ends -------------------------------------------
{
  const doc = lockedStrip();
  const deleted = applyMeshDelete(doc, { vertices: [], edges: [], quads: [0] });
  check(
    deleted.ok && lockNames(deleted.doc).join() === 'strip-v2|strip-v3' && deleted.doc.edgeLocked?.['0,1'] === true,
    'ops: a delete that renumbers the corners carries the lock onto the same two corners',
  );

  const { mesh, adj } = meshContext(doc);
  const before = [0.25, 0.75].map(t => curvePoint(doc, 2, 3, t));
  const cut = applyLoopCut(doc, planLoopCut(mesh, adj, 0, [0, 1]), 0.5);
  if (!cut.ok) check(false, 'ops: a loop cut across the locked edge is accepted');
  else {
    const out = cut.doc,
      at = (name: string) => out.vertexIds.indexOf(name);
    const v2 = at('strip-v2'),
      v3 = at('strip-v3');
    const mid = out.quads
      .flat()
      .find(v => !out.vertexIds[v].startsWith('strip-') && edgeLockIsSet(out, v2, v) && edgeLockIsSet(out, v, v3));
    check(
      mid !== undefined && !edgeLockIsSet(out, v2, v3) && Object.keys(out.edgeLocked ?? {}).length === 2,
      'ops: a loop cut splits the locked edge into two locked halves through the new corner',
    );
    check(
      mid !== undefined &&
        near(curvePoint(out, v2, mid, 0.5), before[0]) &&
        near(curvePoint(out, mid, v3, 0.5), before[1]),
      'ops: the halves trace the locked curve exactly (de Casteljau, not the smoothed default)',
    );
  }

  const twin = lockedStrip();
  twin.vertices.push(...getVertex(twin, 3));
  twin.vertexIds.push('strip-v8');
  const welded = applyVertexWeld(twin, [[3, 8]]);
  check(
    welded.ok && lockNames(welded.doc).join() === 'strip-v2|strip-v8',
    'ops: welding a locked corner into another point moves the lock onto the survivor',
  );
}

// ---- saving, registers, sync -------------------------------------------------------------------------------
{
  const doc = lockedStrip();
  const stored = serializeMountain(doc);
  check(
    JSON.stringify(stored.edgeLocked) === JSON.stringify({ [edgeLockName('strip-v2', 'strip-v3')]: true }),
    'save: an edge lock is stored by the stable ids of both ends',
  );
  const loaded = structuredClone(stored) as unknown as QuadMeshDoc;
  keyMountainByIndex(loaded);
  check(
    JSON.stringify(loaded.edgeLocked) === JSON.stringify({ '2,3': true }),
    'load: the lock comes back on the same edge',
  );

  const key = edgeLockRegister('strip-v3', 'strip-v2');
  const registers = documentRegisters(doc);
  check(
    key === edgeLockRegister('strip-v2', 'strip-v3') && registers.get(key) === true,
    'registers: an edge lock is one register, named the same whichever end comes first',
  );
  const section = registerSection(doc, key);
  check(
    section !== null && sectionRegisters(doc, section).get(key) === true,
    'registers: the lock hashes in the section that re-reads it',
  );
  const shell = registerShell(doc);
  applyRegisters(shell, registers);
  check(
    JSON.stringify(shell.edgeLocked) === JSON.stringify(doc.edgeLocked),
    'registers: a full resync rebuilds the lock',
  );
  const remote = strip();
  check(
    writeRegister(remote, key, 'yes') === 'refused' &&
      writeRegister(remote, key, true) === 'landed' &&
      remote.edgeLocked?.['2,3'] === true &&
      writeRegister(remote, key, undefined) === 'landed' &&
      !remote.edgeLocked?.['2,3'],
    'registers: a lock register holds true or nothing, and lands on the edge it names',
  );

  const summary = changeSummary(strip(), doc);
  check(
    summary.edgeLocks.added === 1 && describeChanges(summary).includes('1 edge locked'),
    'compare: a checkpoint diff reports the edge lock',
  );

  const deleted = applyMeshDelete(doc, { vertices: [], edges: [], quads: [0] });
  if (deleted.ok) {
    const applied = applyTopologyDelta(detachedDocument(doc), topologyDelta(doc, deleted.doc));
    check(
      applied.ok && JSON.stringify(applied.applied.doc.edgeLocked) === JSON.stringify(deleted.doc.edgeLocked),
      'sync: a topology delta carries the lock onto the renumbered corners on every replica',
    );
  }
  const gone = applyMeshDelete(doc, { vertices: [], edges: [], quads: [0, 1] });
  if (gone.ok) {
    const applied = applyTopologyDelta(detachedDocument(doc), topologyDelta(doc, gone.doc));
    check(
      applied.ok && !applied.applied.doc.edgeLocked && applied.applied.cleared.includes(key),
      'sync: a delta that removes the edge clears its lock register',
    );
  }

  const watcher = createNetWatcher();
  const plain = strip();
  watcher.note(plain);
  check(watcher.note(lockedStrip()).kind === 'whole', 'preview: an edge lock rebuilds the cage so the edge draws red');
}

// ---- clipboard ---------------------------------------------------------------------------------------------
{
  const doc = lockedStrip(),
    { mesh, edgeHandle } = meshFromDoc(doc);
  const clip = copyMeshVertices({
    mesh,
    naming: INDEX_NAMING,
    selectedVertices: [0, 1, 2, 3, 4, 5],
    edgeHandle,
    edgeLocked: (a, b) => edgeLockIsSet(doc, a, b),
  });
  check(
    clip?.quads.length === 2 && JSON.stringify(clip.edgeLocked) === JSON.stringify({ '2,3': true }),
    'clipboard: copying the patches either side of a locked edge copies the lock',
  );
  if (clip) {
    const pasted = pasteMeshVertices(strip(), clip, [0, 0, 50]);
    check(pasted.doc.edgeLocked?.['10,11'] === true, 'clipboard: the pasted copy carries its own lock');
  }
}

if (failures) process.exitCode = 1;
