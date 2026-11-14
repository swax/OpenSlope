// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { Rail, V3 } from '../src/core/doc/types';
import type { Stage } from '../src/app/viewport/stage';
import { createRailsLayer } from '../src/app/viewport/scene/rails';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';

const stage = {
  scene: new THREE.Scene(),
  worldRoot: new THREE.Group(),
  gizmo: { dragging: false, object: null as THREE.Object3D | null },
  gizmoKind: null as string | null,
  cb: {
    onSelectRailNode: (_r: number | null, _n: number | null, _nodes?: readonly number[]) => {},
    onMoveRailNode: (_r: number, _n: number, _pos: V3) => {},
    onMoveRailNodes: (_r: number, _nodes: readonly number[], _delta: V3) => {},
  },
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
const assets = createPropAssets();
const layer = createRailsLayer(stage as unknown as Stage, assets);
const rail: Rail = {
  id: 'rail:1',
  height: 6,
  nodes: [
    [0, 6, 0],
    [20, 8, 10],
    [40, 10, 20],
  ],
  handles: [null, { in: [-5, 1, 0], out: [5, -1, 0] }, null],
};
const second: Rail = {
  id: 'rail:2',
  height: 6,
  nodes: [
    [60, 6, 0],
    [80, 6, 0],
  ],
};
const rails = [rail, second];
let selected: readonly number[] = [];
stage.cb.onSelectRailNode = (r, n, nodes) => {
  selected = [...(nodes ?? [])];
  layer.setRails(rails, r, n, nodes);
};
stage.cb.onMoveRailNodes = (r, nodes, delta) => {
  for (const node of nodes) rails[r].nodes[node] = rails[r].nodes[node].map((value, axis) => value + delta[axis]) as V3;
  layer.setRails(rails, r, null, nodes);
};
const outlines = () => {
  let count = 0;
  layer.railGroup.traverse(object => {
    if ((object as THREE.Mesh).material === assets.propOutlineMat) count++;
  });
  return count;
};
layer.setRails(rails, null, null);
layer.seatNode(0, 0);
assert.deepEqual(selected, [0]);
assert.equal(layer.selectedNode, 0);
assert.equal(outlines(), 0, 'one point does not select the whole pipe');
layer.seatNode(0, 2, true);
assert.deepEqual(selected, [0, 2]);
assert.equal(layer.selectedNode, null);
assert.deepEqual(stage.gizmo.object!.position.toArray(), [20, 8, -10], 'a group gizmo sits at the selected centroid');
assert.equal(outlines(), 1, 'a multi-point selection outlines the pipe');
const untouched = [...rail.nodes[1]],
  handles = structuredClone(rail.handles);
stage.gizmo.dragging = true;
layer.moveSelectedNodes([25, 10, 4]);
layer.moveSelectedNodes([28, 12, 2]);
stage.gizmo.dragging = false;
assert.deepEqual(rail.nodes[0], [8, 10, -8]);
assert.deepEqual(rail.nodes[2], [48, 14, 12]);
assert.deepEqual(rail.nodes[1], untouched, 'group translation leaves unselected points untouched');
assert.deepEqual(rail.handles, handles, 'translation preserves relative Bezier handles');
layer.seatNode(0, 0, true);
assert.deepEqual(selected, [2], 'Shift-click removes a selected point');
assert.equal(outlines(), 0);
layer.seatAll(0);
assert.deepEqual(selected, [0, 1, 2]);
assert(
  stage.gizmo
    .object!.position.toArray()
    .every((value, axis) => Math.abs(value - [76 / 3, 32 / 3, -14 / 3][axis]) < 1e-12),
);
layer.setSkins({});
assert.deepEqual(layer.selectedNodes, [0, 1, 2], 'asset refresh preserves a multi-point selection');
layer.seatNode(1, 0, true);
assert.deepEqual(selected, [0], 'a different rail starts its own point selection');
layer.seatNode(1, 0, true);
assert.equal(layer.selectedRail, null, 'removing the last point deselects the rail');
assert.equal(stage.gizmoKind, null);
console.log(
  'RAIL POINT SELECTION: PASS (single, additive, toggle, all, shared pivot, rigid translation, handles, refresh, deselection)',
);
