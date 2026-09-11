// tier: fast

// VR play (docs/016), checked without a headset. Three things are worth pinning here and none of them need one:
// the CONTROL MAP (which button means what is the parity claim), the on-foot WALKER (a character controller with
// no spec behind it, so its edges are only as good as its tests), and HEAD STEER in the ride model — the one
// change VR makes to physics that every desktop ride also runs through.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { heldDeckRotation } from '../src/app/ride/board-grab';
import { createGrindRails } from '../src/app/ride/grind';
import { createRideModel, groundRestDepth, SURFACE_ROWS } from '../src/app/ride/physics';
import { RAIL_TUBE_RADIUS } from '../src/core/rails/rail-mesh';
import {
  controllerFingerCurls, footControls, grabControls, normalizeAxis, precisionRideAxis, readPads, rideControls, shapeAxis,
  smoothTurnRadians,
  viewToggleHeld, wristMenuToggleHeld, type XrHand,
} from '../src/app/ride/xr/input';
import {
  canonicalXrHandRotation, createBoardActionGuide, createVirtualController, headsetBodyFacing,
  preferredBoardActionHand, rebaseXrPresentationMatrix,
  trackedRoomDelta, trackedRoomMoveReady, viewerYaw,
  xrViewOffset, XR_NEAR_CLIP, XR_THIRD_PERSON_DISTANCE, XR_THIRD_PERSON_HEIGHT,
} from '../src/app/ride/xr/session';
import {
  XR_BOARD_CONTROL_NOTES, xrControllerDiagramLabels, xrHudActionAt, xrMiniControllerLayout,
} from '../src/app/ride/xr/hud';
import { xrLayerKind } from '../src/app/ride/xr/config';
import {
  createWalker, downwardGroundQuery, PLAYER_AIR_RESISTANCE, PLAYER_JUMP_IMPULSE, PLAYER_RUN_SPEED, PLAYER_STRAFE_SPEED,
  SUPERMAN_CRUISE_SPEED_SCALE, SUPERMAN_MAX_HORIZONTAL_SPEED, type WalkGround,
} from '../src/app/ride/xr/walk';

const SNOW = SURFACE_ROWS[1];

assert.equal(xrHudActionAt(false, new THREE.Vector2(134 / 512, 1 - 134 / 486)), 'calibrate',
  'the compact wrist panel exposes its T-pose action');
assert.equal(xrHudActionAt(false, new THREE.Vector2(378 / 512, 1 - 134 / 486)), 'calibrate',
  'T-pose spans the row vacated by the retired wrist flight button');
assert.equal(xrHudActionAt(false, new THREE.Vector2(134 / 512, 1 - 198 / 486)), 'restart',
  'the compact wrist panel exposes a full gate restart');
assert.equal(xrHudActionAt(false, new THREE.Vector2(378 / 512, 1 - 198 / 486)), 'exit',
  'the compact wrist panel exposes session exit');
assert.equal(xrHudActionAt(false, new THREE.Vector2(134 / 512, 1 - 262 / 486)), 'stats',
  'the compact wrist panel exposes a live performance-stats toggle');
assert.equal(xrHudActionAt(false, new THREE.Vector2(378 / 512, 1 - 262 / 486)), 'view',
  'the compact wrist panel exposes first/third-person view');
assert.equal(xrHudActionAt(false, new THREE.Vector2(256 / 512, 1 - 326 / 486)), 'controls',
  'the compact wrist panel exposes its controller help page');
assert.equal(xrHudActionAt(false, new THREE.Vector2(256 / 512, 1 - 446 / 486), true), 'controls',
  'the controller help page turns the same action into a full-width back button');
assert.equal(xrHudActionAt(false, new THREE.Vector2(134 / 512, 1 - 134 / 486), true), null,
  'main-menu actions cannot fire through the open controller help page');
assert.equal(xrHudActionAt(false, new THREE.Vector2(0.5, 0.5)), null,
  'the gap between watch actions cannot select either neighbor');
assert.equal(xrHudActionAt(true, new THREE.Vector2(0.8, 0.5)), null,
  'the forward profiler remains non-interactive');
assert(XR_NEAR_CLIP <= 0.03, 'the XR near plane should retain hands brought within 3 cm of the viewpoint');
assert.deepEqual(xrViewOffset(false).toArray(), [0, 0, 0], 'first-person XR leaves the viewer at the body');
assert.equal(XR_THIRD_PERSON_DISTANCE, 2, 'the XR third-person camera sits two metres behind the avatar');
assert.deepEqual(xrViewOffset(true).toArray(), [0, XR_THIRD_PERSON_HEIGHT, XR_THIRD_PERSON_DISTANCE],
  'third-person XR moves only the eye parent behind and above the local avatar');

// Controllers and wrist UI share the displaced presentation root with the camera, but the pose handed to the
// avatar must remove that boom. This is the separation that keeps the preview at the real hand without pulling
// the model's arms three metres behind its body.
{
  const bodyWorld = new THREE.Matrix4().makeTranslation(10, 20, 30);
  const viewLocal = new THREE.Matrix4().makeTranslation(0, XR_THIRD_PERSON_HEIGHT, XR_THIRD_PERSON_DISTANCE);
  const presentationWorld = new THREE.Matrix4().multiplyMatrices(bodyWorld, viewLocal);
  const handLocal = new THREE.Matrix4().compose(
    new THREE.Vector3(0.35, 1.25, -0.45),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3),
    new THREE.Vector3(1, 1, 1),
  );
  const presentedHand = new THREE.Matrix4().multiplyMatrices(presentationWorld, handLocal);
  const avatarHand = rebaseXrPresentationMatrix(presentedHand, presentationWorld, bodyWorld);
  const expectedAvatarHand = new THREE.Matrix4().multiplyMatrices(bodyWorld, handLocal);
  assert.ok(avatarHand.elements.every((value, index) =>
    Math.abs(value - expectedAvatarHand.elements[index]) < 1e-12),
  'avatar IK removes the third-person camera offset from presented controller/wrist tracking');
  assert.notDeepEqual(presentedHand.elements, avatarHand.elements,
    'controller and wrist presentation remains displaced beside the real headset instead of stuck to the model');
}
const xrSessionSource = readFileSync(new URL('../src/app/ride/xr/session.ts', import.meta.url), 'utf8');
const ridePhysicsSource = readFileSync(new URL('../src/app/ride/physics.ts', import.meta.url), 'utf8');
assert.match(xrSessionSource, /viewRig\.add\(controller, grip, hand\)/,
  'the live controller, grip, and wrist spaces are parented with the displaced headset view');
assert.match(xrSessionSource,
  /watchActionHit\(\)[^]*?hands\.presentationAimRay\('right', watchRaycaster\.ray\)/,
  'wrist UI acquisition uses the camera-relative controller preview ray');
assert.match(xrSessionSource,
  /const onConnected[^]*?slot\.handedness = event\.data\.handedness[^]*?controller\.addEventListener\('connected', onConnected\)/,
  'left-watch/right-pointer ownership follows Three.js controller-slot connection identity');
assert.doesNotMatch(xrSessionSource, /syncSources\(session\.inputSources\)/,
  'runtime input-source enumeration order cannot swap the persistent controller slots');
assert.match(xrSessionSource, /if \(statsEnabled\) viewRig\.add\(profiler\.object\)/,
  'the performance panel is parented to the presented headset instead of the avatar body');
assert.match(xrSessionSource,
  /watchAction === 'controls'[^]*?controlsOpen = !controlsOpen;[^]*?hud\.invalidate\(\)/,
  'the wrist controls action opens and closes the alternate help page immediately');
assert.match(xrSessionSource, /xr\.setFoveation\(1\);[^]*?await xr\.setSession\(session\)/,
  'every XR layer is constructed with full fixed foveation requested');
assert.doesNotMatch(xrSessionSource, /cycleFoveation|pressLeftB/,
  'no controller button can change the fixed foveation policy');
assert.match(xrSessionSource,
  /const menuHeld = wristMenuToggleHeld\(pads\);[^]*?const pressMenu = menuHeld && !held\.menu[^]*?watchVisible = !watchVisible/,
  'a left-Y edge toggles the session wrist-menu visibility latch exactly once');
assert.match(xrSessionSource, /if \(watchVisible\) hands\.placeWatch\(hud\.object\);[^]*?else hud\.object\.visible = false/,
  'the end-of-frame wrist placement honors the Y-button visibility latch');
assert.match(xrSessionSource, /if \(!watchAction && pressTrigger\) \{ dismount\(\); return; \}/,
  'a trigger edge dismounts while riding unless that trigger selected the wrist menu');
assert.doesNotMatch(xrSessionSource, /pressB|pads\.right\?\.b[^]*?resetToCourse|pads\.right\?\.b[^]*?resetOnFoot/,
  'right B remains exclusively boost rather than either recovery action');
assert.match(xrSessionSource,
  /const pressX = !!pads\.left\?\.a[^]*?pressX && controls\.courseRespawn[^]*?ride\.resetToCourse\(\)/,
  'a left-X edge invokes the board model’s nearby-course recovery while riding');
assert.match(xrSessionSource,
  /pressX && controls\.spawnBoard[^]*?spawnBoardAhead\(\)[^]*?function spawnBoardAhead\(\)[^]*?scratch\.copy\(walker\.position\(\)\)\.addScaledVector\(scratchB, BOARD_SPAWN_AHEAD\)[^]*?parkBoardAt\(scratch, scratchB\)/,
  'left X parks the one session board ahead of the walker while off board');
assert.doesNotMatch(xrSessionSource, /respawnOnCourseOnFoot/,
  'off-board X no longer moves the player through the course recovery path');
assert.match(ridePhysicsSource, /if \(heldBoostActive\(\)\) \{[^]*?boardPointingDirection\(st, airAim\)/,
  'mounted airborne boost derives thrust from the visible board nose');
assert.doesNotMatch(ridePhysicsSource, /airBoostAim/,
  'mounted physics no longer has a camera/controller aim seam');
assert.match(xrSessionSource,
  /function offBoardBoostDirection\(\)[^]*?if \(!boardGrab\.held\) return controllerBoostAim\(\)[^]*?set\(0, 0, 1\)\.applyQuaternion\(parked\.group\.quaternion\)/,
  'a carried board replaces the controller ray with its own world-space +Z nose');
assert.match(xrSessionSource, /boostDirection: controls\.boost \? offBoardBoostDirection\(\) : undefined/,
  'off-board B supplies the board/controller direction selected for the current carry state');
assert.match(xrSessionSource, /boardJetpack: controls\.boost && boardGrab\.held/,
  'the walker receives an explicit floor-launch gate only while the board is held');
assert.match(xrSessionSource,
  /if \(pressGrab\[hand\]\) \{ if \(!summonToHand\(hand\)\) takeInHand\(hand\); \}/,
  'a valid behind-head summon takes priority over an ordinary nearby ground grab');
assert.match(xrSessionSource,
  /onFell: \(\) => \{ if \(scoredRunActive\(\)\) resetOnFoot\(\); \}[^]*?function scoredRunActive\(\)[^]*?runStatus\?\.phase === 'running'/,
  'off-board WebXR falls auto-recover only while the retained Race/Showoff score is actively running');
assert.match(xrSessionSource,
  /heldBoardBoostTrail\.update\(\{[^]*?quaternion: parked\.group\.quaternion[^]*?active: boardGrab\.held && walker\.isFlightBoosting\(\)/,
  'held-board thrust drives the same board-pose boost trail while force is applied');
assert.match(xrSessionSource, /object\.lookAt\(scratch\.copy\(headLocal\)\.applyMatrix4\(viewRig\.matrixWorld\)\)/,
  'the performance panel faces the presented headset rather than the avatar head');

// A mounted body is posed once during the ride step, before the XR rig can be seated on that new board pose.
// Fresh world-space wrists arrive afterward, so the public hand seam must immediately perform a zero-time
// presentation solve or the visible gloves trail a moving board by one display frame. The browser-owned session
// cannot be instantiated headlessly; pin the ordering at its small boundary like the other wiring contracts.
const rideSessionSource = readFileSync(new URL('../src/app/ride/session.ts', import.meta.url), 'utf8');
assert.match(rideSessionSource,
  /setXrHands\([^]*?setHandTargets\(left, right\);[^]*?if \(this\.inVr\) this\.pose\.update\(this\.model\.st, 0, this\.input\.keys, this\.model\.renderState\(\)\);/,
  'mounted XR hands are late-latched with zero elapsed time against the current rendered board pose');
assert.match(xrSessionSource, /if \(runArmed\) \{ started\.startRun\(\); runArmed = false; \}/,
  'the prewarmed WebXR board starts an armed run on the next real mount');
assert.match(xrSessionSource,
  /watchAction === 'restart'[^]*?restartAtGate\(\)[^]*?function restartAtGate\(\)[^]*?abandonRun\(\)[^]*?runArmed = true[^]*?parkBoardAt\(deps\.spawn, rigFwd\)[^]*?resetOnFoot\(\)/,
  'wrist Restart abandons the result, restores the gate arrangement, and arms the next mount');
// The green setup flag marks where the run starts; a run in progress must not stand next to it. The desktop path
// hides it in `takeEditorView`; the headset path never takes that view, so it has to put the flag away itself.
const rideLayerSource = readFileSync(new URL('../src/app/viewport/scene/ride.ts', import.meta.url), 'utf8');
assert.match(rideLayerSource,
  /function takeEditorView\(\)[^]*?showRideSpawn\(null\);[^]*?function restoreEditorView\(\)/,
  'a desktop ride puts the start flag away when it takes the editor view');
assert.match(rideLayerSource,
  /xr = session;\s*(?:\/\/[^\n]*\n\s*)*showRideSpawn\(null\);\s*if \(await session\.enter\(\)\) return true;/,
  'entering the headset puts the start flag away before the session\'s first frame');
assert.match(rideLayerSource,
  /if \(await session\.enter\(\)\) return true;[^]*?showRideSpawn\(spawn\);[^]*?return false;\s*\}/,
  'a refused headset session puts the setup flag back where it was');
assert.match(xrSessionSource,
  /offBoardRun = airborne && departing\.runStatus \? departing : null;[^]*?if \(!offBoardRun\) departing\.abandonRun\(\);/,
  'a grounded WebXR dismount clears the run while an airborne hop retains it');
assert.match(xrSessionSource,
  /const coastVelocity = departing\.state\.vel\.clone\(\);[^]*?boardCoast\.launch\(at, coastVelocity, departing\.state\.fwd, departing\.state\.boardUp\)[^]*?walker\.placeAt\(scratch, carry\)/,
  'a WebXR dismount gives the loose deck and airborne rider the authoritative board trajectory');
assert.doesNotMatch(xrSessionSource, /boardCoast\.launch\(at, view\.vel/,
  'WebXR never launches a loose deck from a lagging interpolated render velocity');
assert.match(rideSessionSource,
  /const coastVelocity = this\.model\.st\.vel\.clone\(\);[^]*?this\.boardCoast\?\.launch\(view\.pos, coastVelocity, this\.model\.st\.fwd, this\.model\.st\.boardUp\)/,
  'desktop dismount uses the same authoritative coast handoff as WebXR and Unity');
assert.match(xrSessionSource,
  /offBoardRun\.stepRunOffBoard\(footFrameDt, walker\.isGrounded\(\), boardGrab\.hand\);[^]*?if \(!offBoardRun\.runStatus\) offBoardRun = null;/,
  'an airborne off-board run keeps ticking and scores the held deck until the rider lands without it');
const xrHudSource = readFileSync(new URL('../src/app/ride/xr/hud.ts', import.meta.url), 'utf8');
assert.match(xrHudSource, /run\.phase === 'finished' \? 'FINISHED' : 'TIME UP'/,
  'the wrist status display names a completed race or expired showoff run');
assert.match(xrHudSource,
  /run\.mode === 'showoff'[^]*?formatRunClock\(run\.elapsedSeconds\)[^]*?run\.score[^]*?: formatRunClock\(run\.elapsedSeconds\)/,
  'the wrist result shows score only for Showoff and leaves a Race result time-only');
assert.match(xrHudSource, /run\?\.mode === 'showoff' && run\.phase === 'running'[^]*?run\.score/,
  'the wrist status row keeps live points out of Race while retaining them in Showoff');
assert.match(xrHudSource,
  /state && run\?\.phase === 'running'\) drawBoostMeter\(ctx, run\.boostMeter\)[^]*?RIDE_BOOST_METER_SEGMENTS/,
  'the WebXR wrist draws the run meter only on-board; off-board boost is unlimited');
assert.match(xrHudSource, /run\?\.trick\) drawTrick\(ctx, run\.trick\)[^]*?function drawTrick[^]*?trick\.detail/,
  'the Showoff wrist renders the shared itemized trick and held result');

// Physical head yaw owns the local on-foot body, including after a smooth-turn rig rotation. Looking exactly
// vertical has no meaningful yaw and therefore retains the last stable body heading.
{
  const out = new THREE.Vector3();
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  headsetBodyFacing(yaw, new THREE.Vector3(0, 0, 1), out);
  assert.ok(out.distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-8,
    'turning the headset in the room should turn the on-foot body to the same world yaw');
  const vertical = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  headsetBodyFacing(vertical, out, out);
  assert.ok(out.distanceTo(new THREE.Vector3(-1, 0, 0)) < 1e-8,
    'looking straight down should retain the last stable torso yaw');
}

// Every input source becomes one canonical wrist frame: local +Y is fingers, +Z is palm. Optical hand joints
// use the WebXR Hand Input axes; held controller palms are mirrored left/right and roll with the grip.
{
  const raw = new THREE.Quaternion();
  const optical = canonicalXrHandRotation(raw, 'left', 'hand');
  assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(optical).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-8,
    'an optical wrist should point the canonical fingers along WebXR wrist -Z');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(optical).distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-8,
    'an optical wrist should carry the WebXR palm normal into canonical +Z');
  const leftGrip = canonicalXrHandRotation(raw, 'left', 'grip');
  const rightGrip = canonicalXrHandRotation(raw, 'right', 'grip');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(leftGrip).x > 0.999
    && new THREE.Vector3(0, 0, 1).applyQuaternion(rightGrip).x < -0.999,
  'controller grip palms should mirror across the two hands');
  for (const [hand, grip] of [['left', leftGrip], ['right', rightGrip]] as const) {
    const carry = heldDeckRotation(hand, grip);
    assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(carry)
      .distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-8,
    `${hand} summon should run deck length along the physical controller's up/down edge`);
    assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(carry)
      .distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-8,
    `${hand} summon should face the topsheet back toward the wearer`);
  }
  const rolledRaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, -1), Math.PI / 2);
  const rolled = canonicalXrHandRotation(rolledRaw, 'left', 'hand');
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(rolled).x < -0.999,
    'rolling a tracked wrist should rotate the canonical palm instead of leaving it body-up');

  const visual = createVirtualController();
  visual.setHandedness('right');
  visual.group.updateMatrixWorld(true);
  const box = (name: string) => new THREE.Box3().setFromObject(visual.group.getObjectByName(name)!);
  // The shape is a measured rebuild of Meta's Touch Plus reference in WebXR grip space, so what is worth pinning
  // is the CONTRACT that placement depends on: the handle lies along Z with its centre near the origin, and the
  // deck overhangs the -Z end on the +Y side. Get either wrong and the model sits through the avatar's hand.
  const handle = box('xr-controller.handle');
  const size = handle.getSize(new THREE.Vector3());
  assert.ok(size.z > size.x && size.z > size.y,
    'the shell should run along WebXR grip-space Z, the axis a held rod lies on, not stand up its own Y');
  assert.ok(Math.abs(handle.getCenter(new THREE.Vector3()).z) < 0.02,
    'grip space puts the centre of the handle at the origin, so the shell should straddle z = 0');
  const face = box('xr-controller.face');
  const faceCentre = face.getCenter(new THREE.Vector3());
  assert.ok(faceCentre.z < -0.03 && faceCentre.y > 0,
    'the button deck belongs on the forward -Z end of the grip, standing off it on +Y');
  assert.ok(Math.abs(face.max.x - face.min.x - 0.0664) < 0.004,
    'the deck should keep the reference plate diameter of about 6.6 cm');
  assert.ok(box('xr-controller.collar').min.y < face.min.y,
    'a white collar carries on below the plate rim, so the deck is never a disc floating over a gap');
  const stick = box('xr-controller.stick');
  const buttonA = box('xr-controller.button');
  const triggerCentre = box('xr-controller.trigger').getCenter(new THREE.Vector3());
  assert.ok(triggerCentre.y < -0.028,
    'the physical trigger hangs below the front shell instead of being buried inside the controller model');
  assert.ok(stick.min.y > face.min.y && buttonA.min.y > face.min.y,
    'the stick and the face buttons sit on the deck, not inside it');
  assert.ok(stick.getCenter(new THREE.Vector3()).x > buttonA.getCenter(new THREE.Vector3()).x,
    'on a right controller the stick sits outboard of A, as the hardware lays them out');
  assert.equal(visual.group.getObjectByName('xr-controller.label-A')!.visible, true,
    'the right virtual controller labels its A jump button');
  assert.equal(visual.group.getObjectByName('xr-controller.label-A')!.scale.z, -1,
    'the A/B face glyphs use controller-forward as upright rather than reading upside down in the hand');
  assert.ok(visual.group.getObjectByName('xr-controller.button-upper'),
    'the upper B button is present on the right controller');
  assert.equal(visual.group.getObjectByName('xr-controller.label-B')!.visible, true,
    'the right virtual controller labels its B boost button');
  const jumpLabel = visual.group.getObjectByName('xr-controller.action-jump')!;
  const boostLabel = visual.group.getObjectByName('xr-controller.action-boost')!;
  const steerLabel = visual.group.getObjectByName('xr-controller.action-steer')!;
  const resetLabel = visual.group.getObjectByName('xr-controller.action-reset')!;
  const spawnLabel = visual.group.getObjectByName('xr-controller.action-spawn')!;
  const menuLabel = visual.group.getObjectByName('xr-controller.action-menu')!;
  const moveLabel = visual.group.getObjectByName('xr-controller.action-move')!;
  const lookLabel = visual.group.getObjectByName('xr-controller.action-look')!;
  const equipLabel = visual.group.getObjectByName('xr-controller.action-equip')!;
  const unequipLabel = visual.group.getObjectByName('xr-controller.action-unequip')!;
  const grabBoardLabel = visual.group.getObjectByName('xr-controller.action-grab-board')!;
  assert.ok(jumpLabel instanceof THREE.LineSegments && boostLabel instanceof THREE.LineSegments,
    'JUMP and BOOST are small vector marks fixed to the controller deck, not camera-facing callouts');
  const jumpMaterial = (jumpLabel as THREE.LineSegments).material;
  assert.equal(jumpMaterial instanceof THREE.LineBasicMaterial && jumpMaterial.depthTest, true,
    'surface text is occluded with the controller instead of showing through it like a floating overlay');
  assert.equal(jumpLabel.parent?.name, 'xr-controller.deck',
    'the action text moves and rotates as part of the physical controller surface');
  assert.equal(equipLabel.parent?.name, 'xr-controller.trigger',
    'EQUIP is printed directly on the moving index trigger');
  assert.equal(grabBoardLabel.parent?.name, 'xr-controller.grip-pad',
    'GRAB BOARD is printed down the moving grip paddle');
  assert.ok(equipLabel.position.z < -0.0052,
    'the trigger text sits just beyond the exposed forward face, not on the face buried toward the shell');
  assert.equal(equipLabel.scale.x, -1,
    'the trigger-face EQUIP letters read in order when viewed from the exposed side');
  assert.ok(grabBoardLabel.position.x < -0.0022,
    'the right grip text sits just beyond its exposed outer side, not on the narrow top edge');
  const controlInk = (equipLabel as THREE.LineSegments).material;
  assert.equal(controlInk instanceof THREE.LineBasicMaterial && controlInk.color.getHex(), 0x123842,
    'dark control ink keeps the trigger and grip labels legible against their white button surfaces');
  assert.ok(equipLabel.visible && !unequipLabel.visible && grabBoardLabel.visible,
    'an on-foot controller identifies the live trigger and grip board actions');
  visual.setBoardAction(true);
  assert.ok(!equipLabel.visible && unequipLabel.visible && grabBoardLabel.visible,
    'the index-trigger label switches to UNEQUIP while riding without hiding the grip label');
  assert.ok(!lookLabel.visible && !moveLabel.visible && !steerLabel.visible,
    'riding, the right stick does nothing, so the right controller carries no stick legend');
  visual.setBoardAction(false);
  assert.ok(jumpLabel.visible && boostLabel.visible && !steerLabel.visible && !resetLabel.visible
    && !spawnLabel.visible && !menuLabel.visible,
    'the right controller shows JUMP/BOOST beside A/B without adding a false steering label');
  assert.ok(lookLabel.visible && !moveLabel.visible,
    'on foot the right stick turns the view, and its legend says so');
  // The A legend used to sit on the far edge beyond the button, where the thumb reaching across the deck covers
  // it exactly when the rider looks down to read it. Both legends now share the edge beside B, stacked.
  assert.ok(jumpLabel.position.x < -0.015 && Math.abs(jumpLabel.position.x - boostLabel.position.x) < 1e-6
    && Math.abs(spawnLabel.position.x - boostLabel.position.x) < 1e-6
    && Math.abs(resetLabel.position.x - boostLabel.position.x) < 1e-6,
    'the A/X legends sit on the same plate edge as the B/Y legends, out from under the thumb');
  assert.ok(jumpLabel.position.z > boostLabel.position.z + 0.012,
    'the two legends stack without overlapping: A/X aft beside A, B/Y forward beside B');
  assert.equal(visual.group.getObjectByName('xr-controller.squeeze-right'), undefined,
    'one mirrored model replaced the pair of grip paddles the hardware-neutral controller drew');

  const rightPad = box('xr-controller.grip-pad').getCenter(new THREE.Vector3());
  assert.ok(rightPad.x < -0.025 && rightPad.x > -0.028 && rightPad.y < -0.017,
    'the right grip paddle stands off the handle\'s inward side and down — but tucked toward its own controller, '
    + 'not reaching toward the other hand');
  visual.setHandedness('left');
  visual.group.updateMatrixWorld(true);
  const leftPad = box('xr-controller.grip-pad').getCenter(new THREE.Vector3());
  assert.ok(rightPad.x < 0 && leftPad.x > 0,
    'mirroring the model puts the single grip pad on the inward side of whichever hand holds it');
  assert.ok(Math.abs(leftPad.x + rightPad.x) < 1e-6 && Math.abs(leftPad.z - rightPad.z) < 1e-6,
    'the left controller is the right one mirrored through X, which is what the hardware is');
  assert.equal(visual.group.getObjectByName('xr-controller.label-A')!.visible, false,
    'the right-hand A label stays off the left controller');
  assert.equal(visual.group.getObjectByName('xr-controller.label-B')!.visible, false,
    'the right-hand B label stays off the left controller');
  assert.equal(visual.group.getObjectByName('xr-controller.label-X')!.visible, true,
    'the active left X button carries its own action glyph');
  assert.equal(visual.group.getObjectByName('xr-controller.label-Y')!.visible, true,
    'the active left Y wrist-menu button carries its own action glyph');
  assert.equal(visual.group.getObjectByName('xr-controller.label-X')!.scale.z, -1,
    'the left X glyph uses the same upright controller-surface orientation as A/B');
  assert.ok(!jumpLabel.visible && !boostLabel.visible && !steerLabel.visible && moveLabel.visible
    && !lookLabel.visible && !resetLabel.visible && spawnLabel.visible && menuLabel.visible,
    'off board, the left controller replaces RESET with the live SPAWN action beside X and labels its stick MOVE');
  assert.equal(equipLabel.scale.x, 1,
    'the mirrored left trigger preserves the corrected exposed-face EQUIP reading direction');
  visual.setBoardAction(true);
  assert.ok(resetLabel.visible && !spawnLabel.visible,
    'while riding, the left X surface action switches back from SPAWN to RESET');
  assert.ok(steerLabel.visible && !moveLabel.visible,
    'while riding, the left stick legend switches from MOVE to STEER');
  assert.ok(visual.group.getObjectByName('xr-controller.button')!.visible,
    'the bound X hardware cap remains visible on the left hand');
  visual.dispose();
}

assert.equal(preferredBoardActionHand(false, false), null);
assert.equal(preferredBoardActionHand(true, false), 'left');
assert.equal(preferredBoardActionHand(false, true), 'right');
assert.equal(preferredBoardActionHand(true, true), 'right',
  'one board gets one guide, and the right controller wins when both hands can act on it');

// A live board action draws a genuinely dashed, narrow world-space tube. Unlike platform-limited WebGL lines,
// it has reliable thickness in-headset, starts beyond the controller shell, and stays at 50% opacity.
{
  const guide = createBoardActionGuide('left');
  assert.equal(guide.object.name, 'xr-board-action-guide-left');
  assert.ok(guide.object.material instanceof THREE.ShaderMaterial,
    'the controller-to-board cue uses a shader-dashed tube rather than a platform-limited one-pixel line');
  assert.equal(guide.object.material.opacity, 0.5, 'the cyan guide is exactly 50% opaque');
  assert.equal(guide.object.geometry.parameters.radiusTop, 0.00225,
    'the guide has a stable 4.5 mm world-space diameter');
  assert.match(guide.object.material.fragmentShader, /mod\(vAlong \* lineLength, dashSize \+ gapSize\)/,
    'the tube keeps the cyan dash/gap cadence along its world-space length');
  assert.equal(guide.object.visible, false, 'the guide stays absent until a board action is in range');
  const from = new THREE.Vector3(1, 2, 3), to = new THREE.Vector3(4, 6, 3);
  guide.show(from, to);
  assert.equal(guide.object.visible, true);
  guide.object.updateMatrixWorld(true);
  const drawnStart = new THREE.Vector3(0, -0.5, 0).applyMatrix4(guide.object.matrixWorld);
  const drawnEnd = new THREE.Vector3(0, 0.5, 0).applyMatrix4(guide.object.matrixWorld);
  const expectedStart = from.clone().addScaledVector(to.clone().sub(from).normalize(), 0.09);
  assert.ok(drawnStart.distanceTo(expectedStart) < 1e-7,
    'the dash begins nine centimetres out from the grip origin, beyond the controller shell');
  assert.ok(drawnEnd.distanceTo(to) < 1e-7, 'the far end still lands on the actionable deck point');
  assert.ok(Math.abs(guide.object.material.uniforms.lineLength.value - 4.91) < 1e-8,
    'the dash shader receives the visible post-clearance length in world metres');
  guide.hide();
  assert.equal(guide.object.visible, false);
  guide.dispose();
}

assert.deepEqual(xrControllerDiagramLabels('ride').right, [
  { control: 'TRIGGER', action: 'DISMOUNT' }, { control: 'GRIP', action: 'CARRY' },
  { control: 'STICK', action: 'CLICK VIEW' }, { control: 'A', action: 'HOLD · JUMP' },
  { control: 'B', action: 'BOOST' },
], 'the wrist diagram names trigger, A, and B with their riding actions');
{
  const left = xrMiniControllerLayout('left'), right = xrMiniControllerLayout('right');
  assert.deepEqual(right, {
    stick: { x: 15, y: -20 }, faceLower: { x: -12, y: -14 }, faceUpper: { x: -22, y: -29 },
  }, 'the right help controller puts its stick on the right and angles A/B inward on the left');
  assert.equal(left.stick.x, -right.stick.x);
  assert.equal(left.faceLower.x, -right.faceLower.x);
  assert.equal(left.faceUpper.x, -right.faceUpper.x,
    'the two help-controller control clusters are exact horizontal mirrors');
}
assert.deepEqual(xrControllerDiagramLabels('ride').left, [
  { control: 'TRIGGER', action: 'DISMOUNT' }, { control: 'GRIP', action: 'CARRY' },
  { control: 'STICK', action: 'CARVE · TUCK/BRAKE' },
  { control: 'X', action: 'COURSE RESPAWN' },
  { control: 'Y', action: 'SHOW / HIDE MENU' },
], 'the riding diagram exposes left X recovery and left Y wrist-menu visibility');
assert.deepEqual(xrControllerDiagramLabels('foot').left.map(row => row.control),
  ['TRIGGER', 'GRIP', 'STICK', 'X', 'Y'], 'the on-foot left diagram exposes both face-button actions');
assert.equal(xrControllerDiagramLabels('foot').left.find(row => row.control === 'X')?.action, 'SPAWN BOARD',
  'the on-foot help advertises X as the board recall instead of player recovery');
assert.equal(xrControllerDiagramLabels('foot').left.find(row => row.control === 'Y')?.action, 'SHOW / HIDE MENU',
  'the help advertises the session-wide Y wrist-menu toggle');
assert.deepEqual(xrControllerDiagramLabels('foot').right.map(row => row.control),
  ['TRIGGER', 'GRIP', 'STICK', 'A', 'B'], 'the right-controller diagram includes A jump and B boost');
assert.equal(xrControllerDiagramLabels('foot').right[0].action, 'RIDE',
  'the on-foot diagram keeps the right trigger exclusively on board interaction');
assert.match(xrControllerDiagramLabels('foot').right.find(row => row.control === 'A')?.action ?? '', /DOUBLE .*FLY/,
  'the diagram advertises double-jump flight on A');
assert.match(xrControllerDiagramLabels('foot').right.find(row => row.control === 'B')?.action ?? '', /AIR BOOST · \+A FLY/,
  'the diagram advertises that A + B enters flight and B boosts it');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /behind your head.*summon/i.test(note)),
  'the help page explains the behind-the-head board summon');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /airborne.*(?:take|remove).*board/i.test(note)),
  'the help page explains taking the board off while flying');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /on board.*B follows.*deck nose/i.test(note)),
  'the help notes say that mounted boost follows the board nose');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /holding.*jetpack.*ground/i.test(note)),
  'the help notes explain the held board’s floor-launching jetpack behavior');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /empty hand.*right controller/i.test(note)),
  'the help notes retain the empty-handed right-controller aim');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /off-board.*boost.*unlimited/i.test(note)),
  'the help notes distinguish unlimited Superman boost from the board run meter');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /A \+ B turns a jump into flight/i.test(note)),
  'the help notes advertise Jump + Boost as an alternate flight entry');
assert.ok(XR_BOARD_CONTROL_NOTES.some(note => /trigger re-equips/i.test(note)),
  'the help page explains putting a held board back under the rider');
assert.doesNotMatch(xrSessionSource, /flightRay|watchAction === 'fly'|flight:\s*\{/,
  'the XR session contains no pointed-trigger or wrist-button flight path');
assert.match(xrSessionSource, /setFlightBoostAudio\(walker\.isFlightBoosting\(\), dt\)/,
  'XR audio follows the walker’s applied-air-boost gate');
assert.match(xrSessionSource,
  /Off-board boost never spends the retained run meter\.[^]*?boost: controls\.boost/,
  'off-board B reaches the walker directly without consulting a retained board run meter');
assert.match(xrSessionSource, /walker\.step\(dt,[^]*?boost: controls\.boost/,
  'off-board flight receives raw held B state without consulting the retained ride scorer');

// Physical X/Z tracking moves 1:1 through the rig's yaw; height is head/crouch pose, not locomotion.
{
  const previous = new THREE.Vector3(1, 1.7, 2);
  const current = new THREE.Vector3(1.3, 1.2, 1.6);
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const delta = new THREE.Vector3();
  assert.equal(trackedRoomDelta(previous, current, rotation, delta), true);
  assert.ok(Math.abs(delta.length() - 0.5) < 1e-9, 'room-scale horizontal distance is preserved 1:1');
  assert.ok(Math.abs(delta.y) < 1e-9, 'physical crouch height is not folded into walker locomotion');
  assert.equal(trackedRoomDelta(previous, new THREE.Vector3(3, 1.7, 2), rotation, delta), false,
    'a tracking-origin jump is a recenter event, not a two-metre teleport');

  const pending = new THREE.Vector3();
  assert.equal(trackedRoomMoveReady(pending, new THREE.Vector3(0.0005, 0, 0)), false,
    'sub-millimetre optical jitter does not launch a collision solve');
  assert.equal(trackedRoomMoveReady(pending, new THREE.Vector3(0.0016, 0, 0)), true,
    'slow real room movement accumulates instead of being discarded by the jitter gate');
  assert.ok(Math.abs(pending.x - 0.0021) < 1e-9, 'the ready movement retains the complete accumulated distance');
}

// Layer reporting follows the actual runtime object, independently of the requested render path.
{
  assert.equal(xrLayerKind({ framebufferWidth: 6000 }), 'webgl');
  assert.equal(xrLayerKind({ textureWidth: 6000 }), 'projection');
  assert.equal(xrLayerKind({}), 'none');
}

// ---------------------------------------------------------------------------------------------------------
// The WebXR control map: left stick carves and throttles, A jumps in either locomotion state, B boosts in either
// state, either trigger is the state-aware mount/dismount verb, and left X is nearby-course recovery.

/** A controller reporting the `xr-standard` layout: four axes, thumbstick at 2/3. */
function pad(handedness: 'left' | 'right', over: Partial<Record<string, number | boolean>> = {}) {
  const names = ['trigger', 'squeeze', 'pad', 'stick', 'a', 'b'];
  const buttons = names.map(name => {
    const raw = over[name], value = typeof raw === 'number' ? raw : Number(!!raw);
    return { pressed: value > 0.5, touched: value > 0, value };
  });
  return {
    handedness,
    gamepad: { axes: [0, 0, Number(over.x ?? 0), Number(over.y ?? 0)], buttons } as unknown as Gamepad,
  } as unknown as XRInputSource;
}

{
  const hand = readPads([pad('left', { squeeze: 0.8, trigger: 0 })]).left;
  assert.deepEqual(controllerFingerCurls(hand), {
    thumb: 0.8, index: 0, middle: 0.8, ring: 0.8, pinky: 0.8,
  }, 'grab should close four digits while leaving the trigger/index finger pointing');
  const fist = controllerFingerCurls(readPads([pad('right', { squeeze: 1, trigger: 1 })]).right);
  assert.deepEqual(fist, { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 },
    'grab plus trigger should close the controller hand into a fist');
}

{
  const pads = readPads([pad('left', { x: 0.9, y: -1, trigger: true, a: true }),
    pad('right', { a: true, b: true })]);
  const left = pads.left as XrHand;
  assert.equal(left.handedness, 'left');
  assert.ok(left.trigger, 'the left trigger reads on the left hand');

  const ride = rideControls(pads);
  assert.ok(ride.steer > 0.5, `full right stick carves right (got ${ride.steer.toFixed(3)})`);
  assert.ok(ride.tuck && !ride.brake, 'stick pushed AWAY from you is the tuck, not the brake');
  assert.ok(ride.boost, 'right B is SSX’s held Boost');
  assert.ok(ride.ollie, 'right A is the charged board jump');
  assert.ok(ride.dismount, 'either trigger gets the rider off the board');
  assert.equal((pads.right as XrHand).b, true, 'right B is exposed by the XR input map');
  const xOnly = rideControls(readPads([pad('left', { a: true })]));
  assert.ok(xOnly.courseRespawn && !xOnly.boost && !xOnly.ollie,
    'left X requests course recovery without becoming a second boost or jump button');
  const triggerOnly = rideControls(readPads([pad('left', { trigger: true })]));
  assert.ok(triggerOnly.dismount && !triggerOnly.boost && !triggerOnly.ollie,
    'the trigger is exclusively dismount while riding');
}

assert.equal(viewToggleHeld(readPads([pad('right', { stick: true })])), true,
  'right-stick click is the headset-native first/third-person toggle');
assert.equal(viewToggleHeld(readPads([pad('left', { stick: true })])), false,
  'the steering stick cannot toggle the view accidentally');
assert.equal(wristMenuToggleHeld(readPads([pad('left', { b: true })])), true,
  'left Y is the headset-native wrist-menu visibility toggle');
assert.equal(wristMenuToggleHeld(readPads([pad('right', { b: true })])), false,
  'right B remains boost and cannot hide the wrist menu');

{
  const ride = rideControls(readPads([pad('left', { y: 1 }), pad('right', { a: true })]));
  assert.ok(ride.brake && !ride.tuck, 'stick pulled BACK is the brake');
  assert.ok(ride.ollie, 'right A is the charged ollie');
  assert.ok(!ride.boost, '...and it is not the boost');
}

// A hand that is tracked but carries no gamepad (hand tracking, a tracked object) must not read as a hand at
// rest that is also pressing nothing — it must simply be absent, so the other hand still drives the run.
{
  const bare = { handedness: 'left', gamepad: undefined } as unknown as XRInputSource;
  const pads = readPads([bare, pad('right', { a: true })]);
  assert.equal(pads.left, null, 'a gamepad-less hand reports nothing');
  assert.ok(rideControls(pads).ollie, 'and the other hand can still jump');
}

// The dead zone is the one thing between a resting thumb and a board that carves on its own.
{
  assert.equal(shapeAxis(0.1), 0, 'a resting thumb inside the dead zone is exactly zero');
  assert.ok(Math.abs(shapeAxis(1)) > 0.99, 'full deflection is full steer');
  assert.ok(shapeAxis(0.5) < 0.5, 'the centre is softened, as it is on the pad and the touch stick');
  assert.equal(shapeAxis(-0.5), -shapeAxis(0.5), 'and the shaping is symmetric');
}

// Riding uses the headset-tested Unity precision curve after the physical dead zone: sign(x)·x², exactly full
// at hard lock. It is deliberately separate from the walking curve above.
{
  const normalizedHalf = (0.5 - 0.18) / (1 - 0.18);
  assert.equal(precisionRideAxis(0.1), 0, 'precision ride steering keeps the controller drift dead zone');
  assert.ok(Math.abs(precisionRideAxis(0.5) - normalizedHalf * normalizedHalf) < 1e-12,
    'partial ride stick is squared after dead-zone normalization');
  assert.equal(precisionRideAxis(1), 1, 'hard right remains exactly 100%');
  assert.equal(precisionRideAxis(-1), -1, 'hard left remains exactly 100%');
  assert.equal(rideControls(readPads([pad('left', { x: 0.5 })])).steer, precisionRideAxis(0.5),
    'the WebXR riding map actually hands that precision value to the board');
  assert.equal(rideControls(readPads([pad('left', { x: 0.5 })])).spin, normalizeAxis(0.5),
    'air spin receives linear post-dead-zone throw instead of the ground carve curve');
  const mostlyHorizontal = rideControls(readPads([pad('left', { x: 0.8, y: -0.41 })]));
  assert.ok(!mostlyHorizontal.tuck && !mostlyHorizontal.brake,
    'incidental XR stick Y does not add a flip to a mostly-horizontal air spin');
  const diagonal = rideControls(readPads([pad('left', { x: 0.7, y: -0.7 })]));
  assert.ok(diagonal.spin > 0 && diagonal.tuck,
    'a deliberate XR diagonal retains simultaneous spin and forward flip');
}

// On foot the same sticks mean walking and turning. Either trigger remains board interaction; A double-jumps and
// right B restores full Superman speed.
{
  const foot = footControls(readPads([pad('left', { x: 0, y: -1, a: true }),
    pad('right', { trigger: true, a: true, b: true })]));
  assert.ok(foot.moveY > 0.9 && Math.abs(foot.moveX) < 1e-6, 'stick away from you walks forward');
  assert.ok(foot.mount, 'the right trigger reaches for the board');
  assert.ok(foot.jump, 'right A exposes the on-foot jump and double-jump intent');
  assert.ok(foot.boost, 'right B exposes the full-speed flight modifier');
  assert.ok(footControls(readPads([pad('left', { trigger: true }), pad('right')])).mount,
    '...and so does the left');
  assert.ok(footControls(readPads([pad('left'), pad('right', { trigger: true })])).mount,
    'carrying the deck can still use the right trigger to re-equip it');
  const boostOnly = footControls(readPads([pad('left', { a: true }), pad('right', { b: true })]));
  assert.ok(boostOnly.boost && boostOnly.spawnBoard && !boostOnly.jump && !boostOnly.mount,
    'right B boosts on foot while left X independently requests a board ahead');
}

// The GRIP is the carry verb, in every state and on both hands: pick the deck up, pass it over, throw it, and
// snatch it off your own feet mid-flight. Which of those a squeeze means is the session's business; the map's
// job is only to report that a hand closed.
{
  const grab = grabControls(readPads([pad('left', { squeeze: true }), pad('right')]));
  assert.deepEqual(grab, { left: true, right: false }, 'the grip reads on the hand that squeezed it');
  assert.deepEqual(grabControls(readPads([pad('left', { trigger: true }), pad('right', { a: true })])),
    { left: false, right: false }, 'and nothing else on either controller is a grab');
  assert.deepEqual(grabControls(readPads([])), { left: false, right: false },
    'an absent controller is an open hand, not a held grip');
}

// Smooth turn is time-based, dead-zoned, and correctly signed in Three's world-yaw convention. Positive world-Y
// turns a −Z-facing viewer LEFT, so pushing the physical stick right has to produce a negative yaw.
{
  assert.equal(smoothTurnRadians(0.1, 1 / 60), 0, 'a nudge inside the dead zone turns nothing');
  const right = smoothTurnRadians(1, 1 / 60);
  assert.ok(right < 0, 'pushing right produces the negative world yaw that actually faces right');
  assert.ok(new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), right).x > 0,
    'and that yaw turns a forward-facing viewer toward world right, not left');
  assert.ok(Math.abs(smoothTurnRadians(1, 1 / 30) - right * 2) < 1e-9,
    'holding the stick sweeps continuously at a frame-rate-independent rate');
  assert.equal(smoothTurnRadians(-1, 1 / 60), -right, 'left is the exact opposite turn');
}

// ---------------------------------------------------------------------------------------------------------
// The rig's facing convention. A rig carries a VIEWER, and a viewer looks down its own −Z; seat it with the +Z
// sign and the rider faces backwards, which mirrors walking, the mount reach and head steer all at once — so
// each of them then looks like a separate bug. Found in the headset the first time; pinned here.
{
  for (const heading of [
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0.6, 0, -0.8),
  ]) {
    const rig = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), viewerYaw(heading));
    const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(rig);
    assert.ok(facing.distanceTo(heading) < 1e-6,
      `a rig yawed for ${heading.toArray()} faces it (got ${facing.toArray().map(v => v.toFixed(3))})`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The walker.

/** A ground query over a heightfield given as a function of x — enough for floors, steps and walls. */
function terrain(heightAt: (x: number, z: number) => number | null, normalAt?: (x: number) => THREE.Vector3) {
  return downwardGroundQuery((from, to): WalkGround | null => {
    const y = heightAt(from.x, from.z);
    if (y === null) return null;
    if (y > from.y || y < to.y) return null; // outside the probe's own window, as a real cast would be
    return { y, normal: normalAt?.(from.x) ?? new THREE.Vector3(0, 1, 0) };
  });
}

// A head looking down −Z, which is where a camera's own forward points; the walker's right is then +X.
const FORWARD = new THREE.Vector3(0, 0, -1);
const still = { moveX: 0, moveY: 0, forward: FORWARD, jump: false };

// Dropped in, the walker falls and lands — and STAYS landed rather than bouncing or sinking.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 8, 0), new THREE.Vector3(0, 0, 0));
  assert.ok(!walker.isGrounded(), 'a carried placement starts airborne');
  for (let i = 0; i < 240; i++) walker.step(1 / 60, still);
  assert.ok(walker.isGrounded(), 'it lands');
  assert.ok(Math.abs(walker.position().y) < 1e-6, `and rests exactly on the floor (y ${walker.position().y})`);
}

// Walking is head-relative and uses the speeds OpenSlope Unity stamps onto VRCWorldSettings.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 60; i++) walker.step(1 / 60, { moveX: 0, moveY: 1, forward: FORWARD, jump: false });
  const travelled = -walker.position().z;
  assert.ok(Math.abs(travelled - PLAYER_RUN_SPEED) < 1e-9,
    `a second of full forward covers Unity's ${PLAYER_RUN_SPEED} m (got ${travelled.toFixed(2)})`);
  assert.ok(walker.position().z < 0, 'and it goes where the head is pointed');
  assert.ok(Math.abs(walker.position().x) < 1e-6, 'with nothing sideways out of a forward push');

  walker.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 60; i++) walker.step(1 / 60, { moveX: 1, moveY: 0, forward: FORWARD, jump: false });
  assert.ok(Math.abs(walker.position().x - PLAYER_STRAFE_SPEED) < 1e-9,
    `full strafe covers Unity's gentler ${PLAYER_STRAFE_SPEED} m/s`);
}

// Walking in the physical room advances the same walker 1:1 but does not manufacture stick momentum.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  walker.moveTracked(new THREE.Vector3(0.3, 0, -0.4));
  walker.step(1 / 60, still);
  assert.ok(Math.abs(walker.position().length() - 0.5) < 1e-9,
    'a 50 cm physical step moves the in-game feet exactly 50 cm');
  assert.ok(walker.velocity().lengthSq() < 1e-9, 'room-scale displacement does not become stick velocity');
}

// Desktop Ctrl crouch keeps the same direction and controller but slows the character to a cautious walk.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 60; i++) walker.step(1 / 60, {
    moveX: 0, moveY: 1, forward: FORWARD, jump: false, crouch: true,
  });
  const travelled = -walker.position().z;
  assert.ok(travelled > 4.3 && travelled < 4.6,
    `a crouch-walk should cover about 55% of full speed (got ${travelled.toFixed(2)} m)`);
}

// A step you could stroll up is walked up; a wall is not walked through. The two differ only by height, which is
// exactly the check — a walker that took either as "no floor here" would be stuck at both.
{
  const step = createWalker({ ground: terrain((x) => (x > 1 ? 0.3 : 0)), oobFloorY: -100 });
  step.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 90; i++) step.step(1 / 60, { moveX: 1, moveY: 0, forward: FORWARD, jump: false });
  assert.ok(step.position().x > 2, `a 30 cm step is walked up (reached x ${step.position().x.toFixed(2)})`);
  assert.ok(Math.abs(step.position().y - 0.3) < 1e-6, 'and the walker stands on top of it');

  const wall = createWalker({ ground: terrain((x) => (x > 1 ? 4 : 0)), oobFloorY: -100 });
  wall.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 90; i++) wall.step(1 / 60, { moveX: 1, moveY: 0, forward: FORWARD, jump: false });
  assert.ok(wall.position().x < 1.05, `a 4 m wall is not (stopped at x ${wall.position().x.toFixed(2)})`);
}

// The two things that look alike from underneath and must not behave alike. Where the MESH runs out there is
// nothing to stand on and nothing to fall onto either, so the boundary holds the rider: walking into the void
// off the side of a mountain is a bug report, not a feature. A cliff INSIDE the mesh still has floor a long way
// below it, and that is a real fall.
const right = { moveX: 1, moveY: 0, forward: FORWARD, jump: false };
{
  const edge = createWalker({ ground: terrain((x) => (x < 2 ? 0 : null)), oobFloorY: -100 });
  edge.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 120; i++) edge.step(1 / 60, right);
  assert.ok(edge.position().x <= 2.01, `the mountain's own edge holds (stopped at x ${edge.position().x.toFixed(2)})`);
  assert.ok(edge.isGrounded(), 'with the rider still on their feet');

  const cliff = createWalker({ ground: terrain((x) => (x < 2 ? 0 : -30)), oobFloorY: -100 });
  cliff.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 45; i++) cliff.step(1 / 60, right);
  assert.ok(!cliff.isGrounded(), 'a cliff inside the mesh drops you');
  for (let i = 0; i < 300; i++) cliff.step(1 / 60, right);
  assert.ok(cliff.isGrounded() && Math.abs(cliff.position().y + 30) < 1e-6, '...and you land at the bottom of it');
}

// Falling past the floor is the host's cue to put the rider back on the course.
{
  let fell = 0;
  const walker = createWalker({ ground: terrain(() => null), oobFloorY: -20, onFell: () => { fell++; } });
  walker.placeAt(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 300; i++) walker.step(1 / 60, still);
  assert.ok(fell > 0, 'a fall past the out-of-bounds floor reports itself');
}

// The first press is still Unity's authored, ground-gated jump. Without a second press it remains the same
// ballistic hop and lands at the same apex.
{
  const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  walker.step(1 / 60, { ...still, jump: true });
  const rising = walker.velocity().y;
  assert.ok(Math.abs(rising - (PLAYER_JUMP_IMPULSE - 9.81 / 60)) < 1e-9,
    `the jump begins from Unity's ${PLAYER_JUMP_IMPULSE} m/s impulse (${rising.toFixed(2)} after gravity)`);
  let peak = 0;
  for (let i = 0; i < 240; i++) { walker.step(1 / 60, still); peak = Math.max(peak, walker.position().y); }
  assert.ok(peak > 1 && peak < 1.2, `and matches Unity's ~1.16 m apex (peaked ${peak.toFixed(2)} m)`);
  assert.ok(walker.isGrounded(), 'then lands again');
}

// A second jump press while the first jump is airborne enters directional Superman flight. Jump + Boost is the
// alternate entry. Directional thrust cruises at half speed; Boost restores the authored full acceleration/caps.
const flyingWalker = (removeFloor = true) => {
  let floor = true;
  const walker = createWalker({ ground: terrain(() => floor ? 0 : null), oobFloorY: -10_000 });
  walker.placeAt(new THREE.Vector3(0, 0, 0));
  walker.step(1 / 60, { ...still, jump: true, jumpHeld: true });
  walker.step(1 / 60, still); // release between presses
  walker.step(1 / 60, { ...still, jump: true, jumpHeld: true });
  assert.ok(walker.isFlying(), 'the second airborne jump press enters Superman flight');
  floor = !removeFloor; // most probes stay airborne; coast tests retain a landing surface
  return walker;
};
{
  const thrust = (intent: Partial<typeof still> & { jumpHeld?: boolean; crouch?: boolean; boost?: boolean }) => {
    const walker = flyingWalker();
    for (let i = 0; i < 60; i++) walker.step(1 / 60, { ...still, ...intent });
    return walker.velocity().clone();
  };
  const cruiseForward = thrust({ moveY: 1 });
  const boostedForward = thrust({ moveY: 1, boost: true });
  assert.ok(cruiseForward.z < -10, 'W / stick-forward thrusts along the flattened view');
  assert.ok(thrust({ moveY: -1 }).z > 10, 'S / stick-back thrusts backward');
  assert.ok(thrust({ moveX: -1 }).x < -10, 'A / stick-left thrusts left');
  assert.ok(thrust({ moveX: 1 }).x > 10, 'D / stick-right thrusts right');
  assert.ok(thrust({ jumpHeld: true }).y > 5, 'holding jump after activation thrusts up');
  assert.ok(thrust({ crouch: true }).y < -10, 'holding crouch after activation thrusts down');
  assert.ok(-boostedForward.z > -cruiseForward.z * 1.9,
    'holding Boost restores approximately twice the cruise-flight acceleration');

  const aimed = flyingWalker();
  aimed.step(1 / 60, { ...still, boost: true, boostDirection: new THREE.Vector3(1, 0, 0) });
  assert.ok(aimed.isFlightBoosting() && aimed.velocity().x > 0,
    'B thrusts along an explicit controller aim during flight even with every directional control centred');

  const jetpack = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  jetpack.placeAt(new THREE.Vector3(0, 0, 0));
  jetpack.step(1 / 60, {
    ...still, boost: true, boardJetpack: true, boostDirection: new THREE.Vector3(0, 1, 0),
  });
  assert.ok(!jetpack.isGrounded() && jetpack.isFlightBoosting(),
    'a held-board boost can leave the floor without first entering jump/Superman flight');
  assert.ok(jetpack.velocity().y > 0,
    'the floor launch accelerates along the supplied upward board nose');

  const soundGate = flyingWalker();
  soundGate.step(1 / 60, { ...still, moveY: 1, boost: true });
  assert.ok(soundGate.isFlightBoosting(), 'boost audio opens while boosted directional thrust is applied');
  soundGate.step(1 / 60, { ...still, boost: true });
  assert.ok(!soundGate.isFlightBoosting(), 'holding Boost without directional thrust does not play the boost sound');

  const ledge = createWalker({ ground: terrain((x) => (x < 1 ? 0 : -100)), oobFloorY: -1000 });
  ledge.placeAt(new THREE.Vector3(0, 0, 0));
  for (let i = 0; i < 30; i++) ledge.step(1 / 60, right);
  assert.ok(!ledge.isGrounded(), 'the ledge case is airborne without jumping');
  ledge.step(1 / 60, { ...still, jump: true, jumpHeld: true });
  assert.ok(!ledge.isFlying(), 'walking off a ledge does not count as the first half of a double jump');
}

// Boost during a grounded jump is the alternate chord that turns persistent Superman flight on. This works if
// Boost was held at takeoff or joins the jump once airborne. The walker owns no boost meter off-board.
{
  const jumpArc = (boost: boolean) => {
    const walker = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
    walker.placeAt(new THREE.Vector3(0, 0, 0));
    walker.step(1 / 60, { ...still, moveY: 1, jump: true });
    for (let i = 0; i < 30; i++) walker.step(1 / 60, { ...still, moveY: 1, boost });
    return walker;
  };
  const plain = jumpArc(false), boosted = jumpArc(true);
  assert.ok(boosted.isFlying(), 'adding B to a single A jump enters persistent Superman flight');
  assert.ok(boosted.isFlightBoosting(), 'B reports boost while directional thrust is actually applied to that jump');
  assert.ok(-boosted.velocity().z > -plain.velocity().z + 5,
    `Jump + B adds full airborne thrust (${(-plain.velocity().z).toFixed(1)} -> ${(-boosted.velocity().z).toFixed(1)} m/s)`);

  const takeoffChord = createWalker({ ground: terrain(() => 0), oobFloorY: -100 });
  takeoffChord.placeAt(new THREE.Vector3(0, 0, 0));
  takeoffChord.step(1 / 60, { ...still, jump: true, jumpHeld: true, boost: true });
  assert.ok(takeoffChord.isFlying(), 'holding Jump + Boost together enters flight directly at takeoff');

  const dismount = createWalker({ ground: terrain(() => null), oobFloorY: -1000 });
  dismount.placeAt(new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 1, -12));
  dismount.step(1 / 60, { ...still, boost: true, boostDirection: new THREE.Vector3(1, 0.25, 0) });
  assert.ok(dismount.isFlightBoosting() && !dismount.isFlying(),
    'the inherited airborne arc from a board dismount accepts unlimited aimed B thrust with centred sticks');
  assert.ok(dismount.velocity().x > 0 && dismount.velocity().y > 1 - 9.81 / 60,
    'that thrust follows the supplied controller ray, including its vertical aim');
}

// Flying uses the same gentle 0.3/s horizontal resistance as a board-speed dismount; gravity independently bends
// the trajectory back toward the snow.
{
  const walker = flyingWalker(false);
  for (let i = 0; i < 18; i++) walker.step(1 / 60, { ...still, moveY: 1 });
  const coastSpeed = -walker.velocity().z;
  const beforeReleaseY = walker.velocity().y;
  assert.ok(coastSpeed > 2, `directional thrust builds forward speed (${coastSpeed.toFixed(2)} m/s)`);
  for (let i = 0; i < 6; i++) walker.step(1 / 60, still);
  const expectedCoast = coastSpeed * Math.pow(1 - PLAYER_AIR_RESISTANCE / 60, 6);
  assert.ok(Math.abs(-walker.velocity().z - expectedCoast) < 1e-9,
    `released flight sheds horizontal momentum at ${PLAYER_AIR_RESISTANCE}/s`);
  assert.ok(walker.velocity().y < beforeReleaseY, 'while gravity keeps pulling the released flight downward');
  assert.ok(walker.isFlying(), 'the ballistic flight mode remains active through the released coast');
  for (let i = 0; i < 120; i++) walker.step(1 / 60, still);
  assert.ok(walker.isGrounded() && !walker.isFlying(), 'touchdown hands control back to ordinary walking');

  const capped = flyingWalker();
  capped.velocity().set(600, 1, 0);
  capped.step(1 / 60, still);
  assert.ok(Math.abs(Math.hypot(capped.velocity().x, capped.velocity().z)
    - SUPERMAN_MAX_HORIZONTAL_SPEED * SUPERMAN_CRUISE_SPEED_SCALE) < 1e-9,
  `cruise flight is capped at half of ${SUPERMAN_MAX_HORIZONTAL_SPEED} m/s`);
  const boostedCap = flyingWalker();
  boostedCap.velocity().set(600, 1, 0);
  boostedCap.step(1 / 60, { ...still, boost: true });
  assert.ok(Math.abs(Math.hypot(boostedCap.velocity().x, boostedCap.velocity().z)
    - SUPERMAN_MAX_HORIZONTAL_SPEED) < 1e-9,
  `Boost restores the full ${SUPERMAN_MAX_HORIZONTAL_SPEED} m/s cap`);
  assert.ok(!boostedCap.isFlightBoosting(), 'raising the cap alone is silent until directional thrust is applied');
}

// A fast diagonal descent must sweep its real trajectory. Resolving all horizontal travel at the opening height
// and only then probing vertically can bury the feet beneath a rising slope whose surface is already above the
// probe; this is the characteristic Superman landing tunnel.
{
  let terrainActive = false;
  const slopeNormal = new THREE.Vector3(-2, 1, 0).normalize();
  const slope = downwardGroundQuery((from, to): WalkGround | null => {
    if (!terrainActive) return null;
    const delta = to.clone().sub(from);
    const denominator = delta.y - 2 * delta.x;
    if (Math.abs(denominator) < 1e-9) return null;
    const t = (2 * from.x - from.y) / denominator; // segment intersection with y = 2x
    if (t < 0 || t > 1) return null;
    return { y: from.y + delta.y * t, normal: slopeNormal };
  });
  const walker = createWalker({ ground: slope, oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 10, 0), new THREE.Vector3(200, -200, 0));
  terrainActive = true;
  walker.step(0.05, still);
  assert.ok(walker.isGrounded(), 'a high-speed diagonal Superman descent lands instead of crossing the slope');
  assert.ok(Math.abs(walker.position().y - 2 * walker.position().x) < 1e-6,
    `the swept landing stops on the slope (at ${walker.position().toArray().map(n => n.toFixed(3)).join(', ')})`);
  assert.ok(walker.position().x > 3 && walker.position().x < 4,
    'the landing occurs at the trajectory intersection rather than snapping to its buried destination');
}

// Terrain met from the side is a barrier, not a floor. The swept cast used to run only on descending chords
// and keep only standable hits, so a Superman climb crossing a cliff face was never even tested — the flyer
// passed straight through the mountain. A crossed face now stops the flight on its near side and keeps only
// the velocity running along it, without becoming a landing.
{
  const wallX = 5;
  const cliffQuery = downwardGroundQuery((from, to): WalkGround | null => {
    const delta = to.clone().sub(from);
    // the cliff: the plane x = wallX, crossed travelling +X, reported with its real hit point
    if (from.x < wallX && to.x > wallX) {
      const point = from.clone().addScaledVector(delta, (wallX - from.x) / delta.x);
      return { y: point.y, normal: new THREE.Vector3(-1, 0, 0), point };
    }
    // the flat approach floor
    if (from.y >= 0 && to.y <= 0) return { y: 0, normal: new THREE.Vector3(0, 1, 0) };
    return null;
  });
  const walker = createWalker({ ground: cliffQuery, oobFloorY: -100 });
  walker.placeAt(new THREE.Vector3(0, 5, 0), new THREE.Vector3(30, 10, 0));
  for (let i = 0; i < 30; i++) walker.step(1 / 60, still);
  assert.ok(walker.position().x < wallX,
    `an ascending flight stops at the cliff face instead of tunnelling (x ${walker.position().x.toFixed(3)})`);
  assert.ok(walker.position().x > wallX - 0.6, 'on its near side, not far short of it');
  assert.ok(Math.abs(walker.velocity().x) < 1e-9, 'the into-face speed is consumed by the stop');
  assert.ok(!walker.isGrounded(), 'and a wall strike while rising is not read as a landing');
  for (let i = 0; i < 300; i++) walker.step(1 / 60, still);
  assert.ok(walker.isGrounded() && walker.position().x < wallX && Math.abs(walker.position().y) < 1e-6,
    'the blocked flyer then falls back to the floor on the near side of the cliff');
}

// ---------------------------------------------------------------------------------------------------------
// Head steer, in the ride model itself.

const keys = { left: false, right: false, tuck: false, brake: false, boost: false };
const stick = { active: false, x: 0, airX: 0 };

function floor(): THREE.Mesh {
  const extent = 2000;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -extent, 0, -extent, -extent, 0, extent, extent, 0, -extent,
    extent, 0, -extent, -extent, 0, extent, extent, 0, extent,
  ], 3));
  const mesh = new THREE.Mesh(geometry);
  mesh.updateMatrixWorld(true);
  return mesh;
}

/** A rider already up to speed on level snow, facing +Z, optionally head-steering at `gaze`. */
function riding(gaze?: () => THREE.Vector3 | null, rails?: ReturnType<typeof createGrindRails>) {
  const model = createRideModel({
    spawn: new THREE.Vector3(0, 1, 0), heading: new THREE.Vector3(0, 0, 1), terrain: floor(),
    surfaceOf: () => 1, rails, oobFloorY: -100, keys, stick, gaze, onRespawn: () => {},
  });
  model.start();
  model.st.pos.set(0, -groundRestDepth(SNOW), 0);
  model.st.vel.set(0, 0, 16);
  model.st.fwd.set(0, 0, 1);
  model.st.contactN.set(0, 1, 0);
  model.st.boardUp.set(0, 1, 0);
  model.st.grounded = true;
  return model;
}

const headingDeg = (m: ReturnType<typeof riding>) =>
  THREE.MathUtils.radToDeg(Math.atan2(m.st.fwd.x, m.st.fwd.z));

// The claim: look somewhere and the board goes there. 40° off to one side, and the heading arrives on the gaze
// and STOPS there rather than sailing past it or oscillating around it.
{
  const gaze = new THREE.Vector3(Math.sin(0.7), 0, Math.cos(0.7)).normalize(); // ~40° to +X of travel
  const model = riding(() => gaze);
  let peakLean = 0;
  for (let i = 0; i < 240; i++) { model.step(1 / 60); peakLean = Math.max(peakLean, Math.abs(model.st.lean)); }
  const gazeDeg = THREE.MathUtils.radToDeg(Math.atan2(gaze.x, gaze.z));
  const settled = headingDeg(model);
  assert.ok(Math.abs(settled - gazeDeg) < 12,
    `the heading arrives on the gaze (${settled.toFixed(1)}° vs the gaze's ${gazeDeg.toFixed(1)}°)`);
  assert.ok(model.st.vel.x > 1, 'and the rider is actually travelling that way, not just pointing');
  // The gaze drives the shared input→lean slew, which is what banks the deck and supplies the carve's force.
  // Without it a head turn only aims the nose, and on ice nothing would bend the path at all. Measured at its
  // PEAK, because the lean is supposed to ebb: it is referenced to travel, so it fades as the carve brings the
  // path round onto the gaze, exactly as a stick turn's does when you let the stick go.
  assert.ok(peakLean > 0.1, `the head turn EDGES the board (peak lean ${peakLean.toFixed(3)})`);
  assert.ok(Math.abs(model.st.lean) < peakLean * 0.5,
    `...and the edge comes off as the path arrives (settled ${model.st.lean.toFixed(3)})`);
}

// Looking where you are already going is not a steering input. A glance inside the deadzone must not walk the
// board round the mountain a degree at a time.
{
  const model = riding(() => new THREE.Vector3(Math.sin(0.05), 0, Math.cos(0.05)).normalize()); // ~3°, inside 5°
  const before = headingDeg(model);
  for (let i = 0; i < 240; i++) model.step(1 / 60);
  assert.ok(Math.abs(headingDeg(model) - before) < 1.5,
    `a glance inside the deadzone holds the line (drifted ${(headingDeg(model) - before).toFixed(2)}°)`);
  assert.ok(Math.abs(model.st.lean) < 0.02, 'and edges nothing');
}

// The gate that keeps every non-headset ride on its retail traces: with no gaze the model is the model it was.
{
  const model = riding();
  const before = headingDeg(model);
  for (let i = 0; i < 240; i++) model.step(1 / 60);
  assert.ok(Math.abs(headingDeg(model) - before) < 0.5,
    'a ride that hands in no gaze steers on nothing but its stick');
  assert.equal(model.st.seatYaw, 0, 'and banks no seat carry, because no thumb turned it');
}

// The seat carry is the STICK's intent and only the stick's: a gaze that dragged the view would read as a
// further gaze offset next frame and spin the wearer, which is the classic VR feedback loop. On snow the WebXR
// seat receives exactly one quarter of the old/full carry, after the same yaw clamp.
{
  const gaze = new THREE.Vector3(Math.sin(0.7), 0, Math.cos(0.7)).normalize();
  const looked = riding(() => gaze);
  for (let i = 0; i < 120; i++) looked.step(1 / 60);
  assert.equal(looked.st.seatYaw, 0, 'a head-steered turn leaves the seat pinned');

  const fullCarryReference = riding();
  const thumbed = riding(() => null);
  stick.active = true; stick.x = 1;
  fullCarryReference.step(1 / 60);
  thumbed.step(1 / 60);
  stick.active = false; stick.x = 0;
  assert.ok(Math.abs(thumbed.st.seatYaw) > 1e-6,
    `a grounded stick turn still carries the headset (${thumbed.st.seatYaw.toFixed(6)} rad)`);
  assert.ok(Math.abs(thumbed.st.seatYaw / fullCarryReference.st.seatYaw - 0.25) < 1e-9,
    'grounded WebXR stick-to-view carry is exactly 25% after the retail yaw clamp');
  assert.ok(Math.sign(thumbed.st.seatYaw) === Math.sign(headingDeg(thumbed)) || headingDeg(thumbed) === 0,
    'and carries it the way the board actually turned');
}

// Airborne, the gaze aims the deck at the air rate and stops on arrival — the landing bearing is what you were
// looking at, which is the point of being able to look at it.
{
  const gaze = new THREE.Vector3(1, 0, 0);
  const model = riding(() => gaze);
  model.st.grounded = false;
  model.st.pos.y += 6;
  model.st.vel.set(0, 6, 16);
  for (let i = 0; i < 40; i++) model.step(1 / 60);
  const aimed = headingDeg(model);
  assert.ok(Math.abs(aimed - 90) < 10, `the air heading turns onto the gaze (got ${aimed.toFixed(1)}°)`);
  for (let i = 0; i < 40; i++) model.step(1 / 60);
  assert.ok(Math.abs(headingDeg(model) - 90) < 10, 'and stops there instead of spinning past it');
}

// Stick spin in air keeps full view carry and owns heading over gaze while held. Without that ownership the head
// follower turns back toward a still-forward headset at the same 270°/s and cancels the spin tick-for-tick.
{
  const gaze = new THREE.Vector3(0, 0, 1);
  const model = riding(() => gaze);
  model.st.grounded = false;
  model.st.pos.y += 6;
  model.st.vel.set(0, 6, 16);
  stick.active = true; stick.x = 1; stick.airX = 1;
  model.step(1 / 60);
  stick.active = false; stick.x = 0; stick.airX = 0;
  const boardYaw = headingDeg(model);
  const seatYaw = THREE.MathUtils.radToDeg(model.st.seatYaw);
  assert.ok(Math.abs(boardYaw) > 4,
    `air stick spin survives a forward headset gaze (${boardYaw.toFixed(3)}° after one tick)`);
  assert.ok(Math.abs(boardYaw - seatYaw) < 1e-6,
    `air stick yaw carries the headset at 100% (${boardYaw.toFixed(3)}° board / ${seatYaw.toFixed(3)}° view)`);
}

// On a rail every input path follows the shipped Unity presentation: steering owns continuous deck yaw at the
// shared 270°/s air rate while travel stays on the spline. WebXR additionally carries the stick into the
// upright view and centring hands the deck back to head steering without rotating that seat.
{
  const y = -groundRestDepth(SNOW);
  const segment: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(0, y, -100), new THREE.Vector3(0, y, -33),
    new THREE.Vector3(0, y, 33), new THREE.Vector3(0, y, 100),
  ];
  const rails = createGrindRails([{ surf: 1, seat: 0, segments: [segment] }]);
  assert.equal(rails.query(new THREE.Vector3(0, y, 0))?.seat, 0,
    'an authored-contact rail carries no implicit height above its spline');
  const gaze = new THREE.Vector3(0, 0, 1);

  const fine = riding(() => gaze, rails);
  stick.active = true; stick.x = precisionRideAxis(0.3); // deliberately below HEAD_STICK_OVERRIDE after x²
  fine.step(1 / 60);
  stick.active = false; stick.x = 0;
  assert.ok(Math.abs(fine.st.pos.y - y) < 1e-6,
    'a zero-seat rail puts the deck origin directly on its authored curve');
  assert.ok(Math.abs(fine.st.seatYaw) > 1e-8,
    'a gentle post-dead-zone precision value still owns rail steering before the curve magnitude threshold');

  const pipeRails = createGrindRails([{ surf: 1, seat: RAIL_TUBE_RADIUS, segments: [segment] }]);
  const crowned = riding(undefined, pipeRails);
  crowned.step(1 / 60);
  assert.equal(crowned.st.railIdx, 0, 'the generated-pipe fixture catches its rail');
  assert.ok(Math.abs(crowned.st.pos.y - (y + RAIL_TUBE_RADIUS)) < 1e-6,
    'a generated pipe seats the deck one tube radius above its centreline');

  const model = riding(() => gaze, rails);
  stick.active = true; stick.x = 1;
  // A third of a second, not a full one: at the shared 270°/s air rate a full second wraps railYaw back to
  // ±90° and would let the old 90°/s rate pass the same assertion.
  for (let i = 0; i < 20; i++) model.step(1 / 60);
  stick.active = false; stick.x = 0;
  assert.equal(model.st.railIdx, 0, 'the fixture is grinding the rail');
  assert.ok(Math.abs(Math.abs(model.st.railYaw) - 90) < 0.1,
    `a third-second of hard rail stick covers 90° at the shared 270°/s air rate (got ${model.st.railYaw.toFixed(3)}°)`);
  assert.ok(Math.abs(THREE.MathUtils.radToDeg(model.st.seatYaw) - model.st.railYaw) < 1e-6,
    'rail stick yaw carries the WebXR seat at 100%');

  const pinnedSeat = model.st.seatYaw;
  for (let i = 0; i < 60; i++) model.step(1 / 60);
  assert.ok(Math.abs(model.st.railYaw) <= 5.1,
    `a centred rail stick hands the deck back to head steering's 5° dead zone (remaining ${model.st.railYaw.toFixed(3)}°)`);
  assert.equal(model.st.seatYaw, pinnedSeat, 'rail head steering leaves the headset seat pinned');

  const desktop = riding(undefined, rails);
  keys.right = true;
  let desktopTurn = 0;
  const previousFacing = desktop.st.fwd.clone();
  for (let i = 0; i < 250; i++) {
    desktop.step(1 / 60);
    desktopTurn += THREE.MathUtils.radToDeg(previousFacing.angleTo(desktop.st.fwd));
    previousFacing.copy(desktop.st.fwd);
  }
  keys.right = false;
  assert.equal(desktop.st.railIdx, 0, 'the desktop 360 fixture remains on the rail');
  assert.ok(desktopTurn > 360,
    `desktop rail steering passes a full 360° without clamping (turned ${desktopTurn.toFixed(1)}°)`);
}

console.log('XR PLAY: PASS');
