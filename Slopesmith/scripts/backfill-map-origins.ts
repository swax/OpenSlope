/**
 * Write `Origin.json` into map folders that predate the contract.
 *
 *   npx tsx scripts/backfill-map-origins.ts --dry-run                    # the configured Maps library
 *   npx tsx scripts/backfill-map-origins.ts /path/to/Maps                # one or more explicit roots
 *   npx tsx scripts/backfill-map-origins.ts --force /path/to/Maps       # rewrite records already there
 *
 * Every consumer already reads an unmarked folder as retail (`readLevelOrigin`), so nothing is BROKEN without
 * this. What it fixes is the authored half: a mountain exported before the contract existed reads as retail
 * too, and the Reference picker's origin row says so until something states otherwise. Running this states it.
 *
 * The AUTHORED half of the classification is not reimplemented here. It IS `readLevelOrigin` — the same
 * function the listing asks — so a folder carrying an export manifest can never be written one answer and
 * read another.
 *
 * What this adds is evidence the reader does not bother with, because the reader does not have to write
 * anything down. `readLevelOrigin` resolves everything it cannot identify to plain "retail", which is the
 * right DEFAULT and the wrong thing to record as a finding: it would stamp `Origin: retail, Course: MOUNTAIN47`
 * onto an early authored export and make a guess look like provenance. So a folder with no manifest is asked
 * for proof of extraction — `World.json` naming its own slot, or the `SSFLogic.json` / `ConfigTricky.ssx` that
 * only a BIG unpack leaves behind — and one that offers none is written as unidentified rather than as a
 * course. Same reading in the picker; an honest record instead of an invented one.
 *
 * Existing records are left alone unless `--force`. A folder that already says what it is has been through a
 * current tool, and that tool knew things this script is inferring.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathExists } from '../src/server/fs-async';
import { listLevels, readLevelOrigin } from '../src/server/routes/levels';
import { forgetWorkspaceConfig, mapsRoot } from '../src/server/workspace-config';
import {
  MAP_ORIGIN_FILE, MAP_ORIGIN_SCHEMA, UNIDENTIFIED_FOLDER_REASON, normalizeMapOrigin, retailExtractOrigin,
  type MapOriginRecord,
} from '../src/core/export/origin';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const roots = args.filter(arg => !arg.startsWith('--')).map(arg => resolve(arg));

/** What one folder needs doing, decided before anything is written so a dry run is the real plan. */
interface Planned {
  level: string;
  record: MapOriginRecord;
  /** The record already on disk, when there is a readable one. */
  existing: MapOriginRecord | null;
  /** What settled it, for the report — the reader alone, or a file that proves an extraction. */
  evidence: string;
}

/**
 * Files only a `snowknife import` puts in a map folder.
 *
 * `SSFLogic.json` is written by the import for repack's SSF compile and by nothing else; `ConfigTricky.ssx`
 * and the `Models.json`/`Instances.json` pair come straight out of the BIG unpack. An authored export writes
 * canonical prop tables under the same two names, so those are checked only alongside a third — an export that
 * has `Models.json` never also has `ConfigTricky.ssx`.
 */
const EXTRACT_MARKERS = ['SSFLogic.json', 'ConfigTricky.ssx'];

/**
 * Proof that a folder is an extract, and of which course.
 *
 * `World.json` is the strong form: `snowknife import` writes the slot it read into it, so the answer is
 * recorded rather than inferred from a directory name somebody may have renamed. The markers are the weaker
 * form — they prove an extraction happened without naming it, and there the folder name is the best available
 * slot, which is exactly the assumption every other part of the pipeline already makes about a map folder.
 */
async function extractionEvidence(dir: string, level: string):
Promise<{ course: string; how: string } | null> {
  const world = await readJson(join(dir, 'World.json')) as { Course?: unknown } | null;
  if (typeof world?.Course === 'string' && world.Course.trim()) {
    return { course: world.Course.trim(), how: 'World.json' };
  }
  for (const marker of EXTRACT_MARKERS) {
    if (await pathExists(join(dir, marker))) return { course: level, how: marker };
  }
  return null;
}

/**
 * Read every level under `root` and decide its record.
 *
 * The root is applied by pointing the env override at it and dropping the config memo, so `listLevels` and
 * `readLevelOrigin` resolve beneath it exactly as the server would — rather than this script growing its own
 * parallel notion of where a map folder lives.
 */
async function planRoot(root: string): Promise<Planned[]> {
  process.env.SLOPESMITH_MAPS_ROOT = root;
  forgetWorkspaceConfig();
  const planned: Planned[] = [];
  for (const level of await listLevels()) {
    const dir = join(root, level);
    const existing = normalizeMapOrigin(await readJson(join(dir, MAP_ORIGIN_FILE)));
    const inferred = await readLevelOrigin(level);
    // An export manifest is its own evidence, and the reader has already used it. Only the folders it could
    // not identify — the ones it fell back to plain "retail" for — need looking at.
    if (inferred.Origin === 'slopesmith') {
      planned.push({ level, record: inferred, existing, evidence: 'Slopesmith.json' });
      continue;
    }
    const proof = await extractionEvidence(dir, level);
    planned.push({
      level, existing,
      evidence: proof?.how ?? 'nothing identifying',
      record: proof ? retailExtractOrigin(proof.course) : {
        Schema: MAP_ORIGIN_SCHEMA, Origin: 'retail', RetailData: true,
        Reasons: [UNIDENTIFIED_FOLDER_REASON],
      },
    });
  }
  return planned;
}

async function readJson(path: string): Promise<unknown> {
  if (!await pathExists(path)) return null;
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return null; }
}

/** One line per folder: what it was found to be, what settled it, and what is happening to it. */
function describe(plan: Planned): string {
  const what = plan.record.RetailData
    ? `${plan.record.Origin} · retail data (${plan.record.Reasons.join(', ')})`
    : `${plan.record.Origin} · no retail data`;
  const action = plan.existing && !FORCE ? 'kept' : plan.existing ? 'rewrote' : DRY ? 'would write' : 'wrote';
  return `  ${plan.level.padEnd(20)} ${action.padEnd(12)} ${what.padEnd(56)} ← ${plan.evidence}`;
}

if (!roots.length) roots.push(mapsRoot());

let written = 0;
let kept = 0;
let retail = 0;
const unidentified: string[] = [];
for (const root of roots) {
  if (!await pathExists(root)) {
    console.log(`\n${root}\n  (no such folder — skipped)`);
    continue;
  }
  const plan = await planRoot(root);
  console.log(`\n${root}  —  ${plan.length} level folder(s)`);
  if (!plan.length) {
    // Worth saying which, because "no levels" and "wrong root" look identical from a count of zero.
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    console.log(`  (nothing with a Patches.json; the folder holds ${entries.length} entr(y|ies))`);
    continue;
  }
  for (const item of plan) {
    console.log(describe(item));
    if (item.record.RetailData) retail++;
    if (item.record.Reasons.includes(UNIDENTIFIED_FOLDER_REASON)) unidentified.push(`${root} → ${item.level}`);
    if (item.existing && !FORCE) { kept++; continue; }
    if (!DRY) {
      await writeFile(join(root, item.level, MAP_ORIGIN_FILE),
        JSON.stringify(item.record, null, 2) + '\n', 'utf8');
    }
    written++;
  }
}

console.log(`\n${DRY ? 'would write' : 'wrote'} ${written}, kept ${kept} existing record(s).`);
console.log(`${retail} folder(s) carry retail data.`);
if (unidentified.length) {
  console.log(`\n${unidentified.length} folder(s) offered nothing to identify them — no export manifest and no`
    + ' trace of a BIG unpack. They are recorded as retail-because-unknown rather than as extracts, which is'
    + ' what they already read as. Re-export one to replace the record with its real answer:');
  for (const entry of unidentified) console.log(`  ${entry}`);
}
if (DRY) console.log('\n(dry run — nothing was written; re-run without --dry-run to apply)');
