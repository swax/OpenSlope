/**
 * Study a `slopesmith-mesh-selection` copied from a reference trail centre seam.
 *
 * The copied graph gives exact boundary cubics but deliberately carries only the selected edges. This tool
 * resolves them back onto the level's complete reference QuadMesh, recovers the two incident trail patches and
 * their perpendicular station edges, and measures the construction law we need for a spline loft generator.
 *
 * Usage:
 *   npx tsx tools/mountain-study/trail-selection.ts ../ResearchData/trails/centerlines/mesa-centerline.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { V3 } from '../../src/core/doc/types';
import { cubicPoint } from '../../src/core/math/bezier';
import { add, len, sub } from '../../src/core/math/vec';
import { buildReferenceMesh, type RawPatch } from '../../src/core/reference/terrain';
import { meshAdjacency } from '../../src/core/mesh/topology';
import { MAPS_DIR, REPO_ROOT, evidencePath, tempFile } from './paths';

interface SelectionEdge {
  vertices: [number, number];
  bezier: [V3, V3, V3, V3] | null;
}
interface SelectionFile {
  format: string;
  version: number;
  source: 'authored' | 'reference';
  referenceLevel?: string;
  referenceOffset?: V3;
  selection: { vertices: V3[]; edges: SelectionEdge[]; patches: number[][] };
}
interface PatchRecord extends RawPatch { PatchName?: string; UVPoints?: number[][]; }

const inputPath = resolve(process.argv[2] ?? join(REPO_ROOT, 'ResearchData', 'trails', 'centerlines', 'mesa-centerline.json'));
const copied = JSON.parse(readFileSync(inputPath, 'utf8')) as SelectionFile;
if (copied.format !== 'slopesmith-mesh-selection' || copied.source !== 'reference')
  throw new Error(`${basename(inputPath)} is not a copied reference mesh selection`);
const level = copied.referenceLevel;
if (!level) throw new Error('selection does not name its referenceLevel');
const offset = copied.referenceOffset ?? [0, 0, 0];
const raw = JSON.parse(readFileSync(join(MAPS_DIR, level, 'Patches.json'), 'utf8')) as { Patches: PatchRecord[] };
const patches = raw.Patches.filter(p => p.Points?.length >= 16);

console.log(`building ${level} reference topology (${patches.length} patches)...`);
const reference = buildReferenceMesh(patches, undefined, 1);
const adjacency = meshAdjacency(reference.mesh);
const point = (vertex: number): V3 => {
  const i = vertex * 3;
  return [reference.mesh.vertices[i], reference.mesh.vertices[i + 1], reference.mesh.vertices[i + 2]];
};
const native = (p: V3): V3 => [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]];
const key = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
const pkey = (p: V3) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
const vertexByPoint = new Map<string, number>();
for (let i = 0; i < reference.mesh.vertexCount; i++) vertexByPoint.set(pkey(point(i)), i);

const nativeVertices = copied.selection.vertices.map(native);
const matchErrors: number[] = [];
const meshVertices = nativeVertices.map((p, copiedIndex) => {
  let found = vertexByPoint.get(pkey(p));
  if (found === undefined) {
    let best = -1, bestDistance = Infinity;
    for (let i = 0; i < reference.mesh.vertexCount; i++) {
      const d = len(sub(point(i), p));
      if (d < bestDistance) { best = i; bestDistance = d; }
    }
    if (bestDistance > 0.03) throw new Error(`selection vertex ${copiedIndex} misses the reference mesh by ${bestDistance.toFixed(3)}m`);
    found = best;
  }
  matchErrors.push(len(sub(point(found), p)));
  return found;
});

const cubicLength = (cp: readonly V3[], samples = 32): number => {
  let total = 0, previous = cp[0];
  for (let i = 1; i <= samples; i++) {
    const here = cubicPoint(cp[0], cp[1], cp[2], cp[3], i / samples);
    total += len(sub(here, previous)); previous = here;
  }
  return total;
};
const planLength = (cp: readonly V3[], samples = 32): number => {
  let total = 0, previous = cp[0];
  for (let i = 1; i <= samples; i++) {
    const here = cubicPoint(cp[0], cp[1], cp[2], cp[3], i / samples);
    total += Math.hypot(here[0] - previous[0], here[2] - previous[2]); previous = here;
  }
  return total;
};
const edgeCubic = (from: number, to: number): [V3, V3, V3, V3] => {
  const a = point(from), b = point(to);
  return [a, add(a, reference.edgeHandle(from, to)), add(b, reference.edgeHandle(to, from)), b];
};
const planAngle = (a: V3, b: V3): number => {
  const al = Math.hypot(a[0], a[2]), bl = Math.hypot(b[0], b[2]);
  if (al < 1e-9 || bl < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[2] * b[2]) / (al * bl))));
};
const degrees = (radians: number) => radians * 180 / Math.PI;
const q = (values: readonly number[], at: number): number => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * at)))];
};
const distribution = (values: readonly number[]) => ({
  n: values.length, p10: q(values, .1), p25: q(values, .25), median: q(values, .5), p75: q(values, .75), p90: q(values, .9),
});

type ResolvedEdge = SelectionEdge & {
  index: number; mesh: [number, number]; cp: [V3, V3, V3, V3]; length: number; planLength: number;
};
const resolvedEdges: ResolvedEdge[] = copied.selection.edges.map((edge, index) => {
  const a = meshVertices[edge.vertices[0]], b = meshVertices[edge.vertices[1]];
  const cp = edge.bezier ? edge.bezier.map(native) as [V3, V3, V3, V3] : edgeCubic(a, b);
  return { ...edge, index, mesh: [a, b], cp, length: cubicLength(cp), planLength: planLength(cp) };
});
const edgeByLocalKey = new Map(resolvedEdges.map(edge => [key(...edge.vertices), edge]));

// The copied centre seam is a graph, not necessarily one run. Preserve its junctions instead of silently
// flattening them into a path: maximal chains stop at every degree != 2 vertex.
const graph = Array.from({ length: nativeVertices.length }, () => [] as number[]);
for (const edge of resolvedEdges) {
  const [a, b] = edge.vertices; graph[a].push(b); graph[b].push(a);
}
const components: number[][] = [];
const seenVertices = new Set<number>();
for (let seed = 0; seed < graph.length; seed++) {
  if (!graph[seed].length || seenVertices.has(seed)) continue;
  const component: number[] = [], queue = [seed]; seenVertices.add(seed);
  while (queue.length) {
    const here = queue.pop()!; component.push(here);
    for (const next of graph[here]) if (!seenVertices.has(next)) { seenVertices.add(next); queue.push(next); }
  }
  components.push(component);
}
const maximalChains: number[][] = [];
const walkedEdges = new Set<string>();
for (const start of graph.flatMap((neighbors, vertex) => neighbors.length !== 2 ? [vertex] : [])) {
  for (const first of graph[start]) {
    if (walkedEdges.has(key(start, first))) continue;
    const chain = [start]; let previous = start, current = first;
    walkedEdges.add(key(previous, current)); chain.push(current);
    while (graph[current].length === 2) {
      const next = graph[current][0] === previous ? graph[current][1] : graph[current][0];
      if (walkedEdges.has(key(current, next))) break;
      walkedEdges.add(key(current, next)); chain.push(next); previous = current; current = next;
    }
    maximalChains.push(chain);
  }
}

// Curvature at regular centre vertices, using the exact outgoing cubic tangents and half of each incident
// edge's arc as the support length. Straight is two opposite outgoing rays (angle pi), not angle zero.
const vertexCurvature = new Map<number, number>();
for (let vertex = 0; vertex < graph.length; vertex++) {
  if (graph[vertex].length !== 2) continue;
  const rays: V3[] = [], lengths: number[] = [];
  for (const neighbor of graph[vertex]) {
    const edge = edgeByLocalKey.get(key(vertex, neighbor))!;
    const atStart = edge.vertices[0] === vertex;
    rays.push(atStart ? sub(edge.cp[1], edge.cp[0]) : sub(edge.cp[2], edge.cp[3]));
    lengths.push(edge.planLength);
  }
  const deflection = Math.max(0, Math.PI - planAngle(rays[0], rays[1]));
  vertexCurvature.set(vertex, deflection / Math.max(1e-6, (lengths[0] + lengths[1]) / 2));
}
const edgeCurvature = (edge: ResolvedEdge): number => {
  const ownTurn = planAngle(sub(edge.cp[1], edge.cp[0]), sub(edge.cp[3], edge.cp[2])) / Math.max(1e-6, edge.planLength);
  const ends = edge.vertices.flatMap(vertex => vertexCurvature.has(vertex) ? [vertexCurvature.get(vertex)!] : []);
  return ends.length ? (ownTurn + ends.reduce((a, b) => a + b, 0) / ends.length) / 2 : ownTurn;
};
const edgeSignedCurvature = (edge: ResolvedEdge): number => {
  const a = sub(edge.cp[1], edge.cp[0]), b = sub(edge.cp[3], edge.cp[2]);
  const turn = Math.atan2(a[0] * b[2] - a[2] * b[0], a[0] * b[0] + a[2] * b[2]);
  return turn / Math.max(1e-6, edge.planLength);
};

const incidentFaceHistogram = new Map<number, number>();
const trackPatches = new Set<number>();
const patchCentreEdges = new Map<number, ResolvedEdge[]>();
for (const edge of resolvedEdges) {
  const faces = adjacency.edgeQuads.get(key(...edge.mesh)) ?? [];
  incidentFaceHistogram.set(faces.length, (incidentFaceHistogram.get(faces.length) ?? 0) + 1);
  for (const face of faces) {
    trackPatches.add(face);
    const list = patchCentreEdges.get(face) ?? []; list.push(edge); patchCentreEdges.set(face, list);
  }
}

const quadEdges = (quad: readonly number[]): [number, number][] => {
  const [A, B, C, D] = quad;
  return [[A, B], [B, D], [D, C], [C, A]];
};
const otherAt = (quad: readonly number[], endpoint: number, along: number): number | null => {
  for (const [a, b] of quadEdges(quad)) {
    if (a === endpoint && b !== along) return b;
    if (b === endpoint && a !== along) return a;
  }
  return null;
};
const isAlongU = (quad: readonly number[], a: number, b: number): boolean => {
  const [A, B, C, D] = quad;
  return key(a, b) === key(A, C) || key(a, b) === key(B, D);
};

const stationMap = new Map<string, {
  center: number; outers: [number, number]; width: number; laneWidths: [number, number]; bank: number;
  dish: number; perpendicularError: number;
}>();
const longitudinalTangentErrors: number[] = [];
for (const edge of resolvedEdges) {
  const faces = adjacency.edgeQuads.get(key(...edge.mesh)) ?? [];
  if (faces.length !== 2) continue;
  for (let endpointSlot = 0; endpointSlot < 2; endpointSlot++) {
    const center = edge.mesh[endpointSlot], along = edge.mesh[1 - endpointSlot];
    const outers = faces.flatMap(face => otherAt(reference.mesh.quads[face], center, along) ?? []);
    const unique = [...new Set(outers)];
    if (unique.length !== 2 || unique[0] === unique[1]) continue;
    const stationKey = `${center}|${[...unique].sort((a, b) => a - b).join(',')}`;
    const c = point(center), o0 = point(unique[0]), o1 = point(unique[1]);
    const laneWidths = unique.map(outer => cubicLength(edgeCubic(center, outer))) as [number, number];
    const width = laneWidths[0] + laneWidths[1];
    const dx = o1[0] - o0[0], dz = o1[2] - o0[2], planWidth = Math.hypot(dx, dz);
    const t = planWidth > 1e-9 ? Math.max(0, Math.min(1, ((c[0] - o0[0]) * dx + (c[2] - o0[2]) * dz) / (planWidth * planWidth))) : .5;
    const chordY = o0[1] + (o1[1] - o0[1]) * t;
    const tangent = endpointSlot === 0 ? sub(edge.cp[1], edge.cp[0]) : sub(edge.cp[3], edge.cp[2]);
    const cross = sub(o1, o0);
    const angle = degrees(planAngle(tangent, cross));
    stationMap.set(stationKey, {
      center, outers: [unique[0], unique[1]], width, laneWidths,
      bank: degrees(Math.atan2(o1[1] - o0[1], Math.max(1e-9, planWidth))),
      dish: c[1] - chordY,
      perpendicularError: Math.abs(90 - angle),
    });
  }

  // A loft copies the centre-seam tangent law onto each outside rail. Measure how parallel those exact stored
  // cubics stay at both stations; this catches diagonal/skew patches that a corner-only width study would miss.
  for (const face of faces) {
    const quad = reference.mesh.quads[face];
    const oa = otherAt(quad, edge.mesh[0], edge.mesh[1]), ob = otherAt(quad, edge.mesh[1], edge.mesh[0]);
    if (oa === null || ob === null) continue;
    const outer = edgeCubic(oa, ob);
    longitudinalTangentErrors.push(degrees(planAngle(sub(edge.cp[1], edge.cp[0]), sub(outer[1], outer[0]))));
    longitudinalTangentErrors.push(degrees(planAngle(sub(edge.cp[3], edge.cp[2]), sub(outer[3], outer[2]))));
  }
}
const stations = [...stationMap.values()];

const radiusBands = [
  { label: '<40m', min: 0, max: 40 },
  { label: '40-80m', min: 40, max: 80 },
  { label: '80-160m', min: 80, max: 160 },
  { label: '160-320m', min: 160, max: 320 },
  { label: '>=320m', min: 320, max: Infinity },
] as const;
const edgeByRadius = radiusBands.map(band => {
  const edges = resolvedEdges.filter(edge => {
    const curvature = edgeCurvature(edge), radius = curvature > 1e-7 ? 1 / curvature : Infinity;
    return radius >= band.min && radius < band.max;
  });
  return { band: band.label, edges: edges.length, spacing: distribution(edges.map(edge => edge.length)) };
});
const localByMesh = new Map(meshVertices.map((mesh, local) => [mesh, local] as const));
const curvatureAtLocal = (local: number | undefined): number => {
  if (local === undefined || !graph[local]?.length) return 0;
  const incident = graph[local].map(next => edgeCurvature(edgeByLocalKey.get(key(local, next))!));
  return incident.reduce((sum, value) => sum + value, 0) / incident.length;
};
const stationByRadius = radiusBands.map(band => {
  const matches = stations.filter(station => {
    const curvature = curvatureAtLocal(localByMesh.get(station.center));
    const radius = curvature > 1e-7 ? 1 / curvature : Infinity;
    return radius >= band.min && (band.max === Infinity || radius < band.max);
  });
  return {
    band: band.label, stations: matches.length,
    width: distribution(matches.map(station => station.width)),
    bank: distribution(matches.map(station => Math.abs(station.bank))),
    dishFraction: distribution(matches.map(station => station.dish / station.width)),
  };
});
const pearson = (pairs: readonly [number, number][]): number => {
  if (pairs.length < 2) return NaN;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let xy = 0, xx = 0, yy = 0;
  for (const [x, y] of pairs) { const dx = x - mx, dy = y - my; xy += dx * dy; xx += dx * dx; yy += dy * dy; }
  return xy / Math.sqrt(Math.max(1e-20, xx * yy));
};
const curvatureBankPairs = stations.flatMap(station => {
  const curvature = curvatureAtLocal(localByMesh.get(station.center));
  return curvature > 1e-6 ? [[curvature, Math.abs(station.bank)] as [number, number]] : [];
});

const twistOffsets: number[] = [], normalizedTwistOffsets: number[] = [];
const flowHandleRatios: number[] = [], crossHandleRatios: number[] = [];
const axisHistogram = { alongU: 0, acrossV: 0 };
const textureStats = new Map<string, { patches: Set<number>; lengths: number[]; radii: number[]; surfaces: Map<number, number> }>();
const uvPatterns = new Map<string, number>();
for (const face of trackPatches) {
  const exact = reference.patchControls[face] as V3[];
  // Per-patch Ferguson/zero-twist prediction from THIS patch's own boundary controls. Using the de-duplicated
  // shared edge provider here would fold tolerated seam disagreement into the interior-twist residual.
  const zeroInterior: V3[] = [
    sub(add(exact[4], exact[1]), exact[0]),
    sub(add(exact[2], exact[7]), exact[3]),
    sub(add(exact[8], exact[13]), exact[12]),
    sub(add(exact[11], exact[14]), exact[15]),
  ];
  const patchScale = Math.max(1e-6, ...quadEdges(reference.mesh.quads[face]).map(([a, b]) => len(sub(point(b), point(a)))));
  for (let i = 0; i < 4; i++) {
    const residual = len(sub(exact[[5, 6, 9, 10][i]], zeroInterior[i]));
    twistOffsets.push(residual); normalizedTwistOffsets.push(residual / patchScale);
  }

  const quad = reference.mesh.quads[face];
  const boundaryControls: [V3, V3, V3, V3][] = [
    [exact[0], exact[1], exact[2], exact[3]],
    [exact[3], exact[7], exact[11], exact[15]],
    [exact[15], exact[14], exact[13], exact[12]],
    [exact[12], exact[8], exact[4], exact[0]],
  ];
  const centers = patchCentreEdges.get(face) ?? [];
  const boundary = quadEdges(quad);
  for (let boundaryIndex = 0; boundaryIndex < boundary.length; boundaryIndex++) {
    const [a, b] = boundary[boundaryIndex], cp = boundaryControls[boundaryIndex];
    const chord = len(sub(cp[3], cp[0]));
    if (chord < 1e-6) continue;
    const isCenter = centers.some(center => key(...center.mesh) === key(a, b));
    const isOpposite = centers.some(center => !center.mesh.includes(a) && !center.mesh.includes(b));
    const target = isCenter || isOpposite ? flowHandleRatios : crossHandleRatios;
    target.push(len(sub(cp[1], cp[0])) / chord, len(sub(cp[2], cp[3])) / chord);
  }

  for (const centerEdge of centers) {
    if (isAlongU(quad, ...centerEdge.mesh)) axisHistogram.alongU++; else axisHistogram.acrossV++;
    const texture = reference.patchTex[face] ?? '(none)';
    const entry = textureStats.get(texture) ?? {
      patches: new Set<number>(), lengths: [] as number[], radii: [] as number[], surfaces: new Map<number, number>(),
    };
    entry.patches.add(face); entry.lengths.push(centerEdge.length);
    const curvature = edgeCurvature(centerEdge);
    entry.radii.push(curvature > 1e-7 ? 1 / curvature : Infinity);
    entry.surfaces.set(reference.patchSurf[face], (entry.surfaces.get(reference.patchSurf[face]) ?? 0) + 1);
    textureStats.set(texture, entry);
  }
  const uv = patches[face].UVPoints ?? [];
  const uvKey = JSON.stringify(uv.map(pair => pair.map(value => Math.round(value * 10000) / 10000)));
  uvPatterns.set(uvKey, (uvPatterns.get(uvKey) ?? 0) + 1);
}

const textureReport = [...textureStats].map(([texture, entry]) => ({
  texture,
  patches: entry.patches.size,
  segmentLength: distribution(entry.lengths),
  turnRadius: distribution(entry.radii.filter(Number.isFinite)),
  straight: entry.radii.filter(radius => !Number.isFinite(radius) || radius > 500).length,
  surfaces: Object.fromEntries([...entry.surfaces].sort((a, b) => a[0] - b[0])),
})).sort((a, b) => b.patches - a.patches);
const texturePairs = new Map<string, { edges: number; lengths: number[]; radii: number[]; signedCurvature: number[]; surfaces: string[] }>();
for (const edge of resolvedEdges) {
  const faces = adjacency.edgeQuads.get(key(...edge.mesh)) ?? [];
  if (faces.length !== 2) continue;
  const textures = faces.map(face => reference.patchTex[face] ?? '(none)').sort();
  const pairKey = textures.join(' + ');
  const entry = texturePairs.get(pairKey) ?? { edges: 0, lengths: [], radii: [], signedCurvature: [], surfaces: [] };
  entry.edges++; entry.lengths.push(edge.length);
  const curvature = edgeCurvature(edge); entry.radii.push(curvature > 1e-7 ? 1 / curvature : Infinity);
  entry.signedCurvature.push(edgeSignedCurvature(edge));
  entry.surfaces.push(faces.map(face => reference.patchSurf[face]).sort((a, b) => a - b).join('+'));
  texturePairs.set(pairKey, entry);
}
const texturePairReport = [...texturePairs].map(([pair, entry]) => ({
  pair, edges: entry.edges, spacing: distribution(entry.lengths),
  turnRadius: distribution(entry.radii.filter(Number.isFinite)),
  turnDirection: {
    negative: entry.signedCurvature.filter(value => value < -1e-5).length,
    straight: entry.signedCurvature.filter(value => Math.abs(value) <= 1e-5).length,
    positive: entry.signedCurvature.filter(value => value > 1e-5).length,
  },
  surfacePairs: Object.fromEntries([...new Set(entry.surfaces)].map(surface => [surface, entry.surfaces.filter(candidate => candidate === surface).length])),
})).sort((a, b) => b.edges - a.edges);

const degreeHistogram = new Map<number, number>();
for (const neighbors of graph) if (neighbors.length) degreeHistogram.set(neighbors.length, (degreeHistogram.get(neighbors.length) ?? 0) + 1);
const junctions = graph.flatMap((neighbors, localVertex) => neighbors.length > 2 ? [{
  localVertex,
  meshVertex: meshVertices[localVertex],
  position: nativeVertices[localVertex],
  selectedDegree: neighbors.length,
  meshValence: adjacency.neighbors[meshVertices[localVertex]].length,
  outgoingLengths: neighbors.map(next => edgeByLocalKey.get(key(localVertex, next))!.length),
  incidentPatches: [...new Set(neighbors.flatMap(next => adjacency.edgeQuads.get(key(meshVertices[localVertex], meshVertices[next])) ?? []))],
}] : []);

const chainReport = maximalChains.map((vertices, index) => {
  const edges = Array.from({ length: vertices.length - 1 }, (_, i) => edgeByLocalKey.get(key(vertices[i], vertices[i + 1]))!);
  const start = nativeVertices[vertices[0]], end = nativeVertices[vertices[vertices.length - 1]];
  return { index, vertices: vertices.length, edges: edges.length, length: edges.reduce((sum, edge) => sum + edge.length, 0), drop: start[1] - end[1] };
}).sort((a, b) => b.length - a.length);
const cyclomaticNumber = resolvedEdges.length - nativeVertices.length + components.length;

const report = {
  input: evidencePath(inputPath),
  referenceLevel: level,
  referenceOffset: offset,
  source: {
    vertices: nativeVertices.length,
    edges: resolvedEdges.length,
    matchError: distribution(matchErrors),
    degreeHistogram: Object.fromEntries([...degreeHistogram].sort((a, b) => a[0] - b[0])),
    components: components.length,
    cycles: cyclomaticNumber,
    maximalChains: chainReport,
    junctions,
  },
  topology: {
    incidentFacesPerSelectedEdge: Object.fromEntries([...incidentFaceHistogram].sort((a, b) => a[0] - b[0])),
    uniqueTrailPatches: trackPatches.size,
    patchAxis: axisHistogram,
  },
  spacing: {
    centerEdgeArcLength: distribution(resolvedEdges.map(edge => edge.length)),
    centerEdgePlanLength: distribution(resolvedEdges.map(edge => edge.planLength)),
    handleToChordFlow: distribution(flowHandleRatios),
    handleToChordCross: distribution(crossHandleRatios),
    byTurnRadius: edgeByRadius,
  },
  crossSection: {
    stations: stations.length,
    totalWidth: distribution(stations.map(station => station.width)),
    laneWidth: distribution(stations.flatMap(station => station.laneWidths)),
    dishMeters: distribution(stations.map(station => station.dish)),
    dishFractionOfWidth: distribution(stations.map(station => station.dish / station.width)),
    absoluteBankDegrees: distribution(stations.map(station => Math.abs(station.bank))),
    byTurnRadius: stationByRadius,
    curvatureVsAbsoluteBankPearson: pearson(curvatureBankPairs),
  },
  alignment: {
    crossEdgePerpendicularErrorDegrees: distribution(stations.map(station => station.perpendicularError)),
    centerVsOuterTangentErrorDegrees: distribution(longitudinalTangentErrors),
  },
  subCage: {
    interiorTwistMeters: distribution(twistOffsets),
    interiorTwistFractionOfPatch: distribution(normalizedTwistOffsets),
    zeroWithin1cm: twistOffsets.filter(value => value <= .01).length / Math.max(1, twistOffsets.length),
    zeroWithin5cm: twistOffsets.filter(value => value <= .05).length / Math.max(1, twistOffsets.length),
  },
  uvPatterns: [...uvPatterns].map(([pattern, count]) => ({ count, pattern })).sort((a, b) => b.count - a.count),
  textures: textureReport,
  texturePairs: texturePairReport,
};

const output = tempFile(`${level.toLowerCase()}-trail-study.json`);
writeFileSync(output, JSON.stringify(report, null, 2));

const show = (label: string, d: ReturnType<typeof distribution>, digits = 1) =>
  console.log(`${label}: n=${d.n}  p10=${d.p10.toFixed(digits)}  median=${d.median.toFixed(digits)}  p90=${d.p90.toFixed(digits)}`);
console.log('\n=== COPIED CENTRE GRAPH ===');
console.log(`${nativeVertices.length} vertices · ${resolvedEdges.length} edges · ${components.length} components · ${junctions.length} degree-3 junctions · ${cyclomaticNumber} split/rejoin cycle(s)`);
console.log(`degree ${[...degreeHistogram].map(([degree, count]) => `${degree}:${count}`).join('  ')} · maximal chains ${maximalChains.length}`);
console.log(`edge incident-patch count ${[...incidentFaceHistogram].map(([faces, count]) => `${faces}:${count}`).join('  ')}`);
show('station spacing / centre cubic (m)', report.spacing.centerEdgeArcLength);
console.log('spacing by turn radius:', edgeByRadius.map(row => `${row.band} n=${row.edges} med=${row.spacing.median.toFixed(1)}m`).join(' · '));
console.log('\n=== TWO-LANE CROSS-SECTIONS ===');
show('full width (m)', report.crossSection.totalWidth);
show('one lane (m)', report.crossSection.laneWidth);
show('centre below rim chord (m)', report.crossSection.dishMeters, 2);
show('dish / width', report.crossSection.dishFractionOfWidth, 3);
show('|bank| (deg)', report.crossSection.absoluteBankDegrees);
console.log('cross-section by turn radius:', stationByRadius.map(row => `${row.band} n=${row.stations} width=${row.width.median.toFixed(1)}m bank=${row.bank.median.toFixed(1)}°`).join(' · '));
console.log(`curvature ↔ |bank| Pearson r=${report.crossSection.curvatureVsAbsoluteBankPearson.toFixed(3)}`);
show('cross-edge perpendicular error (deg)', report.alignment.crossEdgePerpendicularErrorDegrees);
show('centre-vs-rim tangent error (deg)', report.alignment.centerVsOuterTangentErrorDegrees);
console.log('\n=== PATCH / SUB-CAGE LAW ===');
console.log(`trail-aligned parameterization: u=${axisHistogram.alongU}, v=${axisHistogram.acrossV}`);
show('flow handle / chord', report.spacing.handleToChordFlow, 3);
show('cross handle / chord', report.spacing.handleToChordCross, 3);
show('interior zero-twist residual (m)', report.subCage.interiorTwistMeters, 3);
show('interior residual / patch size', report.subCage.interiorTwistFractionOfPatch, 4);
console.log(`zero twist within 1cm ${(report.subCage.zeroWithin1cm * 100).toFixed(1)}% · within 5cm ${(report.subCage.zeroWithin5cm * 100).toFixed(1)}%`);
console.log('\n=== TEXTURES ON THE SELECTED TRAIL PATCHES ===');
for (const texture of textureReport)
  console.log(`${texture.texture.padEnd(12)} patches=${String(texture.patches).padStart(3)}  len~${texture.segmentLength.median.toFixed(1)}m  turnR~${Number.isFinite(texture.turnRadius.median) ? texture.turnRadius.median.toFixed(0) : '-'}m  surfaces=${JSON.stringify(texture.surfaces)}`);
console.log('\ntexture pairs across the centre seam:');
for (const pair of texturePairReport)
  console.log(`${pair.pair.padEnd(25)} edges=${String(pair.edges).padStart(3)}  len~${pair.spacing.median.toFixed(1)}m  turnR~${Number.isFinite(pair.turnRadius.median) ? pair.turnRadius.median.toFixed(0) : '-'}m  turn -/0/+=${pair.turnDirection.negative}/${pair.turnDirection.straight}/${pair.turnDirection.positive}`);
console.log(`\nfull report -> ${output}`);
