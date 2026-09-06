/**
 * Desktop test-ride cursor ownership. First person keeps the cursor captured until Escape, then any viewport
 * click captures it again. Third person captures only for the duration of an RMB look.
 */
export interface RidePointerLockOpts {
  target: HTMLElement;
  onMove(deltaX: number, deltaY: number): void;
}

// A real high-speed mouse move arrives as several events. A single larger jump is characteristic of the
// synthetic cursor-warp delta Chromium / some Windows drivers can emit as pointer lock or window focus settles.
const MAX_TRUSTED_MOVEMENT = 160;

export function createRidePointerLock(o: RidePointerLockOpts) {
  const doc = o.target.ownerDocument;
  let attached = false;
  let firstPerson = false;
  let rightHeld = false;
  let requestPending = false;
  let suppressNextMove = false;

  const supported = typeof o.target.requestPointerLock === 'function'
    && (doc.defaultView?.matchMedia?.('(pointer: fine)').matches ?? true);
  const locked = () => doc.pointerLockElement === o.target;

  function release() {
    if (locked()) doc.exitPointerLock?.();
  }

  function wantsLock() {
    return firstPerson || rightHeld;
  }

  function request() {
    if (!attached || !supported || !wantsLock() || locked() || requestPending || doc.visibilityState === 'hidden') return;
    requestPending = true;
    try {
      const result = o.target.requestPointerLock() as void | Promise<void>;
      if (result && typeof result.then === 'function') {
        void result.catch(() => {}).finally(() => {
          requestPending = false;
          // A request can finish after Stop has already torn the ride down.
          if ((!attached || !wantsLock()) && locked()) release();
        });
      }
      // The void-returning form reports completion through pointerlockchange / pointerlockerror.
    } catch {
      requestPending = false;
    }
  }

  function keyDown(event: KeyboardEvent) {
    // Unlocked Escape deliberately falls through to the ride input: a second press exits back to Test setup.
    if (event.key === 'Escape' && locked()) {
      release();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function mouseMove(event: MouseEvent) {
    if (!locked()) return;
    const deltaX = Number(event.movementX), deltaY = Number(event.movementY);
    if (suppressNextMove) { suppressNextMove = false; return; }
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)
      || Math.abs(deltaX) > MAX_TRUSTED_MOVEMENT || Math.abs(deltaY) > MAX_TRUSTED_MOVEMENT) return;
    if (deltaX || deltaY) o.onMove(deltaX, deltaY);
  }

  function mouseDown(event: MouseEvent) {
    if (event.button === 2) rightHeld = true;
    if (!firstPerson && event.button !== 2) return;
    request();
  }

  function mouseUp(event: MouseEvent) {
    if (event.button !== 2) return;
    rightHeld = false;
    if (!firstPerson) release();
  }

  function lockChanged() {
    requestPending = false;
    // The first event after capture can describe the browser warping its hidden cursor, not physical motion.
    suppressNextMove = locked();
    if ((!attached || !wantsLock()) && locked()) release();
  }

  function lockError() {
    requestPending = false;
  }

  function windowFocused() {
    if (locked()) suppressNextMove = true;
  }

  function setFirstPerson(enabled: boolean) {
    if (firstPerson === enabled) return;
    firstPerson = enabled;
    if (firstPerson) request();
    else if (rightHeld) request();
    else release();
  }

  function attach() {
    if (attached || !supported) return;
    attached = true;
    doc.addEventListener('keydown', keyDown, true);
    doc.addEventListener('mousemove', mouseMove);
    doc.addEventListener('mouseup', mouseUp, true);
    doc.addEventListener('pointerlockchange', lockChanged);
    doc.addEventListener('pointerlockerror', lockError);
    doc.defaultView?.addEventListener('focus', windowFocused);
    o.target.addEventListener('mousedown', mouseDown, true);
    if (firstPerson) request();
  }

  function detach() {
    if (!attached) return;
    attached = false;
    rightHeld = false;
    doc.removeEventListener('keydown', keyDown, true);
    doc.removeEventListener('mousemove', mouseMove);
    doc.removeEventListener('mouseup', mouseUp, true);
    doc.removeEventListener('pointerlockchange', lockChanged);
    doc.removeEventListener('pointerlockerror', lockError);
    doc.defaultView?.removeEventListener('focus', windowFocused);
    o.target.removeEventListener('mousedown', mouseDown, true);
    release();
  }

  return {
    attach, detach, request, setFirstPerson,
    get supported() { return supported; },
    get locked() { return locked(); },
    get firstPerson() { return firstPerson; },
  };
}

export type RidePointerLock = ReturnType<typeof createRidePointerLock>;
