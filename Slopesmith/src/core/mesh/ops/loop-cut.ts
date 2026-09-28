import type { QuadMeshDoc, V3 } from '../../doc/types';
import { closestPointOnSegment } from '../../math/segment';
import { patchPoint } from '../../math/bezier';
import {
  buildQuadMesh, meshEdgeHandles, quadControlPoints,
  type QuadMesh, type EdgeHandle, type MeshAdjacency,
} from '../topology';
import { ekey, quadEdges, checkManifold, finishMeshRewrite, looseVertexIds } from './contract';
import { quadCornerNeighbor, edgePointAt, inheritCrease, splitEdgeHandlesExact, splitQuadLoop } from './cut-primitives';
import { remapTJunctionsForEdgeSplits } from '../t-junctions';
import { readVertex } from '../primitives';

/**
 * The loop cut (docs/017 "Loop cut (the headline)"): walks the quad strip a hovered edge crosses, plans the
 * cut, renders its interactive ghost geometry, and commits the split — one inserted vertex per crossed edge
 * on the true edge curve, each crossed quad split in two. The viewport builds a ghost from the same plan it
 * later commits, and the commit is just `applyLoopCut(doc, plan, t)`. The hovered-edge pick lives here too.
 */

/** One quad the strip crosses, with the two OPPOSITE rail edges the cut runs between. Each rail is directed
 *  `[from,to]` so the inserted-vertex fraction `t` is measured the same way along the whole strip; the split
 *  itself reads the rails undirected (a cut vertex is shared by both quads on the edge). */
export interface LoopCutSplit { quad: number; rails: [[number, number], [number, number]]; }

/** A planned loop cut: the strip of quads to split, the unique edges that get an inserted vertex (each with
 *  the direction to measure `t` from), and WHY the strip ended each way — for the ghost's stop markers. */
export interface LoopCutPlan {
  splits: LoopCutSplit[];
  cutEdges: { key: string; from: number; to: number }[];
  /** Boundary edges the strip ran out to (the cut's open ends). */
  rimStops: [number, number][];
  /** Triangles (wedges) the strip runs into. A triangle has no opposite edge to leave by, so the cut ends at
   *  its far corner and splits it into two triangles — still conforming, no hanging point. */
  wedgeEnds: { quad: number; rail: [number, number] }[];
  /** Edges where the strip ends against a patch it can't run on through and can't end inside — a seam three
   *  or more patches share, the strip coming back across itself, or a triangle it already ends in. The cut ends
   *  there as an explicit T-junction on that patch's unsplit edge, the way Split ends against an unselected one. */
  tStops: [number, number][];
  /** The strip closed into a ring (a global loop, no open ends). */
  closed: boolean;
}

/**
 * Walk the quad strip a hovered edge crosses and plan the loop cut. From the start quad the two OPPOSITE
 * rails (the hovered edge and the edge across from it) each extend outward, stepping to the neighbour across
 * the rail and continuing across THAT quad's opposite edge, until the strip reaches the rim (a boundary edge),
 * closes into a ring, ends in a triangle (`wedgeEnds`), or meets a patch it can't cross (`tStops`). Poles
 * don't stop it: entering a quad by one
 * edge always leaves by the opposite one, whatever its corners' valence, so the strip is as well defined through
 * a 3/5 pole's patches as anywhere — only a vertex-to-vertex edge LOOP is ambiguous there, and a cut walks
 * faces. On a pristine promoted grid the strip runs rim to rim — a whole row / column insert. Returns the plan
 * the ghost and the commit both read; never mutates.
 */
export function planLoopCut(mesh: QuadMesh, adj: MeshAdjacency, quad: number, edge: [number, number]): LoopCutPlan {
  const quads = mesh.quads;
  const proper = (q: number) => new Set(quads[q]).size === 4;

  const splits: LoopCutSplit[] = [];
  const cutMap = new Map<string, { key: string; from: number; to: number }>(); // first-seen direction wins
  const rimStops: [number, number][] = [];
  const wedgeEnds: { quad: number; rail: [number, number] }[] = [];
  const tStops: [number, number][] = [];
  const railsOf = new Map<number, string[]>();     // each crossed quad → the keys of the two rails it was cut by
  let closed = false;

  const register = (rail: [number, number]) => {
    const key = ekey(rail[0], rail[1]);
    if (!cutMap.has(key)) cutMap.set(key, { key, from: rail[0], to: rail[1] });
  };

  const extend = (q: number, rail: [number, number]) => {
    const across = (adj.edgeQuads.get(ekey(rail[0], rail[1])) ?? []).filter(x => x !== q);
    if (!across.length) { rimStops.push(rail); return; }           // ran out to the rim — an open end of the cut
    if (across.length > 1) { tStops.push(rail); return; }          // a seam of 3+ patches: no single way on
    const nb = across[0];
    const crossed = railsOf.get(nb);
    if (crossed) {
      // back on a crossed quad: by one of its own rails the strip has closed into a ring; by its other pair of
      // edges it is crossing itself, which would need that quad cut both ways — it ends there instead
      if (crossed.includes(ekey(rail[0], rail[1]))) closed = true; else tStops.push(rail);
      return;
    }
    if (!proper(nb)) {
      // a triangle has no opposite edge to leave by: the cut ends at its far corner — once; a second end in
      // the same triangle would need it cut three ways, so that one hangs instead
      if (wedgeEnds.some(end => end.quad === nb)) tStops.push(rail); else wedgeEnds.push({ quad: nb, rail });
      return;
    }
    process(nb, rail, false);
  };
  const process = (q: number, entryRail: [number, number], isStart: boolean) => {
    if (railsOf.has(q) || !proper(q)) return;
    const c = quads[q];
    const f2 = quadCornerNeighbor(c, entryRail[0], entryRail[1]);
    const t2 = quadCornerNeighbor(c, entryRail[1], entryRail[0]);
    if (f2 < 0 || t2 < 0) return; // the hovered edge isn't an edge of this quad (guarded by the caller)
    const exitRail: [number, number] = [f2, t2];
    railsOf.set(q, [ekey(entryRail[0], entryRail[1]), ekey(exitRail[0], exitRail[1])]);
    register(entryRail); register(exitRail);
    splits.push({ quad: q, rails: [entryRail, exitRail] });
    if (isStart) extend(q, entryRail); // the start quad walks BOTH ways; a middle quad only continues forward
    extend(q, exitRail);
  };

  process(quad, edge, true);
  return { splits, cutEdges: [...cutMap.values()], rimStops, wedgeEnds, tStops, closed };
}

/** A triangle (wedge `[A,B,C,C]`, perimeter A→B→C) cut from a point on one side to the corner opposite:
 *  the side's two ends in perimeter order, and that corner. Null when `rail` isn't one of its sides. */
function wedgeSide(wedge: readonly number[], rail: readonly [number, number]): { p: number; q: number; apex: number } | null {
  const ring = [wedge[0], wedge[1], wedge[2]];
  for (let i = 0; i < 3; i++) {
    const p = ring[i], q = ring[(i + 1) % 3];
    if (ekey(p, q) === ekey(rail[0], rail[1])) return { p, q, apex: ring[(i + 2) % 3] };
  }
  return null;
}

/** The renderable geometry of a planned cut at fraction `t`, in editor/data space: the cut CURVE (flat
 *  segment-pair list for a fat line, sampled on each crossed quad's iso-parameter so it hugs the terrain),
 *  the inserted-vertex dots, and the rim / T-junction stop-marker points. The viewport draws these directly. */
export interface LoopCutGeometry { line: number[]; cutPts: number[]; rimPts: number[]; tPts: number[]; }

export function loopCutGeometry(mesh: QuadMesh, eh: EdgeHandle, plan: LoopCutPlan, t: number, seg = 6): LoopCutGeometry {
  const pos = (id: number): V3 => readVertex(mesh.vertices, id);
  const dir = new Map(plan.cutEdges.map(e => [e.key, e]));

  const cutPts: number[] = [];
  for (const e of plan.cutEdges) { const p = edgePointAt(e.from, e.to, t, eh, pos); cutPts.push(p[0], p[1], p[2]); }

  const line: number[] = [];
  for (const sp of plan.splits) {
    const [A, B, C, D] = mesh.quads[sp.quad];
    const kAB = ekey(A, B), kCD = ekey(C, D), kAC = ekey(A, C), kBD = ekey(B, D);
    const cp = quadControlPoints(mesh, eh, sp.quad);
    // the cut is the iso-parameter line at the fraction the two opposite rails carry. On {A,B}/{C,D} it runs
    // down u at constant v; on {A,C}/{B,D} across v at constant u. Fraction measured from the (0,0) corner A.
    let sample: (i: number) => V3;
    if (dir.has(kAB) && dir.has(kCD)) {
      const v = dir.get(kAB)!.from === A ? t : 1 - t;
      sample = (i) => patchPoint(cp, i / seg, v);
    } else if (dir.has(kAC) && dir.has(kBD)) {
      const u = dir.get(kAC)!.from === A ? t : 1 - t;
      sample = (i) => patchPoint(cp, u, i / seg);
    } else continue;
    let prev = sample(0);
    for (let i = 1; i <= seg; i++) { const cur = sample(i); line.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]); prev = cur; }
  }
  // Into each end triangle: from the cut point on its side to the far corner, a straight run in the wedge's
  // (u, v) — corners A (0,0), B (0,1), and the apex C, which the wedge folds across the whole u = 1 row.
  for (const end of plan.wedgeEnds) {
    const w = mesh.quads[end.quad], side = wedgeSide(w, end.rail), cut = dir.get(ekey(end.rail[0], end.rail[1]));
    if (!side || !cut) continue;
    const cp = quadControlPoints(mesh, eh, end.quad);
    const [A, B] = w;
    const at = (id: number, other: number): [number, number] => id === A ? [0, 0] : id === B ? [0, 1] : [1, other === B ? 1 : 0];
    const p0 = at(side.p, side.q), p1 = at(side.q, side.p);
    const f = cut.from === side.p ? t : 1 - t;
    const m: [number, number] = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
    const apex: [number, number] = side.apex === A ? [0, 0] : side.apex === B ? [0, 1] : [1, m[1]];
    let prev = patchPoint(cp, m[0], m[1]);
    for (let i = 1; i <= seg; i++) {
      const s = i / seg, cur = patchPoint(cp, m[0] + (apex[0] - m[0]) * s, m[1] + (apex[1] - m[1]) * s);
      line.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]); prev = cur;
    }
  }

  const marker = (rails: [number, number][]): number[] => {
    const out: number[] = [];
    for (const r of rails) { const p = edgePointAt(r[0], r[1], t, eh, pos); out.push(p[0], p[1], p[2]); }
    return out;
  };
  return { line, cutPts, rimPts: marker(plan.rimStops), tPts: marker(plan.tStops) };
}

/** Nearest perimeter edge of a quad to a data-space point (distance to the edge segment) — the viewport's
 *  hovered-edge pick: it raycasts the terrain to a quad + hit point, then this names which edge the loop
 *  crosses. Returns the two corner ids in the quad's own perimeter order. */
export function hoveredEdge(mesh: QuadMesh, quad: number, point: V3): [number, number] {
  const pos = (id: number): V3 => readVertex(mesh.vertices, id);
  const distToSeg = (p: V3, a: V3, b: V3): number => Math.sqrt(closestPointOnSegment(p, a, b).distance2);
  const edges = quadEdges(mesh.quads[quad]);
  let best = edges[0], bestD = Infinity;
  for (const e of edges) { const d = distToSeg(point, pos(e[0]), pos(e[1])); if (d < bestD) { bestD = d; best = e; } }
  return best;
}

/**
 * Commit a planned loop cut into a NEW doc (pure — the input is untouched). Inserts one vertex on every cut
 * edge at fraction `t` on the derived Bezier edge curve, splits each crossed quad into two (the second half
 * inherits the parent's paint / tile / orientation), inherits any split-edge crease onto the surviving
 * endpoints (the new midpoint is born smooth), then runs the manifold guard + `remapIds`. A triangle the strip
 * ends in splits from the cut point to its far corner. Where the strip ended against a patch it couldn't
 * cross (`tStops`) the inserted vertex is a T-junction on that patch's unsplit edge: the edge keeps its exact
 * curve and the cut halves follow it, as Split's strip ends do.
 */
export function applyLoopCut(doc: QuadMeshDoc, plan: LoopCutPlan, t: number): { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  if (!plan.splits.length) return { ok: false, error: 'Loop cut found no quads to split.' };
  const tt = Math.min(0.98, Math.max(0.02, t));
  const hanging = new Set(plan.tStops.map(([a, b]) => ekey(a, b)));

  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const eh = meshEdgeHandles(mesh, doc.edgeHandles);
  const pos = (id: number): V3 => readVertex(doc.vertices, id);

  const vertices = doc.vertices.slice();
  const quads: (number[] | null)[] = doc.quads.map(q => q.slice());
  const edgeHandles: Record<string, V3> = { ...(doc.edgeHandles ?? {}) };
  const quadPaint = doc.quadPaint ? { ...doc.quadPaint } : undefined;
  const quadTex = doc.quadTex ? { ...doc.quadTex } : undefined;
  const quadOrient = doc.quadOrient ? { ...doc.quadOrient } : undefined;
  const quadLocked = doc.quadLocked ? { ...doc.quadLocked } : undefined;
  const quadTwist = doc.quadTwist ? { ...doc.quadTwist } : undefined;
  const quadLabels = doc.quadLabels ? Object.fromEntries(Object.entries(doc.quadLabels)
    .map(([quad, labels]) => [quad, [...labels]])) : undefined;

  // 1. insert a vertex on each cut edge (on the true edge curve), inheriting any crease onto the two halves —
  //    or, where the strip ends against an uncrossed patch, splitting the curve exactly and keeping the parent,
  //    so that patch's unsplit edge and the new halves are one curve (a T-junction, not a crack)
  const cutVid = new Map<string, number>();
  for (const e of plan.cutEdges) {
    const p = edgePointAt(e.from, e.to, tt, eh, pos);
    const vid = vertices.length / 3;
    vertices.push(p[0], p[1], p[2]);
    cutVid.set(e.key, vid);
    if (hanging.has(e.key)) splitEdgeHandlesExact(edgeHandles, e.from, e.to, vid, tt, p, eh, pos, true);
    else inheritCrease(edgeHandles, e.from, e.to, vid, tt);
  }

  // 2. split each crossed quad into two along ITS two rails (a quad the strip later ran into sideways also
  //    holds a hanging cut on another edge), keeping the original id for the first half so its paint stays
  //    put; the appended second half copies the paint / tile / orientation.
  for (const sp of plan.splits) {
    const halves = splitQuadLoop(doc.quads[sp.quad], new Map(sp.rails.map(([a, b]) => [ekey(a, b), cutVid.get(ekey(a, b))!])));
    if (!halves) return { ok: false, error: 'Loop cut split lost a rail edge — rejected.' };
    const [h1, h2] = halves;
    quads[sp.quad] = h1;
    const nq = quads.length; quads.push(h2);
    if (quadPaint && quadPaint[sp.quad] !== undefined) quadPaint[nq] = quadPaint[sp.quad];
    if (quadTex && quadTex[sp.quad] !== undefined) quadTex[nq] = quadTex[sp.quad];
    if (quadOrient && quadOrient[sp.quad] !== undefined) quadOrient[nq] = quadOrient[sp.quad];
    if (quadLocked && quadLocked[sp.quad] === true) quadLocked[nq] = true;
    if (quadLabels && quadLabels[sp.quad]?.length) quadLabels[nq] = [...quadLabels[sp.quad]];
    // interior twist: the parent's per-corner offsets don't map cleanly onto the split's NEW corners (a
    // midpoint replaces two of them), so a cut through a sculpted quad resets it to zero-twist rather than
    // misplace the relief — the surface-preserving split is the 018 density-refine job. Unsplit quads keep
    // their twist (carried through remapIds under the id shift).
    if (quadTwist) delete quadTwist[sp.quad];
  }

  // 3. each end triangle splits from the cut point to its far corner into two triangles, in its own winding,
  //    so the cut ends conformingly. The halves inherit its paint the way a split quad's do.
  for (const end of plan.wedgeEnds) {
    const w = doc.quads[end.quad], side = wedgeSide(w, end.rail), m = cutVid.get(ekey(end.rail[0], end.rail[1]));
    if (!side || m === undefined) return { ok: false, error: 'Loop cut lost the triangle it ends in — rejected.' };
    quads[end.quad] = [side.p, m, side.apex, side.apex];
    const nq = quads.length; quads.push([m, side.q, side.apex, side.apex]);
    if (quadPaint && quadPaint[end.quad] !== undefined) quadPaint[nq] = quadPaint[end.quad];
    if (quadTex && quadTex[end.quad] !== undefined) quadTex[nq] = quadTex[end.quad];
    if (quadOrient && quadOrient[end.quad] !== undefined) quadOrient[nq] = quadOrient[end.quad];
    if (quadLocked && quadLocked[end.quad] === true) quadLocked[nq] = true;
    if (quadLabels && quadLabels[end.quad]?.length) quadLabels[nq] = [...quadLabels[end.quad]];
    if (quadTwist) delete quadTwist[end.quad];
  }

  const guard = checkManifold(quads.filter(Boolean) as number[][]);
  if (!guard.ok) return { ok: false, error: guard.error! };

  // Fully split edges carry their existing T records onto the halves; a hanging end keeps its host edge and
  // gains a new explicit T node.
  const tJunctions = remapTJunctionsForEdgeSplits(doc.tJunctions, plan.cutEdges.filter(edge => !hanging.has(edge.key))
    .map(edge => ({ edge: [edge.from, edge.to], vertex: cutVid.get(edge.key)!, t: tt })));
  for (const edge of plan.cutEdges) {
    if (hanging.has(edge.key)) tJunctions.push({ vertex: cutVid.get(edge.key)!, edge: [edge.from, edge.to], t: tt });
  }
  const { doc: out } = finishMeshRewrite(doc, {
    vertices, quads, keepVertices: looseVertexIds(doc), freeEdges: doc.freeEdges,
    tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels,
  });
  return { ok: true, doc: out };
}
