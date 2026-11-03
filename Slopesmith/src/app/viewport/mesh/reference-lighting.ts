import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import { pickTree, type TreeGeometry } from './surface-trees';

/** Sample direct RGB or baked vertex shade from the first rendered surface below a body, in reference space.
 * The existing pick BVH keeps caves separate from their roofs and avoids a full triangle walk.
 * Legacy residual pages keep their existing actor probes. Without those probes,
 * their separable alpha intensity supplies a neutral fallback; RGB is base-entangled. */
export function referenceGroundLightSampler(
  geometry: TreeGeometry,
  data: ReferenceMesh,
): (position: V3, residualFallback?: boolean) => V3 | null {
  const vertex = data.lightingSource === 'vertex';
  const separable = vertex || data.patchLightmapMultiply?.some(Boolean);
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    weights = new THREE.Vector3();
  return (position, residualFallback = false) => {
    if (!separable && !residualFallback) return null;
    const colors = data.lightColor;
    const intensity = data.intensity;
    if (
      colors?.length !== data.positions.length &&
      (!residualFallback || intensity?.length !== data.positions.length / 3)
    )
      return null;
    ray.origin.set(position[0], position[1] + 0.25, position[2]);
    const hit = pickTree(geometry)?.raycastFirst(ray, THREE.DoubleSide);
    if (!hit?.face || hit.faceIndex == null) return null;
    const residual = !vertex && !data.patchLightmapMultiply?.[Math.floor(hit.faceIndex / data.facesPerPatch)];
    if (residual && !residualFallback) return null;
    const indices = [hit.face.a, hit.face.b, hit.face.c];
    a.fromArray(data.positions, indices[0] * 3);
    b.fromArray(data.positions, indices[1] * 3);
    c.fromArray(data.positions, indices[2] * 3);
    if (!THREE.Triangle.getBarycoord(hit.point, a, b, c, weights)) return null;
    if (residual) {
      if (intensity?.length !== data.positions.length / 3) return null;
      const shade = Math.max(
        0,
        Math.min(
          1,
          intensity[indices[0]] * weights.x + intensity[indices[1]] * weights.y + intensity[indices[2]] * weights.z,
        ),
      );
      return [shade, shade, shade];
    }
    if (colors?.length !== data.positions.length) return null;
    return [0, 1, 2].map(channel =>
      Math.max(
        0,
        Math.min(
          vertex ? 255 / 128 : 1,
          colors[indices[0] * 3 + channel] * weights.x +
            colors[indices[1] * 3 + channel] * weights.y +
            colors[indices[2] * 3 + channel] * weights.z,
        ),
      ),
    ) as V3;
  };
}
