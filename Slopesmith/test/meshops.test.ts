/**
 * Headless checks for the topology-surgery core (src/core/mesh/ops/index.ts, docs/017): the shared op
 * plumbing (`remapIds` compaction, stable identity, the storage boundary and its tombstones), the loop-cut
 * op, the selection foundation it feeds, and the de Casteljau splits the slides are built on.
 * Run: `npx tsx test/meshops.test.ts`
 *
 * Asserts the doc's own regression checks: a loop cut on a promoted grid IS a whole row / column insert
 * (strip runs rim to rim), the derived mesh stays watertight with no NaN, every painted survivor is
 * preserved across the split, `remapIds` is an identity with no deletions and compacts cleanly with one,
 * and two cuts compose.
 *
 * The rest of the family lives beside this file and shares test/meshops.fixture.ts:
 * meshops-create (patches / edges / extrusions / rip / weld), meshops-edit (control points, locks,
 * delete, dissolve, clipboard), meshops-slide + meshops-slide-gesture (the geometry-preserving slides
 * and their gesture planner) and meshops-loft (flip, loft, authored polygon models).
 */
import { deriveQuadMesh, meshCreaseVertices, meshResetShape, meshSetHandle, meshSetTwist, meshSmoothVertices, meshVertexCanSmooth, migrateMountain } from '../src/core/doc/mountain';
import { meshFromDoc, quadControlPoints, INTERIOR_CP, buildQuadMesh, meshAdjacency, meshEdgeHandles, meshCageEdges } from '../src/core/mesh/topology';
import { patchPoint, patchNormal, cubicPoint, splitCubic, splitPatchU, splitPatchV } from '../src/core/math/bezier';
import { add, cross, dot, len, norm, sub } from '../src/core/math/vec';
import { planLoopCut, applyLoopCut, remapIds, locateVertex, hoveredEdge, meshContext, applyCellEdgeInsert, appendStandalonePatch, applyMeshDelete, checkManifold, ekey } from '../src/core/mesh/ops';
import { getVertex } from '../src/core/doc/doc-edit';
import { serializeMountain } from '../src/core/doc/serialize';
import { INDEX_NAMING, meshPoleIndices, meshPoles, meshEdgeLoop, meshEdgeSegments, resolveEdgeSelection, resolveVertexSelection, resolveCellSelection } from '../src/core/mesh/selection';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { findTJunctions } from '../src/core/mesh/t-junctions';
import { findCoincidentVertices } from '../src/core/mesh/coincident-vertices';
import { watertight, hasNaN, grid, GRID_COLS, freshGrid, cellRows, cellCols, V0, Q0 } from './meshops.fixture';
import { check, failures } from './check';

// ---- 1. COLUMN insert: cut quad 0 across its top edge [0,1] (runs down u = one whole column) ---------------
{
  const doc = freshGrid();
  const { mesh, adj } = meshContext(doc);
  const plan = planLoopCut(mesh, adj, 0, [0, 1]);
  check(plan.poleStops.length === 0 && !plan.closed, 'column cut: no pole stop, not a ring');
  check(plan.rimStops.length === 2, `column cut: runs rim to rim (2 rim stops, got ${plan.rimStops.length})`);
  check(plan.splits.length === cellRows, `column cut: splits one whole column (${cellRows}, got ${plan.splits.length})`);
  check(plan.cutEdges.length === cellRows + 1, `column cut: one cut edge per row boundary (${cellRows + 1}, got ${plan.cutEdges.length})`);
  const r = applyLoopCut(doc, plan, 0.5);
  check(r.ok, 'column cut: commit accepted');
  if (r.ok) {
    check(r.doc.quads.length === Q0 + cellRows, `column cut: +${cellRows} quads (${r.doc.quads.length})`);
    check(r.doc.vertices.length / 3 === V0 + cellRows + 1, `column cut: +${cellRows + 1} vertices (${r.doc.vertices.length / 3})`);
    const wt = watertight(r.doc);
    check(wt.ok, `column cut: watertight (no 3+ edges; over=${wt.over})`);
    check(!hasNaN(r.doc), 'column cut: no NaN vertices');
    // original corners are untouched (loop cut only appends; ids stable)
    const same = doc.vertices.every((v, i) => v === r.doc.vertices[i]);
    check(same, 'column cut: original vertex positions unchanged');
    // the derived quilt still tessellates without NaN
    const pv = buildMountainPreview(r.doc);
    check(!pv.positions.some(x => !Number.isFinite(x)), 'column cut: derived quilt has no NaN');
  }
}

// ---- 2. ROW insert: cut quad 0 across its left edge [0, cols] (runs across v = one whole row) --------------
{
  const doc = freshGrid();
  const { mesh, adj } = meshContext(doc);
  const plan = planLoopCut(mesh, adj, 0, [0, GRID_COLS]);
  check(plan.splits.length === cellCols, `row cut: splits one whole row (${cellCols}, got ${plan.splits.length})`);
  check(plan.rimStops.length === 2 && !plan.closed, 'row cut: runs rim to rim');
  const r = applyLoopCut(doc, plan, 0.5);
  check(r.ok && r.doc.quads.length === Q0 + cellCols, 'row cut: +cellCols quads, committed');
}

// ---- 3. hoveredEdge picks a real perimeter edge of the quad -----------------------------------------------
{
  const doc = freshGrid();
  const { mesh } = meshContext(doc);
  const [A, B, C, D] = doc.quads[0];
  const mid = (i: number, j: number): [number, number, number] => [
    (doc.vertices[i * 3] + doc.vertices[j * 3]) / 2,
    (doc.vertices[i * 3 + 1] + doc.vertices[j * 3 + 1]) / 2,
    (doc.vertices[i * 3 + 2] + doc.vertices[j * 3 + 2]) / 2,
  ];
  const e = hoveredEdge(mesh, 0, mid(A, B)); // a point on the A-B edge should pick the A-B edge
  check(ekey(e[0], e[1]) === ekey(A, B), `hoveredEdge near A-B picks A-B (got ${e})`);
  const e2 = hoveredEdge(mesh, 0, mid(C, D));
  check(ekey(e2[0], e2[1]) === ekey(C, D), `hoveredEdge near C-D picks C-D (got ${e2})`);
  void D;
}

// ---- 4. paint on a cut quad is inherited by both halves ---------------------------------------------------
{
  const doc = freshGrid();
  doc.quadPaint = { 0: 5 }; // ice on quad 0
  doc.quadTex = { 0: 'DONOR/0019.png' };
  const { mesh, adj } = meshContext(doc);
  const plan = planLoopCut(mesh, adj, 0, [0, 1]);
  const r = applyLoopCut(doc, plan, 0.5);
  check(r.ok, 'paint: cut committed');
  if (r.ok) {
    // quad 0 stays the first half; the appended half is the last quad (indices stable, no deletions)
    const halfA = 0, halfB = r.doc.quads.length - cellRows; // second half of quad 0 = first appended split
    check(r.doc.quadPaint?.[halfA] === 5, 'paint: first half keeps SurfaceType');
    check(r.doc.quadPaint?.[halfB] === 5, 'paint: second half inherits SurfaceType');
    check(r.doc.quadTex?.[halfA] === 'DONOR/0019.png' && r.doc.quadTex?.[halfB] === 'DONOR/0019.png', 'paint: both halves keep the tile');
  }
}

// ---- 5. remapIds — identity with no deletions, compaction with one ----------------------------------------
{
  const doc = freshGrid();
  const idn = remapIds({ vertices: doc.vertices.slice(), quads: doc.quads.map(q => q.slice()) });
  check(idn.vertices.length === doc.vertices.length && idn.quads.length === doc.quads.length
    && idn.quads.every((q, i) => q.every((v, j) => v === doc.quads[i][j])), 'remapIds: identity with no deletions');

  // delete quad 0 → its exclusive corner (vertex 0, a grid corner touched only by quad 0) is pruned, ids shift
  const quads = doc.quads.map(q => q.slice()) as (number[] | null)[];
  quads[0] = null;
  const before = doc.vertices.length / 3;
  const cut = remapIds({
    vertices: doc.vertices.slice(), quads, freeEdges: [[1, before - 1]], quadPaint: { 5: 9 },
    quadLocked: { 5: true },
    edgeHandles: { '0>1': [1, 0, 0], [`1>${before - 1}`]: [2, 0, 0] },
    tJunctions: [{ vertex: 2, edge: [1, GRID_COLS + 1], t: 0.4 }],
  });
  check(cut.quads.length === doc.quads.length - 1, 'remapIds: one quad dropped');
  check(cut.vertices.length / 3 === before - 1, 'remapIds: the corner used only by the dropped quad is pruned');
  check(cut.quadPaint?.[4] === 9 && cut.quadPaint?.[5] === undefined, 'remapIds: quad-keyed paint follows the id shift');
  check(cut.quadLocked?.[4] === true && cut.quadLocked?.[5] === undefined,
    'remapIds: patch protection follows the same surviving patch through compaction');
  check(cut.edgeHandles?.['0>1'] === undefined, 'remapIds: an edge handle on a pruned vertex is dropped');
  check(JSON.stringify(cut.freeEdges) === JSON.stringify([[0, before - 2]])
    && cut.edgeHandles?.[`0>${before - 2}`]?.[0] === 2,
    'remapIds: a surviving free edge and its handle follow compacted vertex ids');
  check(cut.tJunctions?.length === 1 && cut.tJunctions[0].vertex === 1
    && ekey(...cut.tJunctions[0].edge) === ekey(0, GRID_COLS) && cut.tJunctions[0].t === 0.4,
    'remapIds: an explicit T-node follows compacted vertex and host-edge ids');
  check(cut.rawVertexIds[0] === undefined && cut.vertexMap.get(cut.rawVertexIds[1]!) === 0
    && cut.vertexMap.size === cut.vertices.length / 3,
    'remapIds: the compaction answers by NAME — one for every survivor, none for the pruned corner');
  check(locateVertex(cut, 1) === 0 && locateVertex(cut, 0) === undefined,
    'remapIds: ...so a point the op named before compaction is found again by that name, or not at all');
}

// ---- 5a. a crease survives an unrelated deletion BYTE-IDENTICALLY -----------------------------------------
// `edgeHandles` is keyed by vertex INDEX at both ends and read by regex in two places (ops/contract.ts
// `remapIds`, doc/mountain.ts `relaxSmoothDetail`), each of which skips a key it cannot parse. A key those two
// stop matching raises nothing: the edge falls back to its Bessel default and the terrain quietly changes
// shape. So the crease is pinned here against the one thing that renumbers the world beneath it — a topology
// edit somewhere else entirely (docs/039).
{
  const doc = freshGrid();
  const creased = 3 * GRID_COLS + 5;                    // interior, nowhere near the patch the delete removes
  meshCreaseVertices(doc, [creased]);
  const before = meshContext(doc);
  const ring = before.adj.neighbors[creased].slice().sort((a, b) => a - b);
  const creasedId = doc.vertexIds[creased], ringIds = ring.map(nb => doc.vertexIds[nb]);
  const storedBefore = JSON.stringify(ring.map(nb => doc.edgeHandles![`${creased}>${nb}`]));
  const effectiveBefore = JSON.stringify(ring.map(nb => before.edgeHandle(creased, nb)));
  const positionBefore = JSON.stringify(getVertex(doc, creased));
  const handlesBefore = Object.keys(doc.edgeHandles ?? {}).length;

  // quad 0 owns grid corner 0 alone, so deleting it prunes that corner and shifts every index above it
  const deleted = applyMeshDelete(doc, { quads: [0] });
  check(deleted.ok, 'crease tripwire: the unrelated patch deletes');
  if (deleted.ok) {
    const out = deleted.doc, now = out.vertexIds.indexOf(creasedId);
    const movedRing = ringIds.map(id => out.vertexIds.indexOf(id));
    check(now === creased - 1 && movedRing.every((nb, i) => nb === ring[i] - 1),
      'crease tripwire: the creased point and its ring kept their ids while every index shifted');
    check(JSON.stringify(getVertex(out, now)) === positionBefore, 'crease tripwire: the creased point did not move');
    check(JSON.stringify(movedRing.map(nb => out.edgeHandles?.[`${now}>${nb}`])) === storedBefore,
      'crease tripwire: every stored crease offset came back byte-identical');
    const after = meshContext(out);
    check(JSON.stringify(movedRing.map(nb => after.edgeHandle(now, nb))) === effectiveBefore,
      'crease tripwire: and so did every EFFECTIVE handle the quilt derives from it');
    check(Object.keys(out.edgeHandles ?? {}).length === handlesBefore,
      `crease tripwire: the rewrite lost no handle key (${handlesBefore})`);
  }
}

// ---- 5b. stable identity: minted once, carried through every rewrite --------------------------------------
{
  const doc = freshGrid();
  const names = new Set([...doc.vertexIds, ...doc.quadIds]);
  check(doc.vertexIds.length === doc.vertices.length / 3 && doc.quadIds.length === doc.quads.length
    && names.size === doc.vertexIds.length + doc.quadIds.length && doc.nextId === names.size,
    'ids: a promoted lattice names every vertex and quad exactly once, with the counter past the last');

  const appended = appendStandalonePatch(doc, [12, 34, 56], [0, 1, 0]);
  check(appended.doc.vertexIds.slice(0, V0).join() === doc.vertexIds.join()
    && appended.doc.quadIds.slice(0, Q0).join() === doc.quadIds.join()
    && appended.doc.vertexIds.length === V0 + 4 && appended.doc.quadIds.length === Q0 + 1
    && appended.doc.nextId === doc.nextId + 5,
    'ids: an append leaves every existing name alone and mints one per created vertex and quad');

  const { mesh, adj } = meshContext(doc);
  const cut = applyLoopCut(doc, planLoopCut(mesh, adj, 0, [0, 1]), 0.4);
  check(cut.ok && cut.doc.vertexIds.slice(0, V0).join() === doc.vertexIds.join()
    && cut.doc.quadIds.slice(0, Q0).join() === doc.quadIds.join()
    && cut.doc.vertexIds.length === cut.doc.vertices.length / 3
    && cut.doc.quadIds.length === cut.doc.quads.length,
    'ids: a loop cut keeps every survivor\'s name and stays index-parallel with the geometry');
  check(cut.ok && new Set([...cut.doc.vertexIds, ...cut.doc.quadIds]).size
    === cut.doc.vertexIds.length + cut.doc.quadIds.length,
    'ids: ...and the geometry the cut created is named fresh, never a reused string');

  const trimmed = applyMeshDelete(doc, { quads: [0] });
  check(trimmed.ok && trimmed.doc.vertexIds.join() === doc.vertexIds.slice(1).join()
    && trimmed.doc.quadIds.join() === doc.quadIds.slice(1).join(),
    'ids: compaction moves a name to its new index rather than renaming what it finds there');

  // a save below version 5 carries no identity at all: the migration names the whole mesh once, in index order
  const idless = structuredClone(grid) as unknown as Record<string, unknown>;
  delete idless.vertexIds; delete idless.quadIds; delete idless.nextId;
  idless.version = 4;
  (idless as unknown as QuadMeshDoc).edgeHandles = { '0>1': [1, 0, 0], '1>0': [-1, 0, 0] };
  const named = migrateMountain(idless);
  check(named.version === 5 && named.vertexIds.length === V0 && named.quadIds.length === Q0
    && named.vertexIds[0] === 'local:0' && named.quadIds[0] === `local:${V0}` && named.nextId === V0 + Q0,
    'migrate: a document below version 5 is named once, vertices then quads, in index order');
  check(Object.keys(named.edgeHandles ?? {}).length === 2,
    'migrate: naming a document carries its edge handles through by count');
  const again = migrateMountain(structuredClone(named));
  check(again.vertexIds.join() === named.vertexIds.join() && again.quadIds.join() === named.quadIds.join()
    && again.nextId === named.nextId,
    'migrate: a document that already carries identity is never renamed');
}

// ---- 5c. the storage boundary: a name on disk, an index in memory -----------------------------------------
// A document keyed by index on disk is one topology edit away from being wrong: delete a patch, and every
// paint, tile, twist and crease key above it names different geometry when the file is read back. So the
// boundary re-keys — and the round trip that matters is not save/load, it is save, TOPOLOGY EDIT, save, load
// (docs/039). The tripwire below saves a creased mountain, deletes a patch beneath the crease so every index
// shifts, saves again, and demands the crease's key on disk did not move and its offsets came back
// byte-identical.
{
  const creased = 3 * GRID_COLS + 5;
  const authored = freshGrid();
  meshCreaseVertices(authored, [creased]);
  authored.quadPaint = { 7: 5, [Q0 - 1]: 9 };
  authored.quadTex = { 7: 'DONOR/0019.png' };
  authored.quadOrient = { 7: { rot: 2, mirror: true } };
  authored.quadTwist = { 7: [[0, 1, 0], [0, 0, 0], [0, 0, 0], [0, 2, 0]] };
  authored.freeEdges = [[1, V0 - 1]];
  authored.tJunctions = [{ vertex: 2 * GRID_COLS + 3, edge: [10 * GRID_COLS + 2, 10 * GRID_COLS + 3], t: 0.4 }];
  const doc = migrateMountain(authored); // the form the editor holds: every channel keyed by index

  const channels = (d: QuadMeshDoc) => ({
    handles: Object.keys(d.edgeHandles ?? {}).length, paint: Object.keys(d.quadPaint ?? {}).length,
    tex: Object.keys(d.quadTex ?? {}).length, orient: Object.keys(d.quadOrient ?? {}).length,
    twist: Object.keys(d.quadTwist ?? {}).length, free: (d.freeEdges ?? []).length,
    tj: (d.tJunctions ?? []).length,
  });
  const before = channels(doc);
  const ring = meshContext(doc).adj.neighbors[creased].slice().sort((a, b) => a - b);
  const creasedId = doc.vertexIds[creased], ringIds = ring.map(nb => doc.vertexIds[nb]);
  const creaseOffsets = JSON.stringify(ring.map(nb => doc.edgeHandles![`${creased}>${nb}`]));

  const stored = serializeMountain(doc);
  check(stored.keying === 'id' && Object.keys(stored.edgeHandles ?? {}).length === before.handles
    && Object.keys(stored.quadPaint ?? {}).length === before.paint,
    `store: every keyed channel is written by name, none of it lost (${before.handles} creases)`);
  const names = new Set(doc.vertexIds);
  check(Object.keys(stored.edgeHandles ?? {}).every(key => {
    const ends = key.split('>');
    return ends.length === 2 && ends.every(end => names.has(end));
  }) && stored.edgeHandles?.[`${creasedId}>${ringIds[0]}`] !== undefined,
    'store: both ends of every crease key are vertex names, not indices');
  check(stored.quadPaint?.[doc.quadIds[7]] === 5 && stored.quadTex?.[doc.quadIds[7]] === 'DONOR/0019.png'
    && stored.quadOrient?.[doc.quadIds[7]]?.rot === 2 && stored.quadTwist?.[doc.quadIds[7]]?.[3][1] === 2
    && stored.freeEdges?.[0][0] === doc.vertexIds[1]
    && stored.tJunctions?.[0].vertex === doc.vertexIds[2 * GRID_COLS + 3],
    'store: paint, tile, orientation, twist, free edges and T-nodes are all written by name');
  check(JSON.stringify(migrateMountain(structuredClone(stored))) === JSON.stringify(doc),
    'store: the document read back is byte-identical to the one written');

  // the whole point: a topology edit BETWEEN two saves must not move what the first one wrote
  const storedKeys = JSON.stringify(Object.keys(stored.edgeHandles ?? {}).sort());
  const trimmed = applyMeshDelete(doc, { quads: [0] }); // prunes vertex 0, shifting every index above it
  check(trimmed.ok, 'store: the unrelated patch deletes');
  if (trimmed.ok) {
    const edited = trimmed.doc, moved = edited.vertexIds.indexOf(creasedId);
    const movedRing = ringIds.map(id => edited.vertexIds.indexOf(id));
    const after = serializeMountain(edited);
    check(JSON.stringify(Object.keys(after.edgeHandles ?? {}).sort()) === storedKeys,
      'store: ...so every crease key on disk is the same key it was before the delete');
    check(moved === creased - 1 && JSON.stringify(movedRing.map(nb => edited.edgeHandles![`${moved}>${nb}`]))
      === creaseOffsets, 'store: ...while in memory the same crease moved down an index');

    const reopened = migrateMountain(structuredClone(after));
    const now = reopened.vertexIds.indexOf(creasedId);
    check(JSON.stringify(ringIds.map(id => reopened.edgeHandles![`${now}>${reopened.vertexIds.indexOf(id)}`]))
      === creaseOffsets, 'reopen: every crease offset came back byte-identical through the topology edit');
    const held = channels(reopened);
    check(held.handles === before.handles && held.paint === before.paint && held.tex === before.tex
      && held.orient === before.orient && held.twist === before.twist && held.free === before.free
      && held.tj === before.tj,
      `reopen: paint ${held.paint}, tiles ${held.tex}, orientation ${held.orient}, twist ${held.twist}, `
      + `free edges ${held.free} and T-nodes ${held.tj} all survived with the ${held.handles} creases`);
    check(reopened.quadPaint?.[6] === 5 && reopened.quadTex?.[6] === 'DONOR/0019.png'
      && reopened.quadOrient?.[6]?.rot === 2 && reopened.quadTwist?.[6]?.[3][1] === 2,
      'reopen: ...and each one landed back on the patch it was painted on, one index lower');
    check(JSON.stringify(reopened) === JSON.stringify(edited),
      'reopen: the whole document read back is byte-identical to the edited one');
  }

  // the editor posts the document it holds, keyed by index and carrying no name marker; reading that as names
  // would turn every index into a name it cannot find, so an unmarked document is read exactly as written
  const posted = migrateMountain(structuredClone(doc));
  check(JSON.stringify(posted) === JSON.stringify(doc),
    'store: a document with no name marker is read as the index-keyed one it is');

  // an index that names no vertex has had no effect on the surface for as long as that was true — it is not a
  // crease, so storing it under an invented name would be inventing a crease
  const inert = migrateMountain(structuredClone(doc));
  inert.edgeHandles = { ...inert.edgeHandles, [`${V0 + 40}>${V0 + 41}`]: [1, 2, 3] };
  check(Object.keys(serializeMountain(inert).edgeHandles ?? {}).length === before.handles,
    'store: a crease on a vertex the mesh does not have is dead data, and is not stored');

  // and the direction that CAN lose a crease says so instead of shrugging
  const bent = structuredClone(stored) as unknown as { edgeHandles: Record<string, [number, number, number]> };
  bent.edgeHandles['local:99999>local:99998'] = [1, 2, 3];
  let refused = false;
  try { migrateMountain(bent); } catch { refused = true; }
  check(refused, 'reopen: a stored crease naming a vertex the document does not carry is refused, not skipped');
}

// ---- 5d. tombstones: what leaves is remembered, so what arrives for it later is discarded quietly ---------
// An id-addressed write can reach a document after the geometry it names has gone: a channel in a file saved
// before the delete, and in time an edit that was in flight during it. Without a record of what left there is
// no telling that from a name out of nowhere, and the choice is between resurrecting geometry and refusing a
// write that was merely late (docs/039).
{
  const doc = migrateMountain(freshGrid());
  check(doc.tombstones === undefined, 'tombstones: a document that has deleted nothing remembers nothing');
  meshCreaseVertices(doc, [0]);
  doc.quadPaint = { 0: 7 };
  const goneVertex = doc.vertexIds[0], goneQuad = doc.quadIds[0];

  const trimmed = applyMeshDelete(doc, { quads: [0] }); // takes quad 0 and the corner only it used
  check(trimmed.ok, 'tombstones: the patch deletes');
  if (trimmed.ok) {
    const edited = trimmed.doc;
    check(edited.tombstones?.includes(goneQuad) === true && edited.tombstones.includes(goneVertex),
      'tombstones: the deleted patch and the corner that went with it are retired by name');
    const live = new Set([...edited.vertexIds, ...edited.quadIds]);
    check(!edited.tombstones!.some(id => live.has(id)), 'tombstones: ...and nothing still in the mesh is retired');

    const late = serializeMountain(edited) as { edgeHandles?: Record<string, V3>; quadPaint?: Record<string, number> };
    late.edgeHandles = { ...late.edgeHandles, [`${goneVertex}>${edited.vertexIds[0]}`]: [1, 2, 3] };
    late.quadPaint = { ...late.quadPaint, [goneQuad]: 9 };
    const creases = Object.keys(edited.edgeHandles ?? {}).length;
    const reopened = migrateMountain(structuredClone(late));
    check(Object.keys(reopened.edgeHandles ?? {}).length === creases
      && Object.keys(reopened.quadPaint ?? {}).length === Object.keys(edited.quadPaint ?? {}).length,
      'tombstones: a crease and a paint naming retired geometry are discarded quietly, not resurrected');
    check(reopened.vertices.length === edited.vertices.length && reopened.quads.length === edited.quads.length,
      'tombstones: ...and the mesh they name is still gone');

    const nonsense = serializeMountain(edited) as { quadPaint?: Record<string, number> };
    nonsense.quadPaint = { ...nonsense.quadPaint, 'local:999999': 9 };
    let raised = false;
    try { migrateMountain(structuredClone(nonsense)); } catch { raised = true; }
    check(raised, 'tombstones: ...while a name this document never had still raises');
  }

  // a crease belongs to its EDGE, so a rewrite that dissolves the edge takes the crease with it even though
  // both its ends live on — the compaction reads creases off the topology, never off their keys
  const shaped = freshGrid();
  const a = 5 * GRID_COLS + 6, b = 6 * GRID_COLS + 6, keep = 5 * GRID_COLS + 5;
  shaped.edgeHandles = { [`${a}>${b}`]: [1, 0, 0], [`${keep}>${keep + 1}`]: [0, 0, 2] };
  const dissolved = applyMeshDelete(shaped, { quads: [5 * cellCols + 5, 5 * cellCols + 6] });
  check(dissolved.ok, 'crease by edge: the two patches sharing the creased edge delete');
  if (dissolved.ok) {
    const out = dissolved.doc, at = (v: number) => out.vertexIds.indexOf(shaped.vertexIds[v]);
    check(at(a) >= 0 && at(b) >= 0 && out.edgeHandles?.[`${at(a)}>${at(b)}`] === undefined,
      'crease by edge: both ends survive, and the crease on the edge between them does not');
    check(out.edgeHandles?.[`${at(keep)}>${at(keep + 1)}`]?.[2] === 2,
      'crease by edge: ...while the crease on an edge that is still there came through');
    // and the one it let go derived nothing: put it back and not one control point in the quilt moves
    const quilt = (d: QuadMeshDoc) => {
      const derived = deriveQuadMesh(d);
      return JSON.stringify(d.quads.map((_, q) =>
        quadControlPoints(derived.mesh, derived.edgeHandle, q, d.quadTwist?.[q] ?? null)));
    };
    const restored = structuredClone(out);
    (restored.edgeHandles ??= {})[`${at(a)}>${at(b)}`] = [1, 0, 0];
    check(quilt(restored) === quilt(out),
      'crease by edge: ...and the crease that went shaped nothing — putting it back moves no control point');
  }
}

// ---- 6. two cuts compose, still watertight ----------------------------------------------------------------
{
  let doc = freshGrid();
  for (const edge of [[0, 1], [0, GRID_COLS]] as [number, number][]) {
    const { mesh, adj } = meshContext(doc);
    const plan = planLoopCut(mesh, adj, 0, edge);
    const r = applyLoopCut(doc, plan, 0.4);
    if (!r.ok) { check(false, `compose: cut ${edge} rejected (${r.error})`); break; }
    doc = r.doc;
  }
  const wt = watertight(doc);
  check(wt.ok && !hasNaN(doc), 'compose: two cuts leave a watertight, finite mesh');
}

// ---- 7. selection foundation: pole classification on the promoted grid --------------------
{
  const doc = freshGrid();
  const { mesh } = meshContext(doc);
  // a promoted rectangular grid has NO extraordinary poles
  const poles = meshPoles(mesh);
  check(poles.extra3.length === 0 && poles.extra5.length === 0, 'poles: a promoted grid has no 3/5 poles');
}

// ---- 7b. extraordinary-pole smoothing: one shared tangent plane across an irregular fan -------------
{
  const source = freshGrid(), valence = 5, vertices: number[] = [0, 2, 0], quads: number[][] = [];
  for (let i = 0; i < valence; i++) {
    const angle = i * Math.PI * 2 / valence;
    vertices.push(Math.cos(angle) * 12, [3, -2, 4, -1, 2][i], Math.sin(angle) * 12);
  }
  for (let i = 0; i < valence; i++) {
    const angle = (i + 0.5) * Math.PI * 2 / valence;
    vertices.push(Math.cos(angle) * 21, [5, 0, 6, -3, 1][i], Math.sin(angle) * 21);
    quads.push([0, 1 + i, 1 + ((i + 1) % valence), 1 + valence + i]);
  }
  const poleDoc: QuadMeshDoc = { ...source, vertices, quads, edgeHandles: undefined, quadTwist: undefined };
  const classified = meshPoleIndices(buildQuadMesh(poleDoc.vertices, poleDoc.quads));
  check(classified.extra5.length === 1 && classified.extra5[0] === 0,
    'poles: the retained valence-5 identity points at the fan centre');
  const poleAdj = meshAdjacency(buildQuadMesh(poleDoc.vertices, poleDoc.quads));
  check(meshVertexCanSmooth(poleDoc, poleAdj, 0),
    'pole smooth: a pristine extraordinary vertex offers Smooth even without an authored override');
  meshCreaseVertices(poleDoc, [0]);
  const creased = (poleAdj.neighbors[0] ?? []).map(nb => [...poleDoc.edgeHandles![`0>${nb}`]] as V3);
  meshSmoothVertices(poleDoc, [0]);
  const effective = meshEdgeHandles(buildQuadMesh(poleDoc.vertices, poleDoc.quads), poleDoc.edgeHandles);
  const smoothed = (poleAdj.neighbors[0] ?? []).map(nb => effective(0, nb));
  const planeNormal = norm(cross(smoothed[0], smoothed[1]));
  check(!poleDoc.edgeHandles && smoothed.length === valence
    && smoothed.every(handle => Math.abs(dot(planeNormal, handle)) < 1e-8),
    'pole smooth: every outgoing handle in a valence-5 fan lies in one common tangent plane');
  check(smoothed.some((handle, i) => len(sub(handle, creased[i])) > 1e-6),
    'pole smooth: a non-planar extraordinary fan visibly differs from its one-sided crease handles');

  const regular = freshGrid(), regularId = GRID_COLS + 1;
  meshCreaseVertices(regular, [regularId]);
  meshSmoothVertices(regular, [regularId]);
  check(!(regular.edgeHandles && (meshAdjacency(buildQuadMesh(regular.vertices, regular.quads)).neighbors[regularId] ?? [])
    .some(nb => regular.edgeHandles![`${regularId}>${nb}`])),
  'regular smooth: valence-4 vertices still clear overrides and return to automatic Bessel handles');
}

// ---- 8. edge loops: the double-click select-the-loop foundation (edge-loop, not the cut's ring) -----------
{
  const doc = freshGrid();
  const { mesh, adj, edgeHandle } = meshContext(doc);
  const cols = GRID_COLS;
  // an interior HORIZONTAL edge traces its whole row, rim to rim (cellCols edges), open (not a ring)
  const hLoop = meshEdgeLoop(mesh, adj, 3 * cols + 2, 3 * cols + 3);
  check(hLoop.edges.length === cellCols, `edge loop: horizontal edge traces its row (${cellCols}, got ${hLoop.edges.length})`);
  check(!hLoop.closed, 'edge loop: a grid row is open (rim to rim), not a ring');
  check(hLoop.edges.every(([a, b]) => a < b), 'edge loop: pairs are canonical [lo,hi]');
  check(hLoop.edges.some(([a, b]) => a === 3 * cols + 2 && b === 3 * cols + 3), 'edge loop: includes the seed edge');
  // ordered: each edge shares a vertex with the next (a contiguous chain, so a shift-range run is well-defined)
  const ordered = hLoop.edges.every((e, i) => i === 0 || e[0] === hLoop.edges[i - 1][0] || e[0] === hLoop.edges[i - 1][1] || e[1] === hLoop.edges[i - 1][0] || e[1] === hLoop.edges[i - 1][1]);
  check(ordered, 'edge loop: edges are returned in a contiguous traversal order');
  // an interior VERTICAL edge traces its whole column (cellRows edges)
  const vLoop = meshEdgeLoop(mesh, adj, 3 * cols + 2, 4 * cols + 2);
  check(vLoop.edges.length === cellRows, `edge loop: vertical edge traces its column (${cellRows}, got ${vLoop.edges.length})`);
  // the two loops cross at exactly the seeded vertex, sharing no edge
  const hset = new Set(hLoop.edges.map(([a, b]) => ekey(a, b)));
  check(vLoop.edges.every(([a, b]) => !hset.has(ekey(a, b))), 'edge loop: row + column loops share no edge');
  // a boundary seed follows the whole connected perimeter instead of stopping at the first grid corner
  const outside = meshEdgeLoop(mesh, adj, 0, 1);
  const outsideCount = 2 * cellCols + 2 * cellRows;
  check(outside.closed && outside.edges.length === outsideCount,
    `edge loop: an outside edge closes around the complete mountain perimeter (${outsideCount}, got ${outside.edges.length})`);
  check(outside.edges.every(([a, b]) => (adj.edgeQuads.get(ekey(a, b)) ?? []).length === 1),
    'edge loop: every selected outside-perimeter edge is a true one-patch boundary');
  // the same topology law finds an INTERNAL hole perimeter without joining it to the distant outer rim
  const holeQuad = 3 * cellCols + 3, [hA, hB] = doc.quads[holeQuad];
  const holeDoc = { ...doc, quads: doc.quads.filter((_, quad) => quad !== holeQuad) };
  const holeMesh = meshContext(holeDoc);
  const hole = meshEdgeLoop(holeMesh.mesh, holeMesh.adj, hA, hB);
  check(hole.closed && hole.edges.length === 4,
    `edge loop: a deleted patch's boundary closes as its own four-edge hole loop (${hole.edges.length})`);
  // curved highlight geometry: nonempty + finite, the same cubic samples the cage wires use
  const segs = meshEdgeSegments(mesh, edgeHandle, hLoop.edges);
  check(segs.length > 0 && segs.every(x => Number.isFinite(x)), 'edge loop: highlight segments finite + nonempty');
}

// ---- 9. edge selection semantics: ctrl = toggle, shift = the run between two picks on ONE loop -------------
{
  const doc = freshGrid();
  const { mesh, adj } = meshContext(doc);
  const cols = GRID_COLS;
  const e0: [number, number] = [3 * cols + 2, 3 * cols + 3];  // a horizontal row edge
  const e1: [number, number] = [3 * cols + 5, 3 * cols + 6];  // 3 edges further along the SAME row
  const off: [number, number] = [3 * cols + 2, 4 * cols + 2]; // a vertical edge — a DIFFERENT loop

  // plain click replaces + sets the anchor
  let s = resolveEdgeSelection([], null, e0, 'replace', mesh, adj, INDEX_NAMING);
  check(s.edges.length === 1 && !!s.anchor, 'edge sel: plain click selects one + anchors');
  // ctrl toggles a second edge in, then back out (non-consecutive accumulation)
  s = resolveEdgeSelection(s.edges, s.anchor, e1, 'toggle', mesh, adj, INDEX_NAMING);
  check(s.edges.length === 2, 'edge sel: ctrl adds a non-consecutive edge');
  s = resolveEdgeSelection(s.edges, s.anchor, e1, 'toggle', mesh, adj, INDEX_NAMING);
  check(s.edges.length === 1, 'edge sel: ctrl on a selected edge removes it');
  // shift selects the run between the anchor (e0) and e1 on their shared row: 4 edges inclusive
  s = resolveEdgeSelection([e0], e0, e1, 'range', mesh, adj, INDEX_NAMING);
  check(s.edges.length === 4, `edge sel: shift-range spans the run on one loop (4, got ${s.edges.length})`);
  // shift to an edge on a DIFFERENT loop is a no-op (must be the same loop)
  const before = resolveEdgeSelection([e0], e0, e0, 'replace', mesh, adj, INDEX_NAMING);
  const after = resolveEdgeSelection(before.edges, before.anchor, off, 'range', mesh, adj, INDEX_NAMING);
  check(after.edges.length === before.edges.length, 'edge sel: shift-range off the anchor loop changes nothing');
  // double-click selects the whole loop
  s = resolveEdgeSelection([], null, e0, 'loop', mesh, adj, INDEX_NAMING);
  check(s.edges.length === cellCols, `edge sel: double-click selects the whole loop (${cellCols}, got ${s.edges.length})`);
  const boundary: [number, number] = [0, 1], perimeter = 2 * cellCols + 2 * cellRows;
  s = resolveEdgeSelection([], null, boundary, 'loop', mesh, adj, INDEX_NAMING);
  check(s.edges.length === perimeter, `edge sel: double-click on an outside edge selects the full perimeter (${perimeter})`);
  s = resolveEdgeSelection([e0], e0, boundary, 'loopAdd', mesh, adj, INDEX_NAMING);
  check(s.edges.length === perimeter + 1,
    'edge sel: Shift-double-click adds the outside perimeter to an existing interior edge selection');
}

// ---- 10. vertex (corner) selection: the point twin — ctrl = toggle, shift = the grid block ----------------
{
  const doc = freshGrid();
  const { adj } = meshContext(doc);
  const cols = GRID_COLS;
  const v0 = 3 * cols + 2;  // (row 3, col 2)
  const v1 = 3 * cols + 5;  // (row 3, col 5) — 3 corners along the SAME row
  const vd = 5 * cols + 5;  // (row 5, col 5) — a DIAGONAL corner from v0

  // plain click replaces + sets the anchor
  let s = resolveVertexSelection([], null, v0, 'replace', adj, INDEX_NAMING);
  check(s.verts.length === 1 && s.anchor === v0, 'vertex sel: plain click selects one + anchors');
  // ctrl toggles a second corner in, then back out (non-consecutive accumulation)
  s = resolveVertexSelection(s.verts, s.anchor, v1, 'toggle', adj, INDEX_NAMING);
  check(s.verts.length === 2, 'vertex sel: ctrl adds a non-consecutive corner');
  s = resolveVertexSelection(s.verts, s.anchor, v1, 'toggle', adj, INDEX_NAMING);
  check(s.verts.length === 1, 'vertex sel: ctrl on a selected corner removes it');
  // shift-range along a shared row: the block degenerates to that line of corners (cols 2..5 = 4)
  s = resolveVertexSelection([v0], v0, v1, 'range', adj, INDEX_NAMING);
  check(s.verts.length === 4, `vertex sel: shift-range along a row is the line (4, got ${s.verts.length})`);
  // shift-range to a DIAGONAL corner spans the rectangular block across the quads: rows 3..5 × cols 2..5 = 12
  const blk = resolveVertexSelection([v0], v0, vd, 'range', adj, INDEX_NAMING);
  check(blk.verts.length === 12, `vertex sel: shift-range across the grid selects the block (12, got ${blk.verts.length})`);
  check([v0, v1, vd, 5 * cols + 2].every(v => blk.verts.includes(v)), 'vertex sel: the block includes all four corners');
}

// ---- 11. cell (face) selection: the surface twin — ctrl = toggle, shift = the block, dbl-click = the loop --
{
  const doc = freshGrid();
  const { mesh } = meshContext(doc);
  const topo = mesh.topology;
  const cc = cellCols;             // cells per row (cell id = cell-row*cellCols + cell-col)
  const q0 = 3 * cc + 2;           // (cell-row 3, cell-col 2)
  const q1 = 3 * cc + 5;           // same cell-row, 3 cells along
  const qd = 5 * cc + 5;           // a DIAGONAL cell from q0

  // plain click replaces + sets the anchor
  let s = resolveCellSelection([], null, q0, 'replace', INDEX_NAMING);
  check(s.cells.length === 1 && s.anchor === q0, 'cell sel: plain click selects one + anchors');
  // ctrl toggles a second cell in, then back out (non-consecutive accumulation)
  s = resolveCellSelection(s.cells, s.anchor, q1, 'toggle', INDEX_NAMING);
  check(s.cells.length === 2, 'cell sel: ctrl adds a non-consecutive cell');
  s = resolveCellSelection(s.cells, s.anchor, q1, 'toggle', INDEX_NAMING);
  check(s.cells.length === 1, 'cell sel: ctrl on a selected cell removes it');
  // shift-range along a shared cell-row: the block degenerates to that strip (cols 2..5 = 4 cells)
  s = resolveCellSelection([q0], q0, q1, 'range', INDEX_NAMING, topo);
  check(s.cells.length === 4, `cell sel: shift-range along a row is the strip (4, got ${s.cells.length})`);
  // shift-range to a DIAGONAL cell spans the rectangular block: cell-rows 3..5 × cell-cols 2..5 = 12
  const blk = resolveCellSelection([q0], q0, qd, 'range', INDEX_NAMING, topo);
  check(blk.cells.length === 12, `cell sel: shift-range across the grid selects the block (12, got ${blk.cells.length})`);
  check([q0, q1, qd, 5 * cc + 2].every(c => blk.cells.includes(c)), 'cell sel: the block includes all four corner cells');
  // double-click selects the whole face loop; the two directions are the row + the column, crossing only at q0
  const dir0 = resolveCellSelection([], null, q0, 'loop', INDEX_NAMING, topo, 0);
  const dir1 = resolveCellSelection([], null, q0, 'loop', INDEX_NAMING, topo, 1);
  check(dir0.cells.includes(q0) && dir1.cells.includes(q0), 'cell loop: each direction includes the seed cell');
  check((dir0.cells.length === cellRows && dir1.cells.length === cellCols)
     || (dir0.cells.length === cellCols && dir1.cells.length === cellRows),
     `cell loop: the two directions run the whole row + column (got ${dir0.cells.length}, ${dir1.cells.length})`);
  const d0set = new Set(dir0.cells);
  check(dir1.cells.filter(c => d0set.has(c)).length === 1, 'cell loop: the row + column strips cross only at the seed');
}

// ---- 12. interior twist (docs/020): moves ONLY the interior CPs, off the zero-twist prediction ------------
{
  const doc = freshGrid();
  const q = 10;                       // an interior quad (all four boundaries shared, so no rim degeneracy)
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const base = quadControlPoints(mesh, edgeHandle, q);        // zero-twist construction

  // a twist offset on corner B (slot 1 → cp6) moves cp6 by exactly that offset, nothing else
  const off: [number, number, number] = [3, -7, 5];
  const twisted = quadControlPoints(mesh, edgeHandle, q, [[0, 0, 0], off, [0, 0, 0], [0, 0, 0]]);
  check(INTERIOR_CP[1] === 6, 'twist: corner slot B maps to cp6');
  const movedOnly = twisted.every((cp, k) => {
    const want: [number, number, number] = k === 6 ? [base[k][0] + off[0], base[k][1] + off[1], base[k][2] + off[2]] : base[k];
    return cp.every((x, j) => Math.abs(x - want[j]) < 1e-9);
  });
  check(movedOnly, 'twist: only cp6 moves; all fifteen other CPs (corners + seams) byte-identical');

  // meshSetTwist persists it, and the derived quilt picks it up (its interior CP is off the zero-twist base)
  meshSetTwist(doc, q, 1, off);
  check(!!doc.quadTwist && doc.quadTwist[q][1] === off && doc.quadTwist[q][0][0] === 0, 'twist: meshSetTwist stores the corner, seeds the rest to zero');
  const derived = meshFromDoc(doc);
  const cpNow = quadControlPoints(derived.mesh, derived.edgeHandle, q, doc.quadTwist![q]);
  const d6 = cpNow[6].map((x, j) => x - base[6][j]);
  check(d6.every((x, j) => Math.abs(x - off[j]) < 1e-9), 'twist: the stored quadTwist reproduces the interior displacement');

  // the twist is INDEPENDENT of the boundary handles: pull an edge handle, the interior offset off the (new)
  // zero-twist base is preserved — exactly how the reference carries a sculpted interior past its tangents.
  const [A, B] = doc.quads[q];
  doc.edgeHandles = { ...(doc.edgeHandles ?? {}), [`${A}>${B}`]: [10, 0, 0] };
  const d2 = meshFromDoc(doc);
  const zeroNow = quadControlPoints(d2.mesh, d2.edgeHandle, q)[6];                  // new zero-twist base after the crease
  const twistNow = quadControlPoints(d2.mesh, d2.edgeHandle, q, doc.quadTwist![q])[6];
  check(twistNow.every((x, j) => Math.abs(x - (zeroNow[j] + off[j])) < 1e-9), 'twist: rides the boundary handle (offset preserved off the new base)');
}

// ---- reset shape: automatic boundary handles + no interior sculpt, corners untouched -----------------------
{
  const doc = freshGrid();
  const q = 10, qFar = 10 * cellCols + 10;
  const [A, B] = doc.quads[q], [FA, FB] = doc.quads[qFar];
  meshSetHandle(doc, A, B, [8, -2, 3]);
  meshSetHandle(doc, FA, FB, [1, 2, 3]);
  meshSetTwist(doc, q, 2, [4, 5, 6]);
  meshSetTwist(doc, qFar, 0, [7, 8, 9]);
  const corners0 = doc.vertices.slice();
  meshResetShape(doc, [q]);
  check(doc.vertices.every((x, i) => x === corners0[i]), 'reset shape: every corner stays bit-identical');
  check(doc.edgeHandles?.[`${A}>${B}`] === undefined, 'reset shape: selected boundary handle returns to automatic smooth');
  check(doc.edgeHandles?.[`${FA}>${FB}`]?.[1] === 2, 'reset shape: an unrelated boundary handle is preserved');
  check(doc.quadTwist?.[q] === undefined, 'reset shape: selected interior sculpt is cleared');
  check(doc.quadTwist?.[qFar]?.[0][2] === 9, 'reset shape: an unrelated interior sculpt is preserved');
}

// ---- 13. twist survives an unrelated loop cut (remapped) and resets on the cut quad ------------------------
{
  const tdoc = freshGrid();
  const qFar = 3 * cellCols + 5, qCut = 0; // qFar is in a different column than qCut's cut, so it isn't split
  meshSetTwist(tdoc, qFar, 0, [1, 2, 3]);
  meshSetTwist(tdoc, qCut, 0, [4, 5, 6]);
  const { mesh: m2, adj: a2 } = meshContext(tdoc);
  const plan = planLoopCut(m2, a2, 0, [0, 1]);
  const r = applyLoopCut(tdoc, plan, 0.5);
  check(r.ok, 'twist+cut: commit accepted');
  if (r.ok) {
    check(r.doc.quadTwist?.[qFar]?.[0][1] === 2, 'twist+cut: an unsplit quad keeps its twist across the cut');
    check(r.doc.quadTwist?.[qCut] === undefined, 'twist+cut: the cut quad resets to zero-twist (no misplaced relief)');
  }
}

// ---- 14c. split selected patch strip only: unresolved ends become explicit T-junctions ---------------------
{
  const doc = freshGrid();
  const cc = cellCols;
  const V0d = doc.vertices.length / 3, Q0d = doc.quads.length;
  // 3 cells in a row (cell-row 3, cols 2,3,4), well inside so both ends have a proper cap cell
  const strip = [3 * cc + 2, 3 * cc + 3, 3 * cc + 4];
  const untouchedEnds = [doc.quads[3 * cc + 1].slice(), doc.quads[3 * cc + 5].slice()];
  const r = applyCellEdgeInsert(doc, strip);
  check(r.ok, 'split patch strip: commit accepted');
  if (r.ok) {
    // Only the three selected cells split; both neighboring cells remain unchanged and host the two T nodes.
    check(r.doc.quads.length === Q0d + 3, `split patch strip: +3 cells (${r.doc.quads.length - Q0d})`);
    check(r.doc.vertices.length / 3 === V0d + 4, `split patch strip: +4 vertices (${r.doc.vertices.length / 3 - V0d})`);
    const wedges = r.doc.quads.filter(q => new Set(q).size === 3 && q[2] === q[3]);
    check(wedges.length === 0, `split patch strip: creates no automatic end-cap wedges (${wedges.length})`);
    const junctions = findTJunctions(r.doc);
    check(junctions.length === 2 && r.doc.tJunctions?.length === 2,
      `split patch strip: both unresolved ends are explicit T-junctions (${junctions.length})`);
    check(untouchedEnds.every((quad, index) => r.doc.quads[3 * cc + 1 + index * 4].join(',') === quad.join(',')),
      'split patch strip: patches immediately beyond both selected ends remain byte-identical');
    const wt = watertight(r.doc);
    check(wt.ok && !hasNaN(r.doc), 'split patch strip: finite with no over-connected edge');
    // Derived quilt remains finite despite the intentionally open topological seams at the T nodes.
    const pv = buildMountainPreview(r.doc);
    check(!pv.positions.some(x => !Number.isFinite(x)) && !pv.normals.some(x => !Number.isFinite(x)), 'split patch strip: derived quilt + normals finite');
  }
  const rimStrip = Array.from({ length: cellRows }, (_, row) => row * cc + 2);
  const rim = applyCellEdgeInsert(doc, rimStrip);
  check(rim.ok && findTJunctions(rim.doc).length === 0,
    'split patch strip: a rim-to-rim selection has conforming boundary endpoints and no T-junctions');

  const fourPatches: QuadMeshDoc = {
    ...doc,
    vertices: [0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0, 40, 0, 0,
      0, 0, 10, 10, 0, 10, 20, 0, 10, 30, 0, 10, 40, 0, 10],
    quads: [[0, 1, 5, 6], [1, 2, 6, 7], [2, 3, 7, 8], [3, 4, 8, 9]],
    freeEdges: undefined, tJunctions: [], edgeHandles: undefined,
    quadPaint: undefined, quadTex: undefined, quadOrient: undefined, quadTwist: undefined,
  };
  const leftHalf = applyCellEdgeInsert(fourPatches, [0, 1]);
  const completedRow = leftHalf.ok ? applyCellEdgeInsert(leftHalf.doc, [2, 3]) : null;
  check(leftHalf.ok && findTJunctions(leftHalf.doc).length === 1,
    'split patch strip composition: splitting the first two of four patches leaves one middle T-junction');
  check(completedRow?.ok === true && completedRow.doc.quads.length === 8
    && completedRow.doc.vertices.length / 3 === 15 && completedRow.doc.quads.every(q => new Set(q).size === 4)
    && findTJunctions(completedRow.doc).length === 0 && findCoincidentVertices(completedRow.doc).length === 0,
    'split patch strip composition: splitting the other two reuses the middle T-node and resolves one conforming eight-quad row');
  const duplicateTJunctions: QuadMeshDoc = {
    ...fourPatches,
    vertices: [...fourPatches.vertices, 20, 0, 5, 20, 0, -10, 20, 0, 5, 20, 0, -20],
    freeEdges: [[10, 11], [12, 13]],
    tJunctions: [{ vertex: 10, edge: [2, 7], t: 0.5 }, { vertex: 12, edge: [2, 7], t: 0.5 }],
  };
  check(!applyCellEdgeInsert(duplicateTJunctions, [2, 3]).ok,
    'split patch strip: duplicate T-nodes at one host parameter are rejected until the points are welded together');
  // a disjoint (non-strip) cell selection is rejected
  check(!applyCellEdgeInsert(doc, [3 * cc + 2, 6 * cc + 2]).ok, 'split patch strip: a disjoint cell selection is rejected');
}

// ---- 15. wedge (collapsed-edge triangle) data-model: [A,B,C,C] flows through derive / render / guard (S3) ---
{
  // a lone wedge quad: corners A, B, C with the D–C side folded to point C
  const verts = [0, 0, 0, 20, 0, 0, 10, 0, 20];
  const mesh = buildQuadMesh(verts, [[0, 1, 2, 2]]);

  // topology: the cell still lists four sides, but the collapsed one is a PRIVATE single-cell wall
  const ce = mesh.topology.cellEdges[0];
  check(ce.length === 4, 'wedge: the cell still lists four sides (the collapsed one is a wall)');
  check(ce.filter(e => (mesh.topology.edgeCells[e] ?? []).length === 1).length >= 1, 'wedge: the collapsed side is a single-cell wall');

  // adjacency: the apex C never neighbours itself (self-edge skipped), but still neighbours A and B
  const adj = meshAdjacency(mesh);
  check(!adj.neighbors[2].includes(2), 'wedge: the apex is not its own neighbour (self-edge skipped)');
  check(adj.neighbors[2].includes(0) && adj.neighbors[2].includes(1), 'wedge: the apex still neighbours A and B');

  // control points: the u=1 row folds to the apex C, and nothing is NaN
  const eh = meshEdgeHandles(mesh);
  const cp = quadControlPoints(mesh, eh, 0);
  const C: [number, number, number] = [verts[6], verts[7], verts[8]];
  check([12, 13, 14, 15].every(k => cp[k].every((x, j) => Math.abs(x - C[j]) < 1e-9)), 'wedge: the u=1 control row folds to the apex C');
  check(cp.every(p => p.every(Number.isFinite)), 'wedge: no NaN control points');

  // the derived surface + its apex normal are finite (patchNormal guards the collapsed frame, incl. u=1)
  let finite = true;
  for (let iu = 0; iu <= 4; iu++) for (let iv = 0; iv <= 4; iv++) {
    const p = patchPoint(cp, iu / 4, iv / 4), n = patchNormal(cp, iu / 4, iv / 4);
    if (!p.every(Number.isFinite) || !n.every(Number.isFinite)) finite = false;
  }
  check(finite, 'wedge: tessellated patch + normals finite everywhere (incl. the apex u=1)');

  // the cage draws the wedge's three real edges (finite), none on the collapsed side
  const cage = meshCageEdges(mesh, eh);
  check(cage.interior.length + cage.boundary.length > 0 && [...cage.interior, ...cage.boundary].every(Number.isFinite), 'wedge: the cage draws finite wedge edges');

  // the manifold guard accepts the wedge, rejects other collapses
  check(checkManifold([[0, 1, 2, 2]]).ok, 'wedge: checkManifold accepts [A,B,C,C]');
  check(!checkManifold([[0, 0, 2, 3]]).ok, 'wedge: checkManifold rejects a non-wedge collapse [A,A,C,D]');
  check(!checkManifold([[0, 1, 2, 0]]).ok, 'wedge: checkManifold rejects [A,B,C,A] (wrong fused pair)');
}

// ---- 16. de Casteljau splits: exact re-cuts of the same curve / surface, and the twist they carry ----------
{
  const at = (c: [V3, V3, V3, V3], s: number) => cubicPoint(c[0], c[1], c[2], c[3], s);
  const dist = (a: V3, b: V3) => len(sub(a, b));
  /** Max norm of the four zero-twist (Ferguson) residuals: cp[i] − (cp[a] + cp[b] − cp[o]) at each corner. */
  const twistResidual = (cp: V3[]) => {
    const corners: [number, number, number, number][] = [[5, 4, 1, 0], [6, 7, 2, 3], [9, 8, 13, 12], [10, 11, 14, 15]];
    return Math.max(...corners.map(([i, a, b, o]) => dist(cp[i], sub(add(cp[a], cp[b]), cp[o]))));
  };

  // ---- splitCubic: both halves re-trace the parent over their sub-range, exactly
  const C: [V3, V3, V3, V3] = [[-4, 2, 1], [3, 9, -6], [14, -5, 11], [21, 7, 4]]; // non-planar, asymmetric
  const snap = JSON.stringify(C);
  let maxL = 0, maxR = 0;
  for (const t of [0.05, 0.13, 0.35, 0.5, 0.77, 0.95]) {
    const { left, right } = splitCubic(C[0], C[1], C[2], C[3], t);
    for (let i = 0; i <= 64; i++) {
      const s = i / 64;
      maxL = Math.max(maxL, dist(at(left, s), at(C, t * s)));
      maxR = Math.max(maxR, dist(at(right, s), at(C, t + (1 - t) * s)));
    }
  }
  check(maxL < 1e-12, `splitCubic: left re-traces [0,t] exactly (max err ${maxL.toExponential(2)})`);
  check(maxR < 1e-12, `splitCubic: right re-traces [t,1] exactly (max err ${maxR.toExponential(2)})`);
  check(JSON.stringify(C) === snap, 'splitCubic: pure — the input control points are untouched');

  // a general (non-Ferguson) patch: asymmetric, non-planar corners AND handles, so a broken splitter can't hide
  const cp: V3[] = [
    [0, 3, 0], [11, -2, 4], [23, 6, -3], [31, 1, 5],
    [-2, 8, 12], [9, -4, 15], [26, 13, 9], [35, 5, 17],
    [3, -6, 26], [13, 11, 21], [21, -9, 30], [38, 14, 24],
    [-5, 2, 37], [12, 16, 41], [27, -7, 34], [33, 9, 44],
  ];
  const cpSnap = JSON.stringify(cp);

  // ---- splitPatchU at t=0.35: lower covers u ∈ [0,t], upper covers u ∈ [t,1]
  const TU = 0.35;
  const su = splitPatchU(cp, TU);
  let maxU = 0;
  for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
    const a = i / 16, v = j / 16;
    maxU = Math.max(maxU, dist(patchPoint(su.lower, a, v), patchPoint(cp, TU * a, v)));       // u = TU*a ∈ [0,TU]
    maxU = Math.max(maxU, dist(patchPoint(su.upper, a, v), patchPoint(cp, TU + (1 - TU) * a, v))); // u ∈ [TU,1]
  }
  check(maxU < 1e-10, `splitPatchU: both sub-patches re-evaluate the parent surface (max err ${maxU.toExponential(2)})`);

  // ---- splitPatchV at t=0.6: the same with u and v swapped
  const TV = 0.6;
  const sv = splitPatchV(cp, TV);
  let maxV = 0;
  for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
    const u = i / 16, b = j / 16;
    maxV = Math.max(maxV, dist(patchPoint(sv.lower, u, b), patchPoint(cp, u, TV * b)));
    maxV = Math.max(maxV, dist(patchPoint(sv.upper, u, b), patchPoint(cp, u, TV + (1 - TV) * b)));
  }
  check(maxV < 1e-10, `splitPatchV: both sub-patches re-evaluate the parent surface (max err ${maxV.toExponential(2)})`);
  check(JSON.stringify(cp) === cpSnap, 'splitPatch*: pure — the parent control net is untouched');

  // the split's own seam corners land on the parent surface (the sub-patches meet where the cut was made)
  check(dist(su.lower[12], su.upper[0]) < 1e-12 && dist(su.lower[15], su.upper[3]) < 1e-12, 'splitPatchU: the halves share the cut boundary corners');

  // ---- the twist claim the doc comment rests on: a Ferguson patch's sub-patch is NOT zero-twist
  const f: V3[] = new Array(16);
  // corners + boundary handles: asymmetric, non-planar (a flat/symmetric patch would pass a broken splitter)
  f[0] = [0, 4, 0]; f[3] = [30, -1, 6]; f[12] = [-4, 2, 33]; f[15] = [36, 11, 39];
  f[1] = [9, -3, 3]; f[2] = [21, 7, -2];      // u=0 rim, across v
  f[4] = [-3, 9, 11]; f[8] = [2, -5, 23];     // v=0 rim, down u
  f[7] = [34, 6, 15]; f[11] = [39, -8, 26];   // v=1 rim, down u
  f[13] = [10, 15, 36]; f[14] = [26, -6, 35]; // u=1 rim, across v
  // interiors = the zero-twist (Ferguson) prediction: corner + its two in-cell handles
  f[5] = sub(add(f[4], f[1]), f[0]);
  f[6] = sub(add(f[7], f[2]), f[3]);
  f[9] = sub(add(f[8], f[13]), f[12]);
  f[10] = sub(add(f[11], f[14]), f[15]);

  const rParent = twistResidual(f);
  check(rParent < 1e-12, `twist: the built parent IS Ferguson (zero-twist residual ${rParent.toExponential(2)})`);
  const rSub = twistResidual(splitPatchU(f, 0.35).upper);
  check(rSub > 1e-3, `twist: its exact sub-patch is NOT zero-twist (residual ${rSub.toFixed(4)}) — a re-cut must carry the interior CPs`);
  // and the sub-patch is still an exact re-cut, so the twist is real geometry, not splitter error
  let maxF = 0;
  const fu = splitPatchU(f, 0.35);
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    maxF = Math.max(maxF, dist(patchPoint(fu.upper, i / 8, j / 8), patchPoint(f, 0.35 + 0.65 * (i / 8), j / 8)));
  }
  check(maxF < 1e-10, `twist: the non-zero-twist half still re-evaluates the parent exactly (max err ${maxF.toExponential(2)})`);
}

console.log(failures ? '\nMESHOPS: FAIL' : '\nMESHOPS: PASS');
process.exit(failures ? 1 : 0);
