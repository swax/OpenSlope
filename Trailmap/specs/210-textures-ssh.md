# 210 — SSH Texture Banks

All texture data ships in **SSH banks**: flat containers of named images with
optional palettes. One format serves every texture role — per-level texture
banks, lightmap banks, skybox banks (all inside the level archive,
`200-archives.md`), the shared crowd and particle sprite banks, and the
rider/board skin banks. The logical roles of these textures are defined in
`160-lighting-data.md` (lightmaps), `170-materials.md` (alpha modes,
flipbooks), and `180-particles-data.md` (the shared sprite bank); this chapter
defines the container bytes and the decode conventions, including the
**half-bright** storage convention every displayed texture needs undone.

Two container variants exist in the format family, distinguished by the
4-byte magic: the older variant (ASCII `SHPS` on PS2, `SHPX`/`SHPG` on the
Xbox/GameCube ports) and a structurally different later variant (mixed-case
`ShpS`) used by later titles. **Every bank on the baseline disc that has been
byte-checked is the older `SHPS` variant** — level, lightmap, and skybox banks
across three levels, plus the shared crowd/particle banks. A decoder can
dispatch on the magic alone. [measured] [[210-variants]]()

> [[210-variants]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs
> `OldSignatureCheck` (SHPS/SHPX/SHPG) vs
> doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/NewShapeHandler.cs ("ShpS");
> raw magic of all 9 GARI/ELYSIUM/MESA level/lightmap/sky banks = `53 48 50 53`.
> NOTE: secondary sources claim level banks are "ShpS" — the raw bytes
> contradict that; measured beats observed.

## Container layout

All multi-byte values are **little-endian**. [measured] [[210-endian]]()

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | magic, ASCII `SHPS` (PS2) |
| 4 | 4 | file size in bytes (equals the real file length) |
| 8 | 4 | image count |
| 12 | 4 | creator code, 4 ASCII chars — an exporter build number, identification only: `G278` on every level, lightmap and sky bank, the front-end model bank, all loading-screen banks, the crowd bank and every loose HUD/front-end/rider-portrait/trick-book bank; `G277` on all rider/board/boot/helmet/head banks in the character texture archive; `G266` on the particle bank; `G264` on the one loading bank with a hardware-order palette; `G247` on the front-end venue map. No engine reader [[210-creator]]() |
| 16 | … | directory: image count × 8-byte entries |

Each directory entry is a 4-character ASCII shortname (not null-terminated)
plus a 32-bit absolute file offset of that image's chunk list. An image's byte
extent is not stored: it is derived as the gap to the next entry's offset (or
the end of file), truncated at the first occurrence of the 8-byte ASCII group
terminator **`Buy ERTS`** (`EASports` on the oldest exporter). The writer's
layout is: it reserves the header-plus-directory region in **128-byte
steps** (112 bytes for up to 12 images, plus 128 per further 16), writes the
terminator immediately after the last directory entry, zero-pads to the
reserved size, then writes image 0 — so the first image does **not** follow
the directory immediately but starts at the reserved boundary, and the
terminator sits **before** each image (in the directory padding for image 0,
then between images); the **last** image has none and runs to the end of the
file. A reader that takes image starts from the directory offsets and image
ends from the next offset (or file end) needs no terminator at all, which is
what makes the loader exporter-version-agnostic. [measured] [[210-directory]]()

The terminator is a convention of the baseline title's banks, not a property
of the container family: SSX (2000) writes none in its level and lightmap
banks, so a decoder covering that title must fall back on the offset gap
alone (`500-series-ssx-2000.md`). [measured] [[210-terminator-scope]]()

> [[210-terminator-scope]]() spec:500-ssh — terminator occurrences measured
> on the 2000 title's example course: course bank 0, lightmap bank 0, sky
> bank 1; loader comment agrees
> (doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs
> `LoadShape`).

Shortname conventions differ by bank role: level/lightmap/skybox banks number
their images as ASCII decimal (`0000`, `0001`, …) — these numbers are what
material and lightmap references in the level files resolve against
(`220-level-pbd.md`) — while the shared banks carry 4-character art names
(`fog0`, `clod`, `snfl`, …); the bank itself is located/loaded once, and
individual sprites within it are then addressed by slot index, per the
mechanism specified in `180-particles-data.md`. [measured]
[[210-shortnames]]()

> [[210-endian]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs
> `LoadShape` (StreamUtil LE defaults); raw check: elysium.ssh size field
> `20 67 17 00` = 1,533,728 = actual length.

> [[210-directory]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs `LoadShape` (size = next−this, "Buy
> ERTS" truncation; loader comment: SSX OG sized by offset alone, Tricky
> always group-terminated, SSX 3 mixed); writer `SaveShape` emits the
> terminator 16-aligned after every image. elysium.ssh's entry-0 offset 880 =
> 16 + 108×8 coincides with the 880-byte reservation for 108 images, so that
> one file does not distinguish the two layouts; the 492-bank PAL survey
> (`ssh_survey.txt` "directory-gap check") has first offset ≠ 16 + 8·count on
> 489/492 banks, after-directory bytes beginning `B` in 488 banks and `E` in
> SPECMAP (`EASports`); gari.ssh 121 images → 1008 (terminator at 984, pad to
> 1008); gari_L/CROWD 16 → 240; PARTICLE 38 → 368; ≤ 12 → 112.
> "Unterminated images per file": exactly one (the last) everywhere; tails:
> gari.ssh ends with its type-112 chunk, PARTICLE.SSH with palette bytes.
> Every bank's size field equals its real length. Engine chunk walker
> `Shape_FindLongNameChunk` `0x002c37e8` walks by the u24 size and treats 0 as
> end of chain — every image chunk carries an explicit non-zero size; only
> palette and lightmap chunks use implied-size 0.

> [[210-creator]]() `survey_detail.py` "creator by class" over 492 banks:
> G278 ×(36 level/lightmap/sky + FE model + 26 loading + crowd + 169 loose),
> G277 ×319 (TEXPS2.BIG), G266 ×1 (PARTICLE.SSH), G264 ×1 (LOAD.SSH), G247 ×1
> (SPECMAP). Writer differences by code: G247 terminator `EASports` (`45 41
> 53 70 6f 72 74 73`), G264 swizzled CLUT, G266 no long-name chunks,
> G277/G278 modern layout. ELF strings "G278"/"G266": none.

> [[210-shortnames]]() raw directory bytes (numeric names in all 9 level
> banks); art names (`fog0`, `clod`, `snfl`, `halo`, `brk1`…) in the shared
> bank, db:particle-bank; export naming
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs.

## The per-image chunk chain

At its directory offset an image is a sequence of **chunks**. Every chunk
begins with a 16-byte header: [measured] [[210-chunk]]()

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 | chunk type (table below) |
| 1 | 3 | chunk size in bytes, including this 16-byte header; 0 means the size is implied by the dimensions and bit depth |
| 4 | 2 | width (signed 16-bit; for a palette chunk: color count) |
| 6 | 2 | height (for a palette chunk: 1) |
| 8 | 2 | X field: on a palette chunk always repeats the color count; on image chunks 0 for every 3D texture — the only non-zero image values on the disc are a **screen-space anchor** (with Y) on twelve 256×256 HUD / front-end / loading tiles used in full-screen composites. The engine has no reader; a 3D-texture decoder may ignore it [[210-axis-flags]]() |
| 10 | 2 | Y field: the other anchor component; 0 everywhere else [[210-axis-flags]]() |
| 12 | 4 | flags; bit 13 (value 8192) = pixel/palette data is swizzled (below); no other bit is set on any image or palette chunk on the disc, and 8192 itself is set exactly once (the loading bank's palette) [[210-axis-flags]]() |

> [[210-axis-flags]]() `ssh_survey.txt` / `ssh_chunks.csv` over 492 banks (36
> level/lightmap/sky of all 12 levels, 2 front-end, 26 loading, 319 rider/board
> from TEXPS2.BIG, 109 loose incl. crowd/particle/HUD): flags by type
> {(2,0): 2752, (33,0): 2751, (5,0): 172, (33,8192): 1 = LOAD.SSH `gene`};
> X/Y {(2,0,0): 2740, (33,256,0): 2687, (5,0,0): 172, …}; the twelve
> exceptions: FE_1 `fe_1` (249,152), `fe_2` (143,44); HUD/HUDGAME/HUDTRICK
> `map1` (224,224), `map4` (101,25); HUDGAME `hud1` (200,167); HUD `ps2c` /
> HUDTRICK `hud1` (2,0); LOADING `loa1` (0,149); palettes with X ≠ width:
> none. Engine: `Shape_PrepareChunk` `0x002c34f0` reads the type byte (`lbu
> 0(s1); andi 0x80` → codec-compressed payload path `0x002c3580`), the u24
> size and `lh 4(s1)`/`lh 6(s1)` at `0x002c367c/0x002c3684`; `gsregscan.py`
> finds no `lh/lhu` of +8/+10 in the shape library `0x002c3000–0x002ca000`
> and the texture record is built from (format, width, height) alone
> (`GsTextureMan_RegisterTexture` `0x001c14a0`); `immscan 0x2000 andi`: no
> hit in the shape library or GS texture manager (the hits are the MC
> overlay, lens flare, and the PBD per-texture record test at `0x0025fd68`).

> [[210-chunk]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs `LoadImages` read order; raw checks:
> elysium.ssh image 0 = type 2, size 4112 = 16 + 64·64; its palette = type 33,
> size 1040 = 16 + 256·4; lightmap image = type 5, size 65552 = 16 + 128·128·4.
> Size-0 fallback = width·height scaled by the type's bytes-per-pixel.

Chunk types relevant to the PS2 baseline: [measured] [[210-types]]()

| Type | Meaning |
|---:|---|
| 1 | 4-bit paletted image (16 colors, two pixels per byte, **low** nibble first) |
| 2 | 8-bit paletted image (256 colors, row-major, one byte per pixel) |
| 5 | 32-bit RGBA image (file byte order R, G, B, A) |
| 33 | palette chunk (entries 4 bytes R, G, B, A) |
| 105 | metal-bin marker (changes alpha interpretation, below) |
| 112 | long-name chunk |
| 124 | **hot-spot list**: after the 16-byte header a u32 count, then `count` × (i32 x, i32 y) points, padded to 16 — carried by 38 HUD / front-end / loading composite images; not a texture property |
| 130 | 8-bit paletted image, payload RefPack-compressed (`200-archives.md`) — more generally, any chunk whose type byte has bit 7 set carries a codec-compressed payload the loader decompresses into a fresh chunk; no shipped bank uses it |

Further type values (16-bit formats, block-compressed formats, an Xbox
palette type) belong to the other platform ports and do not occur in any
PS2 bank on the disc — a survey of all 492 banks, the 319 rider/board/boot/
helmet/head banks of the character texture archive included, finds only
types 2, 5, 33, 112 and 124. The 4-bit type 1 is absent too. [measured]
[[210-types]]()

What the baseline disc actually ships is narrow: every level and skybox
texture across the three byte-surveyed levels is type 2 (8-bit, 256-color
palette), every lightmap is type 5, and types 1/130, the 16-bit types, and
the swizzle flag never occur in level data. Dimensions are always powers of
two, 16×16 through 256×256, with 128×128 dominant. There are no mip chains —
one image chunk per shape. A typical level-bank image is: image chunk →
palette chunk → (empty) long-name chunk → `Buy ERTS`. [measured]
[[210-profile]]()

> [[210-types]]() OldShapeHandler.cs `MatrixType` enum;
> doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/EADecode.cs
> `DecodeMatrix1/2/5` (nibble order, palette lookup, RGBA order). 492-bank
> type census: {112: 2847, 2: 2752, 33: 2752, 5: 172, 124: 38}; 105: 0; 130:
> 0. Type 124 (`dump124.py`): e.g. FE_1 `fe_1` (329,394)(359,400)(357,405)
> (324,403); the community "Unknown1 = width×8 bytes" read is consistent.
> Engine `Shape_PrepareChunk` `0x002c34f0`: type bit 7 → `0x002c3580` (size +
> alloc + 16-byte header copy + `Codex_Decompress` `0x002c35b4`; family-B
> codec payload headers `0x18FB/0x28FB` use flags bits 28–31 as a block
> count → `0x002c3260`; `0x1AFB` → 16-bit; DXT 96/97/98 → software decode
> `Shape_DecodeDxtBlock16` `0x002c39a0`); `Shape_BitsToType` `0x002c38b0` (4 →
> 1, 8 → 2, 15/16/555/565/1555 → 3, 24/888 → 4, 32/8888 → 5);
> `Shape_FindImageByName` `0x002c3700` (long name first, else 4-char short
> name, strcmp).

> [[210-profile]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs;
> full chunk-walk of all 9 banks: gari 121 / elysium 108 /
> mesa 129 level images + 25 sky each, all type 2; lightmaps all type 5
> 128×128; flags 0 on all 433 image + 43 palette chunks surveyed; dimension
> census in the bank inventory below.

### Long-name chunk (type 112)

The long-name chunk holds a null-terminated ASCII long name, padded to
16-byte alignment (the three size bytes are unused). In level banks the chunk
is present on every image but the name is **empty** — the 4-character
directory shortname is the only name an image has. [measured] [[210-longname]]()

> [[210-longname]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs `LoadImages` LongName branch
> (`Position += 3`, null-string read, 16-align); raw: every level-bank
> longname = `70 00 00 00` + 12 zero bytes; longname count == image count in
> all surveys. The new "ShpS" variant moves long names to chunk type 111.

## Palettes and swizzle

A palette chunk's payload is `count × 4` bytes, R, G, B, A per entry; every
palette in level, lightmap and sky data is 256-color, stored linear, but the
rider and board banks ship **trimmed palettes** (28 to 255 entries on 33
banks), so a reader must honour the count rather than assume 256. When a
palette chunk carries flag bit 8192 it is stored in the PS2 CLUT interleaved
order: the stored position of entry `i` swaps bits 3 and 4, i.e.
`stored = (i AND 0xE7) OR ((i AND 8) << 1) OR ((i AND 16) >> 1)`. The
hardware CLUT upload is a fixed 16×16 32-bit transfer in that interleaved
order, so every ordinary linear palette must be re-ordered by the engine
before upload; which pass does so (and therefore reads the flag) was not
located. [measured] [[210-palette]]()

When an *image* chunk carries flag bit 8192 its pixel data is stored in the
PS2 block-swizzled layout and must be unswizzled before palette lookup. For
8-bit data the source byte for output pixel (x, y) of a width-w image is
found by block decomposition: `block = (y AND NOT 15)·w + (x AND NOT 15)·2`,
`swap = (((y+2) >> 2) AND 1)·4`, `posY = (((y AND NOT 3) >> 1) + (y AND 1)) AND 7`,
`column = posY·w·2 + ((x+swap) AND 7)·4`, `byteNum = ((y >> 1) AND 1) + ((x >> 2) AND 2)`,
`source = block + column + byteNum`. The 4-bit variant applies the same block
scheme inside 128×128 page decomposition with nibble selection by
`(y >> 1) AND 1`. On the whole disc the flag is set exactly once — on the
palette of the loading bank (a 512×512 8-bit image with a hardware-order
CLUT) — and never on an image chunk; the capability is specified for
completeness. [measured] [[210-swizzle]]()

> [[210-palette]]() OldShapeHandler.cs `GetColorTable`;
> doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/ByteUtil.cs
> `SwizzlePalette`/`UnswizzlePalette`; survey: palette width 256 on all 433
> level paletted images, flags 0; 492-bank survey: palette widths 256 ×2686,
> 255 ×15, 238 ×7, 100 ×5, 95 ×5, …, 32, 28 (all non-256 in TEXPS2.BIG).
> Engine CLUT upload `GsTexture_BuildClutUpload` `0x001c4460`: fixed 16×16
> PSMCT32 transfer + TEXFLUSH, no flag test; the 8/16 swap pass was not
> found (candidate: the course-load registration virtual `0x0025f524`,
> vtable slot +0x150, into the GS texture manager).

> [[210-swizzle]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Utilities/ByteUtil.cs `Unswizzle8` / `Unswizzle4bpp`;
> OldShapeHandler.cs `LoadImages` (`Flags & 8192`); 492-bank survey: (33,
> 8192) ×1 = LOAD.SSH `gene`, no image chunk flagged.

## The half-bright convention

The PS2 graphics hardware treats the value 128 as full intensity (1.0) for
both texture color modulation and alpha, and doubles at draw time.
Consequently the art on disc is stored **half-bright**, and a decoder that
wants display-ready images must undo two related halvings. The render state
grounds it: there is exactly one texture-register builder in the executable,
used by every textured draw, and it programs the
texture function **modulate** with colour and alpha both taken from the
texture, a 32-bit palette reloaded on every bind, and bilinear/trilinear
filtering with the mip count from the texture record (zero on shipped art).
On the vertex side the object-mesh microprogram computes the lit colour,
clamps it to 255 and emits an 8-bit vertex colour with no 128-based scaling.
With hardware modulate = texel × vertex ÷ 128, a vertex of 128 reproduces the
stored texel and a fully lit vertex doubles it, so a stored opaque texel of
128 reaches white only under full lighting — the ×2 headroom the half-bright
storage relies on — and texel values above 128 over-brighten. Texture alpha
128 reaches the blender as full opacity in the hardware's 128-based alpha
domain. [measured] [[210-halfbright]]()

- **Alpha.** Opaque pixels store alpha 128, not 255. Across every palette in
  all surveyed level and skybox banks the maximum alpha is *exactly* 128.
  Decode rule: if no palette entry exceeds alpha 128, double every alpha and
  cap at 255; the guard leaves a genuinely full-range bank untouched, and the
  inverse (halve on encode) round-trips. The rule is skipped for an image
  with a metal-bin chunk (below). [measured] [[210-alpha]]()
- **Color.** Opaque RGB likewise caps near 128 on most banks, but not all
  (below). Decode rule: if the image's opaque RGB does not exceed ~128,
  double it (`c' = clamp(c×2 − 1, 0, 255)`, inverse `(c+1)/2`, saturating at
  255 — a wrap-around instead of a clamp turns any channel ≥ 129 black); a
  genuinely full-range image is left untouched. [measured] [[210-color]]()

The brighten applies to **every displayed bank**: level, skybox, board-skin,
crowd, and particle-sprite banks. It does *not* apply to lightmap banks,
whose payload is already full-range (below). Within the shared particle
sprite bank, sprites are a **mix**: 27 of 38 store full-range color
(the alpha-style guard above leaves these untouched) and 11 are genuinely
half-bright (the glow/explosion art — `clod`, `halo`, `snfl`, `ex06`–`ex09`,
`exlm`) and need the brighten — the guard, not a blanket apply, is what makes
the rule safe across a mixed bank. The
diagnostic for a missed brighten is an image whose opaque pixels max out at
exactly 128. The brighten must run **before** any later step that inspects
pixel values (such as un-premultiplying a sprite's alpha), or that step
misreads the dim, half-bright source. [observed] [[210-halfbright-scope]]()

> [[210-halfbright]]() engine-side: the renderer programs blend modes against
> the 128-is-1.0 convention (sprite blend enum 5 = Cs·As + Cd @0x00130c20,
> db:powder-spray). TEX0 site: `GsTexture_EmitBindPacket` `0x001c3d10` (ctx,
> texture index, context 1/2, packet; record = `[ctx+0x10] + idx×92`), TEX0
> assembly `0x001c3f74–0x001c4044` fills the register field by field: TBP0 from
> the 20-byte VRAM-slot record (`[ctx+0x3c] + slot×20`), TBW = max(w,64)/64
> (bits 14–19), PSM = `rec+0x20` (bits 20–25), TW = `rec+0x14` (bits 26–29),
> TH = `rec+0x1c` (bits 30–33), bit 34 set **TCC = RGBA**, CBP (bits 37–50)
> from the 16-byte CLUT-slot record (`[ctx+0x6c] + slot×16`), bit 61 set
> **CLD = 1**, nothing into bits 35–36 (**TFX = 0 = MODULATE**), bits 51–55
> zero (CPSM = CT32, CSM1); TEX1 = LCM/L/K from `rec+0x4c/+0x50/+0x54`, MXL
> `rec+0x40`, constant
> 0x160 = MMAG LINEAR + MMIN LINEAR_MIPMAP_LINEAR; MIPTBP1 when MXL ≠ 0.
> `tex0scan.py`: the only `dsll …,26` in .text is `0x001c3ff8`; no `dsll32 …,3`
> anywhere (no TFX writer). Callers `0x001c55b8/0x001c55d0` (contexts 1/2) and
> `0x001c568c` inside `RenderBatch_EmitContextPacket` `0x001c54d8`, ids from
> the node's descriptor copy (`+0x24` → pair cached by `0x001c5228` from
> descriptor `+0x08/+0x0a` set by `RenderDescriptor_BindTexture` `0x001e9870`).
> Registration `0x001c14a0–0x001c1660` (`+0x10` w, `+0x14` log2 w, `+0x18` h,
> `+0x1c` log2 h, `+0x20` PSM, `+0x0c` size in 256-byte blocks, `+0x24` VRAM
> slot −1, `+0x30` CLUT slot, `+0x40` MXL = 0, `+0x58` use count) — texture
> VRAM is an on-demand cache filled on first bind. VU1 program 5 (`vu5.txt`)
> slots 6–29: `I = 255 (0x437f0000)`, `MULAx/MADDAy/MADDAz/MADDw vf13 =
> M(vf20..22)·max(N,0) + vf23`, `MINIi.xyzw vf16, vf13, I`, `FTOI0.xyzw vf19,
> vf16`. Object ALPHA enum 3 (0x44) per db:object-material. Residual: a
> pre-built TEX0 inside a VU1 data packet is not excluded EE-side (a PCSX2 GS
> register dump during an object draw is decisive); vertex alpha (vf23.w) not
> read off.

> [[210-alpha]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs `AlphaFix` (TestAlpha guard, ×2 cap 255,
> halve in `WriteColourTable`, skipped on MetalCheck); measured: max palette
> alpha = 128 across all 433 paletted images of GARI+ELYSIUM+MESA.

> [[210-color]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs `BrightenImage`/`DarkenImage` (+ the
> wrap-to-black pitfall in its comment).

> [[210-halfbright-scope]]() call site: TrickyLevelInterface
> `ExtractTrickyLevelFiles` (level+sky); mixed shared bank: 27 of 38 particle
> sprites full-range, 11 half-bright (the glow/explosion art — clod/halo/snfl/ex06-09/exlm).

### Metal-bin chunk (type 105)

A 16-byte marker chunk with no payload (written as type 105, size 16, then 0
and 128 in the width/height slots). Its presence on an image changes the
meaning of that image's alpha channel: alpha is a separate 8-bit
environment/specular ("metal") mask, **not** transparency — the RGB is fully
opaque, and the alpha-doubling rule must not be applied. **No bank on the
baseline disc contains one** — not level, lightmap, sky, crowd, particle or
HUD, and not any of the 319 rider, board, boot, helmet and head banks in the
character texture archive or the loose per-rider banks — so the rule is
dead for this title and matters only to tools covering others. [measured]
[[210-metal]]()

> [[210-metal]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs `LoadImages` MetalCheck / `ImageWrite`
> metal branch (splits alpha into a separate A8 plane, recombines on save).
> `ssh_survey.txt` "count 105: 0" over 492 banks incl. every `data/char/*.ssh`
> in TEXPS2.BIG and the RP_*/TB_*/TBC_* banks.

## The lightmap bank variant

A level's lightmap bank (`<stem>_L.ssh`, where the stem may drop its last
character to fit the 8.3-style naming — e.g. `elysiu_L.ssh`) is the same
container with a fixed content profile: every image is type 5 (32-bit RGBA),
128×128, unswizzled, no palette. [measured] [[210-lightmap-profile]]()

The channel semantics are unusual: **the luminance is the alpha channel.**
Alpha holds the full-range smooth lighting gradient; RGB holds only a faint
per-level tint (warm on one level, cool on another) that the original
pipeline left behind. The correct decode for use as a multiply-lightmap is
grayscale = alpha. Lightmap banks must **not** be brightened — alpha is
already full-range. [measured] [[210-lightmap-alpha]]()

Each 128×128 lightmap image is one of the data model's **lightmap pages**
(`160-lighting-data.md`), a 16×16 grid of **8×8-texel per-patch tiles** with
no gutter — 256 patch tiles per image. Which image and which tile a
terrain patch samples is carried in the patch record (`220-level-pbd.md`);
the tile-to-patch orientation convention (a transpose relative to the patch
parameters) is a consumer-side rule specified in `160-lighting-data.md`.
[observed] [[210-lightmap-tiles]]()

> [[210-lightmap-profile]]() surveys: GARI 16 / ELYSIUM 17 / MESA 10 images,
> all type 5 128×128 flags 0; naming fallback to the level's `_L.ssh` (real
> file `elysiu_L.ssh`).

> [[210-lightmap-alpha]]() FullColor lightmaps decode as raw RGBA: alpha = A_S
> (intensity), RGB = C_S (source residual) — the GS blend's two terms
> (`160-lighting-data.md`). Raw ELYSIUM map 0: alpha 72–255, maxR 0 (cool tint)
> vs GARI warm tint — tint hue per-level, A_S-in-alpha invariant; raw RGBA with
> no brighten applied in the lightmap path.

> [[210-lightmap-tiles]]() doc:../research/extracted-data.md "Terrain patch
> orientation and seam conventions" (transpose chosen by boundary-continuity
> scoring 0.025 vs 0.121 rot90 / 0.196 identity); per-patch tile reference =
> the patch record's lightmap fields, db:terrain-collision adjacent decode in
> TrickyLevelInterface (`LightMapPoint`).

## Bank inventory (baseline disc, measured)

| Bank | Images | Profile |
|---|---:|---|
| `gari.ssh` | 121 | 8-bit paletted: 102×128², 17×64², 2×32² |
| `gari_L.ssh` | 16 | 32-bit lightmaps, 128² |
| `gari_sky.ssh` | 25 | 8-bit paletted: 128², 256² |
| `elysium.ssh` | 108 | 8-bit: 70×128², 31×64², 3×32², 2×16², 2×256² |
| `elysiu_L.ssh` | 17 | 32-bit lightmaps, 128² |
| `elysium_sky.ssh` | 25 | 8-bit: 128², 256² |
| `mesa.ssh` | 129 | 8-bit: 84×128², 39×64², 4×32², 1×256², 1×16² |
| `mesa_L.ssh` | 10 | 32-bit lightmaps, 128² |
| `mesa_sky.ssh` | 25 | 8-bit (dimension breakdown not re-measured) |

All carry magic `SHPS` and creator code `G278`. Lightmap image counts track
the level's patch count (a level with fewer patches ships fewer maps): across
the twelve levels they are ALASKA 14, ALOHA 12, ELYSIUM 17, GARI 16, MEGAPLEX
3, MERQUER 11, MESA 10, PIPE 10, SNOW 7, front end 3, TRICK 2, UNTRACK 17.
Over the whole disc the image dimensions are 128² ×2120, 64² ×490, 256² ×259,
32² ×41, 16² ×12 and 512² ×2. [measured] [[210-inventory]]()

Beyond the level archives: the crowd flipbook bank (sixteen 128×128 8-bit
frames, each with its own 256-colour palette and a long-name chunk equal to
the short name, flags zero, unswizzled, the level exporter's creator code;
additionally stored premultiplied against black), the particle sprite bank
(38 named sprites — 33 8-bit and 5 32-bit — with one 131-colour palette and
no long-name chunks; the bank loaded once and its sprites addressed by
index, `180-particles-data.md`), per-rider texture banks at
`data/textures/` named by outfit and rider, and board-skin atlas banks
(one 128×128 atlas per rider outfit) inside the character texture archive.
[measured] [[210-shared-banks]]()

> [[210-inventory]]() raw header + chunk-walk of each file; decoded-output
> sanity: GARI 121 level textures + 16 lightmaps. Disc-wide figures from
> `ssh_survey.txt` (492 banks): lightmap (type-5) counts per level as listed;
> dimension census as listed; CROWD.SSH n = 16, creator G278, types {2: 16,
> 33: 16, 112: 16}, flags 0, palettes (256,1,256,0,0), long names cd00…cd15,
> image 0 header `02 10 40 00 80 00 80 00 …`; PARTICLE.SSH creator G266, 33
> type-2 + 5 type-5 sprites, one 131-colour palette, no type-112 chunks.

> [[210-shared-banks]]() crowd premultiply + 16 frames; particle bank
> loader @0x001cb3f0, name lookup, db:particle-bank, map:"shared particle
> sprite bank"; rider bank ELF path strings `/data/textures/t00brod.ssh`
> @0x0039a870; board atlases.

## The later container variant (not on this disc)

The mixed-case `ShpS` variant restructures the container: a 16-byte header
whose image count is big-endian, directory entries with explicit sizes and
variable-length names, and a 32-byte chunk header carrying separate flag
bytes (image / RefPack-compressed / swizzled) and 32-bit dimensions. It keeps
the same image type values, the same 128-as-1.0 alpha convention, and the
same swizzle algorithms. A baseline loader does not need it. [measured]
[[210-newvariant]]()

> [[210-newvariant]]() doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/NewShapeHandler.cs
> `LoadShape` (header/chunk layouts, LongName = type 111).

<!-- DIRTY
Open questions (derivations: elf-map "GS texture binding (TEX0) and the SSH
shape library"):
- Engine reader of SSH flag bit 13 not located; the CLUT upload
  (0x001c4460) is a fixed interleaved 16×16 transfer, so linear palettes must
  be re-ordered by a CPU pass. Decisive: trace the course-load registration
  virtual (0x0025f524, vtable slot +0x150) into the GS texture manager for
  the 8/16 swap loop, or compare LOAD.SSH vs a level palette in PCSX2 VRAM.
- Whether any VU1 data packet carries a pre-built TEX0 with a different TFX
  (only one EE builder exists; a PCSX2 GS register dump settles it).
- Meaning of bit 13 in the PBD 24-byte per-texture record tested at
  0x0025fd68 (sets flag 0x10 on the owning object) — chapter 220 territory.
DIRTY -->
