/**
 * WebXR controller input for VR play (docs/048) — the CONTROL MAP, and nothing else.
 *
 * Two halves, both pure so the map is testable without a headset: `readPads` lifts a frame's `XRInputSource`
 * list into a plain per-hand snapshot, and `rideControls` / `footControls` turn one snapshot into what the two
 * states actually do with it. Which physical control means what is decided HERE, once, so the session host reads
 * intents rather than button indices — and so the map can be checked against the VRChat board's own
 * (`RideableBoard.InputMoveHorizontal` / `InputMoveVertical` / `InputUse` / `InputJump`, Unity docs/vrchat/017)
 * without reading a state machine.
 *
 * The map, which IS the VRChat board's:
 *
 * | Control              | Riding                          | On foot                        |
 * |----------------------|---------------------------------|--------------------------------|
 * | Left stick X         | carve                           | strafe                         |
 * | Left stick Y         | tuck (fwd) / brake (back)       | walk                           |
 * | Right stick X        | —                               | smooth turn                    |
 * | Right stick click    | first / third person            | first / third person           |
 * | Either trigger       | dismount                        | mount / re-equip the board     |
 * | Either GRIP          | take the deck off your feet     | pick up / pass / throw / summon|
 * | Right A              | charged jump (hold → release)  | jump / double-jump or +B fly   |
 * | Right B              | boost along deck nose           | held-board jetpack / air boost |
 * | Left X               | respawn along course            | spawn board ahead              |
 * | Left Y               | show / hide wrist menu          | show / hide wrist menu         |
 * | Wrist Restart button | restart from gate               | restart from gate              |
 * | Head                 | head steer                       | walk direction                 |
 *
 * The GRIP is the carry verb throughout, and the trigger is the ride verb throughout — the same split the
 * VRChat board makes, where VRChat itself routes grab and use apart. That is why one collider can be both a
 * thing you ride and a thing you hold with no separate handle to aim at, and why holding the board takes the
 * trigger remains the board's ride verb: it mounts on foot and dismounts while riding. Flight is entered by a
 * second airborne A press or the A + B chord and follows the directional controls. While a board is carried,
 * B instead uses the board itself as an unlimited thruster, including from the ground.
 */

import { rideVerticalIntent } from '../input';

/** Standard-mapping indices (immersive-web.github.io/webxr-gamepads-module, the `xr-standard` layout). */
const BTN = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 };

/** Stick dead zone and the existing centre-softened walk curve shared with pad/touch input. */
const STICK_DEAD = 0.18, STICK_GAIN = 0.25;
/**
 * How far the left stick must go BACK or FORWARD before it also throttles. Higher than the steer dead zone on
 * purpose: one thumb owns both axes here (as it does on the board — `InputMoveHorizontal`/`Vertical` are one
 * stick), so a hard carve must not quietly brake as the thumb rolls round the gate.
 */
export const RIDE_THROTTLE_DEAD = 0.4;
/** Comfortable smooth yaw at full right-stick deflection. */
const TURN_RATE_DEG = 120;

/** One hand as this frame reports it. `null` for a hand that is not tracked or carries no gamepad. */
export interface XrHand {
  handedness: XRHandedness;
  /** Thumbstick, −1..1. `y` is NEGATIVE pushed away from you, as the Gamepad API reports it. */
  x: number;
  y: number;
  trigger: boolean;
  squeeze: boolean;
  /** Analog pulls, 0..1. `pressed` remains the digital gameplay edge; these animate the avatar hand. */
  triggerValue: number;
  squeezeValue: number;
  stickPressed: boolean;
  /** A / X — right A jumps; left X respawns the rider on-board or spawns the board while on foot. */
  a: boolean;
  /** B / Y — right B boosts; left Y shows or hides the wrist menu. */
  b: boolean;
}

export interface XrPads {
  left: XrHand | null;
  right: XrHand | null;
}

const pressed = (gamepad: Gamepad, index: number) => !!gamepad.buttons[index]?.pressed;
const value = (gamepad: Gamepad, index: number) => {
  const button = gamepad.buttons[index];
  if (!button) return 0;
  const analog = Math.min(1, Math.max(0, Number(button.value) || 0));
  return analog > 0 ? analog : Number(button.pressed);
};

/**
 * A hand's live state, or null when it carries no gamepad (hand tracking, a tracked object, a still-connecting
 * controller). Thumbsticks live at axes 2/3 in the standard layout; a device that reports only two axes puts the
 * same stick at 0/1, so both are read rather than assuming a full four.
 */
export function readHand(source: XRInputSource): XrHand | null {
  const gamepad = source.gamepad;
  if (!gamepad) return null;
  const axes = gamepad.axes;
  const stick = axes.length >= 4 ? 2 : 0;
  return {
    handedness: source.handedness,
    x: axes[stick] ?? 0,
    y: axes[stick + 1] ?? 0,
    trigger: pressed(gamepad, BTN.trigger),
    squeeze: pressed(gamepad, BTN.squeeze),
    triggerValue: value(gamepad, BTN.trigger),
    squeezeValue: value(gamepad, BTN.squeeze),
    stickPressed: pressed(gamepad, BTN.stick),
    a: pressed(gamepad, BTN.a),
    b: pressed(gamepad, BTN.b),
  };
}

/** Controller hand pose: squeeze wraps thumb/middle/ring/pinky while the index remains available to point;
 * pulling the trigger closes that last finger. Values are kept analog for hardware that reports partial pulls. */
export function controllerFingerCurls(hand: XrHand | null | undefined) {
  const grip = hand?.squeezeValue ?? 0, trigger = hand?.triggerValue ?? 0;
  return { thumb: grip, index: trigger, middle: grip, ring: grip, pinky: grip };
}

/** Both hands out of a session's input sources. A hand reporting neither `left` nor `right` is ignored. */
export function readPads(sources: Iterable<XRInputSource>): XrPads {
  const pads: XrPads = { left: null, right: null };
  for (const source of sources) {
    if (source.handedness !== 'left' && source.handedness !== 'right') continue;
    const hand = readHand(source);
    if (hand) pads[source.handedness] = hand;
  }
  return pads;
}

/** The headset-native counterpart to desktop V. Kept as a held value here; the session host owns its edge so
 * mounting/dismounting while it remains pressed cannot fire it twice. */
export function viewToggleHeld(pads: XrPads): boolean { return !!pads.right?.stickPressed; }

/** Quest/WebXR left Y. Kept as a held value so the session host can edge-trigger one visibility change per
 * press instead of flickering the wrist menu every frame the button remains down. */
export function wristMenuToggleHeld(pads: XrPads): boolean { return !!pads.left?.b; }

/** Dead-zoned and centre-softened, the same curve the pad and touch sticks use. Returns exactly 0 inside. */
export function shapeAxis(raw: number, dead = STICK_DEAD): number {
  const scaled = normalizeAxis(raw, dead);
  const mag = Math.abs(scaled);
  return Math.sign(scaled) * (STICK_GAIN * mag + (1 - STICK_GAIN) * mag * mag * mag);
}

/** Remove the physical dead zone and restore the remaining throw to a linear −1..1 axis. Air spin uses this
 *  instead of the ground carve curve so half a deliberate thumb movement remains half the trick rate. */
export function normalizeAxis(raw: number, dead = STICK_DEAD): number {
  const mag = Math.abs(raw);
  if (mag <= dead) return 0;
  return Math.sign(raw) * Math.min(1, (mag - dead) / (1 - dead));
}

/**
 * The headset-tested riding curve ported from OpenSlope Unity: dead-zone and re-normalize the physical controller,
 * then map the remaining throw to `sign(x) * x²`. Partial deflections gain precision while hard lock remains
 * exactly -1/+1. Kept separate from `shapeAxis` so walking and non-XR pad/touch riding do not silently change.
 */
export function precisionRideAxis(raw: number, dead = STICK_DEAD): number {
  const scaled = normalizeAxis(raw, dead);
  return Math.sign(scaled) * scaled * scaled;
}

/** What the controls mean while the rider is ON the board. */
export interface XrRideControls {
  /** Analog carve, −1..1, right positive — handed to the model through the shared stick the pad also drives. */
  steer: number;
  /** Air spin uses the linear post-dead-zone axis, not the precision carve curve. */
  spin: number;
  tuck: boolean;
  brake: boolean;
  /** Right A: held is the ollie CHARGE, and its release is the launch. */
  ollie: boolean;
  /** Right B: SSX's held Boost control. */
  boost: boolean;
  /** Left X: recover near the rider's current course progress. The session edge-triggers this intent. */
  courseRespawn: boolean;
  /** Either trigger: get off the board. */
  dismount: boolean;
}

export function rideControls(pads: XrPads): XrRideControls {
  const left = pads.left, right = pads.right;
  const throttle = left ? -left.y : 0; // stick Y is negative forward; make forward positive first
  const verticalIntent = rideVerticalIntent(left?.x ?? 0, throttle, RIDE_THROTTLE_DEAD);
  return {
    steer: precisionRideAxis(left?.x ?? 0),
    spin: normalizeAxis(left?.x ?? 0),
    tuck: verticalIntent > 0,
    brake: verticalIntent < 0,
    ollie: !!right?.a,
    boost: !!right?.b,
    courseRespawn: !!left?.a,
    dismount: !!left?.trigger || !!right?.trigger,
  };
}

/**
 * The GRIP, per hand — the carry verb, in every state. Which of picking up, passing over, throwing and taking
 * the deck off your feet a squeeze means is decided by what that hand and that board are doing at the time, so
 * the map itself is just "this hand is closing".
 */
export interface XrGrabControls {
  left: boolean;
  right: boolean;
}

export function grabControls(pads: XrPads): XrGrabControls {
  return { left: !!pads.left?.squeeze, right: !!pads.right?.squeeze };
}

/** What the same controls mean while the rider is walking the mountain. */
export interface XrFootControls {
  /** Ground-plane walk intent in HEAD-relative axes: `x` right, `y` forward, each −1..1. */
  moveX: number;
  moveY: number;
  /** Raw smooth-turn axis, right positive. The frame step shapes and integrates it with real time. */
  turn: number;
  /** Either trigger: take the board that is within reach. */
  mount: boolean;
  /** Right A. */
  jump: boolean;
  /** Right B: full directional boost in air, or unlimited board-axis thrust while a deck is held. */
  boost: boolean;
  /** Left X: put the board back on the ground in front of the walker. */
  spawnBoard: boolean;
}

/**
 * Triggers remain the board's ride/re-equip verb. Superman flight is a double jump or Jump + Boost chord, never
 * a trigger mode.
 */
export function footControls(pads: XrPads): XrFootControls {
  const left = pads.left, right = pads.right;
  return {
    moveX: shapeAxis(left?.x ?? 0),
    moveY: shapeAxis(-(left?.y ?? 0)),
    turn: right ? right.x : 0,
    mount: !!left?.trigger || !!right?.trigger,
    jump: !!right?.a,
    boost: !!right?.b,
    spawnBoard: !!left?.a,
  };
}

/**
 * Integrate the on-foot right stick into world yaw. Three's positive world-Y rotation turns a −Z-facing viewer
 * LEFT, so a physical stick pushed right deliberately returns a NEGATIVE angle. Keeping that sign here, beside
 * the gamepad read, prevents the session rig from quietly mirroring left/right again.
 */
export function smoothTurnRadians(axis: number, dt: number, rateDeg = TURN_RATE_DEG): number {
  if (dt <= 0) return 0;
  const shaped = shapeAxis(axis);
  return shaped === 0 ? 0 : -shaped * rateDeg * Math.PI / 180 * Math.min(dt, 0.1);
}
