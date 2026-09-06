import type * as THREE from 'three';
import { patchNormal, patchPoint } from '../../core/math/bezier';
import { quadControlPoints } from '../../core/mesh/topology';
import type { ReferenceMesh } from '../../core/reference/terrain';
import type { V3 } from '../../core/doc/types';
import { PREVIEW_RES, type PreviewData } from '../../core/mesh/tessellation';
import type { PatchContact } from './physics';

/**
 * The ANALYTIC contact for the two mountains a rider can be put on ([Trailmap: 320]): hand the ride the real
 * bicubic surface instead of the chords that approximate it.
 *
 * The collision mesh is each patch tessellated `res`×`res` — and a facet is a chord *under* the arc. A board
 * snapped to it sinks into the sag mid-facet and pops back at every vertex: on a 20 m cell that is a 6–16 cm dip
 * arriving 4–8 times a second, against a 0.11 m deck. The engine never rode facets; it Newton-refines onto the
 * patch, which is why nothing in the real game shudders on smooth ground.
 *
 * The fix is exact and cheap because the tessellation is ours: `faceIndex` decodes straight back to its cell and
 * sub-quad, while arbitrary barycentric weights evaluate `patchPoint` / `patchNormal` there. Physics uses the
 * triangle hit only as a seed and Newton-refines those weights until that patch point actually lies on the probe
 * ray.
 *
 * Both builders live here rather than inside the viewport's ride layer because they depend on nothing but the
 * mountain's own data — which is what lets the offline course runner (`scripts/ai-course-run.ts`) ride the same
 * surface the editor does instead of a faceted stand-in.
 */

/**
 * The bicubic under the tessellated sub-quad a face index names. Both quilts emit two faces per sub-quad in
 * `for iu { for iv }` order, cornered a=(iu,iv) b=(iu,iv+1) c=(iu+1,iv) d=(iu+1,iv+1) and wound (a,d,c) then
 * (a,b,d) — so one decode serves both.
 */
function patchAt(cp: V3[] | number[][], res: number, face: number,
  bary: THREE.Vector3, outPoint: THREE.Vector3, outNormal: THREE.Vector3): boolean {
  const sub = face >> 1;
  const iu = Math.floor(sub / res), iv = sub % res;
  const u0 = iu / res, v0 = iv / res, u1 = (iu + 1) / res, v1 = (iv + 1) / res;
  const w0 = bary.x, w1 = bary.y, w2 = bary.z;
  const u = (face & 1) === 0
    ? w0 * u0 + w1 * u1 + w2 * u1   // a, d, c
    : w0 * u0 + w1 * u0 + w2 * u1;  // a, b, d
  const v = (face & 1) === 0
    ? w0 * v0 + w1 * v1 + w2 * v0
    : w0 * v0 + w1 * v1 + w2 * v1;
  const p = patchPoint(cp as V3[], u, v), n = patchNormal(cp as V3[], u, v);
  outPoint.set(p[0], p[1], p[2]);
  outNormal.set(n[0], n[1], n[2]);
  return true;
}

/** The authored mountain's contact. Control points are rebuilt per cell on first touch and cached — a rider
 *  crosses a handful of cells a second. Null when the preview quilt has not been built yet. */
export function authoredPatchContact(pv: PreviewData | null): PatchContact | null {
  if (!pv) return null;
  const res = PREVIEW_RES, per = pv.facesPerCell, cells = pv.mesh.quadCount;
  const cpCache: (V3[] | null)[] = new Array(cells).fill(null);
  return (faceIndex, bary, outPoint, outNormal) => {
    const q = Math.floor(faceIndex / per);
    if (q < 0 || q >= cells) return false;
    let cp = cpCache[q];
    if (!cp) cp = cpCache[q] = quadControlPoints(pv.mesh, pv.edgeHandle, q, pv.twistOf(q));
    return patchAt(cp, res, faceIndex - q * per, bary, outPoint, outNormal);
  };
}

/**
 * The extracted reference terrain's contact: it carries the original game's sixteen control points for every
 * emitted patch, so the raycast facet decodes exactly as the reference tessellator emitted it and the underlying
 * bicubic is evaluated at that parameter. Keeping reference rides on the triangle chord made a crest appear
 * several centimetres too low and replaced its smooth normal with an abrupt far-side facet normal; ground
 * redirect could consequently turn the rider down the landing before the grounded-exit check had a chance to
 * detach them. Null when the level shipped no control net.
 */
export function referencePatchContact(rd: ReferenceMesh | null): PatchContact | null {
  if (!rd?.patchControls.length) return null;
  const per = rd.facesPerPatch;
  const res = Math.round(Math.sqrt(per / 2));
  if (res < 1 || res * res * 2 !== per) return null;
  const patches = rd.patchControls.length;
  return (faceIndex, bary, outPoint, outNormal) => {
    const q = Math.floor(faceIndex / per);
    if (q < 0 || q >= patches) return false;
    const cp = rd.patchControls[q];
    if (!cp || cp.length < 16) return false;
    return patchAt(cp, res, faceIndex - q * per, bary, outPoint, outNormal);
  };
}
