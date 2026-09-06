/**
 * How far does a boost node throw the rider in THIS ride, at Megaplex's own tuning and Megaplex's own box?
 *
 *   npx tsx tools/ride-study/boost-throw.ts
 *
 * The companion to the PS2 harness cell `vent-throw` (`Trailmap/tools/autotest`, fixture AUTOTEST2). Both run
 * retail's exhaust-vent slot verbatim — mode 1, window 0, rate 3.0, target 100 m/s, straight up — inside a box
 * carrying `Mdl_Exaust_BOOST_Volume_0`'s own 3.29 m of height and 3.60 m of depth, and both report the same
 * three numbers off the same definitions:
 *
 *   rise    peak vertical speed, m/s
 *   climb   metres of altitude gained after the volume was first entered — the throw
 *   speed   peak carried speed, the whole vector, where a cap shows up
 *
 * So the two outputs are read column against column. A port that matches `rise` and misses `climb` has the
 * push right and something after it wrong; one that misses `rise` has the dwell or the lag wrong.
 *
 * It also runs the path a boost node USED to take on top of that one, and keeps running it because the
 * numbers are the reason it is gone. `boost-volumes.ts` is the containment runtime that acts every tick a
 * rider is inside. Beside it, the debounced collision-graph dispatch delivered the lag's closed-form integral
 * over a whole debounce interval as a single impulse — and every host that gets a volume also runs its
 * collision graph, so a boost node was applied BOTH ways. A run with all three rows is what says the
 * difference is a factor rather than a nuance.
 */
import * as THREE from 'three';
import { createRideModel } from '../../src/app/ride/physics';
import { RIDE_BOOST_MAX_SPEED } from '../../src/app/ride/ride-contract.generated';
import type { BoostVolume, BoostVolumeSpec } from '../../src/app/ride/boost-volumes';

/** Retail's exhaust-vent slot: MEGAPLE slot:0100, shared by `Mdl_Exaust_BOOST_Volume_0..11`
 *  ([Trailmap: 360-node-corpus]). Authored in m/s, which is the unit a port works in. */
const VENT = { rate: 3, target: 100, dir: new THREE.Vector3(0, 1, 0) };

/**
 * Retail's air-shaft Z boost: MEGAPLE slot:0092 `Mdl_twinAirShaft_BOOST_0`, read straight out of the
 * extracted `Effects.json` as `U0`=4, `U1`=20, axis (0,0,1), `U5`=−12000, `U6`=0
 * ([Trailmap: 360-zboost-corpus]). Its host sits at raw Z −13487.9, so the authored absolute altitude is a
 * **14.9 m lift**, and the zero tolerance means it never snaps — it eases the whole way in.
 *
 * The push is not a second mechanism to measure: the Z boost uses the same 1/60-scaled directional update
 * ([Trailmap: 360-zboost]). What is
 * its own are the three things wrapped around it — horizontal motion cancelled every tick, an ALTITUDE rather
 * than a speed as the goal, and the snap that closes the ride out. So this case exists to check the wrapper,
 * and the PS2 cell measures the push both of them share.
 */
const SHAFT = { rate: 4, target: 20, liftM: 14.9, snapTolerance: 0 };

/** The host model's own extents, read off the extracted mesh: 3.60 x 3.12 x 3.29 m in model X/Y/Z, Z being
 *  world up. Only the vertical and the along-travel one govern dwell; the third is across the rider's line and
 *  is widened here for the same reason the PS2 fixture widens it — a probe with no steering must not miss. */
const VENT_HEIGHT_M = 3.29;
const VENT_DEPTH_M = 3.6;

/** The editor's Play-mode collision-graph rate limiter (`reference-effects.ts`). */
const DEBOUNCE_SECONDS = 50 / 60;

const H = 1 / 60;
const KEYS = { left: false, right: false, tuck: false, brake: false, boost: false };
const STICK = { active: false, x: 0 };

/** A single planar face tilted `pitch` degrees down the +Z axis, big enough to run on. */
function slope(pitchDeg: number, extent = 4000): THREE.Mesh {
  const t = Math.tan((pitchDeg * Math.PI) / 180);
  const y = (z: number) => -z * t;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -extent, y(-extent), -extent, -extent, y(extent), extent, extent, y(-extent), -extent,
    extent, y(-extent), -extent, -extent, y(extent), extent, extent, y(extent), extent,
  ], 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

interface Reading {
  /** Peak vertical speed, m/s. */
  rise: number;
  /** Metres of altitude gained from the tick the rider first entered the box. */
  climb: number;
  /** Peak carried speed, m/s — the whole vector. */
  speed: number;
  /** Ticks the rider's swept segment met the box. The number every other number follows from. */
  ticksInside: number;
  /** Speed carried into the box, m/s, so a run that entered slow is not read as a weak push. */
  entrySpeed: number;
}

/**
 * Ride down a slope, cross a vent, report the throw.
 *
 * `containment` runs the per-tick volume; `impulse` runs the debounced dispatch. Both together is what the
 * ride did to a boost node before the dispatch half was removed.
 */
function run(opts: { containment: boolean; impulse: boolean; heightM?: number; lift?: boolean }): Reading {
  const pitch = 18;
  const terrain = slope(pitch);
  const surfaceY = (z: number) => -z * Math.tan((pitch * Math.PI) / 180);

  // Far enough down the slope that the rider is at settled course speed before they reach it.
  const boxZ = 260;
  const floor = surfaceY(boxZ);
  // CENTRED on the surface, which is where the PS2 fixture puts it (`pos.y = ground + size[1]/2`) and where
  // retail's own vent sits — its host origin is 1.34 m up inside a 3.29 m box. Anchoring the FLOOR at the
  // surface instead looks equivalent on paper and is not: over 3.6 m of an 18-degree slope the ground falls
  // 1.17 m, so a floor-anchored box drops the rider out through its own bottom face a metre into the
  // crossing, and the run reads two ticks of dwell for a box that should give eight.
  const heightM = opts.heightM ?? VENT_HEIGHT_M;
  const box = new THREE.Box3(
    new THREE.Vector3(-60, floor - heightM / 2, boxZ - VENT_DEPTH_M / 2),
    new THREE.Vector3(60, floor + heightM / 2, boxZ + VENT_DEPTH_M / 2),
  );
  const spec: BoostVolumeSpec = opts.lift
    ? {
      kind: 'vertical-lift', dir: VENT.dir.clone(), target: SHAFT.target, rate: SHAFT.rate,
      targetY: floor + SHAFT.liftM, snapTolerance: SHAFT.snapTolerance,
    }
    : { kind: 'directional', dir: VENT.dir.clone(), target: VENT.target, rate: VENT.rate, mode: 1, seconds: 0 };
  const volume: BoostVolume = { key: 'vent', box, spec };

  const model = createRideModel({
    spawn: new THREE.Vector3(0, surfaceY(0) + 1, 0), heading: new THREE.Vector3(0, 0, 1),
    terrain, surfaceOf: () => 1, oobFloorY: surfaceY(4000) - 500,
    keys: KEYS, stick: STICK, onRespawn: () => {},
    ...(opts.containment ? { boostVolumes: [volume] } : {}),
  });
  model.start();

  let rise = -Infinity, speed = 0, ticksInside = 0, entrySpeed = 0;
  let base: number | null = null, climb = 0, nextImpulse = 0, left = false;
  const previous = new THREE.Vector3().copy(model.st.pos);
  for (let tick = 0; tick < 60 * 40; tick++) {
    model.step(H);
    const inside = box.containsPoint(model.st.pos)
      || segmentMeetsBox(box, previous, model.st.pos);
    previous.copy(model.st.pos);
    if (inside) {
      if (base === null) { base = model.st.pos.y; entrySpeed = model.st.vel.length(); }
      ticksInside++;
      // The debounced half, on the editor's own cadence: one closed-form impulse per debounce interval, which
      // is what `reference-effects.ts` dispatches for a `property.boost` node it also builds a volume for.
      if (opts.impulse && tick * H >= nextImpulse) {
        applyRemovedImpulse(model, DEBOUNCE_SECONDS);
        nextImpulse = tick * H + DEBOUNCE_SECONDS;
      }
    } else if (base !== null) left = true;
    if (base !== null) {
      rise = Math.max(rise, model.st.vel.y);
      speed = Math.max(speed, model.st.vel.length());
      climb = Math.max(climb, model.st.pos.y - base);
      // Stop only once the rider has LEFT the box and fallen back under the altitude they entered at. The
      // test cannot also be the exit test: the course descends, so a rider still crossing the box is under
      // their entry altitude on the very next tick, and reading that as "the throw is over" ended the run
      // two ticks in and reported a nine-tick crossing as two.
      if (left && model.st.vel.y < 0 && model.st.pos.y < base) break;
    }
  }
  return {
    rise: round(rise === -Infinity ? 0 : rise), climb: round(climb), speed: round(speed),
    ticksInside, entrySpeed: round(entrySpeed),
  };
}

/**
 * The impulse the debounced dispatch used to deliver, reproduced here because it no longer exists in the ride.
 *
 * It integrated the first-order lag over the whole debounce interval and applied the result in one frame, on
 * the reasoning that one firing has to stand in for the interval until the next. The arithmetic is what
 * condemns it: `1 - e^(-rate x seconds)` at rate 3 over 50/60 s is 0.918, so a rider gets 92% of the target in
 * a single tick no matter how briefly they were actually inside the volume — the dwell that the engine's whole
 * model turns on stops mattering. It also raised the speed cap, which a scripted boost node never does.
 */
function applyRemovedImpulse(model: ReturnType<typeof createRideModel>, seconds: number): void {
  const axis = VENT.dir.clone().normalize();
  const deficit = VENT.target - model.st.vel.dot(axis);
  if (deficit <= 0) return;
  model.st.vel.addScaledVector(axis, deficit * (1 - Math.exp(-VENT.rate * seconds)));
  if (model.st.grounded) {
    model.st.speedCap = Math.max(model.st.speedCap, Math.min(RIDE_BOOST_MAX_SPEED, model.st.vel.length()));
  }
}

/** The same slab test the ride's containment uses, so "inside" here means what it means there. */
function segmentMeetsBox(box: THREE.Box3, from: THREE.Vector3, to: THREE.Vector3): boolean {
  let enter = 0, exit = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const a = from[axis], delta = to[axis] - a;
    if (Math.abs(delta) < 1e-9) { if (a < box.min[axis] || a > box.max[axis]) return false; continue; }
    const t0 = (box.min[axis] - a) / delta, t1 = (box.max[axis] - a) / delta;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
    if (enter > exit) return false;
  }
  return true;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * What the PS2 measured, for the row to be read against — autotest cell `vent-throw`, three passes at
 * 20260806-203550 / -203635 / -203900, zero regressions. The spread on `rise` is how squarely each pass
 * crossed the box; `speed` did not move at all, and 33.47 m/s is the top cap tier to three figures.
 */
const RETAIL = { rise: '13.5-21.3', climb: '11.2-20.9', speed: '33.47' };

const cases: { label: string; opts: Parameters<typeof run>[0] }[] = [
  { label: 'vent: what Play does (containment)', opts: { containment: true, impulse: false } },
  { label: 'vent: removed dispatch impulse alone', opts: { containment: false, impulse: true } },
  { label: 'vent: BOTH — what Play used to do', opts: { containment: true, impulse: true } },
  // The Z boost gets a shaft rather than a vent: a 3.3 m box would release the rider through its own roof
  // before a 14.9 m lift had anywhere to go, and the thing being checked is the ALTITUDE gate.
  { label: 'Z boost: air shaft, 14.9 m lift', opts: { containment: true, impulse: false, lift: true, heightM: 40 } },
];

console.log(`Megaplex exhaust vent: rate ${VENT.rate}, target ${VENT.target} m/s, straight up`);
console.log(`  box ${VENT_DEPTH_M} m deep x ${VENT_HEIGHT_M} m tall — the host model's own extents`);
console.log(`Megaplex air shaft:    rate ${SHAFT.rate}, target ${SHAFT.target} m/s, `
  + `lift ${SHAFT.liftM} m, tolerance ${SHAFT.snapTolerance}\n`);
console.log(`${'path'.padEnd(40)} ${'ticks'.padStart(6)} ${'entry'.padStart(7)} `
  + `${'rise'.padStart(8)} ${'climb'.padStart(8)} ${'speed'.padStart(8)}`);
console.log('-'.repeat(82));
for (const item of cases) {
  const r = run(item.opts);
  console.log(`${item.label.padEnd(40)} ${String(r.ticksInside).padStart(6)} `
    + `${r.entrySpeed.toFixed(1).padStart(7)} ${r.rise.toFixed(2).padStart(8)} `
    + `${r.climb.toFixed(2).padStart(8)} ${r.speed.toFixed(2).padStart(8)}`);
}
console.log(`${'PS2, retail vent (3 passes)'.padEnd(40)} ${'~6-7'.padStart(6)} ${'~25'.padStart(7)} `
  + `${RETAIL.rise.padStart(8)} ${RETAIL.climb.padStart(8)} ${RETAIL.speed.padStart(8)}`);
console.log('\nunits: entry/rise/speed m/s, climb m. The PS2 row is autotest cell `vent-throw`.');
console.log('The residual gap on the top row is DWELL, not the model: this probe crosses a 3.6 m box square');
console.log('on at the cap for 9 ticks, where the fixture yaws its box across a corridor and the rider takes');
console.log('whatever line they take — which is the same thing the PS2 spread on `rise` is measuring.');
