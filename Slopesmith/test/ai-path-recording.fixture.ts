import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import GUI from 'lil-gui';
import { TestRide } from '../src/app/ride/session';
import { appendRecordedAiPaths } from '../src/core/doc/ai-paths';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { serializeMountain } from '../src/core/doc/serialize';
import { createHistory } from '../src/app/state/history';
import { createViewportCallbacks } from '../src/app/viewport-callbacks';
import { createAiPathsLayer } from '../src/app/viewport/scene/ai-paths';
import { createScenePanel } from '../src/app/ui/chrome/scene-panel';
import { createStore } from '../src/app/state/store';
import { createPlay } from '../src/app/ride/play';
import { buildPlayTools } from '../src/app/ui/tool-panels/play';
import { createEditSections } from '../src/app/ui/tool-panels/widgets';
import { clearGui } from '../src/app/ui/components/gui';

const positions: number[] = [],
  indices: number[] = [];
for (let z = 0; z <= 800; z += 4) positions.push(-60, -z * 0.2, z, 60, -z * 0.2, z);
for (let i = 0; i < 200; i++) {
  const a = i * 2;
  indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
}
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geometry.setIndex(indices);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x264054);
scene.add(new THREE.AmbientLight(0xffffff, 2));
const root = new THREE.Group();
scene.add(root);
const terrain = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xdce9ec }));
scene.add(terrain);
terrain.updateMatrixWorld(true);
const container = document.createElement('div');
container.style.cssText = 'position:relative;width:700px;height:540px';
document.body.appendChild(container);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(700, 540);
container.appendChild(renderer.domElement);
const camera = new THREE.PerspectiveCamera(60, 700 / 540, 0.1, 2000);
const dock = document.createElement('div');
dock.id = 'dock-right';
dock.style.cssText = 'position:absolute;left:710px;top:0;width:310px;max-height:100vh;overflow:auto';
document.body.appendChild(dock);
const store = createStore({ mdoc: defaultMountain(), currentMode: 'play', storedUi: { playMusic: false } });
store.playTarget = 'authored';
store.mdoc.course.knots = [4, 650].map(z => ({ pos: [0, -z * 0.2, z], width: 30, wall: 0, bank: 0, shoulder: 0 }));
const layer = createAiPathsLayer({ scene, worldRoot: root, refRoot: root } as never);
let visible = true;
function refresh() {
  layer.setCourse(store.mdoc.course, 1, store.mdoc.aiPaths, store.mdoc.autoAiPaths !== false);
  layer.setVisible(visible);
  panel?.rebuildScene();
  localStorage.setItem('ai-recording-document', JSON.stringify(serializeMountain(store.mdoc)));
  renderer.render(scene, camera);
}
const history = createHistory({
  getDocJson: () => JSON.stringify(serializeMountain(store.mdoc)),
  onRestore: json => {
    store.mdoc = migrateMountain(JSON.parse(json));
    refresh();
  },
  refreshButtons() {},
});
history.commit();
const callbacks = createViewportCallbacks({
  store,
  edit: { viewportCallbacks: {} },
  scheduleRebuild() {
    history.commit();
    refresh();
  },
} as never);
const panel = createScenePanel({
  camera: {} as never,
  getDoc: () => store.mdoc,
  getSelected: () => null,
  setSelected() {},
  getSelectedKnots: () => [],
  setSelectedKnots() {},
  scheduleRebuild() {
    history.commit();
    refresh();
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
  highlightAuthoredAiPath: index => layer.select(index),
  courseDraw: { active: () => false, begin() {}, end() {}, points: () => [], removeLast() {} },
});
panel.setSceneVisible(true);
panel.selectScene('aiPaths');
refresh();
let ride: TestRide | null = null;
function start(authored = true, recordAiRun = false, touchControls = navigator.maxTouchPoints > 0) {
  const owner = store.mdoc;
  ride = new TestRide({
    terrain,
    scene,
    camera,
    container,
    pointerTarget: renderer.domElement,
    spawn: new THREE.Vector3(0, 0, 4),
    heading: new THREE.Vector3(0, 0, 1),
    surfaceOf: () => 1,
    oobFloorY: -300,
    label: 'AI recording test',
    riderModel: 'procedural',
    boardFx: false,
    touchControls,
    fullscreen: false,
    onExit: () => play.exitRide(),
    recordAiRun,
    onRecordAiPaths: authored
      ? sections => callbacks.onRecordAiPaths?.(appendRecordedAiPaths(owner.aiPaths, sections), owner)
      : undefined,
  });
  ride.start();
}
const toolsHost = document.createElement('div');
toolsHost.id = 'test-tools';
toolsHost.style.cssText = 'width:360px';
document.body.appendChild(toolsHost);
const gui = new GUI({ container: toolsHost, title: 'Test' });
const editSection = createEditSections(gui);
const viewport = {
  get riding() {
    return !!ride;
  },
  get recordingAiRun() {
    return ride?.recordingAiRun ?? false;
  },
  watching: false,
  xrPlaying: false,
  canRideReference: true,
  aiRiderCount: 0,
  activeMapPlayers: () => [],
  dataToWorld: (v: unknown) => v,
  referenceSpawn: () => ({ pos: [0, 0, 4], heading: [0, 0, 1] }),
  showRideSpawn() {},
  setPlayActive() {},
  startRide(...args: unknown[]) {
    start(args[0] === 'authored', args[8] === true, args[7] === true);
  },
  stopRide() {
    ride?.stop();
    ride = null;
  },
  toggleRidePause() {
    ride?.setPaused(!ride.paused);
  },
  setRideGameVolume() {},
  setRideMusic() {},
  setRideAnnouncer() {},
};
const play = createPlay({
  store,
  viewport: viewport as never,
  persistUi() {},
  rebuildTools,
  updateCmdSheet() {},
  syncSkyVisibility() {},
  ensureReferenceEffects: async () => {},
  onPlayingChanged() {},
});
function rebuildTools() {
  clearGui(gui);
  buildPlayTools({
    gui,
    store,
    viewport,
    propPreview: { hide() {} },
    editSection,
    getPlay: () => play,
    getRefLevel: () => 'Reference',
    persistUi() {},
    rebuildTools,
  } as never);
}
rebuildTools();
function key(key: string, down: boolean) {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key, bubbles: true }));
}
(window as unknown as { aiRecording: unknown }).aiRecording = {
  runTo(z: number) {
    if (!ride) throw new Error('No active ride');
    let pressed = false,
      released = false;
    for (let i = 0; i < 3600 && ride.state.pos.z < z; i++) {
      if (!pressed && ride.state.pos.z >= 80 && ride.state.pos.z < 104 && ride.state.grounded) {
        key(' ', true);
        pressed = true;
      }
      if (pressed && !released && ride.state.pos.z >= 104) {
        key(' ', false);
        released = true;
      }
      ride.step(1 / 60);
    }
    renderer.render(scene, camera);
    return { z: ride.state.pos.z, preview: scene.children.filter(child => child instanceof THREE.LineSegments).length };
  },
  state() {
    const selectedPaths: number[] = [];
    root.traverse(object => {
      if (object instanceof Line2 && object.userData.refAiPathIndex !== undefined && object.material.linewidth === 4.5)
        selectedPaths.push(object.userData.refAiPathIndex);
    });
    return {
      paths: store.mdoc.aiPaths ?? [],
      canUndo: history.canUndo(),
      buttons: container.querySelectorAll('.os-ai-record').length,
      recording: ride?.recordingAiRun ?? false,
      riding: !!ride,
      selectedPaths,
      preview: scene.children.filter(child => child instanceof THREE.LineSegments).length,
    };
  },
  stop() {
    play.exitRide();
    renderer.render(scene, camera);
  },
  start,
  setTarget(target: 'authored' | 'reference') {
    play.enterPlaySetup(target);
  },
  undo() {
    history.undo();
  },
  redo() {
    history.redo();
  },
  reload() {
    store.mdoc = migrateMountain(JSON.parse(localStorage.getItem('ai-recording-document')!));
    refresh();
  },
  selectPath() {
    panel.selectAuthoredAiPath(0);
  },
  frameOverview() {
    camera.position.set(90, 180, 175);
    camera.lookAt(0, -25, 175);
    renderer.render(scene, camera);
  },
};
