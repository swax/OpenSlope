/**
 * What a mountain costs: the prop, triangle and texture-page census, as pure arithmetic over the tables an
 * extracted or Slopesmith-authored map folder carries.
 *
 * Three numbers decide whether a course can ship, and only one of them is the one authors talk about:
 *
 *  - **Instances.** Cheap on their own — the disc stores a transform and a model id — but every one is a
 *    placement somebody has to make, and they are what a level's density READS as.
 *  - **Triangles.** Retail instances: a shipped level references a few hundred models from thousands of
 *    placements, so its DISTINCT geometry is a fraction of what it draws. Slopesmith's export does not — it
 *    writes one model row, one mesh and one instance per placement — so an authored level's BAKED total is
 *    the geometry it carries, and the honest comparison is against retail's distinct column.
 *  - **Texture pages.** The hard one. A repacked level's bank is a fixed list of pages and every distinct tile
 *    a prop or a patch names claims one. Borrowed tiles ship verbatim; the author's own ship as appended pages
 *    and cost VRAM on top (docs/011). Pages, not megabytes, are what runs out first.
 *
 * The arithmetic lives here, away from the filesystem, so the same numbers reach the census tool
 * (`npm run budget`), the `/api/level-census` route the editor's Reference comparison reads, and a test that
 * feeds it tables by hand. Nothing here parses a file: the caller reads the tables and hands over per-mesh
 * triangle counts, because that read is what differs between a CLI walking `Maps/` and a served route.
 *
 * **Changing any of this arithmetic means bumping `CENSUS_CACHE_SCHEMA` in `server/census-cache.ts`.** Results
 * are persisted against a fingerprint of the INPUT FILES, which is precisely the thing that does not move when
 * the counting changes — so without the bump, every already-measured mountain keeps serving its old numbers.
 */

/**
 * The shipped mountains an authored one is measured against.
 *
 * Everything else under `Maps/` is a test fixture, a lab, or an authored export, and averaging those into the
 * band would move the numbers a design is read against.
 *
 * These are the retail slots that are a WHOLE MOUNTAIN — one you ride top to bottom. The disc carries four
 * more (`core/doc/race` has the full twelve-slot table): `PIPE` and `BIGAIR` are single-feature event arenas
 * and `TRICK` is the tutorial park, so folding them in would drag the low end of every column down and make
 * an ordinary mountain look extravagant beside a halfpipe. `UNTRACK` is here despite hosting no showoff event,
 * because it is a full descent and prices like one.
 *
 * DO NOT let this drift back into "whatever happens to be extracted on this machine". It did once: the list
 * was written when the library held seven of them, was described as "the seven shipped courses", and then
 * silently mis-classified Aloha Ice Jam as a fixture the day it was extracted. Absent slots cost nothing —
 * a level not in `Maps/` simply never appears — so the list states what retail SHIPPED, not what is here.
 */
export const RETAIL_LEVELS: ReadonlySet<string> = new Set([
  'ALASKA', 'ALOHA', 'ELYSIUM', 'GARI', 'MEGAPLE', 'MERQUER', 'MESA', 'SNOW', 'UNTRACK',
]);

export const isRetailLevel = (level: string): boolean => RETAIL_LEVELS.has(level.toUpperCase());

// ---- the tables a census is computed from ------------------------------------------------------------------

export interface CensusModel {
  ModelName?: string;
  ModelObjects?: ({ MeshData?: ({ MeshPath: string; MaterialID: number } | null)[] | null } | null)[] | null;
}
export interface CensusInstance { ModelID: number; Visable?: boolean; PlayerCollision?: boolean }
/** `TextureFlipbook` is a list of page names, and a native flipbook indexes the bank per FRAME — so a
 *  two-frame material claims two slots (`Snowknife/docs/repack-technical-reference.md`, "Placed props"). */
export interface CensusMaterial { TexturePath?: string; TextureFlipbook?: string[] | null }

export interface CensusSource {
  models: CensusModel[];
  instances: CensusInstance[];
  materials: CensusMaterial[];
  /** Only the texture each patch names is read here; the terrain's shape is the reference loader's business. */
  patches: { TexturePath?: string }[];
  /** Triangles per `Meshes/<path>`, counted by the caller — a mesh named by two models is read once. */
  meshTris: ReadonlyMap<string, number>;
  /** The `Textures/` page files that exist, with their pixel counts, whether or not anything names them. */
  textures: { pages: number; texels: number };
  /** Runtime extras a folder may or may not carry: light records, particle placements, native splines. */
  extras?: { lights?: number; particles?: number; splines?: number };
  /** The audio tree, already reduced to counts by the reader (which is what knows the folder layout). */
  sound?: Partial<SoundCensus>;
}

/**
 * What a mountain SOUNDS like, as a cost.
 *
 * The board banks are deliberately absent from `banks` / `slots` / `bytes`. `zboard` and `zbxsfx` are
 * level-INDEPENDENT — every level's `snowknife import` writes the same copies beneath its own `Audio/SFX`, and
 * the editor serves whichever it finds first — so counting them would add the same ~140 slots to every row and
 * bury the part that differs. What differs is a mountain's OWN sound: its course bank, its crowd, and the
 * named ambience it places.
 */
export interface SoundCensus {
  /** The level's own SFX banks — course, crowd and named ambience; board banks excluded. */
  banks: number;
  /** Populated slots across those banks. This is the bank budget a repack has to fit. */
  slots: number;
  /** Their extracted size in bytes. Decoded PCM, so it is a comparison between mountains rather than a disc
   *  figure — the disc holds these ADPCM-compressed. */
  bytes: number;
  /** PathFinder race songs (a `graph.json` each). Retail ships these on the three event courses only. */
  songs: number;
}

/**
 * There is deliberately no collision-sound column here. `Audio/SoundIndex.json` looks like the obvious one —
 * "how much of this mountain makes a noise when you hit it?" — but it is the ENGINE's table, not the level's:
 * every extracted course carries the same 95 events resolving to the same 66 clips, and only the BANK each one
 * points at changes. Charting it would draw a column reading 95 for every retail row and 0 for every authored
 * one, which measures whether a folder came off a disc, a question `exported` already answers honestly.
 */
export const EMPTY_SOUND: SoundCensus = { banks: 0, slots: 0, bytes: 0, songs: 0 };

// ---- the census ---------------------------------------------------------------------------------------------

export interface ModelCost {
  id: number;
  name: string;
  /** Triangles in ONE copy — what a placement bakes. */
  tris: number;
  /** The texture pages this model's materials name, flipbook frames included. */
  pages: string[];
  /** Placements of it in the source level (visible ones). */
  instances: number;
}

export interface LevelCensus {
  level: string;
  retail: boolean;
  instances: { total: number; visible: number; collidable: number };
  models: { total: number; placed: number };
  meshes: number;
  /** Triangles of DISTINCT geometry — every mesh counted once, whatever shares it. This is what a RETAIL
   *  level carries, because it instances; it is the column an authored map's baked total is read against. */
  geomTris: number;
  /** Placements × per-copy triangles: what a retail level draws, and what an authored level would carry,
   *  since its export bakes one mesh per placement. */
  bakedTris: number;
  patches: number;
  pages: { onDisk: number; terrain: number; props: number; shared: number; unused: number; texels: number };
  /** Light records, particle placements and native splines — present when the folder carries those files. */
  extras: { lights: number; particles: number; splines: number };
  sound: SoundCensus;
  costs: ModelCost[];
}

/** Triangles in an extracted mesh. The extractor writes triangulated faces, but count fan-wise anyway so a
 *  polygon face is priced at what it costs rather than silently as one. */
export function objTriangles(text: string): number {
  let tris = 0;
  for (const line of text.split('\n')) {
    if (line.charCodeAt(0) !== 102 /* f */ || line.charCodeAt(1) > 32) continue;
    let corners = 0;
    for (const token of line.slice(2).trim().split(/\s+/)) if (token) corners++;
    if (corners >= 3) tris += corners - 2;
  }
  return tris;
}

/** Price one level's tables. `level` names it only so the row can carry its own name. */
export function censusFromTables(level: string, source: CensusSource): LevelCensus {
  const { models, instances, materials, patches, meshTris } = source;

  /** A material's pages: its resting tile plus every flipbook frame — a flipbook costs one page per frame. */
  const materialPages = (id: number): string[] => {
    const material = materials[id];
    if (!material) return [];
    const out = material.TexturePath ? [material.TexturePath] : [];
    for (const frame of material.TextureFlipbook ?? []) if (frame) out.push(frame);
    return out;
  };

  const placements = new Map<number, number>();
  let visible = 0, collidable = 0;
  for (const instance of instances) {
    if (instance.PlayerCollision) collidable++;
    if (instance.Visable === false) continue;
    visible++;
    placements.set(instance.ModelID, (placements.get(instance.ModelID) ?? 0) + 1);
  }

  const costs: ModelCost[] = [];
  let bakedTris = 0;
  const propPages = new Set<string>();
  const geomMeshes = new Set<string>();
  models.forEach((model, id) => {
    let tris = 0;
    const pages = new Set<string>();
    const mine: string[] = [];
    for (const object of model.ModelObjects ?? [])
      for (const mesh of object?.MeshData ?? []) {
        if (!mesh) continue;
        tris += meshTris.get(mesh.MeshPath) ?? 0;
        mine.push(mesh.MeshPath);
        for (const page of materialPages(mesh.MaterialID)) pages.add(page);
      }
    const count = placements.get(id) ?? 0;
    if (!count) return;
    bakedTris += tris * count;
    for (const page of pages) propPages.add(page);
    for (const path of mine) geomMeshes.add(path);
    costs.push({ id, name: model.ModelName ?? `model ${id}`, tris, pages: [...pages], instances: count });
  });
  // A mesh shared by several models is geometry the level carries ONCE; summing per model would price a
  // shared trunk or a shared panel again for every model that names it.
  let geomTris = 0;
  for (const path of geomMeshes) geomTris += meshTris.get(path) ?? 0;
  costs.sort((a, b) => b.tris * b.instances - a.tris * a.instances);

  const terrainPages = new Set<string>();
  for (const patch of patches) if (patch.TexturePath) terrainPages.add(patch.TexturePath);
  const used = new Set([...terrainPages, ...propPages]);
  let shared = 0;
  for (const page of terrainPages) if (propPages.has(page)) shared++;

  return {
    level,
    retail: isRetailLevel(level),
    instances: { total: instances.length, visible, collidable },
    models: { total: models.length, placed: placements.size },
    meshes: geomMeshes.size,
    geomTris,
    bakedTris,
    patches: patches.length,
    pages: {
      onDisk: source.textures.pages,
      terrain: terrainPages.size,
      props: propPages.size,
      shared,
      unused: Math.max(0, source.textures.pages - used.size),
      texels: source.textures.texels,
    },
    extras: {
      lights: source.extras?.lights ?? 0,
      particles: source.extras?.particles ?? 0,
      splines: source.extras?.splines ?? 0,
    },
    sound: { ...EMPTY_SOUND, ...source.sound },
    costs,
  };
}

// ---- the comparison row the editor reads ---------------------------------------------------------------------

/**
 * One mountain as the Reference comparison lists it: the census without its per-model breakdown, plus the
 * race facts that say what the course IS rather than what it costs. Served by `/api/level-census`; the heavy
 * `costs` array stays behind `?level=` so listing forty mountains does not ship forty model tables.
 */
export interface MountainStats {
  level: string;
  retail: boolean;
  /** Terrain patches — the quilt's size, and the count an authored net is read against. */
  patches: number;
  instances: { total: number; visible: number; collidable: number };
  models: { total: number; placed: number };
  meshes: number;
  geomTris: number;
  bakedTris: number;
  pages: { onDisk: number; terrain: number; props: number; shared: number; unused: number; texels: number };
  extras: { lights: number; particles: number; splines: number };
  sound: SoundCensus;
  /** The recovered main course line, when the folder carries a path table: metres and metres of drop. */
  course: { length: number; drop: number } | null;
  laps: number;
  showoffSeconds: number;
  /**
   * When Slopesmith last wrote this folder, ISO — the mtime of the `Slopesmith.json` every export writes, which
   * makes it the export's own timestamp rather than a guess from whatever file was touched last. Null for an
   * extracted retail level, which carries no such sidecar and was never exported from here.
   */
  exported: string | null;
}

/** What the reader supplies alongside the census: facts about the folder that are not a count of anything in it. */
export interface MountainProvenance {
  course: { length: number; drop: number } | null;
  laps: number;
  showoffSeconds: number;
  exported: string | null;
}

export const statsFromCensus = (census: LevelCensus, provenance: MountainProvenance): MountainStats => ({
  level: census.level,
  retail: census.retail,
  patches: census.patches,
  instances: census.instances,
  models: census.models,
  meshes: census.meshes,
  geomTris: census.geomTris,
  bakedTris: census.bakedTris,
  pages: census.pages,
  extras: census.extras,
  sound: census.sound,
  ...provenance,
});

/**
 * Fill in anything a served row arrived without, so a reader charts a zero rather than throwing.
 *
 * The page and the service can be a version apart, and in development that is routine rather than exotic:
 * Vite hot-updates the client on every save while `scripts/dev.ts` holds the API service in a scope a restart
 * cannot reach — deliberately, so the response cache and the maps watch survive — so a session started before
 * a census field existed serves rows without it to a page that expects it.
 *
 * A missing group is worth degrading for and never worth crashing for: fourteen columns of real numbers and
 * one of zeros is still the comparison somebody asked for. `filled` reports whether anything had to be
 * invented, so a reader can SAY so — an unexplained column of zeros is indistinguishable from a mountain that
 * genuinely has none of that thing, which is the version of this bug that does not announce itself.
 */
export function normalizeMountainStats(
  raw: readonly MountainStats[],
): { rows: MountainStats[]; filled: boolean } {
  let filled = false;
  const rows = raw.map(row => {
    const counted = fillCounts(row, () => { filled = true; });
    return {
      ...row,
      ...counted,
      laps: row.laps ?? 1,
      showoffSeconds: row.showoffSeconds ?? 0,
      // A null course is a real answer — "this folder has no path table" — so it is not something to fill, and
      // counting it as missing would flag half the library as stale.
      course: row.course ?? null,
      exported: row.exported ?? null,
    };
  });
  return { rows, filled };
}

/**
 * The same repair for a single mountain's full census — what `/api/level-census?level=` answers and the Scene
 * panel's cost rows read.
 *
 * Both consumers need this, and only one of them having it is how a version skew that merely greyed out the
 * comparison table left the panel's rows saying "measuring…" for ever: the throw landed after the fetch, in a
 * promise nobody was awaiting.
 */
export function normalizeLevelCensus(raw: LevelCensus): { census: LevelCensus; filled: boolean } {
  let filled = false;
  const counted = fillCounts(raw, () => { filled = true; });
  return { census: { ...raw, ...counted, costs: raw.costs ?? [] }, filled };
}

/** The count groups both shapes share, defaulted. `onFill` fires for each one that had to be invented. */
function fillCounts<T extends Omit<MountainStats, 'course' | 'laps' | 'showoffSeconds' | 'exported'>>(
  row: Partial<T>, onFill: () => void,
) {
  const fill = <V>(value: V | undefined | null, fallback: V): V => {
    if (value !== undefined && value !== null) return value;
    onFill();
    return fallback;
  };
  return {
    instances: fill(row.instances, { total: 0, visible: 0, collidable: 0 }),
    models: fill(row.models, { total: 0, placed: 0 }),
    pages: fill(row.pages, { onDisk: 0, terrain: 0, props: 0, shared: 0, unused: 0, texels: 0 }),
    extras: fill(row.extras, { lights: 0, particles: 0, splines: 0 }),
    sound: fill(row.sound, EMPTY_SOUND),
    patches: fill(row.patches, 0),
    meshes: fill(row.meshes, 0),
    geomTris: fill(row.geomTris, 0),
    bakedTris: fill(row.bakedTris, 0),
  };
}

/** Texture memory at one byte per texel — what the pages on disk would occupy uncompressed. The disc's own
 *  figure comes from `snowknife repack --dry-run`, which knows each page's encoded format; this is the
 *  format-independent size that makes two mountains comparable. */
export const pageMegabytes = (texels: number): number => texels / 1024 / 1024;

/** Average baked triangles per visible placement — how heavy this mountain's typical prop is, which separates
 *  "lots of small modules" from "a few expensive models". Null when nothing is placed. */
export const trisPerInstance = (stats: Pick<MountainStats, 'bakedTris' | 'instances'>): number | null =>
  stats.instances.visible ? Math.round(stats.bakedTris / stats.instances.visible) : null;
