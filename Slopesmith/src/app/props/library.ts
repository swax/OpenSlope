import { modelDeclaredEffects, type LevelProps } from '../../core/reference/props';
import { AUTHORED_MODEL_LEVEL } from '../../core/doc/models';
import { IMPORTED_PROP_LEVEL, scaleDraftTo } from '../../core/props/imported';
import { propKindOf } from '../../core/props/kind';
import { CUSTOM_TEX_LEVEL, makeTexRef } from '../../core/paint/textures';
import { FAL_GENERATION_HEADER, type FalGenerationProvenance } from '../../core/paint/fal-models';
import type { GroupDef } from '../../core/reference/groups';
import { fetchJson, postJson } from '../net/fetch-json';
import { tooltip } from '../ui/components/tooltip';
import { toast } from '../ui/components/toast';
import { askName, confirmAction } from '../ui/components/prompts';
import { defaultLibrarySource } from '../ui/components/library-default';
import { contextMenu } from '../ui/components/controls';
import { openBlenderGuide } from './blender-bridge';
import { draftToRecord, glbToPropDraft } from './glb-import';
import { ThumbRenderer } from './thumb-renderer';
import { installStyles } from '../ui/components/styles';

/**
 * Prop Library: the bottom panel of a reference world's placeable props (the props answer to the
 * Texture Library). One flat, searchable grid of every model in the chosen level, each shown as a small 3/4
 * thumbnail rendered client-side (ThumbRenderer). Click a prop to arm it as the placement brush — then
 * click the mountain in Props mode to drop it. Thumbnails render lazily (only as swatches scroll into view),
 * so browsing 600+ models stays cheap. A DOM panel (not lil-gui) because picking props wants to SEE them.
 * See docs/012-props.md.
 */

export interface PropLibraryCallbacks {
  /** List the levels that carry props (for the level picker). */
  levels(): Promise<string[]>;
  /** Fetch + decode a level's props (shared with the viewport's geometry cache, so it's fetched once). */
  loadLevel(level: string): Promise<LevelProps>;
  /** Fetch a level's mined group defs (the Groups chip — docs/015). */
  groups(level: string): Promise<GroupDef[]>;
  /** A prop was chosen — arm it for placement (and jump to Props mode). */
  onPick(level: string, model: number, name: string): void;
  /** A group was chosen — arm the whole assembly for placement. */
  onPickGroup(level: string, id: string): void;
  /** The panel was shown / hidden — re-place overlays that sit above it. */
  onHeightChange?(): void;
  /** The panel's ✕ was pressed — the host hides it and remembers it as closed. */
  onClose?(): void;
  /** The imported-GLB catalogue ('@import'), listed in the Custom view beside the authored models (docs/032). */
  importedProps?(): Promise<LevelProps>;
  /** The reference level being studied, for the opening-view rule (library-default.ts). Empty when none. */
  refLevel?(): string;
  /** Live name of the open authored mountain, used for its pinned local-asset entry. */
  mountainName?(): string;
  /** A GLB was imported — the host refetches the catalogue and re-registers its geometry. */
  onImported?(): Promise<LevelProps>;
  /** The open mountain's side of managing a model. The panel owns the library; the document — placements,
   *  authored definitions, history — belongs to the host, so the right-click actions ask for its half here. */
  docModels?: DocModelOps;
}

/** What the Custom view's right-click actions need from the open document. Every one of these is an edit the
 *  host commits to history, so a rename or a delete is one Ctrl+Z away even though the FILE half is not. */
export interface DocModelOps {
  /** How many placements of this model the open mountain holds — shown before a delete. */
  usage(level: string, model: number): number;
  /** Take the new name: an authored model's definition, plus the name every placement carries. */
  rename(level: string, model: number, name: string): void;
  /** Remove the model's placements — and, for an authored model, the definition itself. */
  remove(level: string, model: number): void;
  /** Copy an AUTHORED model's definition (imported records duplicate on the server). */
  duplicate(model: number): { model: number; name: string } | null;
}

const css = `
.pl-pal { position: fixed; left: 0; right: 0; bottom: 0; height: 250px; overflow: hidden;
  background: #0c141de8; border-top: 1px solid #2c3e50; color: #d7e3f0;
  font: 12px/1.4 system-ui, sans-serif; z-index: 16; display: none; flex-direction: column; }
.pl-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 6px; flex: 0 0 auto;
  flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
.pl-head > *:not(.pl-grow) { flex-shrink: 0; }
.pl-title { display: inline-flex; align-items: center; gap: 6px; color: #9fb3c8;
  font: 600 12px system-ui, sans-serif; white-space: nowrap; }
.pl-close { background: transparent; border: 0; color: #7f97ac; cursor: pointer; font-size: 15px; line-height: 1;
  padding: 2px 5px; border-radius: 4px; }
.pl-close:hover { color: #eaf6ff; background: #ffffff14; }
.pl-pal select, .pl-pal input { background: #15202c; color: #d7e3f0; border: 1px solid #2c3e50; border-radius: 4px; padding: 3px 6px; font: inherit; }
.pl-pal input.pl-search { min-width: 120px; }
.pl-chips { display: inline-flex; gap: 4px; flex-shrink: 0; }
.pl-chip { background: #15202c; color: #9fb3c8; border: 1px solid #2c3e50; border-radius: 4px;
  padding: 3px 8px; font: inherit; cursor: pointer; white-space: nowrap; }
.pl-chip:hover { color: #cfe3f5; border-color: #3a5169; }
.pl-chip.on { background: #1d3346; color: #ffc24d; border-color: #ffc24d; }
.pl-grow { flex: 1 1 auto; }
.pl-count { color: #6f8398; font-size: 11px; white-space: nowrap; }
.pl-body { flex: 1 1 auto; overflow: auto; padding: 4px 12px 12px; }
.pl-hint { color: #6f8398; font-size: 11px; margin: 0 0 8px; }
.pl-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: 6px; }
.pl-tile { position: relative; width: 100%; border: 2px solid transparent; border-radius: 5px;
  cursor: pointer; background: #12202e center/contain no-repeat; overflow: hidden; }
.pl-tile .pl-thumb { display: block; width: 100%; aspect-ratio: 1; background-size: contain; background-position: center; background-repeat: no-repeat; }
.pl-tile .pl-name { display: block; font-size: 9px; line-height: 1.15; color: #9fb3c8; padding: 2px 3px 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center; background: #0e1a26; }
.pl-tile:hover { border-color: #6ee7a8; }
.pl-tile.sel { border-color: #ffc24d; box-shadow: 0 0 0 2px #ffc24d, 0 0 12px 3px #ffc24daa; z-index: 2; }
.pl-badge { position: absolute; top: 2px; right: 2px; background: #0e1a26d8; color: #9fd4ff; border: 1px solid #2c3e50;
  border-radius: 4px; padding: 0 4px; font-size: 9px; line-height: 1.5; pointer-events: none; }
/* Amber, and a hair larger than the label it sits beside: the bolt is the part worth spotting from
   across the grid, and the emoji renders small for its point size. */
.pl-badge .pl-fx { color: #ffd166; font-size: 10px; margin-right: 1px; }
.pl-tile.pl-add { display: flex; align-items: center; justify-content: center; aspect-ratio: 1;
  border: 2px dashed #3a5169; color: #6ee7a8; font-size: 24px; line-height: 1; }
.pl-tile.pl-add:hover { border-color: #6ee7a8; color: #a7f3d0; }
.pl-tile.pl-busy { opacity: 0.5; pointer-events: none; }
@media (max-width: 760px) { .pl-tiles { grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); } }
`;

/** Short display name: drop the "Mdl_" prefix and the trailing "_<n>" instance suffix authors used. */
function shortName(name: string): string {
  return name.replace(/^Mdl_/, '').replace(/_\d+$/, '');
}

/** The header's keyword quick-filters: the major model-name families. Each chip narrows the grid to models
 *  whose name contains its keyword; "Misc" (first, and active by default) catches everything none of them
 *  match. Mutually exclusive — one (or none) active at a time. A free-text search OVERRIDES the active chip
 *  and searches the whole level. */
const KW_CHIPS: { label: string; kw: string }[] = [
  { label: 'Fnc', kw: 'fnc_' },
  { label: 'Gem', kw: 'gem_' },
  { label: 'Water', kw: 'water_' },
  { label: 'Rail', kw: 'rail_' },
  { label: 'Rock', kw: 'rock' },
];
const MISC_KW = ' misc'; // sentinel: models matching none of the KW_CHIPS keywords (the "Misc" chip)
const GROUPS_KW = ' groups'; // sentinel: the level's mined assemblies (group defs), not a name keyword (docs/015)

export class PropLibrary {
  readonly el = document.createElement('div');
  private levelSel = document.createElement('select');
  private search = document.createElement('input');
  private countEl = document.createElement('span');
  private body = document.createElement('div');
  private thumb = new ThumbRenderer(96);
  private thumbCache = new Map<string, string>(); // `${level}:${id}` -> PNG data URL
  private props: LevelProps | null = null;
  private imported: LevelProps | null = null; // the '@import' catalogue, shown alongside in the Custom view
  private fileInput = document.createElement('input'); // hidden picker behind the Custom view's + tile
  private importing = false;
  private groupList: GroupDef[] | null = null; // the level's mined group defs (null while loading)
  private filter = '';
  private kwFilter: string | null = MISC_KW; // active keyword chip (a KW_CHIPS.kw or MISC_KW); null = all shown. Misc by default
  private chipEls = new Map<string, HTMLButtonElement>(); // keyword → its header chip button (to toggle .on)
  private customModels = 0;    // authored + imported models the author owns — decides the opening view
  private levelChosen = false; // the author picked a level themselves; stop re-deriving the opening view
  private selModel: number | null = null;
  private selLevel: string | null = null; // the armed tile's OWN level — the Custom view mixes two
  private io: IntersectionObserver;
  private queue: HTMLElement[] = []; // swatches waiting for a thumbnail, drained a few per frame
  private pumping = false;
  private thumbnailGeneration = 0;
  private open = false;
  private loadGeneration = 0;
  private groupLoad: { level: string; promise: Promise<void> } | null = null;

  constructor(private cb: PropLibraryCallbacks) {
    installStyles('prop-library', css);

    this.el.className = 'pl-pal';
    const head = document.createElement('div');
    head.className = 'pl-head';
    // header title — a plain label (the panel opens from the prop tools' Prop Library button, closes on the ✕)
    const title = document.createElement('span');
    title.className = 'pl-title';
    title.textContent = 'Prop Library';
    this.levelSel.onchange = () => { this.levelChosen = true; void this.loadLevel(this.levelSel.value); };

    this.search.className = 'pl-search';
    this.search.type = 'search';
    this.search.placeholder = 'search props…';
    tooltip(this.search, 'Filter the props by name (e.g. “tree”, “rock”, “banner”).');
    this.search.oninput = () => {
      this.filter = this.search.value.trim().toLowerCase();
      this.render();
      this.ensureGroupsForVisibleView();
    };

    // keyword quick-filter chips: mutually exclusive, one (or none) active — click the active one to clear it.
    const chips = document.createElement('div');
    chips.className = 'pl-chips';
    const mkChip = (label: string, key: string, tip: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pl-chip';
      b.textContent = label;
      b.classList.toggle('on', key === this.kwFilter); // initial pressed state (Misc is on by default)
      tooltip(b, tip);
      b.onclick = () => this.setKwFilter(this.kwFilter === key ? null : key); // toggle: re-click clears to all
      this.chipEls.set(key, b);
      chips.appendChild(b);
    };
    mkChip('Misc', MISC_KW, 'Show props that match none of the keyword filters (the default). Click again to show all.');
    // assemblies: e.g. a hydrant and its lid, a sign and its stand, a lamp and its light
    mkChip('Groups', GROUPS_KW, 'Show assemblies mined from this level’s placements; one click places the whole set.');
    for (const c of KW_CHIPS) mkChip(c.label, c.kw, `Show only ${c.label} props (name contains “${c.kw}”). Click again to show all.`);

    this.countEl.className = 'pl-count';
    const grow = document.createElement('span');
    grow.className = 'pl-grow';
    const close = document.createElement('button');
    close.className = 'pl-close';
    close.type = 'button';
    close.textContent = '✕';
    tooltip(close, 'Hide the Prop Library (reopen it from the prop tools).');
    close.onclick = () => this.cb.onClose?.();
    head.append(title, this.levelSel, this.search, chips, grow, this.countEl, close);

    this.body.className = 'pl-body';
    this.fileInput.type = 'file';
    this.fileInput.accept = '.glb,.gltf,model/gltf-binary,model/gltf+json';
    this.fileInput.multiple = true;
    this.fileInput.style.display = 'none';
    this.fileInput.onchange = () => void this.importModels(this.fileInput.files);
    this.el.append(head, this.body, this.fileInput);
    document.body.appendChild(this.el);

    // lazy thumbnails: render one only when its swatch scrolls into view
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { this.io.unobserve(e.target); this.queue.push(e.target as HTMLElement); }
      this.pump();
    }, { root: this.body, rootMargin: '120px' });
  }

  private mountainName(): string { return this.cb.mountainName?.().trim() || 'Mountain'; }

  /** The opening view, per the shared rule. The Custom view mixes both authored pseudo-levels, so it counts
   *  as populated when either the document's own models or the imported GLB catalogue holds anything. */
  private preferredSource(levels: readonly string[]): string {
    return defaultLibrarySource({
      custom: AUTHORED_MODEL_LEVEL,
      hasCustom: this.customModels > 0,
      reference: this.cb.refLevel?.(),
      has: key => levels.includes(key),
      fallback: levels[0],
    });
  }

  /** Show / hide the panel — the host re-places the overlays above it via onHeightChange. */
  show() {
    this.open = true;
    this.el.style.display = 'flex';
    // First open re-asks for the opening view: `init` runs at boot, before the reference has loaded and
    // before the Custom catalogues are known. An explicit choice by the author is never overridden.
    void (async () => {
      if (!this.levelChosen) {
        await this.countCustomModels();
        const levels = [...this.levelSel.options].map(option => option.value);
        const prefer = this.preferredSource(levels);
        if (prefer && prefer !== this.levelSel.value) this.levelSel.value = prefer;
      }
      await this.ensureSelectedLevel();
      this.ensureGroupsForVisibleView();
    })();
    this.cb.onHeightChange?.();
  }

  /** How much the author has of their own: authored models plus imported GLBs, the two the Custom view mixes. */
  private async countCustomModels(): Promise<void> {
    const count = async (level: string, load: () => Promise<LevelProps>) => {
      try { return (await load()).models.length; } catch { return 0; }
    };
    this.customModels = await count(AUTHORED_MODEL_LEVEL, () => this.cb.loadLevel(AUTHORED_MODEL_LEVEL))
      + (this.cb.importedProps ? await count(IMPORTED_PROP_LEVEL, () => this.cb.importedProps!()) : 0);
  }
  hide() { this.open = false; this.el.style.display = 'none'; this.cb.onHeightChange?.(); }
  get level(): string { return this.props?.level ?? this.levelSel.value; }

  /** Same-name custom art changed: final thumbnail data URLs also need invalidating, not only GPU textures. */
  invalidateThumbnails() {
    this.thumbnailGeneration++;
    this.thumbCache.clear();
    this.thumb.invalidateProjectAssets();
    this.queue = [];
    if (this.open) this.render();
  }

  async init(preferredLevel?: string) {
    let levels: string[] = [];
    try { levels = await this.cb.levels(); } catch { /* dev server down */ }
    this.levelSel.innerHTML = '';
    if (!levels.length) { const o = document.createElement('option'); o.textContent = '(dev server only)'; this.levelSel.appendChild(o); return; }
    for (const l of levels) {
      const o = document.createElement('option');
      o.value = l;
      o.textContent = l === AUTHORED_MODEL_LEVEL ? this.mountainName() : l; // this mountain's authored pseudo-level
      this.levelSel.appendChild(o);
    }
    await this.countCustomModels();
    const prefer = preferredLevel && levels.includes(preferredLevel)
      ? preferredLevel : this.preferredSource(levels);
    this.levelSel.value = prefer;
    // The library is normally closed at boot. Populate its cheap catalogue now, but leave the multi-MB
    // geometry payload (and the Groups mining request) until the panel is actually opened.
    if (this.open) await this.loadLevel(prefer);
  }

  /** Another signed-in device changed authored assets; refresh geometry and keep this panel on its level. */
  async reloadCatalogue() {
    const selected = this.levelSel.value;
    this.props = null;
    this.imported = null;
    try { await this.cb.onImported?.(); } catch { /* a reconnect can race the HTTP service */ }
    await this.init(selected);
    this.invalidateThumbnails();
  }

  /** Rename only changes the display label; the compatibility pseudo-level and selected source stay put. */
  refreshMountainName(): void {
    const authored = [...this.levelSel.options].find(option => option.value === AUTHORED_MODEL_LEVEL);
    if (authored) authored.textContent = this.mountainName();
  }

  /** Point the library at a level (defaults to the first available). Public so the host can align it to the armed prop. */
  async setLevel(level: string) {
    if (this.props?.level === level) return;
    if ([...this.levelSel.options].some(o => o.value === level)) this.levelSel.value = level;
    await this.loadLevel(level);
  }

  private async ensureSelectedLevel() {
    const level = this.levelSel.value;
    if (!level || level.startsWith('(') || this.props?.level === level) return;
    await this.loadLevel(level);
  }

  private async loadLevel(level: string) {
    if (!level || level.startsWith('(')) return;
    const generation = ++this.loadGeneration;
    // authored models are LIVE definitions — drop their cached thumbnails so an edited model re-renders
    if (level === AUTHORED_MODEL_LEVEL)
      for (const key of [...this.thumbCache.keys()]) if (key.startsWith(`${AUTHORED_MODEL_LEVEL}:`)) this.thumbCache.delete(key);
    let loaded: LevelProps | null;
    let imported: LevelProps | null = null;
    try {
      // the Custom view shows both kinds of the user's own geometry: authored quad models and imported
      // GLBs. They stay separate LEVELS (docs/032) but read as one grid.
      [loaded, imported] = await Promise.all([
        this.cb.loadLevel(level),
        level === AUTHORED_MODEL_LEVEL ? this.cb.importedProps?.().catch(() => null) ?? null : null,
      ]);
    } catch {
      loaded = null;
    }
    if (generation !== this.loadGeneration || this.levelSel.value !== level) return;
    this.props = loaded;
    this.imported = imported;
    this.groupList = null; // groups are per level; refetched below
    this.render();
    this.ensureGroupsForVisibleView();
  }

  /** Whether the Custom entry is showing — the one view that mixes levels and offers the + import tile. */
  private get isCustomView(): boolean { return this.props?.level === AUTHORED_MODEL_LEVEL; }

  /** The LevelProps a tile's level came from — the Custom view draws from two. */
  private lpFor(level: string): LevelProps | null {
    if (this.props?.level === level) return this.props;
    return this.imported?.level === level ? this.imported : null;
  }

  /** Every model the current view lists, each paired with the level that owns it. */
  private entries(): { lp: LevelProps; model: LevelProps['models'][number] }[] {
    const out: { lp: LevelProps; model: LevelProps['models'][number] }[] = [];
    for (const lp of [this.props, this.imported]) {
      if (lp) for (const model of lp.models) out.push({ lp, model });
    }
    return out;
  }

  /** Mirror the armed prop's highlight (or clear) without re-picking — e.g. when the host arms via a repeat. */
  highlight(level: string, model: number | null) {
    const listed = !!this.lpFor(level); // the Custom view lists two levels, so match on the tile's own
    this.selLevel = listed ? level : null;
    this.selModel = listed ? model : null;
    for (const el of Array.from(this.body.querySelectorAll<HTMLElement>('.pl-tile')))
      el.classList.toggle('sel', this.selModel != null && el.dataset.level === this.selLevel
        && Number(el.dataset.model) === this.selModel);
  }

  /** Switch the active keyword chip (or null to clear), repaint the chips' pressed state, and re-render. */
  private setKwFilter(key: string | null) {
    this.kwFilter = key;
    for (const [k, b] of this.chipEls) b.classList.toggle('on', k === key);
    this.render();
    this.ensureGroupsForVisibleView();
  }

  /** Groups are a separate filesystem-mining request. Fetch them only when the Groups view is visible. */
  private ensureGroupsForVisibleView() {
    if (!this.open || this.filter || this.kwFilter !== GROUPS_KW || !this.props) return;
    if (this.groupList !== null) return;
    const level = this.props.level;
    if (this.groupLoad?.level === level) return;
    const promise = (async () => {
      let groups: GroupDef[];
      try { groups = await this.cb.groups(level); } catch { groups = []; }
      if (this.props?.level !== level) return;
      this.groupList = groups;
      if (!this.filter && this.kwFilter === GROUPS_KW) this.render();
    })().finally(() => {
      if (this.groupLoad?.level === level) this.groupLoad = null;
    });
    this.groupLoad = { level, promise };
  }

  private render() {
    this.body.innerHTML = '';
    this.queue = [];
    if (!this.props) { this.countEl.textContent = ''; return; }
    if (!this.filter && this.kwFilter === GROUPS_KW) { this.renderGroups(); return; } // a search falls through to the models
    const all = this.entries();
    const total = all.length;
    let shown = all;
    if (this.filter) {
      // a search overrides the keyword chip — search the whole level
      shown = shown.filter(e => e.model.name.toLowerCase().includes(this.filter));
    } else if (this.kwFilter === MISC_KW) {
      shown = shown.filter(e => !KW_CHIPS.some(c => e.model.name.toLowerCase().includes(c.kw)));
    } else if (this.kwFilter) {
      shown = shown.filter(e => e.model.name.toLowerCase().includes(this.kwFilter!));
    }
    this.countEl.textContent = `${shown.length}${shown.length !== total ? ` / ${total}` : ''} props`;
    const hint = document.createElement('p');
    hint.className = 'pl-hint';
    hint.textContent = this.isCustomView
      ? 'Your own geometry. ▦ tiled props wear one tile and are editable here; ▽ textured props carry their '
        + 'own UV layout — import one with ＋. Click one to pick it up, then click the mountain to place it.'
      : 'Click a prop to pick it up, then click the mountain to place it — scroll turns it, ⇧scroll resizes, Esc puts it down.';
    this.body.appendChild(hint);
    const grid = document.createElement('div');
    grid.className = 'pl-tiles';
    if (this.isCustomView) {
      grid.appendChild(this.addSwatch()); // import lives first, like the Custom texture level's + tile
      grid.appendChild(this.genSwatch());
    }
    for (const e of shown) grid.appendChild(this.swatch(e.lp, e.model));
    this.body.appendChild(grid);
  }

  /** The Custom view's ＋ tile: load one or more GLB files as placeable props (docs/032). */
  private addSwatch(): HTMLElement {
    const add = document.createElement('div');
    add.className = 'pl-tile pl-add' + (this.importing ? ' pl-busy' : '');
    add.textContent = this.importing ? '…' : '＋';
    // A taken file name lands beside the existing prop (name_2) rather than overwriting it; to put a new
    // version on a prop already placed, right-click it and choose Replace geometry.
    tooltip(add, 'Import a .glb / .gltf as a placeable prop; its textures join the Texture Library.');
    add.onclick = () => this.fileInput.click();
    return add;
  }

  /** The Custom view's ✨ tile: describe an object and fal.ai builds a textured 3D model of it, imported
   *  through the exact same path as a loaded GLB (docs/032). The dialog module loads on demand — it pulls
   *  the generation stack, which browsing the library never needs. */
  private genSwatch(): HTMLElement {
    const gen = document.createElement('div');
    gen.className = 'pl-tile pl-add' + (this.importing ? ' pl-busy' : '');
    gen.textContent = '✨';
    tooltip(gen, 'Generate a prop with fal.ai — describe an object; a textured model lands here like an imported GLB.');
    gen.onclick = () => void import('./prop-gen').then(m => m.openPropGenDialog({
      importGlb: (file, meters, generation) => this.importGenerated(file, meters, generation),
    }));
    return gen;
  }

  /** The Groups chip's grid: one tile per mined assembly — the leader model's thumbnail with a member-count
   *  badge (✸ marks a light member). Click to arm the whole set. */
  private renderGroups() {
    const groups = this.groupList;
    this.countEl.textContent = groups ? `${groups.length} group${groups.length === 1 ? '' : 's'}` : '';
    const hint = document.createElement('p');
    hint.className = 'pl-hint';
    hint.textContent = groups === null
      ? 'mining this level’s assemblies…'
      : groups.length
        ? 'Assemblies mined from this level’s own placements. Click one to pick it up — one click places the whole set (props + lights together).'
        : 'No assemblies found in this level’s placement data.';
    this.body.appendChild(hint);
    if (!groups?.length) return;
    const grid = document.createElement('div');
    grid.className = 'pl-tiles';
    for (const g of groups) grid.appendChild(this.groupSwatch(g));
    this.body.appendChild(grid);
  }

  private groupSwatch(g: GroupDef): HTMLElement {
    const level = this.props!.level;
    const el = document.createElement('div');
    el.className = 'pl-tile';
    el.dataset.group = g.id; // the lazy-thumb pump renders the whole assembly (renderSet)
    const thumb = document.createElement('div');
    thumb.className = 'pl-thumb';
    const badge = document.createElement('span');
    badge.className = 'pl-badge';
    badge.textContent = `⧉${g.props.length}${g.lights.length ? ' ✸' : ''}`;
    const name = document.createElement('span');
    name.className = 'pl-name';
    name.textContent = g.name;
    el.append(thumb, badge, name);
    const parts = g.props.map(m => shortName(m.name));
    if (g.lights.length) parts.push(`${g.lights.length} light${g.lights.length > 1 ? 's' : ''}`);
    tooltip(el, `${g.name} — ${parts.join(' + ')} · placed ${g.occurrences}× in ${level} · click to place the set`);
    const cached = this.thumbCache.get(`${level}:g:${g.id}`);
    if (cached) thumb.style.backgroundImage = `url(${cached})`;
    else this.io.observe(el);
    el.onclick = () => { this.selModel = null; this.highlight(level, null); this.cb.onPickGroup(level, g.id); };
    return el;
  }

  private swatch(lp: LevelProps, m: LevelProps['models'][number]): HTMLElement {
    const level = lp.level;
    const imported = level === IMPORTED_PROP_LEVEL;
    const el = document.createElement('div');
    el.className = 'pl-tile' + (this.selLevel === level && this.selModel === m.id ? ' sel' : '');
    el.dataset.model = String(m.id);
    el.dataset.level = level; // the Custom view mixes levels, so a tile carries its own
    const thumb = document.createElement('div');
    thumb.className = 'pl-thumb';
    const name = document.createElement('span');
    name.className = 'pl-name';
    name.textContent = shortName(m.name);
    el.append(thumb, name);
    // One badge, not two: the corner is small and the group tiles already set the house pattern of
    // combining glyphs (`⧉3 ✸`). The bolt marks a model that arrives ALREADY ANIMATED — it carries its
    // own scrolling surfaces or emitters — which is otherwise invisible until you place one.
    const fx = modelDeclaredEffects(lp, m);
    // The kind glyph rides only in the CUSTOM view, because that is the one grid holding both kinds at once
    // — the same ▦ / ▽ the selection panel and the Blender add-on use, so the three surfaces agree on sight.
    // A reference level's grid is uniformly textured, where a glyph on every tile would be noise.
    const kindGlyph = this.isCustomView ? (propKindOf(level) === 'tiled' ? '▦' : '▽') : '';
    if (kindGlyph || fx.any) {
      const badge = document.createElement('span');
      badge.className = 'pl-badge';
      if (fx.any) {
        const bolt = document.createElement('span');
        bolt.className = 'pl-fx';
        bolt.textContent = '⚡';
        badge.appendChild(bolt);
      }
      if (kindGlyph) badge.appendChild(document.createTextNode(kindGlyph));
      el.appendChild(badge);
    }
    const carries = [
      fx.emitters ? `${fx.emitters} emitter${fx.emitters > 1 ? 's' : ''}` : '',
      fx.scroll ? `${fx.scroll} scrolling surface${fx.scroll > 1 ? 's' : ''}` : '',
    ].filter(Boolean);
    const own = this.isOwnGeometry(level);
    const kind = propKindOf(level) === 'tiled'
      ? 'Tiled prop — one tile, mapping computed, editable with the mesh tools'
      : `Textured prop — its own UV layout${imported ? ', imported from a GLB' : ''}`;
    tooltip(el, `${m.name} · ${kind}`
      + (carries.length ? ` · brings its own ${carries.join(' + ')}` : '') + ' · click to place'
      + (own ? ' · right-click to rename, duplicate or delete' : ''));
    const cached = this.thumbCache.get(`${level}:${m.id}`);
    if (cached) thumb.style.backgroundImage = `url(${cached})`;
    else this.io.observe(el); // render its thumbnail when it scrolls into view
    el.onclick = () => { this.selLevel = level; this.selModel = m.id; this.highlight(level, m.id); this.cb.onPick(level, m.id, m.name); };
    if (own) {
      el.tabIndex = 0; // so the keyboard Menu key / Shift+F10 can raise the same actions
      el.oncontextmenu = e => { e.preventDefault(); this.openModelMenu(level, m, { x: e.clientX, y: e.clientY }); };
    }
    return el;
  }

  /** Whether a tile is the author's OWN geometry — the Custom view's two levels. An extracted level's models
   *  are read-only here for the same reason its texture bank is: they are the reference, not the work. */
  private isOwnGeometry(level: string): boolean {
    return level === IMPORTED_PROP_LEVEL || level === AUTHORED_MODEL_LEVEL;
  }

  /**
   * Rename / duplicate / replace / delete, on the author's own models only — the props answer to the Texture
   * Library's tile menu, and on RIGHT-CLICK for the same reason: a tile's ordinary click means "place this",
   * which is the frequent, harmless act, so managing the model takes the deliberate gesture. Tiles here are
   * focusable, so the keyboard Menu key raises this too.
   *
   * The two kinds diverge on where the model LIVES. An imported GLB is a record on disk, so its actions are
   * server routes; an authored model is a definition inside the open mountain, so its actions are document
   * edits the host commits. Replace only exists for the imported kind — an authored model's geometry is
   * changed by editing it, not by loading a file over it.
   */
  private openModelMenu(level: string, m: LevelProps['models'][number], at: { x: number; y: number }) {
    const imported = level === IMPORTED_PROP_LEVEL;
    contextMenu([
      { label: '✎ Rename…', desc: 'Every placement of it follows the new name.',
        onClick: () => void this.renameModel(level, m) },
      { label: '⧉ Duplicate…', desc: imported
        ? 'Copy it to a second prop — keep this one before replacing its geometry. Nothing already placed follows the copy.'
        : 'Copy the definition to a second prop. Nothing already placed follows the copy.',
        onClick: () => void this.duplicateModel(level, m) },
      ...(imported ? [{ label: '⟳ Replace geometry…',
        desc: 'Load a new GLB over this prop. Everything already placed picks up the new mesh.',
        onClick: () => void this.replaceModel(m) }] : []),
      { label: '⬈ Edit in Blender…',
        desc: imported
          ? 'Take the mesh out to Blender and push it straight back onto this prop — placements and all.'
          : 'Take the quad cage out to Blender and push it straight back. Quads survive the round trip.',
        onClick: () => this.sendToBlender(level, m) },
      { label: '🗑 Delete…', desc: imported
        ? `Remove ${m.name} from the library. Asks first, and says what is placed.`
        : `Remove ${m.name} from this mountain. Asks first, and says what is placed.`,
        onClick: () => void this.deleteModel(level, m) },
    ], at);
  }

  /** Names already in the Custom view, for the "that one exists" check while typing. Models are addressed by
   *  NUMBER, so a repeat is a readability problem rather than a collision — hence a warning, not a block. */
  private nameTaken(exclude?: string) {
    const taken = new Set(this.entries().map(e => e.model.name.trim().toLowerCase()));
    if (exclude) taken.delete(exclude.trim().toLowerCase());
    return (value: string) => taken.has(value.trim().toLowerCase())
      ? 'Another of your props already has that name.' : null;
  }

  private async renameModel(level: string, m: LevelProps['models'][number]) {
    const to = await askName({
      title: 'Rename prop', label: 'New name', value: m.name, confirmLabel: 'Rename',
      hint: level === IMPORTED_PROP_LEVEL
        ? 'The prop keeps its number, so everything already placed follows the new name — and its stored file is renamed to match.'
        : 'The definition and every placement of it take the new name.',
      validate: this.nameTaken(m.name),
    });
    if (!to || to === m.name) return;
    if (level === IMPORTED_PROP_LEVEL) {
      try {
        const res = await postJson<{ name: string }>(
          `/api/custom-prop-rename?id=${m.id}&to=${encodeURIComponent(to)}`);
        this.cb.docModels?.rename(level, m.id, res.name);
        await this.adoptImportedChange();
        toast(`Renamed to ${res.name}.`, 'ok');
      } catch (e) {
        toast(`Rename failed — ${message(e)}`, 'err', 6000);
      }
      return;
    }
    this.cb.docModels?.rename(level, m.id, to);
    await this.loadLevel(AUTHORED_MODEL_LEVEL);
    toast(`Renamed to ${to}.`, 'ok');
  }

  private async duplicateModel(level: string, m: LevelProps['models'][number]) {
    if (level === AUTHORED_MODEL_LEVEL) {
      // the document's own duplicate names the copy by the revision rule ('<name> v2'), so nothing is asked
      const copy = this.cb.docModels?.duplicate(m.id);
      if (!copy) { toast('Duplicate failed — the prop is no longer in this mountain.', 'err'); return; }
      await this.loadLevel(AUTHORED_MODEL_LEVEL);
      toast(`Duplicated as ${copy.name}.`, 'ok');
      return;
    }
    const taken = new Set(this.entries().map(e => e.model.name.trim().toLowerCase()));
    let suggestion = `${m.name} copy`;
    for (let i = 2; taken.has(suggestion.toLowerCase()); i++) suggestion = `${m.name} copy ${i}`;
    const to = await askName({
      title: 'Duplicate prop', label: 'Name for the copy', value: suggestion, confirmLabel: 'Duplicate',
      hint: 'Copies the geometry to a second prop with its own number. Nothing already placed changes — the copy starts unplaced.',
      validate: this.nameTaken(),
    });
    if (!to) return;
    try {
      const res = await postJson<{ id: number; name: string }>(
        `/api/custom-prop-clone?id=${m.id}&to=${encodeURIComponent(to)}`);
      await this.adoptImportedChange();
      toast(`Duplicated as ${res.name}.`, 'ok');
    } catch (e) {
      toast(`Duplicate failed — ${message(e)}`, 'err', 6000);
    }
  }

  /**
   * Put new geometry on an imported model, keeping its number — the answer to "I rebuilt this in Blender and
   * it is already placed forty times".
   *
   * A plain re-import cannot do this: names never overwrite (docs/038), so the same file lands beside the
   * original with its own number and every placement stays on the old mesh. Replace is that escape hatch,
   * chosen rather than inflicted by a matching file name. Textures come in through the ordinary upload route
   * exactly as an import stages them, so a re-exported model brings its new art with it.
   */
  private async replaceModel(m: LevelProps['models'][number]) {
    const file = await pickGlbFile();
    if (!file) return;
    const placements = this.cb.docModels?.usage(IMPORTED_PROP_LEVEL, m.id) ?? 0;
    const ok = await confirmAction({
      title: `Replace ${m.name} with ${file.name}?`,
      confirmLabel: 'Replace',
      body: `The prop keeps its number, so its geometry, materials and any effects it declares are taken `
        + `from ${file.name}.`
        + (placements
          ? ` The ${placements} placement${placements === 1 ? '' : 's'} in this mountain re-render against the new mesh — `
            + 'their positions, rotations and scales are untouched.'
          : ' Nothing is currently placed, so only the library changes.'),
    });
    if (!ok) return;
    try {
      const draft = await glbToPropDraft(file);
      const staged = await this.stageDraftTextures(draft, file.name.replace(/\.[^.]*$/, ''));
      await postJson<{ id: number; name: string }>(`/api/custom-prop-replace?id=${m.id}`,
        JSON.stringify(draftToRecord(draft, staged.tiles, staged.frames)));
      await this.adoptImportedChange();
      const [w, h, d] = draft.size;
      toast(`${m.name} now shows ${file.name} — ${draft.tris.toLocaleString()} tris · `
        + `${w.toFixed(1)}×${d.toFixed(1)}×${h.toFixed(1)} m.`, 'ok', 5000);
    } catch (e) {
      toast(`Replace failed — ${message(e)}`, 'err', 6000);
    }
  }

  /**
   * The escape hatch out to Blender (docs/046).
   *
   * The live route is the add-on, and this dialog's job is mostly to say so — once `blender/slopesmith_bridge.py`
   * is installed the author never comes back here, because pulling and pushing both happen from Blender's own
   * sidebar and the model updates in place. What the dialog adds is the OTHER route: a self-contained GLB for
   * a tool that is not Blender, or for someone who would rather not install anything. That file round-trips
   * too — it carries the same stamp — but it comes back through Replace geometry rather than by itself.
   */
  private sendToBlender(level: string, m: LevelProps['models'][number]) {
    openBlenderGuide({
      kind: level === IMPORTED_PROP_LEVEL ? 'import' : 'model',
      id: m.id,
      name: m.name,
    });
  }

  private async deleteModel(level: string, m: LevelProps['models'][number]) {
    const imported = level === IMPORTED_PROP_LEVEL;
    const placements = this.cb.docModels?.usage(level, m.id) ?? 0;
    const placed = placements
      ? ` The ${placements} placement${placements === 1 ? '' : 's'} in this mountain `
        + `${placements === 1 ? 'goes' : 'go'} with it — that part is undoable.`
      : ' Nothing is currently placed.';
    const ok = await confirmAction({
      title: `Delete ${m.name}?`,
      danger: true,
      confirmLabel: 'Delete',
      body: imported
        ? `Removes the stored prop from this mountain’s assets/props folder. The file itself is not undoable, and its `
          + `number is spent — a later import lands beside it rather than under it.${placed}`
        : `Removes the prop definition from this mountain.${placed}`,
    });
    if (!ok) return;
    if (imported) {
      try {
        await postJson<{ deleted: boolean }>(`/api/custom-prop-delete?id=${m.id}`);
      } catch (e) {
        toast(`Delete failed — ${message(e)}`, 'err', 6000);
        return;
      }
    }
    this.cb.docModels?.remove(level, m.id);
    if (this.selLevel === level && this.selModel === m.id) { this.selLevel = null; this.selModel = null; }
    if (imported) await this.adoptImportedChange(); else await this.loadLevel(AUTHORED_MODEL_LEVEL);
    toast(`Deleted ${m.name}.`, 'ok');
  }

  /** Refetch the imported catalogue after a record changed on disk, dropping the thumbnails it invalidated.
   *  Geometry caches are the host's to clear (onImported), because the viewport holds them. */
  private async adoptImportedChange() {
    this.imported = (await this.cb.onImported?.()) ?? this.imported;
    for (const key of [...this.thumbCache.keys()]) if (key.startsWith(`${IMPORTED_PROP_LEVEL}:`)) this.thumbCache.delete(key);
    this.render();
  }

  /**
   * Load one or more GLB/glTF files as placeable props.
   *
   * Order matters: textures stage FIRST, because the geometry record has to carry the tile refs the server
   * will hand back to every consumer. Each file is independent — one bad model reports itself and the rest
   * of the batch still lands, the same contract the Texture Library's multi-file add keeps.
   */
  private async importModels(files: FileList | null) {
    if (!files?.length || this.importing) return;
    this.importing = true;
    this.render(); // the + tile shows it is busy; a big model takes a moment to convert
    let last: { level: string; model: number; name: string } | null = null;
    let failures = 0;
    for (const file of Array.from(files)) {
      try {
        last = await this.importOne(file);
      } catch (e) {
        failures++;
        toast(`${file.name}: ${e instanceof Error ? e.message : e}`, 'err');
      }
    }
    this.fileInput.value = ''; // so re-picking the same file re-fires onchange
    this.importing = false;
    if (!last) { this.render(); if (!failures) toast('nothing imported', 'warn'); return; }
    await this.adoptImported(last);
  }

  /** Convert, stage and save ONE GLB — the per-file body of the ＋ tile's batch, shared with the ✨
   *  generator. `targetMeters` rescales the draft before it is stored (generated models arrive normalized,
   *  so their authored scale means nothing — docs/032). */
  private async importOne(file: File, targetMeters?: number, generation?: FalGenerationProvenance):
  Promise<{ level: string; model: number; name: string }> {
    const draft = await glbToPropDraft(file);
    if (targetMeters) scaleDraftTo(draft, targetMeters);
    const stem = file.name.replace(/\.[^.]*$/, '');
    const staged = await this.stageDraftTextures(draft, stem, generation);
    const record = { ...draftToRecord(draft, staged.tiles, staged.frames), ...(generation ? { generation } : {}) };
    const saved = await fetchJson<{ id: number; name: string; error?: string }>(
      `/api/custom-prop-import?name=${encodeURIComponent(stem)}`,
      { method: 'POST', body: JSON.stringify(record) });
    if (saved.error) throw new Error(saved.error);
    const [w, h, d] = draft.size;
    toast(`${saved.name} — ${draft.tris.toLocaleString()} tris · ${w.toFixed(1)}×${d.toFixed(1)}×${h.toFixed(1)} m`, 'info');
    return { level: IMPORTED_PROP_LEVEL, model: saved.id, name: saved.name };
  }

  /** Stage a converted draft's material art into the mountain-local texture bank (docs/005), so it resolves
   *  through the ordinary cross-level tile path and shows up in the Texture Library like any custom tile.
   *  Shared by import and Replace — a re-exported model brings its new art the same way its first one came.
   *
   *  A flipbook material stages every frame, since each is its own bank tile the way an extracted level's
   *  are. `tiles` is frame 0 (the material's own art) and `frames` the rest, so an ordinary material's
   *  staging is byte-for-byte what it always was. */
  private async stageDraftTextures(draft: { textures: (Blob | null)[]; flipbooks?: (Blob[] | null)[] },
    stem: string, generation?: FalGenerationProvenance):
  Promise<{ tiles: (string | null)[]; frames: (string[] | null)[] }> {
    const upload = async (blob: Blob, name: string): Promise<string> => {
      // the stored name is the upload's answer, not the request: a tile name already in the bank lands
      // beside it as <name>_2, and the record has to wear the ref that actually exists (docs/038)
      const saved = await fetchJson<{ name: string }>(
        `/api/texture-upload?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: generation ? { [FAL_GENERATION_HEADER]: JSON.stringify(generation) } : undefined,
          body: blob,
        });
      return makeTexRef(CUSTOM_TEX_LEVEL, saved.name);
    };
    const tiles = await Promise.all(draft.textures.map(async (blob, i) =>
      blob ? upload(blob, `${stem}_${i}`) : null));
    const frames = await Promise.all((draft.flipbooks ?? []).map(async (book, i) =>
      book && tiles[i]
        ? Promise.all(book.slice(1).map((blob, f) => upload(blob, `${stem}_${i}_f${f + 1}`)))
        : null));
    return { tiles, frames };
  }

  /** A model landed: refetch the catalogue, drop stale thumbnails, and arm it — adding is choosing. */
  private async adoptImported(last: { level: string; model: number; name: string }) {
    // the catalogue is refetched through the host so the viewport re-registers geometry too — a replaced
    // model's existing placements have to pick up the new mesh
    await this.adoptImportedChange();
    this.selLevel = last.level;
    this.selModel = last.model;
    this.cb.onPick(last.level, last.model, last.name);
    this.body.querySelector<HTMLElement>(`.pl-tile[data-level="${last.level}"][data-model="${last.model}"]`)
      ?.scrollIntoView({ block: 'center' });
  }

  /** Import a GENERATED model (the ✨ dialog's "add to library") — same conversion, staging and record
   *  path as a picked file, plus the rescale to `targetMeters`. Throws with a toast-ready message so the
   *  dialog can stay open on failure (its paid GLB must not be lost to a refused import). */
  async importGenerated(file: File, targetMeters: number, generation: FalGenerationProvenance): Promise<void> {
    if (this.importing) throw new Error('another import is still running — try again in a moment');
    this.importing = true;
    this.render();
    try {
      const last = await this.importOne(file, targetMeters, generation);
      this.importing = false;
      await this.adoptImported(last);
    } finally {
      if (this.importing) { this.importing = false; this.render(); } // the failure path; success re-rendered
    }
  }

  /** Drain the thumbnail render queue one at a time — each render loads its tiles then snapshots the shared
   *  offscreen renderer, so they must not overlap (the renderer + scene are reused). A level change clears
   *  the queue (render()), so the loop naturally picks up the new level's swatches. */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length) {
      const el = this.queue.shift()!;
      // a tile names its own level (the Custom view mixes authored models and imported GLBs); groups only
      // ever come from the selected level itself
      const level = el.dataset.level ?? this.props?.level;
      const lp = level ? this.lpFor(level) : null;
      if (!level || !lp) continue;
      const generation = this.thumbnailGeneration;
      let key: string;
      let url: string | undefined;
      if (el.dataset.group) {
        // a Groups tile renders its whole assembly — every member model at its group-local pose
        const g = this.groupList?.find(gg => gg.id === el.dataset.group);
        if (!g) continue;
        key = `${level}:g:${g.id}`;
        url = this.thumbCache.get(key);
        if (!url) {
          const entries = g.props
            .map(m => ({ model: this.props!.models.find(mm => mm.id === m.model), relPos: m.relPos, relYaw: m.relYaw }))
            .filter((e): e is { model: NonNullable<typeof e.model>; relPos: typeof e.relPos; relYaw: number } => !!e.model);
          if (!entries.length) continue;
          url = await this.thumb.renderSet(entries, level, this.props!.materials);
          if (generation !== this.thumbnailGeneration) continue;
          this.thumbCache.set(key, url);
        }
      } else {
        const id = Number(el.dataset.model);
        const model = lp.models.find(mm => mm.id === id);
        if (!model) continue;
        key = `${level}:${id}`;
        url = this.thumbCache.get(key);
        if (!url) {
          url = await this.thumb.render(model, level, lp.materials);
          if (generation !== this.thumbnailGeneration) continue;
          this.thumbCache.set(key, url);
        }
      }
      const t = el.querySelector<HTMLElement>('.pl-thumb');
      if (t) t.style.backgroundImage = `url(${url})`;
    }
    this.pumping = false;
  }
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Ask for one model file, resolving null if the picker is dismissed. Replace's way in — the library's own
 *  hidden ＋ input is a multi-file adder and belongs to that route. */
function pickGlbFile(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.glb,.gltf,model/gltf-binary,model/gltf+json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}
