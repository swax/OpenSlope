/**
 * Input ownership for the test ride. `keys` is the aggregate state the physics reads; keyboard, touch and
 * gamepad each own a separate hold source, so releasing/disconnecting one device cannot cancel another
 * device's still-held control. Ollie is aggregated the same way and emits edges only when the combined hold
 * changes. The remaining one-shot actions go straight through callbacks.
 */

export interface RideKeys { left: boolean; right: boolean; tuck: boolean; brake: boolean; boost: boolean }
export interface WalkKeys {
  left: boolean; right: boolean; forward: boolean; back: boolean; jump: boolean; crouch: boolean; boost: boolean;
}
export type RideHoldSource = 'keyboard' | 'touch' | 'gamepad' | 'xr';
export type WalkHoldField = 'jump' | 'crouch' | 'boost';

/**
 * Return the signed vertical intent only when Y owns the stick direction. A separate dead zone prevents small
 * physical-axis noise from becoming posture; the direction check prevents a mostly-horizontal carve/spin from
 * also becoming a flip merely because the thumb did not travel along a mathematically perfect X axis. Equal and
 * vertical-dominant diagonals remain deliberate combined spin/flip input.
 */
export function rideVerticalIntent(horizontal: number, vertical: number, dead = 0): -1 | 0 | 1 {
  if (Math.abs(vertical) <= dead || Math.abs(vertical) < Math.abs(horizontal)) return 0;
  return vertical < 0 ? -1 : 1;
}

/** Map the touch stick's screen-space Y (up/forward is negative) onto the riding posture keys. */
export function touchRidePosture(vertical: number, horizontal = 0): Pick<RideKeys, 'tuck' | 'brake'> {
  const intent = rideVerticalIntent(horizontal, vertical);
  return { tuck: intent < 0, brake: intent > 0 };
}

export interface RideInputOpts {
  ollieDown(): void;
  ollieUp(): void;
  respawn(): void;
  telemetryToggle(): void;
  telemetryMark(): void;
  exit(): void;
  /** Desktop Play can keep the session alive while its board is parked and the player walks. */
  onFoot?(): boolean;
  /** E toggles that parked-board state. Omitted by non-desktop/test callers. */
  toggleBoard?(): void;
  /** V toggles the desktop rider's first/third-person view, on foot or on the board. */
  toggleThirdPerson?(): void;
}

export function createRideInput(o: RideInputOpts) {
  const keys: RideKeys = { left: false, right: false, tuck: false, brake: false, boost: false };
  const walkKeys: WalkKeys = {
    left: false, right: false, forward: false, back: false, jump: false, crouch: false, boost: false,
  };
  const holds = new Map<RideHoldSource, RideKeys>();
  const walkHolds = new Map<RideHoldSource, Record<WalkHoldField, boolean>>();
  const ollieHolds = new Set<RideHoldSource>();

  const blankKeys = (): RideKeys => ({ left: false, right: false, tuck: false, brake: false, boost: false });
  function setHold(source: RideHoldSource, field: keyof RideKeys, down: boolean) {
    let owned = holds.get(source);
    if (!owned) { owned = blankKeys(); holds.set(source, owned); }
    if (owned[field] === down) return;
    owned[field] = down;
    keys[field] = [...holds.values()].some(state => state[field]);
  }

  function setWalkHold(source: RideHoldSource, field: WalkHoldField, down: boolean) {
    let owned = walkHolds.get(source);
    if (!owned) { owned = { jump: false, crouch: false, boost: false }; walkHolds.set(source, owned); }
    if (owned[field] === down) return;
    owned[field] = down;
    walkKeys[field] = [...walkHolds.values()].some(state => state[field]);
  }

  function setOllie(source: RideHoldSource, down: boolean) {
    const wasDown = ollieHolds.size > 0;
    if (down) ollieHolds.add(source); else ollieHolds.delete(source);
    const isDown = ollieHolds.size > 0;
    if (!wasDown && isDown) o.ollieDown();
    else if (wasDown && !isDown) o.ollieUp();
  }

  function releaseSource(source: RideHoldSource) {
    const owned = holds.get(source);
    if (owned) for (const field of Object.keys(owned) as (keyof RideKeys)[]) setHold(source, field, false);
    const walkOwned = walkHolds.get(source);
    if (walkOwned) for (const field of Object.keys(walkOwned) as WalkHoldField[]) setWalkHold(source, field, false);
    setOllie(source, false);
  }

  function clearWalk() {
    walkKeys.left = walkKeys.right = walkKeys.forward = walkKeys.back = false;
    walkHolds.clear();
    walkKeys.jump = walkKeys.crouch = walkKeys.boost = false;
  }

  /**
   * A browser does not promise a matching keyup after focus leaves the canvas/window. Clear every keyboard-owned
   * hold at that boundary so Alt-Tab, a devtools click, or the address bar cannot turn the last WASD sample into
   * cruise control. Device-owned holds remain intact through `releaseSource`'s ownership rules.
   */
  function releaseKeyboard() {
    releaseSource('keyboard');
    walkKeys.left = walkKeys.right = walkKeys.forward = walkKeys.back = false;
  }

  /** Release continuous keys before inspecting the event target. A key can go down over the canvas and come up
   * over a text field; filtering that keyup would retain the canvas's old hold forever. */
  function releaseKey(k: string): boolean {
    switch (k) {
      case 'a': case 'arrowleft': walkKeys.left = false; setHold('keyboard', 'left', false); return true;
      case 'd': case 'arrowright': walkKeys.right = false; setHold('keyboard', 'right', false); return true;
      case 'w': case 'arrowup': walkKeys.forward = false; setHold('keyboard', 'tuck', false); return true;
      case 's': case 'arrowdown': walkKeys.back = false; setHold('keyboard', 'brake', false); return true;
      case ' ': setWalkHold('keyboard', 'jump', false); setOllie('keyboard', false); return true;
      case 'control': setWalkHold('keyboard', 'crouch', false); return true;
      case 'shift': setWalkHold('keyboard', 'boost', false); setHold('keyboard', 'boost', false); return true;
      default: return false;
    }
  }

  // ---- input ----

  function handleKey(e: KeyboardEvent, down: boolean) {
    const t = e.target as HTMLElement | null;
    const k = e.key.toLowerCase();
    // Releases belong to the control that received the press, even if focus moved into a field in between.
    if (!down && releaseKey(k)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (t?.matches?.('input, textarea, select')) return;
    if (k === 'e' && o.toggleBoard) {
      if (down && !e.repeat) o.toggleBoard();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (k === 'v' && o.toggleThirdPerson) {
      if (down && !e.repeat) o.toggleThirdPerson();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (o.onFoot?.()) {
      switch (k) {
        case 'a': case 'arrowleft': walkKeys.left = down; break;
        case 'd': case 'arrowright': walkKeys.right = down; break;
        case 'w': case 'arrowup': walkKeys.forward = down; break;
        case 's': case 'arrowdown': walkKeys.back = down; break;
        case ' ': setWalkHold('keyboard', 'jump', down); break;
        case 'control': setWalkHold('keyboard', 'crouch', down); break;
        case 'shift': setWalkHold('keyboard', 'boost', down); break;
        case 'r': if (down) o.respawn(); break;
        case 'f8': if (down && !e.repeat) o.telemetryToggle(); break;
        case 'm': if (down && !e.repeat) o.telemetryMark(); break;
        case 'escape': if (down) { o.exit(); return; } break;
        default: return;
      }
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    switch (k) {
      case 'a': case 'arrowleft': setHold('keyboard', 'left', down); break;
      case 'd': case 'arrowright': setHold('keyboard', 'right', down); break;
      case 'w': case 'arrowup': setHold('keyboard', 'tuck', down); break;
      case 's': case 'arrowdown': setHold('keyboard', 'brake', down); break;
      case 'shift': setHold('keyboard', 'boost', down); break;
      // charged ollie: press = start charging, release = queue the launch. The step's coyote block cancels a
      // charge held into real air, so a mid-air press never banks a jump.
      case ' ': setOllie('keyboard', down); break;
      case 'r': if (down) o.respawn(); break;
      case 'f8': if (down && !e.repeat) o.telemetryToggle(); break;
      case 'm': if (down && !e.repeat) o.telemetryMark(); break;
      case 'escape': if (down) { o.exit(); return; } break;
      default: return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  const keyDown = (e: KeyboardEvent) => handleKey(e, true);
  const keyUp = (e: KeyboardEvent) => handleKey(e, false);
  const blur = () => releaseKeyboard();

  function attach() {
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
  }

  function detach() {
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
    window.removeEventListener('blur', blur);
    releaseKeyboard();
  }

  return { keys, walkKeys, setHold, setWalkHold, setOllie, releaseSource, clearWalk, attach, detach };
}

export type RideInput = ReturnType<typeof createRideInput>;
