# 240 — MPF Model Format

The `.mpf` model file carries rider and board models: bind-pose meshes,
materials, the skeleton, skinning palettes, and morph targets. Rider models
ship as `<name>_body.mpf` + `<name>_head.mpf` pairs in the rider-model
archive, and the single shared board model as `board.mpf` in the board
archive (`200-archives.md`). Animation clips are **not** in the model file
(they live in `.afl` side-files, end of chapter). [observed] [[240-role]]()

A second, unrelated format shares the `.mpf` extension: the interactive-music
graph (`270-music-graph.md`). The two are distinguished by the first four
bytes: the model file starts with a small-integer format id, the music file
with ASCII `xDFP`. The Tricky PS2 model id is **8** (3 = SSX 2000, 13 = SSX 3,
14 = On Tour). All multi-byte values are little-endian; strings are
fixed-length ASCII, NUL-stripped. [measured] [[240-detect]]()

> [[240-role]]() board + rider export verified in practice; rider roster +
> paths in the ELF strings table:
> `data/char/mac_body.mpf` @0x0039c6f0, `data/char/mac_head.mpf`
> @0x0039c878, `data/char/board.mpf` @0x0039f098; disc measurement
> (`200-archives.md` sweep): MDLPS2.BIG = 26 body/head members **plus
> `data/char/board.mpf`** (9,805 bytes, its 27th member), BRDPS2.BIG = the same
> single file — the disc ships it twice, byte-identical, and both archives are
> mounted at start-up (`0x0017be10`: `data/char/mdlps2.big` `0x00386c68` →
> slot+0x38, `data/char/brdps2.big` `0x00386c80` → slot+0x3c via `0x002ca128`);
> the engine loads it by the full name `|data/char/board.mpf` (table
> `0x00343198`, used at `0x00201d9c`), so which mount satisfies the lookup is
> a mount-order detail. Loader: `RiderModel_BuildLoadRequest` `0x00201c88`
> (callers `0x00111290/0x001112b0` in boarder init; body table
> `0x00342bc8[charIdx]`, head `0x00342c00`, suit/boot ssh `0x00342c38`,
> head/helm ssh `0x00342ee8`, board ssh `0x00342f50`; whole-file load
> `0x002c9c48`) → `RiderModel_BindSubModels` `0x00201630` — `[[240-loader]]()`.

> [[240-detect]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/MpfHeaderChecker.cs
> `DetectFileType`; LE = StreamUtil defaults;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs
> `Save` writes 8 (re-saved files accepted by the game = round-trip evidence).

## File layout

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | format id = 8 |
| 0x04 | i16 | sub-model count |
| 0x06 | i16 | directory offset (= 12; the directory follows immediately) |
| 0x08 | u32 | data start — absolute offset where the per-model data blobs begin (= 12 + 80 × count + 4) |
| 0x0C | … | sub-model directory: count × 80-byte entries, then 4 unused bytes |

One `.mpf` is a **container of sub-models**: a rider body file holds the body
at three LOD tiers plus a shadow model; the board file holds six deck shapes
plus shadows. [measured] [[240-layout]]()

### Directory entry — 80 bytes

| Offset | Type | Field |
|---:|---|---|
| 0x00 | char[16] | sub-model name — the engine binds fixed names with a 15-character bounded compare: `Body3000`/`Body1500`/`Body750`/`BodyShdw750`, `Head3000`, `Face3000`, `Eyes3000`, `Goggles3000`, `<Name>Hair3000`, per-character packs (`KaoriPack3000`…), and the board decks `Bx`/`Fr`/`Al` (+`Goofy`) with shadows `ShdwBx`/`ShdwFr`/`ShdwAl`/`ShdwAlGoofy` |
| 0x10 | u32 | data offset, relative to the file's data start |
| 0x14 | u32 | data blob byte size — the loader copies exactly this many bytes, so anything after a blob is ignored by construction |
| 0x18 | u32 ×7 | section offsets, all relative to this model's own blob: bones, IK points, mesh groups, mesh data, materials (= 0; materials come first), weight-reference lists, weight palettes |
| 0x34 | 8 bytes | never read (the entry is copied whole, but only the size, the seven offsets, the seven counts and the file id are consumed); zero in every retail file |
| 0x3C | i16 ×7 | counts: weight palettes, weight-reference lists, mesh groups, bones, materials, IK points, morph keys |
| 0x4A | i8 | **file id** — read as a signed byte; referenced by cross-file bone parents and skinning (below), and it selects the heap (1 = the board heap, else the rider heap) and names the animation record a clip binds to (`.afl` below) |
| 0x4C | 4 bytes | never read; zero in every retail file |

[measured] [[240-directory]]()

The loader binds each named sub-model into one of four "LOD sets" (3000 /
1500 / 750 / shadow): it deep-copies the directory entry and blob into a
heap chosen by file id, relocates every blob-relative offset into a pointer,
then de-duplicates weight palettes across the set (overwriting the palette
header's constant with a unique-palette index), registers every material
texture id with the texture bank, rewrites each mesh-group header in place
(material section), scales bind translations and IK points by the rider's
model-scale value, and builds one animation record per distinct file id with
bind and inverse-bind matrices. Chunk submission at draw time is a DMA
reference of the chunk bytes exactly as stored, preceded by an upload of the
group's blended skin matrices; the vector unit does the skinning. [measured]
[[240-loader]]()

> [[240-loader]]() `RiderModel_BindSubModels` `0x00201630`: `MpfView_Open`
> `0x00208960` (view+0 = file, +4 = file + `[file+6]`, +8 = file + `[file+8]`);
> bind wrapper `0x00201610` → `MpfView_FindSubModel` `0x00208980` (count = `lh
> file+4`, stride 80, `strncmp(name, 15)` `0x002fe578`) → `ModelSet_AddPart`
> `0x00206fb8` (slot map `set+8[fileId]`; 72-byte parts at `[set+4]`; 4 sets of
> 0x5900 B, ids 0..3) → `MpfPart_LoadDirectoryEntry` `0x00205578` (heap select
> on `lb dir+0x4a == 1`, copy 80 B to part+0xc, alloc `dir+0x14` bytes at
> part+0x10, memcpy `0x002fc494`; relocations `dir+0x18` bones → part+0x18,
> `+0x1c` IK → part+0x1c, `+0x20` groups → part+0x34, `+0x28` mesh → part+0x20,
> `+0x2c` wref → part+0x30, `+0x30` palettes → part+0x2c; counts `lhu
> dir+0x3c/+0x3e/+0x40`); dir reads elsewhere: `0x002059e8` (`lh +0x42/+0x46`),
> `0x00205ab8/0x00205b68` (`lh +0x44/+0x40`), `0x00207690` (`lh +0x42/+0x48`, `lb
> +0x4a`); scan of lw/lh/lb at +0x34..+0x3a and +0x4c..+0x4e over
> `0x00204000–0x0020a000` = only list-node vtable hits (`0x00203ff8`,
> `0x002040d0`) and a set flag (`0x00207c28`). Palette dedup
> `ModelSet_DedupWeightPalettes` `0x00207108` (compare `0x00207080/0x00207058`,
> writes `palette hdr+8 := unique index`, `set+0x50/+0x54`); texture
> registration `MpfPart_RegisterMaterialTextures` `0x00205ab8` →
> `TexBank_Register` `0x002049b8` (5 slots × 4 chars); group rewrite
> `MpfPart_RewriteGroupHeaders` `0x00205b68`; `MpfPart_ApplyModelScale`
> `0x002059e8` (called `0x00207364` with f12 = `rider[+0x60]` via
> `RiderModel_SetScale` `0x00208718`); `RiderModel_LinkPartsToAnimRecords`
> `0x00207690` (0x394-byte records, `rec+0x384` = file id, 50-matrix pool);
> skin palette blend `PS2Render_BuildSkinPaletteMatrices` `0x001e7fb8`; draw
> `PS2Render_DrawRiderSet` `0x001df970` / shadow `0x001e0480`; chunk DMA REF
> built at `0x001dfcc4..0x001dfcfc` (`lwu v0,0(chunk) | 0x50000000`) →
> draw-block dispatcher `0x001e8d30`; name tables `0x00342518` (body, 48 B per
> character), `0x00342788` (head, 80 B), `0x00342b98` (board decks/shadows).
> map:"MPF rider model loader, skinning microprogram and .afl tracks".

> [[240-layout]]() TrickyPS2MPF.cs `load`/`Save`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs;
> board sub-model census in the examples section below.

> [[240-directory]]() TrickyPS2MPF.cs `MPFModelHeader` (offsets from the
> fixed read order),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs.

## Material record — 32 bytes

| Offset | Type | Field |
|---:|---|---|
| 0x00 | char[4] | main texture id (e.g. `bord`, `suit`, `head`, `helm`, `boot`) |
| 0x04 | char[4] ×4 | optional extra texture slots; an empty slot starts with a 0x00 byte |
| 0x14 | f32 | **second-pass blend weight**, 0…1: at load the mesh-group header's third word is rewritten to round(factor × 127), positive when slot 4 (the `_g` gloss id) is present, negative when only slot 5 (`envr`) is, zero otherwise; at draw the magnitude is written as a byte into the texture stage and the sign selects the gloss or the environment map |
| 0x18 | f32 ×2 | never read (1/255 in every retail file) |

Slot conventions in real data: slot 4 (the fourth id) holds a gloss-map id
ending `_g` (`st_g`, `hm_g`, `bt_g`, `hd_g`, `bd_g`), and slot 5 holds
`envr` as an environment-map flag. Texture ids resolve by shortname in the
character texture bank (`210-textures-ssh.md`); mesh groups reference
materials by index. At load the loader also replaces the group header's
material index with the resolved texture handle of the main id and sets a
bit in the group's type word when the main id is not the boot texture. The
32-byte record is byte-identical across the PS2, Xbox, and GameCube variants.
[measured] [[240-material]]()

> [[240-material]]() TrickyPS2MPF.cs `MaterialData` (empty slot = first byte
> 0, saved `00 20 20 20`);
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2ModelCombiner.cs
> `StartRegenMeshCharacter`/`StartRegenMeshBoard` (gloss `_g` detection,
> `envr`); deck skins = 146 `*_bord.ssh` banks whose image shortname is
> `bord` (char texture archive). Engine `MpfPart_RewriteGroupHeaders`
> `0x00205b68`: `strncmp(material, "boot" 0x0039f780, 4)` at `0x00205bd0` →
> `group+0 |= 0x8000`; `lb material+0x0c` at `0x00205c00`, `lb +0x10` at
> `0x00205c10`, `lwc1 +0x14` at `0x00205c1c`, `neg.s`, × 127.0 (`0x42fe`) → `sw
> group+8` at `0x00205c4c`; `group+4 := TexBank_FindHandle 0x00204a90` at
> `0x00205c58`; draw use `0x001dfa68–0x001dfae4` (abs → `sb texstage+0xd`, sign
> → `renderer+0x644/+0x648`). `+0x18/+0x1c` = 0.00392157 in all files, unread.

## Skeleton

### Bone record — 84 bytes

| Offset | Type | Field |
|---:|---|---|
| 0x00 | char[16] | bone name |
| 0x10 | i16 | parent **file id** (−1 = none) — the file holding the parent bone |
| 0x12 | i16 | parent bone index within that file's bone list (−1 = root) |
| 0x14 | i16 | **channel flags**: bit 0 = three animated translation channels, bit 1 = three animated rotation channels, bit 2 = static (bind) translation, bit 3 = static (bind) rotation. Curve pointers are assigned in bone order, translation first — the 60-channel body track is the root (flags 3: T then R) plus 18 bones with flags 2; the board bone has flags 3 |
| 0x16 | i16 | index of the bone's **mirror partner** (left↔right; itself for centre bones) — the channel source when a layer plays mirrored |
| 0x18 | f32 ×3 | bind translation (model units = cm); scaled by the rider's model-scale value at load |
| 0x24 | f32 ×3 | bind rotation triple (radians), used raw |
| 0x30 | f32 ×3 | **mirror rotation offset** |
| 0x3C | f32 ×6 | **mirror rotation scale** (×3) and **mirror translation scale** (×3): when a layer plays mirrored, rot' = offset + rot × rotScale and trans' = trans × transScale, sourced from the partner bone (rider root: offset (0, 0, π), rotScale (1, −1, −1), transScale (1, −1, 1)). Not IK limits, not a bind matrix |

The skeleton is **cross-file**: a rider's head bones parent onto body bones
via (parent file id, parent bone index) matched against each file's directory
file id — the body and head files merge into one skeleton. Mesh vertices are
stored in **model space (bind pose)**, not bone-local space, so the render
mesh's extent is the true standing extent. [measured] [[240-bones]]()

### IK points — 16 bytes

Three floats of position plus a u32 **bone index**. Only the board file's IK
points are consumed: the rider pose code fetches board points 0 and 1,
transforms them by the named bone (0, the single board bone) and the board's
world matrix, and uses them as the two **foot-binding anchors** for leg
placement — the "Goofy" decks carry the mirrored X. Rider body and head files
ship zero IK points. Positions are scaled by the model-scale value at load.
[measured] [[240-ik]]()

> [[240-bones]]() TrickyPS2MPF.cs `BoneData`; cross-file resolve =
> TrickyPS2ModelCombiner.cs `FixBoneParents`; model-space vertices + the
> working rider-height measurement (~175 units ≈ 1.75 m, the cm anchor).
> Engine: `AflTrack_BindToSkeleton` `0x00159928` (`andi 1` → 3 curve pointers
> at `0x001599a4`, `andi 2` → 3 at `0x00159a0c`); layer evaluator
> `AnimPart_ApplyLayers` `0x00202ff8` (`andi 5`/`andi 1` at
> `0x002033c8/0x002033d0`; `andi 0xa`/`andi 2` at `0x00203864/0x0020386c`;
> static copies from `+0x18` at `0x002034b0`, `+0x24` at `0x00203918`); mirror
> index `lh +0x16` at `0x00203394` gated by the layer flag `part+0x330[i]` at
> `0x00203374`; mirror math at `0x00203988` (`lwc1 +0x3c`, `+0x30`) and
> `0x0020380c/0x00203834/0x00203844` (`lwc1 +0x48/+0x4c/+0x50`). Data:
> `board.mpf` bone "board" flags 3, id 0, R2 = (0, 0, π), tail = (1, −1, −1, 1,
> −1, 1); `mac_body.mpf` hips flags 3, 18 bones flags 2, l_clav idx 5 id 9 /
> r_clav idx 9 id 5, l_thigh 13 ↔ 16. Which gameplay condition sets the
> per-layer mirror flag (clip instance `+0x64` → `AnimPart_AddLayer`
> `0x00202e28` a2) was not traced — goofy stance is the obvious candidate.

> [[240-ik]]() relocation `part+0x1c` at `0x00205884`, scale at `0x00205a64`,
> `IkPoint_Transform` `0x00205ef0` (`lw 12(ikpt)` × 64 = bone matrix), reached
> through `RiderModel_GetIkPointWorld` `0x00208890` (`root+0x3cf8[fileId]`),
> whose only callers are `0x0012a688` (a2 = 1 board, a3 = 1) and `0x0012a6a8`
> (a3 = 0) inside `BoarderPose_BuildRenderTransform` `0x00129630` with matrices
> at `boarder+0x4a60`. Data: `board.mpf` Al ik0 = (13.34, 10.16, −7.86), ik1 =
> (−37.25, 10.16, −6.50), AlGoofy mirrored, w = 0. Layout per TrickyPS2MPF.cs
> IK loop, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs.

## Mesh groups — three-level indirection

**Level 1 — group header, 20 bytes**: u32 group type (**1** = standard
render, **17** = shadow volume, **256** = morph-target mesh), u32 material
index, u32 unknown, u32 link count, u32 blob-relative link offset.

**Level 2 — weight-reference link, 8 bytes**: u32 blob-relative offset and
u32 count of level-3 headers. Each level-2 entry pairs 1:1, in file order
across all groups, with one weight-reference list (skinning section below).

**Level 3 — mesh/morph header, 12 bytes**: u32 blob-relative offset of the
mesh chunk stream; u32 morph-key offset **relative to the mesh offset** (−1 =
no morphs); u32 morph-key chunk size (−1 = none). [measured] [[240-groups]]()

> [[240-groups]]() TrickyPS2MPF.cs `GroupMainHeader`/`WeightRefGroup`/
> `MeshMorphHeader` + the sequential weight-ref pairing (`NumberWeightRef++`),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs;
> group types confirmed on real files (decks 1, `shdw*` 17, head facial 256).

## Mesh data: the VU chunk stream

Geometry is a PS2 DMA/VIF upload stream, walkable as **chunks** of at most
55 vertices. A 32-byte preamble starts each chunk; its bytes 0–2 are a 24-bit
qword count (chunk bytes ÷ 16 − 1), and **byte 31 = `0x6C` means another
chunk follows** — any other value ends the stream. After the preamble and 16
skipped bytes comes a 16-byte strip-table header: u32 strip count, u32 14,
u32 114 (0 on shadow chunks — zero means the UV and normal sections are
absent), u32 total vertex count. The two constants are **vector-unit
data-memory addresses**: the skinning microprogram keeps up to 25 blended
skin transforms as 4-quadword records from address 14 and, for each, a
3-quadword normal-rotation matrix from address 114 (14 + 25 × 4). A second,
rigid entry point of the same program reads the quadword's second and third
words as the single transform and normal-matrix addresses for the whole
chunk, so per file they are 14/114 (slot 0) or 18/117 (slot 1, e.g. eye and
face chunks); rider body files carry uninitialised values there, harmless
because those chunks run the per-vertex entry. The 16-byte quadword before
the strip table is a ready-made GIF tag (loop count = vertex count,
triangle-strip, Gouraud, textured, alpha-blended, three registers). Then per
strip a 16-byte entry whose first u32 is the strip's vertex count; the strip
lengths partition the chunk's vertex arrays. [measured] [[240-chunks]]()
[[240-vu]]()

The attribute sections follow in order, each preceded by a 48-byte section
header and 16-aligned at its end: [measured] [[240-attrs]]()

1. **UV + weight** (render chunks only): vertex count × 4 × i16 — u and v
   are fixed-point **i16 ÷ 4096**; the third value is the vector-unit
   address of the vertex's 4-quadword skin transform, `slot × 4 + 14`
   (decode `(value − 14) ÷ 4` for the slot), and the fourth the address of
   its 3-quadword normal matrix, `slot × 3 + 114` — the microprogram loads
   both straight from these integers (positions by the 4×4, normals by the
   3×3, then lit).
2. **Normals** (render chunks only): vertex count × 3 × i16, **÷ 32768**.
3. **Positions** (always): render chunks store vertex count × 3 × f32 — raw
   floats in model space, no scale factor; shadow chunks store 3 × f32 plus
   a per-vertex u32 weight slot in the same `(value − 14) ÷ 4` encoding.

After the positions, 32 bytes of transfer tags are skipped and the next
chunk's preamble is tested.

Strips decode to triangles exactly as the level mesh blob's strip rule
(`220-level-pbd.md`). The position/UV/normal arrays are parallel. Degenerate
triangles occur in real streams and must be filtered. Authoring limits
validated by files the game accepts: ≤ 55 vertices per chunk, ≤ 25 weight
palettes referenced per group. [measured] [[240-strips]]()

> [[240-chunks]]() TrickyPS2MPF.cs chunk loop + `Save` (preamble Int24, the
> byte-31 continuation, strip-table constants 14/114),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs.

> [[240-vu]]() VU1 program 4 (`vu_disasm.py`; overlays #30–33 at `.vutext`
> file offset `0x0021a2e8`): entry table `0x0000..0x0060`; preprocessing entry
> `0x0070`: `IADDIU vi01,vi00,14`, `IADDIU vi02,vi00,114`, `IADDIU
> vi03,vi00,918`, `ILW vi04,1023(vi00)`, loop `0x00e0–0x0300` (multiplies each
> uploaded palette by the view-projection in place and derives two 3×3 normal
> matrices per palette, second set at 918); main entry `0x04b0`: `ILW
> vi04,1(vi02)` (strip count), `IADDIU vi03,vi02,2`, per vertex `ILW
> vi08,0(vi05)` → `LQ ..,0..3(vi08)` (4×4) and `ILW vi10,0(vi05)` → `LQ
> ..,0..2(vi10)` (3×3), `ITOF12.xy` UV, `ITOF15.xyz` normal, GIF tag copied to
> TOPS+181, vertices at TOPS+182 stride 3; rigid entry `0x0b18`: `ILW
> vi04/vi05/vi06,1(vi02)` then `LQ ..,0..3(vi05)` / `LQ ..,0..2(vi06)`; EE
> upload `PS2Render_UploadSkinPalette` `0x001df7d0` (matrix copy loop
> `0x001df858`, count unpack `0x600103ff` at `0x001df924`, MSCAL 0x70/8 at
> `0x001df938–0x001df958`); link matrix list `0x001dfc18–0x001dfc c0` from
> `palette hdr+8 × 64` at `renderer+0x3f8`. Data (decoded fields, not the
> bytes): a `board.mpf` chunk opens with a DMA CNT tag of 8 quadwords, STCYCL
> 1/1 and an UNPACK V4-32 of NUM 7 to TOPS+0 whose GIF tag reads NLOOP 55 |
> EOP, followed by strip lengths 5, 14, 114, 55; `mac_head.mpf` Eyes3000 UV
> records decode to (2394, 794, 18, 117) — 18 = 14 + 4·1, 117 = 114 + 3·1 —
> after an STCYCL 1/3 and an UNPACK V4-16 (NUM 54) to TOPS+7 = 2 + 5 strips;
> Face3000 words 18/117; `mac_body.mpf` Body3000 holds two non-decoding words
> in those slots (garbage). Chunk preamble = DMA CNT
> tag (24-bit QWC) + STCYCL(1,1) + UNPACK V4-32 NUM = strips + 2 to TOPS+0;
> trailing 32 bytes = 1-quadword CNT tag with STCYCL and an MSCAL selecting
> the entry (retail chunks imm 4 → 0x20 → `0x13c0`; the `0x13c0`/`0x1288`
> variants vs `0x04b0` were not diffed). Doubt: the per-vertex `ILW`
> component (z vs w) is inferred from which register feeds the 4-row vs
> 3-row loads.

> [[240-attrs]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs
> vertex section reads (÷4096, ÷32768, raw
> f32) and `Save` VIF unpack codes (V4-16 / V3-16 / V3-32; shadow V4-32);
> weight slot math in `CreateFaces` + combiner regen (`Weight*4 + 14`).

> [[240-strips]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs
> `GenerateFaces`/`CreateFaces`; degenerate filter + 55/25 limits =
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2ModelCombiner.cs
> `ReturnFixedFaces` / `StartRegenMeshBoard`.

## Skinning: palette tables

A vertex carries one small slot index that resolves through two tables to a
list of (bone, weight) pairs:

- **Weight palette header — 12 bytes**: u32 entry count, u32 blob-relative
  entry offset, u32 constant (36) — overwritten at load with the palette's
  unique index after de-duplication across the model set, never read from
  the file.
- **Weight entry — 4 bytes**: i16 weight as an **integer percentage** — the
  skin-palette builder converts it to float and divides by 100 before
  scaling that bone's matrix, summing the entries into one blended 4×4
  matrix per unique palette; retail palettes sum to exactly 100 — u8 bone
  index, u8 **file id** — skinning can reference bones in the other file of a
  body/head pair.
- **Weight-reference list — 8 bytes**: u32 count, u32 blob-relative offset
  of count × u32 palette-header indices.

Resolution: vertex slot → its group's weight-reference list → palette-header
index → palette → (file, bone, weight) entries. [measured] [[240-skinning]]()

> [[240-skinning]]() TrickyPS2MPF.cs `BoneWeightHeader`/`BoneWeight`/
> `WeightRefList`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs;
> cross-file resolve TrickyPS2ModelCombiner.cs `FixBoneIDs`; chain restated
> from `CreateFaces`/`ReturnFixedFaces`. Engine
> `PS2Render_BuildSkinPaletteMatrices` `0x001e7fb8`: `f1 = 100.0` (`0x42c8`) at
> `0x001e7fd8`; `lh entry+0` → `cvt.s.w` → `div.s` at `0x001e8040–0x001e8050`;
> bone = `boneBase[lbu entry+3] + lbu entry+2` (`0x001e8000/0x001e8004`) × 64;
> VU0 scale/accumulate `0x001e806c–0x001e8170`. Data: `mac_body.mpf` palettes
> e.g. (50,0,0)+(50,1,0), (25,0,0)+(50,13,0)+(25,16,0). Palette dedup
> `0x00207108` writes `hdr+8`.

## Morph targets

Only group-type-256 meshes carry morphs (head facial animation). The mesh
header's morph offset points at `morph key count` (from the directory entry)
consecutive morph keys, each a **complete transfer packet**: a 16-byte DMA
tag (24-bit quadword count, "return" tag), a no-op, a cycle setting (4/4), a
no-op and a masked **unpack of 3 × 8-bit** values to vertex memory — what
read as a "30-byte header plus a point count and a pad byte" is that packet,
the point count being the unpack's element count and the pad byte its
command — then the per-vertex position deltas as 3 × i8, 16-aligned, then a
no-op, a flush and a program call. The engine draws a morph group by
referencing every key's packet after uploading a per-key (weight, scale)
pair; the microprogram converts each delta with a 15-bit fixed-point
conversion and adds delta × weight × scale × 2560, so the stored i8 is
**1/12.8 model unit** (range ≈ ±9.9 cm; a ÷12 decode is a 6 % approximation).
Deltas are parallel to the chunk's vertex array. The file stores only the
targets; the weights come from the animation record (23 channels for a face,
driven by the `.afl` type-10 track). [measured] [[240-morphs]]()

> [[240-morphs]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2MPF.cs
> morph block (`MorphScale = 12f`, save
> unpack V3-8); head models have nonzero MorphKeyCount, body/board zero;
> combiner validates imported shape-key counts against it. Engine: morph draw
> `0x001dfd60–0x001dffa4` (group type & 0x100; per key `lwu` first word |
> `0x50000000` REF; `0x640103ff` = UNPACK V2-32 NUM 1 → VU 1023 at
> `0x001dfeb0/0x001dff44`; weight `lwc1 f0,0(rec+0x210+key*4)` at `0x001dff50` →
> +0x20, scale f20 = `part+0x38` × 2560.0 (`0x4520` at `0x001dfa08/0x001dfa2c`)
> → +0x24); VU1 program 4 accumulate entry `0x0358` (`IADDIU vi02,vi02,182`,
> `LQ vf01,1023`, `MULy.x vf01`, `ITOF15.xyz`, `MADDx.xyz vf03,vf04,vf01x`);
> anim record morph-weight array `+0x210` (`0x00202df0` clears, `0x00208348`
> passes `rec+0x210`). Data (decoded fields, not the bytes): a `mac_head.mpf`
> Face3000 morph header is a 13-quadword DMA RET tag, twelve zero bytes, STCYCL
> 4/4, four zero bytes, then an UNPACK V3-8 masked (cmd 0x7a) of NUM 0x38 to
> TOPS+182; 23 keys.

## Units, orientation, and real files

Model units are centimeters (`002-conventions.md`). The board deck is
authored length along local X (nose toward −X), width along Y, thickness
along Z. [observed] [[240-units]]()

`board.mpf` contains six render decks plus shadows, all stacked at the
origin: three shapes (`Al` 106 verts/88 tris, `Bx` 128/104, `Fr` 125/107,
roughly 260×42×7.5 down to 168×50×7.4 units) and their mirrored-stance
`*Goofy` twins. Every rider shares this one model; per-rider look is the
`bord` texture, not geometry. Rider files name their sub-models by LOD
vertex budget — `3000` / `1500` / `750` — plus one `shdw*`-named shadow
model (the rider's single shadow model of the overview above; the name
itself varies, e.g. `shdwAl`). [observed] [[240-examples]]()

> [[240-units]]() numeric rider-height derivation; the board deck uses a
> remapped axis convention.

> [[240-examples]]() combiner name-substring file-kind
> detection (`body`/`head`/`algoofy`),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyPS2ModelCombiner.cs.

## Animation clips (`.afl` side-files)

Clips live per character in `data/char/<name>.afl`. The container header is
12 bytes: a u8 console id, a u8 unknown, an i16 animation-header count, then
u32 offsets to the curve-pointer table and curve-data area. The animation
headers follow immediately and are 36 bytes each: u32 key, u32 first-pointer
index, u8 type, u8 related-header count, eleven u16 fields, and a final u32.
[measured] [[240-afl-header]]()

A named clip begins with a type-255 sentinel. Its key is the engine string
hash of the clip name, its first u16 is the frame count, and its
related-header count says how many tracks immediately follow. The core
snowboard clips have two: a type-0 body track with 60 scalar-curve pointers
and a type-1 board track with six. For the 19-bone body skeleton, the body
channels are three root-translation values followed by three absolute local
XYZ Euler angles for every bone in MPF order. The angles are radians; applying
their signs negated in Z-Y-X composition reproduces the bound feet and the
recognizable body hierarchy. [measured] [[240-afl-tracks]]()

Other track pointer counts are type 4/8/9/13 → 12, type 5/6/7/11/14 → 6,
type 10 → 23, and type 12/15 → 3. Types without a pointer payload include 2,
45, 49, 205, and 255. [measured] [[240-afl-pointer-counts]]()

A track's type byte is the **file id of the sub-model it animates**, and a
clip is applied to an animation record only when the record's file id equals
the track type. The ids are fixed per part: 0 body, 1 board, 2 head (never
animated), 5 eyes, 6 goggles, 9 Mac's goggles-with-strap, 10 the face's morph
weights, and hair per rider (4 Psymon, 7 Luther, 8 Eddie, 11 Kaori, 13 Brodi,
15 JP; 12 and 14 the remaining riders' hair). The channel counts follow from
each part's bones and their channel flags: body 6 + 18 × 3 = 60, board 6,
eyes 2 × 3, one-bone goggles 6, two-bone translating hair 12, one-bone
rotating hair 3, face = 23 morph weights. The board track is tx, ty, tz, rx,
ry, rz for the single board bone: translation in model units scaled by the
model-scale value, rotation as absolute local XYZ Euler radians composed as
for body bones. Per-character "uber"/cutscene banks carry head-part tracks;
the shared ride banks carry only body and board. [measured]
[[240-afl-types]]()

**Blending.** Each frame every record is reset to its bind pose, then up to
ten layers are added — one per active clip track matching the record — each
with a time, a weight (track weight × instance weight), a root-yaw offset
and a mirror flag. Layer channels are evaluated, the root gets the yaw offset
added to its Z rotation, and layers blend per bone as a running weighted
average: the first layer replaces, later layers interpolate by
w / (w_acc + w); rotations are averaged component-wise, not as quaternions.
Static bones copy their bind values. Which clip instances are active with
which weights per control state is not traced. [measured] [[240-afl-blend]]()

> [[240-afl-types]]() evaluator `BoarderAnim_EvaluateParts` `0x0015f7e0`: `lb
> v0,8(hdr)` at `0x0015f954` vs the record's `+0x384` at `0x0015f8bc` (record
> id = file id: written as `root + k*0x394 + 0x3a8` at `0x0020783c`, i.e.
> `rec+0x384`; init −1 at `0x00207508`); AFL bind `AflBank_Bind` `0x00158c28`
> (bank+8 headers, +0xc pointer table, +0x10 curve data), `AflClip_Load`
> `0x00158dd8` (sentinel, related count `lbu hdr+9`, sub-tracks `clip+0xc`),
> track alloc `0x00158880` (684-byte "SkelAnim"), `AflBank_LoadFile`
> `0x00158920` (`data/char/%s.afl` `0x0037a200`, name table `0x00326ab0`,
> AnimMemBank `0x00157db8`); channel order `AflTrack_BindToSkeleton`
> `0x00159928`. Data census (`aflscan.py`): franim/cmanim/bx*/fr*Uber = (0:60,
> 1:6); MAC_CON_1/mac_vgari = (0:60, 1:6, 5:6, 9:12, 10:23) = Mac's head file
> ids {5 eyes 2 bones, 9 goggles 2 bones flags 3, 10 face 23 morphs}; feanim
> types 4–15; head directories of all 13 riders. Doubt: the `0x3a8`-vs-`0x384`
> aliasing (root-relative vs record-relative) is the key inference, consistent
> with the init loop, the evaluator, telemetry ("body record id 0") and the
> data.

> [[240-afl-blend]]() `AnimPart_ResetPoseFromBind` `0x00202d60`;
> `AnimPart_AddLayer` `0x00202e28` (a2 mirror → `+0x330`, a3 track → `+0x358`,
> f12 time `+0x2b8`, f13 weight `+0x2e0`, f14 yaw `+0x308`, max 10);
> `AnimPart_ApplyLayers` `0x00202ff8` (yaw add at `0x00203964`, blend at
> `0x00203a00–0x00203b5c`, vec scale `0x00102f80`). State selection lives in
> the anim controller's three channel lists (`controller+0x58`, stride 0x70,
> walked by `0x0015f7e0`) and the event machinery (`BoarderAnim_PlayEvent`
> `0x0015fd10`, clip name/hash resolve `0x00159bd0`, 1412-entry table
> `0x003bd830`) — untraced.

Each scalar curve starts with a little-endian u16 descriptor: the low nibble
is its encoding and the upper 12 bits are a sample count or duration. Types
0–3 are respectively constant through cubic polynomials. Their coefficients
store only the upper three bytes of a little-endian float; the omitted low
byte is restored as `0x80`. Type 4 stores full f32 samples. Types 6 and 7
store a packed base and scale followed by u8 or u16 samples. Sampled types
interpolate from the nearest integer sample using the signed fractional
remainder. Type 5 is a group of consecutive curve segments; adjacent
segments share an endpoint, so advancing subtracts duration minus one.
[measured] [[240-afl-curves]]()

The shared freestyle ride bank exposes the motion as layers rather than one
procedural stance: `frRL_BASECYCLEFAST` is a 42-frame full-body loop,
`frRL_CROUCHCYCLE` a 41-frame crouched loop, and the regular and crouched
heel-side/toe-side turns are distinct 22-frame full-body clips. On a Mac body
skeleton, the neutral base pelvis is about 4.2 cm heelward, 5.5 cm rearward,
and 77.6 cm above the ankle midpoint. At their midpoint the regular
heel-side and toe-side turns put the pelvis about 38.3 cm heelward and
26.9 cm toeward respectively; their upper-body rotations differ as well and
are not mirror images. [measured] [[240-afl-ride]]()

### Live evaluated rider pose

The local human boarder keeps a fixed array of render-part records. Each record
identifies its model part and points directly at that part's runtime 84-byte
MPF bone table plus its bone count; part id 0 is the body. A live Garibaldi
sample resolves six parts and the expected 19-bone body skeleton, including
the original names and parent indices. [measured] [[240-live-layout]]()

`BoarderAnim` evaluates before the board render transform is built. For each
part it resets two in-record arrays from the MPF bind rotations and
translations, submits the active animation layers, then blends them into those
arrays. The body array therefore exposes the final local Euler rotations in
radians and the root translation in model units after layering, exactly the
60 AFL body channels described above. [verified] [[240-live-pose]]()

The embedded animation controller exposes current event ids for three channels.
The main per-rider update evaluates that controller and only then builds the
boarder's render transform. Thus a frame-fenced read of the part locals plus
the board/world transform captures both the final body pose and the transform
it is drawn under. Schema-v4 rider telemetry does this every game tick using
one batched PINE request. [verified] [[240-live-order]]()

> [[240-afl-header]]() ELF format string `data/char/%s.afl` @0x0037a200;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/aflHandler.cs `Load`;
> measured `franim.afl` header/directory walk.

> [[240-afl-tracks]]() named-sentinel hashes matched against the retail ELF
> strings; type-0/type-1 tracks following each sentinel; 60 = 3 + 19×3;
> hierarchy reconstruction with Mac `Body3000`;
> doc:../tools/analysis/afl_pose.py.

> [[240-afl-pointer-counts]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/aflHandler.cs
> `Load` switch; measured header pointer spans in `franim.afl`.

> [[240-afl-curves]]() retail scalar dispatch/evaluator @0x00157ef0 and
> @0x00158048, sampled-channel caller @0x001586d8; executable decoder in
> doc:../tools/analysis/afl_pose.py.

> [[240-afl-ride]]() retail names @0x00374358..0x003744d0; matching sentinel
> hashes and decoded frames in `franim.afl`; world-joint reconstruction from
> `mac_body.mpf` through doc:../tools/analysis/afl_pose.py `ride-summary`.

> [[240-live-layout]]() paused PAL `SLES-50545`, GARI local boarder live memory;
> part count `boarder+0x7BC`, records `boarder+0x7C0` stride `0x394`; part id
> `+0x384`, skeleton pointer `+0x388`, count `+0x38C`; body record id 0,
> pointer/count verified against its 19 names and 84-byte MPF records; probe in
> doc:../tools/instrumentation/rider_telemetry.py `resolve_body_rig`.

> [[240-live-pose]]() @0x0015F7E0, @0x00202D60, @0x00202E28,
> @0x00202E88, @0x00202FF8; MPF bone rotation `+0x24` → part rotation array
> `+0x000 + bone*12`, bind translation `+0x18` → translation array
> `+0x108 + bone*12`; live final arrays match the skeleton count and
> radian-scale bind/current rotations.

> [[240-live-order]]() @0x001147F8 caller, specifically @0x00114854 animation
> evaluation followed by @0x0011485C render-transform composition; controller
> `boarder+0x46C0`, three current event ids from controller `+0x08`, rendered
> board/world transform `boarder+0x4A90..0x4ACF`.

## Other-platform variants

The GameCube `.mnf` keeps the same logical model (sub-model directory;
materials/bones/IK/morphs/skinning/strips) but is big-endian, uses a 4-byte
version blob, and stores vertices as a flat indexed pool rather than VU
chunks. The Xbox `.mxf` is little-endian, same skeleton, and adds stencil
shadow edge-data sections the PS2 file doesn't carry. [measured]
[[240-variants]]()

> [[240-variants]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyGCMNF.cs,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/SSXTricky/TrickyXboxMXF.cs.

<!-- DIRTY
Open questions (derivations: elf-map "MPF rider model loader, skinning
microprogram and .afl tracks"):
- Gameplay source of the per-layer mirror flag (clip instance +0x64 →
  AnimPart_AddLayer 0x00202e28 a2): check writers of +0x64 on the anim
  controller's clip-instance records around BoarderAnim_PlayEvent 0x0015fd10
  for a stance (goofy) read.
- Full animation state machine (which clips/weights are active per control
  state): entry points 0x0015fd10, 0x00159bd0 (1412-entry table 0x003bd830),
  the three channel lists at controller+0x58 (stride 0x70).
- VU program 4 entries 0x13c0 / 0x1288 (retail chunks MSCAL imm 4 → 0x13c0;
  morph packets imm 2 → 0x0358): diff 0x13c0 vs 0x04b0 to name the
  lighting/env variant.
- Saved-file quirks (one mutable byte; 1500+ head models carry trailing
  bytes): the loader copies exactly dir+0x14 bytes per blob (0x00205684/
  0x00205788), so trailing bytes are ignored by construction; the mutable
  byte is undecoded (byte-diff a Snowknife round-trip against retail).
DIRTY -->
