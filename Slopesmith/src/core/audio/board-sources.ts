import { mapGame } from '../reference/map-game';

interface BoardAudioSource {
  name: string;
  game?: string;
  bank?: string;
}

const GAME_ORDER = ['ssx-tricky', 'ssx-3', 'ssx-on-tour', 'jonny-moseley-mad-trix', '1080-avalanche', 'ssx-tricky-gba'];

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
