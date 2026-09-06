import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendMeshIds, seedMeshIds } from '../../doc/ids';
import { add, mul, norm, sub } from '../../math/vec';
import { cubicPolyline, patchNormal } from '../../math/bezier';
import { buildQuadMesh, meshEdgeHandles, quadControlPoints, meshAdjacency } from '../topology';
import {
  ekey, checkManifold, createQuadSurfaceMaps, finishMeshRewrite,
  inheritQuadSurface, locateVertex, looseVertexIds,
} from './contract';
import { quadPerimeterEdges, readVertex } from '../primitives';

/**
 * Edge extrusion: extends a selected boundary edge / run into a new connected strip. A plan freezes the
 * source (validated edges + pinned tangents), a placement stages the outer rim (translated, tangent-guided,
 * or arbitrarily transformed), and the apply bakes one ruled bicubic patch per selected edge.
 */

export interface EdgeExtrusionPlanEdge {
  /** The source/stationary patch whose perimeter direction orients the wall; null for a free edge. */
  from: number;
  to: number;
  sourceQuad: number | null;
  /** Interior extrusion only: the incident patch rewired onto the duplicated edge. */
  sideQuad?: number;
  /** Patch whose paint/texture the new wall inherits; defaults to sourceQuad. */
  inheritQuad?: number;
  /** Unit outward continuation at the source boundary's four cubic control points, from→to. A free edge has
   * no adjacent surface from which to derive this tangent field. */
  continuation?: [V3, V3, V3, V3];
}

export interface EdgeExtrusionPlanCap {
  /** Endpoint of an open interior run, the chosen-side corner beside it, and its incident wall orientation. */
  vertex: number;
  third: number;
  sourceQuad: number;
  wallFrom: boolean;
}

export interface EdgeExtrusionPlan {
  /** Edge extends a rim/free edge; patch lifts a connected region and grows walls around its rim. */
  kind: 'edge' | 'patch';
  edges: EdgeExtrusionPlanEdge[];
  /** Unique points in the moving rim or patch region. Each gets exactly one transformed duplicate. */
  vertices: number[];
  /** Every source edge whose transformed copy belongs to the moving geometry. */
  movingEdges: [number, number][];
  /** Directed source handles whose origin moves with the staged geometry. */
  movingHandles: [number, number][];
  /** Source patches copied onto the moving top. Present only for a patch-region extrusion. */
  topQuads?: { sourceQuad: number; corners: [number, number, number, number] }[];
  /** Existing patches rewired onto a duplicated interior-edge run. */
  sideQuads?: { sourceQuad: number; corners: [number, number, number, number] }[];
  /** Wedge-triangle end caps for an open interior run; a closed loop has none. */
  caps?: EdgeExtrusionPlanCap[];
  /** Initial constrained direction for a patch region (the average selected-surface normal). */
  direction?: V3;
  /** Target depth of one generated wall band, derived from the shortest selected source-edge curve. */
  segmentLength: number;
  /** Effective outgoing handles at every selected endpoint, frozen before adding neighbours changes Bessel. */
  pinnedHandles: Record<string, V3>;
}
export interface EdgeExtrusionPlacement {
  /** Final authored position of each duplicated source endpoint. */
  vertices: Record<number, V3>;
  /** Final directed handles of each transformed outer edge. */
  handles: Record<string, V3>;
  /** Final interior twist vectors of each transformed top patch. */
  twists?: Record<number, [V3, V3, V3, V3]>;
}

export type EdgeExtrusionPlanResult = { ok: true; plan: EdgeExtrusionPlan } | { ok: false; error: string };
export type EdgeExtrusionResult = { ok: true; doc: QuadMeshDoc; quads: number[]; vertices: number[]; outerEdges: [number, number][]; topQuads?: number[] }
  | { ok: false; error: string };

const perimeterEdges = quadPerimeterEdges;

function uniqueEdges(edges: readonly (readonly [number, number])[]): [number, number][] {
  const out = new Map<string, [number, number]>();
  for (const [a, b] of edges) if (a !== b && !out.has(ekey(a, b))) out.set(ekey(a, b), [a, b]);
  return [...out.values()];
}

function uniqueDirectedEdges(edges: readonly (readonly [number, number])[]): [number, number][] {
  const out = new Map<string, [number, number]>();
  for (const [from, to] of edges) if (from !== to && !out.has(`${from}>${to}`)) out.set(`${from}>${to}`, [from, to]);
  return [...out.values()];
}

const bothDirections = (edges: readonly (readonly [number, number])[]) =>
  uniqueDirectedEdges(edges.flatMap(([a, b]) => [[a, b], [b, a]] as [number, number][]));

const MAX_EXTRUSION_SEGMENTS = 16;
const pointAt = (doc: QuadMeshDoc, vertex: number): V3 => readVertex(doc.vertices, vertex);
const mixV3 = (a: V3, b: V3, t: number): V3 =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function sourceEdgeLength(doc: QuadMeshDoc, handle: (from: number, to: number) => V3, from: number, to: number): number {
  const a = pointAt(doc, from), b = pointAt(doc, to);
  const points = cubicPolyline(a, add(a, handle(from, to)), add(b, handle(to, from)), b, 12);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(
    points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  return length;
}

function sourceSegmentLength(doc: QuadMeshDoc, handle: (from: number, to: number) => V3, edges: readonly EdgeExtrusionPlanEdge[]): number {
  const lengths = edges.map(edge => sourceEdgeLength(doc, handle, edge.from, edge.to)).filter(length => length > 1e-3);
  return lengths.length ? Math.min(...lengths) : 1;
}

/** Automatic wall-band count shared by preview and commit. The farthest moved endpoint drives depth while
 * the shortest selected source curve keeps every emitted band no deeper than its narrowest source patch. */
export function edgeExtrusionSegmentCount(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement): number {
  let depth = 0;
  for (const vertex of plan.vertices) {
    const from = pointAt(doc, vertex), to = placement.vertices[vertex];
    depth = Math.max(depth, Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]));
  }
  return Math.max(1, Math.min(MAX_EXTRUSION_SEGMENTS, Math.ceil(depth / Math.max(1e-3, plan.segmentLength))));
}

/** Append n interpolated copies of every moving source vertex. Ring 0 aliases the source id; ring n is the
 * staged rim. Interior patch-region points may leave unused middle copies, which remapIds removes on commit. */
function appendExtrusionRings(
  doc: QuadMeshDoc, plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement, vertices: number[], segments: number,
): Map<number, number[]> {
  const rings = new Map<number, number[]>();
  for (const source of plan.vertices) {
    const from = pointAt(doc, source), ids = [source];
    for (let segment = 1; segment <= segments; segment++) {
      const id = vertices.length / 3, point = mixV3(from, placement.vertices[source], segment / segments);
      vertices.push(...point); ids.push(id);
    }
    rings.set(source, ids);
  }
  return rings;
}

function writeRingEdgeHandles(
  plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement, rings: Map<number, number[]>, segments: number,
  edgeHandles: Record<string, V3>,
) {
  for (const [from, to] of plan.movingEdges) for (const [a, b] of [[from, to], [to, from]] as [number, number][]) {
    const source = plan.pinnedHandles[`${a}>${b}`], target = placement.handles[`${a}>${b}`];
    for (let segment = 0; segment <= segments; segment++) {
      const mappedA = rings.get(a)![segment], mappedB = rings.get(b)![segment];
      edgeHandles[`${mappedA}>${mappedB}`] = mixV3(source, target, segment / segments);
    }
  }
}

function writeCrossHandles(
  doc: QuadMeshDoc, plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement, rings: Map<number, number[]>,
  segments: number, edgeHandles: Record<string, V3>,
) {
  for (const edge of plan.edges) for (const source of [edge.from, edge.to]) {
    const from = pointAt(doc, source), to = placement.vertices[source], ids = rings.get(source)!;
    for (let segment = 1; segment <= segments; segment++) {
      const a = ids[segment - 1], b = ids[segment];
      const pa = mixV3(from, to, (segment - 1) / segments), pb = mixV3(from, to, segment / segments);
      const delta = sub(pb, pa);
      edgeHandles[`${a}>${b}`] = mul(delta, 1 / 3); edgeHandles[`${b}>${a}`] = mul(delta, -1 / 3);
    }
  }
}

/** The source patch's outward cross-boundary tangent at each control point of one oriented perimeter edge. */
function edgeContinuation(cp: V3[], side: number): [V3, V3, V3, V3] {
  const boundary = [[0, 1, 2, 3], [3, 7, 11, 15], [15, 14, 13, 12], [12, 8, 4, 0]][side];
  const inside = [[4, 5, 6, 7], [2, 6, 10, 14], [11, 10, 9, 8], [13, 9, 5, 1]][side];
  const raw = boundary.map((index, i) => sub(cp[index], cp[inside[i]])) as [V3, V3, V3, V3];
  const safe = (v: V3, fallback: V3) => Math.hypot(v[0], v[1], v[2]) > 1e-8 ? norm(v) : fallback;
  const centre = mul(cp[0].map((value, axis) => cp.reduce((sum, p) => sum + p[axis], 0) / cp.length) as V3, 1);
  const g0 = safe(raw[0], norm(sub(cp[boundary[0]], centre)));
  const g3 = safe(raw[3], norm(sub(cp[boundary[3]], centre)));
  const blend1 = norm(add(mul(g0, 2 / 3), mul(g3, 1 / 3)));
  const blend2 = norm(add(mul(g0, 1 / 3), mul(g3, 2 / 3)));
  return [g0, safe(raw[1], blend1), safe(raw[2], blend2), g3];
}

const edgeMidpointUV = (side: number): [number, number] =>
  ([[0, 0.5], [0.5, 1], [1, 0.5], [0.5, 0]] as [number, number][])[side];

/** Validate and freeze an edge extrusion. Boundary/free edges append a strip directly. Interior edges first
 * choose one coherent incident side, rewire that side onto the duplicate, then bridge back to the stationary
 * side—avoiding the non-manifold three-patch fin a naive append would create. */
export function planEdgeExtrusion(
  doc: QuadMeshDoc,
  selection: readonly (readonly [number, number])[],
  preferredQuad: number | null = null,
): EdgeExtrusionPlanResult {
  if (!selection.length) return { ok: false, error: 'Select one or more boundary or free edges to extrude.' };
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh), eh = meshEdgeHandles(mesh, doc.edgeHandles);
  const free = new Set((doc.freeEdges ?? []).map(([a, b]) => ekey(a, b)));
  const unique = new Map<string, [number, number]>();
  for (const edge of selection) {
    const [a, b] = edge;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0 || a >= mesh.vertexCount || b >= mesh.vertexCount) {
      return { ok: false, error: 'The edge selection is stale — select the boundary again.' };
    }
    unique.set(ekey(a, b), a < b ? [a, b] : [b, a]);
  }

  const incidents = new Map<string, number[]>();
  for (const [key] of unique) incidents.set(key, adj.edgeQuads.get(key) ?? []);
  const hasInterior = [...incidents.values()].some(quads => quads.length === 2);
  if (hasInterior && [...incidents.values()].some(quads => quads.length !== 2))
    return { ok: false, error: 'Extrude an interior run separately from boundary or free edges.' };

  if (hasInterior) {
    const entries = [...unique.entries()];
    const selectedVertices = new Set(entries.flatMap(([, edge]) => edge));
    if ((doc.tJunctions ?? []).some(node => selectedVertices.has(node.vertex) || unique.has(ekey(node.edge[0], node.edge[1]))))
      return { ok: false, error: 'Resolve T-junctions touching the interior edge run before extruding it.' };
    const edgeKeysAtVertex = new Map<number, string[]>();
    for (const [key, [a, b]] of entries) {
      edgeKeysAtVertex.set(a, [...(edgeKeysAtVertex.get(a) ?? []), key]);
      edgeKeysAtVertex.set(b, [...(edgeKeysAtVertex.get(b) ?? []), key]);
    }
    if ([...edgeKeysAtVertex.values()].some(keys => keys.length > 2))
      return { ok: false, error: 'Interior extrusion needs a simple edge run or loop; branching selections are ambiguous.' };
    const edgeNeighbors = new Map<string, Set<string>>(entries.map(([key]) => [key, new Set<string>()]));
    for (const keys of edgeKeysAtVertex.values()) if (keys.length === 2) {
      edgeNeighbors.get(keys[0])!.add(keys[1]); edgeNeighbors.get(keys[1])!.add(keys[0]);
    }
    const connected = new Set<string>(), pendingKeys = [entries[0][0]];
    while (pendingKeys.length) {
      const key = pendingKeys.pop()!;
      if (connected.has(key)) continue;
      connected.add(key);
      for (const next of edgeNeighbors.get(key) ?? []) pendingKeys.push(next);
    }
    if (connected.size !== entries.length)
      return { ok: false, error: 'Interior extrusion needs one connected edge run. Extrude disconnected runs separately.' };

    // Two candidate incident patches exist at each edge. Across every non-selected seam, patches belong to
    // the same coherent side strip; propagate the clicked face through that strip.
    const selectedKeys = new Set(entries.map(([key]) => key));
    const quadSideNeighbors = new Map<number, Set<number>>();
    for (const [key, quads] of adj.edgeQuads) {
      if (selectedKeys.has(key) || quads.length !== 2) continue;
      const [a, b] = quads;
      (quadSideNeighbors.get(a) ?? (quadSideNeighbors.set(a, new Set()), quadSideNeighbors.get(a)!)).add(b);
      (quadSideNeighbors.get(b) ?? (quadSideNeighbors.set(b, new Set()), quadSideNeighbors.get(b)!)).add(a);
    }
    const coherent = (a: number, b: number) => a === b || !!quadSideNeighbors.get(a)?.has(b);
    const seed = entries.find(([key]) => preferredQuad !== null && incidents.get(key)!.includes(preferredQuad)) ?? entries[0];
    const seedCandidates = incidents.get(seed[0])!;
    const seedQuad = preferredQuad !== null && seedCandidates.includes(preferredQuad) ? preferredQuad : seedCandidates[0];
    const chosen = new Map<string, number>([[seed[0], seedQuad]]), queue = [seed[0]];
    while (queue.length) {
      const key = queue.shift()!, side = chosen.get(key)!;
      for (const next of edgeNeighbors.get(key) ?? []) {
        const assigned = chosen.get(next);
        if (assigned !== undefined) {
          if (!coherent(side, assigned)) return { ok: false, error: 'The selected edge run does not have one coherent side through its turns.' };
          continue;
        }
        const candidates = incidents.get(next)!.filter(quad => coherent(side, quad));
        if (candidates.length !== 1)
          return { ok: false, error: 'The selected edge run has an ambiguous side at a turn or pole.' };
        chosen.set(next, candidates[0]); queue.push(next);
      }
    }

    const edges: EdgeExtrusionPlanEdge[] = [];
    let normalSum: V3 = [0, 0, 0];
    for (const [key] of entries) {
      const sideQuad = chosen.get(key)!, stationaryQuad = incidents.get(key)!.find(quad => quad !== sideQuad)!;
      const perimeter = perimeterEdges(mesh.quads[stationaryQuad]);
      const side = perimeter.findIndex(([a, b]) => ekey(a, b) === key), oriented = perimeter[side];
      if (!oriented) return { ok: false, error: 'Could not orient the selected interior edge.' };
      const cp = quadControlPoints(mesh, eh, stationaryQuad, doc.quadTwist?.[stationaryQuad] ?? null);
      const [u, v] = edgeMidpointUV(side);
      normalSum = add(normalSum, patchNormal(cp, u, v));
      const movingSide = perimeterEdges(mesh.quads[sideQuad]).findIndex(([a, b]) => ekey(a, b) === key);
      if (movingSide < 0) return { ok: false, error: 'Could not orient the chosen side of the interior edge.' };
      const movingCp = quadControlPoints(mesh, eh, sideQuad, doc.quadTwist?.[sideQuad] ?? null);
      const [movingU, movingV] = edgeMidpointUV(movingSide);
      normalSum = add(normalSum, patchNormal(movingCp, movingU, movingV));
      edges.push({ from: oriented[0], to: oriented[1], sourceQuad: stationaryQuad, sideQuad, inheritQuad: sideQuad,
        continuation: edgeContinuation(cp, side) });
    }
    const vertices = [...new Set(edges.flatMap(edge => [edge.from, edge.to]))].sort((a, b) => a - b);
    const vertexSet = new Set(vertices), sideQuadIds = [...new Set(chosen.values())].sort((a, b) => a - b);
    const sideQuads = sideQuadIds.map(sourceQuad => ({
      sourceQuad, corners: [...doc.quads[sourceQuad]] as [number, number, number, number],
    }));
    const pinnedHandles: Record<string, V3> = {};
    const pin = (from: number, to: number) => {
      const h = eh(from, to); pinnedHandles[`${from}>${to}`] = [h[0], h[1], h[2]];
    };
    for (const from of vertices) for (const to of adj.neighbors[from] ?? []) pin(from, to);
    for (const { corners } of sideQuads) for (const [a, b] of perimeterEdges(corners)) { pin(a, b); pin(b, a); }
    const movingEdges = edges.map(edge => [edge.from, edge.to] as [number, number]);
    const movingHandles = uniqueDirectedEdges(sideQuads.flatMap(({ corners }) =>
      perimeterEdges(corners).flatMap(([a, b]) => [[a, b], [b, a]] as [number, number][])
        .filter(([from]) => vertexSet.has(from))));
    const caps: EdgeExtrusionPlanCap[] = [];
    for (const [vertex, keys] of edgeKeysAtVertex) {
      if (keys.length !== 1) continue; // only the two ends of an open run; a loop has no caps
      const key = keys[0], selectedEdge = unique.get(key)!, other = selectedEdge[0] === vertex ? selectedEdge[1] : selectedEdge[0];
      const sourceQuad = chosen.get(key)!, corners = doc.quads[sourceQuad];
      const neighbors = perimeterEdges(corners).filter(([a, b]) => a === vertex || b === vertex)
        .map(([a, b]) => a === vertex ? b : a).filter(neighbor => neighbor !== other);
      if (neighbors.length !== 1)
        return { ok: false, error: 'Interior extrusion could not form a triangular cap at the end of the selected run.' };
      const wall = edges.find(edge => ekey(edge.from, edge.to) === key)!;
      caps.push({ vertex, third: neighbors[0], sourceQuad, wallFrom: wall.from === vertex });
    }
    const direction = Math.hypot(normalSum[0], normalSum[1], normalSum[2]) > 1e-8 ? norm(normalSum) : [0, 1, 0] as V3;
    return { ok: true, plan: {
      kind: 'edge', edges, vertices, movingEdges, movingHandles, sideQuads, caps, direction,
      segmentLength: sourceSegmentLength(doc, eh, edges), pinnedHandles,
    } };
  }

  const edges: EdgeExtrusionPlanEdge[] = [];
  for (const [key, edge] of unique) {
    const incident = adj.edgeQuads.get(key) ?? [];
    if (incident.length > 1) return { ok: false, error: 'Extrude needs boundary or free edges — an interior edge already has a patch on both sides.' };
    if (!incident.length) {
      if (!free.has(key)) return { ok: false, error: 'The selected edge is neither a patch boundary nor a free edge.' };
      edges.push({ from: edge[0], to: edge[1], sourceQuad: null });
      continue;
    }
    const sourceQuad = incident[0];
    const [A, B, C, D] = mesh.quads[sourceQuad];
    const perimeter = [[A, B], [B, D], [D, C], [C, A]] as [number, number][];
    const side = perimeter.findIndex(([a, b]) => ekey(a, b) === key);
    const oriented = perimeter[side];
    if (!oriented) return { ok: false, error: 'Could not orient the selected boundary edge.' };
    const cp = quadControlPoints(mesh, eh, sourceQuad, doc.quadTwist?.[sourceQuad] ?? null);
    edges.push({ from: oriented[0], to: oriented[1], sourceQuad, continuation: edgeContinuation(cp, side) });
  }

  const vertices = [...new Set(edges.flatMap(e => [e.from, e.to]))].sort((a, b) => a - b);
  // Adding each new cross-edge changes the selected endpoint's neighbour ring. Pin every OLD outgoing tangent
  // there first, not only the selected curve, so the source mountain remains byte-for-byte shaped after append.
  const pinnedHandles: Record<string, V3> = {};
  for (const from of vertices) for (const to of adj.neighbors[from] ?? []) {
    const h = eh(from, to);
    pinnedHandles[`${from}>${to}`] = [h[0], h[1], h[2]];
  }
  return { ok: true, plan: {
    kind: 'edge', edges, vertices,
    movingEdges: edges.map(edge => [edge.from, edge.to]),
    movingHandles: bothDirections(edges.map(edge => [edge.from, edge.to])),
    segmentLength: sourceSegmentLength(doc, eh, edges),
    pinnedHandles,
  } };
}

/** Freeze a connected patch-region extrusion. The selected top is copied intact, while each topological
 * boundary edge grows one wall patch back to the stationary source rim. */
export function planPatchExtrusion(doc: QuadMeshDoc, selection: readonly number[]): EdgeExtrusionPlanResult {
  if (!selection.length) return { ok: false, error: 'Select one or more connected patches to extrude.' };
  const selected = new Set<number>();
  for (const quad of selection) {
    if (!Number.isInteger(quad) || quad < 0 || quad >= doc.quads.length)
      return { ok: false, error: 'The patch selection is stale — select the region again.' };
    selected.add(quad);
  }
  for (const quad of selected) {
    const corners = doc.quads[quad];
    if (corners.length !== 4 || new Set(corners).size !== 4)
      return { ok: false, error: 'Patch extrusion currently needs four distinct corners; dissolve or rebuild the wedge first.' };
  }

  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh);
  const selectedEdges = uniqueEdges([...selected].flatMap(quad => perimeterEdges(doc.quads[quad])));
  const selectedEdgeKeys = new Set(selectedEdges.map(([a, b]) => ekey(a, b)));
  const vertices = [...new Set([...selected].flatMap(quad => doc.quads[quad]))].sort((a, b) => a - b);
  const vertexSet = new Set(vertices);
  if ((doc.tJunctions ?? []).some(node => vertexSet.has(node.vertex) || selectedEdgeKeys.has(ekey(node.edge[0], node.edge[1]))))
    return { ok: false, error: 'Resolve T-junctions touching the selected region before extruding it.' };

  // Patches that touch only at a corner are not one extrudable region. Walk selected edge-neighbours.
  const reached = new Set<number>(), pending = [[...selected][0]];
  while (pending.length) {
    const quad = pending.pop()!;
    if (reached.has(quad)) continue;
    reached.add(quad);
    for (const [a, b] of perimeterEdges(doc.quads[quad]))
      for (const neighbor of adj.edgeQuads.get(ekey(a, b)) ?? [])
        if (selected.has(neighbor) && !reached.has(neighbor)) pending.push(neighbor);
  }
  if (reached.size !== selected.size)
    return { ok: false, error: 'Patch extrusion needs one edge-connected region. Extrude disconnected groups separately.' };

  const eh = meshEdgeHandles(mesh, doc.edgeHandles);
  const edges: EdgeExtrusionPlanEdge[] = [];
  for (const quad of selected) {
    const cp = quadControlPoints(mesh, eh, quad, doc.quadTwist?.[quad] ?? null);
    for (const [side, [from, to]] of perimeterEdges(doc.quads[quad]).entries()) {
      const incidentSelected = (adj.edgeQuads.get(ekey(from, to)) ?? []).filter(q => selected.has(q));
      if (incidentSelected.length === 1) edges.push({ from, to, sourceQuad: quad, continuation: edgeContinuation(cp, side) });
    }
  }
  if (!edges.length) return { ok: false, error: 'The selected patches have no boundary to grow extrusion walls from.' };
  const boundaryDegree = new Map<number, number>();
  for (const edge of edges) {
    boundaryDegree.set(edge.from, (boundaryDegree.get(edge.from) ?? 0) + 1);
    boundaryDegree.set(edge.to, (boundaryDegree.get(edge.to) ?? 0) + 1);
  }
  if ([...boundaryDegree.values()].some(degree => degree !== 2))
    return { ok: false, error: 'The selected region has a pinched or branching boundary. Extrude a simple connected region instead.' };

  // Freeze the old cage so surrounding patches do not change when the source rim gains wall neighbours.
  const pinnedHandles: Record<string, V3> = {};
  for (const from of vertices) for (const to of adj.neighbors[from] ?? []) {
    const h = eh(from, to);
    pinnedHandles[`${from}>${to}`] = [h[0], h[1], h[2]];
  }
  const movingEdges = uniqueEdges([...selected].flatMap(quad => perimeterEdges(doc.quads[quad])));
  let normalSum: V3 = [0, 0, 0];
  for (const quad of selected) {
    const cp = quadControlPoints(mesh, eh, quad, doc.quadTwist?.[quad] ?? null);
    normalSum = add(normalSum, patchNormal(cp, 0.5, 0.5));
  }
  const direction = Math.hypot(normalSum[0], normalSum[1], normalSum[2]) > 1e-8 ? norm(normalSum) : [0, 1, 0] as V3;
  const topQuads = [...selected].sort((a, b) => a - b).map(sourceQuad => ({
    sourceQuad,
    corners: [...doc.quads[sourceQuad]] as [number, number, number, number],
  }));
  return { ok: true, plan: {
    kind: 'patch', edges, vertices, movingEdges, movingHandles: bothDirections(movingEdges),
    topQuads, direction, segmentLength: sourceSegmentLength(doc, eh, edges), pinnedHandles,
  } };
}

/** Translation-only placement used by the direct core API and as an initial interactive stage. */
export function translatedEdgeExtrusionPlacement(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, delta: V3): EdgeExtrusionPlacement {
  const vertices: Record<number, V3> = {}, handles: Record<string, V3> = {};
  for (const source of plan.vertices) {
    const i = source * 3;
    vertices[source] = [doc.vertices[i] + delta[0], doc.vertices[i + 1] + delta[1], doc.vertices[i + 2] + delta[2]];
  }
  for (const [from, to] of plan.movingHandles) {
    handles[`${from}>${to}`] = [...plan.pinnedHandles[`${from}>${to}`]] as V3;
  }
  const twists = copyPlanTwists(doc, plan);
  return { vertices, handles, ...(twists ? { twists } : {}) };
}

function copyPlanTwists(doc: QuadMeshDoc, plan: EdgeExtrusionPlan): EdgeExtrusionPlacement['twists'] {
  if (!plan.topQuads?.length) return undefined;
  const twists: NonNullable<EdgeExtrusionPlacement['twists']> = {};
  for (const { sourceQuad } of plan.topQuads) {
    const source = doc.quadTwist?.[sourceQuad] ?? [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    twists[sourceQuad] = source.map(v => [...v] as V3) as [V3, V3, V3, V3];
  }
  return twists;
}

/** Initial interactive placement for an extrusion. Surface boundaries continue along their source patch's
 * local outward tangent field, so a fan's connectors converge/diverge instead of becoming parallel. Shared
 * run vertices average their incident continuation directions. Free edges fall back to the literal drag. */
export function tangentEdgeExtrusionPlacement(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, delta: V3): EdgeExtrusionPlacement {
  const distance = Math.hypot(delta[0], delta[1], delta[2]);
  // Patch extrusion's one-axis stage carries a signed distance in local X, so dragging through the source
  // changes a mesa into a canyon. Edge continuation remains a non-negative outward distance.
  if (plan.direction) return translatedEdgeExtrusionPlacement(doc, plan, mul(plan.direction, delta[0]));
  const sums = new Map<number, V3>(), first = new Map<number, V3>();
  for (const edge of plan.edges) {
    if (!edge.continuation) continue;
    for (const [vertex, guide] of [[edge.from, edge.continuation[0]], [edge.to, edge.continuation[3]]] as [number, V3][]) {
      sums.set(vertex, add(sums.get(vertex) ?? [0, 0, 0], guide));
      if (!first.has(vertex)) first.set(vertex, guide);
    }
  }
  const vertices: Record<number, V3> = {}, handles: Record<string, V3> = {};
  for (const source of plan.vertices) {
    const p = readVertex(doc.vertices, source);
    const sum = sums.get(source);
    const direction = sum && Math.hypot(sum[0], sum[1], sum[2]) > 1e-8 ? norm(sum) : first.get(source);
    vertices[source] = direction ? add(p, mul(direction, distance)) : add(p, delta);
  }
  for (const edge of plan.edges) {
    const from = readVertex(doc.vertices, edge.from), to = readVertex(doc.vertices, edge.to);
    if (edge.continuation) {
      const source1 = add(from, plan.pinnedHandles[`${edge.from}>${edge.to}`]);
      const source2 = add(to, plan.pinnedHandles[`${edge.to}>${edge.from}`]);
      handles[`${edge.from}>${edge.to}`] = sub(add(source1, mul(edge.continuation[1], distance)), vertices[edge.from]);
      handles[`${edge.to}>${edge.from}`] = sub(add(source2, mul(edge.continuation[2], distance)), vertices[edge.to]);
    } else {
      handles[`${edge.from}>${edge.to}`] = [...plan.pinnedHandles[`${edge.from}>${edge.to}`]] as V3;
      handles[`${edge.to}>${edge.from}`] = [...plan.pinnedHandles[`${edge.to}>${edge.from}`]] as V3;
    }
  }
  for (const [from, to] of plan.movingHandles)
    handles[`${from}>${to}`] ??= [...plan.pinnedHandles[`${from}>${to}`]] as V3;
  const twists = copyPlanTwists(doc, plan);
  return { vertices, handles, ...(twists ? { twists } : {}) };
}

/** A small local document containing only the prospective strip. The viewport tessellates this for the interactive
 * ghost, so curved source/outer edges and the ruled interior are faithful without rebuilding the full mountain. */
export function edgeExtrusionPreviewDoc(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, delta: V3): QuadMeshDoc {
  return edgeExtrusionPlacementPreviewDoc(doc, plan, translatedEdgeExtrusionPlacement(doc, plan, delta));
}

/** Local preview for an arbitrarily transformed outer edge (move / rotate / scale staging). */
export function edgeExtrusionPlacementPreviewDoc(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement): QuadMeshDoc {
  const segments = edgeExtrusionSegmentCount(doc, plan, placement);
  const old = new Map<number, number>(), fresh = new Map<number, number>(), rings = new Map<number, number[]>();
  const vertices: number[] = [], moved = new Set(plan.vertices);
  const ensureOld = (source: number) => {
    let local = old.get(source);
    if (local !== undefined) return local;
    local = vertices.length / 3; old.set(source, local);
    vertices.push(...readVertex(doc.vertices, source));
    return local;
  };
  for (const source of plan.vertices) {
    const from = pointAt(doc, source), ids: number[] = [];
    for (let segment = 0; segment <= segments; segment++) {
      ids.push(vertices.length / 3); vertices.push(...mixV3(from, placement.vertices[source], segment / segments));
    }
    rings.set(source, ids); old.set(source, ids[0]); fresh.set(source, ids[segments]);
  }
  for (const side of plan.sideQuads ?? []) for (const source of side.corners) ensureOld(source);
  const edgeHandles: Record<string, V3> = {};
  for (const [from, to] of plan.movingEdges) for (const [a, b] of [[from, to], [to, from]] as [number, number][]) {
    const source = plan.pinnedHandles[`${a}>${b}`], target = placement.handles[`${a}>${b}`];
    for (let segment = 0; segment <= segments; segment++)
      edgeHandles[`${rings.get(a)![segment]}>${rings.get(b)![segment]}`] = mixV3(source, target, segment / segments);
  }
  const quads: number[][] = [];
  for (const edge of plan.edges) for (let segment = 1; segment <= segments; segment++) {
    const a = rings.get(edge.from)![segment - 1], b = rings.get(edge.to)![segment - 1];
    const na = rings.get(edge.from)![segment], nb = rings.get(edge.to)![segment];
    for (const source of [edge.from, edge.to]) {
      const ids = rings.get(source)!, p0 = vertices.slice(ids[segment - 1] * 3, ids[segment - 1] * 3 + 3) as V3;
      const p1 = vertices.slice(ids[segment] * 3, ids[segment] * 3 + 3) as V3, delta = sub(p1, p0);
      edgeHandles[`${ids[segment - 1]}>${ids[segment]}`] = mul(delta, 1 / 3);
      edgeHandles[`${ids[segment]}>${ids[segment - 1]}`] = mul(delta, -1 / 3);
    }
    // Edge extrusion keeps the source face, while patch-region extrusion removes it and meets a copied top.
    quads.push(plan.kind === 'patch' ? [a, b, na, nb] : [a, na, b, nb]);
  }
  for (const [from, to] of plan.movingEdges) {
    const a = fresh.get(from)!, b = fresh.get(to)!;
    edgeHandles[`${a}>${b}`] = [...placement.handles[`${from}>${to}`]] as V3;
    edgeHandles[`${b}>${a}`] = [...placement.handles[`${to}>${from}`]] as V3;
  }
  const quadTwist: Record<number, [V3, V3, V3, V3]> = {};
  for (const cap of plan.caps ?? []) {
    const ids = rings.get(cap.vertex)!, third = old.get(cap.third)!;
    for (let segment = 1; segment <= segments; segment++)
      quads.push(cap.wallFrom
        ? [ids[segment], ids[segment - 1], third, third]
        : [ids[segment - 1], ids[segment], third, third]);
  }
  for (const side of plan.sideQuads ?? []) {
    const quad = quads.length;
    quads.push(side.corners.map(vertex => moved.has(vertex) ? fresh.get(vertex)! : old.get(vertex)!) as [number, number, number, number]);
    for (const [from, to] of perimeterEdges(side.corners)) for (const [a, b] of [[from, to], [to, from]] as [number, number][]) {
      const localA = moved.has(a) ? fresh.get(a)! : old.get(a)!, localB = moved.has(b) ? fresh.get(b)! : old.get(b)!;
      const handle = moved.has(a) ? placement.handles[`${a}>${b}`] : plan.pinnedHandles[`${a}>${b}`];
      edgeHandles[`${localA}>${localB}`] = [...handle] as V3;
    }
    const twist = doc.quadTwist?.[side.sourceQuad];
    if (twist) quadTwist[quad] = twist.map(v => [...v] as V3) as [V3, V3, V3, V3];
  }
  for (const top of plan.topQuads ?? []) {
    const quad = quads.length;
    quads.push(top.corners.map(vertex => fresh.get(vertex)!) as [number, number, number, number]);
    const twist = placement.twists?.[top.sourceQuad] ?? doc.quadTwist?.[top.sourceQuad];
    if (twist) quadTwist[quad] = twist.map(v => [...v] as V3) as [V3, V3, V3, V3];
  }
  return {
    ...doc,
    vertices,
    quads,
    ...seedMeshIds(doc.nextId, vertices.length / 3, quads.length),
    edgeHandles,
    quadPaint: undefined,
    quadTex: undefined,
    quadOrient: undefined,
    quadLocked: undefined,
    quadLabels: undefined,
    quadTwist: Object.keys(quadTwist).length ? quadTwist : undefined,
    freeEdges: undefined,
  };
}

/** Append one ruled bicubic patch per selected boundary edge. The translated outer curve is an exact copy of
 * the source cubic; cross-curves are linear thirds, so every interior control row follows the drag at 1/3 and
 * 2/3. Existing source tangents are pinned from the plan before topology changes can alter their Bessel default. */
export function applyEdgeExtrusion(
  doc: QuadMeshDoc,
  selection: readonly (readonly [number, number])[],
  delta: V3,
): EdgeExtrusionResult {
  if (!delta.every(Number.isFinite) || Math.hypot(delta[0], delta[1], delta[2]) < 1e-4) {
    return { ok: false, error: 'Drag the selected edge away from its current position to extrude.' };
  }
  const planned = planEdgeExtrusion(doc, selection);
  if (!planned.ok) return planned;
  return applyPlannedEdgeExtrusion(doc, planned.plan, translatedEdgeExtrusionPlacement(doc, planned.plan, delta));
}

/** Translation-only core API for a connected patch-region extrusion. Interactive callers normally stage the
 * same plan so Move / Rotate / Scale can adjust its lifted top before commit. */
export function applyPatchExtrusion(doc: QuadMeshDoc, selection: readonly number[], delta: V3): EdgeExtrusionResult {
  if (!delta.every(Number.isFinite) || Math.hypot(delta[0], delta[1], delta[2]) < 1e-4)
    return { ok: false, error: 'Move the selected patches away from their source to extrude.' };
  const planned = planPatchExtrusion(doc, selection);
  if (!planned.ok) return planned;
  return applyPlannedEdgeExtrusion(doc, planned.plan, translatedEdgeExtrusionPlacement(doc, planned.plan, delta));
}

/** Bake a frozen extrusion plan at its staged outer-edge placement. */
export function applyPlannedEdgeExtrusion(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement): EdgeExtrusionResult {
  if (plan.vertices.some(v => !placement.vertices[v]?.every(Number.isFinite)))
    return { ok: false, error: 'The staged extrusion contains an invalid endpoint.' };
  if (plan.movingHandles.some(([from, to]) => !placement.handles[`${from}>${to}`]?.every(Number.isFinite)))
    return { ok: false, error: 'The staged extrusion contains an invalid curve handle.' };
  const moved = plan.vertices.some(v => {
    const i = v * 3, p = placement.vertices[v];
    return Math.hypot(p[0] - doc.vertices[i], p[1] - doc.vertices[i + 1], p[2] - doc.vertices[i + 2]) >= 1e-4;
  });
  if (!moved) return { ok: false, error: 'Move the staged outer edge away from its source before committing.' };
  if (plan.kind === 'patch') return applyPlannedPatchExtrusion(doc, plan, placement);
  if (plan.sideQuads?.length) return applyPlannedInteriorEdgeExtrusion(doc, plan, placement);
  const segments = edgeExtrusionSegmentCount(doc, plan, placement);
  const vertices = doc.vertices.slice(), quads = doc.quads.map(q => q.slice());
  const edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}), ...plan.pinnedHandles };
  const surfaceMaps = createQuadSurfaceMaps(doc, true);
  const { quadPaint, quadTex, quadOrient, quadLocked, quadLabels } = surfaceMaps;
  const firstAddedVertex = vertices.length / 3;
  const rings = appendExtrusionRings(doc, plan, placement, vertices, segments);
  writeRingEdgeHandles(plan, placement, rings, segments, edgeHandles);
  writeCrossHandles(doc, plan, placement, rings, segments, edgeHandles);
  const addedVertices = Array.from({ length: vertices.length / 3 - firstAddedVertex }, (_, index) => firstAddedVertex + index);

  const addedQuads: number[] = [], outerEdges: [number, number][] = [];
  for (const edge of plan.edges) {
    const inherit = edge.inheritQuad ?? edge.sourceQuad;
    const fromRings = rings.get(edge.from)!, toRings = rings.get(edge.to)!;
    for (let segment = 1; segment <= segments; segment++) {
      const quad = quads.length;
      quads.push([fromRings[segment - 1], fromRings[segment], toRings[segment - 1], toRings[segment]]);
      addedQuads.push(quad);
      if (inherit !== null) inheritQuadSurface(doc, surfaceMaps, inherit, quad);
    }
    const na = fromRings[segments], nb = toRings[segments];
    outerEdges.push(na < nb ? [na, nb] : [nb, na]);
  }
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };
  const consumed = new Set(plan.edges.map(edge => ekey(edge.from, edge.to)));
  const freeEdges = (doc.freeEdges ?? []).filter(([a, b]) => !consumed.has(ekey(a, b)));
  const out: QuadMeshDoc = {
    ...doc, vertices, quads, edgeHandles, ...appendMeshIds(doc, addedVertices.length, addedQuads.length),
  };
  if (freeEdges.length) out.freeEdges = freeEdges; else delete out.freeEdges;
  if (quadPaint) out.quadPaint = quadPaint;
  if (quadTex) out.quadTex = quadTex;
  if (quadOrient) out.quadOrient = quadOrient;
  if (quadLocked) out.quadLocked = quadLocked;
  if (quadLabels) out.quadLabels = quadLabels;
  return { ok: true, doc: out, quads: addedQuads, vertices: addedVertices, outerEdges };
}

/** Interior-edge extrusion keeps one incident side stationary, rewires the chosen side onto a duplicated run,
 * bridges the two with one wall patch per selected edge, and closes an open run with wedge-triangle end caps. */
function applyPlannedInteriorEdgeExtrusion(
  doc: QuadMeshDoc,
  plan: EdgeExtrusionPlan,
  placement: EdgeExtrusionPlacement,
): EdgeExtrusionResult {
  const segments = edgeExtrusionSegmentCount(doc, plan, placement);
  const moved = new Set(plan.vertices), vertices = doc.vertices.slice(), quads = doc.quads.map(quad => quad.slice());
  const edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}), ...plan.pinnedHandles };
  const surfaceMaps = createQuadSurfaceMaps(doc, true);
  const { quadPaint, quadTex, quadOrient, quadLocked, quadLabels } = surfaceMaps;
  const firstAddedVertex = vertices.length / 3;
  const rings = appendExtrusionRings(doc, plan, placement, vertices, segments);
  writeRingEdgeHandles(plan, placement, rings, segments, edgeHandles);
  writeCrossHandles(doc, plan, placement, rings, segments, edgeHandles);
  const fresh = new Map(plan.vertices.map(source => [source, rings.get(source)![segments]]));
  const addedVertices = Array.from({ length: vertices.length / 3 - firstAddedVertex }, (_, index) => firstAddedVertex + index);

  for (const side of plan.sideQuads ?? []) {
    quads[side.sourceQuad] = side.corners.map(vertex => moved.has(vertex) ? fresh.get(vertex)! : vertex);
    for (const [from, to] of perimeterEdges(side.corners)) for (const [a, b] of [[from, to], [to, from]] as [number, number][]) {
      const mappedA = moved.has(a) ? fresh.get(a)! : a, mappedB = moved.has(b) ? fresh.get(b)! : b;
      const handle = moved.has(a) ? placement.handles[`${a}>${b}`] : plan.pinnedHandles[`${a}>${b}`];
      edgeHandles[`${mappedA}>${mappedB}`] = [...handle] as V3;
    }
  }

  const addedQuads: number[] = [], outerEdges: [number, number][] = [];
  const inherit = (target: number, source: number | null) => {
    if (source !== null) inheritQuadSurface(doc, surfaceMaps, source, target);
    if (quadLabels) delete quadLabels[target];
  };
  for (const edge of plan.edges) {
    const fromRings = rings.get(edge.from)!, toRings = rings.get(edge.to)!;
    for (let segment = 1; segment <= segments; segment++) {
      const quad = quads.length;
      quads.push([fromRings[segment - 1], fromRings[segment], toRings[segment - 1], toRings[segment]]);
      addedQuads.push(quad); inherit(quad, edge.inheritQuad ?? edge.sourceQuad);
    }
    const na = fromRings[segments], nb = toRings[segments];
    outerEdges.push(na < nb ? [na, nb] : [nb, na]);
  }
  for (const cap of plan.caps ?? []) {
    const ids = rings.get(cap.vertex)!;
    for (let segment = 1; segment <= segments; segment++) {
      const quad = quads.length;
      quads.push(cap.wallFrom
        ? [ids[segment], ids[segment - 1], cap.third, cap.third]
        : [ids[segment - 1], ids[segment], cap.third, cap.third]);
      addedQuads.push(quad); inherit(quad, cap.sourceQuad);
    }
  }
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };
  const out: QuadMeshDoc = {
    ...doc, vertices, quads, edgeHandles, ...appendMeshIds(doc, addedVertices.length, addedQuads.length),
  };
  if (quadPaint) out.quadPaint = quadPaint;
  if (quadTex) out.quadTex = quadTex;
  if (quadOrient) out.quadOrient = quadOrient;
  if (quadLocked) out.quadLocked = quadLocked;
  if (quadLabels) out.quadLabels = quadLabels;
  return { ok: true, doc: out, quads: addedQuads, vertices: addedVertices, outerEdges };
}

function applyPlannedPatchExtrusion(doc: QuadMeshDoc, plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement): EdgeExtrusionResult {
  if (!plan.topQuads?.length) return { ok: false, error: 'The staged patch extrusion has no top region.' };
  const segments = edgeExtrusionSegmentCount(doc, plan, placement);
  const selected = new Set(plan.topQuads.map(top => top.sourceQuad));
  const vertices = doc.vertices.slice();
  const quads: (number[] | null)[] = doc.quads.map((quad, id) => selected.has(id) ? null : quad.slice());
  const edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}), ...plan.pinnedHandles };
  const surfaceMaps = createQuadSurfaceMaps(doc, true);
  const { quadPaint, quadTex, quadOrient, quadLocked, quadLabels } = surfaceMaps;
  const quadTwist = doc.quadTwist ? { ...doc.quadTwist } : undefined;
  const firstAddedVertex = vertices.length / 3;
  const rings = appendExtrusionRings(doc, plan, placement, vertices, segments);
  writeRingEdgeHandles(plan, placement, rings, segments, edgeHandles);
  writeCrossHandles(doc, plan, placement, rings, segments, edgeHandles);
  const fresh = new Map(plan.vertices.map(source => [source, rings.get(source)![segments]]));

  const inherit = (target: number, source: number) => inheritQuadSurface(doc, surfaceMaps, source, target);
  const wallRawIds: number[] = [], outerRawEdges: [number, number][] = [];
  for (const edge of plan.edges) {
    const fromRings = rings.get(edge.from)!, toRings = rings.get(edge.to)!;
    for (let segment = 1; segment <= segments; segment++) {
      const id = quads.length;
      // Each band traverses its inner ring forward and outer ring backward.
      quads.push([fromRings[segment - 1], toRings[segment - 1], fromRings[segment], toRings[segment]]);
      wallRawIds.push(id);
      if (edge.sourceQuad !== null) inherit(id, edge.sourceQuad);
      if (quadLabels) delete quadLabels[id];
    }
    const na = fromRings[segments], nb = toRings[segments];
    outerRawEdges.push([na, nb]);
  }
  const topRawIds: number[] = [];
  for (const top of plan.topQuads) {
    const id = quads.length;
    quads.push(top.corners.map(vertex => fresh.get(vertex)!)); topRawIds.push(id);
    inherit(id, top.sourceQuad);
    const topTwist = placement.twists?.[top.sourceQuad] ?? doc.quadTwist?.[top.sourceQuad];
    if (quadTwist && doc.quadTwist?.[top.sourceQuad] !== undefined && topTwist)
      quadTwist[id] = topTwist.map(v => [...v] as V3) as [V3, V3, V3, V3];
  }
  const guard = checkManifold(quads.filter((quad): quad is number[] => quad !== null));
  if (!guard.ok) return { ok: false, error: guard.error! };

  const { doc: out, ...identity } = finishMeshRewrite(doc, {
    vertices, quads, freeEdges: doc.freeEdges, tJunctions: doc.tJunctions, edgeHandles,
    quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels,
    keepVertices: looseVertexIds(doc),
  });
  // The staged rim and the points the extrusion created are stated in its own numbering; each is found again
  // by the name it carries.
  const at = (raw: number) => locateVertex(identity, raw);
  // Appended walls/tops remain after every surviving old patch, in their append order.
  const firstAdded = doc.quads.length - selected.size;
  const wallQuads = wallRawIds.map((_, index) => firstAdded + index);
  const topQuads = topRawIds.map((_, index) => firstAdded + wallRawIds.length + index);
  const outerEdges = outerRawEdges.map(([a, b]) => {
    const na = at(a)!, nb = at(b)!;
    return na < nb ? [na, nb] as [number, number] : [nb, na] as [number, number];
  });
  const addedVertices: number[] = [];
  for (let raw = firstAddedVertex; raw < vertices.length / 3; raw++) {
    const mapped = at(raw);
    if (mapped !== undefined) addedVertices.push(mapped);
  }
  return { ok: true, doc: out, quads: [...wallQuads, ...topQuads], vertices: addedVertices, outerEdges, topQuads };
}
