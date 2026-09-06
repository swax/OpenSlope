# 011 — Export preflight & the disc split

A mountain is authored against no target. The reference level is a pure authoring aid — an overlay to measure
against, a course line to seed from, and a bank of tiles to paint from — and export writes **one portable map
folder**. Where that folder ships is decided afterwards, by `snowknife`, which is the only thing holding a
target's slot table.

Code: `src/server/routes/export.ts` (`exportLevel`, `writeDiscRecipe`), `src/core/export/level.ts` (per-cell
texture resolution, `parseTexRef`/`texDestName`), `src/core/export/preflight.ts` (the dialog's summary).
Consumers: `Snowknife/Services/RepackService.cs` (`repack`, `repack-many`), `Snowknife/Repack/SlopesmithExport.cs`
(`texture-plan`), Snowknife's [repack guide](../../Snowknife/REPACK.md) and
[technical reference](../../Snowknife/docs/repack-technical-reference.md), `docs/003-export-contract.md`,
`docs/005-texture-paint.md`.

## One export form

Every painted tile ships flattened and verbatim — `Textures/GARI_0012.png` with `TexturePath: "GARI_0012.png"` —
and nothing is lost, because provenance rides beside it. `Slopesmith.json` carries, per `TexturePath`, the
`{level, name, staged}` it came from, which is exactly what a repacker needs to choose:

| Manifest says | `repack` does |
|---|---|
| `level` == the target slot being replaced | reuse that verbatim ssh page; install nothing |
| `level` is another retail map | install the staged PNG's donor page into a reusable slot, else append |
| `level` is `Custom` | encode the staged PNG (type 5, or type 2 under `--texture-type2`) |

The tool is better placed for every one of those decisions than the editor is: it holds the target's slot
table, the reuse-before-append allocator, the encoder, the power-of-two conform, and the only honest VRAM
numbers. The same argument retires the PS2 size cap from the editor — headroom is a property of the disc being
patched, not of the mountain.

## The export dialog

**Export map** opens a dialog with no target picker. It shows what the folder will contain — cells painted, the tiles
they use and how many cells each covers, **what the props cost**, the imported GLB models the props bake from
(placements × per-copy triangles, with the ~150k baked-triangle flag the export log also raises), and the
sky's tier and page cost — plus two settings that change what is written:

- **bake lighting** (default on) bakes the authored sun into terrain lightmaps + `Lights.json`, independent of
  the viewport's sun preview toggle. Off ships no lighting, so a repack keeps the target level's original
  lights and `_L.ssh` verbatim (`003`).
- **AI path variation** controls seeded lateral variation across the six required Race/Freeride start routes.
  Off still writes six safe gate-to-center routes.

Confirm composes the folder in the browser and lands it: `buildExportFolder` (core) against the browser
byte provider, then the directory the author picked, or a store-only ZIP where the File System Access API
is absent (`037`). Nothing is posted; the server's part is the asset bytes the composition asks for.

## Preflight — what the props cost

A prop is three separate costs that run out at different times, so the dialog reports all three rather than a
placement count, and reads each against the shipped seven (`RETAIL_PROPS`, measured by
`npm run budget` — `tools/prop-budget.ts`).

| | what it is | who pays | retail band |
|---|---|---|---|
| **pages** | every tile a prop material names, flipbook frames included | the repacked level's texture bank, one slot each | 108–197 between terrain and props |
| **baked** | placements × per-copy triangles | the level, on the disc and in the Unity bundle alike | 19 238 – 273 720 of distinct geometry |
| **geometry** | distinct model triangles | nothing directly — it says how modular the map is | as above |

Pages are the one that bites, and it is not proportional to anything an author sees: a model wearing three
tiles spends three slots whether it is placed once or three hundred times, and a tile both painted on terrain
and worn by a model costs two (below).

**Baked triangles are read against retail's distinct-geometry band, not its baked one.** A shipped level
instances: GARI draws 2.7 M triangles from 274 k of geometry. An authored export does not — `canonical-props.ts`
writes one model row, one mesh file and one instance per placement, and `repack` appends all three — so a
243-triangle boulder placed thirty times is 7 290 triangles in the level. The model table grows one row per
placement with it, which is worth knowing before placing thousands of anything.

The section prices what the EXPORT writes, not what the document lists — trigger volumes carry no geometry
and a group placement bakes as its member models, so both are resolved exactly as `core/export/folder.ts`
resolves them (`015`). It covers borrowed, authored-cage and imported models alike; imported GLBs keep their
own section as well, because there the interesting question is which *import* is the heavy one.

The classifier stays pure. Model geometry, the source levels' material tables and the imported-model records
all live on disk, so `server/routes/preflight.ts` attaches this after the fact — the same arrangement the
imported-model summary already used.

### The same numbers, for every mountain in the library

Preflight prices the map being built. Scene ▸ Reference prices the ones it is being read against: the picker
carries the loaded mountain's props / triangles / pages / scene extras / sound, and **compare every mountain**
opens the whole library as one table with the shipped courses' range pinned under each column
(`app/ui/dialogs/mountain-stats.ts`, served by `/api/level-census`).

The table is read from the top, so the rows most likely to be the ones wanted are put there, in bands: **your
own mountain's export** first — matched by `exportFolderName` and dated from its `Slopesmith.json` mtime, which
is the only file an export always writes — then **mountains pinned by hand** (remembered in `localStorage`
under `slopesmith-mountain-pins-v1`), then **the shipped courses** while `include shipped courses` is on, then the
library. The search filters the library band only: a search here means "how does X compare?", and the rows it
is compared against are exactly the ones somebody chose to keep in view. Every band obeys the current column
sort, because pinning chooses what stays visible, not how it is read.

**Sound is four columns, not five.** Banks, slots, SFX megabytes and songs all vary per mountain. Collision
sounds do not: `Audio/SoundIndex.json` is the engine's table, and every extracted course carries the same 95
events over the same 66 clips with only the BANK each one points at changed. A column of it would read 95 for
every retail row and 0 for every authored one — a test of whether a folder came off a disc, which the export
date already answers. The two board banks (`zboard`, `zbxsfx`) are excluded from the counts for the same
reason: every level's import writes identical copies, so counting them adds ~140 slots to every row and buries
what differs.

One measurement feeds all three consumers — that panel, `npm run budget`, and any future reader — because the
arithmetic is `core/reference/census.ts` and the read is `server/routes/census.ts`. Measuring twice is how a
tool and a panel come to disagree about the size of a level; `test/level-census.test.ts` pins the four ways the
arithmetic is easy to get wrong (shared meshes counted once, flipbook frames counted per frame, invisible
instances excluded, baked ≠ distinct).

Pricing the library outright reads ~22 000 files and takes about 5 s, so it is measured once and kept
(`server/census-cache.ts`). Validating is not measuring: stamping those same files takes ~0.5 s, which makes a
warm library about nine times cheaper than a cold one, and a fresh server answers `/api/level-census` in ~0.4 s
instead of ~2.5 s. Entries live under `workspace/cache/level-census/<LEVEL>/<fingerprint>.json` — never inside
the map library — and the fingerprint is the file name, so a moved input is simply a miss. Three layers stack:
this one across runs, `responseCache` within a run (~3 ms), and an ETag so a reopened dialog revalidates to 304.

**Changing the census arithmetic means bumping `CENSUS_CACHE_SCHEMA`.** The fingerprint proves the input files
have not moved, which is exactly the case where a stale entry would otherwise be served forever after a change
to how those files are counted. `test/census-cache.test.ts` pins the invalidation boundary in both directions —
every parsed input moves the fingerprint (including inside the nested audio banks), and a lightmap re-bake
does not.

The dialog's **↻ re-measure** button (`/api/level-census?refresh=1`) drops both caches and reads every folder
again — about 3 s against 0.4 s warm, paid by the server for everybody, which is why the route asks the
moderator role of whoever sends it and the button is shown only to them. It exists because the fingerprint is
metadata, and metadata can lie: a
file restored from a backup, a copy that preserved timestamps, a clock that moved. Widening the fingerprint to
catch those would make every read pay for a case that almost never happens, so instead there is a way to ask.
It re-files what it measures, so the cost is the measurement once rather than the cache switched off; and it
re-prices the per-level rows in the Scene panel too, since a library answer and a single mountain's answer
disagreeing about the same folder is the state a manual refresh is supposed to end.

Re-measuring cannot help with the other reason a column reads zero — a service older than the page, which
`npm run dev` produces routinely because Vite hot-updates the client while the API deliberately survives across
saves. `normalizeMountainStats` / `normalizeLevelCensus` fill the missing groups so nothing throws, report that
they had to, and the dialog's amber footer says which case it is and that restarting the server is the fix.

## Preflight — one class per distinct tile

Each painted cell stores a tile ref `"<LEVEL>/<file.png>"` (`005`); `parseTexRef` yields `{ level, name }`.
Every **distinct** tile is one of two things, and un-painted cells form a third bucket:

| Class | Condition | Ships as |
|---|---|---|
| 🟢 **extracted** | the ref names a real level | that level's PNG, copied byte-for-byte under a flattened name |
| 🔴 **custom** | the ref names the `Custom` pseudo-level | the author's own PNG, likewise copied |
| ⚪ **default** | cell un-painted | a procedural SurfaceType tile generated at export (`003`) |

The classes describe the MAP. What a disc does with them — which slot each page lands in, what is reused,
appended or encoded, and what it costs in VRAM — is reported by the thing that installs the pages.

## The disc, in `snowknife`

`snowknife repack … --dry-run` runs the real pipeline up to the point of writing bytes and reports what it
would do: slots retained and reusable, pages to install in allocation order (each marked **reuse → slot N** or
**append**, with its shipped dimensions after the power-of-two snap), bytes retained/reused/free/appended
against the original bank, the custom-page aggregate against the proven-clean VRAM budget, whether the mountain
overlaps the target's footprint (reusing its `aip`/`sop`) or ships standalone, how the sky resolves, and
anything that will be dropped. `--json` emits the same plan as a record, which is what makes it assertable in a
test without building a four-gigabyte image. `snowknife texture-plan <exportDir> <LEVEL>` answers the texture
half of that with no disc at all.

Because a browser cannot spawn a CLI, the arguments are the thing most easily lost — so every export writes
them into its own folder:

- **`Repack.md`** — the exact invocations: `texture-plan`, a dry run, a stock-executable build with
  `--texture-type2 --bare-slot --no-skycolor`, and `repack-many` for several courses in one image. It rides
  as `GARI` and says so; the slot name and its extracted-data path are the two fields to edit. It also explains
  that menu availability still follows the retail mode/profile, documents the built-in title-screen cheat for
  a locked slot, and keeps noclip as a separately selected local inspection option.
- **`repack-many.json`** — the same build in `repack-many`'s own schema (`{InputIso, OutputIso,
  TextureType2: true, BareSlot: true, SkyColors: false, Levels[{Slot, LevelData, Export}]}`), already naming this export. Its
  relative paths resolve from the folder it sits in, so a dump dropped beside it runs as-is; more `Levels`
  entries build more courses into one image.

**The custom-page VRAM budget** is real but it is the tool's to report: a custom page is injected as type-5
32-bit, 4× the VRAM of a native paletted page, and **the aggregate is what breaks, not any single page**.
Measured on GARI in PCSX2 (MOUNTAIN29–31): ~0.64 MB of installed type-5 pages renders clean, ~2 MB corrupts
every custom page after the first (part-transparent, part-scrambled) even though the ISO bytes re-extract
bit-perfect. `--texture-type2` selects the retail GARI bank's shape instead — all 121 of its pages are type 2,
an unswizzled one-byte index plane with an unswizzled 256-entry type-33 RGBA palette and half-bright RGB/alpha
— at one byte per texel. MOUNTAIN32 verified that path in PCSX2 with 10 custom type-2 pages plus 3 borrowed
pages installed into unused GARI slots; all rendered and the bank stayed at 121 entries. Slopesmith's ready-
to-run recipe therefore selects type 2 explicitly; type 5 remains available by removing the flag or setting
`TextureType2` false, after the dry run proves its aggregate is inside the clean budget.

**Custom tiles are staged by name-shape, one per channel.** A custom tile on an authored *model* is staged by
the material combiner as `Textures/p_Custom_NAME.png` and resolved through the props build's
`custom/<TexturePath>` key. A *terrain-painted* custom tile stages as `Textures/Custom_NAME.png` and is
resolved through its `Slopesmith.json` entry. A tile both painted on terrain and worn by a model therefore
costs **two** pages, and the dry run says so. If a painted tile's PNG is missing from the export, the repacker
leaves the ref unresolved and the cell repoints to slot 0000 — stock art, no crash — so an in-game "my texture
became a default one" is a staging failure, not an engine limit.

## Coordinates

`editor → raw` is an exact bijection (`003`), so a mountain authored in a loaded reference level's own frame
exports straight back into that level's coordinates. `repack` uses that to decide placement: a mountain
inside the target's footprint reuses its `aip`/`sop`; one authored elsewhere ships its own and stands alone
([repack technical reference, "Coordinate alignment"](../../Snowknife/docs/repack-technical-reference.md#coordinate-alignment)).
Nothing about it is an export-time choice.

## Server: the preflight endpoint

`POST /api/preflight { doc }` runs the pure classifier over the posted document and attaches the
imported-model records, which live on disk. No new state is stored — the summary is derived from the document
on demand, and there is nothing to read off a target.

## Reference panel

The reference panel (`main.ts` `initReference`) carries no texture-target control: the panel keeps its level
picker + clear, terrain readout, course line, and "▶ new mountain from this course." That action opens the
Generate terrain from run dialog and uses the same generator; its only extra step is replacing the authored run
with the recovered reference course. The shared height control trims a shorter requested reference course or
extrapolates its downhill tail when a taller one is requested.

## Verification

`npm run smoke` asserts the folder end-to-end through the real `snowknife gltf` (`003`).
`npx tsx test/custom-textures.test.ts` asserts that a custom tile painted on terrain and worn by a model lands as both staged
pages with the manifest provenance behind them, and that the folder carries a complete disc recipe.
`npx tsx test/reference-export.test.ts` pins the reader that reopens an already-shipped keyed folder (`036`).
The disc itself is asserted in Snowknife, against `repack --dry-run --json`, and confirmed by booting a
patched ISO ([repack guide, "Verification"](../../Snowknife/REPACK.md#verification-without-booting)).
