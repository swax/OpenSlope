import type { QuadMeshDoc, V3 } from '../../doc/types';
import { buildQuadMesh, meshEdgeHandles, meshAdjacency, type MeshAdjacency } from '../topology';
import { ekey, checkManifold, finishMeshRewrite, looseVertexIds } from './contract';
import { splitQuadLoop, edgePointAt, splitEdgeHandlesExact } from './cut-primitives';
import { normalizeTJunctions, remapTJunctionsForEdgeSplits } from '../t-junctions';
import { quadPerimeterEdges, readVertex, writeVertex } from '../primitives';

/**
 * Split a selected straight strip of patches with one edge run. The operation owns only the selected patches:
 * where the new run ends against an unselected patch, its endpoint is saved as an explicit T-junction on that
 * untouched host edge. A true terrain rim remains an ordinary conforming boundary split.
 */

/** Opposite perimeter edge of `quad` to `edge` (the one sharing no vertex with it), or null if `edge` isn't
 *  one of its four sides. Perimeter pairs are (A-B, D-C) and (B-D, C-A). */
function oppositeEdge(quad: number[], edge: [number, number]): [number, number] | null {
  const es: [number, number][] = [[quad[0], quad[1]], [quad[1], quad[3]], [quad[3], quad[2]], [quad[2], quad[0]]];
  const i = es.findIndex(e => ekey(e[0], e[1]) === ekey(edge[0], edge[1]));
  return i < 0 ? null : es[(i + 2) % 4];
}

/** Order a set of selected cells into a STRAIGHT strip `[C1..Cn]` + the shared edge between each consecutive
 *  pair, or null if they aren't a simple straight strip (a fork, ring, gap, or a bend where an interior cell's
 *  two shared edges aren't opposite). A lone cell is its own strip (no shared edges). */
function orderCellStrip(quads: number[][], adj: MeshAdjacency, cells: readonly number[]): { order: number[]; shared: [number, number][] } | null {
  if (cells.length === 1) return { order: [cells[0]], shared: [] };
  if (!cells.length) return null;
  const sel = new Set(cells);
  const nbrs = (c: number): { cell: number; edge: [number, number] }[] => {
    const q = quads[c], es = quadPerimeterEdges(q);
    const out: { cell: number; edge: [number, number] }[] = [];
    for (const e of es) { const o = (adj.edgeQuads.get(ekey(e[0], e[1])) ?? []).find(x => x !== c); if (o !== undefined && sel.has(o)) out.push({ cell: o, edge: e }); }
    return out;
  };
  if (cells.some(c => nbrs(c).length > 2)) return null;                 // a fork
  const ends = cells.filter(c => nbrs(c).length === 1);
  if (ends.length !== 2) return null;                                   // a ring (0 ends) or disjoint
  const order = [Math.min(ends[0], ends[1])], shared: [number, number][] = [], seen = new Set(order);
  for (;;) {
    const step = nbrs(order[order.length - 1]).find(x => !seen.has(x.cell));
    if (!step) break;
    shared.push(step.edge); order.push(step.cell); seen.add(step.cell);
  }
  if (order.length !== cells.length) return null;                       // disjoint pieces
  for (let i = 1; i < order.length - 1; i++) {                          // each interior cell must run STRAIGHT
    const opp = oppositeEdge(quads[order[i]], shared[i - 1]);
    if (!opp || ekey(opp[0], opp[1]) !== ekey(shared[i][0], shared[i][1])) return null;
  }
  return { order, shared };
}

/**
 * SPLIT — run an edge down the middle of a selected straight patch strip. Every selected patch becomes two
 * quads. The operation never rewrites a patch beyond the selection: an interior strip end is an explicit
 * hanging node on the unselected patch's unsplit edge, while a map-rim end simply splits the boundary edge.
 *
 * Pure; guard + `remapIds` like every op. Rejects a non-strip selection, a wedge in the selected strip, or a
 * one-cell-wide ring.
 */
export function applyCellEdgeInsert(doc: QuadMeshDoc, cells: readonly number[], t = 0.5):
  { ok: true; doc: QuadMeshDoc } | { ok: false; error: string } {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges);
  const adj = meshAdjacency(mesh);
  const eh = meshEdgeHandles(mesh, doc.edgeHandles);
  const pos = (id: number): V3 => readVertex(doc.vertices, id);
  const proper = (q: number | undefined): q is number => q !== undefined && new Set(doc.quads[q]).size === 4;

  const strip = orderCellStrip(doc.quads, adj, cells);
  if (!strip) return { ok: false, error: 'Select a straight strip of patches (a row / face loop) to split.' };
  const { order, shared } = strip;
  const n = order.length;
  if (order.some(c => !proper(c))) return { ok: false, error: 'Splitting a wedge isn’t supported yet.' };

  // the n+1 rails the loop crosses: [outer end, the n-1 shared edges, outer end]. A lone cell has no shared
  // edge, so default its direction to the A-B / D-C pair.
  const rails: [number, number][] = new Array(n + 1);
  if (n === 1) { const q = doc.quads[order[0]]; rails[0] = [q[0], q[1]]; rails[1] = [q[3], q[2]]; }
  else {
    const o1 = oppositeEdge(doc.quads[order[0]], shared[0]), on = oppositeEdge(doc.quads[order[n - 1]], shared[n - 2]);
    if (!o1 || !on) return { ok: false, error: 'Split couldn’t find the strip ends — rejected.' };
    rails[0] = o1; rails[n] = on;
    for (let i = 1; i < n; i++) rails[i] = shared[i - 1];
  }

  // The cell beyond each strip end remains byte-for-byte untouched. Its presence means the new endpoint is a
  // hanging node on that cell's original edge; absence means this end is on the terrain rim.
  const capL = (adj.edgeQuads.get(ekey(rails[0][0], rails[0][1])) ?? []).find(x => x !== order[0]);
  const capR = (adj.edgeQuads.get(ekey(rails[n][0], rails[n][1])) ?? []).find(x => x !== order[n - 1]);
  if (capL !== undefined && capL === capR) return { ok: false, error: 'The strip loops on itself — nothing to bound against.' };
  const unresolvedEnds = new Set<number>([
    ...(capL !== undefined ? [0] : []),
    ...(capR !== undefined ? [n] : []),
  ]);

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

  // A cut vertex on each rail at `t` (the loop's crossing). If an earlier neighboring Split already left an
  // explicit T-node at this exact host-edge parameter, reuse its vertex id: splitting the other side then closes
  // the seam conformingly instead of creating a second coincident id.
  const m: number[] = new Array(n + 1);
  const savedTJunctions = normalizeTJunctions(doc), reusedTJunctionVertices = new Set<number>();
  for (let j = 0; j <= n; j++) {
    const rail = rails[j];
    const matching = savedTJunctions.filter(node => !reusedTJunctionVertices.has(node.vertex)
      && ekey(node.edge[0], node.edge[1]) === ekey(rail[0], rail[1])
      && Math.abs((node.edge[0] === rail[0] ? node.t : 1 - node.t) - t) <= 1e-4);
    if (matching.length > 1)
      return { ok: false, error: 'Split found multiple T-junction points at the same place. Weld those points to each other first.' };
    const existing = matching[0];
    const p = edgePointAt(rail[0], rail[1], t, eh, pos);
    if (existing) {
      m[j] = existing.vertex;
      reusedTJunctionVertices.add(existing.vertex);
      writeVertex(vertices, m[j], p);
    } else {
      m[j] = vertices.length / 3;
      vertices.push(p[0], p[1], p[2]);
    }
    splitEdgeHandlesExact(edgeHandles, rails[j][0], rails[j][1], m[j], t, p, eh, pos, unresolvedEnds.has(j));
  }

  const inheritPaint = (src: number, dst: number) => {
    if (quadPaint && quadPaint[src] !== undefined) quadPaint[dst] = quadPaint[src];
    if (quadTex && quadTex[src] !== undefined) quadTex[dst] = quadTex[src];
    if (quadOrient && quadOrient[src] !== undefined) quadOrient[dst] = quadOrient[src];
    if (quadLocked && quadLocked[src] === true) quadLocked[dst] = true;
    if (quadLabels && quadLabels[src]?.length) quadLabels[dst] = [...quadLabels[src]];
  };
  const emit = (src: number, cs: number[][]) => {
    quads[src] = cs[0];
    for (let j = 1; j < cs.length; j++) { const id = quads.length; quads.push(cs[j]); inheritPaint(src, id); }
    if (quadTwist) delete quadTwist[src];
  };

  // split each strip cell along its two rails (the loop segment through it); interior cuts are shared → watertight
  for (let i = 0; i < n; i++) {
    const halves = splitQuadLoop(doc.quads[order[i]], new Map([[ekey(rails[i][0], rails[i][1]), m[i]], [ekey(rails[i + 1][0], rails[i + 1][1]), m[i + 1]]]));
    if (!halves) return { ok: false, error: 'Split lost a patch rail — rejected.' };
    emit(order[i], halves);
  }
  const guard = checkManifold(quads.filter(Boolean) as number[][]);
  if (!guard.ok) return { ok: false, error: guard.error! };

  // Interior rails and true rim rails were fully split, so existing T records transfer to their child edges.
  // An end shared with an unselected patch still retains its original host edge and gains a new explicit T node.
  const tJunctions = remapTJunctionsForEdgeSplits(doc.tJunctions,
    rails.flatMap((edge, index) => unresolvedEnds.has(index) ? [] : [{ edge, vertex: m[index], t }]));
  for (const index of unresolvedEnds) tJunctions.push({ vertex: m[index], edge: rails[index], t });
  const { doc: out } = finishMeshRewrite(doc, {
    vertices, quads, keepVertices: looseVertexIds(doc), freeEdges: doc.freeEdges,
    tJunctions, edgeHandles, quadPaint, quadTex, quadOrient, quadLocked, quadTwist, quadLabels,
  });
  return { ok: true, doc: out };
}
