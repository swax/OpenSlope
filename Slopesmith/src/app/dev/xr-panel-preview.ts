import { createDomMirror, createDomPointer, partUvRect, type DomMirror, type Rect } from '../ride/xr/dom-mirror';
import { XR_EDIT_MIRRORS, type XrEditMirrorId } from '../ride/xr/edit-palette';

/**
 * `?xrpanels=1` (dev only): the headset's wrist EDIT palette (docs/068) drawn flat in a floating window, from the
 * SAME mirrors and driven through the SAME pointer the headset uses — the mouse stands in for the controller ray,
 * the wheel for the right stick. What it proves without a headset: that each panel rasterizes faithfully (compare
 * it with the real one beside it), that a click on the image reaches the real control, and what a repaint costs
 * on this machine. What it cannot: the headset browser's own costs, and whether its page `requestAnimationFrame`
 * keeps running during an immersive session — the palette's status strip reports both in VR.
 *
 * The preview's own mouse events are stopped at its host. Otherwise the real mousemove over the preview would reach
 * lil-gui's window-level drag listener alongside the forwarded one, and a dragged slider would read both.
 */

const STATUS_MS = 500;

interface View { wrap: HTMLDivElement; canvas: HTMLCanvasElement; ring: HTMLDivElement; rect: Rect | null }

export function installXrPanelPreview(): { dispose(): void } {
  const pointer = createDomPointer();
  const slots = XR_EDIT_MIRRORS.map(spec => ({ id: spec.id, mirror: createDomMirror(spec), version: -1 }));

  const host = document.createElement('div');
  host.id = 'xr-panel-preview';
  host.setAttribute('aria-label', 'VR edit palette preview');
  Object.assign(host.style, {
    position: 'fixed', left: '10px', top: 'calc(var(--bar-h) + 10px)', zIndex: '40', maxHeight: 'calc(100% - var(--bar-h) - 20px)',
    overflow: 'auto', padding: '8px', background: 'rgba(8,12,18,0.92)', border: '1px solid #3a5a78', borderRadius: '8px',
    color: '#cfe0ee', font: '12px/1.4 system-ui, sans-serif', boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
  } satisfies Partial<CSSStyleDeclaration>);
  const header = document.createElement('div');
  Object.assign(header.style, { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' });
  const title = document.createElement('strong');
  title.textContent = 'VR edit palette · preview';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Close VR edit palette preview');
  close.style.marginLeft = 'auto';
  header.append(title, close);
  const status = document.createElement('div');
  Object.assign(status.style, { font: '11px/1.4 ui-monospace, Consolas, monospace', color: '#9fb6cc', marginBottom: '6px',
    whiteSpace: 'pre-wrap', maxWidth: '640px' });
  // In the headset's reading order: File/undo, Mode, View, then toolbox, keys and libraries in one row. The headset
  // lays these out around the watch (edit-palette.ts `layoutAroundWatch`) and stands a closed library's tab
  // upright; here there is no watch, and a tab stays as drawn.
  const rows = Array.from({ length: 4 }, () => document.createElement('div'));
  for (const row of rows) Object.assign(row.style, { display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '8px' });
  host.append(header, status, ...rows);

  const views = new Map<string, View>();
  const viewKey = (id: XrEditMirrorId, key: string | null) => `${id}:${key ?? ''}`;
  const placement: Record<string, HTMLDivElement> = {
    'bar:file': rows[0], 'bar:mode': rows[1], 'bar:view': rows[2], 'tools:': rows[3], 'legend:legend': rows[3],
    'texlib:': rows[3], 'proplib:': rows[3], 'texlib-tab:': rows[3], 'proplib-tab:': rows[3],
  };
  for (const [key, row] of Object.entries(placement)) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { position: 'relative', display: 'none', outline: '1px dashed #2c4a64' });
    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'absolute', pointerEvents: 'none', display: 'none',
      background: 'rgba(143,215,255,0.22)', outline: '1px solid #8fd7ff' });
    wrap.append(canvas, ring);
    row.append(wrap);
    views.set(key, { wrap, canvas, ring, rect: null });
  }

  /** Where on the page a point over a preview canvas corresponds to, unclamped so a captured drag can overshoot. */
  function targetFor(id: XrEditMirrorId, key: string | null, event: MouseEvent) {
    const slot = slots.find(s => s.id === id)!, view = views.get(viewKey(id, key))!;
    const region = slot.mirror.region, root = slot.mirror.root, part = view.rect;
    if (!region || !root || !part) return null;
    const bounds = view.canvas.getBoundingClientRect();
    const fx = (event.clientX - bounds.left) / bounds.width, fy = (event.clientY - bounds.top) / bounds.height;
    const [u0, v0, u1, v1] = partUvRect(region, part);
    const at = slot.mirror.toClient(u0 + fx * (u1 - u0), v1 - fy * (v1 - v0));
    return at ? { root, x: at.x, y: at.y } : null;
  }

  for (const [key, view] of views) {
    const [id, part] = key.split(':') as [XrEditMirrorId, string];
    const partKey = part || null;
    const canvas = view.canvas;
    // Left and right buttons stand in for the trigger and A; `buttons` carries both on every event.
    const forward = (event: PointerEvent) => pointer.update(targetFor(id, partKey, event),
      (event.buttons & 1) !== 0, (event.buttons & 2) !== 0);
    canvas.addEventListener('pointerdown', event => {
      try { canvas.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer: no capture to take */ }
      forward(event);
    });
    canvas.addEventListener('pointermove', forward);
    canvas.addEventListener('pointerup', forward);
    canvas.addEventListener('contextmenu', event => event.preventDefault());
    canvas.addEventListener('pointerleave', () => { if (!pointer.dragging) pointer.update(null, false); });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      pointer.scroll(targetFor(id, partKey, event), event.deltaY);
    }, { passive: false });
  }
  // Keep the preview's real input to itself (see the header): nothing here should reach the editor or lil-gui.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'click',
    'dblclick', 'wheel', 'contextmenu']) {
    host.addEventListener(type, event => event.stopPropagation());
  }

  function redraw(slot: { id: XrEditMirrorId; mirror: DomMirror }) {
    const { mirror } = slot, region = mirror.region;
    for (const [key, view] of views) {
      if (!key.startsWith(`${slot.id}:`)) continue;
      const part = region ? mirror.parts.find(p => viewKey(slot.id, p.key) === key) : undefined;
      view.rect = part?.rect ?? null;
      if (!region || !part) { view.wrap.style.display = 'none'; continue; }
      const scaleX = mirror.canvas.width / region.width, scaleY = mirror.canvas.height / region.height;
      const w = Math.round(part.rect.width * scaleX), h = Math.round(part.rect.height * scaleY);
      if (view.canvas.width !== w || view.canvas.height !== h) { view.canvas.width = w; view.canvas.height = h; }
      view.canvas.style.width = `${part.rect.width}px`;
      view.canvas.style.height = `${part.rect.height}px`;
      const ctx = view.canvas.getContext('2d')!;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(mirror.canvas, (part.rect.x - region.x) * scaleX, (part.rect.y - region.y) * scaleY, w, h, 0, 0, w, h);
      view.wrap.style.display = '';
    }
  }

  function updateRing() {
    const control = pointer.hoveredControl;
    const r = control?.getBoundingClientRect();
    for (const view of views.values()) {
      const p = view.rect;
      const hit = r && p && r.right > p.x && r.left < p.x + p.width && r.bottom > p.y && r.top < p.y + p.height;
      if (!hit || !r || !p) { view.ring.style.display = 'none'; continue; }
      Object.assign(view.ring.style, {
        display: '', left: `${Math.max(0, r.left - p.x)}px`, top: `${Math.max(0, r.top - p.y)}px`,
        width: `${Math.min(r.right, p.x + p.width) - Math.max(r.left, p.x)}px`,
        height: `${Math.min(r.bottom, p.y + p.height) - Math.max(r.top, p.y)}px`,
        background: pointer.pressed ? 'rgba(255,210,74,0.25)' : 'rgba(143,215,255,0.22)',
      });
    }
  }

  const ms = (value: number) => value < 10 ? value.toFixed(1) : String(Math.round(value));
  let nextStatus = 0, cursor = 0, frame = 0, live = true;
  function loop(now: number) {
    if (!live) return;
    for (let i = 0; i < slots.length; i++) {
      const index = (cursor + i) % slots.length;
      if (slots[index].mirror.tick(now, true)) { cursor = (index + 1) % slots.length; break; }
    }
    for (const slot of slots) {
      if (slot.mirror.version === slot.version) continue;
      slot.version = slot.mirror.version;
      redraw(slot);
    }
    updateRing();
    if (now >= nextStatus) {
      nextStatus = now + STATUS_MS;
      status.textContent = slots.map(({ id, mirror: { stats: s } }) =>
        `${id.padEnd(6)} sync ${ms(s.syncMs).padStart(4)} · decode ${ms(s.decodeMs).padStart(4)} · draw ${ms(s.drawMs).padStart(4)} ms`
        + ` · ${String(Math.round(s.bytes / 1024)).padStart(4)} KB · ${s.nodes} nodes · ${s.cssRules} rules`
        + ` · ${s.repaints}/${s.unchanged}${s.error ? ` · ${s.error}` : ''}`).join('\n')
        + (pointer.notice ? `\n${pointer.notice}` : '');
    }
    frame = requestAnimationFrame(loop);
  }

  document.body.classList.add('os-xr-editing'); // the palette's toolbox clamp, so the preview shows what VR shows
  for (const slot of slots) slot.mirror.setActive(true);
  document.body.appendChild(host);
  frame = requestAnimationFrame(loop);

  function dispose() {
    live = false;
    cancelAnimationFrame(frame);
    pointer.reset();
    for (const slot of slots) slot.mirror.dispose();
    document.body.classList.remove('os-xr-editing');
    host.remove();
  }
  close.addEventListener('click', dispose);
  return { dispose };
}
