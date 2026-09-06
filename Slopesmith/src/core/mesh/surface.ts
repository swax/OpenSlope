/**
 * The QUAD TOPOLOGY a mountain surface's cell selection reads — face loops (`faceLoop`) and the rectangular
 * cell block a shift-range spans (`faceBlock`), written ONCE against the topology whatever the underlying mesh.
 * It is deliberately topology-GENERAL (a quad mesh with arbitrary adjacency and extraordinary 3/5 poles), not
 * grid-special: the authored net's rectangular rows×cols is only its seed template, expressed
 * as one (regular) case of the same model, so the day the authored mesh grows poles / free patches like the
 * reference, this layer is unchanged. The authored preview and the loaded reference each build one; the host
 * resolves cell selection against it (`resolveCellSelection`) and the viewport shades the resulting quad ids.
 */

/** How a control-net edge is classified for the cage / loop highlight (which colour it draws): a `grid`
 *  interior seam (shared by two cells), the quilt's outer `rim` (a single-cell border), or a `tear` (an
 *  interior border that isn't the rim — a hole / unstitched slit; reference-only, a watertight authored mesh
 *  never has one). Shared by the authored net and the reference so both highlight edges the same way. */
export type EdgeCls = 'grid' | 'rim' | 'tear';

/** A control-net vertex's class by interior-seam valence: regular (`grid`), or an extraordinary 3/5-pole —
 *  the loop highlight / cage draw a pole's dot in its own colour (violet 3, magenta 5). */
export type VertexCls = 'grid' | 'pole3' | 'pole5';

/** A quad mesh's adjacency, enough to walk face loops. Cells are quads; each has four boundary edges in a
 *  consistent order whose OPPOSITE pairs are (0,2) and (1,3) — a face loop steps across a quad via the edge
 *  opposite the one it arrived on. */
export interface SurfaceTopology {
  cellCount: number;
  /** Per cell, its four boundary-edge ids in order (opposite pairs (0,2) / (1,3)). */
  cellEdges: number[][];
  /** Per edge id, the ≤2 cells sharing it (1 = a rim edge, 2 = an interior seam). */
  edgeCells: number[][];
  /** Per edge id, whether an endpoint is an EXTRAORDINARY vertex (a 3/5+ pole, valence≠4). A face loop
   *  crosses an edge only when its rail is regular — at a pole the continuation is ambiguous ("more/fewer
   *  than four, how do you know where to extend"), so the loop stops there. Omitted (or all false) on a
   *  regular grid, which has no poles. */
  edgeTouchesPole?: boolean[];
}

/**
 * The face loop(s) through a cell: walk out its edges, stepping to the single neighbour across each edge and
 * continuing across that neighbour's OPPOSITE edge, until a strip hits a rim (no neighbour), a non-manifold
 * junction (several), a revisit, or reaches an IRREGULAR cell — one sitting at a pole (a corner where the net
 * is extraordinary), which is INCLUDED as the strip's terminator because past it the continuation is ambiguous.
 *
 * From a REGULAR cell the two loops are its opposite-edge PAIRS ((0,2) and (1,3)) — a clean column + row on a
 * grid. `dir` picks ONE of them (0 = the (0,2) strip, 1 = the (1,3) strip), the direction a double-click
 * selects (a repeat tap alternates dir); omit it for BOTH (the whole cross). From an IRREGULAR cell (clicked ON
 * a pole) that pairing is meaningless, so every one of its four edges radiates independently regardless of
 * `dir`, each still terminating at the next irregular cell. Returns the loop cells, EXCLUDING `cell`.
 */
export function faceLoop(topo: SurfaceTopology, cell: number, dir?: 0 | 1): number[] {
  const pe = topo.cellEdges[cell];
  if (!pe || pe.length !== 4) return [];
  // "Irregular" = the cell touches a pole (an edge of it has an extraordinary endpoint). A regular grid has
  // none, so this is always false there and the loops run rim to rim (the whole column + row).
  const irregular = (c: number): boolean => {
    const es = topo.cellEdges[c];
    return !!es && !!topo.edgeTouchesPole && es.some(e => topo.edgeTouchesPole![e]);
  };
  const out = new Set<number>();
  const groups = irregular(cell) ? [[0], [1], [2], [3]]
    : dir === undefined ? [[0, 2], [1, 3]]
    : dir === 0 ? [[0, 2]] : [[1, 3]];
  for (const group of groups) {
    const visited = new Set<number>([cell]); // per group, so a ring closes cleanly; groups stay independent
    for (const side of group) {
      let cur = cell, e = pe[side], guard = 0;
      while (e >= 0 && guard++ <= topo.cellCount) {
        const cells = topo.edgeCells[e];
        const nbs = cells ? cells.filter(c => c !== cur) : [];
        if (nbs.length !== 1) break;                 // rim (none) or non-manifold (many): the strip ends
        const nb = nbs[0];
        if (visited.has(nb)) break;                  // the strip closed into a ring
        visited.add(nb); out.add(nb);
        if (irregular(nb)) break;                    // terminate ON the irregular cell (it's included)
        const local = topo.cellEdges[nb]?.indexOf(e) ?? -1;
        if (local < 0) break;
        e = topo.cellEdges[nb][(local + 2) % 4];      // cross the neighbour's opposite edge
        cur = nb;
      }
    }
  }
  out.delete(cell);
  return [...out];
}

/**
 * The rectangular grid BLOCK of CELLS spanned between cells `a` and `b` — the surface-face twin of
 * `meshVertexBlock` (selection.ts) for a shift-range cell pick: every quad bounded by the two strips through
 * `a` and the two through `b`, so a DIAGONAL pick grabs the whole patch of cells across the quads (not just a
 * strip). Degenerates to the straight run of cells when `a` and `b` share a strip, and to `[a]` when they
 * coincide. Returns `null` when a clean rectangle can't be traced (a pole / rim breaks the sweep, or `b` has no
 * two crossing strips) — a no-op for the caller. Pure topology, so it follows the mesh grid even where the
 * surface warps (unlike the screen box-select).
 */
export function faceBlock(topo: SurfaceTopology, a: number, b: number): number[] | null {
  if (a === b) return [a];
  const irregular = (c: number): boolean => {
    const es = topo.cellEdges[c];
    return !!es && !!topo.edgeTouchesPole && es.some(e => topo.edgeTouchesPole![e]);
  };
  // Ordered cells from `c` (inclusive) walking straight out its side-`s` edge, crossing each neighbour's
  // OPPOSITE edge, until a rim / pole / revisit — the single-side half of a `faceLoop` strip.
  const strip = (c: number, s: number): number[] => {
    const first = topo.cellEdges[c]?.[s];
    if (first === undefined) return [c];
    const out = [c], seen = new Set<number>([c]);
    let cur = c, e = first;
    for (let g = 0; g <= topo.cellCount; g++) {
      const nbs = (topo.edgeCells[e] ?? []).filter(x => x !== cur);
      if (nbs.length !== 1) break;                    // rim (none) or non-manifold (many): the strip ends
      const nb = nbs[0];
      if (seen.has(nb)) break;                        // closed into a ring
      seen.add(nb); out.push(nb);
      if (irregular(nb)) break;                       // terminate ON the pole-touching cell (it's included)
      const local = topo.cellEdges[nb]?.indexOf(e) ?? -1;
      if (local < 0) break;
      e = topo.cellEdges[nb][(local + 2) % 4];        // cross the neighbour's opposite edge
      cur = nb;
    }
    return out;
  };
  // shortest straight strip from `start` to the first cell PAST it satisfying `pred` (inclusive), or null.
  const runTo = (start: number, pred: (c: number) => boolean): number[] | null => {
    let best: number[] | null = null;
    for (let s = 0; s < 4; s++) {
      const line = strip(start, s);
      for (let i = 1; i < line.length; i++) {
        if (pred(line[i])) { const run = line.slice(0, i + 1); if (!best || run.length < best.length) best = run; break; }
      }
    }
    return best;
  };
  const straight = runTo(a, c => c === b);
  if (straight) return straight;                      // collinear: a single strip of cells
  // b's two crossing strips (its row + its column), as membership sets.
  const bLoop = (d: 0 | 1): Set<number> => {
    const [s0, s1] = d === 0 ? [0, 2] : [1, 3];
    const set = new Set<number>([b]);
    for (const w of strip(b, s0)) set.add(w);
    for (const w of strip(b, s1)) set.add(w);
    return set;
  };
  const bl0 = bLoop(0), bl1 = bLoop(1);
  if (bl0.size < 2 || bl1.size < 2) return null;      // b isn't a grid-interior cell (a strip dead-ends at once)
  // one side of the rectangle: from `a` straight to whichever of b's strips it meets first (the corner `q`).
  const side = runTo(a, c => bl0.has(c) || bl1.has(c));
  if (!side) return null;
  const q = side[side.length - 1];
  const other = bl0.has(q) ? bl1 : bl0;               // the perpendicular bound to sweep each line onto
  const block = new Set<number>();
  for (const h of side) {                             // sweep each line perpendicular to `side` onto `other`
    const run = runTo(h, c => other.has(c));
    if (!run) return null;                            // ragged: a pole / rim broke the rectangle
    for (const c of run) block.add(c);
  }
  return [...block];
}
