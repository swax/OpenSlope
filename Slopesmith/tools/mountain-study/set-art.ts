/**
 * Trail tile sets drawn for the study sheets (docs/023 · Textures): a set as the 4×3 it is — its cap row at the top, as a
 * path's end is, then its trail row and its right and left turn rows — each tile as a rider going along the path sees it
 * (a cap's travelling out to the end), the way the Create Trail panel draws them; and a set or a row as a line to paste
 * into `TRAIL_TILE_SETS`. The sheets sit in `temp/`, beside `Maps/`, whose pictures they show.
 */
import type { TrailTileRow, TrailTileSet } from '../../src/core/doc/types';
import {
  TRAIL_TILE_ROW_WORDS, TRAIL_TILE_ROWS, trailTileRowLanes, trailTileRowLiteral, trailTileRowView, trailTileSetLiteral,
  trailTileSetRow,
} from '../../src/core/mesh/trail-textures';
import { orientCss } from '../../src/core/paint/orientation';

export const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

let source = (ref: string) => `../Maps/${esc(ref.slice(0, ref.indexOf('/')))}/Textures/${esc(ref.slice(ref.indexOf('/') + 1))}`;
/** Where the sheets' pictures come from — beside `Maps/`, from a sheet in `temp/`, unless set otherwise. */
export function setTileSource(src: (ref: string) => string) { source = src; }
/** A tile ref's picture. */
export const tileSrc = (ref: string) => source(ref);

/** One row's tiles left to right as a rider sees them — a narrow set's two, a wide one's three, a missing middle a hole
 *  — faded where the row is another's, worn for want of the set's own. */
export function rowHtml(row: TrailTileRow, faded = false, narrow = false): string {
  const tile = (which: 'left' | 'middle' | 'right') => {
    const ref = trailTileRowLanes(row).find(lane => lane.which === which)?.ref, view = trailTileRowView(row, which);
    return ref
      ? `<img src="${tileSrc(ref)}" alt="${esc(ref)}" title="${esc(`${ref}${view.mirror ? ' mirrored' : ''}`)}" style="transform: ${orientCss(view.rot, view.mirror)}">`
      : '<span class="hole" title="none"></span>';
  };
  const lanes = narrow ? ['left', 'right'] as const : ['left', 'middle', 'right'] as const;
  return `<div class="srow${faded ? ' faded' : ''}">${lanes.map(tile).join('')}</div>`;
}

/** A set as its 4×3, each row named, the rows it has none of faded. */
export function setHtml(set: TrailTileSet): string {
  return `<div class="set">${TRAIL_TILE_ROWS.map(key => {
    const { row, borrowed } = trailTileSetRow(set, key);
    return `<div class="sline"><span class="slabel">${TRAIL_TILE_ROW_WORDS[key]}${borrowed ? '<br><i>trail’s</i>' : ''}</span>${rowHtml(row, borrowed, set.narrow)}</div>`;
  }).join('')}</div>`;
}

/** A row as it is written in a set, and a set as the literal to paste into `TRAIL_TILE_SETS`. */
export const rowLiteral = trailTileRowLiteral;
export const setLiteral = trailTileSetLiteral;

/** The sheets' rules for a set. */
export const SET_CSS = `
  .set { display: flex; flex-direction: column; gap: 3px; }
  .sline { display: flex; align-items: center; gap: 6px; }
  .slabel { width: 62px; color: var(--dim); font-size: 11px; text-align: right; line-height: 1.2; }
  .slabel i { font-size: 10px; opacity: .8; }
  .srow { display: flex; gap: 1px; } .srow img, .srow .hole { width: 64px; height: 64px; display: block; }
  .srow .hole { border: 1px dashed var(--line); box-sizing: border-box; }
  .srow.faded { opacity: .3; }
  pre { margin: 6px 0 0; font-size: 11px; color: #cfe3f5; background: #0c1219; border-radius: 4px; padding: 6px; overflow-x: auto; }
`;
