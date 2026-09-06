import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { deriveQuadMesh } from '../src/core/doc/mountain';
import { patchPoint } from '../src/core/math/bezier';
import { quadControlPoints } from '../src/core/mesh/topology';
import { prepareRetopologyBenchmark, prepareSelectedRetopology, protectedQuadSet } from '../src/core/mesh/retopology/benchmark';
import { scoreRetopologyCandidate } from '../src/core/mesh/retopology/metrics';
import { readObj, writeObj, type PolygonMesh } from '../src/core/mesh/retopology/obj';
import { candidateReferencePatches, polygonPatchPoints } from '../src/core/mesh/retopology/reference-map';
import { quadWildSharp, quadWildTrailField } from '../src/core/mesh/retopology/field';
import { buildExactTrailBuffer, conformCandidateOuterBoundary, cutCandidateByLockedFootprint, fitBezierSurfaceHeight,
  generatedProtectedFootprintOverlaps, generatedProtectedFootprintPenetration, integrateRetopologyCandidate,
  refineCoarseCandidateInterface, removeCandidateFacesAndRepairBoundary } from '../src/core/mesh/retopology/integrate';
import { conformRetopologySeams } from '../src/core/mesh/retopology/conform';
import { findTJunctions } from '../src/core/mesh/t-junctions';
import { retopologyCapabilities } from '../src/server/retopology/jobs';
import { check, failures } from './check';

function grid(): QuadMeshDoc {
  const vertices: number[] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) vertices.push(col, 0, row);
  const quads: number[][] = [];
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    const A = row * 4 + col, B = A + 1, C = A + 4, D = C + 1;
    quads.push([A, B, C, D]);
  }
  return {
    kind: 'mountain', version: 5, name: 'RETOPO FIXTURE', spacing: 1,
    course: { knots: [], blend: 1, surface: 1 }, baseSurface: 1,
    vertices,
    vertexIds: Array.from({ length: 16 }, (_, i) => `v:${i}`),
    quads,
    quadIds: Array.from({ length: 9 }, (_, i) => `q:${i}`),
    nextId: 25,
    quadLocked: { 4: true },
    quadPaint: { 0: 7, 4: 9 },
  };
}

const doc = grid();
const productCapability = retopologyCapabilities();
check(productCapability.engine === 'quadwild-bimdf'
  && productCapability.scopes.join() === 'whole-unlocked,selected-region'
  && productCapability.defaults.quadWildScale === 1.6
  && (productCapability.available || !!productCapability.reason),
'product job capability reports the pinned whole-mountain QuadWild contract and a useful availability state');
const noCollar = protectedQuadSet(doc, 0), oneCollar = protectedQuadSet(doc, 1);
check(noCollar.size === 1 && noCollar.has(4), 'collar 0 protects exactly the locked patch');
check(oneCollar.size === 5 && [1, 3, 4, 5, 7].every(quad => oneCollar.has(quad)),
  'collar 1 grows through edge-adjacent patch topology');

const prepared = prepareRetopologyBenchmark(doc, {
  collarRings: 0,
  targetPatchSizeM: 1,
  tessellationResolution: 2,
});
check(prepared.constraints.lockedQuadIds.join() === 'q:4'
  && prepared.constraints.protectedQuadIds.join() === 'q:4',
'benchmark constraints use stable patch identity');
check(prepared.constraints.interface.length === 4, 'the protected center patch exposes four exact interface curves');
check(prepared.constraints.targetFaces === 8 && Math.abs(prepared.constraints.sourceAreaM2 - 8) < 1e-9,
  'target face count derives from remeshable surface area and requested patch size');
check(prepared.input.faces.length === 64 && prepared.protected.faces.length === 8,
  'the source and protected quilt regions tessellate independently at the requested resolution');
const wholePrepared = prepareRetopologyBenchmark(doc, {
  collarRings: 0, targetPatchSizeM: 1, tessellationResolution: 2, wholeSurface: true,
});
check(wholePrepared.input.faces.length === 72
  && wholePrepared.protected.faces.length === 8
  && wholePrepared.constraints.protectedQuadIds.length === 0
  && wholePrepared.constraints.remeshQuadIds.length === 9
  && wholePrepared.constraints.interface.length === 4,
'whole-surface preparation triangulates through the locked trail while retaining its internal guides');
const roundTrip = readObj(writeObj(prepared.input));
check(roundTrip.vertices.length === prepared.input.vertices.length
  && roundTrip.faces.length === prepared.input.faces.length,
'OBJ interchange round-trips benchmark topology');

// The ideal flat candidate retains the eight unlocked control quads and the center hole.
const points: V3[] = Array.from({ length: doc.vertices.length / 3 }, (_, i) =>
  [doc.vertices[i * 3], doc.vertices[i * 3 + 1], doc.vertices[i * 3 + 2]]);
const candidate: PolygonMesh = {
  vertices: points,
  faces: doc.quads.flatMap((quad, index) => index === 4 ? [] : [[quad[0], quad[1], quad[3], quad[2]]]),
};
const score = scoreRetopologyCandidate(prepared.input, candidate, prepared.constraints);
check(score.faces.quadPercentage === 1 && score.faces.total === 8,
  'metric report counts an all-quad candidate');
check(score.surfaceDeviation.symmetricMaxM !== null && score.surfaceDeviation.symmetricMaxM < 1e-6,
  'surface deviation is symmetric and zero for the same flat source');
check(score.protectedBoundary.coverageFraction === 1 && score.protectedBoundary.knotMatchFraction === 1,
  'protected-boundary coverage and original control knots match an exact candidate');
check(score.patchQuality.minimumScaledJacobian.min !== null
  && Math.abs(score.patchQuality.minimumScaledJacobian.min - 1) < 1e-9,
'square patches receive the best scaled-Jacobian score');
check(score.trailAlignment.crossFieldDeviationDegrees.max !== null
  && score.trailAlignment.crossFieldDeviationDegrees.max < 1e-9,
'a grid parallel/perpendicular to the protected trail boundary has zero cross-field error');

const wholeCandidate: PolygonMesh = {
  vertices: points,
  faces: doc.quads.map(quad => [quad[0], quad[1], quad[3], quad[2]]),
};
const wholeIntegrated = integrateRetopologyCandidate(doc, wholeCandidate, wholePrepared.constraints, 'WHOLE FIXTURE');
check(wholeIntegrated.report.protectedPatches === 0
  && wholeIntegrated.report.candidatePatches === 9
  && wholeIntegrated.report.connectedComponents === 1
  && wholeIntegrated.report.embeddedTJunctions === 0,
'whole-surface integration replaces the complete source without creating a seam or T-nodes');
check(wholeIntegrated.report.transferredLockedPatches === 1
  && Object.keys(wholeIntegrated.document.quadLocked ?? {}).length === 1
  && wholeIntegrated.report.invertedCandidatePatches === 0,
'whole-surface integration transfers persistent locks and retains valid quad orientation');
const wholeCut = cutCandidateByLockedFootprint(doc, wholeCandidate, 2);
check(wholeCut.removedFaces === 1
  && wholeCut.protectedRegions === 1
  && wholeCut.cappedTriangularHoles === 0
  && wholeCut.boundaryLoops.join() === '4,12',
'locked-footprint cutting turns the whole candidate into one clean trail hole plus outer rim');

const multiVertices: number[] = [];
for (let row = 0; row < 6; row++) for (let col = 0; col < 6; col++) multiVertices.push(col, 0, row);
const multiQuads: number[][] = [];
for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) {
  const A = row * 6 + col, B = A + 1, C = A + 6, D = C + 1;
  multiQuads.push([A, B, C, D]);
}
const multiDoc: QuadMeshDoc = {
  ...doc,
  name: 'MULTI LOCK FIXTURE',
  vertices: multiVertices,
  vertexIds: Array.from({ length: 36 }, (_unused, vertex) => `mv:${vertex}`),
  quads: multiQuads,
  quadIds: Array.from({ length: 25 }, (_unused, quad) => `mq:${quad}`),
  quadLocked: { 6: true, 18: true },
  quadPaint: {},
  nextId: 62,
};
const multiCandidate: PolygonMesh = {
  vertices: Array.from({ length: multiVertices.length / 3 }, (_unused, vertex) =>
    [multiVertices[vertex * 3], multiVertices[vertex * 3 + 1], multiVertices[vertex * 3 + 2]]),
  faces: multiQuads.map(quad => [quad[0], quad[1], quad[3], quad[2]]),
};
const multiCut = cutCandidateByLockedFootprint(multiDoc, multiCandidate, 2);
check(multiCut.removedFaces === 2
  && multiCut.protectedRegions === 2
  && multiCut.boundaryLoops.join() === '4,4,20',
'whole-surface cutting preserves one candidate hole for every disconnected locked region');
const crossingSource: QuadMeshDoc = { ...multiDoc, quadLocked: { 12: true } };
const crossingCandidate: PolygonMesh = {
  vertices: multiCandidate.vertices.map(point => [...point] as V3),
  faces: multiCandidate.faces.map(face => [...face]),
};
crossingCandidate.vertices[14][0] = 2.4; crossingCandidate.vertices[20][0] = 2.4;
const crossingCut = cutCandidateByLockedFootprint(crossingSource, crossingCandidate, 2);
check(crossingCut.removedFaces > 1 && crossingCut.boundaryLoops.length === 2,
  'locked-footprint cutting removes a face that crosses the trail even when its center remains outside');

const repairVertices: V3[] = Array.from({ length: 49 }, (_unused, vertex) =>
  [vertex % 7, 0, Math.floor(vertex / 7)]);
const repairFaceAt = new Map<string, number>(), repairFaces: number[][] = [];
for (let row = 0; row < 6; row++) for (let column = 0; column < 6; column++) {
  if (row === 2 && column === 2) continue;
  const a = row * 7 + column, b = a + 1, c = a + 7, d = c + 1;
  repairFaceAt.set(`${row},${column}`, repairFaces.length); repairFaces.push([a, b, d, c]);
}
const boundaryRepair = removeCandidateFacesAndRepairBoundary(
  { vertices: repairVertices, faces: repairFaces }, new Set([repairFaceAt.get('2,4')!]),
);
check(boundaryRepair.removedFaces >= 2 && boundaryRepair.boundaryLoops.length === 2,
  'local seam repair grows an interior offending face into the existing feature hole');

const overlappingSheets: QuadMeshDoc = {
  kind: 'mountain', version: 5, name: 'OVERLAPPING SHEETS', spacing: 1,
  course: { knots: [], blend: 1, surface: 1 }, baseSurface: 1,
  vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1],
  vertexIds: Array.from({ length: 8 }, (_, vertex) => `overlap:v:${vertex}`),
  quads: [[0, 1, 2, 3], [4, 5, 6, 7]], quadIds: ['overlap:q:0', 'overlap:q:1'], nextId: 10,
};
const sheetPenetration = generatedProtectedFootprintPenetration(overlappingSheets, 1, 2);
check(generatedProtectedFootprintOverlaps(overlappingSheets, 1, 2).length > 0
  && sheetPenetration.penetratingCentroids > 0
  && sheetPenetration.maximumCentroidDepthM > 0,
  'top-down footprint validation rejects a generated sheet laid over a protected patch');

const ringPoints: V3[] = [
  [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [1, 0, 1],
  [0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0],
  [-2, 0, -2], [0, 0, -2], [2, 0, -2], [2, 0, 0], [2, 0, 2], [0, 0, 2], [-2, 0, 2], [-2, 0, 0],
  [-3, 0, -3], [0, 0, -3], [3, 0, -3], [3, 0, 0], [3, 0, 3], [0, 0, 3], [-3, 0, 3], [-3, 0, 0],
];
const expandedInner = [0, 4, 1, 5, 3, 6, 2, 7], conformOuter = [8, 9, 10, 11, 12, 13, 14, 15];
const far = [16, 17, 18, 19, 20, 21, 22, 23];
const stripCell = (inner: readonly number[], outside: readonly number[], at: number): number[] => {
  const perimeter = [inner[at], inner[(at + 1) % inner.length], outside[(at + 1) % outside.length], outside[at]];
  return [perimeter[0], perimeter[1], perimeter[3], perimeter[2]];
};
const conformQuads = [[0, 1, 2, 3],
  ...expandedInner.map((_vertex, at) => stripCell(expandedInner, conformOuter, at)),
  ...conformOuter.map((_vertex, at) => stripCell(conformOuter, far, at))];
const conformDoc: QuadMeshDoc = {
  ...doc,
  name: 'T SEAM FIXTURE',
  vertices: ringPoints.flat(), vertexIds: ringPoints.map((_point, vertex) => `cv:${vertex}`),
  quads: conformQuads, quadIds: conformQuads.map((_quad, face) => `cq:${face}`), nextId: 100,
  quadLocked: { 0: true }, quadPaint: {},
  tJunctions: [
    { vertex: 4, edge: [0, 1], t: .5 }, { vertex: 5, edge: [1, 3], t: .5 },
    { vertex: 6, edge: [3, 2], t: .5 }, { vertex: 7, edge: [2, 0], t: .5 },
  ],
};
const conformed = conformRetopologySeams(conformDoc, { collarRings: 1, footprintResolution: 2 });
check(conformed.report.removedTJunctions === 4 && conformed.report.remainingTJunctions === 0
  && conformed.report.wedges === 4 && conformed.report.invertedPatches === 0
  && conformed.report.connectedComponents === 1,
'seam conformance replaces a denser T-node collar with one connected guarded annulus');
check(conformed.report.maximumLockedControlDeviationM < 1e-9
  && conformed.report.maximumRetainedControlDeviationM < 1e-9,
'seam conformance keeps locked patches and terrain outside its collar bicubic-exact');
const multiWholePrepared = prepareRetopologyBenchmark(multiDoc, {
  wholeSurface: true, collarRings: 0, targetPatchSizeM: 1, tessellationResolution: 1,
});
const multiLockedIds = new Set(multiWholePrepared.constraints.lockedQuadIds);
const multiIntegrated = integrateRetopologyCandidate(multiDoc, multiCut.mesh, {
  ...multiWholePrepared.constraints,
  options: { ...multiWholePrepared.constraints.options, wholeSurface: false, refineBoundaryCorners: false },
  protectedQuadIds: [...multiLockedIds],
  remeshQuadIds: multiDoc.quadIds.filter(id => !multiLockedIds.has(id)),
}, 'MULTI LOCK INTEGRATED');
check(multiIntegrated.report.protectedPatches === 2
  && multiIntegrated.report.interfaceLoops.length === 2
  && multiIntegrated.report.connectedComponents === 1
  && multiIntegrated.report.invertedCandidatePatches === 0,
'plural-loop integration reinserts every disconnected locked region into one surface');
const selectedDoc: QuadMeshDoc = { ...multiDoc, quadLocked: { 12: true } };
const selectedIds = [6, 7, 8, 11, 12, 13, 16, 17, 18].map(quad => selectedDoc.quadIds[quad]);
const selectedPrepared = prepareSelectedRetopology(selectedDoc, selectedIds, 0, {
  targetPatchSizeM: 1, tessellationResolution: 1,
});
check(selectedPrepared.constraints.remeshQuadIds.length === 8
  && selectedPrepared.constraints.protectedQuadIds.length === 17
  && selectedPrepared.constraints.interface.length === 16
  && selectedPrepared.input.faces.length === 16,
'selected-region preparation freezes the outside and locked islands while triangulating only its unlocked solve');
const multiSelectedPrepared = prepareSelectedRetopology(multiDoc, selectedIds, 0, {
  targetPatchSizeM: 1, tessellationResolution: 1,
});
check(multiSelectedPrepared.constraints.lockedQuadIds.length === 2
  && multiSelectedPrepared.constraints.remeshQuadIds.length === 7
  && multiSelectedPrepared.constraints.interface.length === 12,
'one connected selected solve supports multiple exact locked islands');

const curvedSource: QuadMeshDoc = {
  kind: 'mountain', version: 5, name: 'CURVED SOURCE', spacing: 1,
  course: { knots: [], blend: 1, surface: 1 }, baseSurface: 1,
  vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1],
  vertexIds: ['cv:0', 'cv:1', 'cv:2', 'cv:3'], quads: [[0, 1, 2, 3]], quadIds: ['cq:0'], nextId: 5,
  quadTwist: { 0: [[0, 2, 0], [0, 2, 0], [0, 2, 0], [0, 2, 0]] },
};
const flatCandidate: QuadMeshDoc = { ...curvedSource, name: 'FLAT CANDIDATE', quadTwist: {} };
const curvedDerived = deriveQuadMesh(curvedSource), flatDerived = deriveQuadMesh(flatCandidate);
const curvedCenter = patchPoint(quadControlPoints(curvedDerived.mesh, curvedDerived.edgeHandle, 0, curvedDerived.twistOf(0)), .5, .5);
const flatCenter = patchPoint(quadControlPoints(flatDerived.mesh, flatDerived.edgeHandle, 0, flatDerived.twistOf(0)), .5, .5);
const fittedSurface = fitBezierSurfaceHeight(curvedSource, flatCandidate, 0, 8, {
  fitInteriorControls: true,
  maximumTwistCorrectionM: 2,
});
const fittedDerived = deriveQuadMesh(fittedSurface.document);
const fittedCenter = patchPoint(quadControlPoints(fittedDerived.mesh, fittedDerived.edgeHandle, 0, fittedDerived.twistOf(0)), .5, .5);
check(Math.abs(fittedCenter[1] - curvedCenter[1]) < Math.abs(flatCenter[1] - curvedCenter[1]) * .15
  && fittedSurface.report.fittedPatches === 1
  && fittedSurface.report.maximumInteriorControlCorrectionM > 1
  && fittedSurface.report.maximumInteriorControlCorrectionM <= fittedSurface.report.maximumInteriorControlLimitM,
'optional Bezier fitting uses bounded shared sub-cage controls to recover curvature without adding topology');
const fergusonSurface = fitBezierSurfaceHeight(curvedSource, flatCandidate, 0, 8);
check(fergusonSurface.report.fittedPatches === 0
  && fergusonSurface.report.maximumInteriorControlCorrectionM === 0
  && !fergusonSurface.document.quadTwist?.[0],
'Bezier surface seating defaults generated patches to clean zero-twist Ferguson controls');

const referenceCandidate: PolygonMesh = {
  vertices: [[0, 1, 0], [3, 1, 0], [3, 1, 3], [0, 1, 3]],
  faces: [[0, 1, 2, 3]],
};
const referencePoints = polygonPatchPoints(referenceCandidate, referenceCandidate.faces[0]);
check(referencePoints.length === 16
  && referencePoints[0].join() === '0,0,100'
  && referencePoints[3].join() === '-300,0,100'
  && referencePoints[12].join() === '0,-300,100'
  && referencePoints[15].join() === '-300,-300,100',
'reference packaging degree-elevates perimeter quads and converts metres to raw SSX coordinates');
const referencePatches = candidateReferencePatches(referenceCandidate, 'TEST');
check(referencePatches.length === 1 && referencePatches[0].Points.length === 16
  && referencePatches[0].TexturePath === 'snow.png',
'reference packaging emits one textured bicubic patch per candidate polygon');

const fieldMesh: PolygonMesh = {
  vertices: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]],
  faces: [[0, 3, 2], [0, 1, 3]],
};
const sharpLines = quadWildSharp(fieldMesh).trim().split('\n');
check(sharpLines[0] === '4' && sharpLines.length === 5,
'QuadWild feature export marks exactly the open triangle-mesh boundary');
const internalGuide = [{ edgeVertexIds: ['a', 'b'] as [string, string], samples: [[0, 0, 0], [1, 0, 1]] as V3[] }];
const featureSharpLines = quadWildSharp(fieldMesh, internalGuide).trim().split('\n');
check(featureSharpLines[0] === '5' && featureSharpLines.length === 6,
'whole-surface feature export adds an internal trail guide without cutting a hole');
const sampledGuide = [{ edgeVertexIds: ['a', 'b'] as [string, string], samples: [
  [0, 0, 0], [.4, 0, .6], [1, 0, 1],
] as V3[] }];
const proxySharpLines = quadWildSharp(fieldMesh, sampledGuide).trim().split('\n');
check(proxySharpLines[0] === '5' && proxySharpLines.length === 6,
'resolution-1 topology proxies match a full cubic guide by its endpoint chord');
const internalRosyLines = quadWildTrailField(fieldMesh, internalGuide, { iterations: 2 }).trim().split('\n');
check(internalRosyLines.length === 4 && internalRosyLines.slice(2)
  .every(line => line.split(' ').map(Number).every(Number.isFinite)),
'whole-surface trail guidance constrains faces on both sides of an internal feature');
const rosyLines = quadWildTrailField(fieldMesh, [{ edgeVertexIds: ['a', 'b'], samples: [[0, 0, 0], [1, 0, 0]] }], {
  iterations: 2,
}).trim().split('\n');
check(rosyLines[0] === '2' && rosyLines[1] === '4' && rosyLines.length === 4
  && rosyLines.slice(2).every(line => line.split(' ').map(Number).every(Number.isFinite)),
'trail-driven QuadWild field emits one finite tangent vector per input face');

const inner: V3[] = [[1, 0, 1], [1.5, 0, 1], [2, 0, 1], [2, 0, 1.5],
  [2, 0, 2], [1.5, 0, 2], [1, 0, 2], [1, 0, 1.5]];
const outer: V3[] = [[0, 0, 0], [1.5, 0, 0], [3, 0, 0], [3, 0, 1.5],
  [3, 0, 3], [1.5, 0, 3], [0, 0, 3], [0, 0, 1.5]];
const ringCandidate: PolygonMesh = {
  vertices: [...inner, ...outer],
  faces: Array.from({ length: 8 }, (_, i) => [i, (i + 1) % 8, 8 + (i + 1) % 8, 8 + i]),
};
const displacedRim: PolygonMesh = {
  vertices: ringCandidate.vertices.map((point, vertex) => vertex === 8 ? [-.4, 0, -.3] : [...point] as V3),
  faces: ringCandidate.faces.map(face => [...face]),
};
const conformedRim = conformCandidateOuterBoundary(doc, displacedRim);
check(conformedRim.movedVertices > 0 && conformedRim.maximumMoveM > .49
  && Math.hypot(conformedRim.mesh.vertices[8][0], conformedRim.mesh.vertices[8][2]) < 1e-6
  && conformedRim.mesh.vertices[0].join() === displacedRim.vertices[0].join(),
'outer-rim conformance restores the source perimeter without moving an internal trail hole');
const exactBufferConstraints = {
  ...wholePrepared.constraints,
  options: {
    ...wholePrepared.constraints.options,
    wholeSurface: false,
    collarRings: 0,
    regularizeCandidate: true,
    refineBoundaryCorners: false,
    arcLengthInterfaceParameters: true,
  },
  protectedQuadIds: [...wholePrepared.constraints.lockedQuadIds],
  remeshQuadIds: doc.quadIds.filter(id => !wholePrepared.constraints.lockedQuadIds.includes(id)),
};
const exactBuffer = buildExactTrailBuffer(doc, ringCandidate, exactBufferConstraints);
check(exactBuffer.collarPatches === 4
  && exactBuffer.collarLoops[0].innerEdges === 4
  && exactBuffer.collarLoops[0].outerCandidateEdges === 8
  && exactBuffer.constraints.protectedQuadIds.length === 5,
'exact-trail buffer adds one protected transition quad per authored trail boundary edge');
check(Object.keys(exactBuffer.source.quadLocked ?? {}).join() === '4',
'generated transition collars do not expand the persistent trail lock');
check(exactBuffer.source.quads.slice(-exactBuffer.collarPatches).every(quad => {
  const at = (vertex: number): V3 => [exactBuffer.source.vertices[vertex * 3],
    exactBuffer.source.vertices[vertex * 3 + 1], exactBuffer.source.vertices[vertex * 3 + 2]];
  const [A, B, C] = [at(quad[0]), at(quad[1]), at(quad[2])];
  return (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]) > 0;
}), 'transition collar patches are wound with their surface normals facing upward');
const exactBufferIntegration = integrateRetopologyCandidate(
  exactBuffer.source, ringCandidate, exactBuffer.constraints, 'EXACT BUFFER FIXTURE', exactBuffer.refinement,
  { topologyAwareAlignment: false, enforceProtectedSide: false, collapseFlatInterfaceFaces: true },
);
check(exactBufferIntegration.report.crossingInterfaceEdges === 0
  && exactBufferIntegration.report.invertedCandidatePatches === 0
  && exactBufferIntegration.report.protectedControlDeviationM < 1e-12,
'trail-buffer integration reuses its cyclic corner assignment without crossing the protected collar');
const integratedFixture = integrateRetopologyCandidate(doc, ringCandidate, prepared.constraints, 'INTEGRATED FIXTURE');
check(integratedFixture.report.connectedComponents === 1
  && integratedFixture.report.sourceInterfaceEdges === 4
  && integratedFixture.report.candidateInterfaceEdges === 8
  && integratedFixture.report.crossingInterfaceEdges === 0
  && integratedFixture.report.crossingInterfaceFaces.length === 0,
'integration joins a denser candidate boundary to the protected patch as one component');
check(generatedProtectedFootprintOverlaps(
  integratedFixture.document, integratedFixture.report.protectedPatches, 4,
).length === 0, 'top-down footprint validation permits an exact shared protected/generated boundary');
check(integratedFixture.report.embeddedTJunctions === 4
  && integratedFixture.report.protectedControlDeviationM < 1e-12
  && integratedFixture.report.minimumCandidateCornerJacobian > 0,
'integration embeds extra boundary vertices while preserving every protected Bezier control exactly');
const repeatedPrepared = prepareRetopologyBenchmark(integratedFixture.document, {
  wholeSurface: true, collarRings: 0, targetPatchSizeM: 1, tessellationResolution: 1,
});
const repeatedInterfaceDegree = new Map<string, number>();
for (const curve of repeatedPrepared.constraints.interface) for (const vertex of curve.edgeVertexIds) {
  repeatedInterfaceDegree.set(vertex, (repeatedInterfaceDegree.get(vertex) ?? 0) + 1);
}
check(repeatedPrepared.constraints.interface.length === 4
  && [...repeatedInterfaceDegree.values()].every(degree => degree === 2),
'repeat retopology recovers a closed protected loop from an already integrated T-junction interface');
check(integratedFixture.document.tombstones?.includes('q:0') === true
  && integratedFixture.document.tombstones?.includes('q:4') !== true,
'integration retires replaced stable ids without tombstoning exact protected patches');
const skewedRing: PolygonMesh = {
  vertices: ringCandidate.vertices.map((point, vertex) => vertex === 1 ? [.5, 0, 1] : [...point] as V3),
  faces: ringCandidate.faces.map(face => [...face]),
};
const nearestInterface = integrateRetopologyCandidate(doc, skewedRing, {
  ...prepared.constraints,
  options: { ...prepared.constraints.options, arcLengthInterfaceParameters: false },
}, 'NEAREST INTERFACE');
const orderedInterface = integrateRetopologyCandidate(doc, skewedRing, {
  ...prepared.constraints,
  options: { ...prepared.constraints.options, arcLengthInterfaceParameters: true },
}, 'ORDERED INTERFACE');
check(nearestInterface.report.candidateAspectRatio.max > 100
  && orderedInterface.report.candidateAspectRatio.max < 20
  && orderedInterface.report.invertedCandidatePatches === 0,
'ordered chord-length interface placement prevents surplus boundary vertices from collapsing onto a protected corner');
const paintedFixture = integrateRetopologyCandidate(
  doc, ringCandidate, prepared.constraints, 'PAINTED FIXTURE', undefined, { preserveSurfacePaint: true });
check(paintedFixture.document.quadPaint?.[0] === 9
  && Object.values(paintedFixture.document.quadPaint ?? {}).some(surface => surface === 7),
'protected integration keeps locked paint exact and projects source surfaces onto generated patches');

// A coarse solver can omit protected corners from its boundary. The integrator reuses any boundary vertex
// that cyclically corresponds to a protected corner, inserts only the missing corners by strip-splitting the
// boundary-facing quads, and records the opposite points as dependent T-nodes.
const coarseInner: V3[] = [[1.5, 0, 1], [2, 0, 1.5], [1.5, 0, 2], [1, 0, 1.5]];
const coarseMiddle: V3[] = [[1.5, 0, .5], [2.5, 0, 1.5], [1.5, 0, 2.5], [.5, 0, 1.5]];
const coarseOuter: V3[] = [[1.5, 0, 0], [3, 0, 1.5], [1.5, 0, 3], [0, 0, 1.5]];
const coarseCandidate: PolygonMesh = {
  vertices: [...coarseInner, ...coarseMiddle, ...coarseOuter],
  faces: [
    ...Array.from({ length: 4 }, (_, i) => [i, (i + 1) % 4, 4 + (i + 1) % 4, 4 + i]),
    ...Array.from({ length: 4 }, (_, i) => [4 + i, 4 + (i + 1) % 4, 8 + (i + 1) % 4, 8 + i]),
  ],
};
const refinedFixture = integrateRetopologyCandidate(doc, coarseCandidate, prepared.constraints, 'REFINED FIXTURE');
const refinedTJunctions = findTJunctions(refinedFixture.document);
check(refinedFixture.report.boundaryRefinementPatches === 3
  && refinedFixture.report.boundaryRefinementTJunctions === 3
  && refinedFixture.report.candidateInterfaceEdges === 7,
'integration locally refines coarse boundary edges that skip protected trail corners');
check(refinedFixture.report.invertedCandidatePatches === 0
  && refinedTJunctions.length === refinedFixture.report.embeddedTJunctions
  && refinedTJunctions.every(node => node.distance < 1e-9),
'dependent refinement T-nodes remain seated while the generated collar untangles');
const preparedCoarseRefinement = refineCoarseCandidateInterface(doc, coarseCandidate, prepared.constraints);
const preparedCoarseFixture = integrateRetopologyCandidate(
  doc,
  preparedCoarseRefinement!.mesh,
  prepared.constraints,
  'PREPARED REFINED FIXTURE',
  preparedCoarseRefinement!,
);
check(preparedCoarseFixture.report.invertedCandidatePatches === 0
  && preparedCoarseFixture.report.boundaryRefinementTJunctions === 3
  && findTJunctions(preparedCoarseFixture.document).every(node => node.distance < 1e-9),
'precomputed refinement keeps dependent strip edges movable instead of misclassifying them as fixed boundaries');

// An L-shaped locked feature leaves a concave collar notch. A candidate boundary "ear" can fill that notch
// with all four corners on the interface, one of them a surplus knot lying exactly on the straight chord
// between two protected corners. That face is a triangle carrying a redundant knot: it must collapse to a
// single wedge triangle instead of being rejected as a numerically inverted patch.
function earGrid(): QuadMeshDoc {
  const vertices: number[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) vertices.push(col, 0, row);
  const quads: number[][] = [];
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const A = row * 5 + col, B = A + 1, C = A + 5, D = C + 1;
    quads.push([A, B, C, D]);
  }
  return {
    kind: 'mountain', version: 5, name: 'EAR FIXTURE', spacing: 1,
    course: { knots: [], blend: 1, surface: 1 }, baseSurface: 1,
    vertices,
    vertexIds: Array.from({ length: 25 }, (_, i) => `v:${i}`),
    quads,
    quadIds: Array.from({ length: 16 }, (_, i) => `q:${i}`),
    nextId: 50,
    quadLocked: { 5: true, 6: true, 10: true },
  };
}
const earDoc = earGrid();
const earPrepared = prepareRetopologyBenchmark(earDoc, {
  collarRings: 0, targetPatchSizeM: 1, tessellationResolution: 1,
});
const earKnot = 25;
const earCandidate: PolygonMesh = {
  vertices: [
    ...Array.from({ length: 25 }, (_, i): V3 => [i % 5, 0, Math.floor(i / 5)]),
    [2, 0, 2.5],
  ],
  faces: earDoc.quads.flatMap((quad, index) => {
    if (earDoc.quadLocked?.[index]) return [];
    // The cell at the concave corner becomes the flat ear plus a companion wedge covering its remainder.
    if (index === 9) return [[11, 12, earKnot, 17], [11, 17, 16, 16]];
    return [[quad[0], quad[1], quad[3], quad[2]]];
  }),
};
const earRefinement = {
  mesh: earCandidate,
  fixedBoundary: [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5],
  interfaceLoops: [[6, 7, 8, 13, 18, 17, earKnot, 12, 11]],
  cornerVertices: [[6, 7, 8, 13, 18, 17, 12, 11]],
  tJunctions: [], curveSegments: [], addedPatches: 0,
};
const earFixture = integrateRetopologyCandidate(
  earDoc, earCandidate, earPrepared.constraints, 'EAR FIXTURE', earRefinement,
  { collapseFlatInterfaceFaces: true },
);
check(earFixture.report.collapsedInterfaceFaces.length === 1
  && earFixture.report.invertedCandidatePatches === 0
  && earFixture.report.connectedComponents === 1,
'a flat boundary ear with four interface corners collapses to a single wedge triangle');

console.log(failures ? '\nRETOPOLOGY: FAIL' : '\nRETOPOLOGY: PASS');
process.exit(failures ? 1 : 0);
