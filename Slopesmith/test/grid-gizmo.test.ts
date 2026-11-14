// tier: fast

/**
 * The Create Grid draft's whole-draft gizmo (docs/017 · Create grid): a free draft moves, turns and scales about its
 * centre; one drawn off an edge hinges on it — Rotate swings the far side about the edge, Scale stretches it out from
 * the edge or spreads the far corners along it, Move carries the far side — and the snapped side never moves.
 * Drives `createGridToolLayer` over a stage faked down to what it touches, posing the scene-root anchor as
 * TransformControls would, so the mirrored Z is checked against the corners it reports in data space.
 * Run: `npx tsx test/grid-gizmo.test.ts`
 */
import * as THREE from 'three';
import type { V3 } from '../src/core/doc/types';
import { createGridToolLayer } from '../src/app/viewport/tools/create-grid';
import type { PlacementEndpoint } from '../src/app/viewport/input/placement-constraint';
import type { Stage } from '../src/app/viewport/stage';
import { check, failures } from './check';
import { resizeGridWidth } from '../src/core/mesh/ops/grid';

const stage = {
  worldRoot: new THREE.Group(),
  scene: new THREE.Scene(),
  ray: new THREE.Raycaster(),
  gizmo: { dragging: false, object: null as THREE.Object3D | null, mode: 'rotate' as 'translate' | 'rotate' | 'scale' },
  gizmoKind: null as string | null,
  gizmoKnot: -1,
  camera: new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 5000),
  pointer: new THREE.Vector2(),
  renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
  attachGizmo(obj: THREE.Object3D, kind: string, idx: number) {
    this.gizmoKind = kind;
    this.gizmoKnot = idx;
    this.gizmo.object = obj;
  },
  detachGizmo() {
    this.gizmoKind = null;
    this.gizmo.object = null;
  },
};
stage.camera.position.set(0, 200, 0);
let next: PlacementEndpoint | null = null;
const layer = createGridToolLayer(
  stage as unknown as Stage,
  () => new THREE.Mesh(),
  () => next,
);

const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const scene = (p: V3) => [p[0], p[1], -p[2]];
const positions = () => layer.corners!.map(corner => corner.pos);

/** Arm the tool and place a draft from three clicks, each one a vertex snap or a free point. */
function draft(clicks: PlacementEndpoint[]) {
  layer.setActive(false);
  layer.setActive(true);
  for (const click of clicks) {
    next = click;
    layer.onCommit();
  }
  next = null;
}

/** One drag: freeze, pose the anchor as TransformControls would, report, release — and the corners after it. */
function drag(pose: (obj: THREE.Object3D) => void): V3[] {
  const anchor = stage.gizmo.object!;
  stage.gizmo.dragging = true;
  layer.gizmoDragging(true);
  pose(anchor);
  layer.gizmoChanged();
  stage.gizmo.dragging = false;
  layer.gizmoDragging(false);
  return positions();
}

function mode(next: 'translate' | 'rotate' | 'scale') {
  stage.gizmo.mode = next;
  layer.gizmoModeChanged();
}

// Off an edge: both ends of the first side snapped to points, the third click free.
{
  stage.gizmo.mode = 'rotate';
  draft([
    { pos: [0, 0, 0], vertex: 0 },
    { pos: [0, 0, 20], vertex: 1 },
    { pos: [-12, 0, 20], vertex: null },
  ]);
  const anchor = stage.gizmo.object!;
  check(
    layer.wholeSelected && stage.gizmoKind === 'grid' && anchor.userData.gridHinge === true,
    'hinge: a draft drawn off an edge comes up held whole, flagged as hinged',
  );
  check(
    near(anchor.position.toArray(), scene([0, 0, 10])),
    'hinge: Rotate sits on the middle of the edge',
    JSON.stringify(anchor.position.toArray()),
  );
  const axis = (v: THREE.Vector3) => v.applyQuaternion(anchor.quaternion).toArray();
  check(
    near(axis(new THREE.Vector3(1, 0, 0)).map(Math.abs), [0, 0, 1], 1e-9) &&
      near(axis(new THREE.Vector3(0, 0, 1)), [-1, 0, 0], 1e-9),
    'hinge: the anchor runs X along the edge and Z across to the far side',
  );

  const pinned = (out: V3[]) =>
    near(out[0], [0, 0, 0]) &&
    near(out[1], [0, 0, 20]) &&
    layer.corners![0].vertex === 0 &&
    layer.corners![1].vertex === 1;
  // TransformControls turns a local ring as start × (turn about the local axis).
  let out = drag(obj =>
    obj.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)),
  );
  check(pinned(out), 'rotate: the snapped edge stays where it is, still snapped');
  check(
    near(out[2], [0, 12, 20], 1e-9) && near(out[3], [0, 12, 0], 1e-9),
    'rotate: a quarter turn stands the far side up over the edge',
    JSON.stringify(out),
  );
  check(
    near(axis(new THREE.Vector3(0, 0, 1)), [0, 1, 0], 1e-9),
    'release: the anchor re-frames across to the swung far side',
  );

  mode('scale');
  out = drag(obj => obj.scale.set(1, 1, 2));
  check(
    pinned(out) && near(out[2], [0, 24, 20], 1e-9) && near(out[3], [0, 24, 0], 1e-9),
    'scale across: the grid stretches out from the edge, which stays',
    JSON.stringify(out),
  );
  out = drag(obj => obj.scale.set(1.5, 1, 1));
  check(
    pinned(out) && near(out[2], [0, 24, 25], 1e-9) && near(out[3], [0, 24, -5], 1e-9),
    'scale along: the far corners spread apart about their middle, the edge stays',
    JSON.stringify(out),
  );

  mode('translate');
  check(
    near(anchor.position.toArray(), scene([0, 24, 10]), 1e-9),
    'move: the gizmo sits on the middle of the far side',
  );
  out = drag(obj => obj.position.add(new THREE.Vector3(3, 0, 4)));
  check(
    pinned(out) && near(out[2], [3, 24, 21], 1e-9) && near(out[3], [3, 24, -9], 1e-9),
    'move: the far side is carried by the drag, Z mirrored back to data; the edge stays',
    JSON.stringify(out),
  );
  mode('rotate');
  check(
    near(anchor.position.toArray(), scene([0, 0, 6]), 1e-9),
    'rotate again: the gizmo is back on the hinge line, level with the shifted far side',
    JSON.stringify(anchor.position.toArray()),
  );
}

// The second side snapped hinges there too; one snapped corner pins the draft without a hinge.
{
  draft([
    { pos: [-10, 0, 0], vertex: null },
    { pos: [0, 0, 0], vertex: 0 },
    { pos: [0, 0, 20], vertex: 1 },
  ]);
  check(
    layer.wholeSelected && stage.gizmo.object?.userData.gridHinge === true,
    'second side: it hinges on the snapped second side',
  );
  const out = drag(obj => obj.scale.set(1, 1, 2));
  check(
    near(out[0], [-20, 0, 0], 1e-9) &&
      near(out[3], [-20, 0, 20], 1e-9) &&
      near(out[1], [0, 0, 0]) &&
      near(out[2], [0, 0, 20]),
    'second side: scale stretches the free side out from it',
    JSON.stringify(out),
  );
  draft([
    { pos: [0, 0, 0], vertex: 0 },
    { pos: [0, 0, 20], vertex: null },
    { pos: [-12, 0, 20], vertex: null },
  ]);
  check(
    !layer.wholeSelected && stage.gizmoKind === null,
    'one snapped corner: the draft waits for a free corner to be picked',
  );
}

// A free draft still moves, turns and scales whole about its centre.
{
  stage.gizmo.mode = 'rotate';
  draft([
    { pos: [0, 0, 0], vertex: null },
    { pos: [30, 0, 0], vertex: null },
    { pos: [30, 0, 20], vertex: null },
  ]);
  const anchor = stage.gizmo.object!;
  check(
    layer.wholeSelected && anchor.userData.gridHinge === false && near(anchor.position.toArray(), scene([15, 0, 10])),
    'free: the gizmo holds the whole draft at its centre',
  );
  // World rings turn as (turn about the world axis) × start.
  let out = drag(obj =>
    obj.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)),
  );
  const centre = [15, 0, 10];
  const reach = (p: V3) => Math.hypot(p[0] - centre[0], p[2] - centre[2]);
  check(
    out.every(p => Math.abs(reach(p) - Math.hypot(15, 10)) < 1e-9 && Math.abs(p[1]) < 1e-9) &&
      !near(out[0], [0, 0, 0], 1e-6),
    'free: a turn moves every corner about the centre',
    JSON.stringify(out),
  );
  mode('scale');
  const before = positions();
  out = drag(obj => obj.scale.set(2, 1, 1));
  const length = (ps: V3[]) => Math.hypot(ps[1][0] - ps[0][0], ps[1][2] - ps[0][2]);
  check(Math.abs(length(out) - 2 * length(before)) < 1e-9, 'free: a stretch along the first side doubles its length');
}

// Boundary edges resize a placed draft as a pair, without disturbing its opposite side or snapped corners.
{
  stage.camera.position.set(45, 200, -30);
  stage.camera.up.set(0, 0, -1);
  stage.camera.lookAt(45, 0, -30);
  stage.camera.updateMatrixWorld();
  const pick = (pos: V3) => {
    const projected = new THREE.Vector3(...scene(pos)).project(stage.camera);
    stage.pointer.set(projected.x, projected.y);
    stage.ray.setFromCamera(stage.pointer, stage.camera);
    layer.onCommit();
  };
  draft([
    { pos: [0, 0, 0], vertex: null },
    { pos: [90, 0, 0], vertex: null },
    { pos: [90, 0, 60], vertex: null },
  ]);
  mode('translate');
  pick([90, 0, 30]);
  check(
    layer.selectionLabel === 'edge 2' && stage.gizmoKind === 'gridcorner',
    'edge: a boundary click selects the whole edge',
  );
  check(near(stage.gizmo.object!.position.toArray(), scene([90, 0, 30])), 'edge: the move gizmo sits at its midpoint');
  const anchor = stage.gizmo.object!;
  stage.gizmo.dragging = true;
  layer.gizmoDragging(true);
  anchor.position.x = 105;
  layer.gizmoChanged();
  anchor.position.x = 120;
  layer.gizmoChanged();
  stage.gizmo.dragging = false;
  layer.gizmoDragging(false);
  check(
    near(positions()[1], [120, 0, 0]) && near(positions()[2], [120, 0, 60]),
    'edge: both endpoints follow the frozen drag, without accumulating',
  );
  check(near(positions()[0], [0, 0, 0]) && near(positions()[3], [0, 0, 60]), 'edge: the opposite side stays fixed');
  layer.setCorners(resizeGridWidth(layer.corners!, 100));
  check(near(anchor.position.toArray(), scene([120, 0, 50])), 'edge: typed dimensions reseat the selected edge gizmo');
  pick([60, 0, 50]);
  check(layer.wholeSelected, 'edge: clicking the interior selects the whole grid again');
  pick([120, 0, 100]);
  check(layer.selectionLabel === 'corner 3', 'edge: corners retain pick priority over their adjoining edges');
  draft([
    { pos: [0, 0, 0], vertex: 0 },
    { pos: [90, 0, 0], vertex: 1 },
    { pos: [90, 0, 60], vertex: null },
  ]);
  pick([45, 0, 0]);
  check(layer.selectionLabel !== 'edge 1', 'edge: a snapped boundary cannot be moved');
  pick([45, 0, 60]);
  drag(object => (object.position.z -= 30));
  check(
    near(positions()[2], [90, 0, 90]) && near(positions()[3], [0, 0, 90]),
    'edge: the free boundary resizes an attached grid',
  );
  check(
    near(positions()[0], [0, 0, 0]) && near(positions()[1], [90, 0, 0]),
    'edge: an attached grid keeps its snapped side fixed',
  );
  // A turned and tilted grid supplies the edge gizmo's frame, independent of world axes and the camera.
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.45, 0.6, 0.15));
  const turned = (
    [
      [0, 0, 0],
      [90, 0, 0],
      [90, 0, 60],
      [0, 0, 60],
    ] as V3[]
  ).map(pos => {
    const point = new THREE.Vector3(...scene(pos)).applyQuaternion(turn);
    return { pos: [point.x, point.y, -point.z] as V3, vertex: null };
  });
  layer.setCorners(turned as unknown as NonNullable<typeof layer.corners>);
  const midpoint = turned[2].pos.map((value, i) => (value + turned[3].pos[i]) / 2) as V3;
  pick(midpoint);
  const framed = stage.gizmo.object!;
  const along = new THREE.Vector3(...scene(turned[1].pos)).sub(new THREE.Vector3(...scene(turned[0].pos))).normalize();
  const across = new THREE.Vector3(...scene(turned[3].pos)).sub(new THREE.Vector3(...scene(turned[0].pos))).normalize();
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(framed.quaternion);
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(framed.quaternion);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(framed.quaternion);
  check(
    framed.userData.gridEdge === true && Math.abs(x.dot(along)) > 1 - 1e-9 && Math.abs(z.dot(across)) > 1 - 1e-9,
    'edge frame: axes follow a rotated and tilted grid',
  );
  check(
    Math.abs(y.dot(along)) < 1e-9 && Math.abs(y.dot(across)) < 1e-9,
    'edge frame: the up axis follows the grid normal',
  );
  const before = positions().map(point => [...point] as V3);
  drag(object => object.position.addScaledVector(z, 20));
  check(
    near(positions()[0], before[0]) && near(positions()[1], before[1]),
    'edge frame: a local-axis resize leaves the opposite side fixed',
  );
  check(
    Math.abs(new THREE.Vector3(...positions()[2]).distanceTo(new THREE.Vector3(...positions()[1])) - 80) < 1e-8,
    'edge frame: dragging along local width changes width without shearing',
  );
  pick(positions()[2]);
  check(
    stage.gizmo.object!.userData.gridEdge === false &&
      stage.gizmo.object!.quaternion.angleTo(new THREE.Quaternion()) < 1e-9,
    'edge frame: corner selection clears the edge orientation',
  );
}

if (failures) process.exitCode = 1;
