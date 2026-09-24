import type { V3 } from '../doc/types';
import { patchNormal } from '../math/bezier';
import type { MeshAdjacency, QuadMesh } from './topology';
import { undirectedEdgeKey } from './primitives';

/** A seam whose two patches meet at more than this angle reads as a crease, on the authored and reference cages
 *  alike so one reads as a lesson for the other. A smooth (G1) seam measures zero, but retail levels carry a long
 *  tail of gentle few-degree seams; past this the retail creases are mostly where a near-vertical wall meets the
 *  slope, usually with a texture change (snow to rock). */
export const CREASE_DEGREES = 10;

/** A patch's 16 bicubic control points, row-major — the authored net derives them (quadControlPoints), the
 *  reference stores them (patchControls). */
export type PatchControls = (quad: number) => readonly (readonly number[])[];

// Along the seam, stopping just short of the corners: a corner is shared by more than two patches, so the
// two-sided comparison is only meaningful in between. 0.05 still sees a tangent pair bent at the corner.
const SEAM_SAMPLES = [0.05, 0.275, 0.5, 0.725, 0.95];

/** Where the curve a→b sits in `quad`'s (u, v) at parameter t from a. Rows run along u: A-B is u=0, C-D u=1. */
function seamParam(mesh: QuadMesh, quad: number, a: number, b: number, t: number): [number, number] | null {
  const [A, B, C, D] = mesh.quads[quad];
  const sides: [number, number, (s: number) => [number, number]][] = [
    [A, B, s => [0, s]], [C, D, s => [1, s]], [A, C, s => [s, 0]], [B, D, s => [s, 1]],
  ];
  for (const [x, y, at] of sides) {
    if (x === y) continue; // a wedge's collapsed side
    if (x === a && y === b) return at(t);
    if (x === b && y === a) return at(1 - t);
  }
  return null;
}

/** The widest angle, in degrees, between the two patches' surface normals along the seam a–b they share. Zero
 *  on a smooth (G1) seam. Normals compare unsigned, so a patch wound the other way does not read as a fold. */
export function seamCreaseDegrees(mesh: QuadMesh, controls: PatchControls,
  a: number, b: number, quads: readonly [number, number]): number {
  const cps = quads.map(quad => controls(quad) as V3[]);
  let worst = 0;
  for (const t of SEAM_SAMPLES) {
    const uv = quads.map(quad => seamParam(mesh, quad, a, b, t));
    if (!uv[0] || !uv[1]) return 0;
    const n0 = patchNormal(cps[0], uv[0][0], uv[0][1]), n1 = patchNormal(cps[1], uv[1][0], uv[1][1]);
    const cos = Math.min(1, Math.abs(n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
    worst = Math.max(worst, Math.acos(cos) * 180 / Math.PI);
  }
  return worst;
}

/** Every seam shared by exactly two patches that creases past CREASE_DEGREES, as undirected edge keys. */
export function creasedSeams(mesh: QuadMesh, controls: PatchControls, adj: MeshAdjacency): Set<string> {
  const creased = new Set<string>();
  for (const [key, quads] of adj.edgeQuads) {
    if (quads.length !== 2) continue;
    const [a, b] = key.split(',').map(Number);
    if (seamCreaseDegrees(mesh, controls, a, b, [quads[0], quads[1]]) > CREASE_DEGREES) creased.add(undirectedEdgeKey(a, b));
  }
  return creased;
}
