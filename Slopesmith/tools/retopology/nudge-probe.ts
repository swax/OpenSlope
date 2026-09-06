/** Offline diagnostic for the direct-join nudge repair: replays conform -> leaning nudge ->
 * integrate -> seam nudge passes on a saved hole-mode candidate job directory, dissects whatever
 * crossing survives, and prints the conforming footprint-gate verdict.
 * Usage: npx tsx tools/retopology/nudge-probe.ts <job-dir> <mountain.slope.json> */
import { readFileSync, readdirSync } from 'node:fs';
import { migrateMountain } from '../../src/core/doc/mountain';
import { prepareRetopologyBenchmark, protectedQuadSet, tessellateQuads } from '../../src/core/mesh/retopology/benchmark';
import {
  conformCandidateOuterBoundary, facesLeaningOverLockedFootprint, generatedProtectedFootprintPenetration,
  integrateRetopologyCandidate, nudgeCrossingVerticesOffLockedFootprint, nudgeLeaningFacesOffLockedFootprint,
} from '../../src/core/mesh/retopology/integrate';
import { readObj, type PolygonMesh } from '../../src/core/mesh/retopology/obj';
import { boundaryLoops } from '../../src/core/mesh/retopology/prescribe';
import { undirectedEdgeKey } from '../../src/core/mesh/primitives';

const jobDir = process.argv[2];
const sourceFile = process.argv[3];
if (!jobDir || !sourceFile) {
  console.error('Usage: npx tsx tools/retopology/nudge-probe.ts <job-dir> <mountain.slope.json>');
  process.exit(2);
}

const source = migrateMountain(JSON.parse(readFileSync(sourceFile, 'utf8')));
const quadName = readdirSync(jobDir).find(name => /_quadrangulation_smooth\.obj$/.test(name));
if (!quadName) throw new Error('no smooth quadrangulation in job dir');
let candidate = readObj(readFileSync(`${jobDir}/${quadName}`, 'utf8'));

const prepared = prepareRetopologyBenchmark(source, {
  collarRings: 0,
  targetPatchSizeM: 25,
  tessellationResolution: 1,
  wholeSurface: false,
});
const constraints = {
  ...prepared.constraints,
  options: {
    ...prepared.constraints.options,
    wholeSurface: false,
    collarRings: 0,
    regularizeCandidate: false,
    refineBoundaryCorners: false,
    arcLengthInterfaceParameters: true,
  },
};

const loopSummary = (mesh: PolygonMesh): string =>
  boundaryLoops(mesh).map(loop => loop.length).sort((a, b) => a - b).join(', ');
console.log(`candidate rims [${loopSummary(candidate)}]`);

const rim = conformCandidateOuterBoundary(source, candidate);
candidate = rim.mesh;

// mirror the helper's outline machinery for diagnosis
const locked = protectedQuadSet(source, 0);
const meshBoundary = (mesh: PolygonMesh): [number, number][] => {
  const occurrences = new Map<string, { edge: [number, number]; count: number }>();
  for (const face of mesh.faces) for (let i = 0; i < face.length; i++) {
    const edge: [number, number] = [face[i], face[(i + 1) % face.length]];
    if (edge[0] === edge[1]) continue;
    const key = undirectedEdgeKey(edge[0], edge[1]);
    const found = occurrences.get(key);
    if (found) found.count++; else occurrences.set(key, { edge, count: 1 });
  }
  return [...occurrences.values()].filter(record => record.count === 1).map(record => record.edge);
};
const footprint = tessellateQuads(source, locked, 1);
const chordalPoints = meshBoundary({ vertices: footprint.vertices, faces: footprint.faces })
  .flat().map(vertex => [footprint.vertices[vertex][0], footprint.vertices[vertex][2]] as [number, number]);
const nearestCorner = (x: number, z: number): number =>
  Math.min(...chordalPoints.map(([px, pz]) => Math.hypot(px - x, pz - z)));
const describeFace = (face: number) => {
  const quad = candidate.faces[face];
  console.log(`  face ${face}: ${quad.map(vertex => {
    const point = candidate.vertices[vertex];
    return `v${vertex}(corner ${nearestCorner(point[0], point[2]).toFixed(2)}m)`;
  }).join(' ')}`);
};

const before = facesLeaningOverLockedFootprint(source, candidate);
console.log(`leaning faces before nudge: ${before.length}`);
for (const face of before.slice(0, 30)) describeFace(face);
const leaning = nudgeLeaningFacesOffLockedFootprint(source, candidate);
console.log(`leaning nudge: moved ${leaning.nudgedVertices} (max ${leaning.maximumNudgeM.toFixed(2)} m) `
  + `in ${leaning.passes} pass(es), resolved ${leaning.resolved}`);
if (!leaning.resolved) {
  for (const face of facesLeaningOverLockedFootprint(source, leaning.mesh).slice(0, 20)) describeFace(face);
  process.exit(1);
}
candidate = leaning.mesh;

const integrateOnce = () => integrateRetopologyCandidate(source, candidate, constraints, source.name, undefined, {
  preserveSurfacePaint: false,
  topologyAwareAlignment: false,
  enforceProtectedSide: false,
  collapseFlatInterfaceFaces: true,
  conformingSeams: true,
});

let integrated = integrateOnce();
for (let pass = 0; pass < 8; pass++) {
  const crossing = new Set([
    ...integrated.report.crossingInterfaceFaces,
    ...integrated.report.overlappingProtectedFaces,
  ]);
  console.log(`pass ${pass}: crossing faces ${integrated.report.crossingInterfaceFaces.length} `
    + `(+${integrated.report.overlappingProtectedFaces.length} overlap), edges ${integrated.report.crossingInterfaceEdges}, `
    + `wedges ${integrated.report.interfaceWedgeSplits.length}, `
    + `interface ${JSON.stringify(integrated.report.interfaceLoops)}, `
    + `snap ${integrated.report.maximumBoundarySnapM.toFixed(2)} m`);
  for (const face of [...crossing].slice(0, 8)) describeFace(face);
  if (!crossing.size) { console.log('GREEN: no crossings remain'); break; }
  const marginM = Math.min(12.5, .5 * 2 ** pass);
  const nudged = nudgeCrossingVerticesOffLockedFootprint(source, candidate, crossing, marginM);
  console.log(`  nudge(margin ${marginM}): moved ${nudged.nudgedVertices}, max ${nudged.maximumNudgeM.toFixed(2)} m, `
    + `unresolved ${nudged.unresolvedVertices}`);
  if (!nudged.nudgedVertices) { console.log('STUCK: nothing nudged'); break; }
  candidate = nudged.mesh;
  integrated = integrateOnce();
}
console.log(`final: interface ${JSON.stringify(integrated.report.interfaceLoops)} `
  + `snap ${integrated.report.maximumBoundarySnapM.toFixed(2)} m, `
  + `inverted ${integrated.report.invertedCandidatePatches}, `
  + `embedded T ${integrated.report.embeddedTJunctions}`);

const protectedPatches = integrated.report.protectedPatches;
const penetration = generatedProtectedFootprintPenetration(integrated.document, protectedPatches, 8);
console.log(`footprint gate (res 8): ${penetration.overlappingTriangles.length} triangle(s), `
  + `${penetration.penetratingCentroids} centroid(s), depth ${penetration.maximumCentroidDepthM.toFixed(3)} m -> `
  + `${penetration.maximumCentroidDepthM > 25 * .01 ? 'FAIL' : 'pass'} (conforming limit ${(25 * .01).toFixed(2)} m)`);
if (penetration.overlappingTriangles.length) {
  const generatedMesh = tessellateQuads(integrated.document,
    new Set(Array.from({ length: integrated.document.quads.length - protectedPatches },
      (_unused, patch) => patch + protectedPatches)), 4);
  const triangles = generatedMesh.faces.filter(face => face.length === 3);
  for (const id of penetration.overlappingTriangles) {
    const triangle = triangles[id];
    const centroid = triangle.reduce<[number, number]>((sum, vertex) => [
      sum[0] + generatedMesh.vertices[vertex][0] / 3,
      sum[1] + generatedMesh.vertices[vertex][2] / 3,
    ], [0, 0]);
    console.log(`  overlap tri at (${centroid[0].toFixed(1)}, ${centroid[1].toFixed(1)}), `
      + `corner ${nearestCorner(centroid[0], centroid[1]).toFixed(2)}m`);
  }
}
