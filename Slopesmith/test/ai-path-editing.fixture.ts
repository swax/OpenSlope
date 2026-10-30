import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { Stage } from '../src/app/viewport/stage';
import { createAiPathsLayer } from '../src/app/viewport/scene/ai-paths';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import { createScenePanel } from '../src/app/ui/chrome/scene-panel';
import { createViewportCallbacks } from '../src/app/viewport-callbacks';
import { createStore } from '../src/app/state/store';
import { createHistory } from '../src/app/state/history';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import type { V3 } from '../src/core/doc/types';

const container = document.createElement('div');
container.style.cssText = 'position:relative;width:760px;height:650px';
document.body.appendChild(container);
const dock = document.createElement('div');
dock.id = 'dock-right';
dock.style.cssText = 'position:absolute;left:770px;top:0;width:340px;max-height:100vh;overflow:auto';
document.body.appendChild(dock);
const store = createStore({ mdoc: defaultMountain(), currentMode: 'info', storedUi: {} });
store.mdoc.name = 'Node editing';
store.mdoc.course.knots = [0, 90].map(z => ({ pos: [0, 0, z], width: 30, wall: 0, bank: 0, shoulder: 0 }));
store.mdoc.aiPaths = [
  {
    id: 'recorded-one',
    name: 'Recorded run',
    rating: 35,
    respawnable: true,
    points: [
      [-18, 3, 0],
      [-12, 5, 18],
      [0, 3, 40],
      [12, 1, 65],
    ],
    events: [
      { type: 100, value: 288, start: 8, end: 28 },
      { type: 101, value: 60, start: 0, end: 60 },
    ],
  },
  {
    id: 'recorded-two',
    name: 'Other run',
    rating: 65,
    respawnable: false,
    points: [
      [26, 2, 0],
      [27, 2, 40],
      [25, 2, 80],
    ],
    events: [],
  },
];
const callbacks = createViewportCallbacks({
  store,
  edit: { viewportCallbacks: {} },
  scheduleRebuild() {
    refresh();
    if (!stage.gizmo.dragging) history.commit();
  },
} as never);
callbacks.onSelectKnot = () => {};
const stage = new Stage(container, callbacks, true);
stage.renderer.setSize(760, 650);
stage.perspCam.aspect = 760 / 650;
stage.camera.updateProjectionMatrix();
stage.camera.position.set(65, 80, 55);
stage.controls.target.set(0, 0, -35);
stage.controls.update();
const terrain = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshBasicMaterial({ color: 0xe4edf2, side: THREE.DoubleSide }),
);
terrain.rotation.x = -Math.PI / 2;
terrain.position.set(0, -2, 40);
stage.worldRoot.add(terrain);
const layer = createAiPathsLayer(stage);
let visible = true;
function refresh() {
  layer.setCourse(store.mdoc.course, 1, store.mdoc.aiPaths, store.mdoc.autoAiPaths !== false);
  layer.setVisible(visible);
  localStorage.setItem('ai-editing-document', JSON.stringify(serializeMountain(store.mdoc)));
}
const history = createHistory({
  getDocJson: () => JSON.stringify(serializeMountain(store.mdoc)),
  onRestore(json) {
    store.mdoc = migrateMountain(JSON.parse(json));
    refresh();
    panel.rebuildScene();
  },
  refreshButtons() {},
});
history.commit();
const panel = createScenePanel({
  camera: {} as never,
  getDoc: () => store.mdoc,
  getSelected: () => null,
  setSelected() {},
  getSelectedKnots: () => [],
  setSelectedKnots() {},
  scheduleRebuild() {
    refresh();
    history.commit();
  },
  requestCourseSeat() {},
  surfaceOptions: {},
  isSceneActive: () => true,
  onSelectionChange() {},
  showOwnBox() {},
  showRefBox() {},
  hasReference: () => false,
  getReferenceName: () => '',
  getCourseVisible: () => false,
  setCourseVisible() {},
  getNormalsVisible: () => false,
  setNormalsVisible() {},
  getAiPathsVisible: () => visible,
  setAiPathsVisible(on) {
    visible = on;
    layer.setVisible(on);
  },
  getReferenceAiPaths: () => [],
  highlightReferenceAiPath() {},
  highlightAuthoredAiPath: (index, node) => layer.select(index, node),
  courseDraw: { active: () => false, begin() {}, end() {}, points: () => [], removeLast() {} },
});
callbacks.onSelectAuthoredAiPath = panel.selectAuthoredAiPath;
stage.onGizmoChange = () => {
  if (stage.gizmoKind === 'ainode') layer.moveNode();
};
stage.onGizmoDrag = dragging => {
  if (!dragging) {
    panel.refreshAuthoredAiPath();
    history.commit();
  }
};
panel.setSceneVisible(true);
panel.selectScene('aiPaths');
refresh();
const picking = createScenePicking(stage, {
  authoredPropRoots: () => [],
  referencePropRoots: () => [],
  lightRoots: () => [],
  sourceRoots: () => [],
  railRoots: () => [],
  gemRoots: () => [],
  knotTargets: () => [],
  authoredAiPathRoots: () => layer.pickRoots,
  surfaceTargets: () => [{ source: 'authored', object: terrain }],
});
createPointerRouter(
  stage,
  {} as never,
  {
    rideCtl: { riding: false, endDesktopPointer() {} },
    cameraCtl: { activePointers: new Set(), touchPts: new Map() },
    propDeform: { active: false },
    picking: { vertexSourceAtPointer: () => 'authored', pickMeshComponent: () => null },
    courseDraw: { active: false, onHover: () => false },
    edgeExtrusion: { dragging: false, staged: false },
    gems: {},
    refDecor: { clearPropSelection() {} },
    lights: { clearRigSource() {} },
    scenePicking: picking,
  } as never,
  {
    mode: () => 'info',
    terrain: () => terrain,
    reference: () => null,
    refData: () => null,
    pickAnchor: () => undefined,
    pickKnot: () => undefined,
  } as never,
  { clearRefSelection() {}, selectReference() {} },
);

function render() {
  stage.renderer.render(stage.scene, stage.camera);
  requestAnimationFrame(render);
}
render();
function pixel(point: V3) {
  stage.scene.updateMatrixWorld(true);
  const projected = new THREE.Vector3(...point).applyMatrix4(stage.worldRoot.matrixWorld).project(stage.camera);
  return { x: (projected.x + 1) * 380, y: (1 - projected.y) * 325 };
}
(window as any).aiEditing = {
  pixel,
  nodePixel: (index: number) => pixel(store.mdoc.aiPaths![0].points[index]),
  handlePixel() {
    stage.renderer.render(stage.scene, stage.camera);
    const origin = pixel(store.mdoc.aiPaths![0].points[1]);
    let best: { x: number; y: number; error: number } | null = null;
    for (let y = origin.y - 60; y <= origin.y + 60; y += 2)
      for (let x = origin.x - 60; x <= origin.x + 60; x += 2) {
        stage.castAt({ clientX: x, clientY: y });
        if (stage.gizmoHandleHit()?.object.name !== 'X') continue;
        const error = Math.abs(Math.hypot(x - origin.x, y - origin.y) - 32);
        if (!best || error < best.error) best = { x, y, error };
      }
    if (!best) throw new Error('No X gizmo handle found');
    return best;
  },
  state() {
    const lines: number[] = [],
      selected: number[] = [];
    const eventShapes = new Set<string>();
    stage.worldRoot.traverse(object => {
      if (object instanceof Line2 && Number.isInteger(object.userData.refAiPathIndex)) {
        lines.push(object.userData.refAiPathIndex);
        if (object.material.linewidth === 4.5) selected.push(object.userData.refAiPathIndex);
      }
      if (object instanceof THREE.Points && object.material instanceof THREE.PointsMaterial) {
        const shape = object.material.map?.userData.aiPathEventShape;
        if (shape) eventShapes.add(shape);
      }
    });
    return {
      paths: store.mdoc.aiPaths,
      automatic: store.mdoc.autoAiPaths !== false,
      lines,
      selected,
      eventShapes: [...eventShapes],
      nodes: layer.nodeGroup.children.length,
      gizmo: stage.gizmoKind,
      dragging: stage.gizmo.dragging,
      canUndo: history.canUndo(),
    };
  },
  undo: history.undo,
  redo: history.redo,
  reload() {
    store.mdoc = migrateMountain(JSON.parse(localStorage.getItem('ai-editing-document')!));
    refresh();
    panel.rebuildScene();
  },
};
