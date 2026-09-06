import assert from 'node:assert/strict';
import * as THREE from 'three';
import { sphereVsNativeBox, sweptSphereVsNativeBox } from '../src/core/collision/native-box';
import {
  createRideModel, groundRestDepth, SURFACE_ROWS,
  type RideObstacleHit, type RideObstacleSource,
} from '../src/app/ride/physics';
import {
  BOARD_COLLISION_Y, BOARD_HALF_LENGTH, RIDER_BODY_R, RIDER_BODY_Y, RIDER_HEAD_Y,
} from '../src/app/ride/physics-tuning';

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };

// ---------------------------------------------------------------------------
// The native mode-2 law [Trailmap: 370-sphere-box]. Every case below is about the SHAPE the engine admits,
// which is the box grown by one radius across each FACE and left square at the edges and corners.
// ---------------------------------------------------------------------------

const min = { x: -1, y: -1, z: -1 }, max = { x: 1, y: 1, z: 1 };

{
  const inside = sphereVsNativeBox(min, max, { x: 0, y: 0.6, z: 0 }, 0.25);
  assert.ok(inside, 'a centre inside the box always contacts');
  assert.deepEqual(inside.normal, { x: 0, y: 1, z: 0 },
    'the answering face is the nearest one, reported as its outward axis');
  assert.ok(Math.abs(inside.depth - 0.65) < 1e-9,
    'depth is the radius plus the inward distance from that face');
  assert.ok(Math.abs(inside.point.y - 1) < 1e-9 && Math.abs(inside.point.x) < 1e-9,
    'the contact point is the centre projected onto the answering face plane');
}

{
  // Across a face: the centre is outside on x only, and inside both perpendicular slabs.
  assert.ok(sphereVsNativeBox(min, max, { x: 1.2, y: 0, z: 0 }, 0.3),
    'a sphere reaching across a face contacts, inflated by its radius on that axis');
  assert.equal(sphereVsNativeBox(min, max, { x: 1.4, y: 0, z: 0 }, 0.3), null,
    'and stops contacting once the gap exceeds the radius');
}

{
  // The load-bearing negative: a sphere that overlaps only a VERTEX. Its centre is 0.17 from the corner, well
  // inside a 0.3 radius, so a true sphere/box overlap would report a hit here and the engine does not.
  const corner = sphereVsNativeBox(min, max, { x: 1.1, y: 1.1, z: 1.1 }, 0.3);
  assert.equal(corner, null, 'a corner overlap registers nothing: the admitted region is square at the vertices');
  const edge = sphereVsNativeBox(min, max, { x: 1.1, y: 1.1, z: 0 }, 0.3);
  assert.equal(edge, null, 'and square along the edges, for the same reason — two slab gates cannot both pass');
  assert.ok(sphereVsNativeBox(min, max, { x: 1.1, y: 0.99, z: 0 }, 0.3),
    'sliding the same sphere just inside one slab restores the face contact, so the gate is the centre');
}

// ---------------------------------------------------------------------------
// The swept form. It must change WHEN a contact is found, never WHICH contacts exist.
// ---------------------------------------------------------------------------

{
  const swept = sweptSphereVsNativeBox(min, max, { x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.25);
  assert.ok(swept, 'a sphere driven through a face is caught');
  // Entry is where the centre reaches min.x − r = −1.25, i.e. 2.75 along an 8-unit move.
  assert.ok(Math.abs(swept.u - 2.75 / 8) < 1e-6, 'the entry parameter is the exact face-crossing moment');
  assert.deepEqual(swept.contact.normal, { x: -1, y: 0, z: 0 }, 'and the entered face answers');
}

{
  // A single enormous step: a static per-tick test would sample past the box and miss it entirely.
  const far = sweptSphereVsNativeBox(min, max, { x: -400, y: 0, z: 0 }, { x: 400, y: 0, z: 0 }, 0.25);
  assert.ok(far, 'a step long enough to tunnel a static test still reports its entry');
  assert.ok(far.u > 0 && far.u < 0.5, 'at a parameter inside the move rather than at either end');
}

{
  const grazing = sweptSphereVsNativeBox(min, max,
    { x: -4, y: 1.1, z: 1.1 }, { x: 4, y: 1.1, z: 1.1 }, 0.3);
  assert.equal(grazing, null, 'a path that only skims an edge sweeps through it, exactly as the static test says');
}

{
  const started = sweptSphereVsNativeBox(min, max, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 4 }, 0.25);
  assert.ok(started && started.u === 0, 'a sweep that begins already inside reports contact at the start');
}

// ---------------------------------------------------------------------------
// The measured ALOHA case [Trailmap: 370-probe-worked]. Raw level space is Z-up and RAW_TO_EDITOR sends raw Z
// to editor Y, so the numbers below are the measured raw AABB and spline sample mapped into editor metres —
// getting that mapping wrong is what makes this box look like it sits ABOVE the rail when it hangs below it.
// ---------------------------------------------------------------------------

/** `Mdl_Jumbotron_Top_1003`, in editor metres: 12.54 × 7.58 × 7.55 around a 14.6 m zero-thickness panel. */
const jumbotron = {
  min: { x: 75.994, y: 528.636, z: -26.732 },
  max: { x: 88.535, y: 536.217, z: -19.180 },
};
/** The deepest sampled point of `Spline_RailMetalShowOff_1001` inside that box. */
const deepest = { x: 76.029, y: 528.685, z: -26.691 };

{
  const contact = sphereVsNativeBox(jumbotron.min, jumbotron.max, deepest, 0);
  assert.ok(contact, 'the spline really is inside the authored bounds — the overlap is not a measurement slip');
  assert.deepEqual(contact.normal, { x: -1, y: 0, z: 0 },
    'and it is inside by the plan-view corner, not by the face the rail runs under');

  // The corner it clips is the BOTTOM one: the box hangs 7.5 m above the rail line, so raising a sphere off the
  // deck does not leave it. This is the check that would have caught the up-axis error, and it is the reason the
  // spec records the rest of the account for this instance as open rather than settled.
  assert.ok(deepest.y - jumbotron.min.y < 0.05 && jumbotron.max.y - deepest.y > 7,
    'the rail clips the box near its underside, with metres of box above the rider');
  const body = sphereVsNativeBox(jumbotron.min, jumbotron.max,
    { ...deepest, y: deepest.y + RIDER_BODY_Y }, RIDER_BODY_R);
  assert.ok(body, 'so the body sphere raised off the deck is still inside this box at the sampled point');

  assert.ok(deepest.x - jumbotron.min.x < 0.04, 'the plan-view overlap is a few centimetres at one corner');

  // The reach either side of that face is exactly one radius and no more — the box is inflated by the sphere
  // across each face, so "outside" for a mode-2 contact means outside by more than RIDER_BODY_R.
  const justOutside = sphereVsNativeBox(jumbotron.min, jumbotron.max,
    { ...deepest, x: jumbotron.min.x - RIDER_BODY_R + 0.01, y: deepest.y + RIDER_BODY_Y }, RIDER_BODY_R);
  assert.ok(justOutside, 'a centre one radius shy of the face still contacts');
  const clear = sphereVsNativeBox(jumbotron.min, jumbotron.max,
    { ...deepest, x: jumbotron.min.x - RIDER_BODY_R - 0.01, y: deepest.y + RIDER_BODY_Y }, RIDER_BODY_R);
  assert.equal(clear, null, '...and a centre one radius past it does not');
}

// ---------------------------------------------------------------------------
// End to end through the ride model: a mode-2 box is answered by the body sphere and by nothing else.
// ---------------------------------------------------------------------------

function floorAt(y = 0): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -60, y, -60, -60, y, 60, 60, y, -60,
    60, y, -60, -60, y, 60, 60, y, 60,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** A native mode-2 instance: the shared unit box the scene poses, flagged so the ride keeps it a box. */
function nativeBox(centre: THREE.Vector3, size: THREE.Vector3, solid = true): RideObstacleSource {
  return {
    key: 'reference:box', object: { kind: 'reference', index: 0 },
    geometry: new THREE.BoxGeometry(1, 1, 1),
    nativeBox: true,
    matrixWorld: new THREE.Matrix4().compose(centre, new THREE.Quaternion(), size),
    solid, bounce: solid ? 0.5 : 0, playerBounce: solid, surface: -1,
  };
}

function rideInto(obstacle: RideObstacleSource, hits: RideObstacleHit[]) {
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [obstacle], oobFloorY: -100, keys, stick, drive: 0,
    onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 0);
  model.st.vel.set(0, 0, 12);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  for (let tick = 0; tick < 24; tick++) model.step(1 / 60);
  return model;
}

{
  // The measured radius is 0.85 m against a centre at 0.92, so the body sphere is a BALL around the whole
  // rider — reaching from just above the deck to over the head. "The deck has no say" therefore does NOT mean
  // low props are ignored: a knee-high slab is met by the ball rather than by the board's footprint.
  assert.ok(RIDER_BODY_Y - RIDER_BODY_R < 0.15,
    'the body sphere reaches down to about deck height, so nothing rides under it');
  assert.ok(RIDER_BODY_Y + RIDER_BODY_R > RIDER_HEAD_Y,
    '...and over the head, so nothing clears it above either');

  const hits: RideObstacleHit[] = [];
  rideInto(nativeBox(new THREE.Vector3(0, 0.15, 3), new THREE.Vector3(6, 0.3, 0.4)), hits);
  assert.ok(hits.length > 0, 'so a knee-high solid slab does contact');
  // ...and is answered by its TOP face, because that is the least-penetrating one for a ball whose centre
  // rides above the slab. The rider is lifted over the kerb rather than walled by it, which is the same
  // least-penetrating-axis rule the engine resolves on.
  assert.ok(hits[0].normal.y > 0.9,
    'and a low slab answers upward — the rider rides over it rather than being stopped by it');
}

{
  // Where the one sphere and a deck-sized volume genuinely differ is horizontal reach AT deck height, which
  // for a ball centred at the pelvis is much shorter than the board is long.
  const reachAtDeck = Math.sqrt(RIDER_BODY_R ** 2 - (RIDER_BODY_Y - BOARD_COLLISION_Y) ** 2);
  assert.ok(reachAtDeck < BOARD_HALF_LENGTH,
    `at deck height the sphere reaches ${reachAtDeck.toFixed(2)} m, short of the board's ` +
    `${BOARD_HALF_LENGTH} m half-length — so the nose and tail still lead the ball for proxies and bodies`);
}

{
  // The same slab raised to chest height is met by the body sphere and stops the rider.
  const hits: RideObstacleHit[] = [];
  const model = rideInto(nativeBox(new THREE.Vector3(0, RIDER_BODY_Y, 3), new THREE.Vector3(6, 0.6, 0.4)), hits);
  assert.ok(model.st.pos.z < 3.5, 'a box at body height is solid');
  assert.ok(hits.length > 0, 'and dispatches its contact for sound and effects');
  assert.ok(Math.abs(hits[0].normal.z + 1) < 1e-6,
    'the reported normal is the entered face axis, never an interpolated mesh normal');
}

{
  // Ride-through: contact is reported, motion is not changed.
  const hits: RideObstacleHit[] = [];
  const model = rideInto(
    nativeBox(new THREE.Vector3(0, RIDER_BODY_Y, 3), new THREE.Vector3(6, 0.6, 0.4), false), hits);
  assert.ok(model.st.pos.z > 3.5, 'a response-mass-zero box stays pass-through');
  assert.ok(hits.length > 0, 'while still dispatching the contact its effect and sound slots need');
}

{
  // The collider is ORIENTED with the placement [Trailmap: 130-mode2-oriented] — the model's own local box,
  // not the world AABB of the rotated result. This was read live out of a paused PCSX2 session: the box lives
  // on the MODEL record and two instances of the same model share it while carrying different rotations.
  //
  // A thin panel turned 45° is where the two readings differ most, so that is the fixture: the world AABB is a
  // wide diamond-shaped envelope and the real collider is the panel itself.
  // The panel is the line x + z = 4, eight metres long. Its world AABB is the diamond's envelope,
  // x and z both spanning ±2.83 about the centre — so the corner at (x −2.5, z 2) lies well inside the AABB
  // and nowhere near the panel.
  const panel = (): RideObstacleSource => ({
    key: 'reference:panel', object: { kind: 'reference', index: 5 },
    geometry: new THREE.BoxGeometry(8, 3, 0.1), nativeBox: true,
    matrixWorld: new THREE.Matrix4().compose(
      new THREE.Vector3(0, RIDER_BODY_Y, 4),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4),
      new THREE.Vector3(1, 1, 1)),
    solid: true, bounce: 0.5, playerBounce: true, surface: -1,
  });

  function rideAcross(from: THREE.Vector3, heading: THREE.Vector3, hits: RideObstacleHit[], ticks = 30) {
    const model = createRideModel({
      spawn: new THREE.Vector3(0, 1, 0), heading: heading.clone(), terrain: floorAt(),
      surfaceOf: () => 1, obstacles: [panel()], oobFloorY: -100, keys, stick, drive: 0,
      onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
    });
    model.start();
    model.st.pos.copy(from).setY(-groundRestDepth(SURFACE_ROWS[1]));
    model.st.vel.copy(heading).multiplyScalar(12);
    model.st.fwd.copy(heading);
    model.st.contactN.set(0, 1, 0);
    model.st.boardUp.set(0, 1, 0);
    model.st.grounded = true;
    for (let tick = 0; tick < ticks; tick++) model.step(1 / 60);
    return model;
  }

  // Held to 15 ticks (3 m at 12 m/s) so the run stays deep inside the world AABB without approaching the
  // panel: the body sphere is 0.85 m, so "not touching the panel" means keeping most of a metre off its plane.
  const acrossHits: RideObstacleHit[] = [];
  rideAcross(new THREE.Vector3(-5, 0, 2), new THREE.Vector3(1, 0, 0), acrossHits, 15);
  assert.equal(acrossHits.length, 0,
    'crossing the corner of the world AABB touches nothing — the collider is the panel, not its envelope');

  const intoHits: RideObstacleHit[] = [];
  const into = rideAcross(new THREE.Vector3(-5, 0, 9), new THREE.Vector3(1, 0, -1).normalize(), intoHits);
  assert.ok(intoHits.length > 0, 'driving at the panel itself does contact it');
  assert.ok(Math.abs(intoHits[0].normal.y) < 0.2,
    'and the contact normal is one of the panel’s own axes, turned with it — not a world axis');
  assert.ok(into.st.pos.x + into.st.pos.z < 4.2,
    'the rider is stopped on the near side of the panel rather than passing through it');
}

{
  // Depenetration [Trailmap: 370-depenetrate]. A rider who begins the tick already INSIDE a box is the case
  // collide-and-slide handles worst — it clips the movement and can leave them embedded. The engine pushes them
  // out along the contact normal instead, so one tick is enough to be clear of the shape.
  const hits: RideObstacleHit[] = [];
  // Offset so the rider's nearest face is a SIDE one: a box they are standing in the middle of resolves
  // downward, which is correct but would only prove the fixture pushes them through the floor.
  const centre = new THREE.Vector3(3.6, RIDER_BODY_Y, 0), size = new THREE.Vector3(8, 3, 8);
  const bounds = {
    min: { x: centre.x - size.x / 2, y: centre.y - size.y / 2, z: centre.z - size.z / 2 },
    max: { x: centre.x + size.x / 2, y: centre.y + size.y / 2, z: centre.z + size.z / 2 },
  };
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [nativeBox(centre, size)], oobFloorY: -100, keys, stick, drive: 0,
    onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  // Sat inside it, barely moving: nothing about this tick is a swept entry.
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 0);
  model.st.vel.set(0, 0, 0.2);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;

  const bodyAt = (pos: THREE.Vector3) => ({ x: pos.x, y: pos.y + RIDER_BODY_Y, z: pos.z });
  assert.ok(sphereVsNativeBox(bounds.min, bounds.max, bodyAt(model.st.pos), RIDER_BODY_R),
    'the rider starts inside the box');
  model.step(1 / 60);
  assert.equal(sphereVsNativeBox(bounds.min, bounds.max, bodyAt(model.st.pos), RIDER_BODY_R), null,
    'and one tick pushes them clear of it, rather than clipping their movement and leaving them embedded');
  assert.ok(hits.length > 0, 'the contact is still dispatched for sound and effects');
}

{
  // Retirement still reaches a box: an effect kill must not leave an invisible one standing.
  const hits: RideObstacleHit[] = [];
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, drive: 0,
    obstacles: [nativeBox(new THREE.Vector3(0, RIDER_BODY_Y, 3), new THREE.Vector3(6, 0.6, 0.4))],
    oobFloorY: -100, keys, stick, onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  model.retireObstacle('reference:box');
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 0);
  model.st.vel.set(0, 0, 12);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  for (let tick = 0; tick < 24; tick++) model.step(1 / 60);
  assert.ok(model.st.pos.z > 3.5, 'a retired box collider lets the rider through');
  assert.equal(hits.length, 0, 'and dispatches no ghost contact');
}

console.log('native-box-collision ok');
