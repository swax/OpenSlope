import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { createScenePanel } from '../src/app/ui/chrome/scene-panel';
import { createReferenceCourseDecor } from '../src/app/viewport/scene/reference-decor-course';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import { readLevelAiPaths } from '../src/shared/map-levels';
import { defaultMountain } from '../src/core/doc/mountain';
import { pathFile, pathSource } from './ai-path-data.fixture';
import { aiPathEventSpan } from '../src/core/reference/ai-paths';
import { aiPathColor } from '../src/app/ai-path-style';
import { aiLineRatings } from '../src/core/doc/course';
import { createAiPathsLayer } from '../src/app/viewport/scene/ai-paths';
import { createTileMaterials } from '../src/app/viewport/mesh/tile-materials';

const original = JSON.stringify(pathFile);
let paths = (await readLevelAiPaths(pathSource, 'TEST'))!;
const sourcePaths = paths;
let visible = false;
let highlighted: number | null = null;
let mode = 'info';
let referenceSelections = 0;
let anchorOverPath = false;
let attachedGizmo = '';
const anchor = new THREE.Mesh();
const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const dock = document.createElement('div');
dock.id = 'dock-right';
dock.style.cssText = 'position:absolute;left:650px;top:0;width:370px;max-height:100vh;overflow:auto';
document.body.appendChild(dock);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x142432);
scene.add(new THREE.AmbientLight(0xffffff, 1));
const refRoot = new THREE.Group();
refRoot.position.set(5, 0, 4);
refRoot.scale.z = -1;
refRoot.rotation.y = 0.25;
scene.add(refRoot);
const camera = new THREE.OrthographicCamera(-15, 35, 18, -18, 0.1, 200);
camera.up.set(0, 0, -1);
camera.position.set(10, 60, 5);
camera.lookAt(10, 0, 5);
camera.updateMatrixWorld();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(640, 460);
const terrain = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), new THREE.MeshBasicMaterial({ color: 0xf3f6fa }));
terrain.rotation.x = -Math.PI / 2;
terrain.position.set(15, 0, 0);
refRoot.add(terrain);
const surfaceMaterial = terrain.material;
const pickMaterial = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
let textureMesh: THREE.Mesh | null = null;
function texturedTerrain(on: boolean) {
  if (on && !textureMesh) {
    // Real tile material, created after the paths as when reference images finish loading asynchronously.
    const texture = new THREE.DataTexture(new Uint8Array([243, 246, 250, 255]), 1, 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const tiles = createTileMaterials(() => {});
    textureMesh = new THREE.Mesh(terrain.geometry, tiles.material('TEST/snow', texture));
    terrain.add(textureMesh);
  }
  terrain.material = on ? pickMaterial : surfaceMaterial;
  if (textureMesh) textureMesh.visible = on;
}
const building = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshBasicMaterial({ color: 0x2c3a40 }));
building.position.set(10, 4, 0);
building.userData.propIndex = 8;
building.visible = false;
refRoot.add(building);
const stage: any = {
  scene,
  refRoot,
  camera,
  renderer,
  container: canvas,
  ray: new THREE.Raycaster(),
  controls: { enabled: true },
  gizmo: { enabled: false },
  detachGizmo() {},
  attachGizmo(_object: THREE.Object3D, kind: string) {
    attachedGizmo = kind;
  },
  cb: {
    onSelectKnot() {},
    onSelectReferenceAiPath: (index: number | null) => panel.selectReferenceAiPath(index),
    onSelectMountain: () => panel.selectScene('info'),
  },
  castAt(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    this.ray.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        1 - ((event.clientY - rect.top) / rect.height) * 2,
      ),
      camera,
    );
    scene.updateMatrixWorld(true);
  },
};
const decor = createReferenceCourseDecor(stage);
decor.setAiPaths(paths);
for (const material of decor.aiPathMaterials) material.resolution.set(640, 460);
const render = () => renderer.render(scene, camera);
const panel = createScenePanel({
  camera: {} as any,
  getDoc: () => defaultMountain(),
  getSelected: () => null,
  setSelected() {},
  getSelectedKnots: () => [],
  setSelectedKnots() {},
  scheduleRebuild() {},
  requestCourseSeat() {},
  surfaceOptions: {},
  isSceneActive: () => mode === 'info',
  onSelectionChange: render,
  showOwnBox() {},
  showRefBox() {},
  hasReference: () => true,
  getReferenceName: () => 'TEST',
  getCourseVisible: () => false,
  setCourseVisible() {},
  getNormalsVisible: () => false,
  setNormalsVisible() {},
  getAiPathsVisible: () => visible,
  setAiPathsVisible(on) {
    visible = on;
    decor.showAiPaths(on);
    render();
  },
  getReferenceAiPaths: () => paths,
  highlightReferenceAiPath(index) {
    highlighted = index;
    decor.selectAiPath(index);
    render();
  },
  courseDraw: { active: () => false, begin() {}, end() {}, points: () => [], removeLast() {} },
});
panel.setSceneVisible(true);
panel.selectScene('aiPaths');
const picking = createScenePicking(stage, {
  authoredPropRoots: () => [building],
  referencePropRoots: () => [],
  lightRoots: () => [],
  sourceRoots: () => [],
  railRoots: () => [],
  gemRoots: () => [],
  knotTargets: () => [],
  referenceAiPathRoots: () => [decor.aiPathGroup],
  surfaceTargets: () => [{ source: 'reference', object: terrain }],
});
createPointerRouter(
  stage,
  {} as any,
  {
    rideCtl: { riding: false, endDesktopPointer() {} },
    cameraCtl: { activePointers: new Set(), touchPts: new Map() },
    propDeform: { active: false },
    picking: { vertexSourceAtPointer: () => 'reference', pickMeshComponent: () => null },
    courseDraw: { active: false },
    edgeExtrusion: { dragging: false, staged: false },
    gems: {},
    refDecor: { clearPropSelection() {} },
    lights: { clearRigSource() {} },
    scenePicking: picking,
  } as any,
  {
    mode: () => mode,
    terrain: () => terrain,
    reference: () => terrain,
    refData: () => null,
    pickAnchor: () => (anchorOverPath ? { object: anchor } : undefined),
    pickKnot: () => undefined,
  } as any,
  {
    clearRefSelection() {},
    selectReference() {
      referenceSelections++;
      panel.selectScene('info');
    },
  },
);

function pathPixel(index: number, station = 15) {
  const path = paths.find(path => path.originalIndex === index)!;
  render();
  const sample = aiPathEventSpan(path.points, station, station)[0];
  const p = new THREE.Vector3(...sample).applyMatrix4(refRoot.matrixWorld).project(camera);
  const pixel = new Uint8Array(4);
  const gl = renderer.getContext();
  gl.readPixels(
    Math.floor(((p.x + 1) / 2) * 640),
    Math.floor(((p.y + 1) / 2) * 460),
    1,
    1,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixel,
  );
  return [...pixel];
}

function snapshot() {
  const selectedPath = paths.find(path => path.originalIndex === highlighted);
  const selectedPixel = selectedPath ? pathPixel(selectedPath.originalIndex) : null;
  return {
    selectedPixel,
    expectedColor: selectedPath ? aiPathColor(selectedPath.rating) : null,
    highlighted,
    visible,
    category: panel.getSceneSel(),
    referenceSelections,
    attachedGizmo,
    details: [...dock.querySelectorAll('.sp-detail')].map(row => ({
      label: row.querySelector('.lil-name')?.textContent,
      value: row.querySelector('input')?.value,
      readOnly: row.querySelector('input')?.readOnly,
    })),
    materials: decor.aiPathGroup.children.map(child => ({
      index: child.userData.refAiPathIndex,
      color: (child as any).material.color.getHex(),
      dashed: (child as any).material.dashed,
      width: (child as any).material.linewidth,
    })),
    annotationsVisible: decor.aiPathAnnotations.visible,
    overviewVisible: decor.aiPathEvents.visible,
    overviewCount: decor.aiPathEvents.children.length,
    eventRanges: decor.aiPathAnnotations.children
      .filter(child => child.userData.eventStations)
      .map(child => ({
        event: child.userData.aiPathEvent,
        stations: child.userData.eventStations,
        color: (child as any).material.color.getHex(),
        positions: Array.from((child as any).geometry.attributes.instanceStart.data.array),
      })),
    eventLabels: decor.aiPathAnnotations.children
      .filter(child => child instanceof THREE.Sprite)
      .map(child => child.userData.aiPathEvent),
    annotationCount: decor.aiPathAnnotations.children.length,
    text: dock.textContent,
    eventTitles: [...dock.querySelectorAll('.lil-title')]
      .map(element => element.textContent)
      .filter(title => /^\d+\./.test(title ?? '')),
    eventTitleSymbols: [...dock.querySelectorAll('.lil-title')]
      .filter(element => /^\d+\./.test(element.textContent ?? ''))
      .map(element => element.querySelector('svg') !== null),
    detailFolders: [...dock.querySelectorAll('.lil-title')]
      .map(element => element.textContent)
      .filter(title => title === 'Reference path' || title === 'Geometry' || /^Events \(/.test(title ?? '')),
    eventShapes: Object.fromEntries(
      decor.aiPathAnnotations.children
        .filter(child => child instanceof THREE.Points)
        .map(child => [
          child.userData.aiPathEvent,
          (child as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>).material.map?.userData.aiPathEventShape,
        ]),
    ),
    overviewShapes: [
      ...new Set(
        decor.aiPathEvents.children
          .filter(child => child instanceof THREE.Points)
          .map(
            child =>
              (child as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>).material.map?.userData
                .aiPathEventShape,
          ),
      ),
    ].sort(),
  };
}

(window as any).aiPathSelection = {
  snapshot,
  pixels(index: number, stations: number[]) {
    return stations.map(station => pathPixel(index, station));
  },
  select(index: number | null) {
    panel.selectReferenceAiPath(index);
    return snapshot();
  },
  reload(extraEvents = false) {
    paths = extraEvents
      ? sourcePaths.map(path =>
          path.originalIndex === 1
            ? {
                ...path,
                events: [
                  ...path.events,
                  { type: 101, value: 36, start: 4, end: 7.5 },
                  { type: -1, value: 0, start: 16, end: 16 },
                ],
              }
            : path,
        )
      : sourcePaths;
    decor.setAiPaths(paths);
    panel.refreshReferenceAiPaths();
    for (const material of decor.aiPathMaterials) material.resolution.set(640, 460);
    render();
    return snapshot();
  },
  textured(on: boolean) {
    texturedTerrain(on);
    render();
  },
  depthSamples() {
    const selected = highlighted;
    const height = terrain.position.y;
    const results = [1, null].map(index => {
      panel.selectReferenceAiPath(index);
      const read = () => [15, 6, 20].map(station => pathPixel(1, station));
      terrain.position.y = 0;
      const exposed = read();
      terrain.position.y = 5;
      const occluded = read();
      decor.showAiPaths(false);
      const background = read();
      decor.showAiPaths(true);
      return { exposed, occluded, background };
    });
    terrain.position.y = height;
    panel.selectReferenceAiPath(selected);
    render();
    return results;
  },
  authoredFade() {
    const authoredScene = new THREE.Scene();
    const worldRoot = new THREE.Group();
    worldRoot.scale.z = -1;
    authoredScene.add(worldRoot);
    const layer = createAiPathsLayer({ scene: authoredScene, worldRoot } as any);
    const course = {
      blend: 0,
      surface: 1,
      knots: [0, 100].map(z => ({
        pos: [0, 0, z] as [number, number, number],
        width: 30,
        wall: 0,
        bank: 0,
        shoulder: 0,
      })),
    };
    layer.setCourse(course, 1);
    layer.setVisible(true);
    const group = worldRoot.children[0];
    const bright = group.children[0] as Line2;
    const behind = bright.children[0] as Line2;
    const material = bright.material;
    const ghost = behind.material;
    const styles = group.children.map(child => ({
      thick: child instanceof Line2,
      width: (child as Line2).material.linewidth,
      color: (child as Line2).material.color.getHex(),
    }));
    const expectedColors = aiLineRatings(course, 1).map(aiPathColor);
    layer.setFade(0.4);
    const faded = [material.opacity, ghost.opacity];
    layer.select(0);
    const selected = [bright.material.opacity, (bright.children[0] as Line2).material.opacity];
    layer.select(null);
    layer.setFade(1);
    const restored = [material.opacity, ghost.opacity];
    layer.setFade(0.4);
    layer.setCourse(course, 1);
    const rebuilt = group.children[0] as Line2;
    const rebuiltFade = [rebuilt.material.opacity, (rebuilt.children[0] as Line2).material.opacity];
    const result = {
      styles,
      expectedColors,
      faded,
      selected,
      rebuiltFade,
      restored,
      depth: ghost.depthFunc,
      sharedGeometry: behind.geometry === bright.geometry,
    };
    layer.setCourse(null, 1);
    return { ...result, cleared: group.children.length === 0 && !group.visible };
  },
  press(index: number, offset = 0) {
    const path = paths.find(path => path.originalIndex === index)!;
    const p = new THREE.Vector3(...path.points[1]).applyMatrix4(refRoot.matrixWorld).project(camera);
    const rect = canvas.getBoundingClientRect();
    for (const type of ['pointerdown', 'pointerup'])
      canvas.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerType: 'mouse',
          pointerId: 1,
          button: 0,
          clientX: rect.left + ((p.x + 1) / 2) * rect.width,
          clientY: rect.top + ((1 - p.y) / 2) * rect.height + offset,
        }),
      );
    return snapshot();
  },
  hide() {
    decor.showAiPaths(false);
  },
  show() {
    visible = true;
    decor.showAiPaths(true);
  },
  anchor(on: boolean) {
    anchorOverPath = on;
  },
  occlude(on: boolean) {
    terrain.position.y = on ? 5 : 0;
    render();
  },
  building(on: boolean) {
    building.visible = on;
    render();
  },
  clearReference() {
    paths = [];
    decor.setAiPaths(null);
    panel.refreshReferenceAiPaths();
    render();
    return snapshot();
  },
  leave() {
    mode = 'edit';
    decor.showAiPaths(false);
    panel.setSceneVisible(false);
    return snapshot();
  },
  enter() {
    mode = 'info';
    decor.showAiPaths(true);
    panel.setSceneVisible(true);
    panel.selectScene('aiPaths');
  },
  unchanged: () => JSON.stringify(pathFile) === original,
};
render();
