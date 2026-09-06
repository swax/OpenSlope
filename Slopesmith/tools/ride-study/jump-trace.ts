/**
 * TEMP diagnostic (not part of the suite): trace the ride model over a synthetic kicker to see what the
 * board does at a jump lip — does it carry takeoff momentum ballistically, or get bent down onto the
 * landing? Run: npx tsx tools/ride-study/jump-trace.ts
 */
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { createRideModel } from '../../src/app/ride/physics';
import type { RideTelemetryTick } from '../../src/app/ride/telemetry';

// ---- synthetic course profile: slope m(z) = dy/dz, piecewise; y(z) by exact integration ----
// approach downhill -8deg -> transition -> kicker face +20deg -> LIP (z=75) -> steep drop face -> landing -15deg
const D2R = Math.PI / 180;
const M_APPROACH = -Math.tan(8 * D2R);
const M_KICK = Math.tan(20 * D2R);
const M_DROP = -Math.tan(70 * D2R);
const M_LAND = -Math.tan(15 * D2R);
const Z_TRANS0 = 55, Z_TRANS1 = 70, Z_LIP = 75, Z_DROP1 = 76.5;

type Variant = 'kicker' | 'roller';
const variant: Variant = (process.argv[2] as Variant) || 'kicker';
const faceted = process.argv.includes('faceted'); // ride the faceted fallback (no analytic patch contact)
const assertMode = process.argv.includes('assert');
const quiet = process.argv.includes('quiet');

function mOf(z: number): number {
  if (variant === 'roller') {
    // rounded crest: +20deg fades to -15deg over 6 m, no drop face
    if (z < Z_TRANS0) return M_APPROACH;
    if (z < Z_TRANS1) return M_APPROACH + (M_KICK - M_APPROACH) * (z - Z_TRANS0) / (Z_TRANS1 - Z_TRANS0);
    if (z < Z_LIP) return M_KICK;
    if (z < Z_LIP + 6) return M_KICK + (M_LAND - M_KICK) * (z - Z_LIP) / 6;
    return M_LAND;
  }
  if (z < Z_TRANS0) return M_APPROACH;
  if (z < Z_TRANS1) return M_APPROACH + (M_KICK - M_APPROACH) * (z - Z_TRANS0) / (Z_TRANS1 - Z_TRANS0);
  if (z < Z_LIP) return M_KICK;
  if (z < Z_DROP1) return M_DROP;
  return M_LAND;
}
// integrate m once on a fine grid so yOf is exact-enough and consistent with mOf everywhere
const ZMAX = 160, DZ = 0.005;
const yTable = new Float64Array(Math.ceil(ZMAX / DZ) + 2);
{
  let y = 0;
  for (let i = 1; i < yTable.length; i++) {
    const z0 = (i - 1) * DZ, z1 = i * DZ;
    y += 0.5 * (mOf(z0) + mOf(z1)) * DZ;
    yTable[i] = y;
  }
}
function yOf(z: number): number {
  const t = Math.min(Math.max(z, 0), ZMAX) / DZ;
  const i = Math.floor(t), f = t - i;
  return yTable[i] * (1 - f) + yTable[Math.min(i + 1, yTable.length - 1)] * f;
}

// ---- mesh: a ribbon along +Z (chords under the analytic profile, like the 4x4 patch tessellation) ----
const XS = [-15, -7.5, 0, 7.5, 15];
const ZSTEP = 0.75, NZ = Math.floor(ZMAX / ZSTEP);
const positions: number[] = [];
for (let iz = 0; iz <= NZ; iz++) {
  const z = iz * ZSTEP;
  for (const x of XS) positions.push(x, yOf(z), z);
}
const index: number[] = [];
const W = XS.length;
for (let iz = 0; iz < NZ; iz++) {
  for (let ix = 0; ix < W - 1; ix++) {
    const a = iz * W + ix, b = a + 1, c = a + W, d = c + 1;
    index.push(a, c, b, b, c, d); // CCW seen from +Y (up) — outward normal skyward
  }
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geo.setIndex(index);
const terrain = new THREE.Mesh(geo);
terrain.updateMatrixWorld(true);

// analytic contact: project the facet hit straight onto the profile (the heightfield's exact surface + normal)
const ta = new THREE.Vector3(), tb = new THREE.Vector3(), tc = new THREE.Vector3();
const pos = geo.getAttribute('position');
const idx = geo.getIndex()!.array;
function patchContact(faceIndex: number, bary: THREE.Vector3, outPoint: THREE.Vector3, outNormal: THREE.Vector3): boolean {
  const i = faceIndex * 3;
  ta.fromBufferAttribute(pos, idx[i]); tb.fromBufferAttribute(pos, idx[i + 1]); tc.fromBufferAttribute(pos, idx[i + 2]);
  const px = ta.x * bary.x + tb.x * bary.y + tc.x * bary.z;
  const pz = ta.z * bary.x + tb.z * bary.y + tc.z * bary.z;
  outPoint.set(px, yOf(pz), pz);
  outNormal.set(0, 1, -mOf(pz)).normalize();
  return true;
}

// ---- ride ----
const keys = { left: false, right: false, tuck: false, brake: false, boost: process.argv.includes('boost') };
const telemetry: RideTelemetryTick[] = [];
const model = createRideModel({
  spawn: new THREE.Vector3(0, yOf(5) + 1, 5),
  heading: new THREE.Vector3(0, 0, 1),
  terrain,
  surfaceOf: () => 1, // standard snow everywhere
  patchContact: faceted ? undefined : patchContact,
  oobFloorY: -1000,
  keys,
  stick: { active: false, x: 0 },
  onRespawn: () => {},
  onTelemetryTick: tick => telemetry.push(tick),
});
model.start();

const st = model.st;
const H = 1 / 60;
let ballistic: { pos: THREE.Vector3; vel: THREE.Vector3; tick: number } | null = null;
let airTicks = 0, landed = false;
let landing: { pos: THREE.Vector3; tick: number } | null = null;

console.log(`=== variant: ${variant}${faceted ? ' (faceted contact)' : ' (analytic contact)'} ===`);
if (!quiet) console.log('tick     z       y     clr(m)   |v|    vy      vz    gnd  err(m)   nY    note');
const boostUntil = process.argv.includes('boost40') ? 40 : Infinity; // boost only on the early approach
for (let t = 0; t < 1200 && !landed; t++) {
  if (st.pos.z > boostUntil) keys.boost = false;
  model.step(H);
  const tick = telemetry.at(-1)!;
  const clr = st.pos.y - yOf(st.pos.z); // vertical clearance over the analytic profile
  const inWindow = st.pos.z > 68;
  const note: string[] = [];
  if (inWindow && tick.events.some(event => event.type === 'takeoff')) {
    note.push('>>> AIRBORNE');
    ballistic = { pos: new THREE.Vector3().fromArray(tick.closing.position), vel: new THREE.Vector3().fromArray(tick.closing.velocity), tick: t };
  }
  if (ballistic && tick.events.some(event => event.type === 'touchdown')) {
    note.push('<<< TOUCHDOWN'); landed = true; landing = { pos: st.pos.clone(), tick: t };
  }
  if (inWindow && !quiet) {
    console.log(
      `${String(t).padStart(4)}  ${st.pos.z.toFixed(2).padStart(6)}  ${st.pos.y.toFixed(2).padStart(6)}  ${clr.toFixed(3).padStart(6)}` +
      `  ${st.vel.length().toFixed(2).padStart(5)}  ${st.vel.y.toFixed(2).padStart(6)}  ${st.vel.z.toFixed(2).padStart(5)}` +
      `  ${st.grounded ? ' G ' : ' A '}  ${st.error.toFixed(3).padStart(6)}  ${st.contactN.y.toFixed(2).padStart(5)}  ${note.join(' ')}`,
    );
  }
  if (ballistic && !landed) airTicks++;
  if (st.pos.z > 150) break;
}

// pure spec-air ballistic from the takeoff state: two-stage gravity + 0.2/s horizontal damping, explicit Euler
if (ballistic) {
  const p = ballistic.pos.clone(), v = ballistic.vel.clone();
  let ticks = 0;
  while (p.y - yOf(p.z) > 0 && ticks < 1200) {
    p.addScaledVector(v, H);
    v.x -= 0.2 * v.x * H; v.z -= 0.2 * v.z * H;
    v.y -= (v.y > 0 ? 8.5 : 19.0) * H;
    ticks++;
  }
  console.log(`\nballistic from takeoff (tick ${ballistic.tick}, |v|=${ballistic.vel.length().toFixed(2)}, vy=${ballistic.vel.y.toFixed(2)}):`);
  console.log(`  would land at z=${p.z.toFixed(2)} after ${ticks} air ticks (${(ticks * H).toFixed(2)} s), impact |v|=${v.length().toFixed(2)}`);
  console.log(`  model was airborne ${airTicks} ticks total`);
  if (assertMode) {
    assert.ok(landing, 'the telemetry stream must report touchdown after takeoff');
    assert.ok(Math.abs(landing.pos.z - p.z) < 0.35,
      `model landing z=${landing.pos.z.toFixed(3)} must stay within 0.35 m of ballistic z=${p.z.toFixed(3)}`);
    const takeoff = telemetry.find(frame => frame.events.some(event => event.type === 'takeoff'))!;
    assert.equal(takeoff.opening.grounded, true, 'takeoff opens in the grounded state');
    assert.equal(takeoff.closing.grounded, false, 'takeoff closes in the air state');
    assert.equal(takeoff.redirect, undefined, 'a rejected contact must not redirect velocity on the takeoff tick');
    const touchdown = telemetry.find(frame => frame.frame > takeoff.frame && frame.events.some(event => event.type === 'touchdown'))!;
    const flight = telemetry.filter(frame => frame.frame > takeoff.frame && frame.frame < touchdown.frame);
    assert.ok(flight.every(frame => !frame.redirect), 'ticks wholly inside the flight must not receive ground redirect');
    const lastDeferredFloor = flight.filter(frame => frame.events.some(event => event.type === 'floor-crossing-deferred')).at(-1);
    assert.ok(lastDeferredFloor, 'the landing fixture must exercise the swept-floor/contact-probe handoff');
    // A nose/corner sample can reach the slope before the deck reference; four ticks covers that footprint lead.
    assert.ok(touchdown.frame - lastDeferredFloor.frame <= 4,
      `a deferred floor crossing at ${lastDeferredFloor.frame} must become touchdown by ${lastDeferredFloor.frame + 4}`);
    console.log('TELEMETRY ASSERTIONS PASSED');
  }
} else {
  console.log('\nNEVER WENT AIRBORNE');
  if (assertMode) assert.fail('the telemetry stream never reported takeoff');
}
