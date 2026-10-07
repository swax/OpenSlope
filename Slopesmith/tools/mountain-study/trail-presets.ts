/**
 * The built-in trail tile sets (docs/023 · Textures) as a sheet to judge them by: each `TRAIL_TILE_SETS` entry as the
 * 4×3 a path wears — cap, trail, right turn, left turn, top to bottom, each tile as a rider going along the path sees
 * it (the cap's travelling out to the end, the end at the top) — and the line it is written as. A row the set has none
 * of is faded: the trail row is worn there. A two-lane path wears each row's left and right; three lanes and more the
 * middle between.
 *
 * Usage:
 *   npx tsx tools/mountain-study/trail-presets.ts            pictures from Maps/, for this machine
 *   npx tsx tools/mountain-study/trail-presets.ts --inline   pictures in the page, to open anywhere
 *
 * Writes `temp/trail-presets.html`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRAIL_TILE_SETS, trailTileSetId } from '../../src/core/mesh/trail-textures';
import { esc, SET_CSS, setHtml, setLiteral, setTileSource } from './set-art';
import { MAPS_DIR, tempFile } from './paths';

if (process.argv.includes('--inline')) {
  const inlined = new Map<string, string>();
  setTileSource(ref => {
    if (!inlined.has(ref)) {
      const [level, file] = [ref.slice(0, ref.indexOf('/')), ref.slice(ref.indexOf('/') + 1)];
      inlined.set(ref, `data:image/png;base64,${readFileSync(join(MAPS_DIR, level, 'Textures', file)).toString('base64')}`);
    }
    return inlined.get(ref)!;
  });
}

const levels = [...new Set(TRAIL_TILE_SETS.map(set => set.level))];
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trail presets</title>
<style>
  :root { color-scheme: dark; --bg: #0f151c; --panel: #16202b; --line: #2a3a4a; --text: #d7e3f0; --dim: #8fa6ba; --accent: #6ee7a8; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 28px 0 8px; } p { color: var(--dim); margin: 0 0 12px; max-width: 80ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .name { font-weight: 600; margin: 0 0 8px; } .kind { color: var(--accent); font-size: 12px; font-weight: 400; } .lmr { display: flex; gap: 1px; margin: 0 0 4px 68px; color: var(--dim); font-size: 10px; }
  .lmr span { width: 64px; text-align: center; }
  ${SET_CSS}
</style></head><body><main>
<h1>Trail presets</h1>
<p>Every built-in trail tile set, as the 4×3 a path wears (a narrow set 4×2, for two-lane paths): its cap row on a capped end (the end at the top), its trail
row along the path, and its rows through tight right and left turns — each tile as a rider going along the path sees
it. A faded row is one the set has none of: the trail row is worn there. Two lanes wear each row's left and right
tiles; three and more the middle between them. Hover a tile for its ref.</p>
${levels.map(level => `<h2>${esc(level)}</h2>
<div class="grid">${TRAIL_TILE_SETS.filter(set => set.level === level).map(set => `<div class="card">
  <div class="name">${esc(trailTileSetId(set))}${set.narrow ? ' <span class="kind">narrow</span>' : ''}</div>
  <div class="lmr">${(set.narrow ? ['left', 'right'] : ['left', 'middle', 'right']).map(lane => `<span>${lane}</span>`).join('')}</div>
  ${setHtml(set)}
  <pre>${esc(setLiteral(set))}</pre>
</div>`).join('\n')}</div>`).join('\n')}
</main></body></html>
`;
const sheet = tempFile('trail-presets.html');
writeFileSync(sheet, html);
console.log(`wrote ${sheet} — ${TRAIL_TILE_SETS.length} sets`);
