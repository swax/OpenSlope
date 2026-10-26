// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createCanvas } from '@napi-rs/canvas';
import type { Stage } from '../src/app/viewport/stage';
import type { PlacementEndpoint } from '../src/app/viewport/input/placement-constraint';
import { createSurfaceToolLayer } from '../src/app/viewport/tools/create-surface';
import { createLoftPreviewLayer } from '../src/app/viewport/tools/loft-preview';
import { LOFT_PREVIEW_FILL_COLOR, LOFT_PREVIEW_INVALID_COLOR } from '../src/app/viewport/constants';
import { sceneToData } from '../src/app/viewport/coordinates';
import { blankMountain } from '../src/core/doc/mountain';
import { appendMeshIds } from '../src/core/doc/ids';
import { readVertex } from '../src/core/mesh/primitives';
import type { QuadMeshDoc } from '../src/core/doc/types';

// Corner label sprites need a canvas; the rest of this test remains a pure Three.js scene.
const previousDocument = globalThis.document;
globalThis.document = { createElement: () => createCanvas(256, 64) } as unknown as Document;

// Exercise the transient draft through placement/picking and the same scene-space anchor TransformControls moves.
const stage = {
  worldRoot: new THREE.Group(),
  scene: new THREE.Scene(),
  camera: new THREE.OrthographicCamera(-100, 100, 75, -75, 0.1, 1000),
  pointer: new THREE.Vector2(),
  renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
  cb: {
    onCreateSurfaceChange() {
      changes++;
    },
  },
  gizmo: { dragging: false, object: null as THREE.Object3D | null },
  gizmoKind: null as string | null,
  gizmoKnot: -1,
  castAt() {},
  attachGizmo(object: THREE.Object3D, kind: string, index: number) {
    this.gizmo.object = object;
    this.gizmoKind = kind;
    this.gizmoKnot = index;
  },
  detachGizmo() {
    this.gizmo.object = null;
    this.gizmoKind = null;
  },
};
let changes = 0,
  endpoint: PlacementEndpoint | null = null,
  meshDoc: QuadMeshDoc | null = null;
stage.worldRoot.scale.z = -1;
stage.worldRoot.updateMatrixWorld(true);
stage.camera.position.set(0, 200, 0);
stage.camera.up.set(0, 0, -1);
stage.camera.lookAt(0, 0, 0);
stage.camera.updateMatrixWorld(true);
const layer = createSurfaceToolLayer(
  stage as unknown as Stage,
  () => new THREE.Mesh(),
  () => endpoint,
  () => meshDoc,
);
const pointer = (pos: PlacementEndpoint['pos']) => {
  const p = new THREE.Vector3(...pos).applyMatrix4(stage.worldRoot.matrixWorld).project(stage.camera);
  stage.pointer.set(p.x, p.y);
};
const place = (pos: PlacementEndpoint['pos'], vertex: number | null = null) => {
  pointer(pos);
  endpoint = { pos, vertex };
  layer.onCommit();
};
layer.setActive(true);
place([0, 0, 0], 0);
place([60, 0, 0]);
place([60, 0, 40]);
place([0, 0, 40]);
assert.equal(layer.points.length, 4);
assert(!layer.closed);
place([0, 0, 0]);
assert(layer.closed, 'clicking the first point closes the draft without committing it');
assert.equal(layer.points.length, 4, 'closing does not append a duplicate endpoint');
assert.equal(layer.selected, 0);
assert.equal(stage.gizmoKind, 'surfacepoint');
const anchor = stage.gizmo.object!;
stage.gizmo.dragging = true;
layer.gizmoDragging(true);
anchor.position.set(-8, 5, 6);
layer.gizmoChanged();
assert.deepEqual(
  layer.points[0],
  { pos: [-8, 5, -6], vertex: null },
  'a moved snap releases its host binding and mirrors scene Z',
);
assert.deepEqual(layer.points[1].pos, [60, 0, 0], 'other boundary points stay fixed');
stage.gizmo.dragging = false;
layer.gizmoDragging(false);
assert.deepEqual(sceneToData(anchor.position), layer.points[0].pos);
pointer([60, 0, 40]);
layer.onCommit();
assert.equal(layer.selected, 2, 'any boundary point can be picked');
assert.deepEqual(sceneToData(anchor.position), [60, 0, 40]);
pointer([20, 0, 20]);
endpoint = { pos: [20, 0, 20], vertex: null };
layer.onHover({ shiftKey: false, ctrlKey: false, metaKey: false } as PointerEvent);
assert.equal(layer.hover, null, 'a closed draft has no extra moving endpoint');
layer.onCommit();
assert.equal(layer.selected, null);
assert.equal(layer.points.length, 4, 'clicking inside the closed draft cannot append a point');
assert.equal(stage.gizmoKind, null);
layer.undo();
assert(!layer.closed, 'undoing a point reopens the boundary for more drawing');
place([0, 0, 40]);
assert.equal(layer.points.length, 4);
place([60, 0, 0]);
assert.equal(layer.selected, 1, 'placed points can also be adjusted before closing');
assert.equal(stage.gizmoKind, 'surfacepoint');
layer.setActive(false);
assert.equal(layer.points.length, 0);
assert.equal(stage.gizmoKind, null, 'cancelling detaches the draft gizmo');
assert(changes > 8, 'placements, closure, selection and movement refresh the host preview');

// Picking corners is a separate mode: incomplete picks cannot move points or replace the old corners.
layer.setActive(true);
for (const pos of [
  [0, 0, 0],
  [20, 0, 0],
  [60, 0, 0],
  [60, 0, 40],
  [30, 0, 40],
  [0, 0, 40],
] as PlacementEndpoint['pos'][])
  place(pos);
place([0, 0, 0]);
const boundary = structuredClone(layer.points),
  automatic = [...layer.corners];
layer.beginCornerPicking();
assert(layer.pickingCorners && stage.gizmoKind === null);
place(boundary[1].pos);
place(boundary[1].pos);
place([1000, 0, 1000]);
assert.deepEqual(layer.cornerPicks, [1], 'duplicate picks and empty-space clicks are ignored');
assert.deepEqual(layer.corners, automatic, 'pending picks preserve the previous preview corners');
layer.undo();
assert.equal(layer.cornerPicks.length, 0);
assert.deepEqual(layer.points, boundary);
place(boundary[2].pos);
layer.cancelCornerPicking();
assert(!layer.pickingCorners && !layer.manualCorners);
assert.deepEqual(layer.corners, automatic);
layer.beginCornerPicking();
for (const i of [1, 5, 2, 4]) place(boundary[i].pos);
assert(!layer.pickingCorners && layer.manualCorners);
assert.deepEqual(layer.corners, [1, 2, 4, 5], 'four picks finish automatically and follow the loop from A');
assert.deepEqual(layer.points, boundary, 'corner picking never moves or appends boundary points');
layer.setBoundary(boundary, [0, 2, 3, 5]);
layer.beginCornerPicking();
place(boundary[1].pos);
layer.undo();
assert.deepEqual(layer.cornerPicks, [], 'existing-surface corner edits also support undoing a pick');
layer.cancelCornerPicking();
assert.deepEqual(layer.corners, [0, 2, 3, 5]);
layer.setActive(false);
assert(!layer.pickingCorners && layer.cornerPicks.length === 0);
{
  const { boundary, corners, ...mesh } = JSON.parse(
    readFileSync(new URL('./fixtures/surface-stitch-trail-gap.json', import.meta.url), 'utf8'),
  ) as Pick<QuadMeshDoc, 'vertices' | 'quads' | 'edgeHandles' | 'quadTwist'> & {
    boundary: number[];
    corners: number[];
  };
  meshDoc = { ...blankMountain('TRAIL_GAP'), ...mesh };
  Object.assign(meshDoc, appendMeshIds(meshDoc, mesh.vertices.length / 3, mesh.quads.length));
  layer.setActive(true);
  layer.setBoundary(
    boundary.map(vertex => ({ vertex, pos: readVertex(mesh.vertices, vertex) })),
    corners,
  );
  layer.setCorners(null);
  assert.deepEqual(layer.corners, corners, 'the viewport uses the same snapped-run corners as the committed fill');
  layer.setActive(false);
}

globalThis.document = previousDocument;
{
  const previewStage = { worldRoot: new THREE.Group() } as Stage,
    preview = createLoftPreviewLayer(previewStage, () => null),
    fill = previewStage.worldRoot.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
    crossing: [number, number, number][] = [
      [0, 0, 0],
      [60, 0, 40],
      [60, 0, 0],
      [0, 0, 30],
    ];
  preview.setCharts(null, true, crossing);
  assert(fill.visible && fill.geometry.getAttribute('position').count === crossing.length);
  assert.equal(fill.material.color.getHex(), LOFT_PREVIEW_INVALID_COLOR, 'invalid outlines retain a red footprint');
  preview.rebuild();
  assert(fill.visible, 'an ordinary viewport refresh retains the invalid draft');
  preview.setPreview([[0, 1, 2, 3]], [0, 0, 0, 0, 0, 40, 60, 0, 0, 60, 0, 40]);
  assert.equal(fill.material.color.getHex(), LOFT_PREVIEW_FILL_COLOR, 'other tools restore their normal preview');
  preview.setCharts(null);
  assert(!fill.visible, 'cancelling clears the warning footprint');
}
console.log(
  'SURFACE DRAFT: editable closure, point picking, world-space gizmo movement, released snaps, reopen and cancellation passed.',
);
