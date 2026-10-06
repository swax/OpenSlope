import GUI from 'lil-gui';
import { tooltip } from './tooltip';
import { infoBadge } from './info';
import { orientCss } from '../../../core/paint/orientation';

/** Empty a lil-gui of its controllers and child folders without destroying the gui itself. */
export function clearGui(g: GUI) {
  [...g.controllers].forEach(c => c.destroy());
  [...g.folders].forEach(f => f.destroy());
  g.$children.querySelectorAll(':scope > .sp-gui-custom').forEach(el => el.remove());
}

/** Wrapping read-only guidance in a panel (for example an empty-state prompt in the Scene folders).
 *  `more` hangs an info badge on the end for detail the one-line prompt should not carry itself. */
export function note(g: GUI, text: string, more?: string) {
  // A disabled lil-gui string is an input, so it cannot wrap. Use the same custom-row path as banners so notes
  // consume the available panel width and longer guidance remains readable in every toolbox.
  const row = document.createElement('div');
  row.className = 'sp-gui-custom sp-note';
  row.setAttribute('role', 'note');
  row.textContent = text;
  if (more) row.appendChild(infoBadge(more));
  g.$children.appendChild(row);
  return row;
}

/**
 * A numbered walkthrough in a panel, for a task whose ORDER is the content — a recipe spanning several tools
 * rather than the one the panel is showing. It renders as a real ordered list instead of a run-on `note` so
 * the reader can find the step they are on and read only that one. Each item leads with the control it names,
 * emphasised, so the list scans as the sequence of things to press.
 */
export function steps(g: GUI, items: readonly (readonly [action: string, text: string])[]) {
  const list = document.createElement('ol');
  list.className = 'sp-gui-custom sp-steps';
  for (const [action, text] of items) {
    const item = document.createElement('li');
    const lead = document.createElement('b');
    lead.textContent = action;
    item.append(lead, ` — ${text}`); // text nodes, so a step never renders panel copy as markup
    list.appendChild(item);
  }
  g.$children.appendChild(list);
  return list;
}

/** A selected-item information row. Unlike the blue `note` prompt/header, this is styled as a neutral slate
 *  readout card; an optional short label gives metric rows (size / drop / area) their two-column caption. */
export function detail(g: GUI, text: string, name = '') {
  const controller = g.add({ x: text }, 'x').name(name);
  // Read-only inputs still accept focus, selection and copy; disabled controllers suppress pointer events.
  controller.domElement.querySelector('input')!.readOnly = true;
  controller.domElement.classList.add('sp-detail');
  return controller;
}

/** A read-only detail whose value follows live scene state without rebuilding the panel (for example, a
 *  selected light's position while its viewport gizmo is being dragged). */
export function liveDetail(g: GUI, value: () => string, name = '') {
  const controller = g.add({ get x() { return value(); } }, 'x').name(name).listen();
  controller.domElement.querySelector('input')!.readOnly = true;
  controller.domElement.classList.add('sp-detail');
  return controller;
}

/** A red error callout for a failed operation or invalid geometry that needs correction. */
export function errorBanner(g: GUI, text: string) {
  const banner = document.createElement('div');
  banner.className = 'sp-gui-custom sp-error-banner';
  banner.setAttribute('role', 'alert');
  banner.textContent = text;
  g.$children.appendChild(banner);
  return banner;
}

/** An amber warning for an important risk or configuration issue that does not indicate a failed operation. */
export function warningBanner(g: GUI, text: string) {
  const banner = document.createElement('div');
  banner.className = 'sp-gui-custom sp-warning-banner';
  banner.setAttribute('role', 'note');
  banner.textContent = text;
  g.$children.appendChild(banner);
  return banner;
}

/**
 * A sky's horizon panorama, shown as a strip in a panel (docs/025). The image is the whole backdrop unrolled
 * — the 24 wall panels stitched left to right — so it reads as one continuous view around the mountain, which
 * is exactly the thing you want to judge before adopting a sky. `caption` names what you're looking at, and
 * gains the image's true pixel size once it loads: that size is the target to paint a replacement at, so it
 * belongs on the picture rather than buried in a tooltip.
 */
export function skyPreview(g: GUI, src: string, caption: string) {
  const box = document.createElement('div');
  box.className = 'sp-gui-custom sp-sky-preview';
  const img = document.createElement('img');
  img.src = src;
  img.alt = caption;
  img.onerror = () => { box.classList.add('sp-sky-preview-empty'); img.remove(); };
  const cap = document.createElement('span');
  cap.textContent = caption;
  img.onload = () => { cap.textContent = `${caption} · ${img.naturalWidth}×${img.naturalHeight}`; };
  box.append(img, cap);
  g.$children.appendChild(box);
  return box;
}

/**
 * A texture field shown as the art itself: a labelled row whose value is a swatch of the tile, opening a
 * picker when clicked. A texture is a picture, so it is chosen and recognised by looking at pictures — the
 * text box this replaces asked the author to recall refs like "GARI/0106.png" by hand. The ref is hover-only
 * for the same reason: it identifies the tile far worse than the tile does, so it need not hold a row.
 *
 * Built as a lil-gui `.lil-controller` (label in the name column, value beside it) rather than a full-width card,
 * so it lines up with the ordinary fields above it. `src` null renders the empty state, which reads as a
 * deliberate "no texture" rather than a broken image.
 */
export function texturePreview(g: GUI, opts: {
  label: string; src: string | null; value: string; hint: string; onOpen?: () => void;
  orient?: { rot: number; mirror: boolean };
}) {
  const row = document.createElement('div');
  row.className = 'lil-controller sp-gui-custom sp-tex-row';
  const name = document.createElement('div');
  name.className = 'lil-name';
  name.textContent = opts.label;
  row.append(name, texSwatch(opts));
  g.$children.appendChild(row);
  return row;
}

/** One tile as art. A swatch with no `onOpen` renders as a plain picture rather than a dead button — the
 *  reference materials it shows are read-only, and offering a control that answers nothing is worse than
 *  offering none. Given an `orient` it shows the tile the way up the surface wears it (`orientCss`), which
 *  the square, radius-symmetric box takes without distortion — a swatch that stayed upright while the prop
 *  turned would be a picture of the wrong thing. */
function texSwatch(opts: { label: string; src: string | null; value: string; hint: string;
  onOpen?: () => void; orient?: { rot: number; mirror: boolean } }): HTMLElement {
  const swatch = document.createElement(opts.onOpen ? 'button' : 'div');
  if (swatch instanceof HTMLButtonElement) { swatch.type = 'button'; swatch.onclick = opts.onOpen!; }
  swatch.className = `sp-tex-swatch${opts.src ? '' : ' sp-tex-swatch-empty'}`
    + (opts.onOpen ? '' : ' sp-tex-swatch-static');
  if (opts.src) swatch.style.backgroundImage = `url(${opts.src})`;
  if (opts.src && opts.orient) swatch.style.transform = orientCss(opts.orient.rot, opts.orient.mirror);
  // The control is pure art, so the ref is its only name — as a tooltip for the eye, aria-label for
  // everything else (without it this is a button with no accessible name at all).
  swatch.setAttribute('aria-label', `${opts.label}: ${opts.value}`);
  tooltip(swatch, `${opts.value}\n${opts.hint}`); // the ref leads: hovering is how you read which tile this is
  return swatch;
}

/**
 * A material's flipbook as the strip of art it is: one swatch per state, in playback order, each badged with
 * its frame number.
 *
 * Shown rather than listed because the frames of a state list are told apart by their PAINT — a button's
 * green and red, a warning screen's two faces — and a row of file names says nothing about which is which.
 * Frame 0 is the material's resting tile and is deliberately not clickable here: it is the texture field
 * above, and having two controls write the same value hides that the state list is headed by it.
 */
export function flipbookPreview(g: GUI, opts: {
  label: string;
  frames: readonly { src: string | null; value: string }[];
  hint: string;
  /** Replace one state (frame 1 and up). Absent for a material whose table we do not own. */
  onFrame?: (index: number) => void;
}) {
  const row = document.createElement('div');
  row.className = 'lil-controller sp-gui-custom sp-tex-row sp-flip-row';
  const name = document.createElement('div');
  name.className = 'lil-name';
  name.textContent = opts.label;
  const strip = document.createElement('div');
  strip.className = 'sp-flip-strip';
  opts.frames.forEach((frame, index) => {
    const cell = document.createElement('div');
    cell.className = 'sp-flip-cell';
    cell.append(texSwatch({
      label: `frame ${index}`,
      src: frame.src,
      value: frame.value,
      hint: index === 0
        ? 'Frame 0 — what the material rests on. Change it with the texture field above; the state list '
          + 'follows it.'
        : opts.onFrame ? 'Click to replace this state with another tile from the Texture Library.' : opts.hint,
      ...(index > 0 && opts.onFrame ? { onOpen: () => opts.onFrame!(index) } : {}),
    }));
    const badge = document.createElement('span');
    badge.className = 'sp-flip-badge';
    badge.textContent = index === 0 ? 'rest' : String(index);
    cell.append(badge);
    strip.append(cell);
  });
  row.append(name, strip);
  g.$children.appendChild(row);
  return row;
}

/** One half of a matched pair: its art, and what hovering it says. */
export interface TextureHalf { src: string | null; value: string }

/** One matched pair as the art: its two halves, the left lane's and the right lane's, and how they are worn. */
export interface TilePairArt {
  halves: readonly [TextureHalf, TextureHalf];
  /** How each half shows, looking along the trail (`orientCss`). */
  orient?: { rot: number; mirror: boolean };
}

/** A pair's two halves side by side as plain pictures, touching, the way a trail wears them across its width. */
function pairThumb(art: TilePairArt | null, size: number): HTMLElement {
  const thumb = document.createElement('span');
  thumb.className = `sp-pair-thumb${art ? '' : ' sp-pair-thumb-none'}`;
  if (!art) { thumb.textContent = '∅'; thumb.style.width = `${size * 2 + 1}px`; thumb.style.height = `${size}px`; return thumb; }
  for (const half of art.halves) {
    const cell = document.createElement('span');
    cell.className = 'sp-pair-half';
    cell.style.width = cell.style.height = `${size}px`;
    if (half.src) cell.style.backgroundImage = `url(${half.src})`;
    if (half.src && art.orient) cell.style.transform = orientCss(art.orient.rot, art.orient.mirror);
    thumb.append(cell);
  }
  return thumb;
}

/** One choice in a pair dropdown. */
export interface TilePairOption extends TilePairArt {
  id: string;
  /** The heading it lists under — its map. */
  group: string;
  /** Its name there: `Trail 1`. */
  name: string;
  /** Hovering it: its id and tiles. */
  title: string;
}

/** The one pair menu open: closing it is the next open's first act, so two never stand at once. */
let closeOpenPairMenu: (() => void) | null = null;

/**
 * A pair CHOSEN BY ITS ART (a trail's tiles, docs/023 · Textures): a lil-gui row whose value is the worn pair's two
 * halves and its name, opening a list of every pair — each as its art, under its map's name — with "none" first and,
 * given `add`, a way to make a new one last. A pair is recognised by its picture, the way a tile is (`texturePreview`).
 */
export function tilePairDropdown(g: GUI, opts: {
  label: string;
  hint: string;
  value: string | null;
  options: readonly TilePairOption[];
  none: { label: string; title: string };
  add?: { label: string; title: string; onAdd: () => void };
  onChange: (id: string | null) => void;
}) {
  const row = document.createElement('div');
  row.className = 'lil-controller sp-gui-custom sp-tex-row sp-pair-row';
  const name = document.createElement('div');
  name.className = 'lil-name';
  name.textContent = opts.label;
  tooltip(name, opts.hint);
  const current = opts.options.find(option => option.id === opts.value) ?? null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sp-pair-dd';
  const text = document.createElement('span');
  text.className = 'sp-pair-dd-text';
  text.textContent = current ? current.id : opts.value ? `${opts.value} (missing)` : opts.none.label;
  const caret = document.createElement('span');
  caret.className = 'sp-pair-dd-caret';
  caret.textContent = '▾';
  button.append(pairThumb(current, 18), text, caret);
  button.setAttribute('aria-haspopup', 'listbox');
  tooltip(button, current ? current.title : opts.none.title);
  button.onclick = () => openPairMenu(button, opts);
  row.append(name, button);
  g.$children.appendChild(row);
  return row;
}

function openPairMenu(anchor: HTMLElement, opts: Parameters<typeof tilePairDropdown>[1]) {
  closeOpenPairMenu?.();
  const menu = document.createElement('div');
  menu.className = 'sp-pair-menu';
  menu.setAttribute('role', 'listbox');
  const close = () => {
    menu.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', keys, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    if (closeOpenPairMenu === close) closeOpenPairMenu = null;
  };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const keys = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const item = (art: TilePairOption | null, label: string, title: string, selected: boolean, act: () => void) => {
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = `sp-pair-item${selected ? ' sel' : ''}`;
    entry.setAttribute('role', 'option');
    entry.setAttribute('aria-selected', String(selected));
    const words = document.createElement('span');
    words.textContent = label;
    entry.append(pairThumb(art, 30), words);
    tooltip(entry, title);
    entry.onclick = () => { close(); act(); };
    menu.append(entry);
    return entry;
  };
  item(null, opts.none.label, opts.none.title, !opts.value, () => opts.onChange(null));
  let group = '';
  let chosen: HTMLElement | null = null;
  for (const option of opts.options) {
    if (option.group !== group) {
      group = option.group;
      const heading = document.createElement('div');
      heading.className = 'sp-pair-group';
      heading.textContent = group;
      menu.append(heading);
    }
    const entry = item(option, option.name, option.title, option.id === opts.value, () => opts.onChange(option.id));
    if (option.id === opts.value) chosen = entry;
  }
  if (opts.add) {
    const add = opts.add;
    const entry = item(null, add.label, add.title, false, add.onAdd);
    entry.classList.add('sp-pair-new');
    entry.querySelector('.sp-pair-thumb')!.textContent = '+';
  }
  document.body.append(menu);
  // Under the button, or over it where the window ends first; as tall as the room there allows.
  const rect = anchor.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - 8, above = rect.top - 8;
  const down = below >= Math.min(menu.scrollHeight, 240) || below >= above;
  menu.style.maxHeight = `${Math.max(120, down ? below : above)}px`;
  menu.style.minWidth = `${Math.max(rect.width, 180)}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  if (down) menu.style.top = `${rect.bottom + 2}px`; else menu.style.bottom = `${window.innerHeight - rect.top + 2}px`;
  (chosen as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', keys, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  closeOpenPairMenu = close;
}

/** One pair's two halves to edit: each half a swatch that chooses its tile, badged with its lane. */
export function tilePairEditor(g: GUI, opts: {
  label: string;
  hint: string;
  art: TilePairArt;
  onHalf: (side: 0 | 1) => void;
}) {
  const row = document.createElement('div');
  row.className = 'lil-controller sp-gui-custom sp-tex-row sp-flip-row';
  const name = document.createElement('div');
  name.className = 'lil-name';
  name.textContent = opts.label;
  tooltip(name, opts.hint);
  const strip = document.createElement('div');
  strip.className = 'sp-flip-strip';
  for (const side of [0, 1] as const) {
    const cell = document.createElement('div');
    cell.className = 'sp-flip-cell';
    const lane = side ? 'right' : 'left';
    cell.append(texSwatch({
      label: `${lane} lane`, src: opts.art.halves[side].src, value: opts.art.halves[side].value,
      hint: `The ${lane} lane’s half, going along the path. Click to choose its tile from the Texture Library.`,
      onOpen: () => opts.onHalf(side),
      ...(opts.art.orient ? { orient: opts.art.orient } : {}),
    }));
    const badge = document.createElement('span');
    badge.className = 'sp-flip-badge';
    badge.textContent = lane;
    cell.append(badge);
    strip.append(cell);
  }
  row.append(name, strip);
  g.$children.appendChild(row);
  return row;
}

/** Attach a hover tooltip to a lil-gui controller (plain-language help for the domain jargon).
 *  Keep `text` to one line — what the control does; `more` adds an info badge at the row's end
 *  carrying the longer detail (defaults, costs, when it applies) for the reader who wants it. */
export function tip<C extends { domElement: HTMLElement }>(c: C, text: string, more?: string): C {
  tooltip(c.domElement, text);
  if (more) c.domElement.appendChild(infoBadge(more));
  return c;
}

/** Add a shared outline glyph before a lil-gui action's text without falling back to coloured emoji. */
export function iconAction<C extends { domElement: HTMLElement }>(controller: C, iconSvg: string): C {
  const name = controller.domElement.querySelector<HTMLElement>('button > .lil-name');
  if (!name) return controller;
  controller.domElement.classList.add('sp-icon-action');
  const icon = document.createElement('span');
  icon.className = 'sp-inline-action-icon';
  icon.innerHTML = iconSvg;
  name.prepend(icon);
  return controller;
}

/** Lay two adjacent lil-gui action controllers out as one equal-width button row. The controllers remain direct
 * children of the GUI so lil-gui can still destroy and rebuild them normally. */
export function actionPair<C extends { domElement: HTMLElement }>(left: C, right: C): [C, C] {
  left.domElement.classList.add('sp-action-pair', 'sp-action-pair-left');
  right.domElement.classList.add('sp-action-pair', 'sp-action-pair-right');
  return [left, right];
}
