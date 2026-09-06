// tier: fast

import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  createRideModel,
  groundRestDepth,
  SURFACE_ROWS,
  type RideObstacleHit,
  type RideObstacleSource,
  unionLeafNormal,
} from '../src/app/ride/physics';
import { RIDER_BODY_R, RIDER_BODY_Y, RIDER_TORSO_Y } from '../src/app/ride/physics-tuning';
import type { RideTelemetryEvent, RideTelemetryTick } from '../src/app/ride/telemetry';
import { readPhysicsBodyMassProps, readPhysicsBodySpheres } from '../src/server/routes/props';
import {
  crackedBreakTombstonesCollider, localRideEffectSubject, playProximityRadius,
} from '../src/app/viewport/scene/reference-effects';
import { createRideColliderOverlay } from '../src/app/viewport/scene/ride-collider-overlay';
import { PropTextureCache } from '../src/app/props/textures';
import {
  buildUnityBodyRecipe, decodePhysicsBodyTree, scaleBodyShape, unityBodyRecipeKind,
  type DecodedPhysicsBody,
} from '../src/core/collision/unity-body';

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0 };

assert.equal(playProximityRadius('collision', 100), null,
  'even a huge rendered host cannot turn proximity into a collision event');
assert.equal(playProximityRadius('trigger', 100), 101,
  'trigger circumstances retain their rendered-bounds proximity volume');
assert.equal(playProximityRadius('trigger', 100, true), null,
  'an explicitly dispatched trigger column cannot also fire from rider proximity');

assert.equal(crackedBreakTombstonesCollider({
  id: 'support-kill', mainType: 0, semanticType: 'property.node-tombstone', references: {},
  payload: { type0: { SubType: 5, DeadNodeMode: 2 } },
}), true, 'a cracked-break DeadNodeMode-2 call identifies the invisible support collider it tombstones');
assert.equal(crackedBreakTombstonesCollider({
  id: 'ordinary-kill', mainType: 0, semanticType: 'property.breakable-kill', references: {},
  payload: { type0: { SubType: 5, DeadNodeMode: 4 } },
}), false, 'the cracked tombstone path stays distinct from the already-handled breakable kill');

assert.equal(localRideEffectSubject(null), null,
  'the local human remains the null rider subject used by the ride layer');
assert.equal(localRideEffectSubject(3), 3,
  'an AI interaction retains the opponent slot that earned its gameplay effect');
assert.equal(localRideEffectSubject('remote'), undefined,
  'a peer world replay cannot be translated into this client\'s human or AI rider');

// Native per-instance lighting wraps the controlled base in a final material variant. That last draw layer
// must own its Texture wrapper too: otherwise changing one pane's frame can repaint every glass draw that
// shares material 43 even though the underlying controlled cache entries have distinct runtime keys.
{
  const cache = new PropTextureCache() as any;
  const pendingTextures: THREE.Texture[] = [];
  const complete: Array<(texture: THREE.Texture) => void> = [];
  cache.loader = { load: (file: string, onLoad: (texture: THREE.Texture) => void) => {
    const texture = new THREE.Texture();
    texture.name = file;
    pendingTextures.push(texture);
    complete.push(onLoad);
    return texture;
  } };
  const effect = { textureFlip: { direction: 0, speed: 0, length: 0, dwell: false } };
  const base = cache.material('MEGAPLE', '0050.png', effect, ['0050.png', '0069.png'], 'pane:127');
  const otherBase = cache.material('MEGAPLE', '0050.png', effect, ['0050.png', '0069.png'], 'pane:124');
  const pane = cache.native(base);
  const otherPane = cache.native(otherBase);
  assert.equal(base.map.version, 0,
    'an animated clone does not ask Three to upload while its loader Source has no image');
  assert.equal(pane.map.version, 0,
    'a native animated clone also stays upload-idle while the shared image is pending');
  // TextureLoader returns before its Image is ready, then updates its original Source asynchronously. Intact
  // draws must still be attached to that Source or they remain empty until a later runtime command uploads one.
  for (const [index, texture] of pendingTextures.entries()) {
    texture.image = { file: texture.name };
    texture.needsUpdate = true;
    complete[index](texture);
  }
  await Promise.resolve();
  assert.ok(base.map.version > 0 && pane.map.version > 0,
    'successful loader completion releases pending clones for upload');
  const intactImage = base.map.source.data;
  assert.equal(pane.map.source.data, intactImage,
    'the intact draw receives TextureLoader completion while it is still in Edit mode');
  assert.notEqual(pane.map, base.map, 'the final native-lit controlled draw owns a detached texture wrapper');
  assert.equal(pane.map.source, otherPane.map.source,
    'intact controlled draws retain the loader Source so its asynchronous image completion reaches them');
  const intactMap = pane.map;
  const intactSource = pane.map.source;
  cache.controlMaterial(pane, 'texture-flip', 2, 1);
  assert.notEqual(pane.map, intactMap,
    'the first frame change replaces the addressed material map instead of mutating an uploaded shared map');
  assert.notEqual(pane.map.source, intactSource,
    'the addressed pane forks a private renderer Source on its first actual frame change');
  assert.notEqual(pane.map.source, otherPane.map.source,
    'the cracked pane can no longer update another pane through the renderer Source cache');
  assert.notEqual(pane.map.source.data, intactImage, 'the addressed pane selects its cracked image');
  assert.equal(base.map.source.data, intactImage, 'the controlled base remains intact');
  assert.equal(otherPane.map.source.data, intactImage,
    'another pane sharing the native material remains intact');
}

// Always-on flipbooks use the same renderer-safe ownership transition as controlled panes. Assigning a new
// Source directly to an uploaded Texture appears to render, but Three leaves its WebGL allocation registered
// under the old Source; disposing project-owned textures during a mountain import then crashes while reading
// that missing allocation's `usedTimes`.
{
  const cache = new PropTextureCache() as any;
  const loaded: THREE.Texture[] = [];
  cache.loader = { load: (file: string) => {
    const texture = new THREE.Texture();
    texture.name = file;
    loaded.push(texture);
    return texture;
  } };
  const effect = { textureFlip: { direction: 0, speed: 11, length: 0, dwell: false } };
  const ambient = cache.material('Custom', 'rest.png', effect, ['rest.png', 'active.png']);
  for (const texture of loaded) {
    texture.image = { file: texture.name };
    texture.needsUpdate = true;
  }
  const restingMap = ambient.map;
  const restingSource = restingMap.source;
  const restingImage = restingSource.data;
  cache.setWorldEffectsEnabled(true);
  cache.stepWorldEffects(0.1);
  assert.notEqual(ambient.map, restingMap,
    'an ambient frame change replaces the Texture wrapper instead of changing its renderer Source in place');
  assert.notEqual(ambient.map.source, restingSource,
    'an ambient frame change owns a Source whose WebGL disposal bookkeeping cannot alias the resting frame');
  assert.equal(restingSource.data, restingImage, 'the loader Source remains on its resting image');
  assert.notEqual(ambient.map.source.data, restingImage, 'the ambient material advances to its next frame');
  assert.doesNotThrow(() => cache.invalidateProjectAssets(),
    'switching mountain assets can dispose the advanced ambient texture');
}

function floorAt(y = 0): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -30, y, -30, -30, y, 30, 30, y, -30,
    30, y, -30, -30, y, 30, 30, y, 30,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

function wall(solid: boolean, surface = -1): RideObstacleSource {
  return {
    key: 'authored:wall', object: { kind: 'authored', id: 'wall' },
    geometry: new THREE.BoxGeometry(4, 2, 0.2),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, 1, 3),
    solid, bounce: solid ? 0.5 : 0, surface,
  };
}

/** `drive: 0` holds the authored approach speed for fixtures that are about the impact, not about cruising:
 *  the surface cruise drive otherwise pulls any grounded rider up toward snow's 14.4 m/s target. */
function movingAt(obstacle: RideObstacleSource, hits: RideObstacleHit[], drive?: number) {
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [obstacle], oobFloorY: -100, keys, stick, drive,
    onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
  model.st.vel.set(0, 0, 12);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  return model;
}

// An effect kill happens after Play captures its immutable mesh BVH. Retirement must mask those cached faces;
// hiding only the rendered object leaves an invisible wall/floor in the running ride.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt(wall(true), hits);
  model.retireObstacle('authored:wall');
  model.step(1 / 60);
  assert.ok(model.st.pos.z > 2.15 && model.st.vel.z > 0,
    'retiring an effect-killed mesh collider lets the rider pass its cached BVH faces');
  assert.equal(hits.length, 0, 'a retired collider no longer dispatches ghost contacts');

  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
  model.st.vel.set(0, 0, 12);
  model.restoreObstacle('authored:wall');
  model.step(1 / 60);
  assert.ok(model.st.pos.z < 2.15 && model.st.vel.z < 0,
    'restoring a popped pickup re-enables its cached obstacle faces');
  assert.equal(hits.length, 1, 'the restored collider dispatches a fresh contact');
}

// A grounded board must sweep props too. Terrain barrier sweeps are airborne-only, which was the original gap:
// the rider could pass through every fence/tree/custom solid while carving normally on the run.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt(wall(true), hits);
  model.step(1 / 60);
  assert.ok(model.st.pos.z < 2.15, 'a solid prop clips the tick before the board crosses its front face');
  assert.ok(model.st.vel.z < 0, 'the authored 0.5 bounce kicks velocity back from the prop plane');
  assert.equal(hits.length, 1, 'one swept impact reports one debounced prop contact');
  assert.deepEqual(hits[0].object, { kind: 'authored', id: 'wall' });
  assert.ok(hits[0].impactSpeed > 11.9, 'the audio runtime receives the true normal impact speed');
}

// PlayerBounce is restitution plus the native universal 2 km/h outward floor. A soft prop struck slowly must
// still eject the rider instead of absorbing nearly all normal speed in the preview.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt({ ...wall(true), bounce: 0.03, playerBounce: true }, hits);
  model.st.pos.z = 2.11;
  model.st.vel.z = 1;
  model.step(1 / 60);
  assert.ok(model.st.vel.z < -0.55 && model.st.vel.z > -0.57,
    `a soft slow hit leaves at the specified 2 km/h floor (got ${model.st.vel.z})`);
}

// A generic/manual solid with no active native response flag remains a collide-and-slide fallback, so even a
// stale nonzero amount must neither kick nor apply the 2 km/h floor. Native PlayerBounce-off props are filtered
// out of the solid obstacle set before this stage.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt({ ...wall(true), bounce: 0.6, playerBounce: false }, hits);
  model.step(1 / 60);
  assert.ok(Math.abs(model.st.vel.z) < 1e-9,
    'a generic solid fallback cancels the inward component without restitution or eject floor');
  assert.equal(hits.length, 1, 'collide-and-slide still dispatches the prop contact');
}

// Retail foliage / a non-solid custom prop with a hit sound uses the same exact mesh crossing without a response.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt(wall(false), hits);
  model.step(1 / 60);
  assert.ok(model.st.pos.z > 2.15 && model.st.vel.z > 0,
    'a ride-through prop reports contact without changing rider motion');
  assert.equal(hits.length, 1, 'ride-through contact still reaches sounds and collision graphs');
}

// An elevated smash-through panel — GARI's Lcd_ScreenLogo, a mode-2 response-mass-0 box whose underside rides
// above the board sweep — is met by a grounded rider's TORSO, and the grounded body stab is what reports it.
// The PS2 evidence brackets the reach from both sides: the screen breaks ridden through on the snow, while a
// gate lifted 2 m clear is passed beneath without a dispatch (auth-gate-m1-lifted). Head height honours both,
// and grounded-only keeps the negative robust: a rider carried through the panel AIRBORNE has no stab at all —
// the board-first jump smash is the swept samples' job, which is exactly how it already worked.
{
  const panel = (bottomY: number): RideObstacleSource => ({
    key: 'reference:screen', object: { kind: 'reference', index: 500 },
    geometry: new THREE.BoxGeometry(6, 1, 0.3),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, bottomY + 0.5, 3),
    solid: false, bounce: 0, surface: -1,
  });
  {
    const hits: RideObstacleHit[] = [];
    const model = movingAt(panel(0.7), hits);
    for (let tick = 0; tick < 12 && !hits.length; tick++) model.step(1 / 60);
    assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'reference', index: 500 }],
      'a grounded rider reports the elevated pass-through panel their body rides through');
  }
  {
    const hits: RideObstacleHit[] = [];
    const model = movingAt(panel(2.0), hits);
    for (let tick = 0; tick < 30; tick++) model.step(1 / 60);
    assert.equal(hits.length, 0,
      'the same panel lifted 2 m is passed beneath without a report — the PS2 negative control');
  }
  {
    const hits: RideObstacleHit[] = [];
    const model = movingAt(panel(0.7), hits);
    model.st.pos.y = 0.3; // airborne, low enough that the board sweep stays under the panel's underside
    model.st.grounded = false;
    for (let tick = 0; tick < 8; tick++) model.step(1 / 60);
    assert.equal(hits.length, 0, 'an airborne pass leaves the stab off; only board-first contact smashes');
  }
}

// Native mode-3 bodies stay analytic. The non-uniform transform makes this an ellipsoid in world space; a
// tessellated render-mesh fallback would either miss the recovered body entirely or approximate its boundary.
{
  const hits: RideObstacleHit[] = [];
  const body: RideObstacleSource = {
    key: 'reference:body', object: { kind: 'reference', index: 77 },
    spheres: new Float32Array([0, 0, 0, 1]),
    matrixWorld: new THREE.Matrix4().compose(
      new THREE.Vector3(0, 1, 2.65), new THREE.Quaternion(), new THREE.Vector3(2, 1, 0.5)),
    solid: true, bounce: 0.5, surface: -1,
  };
  const model = movingAt(body, hits);
  model.step(1 / 60);
  assert.ok(model.st.pos.z < 2.15 && model.st.vel.z < 0,
    'the analytic sphere-tree leaf blocks at its affine-transformed boundary');
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'reference', index: 77 }]);
}

// A prop that MOVES during the run carries its collider with it. The obstacle set is one BVH baked over
// world-space triangles at launch, so without a per-frame refit a deploying ramp or a retracting pillar leaves
// its wall standing in the pose Play started in: you ride through the thing you can see, and into the thing you
// can't. `liveMatrix` is the opt-in — a source without one stays in the bake, which is what static props want.
{
  // Stowed: the wall is baked across the rider's path, then the clip swings it clear before the tick.
  const hits: RideObstacleHit[] = [];
  const pose = new THREE.Matrix4().makeTranslation(0, 1, 3);
  const model = movingAt({ ...wall(true), matrixWorld: pose.clone(), liveMatrix: () => pose }, hits);
  pose.makeTranslation(0, 1, 40);
  model.step(1 / 60);
  assert.equal(hits.length, 0, 'a prop that moved out of the way stops colliding where it was baked');
  assert.ok(model.st.vel.z > 0, 'the rider keeps its speed through the vacated space');
}
{
  // A shared source set may outlive the first solver using it (AI and the player share it). If it moved after
  // capture but before this solver was constructed, its current version must describe the current provider
  // pose — never bless the older matrixWorld snapshot as though it were already up to date.
  const hits: RideObstacleHit[] = [];
  const pose = new THREE.Matrix4().makeTranslation(0, 1, 40);
  const model = movingAt({ ...wall(true), matrixWorld: new THREE.Matrix4().makeTranslation(0, 1, 3),
    liveMatrix: () => pose, poseVersion: () => 1 }, hits);
  model.step(1 / 60);
  assert.equal(hits.length, 0,
    'a solver created after a prop moved bakes the provider pose instead of its older capture snapshot');
  assert.ok(model.st.vel.z > 0, 'the newly mounted rider passes through the already-vacated space');
}
{
  // Deployed: baked clear, swung into the path. The refit has to ADD collision the launch bake never had.
  const hits: RideObstacleHit[] = [];
  const pose = new THREE.Matrix4().makeTranslation(0, 1, 40);
  const model = movingAt({ ...wall(true), matrixWorld: pose.clone(), liveMatrix: () => pose }, hits);
  pose.makeTranslation(0, 1, 3);
  model.step(1 / 60);
  assert.equal(hits.length, 1, 'a prop that deployed into the path collides at the pose the clip gave it');
  assert.ok(model.st.vel.z < 0, 'the moved collider carries its own authored bounce');
}
{
  // The same motion without a provider: the static majority must stay exactly where they were baked.
  const hits: RideObstacleHit[] = [];
  const source = { ...wall(true), matrixWorld: new THREE.Matrix4().makeTranslation(0, 1, 40) };
  const model = movingAt(source, hits);
  source.matrixWorld.makeTranslation(0, 1, 3);
  model.step(1 / 60);
  assert.equal(hits.length, 0, 'a source with no liveMatrix is frozen in the bake, whatever its matrix does after');
}
{
  // Test mode's wire overlay is a view of the solver, not of the source snapshot. It must re-gather when a live
  // collider moves even while the rider stays put, otherwise a correct refit still LOOKS like an invisible wall.
  const parent = new THREE.Group();
  const overlay = createRideColliderOverlay(parent);
  const pose = new THREE.Matrix4().makeTranslation(0, 1, 3);
  let version = 0;
  overlay.setSources([{ ...wall(true), matrixWorld: pose.clone(), liveMatrix: () => pose,
    poseVersion: () => version }]);
  overlay.setVisible(true);
  const rider = { pos: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), boardUp: new THREE.Vector3(0, 1, 0) };
  const drawnZ = () => {
    const world = overlay.group.children[0] as THREE.Group;
    const position = (world.children[0] as THREE.LineSegments).geometry.getAttribute('position');
    let sum = 0;
    for (let index = 0; index < position.count; index++) sum += position.getZ(index);
    return sum / position.count;
  };
  overlay.update(rider);
  assert.ok(Math.abs(drawnZ() - 3) < 1e-6, 'the overlay starts at the collider pose supplied to the solver');
  pose.makeTranslation(0, 1, 9);
  version++;
  overlay.update(rider);
  assert.ok(Math.abs(drawnZ() - 9) < 1e-6,
    'the overlay follows a changed live collider without requiring the rider to leave its gather slab');
  overlay.dispose();
}
{
  // The refit is a SUBTREE refit: one BVH holds every source, and a mover re-derives only the branch its own
  // triangles landed in (a full-tree refit re-reads every leaf and cost a reference level ~22 ms a frame while
  // its gondolas swung). What a partial pass must not do is disturb its neighbours: after one live prop moves,
  // a second live prop that stayed put and the static majority both still collide exactly where they were baked.
  const liveA = wall(true);
  liveA.key = 'authored:live-a'; liveA.object = { kind: 'authored', id: 'live-a' };
  const poseA = new THREE.Matrix4().makeTranslation(0, 1, 3);
  liveA.matrixWorld = poseA.clone(); liveA.liveMatrix = () => poseA;
  const liveB = wall(true);
  liveB.key = 'authored:live-b'; liveB.object = { kind: 'authored', id: 'live-b' };
  const poseB = new THREE.Matrix4().makeTranslation(0, 1, 5);
  liveB.matrixWorld = poseB.clone(); liveB.liveMatrix = () => poseB;
  const fence = wall(true);
  fence.key = 'authored:fence'; fence.object = { kind: 'authored', id: 'fence' };
  fence.matrixWorld = new THREE.Matrix4().makeTranslation(0, 1, 8);

  const hits: RideObstacleHit[] = [];
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [liveA, liveB, fence], oobFloorY: -100, keys, stick, drive: 0,
    onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
  model.st.vel.set(0, 0, 12);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  poseA.makeTranslation(0, 1, 40); // A swings clear; B and the fence never move
  for (let tick = 0; tick < 60 && hits.length === 0; tick++) model.step(1 / 60);
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'authored', id: 'live-b' }],
    'refitting the mover\'s branch leaves an unmoved live neighbour standing where it was baked');
  hits.length = 0;
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 6); // past B, in front of the static fence
  model.st.vel.set(0, 0, 12);
  for (let tick = 0; tick < 60 && hits.length === 0; tick++) model.step(1 / 60);
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'authored', id: 'fence' }],
    'the static majority also survives a neighbour\'s partial refit');
}
{
  // The pose-stamp fast path: a source that vouches for its pose with `poseVersion` is not recomposed until
  // the stamp moves — that poll over thousands of static-this-frame reference props was worth several ms a
  // frame. The stamp is the whole contract: liveMatrix answers are believed stale until a bump says otherwise,
  // and after the bump the mover collides at its new pose exactly as the polled path does.
  const hits: RideObstacleHit[] = [];
  const pose = new THREE.Matrix4().makeTranslation(0, 1, 40);
  let version = 0;
  const model = movingAt({ ...wall(true), matrixWorld: pose.clone(),
    liveMatrix: () => pose, poseVersion: () => version }, hits);
  pose.makeTranslation(0, 1, 3); // moved, but not vouched for
  model.step(1 / 60);
  assert.equal(hits.length, 0, 'an unbumped stamp keeps the collider at the pose the provider last vouched for');
  version++;
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
  model.st.vel.set(0, 0, 12);
  model.step(1 / 60);
  assert.equal(hits.length, 1, 'the bump is picked up and the mover collides at its live pose');
  assert.ok(model.st.vel.z < 0, 'with its authored bounce, exactly as the polled path resolves it');
}
{
  // Mode 3 keeps its leaves analytic, so a moved body has to re-place its broad-phase bound and normal basis
  // rather than re-transform triangles — the retracting-pillar case.
  const hits: RideObstacleHit[] = [];
  const pose = new THREE.Matrix4().compose(
    new THREE.Vector3(0, 1, 40), new THREE.Quaternion(), new THREE.Vector3(2, 1, 0.5));
  const body: RideObstacleSource = {
    key: 'reference:body', object: { kind: 'reference', index: 77 },
    spheres: new Float32Array([0, 0, 0, 1]), matrixWorld: pose.clone(), liveMatrix: () => pose,
    solid: true, bounce: 0.5, surface: -1,
  };
  const model = movingAt(body, hits);
  pose.setPosition(0, 1, 2.65);
  model.step(1 / 60);
  assert.ok(model.st.pos.z < 2.15 && model.st.vel.z < 0,
    'the sphere-tree body blocks at its moved boundary, not the baked one');
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'reference', index: 77 }]);
}

// Candidate ordering cannot simply stop at the first geometric root: a body sample may begin inside one leaf,
// making that leaf's first root an EXIT, then enter another leaf later in the same tick. The optimized pass must
// skip the outgoing normal and retain the later incoming boundary without smoothing every intersected leaf.
//
// The pair sits at TORSO height rather than at the deck because a native mode-3 contact is gated on the rider's
// body sphere reaching the body at all [Trailmap: 370-probe-modes] — a pair of 5 cm leaves down by the board is
// something the engine rides straight through, so a fixture there would be testing ordering inside a contact
// that never happens. The ordering scenario itself is unchanged: one sample starts inside the first leaf and
// enters the second within the same tick.
{
  const hits: RideObstacleHit[] = [];
  const torsoY = -groundRestDepth(SURFACE_ROWS[1]) + RIDER_TORSO_Y;
  const body: RideObstacleSource = {
    key: 'reference:overlap', object: { kind: 'reference', index: 78 },
    spheres: new Float32Array([
      0, torsoY, 2, 0.05,       // the torso sample starts inside and exits this leaf
      0, torsoY, 2.13, 0.04,    // then enters this leaf before the tick ends
    ]),
    matrixWorld: new THREE.Matrix4(), solid: true, bounce: 0, surface: -1,
  };
  const model = movingAt(body, hits);
  model.step(1 / 60);
  assert.ok(model.st.pos.z < 2.05,
    'an outgoing earliest leaf does not hide the next incoming sphere-tree boundary');
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'reference', index: 78 }]);
}

// The gate itself. Worth knowing how little it rejects now that the body sphere's radius is MEASURED rather
// than guessed: at 0.85 m about a centre at 0.92 it reaches from just above the deck to over the rider's head,
// so it covers nearly everything the sample body can touch. Deck-height pebbles are inside it, not outside.
// What the gate still rejects is a body genuinely clear of the rider — here, one passing well overhead.
{
  const hits: RideObstacleHit[] = [];
  const overhead = -groundRestDepth(SURFACE_ROWS[1]) + RIDER_BODY_Y + RIDER_BODY_R + 1.0;
  const model = movingAt({
    key: 'reference:overhead', object: { kind: 'reference', index: 79 },
    spheres: new Float32Array([0, overhead, 2, 0.05, 0, overhead, 2.13, 0.04]),
    matrixWorld: new THREE.Matrix4(), solid: true, bounce: 0, surface: -1,
  }, hits);
  model.step(1 / 60);
  assert.ok(model.st.pos.z > 2.15,
    'a physics body the rider’s body sphere cannot reach produces no contact at all');
  assert.equal(hits.length, 0, 'and dispatches nothing, because the gate precedes every limb test');
}

// The combined BVH must preserve per-triangle placement identity after its spatial reordering; otherwise a
// collision on one reference prop can play a neighbouring instance's sound.
{
  const far = wall(true);
  far.key = 'authored:far';
  far.object = { kind: 'authored', id: 'far' };
  far.matrixWorld = new THREE.Matrix4().makeTranslation(0, 1, 12);
  const near = wall(true);
  near.key = 'reference:42';
  near.object = { kind: 'reference', index: 42 };
  const hits: RideObstacleHit[] = [];
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [far, near], oobFloorY: -100, keys, stick,
    onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
  model.st.vel.set(0, 0, 12);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  model.step(1 / 60);
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'reference', index: 42 }],
    'the hit callback retains the collided reference instance identity');
}

// Every body sample sees its whole proposed tick before collide-and-slide selects the earliest blocker. A
// ride-through prop behind that blocker was never actually reached and must not emit a phantom sound.
{
  const blocker = wall(true);
  blocker.key = 'authored:blocker';
  blocker.object = { kind: 'authored', id: 'blocker' };
  const behind = wall(false);
  behind.key = 'authored:behind';
  behind.object = { kind: 'authored', id: 'behind' };
  behind.matrixWorld = new THREE.Matrix4().makeTranslation(0, 1, 3.25);
  const hits: RideObstacleHit[] = [];
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [blocker, behind], oobFloorY: -100, keys, stick,
    onRespawn: () => {}, onObstacleHit: hit => hits.push(hit),
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
  model.st.vel.set(0, 0, 24);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  model.step(1 / 60);
  assert.deepEqual(hits.map(hit => hit.object), [{ kind: 'authored', id: 'blocker' }],
    'contacts beyond the resolved blocking plane do not fire sounds or collision graphs');
}

// A solid carrying a native ride surface contributes its upward faces to the ordinary board contact probe.
{
  const top = wall(true, 12);
  top.geometry = new THREE.BoxGeometry(4, 1, 4);
  top.matrixWorld = new THREE.Matrix4();
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 0.7, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(-20),
    surfaceOf: () => 1, obstacles: [top], oobFloorY: -100, keys, stick, onRespawn: () => {},
  });
  model.start();
  assert.equal(model.st.surf, 12, 'spawn probing resolves the prop surface instead of the terrain below it');
  model.seatAtSpawn();
  assert.equal(model.st.grounded, true);
  assert.equal(model.st.surf, 12, 'the board seats on the prop with its wood/metal/etc ride-feel family');
  assert.ok(model.st.pos.y > 0.45, 'the seated board remains on the prop top');
}

// Walking can stand on an ordinary solid prop even when it has no native ride SurfaceType. A grounded remount
// admits only that supporting shell for the continuous contact, so W remains a grounded tuck and the cruise can
// carry the rider to the edge. The ordinary race/teleport seat stays strict, and leaving expires the exception.
{
  const tower = wall(true);
  tower.key = 'reference:media-tower';
  tower.object = { kind: 'reference', index: 437 };
  tower.geometry = new THREE.BoxGeometry(4, 1, 8);
  tower.matrixWorld = new THREE.Matrix4();
  const mountKeys = { left: false, right: false, tuck: true, brake: false, boost: false };
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 0.7, -3), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(-20),
    surfaceOf: () => 1, obstacles: [tower], oobFloorY: -100, keys: mountKeys, stick, onRespawn: () => {},
  });
  model.start();
  assert.equal(model.seatAtSpawn(), false,
    'an ordinary seat does not globally turn a surface=-1 prop into ground');
  assert.equal(model.seatAtMount(), true, 'a grounded in-place mount accepts the solid top directly beneath it');
  assert.equal(model.st.grounded, true);
  assert.equal(model.st.groundKey, tower.key);
  assert.equal(model.st.surf, -1, 'the temporary support retains the prop\'s generic feel instead of inventing snow');

  const startZ = model.st.pos.z;
  for (let tick = 0; tick < 15; tick++) model.step(1 / 60);
  assert.equal(model.st.grounded, true, 'the mount remains grounded while it is still over the tower top');
  assert.equal(model.st.flip, 0, 'W is a tuck on the temporary support, not an airborne forward flip');
  assert.ok(model.st.pos.z > startZ + 0.05, 'the ordinary ground cruise starts carrying the stationary mount forward');

  for (let tick = 0; tick < 240 && model.st.grounded; tick++) model.step(1 / 60);
  assert.equal(model.st.grounded, false, 'the rider can cruise off the tower edge');
  assert.ok(model.st.pos.z > 4, 'leaving the supporting top is not blocked by the prop shell');
  const edgeFlip = model.st.flip;
  model.step(1 / 60);
  assert.ok(model.st.flip > edgeFlip, 'after leaving, W immediately has its normal airborne flip meaning again');
}

// A native `movable` instance (a crash bag) resolves through the rigid-body impulse, not the bounce path
// [Trailmap: 370-world-interaction]. The rider ploughs through paying its own small share, and the body leaves
// with BOTH halves of the impulse: linear travel and the spin its authored inertia earned at the contact offset.
{
  // The real GARI crash-bag body: inertia diag (17569, 18104, 16997) authored at unit mass, so its inverse is
  // near-isotropic. Model-local raw cm, exactly as the level ships it.
  const CRASH_BAG_INV_INERTIA = new Float32Array([
    5.6920e-5, 0, 0,
    0, 5.5240e-5, 0,
    0, 0, 5.8834e-5,
  ]);
  const bag = (over: Partial<RideObstacleSource> = {}): RideObstacleSource => ({
    ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 }, dynamicMass: 5,
    body: { com: [0, 0, 0], invInertia: CRASH_BAG_INV_INERTIA }, ...over,
  });

  const hits: RideObstacleHit[] = [];
  const model = movingAt(bag(), hits);
  const approach = model.st.vel.z;
  for (let tick = 0; tick < 30; tick++) model.step(1 / 60);

  assert.equal(hits.length, 1, 'the shove still reports exactly one debounced contact for sounds and graphs');
  assert.ok(model.st.pos.z > 4, `the rider carries on through the bag (reached z=${model.st.pos.z.toFixed(2)})`);
  assert.ok(model.st.vel.z > approach * 0.85,
    `the rider keeps most of its speed (${model.st.vel.z.toFixed(2)} of ${approach.toFixed(2)})`);

  const shove = hits[0].shove;
  assert.ok(shove, 'a movable instance reports the shove it earned');
  assert.ok(shove!.linear.z > 0 === approach > 0,
    'the body is thrown along the travel that struck it, not back into it');
  assert.ok(shove!.body, 'the body carries its authored mass properties through to the moved-body sim');
  // The spec is explicit: no vertical bias in the impulse direction. Loft is the ground contact's job.
  assert.ok(Math.abs(shove!.linear.y) < 1e-9,
    `the impulse carries no vertical bias (got ${shove!.linear.y})`);
}

// The impulse uses the closed form in [Trailmap: 370-world-interaction]:
// 1.3 * closing / (1/dynamicMass + riderTerm + rotational), applied at the contact offset so the body picks up
// angular velocity too. The prop inverse mass is 1/U0 under the specified knockable-prop convention.
{
  const RESTITUTION = 1.3, PROP_INVERSE_MASS = 1 / 5, RIDER_MASS_TERM = 0.01;
  const inv = 5.6920e-5;
  // Strike 0.9 m below the centre of mass, so there is a real lever and a real rotational term.
  const invInertia = new Float32Array([inv, 0, 0, 0, inv, 0, 0, 0, inv]);
  const hits: RideObstacleHit[] = [];
  const model = movingAt({
    ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 }, dynamicMass: 5,
    body: { com: [0, 0.9, 0], invInertia },
  }, hits);
  model.step(1 / 60);
  const shove = hits[0].shove!;
  assert.ok(shove.body, 'the world tensor reaches the hit');

  // Rebuild the solve independently from the reported contact.
  const n = hits[0].normal.clone();
  const r = hits[0].point.clone().sub(shove.body!.com);
  const rxn = r.clone().cross(n);
  const worldInv = shove.body!.invInertia;
  const iirxn = new THREE.Vector3(
    worldInv[0] * rxn.x + worldInv[1] * rxn.y + worldInv[2] * rxn.z,
    worldInv[3] * rxn.x + worldInv[4] * rxn.y + worldInv[5] * rxn.z,
    worldInv[6] * rxn.x + worldInv[7] * rxn.y + worldInv[8] * rxn.z,
  );
  const rotational = iirxn.cross(r).dot(n);
  assert.ok(rotational > 0, `an off-centre strike has a real rotational term (${rotational})`);
  const expected = RESTITUTION * hits[0].impactSpeed / (PROP_INVERSE_MASS + RIDER_MASS_TERM + rotational);
  assert.ok(Math.abs(shove.linear.length() - expected * PROP_INVERSE_MASS) < 1e-6,
    `linear half matches the traced impulse (${shove.linear.length()} vs ${expected * PROP_INVERSE_MASS})`);
  assert.ok(shove.angular.length() > 1e-3,
    `the contact offset gives the body real spin (${shove.angular.length()} rad/s)`);

  // A dead-centre strike has no lever, so it is pure translation - the lever is what makes a bag tumble.
  const centred: RideObstacleHit[] = [];
  const centredModel = movingAt({
    ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 }, dynamicMass: 5,
    body: { com: [0, 0, 3], invInertia },
  }, centred);
  centredModel.step(1 / 60);
  assert.ok(centred[0].shove!.angular.length() < shove.angular.length(),
    'a strike through the centre of mass spins the body less than an off-centre one');
}

// The authored tensor is what separates one body from another on this path: a thin path marker (inertia 122
// about its flag axis vs 1960 across) spins far more readily than a chunky near-isotropic crash bag.
{
  const launch = (invInertia: Float32Array) => {
    const hits: RideObstacleHit[] = [];
    const model = movingAt({
      ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 }, dynamicMass: 5,
      body: { com: [0, 0.9, 0], invInertia },
    }, hits);
    model.step(1 / 60);
    return hits[0].shove!;
  };
  const bag = launch(new Float32Array([5.6920e-5, 0, 0, 0, 5.5240e-5, 0, 0, 0, 5.8834e-5]));
  const marker = launch(new Float32Array([5.1033e-4, 0, 0, 0, 5.1033e-4, 0, 0, 0, 8.1744e-3]));
  assert.ok(marker.angular.length() > bag.angular.length(),
    `the low-inertia marker spins away harder (${marker.angular.length()} vs ${bag.angular.length()})`);
  assert.ok(marker.linear.length() < bag.linear.length(),
    'and pays for that spin with less travel, out of the one shared impulse');
}

// A mode-3 body is an occupancy LATTICE, not a smooth shell: the shipped bodies sit at leaf radius 24.2 cm on a
// 34.2 cm pitch, so the union is bumpy at leaf scale and a single leaf's radial normal is a poor read of the face
// the body presents. A live capture caught one 83 deg off the body's own radial, which turned the shove impulse
// nearly tangential and drove a struck crash bag DOWN into the snow instead of away from the rider.
//
// This runs against the REAL shipped body, because a hand-built lattice is not bumpy enough to reproduce the
// fault - an earlier synthetic shell passed identically with the smoothing disabled, guarding nothing. Skipped
// when the extracted maps are not present.
{
  const leaves = await readPhysicsBodySpheres('GARI', 7);
  const mass = await readPhysicsBodyMassProps('GARI', 7);
  if (!leaves?.length || !mass) {
    console.log('  (skipped: extracted GARI maps not available for the sphere-tree normal check)');
  } else {
    const packed = new Float32Array(leaves.flat());
    const com = new THREE.Vector3(...mass.com);
    const measure = (band?: number) => {
      const angles: number[] = [];
      for (let hx = -150; hx <= 150; hx += 30) for (let hy = -150; hy <= 150; hy += 30) {
        // A rider-like segment sweeping in from -Z; take the first leaf it enters, as the barrier cast does.
        const origin = new THREE.Vector3(com.x + hx, com.y + hy, com.z - 400);
        const dir = new THREE.Vector3(0, -20, 800);
        let best: { u: number; index: number; point: THREE.Vector3 } | null = null;
        for (let i = 0; i + 3 < packed.length; i += 4) {
          const r = packed[i + 3];
          const mx = origin.x - packed[i], my = origin.y - packed[i + 1], mz = origin.z - packed[i + 2];
          const a = dir.lengthSq();
          const b = 2 * (mx * dir.x + my * dir.y + mz * dir.z);
          const c = mx * mx + my * my + mz * mz - r * r;
          const disc = b * b - 4 * a * c;
          if (disc < 0) continue;
          const enter = (-b - Math.sqrt(disc)) / (2 * a);
          if (enter < 1e-6 || enter > 1) continue;
          if (!best || enter < best.u) best = { u: enter, index: i, point: dir.clone().multiplyScalar(enter).add(origin) };
        }
        if (!best) continue;
        const normal = new THREE.Vector3();
        if (band === undefined) unionLeafNormal(packed, best.point, best.index, normal);
        else unionLeafNormal(packed, best.point, best.index, normal, band);
        normal.normalize();
        const radial = best.point.clone().sub(com).normalize();
        angles.push(Math.acos(Math.min(1, Math.abs(normal.dot(radial)))) * 180 / Math.PI);
      }
      return angles;
    };
    // Band 0 collapses the sum to the single hit leaf - the previous behaviour.
    const single = measure(1e-9), smoothed = measure(3);
    assert.ok(single.length >= 40, `enough real contacts to be meaningful (got ${single.length})`);
    assert.equal(smoothed.length, single.length, 'both reads see the same contacts');
    const mean = (a: number[]) => a.reduce((sum, x) => sum + x, 0) / a.length;
    const beyond45 = (a: number[]) => a.filter(x => x > 45).length;
    // The load-bearing claim: leaf-scale bumps produce near-tangential normals, and smoothing removes them.
    assert.ok(beyond45(single) > single.length * 0.2,
      `one leaf really does report near-tangential faces (${beyond45(single)}/${single.length})`);
    assert.ok(beyond45(smoothed) * 4 < beyond45(single),
      `smoothing clears most of them (${beyond45(smoothed)} vs ${beyond45(single)})`);
    assert.ok(mean(smoothed) < mean(single) - 8,
      `and pulls the whole distribution onto the face (${mean(smoothed).toFixed(1)} vs ${mean(single).toFixed(1)} deg)`);

    // The above compares two bands explicitly, which proves the smoothing works but would still pass if the
    // shipped default were turned off. Guard the default the barrier cast actually runs with.
    const shipped = measure(undefined);
    assert.ok(beyond45(shipped) * 4 < beyond45(single),
      `the SHIPPED band keeps near-tangential faces out of the barrier cast ` +
      `(${beyond45(shipped)}/${shipped.length}, vs ${beyond45(single)} unsmoothed)`);
  }
}

// A shoveable body is transparent to the CAMERA for the same reason foliage is: the rider passes clean through
// it, so the view must too. This matters doubly because the collision set is a launch-time snapshot — a struck
// bag leaves a ghost collider at its original spot, and a live capture caught the chase camera fighting that
// ghost for ~25 frames per hit with corrections up to 3.5 m while the visible bag tumbled elsewhere.
{
  const cast = (obstacle: RideObstacleSource) => {
    const model = createRideModel({
      spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
      surfaceOf: () => 1, obstacles: [obstacle], oobFloorY: -100, keys, stick, onRespawn: () => {},
    });
    model.start();
    // A camera-to-rider segment passing straight through the prop at torso height.
    return model.castCameraObstacle(new THREE.Vector3(0, 1, 6), new THREE.Vector3(0, 1, 0));
  };

  assert.ok(cast(wall(true)), 'an immovable solid still blocks the chase camera');
  assert.equal(cast({ ...wall(true), dynamicMass: 5 }), null,
    'a movable mesh prop is transparent to the camera, exactly as it is to the rider');
  const sphereBody = (dynamicMass?: number): RideObstacleSource => ({
    key: 'reference:9', object: { kind: 'reference', index: 9 },
    spheres: new Float32Array([0, 0, 0, 1.2]),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, 1, 3),
    solid: true, bounce: 0.5, surface: -1, ...(dynamicMass ? { dynamicMass } : {}),
  });
  assert.ok(cast(sphereBody()), 'an immovable sphere-tree body still blocks the chase camera');
  assert.equal(cast(sphereBody(5)), null,
    'a movable sphere-tree body (a crash bag) never shoves the camera, ghost collider included');
}

// The shove reports itself in ride telemetry, so a bag that fails to fly can be diagnosed from a capture rather
// than by guesswork. `hasBody` is the load-bearing field: false means the instance reached Play with no authored
// mass properties, which is the difference between a solved tumble and a translation-only launch.
{
  const invInertia = new Float32Array([5.6920e-5, 0, 0, 0, 5.5240e-5, 0, 0, 0, 5.8834e-5]);
  const capture = (body?: { com: [number, number, number]; invInertia: Float32Array }) => {
    const ticks: RideTelemetryTick[] = [];
    const model = createRideModel({
      spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
      surfaceOf: () => 1, oobFloorY: -100, keys, stick, onRespawn: () => {},
      onTelemetryTick: tick => ticks.push(tick),
      obstacles: [{
        ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 }, dynamicMass: 5,
        ...(body ? { body } : {}),
      }],
    });
    model.start();
    model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 2);
    model.st.vel.set(0, 0, 12);
    model.st.fwd.set(0, 0, 1);
    model.st.contactN.set(0, 1, 0);
    model.st.boardUp.set(0, 1, 0);
    model.st.grounded = true;
    model.step(1 / 60);
    return ticks.flatMap(tick => tick.events).filter(event => event.type === 'prop-shove');
  };

  const solved = capture({ com: [0, 0.9, 0], invInertia });
  assert.equal(solved.length, 1, 'one shove reports one telemetry event');
  const event = solved[0] as Extract<RideTelemetryEvent, { type: 'prop-shove' }>;
  assert.equal(event.key, 'reference:9');
  assert.equal(event.hasBody, true, 'a body with mass properties reports them present');
  assert.ok(event.rotational > 0, 'the rotational term is reported and non-zero off-centre');
  assert.ok(Math.abs(event.denominator - (1 / 5 + 0.01 + event.rotational)) < 1e-9,
    'the denominator is the traced sum of its three terms (1/dynamicMass + riderTerm + rotational)');
  assert.ok(Math.abs(event.impulse - 1.3 * event.closingSpeed / event.denominator) < 1e-9,
    'the reported impulse is the traced 1.3 * closing / denominator');
  assert.ok(event.propAngular.some(v => Math.abs(v) > 1e-3), 'the launch spin is reported');
  assert.notDeepEqual(event.riderVelocityBefore, event.riderVelocityAfter, 'the rider pays, and it is recorded');

  const unsolved = capture();
  assert.equal(unsolved.length, 1, 'a body without mass properties still reports its shove');
  const missing = unsolved[0] as Extract<RideTelemetryEvent, { type: 'prop-shove' }>;
  assert.equal(missing.hasBody, false, 'and flags itself as having reached Play without them');
  assert.equal(missing.rotational, 0, 'with no tensor there is no rotational term to divide the impulse');
  assert.ok(missing.propAngular.every(v => v === 0), 'and no spin at all - a translation-only launch');
  assert.ok(missing.impulse > event.impulse,
    'which also makes it leave FASTER, since none of the impulse is spent on spin');
}

// The same instance without a dynamic mass is the immovable solid it has always been — the shove must not leak
// into ordinary props, which is what made every crash bag in the level ride like a wall.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt({ ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 } }, hits);
  model.step(1 / 60);
  assert.equal(hits[0].shove, null, 'an immovable solid reports no shove');
  assert.ok(model.st.pos.z < 2.15 && model.st.vel.z < 0, 'an immovable solid still stops and kicks the rider back');
}

// A graze is not a shove: below the impact floor the bag stays standing rather than drifting off a brush past it.
{
  const hits: RideObstacleHit[] = [];
  const model = movingAt({
    ...wall(true), key: 'reference:9', object: { kind: 'reference', index: 9 }, dynamicMass: 5,
  }, hits, 0);
  model.st.vel.set(0, 0, 0.2);
  // 0.2 m/s needs five seconds to close the gap the 12 m/s fixtures cross in one tick; at 90 the board never
  // arrived and the shove floor below went untested.
  for (let tick = 0; tick < 300; tick++) model.step(1 / 60);
  assert.ok(hits.length > 0, 'the brush has to actually reach the bag, or the shove floor is untested');
  assert.ok(hits.every(hit => hit.shove === null), 'a sub-threshold brush leaves the bag where it stands');
}

// A rounded solid (a roller) presents DOWNWARD-facing faces to the low board samples, which sit only 14 cm up.
// The barrier resolver's roof clause used to read one of those as a tunnel ceiling and force the air state; with
// terrain contact suppressed — and the terrain barrier sweep deferring every up-facing face to that same probe —
// nothing was left holding the deck up and the rider sank through the mountain until the OOB floor caught it.
{
  const radius = 0.6;
  const roller: RideObstacleSource = {
    key: 'authored:roller', object: { kind: 'authored', id: 'roller' },
    geometry: new THREE.SphereGeometry(radius, 24, 16),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, radius, 8),
    solid: true, bounce: 0.5, surface: -1,
  };
  for (const speed of [8, 12, 20, 30]) {
    for (const bounce of [0, 0.5]) {
      let respawned: boolean;
      const model = createRideModel({
        spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
        surfaceOf: () => 1, obstacles: [{ ...roller, bounce }], oobFloorY: -100, keys, stick,
        onRespawn: () => { respawned = true; }, onObstacleHit: () => {},
      });
      model.start();
      model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 0);
      model.st.vel.set(0, 0, speed);
      model.st.fwd.set(0, 0, 1);
      model.st.contactN.set(0, 1, 0);
      model.st.boardUp.set(0, 1, 0);
      model.st.grounded = true;
      respawned = false; // the spawn seat itself is not the fall this guards against
      let lowest = model.st.pos.y;
      for (let tick = 0; tick < 240; tick++) {
        model.step(1 / 60);
        lowest = Math.min(lowest, model.st.pos.y);
      }
      const at = `hitting a roller at ${speed} m/s with bounce ${bounce}`;
      // `lowest` is the whole of what this fixture guards, and it is exact. A respawn is NOT a proxy for it:
      // this rider's heading is pinned dead at the sphere with no steering, so it eventually stops making
      // progress and the wedge integrator puts it back on the course — the engine's own answer to being stuck
      // ([Trailmap: 395-reset-arm]), and a different event from sinking through the mountain. That mechanism
      // has fixtures of its own at the end of this file.
      assert.ok(lowest > -1, `${at} never drops the rider through the floor (reached y=${lowest.toFixed(2)})`);
      assert.ok(!model.st.forcedAir, `${at} leaves no latched forcedAir behind it`);
      void respawned;
    }
  }
}

// The roof clause still belongs to surfaces the contact probe READS: a rideable solid overhead is a real ceiling,
// and forcing air there is what stops the next down-probe seating the board on its far side.
{
  const roof: RideObstacleSource = {
    key: 'authored:roof', object: { kind: 'authored', id: 'roof' },
    geometry: new THREE.BoxGeometry(8, 0.4, 8),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, 2.9, 0), // underside at 2.7, clear of the 1.72 head sample
    solid: true, bounce: 0, surface: 12,
  };
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles: [roof], oobFloorY: -100, keys, stick, onRespawn: () => {},
  });
  model.start();
  model.st.pos.set(0, 0.1, 0);
  model.st.vel.set(0, 12, 0); // driven straight up into the underside
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = false;
  let latchedAir = false, highest = model.st.pos.y;
  for (let tick = 0; tick < 12; tick++) {
    model.step(1 / 60);
    latchedAir ||= model.st.forcedAir;
    highest = Math.max(highest, model.st.pos.y);
  }
  assert.ok(highest + 1.72 < 2.7, `the head never crosses a rideable ceiling (reached ${(highest + 1.72).toFixed(2)})`);
  assert.ok(model.st.vel.y <= 0, 'a rideable ceiling still kills the upward velocity that hit it');
  assert.ok(latchedAir, 'a rideable ceiling still forces air so the probe cannot seat on its far side');
}

// A rideable prop is a SOLID, and a board riding onto one buries its 0.78 m nose sample the moment the surface
// steepens under it. That sample then leaves through the face it is under, and the barrier sweep used to face
// that normal against travel and read the resulting downward vector as a ceiling: the prop's own restitution
// fired straight down and forcedAir latched on the face the deck was standing on, with no way back — the clear
// is upward-only. A MEGAPLE BumperBase (a 3 m thick slab, surface 13, bounce 0.5) dropped the rider out of the
// world on a bump they should have skipped over.
{
  // A closed prism: a 25° ramp out of the terrain plane, flattening off at the top, on a 3 m thick base.
  const RAMP_END = 4, TOP_Y = RAMP_END * Math.tan(25 * Math.PI / 180), BASE_Y = -3, X = 6, BACK = 10;
  const points: number[] = [];
  // Each quad is given in the order that makes `(b-a)×(c-a)` point OUT of the solid; asserted below rather than
  // trusted, so a mis-wound face fails the test instead of quietly testing the wrong crossing.
  const quad = (a: number[], b: number[], c: number[], d: number[]) => points.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad([-X, 0, 0], [-X, TOP_Y, RAMP_END], [X, TOP_Y, RAMP_END], [X, 0, 0]);                  // ramp
  quad([-X, TOP_Y, RAMP_END], [-X, TOP_Y, BACK], [X, TOP_Y, BACK], [X, TOP_Y, RAMP_END]);    // flat top
  quad([-X, BASE_Y, 0], [X, BASE_Y, 0], [X, BASE_Y, BACK], [-X, BASE_Y, BACK]);              // underside
  quad([-X, BASE_Y, 0], [-X, 0, 0], [X, 0, 0], [X, BASE_Y, 0]);                              // front (−z)
  quad([-X, BASE_Y, BACK], [X, BASE_Y, BACK], [X, TOP_Y, BACK], [-X, TOP_Y, BACK]);          // back (+z)
  quad([-X, BASE_Y, 0], [-X, BASE_Y, BACK], [-X, TOP_Y, BACK], [-X, 0, 0]);                  // left (−x)
  quad([X, BASE_Y, 0], [X, 0, 0], [X, TOP_Y, BACK], [X, BASE_Y, BACK]);                      // right (+x)

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  const inside = new THREE.Vector3(0, (TOP_Y + BASE_Y) / 2, BACK / 2);
  for (let i = 0; i < points.length; i += 9) {
    const a = new THREE.Vector3(...points.slice(i, i + 3));
    const b = new THREE.Vector3(...points.slice(i + 3, i + 6));
    const c = new THREE.Vector3(...points.slice(i + 6, i + 9));
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const outward = a.clone().add(b).add(c).divideScalar(3).sub(inside);
    assert.ok(normal.dot(outward) > 0, `prism face ${i / 9} is wound outward`);
  }

  const bumper: RideObstacleSource = {
    key: 'reference:293', object: { kind: 'reference', index: 293 },
    geometry, matrixWorld: new THREE.Matrix4(), solid: true, bounce: 0.5, surface: 13,
  };
  for (const speed of [12, 20, 28]) {
    let respawned: boolean;
    const ticks: RideTelemetryTick[] = [];
    const model = createRideModel({
      spawn: new THREE.Vector3(0, 1, -6), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
      surfaceOf: () => 1, obstacles: [bumper], oobFloorY: -100, keys, stick,
      onRespawn: () => { respawned = true; }, onTelemetryTick: tick => ticks.push(tick),
    });
    model.start();
    model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), -6);
    model.st.vel.set(0, 0, speed);
    model.st.fwd.set(0, 0, 1);
    model.st.contactN.set(0, 1, 0);
    model.st.boardUp.set(0, 1, 0);
    model.st.grounded = true;
    respawned = false; // the spawn seat itself is not the fall this guards against
    let lowest = model.st.pos.y, highest = model.st.pos.y;
    for (let tick = 0; tick < 90; tick++) {
      model.step(1 / 60);
      lowest = Math.min(lowest, model.st.pos.y);
      highest = Math.max(highest, model.st.pos.y);
    }
    const at = `riding a rideable ramp prop at ${speed} m/s`;
    assert.ok(!respawned, `${at} never falls out of the world`);
    assert.ok(lowest > BASE_Y, `${at} never sinks into the slab (reached y=${lowest.toFixed(2)})`);
    assert.ok(highest > TOP_Y * 0.8, `${at} rides up the ramp (reached y=${highest.toFixed(2)})`);
    assert.ok(!model.st.forcedAir, `${at} leaves no latched forcedAir behind it`);
    const roofed = ticks.flatMap(tick => tick.events)
      .filter((event): event is Extract<RideTelemetryEvent, { type: 'barrier-resolved' }> =>
        event.type === 'barrier-resolved' && event.normal[1] < -0.35);
    assert.equal(roofed.length, 0, `${at} reads no ceiling in the surface it is riding on`);
  }
}

// Slopesmith's orange export preview uses the same occupancy expansion and compact-body tilt decision as
// CollisionBundle. An early leaf is one native sphere but fills its complete max-depth cell cube.
const filled = decodePhysicsBodyTree([10, 20, 30], [
  { U0: 100, U1: 0, U2: 1 }, { U0: 50, U1: 25, U2: 8 }, { U0: 25, U1: 12.5, U2: 64 },
], [0]);
assert.equal(filled?.spheres.length, 4, 'an early occupancy leaf remains one native runtime sphere');
assert.equal(filled?.cells.size, 64, 'an early occupancy leaf expands over its complete max-depth lattice cube');

const gridN = 8;
const trunk: DecodedPhysicsBody = {
  root: [0, 0, 0], gridN, leafRadius: 30,
  axisPos: [-350, -250, -150, -50, 50, 150, 250, 350],
  cells: new Set(Array.from({ length: gridN }, (_, z) => (3 * gridN + 3) * gridN + z)),
  spheres: [],
};
const trunkRecipe = buildUnityBodyRecipe(trunk);
assert.equal(trunkRecipe.tilt.capsules.length, 1,
  'a clean elongated body run produces the one capsule Unity can rotate with the instance');
const sin = Math.sin(Math.PI / 8), cos = Math.cos(Math.PI / 8);
assert.equal(unityBodyRecipeKind(trunkRecipe, [sin, 0, 0, cos], [1, 1, 1]), 'tilt',
  'a 45-degree placement whose world AABB is inflated selects the body-local Unity collider');
const scaledTrunk = scaleBodyShape(trunkRecipe.tilt, [2, 1, 0.5]);
assert.equal(scaledTrunk.capsules[0].radius, trunkRecipe.tilt.capsules[0].radius * 2,
  'non-uniform export scaling uses the conservative largest axis for a capsule radius');

const twoBlobs = new Set<number>();
for (const base of [0, 6]) for (let x = base; x < base + 2; x++)
  for (let y = base; y < base + 2; y++) for (let z = base; z < base + 2; z++)
    twoBlobs.add((x * gridN + y) * gridN + z);
const sparseRecipe = buildUnityBodyRecipe({ ...trunk, cells: twoBlobs });
assert.equal(sparseRecipe.body.boxes.length, 2,
  'disconnected compact leftovers become two fully occupied Unity boxes without filling the gap');

/**
 * The WEDGE INTEGRATOR ([Trailmap: 395-reset-arm]). The engine has no stuck timer and no no-progress test —
 * being lost or slow never resets anybody. What it has instead is this: contact with an OBJECT, accumulated
 * over consecutive frames, decayed otherwise. Both halves matter, and the second is the one that can quietly
 * ruin a course: a rider RIDING a prop is in contact with it every single frame, so a detector that counted
 * that would warp the whole field off every rideable surface on the mountain.
 */
{
  // The cruise drive stays on: what makes a rider WEDGED rather than merely stopped is that it keeps being
  // driven into the thing it cannot get past, which is exactly the state the integrator is counting.
  const run = (obstacle: RideObstacleSource, seat: (model: ReturnType<typeof createRideModel>) => void) => {
    let respawns = 0;
    const model = createRideModel({
      spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
      surfaceOf: () => 1, obstacles: [obstacle], oobFloorY: -100, keys, stick,
      onRespawn: () => { respawns++; }, onObstacleHit: () => {},
    });
    model.start();
    seat(model);
    respawns = 0; // the spawn seat itself is not a reset
    for (let tick = 0; tick < 180; tick++) model.step(1 / 60);
    return { respawns, model };
  };

  // Driven square into an immovable wall and held there: five or so consecutive contact frames and it goes.
  const wall: RideObstacleSource = {
    key: 'authored:slab', object: { kind: 'authored', id: 'slab' },
    geometry: new THREE.BoxGeometry(20, 6, 1),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, 3, 3),
    solid: true, bounce: 0, surface: -1,
  };
  const jammed = run(wall, model => {
    model.st.pos.set(0, -groundRestDepth(SURFACE_ROWS[1]), 0);
    model.st.vel.set(0, 0, 12);
    model.st.fwd.set(0, 0, 1);
    model.st.contactN.set(0, 1, 0);
    model.st.boardUp.set(0, 1, 0);
    model.st.grounded = true;
  });
  assert.ok(jammed.respawns > 0, 'a rider driven into a wall and held there is put back on the course');

  // The other half: a wide rideable SLAB under the board, contacted every frame for three seconds. Its normal
  // is the board's own up, so every frame feeds zero and the rider is left alone.
  const deck: RideObstacleSource = {
    key: 'authored:deck', object: { kind: 'authored', id: 'deck' },
    geometry: new THREE.BoxGeometry(20, 1, 40),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, 0.5, 0),
    solid: true, bounce: 0, surface: 12,
  };
  const riding = run(deck, model => {
    model.st.pos.set(0, 1 - groundRestDepth(SURFACE_ROWS[12]), -15);
    model.st.vel.set(0, 0, 6);
    model.st.fwd.set(0, 0, 1);
    model.st.contactN.set(0, 1, 0);
    model.st.boardUp.set(0, 1, 0);
    model.st.grounded = true;
  });
  assert.equal(riding.respawns, 0, 'riding along a rideable prop is contact, not wedging — nothing resets');
}

// STARTING a ride is expensive and RE-SEATING one is not, and the gap between them is why a headset session
// keeps one board for its whole life instead of building a new one every time the rider steps back on
// (`TestRide.park` / `seatAt`, docs/016). Nearly all of the cost is here, in prop collision: the obstacle
// triangles are de-indexed into world space and a BVH is built over them. A rider who takes the deck off their
// feet mid-jump and puts it straight back would otherwise pay that twice inside one second, in a headset, in
// mid-air — which is exactly where a frame budget cannot absorb it.
//
// Asserted as a RATIO measured in the same process, so it holds under a loaded parallel run.
{
  const geometry = new THREE.SphereGeometry(1, 16, 16);
  const obstacles: RideObstacleSource[] = Array.from({ length: 300 }, (_, i) => ({
    key: `authored:bench${i}`, object: { kind: 'authored', id: `bench${i}` },
    geometry,
    matrixWorld: new THREE.Matrix4().makeTranslation((i % 20) * 3 - 30, 1, Math.floor(i / 20) * 3 - 20),
    solid: true, bounce: 0, surface: -1,
  }));
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floorAt(),
    surfaceOf: () => 1, obstacles, oobFloorY: -100, keys, stick, onRespawn: () => {},
  });
  const beforeStart = performance.now();
  model.start();
  const startMs = performance.now() - beforeStart;

  const seats: number[] = [];
  for (let i = 0; i < 15; i++) {
    const before = performance.now();
    model.warpTo(new THREE.Vector3(i % 5, 1, 4), new THREE.Vector3(0, 0, 1), 0);
    model.seatAtSpawn();
    seats.push(performance.now() - before);
  }
  seats.sort((a, b) => a - b);
  const seatMs = seats[seats.length >> 1];
  assert.ok(startMs > 5, `building a board over ${obstacles.length} props is real work (${startMs.toFixed(1)} ms)`);
  assert.ok(seatMs * 10 < startMs,
    `re-seating one is at least ten times cheaper (${seatMs.toFixed(3)} ms vs ${startMs.toFixed(1)} ms)`);
  assert.ok(seatMs < 5, `and is a frame-budget operation outright (${seatMs.toFixed(3)} ms)`);
  assert.equal(model.st.vel.length(), 0, 'a re-seated board starts at rest, wherever it was warped from');

  // Flat Play can recall the board while the walker is already in a jump. A nearby surface makes warpTo prepare
  // a grounded seat first; the airborne handoff must put the board back at the rider's exact point and velocity
  // instead of dropping them to that surface (or routing them through the course-reset position).
  const airborneAt = new THREE.Vector3(7, 0.5, 9);
  const airborneCarry = new THREE.Vector3(2, 4, 11);
  model.warpTo(airborneAt, new THREE.Vector3(0, 0, -1), 0);
  model.mountAirborne(airborneCarry, airborneAt);
  assert.ok(model.st.pos.distanceTo(airborneAt) < 1e-9,
    'an airborne in-place mount stays at the walker rather than snapping to nearby ground');
  assert.ok(model.st.vel.distanceTo(airborneCarry) < 1e-9 && !model.st.grounded,
    'and resumes the walker\'s carried arc from that exact point');
}

console.log('PROP COLLISION TESTS PASSED');
