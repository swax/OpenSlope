/**
 * Quad-mesh a REGION of the plan — ground a survey says is cleared — as one sheet of cells.
 *
 * `trail.ts` builds a trail by lofting a cross-section along a spline. That is the right tool for a trail
 * somebody is designing: the author owns the centreline, the ribbon follows it exactly, and the patches come
 * out aligned with the direction of travel. It is the wrong tool for a trail somebody has SURVEYED, because a
 * surveyed mountain is not a bundle of splines that politely avoid each other. Its trails fork at six degrees,
 * run side by side for a pitch and rejoin, cross without meeting, and open into a lift base that is not a
 * junction of anything — shapes a swept cross-section cannot express and a junction fan can only refuse.
 *
 * So this asks a different question. Not "what does this centreline sweep out" but "what ground is cleared" —
 * and then meshes that ground. The region arrives as a signed distance field, which is closed under union, so
 * ninety-six trails crossing every which way pose exactly the same problem as one: their footprint is a region
 * with holes in it, and a region with holes in it is meshable whatever put the holes there.
 *
 * ## How
 *
 * A lattice is laid over the region and the cells inside it are kept. That alone is a staircase, so the rim is
 * then FITTED: the boundary vertices are walked along their own loops, smoothed, and projected onto the field's
 * zero set until the sheet's edge sits on the region's edge, while the interior relaxes to keep the cells from
 * shearing. What comes out is a quad mesh whose outline is the survey's outline to within a fraction of a
 * metre, at whatever density the lattice was laid at.
 *
 * ## What it costs
 *
 * The cells are the lattice's, so their edges point where the lattice points and not where the trail runs. A
 * lofted ribbon gets that for free and this cannot get it at all — the region has no single direction, and at
 * a junction there is no such thing. `angleRad` turns the whole lattice, which is worth doing when a survey
 * has a dominant grain, but it buys degrees rather than solving it.
 */

export interface SheetPoint { x: number; z: number }

export interface SheetOptions {
  /**
   * Metres outside the region; negative inside.
   *
   * Only the SIGN and the ZERO SET are read. That is deliberate, because it makes `Math.min` over overlapping
   * shapes a legal field: the minimum of several capsule distances is exact outside their union, has exactly
   * the union's boundary as its zero set, and merely under-states how deep an interior point is — which
   * nothing here asks.
   */
  distanceAt(x: number, z: number): number;
  /** Where to look for the region. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  cellM: number;
  /** The lattice's own plan rotation, radians. */
  angleRad?: number;
  origin?: SheetPoint;
  /**
   * Centrelines the sheet must carry cell by cell, whatever sampling says.
   *
   * A corridor narrower than a cell can pass between two cell centres and simply not be in the region, and a
   * diagonal one can be sampled into a chain of cells that touch only at their corners — which is not a
   * surface. Walking the centreline itself and claiming every cell it passes through makes each corridor a
   * connected run of cells before anything else looks at it.
   */
  spines?: readonly (readonly SheetPoint[])[];
  /** Rounds of fit-and-relax. */
  rounds?: number;
}

export interface Sheet {
  points: SheetPoint[];
  /** `[A, B, C, D]` with perimeter A→B→D→C, the order the quilt stores a patch in. */
  quads: [number, number, number, number][];
  boundary: Set<number>;
  /** The rim, as closed vertex cycles — the outer one and one per hole. */
  loops: number[][];
  /** Cells added, and cells taken away, to keep the sheet a surface. */
  filled: number;
  dropped: number;
  /** How far the fitted rim sits from the region's own edge. */
  fit: { meanM: number; worstM: number };
  /** The sign of a cell's plan area, so a caller can match it to a document's own frame. */
  winding: number;
}

export type SheetResult = ({ ok: true } & Sheet) | { ok: false; error: string };

/** Signed plan area of a `[A,B,C,D]` cell, walking its perimeter A→B→D→C. */
function cellArea(xs: Float64Array, zs: Float64Array, quad: readonly number[]): number {
  const ring = [quad[0], quad[1], quad[3], quad[2]];
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    area += xs[a] * zs[b] - xs[b] * zs[a];
  }
  return area / 2;
}

export function buildSheet(options: SheetOptions): SheetResult {
  const cell = options.cellM;
  if (!(cell > 0)) return { ok: false, error: 'A sheet needs a positive cell size.' };
  const { bounds, distanceAt } = options;
  if (!(bounds.maxX > bounds.minX) || !(bounds.maxZ > bounds.minZ))
    return { ok: false, error: 'A sheet needs bounds with area.' };

  const angle = options.angleRad ?? 0;
  const origin = options.origin ?? { x: bounds.minX, z: bounds.minZ };
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const worldX = (u: number, v: number) => origin.x + u * cos - v * sin;
  const worldZ = (u: number, v: number) => origin.z + u * sin + v * cos;
  const gridU = (x: number, z: number) => (x - origin.x) * cos + (z - origin.z) * sin;
  const gridV = (x: number, z: number) => -(x - origin.x) * sin + (z - origin.z) * cos;

  // ---- which cells ------------------------------------------------------------------------------------------
  let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity;
  for (const [x, z] of [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ],
    [bounds.minX, bounds.maxZ], [bounds.maxX, bounds.maxZ]]) {
    const i = Math.floor(gridU(x, z) / cell), j = Math.floor(gridV(x, z) / cell);
    i0 = Math.min(i0, i - 1); i1 = Math.max(i1, i + 1);
    j0 = Math.min(j0, j - 1); j1 = Math.max(j1, j + 1);
  }
  const span = j1 - j0 + 1;
  const at = (i: number, j: number) => (i - i0) * span + (j - j0);
  const colOf = (id: number) => Math.floor(id / span) + i0;
  const rowOf = (id: number) => (id % span) + j0;
  const held = (i: number, j: number) => i >= i0 && i <= i1 && j >= j0 && j <= j1;
  const centre = (i: number, j: number) => ({ u: (i + 0.5) * cell, v: (j + 0.5) * cell });
  const depthAt = (i: number, j: number) => {
    const c = centre(i, j);
    return distanceAt(worldX(c.u, c.v), worldZ(c.u, c.v));
  };

  const cells = new Set<number>();
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (depthAt(i, j) < 0) cells.add(at(i, j));

  // Every cell a centreline passes through, bridged wherever the walk steps diagonally, so a corridor thinner
  // than the lattice is still a connected run of cells rather than a dotted line.
  for (const spine of options.spines ?? []) {
    let last: { i: number; j: number } | null = null;
    for (let s = 0; s + 1 < spine.length; s++) {
      const a = spine[s], b = spine[s + 1];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const steps = Math.max(1, Math.ceil(length / (cell / 3)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const i = Math.floor(gridU(x, z) / cell), j = Math.floor(gridV(x, z) / cell);
        if (!held(i, j)) { last = null; continue; }
        if (last && last.i !== i && last.j !== j) {
          const one = { i, j: last.j }, two = { i: last.i, j };
          const pick = depthAt(one.i, one.j) <= depthAt(two.i, two.j) ? one : two;
          if (held(pick.i, pick.j)) cells.add(at(pick.i, pick.j));
        }
        cells.add(at(i, j));
        last = { i, j };
      }
    }
  }
  if (!cells.size) return { ok: false, error: 'No cell of the lattice falls inside the region.' };

  /** The largest run of cells joined edge to edge — a sheet is one surface, and a speck the sampling picked up
   *  off in the woods is not part of it. */
  const largestComponent = (from: Set<number>): Set<number> => {
    const seen = new Set<number>();
    let best = new Set<number>();
    for (const start of from) {
      if (seen.has(start)) continue;
      const group = new Set<number>([start]);
      seen.add(start);
      const queue = [start];
      while (queue.length) {
        const id = queue.pop()!;
        const i = colOf(id), j = rowOf(id);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (!held(i + di, j + dj)) continue;
          const next = at(i + di, j + dj);
          if (!from.has(next) || seen.has(next)) continue;
          seen.add(next); group.add(next); queue.push(next);
        }
      }
      if (group.size > best.size) best = group;
    }
    return best;
  };

  let kept = largestComponent(cells);
  let filled = 0;
  let dropped = cells.size - kept.size;

  /**
   * Take the corner-pinches out.
   *
   * Two cells meeting at one vertex and along no edge are not a surface: that vertex sits on the boundary
   * twice, so the rim through it is not a loop and nothing downstream that walks a boundary can walk it. The
   * repair is to make the corner solid where the region is nearly there anyway — the two cells were diagonal
   * because a swath passed obliquely through the lattice, and filling one of them is the same swath one cell
   * wider — and to give up the thinner side only where filling would claim ground the survey never cleared.
   */
  for (let round = 0; round < 32; round++) {
    const add = new Set<number>(), cut = new Set<number>();
    const corners = new Set<number>();
    for (const id of kept) {
      const i = colOf(id), j = rowOf(id);
      for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) corners.add(at(i + di, j + dj));
    }
    for (const corner of corners) {
      const i = colOf(corner), j = rowOf(corner);
      const has = (ci: number, cj: number) => held(ci, cj) && kept.has(at(ci, cj)) && !cut.has(at(ci, cj));
      const nw = has(i - 1, j - 1), ne = has(i, j - 1), sw = has(i - 1, j), se = has(i, j);
      const count = Number(nw) + Number(ne) + Number(sw) + Number(se);
      if (count !== 2) continue;
      const diagonal = (nw && se) ? [{ i, j: j - 1 }, { i: i - 1, j }] : (ne && sw) ? [{ i: i - 1, j: j - 1 }, { i, j }] : null;
      if (!diagonal) continue;
      const open = diagonal.filter(c => held(c.i, c.j));
      const nearest = open.sort((a, b) => depthAt(a.i, a.j) - depthAt(b.i, b.j))[0];
      if (nearest && depthAt(nearest.i, nearest.j) < cell) { add.add(at(nearest.i, nearest.j)); continue; }
      // Nothing to fill with: keep whichever of the two diagonals is better attached and let the other go.
      const present = (nw && se) ? [{ i: i - 1, j: j - 1 }, { i, j }] : [{ i, j: j - 1 }, { i: i - 1, j }];
      const attachment = (c: { i: number; j: number }) => [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([di, dj]) => held(c.i + di, c.j + dj) && kept.has(at(c.i + di, c.j + dj))).length;
      const weaker = attachment(present[0]) <= attachment(present[1]) ? present[0] : present[1];
      cut.add(at(weaker.i, weaker.j));
    }
    if (!add.size && !cut.size) break;
    for (const id of add) kept.add(id);
    for (const id of cut) kept.delete(id);
    filled += add.size; dropped += cut.size;
    const before = kept.size;
    kept = largestComponent(kept);
    dropped += before - kept.size;
  }
  if (!kept.size) return { ok: false, error: 'Nothing survived making the region a surface.' };

  // ---- the mesh ---------------------------------------------------------------------------------------------
  const vertexAt = new Map<number, number>();
  const us: number[] = [], vs: number[] = [];
  const vertex = (i: number, j: number): number => {
    const key = at(i, j);
    const known = vertexAt.get(key);
    if (known !== undefined) return known;
    const id = us.length;
    vertexAt.set(key, id); us.push(i * cell); vs.push(j * cell);
    return id;
  };
  const quads: [number, number, number, number][] = [];
  for (const id of kept) {
    const i = colOf(id), j = rowOf(id);
    quads.push([vertex(i, j), vertex(i + 1, j), vertex(i, j + 1), vertex(i + 1, j + 1)]);
  }

  const xs = new Float64Array(us.length), zs = new Float64Array(us.length);
  for (let v = 0; v < us.length; v++) { xs[v] = worldX(us[v], vs[v]); zs[v] = worldZ(us[v], vs[v]); }
  const winding = Math.sign(cellArea(xs, zs, quads[0]));

  // ---- the rim ----------------------------------------------------------------------------------------------
  const edgeUse = new Map<string, { a: number; b: number; count: number }>();
  for (const quad of quads) {
    const ring = [quad[0], quad[1], quad[3], quad[2]];
    for (let i = 0; i < 4; i++) {
      const a = ring[i], b = ring[(i + 1) % 4];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const seen = edgeUse.get(key);
      if (seen) seen.count++; else edgeUse.set(key, { a, b, count: 1 });
    }
  }
  const boundary = new Set<number>();
  const rimNext = new Map<number, number[]>();
  for (const { a, b, count } of edgeUse.values()) {
    if (count !== 1) continue;
    boundary.add(a); boundary.add(b);
    (rimNext.get(a) ?? (rimNext.set(a, []), rimNext.get(a)!)).push(b);
    (rimNext.get(b) ?? (rimNext.set(b, []), rimNext.get(b)!)).push(a);
  }
  const forked = [...rimNext.values()].filter(list => list.length !== 2).length;
  if (forked) return { ok: false, error: `${forked} rim vertices are on more than one loop — the region did not resolve into a surface.` };

  const loops: number[][] = [];
  const walked = new Set<number>();
  for (const start of rimNext.keys()) {
    if (walked.has(start)) continue;
    const loop = [start];
    walked.add(start);
    let previous = start, current = rimNext.get(start)![0];
    while (current !== start) {
      loop.push(current); walked.add(current);
      const pair = rimNext.get(current)!;
      const onward = pair[0] === previous ? pair[1] : pair[0];
      previous = current; current = onward;
    }
    loops.push(loop);
  }

  // ---- fit the rim to the region, and let the inside follow ---------------------------------------------------
  const neighbours: number[][] = Array.from({ length: us.length }, () => []);
  for (const { a, b } of edgeUse.values()) { neighbours[a].push(b); neighbours[b].push(a); }

  /** One Newton step onto the field's zero set. The step is capped at half a cell so a vertex that starts a
   *  long way out walks in over several rounds instead of shooting past the region and landing in another
   *  part of it. */
  const project = (x: number, z: number): { x: number; z: number } => {
    const h = cell * 0.25;
    const d = distanceAt(x, z);
    const gx = (distanceAt(x + h, z) - distanceAt(x - h, z)) / (2 * h);
    const gz = (distanceAt(x, z + h) - distanceAt(x, z - h)) / (2 * h);
    const g2 = gx * gx + gz * gz;
    if (!(g2 > 1e-9)) return { x, z };
    let sx = -(d * gx) / g2, sz = -(d * gz) / g2;
    const step = Math.hypot(sx, sz), cap = cell * 0.5;
    if (step > cap) { sx *= cap / step; sz *= cap / step; }
    return { x: x + sx, z: z + sz };
  };

  const rounds = options.rounds ?? 24;
  const tryX = new Float64Array(us.length), tryZ = new Float64Array(us.length);
  for (let round = 0; round < rounds; round++) {
    tryX.set(xs); tryZ.set(zs);
    // The rim first slides along itself, which is what actually takes the staircase out — projection alone
    // would pull each step straight onto the rim and keep the corner.
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const v = loop[i], before = loop[(i - 1 + loop.length) % loop.length], after = loop[(i + 1) % loop.length];
        tryX[v] = xs[v] + 0.5 * ((xs[before] + xs[after]) / 2 - xs[v]);
        tryZ[v] = zs[v] + 0.5 * ((zs[before] + zs[after]) / 2 - zs[v]);
      }
    }
    for (const v of boundary) {
      const onto = project(tryX[v], tryZ[v]);
      tryX[v] = onto.x; tryZ[v] = onto.z;
    }
    for (let v = 0; v < us.length; v++) {
      if (boundary.has(v) || !neighbours[v].length) continue;
      let mx = 0, mz = 0;
      for (const n of neighbours[v]) { mx += xs[n]; mz += zs[n]; }
      mx /= neighbours[v].length; mz /= neighbours[v].length;
      tryX[v] = xs[v] + 0.35 * (mx - xs[v]);
      tryZ[v] = zs[v] + 0.35 * (mz - zs[v]);
    }

    /** No round may turn a cell over. Where one would, the vertices of the offending cells are walked back
     *  toward where they were until it does not — and if that never settles, they simply do not move this
     *  round. A fold here becomes an inverted locked patch on the mountain, which nothing downstream forgives. */
    for (let attempt = 0; attempt < 6; attempt++) {
      const bad = quads.filter(quad => Math.sign(cellArea(tryX, tryZ, quad)) !== winding);
      if (!bad.length) break;
      const stuck = new Set(bad.flat());
      const last = attempt === 5;
      for (const v of stuck) {
        tryX[v] = last ? xs[v] : (tryX[v] + xs[v]) / 2;
        tryZ[v] = last ? zs[v] : (tryZ[v] + zs[v]) / 2;
      }
    }
    xs.set(tryX); zs.set(tryZ);
  }

  let sum = 0, worst = 0;
  for (const v of boundary) {
    const off = Math.abs(distanceAt(xs[v], zs[v]));
    sum += off; worst = Math.max(worst, off);
  }

  return {
    ok: true,
    points: Array.from({ length: us.length }, (_, v) => ({ x: xs[v], z: zs[v] })),
    quads, boundary, loops, filled, dropped,
    fit: { meanM: boundary.size ? sum / boundary.size : 0, worstM: worst },
    winding: Math.sign(cellArea(xs, zs, quads[0])),
  };
}
