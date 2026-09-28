// tier: fast

// VR editing's hands (docs/068), checked without a headset:
//  - the one-hand grab drags the map with the hand;
//  - the two-hand grab: pulling apart shrinks the player, twisting turns the map with the hands, moving together
//    drags it — and the pure pose math agrees with the three.js rig transform the session actually applies;
//  - turning about the head leaves the head where it was;
//  - the right-hand world mouse: the client pixel it sends the editor casts back, through the editor's own camera,
//    to the very point the controller is aimed at; buttons map to the mouse events a real mouse would send, and
//    putting the mouse away mid-press releases without clicking;
//  - the hand's depth on a held gizmo translate: pushed out along the laser with distance-scaled gain, masked to
//    the grabbed handle and snapped as TransformControls does.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  rigToWorld, solveOneHandGrab, solveTwoHandGrab, turnRigAbout, XR_EDIT_MAX_SCALE, XR_EDIT_ZOOM_EXPONENT,
  type RigPose, type Vec3,
} from '../src/app/ride/xr/world-grab';
import { createXrWorldPointer } from '../src/app/ride/xr/world-pointer';
import { beginHandGrab, handGrabPoint, handTranslateTarget, XR_HAND_DEPTH_REACH } from '../src/app/ride/xr/hand-drag';
import { correctXrUnionForScale } from '../src/app/ride/xr/scaled-camera';

const near = (a: Vec3, b: Vec3, what: string, eps = 1e-9) =>
  assert(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < eps, `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

// ---- the pure pose math is the rig's transform
{
  const pose: RigPose = { x: 3, y: -2, z: 7, yaw: 0.8, scale: 2.5 };
  const rig = new THREE.Object3D();
  rig.position.set(pose.x, pose.y, pose.z);
  rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw);
  rig.scale.setScalar(pose.scale);
  rig.updateMatrixWorld(true);
  const local = new THREE.Vector3(0.4, 1.6, -0.3);
  near(rigToWorld(pose, local), local.clone().applyMatrix4(rig.matrixWorld), 'rigToWorld is the rig Object3D transform');
}

const start: RigPose = { x: 10, y: 5, z: -4, yaw: 0.3, scale: 1 };
const a0 = v(-0.2, 1.2, -0.4), b0 = v(0.2, 1.2, -0.4);
const grab = { pose: start, a: a0, b: b0 };

// ---- holding still changes nothing
{
  const pose = solveTwoHandGrab(grab, a0, b0);
  near(pose, start, 'still hands leave the rig where it was');
  assert(Math.abs(pose.yaw - start.yaw) < 1e-12 && pose.scale === start.scale);
}

// ---- pan: both hands move together, the world under them moves with them
{
  const shift = v(0.15, -0.1, 0.05);
  const a = v(a0.x + shift.x, a0.y + shift.y, a0.z + shift.z), b = v(b0.x + shift.x, b0.y + shift.y, b0.z + shift.z);
  const pose = solveTwoHandGrab(grab, a, b);
  near(rigToWorld(pose, a), rigToWorld(start, a0), 'the world point in the left hand stays in it');
  near(rigToWorld(pose, b), rigToWorld(start, b0), 'and the right');
  assert.equal(pose.scale, 1, 'a parallel move does not resize');
}

// ---- one grip: the world point in the hand stays in it, at the size and heading the map already had
{
  const hold = { pose: { ...start, scale: 3, yaw: 0.9 }, hand: v(0.2, 1.1, -0.3) };
  const moved = v(0.5, 0.8, -0.1);
  const pose = solveOneHandGrab(hold, moved);
  near(rigToWorld(pose, moved), rigToWorld(hold.pose, hold.hand), 'the world point in the hand follows it, up and down too');
  assert(pose.scale === 3 && pose.yaw === 0.9, 'one hand drags; it neither zooms nor turns');
  near(solveOneHandGrab(hold, hold.hand), hold.pose, 'a still hand leaves the map where it was');
}

// ---- rotate: the pair turns about its midpoint, the map turns with it
{
  const mid = v(0, 1.2, -0.4), turn = 0.7;
  const spin = (p: Vec3) => {
    const dx = p.x - mid.x, dz = p.z - mid.z, c = Math.cos(turn), s = Math.sin(turn);
    return v(mid.x + dx * c + dz * s, p.y, mid.z - dx * s + dz * c);
  };
  const a = spin(a0), b = spin(b0);
  const pose = solveTwoHandGrab(grab, a, b);
  near(rigToWorld(pose, a), rigToWorld(start, a0), 'turning the hands carries the grabbed point round with them');
  near(rigToWorld(pose, b), rigToWorld(start, b0), 'both hands stay on their points');
  assert(Math.abs(pose.yaw - (start.yaw - turn)) < 1e-9, 'the rig turns opposite to the hands, so the map follows them');
}

// ---- zoom: apart is SMALLER (zoom in, the map stretched out between the hands), together bigger; the point
//      between the hands stays between them
{
  const a = v(-0.4, 1.2, -0.4), b = v(0.4, 1.2, -0.4); // spread doubled
  const pose = solveTwoHandGrab(grab, a, b);
  assert(Math.abs(pose.scale - 2 ** -XR_EDIT_ZOOM_EXPONENT) < 1e-9,
    `doubling the spread shrinks the player to 1/${2 ** XR_EDIT_ZOOM_EXPONENT}`);
  near(rigToWorld(pose, v(0, 1.2, -0.4)), rigToWorld(start, v(0, 1.2, -0.4)), 'the midpoint is the pivot of the resize');
  const bigger = solveTwoHandGrab(grab, v(-0.1, 1.2, -0.4), v(0.1, 1.2, -0.4));
  assert(bigger.scale > 1, 'bringing the hands together grows the player (zoom out)');
  const huge = solveTwoHandGrab({ pose: { ...start, scale: 900 }, a: a0, b: b0 }, v(-0.02, 1.2, -0.4), v(0.02, 1.2, -0.4));
  assert.equal(huge.scale, XR_EDIT_MAX_SCALE, 'size is clamped');
}

// ---- smooth turn pivots on the head
{
  const pose: RigPose = { x: 1, y: 2, z: 3, yaw: -0.4, scale: 3 };
  const headLocal = v(0.3, 1.7, 0.2);
  const head = rigToWorld(pose, headLocal);
  const turned = turnRigAbout(pose, head, 0.5);
  near(rigToWorld(turned, headLocal), head, 'a stick turn rotates the world about the eyes, not the play-space origin');
  assert(Math.abs(turned.yaw - (pose.yaw + 0.5)) < 1e-12);
}

// ---- the world mouse
{
  // Just enough DOM for a canvas that records what it is sent. Its own setPointerCapture throws, as a browser
  // does for a pointer it is not tracking — which is what the pointer's capture shim is for.
  class TestEvent extends Event {
    constructor(type: string, init: Record<string, unknown> = {}) {
      super(type, init);
      // Event's own flags (bubbles, cancelable, composed) are getters it already took from `init`.
      for (const [key, value] of Object.entries(init)) if (!(key in Event.prototype)) Object.assign(this, { [key]: value });
    }
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.window ??= globalThis;
  g.MouseEvent ??= TestEvent;
  g.PointerEvent ??= TestEvent;
  const events: { type: string; clientX: number; clientY: number; button: number; buttons: number }[] = [];
  let captureThrew = false;
  class Canvas {
    getBoundingClientRect() { return { left: 40, top: 30, width: 800, height: 600 }; }
    setPointerCapture(_id: number) { throw new Error('NotFoundError'); }
    releasePointerCapture(_id: number) { throw new Error('NotFoundError'); }
    dispatchEvent(event: Event) {
      events.push(event as unknown as (typeof events)[number]);
      if (event.type === 'pointerdown') { try { this.setPointerCapture(1); } catch { captureThrew = true; } }
      return true;
    }
  }
  const canvas = new Canvas();
  const camera = new THREE.PerspectiveCamera(70, 800 / 600, 0.1, 4000);
  camera.position.set(0, 12, 20);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointer = createXrWorldPointer({
    canvas: canvas as unknown as HTMLCanvasElement,
    camera: () => camera,
    surfaceHit: ray => ray.intersectPlane(ground, new THREE.Vector3()),
  });
  // The hand is below and right of the eyes, aimed at a spot on the ground.
  const target = new THREE.Vector3(3, 0, 2);
  const hand = new THREE.Vector3(0.35, 11.4, 19.6);
  const ray = new THREE.Ray(hand, target.clone().sub(hand).normalize());

  pointer.update(ray, false, false, 1000);
  assert.deepEqual(events.map(e => e.type), ['pointerover', 'pointerenter', 'pointermove', 'mousemove'],
    'the cursor arrives on the canvas like a mouse does');
  assert(pointer.onCanvas && pointer.onSurface);
  near(pointer.point, target, 'the cursor is where the controller ray meets the mountain', 1e-6);
  // The editor casts from the pixel it was given: that ray must pass through the aimed-at point.
  const move = events[2];
  const ndc = new THREE.Vector2((move.clientX - 40) / 800 * 2 - 1, -((move.clientY - 30) / 600) * 2 + 1);
  const cast = new THREE.Raycaster();
  cast.setFromCamera(ndc, camera);
  near(cast.ray.intersectPlane(ground, new THREE.Vector3())!, target,
    "the editor's own pick ray from that pixel lands on the controller's point", 1e-4);

  events.length = 0;
  pointer.update(ray, true, false, 1000);
  assert.deepEqual(events.map(e => [e.type, e.button, e.buttons]), [['pointerdown', 0, 1], ['mousedown', 0, 1]],
    'the trigger is the left button');
  assert(!captureThrew, 'a router that captures the pointer on press does not throw on the synthetic one');
  assert.throws(() => canvas.setPointerCapture(1), 'the capture shim is gone once the dispatch is over');
  events.length = 0;
  pointer.update(ray, false, false, 1000);
  assert.deepEqual(events.map(e => e.type), ['pointerup', 'mouseup', 'click'], 'a release clicks');

  events.length = 0;
  pointer.update(ray, false, true, 1000);
  pointer.update(ray, false, false, 1000);
  assert.deepEqual(events.map(e => [e.type, e.button]),
    [['pointerdown', 2], ['mousedown', 2], ['pointerup', 2], ['mouseup', 2], ['contextmenu', 2]], 'A is the right button');

  events.length = 0;
  pointer.update(ray, true, false, 1000);
  pointer.reset();
  assert.deepEqual(events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'pointerout', 'pointerleave'],
    'putting the mouse away mid-press lets go without clicking whatever was under it');

  events.length = 0;
  const away = new THREE.Ray(hand, new THREE.Vector3(0, 0.2, 1).normalize()); // back over the shoulder, into the sky
  pointer.update(away, false, false, 1000);
  assert.equal(events.length, 0, 'a far point behind the eyes puts no cursor on the canvas');
  assert(!pointer.onCanvas);

  // While the hand drives a held gizmo drag itself, a move would have the gizmo put the anchor back on its plane.
  events.length = 0;
  pointer.update(ray, true, false, 1000);
  events.length = 0;
  const aside = new THREE.Ray(hand, new THREE.Vector3(-2, 0, 4).sub(hand).normalize());
  pointer.update(aside, true, false, 1000, true);
  assert.deepEqual(events.map(e => e.type), [], 'a held move sends nothing');
  assert(pointer.onCanvas && pointer.pressed, 'though the cursor is still tracked, and the press still held');
  pointer.update(aside, false, false, 1000, true);
  assert.deepEqual(events.map(e => e.type), ['pointerup', 'mouseup', 'click'], 'the release still lands, ending the drag');
}

// ---- the hand's depth on a held gizmo translate (hand-drag.ts)
{
  const origin = new THREE.Vector3(0, 1.4, 0), dir = new THREE.Vector3(0, 0, -1);
  const anchor = new THREE.Vector3(0.5, 1, -20);
  const grab = beginHandGrab(new THREE.Ray(origin, dir), anchor, new THREE.Quaternion());
  const at = (o: THREE.Vector3, d = dir, scale = 1) => handGrabPoint(grab, new THREE.Ray(o, d), scale, new THREE.Vector3());
  const start = origin.clone().addScaledVector(dir, grab.distance);
  near(at(origin), start, 'a still hand holds the point where it was grabbed');
  const reach = XR_HAND_DEPTH_REACH;
  near(at(origin.clone().addScaledVector(dir, reach)), origin.clone().addScaledVector(dir, 2 * grab.distance),
    'pushing the hand one reach out doubles the held distance from where the hand began', 1e-9);
  near(at(origin.clone().addScaledVector(dir, -reach)), origin,
    'pulling it one reach back brings the point to where the hand began', 1e-9);
  near(at(origin.clone().addScaledVector(dir, -2 * reach)), origin.clone().addScaledVector(dir, -2 * reach + 0.05),
    'and pulled further it stays just ahead of the hand', 1e-9);
  near(at(origin.clone().addScaledVector(dir, reach), dir, 100), origin.clone().addScaledVector(dir, reach + grab.distance),
    'a giant\'s reach is a giant\'s: the same push barely moves a point that is near at that size', 1e-9);
  const sideways = new THREE.Vector3(1, 0, 0);
  near(at(origin.clone().add(sideways)), start.clone().add(sideways), 'moving the hand across carries the point 1:1');
  const close = beginHandGrab(new THREE.Ray(origin, dir), new THREE.Vector3(0, 1.4, -0.2), new THREE.Quaternion());
  near(handGrabPoint(close, new THREE.Ray(origin.clone().setZ(-0.1), dir), 1, new THREE.Vector3()), v(0, 1.4, -0.3),
    'near the hand the push is 1:1, never less');

  // Masked to the grabbed handle, the way TransformControls masks a mouse drag.
  const delta = new THREE.Vector3(1, 2, -3), out = new THREE.Vector3();
  near(handTranslateTarget(grab, delta, 'X', 'world', null, out), v(1.5, 1, -20), 'an X arrow moves along X only');
  near(handTranslateTarget(grab, delta, 'XZ', 'world', null, out), v(1.5, 1, -23), 'the XZ square stays level');
  near(handTranslateTarget(grab, delta, 'XYZ', 'world', null, out), v(1.5, 3, -23), 'the free centre goes anywhere');
  const tilted = beginHandGrab(new THREE.Ray(origin, dir), anchor,
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)); // local X is world Y
  near(handTranslateTarget(tilted, delta, 'X', 'local', null, out), v(0.5, 3, -20), 'a local arrow runs along its own axis');
  near(handTranslateTarget(tilted, delta, 'XYZ', 'local', null, out), v(1.5, 3, -23),
    'the free centre ignores a local frame, as the gizmo does');
  near(handTranslateTarget(grab, new THREE.Vector3(0.26, 0, 0), 'X', 'world', 0.5, out), v(1, 1, -20),
    'snapping rounds the moved axes of the world position');
}

// ---- culling a scaled rig: the stereo union must not cull what is right in front of a giant's eyes
{
  /** A headset-like stereo pair under a rig of the given size: eyes 64 mm apart at 1.6 m, ~100° per eye. */
  const pair = (scale: number) => {
    const rig = new THREE.Group();
    rig.position.set(120, 40, -300);
    rig.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    rig.scale.setScalar(scale);
    const view = new THREE.Group();
    rig.add(view);
    const eye = (x: number, inward: number, outward: number) => {
      const camera = new THREE.PerspectiveCamera();
      camera.matrix.makeTranslation(x, 1.6, 0);
      camera.matrixAutoUpdate = false;
      // Asymmetric like a real headset: more field outward than toward the nose.
      const near = 0.03;
      camera.projectionMatrix.makePerspective(
        x < 0 ? -outward * near : -inward * near, x < 0 ? inward * near : outward * near, 1.1 * near, -1.1 * near,
        near, 4000,
      );
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      return camera;
    };
    const left = eye(-0.032, 0.9, 1.3), right = eye(0.032, 0.9, 1.3);
    const user = new THREE.PerspectiveCamera();
    view.add(user);
    rig.updateMatrixWorld(true);
    for (const camera of [left, right]) camera.matrixWorld.multiplyMatrices(view.matrixWorld, camera.matrix);
    const union = new THREE.ArrayCamera([left, right]);
    return { rig, view, union, user };
  };
  const inView = (camera: THREE.Camera, local: THREE.Vector3, rig: THREE.Object3D) => new THREE.Frustum()
    .setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    .containsPoint(local.clone().applyMatrix4(rig.matrixWorld));

  const unit = pair(1);
  assert.equal(correctXrUnionForScale(unit.union, unit.user), false, 'a life-size rig is left to three');

  const reference = pair(1.00001); // just off 1, so the correction runs: the life-size union
  const giant = pair(100);
  assert(correctXrUnionForScale(reference.union, reference.user));
  assert(correctXrUnionForScale(giant.union, giant.user));
  const a = reference.union.projectionMatrix.elements, b = giant.union.projectionMatrix.elements;
  assert(a.every((value, i) => Math.abs(value - b[i]) < 1e-6 * Math.max(1, Math.abs(value))),
    "the union's projection is in the rig's units, so a giant culls exactly like a life-size rider");
  const seat = (p: ReturnType<typeof pair>) =>
    new THREE.Vector3().setFromMatrixPosition(p.union.matrixWorld).applyMatrix4(p.rig.matrixWorld.clone().invert());
  near(seat(giant), seat(reference), 'and it sits in the same place relative to the eyes', 1e-6);
  for (const [local, what] of [
    [new THREE.Vector3(0.15, 1.3, -0.35), 'the right hand held out'],
    [new THREE.Vector3(-0.1, 1.45, -0.25), 'the watch on the left wrist'],
    [new THREE.Vector3(0.1, 1.9, -0.6), 'the palette'],
    [new THREE.Vector3(0, 1.0, -0.7), 'the body in the lower field of view'],
  ] as const) {
    assert(inView(giant.union, local, giant.rig), `a 100× giant does not cull ${what}`);
  }
  assert(!inView(giant.union, new THREE.Vector3(0, 1.6, 2), giant.rig), 'what is behind the eyes is still culled');
  near(new THREE.Vector3().setFromMatrixPosition(giant.user.matrixWorld),
    new THREE.Vector3().setFromMatrixPosition(giant.union.matrixWorld), 'the user camera is re-seated on the corrected union');
  assert(giant.user.projectionMatrix.equals(giant.union.projectionMatrix), 'and carries its projection');
}

console.log('xr-edit-flight: ok');
