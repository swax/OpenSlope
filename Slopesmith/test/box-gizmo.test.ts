// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBoxToolLayer } from '../src/app/viewport/tools/create-box';
import { planBox } from '../src/core/mesh/ops/box';
import type { Stage } from '../src/app/viewport/stage';
import type { PlacementEndpoint } from '../src/app/viewport/input/placement-constraint';

const near = (actual: readonly number[], expected: readonly number[]) =>
  assert(
    actual.every((value, i) => Math.abs(value - expected[i]) < 1e-8),
    `${actual} != ${expected}`,
  );

const stage = {
  worldRoot: new THREE.Group(),
  scene: new THREE.Scene(),
  camera: new THREE.OrthographicCamera(-400 / 3, 400 / 3, 100, -100, 0.1, 5000),
  pointer: new THREE.Vector2(),
  ray: new THREE.Raycaster(),
  renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
  worldPerPixel: () => 200 / 600,
  snapDataPoint: (point: [number, number, number]) => [...point] as [number, number, number],
  castAt() {
    this.ray.setFromCamera(this.pointer, this.camera);
  },
  gizmo: { dragging: false, object: null as THREE.Object3D | null },
  gizmoKind: null as string | null,
  attachGizmo(object: THREE.Object3D, kind: string) {
    this.gizmo.object = object;
    this.gizmoKind = kind;
  },
  detachGizmo() {
    this.gizmo.object = null;
    this.gizmoKind = null;
  },
};
stage.camera.position.set(45, 200, -30);
stage.camera.up.set(0, 0, -1);
stage.camera.lookAt(45, 0, -30);
stage.camera.updateMatrixWorld();
let next: PlacementEndpoint | null = null;
const layer = createBoxToolLayer(
  stage as unknown as Stage,
  () => new THREE.Mesh(),
  () => next,
);
const currentDraft = () => layer.draft;
function aim(pos: [number, number, number]) {
  const at = new THREE.Vector3(pos[0], pos[1], -pos[2]).project(stage.camera);
  stage.pointer.set(at.x, at.y);
  stage.castAt();
}
function placeBase() {
  layer.setActive(true);
  for (const pos of [
    [0, 0, 0],
    [90, 0, 0],
    [90, 0, 60],
  ] as [number, number, number][]) {
    aim(pos);
    next = { pos, vertex: 0 };
    layer.onCommit();
  }
}
placeBase();
assert.equal(currentDraft(), null, 'the third click fixes only the flat base');
assert.equal(stage.gizmoKind, null, 'the gizmo waits for a fixed height');
assert.equal(layer.points.length, 3);
layer.onCommit();
assert.equal(layer.points.length, 3, 'zero height cannot complete the box');
stage.pointer.y += 0.3;
layer.onHover({} as PointerEvent);
assert(Math.abs(layer.candidate!.height[1] - 30) < 1e-8, 'pulling upward sets positive height even from top view');
assert.equal(currentDraft(), null, 'the volume stays provisional until the fourth click');
layer.onCommit();
assert(layer.draft);
assert.equal(layer.points.length, 4);
assert.equal(stage.gizmoKind, 'box');
near(stage.gizmo.object!.position.toArray(), [45, 15, -30]);
const drag = (change: (anchor: THREE.Object3D) => void) => {
  stage.gizmo.dragging = true;
  layer.gizmoDragging(true);
  change(stage.gizmo.object!);
  layer.gizmoChanged();
  stage.gizmo.dragging = false;
  layer.gizmoDragging(false);
  assert(planBox(layer.draft!).ok, 'transforms keep the box axes perpendicular');
};
drag(anchor => anchor.position.add(new THREE.Vector3(5, 7, -9)));
near(layer.draft.origin, [5, 7, 9]);
drag(anchor => anchor.scale.set(2, 3, 4));
const scaled = planBox(layer.draft);
assert(scaled.ok);
near(Object.values(scaled.plan.dimensions), [180, 240, 90]);
drag(anchor =>
  anchor.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 3)),
);
const rotated = planBox(layer.draft);
assert(rotated.ok);
for (const axis of ['length', 'width', 'height'] as const)
  assert(Math.abs(rotated.plan.dimensions[axis] - scaled.plan.dimensions[axis]) < 1e-8);
drag(anchor => anchor.scale.set(1.5, 0.5, 2));
const resizedAfterRotation = planBox(layer.draft);
assert(resizedAfterRotation.ok);
for (const [axis, expected] of [
  ['length', 270],
  ['width', 480],
  ['height', 45],
] as const)
  assert(Math.abs(resizedAfterRotation.plan.dimensions[axis] - expected) < 1e-8, 'scale follows the rotated box axes');
layer.setPlan(rotated.plan);
assert(stage.worldRoot.children.some(object => object instanceof THREE.LineSegments && object.visible));
layer.setActive(false);
assert.equal(stage.gizmoKind, null);
assert.equal(currentDraft(), null);
assert(
  stage.worldRoot.children.every(object => !object.visible),
  'cancel clears all guides',
);
layer.setActive(true);
assert.equal(layer.points.length, 0, 'rearming starts with an empty base');
placeBase();
stage.pointer.y -= 0.2;
layer.onHover({} as PointerEvent);
layer.onCommit();
assert(
  layer.draft!.height[1] < 0 && Math.abs(layer.draft!.height[1] + 20) < 1e-8,
  'pulling downward extrudes below the base',
);
assert(planBox(layer.draft!).ok);
layer.setActive(false);
stage.camera.position.set(180, 130, 150);
stage.camera.up.set(0, 1, 0);
stage.camera.lookAt(45, 0, -30);
stage.camera.updateMatrixWorld();
placeBase();
aim([90, 25, 60]);
layer.onHover({} as PointerEvent);
assert(Math.abs(layer.candidate!.height[1] - 25) < 1e-8, 'oblique views track the height axis under the pointer');
aim([90, -15, 60]);
layer.onHover({} as PointerEvent);
assert(
  Math.abs(layer.candidate!.height[1] + 15) < 1e-8,
  'the pull crosses through the base without changing its footprint',
);
stage.camera.position.set(160, 100, -140);
stage.camera.lookAt(45, 0, -30);
stage.camera.updateMatrixWorld();
stage.castAt();
layer.refresh();
assert(Math.abs(layer.candidate!.height[1] + 15) < 1e-8, 'orbiting preserves the current height');
layer.setActive(false);
placeBase();
stage.snapDataPoint = point => point.map(value => Math.round(value / 5) * 5) as [number, number, number];
aim([90, 12, 60]);
layer.onHover({} as PointerEvent);
layer.onCommit();
assert(Math.abs(layer.draft!.height[1] - 10) < 1e-8, 'the fourth step respects placement snapping');
// Face and edge picks resize local boundaries, including when near and far edges overlap on screen.
layer.setActive(false);
stage.camera.position.set(45, 200, -30);
stage.camera.up.set(0, 0, -1);
stage.camera.lookAt(45, 0, -30);
stage.camera.updateMatrixWorld();
stage.snapDataPoint = point => [...point];
placeBase();
stage.pointer.y += 0.3;
stage.castAt();
layer.onCommit();
aim([20, 30, 20]);
layer.onCommit();
assert.equal(layer.selectionLabel, 'height end face');
assert.equal(layer.wholeSelected, false);
assert.deepEqual(stage.gizmo.object!.userData.boxResizeAxes, [false, true, false]);
drag(anchor => anchor.position.add(new THREE.Vector3(100, 20, 50)));
near(layer.draft!.origin, [0, 0, 0]);
const faceSized = planBox(layer.draft!);
assert(faceSized.ok);
near(Object.values(faceSized.plan.dimensions), [90, 60, 50]);
aim([90, 50, 20]);
layer.onCommit();
assert.equal(layer.selectionLabel, 'edge along width');
assert.deepEqual(stage.gizmo.object!.userData.boxResizeAxes, [true, true, false]);
drag(anchor => anchor.position.add(new THREE.Vector3(30, 10, 99)));
near(layer.draft!.origin, [0, 0, 0]);
near(layer.draft!.length, [120, 0, 0]);
near(layer.draft!.width, [0, 0, 60]);
near(layer.draft!.height, [0, 60, 0]);
layer.selectWhole();
assert.equal(layer.wholeSelected, true);
assert.equal(stage.gizmo.object!.userData.boxResizeAxes, null);
drag(anchor => anchor.position.add(new THREE.Vector3(5, 7, -9)));
near(layer.draft!.origin, [5, 7, 9]);
console.log(
  'BOX GIZMO: PASS (four-click placement, signed height, component picking/resizing, whole transforms, cancel)',
);
