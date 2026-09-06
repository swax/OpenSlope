import type { QuadMeshDoc, V3 } from '../../doc/types';
import { closestPointOnSegment } from '../../math/segment';
import { patchPoint } from '../../math/bezier';
import {
  buildQuadMesh, meshEdgeHandles, quadControlPoints,
  type QuadMesh, type EdgeHandle, type MeshAdjacency,
} from '../topology';
import { ekey, quadEdges, checkManifold, finishMeshRewrite, looseVertexIds } from './contract';
import { quadCornerNeighbor, edgePointAt, inheritCrease } from './cut-primitives';
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
  /** Edges where the strip stopped because the next quad sits at a 3/5 pole (docs/017: correct behaviour). */
  poleStops: [number, number][];
  /** The strip closed into a ring (a global loop, no open ends). */
  closed: boolean;
}

/** Per-vertex pole test over a quad mesh's adjacency: an INTERIOR vertex (every incident edge shared by two
 *  quads) whose incident-quad count isn't 4 — the same rule `topologyFromQuads` flags as an extraordinary
 *  3/5 pole. A promoted grid has none, so the loop-cut walk never stops early there. */
function poleTest(adj: MeshAdjacency): (v: number) => boolean {
  const incidentQuads = (v: number): Set<number> => {
    const qs = new Set<number>();
    for (const nb of adj.neighbors[v] ?? []) for (const q of adj.edgeQuads.get(ekey(v, nb)) ?? []) qs.add(q);
    return qs;
  };
  const interior = (v: number): boolean => (adj.neighbors[v] ?? []).every(nb => (adj.edgeQuads.get(ekey(v, nb)) ?? []).length >= 2);
  return (v: number) => interior(v) && incidentQuads(v).size !== 4;
}

/**
 * Walk the quad strip a hovered edge crosses and plan the loop cut. From the start quad the two OPPOSITE
 * rails (the hovered edge and the edge across from it) each extend outward, stepping to the single neighbour
 * across the rail and continuing across THAT quad's opposite edge, until the strip reaches the rim (a
 * boundary edge), closes into a ring, or hits a pole (the same terminations as `faceLoop`). On a pristine
 * promoted grid the strip runs rim to rim — a whole row / column insert. Returns the plan the ghost and the
 * commit both read; never mutates.
 */
export function planLoopCut(mesh: QuadMesh, adj: MeshAdjacency, quad: number, edge: [number, number]): LoopCutPlan {
  const quads = mesh.quads;
  const isPole = poleTest(adj);
  const quadHasPole = (q: number) => quads[q].some(isPole);

  const splits: LoopCutSplit[] = [];
  const cutMap = new Map<string, { key: string; from: number; to: number }>(); // first-seen direction wins
  const rimStops: [number, number][] = [];
  const poleStops: [number, number][] = [];
  const visited = new Set<number>();
  let closed = false;

  const register = (rail: [number, number]) => {
    const key = ekey(rail[0], rail[1]);
    if (!cutMap.has(key)) cutMap.set(key, { key, from: rail[0], to: rail[1] });
  };
  const neighborAcross = (q: number, rail: [number, number]): number | undefined =>
    (adj.edgeQuads.get(ekey(rail[0], rail[1])) ?? []).find(x => x !== q);

  const extend = (q: number, rail: [number, number]) => {
    const nb = neighborAcross(q, rail);
    if (nb === undefined) { rimStops.push(rail); return; }        // ran out to the rim — an open end of the cut
    if (visited.has(nb)) { closed = true; return; }               // came back on itself — a ring
    if (isPole(rail[0]) || isPole(rail[1]) || quadHasPole(nb)) { poleStops.push(rail); return; } // stop at a pole
    process(nb, rail, false);
  };
  const process = (q: number, entryRail: [number, number], isStart: boolean) => {
    if (visited.has(q)) return;
    visited.add(q);
    const c = quads[q];
    const f2 = quadCornerNeighbor(c, entryRail[0], entryRail[1]);
    const t2 = quadCornerNeighbor(c, entryRail[1], entryRail[0]);
    if (f2 < 0 || t2 < 0) return; // the hovered edge isn't an edge of this quad (guarded by the caller)
    const exitRail: [number, number] = [f2, t2];
    register(entryRail); register(exitRail);
    splits.push({ quad: q, rails: [entryRail, exitRail] });
    if (isStart) extend(q, entryRail); // the start quad walks BOTH ways; a middle quad only continues forward
    extend(q, exitRail);
  };

  process(quad, edge, true);
  return { splits, cutEdges: [...cutMap.values()], rimStops, poleStops, closed };
}

/** The renderable geometry of a planned cut at fraction `t`, in editor/data space: the cut CURVE (flat
 *  segment-pair list for a fat line, sampled on each crossed quad's iso-parameter so it hugs the terrain),
 *  the inserted-vertex dots, and the rim / pole stop-marker points. The viewport draws these directly. */
export interface LoopCutGeometry { line: number[]; cutPts: number[]; rimPts: number[]; polePts: number[]; }

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

  const marker = (rails: [number, number][]): number[] => {
    const out: number[] = [];
    for (const r of rails) { const p = edgePointAt(r[0], r[1], t, eh, pos); out.push(p[0], p[1], p[2]); }
    return out;
  };
  return { line, cutPts, rimPts: marker(plan.rimStops), polePts: marker(plan.poleStops) };
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
 * endpoints (the new midpoint is born smooth), then runs the manifold guard + `remapIds`. A strip that
 * stopped at a pole is rejected until the wedge op (docs/017 S3) can terminate it cleanly.
 */
export function applyLoopCut(doc: QuadMeshDoc, plan: LoopCutPlan, t: number): { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  if (!plan.splits.length) return { ok: false, error: 'Loop cut found no quads to split.' };
  if (plan.poleStops.length) return { ok: false, error: 'Loop cut stops at a pole — pole termination needs a wedge (docs/017 S3). Try a rim-to-rim or ring cut.' };
  const tt = Math.min(0.98, Math.max(0.02, t));

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

  // 1. insert a vertex on each cut edge (on the true edge curve), inheriting any crease onto the two halves
  const cutVid = new Map<string, number>();
  for (const e of plan.cutEdges) {
    const p = edgePointAt(e.from, e.to, tt, eh, pos);
    const vid = vertices.length / 3;
    vertices.push(p[0], p[1], p[2]);
    cutVid.set(e.key, vid);
    inheritCrease(edgeHandles, e.from, e.to, vid, tt);
  }

  // 2. split each crossed quad into two along the cut, keeping the original id for the first half so its
  //    paint stays put; the appended second half copies the paint / tile / orientation.
  for (const sp of plan.splits) {
    const [A, B, C, D] = doc.quads[sp.quad];
    const cAB = cutVid.get(ekey(A, B)), cCD = cutVid.get(ekey(C, D));
    const cAC = cutVid.get(ekey(A, C)), cBD = cutVid.get(ekey(B, D));
    let h1: number[], h2: number[];
    if (cAB !== undefined && cCD !== undefined) { h1 = [A, cAB, C, cCD]; h2 = [cAB, B, cCD, D]; }
    else if (cAC !== undefined && cBD !== undefined) { h1 = [A, B, cAC, cBD]; h2 = [cAC, cBD, C, D]; }
    else return { ok: false, error: 'Loop cut split lost a rail edge — rejected.' };
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

  const guard = checkManifold(quads.filter(Boolean) as number[][]);
  if (!guard.ok) return { ok: false, error: guard.error! };

  const tJunctions = remapTJunctionsForEdgeSplits(doc.tJunctions, plan.cutEdges.map(edge => ({
    edge: [edge.from, edge.to], vertex: cutVid.get(edge.key)!, t: tt,
  })));
  const { doc: out } = finishMeshRewrite(doc, {
    vertices, quads, keepVertices: looseVertexIds(doc), freeEdges: doc.freeEdges,
    tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels,
  });
  return { ok: true, doc: out };
}
