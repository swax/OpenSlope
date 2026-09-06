// tier: fast

/**
 * The persistent census cache: what makes a stored measurement still true, and what must invalidate it.
 *
 * Pricing a forty-mountain library reads every mesh, texture header and sound slot in it — about five seconds
 * and twenty thousand files. The cache turns that into a stat-only validation pass of the same files, which is
 * roughly nine times cheaper, and the whole trade rests on the fingerprint being exact. A fingerprint that
 * misses a change serves a wrong number forever, silently, which is worse than being slow.
 *
 * So what is pinned here is the invalidation boundary, in both directions:
 *
 *  - Every input the census parses is in the fingerprint — an in-place edit, an addition and a removal each
 *    move it, including in the nested audio banks that are easy to walk past.
 *  - Files the census does NOT read are out of it, so an unrelated lightmap re-bake does not re-price a
 *    mountain whose cost cannot have changed.
 *  - The ordering is by code point rather than locale, because a fingerprint that moves with the runtime's
 *    ICU would invalidate the whole library on a Node upgrade and would differ between two machines sharing
 *    a workspace.
 *
 * Run: tsx test/census-cache.test.ts
 */
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { censusFingerprint, readPersistentCensus, type CensusRecord } from '../src/server/census-cache';
import { censusFromTables } from '../src/core/reference/census';
import { check, failures } from './check';

const work = await mkdtemp(join(tmpdir(), 'slopesmith-census-cache-'));
const level = join(work, 'TESTMTN');
const cacheRoot = join(work, 'cache');

/** A map folder with one of everything the census reads, including a nested audio bank and a song. */
async function buildFolder(): Promise<void> {
  await mkdir(join(level, 'Meshes'), { recursive: true });
  await mkdir(join(level, 'Textures'), { recursive: true });
  await mkdir(join(level, 'Audio', 'SFX', 'testmtn1'), { recursive: true });
  await mkdir(join(level, 'Audio', 'Music', 'song1'), { recursive: true });
  await mkdir(join(level, 'Lightmaps'), { recursive: true });
  await writeFile(join(level, 'Patches.json'), '{"Patches":[]}');
  await writeFile(join(level, 'Models.json'), '{"Models":[]}');
  await writeFile(join(level, 'Meshes', '0.obj'), 'f 1 2 3\n');
  await writeFile(join(level, 'Textures', '0000.png'), 'not really a png');
  await writeFile(join(level, 'Audio', 'SFX', 'testmtn1', '034.wav'), 'RIFF');
  await writeFile(join(level, 'Audio', 'Music', 'song1', 'graph.json'), '{}');
  await writeFile(join(level, 'Lightmaps', '0.png'), 'lightmap');
}
await buildFolder();

const fingerprint = () => censusFingerprint(level);
const first = await fingerprint();

// ---- stability: the same folder must fingerprint the same, every time ---------------------------------------
check(first === await fingerprint(), 'the same folder hashes the same twice — otherwise the cache never hits');
check(/^[A-Za-z0-9_-]+$/.test(first), 'and the digest is filename-safe, because it IS the cache file name');

// ---- every input the census parses moves it ------------------------------------------------------------------
const moves = async (label: string, change: () => Promise<void>) => {
  const before = await fingerprint();
  await change();
  const after = await fingerprint();
  check(before !== after, label);
};

await moves('an in-place edit to a mesh moves the fingerprint — the triangle count could have changed',
  () => writeFile(join(level, 'Meshes', '0.obj'), 'f 1 2 3\nf 4 5 6\n'));
await moves('a mesh added beside it moves it, because the level now carries more geometry',
  () => writeFile(join(level, 'Meshes', '1.obj'), 'f 1 2 3\n'));
await moves('a mesh removed moves it too — a shrinking level must re-price, not keep its old total',
  () => rm(join(level, 'Meshes', '1.obj')));
await moves('a texture page added moves it: pages are the budget that runs out first',
  () => writeFile(join(level, 'Textures', '0001.png'), 'another'));
await moves('an edited patch table moves it', () => writeFile(join(level, 'Patches.json'), '{"Patches":[{}]}'));
await moves('a slot WAV added inside an audio BANK moves it — the nested walk is easy to get wrong',
  () => writeFile(join(level, 'Audio', 'SFX', 'testmtn1', '035.wav'), 'RIFF'));
await moves('a whole new audio bank moves it', async () => {
  await mkdir(join(level, 'Audio', 'SFX', 'crowd'), { recursive: true });
  await writeFile(join(level, 'Audio', 'SFX', 'crowd', '001.wav'), 'RIFF');
});
await moves('a renamed bank moves it even though its bytes are identical', async () => {
  await mkdir(join(level, 'Audio', 'SFX', 'crowd2'), { recursive: true });
  await writeFile(join(level, 'Audio', 'SFX', 'crowd2', '001.wav'), 'RIFF');
  await rm(join(level, 'Audio', 'SFX', 'crowd'), { recursive: true });
});
await moves('a second song moves it', async () => {
  await mkdir(join(level, 'Audio', 'Music', 'song2'), { recursive: true });
  await writeFile(join(level, 'Audio', 'Music', 'song2', 'graph.json'), '{}');
});
await moves('a re-export moves it: Slopesmith.json is the export date the row shows', async () => {
  await writeFile(join(level, 'Slopesmith.json'), '{"level":"TESTMTN"}');
});
await moves('and touching that sidecar alone moves it, because only its mtime carries the date', async () => {
  const later = new Date(Date.now() + 60_000);
  await utimes(join(level, 'Slopesmith.json'), later, later);
});

// ---- and things it does not read do NOT ------------------------------------------------------------------------
{
  const before = await fingerprint();
  await writeFile(join(level, 'Lightmaps', '0.png'), 'rebaked, and larger than it was');
  await writeFile(join(level, 'Lightmaps', '1.png'), 'a new one');
  check(before === await fingerprint(),
    'a lightmap re-bake does NOT move it — nothing the census counts can have changed, so re-pricing forty '
    + 'mountains over it would be pure waste');
}

// ---- an absent directory is not an empty one ---------------------------------------------------------------------
{
  await rm(join(level, 'Textures', '0000.png'));
  await rm(join(level, 'Textures', '0001.png'));
  const emptied = await fingerprint();
  await rm(join(level, 'Textures'), { recursive: true });
  check(emptied !== await fingerprint(),
    'an emptied Textures/ and a deleted one hash differently — they price the same but only one is a mistake');
  await mkdir(join(level, 'Textures'), { recursive: true });
}

// ---- the store: hit, miss, corruption, and the level it was filed under ---------------------------------------------
{
  const record = (name: string): CensusRecord => ({
    census: censusFromTables(name, {
      models: [], instances: [], materials: [], patches: [{}],
      meshTris: new Map(), textures: { pages: 1, texels: 4 },
    }),
    provenance: { course: null, laps: 1, showoffSeconds: 120, exported: null },
  });

  let builds = 0;
  const build = async () => { builds++; return record('TESTMTN'); };

  const miss = await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 1 && miss?.census.patches === 1, 'an unmeasured folder is built once');
  const hit = await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 1 && hit?.census.patches === 1, 'and the second read comes off disk without measuring again');

  await writeFile(join(level, 'Meshes', '0.obj'), 'f 1 2 3\nf 4 5 6\nf 7 8 9\n');
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 2, 'a changed input measures again rather than serving the stored answer');
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 2, '...and that new answer is itself stored');

  // A half-written or hand-edited entry must degrade to a rebuild, never to a crash or a wrong row.
  const stored = join(cacheRoot, 'TESTMTN', `${await fingerprint()}.json`);
  await writeFile(stored, '{"census":{"level":"TESTMTN"');
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 3, 'a corrupt entry is a miss, not a crash');

  await writeFile(stored, JSON.stringify({ census: record('SOMEONE_ELSE').census, provenance: {} }));
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 4, 'an entry naming a different level is refused — a cache must never answer for the wrong map');

  await writeFile(stored, JSON.stringify({ census: { level: 'TESTMTN' } }));
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 5, 'and so is one missing the shapes both readers index into');

  // The manual re-measure behind `?refresh=1`. It exists for the case the fingerprint cannot see — metadata
  // that does not describe the bytes — so the one thing it must do is measure when a VALID entry is sitting
  // there, which is the exact situation every other path treats as a hit.
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 5, 'a valid entry is still a hit right before the forced read');
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot, force: true });
  check(builds === 6, 'force measures over a valid entry — the whole point, since nothing else can');
  await readPersistentCensus('TESTMTN', level, build, { cacheRoot });
  check(builds === 6,
    '...and stores what it measured, so a re-measure costs the measurement once rather than turning the cache '
    + 'off for every read after it');

  // "Not a map" is asked of a folder nothing has priced — the level above already has a valid entry, and a
  // cache that ignored it to re-ask the question would be no cache at all.
  const notAMap = join(work, 'NOTAMAP');
  await mkdir(notAMap, { recursive: true });
  let asked = 0;
  const absent = await readPersistentCensus('NOTAMAP', notAMap,
    async () => { asked++; return null; }, { cacheRoot });
  check(absent === null && asked === 1, 'a folder that is not a map answers null');
  await readPersistentCensus('NOTAMAP', notAMap, async () => { asked++; return null; }, { cacheRoot });
  check(asked === 2,
    '...and stores nothing, so it is re-asked rather than remembered as an absence needing its own expiry');
}

await rm(work, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
