import type { QuadMeshDoc, V3 } from '../../doc/types';
import { deriveQuadMesh } from '../../doc/mountain';
import { add, cross, dot, len, sub } from '../../math/vec';
import {
  pointStrictlyInProjectedPolygon, polygonsIntersectProjectedTriangles, projectedSegmentsProperlyCross,
  type ProjectedPolygon, type ProjectedTriangle,
} from '../projected-overlap';
import { directedEdgeKey, quadPerimeter, quadPerimeterEdges, readVertex, undirectedEdgeKey } from '../primitives';
import { checkManifold, finishMeshRewrite, type MeshRewrite } from '../ops/contract';
import { extraordinaryPoles, meshAdjacency, quadControlPoints } from '../topology';
import { tessellateQuads } from './benchmark';
import { triangulateFaces } from './obj';

export interface ConformRetopologyOptions {
  /** Number of unlocked exact-edge rings replaced outside the old T-node seam. */
  collarRings?: number;
  /** Bicubic samples per locked patch axis used to clear accidental top-down overlap. */
  footprintResolution?: number;
}

export interface ConformRetopologyReport {
  lockedRegions: number;
  removedPatches: number;
  rebuiltPatches: number;
  removedTJunctions: number;
  remainingTJunctions: number;
  wedges: number;
  extraordinaryPoles: number;
  invertedPatches: number;
  connectedComponents: number;
  maximumLockedControlDeviationM: number;
  maximumRetainedControlDeviationM: number;
  maximumAspectRatio: number;
}

export interface ConformedRetopology {
  document: QuadMeshDoc;
  report: ConformRetopologyReport;
}

type Edge = [number, number];

const distance2 = (a: V3, b: V3): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function edgeCycles(edges: readonly Edge[], label: string): number[][] {
  const adjacency = new Map<number, number[]>(), unused = new Set(edges.map(edge => undirectedEdgeKey(...edge)));
  const add = (a: number, b: number) => {
    const found = adjacency.get(a);
    if (found) found.push(b); else adjacency.set(a, [b]);
  };
  for (const [a, b] of edges) { add(a, b); add(b, a); }
  for (const [vertex, neighbors] of adjacency) if (neighbors.length !== 2)
    throw new Error(`${label} vertex ${vertex} has degree ${neighbors.length}, expected 2`);
  const loops: number[][] = [];
  while (unused.size) {
    const [start, first] = (unused.values().next().value as string).split(',').map(Number);
    const loop = [start];
    let previous = start, current = first;
    unused.delete(undirectedEdgeKey(previous, current));
    while (current !== start) {
      loop.push(current);
      const neighbors = adjacency.get(current)!;
      const next = neighbors[0] === previous ? neighbors[1] : neighbors[0];
      if (next === undefined || !unused.delete(undirectedEdgeKey(current, next)))
        throw new Error(`${label} does not form disjoint simple cycles`);
      previous = current; current = next;
    }
    loops.push(loop);
  }
  return loops;
}

function signedArea(loop: readonly number[], vertices: readonly number[]): number {
  let area = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = readVertex(vertices, loop[i]), b = readVertex(vertices, loop[(i + 1) % loop.length]);
    area += a[0] * b[2] - b[0] * a[2];
  }
  return area / 2;
}

function rotate<T>(items: readonly T[], offset: number): T[] {
  const at = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(at), ...items.slice(0, at)];
}

function orientPerimeter(perimeter: number[], vertices: readonly number[], sign: number): number[] {
  return Math.sign(signedArea(perimeter, vertices)) === Math.sign(sign) ? perimeter : [...perimeter].reverse();
}

function perimeterToCell(perimeter: readonly number[]): number[] {
  return perimeter.length === 3
    ? [perimeter[0], perimeter[1], perimeter[2], perimeter[2]]
    : [perimeter[0], perimeter[1], perimeter[3], perimeter[2]];
}

function perimeterQuality(perimeter: readonly number[], vertices: readonly number[]): { valid: boolean; aspect: number; score: number } {
  const points = perimeter.map(vertex => readVertex(vertices, vertex));
  const lengths = points.map((point, i) => len(sub(points[(i + 1) % points.length], point)));
  const shortest = Math.min(...lengths), longest = Math.max(...lengths);
  if (!(shortest > 1e-7)) return { valid: false, aspect: Infinity, score: Infinity };
  const cornerCrosses = points.map((point, i) => cross(
    sub(points[(i + 1) % points.length], point), sub(points[(i + points.length - 1) % points.length], point)));
  const normalSum = cornerCrosses.reduce((sum, value): V3 => add(sum, value), [0, 0, 0]);
  const normalLength = len(normalSum);
  if (!(normalLength > 1e-10)) return { valid: false, aspect: Infinity, score: Infinity };
  const minimumSine = Math.min(...points.map((point, i) => {
    const next = sub(points[(i + 1) % points.length], point);
    const previous = sub(points[(i + points.length - 1) % points.length], point);
    const denominator = len(next) * len(previous);
    return denominator > 1e-10 ? dot(cornerCrosses[i], normalSum) / (denominator * normalLength) : 0;
  }));
  if (!(minimumSine > 1e-5)) return { valid: false, aspect: Infinity, score: Infinity };
  const aspect = longest / shortest;
  // A fourth-power tail makes one needle more expensive than several mildly irregular transition quads.
  // That matches texture-per-patch terrain better than optimizing only average edge length.
  return { valid: true, aspect, score: aspect ** 4 + 8 * (1 - minimumSine) };
}

function perimeterStaysOutsideProtected(
  perimeter: readonly number[],
  innerEdges: ReadonlySet<string>,
  innerVertices: ReadonlySet<number>,
  polygon: readonly [number, number][],
  vertices: readonly number[],
): boolean {
  const projected = perimeter.map(vertex => {
    const point = readVertex(vertices, vertex);
    return [point[0], point[2]] as [number, number];
  });
  for (let corner = 0; corner < perimeter.length; corner++) {
    const vertex = perimeter[corner], next = perimeter[(corner + 1) % perimeter.length];
    if (!innerVertices.has(vertex) && pointStrictlyInProjectedPolygon(projected[corner], polygon, 1e-7)) return false;
    if (innerEdges.has(undirectedEdgeKey(vertex, next))) continue;
    if (polygon.some((point, edge) => projectedSegmentsProperlyCross(
      projected[corner], projected[(corner + 1) % perimeter.length],
      point, polygon[(edge + 1) % polygon.length], 1e-7))) return false;
  }
  const center = projected.reduce<[number, number]>((sum, point) =>
    [sum[0] + point[0] / projected.length, sum[1] + point[1] / projected.length], [0, 0]);
  return !pointStrictlyInProjectedPolygon(center, polygon, 1e-7);
}

interface BridgePath {
  score: number;
  previous: number;
  perimeter: number[];
  wedge: boolean;
}

/** Directly quadrangulate one unwrapped annulus. A (1,1) step makes the usual two-rail quad; (2,0) and
 * (0,2) steps absorb one boundary-count mismatch into an ordinary 3/5-pole transition. Wedges carry a very
 * large cost and therefore appear only when parity or local geometry makes an all-quad path impossible. */
function bridgeOffset(inner: readonly number[], outer: readonly number[], vertices: readonly number[],
  orientation: number, baseValence: readonly number[]): { cells: number[][]; score: number; wedges: number; maxAspect: number } | null {
  const rows = outer.length + 1, index = (i: number, j: number) => i * rows + j;
  const states: (BridgePath | undefined)[] = new Array((inner.length + 1) * rows);
  states[0] = { score: 0, previous: -1, perimeter: [], wedge: false };
  const moves = [
    { di: 1, dj: 1, wedge: false },
    { di: 2, dj: 0, wedge: false },
    { di: 0, dj: 2, wedge: false },
    { di: 1, dj: 0, wedge: true },
    { di: 0, dj: 1, wedge: true },
  ];
  const innerEdges = new Set(inner.map((vertex, index) => undirectedEdgeKey(vertex, inner[(index + 1) % inner.length])));
  const innerVertices = new Set(inner);
  const protectedPolygon = inner.map(vertex => {
    const point = readVertex(vertices, vertex);
    return [point[0], point[2]] as [number, number];
  });
  for (let i = 0; i <= inner.length; i++) for (let j = 0; j <= outer.length; j++) {
    const at = index(i, j), current = states[at];
    if (!current || (i === inner.length && j === outer.length)) continue;
    for (const move of moves) {
      if (i + move.di > inner.length || j + move.dj > outer.length || move.di + move.dj === 0) continue;
      let perimeter: number[];
      if (move.di === 1 && move.dj === 1) perimeter = [
        inner[i % inner.length], inner[(i + 1) % inner.length],
        outer[(j + 1) % outer.length], outer[j % outer.length],
      ];
      else if (move.di === 2) perimeter = [
        inner[i % inner.length], inner[(i + 1) % inner.length],
        inner[(i + 2) % inner.length], outer[j % outer.length],
      ];
      else if (move.dj === 2) perimeter = [
        inner[i % inner.length], outer[(j + 2) % outer.length],
        outer[(j + 1) % outer.length], outer[j % outer.length],
      ];
      else if (move.di === 1) perimeter = [
        inner[i % inner.length], inner[(i + 1) % inner.length], outer[j % outer.length],
      ];
      else perimeter = [
        inner[i % inner.length], outer[(j + 1) % outer.length], outer[j % outer.length],
      ];
      perimeter = orientPerimeter(perimeter, vertices, orientation);
      if (!perimeterStaysOutsideProtected(perimeter, innerEdges, innerVertices, protectedPolygon, vertices)) continue;
      const quality = perimeterQuality(perimeter, vertices);
      if (!quality.valid) continue;
      const next = index(i + move.di, j + move.dj);
      const crossStrip = distance2(readVertex(vertices, inner[(i + move.di) % inner.length]),
        readVertex(vertices, outer[(j + move.dj) % outer.length]));
      const score = current.score + quality.score + crossStrip * .0025 + (move.wedge ? 100000 : 0);
      if (!states[next] || score < states[next]!.score) states[next] = { score, previous: at, perimeter, wedge: move.wedge };
    }
  }
  const end = index(inner.length, outer.length);
  if (!states[end]) return null;
  const perimeters: number[][] = [];
  let wedges = 0, cursor = end;
  while (cursor !== 0) {
    const state = states[cursor]!;
    perimeters.push(state.perimeter); if (state.wedge) wedges++;
    cursor = state.previous;
  }
  perimeters.reverse();
  const incident = [...baseValence];
  for (const perimeter of perimeters) for (const vertex of new Set(perimeter)) incident[vertex]++;
  let score = states[end]!.score;
  for (const vertex of new Set(perimeters.flat())) {
    const departure = Math.abs(incident[vertex] - 4);
    score += departure === 0 ? 0 : departure === 1 ? 2 : 1000 * departure;
  }
  return {
    cells: perimeters.map(perimeterToCell), score, wedges,
    maxAspect: Math.max(...perimeters.map(perimeter => perimeterQuality(perimeter, vertices).aspect)),
  };
}

function bridgeLoops(innerInput: readonly number[], outerInput: readonly number[], vertices: readonly number[],
  orientation: number, baseValence: readonly number[]): { cells: number[][]; wedges: number; maxAspect: number } {
  const inner = signedArea(innerInput, vertices) < 0 ? [...innerInput].reverse() : [...innerInput];
  const outerDirection = signedArea(outerInput, vertices) < 0 ? [...outerInput].reverse() : [...outerInput];
  let best: { cells: number[][]; score: number; wedges: number; maxAspect: number } | null = null;
  const anchor = readVertex(vertices, inner[0]);
  const offsets = outerDirection.map((vertex, offset) => ({ offset, distance: distance2(anchor, readVertex(vertices, vertex)) }))
    .sort((a, b) => a.distance - b.distance).slice(0, Math.min(12, outerDirection.length)).map(value => value.offset);
  for (const offset of offsets) {
    const outer = rotate(outerDirection, offset), candidate = bridgeOffset(inner, outer, vertices, orientation, baseValence);
    if (candidate && (!best || candidate.score < best.score)) best = candidate;
  }
  if (!best) throw new Error(`Could not build a non-inverted quad collar between ${inner.length} protected and ${outerDirection.length} terrain boundary edges`);
  return best;
}

function connectedComponents(vertexCount: number, quads: readonly number[][]): number {
  const neighbors = Array.from({ length: vertexCount }, () => [] as number[]), used = new Set<number>();
  for (const quad of quads) for (const [a, b] of quadPerimeterEdges(quad)) if (a !== b) {
    neighbors[a].push(b); neighbors[b].push(a); used.add(a); used.add(b);
  }
  let count = 0;
  while (used.size) {
    count++;
    const seed = used.values().next().value as number, queue = [seed]; used.delete(seed);
    while (queue.length) for (const next of neighbors[queue.pop()!]) if (used.delete(next)) queue.push(next);
  }
  return count;
}

function controlDeviation(before: QuadMeshDoc, after: QuadMeshDoc, quadIds: ReadonlySet<string>): number {
  const oldAt = new Map(before.quadIds.map((id, index) => [id, index])), newAt = new Map(after.quadIds.map((id, index) => [id, index]));
  const oldDerived = deriveQuadMesh(before), newDerived = deriveQuadMesh(after);
  let maximum = 0;
  for (const id of quadIds) {
    const oldQuad = oldAt.get(id), newQuad = newAt.get(id);
    if (oldQuad === undefined || newQuad === undefined) continue;
    const a = quadControlPoints(oldDerived.mesh, oldDerived.edgeHandle, oldQuad, oldDerived.twistOf(oldQuad));
    const b = quadControlPoints(newDerived.mesh, newDerived.edgeHandle, newQuad, newDerived.twistOf(newQuad));
    for (let i = 0; i < 16; i++) maximum = Math.max(maximum, len(sub(a[i], b[i])));
  }
  return maximum;
}

/** Replace a legacy T-node interface with a local, ordinary quad complex. Locked patches and the terrain
 * outside the chosen collar retain their exact bicubic controls; only the seam collar is regenerated. */
export function conformRetopologySeams(source: QuadMeshDoc, options: ConformRetopologyOptions = {}): ConformedRetopology {
  const rings = Math.max(1, Math.min(3, Math.floor(options.collarRings ?? 1)));
  const locked = new Set(source.quads.map((_quad, index) => source.quadLocked?.[index] === true ? index : -1)
    .filter(index => index >= 0));
  if (!locked.size) throw new Error('Lock the trail or other feature whose seam should be made conforming first');
  if (!(source.tJunctions?.length)) throw new Error('This mountain has no recorded T-junction seam to conform');

  const edgeFaces = new Map<string, number[]>();
  const vertexFaces = Array.from({ length: source.vertices.length / 3 }, () => [] as number[]);
  source.quads.forEach((quad, face) => {
    for (const vertex of new Set(quad)) vertexFaces[vertex].push(face);
    for (const [a, b] of quadPerimeterEdges(quad)) {
      if (a === b) continue;
      const key = undirectedEdgeKey(a, b), found = edgeFaces.get(key);
      if (found) found.push(face); else edgeFaces.set(key, [face]);
    }
  });
  const decompose = (): Set<number>[] => {
    const remaining = new Set(locked), found: Set<number>[] = [];
    while (remaining.size) {
      const seed = remaining.values().next().value as number, region = new Set<number>([seed]), queue = [seed];
      remaining.delete(seed);
      while (queue.length) {
        const quad = queue.pop()!;
        for (const [a, b] of quadPerimeterEdges(source.quads[quad])) for (const neighbor of edgeFaces.get(undirectedEdgeKey(a, b)) ?? [])
          if (locked.has(neighbor) && remaining.delete(neighbor)) { region.add(neighbor); queue.push(neighbor); }
      }
      found.push(region);
    }
    return found;
  };
  const boundaryHostKeys = (region: ReadonlySet<number>): Set<string> => {
    const occurrences = new Map<string, number>();
    for (const quad of region) for (const [a, b] of quadPerimeterEdges(source.quads[quad])) {
      if (a === b) continue;
      const key = undirectedEdgeKey(a, b);
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
    }
    return new Set([...occurrences].filter(([, count]) => count === 1).map(([key]) => key));
  };
  // A transition-collar join records its T-nodes on the collar's OUTER edge, one generated ring outside the
  // locked feature itself. Conforming promises that ring stays exact anyway, so grow each locked region
  // through complete unlocked rings (bounded) until its boundary hosts the recorded seam, and conform around
  // the grown region. A region that never reaches a T-hosting boundary is left exactly as it was.
  const tHostKeys = new Set((source.tJunctions ?? []).map(node => undirectedEdgeKey(...node.edge)));
  for (const region of decompose()) {
    if ([...boundaryHostKeys(region)].some(key => tHostKeys.has(key))) continue;
    const grown = new Set(region), added: number[] = [];
    for (let growth = 0; growth < 3; growth++) {
      const ring = new Set<number>();
      for (const quad of grown) for (const [a, b] of quadPerimeterEdges(source.quads[quad])) {
        if (a === b) continue;
        for (const neighbor of edgeFaces.get(undirectedEdgeKey(a, b)) ?? []) {
          if (!grown.has(neighbor) && !locked.has(neighbor)) ring.add(neighbor);
        }
      }
      if (!ring.size) break;
      for (const face of ring) { grown.add(face); added.push(face); }
      if ([...boundaryHostKeys(grown)].some(key => tHostKeys.has(key))) break;
    }
    if ([...boundaryHostKeys(grown)].some(key => tHostKeys.has(key))) for (const face of added) locked.add(face);
  }

  const unlockedNeighbors = source.quads.map(() => new Set<number>());
  for (const faces of edgeFaces.values()) if (faces.length === 2 && !locked.has(faces[0]) && !locked.has(faces[1])) {
    unlockedNeighbors[faces[0]].add(faces[1]); unlockedNeighbors[faces[1]].add(faces[0]);
  }

  const regions = decompose();

  const conformRegions: Set<number>[] = [], removals: Set<number>[] = [], innerLoops: number[][] = [], outerLoops: number[][] = [];
  const processedHosts = new Set<string>();
  for (const [regionIndex, region] of regions.entries()) {
    const occurrences = new Map<string, { edge: Edge; count: number }>();
    for (const quad of region) for (const [a, b] of quadPerimeterEdges(source.quads[quad])) {
      if (a === b) continue;
      const key = undirectedEdgeKey(a, b), found = occurrences.get(key);
      if (found) found.count++; else occurrences.set(key, { edge: [a, b], count: 1 });
    }
    const boundary = [...occurrences.entries()].filter(([, value]) => value.count === 1);
    const loops = edgeCycles(boundary.map(([, value]) => value.edge), `locked region ${regionIndex + 1} boundary`);
    if (loops.length !== 1) throw new Error(`Locked region ${regionIndex + 1} has ${loops.length} boundary loops; conform one simply-connected feature at a time`);
    const hosts = new Set(boundary.map(([key]) => key));
    if (!(source.tJunctions ?? []).some(node => hosts.has(undirectedEdgeKey(...node.edge)))) continue;
    conformRegions.push(region); innerLoops.push(loops[0]);
    for (const host of hosts) processedHosts.add(host);
    const chainByHost = new Map<string, Set<number>>();
    for (const [key, value] of boundary) chainByHost.set(key, new Set(value.edge));
    for (const node of source.tJunctions ?? []) chainByHost.get(undirectedEdgeKey(...node.edge))?.add(node.vertex);

    const seedFaces = new Set<number>();
    for (const [host, chain] of chainByHost) {
      for (const face of edgeFaces.get(host) ?? []) if (!locked.has(face)) seedFaces.add(face);
      for (const face of source.quads.keys()) {
        if (locked.has(face)) continue;
        const perimeter = quadPerimeter(source.quads[face]);
        // Remove the complete unlocked one-ring at every seam node/corner. Leaving a face that only touches
        // the protected loop at a corner makes the outer collar loop reuse that inner vertex, so any bridge
        // would necessarily create a three-face edge or a pinched annulus.
        if (perimeter.some(vertex => chain.has(vertex))) seedFaces.add(face);
      }
    }

    // Also clear an old generated patch that crossed over the protected surface without receiving T metadata.
    const footprint = tessellateQuads(source, region, Math.max(2, Math.floor(options.footprintResolution ?? 5)));
    const footprintTriangles: ProjectedTriangle[] = triangulateFaces(footprint).map(triangle => triangle.map(vertex => {
      const point = footprint.vertices[vertex]; return [point[0], point[2]] as const;
    }) as unknown as ProjectedTriangle);
    const projectedUnlocked: ProjectedPolygon[] = source.quads.flatMap((quad, id) => locked.has(id) ? [] : [{
      id, points: quadPerimeter(quad).map(vertex => {
        const point = readVertex(source.vertices, vertex); return [point[0], point[2]] as const;
      }),
    }]);
    for (const face of polygonsIntersectProjectedTriangles(projectedUnlocked, footprintTriangles)) seedFaces.add(face);
    if (!seedFaces.size) throw new Error(`Locked region ${regionIndex + 1} has T records but no removable terrain collar`);

    const removed = new Set(seedFaces);
    for (let ring = 1; ring < rings; ring++) {
      const next = new Set<number>();
      for (const face of removed) for (const neighbor of unlockedNeighbors[face]) if (!removed.has(neighbor)) next.add(neighbor);
      for (const face of next) removed.add(face);
    }
    const outerTopology = (mask: ReadonlySet<number>) => {
      const edges: Edge[] = [];
      for (const [key, incident] of edgeFaces) {
        if (incident.length !== 2) continue;
        const removedFaces = incident.filter(face => mask.has(face));
        const retainedFaces = incident.filter(face => !locked.has(face) && !mask.has(face));
        if (removedFaces.length === 1 && retainedFaces.length === 1) {
          const [a, b] = key.split(',').map(Number); edges.push([a, b]);
        }
      }
      const degree = new Map<number, number>();
      for (const [a, b] of edges) {
        degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
      }
      return { edges, invalid: [...degree].filter(([, value]) => value !== 2) };
    };
    // A projected mask can make a diagonal in/out pattern at one cage vertex. Move the local cut by the
    // smallest number of unlocked faces until its OUTER boundary is a disjoint set of ordinary cycles. T-side
    // seed faces remain mandatory, so repairing the mask can never expose the old non-conforming seam again.
    const changed = new Set<number>();
    for (let iteration = 0; iteration < 256; iteration++) {
      const current = outerTopology(removed);
      if (!current.invalid.length) break;
      const [vertex] = current.invalid[0], currentScore = current.invalid.length * 10000 + changed.size;
      let winner: { face: number; score: number } | undefined;
      for (const face of vertexFaces[vertex]) {
        if (locked.has(face) || (removed.has(face) && seedFaces.has(face))) continue;
        if (removed.has(face)) removed.delete(face); else removed.add(face);
        const trial = outerTopology(removed), trialChanged = changed.has(face) ? changed.size - 1 : changed.size + 1;
        const score = trial.invalid.length * 10000 + trialChanged;
        if (score < currentScore && (!winner || score < winner.score)) winner = { face, score };
        if (removed.has(face)) removed.delete(face); else removed.add(face);
      }
      if (!winner) {
        // A reach-across seam can require moving both diagonal sectors before the boundary degree improves;
        // no single toggle is then a strict descent. Expand the removable collar monotonically around the
        // offending vertex and let the next iteration reassess the complete fan.
        const expansion = vertexFaces[vertex].filter(face => !locked.has(face) && !removed.has(face));
        if (!expansion.length) break;
        for (const face of expansion) { removed.add(face); changed.add(face); }
        continue;
      }
      if (removed.has(winner.face)) removed.delete(winner.face); else removed.add(winner.face);
      if (!changed.delete(winner.face)) changed.add(winner.face);
    }
    removals.push(removed);
    const repaired = outerTopology(removed);
    if (repaired.invalid.length) throw new Error(`Terrain collar ${regionIndex + 1} has ${repaired.invalid.length} non-manifold outer-boundary vertices`);
    const outerEdges = repaired.edges;
    const outer = edgeCycles(outerEdges, `terrain collar ${regionIndex + 1} outer boundary`);
    if (outer.length !== 1) throw new Error(`Terrain collar ${regionIndex + 1} produced ${outer.length} outer loops; reduce collar rings or separate nearby locks`);
    outerLoops.push(outer[0]);
  }

  if (!conformRegions.length) throw new Error('Recorded T-junctions are not hosted by a locked feature boundary');

  for (let a = 0; a < removals.length; a++) for (let b = a + 1; b < removals.length; b++)
    if ([...removals[a]].some(face => removals[b].has(face)))
      throw new Error('Two locked regions share the same terrain collar; conform them separately or use fewer collar rings');
  const removed = new Set(removals.flatMap(region => [...region]));
  const retained = new Set(source.quads.map((_quad, index) => removed.has(index) ? -1 : index).filter(index => index >= 0));
  const retainedEdges = new Set([...retained].flatMap(face => quadPerimeterEdges(source.quads[face])
    .map(edge => undirectedEdgeKey(...edge))));
  const changedBoundaryVertices = new Set([...innerLoops.flat(), ...outerLoops.flat()]);
  const original = deriveQuadMesh(source);
  const edgeHandles = { ...(source.edgeHandles ?? {}) };
  // Pin every retained edge handle whose automatic Bessel neighborhood changes at the rebuilt seam. That
  // makes "outside the collar is exact" a measured guarantee rather than only a corner-position promise.
  for (const face of retained) for (const [a, b] of quadPerimeterEdges(source.quads[face])) {
    if (!changedBoundaryVertices.has(a) && !changedBoundaryVertices.has(b)) continue;
    edgeHandles[directedEdgeKey(a, b)] = [...original.edgeHandle(a, b)] as V3;
    edgeHandles[directedEdgeKey(b, a)] = [...original.edgeHandle(b, a)] as V3;
  }

  const quads: (number[] | null)[] = source.quads.map((quad, index) => removed.has(index) ? null : [...quad]);
  const quadIds: (string | null)[] = source.quadIds.map((id, index) => removed.has(index) ? null : id);
  const quadPaint = source.quadPaint ? { ...source.quadPaint } : undefined;
  const quadTex = source.quadTex ? { ...source.quadTex } : undefined;
  const quadOrient = source.quadOrient ? Object.fromEntries(Object.entries(source.quadOrient).map(([key, value]) => [key, { ...value }])) : undefined;
  const quadLocked = source.quadLocked ? { ...source.quadLocked } : undefined;
  const quadTwist = source.quadTwist ? Object.fromEntries(Object.entries(source.quadTwist).map(([key, value]) =>
    [key, value.map(point => [...point] as V3) as [V3, V3, V3, V3]])) : undefined;
  const baseValence = new Array<number>(source.vertices.length / 3).fill(0);
  for (const face of retained) for (const vertex of new Set(source.quads[face])) baseValence[vertex]++;
  const orientation = Math.sign(source.quads.reduce((sum, quad) => sum + signedArea(quadPerimeter(quad), source.vertices), 0)) || 1;
  let wedges = 0, maximumAspectRatio = 0;
  for (let region = 0; region < conformRegions.length; region++) {
    const bridge = bridgeLoops(innerLoops[region], outerLoops[region], source.vertices, orientation, baseValence);
    wedges += bridge.wedges; maximumAspectRatio = Math.max(maximumAspectRatio, bridge.maxAspect);
    const sourceFaces = [...removals[region]];
    for (const cell of bridge.cells) {
      const at = quads.length, center = cell.reduce((sum, vertex) => {
        const point = readVertex(source.vertices, vertex);
        return [sum[0] + point[0] / cell.length, sum[1] + point[1] / cell.length, sum[2] + point[2] / cell.length] as V3;
      }, [0, 0, 0] as V3);
      let nearest = sourceFaces[0], nearestDistance = Infinity;
      for (const face of sourceFaces) {
        const point = source.quads[face].reduce((sum, vertex) => {
          const value = readVertex(source.vertices, vertex);
          return [sum[0] + value[0] / 4, sum[1] + value[1] / 4, sum[2] + value[2] / 4] as V3;
        }, [0, 0, 0] as V3);
        const distance = distance2(center, point);
        if (distance < nearestDistance) { nearest = face; nearestDistance = distance; }
      }
      quads.push(cell); quadIds.push(null);
      for (const [a, b] of quadPerimeterEdges(cell)) {
        if (a === b || retainedEdges.has(undirectedEdgeKey(a, b))) continue;
        const p0 = readVertex(source.vertices, a), p3 = readVertex(source.vertices, b), delta = sub(p3, p0);
        edgeHandles[directedEdgeKey(a, b)] = delta.map(value => value / 3) as V3;
        edgeHandles[directedEdgeKey(b, a)] = delta.map(value => -value / 3) as V3;
      }
      if (quadPaint && source.quadPaint?.[nearest] !== undefined) quadPaint[at] = source.quadPaint[nearest];
      if (quadTex && source.quadTex?.[nearest] !== undefined) quadTex[at] = source.quadTex[nearest];
      if (quadOrient && source.quadOrient?.[nearest]) quadOrient[at] = { ...source.quadOrient[nearest] };
    }
  }
  const liveQuads = quads.filter((quad): quad is number[] => !!quad);
  const manifold = checkManifold(liveQuads);
  if (!manifold.ok) throw new Error(manifold.error);
  const tJunctions = (source.tJunctions ?? []).filter(node => !processedHosts.has(undirectedEdgeKey(...node.edge)));
  const raw: MeshRewrite = {
    vertices: [...source.vertices], quads, vertexIds: [...source.vertexIds], quadIds,
    nextId: source.nextId, freeEdges: source.freeEdges?.map(edge => [...edge] as Edge), tJunctions, edgeHandles,
    quadPaint, quadTex, quadOrient, quadLocked, quadTwist,
  };
  const document = finishMeshRewrite(source, raw).doc;
  const adjacency = meshAdjacency(deriveQuadMesh(document).mesh);
  const lockedIds = new Set([...locked].map(face => source.quadIds[face]));
  const retainedIds = new Set([...retained].filter(face => !locked.has(face)).map(face => source.quadIds[face]));
  const sourceQuadIds = new Set(source.quadIds);
  const invertedPatches = document.quads.filter((quad, index) => !sourceQuadIds.has(document.quadIds[index])
    && !perimeterQuality([...new Set(quadPerimeter(quad))], document.vertices).valid).length;
  const components = connectedComponents(document.vertices.length / 3, document.quads);
  const lockedDeviation = controlDeviation(source, document, lockedIds);
  const retainedDeviation = controlDeviation(source, document, retainedIds);
  if (components !== 1) throw new Error(`Conforming seam produced ${components} disconnected surface components`);
  if (invertedPatches) throw new Error(`Conforming seam produced ${invertedPatches} inverted or degenerate patches`);
  if (lockedDeviation > 1e-7) throw new Error(`Conforming seam moved locked controls by ${lockedDeviation.toFixed(6)} m`);
  if (retainedDeviation > 1e-7) throw new Error(`Conforming seam moved retained controls by ${retainedDeviation.toFixed(6)} m`);
  return {
    document,
    report: {
      lockedRegions: conformRegions.length,
      removedPatches: removed.size,
      rebuiltPatches: document.quads.length - retained.size,
      removedTJunctions: (source.tJunctions?.length ?? 0) - (document.tJunctions?.length ?? 0),
      remainingTJunctions: document.tJunctions?.length ?? 0,
      wedges,
      extraordinaryPoles: extraordinaryPoles(adjacency).size,
      invertedPatches,
      connectedComponents: components,
      maximumLockedControlDeviationM: lockedDeviation,
      maximumRetainedControlDeviationM: retainedDeviation,
      maximumAspectRatio,
    },
  };
}
