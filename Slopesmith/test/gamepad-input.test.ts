// tier: fast

import assert from 'node:assert/strict';

// gamepad.ts shares the browser toast helper; install the one DOM node that helper captures before importing it.
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { getElementById: () => ({ textContent: '', className: '' }) },
});
const { createRideGamepad } = await import('../src/app/ride/gamepad');
const { createRideInput, touchRidePosture } = await import('../src/app/ride/input');

const buttons = Array.from({ length: 16 }, () => ({ pressed: false, touched: false, value: 0 }));
const pad = {
  axes: [0, 0, 0, 0], buttons, connected: true, id: 'Test Standard Gamepad', index: 0,
  mapping: 'standard', timestamp: 0,
} as unknown as Gamepad;
let pads: (Gamepad | null)[] = [pad];
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { getGamepads: () => pads },
});

let ollieDown = 0, ollieUp = 0, boardToggles = 0, respawns = 0, pauseToggles = 0, exits = 0;
const zoomFactors: number[] = [];
let padOnFoot = false, padPaused = false;
const actions = {
  ollieDown: () => { ollieDown++; }, ollieUp: () => { ollieUp++; },
  onFoot: () => padOnFoot,
  toggleBoard: () => { padOnFoot = !padOnFoot; boardToggles++; },
  respawn: () => { respawns++; }, telemetryToggle: () => {}, telemetryMark: () => {}, exit: () => { exits++; },
};
const input = createRideInput(actions);
const stick = { active: false, x: 0, airX: 0, y: 0, id: -1 };
const lookStick = { active: false, x: 0, y: 0, id: -1 };
const gamepad = createRideGamepad({
  respawn: actions.respawn, telemetryToggle: actions.telemetryToggle,
  telemetryMark: actions.telemetryMark,
  onFoot: actions.onFoot, toggleBoard: actions.toggleBoard,
  setHold: input.setHold, setWalkHold: input.setWalkHold,
  setOllie: input.setOllie, releaseSource: input.releaseSource, stick, lookStick,
  togglePause: () => { padPaused = !padPaused; pauseToggles++; },
  zoom: factor => zoomFactors.push(factor),
});

assert.deepEqual(touchRidePosture(-1), { tuck: true, brake: false },
  'pushing the mobile stick forward tucks / accelerates');
assert.deepEqual(touchRidePosture(1), { tuck: false, brake: true },
  'pulling the mobile stick back brakes');
assert.deepEqual(touchRidePosture(0), { tuck: false, brake: false },
  'centring the mobile stick releases both riding postures');
assert.deepEqual(touchRidePosture(-0.41, 0.8), { tuck: false, brake: false },
  'a mostly-horizontal mobile spin does not also become a flip');
assert.deepEqual(touchRidePosture(-0.8, 0.41), { tuck: true, brake: false },
  'a vertical-dominant mobile diagonal can still combine a spin with a forward flip');

// B / East is the respawn face. Camera switching is a separate manual HUD button, not a physical face mapping.
buttons[1].pressed = true;
const respawnMirror = gamepad.poll();
assert.equal(respawns, 1, 'B respawns');
assert.equal(respawnMirror?.respawn, true, 'the HUD mirror sees the B / respawn button');
gamepad.poll();
assert.equal(respawns, 1, 'holding B cannot repeatedly respawn');
buttons[1].pressed = false;
gamepad.poll();

// Start/Menu owns pause because the touch HUD already has a dedicated Exit button.
buttons[9].pressed = true;
gamepad.poll();
assert.equal(padPaused, true, 'Start/Menu pauses the run');
assert.equal(pauseToggles, 1);
assert.equal(exits, 0, 'Start/Menu cannot exit the run');
gamepad.poll();
assert.equal(pauseToggles, 1, 'holding Start/Menu cannot repeatedly toggle pause');
buttons[9].pressed = false;
gamepad.poll();
buttons[9].pressed = true;
gamepad.poll();
assert.equal(padPaused, false, 'a second Start/Menu press resumes the run');
assert.equal(pauseToggles, 2);
buttons[9].pressed = false;
gamepad.poll();

// Y / North is the E-key equivalent. It fires once per press, gets off and back on, and clears any held board
// control in the same sample that dismounts rather than leaving it armed underneath the walking state.
buttons[2].pressed = true;
gamepad.poll();
assert.equal(input.keys.boost, true, 'X holds boost while riding');
buttons[3].pressed = true;
const boardMirror = gamepad.poll();
assert.equal(padOnFoot, true, 'Y gets off the board');
assert.equal(boardMirror?.board, true, 'the HUD mirror sees the Y / board button');
assert.equal(input.keys.boost, false, 'dismounting clears held gamepad board controls immediately');
assert.equal(input.walkKeys.boost, true, 'the same held X becomes full-speed flight boost on foot');
(pad.axes as number[]).splice(0, 4, 0.8, -0.6, 0.5, -0.4);
const walkingMirror = gamepad.poll();
assert.ok(stick.active && stick.x > 0 && stick.y > 0,
  'on foot the left stick becomes two-axis strafe/forward movement');
assert.ok(lookStick.active && lookStick.x > 0 && lookStick.y < 0,
  'on foot the right stick becomes two-axis look');
assert.deepEqual(
  [walkingMirror?.moveX, walkingMirror?.moveY, walkingMirror?.lookX, walkingMirror?.lookY],
  [0.8, 0.6, 0.5, -0.4],
  'the HUD mirror receives raw movement and look axes with forward-positive walking Y',
);
buttons[0].pressed = true;
gamepad.poll();
assert.equal(input.walkKeys.jump, true, 'A / South is the on-foot jump and upward-flight hold');
buttons[0].pressed = false;
gamepad.poll();
assert.equal(input.walkKeys.jump, false, 'releasing A clears the pad jump hold');
buttons[7].pressed = true;
gamepad.poll(0.1);
assert.ok(zoomFactors.at(-1)! < 1, 'R2 continuously zooms the third-person camera in');
buttons[7].pressed = false;
buttons[6].pressed = true;
gamepad.poll(0.1);
assert.ok(zoomFactors.at(-1)! > 1, 'L2 continuously zooms the third-person camera out');
buttons[6].pressed = false;
gamepad.poll();
assert.equal(input.walkKeys.crouch, false, 'camera triggers do not leak into crouch or flight direction');
assert.equal(boardToggles, 1, 'holding Y cannot bounce between riding and walking');
buttons[3].pressed = false;
gamepad.poll();
buttons[3].pressed = true;
gamepad.poll();
assert.equal(padOnFoot, false, 'a second Y press gets back on the board');
assert.equal(stick.y, 0, 'remounting returns the left stick to one-axis board steering');
assert.ok(lookStick.active && lookStick.x > 0 && lookStick.y < 0,
  'the right stick continues to own camera look after remounting');
assert.equal(boardToggles, 2);
buttons[3].pressed = false;
buttons[2].pressed = false;
(pad.axes as number[]).splice(0, 4, 0, 0, 0, 0);
gamepad.poll();
buttons[6].pressed = true;
buttons[7].pressed = true;
gamepad.poll();
assert.equal(input.keys.tuck, false, 'R2 zoom does not leak into tuck');
assert.equal(input.keys.brake, false, 'L2 zoom does not leak into brake');
buttons[6].pressed = false;
buttons[7].pressed = false;
gamepad.poll();

// The riding stick's vertical axis has the same state-independent intent as touch, XR and W/S. Physics decides
// whether that means grounded/rail posture or an airborne flip; the input layer must not discard Y while mounted.
(pad.axes as number[])[1] = -0.7;
const forwardRideMirror = gamepad.poll();
assert.equal(input.keys.tuck, true, 'pushing the mounted gamepad stick forward owns tuck / forward-flip intent');
assert.equal(input.keys.brake, false);
assert.equal(forwardRideMirror?.moveY, 0.7, 'the diagnostic mirror receives forward-positive riding Y');
(pad.axes as number[])[1] = 0.7;
gamepad.poll();
assert.equal(input.keys.tuck, false);
assert.equal(input.keys.brake, true, 'pulling the mounted gamepad stick back owns brake / back-flip intent');
(pad.axes as number[])[1] = 0;
buttons[12].pressed = true;
gamepad.poll();
assert.equal(input.keys.tuck, true, 'D-pad up is the digital forward/tuck/flip alternative');
buttons[12].pressed = false;
gamepad.poll();
assert.equal(input.keys.tuck, false, 'centring the vertical controls releases their riding hold');
(pad.axes as number[]).splice(0, 2, 0.8, -0.41);
gamepad.poll();
assert.equal(input.keys.tuck, false,
  'incidental Y above the throttle threshold does not flip during a mostly-horizontal air spin');
assert.ok(stick.airX > 0, 'the horizontal sample still reaches the air-spin axis');
(pad.axes as number[]).splice(0, 2, 0.7, -0.7);
gamepad.poll();
assert.equal(input.keys.tuck, true, 'a deliberate diagonal retains simultaneous spin and forward flip');
(pad.axes as number[]).splice(0, 2, 0, 0);
gamepad.poll();
(pad.axes as number[])[0] = 0.5;
gamepad.poll();
assert.ok(stick.airX > stick.x,
  'partial mounted stick X keeps a linear air-spin axis beside the softened ground-carve axis');
(pad.axes as number[])[0] = 0;
gamepad.poll();

// A pad release must remove only the pad's contribution, not a keyboard hold that is still live.
input.setHold('keyboard', 'boost', true);
buttons[2].pressed = true;
gamepad.poll();
buttons[2].pressed = false;
gamepad.poll();
assert.equal(input.keys.boost, true, 'releasing gamepad boost preserves keyboard boost ownership');
input.setHold('keyboard', 'boost', false);
assert.equal(input.keys.boost, false);

// Browsers do not reliably deliver gamepaddisconnected. A missing poll sample must release every pad-owned
// digital/analog state and close its charged-ollie edge exactly once.
buttons[2].pressed = true;
buttons[0].pressed = true;
(pad.axes as number[])[0] = 0.8;
gamepad.poll();
assert.equal(input.keys.boost, true);
assert.equal(stick.active, true);
assert.equal(ollieDown, 1);
pads = [null];
gamepad.poll();
assert.equal(input.keys.boost, false, 'a vanished pad cannot leave a held key stuck');
assert.equal(stick.active, false, 'a vanished pad cannot leave analog steer stuck');
assert.equal(ollieUp, 1, 'a vanished pad releases its charged ollie');

// Ollie is aggregate ownership too: unplugging the pad while Space remains held must not launch early.
buttons[0].pressed = false;
buttons[2].pressed = false;
(pad.axes as number[])[0] = 0;
pads = [pad];
gamepad.poll();
input.setOllie('keyboard', true);
assert.equal(ollieDown, 2);
buttons[0].pressed = true;
gamepad.poll();
pads = [null];
gamepad.poll();
assert.equal(ollieUp, 1, 'pad disconnect does not release another source\'s ollie hold');
input.setOllie('keyboard', false);
assert.equal(ollieUp, 2);

// Desktop Play reuses the same keyboard listener after E parks the board: WASD must move the walker rather than
// leaking into the frozen board controls, and the same non-repeating E press must mount it again.
{
  const fakeWindow = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  let onFoot = false, toggles = 0, viewToggles = 0;
  const walking = createRideInput({
    ...actions,
    onFoot: () => onFoot,
    toggleBoard: () => { onFoot = !onFoot; toggles++; },
    toggleThirdPerson: () => { viewToggles++; },
  });
  const key = (type: 'keydown' | 'keyup', value: string, repeat = false) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, { key: { value }, repeat: { value: repeat } });
    fakeWindow.dispatchEvent(event);
  };
  walking.attach();
  key('keydown', 'e');
  assert.equal(onFoot, true, 'E gets off the board');
  key('keydown', 'w');
  key('keydown', 'd');
  key('keydown', 'Control');
  key('keydown', 'Shift');
  assert.equal(walking.walkKeys.forward, true, 'W is forward on foot');
  assert.equal(walking.walkKeys.right, true, 'D is strafe-right on foot');
  assert.equal(walking.walkKeys.crouch, true, 'Ctrl crouches on foot');
  assert.equal(walking.walkKeys.boost, true, 'Shift is the keyboard full-speed flight modifier');
  walking.setWalkHold('touch', 'crouch', true);
  key('keydown', 'v');
  key('keydown', 'v', true);
  assert.equal(viewToggles, 1, 'V toggles third person once without key-repeat bounce');
  key('keyup', 'v');
  key('keyup', 'Control');
  key('keyup', 'Shift');
  assert.equal(walking.walkKeys.boost, false, 'releasing Shift clears the flight boost modifier');
  assert.equal(walking.walkKeys.crouch, true, 'releasing Ctrl preserves a held mobile crouch button');
  walking.setWalkHold('touch', 'crouch', false);
  assert.equal(walking.walkKeys.crouch, false, 'releasing the final crouch source stands back up');
  key('keydown', ' ');
  walking.setWalkHold('touch', 'jump', true);
  key('keyup', ' ');
  assert.equal(walking.walkKeys.jump, true, 'releasing Space preserves a held mobile jump button');
  walking.setWalkHold('touch', 'jump', false);
  assert.equal(walking.walkKeys.jump, false, 'releasing the final jump source clears the jump hold');
  assert.equal(walking.keys.tuck, false, 'walking W does not tuck the parked board');
  assert.equal(walking.keys.right, false, 'walking D does not steer the parked board');
  fakeWindow.dispatchEvent(new Event('blur'));
  assert.equal(walking.walkKeys.forward, false, 'losing window focus releases a held walk key');
  assert.equal(walking.walkKeys.right, false, 'losing window focus releases every held walk direction');
  key('keydown', 'w');
  assert.equal(walking.walkKeys.forward, true, 'walking resumes normally after focus returns');
  fakeWindow.dispatchEvent(new Event('blur'));
  key('keydown', 'e', true);
  assert.equal(toggles, 1, 'key repeat cannot bounce between walking and riding');
  key('keyup', 'e');
  key('keydown', 'e');
  assert.equal(onFoot, false, 'the same E key gets back on the board');
  key('keyup', 'v');
  key('keydown', 'v');
  assert.equal(viewToggles, 2, 'V keeps toggling the view while the rider is on the board');
  walking.detach();
}

console.log('GAMEPAD INPUT TESTS PASSED');
