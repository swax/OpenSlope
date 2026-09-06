import type { QuadMeshDoc, V3 } from '../doc/types';
import { add, dot, len, norm, sub } from '../math/vec';
import { patchPoint, splitCubic, splitPatchU, splitPatchV } from '../math/bezier';
import { INTERIOR_CP, meshFromDoc, quadControlPoints, type EdgeHandle, type MeshAdjacency, type QuadMesh } from './topology';
import { ekey } from './ops';
import { readVertex } from './primitives';
import { meshSetHandle, meshSetTwist } from '../doc/mountain';
import { getVertex, setVertex } from '../doc/doc-edit';

/**
 * Geometry-preserving SLIDES of the control net: move an edge (or a lone vertex) along the surface without
 * changing the surface it describes. A slide is a de Casteljau RE-CUT — the moved edge lands on the parent's
 * own curve, and each quad it crosses becomes the exact sub-patch of itself — so the terrain a rider boards is
 * bit-for-bit what it was before the drag, only re-parameterised. That is what separates a slide from a
 * translate: dragging a cage vertex reshapes the quilt, sliding it re-cuts it.
 *
 * Two facts make an exact re-cut land, and both are load-bearing:
 *
 * 1. The TWIST must be written. The sub-patch of a zero-twist (Ferguson) patch is not itself zero-twist — the
 *    cut stirs the parent's boundary curvature into the corners' mixed second derivative (bezier.ts
 *    `splitPatchU`). `quadTwist` stores an offset PAST the zero-twist prediction, so the base has to be
 *    re-derived from the doc AFTER the corners and boundary handles are in place; measuring the offset against
 *    the pre-slide base bows the sub-patch off the surface it was cut from.
 * 2. Every boundary handle of a preserved quad must be PINNED. An un-overridden handle is Bessel-derived from
 *    the vertex ring, and a slide moves vertices; leave one derived and it re-solves to a different tangent and
 *    the patch drifts. All eight directed handles are written, including the far edge's — pinning those to the
 *    value they already hold is geometrically a no-op, and it stops the ring from stealing them later.
 *
 * A quad's four boundary curves are shared with its neighbours, so a slide is exact for the quads it is asked
 * about and the ones across the far (unmoved) edges; the patches hanging off the MOVED edge are re-shaped, as
 * they must be — their own far edge stayed put while the seam between them travelled.
 *
 * A 2-D slide (both axes at once) obeys one law: **every moved vertex `V` lands on `P_V(tu, tv)` — the exact patch
 * point of `V`'s QUADRANT quad, the quad incident to `V` whose interior lies in the drag's `+u,+v` corner.** No ray is
 * cast and the vertex never leaves the original surface. A composition of two 1-D passes does NOT deliver that law on
 * its own: a `u`-pass then a `v`-pass leaves the two corners whose `v` rail the `u`-pass re-cut exactly on the surface,
 * and drags the other two back along a chord to a neighbour the `u`-pass never moved (metres, not microns — the passes
 * disagree on which two by pass order). So POSITIONS come from the law and the passes only shape TANGENTS:
 * `slideQuadrantTargets` reads the law off the frozen base and a final `place` pass writes it over whatever the passes
 * left. Handles are stored as offsets from their vertex, so a pinned tangent rides along with the correction.
 */

/** How close a slide may come to either end of its parameter range. Reaching the far end would collapse the
 *  quad it slid through (zero-length edge, degenerate handles); a caller that wants that asks for a merge. */
export const SLIDE_EPS = 1e-4;

/**
 * How near the OTHER axis must sit to zero before a 2-D drag's saturated axis may merge — 10% of a cell.
 *
 * A merge is a weld, and a weld fuses two VERTICES. At `tu = 1, tv = 0.4` the dragged corner has reached the far
 * side of its quadrant quad but stands 40% of the way along the link EDGE `Nu–D`, not on either of its ends: it is
 * a T-junction, and a quad mesh has none. Welding it into `Nu` anyway would teleport the corner 40% of a cell back
 * up the edge it had just crossed. So the merge only arms while the drag has stayed essentially on one rail, and
 * the rest of the pad's far range is a wall the drag clamps against — visible, reversible, and never a jump.
 *
 * Both axes saturated is likewise no merge, and for a sharper reason. There the corner has arrived at the quadrant
 * quad's FAR corner `D` (`patchPoint(cp, 1, 1)`, to within the clamp's own 5 mm) — so the weld the geometry calls
 * for is `V→D`, and that is the diagonal fusion `applyVertexWeld` refuses: a quad can only encode the
 * edge-collapsed wedge `[A,B,C,C]`. Naming the two rail neighbours instead does pass the guard, but `Nu` and `Nv`
 * are that same diagonal pair, so union-find fuses all three through `V` and drops it back on a rail it had just
 * crossed — a 30 m teleport on a 53 m cell, not a merge.
 */
export const SLIDE_MERGE_SNAP = 0.1;

const clampT = (t: number): number => (Number.isFinite(t) ? Math.min(Math.max(t, SLIDE_EPS), 1 - SLIDE_EPS) : SLIDE_EPS);

/** A WEDGE [A,B,C,C] folds its u=1 row to a point (docs/017 S3), so it has no independent D corner and no C–D
 *  curve — `quadControlPoints` special-cases it and a de Casteljau cut across the collapsed axis is undefined.
 *  Slides refuse one rather than write a broken net. */
const isWedge = (quad: readonly number[]): boolean => quad[2] === quad[3];

/** Which of the quad's four boundaries the (unordered) vertex pair names, or null when it names none of them.
 *  `AB` is the u=0 row, `CD` the u=1 row, `AC` the v=0 column, `BD` the v=1 column. */
type QuadSide = 'AB' | 'CD' | 'AC' | 'BD';
const SIDES = ['AB', 'CD', 'AC', 'BD'] as const;
function quadSide(quad: readonly number[], edge: readonly [number, number]): QuadSide | null {
  const [A, B, C, D] = quad;
  const is = (x: number, y: number) => (edge[0] === x && edge[1] === y) || (edge[0] === y && edge[1] === x);
  if (is(A, B)) return 'AB';
  if (is(C, D)) return 'CD';
  if (is(A, C)) return 'AC';
  if (is(B, D)) return 'BD';
  return null;
}

/** The two corner SLOTS (indices into the stored `[A,B,C,D]`) each boundary spans. */
const SIDE_SLOTS: Record<QuadSide, readonly [number, number]> = { AB: [0, 1], CD: [2, 3], AC: [0, 2], BD: [1, 3] };
/** The boundary a slide along `side` travels TOWARD — the one it becomes if the slide runs the whole span. */
const OPPOSITE_SIDE: Record<QuadSide, QuadSide> = { AB: 'CD', CD: 'AB', AC: 'BD', BD: 'AC' };
/** The two RAILS a slide along `side` rides: the boundaries joining it to its opposite. */
const RAIL_SIDES: Record<QuadSide, readonly [QuadSide, QuadSide]> = { AB: ['AC', 'BD'], CD: ['AC', 'BD'], AC: ['AB', 'CD'], BD: ['AB', 'CD'] };
/** Corner slot A/B/C/D → its control point in the row-major 16. */
const CORNER_CP = [0, 3, 12, 15] as const;
/** Corner slot A/B/C/D → its patch parameter, the storage contract [A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)]
 *  read as coordinates: `patchPoint(cp, ...CORNER_UV[s])` IS the corner in slot `s`, to the bit. */
const CORNER_UV: readonly (readonly [number, number])[] = [[0, 0], [0, 1], [1, 0], [1, 1]];
/** The one patch coordinate two corner slots differ in (0 = u, 1 = v), or -1 when they are the same corner or the
 *  quad's DIAGONAL — the two slots that differ in both. Cycle-adjacency, stated in patch parameters. */
function slotAxis(a: readonly [number, number], b: readonly [number, number]): number {
  const du = a[0] !== b[0], dv = a[1] !== b[1];
  return du === dv ? -1 : du ? 0 : 1;
}

/**
 * The patch parameter `V` reaches inside `quad` when the rail toward `nu` is cut at `su` and the rail toward `nv` at
 * `sv`: fold each parameter onto the coordinate its rail moves — a corner sitting at 0 runs forward to `t`, one at 1
 * runs back to `1 - t`. `nu` / `nv` name the two rails, not the patch's u / v, so swapping the pairs is the same point.
 * Null when the three vertices do not sit on `quad` as a corner and its two CYCLE-adjacent neighbours on different
 * axes — a diagonal, a repeat, or a stranger.
 */
function quadrantParam(quad: readonly number[], V: number, nu: number, nv: number, su: number, sv: number): [number, number] | null {
  const sV = quad.indexOf(V), sU = quad.indexOf(nu), sW = quad.indexOf(nv);
  if (sV < 0 || sU < 0 || sW < 0) return null;
  const uv = CORNER_UV[sV];
  const cU = slotAxis(uv, CORNER_UV[sU]), cW = slotAxis(uv, CORNER_UV[sW]);
  if (cU < 0 || cW < 0 || cU === cW) return null;
  const at: [number, number] = [uv[0], uv[1]];
  at[cU] = uv[cU] === 0 ? su : 1 - su;
  at[cW] = uv[cW] === 0 ? sv : 1 - sv;
  return at;
}
/** Directed in-quad edge `"fromSlot>toSlot"` → the control point one third along it, at `from`'s end. */
const HANDLE_CP: Record<string, number> = { '0>1': 1, '1>0': 2, '0>2': 4, '2>0': 8, '1>3': 7, '3>1': 11, '2>3': 13, '3>2': 14 };

/** The (unordered) vertex pair boundary `side` names on `quad`. */
const sideEdge = (quad: readonly number[], side: QuadSide): [number, number] => {
  const [s0, s1] = SIDE_SLOTS[side];
  return [quad[s0], quad[s1]];
};

/**
 * The sub-patch left when the named boundary slides to parameter `t` of the span toward the opposite boundary.
 * Each branch keeps the half the named edge does NOT sweep through, and the halves come back over the SAME
 * [A,B,C,D] corner slots — the two corners on the far edge are untouched — so the result writes straight back
 * onto the quad. The u=1 / v=1 sides cut at `1 - t` and keep the `lower` half because their parameter runs
 * backwards from the named edge.
 */
function sideSubPatch(cp: V3[], side: QuadSide, t: number): V3[] {
  switch (side) {
    case 'AB': return splitPatchU(cp, t).upper;
    case 'CD': return splitPatchU(cp, 1 - t).lower;
    case 'AC': return splitPatchV(cp, t).upper;
    case 'BD': return splitPatchV(cp, 1 - t).lower;
  }
}

/** The two directed handles of boundary `side`, read off `cp` and pinned onto the quad. */
function writeSideHandles(doc: QuadMeshDoc, verts: readonly number[], cp: V3[], side: QuadSide): void {
  const [s0, s1] = SIDE_SLOTS[side];
  meshSetHandle(doc, verts[s0], verts[s1], sub(cp[HANDLE_CP[`${s0}>${s1}`]], cp[CORNER_CP[s0]]));
  meshSetHandle(doc, verts[s1], verts[s0], sub(cp[HANDLE_CP[`${s1}>${s0}`]], cp[CORNER_CP[s1]]));
}

/** Boundary `side`'s two corner positions plus its two directed handles — the whole curve that boundary carries. */
function writeSideEdge(doc: QuadMeshDoc, verts: readonly number[], cp: V3[], side: QuadSide): void {
  const [s0, s1] = SIDE_SLOTS[side];
  setVertex(doc, verts[s0], cp[CORNER_CP[s0]]);
  setVertex(doc, verts[s1], cp[CORNER_CP[s1]]);
  writeSideHandles(doc, verts, cp, side);
}

/** The corners + eight directed boundary handles of `cp`, pinned onto the quad. Split out from the twist so a
 *  multi-quad slide can lay down every quad's frame before any twist is measured — a twist offset is taken
 *  against a zero-twist base, and that base moves with the shared vertices its neighbours in the batch write.
 *  Any side may play the "moved" role here: the four writes together cover all four corners and all eight
 *  handles exactly once, so the choice of `AB` is arbitrary. */
function writeQuadFrame(doc: QuadMeshDoc, quad: number, cp: V3[]): void {
  const verts = doc.quads[quad];
  writeSideEdge(doc, verts, cp, 'AB');
  writeSideEdge(doc, verts, cp, 'CD');
  writeSideHandles(doc, verts, cp, 'AC');
  writeSideHandles(doc, verts, cp, 'BD');
}

/** The four interior CPs of `cp` as offsets past the zero-twist prediction the doc now derives — `mesh` / `eh`
 *  must be re-derived from the doc with every frame in the batch already written, or the offsets aim at a
 *  base that no longer exists. */
function writeQuadTwist(doc: QuadMeshDoc, mesh: QuadMesh, eh: EdgeHandle, quad: number, cp: V3[]): void {
  const base = quadControlPoints(mesh, eh, quad);
  for (let k = 0; k < 4; k++) meshSetTwist(doc, quad, k, sub(cp[INTERIOR_CP[k]], base[INTERIOR_CP[k]]));
}

/**
 * Write an exact 16-CP net onto quad `quad`: its four corner vertices, its eight directed boundary handles, and
 * the four interior twist offsets. Reading `quadControlPoints(mesh, eh, quad, doc.quadTwist[quad])` back off the
 * re-derived doc reproduces `cp` — the doc's storage (vertices + directed handles + twist offsets) spans the
 * whole bicubic net, and this is the inverse of that derivation. A wedge quad is skipped: its collapsed row has
 * no independent D corner or C–D curve to carry half the net. Mutates `doc`.
 */
export function writeQuadControlPoints(doc: QuadMeshDoc, quad: number, cp: V3[]): void {
  if (!doc.quads[quad] || isWedge(doc.quads[quad])) return;
  writeQuadFrame(doc, quad, cp);
  const { mesh, edgeHandle } = meshFromDoc(doc);
  writeQuadTwist(doc, mesh, edgeHandle, quad, cp);
}

/** One vertex, the edge it rides (named by the neighbour at the far end), and how far along that edge's cubic. */
export interface VertexSlideItem {
  vertex: number;
  toward: number;
  t: number;
}

/**
 * Slide every item's `vertex` along its own edge toward `toward`, to parameter `t` of that edge's cubic. CURVE-exact
 * per item: each edge's own boundary curve is bit-identical over [t,1], only re-cut, and the vertex lands ON it.
 *
 * Two facts make a RUN of items — a whole edge loop's endpoints sliding along the loop, `A0→A1, A1→A2, …` — come out
 * right, and both are load-bearing:
 *
 * 1. Every item's cubic is read BEFORE any item is written. Consecutive items share a vertex (one's `toward` is the
 *    next's `vertex`), and a half-written doc would hand the next item a corner the last one had already moved, so its
 *    `t` would name a point on a curve that no longer exists.
 * 2. A `toward` that is itself some item's `vertex` gets NO incoming handle pinned. Pinning `toward → vertex` is how a
 *    lone slide stops the vertex ring from re-deriving the far end's tangent — but a `toward` that MOVES writes its own
 *    outgoing handle from its own cut, and its position no longer terminates this item's curve, so the pin would nail
 *    the far tangent of a curve that is not there. A run therefore pins only its lead item's far end.
 *
 * The patches either side of a moved edge do change shape (their far edges stayed put while this seam travelled); use
 * `slideEdgesInQuads` when a patch's surface must be preserved too. An item with `vertex === toward` (no curve) or a
 * non-finite id is skipped, not failed. Mutates `doc`.
 */
export function slideVerticesAlongEdges(doc: QuadMeshDoc, items: readonly VertexSlideItem[]): void {
  const live = items.filter(({ vertex, toward }) => vertex !== toward && Number.isFinite(vertex) && Number.isFinite(toward));
  if (!live.length) return;
  const { edgeHandle } = meshFromDoc(doc);
  const moved = new Set(live.map(it => it.vertex));
  // `edgeHandle` reads the doc's live vertex buffer, so every cut is taken off the pre-slide net, in one pass
  const staged = live.map(({ vertex, toward, t }) => {
    const P0 = getVertex(doc, vertex), P3 = getVertex(doc, toward);
    const { right } = splitCubic(P0, add(P0, edgeHandle(vertex, toward)), add(P3, edgeHandle(toward, vertex)), P3, clampT(t));
    return { vertex, toward, right };
  });
  for (const { vertex, toward, right } of staged) {
    setVertex(doc, vertex, right[0]);
    meshSetHandle(doc, vertex, toward, sub(right[1], right[0]));
    if (!moved.has(toward)) meshSetHandle(doc, toward, vertex, sub(right[2], right[3]));
  }
}

/**
 * Slide `vertex` along its edge toward `toward`, to parameter `t` of that edge's cubic. CURVE-exact: the edge's
 * own boundary curve is bit-identical over [t,1], only re-cut — the vertex lands ON the curve it used to end,
 * and both of the edge's handles are pinned to the sub-curve's, so nothing re-derives it. The patches either
 * side of the edge do change shape (their far edges stayed put while this seam travelled); use
 * `slideEdgesInQuads` when a patch's surface must be preserved too. Mutates `doc`.
 *
 * The one-item case of `slideVerticesAlongEdges`, byte for byte: a lone item's `toward` is nobody's `vertex`, so
 * both directed handles pin.
 */
export function slideVertexAlongEdge(doc: QuadMeshDoc, vertex: number, toward: number, t: number): void {
  slideVerticesAlongEdges(doc, [{ vertex, toward, t }]);
}

/**
 * The 2-D corner slide: `vertex` travels `tu` of the way toward `towardU` AND `tv` of the way toward `towardV`,
 * landing on the point `quad`'s own bicubic patch carries at those two parameters. Both `toward`s must be
 * CYCLE-adjacent to `vertex` in the quad (a diagonal names no rail — a caller bug, so the slide bails), and they
 * must ride different axes. `towardU` / `towardV` label the two rails, not the patch's u / v: each is folded onto
 * whichever coordinate it actually moves, so swapping the two pairs is the same slide.
 *
 * A composition of two curve-splits is WRONG here, and by a wide margin. After the u-split the v-edge runs from the
 * moved vertex to an unmoved corner — a chord across the quad's interior, not the patch's `u = tu` iso-curve — so
 * cutting it at `tv` lands off the surface, and u-then-v ≠ v-then-u. (Two DIFFERENT vertices sliding one axis each is
 * a different matter: there `slideEdgesInQuads` re-cuts the quad, and the moved boundary IS the exact iso-curve, which
 * is why the edge and cell families do compose. A lone vertex preserves no patch, so it has nothing to re-cut into.)
 * The vertex is placed on the patch directly instead — it never leaves the ORIGINAL surface, and no ray is cast.
 *
 * The exactness ledger, stated rather than hidden:
 *  - the VERTEX is exactly on the parent surface, at `P(tu', tv')` of the quad it slid inside;
 *  - each LEAVING edge curve carries its own axis's split tangent, so at `tv → 0` the u-edge is exactly the parent
 *    cubic re-cut over `[tu, 1]` and this reduces to `slideVertexAlongEdge` — every 1-D slide is the `tv = 0` slice
 *    of this one, up to the `SLIDE_EPS` the clamp holds each axis off its ends;
 *  - the FOUR patches around the vertex re-shape, as they must — their far edges stayed put while their shared corner
 *    left the seam. No twist is written: a lone vertex slide preserves no patch, only the surface point.
 *
 * Mutates `doc`. Skipped, not failed: a missing quad, a WEDGE (its collapsed row has no second axis), a `vertex` /
 * `toward` that is not one of the quad's corners, and a diagonal or repeated `toward`.
 */
export function slideVertexOnPatch(
  doc: QuadMeshDoc, quad: number, vertex: number, towardU: number, tu: number, towardV: number, tv: number,
): void {
  const verts = doc.quads[quad];
  if (!verts || isWedge(verts)) return;
  const su = clampT(tu), sw = clampT(tv);
  const at = quadrantParam(verts, vertex, towardU, towardV, su, sw);
  if (!at) return;   // a diagonal, a repeat, or `vertex` twice: no two rails to ride

  const { mesh, edgeHandle } = meshFromDoc(doc);
  const cp = quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad]);
  const P = (i: number) => getVertex(doc, i);
  // both cuts come off the pre-slide net: `edgeHandle` reads the doc's live vertex buffer
  const cut = (toward: number, s: number) => {
    const P0 = P(vertex), P3 = P(toward);
    return splitCubic(P0, add(P0, edgeHandle(vertex, toward)), add(P3, edgeHandle(toward, vertex)), P3, s).right;
  };
  const cutU = cut(towardU, su), cutW = cut(towardV, sw);

  setVertex(doc, vertex, patchPoint(cp, at[0], at[1]));
  meshSetHandle(doc, vertex, towardU, sub(cutU[1], cutU[0]));
  meshSetHandle(doc, towardU, vertex, sub(cutU[2], cutU[3]));
  meshSetHandle(doc, vertex, towardV, sub(cutW[1], cutW[0]));
  meshSetHandle(doc, towardV, vertex, sub(cutW[2], cutW[3]));
}

/** One vertex and the exact surface point a 2-D drag places it on. Absolute, read off the FROZEN drag-start net. */
export interface VertexPlaceItem {
  vertex: number;
  pos: V3;
}

/**
 * The 2-D law, evaluated: for each vertex in `verts`, the exact point of its QUADRANT quad at the two slide parameters.
 *
 * A vertex's quadrant quad is the one incident to it whose interior lies in the drag's `+du,+dv` corner. It is found
 * from the vertex ring alone, with no coordinate frame: `nu` is the neighbour whose direction best agrees with `du`,
 * `nv` the one that best agrees with `dv`, and the quadrant quad is the single quad carrying BOTH edges. That falls out
 * correctly for a whole dragged cell `[A,B,C,D]` with `N_u`, `N_v`, `N_uv` around it — `A`'s quad is the cell itself,
 * `B`'s is `N_v` (its `+u` neighbour is `D`, along the cell's own rail; its `+v` neighbour is the loop's next vertex),
 * `C`'s is `N_u`, `D`'s is `N_uv`. Each corner therefore travels one cell's worth in each axis, along its own patch.
 *
 * `mesh` / `eh` / `quadTwist` are the frozen drag-start net, so the points are on the ORIGINAL surface; the returned
 * positions are absolute and a `place` pass writes them over whatever the shaping passes left. Both parameters clamp
 * with `clampT`, so a saturated axis stops short of collapsing the quadrant quad.
 *
 * A vertex is SKIPPED, not failed, when the law has nothing to say: no neighbour leads in one of the drag's directions
 * (a rim), no single quad carries both rails (a rim corner, a pole fan), the quadrant quad is a WEDGE (a collapsed row
 * has no second axis), or the two rails share an axis. Such a vertex keeps whatever position the shaping passes gave it.
 */
export function slideQuadrantTargets(
  mesh: QuadMesh, eh: EdgeHandle, adj: MeshAdjacency, verts: readonly number[],
  du: V3, dv: V3, tu: number, tv: number, quadTwist?: Readonly<Record<number, readonly V3[]>> | null,
): VertexPlaceItem[] {
  if (len(du) < 1e-12 || len(dv) < 1e-12) return [];
  const dU = norm(du), dV = norm(dv);
  const su = clampT(tu), sv = clampT(tv);
  const P = (i: number): V3 => readVertex(mesh.vertices, i);
  const out: VertexPlaceItem[] = [];
  const seen = new Set<number>();
  for (const V of verts) {
    if (seen.has(V) || !Number.isFinite(V)) continue;
    seen.add(V);
    const ring = adj.neighbors[V] ?? [];
    // the rail that LEADS: strictly positive agreement, so a rim vertex with no neighbour that way has none
    const lead = (d: V3): number => {
      let best = -1, agree = 0;
      for (const n of ring) {
        const w = sub(P(n), P(V));
        if (len(w) < 1e-12) continue;
        const a = dot(norm(w), d);
        if (a > agree) { agree = a; best = n; }
      }
      return best;
    };
    const nu = lead(dU), nv = lead(dV);
    if (nu < 0 || nv < 0 || nu === nv) continue;
    const qu = adj.edgeQuads.get(ekey(V, nu)) ?? [];
    const quad = qu.find(q => (adj.edgeQuads.get(ekey(V, nv)) ?? []).includes(q));   // the one quad carrying both rails
    if (quad === undefined || isWedge(mesh.quads[quad])) continue;
    const at = quadrantParam(mesh.quads[quad], V, nu, nv, su, sv);
    if (!at) continue;
    out.push({ vertex: V, pos: patchPoint(quadControlPoints(mesh, eh, quad, quadTwist?.[quad]), at[0], at[1]) });
  }
  return out;
}

/** One quad and the boundary edge of it that moves. */
export interface EdgeSlideItem {
  quad: number;
  edge: readonly [number, number];
}

/**
 * Slide each item's boundary `edge` across its `quad` to parameter `t` (measured from that edge toward the
 * opposite one). SURFACE-exact for every listed quad: each becomes the de Casteljau sub-patch of itself, so the
 * ridable surface is untouched and only the net that describes it moves. Pass one item to slide a lone edge, the
 * whole into-row of an edge loop to slide the loop.
 *
 * Every quad's control net is read BEFORE any is written, so a vertex two listed quads share is read at its
 * original position — a loop's quads meet along cross edges, and a half-written doc would feed the second quad a
 * corner the first had already moved. The shared cross edge is one curve cut at one point, so both quads pin its
 * handles to the same values and the batch is self-consistent.
 *
 * The write is ORDER-FREE, in two passes over every item, because a chain of items `Q1 | Q2 | N` names one edge
 * twice: `Q1`'s sub-patch carries its far edge (= `Q2`'s moved edge) where it USED to be, and `Q2`'s carries it
 * where it now is.
 *  - Pass A lays each item's FAR edge down. That is only a DEFAULT — a pin against the vertex ring, which would
 *    otherwise re-derive a Bessel tangent from corners the slide moved. Every item reads its far edge off the
 *    same pre-slide curve, so items that share one agree to the bit.
 *  - Pass B lays down the edge each item actually MOVES, plus the four rail handles it rides. An edge is moved by
 *    exactly one item — the one whose quad sits AHEAD of it — so the owner writes last and wins. Two items that
 *    share a rail cut the SAME rail cubic at the same `s`, so their four handles are bit-identical.
 *
 * Skipped, not failed: an item whose quad is a WEDGE (no C–D curve to cut) and an item whose `edge` is not one of
 * the quad's four boundaries. Mutates `doc`.
 */
export function slideEdgesInQuads(doc: QuadMeshDoc, items: readonly EdgeSlideItem[], t: number): void {
  const s = clampT(t);
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const staged: { quad: number; side: QuadSide; cp: V3[] }[] = [];
  for (const { quad, edge } of items) {
    const verts = doc.quads[quad];
    if (!verts || isWedge(verts)) continue;
    const side = quadSide(verts, edge);
    if (!side) continue;
    staged.push({ quad, side, cp: sideSubPatch(quadControlPoints(mesh, edgeHandle, quad, doc.quadTwist?.[quad]), side, s) });
  }
  if (!staged.length) return;
  for (const { quad, side, cp } of staged) writeSideEdge(doc, doc.quads[quad], cp, OPPOSITE_SIDE[side]);
  for (const { quad, side, cp } of staged) {
    const verts = doc.quads[quad];
    writeSideEdge(doc, verts, cp, side);
    for (const rail of RAIL_SIDES[side]) writeSideHandles(doc, verts, cp, rail);
  }
  const after = meshFromDoc(doc);   // the zero-twist base every staged quad's interior offset is measured against
  for (const { quad, cp } of staged) writeQuadTwist(doc, after.mesh, after.edgeHandle, quad, cp);
}

/**
 * Where each end of `edge` is HEADED as it slides across `quad`: `[[from, into], [from, into]]`, the far corner
 * every moved corner arrives at when the slide runs the whole span. It names the rail each end travels along
 * (a drag's direction is decided by which rail agrees with it) and, at the far end, the weld pairs that merge
 * the edge into the one opposite it. `null` when `edge` is not one of the quad's four boundaries, or the quad is
 * a wedge (a collapsed row has no rail to travel).
 *
 * The pairing falls straight out of the storage contract `[A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)]`. The
 * u=0 edge A–B slides down u, and `splitPatchU` cuts the net's COLUMNS: column 0 is (cp0, cp4, cp8, cp12) =
 * A → C and column 3 is (cp3, cp7, cp11, cp15) = B → D. So A rides its own column to C and B rides its to D —
 * each corner keeps its coordinate on the moved edge's own axis and travels along the other. Every side is the
 * same statement re-read: CD (u=1) runs back up its columns to A / B, AC (v=0) runs across its rows to B / D,
 * BD (v=1) runs back to A / C.
 */
export function edgeSlideTargets(quad: readonly number[] | undefined, edge: readonly [number, number]):
  [[number, number], [number, number]] | null {
  if (!quad || isWedge(quad)) return null;
  const side = quadSide(quad, edge);
  if (!side) return null;
  const [A, B, C, D] = quad;
  switch (side) {
    case 'AB': return [[A, C], [B, D]];
    case 'CD': return [[C, A], [D, B]];
    case 'AC': return [[A, B], [C, D]];
    case 'BD': return [[B, A], [D, C]];
  }
}

/**
 * The `[from, into]` weld pairs that finish a `slideEdgesInQuads` gesture dragged past its far end: every moved
 * corner fuses into the corner it arrived at (`edgeSlideTargets`), so `applyVertexWeld` collapses the quads the
 * edge swept through. De-duplicated, because an edge LOOP's neighbouring items share endpoints and each would
 * otherwise name the same fusion twice. Items with nothing to weld (a wedge, a non-boundary edge — exactly the
 * ones the slide itself skipped) contribute nothing.
 *
 * `quads` is the corner table alone — a `QuadMeshDoc`'s `quads`, or the `QuadMesh` a viewport froze at drag-start.
 * The pairing reads nothing else, and a slide never changes the table, so either names the same welds.
 */
export function slideWeldPairs(quads: readonly (readonly number[])[], items: readonly EdgeSlideItem[]): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const { quad, edge } of items) {
    const targets = edgeSlideTargets(quads[quad], edge);
    if (!targets) continue;
    for (const pair of targets) {
      const k = `${pair[0]}>${pair[1]}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(pair);
    }
  }
  return out;
}

/**
 * The `[vertex, toward]` weld pairs that finish a `slideVerticesAlongEdges` gesture dragged past its far end: every
 * item whose `toward` is standing still fuses into it. An item whose `toward` is itself MOVING contributes nothing —
 * a run `A0 → A1, A1 → A2, …, An → A(n+1)` sliding along its loop welds only `An → A(n+1)`, because every earlier
 * item merely vacates a seat its successor has already left. A lone item always welds. De-duplicated, and items with
 * no curve to slide along (`vertex === toward`, a non-finite id — exactly the ones the slide itself skips) are
 * skipped here too.
 *
 * The same rule `slideWeldPairs` and `planCellSlide` already state in their own vocabularies: weld every item whose
 * target is not itself in motion.
 */
export function vertexSlideWeldPairs(items: readonly VertexSlideItem[]): [number, number][] {
  const live = items.filter(({ vertex, toward }) => vertex !== toward && Number.isFinite(vertex) && Number.isFinite(toward));
  const moved = new Set(live.map(it => it.vertex));
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const { vertex, toward } of live) {
    if (moved.has(toward)) continue;
    const k = `${vertex}>${toward}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push([vertex, toward]);
  }
  return out;
}

/**
 * Plan a CELL slide along `dir` (a data-space direction): dragging a face forward moves BOTH of its boundary
 * edges perpendicular to the drag, and every moved edge slides across the quad immediately AHEAD of it. So a cell
 * slide is nothing but `slideEdgesInQuads` fed one item per moved edge, each paired with the quad it crosses:
 *
 *  - the cell's TRAIL edge (the one whose rail agrees with `dir`) slides to parameter `t` inside the cell itself;
 *  - the cell's LEAD edge — its opposite boundary — slides to parameter `t` inside the neighbour `N` beyond it.
 *
 * Items dedupe BY EDGE: two selected cells stacked along the drag share an edge, and it is the front cell's trail
 * and the back cell's lead. Both name the same quad ahead (the front cell), so the two items are the same item.
 *
 * The exactness ledger, stated rather than hidden. `N` — the unselected quad slid INTO — becomes the exact de
 * Casteljau sub-patch of itself; nothing else writes it. A selected cell now spans `[t,1]` of its own patch ∪
 * `[0,t]` of the next, and two G1-joined bicubics are not one bicubic, so a dragged cell CANNOT be surface-exact:
 * its two moved boundary curves are (each is an iso-curve of an original patch at parameter `t`), its rails and
 * interior are a cubic interpolant across the join. The quad behind the selection grows and reshapes, as everywhere.
 *
 * `weld` is the merge a release at the far clamp commits: `edgeSlideTargets` of every item whose quad is NOT a
 * selected cell. That restriction is the crux. At `t → 1` only the leading quads degenerate; a selected cell does
 * not — its trail edge arrives where its lead edge started, but its lead edge has moved on too. Welding a selected
 * cell's own trail into its own lead would collapse the whole selection. Pairs are de-duplicated (cells side by
 * side across the drag share a rail, hence a weld pair).
 *
 * `blocked` when some cell's lead edge has no proper quad beyond it (the rim, or a wedge with no rail to travel):
 * that cell cannot slide forward, so the drag clamps and commits no merge — `weld` comes back empty. The trail
 * item is still emitted, so the caller can preview or refuse. Null when no cell can slide at all: `dir` is
 * degenerate, or every selected cell is a wedge (a collapsed row has no opposite boundary to cut across).
 */
export function planCellSlide(
  mesh: QuadMesh, adj: MeshAdjacency, cells: readonly number[], dir: V3, pos: (id: number) => V3,
): { items: EdgeSlideItem[]; weld: [number, number][]; blocked: boolean } | null {
  if (len(dir) < 1e-12) return null;
  const d = norm(dir);
  const selected = new Set(cells);
  const items: EdgeSlideItem[] = [];
  const byEdge = new Set<string>();
  let blocked = false;

  const push = (quad: number, edge: [number, number]) => {
    const k = ekey(edge[0], edge[1]);
    if (byEdge.has(k)) return;     // an edge is moved once, and the quad ahead of it is decided by `dir` alone
    byEdge.add(k);
    items.push({ quad, edge });
  };

  for (const Q of cells) {
    const verts = mesh.quads[Q];
    if (!verts || isWedge(verts)) continue;
    // The TRAIL edge is the boundary whose rail heads most nearly along the drag — the edge that travels forward
    // INSIDE Q. Rails are normalised first, so this asks which axis agrees with `dir`, not which rail is longest.
    let trailSide: QuadSide | null = null, best = 0;
    for (const side of SIDES) {
      const targets = edgeSlideTargets(verts, sideEdge(verts, side))!;   // a proper quad's four sides all have rails
      const agree = dot(norm(sub(pos(targets[0][1]), pos(targets[0][0]))), d);
      if (agree > best) { best = agree; trailSide = side; }
    }
    if (!trailSide) continue;      // `dir` runs across both axes, or backwards along both: nothing leads
    push(Q, sideEdge(verts, trailSide));

    const lead = sideEdge(verts, OPPOSITE_SIDE[trailSide]);
    const N = (adj.edgeQuads.get(ekey(lead[0], lead[1])) ?? []).find(q => q !== Q);
    if (N === undefined || isWedge(mesh.quads[N])) { blocked = true; continue; }
    push(N, lead);
  }
  if (!items.length) return null;

  const weld: [number, number][] = [];
  if (!blocked) {
    const seen = new Set<string>();
    for (const { quad, edge } of items) {
      if (selected.has(quad)) continue;                     // a dragged cell survives the clamp; only its target dies
      for (const pair of edgeSlideTargets(mesh.quads[quad], edge) ?? []) {
        const k = `${pair[0]}>${pair[1]}`;
        if (seen.has(k)) continue;
        seen.add(k);
        weld.push(pair);
      }
    }
  }
  return { items, weld, blocked };
}

/** One re-cut of a drag frame: a batch of edges across their quads, a batch of vertices along their edges, the
 *  lone-corner 2-D placement, or the `place` correction that seats the moved vertices on the 2-D law's own points.
 *  The first three shape TANGENTS as well as positions; `place` only calls `setVertex`. */
export type SlidePass =
  | { kind: 'edges'; items: EdgeSlideItem[]; t: number }
  | { kind: 'verts'; items: VertexSlideItem[] }
  | { kind: 'patch'; quad: number; vertex: number; towardU: number; tu: number; towardV: number; tv: number }
  | { kind: 'place'; items: VertexPlaceItem[] };

/** One drag frame's whole re-cut, plus the weld a release at the clamp commits. */
export interface SlidePlan {
  passes: SlidePass[];
  weld: [number, number][];
}

/**
 * Run a drag frame's passes against `doc` — the shaping passes in the order given (the u-pass, then the v-pass), then
 * every `place` pass. The caller hands this a fresh clone of the FROZEN drag-start document every frame: a re-cut of a
 * re-cut composes (0.5 of [0.5,1] is 0.75 of the parent), so a plan applied to its own output runs away from the cursor.
 *
 * `place` runs LAST because it is the answer, not a step toward it. A shaping pass reads vertex positions to derive its
 * cut, so a correction written before one would simply be re-cut away; and the correction's own points are read off the
 * frozen base, so nothing it needs can go stale. What the shaping passes contribute is the TANGENTS: each pins the
 * directed handles of the curves it re-cut, and a handle is an offset from its vertex, so it rides along when `place`
 * seats the corner. What they cannot contribute is the positions — a `u`-pass followed by a `v`-pass drags the two
 * corners it did not re-cut in `v` back down a chord toward a neighbour that never moved.
 *
 * The v-pass earns its keep on the curves BETWEEN the corners. Its cut leaves each moved boundary the parent's own
 * iso-curve tangent at the cut parameter, where the u-pass alone leaves the tangent it had a whole cell away.
 *
 * `plan.weld` is not touched here. A merge retires vertices and collapses quads, which re-numbers the ids every pass
 * in the plan names; the host commits it once, on pointer-up, against the finished geometry.
 *
 * Why the v-pass reads the doc the u-pass WROTE, rather than a frozen copy: a `slideEdges` u-pass leaves each quad it
 * names the exact de Casteljau sub-patch of itself, so the moved boundary IS the parent's own `u = tu` iso-curve, and
 * cutting THAT at `tv` lands on the surface. Cutting the parent's `u = 0` boundary instead would land a whole `tu` off it.
 *
 * A 'patch' pass is the lone-corner case: one call carries both axes, placing the vertex on its quad's own patch point,
 * so it is already `place` and its tangents in one and needs no correction after it.
 */
export function applySlidePlan(doc: QuadMeshDoc, plan: SlidePlan): { ok: true } | { ok: false; error: string } {
  for (const pass of plan.passes) {
    if (pass.kind === 'edges') slideEdgesInQuads(doc, pass.items, pass.t);
    else if (pass.kind === 'verts') slideVerticesAlongEdges(doc, pass.items);
    else if (pass.kind === 'patch') slideVertexOnPatch(doc, pass.quad, pass.vertex, pass.towardU, pass.tu, pass.towardV, pass.tv);
  }
  for (const pass of plan.passes) {
    if (pass.kind !== 'place') continue;
    for (const { vertex, pos } of pass.items) if (Number.isFinite(vertex)) setVertex(doc, vertex, pos);
  }
  return { ok: true };
}
