// tier: fast

import * as THREE from 'three';
import { createBoostVolumeRuntime, type BoostVolume } from '../src/app/ride/boost-volumes';
import { createFinishCrossing, createLapCounter } from '../src/app/ride/laps';
import {
  DEFAULT_RACE_MODE, DEFAULT_SHOWOFF_SECONDS, formatRunClock, normalizeRaceMode, raceModeIsTimed,
  scoringEffectsApplyInMode,
} from '../src/core/doc/race';
import { check, failures } from './check';

/**
 * The MainType-0 boost family's ride behaviour ([Trailmap: 360-node-apply, 360-zboost, 360-tubeend]). These are
 * containment-driven volumes, so every case here steps a rider through a box rather than firing an event.
 *
 * The LAP COUNTDOWN is here too rather than in a file of its own, because it is not separable: the lap-gated
 * volume exists to read it ([Trailmap: 390-lap-counter]), and testing either without the other tests half a
 * mechanism.
 */
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;
const H = 1 / 60;
const boxAt = (min: THREE.Vector3, max: THREE.Vector3) => new THREE.Box3(min, max);
const UNIT = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
/** The lifetime every scripted boost in the retail corpus carries — mode 1, window 0, i.e. the node lives
 *  exactly as long as contact does ([Trailmap: 360-node-mode]). Modes 0 and 2+ get their own cases below. */
const MODE1 = { mode: 1, seconds: 0 };

// ---- sub-7 directional: a first-order lag along a world axis, add-only ------------------------------------
{
  const volume: BoostVolume = {
    key: 'v', box: UNIT,
    spec: { kind: 'directional', dir: new THREE.Vector3(0, 0, 1), target: 20, rate: 4, ...MODE1 },
  };
  const rt = createBoostVolumeRuntime([volume]);
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  rt.step(pos, vel, H);
  check(near(vel.z, (20 - 0) * 4 * H), 'directional: first tick adds deficit x rate x dt');

  // Converges on the target rather than blowing past it.
  for (let i = 0; i < 600; i++) rt.step(pos, vel, H);
  check(vel.z > 19.9 && vel.z <= 20.0001, 'directional: converges on the target and does not overshoot');

  // Add-only: a rider already faster along the axis is left alone, so a boost never brakes.
  const fast = new THREE.Vector3(0, 0, 40);
  rt.step(pos, fast, H);
  check(near(fast.z, 40), 'directional: never brakes a rider already faster along the axis');

  // Outside the box nothing happens at all.
  const away = new THREE.Vector3(0, 500, 0), still = new THREE.Vector3();
  rt.step(away, still, H);
  check(still.lengthSq() === 0, 'directional: no effect outside the volume');
}

// ---- sub-18 vertical lift: kills horizontal, aims at an altitude, snaps on arrival -------------------------
{
  const spec = {
    kind: 'vertical-lift' as const, dir: new THREE.Vector3(0, 1, 0), target: 25, rate: 4,
    targetY: 40, snapTolerance: 0,
  };
  const rt = createBoostVolumeRuntime([{ key: 'z', box: UNIT, spec }]);
  const pos = new THREE.Vector3(0, 0, 0), vel = new THREE.Vector3(9, 0, -7);
  rt.step(pos, vel, H);
  check(vel.x === 0 && vel.z === 0, 'vertical lift: cancels horizontal velocity');
  check(near(vel.y, 25 * 4 * H), 'vertical lift: drives vertical speed toward the target');

  // Zero tolerance never snaps — it eases the whole way in.
  const easing = new THREE.Vector3(0, 39.99, 0), ev = new THREE.Vector3();
  rt.step(easing, ev, H);
  check(near(easing.y, 39.99), 'vertical lift: zero tolerance never snaps');

  // A rider at or above the target is released rather than held.
  const above = new THREE.Vector3(0, 45, 0), av = new THREE.Vector3(3, 0, 0);
  rt.step(above, av, H);
  check(av.x === 3, 'vertical lift: releases a rider at or above the target altitude');

  // A tolerance wider than the gap snaps on the first tick — and leaves the CLIMB intact, which is what the
  // tube-end launch then builds on. The horizontal still goes: the engine zeroes X and Y on both exits of the
  // node, the arrival branch included ([Trailmap: 360-zboost]).
  const snapRt = createBoostVolumeRuntime([{ key: 's', box: UNIT, spec: { ...spec, snapTolerance: 1e6 } }]);
  const sp = new THREE.Vector3(0, -30, 0), sv = new THREE.Vector3(5, 12, -3);
  snapRt.step(sp, sv, H);
  check(near(sp.y, 40), 'vertical lift: a tolerance wider than the gap snaps on the first tick');
  check(near(sv.y, 12), 'vertical lift: the arrival snap writes the altitude and leaves the climb');
  check(sv.x === 0 && sv.z === 0, 'vertical lift: ...and cancels horizontal on the snap exit too');
}

// ---- presence is the tick's SWEPT movement, not the point it ended on -------------------------------------
{
  // The engine gates every node in the family on an IntersectLineQuery over the movement ([Trailmap: 360-zboost]).
  // A thin plate is what makes the difference visible: at ride speed a rider steps clean over one between two
  // samples, and a point test then reports it was never there at all.
  const plate = new THREE.Box3(new THREE.Vector3(-50, -1, -0.25), new THREE.Vector3(50, 1, 0.25));
  const spec = { kind: 'directional' as const, dir: new THREE.Vector3(0, 0, 1), target: 30, rate: 6, ...MODE1 };

  const swept = createBoostVolumeRuntime([{ key: 'p', box: plate, spec }]);
  const sweptVel = new THREE.Vector3(0, 0, 25);
  swept.step(new THREE.Vector3(0, 0, 0.4), sweptVel, H, new THREE.Vector3(0, 0, -0.4));
  check(sweptVel.z > 25, 'sweep: a rider that crossed a thin plate this tick is pushed by it');

  const pointOnly = createBoostVolumeRuntime([{ key: 'p', box: plate, spec }]);
  const pointVel = new THREE.Vector3(0, 0, 25);
  pointOnly.step(new THREE.Vector3(0, 0, 0.4), pointVel, H);
  check(near(pointVel.z, 25), 'sweep: and without the movement there is nothing but the end point to test');

  // A movement that misses the box entirely still misses it.
  const past = createBoostVolumeRuntime([{ key: 'p', box: plate, spec }]);
  const pastVel = new THREE.Vector3(0, 0, 25);
  past.step(new THREE.Vector3(0, 40, 0.4), pastVel, H, new THREE.Vector3(0, 40, -0.4));
  check(near(pastVel.z, 25), 'sweep: a movement clean over the box is still no contact');
}

// ---- sub-15 lap-gated: lifts, and latches a stage the tube-end volume reads --------------------------------
{
  const box = boxAt(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 100, 10));
  const spec = {
    kind: 'lap-gated' as const, dir: new THREE.Vector3(0, 1, 0), target: 25, rate: 5,
    axis: new THREE.Vector3(1, 0, 0), stageFloorOffset: 10,
  };
  // Below the floor line the stage is 0 — which is what a real run of the retail course produces, because the
  // rider enters at the shaft base and the answer is latched there.
  const low = createBoostVolumeRuntime([{ key: 'l', box, spec }]);
  const lp = new THREE.Vector3(5, 4, 0), lv = new THREE.Vector3(6, 0, 6);
  low.step(lp, lv, H);
  check(low.stage === 0, 'lap-gated: below the floor line latches stage 0');
  check(lv.x === 0 && lv.z === 0, 'lap-gated: cancels horizontal velocity');
  check(near(lv.y, 25 * 5 * H), 'lap-gated: lifts toward the target');

  // Above it, the side of the box centre along the host axis decides.
  const hi = createBoostVolumeRuntime([{ key: 'l', box, spec }]);
  hi.step(new THREE.Vector3(-5, 60, 0), new THREE.Vector3(), H);
  check(hi.stage === 1, 'lap-gated: negative side of the box centre latches stage 1');
  const hi2 = createBoostVolumeRuntime([{ key: 'l', box, spec }]);
  hi2.step(new THREE.Vector3(5, 60, 0), new THREE.Vector3(), H);
  check(hi2.stage === 2, 'lap-gated: positive side latches stage 2');

  // Latched on ENTRY and never revised: crossing the centre later must not re-classify.
  hi2.step(new THREE.Vector3(-9, 60, 0), new THREE.Vector3(), H);
  check(hi2.stage === 2, 'lap-gated: the stage is latched on entry and never revised');
  // Leaving and re-entering does classify afresh, as a rebuilt node would.
  hi2.step(new THREE.Vector3(0, 500, 0), new THREE.Vector3(), H);
  hi2.step(new THREE.Vector3(-9, 60, 0), new THREE.Vector3(), H);
  check(hi2.stage === 1, 'lap-gated: leaving the volume re-arms classification');

  // The GATE: entry hands the crossing to the counter (enterLapVolume) and reads what it leaves — nonzero
  // lifts, zero is the pass that ends the race riding through ([Trailmap: 360-lapboost-gate]).
  let remaining = 2;
  const gated = createBoostVolumeRuntime([{ key: 'l', box, spec }], { enterLapVolume: () => remaining });
  const gv = new THREE.Vector3(6, 0, 6);
  gated.step(new THREE.Vector3(5, 4, 0), gv, H);
  check(gv.y > 0 && gv.x === 0, 'lap-gated: lifts while laps remain');

  remaining = 0;
  const final = createBoostVolumeRuntime([{ key: 'l', box, spec }], { enterLapVolume: () => remaining });
  const fv = new THREE.Vector3(6, 0, 6);
  final.step(new THREE.Vector3(5, 4, 0), fv, H);
  check(fv.x === 6 && fv.z === 6 && fv.y === 0, 'lap-gated: the final lap is skipped entirely, not merely unlifted');

  // Counted once WITH the latch: the crossing lands on entry, and no re-read mid-contact can drop a rider out
  // of a lift already under way.
  remaining = 1;
  const midway = createBoostVolumeRuntime([{ key: 'l', box, spec }], { enterLapVolume: () => remaining });
  const mv = new THREE.Vector3();
  midway.step(new THREE.Vector3(5, 4, 0), mv, H);
  remaining = 0;
  const before = mv.y;
  midway.step(new THREE.Vector3(5, 6, 0), mv, H);
  check(mv.y > before, 'lap-gated: the crossing is counted with the latch, so a lift already under way finishes');

  // No counter at all (a world that races no laps) lifts on every pass — the has-laps-left branch.
  const ungated = createBoostVolumeRuntime([{ key: 'l', box, spec }]);
  const uv = new THREE.Vector3();
  ungated.step(new THREE.Vector3(5, 4, 0), uv, H);
  check(uv.y > 0, 'lap-gated: a world with no lap count takes the has-laps-left branch');
}

// ---- the lap countdown itself: seed, crossings, and the final lap -------------------------------------------
{
  // A course running along +Z, finishing at the origin.
  const course = [new THREE.Vector3(0, 0, -100), new THREE.Vector3(0, 0, 0)];
  check(createLapCounter(course, 1) === null, 'laps: a single-pass course counts nothing');
  check(createLapCounter(undefined, 5) === null, 'laps: no course line means no countdown');

  // A one-pass course still owns a finish even though it has no LAP countdown. This is the event that freezes
  // the WebXR race result on the wrist.
  const finish = createFinishCrossing(course)!;
  check(finish.step(new THREE.Vector3(0, 0, -20)) === false,
    'finish: approaching a one-pass finish does not end the race');
  check(finish.step(new THREE.Vector3(0, 0, 5)) === true,
    'finish: the first forward crossing ends a one-pass race');
  check(finish.step(new THREE.Vector3(0, 0, 8)) === false,
    'finish: lingering beyond the plane cannot finish twice');
  finish.step(new THREE.Vector3(0, 0, -20));
  check(finish.step(new THREE.Vector3(0, 0, 5)) === true,
    'finish: returning behind the plane re-arms it for a later lap');

  const laps = createLapCounter(course, 5)!;
  check(laps.remaining === 5 && laps.lap === 1, 'laps: the countdown seeds the pass count — retail\'s own seed');

  // MEGAPLEX's four: the lap TUBE's mouth is the crossing station every mid-race pass actually ends at — the
  // finish plane sits down-course of the tube, reached only by the pass the tube declines to lift. Entry
  // counts the crossing and the gate reads what it leaves: 3, 2, 1 lifted, 0 ridden through, and the plane
  // below ends that last pass ([Trailmap: 390-lap-rate, 390-lap-field, 360-lapboost-gate]).
  const mega = createLapCounter(course, 4)!;
  const gate: number[] = [];
  // A lap's worth of riding between tube visits, comfortably past the cross-station debounce.
  const roundTrip = () => { for (let i = 0; i < 200; i++) mega.step(new THREE.Vector3(0, 0, -30)); };
  for (let i = 0; i < 4; i++) { mega.enterLapVolume(); gate.push(mega.remaining); roundTrip(); }
  check(gate.join(',') === '3,2,1,0', `laps: MEGAPLEX's tube entries read ${gate.join(',')} — lifted thrice, through on the fourth`);
  check(!mega.finished, 'laps: the tube never ends the run — the ride-through still has the plane to reach');
  check(mega.step(new THREE.Vector3(0, 0, 5)) === false && mega.finished,
    'laps: the plane ends the pass the tube declined to lift');

  // Two stations, one crossing: a crossing one station just counted is spent at the other.
  const planeFirst = createLapCounter(course, 4)!;
  planeFirst.step(new THREE.Vector3(0, 0, -30));
  check(planeFirst.step(new THREE.Vector3(0, 0, 5)) === true && planeFirst.remaining === 3,
    'laps: the plane station counts a crossing');
  check(planeFirst.enterLapVolume() === false && planeFirst.remaining === 3,
    'laps: a tube entry moments later is the same crossing');
  const tubeFirst = createLapCounter(course, 4)!;
  check(tubeFirst.enterLapVolume() === true && tubeFirst.remaining === 3,
    'laps: a tube entry counts and announces the crossing');
  tubeFirst.step(new THREE.Vector3(0, 0, -30));
  check(tubeFirst.step(new THREE.Vector3(0, 0, 5)) === false && tubeFirst.remaining === 3,
    'laps: ...and the plane moments later does not count it again');

  // Approaching but not yet across counts nothing.
  check(laps.step(new THREE.Vector3(0, 0, -20)) === false, 'laps: approaching the finish counts nothing');
  check(laps.step(new THREE.Vector3(0, 0, 5)) === true, 'laps: crossing the line counts a lap');
  check(laps.remaining === 4 && laps.lap === 2, 'laps: a counted lap decrements the countdown');

  // Lingering past the line cannot count twice; going back behind it re-arms.
  check(laps.step(new THREE.Vector3(0, 0, 8)) === false, 'laps: lingering past the line does not re-count');
  laps.step(new THREE.Vector3(0, 0, -30));
  check(laps.step(new THREE.Vector3(0, 0, 5)) === true, 'laps: going round again counts the next lap');
  check(laps.remaining === 3, 'laps: the countdown keeps falling');

  // Wide of the course entirely: not a finish crossing.
  laps.step(new THREE.Vector3(0, 0, -30));
  check(laps.step(new THREE.Vector3(500, 0, 5)) === false, 'laps: crossing far wide of the line is not a finish');

  // Nor far ABOVE it: the plane is a gate at the mountain's surface, and MEGAPLEX's tube-end launch crosses
  // its plan position ~500 m overhead on the way back up the mountain — a phantom lap if it counted.
  const overhead = createLapCounter(course, 4)!;
  overhead.step(new THREE.Vector3(0, 0, -30));
  check(overhead.step(new THREE.Vector3(0, 480, 5)) === false && overhead.remaining === 4,
    'laps: crossing the plane far overhead is not a finish');
  overhead.step(new THREE.Vector3(0, 0, -30));
  check(overhead.step(new THREE.Vector3(0, 0, 5)) === true && overhead.remaining === 3,
    'laps: ...and the real crossing at the surface still counts');

  // Run it down to the last crossing: the counter lands on zero there and the run is finished.
  for (let i = 0; i < 4; i++) { laps.step(new THREE.Vector3(0, 0, -30)); laps.step(new THREE.Vector3(0, 0, 5)); }
  check(laps.remaining === 0 && laps.lap === 5, 'laps: the countdown lands on zero at the last crossing');
  check(laps.finished, 'laps: the crossing that lands zero finishes the run');

  // Starting already past the finish must not read as an immediate crossing.
  const fresh = createLapCounter(course, 3)!;
  check(fresh.step(new THREE.Vector3(0, 0, 5)) === false, 'laps: starting past the line is not a crossing');
  check(fresh.remaining === 3, 'laps: ...and leaves the countdown seeded');
}

// ---- the run clock: one reading, two events ----------------------------------------------------------------
// The test ride's clock is the engine's own arrangement — one number that a race reads as elapsed and a showoff
// run reads as remaining ([Trailmap: 390-showoff-clock]) — written in the precision a race result is stored in.
{
  check(formatRunClock(0) === '0:00.00', 'clock: a run opens at 0:00.00');
  check(formatRunClock(83.456) === '1:23.45', 'clock: minutes, seconds and centiseconds, truncated not rounded');
  check(formatRunClock(-4) === '0:00.00',
    'clock: an expired countdown reads zero rather than counting on into the red');

  // What the HUD is handed in each mode, off a mountain seeded with Garibaldi's own 120 s.
  const elapsed = 12.5, budget = DEFAULT_SHOWOFF_SECONDS;
  check(formatRunClock(elapsed) === '0:12.50', 'clock: a race counts UP from zero');
  check(formatRunClock(budget - elapsed) === '1:47.50', 'clock: showoff counts the same ride DOWN from its budget');
  check(formatRunClock(budget - (budget + 1)) === '0:00.00', 'clock: past the budget it lands on zero, not below');

  // Free ride has no clock; a new bench opens in Showoff so the native trick layer is visible.
  check(!raceModeIsTimed('freeride'), 'clock: a free ride runs no clock');
  check(raceModeIsTimed('race') && raceModeIsTimed('showoff'), 'clock: ...and both events do');
  check(DEFAULT_RACE_MODE === 'showoff', 'clock: a test ride opens in showoff mode');
  check(normalizeRaceMode('showoff') === 'showoff' && normalizeRaceMode('nonsense') === DEFAULT_RACE_MODE,
    'clock: a stored mode round-trips, and anything unrecognized reads as the default');
  check(scoringEffectsApplyInMode('showoff') && !scoringEffectsApplyInMode('race')
    && !scoringEffectsApplyInMode('freeride'),
    'mode gate: gem/scoring opcodes apply only in showoff');
}

// ---- sub-24 tube-end: the recorded stage picks the launch pair ---------------------------------------------
{
  const stages = [
    { dir: new THREE.Vector3(1, 0, 0), speed: 27 },
    { dir: new THREE.Vector3(0, 1, 0), speed: 35 },
    { dir: new THREE.Vector3(0, 0, 1), speed: 35 },
  ];
  for (const [stage, axis, speed] of [[0, 'x', 27], [1, 'y', 35], [2, 'z', 35]] as const) {
    const rt = createBoostVolumeRuntime([{ key: 't', box: UNIT, spec: { kind: 'tube-end', stages, rate: 2, ...MODE1 } }]);
    rt.stage = stage;
    const pos = new THREE.Vector3(), vel = new THREE.Vector3();
    rt.step(pos, vel, H);
    check(near(vel[axis], speed * 2 * H), `tube-end: stage ${stage} launches along its own pair at ${speed} m/s`);
  }

  // The captured axis is fixed on entry, so re-pointing the stage mid-flight does not steer the rider.
  const rt = createBoostVolumeRuntime([{ key: 't', box: UNIT, spec: { kind: 'tube-end', stages, rate: 2, ...MODE1 } }]);
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  rt.step(pos, vel, H);
  rt.stage = 2;
  rt.step(pos, vel, H);
  check(vel.z === 0, 'tube-end: the launch axis is captured on entry, not re-read per tick');
}

// ---- the lifetime rule: what the mode word does to the push ([Trailmap: 360-node-mode]) --------------------
// Every retail placement is mode 1, so these guard AUTHORED content: the effects editor offers the field and
// documents its meaning, and a mode that makes a node inert on PS2 must not push here.
{
  const dir = new THREE.Vector3(0, 0, 1);
  const push = (mode: number, seconds: number, ticks = 1) => {
    const rt = createBoostVolumeRuntime([{ key: 'm', box: UNIT,
      spec: { kind: 'directional', dir: dir.clone(), target: 20, rate: 4, mode, seconds } }]);
    const pos = new THREE.Vector3(), vel = new THREE.Vector3();
    for (let i = 0; i < ticks; i++) rt.step(pos, vel, H);
    return vel.z;
  };

  check(push(1, 0) > 0, 'mode 1: the retail lifetime pushes from the first tick of contact');
  check(push(2, 0) === 0, 'mode 2: never seeded, retires on its first tick — inert, so it pushes nobody');
  check(push(7, 0) === 0, 'mode >2: any other unseeded mode is inert the same way');

  // Mode 0 is a COOLDOWN, not a window: while it runs the push is suppressed, and the node never retires.
  check(push(0, 0) > 0, 'mode 0 with a zero cooldown pushes immediately — nothing to wait out');
  check(push(0, 1.0, 30) === 0, 'mode 0: the push is suppressed for the whole cooldown');
  check(push(0, 1.0, 90) > 0, 'mode 0: ...and resumes once it has run, rather than retiring');

  // The tube-end launch runs sub-7's update, so it carries sub-7's lifetime.
  const stages = [{ dir: new THREE.Vector3(0, 0, 1), speed: 27 }];
  const inert = createBoostVolumeRuntime([{ key: 't', box: UNIT,
    spec: { kind: 'tube-end', stages, rate: 2, mode: 2, seconds: 0 } }]);
  const tv = new THREE.Vector3();
  inert.step(new THREE.Vector3(), tv, H);
  check(tv.lengthSq() === 0, 'tube-end: inherits the mode, so an inert one launches nobody');
}

// ---- the vertical lift RETIRES once it has nobody left to lift ([Trailmap: 360-zboost]) --------------------
// Its alive flag is set by a rider it lifted and by nothing else, so the first tick everyone inside is at or
// above the target is the tick the node ends. Without this the volume is a trampoline: the lift cancels
// horizontal motion every tick, so a rider carried to the ceiling cannot travel out of the box — they fall
// back through the target, qualify again, and are lifted again indefinitely.
{
  const spec = {
    kind: 'vertical-lift' as const, dir: new THREE.Vector3(0, 1, 0), target: 25, rate: 4,
    targetY: 10, snapTolerance: 0,
  };
  const rt = createBoostVolumeRuntime([{ key: 'z', box: UNIT, spec }]);
  const pos = new THREE.Vector3(0, 0, 0), vel = new THREE.Vector3();

  // Climb until the rider crosses the target, integrating the lift's own output.
  let ticks = 0;
  while (pos.y < spec.targetY && ticks < 6000) { rt.step(pos, vel, H); pos.addScaledVector(vel, H); ticks++; }
  check(pos.y >= spec.targetY, 'vertical lift: carries the rider up to the target altitude');

  // ONE more tick, and it is the whole mechanism rather than bookkeeping: the node retires on the tick it
  // finds nobody left to lift, which is the tick AFTER the rider crossed. The crossing itself is still a tick
  // the node spent lifting them.
  rt.step(pos, vel, H);

  // Now fall back through it. The node is gone, so nothing catches them.
  vel.set(2, -5, 3);
  const below = new THREE.Vector3(0, spec.targetY - 3, 0);
  rt.step(below, vel, H);
  check(vel.y === -5, 'vertical lift: a rider falling back through the target is NOT lifted again');
  check(vel.x === 2 && vel.z === 3, 'vertical lift: ...and a retired node cancels no horizontal either');

  // Leaving and re-entering is a fresh contact, which the engine answers with a fresh node.
  rt.step(new THREE.Vector3(0, 500, 0), new THREE.Vector3(), H);
  const again = new THREE.Vector3(0, 0, 0), againVel = new THREE.Vector3();
  rt.step(again, againVel, H);
  check(againVel.y > 0, 'vertical lift: re-entering builds a new node and lifts again');

  // A rider who arrives already at or above the target is dropped, and that drop retires the node too —
  // the engine's alive flag is only ever set by a rider it LIFTED.
  const high = createBoostVolumeRuntime([{ key: 'z', box: UNIT, spec }]);
  const highVel = new THREE.Vector3(3, -1, 4);
  high.step(new THREE.Vector3(0, spec.targetY + 5, 0), highVel, H);
  check(highVel.x === 3 && highVel.z === 4, 'vertical lift: a rider entering above the target is left alone');
  const sinking = new THREE.Vector3(0, spec.targetY - 2, 0), sinkVel = new THREE.Vector3(0, -5, 0);
  high.step(sinking, sinkVel, H);
  check(sinkVel.y === -5, 'vertical lift: ...and that release ended the node, so sinking back finds nothing');
}

console.log(failures ? `\n${failures} FAILED` : '\nboost-volumes: all checks passed');
process.exit(failures ? 1 : 0);
