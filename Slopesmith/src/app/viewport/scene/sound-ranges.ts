import * as THREE from 'three';
import { externalSoundShape, type ExternalSoundEmitter } from '../../../core/effects/external-sound';

/** Three low-density great circles: readable at course scale without filling the view with a sphere grid. */
function unitRangeRings(segments = 64): THREE.BufferGeometry {
  const points: number[] = [];
  const add = (axis: 0 | 1 | 2) => {
    for (let i = 0; i < segments; i++) {
      const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments;
      const p = [0, 0, 0], q = [0, 0, 0];
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      p[u] = Math.cos(a); p[v] = Math.sin(a);
      q[u] = Math.cos(b); q[v] = Math.sin(b);
      points.push(...p, ...q);
    }
  };
  add(0); add(1); add(2);
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
}

const RANGE_RINGS = unitRangeRings();
const OFFSET_LINE = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1),
]);

export function soundRangeMaterial(): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color: 0x53d9ff, transparent: true, opacity: 0.82, depthTest: false, depthWrite: false,
  });
}

/**
 * Create a non-pickable listener-region overlay in the caller's coordinate system. `unitScale` converts the
 * emitter's native centimetres to that system (1 for a raw-space holder, 0.01 for editor metres).
 */
export function soundRangeObject(emitter: ExternalSoundEmitter, origin: V3Like,
  unitScale: number, material: THREE.LineBasicMaterial): THREE.Group | null {
  const shape = externalSoundShape(emitter);
  if (!shape) return null;
  const group = new THREE.Group();
  group.renderOrder = 98;
  const center = new THREE.Vector3(
    origin[0] + emitter.offset[0] * unitScale,
    origin[1] + emitter.offset[1] * unitScale,
    origin[2] + emitter.offset[2] * unitScale,
  );
  const rings = new THREE.LineSegments(RANGE_RINGS, material);
  rings.position.copy(center);
  if (shape.kind === 'sphere') {
    const radius = shape.radius * unitScale;
    rings.scale.setScalar(radius);
  } else {
    rings.scale.set(
      shape.halfExtents[0] * unitScale,
      shape.halfExtents[1] * unitScale,
      shape.halfExtents[2] * unitScale,
    );
    // The runtime contract exposes one orientation axis. Align the ellipsoid's local Z to it; a zero vector
    // leaves the recovered half-extents axis-aligned rather than inventing an orientation.
    const axis = new THREE.Vector3(...shape.axis);
    if (axis.lengthSq() > 1e-10)
      rings.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.normalize());
  }
  rings.raycast = () => { /* display-only range; clicks pass through to scene geometry */ };
  group.add(rings);

  // Make a non-zero instance-relative offset legible: a line joins the prop origin to the actual emitter center.
  const base = new THREE.Vector3(...origin);
  if (base.distanceToSquared(center) > 1e-10) {
    const direction = center.clone().sub(base);
    const offset = new THREE.LineSegments(OFFSET_LINE, material);
    offset.position.copy(base);
    offset.scale.z = direction.length();
    offset.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction.normalize());
    offset.raycast = () => { /* display-only */ };
    group.add(offset);
  }
  return group;
}

type V3Like = readonly [number, number, number];
