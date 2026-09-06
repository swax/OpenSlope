/** The leaning/seam nudge repair: slide candidate vertices sideways off the locked footprint instead of
 * deleting the faces that lean over it, preserving the prescribed rim's one-to-one interface. */
import type { QuadMeshDoc, V3 } from '../../doc/types';
import {
  pointStrictlyInProjectedPolygon, polygonsIntersectProjectedTriangles,
  projectedSegmentsProperlyCross, type ProjectedPolygon, type ProjectedTriangle,
} from '../projected-overlap';
import { protectedQuadSet, tessellateQuads } from './benchmark';
import { triangulateFaces, type PolygonMesh } from './obj';
import { edgeCycles, polygonBoundary } from './integrate-boundary';

export interface CrossingVertexNudge {
  mesh: PolygonMesh;
  nudgedVertices: number;
  maximumNudgeM: number;
  /** Offending vertices that could not be pushed clear within the marching budget. */
  unresolvedVertices: number;
}

/** Prescribed rim vertices land within the worst authored-corner projection of their protected corner
 * (observed up to ~1.4 m); positions inside this gate are treated as being ON the corner. */
const INTERFACE_RESIDUAL_GATE_M = 2;

function snapToNearestOutlineCorner(
  point: [number, number],
  loops: readonly (readonly [number, number][])[],
): [number, number] {
  let best = point, bestDistance = Infinity;
  for (const loop of loops) for (const corner of loop) {
    const distance = Math.hypot(point[0] - corner[0], point[1] - corner[1]);
    if (distance < bestDistance) { bestDistance = distance; best = corner; }
  }
  return bestDistance <= INTERFACE_RESIDUAL_GATE_M ? best : point;
}

/** Move the interior vertices of footprint-crossing first-row faces sideways off the locked feature instead
 * of deleting the faces. A conforming direct join has no transition collar: deleting a first-row face merges
 * the feature hole into the prescribed rim and destroys the one-to-one interface, so the only local repair
 * that preserves rim topology is sliding the offending vertex in top view. Each vertex is marched along the
 * outward outline normal at its nearest interface anchor until it clears both the chordal outline (the
 * conforming crossing screen) and the sampled bicubic outline (the strict footprint gate) by marginM and
 * none of its flagged edges properly cross; the surface-height fit re-seats the vertex on the terrain. */
export function nudgeCrossingVerticesOffLockedFootprint(
  source: QuadMeshDoc,
  candidate: PolygonMesh,
  crossingFaces: Iterable<number>,
  marginM: number,
): CrossingVertexNudge {
  const locked = protectedQuadSet(source, 0);
  if (!locked.size) throw new Error('Crossing-vertex nudge needs a locked footprint');
  const outlineLoops = (resolution: number): [number, number][][] => {
    const footprint = tessellateQuads(source, locked, resolution);
    return edgeCycles(polygonBoundary({ vertices: footprint.vertices, faces: footprint.faces }),
      `locked footprint outline (resolution ${resolution})`)
      .map(loop => loop.map(vertex => {
        const point = footprint.vertices[vertex];
        return [point[0], point[2]] as [number, number];
      }));
  };
  const chordal = outlineLoops(1), sampled = outlineLoops(4);
  // Even-odd parity across all outline loops keeps annular or holed footprints correct.
  const inside = (loops: [number, number][][], point: [number, number]): boolean =>
    loops.reduce((parity, loop) => pointStrictlyInProjectedPolygon(point, loop, 1e-7) ? !parity : parity, false);
  const nearestOnLoops = (loops: [number, number][][], point: [number, number]) => {
    let best = { distance: Infinity, point, normal: [0, 0] as [number, number] };
    for (const loop of loops) for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const dx = b[0] - a[0], dy = b[1] - a[1], denominator = dx * dx + dy * dy;
      if (denominator < 1e-20) continue;
      const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / denominator));
      const x = a[0] + dx * t, y = a[1] + dy * t, distance = Math.hypot(point[0] - x, point[1] - y);
      if (distance < best.distance) {
        const length = Math.sqrt(denominator);
        best = { distance, point: [x, y], normal: [dy / length, -dx / length] };
      }
    }
    return best;
  };
  // The sampled outline matters too: the bicubic outline bulges outward past the chord near corners, and
  // a straight first-row side edge that clips such a bulge fails the strict footprint gate even though the
  // chordal screens never see it. Interface-to-interface chords are exempt everywhere they are tested.
  const properlyCrossesOutline = (a: [number, number], b: [number, number]): boolean =>
    [chordal, sampled].some(loops => loops.some(loop => loop.some((point, edge) =>
      projectedSegmentsProperlyCross(a, b, point, loop[(edge + 1) % loop.length], 1e-7))));
  const projected = (vertex: number): [number, number] =>
    [candidate.vertices[vertex][0], candidate.vertices[vertex][2]];
  // The conformed rim carries one candidate vertex per protected corner, but only within the prescription
  // residual (the worst authored-corner projection, observed up to ~1.4 m); classify boundary vertices by
  // outline distance so this stays independent of the integrator's private snap bookkeeping and works on
  // hole-mode candidates whose rim is a real boundary as well as on already-cut meshes. The boundary
  // restriction keeps a barely-leaning interior vertex movable, while a grazing unlocked-hole vertex that
  // hugs the outline freezes, which is exactly right: it must not be deformed away from the feature it
  // follows.
  const interfaceVertices = new Set(polygonBoundary(candidate).flat()
    .filter(vertex => nearestOnLoops(chordal, projected(vertex)).distance <= INTERFACE_RESIDUAL_GATE_M));
  // A rim vertex sitting a residual inside the footprint would make every incident edge cross the outline
  // "properly" just off its corner, so crossing tests use the exact corner position, mirroring the
  // integrator's snapped interface.
  const testPosition = (vertex: number): [number, number] =>
    interfaceVertices.has(vertex)
      ? snapToNearestOutlineCorner(projected(vertex), chordal)
      : projected(vertex);
  const targets = new Map<number, Set<number>>();
  const addTarget = (vertex: number, anchor?: number) => {
    const found = targets.get(vertex) ?? new Set<number>();
    if (anchor !== undefined) found.add(anchor);
    targets.set(vertex, found);
  };
  for (const face of new Set(crossingFaces)) {
    const perimeter = candidate.faces[face];
    if (!perimeter) continue;
    for (let corner = 0; corner < perimeter.length; corner++) {
      const a = perimeter[corner], b = perimeter[(corner + 1) % perimeter.length];
      if (a === b || (interfaceVertices.has(a) && interfaceVertices.has(b))) continue;
      if (!properlyCrossesOutline(testPosition(a), testPosition(b))) continue;
      if (interfaceVertices.has(a)) addTarget(b, a);
      else if (interfaceVertices.has(b)) addTarget(a, b);
      else {
        // Both endpoints are interior (an edge slicing a bulge): move the one on or nearest the footprint.
        const aIn = inside(chordal, projected(a)) || inside(sampled, projected(a));
        const bIn = inside(chordal, projected(b)) || inside(sampled, projected(b));
        const mover = aIn === bIn
          ? (nearestOnLoops(sampled, projected(a)).distance <= nearestOnLoops(sampled, projected(b)).distance ? a : b)
          : (aIn ? a : b);
        addTarget(mover, mover === a ? b : a);
      }
    }
    // A face can overlap the footprint by area without any perimeter crossing; pull inside vertices out too.
    for (const vertex of new Set(perimeter)) {
      if (interfaceVertices.has(vertex)) continue;
      const point = projected(vertex);
      if (inside(chordal, point) || inside(sampled, point)) addTarget(vertex);
    }
  }
  // The caller's crossing screen judges post-relaxation positions, so a flagged face can look clean here.
  // Force its interior vertex nearest the outline outward anyway; the escalating margin makes each round
  // trip through relaxation strict progress.
  const forced = new Set<number>();
  for (const face of new Set(crossingFaces)) {
    const perimeter = candidate.faces[face];
    if (!perimeter) continue;
    const interior = [...new Set(perimeter)].filter(vertex => !interfaceVertices.has(vertex));
    if (!interior.length || interior.some(vertex => targets.has(vertex))) continue;
    const mover = interior.reduce((best, vertex) =>
      nearestOnLoops(sampled, projected(vertex)).distance < nearestOnLoops(sampled, projected(best)).distance
        ? vertex : best);
    forced.add(mover);
    addTarget(mover);
    for (let corner = 0; corner < perimeter.length; corner++) {
      const a = perimeter[corner], b = perimeter[(corner + 1) % perimeter.length];
      if (a === mover && interfaceVertices.has(b)) addTarget(mover, b);
      if (b === mover && interfaceVertices.has(a)) addTarget(mover, a);
    }
  }
  const outwardAt = (origin: [number, number]): [number, number] => {
    const near = nearestOnLoops(sampled, origin);
    const probe: [number, number] = [near.point[0] + near.normal[0] * .05, near.point[1] + near.normal[1] * .05];
    return inside(sampled, probe) ? [-near.normal[0], -near.normal[1]] : near.normal;
  };
  const vertices = candidate.vertices.map(point => [...point] as V3);
  let nudgedVertices = 0, maximumNudgeM = 0, unresolvedVertices = 0;
  for (const [vertex, anchorSet] of targets) {
    const at = projected(vertex), anchors = [...anchorSet].map(testPosition);
    const offends = (p: [number, number]): boolean => inside(chordal, p) || inside(sampled, p)
      || Math.min(nearestOnLoops(chordal, p).distance, nearestOnLoops(sampled, p).distance) < marginM
      || anchors.some(anchor => properlyCrossesOutline(anchor, p));
    const violates = inside(chordal, at) || inside(sampled, at)
      || anchors.some(anchor => properlyCrossesOutline(anchor, at));
    if (!violates && !forced.has(vertex)) continue;
    // Candidate directions: each anchor's outward normal keeps a vertex that penetrated past the ribbon
    // center from taking the geometrically nearer exit onto the wrong bank; their bisector escapes a
    // concave pocket where no single anchor's normal satisfies every incident edge at once. The shortest
    // resolving move wins.
    const directions: [number, number][] = [];
    const pushDirection = (d: [number, number]) => {
      const length = Math.hypot(d[0], d[1]);
      if (length < 1e-9) return;
      const unit: [number, number] = [d[0] / length, d[1] / length];
      if (!directions.some(existing => existing[0] * unit[0] + existing[1] * unit[1] > .996)) directions.push(unit);
    };
    for (const anchor of anchors) pushDirection(outwardAt(anchor));
    pushDirection(outwardAt(at));
    if (anchors.length > 1) pushDirection(anchors.reduce<[number, number]>((total, anchor) => {
      const d = outwardAt(anchor);
      return [total[0] + d[0], total[1] + d[1]];
    }, [0, 0]));
    const step = Math.max(.1, marginM * .25);
    let best: { point: [number, number]; distance: number } | undefined;
    for (const direction of directions) {
      // A forced vertex can already look clean in this pre-relaxation frame; start it one full margin out
      // so every pass changes it.
      let p: [number, number] = violates ? at
        : [at[0] + direction[0] * marginM, at[1] + direction[1] * marginM];
      let resolved = !offends(p);
      for (let iteration = 0; iteration < 400 && !resolved; iteration++) {
        p = [p[0] + direction[0] * step, p[1] + direction[1] * step];
        resolved = !offends(p);
      }
      if (!resolved) continue;
      const distance = Math.hypot(p[0] - at[0], p[1] - at[1]);
      if (!best || distance < best.distance) best = { point: p, distance };
    }
    if (!best) { unresolvedVertices++; continue; }
    vertices[vertex] = [best.point[0], candidate.vertices[vertex][1], best.point[1]];
    nudgedVertices++;
    maximumNudgeM = Math.max(maximumNudgeM, best.distance);
  }
  return {
    mesh: { vertices, faces: candidate.faces.map(face => [...face]) },
    nudgedVertices, maximumNudgeM, unresolvedVertices,
  };
}

/** Candidate faces whose top-down footprint overlaps the locked feature's chordal footprint by positive
 * area. A hole-mode candidate carries the locked feature as a real boundary hole, so every overlap is a
 * first-row face leaning over the outline — there is no legitimate interior sheet to cut away. */
export function facesLeaningOverLockedFootprint(source: QuadMeshDoc, candidate: PolygonMesh): number[] {
  const locked = protectedQuadSet(source, 0);
  if (!locked.size) return [];
  const footprint = tessellateQuads(source, locked, 1);
  const triangles: ProjectedTriangle[] = triangulateFaces(footprint).map(triangle => triangle.map(vertex => {
    const point = footprint.vertices[vertex];
    return [point[0], point[2]] as const;
  }) as unknown as ProjectedTriangle);
  // Prescribed rim vertices sit a residual off their protected corner, so a raw first-row face can
  // overlap the footprint by a sliver everywhere the prescribed rim runs inside the authored chord.
  // Snap near-corner vertices onto their corner before testing, mirroring the integrator's interface.
  const outline = edgeCycles(polygonBoundary({ vertices: footprint.vertices, faces: footprint.faces }),
    'locked footprint outline').map(loop => loop.map(vertex => {
      const point = footprint.vertices[vertex];
      return [point[0], point[2]] as [number, number];
    }));
  const boundaryVertices = new Set(polygonBoundary(candidate).flat());
  const snapped = new Map<number, [number, number]>();
  const projectedVertex = (vertex: number): [number, number] => {
    const point: [number, number] = [candidate.vertices[vertex][0], candidate.vertices[vertex][2]];
    if (!boundaryVertices.has(vertex)) return point;
    const corner = snapToNearestOutlineCorner(point, outline);
    if (corner !== point) snapped.set(vertex, corner);
    return corner;
  };
  const projectedFaces: ProjectedPolygon[] = candidate.faces.map((face, id) => ({
    id, points: face.map(projectedVertex),
  }));
  const flagged = new Set(polygonsIntersectProjectedTriangles(projectedFaces, triangles));
  // The bicubic outline bulges outward past the chord near corners, and that bulge can dip across a
  // first-row face's straight side edge — a real overlap the strict footprint gate rejects while every
  // chordal screen stays quiet. Test areas against the sampled footprint with each rim chord spliced to
  // the sampled curve between its corners: a legitimate face then shares the curve exactly (boundary-only
  // contact), while a corner dip keeps positive area.
  const sampledFootprint = tessellateQuads(source, locked, 4);
  const sampledTriangles: ProjectedTriangle[] = triangulateFaces(sampledFootprint).map(triangle =>
    triangle.map(vertex => {
      const point = sampledFootprint.vertices[vertex];
      return [point[0], point[2]] as const;
    }) as unknown as ProjectedTriangle);
  const sampledOutline = edgeCycles(
    polygonBoundary({ vertices: sampledFootprint.vertices, faces: sampledFootprint.faces }),
    'locked footprint sampled outline').map(loop => loop.map(vertex => {
      const point = sampledFootprint.vertices[vertex];
      return [point[0], point[2]] as [number, number];
    }));
  const positionKey = (point: [number, number]) => `${Math.round(point[0] * 256)},${Math.round(point[1] * 256)}`;
  const cornerKeys = new Set(outline.flat().map(positionKey));
  const cornerOnSampled = new Map<string, { loop: number; index: number }>();
  sampledOutline.forEach((loop, loopIndex) => loop.forEach((point, index) => {
    if (cornerKeys.has(positionKey(point))) cornerOnSampled.set(positionKey(point), { loop: loopIndex, index });
  }));
  const splicedFaces: ProjectedPolygon[] = candidate.faces.map((face, id) => {
    const points = projectedFaces[id].points;
    const spliced: [number, number][] = [];
    for (let corner = 0; corner < face.length; corner++) {
      const a = face[corner], b = face[(corner + 1) % face.length];
      if (a === b) continue;
      spliced.push(points[corner] as [number, number]);
      if (!snapped.has(a) || !snapped.has(b)) continue;
      const from = cornerOnSampled.get(positionKey(points[corner] as [number, number]));
      const to = cornerOnSampled.get(positionKey(points[(corner + 1) % face.length] as [number, number]));
      if (!from || !to || from.loop !== to.loop) continue;
      const loop = sampledOutline[from.loop], count = loop.length;
      const forward = (to.index - from.index + count) % count;
      const backward = (from.index - to.index + count) % count;
      const along = forward <= backward ? 1 : -1, steps = Math.min(forward, backward);
      // Only adjacent-corner chords carry the curve; anything longer is not a conforming rim edge.
      if (steps === 0 || steps > 6) continue;
      for (let step = 1; step < steps; step++) {
        spliced.push(loop[((from.index + along * step) % count + count) % count]);
      }
    }
    return { id, points: spliced };
  });
  for (const face of polygonsIntersectProjectedTriangles(splicedFaces, sampledTriangles)) flagged.add(face);
  return [...flagged].sort((a, b) => a - b);
}

export interface LeaningFaceNudge {
  mesh: PolygonMesh;
  nudgedVertices: number;
  maximumNudgeM: number;
  passes: number;
  /** False when leaning faces remain after the marching budget; the caller should fall back. */
  resolved: boolean;
}

/** Clear every leaning first-row face off the locked footprint before integration by nudging, escalating
 * the clearance margin each pass. Replaces the footprint cut for a conforming direct join: cutting a
 * hole-mode candidate removes leaning-face clusters wholesale, which tears the prescribed rim. */
export function nudgeLeaningFacesOffLockedFootprint(
  source: QuadMeshDoc,
  candidate: PolygonMesh,
  maximumPasses = 6,
): LeaningFaceNudge {
  let mesh = candidate, nudgedVertices = 0, maximumNudgeM = 0, passes = 0;
  for (; passes < maximumPasses; passes++) {
    const leaning = facesLeaningOverLockedFootprint(source, mesh);
    if (!leaning.length) return { mesh, nudgedVertices, maximumNudgeM, passes, resolved: true };
    // The 1.5 m base clearance outlasts integration relaxation, which pulls a nudged first-row vertex
    // back toward its neighbors by up to roughly half a metre.
    const nudged = nudgeCrossingVerticesOffLockedFootprint(source, mesh, leaning, 1.5 * 2 ** passes);
    if (!nudged.nudgedVertices) break;
    mesh = nudged.mesh;
    nudgedVertices += nudged.nudgedVertices;
    maximumNudgeM = Math.max(maximumNudgeM, nudged.maximumNudgeM);
  }
  return {
    mesh, nudgedVertices, maximumNudgeM, passes,
    resolved: !facesLeaningOverLockedFootprint(source, mesh).length,
  };
}
