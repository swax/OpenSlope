import * as THREE from 'three';
import type { V3 } from '../../core/doc/types';
import type { ReferenceMesh } from '../../core/reference/terrain';
import { pickTree } from '../viewport/mesh/surface-trees';
import { referencePatchContact } from './patch-contact';

/** Float32 display vertices can round an exact GBA section boundary away from its
 * double-precision start. Seat that boundary at most half a metre inside its own analytic patch. */
export function gbaReferenceSpawn(data: ReferenceMesh, geometry: THREE.BufferGeometry, start: V3): V3 {
  const point = new THREE.Vector3(...start);
  const contact = referencePatchContact(data);
  if (!geometry.index || !contact) return start;
  const tree = pickTree(geometry);
  if (!tree) return start;
  let bestDistance = 0.001 * 0.001;
  let result = start;
  const nearest = new THREE.Vector3(),
    bary = new THREE.Vector3();
  const centre = new THREE.Vector3(),
    seated = new THREE.Vector3(),
    normal = new THREE.Vector3();
  const target = new THREE.Vector3();
  const perPatch = data.facesPerPatch;
  const res = Math.round(Math.sqrt(perPatch / 2));
  tree.shapecast({
    intersectsBounds: box => box.distanceToPoint(point) <= 0.001,
    intersectsTriangle: (triangle, faceIndex) => {
      // Collapsed edges emit zero-area faces too; those cannot seed analytic contact.
      if (triangle.getArea() < 1e-12) return false;
      triangle.closestPointToPoint(point, nearest);
      const distanceSquared = nearest.distanceToSquared(point);
      if (distanceSquared > bestDistance || !triangle.getBarycoord(nearest, bary)) return false;
      if (Math.min(bary.x, bary.y, bary.z) > 0.001) return false;
      // Aim into the whole patch, rather than only a tiny tessellation facet. This
      // keeps the inset independent of render resolution and leaves room for drop-in.
      const localFace = faceIndex % perPatch,
        cell = localFace >> 1;
      const u = res / 2 - Math.floor(cell / res),
        v = res / 2 - (cell % res);
      if ((localFace & 1) === 0) target.set(1 - u, v, u - v);
      else target.set(1 - v, v - u, u);
      if (!contact(faceIndex, target, centre, normal)) return false;
      const distance = centre.distanceTo(nearest);
      if (distance < 1e-9) return false;
      const boundary = bary.clone();
      let fraction = Math.min(1, 0.5 / distance);
      let supported = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        bary.copy(boundary).lerp(target, fraction);
        if (!contact(faceIndex, bary, seated, normal) || normal.y <= 0.35) return false;
        if (seated.distanceTo(point) <= 0.501) {
          supported = true;
          break;
        }
        fraction *= 0.5;
      }
      if (!supported) return false;
      bestDistance = distanceSquared;
      result = [seated.x, seated.y, seated.z];
      return false;
    },
  });
  return result;
}
