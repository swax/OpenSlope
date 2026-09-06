/** Merge a scored all-quad candidate into exact locked trail patches and package an editable/reference map. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { migrateMountain } from '../../src/core/doc/mountain';
import { serializeMountain } from '../../src/core/doc/serialize';
import { buildReferenceMesh } from '../../src/core/reference/terrain';
import { authoredPatches } from '../../src/app/reference/authored';
import type { RetopologyConstraints } from '../../src/core/mesh/retopology/benchmark';
import { buildExactTrailBuffer, cutCandidateByLockedFootprint, documentCageShapeDistributions, fitBezierSurfaceHeight, integrateRetopologyCandidate, refineCoarseCandidateInterface } from '../../src/core/mesh/retopology/integrate';
import { scoreSurfaceDeviation } from '../../src/core/mesh/retopology/metrics';
import { readObj, writeObj, type PolygonMesh } from '../../src/core/mesh/retopology/obj';
import { findTJunctions, normalizeTJunctions } from '../../src/core/mesh/t-junctions';

const args = process.argv.slice(2);
const value = (name: string, fallback?: string): string => {
  const at = args.indexOf(name), found = at >= 0 ? args[at + 1] : undefined;
  if (found !== undefined) return found;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name}`);
};
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const numberValue = (name: string, fallback: number): number => {
  const parsed = Number(value(name, String(fallback)));
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
};
const polygonMeshFromReference = (reference: ReturnType<typeof buildReferenceMesh>): PolygonMesh => ({
  vertices: Array.from({ length: reference.positions.length / 3 }, (_, vertex) => [
    reference.positions[vertex * 3], reference.positions[vertex * 3 + 1], reference.positions[vertex * 3 + 2],
  ]),
  faces: Array.from({ length: reference.indices.length / 3 }, (_, face) => [
    reference.indices[face * 3], reference.indices[face * 3 + 1], reference.indices[face * 3 + 2],
  ]),
});

const sourceFile = resolve(value('--source'));
const candidateFile = resolve(value('--candidate'));
const constraintsFile = resolve(value('--constraints'));
const out = resolve(value('--out'));
const qualityResolution = Math.max(2, Math.floor(numberValue('--quality-resolution', 4)));
const name = value('--name', `${basename(sourceFile).replace(/\.slope\.json$/i, '')}_RETOPO_QUADWILD_INTEGRATED`);
if (existsSync(out) && !args.includes('--overwrite')) throw new Error(`Output already exists: ${out}`);

const source = migrateMountain(readJson<unknown>(sourceFile));
let integrationSource = source;
const candidateText = readFileSync(candidateFile, 'utf8');
let candidate = candidateFile.toLowerCase().endsWith('.slope.json') ? (() => {
  const doc = migrateMountain(JSON.parse(candidateText));
  return {
    vertices: Array.from({ length: doc.vertices.length / 3 }, (_unused, vertex) => [
      doc.vertices[vertex * 3], doc.vertices[vertex * 3 + 1], doc.vertices[vertex * 3 + 2],
    ] as [number, number, number]),
    faces: doc.quads.map(([A, B, C, D]) => [A, B, D, C]),
  } satisfies PolygonMesh;
})() : readObj(candidateText);
const archivedCandidateObj = writeObj(candidate, basename(candidateFile));
let constraints = readJson<RetopologyConstraints>(constraintsFile);
const trailBuffer = args.includes('--trail-buffer');
const preserveLocked = args.includes('--preserve-locked') || trailBuffer;
const footprintRings = Math.max(0, Math.min(4, Math.floor(numberValue('--footprint-rings', 0))));
let lockedFootprintCut: ReturnType<typeof cutCandidateByLockedFootprint> | undefined;
let exactTrailBuffer: ReturnType<typeof buildExactTrailBuffer> | undefined;
let coarseInterfaceRefinement: Exclude<ReturnType<typeof refineCoarseCandidateInterface>, null> | undefined;
if (preserveLocked) {
  if (!constraints.options.wholeSurface) throw new Error('--preserve-locked needs a whole-surface benchmark candidate');
  lockedFootprintCut = cutCandidateByLockedFootprint(source, candidate, constraints.options.tessellationResolution, footprintRings);
  console.log(`Footprint cut: removed ${lockedFootprintCut.removedFaces} QuadWild faces, capped ${lockedFootprintCut.cappedTriangularHoles} pinholes; boundary loops ${lockedFootprintCut.boundaryLoops.join('/')}`);
  candidate = lockedFootprintCut.mesh;
  const locked = new Set(constraints.lockedQuadIds);
  constraints = {
    ...constraints,
    options: {
      ...constraints.options,
      wholeSurface: false,
      collarRings: 0,
      regularizeCandidate: trailBuffer,
      refineBoundaryCorners: !trailBuffer && !args.includes('--no-boundary-refine'),
      arcLengthInterfaceParameters: trailBuffer,
    },
    protectedQuadIds: [...constraints.lockedQuadIds],
    remeshQuadIds: source.quadIds.filter(id => !locked.has(id)),
  };
  if (!trailBuffer && args.includes('--no-boundary-refine')) {
    coarseInterfaceRefinement = refineCoarseCandidateInterface(source, candidate, constraints) ?? undefined;
    if (coarseInterfaceRefinement) {
      candidate = coarseInterfaceRefinement.mesh;
      console.log(`Minimum interface: added ${coarseInterfaceRefinement.addedPatches} strip patches and ${coarseInterfaceRefinement.tJunctions.length} dependent T-nodes`);
    }
  }
  if (trailBuffer) {
    coarseInterfaceRefinement = refineCoarseCandidateInterface(source, candidate, constraints) ?? undefined;
    if (coarseInterfaceRefinement) {
      candidate = coarseInterfaceRefinement.mesh;
      console.log(`Coarse interface: added ${coarseInterfaceRefinement.addedPatches} strip patches and ${coarseInterfaceRefinement.tJunctions.length} dependent T-nodes`);
    }
    exactTrailBuffer = buildExactTrailBuffer(source, candidate, constraints, coarseInterfaceRefinement);
    integrationSource = exactTrailBuffer.source;
    constraints = exactTrailBuffer.constraints;
    console.log(`Trail buffer: ${exactTrailBuffer.collarPatches} protected collar patches; ${exactTrailBuffer.collarLoops.map(loop => `${loop.innerEdges}->${loop.outerCandidateEdges}`).join(', ')} edges; adjusted ${exactTrailBuffer.adjustedOuterVertices} outer vertices`);
  }
}
let integrated = integrateRetopologyCandidate(integrationSource, candidate, constraints, name,
  exactTrailBuffer?.refinement ?? coarseInterfaceRefinement);
const fitBezierVerticesOnly = args.includes('--fit-bezier-vertices-only');
const fitBezierSharedTwist = args.includes('--fit-bezier-shared-twist');
const fitBezier = args.includes('--fit-bezier') || fitBezierVerticesOnly || fitBezierSharedTwist;
const bezierSurfaceFit = fitBezier
  ? fitBezierSurfaceHeight(source, integrated.document, integrated.report.protectedPatches, qualityResolution, {
    fitInteriorControls: fitBezierSharedTwist,
    maximumTwistCorrectionM: numberValue('--maximum-twist', Math.max(2, Math.min(4, (source.spacing || 25) * .1))),
  })
  : undefined;
if (bezierSurfaceFit) {
  integrated = { ...integrated, document: bezierSurfaceFit.document };
  console.log(`Bezier fit: seated ${bezierSurfaceFit.report.fittedVertices} vertices and fitted ${bezierSurfaceFit.report.fittedPatches} interior sub-cages (${fitBezierSharedTwist ? 'shared twist field' : 'zero twist'})`);
}
const normalized = normalizeTJunctions(integrated.document);
if (normalized.length !== integrated.document.tJunctions?.length) throw new Error('Integrated T-junction records failed normalization');
if (integrated.report.connectedComponents !== 1) throw new Error(`Integrated output has ${integrated.report.connectedComponents} components`);
if (integrated.report.protectedControlDeviationM > 1e-9) {
  throw new Error(`Protected trail moved by ${integrated.report.protectedControlDeviationM} m`);
}
const diagnosticInvalid = args.includes('--diagnostic-invalid');
if (integrated.report.invertedCandidatePatches && !diagnosticInvalid) {
  throw new Error(`Integrated output still has ${integrated.report.invertedCandidatePatches} inverted patch(es)`);
}
const tJunctions = findTJunctions(integrated.document);
const maximumTJunctionGapM = Math.max(0, ...tJunctions.map(node => node.distance));
if (maximumTJunctionGapM > 1e-6 && !diagnosticInvalid) throw new Error(`Integrated T-junction gap is ${maximumTJunctionGapM} m`);
const patches = authoredPatches(integrated.document);
const reference = buildReferenceMesh(patches, undefined, 1);
if (reference.patchCount !== integrated.document.quads.length) throw new Error('Integrated reference tessellation lost patches');
const sourceQualityMesh = polygonMeshFromReference(buildReferenceMesh(authoredPatches(source), undefined, qualityResolution));
const candidateQualityMesh = polygonMeshFromReference(buildReferenceMesh(patches, undefined, qualityResolution));
const bezierSurfaceDeviation = scoreSurfaceDeviation(sourceQualityMesh, candidateQualityMesh);
const collarShape = exactTrailBuffer ? documentCageShapeDistributions(
  integrated.document,
  Array.from({ length: exactTrailBuffer.collarPatches }, (_unused, i) =>
    integrated.report.protectedPatches - exactTrailBuffer!.collarPatches + i),
) : undefined;
if (collarShape && collarShape.minimumCornerJacobian.min <= 0 && !diagnosticInvalid) {
  throw new Error(`Generated trail collar has minimum corner Jacobian ${collarShape.minimumCornerJacobian.min}`);
}
const notes = exactTrailBuffer ? [
  'The original locked bicubic trail patches are retained exactly.',
  'A generated one-patch trail-shaped collar moves candidate edge-count transitions away from the trail boundary.',
  'Extra QuadWild boundary vertices become explicit T-nodes on the collar outer edge.',
  'Generated terrain uses smooth derived Bezier handles rather than planar creased patch elevation.',
] : constraints.options.wholeSurface ? [
  'The locked trail and mountain were triangulated and retopologized as one surface with no protected hole.',
  'Trail locks, paint, and textures were transferred by nearest source patch; original trail connectivity was intentionally replaced.',
  'The internal trail boundary guided field/feature alignment but did not form a cut interface.',
  'Generated terrain uses smooth derived Bezier handles rather than planar creased patch elevation.',
] : [
  'Locked trail patches retain their exact source bicubic control points.',
  'Original trail corners are conforming shared vertices; extra candidate seam vertices are explicit T-nodes.',
  'Coarse candidate edges that skip protected corners are locally strip-refined with dependent interior T-nodes.',
  'A harmonic displacement field spreads the exact trail seam through generated terrain while pinning the outer rim.',
  'Candidate seam edges are exact cubic subdivisions of the retained trail edges.',
  'Generated terrain uses smooth derived Bezier handles rather than planar creased patch elevation.',
];
if (constraints.options.tessellationResolution === 1) notes.push(
  'QuadWild received a resolution-1 topology proxy; the full-resolution bicubic source is restored during validation/fitting rather than encoded as extra control patches.',
);
if (bezierSurfaceFit) notes.push(fitBezierSharedTwist
  ? 'Generated cage vertices are bounded-height seated; patch-local surface estimates are reduced to a shared, smoothed, tightly bounded per-vertex interior-control field.'
  : 'Generated cage vertices are bounded-height seated; generated patches remain pure zero-twist Ferguson patches, matching the source mountain control convention.',
);
if (!exactTrailBuffer && integrated.report.sourceInterfaceEdges === integrated.report.candidateInterfaceEdges
  && integrated.report.embeddedTJunctions === 0) notes.push(
  'The retained trail and generated mountain meet through a one-to-one conforming interface with no collar or T-nodes.',
);

mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${name}.slope.json`), `${JSON.stringify(serializeMountain(integrated.document), null, 2)}\n`);
writeFileSync(join(out, 'Patches.json'), `${JSON.stringify({ Patches: patches })}\n`);
writeFileSync(join(out, 'Retopology.json'), `${JSON.stringify({
  kind: 'slopesmith-integrated-retopology', version: 1, name,
  source: basename(sourceFile), candidate: basename(candidateFile), report: integrated.report,
  lockedFootprintCut: lockedFootprintCut && {
    removedFaces: lockedFootprintCut.removedFaces,
    boundaryLoops: lockedFootprintCut.boundaryLoops,
    bufferRings: lockedFootprintCut.bufferRings,
    cappedTriangularHoles: lockedFootprintCut.cappedTriangularHoles,
  },
  exactTrailBuffer: exactTrailBuffer && {
    collarPatches: exactTrailBuffer.collarPatches,
    collarLoops: exactTrailBuffer.collarLoops,
    adjustedOuterVertices: exactTrailBuffer.adjustedOuterVertices,
    collarShape,
  },
  bezierSurfaceFit: bezierSurfaceFit?.report,
  validation: { qualityResolution, maximumTJunctionGapM, bezierSurfaceDeviation },
  notes,
}, null, 2)}\n`);
writeFileSync(join(out, 'candidate.obj'), archivedCandidateObj);
for (const auxiliary of ['AIP.json', 'SOP.json', 'Lights.json']) {
  const file = join(dirname(sourceFile), auxiliary);
  if (existsSync(file)) copyFileSync(file, join(out, auxiliary));
}
console.log(`${name}: ${integrated.report.protectedPatches} exact + ${integrated.report.candidatePatches} retopologized patches`);
if (lockedFootprintCut) console.log(`  footprint cut removed ${lockedFootprintCut.removedFaces} QuadWild faces; boundary loops ${lockedFootprintCut.boundaryLoops.join('/')}`);
if (collarShape) console.log(`  collar edge median/p95 ${collarShape.edgeLength.median.toFixed(2)}/${collarShape.edgeLength.p95.toFixed(2)} m; aspect median/p95 ${collarShape.aspect.median.toFixed(2)}/${collarShape.aspect.p95.toFixed(2)}; minimum Jacobian ${collarShape.minimumCornerJacobian.min.toFixed(4)}`);
console.log(`  ${integrated.report.sourceInterfaceEdges} trail edges <- ${integrated.report.candidateInterfaceEdges} candidate edges, ${integrated.report.embeddedTJunctions} T-nodes`);
console.log(`  ${integrated.report.connectedComponents} component, protected deviation ${integrated.report.protectedControlDeviationM} m, maximum snap ${integrated.report.maximumBoundarySnapM.toFixed(3)} m`);
console.log(`  minimum candidate corner Jacobian ${integrated.report.minimumCandidateCornerJacobian.toFixed(4)}, ${integrated.report.invertedCandidatePatches} inverted patches`);
console.log(`  relaxed ${integrated.report.relaxedCandidateVertices} vertices (${integrated.report.invertedCandidatePatchesBeforeRelax} inverted before)`);
if (constraints.options.wholeSurface) console.log(`  transferred ${integrated.report.transferredLockedPatches} locked trail patches by source-surface proximity; regularized ${integrated.report.regularizedCandidateVertices} vertices`);
console.log(`  final cage edge median/p95 ${integrated.report.candidateEdgeLengthM.median.toFixed(2)}/${integrated.report.candidateEdgeLengthM.p95.toFixed(2)} m; aspect median/p95 ${integrated.report.candidateAspectRatio.median.toFixed(2)}/${integrated.report.candidateAspectRatio.p95.toFixed(2)}`);
if (bezierSurfaceFit) console.log(`  fitted cage corrections: vertex max ${bezierSurfaceFit.report.maximumVertexCorrectionM.toFixed(3)} m; interior median/p95/max ${bezierSurfaceFit.report.interiorControlCorrectionM.median.toFixed(3)}/${bezierSurfaceFit.report.interiorControlCorrectionM.p95.toFixed(3)}/${bezierSurfaceFit.report.maximumInteriorControlCorrectionM.toFixed(3)} m (limit ${bezierSurfaceFit.report.maximumInteriorControlLimitM.toFixed(3)} m); ${bezierSurfaceFit.report.missedHeightSamples} missed / ${bezierSurfaceFit.report.rejectedAmbiguousHeightSamples} ambiguous samples; ${bezierSurfaceFit.report.clampedInteriorControls} raw estimates over limit`);
console.log(`  T-node gap ${maximumTJunctionGapM.toExponential(2)} m; Bezier deviation p95 ${bezierSurfaceDeviation.sourceToCandidateM.p95?.toFixed(3) ?? 'n/a'} m, max ${bezierSurfaceDeviation.symmetricMaxM?.toFixed(3) ?? 'n/a'} m`);
console.log(`  wrote ${out}`);
