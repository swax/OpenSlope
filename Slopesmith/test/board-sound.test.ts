// tier: fast

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BIG_AIR_MIN_PREDICTED_SECONDS, BIG_AIR_WIND_SLOT, BOARD_AUDIO_GROUPS, BOARD_LAND_SLOT, BOARD_OLLIE_SLOT,
  BOARD_RAIL_GROUP, DEFAULT_BOARD_SOUND, SPEED_PAD_SLOT, TRICK_PAD_SLOT, bigAirWindActive, boardAudioGroup,
  boardAirGlideSlot, boardBedFrame, boardCarveSlot, boardGlideSlot, gemChimeSlot, normalizeBoardSound,
} from '../src/core/audio/board-sound';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { boardSoundSource, readBoardSoundBytes, readBoardSoundIndex } from '../src/server/routes/audio';
import {
  auditionBoardSound, boardSoundAuditionActive, boardSoundAuditionPlaying,
  onBoardSoundAuditionChange, stopAudition,
} from '../src/app/ui/components/audition';
import { check, failures } from './check';

/** Board-ride audio (docs/034): the traced surface→family map, the bank's slot arithmetic, the authored mix,
 *  and the shared-bank reader that feeds the test ride. */

// The routing this test injects is synthetic. Real routing comes from the user's executable via
// BoardSoundIndex.json; a fallback legend is checked in at src/core/reference/surface-types.ts (docs/034).
const syntheticGroups = [2, 1, 0];
check(boardAudioGroup(0, syntheticGroups) === 2 && boardAudioGroup(1, syntheticGroups) === 1,
  'surface routing consumes an injected index');
check(boardAudioGroup(99, syntheticGroups) === 0 && boardAudioGroup(-1, syntheticGroups) === 0
  && boardAudioGroup(1, null) === 0, 'unknown or unavailable routing safely rides PACK');
const localIndex = await readBoardSoundIndex();
if (localIndex)
  check(localIndex.SurfaceGroups.length > 0
    && localIndex.SurfaceGroups.every(group => group >= 0 && group < BOARD_AUDIO_GROUPS.length),
  `local ${localIndex.SourceExecutable} board index is usable (${localIndex.SurfaceGroups.length} routes)`);
else console.log('SKIP no Maps/Shared/Audio/BoardSoundIndex.json — local ELF routes not exercised');
check(BOARD_AUDIO_GROUPS[BOARD_RAIL_GROUP] === 'RAIL', 'the grind layer reaches for the RAIL family');

// The decoded GARI bank's own slot pattern: family·8 + mode (carve +3, glide +4, air-glide +6).
const EXPECTED_SLOTS: Record<string, [number, number, number]> = {
  PACK: [3, 4, 6], POWDER: [11, 12, 14], LOOSE: [19, 20, 22], ICE: [27, 28, 30], METAL: [35, 36, 38],
  WOOD: [43, 44, 46], RAIL: [51, 52, 54], ROCK: [59, 60, 62], GLASS: [67, 68, 70], CHUTE: [75, 76, 78],
};
const wrongSlot = BOARD_AUDIO_GROUPS
  .map((family, group) => {
    const [carve, glide, air] = EXPECTED_SLOTS[family];
    return boardCarveSlot(group) === carve && boardGlideSlot(group) === glide && boardAirGlideSlot(group) === air
      ? '' : family;
  })
  .filter(Boolean);
check(!wrongSlot.length, `bank slots match the decoded zboard layout${wrongSlot.length ? ` (${wrongSlot.join(', ')})` : ''}`);

// Project-authored response invariants. AUTOTEST4 supplies the signal ranges used to tune these cases, but
// no retail expression outputs are embedded here: the curve must open smoothly, hand off decisively on a
// skid, distinguish broad material characters, and stay quiet at walking speed.
const speed01 = (mps: number): number => Math.min(1, Math.max(0, (mps - 1.5) / 16.5));
const metalClean = boardBedFrame(4, 47, 0, speed01(12.8));
check(metalClean.glideVol > 0.6 && metalClean.carveVol < 0.15,
  'a clean METAL cruise favors glide without opening the carve row');
const packClean = boardBedFrame(0, 6, 0, speed01(24.3));
check(packClean.glideVol > 0.9 && packClean.carveVol < 0.02 && packClean.glideBend < 0.02,
  'PACK cruising clean: glide is open, carve is shut, and pitch stays natural');
const packEdged = boardBedFrame(0, 250, 100, speed01(8.7));
check(packEdged.carveVol > 0.35 && packEdged.glideVol < 0.02 && packEdged.glideBend > 0.6,
  'PACK holding a full-lock carve: the authored handoff favors carve and raises skid pitch');
const powderClean = boardBedFrame(1, 0, 0, 1);
const woodSkid = boardBedFrame(5, 300, 0, 1);
check(powderClean.glideVol === 1 && powderClean.carveVol === 0,
  'soft snow retains a full clean glide without a carve floor');
check(woodSkid.glideVol === 0.5 && woodSkid.carveVol === 1,
  'hard-surface texture remains audible through a full skid');
check(boardBedFrame(0, 0, 0, speed01(3)).glideVol < 0.05,
  'the smooth speed envelope keeps a crawling board quiet');
check(gemChimeSlot(2) === 116 && gemChimeSlot(3) === 117 && gemChimeSlot(5) === 118,
  'gem chime tiers are MAIN slots 116 / 117 / 118');
check(gemChimeSlot(1) === 116 && gemChimeSlot(2.9) === 116 && gemChimeSlot(4.9) === 117
  && gemChimeSlot(9) === 118, 'the chime thresholds are ≥3 and ≥5 on the value, not a tier index');
check(SPEED_PAD_SLOT === 115 && TRICK_PAD_SLOT === 114, 'speed pad 115, trick pad 114');
check(BOARD_OLLIE_SLOT === 2 && BOARD_LAND_SLOT === 1,
  'primary-rider BOARD transients use +2 on air entry and +1 on landing');
check(BIG_AIR_WIND_SLOT === 32 && BIG_AIR_MIN_PREDICTED_SECONDS === 1.5
  && !bigAirWindActive(1.5) && bigAirWindActive(1.5001),
  'focused-rider MAIN/032 uses the retail strict >1.5-second predicted-flight gate');

// The authored mix: clamped, defaulted, and carried through a saved document.
const clamped = normalizeBoardSound({ enabled: false, volume: 4, glide: -1, carve: 0.25, transients: 'loud' });
check(clamped.enabled === false && clamped.volume === 1 && clamped.glide === 0 && clamped.carve === 0.25
  && clamped.transients === DEFAULT_BOARD_SOUND.transients, 'mix normalization clamps and defaults each field');
check(normalizeBoardSound(undefined).enabled === true, 'a document with no mix rides with sound on');

check(normalizeBoardSound({ enabled: true, volume: 0.5, glide: 0.25, carve: 0.75, transients: 0.6 }).cues
  === DEFAULT_BOARD_SOUND.cues, 'a mix saved before the cue trim existed gains its default');

const doc = blankMountain('BOARD_SOUND_TEST');
doc.boardSound = { enabled: true, volume: 0.5, glide: 0.25, carve: 0.75, transients: 0.6, cues: 0.4 };
const roundTrip = migrateMountain(JSON.parse(JSON.stringify(doc)));
check(roundTrip.boardSound?.volume === 0.5 && roundTrip.boardSound.glide === 0.25
  && roundTrip.boardSound.carve === 0.75 && roundTrip.boardSound.cues === 0.4,
  'saved-document migration preserves the board mix');
check(migrateMountain(JSON.parse(JSON.stringify(blankMountain('NO_MIX')))).boardSound === undefined,
  'a document that never set a mix stays undefined (the runtime defaults it)');

// The shared-bank reader. The banks are level-independent, so any extracted level serves the whole editor.
const source = await boardSoundSource('zboard');
if (!source) {
  console.log('SKIP no extracted zboard bank under Maps/*/Audio/SFX — bank reads not exercised');
  let threw = false;
  try { await readBoardSoundBytes('zboard', boardGlideSlot(0), true); } catch { threw = true; }
  check(threw, 'a missing bank is an error the runtime turns into silence, not a stray read');
} else {
  const glide = await readBoardSoundBytes('zboard', boardGlideSlot(0), true);
  check(glide.subarray(0, 4).toString('ascii') === 'RIFF' && glide.length > 44,
    `PACK glide loop reads as a WAV from ${source.level}`);
  const loopFile = join(source.dir, '004.loop.wav');
  if (existsSync(loopFile)) {
    check(glide.equals(readFileSync(loopFile)), 'a looping layer prefers the BNKl loop-region WAV');
  } else {
    check(glide.equals(readFileSync(join(source.dir, '004.wav'))), 'no loop region: the complete WAV serves');
  }
  const oneShot = await readBoardSoundBytes('zboard', 1, false);
  check(oneShot.equals(readFileSync(join(source.dir, '001.wav'))), 'a one-shot keeps its attack (no loop region)');
  let threw = false;
  try { await readBoardSoundBytes('zboard', 999, false); } catch { threw = true; }
  check(threw, 'an empty slot is an error rather than an empty buffer');
  threw = false;
  try { await readBoardSoundBytes('garibaldi1', 0, false); } catch { threw = true; }
  check(threw, 'only the shared board banks are reachable through this route');
}

// The Sound-panel button follows the shared audio element instead of keeping UI-only state: another slot
// replaces it, a natural end clears it, and an explicit stop clears it even though the WAV has not ended.
const nativeAudio = globalThis.Audio;
class TestAudio {
  static latest: TestAudio;
  volume = 1;
  private listeners = new Map<string, Array<(event: Event) => void>>();
  constructor(public readonly src: string) { TestAudio.latest = this; }
  play(): Promise<void> { return Promise.resolve(); }
  pause(): void {}
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const invoke = typeof listener === 'function'
      ? listener as (event: Event) => void
      : (event: Event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(invoke);
    this.listeners.set(type, listeners);
  }
  finish(type = 'ended'): void {
    for (const listener of this.listeners.get(type) ?? []) listener(new Event(type));
    this.listeners.delete(type);
  }
}
Object.defineProperty(globalThis, 'Audio', { value: TestAudio, configurable: true, writable: true });
let auditionChanges = 0;
const unsubscribe = onBoardSoundAuditionChange(() => { auditionChanges++; });
check(auditionBoardSound(4) && boardSoundAuditionActive() && boardSoundAuditionPlaying(4)
  && !boardSoundAuditionPlaying(28) && auditionChanges === 1,
  'a board preview identifies its own slot so its button can become stop');
auditionBoardSound(28);
check(boardSoundAuditionPlaying(28) && !boardSoundAuditionPlaying(4) && auditionChanges === 3,
  'starting another surface transfers the preview state to that slot');
TestAudio.latest.finish();
check(!boardSoundAuditionActive() && auditionChanges === 4,
  'a naturally completed surface preview restores the button to play');
auditionBoardSound(4);
stopAudition();
check(!boardSoundAuditionActive() && auditionChanges === 6,
  'stopping a surface preview explicitly clears the shared playback state');
unsubscribe();
if (nativeAudio) Object.defineProperty(globalThis, 'Audio', { value: nativeAudio, configurable: true, writable: true });
else Reflect.deleteProperty(globalThis, 'Audio');

console.log(failures ? `\n${failures} check(s) failed` : '\nall board-sound checks passed');
process.exit(failures ? 1 : 0);
