import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { LevelCensus, MountainProvenance } from '../core/reference/census';
import { ensureWorkspace } from './workspace-config';
import {
  fileStamp, listEntries, listSubdirectories, mapLimit, pathExists, readTextOrNull, writeFileAtomic,
  READ_CONCURRENCY,
} from './fs-async';
import { createLogger } from './log';

const log = createLogger('census-cache');

/**
 * Persist what each mountain costs, so the comparison is paid for once rather than once per server start.
 *
 * Pricing the whole library reads every mesh, every texture header and every sound slot in it — about 3.8 s
 * and 22,000 files across a forty-mountain library. `responseCache` already makes that free WITHIN a run;
 * this makes it free across runs, which is the case that actually bites, because the answer is wanted a few
 * seconds after a restart and almost nothing under `Maps/` changed while the server was down.
 *
 * The saving is real because validating is not measuring: stamping those same 22,000 files takes ~0.5 s
 * against ~3.8 s to open and parse them. Size, nanosecond mtime, ctime and relative name catch an in-place
 * edit as well as an addition or a removal, so a re-extraction or a re-export re-prices exactly the mountains
 * it touched and no others.
 *
 * Cache files live under the workspace, never inside the map library — the library is somebody's extracted
 * disc and nothing here writes to it.
 */

/**
 * BUMP THIS whenever the census arithmetic or the stored record changes shape.
 *
 * Nothing else can notice: the fingerprint proves the INPUT FILES are unchanged, which is exactly the
 * situation in which a stale entry would be served forever after a change to how those files are counted.
 * `core/reference/census.ts` carries a pointer back here for the same reason.
 */
const CENSUS_CACHE_SCHEMA = 2; // 2: Aloha Ice Jam and Untracked joined RETAIL_LEVELS, so stored `retail` flags moved

/** One priced mountain, as it is stored and as both readers want it: the census, plus the facts about the
 *  folder that are not a count of anything in it (its course, its race, its export date). */
export interface CensusRecord {
  census: LevelCensus;
  provenance: MountainProvenance;
}

/** Every file the census opens. A directory it walks is listed here rather than probed, so a fingerprint
 *  covers exactly the inputs — walking the rest of the folder (lightmaps, collision, glTF, the skybox) would
 *  cost stats without making the answer any more correct. */
const TOP_LEVEL_INPUTS = [
  // priced directly
  'Patches.json', 'Models.json', 'Instances.json', 'Materials.json',
  'Lights.json', 'ParticleInstances.json', 'Splines.json',
  // the recovered course line, and the export date
  'AIP.json', 'SOP.json', 'Slopesmith.json',
  // the collision-sound index is not counted, but the folder's own race table is read beside it
  join('Audio', 'SoundIndex.json'),
] as const;

/**
 * A metadata fingerprint over the census's inputs.
 *
 * The stats are gathered concurrently but folded into the hash in a fixed order, because a fingerprint that
 * depended on completion order would change between runs over identical data and defeat the cache.
 */
export async function censusFingerprint(levelDir: string): Promise<string> {
  const root = resolve(levelDir);
  const hash = createHash('sha256');
  hash.update(`slopesmith-census:${CENSUS_CACHE_SCHEMA}\n`);
  hash.update(process.platform === 'win32' ? root.toLowerCase() : root).update('\n');

  const png = (file: string) => file.toLowerCase().endsWith('.png');
  const obj = (file: string) => file.toLowerCase().endsWith('.obj');
  const slotWav = (file: string) => /^\d+\.wav$/i.test(file);
  const graph = (file: string) => file.toLowerCase() === 'graph.json';

  // Two listing phases, each fully concurrent, because a level's audio banks are only discoverable once its
  // Audio/SFX folder has been read. Everything after that is ONE flat stat pass: doing it per directory left
  // a big level waiting through twenty round trips, and libuv serves these from a four-thread pool, so idle
  // gaps between phases cost more than the stats themselves.
  const shapes: string[] = [];
  const listing = async (name: string, accept: (file: string) => boolean): Promise<string[]> => {
    const dir = join(root, name);
    // An absent directory and an empty one are distinct inputs: a deleted Meshes/ must not hash the same as
    // an emptied one, because the two price differently and only one of them is a mistake.
    if (!await pathExists(dir)) { shapes.push(`${name.replace(/\\/g, '/')}:missing`); return []; }
    const files = (await listEntries(dir)).filter(entry => entry.isFile && accept(entry.name))
      .map(entry => join(name, entry.name));
    shapes.push(`${name.replace(/\\/g, '/')}:count:${files.length}`);
    return files;
  };
  const banksIn = async (tree: string): Promise<string[]> => {
    const dir = join(root, 'Audio', tree);
    if (!await pathExists(dir)) { shapes.push(`Audio/${tree}:missing`); return []; }
    const folders = (await listSubdirectories(dir)).sort();
    // The folder NAMES are hashed as well as their contents, so a renamed bank changes the fingerprint even
    // when every byte inside it is the same file it was.
    shapes.push(`Audio/${tree}:folders:${folders.join(',')}`);
    return folders.map(folder => join('Audio', tree, folder));
  };

  const [meshes, textures, sfxBanks, songs] = await Promise.all([
    listing('Meshes', obj), listing('Textures', png), banksIn('SFX'), banksIn('Music'),
  ]);
  const audio = (await Promise.all([
    ...sfxBanks.map(bank => listing(bank, slotWav)),
    ...songs.map(song => listing(song, graph)),
  ])).flat();

  const paths = [...TOP_LEVEL_INPUTS, ...meshes, ...textures, ...audio];
  const stamps = await mapLimit(paths, READ_CONCURRENCY,
    async name => ({ name: name.replace(/\\/g, '/').toLowerCase(), stamp: await fileStamp(join(root, name)) }));

  // Folded in a fixed order, because a fingerprint that depended on completion order would change between
  // runs over identical data and defeat the cache. Ordered by code point, NOT `localeCompare`: a collation
  // that moves with the runtime's ICU or the machine's locale is exactly the wrong thing to hash by, and on
  // a list this long it is also the slowest part of the walk.
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const shape of shapes.sort(byName)) hash.update(`${shape}\n`);
  for (const { name, stamp } of stamps.sort((a, b) => byName(a.name, b.name)))
    hash.update(`${name}:${stamp ?? 'missing'}\n`);
  return hash.digest('base64url');
}

/** A stored record is only usable if it still describes the level it was filed under and carries the shapes
 *  both readers index into. Anything else is a miss, not a crash. */
function validRecord(value: unknown, level: string): value is CensusRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<CensusRecord>;
  const census = record.census;
  return !!census && census.level === level && Array.isArray(census.costs)
    && !!census.pages && !!census.extras && !!census.sound && !!record.provenance;
}

const defaultCacheRoot = async () => join((await ensureWorkspace()).workspaceRoot, 'cache', 'level-census');

export interface CensusReadOptions {
  /** Where entries are filed. Defaults to the workspace's own cache folder; tests point it at a temp dir. */
  cacheRoot?: string;
  /**
   * Measure regardless of what is stored, and overwrite the entry with the result.
   *
   * The fingerprint is metadata, and metadata can lie: a file restored from a backup, a clock that moved, a
   * copy that preserved timestamps. Those are rare enough not to widen the fingerprint over — the cost would
   * be paid by every read — and common enough that somebody staring at a number they believe is wrong needs a
   * way to make the question go away. This is that way (`/api/level-census?refresh=1`).
   */
  force?: boolean;
}

/**
 * Read a mountain's priced record, measuring it only when its inputs have moved.
 *
 * The fingerprint IS the file name, so a changed input is simply a miss rather than a comparison — and two
 * servers sharing one workspace can rebuild the same level at once without either seeing the other's
 * half-written file, because `writeFileAtomic` renames a uniquely named temporary into place.
 *
 * `build` returning null means "not a map folder", which is not cached: it costs one read to establish and
 * caching it would need its own absence-shaped entry to invalidate.
 */
export async function readPersistentCensus(level: string, levelDir: string,
  build: () => Promise<CensusRecord | null>, options: CensusReadOptions = {}): Promise<CensusRecord | null> {
  const root = options.cacheRoot ?? await defaultCacheRoot();
  const fingerprint = await censusFingerprint(levelDir);
  const cacheFile = join(root, level, `${fingerprint}.json`);

  // A forced read still WRITES its result under the same fingerprint, so re-measuring costs the measurement
  // once rather than turning the cache off for the rest of the run.
  const cached = options.force ? null : await readTextOrNull(cacheFile);
  if (cached) {
    try {
      const value: unknown = JSON.parse(cached);
      if (validRecord(value, level)) return value;
    } catch { /* corrupt entry — rebuild over it */ }
  }

  const built = await build();
  if (!built) return null;
  try {
    await writeFileAtomic(cacheFile, JSON.stringify(built));
  } catch (error) {
    // A read-only or full cache folder costs speed, never correctness: the measurement just taken is returned.
    log.warn(`could not persist ${level}`, { error });
  }
  return built;
}
