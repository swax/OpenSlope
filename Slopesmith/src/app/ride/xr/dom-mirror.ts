/**
 * DOM mirror (docs/068): the editor's own chrome, rasterized so a WebXR session can wear it on the wrist.
 *
 * An `immersive-vr` session composites only the WebGL layer — WebXR's DOM overlay exists for handheld AR, not for
 * headsets — so the toolbox, the view buttons and the colour keys never reach the eyes however visible they are on
 * the desktop mirror. Rebuilding them in canvas would fork every panel. This rasterizes the REAL panels instead,
 * and forwards controller clicks back into the real DOM, so a panel added next month appears in the headset with
 * no VR-side work.
 *
 * The rasterizer is the SVG `<foreignObject>` route: clone the live subtree, bake what a clone loses, wrap it with
 * the page's own CSS, and decode that SVG as an image into a canvas. What a plain clone loses, and what is baked:
 *
 *  - **Form state.** lil-gui writes `input.value`, `.checked` and `selectedIndex` as PROPERTIES; `cloneNode` copies
 *    attributes. Most toolbox readouts are disabled string inputs, so without this the panel reads blank.
 *  - **Scroll.** A clone lays out at scroll 0. Each scrolled element's children are translated by its offset
 *    instead, which leaves layout — and therefore hit mapping — identical to the page.
 *  - **Canvases and images.** An SVG image loads nothing external, so canvases become data-URL snapshots and
 *    same-origin `<img>` / inline `url()` assets are fetched once into a data-URL cache.
 *  - **Media queries.** Inside an SVG image they are evaluated against the IMAGE's size: a 300 px toolbox would
 *    match `max-width: 760px` and take the phone layout. So the page's CSS is flattened here, against the real
 *    window, and only the rules whose selectors could match the clone are embedded (`selectorRequirements`).
 *  - **Box sizes.** The image lays out at one device pixel per CSS pixel, and the page's borders are rounded to
 *    ITS device pixels, so the same markup comes out a little wider in the image. Every box is pinned to its size
 *    on the page (`pin`).
 *
 * The image covers a REGION of the page (a whole root, or the union of its `data-xr-edit` parts) laid out exactly
 * as it is on screen, so a UV on the drawn texture maps straight back to a client point, and `elementsFromPoint`
 * there finds the real control. `createDomPointer` turns trigger edges into the pointer/mouse/click sequence a
 * mouse would produce.
 *
 * Known gaps, deliberately left for after the headset verdict: native `<select>` popups (a click steps to the next
 * option instead), text/number/colour/file entry, hover-only tooltips, `vh`/`vw` units inside panels (resolved
 * against the image), and pointer capture for a synthetic pointer on runtimes without a mouse.
 */

/** Rasterization density: texture pixels per CSS pixel. Two keeps 11–12 px panel text sharp at arm's length
 *  after mipmapping; the palette's plane size, not this, sets how big it reads. */
export const MIRROR_SCALE = 2;
/** Floor between two repaints of one mirror (ms). Drags and scrolls look live at eight a second. */
const MIN_REPAINT_MS = 125;
/** Re-serialize at least this often even without a mutation: lil-gui's `.listen()` rows change `.value` only,
 *  which no observer sees. An unchanged serialization is dropped before any decode or upload. */
const POLL_MS = 1000;
/** A canvas inside a panel is re-snapshotted at most this often; toDataURL is a PNG encode. */
const CANVAS_REFRESH_MS = 1000;
/** Breathing room around a part, so a panel's own shadow and rounded corners are not cut. */
const PART_PAD = 4;
const MAX_ASSETS = 256;
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

export interface Rect { x: number; y: number; width: number; height: number }

export interface DomMirrorSpec {
  /** Id of the element whose subtree is cloned. */
  rootId: string;
  /** `data-xr-edit` keys to show, each as its own part: the union of every visible element carrying that key.
   *  Null shows the root as one part, cropped to its rendered children. */
  parts: readonly string[] | null;
  /** With `parts` null: show the root's own border box instead of its children's union — for a single control
   *  such as a button, whose padding and background are part of what it looks like. */
  ownBox?: boolean;
}

/** One drawn part: its key and where it sat on the page when the current image was taken. */
export interface MirrorPart { key: string | null; rect: Rect }

export interface DomMirrorStats {
  /** Clone + bake + serialize: the synchronous share, paid inside whichever frame asked for the repaint. */
  syncMs: number;
  /** Wall time for the SVG to decode. Asynchronous, but the browser parses and lays out the SVG document on the
   *  main thread, so a large value can still land between two headset frames. */
  decodeMs: number;
  /** `drawImage` into the canvas (where Chrome may rasterize the vector). */
  drawMs: number;
  /** SVG data-URL length: what every decode parses. */
  bytes: number;
  nodes: number;
  cssRules: number;
  /** Repaints that produced new pixels, and serializations dropped because nothing had changed. */
  repaints: number;
  unchanged: number;
  error: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// pure helpers (headless-tested)

/** Split a selector list on its top-level commas — not those inside `:is(a, b)`, attribute values or strings. */
export function splitSelectorList(text: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = '', start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === '\'') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/** Remove every functional pseudo-class with its argument (`:not(.x)`, `:is(…)`, `:has(…)`, `:nth-child(… of S)`),
 *  attribute selectors and strings: none of them makes a class or id REQUIRED for the selector to match. */
function stripOptionalParts(selector: string): string {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '"' || c === '\'') {
      for (i++; i < selector.length && selector[i] !== c; i++) if (selector[i] === '\\') i++;
      continue;
    }
    if (c === '[') {
      for (let depth = 1; depth > 0 && ++i < selector.length;) {
        if (selector[i] === '[') depth++; else if (selector[i] === ']') depth--;
      }
      continue;
    }
    if (c === ':') {
      const name = /^::?[-\w]+\(/.exec(selector.slice(i));
      if (name) {
        i += name[0].length;
        for (let depth = 1; depth > 0 && i < selector.length; i++) {
          if (selector[i] === '(') depth++; else if (selector[i] === ')') depth--;
        }
        i--;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/**
 * The class/id tokens each alternative of a selector list needs present somewhere in the clone, or null when some
 * alternative needs none (a bare `button`, `:root`, `*`), in which case the rule is always kept. A necessary
 * condition, not a match: cheap enough to run per repaint, and it removes the modal, menu and effects-editor rules
 * that would otherwise ride along in every image.
 */
export function selectorRequirements(selectorText: string): string[][] | null {
  const out: string[][] = [];
  for (const selector of splitSelectorList(selectorText)) {
    const tokens = stripOptionalParts(selector).match(/[.#]-?[_a-zA-Z\u00a0-\uffff][\w\u00a0-\uffff-]*/g);
    if (!tokens?.length) return null;
    out.push([...new Set(tokens)]);
  }
  return out.length ? out : null;
}

/** Whether a rule with these requirements could match given the tokens present. */
export function ruleMayApply(needs: readonly (readonly string[])[] | null, tokens: ReadonlySet<string>): boolean {
  return !needs || needs.some(required => required.every(token => tokens.has(token)));
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {
    x, y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/** Grow by `pad`, clip to the window, and snap outward to whole CSS pixels so texels land on pixel edges. */
export function paddedPixelRect(rect: Rect, pad: number, viewWidth: number, viewHeight: number): Rect | null {
  const left = Math.max(0, Math.floor(rect.x - pad)), top = Math.max(0, Math.floor(rect.y - pad));
  const right = Math.min(viewWidth, Math.ceil(rect.x + rect.width + pad));
  const bottom = Math.min(viewHeight, Math.ceil(rect.y + rect.height + pad));
  return right - left >= 1 && bottom - top >= 1 ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

/** Texture UV (three.js convention: v = 0 at the image's BOTTOM) to the client point it was drawn from. */
export function mirrorUvToClient(region: Rect, u: number, v: number): { x: number; y: number } {
  return { x: region.x + u * region.width, y: region.y + (1 - v) * region.height };
}

/** The UV sub-rectangle a part occupies inside its mirror's image: [u0, v0, u1, v1], v up. */
export function partUvRect(region: Rect, part: Rect): [number, number, number, number] {
  return [
    (part.x - region.x) / region.width,
    1 - (part.y + part.height - region.y) / region.height,
    (part.x + part.width - region.x) / region.width,
    1 - (part.y - region.y) / region.height,
  ];
}

/** The next selectable option stepping `direction` from `current`, wrapping, skipping disabled ones. Returns
 *  `current` when nothing else is selectable. */
export function nextSelectableIndex(disabled: readonly boolean[], current: number, direction: 1 | -1): number {
  const n = disabled.length;
  for (let step = 1; step <= n; step++) {
    const index = ((current + direction * step) % n + n) % n;
    if (!disabled[index]) return index;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------------------------
// the page's CSS, flattened against the real window

interface CssEntry { text: string; needs: string[][] | null }

let cssCache: { key: string; rules: CssEntry[] } | null = null;
/** Bumped when a fetched asset lands, so CSS `url()`s rewritten before it arrived are rewritten again. */
let assetGeneration = 0;
const liveMirrors = new Set<{ markDirty(): void }>();

function mediaMatches(text: string): boolean {
  return !text || text === 'all' || matchMedia(text).matches;
}

function readRules(sheet: CSSStyleSheet): CSSRuleList | null {
  try { return sheet.cssRules; } catch { return null; } // a cross-origin sheet: unreadable, and unused by the panels
}

function flattenRules(rules: CSSRuleList, base: string, out: CssEntry[]) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSMediaRule) {
      if (mediaMatches(rule.media.mediaText)) flattenRules(rule.cssRules, base, out);
    } else if (rule instanceof CSSSupportsRule) {
      if (CSS.supports(rule.conditionText)) flattenRules(rule.cssRules, base, out);
    } else if (rule instanceof CSSImportRule) {
      const sheet = rule.styleSheet;
      const nested = sheet && mediaMatches(rule.media.mediaText) ? readRules(sheet) : null;
      if (nested) flattenRules(nested, sheet?.href ?? base, out);
    } else if (rule instanceof CSSStyleRule && !rule.cssRules?.length) {
      out.push({ text: rewriteCssUrls(rule.cssText, base), needs: selectorRequirements(rule.selectorText) });
    } else {
      // @font-face (lil-gui's glyph font is an inline woff2), @keyframes, @property, nested rules: always kept.
      out.push({ text: rewriteCssUrls(rule.cssText, base), needs: null });
    }
  }
}

/** Anything that changes which media queries match, or which assets are inlined, invalidates the flattening. */
function cssKey(): string {
  let rules = 0;
  for (const sheet of Array.from(document.styleSheets)) rules += readRules(sheet)?.length ?? 0;
  return [
    document.styleSheets.length, rules, innerWidth, innerHeight, devicePixelRatio,
    matchMedia('(pointer: coarse)').matches, matchMedia('(hover: hover)').matches, assetGeneration,
  ].join('|');
}

function pageCss(): CssEntry[] {
  const key = cssKey();
  if (cssCache?.key === key) return cssCache.rules;
  const rules: CssEntry[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    if (sheet.disabled || !mediaMatches(sheet.media.mediaText)) continue;
    const list = readRules(sheet);
    if (list) flattenRules(list, sheet.href ?? document.baseURI, rules);
  }
  cssCache = { key, rules };
  return rules;
}

// ---------------------------------------------------------------------------------------------------------------
// assets: same-origin images and CSS backgrounds, inlined once

const assets = new Map<string, string | null>();

/** A data URL for `url`, or null while it is being fetched (or when it cannot be inlined at all). */
function assetUrl(raw: string, base: string): string | null {
  if (raw.startsWith('data:')) return raw;
  let url: URL;
  try { url = new URL(raw, base); } catch { return null; }
  if (url.origin !== location.origin) return null;
  const key = url.href;
  const known = assets.get(key);
  if (known !== undefined) {
    // Most recently drawn last, so eviction below takes the asset that has been off screen longest.
    if (known !== null) { assets.delete(key); assets.set(key, known); }
    return known;
  }
  if (assets.size >= MAX_ASSETS) {
    // A library grid scrolls through far more tiles than it shows at once: make room rather than refuse. Pending
    // and failed entries stay, so neither is fetched again.
    for (const [old, data] of assets) if (data !== null) { assets.delete(old); break; }
    if (assets.size >= MAX_ASSETS) return null;
  }
  assets.set(key, null);
  void fetch(key, { credentials: 'same-origin' })
    .then(response => response.ok ? response.blob() : Promise.reject(new Error(String(response.status))))
    .then(blob => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    }))
    .then(data => {
      assets.set(key, data);
      assetGeneration++;
      for (const mirror of liveMirrors) mirror.markDirty();
    })
    .catch(() => { /* stays null: drawn without it rather than retried every repaint */ });
  return null;
}

function rewriteCssUrls(text: string, base: string): string {
  if (!text.includes('url(')) return text;
  return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole, _quote: string, url: string) => {
    if (url.startsWith('data:')) return whole;
    const data = assetUrl(url, base);
    return data ? `url("${data}")` : 'url("")';
  });
}

// ---------------------------------------------------------------------------------------------------------------
// the clone

/** Elements that can be hidden or box-less for reasons that do not remove what they contribute. */
const NEVER_PRUNE = new Set(['br', 'wbr', 'option', 'optgroup', 'style', 'source', 'track', 'col', 'colgroup',
  'area', 'map', 'template']);
/** Leaves whose insides are either replaced here or rendered by the element itself. */
const NO_DESCEND = new Set(['svg', 'select', 'canvas', 'img', 'textarea', 'picture', 'math']);
const REMOVE = new Set(['script', 'noscript', 'iframe', 'object', 'embed', 'video', 'audio']);

const canvasSnapshots = new WeakMap<HTMLCanvasElement, { url: string; at: number }>();

function hidden(element: Element): boolean {
  if (!(element instanceof HTMLElement) || NEVER_PRUNE.has(element.localName)) return false;
  if (typeof element.checkVisibility === 'function' ? element.checkVisibility() : element.getClientRects().length) return false;
  return getComputedStyle(element).display === 'none'; // `display: contents` has no box but must keep its children
}

function setFlag(element: Element, name: string, on: boolean) {
  if (on) element.setAttribute(name, ''); else element.removeAttribute(name);
}

function canvasUrl(canvas: HTMLCanvasElement, now: number): string {
  const cached = canvasSnapshots.get(canvas);
  if (cached && now - cached.at < CANVAS_REFRESH_MS) return cached.url;
  let url = TRANSPARENT_PIXEL;
  try { if (canvas.width && canvas.height) url = canvas.toDataURL(); } catch { /* tainted: leave it blank */ }
  canvasSnapshots.set(canvas, { url, at: now });
  return url;
}

/** Bake what `cloneNode` drops. Returns the element that now stands in the clone (a canvas becomes an img). */
function bake(source: Element, copy: Element, now: number): Element {
  const name = source.localName;
  if (REMOVE.has(name)) {
    // Keep the box, lose the content: a video or iframe would load nothing inside an image anyway.
    const stand = document.createElement('div');
    for (const attr of ['id', 'class', 'style']) { const v = copy.getAttribute(attr); if (v !== null) stand.setAttribute(attr, v); }
    if (source instanceof HTMLElement && name !== 'script' && name !== 'noscript') {
      stand.style.width = `${source.offsetWidth}px`; stand.style.height = `${source.offsetHeight}px`;
    } else stand.style.display = 'none';
    copy.replaceWith(stand);
    return stand;
  }
  if (source instanceof HTMLInputElement) {
    if (source.type === 'checkbox' || source.type === 'radio') setFlag(copy, 'checked', source.checked);
    else if (source.type !== 'file' && source.type !== 'password') copy.setAttribute('value', source.value);
  } else if (source instanceof HTMLTextAreaElement) {
    copy.textContent = source.value;
  } else if (source instanceof HTMLSelectElement) {
    const options = (copy as HTMLSelectElement).options;
    for (let i = 0; i < source.options.length && i < options.length; i++) {
      setFlag(options[i], 'selected', source.options[i].selected);
    }
  } else if (source instanceof HTMLCanvasElement) {
    const image = document.createElement('img');
    for (const attr of Array.from(copy.attributes)) image.setAttribute(attr.name, attr.value);
    image.setAttribute('width', String(source.width));
    image.setAttribute('height', String(source.height));
    image.src = canvasUrl(source, now);
    copy.replaceWith(image);
    return image;
  } else if (source instanceof HTMLImageElement) {
    const data = assetUrl(source.currentSrc || source.src, document.baseURI);
    copy.removeAttribute('srcset');
    copy.setAttribute('src', data ?? TRANSPARENT_PIXEL);
    if (!data && source.offsetWidth) {
      (copy as HTMLElement).style.width = `${source.offsetWidth}px`;
      (copy as HTMLElement).style.height = `${source.offsetHeight}px`;
    }
  }
  const style = copy.getAttribute('style');
  if (style?.includes('url(')) copy.setAttribute('style', rewriteCssUrls(style, document.baseURI));
  return copy;
}

/** Move a scrolled element's children by its scroll offset, so the clone shows what the page shows without a
 *  scroll position (which serialization cannot carry). Transforms leave layout — and hit mapping — alone. */
function emulateScroll(copy: Element, left: number, top: number) {
  for (const child of Array.from(copy.children)) {
    if (child instanceof HTMLElement || child instanceof SVGElement) {
      child.style.setProperty('transform', `translate(${-left}px, ${-top}px)`, 'important');
    }
  }
}

/** Whether a laid-out element lies wholly outside the drawn region, so nothing it paints could be seen. Box-less
 *  and inline elements never qualify: a `display: contents` wrapper reports an empty rect at the origin while its
 *  children are on screen, and emptying an inline would reflow the line it sits in. */
function culled(source: Element, clip: Rect): source is HTMLElement {
  if (!(source instanceof HTMLElement) || NEVER_PRUNE.has(source.localName)) return false;
  const r = source.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (r.right > clip.x && r.left < clip.x + clip.width && r.bottom > clip.y && r.top < clip.y + clip.height) return false;
  const display = getComputedStyle(source).display;
  return display !== 'inline' && display !== 'contents';
}

/** Keep a culled element's box, and only its box: its contents (a scrolled-away library tile's inlined art, a
 *  canvas snapshot) would cost serialization and decode for pixels the image never shows. */
function hollow(source: HTMLElement, copy: Element) {
  const box = copy as HTMLElement;
  box.replaceChildren();
  if (!pin(source, box)) {
    // A transformed box or a table row: offsetWidth/Height still give its layout size, rounded to whole pixels.
    important(box, { 'box-sizing': 'border-box', width: `${source.offsetWidth}px`, height: `${source.offsetHeight}px` });
  }
  important(box, { visibility: 'hidden', 'background-image': 'none' });
}

/** Displays whose width and height mean nothing: inline runs, box-less wrappers, and table rows and groups. */
const UNPINNABLE = /^(inline|contents|none|table-(row|row-group|header-group|footer-group|column|column-group|caption))$/;
const px = (value: number) => `${Math.round(value * 1000) / 1000}px`;

/**
 * Fix a cloned element's border box at the size its source has on the page. The image lays out at one device
 * pixel per CSS pixel, and the page usually does not. Chrome rounds borders down to whole device pixels, so a 1 px
 * border is 0.57 px on a 1.75× screen but a full 1 px in the image. Every bordered button in a row then comes out
 * wider, and the row drifts: 5–7 px across the top bar, to the left, because its flex spacers give the growth
 * back. With every box pinned, a border (or a fallback font, an image's intrinsic size, a `vw` length) can only
 * change what is inside its own box, and every control stays where the page, and so the hit mapping, has it.
 * False when the source has no box that can be pinned, or is transformed so its client rect is not its size.
 */
function pin(source: HTMLElement, copy: HTMLElement): boolean {
  const style = getComputedStyle(source);
  if (UNPINNABLE.test(style.display) || style.transform !== 'none') return false;
  const r = source.getBoundingClientRect();
  // The size inline; the rest, the same for every pinned box, once in PINNED_CSS (a smaller image to decode).
  copy.setAttribute(PIN_ATTRIBUTE, '');
  important(copy, { width: px(r.width), height: px(r.height) });
  return true;
}
const PIN_ATTRIBUTE = 'data-xr-pin';
/** An auto minimum is the content's size, which the image's thicker borders make larger than the pinned box. */
const PINNED_CSS = `[${PIN_ATTRIBUTE}]{box-sizing:border-box!important;flex:none!important;min-width:0!important;`
  + 'min-height:0!important;max-width:none!important;max-height:none!important}';

function snapshot(root: HTMLElement, now: number, clip: Rect): { clone: HTMLElement; nodes: number } {
  const clone = root.cloneNode(true) as HTMLElement;
  let nodes = 0;
  const visit = (source: Element, copy: Element) => {
    nodes++;
    const baked = bake(source, copy, now);
    if (source instanceof HTMLElement && baked instanceof HTMLElement && source !== root) pin(source, baked);
    if (NO_DESCEND.has(source.localName) || baked !== copy) return;
    const sources = Array.from(source.children), copies = Array.from(copy.children);
    for (let i = 0; i < sources.length && i < copies.length; i++) {
      const child = sources[i];
      if (hidden(child)) copies[i].remove();
      else if (culled(child, clip)) hollow(child, copies[i]);
      else visit(child, copies[i]);
    }
    if (source.scrollTop || source.scrollLeft) emulateScroll(copy, source.scrollLeft, source.scrollTop);
  };
  visit(root, clone);
  return { clone, nodes };
}

function tokensOf(element: Element, into: Set<string>) {
  if (element.id) into.add(`#${element.id}`);
  const cls = element.getAttribute('class');
  if (cls) for (const name of cls.split(/\s+/)) if (name) into.add(`.${name}`);
}

function important(element: HTMLElement, properties: Record<string, string>) {
  for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
}

/** The page's `:root` / body custom properties set from script (the CSS-declared ones travel with the CSS). */
function copyCustomProperties(from: HTMLElement, to: HTMLElement) {
  for (const name of Array.from(from.style)) {
    if (name.startsWith('--')) to.style.setProperty(name, from.style.getPropertyValue(name));
  }
}

/** Wrap the clone in stand-ins for html, body and any ancestors so ancestor-scoped selectors still match, place it
 *  where it sits relative to `region`, and serialize the lot as one SVG. */
function buildSvg(root: HTMLElement, clone: HTMLElement, rootRect: Rect, region: Rect, scale: number): {
  svg: string; cssRules: number;
} {
  const html = document.createElement('html');
  html.className = document.documentElement.className;
  copyCustomProperties(document.documentElement, html);
  const body = document.createElement('body');
  body.className = document.body.className;
  copyCustomProperties(document.body, body);
  const frame = {
    margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible',
    width: `${region.width}px`, height: `${region.height}px`, position: 'relative',
  };
  important(html, frame);
  important(body, frame);
  const tokens = new Set<string>();
  tokensOf(html, tokens);
  tokensOf(body, tokens);
  let parent: HTMLElement = body;
  const chain: HTMLElement[] = [];
  for (let node = root.parentElement; node && node !== document.body; node = node.parentElement) chain.unshift(node);
  for (const ancestor of chain) {
    const stand = document.createElement(ancestor.localName);
    if (ancestor.id) stand.id = ancestor.id;
    if (ancestor.className) stand.className = ancestor.className;
    important(stand, {
      display: 'block', position: 'static', margin: '0', padding: '0', border: '0', width: 'auto', height: 'auto',
      transform: 'none', overflow: 'visible', background: 'transparent',
    });
    tokensOf(stand, tokens);
    parent.appendChild(stand);
    parent = stand;
  }
  important(clone, {
    position: 'absolute', left: `${rootRect.x - region.x}px`, top: `${rootRect.y - region.y}px`,
    right: 'auto', bottom: 'auto', width: `${rootRect.width}px`, height: `${rootRect.height}px`,
    margin: '0', transform: 'none', 'box-sizing': 'border-box',
    'max-width': 'none', 'max-height': 'none', 'min-width': '0', 'min-height': '0',
  });
  parent.appendChild(clone);
  tokensOf(clone, tokens);
  for (const element of Array.from(clone.querySelectorAll('[class], [id]'))) tokensOf(element, tokens);

  let css = '', cssRules = 0;
  for (const rule of pageCss()) {
    if (!ruleMayApply(rule.needs, tokens)) continue;
    css += rule.text + '\n';
    cssRules++;
  }
  css += PINNED_CSS;
  const head = document.createElement('head');
  const style = document.createElement('style');
  style.textContent = css;
  head.appendChild(style);
  html.append(head, body);

  const markup = new XMLSerializer().serializeToString(html);
  const w = Math.max(1, Math.round(region.width * scale)), h = Math.max(1, Math.round(region.height * scale));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" `
    + `viewBox="0 0 ${region.width} ${region.height}"><foreignObject x="0" y="0" `
    + `width="${region.width}" height="${region.height}">${markup}</foreignObject></svg>`;
  return { svg, cssRules };
}

function clientRect(element: Element): Rect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** Where each part sits on the page right now, and the region that covers them. Null when nothing is visible. */
function measure(root: HTMLElement, keys: readonly string[] | null, ownBox = false):
  { region: Rect; parts: MirrorPart[] } | null {
  const view = (rect: Rect) => paddedPixelRect(rect, keys ? PART_PAD : 0, innerWidth, innerHeight);
  if (!keys && ownBox) {
    const rect = view(clientRect(root));
    return rect ? { region: rect, parts: [{ key: null, rect }] } : null;
  }
  if (!keys) {
    // The root's rendered children, not its box: a dock taller than its panels is empty (and see-through on the
    // page) below them, and that emptiness would otherwise be palette area on the wrist.
    const box = clientRect(root);
    let used: Rect | null = null;
    for (const child of Array.from(root.children)) {
      const rect = clientRect(child);
      if (rect.width >= 1 && rect.height >= 1) used = unionRect(used, rect);
    }
    const clipped = used && intersectRect(used, box);
    const rect = view(clipped ?? box);
    return rect ? { region: rect, parts: [{ key: null, rect }] } : null;
  }
  const parts: MirrorPart[] = [];
  for (const key of keys) {
    let union: Rect | null = null;
    for (const element of Array.from(root.querySelectorAll(`[data-xr-edit="${key}"]`))) {
      const rect = clientRect(element);
      if (rect.width >= 1 && rect.height >= 1) union = unionRect(union, rect);
    }
    const rect = union && view(union);
    if (rect) parts.push({ key, rect });
  }
  if (!parts.length) return null;
  let region: Rect | null = null;
  for (const part of parts) region = unionRect(region, part.rect);
  return { region: region!, parts };
}

// ---------------------------------------------------------------------------------------------------------------
// the mirror

export function createDomMirror(spec: DomMirrorSpec, scale = MIRROR_SCALE) {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  let root: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let active = false, dirty = true, decoding = false;
  let lastPaint = -Infinity, lastSerialize = -Infinity;
  let lastSignature = '';
  /** Where the CURRENT image came from, so hit mapping matches the pixels on show rather than a newer layout. */
  let region: Rect | null = null;
  let parts: MirrorPart[] = [];
  let version = 0;
  let taintChecked = false;
  const stats: DomMirrorStats = {
    syncMs: 0, decodeMs: 0, drawMs: 0, bytes: 0, nodes: 0, cssRules: 0, repaints: 0, unchanged: 0, error: null,
  };
  const markDirty = () => { dirty = true; };
  const handle = { markDirty };

  function detach() {
    observer?.disconnect();
    observer = null;
    if (root) {
      root.removeEventListener('input', markDirty, true);
      root.removeEventListener('change', markDirty, true);
      root.removeEventListener('scroll', markDirty, true);
    }
    root = null;
  }

  /** Follow the root by id, so a panel host that is replaced wholesale is picked up again. */
  function attach() {
    const found = document.getElementById(spec.rootId);
    if (found === root) return;
    detach();
    root = found;
    if (!root) return;
    observer = new MutationObserver(markDirty);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    // Value properties and scroll offsets change without a mutation.
    root.addEventListener('input', markDirty, true);
    root.addEventListener('change', markDirty, true);
    root.addEventListener('scroll', markDirty, true);
    dirty = true;
  }

  function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    if (on) { liveMirrors.add(handle); attach(); dirty = true; lastSignature = ''; }
    else { liveMirrors.delete(handle); detach(); }
  }

  function clear() {
    if (!region) return;
    region = null; parts = []; lastSignature = ''; version++;
  }

  /**
   * Repaint if one is due and allowed. The host passes `allowWork` false once another mirror has already spent
   * this frame's budget, so three panels never serialize in the same headset frame. True when this call did work.
   */
  function tick(now: number, allowWork = true): boolean {
    if (!active) return false;
    attach();
    if (!root || decoding || !allowWork || now - lastPaint < MIN_REPAINT_MS) return false;
    if (!dirty && now - lastSerialize < POLL_MS) return false;
    dirty = false;
    lastSerialize = now;
    const started = performance.now();
    const layout = measure(root, spec.parts, spec.ownBox);
    if (!layout) { clear(); return true; }
    const rootRect = clientRect(root);
    const { clone, nodes } = snapshot(root, now, layout.region);
    const { svg, cssRules } = buildSvg(root, clone, rootRect, layout.region, scale);
    stats.syncMs = performance.now() - started;
    stats.nodes = nodes;
    stats.cssRules = cssRules;
    const signature = svg + JSON.stringify(layout);
    if (signature === lastSignature) { stats.unchanged++; return true; }
    lastSignature = signature;
    lastPaint = now;
    decoding = true;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    stats.bytes = url.length;
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    const decodeStarted = performance.now();
    image.decode().then(() => {
      stats.decodeMs = performance.now() - decodeStarted;
      const drawStarted = performance.now();
      const w = Math.max(1, Math.round(layout.region.width * scale));
      const h = Math.max(1, Math.round(layout.region.height * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      else ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      stats.drawMs = performance.now() - drawStarted;
      if (!taintChecked) {
        taintChecked = true;
        // A tainted canvas cannot be uploaded to WebGL at all; say so once instead of failing every frame.
        try { ctx.getImageData(0, 0, 1, 1); } catch { stats.error = 'canvas tainted by the SVG image'; }
      }
      if (stats.error && !stats.error.startsWith('canvas tainted')) stats.error = null;
      region = layout.region;
      parts = layout.parts;
      stats.repaints++;
      version++;
    }).catch((error: unknown) => {
      stats.error = `decode failed: ${error instanceof Error ? error.message : String(error)}`;
      lastSignature = '';
    }).finally(() => { decoding = false; });
    return true;
  }

  return {
    spec, canvas, stats,
    /** Changes whenever the canvas holds a new image (or none). */
    get version() { return version; },
    get region() { return region; },
    get parts() { return parts; },
    get root() { return root; },
    get tainted() { return stats.error !== null && stats.error.startsWith('canvas tainted'); },
    setActive, tick, markDirty,
    /** Client point under a texture UV on the image currently shown. */
    toClient(u: number, v: number) { return region ? mirrorUvToClient(region, u, v) : null; },
    dispose() { setActive(false); canvas.width = canvas.height = 1; },
  };
}

export type DomMirror = ReturnType<typeof createDomMirror>;

// ---------------------------------------------------------------------------------------------------------------
// input: trigger edges into the events a mouse would have produced

export interface DomPointerTarget { root: HTMLElement; x: number; y: number }

/** What the highlight frames: the control a press would act on, not the text node inside it. */
const ACTIONABLE = 'button, a[href], input, select, textarea, label, summary, [role="button"], [tabindex], '
  + '.lil-controller, .lil-title';
/** Chrome's mouse is pointer 1. Reusing it lets `setPointerCapture` succeed where a mouse exists at all. */
const POINTER_ID = 1;
/** Hover hit-testing is repeated only when the point moves this far, or this long has passed. */
const HOVER_EPSILON_PX = 0.5, HOVER_REFRESH_MS = 100;

export function createDomPointer() {
  let hovered: Element | null = null;
  let hoveredAt: DomPointerTarget | null = null;
  let hoveredTime = -Infinity;
  let pressedOn: Element | null = null;
  let pressRoot: HTMLElement | null = null;
  let last: DomPointerTarget | null = null;
  let down = false;
  /** The secondary (right) button: a press, a release, and the context menu — the Palette's ride-feel menu. */
  let rightDown = false, rightOn: Element | null = null;
  let notice = '';

  function elementAt(target: DomPointerTarget): Element | null {
    for (const element of document.elementsFromPoint(target.x, target.y)) {
      if (target.root.contains(element)) return element;
    }
    return null;
  }

  function refreshHover(target: DomPointerTarget | null, now: number) {
    if (!target) { hovered = null; hoveredAt = null; return; }
    const moved = !hoveredAt || hoveredAt.root !== target.root
      || Math.abs(hoveredAt.x - target.x) >= HOVER_EPSILON_PX || Math.abs(hoveredAt.y - target.y) >= HOVER_EPSILON_PX;
    if (!moved && now - hoveredTime < HOVER_REFRESH_MS) return;
    hovered = elementAt(target);
    hoveredAt = target;
    hoveredTime = now;
  }

  /** `button` is the one that changed (0 primary, 2 secondary); moves report none, -1 for pointer events. */
  function fire(element: Element, type: string, at: { x: number; y: number }, buttons: number, moving = false,
                button = 0) {
    const pointer = type.startsWith('pointer');
    const init: MouseEventInit = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: at.x, clientY: at.y, screenX: at.x, screenY: at.y,
      button: moving && pointer ? -1 : button, buttons,
    };
    element.dispatchEvent(pointer
      ? new PointerEvent(type, {
        ...init, pointerId: POINTER_ID, pointerType: 'mouse', isPrimary: true, width: 1, height: 1,
        pressure: buttons ? 0.5 : 0,
      })
      : new MouseEvent(type, init));
  }

  function commonAncestor(a: Element, b: Element): Element | null {
    let node: Node | null = a;
    while (node && !node.contains(b)) node = node.parentNode;
    return node instanceof Element ? node : null;
  }

  const TYPED = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);

  function activate(element: Element, at: { x: number; y: number }) {
    const select = element.closest('select');
    if (select instanceof HTMLSelectElement) {
      // A native dropdown's popup is browser chrome a headset never sees; step through it instead.
      const next = nextSelectableIndex(Array.from(select.options, option => option.disabled), select.selectedIndex, 1);
      if (next !== select.selectedIndex) {
        select.selectedIndex = next;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const name = select.getAttribute('aria-label')
        ?? select.closest('.lil-controller')?.querySelector('.lil-name')?.textContent?.trim() ?? 'Dropdown';
      notice = `${name} → ${select.options[next]?.text ?? ''}`;
      return;
    }
    const field = element.closest('input, textarea');
    if (field instanceof HTMLInputElement && (field.type === 'file' || field.type === 'color')) {
      notice = field.type === 'file' ? 'File pickers are desktop-only' : 'Colour pickers are desktop-only';
      return;
    }
    if ((field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TYPED.has(field.type)))
      && !field.disabled && !field.readOnly) notice = 'Typing is desktop-only · drag a number to scrub it';
    fire(element, 'click', at, 0);
  }

  /** Let go: up events where the pointer is, and — unless the palette is being put away — the click a mouse
   *  would produce, on the nearest element containing both the press and the release. */
  function release(target: DomPointerTarget | null, click: boolean) {
    down = false;
    const from = pressedOn, root = pressRoot;
    pressedOn = null; pressRoot = null;
    if (!from || !last) return;
    const at = target ?? last;
    const upOn = (target && hovered) || from;
    fire(upOn, 'pointerup', at, 0);
    fire(upOn, 'mouseup', at, 0);
    if (!click) return;
    const clickOn = commonAncestor(from, upOn);
    if (clickOn && root?.contains(clickOn)) activate(clickOn, at);
  }

  /** The secondary button: down on the control under the point, up where it is released, then `contextmenu`. */
  function secondary(target: DomPointerTarget | null, pressed: boolean) {
    if (pressed && !rightDown) {
      rightDown = true;
      if (!target || !hovered) return;
      rightOn = hovered;
      fire(hovered, 'pointerdown', target, 2, false, 2);
      fire(hovered, 'mousedown', target, 2, false, 2);
    } else if (!pressed && rightDown) {
      rightDown = false;
      const from = rightOn;
      rightOn = null;
      const at = target ?? last;
      if (!from || !at) return;
      const upOn = (target && hovered) || from;
      fire(upOn, 'pointerup', at, 0, false, 2);
      fire(upOn, 'mouseup', at, 0, false, 2);
      fire(upOn, 'contextmenu', at, 0, false, 2);
    }
  }

  /**
   * One frame of input. `target` is where the ray meets a mirrored panel (null off every panel); `pressed` is the
   * primary button (the trigger), `right` the secondary (A). A press starts only ON a panel. Once started, moves
   * go to the pressed element — the implicit capture a mouse drag has — for as long as the host keeps supplying a
   * point, which it does off the panel's edge by extending the panel's plane, so a lil-gui slider (window-level
   * mousemove) follows a hand that overshoots.
   */
  function update(target: DomPointerTarget | null, pressed: boolean, right = false, now = performance.now()) {
    refreshHover(target, now);
    secondary(target, right);
    if (pressed && !down) {
      down = true;
      if (target) last = target;
      if (!target || !hovered) return;
      pressedOn = hovered;
      pressRoot = target.root;
      notice = '';
      fire(hovered, 'pointerdown', target, 1);
      fire(hovered, 'mousedown', target, 1);
      return;
    }
    if (pressed && down) {
      if (!pressedOn || !target) return;
      if (last && Math.abs(last.x - target.x) < HOVER_EPSILON_PX && Math.abs(last.y - target.y) < HOVER_EPSILON_PX) return;
      last = target;
      fire(pressedOn, 'pointermove', target, 1, true);
      fire(pressedOn, 'mousemove', target, 1, true);
      return;
    }
    if (target) last = target;
    if (!pressed && down) release(target, true);
  }

  /** Scroll whatever scrolls under the point by `dy` CSS pixels. False when nothing there can scroll. */
  function scroll(target: DomPointerTarget | null, dy: number): boolean {
    if (!target || !dy) return false;
    for (let node = elementAt(target); node && target.root.contains(node); node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) continue;
      node.scrollTop += dy;
      return true;
    }
    return false;
  }

  return {
    update, scroll,
    /** The deepest element under the point, and the control it belongs to (null over empty panel space). */
    get hovered() { return hovered; },
    get hoveredControl(): Element | null {
      const root = hoveredAt?.root;
      const control = hovered?.closest(ACTIONABLE) ?? null;
      return control && root?.contains(control) ? control : null;
    },
    /** True between a press that landed on a panel and its release: that button belongs to the panel. */
    get dragging() { return (down && pressedOn !== null) || (rightDown && rightOn !== null); },
    get pressed() { return down || rightDown; },
    /** The last thing worth telling the wearer (a dropdown step, a desktop-only control). */
    get notice() { return notice; },
    clearNotice() { notice = ''; },
    /** Put the pointer away: a drag in progress is released without a click. */
    reset() {
      if (down) release(null, false);
      if (rightDown && rightOn && last) {
        fire(rightOn, 'pointerup', last, 0, false, 2);
        fire(rightOn, 'mouseup', last, 0, false, 2);
      }
      down = false; rightDown = false; rightOn = null; hovered = null; hoveredAt = null;
    },
  };
}

export type DomPointer = ReturnType<typeof createDomPointer>;
