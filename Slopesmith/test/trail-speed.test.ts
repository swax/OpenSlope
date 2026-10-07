// tier: fast

/**
 * The predicted trail ride (docs/023 · Predicted speed) held to the ride model itself: the same rider, set off from
 * rest, on straight slopes and over lips built from the predicted profile, must carry the same speed and leave and
 * meet the ground in the same places. Then the network rules — where a path starts, what feeds it — and the colour
 * lookup's local walk. Run: `npx tsx test/trail-speed.test.ts`
 */
import * as THREE from 'three';
import type { AuthoredTrail, TrailSettings, V3 } from '../src/core/doc/types';
import { createRideModel, groundRestDepth, SURFACE_ROWS } from '../src/app/ride/physics';
import { RIDE_MAX_SPEED } from '../src/app/ride/ride-contract.generated';
import { nearestSample, predictTrailSpeeds, type PathSpeeds } from '../src/app/ride/trail-speed';
import { check, failures } from './check';

const settings = {} as TrailSettings;
type Network = Pick<AuthoredTrail, 'points' | 'paths'>;
const onePath = (points: V3[]): Network => ({ points, paths: [{ points: points.map((_, i) => i), settings }] });
const ride = (trail: Network, surface = 1): PathSpeeds => predictTrailSpeeds(trail, () => surface).paths[0]!;

/** A straight run `length` long at `degrees` (negative: downhill) along +Z. */
function straight(degrees: number, length = 300): Network {
  const r = degrees * Math.PI / 180, at = (f: number): V3 => [0, length * f * Math.sin(r), length * f * Math.cos(r)];
  return onePath([at(0), at(0.5), at(1)]);
}

/** Arc length along the predicted samples, and the speed at `metres`. */
function speedAt(path: PathSpeeds, metres: number): number {
  let d = 0;
  for (let i = 1; i < path.n; i++) {
    d += Math.hypot(path.pos[i * 3] - path.pos[i * 3 - 3], path.pos[i * 3 + 1] - path.pos[i * 3 - 2], path.pos[i * 3 + 2] - path.pos[i * 3 - 1]);
    if (d >= metres) return path.speed[i];
  }
  return path.speed[path.n - 1];
}

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };

/**
 * The ride model over a 30 m wide strip laid along the predicted samples (a profile in the YZ plane), set off from rest
 * a couple of metres in — at the very edge its probe can miss the strip — and ridden hands-off. Returns its takeoffs
 * and landings (z), its speed a quarter second after each landing, and its speed by z.
 */
function rideStrip(path: PathSpeeds, seconds = 30) {
  const pos: number[] = [];
  for (let i = 0; i + 1 < path.n; i++) {
    const a = [path.pos[i * 3], path.pos[i * 3 + 1], path.pos[i * 3 + 2]], b = [path.pos[i * 3 + 3], path.pos[i * 3 + 4], path.pos[i * 3 + 5]];
    pos.push(a[0] - 15, a[1], a[2], b[0] - 15, b[1], b[2], a[0] + 15, a[1], a[2], a[0] + 15, a[1], a[2], b[0] - 15, b[1], b[2], b[0] + 15, b[1], b[2]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const terrain = new THREE.Mesh(geometry);
  terrain.updateMatrixWorld(true);
  const s = 4, along = new THREE.Vector3(path.pos[s * 3 + 3] - path.pos[s * 3], path.pos[s * 3 + 4] - path.pos[s * 3 + 1],
    path.pos[s * 3 + 5] - path.pos[s * 3 + 2]).normalize();
  const up = new THREE.Vector3(0, along.z, -along.y).normalize();
  const model = createRideModel({
    spawn: new THREE.Vector3(path.pos[s * 3], path.pos[s * 3 + 1] + 1, path.pos[s * 3 + 2]), heading: along, terrain,
    surfaceOf: () => 1, oobFloorY: -1000, keys, stick, onRespawn: () => {},
  });
  model.start();
  model.st.pos.set(path.pos[s * 3], path.pos[s * 3 + 1], path.pos[s * 3 + 2]).addScaledVector(up, -groundRestDepth(SURFACE_ROWS[1], up.y));
  model.st.vel.set(0, 0, 0);
  model.st.fwd.copy(along);
  model.st.contactN.copy(up);
  model.st.boardUp.copy(up);
  model.st.grounded = true;
  const takeoffs: number[] = [], landings: number[] = [], settled: number[] = [], speeds: [number, number][] = [];
  const end = path.pos[path.n * 3 - 1] - 2;
  let grounded = true, landedAt = -1;
  for (let tick = 0; tick < seconds * 60 && model.st.pos.z < end; tick++) {
    model.step(1 / 60);
    speeds.push([model.st.pos.z, model.st.vel.length()]);
    if (model.st.grounded !== grounded) {
      grounded = model.st.grounded;
      (grounded ? landings : takeoffs).push(model.st.pos.z);
      if (grounded) landedAt = tick;
    }
    if (landedAt >= 0 && tick === landedAt + 15) settled.push(model.st.vel.length());
  }
  return { takeoffs, landings, settled, speedAtZ: (z: number) => speeds.find(([at]) => at >= z)?.[1] ?? NaN };
}

/** The predicted takeoffs and landings (z), and the speed a quarter second's travel after each landing. */
function predictedFlights(path: PathSpeeds) {
  const takeoffs: number[] = [], landings: number[] = [], settled: number[] = [];
  for (let i = 1; i < path.n; i++) {
    if (path.air[i] === path.air[i - 1]) continue;
    const z = path.pos[i * 3 + 2];
    if (path.air[i]) takeoffs.push(z);
    else {
      landings.push(z);
      const v = path.speed[i];
      let j = i;
      while (j + 1 < path.n && path.pos[j * 3 + 2] < z + v * 0.25) j++;
      settled.push(path.speed[j]);
    }
  }
  return { takeoffs, landings, settled };
}

// ---- straight slopes: the same terms as the ride's ground tick --------------------------------------------------

for (const degrees of [0, -10, -20, 30, 50]) {
  const predicted = ride(straight(degrees));
  const real = rideStrip(predicted);
  for (const metres of [20, 150]) {
    const r = degrees * Math.PI / 180, z = metres * Math.cos(r);
    const got = speedAt(predicted, metres), want = real.speedAtZ(z);
    check(Math.abs(got - want) < 0.5, `${degrees}° slope: predicted speed ${metres} m in matches the ride's`,
      `${got.toFixed(2)} vs ${want.toFixed(2)} m/s`);
  }
  check(!real.takeoffs.length && !predicted.air.some(Boolean), `${degrees}° slope: both stay on the ground`);
}
{
  const flat = ride(straight(0));
  check(Math.abs(flat.speed[flat.n - 1] - 13.44) < 0.05, 'flat snow cruises at about 13.4 m/s', `${flat.speed[flat.n - 1].toFixed(2)}`);
  const steep = ride(straight(-35, 400));
  check(Math.abs(steep.topSpeed - RIDE_MAX_SPEED) < 0.05, 'a long steep descent tops out at the speed cap', `${steep.topSpeed.toFixed(2)}`);
  const climb = ride(straight(50));
  check(!climb.stalled && climb.speed[climb.n - 1] > 7.5, 'the cruise drive climbs 50° of snow', `${climb.speed[climb.n - 1].toFixed(2)}`);
}

// ---- lips: the clearance a crest opens throws the rider where the ride's own contact lets go ----------------------

const lips: Record<string, V3[]> = {
  crest: [[0, 30, 0], [0, 10, 60], [0, 4, 90], [0, -2, 100], [0, -25, 130], [0, -50, 180], [0, -55, 260]],
  kicker: [[0, 40, 0], [0, 20, 55], [0, 6, 100], [0, 6.5, 118], [0, 2, 128], [0, -20, 170], [0, -45, 250]],
  'steep drop': [[0, 40, 0], [0, 10, 60], [0, -5, 100], [0, -6, 110], [0, -30, 125], [0, -60, 160], [0, -70, 230]],
};
for (const [name, points] of Object.entries(lips)) {
  const predicted = ride(onePath(points)), real = rideStrip(predicted), flights = predictedFlights(predicted);
  check(flights.takeoffs.length === 1 && real.takeoffs.length === 1, `${name}: one jump, predicted and ridden`,
    `${flights.takeoffs.length} vs ${real.takeoffs.length}`);
  if (flights.takeoffs.length !== 1 || real.takeoffs.length !== 1) continue;
  check(Math.abs(flights.takeoffs[0] - real.takeoffs[0]) < 1.5, `${name}: takes off where the ride does`,
    `z ${flights.takeoffs[0].toFixed(1)} vs ${real.takeoffs[0].toFixed(1)}`);
  check(Math.abs(flights.landings[0] - real.landings[0]) < 2.5, `${name}: lands where the ride does`,
    `z ${flights.landings[0].toFixed(1)} vs ${real.landings[0].toFixed(1)}`);
  check(Math.abs(flights.settled[0] - real.settled[0]) < 2, `${name}: carries the ride's speed out of the landing`,
    `${flights.settled[0].toFixed(1)} vs ${real.settled[0].toFixed(1)} m/s`);
  check(predicted.jumps === 1 && predicted.airborneM > 5, `${name}: the path reports its jump`, `${predicted.airborneM.toFixed(1)} m`);
}
{
  const roll: V3[] = [[0, 30, 0], [0, 10, 60], [0, 6, 90], [0, 0, 120], [0, -12, 160], [0, -30, 220]];
  const predicted = ride(onePath(roll)), real = rideStrip(predicted);
  check(!predicted.air.some(Boolean) && !real.takeoffs.length, 'a gentle roll keeps the rider down, predicted and ridden');
}

// ---- stalls ------------------------------------------------------------------------------------------------------

{
  // Rock's cruise drive (0.877 · 1.68 · 5.44 m/s² from a standstill) is weaker than its 9.8 m/s² load up 60°.
  const wall = ride(straight(60, 100), 9);
  check(wall.stalled, 'a 60° rock climb stalls the rider');
  check(Number.isNaN(wall.speed[wall.n - 1]), 'the trail past a stall is never reached');
  check(!ride(straight(60, 100)).stalled, 'the same climb on snow does not');
}

// ---- the network -------------------------------------------------------------------------------------------------

{
  // A main line down a slope, a fork leaving its middle point, and a spur merging onto its lower half.
  const points: V3[] = [[0, 60, 0], [0, 30, 100], [0, 0, 200], [40, 20, 120], [40, 10, 160], [-60, 60, 60], [-40, 40, 110]];
  const trail: Network = {
    points,
    paths: [
      { points: [0, 1, 2], settings },
      { points: [1, 3, 4], settings },       // forks off point 1
      { points: [5, 6, 2], settings },       // merges at point 2, the main line's end
    ],
  };
  const speeds = predictTrailSpeeds(trail).paths;
  const main = speeds[0]!, fork = speeds[1]!, spur = speeds[2]!;
  check(main.speed[0] === 0 && spur.speed[0] === 0, 'a path from a free point starts from rest');
  const knot1 = main.arrivals[1]!;
  check(Math.abs(fork.speed[0] - knot1.speed) < 1e-6 && fork.speed[0] > 10,
    'a path leaving another\'s point starts with the speed arriving there', `${fork.speed[0].toFixed(2)} vs ${knot1.speed.toFixed(2)}`);

  // The same fork laid with its path listed first still waits for its feeder.
  const reordered = predictTrailSpeeds({ points, paths: [trail.paths[1], trail.paths[0]] }).paths;
  check(Math.abs(reordered[0]!.speed[0] - knot1.speed) < 1e-6, 'feeders are ridden first, whatever the path order');

  // A slow line merging into a fast one's through point does not slow it; a fast one lifts a slow one.
  const lift: Network = {
    points: [[0, 0, 0], [0, 0, 60], [0, 0, 120], [-50, 60, -40]],
    paths: [{ points: [0, 1, 2], settings }, { points: [3, 1], settings }],
  };
  const lifted = predictTrailSpeeds(lift).paths;
  const flatOnly = ride(onePath([[0, 0, 0], [0, 0, 60], [0, 0, 120]]));
  const at = (path: PathSpeeds) => path.speed[Math.min(path.n - 1, 130)]; // ~65 m in: just past the merge at 60 m
  check(lifted[1]!.arrivals[1]!.speed > 20, 'the steep spur arrives fast', `${lifted[1]!.arrivals[1]!.speed.toFixed(2)}`);
  check(at(lifted[0]!) > at(flatOnly) + 3, 'its merge lifts the flat line it joins', `${at(lifted[0]!).toFixed(2)} vs ${at(flatOnly).toFixed(2)}`);

  // A closed loop has no free start: it is broken at its first point and ridden from rest there.
  const loop = predictTrailSpeeds({ points: [[0, 0, 0], [50, -10, 50], [0, -20, 100], [-50, -10, 50]], paths: [{ points: [0, 1, 2, 3, 0], settings }] });
  check(loop.paths[0]!.speed[0] === 0 && !loop.paths[0]!.stalled, 'a closed loop rides once round from rest');
}

// ---- the colour lookup ------------------------------------------------------------------------------------------

{
  const path = ride(onePath([[0, 0, 0], [30, -5, 60], [0, -15, 120], [-30, -20, 180]]));
  let near: number | undefined, worst = 0;
  for (let k = 0; k <= 60; k++) {
    // Walk a line beside the path the way a patch's vertices do, each lookup starting from the last answer.
    const i = Math.min(path.n - 1, k * Math.floor(path.n / 60));
    const point: V3 = [path.pos[i * 3] + 4, path.pos[i * 3 + 1] + 0.5, path.pos[i * 3 + 2] - 3];
    const walked = nearestSample(path, point, near), full = nearestSample(path, point);
    const d = (j: number) => Math.hypot(path.pos[j * 3] - point[0], path.pos[j * 3 + 1] - point[1], path.pos[j * 3 + 2] - point[2]);
    worst = Math.max(worst, d(walked) - d(full));
    near = walked;
  }
  check(worst < 1e-9, 'walking from the last answer finds the nearest sample', `${worst}`);
}

if (failures) process.exitCode = 1;
