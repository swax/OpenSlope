import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendMeshIds } from '../../doc/ids';
import { add, cross, mul, norm, sub, dot, len } from '../../math/vec';
import { buildQuadMesh, meshEdgeHandles, meshAdjacency } from '../topology';
import { ekey, checkManifold } from './contract';
import { quadPerimeterEdges, readVertex } from '../primitives';

/**
 * Topology born from nothing: append a free-standing patch, an open elliptical tube, a corner-clicked
 * triangle / quad, or a free construction edge to the doc. Every op here only appends — existing indices, ids
 * and sparse maps stay untouched, and the new geometry is minted fresh ids — and reused surface vertices pin
 * their outgoing tangents first, so joining new topology never reshapes what already exists.
 */

/** Side length of a newly placed free-standing patch. */
export const DEFAULT_STANDALONE_PATCH_SIZE_M = 30;

/** Defaults for the mesh-native tube creator. Diameters describe its cross-section, section length subdivides
 * the drawn axis, and ring edges sets the number of patch columns around the tube. */
export const DEFAULT_TUBE_WIDTH_M = 20;
export const DEFAULT_TUBE_HEIGHT_M = 20;
export const DEFAULT_TUBE_SECTION_M = 10;
export const DEFAULT_TUBE_RING_EDGES = 4;

export type AppendTubeResult =
  | { ok: true; doc: QuadMeshDoc; quads: number[]; vertices: number[]; axialSections: number; radialSections: number }
  | { ok: false; error: string };

/** Append an open elliptical quad tube between two authored-space endpoints. Rings include both endpoints and
 * share their vertices around the seam. The height axis is world-up projected onto the tube cross-section;
 * near a vertical axis it falls back to world Z so the frame remains stable. The caller explicitly controls
 * the ring edge count; four keeps vertices on both width and height extrema and is the default. */
export function appendTube(
  doc: QuadMeshDoc,
  start: V3,
  end: V3,
  widthDiameter = DEFAULT_TUBE_WIDTH_M,
  heightDiameter = DEFAULT_TUBE_HEIGHT_M,
  sectionLength = DEFAULT_TUBE_SECTION_M,
  ringEdges = DEFAULT_TUBE_RING_EDGES,
): AppendTubeResult {
  if (![...start, ...end, widthDiameter, heightDiameter, sectionLength, ringEdges].every(Number.isFinite))
    return { ok: false, error: 'Tube endpoints and dimensions must be finite numbers.' };
  const axisDelta = sub(end, start), length = len(axisDelta);
  if (length < 1e-3) return { ok: false, error: 'Draw two different endpoints to give the tube a length.' };
  if (widthDiameter <= 0 || heightDiameter <= 0)
    return { ok: false, error: 'Tube width and height diameters must be greater than zero.' };
  if (sectionLength <= 0) return { ok: false, error: 'Tube section length must be greater than zero.' };
  if (!Number.isInteger(ringEdges) || ringEdges < 3 || ringEdges > 256)
    return { ok: false, error: 'Tube ring edges must be a whole number from 3 to 256.' };

  const axis = mul(axisDelta, 1 / length);
  const upSeed: V3 = Math.abs(dot(axis, [0, 1, 0])) < 0.98 ? [0, 1, 0] : [0, 0, 1];
  const heightAxis = norm(sub(upSeed, mul(axis, dot(upSeed, axis))));
  const widthAxis = norm(cross(axis, heightAxis));
  const rw = widthDiameter * 0.5, rh = heightDiameter * 0.5;
  const axialSections = Math.max(1, Math.ceil(length / sectionLength));
  const radialSections = ringEdges;
  const patchCount = axialSections * radialSections;
  if (patchCount > 50_000)
    return { ok: false, error: 'That section length would create more than 50,000 tube patches. Increase it.' };

  const firstVertex = doc.vertices.length / 3;
  const vertices = doc.vertices.slice();
  const addedVertices: number[] = [];
  const ringVertex = (ring: number, side: number) => firstVertex + ring * radialSections + (side % radialSections);
  for (let ring = 0; ring <= axialSections; ring++) {
    const center = add(start, mul(axisDelta, ring / axialSections));
    for (let side = 0; side < radialSections; side++) {
      const angle = side / radialSections * Math.PI * 2;
      const point = add(center, add(mul(widthAxis, Math.cos(angle) * rw), mul(heightAxis, Math.sin(angle) * rh)));
      addedVertices.push(vertices.length / 3);
      vertices.push(...point);
    }
  }
  const firstQuad = doc.quads.length;
  const quads = doc.quads.map(quad => quad.slice());
  const addedQuads: number[] = [];
  for (let ring = 0; ring < axialSections; ring++) for (let side = 0; side < radialSections; side++) {
    const next = (side + 1) % radialSections;
    quads.push([
      ringVertex(ring, side), ringVertex(ring, next),
      ringVertex(ring + 1, side), ringVertex(ring + 1, next),
    ]);
    addedQuads.push(firstQuad + addedQuads.length);
  }
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };
  return {
    ok: true,
    doc: { ...doc, vertices, quads, ...appendMeshIds(doc, addedVertices.length, addedQuads.length) },
    quads: addedQuads, vertices: addedVertices,
    axialSections, radialSections,
  };
}

/** Four corners for a square, free-standing patch centred at `center` and tangent to `normal`. The ordering is
 *  the document's [A,B,C,D] layout: C-A is its U axis, B-A its V axis, and UxV points opposite the visible
 *  normal (the preview's (A,D,C)/(A,B,D) winding turns that into the outward face). The projected world-X seed
 *  keeps a placed patch's frame stable as the cursor moves; a near-X-facing wall falls back to world Z. */
export function standalonePatchCorners(center: V3, normal: V3, size: number): [V3, V3, V3, V3] {
  const n = norm(normal);
  const seed: V3 = Math.abs(dot(n, [1, 0, 0])) < 0.95 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(sub(seed, mul(n, dot(seed, n))));
  const v = norm(cross(u, n));
  const h = Math.max(1e-3, Number.isFinite(size) ? Math.abs(size) * 0.5 : 0.5);
  const corner = (su: number, sv: number): V3 => add(center, add(mul(u, su * h), mul(v, sv * h)));
  return [corner(-1, -1), corner(-1, 1), corner(1, -1), corner(1, 1)];
}

/** Append one disconnected quad to the document. Existing indices, ids and every sparse map stay
 *  untouched; the new cell inherits `baseSurface` because it intentionally carries no per-quad overrides. */
export function appendStandalonePatch(doc: QuadMeshDoc, center: V3, normal: V3, size = DEFAULT_STANDALONE_PATCH_SIZE_M):
  { doc: QuadMeshDoc; quad: number; vertices: [number, number, number, number] } {
  const corners = standalonePatchCorners(center, normal, size);
  const firstVertex = doc.vertices.length / 3;
  const vertices: [number, number, number, number] = [firstVertex, firstVertex + 1, firstVertex + 2, firstVertex + 3];
  const quad = doc.quads.length;
  return {
    doc: {
      ...doc, vertices: [...doc.vertices, ...corners.flat()], quads: [...doc.quads, vertices],
      ...appendMeshIds(doc, 4, 1),
    },
    quad,
    vertices,
  };
}

/** One endpoint for a newly authored free edge: reuse an existing mesh vertex by id, or append a new point. */
export type FreeEdgeEndpoint = number | V3;
export type FreeEdgeContact = { pos: V3; edge: [number, number]; t: number };

export type AppendFreeEdgeResult =
  | { ok: true; doc: QuadMeshDoc; edge: [number, number]; appendedVertices: number[] }
  | { ok: false; error: string };

export type AppendPatchResult =
  | { ok: true; doc: QuadMeshDoc; quad: number; vertices: number[] }
  | { ok: false; error: string };

export type PatchCorners =
  | readonly [FreeEdgeEndpoint, FreeEdgeEndpoint, FreeEdgeEndpoint]
  | readonly [FreeEdgeEndpoint, FreeEdgeEndpoint, FreeEdgeEndpoint, FreeEdgeEndpoint];

/** Append a triangle or quad from perimeter-ordered clicks. Each click can reuse a live mesh vertex or supply
 * a new point. Triangles use the document's valid wedge encoding [A,B,C,C]; quads store [A,B,D,C], whose
 * perimeter is A-B-C-D. Free edges around the new face are consumed and existing surface tangents at reused
 * vertices are pinned before their valence changes. */
export function appendPatchFromCorners(
  doc: QuadMeshDoc,
  corners: PatchCorners,
): AppendPatchResult {
  const sides = corners.length;
  const count = doc.vertices.length / 3;
  const validId = (v: number) => Number.isInteger(v) && v >= 0 && v < count;
  const finitePoint = (p: V3) => p.length === 3 && p.every(Number.isFinite);
  if (corners.some(c => typeof c === 'number' ? !validId(c) : !finitePoint(c)))
    return { ok: false, error: `One of the patch corners is stale or invalid — place the ${sides} corners again.` };

  let next = count;
  const ids = corners.map(c => typeof c === 'number' ? c : next++);
  const point = (corner: FreeEdgeEndpoint, id: number): V3 => typeof corner === 'number'
    ? readVertex(doc.vertices, id)
    : corner;
  const positions = corners.map((corner, i) => point(corner, ids[i]));
  for (let i = 0; i < sides; i++) for (let j = i + 1; j < sides; j++) {
    if (ids[i] === ids[j] || Math.hypot(
      positions[i][0] - positions[j][0], positions[i][1] - positions[j][1], positions[i][2] - positions[j][2],
    ) < 1e-6) return { ok: false, error: `A ${sides === 3 ? 'triangle' : 'quad'} needs ${sides} different corner points.` };
  }

  const clickedEdges = ids.map((id, i) => [id, ids[(i + 1) % sides]] as [number, number]);
  const edgeUse = new Map<string, number>(), edgeDirection = new Map<string, [number, number]>();
  for (const q of doc.quads) for (const [a, b] of quadPerimeterEdges(q)) {
    if (a === b) continue;
    const key = ekey(a, b);
    edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    if (!edgeDirection.has(key)) edgeDirection.set(key, [a, b]);
  }
  if (clickedEdges.some(([a, b]) => (edgeUse.get(ekey(a, b)) ?? 0) >= 2))
    return { ok: false, error: 'That patch would put a third surface on an interior edge.' };
  const idSet = new Set(ids);
  if (doc.quads.some(q => new Set(q).size === sides && q.every(id => idSet.has(id))))
    return { ok: false, error: `Those ${sides} vertices already bound a patch.` };

  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  const beforeMesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const beforeAdj = meshAdjacency(beforeMesh), beforeHandle = meshEdgeHandles(beforeMesh, doc.edgeHandles);
  for (let i = 0; i < sides; i++) {
    if (typeof corners[i] !== 'number') continue;
    for (const neighbor of beforeAdj.neighbors[ids[i]] ?? []) {
      const h = beforeHandle(ids[i], neighbor);
      edgeHandles[`${ids[i]}>${neighbor}`] = [h[0], h[1], h[2]];
    }
  }

  const vertices = [...doc.vertices];
  corners.forEach(corner => { if (typeof corner !== 'number') vertices.push(...corner); });
  // A connected face must traverse every shared seam opposite its neighbor. If the authored click order runs
  // the same way as an existing boundary, reverse the whole perimeter (keeping click 0 as the stable anchor).
  // Several connected neighbors must agree on that one global choice; otherwise their own orientations conflict.
  const reverseConstraints = new Set<boolean>();
  for (const [a, b] of clickedEdges) {
    const existing = edgeDirection.get(ekey(a, b));
    if (existing) reverseConstraints.add(existing[0] === a && existing[1] === b);
  }
  if (reverseConstraints.size > 1)
    return { ok: false, error: 'The connected patch boundaries have conflicting normal directions.' };
  const perimeter = reverseConstraints.has(true) ? [ids[0], ...ids.slice(1).reverse()] : ids;
  const quadCorners = sides === 3
    ? [perimeter[0], perimeter[1], perimeter[2], perimeter[2]]
    : [perimeter[0], perimeter[1], perimeter[3], perimeter[2]];
  const quads = [...doc.quads, quadCorners];
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };
  const consumed = new Set(clickedEdges.map(([a, b]) => ekey(a, b)));
  const freeEdges = (doc.freeEdges ?? []).filter(([a, b]) => !consumed.has(ekey(a, b)));
  const out: QuadMeshDoc = {
    ...doc, vertices, quads, edgeHandles,
    ...appendMeshIds(doc, (vertices.length - doc.vertices.length) / 3, 1),
  };
  if (freeEdges.length) out.freeEdges = freeEdges; else delete out.freeEdges;
  return { ok: true, doc: out, quad: doc.quads.length, vertices: ids };
}

/**
 * Append one ordinary control-net edge not owned by a surface. The endpoint inputs may reuse existing vertices or
 * create new ones, which lets the viewport snap a drawn chain onto the mesh without duplicating the snapped point.
 * Existing surface/free edges are refused: the document stores one topological edge between a vertex pair.
 */
export function appendFreeEdge(
  doc: QuadMeshDoc, from: FreeEdgeEndpoint | FreeEdgeContact, to: FreeEdgeEndpoint | FreeEdgeContact,
): AppendFreeEdgeResult {
  const count = doc.vertices.length / 3;
  const contact = (endpoint: FreeEdgeEndpoint | FreeEdgeContact): FreeEdgeContact | null =>
    typeof endpoint === 'object' && !Array.isArray(endpoint) ? endpoint : null;
  const rawPoint = (endpoint: FreeEdgeEndpoint | FreeEdgeContact): V3 | null =>
    typeof endpoint === 'number' ? null : contact(endpoint)?.pos ?? endpoint as V3;
  const validId = (v: number) => Number.isInteger(v) && v >= 0 && v < count;
  if ((typeof from === 'number' && !validId(from)) || (typeof to === 'number' && !validId(to)))
    return { ok: false, error: 'The snapped endpoint is stale — pick the edge endpoints again.' };
  const finitePoint = (p: V3) => p.length === 3 && p.every(Number.isFinite);
  if ((typeof from !== 'number' && !finitePoint(rawPoint(from)!)) || (typeof to !== 'number' && !finitePoint(rawPoint(to)!)))
    return { ok: false, error: 'An edge endpoint is not a finite 3D point.' };
  for (const endpoint of [from, to]) {
    const hit = contact(endpoint);
    if (!hit) continue;
    const [x, y] = hit.edge;
    if (!validId(x) || !validId(y) || x === y || !Number.isFinite(hit.t) || hit.t <= 1e-3 || hit.t >= 1 - 1e-3)
      return { ok: false, error: 'An embedded edge endpoint is stale — pick it again.' };
  }

  const firstNew = count;
  const a = typeof from === 'number' ? from : firstNew;
  const b = typeof to === 'number' ? to : firstNew + (typeof from === 'number' ? 0 : 1);
  if (a === b) return { ok: false, error: 'An edge needs two different endpoints.' };
  const point = (endpoint: FreeEdgeEndpoint | FreeEdgeContact, id: number): V3 => typeof endpoint === 'number'
    ? readVertex(doc.vertices, id)
    : rawPoint(endpoint)!;
  const pa = point(from, a), pb = point(to, b);
  if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) < 1e-6)
    return { ok: false, error: 'An edge needs two different endpoint positions.' };

  const key = ekey(a, b);
  const exists = (doc.freeEdges ?? []).some(([x, y]) => ekey(x, y) === key)
    || doc.quads.some(q => quadPerimeterEdges(q)
      .some(([x, y]) => x !== y && ekey(x, y) === key));
  if (exists) return { ok: false, error: 'Those vertices already share an edge.' };

  const appendedVertices: number[] = [];
  const vertices = [...doc.vertices];
  if (typeof from !== 'number') { vertices.push(...rawPoint(from)!); appendedVertices.push(a); }
  if (typeof to !== 'number') { vertices.push(...rawPoint(to)!); appendedVertices.push(b); }
  const edge: [number, number] = a < b ? [a, b] : [b, a];
  // A new neighbour changes automatic Bessel classification at a reused vertex. If that vertex already belongs
  // to the surface, materialize its current outgoing handles first so snapping on a construction edge cannot warp
  // any existing patch boundary. A free-only chain remains automatic, allowing its joined segments to smooth.
  const edgeHandles = { ...(doc.edgeHandles ?? {}) };
  const beforeMesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const beforeAdj = meshAdjacency(beforeMesh), beforeHandle = meshEdgeHandles(beforeMesh, doc.edgeHandles);
  for (const id of [typeof from === 'number' ? from : null, typeof to === 'number' ? to : null]) {
    if (id === null) continue;
    const surfaceVertex = (beforeAdj.neighbors[id] ?? []).some(n => (beforeAdj.edgeQuads.get(ekey(id, n))?.length ?? 0) > 0);
    if (!surfaceVertex) continue;
    for (const n of beforeAdj.neighbors[id] ?? []) {
      const h = beforeHandle(id, n);
      edgeHandles[`${id}>${n}`] = [h[0], h[1], h[2]];
    }
  }
  const tJunctions = [...(doc.tJunctions ?? [])];
  const seenTJunctions = new Set(tJunctions.map(node => `${node.vertex}:${ekey(node.edge[0], node.edge[1])}`));
  for (const [endpoint, vertex] of [[from, a], [to, b]] as const) {
    const hit = contact(endpoint);
    if (!hit || !(beforeAdj.neighbors[hit.edge[0]] ?? []).includes(hit.edge[1])) continue;
    const key = `${vertex}:${ekey(hit.edge[0], hit.edge[1])}`;
    if (!seenTJunctions.has(key)) {
      seenTJunctions.add(key); tJunctions.push({ vertex, edge: [...hit.edge], t: hit.t });
    }
  }
  return {
    ok: true,
    doc: {
      ...doc,
      vertices,
      ...appendMeshIds(doc, appendedVertices.length, 0),
      freeEdges: [...(doc.freeEdges ?? []), edge],
      tJunctions,
      ...(Object.keys(edgeHandles).length ? { edgeHandles } : {}),
    },
    edge,
    appendedVertices,
  };
}
