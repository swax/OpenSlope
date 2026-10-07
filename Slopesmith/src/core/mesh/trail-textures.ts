import type { TrailSettings, TrailTileRow, TrailTileSet } from '../doc/types';
import type { TrailLaneTiles, TrailTiling } from './trail';

/**
 * Trail tile SETS (docs/023 · Textures): the tiles a trail path wears, a 4×3 — four ROWS of a left, a middle and a
 * right tile: a CAP row on its capped ends, a TRAIL row along its spans, and a row each through its tight right and
 * left turns. A row's left and right tiles are its edge lanes', its middle every lane's between. A set with no cap or
 * turn row wears its trail row there, and a cap or turn row with no middle the trail row's. A set belongs to the map
 * its tiles come from and is named within it — `MESA/Trail 1` — and a path names the set it wears, so a set changed
 * changes every path wearing it. The shipped maps' sets are built in here; a mountain adds its own in its
 * `trailTileSets`.
 */

/** A set's rows, as a set is drawn: the cap at the top, as the end of a path is, then the trail and its turns. */
export const TRAIL_TILE_ROWS = ['cap', 'trail', 'rightTurn', 'leftTurn'] as const;
export type TrailTileRowKey = typeof TRAIL_TILE_ROWS[number];

/** Each row in words: `right turn`. */
export const TRAIL_TILE_ROW_WORDS: Readonly<Record<TrailTileRowKey, string>> = {
  cap: 'cap', trail: 'trail', rightTurn: 'right turn', leftTurn: 'left turn',
};

/**
 * Every built-in set, map by map, each a map's `Preset N`: laid by hand in the panel's set builder, tile by tile, each as
 * it reads to a rider going along the path, and copied out as its layout (docs/023 · Textures). A turn row marks the turn's way, mostly with
 * RIGHT TRIANGLES pointing into it — flat side downhill, upright side on the turn's side; a NARROW set draws a turn mark
 * or a cap across both of its two lanes, a wide one on its edges, three across, fitting a path of any width.
 */
export const TRAIL_TILE_SETS: readonly TrailTileSet[] = [
  {
    level: 'ALASKA', name: 'Preset 1',
    trail: { left: 'ALASKA/0137.png', middle: 'ALASKA/0137.png', right: 'ALASKA/0137.png', quarterTurns: 2 },
    rightTurn: { left: 'ALASKA/0003.png', middle: 'ALASKA/0137.png', right: 'ALASKA/0137.png', quarterTurns: 2 },
    leftTurn: { left: 'ALASKA/0137.png', middle: 'ALASKA/0137.png', right: 'ALASKA/0003.png', mirrored: ['right'], quarterTurns: 0, turns: { right: 2 } },
  },
  {
    level: 'ALOHA', name: 'Preset 1',
    cap: { left: 'ALOHA/0035.png', middle: 'ALOHA/0001.png', right: 'ALOHA/0034.png', quarterTurns: 2, turns: { left: 3, middle: 1, right: 1 } },
    trail: { left: 'ALOHA/0015.png', middle: 'ALOHA/0143.png', right: 'ALOHA/0001.png', quarterTurns: 2 },
    rightTurn: { left: 'ALOHA/0169.png', middle: 'ALOHA/0143.png', right: 'ALOHA/0001.png', quarterTurns: 2 },
    leftTurn: { left: 'ALOHA/0015.png', middle: 'ALOHA/0143.png', right: 'ALOHA/0172.png', quarterTurns: 2 },
  },
  {
    level: 'GARI', name: 'Preset 1', narrow: true,
    cap: { left: 'GARI/0018.png', right: 'GARI/0017.png', quarterTurns: 2 },
    trail: { left: 'GARI/0012.png', right: 'GARI/0012.png', mirrored: ['right'], quarterTurns: 2, turns: { left: 2, right: 2 } },
    rightTurn: { left: 'GARI/0088.png', right: 'GARI/0087.png', mirrored: ['left', 'right'], quarterTurns: 0 },
    leftTurn: { left: 'GARI/0087.png', right: 'GARI/0088.png', quarterTurns: 0 },
  },
  {
    level: 'GARI', name: 'Preset 2', narrow: true,
    cap: { left: 'GARI/0018.png', right: 'GARI/0017.png', quarterTurns: 0, turns: { left: 2, right: 2 } },
    trail: { left: 'GARI/0012.png', right: 'GARI/0012.png', mirrored: ['left'], quarterTurns: 0, turns: { left: 2, right: 2 } },
    rightTurn: { left: 'GARI/0016.png', right: 'GARI/0012.png', mirrored: ['left'], quarterTurns: 0, turns: { left: 2, right: 2 } },
    leftTurn: { left: 'GARI/0012.png', right: 'GARI/0099.png', mirrored: ['left'], quarterTurns: 0, turns: { left: 2, right: 2 } },
  },
  {
    level: 'GARI', name: 'Preset 3',
    cap: { left: 'GARI/0018.png', middle: 'GARI/0012.png', right: 'GARI/0017.png', quarterTurns: 0, turns: { left: 2, middle: 3, right: 2 } },
    trail: { left: 'GARI/0012.png', middle: 'GARI/0020.png', right: 'GARI/0012.png', quarterTurns: 0, turns: { middle: 2, right: 2 } },
    rightTurn: { left: 'GARI/0016.png', middle: 'GARI/0020.png', right: 'GARI/0012.png', mirrored: ['left'], quarterTurns: 0, turns: { left: 2, middle: 2, right: 2 } },
    leftTurn: { left: 'GARI/0012.png', middle: 'GARI/0020.png', right: 'GARI/0099.png', quarterTurns: 0, turns: { middle: 2, right: 2 } },
  },
  {
    level: 'MESA', name: 'Preset 1', narrow: true,
    cap: { left: 'MESA/0043.png', right: 'MESA/0041.png', quarterTurns: 2 },
    trail: { left: 'MESA/0047.png', right: 'MESA/0047.png', quarterTurns: 0, turns: { right: 2 } },
    rightTurn: { left: 'MESA/0066.png', right: 'MESA/0064.png', mirrored: ['left', 'right'], quarterTurns: 0, turns: { left: 2, right: 2 } },
    leftTurn: { left: 'MESA/0062.png', right: 'MESA/0063.png', quarterTurns: 0, turns: { left: 2, right: 2 } },
  },
  {
    level: 'SNOW', name: 'Preset 1',
    cap: { left: 'SNOW/0060.png', middle: 'SNOW/0059.png', right: 'SNOW/0058.png', quarterTurns: 0, turns: { left: 2, middle: 2, right: 2 } },
    trail: { left: 'SNOW/0047.png', middle: 'SNOW/0053.png', right: 'SNOW/0045.png', quarterTurns: 2 },
    rightTurn: { left: 'SNOW/0097.png', middle: 'SNOW/0053.png', right: 'SNOW/0045.png', quarterTurns: 2 },
    leftTurn: { left: 'SNOW/0047.png', middle: 'SNOW/0053.png', right: 'SNOW/0071.png', quarterTurns: 2 },
  },
];

/** Built-in sets no longer given out, and the one a path still naming one wears now — the set after it with the same
 *  trail row — or null where none follows it: such a path goes plain. Their names are never given out again. */
const RETIRED_TRAIL_TILE_SETS: Readonly<Record<string, string | null>> = {
  'MESA/Trail 1': 'MESA/Preset 1', 'MESA/Trail 2': 'MESA/Preset 1', 'MESA/Trail 3': 'MESA/Preset 1', 'MESA/Trail 4': 'MESA/Preset 1',
  'ALASKA/Snow Trail': 'ALASKA/Preset 1', 'ALASKA/Ice Trail': null, 'ALASKA/Ice Arrows Trail': null,
  'ALOHA/Trail 1': null, 'ALOHA/Trail 2': 'ALOHA/Preset 1', 'GARI/Snow Trail': 'GARI/Preset 3', 'MERQUER/Trail 1': null,
  'PIPE/Trail 3': null, 'SNOW/Trail 1': 'SNOW/Preset 1', 'UNTRACK/Trail 1': null,
  // The presets' own names before they were presets — the mountain's own sets they were laid as.
  'MESA/Trail 5': 'MESA/Preset 1', 'ALASKA/Trail 1': 'ALASKA/Preset 1', 'ALOHA/Trail 3': 'ALOHA/Preset 1',
  'SNOW/Trail 2': 'SNOW/Preset 1', 'GARI/Trail 1': 'GARI/Preset 1', 'GARI/Trail 2': 'GARI/Preset 2', 'GARI/Trail 3': 'GARI/Preset 3',
};
/** The set a built-in one no longer given out is worn as now; null where none follows it, undefined for a name never
 *  retired. */
export const retiredTrailTileSetSuccessor = (id: string): string | null | undefined =>
  Object.hasOwn(RETIRED_TRAIL_TILE_SETS, id) ? RETIRED_TRAIL_TILE_SETS[id] : undefined;

/** Tiles those laid that no set lays now: a re-cut takes them back too, as a set's. */
const RETIRED_TRAIL_TILES: readonly string[] = [
  'ALASKA/0001.png', 'ALASKA/0002.png', 'ALASKA/0011.png', 'ALASKA/0120.png',
  'ALOHA/0018.png', 'ALOHA/0021.png', 'ALOHA/0117.png', 'ALOHA/0120.png', 'ALOHA/0122.png', 'ALOHA/0124.png', 'ALOHA/0133.png',
  'ALOHA/0136.png', 'ALOHA/0139.png', 'ALOHA/0170.png',
  'MERQUER/0000.png', 'MERQUER/0001.png', 'MERQUER/0007.png', 'MERQUER/0008.png', 'MERQUER/0147.png',
  'MESA/0002.png', 'MESA/0042.png', 'MESA/0044.png', 'MESA/0045.png', 'MESA/0046.png', 'MESA/0059.png', 'MESA/0061.png',
  'PIPE/0008.png', 'PIPE/0009.png', 'PIPE/0010.png', 'PIPE/0013.png', 'PIPE/0016.png', 'PIPE/0019.png', 'PIPE/0023.png',
  'PIPE/0024.png', 'PIPE/0025.png',
  'SNOW/0072.png', 'SNOW/0073.png', 'SNOW/0095.png', 'UNTRACK/0023.png', 'UNTRACK/0025.png', 'UNTRACK/0027.png',
];

/** What a new path wears until a set is chosen for one (the panel remembers the last chosen). */
export const DEFAULT_TRAIL_TILES = { trailTiles: 'GARI/Preset 3', turnRadiusM: 80 } as const;
/** What a path saved before tile sets wears, unless it had Mesa's tiles off: Mesa's set. */
const LEGACY_TRAIL_TILES = 'MESA/Preset 1';

/** How a tile at `quarterTurns` shows to a rider looking along the path — the path running up the screen — as the D4
 *  `orientCss` draws: a trail tile's own quarter turn and the terrain's sampling put it half a turn round. */
export const trailTileViewOrient = (quarterTurns: number): { rot: number; mirror: boolean } =>
  ({ rot: (((Math.trunc(quarterTurns) + 2) % 4) + 4) % 4, mirror: false });

/** A set's id: its map and its name, `MESA/Trail 1`. */
export const trailTileSetId = (set: Pick<TrailTileSet, 'level' | 'name'>): string => `${set.level}/${set.name}`;

/** Every set a mountain's paths may wear: the built-in ones, then its own — but for one of its own a built-in one has
 *  the name of, which it stands behind (a set laid as the mountain's own and since built in). */
export const trailTileSetsWith = (own: readonly TrailTileSet[] | undefined): TrailTileSet[] =>
  [...TRAIL_TILE_SETS, ...(own ?? []).filter(set => !isBuiltInTrailTileSet(trailTileSetId(set)))];

/** The set an id names — a retired built-in's the one it is worn as now — or null. */
export function findTrailTileSet(id: string | null | undefined, own: readonly TrailTileSet[] | undefined): TrailTileSet | null {
  if (!id) return null;
  const sets = trailTileSetsWith(own);
  const named = (want: string) => sets.find(set => trailTileSetId(set) === want);
  const successor = RETIRED_TRAIL_TILE_SETS[id];
  return named(id) ?? (successor ? named(successor) ?? null : null);
}

export const isBuiltInTrailTileSet = (id: string): boolean => TRAIL_TILE_SETS.some(set => trailTileSetId(set) === id);

/** The built-in set laid exactly as `set` is — every row, and narrow or wide — under whatever name, or null: a set of a
 *  mountain's own since built in. */
export function builtInTrailTileSetTwin(set: TrailTileSet): TrailTileSet | null {
  const laid = (of: TrailTileSet) => trailTileSetLiteral({ ...of, name: '' });
  return TRAIL_TILE_SETS.find(builtIn => laid(builtIn) === laid(set)) ?? null;
}

/** Whether a set fits a path `lanes` wide: a wide set any, a narrow one — drawn two across — two lanes. */
export const trailTileSetFits = (set: Pick<TrailTileSet, 'narrow'>, lanes: number): boolean => !set.narrow || lanes === 2;

/** A row with no middle, nor anything said of one: a narrow set's. */
export function withoutTrailTileMiddle(row: TrailTileRow): TrailTileRow {
  const next: TrailTileRow = { ...row };
  delete next.middle;
  const mirrored = (row.mirrored ?? []).filter(which => which !== 'middle');
  if (mirrored.length) next.mirrored = mirrored; else delete next.mirrored;
  const turns = { ...row.turns };
  delete turns.middle;
  if (Object.values(turns).some(Boolean)) next.turns = turns; else delete next.turns;
  return next;
}

/** A row's tiles, rider's left to right — the middle between them where it has one — leaving out a plain lane's. */
export const trailTileRowTiles = (row: Pick<TrailTileRow, 'left' | 'middle' | 'right'>): string[] =>
  (row.middle ? [row.left, row.middle, row.right] : [row.left, row.right]).filter(Boolean);

/** A row's tiles as a rider sees them, left to right: each one's place, ref ('' for a plain lane), and how it is worn —
 *  mirrored, and turned of its own. */
export const trailTileRowLanes = (row: Pick<TrailTileRow, 'left' | 'middle' | 'right' | 'mirrored' | 'turns'>):
{ which: 'left' | 'middle' | 'right'; ref: string; mirrored: boolean; turns: number }[] =>
  (row.middle ? ['left', 'middle', 'right'] as const : ['left', 'right'] as const)
    .map(which => ({ which, ref: row[which] ?? '', mirrored: !!row.mirrored?.includes(which), turns: row.turns?.[which] ?? 0 }));

/** How a row's tile shows to a rider going along the path, as the D4 `orientCss` draws: the row's turn and its own,
 *  and its mirror — a tile mirrored across the trail shows flipped on screen. */
export function trailTileRowView(row: Pick<TrailTileRow, 'quarterTurns' | 'mirrored' | 'turns'>, which: 'left' | 'middle' | 'right'):
{ rot: number; mirror: boolean } {
  return { rot: trailTileViewOrient(row.quarterTurns + (row.turns?.[which] ?? 0)).rot, mirror: !!row.mirrored?.includes(which) };
}

/** The row with its tile there showing as `view` (`trailTileRowView`): its own turn and mirror set to give that. */
export function withTrailTileRowView(row: TrailTileRow, which: 'left' | 'middle' | 'right', view: { rot: number; mirror: boolean }):
TrailTileRow {
  const turn = (((view.rot - 2 - Math.trunc(row.quarterTurns)) % 4) + 4) % 4;
  const turns = { ...row.turns, [which]: turn };
  for (const side of ['left', 'middle', 'right'] as const) if (!turns[side]) delete turns[side];
  const mirrored = [...(row.mirrored ?? []).filter(side => side !== which), ...(view.mirror ? [which] : [])];
  const next: TrailTileRow = { ...row, mirrored, turns };
  if (!mirrored.length) delete next.mirrored;
  if (!Object.keys(turns).length) delete next.turns;
  return next;
}

/** The row a set wears there: its own, a cap or turn row with no middle wearing the trail row's — shown as it is there;
 *  the trail row where it has none; and whether it is the trail row so. */
export function trailTileSetRow(set: TrailTileSet, key: TrailTileRowKey): { row: TrailTileRow; borrowed: boolean } {
  const own = set[key];
  if (!own) return { row: set.trail, borrowed: key !== 'trail' };
  if (key === 'trail' || own.middle !== undefined || !set.trail.middle) return { row: own, borrowed: false };
  return { row: { ...withTrailTileRowView(own, 'middle', trailTileRowView(set.trail, 'middle')), middle: set.trail.middle }, borrowed: false };
}

/** The name a new set takes in `level`: the first `Trail N` no set there has, nor had. */
export function nextTrailTileSetName(level: string, own: readonly TrailTileSet[] | undefined): string {
  const taken = new Set([
    ...trailTileSetsWith(own).filter(set => set.level === level).map(set => set.name),
    ...Object.keys(RETIRED_TRAIL_TILE_SETS).filter(id => id.startsWith(`${level}/`)).map(id => id.slice(level.length + 1)),
  ]);
  let n = 1;
  while (taken.has(`Trail ${n}`)) n++;
  return `Trail ${n}`;
}

/** Every tile any of these sets lays, and any a set no longer given out laid. */
export function trailTileSetTiles(sets: readonly TrailTileSet[]): Set<string> {
  const rows = sets.flatMap(set => TRAIL_TILE_ROWS.map(key => set[key]).filter((row): row is TrailTileRow => !!row));
  return new Set([...rows.flatMap(trailTileRowTiles), ...RETIRED_TRAIL_TILES].filter(Boolean));
}

/**
 * A set as it was saved while a set was one row of one kind — a trail's, a turn's, a cap's — or a pair: a set of that
 * row alone, worn along its spans. Null for anything else.
 */
export function trailTileSetFromRow(saved: unknown): TrailTileSet | null {
  const old = saved as Partial<TrailTileRow & { level: string; name: string; kind: string }>;
  if (!old || typeof old.level !== 'string' || typeof old.name !== 'string' || typeof old.left !== 'string'
    || typeof old.right !== 'string') return null;
  const row: TrailTileRow = {
    left: old.left, right: old.right, ...(old.middle ? { middle: old.middle } : {}),
    ...(old.mirrored?.length ? { mirrored: [...old.mirrored] } : {}), quarterTurns: old.quarterTurns ?? 0,
  };
  return { level: old.level, name: old.name, trail: row };
}

type TileSettings = Pick<TrailSettings, 'trailTiles' | 'turnRadiusM'>;

/** The set a path's settings wear, and its turns' radius. A path saved before tile sets carries only `mesaTextures`
 *  (or, briefly, a `textures` object): Mesa's tiles off, or none, is plain, and anything else is Mesa's set. One saved
 *  while turns and caps were sets of their own wears its trail's set — its turn and cap rows now. */
export function trailSettingsTiles(settings: TrailSettings): TileSettings {
  const turnRadiusM = settings.turnRadiusM ?? DEFAULT_TRAIL_TILES.turnRadiusM;
  if (settings.trailTiles !== undefined) return { trailTiles: settings.trailTiles, turnRadiusM };
  const legacy = settings as { mesaTextures?: boolean; textures?: unknown };
  const plain = legacy.mesaTextures === false || legacy.textures === null;
  return { trailTiles: plain ? null : LEGACY_TRAIL_TILES, turnRadiusM };
}

const laneTiles = (row: TrailTileRow): TrailLaneTiles => ({
  left: row.left, right: row.right, ...(row.middle ? { middle: row.middle } : {}),
  ...(row.mirrored?.length ? { mirrored: [...row.mirrored] } : {}), ...(row.turns ? { turns: { ...row.turns } } : {}),
  quarterTurns: row.quarterTurns,
});

/** A row as it is written in a set: `{ left: 'MESA/0046.png', middle: …, quarterTurns: 2 }`. */
export function trailTileRowLiteral(row: TrailTileRow): string {
  const turns = (['left', 'middle', 'right'] as const).filter(which => row.turns?.[which]).map(which => `${which}: ${row.turns![which]}`);
  return `{ left: '${row.left}', ${row.middle !== undefined ? `middle: '${row.middle}', ` : ''}right: '${row.right}', `
    + `${row.mirrored?.length ? `mirrored: [${row.mirrored.map(which => `'${which}'`).join(', ')}], ` : ''}quarterTurns: ${row.quarterTurns}`
    + `${turns.length ? `, turns: { ${turns.join(', ')} }` : ''} }`;
}

/** A set as the literal to paste into `TRAIL_TILE_SETS`. */
export function trailTileSetLiteral(set: TrailTileSet): string {
  return ['{', `  level: '${set.level}', name: '${set.name}',${set.narrow ? ' narrow: true,' : ''}`,
    ...TRAIL_TILE_ROWS.flatMap(key => set[key] ? [`  ${key}: ${trailTileRowLiteral(set[key]!)},`] : []), '},'].join('\n');
}

/** What a path's settings lay, for the generator: its set's rows, looked up among the built-in sets and `own`. A set
 *  that cannot be found lays nothing. */
export function trailTiling(settings: TrailSettings, own: readonly TrailTileSet[] | undefined): TrailTiling | undefined {
  const tiles = trailSettingsTiles(settings);
  const set = findTrailTileSet(tiles.trailTiles, own);
  if (!set) return undefined;
  const row = (key: Exclude<TrailTileRowKey, 'trail'>) => set[key] ? laneTiles(trailTileSetRow(set, key).row) : null;
  return {
    trail: laneTiles(set.trail), leftTurn: row('leftTurn'), rightTurn: row('rightTurn'), cap: row('cap'),
    turnRadiusM: tiles.turnRadiusM,
  };
}
