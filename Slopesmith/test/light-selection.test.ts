// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createStore, setSelectedSet, selectedSetLights } from '../src/app/state/store';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import type { AuthoredLight, V3 } from '../src/core/doc/types';
import { freeLightToPlaced } from '../src/core/lighting/sign-lights';
import { createLightsLayer } from '../src/app/viewport/scene/lights';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createTransformLayer } from '../src/app/viewport/gizmo/transform';
import type { Stage } from '../src/app/viewport/stage';
import type { ViewportCallbacks } from '../src/app/viewport/types';

Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { setTimeout: () => 0, setInterval: () => 0, clearTimeout() {} },
});
const { createViewportCallbacks } = await import('../src/app/viewport-callbacks');
const { createPropOps } = await import('../src/app/props/operations');
const store = createStore({ mdoc: migrateMountain(defaultMountain()), currentMode: 'props', storedUi: {} });
const anchor = new THREE.Object3D();
const stage = {
  scene: new THREE.Group(),
  worldRoot: new THREE.Group(),
  gizmoKind: null as string | null,
  gizmo: { object: null as THREE.Object3D | null, dragging: false, axis: 'XZ', setMode() {}, setSpace() {} },
  cb: {} as ViewportCallbacks,
  attachGizmo(object: THREE.Object3D, kind: string) {
    this.gizmo.object = object;
    this.gizmoKind = kind;
  },
  detachGizmo() {
    this.gizmo.object = null;
    this.gizmoKind = null;
  },
  reframeGizmo() {},
};
const lights = createLightsLayer(stage as unknown as Stage);
const props = createPropsLayer(stage as unknown as Stage, createPropAssets(), lights);
stage.cb = createViewportCallbacks({
  store,
  edit: { viewportCallbacks: {}, resetGizmoMode() {} },
  viewport: () => ({ setPlacedPropSelection: props.setSelection }),
  rebuildTools() {},
  scheduleRebuild() {},
  updateCmdSheet() {},
} as unknown as Parameters<typeof createViewportCallbacks>[0]);
const transform = createTransformLayer(
  stage as unknown as Stage,
  {
    net: () => null,
    meshDoc: () => null,
    preview: () => null,
    edgeHandle: () => null,
    terrainBVH: () => null,
    groundAt: x => ({ y: x / 2, normal: [0, 1, 0] }),
  },
  {
    selectedCorner: () => null,
    cornerGroupIdx: () => [],
    editEdgeSel: () => [],
    editCellSel: () => [],
    controlPointSel: () => [],
    authoredControlPointByKey: () => new Map(),
    selectedCageHandle: () => null,
    selectedProp: () => props.selectedProp,
    multiSelProps: () => props.multiSelProps,
    selectedLights: () => lights.selectedSetLights,
    selectedScreenAttached: () => false,
    placedProp: index => store.mdoc.props?.[index],
    extrusionStaged: () => false,
    extrusionFanMode: () => false,
  },
  {
    cornerMarker: anchor,
    cornerGroupHandle: anchor,
    cornerGroupHandleLast: new THREE.Vector3(),
    cageHandleAnchor: anchor,
    propsHandleLast: props.multiHandleLast,
  },
  { releaseCageHandle() {}, enableExtrusionTransform() {}, controlPointsMoved() {} },
);
const sourceLights = (): AuthoredLight[] =>
  [-2, 2, 8].map((x, index) => ({
    id: `light:${index}`,
    kind: 'spot',
    pos: [x, 4, 0],
    dir: [1, 0, 0],
    color: '#88aaff',
    intensity: 2,
    reach: 10,
    cone: 25,
  }));
function reset() {
  store.mdoc.props = [];
  store.mdoc.lights = sourceLights();
  store.selectedLight = null;
  store.selectedProp = null;
  setSelectedSet(store, [], ['light:0', 'light:1']);
  props.setPlacedProps([], null, []);
  lights.setFreeLights(store.mdoc.lights, null, selectedSetLights(store));
  props.setSelection(null, []);
  stage.gizmo.object!.scale.setScalar(1);
  transform.setPropGizmoFrame('world');
}
const near = (actual: readonly number[], expected: readonly number[]) =>
  assert(
    actual.every((value, axis) => Math.abs(value - expected[axis]) < 1e-8),
    `${actual} != ${expected}`,
  );
const wireLines = (group: THREE.Group): THREE.LineSegments[] => {
  const lines: THREE.LineSegments[] = [];
  group.traverse(object => {
    if (object instanceof THREE.LineSegments) lines.push(object);
  });
  return lines;
};
reset();
assert.equal(stage.gizmoKind, 'props', 'a light-only set receives the shared placement gizmo');
near(stage.gizmo.object!.position.toArray(), [0, 4, 0]);
assert.equal(lights.selectedSetLights.length, 2, 'both source markers remain selected');
assert.equal(wireLines(lights.freeLightGroup).length, 1, 'selected lights share one batched wireframe');
const selectedWireVertices = wireLines(lights.freeLightGroup)[0].geometry.getAttribute('position').count;
const markers = lights.freeLightGroup.children.find(child => child instanceof THREE.Points)!;
assert.equal(
  (markers.userData.sourceSelectionGeometry as THREE.BufferGeometry).getAttribute('position').count,
  2,
  'both light icons receive the selected outline',
);
props.clearSelection();
assert.equal(stage.gizmoKind, null, 'clearing a light-only set detaches its shared gizmo immediately');
props.setSelection(null, []);
stage.cb.onMoveProps!([1, 2, 3]);
near(store.mdoc.lights![0].pos, [-1, 6, 3]);
near(store.mdoc.lights![1].pos, [3, 6, 3]);
near(store.mdoc.lights![2].pos, [8, 4, 0]);

reset();
transform.setGizmoMode('rotate');
assert(transform.rotationActive(), 'the shared rotation rings work without any prop members');
transform.beginRotation();
stage.gizmo.object!.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
transform.rotateSelection();
near(store.mdoc.lights![0].pos, [0, 4, -2]);
near(store.mdoc.lights![1].pos, [0, 4, 2]);
near(store.mdoc.lights![0].dir!, [0, 0, 1]);
transform.rotateSelection();
near(store.mdoc.lights![0].pos, [0, 4, -2]);
near(store.mdoc.lights![0].dir!, [0, 0, 1]);
transform.endRotation();

reset();
transform.setGizmoMode('scale');
assert(transform.scaleActive(), 'a light-only selection supports uniform scale');
transform.beginScale();
stage.gizmo.object!.scale.setScalar(2);
transform.scaleSelection();
near(store.mdoc.lights![0].pos, [-4, 4, 0]);
assert.equal(store.mdoc.lights![0].reach, 20, 'scale changes light reach as well as spacing');
transform.scaleSelection();
assert.equal(store.mdoc.lights![0].reach, 20, 'repeated frames use the frozen start rather than accumulating scale');
transform.endScale();

reset();
transform.setGizmoMode('move');
transform.setPropGizmoFrame('surface');
transform.beginSlide();
stage.gizmo.object!.position.x += 4;
assert(transform.slideProps(stage.gizmo.object!), 'a light-only surface slide owns the move');
near(store.mdoc.lights![0].pos, [2, 6, 0]);
near(store.mdoc.lights![1].pos, [6, 6, 0]);
transform.endSlide();

// The same anchor includes both prop and light origins, and each member moves exactly once.
reset();
store.mdoc.props = [{ level: 'TEST', model: 0, name: 'Lamp', pos: [6, 0, 0] as V3, yaw: 0, scale: 1 }];
setSelectedSet(store, [0], ['light:0', 'light:1']);
props.setPlacedProps(store.mdoc.props, null, [0]);
near(stage.gizmo.object!.position.toArray(), [2, 8 / 3, 0]);
stage.cb.onMoveProps!([2, 0, 0]);
near(store.mdoc.props[0].pos, [8, 0, 0]);
near(store.mdoc.lights![0].pos, [0, 4, 0]);

// A light-only set can be deleted or dismissed through the same operations as a prop set.
const ops = createPropOps({
  store,
  viewport: {},
  scheduleRebuild() {},
  rebuildTools() {},
  updateCmdSheet() {},
} as unknown as Parameters<typeof createPropOps>[0]);
setSelectedSet(store, [], ['light:0', 'light:1']);
ops.deleteMultiSelProps();
assert.deepEqual(
  store.mdoc.lights!.map(light => light.id),
  ['light:2'],
);
assert.deepEqual(selectedSetLights(store), []);

// A selected authored group expands its lights without adding them to the independent transform set.
reset();
store.mdoc.props = [0, 1].map(index => ({
  id: `prop:${index}`,
  level: 'TEST',
  model: 0,
  name: 'Lamp',
  pos: [index * 10, 0, 0] as V3,
  yaw: 0,
  scale: 1,
  assembly: 'group:rig',
}));
store.mdoc.lights![0].assembly = store.mdoc.lights![1].assembly = 'group:rig';
setSelectedSet(store, [0, 1], []);
lights.setFreeLights(store.mdoc.lights!, null, []);
props.setPlacedProps(store.mdoc.props, null, [0, 1]);
assert.equal(
  wireLines(lights.freeLightGroup)[0].geometry.getAttribute('position').count,
  selectedWireVertices,
  'every light in a selected group shows its wireframe exactly once',
);
assert.deepEqual(lights.selectedSetLights, [], 'implicit group lights do not become independent transform members');
near(stage.gizmo.object!.position.toArray(), [5, 0, 0]);
lights.setFreeLights(store.mdoc.lights!, null, ['light:0', 'light:2']);
assert.equal(
  wireLines(lights.freeLightGroup)[0].geometry.getAttribute('position').count,
  selectedWireVertices * 1.5,
  'a group and an extra selected light each render once, including overlapping selection',
);
lights.setFreeLights(store.mdoc.lights!, null, []);
const originalWire = wireLines(lights.freeLightGroup)[0];
const beforeBounds = new THREE.Box3().setFromBufferAttribute(
  originalWire.geometry.getAttribute('position') as THREE.BufferAttribute,
);
for (const light of store.mdoc.lights!.slice(0, 2)) light.pos[0] += 10;
lights.setFreeLights(store.mdoc.lights!, null, []);
const afterBounds = new THREE.Box3().setFromBufferAttribute(
  wireLines(lights.freeLightGroup)[0].geometry.getAttribute('position') as THREE.BufferAttribute,
);
assert(Math.abs(afterBounds.min.x - beforeBounds.min.x - 10) < 1e-6, 'selected group wireframes follow moved lights');
props.setSelection(null, [0]);
assert.equal(
  wireLines(lights.freeLightGroup).length,
  0,
  'selecting only part of a group does not expand its other lights',
);
props.setSelection(null, [0, 1]);
let disposed = false;
wireLines(lights.freeLightGroup)[0].geometry.addEventListener('dispose', () => {
  disposed = true;
});
props.clearSelection();
assert(disposed && !wireLines(lights.freeLightGroup).length, 'deselecting a group clears and disposes its wireframe');

// Packed group lights follow their selected placement, alongside any independently selected light.
lights.setAuthoredLights([
  { ...freeLightToPlaced(store.mdoc.lights![0], 0), ofGroup: 0 },
  { ...freeLightToPlaced(store.mdoc.lights![1], 1), ofGroup: 1 },
]);
props.setSelection(null, [0, 1]);
assert.equal(
  wireLines(lights.authoredLightsGroup).length,
  1,
  'selected group placements share one derived-light wireframe',
);
assert.equal(
  wireLines(lights.authoredLightsGroup)[0].geometry.getAttribute('position').count,
  selectedWireVertices,
  'the packed group wireframe contains every selected light',
);
props.clearSelection();
assert.equal(
  wireLines(lights.authoredLightsGroup).length,
  0,
  'clearing prop selection also clears derived group wireframes',
);
console.log('Light selection: shared anchors, move, rotation, scale, surface slide and deletion passed.');
