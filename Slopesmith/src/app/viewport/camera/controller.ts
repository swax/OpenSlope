import * as THREE from 'three';
import { ViewHelper } from 'three/addons/helpers/ViewHelper.js';
import { WORLD_UP, TWIST_ENGAGE, TOUCH_NONE, MOUSE_NONE, ORTHO_ICON, PERSP_ICON } from '../constants';
import { VIEW_ICON } from '../../ui/components/icons';
import type { RotationSnapStep, SnapStep, ViewState } from '../types';
import type { Stage } from '../stage';
import type { SharedCameraView } from '../../../core/session/screen-share';

type TwistState = { pivot: THREE.Vector3; angle: number; active: boolean };
type StepControl = { row: HTMLDivElement; main: HTMLButtonElement; drop: HTMLButtonElement; menu: HTMLDivElement };
type RestorableView = ViewState & Partial<Pick<SharedCameraView, 'up' | 'fov' | 'near'>>;

/** The world-space pivot for an RMB orbit begun over an active transform handle. Null means the pointer is
 *  not on the gizmo, so ordinary terrain-under-cursor orbit selection should run instead. */
export function hoveredGizmoPivot(gizmo: {
  enabled: boolean;
  axis: string | null;
  object?: THREE.Object3D | null;
}): THREE.Vector3 | null {
  if (!gizmo.enabled || !gizmo.axis || !gizmo.object) return null;
  return gizmo.object.getWorldPosition(new THREE.Vector3());
}

/**
 * Camera navigation: the custom desktop fly (Alt+RMB look + WASD), the ray-cast orbit (RMB / single-finger
 * turntable around the cursor's surface hit), the two-finger twist, the exponential wheel zoom, the
 * perspective ⇄ orthographic toggle, view serialize/restore, and double-click focus (frameSphere). Also owns
 * the upper-right ViewHelper nav-gizmo + its projection button. The shell's pointer dispatch drives the
 * gesture methods and reads `flying` / `orbiting` / `twist`; the render loop reads `viewHelper` + calls
 * `flyMove`. All the shared camera objects (camera / controls / cameras / projection state) live on the Stage.
 */
export function createCameraController(stage: Stage, grid: {
  active: () => boolean;
  toggle: () => void;
  step: () => SnapStep;
  setStep: (step: SnapStep) => void;
  projectionChanged: () => void;
}, snap: {
  active: () => boolean;
  toggle: () => void;
  step: () => SnapStep;
  setStep: (step: SnapStep) => void;
  rotationStep: () => RotationSnapStep;
  setRotationStep: (step: RotationSnapStep) => void;
}) {
  // upper-right navigation gizmo (clickable axis nubs -> snap view) + its own tiny renderer
  let viewHelper!: ViewHelper;
  let gizmoRenderer!: THREE.WebGLRenderer;
  let gizmoCanvas!: HTMLCanvasElement;
  let projBtn!: HTMLButtonElement;
  let gridControl!: StepControl;
  let snapControl!: StepControl;

  // desktop fly (Alt+RMB): look-drag steers, WASD/QE moves (true fly, relative to look), Shift faster
  let flying = false;
  let flySpeed = 160;
  let flyDist = 200; // distance to re-seat the orbit pivot in front of the camera on fly-end
  const flyKeys = { w: false, a: false, s: false, d: false, q: false, e: false, shift: false };

  // RMB (desktop) / single-finger touch orbit: a turntable around the hovered gizmo, otherwise the cursor's
  // surface hit (no recenter)
  let orbiting = false;
  const orbitPivot = new THREE.Vector3();
  let orbitLast = { x: 0, y: 0 }; // last pointer position, for touch orbit deltas (movementX is mouse-only)

  const activePointers = new Set<number>();
  // two-finger twist (touch): live finger positions + the armed gesture — yaw about the pivot when the
  // fingers rotate around each other, riding on top of OrbitControls' simultaneous pinch-zoom / pan
  const touchPts = new Map<number, { x: number; y: number }>();
  let twist: TwistState | null = null;

  // ---- desktop fly (RMB) ----

  function flyKey(e: KeyboardEvent, down: boolean) {
    if (e.key === 'Alt') return; // Alt only gates fly at pointerdown (read live); no OrbitControls remap
    if (!flying) return;
    const t = e.target as HTMLElement | null;
    if (t?.matches?.('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (k === 'shift') flyKeys.shift = down;
    else if (k in flyKeys) (flyKeys as Record<string, boolean>)[k] = down;
    else return;
    e.preventDefault();
  }

  function startFly(e: PointerEvent) {
    flying = true;
    flyDist = stage.camera.position.distanceTo(stage.controls.target) || 200;
    stage.controls.enabled = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  function endFly(e: PointerEvent) {
    flying = false;
    for (const k of Object.keys(flyKeys)) (flyKeys as Record<string, boolean>)[k] = false;
    const dir = stage.camera.getWorldDirection(new THREE.Vector3());
    stage.controls.target.copy(stage.camera.position).addScaledVector(dir, flyDist); // re-seat orbit pivot
    stage.controls.enabled = true;
    stage.controls.update();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  /** FPS look from a mouse delta: yaw about world up, pitch about the camera's right axis (clamped). */
  function applyLook(dx: number, dy: number) {
    const SENS = 0.0026;
    const cam = stage.camera;
    cam.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(WORLD_UP, -dx * SENS));
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const test = cam.quaternion.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * SENS));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(test);
    if (Math.abs(fwd.y) < 0.995) cam.quaternion.copy(test); // stop short of flipping over the poles
  }

  /** WASD/QE translate relative to the look direction (true fly — can go underground). Shift = faster. */
  function flyMove(dt: number) {
    const k = flyKeys;
    const v = new THREE.Vector3((k.d ? 1 : 0) - (k.a ? 1 : 0), (k.e ? 1 : 0) - (k.q ? 1 : 0), (k.s ? 1 : 0) - (k.w ? 1 : 0));
    if (v.lengthSq() === 0) return;
    v.normalize().multiplyScalar(flySpeed * (k.shift ? 4 : 1) * dt).applyQuaternion(stage.camera.quaternion);
    stage.camera.position.add(v);
  }

  /** In fly mode the wheel trims fly speed instead of zooming (the shell routes it here). */
  function trimFlySpeed(deltaY: number) {
    flySpeed = Math.max(10, Math.min(6000, flySpeed * (deltaY < 0 ? 1.1 : 0.9)));
  }

  // ---- orbit (desktop RMB / single-finger touch): rigid turntable around the gesture pivot ----

  function startOrbit(e: PointerEvent) {
    orbitPivot.copy(hoveredGizmoPivot(stage.gizmo)
      ?? stage.pivotAt(e)
      ?? stage.rayPoint(e, stage.camera.position.distanceTo(stage.controls.target)));
    orbiting = true;
    orbitLast = { x: e.clientX, y: e.clientY };
    // desktop: disable OrbitControls while we drive the camera. Touch: keep it ENABLED so a second finger
    // still hands off to OrbitControls' native two-finger pinch / pan.
    if (e.pointerType !== 'touch') stage.controls.enabled = false;
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }

  /** Yaw about world up and pitch about the camera's right axis, both THROUGH the pivot (rigid orbit). */
  function applyOrbit(dx: number, dy: number) {
    const SENS = 0.005;
    const cam = stage.camera, P = orbitPivot;
    const yaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, -dx * SENS);
    cam.position.sub(P).applyQuaternion(yaw).add(P);
    cam.quaternion.premultiply(yaw);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * SENS);
    const q = cam.quaternion.clone().premultiply(pitch);
    const currentFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    // A view snapped exactly onto a pole starts with |currentFwd.y| = 1. Requiring the candidate to clear
    // the pole limit in one pointer event rejects every ordinary 1-2 px move, so RMB orbit can never get
    // started. Always permit motion AWAY from a pole; only reject motion that pushes farther into the limit.
    if (Math.abs(fwd.y) < 0.995 || Math.abs(fwd.y) < Math.abs(currentFwd.y)) {
      cam.position.sub(P).applyQuaternion(pitch).add(P);
      cam.quaternion.copy(q);
    }
  }

  /** Apply an orbit-drag move: desktop reads movementX/Y, touch tracks the delta from the last position
   *  itself (touch pointers don't report movementX/Y reliably). */
  function applyOrbitMove(e: PointerEvent) {
    const touch = e.pointerType === 'touch';
    const dx = touch ? e.clientX - orbitLast.x : (e.movementX || 0);
    const dy = touch ? e.clientY - orbitLast.y : (e.movementY || 0);
    orbitLast = { x: e.clientX, y: e.clientY };
    applyOrbit(dx, dy);
  }

  function endOrbit(e: PointerEvent) {
    orbiting = false;
    reseatTargetAhead(stage.camera.position.distanceTo(orbitPivot)); // pivot ahead: update() won't snap the view
    stage.controls.enabled = true;
    stage.controls.update();
    stage.hidePivot();
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  }

  /** Abort an in-progress orbit (a second finger landed): reseat the pivot ahead so OrbitControls resumes
   *  from a sane pivot, then hand it back (the shell re-enables controls). No-op if not orbiting. */
  function cancelOrbit() {
    if (!orbiting) return;
    orbiting = false;
    reseatTargetAhead(stage.camera.position.distanceTo(orbitPivot));
    stage.hidePivot();
  }

  // ---- two-finger twist (touch): yaw when the fingers rotate around each other ----

  /** Arm the twist for a fresh two-finger gesture: pivot = the surface under the fingers' midpoint
   *  (fallback: a point ahead at the orbit distance) + the starting inter-finger angle. */
  function beginTwist(): TwistState {
    const [a, b] = [...touchPts.values()];
    const mid = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
    const pivot = stage.pivotAt(mid) ?? stage.rayPoint(mid, stage.camera.position.distanceTo(stage.controls.target));
    return { pivot, angle: Math.atan2(b.y - a.y, b.x - a.x), active: false };
  }

  /** Two-finger twist → yaw about the gesture's pivot, so the world follows the fingers. Engages past a
   *  small hysteresis; once engaged it tracks the inter-finger angle 1:1, composing with the pinch-zoom /
   *  pan OrbitControls keeps driving from the same two fingers. */
  function applyTwist() {
    const t = twist!;
    const [a, b] = [...touchPts.values()];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    let d = angle - t.angle;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI; // shortest signed arc
    if (!t.active) {
      if (Math.abs(d) < TWIST_ENGAGE) return; // not a twist yet — just pan / pinch noise
      t.active = true;
      t.angle = angle; // engage from here (no snap through the built-up threshold)
      return;
    }
    t.angle = angle;
    const yaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, d);
    stage.camera.position.sub(t.pivot).applyQuaternion(yaw).add(t.pivot);
    stage.controls.target.sub(t.pivot).applyQuaternion(yaw).add(t.pivot);
  }

  /** Park the orbit pivot straight ahead at `dist` so OrbitControls.update()'s lookAt is a no-op (no view snap). */
  function reseatTargetAhead(dist: number) {
    const fwd = stage.camera.getWorldDirection(new THREE.Vector3());
    stage.controls.target.copy(stage.camera.position).addScaledVector(fwd, Math.max(1, dist));
  }

  // ---- wheel zoom (custom): a constant exponential dolly toward the cursor's surface hit ----

  /**
   * Dolly toward / away from the cursor's surface hit by a FIXED FRACTION of the camera->hit distance
   * per notch (exp). Moving along the camera->hit ray keeps that point under the cursor; orientation is
   * untouched. The pivot is re-seated at the hit's depth so a following pan stays consistent too.
   */
  function wheelZoom(e: WheelEvent) {
    const P = stage.pivotAt(e) ?? stage.rayPoint(e, stage.camera.position.distanceTo(stage.controls.target));
    const dy = e.deltaY * (e.deltaMode === 1 ? 30 : 1); // normalise line-mode wheels toward pixels
    const f = Math.exp(Math.max(-1.2, Math.min(1.2, dy * 0.0016))); // <1 = toward P (wheel up), >1 = away
    if (stage.isOrtho && stage.orthoCam) {
      stage.orthoCam.zoom = Math.max(0.02, stage.orthoCam.zoom / f);
      stage.orthoCam.updateProjectionMatrix();
      return;
    }
    const cam = stage.camera;
    cam.position.sub(P).multiplyScalar(f).add(P); // exponential approach; keeps the hit under the cursor
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    reseatTargetAhead(P.clone().sub(cam.position).dot(fwd)); // pivot at the hit's depth
  }

  /** Re-seat the orbit pivot on the surface straight ahead (screen centre), so OrbitControls' pan / dolly
   *  magnitude tracks the real depth you're looking at rather than the target's drifting distance. */
  function seatTargetAhead() {
    stage.pointer.set(0, 0); // screen centre in NDC = the camera's forward ray
    stage.ray.setFromCamera(stage.pointer, stage.camera);
    const hit = stage.ray.intersectObjects(stage.pickTargets(), false)[0];
    reseatTargetAhead(hit ? stage.camera.position.distanceTo(hit.point) : stage.camera.position.distanceTo(stage.controls.target));
  }

  /**
   * The corner navigation gizmo: three's ViewHelper renders into its required 128×128 canvas, while a CSS-sized
   * frame scales that canvas down on mobile without changing its render or pointer coordinate space. Clicking an
   * axis nub snaps the view down that axis. Under it sits the projection (perspective / orthographic) toggle, then
   * matching Grid / Snap split controls. Their main buttons toggle the feature; the chevrons open the shared
   * 1 / 5 / 10 metre resolution menu.
   */
  function buildGizmo() {
    const cluster = document.createElement('div');
    cluster.className = 'sp-navgizmo'; // fixed placement lives in the stylesheet
    cluster.style.cssText = 'display:flex; flex-direction:column; align-items:flex-end; gap:6px; pointer-events:none;';

    const gizmoFrame = document.createElement('div');
    gizmoFrame.className = 'sp-navgizmo-canvas';
    gizmoCanvas = document.createElement('canvas');
    gizmoCanvas.style.cssText = 'width:128px; height:128px; pointer-events:auto; cursor:pointer;';
    gizmoRenderer = new THREE.WebGLRenderer({ canvas: gizmoCanvas, alpha: true, antialias: true });
    gizmoRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    gizmoRenderer.setSize(128, 128, false);
    gizmoRenderer.setClearColor(0x000000, 0);

    viewHelper = new ViewHelper(stage.camera, gizmoCanvas);
    viewHelper.center = stage.controls.target; // snap orbits around the current view target
    gizmoCanvas.addEventListener('pointerdown', e => { viewHelper.center = stage.controls.target; viewHelper.handleClick(e); });
    gizmoFrame.appendChild(gizmoCanvas);

    const btnColumn = document.createElement('div');
    // stretch to the gizmo canvas width and centre both controls under it (cluster is otherwise right-aligned)
    btnColumn.style.cssText = 'display:flex; flex-direction:column; align-items:center; gap:3px; pointer-events:auto; align-self:stretch;';
    projBtn = document.createElement('button');
    projBtn.className = 'sp-gizmo-btn'; // borderless: label + the current-projection glyph
    projBtn.title = 'Projection — click to switch between perspective and orthographic (parallel) view';
    projBtn.setAttribute('aria-label', 'Toggle perspective / orthographic projection');
    projBtn.onclick = () => setProjection(!stage.isOrtho);

    gridControl = buildStepControl('Grid', VIEW_ICON.grid, 'drafting grid', grid.toggle);
    addStepSection(gridControl, 'Grid', 'grid', [1, 5, 10], v => `${v} m`, v => grid.setStep(v as SnapStep));
    snapControl = buildStepControl('Snap', VIEW_ICON.magnet, 'transform and placement snapping', snap.toggle);
    addStepSection(snapControl, 'Move', 'move', [1, 5, 10], v => `${v} m`, v => snap.setStep(v as SnapStep));
    addStepSection(snapControl, 'Rotate', 'rotate', [5, 15, 45], v => `${v}°`,
      v => snap.setRotationStep(v as RotationSnapStep));
    refreshProjBtn();
    refreshGridBtn();
    refreshSnapBtn();
    btnColumn.append(projBtn, gridControl.row, snapControl.row);

    cluster.append(gizmoFrame, btnColumn);
    document.body.appendChild(cluster);
  }

  /** One compact split row: label + feature icon toggles; the separate chevron opens its increment menu. */
  function buildStepControl(
    label: string, icon: string, noun: string, toggle: () => void,
  ): StepControl {
    const row = document.createElement('div');
    row.className = 'sp-gizmo-step';
    const main = document.createElement('button');
    main.className = 'sp-gizmo-btn sp-gizmo-toggle';
    main.title = `${label} — toggle ${noun}`;
    main.setAttribute('aria-label', `Toggle ${noun}`);
    main.onclick = () => toggle();
    const drop = document.createElement('button');
    drop.className = 'sp-gizmo-btn sp-gizmo-drop';
    drop.title = `${label} increments`;
    drop.setAttribute('aria-label', `Choose ${noun} resolution`);
    drop.setAttribute('aria-haspopup', 'menu');
    drop.innerHTML = VIEW_ICON.chevronDown;
    const menu = document.createElement('div');
    menu.className = 'sp-gizmo-step-menu';
    menu.setAttribute('role', 'menu');
    drop.onclick = e => {
      e.stopPropagation();
      const open = !menu.classList.contains('open');
      for (const m of document.querySelectorAll('.sp-gizmo-step-menu.open')) m.classList.remove('open');
      menu.classList.toggle('open', open);
      drop.setAttribute('aria-expanded', String(open));
    };
    row.addEventListener('pointerdown', e => e.stopPropagation());
    document.addEventListener('pointerdown', e => {
      if (!row.contains(e.target as Node)) { menu.classList.remove('open'); drop.setAttribute('aria-expanded', 'false'); }
    });
    row.append(main, drop, menu);
    return { row, main, drop, menu };
  }

  function addStepSection(
    control: StepControl, title: string, kind: string, values: number[], format: (value: number) => string,
    select: (value: number) => void,
  ) {
    const section = document.createElement('div');
    section.className = 'sp-gizmo-step-section';
    const heading = document.createElement('span');
    heading.textContent = title;
    const choices = document.createElement('div');
    choices.className = 'sp-gizmo-step-choices';
    for (const value of values) {
      const option = document.createElement('button');
      option.type = 'button';
      option.dataset.kind = kind;
      option.dataset.step = String(value);
      option.textContent = format(value);
      option.setAttribute('role', 'menuitemradio');
      option.onclick = e => {
        e.stopPropagation();
        select(value);
        control.menu.classList.remove('open');
        control.drop.setAttribute('aria-expanded', 'false');
      };
      choices.appendChild(option);
    }
    section.append(heading, choices);
    control.menu.appendChild(section);
  }

  function refreshStepControl(
    control: StepControl, label: string, icon: string, active: boolean, selected: Record<string, number>,
  ) {
    control.main.innerHTML = `<span class="sp-gizmo-lbl">${label}</span>${icon}`;
    control.main.classList.toggle('on', active);
    control.main.setAttribute('aria-pressed', String(active));
    for (const option of control.menu.querySelectorAll<HTMLButtonElement>('button')) {
      const on = selected[option.dataset.kind ?? ''] === Number(option.dataset.step);
      option.classList.toggle('on', on); option.setAttribute('aria-checked', String(on));
    }
  }

  /** Repaint the projection button to show the CURRENT projection: the name (Persp / Ortho) then its glyph. */
  function refreshProjBtn() {
    const label = stage.isOrtho ? 'Ortho' : 'Persp';
    projBtn.innerHTML = `<span class="sp-gizmo-lbl">${label}</span>` + (stage.isOrtho ? ORTHO_ICON : PERSP_ICON);
  }

  /** Grid is an orthographic-only aid: hide the control in perspective; white = on, grey = off. */
  function refreshGridBtn() {
    gridControl.row.style.display = stage.isOrtho ? 'flex' : 'none';
    refreshStepControl(gridControl, `Grid ${grid.step()}m`, VIEW_ICON.grid, grid.active(), { grid: grid.step() });
  }

  /** Snap is global and projection-independent, so its row is always present below Grid / Projection. */
  function refreshSnapBtn() {
    refreshStepControl(snapControl, `Snap ${snap.step()}m · ${snap.rotationStep()}°`, VIEW_ICON.magnet, snap.active(),
      { move: snap.step(), rotate: snap.rotationStep() });
  }

  /** Swap the active camera between perspective and orthographic, preserving the framing + target. */
  function setProjection(ortho: boolean) {
    if (ortho === stage.isOrtho) return;
    const w = stage.container.clientWidth || 1, h = stage.container.clientHeight || 1;
    const aspect = w / h;
    const target = stage.controls.target;
    if (ortho) {
      const dist = stage.perspCam.position.distanceTo(target);
      stage.orthoHalfH = dist * Math.tan((stage.perspCam.fov * Math.PI / 180) / 2);
      const cam = new THREE.OrthographicCamera(-stage.orthoHalfH * aspect, stage.orthoHalfH * aspect, stage.orthoHalfH, -stage.orthoHalfH, 0.5, stage.perspCam.far);
      cam.position.copy(stage.perspCam.position);
      cam.quaternion.copy(stage.perspCam.quaternion);
      cam.zoom = 1;
      stage.orthoCam = cam;
      stage.camera = cam;
    } else {
      const o = stage.orthoCam!;
      // carry any ortho zoom back into a matching perspective distance so the view doesn't jump
      const height = (stage.orthoHalfH * 2) / o.zoom;
      const dist = (height / 2) / Math.tan((stage.perspCam.fov * Math.PI / 180) / 2);
      const dir = o.position.clone().sub(target).normalize();
      stage.perspCam.position.copy(target).addScaledVector(dir, dist);
      stage.perspCam.quaternion.copy(o.quaternion);
      stage.camera = stage.perspCam;
    }
    stage.isOrtho = ortho;
    grid.projectionChanged();
    stage.controls.object = stage.camera;
    stage.gizmo.camera = stage.camera; // the gizmo handles ortho + perspective; keep it on the live camera
    stage.controls.update();
    refreshProjBtn(); // show the now-active projection's glyph
    refreshGridBtn();
    viewHelper.dispose();
    viewHelper = new ViewHelper(stage.camera, gizmoCanvas);
    viewHelper.center = stage.controls.target;
  }

  /** Snapshot the camera framing (position, look target, projection, zoom) so a reload can restore the
   *  exact current view. Reads the ACTIVE camera, so it's correct in either projection. */
  function serializeView(): ViewState {
    return {
      pos: [stage.camera.position.x, stage.camera.position.y, stage.camera.position.z],
      target: [stage.controls.target.x, stage.controls.target.y, stage.controls.target.z],
      ortho: stage.isOrtho,
      zoom: stage.isOrtho && stage.orthoCam ? stage.orthoCam.zoom : 1,
      orthoHalfH: stage.orthoHalfH,
    };
  }

  /** The view actually being rendered for screen sharing. During Test the ride owns the perspective camera,
   * while OrbitControls' editor target is deliberately dormant; derive its target from the live world
   * orientation and carry the ride lens rather than serializing that stale editor framing. */
  function serializeSharedView(renderedCamera = false): SharedCameraView {
    const stored = serializeView();
    const camera = stage.camera;
    camera.updateWorldMatrix(true, false);
    const quaternion = camera.getWorldQuaternion(new THREE.Quaternion());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion).normalize();
    const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? (camera as THREE.PerspectiveCamera).fov : stage.perspCam.fov;
    if (!renderedCamera) return {
      ...stored,
      up: [up.x, up.y, up.z],
      fov,
      near: camera.near,
    };
    const pos = camera.getWorldPosition(new THREE.Vector3());
    const target = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(10).add(pos);
    return {
      pos: [pos.x, pos.y, pos.z],
      target: [target.x, target.y, target.z],
      up: [up.x, up.y, up.z],
      ortho: false,
      zoom: 1,
      orthoHalfH: stage.orthoHalfH,
      fov,
      near: camera.near,
    };
  }

  const viewUp = (v: RestorableView): THREE.Vector3 => {
    if (!v.up) return WORLD_UP;
    const up = new THREE.Vector3(v.up[0], v.up[1], v.up[2]);
    return up.lengthSq() > 1e-12 ? up.normalize() : WORLD_UP;
  };

  function applyPerspectiveLens(v: RestorableView): void {
    let changed = false;
    if (v.fov !== undefined && stage.perspCam.fov !== v.fov) {
      stage.perspCam.fov = v.fov;
      changed = true;
    }
    if (v.near !== undefined && stage.perspCam.near !== v.near) {
      stage.perspCam.near = v.near;
      changed = true;
    }
    if (changed) stage.perspCam.updateProjectionMatrix();
  }

  /** Restore a view captured by serializeView. Rebuilds the active camera from scratch so the framing is
   *  reproduced exactly regardless of the current projection. */
  function applyView(v: RestorableView) {
    const target = new THREE.Vector3(v.target[0], v.target[1], v.target[2]);
    const up = viewUp(v);
    stage.controls.target.copy(target);
    stage.orthoHalfH = v.orthoHalfH;
    applyPerspectiveLens(v);

    // seat the perspective camera (the baseline the projection toggle reads from), oriented at the target
    stage.perspCam.up.copy(up);
    stage.perspCam.position.set(v.pos[0], v.pos[1], v.pos[2]);
    stage.perspCam.lookAt(target);

    if (v.ortho) {
      const aspect = (stage.container.clientWidth || 1) / (stage.container.clientHeight || 1);
      const cam = new THREE.OrthographicCamera(
        -stage.orthoHalfH * aspect, stage.orthoHalfH * aspect, stage.orthoHalfH, -stage.orthoHalfH,
        v.near ?? 0.5, stage.perspCam.far);
      cam.up.copy(up);
      cam.position.set(v.pos[0], v.pos[1], v.pos[2]);
      cam.lookAt(target);
      cam.zoom = v.zoom;
      cam.updateProjectionMatrix();
      stage.orthoCam = cam;
      stage.camera = cam;
    } else {
      stage.orthoCam = null;
      stage.camera = stage.perspCam;
    }
    stage.isOrtho = v.ortho;
    grid.projectionChanged();
    stage.controls.object = stage.camera;
    stage.gizmo.camera = stage.camera;
    refreshProjBtn(); // show the restored projection's glyph
    refreshGridBtn();
    stage.controls.update();
    // rebuild the upper-right nav gizmo on the now-active camera
    viewHelper.dispose();
    viewHelper = new ViewHelper(stage.camera, gizmoCanvas);
    viewHelper.center = stage.controls.target;
  }

  /**
   * Apply a live shared-camera sample. Ordinary frames keep the active camera and ViewHelper in place; only a
   * projection transition needs the heavier restore path that swaps the camera object and rebuilds the gizmo.
   */
  function followView(v: RestorableView) {
    if (v.ortho !== stage.isOrtho) { applyView(v); return; }
    const target = new THREE.Vector3(v.target[0], v.target[1], v.target[2]);
    const up = viewUp(v);
    stage.controls.target.copy(target);
    stage.orthoHalfH = v.orthoHalfH;
    applyPerspectiveLens(v);
    stage.perspCam.position.set(v.pos[0], v.pos[1], v.pos[2]);
    stage.perspCam.up.copy(up);
    stage.perspCam.lookAt(target);
    if (stage.isOrtho && stage.orthoCam) {
      const aspect = (stage.container.clientWidth || 1) / (stage.container.clientHeight || 1);
      stage.orthoCam.left = -v.orthoHalfH * aspect;
      stage.orthoCam.right = v.orthoHalfH * aspect;
      stage.orthoCam.top = v.orthoHalfH;
      stage.orthoCam.bottom = -v.orthoHalfH;
      stage.orthoCam.position.set(v.pos[0], v.pos[1], v.pos[2]);
      stage.orthoCam.up.copy(up);
      stage.orthoCam.lookAt(target);
      stage.orthoCam.zoom = v.zoom;
      if (v.near !== undefined) stage.orthoCam.near = v.near;
      stage.orthoCam.updateProjectionMatrix();
    }
    stage.controls.update();
    viewHelper.center = stage.controls.target;
  }

  /** Point the camera at `center` and dolly so a sphere of `radius` around it fills the view, KEEPING the
   *  current viewing direction (a Unity-style "frame selected"). Used by double-click-to-focus. */
  function frameSphere(center: THREE.Vector3, radius: number) {
    radius = Math.max(radius, 1);
    const dir = stage.camera.getWorldDirection(new THREE.Vector3());
    if (dir.lengthSq() < 1e-6) dir.set(1, -1, 1).normalize(); // degenerate guard
    stage.controls.target.copy(center);
    if (stage.isOrtho && stage.orthoCam) {
      stage.orthoCam.position.copy(center).addScaledVector(dir, -radius * 3);
      stage.orthoCam.zoom = stage.orthoHalfH / (radius * 1.15);
      stage.orthoCam.updateProjectionMatrix();
    } else {
      const aspect = (stage.container.clientWidth || 1) / (stage.container.clientHeight || 1);
      const halfFov = (stage.perspCam.fov * Math.PI) / 360; // vertical half-fov in radians
      const fit = Math.tan(halfFov) * Math.min(1, aspect); // tangent of the tighter (limiting) axis
      stage.camera.position.copy(center).addScaledVector(dir, -(radius * 1.15) / Math.max(1e-3, fit));
    }
    stage.camera.lookAt(center);
    stage.controls.update();
  }

  /** Place the active editor camera at an exact world-space eye and point it at an exact target. */
  function lookFrom(eye: THREE.Vector3, target: THREE.Vector3) {
    stage.controls.target.copy(target);
    stage.camera.up.copy(WORLD_UP);
    stage.camera.position.copy(eye);
    stage.camera.lookAt(target);
    stage.controls.update();
    viewHelper.center = stage.controls.target;
  }

  buildGizmo(); // upper-right axis gizmo + projection button
  // single finger is ours (custom ray-cast orbit in nav modes, or paint / sculpt); OrbitControls only
  // drives the two-finger pinch-zoom / pan, so its one-finger slot stays disabled (see updateTouch).
  stage.controls.touches = { ONE: TOUCH_NONE, TWO: THREE.TOUCH.DOLLY_PAN };
  // Desktop mouse: plain LMB selects / paints / sculpts (never moves the camera); RMB-drag orbits; Alt+RMB
  // flies; MMB pans. OrbitControls keeps MMB pan + two-finger touch; RMB orbit + Alt+RMB
  // fly are our own; the desktop wheel zoom is custom (the shell owns the wheel listener).
  stage.controls.mouseButtons = { LEFT: MOUSE_NONE, MIDDLE: THREE.MOUSE.PAN, RIGHT: MOUSE_NONE };
  stage.controls.zoomToCursor = true; // still used by two-finger pinch (we own the desktop wheel)

  return {
    get viewHelper() { return viewHelper; },
    get gizmoRenderer() { return gizmoRenderer; },
    get flying() { return flying; },
    get orbiting() { return orbiting; },
    get activePointers() { return activePointers; },
    get touchPts() { return touchPts; },
    get twist() { return twist; },
    set twist(v: TwistState | null) { twist = v; },
    flyKey, startFly, endFly, applyLook, flyMove, trimFlySpeed,
    startOrbit, applyOrbit, applyOrbitMove, endOrbit, cancelOrbit,
    beginTwist, applyTwist, reseatTargetAhead, wheelZoom, seatTargetAhead,
    setProjection, serializeView, serializeSharedView, applyView, followView, frameSphere, lookFrom,
    refreshGridBtn, refreshSnapBtn,
  };
}

export type CameraController = ReturnType<typeof createCameraController>;
