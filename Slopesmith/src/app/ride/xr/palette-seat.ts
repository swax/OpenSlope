import * as THREE from 'three';

/**
 * The placement bar over the VR EDIT palette (docs/068): IN / OUT, LEFT / RIGHT, UP / DOWN, BIGGER / SMALLER,
 * TILT IN / TILT OUT and RESET, with a readout of the seat they give underneath. It is there to find the palette's
 * seat by hand in the headset and read off the numbers that become the defaults (`XR_EDIT_PALETTE_SEAT` and
 * `XR_EDIT_METRES_PER_PX` in edit-palette.ts).
 *
 * Moves are in the left controller's grip space, the frame those defaults are written in: IN is toward the eyes
 * (+Z), RIGHT is +X, UP is the back of the hand (+Y). TILT IN turns the palette's top edge up toward the eyes. Size
 * scales the panels away from the watch they surround; the bar keeps its own size so it stays usable at any size.
 *
 * A moved seat is kept in localStorage together with the defaults it was moved from. It survives leaving EDIT, a
 * session swap and a reload, and lapses on its own once different defaults ship.
 */

export interface XrPaletteSeat {
  /** The seat in grip space, metres: the palette's origin, which by default is the watch's top-left corner. */
  x: number; y: number; z: number;
  /** Lean about the grip's X axis, radians. Negative leans the top edge away from the eyes. */
  tilt: number;
  /** Multiplier on the palette's metres per CSS pixel. */
  scale: number;
}

export type XrPaletteSeatAction =
  | 'in' | 'out' | 'left' | 'right' | 'up' | 'down' | 'bigger' | 'smaller' | 'tilt-in' | 'tilt-out' | 'reset';

export const XR_PALETTE_SEAT_STEP = 0.01;
export const XR_PALETTE_TILT_STEP = Math.PI / 72;
export const XR_PALETTE_SIZE_STEP = 1.05;
const MIN_SCALE = 0.25, MAX_SCALE = 4;
/** A held button repeats after this long, this many times a second. */
const REPEAT_DELAY_S = 0.35, REPEAT_HZ = 12;
const STORAGE_KEY = 'slopesmith-xr-palette-seat-v1';

/** Tenth-of-a-millimetre grid, so a run of 1 cm steps reads back as round numbers. */
const snap = (value: number) => Math.round(value * 1e4) / 1e4;

export function stepPaletteSeat(seat: XrPaletteSeat, action: XrPaletteSeatAction,
                                defaults: XrPaletteSeat): XrPaletteSeat {
  const next = { ...seat };
  switch (action) {
    case 'in': next.z = snap(seat.z + XR_PALETTE_SEAT_STEP); break;
    case 'out': next.z = snap(seat.z - XR_PALETTE_SEAT_STEP); break;
    case 'left': next.x = snap(seat.x - XR_PALETTE_SEAT_STEP); break;
    case 'right': next.x = snap(seat.x + XR_PALETTE_SEAT_STEP); break;
    case 'up': next.y = snap(seat.y + XR_PALETTE_SEAT_STEP); break;
    case 'down': next.y = snap(seat.y - XR_PALETTE_SEAT_STEP); break;
    case 'bigger': next.scale = Math.min(MAX_SCALE, seat.scale * XR_PALETTE_SIZE_STEP); break;
    case 'smaller': next.scale = Math.max(MIN_SCALE, seat.scale / XR_PALETTE_SIZE_STEP); break;
    case 'tilt-in': next.tilt = seat.tilt + XR_PALETTE_TILT_STEP; break;
    case 'tilt-out': next.tilt = seat.tilt - XR_PALETTE_TILT_STEP; break;
    case 'reset': return { ...defaults };
  }
  return next;
}

const SEAT_KEYS = ['x', 'y', 'z', 'tilt', 'scale'] as const;

function isSeat(value: unknown): value is XrPaletteSeat {
  if (!value || typeof value !== 'object') return false;
  const seat = value as Record<string, unknown>;
  return SEAT_KEYS.every(key => typeof seat[key] === 'number' && Number.isFinite(seat[key]));
}

export function samePaletteSeat(a: XrPaletteSeat, b: XrPaletteSeat): boolean {
  return SEAT_KEYS.every(key => Math.abs(a[key] - b[key]) < 1e-9);
}

export function loadPaletteSeat(defaults: XrPaletteSeat): XrPaletteSeat {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as { defaults?: unknown; seat?: unknown } | null;
    if (parsed && isSeat(parsed.defaults) && samePaletteSeat(parsed.defaults, defaults) && isSeat(parsed.seat)) {
      return { ...parsed.seat, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, parsed.seat.scale)) };
    }
  } catch { /* disabled storage, or none at all */ }
  return { ...defaults };
}

export function savePaletteSeat(seat: XrPaletteSeat, defaults: XrPaletteSeat): void {
  try {
    if (samePaletteSeat(seat, defaults)) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify({ defaults, seat }));
  } catch { /* disabled/full storage */ }
}

// ---------------------------------------------------------------------------------------------------------------
// the bar

const BAR_W = 1280, BAR_H = 176;
/** 0.44 mm per canvas pixel: buttons about 45 × 32 mm, easy to hold a laser on at arm's length. */
export const XR_PALETTE_SEAT_BAR_METRES = 0.56;
const MARGIN = 12, INNER_GAP = 6, GROUP_GAP = 20, BUTTON_Y = 10, BUTTON_H = 72;
/** Invisible acquisition margin: half the gap between paired buttons, so no point belongs to two. */
const HIT_PAD = INNER_GAP / 2;

const GROUPS: ReadonlyArray<ReadonlyArray<readonly [XrPaletteSeatAction, string]>> = [
  [['in', 'IN'], ['out', 'OUT']],
  [['left', 'LEFT'], ['right', 'RIGHT']],
  [['up', 'UP'], ['down', 'DOWN']],
  [['bigger', 'BIGGER'], ['smaller', 'SMALLER']],
  [['tilt-in', 'TILT IN'], ['tilt-out', 'TILT OUT']],
  [['reset', 'RESET']],
];

export interface XrPaletteSeatButton { action: XrPaletteSeatAction; label: string; x: number; y: number; w: number; h: number }

/** The row of buttons in canvas pixels, left to right, pairs a little apart from each other. */
export const XR_PALETTE_SEAT_BUTTONS: ReadonlyArray<XrPaletteSeatButton> = (() => {
  const count = GROUPS.reduce((sum, group) => sum + group.length, 0);
  const gaps = GROUPS.reduce((sum, group) => sum + (group.length - 1) * INNER_GAP, 0) + (GROUPS.length - 1) * GROUP_GAP;
  const w = (BAR_W - 2 * MARGIN - gaps) / count;
  const buttons: XrPaletteSeatButton[] = [];
  let x = MARGIN;
  GROUPS.forEach((group, index) => {
    if (index) x += GROUP_GAP - INNER_GAP;
    for (const [action, label] of group) {
      buttons.push({ action, label, x, y: BUTTON_Y, w, h: BUTTON_H });
      x += w + INNER_GAP;
    }
  });
  return buttons;
})();

/** The button under a texture UV (three's: v runs up), or null between and below them. */
export function paletteSeatActionAt(u: number, v: number): XrPaletteSeatAction | null {
  const x = u * BAR_W, y = (1 - v) * BAR_H;
  const button = XR_PALETTE_SEAT_BUTTONS.find(b =>
    x >= b.x - HIT_PAD && x <= b.x + b.w + HIT_PAD && y >= b.y - HIT_PAD && y <= b.y + b.h + HIT_PAD);
  return button?.action ?? null;
}

export function createXrPaletteSeatBar(options: { metresPerPx: number; renderOrder: number }) {
  const canvas = document.createElement('canvas');
  canvas.width = BAR_W; canvas.height = BAR_H;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const width = XR_PALETTE_SEAT_BAR_METRES, height = XR_PALETTE_SEAT_BAR_METRES * BAR_H / BAR_W;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  }));
  mesh.name = 'xr-edit-palette-seat';
  mesh.renderOrder = options.renderOrder;
  const raycaster = new THREE.Raycaster();
  let hovered: XrPaletteSeatAction | null = null, held: XrPaletteSeatAction | null = null;
  let wasPressed = false, repeatIn = 0, painted = '';

  /** Where a ray meets the bar, and the button there (null between buttons: still the bar's, not the world's). */
  function cast(ray: THREE.Ray): { action: XrPaletteSeatAction | null; point: THREE.Vector3 } | null {
    if (!mesh.visible) return null;
    raycaster.ray.copy(ray);
    mesh.updateWorldMatrix(true, false);
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit?.uv) return null;
    return { action: paletteSeatActionAt(hit.uv.x, hit.uv.y), point: hit.point };
  }

  /**
   * One frame of the trigger. A press on a button acts at once; holding it repeats that button wherever the laser
   * goes (the palette moves out from under a held UP), until the trigger is let go. Returns the action to apply
   * this frame, if any.
   */
  function press(over: XrPaletteSeatAction | null, pressed: boolean, dt: number): XrPaletteSeatAction | null {
    hovered = over;
    let fire: XrPaletteSeatAction | null = null;
    if (pressed && !wasPressed && over) {
      held = fire = over;
      repeatIn = REPEAT_DELAY_S;
    } else if (pressed && held && held !== 'reset') {
      repeatIn -= Math.min(dt, 0.1);
      if (repeatIn <= 0) { repeatIn += 1 / REPEAT_HZ; fire = held; }
    }
    if (!pressed) held = null;
    wasPressed = pressed;
    return fire;
  }

  const signed = (value: number, digits: number) => `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(digits)}`;

  /** Repaint when anything drawn has changed. `size` is the palette as worn, metres. */
  function paint(seat: XrPaletteSeat, moved: boolean, size: { width: number; height: number }) {
    const degrees = seat.tilt * 180 / Math.PI;
    const line1 = `x ${signed(seat.x, 3)}  y ${signed(seat.y, 3)}  z ${signed(seat.z, 3)} m   tilt ${signed(degrees, 1)}°`
      + `   size ${seat.scale.toFixed(2)}× = ${(options.metresPerPx * seat.scale * 1000).toFixed(2)} mm/px`;
    const line2 = `palette ${size.width.toFixed(2)} × ${size.height.toFixed(2)} m · `
      + `${moved ? 'moved · RESET returns to the default' : 'default seat'} · hold a button to repeat`;
    const key = `${hovered}|${held}|${line1}|${line2}`;
    if (key === painted) return;
    painted = key;
    ctx.clearRect(0, 0, BAR_W, BAR_H);
    ctx.fillStyle = 'rgba(10,16,24,0.82)';
    ctx.beginPath();
    ctx.roundRect(2, 2, BAR_W - 4, BAR_H - 4, 14);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 22px system-ui, sans-serif';
    for (const button of XR_PALETTE_SEAT_BUTTONS) {
      const active = button.action === held, over = button.action === hovered;
      ctx.fillStyle = active ? '#ffd24a' : over ? '#2f4f6e' : '#1b2a3a';
      ctx.beginPath();
      ctx.roundRect(button.x, button.y, button.w, button.h, 10);
      ctx.fill();
      ctx.strokeStyle = over || active ? '#8fd7ff' : '#3a5a78';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = active ? '#10161e' : '#eaf4ff';
      ctx.fillText(button.label, button.x + button.w / 2, button.y + button.h / 2 + 1, button.w - 8);
    }
    ctx.textAlign = 'left';
    ctx.font = '600 26px ui-monospace, Consolas, monospace';
    ctx.fillStyle = moved ? '#ffd24a' : '#eaf4ff';
    ctx.fillText(line1, 18, 114, BAR_W - 36);
    ctx.font = '500 22px system-ui, sans-serif';
    ctx.fillStyle = '#9fb6cc';
    ctx.fillText(line2, 18, 150, BAR_W - 36);
    texture.needsUpdate = true;
  }

  function reset() { hovered = held = null; wasPressed = false; }

  function dispose() {
    mesh.geometry.dispose(); mesh.material.dispose(); texture.dispose();
    mesh.removeFromParent();
  }

  return { object: mesh as THREE.Object3D, width, height, cast, press, paint, reset, dispose };
}

export type XrPaletteSeatBar = ReturnType<typeof createXrPaletteSeatBar>;
