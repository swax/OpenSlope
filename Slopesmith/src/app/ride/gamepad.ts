/**
 * Backbone / MFi (and any "standard"-mapping) game controller support for the test ride, via the Web Gamepad API.
 * iOS Safari exposes a Backbone plugged into the phone as a standard gamepad, so the same code drives a desktop
 * pad too. Held buttons feed input's source-aware aggregate, so disconnecting the pad cannot stomp a simultaneous
 * keyboard/touch hold. One-shot actions (board on/off, respawn, pause, telemetry) fire on button edges; ollie
 * ownership is also aggregated so another device can keep the charge held across a pad disconnect.
 *
 * There is no event stream for held buttons — a pad must be polled — so `poll()` runs once per frame from the ride
 * session's step, right before the model reads `keys`.
 */

import { toast } from '../ui/components/toast';
import {
  rideVerticalIntent, type RideHoldSource, type RideInputOpts, type RideKeys, type WalkHoldField,
} from './input';
import { normalizeAxis, RIDE_THROTTLE_DEAD, shapeAxis } from './xr/input';

// Standard-mapping button/axis indices (w3c.github.io/gamepad/#remapping); a Backbone reports this layout. To
// remap a control, change the index here — nothing else in this file hard-codes a button.
const BTN = {
  ollie: 0,        // A / South  — charged ollie: hold to charge, release to launch (mirrors Space)
  respawn: 1,      // B / East   — respawn at the last spawn
  boost: 2,        // X / West   — boost (hold)
  board: 3,        // Y / North  — get off / get back on the board (mirrors E)
  zoomOut: 6,      // L2         — zoom the third-person camera out
  zoomIn: 7,       // R2         — zoom the third-person camera in
  pause: 9,        // ☰ Start/Menu — pause / resume the run
  telemToggle: 10, // L3 stick-click — start / stop telemetry capture
  telemMark: 11,   // R3 stick-click — drop a telemetry marker
  dpadUp: 12, dpadDown: 13, dpadLeft: 14, dpadRight: 15,
};
const LEFT_X_AXIS = 0, LEFT_Y_AXIS = 1, RIGHT_X_AXIS = 2, RIGHT_Y_AXIS = 3;
const STICK_DEAD = 0.18; // ignore stick drift and a resting thumb
/** Exponential third-person boom scale per held second. Analog triggers proportionally scale this rate. */
const ZOOM_RATE = 1.6;

/** What the pad is physically doing this frame, for the HUD's diagnostic mirror: the touch controls light up
 *  and the visible movement stick tracks its physical counterpart, so a suspect controller can be read off the
 *  screen. Axes are RAW (no dead zone, no shaping) — drift is exactly what a diagnostic wants to see. */
export interface PadMirror {
  /** Any real input this frame — a button down, or the stick past its dead zone. */
  active: boolean;
  steer: number;
  /** On-foot axes: X right, Y forward; look Y is positive down-screen. */
  moveX: number; moveY: number; lookX: number; lookY: number;
  ollie: boolean; boost: boolean;
  board: boolean; respawn: boolean;
}

export interface RideGamepadOpts extends Omit<RideInputOpts, 'ollieDown' | 'ollieUp' | 'exit'> {
  setHold(source: RideHoldSource, field: keyof RideKeys, down: boolean): void;
  setWalkHold(source: RideHoldSource, field: WalkHoldField, down: boolean): void;
  setOllie(source: RideHoldSource, down: boolean): void;
  releaseSource(source: RideHoldSource): void;
  /** The left virtual stick: ride steer on the board, two-axis movement on foot. */
  stick: { active: boolean; x: number; airX: number; y: number; id?: number };
  /** The physical right-stick camera axis, shared by riding and on-foot views. */
  lookStick: { active: boolean; x: number; y: number; id?: number };
  togglePause(): void;
  zoom(factor: number): void;
}

/** Human part of a gamepad id like "Backbone One Extended Gamepad (Vendor: 05ac …)". */
function padName(id: string): string {
  const paren = id.indexOf('(');
  return ((paren > 0 ? id.slice(0, paren) : id).trim()) || 'gamepad';
}

export function createRideGamepad(o: RideGamepadOpts) {
  // Edges for the one-shot buttons: fire on the press (and, for the ollie, also the release).
  const prev = {
    ollie: false, board: false, respawn: false, pause: false, telemToggle: false, telemMark: false,
  };
  let ownsStick = false;      // true while the physical left stick owns the shared HUD stick
  let ownsLookStick = false;  // true while the physical right stick owns the shared camera axis
  let index: number | null = null;

  const onConnect = (e: GamepadEvent) => { index = e.gamepad.index; toast(`Controller connected — ${padName(e.gamepad.id)}`, 'ok'); };
  const onDisconnect = (e: GamepadEvent) => {
    if (e.gamepad.index === index) { index = null; releasePad(); }
    toast('Controller disconnected', 'info');
  };

  function pick(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    if (index != null && pads[index]) return pads[index];
    // iOS sometimes populates the array without firing a connect event, so fall back to the first live pad.
    for (const p of pads) if (p) { index = p.index; return p; }
    return null;
  }

  const pressed = (gp: Gamepad, i: number) => { const b = gp.buttons[i]; return !!b && b.pressed; };
  const buttonValue = (gp: Gamepad, i: number) => {
    const b = gp.buttons[i];
    if (!b) return 0;
    const analog = Math.min(1, Math.max(0, Number(b.value) || 0));
    return analog > 0 ? analog : Number(b.pressed);
  };

  const touchOwns = (stick: { id?: number }) => typeof stick.id === 'number' && stick.id !== -1;
  function releaseStick() {
    if (ownsStick && !touchOwns(o.stick)) {
      o.stick.active = false; o.stick.x = 0; o.stick.airX = 0; o.stick.y = 0;
    }
    ownsStick = false;
  }
  function releaseLookStick() {
    if (ownsLookStick && !touchOwns(o.lookStick)) {
      o.lookStick.active = false; o.lookStick.x = 0; o.lookStick.y = 0;
    }
    ownsLookStick = false;
  }
  function releasePad() {
    releaseStick();
    releaseLookStick();
    o.releaseSource('gamepad');
    prev.ollie = prev.board = prev.respawn = prev.pause = prev.telemToggle = prev.telemMark = false;
  }

  /** Sample the pad and drive `keys`/`stick`/the action edges. Returns the pad's physical state for the HUD's
   *  diagnostic mirror (null when no pad is connected); its `active` flag is what swaps the touch overlay for
   *  the controller legend. */
  function poll(dt = 0): PadMirror | null {
    const gp = pick();
    if (!gp) { releasePad(); return null; }

    // Y is the gamepad counterpart to desktop E and the touch HUD's Board face. Read it before the held
    // controls so a dismount releases the pad's board inputs in this same sample, while a remount can accept the
    // rest of the pad immediately. The edge continues to be polled on foot; otherwise Y could get off but never
    // get back on.
    const boardNow = pressed(gp, BTN.board);
    if (boardNow && !prev.board) o.toggleBoard?.();
    prev.board = boardNow;
    const onFoot = o.onFoot?.() ?? false;

    // ---- sticks: left carves + tucks/brakes/flips while riding, then becomes two-axis movement on foot ----
    const leftX = gp.axes[LEFT_X_AXIS] ?? 0, leftY = gp.axes[LEFT_Y_AXIS] ?? 0;
    const rightX = gp.axes[RIGHT_X_AXIS] ?? 0, rightY = gp.axes[RIGHT_Y_AXIS] ?? 0;
    const zoom = buttonValue(gp, BTN.zoomOut) - buttonValue(gp, BTN.zoomIn);
    if (zoom && dt > 0) o.zoom(Math.exp(zoom * ZOOM_RATE * Math.min(dt, 0.1)));
    const dUp = pressed(gp, BTN.dpadUp), dDown = pressed(gp, BTN.dpadDown);
    const dLeft = pressed(gp, BTN.dpadLeft), dRight = pressed(gp, BTN.dpadRight);
    const dpadX = Number(dRight) - Number(dLeft), dpadY = Number(dUp) - Number(dDown);
    const moveX = dpadX || leftX, moveY = dpadY || -leftY;
    const stickX = onFoot ? moveX : leftX, stickY = onFoot ? moveY : 0;
    if ((Math.abs(stickX) > STICK_DEAD || Math.abs(stickY) > STICK_DEAD) && !touchOwns(o.stick)) {
      o.stick.x = shapeAxis(stickX, STICK_DEAD);
      o.stick.airX = normalizeAxis(stickX, STICK_DEAD);
      o.stick.y = shapeAxis(stickY, STICK_DEAD);
      o.stick.active = true;
      ownsStick = true;
    } else {
      releaseStick();
    }
    if ((Math.abs(rightX) > STICK_DEAD || Math.abs(rightY) > STICK_DEAD) && !touchOwns(o.lookStick)) {
      o.lookStick.x = shapeAxis(rightX, STICK_DEAD);
      o.lookStick.y = shapeAxis(rightY, STICK_DEAD);
      o.lookStick.active = true;
      ownsLookStick = true;
    } else releaseLookStick();
    o.setHold('gamepad', 'left', !onFoot && dLeft);
    o.setHold('gamepad', 'right', !onFoot && dRight);

    // ---- held states ----
    const boostNow = pressed(gp, BTN.boost);
    // Directional stick/D-pad Y matches touch and XR. Ground/rail consume tuck/brake, while the air integrator
    // consumes the same state as forward/back flip intent. L2/R2 are reserved for camera zoom.
    const verticalIntent = rideVerticalIntent(moveX, moveY, RIDE_THROTTLE_DEAD);
    const verticalTuck = verticalIntent > 0, verticalBrake = verticalIntent < 0;
    o.setHold('gamepad', 'tuck', !onFoot && verticalTuck);
    o.setHold('gamepad', 'brake', !onFoot && verticalBrake);
    o.setHold('gamepad', 'boost', !onFoot && boostNow);
    o.setWalkHold('gamepad', 'boost', onFoot && boostNow);

    // ---- one-shot edges ----
    const ollieNow = pressed(gp, BTN.ollie);
    o.setWalkHold('gamepad', 'jump', onFoot && ollieNow);
    if (!onFoot && ollieNow !== prev.ollie) o.setOllie('gamepad', ollieNow);
    else if (onFoot) o.setOllie('gamepad', false);
    prev.ollie = ollieNow;

    const respawnNow = pressed(gp, BTN.respawn);
    if (respawnNow && !prev.respawn) o.respawn();
    prev.respawn = respawnNow;

    const pauseNow = pressed(gp, BTN.pause);
    if (pauseNow && !prev.pause) o.togglePause();
    prev.pause = pauseNow;

    const toggleNow = pressed(gp, BTN.telemToggle);
    if (toggleNow && !prev.telemToggle) o.telemetryToggle();
    prev.telemToggle = toggleNow;

    const markNow = pressed(gp, BTN.telemMark);
    if (markNow && !prev.telemMark) o.telemetryMark();
    prev.telemMark = markNow;

    return {
      // Any button counts as activity — mapped or not — so riding on an oddly-mapped pad still claims the screen.
      active: [leftX, leftY, rightX, rightY].some(axis => Math.abs(axis) > STICK_DEAD)
        || gp.buttons.some(b => b.pressed),
      steer: dpadX || leftX,
      moveX, moveY, lookX: rightX, lookY: rightY,
      ollie: ollieNow, boost: boostNow,
      board: boardNow, respawn: respawnNow,
    };
  }

  function attach() {
    window.addEventListener('gamepadconnected', onConnect);
    window.addEventListener('gamepaddisconnected', onDisconnect);
  }

  function detach() {
    window.removeEventListener('gamepadconnected', onConnect);
    window.removeEventListener('gamepaddisconnected', onDisconnect);
    releasePad();
  }

  return { poll, attach, detach };
}

export type RideGamepad = ReturnType<typeof createRideGamepad>;
