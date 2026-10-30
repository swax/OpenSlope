import * as THREE from 'three';
import type { AuthoredAiPath, CoursePath, V3 } from '../../../core/doc/types';
import { authoredAiDisplayPaths } from '../../../core/doc/ai-paths';
import type { Stage } from '../stage';
import { createReferenceAiPathsLayer } from './reference-ai-paths';
import { occludedMaterial } from '../shared/overlays';
import { fadeObject } from '../shared/fade';

/** Generated and recorded authored routes share the reference network's pixel-width lines and event overlay. */
export function createAiPathsLayer(stage: Stage) {
  const layer = createReferenceAiPathsLayer(stage, stage.worldRoot);
  const nodes = new THREE.Group();
  stage.worldRoot.add(nodes);
  const handle = new THREE.Object3D();
  stage.scene.add(handle);
  const geometry = new THREE.SphereGeometry(1, 10, 6);
  // Match the lines' transparent queue so event spans cannot paint over an editable node.
  const normal = new THREE.MeshBasicMaterial({ color: 0xffc268, transparent: true, depthWrite: false });
  const active = new THREE.MeshBasicMaterial({ color: 0xffef7a, transparent: true, depthWrite: false });
  const behind = new Map([
    [normal, occludedMaterial(normal)],
    [active, occludedMaterial(active)],
  ]);
  let paths: AuthoredAiPath[] = [];
  let recordedIds = new Set<string>();
  let selectedId: string | null = null;
  let selectedNode: number | null = null;
  let visible = false;
  let fade = 1;

  function setCourse(
    course: CoursePath | null,
    seed: number,
    recorded: readonly AuthoredAiPath[] = [],
    automatic = true,
  ) {
    paths = authoredAiDisplayPaths(course, seed, recorded, automatic);
    recordedIds = new Set(recorded.map(path => path.id));
    layer.setAiPaths(
      paths.map((path, index) => ({
        ...path,
        originalIndex: index,
        start: !recordedIds.has(path.id),
        startSlots: [],
        markers: [],
      })),
    );
    const index = paths.findIndex(path => path.id === selectedId);
    select(index < 0 ? null : index, selectedNode);
  }

  function select(index: number | null, node: number | null = null) {
    const path = index === null ? undefined : paths[index];
    selectedId = path?.id ?? null;
    selectedNode = path && recordedIds.has(path.id) && node !== null && path.points[node] ? node : null;
    layer.selectAiPath(index);
    nodes.clear();
    if (stage.gizmoKind === 'ainode' && selectedNode === null) stage.detachGizmo();
    if (!path || !recordedIds.has(path.id)) return;
    const size = new THREE.Vector2(),
      world = new THREE.Vector3();
    path.points.forEach((point, nodeIndex) => {
      const material = nodeIndex === selectedNode ? active : normal;
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(...point);
      marker.scale.setScalar(0.5);
      marker.userData.authoredAiPathIndex = index;
      marker.userData.aiPathNode = nodeIndex;
      marker.renderOrder = 8;
      marker.onBeforeRender = (renderer, _scene, camera) => {
        renderer.getSize(size);
        marker.getWorldPosition(world).applyMatrix4(camera.matrixWorldInverse);
        const depth = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? Math.abs(world.z) : 1;
        marker.scale.setScalar((10 * depth) / (camera.projectionMatrix.elements[5] * size.y));
        marker.updateMatrixWorld(true);
      };
      const ghost = new THREE.Mesh(geometry, behind.get(material)!);
      ghost.raycast = () => {};
      marker.add(ghost);
      nodes.add(marker);
    });
    nodes.visible = visible;
    fadeObject(nodes, fade);
    if (selectedNode !== null && visible) {
      if (!stage.gizmo?.dragging) {
        stage.worldRoot.updateWorldMatrix(true, false);
        handle.position.copy(new THREE.Vector3(...path.points[selectedNode]).applyMatrix4(stage.worldRoot.matrixWorld));
      }
      stage.attachGizmo(handle, 'ainode', selectedNode);
    }
  }

  function moveNode() {
    const path = paths.find(path => path.id === selectedId);
    if (!path || selectedNode === null || !recordedIds.has(path.id)) return;
    stage.worldRoot.updateWorldMatrix(true, false);
    const position = handle.position.clone().applyMatrix4(stage.worldRoot.matrixWorld.clone().invert()).toArray() as V3;
    stage.cb.onMoveAiPathNode?.(path.id, selectedNode, position);
  }

  return {
    setCourse,
    setVisible(on: boolean) {
      visible = on;
      layer.showAiPaths(on);
      nodes.visible = on;
      if (!on && stage.gizmoKind === 'ainode') stage.detachGizmo();
    },
    setFade(factor: number) {
      fade = factor;
      layer.setFade(factor);
      fadeObject(nodes, factor);
    },
    select,
    moveNode,
    pickRoots: [layer.aiPathGroup, nodes],
    nodeGroup: nodes,
    materials: layer.aiPathMaterials,
  };
}

export type AiPathsLayer = ReturnType<typeof createAiPathsLayer>;
