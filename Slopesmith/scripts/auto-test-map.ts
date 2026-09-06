/**
 * Export an auto-test fixture course, headless, for the ISO auto-test harness.
 *
 *   tsx scripts/auto-test-map.ts [outDir] [--fixture GOLD] [--authored-only]
 *
 * GOLD is the regression course — one cell per mechanism, selected out of AUTOTEST1, which is the catalogue
 * of everything hardware has demonstrated. AUTOTEST2 is the bench, where a question lives until a batch has
 * answered it. They are separate courses so a run of the demo comes back all-green or not at all, instead of
 * green rows and open rows the reader has to tell apart.
 *
 * Writes the level folder `snowknife repack` consumes, plus `autotest-plan.json` beside it: the join from
 * each variant to the native instance name the harness hashes to find the live entity. The plan is READ BACK
 * out of the export rather than predicted, so a change to the bake's group naming surfaces here as a
 * mismatch instead of silently pointing the harness at an instance that does not exist.
 *
 * The two flipbook tiles and the three audio-bench tones land in this fixture mountain's asset libraries under
 * reserved `zz-autotest-` names and are left there: the fixture is rebuilt constantly and re-encoding
 * identical 8x8 PNGs or 1 s sine bursts every run buys nothing. Delete them by hand if the Custom libraries
 * need to be clean.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  autoTestFixture, autoTestMountain, AUTO_TEST_NAME, type AutoTestCase,
} from '../src/core/collision/autotest';
import { CUSTOM_TEX_LEVEL, saveSharedCustomTexture } from '../src/server/routes/textures';
import { saveSharedCustomSound } from '../src/server/routes/sounds';
import { encodePng } from '../src/server/routes/png';
import { exportLevel } from '../src/server/routes/export';
import { createProject, listProjects, openProject, saveProject } from '../src/server/projects';
import { validateEffectsAuthoring } from '../src/core/effects/authoring';
import type { EffectsDocument } from '../src/core/effects/document';
import type { PlacedProp, Rail } from '../src/core/doc/types';
import { mapsRoot } from '../src/server/workspace-config';
import { defaultMountain } from '../src/core/doc/mountain';
import { migrateLegacyProjectAssets } from '../src/server/project-assets';
import { importGlbFile } from '../src/server/props/import-glb';
import { listImportedProps, saveImportedProp } from '../src/server/routes/imported-props';

let temporaryAssets = '';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SNOW_GUN_GLB = join(SCRIPT_DIR, '..', 'tools', 'prop-recipes', 'props', 'SnowGun.glb');

/**
 * Clip fixtures need a model carrying real keyframes. Seed the current mountain's catalogue from the
 * committed, reproducible SnowGun GLB instead of depending on a developer's ignored `Maps/Custom` record.
 * The catalogue owns model numbers, so callers pass the number allocated here into the fixture builder.
 */
async function ensureClipModel(cases: readonly AutoTestCase[]): Promise<number | null> {
  if (!cases.some(test => test.shape === 'clip' || test.companionShape === 'clip')) return null;
  const existing = (await listImportedProps()).find(({ record }) => record.name === 'SnowGun'
    && record.tris === 190 && record.animation?.clipFrames === 40);
  if (existing) return existing.record.id;
  const record = await importGlbFile(SNOW_GUN_GLB);
  const saved = await saveImportedProp('SnowGun', record);
  console.log(`Imported bundled SnowGun clip model as catalogue model ${saved.record.id}.`);
  return saved.record.id;
}

/**
 * A plain sine burst, stored under a reserved name so a rebuild reuses it instead of leaving `_2`, `_3` …
 *
 * 22.05 kHz because that is the ceiling every retail course-bank sound sits at or under, and because the
 * fixture's own bank has to stay a believable size — the point of these cells is the engine's behaviour, not
 * how much sound RAM a test course can spend. A short clip also keeps the loop honest: a bed that only sounds
 * right because it is long enough never to wrap would hide the exact defect these cells exist to catch.
 */
async function tone(name: string, hz: number, seconds: number): Promise<{ file: string; hz: number }> {
  const rate = 22050;
  const frames = Math.round(rate * seconds);
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    // Fade the first and last 5 ms so a wrap does not click; the clip is judged by a memory read, but an
    // audible seam would make the same fixture useless for listening to.
    const edge = Math.min(1, i / (rate * 0.005), (frames - 1 - i) / (rate * 0.005));
    pcm.writeInt16LE(Math.round(12000 * edge * Math.sin(2 * Math.PI * hz * i / rate)), i * 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
  return { file: await saveSharedCustomSound(name, wav), hz };
}

/** A flat 8x8 tile. The colours only have to differ so the two frames are distinguishable in a memory read;
 *  nothing about this fixture is judged by eye. */
async function tile(name: string, rgb: [number, number, number]): Promise<string> {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255;
  }
  return saveSharedCustomTexture(name, encodePng({ w: 8, h: 8, data }));
}

/**
 * Land the fixture in the workspace as an ordinary editable project, so an auto-test run can be opened and
 * looked at rather than only inferred from a verdict table. This is the lab: every cell that has been proven
 * on hardware is a working demonstration you can select, inspect and copy out of.
 *
 * Created once and SAVED thereafter. `createProject` stores under a free name, so calling it every run would
 * leave AUTOTEST1_2, _3, _4 … behind and the one you opened would never be the one that just rode.
 *
 * The publish is then READ BACK and validated, because "the write succeeded" is a much weaker claim than
 * "this opens". The editor loads a project through `openProject`, so that is what runs here, and the
 * document it hands back is put through the same authoring validator the effects editor shows issues from.
 * A fixture that packs into an ISO but throws when opened would otherwise be discovered by hand.
 */
async function publishProject(doc: unknown, name: string): Promise<string> {
  const existing = (await listProjects()).find(project => project.name.toUpperCase() === name);
  const snapshot = existing
    ? await saveProject(existing.id, existing.revision, doc)
    : await createProject(doc);
  const opened = await openProject(snapshot.project.id);
  const reopened = opened.document as {
    props?: PlacedProp[]; models?: unknown[]; effects?: EffectsDocument; rails?: Rail[];
  };
  const issues = reopened.effects
    ? validateEffectsAuthoring(reopened.effects, reopened.props ?? [], reopened.rails ?? [])
      .filter(issue => issue.severity === 'error')
    : [{ path: '$.effects', message: 'the reopened project carries no effects document' }];
  if (issues.length) {
    throw new Error(`"${snapshot.project.name}" does not reopen cleanly:\n  `
      + issues.map(issue => `${issue.path}: ${issue.message}`).join('\n  '));
  }
  const what = `${reopened.props?.length ?? 0} prop(s), ${reopened.models?.length ?? 0} model(s), `
    + `${reopened.effects?.graphs.length ?? 0} graph(s)`;
  return `${existing ? 'updated' : 'created'} workspace project "${snapshot.project.name}"`
    + ` (revision ${snapshot.project.revision}); reopens clean with ${what}`;
}

async function main(): Promise<number> {
  const flagged = process.argv.indexOf('--fixture');
  const fixture = autoTestFixture(flagged >= 0 ? process.argv[flagged + 1] ?? AUTO_TEST_NAME : AUTO_TEST_NAME);
  const positional = process.argv.slice(2).find(arg => !arg.startsWith('--') && arg !== fixture.name);
  const outDir = positional || join(mapsRoot(), fixture.name);
  const authoredOnly = process.argv.includes('--authored-only');
  const cases = authoredOnly
    ? fixture.cases.filter(test => !['bag', 'gem', 'clip'].includes(test.shape) && !test.companionShape)
    : fixture.cases;
  if (process.argv.includes('--no-project')) {
    temporaryAssets = mkdtempSync(join(tmpdir(), 'slopesmith-autotest-assets-'));
    process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = temporaryAssets;
  } else {
    const existing = (await listProjects()).find(project => project.name.toUpperCase() === fixture.name);
    const project = existing ? await openProject(existing.id)
      : await createProject({ ...defaultMountain(), name: fixture.name });
    await migrateLegacyProjectAssets(project);
    process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = join(project.project.folder, 'assets');
  }
  console.log(`${fixture.name}: ${fixture.purpose}`);
  if (authoredOnly) {
    console.log(`Authored-only export: kept ${cases.length} case(s), omitted ${fixture.cases.length - cases.length} `
      + 'that require retail or imported models.');
  }
  const rest = await tile('zz-autotest-rest.png', [40, 40, 40]);
  const frame = await tile('zz-autotest-frame.png', [230, 30, 30]);
  // Three distinguishable pitches, so a run can also be listened to: the bed low, the gated one a fifth up,
  // the impact an octave above that.
  const ambientTones = {
    loop: await tone('zz-autotest-loop.wav', 220, 1.0),
    gated: await tone('zz-autotest-gated.wav', 330, 1.0),
    hit: await tone('zz-autotest-hit.wav', 660, 0.25),
  };
  const clipModel = await ensureClipModel(cases);

  const { doc, plan } = autoTestMountain({
    name: fixture.name, cases, mode: fixture.mode, strips: fixture.strips,
    ...(clipModel === null ? {} : { clipModel }),
    ...(fixture.leadInM === undefined ? {} : { leadInM: fixture.leadInM }),
    ...(fixture.windowFrames === undefined ? {} : { windowFrames: fixture.windowFrames }),
    flipbookTiles: { rest: `${CUSTOM_TEX_LEVEL}/${rest}`, frame: `${CUSTOM_TEX_LEVEL}/${frame}` },
    ambientTones,
    // The explicit flag adds per-contact banners to ordinary fixtures. A fixture carrying independent
    // stageMessage triggers records that requirement in its plan, and run.py enables the patch itself.
    hudText: process.argv.includes('--hud-text'),
  });

  const result = await exportLevel(doc as never, { outDir, lighting: false });
  console.log(result.log);
  let publishFailed = false;
  if (!process.argv.includes('--no-project')) {
    try {
      console.log(await publishProject(doc, fixture.name));
    } catch (error) {
      // Loud but not fatal. The ISO does not depend on the workspace copy, and a harness pass that stopped
      // here would cost a 2.9 GB rebuild over a copy that is only there to be looked at — but a lab you
      // cannot open is a broken deliverable, so it fails the script's exit code rather than scrolling past.
      console.error(`FAIL: could not publish the workspace project — ${(error as Error).message}`);
      publishFailed = true;
    }
  }

  // The authoritative variant -> instance join. `bakedGroups` is what the packer itself compiles effect
  // attachments through, and canonical export copies the group name verbatim into InstanceName.
  const effects = JSON.parse(readFileSync(join(outDir, 'Effects.json'), 'utf8'));
  const baked = effects.extensions?.slopesmith?.bakedGroups ?? {};
  const instances: { InstanceName: string; Location: [number, number, number] }[] = JSON.parse(
    readFileSync(join(outDir, 'Instances.json'), 'utf8')).Instances ?? [];
  const known = new Map(instances.map(item => [item.InstanceName, item.Location]));

  let mismatches = 0;
  for (const entry of plan.entries) {
    const actual = baked[entry.propId]?.[0];
    if (typeof actual !== 'string' || !actual) {
      console.error(`FAIL ${entry.id}: the export has no baked group for ${entry.propId}`);
      mismatches++;
      continue;
    }
    entry.instanceName = actual;
    // An imported placement's group is named from the CATALOGUE model rather than from the placement — several
    // cells share one record, and `Import_<n>_` is what separates them — so for those the family is what there
    // is to check. Every other family this fixture uses is named from something it authored per cell, and
    // there the authored suffix must be present: it is what catches a case wired to the wrong baker.
    const named = entry.imported
      ? /^Import(Solid)?_\d+_.+$/.test(actual)
      : actual.endsWith(`_${entry.propName}`);
    if (!named) {
      console.error(`FAIL ${entry.id}: ${actual} is not the ${entry.imported ? 'imported-catalogue' : 'authored'} `
        + `name this case should have baked (${entry.imported ? 'Import_<n>_<model>' : entry.propName})`);
      mismatches++;
    }
    const location = known.get(actual);
    if (!location) {
      console.error(`FAIL ${entry.id}: ${actual} is not in Instances.json`);
      mismatches++;
    } else entry.location = location;
  }
  // The emitter -> event-id join, read back for the same reason the instance names are: a CUSTOM clip is
  // allocated a reserved id by the export, so predicting it here would mean the probe grades whichever
  // emitter happens to hold that id rather than the one this cell placed.
  const ambientJoin = effects.extensions?.slopesmith?.ambientSounds ?? {};
  const collisionJoin = effects.extensions?.slopesmith?.collisionSounds ?? {};
  for (const item of plan.audio ?? []) {
    // A one-shot rides the COLLISION join; everything else rides the emitter one. Same reason either way:
    // the id is allocated by the export, so reading it back is the only way the plan can name the thing the
    // disc actually carries.
    const found = item.expect === 'one-shot' ? collisionJoin[item.propId] : ambientJoin[item.propId]?.event;
    if (typeof found !== 'number') {
      console.error(`FAIL ${item.id}: the export placed no ${item.expect === 'one-shot' ? 'collision sound'
        : 'ambient emitter'} for ${item.propId}`);
      mismatches++;
      continue;
    }
    item.event = found;
  }
  const events = (plan.audio ?? []).map(item => item.event).filter(event => event !== null);
  if (new Set(events).size !== events.length) {
    // The runtime refuses to start a second voice for an id already sounding, so a duplicate would leave one
    // cell dark for a reason that has nothing to do with what it was built to ask.
    console.error('FAIL: two emitter cells were allocated the same event id');
    mismatches++;
  }

  const names = new Set(plan.entries.map(entry => entry.instanceName));
  if (names.size !== plan.entries.length) {
    // The harness finds a cell by hashing this name, so two cells sharing one is not a cosmetic clash.
    console.error('FAIL: two variants baked to the same instance name');
    mismatches++;
  }

  // Every case must present its span ACROSS the fall line. Authored yaw is applied in raw space, so a
  // change of rotation convention would quietly turn each panel edge-on to the descent: the rider would
  // stream past a 120 m gate through the gap beside it, and every cell would report a truthful
  // "crossed-without-firing" about a contact that was never offered. This is the whole fixture's premise,
  // so it is asserted rather than assumed. The fall line is measured from the plan's own cells instead of
  // a hardcoded axis mapping.
  const props = readFileSync(join(outDir, 'Props.obj'), 'utf8');
  const byGroup = new Map<string, number[][]>();
  let current: number[][] | null = null;
  for (const line of props.split('\n')) {
    if (line.startsWith('o ')) byGroup.set(line.slice(2).trim(), current = []);
    else if (line.startsWith('v ') && current)
      current.push(line.trim().split(/\s+/).slice(1, 4).map(Number));
  }
  const first = plan.entries[0]?.location, second = plan.entries[1]?.location;
  if (first && second) {
    const run = Math.hypot(second[0] - first[0], second[1] - first[1]) || 1;
    const fall = [(second[0] - first[0]) / run, (second[1] - first[1]) / run];
    for (const entry of plan.entries) {
      // Waived only where the cell says its claim does not come from contact. A persistent node installs
      // ahead of the rider whether or not they touch anything, so a cell judged on that node's own state
      // loses nothing by being narrow — and the cells that ask for this borrow a retail model for its
      // keyframes and inherit whatever bounding box it shipped with.
      if (entry.contactOptional) continue;
      const group = [...byGroup].find(([name]) => name.endsWith(`_${entry.instanceName}`))?.[1];
      if (!group?.length) continue;
      let span = [0, 0], best = 0;
      for (let i = 0; i < group.length; i++) for (let k = i + 1; k < group.length; k++) {
        const d = [group[k][0] - group[i][0], group[k][1] - group[i][1]];
        const m = Math.hypot(d[0], d[1]);
        if (m > best) { best = m; span = d; }
      }
      const across = Math.abs(span[0] * fall[1] - span[1] * fall[0]);
      const along = Math.abs(span[0] * fall[0] + span[1] * fall[1]);
      if (across <= along) {
        console.error(`FAIL ${entry.id}: lies ALONG the fall line (across ${across.toFixed(0)},`
          + ` along ${along.toFixed(0)}) — the rider can pass beside it`);
        mismatches++;
      }
    }
  }

  const planPath = join(outDir, 'autotest-plan.json');
  writeFileSync(planPath, JSON.stringify({ ...plan, exportDir: outDir }, null, 1) + '\n');
  console.log(`\n${plan.entries.length} variant(s) -> ${planPath}`);
  for (const entry of plan.entries)
    console.log(`  ${entry.id.padEnd(22)} ${String(entry.distanceM).padStart(5)} m  mode ${entry.mode}  ${entry.instanceName}`);
  for (const strip of plan.strips ?? [])
    console.log(`  strip ${strip.label.padEnd(16)} ${String(strip.fromM).padStart(5)}-${strip.toM} m  Surf_${strip.surface}`);
  if (!existsSync(join(outDir, 'Props.obj'))) { console.error('FAIL: the export wrote no Props.obj'); mismatches++; }
  if (publishFailed) mismatches++;
  return mismatches ? 1 : 0;
}

main().then(code => process.exitCode = code, error => { console.error(error); process.exitCode = 1; })
  .finally(() => { if (temporaryAssets) rmSync(temporaryAssets, { recursive: true, force: true }); });
