import { join } from 'node:path';
import type { ReferenceIntroMusic, ReferenceMusicGraph, ReferenceMusicIndex } from '../../core/reference/music';
import { summarizeReferenceMusic } from '../../core/reference/music';
import { mapsRoot } from '../workspace-config';
import { isDirectory, listEntries, listDir, mapLimit, pathExists, readBytesOrNull, readJsonOr, READ_CONCURRENCY } from '../fs-async';
import { safeDataName } from './safe-name';
import { readEnvironmentAudio } from './audio';

function safeSegment(value: string, what: string): string {
  const safe = safeDataName(value);
  if (!safe || safe !== value) throw new Error(`invalid ${what} ${value || '(empty)'}`);
  return safe;
}

async function musicRoot(level: string): Promise<{ level: string; root: string }> {
  const safeLevel = safeSegment(level, 'reference level');
  const root = join(mapsRoot(), safeLevel, 'Audio', 'Music');
  if (!await isDirectory(root)) throw new Error(`no extracted race music for ${safeLevel}`);
  return { level: safeLevel, root };
}

/** Song folders, preferring the extractor's playlist order over the alphabetical fallback. Both forms confirm
 *  a graph.json per candidate, which is one probe each — run concurrently rather than in sequence. */
async function songIds(root: string): Promise<string[]> {
  const hasGraph = async (name: string) => await pathExists(join(root, name, 'graph.json'));
  const playlist = await readJsonOr<unknown>(join(root, 'playlist.json'), null);
  if (Array.isArray(playlist)) {
    const named = playlist.filter((item): item is string =>
      typeof item === 'string' && safeDataName(item) === item);
    const present = await mapLimit(named, READ_CONCURRENCY, hasGraph);
    return named.filter((_name, index) => present[index]);
  }
  const candidates = (await listDir(root)).filter(name => safeDataName(name) === name);
  const present = await mapLimit(candidates, READ_CONCURRENCY, hasGraph);
  return candidates.filter((_name, index) => present[index])
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

/** MusicDirectorSetup's exact generic choice: top-level `<song>-<tier><digits>.wav`, preferring C, then A,
 * then B. Song folders contain `chunk_NNN.wav` and are deliberately excluded by `listEntries(root)`. */
async function introMusic(root: string): Promise<ReferenceIntroMusic | null> {
  const entries = await listEntries(root);
  const byTier = new Map<'A' | 'B' | 'C', Array<{ name: string; index: number }>>();
  for (const entry of entries) {
    if (!entry.isFile) continue;
    const match = /-([ABC])(\d+)\.wav$/i.exec(entry.name);
    if (!match) continue;
    const tier = match[1].toUpperCase() as 'A' | 'B' | 'C';
    const list = byTier.get(tier) ?? [];
    list.push({ name: entry.name, index: Number(match[2]) });
    byTier.set(tier, list);
  }
  for (const tier of ['C', 'A', 'B'] as const) {
    const stems = byTier.get(tier);
    if (stems?.length) return {
      tier,
      stems: stems.sort((a, b) => a.index - b.index
        || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map(item => item.name),
    };
  }
  return null;
}

function safeWavName(value: string): string {
  if (!/^[A-Za-z0-9_-]+\.wav$/i.test(value)) throw new Error(`invalid extracted music sample ${value}`);
  return value;
}

export async function readReferenceMusicGraph(level: string, song: string): Promise<ReferenceMusicGraph> {
  const { root } = await musicRoot(level);
  const safeSong = safeSegment(song, 'reference song');
  const graph = await readJsonOr<ReferenceMusicGraph | null>(join(root, safeSong, 'graph.json'), null);
  if (!graph) throw new Error(`no race-music graph ${level}/${safeSong}`);
  if (!Array.isArray(graph.Nodes) || !Array.isArray(graph.Samples) || typeof graph.EventTable !== 'string')
    throw new Error(`invalid race-music graph ${level}/${safeSong}`);
  return graph;
}

/** Read one decoded WAV from the extracted song. `sample` is the MPF's one-based node sample id. */
export async function readReferenceMusicSampleBytes(level: string, song: string, sample: number): Promise<Buffer> {
  const resolved = await musicRoot(level);
  const safeSong = safeSegment(song, 'reference song');
  const index = Math.trunc(sample) - 1;
  const graph = await readReferenceMusicGraph(resolved.level, safeSong);
  if (!Number.isInteger(sample) || index < 0 || index >= graph.Samples.length)
    throw new Error(`invalid race-music sample ${sample}`);
  const wav = safeWavName(graph.Samples[index].Wav);
  const bytes = await readBytesOrNull(join(resolved.root, safeSong, wav));
  if (!bytes) throw new Error(`missing race-music sample ${resolved.level}/${safeSong}/${wav}`);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`invalid WAV race-music sample ${resolved.level}/${safeSong}/${wav}`);
  return bytes;
}

/** Read one top-level intro stem named by the index. Re-resolving the chosen tier makes the byte route a
 * closed capability: a caller cannot use a merely path-safe WAV name to read unrelated files in Audio/Music. */
export async function readReferenceIntroMusicBytes(level: string, stem: string): Promise<Buffer> {
  const resolved = await musicRoot(level);
  const intro = await introMusic(resolved.root);
  if (!intro || !intro.stems.includes(stem)) throw new Error(`invalid intro-music stem ${stem || '(empty)'}`);
  const bytes = await readBytesOrNull(join(resolved.root, stem));
  if (!bytes) throw new Error(`missing intro-music stem ${resolved.level}/${stem}`);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`invalid WAV intro-music stem ${resolved.level}/${stem}`);
  return bytes;
}

export async function readReferenceMusicIndex(level: string): Promise<ReferenceMusicIndex> {
  const safeLevel = safeSegment(level, 'reference level');
  const root = join(mapsRoot(), safeLevel, 'Audio', 'Music');
  const hasMusic = await isDirectory(root);
  const ids = hasMusic ? await songIds(root) : [];
  const graphs = await mapLimit(ids, READ_CONCURRENCY, id => readReferenceMusicGraph(safeLevel, id));
  return {
    level: safeLevel,
    environment: (await readEnvironmentAudio(safeLevel))?.Bed ?? null,
    intro: hasMusic ? await introMusic(root) : null,
    songs: ids.map((id, index) => summarizeReferenceMusic(id, graphs[index])),
  };
}
