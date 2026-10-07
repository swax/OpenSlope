import type { QuadMeshDoc, V3 } from '../doc/types';
import { patchNormal } from '../math/bezier';
import { add, dot, len, mul, norm } from '../math/vec';
import { seamCreaseDegrees, seamParam } from './creases';
import { quadIsLocked } from './locks';
import { buildQuadMesh, INTERIOR_CP, meshAdjacency, meshEdgeHandles, quadControlPoints } from './topology';
import { undirectedEdgeKey } from './primitives';

/**
 * Seam fairing at extraordinary vertices — the half of Smooth that corner handles cannot do.
 *
 * Each patch's interior control points come from its corners and their handles with zero twist. Where four
 * patches meet, that is smooth across every seam; where three or five meet, two neighbouring patches share a
 * tangent plane only AT the pole and at the seam's far end, and kink in between (a seam into a valence-5 pole
 * on an authored mountain measured 12° though both its corners read 0°). Smoothing the corner handles cannot
 * reach that: the kink lives in the interior control points.
 *
 * So for each pole, solve the twist offset of the interior control point at the pole corner of every patch in
 * its fan. That one control point bends only the patch's two seams out of the pole, so the solve is local to the
 * fan. Along each seam the two patches' cross-boundary derivatives are asked to lie in one shared tangent plane
 * — the average of their two current normals, re-taken each round — which is linear in the offsets; a light
 * penalty keeps them small, so they move the surface mostly along its normal. The result is kept only when it
 * lowers the fan's seam angles.
 */

/** Seam samples the solve fits, measured from the pole. Denser than the crease read-out's five, so the fit
 *  smooths the whole seam rather than its sample points. */
const FIT_SAMPLES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const ROUNDS = 6;
/** Penalty on offset size, relative to the mean squared constraint weight: enough to pin the directions the
 *  seams leave free, far too little to hold back a real fit. */
const SMALL = 1e-3;

const bern = (t: number) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
const bernD = (t: number) => [-3 * (1 - t) ** 2, 3 * (1 - t) ** 2 - 6 * t * (1 - t), 6 * t * (1 - t) - 3 * t * t, 3 * t * t];

/** ∂S/∂u or ∂S/∂v of a row-major bicubic patch (rows run along u) at (u, v). */
function partial(cp: readonly V3[], u: number, v: number, by: 'u' | 'v'): V3 {
  const bu = by === 'u' ? bernD(u) : bern(u), bv = by === 'v' ? bernD(v) : bern(v);
  const out: V3 = [0, 0, 0];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const w = bu[i] * bv[j], p = cp[i * 4 + j];
    out[0] += w * p[0]; out[1] += w * p[1]; out[2] += w * p[2];
  }
  return out;
}

/** Solve the symmetric positive system A x = b in place (Gaussian elimination, partial pivoting). */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]]; [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let row = col + 1; row < n; row++) {
      const f = a[row][col] / a[col][col];
      if (!f) continue;
      for (let k = col; k < n; k++) a[row][k] -= f * a[col][k];
      b[row] -= f * b[col];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let s = b[row];
    for (let k = row + 1; k < n; k++) s -= a[row][k] * x[k];
    x[row] = s / a[row][row];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** An interior vertex whose fan is not the regular four patches — the only place zero twist kinks a seam. */
function isPole(adj: ReturnType<typeof meshAdjacency>, id: number): boolean {
  const neighbors = adj.neighbors[id] ?? [];
  if (neighbors.length < 3) return false;
  const fan = new Set<number>();
  for (const nb of neighbors) {
    const quads = adj.edgeQuads.get(undirectedEdgeKey(id, nb)) ?? [];
    if (quads.length !== 2) return false;
    for (const quad of quads) fan.add(quad);
  }
  return fan.size !== 4;
}

/** Fair the seams around every pole among `ids` (other vertices are passed by), writing the solved pole-corner
 *  offsets into `quadTwist`. Locked patches and wedges keep theirs and only shape the target. Run it after the
 *  corner handles are smoothed: it fits the interiors to whatever the corners now are. Returns, per pole it
 *  changed, the fan's widest seam angle before and after. */
export function fairPoleSeams(doc: QuadMeshDoc, ids: readonly number[]): { vertex: number; before: number; after: number }[] {
  const mesh = buildQuadMesh(doc.vertices, doc.quads, doc.freeEdges), adj = meshAdjacency(mesh);
  const edgeHandle = meshEdgeHandles(mesh, doc.edgeHandles);
  const faired: { vertex: number; before: number; after: number }[] = [];
  for (const pole of new Set(ids)) {
    if (!isPole(adj, pole)) continue;
    const seams = (adj.neighbors[pole] ?? []).map(nb => ({ nb, quads: adj.edgeQuads.get(undirectedEdgeKey(pole, nb))! }));
    const fan = [...new Set(seams.flatMap(seam => seam.quads))];
    const free = fan.filter(quad => !quadIsLocked(doc, quad) && new Set(doc.quads[quad]).size === 4);
    if (!free.length) continue;
    const slotOf = (quad: number) => doc.quads[quad].indexOf(pole);
    const twistOf = (quad: number): V3[] => (doc.quadTwist?.[quad] ?? [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]])
      .map(v => [...v] as V3);
    const twist = new Map<number, V3[]>(fan.map(quad => [quad, twistOf(quad)]));
    const controls = (quad: number) => quadControlPoints(mesh, edgeHandle, quad, twist.get(quad));
    const worst = () => Math.max(...seams.map(({ nb, quads }) =>
      seamCreaseDegrees(mesh, controls, pole, nb, [quads[0], quads[1]])));
    const before = worst();
    // Smooth discards whatever was sculpted at the pole corner and fits it fresh; the other corners keep theirs.
    for (const quad of free) twist.get(quad)![slotOf(quad)] = [0, 0, 0];

    const index = new Map(free.map((quad, i) => [quad, i])), n = free.length * 3;
    for (let round = 0; round < ROUNDS; round++) {
      const ata = Array.from({ length: n }, () => new Array<number>(n).fill(0)), atb = new Array<number>(n).fill(0);
      let weight = 0, rows = 0;
      const cps = new Map(fan.map(quad => [quad, controls(quad)]));
      for (const { nb, quads } of seams) for (const t of FIT_SAMPLES) {
        const at = quads.map(quad => seamParam(mesh, quad, pole, nb, t));
        if (!at[0] || !at[1]) continue;
        const normals = quads.map((quad, i) => patchNormal(cps.get(quad)! as V3[], at[i]![0], at[i]![1]));
        const target = norm(add(normals[0], mul(normals[1], dot(normals[0], normals[1]) < 0 ? -1 : 1)));
        if (len(target) < 0.5) continue;
        quads.forEach((quad, side) => {
          const k = index.get(quad);
          if (k === undefined) return;
          const [u, v] = at[side]!;
          // The seam runs along v where u is fixed (rows A-B, C-D) and along u where v is: the cross-boundary
          // derivative is the other partial, and the pole-corner control point enters it with this weight.
          const across: 'u' | 'v' = u === 0 || u === 1 ? 'u' : 'v';
          const cp = INTERIOR_CP[slotOf(quad)], ci = Math.floor(cp / 4), cj = cp % 4;
          const c = across === 'u' ? bernD(u)[ci] * bern(v)[cj] : bern(u)[ci] * bernD(v)[cj];
          const cross = partial(cps.get(quad)!, u, v, across);
          // Row: c·(target · w_new) = c·(target · w_now) − cross · target, so the new cross derivative ⟂ target.
          const w = twist.get(quad)![slotOf(quad)];
          const rhs = c * dot(target, w) - dot(cross, target);
          const row = target.map(x => c * x);
          for (let p = 0; p < 3; p++) {
            atb[k * 3 + p] += row[p] * rhs;
            for (let q = 0; q < 3; q++) ata[k * 3 + p][k * 3 + q] += row[p] * row[q];
          }
          weight += c * c; rows++;
        });
      }
      if (!rows) break;
      const penalty = SMALL * weight / rows;
      for (let p = 0; p < n; p++) ata[p][p] += penalty;
      const x = solve(ata, atb);
      if (!x) break;
      for (const quad of free) {
        const k = index.get(quad)!;
        twist.get(quad)![slotOf(quad)] = [x[k * 3], x[k * 3 + 1], x[k * 3 + 2]];
      }
    }

    const after = worst();
    if (!(after < before - 1e-6)) continue; // never leave a fan worse than Smooth found it
    for (const quad of free) {
      const tuple = twist.get(quad)! as [V3, V3, V3, V3];
      const map = (doc.quadTwist ??= {});
      if (tuple.every(v => len(v) < 1e-9)) delete map[quad]; else map[quad] = tuple;
    }
    if (doc.quadTwist && !Object.keys(doc.quadTwist).length) doc.quadTwist = undefined;
    faired.push({ vertex: pole, before, after });
  }
  return faired;
}
