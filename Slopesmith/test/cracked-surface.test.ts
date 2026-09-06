// tier: fast

/**
 * The Cracked surface runtime, against the numbers measured on PS2.
 *
 * Retail's Megaplex pane is the reference case: authored lifetime -1 and strength 5, ridden onto, cracked, and
 * gone about three seconds later. Live memory caught three of them mid-drain at 5.0000 / 3.8750 / 2.0165, and
 * a bench cell at strength 1000 took ten or more charges in one traversal spaced a flat 0.5 s apart. The same
 * node spends 70-96 on a single hard contact, which is why dropping onto a pane breaks straight through it.
 */
import * as THREE from 'three';
import {
  createCrackedSurfaceRuntime, CRACK_GATE_SECONDS, CARRIED_HIT_COST, IMPACT_NORMAL_SPEED,
} from '../src/app/ride/cracked-surfaces';
import { createRideModel } from '../src/app/ride/physics';
import { check, failures } from './check';

/** A pane laid flat at the origin — box for the broad phase, its two faces for the narrow one. */
const paneBox = () => new THREE.Box3(new THREE.Vector3(-5, -0.1, -5), new THREE.Vector3(5, 0.1, 5));
const paneTriangles = () => {
  const a = new THREE.Vector3(-5, 0, -5), b = new THREE.Vector3(5, 0, -5);
  const c = new THREE.Vector3(5, 0, 5), d = new THREE.Vector3(-5, 0, 5);
  return [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)];
};
const surface = (over: { key?: string; strength?: number; lifetimeSeconds?: number } = {}) => ({
  key: over.key ?? 'pane', strength: over.strength ?? 5,
  lifetimeSeconds: over.lifetimeSeconds ?? -1, box: paneBox(), triangles: paneTriangles(),
});
/** Riding along the pane: on it, moving across it, no vertical speed to speak of. */
const RIDE_VEL = new THREE.Vector3(8, -0.4, 0);
/** Dropping onto it from a height. */
const FALL_VEL = new THREE.Vector3(0, -(IMPACT_NORMAL_SPEED + 5), 0);
const AT = new THREE.Vector3(0, 0, 0);

const TICK = 1 / 60;

function flatTerrain(): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -20, 0, -20, -20, 0, 20, 20, 0, -20,
    20, 0, -20, -20, 0, 20, 20, 0, 20,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** Ride a carried rider over one surface for `seconds`, reporting when it cracked and when it broke. */
function rideCarried(spec = surface(), seconds = 10) {
  const events: { crackedAt: number | null; brokeAt: number | null; healedAt: number | null } = {
    crackedAt: null, brokeAt: null, healedAt: null,
  };
  let t = 0;
  const runtime = createCrackedSurfaceRuntime([spec], {
    onCrack: () => { events.crackedAt ??= t; },
    onBreak: () => { events.brokeAt ??= t; },
    onHeal: () => { events.healedAt ??= t; },
  });
  const charges: number[] = [];
  let last = runtime.strengthOf(spec.key);
  for (; t < seconds; t += TICK) {
    runtime.step(AT, AT, RIDE_VEL, TICK);
    const now = runtime.strengthOf(spec.key);
    if (now !== last) { charges.push(t); last = now; }
  }
  return { runtime, events, charges };
}

// ---- the retail pane, ridden -----------------------------------------------------------------------------
{
  const { runtime, events, charges } = rideCarried();
  check(events.crackedAt === 0, `riding onto it cracks it at once (at ${events.crackedAt}s)`);
  check(events.brokeAt !== null, 'staying on it breaks it');
  // Five strength at one per charge, charged every 0.5 s starting at t=0, is the fifth charge at 2.0 s.
  const broke = events.brokeAt ?? -1;
  check(broke > 1.9 && broke < 3.1, `it gives way after about 2-3 s of riding (${broke.toFixed(2)}s)`);
  check(runtime.isBroken('pane'), 'the host reports broken, so the caller can drop the rider through');
  check(!runtime.isCracked('pane'), 'a broken surface is no longer merely cracked');

  const gaps = charges.slice(1).map((at, i) => at - charges[i]);
  const spacing = gaps.every(gap => Math.abs(gap - CRACK_GATE_SECONDS) < TICK * 1.5);
  check(spacing, `charges land ${CRACK_GATE_SECONDS}s apart, the 30-frame gate `
    + `(gaps ${gaps.map(g => g.toFixed(3)).join(', ')})`);
  runtime.restore('pane');
  check(!runtime.isBroken('pane') && !runtime.isCracked('pane') && runtime.strengthOf('pane') === 5,
    'the shared breakable respawn refills and re-arms the pane');
  runtime.impact('pane', IMPACT_NORMAL_SPEED);
  check(runtime.isBroken('pane'), 'the restored pane can break again as a fresh interaction');
}

// ---- the same pane, fallen onto ---------------------------------------------------------------------------
{
  const runtime = createCrackedSurfaceRuntime([surface()]);
  runtime.step(AT, AT, FALL_VEL, TICK);
  check(runtime.isBroken('pane'), 'dropping onto it from a height breaks straight through, in one contact');
}

// ---- one player pool survives the hand-off between board and on-foot locomotion ----------------------------
{
  const runtime = createCrackedSurfaceRuntime([surface()]);
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), terrain: flatTerrain(), surfaceOf: () => 1,
    oobFloorY: -100,
    keys: { left: false, right: false, tuck: false, brake: false, boost: false },
    stick: { active: false, x: 0 }, crackedSurfaceRuntime: runtime, onRespawn: () => {},
  });
  // This public bridge is what desktop walking calls while its board model is deliberately idle, and WebXR
  // supplies the same runtime directly while no board has been built or the board is parked.
  model.stepCrackedSurfaces(AT, AT, RIDE_VEL, TICK);
  check(runtime.isCracked('pane') && !runtime.isBroken('pane'),
    'dismounted locomotion charges the player session\'s board crack pool');
  const away = new THREE.Vector3(10, 10, 10);
  model.stepCrackedSurfaces(away, away, RIDE_VEL, CRACK_GATE_SECONDS);
  model.stepCrackedSurfaces(AT, AT, FALL_VEL, TICK);
  check(runtime.isBroken('pane'), 'a later flying impact finishes that same pane instead of starting a new pool');
}
{
  const runtime = createCrackedSurfaceRuntime([surface()]);
  runtime.step(AT, AT, new THREE.Vector3(0, -(IMPACT_NORMAL_SPEED - 1), 0), TICK);
  check(!runtime.isBroken('pane'), 'a gentle settle is the carried cost, not the impact one');
  check(runtime.isCracked('pane'), 'and it still cracks');
}

// ---- the pool is an impact budget, not a hit count ---------------------------------------------------------
{
  const { runtime, charges } = rideCarried(surface({ key: 'slab', strength: 1000 }), 6);
  check(!runtime.isBroken('slab'), 'a strength-1000 surface survives a traversal, as the bench cell did');
  const spent = 1000 - (runtime.strengthOf('slab') ?? 0);
  check(Math.abs(spent - charges.length * CARRIED_HIT_COST) < 1e-6,
    `every charge cost the carried price (${charges.length} charges, ${spent.toFixed(2)} spent)`);
  check(charges.length >= 10, `a traversal lands ten or more charges (${charges.length})`);
}

// ---- lifetime: the crack heals, which is why retail authors -1 ---------------------------------------------
{
  const { runtime, events } = rideCarried(surface({ key: 'glass', strength: 1000, lifetimeSeconds: 2 }), 6);
  check(events.healedAt !== null, 'a positive lifetime retires the crack before the pool runs out');
  check((runtime.strengthOf('glass') ?? 0) > 990,
    'and the heal takes the accumulated damage with it, so the surface starts over');
}
{
  const { events } = rideCarried(surface({ strength: 1000 }), 6);
  check(events.healedAt === null, 'the authored -1 never expires: once cracked, cracked until it gives way');
}

// ---- a spent surface gives way exactly once -----------------------------------------------------------------
{
  let breaks = 0;
  const runtime = createCrackedSurfaceRuntime([surface()], { onBreak: () => { breaks += 1; } });
  for (let t = 0; t < 10; t += TICK) runtime.step(AT, AT, RIDE_VEL, TICK);
  runtime.step(AT, AT, FALL_VEL, TICK);
  check(breaks === 1, `the break fires once however long the rider stays on it (${breaks})`);
}

// ---- a long step is not travel, and must not charge everything between --------------------------------------
{
  // The bug this guards: `crackFrom` starts at the zero vector, so the first tick of a run swept a box from
  // the WORLD ORIGIN to the rider and overlapped every cracked surface on the mountain at once. With any
  // downward speed that is the impact cost, and every pane in Megaplex broke before the rider touched one.
  const far = new THREE.Vector3(400, 0, 400);
  const origin = new THREE.Vector3(0, 0, 0);
  let breaks = 0;
  const runtime = createCrackedSurfaceRuntime([surface()], { onBreak: () => { breaks += 1; } });
  runtime.step(origin, far, FALL_VEL, TICK);
  check(breaks === 0 && !runtime.isCracked('pane'),
    'a sweep from the origin to a distant rider charges nothing it merely spans');

  // ...while an ordinary tick's step still sweeps, so a fast rider cannot skip a thin pane between samples.
  const near = new THREE.Vector3(0, 0, -0.4);
  const runtime2 = createCrackedSurfaceRuntime([surface()]);
  runtime2.step(near, new THREE.Vector3(0, 0, 0.4), RIDE_VEL, TICK);
  check(runtime2.isCracked('pane'), 'a normal step still sweeps, so a thin pane cannot slip between samples');
}

// ---- the box is the broad phase only: near the box is not near the glass ------------------------------------
{
  // The bug this guards: a TILTED pane's axis-aligned box is a wedge of mostly air, and charging on box
  // overlap broke panes the rider was still descending toward — "whatever I'm moving towards breaks before
  // I get there". The glass itself is the test, so a rider inside the box but half the box away from the
  // faces must charge nothing.
  const a = new THREE.Vector3(-5, 0, -5), b = new THREE.Vector3(5, 0, -5);
  const c = new THREE.Vector3(5, 10, 5), d = new THREE.Vector3(-5, 10, 5);
  const tilted = {
    key: 'ramp', strength: 5, lifetimeSeconds: -1,
    box: new THREE.Box3(new THREE.Vector3(-5, -0.1, -5), new THREE.Vector3(5, 10.1, 5)),
    triangles: [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)],
  };
  const runtime = createCrackedSurfaceRuntime([tilted]);
  const inBoxOffGlass = new THREE.Vector3(0, 0.5, 4); // the glass overhead here is at y = 9
  runtime.step(inBoxOffGlass, inBoxOffGlass, FALL_VEL, TICK);
  check(!runtime.isCracked('ramp'), "inside a tilted pane's box but away from its faces charges nothing");

  // ...and a rider ON the tilted glass, moving fast ALONG it, is carried — however fast they are descending
  // with the slope. Vertical speed alone called this an impact and broke every pane on a downhill arrival.
  const onGlass = new THREE.Vector3(0, 5.1, 0.15); // on the y=x ramp face, within board reach
  // The face rises with +z, so descending it means y AND z falling together. 20 m/s along the glass, with
  // |vel.y| = 14 — far above the impact threshold on the vertical axis, and near zero along the normal.
  const alongRamp = new THREE.Vector3(0, -14, -14);
  const runtime2 = createCrackedSurfaceRuntime([tilted]);
  runtime2.step(onGlass, onGlass, alongRamp, TICK);
  check(runtime2.isCracked('ramp') && !runtime2.isBroken('ramp'),
    'riding fast ALONG tilted glass is the carried cost — normal speed, not vertical speed');
}

// ---- a standing pane met by the walker's BODY, not their feet ------------------------------------------------
{
  // A vertical pane at chest height: bottom edge 0.9 m up, top at 2 m. The walker's feet chord passes clean
  // underneath it — the bug this guards is the on-foot rider's upper body sailing through unbroken glass while
  // only a jump (feet lifted into board reach) registered.
  const chestPane = () => {
    const a = new THREE.Vector3(-2, 0.9, 0), b = new THREE.Vector3(2, 0.9, 0);
    const c = new THREE.Vector3(2, 2, 0), d = new THREE.Vector3(-2, 2, 0);
    return {
      key: 'chest', strength: 5, lifetimeSeconds: -1,
      box: new THREE.Box3(new THREE.Vector3(-2, 0.9, -0.1), new THREE.Vector3(2, 2, 0.1)),
      triangles: [new THREE.Triangle(a, b, c), new THREE.Triangle(a, c, d)],
    };
  };
  const walkThrough = { from: new THREE.Vector3(0, 0, -1), to: new THREE.Vector3(0, 0, 1) };
  const runVel = new THREE.Vector3(0, 0, 8.13); // full on-foot run, straight into the pane's normal
  const feet = createCrackedSurfaceRuntime([chestPane()]);
  feet.step(walkThrough.from, walkThrough.to, runVel, TICK);
  check(feet.strengthOf('chest') === 5, 'a feet-point presence still walks under a chest-high pane untouched');
  const standing = createCrackedSurfaceRuntime([chestPane()]);
  standing.step(walkThrough.from, walkThrough.to, runVel, TICK, 1.72);
  check(standing.isBroken('chest'),
    'the standing body registers the same pane, and running straight through it is the impact price');
}

// ---- a Superman-speed pass still sweeps its real chord -------------------------------------------------------
{
  // 250 m/s of genuine flight covers 12.5 m in one 0.05 s frame — far past the old 5 m teleport cutoff, whose
  // destination-point fallback let a fast flyer cross a pane unregistered. The velocity vouches for the chord.
  const from = new THREE.Vector3(-6, 0.3, 0), to = new THREE.Vector3(6.5, 0.3, 0);
  const flightVel = new THREE.Vector3(250, 0, 0);
  const fast = createCrackedSurfaceRuntime([surface()]);
  fast.step(from, to, flightVel, 0.05);
  check((fast.strengthOf('pane') ?? 5) < 5, 'a 250 m/s pass across a pane registers along its real chord');
  // The same chord with no velocity behind it IS a teleport, and must stay a destination-only point test —
  // the destination here is off the pane, so nothing charges.
  const teleport = createCrackedSurfaceRuntime([surface()]);
  teleport.step(from, to, new THREE.Vector3(0, 0, 0), 0.05);
  check(teleport.strengthOf('pane') === 5, 'a chord the velocity cannot explain still charges nothing en route');
}

// ---- an untouched surface is inert ---------------------------------------------------------------------------
{
  const runtime = createCrackedSurfaceRuntime([surface()]);
  const away = new THREE.Vector3(500, 0, 500);
  for (let t = 0; t < 5; t += TICK) runtime.step(away, away, RIDE_VEL, TICK);
  check(!runtime.isCracked('pane') && !runtime.isBroken('pane'),
    'a surface nobody rides is never cracked — the drain is contact, not time');
  check(runtime.strengthOf('pane') === 5, 'and it holds its authored strength');
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nCRACKED SURFACE TESTS PASSED');
process.exit(failures ? 1 : 0);
