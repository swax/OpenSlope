import type GUI from 'lil-gui';
import { orientCss } from '../../../core/paint/orientation';
import { DRAG_TILE } from '../../paint/drag-drop';
import { installStyles } from './styles';
import { tooltip } from './tooltip';

/**
 * The trail tile SET BUILDER (docs/023 · Textures): one of the mountain's own sets laid out as the 4×3 a path wears —
 * cap, trail, right turn, left turn, top to bottom; left lane, middle, right lane across, or a narrow set's two lanes —
 * in squares as large as the panel allows, packed edge to edge as the Palette's are, so a set reads as the trail it makes. Each square shows its
 * tile as a rider going along the path sees it. Tiles are dragged in from the Texture Library (or, with a square
 * selected, clicked there); a square dragged onto another swaps the two (⇧ copies); the selected square's tile turns
 * with ← / → and mirrors with ⇧ (or ↑ / ↓), the editor's one tile-turning gesture (shortcuts.ts); a ✕ clears a square, or takes a
 * cap or turn row off. A row the set has none of shows the trail row worn there, faded, and changing it gives the set
 * the row.
 */

/** One square's tile: its picture, its ref, and how it shows (`orientCss`). */
export interface BuilderTile { src: string; ref: string; view: { rot: number; mirror: boolean } }

/** One row of the set: its name and where it is worn, its tiles left to right (null for none), whether it is the
 *  trail row shown for want of its own, and whether it can be taken off. */
export interface BuilderRow {
  label: string;
  hint: string;
  tiles: readonly (BuilderTile | null)[];
  borrowed: boolean;
  removable: boolean;
}

/** A square: its row, and its column among the builder's `lanes`. */
export interface BuilderSquare { row: number; col: number }

export interface TileSetBuilderOptions {
  title: string;
  hint: string;
  /** Its columns, left to right: a wide set's three lanes, or a narrow one's two. */
  lanes: readonly ('left' | 'middle' | 'right')[];
  rows: readonly BuilderRow[];
  /** The selected square, which ← / → turn and a Library click fills. */
  focus: BuilderSquare | null;
  /** Whether the Texture Library is open for the builder. */
  libraryOpen: boolean;
  onFocus(square: BuilderSquare | null): void;
  /** A Library tile dropped on a square, with how it showed where it came from (a Palette drag carries it). */
  onDrop(square: BuilderSquare, tile: { ref: string; view?: { rot: number; mirror: boolean } }): void;
  /** A square dragged onto another: swapped, or with ⇧ copied. */
  onMove(from: BuilderSquare, to: BuilderSquare, copy: boolean): void;
  /** ← / → on the selected square: `turnD4`'s step. */
  onTurn(square: BuilderSquare, dir: 1 | -1, flip: boolean): void;
  onClear(square: BuilderSquare): void;
  onRemoveRow(row: number): void;
  onLibrary(): void;
  onCopy(): void;
}

/** A builder square being dragged: `{ row, col }`. */
const DRAG_SQUARE = 'application/x-ss-set-square';

const CSS = `
.lil-gui .lil-controller.sp-sb { display: block; height: auto; padding: 6px 0 8px; }
.sp-sb-head { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; }
.sp-sb-title { flex: 1 1 auto; min-width: 0; color: #d7e3f0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* lil-gui sizes every button to its row; the builder's are its own size */
.lil-gui .sp-sb .sp-sb-btn { flex: 0 0 auto; width: auto; height: auto; padding: 2px 7px; background: #15202c; border: 1px solid #2c3e50;
  border-radius: 4px; color: #b8c9d9; font: 11px/1.4 system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
.lil-gui .sp-sb .sp-sb-btn:hover { border-color: #6ee7a8; color: #eaf6ff; }
.lil-gui .sp-sb .sp-sb-btn.on { border-color: #ffc24d; color: #ffe2a0; background: #ffc24d14; }
/* squares packed edge to edge with a 1 px seam, as the Palette's, so the set reads as the trail it lays */
.sp-sb-grid { display: grid; gap: 1px; background: #1a2836; }
.sp-sb-lane { padding: 1px 0 2px; background: #101b26; color: #7f97ac; font-size: 9px; text-align: center; letter-spacing: .05em; }
.sp-sb-label { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
  background: #101b26; color: #8fa6ba; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; }
.sp-sb-label span { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; }
.lil-gui .sp-sb .sp-sb-label button { width: 14px; height: 14px; padding: 0; line-height: 12px; border-radius: 3px; background: #2a1c1ccc;
  border: 1px solid #6b3434; color: #f5cfcf; font-size: 9px; cursor: pointer; }
.sp-sb-sq { position: relative; aspect-ratio: 1; background: #0d1722; overflow: hidden; cursor: pointer; }
.sp-sb-sq.empty { outline: 1px dashed #2a3b4b; outline-offset: -1px; }
.sp-sb-sq:not(.empty) { cursor: grab; }
.sp-sb-sq:not(.empty):active { cursor: grabbing; }
.sp-sb-art { position: absolute; inset: 0; pointer-events: none; background-size: cover; }
.sp-sb-sq.borrowed .sp-sb-art { opacity: .32; }
/* hover and selection drawn on an overlay ABOVE the tile's art — an inset shadow on the square itself sits under it */
.sp-sb-sq::after { content: ''; position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.sp-sb-sq:hover::after, .sp-sb-sq.over::after { box-shadow: inset 0 0 0 2px #6ee7a8; }
.sp-sb-sq.sel::after { box-shadow: inset 0 0 0 3px #ffc24d, inset 0 0 18px 5px #ffc24dcc; }
.lil-gui .sp-sb .sp-sb-x { position: absolute; top: 2px; right: 2px; z-index: 2; width: 15px; height: 15px; padding: 0; line-height: 13px; text-align: center;
  border-radius: 3px; background: #2a1c1ccc; border: 1px solid #6b3434; color: #f5cfcf; font-size: 10px; cursor: pointer; display: none; }
.lil-gui .sp-sb .sp-sb-sq:hover .sp-sb-x { display: block; }
.sp-sb-hint { margin: 6px 0 0; color: #7f97ac; font-size: 11px; line-height: 1.35; }
`;

/** The builder showing now, for the arrow keys. */
let live: { el: HTMLElement; opts: TileSetBuilderOptions } | null = null;

/** ← / → (⇧, or ↑ / ↓, to mirror) on the builder's selected square — false when no builder is up with a tile selected, leaving
 *  the key to the rest of the editor. */
export function turnBuilderSquare(dir: 1 | -1, flip: boolean): boolean {
  if (!live?.el.isConnected || !live.opts.focus) return false;
  const { row, col } = live.opts.focus;
  if (!live.opts.rows[row]?.tiles[col]) return false;
  live.opts.onTurn(live.opts.focus, dir, flip);
  return true;
}

export function tileSetBuilder(g: GUI, opts: TileSetBuilderOptions): HTMLElement {
  installStyles('tile-set-builder', CSS);
  const block = document.createElement('div');
  block.className = 'lil-controller sp-gui-custom sp-sb';

  const head = document.createElement('div');
  head.className = 'sp-sb-head';
  const title = document.createElement('span');
  title.className = 'sp-sb-title';
  title.textContent = opts.title;
  tooltip(title, opts.hint);
  const button = (text: string, hint: string, act: () => void, on = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sp-sb-btn${on ? ' on' : ''}`;
    b.textContent = text;
    b.onclick = act;
    tooltip(b, hint);
    return b;
  };
  head.append(title,
    button(opts.libraryOpen ? '▦ close library' : '▦ texture library', opts.libraryOpen
      ? 'Close the Texture Library.'
      : 'Open the Texture Library below: drag its tiles onto the squares, or select a square and click a tile there.',
    opts.onLibrary, opts.libraryOpen),
    button('⧉ copy layout', 'Copy this set as it is written in the built-in sets — to paste, or to send as a preset.', opts.onCopy));

  const grid = document.createElement('div');
  grid.className = 'sp-sb-grid';
  grid.style.gridTemplateColumns = `16px repeat(${opts.lanes.length}, 1fr)`;
  grid.append(document.createElement('span'));
  for (const lane of opts.lanes) {
    const cap = document.createElement('span');
    cap.className = 'sp-sb-lane';
    cap.textContent = lane;
    grid.append(cap);
  }
  const squares: HTMLElement[][] = [];
  const select = (square: BuilderSquare | null) => {
    opts.focus = square;
    squares.forEach((row, r) => row.forEach((el, c) => el.classList.toggle('sel', !!square && square.row === r && square.col === c)));
    opts.onFocus(square);
  };
  opts.rows.forEach((row, r) => {
    const label = document.createElement('div');
    label.className = 'sp-sb-label';
    const words = document.createElement('span');
    words.textContent = row.label;
    label.append(words);
    tooltip(label, `${row.hint}${row.borrowed ? ' This set has none of its own: faded, its trail row is worn here.' : ''}`);
    if (row.removable) {
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.onclick = () => opts.onRemoveRow(r);
      tooltip(x, `Take the ${row.label} row off: the trail row is worn there.`);
      label.append(x);
    }
    grid.append(label);
    squares.push(row.tiles.map((tile, c) => {
      const square = { row: r, col: c };
      const el = document.createElement('div');
      el.className = `sp-sb-sq${tile ? '' : ' empty'}${row.borrowed ? ' borrowed' : ''}`
        + `${opts.focus?.row === r && opts.focus.col === c ? ' sel' : ''}`;
      if (tile) {
        const art = document.createElement('div');
        art.className = 'sp-sb-art';
        art.style.backgroundImage = `url(${tile.src})`;
        art.style.transform = orientCss(tile.view.rot, tile.view.mirror);
        el.append(art);
        el.draggable = true;
        el.ondragstart = e => {
          e.dataTransfer?.setData(DRAG_SQUARE, JSON.stringify(square));
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove';
        };
        if (!row.borrowed) {
          const x = document.createElement('button');
          x.type = 'button';
          x.className = 'sp-sb-x';
          x.textContent = '✕';
          x.onclick = e => { e.stopPropagation(); opts.onClear(square); };
          tooltip(x, 'Clear this square.');
          el.append(x);
        }
      }
      tooltip(el, `${row.label} · ${opts.lanes[c]}${tile ? ` · ${tile.ref}${tile.view.mirror ? ' (mirrored)' : ''}` : ' · none'}\n`
        + 'Click to select it — then ← / → turn its tile, ↑ / ↓ mirror it, and a Texture Library click fills it. Drag a tile '
        + 'here from the Library, or drag another square here to swap (⇧ copies).');
      el.onclick = () => select(opts.focus?.row === r && opts.focus.col === c ? null : square);
      const accepts = (e: DragEvent) => !!e.dataTransfer?.types.some(type => type === DRAG_SQUARE || type === DRAG_TILE);
      el.ondragover = e => {
        if (!accepts(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = e.shiftKey || e.dataTransfer.types.includes(DRAG_TILE) ? 'copy' : 'move';
      };
      el.ondragenter = e => { if (accepts(e)) el.classList.add('over'); };
      el.ondragleave = () => el.classList.remove('over');
      el.ondrop = e => {
        e.preventDefault();
        el.classList.remove('over');
        const dt = e.dataTransfer;
        if (!dt) return;
        try {
          const moved = dt.getData(DRAG_SQUARE);
          if (moved) {
            const from = JSON.parse(moved) as BuilderSquare;
            if (from.row !== r || from.col !== c) opts.onMove(from, square, e.shiftKey);
            return;
          }
          const dropped = dt.getData(DRAG_TILE);
          if (!dropped) return;
          const { ref, rot, mirror } = JSON.parse(dropped) as { ref: string; rot?: number; mirror?: boolean };
          if (ref) opts.onDrop(square, { ref, ...(rot !== undefined ? { view: { rot, mirror: !!mirror } } : {}) });
        } catch { /* a malformed payload drops nothing */ }
      };
      grid.append(el);
      return el;
    }));
  });

  const hint = document.createElement('p');
  hint.className = 'sp-sb-hint';
  hint.textContent = 'Drag tiles from the Texture Library onto the squares, or select a square and click a tile there. '
    + 'Drag a square onto another to swap them (⇧ copies). ← / → turn the selected tile, ↑ / ↓ mirror it.';
  block.append(head, grid, hint);
  g.$children.appendChild(block);
  live = { el: block, opts };
  return block;
}
