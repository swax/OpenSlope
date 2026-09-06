/**
 * Census the extracted levels' own score-multiplier gems, so a from-scratch course can be strung the way the
 * shipped ones are rather than the way a loop happens to lay them out.
 *
 * Run: npx tsx tools/reference-study/ref-gems.ts [LEVEL ...]     (default: every extracted level that ships gems)
 *
 * A gem is a pass-through instance of a `Gem_TrickMultiplier_{YellowX2,OrangeX3,RedX5}_*` model
 * ([Trailmap: 390-pickups-and-race]); the tier is in the model name, so the census reads names rather than
 * chasing each instance's MainType-14 effect slot. Positions come back through the same raw→editor transform
 * the reference layer uses, and each gem is projected onto the level's own main course line to give it a
 * station — which is what makes two levels of different lengths comparable.
 *
 * The number worth taking away is not the count. It is whether the gems are spread or CLUSTERED: a course that
 * carpets its whole length at a fixed pitch is saying nothing about where the interesting ground is, and one
 * that spends them in short runs is pointing at something. The report gives both readings — gems per 100 m of
 * course, and the run structure once gems more than `GAP` apart are called separate runs.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeProps } from '../../src/core/reference/props';
import { editorFromRaw } from '../../src/core/reference/terrain';
import { readLevelProps } from '../../src/server/routes/props';
import { readLevelCourse, listLevels } from '../../src/server/routes/levels';
import { mapsRoot } from '../../src/server/workspace-config';
import type { V3 } from '../../src/core/doc/types';

/** Metres of course between two gems before they count as separate runs. A rider at 25 m/s covers 25 m a
 *  second, so gems further apart than this are never on screen together and cannot read as one string. */
const GAP = 40;

const TIERS: [string, number][] = [['YellowX2', 2], ['OrangeX3', 3], ['RedX5', 5]];

const args = process.argv.slice(2);
const levels = args.length ? args.map(a => a.toUpperCase()) : await listLevels();

interface Row { level: string; gems: number; tiers: Map<number, number>; course: number; runs: number[][] }
const rows: Row[] = [];

for (const level of levels) {
  let names: string[];
  try {
    const raw = JSON.parse(await readFile(join(mapsRoot(), level, 'Models.json'), 'utf8')) as
      { Models?: { ModelName?: string }[] };
    names = (raw.Models ?? []).map(m => m.ModelName ?? '');
  } catch { continue; }

  const tierOf = new Map<number, number>();
  names.forEach((name, i) => {
    const hit = TIERS.find(([tag]) => name.includes(`Gem_TrickMultiplier_${tag}`));
    if (hit) tierOf.set(i, hit[1]);
  });
  if (!tierOf.size) continue;

  const props = decodeProps(await readLevelProps(level));
  const gems: { pos: V3; tier: number }[] = [];
  for (const inst of props.instances) {
    const tier = tierOf.get(inst.model);
    if (tier === undefined) continue;
    gems.push({ pos: editorFromRaw(inst.loc), tier });
  }
  if (!gems.length) continue;

  // Station along the level's own main course line: nearest point on the polyline, by accumulated length.
  // `readLevelCourse` has already reconstructed its points into editor space; only the raw instance
  // positions need `editorFromRaw`.
  const line = ((await readLevelCourse(level))?.points ?? []) as V3[];
  const at: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    at.push(at[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][2] - line[i - 1][2]));
  }
  const courseLen = at[at.length - 1] ?? 0;
  const stationOf = (p: V3): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = (line[i][0] - p[0]) ** 2 + (line[i][2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = at[i]; }
    }
    return best;
  };

  const stations = line.length >= 2 ? gems.map(g => stationOf(g.pos)).sort((a, b) => a - b) : [];
  const runs: number[][] = [];
  for (const s of stations) {
    const last = runs[runs.length - 1];
    if (!last || s - last[last.length - 1] > GAP) runs.push([s]); else last.push(s);
  }

  const tiers = new Map<number, number>();
  for (const g of gems) tiers.set(g.tier, (tiers.get(g.tier) ?? 0) + 1);
  rows.push({ level, gems: gems.length, tiers, course: courseLen, runs });
}

if (!rows.length) {
  console.log('no extracted level here ships Gem_TrickMultiplier instances');
  process.exit(0);
}

console.log('  level      gems   x2/x3/x5      course   per 100 m   runs   gems/run   within a run');
for (const r of rows.sort((a, b) => b.gems - a.gems)) {
  const t = (n: number) => String(r.tiers.get(n) ?? 0).padStart(3);
  const per = r.course ? (r.gems * 100) / r.course : NaN;
  const sizes = r.runs.map(run => run.length);
  const inner: number[] = [];
  for (const run of r.runs) for (let i = 1; i < run.length; i++) inner.push(run[i] - run[i - 1]);
  inner.sort((a, b) => a - b);
  const med = inner.length ? inner[inner.length >> 1] : NaN;
  console.log(`  ${r.level.padEnd(9)} ${String(r.gems).padStart(5)}   ${t(2)}/${t(3)}/${t(5)}`
    + `   ${r.course.toFixed(0).padStart(6)} m`
    + `   ${Number.isFinite(per) ? per.toFixed(1).padStart(6) : '     —'}`
    + `   ${String(r.runs.length).padStart(4)}`
    + `   ${sizes.length ? (r.gems / sizes.length).toFixed(1).padStart(6) : '     —'}`
    + `   ${Number.isFinite(med) ? `${med.toFixed(1)} m median, ${inner[0].toFixed(1)}–${inner[inner.length - 1].toFixed(0)} m` : '—'}`);
}

console.log(`\n  runs are gems within ${GAP} m of the next along the course; a course that carpets its length`);
console.log('  shows one huge run, and one that spends them in strings shows many small ones.');

const all = rows.flatMap(r => r.runs.map(run => run.length));
const totalGems = rows.reduce((n, r) => n + r.gems, 0);
const totalCourse = rows.reduce((n, r) => n + r.course, 0);
console.log(`\n  across ${rows.length} level(s): ${totalGems} gems over ${totalCourse.toFixed(0)} m — `
  + `${((totalGems * 100) / Math.max(1, totalCourse)).toFixed(1)} per 100 m of course, `
  + `in ${all.length} runs of ${(totalGems / Math.max(1, all.length)).toFixed(1)} gems on average`);
const solo = all.filter(n => n === 1).length;
console.log(`  ${solo} of those runs (${((solo * 100) / Math.max(1, all.length)).toFixed(0)}%) are a single gem`);
