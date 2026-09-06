// tier: fast

/**
 * The SSX Mod Manager ZIP -> Maps bridge: archive validation, inference, and the destructive-tool boundary.
 * The orchestration half uses a recording Snowknife double and a tiny fake ISO, so the normal gate proves
 * path/cleanup/publication behavior without requiring disc data or a built .NET checkout.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zipStoreOnly } from '../src/app/export/zip';
import {
  importModMap, inspectLevelModZip, parseImportModArgs, suggestedMapName,
  type SnowknifeCommandRunner,
} from '../scripts/import-mod-map';

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value);

async function fixtureZip(options: { missing?: string; traversal?: boolean; malformedInfo?: boolean } = {}): Promise<Buffer> {
  const stem = 'aloha';
  const names = [
    ...['adl', 'aip', 'ltg', 'map', 'pbd', 'sop', 'ssf', 'ssh'].map(extension => `${stem}.${extension}`),
    `${stem}_L.ssh`, `${stem}_sky.pbd`, `${stem}_sky.ssh`,
    // Twist'N'Turn carries a donor PIPE.BIG in this same directory. It must never become a nested BIG member.
    'ALOHA.BIG',
  ].filter(name => name.toLowerCase() !== options.missing?.toLowerCase());
  const files = [
    { path: 'ModInfo.json', bytes: bytes(options.malformedInfo ? '{"Name":"broken\nmetadata"}' : JSON.stringify({ Name: "Moloka'i Pa'Hee" })) },
    ...names.map((name, index) => ({ path: `data/models/${name}`, bytes: bytes(`native-${index}-${name}`) })),
    ...(options.traversal ? [{ path: 'data/models/../outside.bin', bytes: bytes('no') }] : []),
  ];
  return Buffer.from(await zipStoreOnly('fixture', files).arrayBuffer());
}

console.log('== ZIP inspection ==');
const inspected = inspectLevelModZip(await fixtureZip(), 'fixture.zip');
assert.equal(inspected.title, "Moloka'i Pa'Hee");
assert.equal(inspected.inferredSlot, 'ALOHA');
assert.equal(inspected.mapEntry, 'fixture/data/models/aloha.map');
assert.equal(inspected.members.length, 11);
assert(!inspected.members.some(member => member.name.toLowerCase().endsWith('.big')),
  'embedded donor BIGs are excluded from the rebuilt archive');
assert.equal(suggestedMapName(inspected.title), 'MOLOKAI_PAHEE');
const malformedInfo = inspectLevelModZip(await fixtureZip({ malformedInfo: true }), 'Twist-N-Turn.zip');
assert.equal(malformedInfo.title, 'Twist-N-Turn');
assert.match(malformedInfo.metadataWarning ?? '', /invalid optional ModInfo\.json/i);
const incomplete = await fixtureZip({ missing: 'aloha.pbd' });
// The reader accepts the legacy seven-character lightmap stem, but the main course set stays mandatory.
assert.throws(() => inspectLevelModZip(incomplete, 'incomplete.zip'), /incomplete.*aloha\.pbd/i);
assert.throws(() => inspectLevelModZip(new Uint8Array(Buffer.from('not a zip')), 'bad.zip'), /not a ZIP/i);
const traversal = await fixtureZip({ traversal: true });
assert.throws(() => inspectLevelModZip(traversal, 'unsafe.zip'), /invalid path/i);
console.log('PASS native members are inferred, bounded, CRC-checked, and donor BIGs are excluded');

console.log('\n== CLI arguments ==');
const parsed = parseImportModArgs([
  'course.zip', '--iso', 'tricky.iso', '--slot', 'aloha', '--name', 'ALOHA_HOLE', '--with-overrides',
]);
assert.equal(parsed.zipPath, resolve('course.zip'));
assert.equal(parsed.isoPath, resolve('tricky.iso'));
assert.equal(parsed.slot, 'aloha');
assert.equal(parsed.name, 'ALOHA_HOLE');
assert.equal(parsed.withOverrides, true);
const positional = parseImportModArgs(['course.zip', 'tricky.iso', 'aloha', 'ALOHA_HOLE']);
assert.equal(positional.isoPath, resolve('tricky.iso'));
assert.equal(positional.slot, 'aloha');
assert.equal(positional.name, 'ALOHA_HOLE');
assert.throws(() => parseImportModArgs(['course.zip']), /missing <clean-tricky\.iso>/i);
assert.throws(() => parseImportModArgs(['one.zip', 'tricky.iso', 'ALOHA', 'NAME', 'extra']), /unexpected extra/i);
console.log('PASS required inputs and options parse without a shell');

console.log('\n== import orchestration ==');
const root = await mkdtemp(join(tmpdir(), 'slopesmith-mod-import-test-'));
try {
  const maps = join(root, 'Maps');
  const work = join(root, 'temp');
  const zip = join(root, 'course.zip');
  const iso = join(root, 'clean.iso');
  await Promise.all([mkdir(maps), mkdir(work), writeFile(zip, await fixtureZip()), writeFile(iso, 'clean-disc')]);

  const calls: string[][] = [];
  let rejectEffects = false;
  let rejectSalvage = false;
  const runner: SnowknifeCommandRunner = async raw => {
    const args = [...raw];
    calls.push(args);
    if (args[0] === 'refpack') {
      await copyFile(args[1], args[2]);
    } else if (args[0] === 'big-create') {
      await writeFile(args[2], 'rebuilt-big');
    } else if (args[0] === 'iso-replace') {
      // The production Snowknife mutates args[1], which is asserted below to be the temporary copy.
    } else if (args[0] === 'effects-export') {
      if (rejectEffects && (!args.includes('--salvage-dangling-references') || rejectSalvage)) {
        throw new Error('invalid SSF fixture');
      }
      await writeFile(args[2], '{}\n');
    } else if (args[0] === 'import') {
      const staging = args[3];
      await mkdir(staging, { recursive: true });
      await Promise.all(['Patches.json', 'Instances.json', 'Models.json', 'Origin.json']
        .map(file => writeFile(join(staging, file), '{}\n')));
    } else throw new Error(`unexpected fake Snowknife command: ${args[0]}`);
  };

  const result = await importModMap({ zipPath: zip, isoPath: iso, name: 'MOD_ALOHA', mapsRoot: maps }, {
    runSnowknife: runner, tempRoot: work, log: () => undefined,
  });
  assert.equal(result.slot, 'ALOHA');
  assert.equal(result.destination, join(maps, 'MOD_ALOHA'));
  assert.equal((await readFile(join(result.destination, 'Patches.json'), 'utf8')).trim(), '{}');
  assert.equal(await readFile(iso, 'utf8'), 'clean-disc', 'the supplied ISO remains untouched');
  assert.equal(calls.filter(args => args[0] === 'refpack').length, 11);
  assert.deepEqual(calls.find(args => args[0] === 'big-create')?.slice(-2), ['c0fb', '--store']);
  const replace = calls.find(args => args[0] === 'iso-replace')!;
  assert.notEqual(resolve(replace[1]), resolve(iso), 'iso-replace targets only the temporary copy');
  assert.equal(replace[2], 'DATA\\MODELS\\ALOHA.BIG');
  assert(calls.find(args => args[0] === 'import')?.includes('--no-overrides'),
    'faithful imports suppress local remodel overlays by default');
  assert(calls.find(args => args[0] === 'import')?.includes('--repair-missing-map-links'),
    'third-party imports tolerate missing optional native name links');
  assert(calls.find(args => args[0] === 'import')?.includes('--allow-nonring-sky'),
    'third-party imports preserve custom non-ring skyboxes');
  assert.deepEqual(await readdir(work), [], 'the command removes its temporary ISO and BIG workspace');

  rejectEffects = true;
  const salvagedResult = await importModMap({
    zipPath: zip, isoPath: iso, name: 'MOD_SALVAGED_EFFECTS', mapsRoot: maps,
  }, { runSnowknife: runner, tempRoot: work, log: () => undefined });
  assert.equal(salvagedResult.destination, join(maps, 'MOD_SALVAGED_EFFECTS'));
  assert(calls.filter(args => args[0] === 'import').at(-1)?.includes('--salvage-effects'),
    'a failed strict SSF preflight retains valid effects through the audited salvage path');

  rejectSalvage = true;
  const invalidResult = await importModMap({
    zipPath: zip, isoPath: iso, name: 'MOD_INVALID_EFFECTS', mapsRoot: maps,
  }, { runSnowknife: runner, tempRoot: work, log: () => undefined });
  assert.equal(invalidResult.destination, join(maps, 'MOD_INVALID_EFFECTS'));
  assert(calls.filter(args => args[0] === 'import').at(-1)?.includes('--no-effects'),
    'a failed SSF preflight selects the explicit terrain/props-only import');
  await assert.rejects(importModMap({ zipPath: zip, isoPath: iso, name: 'MOD_ALOHA', mapsRoot: maps }, {
    runSnowknife: runner, tempRoot: work, log: () => undefined,
  }), /destination already exists/i);
  console.log('PASS imports stage atomically, preserve the source ISO, and refuse overwrites');
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
