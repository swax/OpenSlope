import type { V3 } from '../../doc/types';
import { add, mul, sub } from '../../math/vec';
import { cubicPoint, splitCubic } from '../../math/bezier';
import type { EdgeHandle } from '../topology';
import { ekey } from './contract';

/**
 * The primitive split moves the cut family composes: a vertex inserted on the true cubic edge curve, crease
 * inheritance onto a split edge's halves, the opposite-rail quad split, and the perimeter-adjacency step a
 * strip walk takes. Loop cut, patch-strip Split, edge-crossing weld, and surface cut all build from these.
 */

/** Local perimeter adjacency of a quad `[A,B,C,D]` by corner index: A~{B,C}, B~{A,D}, C~{A,D}, D~{B,C}. */
const LOCAL_ADJ: number[][] = [[1, 2], [0, 3], [0, 3], [1, 2]];

/** The perimeter neighbour of corner `x` within quad `corners`, excluding `y` — so from the directed edge
 *  (x,y) it names the corresponding corner on the OPPOSITE edge (x's partner across the cut direction). */
export function quadCornerNeighbor(corners: number[], x: number, y: number): number {
  const li = corners.indexOf(x);
  if (li < 0) return -1;
  for (const n of LOCAL_ADJ[li]) if (corners[n] !== y) return corners[n];
  return -1;
}

/** Split a quad `L` along the loop cut defined by cut-vertex ids on two OPPOSITE edges — the same split
 *  `applyLoopCut` does, factored out so patch-strip Split reuses its proven winding. Returns
 *  [near-edge half, far-edge half] (each a proper quad) or null if the two cuts aren't an opposite pair. */
export function splitQuadLoop(L: number[], cut: Map<string, number>): [number[], number[]] | null {
  const [A, B, C, D] = L;
  const cAB = cut.get(ekey(A, B)), cCD = cut.get(ekey(C, D)), cAC = cut.get(ekey(A, C)), cBD = cut.get(ekey(B, D));
  if (cAB !== undefined && cCD !== undefined) return [[A, cAB, C, cCD], [cAB, B, cCD, D]];
  if (cAC !== undefined && cBD !== undefined) return [[A, B, cAC, cBD], [cAC, cBD, C, D]];
  return null;
}

/** The point where a loop cut inserts a vertex on edge (from,to): parameter `t` along the derived cubic
 *  Bezier EDGE curve (corner + directional handle, the neighbour's handle back, the neighbour), so a cut
 *  through curved terrain lands ON the surface, not on the straight chord (docs/017). */
export function edgePointAt(from: number, to: number, t: number, eh: EdgeHandle, pos: (id: number) => V3): V3 {
  const P0 = pos(from), P3 = pos(to);
  const P1 = add(P0, eh(from, to)), P2 = add(P3, eh(to, from));
  return cubicPoint(P0, P1, P2, P3, t);
}

/** Carry a split edge's crease onto its two halves: the surviving endpoints keep their pinned tangent
 *  (scaled to the shorter sub-edge), the new midpoint is left smooth (no override → Bessel). A smooth parent
 *  edge (no override) contributes nothing, so the halves are born smooth (docs/017). */
export function inheritCrease(edgeHandles: Record<string, V3>, from: number, to: number, vid: number, t: number) {
  const hFT = edgeHandles[`${from}>${to}`], hTF = edgeHandles[`${to}>${from}`];
  if (!hFT && !hTF) return;
  if (hFT) edgeHandles[`${from}>${vid}`] = mul(hFT, t);         // from's tangent along its t-fraction sub-edge
  if (hTF) edgeHandles[`${to}>${vid}`] = mul(hTF, 1 - t);        // to's tangent along its (1-t)-fraction sub-edge
  delete edgeHandles[`${from}>${to}`]; delete edgeHandles[`${to}>${from}`]; // the parent directed edge is gone
}

/** Replace one cubic edge with its exact de Casteljau children. Unlike `inheritCrease`, this pins both
 * directions at the inserted point, so an unresolved T seam and the unsplit host evaluate to the same curve
 * everywhere — not merely at the hanging vertex. `midpoint` is supplied because the new id may not exist in
 * the source document read by `pos` yet. */
export function splitEdgeHandlesExact(
  edgeHandles: Record<string, V3>, from: number, to: number, vid: number, t: number, midpoint: V3,
  eh: EdgeHandle, pos: (id: number) => V3, preserveParent = false,
) {
  const p0 = pos(from), p3 = pos(to);
  const split = splitCubic(p0, add(p0, eh(from, to)), add(p3, eh(to, from)), p3, t);
  edgeHandles[`${from}>${vid}`] = sub(split.left[1], p0);
  edgeHandles[`${vid}>${from}`] = sub(split.left[2], midpoint);
  edgeHandles[`${vid}>${to}`] = sub(split.right[1], midpoint);
  edgeHandles[`${to}>${vid}`] = sub(split.right[2], p3);
  if (preserveParent) {
    edgeHandles[`${from}>${to}`] = eh(from, to);
    edgeHandles[`${to}>${from}`] = eh(to, from);
  } else {
    delete edgeHandles[`${from}>${to}`]; delete edgeHandles[`${to}>${from}`];
  }
}
