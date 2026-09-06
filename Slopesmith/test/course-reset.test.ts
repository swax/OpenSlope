// tier: fast

/**
 * THE CARRY-BACK ([Trailmap: 395], docs/016): where a rider that has gone out of play is put back down. Every
 * out-of-play condition the model detects — the out-of-bounds floor, an authored Reset (Surf_0) surface, and the
 * wedge integrator — takes one carry-back exit when its host enables automatic recovery. The rider's reset
 * button reaches that exit unconditionally. The destination is the COURSE near where they left it, not the start
 * gate. A run down MEGAPLEX is two kilometres long; being returned to the top of it for touching a wall is the
 * difference between a test bench you can iterate on and one you cannot.
 *
 * These check the three tiers and the two things that make them safe: that the tier the mountain can actually
 * supply is the one taken, that a reset which keeps re-firing escapes to the start gate instead of looping
 * forever, and that the AI field is left on its own rubber-banded reset rather than pre-empted by this one.
 *
 * Run: npx tsx test/course-reset.test.ts
 */
import * as THREE from 'three';
import { RESET_SPEED, createRideModel } from '../src/app/ride/physics';

let failures = 0;
function ok(cond: boolean, label: string, detail = '') {
  if (cond) console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };

// ---- a constant slope along +Z, and a course line straight down the middle of it ----
const D2R = Math.PI / 180;
const GRADE = -Math.tan(12 * D2R);
const ZMAX = 600;
const yOf = (z: number) => GRADE * z;
const OOB_FLOOR = yOf(ZMAX) - 100;

function makeSlope() {
  const XS: number[] = [];
  for (let x = -80; x <= 80; x += 5) XS.push(x);
  const positions: number[] = [];
  const nz = ZMAX / 4;
  for (let iz = 0; iz <= nz; iz++) for (const x of XS) positions.push(x, yOf(iz * 4), iz * 4);
  const index: number[] = [];
  const W = XS.length;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < W - 1; ix++) {
      const a = iz * W + ix, b = a + 1, c = a + W, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld(true);
  return mesh;
}

const terrain = makeSlope();
/** The authored line, deliberately offset 6 m across the fall line so "snapped to the course" is measurable —
 *  a course down x = 0 could not be told apart from a rider who simply stayed where they were. */
const course: THREE.Vector3[] = [];
for (let z = 0; z <= ZMAX; z += 20) course.push(new THREE.Vector3(6, yOf(z), z));

function rider(opts: {
  course?: readonly THREE.Vector3[];
  carryBack?: boolean;
  automaticRespawnAvailable?: () => boolean;
} = {}) {
  const model = createRideModel({
    spawn: new THREE.Vector3(0, yOf(0), 0), heading: new THREE.Vector3(0, 0, 1),
    terrain, surfaceOf: () => 1, oobFloorY: OOB_FLOOR, keys, stick, onRespawn: () => {},
    ...opts,
  });
  model.start();
  return model;
}

// Automatic recovery is a policy above the carry-back itself. A free ride can fall below the world without a
// hidden teleport, while the exact same public reset remains the player's unconditional way back.
{
  let automatic = false;
  let respawns = 0;
  const model = createRideModel({
    spawn: new THREE.Vector3(0, yOf(0), 0), heading: new THREE.Vector3(0, 0, 1),
    terrain, surfaceOf: () => 1, oobFloorY: OOB_FLOOR, keys, stick, course,
    automaticRespawnAvailable: () => automatic,
    onRespawn: () => { respawns++; },
  });
  model.start();
  respawns = 0;
  model.st.pos.set(20, OOB_FLOOR - 50, 260);
  model.step(1 / 60);
  ok(respawns === 0 && model.st.pos.y < OOB_FLOOR,
    'a disabled automatic-recovery gate leaves an out-of-bounds free rider where physics put them');

  model.resetToCourse();
  ok(respawns === 1 && model.st.pos.y > OOB_FLOOR,
    'the manual carry-back remains unconditional while automatic recovery is disabled');

  automatic = true;
  model.st.pos.y = OOB_FLOOR - 50;
  model.step(1 / 60);
  ok(respawns === 2 && model.st.pos.y > OOB_FLOOR,
    'enabling the same gate restores automatic recovery for a live scored run');
}

/** Ride until the rider is well down the mountain, so "the start" and "where they were" are far apart. */
function rideDown(model: ReturnType<typeof rider>, seconds = 12) {
  for (let i = 0; i < seconds * 60; i++) model.step(1 / 60);
  return model.st.pos.clone();
}

/** Fall out of the world: the out-of-bounds floor, which takes the same exit the wedge integrator does. */
function fallOut(model: ReturnType<typeof rider>) {
  model.st.pos.y = OOB_FLOOR - 50;
  model.step(1 / 60);
}

// ---------------------------------------------------------------------------------------------------------
// 1) The course line. The rider is put back ON it, at the height of the real ground under it — never at the
// line's own Y, and never at the gate.
{
  const model = rider({ course });
  const left = rideDown(model);
  ok(left.z > 100, 'the rider is well down the mountain before going out of play', `z = ${left.z.toFixed(1)} m`);

  fallOut(model);
  const back = model.st.pos;
  ok(Math.abs(back.z - left.z) < 25,
    'a rider that falls out of the world is put back where they left, not at the start gate',
    `z = ${back.z.toFixed(1)} m (left at ${left.z.toFixed(1)}, gate at 0)`);
  ok(Math.abs(back.x - 6) < 1.5, 'and put back ON the authored course line', `x = ${back.x.toFixed(2)} m (line at 6)`);
  ok(Math.abs(back.y - yOf(back.z)) < 2.5,
    'at the height of the ground under the line, which is cast for separately',
    `y = ${back.y.toFixed(1)} m (ground ${yOf(back.z).toFixed(1)})`);
  ok(model.st.fwd.z > 0.9, 'facing down-course', `fwd.z = ${model.st.fwd.z.toFixed(3)}`);
  ok(Math.abs(model.st.vel.length() - RESET_SPEED) < 0.01,
    'and set down already moving, at the reset speed rather than the speed they died with',
    `${model.st.vel.length().toFixed(2)} m/s`);
}

// WebXR can ask the same resolver to recover an on-foot rider rather than the parked board. The optional query
// point must choose the nearby course segment without first warping the hidden board model to the walker.
{
  const model = rider({ course });
  const walker = new THREE.Vector3(28, yOf(420), 420);
  model.resetToCourse(walker);
  ok(Math.abs(model.st.pos.z - walker.z) < 2,
    'an external on-foot query point respawns at that rider’s course progress',
    `z = ${model.st.pos.z.toFixed(1)} m (walker ${walker.z.toFixed(1)})`);
  ok(Math.abs(model.st.pos.x - 6) < 1.5,
    'the on-foot query still lands on the authored course rather than at the walker’s lateral offset',
    `x = ${model.st.pos.x.toFixed(2)} m (line at 6, walker at ${walker.x})`);
}

// A course line that folds back past some far part of the mountain is not the line the rider left, so the
// nearest point on it is the wrong answer and the trail is taken instead.
{
  const far: THREE.Vector3[] = [];
  for (let z = 0; z <= ZMAX; z += 20) far.push(new THREE.Vector3(4000, yOf(z), z));
  const model = rider({ course: far });
  const left = rideDown(model);
  fallOut(model);
  ok(Math.abs(model.st.pos.x) < 50,
    'a course line hundreds of metres away is not the line the rider left, and is not used',
    `x = ${model.st.pos.x.toFixed(1)} m (line at 4000)`);
  ok(Math.abs(model.st.pos.z - left.z) < 25, 'the trail answers instead', `z = ${model.st.pos.z.toFixed(1)} m`);
}

// ---------------------------------------------------------------------------------------------------------
// 2) The breadcrumb trail — a mountain with no authored course still has somewhere honest to put a rider back.
{
  const model = rider();
  const left = rideDown(model);
  fallOut(model);
  const back = model.st.pos;
  ok(back.z > 100 && back.z <= left.z + 1,
    'with no course line the rider is put back on their own trail, a little way back up it',
    `z = ${back.z.toFixed(1)} m (left at ${left.z.toFixed(1)})`);
  ok(left.z - back.z < 40, 'and only a little way back — the trail is not a lap of the mountain',
    `${(left.z - back.z).toFixed(1)} m back`);
  ok(Math.abs(back.y - yOf(back.z)) < 2.5, 'on the ground the crumb was taken from',
    `y = ${back.y.toFixed(1)} m (ground ${yOf(back.z).toFixed(1)})`);
  ok(model.st.fwd.z > 0.9, 'facing the way they were travelling', `fwd.z = ${model.st.fwd.z.toFixed(3)}`);
}

// ---------------------------------------------------------------------------------------------------------
// 3) The start gate, and only as the escape: a carry-back that keeps landing the rider somewhere that puts them
// straight back out of play is a loop, and the third one inside the window breaks out of it.
{
  const model = rider({ course });
  rideDown(model);
  fallOut(model);
  const first = model.st.pos.clone();
  ok(first.z > 100, 'the first reset carries the rider back on-course', `z = ${first.z.toFixed(1)} m`);
  rideDown(model, 0.5); fallOut(model);
  ok(model.st.pos.z > 100, 'so does the second', `z = ${model.st.pos.z.toFixed(1)} m`);
  rideDown(model, 0.5); fallOut(model);
  ok(model.st.pos.z < 5,
    'the third inside the window means the target itself is the trap: out to the run start',
    `z = ${model.st.pos.z.toFixed(1)} m`);

  // ...and the start gate it escapes to is the RUN's, not whatever the last carry-back left behind as the
  // respawn point — which is what `spawn` holds by then. Getting this wrong sends the rider straight back
  // into the loop it just broke out of.
  ok(Math.abs(model.st.pos.x) < 3,
    'the gate is the run start, not the last reset point the warp saved',
    `x = ${model.st.pos.x.toFixed(2)} m (gate 0, last reset ${first.x.toFixed(2)})`);

  // Once the streak lapses the carry-back is armed again — the escape is a circuit breaker, not a latch.
  const left = rideDown(model, 8);
  fallOut(model);
  ok(Math.abs(model.st.pos.z - left.z) < 25, 'and after the window lapses the carry-back is armed again',
    `z = ${model.st.pos.z.toFixed(1)} m (left at ${left.z.toFixed(1)})`);
}

// ---------------------------------------------------------------------------------------------------------
// The condition this was reported over: WEDGED ON THE LEVEL. The wedge integrator fires against a prop that has
// simply stopped the rider — no fall, no authored volume — and it took the same exit to the start gate that a
// fall did, which on a two-kilometre run is most of the run thrown away for touching a wall.
{
  let respawns = 0;
  let firstReset: THREE.Vector3 | null = null;
  const model = createRideModel({
    spawn: new THREE.Vector3(0, yOf(0), 0), heading: new THREE.Vector3(0, 0, 1),
    terrain, surfaceOf: () => 1, oobFloorY: OOB_FLOOR, keys, stick, course,
    // A wall square across the fall line, which the slope then holds the rider against: consecutive shoving
    // contacts, which is exactly what the integrator is a detector for.
    obstacles: [{
      key: 'authored:wall', object: { kind: 'authored', id: 'wall' },
      geometry: new THREE.BoxGeometry(120, 8, 1),
      matrixWorld: new THREE.Matrix4().makeTranslation(0, yOf(150) + 4, 150),
      solid: true, bounce: 0, surface: -1,
    }],
    onRespawn: () => { if (++respawns === 2) firstReset = model.st.pos.clone(); }, // 1 is the start itself
  });
  model.start();
  for (let i = 0; i < 30 * 60 && respawns < 2; i++) model.step(1 / 60);
  ok(firstReset !== null, 'a rider a prop has pinned is taken out of play by the wedge integrator');
  const at = firstReset as THREE.Vector3 | null;
  ok(!!at && at.z > 100,
    'and is carried back onto the course beside the wall that stopped them, not to the top of the run',
    at ? `z = ${at.z.toFixed(1)} m (wall at 150, gate at 0)` : 'never reset');
  ok(!!at && Math.abs(at.x - 6) < 1.5, 'on the authored line', at ? `x = ${at.x.toFixed(2)} m` : '');
}

// The gate applies to the object-wedge branch too, not just the easy-to-fixture out-of-bounds branch above.
{
  let respawns = 0;
  const model = createRideModel({
    spawn: new THREE.Vector3(0, yOf(0), 0), heading: new THREE.Vector3(0, 0, 1),
    terrain, surfaceOf: () => 1, oobFloorY: OOB_FLOOR, keys, stick, course,
    obstacles: [{
      key: 'authored:free-wall', object: { kind: 'authored', id: 'free-wall' },
      geometry: new THREE.BoxGeometry(120, 8, 1),
      matrixWorld: new THREE.Matrix4().makeTranslation(0, yOf(150) + 4, 150),
      solid: true, bounce: 0, surface: -1,
    }],
    automaticRespawnAvailable: () => false,
    onRespawn: () => { respawns++; },
  });
  model.start();
  respawns = 0;
  for (let i = 0; i < 30 * 60; i++) model.step(1 / 60);
  ok(respawns === 0,
    'a prop wedge does not automatically carry a free rider away from the collision');
  model.resetToCourse();
  ok(respawns === 1,
    'the manual button can still recover that wedged free rider');
}

// ---------------------------------------------------------------------------------------------------------
// 4) The AI field opts out. Its riders run their own rubber-banded reset over the respawnable AIP network, which
// places them with the pack rather than where they fell — and that reset is ARMED by the plain respawn, so a
// carry-back here would warp every reset rider twice and put the second one somewhere the field never chose.
{
  const model = rider({ course, carryBack: false });
  const left = rideDown(model);
  fallOut(model);
  ok(model.st.pos.z < 5,
    'a rider whose owner runs its own reset gets the plain respawn, untouched',
    `z = ${model.st.pos.z.toFixed(1)} m (left at ${left.z.toFixed(1)})`);
}

console.log(failures ? `COURSE RESET: ${failures} FAILED` : 'COURSE RESET: PASS');
process.exit(failures ? 1 : 0);
