// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { V3 } from '../src/core/doc/types';
import type { Stage } from '../src/app/viewport/stage';
import { createSubdivisionBendLayer, type BendHandles } from '../src/app/viewport/tools/subdivision-bend';

const gizmo = { object: null as THREE.Object3D | null, dragging: false };
const stage = {
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(),
  renderer: { domElement: { clientHeight: 1000 } },
  controls: { enabled: true },
  gizmo,
  gizmoKind: null as string | null,
  attachGizmo(object: THREE.Object3D, kind: string) {
    gizmo.object = object;
    this.gizmoKind = kind;
  },
  detachGizmo() {
    gizmo.object = null;
    this.gizmoKind = null;
  },
};
const layer = createSubdivisionBendLayer(stage as unknown as Stage);
const original: V3[] = [
  [0, 0, 1],
  [0, 0, -1],
  [10, 0, 0],
];
let finished = 0;
let handles: BendHandles;
function reset(mode: 'section' | 'point' = 'section') {
  handles = {
    points: structuredClone(original),
    edges: [
      [0, 1],
      [1, 2],
    ],
    sections: [[0, 1], [2]],
    mode,
    index: mode === 'section' ? 0 : 1,
    onSelect() {},
    onChange(points, done) {
      handles = { ...handles, points };
      layer.set(handles);
      if (done) finished++;
    },
  };
  layer.set(handles);
}
function begin() {
  gizmo.dragging = true;
  layer.dragging(true);
}
function end() {
  gizmo.dragging = false;
  layer.dragging(false);
}
function near(actual: readonly V3[], expected: readonly V3[]) {
  actual.forEach((p, i) => p.forEach((n, a) => assert(Math.abs(n - expected[i][a]) < 1e-8)));
}
reset();
begin();
gizmo.object!.position.x = 2;
layer.changed();
gizmo.object!.position.x = 3;
layer.changed();
near(handles!.points, [
  [3, 0, 1],
  [3, 0, -1],
  [10, 0, 0],
]);
end();
assert.equal(finished, 1, 'one completed drag, with each frame measured from its start');
reset();
begin();
gizmo.object!.rotation.y = Math.PI / 2;
layer.changed();
near(handles!.points, [
  [-1, 0, 0],
  [1, 0, 0],
  [10, 0, 0],
]);
end();
reset();
begin();
gizmo.object!.scale.setScalar(2);
layer.changed();
near(handles!.points, [
  [0, 0, 2],
  [0, 0, -2],
  [10, 0, 0],
]);
end();
reset('point');
begin();
gizmo.object!.position.y = 8;
layer.changed();
near(handles!.points, [
  [0, 0, 1],
  [0, 8, -1],
  [10, 0, 0],
]);
layer.set(null);
assert.equal(gizmo.dragging, false, 'closing mid-drag releases the native transform');
assert.equal(stage.controls.enabled, true);
assert.equal(gizmo.object, null);
console.log(
  'SUBDIVISION BEND HANDLES: PASS (point/section movement, rotation, scale, scene coordinates and drag cancellation)',
);
