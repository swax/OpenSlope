import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { projectAssetPath } from '../project-assets';
import { ensureDir, isFile, listEntries, pathExists, readBytesOrNull } from '../fs-async';
import { storeUnderFreeName } from './safe-name';
import type { RaceMusicArrangement } from '../../core/doc/types';
import { textFile } from '../../core/export/files';
import type { StagedRaceMusic } from '../../core/export/provider';
import {
  decodeWav, encodePcm16Wav, resampleAudio, RACE_MUSIC_CHANNELS, RACE_MUSIC_SAMPLE_RATE,
  STAGED_ARRANGEMENT, STAGED_TRACK,
} from '../../core/export/wav';
import { normalizeRaceMusicArrangement } from '../../core/music/arrangement';

/** Author-owned full-length sources. Browsers audition the original file; export turns the selection into
 * one stable PCM16 WAV plus an arrangement contract for Snowknife's donor-shaped PathFinder replacement. */
const MUSIC_EXTENSIONS = new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac']);
const MUSIC_MIME: Record<string, string> = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
};

const customMusicDir = () => projectAssetPath('music');

async function musicFile(name: string): Promise<string> {
  const ext = extname(name).toLowerCase();
  if (!name || basename(name) !== name || !MUSIC_EXTENSIONS.has(ext))
    throw new Error(`invalid custom music filename ${name || '(empty)'}`);
  const file = join(customMusicDir(), name);
  if (!await isFile(file)) throw new Error(`no custom music ${name}`);
  return file;
}

export async function listCustomMusic(): Promise<string[]> {
  return (await listEntries(customMusicDir()))
    .filter(entry => entry.isFile && MUSIC_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

export function customMusicContentType(name: string): string {
  return MUSIC_MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Keep a track that arrived with an uploaded map (docs/038). The bytes are stored as they came — a source
 * file is the author's master and the export is what normalises it — so this only decides the name, which is
 * the one thing the mountain-local library must decide: a name already taken lands beside the original as `name_2`,
 * and a retired one is never handed out again. Returns the stored file name, extension included.
 */
export async function saveCustomMusic(name: string, bytes: Buffer): Promise<string> {
  const ext = extname(name).toLowerCase();
  if (!MUSIC_EXTENSIONS.has(ext)) throw new Error(`unsupported music format ${ext || '(none)'}`);
  const { name: stem } = await storeUnderFreeName({
    library: customMusicDir(),
    name: name.slice(0, name.length - ext.length),
    fallback: 'track',
    taken: candidate => pathExists(join(customMusicDir(), candidate + ext)),
    write: async stored => {
      await ensureDir(customMusicDir());
      await writeFile(join(customMusicDir(), stored + ext), bytes);
    },
  });
  return stem + ext;
}

export async function readCustomMusicBytes(name: string): Promise<Buffer> {
  const bytes = await readBytesOrNull(await musicFile(name));
  if (!bytes) throw new Error(`no custom music ${name}`);
  return bytes;
}

/**
 * The node side of race-music staging: the selected library source, transcoded to the folder's
 * `Music/track.wav` contract, plus the arrangement beside it.
 *
 * Uncompressed sources only, because a headless export decodes them itself — `decodeWav` reads what a WAV
 * container can hold and nothing pretends to be a codec library. A browser hands anything it can play to
 * WebAudio instead, so an mp3 track is staged there; here it is refused by name rather than silently dropped.
 */
export async function stageRaceMusic(selection: string | null | undefined, levelDir: string,
  authoredArrangement?: RaceMusicArrangement): Promise<StagedRaceMusic> {
  const existing = await pathExists(join(levelDir, 'Music', 'track.wav'));
  if (selection === undefined) return { status: 'legacy', files: [], remove: [], existing };
  if (selection === null || !selection.trim())
    return { status: 'cleared', files: [], remove: [STAGED_TRACK, STAGED_ARRANGEMENT], existing };

  const source = await musicFile(selection);
  const bytes = await readBytesOrNull(source);
  if (!bytes) throw new Error(`no custom music ${selection}`);
  if (extname(selection).toLowerCase() !== '.wav')
    throw new Error(`${selection} is compressed — a headless export stages uncompressed WAV sources; `
      + 'export from the editor to stage this one.');
  const track = encodePcm16Wav(
    resampleAudio(decodeWav(bytes), RACE_MUSIC_SAMPLE_RATE, RACE_MUSIC_CHANNELS), RACE_MUSIC_SAMPLE_RATE);
  const arrangement = normalizeRaceMusicArrangement(authoredArrangement);
  return {
    status: 'staged',
    files: [
      { path: STAGED_TRACK, bytes: track },
      textFile(STAGED_ARRANGEMENT, `${JSON.stringify({ version: 1, ...arrangement }, null, 2)}\n`),
    ],
    remove: [],
    existing,
    mode: arrangement.mode,
    bytes: track.length,
  };
}
