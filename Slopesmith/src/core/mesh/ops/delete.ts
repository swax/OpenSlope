import type { QuadMeshDoc } from '../../doc/types';
import { buildQuadMesh, meshAdjacency } from '../topology';
import { ekey, finishMeshRewrite, looseVertexIds } from './contract';

/**
 * Face deletion: resolves the patches a Delete gesture owns and removes them, pruning every now-unused vertex
 * through the shared compactor. Deleting an interior edge removes both incident patches and leaves an
 * intentional open boundary — dissolve is the edge-preserving alternative.
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

/** Delete the patches resolved by `meshDeleteTargets`, prune every now-unused vertex, and remap all sparse shape /
 *  paint maps through the shared compactor. This is face deletion rather than edge dissolve:
 *  deleting an interior edge removes both incident patches and leaves an intentional open boundary. A selected
 *  vertex removes its whole incident patch fan; a selected loose vertex is pruned even when that fan is empty. */
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
  const edgeHandles = doc.edgeHandles ? { ...doc.edgeHandles } : undefined;
  if (edgeHandles) for (const [a, b] of doc.freeEdges ?? []) if (!keptFreeKeys.has(ekey(a, b))) {
    delete edgeHandles[`${a}>${b}`]; delete edgeHandles[`${b}>${a}`];
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
