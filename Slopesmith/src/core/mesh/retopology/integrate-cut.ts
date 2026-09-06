/** The locked-footprint cut stage: classify and remove candidate faces over the protected feature, repair
 * the resulting boundary back to simple cycles, and split exceptional all-interface quads into wedges. */
import type { QuadMeshDoc, V3 } from '../../doc/types';
import { deriveQuadMesh } from '../../doc/mountain';
import {
  polygonsIntersectProjectedTriangles, type ProjectedPolygon, type ProjectedTriangle,
} from '../projected-overlap';
import { undirectedEdgeKey } from '../primitives';
import { protectedQuadSet, tessellateQuads } from './benchmark';
import { triangulateFaces, type PolygonMesh } from './obj';
import { edgeCycles, polygonBoundary } from './integrate-boundary';

export interface LockedFootprintCut {
  mesh: PolygonMesh;
  removedFaces: number;
  protectedRegions: number;
  boundaryLoops: number[];
  bufferRings: number;
  cappedTriangularHoles: number;
}

export interface CandidateBoundaryTrim {
  mesh: PolygonMesh;
  requestedFaces: number;
  removedFaces: number;
  boundaryLoops: number[];
}

/** Expand a local candidate-hole cut until its boundary is again a union of simple degree-2 cycles. Crossing
 * edges can be shared by two diagonally arranged first-row faces; deleting both directly creates a bow-tie
 * vertex. This monotone repair removes the smallest adjacent fan needed to close that notch and never restores
 * an offending face. */
export function removeCandidateFacesAndRepairBoundary(
  candidate: PolygonMesh,
  requestedFaces: ReadonlySet<number>,
): CandidateBoundaryTrim {
  const originalBoundary = polygonBoundary(candidate);
  const baselineLoops = edgeCycles(originalBoundary, 'candidate boundary').length;
  const removed = new Set([...requestedFaces].filter(face => Number.isInteger(face)
    && face >= 0 && face < candidate.faces.length));
  if (!removed.size) return {
    mesh: candidate, requestedFaces: 0, removedFaces: 0,
    boundaryLoops: edgeCycles(polygonBoundary(candidate), 'candidate boundary').map(loop => loop.length).sort((a, b) => a - b),
  };
  const vertexFaces = Array.from({ length: candidate.vertices.length }, () => [] as number[]);
  const edgeFaces = new Map<string, number[]>();
  candidate.faces.forEach((face, faceIndex) => {
    for (const vertex of new Set(face)) vertexFaces[vertex].push(faceIndex);
    face.forEach((vertex, corner) => {
      const key = undirectedEdgeKey(vertex, face[(corner + 1) % face.length]);
      const found = edgeFaces.get(key);
      if (found) found.push(faceIndex); else edgeFaces.set(key, [faceIndex]);
    });
  });
  const neighbors = candidate.faces.map(() => new Set<number>());
  for (const faces of edgeFaces.values()) if (faces.length === 2) {
    neighbors[faces[0]].add(faces[1]); neighbors[faces[1]].add(faces[0]);
  }
  const originalBoundaryFaces = new Set<number>();
  for (const [a, b] of originalBoundary) for (const face of edgeFaces.get(undirectedEdgeKey(a, b)) ?? []) {
    originalBoundaryFaces.add(face);
  }
  /** A requested set wholly inside the kept surface creates a second hole instead of extending the feature
   * hole. Join each such component to the nearest pre-existing boundary through the face dual. This is the
   * topological equivalent of growing the cut, and avoids guessing left/right from world axes. */
  const connectRemovedComponentsToBoundary = (): number => {
    const pending = new Set(removed);
    let added = 0;
    while (pending.size) {
      const seed = pending.values().next().value as number, component = new Set([seed]), queue = [seed];
      pending.delete(seed);
      while (queue.length) {
        const face = queue.shift()!;
        for (const next of neighbors[face]) if (removed.has(next) && !component.has(next)) {
          component.add(next); pending.delete(next); queue.push(next);
        }
      }
      if ([...component].some(face => originalBoundaryFaces.has(face))) continue;
      const frontier = [...component], previous = new Map<number, number>();
      const visited = new Set(component);
      let target: number | undefined;
      while (frontier.length && target === undefined) {
        const face = frontier.shift()!;
        for (const next of neighbors[face]) {
          if (visited.has(next)) continue;
          visited.add(next); previous.set(next, face);
          if (originalBoundaryFaces.has(next)) { target = next; break; }
          frontier.push(next);
        }
      }
      if (target === undefined) throw new Error('Could not connect local seam repair to a candidate boundary');
      for (let face = target; !component.has(face); face = previous.get(face)!) {
        if (!removed.has(face)) { removed.add(face); added++; }
      }
    }
    return added;
  };
  const boundaryTopology = (mask: ReadonlySet<number>) => {
    const occurrences = new Map<string, [number, number]>();
    candidate.faces.forEach((face, faceIndex) => {
      if (mask.has(faceIndex)) return;
      face.forEach((vertex, corner) => {
        const edge: [number, number] = [vertex, face[(corner + 1) % face.length]], key = undirectedEdgeKey(...edge);
        if (occurrences.has(key)) occurrences.delete(key); else occurrences.set(key, edge);
      });
    });
    const degree = new Map<number, number>();
    for (const [a, b] of occurrences.values()) {
      degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const invalid = [...degree].filter(([, value]) => value !== 2);
    const penalty = invalid.reduce((sum, [, value]) => sum + Math.abs(value - 2), 0);
    return { edges: [...occurrences.values()], invalid, penalty };
  };
  const removeDetachedKeptComponents = (): number => {
    const pending = new Set(candidate.faces.map((_face, face) => face).filter(face => !removed.has(face)));
    const components: number[][] = [];
    while (pending.size) {
      const seed = pending.values().next().value as number, component = [seed], queue = [seed];
      pending.delete(seed);
      while (queue.length) {
        const face = queue.shift()!;
        for (const next of neighbors[face]) if (!removed.has(next) && pending.delete(next)) {
          component.push(next); queue.push(next);
        }
      }
      components.push(component);
    }
    components.sort((a, b) => b.length - a.length);
    let added = 0;
    for (const component of components.slice(1)) for (const face of component) {
      removed.add(face); added++;
    }
    return added;
  };
  let repairedLoops: number[][] | undefined;
  for (let pass = 0; pass < 8; pass++) {
    let changed = connectRemovedComponentsToBoundary();
    for (let iteration = 0; iteration < 256; iteration++) {
      const current = boundaryTopology(removed);
      if (!current.invalid.length) break;
      const [vertex] = current.invalid[0];
      let winner: { face: number; penalty: number } | undefined;
      for (const face of vertexFaces[vertex]) {
        if (removed.has(face)) continue;
        removed.add(face); const trial = boundaryTopology(removed); removed.delete(face);
        if (!winner || trial.penalty < winner.penalty) winner = { face, penalty: trial.penalty };
      }
      if (!winner) throw new Error(`Could not close candidate boundary fan at vertex ${vertex}`);
      removed.add(winner.face); changed++;
    }
    const topology = boundaryTopology(removed);
    if (topology.invalid.length) throw new Error(
      `Candidate boundary repair left ${topology.invalid.length} non-manifold vertex/vertices`,
    );
    const detached = removeDetachedKeptComponents();
    if (detached) continue;
    repairedLoops = edgeCycles(topology.edges, 'repaired candidate boundary');
    if (repairedLoops.length === baselineLoops) break;
    // Another loop means a later fan repair made an interior removal island. The next pass joins it to the
    // original boundary. Fewer loops means the repair consumed a protected boundary component and is unsafe.
    if (repairedLoops.length < baselineLoops || !changed) break;
  }
  const repaired = boundaryTopology(removed);
  if (repaired.invalid.length) throw new Error(
    `Candidate boundary repair left ${repaired.invalid.length} non-manifold vertex/vertices`,
  );
  const keptFaces = candidate.faces.filter((_face, face) => !removed.has(face));
  const used = new Set(keptFaces.flat()), oldToNew = new Map<number, number>(), vertices: V3[] = [];
  for (const old of [...used].sort((a, b) => a - b)) {
    oldToNew.set(old, vertices.length); vertices.push([...candidate.vertices[old]] as V3);
  }
  const mesh: PolygonMesh = { vertices, faces: keptFaces.map(face => face.map(vertex => oldToNew.get(vertex)!)) };
  const loops = edgeCycles(polygonBoundary(mesh), 'repaired candidate boundary');
  if (loops.length !== baselineLoops) throw new Error(
    `Local seam repair changed candidate boundary loop count from ${baselineLoops} to ${loops.length}`,
  );
  return {
    mesh, requestedFaces: requestedFaces.size, removedFaces: removed.size,
    boundaryLoops: loops.map(loop => loop.length).sort((a, b) => a - b),
  };
}

/** Split exceptional all-interface bow-tie quads into two manifold triangular wedges. Wedges retain the
 * four-index SlopeSmith/OBJ contract by collapsing one private edge; no neighbouring edge is subdivided and no
 * T-junction is introduced. */
export function splitCandidateFacesToWedges(
  candidate: PolygonMesh,
  facesToSplit: ReadonlyMap<number, 'ac' | 'bd'>,
): PolygonMesh {
  const faces: number[][] = [];
  candidate.faces.forEach((face, faceIndex) => {
    const diagonal = facesToSplit.get(faceIndex);
    if (!diagonal || face.length !== 4 || new Set(face).size !== 4) {
      faces.push([...face]); return;
    }
    const [a, b, c, d] = face;
    if (diagonal === 'ac') faces.push([a, b, c, c], [a, c, d, d]);
    else faces.push([b, c, d, d], [b, d, a, a]);
  });
  return { vertices: candidate.vertices.map(point => [...point] as V3), faces };
}

/** Cut an all-surface candidate at the exact locked-trail footprint. QuadWild receives that footprint as an
 * internal feature, so a useful result should already contain a coherent edge cycle there. This stage only
 * classifies and removes faces; the protected integrator later inserts the original bicubic trail. */
export function cutCandidateByLockedFootprint(
  source: QuadMeshDoc,
  candidate: PolygonMesh,
  resolution = 8,
  bufferRings = 0,
): LockedFootprintCut {
  const projectedFaces: ProjectedPolygon[] = candidate.faces.map((face, id) => ({
    id, points: face.map(vertex => [candidate.vertices[vertex][0], candidate.vertices[vertex][2]] as const),
  }));
  const edgeFaces = new Map<string, number[]>(), vertexFaces = Array.from({ length: candidate.vertices.length }, () => [] as number[]);
  candidate.faces.forEach((face, faceIndex) => {
    for (const vertex of face) vertexFaces[vertex].push(faceIndex);
    face.forEach((vertex, corner) => {
      const key = undirectedEdgeKey(vertex, face[(corner + 1) % face.length]), found = edgeFaces.get(key);
      if (found) found.push(faceIndex); else edgeFaces.set(key, [faceIndex]);
    });
  });
  const neighbors = candidate.faces.map(() => new Set<number>());
  for (const faces of edgeFaces.values()) if (faces.length === 2) {
    neighbors[faces[0]].add(faces[1]); neighbors[faces[1]].add(faces[0]);
  }
  const locked = protectedQuadSet(source, 0), sourceTopology = deriveQuadMesh(source).mesh.topology;
  const remainingLocked = new Set(locked), lockedRegions: Set<number>[] = [];
  while (remainingLocked.size) {
    const seed = remainingLocked.values().next().value as number, region = new Set<number>([seed]), queue = [seed];
    remainingLocked.delete(seed);
    while (queue.length) {
      const quad = queue.pop()!;
      for (const edge of sourceTopology.cellEdges[quad] ?? []) for (const neighbor of sourceTopology.edgeCells[edge] ?? []) {
        if (remainingLocked.delete(neighbor)) { region.add(neighbor); queue.push(neighbor); }
      }
    }
    lockedRegions.push(region);
  }
  if (!lockedRegions.length) throw new Error('Whole-surface candidate needs at least one locked footprint');

  // Positive-area polygon intersection catches a coarse candidate face that straddles a narrow or curved
  // protected feature even when its center lies outside. Boundary-only contact remains, so an already exact
  // candidate interface does not lose an extra ring. Keep the largest connected match for EACH disconnected
  // locked source region rather than silently keeping only the largest trail in the document.
  const removed = new Set<number>();
  for (const [regionIndex, region] of lockedRegions.entries()) {
    const footprint = tessellateQuads(source, region, Math.max(2, Math.floor(resolution)));
    const projected = triangulateFaces(footprint).map((triangle): ProjectedTriangle => {
      const point = (vertex: number): [number, number] => {
        const value = footprint.vertices[vertex];
        return [value[0], value[2]];
      };
      return [point(triangle[0]), point(triangle[1]), point(triangle[2])];
    });
    const matched = new Set(polygonsIntersectProjectedTriangles(projectedFaces, projected));
    const components: number[][] = [], unseen = new Set(matched);
    while (unseen.size) {
      const seed = unseen.values().next().value as number, component: number[] = [], queue = [seed];
      unseen.delete(seed);
      while (queue.length) {
        const face = queue.pop()!; component.push(face);
        for (const neighbor of neighbors[face]) if (unseen.delete(neighbor)) queue.push(neighbor);
      }
      components.push(component);
    }
    components.sort((a, b) => b.length - a.length);
    const component = components[0];
    if (!component?.length) throw new Error(`Whole-surface candidate has no faces inside locked footprint ${regionIndex + 1}`);
    for (const face of component) removed.add(face);
  }
  const rings = Math.max(0, Math.min(4, Math.floor(bufferRings)));
  for (let ring = 0; ring < rings; ring++) {
    const addFaces = new Set<number>();
    for (const face of removed) for (const neighbor of neighbors[face]) if (!removed.has(neighbor)) addFaces.add(neighbor);
    for (const face of addFaces) removed.add(face);
  }
  const outside = new Set<number>(), queue: number[] = [];
  candidate.faces.forEach((face, faceIndex) => {
    if (removed.has(faceIndex)) return;
    const atOuterBoundary = face.some((vertex, corner) =>
      edgeFaces.get(undirectedEdgeKey(vertex, face[(corner + 1) % face.length]))?.length === 1);
    if (atOuterBoundary) { outside.add(faceIndex); queue.push(faceIndex); }
  });
  while (queue.length) for (const neighbor of neighbors[queue.pop()!]) {
    if (!removed.has(neighbor) && !outside.has(neighbor)) { outside.add(neighbor); queue.push(neighbor); }
  }
  candidate.faces.forEach((_face, face) => { if (!removed.has(face) && !outside.has(face)) removed.add(face); });

  const cutBoundary = (mask: ReadonlySet<number>) => {
    const occurrences = new Map<string, [number, number]>();
    candidate.faces.forEach((face, faceIndex) => {
      if (mask.has(faceIndex)) return;
      face.forEach((vertex, corner) => {
        const edge: [number, number] = [vertex, face[(corner + 1) % face.length]], key = undirectedEdgeKey(...edge);
        if (occurrences.has(key)) occurrences.delete(key); else occurrences.set(key, edge);
      });
    });
    const degree = new Map<number, number>();
    for (const [a, b] of occurrences.values()) {
      degree.set(a, (degree.get(a) ?? 0) + 1); degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    const invalid = [...degree].filter(([, value]) => value !== 2);
    return { edges: [...occurrences.values()], invalid };
  };
  // A diagonal inside/outside pattern around one vertex makes a bow-tie cut. Toggle the least-cost incident face
  // whenever doing so strictly improves the global boundary-manifold score.
  const changed = new Set<number>();
  for (let iteration = 0; iteration < 128; iteration++) {
    const topology = cutBoundary(removed);
    if (!topology.invalid.length) break;
    const [vertex] = topology.invalid[0], currentScore = topology.invalid.length * 10000 + changed.size;
    let winner: { face: number; score: number } | undefined;
    for (const face of vertexFaces[vertex]) {
      if (removed.has(face)) removed.delete(face); else removed.add(face);
      const trial = cutBoundary(removed);
      const trialChanged = changed.has(face) ? changed.size - 1 : changed.size + 1;
      const score = trial.invalid.length * 10000 + trialChanged;
      if (score < currentScore && (!winner || score < winner.score)) winner = { face, score };
      if (removed.has(face)) removed.delete(face); else removed.add(face);
    }
    if (!winner) break;
    if (removed.has(winner.face)) removed.delete(winner.face); else removed.add(winner.face);
    if (!changed.delete(winner.face)) changed.add(winner.face);
  }
  const repairedBoundary = cutBoundary(removed);
  if (repairedBoundary.invalid.length) {
    throw new Error(`Locked-footprint cut has ${repairedBoundary.invalid.length} non-manifold boundary vertex/vertices after mask repair`);
  }
  const keptFaces = candidate.faces.filter((_face, face) => !removed.has(face));
  const used = new Set(keptFaces.flat()), oldToNew = new Map<number, number>(), vertices: V3[] = [];
  for (const old of [...used].sort((a, b) => a - b)) {
    oldToNew.set(old, vertices.length);
    vertices.push([...candidate.vertices[old]] as V3);
  }
  const mesh: PolygonMesh = { vertices, faces: keptFaces.map(face => face.map(vertex => oldToNew.get(vertex)!)) };
  const initialLoops = edgeCycles(polygonBoundary(mesh), 'locked-footprint cut');
  const pinholes = initialLoops.filter(loop => loop.length === 3);
  for (const [a, b, c] of pinholes) mesh.faces.push([a, c, b, b]);
  const loops = edgeCycles(polygonBoundary(mesh), 'locked-footprint capped cut').map(loop => loop.length).sort((a, b) => a - b);
  const expectedLoops = lockedRegions.length + 1;
  if (loops.length < expectedLoops) {
    throw new Error(`Locked-footprint cut produced ${loops.length} boundary loop(s), expected an outer rim and ${lockedRegions.length} locked hole(s)`);
  }
  return {
    mesh, removedFaces: removed.size, protectedRegions: lockedRegions.length, boundaryLoops: loops, bufferRings: rings,
    cappedTriangularHoles: pinholes.length,
  };
}
