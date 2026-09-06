/**
 * Ride study: what slip angle does a HELD lean settle at, per surface?
 *
 * The retail captures answer this for ice directly — `control.leanSlew` and the contact basis are both in the
 * v4 rider telemetry, and the settled points there fit `|slip| ≈ 31.8° · |lean|` with no speed term across
 * 13–20 m/s ([Trailmap: 330-carving]; ResearchData/telemetry/gari-ice-turn-retail-*). This drives the PORTED
 * model over the same held leans so the two curves can be laid side by side — the question behind a
 * commanded-slip term is whether the port already reproduces that line before anything is built on top of it.
 *
 * Flat ground by design: it pins the contact response at its neutral equilibrium (ice A/100 = 13.5 m/s², carve
 * force response·tan(45°·lean) ≈ 11.6 m/s² at full lean) so the measurement isolates the steering loop from
 * terrain curvature. That is also its limit — the carve slide's whole job is to read a DEEPER error on concave
 * ground and drive the response toward its 2A clamp, and retail's ice traces were ridden on Garibaldi, not on a
 * plane. Read a low port number here as "flat ground is the floor of the carve", not as a port defect.
 *
 * Run: npx tsx tools/ride-study/ice-slip-sweep.ts [surface=5] [drive] [recover]
 *   surface   SurfaceType row to ride (5 ice, 1 standard snow)
 *   drive     leave the cruise drive on; default disables it so a seeded speed holds put
 *   recover   instead of the sweep, carve to equilibrium then CENTRE the input and watch the slip close —
 *             splitting the closure into the part the heading did (the board swinging onto its drift) and the
 *             part the travel did (the drift bending back under the board). Only the second recovers a line.
 */
import * as THREE from 'three';
import { createRideModel } from '../../src/app/ride/physics';
import { SURFACE_ROWS } from '../../src/app/ride/physics';
import { STEER_STRENGTH } from '../../src/app/ride/physics-tuning';

const SURFACE = Number(process.argv[2] ?? 5);
const DRIVE_ON = process.argv.includes('drive');
const RECOVER = process.argv.includes('recover');
const H = 1 / 60;
const SETTLE_TICKS = 90;   // contact settles before the lean goes on
const HOLD_TICKS = 420;    // 7 s of held lean
const WINDOW = 90;         // the last 1.5 s is the equilibrium sample

const LEANS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
// 0 = no seed (the cruise drive settles it). The drive is positive-only, so with it ON a seed ABOVE the
// surface target still holds; a seed below it just gets pulled back up to the target.
const SPEEDS = DRIVE_ON ? [0, 22, 26] : [12, 16, 20, 24];

// ---- flat terrain, exact contact -------------------------------------------------------------------
const HALF = 150, STEP = 5;
const positions: number[] = [];
const index: number[] = [];
const N = (HALF * 2) / STEP;
for (let iz = 0; iz <= N; iz++) {
  for (let ix = 0; ix <= N; ix++) positions.push(-HALF + ix * STEP, 0, -HALF + iz * STEP);
}
for (let iz = 0; iz < N; iz++) {
  for (let ix = 0; ix < N; ix++) {
    const a = iz * (N + 1) + ix, b = a + 1, c = a + N + 1, d = c + 1;
    index.push(a, c, b, b, c, d); // CCW from +Y — outward normal skyward
  }
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
geo.setIndex(index);
const terrain = new THREE.Mesh(geo);
terrain.updateMatrixWorld(true);

const gp = geo.getAttribute('position');
const gi = geo.getIndex()!.array;
const ca = new THREE.Vector3(), cb = new THREE.Vector3(), cc = new THREE.Vector3();
function patchContact(faceIndex: number, bary: THREE.Vector3, outPoint: THREE.Vector3, outNormal: THREE.Vector3): boolean {
  const i = faceIndex * 3;
  ca.fromBufferAttribute(gp, gi[i]); cb.fromBufferAttribute(gp, gi[i + 1]); cc.fromBufferAttribute(gp, gi[i + 2]);
  outPoint.set(
    ca.x * bary.x + cb.x * bary.y + cc.x * bary.z,
    0,
    ca.z * bary.x + cb.z * bary.y + cc.z * bary.z,
  );
  outNormal.set(0, 1, 0);
  return true;
}

// ---- one held-lean run ------------------------------------------------------------------------------
const tangent = new THREE.Vector3(), lateral = new THREE.Vector3(), flat = new THREE.Vector3();

interface Sample { lean: number; slipDeg: number; speed: number; yawDps: number; grounded: boolean }

function measure(stickX: number, seedSpeed: number): Sample | null {
  const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
  const stick = { active: false, x: 0 };
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 0.6, -60),
    heading: new THREE.Vector3(0, 0, 1),
    terrain,
    surfaceOf: () => SURFACE,
    patchContact,
    oobFloorY: -1000,
    keys,
    stick,
    ...(DRIVE_ON ? {} : { drive: 0 }),
    onRespawn: () => {},
  });
  model.start();
  const st = model.st;

  for (let t = 0; t < SETTLE_TICKS; t++) model.step(H);
  if (!st.grounded) return null;
  if (seedSpeed > 0) st.vel.copy(st.fwd).multiplyScalar(seedSpeed);

  stick.active = true;
  stick.x = stickX;

  const slips: number[] = [], speeds: number[] = [], leans: number[] = [], yaws: number[] = [];
  let prevHeading = Math.atan2(st.fwd.x, st.fwd.z);
  let leftGround = false;
  for (let t = 0; t < HOLD_TICKS; t++) {
    model.step(H);
    if (!st.grounded) leftGround = true;
    if (t < HOLD_TICKS - WINDOW) {
      prevHeading = Math.atan2(st.fwd.x, st.fwd.z);
      continue;
    }
    // Signed slip in the contact frame, the same construction the retail extractor uses: travel measured
    // against the board's contact-plane tangent, positive toward `cross(n, fwd)`.
    tangent.copy(st.fwd).projectOnPlane(st.contactN);
    if (tangent.lengthSq() < 1e-8) continue;
    tangent.normalize();
    lateral.crossVectors(st.contactN, tangent).normalize();
    flat.copy(st.vel).projectOnPlane(st.contactN);
    if (flat.lengthSq() < 1e-6) continue;
    slips.push(THREE.MathUtils.radToDeg(Math.atan2(flat.dot(lateral), flat.dot(tangent))));
    speeds.push(st.vel.length());
    leans.push(st.lean);
    const heading = Math.atan2(st.fwd.x, st.fwd.z);
    let d = heading - prevHeading;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    yaws.push(THREE.MathUtils.radToDeg(d) / H);
    prevHeading = heading;
  }
  if (slips.length < WINDOW / 2) return null;
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  return {
    lean: mean(leans),
    slipDeg: mean(slips),
    speed: mean(speeds),
    yawDps: mean(yaws),
    grounded: !leftGround,
  };
}

/**
 * Carve to equilibrium at full lean, then centre the input and watch the slip angle close.
 *
 * The slip angle can close two ways and they are not interchangeable. The HEADING can swing onto the drift
 * (the yaw loop does this: with turnLean at zero it drives `slipRef` to zero by rotating the board onto its
 * travel) — the number goes to zero and the rider is still leaving the course sideways, now pointing that way.
 * Or the TRAVEL can bend back under the board, which is the only closure that recovers a line, and the only
 * mechanism for it is the lateral carve drag. Splitting the two is the whole question.
 */
function recovery(): void {
  const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
  const stick = { active: true, x: 1.0 };
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 0.6, -60),
    heading: new THREE.Vector3(0, 0, 1),
    terrain,
    surfaceOf: () => SURFACE,
    patchContact,
    oobFloorY: -1000,
    keys,
    stick,
    ...(DRIVE_ON ? {} : { drive: 0 }),
    onRespawn: () => {},
  });
  model.start();
  const st = model.st;
  for (let t = 0; t < SETTLE_TICKS + 180; t++) model.step(H);   // carve to equilibrium

  const slipOf = () => {
    tangent.copy(st.fwd).projectOnPlane(st.contactN).normalize();
    lateral.crossVectors(st.contactN, tangent).normalize();
    flat.copy(st.vel).projectOnPlane(st.contactN);
    return THREE.MathUtils.radToDeg(Math.atan2(flat.dot(lateral), flat.dot(tangent)));
  };
  const headingOf = () => THREE.MathUtils.radToDeg(Math.atan2(st.fwd.x, st.fwd.z));
  const travelOf = () => THREE.MathUtils.radToDeg(Math.atan2(st.vel.x, st.vel.z));
  const unwrap = (d: number) => { while (d > 180) d -= 360; while (d < -180) d += 360; return d; };

  const slip0 = slipOf(), head0 = headingOf(), trav0 = travelOf();
  console.log(`carved to equilibrium: slip ${slip0.toFixed(2)}deg at ${st.vel.length().toFixed(2)} m/s\n`);
  console.log('  input CENTRED at t=0\n');
  console.log(`${'t (s)'.padStart(7)} ${'slip deg'.padStart(9)} ${'closed %'.padStart(9)} ${'heading moved'.padStart(14)} ${'travel moved'.padStart(13)} ${'speed'.padStart(7)}`);

  stick.x = 0;
  for (let t = 1; t <= 300; t++) {
    model.step(H);
    if (t % 15 !== 0) continue;
    const slip = slipOf();
    const dHead = unwrap(headingOf() - head0), dTrav = unwrap(travelOf() - trav0);
    const closed = (1 - slip / slip0) * 100;
    console.log(
      `${(t * H).toFixed(2).padStart(7)} ${slip.toFixed(2).padStart(9)} ${closed.toFixed(1).padStart(9)}`
      + ` ${dHead.toFixed(2).padStart(14)} ${dTrav.toFixed(2).padStart(13)} ${st.vel.length().toFixed(2).padStart(7)}`,
    );
  }
  const dHead = unwrap(headingOf() - head0), dTrav = unwrap(travelOf() - trav0);
  const total = Math.abs(dHead) + Math.abs(dTrav);
  console.log(`\nover 5 s with the input centred, the ${Math.abs(slip0 - slipOf()).toFixed(1)}deg of slip closed by:`);
  console.log(`  heading swinging onto the drift : ${(100 * Math.abs(dHead) / total).toFixed(0)}%  (${dHead.toFixed(1)}deg)  <- does NOT recover the line`);
  console.log(`  travel bending back under it    : ${(100 * Math.abs(dTrav) / total).toFixed(0)}%  (${dTrav.toFixed(1)}deg)  <- the only closure that does`);
}

// ---- sweep ------------------------------------------------------------------------------------------
const row = SURFACE_ROWS[SURFACE];
console.log(`=== held-lean slip equilibrium: SurfaceType ${SURFACE} (${row.name}) ===`);
console.log(`    carve drag ${row.drag}  carve tilt ${row.tilt}deg  A ${row.A}  cruise target ${row.target} m/s`);
console.log(`    flat ground, cruise drive ${DRIVE_ON ? 'ON (speed settles at the surface target)' : 'OFF (seeded speed holds)'},`
  + ` ${HOLD_TICKS} ticks held, mean of the last ${WINDOW}\n`);

/**
 * The game's turn-lean curve ([Trailmap: 330-carving], the c7 / 0.5·c0 shape) in DEGREES — the angle by which
 * the heading leads its reference direction. The yaw closure drives `slipRef` onto exactly this value, and for
 * stick steering the reference IS the travel direction, so this is the equilibrium slip angle the loop is
 * solving for. Printed beside the measurement to test that identity rather than fitting a curve to it.
 */
function turnLeanDeg(lean: number): number {
  return Math.abs(THREE.MathUtils.radToDeg(lean * 0.5239824 * (1 + 0.2 * (1 - lean * lean)) * STEER_STRENGTH));
}

const fitPoints: Array<{ lean: number; slip: number }> = [];
const turnLeanPoints: Array<{ turnLean: number; slip: number }> = [];

if (RECOVER) { recovery(); process.exit(0); }

for (const seed of SPEEDS) {
  console.log(seed > 0 ? `-- seeded ${seed} m/s --` : '-- cruise-driven --');
  console.log(`${'stick'.padStart(7)} ${'lean'.padStart(7)} ${'|slip| deg'.padStart(11)} ${'turnLean'.padStart(9)} ${'ratio'.padStart(6)} ${'speed'.padStart(7)} ${'yaw d/s'.padStart(8)} ${'turn R m'.padStart(9)}  note`);
  for (const l of LEANS) {
    const s = measure(l, seed);
    if (!s) { console.log(`${l.toFixed(2).padStart(7)}      -           -       -        -  no settled ground contact`); continue; }
    const note = s.grounded ? '' : 'left the ground during the hold';
    const tl = turnLeanDeg(s.lean);
    console.log(
      `${l.toFixed(2).padStart(7)} ${s.lean.toFixed(3).padStart(7)} ${Math.abs(s.slipDeg).toFixed(2).padStart(11)}`
      + ` ${tl.toFixed(2).padStart(9)} ${(Math.abs(s.slipDeg) / tl).toFixed(3).padStart(6)}`
      + ` ${s.speed.toFixed(2).padStart(7)} ${s.yawDps.toFixed(1).padStart(8)}`
      // Turn radius is the number that decides whether a line fits inside the course, which slip angle alone
      // never says: ice can drift hard and still track far too wide to hold a trail.
      + ` ${(s.speed / Math.abs(THREE.MathUtils.degToRad(s.yawDps))).toFixed(1).padStart(9)}  ${note}`,
    );
    if (s.grounded && Math.abs(s.lean) > 0.05) turnLeanPoints.push({ turnLean: tl, slip: Math.abs(s.slipDeg) });
    if (s.grounded && Math.abs(s.lean) > 0.05) fitPoints.push({ lean: Math.abs(s.lean), slip: Math.abs(s.slipDeg) });
  }
  console.log('');
}

if (fitPoints.length >= 3) {
  const k = fitPoints.reduce((s, p) => s + p.lean * p.slip, 0) / fitPoints.reduce((s, p) => s + p.lean * p.lean, 0);
  const resid = Math.max(...fitPoints.map(p => Math.abs(p.slip - k * p.lean)));
  console.log(`linear-through-origin fit over ${fitPoints.length} settled points: |slip| = ${k.toFixed(2)}deg * |lean|  (max resid ${resid.toFixed(2)}deg)`);
  if (SURFACE === 5) {
    console.log(`retail ice, same fit over the v4 captures:              |slip| = 31.81deg * |lean|  (max resid 1.57deg)`);
    console.log(`  -> port/retail carve ratio ${(k / 31.81).toFixed(2)}x on FLAT ground`);
  }
}

if (turnLeanPoints.length >= 3) {
  const k = turnLeanPoints.reduce((s, p) => s + p.turnLean * p.slip, 0)
    / turnLeanPoints.reduce((s, p) => s + p.turnLean * p.turnLean, 0);
  const resid = Math.max(...turnLeanPoints.map(p => Math.abs(p.slip - k * p.turnLean)));
  console.log(`\nagainst the turn-lean curve instead of raw lean:  |slip| = ${k.toFixed(4)} * turnLean(deg)  (max resid ${resid.toFixed(2)}deg)`);
  console.log(`  a coefficient of 1.0 means the equilibrium slip IS the heading's lead angle - no fitted curve needed.`);
}
