import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendMeshIds } from '../../doc/ids';
import { add, cross, dot, len, lerp, mul, norm, sub } from '../../math/vec';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import { checkManifold, ekey } from './contract';
import { quadPerimeterEdges, readVertex } from '../primitives';

/**
 * Create Grid: a flat lattice of patches between four corners A, B, C, D, run in that order round the rim. The
 * tool takes three clicks — both ends of the first side A → B, then a point setting the width — and squares a
 * free third point off against the first side, so the draft starts as a rectangle in the plane the clicks span
 * (gridCornersFromClicks). Its free corners can then be moved one at a time, which bends the lattice
 * bilinearly, and a draft with no snapped corner can be moved, turned and scaled whole. One drawn off an edge —
 * a single side snapped, its far side free — swings on that side like a hinge instead (gridHinge).
 *
 * The divisions come either as counts, or from one target patch size: each side takes the count that brings its
 * patches closest to that size (gridDivisionsForSize).
 *
 * Snapped onto existing geometry, the grid ATTACHES rather than overlapping. When its first two corners are
 * points joined by an open run of edges — a patch rim, or free construction edges — that run becomes the side:
 * its vertices are reused, its curves kept, and its edge count sets the columns, so the new patches meet the
 * old ones point for point with no T-junctions. A third corner joined to the second the same way sets the rows.
 * Every row of the lattice is the first side carried across the width, so a curved rim grows a band that
 * follows it. Like every append op, nothing existing moves: reused points pin their outgoing tangents first.
 */

export const DEFAULT_GRID_COLUMNS = 4;
export const DEFAULT_GRID_ROWS = 4;
export const DEFAULT_GRID_PATCH_SIZE_M = 10;
export const MAX_GRID_DIVISIONS = 256;
const MAX_GRID_PATCHES = 50_000;
/** A run of edges stands in for a side only while it runs nearly straight between its ends: no longer than this
 *  multiple of the straight distance. A rim that wanders off — round a corner, or the long way round a hole — is
 *  not the side the user meant, so the grid spans the two points with a new straight side instead. */
const SIDE_CHAIN_DETOUR = 1.3;

/** One corner: a free point, or an existing vertex it is snapped to (and pinned at). */
export type GridCorner = { pos: V3; vertex: number | null };
/** The grid's corners round its rim: A → B is the first side (columns run along it), B → C the second (rows). */
export type GridCorners = readonly [GridCorner, GridCorner, GridCorner, GridCorner];

export type GridOptions = {
  /** Patches along the first side and across the width, unless an attached run of edges sets them. */
  columns: number;
  rows: number;
  /** Divide by a target patch size, metres, instead: each side takes the count nearest that size. */
  patchSize?: number | null;
  /** Where the grid is drawn from (the camera). Its front faces this way unless an attached patch decides. */
  eye?: V3 | null;
};

export type GridPlan = {
  columns: number;
  rows: number;
  /** Whether an attached run of edges set the count (the first side sets columns, the second rows). */
  inheritedColumns: boolean;
  inheritedRows: boolean;
  /** Straight first-side length |B − A| and width |C − B|, metres. */
  length: number;
  width: number;
  /** Average patch size along the first side and across it, metres. */
  cellLength: number;
  cellWidth: number;
  /** (rows + 1) × (columns + 1) lattice points, row-major: row j, column i at j * (columns + 1) + i. */
  points: V3[];
  /** The existing vertex each lattice point reuses, or null for a new one. */
  reuse: (number | null)[];
  /** Lattice-indexed cells in the document's [A,B,C,D] order, wound as the commit will be. */
  quads: [number, number, number, number][];
};

export type GridPlanResult = { ok: true; plan: GridPlan } | { ok: false; error: string };
export type AppendGridResult =
  { ok: true; doc: QuadMeshDoc; quads: number[]; vertices: number[] } | { ok: false; error: string };

const free = (pos: V3): GridCorner => ({ pos: [...pos], vertex: null });

/** The four corners three clicks describe: A and B as clicked; a free third point squared off against A → B, so
 *  the draft is a rectangle, or a snapped one kept where it is; and D completing the parallelogram. */
export function gridCornersFromClicks(first: GridCorner, second: GridCorner, third: GridCorner): GridCorners {
  const along = norm(sub(second.pos, first.pos));
  const reach = sub(third.pos, second.pos);
  const c: GridCorner =
    third.vertex !== null
      ? { pos: [...third.pos], vertex: third.vertex }
      : free(add(second.pos, sub(reach, mul(along, dot(reach, along)))));
  return [
    { pos: [...first.pos], vertex: first.vertex },
    { pos: [...second.pos], vertex: second.vertex },
    c,
    free(add(first.pos, sub(c.pos, second.pos))),
  ];
}

/** The side a draft drawn off an edge swings on: two neighbouring corners snapped to existing points while the
 *  other two are free, as [from, to] round the rim. Null for a free draft, or one pinned any other way. */
export function gridHinge(corners: GridCorners): [number, number] | null {
  const pins = corners.flatMap((corner, i) => (corner.vertex !== null ? [i] : []));
  if (pins.length !== 2) return null;
  const [i, j] = pins;
  return j === i + 1 ? [i, j] : i === 0 && j === 3 ? [3, 0] : null;
}

/** Whether typing a length can move B (with C, its side carried along), or a width C and D. A snapped corner
 *  is pinned where it is attached, so a size that would have to move one is fixed. */
export const gridLengthFixed = (corners: GridCorners) => corners[1].vertex !== null || corners[2].vertex !== null;
export const gridWidthFixed = (corners: GridCorners) => corners[2].vertex !== null || corners[3].vertex !== null;

/** Resize the first side to `length` from A: B and C move together along A → B, so the far side keeps its run. */
export function resizeGridLength(corners: GridCorners, length: number): GridCorners {
  if (gridLengthFixed(corners) || !(Number.isFinite(length) && length > 0)) return corners;
  const [a, b, c, d] = corners,
    shift = sub(add(a.pos, mul(norm(sub(b.pos, a.pos)), length)), b.pos);
  return [a, free(add(b.pos, shift)), free(add(c.pos, shift)), d];
}

/** Resize the width to `width`: C and D move out along their own sides from B and A. */
export function resizeGridWidth(corners: GridCorners, width: number): GridCorners {
  if (gridWidthFixed(corners) || !(Number.isFinite(width) && width > 0)) return corners;
  const [a, b, c, d] = corners;
  return [
    a,
    b,
    free(add(b.pos, mul(norm(sub(c.pos, b.pos)), width))),
    free(add(a.pos, mul(norm(sub(d.pos, a.pos)), width))),
  ];
}

/** The count of patches along a side `length` long whose size comes closest to `size` — never fewer than one. */
export function gridDivisionsForSize(length: number, size: number): number {
  const exact = length / size;
  const low = Math.max(1, Math.floor(exact)),
    high = Math.max(1, Math.ceil(exact));
  const count = Math.abs(length / low - size) <= Math.abs(length / high - size) ? low : high;
  return Math.min(MAX_GRID_DIVISIONS, count);
}

type OpenEdges = {
  /** Neighbours across edges with fewer than two patches: patch rims and free edges. */
  neighbors: Map<number, number[]>;
  /** The one patch's traversal of each rim edge, keyed undirected. */
  rimDirection: Map<string, [number, number]>;
  /** Edges two patches already share. */
  interior: Set<string>;
};

// The planner runs per pointer move while the third corner is placed, so the edge census is taken once per
// document; every mesh op hands back a new document, so the cache turns over with the topology on its own.
const openEdgeCache = new WeakMap<QuadMeshDoc, OpenEdges>();

function openEdges(doc: QuadMeshDoc): OpenEdges {
  const cached = openEdgeCache.get(doc);
  if (cached) return cached;
  const uses = new Map<string, [number, number][]>();
  for (const quad of doc.quads)
    for (const [a, b] of quadPerimeterEdges(quad)) {
      if (a === b) continue;
      const key = ekey(a, b),
        list = uses.get(key);
      if (list) list.push([a, b]);
      else uses.set(key, [[a, b]]);
    }
  const neighbors = new Map<number, number[]>(),
    rimDirection = new Map<string, [number, number]>();
  const interior = new Set<string>();
  const link = (from: number, to: number) => {
    const list = neighbors.get(from);
    if (!list) neighbors.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const [key, list] of uses) {
    if (list.length > 1) {
      interior.add(key);
      continue;
    }
    const [a, b] = list[0];
    rimDirection.set(key, [a, b]);
    link(a, b);
    link(b, a);
  }
  for (const [a, b] of doc.freeEdges ?? [])
    if (a !== b && !uses.has(ekey(a, b))) {
      link(a, b);
      link(b, a);
    }
  const out = { neighbors, rimDirection, interior };
  openEdgeCache.set(doc, out);
  return out;
}

/** The open run of edges joining two points, as its vertices from → to: the shortest one, and only if it runs
 *  nearly straight between them (SIDE_CHAIN_DETOUR). Null when no such run exists. */
export function gridSideChain(doc: QuadMeshDoc, from: number, to: number): number[] | null {
  if (from === to) return null;
  const { neighbors } = openEdges(doc);
  if (!neighbors.has(from) || !neighbors.has(to)) return null;
  const pos = (v: number) => readVertex(doc.vertices, v);
  const budget = len(sub(pos(to), pos(from))) * SIDE_CHAIN_DETOUR + 1e-6;
  const dist = new Map<number, number>([[from, 0]]),
    previous = new Map<number, number>();
  const done = new Set<number>(),
    frontier = [from];
  while (frontier.length) {
    let best = 0;
    for (let i = 1; i < frontier.length; i++) if (dist.get(frontier[i])! < dist.get(frontier[best])!) best = i;
    const v = frontier.splice(best, 1)[0];
    if (done.has(v)) continue;
    done.add(v);
    if (v === to) break;
    const here = pos(v),
      base = dist.get(v)!;
    for (const n of neighbors.get(v) ?? []) {
      if (done.has(n)) continue;
      const d = base + len(sub(pos(n), here));
      if (d > budget || d >= (dist.get(n) ?? Infinity)) continue;
      dist.set(n, d);
      previous.set(n, v);
      frontier.push(n);
    }
  }
  if (!done.has(to)) return null;
  const chain = [to];
  while (chain[chain.length - 1] !== from) chain.push(previous.get(chain[chain.length - 1])!);
  return chain.reverse();
}

function validCount(value: number, what: string): string | null {
  return Number.isInteger(value) && value >= 1 && value <= MAX_GRID_DIVISIONS
    ? null
    : `Grid ${what} must be a whole number from 1 to ${MAX_GRID_DIVISIONS}.`;
}

/** Whether the diagonal p–r splits p, q, r, s into two triangles facing the same way. */
const foldsAcross = (p: V3, q: V3, r: V3, s: V3) => dot(cross(sub(q, p), sub(r, p)), cross(sub(r, p), sub(s, p))) <= 0;

/** Lay out the grid four corners describe, without touching the document: its lattice, which points it reuses,
 *  and its cells wound to match whatever it attaches to. The preview draws this; appendGrid commits it. */
export function planGrid(doc: QuadMeshDoc, corners: GridCorners, options: GridOptions): GridPlanResult {
  const count = doc.vertices.length / 3;
  for (const corner of corners) {
    if (corner.vertex !== null && !(Number.isInteger(corner.vertex) && corner.vertex >= 0 && corner.vertex < count))
      return { ok: false, error: 'A snapped grid corner is stale — place the corners again.' };
    if (corner.pos.length !== 3 || !corner.pos.every(Number.isFinite))
      return { ok: false, error: 'A grid corner is not a finite 3D point.' };
  }
  const at = (corner: GridCorner): V3 =>
    corner.vertex !== null ? readVertex(doc.vertices, corner.vertex) : [...corner.pos];
  const [first, second, third, fourth] = corners;
  const a = at(first),
    b = at(second),
    c = at(third),
    d = at(fourth);
  if (len(sub(b, a)) < 1e-3) return { ok: false, error: 'Place the first side’s two corners apart.' };
  if (len(cross(norm(sub(b, a)), sub(c, b))) < 1e-3)
    return { ok: false, error: 'Move the third corner off the first side to give the grid a width.' };
  // Both diagonals must split the outline into two triangles facing the same way; otherwise a corner has been
  // pulled across the grid, or onto a side, and the lattice would fold over itself.
  if (foldsAcross(a, b, c, d) || foldsAcross(b, c, d, a))
    return { ok: false, error: 'Those corners fold the grid over itself — move the last corner back out.' };
  const size = options.patchSize;
  if (size != null && !(Number.isFinite(size) && size > 0))
    return { ok: false, error: 'The patch size must be greater than zero.' };
  const lengthAcross = (len(sub(b, a)) + len(sub(c, d))) / 2,
    widthAcross = (len(sub(c, b)) + len(sub(d, a))) / 2;

  // The first side: an attached run of edges, or a straight side cut into the requested divisions.
  const sideChain =
    first.vertex !== null && second.vertex !== null ? gridSideChain(doc, first.vertex, second.vertex) : null;
  const columns = sideChain
    ? sideChain.length - 1
    : size != null
      ? gridDivisionsForSize(lengthAcross, size)
      : options.columns;
  if (!sideChain) {
    const error = validCount(columns, 'columns');
    if (error) return { ok: false, error };
  }
  // The second side, likewise attached from the first side's far end.
  let rowChain =
    second.vertex !== null && third.vertex !== null ? gridSideChain(doc, second.vertex, third.vertex) : null;
  if (rowChain && sideChain && rowChain.some(v => v !== second.vertex && sideChain.includes(v))) rowChain = null;
  const rows = rowChain ? rowChain.length - 1 : size != null ? gridDivisionsForSize(widthAcross, size) : options.rows;
  if (!rowChain) {
    const error = validCount(rows, 'rows');
    if (error) return { ok: false, error };
  }
  if (columns * rows > MAX_GRID_PATCHES)
    return {
      ok: false,
      error: `That would create ${columns * rows} patches; a grid holds at most ${MAX_GRID_PATCHES}.`,
    };

  // Each row is the first side carried along the second; a fourth corner moved off the parallelogram that makes
  // pulls the lattice bilinearly toward it, which leaves both attached sides exactly where they are.
  const firstSide = sideChain
    ? sideChain.map(v => readVertex(doc.vertices, v))
    : Array.from({ length: columns + 1 }, (_, i) => lerp(a, b, i / columns));
  const secondSide = rowChain
    ? rowChain.map(v => readVertex(doc.vertices, v))
    : Array.from({ length: rows + 1 }, (_, j) => lerp(b, c, j / rows));
  const skew = sub(d, sub(add(a, c), b));
  const reuseAt = (i: number, j: number): number | null => {
    if (j === 0 && sideChain) return sideChain[i];
    if (i === columns && rowChain) return rowChain[j];
    if (j === 0 && i === 0) return first.vertex;
    if (j === 0 && i === columns) return second.vertex;
    if (j === rows && i === columns) return third.vertex;
    if (j === rows && i === 0) return fourth.vertex;
    return null;
  };
  const points: V3[] = [],
    reuse: (number | null)[] = [],
    seen = new Set<number>();
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      const vertex = reuseAt(i, j);
      if (vertex !== null) {
        if (seen.has(vertex))
          return { ok: false, error: 'The grid would use one point twice — snap its corners to different points.' };
        seen.add(vertex);
      }
      reuse.push(vertex);
      points.push(
        vertex !== null
          ? readVertex(doc.vertices, vertex)
          : add(sub(add(firstSide[i], secondSide[j]), b), mul(skew, (1 - i / columns) * (j / rows))),
      );
    }

  // Default winding fronts (B − A) × (C − A). A seam shared with an existing patch must run opposite to it, which
  // decides the winding outright; otherwise the front faces the eye the grid was drawn from.
  const stride = columns + 1;
  let quads: [number, number, number, number][] = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < columns; i++) {
      const corner = j * stride + i;
      quads.push([corner, corner + 1, corner + stride, corner + stride + 1]);
    }
  const { rimDirection, interior } = openEdges(doc);
  const flips = new Set<boolean>();
  for (const quad of quads)
    for (const [p, q] of quadPerimeterEdges(quad)) {
      const from = reuse[p],
        to = reuse[q];
      if (from === null || to === null) continue;
      if (interior.has(ekey(from, to)))
        return { ok: false, error: 'The grid would put a third patch on an interior edge.' };
      const existing = rimDirection.get(ekey(from, to));
      if (existing) flips.add(existing[0] === from);
    }
  if (flips.size > 1)
    return { ok: false, error: 'The edges this grid attaches to face opposite ways, so it cannot match both.' };
  let flip = flips.has(true);
  if (!flips.size) {
    const centre = mul(add(add(a, b), add(c, d)), 0.25);
    flip = dot(cross(sub(b, a), sub(c, a)), options.eye ? sub(options.eye, centre) : [0, 1, 0]) < 0;
  }
  if (flip) quads = quads.map(([p, q, r, s]) => [q, p, s, r]);

  return {
    ok: true,
    plan: {
      columns,
      rows,
      inheritedColumns: !!sideChain,
      inheritedRows: !!rowChain,
      length: len(sub(b, a)),
      width: len(sub(c, b)),
      cellLength: lengthAcross / columns,
      cellWidth: widthAcross / rows,
      points,
      reuse,
      quads,
    },
  };
}

/** Commit a planned grid: append its new points and patches, reuse the attached ones, pin the reused points'
 *  existing tangents so nothing already there reshapes, and consume free edges that become patch sides. */
export function appendGrid(doc: QuadMeshDoc, plan: GridPlan): AppendGridResult {
  const count = doc.vertices.length / 3;
  if (plan.reuse.some(v => v !== null && !(Number.isInteger(v) && v >= 0 && v < count)))
    return { ok: false, error: 'A point this grid attaches to is gone — place the corners again.' };
  const vertices = [...doc.vertices],
    ids: number[] = [],
    added: number[] = [];
  plan.points.forEach((point, k) => {
    const reused = plan.reuse[k];
    if (reused !== null) {
      ids.push(reused);
      return;
    }
    const id = vertices.length / 3;
    vertices.push(...point);
    ids.push(id);
    added.push(id);
  });
  const created = plan.quads.map(quad => quad.map(k => ids[k]));
  const quads = [...doc.quads, ...created];
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false, error: guard.error! };

  const out: QuadMeshDoc = { ...doc, vertices, quads, ...appendMeshIds(doc, added.length, created.length) };
  const reused = plan.reuse.filter((v): v is number => v !== null);
  if (reused.length) {
    const edgeHandles = { ...(doc.edgeHandles ?? {}) };
    const beforeMesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
    const beforeAdj = meshAdjacency(beforeMesh),
      beforeHandle = meshEdgeHandles(beforeMesh, doc.edgeHandles);
    for (const id of reused)
      for (const neighbor of beforeAdj.neighbors[id] ?? []) {
        const h = beforeHandle(id, neighbor);
        edgeHandles[`${id}>${neighbor}`] = [h[0], h[1], h[2]];
      }
    out.edgeHandles = edgeHandles;
    const sides = new Set(created.flatMap(quad => quadPerimeterEdges(quad).map(([p, q]) => ekey(p, q))));
    const freeEdges = (doc.freeEdges ?? []).filter(([p, q]) => !sides.has(ekey(p, q)));
    if (freeEdges.length) out.freeEdges = freeEdges;
    else delete out.freeEdges;
  }
  const firstQuad = doc.quads.length;
  return { ok: true, doc: out, quads: created.map((_, i) => firstQuad + i), vertices: added };
}
