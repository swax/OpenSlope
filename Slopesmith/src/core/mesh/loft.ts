import type { QuadMeshDoc, V3 } from '../doc/types';
import { appendMeshIds } from '../doc/ids';
import { len, sub } from '../math/vec';
import { checkManifold, ekey, orderEdgeChain } from './ops';
import { directedEdgeKey, readVertex } from './primitives';
import { buildQuadMesh, meshEdgeHandles } from './topology';

/**
 * LOFT (docs/023 S1): the one geometry generator that spans N ordered RAILS with a quad chart. A rail is an
 * ordered run of existing vertex ids — an adopted edge run (`selection.ts` `meshEdgeLoop`) or any hand-listed
 * station sequence — and the rails are given in CROSS-SECTION order (rail 0 to rail N−1 across the ribbon). Every
 * rail carries the same station count S, so the chart is an (N−1)-lane × (S−1)-station grid of quads whose corners
 * are the rail vertices THEMSELVES by default. With `targetPatchM`, long spans gain interpolated rails whose
 * vertices are appended without renumbering the inputs. A loft between two host
 * edge runs is therefore a bridge that is watertight by construction — the two seams it closes are the hosts' own
 * boundary vertices, shared, not duplicated (the "loft is the knitting tool" of docs/023).
 *
 * Winding — the load-bearing choice the spec left open. The chart's two parameter axes map onto the quad storage
 * `[A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)]` (topology.ts) as **u = along a rail (station), v = across the rails
 * (lane)**. So one quad spanning lanes n..n+1 at stations s..s+1 stores `[rail[n][s], rail[n+1][s], rail[n][s+1],
 * rail[n+1][s+1]]`: A→C runs down one rail (+u, the spine), A→B crosses to the next rail (+v). That is the
 * flow-oriented convention the extracted snow ribbons carry — "two neighbours along the seam, one across" (docs/023):
 * u is the flow down the mountain, v the cross-section. Chosen for self-consistency: adjacent lanes meet along a
 * shared rail, which is lane n's v=1 column and lane n+1's v=0 column — exactly how a promoted grid's cells abut —
 * so the whole chart reads with one u/v frame and neighbouring patches never disagree on orientation. Whether the
 * derived normal points skyward is then the CALLER's business, decided by the rail order × station order it picks,
 * the same as any hand-built patch; the loft only guarantees the frame is congruent across the chart.
 *
 * No edge handles are written, so every seam the loft lays down is Bessel-smooth (the absent-handle default,
 * topology.ts `meshEdgeHandles`) — the shipped 1/3-handle convention already, so a loft is born G1 with its
 * neighbours with nothing to tune. New quads take no `quadPaint` entry and inherit `baseSurface`; `opts.surface`
 * paints them all (the floor-cell paint docs/023 applies on emit).
 *
 * Refusals are explicit (the doc's stitched-refuses model — never a silent fixup), each with its own message:
 *  - fewer than 2 rails, fewer than 2 stations, a rail whose station count differs, or an out-of-range vertex id;
 *  - a rail whose endpoints sit equidistant from the previous rail's (a symmetric / closed run) — the reversal test
 *    can't tell which way it runs, so the loft bails rather than guess;
 *  - a quad whose four corners already form an existing patch (compared as a corner SET, so any rotation / reflection
 *    counts) — a loft never re-covers a patch;
 *  - two adjacent rails meeting at one station (the lane between them folds to a triangle) — distinct from
 *  - any other repeated corner (a rail doubling back on itself), a degenerate quad;
 *  - a chart that would drive an edge to 3+ quads (overlaying a stitched seam) — the shared manifold guard.
 *
 * Direction alignment: rails may be picked either way round. Each rail past the first is oriented to the previous
 * (already-oriented) one by a nearest-endpoint test — reverse it when its ends clearly match the previous rail's
 * REVERSED order — and every reversal is reported in `reversed` (input rail indices) for the ghost / outliner.
 *
 * Pure and deterministic: same inputs → a byte-identical doc, no clock / RNG. The loft only APPENDS quads and any
 * requested intermediate-rail vertices, so existing ids are stable and there is nothing to compact — unlike the
 * surgery ops it needs no `remapIds`, and it leaves loose (not-yet-quadded) vertices untouched, which is what lets an
 * adopted rail sit in the buffer before it is lofted.
 */

/** How near the two endpoint-sum candidates may sit before the reversal test is a tie the loft won't break. */
const ALIGN_EPS = 1e-6;

export interface LoftOptions {
  /** SurfaceType painted onto every emitted quad; absent ⇒ the quads inherit `baseSurface` (docs/023: default snow). */
  surface?: number;
  /** Generated rails whose station order is already authoritative skip endpoint auto-reversal. */
  preserveRailOrder?: boolean;
  /** Maximum desired distance between adjacent rails. Larger gaps receive evenly interpolated rails. */
  targetPatchM?: number;
  /** 0 = straight connectors, 1 = smooth through the rail sequence, 2 = exaggerated curvature. */
  connectionCurve?: number;
}

export type RailsResult =
  | { ok: true; rails: number[][] }
  | { ok: false; error: string };

export type RailResult =
  | { ok: true; rail: number[] }
  | { ok: false; error: string };

/** Read one selected edge chain into the ordered vertex run used by the interactive Bridge Builder. */
export function railFromEdges(edges: readonly (readonly [number, number])[]): RailResult {
  if (!edges.length) return { ok: false, error: 'Select one open edge chain for the next bridge rail.' };
  const rail = orderEdgeChain(edges.map(([a, b]) => [a, b] as [number, number]));
  if (!rail) return { ok: false, error: 'A bridge rail must be one connected open edge chain — not separate runs, a closed ring, or a branch.' };
  return { ok: true, rail };
}

/**
 * RAILS FROM AN EDGE SELECTION (docs/023 S1, "edge-runs-as-rails"): read an Edit-mode edge selection — a flat set of
 * canonical `[lo,hi]` vertex-id pairs, exactly what a double-click edge-loop pick plus a shift-added second loop
 * leaves in `store.edgeSel` — into the ordered vertex RUNS `applyLoft` spans. Pure combinatorics over the edges'
 * shared vertices; no mesh is needed, so it serves any front-end (the house rule that Edit work lands in a core fn
 * of the primitive), the same way the `resolve*Selection` queries do.
 *
 * The derivation:
 *  - PARTITION the edges into connected components (two edges join when they share a vertex) — each component is one
 *    prospective rail, so two disjoint edge loops give the two cross-section rails with no further gesture.
 *  - Each component must be a SIMPLE OPEN RUN: `orderEdgeChain` (ops/index.ts, shared with Rip) walks it
 *    end-to-end from its smaller endpoint, the deterministic start the surgery ops already use. A closed loop (a
 *    ring — no ends) or a branching run (a vertex on 3+ edges) is not a rail, so the whole derivation refuses,
 *    explicitly, rather than pick an arbitrary path through it (the doc's never-a-silent-fixup rule).
 *  - CROSS-SECTION ORDER: the rails are sorted by their first (smaller-endpoint) vertex id — a stable total order,
 *    independent of pick / insertion order, and it is all that's needed, because `applyLoft` orients each rail to
 *    the previous one by a nearest-endpoint test. So the geometry, not this ordering, decides which way each rail
 *    runs and which face the chart presents; this function only settles a deterministic cross-section sequence.
 *
 * Fewer than two components is NOT a loft — a lone edge or one loop is only one rail — so it
 * refuses too. Station counts are NOT checked here: two runs of unequal length ARE two rails, and `applyLoft` is the
 * one place the shared-station-count law lives (its refusal names the mismatch). This answers "what are the rails,
 * in order"; the loft answers "can they be lofted".
 */
export function railsFromEdges(edges: readonly (readonly [number, number])[]): RailsResult {
  if (!edges.length)
    return { ok: false, error: 'Select two edge runs to loft between — double-click an edge loop, then shift-double-click a second.' };

  // Union-find over the edges' vertices: one component per rail. The selections are tiny, so a plain find with
  // one-step compression is ample; the final rail order is fixed by the sort below, not by the union roots.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = parent.get(x);
    if (r === undefined) { parent.set(x, x); return x; }
    while (r !== parent.get(r)) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const [a, b] of edges) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }

  const groups = new Map<number, [number, number][]>();
  for (const [a, b] of edges) {
    const r = find(a), g = groups.get(r);
    if (g) g.push([a, b]); else groups.set(r, [[a, b]]);
  }
  if (groups.size < 2)
    return { ok: false, error: `A loft spans two or more edge runs; this selection is one run. Add a second edge loop (shift-double-click another loop).` };

  const rails: number[][] = [];
  for (const g of groups.values()) {
    const chain = orderEdgeChain(g);
    if (!chain)
      return { ok: false, error: 'Each loft rail is a single OPEN edge run — one of the picks is a closed loop or branches. Trim it to a run with two ends.' };
    rails.push(chain);
  }
  rails.sort((p, q) => p[0] - q[0]); // cross-section order: by each run's smaller endpoint (deterministic; distinct components ⇒ distinct starts)
  return { ok: true, rails };
}

export type LoftResult =
  | { ok: true; doc: QuadMeshDoc; reversed: number[] }
  | { ok: false; error: string };

/** The four corners of the sorted-id key for a quad — a duplicate is the same corner SET regardless of winding. */
const quadKey = (c: readonly number[]): string => [...c].sort((a, b) => a - b).join(',');

export function applyLoft(doc: QuadMeshDoc, rails: readonly (readonly number[])[], opts?: LoftOptions): LoftResult {
  if (rails.length < 2) return { ok: false, error: `A loft spans at least two rails; got ${rails.length}.` };
  const S = rails[0].length;
  if (S < 2) return { ok: false, error: `A loft needs at least two stations per rail; rail 0 has ${S}.` };
  for (let n = 0; n < rails.length; n++) {
    if (rails[n].length !== S)
      return { ok: false, error: `Rails must share a station count: rail 0 has ${S}, rail ${n} has ${rails[n].length}. Adopt matching runs (or resample) before lofting.` };
  }
  const vcount = doc.vertices.length / 3;
  for (let n = 0; n < rails.length; n++) for (let s = 0; s < S; s++) {
    const id = rails[n][s];
    if (!Number.isInteger(id) || id < 0 || id >= vcount)
      return { ok: false, error: `Rail ${n} names a vertex (${id}) that isn't in the mesh — rejected.` };
  }

  const pos = (id: number): V3 => readVertex(doc.vertices, id);

  // Orient picked/adopted rails to the previous (already-oriented) one: reverse it when its ends match the previous
  // rail's reversed order more closely than its forward order. Generated rails may opt out because their station
  // order is already paired; closed/symmetric generated runs would otherwise trip the endpoint tie guard.
  const aligned: number[][] = opts?.preserveRailOrder ? rails.map(r => r.slice()) : [rails[0].slice()];
  const reversed: number[] = [];
  if (!opts?.preserveRailOrder) {
    for (let n = 1; n < rails.length; n++) {
      const prev = aligned[n - 1], cand = rails[n];
      const P0 = pos(prev[0]), P1 = pos(prev[S - 1]);
      const R0 = pos(cand[0]), R1 = pos(cand[S - 1]);
      const keep = len(sub(P0, R0)) + len(sub(P1, R1)); // stations correspond as given
      const flip = len(sub(P0, R1)) + len(sub(P1, R0)); // stations correspond reversed
      if (Math.abs(keep - flip) <= ALIGN_EPS * (keep + flip + 1))
        return { ok: false, error: `Loft can't orient rail ${n}: its ends are equidistant from rail ${n - 1}'s (a symmetric or closed run). Trim or reorder the run so its ends are distinct.` };
      if (flip < keep) { aligned.push(cand.slice().reverse()); reversed.push(n); }
      else aligned.push(cand.slice());
    }
  }

  // Subdivide only the across-rail direction. Original vertex ids remain untouched; generated rails append
  // vertices and interpolate corresponding stations, just like a long extrusion inserts depth loops.
  const vertices = doc.vertices.slice();
  const expanded: number[][] = [aligned[0]];
  const target = opts?.targetPatchM;
  const connectionCurve = Number.isFinite(opts?.connectionCurve) ? Math.max(0, Math.min(2, opts!.connectionCurve!)) : undefined;
  const catmull = (p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 => {
    const t2 = t * t, t3 = t2 * t;
    const axis = (i: number) => 0.5 * ((2 * p1[i]) + (-p0[i] + p2[i]) * t
      + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2
      + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3);
    return [axis(0), axis(1), axis(2)];
  };
  for (let n = 0; n < aligned.length - 1; n++) {
    const railA = aligned[n], railB = aligned[n + 1];
    let segments = 1;
    if (target !== undefined && Number.isFinite(target) && target > 0) {
      let maxGap = 0;
      for (let s = 0; s < S; s++) maxGap = Math.max(maxGap, len(sub(pos(railA[s]), pos(railB[s]))));
      segments = Math.min(128, Math.max(1, Math.ceil(maxGap / target)));
    }
    for (let k = 1; k < segments; k++) {
      const t = k / segments;
      const rail: number[] = [];
      for (let s = 0; s < S; s++) {
        const a = pos(railA[s]), b = pos(railB[s]);
        const linear: V3 = [
          a[0] + (b[0] - a[0]) * t,
          a[1] + (b[1] - a[1]) * t,
          a[2] + (b[2] - a[2]) * t,
        ];
        const smooth = connectionCurve === undefined ? linear : catmull(
          pos(aligned[Math.max(0, n - 1)][s]), a, b, pos(aligned[Math.min(aligned.length - 1, n + 2)][s]), t,
        );
        const p = connectionCurve === undefined ? linear : [
          linear[0] + (smooth[0] - linear[0]) * connectionCurve,
          linear[1] + (smooth[1] - linear[1]) * connectionCurve,
          linear[2] + (smooth[2] - linear[2]) * connectionCurve,
        ];
        rail.push(vertices.length / 3);
        vertices.push(p[0], p[1], p[2]);
      }
      expanded.push(rail);
    }
    expanded.push(railB);
  }

  // Emit (N-1) lanes × (S-1) stations of quads, reusing input and generated rail vertices as corners.
  const existing = new Set<string>();
  for (const q of doc.quads) existing.add(quadKey(q));
  const seen = new Set<string>();
  const newQuads: number[][] = [];
  for (let n = 0; n < expanded.length - 1; n++) {
    const railA = expanded[n], railB = expanded[n + 1];
    for (let s = 0; s < S - 1; s++) {
      const A = railA[s], B = railB[s], C = railA[s + 1], D = railB[s + 1];
      if (A === B || C === D)
        return { ok: false, error: `Rails ${n} and ${n + 1} meet at station ${A === B ? s : s + 1} — the lane between them collapses to a triangle. Loft v1 emits quads only; weld or dart the meeting point instead.` };
      if (new Set([A, B, C, D]).size !== 4)
        return { ok: false, error: `Loft would emit a degenerate quad at lane ${n}, station ${s} — a rail doubles back on itself (a corner repeats). Rejected.` };
      const key = quadKey([A, B, C, D]);
      if (existing.has(key))
        return { ok: false, error: `Loft would re-cover an existing patch at lane ${n}, station ${s} — those four corners already form a quad. Bridge an open rim, don't loft over a stitched seam.` };
      if (seen.has(key))
        return { ok: false, error: `Loft would emit the same quad twice at lane ${n}, station ${s} — the rails cross or double back. Rejected.` };
      seen.add(key);
      newQuads.push([A, B, C, D]);
    }
  }

  const quads = doc.quads.map(q => q.slice());
  const firstNew = quads.length;
  for (const q of newQuads) quads.push(q);

  const guard = checkManifold(quads);
  if (!guard.ok)
    return { ok: false, error: 'Loft would drive an edge onto 3+ quads (overlaying a stitched seam) — bridge an open rim, not a closed one.' };

  const out: QuadMeshDoc = {
    ...doc, vertices, quads,
    ...appendMeshIds(doc, (vertices.length - doc.vertices.length) / 3, newQuads.length),
  };
  // A free edge becomes an ordinary surface edge as soon as this bridge uses it. Keep its directed handles,
  // but drop the redundant free-edge record so selection/rendering sees one edge rather than two coincident ones.
  if (doc.freeEdges?.length) {
    const covered = new Set<string>();
    for (const [A, B, C, D] of newQuads) {
      covered.add(ekey(A, B)); covered.add(ekey(A, C));
      covered.add(ekey(B, D)); covered.add(ekey(C, D));
    }
    const freeEdges = doc.freeEdges.filter(([a, b]) => !covered.has(ekey(a, b)));
    if (freeEdges.length) out.freeEdges = freeEdges; else delete out.freeEdges;
  }
  if (opts?.surface !== undefined) {
    const quadPaint: Record<number, number> = { ...(doc.quadPaint ?? {}) };
    for (let i = 0; i < newQuads.length; i++) quadPaint[firstNew + i] = opts.surface;
    out.quadPaint = quadPaint;
  }
  if (connectionCurve !== undefined) {
    const mesh = buildQuadMesh(out.vertices, out.quads, out.freeEdges);
    const automatic = meshEdgeHandles(mesh);
    const edgeHandles: Record<string, V3> = { ...(out.edgeHandles ?? {}) };
    for (let n = 0; n < expanded.length - 1; n++) for (let s = 0; s < S; s++) {
      const a = expanded[n][s], b = expanded[n + 1][s];
      const A = readVertex(out.vertices, a), B = readVertex(out.vertices, b);
      const chordAB: V3 = [(B[0] - A[0]) / 3, (B[1] - A[1]) / 3, (B[2] - A[2]) / 3];
      const chordBA: V3 = [-chordAB[0], -chordAB[1], -chordAB[2]];
      const autoAB = automatic(a, b), autoBA = automatic(b, a);
      edgeHandles[directedEdgeKey(a, b)] = [
        chordAB[0] + (autoAB[0] - chordAB[0]) * connectionCurve,
        chordAB[1] + (autoAB[1] - chordAB[1]) * connectionCurve,
        chordAB[2] + (autoAB[2] - chordAB[2]) * connectionCurve,
      ];
      edgeHandles[directedEdgeKey(b, a)] = [
        chordBA[0] + (autoBA[0] - chordBA[0]) * connectionCurve,
        chordBA[1] + (autoBA[1] - chordBA[1]) * connectionCurve,
        chordBA[2] + (autoBA[2] - chordBA[2]) * connectionCurve,
      ];
    }
    out.edgeHandles = edgeHandles;
  }
  return { ok: true, doc: out, reversed };
}
