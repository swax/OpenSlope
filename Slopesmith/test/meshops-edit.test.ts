/**
 * Headless checks for the meshops edits that reshape or remove what is already there (docs/017): the
 * sub-cage control-point set and its dependency-ordered batch moves, the patch locks that protect an
 * exact bicubic shape, delete, dissolve, and the vertex clipboard.
 * Run: `npx tsx test/meshops-edit.test.ts`
 *
 * Split out of test/meshops.test.ts; the grid fixture and the `check()` tally live in
 * test/meshops.fixture.ts, shared with the other `meshops-*` checks.
 */
import * as THREE from 'three';
import { applyBrush, meshSetTwist, migrateMountain } from '../src/core/doc/mountain';
import { meshFromDoc, quadControlPoints, buildQuadMesh, meshEdgeHandles, meshCageEdges } from '../src/core/mesh/topology';
import { add, len, mul, sub } from '../src/core/math/vec';
import { appendStandalonePatch, meshDeleteTargets, applyMeshDelete, applyMeshDissolve } from '../src/core/mesh/ops';
import { getVertex, setVertex } from '../src/core/doc/doc-edit';
import { serializeMountain } from '../src/core/doc/serialize';
import { copyMeshVertices, meshClipboardText, pasteMeshVertices } from '../src/core/mesh/clipboard';
import { controlPointCageOwners, controlPointKey, meshControlPoints, moveMeshControlPoints, moveMeshVerticesProportional, setMeshControlPoints } from '../src/core/mesh/control-points';
import { INDEX_NAMING } from '../src/core/mesh/selection';
import { buildMountainPreview, previewMismatch, refreshPreviewPatches } from '../src/core/mesh/tessellation';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { clipboardPlacementOffset } from '../src/app/viewport/tools/clipboard-placement';
import { lockedViewAxis } from '../src/app/viewport/camera/view-grid';
import { findTJunctions } from '../src/core/mesh/t-junctions';
import { lockedEdgeSet, lockedVertexSet, setQuadsLocked } from '../src/core/mesh/locks';
import { GRID_COLS, freshGrid, V0, Q0 } from './meshops.fixture';
import { check, failures } from './check';

// ---- 0b. SUB-CAGE CONTROL POINTS: one identity/render/pick set, exact dependency-ordered batch moves -------
{
  const added = appendStandalonePatch(freshGrid(), [80, 20, -50], [0, 1, 0]);
  // Control points name their geometry by the document's stable ids (docs/039), so the fixture's own
  // indices are read through the identity the patch was minted with.
  const addedVertexNames = added.vertices.map(v => added.doc.vertexIds[v]);
  const addedQuadName = added.doc.quadIds[added.quad];
  const belongs = (id: ReturnType<typeof meshControlPoints>[number]['id']) => id.kind === 'vertex'
    ? addedVertexNames.includes(id.vertex)
    : id.kind === 'edge'
      ? addedVertexNames.includes(id.from) && addedVertexNames.includes(id.to)
      : id.quad === addedQuadName;
  const points = meshControlPoints(added.doc).filter(cp => belongs(cp.id));
  check(points.length === 16
    && points.filter(cp => cp.id.kind === 'vertex').length === 4
    && points.filter(cp => cp.id.kind === 'edge').length === 8
    && points.filter(cp => cp.id.kind === 'twist').length === 4,
  'sub-cage points: a standalone patch enumerates 4 corners + 8 directed tangents + 4 interiors exactly once');

  const ownerCages = controlPointCageOwners([
    { kind: 'vertex', vertex: addedVertexNames[0] },
    { kind: 'edge', from: addedVertexNames[0], to: addedVertexNames[1] },
    { kind: 'edge', from: addedVertexNames[1], to: addedVertexNames[0] },
    { kind: 'twist', quad: addedQuadName, corner: 0 },
    { kind: 'twist', quad: addedQuadName, corner: 3 },
  ]);
  check(ownerCages.edges.length === 1 && ownerCages.quads.length === 1 && ownerCages.quads[0] === addedQuadName,
    'sub-cage reveal: selected tangents and interiors resolve to one de-duplicated edge / patch owner cage');

  const delta: V3 = [7, -3, 4.5], before = new Map(points.map(cp => [controlPointKey(cp.id), cp.pos]));
  const moved = structuredClone(added.doc);
  moveMeshControlPoints(moved, points.map(cp => cp.id), delta);
  const after = new Map(meshControlPoints(moved).filter(cp => belongs(cp.id)).map(cp => [controlPointKey(cp.id), cp.pos]));
  const allTranslated = points.every(cp => {
    const a = before.get(controlPointKey(cp.id))!, b = after.get(controlPointKey(cp.id))!;
    return len(sub(b, add(a, delta))) < 1e-8;
  });
  check(allTranslated, 'sub-cage points: translating a complete 4x4 cage moves every point exactly once');

  const mixed = [
    points.find(cp => cp.id.kind === 'vertex')!,
    points.find(cp => cp.id.kind === 'edge')!,
    points.find(cp => cp.id.kind === 'twist')!,
  ];
  const pivot: V3 = [
    mixed.reduce((s, cp) => s + cp.pos[0], 0) / mixed.length,
    mixed.reduce((s, cp) => s + cp.pos[1], 0) / mixed.length,
    mixed.reduce((s, cp) => s + cp.pos[2], 0) / mixed.length,
  ];
  const turnY90 = (p: V3): V3 => [pivot[0] + p[2] - pivot[2], p[1], pivot[2] - p[0] + pivot[0]];
  const rotatedTargets = mixed.map(cp => ({ id: cp.id, pos: turnY90(cp.pos) }));
  const rotatedMixed = structuredClone(added.doc);
  setMeshControlPoints(rotatedMixed, rotatedTargets);
  const rotatedByKey = new Map(meshControlPoints(rotatedMixed).map(cp => [controlPointKey(cp.id), cp.pos]));
  check(rotatedTargets.every(t => len(sub(rotatedByKey.get(controlPointKey(t.id))!, t.pos)) < 1e-8),
    'sub-cage points: a mixed corner/tangent/interior group lands on exact absolute rotation targets');

  const onlyPatch: QuadMeshDoc = {
    ...added.doc,
    vertices: added.vertices.flatMap(v => getVertex(added.doc, v)),
    quads: [[0, 1, 2, 3]],
    edgeHandles: undefined, quadTwist: undefined, quadPaint: undefined, quadTex: undefined, quadOrient: undefined,
  };

  // Moving one whole edge is a patch resize: its 4x4 cage must stretch in parameter-space proportions even
  // when every boundary tangent and interior has been hand-shaped (plain corner writes would keep those sparse
  // offsets fixed and make the first interior row travel the full delta instead of 2/3).
  const resized = structuredClone(onlyPatch);
  const [A, B, C, D] = resized.quads[0];
  resized.edgeHandles = {
    [`${A}>${B}`]: [2, 1, -0.5], [`${B}>${A}`]: [-3, 0.25, 0.75],
    [`${A}>${C}`]: [1, -0.5, 2], [`${C}>${A}`]: [-2.5, 0.75, -1],
    [`${B}>${D}`]: [0.5, 1.5, 1], [`${D}>${B}`]: [-1, -0.25, -2],
    [`${C}>${D}`]: [2.5, 0.5, 0.25], [`${D}>${C}`]: [-2, 1, -0.75],
  };
  resized.quadTwist = { 0: [[0.5, 1, -0.5], [-1, 0.25, 0.75], [0.2, -0.4, 1.1], [0.8, 0.6, -0.3]] };
  const beforeResizeCtx = meshFromDoc(resized);
  const beforeResize = quadControlPoints(beforeResizeCtx.mesh, beforeResizeCtx.edgeHandle, 0, resized.quadTwist[0]);
  const edgeDelta: V3 = [9, -3, 6];
  const resizeChange = moveMeshVerticesProportional(resized, [A, B], edgeDelta);
  const afterResizeCtx = meshFromDoc(resized);
  const afterResize = quadControlPoints(afterResizeCtx.mesh, afterResizeCtx.edgeHandle, 0, resized.quadTwist?.[0]);
  const proportional = afterResize.every((p, i) => {
    const u = Math.floor(i / 4) / 3; // A-B is u=0 (moved); C-D is u=1 (fixed)
    return len(sub(p, add(beforeResize[i], mul(edgeDelta, 1 - u)))) < 1e-8;
  });
  check(proportional, 'proportional resize: moving an edge carries the shaped 4x4 cage by 1, 2/3, 1/3, 0');
  check(resizeChange.quads.length === 1 && resizeChange.edges.length === 4,
    'proportional resize: reports the exact dirty patch and its four boundary curves for local preview');
  const sparseResize = structuredClone(onlyPatch);
  moveMeshVerticesProportional(sparseResize, [0, 1], edgeDelta);
  check(sparseResize.edgeHandles === undefined && sparseResize.quadTwist === undefined,
    'proportional resize: an automatic free-patch cage stays automatic when it already scales correctly');

  const tangent = points.find(cp => cp.id.kind === 'edge')!;
  const tangentOnly = structuredClone(added.doc), corners0 = added.vertices.map(v => getVertex(tangentOnly, v));
  moveMeshControlPoints(tangentOnly, [tangent.id], delta);
  const tangentAfter = meshControlPoints(tangentOnly).find(cp => controlPointKey(cp.id) === controlPointKey(tangent.id))!;
  check(len(sub(tangentAfter.pos, add(tangent.pos, delta))) < 1e-8
    && added.vertices.every((v, i) => len(sub(getVertex(tangentOnly, v), corners0[i])) < 1e-9),
  'sub-cage points: a lone tangent moves without moving its owner corners');

  const interior = points.find(cp => cp.id.kind === 'twist')!;
  const interiorOnly = structuredClone(added.doc);
  moveMeshControlPoints(interiorOnly, [interior.id], delta);
  const interiorAfter = meshControlPoints(interiorOnly).find(cp => controlPointKey(cp.id) === controlPointKey(interior.id))!;
  check(len(sub(interiorAfter.pos, add(interior.pos, delta))) < 1e-8,
    'sub-cage points: a lone interior moves to its exact target relative to the live boundary cage');

  const partial = buildMountainPreview(onlyPatch);
  meshSetTwist(onlyPatch, 0, 2, [1.5, -2, 0.75]);
  check(refreshPreviewPatches(onlyPatch, partial, [0]) === 1, 'live edit preview: retessellates the named patch in place');
  check(previewMismatch(onlyPatch, partial) === null,
    'live edit preview: the updated quilt is byte-identical to an authoritative full rebuild');
  // Paint, tile and orientation are patch-local too, and they move the colour / UV / material channels rather
  // than the geometry — so the same in-place update has to carry them.
  (onlyPatch.quadPaint ??= {})[0] = 5;
  (onlyPatch.quadTex ??= {})[0] = 'TEST/PARTIAL.png';
  (onlyPatch.quadOrient ??= {})[0] = { rot: 2, mirror: true };
  refreshPreviewPatches(onlyPatch, partial, [0]);
  check(previewMismatch(onlyPatch, partial) === null,
    'live edit preview: a repainted, retiled and reoriented patch matches a full rebuild in every channel');
}

// ---- 0c. PATCH LOCKS: exact bicubic shape protection across every geometric write path ---------------------
{
  // Two joined patches make the important case explicit: the protected patch shares a seam with terrain that
  // remains editable. Stable ids are included because direct control-point transforms name their targets by id.
  const base = freshGrid();
  const pair: QuadMeshDoc = {
    ...base,
    vertices: [
      0, 0, 0, 0, 0, 10,
      10, 0, 0, 10, 0, 10,
      20, 0, 0, 20, 0, 10,
    ],
    quads: [[0, 1, 2, 3], [2, 3, 4, 5]],
    vertexIds: ['lock-v0', 'lock-v1', 'lock-v2', 'lock-v3', 'lock-v4', 'lock-v5'],
    quadIds: ['lock-q0', 'lock-q1'], nextId: 8,
    edgeHandles: undefined, quadPaint: undefined, quadTex: undefined, quadOrient: undefined,
    quadLocked: undefined, quadTwist: undefined, freeEdges: undefined, tJunctions: [],
  };
  const controls = (doc: QuadMeshDoc, quad = 0) => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    return quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad] ?? null);
  };
  const beforeLock = controls(pair);
  check(setQuadsLocked(pair, [0], true) === 1 && pair.quadLocked?.[0] === true
    && lockedVertexSet(pair).size === 4 && lockedEdgeSet(pair).size === 4,
  'patch lock: the selected patch protects its four corners and perimeter curves');
  check(JSON.stringify(controls(pair)) === JSON.stringify(beforeLock)
    && Object.keys(pair.edgeHandles ?? {}).length === 8,
  'patch lock: locking is shape-neutral and pins all eight effective boundary handles');

  const lockedShape = JSON.stringify(controls(pair)), lockedCorners = pair.quads[0].map(v => getVertex(pair, v));
  setVertex(pair, 0, [99, 99, 99]);
  const moved = moveMeshVerticesProportional(pair, [0, 1, 2, 3, 4, 5], [0, 6, 0]);
  check(pair.quads[0].every((v, i) => JSON.stringify(getVertex(pair, v)) === JSON.stringify(lockedCorners[i]))
    && moved.vertices.join(',') === '4,5' && getVertex(pair, 4)[1] === 6 && getVertex(pair, 5)[1] === 6,
  'patch lock: direct writes and group moves skip protected corners while adjacent terrain still moves');
  check(JSON.stringify(controls(pair)) === lockedShape,
    'patch lock: moving the neighbouring patch cannot reshape the protected bicubic surface');

  const lockedNames = new Set(pair.quads[0].map(v => pair.vertexIds[v]));
  const lockedPoints = meshControlPoints(pair).filter(cp => {
    const id = cp.id;
    if (id.kind === 'twist') return id.quad === pair.quadIds[0];
    if (id.kind === 'vertex') return lockedNames.has(id.vertex);
    return lockedNames.has(id.from) && lockedNames.has(id.to);
  });
  check(moveMeshControlPoints(pair, lockedPoints.map(cp => cp.id), [3, 4, 5]) === 0
    && JSON.stringify(controls(pair)) === lockedShape,
  'patch lock: corner, tangent and interior control-point transforms are all rejected');

  const brushed = structuredClone(pair), outerBefore = getVertex(brushed, 4);
  applyBrush(brushed, 'raise', [10, 0, 5], 30, 2, 'vertical', 0, 'constant');
  check(JSON.stringify(controls(brushed)) === lockedShape && getVertex(brushed, 4)[1] > outerBefore[1],
    'patch lock: sculpting leaves the protected surface exact while deforming reachable unlocked terrain');

  const stored = serializeMountain(pair);
  check(stored.quadLocked?.[pair.quadIds[0]] === true
    && migrateMountain(structuredClone(stored)).quadLocked?.[0] === true,
  'patch lock: save/load stores protection by stable patch id and restores it to the live index');
  check(setQuadsLocked(pair, [0], false) === 1 && pair.quadLocked === undefined,
    'patch lock: unlocking removes protection without discarding the captured surface handles');
  const unlocked = getVertex(pair, 0);
  setVertex(pair, 0, [unlocked[0], unlocked[1] + 2, unlocked[2]]);
  check(getVertex(pair, 0)[1] === unlocked[1] + 2, 'patch lock: unlocked geometry is editable again');
}

// ---- 0b. DELETE: cells directly; incident patches from selected edges or vertices ---------------------------
{
  const base = freshGrid();
  const added = appendStandalonePatch(base, [25, 10, -40], [0, 1, 0]);
  const q = added.quad, [A, B] = added.vertices;
  added.doc.edgeHandles = { ...(added.doc.edgeHandles ?? {}), [`${A}>${B}`]: [3, 0, 0] };
  added.doc.quadPaint = { ...(added.doc.quadPaint ?? {}), [q]: 7 };
  added.doc.quadTex = { ...(added.doc.quadTex ?? {}), [q]: 'TEST/DELETE.png' };

  check(JSON.stringify(meshDeleteTargets(added.doc, { vertices: [A] })) === JSON.stringify([q]),
    'delete: one selected point targets every patch incident to it');
  check(JSON.stringify(meshDeleteTargets(added.doc, { vertices: added.vertices })) === JSON.stringify([q]),
    'delete: all corners of a free-standing patch still de-duplicate to exactly that patch');
  check(JSON.stringify(meshDeleteTargets(added.doc, { edges: [[A, B]] })) === JSON.stringify([q]),
    'delete: a rim edge targets its one incident patch');
  check(JSON.stringify(meshDeleteTargets(added.doc, { quads: [q] })) === JSON.stringify([q]),
    'delete: a selected cell targets itself');

  const interior = base.quads[0];
  const edgeTargets = meshDeleteTargets(base, { edges: [[interior[1], interior[3]]] });
  check(edgeTargets.length === 2 && edgeTargets.includes(0),
    'delete: an interior edge targets the patches on both sides');

  const deleted = applyMeshDelete(added.doc, { vertices: added.vertices });
  check(deleted.ok && deleted.quads === 1 && deleted.vertices === 4,
    'delete: a complete vertex selection removes one patch and its four now-unused vertices');
  if (deleted.ok) {
    check(deleted.doc.quads.length === Q0 && deleted.doc.vertices.length / 3 === V0,
      'delete: compaction restores the pre-patch topology without orphan vertices');
    check(deleted.doc.edgeHandles?.[`${A}>${B}`] === undefined
      && deleted.doc.quadPaint?.[q] === undefined && deleted.doc.quadTex?.[q] === undefined,
      'delete: discarded handles and patch metadata do not survive compaction');
    check(added.doc.quads.length === Q0 + 1 && added.doc.vertices.length / 3 === V0 + 4,
      'delete: source document is untouched');
  }

  const looseId = base.vertices.length / 3;
  const withLoose: QuadMeshDoc = { ...base, vertices: [...base.vertices, 500, 500, 500] };
  const loose = applyMeshDelete(withLoose, { vertices: [looseId] });
  check(loose.ok && loose.quads === 0 && loose.vertices === 1
    && loose.doc.quads.length === Q0 && loose.doc.vertices.length / 3 === V0,
    'delete: a genuinely loose selected point is removed without deleting a patch');

  const edgeA = base.vertices.length / 3, edgeB = edgeA + 1;
  const withFreeEdge: QuadMeshDoc = {
    ...base,
    vertices: [...base.vertices, 500, 500, 500, 510, 500, 500],
    freeEdges: [[edgeA, edgeB]],
  };
  const deletedEdge = applyMeshDelete(withFreeEdge, { edges: [[edgeA, edgeB]] });
  check(deletedEdge.ok && deletedEdge.quads === 0 && deletedEdge.vertices === 2
    && deletedEdge.doc.freeEdges === undefined && deletedEdge.doc.vertices.length === base.vertices.length,
    'delete: a selected free edge and its now-unused endpoints are removed without touching surfaces');

  const onePatch: QuadMeshDoc = {
    ...base,
    vertices: added.doc.vertices.slice(A * 3, (A + 4) * 3),
    quads: [[0, 1, 2, 3]],
    edgeHandles: undefined, quadPaint: undefined, quadTex: undefined, quadOrient: undefined, quadTwist: undefined,
  };
  const final = applyMeshDelete(onePatch, { quads: [0] });
  check(!final.ok, 'delete: the mountain’s final surface patch is protected');
}

// ---- 0b. DISSOLVE: fuse to four strong corners; skipped neighbor points become diagnosed T-junctions ------
{
  const doc = freshGrid(), cols = GRID_COLS;
  const edge: [number, number] = [3 * cols + 2, 3 * cols + 3];
  const dissolvedEdge = applyMeshDissolve(doc, { edges: [edge] });
  const edgeTJunctions = dissolvedEdge.ok ? findTJunctions(dissolvedEdge.doc) : [];
  check(dissolvedEdge.ok && dissolvedEdge.doc.quads.length === doc.quads.length - 1 && edgeTJunctions.length === 2,
    'dissolve edge: a six-point two-quad boundary keeps four corners and diagnoses two skipped side points');
  const vertex = 4 * cols + 4;
  const dissolvedPoint = applyMeshDissolve(doc, { vertices: [vertex] });
  const pointTJunctions = dissolvedPoint.ok ? findTJunctions(dissolvedPoint.doc) : [];
  check(dissolvedPoint.ok && dissolvedPoint.doc.quads.length === doc.quads.length - 3 && pointTJunctions.length === 4,
    'dissolve point: an eight-point fan keeps four outer corners and diagnoses four skipped side points');

  const twoPatch: QuadMeshDoc = {
    ...doc,
    vertices: [0, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 20, 0, 0, 20, 0, 10],
    quads: [[0, 1, 2, 3], [2, 3, 4, 5]],
    edgeHandles: undefined, quadPaint: undefined, quadTex: undefined, quadOrient: undefined, quadTwist: undefined,
  };
  const isolated = applyMeshDissolve(twoPatch, { edges: [[2, 3]] });
  check(isolated.ok && isolated.doc.quads.length === 1 && isolated.doc.vertices.length / 3 === 4
    && findTJunctions(isolated.doc).length === 0,
  'dissolve edge: an isolated two-quad strip drops its now-unused side points and becomes one clean quad');

  const wedgePair: QuadMeshDoc = {
    ...twoPatch,
    vertices: [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10],
    quads: [[0, 1, 2, 2], [0, 2, 3, 3]],
  };
  const cleaned = applyMeshDissolve(wedgePair, { edges: [[0, 2]] });
  check(cleaned.ok && cleaned.doc.quads.length === 1 && new Set(cleaned.doc.quads[0]).size === 4,
    'dissolve edge: two temporary wedges cleanly fuse back into one quad with no skipped boundary vertex');
}

// ---- 0c. VERTEX CLIPBOARD: shared authored/reference source, exact shape + sparse maps ----------------------
{
  const center: V3 = [10, 20, 30], target: V3 = [50, 60, 70];
  check(JSON.stringify(clipboardPlacementOffset(target, center, 'z')) === JSON.stringify([40, 40, 0]),
    'clipboard placement: an XY view preserves every pasted vertex Z by applying zero Z translation');
  check(JSON.stringify(clipboardPlacementOffset(target, center, 'y')) === JSON.stringify([40, 0, 40])
    && JSON.stringify(clipboardPlacementOffset(target, center, 'x')) === JSON.stringify([0, 40, 40]),
    'clipboard placement: XZ and YZ views likewise preserve their hidden dimensions');
  check(JSON.stringify(clipboardPlacementOffset(target, center, null)) === JSON.stringify([40, 40, 40]),
    'clipboard placement: a free-angle view still accepts pointer depth on all three dimensions');
  const axisCamera = new THREE.PerspectiveCamera();
  axisCamera.position.set(0, 0, 10); axisCamera.lookAt(0, 0, 0); axisCamera.updateMatrixWorld();
  check(lockedViewAxis(axisCamera) === 'z', 'clipboard placement: an exact XY camera is recognized as Z-locked');
  axisCamera.position.set(10, 10, 10); axisCamera.lookAt(0, 0, 0); axisCamera.updateMatrixWorld();
  check(lockedViewAxis(axisCamera) === null, 'clipboard placement: a free-angle camera does not acquire a hidden axis');

  const source = freshGrid();
  const selected = [...new Set(source.quads[0])];
  const [A, B] = source.quads[0];
  source.edgeHandles = { [`${A}>${B}`]: [2.25, 0.5, -1] };
  source.quadTwist = { 0: [[0.5, 1, 0], [0, -0.25, 0.75], [0.2, 0, -0.4], [-0.1, 0.3, 0]] };
  source.quadPaint = { 0: 7 };
  source.quadTex = { 0: 'TEST/0042.png' };
  source.quadOrient = { 0: { rot: 3, mirror: true } };
  const { mesh, edgeHandle } = meshFromDoc(source);
  const exact = quadControlPoints(mesh, edgeHandle, 0, source.quadTwist[0]);
  const offset: V3 = [100, 5, -30];
  const clip = copyMeshVertices({
    mesh, naming: INDEX_NAMING, selectedVertices: selected, edgeHandle, offset,
    controls: q => quadControlPoints(mesh, edgeHandle, q, source.quadTwist?.[q] ?? null),
    paint: q => source.quadPaint?.[q], texture: q => source.quadTex?.[q], orientation: q => source.quadOrient?.[q],
  });
  check(!!clip && clip.vertices.length === 12 && clip.quads.length === 1,
    'vertex clipboard: four selected vertices carry their fully enclosed patch');
  if (clip) {
    const copiedMesh = buildQuadMesh(clip.vertices, clip.quads);
    const copiedHandle = meshEdgeHandles(copiedMesh, clip.edgeHandles);
    const copiedCP = quadControlPoints(copiedMesh, copiedHandle, 0, clip.quadTwist?.[0] ?? null);
    const shapeExact = copiedCP.every((p, i) => len(sub(p, add(exact[i], offset))) < 1e-8);
    check(shapeExact, 'vertex clipboard: effective boundary handles + interior twist preserve all 16 control points');
    check(clip.quadPaint?.[0] === 7 && clip.quadTex?.[0] === 'TEST/0042.png'
      && clip.quadOrient?.[0]?.rot === 3 && clip.quadOrient[0].mirror,
      'vertex clipboard: patch surface, texture and orientation metadata follow the copied patch');

    const target = freshGrid(), v0 = target.vertices.length / 3, q0 = target.quads.length;
    const placement: V3 = [12, -3, 8];
    const pasted = pasteMeshVertices(target, clip, placement);
    check(pasted.vertices.length === 4 && pasted.vertices[0] === v0 && pasted.quads[0] === q0,
      'vertex clipboard: paste reports the stable appended ids for immediate selection');
    check(JSON.stringify(pasted.doc.quads[q0]) === JSON.stringify(clip.quads[0].map(v => v + v0)),
      'vertex clipboard: paste re-keys clipboard-local topology onto the target document');
    check(len(sub(getVertex(pasted.doc, v0), add([clip.vertices[0], clip.vertices[1], clip.vertices[2]], placement))) < 1e-9,
      'vertex clipboard: placement translates pasted vertices from the ghost centroid without changing shape vectors');
    check(pasted.doc.edgeHandles?.[`${v0}>${v0 + 1}`] !== undefined
      && pasted.doc.quadTwist?.[q0] !== undefined && pasted.doc.quadPaint?.[q0] === 7,
      'vertex clipboard: paste re-keys shape and patch maps with the appended geometry');
  }

  const loose = copyMeshVertices({ mesh, naming: INDEX_NAMING, selectedVertices: selected.slice(0, 2), selectedEdges: [[A, B]], edgeHandle });
  check(!!loose && loose.vertices.length === 6 && loose.quads.length === 0 && loose.freeEdges?.length === 1,
    'clipboard: a selected edge keeps its endpoints and explicit free-edge topology without inventing a patch');
  const looseText = loose ? JSON.parse(meshClipboardText(loose, {
    source: 'reference', level: 'DONOR', referenceOffset: [100, 0, 0],
  })) : null;
  check(looseText?.format === 'slopesmith-mesh-selection' && looseText.referenceLevel === 'DONOR'
    && looseText.referenceOffset?.[0] === 100 && looseText.selection.edges?.[0]?.bezier?.length === 4,
  'clipboard text: a reference edge exposes its level, placement offset, vertices, and exact cubic controls');
  if (loose) {
    const target = freshGrid(), v0 = target.vertices.length / 3;
    const pasted = pasteMeshVertices(target, loose);
    check(pasted.vertices.length === 2 && pasted.doc.vertices.length / 3 === v0 + 2
      && pasted.doc.quads.length === target.quads.length
      && JSON.stringify(pasted.freeEdges) === JSON.stringify([[v0, v0 + 1]])
      && JSON.stringify(pasted.doc.freeEdges) === JSON.stringify([[v0, v0 + 1]]),
    'clipboard: an edge paste re-keys one selectable free edge onto its appended vertices');
    const pastedMesh = meshFromDoc(pasted.doc), cage = meshCageEdges(pastedMesh.mesh, pastedMesh.edgeHandle);
    check(pastedMesh.mesh.freeEdges.length === 1 && cage.boundary.length > 0
      && pasted.doc.edgeHandles?.[`${v0}>${v0 + 1}`] !== undefined,
    'clipboard: the pasted free edge renders as its preserved curved cage wire');
  }
  const edgeLoop = copyMeshVertices({ mesh, naming: INDEX_NAMING, selectedVertices: selected, selectedQuads: [],
    selectedEdges: [[selected[0], selected[1]], [selected[1], selected[3]], [selected[3], selected[2]], [selected[2], selected[0]]], edgeHandle });
  check(!!edgeLoop && edgeLoop.vertices.length === 12 && edgeLoop.quads.length === 0 && edgeLoop.freeEdges?.length === 4,
    'clipboard: an explicit edge loop stays four free edges even when its endpoints enclose a patch');
  const sevenAlongLoop = copyMeshVertices({ mesh, naming: INDEX_NAMING, selectedVertices: [0, 1, 2, 3, 4, 5, 6], edgeHandle });
  check(!!sevenAlongLoop && sevenAlongLoop.vertices.length === 21 && sevenAlongLoop.quads.length === 0
    && sevenAlongLoop.freeEdges?.length === 6,
    'clipboard: seven connected loop vertices infer and preserve their six intervening free edges');
  const surface = copyMeshVertices({ mesh, naming: INDEX_NAMING, selectedVertices: selected, selectedQuads: [0], edgeHandle });
  check(!!surface && surface.quads.length === 1,
    'vertex clipboard: an explicit surface selection carries exactly its selected patch');
  const orphan = source.quads[10].find(id => !selected.includes(id))!;
  const mixed = copyMeshVertices({ mesh, naming: INDEX_NAMING, selectedVertices: [...selected, orphan], edgeHandle });
  check(!!mixed && mixed.vertices.length === 15 && mixed.quads.length === 1,
    'vertex clipboard: selected loose points remain alongside fully enclosed patches');
}

console.log(failures ? '\nMESHOPS-EDIT: FAIL' : '\nMESHOPS-EDIT: PASS');
process.exit(failures ? 1 : 0);
