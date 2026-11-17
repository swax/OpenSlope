import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import type { Stage } from '../stage';
import { dataToScene, sceneToData } from '../coordinates';

export type BendHandleMode = 'section' | 'point';
export type BendHandles = {
  points: readonly V3[];
  edges: readonly (readonly [number, number])[];
  sections: readonly (readonly number[])[];
  mode: BendHandleMode;
  index: number;
  onChange(points: V3[], finished: boolean): void;
  onSelect(index: number): void;
};

/** The live source cage's points and sections, edited privately with the shared transform gizmo. */
export function createSubdivisionBendLayer(stage: Stage) {
  const overlay = new THREE.Group(),
    anchor = new THREE.Object3D();
  overlay.name = 'subdivision-bend-handles';
  stage.scene.add(overlay, anchor);
  const sphere = new THREE.SphereGeometry(1, 10, 8);
  const normal = new THREE.MeshBasicMaterial({ color: 0x41dbcc, depthTest: false, depthWrite: false });
  const selected = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
  const wire = new THREE.LineBasicMaterial({ color: 0x41dbcc, depthTest: false, depthWrite: false });
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), wire);
  line.renderOrder = 10_001;
  line.raycast = () => {};
  overlay.add(line);
  let state: BendHandles | null = null;
  let bulbs: THREE.Mesh[] = [];
  let base: { points: V3[]; ids: readonly number[]; inverse: THREE.Matrix4 } | null = null;
  const ids = () => (state!.mode === 'point' ? [state!.index] : state!.sections[state!.index]);
  const center = (indices: readonly number[]) =>
    indices.reduce((p, i) => p.add(dataToScene(state!.points[i])), new THREE.Vector3()).divideScalar(indices.length);

  function sync() {
    if (!state) return;
    for (const bulb of bulbs) {
      const camera = stage.camera;
      const size =
        camera instanceof THREE.PerspectiveCamera
          ? stage.camera.position.distanceTo(bulb.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 12
          : ((camera.top - camera.bottom) / camera.zoom) * 6;
      bulb.scale.setScalar(Math.max(0.01, size / Math.max(1, stage.renderer.domElement.clientHeight)));
    }
    overlay.updateMatrixWorld(true);
  }

  function seat() {
    if (!state || stage.gizmo.dragging) return;
    anchor.position.copy(center(ids()));
    anchor.quaternion.identity();
    anchor.scale.set(1, 1, 1);
    anchor.userData.deformSection = ids().length > 1;
    stage.attachGizmo(anchor, 'subdivisionbend', state.index);
  }

  function set(value: BendHandles | null) {
    state = value;
    for (const bulb of bulbs) bulb.removeFromParent();
    bulbs = [];
    overlay.visible = !!state;
    if (!state) {
      base = null;
      if (stage.gizmoKind === 'subdivisionbend') {
        stage.gizmo.dragging = false;
        stage.controls.enabled = true;
        stage.detachGizmo();
      }
      return;
    }
    const lines = state.edges.flatMap(([a, b]) => [
      ...dataToScene(state!.points[a]).toArray(),
      ...dataToScene(state!.points[b]).toArray(),
    ]);
    line.geometry.dispose();
    line.geometry = new THREE.BufferGeometry();
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const positions = state.mode === 'point' ? state.points.map(p => dataToScene(p)) : state.sections.map(center);
    positions.forEach((p, i) => {
      const bulb = new THREE.Mesh(sphere, i === state!.index ? selected : normal);
      bulb.position.copy(p);
      bulb.userData.control = i;
      bulb.renderOrder = 10_002;
      bulb.raycast = () => {};
      overlay.add(bulb);
      bulbs.push(bulb);
    });
    sync();
    seat();
  }

  return {
    set,
    sync,
    pickHandle() {
      if (!state) return;
      sync();
      const hits: THREE.Intersection[] = [];
      for (const bulb of bulbs) THREE.Mesh.prototype.raycast.call(bulb, stage.ray, hits);
      hits.sort((a, b) => a.distance - b.distance);
      if (hits[0]) state.onSelect(hits[0].object.userData.control as number);
    },
    dragging(on: boolean) {
      if (!state) return;
      if (on) {
        anchor.updateMatrixWorld(true);
        base = {
          points: structuredClone(state.points) as V3[],
          ids: [...ids()],
          inverse: anchor.matrixWorld.clone().invert(),
        };
      } else {
        base = null;
        state.onChange(
          state.points.map(p => [...p]),
          true,
        );
        seat();
      }
    },
    changed() {
      if (!state || !base) return;
      anchor.updateMatrixWorld(true);
      const delta = anchor.matrixWorld.clone().multiply(base.inverse);
      const points = base.points.map(p => [...p] as V3);
      for (const i of base.ids) points[i] = sceneToData(dataToScene(base.points[i]).applyMatrix4(delta));
      state.onChange(points, false);
    },
  };
}
