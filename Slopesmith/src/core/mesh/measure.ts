import type { V3 } from '../doc/types';
import { add, cross, len, sub } from '../math/vec';
import { cubicPolyline, patchPoint } from '../math/bezier';
import type { EdgeHandle, MeshAdjacency, QuadMesh } from './topology';
import { readVertex, undirectedEdgeKey } from './primitives';
import { seamCreaseDegrees, type PatchControls } from './creases';

/**
 * Metric read-outs for a control-net selection — the true surface measurements the Edit toolbox shows so a
 * builder can size a run in metres: the curved length of an edge, and a cell's down-slope length, across
 * width, vertical drop and surface area. Everything is measured off the bicubic quilt's own primitives — an
 * edge's shared boundary Bezier, a cell's sixteen control points — the SAME primitives the preview
 * tessellates and the bake writes. Both terrain surfaces expose them (the authored net and the read-only
 * reference are each a `QuadMesh` + `EdgeHandle`, and a cell is its sixteen CPs whether they come from
 * `quadControlPoints` or the reference's stored `patchControls`), so this one core measures both and the
 * panel shows one read-out — a measurement change lands on both surfaces at once.
 */

/** Surface-integral sampling resolution: a selection is measured once when it's picked, not per frame, so a
 *  fine grid (area / drop converge, curved spans stop under-reading) costs nothing. Even, so the centre
 *  lines land exactly on u=0.5 / v=0.5. */
const RES = 12;

const vAt = (m: QuadMesh, i: number): V3 => readVertex(m.vertices, i);

/** Total length of a polyline (sum of its straight segment lengths). */
function polylineLength(pts: V3[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += len(sub(pts[i], pts[i - 1]));
  return s;
}

/** Area of the triangle (a, b, c). */
const triArea = (a: V3, b: V3, c: V3): number => 0.5 * len(cross(sub(b, a), sub(c, a)));

/**
 * The true (curved) length of one control-net EDGE — the arc length of its shared cubic-Bezier boundary
 * curve (exactly the curve `meshCageEdges` draws and the two adjacent patches bake), not the straight chord
 * between the corners. `a` / `b` are the edge's vertex ids; the handles come from the same directed-edge
 * provider the patches read (authored Bessel/override, or the reference's faithful stored curves), so the
 * number is the ridable edge on the surface for either.
 */
export function edgeLength(mesh: QuadMesh, eh: EdgeHandle, a: number, b: number): number {
  const Pa = vAt(mesh, a), Pb = vAt(mesh, b);
  return polylineLength(cubicPolyline(Pa, add(Pa, eh(a, b)), add(Pb, eh(b, a)), Pb, RES));
}

export interface CellMetrics {
  /** Down-the-spine span (u axis) — the cell's length along the fall line, the curved arc through its centre. */
  length: number;
  /** Across-slope span (v axis) — the cell's width, the curved arc through its centre. */
  width: number;
  /** Vertical extent (max − min height) over the cell's surface. */
  drop: number;
  /** True 3D surface area of the bicubic patch (m²). */
  area: number;
  /** Height range of the sampled surface — so a multi-cell selection can fold one overall drop from many cells. */
  minY: number;
  maxY: number;
}

/**
 * The metric read-out for one cell straight from its sixteen bicubic control points (`cp`, row-major, rows
 * along u): down-slope length, across width, vertical drop and true surface area. Taking the CPs directly is
 * the shared seam — the authored net feeds `quadControlPoints(mesh, eh, quad, twist)` (so a sculpted interior
 * is measured as it rides) and the reference feeds its stored `patchControls[patch]`, and this code is blind
 * to which. Length / width are the curved centre-line spans (u at v=0.5, v at u=0.5) — a warped cell reads
 * its real reach, not the chord. `minY` / `maxY` are exposed so a multi-cell selection aggregates one drop.
 */
export function cellMetrics(cp: V3[]): CellMetrics {
  let area = 0, minY = Infinity, maxY = -Infinity;
  // sample the patch on an (RES+1)² grid: triangulated area + height range
  const grid: V3[][] = [];
  for (let iu = 0; iu <= RES; iu++) {
    const row: V3[] = [];
    for (let iv = 0; iv <= RES; iv++) {
      const p = patchPoint(cp, iu / RES, iv / RES);
      row.push(p);
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    }
    grid.push(row);
  }
  for (let iu = 0; iu < RES; iu++) {
    for (let iv = 0; iv < RES; iv++) {
      const a = grid[iu][iv], b = grid[iu][iv + 1], c = grid[iu + 1][iv], d = grid[iu + 1][iv + 1];
      area += triArea(a, b, c) + triArea(d, c, b);
    }
  }
  // centre lines: down the spine at v=0.5 (length), across at u=0.5 (width)
  const uLine: V3[] = [], vLine: V3[] = [];
  for (let i = 0; i <= RES; i++) uLine.push(patchPoint(cp, i / RES, 0.5));
  for (let i = 0; i <= RES; i++) vLine.push(patchPoint(cp, 0.5, i / RES));
  return { length: polylineLength(uLine), width: polylineLength(vLine), drop: maxY - minY, area, minY, maxY };
}

export interface EdgeMeasure {
  kind: 'edge';
  count: number;
  /** Total curved length over every selected edge (a single edge = its own length). */
  total: number;
  /** How sharply the two patches meet along the edge, in degrees (core/mesh/creases.ts) — the widest across a
   *  multi-selection. Null when no selected edge is a seam between exactly two patches (a rim, a free edge). */
  angle: number | null;
  /** The selected edges that are two-patch seams, so a read-out can re-measure `angle` as the surface changes. */
  seams: Seam[];
  /** Re-measure `angle` against the live surface (supplied by a host whose surface is editable); a read-out
   *  polls it so the value follows smooth / crease / drags without the selection being re-picked. */
  liveAngle?: () => number | null;
}

/** An edge a–b and the two patches either side of it. */
export type Seam = { a: number; b: number; quads: [number, number] };

/** The widest seam angle over `seams`, or null when there are none. */
export function widestSeamAngle(mesh: QuadMesh, controls: PatchControls, seams: readonly Seam[]): number | null {
  let angle: number | null = null;
  for (const seam of seams) {
    if (!mesh.quads[seam.quads[0]] || !mesh.quads[seam.quads[1]]) continue; // topology moved on under the pick
    angle = Math.max(angle ?? 0, seamCreaseDegrees(mesh, controls, seam.a, seam.b, seam.quads));
  }
  return angle;
}

export interface CellMeasure {
  kind: 'cell';
  count: number;
  /** Total 3D surface area over every selected cell. */
  area: number;
  /** Overall vertical fall across the whole selection (max − min height). */
  drop: number;
  /** The lone cell's full metrics (its length × width) when exactly one is selected, else null. */
  single: CellMetrics | null;
  /** The lone selected cell / patch id, for the read-out label (only when count === 1). */
  id: number | null;
}

/** A control-net selection's measured metrics, ready for the toolbox — one shape whether the selection is on
 *  the authored net or the read-only reference. */
export type SelectionMeasure = EdgeMeasure | CellMeasure;

/** Fold an edge selection into its measure (total curved length + count + seam angle), or null when empty.
 *  `seams` gives the surface's adjacency and a patch's sixteen control points (as for measureCells), so the seam
 *  angle can compare the two patches either side of each edge. The adjacency is the caller's already-derived one:
 *  a selection read-out must not rebuild the whole mountain's topology. Without it (a caller after length
 *  alone) the angle is null. */
export function measureEdges(mesh: QuadMesh, eh: EdgeHandle, edges: readonly [number, number][],
  seamSource?: { adj: MeshAdjacency; controls: PatchControls }): EdgeMeasure | null {
  if (!edges.length) return null;
  let total = 0;
  for (const [a, b] of edges) total += edgeLength(mesh, eh, a, b);
  const seams: Seam[] = [];
  if (seamSource) {
    const { adj } = seamSource;
    for (const [a, b] of edges) {
      const quads = adj.edgeQuads.get(undirectedEdgeKey(a, b));
      if (quads?.length === 2) seams.push({ a, b, quads: [quads[0], quads[1]] });
    }
  }
  return { kind: 'edge', count: edges.length, total, seams,
    angle: seamSource ? widestSeamAngle(mesh, seamSource.controls, seams) : null };
}

/**
 * Fold a cell selection into its measure, or null when empty. `cpOf` hands back a cell's sixteen control
 * points — the ONE thing that differs between the two surfaces (authored `quadControlPoints`, reference
 * stored `patchControls`), so the aggregation itself is shared. A single cell keeps its full metrics (for the
 * length × width read-out); many fold to one total area + one overall drop.
 */
export function measureCells(cpOf: (cell: number) => V3[], cells: readonly number[]): CellMeasure | null {
  if (!cells.length) return null;
  let area = 0, minY = Infinity, maxY = -Infinity, single: CellMetrics | null = null;
  for (const q of cells) {
    const m = cellMetrics(cpOf(q));
    area += m.area;
    minY = Math.min(minY, m.minY);
    maxY = Math.max(maxY, m.maxY);
    single = m;
  }
  return {
    kind: 'cell', count: cells.length, area, drop: maxY - minY,
    single: cells.length === 1 ? single : null,
    id: cells.length === 1 ? cells[0] : null,
  };
}
