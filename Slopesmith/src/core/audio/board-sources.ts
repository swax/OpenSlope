import { mapGame } from '../reference/map-game';
import type { CollisionSoundIndex } from '../effects/collision-sound';

/** Older preview adapters omitted snow loops when the disc had BOARD but no SPUBOARD bank. */
export function missingSnowLoopSources(
  index: Pick<CollisionSoundIndex, 'NamedBanks'> | null | undefined,
  bank: string,
  slot: number,
): { bank: string; slot: number }[] {
  const original = index?.NamedBanks?.BOARD;
  if (
    bank.toLowerCase() !== 'openslope_board' ||
    index?.NamedBanks?.SPUBOARD ||
    !original ||
    !/^[a-z0-9_-]+$/i.test(original) ||
    slot < 0 ||
    slot >= 32 ||
    ![3, 4].includes(slot % 8)
  )
    return [];
  return [...new Set([slot, slot % 8])].map(slot => ({ bank: original, slot }));
}

interface BoardAudioSource {
  name: string;
  game?: string;
  bank?: string;
}

const GAME_ORDER = [
  'ssx-tricky',
  'ssx-3',
  'ssx-3-beta',
  'ssx-on-tour',
  'jonny-moseley-mad-trix',
  '1080-avalanche',
  'ssx-tricky-gba',
];

function priority(source: BoardAudioSource): number {
  let game = mapGame(source);
  // Shared and old unnamed Tricky extractions can predate source-game metadata.
  if (game === 'unknown' && /^(zboard|zbxsfx)$/i.test(source.bank ?? '')) game = 'ssx-tricky';
  const index = GAME_ORDER.indexOf(game);
  return index < 0 ? GAME_ORDER.length : index;
}

/** Automatic custom-mountain audio uses one stable bank in game-preference order. */
export function compareBoardAudioSources(a: BoardAudioSource, b: BoardAudioSource): number {
  return priority(a) - priority(b) || a.name.localeCompare(b.name);
}
