import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRideColliderOverlay, type RideProbePose } from '../src/app/viewport/scene/ride-collider-overlay';
import type { RideObstacleSource } from '../src/app/ride/physics';
import {
  BOARD_HALF_LENGTH, RIDER_BARRIER_PAD, RIDER_BODY_R, RIDER_BODY_Y, RIDER_HEAD_Y, RIDER_SHOULDER_R,
} from '../src/app/ride/physics-tuning';

/**
 * Test mode's collider overlay (docs/016). What it is FOR is explaining a contact that did or didn't happen, so
 * the checks below are about the two things that make it trustworthy: the rider half must be the same volume the
 * contact solver uses, and the two prop classes must stay visually apart.
 */

function pose(x = 0, y = 0, z = 0): RideProbePose {
  return {
    pos: new THREE.Vector3(x, y, z),
    fwd: new THREE.Vector3(0, 0, 1),
    boardUp: new THREE.Vector3(0, 1, 0),
  };
}

function boxSource(key: string, centre: THREE.Vector3, size: THREE.Vector3, solid: boolean): RideObstacleSource {
  return {
    key, object: { kind: 'authored', id: key },
    geometry: new THREE.BoxGeometry(1, 1, 1), nativeBox: true,
    matrixWorld: new THREE.Matrix4().compose(centre, new THREE.Quaternion(), size),
    solid, bounce: solid ? 0.5 : 0, surface: -1,
  };
}

/** World-space bounds of every line vertex under `root`, which is what the overlay actually draws. */
function drawnBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.traverse(object => {
    if (!(object instanceof THREE.LineSegments)) return;
    const position = object.geometry.getAttribute('position');
    const vertex = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) box.expandByPoint(vertex.fromBufferAttribute(position, i));
  });
  return box;
}

function lineCount(root: THREE.Object3D): number {
  let count = 0;
  root.traverse(object => { if (object instanceof THREE.LineSegments) count++; });
  return count;
}

// ---------------------------------------------------------------------------

{
  const parent = new THREE.Group();
  const overlay = createRideColliderOverlay(parent);
  assert.equal(overlay.visible, false, 'the overlay starts off — it is a diagnostic, not a view setting');
  assert.equal(overlay.group.visible, false);

  overlay.setSources([
    boxSource('near-solid', new THREE.Vector3(0, 1, 6), new THREE.Vector3(2, 2, 2), true),
    boxSource('near-through', new THREE.Vector3(6, 1, 0), new THREE.Vector3(2, 2, 2), false),
    boxSource('far', new THREE.Vector3(0, 1, 900), new THREE.Vector3(2, 2, 2), true),
  ]);
  overlay.update(pose());
  assert.equal(lineCount(overlay.group), 0, 'nothing is built while the toggle is off, however many sources it holds');

  overlay.setVisible(true);
  overlay.update(pose());
  assert.ok(overlay.group.visible);

  const groups = overlay.group.children as THREE.Group[];
  const world = groups[0], rider = groups[1];
  assert.equal(lineCount(world), 2, 'solid and pass-through props are drawn as two buffers, so they read apart');

  const worldBounds = drawnBounds(world);
  assert.ok(worldBounds.max.z < 100, 'a prop 900 m away is not gathered — the overlay follows the rider');
  assert.ok(worldBounds.max.z > 6.9 && worldBounds.max.x > 6.9,
    'both nearby props are, and as their WORLD bounds rather than the shared unit box they are posed from');

  // The rider half is the load-bearing one: it has to be the volume that actually collides. It is drawn as two
  // buffers — the sample marks, then the body sphere on its own colour, because that sphere is the whole story
  // for a bounding box and needs to be findable by eye.
  assert.equal(lineCount(rider), 2, 'the body sphere is its own buffer, so it reads apart from the samples');
  const marks = drawnBounds(rider.children[0]), body = drawnBounds(rider.children[1]);
  assert.ok(Math.abs(body.max.y - (RIDER_BODY_Y + RIDER_BODY_R)) < 1e-3,
    'the drawn body sphere reaches exactly the top of the sphere a bounding box is tested against');
  assert.ok(Math.abs(body.min.y - (RIDER_BODY_Y - RIDER_BODY_R)) < 1e-3, '...and its bottom');
  assert.ok(Math.abs(body.max.x - RIDER_BODY_R) < 1e-3 && Math.abs(body.max.z - RIDER_BODY_R) < 1e-3,
    '...and its radius on both horizontal axes, centred on the rider');
  assert.ok(Math.abs(marks.max.z - BOARD_HALF_LENGTH) < 1e-6,
    'the deck footprint is drawn at its real half-length — nothing reaches further along the board');
  assert.ok(Math.abs(marks.max.x - (RIDER_SHOULDER_R + RIDER_BARRIER_PAD)) < 1e-6,
    'and the widest mark across is the shoulder sample, which is wider than the deck');
  assert.ok(marks.max.y > RIDER_HEAD_Y - 0.1 && marks.max.y < RIDER_HEAD_Y + 0.2,
    'the head sample is drawn as a mark at head height, not as a body reaching up to it');

  overlay.setVisible(false);
  assert.equal(lineCount(overlay.group), 0, 'switching it off frees its buffers rather than just hiding them');
  overlay.dispose();
  assert.equal(parent.children.length, 0, 'disposal detaches the overlay from the scene');
}

{
  // Following the rider: the world half is gathered around a position and re-gathered once they leave it.
  const overlay = createRideColliderOverlay(new THREE.Group());
  overlay.setVisible(true);
  overlay.setSources([
    boxSource('start', new THREE.Vector3(0, 1, 0), new THREE.Vector3(2, 2, 2), true),
    boxSource('down-the-hill', new THREE.Vector3(0, 1, 200), new THREE.Vector3(2, 2, 2), true),
  ]);
  overlay.update(pose());
  let bounds = drawnBounds(overlay.group.children[0]);
  assert.ok(bounds.max.z < 100, 'the far prop is out of range at the start');

  overlay.update(pose(0, 0, 200));
  bounds = drawnBounds(overlay.group.children[0]);
  assert.ok(bounds.min.z > 100, 'riding down to it re-gathers around the new position');
  assert.ok(bounds.max.z > 198, 'and the prop that is now near is the one drawn');
  overlay.dispose();
}

{
  // A mode-3 body is drawn from its packed leaves, transformed by the placement — not as a box around them.
  const overlay = createRideColliderOverlay(new THREE.Group());
  overlay.setVisible(true);
  overlay.setSources([{
    key: 'body', object: { kind: 'reference', index: 3 },
    spheres: new Float32Array([0, 0, 0, 1, 0, 0, 4, 1]),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, 2, 0),
    solid: true, bounce: 0.5, surface: -1,
  }]);
  overlay.update(pose());
  const bounds = drawnBounds(overlay.group.children[0]);
  assert.ok(Math.abs(bounds.min.y - 1) < 1e-3 && Math.abs(bounds.max.y - 3) < 1e-3,
    'a leaf sphere is drawn at its own radius, in the placement’s world frame');
  // The wire circles are sampled, so an extreme lands just inside the true radius; 4.97 of a possible 5 is
  // the second leaf being drawn, not the first one stretched.
  assert.ok(bounds.max.z > 4.9 && bounds.max.z <= 5.001,
    'and every leaf of the body is drawn, not just the first');
  overlay.dispose();
}

console.log('ride-collider-overlay ok');
