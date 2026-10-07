// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import { createStore, selectedSetLights } from '../src/app/state/store';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import type { V3 } from '../src/core/doc/types';

Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { getElementById: () => ({ textContent: '', className: '' }) },
});
// The status toast a light's tie reports through arms a timer.
Object.defineProperty(globalThis, 'window', { configurable: true,
  value: { setTimeout: () => 0, clearTimeout() {}, addEventListener() {}, removeEventListener() {} } });
const { createViewportCallbacks } = await import('../src/app/viewport-callbacks');
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
store.mdoc.props = [-5, 0, 5].map((x, index) => ({
  id: `prop:${index}`, level: 'TEST', model: index, name: `Prop ${index}`, pos: [x, 0, 0] as V3, yaw: 0, scale: 1,
}));
const rendered = { single: null as number | null, many: [] as number[] };
const callbacks = createViewportCallbacks({
  store, edit: { viewportCallbacks: {}, resetGizmoMode() {} },
  propOps: () => ({ isReplacingProp: () => false, lightJoinWaitsFor: () => null, finishLightJoin: () => false }),
  viewport: () => ({ setPlacedPropSelection(single: number | null, many: number[]) {
    rendered.single = single; rendered.many = [...many];
  } }),
  rebuildTools() {}, updateCmdSheet() {}, refreshSelection() {}, scheduleRebuild() {}, selectScene() {},
} as unknown as Parameters<typeof createViewportCallbacks>[0]);
const handlers = new Map<string, ((event: PointerEvent) => void)[]>();
const dom = {
  style: {}, clientWidth: 800, clientHeight: 600, setPointerCapture() {}, releasePointerCapture() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  addEventListener(type: string, handler: (event: PointerEvent) => void) {
    handlers.set(type, [...handlers.get(type) ?? [], handler]);
  },
};
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
camera.position.z = 20;
camera.updateMatrixWorld();
const stage = {
  renderer: { domElement: dom }, container: dom, camera, scene: new THREE.Scene(), worldRoot: new THREE.Group(),
  controls: { enabled: true }, marqueeEl: { style: {} },
  gizmo: { enabled: true, axis: null, object: null, dragging: false }, cb: callbacks, castAt() {},
};
const editModes: string[] = [];
const layers = {
  props: { placedPropGroup: new THREE.Group(), lastPlacedProps: store.mdoc.props, propArm: null,
    selectedProp: null, multiSelProps: [] },
  propLines: { lines: [] }, lights: { lightArmed: false }, rails: { railArmed: false },
  gems: { gemArmed: false, gemLine: null }, rideCtl: { riding: false },
  cameraCtl: { activePointers: new Set(), touchPts: new Map(), orbiting: false, flying: false },
  edgeExtrusion: { active: false, dragging: false, staged: false },
  picking: { vertexSourceAtPointer: () => 'authored' },
  selection: { finishEditMarquee: (mode: string) => editModes.push(mode) },
  cage: { cage: true }, courseDraw: { active: false }, clipboardPlacement: { active: false },
  surgery: { tool: null, onCommit: () => false }, tubeTool: { active: false }, trailTool: { active: false, pickKnot: () => false }, pathHandles: { pickHandle: () => false }, propDeform: { active: false },
  patchTool: { active: false }, weldTool: { active: false }, createEdge: { armed: false },
};
const knots = [-5, 0, 5].map((x, index) => {
  const knot = new THREE.Object3D(); knot.position.x = x; knot.userData.knot = index; return knot;
});
createPointerRouter(stage as unknown as Parameters<typeof createPointerRouter>[0],
  { editPickKinds: { point: true, edge: true, patch: true, prop: false } } as Parameters<typeof createPointerRouter>[1],
  layers as unknown as Parameters<typeof createPointerRouter>[2],
  { mode: () => store.currentMode, isMountain: () => true, courseKnots: () => knots } as unknown as Parameters<typeof createPointerRouter>[3],
  { selectReference() {}, clearRefSelection() {} });

function drag(x0: number, x1: number, shiftDown = false, shiftUp = shiftDown) {
  for (const [type, clientX, clientY, shiftKey] of [
    ['pointerdown', x0, 250, shiftDown], ['pointermove', x1, 350, shiftDown], ['pointerup', x1, 350, shiftUp],
  ] as const) {
    const event = { type, button: 0, pointerId: 1, pointerType: 'mouse', clientX, clientY,
      shiftKey, ctrlKey: false, metaKey: false, altKey: false, target: dom,
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} } as unknown as PointerEvent;
    for (const handler of handlers.get(type) ?? []) handler(event);
  }
}

// Drive real pointer events into the real application callbacks, with objects at x = 200, 400 and 600.
for (const mode of ['props', 'info'] as const) {
  store.currentMode = mode;
  const single = () => mode === 'props' ? store.selectedProp : store.selected;
  const many = () => mode === 'props' ? store.multiSel : store.selectedKnots;
  const selectSingle = () => {
    if (mode === 'props') { store.selectedProp = 0; store.multiSel = []; }
    else { store.selected = 0; store.selectedKnots = []; }
  };
  selectSingle();
  drag(350, 450, true, false);
  assert.deepEqual(many(), [0, 1], `${mode}: Shift-drag retains a single pick even if Shift is released first`);
  assert.equal(single(), null);
  drag(350, 650, true);
  assert.deepEqual(many(), [0, 1, 2], `${mode}: overlapping Shift-drag adds new members without toggling old ones`);
  drag(150, 650, true);
  assert.deepEqual(many(), [0, 1, 2], `${mode}: selecting the same set again never duplicates or removes it`);
  drag(700, 780, true);
  assert.deepEqual(many(), [0, 1, 2], `${mode}: an empty Shift-drag retains the set`);
  drag(550, 650);
  assert.deepEqual(many(), [2], `${mode}: plain drag still replaces the set`);
  drag(150, 250, false, true);
  assert.deepEqual(many(), [0, 2], `${mode}: Shift pressed after pointerdown also adds`);
  selectSingle();
  drag(700, 780, true);
  assert.equal(single(), 0, `${mode}: an empty Shift-drag leaves a single pick untouched`);
  assert.deepEqual(many(), []);
  drag(700, 780);
  assert.equal(single(), null, `${mode}: an empty plain drag clears a single pick`);
  assert.deepEqual(many(), []);
}
assert.deepEqual(rendered, { single: null, many: [] }, 'the prop viewport receives the final selection');

store.currentMode = 'edit';
drag(350, 450, true, false);
drag(350, 450, false, true);
drag(350, 450);
assert.deepEqual(editModes, ['add', 'add', 'replace'], 'Edit vertices/edges/patches retain the same Shift-drag routing');

// Props Ctrl/Cmd+click builds a set prop by prop, a group going in and out whole (docs/015 · Authored groups).
{
  store.currentMode = 'props';
  store.selectedProp = null; store.multiSel = [];
  const toggle = callbacks.onToggleProp!.bind(callbacks);
  toggle(0);
  assert.equal(store.selectedProp, 0, 'Ctrl+click on nothing selected selects that prop on its own');
  assert.deepEqual(store.multiSel, []);
  toggle(2);
  assert.deepEqual(store.multiSel, [0, 2], 'a second Ctrl+click makes a set of the two');
  assert.equal(store.selectedProp, null);
  assert.deepEqual(rendered, { single: null, many: [0, 2] }, 'shown as a set under its centre gizmo');
  toggle(0);
  assert.equal(store.selectedProp, 2, 'dropping one of two leaves the other as an ordinary selection');
  assert.deepEqual(rendered, { single: 2, many: [] });
  toggle(2);
  assert.equal(store.selectedProp, null, 'and dropping the last leaves nothing');
  store.mdoc.props![1].assembly = store.mdoc.props![2].assembly = 'group:0000';
  toggle(0);
  toggle(1);
  assert.deepEqual(store.multiSel, [0, 1, 2], 'Ctrl+click on a group member adds the whole group');
  toggle(2);
  assert.deepEqual(store.selectedProp, 0, 'and Ctrl+click on one drops the whole group');
  delete store.mdoc.props![1].assembly; delete store.mdoc.props![2].assembly;
}

// Props Ctrl/Cmd+click on a light adds it to the selection beside the props, as a prop would be (docs/015).
{
  store.mdoc.lights = [
    { id: 'light:0000', kind: 'point', pos: [0, 5, 0], color: '#ffffff', intensity: 1, reach: 10 },
    { id: 'light:0001', kind: 'point', pos: [3, 5, 0], color: '#ffffff', intensity: 1, reach: 10 },
  ];
  store.selectedProp = null; store.multiSel = []; store.selectedLight = null;
  const toggleLight = callbacks.onToggleLight!.bind(callbacks);
  const toggle = callbacks.onToggleProp!.bind(callbacks);
  assert.equal(toggleLight('light:0000'), false, 'with nothing selected it leaves the click to select the light');
  store.selectedProp = 1;
  assert.equal(toggleLight('light:0000'), true);
  assert.deepEqual(store.multiSel, [1], 'a selected prop and a Ctrl+clicked light make a set…');
  assert.deepEqual(selectedSetLights(store), ['light:0000'], '…with the light in it');
  assert.equal(store.mdoc.lights[0].assembly, undefined, 'and nothing is grouped until ⊞ group is pressed');
  toggle(0);
  assert.deepEqual(store.multiSel, [0, 1], 'Ctrl+clicking another prop keeps the light in the set');
  assert.deepEqual(selectedSetLights(store), ['light:0000']);
  toggleLight('light:0001');
  assert.deepEqual(selectedSetLights(store), ['light:0000', 'light:0001'], 'and another light joins it');
  toggleLight('light:0000');
  assert.deepEqual(selectedSetLights(store), ['light:0001'], 'Ctrl+clicking a light again drops it');
  callbacks.onSelectProps!([2]);
  assert.deepEqual(selectedSetLights(store), [], 'a plain new selection lets the lights go');
  store.multiSel = []; store.selectedProp = null; store.selectedLight = 'light:0000';
  toggle(2);
  assert.deepEqual(store.multiSel, [2], 'Ctrl+clicking a prop with a light selected makes a set of the two');
  assert.deepEqual(selectedSetLights(store), ['light:0000']);
  assert.equal(store.selectedLight, null);
  toggle(2);
  assert.equal(store.selectedLight, 'light:0000', 'dropping the only prop leaves the light selected on its own');
  store.selectedLight = null;
  store.mdoc.lights = [];
}
console.log('Marquee selection: props, course points and Edit modifier routing passed.');
