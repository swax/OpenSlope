// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Stage } from '../src/app/viewport/stage';
import type { TreeGeometry } from '../src/app/viewport/mesh/surface-trees';

for (const ortho of [false, true]) {
  const camera = ortho
    ? new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1000)
    : new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000);
  camera.position.set(0, 100, 120);
  camera.lookAt(0, 5, 0);
  camera.updateMatrixWorld(true);
  const root = new THREE.Group();
  root.scale.z = -1;
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80, 64, 64).rotateX(-Math.PI / 2), material);
  const reference = new THREE.Mesh(ground.geometry.clone(), material);
  reference.position.y = 20;
  root.add(ground, reference);
  root.updateMatrixWorld(true);
  const stage = Object.assign(Object.create(Stage.prototype) as object, {
    camera,
    ray: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    pickLocalRay: new THREE.Ray(),
    pickInv: new THREE.Matrix4(),
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) } },
    pickTargets: () => [ground, reference],
  }) as unknown as Stage;
  const cursor = { clientX: 400, clientY: 300 };
  stage.castAt(cursor);
  const expected = stage.ray.intersectObjects([ground, reference], false)[0];
  assert.equal(expected.object, reference, 'navigation chooses the nearest mountain, not the first target');
  // A navigation gesture must never fall back to a full terrain triangle walk.
  ground.raycast = reference.raycast = () => {
    throw new Error('linear terrain raycast');
  };
  const pivot = stage.pivotAt(cursor);
  assert(pivot && pivot.distanceTo(expected.point) < 1e-5, 'both camera projections retain the cursor anchor');
  const tree = (reference.geometry as TreeGeometry).pickBVH;
  assert(tree, 'the first cast builds a tree for each surface');
  for (let tick = 0; tick < 20; tick++) {
    const next = stage.pivotAt(cursor);
    assert(next && next.distanceTo(expected.point) < 1e-5);
    assert.equal((reference.geometry as TreeGeometry).pickBVH, tree, 'wheel ticks reuse the surface tree');
  }
  // Hiding a reference patch replaces the index; navigation must follow the replacement too.
  reference.geometry.setIndex([]);
  const uncovered = stage.pivotAt(cursor);
  assert(uncovered && Math.abs(uncovered.y) < 1e-5, 'an empty reference no longer intercepts the authored ground');
  stage.pickTargets = () => [];
  assert.equal(stage.pivotAt(cursor), null, 'off-surface navigation keeps its existing ray-point fallback');
  ground.geometry.dispose();
  reference.geometry.dispose();
  material.dispose();
}
console.log('Navigation picking: nearest mirrored terrain, both projections, cached trees and hidden patches: PASS');
