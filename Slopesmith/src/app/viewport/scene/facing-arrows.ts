import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';

/**
 * Face-normal arrows for a selected prop — the orientation instrument for authored models AND the parity
 * reference for retail ones (select a shipped fence beside your model and match the arrows). They ride the
 * tile-orientation **F** toggle: that button is already the "which way does it face" setting.
 *
 * Arrows point along each face's data-space front — the normal the game bakes its per-vertex prop lighting
 * from ([Trailmap: 400]; lighting is baked once and shown from both sides, so an arrow aimed into the
 * ground reads "this face ships dark from every view"). Segments are emitted in the model's own raw space
 * and added under the instance/placement transform, so mirrors compose and what you see is the data.
 *
 * **The STORED normal wins over the winding wherever a model ships one**, which is the whole point on the
 * parity read: a retail model carries explicit per-vertex normals (`PropSub.normals`, the extractor's `nor`)
 * and the GS lights from those, not from `∂u×∂v`. The two are not interchangeable in shipped art — 87 of
 * MEGAPLE's 172 `Fnc_TokyoFence*` models store a normal OPPOSED to their winding, alternating panel by panel
 * the way mirrored duplicate art does — so deriving the arrow from the winding would point half a fence line
 * backwards against the normal its own lighting uses, and an authored model matched to that arrow would
 * inherit the error. Authored and imported models ship no normals, so `computeVertexNormals` has already put
 * the winding into the same attribute and this reads identically for them.
 */

/** Green = the orientation reading, matching the F-overlay's patch-orientation green. */
export function facingArrowMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({ color: 0x41d06a, transparent: true, opacity: 0.9, depthTest: false });
}

/** Line-segment positions (model-local space): shaft + V head per sampled face, the face count capped so a
 *  leafy tree stays legible, arrow size from the model's local bbox. */
export function facingArrowSegments(geoms: readonly THREE.BufferGeometry[],
  box: { min: V3; max: V3 } | null): number[] {
  let total = 0;
  for (const g of geoms) total += (g.getIndex()?.count ?? 0) / 3;
  if (!total) return [];
  const MAX_ARROWS = 160;
  const stride = Math.max(1, Math.ceil(total / MAX_ARROWS));
  const diag = box ? Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) : 200;
  const len = Math.min(400, Math.max(20, diag * 0.1));   // raw cm
  const head = len * 0.3;
  const out: number[] = [];
  let f = 0;
  for (const g of geoms) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const nor = g.getAttribute('normal');
    if (!pos || !idx) continue;
    for (let k = 0; k + 2 < idx.count; k += 3, f++) {
      if (f % stride) continue;
      const [a, b, c] = [idx.getX(k), idx.getX(k + 1), idx.getX(k + 2)];
      const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
      const ux = pos.getX(b) - ax, uy = pos.getY(b) - ay, uz = pos.getZ(b) - az;
      const wx = pos.getX(c) - ax, wy = pos.getY(c) - ay, wz = pos.getZ(c) - az;
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      if (nor) {                                          // the shipped normal, averaged over the face
        const sx = nor.getX(a) + nor.getX(b) + nor.getX(c);
        const sy = nor.getY(a) + nor.getY(b) + nor.getY(c);
        const sz = nor.getZ(a) + nor.getZ(b) + nor.getZ(c);
        // A face whose three stored normals cancel (a hard seam averaged to nothing) keeps the winding,
        // which is the only reading left rather than a wrong one.
        if (Math.hypot(sx, sy, sz) > 1e-6) { nx = sx; ny = sy; nz = sz; }
      }
      const nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-9) continue;                            // degenerate face
      nx /= nl; ny /= nl; nz /= nl;
      const cx = ax + (ux + wx) / 3, cy = ay + (uy + wy) / 3, cz = az + (uz + wz) / 3;
      const tx = cx + nx * len, ty = cy + ny * len, tz = cz + nz * len;
      out.push(cx, cy, cz, tx, ty, tz);                   // shaft
      // V head in the plane of the normal and an arbitrary perpendicular
      let px = -ny, py = nx, pz = 0;
      const pl = Math.hypot(px, py, pz);
      if (pl < 1e-6) { px = 1; py = 0; pz = 0; } else { px /= pl; py /= pl; }
      out.push(tx, ty, tz, tx - nx * head + px * head * 0.5, ty - ny * head + py * head * 0.5, tz - nz * head + pz * head * 0.5);
      out.push(tx, ty, tz, tx - nx * head - px * head * 0.5, ty - ny * head - py * head * 0.5, tz - nz * head - pz * head * 0.5);
    }
  }
  return out;
}
