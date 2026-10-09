// tier: fast

/**
 * The predicted ride down a mountain's course (docs/023 · Predicted speed, the mountain) held to the trail prediction
 * it is built from: a lane down a plain slope carries what a straight trail down it does. Then what the lines add — the
 * ground they cover and the ground they leave bare, a line leaving another at its speed, a stall and the climb it never
 * tops, a gap flown between two pieces, a wall flown over, ground nobody rides, a gate off the mountain — and the solver
 * giving the same answer a slice at a time. Run: `npx tsx test/mountain-speed.test.ts`
 */
import type { AuthoredTrail, TrailSettings, V3 } from '../src/core/doc/types';
import { RIDE_MAX_SPEED } from '../src/app/ride/ride-contract.generated';
import {
  mountainSpeedSolver, predictMountainSpeeds, type MountainSpeeds, type SpeedLine, type SpeedQuilt,
} from '../src/app/ride/mountain-speed';
import { predictTrailSpeeds, type PathSpeeds } from '../src/app/ride/trail-speed';
import { check, failures } from './check';

const RES = 8, SIDE = RES + 1;

/** A quilt over the heightfield `height`, `cols × rows` patches `size` metres square from `(x0, z0)`, its normals
 *  read off the field. */
function heightQuilt(height: (x: number, z: number) => number, cols: number, rows: number, size: number,
  x0 = 0, z0 = 0, surface = 1): SpeedQuilt {
  const positions: number[] = [], normals: number[] = [], cellSurf: number[] = [];
  const e = 0.01;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cellSurf.push(surface);
      for (let iu = 0; iu < SIDE; iu++) {
        for (let iv = 0; iv < SIDE; iv++) {
          const x = x0 + (c + iv / RES) * size, z = z0 + (r + iu / RES) * size;
          const hx = (height(x + e, z) - height(x - e, z)) / (2 * e), hz = (height(x, z + e) - height(x, z - e)) / (2 * e);
          const len = Math.hypot(hx, 1, hz);
          positions.push(x, height(x, z), z);
          normals.push(-hx / len, 1 / len, -hz / len);
        }
      }
    }
  }
  return { positions, normals, cellSurf, side: SIDE };
}

/** Two quilts as one, the second's patches after the first's. */
function joined(a: SpeedQuilt, b: SpeedQuilt): SpeedQuilt {
  return {
    positions: [...Array.from(a.positions), ...Array.from(b.positions)],
    normals: [...Array.from(a.normals), ...Array.from(b.normals)],
    cellSurf: [...Array.from(a.cellSurf), ...Array.from(b.cellSurf)], side: SIDE,
  };
}

/** The lattice point nearest `(x, z)` in plan. */
function at(quilt: SpeedQuilt, x: number, z: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < quilt.positions.length / 3; i++) {
    const d = (quilt.positions[i * 3] - x) ** 2 + (quilt.positions[i * 3 + 2] - z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** A plane falling at `degrees` toward +Z. */
const plane = (degrees: number) => (_x: number, z: number) => -z * Math.tan(degrees * Math.PI / 180);

/** A line straight down +Z at plan `x` from `z0` to `z1` over `height`. */
function straightLine(height: (x: number, z: number) => number, x: number, z0: number, z1: number, halfWidth = 0,
  start = true): SpeedLine {
  const points: V3[] = [];
  for (let z = z0; z <= z1 + 1e-9; z += 5) points.push([x, height(x, z), z]);
  return { points, halfWidth, start };
}

/** The trail prediction's speed `metres` along a straight run at `degrees` (negative: downhill) along +Z. */
function trailSpeedAt(degrees: number, metres: number): number {
  const r = degrees * Math.PI / 180, length = 300, point = (f: number): V3 => [0, length * f * Math.sin(r), length * f * Math.cos(r)];
  const trail: Pick<AuthoredTrail, 'points' | 'paths'> = {
    points: [point(0), point(0.5), point(1)], paths: [{ points: [0, 1, 2], settings: {} as TrailSettings }],
  };
  const path: PathSpeeds = predictTrailSpeeds(trail).paths[0]!;
  let d = 0;
  for (let i = 1; i < path.n; i++) {
    d += Math.hypot(path.pos[i * 3] - path.pos[i * 3 - 3], path.pos[i * 3 + 1] - path.pos[i * 3 - 2], path.pos[i * 3 + 2] - path.pos[i * 3 - 1]);
    if (d >= metres) return path.speed[i];
  }
  return path.speed[path.n - 1];
}

// ---- a lane is a trail ------------------------------------------------------------------------------------------

{
  const slope = 20, fall = plane(slope), quilt = heightQuilt(fall, 4, 6, 30);
  const field = predictMountainSpeeds(quilt, [straightLine(fall, 60, 0, 180, 9)]);
  for (const z of [18.75, 60, 120]) {
    const metres = z / Math.cos(slope * Math.PI / 180);
    const got = field.speed[at(quilt, 60, z)], want = trailSpeedAt(-slope, metres);
    check(Math.abs(got - want) < 0.03 * want + 0.3, `the lane carries a straight trail's speed ${metres.toFixed(0)} m down`,
      `${got.toFixed(2)} vs ${want.toFixed(2)} m/s`);
  }
  check(field.speed[at(quilt, 60, 0)] === 0, 'the gate line sets off from rest');
  check(!field.bare[at(quilt, 69, 90)] && !field.bare[at(quilt, 51, 90)], 'its lanes cover the ground either side of it');
  check(!!field.bare[at(quilt, 0, 90)] && !!field.bare[at(quilt, 120, 90)], 'ground no lane comes near is left bare');
  check(!field.air.some(a => a), 'a plain slope throws no one');

  // A line leaving that one half way down picks up its speed there.
  const branch: SpeedLine = { points: [[60, fall(60, 90), 90], [100, fall(100, 150), 150]], halfWidth: 0, start: false };
  const fed = predictMountainSpeeds(quilt, [straightLine(fall, 60, 0, 180), branch]);
  const there = fed.speed[at(quilt, 60, 90)], leaving = fed.speed[at(quilt, 63.75, 93.75)];
  check(Math.abs(leaving - there) < 2, 'a line leaving another starts at the speed the other carries there',
    `${leaving.toFixed(2)} vs ${there.toFixed(2)} m/s`);
}

// ---- stalls, gaps, walls and ground nobody rides ---------------------------------------------------------------

{
  // Straight up a 60° rock face: the rock's drive cannot carry the rider up it, and nothing above levels off.
  const climb = (_x: number, z: number) => z * Math.tan(60 * Math.PI / 180);
  const quilt = heightQuilt(climb, 2, 3, 30, 0, 0, 9);
  const field = predictMountainSpeeds(quilt, [straightLine(climb, 30, 0, 90)]);
  const above = at(quilt, 30, 60);
  check(Number.isNaN(field.speed[above]) && !field.bare[above], 'the climb past a stall is never reached, and reads so');
}

{
  // A run ending at an open edge, and a separate landing 20 m on and 20 m down: nothing joins them but the air.
  const fall = plane(20), run = heightQuilt(fall, 3, 4, 30);
  const landing = heightQuilt((x, z) => fall(x, z) - 20, 3, 3, 30, 0, 140);
  const quilt = joined(run, landing), lattice = run.positions.length / 3;
  const field = predictMountainSpeeds(quilt, [straightLine(fall, 45, 0, 225, 6)]);
  const beyond = lattice + at(landing, 45, 200);
  check(!field.air[beyond] && field.speed[beyond] > 20, 'the lane flies the gap and lands beyond it, carrying its speed',
    `${field.speed[beyond].toFixed(2)} m/s`);
  check(field.air[lattice + at(landing, 45, 141)] === 1, 'and is in the air coming over the far side');
}

{
  // A 25° run-in breaking over an 80° face 15 m tall, and 25° again below: the face is a wall, and the rider flies it.
  const steep = Math.tan(80 * Math.PI / 180), run = Math.tan(25 * Math.PI / 180), lip = 90, drop = 15;
  const height = (_x: number, z: number) => -z * run - Math.min(Math.max(z - lip, 0), drop / steep) * (steep - run);
  const quilt = heightQuilt(height, 3, 8, 30);
  const field: MountainSpeeds = predictMountainSpeeds(quilt, [straightLine(height, 45, 0, 235, 6)]);
  let airBefore = 0, faceFlown = 0;
  for (let i = 0; i < field.speed.length; i++) {
    const z = quilt.positions[i * 3 + 2];
    if (field.air[i] && z < lip - 4) airBefore++;
    if (field.air[i] && z > lip && z < lip + 20) faceFlown++;
  }
  check(airBefore === 0, 'the run-in keeps the rider down', `${airBefore}`);
  check(faceFlown > 0, 'the rider leaves the lip and flies over the face and the ground below it', `${faceFlown} points`);
  const landed = at(quilt, 45, 220);
  check(!field.air[landed] && field.speed[landed] > 0.8 * RIDE_MAX_SPEED, 'and lands, carrying speed down the slope below',
    `${field.speed[landed].toFixed(2)} m/s`);
}

{
  const fall = plane(15), quilt = heightQuilt(fall, 3, 3, 30, 0, 0, 0);
  const field = predictMountainSpeeds(quilt, [straightLine(fall, 45, 0, 90, 6)]);
  check(field.bare.every(b => b === 1), 'out of bounds is no ground to ride, and is left bare');
  const ridden = heightQuilt(fall, 3, 3, 30);
  check(predictMountainSpeeds(ridden, [straightLine(fall, 45, 0, 90)]).startGap < 1e-6, 'a gate on the ground stands on it');
  const off = predictMountainSpeeds(ridden, [{ points: [[-300, 0, 0], [-300, 0, 90]], halfWidth: 0, start: true }]);
  check(Math.abs(off.startGap - 300) < 1, 'a gate off the mountain reports how far it is from the ground', `${off.startGap.toFixed(1)} m`);
}

// ---- a slice at a time -------------------------------------------------------------------------------------------

{
  const fall = plane(20), quilt = heightQuilt(fall, 4, 6, 30), lines = [straightLine(fall, 60, 0, 180, 9)];
  const whole = predictMountainSpeeds(quilt, lines);
  const solver = mountainSpeedSolver(quilt, lines);
  let slices = 0, result: MountainSpeeds | null = null;
  while (!result && slices < 1000) { slices++; result = solver.run(() => false); }
  check(slices > 1, 'the solver hands back control between lanes', `${slices} slices`);
  check(!!result && result.speed.every((v, i) => Object.is(v, whole.speed[i])) && result.air.every((v, i) => v === whole.air[i]),
    'and finishes with the answer it gives all at once');
}

if (failures) process.exitCode = 1;
