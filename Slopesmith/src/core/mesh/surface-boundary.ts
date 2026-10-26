import type { QuadMeshDoc, V3 } from '../doc/types';
import { blankMountain } from '../doc/mountain';
import { appendMeshIds } from '../doc/ids';
import { add, cross, len, mul, sub } from '../math/vec';
import { cubicPolyline } from '../math/bezier';
import { SpatialHash3D } from '../math/spatial-hash';
import { meshFromDoc } from './topology';
import { readVertex, undirectedEdgeKey } from './primitives';
import { boundarySurfaceCharts, createSurfaceFromBoundary, type SurfaceResult } from './surface-object';
import {
  addSurfaceStitch,
  meshBoundaryChain,
  selectedSurfaceBoundary,
  orientStitchTarget,
  automaticStitchFacesOppose,
} from './surface-stitch';
import type { SurfaceSide, SurfaceStitch } from '../doc/types';
import { surfaceSideControls } from './surface-stitch-controls';
import { inferSurfaceCorners, validateSurfaceCorners } from './surface-corners';

export type SurfaceBoundaryPoint = { pos: V3; vertex: number | null };
export type SurfaceBoundaryStyle = 'smooth' | 'creased';
const EPS = 1e-6;
export const MAX_SURFACE_BOUNDARY_POINTS = 128;
const sources = new WeakMap<
  QuadMeshDoc,
  { edge: (from: number, to: number) => [number, number] | undefined; geometry: ReturnType<typeof meshFromDoc> }
>();

function sourceGeometry(doc: QuadMeshDoc) {
  let source = sources.get(doc);
  if (!source) {
    const edges = new Set(doc.freeEdges?.map(([a, b]) => undirectedEdgeKey(a, b)));
    for (const [a, b, c, d] of doc.quads)
      for (const [x, y] of [
        [a, b],
        [b, d],
        [d, c],
        [c, a],
      ])
        edges.add(undirectedEdgeKey(x, y));
    const grid = new SpatialHash3D<number>(EPS),
      aliases = new Map<number, number[]>();
    for (let i = 0; i < doc.vertexIds.length; i++) grid.insertPoint(readVertex(doc.vertices, i), i);
    const coincident = (v: number) => {
      if (!aliases.has(v)) {
        const p = readVertex(doc.vertices, v);
        aliases.set(
          v,
          grid.queryPointNeighborhood(p).filter(i => len(sub(readVertex(doc.vertices, i), p)) < EPS),
        );
      }
      return aliases.get(v)!;
    };
    source = {
      geometry: meshFromDoc(doc),
      edge: (from, to) => {
        if (edges.has(undirectedEdgeKey(from, to))) return [from, to];
        // A stitched corner has separate authoring and terrain identities. Either pick must copy
        // the same existing cubic when the next edge belongs to the other authoring cage.
        for (const a of coincident(from))
          for (const b of coincident(to)) if (a !== b && edges.has(undirectedEdgeKey(a, b))) return [a, b];
      },
    };
    sources.set(doc, source);
  }
  return source;
}

function segmentHandles(doc: QuadMeshDoc, from: SurfaceBoundaryPoint, to: SurfaceBoundaryPoint): [V3, V3] {
  const ab = mul(sub(to.pos, from.pos), 1 / 3);
  if (from.vertex === null || to.vertex === null) return [ab, mul(ab, -1)];
  const source = sourceGeometry(doc);
  const edge = source.edge(from.vertex, to.vertex);
  return edge
    ? [source.geometry.edgeHandle(edge[0], edge[1]), source.geometry.edgeHandle(edge[1], edge[0])]
    : [ab, mul(ab, -1)];
}

/** The same boundary cubic the draft will use, including an existing curved edge copied by snapping. */
export function surfaceBoundarySegmentLength(doc: QuadMeshDoc, from: SurfaceBoundaryPoint, to: SurfaceBoundaryPoint) {
  if (from.vertex === null || to.vertex === null) return len(sub(to.pos, from.pos));
  const [ab, ba] = segmentHandles(doc, from, to),
    samples = cubicPolyline(from.pos, add(from.pos, ab), add(to.pos, ba), to.pos, 64);
  return samples.slice(1).reduce((length, p, i) => length + len(sub(p, samples[i])), 0);
}

function validate(points: readonly SurfaceBoundaryPoint[]) {
  if (points.length < 4) throw new Error('Place at least four boundary points, then close the loop or press Enter.');
  if (points.length > MAX_SURFACE_BOUNDARY_POINTS) throw new Error('A surface boundary can have at most 128 points.');
  if (points.some(p => p.pos.length !== 3 || p.pos.some(n => !Number.isFinite(n))))
    throw new Error('Use finite boundary points.');
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      if (len(sub(points[i].pos, points[j].pos)) < EPS)
        throw new Error('Keep the boundary points distinct. Click the first point to close the loop.');
  const origin = points[0].pos;
  let normal: V3 = [0, 0, 0];
  for (let i = 0; i < points.length; i++)
    normal = add(normal, cross(sub(points[i].pos, origin), sub(points[(i + 1) % points.length].pos, origin)));
  if (len(normal) < EPS) throw new Error('The boundary needs to enclose a surface.');
  const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))),
    axes = [0, 1, 2].filter(axis => axis !== drop),
    flat = points.map(p => axes.map(axis => p.pos[axis]));
  const orient = (a: number[], b: number[], c: number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < flat.length; i++)
    for (let j = i + 1; j < flat.length; j++) {
      if (j === i + 1 || (i === 0 && j === flat.length - 1)) continue;
      const a = flat[i],
        b = flat[(i + 1) % flat.length],
        c = flat[j],
        d = flat[(j + 1) % flat.length];
      const overlaps = [0, 1].every(
        axis =>
          Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) <=
          Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) + EPS,
      );
      if (overlaps && orient(a, b, c) * orient(a, b, d) <= 0 && orient(c, d, a) * orient(c, d, b) <= 0)
        throw new Error('The boundary crosses itself. Undo the last point and draw around the perimeter.');
    }
}

/** Extra clicks remain editable points along the four inferred sides. */
export function surfaceBoundaryCorners(points: readonly SurfaceBoundaryPoint[], doc?: QuadMeshDoc | null) {
  if (doc && points.length >= 4 && points.some(p => p.vertex !== null)) {
    const source = sourceGeometry(doc);
    const copied = points.map((p, i) => {
      const next = points[(i + 1) % points.length];
      return p.vertex !== null && next.vertex !== null && !!source.edge(p.vertex, next.vertex);
    });
    const ends = points.flatMap((_, i) => (copied[i] !== copied[(i + points.length - 1) % points.length] ? [i] : []));
    // Two snapped runs and their connecting spans already define four sides. A geometric line fit
    // can put a corner inside a bending trail, forcing one host across two adjacent stitch bands.
    if (ends.length === 4) return ends;
  }
  return inferSurfaceCorners(points.map(p => p.pos));
}

/** A small isolated sketch. Styles affect new edges along each side; copied host edges keep their cubics. */
export function surfaceBoundaryDraft(
  doc: QuadMeshDoc,
  points: readonly SurfaceBoundaryPoint[],
  corners?: readonly number[],
  style: SurfaceBoundaryStyle = 'creased',
) {
  validate(points);
  const boundary = blankMountain('Surface boundary');
  boundary.vertices = points.flatMap(p => p.pos);
  Object.assign(boundary, appendMeshIds(boundary, points.length, 0));
  boundary.freeEdges = points.map((_, i) => [i, (i + 1) % points.length]);
  boundary.edgeHandles = {};
  points.forEach(p => {
    if (p.vertex !== null && (!doc.vertexIds[p.vertex] || len(sub(readVertex(doc.vertices, p.vertex), p.pos)) > EPS))
      throw new Error('A snapped point changed. Cancel and start the surface again.');
  });
  for (const [a, b] of boundary.freeEdges) {
    const [ab, ba] = segmentHandles(doc, points[a], points[b]);
    boundary.edgeHandles[`${a}>${b}`] = [...ab];
    boundary.edgeHandles[`${b}>${a}`] = [...ba];
  }
  const stops = validateSurfaceCorners(points.length, corners ?? surfaceBoundaryCorners(points, doc));
  if (style === 'smooth') {
    const copied = new Set(
      boundary.freeEdges
        .filter(
          ([a, b]) =>
            points[a].vertex !== null &&
            points[b].vertex !== null &&
            sourceGeometry(doc).edge(points[a].vertex!, points[b].vertex!),
        )
        .map(([a, b]) => undirectedEdgeKey(a, b)),
    );
    stops.forEach((start, side) => {
      const count = (stops[(side + 1) % 4] - start + points.length) % points.length;
      const path = Array.from({ length: count + 1 }, (_, i) => (start + i) % points.length);
      path.forEach((at, i) => {
        const before = path[Math.max(0, i - 1)],
          after = path[Math.min(path.length - 1, i + 1)];
        const tangent =
          i > 0 && copied.has(undirectedEdgeKey(at, before))
            ? mul(boundary.edgeHandles![`${at}>${before}`], -3)
            : i < path.length - 1 && copied.has(undirectedEdgeKey(at, after))
              ? mul(boundary.edgeHandles![`${at}>${after}`], 3)
              : mul(sub(points[after].pos, points[before].pos), 1 / (Number(i > 0) + Number(i < path.length - 1)));
        for (const [to, scale] of [
          [before, -1 / 3],
          [after, 1 / 3],
        ]) {
          if (to === at || copied.has(undirectedEdgeKey(at, to))) continue;
          boundary.edgeHandles![`${at}>${to}`] = mul(tangent, scale);
        }
      });
    });
  }
  const outline = boundary.freeEdges.flatMap(([a, b]) =>
    cubicPolyline(
      points[a].pos,
      add(points[a].pos, boundary.edgeHandles![`${a}>${b}`]),
      add(points[b].pos, boundary.edgeHandles![`${b}>${a}`]),
      points[b].pos,
      12,
    ).slice(0, -1),
  );
  outline.push(points[0].pos);
  return { boundary, corners: stops, outline, charts: boundarySurfaceCharts(boundary, boundary.freeEdges, stops) };
}

/** Install the sketch and its live Surface together as one document edit. Existing geometry is unchanged. */
export function createSurfaceFromDrawnBoundary(
  doc: QuadMeshDoc,
  points: readonly SurfaceBoundaryPoint[],
  patchSizeM = 25,
  corners?: readonly number[],
  style: SurfaceBoundaryStyle = 'creased',
): SurfaceResult {
  try {
    // A point placed exactly on an existing boundary is a contact even when the viewport did not
    // retain a snap id (for example after grid snapping). Prefer visible Surface controls over output.
    const controls = new Set(doc.surfaces?.flatMap(s => s.controls.flat())),
      generated = new Set(doc.surfaces?.flatMap(s => s.patches.map(p => p.quad))),
      ordinary = new Set(doc.quads.flatMap((q, i) => (generated.has(doc.quadIds[i]) ? [] : q))),
      candidates = doc.vertexIds.flatMap((id, i) => (controls.has(id) ? [i] : []));
    candidates.push(...ordinary);
    points = points.map(point => {
      if (point.vertex !== null) return point;
      const vertex = candidates.find(i => len(sub(readVertex(doc.vertices, i), point.pos)) < EPS);
      return vertex === undefined ? point : { vertex, pos: readVertex(doc.vertices, vertex) };
    });
    const draft = surfaceBoundaryDraft(doc, points, corners, style),
      start = doc.vertexIds.length;
    const out: QuadMeshDoc = {
      ...doc,
      ...appendMeshIds(doc, points.length, 0),
      vertices: [...doc.vertices, ...draft.boundary.vertices],
      freeEdges: [
        ...(doc.freeEdges ?? []),
        ...draft.boundary.freeEdges!.map(([a, b]) => [start + a, start + b] as [number, number]),
      ],
      edgeHandles: { ...doc.edgeHandles },
    };
    for (const [key, offset] of Object.entries(draft.boundary.edgeHandles!)) {
      const [a, b] = key.split('>').map(Number);
      out.edgeHandles![`${start + a}>${start + b}`] = offset;
    }
    const result = createSurfaceFromBoundary(
      out,
      draft.boundary.freeEdges!.map(([a, b]) => [start + a, start + b]),
      draft.corners.map(i => start + i),
      patchSizeM,
    );
    if (!result.ok) return result;
    const contacts = new Map<string, string>();
    for (const id of new Set(result.surface.controls.flat())) {
      const p = readVertex(result.doc.vertices, result.doc.vertexIds.indexOf(id)),
        contact = points.find(v => v.vertex !== null && len(sub(v.pos, p)) < EPS);
      if (contact?.vertex !== undefined && contact.vertex !== null) contacts.set(id, doc.vertexIds[contact.vertex]);
    }
    const stitched = attachSurfaceContacts(result.doc, result.surface.id, contacts, doc);
    return { ok: true, doc: stitched, surface: stitched.surfaces!.find(s => s.id === result.surface.id)! };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Explicitly complete missing contacts on an existing object. Detach never invokes discovery. */
export function stitchTouchingSurfaceBoundaries(doc: QuadMeshDoc, id: string): QuadMeshDoc {
  const source = doc.surfaces?.find(s => s.id === id);
  if (!source) throw new Error('Select an editable surface first.');
  const candidates = new Set<number>();
  for (const target of doc.surfaces ?? []) {
    if (target.id === id) continue;
    for (const side of ['u0', 'u1', 'v0', 'v1'] as const)
      for (const p of surfaceSideControls(doc, target, side)) candidates.add(p.vertex);
  }
  const own = new Set(source.patches.map(p => p.quad));
  doc.quads.forEach((q, i) => {
    if (!own.has(doc.quadIds[i])) q.forEach(v => candidates.add(v));
  });
  const contacts = new Map<string, string>();
  for (const name of new Set(source.controls.flat())) {
    const p = readVertex(doc.vertices, doc.vertexIds.indexOf(name)),
      target = [...candidates].find(v => len(sub(readVertex(doc.vertices, v), p)) < EPS);
    if (target !== undefined) contacts.set(name, doc.vertexIds[target]);
  }
  return attachSurfaceContacts(doc, id, contacts, doc);
}

function attachSurfaceContacts(
  doc: QuadMeshDoc,
  id: string,
  contacts: Map<string, string>,
  hosts: QuadMeshDoc,
): QuadMeshDoc {
  let stitched = doc;
  const source = doc.surfaces!.find(s => s.id === id)!;
  // A snapped run names the original host, rather than merely copying its current curve shape.
  for (let g = 0; g < (source.guides?.length ?? 0); g++) {
    const guide = source.guides![g];
    if (guide.at !== 0 && guide.at !== 1) continue;
    const names = source.controls[g];
    const snapped = names.map(id => contacts.get(id));
    const side = `${guide.axis === 'U' ? 'v' : 'u'}${guide.at}` as SurfaceSide;
    const occupied = (a: number, b: number) =>
      stitched.surfaces!.some(s =>
        s.stitches?.some(st => {
          const range =
            s.id === id && st.side === side
              ? st.range
              : 'surface' in st.target && st.target.surface === id && st.target.side === side
                ? st.target.range
                : undefined;
          return range && Math.min(b, Math.max(...range)) > Math.max(a, Math.min(...range)) + EPS;
        }),
      );
    let segment = 0;
    while (segment < names.length - 1) {
      if (occupied(guide.knots[segment], guide.knots[segment + 1])) {
        segment++;
        continue;
      }
      const candidates: { end: number; target: SurfaceStitch['target'] }[] = [];
      for (let end = segment + 1; end < names.length; end++) {
        if (
          occupied(guide.knots[segment], guide.knots[end]) ||
          snapped.slice(segment, end + 1).some(v => v === undefined)
        )
          break;
        const chain = snapped.slice(segment, end + 1) as string[];
        const edges = chain.slice(1).map((b, i) => [chain[i], b] as [string, string]);
        const surface = selectedSurfaceBoundary(hosts, edges, id);
        if (surface) candidates.push({ end, target: surface });
        else
          try {
            const resolved = edges.map(([a, b]) => {
              const edge = sourceGeometry(hosts).edge(hosts.vertexIds.indexOf(a), hosts.vertexIds.indexOf(b));
              return edge ? (edge.map(v => hosts.vertexIds[v]) as [string, string]) : ([a, b] as [string, string]);
            });
            candidates.push({ end, target: { vertices: meshBoundaryChain(hosts, resolved) } });
          } catch {
            break;
          }
      }
      const candidate = candidates.at(-1);
      if (!candidate) {
        segment++;
        continue;
      }
      const boundary = {
        surface: source.id,
        side,
        range: [guide.knots[segment], guide.knots[candidate.end]] as [number, number],
      };
      const target = orientStitchTarget(stitched, boundary, candidate.target);
      if (automaticStitchFacesOppose(stitched, boundary, target))
        stitched = addSurfaceStitch(stitched, source.id, boundary, target);
      segment = candidate.end;
    }
  }
  return stitched;
}
