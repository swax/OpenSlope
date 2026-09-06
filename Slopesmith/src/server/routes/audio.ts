import { join } from 'node:path';
import { mapsRoot } from '../workspace-config';
import { isDirectory, listDir, listEntries, listSubdirectories, readBytesOrNull, readJsonOr } from '../fs-async';
import type { CollisionSoundIndex } from '../../core/effects/collision-sound';
import type { BoardSoundIndex } from '../../core/audio/board-sound';
import { validEnvironmentDocument, type EnvironmentAudioDocument } from '../../core/audio/environment';
import { safeDataName } from './safe-name';

/** Read the user-generated map sidecar Snowknife wrote from this map's source disc. */
export async function readSoundIndex(level: string): Promise<CollisionSoundIndex | null> {
  const safeLevel = safeDataName(level);
  if (!safeLevel) return null;
  const index = await readJsonOr<CollisionSoundIndex | null>(
    join(mapsRoot(), safeLevel, 'Audio', 'SoundIndex.json'), null);
  return index?.Schema === 'openslope-sound-index/v1' ? index : null;
}

/** Read the explicit map-local off-board environment bed. Missing/old folders have no implicit fallback. */
export async function readEnvironmentAudio(level: string): Promise<EnvironmentAudioDocument | null> {
  const safeLevel = safeDataName(level);
  if (!safeLevel) return null;
  const document = await readJsonOr<EnvironmentAudioDocument | null>(
    join(mapsRoot(), safeLevel, 'Audio', 'Environment.json'), null);
  return validEnvironmentDocument(document) ? document : null;
}

/** Read the disc-global board surface routes generated beside the shared zboard bank. */
export async function readBoardSoundIndex(): Promise<BoardSoundIndex | null> {
  const index = await readJsonOr<BoardSoundIndex | null>(
    join(mapsRoot(), 'Shared', 'Audio', 'BoardSoundIndex.json'), null);
  if (index?.Schema !== 'openslope-board-sound-index/v1' || !Array.isArray(index.SurfaceGroups)) return null;
  return index.SurfaceGroups.every(group => Number.isInteger(group) && group >= 0) ? index : null;
}

async function soundRequest(level: string, slot: number, loop = false) {
  const safeLevel = safeDataName(level);
  const safeSlot = Math.trunc(slot);
  if (!safeLevel || safeSlot < 0 || safeSlot > 999) throw new Error(`invalid effect sound ${level}/${slot}`);
  const root = join(mapsRoot(), safeLevel, 'Audio', 'SFX');
  if (!await isDirectory(root)) throw new Error(`no extracted SFX for ${safeLevel}`);
  const stem = `${safeSlot}`.padStart(3, '0');
  // A continuing ExternalSounds voice wants the BNKl loop region Snowknife writes beside the slot, the same
  // clean sustain the board ride reads. Most environment banks ship one; the clips that do not (and every
  // one-shot, which wants its attack) fall back to the whole WAV. [Trailmap: 190-audio-data]
  return {
    safeLevel, root, filename: `${stem}.wav`,
    filenames: loop ? [`${stem}.loop.wav`, `${stem}.wav`] : [`${stem}.wav`],
  };
}

/** The first of `files` that exists, read in order. Sequential rather than concurrent because the list is a
 *  preference order — the fallback is only wanted when the preferred name is genuinely absent. */
async function readFirst(files: string[]): Promise<Buffer | null> {
  for (const file of files) {
    const bytes = await readBytesOrNull(file);
    if (bytes) return bytes;
  }
  return null;
}

/** Read an effect/collision sound slot from the extracted banks. `course` (the default) is a MainType-8
 * SoundPlay slot or an event-resolved collision slot in the level's course BANK (group 2), deliberately
 * excluding the shared rider/crowd/wind banks that may contain an unrelated WAV with the same numeric
 * filename. `crowd` serves the shared Crowd bank (group 3) — the target of collision event ids 97–99
 * [Trailmap: 420-audio-runtime]. */
export async function readCourseEffectSoundBytes(level: string, slot: number,
  bank: 'course' | 'crowd' = 'course', loop = false): Promise<Buffer> {
  const { safeLevel, root, filename, filenames } = await soundRequest(level, slot, loop);
  const entries = await listEntries(root);
  const named = (await readSoundIndex(safeLevel))?.Banks['2'] ?? null;
  const banks = bank === 'crowd'
    ? entries.filter(entry => entry.name.toLowerCase() === 'crowd').map(entry => entry.name)
    // No folder scan fallback: fixed environmental banks share numeric filenames with the course bank. An
    // extraction without SoundIndex is unresolved, which is safer than auditioning a different sound.
    : entries.filter(entry => entry.isDirectory && named
        && entry.name.toLowerCase() === named.toLowerCase()).map(entry => entry.name);
  // Preference order is per bank, not across banks: a loop region only ever substitutes for its own slot.
  const bytes = await readFirst(banks.flatMap(dir => filenames.map(name => join(root, dir, name))));
  if (!bytes) throw new Error(`no ${bank}-bank sound ${safeLevel}/${filename}`);
  return bytes;
}

export type SoundBankKind = 'course' | 'crowd' | 'board' | 'named';

export interface SoundBankListing {
  /** Extracted folder name under Maps/<level>/Audio/SFX, e.g. `garibaldi1`. */
  name: string;
  kind: SoundBankKind;
  /** Populated slot numbers, ascending. `NNN.loop.wav` siblings are not separate slots. */
  slots: number[];
}

const SLOT_WAV = /^(\d{3})\.wav$/i;

function bankKind(courseBank: string | null, name: string): SoundBankKind {
  const lower = name.toLowerCase();
  if (lower === (courseBank ?? '').toLowerCase()) return 'course';
  if (lower === 'crowd') return 'crowd';
  if (BOARD_BANKS.has(lower)) return 'board';
  return 'named';
}

/** Every extracted bank of one level with the slots it actually populates — the browser behind the Sound
 * Library. Course bank first (the slots a MainType-8 PlaySound node indexes), then crowd, board, and the
 * named global banks alphabetically. */
export async function listSoundBanks(level: string): Promise<SoundBankListing[]> {
  const safeLevel = safeDataName(level);
  const root = safeLevel ? join(mapsRoot(), safeLevel, 'Audio', 'SFX') : '';
  if (!root || !await isDirectory(root)) return [];
  const courseBank = (await readSoundIndex(safeLevel))?.Banks['2'] ?? null;
  const order: Record<SoundBankKind, number> = { course: 0, crowd: 1, board: 2, named: 3 };
  const banks = await Promise.all((await listSubdirectories(root)).map(async name => ({
    name,
    kind: bankKind(courseBank, name),
    slots: (await listDir(join(root, name)))
      .map(file => SLOT_WAV.exec(file)?.[1]).filter((n): n is string => !!n)
      .map(Number).sort((a, b) => a - b),
  })));
  return banks.filter(bank => bank.slots.length)
    .sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
}

/** Levels with an extracted Audio/SFX tree, ascending — the Sound Library's level picker. */
export async function listSoundBankLevels(): Promise<string[]> {
  const levels = await listDir(mapsRoot());
  const found = await Promise.all(levels.map(async level =>
    await isDirectory(join(mapsRoot(), level, 'Audio', 'SFX')) ? level : null));
  return found.filter((level): level is string => !!level).sort();
}

/** The shared banks the board ride reads: the Board bank's family×mode loop matrix and the main SFX bank the
 * held-boost roar lives in [Trailmap: 190-audio-data, 420-audio-runtime]. */
const BOARD_BANKS = new Set(['zboard', 'zbxsfx']);

/** Which extracted level supplies a shared board bank. The banks are level-INDEPENDENT — every level's
 * `snowknife import` writes the same zboard/zbxsfx WAVs beneath its own Audio/SFX — so the first level carrying
 * the folder serves the whole editor, and an authored mountain that has never had a reference loaded still
 * gets a board bed. Null when nothing has been extracted yet. */
export async function boardSoundSource(bank: string): Promise<{ level: string; dir: string } | null> {
  const wanted = bank.trim().toLowerCase();
  if (!BOARD_BANKS.has(wanted)) return null;
  for (const level of (await listDir(mapsRoot())).sort()) {
    const dir = join(mapsRoot(), level, 'Audio', 'SFX', wanted);
    if (await isDirectory(dir)) return { level, dir };
  }
  return null;
}

/** Read one shared board-bank slot. `loop` prefers the sibling `NNN.loop.wav` Snowknife emits from the BNKl
 * loop region — the clean sustain a continuously performed layer wants — and falls back to the complete WAV
 * for the slots that ship no loop region (and for the one-shot transients, which want their attack). */
export async function readBoardSoundBytes(bank: string, slot: number, loop: boolean): Promise<Buffer> {
  const source = await boardSoundSource(bank);
  if (!source) throw new Error(`no extracted ${bank} bank under Maps/*/Audio/SFX`);
  const safeSlot = Math.trunc(slot);
  if (safeSlot < 0 || safeSlot > 999) throw new Error(`invalid board sound slot ${slot}`);
  const stem = `${safeSlot}`.padStart(3, '0');
  const names = loop ? [`${stem}.loop.wav`, `${stem}.wav`] : [`${stem}.wav`];
  const bytes = await readFirst(names.map(name => join(source.dir, name)));
  if (!bytes) throw new Error(`no ${bank} slot ${stem} in ${source.level}`);
  return bytes;
}

/** Read a fixed global environmental bank selected by a native ExternalSounds event. The requested bank is
 * one safe path segment and is matched case-insensitively to the extracted AUDIO.BIG folder. */
export async function readNamedEffectSoundBytes(level: string, slot: number, bank: string,
  loop = false): Promise<Buffer> {
  const { safeLevel, root, filename, filenames } = await soundRequest(level, slot, loop);
  const requested = bank.trim();
  if (!requested || safeDataName(requested) !== requested) throw new Error(`invalid effect sound bank ${bank}`);
  const dir = (await listSubdirectories(root)).find(name => name.toLowerCase() === requested.toLowerCase());
  const bytes = dir ? await readFirst(filenames.map(name => join(root, dir, name))) : null;
  if (!bytes) throw new Error(`no ${requested}-bank sound ${safeLevel}/${filename}`);
  return bytes;
}

/** Locate a fixed environment bank without making authored maps name a donor level. These banks come from
 * shared AUDIO.BIG and are byte-identical across course extractions; the first installed copy is enough. */
export async function environmentSoundSource(bank: string): Promise<{ level: string; dir: string } | null> {
  const requested = bank.trim();
  if (!requested || safeDataName(requested) !== requested) return null;
  for (const level of (await listDir(mapsRoot())).sort()) {
    const root = join(mapsRoot(), level, 'Audio', 'SFX');
    if (!await isDirectory(root)) continue;
    const named = (await listSubdirectories(root)).find(name => name.toLowerCase() === requested.toLowerCase());
    if (named) return { level, dir: join(root, named) };
  }
  return null;
}

/** Read a level-independent environment-bed slot, preferring its decoded sustain region for a loop. */
export async function readEnvironmentSoundBytes(bank: string, slot: number, loop: boolean): Promise<Buffer> {
  const source = await environmentSoundSource(bank);
  if (!source) throw new Error(`no extracted ${bank} environment bank under Maps/*/Audio/SFX`);
  const safeSlot = Math.trunc(slot);
  if (!Number.isInteger(slot) || safeSlot < 0 || safeSlot > 999)
    throw new Error(`invalid environment sound slot ${slot}`);
  const stem = String(safeSlot).padStart(3, '0');
  const names = loop ? [`${stem}.loop.wav`, `${stem}.wav`] : [`${stem}.wav`];
  const bytes = await readFirst(names.map(name => join(source.dir, name)));
  if (!bytes) throw new Error(`no ${bank} environment slot ${stem} in ${source.level}`);
  return bytes;
}
