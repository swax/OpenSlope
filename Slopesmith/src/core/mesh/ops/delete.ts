import type { QuadMeshDoc } from '../../doc/types';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles } from '../topology';
import { ekey, finishMeshRewrite, looseVertexIds } from './contract';

/**
 * Face deletion: resolves the patches a Delete gesture owns and removes them, pruning every now-unused vertex
 * through the shared compactor. Deleting an interior edge removes both incident patches and leaves an
 * intentional open boundary — dissolve is the edge-preserving alternative. A patch removed only because one of
 * its edges or corners was picked leaves its other edges behind as free edges (keptPatchEdges): deleting the far
 * edge of a strip grown off a free edge takes the strip and hands the free edge back for another extrude.
 */

/** The three mutually-exclusive Edit selection families, expressed together so the delete core stays UI-free.
 *  A caller may provide more than one family; their target patches are unioned. */
export interface MeshDeleteSelection {
  vertices?: readonly number[];
  edges?: readonly (readonly [number, number])[];
  quads?: readonly number[];
}

/** Resolve the patches a simple Delete gesture owns:
 *  - selected cells name themselves;
 *  - a selected boundary edge names every incident patch (one on a rim, two in the interior);
 *  - a selected vertex names every patch that uses it (standard vertex-delete semantics).
 *
 *  Pure and cheap, so menus can use it for their enabled state as well as the eventual commit. A selected loose
 *  vertex targets no patch, but `applyMeshDelete` still removes it during compaction. */
export function meshDeleteTargets(doc: QuadMeshDoc, selection: MeshDeleteSelection): number[] {
  const targets = new Set<number>();
  for (const q of selection.quads ?? []) {
    if (Number.isInteger(q) && q >= 0 && q < doc.quads.length) targets.add(q);
  }

  if (selection.edges?.length) {
    const adj = meshAdjacency(buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges));
    for (const [a, b] of selection.edges) {
      if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) continue;
      for (const q of adj.edgeQuads.get(ekey(a, b)) ?? []) targets.add(q);
    }
  }

  if (selection.vertices?.length) {
    const selected = new Set(selection.vertices.filter(v => Number.isInteger(v) && v >= 0 && v < doc.vertices.length / 3));
    if (selected.size) doc.quads.forEach((corners, q) => {
      if (corners.some(v => selected.has(v))) targets.add(q);
    });
  }
  return [...targets].sort((a, b) => a - b);
}

/** The edges of removed patches that outlive them as free edges: every edge of a patch deleted only because a
 *  picked edge or corner touched it — not a picked patch — unless that edge was picked itself, touches a picked
 *  corner, or still borders a surviving patch (it stays a patch edge then). An edge also on a picked patch goes
 *  with that patch. Each kept edge freezes its current handles as explicit ones, so it keeps the exact curve it
 *  had as a patch boundary instead of re-deriving a free edge's automatic shape. */
function keptPatchEdges(
  doc: QuadMeshDoc, targets: readonly number[], selection: MeshDeleteSelection,
  selectedEdgeKeys: ReadonlySet<string>, selectedVertices: ReadonlySet<number>,
): { edges: [number, number][]; handles: Record<string, [number, number, number]> } {
  const picked = new Set(selection.quads ?? []), removed = new Set(targets);
  const incidental = targets.filter(q => !picked.has(q));
  if (!incidental.length) return { edges: [], handles: {} };
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh);
  const handle = meshEdgeHandles(mesh, doc.edgeHandles, adj);
  const edges = new Map<string, [number, number]>();
  for (const q of incidental) {
    const [A, B, C, D] = doc.quads[q];
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      const key = ekey(a, b), owners = adj.edgeQuads.get(key) ?? [];
      if (a === b || selectedEdgeKeys.has(key) || selectedVertices.has(a) || selectedVertices.has(b)) continue;
      if (owners.some(owner => picked.has(owner) || !removed.has(owner))) continue;
      if ((doc.freeEdges ?? []).some(([x, y]) => ekey(x, y) === key)) continue;
      edges.set(key, a < b ? [a, b] : [b, a]);
    }
  }
  const handles: Record<string, [number, number, number]> = {};
  for (const [a, b] of edges.values()) {
    handles[`${a}>${b}`] = [...handle(a, b)] as [number, number, number];
    handles[`${b}>${a}`] = [...handle(b, a)] as [number, number, number];
  }
  return { edges: [...edges.values()], handles };
}

/** Delete the patches resolved by `meshDeleteTargets`, prune every now-unused vertex, and remap all sparse shape /
 *  paint maps through the shared compactor. This is face deletion rather than edge dissolve:
 *  deleting an interior edge removes both incident patches and leaves an intentional open boundary. A selected
 *  vertex removes its whole incident patch fan; a selected loose vertex is pruned even when that fan is empty.
 *  The removed patches' unpicked edges survive as free edges (keptPatchEdges) unless a patch was picked itself. */
export function applyMeshDelete(doc: QuadMeshDoc, selection: MeshDeleteSelection):
  { ok: true; doc: QuadMeshDoc; quads: number; vertices: number } | { ok: false; error: string } {
  const targets = meshDeleteTargets(doc, selection);
  const explicitVertices = [...new Set(selection.vertices ?? [])]
    .filter(v => Number.isInteger(v) && v >= 0 && v < doc.vertices.length / 3);
  const vertexSet = new Set(explicitVertices);
  const selectedEdgeKeys = new Set((selection.edges ?? []).map(([a, b]) => ekey(a, b)));
  const freeEdges = (doc.freeEdges ?? []).filter(([a, b]) => !selectedEdgeKeys.has(ekey(a, b)) && !vertexSet.has(a) && !vertexSet.has(b));
  const removedFreeEdges = (doc.freeEdges?.length ?? 0) - freeEdges.length;
  const keptFreeKeys = new Set(freeEdges.map(([a, b]) => ekey(a, b)));
  let edgeHandles = doc.edgeHandles ? { ...doc.edgeHandles } : undefined;
  if (edgeHandles) for (const [a, b] of doc.freeEdges ?? []) if (!keptFreeKeys.has(ekey(a, b))) {
    delete edgeHandles[`${a}>${b}`]; delete edgeHandles[`${b}>${a}`];
  }
  const kept = keptPatchEdges(doc, targets, selection, selectedEdgeKeys, vertexSet);
  if (kept.edges.length) {
    freeEdges.push(...kept.edges);
    edgeHandles = { ...edgeHandles, ...kept.handles };
  }
  if (!targets.length && !explicitVertices.length && !removedFreeEdges) return { ok: false, error: 'Select a point, edge, or patch to delete it.' };
  // Guard the LAST patch, not a doc that has none: a blank mountain (or a fresh model) is legitimately
  // quad-free, and there `targets.length === 0 === doc.quads.length` would block deleting points and free edges.
  if (doc.quads.length && targets.length === doc.quads.length) return { ok: false, error: 'A mountain needs at least one patch — Delete can’t remove the final surface.' };

  const removed = new Set(targets);
  const beforeVertices = doc.vertices.length / 3;
  const { doc: out } = finishMeshRewrite(doc, {
    vertices: doc.vertices.slice(),
    quads: doc.quads.map((q, i) => removed.has(i) ? null : q.slice()),
    keepVertices: looseVertexIds(doc).filter(vertex => !vertexSet.has(vertex)),
    freeEdges,
    tJunctions: doc.tJunctions,
    edgeHandles,
    quadPaint: doc.quadPaint ? { ...doc.quadPaint } : undefined,
    quadTex: doc.quadTex ? { ...doc.quadTex } : undefined,
    quadOrient: doc.quadOrient ? { ...doc.quadOrient } : undefined,
    quadLocked: doc.quadLocked ? { ...doc.quadLocked } : undefined,
    quadTwist: doc.quadTwist ? { ...doc.quadTwist } : undefined,
    quadLabels: doc.quadLabels ? Object.fromEntries(Object.entries(doc.quadLabels)
      .map(([quad, labels]) => [quad, [...labels]])) : undefined,
  });
  return { ok: true, doc: out, quads: targets.length, vertices: beforeVertices - out.vertices.length / 3 };
}
