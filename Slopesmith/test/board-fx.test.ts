// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  BoardFx, isPowderSurface, isSnowFxSurface, wakeSurfaceDepth, wakeSurfaceWidth, type BoardFxFrame,
} from '../src/app/ride/board-fx';
import { defaultMountain } from '../src/core/doc/mountain';
import { createStore } from '../src/app/state/store';

assert.equal(wakeSurfaceDepth(1), 0.85, 'packed snow carries Unity’s medium carved-wake depth');
assert.equal(wakeSurfaceDepth(3), 1, 'powder carries the deepest wake profile');
assert.equal(wakeSurfaceDepth(7), 0, 'the no-trail ice row stays out of the wake table');
assert.equal(wakeSurfaceWidth(3), 2.4, 'powder keeps Unity’s wide plow footprint');
assert.ok(isPowderSurface(3) && isPowderSurface(4) && !isPowderSurface(1));
assert.ok(isSnowFxSurface(1) && isSnowFxSurface(8) && !isSnowFxSurface(5));

const scene = new THREE.Scene();
const fx = new BoardFx(scene);
const frame: BoardFxFrame = {
  pos: new THREE.Vector3(0, -0.005, 0), fwd: new THREE.Vector3(0, 0, 1),
  vel: new THREE.Vector3(0, 0, 18), normal: new THREE.Vector3(0, 1, 0),
  grounded: true, surfaceGap: -0.005, grinding: false, surf: 1, lean: 0,
  boardPosition: new THREE.Vector3(0, -0.005, 0), boardQuaternion: new THREE.Quaternion(),
  boostActive: false, boostEnergy: 1, padBoost: false,
  boostDirection: new THREE.Vector3(0, 0, 1),
};
const step = (n: number, dz = 0.3) => { for (let i = 0; i < n; i++) {
  frame.pos.z += dz; frame.boardPosition.copy(frame.pos); fx.update(frame, 1 / 60, 'snowboard');
} };
const additiveMesh = () => scene.getObjectByName('PlayerBoardSnowParticles') as THREE.Mesh;
const chunkMesh = () => scene.getObjectByName('PlayerBoardSnowChunks') as THREE.Mesh;
const instanceAt = (mesh: THREE.Mesh, index: number) => new THREE.Vector3().fromBufferAttribute(
  (mesh.geometry as THREE.InstancedBufferGeometry).getAttribute('instancePosition') as THREE.BufferAttribute, index);

// A straight run cuts a wake: the ribbon has no carve/lean gate. Groomed snow itself sprays almost nothing
// straight (the record rate puts the chunk ring at ~1 sprite/s), and the powder/plume/sheet buffers are closed.
step(8);
assert.ok(fx.stats().wakeRows >= 6, 'a moving grounded board lays a spaced fading wake while riding straight');
// Slow travel (less than one row spacing per frame — deep powder at 60 fps) must still commit rows: the head
// tracks the board and commits against the last committed row, not against itself.
fx.clear();
step(12, 0.12);
assert.ok(fx.stats().wakeRows >= 5,
  `a slow board still lays a wake, one row per spacing (${fx.stats().wakeRows} rows over 1.44 m)`);
frame.surf = 3; frame.pos.y = -0.3; frame.surfaceGap = -0.3;
step(6, 0.12);
assert.ok(fx.stats().wakeRows >= 7, 'a board buried 30 cm in powder keeps laying the ribbon at the surface');
frame.surf = 1; frame.pos.y = -0.005; frame.surfaceGap = -0.005;
fx.clear();
step(8);
assert.ok(fx.systemStats().plume === 0 && fx.systemStats().powder === 0 && fx.systemStats().spryColumns === 0,
  `packed snow ridden straight opens none of the carve buffers (${JSON.stringify(fx.systemStats())})`);

// The boost afterimage is the separate seven-record board-geometry ring: sampled at 20 Hz, hidden until two
// records exist, and driven independently of snow contact so the same renderer follows an aimed air boost.
fx.clear(); frame.boostActive = true; frame.boostEnergy = 0.2;
step(3);
assert.equal(fx.systemStats().boostSamples, 1, 'boost caches one board pose every third 60 Hz tick');
assert.equal(fx.systemStats().boostVertices, 0, 'the native two-record draw gate suppresses the engage flash');
step(18);
assert.equal(fx.systemStats().boostSamples, 7, 'the boost pose ring caps at seven retail records');
assert.equal(fx.systemStats().boostVertices, 84, 'seven samples draw two six-vertex edge sheets per segment');
const boostMesh = scene.getObjectByName('PlayerBoardBoostTrail') as THREE.Mesh;
const boostColour = (boostMesh.geometry as THREE.BufferGeometry).getAttribute('trailColour') as THREE.BufferAttribute;
assert.ok(boostColour.getX(0) > 0.99 && boostColour.getY(0) > 0.9 && boostColour.getZ(0) < 0.01,
  'the low-meter boost tier uses the recovered yellow RGB');
frame.grounded = false; frame.surfaceGap = 2; frame.pos.y += 1; frame.boostEnergy = 1;
step(3);
assert.equal(fx.systemStats().boostSamples, 7, 'air boost feeds the same saturated pose ring');
const newestBoostVertex = boostMesh.geometry.drawRange.count - 1;
assert.ok(boostColour.getX(newestBoostVertex) > 0.99 && boostColour.getY(newestBoostVertex) < 0.1,
  'the high-meter/air boost tier uses the recovered red RGB');
frame.boostActive = false;
step(3);
assert.equal(fx.systemStats().boostSamples, 6, 'release drains exactly one oldest record per 20 Hz update');
step(15);
assert.equal(fx.systemStats().boostVertices, 0, 'the released afterimage contracts and disappears without a pop');
frame.grounded = true; frame.surfaceGap = -0.005; frame.pos.y = -0.005; frame.boardPosition.copy(frame.pos);
fx.clear(); step(8); // restore the straight-run wake fixture consumed by the independent boost lifecycle case

// The wake uses a lenient near-snow gate, unlike the strict spray/touchdown gate. A one-frame bump skip
// should extend the groove without inventing a takeoff puff.
const beforeSkip = fx.stats();
frame.grounded = false; frame.surfaceGap = 0.15; frame.pos.z += 0.3;
fx.update(frame, 1 / 60, 'snowboard');
assert.ok(fx.stats().wakeRows > beforeSkip.wakeRows, 'a near-surface bump skip keeps the wake continuous');
frame.grounded = true; frame.surfaceGap = -0.005;
step(2);

// A hard carve drives the three carve buffers: the alpha-blended chunk ring, the growing plume, and the sheet.
fx.clear();
frame.lean = 0.9;
step(6);
let systems = fx.systemStats();
assert.ok(systems.surface >= 1 && systems.plume >= 1 && systems.spryColumns >= 2,
  `a hard carve drives the chunk ring, the plume and the spray sheet (${JSON.stringify(systems)})`);
assert.ok(systems.newestSurface && !systems.newestSurface.additive && systems.newestSurface.sprite === 5,
  'groomed snow chunks are the alpha-blended blb1 sprite the record selects');
// The chunks are THROWN out of the turn and up: lean > 0 turns left (the slide is −lean·cross(n, fwd)), so the
// outside of the turn is −cross(n, fwd) = −(+x) here, and a 0.9 lean rolls the throw nearly straight up.
const throwVec = new THREE.Vector3(...systems.newestSurface!.throw);
assert.ok(throwVec.y > 8 && throwVec.z > 0 && throwVec.x <= 0.5,
  `a full carve throws the chunks up and out of the turn at a fraction of board speed (${throwVec.toArray()})`);
// P6 flies the billboards: the same chunk is somewhere else one frame later (nothing is frozen at spawn).
const chunkBefore = instanceAt(chunkMesh(), 0);
fx.update(frame, 1 / 60, 'snowboard');
const chunkAfter = instanceAt(chunkMesh(), 0);
assert.ok(chunkBefore.distanceTo(chunkAfter) > 0.02, 'surface chunks move along their throw after spawn');
const spry = scene.getObjectByName('PlayerBoardSprySheet') as THREE.Mesh;
assert.ok(spry && spry.geometry.drawRange.count > 0, 'successive carve samples build the connected four-rail sheet');
assert.equal((spry.material as THREE.ShaderMaterial).depthTest, false, 'the sheet draws with the always-pass depth state');

// Powder: the lean-independent plume opens, the dedicated powder cloud rides with the board, and the wake stays.
fx.clear();
frame.surf = 3; frame.lean = 0;
step(2);
systems = fx.systemStats();
assert.ok(fx.stats().wakeRows >= 2, 'powder retains the wide, persistent retail wake profile');
assert.ok(systems.plume >= 1 && systems.powder >= 2,
  `powder emits the growing plume and the constant contact cloud (${JSON.stringify(systems)})`);
// Puffs are batched plume → landing → powder, so the last instance is a powder puff; the plume stays frozen.
const lastInstance = () => instanceAt(additiveMesh(), (additiveMesh().geometry as THREE.InstancedBufferGeometry).instanceCount - 1);
const cloudBefore = lastInstance();
frame.pos.z += 3; fx.update(frame, 1 / 60, 'snowboard');
const cloudAfter = lastInstance();
assert.ok(cloudAfter.z - cloudBefore.z > 2, 'the powder cloud is re-placed off the current contact every frame');

// One tick allocates one chunk slot, but its integer gate is also the P6 billboard count: powder's rate expands a
// hard carve's slot into several small str3 stars.
fx.clear();
frame.surf = 3; frame.lean = 0.9; frame.vel.set(0, 0, 18);
frame.pos.z += 0.3; fx.update(frame, 1 / 60, 'snowboard');
systems = fx.systemStats();
assert.equal(systems.surfaceSlots, 1, 'one 60 Hz tick allocates at most one surface-ring slot');
assert.ok(systems.surface >= 6 && systems.newestSurface?.sprite === 7,
  `that slot carries the multi-billboard P6 count of powder twinkles (${JSON.stringify(systems)})`);

// Leaving the snow fires the takeoff puff from the same ring: additive swp2 flying with the board.
fx.clear();
frame.surf = 1; frame.lean = 0; frame.grounded = false; frame.surfaceGap = 1.5; frame.vel.set(0, 6, 14);
frame.pos.y += 0.5; frame.pos.z += 0.3; fx.update(frame, 1 / 60, 'snowboard');
frame.pos.y += 0.1; frame.pos.z += 0.25; fx.update(frame, 1 / 60, 'snowboard');
systems = fx.systemStats();
assert.ok(systems.surface >= 1 && systems.newestSurface?.additive && systems.newestSurface.sprite === 6,
  `an airborne board puffs additive swp2 from its tail (${JSON.stringify(systems)})`);
assert.equal(systems.landing, 0, 'nothing lands while still airborne');

// Touchdown: an immediate landing-cloud burst that keeps building for the next second, drawn as big squares that
// rise up the contact normal — not thin streaks, and not a hand-made ring.
for (let i = 0; i < 12; i++) { frame.pos.z += 0.25; frame.vel.y -= 0.8; fx.update(frame, 1 / 60, 'snowboard'); }
frame.grounded = true; frame.surfaceGap = -0.005; frame.vel.set(0, 0, 14); frame.pos.y = -0.005;
frame.pos.z += 0.2; fx.update(frame, 1 / 60, 'snowboard');
systems = fx.systemStats();
assert.ok(systems.landing >= 2, `touchdown fires an immediate landing-cloud burst (${JSON.stringify(systems)})`);
const landedAt = systems.landing;
step(30, 0.23);
systems = fx.systemStats();
assert.ok(systems.landing > landedAt + 6, `the landing accumulator keeps the cloud building (${JSON.stringify(systems)})`);
const landingSizes = (additiveMesh().geometry as THREE.InstancedBufferGeometry).getAttribute('instanceSize') as THREE.BufferAttribute;
let widest = 0;
const drawn = (additiveMesh().geometry as THREE.InstancedBufferGeometry).instanceCount;
for (let i = 0; i < drawn; i++) widest = Math.max(widest, landingSizes.getX(i));
assert.ok(widest > 1.0, `landing squares grow past a metre of half-extent (${widest.toFixed(2)} m)`);

// Rail travel is grounded in physics but is not snow contact: no wake, no snow buffers — sparks instead.
fx.clear();
frame.surf = 1; frame.grinding = true; frame.vel.set(0, 0, 14);
step(12);
systems = fx.systemStats();
assert.equal(fx.stats().wakeRows, 0, 'grinding lays no snow wake');
assert.ok(systems.surface === 0 && systems.plume === 0 && systems.powder === 0 && systems.spryColumns === 0,
  `grinding opens none of the snow buffers (${JSON.stringify(systems)})`);
assert.ok(systems.sparks >= 6, `a grind throws about a spark a frame (${JSON.stringify(systems)})`);
const sparkColour = (additiveMesh().geometry as THREE.InstancedBufferGeometry).getAttribute('instanceColor') as THREE.BufferAttribute;
const lastDot = (additiveMesh().geometry as THREE.InstancedBufferGeometry).instanceCount - 1;
assert.ok(sparkColour.getX(lastDot) > sparkColour.getY(lastDot) && sparkColour.getY(lastDot) > sparkColour.getZ(lastDot),
  `rail sparks are orange-yellow (${sparkColour.getX(lastDot).toFixed(2)}, ${sparkColour.getY(lastDot).toFixed(2)}, ${sparkColour.getZ(lastDot).toFixed(2)})`);
assert.ok(lastDot + 1 >= systems.sparks * 2, 'each spark draws a multi-copy trail');
// Rock/metal ridden on the ground sparks the same way and stays out of the snow buffers.
fx.clear();
frame.grinding = false; frame.surf = 13;
step(12);
systems = fx.systemStats();
assert.ok(systems.sparks >= 6 && systems.surface === 0 && fx.stats().wakeRows === 0,
  `metal ridden on the ground sparks instead of spraying snow (${JSON.stringify(systems)})`);
frame.surf = 1;

assert.ok(scene.getObjectByName('PlayerBoardFx'), 'the local ride owns one named FX group');
const particleMesh = additiveMesh();
assert.ok(particleMesh.isMesh && particleMesh.geometry instanceof THREE.InstancedBufferGeometry,
  'sprites use instanced world-space quads rather than hardware-limited WebGL points');
assert.doesNotMatch((particleMesh.material as THREE.ShaderMaterial).vertexShader, /gl_PointSize/,
  'the 8 m plume and 5 m landing squares have no point-size clamp');
assert.equal((particleMesh.material as THREE.ShaderMaterial).blending, THREE.AdditiveBlending, 'puff buffers draw additive');
assert.equal((chunkMesh().material as THREE.ShaderMaterial).blending, THREE.NormalBlending,
  'the surface chunk ring draws alpha-over, the blend its material record selects');
assert.deepEqual((particleMesh.material as THREE.ShaderMaterial).uniforms.particleAtlasGrid.value.toArray(), [4, 3],
  'board spray renders from the decoded shared-particle atlas rather than procedural masks');
fx.dispose();
assert.equal(scene.getObjectByName('PlayerBoardFx'), undefined, 'disposing a ride removes every board-FX draw object');

// The preference defaults on for the product but honours an explicit stored opt-out.
const fresh = createStore({ mdoc: defaultMountain(), currentMode: 'play', storedUi: {} });
const disabled = createStore({ mdoc: defaultMountain(), currentMode: 'play', storedUi: { playBoardFx: false } });
const standard = createStore({
  mdoc: defaultMountain(), currentMode: 'play', storedUi: { playSnowboardStance: 'standard' },
});
const roughCutouts = createStore({
  mdoc: defaultMountain(), currentMode: 'play', storedUi: { playSmoothCutouts: false },
});
const legacyAiOn = createStore({
  mdoc: defaultMountain(), currentMode: 'play', storedUi: { playAi: true, playAiMax: 6 },
});
const legacyAiOff = createStore({
  mdoc: defaultMountain(), currentMode: 'play', storedUi: { playAi: false, playAiMax: 6 },
});
const countedAi = createStore({
  mdoc: defaultMountain(), currentMode: 'play', storedUi: { playAiMax: 3 },
});
const excessiveVrScale = createStore({
  mdoc: defaultMountain(), currentMode: 'play', storedUi: { playVrRenderScale: 4 },
});
assert.equal(fresh.playBoardFxOn, true, 'Board FX defaults on in Test mode');
assert.equal(disabled.playBoardFxOn, false, 'the Test panel Board FX opt-out persists');
assert.equal(fresh.playSnowboardStance, 'goofy', 'the original left-facing snowboard stance remains the default');
assert.equal(standard.playSnowboardStance, 'standard', 'the right-facing standard stance persists');
assert.equal(fresh.playSmoothCutoutsOn, true, 'MSAA plus smooth cutouts defaults on across editor and Test');
assert.equal(roughCutouts.playSmoothCutoutsOn, false, 'the fast alpha-hash/MSAA opt-out persists');
assert.equal(fresh.playAiMax, 0, 'AI riders default off through the unified zero count');
assert.equal(fresh.playVrRenderScale, 1.5, 'WebXR render scale defaults to 1.5×');
assert.equal(excessiveVrScale.playVrRenderScale, 3, 'persisted WebXR render scale is capped at 3×');
assert.equal(legacyAiOn.playAiMax, 6, 'the former AI checkbox and max migrate into one positive count');
assert.equal(legacyAiOff.playAiMax, 0, 'a former disabled checkbox wins over its stale saved max during migration');
assert.equal(countedAi.playAiMax, 3, 'the unified AI rider count persists without a second boolean');
const playToolsSource = readFileSync(resolve(process.cwd(), 'src/app/ui/tool-panels/play.ts'), 'utf8');
const gearRow = playToolsSource.indexOf('gui.$children.appendChild(gearButtonRow)');
const stanceGate = playToolsSource.indexOf("if (store.playRideGear === 'snowboard')", gearRow);
const launchControls = playToolsSource.indexOf('if (play.launching)', stanceGate);
assert(gearRow >= 0 && stanceGate > gearRow && launchControls > stanceGate,
  'Standard / Goofy is gated to snowboards directly below the gear row and above launch controls');

// Allocation boundary: only the player TestRide imports BoardFx. AI physics/pose stays effect-free.
const app = resolve(process.cwd(), 'src/app/ride');
assert.match(readFileSync(resolve(app, 'session.ts'), 'utf8'), /new BoardFx\(this\.o\.scene, this\.o\.boardFxGround\)/);
assert.doesNotMatch(readFileSync(resolve(app, 'ai.ts'), 'utf8'), /BoardFx|PlayerBoardFx/,
  'AI riders never allocate the local-player board renderer');
const playPanel = readFileSync(resolve(process.cwd(), 'src/app/ui/tool-panels/play.ts'), 'utf8');
assert.match(playPanel, /\.name\('Board FX'\)/, 'the Test panel exposes the Board FX checkbox');
assert.match(playPanel, /viewport\.setRideBoardFx\(v\)/, 'the checkbox applies live to an active Test ride');

console.log('BOARD FX: PASS');
