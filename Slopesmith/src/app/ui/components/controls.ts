/**
 * Tiny DOM control helpers for the horizontal top toolbar (buttons + segmented switches).
 * lil-gui handles the vertical property panels (left Scene / right Tools); it stacks vertically, so
 * the top bar - which wants a horizontal row of context/view/file controls - is plain DOM.
 */
import { tooltip } from './tooltip';

export function button(
  label: string,
  onClick: () => void,
  opts: { accent?: boolean; title?: string; cls?: string } = {},
): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sp-btn' + (opts.accent ? ' accent' : '') + (opts.cls ? ' ' + opts.cls : '');
  b.textContent = label;
  if (opts.title) tooltip(b, opts.title);
  b.onclick = onClick;
  return b;
}

export interface SegOption<T extends string> {
  value: T;
  /** Visible/accessibility label. A getter lets long-lived controls follow the open mountain's name. */
  label: string | (() => string);
  /** Inline SVG/HTML rendered instead of the text label (the label becomes the accessible name). */
  icon?: string;
  /** Hover tooltip; defaults to the label. Use this to carry the one-line description. */
  title?: string | (() => string);
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  /** Repaint the active highlight from the current value getter. */
  refresh(): void;
  setEnabled(value: T, on: boolean): void;
}

export interface ToggleBar {
  el: HTMLDivElement;
  refresh(): void;
}

/** A connected group of independent pressed buttons. Unlike `segmented`, several values may be on at once;
 * the caller owns any policy such as keeping at least one value enabled. */
export function toggleBar<T extends string>(options: SegOption<T>[], active: (value: T) => boolean,
  toggle: (value: T) => void): ToggleBar {
  const el = document.createElement('div');
  el.className = 'sp-seg';
  const btns = new Map<T, HTMLButtonElement>();
  const refresh = () => {
    for (const [value, button] of btns) {
      const option = options.find(candidate => candidate.value === value)!;
      const optionLabel = typeof option.label === 'function' ? option.label() : option.label;
      button.textContent = optionLabel;
      const on = active(value);
      button.classList.toggle('on', on);
      button.setAttribute('aria-pressed', String(on));
    }
  };
  for (const option of options) {
    const button = document.createElement('button');
    button.textContent = typeof option.label === 'function' ? option.label() : option.label;
    tooltip(button, option.title ?? option.label);
    button.onclick = () => { toggle(option.value); refresh(); };
    btns.set(option.value, button);
    el.appendChild(button);
  }
  refresh();
  return { el, refresh };
}

/** A mutually-exclusive button group bound to a get/set pair (e.g. editor or mode). */
export function segmented<T extends string>(options: SegOption<T>[], get: () => T | null, set: (v: T) => void): Segmented<T> {
  const el = document.createElement('div');
  el.className = 'sp-seg';
  const btns = new Map<T, HTMLButtonElement>();
  const refresh = () => {
    const cur = get();
    for (const [v, b] of btns) {
      const option = options.find(candidate => candidate.value === v)!;
      const optionLabel = typeof option.label === 'function' ? option.label() : option.label;
      if (option.icon) b.setAttribute('aria-label', optionLabel); else b.textContent = optionLabel;
      const active = v === cur;
      b.classList.toggle('on', active);
      b.setAttribute('aria-pressed', String(active));
    }
  };
  for (const o of options) {
    const b = document.createElement('button');
    const optionLabel = () => typeof o.label === 'function' ? o.label() : o.label;
    if (o.icon) { b.innerHTML = o.icon; b.classList.add('sp-seg-icon'); b.setAttribute('aria-label', optionLabel()); }
    else b.textContent = optionLabel();
    tooltip(b, o.title ?? o.label);
    b.onclick = () => { if (!b.disabled) { set(o.value); refresh(); } };
    btns.set(o.value, b);
    el.appendChild(b);
  }
  refresh();
  return {
    el,
    refresh,
    setEnabled(value, on) {
      const b = btns.get(value);
      if (b) { b.disabled = !on; b.classList.toggle('disabled', !on); }
    },
  };
}

// ---- icon button bar (independent toggles + one-shot actions, e.g. the View controls) ----
// Unlike `segmented` (mutually exclusive), each button stands alone: a toggle highlights while its
// `active()` is true; an action (no `active`) is momentary. Shares the connected-pill look.

export interface IconButton {
  icon: string;
  /** Accessible name + tooltip fallback. */
  label: string;
  /** Hover tooltip (the one-line description); defaults to the label. */
  title?: string | (() => string);
  onClick: () => void;
  /** Toggle buttons pass a getter; the button shows the active highlight whenever it returns true. */
  active?: () => boolean;
  /** Optional getter; when it returns false the button is disabled + dimmed (e.g. Undo with no history). */
  enabled?: () => boolean;
}

export interface IconBar {
  el: HTMLElement;
  /** Repaint every toggle's highlight from its `active()` (call after external state changes). */
  refresh(): void;
}

export function iconBar(items: IconButton[]): IconBar {
  const el = document.createElement('div');
  el.className = 'sp-seg';
  const refreshers: (() => void)[] = [];
  const refresh = () => { for (const r of refreshers) r(); };
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'sp-seg-icon';
    b.innerHTML = it.icon;
    b.setAttribute('aria-label', it.label);
    tooltip(b, it.title ?? it.label);
    b.onclick = () => { it.onClick(); refresh(); };
    if (it.active) { const a = it.active; refreshers.push(() => b.classList.toggle('on', a())); }
    if (it.enabled) { const en = it.enabled; refreshers.push(() => { const ok = en(); b.disabled = !ok; b.classList.toggle('disabled', !ok); }); }
    el.appendChild(b);
  }
  refresh();
  return { el, refresh };
}

/** An inline group of related controls in the bar (so gaps read as logical separation). */
export function group(...children: HTMLElement[]): HTMLElement {
  const g = document.createElement('div');
  g.className = 'sp-group';
  g.append(...children);
  return g;
}

export function label(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'sp-label';
  s.textContent = text;
  return s;
}

/** The app name behind its mark, opening the top bar. The mark is the inverse cut of the icon: white artwork
 *  with its interiors open against the dark bar. A narrow bar drops the word and keeps the mark (CSS). */
export function brand(name: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sp-brand';
  const mark = document.createElement('img');
  mark.src = '/slopesmith_icon_light.svg';
  mark.alt = '';
  const text = document.createElement('span');
  text.textContent = name;
  el.append(mark, text);
  el.title = name;
  return el;
}

export function spacer(): HTMLElement {
  const s = document.createElement('div');
  s.className = 'sp-spacer';
  return s;
}

// ---- dropdown menu button (a trigger that opens a popup of described items) ----

export interface MenuItem {
  label: string;
  /** One-line plain-language description, shown on HOVER rather than under the label. A long menu is read by
   *  scanning its labels; a paragraph under every row turns that scan into a wall of prose. */
  desc?: string;
  /** Short explanation shown in the row. Use this when the label alone does not tell a user what choosing
   *  the item will do; `desc` can still carry longer or more technical hover help. */
  detail?: string;
  onClick?: () => void;
  /** Marks the current selection (e.g. the active editor/mode). */
  checked?: boolean;
  disabled?: boolean;
  /** Section this row belongs to. The first row of each run gets the heading; rows with no group lead the
   *  menu ungrouped, so an ordinary short menu is unchanged. */
  group?: string;
}

export interface Menu {
  el: HTMLButtonElement;
  /** Update the trigger text (e.g. to the current editor/mode). */
  setLabel(text: string): void;
}

export interface MenuOptions {
  /** Inline SVG that stands in for the trigger text where the bar is too narrow to spell it out. Both are
   *  rendered; CSS picks which one shows (see the narrow-bar query around `.sp-app-menu`). */
  collapseIcon?: string;
}

let openPop: HTMLElement | null = null;
let menuSeq = 0;

function closeMenu() {
  if (openPop) { openPop.remove(); openPop = null; }
}
// any click/Escape outside the popup or trigger closes it (triggers/items stopPropagation)
document.addEventListener('click', closeMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });

/** The popup itself: rows of label + optional description, sharing one close path with everything above. */
function buildPop(items: MenuItem[], owner?: string): HTMLElement {
  const pop = document.createElement('div');
  pop.className = 'sp-menu-pop';
  if (items.some(item => item.detail)) pop.classList.add('has-details');
  if (owner) pop.dataset.owner = owner;
  pop.onclick = ev => ev.stopPropagation();
  let group: string | undefined;
  for (const it of items) {
    if (it.group && it.group !== group) {
      const head = document.createElement('div');
      head.className = 'sp-menu-group';
      head.textContent = it.group;
      pop.appendChild(head);
    }
    group = it.group;
    const row = document.createElement('button');
    row.className = 'sp-menu-item' + (it.checked ? ' checked' : '') + (it.detail ? ' has-details' : '');
    row.disabled = !!it.disabled;
    const l = document.createElement('div');
    l.className = 'sp-menu-label';
    l.textContent = (it.checked ? '● ' : '') + it.label;
    row.appendChild(l);
    if (it.detail) {
      const detail = document.createElement('div');
      detail.className = 'sp-menu-detail';
      detail.textContent = it.detail;
      row.appendChild(detail);
    }
    // `detail` carries the concise, visible answer; `desc` remains the home for longer caveats and evidence
    // that would otherwise turn a scan-friendly menu into a wall of prose.
    if (it.desc) tooltip(row, it.desc);
    row.onclick = ev => { ev.stopPropagation(); if (it.disabled) return; closeMenu(); it.onClick?.(); };
    pop.appendChild(row);
  }
  return pop;
}

/** Place an open popup at a viewport point, nudged back on screen if it would overhang an edge. */
function placePop(pop: HTMLElement, x: number, y: number) {
  pop.style.left = `${Math.max(6, Math.min(x, window.innerWidth - pop.offsetWidth - 6))}px`;
  pop.style.top = `${Math.max(6, Math.min(y, window.innerHeight - pop.offsetHeight - 6))}px`;
}

/**
 * A top-bar menu button. `items` may be a thunk so it re-reads live state each open (current
 * selection checked, options disabled by context) - e.g. Sculpt controls disabled outside Sculpt mode.
 */
export function menu(triggerLabel: string, items: MenuItem[] | (() => MenuItem[]), opts: MenuOptions = {}): Menu {
  const id = `m${menuSeq++}`;
  const btn = document.createElement('button');
  btn.className = 'sp-btn sp-menu-btn';
  const text = document.createElement('span');
  text.className = 'sp-menu-btn-label';
  text.textContent = triggerLabel;
  btn.appendChild(text);
  if (opts.collapseIcon) {
    const icon = document.createElement('span');
    icon.className = 'sp-menu-btn-icon';
    icon.innerHTML = opts.collapseIcon;
    btn.appendChild(icon);
  }
  btn.onclick = e => {
    e.stopPropagation();
    const reopeningSame = openPop?.dataset.owner === id;
    closeMenu();
    if (reopeningSame) return; // clicking the open trigger again closes it

    const pop = buildPop(typeof items === 'function' ? items() : items, id);
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect();
    placePop(pop, r.left, r.bottom + 4);
    openPop = pop;
  };
  return { el: btn, setLabel: t => { text.textContent = t; } };
}

/**
 * The same menu raised at a point instead of under a trigger — for right-click context menus. Actions that
 * would be misfired as visible buttons (destructive ones, or ones sharing a target with a click that means
 * something else) belong here: a right-click is deliberate in a way that clipping a small button is not.
 * Shares the popup, its styling, and the outside-click / Escape close with `menu` above.
 */
export function contextMenu(items: MenuItem[], at: { x: number; y: number }) {
  closeMenu();
  const pop = buildPop(items);
  document.body.appendChild(pop);
  placePop(pop, at.x, at.y);
  openPop = pop;
}
