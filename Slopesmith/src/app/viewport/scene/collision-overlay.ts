import * as THREE from 'three';
import type { BodyShape } from '../../../core/collision/unity-body';

/** Selected-prop collision shape colours: cyan is eligible rider contact, slate is configured but gated off. */
export const COLLISION_OVERLAY_ACTIVE_COLOR = 0x4fc3f7;
export const COLLISION_OVERLAY_INACTIVE_COLOR = 0x7f8b99;
/** The simplified collider emitted into the Unity bundle, shown alongside the native shape. */
export const UNITY_COLLISION_OVERLAY_COLOR = 0xffa23a;

export interface CollisionOverlayMeshPiece {
  geometry: THREE.BufferGeometry;
  /** Geometry-local to the overlay parent's local coordinate frame. */
  matrix: THREE.Matrix4;
}

/**
 * One lightweight, selection-local collision overlay. Callers supply exact collision geometry in the local
 * frame of `parent`; this component owns only the derived wire buffers and sphere instance buffer. Keeping the
 * renderer shared lets authored and reference selections use identical colours, cleanup, and pick behaviour.
 */
export interface CollisionOverlayOptions {
  name?: string;
  activeColor?: number;
  inactiveColor?: number;
  unity?: boolean;
}

export function createCollisionOverlay(parent: THREE.Object3D, options: CollisionOverlayOptions = {}) {
  const group = new THREE.Group();
  group.name = options.name ?? 'Selected collision shape';
  group.userData.collisionOverlay = true;
  if (options.unity) group.userData.unityCollisionOverlay = true;
  parent.add(group);

  const lineMaterials = {
    active: new THREE.LineBasicMaterial({
      color: options.activeColor ?? COLLISION_OVERLAY_ACTIVE_COLOR, transparent: true, opacity: 0.92,
      depthTest: false, depthWrite: false,
    }),
    inactive: new THREE.LineBasicMaterial({
      color: options.inactiveColor ?? COLLISION_OVERLAY_INACTIVE_COLOR, transparent: true, opacity: 0.68,
      depthTest: false, depthWrite: false,
    }),
  };
  const sphereMaterials = {
    active: new THREE.MeshBasicMaterial({
      color: options.activeColor ?? COLLISION_OVERLAY_ACTIVE_COLOR, transparent: true, opacity: 0.2,
      depthWrite: false, side: THREE.DoubleSide,
    }),
    inactive: new THREE.MeshBasicMaterial({
      color: options.inactiveColor ?? COLLISION_OVERLAY_INACTIVE_COLOR, transparent: true, opacity: 0.1,
      depthWrite: false, side: THREE.DoubleSide,
    }),
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitBoxEdges = new THREE.EdgesGeometry(unitBox);
  unitBox.dispose();
  const unitSphere = new THREE.SphereGeometry(1, 12, 8);
  let ownedWireGeometries: THREE.BufferGeometry[] = [];
  let sphereInstances: THREE.InstancedMesh | null = null;
  let requestedVisible = true;

  function material(active: boolean) { return active ? lineMaterials.active : lineMaterials.inactive; }

  function clear() {
    group.clear();
    for (const geometry of ownedWireGeometries) geometry.dispose();
    ownedWireGeometries = [];
    sphereInstances?.dispose();
    sphereInstances = null;
  }

  function showMeshes(pieces: readonly CollisionOverlayMeshPiece[], active: boolean) {
    clear();
    for (const piece of pieces) {
      const wire = new THREE.WireframeGeometry(piece.geometry);
      ownedWireGeometries.push(wire);
      const lines = new THREE.LineSegments(wire, material(active));
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(piece.matrix);
      lines.renderOrder = 99;
      lines.raycast = () => { /* display-only overlay */ };
      group.add(lines);
    }
  }

  function showBox(box: THREE.Box3, active: boolean) {
    clear();
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const lines = new THREE.LineSegments(unitBoxEdges, material(active));
    lines.matrixAutoUpdate = false;
    lines.matrix.compose(center, new THREE.Quaternion(), size);
    lines.renderOrder = 99;
    lines.raycast = () => { /* display-only overlay */ };
    group.add(lines);
  }

  /** Packed model-local x/y/z/r leaves, transformed into the overlay parent's local coordinate frame. */
  function showSpheres(spheres: Float32Array, bodyMatrix: THREE.Matrix4, active: boolean) {
    clear();
    const count = Math.floor(spheres.length / 4);
    if (!count) return;
    const mesh = new THREE.InstancedMesh(unitSphere, active ? sphereMaterials.active : sphereMaterials.inactive, count);
    const local = new THREE.Matrix4(), matrix = new THREE.Matrix4();
    const position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const offset = i * 4, radius = Math.max(0, spheres[offset + 3]);
      local.compose(position.fromArray(spheres, offset), rotation, scale.set(radius, radius, radius));
      mesh.setMatrixAt(i, matrix.multiplyMatrices(bodyMatrix, local));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 98;
    mesh.raycast = () => { /* display-only overlay */ };
    sphereInstances = mesh;
    group.add(mesh);
  }

  function capsuleWireGeometry(shape: BodyShape) {
    const positions: number[] = [];
    const segments = 16;
    const pushSegment = (a: THREE.Vector3, b: THREE.Vector3) => positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
    const circle = (center: THREE.Vector3, u: THREE.Vector3, v: THREE.Vector3, radius: number) => {
      for (let i = 0; i < segments; i++) {
        const a = i * Math.PI * 2 / segments, b = (i + 1) * Math.PI * 2 / segments;
        pushSegment(center.clone().addScaledVector(u, Math.cos(a) * radius).addScaledVector(v, Math.sin(a) * radius),
          center.clone().addScaledVector(u, Math.cos(b) * radius).addScaledVector(v, Math.sin(b) * radius));
      }
    };
    const arc = (center: THREE.Vector3, radial: THREE.Vector3, outward: THREE.Vector3, radius: number,
      reverse = false) => {
      for (let i = 0; i < segments / 2; i++) {
        const a = i * Math.PI / (segments / 2), b = (i + 1) * Math.PI / (segments / 2);
        const point = (angle: number) => center.clone()
          .addScaledVector(radial, Math.cos(angle) * radius * (reverse ? -1 : 1))
          .addScaledVector(outward, Math.sin(angle) * radius);
        pushSegment(point(a), point(b));
      }
    };
    for (const capsule of shape.capsules) {
      const a = new THREE.Vector3(...capsule.a), b = new THREE.Vector3(...capsule.b);
      const axis = b.clone().sub(a);
      const radius = Math.max(0, capsule.radius);
      if (!radius) continue;
      if (axis.lengthSq() < 1e-6) {
        const x = new THREE.Vector3(1, 0, 0), y = new THREE.Vector3(0, 1, 0), z = new THREE.Vector3(0, 0, 1);
        circle(a, x, y, radius); circle(a, x, z, radius); circle(a, y, z, radius);
        continue;
      }
      axis.normalize();
      const reference = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const u = new THREE.Vector3().crossVectors(axis, reference).normalize();
      const v = new THREE.Vector3().crossVectors(axis, u).normalize();
      circle(a, u, v, radius); circle(b, u, v, radius);
      for (const radial of [u, u.clone().negate(), v, v.clone().negate()])
        pushSegment(a.clone().addScaledVector(radial, radius), b.clone().addScaledVector(radial, radius));
      arc(a, u, axis.clone().negate(), radius); arc(a, v, axis.clone().negate(), radius);
      arc(b, u, axis, radius, true); arc(b, v, axis, radius, true);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }

  /** Unity-export boxes/capsules, already instance-scaled, transformed from body space into the overlay parent. */
  function showPrimitives(shape: BodyShape, bodyMatrix: THREE.Matrix4, active = true) {
    clear();
    for (const box of shape.boxes) {
      const local = new THREE.Matrix4().compose(new THREE.Vector3(...box.center), new THREE.Quaternion(),
        new THREE.Vector3(...box.size));
      const lines = new THREE.LineSegments(unitBoxEdges, material(active));
      lines.matrixAutoUpdate = false;
      lines.matrix.multiplyMatrices(bodyMatrix, local);
      lines.renderOrder = 100;
      lines.raycast = () => { /* display-only overlay */ };
      group.add(lines);
    }
    if (shape.capsules.length) {
      const geometry = capsuleWireGeometry(shape);
      ownedWireGeometries.push(geometry);
      const lines = new THREE.LineSegments(geometry, material(active));
      lines.matrixAutoUpdate = false;
      lines.matrix.copy(bodyMatrix);
      lines.renderOrder = 100;
      lines.raycast = () => { /* display-only overlay */ };
      group.add(lines);
    }
  }

  function setVisible(on: boolean) {
    requestedVisible = on;
    group.visible = on;
  }

  return {
    group, clear, showMeshes, showBox, showSpheres, showPrimitives, setVisible,
    get visible() { return requestedVisible; },
  };
}

export type CollisionOverlay = ReturnType<typeof createCollisionOverlay>;
