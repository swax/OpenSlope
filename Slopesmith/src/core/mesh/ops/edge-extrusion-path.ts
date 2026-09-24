import type { QuadMeshDoc, V3 } from '../../doc/types';
import { add, dot, len, lerp, mul, norm, sub } from '../../math/vec';
import {
  fromPathFrame, levelPathFrame, pathRunsForward, rolledPathFrame, toPathFrame, vertexRollOf, type PathFrame,
} from '../path-frame';
import { readVertex } from '../primitives';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import { ekey } from './contract';
import { orderEdgeChain } from './edge-chains';
import { MAX_EXTRUSION_SEGMENTS, type EdgeExtrusionPlan, type EdgeExtrusionPlacement, type EdgeExtrusionRing } from './edge-extrusion';

export type EdgeExtrusionPathResult = { ok: true; placement: EdgeExtrusionPlacement }
  | { ok: false; error: string };

/** Use a connected mesh-edge chain as an actual side or shared seam of the new quilt. Every guide edge becomes one wall
 * band, preserving authored vertices and cubic handles even when their spacing is uneven. */
export function edgeChainExtrusionPlacement(
  doc: QuadMeshDoc, plan: EdgeExtrusionPlan, edges: readonly [number, number][],
): EdgeExtrusionPathResult {
  if (plan.kind !== 'edge') return { ok: false, error: 'Select an edge or edge run to extrude along a path.' };
  if (!edges.length) return { ok: false, error: 'Select the path edges to follow. The blue edges are the captured source.' };
  const chain = orderEdgeChain(edges);
  if (!chain) return { ok: false, error: 'Select one connected open edge chain for the path, without branches or loops.' };
  const sourceEdges = new Set(plan.edges.map(edge => ekey(edge.from, edge.to)));
  if (edges.some(([a, b]) => sourceEdges.has(ekey(a, b))))
    return { ok: false, error: 'Select the path edges, leaving out the edge being extruded.' };
  const source = new Set(plan.vertices), shared = chain.filter(vertex => source.has(vertex));
  if (shared.length !== 1 || (chain[0] !== shared[0] && chain[chain.length - 1] !== shared[0]))
    return { ok: false, error: 'The path must start at a vertex of the source edge run (an end or a middle vertex) and continue away without touching the source again.' };
  const root = shared[0];
  const adjoiningSources = plan.edges.filter(edge => edge.from === root || edge.to === root).length;
  if (adjoiningSources < 1 || adjoiningSources > 2)
    return { ok: false, error: 'The path can start where one or two source edges meet, but not at a branch of three or more edges.' };
  if (chain[0] !== root) chain.reverse();
  if (edges.length > MAX_EXTRUSION_SEGMENTS)
    return { ok: false, error: `Choose a path with at most ${MAX_EXTRUSION_SEGMENTS} edges.` };
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh);
  const handle = meshEdgeHandles(mesh, doc.edgeHandles);
  for (let i = 1; i < chain.length; i++) {
    const incident = adj.edgeQuads.get(ekey(chain[i - 1], chain[i]));
    if (!incident) return { ok: false, error: 'The selected path is stale. Select its edges again.' };
    if (incident.length + adjoiningSources > 2)
      return { ok: false, error: adjoiningSources === 2
        ? 'A path starting in the middle of the source creates patches on both sides. Choose free path edges with no existing patches.'
        : 'A path edge already has a patch on both sides. Choose free or boundary edges so the new quads can join them.' };
    if (len(sub(readVertex(doc.vertices, chain[i]), readVertex(doc.vertices, chain[i - 1]))) < 1e-6)
      return { ok: false, error: 'The path contains an edge with no length. Move or remove that edge first.' };
  }
  const guideHandles: Record<string, V3> = {};
  for (const vertex of chain) for (const neighbor of adj.neighbors[vertex]) {
    guideHandles[`${vertex}>${neighbor}`] = [...handle(vertex, neighbor)] as V3;
    guideHandles[`${neighbor}>${vertex}`] = [...handle(neighbor, vertex)] as V3;
  }
  const tangent = (i: number): V3 => {
    const incoming = i ? mul(handle(chain[i], chain[i - 1]), -1) : [0, 0, 0] as V3;
    const outgoing = i < chain.length - 1 ? handle(chain[i], chain[i + 1]) : [0, 0, 0] as V3;
    const sum = add(incoming, outgoing);
    return len(sum) > 1e-8 ? norm(sum)
      : norm(sub(readVertex(doc.vertices, chain[Math.min(i + 1, chain.length - 1)]), readVertex(doc.vertices, chain[Math.max(0, i - 1)])));
  };
  // Each guide vertex's own roll banks the profile there (QuadMeshDoc.vertexRoll), measured from the root's. The
  // chain runs root→end; a roll is authored against the lower→higher-id direction (pathRunsForward), so it
  // reads negated wherever the chain runs the other way.
  const roll = (i: number) => {
    const back = chain[Math.max(0, i - 1)], ahead = chain[Math.min(chain.length - 1, i + 1)];
    return (pathRunsForward(doc.vertexIds, back, ahead) ? 1 : -1) * vertexRollOf(doc, chain[i]);
  };
  const origin = readVertex(doc.vertices, root);
  const profile = localProfile(doc, plan, origin, tangent(0), roll(0));
  let previous = tangent(0), level = profile.level;
  const stations: EdgeExtrusionRing[] = [], frames = [profile.frame];
  for (let i = 1; i < chain.length; i++) {
    const next = tangent(i);
    if (dot(previous, next) < -0.999999) return { ok: false, error: 'The path doubles back too sharply. Smooth that turn before extruding.' };
    level = levelPathFrame(next, level.y) ?? level;
    const frame = rolledPathFrame(level, roll(i));
    stations.push(profile.at(readVertex(doc.vertices, chain[i]), frame));
    frames.push(frame);
    previous = next;
  }
  return { ok: true, placement: { ...stations[stations.length - 1], stations,
    guide: { source: root, vertices: chain, handles: guideHandles, frames } } };
}

/** Sweep a captured edge along a sampled path. Align the path's start with the source centroid and carry its
 * cross-section in the path's level frame (localProfile), so it keeps its sideways axis horizontal around bends.
 * Arc-length stations obey the chosen segment length; extra stations resolve changes of direction. */
export function pathEdgeExtrusionPlacement(
  doc: QuadMeshDoc, plan: EdgeExtrusionPlan, path: readonly V3[],
): EdgeExtrusionPathResult {
  if (plan.kind !== 'edge') return { ok: false, error: 'Path extrusion needs a selected edge or edge run.' };
  if (!Number.isFinite(plan.segmentLength) || plan.segmentLength <= 0)
    return { ok: false, error: 'Extrusion segment length must be greater than zero.' };
  if (path.some(point => point.length !== 3 || !point.every(Number.isFinite)))
    return { ok: false, error: 'The selected path contains an invalid point.' };
  const points: V3[] = [];
  for (const point of path)
    if (!points.length || len(sub(point, points[points.length - 1])) > 1e-6) points.push([...point]);
  if (points.length < 2) return { ok: false, error: 'Choose a path with at least two different points.' };
  const distances = [0];
  let turn = 0;
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + len(sub(points[i], points[i - 1])));
    if (i > 1) {
      const before = norm(sub(points[i - 1], points[i - 2])), after = norm(sub(points[i], points[i - 1]));
      turn += Math.acos(Math.max(-1, Math.min(1, dot(before, after))));
    }
  }
  const length = distances[distances.length - 1];
  const segments = Math.max(1, Math.ceil(length / plan.segmentLength), Math.ceil(turn / (Math.PI / 12)));
  if (segments > MAX_EXTRUSION_SEGMENTS)
    return { ok: false, error: `This path needs too many segments. Increase the segment length or choose a shorter path (maximum ${MAX_EXTRUSION_SEGMENTS}).` };
  const sampled: V3[] = [points[0]];
  let span = 1;
  for (let i = 1; i <= segments; i++) {
    const distance = length * i / segments;
    while (span < distances.length - 1 && distances[span] < distance) span++;
    sampled.push(lerp(points[span - 1], points[span],
      (distance - distances[span - 1]) / (distances[span] - distances[span - 1])));
  }
  const tangent = (i: number) => norm(sub(sampled[Math.min(segments, i + 1)], sampled[Math.max(0, i - 1)]));
  let previousTangent = tangent(0);
  const center = mul(plan.vertices.reduce<V3>((sum, vertex) => add(sum, readVertex(doc.vertices, vertex)), [0, 0, 0]), 1 / plan.vertices.length);
  const profile = localProfile(doc, plan, center, previousTangent);
  let frame = profile.level;
  const stations: EdgeExtrusionRing[] = [];
  for (let i = 1; i <= segments; i++) {
    const nextTangent = tangent(i);
    if (dot(previousTangent, nextTangent) < -0.999999)
      return { ok: false, error: 'The path doubles back too sharply. Smooth that turn before extruding.' };
    frame = levelPathFrame(nextTangent, frame.y) ?? frame;
    stations.push(profile.at(add(center, sub(sampled[i], sampled[0])), frame));
    previousTangent = nextTangent;
  }
  return { ok: true, placement: { ...stations[stations.length - 1], stations } };
}

/** The captured profile — its vertices about `origin` and its moving handles — held in the path's local frame at
 * the start (level, turned by `roll`), so each station rebuilds it in its own frame (levelPathFrame): the profile
 * keeps its relation to the path's local axes, its sideways axis staying level through turns that climb or
 * descend unless a station's roll banks it. `level` is the unrolled start frame a sweep continues from. */
function localProfile(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, origin: V3, startTangent: V3, roll = 0) {
  const level = levelPathFrame(startTangent) ?? { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const frame = rolledPathFrame(level, roll);
  const offsets = plan.vertices.map(vertex => [vertex, toPathFrame(frame, sub(readVertex(doc.vertices, vertex), origin))] as const);
  const handles = plan.movingHandles.map(([a, b]) => [`${a}>${b}`, toPathFrame(frame, plan.pinnedHandles[`${a}>${b}`])] as const);
  return {
    level, frame,
    at: (point: V3, station: PathFrame): EdgeExtrusionRing => ({
      vertices: Object.fromEntries(offsets.map(([vertex, local]) => [vertex, add(point, fromPathFrame(station, local))])),
      handles: Object.fromEntries(handles.map(([edge, local]) => [edge, fromPathFrame(station, local)])),
    }),
  };
}
