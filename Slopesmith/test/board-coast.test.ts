// tier: fast

// The RIDERLESS COAST (`app/ride/board-coast.ts`) and the rider's half of the same moment (`xr/walk.placeAt`).
//
// Stepping off a board mid-flight splits one object into two, both retaining the complete launch velocity before
// the equipment's stronger gravity separates their trajectories. Neither
// is traced by the spec — the engine has no dismount — so this is the only place the behaviour is pinned, and
// the failure it exists to catch is the cheap one: a deck frozen in mid-air and a rider set down on the snow
// beneath it with all their speed still on.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createBoardCoast } from '../src/app/ride/board-coast';
import {
  COAST_AIR_RESISTANCE, COAST_GRAVITY, COAST_MAX_TIME, COAST_SEAT, COAST_STOP_SPEED,
} from '../src/app/ride/physics-tuning';
import {
  createWalker, downwardGroundQuery, PLAYER_AIR_RESISTANCE, type WalkGround,
} from '../src/app/ride/xr/walk';

/** A ground query over a heightfield given as a function of x, with the slope's own normal. */
function terrain(heightAt: (x: number, z: number) => number | null, normalAt?: (x: number) => THREE.Vector3) {
  return downwardGroundQuery((from, to): WalkGround | null => {
    const y = heightAt(from.x, from.z);
    if (y === null) return null;
    if (y > from.y || y < to.y) return null; // outside the probe's own window, as a real cast would be
    return { y, normal: (normalAt?.(from.x) ?? new THREE.Vector3(0, 1, 0)).clone() };
  });
}

const FLAT = new THREE.Vector3(0, 1, 0);
const AHEAD = new THREE.Vector3(0, 0, 1);
const FALL_FLOOR = -400;

/** Run a coast to rest (or to its safety expiry), returning how many seconds it took. */
function settle(coast: ReturnType<typeof createBoardCoast>, limit = COAST_MAX_TIME + 4): number {
  let t = 0;
  while (coast.active && t < limit) { coast.step(1 / 60); t += 1 / 60; }
  return t;
}

// A board jumped off in mid-air keeps its arc, falls, and slides on down the hill — it does not hang where the
// rider let go of it, which is what a session that simply stops stepping the ride model leaves behind.
{
  const coast = createBoardCoast({ ground: terrain(() => 0), oobFloorY: FALL_FLOOR });
  coast.launch(new THREE.Vector3(0, 12, 0), new THREE.Vector3(0, 0, 18), AHEAD, FLAT);
  assert.ok(coast.active, 'a dismount hands the deck to the coast');

  coast.step(1 / 60);
  assert.ok(coast.pos.y < 12 && coast.pos.z > 0, 'the first frame already falls and carries');

  const airborneFor = (() => {
    let t = 0;
    while (!coast.grounded && t < 4) { coast.step(1 / 60); t += 1 / 60; }
    return t;
  })();
  assert.ok(coast.grounded, `the deck reaches the snow (after ${airborneFor.toFixed(2)} s)`);
  const landedAt = coast.pos.z;
  assert.ok(landedAt > 4, `and lands well down-course from the bail (${landedAt.toFixed(1)} m)`);

  settle(coast);
  assert.ok(!coast.active, 'friction parks it');
  assert.ok(coast.pos.z > landedAt, `then it slides on past the touchdown (${coast.pos.z.toFixed(1)} m)`);
  assert.ok(Math.abs(coast.pos.y - COAST_SEAT) < 1e-9, 'and comes to rest lying on the surface');
  assert.equal(coast.vel.length(), 0, 'a parked deck has no velocity left');
}

// The coast is a board on a surface, not a ballistic object: seated, it stays welded to the face it is sliding
// on and lies along it. Gravity's into-surface part is clamped off there — a seated deck has no contact spring
// to balance the full pull, so keeping it would drive the board into the snow instead of along it.
{
  const bank = new THREE.Vector3(-1, 2, 0).normalize(); // the surface y = x/2, falling away toward −x
  const coast = createBoardCoast({
    ground: terrain(x => x / 2, () => bank), oobFloorY: FALL_FLOOR,
  });
  coast.launch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-9, -4.5, 0), AHEAD, FLAT);
  for (let i = 0; i < 20; i++) coast.step(1 / 60);
  assert.ok(coast.pos.x < -1, `a deck let go of at speed runs on down the bank (x ${coast.pos.x.toFixed(2)})`);
  assert.ok(Math.abs(coast.pos.y - (coast.pos.x / 2 + COAST_SEAT)) < 1e-6,
    'staying seated on the slope the whole way rather than sinking through it or flying off it');
  assert.ok(coast.up.dot(bank) > 0.99, 'and settling onto the face it is running across');
  settle(coast);
  assert.ok(!coast.active && coast.vel.length() === 0, 'friction still parks it on the incline');
}

// Nothing under it at all: the safety timer must never freeze a deck in mid-air, so an expiry that catches one
// falling drops the carry and lets gravity finish the job. If it still finds no surface by the hard backstop,
// the host is told even when real gravity has not yet crossed an arbitrarily deep out-of-bounds floor.
{
  let lost = 0;
  const coast = createBoardCoast({
    ground: terrain(() => null), oobFloorY: FALL_FLOOR, onLost: () => { lost++; },
  });
  coast.launch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 20), AHEAD, FLAT);
  const took = settle(coast);
  assert.ok(!coast.active, `a deck that flew off the world parks rather than being tracked forever (${took.toFixed(1)} s)`);
  assert.equal(lost, 1, 'and reports itself lost exactly once');
  assert.ok(coast.pos.y < -250, 'having continued falling under player gravity for the complete safety window');
}

// A deck stepped off at a standstill has arrived already: it parks on the spot rather than creeping.
{
  const coast = createBoardCoast({ ground: terrain(() => 0), oobFloorY: FALL_FLOOR });
  coast.launch(new THREE.Vector3(3, 0, -2), new THREE.Vector3(0, 0, COAST_STOP_SPEED / 2), AHEAD, FLAT);
  settle(coast);
  assert.ok(coast.pos.distanceTo(new THREE.Vector3(3, COAST_SEAT, -2)) < 0.1,
    'a slow dismount leaves the board where the rider stood');
}

// A mount takes the deck back, and the coast stops answering for where it is.
{
  const coast = createBoardCoast({ ground: terrain(() => 0), oobFloorY: FALL_FLOOR });
  coast.launch(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 0, 10), AHEAD, FLAT);
  assert.ok(coast.launched, 'the coast owns the deck from the dismount');
  const beforeClaim = coast.epoch;
  coast.stop();
  assert.ok(!coast.launched && !coast.active, 'and hands it back on the mount');
  assert.equal(coast.epoch, beforeClaim + 1,
    'the ownership handoff advances the equipment-only multiplayer teleport epoch');
}

// Parking is the gate post and the reset: laid flat on the snow at rest, facing where it was put.
{
  const bank = new THREE.Vector3(1, 3, 0).normalize();
  const coast = createBoardCoast({ ground: terrain(() => 7, () => bank), oobFloorY: FALL_FLOOR });
  const beforePark = coast.epoch;
  coast.park(new THREE.Vector3(2, 40, 5), AHEAD);
  assert.ok(!coast.active && coast.launched, 'a park is a deck at rest that the coast still knows the place of');
  assert.ok(Math.abs(coast.pos.y - (7 + COAST_SEAT)) < 1e-9, 'seated on the surface under the point given');
  assert.ok(coast.up.dot(bank) > 0.999, 'lying along that surface');
  assert.ok(Math.abs(coast.fwd.dot(coast.up)) < 1e-9, 'with its heading squared onto the deck');
  assert.equal(coast.epoch, beforePark + 1, 'an explicit re-park advances the equipment-only teleport epoch');
}

// ---------------------------------------------------------------------------------------------------------
// The rider's half: a carried placement keeps the height it was given, not just the velocity.

{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 14, 0), new THREE.Vector3(0, 4, 22));
  assert.ok(Math.abs(walker.position().y - 14) < 1e-9,
    `a rider who bails at 14 m is still at 14 m (got ${walker.position().y.toFixed(3)})`);
  assert.ok(!walker.isGrounded(), 'and is airborne, not standing on the snow far below');
  assert.ok(Math.abs(walker.velocity().z - 22) < 1e-9, 'carrying the board\'s speed');

  // A rising bail gives both halves the complete launch velocity. The equipment's stronger gravity creates the
  // separation after release, rather than an artificial velocity change at the handoff.
  const coast = createBoardCoast({ ground: terrain(() => 0), oobFloorY: FALL_FLOOR });
  const risingCarry = new THREE.Vector3(0, 4, 22);
  coast.launch(new THREE.Vector3(0, 14, 0), risingCarry, AHEAD, FLAT);
  assert.equal(coast.vel.y, 4, 'a dismounted board retains its complete upward velocity at the handoff');
  assert.equal(coast.vel.z, 22, 'while retaining its horizontal trajectory');
  assert.equal(risingCarry.y, 4, 'the coast does not mutate the velocity retained by the rider');
  const still = { moveX: 0, moveY: 0, forward: new THREE.Vector3(0, 0, -1), jump: false };
  for (let i = 0; i < 6; i++) { walker.step(1 / 60, still); coast.step(1 / 60); }
  assert.ok(walker.position().z > 1.5 && coast.pos.z > 1.5, 'both halves of the bail carry on down-course');
  assert.ok(walker.position().distanceTo(coast.pos) < 1,
    `board and rider leave together before stronger equipment gravity separates them (${walker.position().distanceTo(coast.pos).toFixed(2)} m apart)`);
}

// Downward velocity is retained too: launch copies every component regardless of which way the board is moving.
{
  const coast = createBoardCoast({ ground: terrain(() => null), oobFloorY: FALL_FLOOR });
  coast.launch(new THREE.Vector3(0, 20, 0), new THREE.Vector3(3, -5, 12), AHEAD, FLAT);
  assert.deepEqual(coast.vel.toArray(), [3, -5, 12], 'a descending dismount retains every velocity component');
  coast.step(1 / 60);
  assert.equal(COAST_GRAVITY, 14, 'loose equipment uses the requested 14 m/s² gravity');
  assert.ok(Math.abs(coast.vel.y - (-5 - COAST_GRAVITY / 60)) < 1e-9,
    `loose equipment falls under ${COAST_GRAVITY} m/s² gravity`);
}

// A board-speed dismount uses 0.3/s player resistance while the loose board uses 0.1/s, so both retain their
// launch trajectory and the board gradually pulls ahead.
{
  assert.equal(COAST_AIR_RESISTANCE, 0.1, 'the loose board uses the requested gentle 0.1/s air resistance');
  const walker = createWalker({ ground: terrain(() => null), oobFloorY: -5000 });
  const coast = createBoardCoast({ ground: terrain(() => null), oobFloorY: FALL_FLOOR });
  const still = { moveX: 0, moveY: 0, forward: new THREE.Vector3(0, 0, -1), jump: false };
  const start = new THREE.Vector3(0, 200, 0), carry = new THREE.Vector3(0, 0, 25);
  walker.placeAt(start, carry);
  coast.launch(start, carry, AHEAD, FLAT);
  for (let i = 0; i < 30; i++) { walker.step(1 / 60, still); coast.step(1 / 60); }
  const expected = carry.z * Math.pow(1 - PLAYER_AIR_RESISTANCE / 60, 30);
  assert.ok(Math.abs(walker.velocity().z - expected) < 1e-9,
    `the carried arc damps at ${PLAYER_AIR_RESISTANCE}/s (${walker.velocity().z.toFixed(2)} m/s after 0.5 s)`);
  const expectedBoard = carry.z * Math.pow(1 - COAST_AIR_RESISTANCE / 60, 30);
  assert.ok(Math.abs(coast.vel.z - expectedBoard) < 1e-9,
    `the board's arc damps at ${COAST_AIR_RESISTANCE}/s (${coast.vel.z.toFixed(2)} m/s after 0.5 s)`);
  assert.ok(coast.pos.z > walker.position().z && coast.vel.z > walker.velocity().z,
    'the lower board resistance makes it gradually pull ahead of the airborne rider');

  // The stick may still turn that inherited arc while the gentle player air resistance scrubs it.
  const steered = createWalker({ ground: terrain(() => null), oobFloorY: -5000 });
  steered.placeAt(new THREE.Vector3(0, 200, 0), new THREE.Vector3(0, 0, 25));
  const right = { moveX: 1, moveY: 0, forward: new THREE.Vector3(0, 0, -1), jump: false };
  for (let i = 0; i < 30; i++) steered.step(1 / 60, right);
  const speed = Math.hypot(steered.velocity().x, steered.velocity().z);
  assert.ok(speed < 25, `player air resistance scrubs the carried speed (${speed.toFixed(2)} m/s)`);
  assert.ok(steered.velocity().x > 0.5, 'while the arc still bends toward the stick');
}

// An ordinary jump uses that same gentle response.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  const forward = new THREE.Vector3(0, 0, -1);
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  walker.step(1 / 60, { moveX: 1, moveY: 0, forward, jump: true }); // hop sideways at strafe pace
  const launched = walker.velocity().x;
  assert.ok(launched > 3, `the hop leaves at strafe pace (${launched.toFixed(2)} m/s)`);
  for (let i = 0; i < 20; i++) walker.step(1 / 60, { moveX: 0, moveY: 0, forward, jump: false });
  assert.ok(walker.velocity().x < launched * 0.95,
    `and a centred stick gently bleeds a walking hop (${walker.velocity().x.toFixed(2)} m/s)`);
}

// A grounded dismount is unchanged: no carry, so the walker is placed standing on the surface at rest.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 6, 0));
  assert.ok(walker.isGrounded() && Math.abs(walker.position().y) < 1e-9,
    'an uncarried placement still drops onto the surface under it');
  assert.equal(walker.velocity().length(), 0, 'at rest');
}

// A carry that starts BELOW the surface is lifted onto it rather than left buried.
{
  const walker = createWalker({ ground: terrain(() => 3), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 1, 0), new THREE.Vector3(5, 0, 0));
  assert.ok(Math.abs(walker.position().y - 3) < 1e-9, 'the height is raised to the floor, never dropped to it');
}

console.log('BOARD COAST: PASS');
