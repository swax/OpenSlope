// tier: fast

/**
 * What a mountain costs, and the four places that arithmetic is easy to get wrong.
 *
 * The census is the number an author designs against: the Scene ▸ Reference comparison shows it for every map
 * folder in the library, `npm run budget` prints the same rows, and the export preflight reads a project's own
 * spend against the band the shipped courses occupy. All three now read one implementation
 * (`core/reference/census`), so what is worth pinning is the arithmetic that implementation must not drift on.
 *
 * Each of these was a real way to be wrong by a factor:
 *
 *  - A mesh named by several models is geometry the level carries ONCE. Summing per model prices a shared
 *    trunk again for every model that names it, which is how a distinct-geometry band ends up nine times the
 *    level's actual art.
 *  - A flipbook material claims one bank slot PER FRAME, because the native renderer indexes the bank per
 *    frame. Counting the resting tile alone under-prices an animated sign by however long it animates.
 *  - An invisible instance is not drawn and is not a placement anyone made. Counting it inflates both the
 *    density figure and the baked total.
 *  - Baked is placements × per-copy triangles. Distinct is the art behind them. Confusing the two is the whole
 *    reason an authored export — which bakes one mesh per placement — is read against retail's DISTINCT column.
 *
 * Run: tsx test/level-census.test.ts
 */
import {
  censusFromTables, isRetailLevel, normalizeLevelCensus, normalizeMountainStats, objTriangles, pageMegabytes,
  statsFromCensus, trisPerInstance, type CensusSource, type LevelCensus, type MountainStats,
} from '../src/core/reference/census';
import { check, failures } from './check';

// ---- counting triangles in an extracted mesh ---------------------------------------------------------------
check(objTriangles('v 0 0 0\nf 1 2 3\nf 4 5 6\n') === 2, 'two triangular faces are two triangles');
check(objTriangles('f 1 2 3 4\n') === 2, 'a quad face is priced fan-wise at the two triangles it costs');
check(objTriangles('f 1 2 3 4 5 6\n') === 4, '...and a six-corner face at four');
check(objTriangles('# f 1 2 3\nfoo 1 2 3\nvf 1 2 3\n') === 0,
  'only a real `f ` line counts — a comment, a longer keyword and a suffix are all not faces');
check(objTriangles('f 1/1/1 2/2/2 3/3/3\n') === 1, 'indexed corners count as corners');
check(objTriangles('') === 0, 'an unreadable mesh is zero, not a crash');

// ---- the level every other check is measured on ------------------------------------------------------------
/**
 * Two models sharing one mesh, one of them animated:
 *   model 0 "shared+own"  → tree.obj (2 tris, page trunk.png) + rock.obj (1 tri, flipbook of 3 frames)
 *   model 1 "shared only" → tree.obj (2 tris, page trunk.png)
 *   model 2 "unplaced"    → huge.obj (500 tris) — in the table, placed by nobody
 * Instances: 3 of model 0 (one of them invisible), 2 of model 1, none of model 2.
 */
const source: CensusSource = {
  models: [
    {
      ModelName: 'shared+own',
      ModelObjects: [{ MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }, { MeshPath: 'rock.obj', MaterialID: 1 }] }],
    },
    { ModelName: 'shared only', ModelObjects: [{ MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
    { ModelName: 'unplaced', ModelObjects: [{ MeshData: [{ MeshPath: 'huge.obj', MaterialID: 2 }] }] },
  ],
  instances: [
    { ModelID: 0, PlayerCollision: true },
    { ModelID: 0 },
    { ModelID: 0, Visable: false, PlayerCollision: true },
    { ModelID: 1 },
    { ModelID: 1 },
  ],
  materials: [
    { TexturePath: 'trunk.png' },
    { TexturePath: 'fire0.png', TextureFlipbook: ['fire0.png', 'fire1.png', 'fire2.png'] },
    { TexturePath: 'unused-by-anything-placed.png' },
  ],
  patches: [{ TexturePath: 'snow.png' }, { TexturePath: 'snow.png' }, { TexturePath: 'trunk.png' }, {}],
  meshTris: new Map([['tree.obj', 2], ['rock.obj', 1], ['huge.obj', 500]]),
  textures: { pages: 7, texels: 2 * 1024 * 1024 },
  extras: { lights: 12, particles: 3, splines: 4 },
  sound: { banks: 2, slots: 5, bytes: 640_000, songs: 1 },
};
const census = censusFromTables('TESTMTN', source);

// ---- placements -----------------------------------------------------------------------------------------
check(census.instances.total === 5 && census.instances.visible === 4,
  'the invisible instance is in the total and out of the visible count');
check(census.instances.collidable === 2,
  'collision is counted whether or not the instance is drawn — an invisible collider is still a collider');
check(census.models.total === 3 && census.models.placed === 2,
  'a model nobody placed is in the table and not in the placed count');

// ---- geometry: the shared-mesh trap -----------------------------------------------------------------------
check(census.meshes === 2, 'the two placed models name two distinct meshes, not three');
check(census.geomTris === 3,
  'distinct geometry counts tree.obj ONCE across both models that name it: 2 + 1 = 3, not 2 + 1 + 2 = 5');
check(census.bakedTris === 2 * 3 + 2 * 2,
  'baked is placements × per-copy: two visible copies of a 3-tri model and two of a 2-tri one = 10');
check(trisPerInstance(census) === 3, 'per-placement weight divides baked by VISIBLE placements: 10 / 4 ≈ 3');

// ---- texture pages: the flipbook trap -----------------------------------------------------------------------
check(census.pages.props === 4,
  'the animated material claims a slot per FRAME: trunk + fire0/1/2 = 4 prop pages, not 2');
check(census.pages.terrain === 2, 'terrain pages are the distinct tiles its patches name, and a bare patch names none');
check(census.pages.shared === 1, 'trunk.png is named by a patch AND a prop, so it is one shared page, not two');
check(census.pages.unused === 7 - 5,
  'pages on disk that neither a patch nor a placed prop names are the level’s other art (crowd flipbook, pickups)');
check(census.pages.onDisk === 7 && pageMegabytes(census.pages.texels) === 2,
  'the folder’s own page count and its size at one byte per texel come through unchanged');

// ---- the per-model breakdown --------------------------------------------------------------------------------
check(census.costs.length === 2, 'only placed models get a cost row');
check(census.costs[0].name === 'shared+own' && census.costs[0].instances === 2,
  'rows are heaviest-baked first, and count only visible placements');
check(census.costs[0].pages.length === 4 && census.costs[0].pages.includes('fire2.png'),
  'a row carries every page its materials name, frames included — what placing it would cost the bank');

// ---- the extras, and which mountains are the yardstick --------------------------------------------------------
check(census.patches === 4, 'the terrain quilt is every patch, textured or not');
check(census.extras.lights === 12 && census.extras.particles === 3 && census.extras.splines === 4,
  'lights, particle placements and splines ride along as the per-frame extras');
check(census.sound.banks === 2 && census.sound.slots === 5 && census.sound.songs === 1,
  'and so does the sound census the reader hands over');
check(!('hits' in census.sound),
  'which carries NO collision-sound count: `Audio/SoundIndex.json` is the engine’s table, identical in every '
  + 'extracted course (95 events, 66 clips), so a column of it would measure whether a folder came off a disc');
check(!census.retail && isRetailLevel('gari') && isRetailLevel('MEGAPLE'),
  'the band is the SHIPPED courses, case-insensitively, and an authored mountain is not one');
// Aloha Ice Jam is a shipped course. It was mis-classified as a fixture for five days because the list had
// been written from whatever was extracted at the time and then described as "the seven" — so the list states
// what retail shipped, and these pin the two ends of that rule.
check(isRetailLevel('ALOHA') && isRetailLevel('UNTRACK'),
  'Aloha Ice Jam and Untracked are shipped mountains — a slot missing from Maps/ costs nothing, but '
  + 'mis-classifying an extracted one silently moves the band');
check(!isRetailLevel('PIPE') && !isRetailLevel('BIGAIR') && !isRetailLevel('TRICK'),
  '...while the halfpipe, the big-air arena and the tutorial park are not: they are single-feature slots, and '
  + 'averaging them in would drag every column down and make an ordinary mountain look extravagant');

// ---- the comparison row the editor reads ----------------------------------------------------------------------
{
  const stats = statsFromCensus(census, {
    course: { length: 4000, drop: 1200 }, laps: 4, showoffSeconds: 90, exported: '2026-08-12T09:00:00.000Z',
  });
  check(stats.level === 'TESTMTN' && stats.bakedTris === census.bakedTris && stats.pages.onDisk === 7,
    'the row carries the census through unchanged');
  check(stats.sound.slots === 5 && stats.sound.songs === 1, '...including the sound census');
  check(stats.course?.length === 4000 && stats.laps === 4 && stats.showoffSeconds === 90,
    '...joined to what the course IS: its recovered line, its passes and its showoff clock');
  check(stats.exported === '2026-08-12T09:00:00.000Z',
    '...and when Slopesmith last wrote the folder, which is what marks it as one of yours');
  check(!('costs' in stats),
    'and NOT the per-model table — listing forty mountains must not ship forty model breakdowns');
  const unraced = statsFromCensus(census,
    { course: null, laps: 1, showoffSeconds: 120, exported: null });
  check(unraced.course === null, 'a folder with no recoverable course line says so rather than reading as zero');
  check(unraced.exported === null, 'and an extracted retail level was never exported from here, so it says null');
}

// ---- a mountain with no props at all ----------------------------------------------------------------------------
{
  // Terrain someone is part-way through building: a legitimate — and interesting — point of comparison, so it
  // must produce a row rather than being skipped for having an empty prop table.
  const bare = censusFromTables('BARE', {
    models: [], instances: [], materials: [], patches: [{ TexturePath: 'snow.png' }],
    meshTris: new Map(), textures: { pages: 1, texels: 0 },
  });
  check(bare.patches === 1 && bare.bakedTris === 0 && bare.costs.length === 0, 'an unpropped mountain prices at zero');
  check(trisPerInstance(bare) === null, 'and its per-placement weight is unanswerable rather than a divide by zero');
  check(bare.extras.lights === 0, 'a folder carrying none of the extra tables reads as zero, not undefined');
  check(bare.sound.slots === 0 && bare.sound.songs === 0,
    'and a silent folder reads as zero across the whole sound census rather than as a hole in the row');
}

// ---- the sound census is a PARTIAL from the reader --------------------------------------------------------------
{
  // The reader knows the folder layout and hands over counts; a reader that learns to count one more thing must
  // not force every other caller (and this test) to restate the fields it already had.
  const partial = censusFromTables('HALF', {
    models: [], instances: [], materials: [], patches: [],
    meshTris: new Map(), textures: { pages: 0, texels: 0 },
    sound: { slots: 12 },
  });
  check(partial.sound.slots === 12 && partial.sound.banks === 0 && partial.sound.bytes === 0,
    'a partial sound census fills its stated field and defaults the rest');
}

// ---- a page reading rows from a service one version behind it -------------------------------------------------
{
  // `npm run dev` hot-updates the editor on every save and deliberately holds the API service across them, so
  // a page charting a census field the running service predates is an ORDINARY development state, not an
  // exotic one. It cost a "Cannot read properties of undefined (reading 'banks')" once; a missing group has
  // to read as zero.
  const complete = statsFromCensus(census,
    { course: { length: 10, drop: 2 }, laps: 1, showoffSeconds: 90, exported: null });
  const older = { ...complete } as Partial<MountainStats>;
  delete older.sound;
  delete older.extras;

  const { rows, filled } = normalizeMountainStats([older as MountainStats]);
  check(rows[0].sound.banks === 0 && rows[0].sound.slots === 0 && rows[0].extras.lights === 0,
    'a row served without a group reads as zero across it rather than throwing on the first cell');
  check(rows[0].bakedTris === complete.bakedTris && rows[0].level === 'TESTMTN',
    'and every field the service DID send survives untouched — one stale column is not a reason to lose thirteen');
  check(filled, 'the reader is told something was invented, so it can say so rather than pass zeros off as measured');

  const intact = normalizeMountainStats([complete]);
  check(!intact.filled, 'a complete row fills nothing');
  check(!normalizeMountainStats([{ ...complete, course: null }]).filled,
    'and a null course is a real answer — "no path table" — not a hole, or half the library would read as stale');
}

// ---- the SAME repair for one mountain's full census -----------------------------------------------------------
{
  // Two consumers read a census over the wire — the comparison table (`MountainStats[]`) and the Scene panel's
  // cost rows (one `LevelCensus`) — and hardening only the first is how a skew that merely greyed out the table
  // left the panel's rows reading "measuring…" for ever: the throw landed after the fetch, inside a promise
  // nobody awaited. Both shapes go through the same fill.
  const older = { ...census } as Partial<LevelCensus>;
  delete older.sound;

  const { census: repaired, filled } = normalizeLevelCensus(older as LevelCensus);
  check(repaired.sound.slots === 0 && repaired.sound.banks === 0,
    'a census served without its sound group reads as zero rather than throwing on `.slots`');
  check(filled, 'and reports the fill, so the panel can name the reason instead of showing a bare zero');
  check(repaired.bakedTris === census.bakedTris && repaired.costs.length === census.costs.length,
    'everything the service did send comes through, per-model table included');
  check(!normalizeLevelCensus(census).filled, 'a complete census fills nothing');
  check(normalizeLevelCensus({ ...census, costs: undefined as unknown as typeof census.costs }).census.costs.length === 0,
    'and a missing per-model table is an empty one — the tool iterates it without checking');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
