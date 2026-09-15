// tier: fast

// Flat ground is the case where the contact term has no slope to hide behind: gravity's contact-plane component
// is exactly zero, so the cruise drive is the ONLY thing that can move the rider, and anything the contact
// manufactures on its own is the only other motion in the tick. Both failures below were found in a MEGAPLE
// capture that spawned on a level shelf: 1196 frames, 17 m travelled, and the cruise drive gated off for every
// one of the 1171 grounded ticks.
import assert from 'node:assert/strict';
import { forwardResistance } from '../src/app/ride/ride-response';
import { RIDER_DRIVE } from '../src/app/ride/physics-tuning';
import * as THREE from 'three';
import { createRideModel, groundRestDepth, SURFACE_ROWS } from '../src/app/ride/physics';

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };
const SNOW = SURFACE_ROWS[1];

function floorAt(y = 0, extent = 400): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -extent, y, -extent, -extent, y, extent, extent, y, -extent,
    extent, y, -extent, -extent, y, extent, extent, y, extent,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** A rider seated at rest on the level floor, facing +Z. `drive: 0` isolates the contact from the cruise term. */
function seated(drive?: number) {
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, oobFloorY: -100, keys, stick, drive, onRespawn: () => {},
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SNOW), 0);
  model.st.vel.set(0, 0, 0);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  return model;
}

const travel = (m: ReturnType<typeof seated>) => m.st.vel.dot(m.st.fwd);
const planar = (m: ReturnType<typeof seated>) => Math.hypot(m.st.vel.x, m.st.vel.z);

// The big-air audio gate consumes a total-flight prediction built on the ground->air edge. A strong launch over
// known flat terrain is long enough, and touchdown clears the latch instead of leaking it into the next jump.
{
  const model = seated(0);
  model.st.vel.set(0, 10, 12);
  model.st.forcedAir = true;
  model.step(1 / 60);
  assert.ok(!model.st.grounded && model.st.predictedAirTime > 1.5,
    `a strong launch predicts its >1.5 s landing arc (got ${model.st.predictedAirTime.toFixed(3)} s)`);
  for (let i = 0; i < 240 && !model.st.grounded; i++) model.step(1 / 60);
  assert.ok(model.st.grounded && model.st.predictedAirTime === 0,
    'touchdown clears the big-air flight prediction');
}

// ---------------------------------------------------------------------------------------------------------
// The grounded redirect must not manufacture travel out of contact buzz.
//
// The restore's gain on the tangential channel tends to 1/(1 − 0.4) = 1.667 per tick as that channel tends to
// zero, and a deck pinned at its pushout budget refills the normal channel for free every tick (the pushout
// zeroes `vn`, position integrates with the zeroed velocity so the deck never moves, and the saturated response
// puts `accel·dt` back). On flat ground nothing else acts along the contact plane, so the seed that gets
// amplified is float noise in the contact normal — and the direction it happens to point becomes the direction
// the rider travels. In the capture, 2.9 mm/s of seed became 1.4 m/s BACKWARDS in about twelve ticks.
// The drop is what arms it: the capture spawned hovering 1.03 m up, and the landing drove the deck to 34.8 mm —
// past snow's 25 mm pushout budget — which is what pins it and starts the free refill. A deck seated at its bog
// equilibrium never buzzes and never pumps, so a standstill test that skips the drop reproduces nothing.
{
  const model = seated(0);
  model.st.pos.set(0, 1.03, 0);
  model.st.grounded = false;
  // The capture's seed, aimed against the board: the contact normal's float-level tilt was +Z on a −Z heading.
  model.st.vel.set(0, 0, -0.0029);
  let worstBackwards = 0;
  for (let i = 0; i < 600; i++) {
    model.step(1 / 60);
    worstBackwards = Math.min(worstBackwards, travel(model));
  }
  assert.ok(model.st.grounded, 'the drop lands and stays down');
  assert.ok(planar(model) < 0.05,
    `a level standstill stays at rest instead of pumping contact buzz into travel (got ${planar(model).toFixed(4)} m/s)`);
  assert.ok(worstBackwards > -0.05,
    `the seed is never amplified into backwards travel (worst ${worstBackwards.toFixed(4)} m/s)`);
  assert.ok(model.st.grounded, 'the deck stays seated while the redirect declines to restore');
}

// The same standstill on a surface whose contact is a soft spring rather than a stiff bog. Powders are exempt
// from the redirect entirely, so this only confirms the floor did not disturb them.
{
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 3, oobFloorY: -100, keys, stick, drive: 0, onRespawn: () => {},
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[3]), 0);
  model.st.vel.set(0, 0, -0.0029);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.grounded = true;
  for (let i = 0; i < 600; i++) model.step(1 / 60);
  assert.ok(planar(model) < 0.05, 'powder does not pump either');
}

// ---------------------------------------------------------------------------------------------------------
// A landing that HAS travel to rotate into must still convert its impact into carried speed ([Trailmap: 320]).
// This is the half of the redirect the floor above must not touch: the normal channel legitimately dwarfs the
// tangential one on a hard landing, which is exactly why the skip is an absolute floor and not a ratio.
{
  const model = seated(0);
  model.st.pos.set(0, 4, -30);
  model.st.vel.set(0, 0, 12);
  model.st.grounded = false;
  let arrivingPlanar = 0, peakAfterLanding = 0, groundedTicks = 0;
  for (let i = 0; i < 240; i++) {
    if (!model.st.grounded) arrivingPlanar = planar(model);
    model.step(1 / 60);
    if (model.st.grounded && ++groundedTicks <= 30) peakAfterLanding = Math.max(peakAfterLanding, planar(model));
  }
  assert.ok(model.st.grounded, 'the drop lands');
  assert.ok(peakAfterLanding > arrivingPlanar + 1,
    `contact redirects impact into forward travel (${arrivingPlanar.toFixed(2)} -> ${peakAfterLanding.toFixed(2)} m/s)`);
  assert.ok(travel(model) > 0 && planar(model) < peakAfterLanding,
    'the rider carries forward travel, then the recovered resistance slows the unpowered coast');
}

// ---------------------------------------------------------------------------------------------------------
// The cruise drive is the only force along a level contact plane, so it has to be able to start from rest.
// Gating it on a readable travel direction made low speed ABSORBING: under the floor nothing could re-accelerate
// the rider, so the capture's rider crept at 0.36 m/s for the last 200 frames with the drive gated off.
{
  const model = seated();
  for (let i = 0; i < 300; i++) model.step(1 / 60);
  assert.ok(travel(model) > 0, 'a standstill on level snow drives FORWARD, along the board heading');
  const speed = planar(model);
  const balance = RIDER_DRIVE * SNOW.mult * (SNOW.target - speed)
    + forwardResistance(SNOW, speed, model.st.error, model.st.sinkBudget, 0, 0);
  assert.ok(speed < SNOW.target && Math.abs(balance) < 0.01,
    `cruise and resistance settle in balance below the target (net ${balance.toFixed(4)} m/s²)`);
}

// Alignment is a heading delta in the contact plane, so a SIDEWAYS skid still gets nothing ([Trailmap: 360]).
// This is the half of the gate riding switch does not touch: 90° across the travel is off the drive's 60° band
// whichever end of the deck is called the front, so a slide stays a slide.
{
  const model = seated();
  model.st.vel.set(8, 0, 0); // 8 m/s across a +Z heading: square sideways, 90° off both ends
  const before = model.st.vel.length();
  model.step(1 / 60);
  assert.ok(model.st.vel.length() <= before + 1e-6,
    'a rider 90° across their travel gets no drive, so the sideways skid does not accelerate');
}

// ...and the other half: 180° across the travel is RIDING SWITCH (docs/016), not a dead skid. The lead latches
// to the end that is actually leading, so the rider keeps the deck pointing where the air left it and rides on.
// The deck must not whip around to face the travel — that snap-back is the thing switch support removes.
{
  const model = seated();
  model.st.vel.set(0, 0, -8); // 8 m/s backwards under a +Z heading: landed a 180
  model.step(1 / 60);
  assert.equal(model.st.lead, -1, 'travel 180° off the nose hands the lead to the tail');
  assert.ok(model.st.vel.dot(model.st.fwd) <= 0, 'one tick does not flip the board around');
  for (let i = 0; i < 300; i++) model.step(1 / 60);
  assert.equal(model.st.lead, -1, 'and it stays switch — nothing rights the lead on its own');
  assert.ok(model.st.fwd.z > 0.9, 'the drawn nose still points the way it was left');
  const speed = -model.st.vel.z;
  const balance = RIDER_DRIVE * SNOW.mult * (SNOW.target - speed)
    + forwardResistance(SNOW, speed, model.st.error, model.st.sinkBudget, 0, 0);
  assert.ok(speed > 0 && Math.abs(balance) < 0.01, 'switch travel reaches the same drive/resistance equilibrium');
}

// ---------------------------------------------------------------------------------------------------------
// Brake scrubs toward a standstill and stops there. Unclamped it ran the forward component negative without
// limit: in the capture, frames 651–671 of held brake ACCELERATED the rider from 1.0 to 5.25 m/s backwards, and
// braking added a net 7.9 m/s across the run.
{
  const model = seated(0);
  model.st.vel.set(0, 0, 8);
  keys.brake = true;
  let worstBackwards = 0, fastest = 0;
  for (let i = 0; i < 300; i++) {
    model.step(1 / 60);
    worstBackwards = Math.min(worstBackwards, travel(model));
    fastest = Math.max(fastest, model.st.vel.length());
  }
  keys.brake = false;
  assert.ok(fastest <= 8 + 1e-6, `holding brake never gains speed (peaked at ${fastest.toFixed(2)} m/s)`);
  assert.ok(worstBackwards >= -1e-6, `and never reverses (worst ${worstBackwards.toFixed(4)} m/s)`);
  assert.ok(planar(model) < 0.05, 'the rider comes to a stop');
}

console.log('FLAT GROUND RIDE TESTS PASSED');
