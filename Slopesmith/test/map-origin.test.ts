// tier: fast

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAP_ORIGIN_FILE,
  RETAIL_EXTRACT_REASON,
  UNCLASSIFIED_EXPORT_REASON,
  authoredOrigin,
  normalizeMapOrigin,
  originSummary,
  retailExtractOrigin,
} from '../src/core/export/origin';
import { SLOPESMITH_EXPORT_MANIFEST } from '../src/core/export/manifest';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { check, failures } from './check';
import { mapGame, mapGameLabel } from '../src/core/reference/map-game';

/**
 * `Origin.json` (docs/036): what a map folder is, and whether it carries retail bytes — the two facts the
 * Scene toolbox's origin row reads for the loaded reference.
 *
 * Two layers, in the order a wrong answer at each would matter. The classification is pure and is checked as
 * a value. The folder reader's FALLBACK is checked against real directories, because that is the rule that
 * decides what every map folder extracted before this contract existed is described as — and getting it
 * backwards would describe a whole library of extracts as authored. The listing the picker fetches is checked
 * last, since it is what the editor actually reads.
 */

const maps = mkdtempSync(join(tmpdir(), 'slopesmith-origin-maps-'));
const workspace = mkdtempSync(join(tmpdir(), 'slopesmith-origin-ws-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = workspace;
process.env.SLOPESMITH_MAPS_ROOT = maps;
forgetWorkspaceConfig();

/** A map folder as the reference layer recognises one: a Patches.json is what makes it a level at all. */
function mapFolder(name: string, files: Record<string, unknown>): void {
  const dir = join(maps, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Patches.json'), JSON.stringify({ Patches: [] }));
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(join(dir, file), JSON.stringify(body, null, 2));
  }
}

const named = (entries: unknown, name: string): { name: string; course?: string; retailData?: boolean } | undefined =>
  (Array.isArray(entries) ? entries : []).find(entry => entry?.name === name);

// ---- the four kinds of folder a Maps library can hold -------------------------------------------------
mapFolder('RETAILMAP', { [MAP_ORIGIN_FILE]: retailExtractOrigin('retailmap') });
mapFolder('AUTHORED', {
  [MAP_ORIGIN_FILE]: authoredOrigin({
    source: 'slopesmith-authored',
    publicDistribution: 'allowed',
    retailDerived: false,
    userSupplied: false,
    reasons: [],
  }),
});
// No Origin.json: the folder is identified as authored by its export manifest, and its provenance answers the
// second question. This is every mountain exported between the provenance guard and this contract.
mapFolder('BORROWED', {
  [SLOPESMITH_EXPORT_MANIFEST]: {
    schema: 1,
    kind: 'slopesmith-export',
    level: 'BORROWED',
    documentVersion: 1,
    textures: {},
    provenance: {
      source: 'slopesmith-authored',
      publicDistribution: 'blocked-retail-derived',
      retailDerived: true,
      userSupplied: false,
      reasons: ['retail-prop-art', 'retail-sky'],
    },
  },
});
// Nothing at all: an extract from before any of this existed.
mapFolder('LEGACY', {});

// ---- the classification, as a value ----------------------------------------------------------------
const extract = retailExtractOrigin('gari');
check(
  extract.Origin === 'retail' &&
    extract.Course === 'GARI' &&
    extract.RetailData &&
    extract.Reasons.length === 1 &&
    extract.Reasons[0] === RETAIL_EXTRACT_REASON,
  'an extract states the slot it came from and carries the single reason there is to carry',
);

const clean = authoredOrigin({
  source: 'slopesmith-authored',
  publicDistribution: 'allowed',
  retailDerived: false,
  userSupplied: false,
  reasons: [],
});
check(
  clean.Origin === 'slopesmith' && !clean.RetailData && clean.Reasons.length === 0 && !clean.Course,
  'an export of nothing but authored content is authored, clean, and names no slot',
);

const rights = authoredOrigin({
  source: 'slopesmith-authored',
  publicDistribution: 'rights-review-required',
  retailDerived: false,
  userSupplied: true,
  reasons: ['user-texture', 'user-music'],
});
check(
  !rights.RetailData && rights.Reasons.length === 0,
  "a mountain full of the author's own uploads carries no retail data — the user- reasons do not travel",
);

const borrowed = authoredOrigin({
  source: 'slopesmith-authored',
  publicDistribution: 'blocked-retail-derived',
  retailDerived: true,
  userSupplied: true,
  reasons: ['retail-sky', 'user-music'],
});
check(
  borrowed.Origin === 'slopesmith' && borrowed.RetailData && borrowed.Reasons.join() === 'retail-sky',
  'and one that borrows art is authored AND retail, which is the pair one boolean could not say',
);

check(
  normalizeMapOrigin(JSON.parse(JSON.stringify(extract)))?.Course === 'GARI',
  'a record survives the round trip through JSON it is written as',
);
check(
  normalizeMapOrigin({ ...extract, Schema: 'openslope-origin/v2' }) === null &&
    normalizeMapOrigin({ ...extract, Origin: 'somewhere-else' }) === null &&
    normalizeMapOrigin(null) === null,
  'a record from another schema, another vocabulary, or no record at all is not read as one',
);
check(
  normalizeMapOrigin({ ...extract, Reasons: [] }) === null &&
    normalizeMapOrigin({ ...clean, RetailData: false, Reasons: ['retail-sky'] }) === null,
  'and the two halves have to agree: retail data with no reason, or reasons with no retail data, is neither',
);

// The summary the picker lists by — and the origin row reads — carries the slot when the record names one.
check(
  originSummary('GARI', extract).course === 'GARI' && !('course' in originSummary('X', clean)),
  'the listing summary carries an extract’s course slot and omits it for an authored folder',
);

// ---- the folder reader, over real directories -------------------------------------------------------
const { readLevelOrigin, listLevelOrigins } = await import('../src/server/routes/levels');

check(
  (await readLevelOrigin('RETAILMAP')).RetailData && (await readLevelOrigin('RETAILMAP')).Origin === 'retail',
  'a folder with an Origin.json is taken at its word',
);
check(!(await readLevelOrigin('AUTHORED')).RetailData, 'including when the word is that it carries nothing borrowed');

const inferred = await readLevelOrigin('BORROWED');
check(
  inferred.Origin === 'slopesmith' && inferred.RetailData && inferred.Reasons.join() === 'retail-prop-art,retail-sky',
  'an export with no Origin.json is still authored, and its provenance block answers what is in it',
);

const legacy = await readLevelOrigin('LEGACY');
check(
  legacy.Origin === 'retail' && legacy.RetailData,
  'and an unmarked folder is read as retail — the direction that describes an extract as an extract',
);
check(
  (await readLevelOrigin('NO-SUCH-MAP')).RetailData,
  'a folder that cannot be read at all reads as retail too, for the same reason',
);

const listed = await listLevelOrigins();
check(
  listed.length === 4 &&
    named(listed, 'AUTHORED')?.retailData === false &&
    named(listed, 'LEGACY')?.retailData === true &&
    named(listed, 'RETAILMAP')?.course === 'RETAILMAP',
  'the listing carries each folder’s own answer, so the origin row says exactly what the folder recorded',
);

mapFolder('RENAMED', {
  [MAP_ORIGIN_FILE]: { ...retailExtractOrigin('MESA'), Game: 'ssx-3' },
  'Import.json': { Game: 'ssx', DisplayName: '  Source Mesa  ' },
});
mapFolder('SIDECAR', { 'Import.json': { Game: '1080-avalanche' } });
mapFolder('SSXOT_ER4_DAY', {});
mapFolder('GARI', {});
const sources = await listLevelOrigins();
const gameOf = (name: string) => sources.find(map => map.name === name)?.game;
check(gameOf('RENAMED') === 'ssx-3', 'explicit origin game wins over import metadata and folder/course names');
check(
  sources.find(map => map.name === 'RENAMED')?.displayName === 'Source Mesa',
  'import titles are trimmed and retained independently of folder and game identity',
);
check(gameOf('SIDECAR') === '1080-avalanche', 'a renamed legacy folder retains its import-sidecar game');
check(
  gameOf('SSXOT_ER4_DAY') === 'ssx-on-tour' && gameOf('GARI') === 'ssx-tricky',
  'known legacy course IDs supply missing games',
);
check(
  gameOf('AUTHORED') === 'slopesmith' && gameOf('LEGACY') === 'unknown',
  'authored and unidentified maps have separate groups',
);
check(
  normalizeMapOrigin({ ...extract, Game: ' SSX-3 ' })?.Game === 'ssx-3',
  'the origin reader retains and normalizes the game',
);
check(
  mapGame({ name: 'SSX3_PEAK1' }) === 'ssx-3' &&
    mapGame({ name: 'TRICKY_GARI' }) === 'ssx-tricky' &&
    mapGame({ name: 'SSX_SNOW' }) === 'ssx' &&
    mapGame({ name: 'AVALANCHE_CRS01_00' }) === '1080-avalanche' &&
    mapGame({ name: 'MADTRIX_TH_TAHOE' }) === 'jonny-moseley-mad-trix' &&
    mapGameLabel(mapGame({ name: 'renamed', game: 'future-game' })) === 'future-game',
  'all supported legacy prefixes and future explicit game IDs remain selectable',
);
check(
  (await listLevelOrigins(['SIDECAR'])).length === 1,
  'asset catalogues can request source metadata for only their own maps',
);

// A legacy export whose manifest predates the provenance guard says nothing about what it borrowed, and is
// read as though it borrowed something rather than as though it did not.
mapFolder('PREGUARD', {
  [SLOPESMITH_EXPORT_MANIFEST]: {
    schema: 1,
    kind: 'slopesmith-export',
    level: 'PREGUARD',
    documentVersion: 1,
    textures: {},
  },
});
const preguard = await readLevelOrigin('PREGUARD');
check(
  preguard.Origin === 'slopesmith' && preguard.RetailData && preguard.Reasons.join() === UNCLASSIFIED_EXPORT_REASON,
  'an export made before the provenance guard is authored but unclassified, which counts as carrying data',
);

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('map origin: all checks passed');
