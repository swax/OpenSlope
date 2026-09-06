/**
 * The browser's primary-pointer media query describes pointing ACCURACY, not a touchscreen. A Quest controller
 * ray is therefore allowed to look "coarse" even though there is no glass under a thumb. Keep the last real DOM
 * pointer type separately so flat Play can decide whether its direct-touch controls are meaningful.
 */

let lastPointerType = '';

export function noteRidePointerType(pointerType: string | null | undefined): void {
  lastPointerType = typeof pointerType === 'string' ? pointerType : '';
}

export function lastRidePointerWasTouch(): boolean { return lastPointerType === 'touch'; }

/** Safe in tests/server-side imports, where neither `window` nor `matchMedia` need exist. */
export function primaryPointerIsCoarse(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
}

/** A coarse browser panel that can present immersive VR should lead with its native headset launch. */
export function preferImmersivePlay(xrAvailable: boolean | undefined, coarse = primaryPointerIsCoarse()): boolean {
  return xrAvailable === true && coarse;
}

// Loaded with the ride UI at application start, before the Play button can be pressed. Capture sees the launch
// press even when lil-gui stops it later, and optional chaining keeps the tiny Node launch harness browser-free.
if (typeof window !== 'undefined') {
  window.addEventListener?.('pointerdown', event => noteRidePointerType(event.pointerType), true);
}
