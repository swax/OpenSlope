/**
 * What a level costs: the prop, triangle and texture-page census.
 *
 *   npx tsx tools/prop-budget.ts                     # every extracted level under Maps/
 *   npx tsx tools/prop-budget.ts --project MY_PROJECT # what a workspace project spends, against that census
 *   npx tsx tools/prop-budget.ts --level MEGAPLE     # one level, with its heaviest models listed
 *
 * Three numbers decide whether a course can ship, and only one of them is the one authors talk about:
 *
 *  - **Instances.** Cheap on their own — the disc stores a transform and a model id — but every one is a
 *    placement somebody has to make, and they are what a level's density READS as.
 *  - **Baked triangles.** Retail instances: a shipped level references a few hundred models from thousands of
 *    placements. Slopesmith's export does not — it writes one model row, one mesh and one instance per
 *    placement — so an authored level's BAKED total is the geometry it carries, and the honest comparison is
 *    against retail's distinct-geometry column rather than its baked one.
 *  - **Texture pages.** The hard one. A repacked level's bank is a fixed list of pages — 127 to 216 across
 *    the retail levels — and every distinct tile a prop or a patch names claims one. Borrowed tiles ship
 *    verbatim; the author's own ship as appended pages and cost VRAM on top (docs/011). Pages, not
 *    megabytes, are what runs out first.
 *
 * The measurement is deliberately independent of the editor's prop pipeline: it reads the extracted JSON and
 * the mesh OBJs directly, so the census cannot drift with a decoder change and can be re-run against a fresh
 * extraction by anybody.
 *
 * The census itself lives in `core/reference/census` (the arithmetic) and `server/routes/census` (the read),
 * because the editor's Scene ▸ Reference comparison shows these same numbers. Measuring twice is how a tool
 * and a panel come to disagree about the size of a level; this file is the command line over that measurement,
 * plus the part only a CLI does — pricing a workspace project that has not been exported yet.
 */
import { readdir } from 'node:fs/promises';
import { mapsRoot } from '../src/server/workspace-config';
import { listProjects, openProject } from '../src/server/projects';
import { groupDefIndex } from '../src/server/routes/groups';
import { expandGroupProps } from '../src/core/reference/groups';
import { levelCensus } from '../src/server/routes/census';
import type { LevelCensus } from '../src/core/reference/census';
import type { PlacedProp, QuadMeshDoc } from '../src/core/doc/types';

// ---- arguments -----------------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const value = (name: string): string | null => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
};
const ONLY = value('level')?.toUpperCase() ?? null;
const PROJECT = value('project')?.toUpperCase() ?? null;
const FIND = value('find')?.toLowerCase() ?? null;
const JSON_OUT = argv.includes('--json');

// ---- what a project spends ---------------------------------------------------------------------------------

export interface ProjectSpend {
  project: string;
  props: number;
  bakedTris: number;
  /** Prop pages, as `<LEVEL>/<page>` — a page borrowed from two donor levels is two pages on the disc,
   *  because the combiner namespaces them per source (docs/011). */
  propPages: string[];
  terrainPages: string[];
  donors: string[];
  byModel: { level: string; name: string; placements: number; tris: number; baked: number; pages: string[] }[];
  unresolved: string[];
}

async function projectSpend(name: string, census: Map<string, LevelCensus>): Promise<ProjectSpend> {
  const manifest = (await listProjects()).find(project => project.name.toUpperCase() === name);
  if (!manifest) throw new Error(`no workspace project named "${name}"`);
  const doc = (await openProject(manifest.id)).document as QuadMeshDoc;
  // A group placement bakes as its member models (docs/015), so it is priced as them — the same expansion the
  // export does before it writes a vertex. Pricing the leader alone would silently drop half of an assembly.
  const listed: PlacedProp[] = doc.props ?? [];
  const defs = await groupDefIndex(new Set(listed.flatMap(p => (p.group ? [p.level] : []))));
  const props: PlacedProp[] = listed.flatMap(prop => {
    const def = prop.group ? defs.get(`${prop.level}:${prop.group}`) : undefined;
    return def ? expandGroupProps(prop, def) : [prop];
  });

  const byKey = new Map<string, { level: string; model: number; name: string; placements: number }>();
  for (const prop of props) {
    const key = `${prop.level}/${prop.model}`;
    const found = byKey.get(key);
    if (found) found.placements++;
    else byKey.set(key, { level: prop.level, model: prop.model, name: prop.name, placements: 1 });
  }

  const rows: ProjectSpend['byModel'] = [];
  const propPages = new Set<string>();
  const unresolved: string[] = [];
  let bakedTris = 0;
  for (const entry of byKey.values()) {
    const level = census.get(entry.level.toUpperCase());
    const cost = level?.costs.find(c => c.id === entry.model);
    if (!cost) {
      unresolved.push(`${entry.level}/${entry.name} (model ${entry.model})`);
      continue;
    }
    const pages = cost.pages.map(page => `${entry.level}/${page}`);
    for (const page of pages) propPages.add(page);
    bakedTris += cost.tris * entry.placements;
    rows.push({
      level: entry.level, name: cost.name, placements: entry.placements,
      tris: cost.tris, baked: cost.tris * entry.placements, pages,
    });
  }
  rows.sort((a, b) => b.baked - a.baked);

  const terrainPages = new Set<string>();
  for (const ref of Object.values(doc.quadTex ?? {})) if (ref) terrainPages.add(String(ref));

  return {
    project: manifest.name,
    props: props.length,
    bakedTris,
    propPages: [...propPages].sort(),
    terrainPages: [...terrainPages].sort(),
    donors: [...new Set(rows.map(r => r.level))].sort(),
    byModel: rows,
    unresolved,
  };
}

// ---- report ---------------------------------------------------------------------------------------------------

const n = (x: number) => x.toLocaleString('en-US');
const pad = (text: string, width: number, right = true) =>
  right ? text.padStart(width) : text.padEnd(width);

function printCensus(all: LevelCensus[]): void {
  const head = ['level', 'inst', 'vis', 'models', 'meshes', 'geom tris', 'baked tris', 'tris/inst',
    'pages', 'terr', 'prop', 'both', 'other', 'MB@1B'];
  const rows = all.map(c => [
    c.level,
    n(c.instances.total), n(c.instances.visible), n(c.models.placed), n(c.meshes),
    n(c.geomTris), n(c.bakedTris),
    c.instances.visible ? n(Math.round(c.bakedTris / c.instances.visible)) : '—',
    n(c.pages.onDisk), n(c.pages.terrain), n(c.pages.props), n(c.pages.shared), n(c.pages.unused),
    (c.pages.texels / 1024 / 1024).toFixed(2),
  ]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)));
  console.log(head.map((h, i) => pad(h, width[i], i > 0)).join('  '));
  for (const row of rows) console.log(row.map((cell, i) => pad(cell, width[i], i > 0)).join('  '));
  console.log('\n`other` is pages neither a patch nor a placed prop names — the shared 16-page crowd flipbook'
    + ' bank (cd00–cd15),\nparticle and pickup art. Every level carries 17–20 of them, so terrain and props'
    + ' get the bank minus that.');
}

function printLevelDetail(c: LevelCensus): void {
  console.log(`\n${c.level} — the twelve heaviest models, by what they cost baked:`);
  for (const cost of c.costs.slice(0, 12)) {
    console.log(`  ${pad(n(cost.instances * cost.tris), 9)}  ${pad(`${cost.instances}×`, 6)} `
      + `${pad(`${n(cost.tris)} tris`, 11)}  ${cost.name}  [${cost.pages.join(' ')}]`);
  }
  const modules = c.costs.filter(cost => cost.instances >= 20);
  const fromModules = modules.reduce((sum, cost) => sum + cost.instances, 0);
  console.log(`  ${modules.length} models are placed 20+ times and carry ${fromModules} of ${c.instances.visible} `
    + `visible instances (${((100 * fromModules) / c.instances.visible).toFixed(0)}%) — the repeated-module share`);
}

function printSpend(spend: ProjectSpend, all: LevelCensus[]): void {
  const retail = all.filter(c => c.retail);
  const band = (pick: (c: LevelCensus) => number) => {
    const values = retail.map(pick).sort((a, b) => a - b);
    return `${n(values[0])}–${n(values[values.length - 1])}`;
  };
  console.log(`\n${spend.project} — what its props spend`);
  console.log(`  ${n(spend.props)} placements          retail ships ${band(c => c.instances.visible)} visible`);
  // Against retail's GEOMETRY column: an authored export bakes one mesh per placement, so this is the level's
  // own geometry rather than the draw count an instancing renderer earns.
  console.log(`  ${n(spend.bakedTris)} baked triangles   retail levels carry ${band(c => c.geomTris)}`);
  console.log(`  ${n(spend.propPages.length)} prop pages + ${n(spend.terrainPages.length)} painted terrain pages`
    + `   retail banks hold ${band(c => c.pages.onDisk)} pages`);
  if (spend.donors.length) console.log(`  donor levels: ${spend.donors.join(', ')}`);
  if (spend.byModel.length) {
    console.log('\n  by model:');
    for (const row of spend.byModel) {
      console.log(`  ${pad(n(row.baked), 8)}  ${pad(`${row.placements}×`, 6)} ${pad(`${n(row.tris)} tris`, 10)}  `
        + `${row.level}/${row.name}`);
    }
  }
  if (spend.propPages.length) console.log(`\n  prop pages: ${spend.propPages.join(', ')}`);
  for (const missing of spend.unresolved) console.log(`  ⚠ unresolved model — ${missing}`);
}

// ---- main -----------------------------------------------------------------------------------------------------

const levels = (await readdir(mapsRoot(), { withFileTypes: true }))
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => !ONLY || name.toUpperCase() === ONLY)
  .sort();

const census: LevelCensus[] = [];
for (const level of levels) {
  const found = await levelCensus(level);
  if (found) census.push(found);
}
const retailFirst = [...census].sort((a, b) =>
  Number(b.retail) - Number(a.retail) || a.instances.visible - b.instances.visible);

if (JSON_OUT) {
  console.log(JSON.stringify({ census: retailFirst.map(({ costs, ...rest }) => rest) }, null, 2));
} else if (FIND) {
  // Choosing a kit is a budget decision, so the price is what a search returns: one copy's triangles and the
  // pages it drags in. A model wearing three pages is three slots of the level's bank whoever places it.
  console.log(`models matching "${FIND}" — per-copy cost\n`);
  const hits = census.flatMap(c => c.costs
    .filter(cost => cost.name.toLowerCase().includes(FIND))
    .map(cost => ({ level: c.level, cost })));
  hits.sort((a, b) => a.cost.tris - b.cost.tris);
  for (const { level, cost } of hits) {
    console.log(`  ${pad(n(cost.tris), 6)} tris  ${pad(`${cost.instances}× in level`, 16, false)} `
      + `${pad(`${cost.pages.length} page${cost.pages.length === 1 ? '' : 's'}`, 8, false)} `
      + `${level}/${cost.name}  [${cost.pages.join(' ')}]`);
  }
  if (!hits.length) console.log('  (none)');
} else {
  console.log(`Extracted levels under ${mapsRoot()} — the shipped courses first\n`);
  printCensus(retailFirst);
  if (ONLY && retailFirst.length === 1) printLevelDetail(retailFirst[0]);
}

if (PROJECT) {
  const byName = new Map(census.map(c => [c.level.toUpperCase(), c]));
  printSpend(await projectSpend(PROJECT, byName), census);
}
