import * as THREE from 'three';
import { createEffectsEditor } from '../src/app/effects/editor';
import { createStore } from '../src/app/state/store';
import { createReferenceDecor } from '../src/app/viewport/scene/reference-decor';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createScenePicking } from '../src/app/viewport/input/scene-picking';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import { RAW_TO_EDITOR } from '../src/app/viewport/constants';
import { defaultMountain } from '../src/core/doc/mountain';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { decodeReferenceEffects, referenceEffectInstanceIndices } from '../src/core/reference/effects';
import { decodeProps } from '../src/core/reference/props';
import { buildLevelPropsUncached } from '../src/shared/map-props';
import { readReferenceEffects } from '../src/shared/map-effects';
import type { MapDataSource } from '../src/shared/map-data';

const level = 'SSXOT_ER4_DAY';
const names = ['mdl_er4_trg_fw_archlights_4_1001', 'mdl_er4_impassableleft_17', 'ordinary-fence'];
const document = createEmptyEffectsDocument(level);
document.target.game = 'ssx-on-tour';
const rows = names.map((InstanceName, i) => ({
  InstanceName,
  ModelID: 0,
  Location: [i * 300, 0, 0],
  Rotation: [0, 0, 0, 1],
  Scale: [1, 1, 1],
  Visable: true,
  PlayerCollision: true,
  PlayerBounce: true,
  CollsionMode: 2,
  U0: 1e30,
  EffectSlotIndex: -1,
}));
const docs: Record<string, unknown> = {
  'Effects.json': document,
  'Instances.json': { Instances: rows },
  'Models.json': {
    Models: [
      {
        ModelName: 'retained-helper-mesh',
        ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'triangle.obj', MaterialID: 0 }] }],
      },
    ],
  },
};
const sourceBytes = JSON.stringify(docs);
const io: MapDataSource = {
  root: 'maps',
  async readJsonOr<T>(path: string, fallback: T): Promise<T> {
    return (docs[path.split('/').at(-1)!] as T) ?? fallback;
  },
  async readTextOrNull(path) {
    return path.endsWith('/triangle.obj') ? 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n' : null;
  },
  async readBytesOrNull() {
    return null;
  },
  async listEntries() {
    return [];
  },
  async listDir() {
    return [];
  },
  async pathExists() {
    return false;
  },
};
const props = decodeProps(await buildLevelPropsUncached(io, level));
const effects = decodeReferenceEffects(await readReferenceEffects(io, level));
const canvas = window.document.createElement('canvas');
canvas.width = 500;
canvas.height = 220;
canvas.style.display = 'block';
window.document.body.appendChild(canvas);
const scene = new THREE.Scene();
const refRoot = new THREE.Group();
scene.add(refRoot, new THREE.AmbientLight(0xffffff));
const camera = new THREE.OrthographicCamera(-1, 8, 1, -1, 0.1, 30);
camera.up.set(0, 0, -1);
camera.position.set(0, 10, 0);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const renderer = new THREE.WebGLRenderer({ canvas });
renderer.setSize(500, 220);
const store = createStore({ mdoc: defaultMountain(), currentMode: 'effects', storedUi: {} });
const unavailable: string[] = [];
let selected: number[] = [];
const stage: any = {
  scene,
  refRoot,
  camera,
  renderer,
  container: canvas,
  ray: new THREE.Raycaster(),
  controls: { enabled: true },
  gizmo: { enabled: false },
  cb: {
    onSelectReferenceEffectProp: (index: number, additive: boolean) =>
      editor.selectReferencePropEffect(index, additive),
    onClickTargetUnavailable: (target: string) => unavailable.push(target),
    onClearEffectSelection: () => editor.clearSelection(),
  },
  castAt(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    this.ray.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        (-(event.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    scene.updateMatrixWorld(true);
  },
};
const decor = createReferenceDecor(stage, createPropAssets());
decor.setProps(props);
decor.setEffectPropIndices(referenceEffectInstanceIndices(effects));
decor.showProps(true);
const render = () => renderer.render(scene, camera);
const viewport: any = {
  showEffectMotionPaths() {},
  showEffectRails() {},
  showAuthoredEffectProps() {},
  setEffectHandle() {},
  setPlacedPropSelection() {},
  setReferenceEffects() {},
  stopReferenceEffectPreview() {},
  showReferenceAnimObjectPath() {},
  hideReferenceSplineMotion() {},
  selectReferenceRailSpline() {},
  selectAuthoredParticleVolume() {},
  selectReferenceParticleVolume() {},
  showReferenceEffectInspector(on: boolean) {
    decor.showEffectProps(on);
    render();
  },
  selectReferenceEffectInstances(indices: number[]) {
    selected = [...indices];
    decor.highlightEffectPropSourceIndices(indices);
    render();
  },
};
const editor = createEffectsEditor({
  store,
  viewport,
  scheduleRebuild() {},
  loadPropLevel: async () => props,
  goToProp() {},
  goToSpecialProp() {},
  goToPropTools() {},
  goToRail() {},
  pathHandles: {} as any,
});
window.document.body.appendChild(editor.el);
editor.setReferenceState({ status: 'ready', data: effects });
editor.setActive(true);
const picking = createScenePicking(stage, {
  authoredPropRoots: () => [],
  referencePropRoots: scope => (scope === 'effects' ? decor.effectPropGroups : decor.propPickGroups),
  lightRoots: () => [],
  sourceRoots: () => [],
  railRoots: () => [],
  gemRoots: () => [],
  knotTargets: () => [],
  surfaceTargets: () => [],
});
createPointerRouter(
  stage,
  {} as any,
  {
    rideCtl: { riding: false },
    cameraCtl: { activePointers: new Set(), touchPts: new Map() },
    propDeform: { active: false },
    picking: { vertexSourceAtPointer: () => 'reference' },
    rails: { railArmed: false, rails: [] },
    pathHandles: { pickHandle: () => false },
    scenePicking: picking,
  } as any,
  { mode: () => store.currentMode } as any,
  {} as any,
);

function press(index: number, additive = false) {
  const point = new THREE.Vector3(index * 300 + 33, 33, 0).applyMatrix4(RAW_TO_EDITOR).project(camera);
  const rect = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerType: 'mouse',
      pointerId: 1,
      button: 0,
      clientX: rect.left + ((point.x + 1) / 2) * rect.width,
      clientY: rect.top + ((1 - point.y) / 2) * rect.height,
      ctrlKey: additive,
    }),
  );
  return { selected: [...selected], text: editor.el.textContent, unavailable: [...unavailable] };
}

(window as any).helperSelection = {
  press,
  refresh() {
    editor.setReferenceState({ status: 'ready', data: effects });
    editor.render();
    return [...selected];
  },
  stop() {
    editor.setActive(false);
    return decor.effectPropGroups[2].visible;
  },
  unchanged() {
    return (
      JSON.stringify(docs) === sourceBytes &&
      effects.document.graphs.length === 0 &&
      effects.document.slots.length === 0
    );
  },
};
render();
