/**
 * The Palette (the Tools panel's content while painting): a small staging grid where you compose the
 * exact tile + ride-feel + orientation combos you'll paint the mountain with. Drag a tile in from the
 * Texture Library; drag cells within the Palette to rearrange them (Shift+drag copies a cell instead of moving it). A click on a filled cell makes it the
 * active paint brush (like the Library or a sampled viewport surface), magnifies it in the preview, and flashes its
 * duplicates; ← / → then turn it through the 8 D4 states (like the terrain, and like a tiled prop's tile),
 * ⇧ mirroring rather than turning; the ✕ on
 * hover clears a cell. A texture/surface view toggle shows either the tile art or its underlying ride-feel
 * colour; in Surface view right-click a cell to open a menu that sets its ride feel (a plain click still
 * grabs the tile as the brush, as in Texture view) — so the
 * same tile can sit in the pad more than once with different surfaces. A big preview above
 * (always shown) magnifies the focused cell in the middle with a thin strip of its grid-adjacent cell on
 * each side, at that cell's grid orientation — mirroring the pad, but only where neighbours butt cleanly (a
 * pad edge, empty, or orange-separated neighbour leaves that side blank) — see gridNeighbour /
 * drawPreviewCanvas. Click the preview to pulse the tile's duplicates elsewhere in the pad. With no brush armed, clicking
 * a textured viewport surface inspects it; middle-clicking the surface or pressing “paint texture” beneath
 * this preview arms it at its orientation relative to the patch (the top-bar F overlay draws the pink art F
 * on the preview and every pad cell here too; see setShowF). A slot menu left of the view toggle swaps
 * between 10 separate pads, so several tile combos can be staged at once (the menu counts each slot's
 * cells); the armed brush carries across a switch but the focused cell does not — see setPad. Every slot
 * persists across reloads.
 *
 * Cells sit edge-to-edge with a 1 px seam so the Palette doubles as a tile-alignment check: for each
 * shared edge between two filled cells, the touching edges (with each cell's D4 orientation applied,
 * then averaged into a few coarse segments so per-pixel grain is ignored) are compared segment-by-
 * segment, and the seam is painted orange when the WORST segment steps apart — a colour / brightness
 * break somewhere along the edge, not mere grain misalignment, and not diluted by the parts that do
 * match. Pixels are read from the same-origin texture images via a scratch canvas (see edgesFor /
 * bucketize / edgeDiff / drawSeams).
 */
import { parseTexRef, type Brush, type TexRef } from '../../core/paint/textures';
import { orientCss, orientText, turnD4 } from '../../core/paint/orientation';
import { DEFAULT_SURFACE, SURFACE_TYPES, surfaceStyle } from '../../core/doc/types';
import { DRAG_CELL, DRAG_TILE } from './drag-drop';
import { drawFGlyph, F_OVERLAY_CSS } from './glyph';
import { tooltip } from '../ui/components/tooltip';
import { infoBadge } from '../ui/components/info';
import { installStyles } from '../ui/components/styles';
import { textureRefUrl } from '../net/asset-paths';
import { alphaClassLabel, classifyTextureAlpha, type AlphaClass } from '../props/texture-alpha';
import {
  CROWD_FRAMES_PER_SECOND,
  createTextureFlipPlayback,
  isTextureFlipPulse,
  selectTextureFlipPlaybackFrame,
  stepTextureFlipPlayback,
  type TextureFlipEffect,
  type TextureFlipPlayback,
} from '../../core/effects/world-effects';

interface Cell { ref: TexRef; surface: number; rot: number; mirror: boolean; }
/** What the big preview can magnify: a pad cell / brush, or an inspected terrain cell whose ride feel may be
 *  unknown (a reference patch carries no SurfaceType) — the readout shows '—' then. A shift-range selection
 *  passes the set's size in `count` (the readout describes the anchor cell and shows the count under it).
 *  `source` = the kind of editor object the selection came from and `sourceName` is its specific identity;
 *  ordinary brush / pad previews fall back to `palette` plus the texture name. `context`
 *  distinguishes terrain paint context (ride material + D4 apply) from a prop texture (neither applies).
 *  `appearance` / `priority` / `scroll` are native PROP-surface facts for the details list. `uvEdges` = the inspected prop submesh's
 *  triangle edges in UV space ((u1,v1,u2,v2)-packed) — drawn over the art to show how the surface maps
 *  onto the texture. `flipbookFrames` carries every extracted frame for an inspected animated prop surface. */
type PreviewCell = { ref: TexRef; surface: number | null; rot: number; mirror: boolean; count?: number;
  source?: 'model' | 'surface' | 'palette'; sourceName?: string; context?: 'terrain' | 'prop';
  appearance?: string; priority?: boolean; scroll?: boolean;
  uvEdges?: Float32Array; flipbookFrames?: TexRef[];
  flipbookEffect?: TextureFlipEffect };
type View = 'texture' | 'surface';
type Edges = { top: number[]; right: number[]; bottom: number[]; left: number[] }; // RGBA runs along each side

const EDGE_N = 32;            // render each oriented tile this small to sample its edge pixels
const EDGE_BUCKETS = 4;       // average each edge into this many segments before comparing, so per-pixel grain
                             // misalignment (two "same snow" edges) doesn't read as a seam — only a coarse
                             // colour / brightness step (or a large-scale feature break) does
const SEAM_THRESH = 0.20;     // per-channel diff (0..1) of the WORST-matching segment above which a seam is
                             // "not aligned" — worst-segment, not average, so a partial mismatch (edges match
                             // at one end but step apart at the other) still flags instead of averaging out
const SEAM_W = 3;             // px width of the orange mismatch marker drawn in the 1 px gap
const SEAM_COLOR = '#ff8a1e';
const PREV_STRIP = 0.13;                   // side-strip thickness of the big preview, as a fraction of its width
const PREV_STRIP_MIN = 14, PREV_STRIP_MAX = 26; // clamped so the strips stay a readable sliver at any panel size
const DEFAULT_FLIPBOOK_EFFECT: TextureFlipEffect = {
  direction: 0, speed: CROWD_FRAMES_PER_SECOND * 2, length: 0, dwell: false,
};

export interface PaletteCallbacks {
  /** The active brush changed (a cell was placed / selected / rotated) — paint terrain with this. */
  onSelect(brush: Brush, preserveInspection?: boolean): void;
  /** The staged set of tiles changed (placed / cleared / dropped) — e.g. so the Library can re-filter. */
  onContentsChange?(): void;
  /** The "Texture Library" toggle was pressed — show / hide the bottom Texture Library panel. */
  onToggleLibrary?(): void;
  /** The Texture / Surface view toggle flipped — the right-click role differs per view, so the host redraws
   *  the Palette help overlay to match. */
  onViewChange?(): void;
}

const ROWS = 15, COLS = 5, N = ROWS * COLS;
const PADS = 10;                     // independently stored pads, picked from the slot menu above the grid
const KEY = 'slopesmith-scratch-v1'; // the name doesn't match the pad's current UI language; keep it as-is so already-staged palettes keep loading
const LIB_SVG = // a 2×2 tile grid — the Texture Library
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>' +
  '<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';

const css = `
.sc-pad { display: none; flex-direction: column; gap: 8px; padding: 8px 2px 4px; }
.sc-prev { display: flex; flex-direction: column; gap: 8px; align-items: stretch; padding: 8px;
  border: 1px solid #2c3e50; border-radius: 6px; background: #12202e; }
/* the big preview (always shown): the focused cell large in the middle with a thin strip of its
   grid-adjacent cell abutting each side, drawn to a canvas — only where the neighbour butts cleanly
   (a pad edge, empty, or orange-separated neighbour leaves that side blank). */
.sc-pvwrap { position: relative; width: 100%; }
.sc-pvcanvas { display: block; width: 100%; border-radius: 5px; background: #0e1a26; cursor: grab; }
.sc-pvcanvas:active { cursor: grabbing; }
.sc-psource { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0 2px;
  color: #b8c9d9; font-size: 11px; line-height: 1.2; }
.sc-psource .sc-pcap { flex: 0 0 auto; }
.sc-psource-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-paint { width: 100%; height: var(--widget-height); padding: 0; border: 0;
  border-radius: var(--widget-border-radius); background: var(--widget-color); color: var(--text-color);
  cursor: pointer; font-family: var(--font-family); font-size: var(--font-size); font-weight: normal; }
@media (hover: hover) {
  .sc-paint:hover { background: var(--hover-color); }
  .sc-paint:focus { box-shadow: inset 0 0 0 1px var(--focus-color); outline: none; }
}
.sc-paint:active { background: var(--focus-color); }
/* inspected prop flipbook: all extracted frames in order; clicking one promotes it to the large preview */
.sc-pframe-head { display: flex; align-items: baseline; gap: 7px; }
.sc-pplay { padding: 0; border: 0; background: transparent; color: #ffd21a; cursor: pointer;
  font: 600 10px/1 system-ui, sans-serif; text-decoration: underline; text-underline-offset: 2px; }
.sc-pplay:hover { color: #ffe77a; }
.sc-pframes { display: flex; gap: 5px; overflow-x: auto; padding: 1px 1px 4px; scrollbar-width: thin; }
.sc-pframe { position: relative; flex: 0 0 48px; width: 48px; height: 48px; padding: 0; overflow: hidden;
  border: 1px solid #34506b; border-radius: 4px; background: #0e1a26; cursor: pointer; }
.sc-pframe:hover { border-color: #9fb3c8; }
.sc-pframe.on { border-color: #ffd21a; box-shadow: 0 0 0 1px #ffd21a; }
.sc-pframe img { display: block; width: 100%; height: 100%; object-fit: cover; image-rendering: auto; }
.sc-pframe-no { position: absolute; right: 2px; bottom: 1px; padding: 0 2px; border-radius: 2px;
  background: #08111bcc; color: #d9e6f2; font: 9px/14px system-ui, sans-serif; pointer-events: none; }
/* Terrain paint context sits immediately above the Paint action; prop textures omit it because terrain ride
   material and patch-relative D4 do not describe a model submesh. */
.sc-plines { display: flex; flex-direction: column; gap: 1px; min-width: 0;
  user-select: text; -webkit-user-select: text; cursor: text; }
.sc-plines.cols { flex-direction: row; align-items: stretch; gap: 0; }
.sc-pcol { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 0 9px; justify-content: center; }
.sc-pcol:first-child { flex: 1 1 auto; padding-left: 2px; }
.sc-pcol + .sc-pcol { flex: 0 0 auto; border-left: 1px solid #24384a; } /* material / rotation sized to content */
.sc-pcap { font-size: 9px; letter-spacing: .05em; text-transform: uppercase; color: #6f8398; user-select: none; }
.sc-pmeta { font-size: 11px; color: #9fb3c8; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.sc-pmeta .sc-sw { width: 11px; height: 11px; border-radius: 2px; border: 1px solid #0006; }
/* rotation readout: the brush's own D4 orientation as degrees (0° / 90° / 180° / 270°) plus a ⇋ when mirrored */
.sc-prot { font-size: 11px; color: #9fb3c8; white-space: nowrap; }
/* shift-range count under the readout: the set the terrain's amber outlines mark (Del clears them all) */
.sc-pcount { font-size: 10px; color: #ffc24d; padding: 2px 2px 0; user-select: none; }
/* Texture facts mirror Prop Details' neutral slate cards: short semantic label left, value right. */
.sc-details { display: flex; flex-direction: column; gap: 3px; user-select: text; -webkit-user-select: text; }
.sc-detail { display: grid; grid-template-columns: minmax(66px, 38%) minmax(0, 1fr); align-items: center;
  min-height: var(--widget-height); padding: 2px 6px; background: #111d28; border: 1px solid #294055;
  border-left: 3px solid #5d8db5; border-radius: 5px; box-sizing: border-box; }
.sc-detail-label { color: #7894aa; font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.sc-detail-value { min-width: 0; color: #d3e2ee; font-size: var(--font-size); text-align: right;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-empty { color: #6f8398; font-size: 11px; padding: 2px; }
.sc-bar { display: flex; align-items: center; gap: 6px; }
.sc-grow { flex: 1 1 auto; }
/* "Texture Library" show/hide toggle above the preview; blue when open */
.sc-openlib { cursor: pointer; background: #1c2b3a; border: 1px solid #34506b; color: #cfe3f5; flex: 0 0 auto;
  border-radius: 6px; font-size: 11px; padding: 4px 9px; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.sc-openlib:hover { background: #25425c; }
.sc-openlib.on { background: #2d4f6b; border-color: #6ee7a8; color: #eaf6ff; }
.sc-openlib svg { width: 13px; height: 13px; }
/* palette slot picker, left of the view toggle: ${PADS} separately stored pads, so several tile combos can be
   kept at once and swapped between. Each option counts what that slot holds. */
.sc-padsel { flex: 0 0 auto; background: #15202c; color: #cfe3f5; border: 1px solid #34506b; border-radius: 6px;
  padding: 4px 6px; font: inherit; font-size: 11px; cursor: pointer; }
.sc-padsel:hover { background: #1c2b3a; }
.sc-padsel:focus { outline: none; box-shadow: inset 0 0 0 1px var(--focus-color); }
.sc-seg { display: inline-flex; flex: 0 0 auto; border: 1px solid #34506b; border-radius: 6px; overflow: hidden; }
.sc-seg button { background: #15202c; color: #aebfd0; border: 0; border-left: 1px solid #2c3e50; padding: 4px 10px;
  font-size: 11px; cursor: pointer; }
.sc-seg button:first-child { border-left: 0; }
.sc-seg button.on { background: #2d4f6b; color: #eaf6ff; }
/* cells packed edge-to-edge (1 px seam) so the pad reads as a tiling; highlights are INSET so they
   never widen a cell and break the alignment view. sc-seams draws the orange mismatch markers on top. */
.sc-gridwrap { position: relative; }
.sc-grid { display: grid; grid-template-columns: repeat(${COLS}, 1fr); gap: 1px; background: #1a2836; }
.sc-seams { position: absolute; inset: 0; pointer-events: none; z-index: 3; } /* keep seams above the sel glow */
.sc-cell { position: relative; aspect-ratio: 1; cursor: pointer;
  background-color: #0d1722; background-size: cover; overflow: hidden; }
.sc-cell.empty { outline: 1px dashed #2a3b4b; outline-offset: -1px; cursor: pointer; }
.sc-cell:not(.empty) { cursor: grab; }
.sc-cell:not(.empty):active { cursor: grabbing; }
.sc-cell:not(.empty):hover { box-shadow: inset 0 0 0 2px #6ee7a8; }
/* the amber selection box (like the Texture Library swatch) HOLDS only on the focused cell */
.sc-cell.sel { box-shadow: 0 0 0 2px #ffc24d, 0 0 12px 3px #ffc24daa; z-index: 2; }
/* a one-shot pulse that fades to nothing — added to every cell sharing the selected tile so its duplicates
   flash, then settle back (the focused cell keeps its steady .sel glow underneath) */
.sc-cell.flash { animation: sc-flash .6s ease-out; z-index: 3; }
@keyframes sc-flash {
  from { box-shadow: 0 0 0 4px #ffe79a, 0 0 22px 9px #ffd98a; }
  to   { box-shadow: 0 0 0 2px #ffc24d00, 0 0 12px 3px #ffc24d00; } }
.sc-cell.over { box-shadow: inset 0 0 0 2px #6ee7a8; }
.sc-x { position: absolute; top: 1px; right: 1px; width: 14px; height: 14px; line-height: 12px; text-align: center;
  border-radius: 3px; background: #2a1c1ccc; border: 1px solid #6b3434; color: #f5cfcf; font-size: 10px;
  display: none; }
.sc-cell:hover .sc-x { display: block; }
/* Surface view: the ride-feel colour covers the RIGHT half of the cell over the tile art (vertical split) */
.sc-surfhalf { position: absolute; top: 0; right: 0; width: 50%; height: 100%; pointer-events: none;
  border-left: 1px solid #0006; }
/* ride-feel picker popup (Surface view: right-click a cell) */
.sc-surfmenu { position: fixed; z-index: 60; background: #0e1a26; border: 1px solid #34506b; border-radius: 8px;
  padding: 4px; box-shadow: 0 8px 30px #000a; max-height: 70vh; overflow: auto; min-width: 150px; }
.sc-surfrow { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: transparent;
  border: 0; color: #d7e3f0; padding: 6px 10px; border-radius: 5px; cursor: pointer; font: inherit; font-size: 12px; white-space: nowrap; }
.sc-surfrow:hover { background: #1c3247; }
.sc-surfrow.on { background: #2d4f6b; color: #eaf6ff; }
.sc-surfsw { width: 13px; height: 13px; border-radius: 3px; border: 1px solid #0006; flex: 0 0 auto; }
`;

/** SurfaceType as a short label, e.g. "1 snow" or "5 ice". */
function surfText(s: number): string {
  return `${s} ${SURFACE_TYPES[s] ?? `surface ${s}`}`;
}
function surfCss(s: number): string {
  const [r, g, b] = surfaceStyle(s).color;
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

export class Palette {
  readonly el = document.createElement('div');
  private prev = document.createElement('div');
  private prevCanvas = document.createElement('canvas'); // big preview: selected cell + its grid-adjacent neighbours
  private libBtn = document.createElement('button');     // show / hide the Texture Library above the preview
  private showF = false; // the top-bar F toggle: draw the pink art F on the preview + every pad cell
  private seg = document.createElement('div');
  private padSel = document.createElement('select');     // which of the PADS stored pads the grid is showing
  private gridWrap = document.createElement('div');
  private grid = document.createElement('div');
  private seams = document.createElement('canvas'); // orange mismatch markers over the grid
  private pads: (Cell | null)[][] = Array.from({ length: PADS }, () => new Array<Cell | null>(N).fill(null));
  private activePad = 0;
  /** The pad on screen. Everything else works cell-by-cell through this, so the whole editor keeps operating
   *  on "the pad" and only the slot menu decides which one that is. */
  private get cells(): (Cell | null)[] { return this.pads[this.activePad]; }
  private view: View = 'texture';
  private current: Cell | null = null; // active brush combo (from the Library, a sampled surface, or a cell)
  private inspect: PreviewCell | null = null; // a terrain cell being INSPECTED (paint select mode) — preview-only, never the brush
  private inspectFrame = 0; // selected frame within an inspected prop flipbook
  private inspectFlip: TextureFlipPlayback | null = null;
  private inspectPlaying = false;
  private inspectRaf: number | null = null;
  private inspectLastTime = 0;
  private selCell: number | null = null;
  private imgCache = new Map<string, HTMLImageElement>();      // ref -> loaded texture image
  private edgeCache = new Map<string, Edges>();                // `ref|rot|mirror` -> oriented edge pixels
  private typeCache = new Map<string, string>();                // tile ref -> generic PNG alpha classification
  private typePending = new Set<string>();
  private exCanvas = document.createElement('canvas');         // scratch canvas to read edge pixels from
  private exCtx = this.exCanvas.getContext('2d', { willReadFrequently: true });
  private surfMenu: HTMLElement | null = null;                 // the ride-feel picker popup (Surface view)
  private surfMenuOff: ((e: MouseEvent) => void) | null = null; // its outside-click closer

  constructor(private cb: PaletteCallbacks) {
    installStyles('paint-palette', css);

    this.el.className = 'sc-pad';
    this.prev.className = 'sc-prev';
    this.prevCanvas.className = 'sc-pvcanvas';
    // the preview fills the panel width; redraw the tiling whenever the dock (hence its width) resizes
    new ResizeObserver(() => this.drawPreviewCanvas()).observe(this.prevCanvas);
    // the preview is a drag SOURCE: drag it down into a Palette cell to stage the current tile (with its orientation)
    this.prevCanvas.draggable = true;
    this.prevCanvas.ondragstart = e => {
      const c = this.previewCell();
      if (!c || !e.dataTransfer) { e.preventDefault(); return; }
      e.dataTransfer.setData(DRAG_TILE, JSON.stringify({ ref: c.ref, surface: c.surface, rot: c.rot, mirror: c.mirror }));
      e.dataTransfer.effectAllowed = 'copy';
    };
    // rotating the active tile is on ← / → everywhere in Paint (shortcuts.ts), so the preview has no menu of
    // its own; suppress the browser's so a stray right-click over it behaves like the rest of the panel
    this.prevCanvas.oncontextmenu = e => e.preventDefault();
    // click the preview to pulse the previewed tile's duplicates elsewhere in the pad (spot where else it's used)
    this.prevCanvas.onclick = () => { const c = this.previewCell(); if (c) this.flashRef(c.ref); };

    // Texture Library row — a toggle to show / hide the bottom Texture Library panel
    const libBar = document.createElement('div');
    libBar.className = 'sc-bar';
    this.libBtn.className = 'sc-openlib';
    this.libBtn.type = 'button';
    this.libBtn.innerHTML = `${LIB_SVG}<span>Texture Library</span>`;
    tooltip(this.libBtn, 'Show / hide the Texture Library — the level’s texture tiles, at the bottom of the screen.');
    this.libBtn.onclick = () => this.cb.onToggleLibrary?.();
    const libGrow = document.createElement('span');
    libGrow.className = 'sc-grow';
    libBar.append(libGrow, this.libBtn);

    // view toggle (Texture / Surface); interaction help lives in the lower-right "Paint" overlay
    const bar = document.createElement('div');
    bar.className = 'sc-bar';
    // slot picker, ahead of the view toggle: each slot is its own pad, so a snow-rock set and a park set (say)
    // can both be staged and swapped between instead of one overwriting the other
    this.padSel.className = 'sc-padsel';
    for (let p = 0; p < PADS; p++) {
      const o = document.createElement('option');
      o.value = String(p);
      o.textContent = `Palette ${p + 1}`;
      this.padSel.appendChild(o);
    }
    // The number after a slot is how many cells it holds.
    tooltip(this.padSel, `Palette slot — ${PADS} pads of staged tiles; each keeps its own combo across reloads.`);
    this.padSel.onchange = () => this.setPad(Number(this.padSel.value));
    this.seg.className = 'sc-seg';
    for (const [v, label] of [['texture', 'Texture'], ['surface', 'Surface']] as [View, string][]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => this.setView(v);
      this.seg.appendChild(b);
    }
    const grow = document.createElement('span');
    grow.className = 'sc-grow';
    // the shared info badge next to the view toggle — what the Palette is for
    const help = infoBadge(
      'Palette — stage the tiles you’ll paint with:\n' +
      '• Drag tiles in from the Texture Library into a cell\n' +
      '• Drag cells around to arrange a pattern\n' +
      '• Click a cell to use that tile as the brush\n' +
      '• ← / → turn the tile a quarter (⇧ mirrors it)\n' +
      '• Keep combos in the palette slots on the left');
    bar.append(this.padSel, this.seg, help, grow);

    this.grid.className = 'sc-grid';
    this.grid.oncontextmenu = e => e.preventDefault(); // R-click opens the ride-feel menu, no browser menu
    this.exCanvas.width = this.exCanvas.height = EDGE_N;
    this.gridWrap.className = 'sc-gridwrap';
    this.seams.className = 'sc-seams';
    this.gridWrap.append(this.grid, this.seams);
    // the grid reflows as the dock resizes; re-place the seam markers to match
    new ResizeObserver(() => this.drawSeams()).observe(this.gridWrap);

    this.el.append(libBar, this.prev, bar, this.gridWrap);
    this.load();
    this.syncSeg();
    this.syncPadSel();
    this.renderGrid();
    this.renderPreview();
  }

  setVisible(on: boolean) {
    this.el.style.display = on ? 'flex' : 'none';
    if (on) { this.drawSeams(); this.drawPreviewCanvas(); }
    else this.stopFlipbook();
  }

  /** Reflect the Texture Library's open/closed state on the "Texture Library" toggle (its pressed highlight).
   *  The host keeps this in sync when the Library is opened / folded via either this button or its own caret. */
  setLibraryOpen(on: boolean) { this.libBtn.classList.toggle('on', on); }

  /** The top-bar F toggle: draw the pink art F (1/3 tile, centred) on the preview and every pad cell. */
  setShowF(on: boolean) {
    if (on === this.showF) return;
    this.showF = on;
    this.renderGrid();
    this.renderPreview();
  }

  /** The set of texture refs staged in the VISIBLE slot (for the Library's "hide staged" filter) — the filter
   *  declutters against the pad you can see, so tiles parked in another slot stay offered. */
  stagedRefs(): Set<string> {
    const s = new Set<string>();
    for (const c of this.cells) if (c) s.add(c.ref);
    return s;
  }

  /**
   * Repoint every staged cell wearing `from` to `to`, or clear them when `to` is null — a Custom tile was
   * renamed or deleted out from under the pad. Without this the pad keeps rendering a ref whose file has
   * moved or gone, which shows as a broken swatch that still paints.
   */
  retargetRef(from: TexRef, to: TexRef | null): void {
    let touched = false;
    for (const pad of this.pads) {                     // every slot, not just the visible one — an off-screen
      for (let i = 0; i < pad.length; i++) {           // pad holding a deleted ref would still paint it later
        const c = pad[i];
        if (!c || c.ref !== from) continue;
        pad[i] = to ? { ...c, ref: to } : null;
        touched = true;
      }
    }
    if (this.current?.ref === from) this.current = to ? { ...this.current, ref: to } : null;
    if (this.inspect?.ref === from) this.inspect = null;
    if (!touched && !this.current && !this.inspect) return;
    if (touched) this.save();                          // else a reload restores the dead ref from storage
    this.renderGrid();
    this.renderPreview();
  }

  /** Adopt the app's current paint brush as the thing that drops into a blank cell (and the preview). */
  setCurrent(brush: Brush, preserveInspection = false) {
    this.current = { ref: brush.ref, surface: brush.surface, rot: brush.rot, mirror: brush.mirror };
    if (!preserveInspection) this.clearInspection(); // a sampled surface keeps its details until painting starts
    this.selCell = null;
    this.renderGrid(); // no cell holds the glow now (the brush came from the Library / viewport)
    this.renderPreview();
    this.flashRef(brush.ref); // flash any pad duplicates of the picked tile
  }

  /** Put the brush down (Esc left placement mode): nothing held, the preview empties until the next pick. */
  clearCurrent() {
    this.current = null;
    this.selCell = null;
    this.renderGrid();
    this.renderPreview();
  }

  /** True while the preview is retaining the surface that supplied a newly sampled brush. */
  get inspecting(): boolean { return this.inspect !== null; }

  /** Show a clicked surface in the preview without touching the brush or pad. Terrain selections expose
   *  paint material + rotation above the action; prop selections omit those and contribute native texture
   *  facts below it. Null returns the preview to the brush / focused pad cell. */
  showCell(c: PreviewCell | null) {
    this.stopFlipbook();
    this.inspect = c ? { ref: c.ref, surface: c.surface, rot: c.rot, mirror: c.mirror, count: c.count,
      source: c.source, sourceName: c.sourceName, context: c.context,
      appearance: c.appearance, priority: c.priority, scroll: c.scroll,
      uvEdges: c.uvEdges, flipbookFrames: c.flipbookFrames,
      flipbookEffect: c.flipbookEffect } : null;
    this.inspectFrame = 0;
    this.inspectFlip = this.inspect?.flipbookFrames && this.inspect.flipbookFrames.length > 1
      ? createTextureFlipPlayback(this.previewFlipEffect(this.inspect.flipbookEffect)) : null;
    this.renderPreview();
  }

  /** Refine the inspected prop's appearance IF `ref` is still what the preview shows — the async
   *  cutout-vs-translucent read refines a prop inspect without clobbering a newer selection. */
  updateCellAppearance(ref: TexRef, appearance: string) {
    if (this.inspect?.ref !== ref) return;
    this.inspect.appearance = appearance;
    this.renderPreview();
  }

  private brushOf(c: Cell): Brush { return { kind: 'tile', ref: c.ref, surface: c.surface, rot: c.rot, mirror: c.mirror }; }

  /** What the preview magnifies: an inspected terrain cell first (paint select mode), else the focused pad
   *  cell, else the active brush (may be null). */
  private previewCell(): PreviewCell | null {
    return this.inspect ?? (this.selCell != null ? this.cells[this.selCell] : this.current);
  }

  /** Texture shown in the large preview: the chosen flipbook frame for a prop inspection, else frame zero. */
  private previewRef(c: PreviewCell): TexRef {
    return c.flipbookFrames?.[this.inspectFrame] ?? c.ref;
  }

  /** The law the frame strip plays back. Texture Details browses a material's frames, so a one-shot's node
   *  lifetime — which in the world ends the animation in well under a second — is dropped here; the detail
   *  rows below still report it. */
  private previewFlipEffect(effect: TextureFlipEffect | undefined): TextureFlipEffect {
    const law = effect ?? DEFAULT_FLIPBOOK_EFFECT;
    return isTextureFlipPulse(law) ? { ...law, length: 0 } : law;
  }

  /** Arm the exact tile currently shown by the preview. A reference patch arms with its own ride feel; a
   *  prop inspection has none and adopts the standard snow default; its yellow inspection remains until the
   *  first stroke. */
  private armPreview() {
    const c = this.previewCell();
    if (!c) return;
    this.current = { ref: this.previewRef(c), surface: c.surface ?? DEFAULT_SURFACE, rot: c.rot, mirror: c.mirror };
    this.cb.onSelect(this.brushOf(this.current), this.inspect !== null);
    this.flashRef(this.current.ref);
  }

  /** Leave prop/terrain inspection for an ordinary brush/pad interaction, stopping its private preview clock. */
  private clearInspection() {
    this.stopFlipbook();
    this.inspect = null;
    this.inspectFlip = null;
    this.inspectFrame = 0;
  }

  private stopFlipbook() {
    if (this.inspectRaf !== null) cancelAnimationFrame(this.inspectRaf);
    this.inspectRaf = null;
    this.inspectPlaying = false;
    const play = this.prev.querySelector<HTMLButtonElement>('.sc-pplay');
    if (play) play.textContent = 'Play';
  }

  private toggleFlipbook() {
    const c = this.inspect;
    const frames = c?.flipbookFrames;
    if (!c || !frames || frames.length < 2) return;
    if (this.inspectPlaying) { this.stopFlipbook(); return; }
    const effect = this.previewFlipEffect(c.flipbookEffect);
    if (!this.inspectFlip) {
      this.inspectFlip = createTextureFlipPlayback(effect);
      selectTextureFlipPlaybackFrame(this.inspectFlip, frames.length, this.inspectFrame);
    }
    this.inspectPlaying = true;
    this.inspectLastTime = performance.now();
    const play = this.prev.querySelector<HTMLButtonElement>('.sc-pplay');
    if (play) play.textContent = 'Pause';
    this.inspectRaf = requestAnimationFrame(this.stepFlipbook);
  }

  private stepFlipbook = (now: number) => {
    const c = this.inspect;
    const frames = c?.flipbookFrames;
    const playback = this.inspectFlip;
    if (!this.inspectPlaying || !c || !frames || frames.length < 2 || !playback) {
      this.stopFlipbook();
      return;
    }
    const dt = Math.min(0.1, Math.max(0, (now - this.inspectLastTime) / 1000));
    this.inspectLastTime = now;
    if (stepTextureFlipPlayback(playback, this.previewFlipEffect(c.flipbookEffect), frames.length, dt)) {
      this.inspectFrame = playback.frame;
      this.syncFlipbookPreview();
    }
    this.inspectRaf = requestAnimationFrame(this.stepFlipbook);
  };

  private chooseFlipbookFrame(index: number) {
    const c = this.inspect;
    const frames = c?.flipbookFrames;
    if (!c || !frames || index < 0 || index >= frames.length) return;
    this.inspectFrame = index;
    this.inspectFlip = createTextureFlipPlayback(this.previewFlipEffect(c.flipbookEffect));
    selectTextureFlipPlaybackFrame(this.inspectFlip, frames.length, index);
    this.inspectLastTime = performance.now();
    this.syncFlipbookPreview();
  }

  /** Update only the changing frame affordances; rebuilding the whole panel each tick would reset scrolling. */
  private syncFlipbookPreview() {
    const c = this.inspect;
    if (!c) return;
    this.prev.querySelectorAll<HTMLElement>('.sc-pframe').forEach((frame, index) =>
      frame.classList.toggle('on', index === this.inspectFrame));
    this.syncPreviewDetails();
    this.drawPreviewCanvas();
  }

  /** A click on a filled cell makes it the active paint brush (like the Library / viewport sampler) and focuses
   *  the preview on it — the same in both views. A click on an empty cell just focuses the preview. (In
   *  Surface view the ride-feel menu is on right-click instead; see the grid's oncontextmenu.) */
  private clickCell(i: number) {
    this.clearInspection(); // any pad interaction returns the preview to the pad / brush
    if (this.cells[i]) { this.copyToBrush(i); return; }
    this.focusCell(i);
  }
  /** Focus the preview on cell `i` (holds the selection there) without touching the brush or pad contents. */
  private focusCell(i: number) {
    this.selCell = i;
    this.renderGrid(); this.renderPreview();
    this.flashMatching(i);
  }
  /** Copy an existing cell's tile (ref + surface + orientation) to the active paint brush, and focus it. */
  private copyToBrush(i: number) {
    this.current = { ...this.cells[i]! };
    this.selCell = i;
    this.renderGrid(); this.renderPreview();
    this.cb.onSelect(this.brushOf(this.current));
    this.flashMatching(i);
  }
  /** Briefly flash every cell sharing cell `i`'s texture (so you can spot its duplicates). Only the focused
   *  cell KEEPS the selection glow (via `.sel` in renderGrid); the others just pulse and fade. */
  private flashMatching(i: number) {
    const ref = this.cells[i]?.ref;
    if (ref) this.flashRef(ref);
  }
  /** Pulse-and-fade every pad cell using texture `ref` (duplicates flash on any selection of that tile). */
  private flashRef(ref: TexRef) {
    const els = this.grid.children as HTMLCollectionOf<HTMLElement>;
    for (let k = 0; k < N; k++) els[k]?.classList.remove('flash');
    void this.grid.offsetWidth;                          // one reflow so re-adding restarts the animation
    for (let k = 0; k < N; k++) if (this.cells[k]?.ref === ref) els[k]?.classList.add('flash');
  }

  /** Open the ride-feel picker for cell `i` (Surface view): a popup of SurfaceType swatch + name; picking
   *  one sets that cell's ride feel. Anchored to the cell, dismissed on an outside click. */
  private openSurfaceMenu(i: number) {
    this.closeSurfaceMenu();
    const cell = this.cells[i];
    if (!cell) return;
    const anchor = this.grid.children[i] as HTMLElement | undefined;
    if (!anchor) return;
    const menu = document.createElement('div');
    menu.className = 'sc-surfmenu';
    const opts: [number, string][] = Object.entries(SURFACE_TYPES).map(([n, l]) => [Number(n), l] as [number, string]);
    for (const [val, lbl] of opts) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sc-surfrow' + (cell.surface === val ? ' on' : '');
      const sw = document.createElement('span');
      sw.className = 'sc-surfsw';
      sw.style.background = surfCss(val);
      const nm = document.createElement('span');
      nm.textContent = `${val} ${lbl}`;
      row.append(sw, nm);
      row.onclick = e => { e.stopPropagation(); this.setCellSurface(i, val); this.closeSurfaceMenu(); };
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.round(Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.round(Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8))}px`;
    this.surfMenu = menu;
    this.surfMenuOff = (ev: MouseEvent) => { if (this.surfMenu && !this.surfMenu.contains(ev.target as Node)) this.closeSurfaceMenu(); };
    setTimeout(() => this.surfMenuOff && document.addEventListener('mousedown', this.surfMenuOff), 0);
  }
  private closeSurfaceMenu() {
    this.surfMenu?.remove();
    this.surfMenu = null;
    if (this.surfMenuOff) { document.removeEventListener('mousedown', this.surfMenuOff); this.surfMenuOff = null; }
  }
  /** Set cell `i`'s ride feel; if it's the focused/brush cell, update the live brush too. */
  private setCellSurface(i: number, surface: number) {
    const c = this.cells[i];
    if (!c) return;
    c.surface = surface;
    if (this.selCell === i && this.current) { this.current.surface = surface; this.cb.onSelect(this.brushOf(c)); }
    this.save(); this.renderGrid(); this.renderPreview();
  }
  private rotateCell(i: number, dir: 1 | -1, flip: boolean) {
    const c = this.cells[i];
    if (!c) return;
    this.clearInspection(); // the rotated pad cell becomes the preview
    // The shared step (core/paint/orientation turnD4): with the pad rendering a tile exactly as the terrain
    // does, → turns it the same way on screen here as on the mountain. Reads down a quarter (0°→270°→…).
    Object.assign(c, turnD4(c, dir, flip));
    // rotating also makes this the active tile, so the preview + properties track it as you turn
    this.selCell = i; this.current = { ...c };
    this.save(); this.renderGrid(); this.renderPreview();
    this.cb.onSelect(this.brushOf(c), true); // a turn edits the held tile, so a sampled source keeps its outline
  }
  private clearCell(i: number) {
    this.cells[i] = null;
    if (this.selCell === i) this.selCell = null;
    this.save(); this.renderGrid();
    this.cb.onContentsChange?.();
  }

  /** True if a drag carries something this pad accepts — a Library tile or one of its own cells. */
  private canDrop(e: DragEvent): boolean {
    const t = e.dataTransfer?.types;
    return !!t && (t.includes(DRAG_TILE) || t.includes(DRAG_CELL));
  }
  /** Drop onto cell `i`: a Library tile lands there (staged with its ride feel); a dragged cell swaps in, or
   *  with Shift held is copied (the source cell stays put). */
  private dropOnCell(i: number, e: DragEvent) {
    const dt = e.dataTransfer;
    if (!dt) return;
    this.clearInspection(); // a drop refocuses the preview on the pad
    const tile = dt.getData(DRAG_TILE);
    if (tile) {
      try {
        const { ref, surface, rot, mirror } = JSON.parse(tile) as { ref: TexRef; surface?: number | null; rot?: number; mirror?: boolean };
        this.cells[i] = { ref, surface: surface ?? DEFAULT_SURFACE, rot: rot ?? 0, mirror: mirror ?? false }; // preview drags carry orientation; Library drags don't (rot 0)
        this.current = { ...this.cells[i]! }; this.selCell = i;
        this.save(); this.renderGrid(); this.renderPreview();
        this.cb.onSelect(this.brushOf(this.cells[i]!));
        this.cb.onContentsChange?.();
        this.flashMatching(i);
      } catch { /* malformed payload — ignore */ }
      return;
    }
    const cell = dt.getData(DRAG_CELL);
    if (cell !== '') {
      const from = Number(cell);
      if (!Number.isInteger(from) || from < 0 || from >= N || from === i) return;
      if (e.shiftKey) {                                   // Shift+drag = COPY: clone the source into the target, leave the source in place
        if (!this.cells[from]) return;                    // nothing to copy from an empty source
        this.cells[i] = { ...this.cells[from]! };
        this.save(); this.renderGrid(); this.renderPreview();
        this.cb.onContentsChange?.();                     // a copy-over can drop the target's old ref from the staged set
        this.flashMatching(i);
        return;
      }
      [this.cells[from], this.cells[i]] = [this.cells[i], this.cells[from]]; // swap (a swap with null = a move)
      if (this.selCell === from) this.selCell = i;        // keep the moved brush selected at its new home
      else if (this.selCell === i) this.selCell = from;
      this.save(); this.renderGrid(); this.renderPreview();
    }
  }
  /** True while the pad is in Surface view — the host uses this to phrase the Palette help (right-click sets
   *  ride feel here, rotates in Texture view). */
  get surfaceView(): boolean { return this.view === 'surface'; }
  private setView(v: View) { this.closeSurfaceMenu(); this.view = v; this.save(); this.syncSeg(); this.renderGrid(); this.renderPreview(); this.cb.onViewChange?.(); }
  private syncSeg() { [...this.seg.children].forEach((b, i) => b.classList.toggle('on', (i === 0 ? 'texture' : 'surface') === this.view)); }

  /** Show pad `p`. The armed brush survives the switch — it belongs to the app, not to a slot — but the
   *  focused cell doesn't, since its index addressed the pad we're leaving; the preview falls back to the
   *  brush. The staged set changes wholesale, so the Library re-filters. */
  private setPad(p: number) {
    if (!Number.isInteger(p) || p < 0 || p >= PADS || p === this.activePad) { this.syncPadSel(); return; }
    this.closeSurfaceMenu();
    this.clearInspection();
    this.activePad = p;
    this.selCell = null;
    this.save();
    this.renderGrid();
    this.renderPreview();
    this.cb.onContentsChange?.();
  }
  /** Label each slot with how many cells it holds, so a stored combo is findable without visiting every slot. */
  private syncPadSel() {
    for (let p = 0; p < PADS; p++) {
      const n = this.pads[p].reduce((t, c) => t + (c ? 1 : 0), 0);
      this.padSel.options[p].textContent = n ? `Palette ${p + 1} · ${n}` : `Palette ${p + 1}`;
    }
    this.padSel.value = String(this.activePad);
  }

  private detailRow(label: string, value: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sc-detail';
    row.dataset.detail = label;
    const name = document.createElement('span');
    name.className = 'sc-detail-label';
    name.textContent = label;
    const text = document.createElement('span');
    text.className = 'sc-detail-value';
    text.textContent = value;
    text.title = value;
    row.append(name, text);
    return row;
  }

  private setDetail(label: string, value: string) {
    const text = this.prev.querySelector<HTMLElement>(`.sc-detail[data-detail="${label}"] .sc-detail-value`);
    if (!text) return;
    text.textContent = value;
    text.title = value;
  }

  /** A flipbook frame can change without rebuilding the panel (which would reset its horizontal scroll). */
  private syncPreviewDetails() {
    const c = this.previewCell();
    if (!c) return;
    const ref = this.previewRef(c);
    const image = this.imageFor(ref);
    this.setDetail('filepath', ref);
    this.setDetail('type', c.appearance ?? this.textureType(ref));
    this.setDetail('size', image.complete && image.naturalWidth
      ? `${image.naturalWidth} × ${image.naturalHeight} px` : 'loading…');
  }

  /** Alpha is an intrinsic texture fact for terrain/library tiles. Prop alpha-pass materials supply their
   *  more precise native appearance through `appearance`; this fallback classifies the PNG itself once. */
  private textureType(ref: TexRef): string {
    const cached = this.typeCache.get(ref);
    if (cached) return cached;
    if (!this.typePending.has(ref)) {
      this.typePending.add(ref);
      const { level, name } = parseTexRef(ref);
      void classifyTextureAlpha(level, name).then((kind: AlphaClass) => {
        const label = kind === 'opaque-alpha' ? 'opaque'
          : kind === 'unknown' ? 'unknown' : alphaClassLabel(kind);
        this.typeCache.set(ref, label);
        this.typePending.delete(ref);
        const showing = this.previewCell();
        if (showing && this.previewRef(showing) === ref) this.syncPreviewDetails();
      });
    }
    return 'reading alpha…';
  }

  private renderPreview() {
    this.prev.innerHTML = '';
    const c = this.previewCell();
    this.prev.classList.toggle('empty', !c);
    if (c) {
      const source = document.createElement('div');
      source.className = 'sc-psource';
      const caption = document.createElement('span');
      caption.className = 'sc-pcap';
      caption.textContent = c.source ?? 'palette';
      const value = document.createElement('span');
      value.className = 'sc-psource-value';
      value.textContent = c.sourceName ?? parseTexRef(c.ref).name.replace(/\.png$/i, '');
      value.title = value.textContent;
      source.append(caption, value);
      this.prev.appendChild(source);
    }
    // the preview canvas is ALWAYS shown (even with nothing selected) so the box stays put
    const wrap = document.createElement('div');
    wrap.className = 'sc-pvwrap';
    wrap.appendChild(this.prevCanvas);
    this.prev.appendChild(wrap);
    if (c) {
      // Ride material and D4 are paint-context properties, not properties of a prop model's texture.
      if (c.context !== 'prop') {
        const context = document.createElement('div');
        context.className = 'sc-plines cols';
        const material = c.surface ?? DEFAULT_SURFACE;
        const feel = document.createElement('div');
        feel.className = 'sc-pmeta';
        feel.innerHTML = `<span class="sc-sw" style="background:${surfCss(material)}"></span>${surfText(material)}${c.surface === null ? ' · default' : ''}`;
        const rot = document.createElement('div');
        rot.className = 'sc-prot';
        rot.textContent = orientText(c.rot, c.mirror);
        context.append(this.prevCol('material', feel), this.prevCol('rotation', rot));
        this.prev.appendChild(context);
      }

      const paint = document.createElement('button');
      paint.type = 'button';
      paint.className = 'sc-paint';
      paint.textContent = '＋ paint texture';
      paint.title = 'Put this texture on the cursor, then click terrain to paint it';
      paint.onclick = () => this.armPreview();
      this.prev.appendChild(paint);

      const shownRef = this.previewRef(c);
      const image = this.imageFor(shownRef);
      const details = document.createElement('div');
      details.className = 'sc-details';
      details.append(this.detailRow('filepath', shownRef));
      details.append(this.detailRow('type', c.appearance ?? this.textureType(shownRef)));
      details.append(this.detailRow('size', image.complete && image.naturalWidth
        ? `${image.naturalWidth} × ${image.naturalHeight} px` : 'loading…'));
      if (c.flipbookFrames && c.flipbookFrames.length > 1) {
        const effect = c.flipbookEffect ?? DEFAULT_FLIPBOOK_EFFECT;
        const fps = `${Number(effect.speed.toFixed(2))} fps`;
        details.append(this.detailRow('animation', effect.dwell
          ? `${c.flipbookFrames.length} frames · dwell timing`
          : isTextureFlipPulse(effect)
            ? `${c.flipbookFrames.length} frames · ${fps} · ${Number(effect.length.toFixed(2))} s one-shot`
            : `${c.flipbookFrames.length} frames · ${fps}`));
      }
      if (c.scroll) details.append(this.detailRow('mapping', 'UV scroll'));
      if (c.priority) details.append(this.detailRow('draw priority', 'enabled · z-fight tiebreaker'));
      this.prev.appendChild(details);
    } else {
      const empty = document.createElement('div');
      empty.className = 'sc-empty';
      empty.textContent = 'no texture selected';
      this.prev.appendChild(empty);
    }

    if (c?.flipbookFrames && c.flipbookFrames.length > 1) {
      const head = document.createElement('div');
      head.className = 'sc-pframe-head';
      const caption = document.createElement('div');
      caption.className = 'sc-pcap';
      caption.textContent = `flipbook frames · ${c.flipbookFrames.length}`;
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'sc-pplay';
      play.textContent = this.inspectPlaying ? 'Pause' : 'Play';
      const flipEffect = c.flipbookEffect ?? DEFAULT_FLIPBOOK_EFFECT;
      play.title = flipEffect.dwell ? 'Preview with the recovered native dwell timing'
        : isTextureFlipPulse(flipEffect)
          ? `Browse every frame at ${Number(flipEffect.speed.toFixed(2))} frames per second — in the world a graph`
            + ` runs this as a ${Number(flipEffect.length.toFixed(2))} s one-shot`
          : `Preview at ${Number(flipEffect.speed.toFixed(2))} frames per second`;
      play.onclick = () => this.toggleFlipbook();
      head.append(caption, play);
      this.prev.appendChild(head);
      const strip = document.createElement('div');
      strip.className = 'sc-pframes';
      c.flipbookFrames.forEach((frame, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `sc-pframe${index === this.inspectFrame ? ' on' : ''}`;
        button.title = parseTexRef(frame).name;
        const image = document.createElement('img');
        image.src = textureRefUrl(frame);
        image.alt = `Flipbook frame ${index + 1}`;
        const number = document.createElement('span');
        number.className = 'sc-pframe-no';
        number.textContent = String(index + 1);
        button.append(image, number);
        button.onclick = () => this.chooseFlipbookFrame(index);
        strip.appendChild(button);
      });
      this.prev.appendChild(strip);
    }
    if (c?.count && c.count > 1) { // a shift-range selection: the readout describes the anchor; count the set
      const n = document.createElement('div');
      n.className = 'sc-pcount';
      n.textContent = `${c.count} tiles selected — Del clears them all`;
      this.prev.appendChild(n);
    }
    this.drawPreviewCanvas();
  }

  /** Turn the active tile a quarter (→ / dir −1 = CW on screen, ← / dir +1 = CCW), or toggle its mirror with
   *  `flip`. The target is the focused pad cell when there is one — a brush picked from the pad IS that cell,
   *  so the staged combo turns with it — else the loose brush (from the Library or a viewport sample). Bound
   *  to ← / → in Paint mode (shortcuts.ts); returns true when something was there to turn. */
  turnActive(dir: 1 | -1, flip: boolean): boolean {
    if (this.selCell != null && this.cells[this.selCell]) { this.rotateCell(this.selCell, dir, flip); return true; }
    if (!this.current) return false; // nothing held: leave any inspection readout alone, the key is unhandled
    this.clearInspection(); // turning the active tile returns the preview to it
    Object.assign(this.current, turnD4(this.current, dir, flip));
    this.renderGrid(); this.renderPreview();
    this.cb.onSelect(this.brushOf(this.current), true); // as above: turning is not a new pick
    return true;
  }

  /** One labelled column of the selected-texture readout: a small uppercase caption above its value. */
  private prevCol(caption: string, value: HTMLElement): HTMLElement {
    const col = document.createElement('div');
    col.className = 'sc-pcol';
    const cap = document.createElement('div');
    cap.className = 'sc-pcap';
    cap.textContent = caption;
    col.append(cap, value);
    return col;
  }

  /** The cell physically ADJACENT to the selected pad cell on `side`, at its own grid orientation — or null
   *  when there's no selected grid cell (e.g. the brush came from the Library), the pad edge is reached, the
   *  adjacent cell is empty, or that neighbour is separated from the selected cell by an orange seam (its
   *  touching edge doesn't align). So the preview mirrors the pad but only shows neighbours that butt cleanly:
   *  the cell to the LEFT meets the centre with its RIGHT edge, the one above with its BOTTOM edge, and so on. */
  private gridNeighbour(side: 'left' | 'right' | 'top' | 'bottom'): Cell | null {
    if (this.inspect) return null;                       // an inspected terrain cell has no pad neighbourhood
    const i = this.selCell;
    if (i == null) return null;                          // brush isn't a placed cell → no grid neighbourhood
    const center = this.cells[i];
    if (!center) return null;
    const col = i % COLS, row = (i / COLS) | 0;
    let j = -1;
    if (side === 'left') { if (col > 0) j = i - 1; }
    else if (side === 'right') { if (col < COLS - 1) j = i + 1; }
    else if (side === 'top') { if (row > 0) j = i - COLS; }
    else { if (row < ROWS - 1) j = i + COLS; }
    if (j < 0) return null;                              // pad edge → blank side
    const n = this.cells[j];
    if (!n) return null;                                 // empty adjacent cell → blank side
    const ce = this.edgesFor(center), ne = this.edgesFor(n);
    if (!ce || !ne) return null;                         // still loading
    const d = side === 'left' ? edgeDiff(ne.right, ce.left)
      : side === 'right' ? edgeDiff(ne.left, ce.right)
      : side === 'top' ? edgeDiff(ne.bottom, ce.top)
      : edgeDiff(ne.top, ce.bottom);
    return d > SEAM_THRESH ? null : n;                   // separated by an orange seam → don't show it
  }

  /** Draw the selected cell big in the middle of the preview canvas, with a thin strip of its GRID-ADJACENT
   *  cell on each side (only where they butt cleanly — see gridNeighbour — at that neighbour's grid
   *  orientation). The preview is always drawn; it's blank when nothing is selected. Surface view shows the
   *  tile art alone — the ride feel is in the readout row below, so the preview needn't repeat it. */
  private drawPreviewCanvas() {
    const cv = this.prevCanvas;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.clientWidth || 190;                    // fills the panel; the ResizeObserver redraws on real size
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = cv.width;                               // square
    cv.style.height = `${W}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, W);
    const c = this.previewCell();
    if (!c) return;                                     // nothing focused: leave it blank
    if (this.view === 'surface') {                      // the tile art alone (ride feel lives in the readout below)
      const im = this.imageFor(this.previewRef(c));
      if (im.complete && im.naturalWidth) {
        ctx.save();
        ctx.translate(W / 2, W / 2);
        ctx.rotate((c.mirror ? c.rot : -c.rot) * Math.PI / 2); // match the terrain's on-surface rotation sense
        ctx.scale(c.mirror ? -1 : 1, 1);
        ctx.drawImage(im, -W / 2, -W / 2, W, W);
        if (this.showF) drawFGlyph(ctx, W);             // the art F rides the same transform
        ctx.restore();
      }
      return;
    }
    const T = Math.round(Math.min(PREV_STRIP_MAX, Math.max(PREV_STRIP_MIN, W * PREV_STRIP)));
    const S = W - 2 * T;                                // centre tile size; strips are one tile shifted off-edge
    // draw the given cell's oriented tile with its top-left at (dx,dy), clipped to the rect (cx,cy,cw,ch)
    const drawTile = (cell: PreviewCell, dx: number, dy: number, cx: number, cy: number, cw: number, ch: number) => {
      const im = this.imageFor(cell.ref);
      if (!im.complete || !im.naturalWidth) return;    // still loading — the onload handler redraws
      ctx.save();
      ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.clip();
      ctx.translate(dx + S / 2, dy + S / 2);
      ctx.rotate((cell.mirror ? cell.rot : -cell.rot) * Math.PI / 2); // terrain's rotation sense (rot 0 = upright)
      ctx.scale(cell.mirror ? -1 : 1, 1);
      ctx.drawImage(im, -S / 2, -S / 2, S, S);
      if (this.showF) drawFGlyph(ctx, S);              // the art F rides the same transform (clipped like the tile)
      ctx.restore();
    };
    const left = this.gridNeighbour('left');
    const right = this.gridNeighbour('right');
    const top = this.gridNeighbour('top');
    const bottom = this.gridNeighbour('bottom');
    if (left) drawTile(left, T - S, T, 0, T, T, S);        // left strip   → its right edge
    if (right) drawTile(right, T + S, T, T + S, T, T, S);  // right strip  → its left edge
    if (top) drawTile(top, T, T - S, T, 0, S, T);          // top strip    → its bottom edge
    if (bottom) drawTile(bottom, T, T + S, T, T + S, S, T);// bottom strip → its top edge
    drawTile({ ...c, ref: this.previewRef(c) }, T, T, T, T, S, S); // active flipbook frame, on top
    if (c.uvEdges?.length) this.drawUvEdges(ctx, c.uvEdges, T, T, S);
  }

  /** The inspected prop submesh's UV wireframe over the tile art: each triangle edge drawn where it
   *  samples the texture. Prop UVs tile (RepeatWrapping), so each edge is translated by the floor of its
   *  own min corner — an edge spanning several repeats draws clipped rather than wrapped. OBJ vt is
   *  bottom-left origin (the props' flipY texture read), so v maps to canvas y inverted. */
  private drawUvEdges(ctx: CanvasRenderingContext2D, edges: Float32Array, x: number, y: number, s: number) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, s, s); ctx.clip();
    ctx.strokeStyle = 'rgba(255,210,26,0.9)'; // shared selected-geometry yellow (#ffd21a)
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i + 3 < edges.length; i += 4) {
      const du = Math.floor(Math.min(edges[i], edges[i + 2]));
      const dv = Math.floor(Math.min(edges[i + 1], edges[i + 3]));
      ctx.moveTo(x + (edges[i] - du) * s, y + (1 - (edges[i + 1] - dv)) * s);
      ctx.lineTo(x + (edges[i + 2] - du) * s, y + (1 - (edges[i + 3] - dv)) * s);
    }
    ctx.stroke();
    ctx.restore();
  }

  private renderGrid() {
    this.grid.innerHTML = '';
    // only the focused cell HOLDS the selection glow; duplicates just flash on select (see flashMatching)
    for (let i = 0; i < N; i++) {
      const c = this.cells[i];
      const cell = document.createElement('div');
      cell.className = 'sc-cell' + (c ? '' : ' empty') + (i === this.selCell ? ' sel' : '');
      if (c) {
        // the tile art (full cell, at its own D4 orientation); in Surface view the RIGHT half is overlaid
        // with the ride-feel colour, so the cell reads as half texture / half colour (vertical split)
        const img = document.createElement('div');
        img.style.cssText = `position:absolute;inset:0;pointer-events:none;background-size:cover;background-image:url(${textureRefUrl(c.ref)});transform:${orientCss(c.rot, c.mirror)}`;
        if (this.showF) { // the art F, inside the oriented element so it rides the tile's rotation / mirror
          const f = document.createElement('div');
          f.style.cssText = F_OVERLAY_CSS;
          img.appendChild(f);
        }
        cell.appendChild(img);
        if (this.view === 'surface') {
          const half = document.createElement('div');
          half.className = 'sc-surfhalf';
          half.style.background = surfCss(c.surface);
          cell.appendChild(half);
        }
        tooltip(cell, `${parseTexRef(c.ref).name.replace(/\.png$/i, '')} · ${surfText(c.surface)} · ${orientText(c.rot, c.mirror)}`);
        const x = document.createElement('span');
        x.className = 'sc-x';
        x.textContent = '✕';
        x.onclick = e => { e.stopPropagation(); this.clearCell(i); };
        cell.appendChild(x);
        cell.draggable = true; // a filled cell can be dragged onto another to reorder (Shift+drag copies)
        cell.ondragstart = e => { e.dataTransfer?.setData(DRAG_CELL, String(i)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'; };
      }
      cell.onclick = () => this.clickCell(i);
      cell.oncontextmenu = e => {
        // Surface view: right-click opens the ride-feel menu. Texture view has nothing on right-click —
        // rotating is ← / → everywhere in Paint now (shortcuts.ts).
        e.preventDefault();
        if (this.view === 'surface' && this.cells[i]) this.openSurfaceMenu(i);
      };
      // drop target: a Library tile stages here, a dragged cell swaps here (Shift = copy → copy cursor)
      cell.ondragover = e => { if (this.canDrop(e)) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = (e.shiftKey || e.dataTransfer.types.includes(DRAG_TILE)) ? 'copy' : 'move'; } };
      cell.ondragenter = e => { if (this.canDrop(e)) cell.classList.add('over'); };
      cell.ondragleave = () => cell.classList.remove('over');
      cell.ondrop = e => { e.preventDefault(); cell.classList.remove('over'); this.dropOnCell(i, e); };
      this.grid.appendChild(cell);
    }
    this.drawSeams();
    this.drawPreviewCanvas(); // a grid change may alter the selected cell's neighbourhood shown in the preview
  }

  /** The loaded texture image for a ref (kick off a load on first ask; redraw seams when it arrives). */
  private imageFor(ref: TexRef): HTMLImageElement {
    let img = this.imgCache.get(ref);
    if (!img) {
      img = new Image();
      img.onload = () => { this.drawSeams(); this.drawPreviewCanvas(); this.syncPreviewDetails(); };
      img.src = textureRefUrl(ref);
      this.imgCache.set(ref, img);
    }
    return img;
  }
  /** A cell's four edges as oriented pixel runs, or null while its texture is still loading. */
  private edgesFor(c: Cell): Edges | null {
    const key = `${c.ref}|${c.rot}|${c.mirror ? 1 : 0}`;
    const hit = this.edgeCache.get(key);
    if (hit) return hit;
    const img = this.imageFor(c.ref);
    const ctx = this.exCtx;
    if (!ctx || !img.complete || !img.naturalWidth) return null;
    ctx.clearRect(0, 0, EDGE_N, EDGE_N);
    ctx.save();
    ctx.translate(EDGE_N / 2, EDGE_N / 2);          // draw the tile exactly as the cell shows it
    ctx.rotate((c.mirror ? c.rot : -c.rot) * Math.PI / 2); // same sense as the display, so extracted edges match
    ctx.scale(c.mirror ? -1 : 1, 1);
    ctx.drawImage(img, -EDGE_N / 2, -EDGE_N / 2, EDGE_N, EDGE_N);
    ctx.restore();
    let edges: Edges;
    try { edges = extractEdges(ctx.getImageData(0, 0, EDGE_N, EDGE_N).data, EDGE_N); }
    catch { return null; } // canvas tainted (shouldn't happen for same-origin textures)
    this.edgeCache.set(key, edges);
    return edges;
  }

  /** Paint an orange marker in the seam between any two filled cells whose touching edges don't match. */
  private drawSeams() {
    const ctx = this.seams.getContext('2d');
    if (!ctx) return;
    const w = this.gridWrap.clientWidth, h = this.gridWrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.seams.width = Math.max(1, Math.round(w * dpr));
    this.seams.height = Math.max(1, Math.round(h * dpr));
    this.seams.style.width = `${w}px`; this.seams.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (this.view !== 'texture' || !w || !h) return; // alignment only makes sense on the tile art
    const els = this.grid.children as HTMLCollectionOf<HTMLElement>;
    if (els.length < N) return; // grid not built yet (e.g. an early resize tick)
    ctx.fillStyle = SEAM_COLOR;
    for (let i = 0; i < N; i++) {
      const c = this.cells[i];
      if (!c) continue;
      const el = els[i];
      const col = i % COLS, row = (i / COLS) | 0;
      if (col < COLS - 1) {                                   // seam with the right neighbour
        const rn = this.cells[i + 1];
        const ea = rn && this.edgesFor(c), eb = rn && this.edgesFor(rn);
        if (ea && eb && edgeDiff(ea.right, eb.left) > SEAM_THRESH)
          ctx.fillRect(el.offsetLeft + el.offsetWidth + 0.5 - SEAM_W / 2, el.offsetTop, SEAM_W, el.offsetHeight);
      }
      if (row < ROWS - 1) {                                   // seam with the bottom neighbour
        const bn = this.cells[i + COLS];
        const ea = bn && this.edgesFor(c), eb = bn && this.edgesFor(bn);
        if (ea && eb && edgeDiff(ea.bottom, eb.top) > SEAM_THRESH)
          ctx.fillRect(el.offsetLeft, el.offsetTop + el.offsetHeight + 0.5 - SEAM_W / 2, el.offsetWidth, SEAM_W);
      }
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      // `cells` is the pre-slot store, a single pad — it loads into slot 1 so an existing palette survives.
      const s = JSON.parse(raw) as { pads?: (Cell | null)[][]; cells?: (Cell | null)[]; pad?: number; view?: View };
      const stored = Array.isArray(s.pads) ? s.pads : Array.isArray(s.cells) ? [s.cells] : [];
      for (let p = 0; p < PADS; p++) {
        const pad = stored[p];
        if (!Array.isArray(pad)) continue;
        for (let i = 0; i < N; i++) {
          const c = pad[i];
          this.pads[p][i] = c && typeof c.ref === 'string' ? { ref: c.ref, surface: typeof c.surface === 'number' ? c.surface : DEFAULT_SURFACE, rot: c.rot | 0, mirror: !!c.mirror } : null;
        }
      }
      if (Number.isInteger(s.pad) && s.pad! >= 0 && s.pad! < PADS) this.activePad = s.pad!;
      if (s.view === 'surface' || s.view === 'texture') this.view = s.view;
    } catch { /* ignore a corrupt / stale pad */ }
  }
  /** Persist every slot (not just the one on screen) and refresh the slot menu's counts — save() is called
   *  from each pad mutation, so the labels track what the slots hold. */
  private save() {
    this.syncPadSel();
    try { localStorage.setItem(KEY, JSON.stringify({ pads: this.pads, pad: this.activePad, view: this.view })); } catch { /* storage full / disabled */ }
  }
}

/** The four borders of an N×N ImageData as coarse RGB runs — each side's outer line (top/bottom left→right,
 *  left/right top→bottom) reduced to EDGE_BUCKETS segment-averages, so grain washes out but position stays. */
function extractEdges(d: Uint8ClampedArray, n: number): Edges {
  const top: number[] = [], bottom: number[] = [], left: number[] = [], right: number[] = [];
  const px = (x: number, y: number, out: number[]) => { const i = (y * n + x) * 4; out.push(d[i], d[i + 1], d[i + 2]); };
  for (let x = 0; x < n; x++) { px(x, 0, top); px(x, n - 1, bottom); }
  for (let y = 0; y < n; y++) { px(0, y, left); px(n - 1, y, right); }
  return { top: bucketize(top), right: bucketize(right), bottom: bucketize(bottom), left: bucketize(left) };
}
/** Average an n-sample RGB run into EDGE_BUCKETS segment-means (length EDGE_BUCKETS * 3). */
function bucketize(rgb: number[]): number[] {
  const n = rgb.length / 3, per = n / EDGE_BUCKETS, out: number[] = [];
  for (let k = 0; k < EDGE_BUCKETS; k++) {
    let r = 0, g = 0, b = 0, c = 0;
    for (let i = Math.floor(k * per); i < Math.floor((k + 1) * per); i++) { r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]; c++; }
    out.push(r / c, g / c, b / c);
  }
  return out;
}
/** Worst per-segment colour difference of two bucketed edges (each RGB triplet = one segment), 0..1.
 *  Taking the WORST segment, not the average, means a partial mismatch (edges agree at one end but step
 *  apart at the other) still scores high instead of being diluted by the matching segments. */
function edgeDiff(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let worst = 0;
  for (let i = 0; i + 2 < n; i += 3) { // one RGB segment at a time
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / (3 * 255);
    if (d > worst) worst = d;
  }
  return worst;
}
