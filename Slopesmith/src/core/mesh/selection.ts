import type { V3 } from '../doc/types';
import { add } from '../math/vec';
import { pushCubicEdge } from '../math/bezier';
import { meshAdjacency, type QuadMesh, type EdgeHandle, type MeshAdjacency } from './topology';
import { faceLoop, faceBlock, type SurfaceTopology } from './surface';
import { canonicalEdge, readVertex, undirectedEdgeKey as ekey } from './primitives';

/**
 * Topology-general SELECTION queries over an authored quad mesh — the same foundation the reference loader
 * (`terrain.ts` `buildReferenceMesh`) exposes for a loaded level, so edge + surface selection reads
 * identically on the authored net and the reference (the reference is just read-only). The reference computes
 * these from position-deduplicated patches, this from the mesh's explicit vertex ids + directed-edge handles,
 * but the outputs are the SAME shape, so ONE viewport renderer draws both.
 *
 * A control-net vertex's INTERIOR-SEAM VALENCE — the count of incident edges shared by two quads (the quilt's
 * seams; a single-quad border edge doesn't count) — classifies it: 4 is regular, 3 / 5 the extraordinary
 * poles this module surfaces as clouds.
 */

/** Extraordinary-pole vertex indices grouped by their interior grid valence. Retaining identity separately
 * from position lets the viewport stream pole dots during a drag without reclassifying stable topology. */
export function meshPoleIndices(mesh: QuadMesh): { extra3: number[]; extra5: number[] } {
  const adj = meshAdjacency(mesh);
  const valence = new Int32Array(mesh.vertexCount);
  for (let a = 0; a < adj.neighbors.length; a++) {
    for (const b of adj.neighbors[a]) {
      if (b < a) continue;
      if ((adj.edgeQuads.get(ekey(a, b)) ?? []).length >= 2) { valence[a]++; valence[b]++; }
    }
  }
  const extra3: number[] = [], extra5: number[] = [];
  for (let i = 0; i < valence.length; i++) {
    if (valence[i] === 3) extra3.push(i);
    else if (valence[i] === 5) extra5.push(i);
  }
  return { extra3, extra5 };
}

/** Position clouds for the authored twin of the reference's `cornerPtsExtra3/5`. */
export function meshPoles(mesh: QuadMesh): { extra3: Float32Array; extra5: Float32Array } {
  const positions = (vertices: readonly number[]) => new Float32Array(vertices.flatMap(vertex =>
    [mesh.vertices[vertex * 3], mesh.vertices[vertex * 3 + 1], mesh.vertices[vertex * 3 + 2]]));
  const poles = meshPoleIndices(mesh);
  return { extra3: positions(poles.extra3), extra5: positions(poles.extra5) };
}

/**
 * How a selection NAMES the geometry it holds (docs/039). The authored mountain names a vertex or a quad by
 * the stable id it carries, so a selection outlives the topology edit that renumbers the arrays; the read-only
 * reference names it by index, because the reference is rebuilt by position-dedup on every load and never
 * edited — its numbering is legitimately ephemeral, and ids there would be ceremony.
 *
 * The queries below walk index-native topology whatever the caller's naming, so the resolvers convert at
 * their own edges. That is what lets ONE implementation serve both surfaces instead of two that drift.
 */
export interface MeshNaming<Id> {
  /** Where `id` sits in the mesh now, or null when the mesh no longer carries it. */
  index(id: Id): number | null;
  /** What the element at `index` is called, or null when the mesh has nothing there. */
  name(index: number): Id | null;
  /** `a` and `b` in this naming's canonical order, so one undirected edge has exactly one form. */
  canonical(a: Id, b: Id): [Id, Id];
}

/** The naming of a surface whose numbering IS its identity — the read-only reference mesh. */
export const INDEX_NAMING: MeshNaming<number> = {
  index: id => id,
  name: index => index,
  canonical: canonicalEdge,
};

/** A canonical edge pair, named however its surface names geometry. */
export type Edge<Id = number> = [Id, Id];
/** Set key for an edge already in its naming's canonical order — both ends of one edge, order preserved. */
const nameKey = <Id>(e: Edge<Id>) => `${String(e[0])}|${String(e[1])}`;
const sameEdge = <Id>(a: Edge<Id>, b: Edge<Id>) => a[0] === b[0] && a[1] === b[1];
const canonEdge = canonicalEdge;

/**
 * The EDGE LOOP through edge (a,b). A BOUNDARY seed (exactly one incident patch) follows the connected outside
 * perimeter at each endpoint, closing around an outer rim or a hole. An INTERIOR seed keeps the ordinary
 * collinear behavior: hop to the unique incident edge sharing NO quad with the arriving edge (the "straight
 * through" continuation) until a 3/5-pole, the rim, or the ring closes back on itself. This is the loop a
 * double-click on an edge selects (the edge-loop, not the perpendicular ring the
 * loop CUT walks). Returns the loop's edges as canonical `[lo,hi]` pairs in TRAVERSAL ORDER (one rim to the
 * other for an open loop, seed-first around a ring) plus whether it `closed` into a ring — the order lets a
 * shift-range pick the run of edges between two picks. Pure topology; the caller curves them for the highlight.
 */
export function meshEdgeLoop(mesh: QuadMesh, adj: MeshAdjacency, a: number, b: number): { edges: Edge[]; closed: boolean } {
  const facesOf = (x: number, y: number) => adj.edgeQuads.get(ekey(x, y)) ?? [];
  const seedKey = ekey(a, b);
  // Boundary vertices normally carry exactly two boundary neighbours, even at extraordinary surface poles.
  // Following those neighbours selects the topological perimeter rather than the straight grid row that an
  // interior edge uses. A torn/branched rim stops explicitly where continuation ceases to be unique.
  if (facesOf(a, b).length === 1) {
    const walkBoundary = (px: number, cx: number): { out: Edge[]; ring: boolean } => {
      const out: Edge[] = [], seen = new Set<string>([seedKey]);
      for (;;) {
        const onward = (adj.neighbors[cx] ?? []).filter(w => w !== px && facesOf(cx, w).length === 1);
        if (onward.length !== 1) return { out, ring: false };
        const nx = onward[0], key = ekey(cx, nx);
        if (key === seedKey) return { out, ring: true };
        if (seen.has(key)) return { out, ring: false };
        seen.add(key); out.push(canonEdge(cx, nx)); px = cx; cx = nx;
      }
    };
    const fwd = walkBoundary(a, b);
    if (fwd.ring) return { edges: [canonEdge(a, b), ...fwd.out], closed: true };
    const bwd = walkBoundary(b, a);
    return { edges: [...bwd.out.slice().reverse(), canonEdge(a, b), ...fwd.out], closed: false };
  }
  // does the arriving edge (px,cx) share a quad with the candidate onward edge (cx,w)?
  const sharesFace = (px: number, cx: number, w: number) => facesOf(px, cx).some(f => facesOf(cx, w).includes(f));
  // walk away from cx, having arrived along edge px→cx; collect the edges traversed (ordered, seed excluded)
  // and report whether the walk closed back onto the seed (a ring).
  const walk = (px: number, cx: number): { out: Edge[]; ring: boolean } => {
    const out: Edge[] = [];
    const seen = new Set<string>([seedKey]);
    for (;;) {
      const onward = (adj.neighbors[cx] ?? []).filter(w => w !== px && !sharesFace(px, cx, w));
      if (onward.length !== 1) return { out, ring: false };  // pole / rim / tangle: the loop dies here
      const nx = onward[0], k = ekey(cx, nx);
      if (k === seedKey) return { out, ring: true };         // closed back onto the seed
      if (seen.has(k)) return { out, ring: false };          // met an already-walked edge (torn / degenerate net)
      seen.add(k);
      out.push(canonEdge(cx, nx));
      px = cx; cx = nx;
    }
  };
  const fwd = walk(a, b); // forward, past b
  if (fwd.ring) return { edges: [canonEdge(a, b), ...fwd.out], closed: true };
  const bwd = walk(b, a); // backward, past a
  return { edges: [...bwd.out.slice().reverse(), canonEdge(a, b), ...fwd.out], closed: false };
}

/** How a click changes an edge selection: plain = replace (+set anchor); ctrl = toggle one edge in/out
 *  (+set anchor); shift = the run of edges between the anchor and this edge ALONG THEIR SHARED LOOP (unioned;
 *  ignored if this edge isn't on the anchor's loop); double-click = the whole loop (replace, or `loopAdd` to
 *  union). The ONE selection-semantics function the authored net and the read-only reference both call. */
export type EdgeSelectMode = 'replace' | 'toggle' | 'range' | 'loop' | 'loopAdd';

/** The sub-run of an ordered loop between positions i and j (inclusive). On a ring, the shorter of the two arcs. */
function loopRun(loop: Edge[], closed: boolean, i: number, j: number): Edge[] {
  const lo = Math.min(i, j), hi = Math.max(i, j);
  const inner = loop.slice(lo, hi + 1);
  if (!closed) return inner;
  const outer = [...loop.slice(hi), ...loop.slice(0, lo + 1)]; // wrap the other way (both ends included)
  return inner.length <= outer.length ? inner : outer;
}

/** Apply a click (`edge`, already canonical) to an edge selection under `mode`, returning the new set + anchor.
 *  Pure: `current` is not mutated. `mesh`/`adj` drive the loop walk for range / loop modes, and `naming` says
 *  what the caller's surface calls the edges it walks up. */
export function resolveEdgeSelection<Id>(
  current: readonly Edge<Id>[], anchor: Edge<Id> | null, edge: Edge<Id>, mode: EdgeSelectMode,
  mesh: QuadMesh, adj: MeshAdjacency, naming: MeshNaming<Id>,
): { edges: Edge<Id>[]; anchor: Edge<Id> | null } {
  const E = naming.canonical(edge[0], edge[1]);
  if (mode === 'replace') return { edges: [E], anchor: E };
  if (mode === 'toggle') {
    const has = current.some(e => sameEdge(e, E));
    return { edges: has ? current.filter(e => !sameEdge(e, E)) : [...current, E], anchor: E };
  }
  const at = (e: Edge<Id>): Edge | null => {
    const a = naming.index(e[0]), b = naming.index(e[1]);
    return a === null || b === null ? null : canonEdge(a, b);
  };
  const named = (e: Edge): Edge<Id> | null => {
    const a = naming.name(e[0]), b = naming.name(e[1]);
    return a === null || b === null ? null : naming.canonical(a, b);
  };
  // Union with what is already held, de-duplicated on the caller's own names.
  const fresh = (edges: Edge[]) => {
    const seen = new Set(current.map(nameKey));
    return edges.flatMap(e => {
      const id = named(e);
      return id && !seen.has(nameKey(id)) ? [id] : [];
    });
  };
  if (mode === 'loop' || mode === 'loopAdd') {
    const seed = at(E);
    if (!seed) return { edges: [...current], anchor: E };
    const { edges: loop } = meshEdgeLoop(mesh, adj, seed[0], seed[1]);
    if (mode === 'loop') return { edges: loop.flatMap(e => { const id = named(e); return id ? [id] : []; }), anchor: E };
    return { edges: [...current, ...fresh(loop)], anchor: E };
  }
  // range: the run from the anchor to E along the anchor's loop; keep the anchor so further shift-clicks re-range
  if (!anchor) return { edges: [E], anchor: E };
  const from = at(anchor), to = at(E);
  if (!from || !to) return { edges: [...current], anchor };
  const { edges: loop, closed } = meshEdgeLoop(mesh, adj, from[0], from[1]);
  const i = loop.findIndex(e => sameEdge(e, from)), j = loop.findIndex(e => sameEdge(e, to));
  if (i < 0 || j < 0) return { edges: [...current], anchor }; // E isn't on the anchor's loop → no change
  return { edges: [...current, ...fresh(loopRun(loop, closed, i, j))], anchor };
}

/** The straight-through VERTEX RUN from `a` to `b`: the ordered vertices along a single edge loop that
 *  connects them — each hop continues through the onward edge sharing NO quad with the arriving one (the same
 *  "straight through" rule the edge loop walks) — or `null` when no loop through `a` reaches `b` (they're not
 *  collinear, e.g. a diagonal pair on a grid). Endpoints included; the shorter run wins if a ring reaches `b`
 *  both ways. The vertex twin of a `meshEdgeLoop` sub-run, for a shift-range corner pick. */
export function meshVertexRun(adj: MeshAdjacency, a: number, b: number): number[] | null {
  if (a === b) return [a];
  const facesOf = (x: number, y: number) => adj.edgeQuads.get(ekey(x, y)) ?? [];
  const sharesFace = (px: number, cx: number, w: number) => facesOf(px, cx).some(f => facesOf(cx, w).includes(f));
  let best: number[] | null = null;
  for (const first of adj.neighbors[a] ?? []) {   // walk each direction out of the anchor; keep the shortest hit
    const path = [a];
    let px = a, cx = first;
    const seen = new Set<number>([a]);
    for (;;) {
      path.push(cx);
      if (cx === b) { if (!best || path.length < best.length) best = path.slice(); break; }
      if (seen.has(cx)) break;                    // looped back without reaching b
      seen.add(cx);
      const onward = (adj.neighbors[cx] ?? []).filter(w => w !== px && !sharesFace(px, cx, w));
      if (onward.length !== 1) break;             // pole / rim / tangle: this direction dead-ends
      px = cx; cx = onward[0];
    }
  }
  return best;
}

/** The rectangular grid BLOCK of corners spanned between `a` and `b` — the 2-D range a shift-click selects on a
 *  quad grid: every corner bounded by the two rows and two columns through `a` and `b`, so a DIAGONAL pick grabs
 *  the whole patch of corners across the quads (not nothing). Degenerates to the straight `meshVertexRun` line
 *  when `a` and `b` share a row / column, and to `[a]` when they coincide. Returns `null` if a clean rectangle
 *  can't be traced (a pole / rim interrupts the sweep, or `b` isn't a grid-interior corner) — a no-op for the
 *  caller. Pure topology, so it follows the mesh grid even where the surface warps (unlike screen box-select). */
export function meshVertexBlock(adj: MeshAdjacency, a: number, b: number): number[] | null {
  if (a === b) return [a];
  const line = meshVertexRun(adj, a, b);
  if (line) return line;                          // collinear: the block is a single row / column of corners

  const facesOf = (x: number, y: number) => adj.edgeQuads.get(ekey(x, y)) ?? [];
  const sharesFace = (px: number, cx: number, w: number) => facesOf(px, cx).some(f => facesOf(cx, w).includes(f));
  // walk a straight loop from cx (arrived via px), collecting vertices (cx inclusive) until a pole / rim / repeat.
  const walkFrom = (px: number, cx: number): number[] => {
    const out = [cx], seen = new Set<number>([px, cx]);
    let p = px, c = cx;
    for (;;) {
      const onward = (adj.neighbors[c] ?? []).filter(w => w !== p && !sharesFace(p, c, w));
      if (onward.length !== 1 || seen.has(onward[0])) return out;
      seen.add(onward[0]); out.push(onward[0]); p = c; c = onward[0];
    }
  };
  // the ≤2 straight loops through a vertex (each a full row / column of the grid), as membership sets.
  const loopsOf = (v: number): Set<number>[] => {
    const nbrs = adj.neighbors[v] ?? [], used = new Set<number>(), loops: Set<number>[] = [];
    for (const n of nbrs) {
      if (used.has(n)) continue;
      const opp = nbrs.find(m => m !== n && !sharesFace(n, v, m)); // the "straight through" neighbour, if any
      used.add(n); if (opp !== undefined) used.add(opp);
      const set = new Set<number>([v]);
      for (const w of walkFrom(v, n)) set.add(w);
      if (opp !== undefined) for (const w of walkFrom(v, opp)) set.add(w);
      loops.push(set);
    }
    return loops;
  };
  // shortest straight run from `start` to the first vertex satisfying `pred` (inclusive), or null.
  const runTo = (start: number, pred: (v: number) => boolean): number[] | null => {
    let best: number[] | null = null;
    for (const first of adj.neighbors[start] ?? []) {
      const path = [start]; let px = start, cx = first; const seen = new Set<number>([start]);
      for (;;) {
        path.push(cx);
        if (pred(cx)) { if (!best || path.length < best.length) best = path.slice(); break; }
        if (seen.has(cx)) break;
        seen.add(cx);
        const onward = (adj.neighbors[cx] ?? []).filter(w => w !== px && !sharesFace(px, cx, w));
        if (onward.length !== 1) break;
        px = cx; cx = onward[0];
      }
    }
    return best;
  };

  const bLoops = loopsOf(b);
  if (bLoops.length < 2) return null;             // b isn't a grid-interior corner (no two crossing loops)
  // one side of the rectangle: from `a` straight to whichever of b's loops it meets first (the corner `q`).
  const side = runTo(a, v => v !== a && (bLoops[0].has(v) || bLoops[1].has(v)));
  if (!side) return null;
  const q = side[side.length - 1];
  const other = bLoops[0].has(q) ? bLoops[1] : bLoops[0]; // the perpendicular bound to sweep each line onto
  const block = new Set<number>();
  for (const h of side) {                         // sweep each line perpendicular to `side` down onto `other`
    const run = runTo(h, v => other.has(v));
    if (!run) return null;                        // ragged: a pole / rim broke the rectangle
    for (const v of run) block.add(v);
  }
  return [...block];
}

/** How a click changes a control-net VERTEX (corner) selection — the point twin of `resolveEdgeSelection`,
 *  over a flat set of vertex ids: plain = replace (+set anchor); ctrl = toggle one vertex in/out (+set anchor);
 *  shift = the rectangular BLOCK of corners spanned from the anchor to this one across the quad grid
 *  (`meshVertexBlock` — a straight line when they share a row / column; unioned; ignored when no clean block
 *  traces). The ONE point-selection-semantics fn the host calls (mirrors the edge + cell picks). */
export type VertexSelectMode = 'replace' | 'toggle' | 'range';

export function resolveVertexSelection<Id>(
  current: readonly Id[], anchor: Id | null, vertex: Id, mode: VertexSelectMode, adj: MeshAdjacency,
  naming: MeshNaming<Id>,
): { verts: Id[]; anchor: Id } {
  if (mode === 'replace') return { verts: [vertex], anchor: vertex };
  if (mode === 'toggle') {
    const has = current.includes(vertex);
    return { verts: has ? current.filter(v => v !== vertex) : [...current, vertex], anchor: vertex };
  }
  // range: the block of corners from the anchor to this vertex across the grid; keep the anchor for further ranges
  if (anchor === null) return { verts: [vertex], anchor: vertex };
  const from = naming.index(anchor), to = naming.index(vertex);
  if (from === null || to === null) return { verts: [...current], anchor };
  const block = meshVertexBlock(adj, from, to);
  if (!block) return { verts: [...current], anchor };  // no clean block → no change
  const set = new Set(current);
  for (const v of block) { const id = naming.name(v); if (id !== null) set.add(id); }
  return { verts: [...set], anchor };
}

/** How a click changes an Edit-mode CELL (quad) selection — the surface-face member of the resolve family
 *  (the cell twin of `resolveEdgeSelection`), over a flat set of quad ids: plain = replace (+set anchor); ctrl =
 *  toggle one cell in/out (+set anchor); shift = the rectangular BLOCK of cells spanned from the anchor to this
 *  one across the grid (`faceBlock` — a straight strip when they share one; unioned; ignored when no clean block
 *  traces); double-click = the face LOOP through the cell in direction `loopDir` (0/1 = the two opposite-edge
 *  strips), replacing (`loop`) or unioning (`loopAdd`). Runs on the cell topology (`SurfaceTopology`), the
 *  substrate face loops read; the host owns the set, the anchor, and the loop-direction toggle. */
export type CellSelectMode = 'replace' | 'toggle' | 'range' | 'loop' | 'loopAdd';

export function resolveCellSelection<Id>(
  current: readonly Id[], anchor: Id | null, cell: Id, mode: 'replace' | 'toggle',
  naming: MeshNaming<Id>,
): { cells: Id[]; anchor: Id };
export function resolveCellSelection<Id>(
  current: readonly Id[], anchor: Id | null, cell: Id, mode: 'range' | 'loop' | 'loopAdd',
  naming: MeshNaming<Id>, topo: SurfaceTopology, loopDir?: 0 | 1,
): { cells: Id[]; anchor: Id };
/** Compatibility overload for callers whose mode is still a union and already have topology available. */
export function resolveCellSelection<Id>(
  current: readonly Id[], anchor: Id | null, cell: Id, mode: CellSelectMode,
  naming: MeshNaming<Id>, topo: SurfaceTopology, loopDir?: 0 | 1,
): { cells: Id[]; anchor: Id };
export function resolveCellSelection<Id>(
  current: readonly Id[], anchor: Id | null, cell: Id, mode: CellSelectMode,
  naming: MeshNaming<Id>, topo?: SurfaceTopology, loopDir: 0 | 1 = 0,
): { cells: Id[]; anchor: Id } {
  if (mode === 'replace') return { cells: [cell], anchor: cell };
  if (mode === 'toggle') {
    const has = current.includes(cell);
    return { cells: has ? current.filter(c => c !== cell) : [...current, cell], anchor: cell };
  }
  // The overloads require topology for every mode that reaches this point.
  if (!topo) throw new Error(`Cell selection mode ${mode} requires surface topology`);
  const seed = naming.index(cell);
  if (seed === null) return { cells: [...current], anchor: cell };
  const union = (cells: readonly number[]) => {
    const set = new Set(current);
    for (const c of cells) { const id = naming.name(c); if (id !== null) set.add(id); }
    return [...set];
  };
  if (mode === 'loop' || mode === 'loopAdd') {
    const loop = [seed, ...faceLoop(topo, seed, loopDir)]; // include the clicked cell; the loop excludes it
    if (mode === 'loop') return { cells: loop.flatMap(c => naming.name(c) ?? []), anchor: cell };
    return { cells: union(loop), anchor: cell };
  }
  // range: the block of cells from the anchor to this cell across the grid; keep the anchor for further ranges
  if (anchor === null) return { cells: [cell], anchor: cell };
  const from = naming.index(anchor);
  const block = from === null ? null : faceBlock(topo, from, seed);
  if (!block) return { cells: [...current], anchor };  // no clean block → no change
  return { cells: union(block), anchor };
}

/** Curved polyline segments (concatenated cubic samples) for a SET of edges — the highlight geometry for a
 *  selected edge / edge loop, built exactly the way the cage draws its wires (`meshCageEdges`): each edge's
 *  derived cubic (corner + directional handle, the neighbour's handle back, the neighbour). Data space. */
export function meshEdgeSegments(mesh: QuadMesh, eh: EdgeHandle, edges: Iterable<[number, number]>, seg = 6): Float32Array {
  const P = (id: number): V3 => readVertex(mesh.vertices, id);
  const out: number[] = [];
  for (const [a, b] of edges) {
    if (a >= mesh.vertexCount || b >= mesh.vertexCount) continue; // a selection that outlived a topology edit
    const Pa = P(a), Pb = P(b);
    pushCubicEdge(out, Pa, add(Pa, eh(a, b)), add(Pb, eh(b, a)), Pb, seg);
  }
  return new Float32Array(out);
}
