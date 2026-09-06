import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { mapsRoot } from '../workspace-config';
import {
  isDirectory, listDir, listSubdirectories, mapLimit, pathExists, readJsonOr, readTextOrNull, readBytesOrNull,
  READ_CONCURRENCY,
} from '../fs-async';
import {
  censusFromTables, objTriangles, statsFromCensus, EMPTY_SOUND,
  type CensusInstance, type CensusMaterial, type CensusModel, type LevelCensus, type MountainProvenance,
  type MountainStats, type SoundCensus,
} from '../../core/reference/census';
import { readPersistentCensus, type CensusRecord } from '../census-cache';
import { SLOPESMITH_EXPORT_MANIFEST } from '../../core/export/manifest';
import { readLevelCourse, readLevelLaps, readLevelShowoffSeconds, listLevels } from './levels';
import { safeDataName } from './safe-name';

/**
 * Read what each mountain under `Maps/` costs, so the editor's Reference comparison can put a candidate design
 * beside the shipped courses instead of beside nothing (`core/reference/census` explains the three numbers).
 *
 * This is the same measurement `npm run budget` prints, taken from the same files, because it is literally the
 * same function — the arithmetic is pure and lives in core; this module is only the read. Doing it twice is how
 * a tool and a panel come to disagree about the size of a level.
 *
 * The read is deliberately direct: extracted JSON and the mesh OBJs, not the editor's prop pipeline. A census
 * that went through the loader would move whenever the loader did, and the whole point of the numbers is that
 * they are a fixed thing to design against.
 */

interface ModelsFile { Models?: CensusModel[] }
interface InstancesFile { Instances?: CensusInstance[] }
interface MaterialsFile { Materials?: CensusMaterial[] }
type PatchRow = { TexturePath?: string };

/** `Patches.json` is `{Patches:[…]}`, but the reference loader also accepts a bare array, so this does too —
 *  the census must never disagree with the renderer about whether a folder is a map. */
const patchRows = (json: unknown): PatchRow[] | null => {
  if (Array.isArray(json)) return json as PatchRow[];
  const rows = (json as { Patches?: unknown } | null)?.Patches;
  return Array.isArray(rows) ? rows as PatchRow[] : null;
};

/** Page dimensions straight off the PNG header — IHDR is always the first chunk, so 24 bytes is the whole read. */
async function pngTexels(file: string): Promise<number> {
  const head = (await readBytesOrNull(file))?.subarray(0, 24);
  if (!head || head.length < 24) return 0;
  return head.readUInt32BE(16) * head.readUInt32BE(20);
}

/** How many records a table file holds, without caring what they are — the count is the stat. */
async function countRecords(dir: string, file: string, key: string): Promise<number> {
  const json = await readJsonOr<Record<string, unknown> | null>(join(dir, file), null);
  const rows = json?.[key];
  return Array.isArray(rows) ? rows.length : 0;
}

/** Slot WAVs are `NNN.wav`; `NNN.loop.wav` is the same slot's loop region, not a second slot. */
const SLOT_WAV = /^\d+\.wav$/i;
/** The two level-INDEPENDENT board banks every import writes — see `SoundCensus` for why they are excluded. */
const BOARD_BANKS = new Set(['zboard', 'zbxsfx']);

/**
 * The level's own sound, counted off its `Audio` tree.
 *
 * Sizes come from a `stat` per slot WAV rather than from reading the bytes: a mountain's bank is a couple of
 * hundred files, and the whole library is measured in one answer.
 */
async function readSound(dir: string): Promise<SoundCensus> {
  const audio = join(dir, 'Audio');
  if (!await isDirectory(audio)) return EMPTY_SOUND;

  const sfx = join(audio, 'SFX');
  const banks = (await listSubdirectories(sfx)).filter(name => !BOARD_BANKS.has(name.toLowerCase()));
  const measured = await mapLimit(banks, 8, async bank => {
    const slots = (await listDir(join(sfx, bank))).filter(file => SLOT_WAV.test(file));
    const sizes = await mapLimit(slots, READ_CONCURRENCY,
      file => stat(join(sfx, bank, file)).then(info => info.size, () => 0));
    return { slots: slots.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
  });

  // A song is a folder with a `graph.json` — the same test the music study uses, so the two agree about what
  // counts as a song and neither is fooled by a loose WAV sitting beside the song folders.
  const music = join(audio, 'Music');
  const candidates = await listSubdirectories(music);
  const graphs = await mapLimit(candidates, READ_CONCURRENCY,
    name => pathExists(join(music, name, 'graph.json')));

  return {
    banks: measured.filter(bank => bank.slots).length,
    slots: measured.reduce((sum, bank) => sum + bank.slots, 0),
    bytes: measured.reduce((sum, bank) => sum + bank.bytes, 0),
    songs: graphs.filter(Boolean).length,
  };
}

/** When Slopesmith last wrote this folder: the export sidecar's mtime, or null for a retail extraction that
 *  has none. `Slopesmith.json` is written by every export and by nothing else, so its mtime is the date. */
async function exportedAt(dir: string): Promise<string | null> {
  try { return (await stat(join(dir, SLOPESMITH_EXPORT_MANIFEST))).mtime.toISOString(); }
  catch { return null; }
}

/**
 * Price one level folder, reading every mesh, texture header and sound slot in it. Returns null only when the
 * folder is not a map at all; a mountain that places no props still gets a row, because "no props yet" is a
 * legitimate — and interesting — point of comparison for a terrain someone is part-way through building.
 *
 * This is the MEASUREMENT. Callers go through `censusRecord`, which only reaches it when the folder has
 * actually moved (`server/census-cache`).
 */
async function measureLevel(level: string): Promise<LevelCensus | null> {
  const dir = join(mapsRoot(), level);
  const [models, instances, materials, rawPatches] = await Promise.all([
    readJsonOr<ModelsFile>(join(dir, 'Models.json'), {}),
    readJsonOr<InstancesFile>(join(dir, 'Instances.json'), {}),
    readJsonOr<MaterialsFile>(join(dir, 'Materials.json'), {}),
    readJsonOr<unknown>(join(dir, 'Patches.json'), null),
  ]);
  const patches = patchRows(rawPatches);
  if (!patches) return null; // Patches.json is what makes a folder a map (docs/036)

  // every mesh the model table names, read once — a level's models share meshes heavily
  const meshPaths = new Set<string>();
  for (const model of models.Models ?? [])
    for (const object of model.ModelObjects ?? [])
      for (const mesh of object?.MeshData ?? []) if (mesh) meshPaths.add(mesh.MeshPath);
  const meshTris = new Map<string, number>();
  await mapLimit([...meshPaths], READ_CONCURRENCY, async path => {
    meshTris.set(path, objTriangles(await readTextOrNull(join(dir, 'Meshes', path)) ?? ''));
  });

  const files = (await listDir(join(dir, 'Textures'))).filter(file => file.toLowerCase().endsWith('.png'));
  const texels = (await mapLimit(files, READ_CONCURRENCY, file => pngTexels(join(dir, 'Textures', file))))
    .reduce((sum, count) => sum + count, 0);

  const [lights, particles, splines, sound] = await Promise.all([
    countRecords(dir, 'Lights.json', 'Lights'),
    countRecords(dir, 'ParticleInstances.json', 'Particles'),
    countRecords(dir, 'Splines.json', 'Splines'),
    readSound(dir),
  ]);

  return censusFromTables(level, {
    models: models.Models ?? [],
    instances: instances.Instances ?? [],
    materials: materials.Materials ?? [],
    patches,
    meshTris,
    textures: { pages: files.length, texels },
    extras: { lights, particles, splines },
    sound,
  });
}

/** What the folder IS, beside what it costs: its recovered course line, the race it is run as, and when
 *  Slopesmith last exported it. The course recovery is the same one the loaded reference reports, so the two
 *  agree. Stored with the census, because it is measured from the same folder at the same moment. */
async function measureProvenance(level: string): Promise<MountainProvenance> {
  const [course, laps, showoffSeconds, exported] = await Promise.all([
    readLevelCourse(level), readLevelLaps(level), readLevelShowoffSeconds(level),
    exportedAt(join(mapsRoot(), level)),
  ]);
  return {
    course: course ? { length: course.length, drop: course.drop } : null,
    laps,
    showoffSeconds,
    exported,
  };
}

/**
 * One mountain's priced record, off the persistent cache when its folder has not moved since it was last
 * measured (`server/census-cache`). Everything below reads through here, so nothing prices a folder twice.
 *
 * `force` measures the folder whatever is stored — the manual re-measure behind `?refresh=1`, for the day the
 * fingerprint's metadata does not describe what is actually in the files.
 */
export async function censusRecord(name: string, force = false): Promise<CensusRecord | null> {
  const level = safeDataName(name);
  return readPersistentCensus(level, join(mapsRoot(), level), async () => {
    const census = await measureLevel(level);
    return census && { census, provenance: await measureProvenance(level) };
  }, { force });
}

/** One mountain's census, with its per-model breakdown — what `npm run budget` prints and what
 *  `/api/level-census?level=` answers. */
export async function levelCensus(name: string, force = false): Promise<LevelCensus | null> {
  return (await censusRecord(name, force))?.census ?? null;
}

/** One mountain's comparison row: the census without its per-model table, joined to what the course is. */
export async function mountainStats(name: string, force = false): Promise<MountainStats | null> {
  const record = await censusRecord(name, force);
  return record && statsFromCensus(record.census, record.provenance);
}

/**
 * Every mountain in the library, priced. Read a few at a time rather than all at once: measuring a level opens
 * hundreds of mesh files, and forty levels doing that together is how a bulk read reaches the descriptor limit
 * on the machine that has the biggest library. A cached level costs only its fingerprint, so the warm pass
 * through this is dominated by stats rather than reads.
 *
 * A forced pass re-measures every one of them, which is the whole library's cold cost — seconds, not
 * milliseconds. That is the price of the answer being trustworthy, and it is why nothing does it on a timer.
 */
export async function allMountainStats(force = false): Promise<MountainStats[]> {
  const levels = await listLevels();
  const rows = await mapLimit(levels, 4, level => mountainStats(level, force).catch(() => null));
  return rows.filter((row): row is MountainStats => row !== null);
}
