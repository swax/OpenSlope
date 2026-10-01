import * as THREE from 'three';
import {
  createDomMirror, createDomPointer, partUvRect, type DomMirror, type DomMirrorSpec, type DomPointerTarget, type Rect,
} from './dom-mirror';
import { normalizeAxis } from './input';
import { XR_WATCH_HEIGHT, XR_WATCH_POSITION, XR_WATCH_TILT, XR_WATCH_WIDTH } from './hud';
import {
  createXrPaletteSeatBar, loadPaletteSeat, samePaletteSeat, savePaletteSeat, stepPaletteSeat, type XrPaletteSeat,
} from './palette-seat';

/**
 * The wrist EDIT palette (docs/068): the editor's real file/undo, mode and view buttons, its current toolbox and
 * its colour keys, worn on the left controller the way a painting app wears its palette, and pressed with the right
 * controller's ray.
 *
 * Every pixel is the page's own (`dom-mirror.ts`); this module only places those images in the world and turns
 * ray hits into page coordinates. It is a PROOF OF CONCEPT for exactly that question — whether the real DOM can be
 * shown and driven in a headset cheaply enough — so it carries its own measurements: each panel's repaint cost is
 * printed along the palette's top edge, together with whether the page's `requestAnimationFrame` is still running
 * (standalone headset browsers may pause it during an immersive session, which would stall lil-gui's live rows and
 * the editor's rebuild funnel as well as this).
 *
 * Editing the WORLD from the headset is not here: the toolbox changes settings, but a brush stroke still needs the
 * controller ray to reach the pointer router (docs/068 ▸ Next).
 */

export type XrEditMirrorId = 'bar' | 'tools' | 'legend' | 'texlib' | 'proplib' | 'texlib-tab' | 'proplib-tab';

/** What the palette shows: the top bar's File/undo, Mode and View groups, the whole right-hand toolbox, the
 *  lower-left colour keys, and the bottom libraries — or, while one is closed in its own mode, its pull-up tab
 *  (dock-tab.ts). Parts are the `data-xr-edit` keys those panels carry (top-bar.ts, legends.ts). A panel that is
 *  not on the page (a library outside its mode) simply has no image, and takes no palette space. */
export const XR_EDIT_MIRRORS: ReadonlyArray<DomMirrorSpec & { id: XrEditMirrorId }> = [
  { id: 'bar', rootId: 'dock-top', parts: ['file', 'mode', 'view'] },
  { id: 'tools', rootId: 'dock-right', parts: null },
  { id: 'legend', rootId: 'lowerleft', parts: ['legend'] },
  { id: 'texlib', rootId: 'texture-library', parts: null },
  { id: 'proplib', rootId: 'prop-library', parts: null },
  { id: 'texlib-tab', rootId: 'texture-library-tab', parts: null, ownBox: true },
  { id: 'proplib-tab', rootId: 'prop-library-tab', parts: null, ownBox: true },
];
/** Tabs stand upright beside the toolbox, turned a quarter clockwise: the label reads downward and the tab's
 *  pull-up caret points out, away from the toolbox, toward where the library opens. */
const TAB_ROLL = -Math.PI / 2;

/**
 * Metres per CSS pixel. 0.8 mm — doubled after the first headset pass, where 0.4 mm read small — puts the
 * toolbox's 11–12 px text about 9 mm tall and the 300 px toolbox 24 cm wide.
 */
export const XR_EDIT_METRES_PER_PX = 0.0008;
/** Space between panels on the palette. */
const GAP = 0.016;
/** Full right-stick deflection scrolls this many CSS pixels a second. */
const SCROLL_PX_PER_S = 900;
/**
 * Where the palette sits on the left controller, in its grip space (+X toward the body, +Y the back of the hand,
 * −Z toward the fingers). The palette's origin is the watch's top-left corner (`layoutAroundWatch`), so by default
 * it lies in the watch's own plane and is laid out around it.
 *
 * Earlier headset passes hung it on a seat of its own, below the hand and leaning away at 45°. The placement-bar
 * pass (2026-09-30) brought it flat into the watch's plane, with the toolbox just left of the watch and the menus
 * over both. That is now the layout by construction, not by numbers. The placement bar (palette-seat.ts) still
 * moves, sizes and tilts it from here in the headset, and reads out where it went.
 */
export const XR_EDIT_PALETTE_SEAT: Readonly<XrPaletteSeat> = {
  x: XR_WATCH_POSITION[0] - XR_WATCH_WIDTH / 2,
  y: XR_WATCH_POSITION[1] + Math.cos(XR_WATCH_TILT) * XR_WATCH_HEIGHT / 2,
  z: XR_WATCH_POSITION[2] + Math.sin(XR_WATCH_TILT) * XR_WATCH_HEIGHT / 2,
  tilt: XR_WATCH_TILT, scale: 1,
};
/** Status strip along the palette's top: two lines of 24 px text. */
const STATUS_W = 1024, STATUS_H = 72, STATUS_METRES = 0.44;
const STATUS_HZ = 2;
const LOG_MS = 5000;
const RENDER_ORDER = 32;

export interface PaletteItem { w: number; h: number }
export interface PalettePlacement { x: number; y: number; w: number; h: number }

export interface WatchLayout {
  stack: (PalettePlacement | null)[];
  tools: PalettePlacement | null;
  legend: PalettePlacement | null;
  docked: (PalettePlacement | null)[];
  /** The extent of everything laid out, the watch included. */
  left: number; right: number; top: number; bottom: number;
}

/**
 * The palette laid out around the watch, in the watch's plane. Placements are item CENTRES in metres, with the
 * origin at the watch's top-left corner and +Y toward the watch's top edge:
 *
 * - the toolbox stands left of the watch, top edges level;
 * - the `stack` rows (status, File, Mode, View, top to bottom) rise from just above both, left-aligned with the
 *   toolbox and touching, so the strips read as one bar;
 * - the colour keys stand right of the watch, top edges level;
 * - the docked items (an open library, or a closed one's tab) stand side by side right of the toolbox, on its
 *   bottom edge, or lower where that edge is too high for them to clear the watch and the keys.
 *
 * A mode switch changes the toolbox, the keys and the docked items, and each only grows away from the watch.
 * Nothing above the watch or beside it moves. Missing items take no space.
 */
export function layoutAroundWatch(parts: {
  stack: ReadonlyArray<PaletteItem | null>; tools: PaletteItem | null; legend: PaletteItem | null;
  docked: ReadonlyArray<PaletteItem | null>;
}, watch: PaletteItem, gap: number): WatchLayout {
  const { tools, legend } = parts;
  const at = (x: number, top: number, item: PaletteItem): PalettePlacement =>
    ({ x: x + item.w / 2, y: top - item.h / 2, w: item.w, h: item.h });
  const left = tools ? -gap - tools.w : 0;
  let right = watch.w, bottom = -watch.h;
  let rise = gap, top = 0; // the bottom of the next stack row up, and the top of the stack so far
  const stack: (PalettePlacement | null)[] = parts.stack.map(() => null);
  for (let i = parts.stack.length - 1; i >= 0; i--) {
    const item = parts.stack[i];
    if (!item) continue;
    stack[i] = at(left, rise + item.h, item);
    right = Math.max(right, left + item.w);
    rise += item.h;
    top = rise;
  }
  const legendAt = legend && at(watch.w + gap, 0, legend);
  if (legend) { right = Math.max(right, watch.w + gap + legend.w); bottom = Math.min(bottom, -legend.h); }
  if (tools) bottom = Math.min(bottom, -tools.h);
  const dockH = parts.docked.reduce((max, item) => Math.max(max, item?.h ?? 0), 0);
  const floor = Math.min(-(tools?.h ?? 0), -Math.max(watch.h, legend?.h ?? 0) - gap - dockH);
  let x = 0;
  const docked = parts.docked.map(item => {
    if (!item) return null;
    const placement = at(x, floor + item.h, item);
    right = Math.max(right, x + item.w);
    bottom = Math.min(bottom, floor);
    x += item.w + gap;
    return placement;
  });
  return {
    stack, tools: tools && at(left, 0, tools), legend: legendAt, docked,
    left, right, top, bottom,
  };
}

interface Slot {
  id: XrEditMirrorId;
  mirror: DomMirror;
  texture: THREE.CanvasTexture | null;
  textureSize: [number, number];
  version: number;
  planes: Map<string | null, PartPlane>;
}

interface PartPlane {
  slot: Slot;
  key: string | null;
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  /** Client rect the part occupied in the image on show, and its UV window in that image. */
  rect: Rect;
  uv: [number, number, number, number];
}

export function createXrEditPalette() {
  const object = new THREE.Group();
  object.name = 'xr-edit-palette';
  object.visible = false;
  let seat = loadPaletteSeat(XR_EDIT_PALETTE_SEAT);
  // The placement bar sits over the top strip and keeps its own size, however the palette is sized. It shows
  // only while the watch's MOVE UI is on (`setPlacing`).
  const seatBar = createXrPaletteSeatBar({ metresPerPx: XR_EDIT_METRES_PER_PX, renderOrder: RENDER_ORDER });
  seatBar.object.visible = false;
  object.add(seatBar.object);
  const pointer = createDomPointer();
  // Unbounded: the palette rides the rig, which grows with the player (world-grab.ts).
  const raycaster = new THREE.Raycaster();
  const slots: Slot[] = XR_EDIT_MIRRORS.map(spec => ({
    id: spec.id, mirror: createDomMirror(spec), texture: null, textureSize: [0, 0], version: -1, planes: new Map(),
  }));
  const hitTargets: THREE.Object3D[] = [];
  let open = false, relayout = true, cursor = 0, width = 0, height = 0;
  let dragPlane: PartPlane | null = null, hoverPlane: PartPlane | null = null;

  // Hover / press frame over the control a trigger would act on. Parented to whichever part plane it is on, in
  // that plane's unit square, so it needs no metric bookkeeping of its own.
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0x8fd7ff, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const highlight = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), highlightMaterial);
  highlight.renderOrder = RENDER_ORDER + 1;
  highlight.raycast = () => {};
  highlight.visible = false;

  const statusCanvas = document.createElement('canvas');
  statusCanvas.width = STATUS_W; statusCanvas.height = STATUS_H;
  const statusCtx = statusCanvas.getContext('2d')!;
  const statusTexture = new THREE.CanvasTexture(statusCanvas);
  statusTexture.colorSpace = THREE.SRGBColorSpace;
  const status = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
    map: statusTexture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  }));
  status.renderOrder = RENDER_ORDER;
  status.raycast = () => {};
  object.add(status);
  let nextStatus = 0, nextLog = 0;

  // Page requestAnimationFrame liveness: counted only while the palette is open.
  let rafFrames = 0, rafHandle = 0, rafSince = 0, rafRate = -1;
  const onPageFrame = () => { rafFrames++; if (open) rafHandle = requestAnimationFrame(onPageFrame); };

  function createPlane(slot: Slot, key: string | null): PartPlane {
    const material = new THREE.MeshBasicMaterial({
      map: slot.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    mesh.renderOrder = RENDER_ORDER;
    mesh.name = `xr-edit-${slot.id}${key ? `-${key}` : ''}`;
    const plane: PartPlane = { slot, key, mesh, rect: { x: 0, y: 0, width: 1, height: 1 }, uv: [0, 0, 1, 1] };
    mesh.userData.palettePlane = plane;
    slot.planes.set(key, plane);
    object.add(mesh);
    hitTargets.push(mesh);
    return plane;
  }

  function setUv(plane: PartPlane, uv: [number, number, number, number]) {
    plane.uv = uv;
    const [u0, v0, u1, v1] = uv;
    // PlaneGeometry's vertex order: top-left, top-right, bottom-left, bottom-right.
    const attribute = plane.mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    attribute.setXY(0, u0, v1); attribute.setXY(1, u1, v1); attribute.setXY(2, u0, v0); attribute.setXY(3, u1, v0);
    attribute.needsUpdate = true;
  }

  /** Bring each slot's texture and part planes up to the mirror's latest image. */
  function sync() {
    for (const slot of slots) {
      const { mirror } = slot;
      if (mirror.version === slot.version) continue;
      slot.version = mirror.version;
      relayout = true;
      const region = mirror.region;
      if (!region || mirror.tainted) {
        for (const plane of slot.planes.values()) plane.mesh.visible = false;
        continue;
      }
      const { canvas } = mirror;
      if (!slot.texture || slot.textureSize[0] !== canvas.width || slot.textureSize[1] !== canvas.height) {
        // A resized canvas needs a new GPU allocation; three keeps immutable storage per texture.
        slot.texture?.dispose();
        slot.texture = new THREE.CanvasTexture(canvas);
        slot.texture.colorSpace = THREE.SRGBColorSpace;
        slot.texture.anisotropy = 4;
        slot.textureSize = [canvas.width, canvas.height];
        for (const plane of slot.planes.values()) {
          plane.mesh.material.map = slot.texture;
          plane.mesh.material.needsUpdate = true;
        }
      } else slot.texture.needsUpdate = true;
      const shown = new Set<string | null>();
      for (const part of mirror.parts) {
        const plane = slot.planes.get(part.key) ?? createPlane(slot, part.key);
        plane.rect = part.rect;
        setUv(plane, partUvRect(region, part.rect));
        plane.mesh.visible = true;
        shown.add(part.key);
      }
      for (const [key, plane] of slot.planes) if (!shown.has(key)) plane.mesh.visible = false;
    }
    if (relayout) layout();
  }

  function visiblePlane(id: XrEditMirrorId, key: string | null): PartPlane | null {
    const plane = slots.find(slot => slot.id === id)?.planes.get(key);
    return plane?.mesh.visible ? plane : null;
  }

  /** A panel's size on the palette. The seat's scale sizes the panels; the watch they surround keeps its own. */
  const size = (plane: PartPlane | null): PaletteItem | null => plane && {
    w: plane.rect.width * XR_EDIT_METRES_PER_PX * seat.scale, h: plane.rect.height * XR_EDIT_METRES_PER_PX * seat.scale,
  };

  /** A tab's footprint once it stands upright: its page width becomes its height. */
  const turned = (plane: PartPlane | null): PaletteItem | null => {
    const item = size(plane);
    return item && { w: item.h, h: item.w };
  };

  /** Around the watch (`layoutAroundWatch`): the toolbox left of it, the status, File/undo, Mode and View strips
   *  above both, the colour keys right of it, and the libraries right of the toolbox below it. */
  function layout() {
    relayout = false;
    const file = visiblePlane('bar', 'file'), mode = visiblePlane('bar', 'mode'), view = visiblePlane('bar', 'view');
    const tools = visiblePlane('tools', null), legend = visiblePlane('legend', 'legend');
    const libraries = [visiblePlane('texlib', null), visiblePlane('proplib', null)];
    const tabs = [visiblePlane('texlib-tab', null), visiblePlane('proplib-tab', null)];
    const statusW = STATUS_METRES * seat.scale;
    const laid = layoutAroundWatch({
      stack: [{ w: statusW, h: statusW * STATUS_H / STATUS_W }, size(file), size(mode), size(view)],
      tools: size(tools), legend: size(legend), docked: [...libraries.map(size), ...tabs.map(turned)],
    }, { w: XR_WATCH_WIDTH, h: XR_WATCH_HEIGHT }, GAP);
    width = laid.right - laid.left;
    height = laid.top - laid.bottom;
    const place = (mesh: THREE.Object3D | undefined, at: PalettePlacement | null, roll = 0) => {
      if (!mesh || !at) return;
      mesh.position.set(at.x, at.y, 0);
      mesh.rotation.set(0, 0, roll);
      // Scale is the plane's own width and height; a rolled plane's footprint has them swapped.
      if (roll) mesh.scale.set(at.h, at.w, 1); else mesh.scale.set(at.w, at.h, 1);
    };
    place(status, laid.stack[0]);
    place(file?.mesh, laid.stack[1]);
    place(mode?.mesh, laid.stack[2]);
    place(view?.mesh, laid.stack[3]);
    place(tools?.mesh, laid.tools);
    place(legend?.mesh, laid.legend);
    libraries.forEach((plane, index) => place(plane?.mesh, laid.docked[index]));
    tabs.forEach((plane, index) => place(plane?.mesh, laid.docked[libraries.length + index], TAB_ROLL));
    seatBar.object.position.set(laid.left + seatBar.width / 2, laid.top + GAP + seatBar.height / 2, 0);
  }

  /** The texture UV at a point in a part plane's unit square (−0.5..0.5), unclamped: off the edge is allowed. */
  function planeUv(plane: PartPlane, local: THREE.Vector3): [number, number] {
    const [u0, v0, u1, v1] = plane.uv;
    return [u0 + (local.x + 0.5) * (u1 - u0), v0 + (local.y + 0.5) * (v1 - v0)];
  }

  function targetAt(plane: PartPlane, u: number, v: number): DomPointerTarget | null {
    const root = plane.slot.mirror.root, at = plane.slot.mirror.toClient(u, v);
    return root && at ? { root, x: at.x, y: at.y } : null;
  }

  const local = new THREE.Vector3(), worldPoint = new THREE.Vector3(), dragSurface = new THREE.Plane();
  const planeNormal = new THREE.Vector3();

  function cast(ray: THREE.Ray): { plane: PartPlane; target: DomPointerTarget; point: THREE.Vector3 } | null {
    raycaster.ray.copy(ray);
    object.updateWorldMatrix(true, true);
    for (const hit of raycaster.intersectObjects(hitTargets, false)) {
      const plane = hit.object.userData.palettePlane as PartPlane | undefined;
      if (!plane || !hit.object.visible) continue;
      plane.mesh.worldToLocal(local.copy(hit.point));
      const [u, v] = planeUv(plane, local);
      const target = targetAt(plane, u, v);
      if (target) return { plane, target, point: worldPoint.copy(hit.point) };
    }
    return null;
  }

  /** While a drag holds the trigger, keep a point on the pressed panel's plane even past its edge. */
  function extend(ray: THREE.Ray, plane: PartPlane): { target: DomPointerTarget; point: THREE.Vector3 } | null {
    plane.mesh.updateWorldMatrix(true, false);
    plane.mesh.getWorldPosition(worldPoint);
    planeNormal.set(0, 0, 1).transformDirection(plane.mesh.matrixWorld);
    dragSurface.setFromNormalAndCoplanarPoint(planeNormal, worldPoint);
    if (!ray.intersectPlane(dragSurface, worldPoint)) return null;
    plane.mesh.worldToLocal(local.copy(worldPoint));
    const [u, v] = planeUv(plane, local);
    const target = targetAt(plane, u, v);
    return target ? { target, point: worldPoint } : null;
  }

  function updateHighlight() {
    const control = pointer.hoveredControl;
    const plane = pointer.dragging ? dragPlane : hoverPlane;
    if (!control || !plane) { highlight.visible = false; return; }
    const r = control.getBoundingClientRect(), p = plane.rect;
    const left = Math.max(r.left, p.x), top = Math.max(r.top, p.y);
    const right = Math.min(r.right, p.x + p.width), bottom = Math.min(r.bottom, p.y + p.height);
    if (right - left < 1 || bottom - top < 1) { highlight.visible = false; return; }
    if (highlight.parent !== plane.mesh) plane.mesh.add(highlight);
    highlight.position.set(((left + right) / 2 - p.x) / p.width - 0.5, 0.5 - ((top + bottom) / 2 - p.y) / p.height, 0);
    highlight.scale.set((right - left) / p.width, (bottom - top) / p.height, 1);
    highlightMaterial.color.setHex(pointer.pressed ? 0xffd24a : 0x8fd7ff);
    highlight.visible = true;
  }

  /**
   * One frame of right-controller input against the palette. `ray` is the right aim ray (null when the watch has
   * it, or when the palette is not in play); `left` / `right` are the mouse buttons the host routed here (trigger /
   * A), `stick` the right stick's raw Y. `consumed` is true while the ray is on a panel or a press it started is
   * live: the buttons and the right stick belong to the palette then.
   */
  function update(ray: THREE.Ray | null, left: boolean, right: boolean, stick: number, dt: number): {
    point: THREE.Vector3 | null; consumed: boolean;
  } {
    if (!open) return { point: null, consumed: false };
    // The placement bar lies below every panel, so nothing else can be under the laser there. A drag that began
    // on a panel keeps that panel even while the hand strays across the bar.
    const bar = ray && !pointer.dragging ? seatBar.cast(ray) : null;
    const hit = ray && !bar ? cast(ray) : null;
    let target = hit?.target ?? null, point = hit?.point ?? bar?.point ?? null;
    if (!hit && ray && pointer.dragging && dragPlane) {
      const extended = extend(ray, dragPlane);
      if (extended) { target = extended.target; point = extended.point; }
    }
    hoverPlane = hit?.plane ?? null;
    const wasDragging = pointer.dragging;
    pointer.update(target, left, right);
    if (!wasDragging && pointer.dragging) dragPlane = hit?.plane ?? null;
    if (!pointer.dragging) dragPlane = null;
    const nudge = seatBar.press(bar?.action ?? null, left, dt);
    if (nudge) {
      const resized = stepPaletteSeat(seat, nudge, XR_EDIT_PALETTE_SEAT);
      if (resized.scale !== seat.scale) relayout = true;
      seat = resized;
      savePaletteSeat(seat, XR_EDIT_PALETTE_SEAT);
    }
    const axis = normalizeAxis(stick);
    if (hit && axis) pointer.scroll(hit.target, axis * SCROLL_PX_PER_S * Math.min(dt, 0.1));
    updateHighlight();
    return { point, consumed: !!hit || !!bar || pointer.dragging };
  }

  /** Whether the ray meets a panel or the placement bar, without acting on it: the host uses it to decide who a
   *  new press belongs to. */
  function hits(ray: THREE.Ray): boolean {
    return open && (cast(ray) !== null || seatBar.cast(ray) !== null);
  }

  /** Per frame, after the rig is seated: at most ONE panel serializes per frame, then textures follow. */
  function tick(now: number) {
    if (!open) return;
    for (let i = 0; i < slots.length; i++) {
      const index = (cursor + i) % slots.length;
      if (slots[index].mirror.tick(now, true)) { cursor = (index + 1) % slots.length; break; }
    }
    sync();
    if (seatBar.object.visible) seatBar.paint(seat, !samePaletteSeat(seat, XR_EDIT_PALETTE_SEAT), { width, height });
    if (now >= nextStatus) { nextStatus = now + 1000 / STATUS_HZ; paintStatus(now); }
    if (now >= nextLog) { nextLog = now + LOG_MS; logStats(); }
  }

  const ms = (value: number) => value < 10 ? value.toFixed(1) : String(Math.round(value));

  function paintStatus(now: number) {
    const elapsed = (now - rafSince) / 1000;
    if (elapsed >= 1) { rafRate = rafFrames / elapsed; rafFrames = 0; rafSince = now; }
    statusCtx.clearRect(0, 0, STATUS_W, STATUS_H);
    statusCtx.fillStyle = 'rgba(10,16,24,0.82)';
    statusCtx.beginPath();
    statusCtx.roundRect(2, 2, STATUS_W - 4, STATUS_H - 4, 14);
    statusCtx.fill();
    statusCtx.textBaseline = 'middle';
    statusCtx.font = '600 24px system-ui, sans-serif';
    const error = slots.map(slot => slot.mirror.stats.error && `${slot.id}: ${slot.mirror.stats.error}`).find(Boolean);
    statusCtx.fillStyle = error ? '#ff8d8d' : pointer.notice ? '#ffd24a' : '#9fb6cc';
    statusCtx.fillText(error || pointer.notice
      || 'trigger click · A right-click · stick ↕ scroll · grip = drag map · both grips: pull = zoom in, twist = turn',
    18, 20, STATUS_W - 36);
    // Only the panels on show: a library outside its mode, or a tab while its library is open, costs nothing.
    const shown = slots.filter(slot => slot.mirror.region);
    const bytes = shown.reduce((sum, slot) => sum + slot.mirror.stats.bytes, 0);
    const costs = shown.map(slot => `${slot.id} ${ms(slot.mirror.stats.syncMs)}+${ms(slot.mirror.stats.decodeMs)}`);
    const raf = rafRate < 0 ? 'rAF …' : rafRate < 1 ? 'page rAF PAUSED' : `rAF ${Math.round(rafRate)}/s`;
    statusCtx.fillStyle = rafRate >= 0 && rafRate < 1 ? '#ffc14a' : '#eaf4ff';
    statusCtx.fillText(`${costs.join(' · ')} ms · ${Math.round(bytes / 1024)} KB · ${raf}`
      + `${document.visibilityState === 'hidden' ? ' · hidden' : ''}`, 18, 52, STATUS_W - 36);
    statusTexture.needsUpdate = true;
  }

  function logStats() {
    const rows = slots.map(slot => {
      const s = slot.mirror.stats;
      return `${slot.id} sync ${ms(s.syncMs)} decode ${ms(s.decodeMs)} draw ${ms(s.drawMs)} ms`
        + ` · ${Math.round(s.bytes / 1024)} KB · ${s.nodes} nodes · ${s.cssRules} rules`
        + ` · ${s.repaints} painted / ${s.unchanged} unchanged${s.error ? ` · ${s.error}` : ''}`;
    });
    console.info(`[xr edit] ${rows.join(' | ')} | page rAF ${rafRate < 0 ? '?' : rafRate.toFixed(0)}/s`
      + ` · ${document.visibilityState}`);
  }

  function setOpen(on: boolean) {
    if (on === open) return;
    open = on;
    object.visible = on;
    // Clamp the toolbox to a palette's height while the headset shows it (dock.css): a window-tall dock would be
    // half a metre on the wrist, and the clamp makes its own scrollbar the one the right stick drives.
    document.body.classList.toggle('os-xr-editing', on);
    for (const slot of slots) slot.mirror.setActive(on);
    if (on) {
      relayout = true;
      rafFrames = 0; rafSince = performance.now(); rafRate = -1;
      rafHandle = requestAnimationFrame(onPageFrame);
      nextStatus = 0;
      nextLog = performance.now() + LOG_MS;
    } else {
      cancelAnimationFrame(rafHandle);
      pointer.reset();
      seatBar.reset();
      highlight.visible = false;
      dragPlane = hoverPlane = null;
    }
  }

  function dispose() {
    setOpen(false);
    for (const slot of slots) {
      slot.mirror.dispose();
      slot.texture?.dispose();
      for (const plane of slot.planes.values()) { plane.mesh.geometry.dispose(); plane.mesh.material.dispose(); }
    }
    highlight.geometry.dispose(); highlightMaterial.dispose();
    status.geometry.dispose(); status.material.dispose(); statusTexture.dispose();
    seatBar.dispose();
    object.removeFromParent();
  }

  return {
    object,
    get open() { return open; },
    /** The placement bar is showing: the watch's MOVE UI while EDIT is on. */
    get placing() { return seatBar.object.visible; },
    setPlacing(on: boolean) {
      seatBar.object.visible = on;
      if (!on) seatBar.reset();
    },
    /** Where the palette sits on the left controller: the defaults, or wherever the placement bar has moved it. */
    get seat(): Readonly<XrPaletteSeat> { return seat; },
    setOpen, update, hits, tick, dispose,
  };
}

export type XrEditPalette = ReturnType<typeof createXrEditPalette>;
