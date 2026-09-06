
import type { V3 } from '../doc/types';
import { add, dot, len, mul, norm, sub } from '../math/vec';
import { cubicPoint, nearestCubicT, patchPoint } from '../math/bezier';
import { quadControlPoints, vertexAxes, type EdgeHandle, type MeshAdjacency, type QuadMesh } from './topology';
import { ekey } from './ops';
import { readVertex } from './primitives';
import {
  SLIDE_EPS, SLIDE_MERGE_SNAP, edgeSlideTargets, planCellSlide, slideQuadrantTargets, slideWeldPairs, vertexSlideWeldPairs,
  type EdgeSlideItem, type SlidePass, type SlidePlan, type VertexSlideItem,
} from './slide';

/**
 * The Surface-mode gizmo's exact slide, planned (docs/006; the geometry itself lives in core/mesh/slide.ts). One drag
 * frame in — the frozen drag-start net and the pointer — one `SlidePlan` out, for the host to apply to a fresh clone
 * of its own frozen document. Nothing here reads the scene, the gizmo or the live doc: the viewport seats a
 * `SlideExact` at pointer-down and this module is a function of it, which is why a drag frame is reproducible and a
 * long drag accumulates no drift.
 *
 * The gizmo offers three slide handles, and they are one gesture with one or both axes engaged:
 *  • the in-plane ARROWS 'X' (down-mountain, `tu`) and 'Z' (cross-slope, `padV`) drive one axis and zero the other;
 *  • the 'XZ' tangent PAD drives both, and its parameters come out of the same rails the arrows read.
 *
 * The exactness ledger, per family and per axis count:
 *  | selection | one axis                                            | two axes                                   |
 *  |-----------|-----------------------------------------------------|--------------------------------------------|
 *  | corner    | the edge CURVE over [t,1] is bit-exact               | the vertex is exactly on its quadrant patch|
 *  | edge/loop | every listed quad's SURFACE is bit-exact             | every moved endpoint is on the surface     |
 *  | cell(s)   | the unselected quad slid INTO is bit-exact          | every moved rim vertex is on the surface   |
 * A two-axis drag re-parameterises nothing (a moved cell's footprint straddles four parent patches, and four
 * G1-joined bicubics are not one bicubic), but no vertex it moves ever leaves the parent surface, and no ray is cast
 * — so it holds on the overhangs and cave roofs a down-ray cannot reach. Let either parameter fall back below
 * `SLIDE_EPS` and its pass drops out, restoring the one-axis row of the table above, bit for bit.
 */

/**
 * The frozen parent net a Surface-mode slide re-cuts against. A slide is a de Casteljau RE-CUT, not a translate:
 * every drag frame measures its parameters against THIS net, never against the previous frame's result.
 *
 * `mesh` / `eh` / `twist` are COPIES taken at drag-start — the host replaces its document each frame, and the re-cut
 * is only exact against the net the drag opened on. `anchor0` is the gizmo anchor's data-space seat.
 *
 * The surface axes come in two flavours, and both are load-bearing:
 *  • `tu` / `tv` are the frame's own AXIS TANGENTS, oriented so `vertexAxes`' `u[0] → u[1]` runs along `tu` and
 *    `v[0] → v[1]` along `tv`. Their sign against a drag is what names the neighbour a corner slides toward.
 *  • `tu` / `padV` are the gizmo's own X and Z arrows in data space, an ORTHONORMAL pair (`padV = n × tu`, which is
 *    what `frameQuat` builds the gizmo's local Z from). A pad drag resolves into these, so its two coordinates are
 *    independent and stripping one leaves the other untouched.
 * On a skewed net `tv` and `padV` are neither parallel nor even same-signed — `vertexFrame` crosses `tv × tu` and
 * flips the result skyward, so the blue arrow generally runs against the raw `tv`. Reading a pad coordinate off `tv`,
 * or a neighbour's side off `padV`, silently inverts the drag on half the meshes.
 *
 * Exactly one of `vertex` (a lone corner), `edges` (an edge or an edge loop) and `cells` (a face selection) is
 * populated — a corner REGION re-parameterises nothing and never seats one of these.
 */
export interface SlideExact {
  mesh: QuadMesh;
  eh: EdgeHandle;
  adj: MeshAdjacency;
  twist?: Record<number, [V3, V3, V3, V3]>;
  anchor0: V3;
  tu: V3;                       // down-mountain axis tangent = the gizmo's X arrow (unit)
  tv: V3;                       // cross-slope axis tangent, orienting `vertexAxes`' v pair (unit)
  padV: V3;                     // the gizmo's Z arrow, `n × tu` (unit, ⟂ tu) — the pad's second coordinate
  vertex: number;               // the slid corner, or -1 when an edge / cell selection is sliding
  edges: [number, number][];    // the slid edge / edge loop, empty for a corner / a cell
  cells: number[];              // the slid cell selection (quad ids), empty for a corner / an edge
}

/**
 * One drag frame resolved into the pad's own orthonormal frame. `du` / `dv` are the pointer's travel along the two
 * gizmo arrows; an ARROW drag zeroes the axis it does not own, which is exactly what makes a pure-axis pad drag and
 * the matching arrow read the same parameter.
 *
 * `pu` is the pointer with the OTHER axis's travel stripped out, so projecting it onto the u rail measures the u drag
 * alone (and `pv` symmetrically). Under an arrow the stripped component is a literal zero, so `pu` IS the pointer and
 * the whole 1-D path comes out bit-identical. `dirU` / `dirV` are the same statement as vectors — `p_axis − anchor0`
 * — which is the drag vector itself under the arrow, so the quad searches see what they always saw.
 */
export interface SlideDrag {
  du: number; dv: number;
  uOn: boolean; vOn: boolean;   // the axis carries enough travel to name a direction
  dirU: V3; dirV: V3;           // the signed per-axis drag vectors (`p_axis − anchor0`)
  pu: V3; pv: V3;               // the pointer, one axis's travel removed
}

/** One axis of a drag frame against the frozen net: whether the drag rides it, whether it has anywhere to go (a rim,
 *  or a wedge ahead, pins it at `t = 0` and forbids its merge), and its raw parameter on its own rail. */
interface SlideAxis { on: boolean; blocked: boolean; raw: number }

/** Which passes a resolved pair of axes emits, at which parameters, and which one merges. */
interface SlideAxesPlan { tu: number; tv: number; uPass: boolean; vPass: boolean; place: boolean; mergeU: boolean; mergeV: boolean }

/** One frame of a slide, resolved: the re-cut the host applies, where the gizmo anchor is parked (on the geometry,
 *  not a hair off it), and whether the cursor has run PAST a far end (a release there merges). */
export interface SlideCut { plan: SlidePlan; pos: V3; merge: boolean }

/** The travel below which an axis has not yet committed to a sign — the drag names no neighbour, so the frozen net
 *  simply stands. An arrow's other axis is a literal zero and always sits here. */
const SLIDE_DEADZONE = 1e-9;

/** The bound core/mesh/slide.ts holds the geometry to — mirrored here only so the gizmo anchor is parked at the same point
 *  the doc was re-cut to, never a hair past it. */
const clampSlideT = (t: number) => Math.min(Math.max(t, SLIDE_EPS), 1 - SLIDE_EPS);

/** Corner slot A/B/C/D → its patch parameter, the storage contract [A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)] read
 *  as coordinates. The planner's copy of core/mesh/slide.ts's own table: the gizmo parks on the point a `patch` pass
 *  writes, and that point is a `patchPoint` at the fold below. */
const SLIDE_CORNER_UV: readonly (readonly [number, number])[] = [[0, 0], [0, 1], [1, 0], [1, 1]];

/** An axis the drag does not ride: no pass, no parameter, no merge. */
const AXIS_OFF: SlideAxis = { on: false, blocked: false, raw: 0 };

/**
 * Resolve a drag frame's two raw parameters into the passes one `SlidePlan` carries. Uniform across the three
 * selection families, because the merge law is a statement about the DRAG, not about what it is dragging.
 *
 *  • **Saturating one axis merges; saturating both merges nothing.** At both clamps the dragged thing has arrived at
 *    the quadrant quad's FAR corner, so the weld the geometry asks for is the one into that corner — the DIAGONAL
 *    fusion `applyVertexWeld` refuses, since a quad encodes the edge-collapsed wedge `[A,B,C,C]` and nothing else.
 *    Naming the two rail neighbours instead does pass the guard, but they are that same diagonal pair, so union-find
 *    fuses all three and drops the corner most of a cell back onto a rail it had just crossed. The drag clamps.
 *  • **A merge arms only from near the other axis's rail** (`SLIDE_MERGE_SNAP`). Mid-way along the link edge the
 *    dragged thing has arrived at no vertex at all, and a quad mesh has no legal T-junction; welding there would
 *    teleport it back up the edge it just crossed. Past the snap the far range is a wall the drag clamps against.
 *  • **A merging axis pins the other at zero**, dropping its pass and the `place` correction — so the committed
 *    geometry sits ON the weld target instead of springing back off it, and the merge path is the 1-D path.
 *  • **An axis riding ALONE always emits.** That is the in-plane arrow: it emits a blocked rim slide (`t = 0`, whose
 *    geometry is the clamp's own ε step) and a sub-ε nudge exactly as the 1-D slide does, so the arrows are unchanged.
 *  • **An axis sharing the drag emits only when it is LIVE** — unblocked and past `SLIDE_EPS`. Below that the clamp
 *    would invent an ε step the cursor never asked for, so the axis (and the `place` pass with it) drops out and the
 *    pad reduces, bit for bit, to the 1-D slide down the axis that survives.
 */
function resolveSlideAxes(u: SlideAxis, v: SlideAxis): SlideAxesPlan {
  const satU = u.on && !u.blocked && u.raw >= 1 - SLIDE_EPS;
  const satV = v.on && !v.blocked && v.raw >= 1 - SLIDE_EPS;
  if (satU && !satV && v.raw <= SLIDE_MERGE_SNAP) return { tu: u.raw, tv: 0, uPass: true, vPass: false, place: false, mergeU: true, mergeV: false };
  if (satV && !satU && u.raw <= SLIDE_MERGE_SNAP) return { tu: 0, tv: v.raw, uPass: false, vPass: true, place: false, mergeU: false, mergeV: true };
  const uLive = u.on && !u.blocked && u.raw > SLIDE_EPS;
  const vLive = v.on && !v.blocked && v.raw > SLIDE_EPS;
  const uPass = uLive || (u.on && !v.on);
  const vPass = vLive || (v.on && !u.on);
  return { tu: uPass ? u.raw : 0, tv: vPass ? v.raw : 0, uPass, vPass, place: uLive && vLive, mergeU: false, mergeV: false };
}

/** Every vertex a batch of edges moves — their endpoints, each once. These are the `place` pass's subjects: the
 *  selected edges' own ends for an edge drag, and for a cell drag the endpoints of every item `planCellSlide` emitted,
 *  which is the selection's whole moved rim (a face carries BOTH of its boundaries forward). */
function slideEdgeVerts(edges: readonly (readonly number[])[]): number[] {
  const seen = new Set<number>();
  for (const e of edges) { seen.add(e[0]); seen.add(e[1]); }
  return [...seen];
}

/** A frozen vertex position (the drag-start net, data space). */
export function frozenPos(s: SlideExact, id: number): V3 {
  return readVertex(s.mesh.vertices, id);
}

/** The frozen `from → to` boundary cubic, COPIED so it starts at the gizmo anchor — the parent spline moved onto the
 *  handle the user is holding. For a lone corner the anchor sits on `from`, so the copy is the curve itself and its
 *  point at t is exactly where the corner lands; for an edge the anchor rides the selection's centroid, and the copy
 *  turns the anchor's travel into the same parameter the re-cut consumes. */
function frozenRail(s: SlideExact, from: number, to: number): [V3, V3, V3, V3] {
  const A = frozenPos(s, from), B = frozenPos(s, to);
  const o = sub(s.anchor0, A);
  return [add(A, o), add(add(A, s.eh(from, to)), o), add(add(B, s.eh(to, from)), o), add(B, o)];
}

/** Where a rail's cubic carries the anchor at parameter `t`, held inside the bound core/mesh/slide.ts clamps the geometry
 *  to — so the gizmo parks on the point the doc was re-cut to. */
const railPoint = (rail: [V3, V3, V3, V3], t: number): V3 => cubicPoint(rail[0], rail[1], rail[2], rail[3], clampSlideT(t));

/** Where the anchor lands when both axes moved: each rail's own travel, summed. A rail's cubic already starts AT the
 *  anchor (`frozenRail`), so its travel is `point − anchor0`. One rail alone parks straight on its own point — the
 *  1-D slide's landing, to the bit. */
function railSum(s: SlideExact, qu: V3 | null, qv: V3 | null): V3 | null {
  if (qu && qv) return add(s.anchor0, add(sub(qu, s.anchor0), sub(qv, s.anchor0)));
  return qu ?? qv;
}

/** How far a frozen vertex sits from the gizmo anchor, squared — the "which one is under the user's hand" test. */
function anchorDistSq(s: SlideExact, id: number): number {
  const r = sub(frozenPos(s, id), s.anchor0);
  return dot(r, r);
}

/** The `[from, to]` rail the shared parameter is read off: of every moved corner in the run, the one nearest the gizmo
 *  anchor, riding toward the far corner it would arrive at. Nearest, because that is the edge under the user's hand;
 *  any of them would do, since the sub-patch cut moves them all to the same parameter. */
function leadSlideRail(s: SlideExact, items: readonly EdgeSlideItem[]): [number, number] | null {
  let bestPair: [number, number] | null = null, bestD = Infinity;
  for (const { quad, edge } of items) {
    const targets = edgeSlideTargets(s.mesh.quads[quad], edge);
    if (!targets) continue;
    for (const [from, to] of targets) {
      const q = anchorDistSq(s, from);
      if (q < bestD) { bestD = q; bestPair = [from, to]; }
    }
  }
  return bestPair;
}

/** Each selected edge paired with the quad AHEAD of it along `dir`: `edgeSlideTargets` names the far corner every
 *  endpoint rides toward, and the direction of that ride, dotted with the drag, is the test. A rim edge has one quad,
 *  so dragging away from it has nowhere to go — the whole loop is then `blocked` and clamps at `t → 0`, because a loop
 *  cannot split across a rim. */
function edgeSlideItems(s: SlideExact, dir: V3): { items: EdgeSlideItem[]; blocked: boolean } {
  const items: EdgeSlideItem[] = [];
  let blocked = false;
  for (const e of s.edges) {
    let ahead = -1, best = 0, any = -1;
    for (const q of s.adj.edgeQuads.get(ekey(e[0], e[1])) ?? []) {
      const targets = edgeSlideTargets(s.mesh.quads[q], e);
      if (!targets) continue; // a wedge / a non-boundary edge — exactly what slideEdgesInQuads skips
      if (any < 0) any = q;
      const rail = sub(frozenPos(s, targets[0][1]), frozenPos(s, targets[0][0]));
      const k = dot(rail, dir);
      if (k > best) { best = k; ahead = q; }
    }
    if (ahead >= 0) items.push({ quad: ahead, edge: e });
    else if (any >= 0) { items.push({ quad: any, edge: e }); blocked = true; }
  }
  return { items, blocked };
}

/** Each of `verts` paired with the ring neighbour it slides toward along `dir` — the one whose direction agrees most,
 *  and strictly agrees at all. A vertex with none is dropped: at a rim there is no curve that way. `t` is a
 *  placeholder the caller overwrites with the axis's shared parameter, once its rail has named one. */
function vertexSlideItems(s: SlideExact, verts: readonly number[], dir: V3): VertexSlideItem[] {
  if (len(dir) < 1e-12) return [];
  const d = norm(dir);
  const out: VertexSlideItem[] = [];
  for (const V of verts) {
    let toward = -1, best = 0;
    for (const n of s.adj.neighbors[V] ?? []) {
      const w = sub(frozenPos(s, n), frozenPos(s, V));
      if (len(w) < 1e-12) continue;
      const a = dot(norm(w), d);
      if (a > best) { best = a; toward = n; }
    }
    if (toward >= 0) out.push({ vertex: V, toward, t: 0 });
  }
  return out;
}

/** The endpoint closest to the handle is the selection's lead along-edge rail. Keeping this choice shared between
 *  the gizmo and the planner makes the curve drawn under the handle the exact curve used to read the drag. */
function leadVertexSlideItem(s: SlideExact, items: readonly VertexSlideItem[]): VertexSlideItem | null {
  return items.length ? items.reduce((a, b) => anchorDistSq(s, a.vertex) <= anchorDistSq(s, b.vertex) ? a : b) : null;
}

/** Which of the two gizmo arrows the SELECTED EDGES travel down: their mean rail direction, unsigned (an edge's rail
 *  points opposite ways in its two quads, and a loop's edges need not agree either) against the pad's own orthonormal
 *  axes. The winner slides the edges ACROSS their quads; the loser slides their endpoints ALONG. */
function edgesRunAcross(s: SlideExact): boolean {
  let au = 0, av = 0;
  for (const e of s.edges) {
    for (const q of s.adj.edgeQuads.get(ekey(e[0], e[1])) ?? []) {
      const targets = edgeSlideTargets(s.mesh.quads[q], e);
      if (!targets) continue;
      const r = norm(sub(frozenPos(s, targets[0][1]), frozenPos(s, targets[0][0])));
      au += Math.abs(dot(r, s.tu)); av += Math.abs(dot(r, s.padV));
      break; // one quad names the rail's axis; the other names its negation
    }
  }
  return au >= av;
}

/** The corner's QUADRANT quad: the one quad carrying both the `nu` and the `nv` rail, so its interior lies in the
 *  drag's `+u,+v` corner. A rim corner has none, and a pole fan's rails can be spread across two quads. −1 then. */
function quadrantQuad(s: SlideExact, V: number, nu: number, nv: number): number {
  const qv = s.adj.edgeQuads.get(ekey(V, nv)) ?? [];
  const q = (s.adj.edgeQuads.get(ekey(V, nu)) ?? []).find(x => qv.includes(x));
  return q === undefined ? -1 : q;
}

/** The point a `patch` pass seats `V` at: `quad`'s own bicubic at the two slide parameters, folded onto the
 *  coordinates the two rails actually move (a corner sitting at 0 runs forward to `t`, one at 1 runs back to `1 − t`)
 *  — the fold `slideVertexOnPatch` applies, restated so the gizmo parks ON the corner it just wrote. Null when the
 *  three vertices are not a corner of `quad` and its two CYCLE-adjacent neighbours on different axes (a diagonal, a
 *  repeat, a stranger), or `quad` is a WEDGE whose collapsed row carries no second axis — exactly the cases
 *  `slideVertexOnPatch` refuses, so a null here is the signal to slide one axis instead. */
function quadrantPoint(s: SlideExact, quad: number, V: number, nu: number, nv: number, tu: number, tv: number): V3 | null {
  const verts = s.mesh.quads[quad];
  if (!verts || verts[2] === verts[3]) return null;
  const sV = verts.indexOf(V), sU = verts.indexOf(nu), sW = verts.indexOf(nv);
  if (sV < 0 || sU < 0 || sW < 0) return null;
  const uv = SLIDE_CORNER_UV[sV];
  /** The ONE coordinate two corner slots differ in (0 = u, 1 = v), or −1 for the diagonal / the same corner. */
  const slotAxis = (b: readonly [number, number]): number => {
    const du = uv[0] !== b[0], dv = uv[1] !== b[1];
    return du === dv ? -1 : du ? 0 : 1;
  };
  const cU = slotAxis(SLIDE_CORNER_UV[sU]), cW = slotAxis(SLIDE_CORNER_UV[sW]);
  if (cU < 0 || cW < 0 || cU === cW) return null;
  const at: [number, number] = [uv[0], uv[1]];
  at[cU] = uv[cU] === 0 ? clampSlideT(tu) : 1 - clampSlideT(tu);
  at[cW] = uv[cW] === 0 ? clampSlideT(tv) : 1 - clampSlideT(tv);
  const P = patchPoint(quadControlPoints(s.mesh, s.eh, quad, s.twist?.[quad]), at[0], at[1]);
  return add(P, sub(s.anchor0, frozenPos(s, V))); // the corner's own point, moved onto the handle the user holds
}

/**
 * The rail a pure-axis drag down `dir` reads its parameter off, copied onto the gizmo anchor. It is the curve the
 * ANCHOR itself travels: `railPoint(rail, t)` is exactly the seat `planSlideRecut` parks it on, at every `t` the drag
 * can reach. So the Surface arrow is drawn as this cubic and means it — its head is the neighbour the drag clamps and
 * merges at, and its shaft is where the corner (or the selection's lead corner) will actually go.
 *
 * Null where the drag has nowhere to go: past a rim, into a wedge, or off a corner REGION, whose four unrelated
 * corners re-parameterise no curve. Those directions keep the gizmo's straight arrow, which is the honest picture —
 * the drag clamps there and the net stands.
 */
export function slideRail(s: SlideExact, dir: V3): [V3, V3, V3, V3] | null {
  if (s.vertex >= 0) {
    // the corner's own edges: which axis `dir` rides, then which end of that axis pair it heads for. The SIDE comes
    // off the frame's raw tangents — `vertexAxes` orients its pairs by them — exactly as `planCornerSlide` seats it.
    const { u, v } = vertexAxes(s.adj, s.vertex);
    const onU = Math.abs(dot(dir, s.tu)) >= Math.abs(dot(dir, s.padV));
    const pair = onU ? u : v;
    const toward = (onU ? dot(dir, s.tu) : dot(dir, s.tv)) > 0 ? pair[1] : pair[0];
    return toward < 0 ? null : frozenRail(s, s.vertex, toward);
  }
  if (s.edges.length) {
    const onU = Math.abs(dot(dir, s.tu)) >= Math.abs(dot(dir, s.padV));
    if (onU !== edgesRunAcross(s)) {
      const lead = leadVertexSlideItem(s, vertexSlideItems(s, slideEdgeVerts(s.edges), dir));
      return lead ? frozenRail(s, lead.vertex, lead.toward) : null;
    }
  }
  const found = s.cells.length ? planCellSlide(s.mesh, s.adj, s.cells, dir, id => frozenPos(s, id))
    : s.edges.length ? edgeSlideItems(s, dir)
    : null;
  if (!found || found.blocked || !found.items.length) return null;
  const lead = leadSlideRail(s, found.items);
  return lead && frozenRail(s, lead[0], lead[1]);
}

/**
 * Resolve the dragged anchor `p` (data space) into the pad's two coordinates. Null while neither axis has committed
 * to a sign — there is no neighbour to name then, so the frozen net simply stands. `ax` is the gizmo handle: an arrow
 * forces its own axis and zeroes the other, which is what makes `pu` (or `pv`) the pointer itself and reproduces the
 * 1-D slide bit for bit; the pad keeps both, and stripping each axis's travel from the other's probe point is what
 * makes a pure-axis pad drag read the same parameter the matching arrow reads.
 */
export function slideDragFrame(s: SlideExact, ax: 'X' | 'Z' | 'XZ', p: V3): SlideDrag | null {
  const d = sub(p, s.anchor0);
  const du = ax === 'Z' ? 0 : dot(d, s.tu);
  const dv = ax === 'X' ? 0 : dot(d, s.padV);
  const uOn = Math.abs(du) >= SLIDE_DEADZONE, vOn = Math.abs(dv) >= SLIDE_DEADZONE;
  if (!uOn && !vOn) return null;
  const pu = vOn ? sub(p, mul(s.padV, dv)) : p;
  const pv = uOn ? sub(p, mul(s.tu, du)) : p;
  return { du, dv, uOn, vOn, dirU: sub(pu, s.anchor0), dirV: sub(pv, s.anchor0), pu, pv };
}

/** One drag frame's whole re-cut: the family the selection belongs to picks the planner. Null when the drag has
 *  nowhere to go at all (no rail, no quad ahead, every cell a wedge) — the frozen net stands and the anchor is left
 *  where the gizmo put it. */
export function planSlideRecut(s: SlideExact, g: SlideDrag): SlideCut | null {
  if (s.vertex >= 0) return planCornerSlide(s, g);
  if (s.cells.length) return planCellsSlide(s, g);
  return planEdgesSlide(s, g);
}

/**
 * A single corner slides along its own edges. `vertexAxes` orients each axis pair so its tangent runs from `[0]`
 * toward `[1]`, so the sign of the drag against the frame's own `tu` / `tv` (NOT the gizmo's orthonormal `padV`,
 * which generally runs against `tv`) names the neighbour it heads for. The chosen side can be OFF the net at a rim
 * vertex: there is no curve that way, so that axis pins at its own near end and the corner holds — a slide can never
 * leave the surface it re-parameterises. An axis with no edge at all is not an axis.
 *
 * With BOTH axes live the corner takes a single `patch` pass, not a composition of two curve-splits: after a u-cut the
 * v-edge is a chord across the quad's interior, not the patch's `u = tu` iso-curve, so cutting it lands off the
 * surface — and u-then-v ≠ v-then-u by a wide margin. `slideVertexOnPatch` places the corner on its QUADRANT quad's
 * own patch point instead, which is `place` and its tangents in one, and no separate correction follows it. A rim
 * corner or a pole fan carries no quadrant quad (no single quad holds both rails, cycle-adjacent, on different axes):
 * the DOMINANT axis then slides alone, which is the 1-D gesture the user already knows.
 */
function planCornerSlide(s: SlideExact, g: SlideDrag): SlideCut | null {
  const { u, v } = vertexAxes(s.adj, s.vertex);
  /** One axis: the neighbour the drag heads for (with the rim's near-end fallback), its frozen rail, its state. */
  const seat = (pair: [number, number], on: boolean, forward: boolean, probe: V3) => {
    if (!on) return null;
    const ahead = forward ? pair[1] : pair[0];
    const toward = ahead >= 0 ? ahead : forward ? pair[0] : pair[1];
    if (toward < 0) return null; // no edge at all on this axis: nothing to slide along
    const rail = frozenRail(s, s.vertex, toward);
    const raw = ahead >= 0 ? nearestCubicT(rail[0], rail[1], rail[2], rail[3], probe) : 0;
    return { toward, rail, st: { on: true, blocked: ahead < 0, raw } as SlideAxis };
  };
  const U = seat(u, g.uOn, g.du > 0, g.pu);
  const V = seat(v, g.vOn, dot(g.dirV, s.tv) > 0, g.pv);
  if (!U && !V) return null;

  let r = resolveSlideAxes(U?.st ?? AXIS_OFF, V?.st ?? AXIS_OFF);
  if (r.place && U && V) {
    const quad = quadrantQuad(s, s.vertex, U.toward, V.toward);
    const pos = quad < 0 ? null : quadrantPoint(s, quad, s.vertex, U.toward, V.toward, r.tu, r.tv);
    if (pos) return {
      plan: { passes: [{ kind: 'patch', quad, vertex: s.vertex, towardU: U.toward, tu: r.tu, towardV: V.toward, tv: r.tv }], weld: [] },
      pos, merge: false, // a corner inside its quadrant quad has arrived at no vertex: there is nothing to fuse with
    };
    const uDom = Math.abs(g.du) >= Math.abs(g.dv); // no quadrant quad: the axis the drag leans on carries it alone
    r = resolveSlideAxes(uDom ? U.st : AXIS_OFF, uDom ? AXIS_OFF : V.st);
  }
  // exactly one axis survives here: `place` was the only branch that emitted two, and a merge pins the other at 0
  const A = r.uPass && U ? { ...U, t: r.tu } : r.vPass && V ? { ...V, t: r.tv } : null;
  if (!A) return null;
  // t = 1 is the neighbour itself: the cursor's foot only reaches an end when it has run to or past it, and
  // `slideVerticesAlongEdges` clamps short of it, so the drag holds there and a release merges the two.
  const merge = r.mergeU || r.mergeV;
  return {
    plan: { passes: [{ kind: 'verts', items: [{ vertex: s.vertex, toward: A.toward, t: A.t }] }], weld: merge ? [[s.vertex, A.toward]] : [] },
    pos: railPoint(A.rail, A.t),
    merge,
  };
}

/**
 * An edge (or a whole edge loop) has two independent motions, and which axis drives which is a property of the
 * SELECTION, not of the gizmo: it slides ACROSS the quads it borders (surface-exact — each becomes the de Casteljau
 * sub-patch of itself), and its endpoints slide ALONG it (curve-exact per endpoint). So the ACROSS axis is the one the
 * selection's own rails run down (`edgesRunAcross`), and the ALONG axis is the other.
 *
 * A lone engaged axis keeps that same role: the across arrow re-cuts adjacent quads and the along arrow runs the
 * endpoints down their selected-edge direction. This is also the distinction `slideRail` uses to draw each arrow.
 *
 * One `t` drives every across item — that is what `slideEdgesInQuads` cuts with, each quad at the same parameter of
 * its own span — and it comes from the rail at the edge nearest the gizmo anchor, the edge under the user's hand. The
 * along parameter comes from the endpoint nearest that same anchor, riding toward its own next vertex. With both live,
 * a `place` pass then seats every endpoint on its quadrant quad's exact patch point: the composed passes leave the
 * TRAILING endpoint on the parent surface and drag the LEADING one back down a chord to a vertex the across pass
 * never moved, so the positions come from the law and the passes only shape the tangents.
 */
function planEdgesSlide(s: SlideExact, g: SlideDrag): SlideCut | null {
  const acrossU = edgesRunAcross(s);
  const [onA, onB] = acrossU ? [g.uOn, g.vOn] : [g.vOn, g.uOn];
  const [dirA, dirB] = acrossU ? [g.dirU, g.dirV] : [g.dirV, g.dirU];
  const [probeA, probeB] = acrossU ? [g.pu, g.pv] : [g.pv, g.pu];
  const ends = slideEdgeVerts(s.edges);

  let across: { items: EdgeSlideItem[]; rail: [V3, V3, V3, V3]; st: SlideAxis } | null = null;
  if (onA) {
    const { items, blocked } = edgeSlideItems(s, dirA);
    const lead = items.length ? leadSlideRail(s, items) : null;
    if (lead) {
      const rail = frozenRail(s, lead[0], lead[1]);
      across = { items, rail, st: { on: true, blocked, raw: blocked ? 0 : nearestCubicT(rail[0], rail[1], rail[2], rail[3], probeA) } };
    }
  }
  let along: { items: VertexSlideItem[]; rail: [V3, V3, V3, V3]; st: SlideAxis } | null = null;
  if (onB) {
    const items = vertexSlideItems(s, ends, dirB);
    const near = leadVertexSlideItem(s, items);
    if (near) {
      const rail = frozenRail(s, near.vertex, near.toward);
      along = { items, rail, st: { on: true, blocked: false, raw: nearestCubicT(rail[0], rail[1], rail[2], rail[3], probeB) } };
    }
  }
  const stA = across?.st ?? AXIS_OFF, stB = along?.st ?? AXIS_OFF;
  const r = resolveSlideAxes(acrossU ? stA : stB, acrossU ? stB : stA);
  const [passA, tA, mergeA] = acrossU ? [r.uPass, r.tu, r.mergeU] : [r.vPass, r.tv, r.mergeV];
  const [passB, tB, mergeB] = acrossU ? [r.vPass, r.tv, r.mergeV] : [r.uPass, r.tu, r.mergeU];

  const passes: SlidePass[] = [];
  if (passA && across) passes.push({ kind: 'edges', items: across.items, t: tA });
  const alongItems = along ? along.items.map(it => ({ ...it, t: tB })) : [];
  if (passB && along) passes.push({ kind: 'verts', items: alongItems });
  if (r.place) passes.push({ kind: 'place', items: slideQuadrantTargets(s.mesh, s.eh, s.adj, ends, g.dirU, g.dirV, r.tu, r.tv, s.twist) });

  const pos = railSum(s, passA && across ? railPoint(across.rail, tA) : null, passB && along ? railPoint(along.rail, tB) : null);
  if (!pos) return null; // no quad ahead of any edge and no endpoint to run along: the frozen net stands
  return {
    // the across merge fuses each moved corner into the far corner it arrived at; the along merge fuses only the run's
    // LEAD endpoint — every earlier one merely vacates a seat its successor has already left
    plan: { passes, weld: mergeA && across ? slideWeldPairs(s.mesh.quads, across.items) : mergeB ? vertexSlideWeldPairs(alongItems) : [] },
    pos, merge: r.mergeU || r.mergeV,
  };
}

/**
 * A CELL selection slides forward, and a face carries BOTH of its boundaries: the trail edge re-cuts the cell itself,
 * the lead edge re-cuts the neighbour beyond it, both to the same parameter. `planCellSlide` works out which boundary
 * is which from the drag and hands back the item list — so a cell slide is applied with the SAME `slideEdgesInQuads`
 * call an edge slide makes, and re-plans every frame because dragging back past the anchor swaps trail for lead. The
 * two axes' item lists move DIFFERENT edges (the cell's u boundaries vs its v ones), so the pad runs one plan per
 * axis, in order, and then seats every moved corner with a `place` pass.
 *
 * The exactness ledger. In ONE axis: the unselected quad slid INTO is bit-exact, and the dragged cell's two moved
 * boundary CURVES are exact; the dragged cell's interior sits ~0.04% of a quad diagonal off the parent surface,
 * because it now straddles a G1 seam ([t,1] of its own patch ∪ [0,t] of the next) and two G1-joined bicubics are not
 * one bicubic. In BOTH: every moved VERTEX is exactly on the parent surface (`slideQuadrantTargets` reads the law off
 * the frozen base) and nothing else is. Those are the price of the gesture, not bugs to chase.
 *
 * `plan.weld` names only the LEADING quads' rails: at `t → 1` only they degenerate, while a dragged cell survives one
 * seat forward. `plan.blocked` (a rim cell, nothing proper ahead of it) pins that axis at 0 and commits no merge —
 * the drag stands, exactly as a rim edge's does — leaving the other axis to work.
 */
function planCellsSlide(s: SlideExact, g: SlideDrag): SlideCut | null {
  const seat = (on: boolean, dir: V3, probe: V3) => {
    if (!on) return null;
    const plan = planCellSlide(s.mesh, s.adj, s.cells, dir, id => frozenPos(s, id));
    const lead = plan ? leadSlideRail(s, plan.items) : null;
    if (!plan || !lead) return null; // every cell a wedge, or nothing to ride: this axis is not an axis
    const rail = frozenRail(s, lead[0], lead[1]);
    const raw = plan.blocked ? 0 : nearestCubicT(rail[0], rail[1], rail[2], rail[3], probe);
    return { plan, rail, st: { on: true, blocked: plan.blocked, raw } as SlideAxis };
  };
  const U = seat(g.uOn, g.dirU, g.pu), V = seat(g.vOn, g.dirV, g.pv);
  if (!U && !V) return null;

  const r = resolveSlideAxes(U?.st ?? AXIS_OFF, V?.st ?? AXIS_OFF);
  const passes: SlidePass[] = [];
  if (r.uPass && U) passes.push({ kind: 'edges', items: U.plan.items, t: r.tu });
  if (r.vPass && V) passes.push({ kind: 'edges', items: V.plan.items, t: r.tv });
  if (r.place && U && V) {
    const moved = slideEdgeVerts([...U.plan.items, ...V.plan.items].map(it => it.edge)); // the selection's whole moved rim
    passes.push({ kind: 'place', items: slideQuadrantTargets(s.mesh, s.eh, s.adj, moved, g.dirU, g.dirV, r.tu, r.tv, s.twist) });
  }
  const pos = railSum(s, r.uPass && U ? railPoint(U.rail, r.tu) : null, r.vPass && V ? railPoint(V.rail, r.tv) : null);
  if (!pos) return null;
  return {
    plan: { passes, weld: r.mergeU && U ? U.plan.weld : r.mergeV && V ? V.plan.weld : [] },
    pos, merge: r.mergeU || r.mergeV,
  };
}
