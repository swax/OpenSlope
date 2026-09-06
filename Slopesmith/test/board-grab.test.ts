// tier: fast

// The board IN YOUR HAND (`app/ride/board-grab.ts`) and the THROW it leaves with (`board-coast.throwFrom`).
//
// Every pickup enters one controller-relative palm-edge hold: right hand/right edge, left hand/left edge.
// Physical grabs keep the touched tail-to-nose location while a summon uses the waist. Everything after that
// follows rigidly, and a throw leaves with the arc and tumble the hand was actually swinging through.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  CARRY_TOWARD_CONTROLLER, CARRY_TOWARD_PLAYER,
  createBoardGrab, deckGrabDistance, deckRayDistance, deckWithinReach, handBehindHead, handGripPoint,
  heldDeckEdgePoint, heldDeckRotation, nearestDeckPoint,
} from '../src/app/ride/board-grab';
import { createBoardCoast } from '../src/app/ride/board-coast';
import { createBoard } from '../src/app/ride/gear';
import { downwardGroundQuery, type WalkGround } from '../src/app/ride/xr/walk';
import {
  GRAB_HAND_FORWARD, GRAB_REACH, HAND_TRANSFER_REACH, THROW_MAX_SPEED, THROW_MAX_SPIN,
} from '../src/app/ride/physics-tuning';

const snowboard = createBoard('snowboard');
const skis = createBoard('skis');
const BOX = snowboard.grabBox;
const FLAT = new THREE.Quaternion();

/** A hand at a world point with its canonical frame level: `+Y` toward the fingers. */
function hand(x: number, y: number, z: number, rotation = FLAT) {
  return { position: new THREE.Vector3(x, y, z), quaternion: rotation.clone() };
}

/** Where every held side edge is seated relative to a tracked palm. */
function carryTarget(at: ReturnType<typeof hand>) {
  return at.position.clone()
    .add(new THREE.Vector3(0, -CARRY_TOWARD_PLAYER, -CARRY_TOWARD_CONTROLLER)
      .applyQuaternion(at.quaternion));
}

// Both gears describe an outline a hand can reach for, and both are the size of the thing they draw.
{
  assert.ok(BOX.half.z > 0.9 && BOX.half.z < 1, `a 186 cm deck reaches ~0.93 m each way (${BOX.half.z})`);
  assert.ok(BOX.half.x > 0.2 && BOX.half.x < 0.22, `and ~21 cm across (${BOX.half.x})`);
  assert.ok(skis.grabBox.half.z > BOX.half.z, 'a 204 cm ski is the longer outline of the two');
  assert.ok(skis.grabBox.center.z > 0.05,
    'and its box sits forward of the boot, because that is where a ski actually is');
}

// The fist is a little forward of the tracked wrist, and that — not the wrist — is what the deck is measured to.
{
  const grip = handGripPoint(new THREE.Vector3(0, 1, 0), FLAT);
  assert.ok(Math.abs(grip.y - (1 + GRAB_HAND_FORWARD)) < 1e-9,
    'the grip point sits along the canonical hand frame\'s finger axis');
}

// Nearest point: reach for the nose and you are nearest the nose, not the middle of the deck.
{
  const deck = new THREE.Vector3(0, 0, 0);
  const nose = nearestDeckPoint(BOX, deck, FLAT, new THREE.Vector3(0, 0.05, 4));
  assert.ok(Math.abs(nose.z - BOX.half.z) < 1e-9, `a hand out past the nose is nearest the nose (${nose.z})`);
  const waist = nearestDeckPoint(BOX, deck, FLAT, new THREE.Vector3(1, 0.05, 0));
  assert.ok(Math.abs(waist.x - BOX.half.x) < 1e-9, 'a hand out to the side is nearest the edge beside it');
  assert.ok(Math.abs(waist.z) < 1e-9, '...at the waist it is actually beside');
  const inside = nearestDeckPoint(BOX, deck, FLAT, new THREE.Vector3(0, BOX.center.y, 0.2));
  assert.ok(inside.distanceTo(new THREE.Vector3(0, BOX.center.y, 0.2)) < 1e-9,
    'a hand already inside the outline is nearest to itself');

  // ...and the box turns with the deck, so a board standing on its tail is reached for end-on.
  const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const tip = nearestDeckPoint(BOX, deck, upright, new THREE.Vector3(0, 4, 0));
  assert.ok(Math.abs(tip.y - BOX.half.z) < 1e-6, `a deck stood on end is nearest at its raised tip (${tip.y})`);
}

// Reach is measured to the DECK, not to its origin, so the nose of a long board is grabbable from its nose.
{
  const deck = new THREE.Vector3(0, 0, 0);
  const atNose = hand(0, 0.05, BOX.half.z + 0.2);
  assert.ok(deckWithinReach(BOX, deck, FLAT, atNose.position, atNose.quaternion),
    'a hand 20 cm off the nose of a 1.86 m deck is within reach of it');
  assert.ok(deckGrabDistance(BOX, deck, FLAT, atNose.position, atNose.quaternion) < 0.25,
    'and is measured against the outline rather than the middle');
  const wayOff = hand(0, 0.05, BOX.half.z + GRAB_REACH + 0.3);
  assert.ok(!deckWithinReach(BOX, deck, FLAT, wayOff.position, wayOff.quaternion),
    'well past it is not');
  // Two reaches, and the pass is the tighter: taking a deck off the snow is an arm's length, taking it out of
  // the other hand means being on it.
  assert.ok(HAND_TRANSFER_REACH < GRAB_REACH, 'a pass asks for a closer hand than a pick-up does');
  const armsLength = hand(0, 0.05, BOX.half.z + 0.8);
  assert.ok(deckWithinReach(BOX, deck, FLAT, armsLength.position, armsLength.quaternion),
    'a deck 80 cm off the fingertips can still be picked up');
  assert.ok(!deckWithinReach(BOX, deck, FLAT, armsLength.position, armsLength.quaternion,
    HAND_TRANSFER_REACH), '...but not taken out of the other hand from there');
}

// ---------------------------------------------------------------------------------------------------------
// POINTING at the deck — the trigger's target, and the other half of the two-button split. A ray, not a
// proximity, so standing in one place the trigger and the grip can mean two different things.

{
  const deck = new THREE.Vector3(0, 0, 6);
  const from = new THREE.Vector3(0, 1.5, 0);
  const at = (x: number, y: number, z: number) =>
    new THREE.Ray(from.clone(), new THREE.Vector3(x, y, z).sub(from).normalize());

  const centre = from.distanceTo(deck);
  const straight = deckRayDistance(BOX, deck, FLAT, at(0, 0, 6));
  assert.ok(straight !== null, 'a ray aimed down at the deck hits it');
  // The reported distance is where the ray ENTERS the outline, which on a 1.86 m board seen down its length is
  // most of a metre before its middle — the near tip is what you are pointing at, and it is what you get.
  assert.ok(straight! < centre && straight! > centre - 1.2,
    `at its near end rather than its centre (${straight!.toFixed(2)} m of ${centre.toFixed(2)})`);
  assert.ok(deckRayDistance(BOX, deck, FLAT, at(0, 0, 5.4)) !== null,
    'and anywhere along its length counts, not just its middle');
  assert.equal(deckRayDistance(BOX, deck, FLAT, at(4, 0, 6)), null, 'a ray well off to one side misses');
  assert.equal(deckRayDistance(BOX, deck, FLAT, at(0, 3, 6)), null, 'and so does one over the top of it');

  // The outline turns with the deck, so a board propped on its tail is pointed at where it is STANDING — and a
  // ray that finds it there finds nothing where a board lying flat on the snow would have been.
  const upright = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const standing = new THREE.Vector3(0, BOX.half.z, 6);
  const chestHigh = new THREE.Ray(new THREE.Vector3(0, 1.2, 0), new THREE.Vector3(0, 0, 1));
  assert.ok(deckRayDistance(BOX, standing, upright, chestHigh) !== null,
    'a deck propped on its tail is pointed at at chest height');
  assert.equal(deckRayDistance(BOX, deck, FLAT, chestHigh), null,
    '...where the same ray finds nothing at all if it is lying flat instead');

  // Padded, because a board is 14 cm thick and pointing at one is aiming, not threading a needle.
  const grazing = new THREE.Ray(new THREE.Vector3(0, 0.2, 0), new THREE.Vector3(0, 0, 1));
  assert.equal(deckRayDistance(BOX, deck, FLAT, grazing, 0), null,
    'a ray 4 cm over the topsheet misses the exact outline');
  assert.ok(deckRayDistance(BOX, deck, FLAT, grazing) !== null, 'and is a hit on the aimed one');
}

// The sword draw: behind the head, up near the shoulder, close to it. Nothing else fires it.
{
  const head = new THREE.Vector3(0, 1.6, 0);
  const facing = new THREE.Quaternion(); // a viewer looks down its own −Z, so "behind" is +Z
  assert.ok(handBehindHead(head, facing, new THREE.Vector3(0.2, 1.5, 0.3)),
    'a hand up behind the shoulder is the summon');
  assert.ok(!handBehindHead(head, facing, new THREE.Vector3(0.2, 1.5, -0.3)),
    'a hand out in FRONT is not — which is the sign the whole gesture turns on');
  assert.ok(!handBehindHead(head, facing, new THREE.Vector3(0.2, 1.0, 0.3)),
    'a hand behind the hips is not: only a reach up toward the shoulder blades');
  assert.ok(!handBehindHead(head, facing, new THREE.Vector3(0.2, 1.5, 0.9)),
    'nor an arm trailing a metre behind you');

  // Looking DOWN must not turn "behind me" into "below me", or glancing at your own board would summon.
  const lookingDown = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2.2);
  assert.ok(!handBehindHead(head, lookingDown, new THREE.Vector3(0, 1.2, 0)),
    'a hand dropped in front while looking at your feet is not a reach behind your head');
  assert.ok(handBehindHead(head, lookingDown, new THREE.Vector3(0, 1.5, 0.3)),
    '...and the real gesture still works while looking down');
}

// ---------------------------------------------------------------------------------------------------------
// The grab itself: always re-posed onto the hand-appropriate edge, at the touched tail-to-nose location.

{
  const grab = createBoardGrab();
  // A deck lying at an angle, and a hand off to one side of it — the ordinary walk-up-and-take-it case.
  const deckPosition = new THREE.Vector3(2, 0, 5);
  const deckRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.9, -0.3));
  const at = hand(2.5, 0.4, 5.2, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.4, 0)));

  const touchedLocal = handGripPoint(at.position, at.quaternion).sub(deckPosition)
    .applyQuaternion(deckRotation.clone().invert());
  const touchedAlong = THREE.MathUtils.clamp(
    touchedLocal.z, BOX.center.z - BOX.half.z, BOX.center.z + BOX.half.z,
  );
  grab.grab('right', at.position, at.quaternion, deckPosition, deckRotation, BOX);
  assert.equal(grab.hand, 'right', 'the grip that closed is the hand that has it');

  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  grab.follow(at.position, at.quaternion, 1 / 72, position, rotation);
  assert.ok(rotation.angleTo(heldDeckRotation('right', at.quaternion)) < 1e-6,
    'a ground pickup enters the same upright controller-relative pose as every other carry');
  const heldEdge = heldDeckEdgePoint(BOX, 'right', touchedAlong).applyQuaternion(rotation).add(position);
  assert.ok(heldEdge.distanceTo(carryTarget(at)) < 1e-6,
    'the RIGHT hand holds the right edge at the touched tail-to-nose location');
  assert.ok(Math.abs(heldDeckEdgePoint(BOX, 'right', touchedAlong).z - touchedAlong) < 1e-9,
    'the contact location along the board survives the re-pose');

  // From here it is welded to the wrist: turn the hand and the chosen edge point follows rigidly.
  const turned = hand(2.5, 0.4, 5.2, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.6, 0.2)));
  grab.follow(turned.position, turned.quaternion, 1 / 72, position, rotation);
  assert.ok(heldDeckEdgePoint(BOX, 'right', touchedAlong).applyQuaternion(rotation).add(position)
    .distanceTo(carryTarget(turned)) < 1e-6,
  'the selected edge point stays in the palm pose however the wrist turns');
}

// ---------------------------------------------------------------------------------------------------------
// A pointer supplies its exact hit rather than borrowing the virtual wrist location, and left takes left edge.

{
  const grab = createBoardGrab();
  const deckPosition = new THREE.Vector3(3, 0.2, -2);
  const deckRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0.65, 0.2));
  const at = hand(2.7, 1.1, -1.8, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.4, 0.1)));
  const clickedAlong = BOX.center.z - BOX.half.z + 0.14;
  const clicked = new THREE.Vector3(BOX.center.x, BOX.center.y, clickedAlong)
    .applyQuaternion(deckRotation).add(deckPosition);

  grab.grab('left', at.position, at.quaternion, deckPosition, deckRotation, BOX, false, clicked);
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  grab.follow(at.position, at.quaternion, 1 / 72, position, rotation);
  const localEdge = heldDeckEdgePoint(BOX, 'left', clickedAlong);
  assert.ok(Math.abs(localEdge.x - (BOX.center.x + BOX.half.x)) < 1e-9,
    'the LEFT hand selects the visible left side edge');
  assert.ok(localEdge.applyQuaternion(rotation).add(position).distanceTo(carryTarget(at)) < 1e-6,
    'a pointer pickup seats that edge at the clicked tail-to-nose location, not at the virtual wrist');
}

// ---------------------------------------------------------------------------------------------------------
// The pass: the other hand takes its own side edge at the point along the board where it closed.

{
  const grab = createBoardGrab();
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const left = hand(-0.3, 1.2, 0.3);
  grab.grab('left', left.position, left.quaternion, new THREE.Vector3(-0.3, 1.0, 0.3), FLAT, BOX);
  grab.follow(left.position, left.quaternion, 1 / 72, position, rotation);

  // The free hand comes across to a point further along the deck.
  const right = hand(-0.25, 1.25, 0.8);
  assert.ok(deckWithinReach(BOX, position, rotation, right.position, right.quaternion),
    'the free hand can reach further down a deck the other one is already holding');
  const passLocal = handGripPoint(right.position, right.quaternion).sub(position)
    .applyQuaternion(rotation.clone().invert());
  const passAlong = THREE.MathUtils.clamp(
    passLocal.z, BOX.center.z - BOX.half.z, BOX.center.z + BOX.half.z,
  );
  grab.grab('right', right.position, right.quaternion, position, rotation, BOX);
  grab.follow(right.position, right.quaternion, 1 / 72, position, rotation);
  assert.equal(grab.hand, 'right', 'the pass hands it over');
  assert.ok(rotation.angleTo(heldDeckRotation('right', right.quaternion)) < 1e-6,
    'the new holding hand owns the standard carry orientation');
  assert.ok(heldDeckEdgePoint(BOX, 'right', passAlong).applyQuaternion(rotation).add(position)
    .distanceTo(carryTarget(right)) < 1e-6,
  'the right hand takes the right edge where it met the board along its length');
}

// ---------------------------------------------------------------------------------------------------------
// The throw: the arc and the tumble the hand was swinging through, capped so a flick cannot fire it away.

{
  const grab = createBoardGrab();
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const start = hand(0, 1.2, 0);
  grab.grab('right', start.position, start.quaternion, new THREE.Vector3(0, 1.1, 0), FLAT, BOX);
  // Swing the hand forward at 4 m/s for a fifth of a second, turning it as it goes.
  const dt = 1 / 72;
  for (let i = 1; i <= 15; i++) {
    const swung = hand(0, 1.2, i * 4 * dt,
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * dt * 3));
    grab.follow(swung.position, swung.quaternion, dt, position, rotation);
  }
  const thrown = grab.release();
  assert.ok(!grab.held, 'letting go lets go');
  assert.ok(thrown.velocity.z > 3 && thrown.velocity.z < 5,
    `the throw is the speed the hand was moving (${thrown.velocity.z.toFixed(2)} m/s)`);
  assert.ok(thrown.spin.length() > 60,
    `and carries the tumble the wrist was turning through (${thrown.spin.length().toFixed(0)}°/s)`);

  // A one-frame tracking spike cannot become the throw, and neither can a genuine hard flick uncapped.
  const flick = createBoardGrab();
  flick.grab('left', start.position, start.quaternion, new THREE.Vector3(0, 1.1, 0), FLAT, BOX);
  const spike = hand(0, 1.2, 40);
  flick.follow(start.position, start.quaternion, dt, position, rotation);
  flick.follow(spike.position, spike.quaternion, dt, position, rotation);
  const wild = flick.release();
  assert.ok(wild.velocity.length() <= THROW_MAX_SPEED + 1e-9,
    `a 2 900 m/s tracking spike leaves at the ${THROW_MAX_SPEED} m/s cap (${wild.velocity.length().toFixed(1)})`);
  assert.ok(wild.spin.length() <= THROW_MAX_SPIN + 1e-9, 'and its tumble is capped too');
}

// The recall: an immediate controller-relative edge catch from any distance, with no cross-map flight.
{
  const grab = createBoardGrab();
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const at = hand(0, 1.5, 0);
  const away = new THREE.Vector3(0, 0, 60); // a board abandoned sixty metres down the mountain
  const lying = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.1);
  const target = heldDeckRotation('right', at.quaternion);

  grab.grab('right', at.position, at.quaternion, away, lying, BOX, true);
  grab.follow(at.position, at.quaternion, 1 / 72, position, rotation);
  const fist = handGripPoint(at.position, at.quaternion);
  const palm = at.position;
  const expectedEdge = carryTarget(at);
  assert.ok(position.distanceTo(away) > 50, 'the first held frame has already snapped across the mountain');
  assert.ok(rotation.angleTo(target) < 1e-6, 'the first held frame is already in the ready carry orientation');
  const edge = heldDeckEdgePoint(BOX, 'right').applyQuaternion(rotation).add(position);
  assert.ok(edge.distanceTo(expectedEdge) < 1e-6,
    'the snowboard edge is exactly 2 in toward the controller and 1.5 in toward the player from the palm');
  assert.ok(edge.distanceTo(fist) > edge.distanceTo(palm),
    'the summoned edge remains behind the controller rather than drifting toward the ordinary forward fist point');
  const nose = new THREE.Vector3(0, 0, 1).applyQuaternion(rotation);
  const rightControllerUp = new THREE.Vector3(1, 0, 0).applyQuaternion(at.quaternion);
  assert.ok(nose.distanceTo(rightControllerUp) < 1e-6,
    'the board length follows the right controller up/down instead of pointing forward');
  const topsheet = new THREE.Vector3(0, 1, 0).applyQuaternion(rotation);
  const towardWearer = new THREE.Vector3(0, -1, 0).applyQuaternion(at.quaternion);
  assert.ok(topsheet.distanceTo(towardWearer) < 1e-6,
    'the quarter-turn leaves the snowboard topsheet facing the wearer');
  const centre = BOX.center.clone().applyQuaternion(rotation).add(position);
  const palmIn = new THREE.Vector3(0, 0, 1).applyQuaternion(at.quaternion);
  assert.ok(centre.clone().sub(edge).normalize().distanceTo(palmIn) < 1e-6,
    'the board extends inward from the caught edge instead of out past the hand');

  // The left hand is a mirrored frame. It catches the opposite local edge so the skis still extend inward, and
  // uses -X rather than +X for the same physical controller-button face.
  const skiGrab = createBoardGrab();
  skiGrab.grab('left', at.position, at.quaternion, away, lying, skis.grabBox, true);
  skiGrab.follow(at.position, at.quaternion, 1 / 72, position, rotation);
  const skiEdge = heldDeckEdgePoint(skis.grabBox, 'left').applyQuaternion(rotation).add(position);
  assert.ok(skiEdge.distanceTo(expectedEdge) < 1e-6,
    'the mirrored ski pair receives the same physical controller/player offsets');
  const leftControllerUp = new THREE.Vector3(-1, 0, 0).applyQuaternion(at.quaternion);
  assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(rotation).distanceTo(leftControllerUp) < 1e-6,
    'the mirrored ski length follows the left controller up/down as well');
  assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(rotation).distanceTo(towardWearer) < 1e-6,
    'the mirrored left-hand carry also leaves the ski fronts facing the wearer');
  const skiCentre = skis.grabBox.center.clone().applyQuaternion(rotation).add(position);
  assert.ok(skiCentre.clone().sub(skiEdge).normalize().distanceTo(palmIn) < 1e-6,
    'the skis also extend inward from the edge instead of outward past the hand');

  // A sixty-metre snap is not a throw the hand made, and must never leave as one.
  const settled = createBoardGrab();
  settled.grab('left', at.position, at.quaternion, away, lying, BOX, true);
  settled.follow(at.position, at.quaternion, 1 / 72, position, rotation);
  assert.equal(settled.release().velocity.length(), 0,
    'letting go of a board that just flew to you sets it down; it does not fire it back');
}

// Putting the deck back under the feet is not letting go of it: no throw comes out of a mount.
{
  const grab = createBoardGrab();
  const position = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const at = hand(0, 1.2, 0);
  grab.grab('right', at.position, at.quaternion, new THREE.Vector3(0, 1.1, 0), FLAT, BOX);
  grab.follow(at.position, at.quaternion, 1 / 72, position, rotation);
  grab.clear();
  assert.ok(!grab.held && grab.hand === null, 'a mount takes the deck out of the hand with nothing thrown');
}

// ---------------------------------------------------------------------------------------------------------
// And what the thrown deck then does, in the coast that receives it.

{
  const ground = downwardGroundQuery((from, to): WalkGround | null => {
    if (0 > from.y || 0 < to.y) return null;
    return { y: 0, normal: new THREE.Vector3(0, 1, 0) };
  });
  const coast = createBoardCoast({ ground, oobFloorY: -400 });
  coast.throwFrom(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 3, 12),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(400, 0, 0));
  assert.ok(coast.thrown, 'a released deck enters the coast as a throw');
  assert.equal(coast.vel.y, 3, 'an intentional upward hand throw retains its vertical velocity');

  const startUp = coast.up.clone();
  for (let i = 0; i < 6; i++) coast.step(1 / 60);
  assert.ok(coast.up.angleTo(startUp) > 0.2, 'which turns over as it flies rather than levelling out');

  let airborne = 0;
  while (coast.thrown && airborne < 5) { coast.step(1 / 60); airborne += 1 / 60; }
  assert.ok(!coast.thrown, 'the first touch of ground ends the flight');
  assert.ok(coast.pos.z > 8.5, `a throw keeps its whole arc rather than being scrubbed dry (${coast.pos.z.toFixed(1)} m)`);
  assert.ok(coast.up.y > 0, 'and a thrown board lands up, whatever way round the tumble left it');

  let settling = 0;
  while (coast.active && settling < 10) { coast.step(1 / 60); settling += 1 / 60; }
  assert.ok(!coast.active && coast.vel.length() === 0, 'then it slides and parks like any other loose deck');
}

// A deck jumped off (not thrown) has gentle 0.1/s air resistance; a thrown deck retains its complete ballistic
// speed as well as its tumble, so the thrown one still edges ahead.
{
  const ground = downwardGroundQuery((from, to): WalkGround | null =>
    (0 > from.y || 0 < to.y) ? null : { y: 0, normal: new THREE.Vector3(0, 1, 0) });
  const dropped = createBoardCoast({ ground, oobFloorY: -400 });
  dropped.launch(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 3, 12),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  assert.ok(!dropped.thrown, 'a jump-off is not a throw');
  const thrown = createBoardCoast({ ground, oobFloorY: -400 });
  thrown.throwFrom(new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 3, 12),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), new THREE.Vector3());
  for (let i = 0; i < 40; i++) { dropped.step(1 / 60); thrown.step(1 / 60); }
  assert.ok(thrown.pos.z > dropped.pos.z + 0.2,
    `the thrown deck sails and the dropped one drops (${thrown.pos.z.toFixed(1)} vs ${dropped.pos.z.toFixed(1)} m)`);
}

snowboard.dispose();
skis.dispose();
console.log('BOARD GRAB: PASS');
