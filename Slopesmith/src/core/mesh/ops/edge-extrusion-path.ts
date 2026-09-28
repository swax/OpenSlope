import type { QuadMeshDoc, V3 } from '../../doc/types';
import { add, cross, dot, len, lerp, mul, norm, sub } from '../../math/vec';
import {
  fromPathFrame, pathRunsForward, rolledPathFrame, sweepPathFrames, toPathFrame, vertexRollOf, type PathFrame,
} from '../path-frame';
import { readVertex } from '../primitives';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import { ekey } from './contract';
import { guideCuts, splitGuideEdges, type GuideSplit } from './guide-split';
import { orderEdgeChain } from './edge-chains';
import { MAX_EXTRUSION_SEGMENTS, type EdgeExtrusionPlan, type EdgeExtrusionPlacement, type EdgeExtrusionRing } from './edge-extrusion';

/** A placement; whether its run turns with the path (`turns`) or is carried parallel; and — when the path bends
 *  tighter than a turning run can follow — a note saying where it folds. */
export type EdgeExtrusionPathResult = { ok: true; placement: EdgeExtrusionPlacement; turns: boolean; warning?: string }
  | { ok: false; error: string };

type BendSample = { curvature: number; normal: V3; frame: PathFrame };

/** Where the profile reaches past the path's centre of curvature on the inside of a bend, the sweep folds over
 *  itself there whatever frames carry it — geometry, not a placement fault. The tightest such bend, as a note. */
function foldWarning(samples: readonly BendSample[], profile: readonly V3[]): string | undefined {
  let worst = 1, radius = 0, reach = 0;
  for (const { curvature, normal, frame } of samples) {
    if (curvature < 1e-9) continue;
    const inward = Math.max(...profile.map(local => dot(fromPathFrame(frame, local), normal)));
    if (inward * curvature > worst) { worst = inward * curvature; radius = 1 / curvature; reach = inward; }
  }
  return worst > 1
    ? `The path bends tighter (${radius.toFixed(1)} m radius) than the edge run reaches into that bend (${reach.toFixed(1)} m), `
      + 'so the new patches fold over on its inside. Ease the path\'s bend there, or extrude a shorter edge run.'
    : undefined;
}

/** Curvature, principal normal (toward the centre) and a station frame at samples along one guide cubic. */
function cubicBends(p0: V3, p1: V3, p2: V3, p3: V3, start: PathFrame, end: PathFrame): BendSample[] {
  const out: BendSample[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, s = 1 - t;
    const d1 = add(add(mul(sub(p1, p0), 3 * s * s), mul(sub(p2, p1), 6 * s * t)), mul(sub(p3, p2), 3 * t * t));
    const d2 = add(mul(add(sub(p2, mul(p1, 2)), p0), 6 * s), mul(add(sub(p3, mul(p2, 2)), p1), 6 * t));
    const speed = len(d1), bend = cross(d1, d2);
    if (speed < 1e-9 || len(bend) < 1e-12) continue;
    out.push({ curvature: len(bend) / speed ** 3, normal: norm(cross(bend, d1)), frame: t < 0.5 ? start : end });
  }
  return out;
}

/** Use a connected mesh-edge chain as an actual side or shared seam of the new quilt. Every guide edge becomes one wall
 * band, preserving authored vertices and cubic handles even when their spacing is uneven — except a free guide edge
 * that turns further than one band can follow (MAX_BAND_TURN), which is cut on its own curve into several
 * (`guide.splits`; applying the placement makes the same cuts). The profile is carried station to station by the
 * least rotation the path makes, kept level wherever level is well defined (sweptPathFrame). */
export function edgeChainExtrusionPlacement(
  doc: QuadMeshDoc, plan: EdgeExtrusionPlan, edges: readonly [number, number][],
  /** `turn`: carry the run turning with the path (a drawn path's frames and roll) or parallel to it. Unset, a
   *  path drawn of free edges turns and a path along existing surface edges runs parallel. */
  options: { turn?: boolean } = {},
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
  let drawn = true;   // every guide edge free: a path drawn for the purpose, not an edge of existing surface
  for (let i = 1; i < chain.length; i++) {
    const incident = adj.edgeQuads.get(ekey(chain[i - 1], chain[i]));
    if (!incident) return { ok: false, error: 'The selected path is stale. Select its edges again.' };
    if (incident.length + adjoiningSources > 2)
      return { ok: false, error: adjoiningSources === 2
        ? 'A path starting in the middle of the source creates patches on both sides. Choose free path edges with no existing patches.'
        : 'A path edge already has a patch on both sides. Choose free or boundary edges so the new quads can join them.' };
    if (len(sub(readVertex(doc.vertices, chain[i]), readVertex(doc.vertices, chain[i - 1]))) < 1e-6)
      return { ok: false, error: 'The path contains an edge with no length. Move or remove that edge first.' };
    if (incident.length) drawn = false;
  }
  const turn = options.turn ?? drawn;
  if (!turn) return parallelChainPlacement(doc, plan, chain, handle, adj);
  const splits: GuideSplit[] = [];
  for (let i = 1; i < chain.length; i++) {
    // A free guide edge that bends a long way would put that whole turn into one band of patches, which a
    // bicubic can't follow — it folds. Cut it on its own curve so each band turns at most MAX_BAND_TURN. (A
    // boundary edge stays whole: its patch would be left with a hanging point.)
    if (adj.edgeQuads.get(ekey(chain[i - 1], chain[i]))?.length) continue;
    const p0 = readVertex(doc.vertices, chain[i - 1]), p3 = readVertex(doc.vertices, chain[i]);
    const ts = guideCuts(p0, add(p0, handle(chain[i - 1], chain[i])), add(p3, handle(chain[i], chain[i - 1])), p3);
    if (ts.length) splits.push({ from: chain[i - 1], to: chain[i], ts });
  }
  // Each guide vertex's own roll banks the profile there (QuadMeshDoc.vertexRoll), measured from the root's. The
  // chain runs root→end; a roll is authored against the lower→higher-id direction (pathRunsForward), so it
  // reads negated wherever the chain runs the other way. Read on the chain as drawn, before any cut; a cut
  // point takes its roll between its edge's ends.
  const roll = (i: number) => {
    const back = chain[Math.max(0, i - 1)], ahead = chain[Math.min(chain.length - 1, i + 1)];
    return (pathRunsForward(doc.vertexIds, back, ahead) ? 1 : -1) * vertexRollOf(doc, chain[i]);
  };
  const work = splitGuideEdges(doc, splits);
  const path = [chain[0]], rolls = [roll(0)];
  let minted = doc.vertices.length / 3;
  for (let i = 1; i < chain.length; i++) {
    for (const t of splits.find(split => split.from === chain[i - 1])?.ts ?? []) {
      path.push(minted++); rolls.push(roll(i - 1) + (roll(i) - roll(i - 1)) * t);
    }
    path.push(chain[i]); rolls.push(roll(i));
  }
  if (path.length - 1 > MAX_EXTRUSION_SEGMENTS)
    return { ok: false, error: `This path bends too much to sweep in at most ${MAX_EXTRUSION_SEGMENTS} bands. Choose a shorter or straighter path.` };
  const workMesh = buildQuadMesh(work.vertices, work.quads, work.freeEdges), workAdj = meshAdjacency(workMesh);
  const workHandle = meshEdgeHandles(workMesh, work.edgeHandles);
  const guideHandles: Record<string, V3> = {};
  for (const vertex of path) for (const neighbor of workAdj.neighbors[vertex]) {
    guideHandles[`${vertex}>${neighbor}`] = [...workHandle(vertex, neighbor)] as V3;
    guideHandles[`${neighbor}>${vertex}`] = [...workHandle(neighbor, vertex)] as V3;
  }
  const tangent = (i: number): V3 => {
    const incoming = i ? mul(workHandle(path[i], path[i - 1]), -1) : [0, 0, 0] as V3;
    const outgoing = i < path.length - 1 ? workHandle(path[i], path[i + 1]) : [0, 0, 0] as V3;
    const sum = add(incoming, outgoing);
    return len(sum) > 1e-8 ? norm(sum)
      : norm(sub(readVertex(work.vertices, path[Math.min(i + 1, path.length - 1)]), readVertex(work.vertices, path[Math.max(0, i - 1)])));
  };
  const tangents = path.map((_, i) => tangent(i));
  if (tangents.some((next, i) => i > 0 && dot(tangents[i - 1], next) < -0.999999))
    return { ok: false, error: 'The path doubles back too sharply. Smooth that turn before extruding.' };
  const swept = sweepPathFrames(tangents);
  if (!swept) return { ok: false, error: 'The path doubles back too sharply. Smooth that turn before extruding.' };
  const frames = swept.map((frame, i) => rolledPathFrame(frame, rolls[i]));
  const profile = localProfile(work, plan, readVertex(work.vertices, root), frames[0]);
  const stations: EdgeExtrusionRing[] = [], bends: BendSample[] = [];
  for (let i = 1; i < path.length; i++) {
    stations.push(profile.at(readVertex(work.vertices, path[i]), frames[i]));
    const p0 = readVertex(work.vertices, path[i - 1]), p3 = readVertex(work.vertices, path[i]);
    bends.push(...cubicBends(p0, add(p0, workHandle(path[i - 1], path[i])), add(p3, workHandle(path[i], path[i - 1])), p3,
      frames[i - 1], frames[i]));
  }
  const warning = foldWarning(bends, profile.offsets);
  return { ok: true, turns: true, ...(warning ? { warning } : {}), placement: { ...stations[stations.length - 1], stations,
    guide: { source: root, vertices: path, handles: guideHandles, frames, ...(splits.length ? { splits } : {}) } } };
}

/** The run carried along the guide without turning: every point follows a parallel copy of the guide's curve, so
 *  each band is the run pulled along the path — a skirt down a terrain edge, however long the run is beside it.
 *  Turning would swing a run that reaches far from the path through an arc its length times the path's turn. */
function parallelChainPlacement(
  doc: QuadMeshDoc, plan: EdgeExtrusionPlan, chain: number[], handle: (from: number, to: number) => V3,
  adj: ReturnType<typeof meshAdjacency>,
): EdgeExtrusionPathResult {
  const origin = readVertex(doc.vertices, chain[0]);
  const guideHandles: Record<string, V3> = {};
  for (const vertex of chain) for (const neighbor of adj.neighbors[vertex]) {
    guideHandles[`${vertex}>${neighbor}`] = [...handle(vertex, neighbor)] as V3;
    guideHandles[`${neighbor}>${vertex}`] = [...handle(neighbor, vertex)] as V3;
  }
  const handles = Object.fromEntries(plan.movingHandles.map(([a, b]) => [`${a}>${b}`, [...plan.pinnedHandles[`${a}>${b}`]] as V3]));
  const stations: EdgeExtrusionRing[] = chain.slice(1).map(vertex => {
    const shift = sub(readVertex(doc.vertices, vertex), origin);
    return {
      vertices: Object.fromEntries(plan.vertices.map(point => [point, add(readVertex(doc.vertices, point), shift)])),
      handles: Object.fromEntries(Object.entries(handles).map(([edge, h]) => [edge, [...h] as V3])),
    };
  });
  return { ok: true, turns: false, placement: { ...stations[stations.length - 1], stations,
    guide: { source: chain[0], vertices: chain, handles: guideHandles, parallel: true } } };
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
  const tangents = Array.from({ length: segments + 1 }, (_, i) =>
    norm(sub(sampled[Math.min(segments, i + 1)], sampled[Math.max(0, i - 1)])));
  if (tangents.some((next, i) => i > 0 && dot(tangents[i - 1], next) < -0.999999))
    return { ok: false, error: 'The path doubles back too sharply. Smooth that turn before extruding.' };
  const frames = sweepPathFrames(tangents);
  if (!frames) return { ok: false, error: 'The path doubles back too sharply. Smooth that turn before extruding.' };
  const center = mul(plan.vertices.reduce<V3>((sum, vertex) => add(sum, readVertex(doc.vertices, vertex)), [0, 0, 0]), 1 / plan.vertices.length);
  const profile = localProfile(doc, plan, center, frames[0]);
  const stations: EdgeExtrusionRing[] = [], bends: BendSample[] = [];
  for (let i = 1; i <= segments; i++) {
    stations.push(profile.at(add(center, sub(sampled[i], sampled[0])), frames[i]));
    if (i === segments) continue;
    const before = sub(sampled[i], sampled[i - 1]), after = sub(sampled[i + 1], sampled[i]);
    const turn = Math.acos(Math.max(-1, Math.min(1, dot(norm(before), norm(after)))));
    const inward = sub(norm(after), norm(before));
    if (turn > 1e-6 && len(inward) > 1e-9)
      bends.push({ curvature: turn / ((len(before) + len(after)) / 2), normal: norm(inward), frame: frames[i] });
  }
  const warning = foldWarning(bends, profile.offsets);
  return { ok: true, turns: true, ...(warning ? { warning } : {}), placement: { ...stations[stations.length - 1], stations } };
}

/** The captured profile — its vertices about `origin` and its moving handles — held in the sweep's start frame
 * (sweepPathFrames, turned by the root's roll), so each station rebuilds it in its own frame: the profile keeps
 * its relation to the path's local axes, its sideways axis staying level through turns that climb or descend
 * unless a station's roll banks it. */
function localProfile(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, origin: V3, frame: PathFrame) {
  const offsets = plan.vertices.map(vertex => [vertex, toPathFrame(frame, sub(readVertex(doc.vertices, vertex), origin))] as const);
  const handles = plan.movingHandles.map(([a, b]) => [`${a}>${b}`, toPathFrame(frame, plan.pinnedHandles[`${a}>${b}`])] as const);
  return {
    /** Each profile point's offset from the path, in the frame it is carried in. */
    offsets: offsets.map(([, local]) => local),
    at: (point: V3, station: PathFrame): EdgeExtrusionRing => ({
      vertices: Object.fromEntries(offsets.map(([vertex, local]) => [vertex, add(point, fromPathFrame(station, local))])),
      handles: Object.fromEntries(handles.map(([edge, local]) => [edge, fromPathFrame(station, local)])),
    }),
  };
}
