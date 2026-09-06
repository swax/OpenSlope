/**
 * TEMP diagnostic (not part of the suite): trace the ride model over a synthetic grind line to check the rail
 * state against [Trailmap: 350] — the vacuum catch from the ground, magnitude-preserving tangent capture,
 * slope gravity with no drag, chaining across a rail junction, running off the end into air, and the ollie
 * exit with its re-lock lockout. Run: npx tsx tools/ride-study/rail-trace.ts [ollie] [boost] [spin]
 */
import * as THREE from 'three';
import { createGrindRails } from '../../src/app/ride/grind';
import { createRideModel } from '../../src/app/ride/physics';
import { RAIL_TUBE_RADIUS } from '../../src/core/rails/rail-mesh';
import { railBezierSegments } from '../../src/core/rails/rails';
import type { V3 } from '../../src/core/doc/types';

const doOllie = process.argv.includes('ollie');

// ---- terrain: a constant -10 deg slope along +Z, as a plain ribbon (faceted contact is exact on a plane) ----
const D2R = Math.PI / 180;
const M = -Math.tan(10 * D2R);
const yOf = (z: number) => M * z;

const XS = [-15, -7.5, 0, 7.5, 15];
const ZMAX = 160, ZSTEP = 1.5, NZ = Math.floor(ZMAX / ZSTEP);
const positions: number[] = [];
for (let iz = 0; iz <= NZ; iz++) for (const x of XS) positions.push(x, yOf(iz * ZSTEP), iz * ZSTEP);
const index: number[] = [];
const W = XS.length;
for (let iz = 0; iz < NZ; iz++) {
  for (let ix = 0; ix < W - 1; ix++) {
    const a = iz * W + ix, b = a + 1, c = a + W, d = c + 1;
    index.push(a, c, b, b, c, d);
  }
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geo.setIndex(index);
const terrain = new THREE.Mesh(geo);
terrain.updateMatrixWorld(true);

// ---- rails: two straight grind lines down the fall line, floated 0.4 m over the snow, a 0.5 m junction gap ----
const FLOAT = 0.4;
const railNodes = (z0: number, z1: number): V3[] => {
  const nodes: V3[] = [];
  for (let z = z0; z <= z1 + 1e-6; z += (z1 - z0) / 2) nodes.push([0, yOf(z) + FLOAT, z]);
  return nodes;
};
const toSegs = (nodes: V3[]) => railBezierSegments(nodes).map(seg =>
  seg.map(p => new THREE.Vector3(p[0], p[1], p[2])) as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]);
const rails = createGrindRails([
  { surf: 13, seat: RAIL_TUBE_RADIUS, segments: toSegs(railNodes(20, 60)) },   // rail 0
  { surf: 13, seat: RAIL_TUBE_RADIUS, segments: toSegs(railNodes(60.5, 90)) }, // rail 1 — chained across the junction
]);

// ---- ride ----
const keys = { left: false, right: false, tuck: false, brake: false, boost: process.argv.includes('boost') };
const model = createRideModel({
  spawn: new THREE.Vector3(0, yOf(2) + 1, 2),
  heading: new THREE.Vector3(0, 0, 1),
  terrain,
  surfaceOf: () => 1,
  rails,
  oobFloorY: -1000,
  keys,
  stick: { active: false, x: 0 },
  onRespawn: () => {},
});
model.start();

const st = model.st;
const H = 1 / 60;
console.log(`=== rail trace${doOllie ? ' (ollie at 0.8 s of grind)' : ''} — 2 rails, ${rails.segmentCount} segments ===`);
console.log('tick     z       y     |v|     vy    rail surf  gnd  yaw   note');

let prevRail = -1, prevGrounded = false;
let catchSpeed = 0, grindTicks = 0, speedAtGrind60 = 0, ollieTick = -1, relockTick = -1, offEndTick = -1;
const events: string[] = [];
for (let t = 0; t < 1500; t++) {
  if (process.argv.includes('spin')) keys.right = st.railIdx >= 0; // hold a boardslide while grinding
  if (doOllie && st.railIdx >= 0 && st.railTime >= 0.8 && ollieTick < 0) { model.ollieDown(); }
  if (doOllie && st.railIdx >= 0 && st.railTime >= 0.9 && ollieTick < 0) { model.ollieUp(); ollieTick = t; }
  model.step(H);
  const note: string[] = [];
  if (st.railIdx >= 0 && prevRail < 0) {
    note.push(`>>> CAUGHT rail ${st.railIdx}`);
    catchSpeed = st.vel.length();
    if (relockTick < 0 && ollieTick >= 0) relockTick = t;
  }
  if (st.railIdx >= 0 && prevRail >= 0 && st.railIdx !== prevRail) note.push(`>>> CHAINED ${prevRail} → ${st.railIdx}`);
  if (st.railIdx < 0 && prevRail >= 0) { note.push('<<< OFF RAIL'); if (offEndTick < 0 && ollieTick < 0) offEndTick = t; }
  if (!prevGrounded && st.grounded && st.railIdx < 0) note.push('<<< touchdown (terrain)');
  if (st.railIdx >= 0) { grindTicks++; if (grindTicks === 60) speedAtGrind60 = st.vel.length(); }
  if (note.length || (st.railIdx >= 0 && grindTicks % 30 === 0)) {
    console.log(
      `${String(t).padStart(4)}  ${st.pos.z.toFixed(2).padStart(6)}  ${st.pos.y.toFixed(2).padStart(6)}` +
      `  ${st.vel.length().toFixed(2).padStart(5)}  ${st.vel.y.toFixed(2).padStart(5)}` +
      `  ${String(st.railIdx).padStart(4)}  ${String(st.surf).padStart(4)}  ${st.grounded ? ' G ' : ' A '}` +
      `  ${st.railYaw.toFixed(0).padStart(4)}  ${note.join(' ')}`,
    );
    events.push(...note);
  }
  prevRail = st.railIdx;
  prevGrounded = st.grounded;
  if (st.pos.z > 150) break;
}

// ---- checks ----
const grindSecs = grindTicks / 60;
console.log('\nsummary:');
console.log(`  caught at |v|=${catchSpeed.toFixed(2)} m/s; ground ${grindSecs.toFixed(2)} s total`);
if (speedAtGrind60 > 0) {
  // [Trailmap: 350] no drag; slope gravity alone: dv/dt = 9.8·sin(10°) = 1.70 m/s² down a -10° line
  const gain = (speedAtGrind60 - catchSpeed) / 1.0;
  console.log(`  speed gain over the first grind second: ${gain.toFixed(2)} m/s (slope gravity predicts ≈ 1.70)`);
}
if (doOllie && ollieTick >= 0) {
  const relock = relockTick >= 0 ? `re-caught ${(relockTick - ollieTick) / 60}s after the pop` : 'never re-caught';
  console.log(`  ollie released at tick ${ollieTick}; ${relock} (lockout 0.35 s)`);
}
if (offEndTick >= 0) console.log(`  ran off the last rail at tick ${offEndTick}, airborne with carried speed`);
