# 512 — SSX 3: Textures and Materials

A detail chapter of the SSX 3 addendum (`510-series-ssx-3.md`): the texture
resources and their palettes, the material record and its render-state word,
what texture alpha means on terrain, and the one page reserved for helper
geometry. Read it against `170-materials.md` and `210-textures-ssh.md`.
Lightmap pages are a separate resource and are covered in
`511-ssx3-terrain-and-lightmaps.md`. [measured] [[512-role]]()

> [[512-role]]() doc:../research/ssx3-world-data.md — method and every
> figure below.

## Texture resources

A texture is one image per record, keyed by a **mountain-wide id**: 788 pages,
ids 0 to 787. A page is repeated in every streaming group that needs it, and
every repeat is byte-identical to the first, so a reader may decode each id
once. [measured] [[512-ids]]()

Each record holds a single image with its palette, in the per-image form of
`210-textures-ssh.md`. The images are 4-bit indexed (476 pages), 8-bit indexed
(308) or 32-bit (4). [measured] [[512-formats]]()

**Colour is stored at full brightness.** Nearly every page (757 of 788) uses
colour values above the half-bright ceiling, so the baseline's half-bright
convention does not apply and texture colour must not be doubled.
[measured] [[512-full-range]]()

**Alpha is on the console's 0–128 scale**, with 128 meaning opaque: no palette
entry on the mountain exceeds it. [measured] [[512-alpha-scale]]()

> [[512-ids]]() doc:../research/ssx3-world-data.md "Textures": 6,203 bin-9
> records, 5,415 repeats, 0 differing.

> [[512-formats]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldSSH.cs
> (format byte 1 / 2 / 5); census doc:../research/ssx3-world-data.md
> "Textures".

> [[512-full-range]]() doc:../research/ssx3-world-data.md "Textures",
> "Lightmaps" (base brightness); spec:210-halfbright for the baseline.

> [[512-alpha-scale]]() doc:../research/ssx3-world-data.md "Textures": 0
> of 784 palettes have an entry's alpha above 128.

## 8-bit palettes

Every 8-bit palette is stored in the **interleaved hardware order** that
`210-textures-ssh.md` defines for a flagged baseline palette: within each block
of 32 entries, the second and third runs of eight are exchanged. In SSX 3 this
holds on every 8-bit page, without a flag. [measured] [[512-palette-order]]()

The palette header gives a **colour count**, but the stored table is longer.
It always reaches the highest interleaved slot that any colour below the count
maps to, plus one, rounded up to a whole row of four entries. When the count
is not a multiple of 32, some colours below it map to slots at or past it. A
reader must therefore read the whole stored table before de-interleaving, not
just as many entries as the count. Stopping at the count turns those colours
into transparent black. For example, a 236-colour page stores 244 slots, and
its colours 232 to 235 sit in slots 240 to 243. Forty-one pages use such
colours. [measured] [[512-palette-extent]]()

4-bit palettes are not interleaved. Some also store entries past their count,
which nothing reads. [measured] [[512-palette-extent]]()

> [[512-palette-order]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldSSH.cs
> unswizzles every format-2 palette; spec:210-palette for the rule.

> [[512-palette-extent]]() doc:../research/ssx3-world-data.md "Textures"
> (8-bit palette order and extent): stored length ≥ highest swizzled slot +
> 1 on 308 / 308 pages; 41 pages, 3,668 texels in the extension; 38 of 476
> 4-bit pages store past their count. Regression test
> doc:../../Snowknife/SSX-Library/SSX-Library.Tests/WorldShapePaletteTests.cs;

## The material record

A material names a **primary page**, an optional **secondary page** (absent on
most), and a **render-state word**. Its other fields are constant across the
mountain. [measured] [[512-material-record]]()

The render-state word is a bit set. Its lowest bit is set on every material,
and three further bits choose how the primary page's alpha is used. [measured]
[[512-render-state]]()

| Bit | Meaning | Materials |
|---:|---|---:|
| 1 | always set | 2,575 |
| 2 | **alpha test**: the page's alpha cuts holes | 542 |
| 4 | **alpha blend** | 469 |
| 64 | **additive** glow | 32 |
| 32 | the material names a **secondary page** | 119 |
| 8, 16 | not established | 52 |

A blended material also sets bit 2; the count under 2 excludes those.

The alpha bits were measured against the pages they draw. Among materials with
none of them, 6 of 1,532 have a page with any clear texel. Among alpha-tested
materials, 481 of 542 have pages with clear texels. Every blended or additive
material's page has non-solid alpha. Bit 32 is set on exactly the 119 materials
with a secondary page, and only on those. [measured] [[512-state-vs-alpha]]()

> [[512-material-record]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldBin0.cs
> `TextureID`, `U1` (secondary page, −1 when absent), `U7` (render state);
> `U2` −1 and `U3` 0 on all 2,575; doc:../research/ssx3-world-data.md
> "Materials".

> [[512-render-state]]() doc:../research/ssx3-world-data.md "Materials":
> `U7` census 1 ×1,487, 3 ×522, 7 ×397, 39 ×51, 33 ×36, 97 ×30, 31 ×21,
> 27 ×20, 25 ×9, 121 ×2.

> [[512-state-vs-alpha]]() doc:../research/ssx3-world-data.md "Materials":
> clear = alpha < 8, solid = alpha ≥ 250 after scaling to 0–255.

## Terrain alpha is a mask, not coverage

On many terrain pages the alpha channel holds a **mask**, not transparency: 94 of the 331 terrain pages carry non-solid
alpha, and only one has the shape of a cutout, with a large fully clear area
and a large fully solid one. That page is the open metal truss of a big-air
ramp, and no patch field marks its seven patches as different from their
neighbours. The rest are soft masks over ice and carved snow. On one such page,
71% of the texels have zero alpha and none goes above a third of full; treated
as coverage, it would erase most of the ice it paints. [measured]
[[512-terrain-mask]]() [[512-cutout]]()

The masks belong to the **secondary-page pass** (`511-ssx3-terrain-and-lightmaps.md`).
Every patch that names a secondary page lies on a masked page. Two-thirds of
the masked pages are used only by such patches. The secondary pages themselves
are uniform half-alpha images. The mask evidently weights a sparkle or sheen
layer over the base, but the combine itself is not established. Terrain alpha
is therefore not coverage. [inferred] [[512-mask-pass]]()

On props the material decides. A prop page's alpha is transparency only when
the material sets an alpha bit, and a few opaque materials' pages carry
non-solid alpha that is not drawn as such. [measured] [[512-state-vs-alpha]]()

> [[512-terrain-mask]]() doc:../research/ssx3-world-data.md "Terrain
> alpha": 237 solid, 93 masked, 1 cutout-shaped (≥ 5% clear and ≥ 25%
> solid); page 376: 70.6% clear, the rest partial, maximum 78 of 255, on
> 118 patches. Negative result recorded there.

> [[512-cutout]]() doc:../research/ssx3-world-data.md "Terrain alpha": page
> 307, 33.4% clear / 52.1% solid, on 7 patches of EBA3's ramp.

> [[512-mask-pass]]() doc:../research/ssx3-world-data.md "Terrain alpha":
> 3,895 / 3,895 secondary-page patches on masked pages; 64 of 93 masked
> pages used only by them; secondary pages 62 / 198 / 297 / 50 partial
> everywhere.

## The debug page

One page, a flat **orange debug texture**, is reserved for helper geometry. It
is the page of 41 materials. 1,129 models draw with it alone, and their 3,174
placements are all helpers: reset planes and volumes, backcountry volumes,
invisible course fences, teleports, one-way volumes, impact triggers, streaming
load and unload boxes, and ride-state boxes. Four placements' models mix it
with real pages. A model drawn only with this page is never shown in play.
[measured] [[512-debug-page]]()

> [[512-debug-page]]() doc:../research/ssx3-world-data.md "The debug page":
> page id 17; family census there. The "never shown" reading rests on the
> names and on no visible object using the page; it was not captured in the
> running game.

## Not established

- The combine of the secondary-page pass. [open]
- Whether, and by what switch, the game cuts the truss page's holes; no patch
  field distinguishes its patches. [open]
- Render-state bits 8 and 16. [open]
