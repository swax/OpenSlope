import type { V3 } from '../../doc/types';
import type { InterfaceCurve } from './benchmark';
import type { PolygonMesh } from './obj';
import { boundaryLoops } from './prescribe';
import { bilinear, chamfer, grade, rasterize, type Raster } from './contour-raster';
import {
  bandComponents, clipToClearance, componentOf, curveLength, marchLevel, resampleCurve, scheduleLevels,
  type LevelCurve,
} from './contour-levels';
import {
  Builder, bridgeCycle, capRow, chainArcSets, knitAligned, knitChainIntoHost, knitChainToCycle,
  knitRings, medianChainDistance, pointInRing, ringCentroid, shrinkCap, skyward, weldCycle,
  CAP_LIMIT, type Row,
} from './contour-knit';
import { joinTargets, resampleFreeRim, type JoinTarget } from './contour-join';
import { cancelParityTriangles, relaxInterior, splitPinches } from './contour-repair';

/**
 * Contour-flow candidate generation (the "Elevation loops" retopology strategy).
 *
 * The mountain's unlocked terrain is meshed from its own shape instead of from a lattice: the rows are
 * edge loops along graded (smoothed) elevation lines and the columns flow up the gradient, so the cage's
 * edge flow reads as the hill's contour map. The generator emits the same all-quad candidate `PolygonMesh`
 * the QuadWild path produces, and the existing direct conforming join integrates it: every locked-feature
 * hole rim is built with exactly one candidate vertex per authored rim corner, placed on the corner.
 *
 * Structure of a solve:
 *   1. RASTER — the triangulated unlocked surface is sampled to a height grid; a chamfer distance field
 *      to the region boundary records how far each node stands from any rim or locked hole.
 *   2. GRADE — the height grid is box-blurred at the cell scale, so its contours are the graded elevation
 *      lines rather than every mogul's wiggle.
 *   3. SWEEP — marching squares extracts each level's curves, clipped to stand one knit ring off the
 *      boundary; bands between consecutive levels are meshed as ladders whose kite rows absorb vertex
 *      count changes, with caps at peaks and pits and saddle rows where loops split or merge. A band the
 *      sweep cannot mesh cleanly against the coastline is deliberately left open — the join ring closes it.
 *   4. JOIN — every boundary loop of the swept sheet is knitted to its region-boundary target with one
 *      cyclic ring of quads: locked rims onto their authored corners exactly (the conforming seam), free
 *      rims onto the source perimeter resampled at the cell size.
 *
 * Parity: an all-quad patch fixes the parity of each boundary loop (adding or removing quads changes any
 * loop's edge count by an even number), and a locked rim's authored count is not negotiable. Free rims and
 * swept rows pick matching parities, and each odd locked rim costs the join ring one temporary triangle;
 * the triangles are then paired up and cancelled against each other by pushing them through the quad sheet
 * (triangle + neighbouring quad = pentagon, re-split with the triangle one face further along), which is
 * the constructive equivalent of the parity routing QuadWild's BiMDF solve does globally.
 */

export interface ContourCandidateInput {
  /** Triangulated unlocked surface for the height raster (holes where features are locked). */
  surface: PolygonMesh;
  /** Resolution-1 hole-mode proxy whose boundary loops are the join targets. */
  boundaryProxy: PolygonMesh;
  /** Locked-rim cubics; a proxy boundary loop lying on these is a conforming-seam target. */
  interfaceCurves: InterfaceCurve[];
  targetPatchSizeM: number;
  /** Diagnostic mode: join failures become notes instead of errors; the result may not be integrable. */
  lenient?: boolean;
}

export interface ContourCandidateStats {
  rasterNodes: number;
  levels: number;
  sweptQuads: number;
  ringQuads: number;
  caps: number;
  pits: number;
  saddles: number;
  openBands: number;
  islandFills: number;
  parityTriangles: number;
  relaxedVertices: number;
}

export interface ContourCandidateResult {
  mesh: PolygonMesh;
  /** Human-readable build notes (events, skipped bands, fills). */
  notes: string[];
  stats: ContourCandidateStats;
}

/** How far (in cells) the sweep stands off the region boundary; the join ring spans this moat. */
const MOAT_CELLS = 0.8;
/** How far (in cells) a locked rim's intermediate ring stands off the rim. The job re-imposes this
 *  offset on the integrated result (integration's relax knows nothing of the strip's shape). */
export const CONTOUR_RIM_STRIP_CELLS = 0.4;
const RIM_STRIP_CELLS = CONTOUR_RIM_STRIP_CELLS;

// ---- the sweep -------------------------------------------------------------------------------------------

interface SweepOutcome {
  rows: Map<LevelCurve, Row>;
}

function sweepBands(
  builder: Builder,
  raster: Raster,
  levels: number[],
  curvesAt: LevelCurve[][],
  cell: number,
  moat: number,
  notes: string[],
  stats: ContourCandidateStats,
): SweepOutcome {
  const rows = new Map<LevelCurve, Row>();
  const fresh = new Set<Row>();
  const rowFor = (curve: LevelCurve, parity?: number): Row => {
    const found = rows.get(curve);
    if (found) return found;
    const points = resampleCurve(curve, cell, parity);
    const ids = points.map(([x, z]) => {
      const y = bilinear(raster, raster.height, x, z);
      return builder.addVertex(x, Number.isNaN(y) ? 0 : y, z);
    });
    const row: Row = { ids, closed: curve.closed };
    rows.set(curve, row);
    fresh.add(row);
    return row;
  };
  // A chained arc composite must be REUSED by the band above: its connector chords are ordinary edges
  // of the knit, and only when both bands traverse the very same chords do those edges end up two-sided
  // (interior). Keyed by the arc set, which is the composite's identity across bands.
  const curveTag = new Map<LevelCurve, string>();
  curvesAt.forEach((curves, level) => curves.forEach((curve, index) => curveTag.set(curve, `${level}.${index}`)));
  const chainCache = new Map<string, number[][]>();
  const chainsFor = (arcRows: Row[], arcs: LevelCurve[]): number[][] => {
    const key = arcs.map(curve => curveTag.get(curve)).sort().join(',');
    const cached = chainCache.get(key);
    if (cached) return cached;
    const chained = chainArcSets(builder, raster, moat, arcRows, cell);
    chainCache.set(key, chained);
    return chained;
  };

  for (let band = 0; band + 1 < levels.length; band++) {
    const components = bandComponents(raster, levels[band], levels[band + 1], moat);
    const lowersBy = new Map<number, LevelCurve[]>(), uppersBy = new Map<number, LevelCurve[]>();
    for (const [curves, uphill, into] of [
      [curvesAt[band], true, lowersBy], [curvesAt[band + 1], false, uppersBy],
    ] as const) {
      for (const curve of curves) {
        const label = componentOf(raster, components, curve, uphill);
        if (label < 0) {
          const [x, z] = curve.points[0];
          notes.push(`band ${band} ${uphill ? 'lower' : 'upper'} ${curve.closed ? 'loop' : 'arc'} `
            + `(${curve.points.length}p) at ${x.toFixed(0)},${z.toFixed(0)} matched no band component`);
          continue;
        }
        const list = into.get(label) ?? [];
        list.push(curve);
        into.set(label, list);
      }
    }
    for (const label of new Set([...lowersBy.keys(), ...uppersBy.keys()])) {
      const lowers = lowersBy.get(label) ?? [], uppers = uppersBy.get(label) ?? [];
      const before = builder.faces.length;
      const lowerLoops = lowers.filter(curve => curve.closed), lowerArcs = lowers.filter(curve => !curve.closed);
      const upperLoops = uppers.filter(curve => curve.closed), upperArcs = uppers.filter(curve => !curve.closed);
      if (process.env.SLOPESMITH_CONTOUR_TRACE) {
        const at = (lowers[0] ?? uppers[0]).points[0];
        notes.push(`band ${band} comp ${label} @${at[0].toFixed(0)},${at[1].toFixed(0)}: `
          + `L ${lowerLoops.length}loop+${lowerArcs.length}arc, U ${upperLoops.length}loop+${upperArcs.length}arc`);
      }
      if (!uppers.length) {
        // the component tops out: summits cap; arcs die against the coastline and the join ring closes them
        for (const curve of lowerLoops) if (rows.has(curve)) {
          shrinkCap(builder, raster, rows.get(curve)!.ids, cell);
          stats.caps++;
        }
        if (lowerArcs.length) stats.openBands++;
      } else if (!lowers.length) {
        for (const curve of upperLoops) {
          shrinkCap(builder, raster, rowFor(curve).ids, cell);
          stats.pits++;
        }
        if (upperArcs.length) stats.openBands++;
      } else {
        // Compose each side into one cycle or chain. Loops compose with a welded col pole while still
        // fresh (bands above knit the very same vertex) or with edge bridges once knitted; arcs chain in
        // the order they project onto the other side, joined by connector chords whose single-quad edges
        // fall to the join ring. A chained arc side facing a closed side wraps into a full cycle the same
        // way — the wrap chord crosses the coastline gap the ring later closes.
        const composeLoops = (loops: LevelCurve[]): number[] => {
          const loopRows = loops.map(curve => rowFor(curve));
          const ids = loopRows.length === 1 ? loopRows[0].ids
            : loopRows.every(row => fresh.has(row))
              ? weldCycle(builder, raster, loopRows)
              : bridgeCycle(builder, loopRows.map(row => row.ids));
          return ids;
        };
        const lowerCycle = lowerLoops.length ? composeLoops(lowerLoops) : null;
        const upperCycle = upperLoops.length ? composeLoops(upperLoops) : null;
        const lowerChains = lowerArcs.length
          ? chainsFor(lowerArcs.map(curve => rowFor(curve)), lowerArcs) : [];
        const upperChains = upperArcs.length
          ? chainsFor(upperArcs.map(curve => rowFor(curve)), upperArcs) : [];
        if (lowerCycle && upperCycle) {
          if (lowerLoops.length + upperLoops.length > 2) stats.saddles++;
          stats.parityTriangles += knitAligned(builder, lowerCycle, upperCycle);
        }
        // Chains match by role: a guest knits its whole length into a claimed sub-range of a host, so a
        // contour splitting or merging across the band shares one host between several guests. A chain
        // that guested is fully consumed and may never also host (its edges already carry this band's
        // quad); a host's unclaimed stretches stay open for the join ring.
        const lowerUsed = lowerChains.map(chain => chain.map(() => false));
        const upperUsed = upperChains.map(chain => chain.map(() => false));
        const lowerCycleUsed = lowerCycle && !upperCycle ? lowerCycle.map(() => false) : null;
        const upperCycleUsed = upperCycle && !lowerCycle ? upperCycle.map(() => false) : null;
        const isFree = (used: boolean[]): boolean => used.every(flag => !flag);
        const consume = (used: boolean[]): void => { used.fill(true); };
        // Candidate pairs knit in ascending distance order: a chain occluding another from its host is
        // by definition the nearer of the two, so it claims the host stretch first and the farther chain
        // clips to what remains. Each chain guests once, whole and free; hosting is per-edge.
        const PAIR_REACH = 3.5 * cell;
        interface ChainPair { l: number; u: number; d: number }
        const chainPairs: ChainPair[] = [];
        for (let l = 0; l < lowerChains.length; l++) for (let u = 0; u < upperChains.length; u++) {
          const d = Math.min(medianChainDistance(builder, lowerChains[l], upperChains[u]),
            medianChainDistance(builder, upperChains[u], lowerChains[l]));
          if (d < PAIR_REACH) chainPairs.push({ l, u, d });
        }
        chainPairs.sort((a, b) => a.d - b.d);
        for (const { l, u } of chainPairs) {
          const low = lowerChains[l], up = upperChains[u];
          const lowFree = isFree(lowerUsed[l]), upFree = isFree(upperUsed[u]);
          if (!lowFree && !upFree) continue;
          // guest the shorter free chain into the longer — but a chain whose OPPOSITE side holds the only
          // cycle must never be consumed as a guest: its remaining free runs are what the cycle knits to
          // (the first closed loop above clipped ground attaches to the arc that wraps it)
          const lowerMayGuest = lowFree && !(upperCycle && !lowerCycle);
          const upperMayGuest = upFree && !(lowerCycle && !upperCycle);
          if (upperMayGuest && (!lowerMayGuest || up.length <= low.length)) {
            if (knitChainIntoHost(builder, up, low, lowerUsed[l])) consume(upperUsed[u]);
          } else if (lowerMayGuest) {
            if (knitChainIntoHost(builder, low, up, upperUsed[u])) consume(lowerUsed[l]);
          }
        }
        // a chain's remaining free runs (a partial claim leaves some) still knit to a facing cycle —
        // this is how the first closed loop above clipped ground attaches to the arc that wraps it
        const cycleRuns = (chain: number[], used: boolean[],
          cycleIds: number[] | null, cycleUsed: boolean[] | null): boolean => {
          if (!cycleIds || !cycleUsed) return false;
          let any = false;
          let runStart = -1;
          for (let e = 0; e <= used.length; e++) {
            const free = e < used.length && !used[e];
            if (free && runStart < 0) runStart = e;
            if (!free && runStart >= 0) {
              const run = chain.slice(runStart, e + 1);
              if (run.length >= 2) {
                if (knitChainToCycle(builder, run, cycleIds, cycleUsed)) {
                  for (let i = runStart; i < e; i++) used[i] = true;
                  any = true;
                } else if (process.env.SLOPESMITH_CONTOUR_TRACE) {
                  const p = builder.vertices[run[0]];
                  notes.push(`band ${band}: cycle run (${run.length}v at `
                    + `${p[0].toFixed(0)},${p[2].toFixed(0)}) declined by the ${cycleIds.length}v cycle`);
                }
              }
              runStart = -1;
            }
          }
          return any;
        };
        for (let l = 0; l < lowerChains.length; l++) {
          const wasFree = isFree(lowerUsed[l]);
          if (process.env.SLOPESMITH_CONTOUR_TRACE) {
            notes.push(`band ${band}: lower chain ${l} (${lowerChains[l].length}v) `
              + `free edges ${lowerUsed[l].filter(flag => !flag).length}/${lowerUsed[l].length}, `
              + `cycle ${upperCycle ? `${upperCycle.length}v` : 'none'}`);
          }
          const knitAny = cycleRuns(lowerChains[l], lowerUsed[l], upperCycle, upperCycleUsed);
          if (knitAny || !wasFree) continue;
          stats.openBands++;
          const p = builder.vertices[lowerChains[l][0]];
          notes.push(`band ${band} lower chain (${lowerChains[l].length}v) at `
            + `${p[0].toFixed(0)},${p[2].toFixed(0)} found no partner `
            + `(${upperChains.length} upper chains, cycle ${upperCycle ? 'yes' : 'no'})`);
        }
        for (let u = 0; u < upperChains.length; u++) {
          const wasFree = isFree(upperUsed[u]);
          const knitAny = cycleRuns(upperChains[u], upperUsed[u], lowerCycle, lowerCycleUsed);
          if (knitAny || !wasFree) continue;
          stats.openBands++;
          const p = builder.vertices[upperChains[u][0]];
          notes.push(`band ${band} upper chain (${upperChains[u].length}v) at `
            + `${p[0].toFixed(0)},${p[2].toFixed(0)} found no partner `
            + `(${lowerChains.length} lower chains at `
            + `${lowerChains.map(low => medianChainDistance(builder, upperChains[u], low).toFixed(0)).join('/')} m, `
            + `cycle ${lowerCycle ? 'yes' : 'no'})`);
        }
      }
      for (const curve of [...lowers, ...uppers]) {
        const row = rows.get(curve);
        if (row) fresh.delete(row);
      }
      stats.sweptQuads += builder.faces.length - before;
    }
  }

  // the top level's closed hill curves have no band above: cap the summits
  for (const curve of curvesAt[curvesAt.length - 1] ?? []) {
    if (!curve.closed || !rows.has(curve)) continue;
    const [cx, cz] = ringCentroid(builder, rows.get(curve)!.ids);
    if (bilinear(raster, raster.height, cx, cz) >= levels[levels.length - 1]) {
      const before = builder.faces.length;
      shrinkCap(builder, raster, rows.get(curve)!.ids, cell);
      stats.caps++;
      stats.sweptQuads += builder.faces.length - before;
    }
  }
  // closed pit curves at the first level have no band below: cap the pit floors
  for (const curve of curvesAt[0] ?? []) {
    if (!curve.closed || !rows.has(curve)) continue;
    const [cx, cz] = ringCentroid(builder, rows.get(curve)!.ids);
    if (bilinear(raster, raster.height, cx, cz) < levels[0]) {
      const before = builder.faces.length;
      shrinkCap(builder, raster, rows.get(curve)!.ids, cell);
      stats.pits++;
      stats.sweptQuads += builder.faces.length - before;
    }
  }
  return { rows };
}

// ---- entry -----------------------------------------------------------------------------------------------

export function buildContourCandidate(input: ContourCandidateInput): ContourCandidateResult {
  const cell = Math.max(2, input.targetPatchSizeM);
  const notes: string[] = [];
  const stats: ContourCandidateStats = {
    rasterNodes: 0, levels: 0, sweptQuads: 0, ringQuads: 0, caps: 0, pits: 0, saddles: 0,
    openBands: 0, islandFills: 0, parityTriangles: 0, relaxedVertices: 0,
  };

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, , z] of input.surface.vertices) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  let step = cell / 4;
  const spanX = Math.max(1, maxX - minX), spanZ = Math.max(1, maxZ - minZ);
  if ((spanX / step) * (spanZ / step) > 2.5e6) step = Math.sqrt((spanX * spanZ) / 2.5e6);
  const raster = rasterize(input.surface, step);
  stats.rasterNodes = raster.width * raster.depth;
  grade(raster, (1.2 * cell) / step, 2);
  chamfer(raster);
  const moat = MOAT_CELLS * cell;

  const levels = scheduleLevels(raster, cell);
  stats.levels = levels.length;
  if (levels.length < 2) {
    throw new Error('the unlocked terrain spans less than two contour bands; use the QuadWild strategy here');
  }
  const curvesAt = levels.map(level => marchLevel(raster, level)
    .flatMap(curve => clipToClearance(raster, curve, moat))
    .filter(curve => curveLength(curve) >= (curve.closed ? 2.5 : 1.2) * cell));

  const builder = new Builder();
  sweepBands(builder, raster, levels, curvesAt, cell, moat, notes, stats);
  if (!builder.faces.length) throw new Error('the contour sweep produced no quads');

  // ---- join: knit every swept boundary loop to its region-boundary target -------------------------------
  const targets = joinTargets(input.boundaryProxy, input.interfaceCurves, cell, notes);
  // "On locked ground" is a NESTING-PARITY question, never a single polygon test: the network outline
  // contains every stand, and a stand's interior (depth 2) is unlocked ground again.
  const lockedRings = targets.filter(target => target.locked).map(target => {
    let loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
    for (const point of target.positions) {
      loX = Math.min(loX, point[0]); hiX = Math.max(hiX, point[0]);
      loZ = Math.min(loZ, point[2]); hiZ = Math.max(hiZ, point[2]);
    }
    return { ring: target.positions, loX, hiX, loZ, hiZ };
  });
  const insideLockedGround = (x: number, z: number): boolean => {
    let depth = 0;
    for (const polygon of lockedRings) {
      if (x < polygon.loX || x > polygon.hiX || z < polygon.loZ || z > polygon.hiZ) continue;
      let inside = false;
      for (let a = 0, b = polygon.ring.length - 1; a < polygon.ring.length; b = a++) {
        const pa = polygon.ring[a], pb = polygon.ring[b];
        if ((pa[2] > z) !== (pb[2] > z)
          && x < pa[0] + ((pb[0] - pa[0]) * (z - pa[2])) / (pb[2] - pa[2])) inside = !inside;
      }
      if (inside) depth++;
    }
    return depth % 2 === 1;
  };
  const nearestLockedRimPoint = (x: number, z: number): { d: number; x: number; z: number } => {
    let bestD = Infinity, bestX = 0, bestZ = 0;
    for (const polygon of lockedRings) {
      if (x < polygon.loX - bestD || x > polygon.hiX + bestD
        || z < polygon.loZ - bestD || z > polygon.hiZ + bestD) continue;
      const n = polygon.ring.length;
      for (let i = 0; i < n; i++) {
        const a = polygon.ring[i], b = polygon.ring[(i + 1) % n];
        const abx = b[0] - a[0], abz = b[2] - a[2];
        const len2 = abx * abx + abz * abz;
        const t = len2 > 1e-12 ? Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / len2)) : 0;
        const qx = a[0] + t * abx, qz = a[2] + t * abz;
        const d = Math.hypot(x - qx, z - qz);
        if (d < bestD) { bestD = d; bestX = qx; bestZ = qz; }
      }
    }
    return { d: bestD, x: bestX, z: bestZ };
  };
  splitPinches(builder, notes);
  // a pinch vertex (more than two boundary edges) would silently corrupt the boundary walk
  {
    const boundaryDegree = new Map<number, number>();
    const edgeUse = new Map<string, number>();
    for (const face of builder.faces) for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
    for (const [key, count] of edgeUse) {
      if (count !== 1) continue;
      for (const id of key.split(',').map(Number)) {
        boundaryDegree.set(id, (boundaryDegree.get(id) ?? 0) + 1);
      }
    }
    for (const [id, degree] of boundaryDegree) {
      if (degree > 2) {
        const p = builder.vertices[id];
        throw new Error(`the swept sheet pinches at ${p[0].toFixed(0)},${p[2].toFixed(0)} `
          + `(${degree} boundary edges on one vertex)`);
      }
    }
  }
  let sweptLoops: number[][];
  try {
    sweptLoops = boundaryLoops({ vertices: builder.vertices, faces: builder.faces });
  } catch (error) {
    throw new Error(`the swept contour sheet has a non-manifold boundary: ${(error as Error).message}`, { cause: error });
  }
  // small enclosed gaps (mismatched chords, parity-dropped edges) are capped shut before pairing; an odd
  // gap leaves one triangle for the global cancellation
  builder.stage = 'gap patch';
  let patchedLoops = 0;
  for (const ids of sweptLoops) {
    if (ids.length > 28) continue;
    // a loop owns a target only when it also stands NEAR it — a far target's centroid can fall inside
    // a small col gap by coincidence
    const ownsTarget = targets.some(target => {
      if (!pointInRing(builder, ids, target.centroid[0], target.centroid[1])) return false;
      let best = Infinity;
      for (const id of ids) {
        const p = builder.vertices[id];
        for (let i = 0; i < target.positions.length; i += Math.max(1, Math.floor(target.positions.length / 12))) {
          const q = target.positions[i];
          best = Math.min(best, Math.hypot(p[0] - q[0], p[2] - q[2]));
        }
      }
      return best < 3 * cell;
    });
    if (ownsTarget) continue;
    // which side does the sheet lie on? A gap hole's neighbouring face sits OUTSIDE the loop and the
    // loop caps shut; a face INSIDE means this is the outer boundary of a stray fragment (a sliver of
    // corridor the sweep couldn't hold together), which is deleted — the join ring paves its ground.
    const edgeOwner = builder.faces.findIndex(face => {
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        if ((a === ids[0] && b === ids[1]) || (a === ids[1] && b === ids[0])) return true;
      }
      return false;
    });
    if (edgeOwner >= 0) {
      const owner = builder.faces[edgeOwner];
      let cx = 0, cz = 0;
      for (const id of owner) { cx += builder.vertices[id][0]; cz += builder.vertices[id][2]; }
      if (pointInRing(builder, ids, cx / owner.length, cz / owner.length)) {
        const keyOf = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
        const byEdge = new Map<string, number[]>();
        builder.faces.forEach((face, slot) => {
          for (let i = 0; i < face.length; i++) {
            const key = keyOf(face[i], face[(i + 1) % face.length]);
            const list = byEdge.get(key);
            if (list) list.push(slot); else byEdge.set(key, [slot]);
          }
        });
        const fragment = new Set<number>([edgeOwner]);
        const queue = [edgeOwner];
        while (queue.length && fragment.size <= 250) {
          const at = queue.pop()!;
          for (let i = 0; i < builder.faces[at].length; i++) {
            const key = keyOf(builder.faces[at][i], builder.faces[at][(i + 1) % builder.faces[at].length]);
            for (const other of byEdge.get(key) ?? []) {
              if (!fragment.has(other)) { fragment.add(other); queue.push(other); }
            }
          }
        }
        if (fragment.size <= 250) {
          for (const slot of fragment) builder.faces[slot] = [];
          patchedLoops++;
          notes.push(`a stray ${fragment.size}-quad fragment near ${ids.length} boundary vertices removed`);
          continue;
        }
      }
    }
    let ring = [...ids];
    if (ring.length % 2) {
      builder.addTri(ring[0], ring[1], ring[2]);
      stats.parityTriangles++;
      ring = [ring[0], ...ring.slice(2)];
    }
    if (ring.length > CAP_LIMIT) shrinkCap(builder, raster, skyward(builder, ring), cell);
    else capRow(builder, skyward(builder, ring), raster);
    patchedLoops++;
  }
  if (patchedLoops) {
    builder.compact();
    notes.push(`${patchedLoops} small gap loop(s) resolved`);
    sweptLoops = boundaryLoops({ vertices: builder.vertices, faces: builder.faces });
  }
  const paired = new Map<number, JoinTarget[]>();
  const unpaired: JoinTarget[] = [];
  for (const target of targets) {
    let best = -1, bestDistance = Infinity;
    for (let loop = 0; loop < sweptLoops.length; loop++) {
      const ids = sweptLoops[loop];
      const contains = pointInRing(builder, ids, target.centroid[0], target.centroid[1]);
      const contained = (() => {
        const [x, z] = ringCentroid(builder, ids);
        let inside = false;
        const ring = target.positions;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a[2] > z) !== (b[2] > z) && x < a[0] + ((b[0] - a[0]) * (z - a[2])) / (b[2] - a[2])) inside = !inside;
        }
        return inside;
      })();
      if (!contains && !contained) continue;
      let sum = 0, count = 0;
      const stride = Math.max(1, Math.floor(ids.length / 24));
      for (let i = 0; i < ids.length; i += stride) {
        const p = builder.vertices[ids[i]];
        let bestSegment = Infinity;
        for (let j = 0; j < target.positions.length; j++) {
          const a = target.positions[j], b = target.positions[(j + 1) % target.positions.length];
          const abx = b[0] - a[0], abz = b[2] - a[2];
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12
            ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
          bestSegment = Math.min(bestSegment, Math.hypot(p[0] - a[0] - t * abx, p[2] - a[2] - t * abz));
        }
        sum += bestSegment; count++;
      }
      const distance = count ? sum / count : Infinity;
      if (distance < bestDistance) { bestDistance = distance; best = loop; }
    }
    if (best >= 0) {
      const list = paired.get(best) ?? [];
      list.push(target);
      paired.set(best, list);
    } else unpaired.push(target);
  }
  // a hole whose moat merged into a larger swept loop fails both containment tests (the loop detours
  // around it); it still joins the loop that runs right past it. The connector must stay on covered
  // ground — a loop that is merely NEAR across a locked feature (a stand rim against the sheet on the
  // trail's far side) is no partner, and such a target falls through to the island fill instead.
  for (let i = unpaired.length - 1; i >= 0; i--) {
    const target = unpaired[i];
    let best = -1, bestDistance = 3 * cell;
    for (let loop = 0; loop < sweptLoops.length; loop++) {
      const ids = sweptLoops[loop];
      let sum = 0, count = 0, nearX = 0, nearZ = 0, nearest = Infinity;
      const stride = Math.max(1, Math.floor(target.positions.length / 16));
      for (let j = 0; j < target.positions.length; j += stride) {
        const p = target.positions[j];
        let bestSegment = Infinity;
        for (let k = 0; k < ids.length; k++) {
          const a = builder.vertices[ids[k]], b = builder.vertices[ids[(k + 1) % ids.length]];
          const abx = b[0] - a[0], abz = b[2] - a[2];
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12
            ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
          const qx = a[0] + t * abx, qz = a[2] + t * abz;
          const d = Math.hypot(p[0] - qx, p[2] - qz);
          bestSegment = Math.min(bestSegment, d);
          if (d < nearest) { nearest = d; nearX = qx; nearZ = qz; }
        }
        sum += bestSegment; count++;
      }
      const distance = count ? sum / count : Infinity;
      if (distance >= bestDistance) continue;
      // the path from the rim to the loop must not cross locked ground (an open moat between a cut-back
      // terrain edge and the feature is fine — the ring paves it); judged by nesting parity, with the
      // target's own interior excluded (the connector starts at its centroid)
      let blocked = false;
      for (let step = 1; step < 8 && !blocked; step++) {
        const t = step / 8;
        const x = target.centroid[0] + (nearX - target.centroid[0]) * t;
        const z = target.centroid[1] + (nearZ - target.centroid[1]) * t;
        let insideOwn = false;
        const own = target.positions;
        for (let a = 0, b = own.length - 1; a < own.length; b = a++) {
          const pa = own[a], pb = own[b];
          if ((pa[2] > z) !== (pb[2] > z)
            && x < pa[0] + ((pb[0] - pa[0]) * (z - pa[2])) / (pb[2] - pa[2])) insideOwn = !insideOwn;
        }
        if (insideOwn) continue;
        if (insideLockedGround(x, z)) blocked = true;
      }
      if (blocked) continue;
      bestDistance = distance;
      best = loop;
    }
    if (best >= 0) {
      const list = paired.get(best) ?? [];
      list.push(target);
      paired.set(best, list);
      unpaired.splice(i, 1);
    }
  }
  for (let loop = 0; loop < sweptLoops.length; loop++) {
    if (!paired.has(loop)) {
      const [x, z] = ringCentroid(builder, sweptLoops[loop]);
      // vertex-connected components of the swept sheet, so a fragmentation bug names its pieces
      const parent = new Map<number, number>();
      const find = (a: number): number => {
        let root = a;
        while (parent.get(root) !== root) root = parent.get(root)!;
        while (parent.get(a) !== root) { const next = parent.get(a)!; parent.set(a, root); a = next; }
        return root;
      };
      for (const face of builder.faces) {
        for (const id of face) if (!parent.has(id)) parent.set(id, id);
        for (let i = 1; i < face.length; i++) parent.set(find(face[i]), find(face[0]));
      }
      const componentOfLoop = sweptLoops.map(ids => find(ids[0]));
      const componentCount = new Set([...parent.keys()].map(find)).size;
      const shape = sweptLoops.map((ids, index) => {
        const [cx, cz] = ringCentroid(builder, ids);
        let loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
        for (const id of ids) {
          const p = builder.vertices[id];
          loX = Math.min(loX, p[0]); hiX = Math.max(hiX, p[0]);
          loZ = Math.min(loZ, p[2]); hiZ = Math.max(hiZ, p[2]);
        }
        return `#${index}:${ids.length}v@${cx.toFixed(0)},${cz.toFixed(0)}`
          + `[${loX.toFixed(0)}..${hiX.toFixed(0)},${loZ.toFixed(0)}..${hiZ.toFixed(0)}]`
          + `c${componentOfLoop[index]}${paired.has(index) ? '*' : ''}`;
      }).join(' ');
      const message = `a swept boundary loop near ${x.toFixed(0)},${z.toFixed(0)} `
        + `(${sweptLoops[loop].length} vertices) matches no region boundary; `
        + `${targets.length} targets, ${componentCount} sheet component(s), loops ${shape}`;
      if (!input.lenient) throw new Error(message);
      notes.push(`JOIN FAILURE: ${message}`);
    }
  }

  const realize = (target: JoinTarget, parity: number): number[] => {
    if (target.ids) return target.ids;
    if (target.locked) {
      target.ids = target.positions.map(point => builder.addVertex(point[0], point[1], point[2]));
    } else {
      target.ids = resampleFreeRim(target.positions, cell, parity).map(([x, z]) => {
        const y = bilinear(raster, raster.height, x, z);
        return builder.addVertex(x, Number.isNaN(y) ? target.positions[0][1] : y, z);
      });
    }
    return target.ids;
  };
  /**
   * A locked rim never receives kites directly: a kite spanning two rim edges around a convex feature
   * corner covers the feature itself, and kinked first rows bow their bicubic surfaces over the outline.
   * Instead the rim gets an intermediate ring at the SAME vertex count — one rectangular strip quad per
   * rim edge — and every count-absorbing kite lands one ring out, on unlocked ground. Returns the ring
   * the knit composite should use in the rim's place.
   */
  const intermediates = new Map<JoinTarget, number[]>();
  const bufferLockedRim = (target: JoinTarget, towards: number[] | null): number[] => {
    const found = intermediates.get(target);
    if (found) return found;
    const ids = target.ids!;
    const n = ids.length;
    const offsetM = RIM_STRIP_CELLS * cell;
    const ring = ids.map((id, index) => {
      const p = builder.vertices[id];
      const previous = builder.vertices[ids[(index - 1 + n) % n]];
      const next = builder.vertices[ids[(index + 1) % n]];
      const tx = next[0] - previous[0], tz = next[2] - previous[2];
      const length = Math.hypot(tx, tz) || 1;
      // two normal candidates; the intermediate ring stands on the side the sheet is on — toward the
      // swept loop when there is one, toward the stand's own interior for an island fill
      const candidates: [number, number][] = [
        [p[0] - (tz / length) * offsetM, p[2] + (tx / length) * offsetM],
        [p[0] + (tz / length) * offsetM, p[2] - (tx / length) * offsetM],
      ];
      const towardsSheet = (x: number, z: number): number => {
        if (!towards) return Math.hypot(x - target.centroid[0], z - target.centroid[1]);
        // exact distance to the swept polyline: strided vertex sampling flips the side at rim corners,
        // and a corner ring vertex on the wrong diagonal rails the whole strip across the feature
        let best = Infinity;
        for (let i = 0; i < towards.length; i++) {
          const a = builder.vertices[towards[i]], b = builder.vertices[towards[(i + 1) % towards.length]];
          const abx = b[0] - a[0], abz = b[2] - a[2];
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12
            ? Math.max(0, Math.min(1, ((x - a[0]) * abx + (z - a[2]) * abz) / len2)) : 0;
          best = Math.min(best, Math.hypot(x - a[0] - t * abx, z - a[2] - t * abz));
        }
        return best;
      };
      const [x, z] = towardsSheet(...candidates[0]) <= towardsSheet(...candidates[1])
        ? candidates[0] : candidates[1];
      const y = bilinear(raster, raster.height, x, z);
      return builder.addVertex(x, Number.isNaN(y) ? p[1] : y, z);
    });
    for (let i = 0; i < n; i++) {
      builder.addQuad(ids[i], ids[(i + 1) % n], ring[(i + 1) % n], ring[i]);
    }
    intermediates.set(target, ring);
    return ring;
  };
  builder.stage = 'join ring';
  // rings whose targets are all locked have fixed parity and may each cost a triangle; rings carrying a
  // free rim knit last, and the final one also absorbs whatever triangle debt the sheet already carries
  // (sweep knits, gap patches, earlier rings) so the global count pairs up for cancellation
  const ringGroups = [...paired.entries()]
    .sort((a, b) => Number(a[1].some(t => !t.locked)) - Number(b[1].some(t => !t.locked)));
  const lastFree = ringGroups.reduce(
    (found, [, joined], index) => (joined.some(t => !t.locked) ? index : found), -1);
  for (let group = 0; group < ringGroups.length; group++) {
    const [loop, joined] = ringGroups[group];
    const swept = sweptLoops[loop];
    const before = builder.faces.length;
    if (process.env.SLOPESMITH_CONTOUR_TRACE) {
      const [cx, cz] = ringCentroid(builder, swept);
      notes.push(`join group: swept loop #${loop} (${swept.length}v @${cx.toFixed(0)},${cz.toFixed(0)}) <- `
        + joined.map(target => `${target.locked ? 'locked' : 'free'} ${target.positions.length}c `
          + `@${target.centroid[0].toFixed(0)},${target.centroid[1].toFixed(0)}`).join(' + '));
    }
    // Each ring must traverse in the direction the swept loop walks past it, or the knit drapes quads
    // across the feature: a merged-moat loop passes a hole's bay OPPOSITE to how it rounds the outer rim,
    // so per-ring correlation against the winding-fixed swept loop decides, not a global rule — and the
    // knit itself must not renormalize either side afterwards.
    const sweptOriented = skyward(builder, swept);
    const loopLine = sweptOriented.map(id => builder.vertices[id]);
    const loopCumulative = [0];
    for (let i = 1; i <= loopLine.length; i++) {
      const a = loopLine[i - 1], b = loopLine[i % loopLine.length];
      loopCumulative.push(loopCumulative[i - 1] + Math.hypot(a[0] - b[0], a[2] - b[2]));
    }
    const loopTotal = loopCumulative[loopLine.length];
    const paramOnLoop = (p: V3): number => {
      let best = 0, bestDistance = Infinity;
      for (let i = 0; i < loopLine.length; i++) {
        const a = loopLine[i], b = loopLine[(i + 1) % loopLine.length];
        const abx = b[0] - a[0], abz = b[2] - a[2];
        const len2 = abx * abx + abz * abz;
        const t = len2 > 1e-12
          ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[2] - a[2]) * abz) / len2)) : 0;
        const d = Math.hypot(p[0] - a[0] - t * abx, p[2] - a[2] - t * abz);
        if (d < bestDistance) { bestDistance = d; best = loopCumulative[i] + t * Math.sqrt(len2); }
      }
      return best;
    };
    // A locked rim whose whole projection lands within a couple of swept edges cannot ride in the
    // composite: the knit would fan its entire ring plus both bridge hops off one anchor, doubling
    // spokes through the duplicated bridge vertices. Such a target is an island fill.
    const kept: JoinTarget[] = [];
    for (const target of joined) {
      if (!target.locked || joined.length === 1) { kept.push(target); continue; }
      let loParam = Infinity, hiParam = -Infinity;
      const origin = paramOnLoop(target.positions[0]);
      for (const point of target.positions) {
        let param = paramOnLoop(point) - origin;
        if (param > loopTotal / 2) param -= loopTotal;
        if (param < -loopTotal / 2) param += loopTotal;
        loParam = Math.min(loParam, param);
        hiParam = Math.max(hiParam, param);
      }
      const span = hiParam - loParam;
      // The rim must also SEE the loop: a central stand projects widely onto the moat that encircles
      // the whole network, but every line from it to that moat crosses the trail. Sample connectors
      // from a few rim corners to their nearest loop points; locked ground on the way (own ring
      // excluded) means the loop is not this rim's neighbour, whatever the projections say.
      let visible = false;
      const probeCount = Math.min(6, target.positions.length);
      for (let probe = 0; probe < probeCount && !visible; probe++) {
        const point = target.positions[Math.floor((probe * target.positions.length) / probeCount)];
        let bestD = Infinity, nearX = 0, nearZ = 0;
        for (let i = 0; i < loopLine.length; i++) {
          const a = loopLine[i], b = loopLine[(i + 1) % loopLine.length];
          const abx = b[0] - a[0], abz = b[2] - a[2];
          const len2 = abx * abx + abz * abz;
          const t = len2 > 1e-12
            ? Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[2] - a[2]) * abz) / len2)) : 0;
          const qx = a[0] + t * abx, qz = a[2] + t * abz;
          const d = Math.hypot(point[0] - qx, point[2] - qz);
          if (d < bestD) { bestD = d; nearX = qx; nearZ = qz; }
        }
        let clear = true;
        for (let step = 1; step < 8 && clear; step++) {
          const t = step / 8;
          const x = point[0] + (nearX - point[0]) * t;
          const z = point[2] + (nearZ - point[2]) * t;
          let insideOwn = false;
          const own = target.positions;
          for (let a = 0, b = own.length - 1; a < own.length; b = a++) {
            const pa = own[a], pb = own[b];
            if ((pa[2] > z) !== (pb[2] > z)
              && x < pa[0] + ((pb[0] - pa[0]) * (z - pa[2])) / (pb[2] - pa[2])) insideOwn = !insideOwn;
          }
          if (insideOwn) continue;
          if (insideLockedGround(x, z)) clear = false;
        }
        if (clear) visible = true;
      }
      if (span < 2.5 * (loopTotal / sweptOriented.length) || !visible) {
        unpaired.push(target);
        notes.push(`a locked rim near ${target.centroid[0].toFixed(0)},${target.centroid[1].toFixed(0)} `
          + `${visible ? 'spans too little of' : 'cannot see'} its swept loop; filled as an island instead`);
      } else kept.push(target);
    }
    // a loop must knit to something; a pathological group of only tiny rims keeps its first
    if (!kept.length) kept.push(joined[0]);
    const joinedKept = kept;
    const lockedCount = joinedKept.filter(target => target.locked)
      .reduce((sum, target) => sum + target.positions.length, 0);
    const bridges = 2 * (joinedKept.length - 1);
    // choose the free rims' parity so the ring needs no triangle — or exactly one, when this is the
    // last free ring and the sheet's triangle count is odd
    let wantFreeParity = (sweptOriented.length + lockedCount + bridges
      + (group === lastFree ? stats.parityTriangles % 2 : 0)) % 2;
    const rings = joinedKept.map(target => {
      if (target.locked) {
        realize(target, 0);
        return bufferLockedRim(target, swept);
      }
      const ids = realize(target, wantFreeParity);
      wantFreeParity = 0;
      return ids;
    });
    for (let r = 0; r < rings.length; r++) {
      const ids = rings[r];
      const samples = Math.min(12, ids.length);
      let forward = 0;
      let previous = paramOnLoop(builder.vertices[ids[0]]);
      for (let k = 1; k <= samples; k++) {
        const at = paramOnLoop(builder.vertices[ids[Math.floor((k * ids.length) / (samples + 1))] ?? ids[0]]);
        let diff = at - previous;
        if (diff > loopTotal / 2) diff -= loopTotal;
        if (diff < -loopTotal / 2) diff += loopTotal;
        forward += Math.sign(diff);
        previous = at;
      }
      if (forward < 0) rings[r] = [...ids].reverse();
    }
    const cycle = joinedKept.length === 1 ? rings[0] : bridgeCycle(builder, rings);
    const [narrow, wide] = sweptOriented.length <= cycle.length
      ? [sweptOriented, cycle] : [cycle, sweptOriented];
    stats.parityTriangles += knitRings(builder, narrow, wide);
    stats.ringQuads += builder.faces.length - before;
  }

  // enclosed stands too small to sweep: fill from their rims inward
  builder.stage = 'island fill';
  const consumed = new Set<JoinTarget>();
  for (const target of unpaired) {
    if (consumed.has(target)) continue;
    const children = unpaired.filter(other => {
      if (other === target || consumed.has(other)) return false;
      // judged at a rim corner — a concave ring's centroid can sit inside a sibling
      const [x, , z] = other.positions[0];
      let containedInTarget = false;
      const ring = target.positions;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a[2] > z) !== (b[2] > z) && x < a[0] + ((b[0] - a[0]) * (z - a[2])) / (b[2] - a[2])) {
          containedInTarget = !containedInTarget;
        }
      }
      return containedInTarget;
    });
    const before = builder.faces.length;
    if (children.length) {
      const outerIds = realize(target, 0);
      const childIds = children.map(child => realize(child, 0));
      const outerRing = target.locked ? bufferLockedRim(target, childIds[0]) : outerIds;
      const childRings = children.map((child, index) =>
        child.locked ? bufferLockedRim(child, outerIds) : childIds[index]);
      const cycle = childRings.length === 1 ? childRings[0] : bridgeCycle(builder, childRings);
      stats.parityTriangles += knitAligned(builder, outerRing, cycle);
      children.forEach(child => consumed.add(child));
    } else {
      // Only an enclosed STAND may be filled; a locked HOLE's interior is the feature itself, and paving
      // it would be caught by the footprint gate far too late. The discriminator is nesting parity of
      // the locked rims: a rim inside an odd number of OTHER locked rims (a stand inside the network's
      // outline) encloses unlocked ground — even a stand whose terrain island was cut away entirely, so
      // the fill legitimately CREATES its ground.
      let depth = 0;
      for (const other of targets) {
        if (other === target || !other.locked) continue;
        // judged at a rim corner — a concave ring's centroid can sit inside a sibling
        const x = target.positions[0][0], z = target.positions[0][2];
        const ring = other.positions;
        let inside = false;
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const pa = ring[a], pb = ring[b];
          if ((pa[2] > z) !== (pb[2] > z)
            && x < pa[0] + ((pb[0] - pa[0]) * (z - pa[2])) / (pb[2] - pa[2])) inside = !inside;
        }
        if (inside) depth++;
      }
      if (target.locked && depth % 2 === 0) {
        throw new Error(`a locked feature rim near ${target.centroid[0].toFixed(0)},`
          + `${target.centroid[1].toFixed(0)} found no swept sheet to join`);
      }
      // a disk fill must not contain any OTHER locked ring — a stand whose nested feature paired with
      // its own sweep elsewhere would be paved over silently
      let threaded = false;
      for (const other of targets) {
        if (other === target || !other.locked || consumed.has(other)) continue;
        const [x, , z] = other.positions[0];
        const ring = target.positions;
        let inside = false;
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const pa = ring[a], pb = ring[b];
          if ((pa[2] > z) !== (pb[2] > z)
            && x < pa[0] + ((pb[0] - pa[0]) * (z - pa[2])) / (pb[2] - pa[2])) inside = !inside;
        }
        if (inside) {
          const message = `an island fill near ${target.centroid[0].toFixed(0)},`
            + `${target.centroid[1].toFixed(0)} would pave over the locked rim near `
            + `${other.centroid[0].toFixed(0)},${other.centroid[1].toFixed(0)}; `
            + 'its nested structure pairs elsewhere and the fill cannot thread it yet';
          if (!input.lenient) throw new Error(message);
          notes.push(`JOIN FAILURE: ${message}`);
          threaded = true;
        }
      }
      if (threaded) {
        consumed.add(target);
        continue;
      }
      const ids = realize(target, 0);
      let fill = target.locked ? bufferLockedRim(target, null) : ids;
      if (fill.length % 2) {
        // an isolated odd rim cannot be all-quad (its parity has nowhere to route); one collapsed
        // wedge pays the difference and the rest caps as usual
        builder.addWedge(fill[0], fill[1], fill[2]);
        fill = [fill[0], ...fill.slice(2)];
      }
      shrinkCap(builder, raster, fill, cell);
    }
    consumed.add(target);
    stats.islandFills++;
    stats.ringQuads += builder.faces.length - before;
  }

  try {
    cancelParityTriangles(builder, notes);
  } catch (error) {
    if (!input.lenient) throw error;
    notes.push(`JOIN FAILURE: ${(error as Error).message}`);
    builder.compact();
  }

  const fixed = new Set<number>();
  for (const target of targets) for (const id of target.ids ?? []) fixed.add(id);
  // No free vertex may stand on locked ground or graze its rim: judged by nesting parity, and repaired
  // by mirroring across the nearest rim onto the unlocked side past a small margin. Runs before AND
  // after relaxation, which can drag a first-row vertex back toward the feature.
  const pushOffLockedOutlines = (): number => {
    const margin = 0.06 * cell;
    let pushed = 0;
    for (let id = 0; id < builder.vertices.length; id++) {
      if (fixed.has(id)) continue;
      const p = builder.vertices[id];
      const onLocked = insideLockedGround(p[0], p[2]);
      const nearest = nearestLockedRimPoint(p[0], p[2]);
      if (!onLocked && nearest.d >= margin) continue;
      const nx = p[0] - nearest.x, nz = p[2] - nearest.z;
      const length = Math.hypot(nx, nz);
      const sign = onLocked ? -1 : 1;
      p[0] = nearest.x + (length > 1e-9 ? (sign * nx) / length : 1) * margin;
      p[2] = nearest.z + (length > 1e-9 ? (sign * nz) / length : 0) * margin;
      const y = bilinear(raster, raster.height, p[0], p[2]);
      if (!Number.isNaN(y)) p[1] = y;
      pushed++;
    }
    return pushed;
  };
  const pushedBefore = pushOffLockedOutlines();
  stats.relaxedVertices = relaxInterior(builder, raster, fixed, 16);
  // pushing is unguarded (clearing the outline outranks shape), so alternate with fold-repairing
  // relaxation until both are quiet
  let pushedAfter = 0;
  for (let round = 0; round < 3; round++) {
    const pushed = pushOffLockedOutlines();
    pushedAfter += pushed;
    if (!pushed) break;
    stats.relaxedVertices += relaxInterior(builder, raster, fixed, 4);
  }
  if (pushedBefore + pushedAfter) {
    notes.push(`${pushedBefore}+${pushedAfter} vertex/vertices pushed clear of locked outlines`);
  }

  // ---- validation ----------------------------------------------------------------------------------------
  const use = new Map<string, number>();
  let wedges = 0;
  for (const face of builder.faces) {
    const unique = new Set(face).size;
    const wedge = face.length === 4 && unique === 3
      && face.some((id, i) => id === face[(i + 1) % 4]);
    if (wedge) wedges++;
    if (face.length !== 4 || (unique !== 4 && !wedge)) {
      if (!input.lenient) throw new Error('contour candidate holds a non-quad face after parity cancellation');
      notes.push('JOIN FAILURE: a non-quad face survived parity cancellation');
      continue;
    }
    for (let i = 0; i < 4; i++) {
      const a = face[i], b = face[(i + 1) % 4];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  if (wedges) notes.push(`${wedges} collapsed wedge(s) paid for odd locked rims`);
  for (const [key, count] of use) {
    if (count > 2) {
      const [a, b] = key.split(',').map(Number);
      const pa = builder.vertices[a], pb = builder.vertices[b];
      const holders = builder.faces
        .map((face, slot) => ({ face, slot }))
        .filter(({ face }) => face.includes(a) && face.includes(b))
        .map(({ face, slot }) => {
          let cx = 0, cz = 0;
          for (const id of face) { cx += builder.vertices[id][0]; cz += builder.vertices[id][2]; }
          return `#${slot}[${builder.faceStage[slot] ?? '?'}]`
            + `@${(cx / face.length).toFixed(0)},${(cz / face.length).toFixed(0)}`;
        });
      const message = `contour candidate edge ${pa[0].toFixed(0)},${pa[2].toFixed(0)}`
        + `-${pb[0].toFixed(0)},${pb[2].toFixed(0)} is used ${count} times by ${holders.join(' ')}`;
      if (!input.lenient) throw new Error(message);
      notes.push(`JOIN FAILURE: ${message}`);
    }
  }
  const targetIds = new Set(targets.flatMap(target => target.ids ?? []));
  for (const [key, count] of use) {
    if (count !== 1) continue;
    const [a, b] = key.split(',').map(Number);
    if (!targetIds.has(a) || !targetIds.has(b)) {
      const p = builder.vertices[a];
      const message = `the contour sheet has an open edge off the region boundary near `
        + `${p[0].toFixed(0)},${p[2].toFixed(0)}`;
      if (!input.lenient) throw new Error(message);
      notes.push(`JOIN FAILURE: ${message}`);
      break;
    }
  }
  {
    // one candidate component per proxy region component — a knit that quietly failed leaves an island
    const parent = new Map<number, number>();
    const find = (a: number): number => {
      let root = a;
      while (parent.get(root) !== root) root = parent.get(root)!;
      while (parent.get(a) !== root) { const next = parent.get(a)!; parent.set(a, root); a = next; }
      return root;
    };
    for (const face of builder.faces) {
      for (const id of face) if (!parent.has(id)) parent.set(id, id);
      for (let i = 1; i < face.length; i++) parent.set(find(face[i]), find(face[0]));
    }
    const candidateComponents = new Set([...parent.keys()].map(find)).size;
    // one candidate component per UNLOCKED REGION: the outer mountain plus every odd-nesting-depth
    // locked rim (a stand). The proxy's own component count over-counts wherever the terrain cut left a
    // stand's lattice in several fragments.
    let expected = 1;
    for (const polygon of lockedRings) {
      // containment is judged at a rim CORNER: a concave ring's centroid can sit inside a sibling
      const cx = polygon.ring[0][0], cz = polygon.ring[0][2];
      let depth = 0;
      for (const other of lockedRings) {
        if (other === polygon) continue;
        let inside = false;
        for (let a = 0, b = other.ring.length - 1; a < other.ring.length; b = a++) {
          const pa = other.ring[a], pb = other.ring[b];
          if ((pa[2] > cz) !== (pb[2] > cz)
            && cx < pa[0] + ((pb[0] - pa[0]) * (cz - pa[2])) / (pb[2] - pa[2])) inside = !inside;
        }
        if (inside) depth++;
      }
      if (depth % 2 === 1) expected++;
    }
    if (candidateComponents !== expected) {
      const message = `the contour candidate has ${candidateComponents} component(s) `
        + `for the region's ${expected}`;
      if (!input.lenient) throw new Error(message);
      notes.push(`JOIN FAILURE: ${message}`);
    }
  }

  // No face may sit over locked ground — judged by nesting parity, since an open moat between a
  // cut-back terrain edge and the feature is legal for the join ring. A stray offender (a knit quad
  // cutting a bay's corner) repairs by mirroring its free vertices across the nearest rim; whatever
  // remains is a hard failure the job's footprint gate would reject far less legibly.
  for (let round = 0; round < 24; round++) {
    let draped = 0;
    for (const face of builder.faces) {
      let cx = 0, cz = 0;
      for (const id of face) { cx += builder.vertices[id][0]; cz += builder.vertices[id][2]; }
      cx /= face.length; cz /= face.length;
      if (!insideLockedGround(cx, cz)) continue;
      draped++;
      for (const id of face) {
        if (fixed.has(id)) continue;
        const p = builder.vertices[id];
        const nearest = nearestLockedRimPoint(p[0], p[2]);
        const sign = insideLockedGround(p[0], p[2]) ? -1 : 1;
        const nx = p[0] - nearest.x, nz = p[2] - nearest.z;
        const length = Math.hypot(nx, nz);
        if (!(length > 1e-9)) continue;
        p[0] += ((sign * nx) / length) * raster.step;
        p[2] += ((sign * nz) / length) * raster.step;
        const y = bilinear(raster, raster.height, p[0], p[2]);
        if (!Number.isNaN(y)) p[1] = y;
      }
    }
    if (!draped) break;
  }
  {
    const draped: string[] = [];
    for (const face of builder.faces) {
      let cx = 0, cz = 0;
      for (const id of face) { cx += builder.vertices[id][0]; cz += builder.vertices[id][2]; }
      cx /= face.length; cz /= face.length;
      if (insideLockedGround(cx, cz)) draped.push(`${cx.toFixed(0)},${cz.toFixed(0)}`);
    }
    if (draped.length > 2) {
      const message = `${draped.length} candidate faces are draped over locked footprints (${draped.slice(0, 3).join(' ')})`;
      if (!input.lenient) throw new Error(message);
      notes.push(`JOIN FAILURE: ${message}`);
    } else if (draped.length) {
      // a stray survivor of the repair rounds is left to the job's footprint gate, which measures its
      // actual depth instead of its existence
      notes.push(`${draped.length} face(s) still lean over a locked rim at ${draped.join(' ')}; `
        + 'the footprint gate judges their depth');
    }
  }

  notes.push(`${stats.levels} graded elevation levels; ${stats.sweptQuads} swept + ${stats.ringQuads} `
    + `join-ring quads; ${stats.caps} caps, ${stats.pits} pits, ${stats.saddles} saddles, `
    + `${stats.openBands} open bands absorbed by the join, ${stats.islandFills} island fills`);
  return { mesh: { vertices: builder.vertices, faces: builder.faces }, notes, stats };
}
