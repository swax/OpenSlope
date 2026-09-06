import type { QuadMeshDoc } from '../../doc/types';

export type MeshFlipResult =
  | { ok: true; doc: QuadMeshDoc; flipped: number }
  | { ok: false; error: string };

/**
 * Reverse which side of the selected patches is ridable. The engine's contact is one-sided along the patch's
 * parametric normal ([Trailmap: 320] — the spring and the pushout act along `∂P/∂u × ∂P/∂v` treated as
 * outward), so a patch wound the wrong way is a surface the rider falls through. The flip mirrors each cell's
 * v axis — corner order `[A@(0,0), B@(0,1), C@(1,0), D@(1,1)]` becomes `[B, A, D, C]` — which negates the
 * parametric cross while keeping u as the flow axis, and keeps a WEDGE's collapsed pair in its one legal slot
 * (`[A,B,C,C]` → `[B,A,C,C]`; a u/v transpose would scatter it into a degenerate).
 *
 * The surface itself does not move: the corners, the directed edge handles, and the manifold's undirected edge
 * set are all preserved, so the flip is a pure reparameterization — flipping twice is the identity. Per-quad
 * data rides along: interior twist offsets swap seats with their corners, and a cell carrying paint state has
 * its D4 tile orientation composed with the v-mirror (rot += 2, mirror toggles) so the painted tile keeps
 * rendering exactly as placed. A virgin cell gets no orientation entry — the flip is geometry, not paint.
 */
export function applyMeshFlip(doc: QuadMeshDoc, quads: readonly number[]): MeshFlipResult {
  const targets = [...new Set(quads)].filter(q => q >= 0 && q < doc.quads.length);
  if (!targets.length) return { ok: false, error: 'Select at least one patch to flip.' };

  const next = doc.quads.map(q => q.slice());
  const twistMap = doc.quadTwist ? { ...doc.quadTwist } : undefined;
  let orientMap = doc.quadOrient ? { ...doc.quadOrient } : undefined;
  for (const q of targets) {
    const [A, B, C, D] = next[q];
    next[q] = [B, A, D, C];
    const twist = twistMap?.[q];
    if (twist) twistMap[q] = [twist[1], twist[0], twist[3], twist[2]];
    // Compose the tile orientation with the v-mirror only where paint state exists to keep steady.
    if (orientMap?.[q] || doc.quadTex?.[q]) {
      const o = orientMap?.[q] ?? { rot: 0, mirror: false };
      (orientMap ??= {})[q] = { rot: (o.rot + 2) % 4, mirror: !o.mirror };
    }
  }
  const out: QuadMeshDoc = { ...doc, quads: next };
  if (twistMap) out.quadTwist = twistMap;
  if (orientMap) out.quadOrient = orientMap;
  return { ok: true, doc: out, flipped: targets.length };
}
