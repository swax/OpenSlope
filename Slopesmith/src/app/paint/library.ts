/**
 * Texture Library: the bottom panel of the level's real extracted texture files. One flat list (no
 * grouping — SurfaceType is physics, not look). Tiles carry only their look here: a clicked or dragged
 * tile lands at the default ride feel (snow); the ride feel is chosen per-cell in the Palette's Surface
 * mode. Click a tile to paint with it, or drag it up into your Palette (the staging pad in Tools) to
 * stage it. Middle-clicking a textured mountain/reference/prop surface samples it through this same brush
 * path; ordinary LMB only inspects/selects. The panel collapses to its header to free screen space. A DOM panel (not
 * lil-gui) because picking textures wants to SEE them (thumbnails), served from /api/texture.
 *
 * The same grid doubles as a one-shot texture PICKER (openPick / TexturePick): raised from elsewhere in the
 * editor — the Edit model banner's texture swatch — it borrows the panel over whatever mode is up, a tile
 * click answers the request instead of arming a brush, and Esc / Cancel / ✕ backs out. That is why the host's
 * "Texture Library only in Paint mode" rule has to consult `picking` before hiding the panel.
 * See docs/005-texture-paint.md.
 */
import { CUSTOM_TEX_LEVEL, makeTexRef, parseTexRef, type Brush, type LevelTextures, type TexRef, type TexTile } from '../../core/paint/textures';
import { DEFAULT_SURFACE } from '../../core/doc/types';
import { DRAG_TILE } from './drag-drop';
import { F_SVG_URL } from './glyph';
import { openTextureGenDialog } from './texture-gen';
import { tooltip } from '../ui/components/tooltip';
import { fetchJson, postJson } from '../net/fetch-json';
import { registerReferenceTextureRevisions, textureUrl } from '../net/asset-paths';
import { installStyles } from '../ui/components/styles';
import { defaultLibrarySource } from '../ui/components/library-default';
import { askName, confirmAction } from '../ui/components/prompts';
import { contextMenu } from '../ui/components/controls';
import { toast } from '../ui/components/toast';
import type { TexturePick } from './texture-pick';

export type { TexturePick } from './texture-pick';

/**
 * A one-shot "choose a texture" request (see openPick). The panel borrows the bottom dock from whatever mode
 * is up, a tile click ANSWERS the request instead of arming a paint brush, and ✕ / Esc cancels it. The Edit
 * model banner's texture swatch opens one — picking a tile off the art beats typing "GARI/0106.png" from
 * memory, which is what that field used to ask for — and the Generate texture dialog's Transition / Decal
 * tabs open them for their input tiles (the dialog steps aside while the question is up).
 */
export interface PaletteCallbacks {
  /** A texture was selected — the brush carries the ride feel chosen at the top of the panel. */
  onBrush(brush: Brush, sampled?: boolean): void;
  /** A pick finished (answered or cancelled) — the host reapplies its normal per-mode show/hide rule. */
  onPickEnd?(): void;
  /** The panel was shown / hidden — re-place overlays that sit above it. */
  onHeightChange?(): void;
  /** The panel's ✕ was pressed — the host hides it and remembers it as closed. */
  onClose?(): void;
  /** The tiles currently staged in the Palette, so the Library can drop them when "hide staged" is on. */
  stagedRefs?(): Set<string>;
  /** A tile just landed in the library; rebuild consumers that retain decoded GPU textures. */
  onTextureRevision?(ref: TexRef): void;
  /** How many places in the LIVE document wear this tile — painted cells plus authored models. Lets the
   *  delete and replace confirmations say what they cost instead of asking the author to remember. */
  docTexUsage?(ref: TexRef): number;
  /** A custom tile was renamed or replaced: repoint the document's refs so painted cells keep their art. */
  onTextureRenamed?(from: TexRef, to: TexRef): void;
  /** A custom tile was deleted: drop the document's refs so nothing is left pointing at a missing file. */
  onTextureDeleted?(ref: TexRef): void;
  /** The reference level being studied, for the opening-view rule (library-default.ts). Empty when none. */
  refLevel?(): string;
  /** Live name of the open authored mountain, used for its pinned local-asset entry. */
  mountainName?(): string;
}

const css = `
.sp-pal { position: fixed; left: 0; right: 0; bottom: 0; height: 250px; overflow: hidden;
  background: #0c141de8; border-top: 1px solid #2c3e50; color: #d7e3f0;
  font: 12px/1.4 system-ui, sans-serif; z-index: 16; display: none; flex-direction: column; }
.sp-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 6px; flex: 0 0 auto;
  flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
/* keep each control its natural size (only the spacer flexes) so a too-narrow header scrolls sideways
   instead of wrapping or squishing — matters on mobile */
.sp-head > *:not(.sp-grow) { flex-shrink: 0; }
.sp-title { display: inline-flex; align-items: center; gap: 6px; color: #9fb3c8;
  font: 600 12px system-ui, sans-serif; white-space: nowrap; }
/* choose-a-texture mode: the panel is answering a question rather than offering a brush, so it names the
   question in the title, greens its edge, and shows the way out next to the ✕. */
.sp-pal.sp-picking { border-top: 1px solid #6ee7a8; }
.sp-pal.sp-picking .sp-title { color: #6ee7a8; }
.sp-pickcancel { background: #1c2b3a; border: 1px solid #34506b; color: #cfe3f5; border-radius: 5px;
  padding: 3px 10px; font: inherit; font-size: 11px; cursor: pointer; }
.sp-pickcancel:hover { background: #25425c; }
.sp-close { background: transparent; border: 0; color: #7f97ac; cursor: pointer; font-size: 15px; line-height: 1;
  padding: 2px 5px; border-radius: 4px; }
.sp-close:hover { color: #eaf6ff; background: #ffffff14; }
.sp-pal select { background: #15202c; color: #d7e3f0; border: 1px solid #2c3e50; border-radius: 4px; padding: 3px 5px; }
.sp-grow { flex: 1 1 auto; }
.sp-filt { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: #9fb3c8; font-size: 11px; white-space: nowrap; }
.sp-filt input { cursor: pointer; margin: 0; }
.sp-body { flex: 1 1 auto; overflow: auto; padding: 4px 12px 12px; }
.sp-hint { color: #6f8398; font-size: 11px; margin: 0 0 8px; }
.sp-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(56px, 1fr)); gap: 6px; }
.sp-tile { position: relative; width: 100%; aspect-ratio: 1; border: 2px solid transparent; border-radius: 5px;
  cursor: grab; background-size: cover; image-rendering: auto; } /* file-native: shown 0 = up, as on disk */
.sp-tile:active { cursor: grabbing; }
.sp-tile:hover { border-color: #6ee7a8; }
/* the tile-orientation F overlay (top-bar F toggle): drawn INSIDE the swatch so it rides the art */
.sp-pal.show-f .sp-tile::after { content: ''; position: absolute; inset: 33.33%; pointer-events: none;
  background: ${F_SVG_URL} center/contain no-repeat; }
.sp-tile.sel { border-color: #ffc24d; box-shadow: 0 0 0 2px #ffc24d, 0 0 12px 3px #ffc24daa; z-index: 2;
  animation: sp-sel-pulse .5s ease-out; }
/* the Custom level's "+ add texture" and "✨ generate texture" cells — tile-shaped buttons, first in the grid */
.sp-tile.sp-add { border: 2px dashed #3d5166; background: #12202e; cursor: pointer;
  display: flex; align-items: center; justify-content: center; color: #9fb3c8; font-size: 24px; }
.sp-tile.sp-add:hover { border-color: #6ee7a8; color: #6ee7a8; }
.sp-tile.sp-gen { font-size: 20px; border-color: #4a4166; background: #1d1830; color: #b9a8e0; }
.sp-tile.sp-gen:hover { border-color: #b98cff; color: #ddccff; }
/* the pick grid's "no texture" cell — the only way back to untextured once a tile is set */
.sp-tile.sp-none { font-size: 18px; color: #7f97ac; }
/* Custom tiles carry their management actions on right-click (see openTileMenu), so the grid stays pure
   artwork and nothing destructive sits under an ordinary click. The focus ring is what keyboard users
   aim the Menu key with. */
.sp-tile:focus-visible { outline: 2px solid #6ee7a8; outline-offset: 1px; }
@keyframes sp-sel-pulse {
  from { box-shadow: 0 0 0 4px #ffe79a, 0 0 22px 9px #ffd98a; }
  to   { box-shadow: 0 0 0 2px #ffc24d, 0 0 12px 3px #ffc24daa; } }
`;


export class TextureLibrary {
  readonly el = document.createElement('div');
  private titleEl = document.createElement('span');   // 'Texture Library', or the question while picking
  private cancelBtn = document.createElement('button'); // pick mode's way out, beside the ✕
  private levelSel = document.createElement('select');
  private hideUnusedChk = document.createElement('input');
  private filterCap = document.createElement('span');
  private hideStagedChk = document.createElement('input');
  private hideStagedCap = document.createElement('span');
  private body = document.createElement('div');
  private fileInput = document.createElement('input'); // hidden picker behind the Custom level's + tile
  private customTiles = 0;    // how many tiles the author's own bank holds — decides the opening view
  private levelChosen = false; // the author picked a level themselves; stop re-deriving the opening view
  private hideUnused = true;  // hide textures the level never uses on terrain (props/skybox); on by default
  private hideStaged = true;  // hide tiles already staged in the Palette; on by default (declutter as you build)
  private tex: LevelTextures | null = null;
  private selKey = ''; // highlighted brush key
  private open = false;
  private loadGeneration = 0;
  private loadError = '';
  private pick: TexturePick | null = null;                     // the live "choose a texture" request, if any
  private pickKeys: ((e: KeyboardEvent) => void) | null = null; // its Esc handler, while it's up

  constructor(private cb: PaletteCallbacks) {
    installStyles('texture-library', css);

    this.el.className = 'sp-pal';
    const head = document.createElement('div');
    head.className = 'sp-head';
    // header title — a plain label (the panel opens from the paint tools' Texture Library button, closes on
    // the ✕), or the question being asked while a pick owns the panel
    this.titleEl.className = 'sp-title';
    this.titleEl.textContent = 'Texture Library';
    this.levelSel.onchange = () => { this.levelChosen = true; void this.loadLevel(this.levelSel.value); };

    // filter: hide the textures this level never paints on terrain (props / skybox / spares) — on by default
    const filt = document.createElement('label');
    filt.className = 'sp-filt';
    tooltip(filt, 'Hide textures this level never uses on its terrain — props, skybox, spares. On by default.');
    this.hideUnusedChk.type = 'checkbox';
    this.hideUnusedChk.checked = this.hideUnused;
    this.hideUnusedChk.onchange = () => { this.hideUnused = this.hideUnusedChk.checked; this.render(); };
    this.filterCap.textContent = 'hide unused';
    filt.append(this.hideUnusedChk, this.filterCap);

    // filter: hide tiles already staged in the Palette, to declutter the Library as you build it
    const filt2 = document.createElement('label');
    filt2.className = 'sp-filt';
    tooltip(filt2, 'Hide tiles already staged in your Palette. On by default.');
    this.hideStagedChk.type = 'checkbox';
    this.hideStagedChk.checked = this.hideStaged;
    this.hideStagedChk.onchange = () => { this.hideStaged = this.hideStagedChk.checked; this.render(); };
    this.hideStagedCap.textContent = 'hide staged';
    filt2.append(this.hideStagedChk, this.hideStagedCap);

    const grow = document.createElement('span');
    grow.className = 'sp-grow';
    // pick mode's explicit way out; the ✕ does the same thing then, rather than "remember me as closed"
    this.cancelBtn.className = 'sp-pickcancel';
    this.cancelBtn.type = 'button';
    this.cancelBtn.textContent = 'Cancel';
    this.cancelBtn.style.display = 'none';
    tooltip(this.cancelBtn, 'Keep the current texture and close the picker (Esc).');
    this.cancelBtn.onclick = () => this.cancelPick();
    const close = document.createElement('button');
    close.className = 'sp-close';
    close.type = 'button';
    close.textContent = '✕';
    tooltip(close, 'Hide the Texture Library (reopen it from the paint tools).');
    close.onclick = () => { if (!this.cancelPick()) this.cb.onClose?.(); };
    head.append(this.titleEl, this.levelSel, filt, filt2, grow, this.cancelBtn, close);

    this.body.className = 'sp-body';
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.multiple = true;
    this.fileInput.style.display = 'none';
    this.fileInput.onchange = () => void this.addCustomTextures(this.fileInput.files);
    this.el.append(head, this.body, this.fileInput);
    document.body.appendChild(this.el);
  }

  private mountainName(): string { return this.cb.mountainName?.().trim() || 'Mountain'; }

  get level(): string { return this.tex?.level ?? this.levelSel.value ?? ''; }

  /** The opening view, per the shared rule. Kept as a method because the reference loads asynchronously —
   *  `init` runs at boot, before a reference is up, so the answer is asked for again on first open. */
  private preferredSource(has: (key: string) => boolean, levels: readonly string[]): string {
    return defaultLibrarySource({
      custom: CUSTOM_TEX_LEVEL,
      hasCustom: this.customTiles > 0,
      reference: this.cb.refLevel?.(),
      has,
      fallback: levels.length ? levels[0] : CUSTOM_TEX_LEVEL,
    });
  }

  /** Show / hide the panel — the host re-places the overlays above it via onHeightChange. */
  show() {
    this.open = true;
    this.el.style.display = 'flex';
    // First open re-asks for the opening view: boot ordering means the reference was still loading when
    // `init` chose. Once the author has picked a level themselves, their choice stands.
    if (!this.levelChosen && !this.pick) {
      const has = (key: string) => [...this.levelSel.options].some(option => option.value === key);
      const levels = [...this.levelSel.options].map(option => option.value).filter(key => key !== CUSTOM_TEX_LEVEL);
      const prefer = this.preferredSource(has, levels);
      if (prefer && prefer !== this.levelSel.value) this.levelSel.value = prefer;
    }
    void this.ensureSelectedLevel();
    this.cb.onHeightChange?.();
  }
  hide() { this.open = false; this.el.style.display = 'none'; this.cb.onHeightChange?.(); }

  /** True while a pick owns the panel. The host's per-mode rule (Texture Library only in Paint) stands aside
   *  for this — a pick is raised from Edit mode and has to outlive the mode it was raised from. */
  get picking(): boolean { return this.pick !== null; }

  /**
   * Borrow the panel to answer one question: which texture? Opens it wherever we are, highlights `current`
   * and reveals it through any filter that would hide it, and routes the next tile click to `onPick`.
   * Esc / Cancel / ✕ cancel. Exactly one pick can be live; opening a second cancels the first.
   */
  openPick(req: TexturePick) {
    this.cancelPick();
    this.pick = req;
    this.selKey = req.current ? `tile:${req.current}` : '';
    this.titleEl.textContent = req.title;
    this.cancelBtn.style.display = '';
    this.el.classList.add('sp-picking');
    this.show();
    void this.revealPickTarget(req.current);
    // Esc belongs to the picker while it's up: capture it ahead of the editor's own layered Escape, which
    // would otherwise end the model-edit session out from under the question being asked.
    this.pickKeys = e => {
      if (e.key !== 'Escape' || !this.pick) return;
      e.preventDefault();
      e.stopPropagation();
      this.cancelPick();
    };
    document.addEventListener('keydown', this.pickKeys, true);
  }

  /** Cancel a live pick (Esc, the ✕, a mode change). Returns whether there was one to cancel. */
  cancelPick(): boolean {
    if (!this.pick) return false;
    this.endPick();
    return true;
  }

  /** Load and scroll to the tile a pick starts on, so the picker opens showing the current answer. */
  private async revealPickTarget(current: TexRef | null) {
    if (current) {
      const { level } = parseTexRef(current);
      if (level && level !== this.tex?.level && [...this.levelSel.options].some(o => o.value === level)) {
        this.levelSel.value = level;
        await this.loadLevel(level);
      }
    }
    this.render();
    if (!current) { this.body.scrollTop = 0; return; }
    this.body.querySelector<HTMLElement>(`.sp-tile[data-ref="${current}"]`)?.scrollIntoView({ block: 'center' });
  }

  /** Settle the pick: `ref` answers it (null = the "no texture" cell), no argument cancels it. Either way the
   *  panel returns to being the plain Library and the host reapplies its per-mode rule. */
  private endPick(ref?: TexRef | null) {
    const pick = this.pick;
    if (!pick) return;
    this.pick = null;
    if (this.pickKeys) { document.removeEventListener('keydown', this.pickKeys, true); this.pickKeys = null; }
    this.cancelBtn.style.display = 'none';
    this.el.classList.remove('sp-picking');
    this.titleEl.textContent = 'Texture Library';
    this.selKey = '';
    if (ref === undefined) pick.onCancel?.(); else pick.onPick(ref);
    this.render();
    this.cb.onPickEnd?.();
  }

  /** Emit a tile brush. A Library click lands at 0° and defaults the ride feel to 1 (snow); a viewport sample
   *  passes the picked surface and the tile's D4 orientation relative to the patch (see pickTexture). The
   *  ride feel is otherwise chosen per-cell in the Palette's Surface mode. */
  private emitTile(ref: TexRef, surface: number = DEFAULT_SURFACE, rot = 0, mirror = false, sampled = false) {
    this.cb.onBrush({ kind: 'tile', ref, surface, rot, mirror }, sampled);
  }

  async init(preferredLevel?: string) {
    try {
      const { levels } = await fetchJson<{ levels: string[] }>('/api/textures');
      this.levelSel.innerHTML = '';
      // the user's own tiles — pinned FIRST, whether or not any exist yet (its body holds the + / ✨ tiles):
      // it is the one bank that is authored rather than extracted, so it should not be hunted for at the
      // bottom of thirty read-only level names
      const custom = document.createElement('option');
      custom.value = CUSTOM_TEX_LEVEL;
      custom.textContent = this.mountainName();
      this.levelSel.appendChild(custom);
      for (const l of levels as string[]) {
        const o = document.createElement('option');
        o.value = o.textContent = l;
        this.levelSel.appendChild(o);
      }
      const has = (key: string) => [...this.levelSel.options].some(option => option.value === key);
      // Count the author's own tiles once so the opening view can prefer them. Cheap: it is the one bank
      // that is authored rather than extracted, so it is short or empty.
      try {
        const { tiles } = await fetchJson<{ tiles: TexTile[] }>(
          `/api/textures?level=${encodeURIComponent(CUSTOM_TEX_LEVEL)}`);
        this.customTiles = tiles?.length ?? 0;
      } catch { this.customTiles = 0; }
      const prefer = preferredLevel && has(preferredLevel) ? preferredLevel : this.preferredSource(has, levels);
      this.levelSel.value = prefer;
      // Keep the catalogue cheap at boot. The selected level's metadata (and therefore its thumbnail image
      // requests) waits until the library is actually opened.
      if (this.open) await this.loadLevel(prefer);
    } catch {
      this.loadError = 'Texture catalogue unavailable. Start or reconnect the dev server, then reopen the library.';
      const o = document.createElement('option');
      o.textContent = '(dev server only)';
      this.levelSel.appendChild(o);
      if (this.open) this.render();
    }
  }

  /** Another signed-in device changed authored assets; preserve this panel's place while refetching it. */
  async reloadCatalogue() {
    const selected = this.levelSel.value;
    this.tex = null;
    await this.init(selected);
  }

  /** Rename only changes the display label; the compatibility pseudo-level and selected source stay put. */
  refreshMountainName(): void {
    const custom = [...this.levelSel.options].find(option => option.value === CUSTOM_TEX_LEVEL);
    if (custom) custom.textContent = this.mountainName();
  }

  private async ensureSelectedLevel() {
    const level = this.levelSel.value;
    if (!level || level.startsWith('(') || this.tex?.level === level) return;
    await this.loadLevel(level);
  }

  private async loadLevel(level: string): Promise<LevelTextures | null> {
    if (!level || level.startsWith('(')) return null;
    const generation = ++this.loadGeneration;
    try {
      const tex = await fetchJson<LevelTextures>(`/api/textures?level=${encodeURIComponent(level)}`);
      if (generation !== this.loadGeneration || this.levelSel.value !== level) return null;
      if (level !== CUSTOM_TEX_LEVEL) {
        registerReferenceTextureRevisions(level, Object.fromEntries(
          tex.tiles.flatMap(tile => tile.revision ? [[tile.name, tile.revision]] : [])));
      }
      // Keep the opening-view count honest as tiles are added and deleted under it.
      if (level === CUSTOM_TEX_LEVEL) this.customTiles = tex.tiles?.length ?? 0;
      this.tex = tex;
      this.loadError = '';
      this.render();
      return tex;
    } catch (error) {
      if (generation !== this.loadGeneration || this.levelSel.value !== level) return null;
      this.tex = null;
      this.loadError = `Could not load ${level} textures: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
      return null;
    }
  }

  /** Sample a tile off a viewport surface: make it the active brush, adopt the picked patch's ride feel
   *  and its D4 orientation relative to the patch (the green frame-F → pink art-F turn, passed in by the
   *  viewport), and scroll the tile into view. Painting the brush reproduces that orientation. */
  async pickTexture(ref: TexRef, surfaceHint: number | null, rot = 0, mirror = false): Promise<string> {
    const { level, name } = parseTexRef(ref);
    // Bare refs are legacy authored paint. The catalogue selection is available without opening the library,
    // so it remains the backfill source after metadata loading became lazy.
    const resolvedLevel = level || this.levelSel.value || this.tex?.level || '';
    if (!resolvedLevel) throw new Error(`cannot resolve a source level for ${name}`);
    if (resolvedLevel !== this.tex?.level && [...this.levelSel.options].some(o => o.value === resolvedLevel)) {
      this.levelSel.value = resolvedLevel;
      if (!await this.loadLevel(resolvedLevel)) throw new Error(this.loadError || `could not load ${resolvedLevel} textures`);
    }
    const fullRef = makeTexRef(resolvedLevel, name);
    this.selKey = `tile:${fullRef}`;
    const picked = this.tex?.tiles.find(t => t.name === name);
    // reveal a sampled tile that a filter would otherwise hide
    if (picked && picked.count === 0 && this.hideUnused) { this.hideUnused = false; this.hideUnusedChk.checked = false; }
    if (this.hideStaged && this.cb.stagedRefs?.().has(fullRef)) { this.hideStaged = false; this.hideStagedChk.checked = false; }
    this.render();
    const sw = this.body.querySelector<HTMLElement>(`.sp-tile[data-ref="${fullRef}"]`);
    sw?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    this.emitTile(fullRef, surfaceHint ?? DEFAULT_SURFACE, rot, mirror, true); // sampling keeps ride feel + orientation
    return sw ? `picked ${name}` : `picked ${name} (not a texture in ${this.tex?.level ?? 'this level'})`;
  }

  /** The top-bar F toggle: draw the pink art F on every Library swatch (CSS ::after inside the swatch). */
  setShowF(on: boolean) { this.el.classList.toggle('show-f', on); }

  /** Light up the swatch for `ref` (or clear) without emitting a brush — mirrors the Palette's active tile. */
  highlightRef(ref: TexRef | null) {
    const key = ref ? `tile:${ref}` : '';
    if (key === this.selKey) return;
    this.selKey = key;
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>('.sp-tile')))
      el.classList.toggle('sel', !!ref && el.dataset.ref === ref);
  }

  private select(key: string) { this.selKey = key; this.render(); }

  private render() {
    this.body.innerHTML = '';
    if (!this.tex) {
      if (this.loadError) {
        const error = document.createElement('p');
        error.className = 'sp-hint';
        error.textContent = this.loadError;
        this.body.appendChild(error);
      }
      return;
    }
    // the Custom level has no terrain usage by definition, so the "hide unused" filter is meaningless there
    const custom = this.tex.level === CUSTOM_TEX_LEVEL;
    const filt = this.hideUnusedChk.parentElement as HTMLElement | null;
    if (filt) filt.style.display = custom ? 'none' : '';
    const unused = this.tex.tiles.filter(t => t.count === 0).length;
    this.filterCap.textContent = unused ? `hide unused (${unused})` : 'hide unused';
    // "hide staged" declutters the Library against the paint Palette. A pick is answering a different
    // question, so the filter would only hide candidate answers for no reason — it stands down (and hides).
    const filt2 = this.hideStagedChk.parentElement as HTMLElement | null;
    if (filt2) filt2.style.display = this.pick ? 'none' : '';
    const staged = !this.pick && this.hideStaged ? this.cb.stagedRefs?.() ?? null : null; // refs already in the Palette
    const shown = this.tex.tiles.filter(t =>
      (custom || !this.hideUnused || t.count > 0) &&
      !(staged && staged.has(makeTexRef(this.tex!.level, t.name))));
    const hint = document.createElement('p');
    hint.className = 'sp-hint';
    hint.textContent = this.pick
      ? 'Click a tile to use it. Switch level above to browse another bank; Esc or Cancel keeps the current one.'
      : custom
      ? 'Your own tiles. Add an image with the + tile or describe one with ✨, then paint with it or set it on a model from the model banner’s texture swatch (Edit ▸ Editing <model>). Right-click a tile to rename, duplicate or delete it.'
      : 'Drag a tile from here into your Palette to arrange tiles, or click a tile to paint with it now.';
    this.body.appendChild(hint);
    const grid = document.createElement('div');
    grid.className = 'sp-tiles';
    if (this.pick) grid.appendChild(this.noneSwatch());
    if (custom) { grid.appendChild(this.addSwatch()); grid.appendChild(this.genSwatch()); }
    for (const t of shown) grid.appendChild(this.tileSwatch(t));
    this.body.appendChild(grid);
  }

  /** Re-render if the Palette's contents changed while "hide staged" is on — preserving scroll position. */
  refresh() {
    if (!this.tex || !this.hideStaged) return;
    const top = this.body.scrollTop;
    this.render();
    this.body.scrollTop = top;
  }

  /** A tile swatch; click makes it the brush, drag stages it into the Palette. Both land at the default
   *  ride feel (snow) — set the ride feel per-cell in the Palette's Surface mode. */
  private tileSwatch(t: TexTile): HTMLElement {
    const ref = makeTexRef(this.tex!.level, t.name);
    const sw = document.createElement('div');
    sw.className = 'sp-tile';
    sw.dataset.ref = ref;
    if (this.selKey === `tile:${ref}`) sw.classList.add('sel');
    sw.style.backgroundImage = `url(${textureUrl(this.tex!.level, t.name)})`;
    const label = t.name.replace(/\.png$/i, '');
    tooltip(sw, this.tex!.level === CUSTOM_TEX_LEVEL
      ? `${label} · your custom tile (${ref}) · drag into your Palette · right-click to rename, duplicate or delete`
      : t.count > 0 ? `${label} · used ${t.count}× · drag into your Palette` : `${label} · not used on terrain · drag into your Palette`);
    // While a pick is up a click ANSWERS it; otherwise it arms the paint brush as usual.
    sw.onclick = () => { if (this.pick) { this.endPick(ref); return; } this.select(`tile:${ref}`); this.emitTile(ref); };
    sw.draggable = true;
    sw.ondragstart = e => {
      e.dataTransfer?.setData(DRAG_TILE, JSON.stringify({ ref, surface: DEFAULT_SURFACE }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
    };
    if (this.tex!.level === CUSTOM_TEX_LEVEL) {
      sw.tabIndex = 0; // so the keyboard Menu key / Shift+F10 can raise the same actions
      sw.oncontextmenu = e => { e.preventDefault(); this.openTileMenu(t.name, { x: e.clientX, y: e.clientY }); };
    }
    return sw;
  }

  /** Rename / duplicate / delete, on the author's own tiles only — an extracted level's bank is read-only.
   *  On RIGHT-CLICK rather than as hover buttons: they used to sit as a small bar inside the tile, where
   *  aiming at the art clipped Delete often enough to matter. A tile's ordinary click means "paint with
   *  this", which is the frequent, harmless act; managing the file is the rare, destructive one, so it takes
   *  the deliberate gesture. Custom tiles are focusable, so the keyboard Menu key raises this too. */
  private openTileMenu(name: string, at: { x: number; y: number }) {
    const stem = name.replace(/\.png$/i, '');
    contextMenu([
      { label: '✎ Rename…', desc: 'Painted cells, models and imported props follow the new name.',
        onClick: () => void this.renameTile(name) },
      { label: '⧉ Duplicate…', desc: 'Copy the art to a second tile — keep this one before regenerating over it.',
        onClick: () => void this.cloneTile(name) },
      { label: '⟳ Replace art…', desc: 'Put a new image on this tile. Everything wearing it follows.',
        onClick: () => void this.replaceTile(name) },
      { label: '🗑 Delete…', desc: `Remove ${stem}.png from disk. Asks first, and says what is using it.`,
        onClick: () => void this.deleteTile(name) },
    ], at);
  }

  /** What a delete or a replace reaches: the live document's painted cells and models, plus the imported-prop
   *  records on disk, which the editor cannot count for itself. A failed count is advisory, never a blocker. */
  private async tileUsage(name: string): Promise<string[]> {
    const inDoc = this.cb.docTexUsage?.(makeTexRef(CUSTOM_TEX_LEVEL, name)) ?? 0;
    let imported = 0;
    try {
      imported = (await fetchJson<{ importedProps: number }>(
        `/api/texture-usage?name=${encodeURIComponent(name)}`)).importedProps;
    } catch { /* usage is advisory — a failed count must not block the action */ }
    return [
      inDoc ? `${inDoc} place${inDoc === 1 ? '' : 's'} in this mountain` : '',
      imported ? `${imported} imported prop${imported === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
  }

  /** Names already taken in the Custom level, for the "that one exists" check while typing. */
  private customNames(): Set<string> {
    return new Set((this.tex?.tiles ?? []).map(t => t.name.replace(/\.png$/i, '').toLowerCase()));
  }

  private nameTaken(exclude?: string) {
    const taken = this.customNames();
    if (exclude) taken.delete(exclude.replace(/\.png$/i, '').toLowerCase());
    return (value: string) => taken.has(value.replace(/\.png$/i, '').toLowerCase())
      ? 'A custom tile with that name already exists.' : null;
  }

  private async renameTile(name: string) {
    const stem = name.replace(/\.png$/i, '');
    const to = await askName({
      title: 'Rename texture', label: 'New name', value: stem, confirmLabel: 'Rename',
      hint: 'Painted cells, authored models and imported props are repointed to the new name, so nothing '
        + 'loses its art. Letters, digits, hyphens and underscores are kept; anything else is dropped.',
      validate: this.nameTaken(stem),
    });
    if (!to) return;
    try {
      const res = await postJson<{ name: string; repointed: number }>(
        `/api/texture-rename?from=${encodeURIComponent(stem)}&to=${encodeURIComponent(to)}`);
      this.cb.onTextureRenamed?.(makeTexRef(CUSTOM_TEX_LEVEL, name), makeTexRef(CUSTOM_TEX_LEVEL, res.name));
      await this.adoptCustomTexture(res.name);
      toast(`Renamed to ${res.name}${res.repointed ? ` · ${res.repointed} imported prop(s) repointed` : ''}.`, 'ok');
    } catch (e) {
      toast(`Rename failed — ${message(e)}`, 'err', 6000);
    }
  }

  /**
   * Replace a tile's art: the deliberate "keep iterating on this one" move, and the only action here that
   * changes what an already-painted cell looks like.
   *
   * It is an upload plus a repoint, not a write over the old file — the new art lands under its own name, the
   * document and the imported-prop records are moved onto it, and the old tile goes. So the tile the author
   * is holding gains the new art while no already-fetched image ever silently becomes a different picture,
   * which is what keeps caches out of this (docs/038).
   */
  private async replaceTile(name: string) {
    const stem = name.replace(/\.png$/i, '');
    const file = await pickImageFile();
    if (!file) return;
    const costs = await this.tileUsage(name);
    const ok = await confirmAction({
      title: `Replace ${stem} with ${file.name}?`,
      confirmLabel: 'Replace',
      body: `The new art is stored as its own tile and everything wearing ${stem}.png is repointed to it, `
        + `then ${stem}.png is removed.`
        + (costs.length
          ? ` This changes what ${costs.join(' and ')} show.`
          : ' Nothing is currently using it, so only the library changes.'),
    });
    if (!ok) return;
    try {
      const blob = await imageFileToPng(file, 512);
      const res = await postJson<{ name: string; replaced: string; repointed: number }>(
        `/api/texture-replace?name=${encodeURIComponent(stem)}`, blob);
      this.cb.onTextureRenamed?.(makeTexRef(CUSTOM_TEX_LEVEL, res.replaced), makeTexRef(CUSTOM_TEX_LEVEL, res.name));
      await this.adoptCustomTexture(res.name);
      toast(`${res.replaced} now shows ${file.name}, as ${res.name}`
        + `${res.repointed ? ` · ${res.repointed} imported prop(s) repointed` : ''}.`, 'ok', 5000);
    } catch (e) {
      toast(`Replace failed — ${message(e)}`, 'err', 6000);
    }
  }

  private async cloneTile(name: string) {
    const stem = name.replace(/\.png$/i, '');
    const taken = this.customNames();
    let suggestion = `${stem}-copy`;
    for (let i = 2; taken.has(suggestion.toLowerCase()); i++) suggestion = `${stem}-copy-${i}`;
    const to = await askName({
      title: 'Duplicate texture', label: 'Name for the copy', value: suggestion, confirmLabel: 'Duplicate',
      hint: 'Copies the art to a second tile. Nothing already painted changes — the copy starts unused.',
      validate: this.nameTaken(),
    });
    if (!to) return;
    try {
      const res = await postJson<{ name: string }>(
        `/api/texture-clone?from=${encodeURIComponent(stem)}&to=${encodeURIComponent(to)}`);
      await this.adoptCustomTexture(res.name);
      toast(`Duplicated as ${res.name}.`, 'ok');
    } catch (e) {
      toast(`Duplicate failed — ${message(e)}`, 'err', 6000);
    }
  }

  private async deleteTile(name: string) {
    const stem = name.replace(/\.png$/i, '');
    const ref = makeTexRef(CUSTOM_TEX_LEVEL, name);
    const costs = await this.tileUsage(name);
    const ok = await confirmAction({
      title: `Delete ${stem}?`,
      danger: true,
      confirmLabel: 'Delete',
      body: `Removes assets/textures/${stem}.png from this mountain. This is not undoable.`
        + (costs.length
          ? ` It is currently used by ${costs.join(' and ')}. Painted cells and authored models are cleared `
            + 'and fall back to their surface tint; imported props keep the reference and will show as '
            + 'untextured until you point them somewhere else.'
          : ' Nothing is currently using it.'),
    });
    if (!ok) return;
    try {
      await postJson<{ deleted: boolean }>(`/api/texture-delete?name=${encodeURIComponent(stem)}`);
      this.cb.onTextureDeleted?.(ref);
      this.selKey = '';
      await this.loadLevel(CUSTOM_TEX_LEVEL);
      toast(`Deleted ${stem}.png.`, 'ok');
    } catch (e) {
      toast(`Delete failed — ${message(e)}`, 'err', 6000);
    }
  }

  /** The pick grid's "no texture" cell, first in the grid: answers the pick with null. Once a tile is set,
   *  this is the only way back to none — which for a model means untextured clay. */
  private noneSwatch(): HTMLElement {
    const none = document.createElement('div');
    none.className = 'sp-tile sp-add sp-none' + (this.selKey === '' ? ' sel' : '');
    none.textContent = '∅';
    tooltip(none, 'No texture — the model falls back to untextured clay.');
    none.onclick = () => this.endPick(null);
    return none;
  }

  /** The Custom level's "+ add texture" cell — opens the file picker behind it. */
  private addSwatch(): HTMLElement {
    const add = document.createElement('div');
    add.className = 'sp-tile sp-add';
    add.textContent = '+';
    // A taken name gets a numbered one rather than overwriting existing art.
    tooltip(add, 'Add a texture to this mountain — images over 512px shrink to fit.');
    add.onclick = () => this.fileInput.click();
    return add;
  }

  /** The Custom level's "✨ generate texture" cell — the same destination as the + tile, reached by
   *  describing the material instead of finding a file for it (docs/033). */
  private genSwatch(): HTMLElement {
    const gen = document.createElement('div');
    gen.className = 'sp-tile sp-add sp-gen';
    gen.textContent = '✨';
    // The dialog opens with a tiling prompt already written, model menus priced per run, and a size menu
    // defaulting to the 128² PS2 tiles ship at; results land here as authored tiles like any other image.
    tooltip(gen, 'Generate a texture with fal.ai — describe it, or inpaint a transition or decal. '
      + 'Needs a fal.ai API key (Settings ▸ Integrations); bills your own account.');
    gen.onclick = () => openTextureGenDialog({
      mountainName: this.mountainName(),
      onSaved: name => this.adoptCustomTexture(name),
      // the Transition / Decal tabs choose their input tiles through this very panel's pick mode; the
      // dialog hides itself while the question is up
      pickTexture: req => this.openPick(req),
    });
    return gen;
  }

  /** Store loaded image files as Custom tiles via the dev server, then reload the Custom level and make the
   *  last added tile the brush (adding is choosing — you add a texture to use it). A file whose name is
   *  already a tile lands beside it as `<name>_2` rather than over it, so the answer's `name` is what gets
   *  armed — loading an image never changes art someone else's cell is wearing (docs/038). */
  private async addCustomTextures(files: FileList | null) {
    if (!files?.length) return;
    let last: string | null = null;
    for (const file of Array.from(files)) {
      try {
        const blob = await imageFileToPng(file, 512);
        const stem = file.name.replace(/\.[^.]*$/, '');
        const { name } = await fetchJson<{ name: string }>(
          `/api/texture-upload?name=${encodeURIComponent(stem)}`, { method: 'POST', body: blob });
        last = name;
      } catch (e) {
        console.warn(`custom texture "${file.name}" failed:`, e);
      }
    }
    this.fileInput.value = '';
    if (!last) return;
    await this.adoptCustomTexture(last);
  }

  /** Reveal a newly stored Custom tile and make it the brush — the shared tail of both routes into the
   *  library, the + file picker and the ✨ generator. */
  private async adoptCustomTexture(name: string) {
    this.levelSel.value = CUSTOM_TEX_LEVEL;
    await this.loadLevel(CUSTOM_TEX_LEVEL);
    const ref = makeTexRef(CUSTOM_TEX_LEVEL, name);
    this.cb.onTextureRevision?.(ref);
    this.selKey = `tile:${ref}`;
    this.render();
    this.body.querySelector<HTMLElement>(`.sp-tile[data-ref="${ref}"]`)?.scrollIntoView({ block: 'center' });
    this.emitTile(ref);
  }
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Ask for one image file, resolving null if the picker is dismissed. The Replace action's way in — the
 *  library's own hidden `+` input is a multi-file adder and belongs to that route. */
function pickImageFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Draw an image file to a canvas — shrunk so neither edge exceeds `max` — and hand back PNG bytes. The
 *  browser does the format decode (PNG / JPG / WebP…), so the server only ever stores one kind of file. */
async function imageFileToPng(file: File, max: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((ok, err) => {
      img.onload = () => ok();
      img.onerror = () => err(new Error(`not a readable image: ${file.name}`));
      img.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((ok, err) =>
      canvas.toBlob(b => (b ? ok(b) : err(new Error('PNG encode failed'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
