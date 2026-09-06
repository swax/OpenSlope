// tier: fast

/**
 * The ride's range gate (viewport/scene/range-cull): the distance bound frustum culling cannot supply,
 * because at a start gate the whole fall line is inside the frustum. What has to hold: cells and prop slots
 * beyond the range stop drawing, the cell under your board never does, leaving the ride restores exactly
 * what the gate hid and nothing else, and the pass is not re-run for every step the viewer takes.
 */
import * as THREE from 'three';
import { createRangeCull } from '../src/app/viewport/scene/range-cull';
import { check, failures } from './check';

/** A stand-in for one quilt cell: the real ones carry an explicit bounding sphere for exactly this reason. */
function chunk(centre: [number, number, number], radius: number): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(...centre), radius);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

/** A batch of one-triangle props at the given x positions, addressable per slot like the real prop draws. */
function batch(xs: number[]): THREE.BatchedMesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  const mesh = new THREE.BatchedMesh(xs.length, 3 * xs.length, 3 * xs.length, new THREE.MeshBasicMaterial());
  const geometryId = mesh.addGeometry(geometry);
  const matrix = new THREE.Matrix4();
  for (const x of xs) {
    const id = mesh.addInstance(geometryId);
    mesh.setMatrixAt(id, matrix.makeTranslation(x, 0, 0));
  }
  return mesh;
}

const scene = new THREE.Scene();
const root = new THREE.Group();
scene.add(root);
const near = chunk([0, 0, 0], 50);          // under the viewer
const far = chunk([500, 0, 0], 50);         // clear of the range
const wide = chunk([300, 0, 0], 150);       // centre beyond the range, near edge inside it
const props = batch([0, 100, 300, 1000]);
for (const object of [near, far, wide, props]) root.add(object);
root.updateMatrixWorld(true);

const fogColor = new THREE.Color(0x334455);
const cull = createRangeCull({
  scene,
  chunks: () => [near, far, wide],
  propMeshes: () => [props as never],
  fogColor: () => fogColor,
});

const eye = new THREE.Vector3();
const visibleSlots = () => [0, 1, 2, 3].filter(i => props.getVisibleAt(i));

// ---- off is off: an editor view is unbounded, and the gate must cost it nothing ----
cull.update(eye);
check(scene.fog === null && near.visible && far.visible && visibleSlots().length === 4,
  'an unarmed gate draws everything and hangs no fog');

// ---- armed ----
cull.setRange(200);
cull.update(eye);
check(near.visible && !far.visible,
  'a cell beyond the range stops drawing, the one under the viewer keeps drawing');
check(wide.visible,
  'a cell whose CENTRE is out of range but whose near edge is inside it keeps drawing');
check(visibleSlots().join(',') === '0,1',
  'prop slots beyond the range stop drawing, slot by slot');
check(scene.fog instanceof THREE.Fog && (scene.fog as THREE.Fog).far === 200
  && (scene.fog as THREE.Fog).near === 150
  && (scene.fog as THREE.Fog).color.getHex() === fogColor.getHex(),
  'a range too short to reach the 300 m haze start keeps a 50 m band off its far plane, in the sky\'s own horizon colour');

// A sky replacement is asynchronous: switching from the authored MESA world to reference GARI can finish
// after this range was armed. The range stays the same, but its fog must adopt the newly loaded horizon.
const fogInstanceAtLoad = scene.fog;
fogColor.set(0x8899aa);
cull.refreshFogColor();
check(scene.fog === fogInstanceAtLoad && (scene.fog as THREE.Fog).color.getHex() === fogColor.getHex(),
  'a newly loaded active sky refreshes the existing fog colour without changing the range');
const stats = cull.stats();
check(stats.range === 200 && stats.chunks === 3 && stats.chunksDrawn === 2
  && stats.slots === 4 && stats.slotsDrawn === 2,
  `the census reports ${stats.chunksDrawn}/${stats.chunks} cells and ${stats.slotsDrawn}/${stats.slots} slots drawn`);

// ---- the pass is movement-gated, not per-frame ----
const fogInstance = scene.fog;
eye.set(10, 0, 0);
cull.update(eye);
check(visibleSlots().join(',') === '0,1',
  'a step shorter than the recheck distance does not re-run the pass');
// 450 m along: the near cell is 400 m behind its own edge, the far one is now underfoot, and of the props
// only the slot at 300 is inside 200 m.
eye.set(450, 0, 0);
cull.update(eye);
check(visibleSlots().join(',') === '2' && !near.visible && far.visible,
  'travelling re-gates: what fell behind drops, what you have reached comes back');

// ---- the gate owns only what it hid ----
props.setVisibleAt(2, false);   // stand in for a graph hiding a prop while it is well inside the range
eye.set(480, 0, 0);
cull.update(eye);
check(!props.getVisibleAt(2),
  'a slot hidden by something else stays hidden when the gate re-gates it in range');

cull.setRange(600);
check(scene.fog === fogInstance && (scene.fog as THREE.Fog).far === 600,
  'changing the range moves the existing fog rather than replacing it (a swap recompiles every material)');
// 600 m is the tier a headset rides at and the Unity culler's Quest range; both ports must haze it the same.
check((scene.fog as THREE.Fog).near === 300,
  'the haze starts at a fixed 300 m, so widening the range moves its far edge and not its beginning');
cull.update(eye);
check(props.getVisibleAt(3) && !props.getVisibleAt(2),
  'a wider range re-admits the slots the gate dropped, and still not the one it never hid');

// ---- leaving the ride ----
cull.setRange(null);
check(near.visible && far.visible && wide.visible && scene.fog === null,
  'turning the gate off re-shows every cell and drops the fog');
check(visibleSlots().join(',') === '0,1,3',
  'and re-shows exactly the slots it hid — slot 2 was hidden by someone else and stays that way');

// ---- the reference root is offset and Z-flipped; a reflection preserves distance, so the gate is exact ----
const flipped = new THREE.Group();
flipped.position.set(2000, 0, 0);
flipped.scale.set(1, 1, -1);
scene.add(flipped);
const inFlipped = chunk([0, 0, 300], 10);   // world (2000, 0, -300)
flipped.add(inFlipped);
flipped.updateMatrixWorld(true);
const flippedCull = createRangeCull({
  scene, chunks: () => [inFlipped], propMeshes: () => [], fogColor: () => null,
});
flippedCull.setRange(200);
flippedCull.update(new THREE.Vector3(2000, 0, -300));
check(inFlipped.visible, 'a cell under a reflected, offset root is measured at its true world position');
flippedCull.update(new THREE.Vector3(2000, 0, 300));   // 600 m away through the flip, not 0
check(!inFlipped.visible, 'and the mirrored position 600 m away is correctly out of range');

if (failures) process.exitCode = 1;
else console.log('RANGE CULL TESTS PASSED');
