/**
 * One shard of the dependency-radius brute force in `rebuild.test.ts`.
 *
 * That proof moves every corner of a fixture in turn and rebuilds the whole mountain after each one, which is
 * ~1300 full re-tessellations and was, on its own, most of the gate's wall clock. The probes are independent —
 * each restores the corner it moved before the next begins — and what they accumulate is three running sums,
 * so the work splits across threads and adds back up to exactly the number a single thread would have reached.
 * The proof is unchanged: every corner is still moved, and every patch a rebuild actually shifts is still
 * checked against the radius that claimed it.
 *
 * This file is not a check itself (hence not `*.test.ts`, which is the gate's whole discovery rule) — it is
 * the body of one, and `rebuild.test.ts` also calls `radiusTally` directly when there is no pool to spread it
 * over. Nothing here may depend on being a worker for that reason: the `parentPort` wiring is the last thing
 * in the file and it is what a main-thread import quietly skips.
 */
import { parentPort } from 'node:worker_threads';
import { getVertex, setVertex } from '../src/core/doc/doc-edit';
import { patchDependency } from '../src/core/mesh/incremental';
import { buildMountainPreview, PATCH_VERTS, type PreviewData } from '../src/core/mesh/tessellation';
import type { QuadMeshDoc } from '../src/core/doc/types';

/** A slice of one fixture's corners to probe. The document rides the structured clone, which — unlike the
 *  JSON round trip the suite's `clone` uses — carries sets and typed arrays through untouched, so a shard
 *  reads the same document the caller holds and no migration has to be re-run on this side to rebuild it. */
export interface RadiusShard { doc: QuadMeshDoc; sample: number[] }

/** What the probes add up to. All three are sums over independent corners, so shard tallies simply total. */
export interface RadiusTally { missed: number; claimed: number; over: number }

/** Which patches a full rebuild actually moves when one corner does — the ground truth the radius is held to. */
function movedPatches(doc: QuadMeshDoc, before: PreviewData, vertex: number): Set<number> {
  const held = [...doc.vertices];
  const at = getVertex(doc, vertex);
  setVertex(doc, vertex, [at[0] + 3.7, at[1] - 1.9, at[2] + 2.3]);
  const after = buildMountainPreview(doc);
  doc.vertices = held;
  const moved = new Set<number>();
  for (let q = 0; q < after.mesh.quadCount; q++) {
    const from = q * PATCH_VERTS * 3, to = from + PATCH_VERTS * 3;
    for (let i = from; i < to; i++) {
      if (before.positions[i] !== after.positions[i] || before.normals[i] !== after.normals[i]) { moved.add(q); break; }
    }
  }
  return moved;
}

/**
 * Probe one slice of corners. The preview and the dependency map are rebuilt per shard rather than shipped,
 * because both are derived deterministically from the document and one rebuild is nothing beside the hundreds
 * this then runs against it.
 */
export function radiusTally(doc: QuadMeshDoc, sample: number[]): RadiusTally {
  const preview = buildMountainPreview(doc);
  const dependency = patchDependency(preview.mesh, preview.adjacency);
  let missed = 0, claimed = 0, over = 0;
  for (const vertex of sample) {
    const named = dependency.ofVertices([vertex]);
    const truth = movedPatches(doc, preview, vertex);
    for (const q of truth) if (!named.has(q)) missed++;
    claimed += named.size;
    over += named.size - truth.size;
  }
  return { missed, claimed, over };
}

// Only when actually loaded as a worker. A main-thread import gets the functions above and nothing else.
parentPort?.on('message', (shard: RadiusShard) => {
  parentPort!.postMessage(radiusTally(shard.doc, shard.sample));
});
