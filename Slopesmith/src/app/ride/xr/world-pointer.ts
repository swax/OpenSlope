import * as THREE from 'three';

/**
 * The right controller as the editor's MOUSE on the mountain (docs/068), while the wrist EDIT palette is open.
 *
 * The editor's pointer router picks from a CLIENT PIXEL: it casts `stage.camera` through it, and measures vertex,
 * edge and marquee picks in screen pixels around it. Rather than teach every tool a second input model, the hand
 * drives that same path. The controller's ray is met with the mountain; that point is projected through the camera
 * the router casts from (which WebXR keeps on the headset's pose), and pointer events go to the canvas at the
 * resulting client position. Hover, click, drag and the gizmo then run exactly the code a mouse runs.
 *
 * What the router sees is therefore the EYE's ray through where the controller points, not the controller's own
 * ray. The two meet at the point the hand is aimed at, and the cursor dot is drawn there, so what the dot covers
 * from the eye is what gets picked. That point is the first thing the laser meets that the editor can pick — the
 * mountain, a prop, a rail, a gizmo handle — not only the ground: met with the ground behind a prop, the eye's ray
 * passed beside the prop by however far the hand sits from the eyes. Where the laser meets nothing, a far point
 * along it stands in.
 *
 * Click slop: pulling a trigger turns the hand a degree or so, and the router turns a press that moves 4 px into a
 * box select. So a press holds the cursor where it went down until the aim has left it by CLICK_SLOP; a release
 * before then is a click on the press point.
 *
 * Pointer capture: the router and TransformControls capture the pointer on a press. A synthetic pointer is not one
 * the browser tracks (a standalone headset browser may have no mouse at all), so capture calls are made inert
 * for the duration of each dispatch; the per-frame moves sent here are what keeps a drag going.
 */

export interface XrWorldPointerDeps {
  /** The canvas the pointer router and gizmo listen on. */
  canvas: HTMLCanvasElement;
  /** The camera the router casts from; the XR session keeps it on the headset's pose. */
  camera(): THREE.Camera;
  /** Nearest point along a world ray on anything the editor picks (surface, scene object, gizmo handle), or null. */
  aimHit(ray: THREE.Ray): THREE.Vector3 | null;
  /** The move gizmo's live translate, if one is being dragged, and a way to put its anchor at a world point:
   *  how the hand moves a held prop or point in depth (hand-drag.ts). */
  translateDrag?(): { anchor: THREE.Object3D; axis: string; space: 'local' | 'world'; snap: number | null } | null;
  driveTranslate?(world: THREE.Vector3): void;
}

/** Chrome's mouse is pointer 1; the router's desktop paths key off `pointerType: 'mouse'`. */
const POINTER_ID = 1;
/** A move smaller than this (CSS px) is not re-sent; a still hand should not re-run hover picking every frame. */
const MOVE_EPSILON_PX = 0.35;
/** How far the aim may wander from a press, seen from the eyes, before the press is a drag (radians). */
export const CLICK_SLOP = THREE.MathUtils.degToRad(2);
const BUTTON_MASK = { 0: 1, 2: 2 } as const;
type Button = 0 | 2;

export function createXrWorldPointer(deps: XrWorldPointerDeps) {
  const { canvas } = deps;
  const point = new THREE.Vector3(), ndc = new THREE.Vector3();
  const eye = new THREE.Vector3(), pressDir = new THREE.Vector3(), aimDir = new THREE.Vector3();
  let inside = false;
  let buttons = 0;
  let last: { x: number; y: number } | null = null;
  let hit = false, located = false;
  /** A press has not yet left CLICK_SLOP: moves are held, so the router still sees it where it went down. */
  let settling = false;

  /** The direction from the eyes to this frame's cursor point. */
  function aimFromEye(out: THREE.Vector3) {
    return out.copy(point).sub(deps.camera().getWorldPosition(eye)).normalize();
  }

  const noCapture = () => {};
  /** Run a dispatch with pointer capture made inert (see the header). Own properties shadow the prototype's. */
  function dispatching(run: () => void) {
    const target = canvas as unknown as Record<string, unknown>;
    target.setPointerCapture = noCapture;
    target.releasePointerCapture = noCapture;
    try { run(); } finally {
      delete target.setPointerCapture;
      delete target.releasePointerCapture;
    }
  }

  function fire(type: string, at: { x: number; y: number }, button: number) {
    const pointer = type.startsWith('pointer');
    const init: MouseEventInit = {
      bubbles: type !== 'pointerenter' && type !== 'pointerleave',
      cancelable: true, composed: true, view: window,
      clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y, button, buttons,
    };
    canvas.dispatchEvent(pointer
      ? new PointerEvent(type, {
        ...init, pointerId: POINTER_ID, pointerType: 'mouse', isPrimary: true, width: 1, height: 1,
        pressure: buttons ? 0.5 : 0,
      })
      : new MouseEvent(type, init));
  }

  /** Where the ray meets what it is aimed at, as a client point on the canvas; null when that point is not in view. */
  function locate(ray: THREE.Ray, farDistance: number): { x: number; y: number } | null {
    const target = deps.aimHit(ray);
    hit = !!target;
    point.copy(target ?? ray.at(farDistance, point));
    ndc.copy(point).project(deps.camera());
    if (!(ndc.z > -1 && ndc.z < 1)) return null; // behind the eyes, or past the far plane
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + (ndc.x + 1) / 2 * rect.width, y: rect.top + (1 - ndc.y) / 2 * rect.height };
  }

  function press(button: Button, at: { x: number; y: number }) {
    if (!buttons) { settling = true; last = at; aimFromEye(pressDir); }
    buttons |= BUTTON_MASK[button];
    fire('pointerdown', at, button);
    fire('mousedown', at, button);
  }

  /** `complete` false when the mouse is being put away mid-press: the up events land, the click does not. */
  function release(button: Button, at: { x: number; y: number }, complete = true) {
    buttons &= ~BUTTON_MASK[button];
    if (!buttons) settling = false;
    fire('pointerup', at, button);
    fire('mouseup', at, button);
    if (complete) fire(button === 0 ? 'click' : 'contextmenu', at, button);
  }

  /**
   * One frame. `ray` is the right aim ray (null while the palette or the watch has it); `left` / `right` are the
   * mouse buttons (trigger / A). A press only starts with the cursor on the canvas; a release always lands, at the
   * last known point if the ray has since gone elsewhere. `farDistance` is where a ray that meets no surface puts
   * the cursor, in world units — the host scales it with the player. `holdMoves` sends no moves: the host is
   * driving a gizmo drag itself (hand-drag.ts), and a move would have the gizmo put it back on its plane.
   */
  function update(ray: THREE.Ray | null, left: boolean, right: boolean, farDistance: number, holdMoves = false) {
    const at = ray ? locate(ray, farDistance) : null;
    located = !!at;
    if (!at) hit = false;
    if (holdMoves) settling = false; // the press took a gizmo handle: it is the hand's drag now, not a click
    dispatching(() => {
      if (at) {
        if (!inside) { fire('pointerover', at, 0); fire('pointerenter', at, 0); inside = true; }
        if (settling && aimFromEye(aimDir).angleTo(pressDir) > CLICK_SLOP) settling = false;
        const moved = !last || Math.abs(at.x - last.x) >= MOVE_EPSILON_PX || Math.abs(at.y - last.y) >= MOVE_EPSILON_PX;
        if (moved && !holdMoves && !settling) {
          last = at;
          fire('pointermove', at, -1);
          fire('mousemove', at, 0);
        }
      }
      // A press still settling lets go where it went down: a click on what it was pressed on.
      const from = settling ? last : at ?? last;
      for (const [button, down] of [[0, left], [2, right]] as const) {
        const held = (buttons & BUTTON_MASK[button]) !== 0;
        if (down && !held && at) press(button, at);
        else if (!down && held && from) release(button, from);
      }
      if (!at && inside && !buttons && last) { fire('pointerout', last, 0); fire('pointerleave', last, 0); inside = false; }
    });
  }

  /** Put the mouse away: release anything held (without moving), and leave the canvas. */
  function reset() {
    if (!last) { buttons = 0; inside = false; return; }
    const at = last;
    dispatching(() => {
      for (const button of [0, 2] as const) if (buttons & BUTTON_MASK[button]) release(button, at, false);
      if (inside) { fire('pointerout', at, 0); fire('pointerleave', at, 0); }
    });
    buttons = 0; inside = false; last = null; hit = false; located = false; settling = false;
  }

  return {
    update, reset,
    /** The world point under the cursor this frame (what the laser met, or the far stand-in), valid while `onCanvas`. */
    get point() { return point; },
    /** Whether the cursor landed on the canvas this frame, and whether the laser met something pickable. */
    get onCanvas() { return located; },
    get onSurface() { return hit; },
    /** A button is held: the drag it started owns the hand until it is released. */
    get pressed() { return buttons !== 0; },
  };
}

export type XrWorldPointer = ReturnType<typeof createXrWorldPointer>;
