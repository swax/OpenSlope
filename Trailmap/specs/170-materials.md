# 170 — Materials

A **material** binds a piece of geometry to a texture and to the small set of
appearance rules that decide how that texture is composited: its alpha mode,
whether it cycles through a sequence of frames, and whether its texture
coordinates scroll. This chapter defines the material data model. The on-disc
encoding of the material and flipbook tables is in `220-level-pbd.md`; the
texture banks themselves (and the half-bright storage convention) are in
`210-textures-ssh.md`; how the original renderer composites and animates the
result is in `400-rendering.md` and `410-texture-animation.md`.

## Where materials live

Material records belong to **objects**, not terrain. A terrain patch names its
diffuse texture **directly**, by an index into the level's texture bank, with no
material record in between (`110-terrain.md`); patches are always opaque or
cutout and never carry the flipbook or scroll machinery below. Object
sub-meshes, by contrast, resolve their texture and appearance through the
level's shared **material table**: a model's mesh slot names a material, and the
material names a texture. Everything in this chapter is therefore part of the
object path. [[170-where]]()

> [[170-where]]() terrain patch texture =
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> `Patch.TextureAssigment` (int16 index into the SSH bank, no material record);
> object materials = the same file's `TrickyMaterial` table indexed via a
> model's `MaterialBlock`. Export join
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs.

## The material record

Each material record carries, among fields not yet fully decoded: [[170-record]]()

| Field | Meaning |
|---|---|
| Texture reference | Index into the level texture bank; −1 for "no texture". |
| Appearance flags | A flag word; the established bit marks an **alpha-blend** material (below). |
| Flipbook reference | Index into the level's texture-flipbook table; −1 for "not animated". |

A material record carries **no name**. Levels do ship authored material names, but
only in the build's linker sidecar — the same file the instance and model names come
from (`120-objects.md`) — and that list is a **superset** of the runtime table: it
retains the materials of terrain patches, which the PBD flattens to a bare texture
index and drops (above). The two therefore do not correspond position for position,
and reading the *i*th name onto the *i*th material misattributes most of them. Order
is preserved, though, and each linker entry carries the number of times the build
referenced its material, so the runtime table can be **aligned back into** the list
rather than indexed into it. [measured] [[170-no-name]]()

A material with no flipbook reference uses its single texture statically. A
material with a flipbook reference draws a sequence of textures instead (see
*Material flipbooks*). [[170-record]]()

> [[170-record]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> struct `TrickyMaterial` (`TextureID` int16 at `0x00`, the appearance-flags
> word `UnknownInt18` at `0x40`, `TextureFlipbookID` int16 at `0x44`). The eight
> floats are two colour blocks — RGBA at `0x08` (default `(0,0,0,1)`) and RGB at
> `0x20` (`0.5` = GS-neutral) — that the mesh draw loop does not read; the rest
> of the record is reserved or a file-scope constant. Full byte map and
> per-level value distribution: `220-level-pbd.md`. Export
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/MaterialJsonHandler.cs.

> [[170-no-name]]() struct `TrickyMaterial` has no name member —
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.
> Names come from the map sidecar's `MATERIALS BEGIN` block, whose rows are
> `Name / UID / Ref / HashValue`
> (doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/MapHandler.cs
> `ReadBlock`); `UID` is the row index and `HashValue` is `bxStringHash(Name)`
> (reproduced on all 1821 rows across 10 retail levels), so neither is an
> independent key. Superset measured: map vs PBD material counts are 259/218
> MERQUER, 176/115 ELYSIUM, 219/126 GARI, 225/158 MESA, 189/110 SNOW, and the
> surplus names are terrain-shaped (`mainLeft_SN`, `powder_SN`,
> `Tex_Snow_Track_*`). `Ref` is an authored reference count, confirmed exactly on
> five levels by `Σ Ref == NumPatches + (mesh→material references)` — 4696, 5294,
> 4709, 3730, 3266, each matching to the unit. Order preservation shows up as
> monotone non-decreasing offsets between flipbook-bearing records and their
> `Flip_*` names (MERQUER +20 ×8 then +34; GARI +28, +31, +34, +60, +64, +77),
> the signature of interleaved insertions rather than a permutation. Derivation,
> the alignment method and its measured accuracy:
> doc:../research/extracted-data.md "Material names and the linker map".

## Alpha modes

A material composites in one of three modes: [[170-alpha]]()

- **Opaque** — the texture's alpha is ignored; the surface fully occludes.
- **Cutout** — an alpha *test*: texels below a threshold are not drawn at all,
  the rest are fully opaque. This is how foliage, fences, billboards, flags, and
  the crowd render their holes. The hole mask itself is a property of the texture
  (a hard transparent/opaque split in the alpha channel); the material flags only
  that it draws in an alpha pass (the bit below).
- **Blend** — alpha *over*: the texture is drawn semi-transparently over what is
  behind it (translucent glass, water surfaces, the lit LCD screens).

Opaque vs. translucent is marked **explicitly** in the material's appearance
flags — the alpha-pass bit (bit 18 of the appearance-flags word): **set** when the material
composites with the texture's alpha (either alpha-test cutout — tree leaves,
fences, flags, billboards — or alpha-blend — glass, water, LCD screens), **clear**
when the alpha is ignored (opaque — tree trunks, building skins, the media-tower
bodies). It must be read from this bit, *not* inferred from the pixels: the
half-bright store (below) keeps opaque alpha at `0x80`, so an opaque skin's window
texels and a translucent pane are byte-identical. The cutout-vs-blend split
*among* alpha-pass materials is then a texture property — a hard transparent/opaque
hole mask is cutout, a smooth partial-alpha band is blend. Blend is object-only;
terrain composites opaque or cutout, never blend. [[170-alpha-flag]]()

> [[170-alpha]]() the three-mode model + the blend examples (glass,
> `Mdl_Water_River`, LCD jumbotrons) are a clean reading of the texture and
> material data; texture alpha conventions per
> bit-depth in doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs
> (`AlphaFix`).

> [[170-alpha-flag]]() the alpha-pass flag is bit 18 (mask `0x40000`) of the
> appearance-flags word at material offset `0x40`
> (`TrickyMaterial.UnknownInt18`),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.
> Engine-confirmed: `RenderObjectMeshes_MaterialDispatch` (db @0x001e2468)
> reads `lw v1,0x40(s0)` and tests `& 0x40000` (@0x001e2b5c) — set takes the
> alpha/translucent draw branch, clear takes the opaque branch. Correlated
> against material role across GARI **and** ELYSIUM (no texture is shared by a
> set and a clear material): SET on every alpha-test material (tree LEAVES,
> fences, flags, billboards `Mdl_Billboard_*`) and every alpha-blend material
> (glass `Mdl_HalfPipeThing_Glass`, water `Mdl_Water_River`, LCD
> `Mdl_Lcd_ScreenLogo`); CLEAR on every opaque one (tree TRUNKS, building skins,
> `Mdl_MediaTower` bodies). Bit 17 (`0x20000`) is an **opaque draw-order
> priority** bit: on the opaque branch it sets render-descriptor byte `+0x0e`
> (`RenderDescriptor_SetSortKeySource` @0x001e98e0), which `RenderNode_BuildSortKey`
> (@0x001c7580) folds into the opaque-draw sort key — `1022` when set vs `1023`
> default. `RadixSort16` (@0x002d0dd8) sorts descending, so that draws it one rank
> **later** within its render mode — the correct end of the order for a coplanar
> decal, since the depth test passes on equality and the last draw wins
> (`RenderDrawList_SortByPriority` @0x001c4798). It is
> a coplanar-decal/overlay z-fight tiebreaker for the `0x35008` props
> (`Mdl_Lcdscan`, the firework cylinder, `Mdl_Finish_Coral`). What the ALPHA
> branch does with the same byte — `+0x0e = 2`, selecting a per-object quantized
> camera-depth ordinal from descriptor `+0x04`, which is what makes translucent
> object meshes draw back-to-front — is `400-rendering.md` "Draw order"; it
> changes no raster state, so the blend/alpha-test/z-write above are shared with
> the opaque path. The base word
> `0x15008` (bits 3/12/14/16) is authoring metadata (the whole-`.text` scan finds
> it is never branched on). [engine-decoded; bits 18, 17, base all resolved]

## Half-bright colour storage

Textures — including material-referenced ones — are stored at half
brightness; the storage convention and decode rules are owned by
`210-textures-ssh.md`. [[170-halfbright]]()

> [[170-halfbright]]() see `210-textures-ssh.md` "The half-bright
> convention" for the doubling rule, the alpha-channel extension, and the
> brighten-before-inspect ordering requirement.

## Material flipbooks

A **flipbook** is an ordered list of texture references — the frames of an
animation (waving start flags, panning LCD signage, the cheering crowd). The
level holds a flipbook table; a material opts in by naming one. Each flipbook
record is a frame count plus the list of texture indices, in display order.
[[170-flipbook]]()

The flipbook stores **which** textures and **in what order**, but not how fast.
The frame **rate** comes from elsewhere: an instance may carry a texture-flip
effect on its logic hook (`150-logic.md`) that supplies a speed and a direction,
and the crowd uses a fixed rate. A material's identity for caching purposes is
therefore the full frame list, not just a base texture — two materials that
share a base texture but differ in frames are distinct. The crowd's frames are
not even in the level data: the level material is a placeholder, and the real
cheer sequence is a shared disc asset. Flipbook playback timing is specified in
`410-texture-animation.md`. [[170-flipbook-rate]]()

> [[170-flipbook]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> struct `TextureFlipbook` (`ImageCount`, `ImagePositions` = texture indices);
> a material opts in via `TrickyMaterial.TextureFlipbookID ≥ 0`. GARI: ~16
> materials use flipbooks (start flags, LCD signs, `4x4_people`).

> [[170-flipbook-rate]]() rate/direction = the SSF texture-flip
> effect, db topic via doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> struct `TextureFlipEffect` (`Direction` 0=fwd, `Speed`); crowd frames are the
> shared disc asset `DATA\TEXTURES\CROWD.SSH` (placeholder `TextureID` in the
> level). Observed GARI rates {1, 3.5, 4, 8} fps.

## UV scroll

A material's texture can **scroll** — its texture coordinates advance every tick
to make a surface appear to flow (river water, conveyor stripes, the boost-pad
chevrons, LCD scanlines). Scroll is attached at the **instance**, not baked into
the material: an instance flagged for UV scroll (`120-objects.md`) carries a
scroll effect on its logic hook giving a mode, a per-axis scroll rate, an
active/pause cycle, and an optional total lifetime. [[170-scroll]]()

The mode controls the motion within that cycle: [[170-scroll-mode]]()

| Mode | Motion during the active interval |
|---:|---|
| 0 | constant-rate linear motion; the next interval continues in the same direction |
| 1 | eased ping-pong; a triangular rate envelope rises from zero to half the authored rate, returns to zero, then reverses |
| 2 | constant-rate ping-pong; direction reverses at each active-interval boundary |

Every other numeric value follows mode 0's linear path in the native update
routine. `U3` is the active duration in seconds, `U4` is the stopped duration
between active intervals, and `U5` is the node lifetime in seconds; zero
lifetime leaves it installed until its effect slot unloads. Offsets wrap at one
texture repeat, independently of those timing fields. [[170-scroll-timing]]()

Scroll rates are expressed in texture-coordinate units per tick. The clock,
the per-tick advance/wrap update, and the resulting cannot-be-flattened
constraint are runtime consequences specified in `410-texture-animation.md`.
[[170-scroll-rate]]()

> [[170-scroll]]() the UV-scroll marker is instance properties
> `BitFlags` bit 13 (`120-objects.md`); the parameters are the SSF effect
> struct `UVScrolling` (`U0` mode, `U1` H-scroll, `U2` V-scroll, `U3` active
> seconds, `U4` pause seconds, `U5` lifetime seconds),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.

> [[170-scroll-mode]]() `UVScrollNode_Update` 0x001422E8: exact mode 1 takes
> the triangular-envelope branch at 0x001423F8; modes 1 and 2 negate both rates
> at 0x001423B0–0x001423EC; all other values take the direct-add branch at
> 0x001425A0. The retail corpus uses modes 0 and 2; mode 1 is live engine
> behavior but was not found in the extracted course set,
> doc:../research/effects-semantic-names.md.

> [[170-scroll-timing]]() `UVScrollNode_Update` 0x001422E8 increments the shared
> phase by 1/60, switches from active at `U3`, waits through `U4`, and wraps the
> resulting U/V offsets at ±1. `UVScrollNode_ConstructFromEffectPayload`
> 0x00141FF8 reads `U5` as f32, multiplies by 60 and rounds it into the optional
> node-frame countdown. The previous horizontal/vertical “length” labels came
> from an unverified field-name guess and are superseded by this runtime use.

> [[170-scroll-rate]]() rates are UV units per 60 Hz global tick
> (db:timestep, `002-conventions.md`); GARI: 44 `Mdl_Water_River` segments plus
> LCD/boost scrollers, ~67 instances at 8 distinct speeds,
> doc:../research/extracted-data.md.

## Sprite blending is not material data

One blend decision is **not** carried by materials at all. Particle **sprites**
(snow spray, sparks, fireworks, gem twinkles) are composited **additively** by a
dedicated render path that ignores the material's alpha mode entirely, while the
carved-wake trail uses ordinary alpha. The choice is fixed by which render path
the geometry takes, not by any per-material flag, so it is specified with the
particle data and the render model rather than here (`180-particles-data.md`,
`400-rendering.md`). [[170-sprite-blend]]()

> [[170-sprite-blend]]() the sprite renderer
> hard-codes the additive GS blend enum 5 (`Cs·As + Cd`), bypassing the
> material path; generic alpha-blend materials use enum 3, but the carved
> wake is a dedicated two-pass draw with its own enum 4/8 pair, not the
> generic material path (`400-rendering.md`). Translator 0x001c08e0, table
> 0x00391ad0; terrain/prop materials carry their own blend bytes in the
> render descriptor (+0x15/+0x17), map:"Render z-state — the board is NOT
> drawn".
