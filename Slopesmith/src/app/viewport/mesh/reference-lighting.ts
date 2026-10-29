import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import { pickTree, type TreeGeometry } from './surface-trees';

/** Sample direct RGB or baked vertex shade from the first rendered surface below a body, in reference space.
 * The existing pick BVH keeps caves separate from their roofs and avoids a full triangle walk.
 * Legacy residual pages keep their existing instance-probe lighting without a second attenuation. */
export function referenceGroundLightSampler(
  geometry: TreeGeometry,
  data: ReferenceMesh,
): ((position: V3) => V3 | null) | null {
  const vertex = data.lightingSource === 'vertex';
  if (!vertex && !data.patchLightmapMultiply?.some(Boolean)) return null;
  const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  const a = new THREE.Vector3(),
    b = new THREE.Vector3(),
    c = new THREE.Vector3(),
    weights = new THREE.Vector3();
  return position => {
    const colors = data.lightColor;
    if (!colors || colors.length !== data.positions.length) return null;
    ray.origin.set(position[0], position[1] + 0.25, position[2]);
    const hit = pickTree(geometry)?.raycastFirst(ray, THREE.DoubleSide);
    if (
      !hit?.face ||
      hit.faceIndex == null ||
      (!vertex && !data.patchLightmapMultiply?.[Math.floor(hit.faceIndex / data.facesPerPatch)])
    )
      return null;
    const indices = [hit.face.a, hit.face.b, hit.face.c];
    a.fromArray(data.positions, indices[0] * 3);
    b.fromArray(data.positions, indices[1] * 3);
    c.fromArray(data.positions, indices[2] * 3);
    if (!THREE.Triangle.getBarycoord(hit.point, a, b, c, weights)) return null;
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
