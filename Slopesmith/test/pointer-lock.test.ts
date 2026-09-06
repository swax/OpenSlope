// tier: fast

import assert from 'node:assert/strict';
import { createRidePointerLock } from '../src/app/ride/pointer-lock';

class FakeWindow extends EventTarget {
  matchMedia() { return { matches: true }; }
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
  constructor(readonly ownerDocument: FakeDocument) { super(); }
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
const lock = createRidePointerLock({
  target: target as unknown as HTMLElement,
  onMove: (x, y) => moves.push([x, y]),
});

lock.attach();
assert.equal(target.requests, 0, 'starting in third person leaves the cursor visible');
assert.equal(lock.locked, false);
doc.dispatchEvent(mouseMove(4, 2));
assert.deepEqual(moves, [], 'ordinary hover movement does not steer the ride');
target.dispatchEvent(mouseButton('mousedown', 0));
assert.equal(target.requests, 0, 'left mouse does not capture the cursor');

target.dispatchEvent(mouseButton('mousedown', 2));
assert.equal(target.requests, 1, 'pressing right mouse captures the cursor');
assert.equal(lock.locked, true);
doc.dispatchEvent(mouseMove(900, -700));
assert.deepEqual(moves, [], 'the synthetic first delta after capture is ignored');
doc.dispatchEvent(mouseMove(7, -3));
assert.deepEqual(moves, [[7, -3]], 'movement looks around while right mouse is held');
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
assert.deepEqual(moves, [[7, -3], [-5, 6]], 'captured first-person movement looks around');

const firstPersonEscape = keyboard('keydown', 'Escape');
doc.dispatchEvent(firstPersonEscape);
assert.equal(doc.exits, 2, 'Escape exposes the cursor in first person');
assert.equal(firstPersonEscape.defaultPrevented, true, 'releasing first-person capture does not also exit the ride');
target.dispatchEvent(mouseButton('mousedown', 0));
assert.equal(target.requests, 3, 'any viewport click recaptures first person');
doc.dispatchEvent(mouseMove(30, 0));
doc.defaultView!.dispatchEvent(new Event('focus'));
doc.dispatchEvent(mouseMove(-120, 0));
assert.deepEqual(moves, [[7, -3], [-5, 6]], 'the first delta after recapture or refocus is ignored');
doc.dispatchEvent(mouseMove(3, 2));
assert.deepEqual(moves, [[7, -3], [-5, 6], [3, 2]], 'ordinary movement resumes immediately after refocus');
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

console.log('pointer lock checks passed');
