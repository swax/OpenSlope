// tier: fast

/**
 * The whole-selection gizmo (docs/023): trail paths selected with no point picked carry the gizmo at their patches'
 * centre, and Move / Rotate / Scale on it report the transform from the drag's start, which the host takes every
 * point and dragged Bézier handle through. Drives `createTrailToolLayer` over a stage faked down to what it touches, so the scene-root
 * anchor's mirrored Z is checked against the data it reports. Run: `npx tsx test/trail-gizmo.test.ts`
 */
import * as THREE from 'three';
import type { PathHandles, V3 } from '../src/core/doc/types';
import { createTrailToolLayer, type TrailTransform } from '../src/app/viewport/tools/create-trail';
import type { Stage } from '../src/app/viewport/stage';
import { check, failures } from './check';

const stage = {
  worldRoot: new THREE.Group(), scene: new THREE.Scene(), ray: new THREE.Ray(),
  gizmo: { dragging: false, object: null as THREE.Object3D | null },
  gizmoKind: null as string | null, gizmoKnot: -1,
  pointMarkerRadius: (_at: THREE.Vector3, px: number) => px * 0.1,
  camera: new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 5000), pointer: new THREE.Vector2(),
  renderer: { domElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } },
  attachGizmo(obj: THREE.Object3D, kind: string, idx: number) { this.gizmoKind = kind; this.gizmoKnot = idx; this.gizmo.object = obj; },
  detachGizmo() { this.gizmoKind = null; this.gizmo.object = null; },
};
const layer = createTrailToolLayer(stage as unknown as Stage, () => new THREE.Mesh(), () => null);
let transform: TrailTransform | null = null;
layer.setHost({ append() {}, select() {}, transform: xf => { transform = xf; } });

const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const knots: V3[] = [[0, 0, 0], [0, 0, 100], [50, 10, 150]];
const handles: (PathHandles | null)[] = [null, { out: [10, 0, 20] }];
const pivot: V3 = [10, 2, 60];

const shape = { paths: [{ nodes: [0, 1, 2], handles }] };
layer.setKnots(knots, null, pivot, shape);
const anchor = stage.gizmo.object!;
check(stage.gizmoKind === 'trail' && near(anchor.position.toArray(), [10, 2, -60]),
  'seat: the whole-trail gizmo sits at the pivot, in the mirrored scene root');
layer.setKnots(knots, 1, pivot, shape);
check(stage.gizmoKind === 'trailknot', 'seat: a picked knot takes the gizmo');
layer.setKnots(knots, null, null, shape);
check(stage.gizmoKind === null, 'seat: no pivot, no whole-trail gizmo');
layer.setKnots(knots, null, pivot, shape);

/** One drag: freeze, pose the anchor as TransformControls would, report, release — and the knots and handles
 *  taken through the reported transform, as the host takes them. */
function drag(pose: (obj: THREE.Object3D) => void): { knots: V3[]; handles: (PathHandles | null)[] } {
  transform = null;
  stage.gizmo.dragging = true;
  layer.wholeDragging(true);
  pose(anchor);
  layer.wholeChanged();
  const xf = transform as TrailTransform | null;
  layer.wholeDragging(false);
  stage.gizmo.dragging = false;
  return {
    knots: knots.map(k => xf!.point(k)),
    handles: handles.map(own => own ? { ...(own.out ? { out: xf!.vector(own.out) } : {}) } : null),
  };
}

// Move: a scene-space drag of (+5, +1, +8) is data (+5, +1, −8) for every knot; handles are offsets and stay.
{
  const out = drag(obj => obj.position.add(new THREE.Vector3(5, 1, 8)));
  check(out.knots.every((k, i) => near(k, [knots[i][0] + 5, knots[i][1] + 1, knots[i][2] - 8])),
    'move: every knot moves by the drag, Z mirrored back to data', JSON.stringify(out.knots));
  check(out.handles[0] === null && near(out.handles[1]!.out!, [10, 0, 20]), 'move: a dragged handle travels with its knot unchanged');
  check(anchor.quaternion.equals(new THREE.Quaternion()) && anchor.scale.equals(new THREE.Vector3(1, 1, 1)),
    'release: the anchor is squared up for the next drag');
}

// Rotate: a quarter turn about the vertical keeps every knot's distance from the pivot, keeps heights, and turns
// a dragged handle by the same angle.
{
  anchor.position.set(pivot[0], pivot[1], -pivot[2]);
  const out = drag(obj => obj.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
  const plan = (p: readonly number[]) => Math.hypot(p[0] - pivot[0], p[2] - pivot[2]);
  check(out.knots.every((k, i) => Math.abs(plan(k) - plan(knots[i])) < 1e-9 && Math.abs(k[1] - knots[i][1]) < 1e-9),
    'rotate: every knot keeps its plan distance from the pivot and its height');
  const before = Math.atan2(knots[0][2] - pivot[2], knots[0][0] - pivot[0]);
  const after = Math.atan2(out.knots[0][2] - pivot[2], out.knots[0][0] - pivot[0]);
  const turned = Math.abs(Math.abs(((after - before + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) - Math.PI);
  check(Math.abs(turned - Math.PI / 2) < 1e-9, 'rotate: a quarter turn turns the trail a quarter', `${turned}`);
  const h = out.handles[1]!.out!;
  check(Math.abs(Math.hypot(h[0], h[2]) - Math.hypot(10, 20)) < 1e-9 && !near(h, [10, 0, 20], 1e-3),
    'rotate: a dragged handle turns with its knot, keeping its length');
}

// Scale: doubling X stretches every knot's X offset from the pivot and every handle's X.
{
  anchor.position.set(pivot[0], pivot[1], -pivot[2]);
  const out = drag(obj => obj.scale.set(2, 1, 1));
  check(out.knots.every((k, i) => near(k, [pivot[0] + (knots[i][0] - pivot[0]) * 2, knots[i][1], knots[i][2]])),
    'scale: knots stretch about the pivot on the scaled axis only');
  check(near(out.handles[1]!.out!, [20, 0, 20]), 'scale: a dragged handle stretches with them');
}

// Snapping: a dragged point lands on a point it overlaps on screen, however far apart the two are in depth.
{
  stage.camera.position.set(0, 400, 0);
  stage.camera.up.set(0, 0, -1);
  stage.camera.lookAt(0, 0, 0);
  stage.camera.updateMatrixWorld();
  const target: V3 = [0, 0, 0];
  layer.setKnots(knots, 1, null, { ...shape, dragSnaps: [target] });
  stage.gizmo.dragging = true;
  check(near(layer.snapDrag([0, 200, 0]), target), 'snap: a point 200 m above another, overlapping it down the view, lands on it');
  check(near(layer.snapDrag([40, 0, 0]), [40, 0, 0]), 'snap: one level with it but apart on screen does not');
  stage.gizmo.dragging = false;
  layer.knotDragging(false);
}

if (failures) process.exitCode = 1;
