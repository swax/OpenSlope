/**
 * Measure every GLB in a directory without touching the Custom bank.
 *
 *   npx tsx tools/prop-recipes/measure-models.ts tools/prop-recipes/props
 *   npx tsx tools/prop-recipes/measure-models.ts courses/europa/props/models
 *
 * This uses the same import and editor-space measurement path as authored-course placement tools, but saves
 * nothing, so it can never renumber a model already used by a project.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { glbPropDraft } from '../../src/server/props/import-glb';
import { measurePropDraft } from '../course-authoring/props';

const MODEL_ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, 'props'));

const rows: { name: string; long: number; wide: number; tall: number; tris: number }[] = [];
for (const file of (await readdir(MODEL_ROOT)).filter(f => f.toLowerCase().endsWith('.glb'))) {
  const path = join(MODEL_ROOT, file);
  const draft = await glbPropDraft(await readFile(path), { fileName: file });
  const m = measurePropDraft(draft);
  rows.push({
    name: file.replace(/\.glb$/i, ''),
    long: Math.max(m.size.x, m.size.z), wide: Math.min(m.size.x, m.size.z), tall: m.size.y, tris: m.tris,
  });
}

rows.sort((a, b) => b.tall - a.tall);
console.log('  model                    long     wide     tall     tris');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(22)} ${r.long.toFixed(1).padStart(6)} ${r.wide.toFixed(1).padStart(6)} `
    + `${r.tall.toFixed(1).padStart(8)} ${String(r.tris).padStart(8)}`);
}
console.log(`\n  ${rows.length} models in ${MODEL_ROOT}, `
  + `${rows.reduce((n, r) => n + r.tris, 0).toLocaleString()} triangles of distinct art`);
