# 220 — PBD Level File

The `.pbd` member of the level archive (`200-archives.md`) is the level's
world database: terrain patches, object instances, models and their meshes,
materials, lights, splines, cameras, texture flipbooks, and the mesh
geometry blob. It encodes the data model of `110-terrain.md` (patches),
`120-objects.md` (instances/models), `160-lighting-data.md` (lights, lightmap
references), and `170-materials.md` (materials, flipbooks). The skybox file
(`<stem>_sky.pbd`) is the same format. [observed] [[220-family]]()

Three things are deliberately *not* in the PBD. Names: every patch, instance,
material, light, spline, model, and camera is anonymous on disc; names and
name-hashes live in the `.map` linker manifest, index-aligned with the PBD
sections (`200-archives.md`). Behavior: per-instance gameplay properties
(collision, surface type, effect slots) live in the `.ssf`
(`230-level-ssf.md`), joined by instance index. Texture payload: the texture
count here only sizes an index space resolved against the sidecar `.ssh` bank
(`210-textures-ssh.md`). [observed] [[220-separation]]()

All multi-byte values are **little-endian**. Raw positions are in engine
units (centimeters, `002-conventions.md`). [measured] [[220-endian]]()

> [[220-family]]() doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs
> `ExtractTrickyLevelFiles` (loads `.map`, `.pbd`, `_sky.pbd`, `.ssh`, `.ssf`,
> `.ltg`, `.adl` off one stem).

> [[220-separation]]() doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs
> — names from `mapHandler.Patchs[i]` etc.,
> behavior from `ssfHandler.InstanceState[i]` → ObjectProperties, sounds via
> name-hash → `.adl`.

> [[220-endian]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/StreamUtil.cs
> LE defaults; scale: BezierUtil `CalcCoefficients` converts raw → meters ×0.01.

## Header (136 bytes)

Fifteen counts, then eighteen absolute file offsets. The file begins with a
four-byte tag `00 15 1B 01` that is a **three-byte version triple followed by
a one-byte platform code**: bytes 0–2 read "version 0.21.27" and are only
echoed to the debug log, never compared; byte 3 is the format code the loader
switches on — 0 generic, 1 PS2, 2 Xbox, 3 GameCube — and any other value
rejects the file. All four accepted codes take the identical parse path, so
the byte is validated but not otherwise consumed. The loader also refuses a
file declaring more than 4,000 models, because its load-time pointer tables
are fixed at that size. Every retail level and sky carries exactly
`00 15 1B 01`. [measured] [[220-header]]()

| Offset | Field | | Offset | Field |
|---:|---|---|---:|---|
| 0x00 | version 0.21.27 (3 bytes) + format code (1 = PS2; 0/2/3 accepted) | | 0x44 | patch section offset |
| 0x04 | player-start count (always 0) | | 0x48 | instance offset |
| 0x08 | patch count | | 0x4C | particle-instance offset |
| 0x0C | instance count | | 0x50 | material offset |
| 0x10 | particle-instance count | | 0x54 | material-block offset |
| 0x14 | material count | | 0x58 | light offset |
| 0x18 | material-block count | | 0x5C | spline offset |
| 0x1C | light count | | 0x60 | spline-segment offset |
| 0x20 | spline count | | 0x64 | flipbook offset |
| 0x24 | spline-segment count | | 0x68 | model pointer-table offset |
| 0x28 | texture-flipbook count | | 0x6C | models offset |
| 0x2C | model count | | 0x70 | particle-model pointer-table offset |
| 0x30 | particle-model count | | 0x74 | particle-models offset |
| 0x34 | texture count (sizes the `.ssh` index space) | | 0x78 | camera pointer-table offset (0 = none) |
| 0x38 | camera count (front-end map only; 0 in race levels) | | 0x7C | cameras offset |
| 0x3C | lightmap-size field (always 0) | | 0x80 | hash-section offset (0 = absent) |
| 0x40 | player-start offset (always 0) | | 0x84 | mesh-data offset (blob runs to end of file) |

Sections are written in the offset order above, with 16-byte alignment
between several of them; offsets are absolute, so readers need no layout
assumption beyond the header. [observed] [[220-header]]()

> [[220-header]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> `LoadPBD` head (read order = these offsets) / `SaveNew` (magic bytes, write
> order, AlignBy16 sites); player-start + lightmap-size fields dead in every
> observed level (starts come from the path files, `250-paths-aip-sop.md`).
> Engine: `CourseResolve_ParsePbdAndRelocate` `0x00255b60` (vtable slot +0x5c
> of `cCourseResolve_PS2`, vtable `0x003a88a8`, RTTI `0x003a89c8/0x003a89e0`):
> the three version bytes at `+0/+1/+2` are only printed, via `0x00255840`
> with a version format string `0x003a8438` (no compare); `lb v1,3(s2)` switch
> at `0x00255ba8–0x00255bdc` selects one of four platform-format name strings
> (`0x003a8450–0x003a8480`: generic, PS2, Xbox, GameCube), else `v0 = 0`
> return at `0x00255bc4/0x00255bdc`; all arms rejoin at `0x00255c30` and print
> every count/offset with its field label (`0x003a84a0–0x003a86f0`).
> Caller `CourseResolve_Resolve` `0x00252880` (slot +0x2c): `slti
> v0,[hdr+0x2c],4001` else error 6 at `0x002528c4` (stack tables `sw sp,8(s0)`
> / `sw sp+16000,12(s0)`), calls slot +0x5c at `0x002528e8`, `beq v0,zero →
> return 1` at `0x002528f0`. Quirk: the flipbook offset `+0x64` is relocated
> twice (`0x00255ecc`, `0x00256098`), harmless because the flipbook pointer
> table (`this+0x0C`, `0x002553c8`) is built between them. Survey: 23/23 PAL
> PBDs (11 courses, 11 skies, front end) carry `00 15 1B 01`. map:"PBD loader
> (cCourseResolve): validation, instances, LODs, splines, cameras, VIF".

## Patch record — 448 bytes

`patch count` records at the patch offset. The patch is the terrain unit of
`110-terrain.md`: a bicubic surface with texture/lightmap references and a
surface type. [measured] [[220-patch]]()

| Offset | Type | Field |
|---:|---|---|
| 0x000 | 4 floats | lightmap tile rectangle (x, y, w, h), normalized 0–1 within the 128×128 lightmap image (a lightmap page, `160-lighting-data.md`) selected by the lightmap ID below (texels = value × 128) |
| 0x010 | 4 × 4 floats | texture UV corners 1–4 (only x, y meaningful) |
| 0x050 | 16 × 4 floats | the bicubic surface, as **power-basis coefficients** (below) |
| 0x150 | 3 floats | bounding-box minimum |
| 0x15C | 3 floats | bounding-box maximum |
| 0x168 | 4 × 4 floats | the four raw corner control points (= bicubic cp0, cp12, cp3, cp15) in parametric order (u0,v0), (u1,v0), (u0,v1), (u1,v1); stored **parallel to** the four UV corners at 0x010, so `UVPoint_i` is the texture coordinate of corner `Point_i` (same index) |
| 0x1A8 | u32 | surface type, 0–18 (enumeration `110-terrain.md`, response `310-surface-response.md`; e.g. 1 snow, 3 powder, 5 ice, 9 rock, 17 no-collision, 18 show-off ramp) |
| 0x1AC | u16 | four packed 3-bit resource-kind tags for the four IDs at 0x1B0–0x1B6; retail `0x29` decodes to kinds 1, 5, 0, 0 |
| 0x1AE | i16 | visibility: negative = trick-only patch |
| 0x1B0 | i16 | texture index into the level `.ssh` bank |
| 0x1B2 | i16 | lightmap ID (which lightmap image — a lightmap page of `160-lighting-data.md`) |
| 0x1B4 | i16 ×2 | unused resource-ID slots (both −1) |
| 0x1B8 | u32 ×2 | unconsumed level-compiler residue; retail constants, safe to zero |

The loader treats the four halfwords from the texture index through the two
unused slots as one typed resource-reference array. The tag word selects which
index-remap table, if any, applies to each slot. The final two words do not
participate in loading, rendering, or collision; deterministic writers should
zero them rather than reproduce one retail build's authoring-process residue.
[[220-patch-tail]]()

> [[220-patch]]() PBDHandler.cs `struct Patch` read loop,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> lightmap texel scale ×128; corner
> point identities = rebuild lines (`Point1 = RawPoints[0]`, `[12]`, `[3]`,
> `[15]`) in TrickyLevelInterface; surface legend = handler comment +
> engine-side 20-record named table db:surface-types.

> [[220-patch-tail]]() db:pbd-patch-tail; @0x00260c28; @0x00260dc8;
> map:"PBD terrain-patch resource tail"; the two remappers walk four i16 IDs
> using four 3-bit tags from the preceding word. Retail survey: 29,381 patches
> across all 12 PAL course/front-end PBDs; final two words invariant but absent
> from every patch consumer. Reader/writer layout:
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.

### The 16 vectors are power-basis coefficients, not control points

The stored 4×4 grid holds the patch as **monomial (power-basis) coefficients,
highest degree first** — the last stored vector is the constant term (a patch
corner) — not as Bézier control points. The original engine consumes the
stored vectors directly in this form for both collision and rendering, so
this is the authoritative on-disc meaning; conversion to Bézier control
points is an exact monomial↔Bernstein basis change applied per row then per
column. The stored order is reversed row-major: row 4 column 4 first, row 1
column 1 last. [measured] [[220-power-basis]]()

Two consumer-side conventions apply to these records, owned elsewhere and
not to be conflated: the texture-UV corner-binding convention
(`110-terrain.md`) and the lightmap-tile orientation convention
(`160-lighting-data.md`). Adjacent patches' boundary control points are
near-equal but not bitwise equal — consumers that need watertight seams
must epsilon-weld (`110-terrain.md` "Continuity and seams").
[observed] [[220-orientation]]()

> [[220-power-basis]]() engine: collision Newton refinement consumes the four
> stored coefficient row blocks directly (record offsets 0x50 + k·0x40),
> db:terrain-collision @0x0025e480; renderer tessellates the same data on VU1,
> db:terrain-render @0x001da180; basis change
> doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/BezierUtil.cs
> `GenerateRawPoints`/`GenerateProcessedPoints`; reversed storage order =
> TrickyLevelInterface export/rebuild index mapping; Bernstein evaluation of
> the decoded points validated in practice.

> [[220-orientation]]() doc:../research/extracted-data.md "Terrain patch
> orientation and seam conventions" (UV corners pair index-for-index with the
> geometry corners = a transpose; lightmap transpose chosen by
> boundary-continuity scoring; epsilon-weld).

## Instance record — 256 bytes

`instance count` records at the instance offset. A PBD instance is purely
placement, lighting, model reference, bounds, and list links — all gameplay
behavior joins from the `.ssf` by instance index (`120-objects.md`,
`230-level-ssf.md`). [measured] [[220-instance]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | 16 floats | world transform matrix (row-vector layout; translation in the fourth row) |
| 0x40 | 16 floats | instance lighting, read as a second 4×4 then split **column-wise**: three light direction vectors + a fourth column whose role is unconfirmed, read as an ambient term [inferred] (`160-lighting-data.md`) |
| 0x80 | 4 × 4 floats | the paired light colors: three key colors + ambient color |
| 0xC0 | u32 | model index |
| 0xC4 | u32 ×2 | previous / next instance indices (linked list, −1 terminated) |
| 0xCC | 3 floats ×2 | world-space bounding box (min, max) of the transformed model |
| 0xE4 | u32 ×3 | runtime slots, zero on disc: the effect node bound to the instance; the live status word (`120-objects.md`); the pointer to the instance's behavior-file properties record |
| 0xF0 | u32 | **material-block index** — resolved at load to that block, and it is this per-instance block (not the model's) that the object draw, the texture-flipbook state and the material-randomising effect read; every retail instance names its model's own block, so per-instance material variants are a format capability retail never uses |
| 0xF4 | u32 ×3 | runtime scratch (first word zeroed at load, no reader found) and two words never written or read; zero on disc |

Only the material-block index is file data among the seven trailing words;
a writer may zero the other six. The transform's fourth column is genuinely
consumed by the 4×4 vector-unit multiplies and must stay (0, 0, 0, 1); the
lighting block's fourth column is (0, 0, 0, 1) and the colour block's
(0, 0, 0, 128) in every retail instance — the latter is the hardware's
"1.0" alpha on the ambient row. [measured] [[220-instance-runtime]]()

> [[220-instance-runtime]]() `CourseResolve_ResolveInstances` `0x00253930`
> (slot +0x64, prints a resolving-instances banner): `+0xc0` resolved to a
> model by index through `jal 0x00252810`; `+0xf0` resolved through the
> material-block pointer table at `this+0x08`, `0x00253978–0x00253998` (table built
> by `0x00255388` from `header+0x54`, count `header+0x18`); `sw zero,0xf4(s0)`
> at `0x0025398c`; `+0xc4/+0xc8` → `Pbd_GetInstance` or 0; stride 256 at
> `0x002539d8`; the same table indexes `model+0x0C` at `0x00253cb4–0x00253cc0`.
> SSF link pass `0x0025fac8`: default props `0x003d4070` → `+0xec`, flags →
> `+0xe8` (`0x0025fb90/0x0025fb9c`), then per instance `props = ssf[+0x38] +
> i*24` (`0x0025fd60`, `0x0025fd5c/0x0025fd70`). Readers of `+0xF0`: render
> submit `0x00199ba0` `lw a2,0xf0(v0)` → draw vtable +0x2ac
> (`RenderMethod_ObjectMeshes_vptr` `0x00394b2c` → `0x001e2468`, material-table
> arg indexed by mesh-entry `+0x04`), `TextureFlipState_Init`
> `0x00142b14–0x00142b68`, material randomizer `0x00145a20–0x00145a68`.
> Field scan (`+0xe4..+0xfc` off 26 base registers): every `+0xf8/+0xfc` hit is
> a `[lh adjust, lw fn]` vtable pair or an unrelated struct. Eleven-course
> survey: `+0xE4/E8/EC/F4/F8/FC` all zero; `+0xF0 == model.matBlk == model
> index` on 100 % of instances. W columns: instance matrix (0,0,0,1) and colour
> (0,0,0,128) in all 11 courses; matrix consumed by `ldc2 a0..a3` +
> `vmadda/vmadd` chains at `0x001e27d8–0x001e28f4` and `0x00199968–0x001999c4`;
> light block passed whole as `t0 = instance+0x40` at `0x00199b8c` (its VU1
> use not read).

> [[220-instance]]() PBDHandler.cs `struct Instance`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> semantics doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/InstanceJsonHandler.cs
> + doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs
> (Matrix4x4.Decompose, light split, ModelID join via
> `RegenerateLowestAndHighest`); per-instance prop lighting (three keys +
> ambient) validated in practice — see spec 160 anchors.

## Particle instance record — 112 bytes

A world transform (same 16-float layout), the particle-model table index at
`0x40`, a bounding box, and five unknown u32s. The model index is a real
many-to-one reference rather than an implicit parallel-table pairing: GARI's
10 placements happen to select 10 models and their names match, while ELYSIUM
has 59 placements selecting just 19 shared models. The library and current JSON
name it `ParticleModelIndex`. [measured] [[220-particle-instance]]()

| Offset | Type | Field |
|---:|---|---|
| `0x00` | f32[16] | world matrix |
| `0x40` | u32 | particle-model table index (`ParticleModelIndex`) |
| `0x44` | f32[3] | bounding-box minimum |
| `0x50` | f32[3] | bounding-box maximum |
| `0x5C` | u32[5] | unknown/reserved (`UnknownInt8`–`UnknownInt12`) |

> [[220-particle-instance]]() PBDHandler.cs `struct ParticleInstance`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> extracted PAL corpus: GARI 10 placements / 10 models, MERQUER 9 / 9,
> ELYSIUM 59 / 19. Resolving `ParticleModelIndex` against table order recovers every
> placement; a name-only join recovers only 19 of ELYSIUM's 59 placements.
> This is **not** an SSF effect-slot index, ordinary object/model index, sprite/
> texture index, name hash, or implicit same-row pairing.

## Materials and material blocks

A **material** record is 72 bytes. The two fields the renderer reads — the
texture index at `0x00` and the appearance-flags word at `0x40` — are
engine-confirmed; the eight floats are two colour blocks (consumed elsewhere or
unused), and the remaining span is reserved or file-scope constant: [measured]
[[220-material]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | i16 | texture index into the `.ssh` bank; −1 = untextured. The **only** field touched at load (remapped in place) and one of two the renderer reads |
| 0x02 | i16 | second index, unused (−1; one GARI outlier) |
| 0x04 | u32 | authored −1, inert — the loader never writes it (not a runtime handle slot) |
| 0x08 | 4 × f32 | **colour A** (RGBA) — default `(0,0,0,1)`; a dark red `(0.179,0.065,0.065,1)` on a few flag/billboard materials. Never read at runtime (authoring-only) |
| 0x18 | u32 | **file-scope constant**, replicated identically into every record (6 GARI / 11 ELYSIUM / 0 skybox). Not loader-written, never read — an offline level-compiler artifact |
| 0x1C | f32 | **file-scope constant** (≈ 1.156e5 GARI / 1.269e5 ELYSIUM; a denormal in skyboxes). Not loader-written, never read; a far/fog-distance reading is a data-side guess only |
| 0x20 | 3 × f32 | **colour B** (RGB) — quantized `{0, 0.5, 0.5124}` (`0.5` = the GS colour-doubling neutral, displays full-bright). Never read at runtime (authoring-only) |
| 0x2C | 5 × u32 | reserved, all zero across both levels |
| 0x40 | u32 | **appearance-flags word** (below) |
| 0x44 | i16 | texture-flipbook index; −1 = none |
| 0x46 | i16 | unknown (−1 or 0) |

The renderer treats the material as **TextureID + flag word and nothing else**:
the object draw loop reads only `0x00` and `0x40`, and the loader writes only
`0x00`. The two colour blocks and the file-scope constants are baked offline and
never consumed at runtime. The PBD itself is loaded **in place** (no per-record
copy): `Pbd_GetMaterial` indexes `base + i·72` from the relocated header, and a
block-resolver builds the pointer table the draw loop receives. [[220-mat-load]]()

The appearance-flags word at `0x40` is what the renderer dispatches on. Every
material carries a fixed set of base bits (3, 12, 14, 16); a whole-program scan
shows those base bits are **never branched on** anywhere — authoring/build
metadata, not runtime state. Only two higher bits drive the renderer. **Bit 18
is the alpha-pass selector**: set → the mesh takes the alpha/translucent draw
branch, clear → the opaque branch (`170-materials.md`). **Bit 17 is an opaque
draw-order priority bit**, consulted only on the opaque branch: it lowers the
material's opaque-draw sort key (`1022` when set vs `1023` default), nudging the
draw one rank earlier within its render mode. It is a painter's-order tiebreaker
so the coplanar decal/overlay props that carry it (`Mdl_Lcdscan`, the firework
cylinder, `Mdl_Finish_Coral`) draw in a deterministic order over the surface
they sit on (all bit 18 clear = opaque). The cutout-vs-blend split among
alpha-pass materials is a property of the referenced texture (a hole mask), not
a separate field. The library reads the whole word as
`TrickyMaterial.UnknownInt18`. UV-scroll and flipbook *rate* live in the `.ssf`
effect data, not here. [measured layout, engine-confirmed dispatch]
[[220-material]]()

A **material block** is a u32 count followed by that many u32 material
indices, records concatenated back-to-back and referenced by ordinal index.
Material blocks are the indirection between models and materials: a mesh's
material is `materials[block[model.materialBlockId][mesh.materialBlockPos]]`.
[measured] [[220-material-block]]()

> [[220-material]]() PBDHandler.cs `struct TrickyMaterial` (sequential read loop
> gives the byte offsets directly: i16 `0x00`, i16 `0x02`, u32 `0x04`, 4f
> `0x08`, u32 `0x18`, 4f `0x1C`, 5×u32 `0x2C`, u32 `0x40`, i16 `0x44`, i16
> `0x46`),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/MaterialJsonHandler.cs.
> Engine read-site `RenderObjectMeshes_MaterialDispatch` (db @0x001e2468): per
> mesh, material ptr = table[mesh+0x04]; `lh a1,0x00(s0)` = TextureID,
> `lw v1,0x40(s0)` = appearance-flags; alpha-pass test @0x001e2b5c
> (`& 0x40000`), opaque sub-mode test @0x001e2c08 (`& 0x20000`). Base bits
> 3/12/14/16 (`0x15008`) are constant across materials and never branched on.
> Field map + per-level value distribution: db topic `object-material`, struct
> `TrickyMaterial`. The eight floats' role is data-derived (two colour blocks,
> not read by this loop). Cutout-vs-blend is a texel property; flipbook guard
> `TextureFlipbookID != -1`.

> [[220-mat-load]]() PBD loaded in place by the `cCourseResolve` cluster:
> `CourseResolve_ParsePbdAndRelocate` (db @0x00255b60) checks the magic +
> version and relocates the header section offsets in place; `Pbd_GetMaterial`
> (@0x00255020) = `header+0x50 base + i·72` (bound by `header+0x14`);
> `Pbd_ResolveMaterialBlockToPointers` (@0x002544e0) builds the material-pointer
> table the draw loop gets as `a2`; `Course_RemapMaterialTextureIds`
> (@0x00260c28, twin @0x001862c8) is the only load-time per-material write and
> touches only `+0x00`. The `0x20000` sub-mode write lands at GS
> render-descriptor `+0x0e` (`RenderDescriptor_SetOpaqueSubmode` @0x001e98e0),
> which `RenderNode_BuildSortKey` folds into the opaque-draw radix sort
> (`1022` set / `1023` default); db topic `object-material`, struct
> `RenderDescriptor`.

> [[220-material-block]]() PBDHandler.cs `struct MaterialBlock`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> the join = TrickyLevelInterface mesh export
> (`materialBlocks[MaterialBlockID].ints[MaterialBlockPos]`).

## Light record — 92 bytes

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | type — 0 directional (the sun), 1 point, 2 decorative flare, 3 ambient (`160-lighting-data.md`) |
| 0x04 | u32 | glow-sprite resolution — 0 = none; observed 16/32 on some courses, 256/512 on others; low = a diffuse glow. Bake/authoring; no runtime drawer found |
| 0x08 | f32 + u32 | unknown |
| 0x10 | 3 floats | color (RGB, high-range) |
| 0x1C | 3 floats | direction |
| 0x28 | 3 floats | position |
| 0x34 | 3 floats ×2 | influence bounding box (min, max) |
| 0x4C | f32/u32 ×4 | unknown (radius/falloff candidates [open]) |

The records feed the **baked** lighting only — the loader resolves each cell's
inside/crossing light-lists against this table once, and nothing reads it
per-frame (`160-lighting-data.md`). On the example level the 942 lights split 842
of type 1, 98 of type 2, one each of types 3 and 0. [measured] [[220-light]]()

> [[220-light]]() PBDHandler.cs `struct Light`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/LightJsonHandler.cs;
> GARI distribution from the level's JSON export. Engine: type enum 0
> directional/sun, 1 point, 2 decorative flare, 3 ambient; records read only
> at load — per-cell inside/crossing light-lists resolved against the table
> by `PbdLights_ResolvePerCellIllum` @0x00252d10 via `Pbd_GetLight` @0x00254fb0
> (92-byte stride); exhaustive render-region scan finds no per-frame reader.
> spriteRes (+0x04) = glow-sprite resolution (16/32 Snowdream, 256/512 GARI)
> with no runtime drawer — the visible flare glow is the prop's particle
> plume; type-2 lights sit on `Mdl_Flare` props. doc:../research/light-flares.md.

## Splines and spline segments

A **spline** record (40 bytes) is a bounding box (min/max, 24 bytes), a
u32 that is zero on disc, a segment count, the index of its first segment in
the spline-segment section (one spline's segments are contiguous), and a u32
that is −1 on disc. Neither of the two constant words is file data: at load
the first is overwritten with the rail's runtime candidacy word and the
second with the behavior file's spline style, which the rail query then
reports as the rail's **surface type** (13 = off-track metal on every grind
rail; 12, 5 and 1 on other rails; −1 on mover paths) — so the spline's style
lives in the `.ssf`, not here (`140-paths.md`, `230-level-ssf.md`). [measured]
[[220-spline]]()

A **spline segment** record (128 bytes): [measured] [[220-segment]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | 4 × 4 floats | the cubic curve as **power-basis coefficients, highest degree first**: t³, t², t¹, constant (= segment start point) |
| 0x40 | 4 floats | cubic polynomial mapping arc length (in meters = raw units ÷ 100) to curve parameter t, highest degree first |
| 0x50 | u32 ×2 | previous / next segment indices |
| 0x58 | u32 | owning spline index |
| 0x5C | 3 floats ×2 | segment bounding box (min, max) |
| 0x74 | f32 | segment arc length (raw units) — the exact integrated length of the cubic |
| 0x78 | f32 | cumulative arc length before this segment |
| 0x7C | u32 | level-compiler residue: one constant value in all 4,879 retail segments, five bytes from the patch-tail residue, never read by the segment resolver or the rail query; safe to zero |

As with patches, the power-basis storage is engine-authoritative: the
original rail query evaluates the four stored vectors directly as
`P(t) = c₃t³ + c₂t² + c₁t + c₀` with the exact-derivative tangent, on the
64-byte block that is exactly offsets 0x00–0x3F of this record
(`350-rails.md` describes the riding model). [measured] [[220-segment-engine]]()

The arc-length polynomial was produced by an **unconstrained least-squares
cubic fit of parameter against arc length over 1,025 samples spaced
uniformly in arc length** (1,024 equal steps along the curve, the parameter
at each recovered by inverting the integrated length). Fitting that way
reproduces every tested retail coefficient set to single-precision rounding;
other sample counts, parameter-uniform sampling, a forced zero constant term
or pinned endpoints all miss by a hundred to ten thousand times more. The
fit is not exact at the ends (about 0.013 at zero length and 1.005 at full
length on the tightest example segment), which is inherent to it; a rebuild
that samples uniformly in the parameter is a close approximation, not the
original method. [measured] [[220-arclength-fit]]()

> [[220-spline]]() PBDHandler.cs `struct Spline`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs; style join
> `ssfHandler.Splines[i].SplineStyle` in TrickyLevelInterface (GARI: all 169
> splines style 13 = grind). Engine: `CourseResolve_ResolveSplines` `0x00254690`
> relocates only `+0x20` (→ `Pbd_GetSplineSegment` `0x00255080`); the SSF link
> `0x0025fdb4–0x0025fe18` writes `sw a0,36(v0)` (style → `spline+0x24`) at
> `0x0025fe00` and the candidacy word → `spline+0x18` at `0x0025fe08–0x0025fe18`;
> rail query `0x00259860` admission `lw a3,88(s0)` (`seg+0x58` = spline), `lw
> v0,24(a3); xori 1; andi 1 → skip` at `0x00259bf4–0x00259c04`, on accept `lw
> v1,36(a3); sw v1,52(t4)` at `0x0025a478–0x0025a488` → `output+0x34` →
> `RailMotion_State3CopyRailSurfaceId` `0x0010b1b8` (the load is off the
> spline pointer, not the segment). Surface table:
> 13 "off-track metal", 12 "no sound small wake", 5 "ice standard", 1
> "standard snow". Eleven-course survey: u1 = 0 ×1461, u2 = 0xFFFFFFFF ×1461;
> SSF records (1,1,13) dominant, (1,1,12) ELYSIUM/MESA, (1,1,5) ALASKA,
> (1,1,1) MESA, (−1,−2,−1) MERQUER/ELYSIUM movers.

> [[220-segment]]() PBDHandler.cs `struct SplinesSegments`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> arc-length coefficient semantics =
> doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/BezierUtil.cs `CalcCoefficients` (fits length→t over
> 200 samples, ×0.01 to meters) + rebuild write order. Engine:
> `CourseResolve_ResolveSplineSegments` `0x00254718` touches `+0x50/+0x54` (−1
> → 0) and `+0x58` (→ `Pbd_GetSpline` `0x00255050`: `hdr+0x5c + i*40`; segments
> `hdr+0x60 + i<<7`); `+0x7c` untouched. Survey: `+0x7c` = `0x0041CA8F` on
> 4,879/4,879 retail segments (patch-tail residue is `0x0041CA8A`); `+0x74` vs
> numerically integrated arc length rel. err. < 1e-6 on 400 segments (chord /
> control-polygon / Gravesen estimates differ by up to 2 %); `+0x78` cumulative
> with 0 mismatches.

> [[220-arclength-fit]]() `gari.py arclen` (a local `agents/pbd` analysis run, not shipped): 536/542 GARI segments
> nonlinear; uniform-in-arc-length least-squares refits vs stored
> coefficients — seg 7 |Δ| 2.66e-4 (n = 256), **2.25e-6 (n = 1024)**, 6.97e-5
> (4096), 8.66e-5 (16384); segs 8–12 |Δ| 2–9e-8 at n = 1024 vs ≥ 6e-7
> elsewhere; uniform-in-t fits n = 8…1000 |Δ| 2e-3–7e-3; no-constant fit
> 1.28e-2; stored poly(0) = 0.0128, poly(L) = 1.0054 (seg 7). 1024 vs 1025
> points and the tool's integrator are indistinguishable at float32.

> [[220-segment-engine]]() db:rail-geometry @0x00259860 (nearest-rail
> candidate walk), @0x0025a3e0 (derivative tangent), @0x0010b1b8 (rail surface
> id copy from the runtime segment block).

## Texture flipbooks

A flipbook record is a u32 frame count followed by that many u32 texture
indices (the same `.ssh` index space as material texture IDs), records
concatenated, referenced by ordinal index from materials. Frame *rate* is not
stored here (it comes with the effect data, `170-materials.md`). On the
example level 16 of 125 materials carry a flipbook. [measured] [[220-flipbook]]()

> [[220-flipbook]]() PBDHandler.cs `struct TextureFlipbook`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs;
> index→texture resolution doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs; GARI counts from the level JSON export.

## Models

The model section is reached through a pointer table: `model count` × u32 at
the model-pointer offset, each a byte offset relative to the models-section
offset. Models are referenced everywhere by ordinal index. [measured]
[[220-model-ptr]]()

### Model header — 56 bytes, then object headers

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | total record length (16-aligned) |
| 0x04 | u32 | object count |
| 0x08 | u32 | offset to the object-header array from record start (= 56; objects follow immediately) |
| 0x0C | u32 | material-block index |
| 0x10 | u32 | unknown |
| 0x14 | f32 | animation length, in 30 fps frames |
| 0x18 | 3 floats | **vertex dequantization extent** per axis: vertex = int16 ÷ 32768 × extent; 0 means 1. Not a transform scale |
| 0x24 | u32 ×5 | totals (mesh count, vertex count, tri-strip count, unknown, non-tri count) |

[measured] [[220-model-header]]()

### Object header — 24 bytes, offsets relative to its own start

Parent object index (hierarchy; mesh data is model-space), three LOD
mesh-header offsets (high/medium/low; 0 or −1 = none), an animation offset
(0 = none), and a matrix offset (−1 = none; else a 16-float local transform).
Shipped levels **reuse one offset for all three** LOD slots — across all
eleven courses and every sky, all 8,757 sub-objects have high == medium ==
low — and the engine never chooses anyway: the hierarchy resolver relocates
all three offsets (resolving each distinct mesh header once), but the object
renderer takes the **high** offset unconditionally for every object and
never reads the other two, with no distance comparison anywhere in the draw
path. Object-mesh LOD is a format feature with no runtime consumer; the
"near/far LOD" render options belong to terrain tessellation
(`400-rendering.md`). [measured] [[220-object-header]]()

### Mesh header and mesh entries

At an object's LOD offset: a u32 total length, the object's bounding box
(min/max), a u32 flags word, a u32 mesh count, a u32 face count, a u32
header-tail length, then `mesh count` × u32 entry offsets, then `mesh count`
28-byte mesh entries: entry length, **material-block position** (the
per-mesh index into the model's material block), mesh-data length, **start
position** (byte offset into the mesh-data blob), and three interior byte
marks. [measured] [[220-mesh-header]]()

> [[220-model-ptr]]() PBDHandler.cs model pointer loop
> (`ModelsOffset + ModelPointers[i]`),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.

> [[220-model-header]]() PBDHandler.cs model-header read; dequantization =
> `ReadMesh` vertex loop (i16/32768 × Scale) + `SaveNew` scale-fitting;
> AnimTime 30 fps frames doc:../research/extracted-data.md "Model object
> animation" (bridge 90 frames = 3.0 s).

> [[220-object-header]]() PBDHandler.cs `struct ObjectHeader`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs, + `SaveNew`
> relative-offset writeback; community writer emits one shared LOD offset.
> Engine: `CourseResolve_ResolveModelHierarchy` `0x00253d08` (prints its five
> field labels — parent id, three LOD offsets, animation offset — `0x003a7f50–0x003a7fa8`):
> `+4 += base` → mesh resolve slot +0x8c at `0x00253de0`; `+8` resolved only
> if `!= +4` at `0x00253e04`; `+0xc` only if `!= +4 && != +8` at
> `0x00253e30/0x00253e3c`; matrix `+0x14 == -1 → 0x00347640` (identity) at
> `0x00253e58–0x00253e74`. Draw loop `RenderObjectMeshes_MaterialDispatch`
> `0x001e2468`: object loop over `[model+0x08]`/`[model+0x04]`, `lw s7,4(a2)`
> at `0x001e29d0` (HI only), `lw v0,0x20(s7)` at `0x001e29dc`, stride `addiu
> fp,a2,24` at `0x001e2dd4/0x001e2dec`; no `+8`/`+12` loads and no `c.lt/c.le`
> in `0x001e29ac–0x001e2e08`. Survey: GARI 740/740, ALASKA 261/261, ALOHA
> 796/796, ELYSIUM 926/926, MEGAPLE 626/626, MERQUER 1875/1875, MESA 1235/1235,
> PIPE/SNOW/TRICK/UNTRACK likewise, skies 1/1. Terrain thresholds
> `cPS2BezierMan_Construct` `0x001da180` (`+0x10` = 3000 / `+0x14` = 15000) vs
> the menu bands at `0x00187760` [inferred link].

> [[220-mesh-header]]() PBDHandler.cs `struct ObjectData` / `struct
> MeshOffsets`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs; material join = TrickyLevelInterface mesh export.

### Object animation

At an object's animation offset: six floats (rest translation xyz in raw
units, rest rotation xyz in radians), a u32 **channel bitmask** (bit 0 X
position … bit 5 Z rotation, one channel entry per set bit in bit order), a
u32 channel count and array offset, then per channel: a u32 segment count and
offset, then `count` × 24-byte segments — four cubic coefficients (Horner
order, degrees) plus a start/end time window in seconds. This is the byte
layout behind the world-prop clip semantics of `120-objects.md`. [measured
layout] [[220-anim]]()

> [[220-anim]]() PBDHandler.cs animation read loops;
> doc:../research/extracted-data.md "Model object animation (`Models.json`) —
> the world-prop clip format" (channel mask, Horner sampling, degrees, rest
> pose at t=0).

## Particle models

Pointer table (u32 offsets relative to the particle-models offset), then per
record: a u32 byte size, a u32 emitter-header count, a u32 offset to the
header array (relative to record start), and five undecoded u32s. Each
16-byte emitter header holds an undecoded u32, a u32 object offset (relative
to the *header array base*), and two undecoded u32s. Each object: u32 byte
size, bounding box, undecoded u32, a u32 keyframe count + offset, then
28-byte keyframes — raw layout position xyz, rotation xyz, one undecoded
float, read per `180-particles-data.md` as a per-puff position, scale (the
rotation slot), and radius (the trailing float; reproduces the stored
cluster bounds to ~1%). Most of this record family beyond the keyframes is
undecoded [open]. [measured layout, inferred field semantics]
[[220-particle-model]]()

> [[220-particle-model]]() PBDHandler.cs particle-model structs;
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/ParticleModelJsonHandler.cs.
> The pointer table has `particle-model count` entries. This matters on ELYSIUM
> (59 instances / 19 models); an older library reader incorrectly looped over
> the instance count and over-read 40 words before consuming only the first 19.

## Cameras

Race levels ship zero cameras; the section is populated in the front-end
map (62 cameras). A camera record: u32 byte size, translation (3f), rotation
(3f), u32 type, focal length, aspect ratio, aperture (2f), near/far clip
(2f), interest point (3f), up vector (3f), animation length, and an animation
offset (relative to the record) to an animation block that is
**byte-for-byte the object-animation format** above — six rest floats
(translation, rotation), a little-endian 32-bit channel bitmask, a channel
count, the offset of the channel table, then per channel a segment count and
its segment-array offset, then 24-byte cubic segments (four coefficients plus
a start/end time in seconds; rotations in degrees). The engine resolves it
with the very routine it uses for model animation. Mask bits 0–5 are
translation/rotation x/y/z; the front-end cameras also animate bits 9 and 10
(aperture x/y), 11 (focal length), 12 (near clip) and 13–15 (three constant
channels of unassigned role). [measured] [[220-camera]]()

> [[220-camera]]() PBDHandler.cs `struct CameraInstance` + camera animation
> loops ("probably not right" handler comments; lines 619–656 `U0 =
> ReadFloat(stream, true)`, `Count/Action`, Vector3 pairs);
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/CameraJSONHandler.cs;
> GARI camera count 0; header comment "Used in SSXFE MAP". Raw SSXFE
> `ssxfe.pbd` cam 0: anim block at `cam+0x58` decodes to mask 0x83f, 7
> channels, table offset 0x24; cam 1 mask 0xfe3f, 13 channels;
> popcount(mask) == channel count; channel blocks `{count, segOff = 8}`;
> segments e.g. cam 0 ch5 `(0, 0, 0, −180.0003, 0.0, 3.0)` ↔ rest rot z =
> 3.14159 rad, ch6 c0 = 35.927 ↔ focal 35.921; cam 1 ch6..ch12 constants
> 1.4173/0.9449 (aperture), 25.0 (focal), 1.0 (near clip), 5.6/5.0/2.51327.
> Engine: `CourseResolve_ResolveCamera` `0x002548c8` (prints "Camera
> Length/Translation/Rotation/Type/Focal Length/Aspect Ratio/Aperture/Clip
> Plane/Interest Point/UpVector" `0x003a81d0–0x003a8270`) relocates `+0x54`
> and calls the animation resolver slot +0xa4 (`CourseResolve_ResolveAnimation`
> `0x002545a8`: `+0x20 += base`, count `+0x1c`, per channel `+0x04 += channel
> base` via slot +0xac `0x00254650`) at `0x00254af8` — the same slot the model
> hierarchy resolver calls at `0x00253e8c`.

## Hash section

When the header's hash offset is nonzero: a 52-byte header (u32 total length,
then six count/offset u32 pairs — patches [inferred], instances, particle
instances [inferred], lights, splines [inferred], cameras; offsets relative
to the hash section), then 8-byte
entries: u32 name hash, u32 object index into the respective section. The
hash is the linker name hash of `200-archives.md` — this section is how
external files (notably the `.adl` sound-attachment table) address
instances, lights, and cameras by name. [measured] [[220-hash]]()

> [[220-hash]]() PBDHandler.cs `struct HashData`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs; join = TrickyLevelInterface
> hash → ADL sound lookup via `MapHandler.GenerateHash`; the three
> question-marked slots are handler-comment guesses, only
> instances/lights/cameras are read in practice.

## Mesh data blob

Everything from the mesh-data offset to end of file is a concatenation of
PS2 DMA/VIF transfer packets; each mesh entry's start position points into
it. A mesh is one or more **chunks**; after reading a chunk, another chunk
follows if the byte 31 positions ahead is `0x6C` (the VIF "unpack 4×32-bit"
command). [measured] [[220-blob]]()

Per chunk, after 48 bytes of transfer tags: a u32 strip count, a u32 vertex
count (each padded to 8), and four data arrays separated by fixed-size tag
rows — the strip table (`strip count` × byte pairs (3 × the strip's vertex
count, 0), unpacked as two signed 8-bit components — reading each pair as a
little-endian i16 gives the same number only because the second byte is
always zero; strips never exceed 32 vertices), the UVs (`vertex count` × 2 ×
i16, fixed-point ÷ 4096),
the normals (3 × signed-normalized i16, decode ÷32768; encode +1 as 32767 and
saturate before narrowing), and the positions (3 × i16, ÷ 32768 ×
the model's per-axis dequantization extent), each 16-aligned. Chunks hold at
most ~50 vertices; meshes end with fixed terminator rows. [measured]
[[220-chunk-layout]]()

Vertices are stored strip-ordered with no index buffer; the arrays are
index-aligned. Within a strip, vertex i ≥ 2 emits a triangle (i−2, i−1, i)
with alternating winding: even faces in stored order, odd faces reversed.
[measured] [[220-strips]]()

> [[220-blob]]() PBDHandler.cs `LoadPBD` mesh loop + `ReadMesh` (the
> byte-at-31 continuation test), doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.

> [[220-chunk-layout]]() PBDHandler.cs `ReadMesh` (read) / `SaveNew`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs,
> `GenerateMesh` (write; authoritative literal tag rows incl. the DEADBEEF
> terminators). Full decode of the chunk stream (GARI blob+0, model 0 ctx 0),
> given as decoded fields rather than as the words themselves: DMA CNT qwc=6;
> VIF row = NOP, STCYCL 1/1, NOP, **UNPACK V4-32 ×2 → VU addr 0x0B** (cmd
> 0x6C) carrying a GIF-tag template (NLOOP = vertex count | EOP, PRE, PRIM
> 0x5C = tri-strip + Gouraud + textured + alpha-blend, NREG 3, REGS
> ST/RGBAQ/XYZF2) and the quad `(stripCount, 0, vertexCount, 0)`; strip row =
> **UNPACK V2-8, NUM = strip count → 0x0D** (the 0x66 cmd byte that "did not
> decode": cmd bits 6–5 unpack, bit 4 mask = 0, vn = 1 (V2), vl = 2 (8-bit));
> a DMA REF qwc=1 of the mesh entry's first mark (STMOD 1, STROW); a CNT
> qwc=73 whose stream sets STROW (0,0,4096,4096), STMASK `0x50505050`, STCYCL
> cl=3/wl=1 and **UNPACK V2-16 masked → 0x1B** (cmd 0x75; UVs; z/w filled with
> 4096 = the ÷4096 fixed point), then STMOD 0, STROW (0,0,0,32768), STMASK
> `0x40404040`, **UNPACK V3-16 masked → 0x1C/0x1D** (cmd 0x79; normals,
> positions; w = 32768 = the ÷32768 fixed point) — the cycle setting
> interleaves UV/normal/position as three quads per vertex from 0x1B; marks
> 0xe80/0xe90 = `0 0 0 deadbeef` terminators. So 0x6C is V4-32 unmasked, 0x75
> V2-16 **masked**, 0x79 V3-16 **masked**. VIFcode fields: cmd[31:24], NUM[23:16], ADDR[9:0], USN bit 14, FLG bit
> 15. Survey: 1,332 chunks / 6,638 strips, high byte 0 ×6638, max 96 = 32
> vertices, Σ(len/3) == vertex count ×1332. Mesh-context resolver
> `CourseResolve_ResolvePs2MeshContext` `0x00256150` prints
> "Length/Material Index/VIF Offset" and relocates entry `+0x0C` by
> `hdr+0x84`; the DMA REF mark fixup is a later pass (its two DMA-resolve
> banner strings sit at `0x003a87e0–0x003a8868`; not traced).

> [[220-strips]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/objTriPBDHandler.cs
> `GenerateFaces`/`CreateFaces` (winding), `GenerateTristripDataOneNew`
> (50-vertex chunk split).

## Variants and real counts

The Xbox port's `.xbd` sibling keeps the same patch concepts (UV corners
first, the same 16 reversed coefficient vectors, corner points) with
different surrounding fields and pre-tessellated index data; only its patches
are decoded. The GameCube variant has no decoder. [measured, partial]
[[220-xbd]]()

Garibaldi (PAL), as a representative size: 3,885 patches, 3,393 instances,
10 particle instances, 125 materials (16 flipbooked), 942 lights, 169
splines / 542 segments, 648 models, 10 particle models, 0 cameras, 16
lightmap images. Patch surface types span 9 of the 19 defined values.
[measured] [[220-counts]]()

> [[220-xbd]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/Xbox/XBDHandler.cs.

> [[220-counts]]() GARI JSON export of the real level (counts = PBD header
> counts by construction), TrickyLevelInterface; surface distribution
> doc:../research/extracted-data.md "Terrain surface labels" (0×622, 1×650,
> 3×1321, 4×390, 5×258, 9×540, 10×38, 17×6, 18×60; 60 trick-only).

<!-- DIRTY
Open questions (derivations: elf-map "PBD loader (cCourseResolve)"):
- Instance +0xF4: zeroed at load, no reader via base-register scan; decisive
  = data-flow over 0x0013a000–0x00149000 or a PCSX2 write-watch.
- Light/colour block W column (+0x40..+0xBF) on VU1 program 5: only matters
  if a writer deviates from (0,0,0,1)/(0,0,0,128). Patch/segment W = 1.0 are
  padding (EE evaluators use xyz only).
- Camera mask bits 13–15 (constants 5.6 / 5.0 / 2.513 in SSXFE): read the
  front-end camera player (consumer of cameraRec+0x54).
- DMA REF fixup of the mesh-entry marks (+0x10..+0x18): "RESOLVING MODELS
  DMA" pass (strings @0x003a87e0–0x003a8868) untraced; marks are blob-relative
  on disc.
- Material record +0x18/+0x1C: offline meaning (data guess: +0x1C ~ level
  far-distance); unread at runtime, so unconfirmable from the ELF.
- Light record +0x08 and the four +0x4C unknowns (radius/falloff/intensity?):
  no located reader. See research/light-flares.md.
- Header +0x64 double relocation (0x00255ecc / 0x00256098): confirm
  `Course_RemapMaterialTextureIds`'s +0x44 flipbook walk goes through the
  this+0x0C table rather than the header word (expected).
DIRTY -->
