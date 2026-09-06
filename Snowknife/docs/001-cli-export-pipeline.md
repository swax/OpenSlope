# 001 — CLI Export Pipeline

The first half of the port: `snowknife` rips a level **straight out of the game ISO** into plain
interchange files (JSON / OBJ / PNG) that the Unity importer (Unity docs 003–009) then assembles. This doc
is the **producer** side — what the commands are, what `import` runs end-to-end, and the file contract
the importer depends on. Targets `ssx-tricky.iso` (PAL).

Code: `Cli/Commands.cs` (the command table — each subcommand's handler and help in one row), `Services/`
(one class per command group), and the exporters in
`Export/` — `PropsExporter.cs`, `PropsCollisionExporter.cs`, `SkyboxExporter.cs`,
`LightmapExporter.cs`, `CharExporter.cs`. Terrain has no OBJ exporter: `Bundle/TerrainBundle.cs`
tessellates `Patches.json` straight into the bundle. Built on the cross-platform `SSX-Library`; reads
the ISO via `DiscUtils` (no mounting).

## Commands

| Command | Does |
|---|---|
| `iso-ls` / `iso-extract` | browse / pull a file out of the ISO |
| `ssh-extract` | decode an EA `.SSH` texture bank to PNGs (e.g. shared `DATA\TEXTURES\CROWD.SSH`) |
| `big-ls` / `big-extract` | list / extract a `.BIG` archive |
| **`import <iso> <courseSlot> <mapDir>`** | the one-shot: import a Tricky course into the canonical Maps folder |
| `rider <iso> <name> [outDir]` | export a rider + **measure its height** (the world-scale anchor — see [004](../../Unity/docs/unity/004-orientation-and-scale.md)) |
| `props` / `skybox` / `lightmaps` / `particles` | re-run a single export stage against an already-imported map dir |
| `board-sound-index <iso> <sharedDir>` | interpret the boot ELF's board-surface dispatcher → `Audio/BoardSoundIndex.json` (also run by `shared`) |

## What `import` runs

`import` mirrors the game's own load flow and then layers the exporters on top:

1. Pull `<NAME>.BIG` from the ISO → `BIG.Extract` → find the `.map` →
   `TrickyLevelInterface.ExtractTrickyLevelFiles`. This emits the base data: `Patches.json`,
   `Instances.json`, `Models.json`, `Materials.json`, the SSF logic, per-model OBJs + `Textures/`, and
   the raw terrain lightmap `<level>_L.ssh`.
2. **`LightmapExporter`** re-exports `Lightmaps/*.png` (alpha → grayscale — gotcha 1).
3. **`ExtractCrowdFrames`** decodes the shared `CROWD.SSH` → `cd00..cd15.png` (gotcha 2).
4. **`PropsExporter`** → `Props.obj` (+`.mtl`) from `Instances`+`Models`+`Materials`; also tags
   UV-scroll submeshes and writes `Scroll.json` / `Flip.json` (the animation tables — [008](../../Unity/docs/008-texture-animation.md)).
5. **`PropsCollisionExporter`** → `PropsCollision.obj` from the per-model collision proxies
   ([009](../../Unity/docs/009-collision.md)).
6. **`SkyboxExporter`** → `Skybox.obj` (+`.mtl`) with `Skybox/Textures/`, plus a measured
   `Skybox/Ring.json` composition contract ([006](../../Unity/docs/unity/006-skybox.md)).

Alongside the geometry it writes two records that are *about* the folder rather than in it: `World.json`, the
per-course world configuration the executable carries rather than the level files, and `Origin.json`, which
says what the folder is — `retail`, carrying retail data. Slopesmith's export writes the same `Origin.json`
contract with its own answer, so a consumer can tell an extract from an authored mountain, and either from an
authored mountain that borrows retail art. A folder with no `Origin.json` is read as retail, which is what
every library extracted before the contract existed looks like. Slopesmith shows it as the origin row under
its Reference picker ([038](../../Slopesmith/docs/038-hosted-sessions.md#map-origin)).

It finishes by printing a checklist of which output files exist.

## The file contract (producer → consumer)

Each file the importer reads is produced here; this is the seam between the two halves:

| File(s) | Produced by | Consumed by |
|---|---|---|
| `Patches.json` | base extract | [002](../../Unity/docs/unity/002-terrain-geometry.md) / [007](../../Unity/docs/unity/007-terrain-lighting.md) |
| `Instances.json` | base extract | [003](../../Unity/docs/unity/003-props.md) / [010](../../Unity/docs/unity/010-object-lighting.md) |
| `Materials.json`, `Textures/` | base extract | [005](../../Unity/docs/unity/005-materials-and-alpha.md) |
| `Props.obj` | `PropsExporter` | [003](../../Unity/docs/unity/003-props.md) |
| `Lightmaps/*.png` | `LightmapExporter` | [007](../../Unity/docs/unity/007-terrain-lighting.md) |
| `Scroll.json`, `Flip.json`, `cd*.png` | `PropsExporter` / `ExtractCrowdFrames` | [008](../../Unity/docs/008-texture-animation.md) |
| `PropsCollision.obj`, `Collision/` | `PropsCollisionExporter` | [009](../../Unity/docs/009-collision.md) |
| `Skybox.obj`, `Skybox/Textures/`, `Skybox/Ring.json` | `SkyboxExporter` | [006](../../Unity/docs/unity/006-skybox.md) |
| `Shared/Audio/BoardSoundIndex.json` | `SoundIndexService` via `shared` | Slopesmith board-audio routing |
| `<LEVEL>/Audio/Environment.json` | `SoundIndexService` via `sound-index` / `sfx` / `import` | Unity + Slopesmith off-board fallback |
| `Origin.json` | `MapOrigin` via `import` (and Slopesmith's export) | Slopesmith's Reference picker origin row ([038](../../Slopesmith/docs/038-hosted-sessions.md#map-origin)) |

## Gotchas

### 1. The terrain lightmap stores the GS blend's two terms
`<level>_L.ssh` is a FullColor RGBA bank holding the game's GS lighting blend: **alpha = A_S** (light
intensity) and **RGB = C_S** (a source-colour residual — a faint tint, blue always 0). The library's
default `BrightenImage` export discards alpha and produces dark/orange PNGs on this bank; `LightmapExporter`
keeps the **raw RGBA** instead (guarded to `FullColor`) so the terrain shader can reconstruct `(C_D − C_S)·A_S`.
The full lighting story is [007](../../Unity/docs/unity/007-terrain-lighting.md).

### 2. Some art is shared across the ISO, not in the level file
The crowd isn't in the level's texture bank — it's `DATA\TEXTURES\CROWD.SSH`, a shared 16-frame
animation reused on every course (the same old-PS2 `SHPS` shape variant as the level banks, not the later mixed-case `ShpS`). It
has to be decoded separately (`ExtractCrowdFrames` / `ssh-extract`). Same theme as
[008](../../Unity/docs/008-texture-animation.md) gotcha 1: don't assume everything a level needs is inside the level.

### 3. `BrightenImage` must saturate, not wrap
The PS2 "modulate2x" inverse (`*2 − 1`) needs a saturating clamp to `0..255` before the cast to `byte` —
clamping to `0..256` instead wraps (`(byte)256 == 0`), blacking out any *source* channel ≥ 129. This is
easy to miss because PS2 art authors "white" at ~128 (×2 → 255), so only genuinely bright source pixels
trip it; lightmaps bypass brighten entirely, so they're unaffected.

### 4. The two halves must agree on conventions — encode them once, on both sides
The terrain texture-UV binding is encoded identically on the producer and consumer sides
([002](../../Unity/docs/unity/002-terrain-geometry.md)): each stored `UVPoint_i` pairs index-for-index with the patch's
geometry corner `Point_i` — an off-diagonal **transpose** of the bilerp corners. The producer and
consumer share conventions (UV corner binding, X-handedness, raw-vs-scaled space), so they're written
explicitly on both sides rather
than left implicit — otherwise a change on one side silently desyncs the other.

### 5. The `*2` half-bright brighten is needed on **every** displayed SSH bank, not just level textures
The PS2 GS doubles texture colour at draw (modulate2×, stored `0x80` == `1.0`), so EA's SSH art sits at
**half brightness** on disc — opaque pixels cap at ~128. The level/skybox path applies the inverse
`BrightenImage` (`*2 − 1`, gotcha 3); any other **displayed** bank decoded straight to PNG without it
imports uniformly dim (diagnostic: a decoded PNG whose opaque pixels max at exactly 128). Three displayed
banks besides the level/skybox path need it:
- **board deck skins** (`ExportBoardTextures`, `TEXPS2.BIG` → [018](018-board-assets.md)),
- **crowd flipbook** (`ExtractCrowdFrames`, `CROWD.SSH` → [008](../../Unity/docs/008-texture-animation.md)) — also
  premultiplied, so the brighten runs *before* the decode-time un-premultiply (`TextureFinish`,
  [005](../../Unity/docs/unity/005-materials-and-alpha.md)); composes correctly (premult detector still fires),
- **particle sprites** (`ExtractParticleSprites`, `PARTICLE.SSH` → [014](../../Unity/docs/unity/014-particles.md)) — a *mixed*
  bank: 27 of 38 store full-range and 11 are half-bright (the glow/explosion art `clod`/`halo`/`snfl`/
  `ex06`–`ex09`/`exlm`). This bank brightens with a **per-image guard** (`BrightenImage(guard: true)`): it
  scans each sprite's opaque texels and doubles only the half-bright ones (≤ `0x80`), leaving the
  full-range sprites (`fog0`, `envr`, `brk*`, the `str*`/`swd*`/spray art) untouched so their mid-tones
  don't clamp toward white.

The crowd and board banks brighten unconditionally; the particle bank is per-image guarded. Because the
particle bank is the same shared art for every level (no per-level index), it has its own standalone
re-decode command — **`snowknife particles <iso> <levelDir>`** — so the sprites can be regenerated without
a full `import` rerun.

## Diagnostics

- **`import` prints a final file checklist** (Props.obj / PropsCollision.obj / Skybox.obj
  present?), so a stage that silently produced nothing is obvious without diffing the output dir.
- **Headless Blender validation** (`Blender/blender_validate.py`) imports the OBJs to confirm geometry
  + materials resolve, independent of Unity — the producer side is verified before the importer ever
  sees it.

## Note

`snowknife` (in `Snowknife/Snowknife/`) references `SSX-Library` as a **sibling** `ProjectReference`; the
library is a git submodule of this repo, checked out at `Snowknife/SSX-Library/`. The raw work dir (including the
untouched `_L.ssh`) is left under `%TEMP%/snowknife_*`
for inspection.
