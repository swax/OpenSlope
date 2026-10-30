// tier: fast

import assert from 'node:assert/strict';
import { createRidePointerLock } from '../src/app/ride/pointer-lock';

class FakeWindow extends EventTarget {
  matchMedia() {
    return { matches: true };
  }
}

class FakeDocument extends EventTarget {
  pointerLockElement: Element | null = null;
  visibilityState: DocumentVisibilityState = 'visible';
  exits = 0;
  defaultView = new FakeWindow() as unknown as Window;

  exitPointerLock() {
    this.exits++;
    this.pointerLockElement = null;
    this.dispatchEvent(new Event('pointerlockchange'));
  }
}

class FakeTarget extends EventTarget {
  requests = 0;
  constructor(readonly ownerDocument: FakeDocument) {
    super();
  }
  requestPointerLock() {
    this.requests++;
    this.ownerDocument.pointerLockElement = this as unknown as Element;
    this.ownerDocument.dispatchEvent(new Event('pointerlockchange'));
  }
}

function keyboard(type: 'keydown', key: string) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, { key: { value: key }, repeat: { value: false } });
  return event;
}

function mouseButton(type: 'mousedown' | 'mouseup', button: number) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, 'button', { value: button });
  return event;
}

function mouseMove(x: number, y: number) {
  const event = new Event('mousemove');
  Object.defineProperties(event, { movementX: { value: x }, movementY: { value: y } });
  return event;
}

const doc = new FakeDocument();
const target = new FakeTarget(doc);
const moves: [number, number][] = [];
const turns: boolean[] = [];
const lock = createRidePointerLock({
  target: target as unknown as HTMLElement,
  onMove: (x, y, turnAvatar) => {
    moves.push([x, y]);
    turns.push(turnAvatar);
  },
});

lock.attach();
assert.equal(target.requests, 0, 'starting in third person leaves the cursor visible');
assert.equal(lock.locked, false);
doc.dispatchEvent(mouseMove(4, 2));
assert.deepEqual(moves, [], 'ordinary hover movement does not steer the ride');
target.dispatchEvent(mouseButton('mousedown', 2));
assert.equal(target.requests, 1, 'pressing right mouse captures the cursor');
assert.equal(lock.locked, true);
doc.dispatchEvent(mouseMove(900, -700));
assert.deepEqual(moves, [], 'the synthetic first delta after capture is ignored');
doc.dispatchEvent(mouseMove(7, -3));
assert.deepEqual(moves, [[7, -3]], 'movement looks around while right mouse is held');
assert.equal(turns.at(-1), false, 'right drag only orbits the camera');
doc.dispatchEvent(mouseMove(161, -3));
doc.dispatchEvent(mouseMove(Number.POSITIVE_INFINITY, 1));
assert.deepEqual(moves, [[7, -3]], 'invalid and implausible one-event spikes cannot snap the view');
doc.dispatchEvent(mouseButton('mouseup', 2));
assert.equal(doc.exits, 1, 'releasing right mouse immediately exposes the cursor');
assert.equal(lock.locked, false);
doc.dispatchEvent(mouseMove(4, 2));
assert.deepEqual(moves, [[7, -3]], 'movement stops steering after right mouse is released');

lock.setFirstPerson(true);
assert.equal(target.requests, 2, 'entering first person captures the cursor immediately');
assert.equal(lock.firstPerson, true);
doc.dispatchEvent(mouseMove(40, 20));
assert.deepEqual(moves, [[7, -3]], 'first-person capture also suppresses its first delta');
doc.dispatchEvent(mouseMove(-5, 6));
assert.deepEqual(
  moves,
  [
    [7, -3],
    [-5, 6],
  ],
  'captured first-person movement looks around',
);

const firstPersonEscape = keyboard('keydown', 'Escape');
doc.dispatchEvent(firstPersonEscape);
assert.equal(doc.exits, 2, 'Escape exposes the cursor in first person');
assert.equal(firstPersonEscape.defaultPrevented, true, 'releasing first-person capture does not also exit the ride');
target.dispatchEvent(mouseButton('mousedown', 0));
assert.equal(target.requests, 3, 'any viewport click recaptures first person');
doc.dispatchEvent(mouseMove(30, 0));
doc.defaultView!.dispatchEvent(new Event('focus'));
doc.dispatchEvent(mouseMove(-120, 0));
assert.deepEqual(
  moves,
  [
    [7, -3],
    [-5, 6],
  ],
  'the first delta after recapture or refocus is ignored',
);
doc.dispatchEvent(mouseMove(3, 2));
assert.deepEqual(
  moves,
  [
    [7, -3],
    [-5, 6],
    [3, 2],
  ],
  'ordinary movement resumes immediately after refocus',
);
doc.dispatchEvent(mouseButton('mouseup', 0));
assert.equal(lock.locked, true, 'releasing a first-person click keeps the cursor captured');
doc.dispatchEvent(mouseButton('mouseup', 2));
assert.equal(lock.locked, true, 'RMB release also keeps first-person capture');

lock.setFirstPerson(false);
assert.equal(doc.exits, 3, 'entering third person exposes the cursor');
assert.equal(lock.firstPerson, false);

target.dispatchEvent(mouseButton('mousedown', 2));
const escape = keyboard('keydown', 'Escape');
doc.dispatchEvent(escape);
assert.equal(doc.exits, 4, 'Escape can break third-person capture before right mouse is released');
assert.equal(escape.defaultPrevented, true, 'the release press does not also exit the ride');
const secondEscape = keyboard('keydown', 'Escape');
doc.dispatchEvent(secondEscape);
assert.equal(secondEscape.defaultPrevented, false, 'a second Escape remains available to exit Test play');
doc.dispatchEvent(mouseButton('mouseup', 2));

target.dispatchEvent(mouseButton('mousedown', 2));
lock.detach();
assert.equal(doc.exits, 5, 'stopping the ride always returns the cursor to the editor');
target.dispatchEvent(mouseButton('mousedown', 2));
assert.equal(target.requests, 5, 'the stopped ride no longer re-captures on a click');

// RMB reports a held look on its own, so the chase camera can tell a held look from a released one — including
// where capture is unavailable and the editor's fallback move path is what steers.
{
  const coarseDoc = new FakeDocument();
  (coarseDoc.defaultView as unknown as FakeWindow).matchMedia = () => ({ matches: false });
  const coarseTarget = new FakeTarget(coarseDoc);
  const coarse = createRidePointerLock({ target: coarseTarget as unknown as HTMLElement, onMove: () => {} });
  coarse.attach();
  assert.equal(coarse.supported, false);
  coarseTarget.dispatchEvent(mouseButton('mousedown', 2));
  assert.equal(coarse.looking, true, 'RMB down holds the look even without pointer capture');
  assert.equal(coarseTarget.requests, 0, 'an unsupported device is never asked to capture');
  coarseDoc.dispatchEvent(mouseButton('mouseup', 2));
  assert.equal(coarse.looking, false, 'RMB up lets the look go');
  coarse.detach();
}

// Chording look buttons must retain capture until the last release and change the gesture immediately.
{
  const dragDoc = new FakeDocument();
  const dragTarget = new FakeTarget(dragDoc);
  const bodyTurns: boolean[] = [];
  const drag = createRidePointerLock({
    target: dragTarget as unknown as HTMLElement,
    onMove: (_x, _y, turn) => bodyTurns.push(turn),
  });
  drag.attach();
  dragTarget.dispatchEvent(mouseButton('mousedown', 0));
  assert.equal(drag.locked, true, 'left drag captures the cursor');
  dragDoc.dispatchEvent(mouseMove(0, 0));
  dragDoc.dispatchEvent(mouseMove(5, 0));
  assert.deepEqual(bodyTurns, [true], 'left drag turns the avatar');
  dragTarget.dispatchEvent(mouseButton('mousedown', 2));
  dragDoc.dispatchEvent(mouseButton('mouseup', 0));
  assert.equal(drag.locked, true, 'right remains captured after releasing left');
  dragDoc.dispatchEvent(mouseMove(5, 0));
  assert.deepEqual(bodyTurns, [true, false], 'the remaining right drag only orbits');
  dragDoc.dispatchEvent(mouseButton('mouseup', 2));
  assert.equal(drag.locked, false, 'the final release exposes the cursor');
  assert.equal(drag.looking, false);
  drag.detach();
}

{
  const recordingDoc = new FakeDocument();
  const recordingTarget = new FakeTarget(recordingDoc);
  let saves = 0;
  const recordingLock = createRidePointerLock({
    target: recordingTarget as unknown as HTMLElement,
    onMove() {},
    onEscape() {
      saves++;
      return true;
    },
  });
  recordingLock.attach();
  recordingLock.setFirstPerson(true);
  assert(recordingLock.locked);
  recordingDoc.dispatchEvent(keyboard('keydown', 'Escape'));
  assert.equal(saves, 1, 'A recording handles the first Escape while captured');
  assert.equal(recordingLock.locked, false);
  recordingLock.detach();
}

console.log('pointer lock checks passed');
