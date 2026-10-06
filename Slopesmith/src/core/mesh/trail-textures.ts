import type { TrailSettings, TrailTilePair } from '../doc/types';
import type { TrailTiling } from './trail';

/**
 * Trail tile PAIRS (docs/023 · Textures): the matched tiles a trail path wears — one along its spans, one through its
 * tight left turns and one through its tight right turns. A pair belongs to the map its two tiles come from and is
 * named within it — `MESA/Trail 1` — and a path names the pairs it wears, so a pair changed changes every path wearing
 * it. The shipped maps' pairs are built in here; a mountain adds its own in its `trailTilePairs`.
 */

/** Every built-in pair, map by map — a map's trail pairs, then its turn pairs. */
export const TRAIL_TILE_PAIRS: readonly TrailTilePair[] = [
  // Mesa's matched halves (docs/023 · Measured ordinary-chart law), [rider's left, rider's right].
  { level: 'MESA', name: 'Trail 1', kind: 'trail', left: 'MESA/0045.png', right: 'MESA/0044.png', quarterTurns: 0 },
  { level: 'MESA', name: 'Trail 2', kind: 'trail', left: 'MESA/0047.png', right: 'MESA/0046.png', quarterTurns: 0 },
  { level: 'MESA', name: 'Trail 3', kind: 'trail', left: 'MESA/0061.png', right: 'MESA/0059.png', quarterTurns: 0 },
  { level: 'MESA', name: 'Trail 4', kind: 'trail', left: 'MESA/0042.png', right: 'MESA/0002.png', quarterTurns: 0 },
  // Mesa marks a turn's way with the same striped tile turned round, stripes down the centre seam
  // (tools/mountain-study/trail-pairs.ts): blue 0064|0066 on 12 left turns and 1 right, 0066|0064 on 24 right and none
  // left; red 0062|0063 on left turns only, 0063|0062 on right ones.
  { level: 'MESA', name: 'Left Turn 1', kind: 'left-turn', left: 'MESA/0064.png', right: 'MESA/0066.png', quarterTurns: 2 }, // blue
  { level: 'MESA', name: 'Right Turn 1', kind: 'right-turn', left: 'MESA/0066.png', right: 'MESA/0064.png', quarterTurns: 0 },
  { level: 'MESA', name: 'Left Turn 2', kind: 'left-turn', left: 'MESA/0062.png', right: 'MESA/0063.png', quarterTurns: 2 }, // red
  { level: 'MESA', name: 'Right Turn 2', kind: 'right-turn', left: 'MESA/0063.png', right: 'MESA/0062.png', quarterTurns: 0 },
];

/** Built-in pairs since split by the way a turn goes, and what each turn slot wears for one now. Their names are never
 *  given out again, so a path still naming one means this. */
const RETIRED_TRAIL_TILE_PAIRS: Readonly<Record<string, { left: string; right: string }>> = {
  'MESA/Turn 1': { left: 'MESA/Left Turn 1', right: 'MESA/Right Turn 1' },
  'MESA/Turn 2': { left: 'MESA/Left Turn 2', right: 'MESA/Right Turn 2' },
};

/** What a new path wears, and what a path saved before tile pairs wears unless it had Mesa's tiles off. */
export const DEFAULT_TRAIL_TILES = {
  trailTiles: 'MESA/Trail 1', leftTurnTiles: 'MESA/Left Turn 1', rightTurnTiles: 'MESA/Right Turn 1', turnRadiusM: 80,
} as const;

/** How a half at `quarterTurns` shows to a rider looking along the path — the path running up the screen — as the D4
 *  `orientCss` draws: a trail tile's own quarter turn and the terrain's sampling put it half a turn round. */
export const trailTileViewOrient = (quarterTurns: number): { rot: number; mirror: boolean } =>
  ({ rot: (((Math.trunc(quarterTurns) + 2) % 4) + 4) % 4, mirror: false });

/** A pair's id: its map and its name, `MESA/Trail 1`. */
export const trailTilePairId = (pair: Pick<TrailTilePair, 'level' | 'name'>): string => `${pair.level}/${pair.name}`;

/** Every pair a mountain's paths may wear: the built-in ones, then its own. */
export const trailTilePairsWith = (own: readonly TrailTilePair[] | undefined): TrailTilePair[] =>
  [...TRAIL_TILE_PAIRS, ...(own ?? [])];

/** The pair an id names, or null. */
export function findTrailTilePair(id: string | null | undefined, own: readonly TrailTilePair[] | undefined): TrailTilePair | null {
  if (!id) return null;
  return trailTilePairsWith(own).find(pair => trailTilePairId(pair) === id) ?? null;
}

export const isBuiltInTrailTilePair = (id: string): boolean => TRAIL_TILE_PAIRS.some(pair => trailTilePairId(pair) === id);

const KIND_WORDS: Readonly<Record<TrailTilePair['kind'], string>> = {
  trail: 'Trail', turn: 'Turn', 'left-turn': 'Left Turn', 'right-turn': 'Right Turn',
};

/** The name a new pair of `kind` takes in `level`: the first `Trail N` (`Left Turn N`, …) no pair there has, nor had. */
export function nextTrailTilePairName(level: string, kind: TrailTilePair['kind'], own: readonly TrailTilePair[] | undefined): string {
  const taken = new Set([
    ...trailTilePairsWith(own).filter(pair => pair.level === level).map(pair => pair.name),
    ...Object.keys(RETIRED_TRAIL_TILE_PAIRS).filter(id => id.startsWith(`${level}/`)).map(id => id.slice(level.length + 1)),
  ]);
  const word = KIND_WORDS[kind];
  let n = 1;
  while (taken.has(`${word} ${n}`)) n++;
  return `${word} ${n}`;
}

/** Every tile any of these pairs lays. */
export function trailTilePairTiles(pairs: readonly TrailTilePair[]): Set<string> {
  return new Set(pairs.flatMap(pair => [pair.left, pair.right]).filter(Boolean));
}

type TileSettings = Pick<TrailSettings, 'trailTiles' | 'leftTurnTiles' | 'rightTurnTiles' | 'turnRadiusM'>;

/** The setting each pair slot is. */
export const TRAIL_TILE_SLOTS = ['trailTiles', 'leftTurnTiles', 'rightTurnTiles'] as const;

/** The kinds of pair each slot offers, and the kind a pair made for it is. A `turn` pair goes either way. */
export const TRAIL_TILE_SLOT_KINDS: Readonly<Record<typeof TRAIL_TILE_SLOTS[number], readonly TrailTilePair['kind'][]>> = {
  trailTiles: ['trail'], leftTurnTiles: ['left-turn', 'turn'], rightTurnTiles: ['right-turn', 'turn'],
};

/** A turn slot's pair, a retired one standing for what it was split into on that side. */
const turnSlot = (id: string | null, side: 'left' | 'right'): string | null => (id && RETIRED_TRAIL_TILE_PAIRS[id]?.[side]) ?? id;

/** The pairs a path's settings wear. A path saved with one pair for every turn wears it through both; one saved before
 *  tile pairs carries only `mesaTextures` (or, briefly, a `textures` set): Mesa's tiles off, or no set, is plain, and
 *  anything else is Mesa's first pairs. */
export function trailSettingsTiles(settings: TrailSettings): TileSettings {
  const turnRadiusM = settings.turnRadiusM ?? DEFAULT_TRAIL_TILES.turnRadiusM;
  if (settings.leftTurnTiles !== undefined) {
    return {
      trailTiles: settings.trailTiles ?? null, turnRadiusM,
      leftTurnTiles: turnSlot(settings.leftTurnTiles, 'left'), rightTurnTiles: turnSlot(settings.rightTurnTiles ?? null, 'right'),
    };
  }
  const legacy = settings as { turnTiles?: string | null; mesaTextures?: boolean; textures?: unknown };
  if (settings.trailTiles !== undefined) {
    const turn = legacy.turnTiles ?? null;
    return { trailTiles: settings.trailTiles, leftTurnTiles: turnSlot(turn, 'left'), rightTurnTiles: turnSlot(turn, 'right'), turnRadiusM };
  }
  const plain = legacy.mesaTextures === false || legacy.textures === null;
  return plain ? { trailTiles: null, leftTurnTiles: null, rightTurnTiles: null, turnRadiusM } : { ...DEFAULT_TRAIL_TILES };
}

/** What a path's settings lay, for the generator: its pairs looked up among the built-in ones and `own`. A pair
 *  that cannot be found lays nothing. */
export function trailTiling(settings: TrailSettings, own: readonly TrailTilePair[] | undefined): TrailTiling | undefined {
  const tiles = trailSettingsTiles(settings);
  const trail = findTrailTilePair(tiles.trailTiles, own);
  const leftTurn = findTrailTilePair(tiles.leftTurnTiles, own), rightTurn = findTrailTilePair(tiles.rightTurnTiles, own);
  return trail || leftTurn || rightTurn ? { trail, leftTurn, rightTurn, turnRadiusM: tiles.turnRadiusM } : undefined;
}
