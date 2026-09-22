/**
 * Headless checks for the topology-surgery ops that ADD geometry (src/core/mesh/ops, docs/017): the
 * standalone/drawn patch, the tube, mesh-native free edges, the edge and patch extrusions, the rip that
 * un-stitches an interior path, and the loop weld that closes an annular gap.
 * Run: `npx tsx test/meshops-create.test.ts`
 *
 * Split out of test/meshops.test.ts; the grid fixture and the `check()` tally live in
 * test/meshops.fixture.ts, shared with the other `meshops-*` checks.
 */
import * as THREE from 'three';
import { applyBrush, applyGrabBrush, applyPushBrush, brushFalloffWeight, createFlattenBrushPlane, createGrabBrushState, migrateMountain, surfaceBrushDistances } from '../src/core/doc/mountain';
import { meshFromDoc, quadControlPoints, buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../src/core/mesh/topology';
import { cubicPoint } from '../src/core/math/bezier';
import { add, cross, dot, len, mul, norm, sub } from '../src/core/math/vec';
import { applyEdgeRip, applyEdgeWeld, applyEdgeWeldSets, applyEdgeLoopWeld, boundaryEdgeLoopVertices, applyVertexWeld, applyVertexWeldTogether, applyEdgeCrossingWeld, autoWeldCreatedEdgeCrossings, appendStandalonePatch, appendPatchFromCorners, appendFreeEdge, appendTube, validateSurfaceCutPath, routeSurfaceCutPath, applySurfaceCut, standalonePatchCorners, DEFAULT_STANDALONE_PATCH_SIZE_M, planEdgeExtrusion, planPatchExtrusion, edgeExtrusionSegmentCount, edgeExtrusionPreviewDoc, edgeExtrusionPlacementPreviewDoc, translatedEdgeExtrusionPlacement, tangentEdgeExtrusionPlacement, applyEdgeExtrusion, applyPatchExtrusion, applyPlannedEdgeExtrusion, applyMeshDelete, applyMeshDissolve, checkManifold, ekey } from '../src/core/mesh/ops';
import { getVertex } from '../src/core/doc/doc-edit';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { constrainPlacement } from '../src/app/viewport/input/placement-constraint';
import { edgeConnectedFrame, resolveGizmoFrame } from '../src/app/viewport/gizmo/transform';
import { hoveredGizmoPivot } from '../src/app/viewport/camera/controller';
import { edgeExtrusionOccludingSourceQuads } from '../src/app/viewport/tools/edge-extrusion';
import { findTJunctions, reconcileTJunctionGeometry, remapTJunctionsForEdgeSplits, T_JUNCTION_TOLERANCE_M } from '../src/core/mesh/t-junctions';
import { findEdgeCrossings } from '../src/core/mesh/edge-crossings';
import { coincidentVertexGroup, findCoincidentVertices } from '../src/core/mesh/coincident-vertices';
import { watertight, normalsAgreeAcrossSeams, hasNaN, grid, GRID_COLS, freshGrid, cellCols, V0, Q0 } from './meshops.fixture';
import { check, failures } from './check';

// ---- 0. CREATE PATCH: append one disconnected tangent square without disturbing existing ids / maps --------
{
  const doc = freshGrid();
  const center: V3 = [12, 34, 56], normal = norm([0.2, 1, -0.3]), size = 18;
  const beforeVertices = doc.vertices.slice(), beforeQuads = doc.quads.map(q => q.slice());
  const r = appendStandalonePatch(doc, center, normal, size);
  check(r.doc !== doc, 'create patch: returns a new document');
  check(doc.vertices.length === beforeVertices.length && doc.quads.length === beforeQuads.length,
    'create patch: source document is untouched');
  check(r.doc.vertices.length / 3 === V0 + 4 && r.doc.quads.length === Q0 + 1,
    'create patch: appends four vertices and one quad');
  check(r.quad === Q0 && r.vertices.every((v, i) => v === V0 + i),
    'create patch: reports stable appended quad / vertex ids');
  check(beforeVertices.every((v, i) => r.doc.vertices[i] === v)
    && beforeQuads.every((q, i) => q.every((v, k) => r.doc.quads[i][k] === v)),
    'create patch: all existing geometry ids and values stay unchanged');
  const [A, B, C, D] = standalonePatchCorners(center, normal, size);
  const inPlane = [A, B, C, D].every(p => Math.abs(dot(sub(p, center), normal)) < 1e-8);
  check(inPlane, 'create patch: every corner lies in the clicked tangent plane');
  check(Math.abs(len(sub(B, A)) - size) < 1e-8 && Math.abs(len(sub(C, A)) - size) < 1e-8,
    'create patch: both sides equal the requested nominal patch size');
  check(dot(norm(cross(sub(C, A), sub(B, A))), normal) < -0.999999,
    'create patch: A/B/C/D ordering produces the document winding');
  const defaultPatch = appendStandalonePatch(doc, center, normal);
  const [dA, dB, dC] = defaultPatch.vertices.map(v => getVertex(defaultPatch.doc, v));
  check(Math.abs(len(sub(dB, dA)) - DEFAULT_STANDALONE_PATCH_SIZE_M) < 1e-8
    && Math.abs(len(sub(dC, dA)) - DEFAULT_STANDALONE_PATCH_SIZE_M) < 1e-8,
    'create patch: default size is 30 × 30 m');
  const pv = buildMountainPreview(r.doc);
  check(!pv.positions.some(x => !Number.isFinite(x)), 'create patch: derived quilt has no NaN');
}

// ---- 0a. DRAW PATCH: four perimeter clicks can mix new points and reused mesh vertices --------------------
{
  const empty: QuadMeshDoc = { ...freshGrid(), vertices: [], quads: [] };
  const drawn = appendPatchFromCorners(empty, [[0, 0, 0], [0, 0, 10], [12, 0, 10], [12, 0, 0]]);
  check(drawn.ok && drawn.doc.vertices.length === 12 && drawn.doc.quads[0]?.join(',') === '0,1,3,2',
    'draw patch: four perimeter clicks append one correctly ordered quad');
  check(empty.vertices.length === 0 && empty.quads.length === 0, 'draw patch: source document is untouched');

  const framed: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 0, 0, 10, 12, 0, 10, 12, 0, 0],
    freeEdges: [[0, 1], [1, 2], [2, 3], [0, 3]],
  };
  const filled = appendPatchFromCorners(framed, [0, 1, 2, 3]);
  check(filled.ok && filled.doc.vertices.length === framed.vertices.length && !filled.doc.freeEdges?.length,
    'draw patch: four existing vertices are reused and their perimeter free edges are consumed');
  if (filled.ok) check(!appendPatchFromCorners(filled.doc, [0, 1, 2, 3]).ok,
    'draw patch: an already-filled four-vertex boundary is refused');

  const triangle = appendPatchFromCorners(empty, [[0, 0, 0], [10, 0, 0], [4, 0, 8]]);
  check(triangle.ok && triangle.doc.vertices.length === 9 && triangle.doc.quads[0]?.join(',') === '0,1,2,2',
    'draw patch: three perimeter clicks append one valid wedge-encoded triangle');
  if (triangle.ok) {
    check(checkManifold(triangle.doc.quads).ok && watertight(triangle.doc).boundary === 3,
      'draw patch: a triangle has three boundary edges and remains manifold');
    check(!buildMountainPreview(triangle.doc).positions.some(x => !Number.isFinite(x)),
      'draw patch: the derived triangular patch remains finite');
  }
  const triangleFrame: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 10, 0, 0, 4, 0, 8],
    freeEdges: [[0, 1], [1, 2], [0, 2]],
  };
  const filledTriangle = appendPatchFromCorners(triangleFrame, [0, 1, 2]);
  check(filledTriangle.ok && !filledTriangle.doc.freeEdges?.length,
    'draw patch: a triangle reuses existing vertices and consumes its three perimeter free edges');
  if (filled.ok) {
    const joined = appendPatchFromCorners(filled.doc, [1, 0, [-6, 0, 5]]);
    check(joined.ok && checkManifold(joined.doc.quads).ok && normalsAgreeAcrossSeams(joined.doc),
      'draw patch: a triangle can share a boundary edge with a quad to join differently directed patch regions');
    if (joined.ok) {
      const shared = joined.doc.quads.filter(q => {
        const perimeter = [[q[0], q[1]], [q[1], q[3]], [q[3], q[2]], [q[2], q[0]]];
        return perimeter.some(([a, b]) => a !== b && ekey(a, b) === ekey(0, 1));
      }).length;
      check(shared === 2 && !buildMountainPreview(joined.doc).positions.some(x => !Number.isFinite(x)),
        'draw patch: the triangle/quad seam is shared exactly twice and derives a finite surface');
      check(!appendPatchFromCorners(joined.doc, [0, 1, [-6, 0, -5]]).ok,
        'draw patch: a third patch on the joined triangle/quad seam is refused');
    }
    const autoOriented = appendPatchFromCorners(filled.doc, [0, 1, [-6, 0, 5]]);
    check(autoOriented.ok && normalsAgreeAcrossSeams(autoOriented.doc),
      'draw patch: a connected patch clicked in the same edge direction is reversed to match its neighbor normal');
  }

  const locked = constrainPlacement({ pos: [7, 3, -2], vertex: 9 }, [1, 1, 1], true);
  check(locked.pos.join(',') === '7,1,1' && locked.vertex === null,
    'placement axis lock: Shift keeps only the dominant world-axis delta and drops an off-axis vertex snap');
  const aligned = constrainPlacement({ pos: [1, 1, 8], vertex: 4 }, [1, 1, 1], true);
  check(aligned.pos.join(',') === '1,1,8' && aligned.vertex === 4,
    'placement axis lock: an existing vertex already on the locked axis is still reused');
  check(resolveGizmoFrame('local', false) === 'local' && resolveGizmoFrame('surface', false) === 'surface',
    'transform frame: Local stays slope-aligned without becoming the constrained Surface mode');
  check(resolveGizmoFrame('local', true) === 'world' && resolveGizmoFrame('surface', true) === 'world',
    'transform frame: Shift temporarily forces either slope-aligned mode to World');
  const freeLine = buildQuadMesh([0, 2, 0, 8, 5, 4], [], [[0, 1]]);
  const freeAdj = meshAdjacency(freeLine);
  const freeA = edgeConnectedFrame(freeLine.vertices, freeAdj, 0);
  const freeB = edgeConnectedFrame(freeLine.vertices, freeAdj, 1);
  check(!!freeA && !!freeB && freeA.tu.dot(freeB.tu) > 0.999999 && Math.abs(freeA.tu.dot(freeA.n)) < 1e-9,
    'transform frame: both points of a surface-less free edge derive the same orthonormal Local frame');
  const verticalLine = buildQuadMesh([0, 0, 0, 0, 10, 0], [], [[0, 1]]);
  const verticalFrame = edgeConnectedFrame(verticalLine.vertices, meshAdjacency(verticalLine), 0);
  check(!!verticalFrame && verticalFrame.n.lengthSq() > 0.999999 && Math.abs(verticalFrame.tu.dot(verticalFrame.n)) < 1e-9,
    'transform frame: a vertical free edge gets a stable perpendicular Local-up fallback');
  const pivotParent = new THREE.Group(), pivotHandle = new THREE.Object3D();
  pivotParent.position.set(10, 20, 30); pivotHandle.position.set(2, 3, 4); pivotParent.add(pivotHandle);
  const gizmoPivot = hoveredGizmoPivot({ enabled: true, axis: 'X', object: pivotHandle });
  check(gizmoPivot?.toArray().join(',') === '12,23,34',
    'camera orbit: an RMB drag over a gizmo uses the attached handle world position as its pivot');
  check(hoveredGizmoPivot({ enabled: true, axis: null, object: pivotHandle }) === null,
    'camera orbit: off-gizmo RMB keeps the ordinary cursor-surface pivot path');

  const wall: QuadMeshDoc = {
    ...freshGrid(),
    vertices: [
      0, 0, 0, 0, 0, 10, 0, 10, 0, 0, 10, 10,
      100, 0, 0, 100, 0, 10, 100, 10, 0, 100, 10, 10,
    ],
    quads: [[0, 1, 2, 3], [4, 5, 6, 7]],
  };
  const wallDistance = surfaceBrushDistances(wall, [0, 1, 5], 8, 0);
  check(Number.isFinite(wallDistance[0]) && Number.isFinite(wallDistance[1])
    && wallDistance[2] === Infinity && wallDistance[3] === Infinity,
    'surface brush: a wall footprint uses vertical surface distance instead of selecting every shared XZ row');
  check([...wallDistance.slice(4)].every(d => d === Infinity),
    'surface brush: a footprint seeded on one patch cannot jump to disconnected stacked geometry');
  const raisedWall = structuredClone(wall);
  applyBrush(raisedWall, 'raise', [0, 1, 5], 8, 2, 'vertical', 0);
  check(raisedWall.vertices[1] > wall.vertices[1] && raisedWall.vertices[4] > wall.vertices[4]
    && raisedWall.vertices[7] === wall.vertices[7] && raisedWall.vertices[13] === wall.vertices[13],
    'surface brush: the dab deforms only corners inside its connected intrinsic radius');
  check(Math.abs(brushFalloffWeight('smooth', 0.5) - 0.5625) < 1e-12
    && Math.abs(brushFalloffWeight('linear', 0.5) - 0.5) < 1e-12
    && Math.abs(brushFalloffWeight('sharp', 0.5) - 0.25) < 1e-12
    && Math.abs(brushFalloffWeight('constant', 0.5) - 1) < 1e-12,
    'brush falloff: smooth preserves the original bell while linear, sharp, and constant expose distinct profiles');
  check(brushFalloffWeight('smooth', 0) === 1 && brushFalloffWeight('linear', 0) === 1
    && brushFalloffWeight('sharp', 0) === 1 && brushFalloffWeight('constant', 0) === 1
    && brushFalloffWeight('smooth', 1) === 0 && brushFalloffWeight('linear', 1) === 0
    && brushFalloffWeight('sharp', 1) === 0 && brushFalloffWeight('constant', 1) === 0,
    'brush falloff: every profile is full strength at the centre and stops at the footprint edge');
  const grabState = createGrabBrushState(wall, [0, 1, 5], 8, 0, 'constant');
  const grabbedWall = structuredClone(wall);
  applyGrabBrush(grabbedWall, grabState, [2, 3, 4]);
  check(grabbedWall.vertices.slice(0, 6).join(',') === '2,3,4,2,3,14'
    && grabbedWall.vertices.slice(6).join(',') === wall.vertices.slice(6).join(','),
    'grab brush: a view-plane displacement moves only the captured connected footprint');
  applyGrabBrush(grabbedWall, grabState, [-1, 2, -3]);
  check(grabbedWall.vertices.slice(0, 6).join(',') === '-1,2,-3,-1,2,7',
    'grab brush: each drag update evaluates from frozen press positions instead of accumulating frame deltas');
  const pushedWall = structuredClone(wall);
  applyPushBrush(pushedWall, [0, 1, 5], 8, 0, 'constant', [2, 3, 4], [1, 0, 0], 0.5);
  check(pushedWall.vertices.slice(0, 6).join(',') === '0,1.5,2,0,1.5,12'
    && pushedWall.vertices.slice(6).join(',') === wall.vertices.slice(6).join(','),
    'push brush: each live footprint moves along the hit tangent and cannot cross to disconnected terrain');
  const unevenWall = structuredClone(wall);
  unevenWall.vertices[0] = 2; unevenWall.vertices[3] = -2;
  unevenWall.vertices[6] = 2; unevenWall.vertices[9] = 4;
  const heightFlat = structuredClone(unevenWall);
  applyBrush(heightFlat, 'flatten', [0, 5, 5], 20, 1, 'vertical', 0, 'constant', 'height', [1, 0, 0]);
  check(heightFlat.vertices[0] === 2 && heightFlat.vertices[1] === 1.75
    && heightFlat.vertices[7] === 8.25,
    'flatten modes: height preserves XZ and retains the original horizontal world-Y behavior');
  const surfaceFlat = structuredClone(unevenWall);
  applyBrush(surfaceFlat, 'flatten', [0, 5, 5], 20, 1, 'vertical', 0, 'constant', 'surface', [1, 0, 0]);
  check(Math.abs(surfaceFlat.vertices[0] - 1.3) < 1e-12
    && Math.abs(surfaceFlat.vertices[3] + 1.3) < 1e-12
    && surfaceFlat.vertices[1] === unevenWall.vertices[1] && surfaceFlat.vertices[2] === unevenWall.vertices[2],
    'flatten modes: surface projects in 3D toward the clicked tangent plane instead of changing only height');
  const areaFlat = structuredClone(unevenWall);
  const centroid = (vertices: number[], axis: number) =>
    (vertices[axis] + vertices[axis + 3] + vertices[axis + 6] + vertices[axis + 9]) / 4;
  const beforeCentroid: V3 = [centroid(areaFlat.vertices, 0), centroid(areaFlat.vertices, 1), centroid(areaFlat.vertices, 2)];
  applyBrush(areaFlat, 'flatten', [0, 5, 5], 20, 1, 'vertical', 0, 'constant', 'area', [1, 0, 0]);
  const afterCentroid: V3 = [centroid(areaFlat.vertices, 0), centroid(areaFlat.vertices, 1), centroid(areaFlat.vertices, 2)];
  check(areaFlat.vertices.slice(0, 12).some((v, i) => Math.abs(v - unevenWall.vertices[i]) > 1e-9)
    && afterCentroid.every((v, axis) => Math.abs(v - beforeCentroid[axis]) < 1e-9),
    'flatten modes: area fits the footprint trend while preserving its weighted centre');
  const originalPlane = createFlattenBrushPlane(wall, [0, 5, 5], 20, 0, 'constant', 'height', [0, 1, 0]);
  const lockedFlat = structuredClone(wall);
  applyBrush(lockedFlat, 'flatten', [100, 10, 5], 20, 1, 'vertical', 1, 'constant', 'height', [0, 1, 0], originalPlane);
  check(lockedFlat.vertices[13] === 1.75 && lockedFlat.vertices[19] === 8.25
    && lockedFlat.vertices.slice(0, 12).join(',') === wall.vertices.slice(0, 12).join(','),
    'flatten plane lock: a later dab on another surface still levels toward the plane sampled on press');
  const followingFlat = structuredClone(wall);
  applyBrush(followingFlat, 'flatten', [100, 10, 5], 20, 1, 'vertical', 1, 'constant', 'height', [0, 1, 0]);
  check(followingFlat.vertices[13] === 3.5 && followingFlat.vertices[19] === 10,
    'flatten plane follow: without a locked plane each dab resamples its target under the cursor');

  const detailedWall = structuredClone(wall);
  detailedWall.edgeHandles = {
    '0>1': [0, 3, 3], '1>0': [0, -2, -3],
    '0>2': [1, 3, 0], '2>0': [-1, -3, 0],
  };
  detailedWall.quadTwist = { 0: [[0, 4, 0], [2, -3, 0], [-2, 2, 1], [0, -4, -1]] };
  const beforeDetailed = meshFromDoc(detailedWall);
  const beforeDetailedCp = quadControlPoints(
    beforeDetailed.mesh, beforeDetailed.edgeHandle, 0, detailedWall.quadTwist[0],
  );
  const cageFlat = structuredClone(detailedWall);
  applyBrush(cageFlat, 'flatten', [0, 0, 5], 20, 1, 'vertical', 0, 'constant', 'height', [0, 1, 0], null, 0.5, 0.2);
  const afterDetailed = meshFromDoc(cageFlat);
  const afterDetailedCp = quadControlPoints(afterDetailed.mesh, afterDetailed.edgeHandle, 0, cageFlat.quadTwist?.[0]);
  check(afterDetailedCp.every((cp, i) => Math.abs(cp[1] - beforeDetailedCp[i][1] * 0.8) < 1e-9),
    'control-point-aware flatten: amount moves all 16 effective Bezier controls, not only corners');

  const smoothDetail = structuredClone(detailedWall);
  const originalHandle = [...smoothDetail.edgeHandles!['0>1']] as V3;
  applyBrush(smoothDetail, 'smooth', [0, 5, 5], 20, 1, 'vertical', 0, 'constant', 'height', [0, 1, 0], null, 0.25);
  const smoothMesh = buildQuadMesh(smoothDetail.vertices, smoothDetail.quads, smoothDetail.freeEdges);
  const automaticHandle = meshEdgeHandles(smoothMesh)(0, 1);
  const expectedHandle = originalHandle.map((v, axis) => v * 0.75 + automaticHandle[axis] * 0.25);
  const relaxedHandle = smoothDetail.edgeHandles?.['0>1'];
  check(!!relaxedHandle
    && relaxedHandle.every((v, axis) => Math.abs(v - expectedHandle[axis]) < 1e-9)
    && smoothDetail.quadTwist?.[0][0].join(',') === '0,3,0',
    'control-point-aware smooth: amount relaxes explicit boundary handles and interior twists toward the automatic cage');

  const raisedDetail = structuredClone(detailedWall);
  const detailBeforeRaise = JSON.stringify({ handles: raisedDetail.edgeHandles, twist: raisedDetail.quadTwist });
  applyBrush(raisedDetail, 'raise', [0, 5, 5], 20, 2, 'vertical', 0, 'constant');
  check(JSON.stringify({ handles: raisedDetail.edgeHandles, twist: raisedDetail.quadTwist }) === detailBeforeRaise,
    'control-point-aware displacement: broad raise preserves authored handle and interior detail offsets');
  const pushedDetail = structuredClone(detailedWall);
  const detailBeforePush = JSON.stringify({ handles: pushedDetail.edgeHandles, twist: pushedDetail.quadTwist });
  applyPushBrush(pushedDetail, [0, 5, 5], 20, 0, 'constant', [0, 2, 3], [1, 0, 0], 0.5);
  check(JSON.stringify({ handles: pushedDetail.edgeHandles, twist: pushedDetail.quadTwist }) === detailBeforePush,
    'control-point-aware push: tangent shoving preserves authored handle and interior detail offsets');
}

// ---- 0b. CREATE TUBE: draw its axis and derive a manifold elliptical quad shell ---------------------------
{
  const empty: QuadMeshDoc = { ...freshGrid(), vertices: [], quads: [] };
  const tube = appendTube(empty, [0, 2, 0], [25, 2, 0], 12, 8, 6);
  check(tube.ok, 'create tube: a valid drawn axis produces an elliptical quad tube');
  if (tube.ok) {
    check(tube.axialSections === 5 && tube.radialSections === 4
      && tube.doc.quads.length === tube.axialSections * tube.radialSections,
    'create tube: section length sizes the axis while ring edges default to four');
    check(tube.doc.vertices.length / 3 === (tube.axialSections + 1) * tube.radialSections
      && watertight(tube.doc).boundary === tube.radialSections * 2,
    'create tube: rings share their seam and only the two open ends are boundaries');
    const firstRing = tube.vertices.slice(0, tube.radialSections).map(vertex => getVertex(tube.doc, vertex));
    const ys = firstRing.map(point => point[1]), zs = firstRing.map(point => point[2]);
    check(Math.abs(Math.max(...ys) - Math.min(...ys) - 8) < 1e-8
      && Math.abs(Math.max(...zs) - Math.min(...zs) - 12) < 1e-8,
    'create tube: height and width diameters are exact and height follows world-up');
    check(checkManifold(tube.doc.quads).ok && !hasNaN(tube.doc)
      && !buildMountainPreview(tube.doc).positions.some(x => !Number.isFinite(x)),
    'create tube: topology and its derived bicubic surface remain finite and manifold');
  }
  check(!appendTube(empty, [1, 1, 1], [1, 1, 1], 10, 10, 5).ok,
    'create tube: coincident endpoints are refused');
  check(!appendTube(empty, [0, 0, 0], [10, 0, 0], 10, 10, 0).ok,
    'create tube: a non-positive section length is refused');
  const eightSided = appendTube(empty, [0, 0, 0], [25, 0, 0], 10, 10, 6, 8);
  check(eightSided.ok && eightSided.radialSections === 8 && eightSided.doc.quads.length === 40,
    'create tube: ring edges explicitly control the patch columns around the cross-section');
  check(!appendTube(empty, [0, 0, 0], [10, 0, 0], 10, 10, 5, 2).ok,
    'create tube: fewer than three ring edges is refused');
}

// ---- 0c. CREATE EDGE: append mesh-native free edges, optionally reusing snapped vertices -------------------
{
  const empty: QuadMeshDoc = { ...freshGrid(), vertices: [], quads: [] };
  const first = appendFreeEdge(empty, [0, 0, 0], [10, 2, 0]);
  check(first.ok && first.doc.vertices.length === 6 && first.doc.freeEdges?.[0]?.join(',') === '0,1',
    'create edge: two free points append two vertices and one selectable free edge');
  check(empty.vertices.length === 0 && empty.freeEdges === undefined, 'create edge: source document is untouched');
  if (first.ok) {
    const chained = appendFreeEdge(first.doc, first.edge[1], [20, 3, 4]);
    check(chained.ok && chained.doc.vertices.length === 9 && chained.doc.freeEdges?.length === 2
      && chained.edge.join(',') === '1,2' && chained.appendedVertices.join(',') === '2',
      'create edge: a snapped/reused endpoint continues a chain without duplicating its shared vertex');
    check(!appendFreeEdge(first.doc, 0, 1).ok, 'create edge: a duplicate free edge is refused');
  }
  check(!appendFreeEdge(grid, grid.quads[0][0], grid.quads[0][1]).ok,
    'create edge: an existing surface edge is refused instead of duplicated as a free edge');
  check(!appendFreeEdge(empty, [1, 1, 1], [1, 1, 1]).ok, 'create edge: coincident endpoints are refused');

  const surfaceVertex = grid.quads[0][0], beforeMesh = meshFromDoc(grid);
  const beforeHandles = [grid.quads[0][1], grid.quads[0][2]]
    .map(n => [n, beforeMesh.edgeHandle(surfaceVertex, n)] as const);
  const attached = appendFreeEdge(grid, surfaceVertex, [-30, 5, -30]);
  check(attached.ok && beforeHandles.every(([n, h]) => len(sub(meshEdgeHandles(buildQuadMesh(attached.doc.vertices, attached.doc.quads, attached.doc.freeEdges), attached.doc.edgeHandles)(surfaceVertex, n), h)) < 1e-12),
    'create edge: snapping onto a surface vertex preserves its existing boundary tangents exactly');

  const strip: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0, 10, 20, 0, 0, 20, 0, 10],
    quads: [[0, 1, 2, 3], [2, 3, 4, 5]],
  };
  const partial = [{ vertex: 0 }, { edge: [2, 3] as [number, number], t: 0.5 }];
  const looseStrip: QuadMeshDoc = { ...strip, vertices: [...strip.vertices, 123, 45, 67] };
  const cutWithLoosePoint = applySurfaceCut(looseStrip, partial);
  check(cutWithLoosePoint.ok && cutWithLoosePoint.doc.vertices.length / 3 === 8
    && cutWithLoosePoint.doc.vertices.slice(18, 21).join(',') === '123,45,67'
    && cutWithLoosePoint.endVertex < cutWithLoosePoint.doc.vertices.length / 3
    && cutWithLoosePoint.edges.every(edge => edge.every(vertex => vertex < cutWithLoosePoint.doc.vertices.length / 3)),
  'topology compaction: an unrelated surface cut preserves an authored loose point and returns live compacted ids');
  const deleteLoosePoint = applyMeshDelete(looseStrip, { vertices: [6] });
  check(deleteLoosePoint.ok && deleteLoosePoint.doc.vertices.length / 3 === 6,
    'topology compaction: Delete still removes a loose point when that point is explicitly selected');
  const partialPlan = validateSurfaceCutPath(strip, partial);
  const partialCut = applySurfaceCut(strip, partial);
  check(partialPlan.ok && partialPlan.complete && partialCut.ok && findTJunctions(partialCut.doc).length === 1,
    'create edge surface cut: ending inside a shared edge changes only the traversed patch and commits a T-junction');
  const cutPath = [...partial, { edge: [4, 5] as [number, number], t: 0.5 }];
  const cut = applySurfaceCut(strip, cutPath);
  check(cut.ok, 'create edge surface cut: a vertex-to-rim route across two patches commits atomically');
  if (cut.ok) {
    check(cut.edges.length === 2 && cut.doc.vertices.length / 3 === 8,
      'create edge surface cut: both crossed edges are bisected once and both drawn segments are returned');
    const use = (a: number, b: number) => cut.doc.quads.filter(q => {
      const p = [q[0], q[1], q[3], q[2]];
      return p.some((v, i) => ekey(v, p[(i + 1) % 4]) === ekey(a, b));
    }).length;
    check(use(2, 6) === 2 && use(3, 6) === 2,
      'create edge surface cut: both halves of the crossed interior edge remain shared — no T-junction');
    check(cut.wedges >= 1 && checkManifold(cut.doc.quads).ok && !buildMountainPreview(cut.doc).positions.some(x => !Number.isFinite(x)),
      'create edge surface cut: parity wedges are valid temporary patches and the derived surface stays finite');
  }
  check(!validateSurfaceCutPath(strip, [{ vertex: 0 }, { vertex: 1 }]).ok,
    'create edge surface cut: a segment that merely follows an existing patch edge is refused');
  const boundaryStart = [
    { edge: [0, 1] as [number, number], t: 0.5 },
    { edge: [2, 3] as [number, number], t: 0.5 },
    { edge: [4, 5] as [number, number], t: 0.5 },
  ];
  check(validateSurfaceCutPath(strip, boundaryStart.slice(0, 1)).ok
    && validateSurfaceCutPath(strip, [{ edge: [2, 3] as [number, number], t: 0.5 }]).ok,
  'create edge surface cut: an arbitrary outside or inside edge point may start a route');
  const rimToRim = applySurfaceCut(strip, boundaryStart);
  check(rimToRim.ok && rimToRim.edges.length === 2 && rimToRim.doc.vertices.length / 3 === 9,
    'create edge surface cut: an outside-edge start bisects that boundary and commits rim-to-rim without a T-junction');
  const diagonalSource: QuadMeshDoc = { ...strip, quads: [strip.quads[0]] };
  const diagonal = applySurfaceCut(diagonalSource, [{ vertex: 0 }, { vertex: 3 }]);
  check(diagonal.ok && diagonal.doc.quads.length === 2 && diagonal.doc.quads.every(q => new Set(q).size === 3),
    'create edge surface cut: another existing vertex cleanly terminates a cut, with extraordinary valence allowed');
  if (diagonal.ok) {
    const restored = applyMeshDissolve(diagonal.doc, { edges: [[0, 3]] });
    check(restored.ok && restored.doc.quads.length === 1 && new Set(restored.doc.quads[0]).size === 4,
      'create edge surface cut: dissolving the temporary wedge seam restores the original all-quad patch');
  }

  const insideToRim = applySurfaceCut(strip, [
    { edge: [2, 3], t: 0.4 }, { edge: [0, 1], t: 0.6 },
  ]);
  check(insideToRim.ok && findTJunctions(insideToRim.doc).length === 1,
    'create edge surface cut: an interior-edge start leaves the untraversed incident patch untouched');

  const local = freshGrid(), localQ = cellCols + 1;
  const [lA, lB, lC, lD] = local.quads[localQ];
  const hostEdges = [[lA, lB], [lC, lD]] as [number, number][];
  const untouchedNeighbors = local.quads.filter((q, qid) => qid !== localQ && hostEdges.some(([x, y]) => {
    const perimeter = [[q[0], q[1]], [q[1], q[3]], [q[3], q[2]], [q[2], q[0]]] as [number, number][];
    return perimeter.some(([a, b]) => ekey(a, b) === ekey(x, y));
  }));
  const localCut = applySurfaceCut(local, [
    { edge: hostEdges[0], t: 0.35 }, { edge: hostEdges[1], t: 0.65 },
  ]);
  const localJunctions = localCut.ok ? findTJunctions(localCut.doc) : [];
  check(localCut.ok && localCut.doc.vertices.length / 3 === local.vertices.length / 3 + 2
    && localCut.doc.quads.length === local.quads.length + 1 && localCut.wedges === 0,
  'create edge local bisect: one internal quad becomes two quads without propagating extra patches');
  check(localCut.ok && untouchedNeighbors.every(source => localCut.doc.quads.some(q => q.join(',') === source.join(','))),
    'create edge local bisect: adjacent quads remain byte-identical instead of becoming skinny repair patches');
  check(localJunctions.length === 2 && localCut.ok && localCut.doc.tJunctions?.length === 2
    && localJunctions.every(j => hostEdges.some(e => ekey(e[0], e[1]) === ekey(j.edge[0], j.edge[1]))),
    'create edge local bisect: the two internal endpoints remain explicit red-diagnostic T-junctions');
  if (localCut.ok) {
    const before = meshFromDoc(local), after = meshFromDoc(localCut.doc);
    const curve = (source: QuadMeshDoc, edgeHandle: ReturnType<typeof meshFromDoc>['edgeHandle'], a: number, b: number, u: number) => {
      const p0 = getVertex(source, a), p3 = getVertex(source, b);
      return cubicPoint(p0, add(p0, edgeHandle(a, b)), add(p3, edgeHandle(b, a)), p3, u);
    };
    const exact = localJunctions.every(node => Array.from({ length: 17 }, (_, i) => i / 16).every(u => {
      const [a, b] = node.edge, v = node.vertex;
      const parent = curve(local, before.edgeHandle, a, b, u);
      const retainedHost = curve(localCut.doc, after.edgeHandle, a, b, u);
      const child = u <= node.t
        ? curve(localCut.doc, after.edgeHandle, a, v, u / node.t)
        : curve(localCut.doc, after.edgeHandle, v, b, (u - node.t) / (1 - node.t));
      return len(sub(parent, retainedHost)) < 1e-9 && len(sub(parent, child)) < 1e-9;
    }));
    check(exact, 'create edge local bisect: each T-side child cubic exactly matches its retained unsplit host curve');
  }

  const transferredT = remapTJunctionsForEdgeSplits([{ vertex: 9, edge: [1, 4], t: 0.75 }],
    [{ edge: [1, 4], vertex: 8, t: 0.5 }]);
  const resolvedT = remapTJunctionsForEdgeSplits([{ vertex: 8, edge: [1, 4], t: 0.5 }],
    [{ edge: [1, 4], vertex: 8, t: 0.5 }]);
  check(transferredT.length === 1 && ekey(...transferredT[0].edge) === ekey(8, 4) && Math.abs(transferredT[0].t - 0.5) < 1e-9,
    'explicit T topology: splitting a host edge transfers its node to the correct child edge and parameter');
  check(resolvedT.length === 0,
    'explicit T topology: splitting a host edge with its embedded vertex resolves the record');

  const twoPatches: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 10, 0, 0, 20, 0, 0, 0, 0, 10, 10, 0, 10, 20, 0, 10],
    quads: [[0, 1, 3, 4], [1, 2, 4, 5]],
  };
  const halfSplit = applySurfaceCut(twoPatches, [
    { edge: [0, 3], t: 0.5 }, { edge: [1, 4], t: 0.5 },
  ]);
  const halfJunction = halfSplit.ok ? findTJunctions(halfSplit.doc) : [];
  const completedSplit = halfSplit.ok && halfJunction.length === 1
    ? applySurfaceCut(halfSplit.doc, [{ edge: [2, 5], t: 0.5 }, { vertex: halfJunction[0].vertex }])
    : null;
  const completedSplitReverse = halfSplit.ok && halfJunction.length === 1
    ? applySurfaceCut(halfSplit.doc, [{ vertex: halfJunction[0].vertex }, { edge: [2, 5], t: 0.5 }])
    : null;
  check(halfSplit.ok && halfSplit.doc.quads.length === 3 && halfJunction.length === 1,
    'create edge T completion: splitting only the first of two patches leaves three quads and one T-junction');
  if (halfSplit.ok && halfJunction.length) {
    const detached = structuredClone(halfSplit.doc), vertex = halfJunction[0].vertex;
    detached.vertices[vertex * 3 + 1] += 2;
    reconcileTJunctionGeometry(detached);
    check(findTJunctions(detached)[0]?.distance < 1e-6,
      'explicit T topology: moving or sculpting either side reseats the embedded vertex on its saved host curve');
  }
  check(completedSplit?.ok === true && completedSplit.doc.quads.length === 4
    && completedSplit.doc.quads.every(q => new Set(q).size === 4)
    && findTJunctions(completedSplit.doc).length === 0 && completedSplit.doc.tJunctions?.length === 0,
  'create edge T completion: drawing across the opposite patch reuses the T vertex and resolves to four clean quads');
  check(completedSplitReverse?.ok === true && completedSplitReverse.doc.quads.length === 4
    && findTJunctions(completedSplitReverse.doc).length === 0,
  'create edge T completion: the same four-quad resolution works when drawing outward from the T vertex');

  const threePatches: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0, 0, 0, 10, 10, 0, 10, 20, 0, 10, 30, 0, 10],
    quads: [[0, 1, 4, 5], [1, 2, 5, 6], [2, 3, 6, 7]],
  };
  const threeHalf = applySurfaceCut(threePatches, [
    { edge: [0, 4], t: 0.5 }, { edge: [1, 5], t: 0.5 },
  ]);
  const threeStart = threeHalf.ok ? findTJunctions(threeHalf.doc)[0] : null;
  const threeCompleted = threeHalf.ok && threeStart
    ? applySurfaceCut(threeHalf.doc, [
      { vertex: threeStart.vertex }, { edge: [2, 6], t: 0.5 }, { edge: [3, 7], t: 0.5 },
    ])
    : null;
  const threeRoutedPath = threeHalf.ok && threeStart
    ? routeSurfaceCutPath(threeHalf.doc, { vertex: threeStart.vertex }, { edge: [3, 7], t: 0.5 }) : null;
  const threeRouted = threeHalf.ok && threeRoutedPath ? applySurfaceCut(threeHalf.doc, threeRoutedPath) : null;
  check(threeCompleted?.ok === true && threeCompleted.doc.quads.length === 6
    && threeCompleted.doc.quads.every(q => new Set(q).size === 4)
    && findTJunctions(threeCompleted.doc).length === 0 && threeCompleted.doc.tJunctions?.length === 0,
  'create edge T-to-rim completion: a route across multiple patch edges ends conformingly at the true outside rim');
  check(threeRoutedPath?.length === 3 && threeRouted?.ok === true && threeRouted.doc.quads.length === 6
    && findTJunctions(threeRouted.doc).length === 0,
  'create edge T-to-rim completion: a direct long gesture discovers the intervening patch edge instead of becoming a free edge');

  const host = meshFromDoc(strip), hostA = getVertex(strip, 0), hostB = getVertex(strip, 1);
  const touch = cubicPoint(hostA, add(hostA, host.edgeHandle(0, 1)), add(hostB, host.edgeHandle(1, 0)), hostB, 0.43);
  const unresolved = appendFreeEdge(strip, [-8, 0, 4.3], { pos: touch, edge: [0, 1], t: 0.43 });
  const junctions = unresolved.ok ? findTJunctions(unresolved.doc) : [];
  check(unresolved.ok && junctions.some(j => j.vertex === 7 && ekey(j.edge[0], j.edge[1]) === ekey(0, 1)),
    'create edge diagnostics: a free endpoint on another edge interior is a T-junction');
  check(unresolved.ok && findTJunctions(unresolved.doc, T_JUNCTION_TOLERANCE_M, [7]).length === 1
    && findTJunctions(unresolved.doc, T_JUNCTION_TOLERANCE_M, [6]).length === 0,
  'create edge diagnostics: a selected-point query identifies only the clicked T-junction vertex');
  if (unresolved.ok) {
    const unrecorded = { ...unresolved.doc, tJunctions: [] };
    check(findTJunctions(unrecorded).length === 0,
      'create edge diagnostics: geometric overlap alone does not invent T topology without an explicit record');
    const legacyImplicit = structuredClone(unresolved.doc);
    delete legacyImplicit.tJunctions;
    check(findTJunctions(migrateMountain(legacyImplicit)).length === 1,
      'T-node migration: a legacy geometric contact is converted once into explicit saved topology');
  }
  const nearMiss = appendFreeEdge(strip, [-8, T_JUNCTION_TOLERANCE_M * 1.5, 4.3],
    [touch[0], touch[1] + T_JUNCTION_TOLERANCE_M * 1.5, touch[2]]);
  check(nearMiss.ok && findTJunctions(nearMiss.doc).length === 0,
    'create edge diagnostics: a nearby endpoint beyond the geometric tolerance is not highlighted');

  const hole = freshGrid();
  hole.quads.splice(Math.floor(hole.quads.length / 2), 1);
  check(findTJunctions(hole).length === 0,
    'create edge diagnostics: a connected internal-hole boundary is not a T-junction');

  const crossingDoc: QuadMeshDoc = {
    ...empty,
    vertices: [-10, 0, 0, 10, 0, 0, 0, 0, -10, 0, 0, 10],
    quads: [], freeEdges: [[0, 1], [2, 3]],
  };
  const crossings = findEdgeCrossings(crossingDoc);
  check(crossings.length === 1 && crossings[0].kind === 'crossing' && crossings[0].distance < 1e-8,
    'edge crossing diagnostics: two non-connected transverse cubic edges produce one red crossing');
  const weldedCrossing = crossings.length ? applyEdgeCrossingWeld(crossingDoc, crossings[0]) : null;
  check(weldedCrossing?.ok === true && weldedCrossing.doc.vertices.length / 3 === 5
    && weldedCrossing.doc.freeEdges?.length === 4 && findEdgeCrossings(weldedCrossing.doc).length === 0,
  'edge crossing weld: one shared vertex splits both free edges and clears the diagnostic');
  const automaticCrossing = autoWeldCreatedEdgeCrossings(crossingDoc, [[0, 1]]);
  check(automaticCrossing.welded === 1 && automaticCrossing.edges.length === 2
    && automaticCrossing.doc.freeEdges?.length === 4 && findEdgeCrossings(automaticCrossing.doc).length === 0,
  'create edge auto-weld: an exact transverse crossing involving the new edge is split and welded immediately');
  const crossingEndpointDoc: QuadMeshDoc = {
    ...crossingDoc,
    vertices: [...crossingDoc.vertices, 0, 0, 0, 10, 10, 0],
    freeEdges: [...crossingDoc.freeEdges!, [4, 5]],
  };
  const automaticEndpoint = autoWeldCreatedEdgeCrossings(crossingEndpointDoc, [[4, 5]]);
  const endpointAdj = meshAdjacency(meshFromDoc(automaticEndpoint.doc).mesh);
  check(automaticEndpoint.welded === 1 && endpointAdj.neighbors[4]?.length === 5
    && findEdgeCrossings(automaticEndpoint.doc).length === 0,
  'create edge auto-weld: finishing a new edge on an existing red crossing connects both old edges to its endpoint');
  const overlapDoc: QuadMeshDoc = {
    ...empty,
    vertices: [-10, 0, 0, 10, 0, 0, -10, 0.1, 0, 10, 0.1, 0],
    quads: [], freeEdges: [[0, 1], [2, 3]],
  };
  const overlaps = findEdgeCrossings(overlapDoc);
  check(overlaps.length === 1 && overlaps[0].kind === 'near-overlap' && Math.abs(overlaps[0].distance - 0.1) < 1e-6,
    'edge crossing diagnostics: close parallel edge interiors produce one amber near-overlap');
  const automaticOverlap = autoWeldCreatedEdgeCrossings(overlapDoc, [[0, 1]]);
  check(automaticOverlap.welded === 0 && automaticOverlap.doc === overlapDoc,
    'create edge auto-weld: a nearby parallel edge remains a diagnostic and is never merged automatically');

  const coincidentDoc: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 10, 0, 0, 0.02, 0, 0, 0.02, 0, 10],
    quads: [], freeEdges: [[0, 1], [2, 3]],
  };
  const coincident = findCoincidentVertices(coincidentDoc);
  check(coincident.length === 1 && coincident[0].vertices[0] === 0 && coincident[0].vertices[1] === 2
    && Math.abs(coincident[0].distance - 0.02) < 1e-8,
  'coincident point diagnostics: distinct used vertices within 5 cm produce one weld suggestion');
  check(coincidentVertexGroup(coincidentDoc, 2).join(',') === '0,2'
    && coincidentVertexGroup(coincidentDoc, 1).join(',') === '1',
    'coincident point selection: clicking either stacked point expands to the group while an isolated point stays single');
  const coincidenceChain: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 0, 0, 10, 0.04, 0, 0, 0.04, 0, 10, 0.08, 0, 0, 0.08, 0, 10],
    quads: [], freeEdges: [[0, 1], [2, 3], [4, 5]],
  };
  check(coincidentVertexGroup(coincidenceChain, 0).join(',') === '0,2'
    && coincidentVertexGroup(coincidenceChain, 2).join(',') === '0,2,4',
    'coincident point selection: proximity is direct from the clicked point and does not chain to a distant endpoint');
  const weldedCoincident = applyVertexWeld(coincidentDoc, [[2, 0]]);
  check(weldedCoincident.ok && findCoincidentVertices(weldedCoincident.doc).length === 0,
    'coincident point weld: merging the suggested pair clears its diagnostic');

  const togetherDoc: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, -10, 0, 0],
    quads: [], freeEdges: [[0, 1], [2, 3], [4, 5]],
  };
  const weldedTogether = applyVertexWeldTogether(togetherDoc, [4, 2, 0, 2]);
  check(weldedTogether.ok && weldedTogether.doc.vertices.length / 3 === 4
    && weldedTogether.doc.freeEdges?.every(([a]) => a === 0) === true,
    'point weld to each other: every unique selected point merges into the lowest-id survivor in one operation');
  check(!applyVertexWeldTogether(togetherDoc, [0, 0]).ok,
    'point weld to each other: fewer than two unique points is rejected');

  const togetherTJunctionDoc: QuadMeshDoc = {
    ...empty,
    vertices: [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10, 5, 0, 0, 5, 0, -10, 5, 0, 0, 5, 0, -20],
    quads: [[0, 1, 2, 3]], freeEdges: [[4, 5], [6, 7]],
    tJunctions: [{ vertex: 4, edge: [0, 1], t: 0.5 }, { vertex: 6, edge: [0, 1], t: 0.5 }],
  };
  const weldedTJunctions = applyVertexWeldTogether(togetherTJunctionDoc, [6, 4]);
  check(weldedTJunctions.ok && weldedTJunctions.doc.tJunctions?.length === 1
    && weldedTJunctions.doc.freeEdges?.filter(([a]) => a === 4).length === 2,
    'point weld to each other: overlapping T-nodes become one vertex and one deduplicated explicit T-junction');
  const unsafeTJunctionWeld = applyVertexWeld(togetherTJunctionDoc, [[4, 7]]);
  check(!unsafeTJunctionWeld.ok,
    'point weld: a T-node cannot be moved to a distant target and later snapped back onto its host by reconciliation');

  const legacy = structuredClone(grid) as QuadMeshDoc & { tracks?: unknown[]; guides?: unknown[] };
  legacy.tracks = [{ chart: { verts: [0], quads: [0] } }];
  legacy.guides = [{ knots: [[0, 0, 0], [1, 0, 0]], name: 'old' }];
  (legacy as unknown as Record<string, unknown>).tJunctions = [0];
  const migrated = migrateMountain(legacy);
  check(!('tracks' in migrated) && !('guides' in migrated) && migrated.tJunctions?.length === 0
    && migrated.vertices.length === grid.vertices.length && migrated.quads.length === grid.quads.length,
    'migrate: retired construction metadata is dropped while generated mesh geometry remains');
}

// ---- 0c. EDGE EXTRUDE: Alt-drag a boundary edge/run into a faithful ruled bicubic strip -------------------
{
  const added = appendStandalonePatch(freshGrid(), [80, 20, -50], [0, 1, 0]);
  const source: QuadMeshDoc = {
    ...added.doc,
    vertices: added.vertices.flatMap(v => getVertex(added.doc, v)),
    quads: [[0, 1, 2, 3]],
    edgeHandles: {
      '0>1': [4, 2, -1], '1>0': [-3, 1, 2],
      '0>2': [2, -1, 3], '2>0': [-2, 0.5, -2],
      '1>3': [1, 2, 2.5], '3>1': [-1.5, -0.5, -2],
      '2>3': [3, 1, 0.5], '3>2': [-2.5, 1.5, -1],
    },
    quadTwist: { 0: [[0.4, 1, -0.2], [-0.7, 0.3, 0.8], [0.2, -0.5, 1], [0.9, 0.4, -0.3]] },
    quadPaint: { 0: 7 }, quadTex: { 0: 'TEST/EXTRUDE.png' }, quadOrient: { 0: { rot: 2, mirror: true } },
  };
  const beforeJson = JSON.stringify(source), ctx0 = meshFromDoc(source);
  const sourceCp0 = quadControlPoints(ctx0.mesh, ctx0.edgeHandle, 0, source.quadTwist?.[0]);
  const sourceCurve = [sourceCp0[0], sourceCp0[1], sourceCp0[2], sourceCp0[3]];
  const delta: V3 = [11, -4, 7];
  const result = applyEdgeExtrusion(source, [[0, 1]], delta);
  check(result.ok, 'edge extrude: a boundary edge is accepted');
  check(JSON.stringify(source) === beforeJson, 'edge extrude: source document is untouched');
  if (result.ok) {
    check(result.doc.vertices.length / 3 === 6 && result.doc.quads.length === 2,
      'edge extrude: one edge appends two shared-end vertices and one patch');
    const ctx1 = meshFromDoc(result.doc);
    const sourceCp1 = quadControlPoints(ctx1.mesh, ctx1.edgeHandle, 0, result.doc.quadTwist?.[0]);
    check(sourceCp1.every((p, i) => len(sub(p, sourceCp0[i])) < 1e-8),
      'edge extrude: adding neighbours leaves all 16 source control points exact');
    const emitted = quadControlPoints(ctx1.mesh, ctx1.edgeHandle, result.quads[0], result.doc.quadTwist?.[result.quads[0]]);
    const ruled = emitted.every((p, i) => {
      const row = Math.floor(i / 4), v = (i % 4) / 3;
      return len(sub(p, add(sourceCurve[row], mul(delta, v)))) < 1e-8;
    });
    check(ruled, 'edge extrude: new 4x4 cage is the exact source cubic swept through 0, 1/3, 2/3, 1');
    check(result.outerEdges.length === 1 && result.outerEdges[0].every(v => result.vertices.includes(v)),
      'edge extrude: reports the translated outer edge for immediate repeat extrusion');
    check(result.doc.quadPaint?.[1] === 7 && result.doc.quadTex?.[1] === 'TEST/EXTRUDE.png'
      && result.doc.quadOrient?.[1]?.rot === 2 && result.doc.quadOrient[1].mirror,
      'edge extrude: new patch inherits surface, texture, and orientation metadata');
    check(normalsAgreeAcrossSeams(result.doc),
      'edge extrude: the new strip normal agrees with its adjacent source face');
  }

  const planned = planEdgeExtrusion(source, [[0, 1]]);
  if (planned.ok) {
    const tangent = tangentEdgeExtrusionPlacement(source, planned.plan, delta);
    const tangentA = norm(sub(tangent.vertices[0], getVertex(source, 0)));
    const tangentB = norm(sub(tangent.vertices[1], getVertex(source, 1)));
    const expectedA = norm(mul(source.edgeHandles!['0>2'], -1));
    const expectedB = norm(mul(source.edgeHandles!['1>3'], -1));
    check(dot(tangentA, expectedA) > 1 - 1e-10 && dot(tangentB, expectedB) > 1 - 1e-10,
      'edge extrude tangent: each endpoint continues its own source-patch outward tangent');
    check(Math.abs(dot(tangentA, tangentB)) < 0.999,
      'edge extrude tangent: fan-like connector directions are not forced parallel');
    const tangentGhost = edgeExtrusionPlacementPreviewDoc(source, planned.plan, tangent);
    check(!buildMountainPreview(tangentGhost).positions.some(x => !Number.isFinite(x)),
      'edge extrude tangent: locally continued outer curve preview stays finite');
    const ghost = edgeExtrusionPreviewDoc(source, planned.plan, delta), pv = buildMountainPreview(ghost);
    check(ghost.quads.length === 1 && !pv.positions.some(x => !Number.isFinite(x)),
      'edge extrude: the local curved drag ghost is finite and contains only the prospective strip');
    const placed = translatedEdgeExtrusionPlacement(source, planned.plan, delta);
    const moved = planned.plan.vertices[1];
    placed.vertices[moved] = add(placed.vertices[moved], [3, 5, -2]);
    placed.handles['0>1'] = mul(placed.handles['0>1'], 1.25);
    placed.handles['1>0'] = mul(placed.handles['1>0'], 1.25);
    const staged = applyPlannedEdgeExtrusion(source, planned.plan, placed);
    check(staged.ok && staged.doc.vertices.slice(-3).every((v, i) => Math.abs(v - placed.vertices[moved][i]) < 1e-10),
      'edge extrude stage: an independently transformed outer endpoint bakes at its exact target');
    const stagedGhost = edgeExtrusionPlacementPreviewDoc(source, planned.plan, placed);
    check(!buildMountainPreview(stagedGhost).positions.some(x => !Number.isFinite(x)),
      'edge extrude stage: move / rotate / scale placement preview stays finite');
    const longDelta: V3 = [planned.plan.segmentLength * 2.2, 0, 0];
    const longPlacement = translatedEdgeExtrusionPlacement(source, planned.plan, longDelta);
    const longSegments = edgeExtrusionSegmentCount(source, planned.plan, longPlacement);
    const longGhost = edgeExtrusionPlacementPreviewDoc(source, planned.plan, longPlacement);
    const longResult = applyPlannedEdgeExtrusion(source, planned.plan, longPlacement);
    check(longSegments === 3 && longGhost.quads.length === 3 && longResult.ok && longResult.quads.length === 3
      && longResult.vertices.length === 6,
      'edge extrude auto segments: a 2.2-edge-depth strip becomes three quad bands in preview and commit');
    if (longResult.ok) check(normalsAgreeAcrossSeams(longResult.doc) && !hasNaN(longResult.doc),
      'edge extrude auto segments: intermediate rings remain finite and consistently oriented');
  }
  const run = applyEdgeExtrusion(source, [[0, 1], [1, 3]], delta);
  check(run.ok && run.vertices.length === 3 && run.quads.length === 2,
    'edge extrude run: adjacent selected edges share their duplicated corner');
  if (run.ok) check(checkManifold(run.doc.quads).ok,
    'edge extrude run: the emitted corner strip stays manifold');

  const freeSeed = appendFreeEdge(freshGrid(), [200, 40, -80], [230, 45, -70]);
  check(freeSeed.ok, 'free edge extrude: fixture edge created');
  if (freeSeed.ok) {
    const [fa, fb] = freeSeed.edge;
    const freeDoc = structuredClone(freeSeed.doc);
    (freeDoc.edgeHandles ??= {})[`${fa}>${fb}`] = [9, 4, -2];
    freeDoc.edgeHandles[`${fb}>${fa}`] = [-7, 3, 1];
    const beforeQ = freeDoc.quads.length, beforeV = freeDoc.vertices.length / 3;
    const freeResult = applyEdgeExtrusion(freeDoc, [freeSeed.edge], delta);
    check(freeResult.ok, 'free edge extrude: a free-standing edge is accepted as a patch seed');
    if (freeResult.ok) {
      check(freeResult.doc.quads.length === beforeQ + 1 && freeResult.doc.vertices.length / 3 === beforeV + 2,
        'free edge extrude: appends one patch and one translated endpoint pair');
      check(!(freeResult.doc.freeEdges ?? []).some(([a, b]) => ekey(a, b) === ekey(fa, fb)),
        'free edge extrude: consumes the source free-edge record once it becomes a surface boundary');
      const ctx = meshFromDoc(freeResult.doc), cp = quadControlPoints(ctx.mesh, ctx.edgeHandle, freeResult.quads[0]);
      const pa = getVertex(freeDoc, fa), pb = getVertex(freeDoc, fb);
      const curve = [pa, add(pa, freeDoc.edgeHandles![`${fa}>${fb}`]), add(pb, freeDoc.edgeHandles![`${fb}>${fa}`]), pb];
      check(cp.every((p, i) => len(sub(p, add(curve[Math.floor(i / 4)], mul(delta, (i % 4) / 3)))) < 1e-8),
        'free edge extrude: preserves the source cubic and sweeps it through the drag');
      check(checkManifold(freeResult.doc.quads).ok && !hasNaN(freeResult.doc),
        'free edge extrude: result is manifold and finite');
      check(normalsAgreeAcrossSeams(freeResult.doc),
        'free edge extrude: the first patch strip has consistent internal normal orientation');
    }
    const freePlan = planEdgeExtrusion(freeDoc, [freeSeed.edge]);
    if (freePlan.ok) {
      check(edgeExtrusionOccludingSourceQuads(freePlan.plan).length === 0,
        'free edge extrude preview: unchanged source terrain remains visible');
      const ghost = edgeExtrusionPreviewDoc(freeDoc, freePlan.plan, delta), pv = buildMountainPreview(ghost);
      check(ghost.quads.length === 1 && !ghost.freeEdges && !pv.positions.some(x => !Number.isFinite(x)),
        'free edge extrude: local preview contains one finite prospective patch');
    }
  }

  const gridDoc = freshGrid(), [, B, , D] = gridDoc.quads[0];
  const interiorPlan = planEdgeExtrusion(gridDoc, [[B, D]], 0);
  check(interiorPlan.ok && interiorPlan.plan.sideQuads?.[0].sourceQuad === 0 && interiorPlan.plan.caps?.length === 2,
    'interior edge extrude: the clicked patch becomes the chosen side and the two run ends plan triangle caps');
  if (interiorPlan.ok) {
    check(edgeExtrusionOccludingSourceQuads(interiorPlan.plan).join(',') === '0',
      'interior edge extrude preview: masks the rewired source-side patch');
    const before = JSON.stringify(gridDoc), beforeCtx = meshFromDoc(gridDoc);
    const stationary = interiorPlan.plan.edges[0].sourceQuad!;
    const stationaryCp = quadControlPoints(beforeCtx.mesh, beforeCtx.edgeHandle, stationary, gridDoc.quadTwist?.[stationary]);
    const placement = translatedEdgeExtrusionPlacement(gridDoc, interiorPlan.plan, delta);
    const ghost = edgeExtrusionPlacementPreviewDoc(gridDoc, interiorPlan.plan, placement);
    check(ghost.quads.length === 4 && !buildMountainPreview(ghost).positions.some(value => !Number.isFinite(value)),
      'interior edge extrude: preview contains one wall, two triangle caps, and the affected side patch');
    const normalPlacement = tangentEdgeExtrusionPlacement(gridDoc, interiorPlan.plan, [8, 0, 0]);
    const normalMove = sub(normalPlacement.vertices[B], getVertex(gridDoc, B));
    const eh = beforeCtx.edgeHandle, pB = getVertex(gridDoc, B), pD = getVertex(gridDoc, D);
    const edgeBefore = add(pB, eh(B, D)), edgeAfter = add(pD, eh(D, B));
    const tangent = sub(cubicPoint(pB, edgeBefore, edgeAfter, pD, 0.51), cubicPoint(pB, edgeBefore, edgeAfter, pD, 0.49));
    check(Math.abs(dot(norm(normalMove), norm(tangent))) < 1e-6,
      'interior edge extrude: the constrained placement moves perpendicular to the selected surface edge');
    const deepPlacement = translatedEdgeExtrusionPlacement(
      gridDoc, interiorPlan.plan, mul(interiorPlan.plan.direction!, interiorPlan.plan.segmentLength * 2.2));
    const deepSegments = edgeExtrusionSegmentCount(gridDoc, interiorPlan.plan, deepPlacement);
    const deepGhost = edgeExtrusionPlacementPreviewDoc(gridDoc, interiorPlan.plan, deepPlacement);
    const deepResult = applyPlannedEdgeExtrusion(gridDoc, interiorPlan.plan, deepPlacement);
    check(deepSegments === 3 && deepGhost.quads.length === 10 && deepResult.ok
      && deepResult.quads.length === 9 && deepResult.vertices.length === 6,
      'interior edge extrude auto segments: three wall bands create matching three-triangle fans at both ends');
    if (deepResult.ok) check(normalsAgreeAcrossSeams(deepResult.doc) && !hasNaN(deepResult.doc),
      'interior edge extrude auto segments: wall bands and cap fans remain finite and consistently oriented');
    const interior = applyPlannedEdgeExtrusion(gridDoc, interiorPlan.plan, placement);
    check(interior.ok && JSON.stringify(gridDoc) === before,
      'interior edge extrude: commit succeeds without touching the source document');
    if (interior.ok) {
      check(interior.doc.vertices.length === gridDoc.vertices.length + 6 && interior.doc.quads.length === gridDoc.quads.length + 3
        && interior.quads.length === 3,
        'interior edge extrude: duplicates two endpoints and adds one wall quad plus two triangle patches');
      const afterCtx = meshFromDoc(interior.doc);
      const afterStationary = quadControlPoints(afterCtx.mesh, afterCtx.edgeHandle, stationary, interior.doc.quadTwist?.[stationary]);
      check(afterStationary.every((point, index) => len(sub(point, stationaryCp[index])) < 1e-8),
        'interior edge extrude: the unchosen side remains an exact bicubic surface');
      const chosen = interior.doc.quads[0], newEdge = interior.outerEdges[0];
      check(chosen.includes(newEdge[0]) && chosen.includes(newEdge[1]) && !chosen.includes(B) && !chosen.includes(D),
        'interior edge extrude: the chosen patch is rewired to the duplicated edge');
      check(checkManifold(interior.doc.quads).ok && watertight(interior.doc).boundary === watertight(gridDoc).boundary && !hasNaN(interior.doc),
        'interior edge extrude: triangle caps keep the ledge manifold, finite, and free of new boundaries');
      check(normalsAgreeAcrossSeams(interior.doc),
        'interior edge extrude: wall and triangle normals agree across every adjacent seam');
    }
  }
  const flippedPlan = planEdgeExtrusion(gridDoc, [[B, D]], 1);
  check(flippedPlan.ok && flippedPlan.plan.sideQuads?.[0].sourceQuad === 1,
    'interior edge extrude: choosing the opposite incident patch flips the rewired side');

  const next = D + GRID_COLS;
  const runPlan = planEdgeExtrusion(gridDoc, [[B, D], [D, next]], 0);
  check(runPlan.ok && runPlan.plan.sideQuads?.length === 2,
    'interior edge extrude run: the clicked side propagates across a connected two-edge strip');
  if (runPlan.ok) {
    const run = applyPlannedEdgeExtrusion(gridDoc, runPlan.plan, translatedEdgeExtrusionPlacement(gridDoc, runPlan.plan, delta));
    check(run.ok && run.vertices.length === 3 && run.quads.length === 4 && checkManifold(run.doc.quads).ok,
      'interior edge extrude run: shared duplicated corners create two walls and only two end caps');
  }
}

// ---- 0c. PATCH EXTRUDE: lift/push one connected top and grow a watertight wall ring ----------------------
{
  const source = freshGrid(), row = 3, col = 3, first = row * cellCols + col, second = first + 1;
  const selected = [first, second], delta: V3 = [0, 14, 0];
  source.quadPaint = { ...(source.quadPaint ?? {}), [first]: 7, [second]: 9 };
  source.quadTex = { ...(source.quadTex ?? {}), [first]: 'TEST/MESA.png' };
  source.quadTwist = { ...(source.quadTwist ?? {}), [first]: [[1, 2, 3], [-2, 1, 0], [0, 0.5, -1], [2, -1, 1]] };
  const before = JSON.stringify(source), beforeCtx = meshFromDoc(source);
  const sourceCp = selected.map(quad => quadControlPoints(beforeCtx.mesh, beforeCtx.edgeHandle, quad, source.quadTwist?.[quad]));
  const neighbor = first - 1;
  const neighborCp = quadControlPoints(beforeCtx.mesh, beforeCtx.edgeHandle, neighbor, source.quadTwist?.[neighbor]);
  const plan = planPatchExtrusion(source, selected);
  check(plan.ok && plan.plan.kind === 'patch' && plan.plan.edges.length === 6 && plan.plan.topQuads?.length === 2,
    'patch extrude plan: a connected two-patch region finds six boundary walls and preserves two top patches');
  if (plan.ok) {
    check(edgeExtrusionOccludingSourceQuads(plan.plan).join(',') === [...selected].sort((a, b) => a - b).join(','),
      'patch extrude preview: masks every replaced source top so downward walls stay visible');
    const ghost = edgeExtrusionPreviewDoc(source, plan.plan, delta);
    check(ghost.quads.length === 8 && !buildMountainPreview(ghost).positions.some(value => !Number.isFinite(value)),
      'patch extrude preview: walls plus lifted top form a finite local ghost');
    const staged = tangentEdgeExtrusionPlacement(source, plan.plan, [5, 0, 0]);
    const movement = sub(staged.vertices[plan.plan.vertices[0]], getVertex(source, plan.plan.vertices[0]));
    check(dot(norm(movement), plan.plan.direction!) > 1 - 1e-10,
      'patch extrude stage: the initial handle follows the selected region average surface normal');
    const pushed = tangentEdgeExtrusionPlacement(source, plan.plan, [-5, 0, 0]);
    const pushMovement = sub(pushed.vertices[plan.plan.vertices[0]], getVertex(source, plan.plan.vertices[0]));
    check(dot(norm(pushMovement), plan.plan.direction!) < -1 + 1e-10,
      'patch extrude stage: crossing the source plane reverses the normal for a canyon push');
    const deepPlacement = translatedEdgeExtrusionPlacement(
      source, plan.plan, mul(plan.plan.direction!, plan.plan.segmentLength * 2.2));
    const deepSegments = edgeExtrusionSegmentCount(source, plan.plan, deepPlacement);
    const deepGhost = edgeExtrusionPlacementPreviewDoc(source, plan.plan, deepPlacement);
    const deepResult = applyPlannedEdgeExtrusion(source, plan.plan, deepPlacement);
    check(deepSegments === 3 && deepGhost.quads.length === 20 && deepResult.ok
      && deepResult.quads.length === 20 && deepResult.vertices.length === 18,
      'patch extrude auto segments: a deep two-patch mesa gains three coherent wall rings and one unchanged top');
    if (deepResult.ok) check(normalsAgreeAcrossSeams(deepResult.doc) && !hasNaN(deepResult.doc),
      'patch extrude auto segments: all wall rings remain finite and consistently oriented');
  }
  const result = applyPatchExtrusion(source, selected, delta);
  check(result.ok, 'patch extrude: a connected selected region is accepted');
  check(JSON.stringify(source) === before, 'patch extrude: source document is untouched');
  if (result.ok) {
    check(result.topQuads?.length === 2 && result.quads.length === 8
      && result.doc.quads.length === source.quads.length + 6,
    'patch extrude: replaces two source patches with two lifted tops and six new walls');
    check(checkManifold(result.doc.quads).ok && watertight(result.doc).boundary === watertight(source).boundary && !hasNaN(result.doc),
      'patch extrude: an interior mesa remains manifold, finite, and does not open a new mesh boundary');
    check(normalsAgreeAcrossSeams(result.doc),
      'patch extrude: lifted top, surrounding terrain, and generated wall normals agree across every seam');
    const afterCtx = meshFromDoc(result.doc);
    for (let i = 0; i < result.topQuads!.length; i++) {
      const cp = quadControlPoints(afterCtx.mesh, afterCtx.edgeHandle, result.topQuads![i], result.doc.quadTwist?.[result.topQuads![i]]);
      check(cp.every((point, index) => len(sub(point, add(sourceCp[i][index], delta))) < 1e-8),
        `patch extrude top ${i + 1}: every bicubic control point is an exact translated copy`);
    }
    const afterNeighbor = quadControlPoints(afterCtx.mesh, afterCtx.edgeHandle, neighbor, result.doc.quadTwist?.[neighbor]);
    check(afterNeighbor.every((point, index) => len(sub(point, neighborCp[index])) < 1e-8),
      'patch extrude: pinning the source rim leaves the surrounding patch shape exact');
    check(result.doc.quadPaint?.[result.topQuads![0]] === 7 && result.doc.quadPaint?.[result.topQuads![1]] === 9
      && result.doc.quadTex?.[result.topQuads![0]] === 'TEST/MESA.png',
      'patch extrude: lifted tops inherit surface and texture metadata');
  }
  const disconnected = planPatchExtrusion(source, [first, first + 2]);
  check(!disconnected.ok && disconnected.error.includes('connected'),
    'patch extrude: disconnected patch groups are rejected instead of being joined implicitly');
}

// ---- 0c. RIP: un-stitch a selected interior path into two pinned-end lips with a 1 m opening --------------
{
  const source = freshGrid(), before = JSON.stringify(source);
  const row = 3, v0 = row * GRID_COLS + 3, v1 = v0 + 1, v2 = v1 + 1;
  const edges: [number, number][] = [[v0, v1], [v1, v2]];
  const p0 = getVertex(source, v0), p1 = getVertex(source, v1), p2 = getVertex(source, v2);
  const boundary0 = watertight(source).boundary;
  const beforeHandle = meshEdgeHandles(buildQuadMesh(source.vertices, source.quads, source.freeEdges), source.edgeHandles)(v0, v1);
  const ripped = applyEdgeRip(source, edges);
  check(!applyEdgeRip(source, [edges[0]]).ok, 'rip: a single edge with both endpoints pinned is refused');
  check(JSON.stringify(source) === before, 'rip: source document is untouched');
  check(ripped.ok, 'rip: a connected two-edge interior path is accepted');
  if (ripped.ok) {
    const [[oldVertex, copyVertex]] = ripped.splitVertices;
    const oldPoint = getVertex(ripped.doc, oldVertex), copyPoint = getVertex(ripped.doc, copyVertex);
    const tangent = norm(sub(p2, p0)), opening = sub(copyPoint, oldPoint);
    check(ripped.doc.vertices.length / 3 === V0 + 1 && ripped.doc.quads.length === Q0,
      'rip: duplicates only the one interior path vertex and keeps every patch id');
    check(len(sub(getVertex(ripped.doc, v0), p0)) < 1e-12 && len(sub(getVertex(ripped.doc, v2), p2)) < 1e-12,
      'rip: path endpoints stay pinned');
    check(Math.abs(len(opening) - 1) < 1e-10 && Math.abs(dot(norm(opening), tangent)) < 1e-8,
      'rip: the two interior copies separate by 1 m perpendicular to the path');
    check(len(sub(mul(add(oldPoint, copyPoint), 0.5), p1)) < 1e-10,
      'rip: the original path remains the midpoint of the opening (0.5 m per lip)');
    const lipVertices = ripped.lips.map(lip => new Set(lip.flat()));
    check([...lipVertices[0]].filter(v => lipVertices[1].has(v)).sort((a, b) => a - b).join(',') === [v0, v2].sort((a, b) => a - b).join(','),
      'rip: the two lips share only their pinned endpoints');
    const wt = watertight(ripped.doc);
    check(wt.ok && wt.boundary === boundary0 + 4 && !hasNaN(ripped.doc),
      'rip: both former shared edges become paired open boundaries; the mesh stays finite and manifold');
    const dupHandle = ripped.doc.edgeHandles?.[`${v0}>${copyVertex}`];
    const oldHandle = ripped.doc.edgeHandles?.[`${v0}>${v1}`];
    check(!!dupHandle && !!oldHandle && len(sub(dupHandle, beforeHandle)) < 1e-12 && len(sub(oldHandle, beforeHandle)) < 1e-12,
      'rip: both lips inherit the frozen effective Bezier handle from the stitched edge');
    check(!buildMountainPreview(ripped.doc).positions.some(x => !Number.isFinite(x)),
      'rip: the opened quilt tessellates without NaN');
    const stitchedSet = applyEdgeWeldSets(ripped.doc, ripped.lips[0], ripped.lips[1].slice().reverse());
    check(stitchedSet.ok, 'edge weld set: two source lip edges pair with two target lip edges independent of selection order');
    if (stitchedSet.ok) {
      const sw = watertight(stitchedSet.doc);
      check(sw.ok && sw.boundary === boundary0 && stitchedSet.doc.vertices.length / 3 === V0,
        'edge weld set: all pairs commit atomically and restore the complete ripped path');
    }
    const stitched = applyEdgeWeld(ripped.doc, ripped.lips[0][0], ripped.lips[1][0]);
    check(stitched.ok, 'edge weld: equal-length paired Rip lips stitch successfully');
    if (stitched.ok) {
      const sw = watertight(stitched.doc);
      check(sw.ok && sw.boundary === boundary0 && stitched.doc.vertices.length / 3 === V0,
        'edge weld: target endpoints retire into the source edge and restore the stitched topology');
    }
    const unequal = structuredClone(ripped.doc), targetVertex = ripped.lips[1][0][1];
    unequal.vertices[targetVertex * 3] += 5;
    check(applyEdgeWeld(unequal, ripped.lips[0][0], ripped.lips[1][0]).ok,
      'edge weld: different edge lengths still weld by their closest endpoint vertices');
  }

  const interiorDoc = freshGrid(), [, ia, , ib] = interiorDoc.quads[0];
  const interiorCtx = meshFromDoc(interiorDoc), ipa = getVertex(interiorDoc, ia), ipb = getVertex(interiorDoc, ib);
  const freeCopy = appendFreeEdge(interiorDoc, add(ipa, [200, 0, 0]), add(ipb, [200, 0, 0]));
  if (freeCopy.ok) {
    const [fa, fb] = freeCopy.edge;
    (freeCopy.doc.edgeHandles ??= {})[`${fa}>${fb}`] = [...interiorCtx.edgeHandle(ia, ib)] as V3;
    freeCopy.doc.edgeHandles[`${fb}>${fa}`] = [...interiorCtx.edgeHandle(ib, ia)] as V3;
    const joined = applyEdgeWeld(freeCopy.doc, [ia, ib], freeCopy.edge);
    check(joined.ok && !joined.doc.freeEdges?.length && joined.doc.vertices.length / 3 === V0,
      'edge weld: a free edge can weld into an equal-length interior edge and its redundant free record is consumed');
  } else check(false, 'edge weld: interior/free fixture built');

  const freeOnly: QuadMeshDoc = { ...freshGrid(), vertices: [], quads: [], freeEdges: undefined };
  const freeA = appendFreeEdge(freeOnly, [0, 0, 0], [10, 0, 0]);
  const freeB = freeA.ok ? appendFreeEdge(freeA.doc, [30, 0, 0], [40, 0, 0]) : freeA;
  if (freeA.ok && freeB.ok) {
    const joined = applyEdgeWeld(freeB.doc, freeA.edge, freeB.edge);
    check(joined.ok && joined.doc.freeEdges?.length === 1 && joined.doc.vertices.length / 3 === 2,
      'edge weld: two equal-length free edges merge into the selected survivor');
  } else check(false, 'edge weld: free/free fixture built');

  const mixedWinding = freshGrid();
  const mixedAdj = meshAdjacency(buildQuadMesh(mixedWinding.vertices, mixedWinding.quads, mixedWinding.freeEdges));
  const reversedQuad = (mixedAdj.edgeQuads.get(ekey(v1, v2)) ?? [])[0];
  const [A, B, C, D] = mixedWinding.quads[reversedQuad];
  mixedWinding.quads[reversedQuad] = [A, C, B, D]; // same four perimeter edges, opposite local winding
  check(applyEdgeRip(mixedWinding, edges).ok,
    'rip: side tracing follows topology through a locally reversed quad instead of requiring uniform winding');

  const poleBase = freshGrid(), poleRim = 2, poleInner = GRID_COLS + 2;
  const poled = applyVertexWeld(poleBase, [[poleInner, poleRim]]);
  if (poled.ok) {
    const poleAdj = meshAdjacency(buildQuadMesh(poled.doc.vertices, poled.doc.quads, poled.doc.freeEdges));
    const pole = poleAdj.neighbors.findIndex((neighbors, vertex) => neighbors.length === 5
      && neighbors.filter(n => (poleAdj.edgeQuads.get(ekey(vertex, n))?.length ?? 0) === 2).length >= 2);
    const poleNeighbors = (poleAdj.neighbors[pole] ?? []).filter(n => (poleAdj.edgeQuads.get(ekey(pole, n))?.length ?? 0) === 2);
    check(pole >= 0 && applyEdgeRip(poled.doc, [[poleNeighbors[0], pole], [pole, poleNeighbors[1]]]).ok,
      'rip: a two-edge path continues through an ordinary 5-pole fan');
  } else check(false, 'rip: 5-pole fixture built');
}

// ---- 0d. WELD LOOPS: close an annular gap without moving either boundary, even at unequal densities -------
{
  const doc = freshGrid();
  const points: V3[] = [
    [-4, 0, -4], [-4, 0, 4], [4, 0, 4], [4, 0, -4],
    [-2, 0, -2], [-2, 0, 2], [2, 0, 2], [2, 0, -2],
    [-1, 0, -0.8], [-0.6, 0, 1], [1, 0, 0],
  ];
  doc.vertices = points.flat();
  doc.vertexIds = points.map((_, i) => `loop-v${i}`);
  // Four patches form terrain around a square hole; a separate triangular trail patch sits inside it.
  doc.quads = [[0, 1, 4, 5], [1, 2, 5, 6], [2, 3, 6, 7], [3, 0, 7, 4], [8, 9, 10, 10]];
  doc.quadIds = doc.quads.map((_, i) => `loop-q${i}`);
  doc.nextId = 100;
  doc.tJunctions = [];
  for (const key of ['freeEdges', 'edgeHandles', 'quadPaint', 'quadTex', 'quadOrient', 'quadTwist', 'tombstones'] as const)
    delete doc[key];
  const mountain: [number, number][] = [[4, 5], [5, 6], [6, 7], [7, 4]];
  const trail: [number, number][] = [[8, 9], [9, 10], [10, 8]];
  const sourceLoop = boundaryEdgeLoopVertices(doc, mountain), targetLoop = boundaryEdgeLoopVertices(doc, trail);
  check(sourceLoop.ok && sourceLoop.vertices.length === 4 && targetLoop.ok && targetLoop.vertices.length === 3,
    'weld loops: unordered selected borders resolve as two complete surface boundary cycles');
  const before = JSON.stringify(doc), boundary = watertight(doc).boundary;
  const welded = applyEdgeLoopWeld(doc, mountain.slice().reverse(), [trail[1], trail[2], trail[0]]);
  check(welded.ok, 'weld loops: unequal four-edge and three-edge boundaries stitch successfully');
  check(JSON.stringify(doc) === before, 'weld loops: the source document is untouched');
  if (welded.ok) {
    const after = watertight(welded.doc), adj = meshAdjacency(buildQuadMesh(welded.doc.vertices, welded.doc.quads, welded.doc.freeEdges));
    check(welded.doc.vertices.length === doc.vertices.length && welded.quads.length === Math.max(mountain.length, trail.length)
      && welded.triangles === Math.abs(mountain.length - trail.length),
    'weld loops: neither border moves; the seam maximizes quads and emits only the unavoidable density-transition triangles');
    check(after.ok && after.boundary === boundary - mountain.length - trail.length && checkManifold(welded.doc.quads).ok,
      'weld loops: the annular seam consumes both borders and leaves a finite manifold surface');
    check([...mountain, ...trail].every(([a, b]) => (adj.edgeQuads.get(ekey(a, b)) ?? []).length === 2),
      'weld loops: every former hole/trail boundary edge now has exactly two incident patches');
    check(!buildMountainPreview(welded.doc).positions.some(x => !Number.isFinite(x)),
      'weld loops: the stitched Bezier quilt evaluates without NaN');
  }
  const equalDoc = structuredClone(doc);
  equalDoc.vertices.push(0.6, 0, -1);
  equalDoc.vertexIds.push('loop-v11');
  equalDoc.quads[4] = [8, 9, 11, 10];
  const equalTrail: [number, number][] = [[8, 9], [9, 10], [10, 11], [11, 8]];
  const equal = applyEdgeLoopWeld(equalDoc, mountain, equalTrail);
  check(equal.ok && equal.quads.length === 4 && equal.triangles === 0,
    'weld loops: equal-density boundaries produce one clean all-quad seam patch per station');
  const interior = [[0, 1], [1, 5], [5, 4], [4, 0]] as [number, number][];
  check(!boundaryEdgeLoopVertices(doc, interior).ok,
    'weld loops: a closed selection containing interior edges is rejected as a boundary seam');
}

console.log(failures ? '\nMESHOPS-CREATE: FAIL' : '\nMESHOPS-CREATE: PASS');
process.exit(failures ? 1 : 0);
