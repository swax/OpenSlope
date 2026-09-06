/** Offline diagnostic for the direct conforming join: replays cut -> conform -> refine ->
 * integrate on a saved hole-mode candidate job directory and reports rim structure per stage.
 * Usage: npx tsx tools/retopology/join-probe.ts <job-dir> <mountain.slope.json> [--skip-cut]
 * [--skip-refine] [--conforming]. Writes an XZ SVG of any crossing faces to $TEMP. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { migrateMountain } from '../../src/core/doc/mountain';
import { prepareRetopologyBenchmark } from '../../src/core/mesh/retopology/benchmark';
import {
  conformCandidateOuterBoundary, cutCandidateByLockedFootprint, integrateRetopologyCandidate,
  refineCoarseCandidateInterface,
} from '../../src/core/mesh/retopology/integrate';
import { readObj, type PolygonMesh } from '../../src/core/mesh/retopology/obj';
import { boundaryLoops } from '../../src/core/mesh/retopology/prescribe';

const jobDir = process.argv[2];
const sourceFile = process.argv[3];
if (!jobDir || !sourceFile) {
  console.error('Usage: npx tsx tools/retopology/join-probe.ts <job-dir> <mountain.slope.json>');
  process.exit(2);
}

const loopSummary = (mesh: PolygonMesh): string =>
  boundaryLoops(mesh).map(loop => loop.length).sort((a, b) => a - b).join(', ');

const source = migrateMountain(JSON.parse(readFileSync(sourceFile, 'utf8')));
const quadName = readdirSync(jobDir).find(name => /_quadrangulation_smooth\.obj$/.test(name));
if (!quadName) throw new Error('no smooth quadrangulation in job dir');
let candidate = readObj(readFileSync(`${jobDir}/${quadName}`, 'utf8'));
console.log(`candidate ${quadName}: ${candidate.vertices.length} verts, rims [${loopSummary(candidate)}]`);

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

if (!process.argv.includes('--skip-cut')) {
  candidate = cutCandidateByLockedFootprint(source, candidate, 1, 0).mesh;
  console.log(`after cut(res 1): ${candidate.vertices.length} verts, rims [${loopSummary(candidate)}]`);
}

const rim = conformCandidateOuterBoundary(source, candidate);
candidate = rim.mesh;
console.log(`after conformOuter: moved ${rim.movedVertices} (max ${rim.maximumMoveM.toFixed(2)} m), rims [${loopSummary(candidate)}]`);

let refinement;
if (!process.argv.includes('--skip-refine')) {
  refinement = refineCoarseCandidateInterface(source, candidate, constraints) ?? undefined;
  if (refinement) candidate = refinement.mesh;
  console.log(`after refine: ${refinement ? `${refinement.tJunctions.length} T-junctions, ` : 'null, '}rims [${loopSummary(candidate)}]`);
}

const integrated = integrateRetopologyCandidate(source, candidate, constraints, source.name, refinement, {
  preserveSurfacePaint: false,
  topologyAwareAlignment: false,
  enforceProtectedSide: false,
  collapseFlatInterfaceFaces: true,
  conformingSeams: process.argv.includes('--conforming'),
});
const report = integrated.report;
console.log(`integrated: crossing faces ${report.crossingInterfaceFaces.length}, ` +
  `wedge splits ${report.interfaceWedgeSplits.length}, collapsed ${report.collapsedInterfaceFaces.length}, ` +
  `interface source/candidate edges ${report.sourceInterfaceEdges}/${report.candidateInterfaceEdges}`);
console.log(`report keys: ${Object.keys(report).join(', ')}`);
console.log(`max boundary snap: ${(report as { maximumBoundarySnapM?: number }).maximumBoundarySnapM?.toFixed(2) ?? '?'} m`);
if (report.crossingInterfaceFaces.length) {
  // crossing indices refer to candidate faces; report centroids and their span between the
  // protected rims to see whether the crossings cluster at the hairpin neck
  const hole = boundaryLoops(candidate).reduce((a, b) => (b.length < a.length ? b : a));
  const holePositions = hole.map(vertex => candidate.vertices[vertex]);
  for (const face of report.crossingInterfaceFaces.slice(0, 20)) {
    const quad = candidate.faces[face];
    const centroid = quad.reduce<[number, number, number]>((sum, vertex) => {
      const point = candidate.vertices[vertex];
      return [sum[0] + point[0] / quad.length, sum[1] + point[1] / quad.length, sum[2] + point[2] / quad.length];
    }, [0, 0, 0]);
    let nearest = Infinity;
    for (const point of holePositions) {
      nearest = Math.min(nearest, Math.hypot(point[0] - centroid[0], point[2] - centroid[2]));
    }
    console.log(`  crossing face ${face} at (${centroid.map(value => value.toFixed(0)).join(', ')}), ${nearest.toFixed(1)} m from trail rim`);
  }

  // XZ SVG: protected outline chords (red), candidate rim (blue), crossing faces (orange)
  const corners = prepared.constraints.interface.map(curve => curve.samples[0]);
  const xs = [...corners, ...holePositions].map(point => point[0]);
  const zs = [...corners, ...holePositions].map(point => point[2]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs) - 30, Math.max(...xs) + 30, Math.min(...zs) - 30, Math.max(...zs) + 30];
  const sx = (x: number) => ((x - minX) / (maxX - minX)) * 1200;
  const sz = (z: number) => ((z - minZ) / (maxZ - minZ)) * 1200;
  const path = (points: [number, number][], close: boolean) =>
    `M ${points.map(([x, z]) => `${sx(x).toFixed(1)} ${sz(z).toFixed(1)}`).join(' L ')}${close ? ' Z' : ''}`;
  const svg: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 1200">`];
  svg.push(`<path d="${path(corners.map(point => [point[0], point[2]]), true)}" fill="none" stroke="red" stroke-width="1.5"/>`);
  svg.push(`<path d="${path(holePositions.map(point => [point[0], point[2]]), true)}" fill="none" stroke="blue" stroke-width="1"/>`);
  for (const point of corners) svg.push(`<circle cx="${sx(point[0]).toFixed(1)}" cy="${sz(point[2]).toFixed(1)}" r="3" fill="red"/>`);
  for (const vertex of hole) {
    const point = candidate.vertices[vertex];
    svg.push(`<circle cx="${sx(point[0]).toFixed(1)}" cy="${sz(point[2]).toFixed(1)}" r="2" fill="blue"/>`);
  }
  for (const face of report.crossingInterfaceFaces) {
    const points = candidate.faces[face].map(vertex => [candidate.vertices[vertex][0], candidate.vertices[vertex][2]] as [number, number]);
    svg.push(`<path d="${path(points, true)}" fill="orange" fill-opacity="0.5" stroke="darkorange"/>`);
  }
  svg.push('</svg>');
  const out = `${process.env.TEMP ?? '.'}/join-probe.svg`;
  writeFileSync(out, svg.join('\n'));
  console.log(`wrote ${out}`);
}
