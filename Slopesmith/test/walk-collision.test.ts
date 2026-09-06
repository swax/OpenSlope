// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWalkObstacleWorld } from '../src/app/ride/walk-collision';
import { createWalker, downwardGroundQuery, type WalkGround } from '../src/app/ride/xr/walk';
import type { RideObstacleHit, RideObstacleSource } from '../src/app/ride/physics';

function source(key: string, geometry: THREE.BufferGeometry, matrixWorld: THREE.Matrix4,
  extra: Partial<RideObstacleSource> = {}): RideObstacleSource {
  return {
    key, object: { kind: 'authored', id: key }, geometry, matrixWorld,
    solid: true, bounce: 0, surface: -1, ...extra,
  };
}

function terrainAndProps(world: ReturnType<typeof createWalkObstacleWorld>) {
  return downwardGroundQuery((from, to): WalkGround | null => {
    const terrain = from.y >= 0 && to.y <= 0
      ? { y: 0, normal: new THREE.Vector3(0, 1, 0) }
      : null;
    const prop = world.groundCast(from, to);
    if (!terrain) return prop;
    if (!prop) return terrain;
    return prop.y > terrain.y ? prop : terrain;
  });
}

// A prop does not need a snowboard SurfaceType to be ordinary character ground. The walker can be dropped on
// a collidable roof and remains there instead of falling through to the terrain beneath it.
{
  const platform = source(
    'platform', new THREE.BoxGeometry(4, 1, 4), new THREE.Matrix4().makeTranslation(0, 1.5, 0),
  );
  const world = createWalkObstacleWorld([platform]);
  const walker = createWalker({
    ground: terrainAndProps(world), resolveMove: world.resolveMove, oobFloorY: -100,
  });
  walker.placeAt(new THREE.Vector3(0, 4, 0));
  assert.ok(Math.abs(walker.position().y - 2) < 1e-6,
    `solid prop top is walkable even with surface=-1 (feet y ${walker.position().y})`);
  for (let i = 0; i < 60; i++) walker.step(1 / 60, {
    moveX: 0, moveY: 0, forward: new THREE.Vector3(0, 0, -1), jump: false,
  });
  assert.ok(walker.isGrounded() && Math.abs(walker.position().y - 2) < 1e-6,
    'the on-foot controller stays seated on the prop');
  world.dispose();
}

// A nearer trigger must not hide valid ground beneath it. The optimized query retains the nearest VALID face
// while traversing instead of taking the first raw ray hit and allocating/sorting the entire 202 m hit list.
{
  const trigger = source(
    'trigger', new THREE.BoxGeometry(4, 0.2, 4), new THREE.Matrix4().makeTranslation(0, 4, 0),
    { solid: false },
  );
  const floor = source(
    'floor', new THREE.BoxGeometry(4, 0.2, 4), new THREE.Matrix4().makeTranslation(0, 2, 0),
  );
  const world = createWalkObstacleWorld([trigger, floor]);
  world.beginFrame();
  const ground = world.groundCast(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -8, 0));
  assert.ok(ground && Math.abs(ground.y - 2.1) < 1e-6,
    `nearest solid floor survives a nearer trigger (ground y ${ground?.y})`);
  assert.equal(world.perf.groundCasts, 1);
  assert.ok(world.perf.triangleTests > 0, 'ground traversal exposes its exact candidate-triangle work');
  world.dispose();
}

// The feet-only height query cannot see the side of a tall prop when its roof is above the probe. The body
// resolver supplies that missing wall and clips the feet root before the character enters it.
{
  const wall = source(
    'wall', new THREE.BoxGeometry(1, 5, 4), new THREE.Matrix4().makeTranslation(1, 2.5, 0),
  );
  const world = createWalkObstacleWorld([wall]);
  const walker = createWalker({
    ground: terrainAndProps(world), resolveMove: world.resolveMove, oobFloorY: -100,
  });
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  const right = { moveX: 1, moveY: 0, forward: new THREE.Vector3(0, 0, -1), jump: false };
  for (let i = 0; i < 60; i++) walker.step(1 / 60, right);
  assert.ok(walker.position().x < 0.25,
    `the walking body stops outside the prop wall (feet x ${walker.position().x.toFixed(3)})`);
  world.dispose();
}

// Roller/dynamic props report the same stable object identity and a real shove as board impacts. They are not
// made into immovable walls by the walker resolver: the scene-side Roller runtime receives the impulse and moves.
{
  const hits: RideObstacleHit[] = [];
  const roller = source(
    'roller', new THREE.BoxGeometry(1, 2, 2), new THREE.Matrix4().makeTranslation(1, 1, 0),
    { dynamicMass: 12 },
  );
  const world = createWalkObstacleWorld([roller], hit => hits.push(hit));
  const from = new THREE.Vector3(0, 0, 0), to = new THREE.Vector3(2, 0, 0);
  const velocity = new THREE.Vector3(8, 0, 0);
  world.resolveMove(from, to, velocity);
  assert.ok(to.x > 1.9, 'a Roller contact is passed to its movable-body runtime instead of becoming a static wall');
  assert.equal(hits.length, 1, 'one crossing dispatches one debounced contact');
  assert.equal(hits[0].key, 'roller');
  assert.equal(hits[0].object.kind, 'authored');
  assert.ok(hits[0].impactSpeed > 7.9, `walking impact carries closing speed (${hits[0].impactSpeed})`);
  assert.ok(hits[0].shove && hits[0].shove.linear.x > 0,
    'the Roller receives a forward linear shove from the walking character');
  assert.ok(world.perf.sweeps <= 4,
    `one move uses one shared nine-rail traversal per slide plane, not nine (${world.perf.sweeps} sweeps)`);
  world.dispose();
}

// Moving prop geometry is synchronized once per rendered frame and only its BVH subtree is refit. Multiple
// ground/body queries in one frame consume the same pose and diagnostics reset cleanly at the next boundary.
{
  const pose = new THREE.Matrix4().makeTranslation(0, 1.5, 0);
  let version = 0, poseReads = 0;
  const platform = source(
    'moving-platform', new THREE.BoxGeometry(4, 1, 4), pose.clone(),
    { liveMatrix: () => { poseReads++; return pose; }, poseVersion: () => version },
  );
  const world = createWalkObstacleWorld([platform]);
  world.beginFrame();
  const first = world.groundCast(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -8, 0));
  world.groundCast(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -8, 0));
  assert.ok(first && Math.abs(first.y - 2) < 1e-6);
  assert.equal(poseReads, 0, 'an unchanged pose stamp avoids even recomposing the live matrix');
  assert.equal(world.perf.liveRefits, 0);
  assert.equal(world.perf.groundCasts, 2);

  pose.makeTranslation(0, 3.5, 0); version++;
  world.beginFrame();
  const moved = world.groundCast(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -8, 0));
  world.groundCast(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, -8, 0));
  assert.ok(moved && Math.abs(moved.y - 4) < 1e-6,
    `the targeted refit carries walking ground to its current pose (ground y ${moved?.y})`);
  assert.equal(poseReads, 1, 'all collision queries in one frame share one live-pose synchronization');
  assert.equal(world.perf.liveRefits, 1, 'all moving mesh changes are combined into one targeted BVH refit');
  assert.equal(world.perf.groundCasts, 2, 'the next frame starts fresh diagnostic counters');
  world.dispose();
}

console.log('walk collision tests passed');
