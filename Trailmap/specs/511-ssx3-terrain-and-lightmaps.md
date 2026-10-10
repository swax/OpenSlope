# 511 — SSX 3: Terrain and Lightmaps

A detail chapter of the SSX 3 addendum (`510-series-ssx-3.md`): how the
mountain's locations fit together, what the patch record carries beyond the
baseline, and how its lightmaps are laid out, addressed and combined. Read it
against `110-terrain.md` and `160-lighting-data.md`; where it is silent, they
and chapter 510 hold. [measured] [[511-role]]()

> [[511-role]]() doc:../research/ssx3-world-data.md — method (census probe
> over the decoder's SSX 3 handlers, reader's own NTSC-U disc) and every
> figure below.

## One mountain of named locations

The streaming database names **49 locations**: five **hubs**, seventeen
**events**, twenty-one **connectors**, five **skies** and one shared location
that places no terrain. A hub is named by a single letter. An event is named by
its hub letter, a two-letter discipline (race, slopestyle, halfpipe, big air,
backcountry) and an index. A connector is named for the two locations it joins,
an event and the hub it leaves from, or an event and the next hub down. Each
hub letter has one sky location. [measured] [[511-locations]]()

The five hubs stack into the game's three peaks. By the median height of their
terrain, the letters order E, C, D, A, B from the top: peak 3 is hub E, peak 2
is hubs C and D, and peak 1 is hubs A and B, with B at the foot of the mountain.
[measured] [[511-peaks]]()

Every location is authored in **one shared world space**, in the same Z-up
centimetre units as the baseline. There is no per-location origin or offset:
patches of neighbouring locations share their boundary corners exactly, joining
43 pairs of locations, so any set of locations assembles by simple union.
[measured] [[511-one-space]]()

> [[511-locations]]() doc:../research/ssx3-world-data.md "Locations and
> peaks"; location table read per
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SDBHandler.cs;
> Disciplines by the second and third letters of the 17 event names: RA,
> SS, HP, BA, BC.

> [[511-peaks]]() doc:../research/ssx3-world-data.md "Locations and peaks":
> median patch-centre height by letter E 4,925 m, C 1,853 m, D −395 m,
> A −2,290 m, B −5,001 m; hubs alone in the same order.

> [[511-one-space]]() doc:../research/ssx3-world-data.md "Locations and
> peaks": 173 patch corners shared across locations, 43 location pairs.

## What the patch adds

The patch's geometry, corner UVs and record size are as chapter 510 states.
Three fields carry more than the baseline's equivalents.

**Texture and lightmap references** are resource identifiers, and both are
**mountain-wide**: a page id means the same page in every location. Every
patch has a lightmap; 331 distinct texture pages are used by terrain.
[measured] [[511-refs]]()

**A secondary page.** One patch in eight names a second texture page, always
one of three, beside its own. Exactly those patches carry a distinct value in
a separate small field of the record, and every one of them lies on a texture page
whose alpha is a mask (`512-ssx3-textures-and-materials.md`). The data reads
as a second, masked pass of a shared sparkle or sheen page over the base
texture. What the pass computes is not established. [inferred]
[[511-secondary]]()

**Surface type.** Chapter 510 shows that the surface value space matches the
baseline's but the labels do not. The authored patch names give each value a
reading, and those readings explain the measured tilt. [inferred]
[[511-surface-names]]()

| Value | Patches | Named as | Reading |
|---:|---:|---|---|
| 2 | 8,033 | powder | powder |
| 3 | 3,276 | deep powder, rocky | deep powder |
| 4 | 1,923 | ice | ice |
| 9 | 200 | tree trunks, logs | wood — the steepest class, since trunks stand vertical |
| 10 | 83 | podium tops, helipads, metal fronts | metal — the flattest class |
| 8 | 257 | a lettered "alps" series | distant backdrop ridges |
| 1 | 836 | water surfaces among generic sections | not established |
| 17 | 7 | cement | not established |
| 0, 5, 7, 13, 18 | 16,029 | generic section, path and wall names | not established |

> [[511-refs]]() doc:../research/ssx3-world-data.md "Patch fields";
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldPatch.cs
> `TextureRID`, `LightmapRID`; lightmap references span 0–622 =
> the 623 lightmap records (spec 510).

> [[511-secondary]]() doc:../research/ssx3-world-data.md "Patch fields",
> "Terrain alpha": `U14` names page 297 / 62 / 198 on 3,895 patches; `U4`
> = 425 on exactly those, 41 on all others; all 3,895 on masked pages.

> [[511-surface-names]]() doc:../research/ssx3-world-data.md "Patch
> fields" — name-word census per `U2` value; spec:510-surface tilt (value 9
> mean up-component 0.13, value 10 0.85).

## Lightmap pages

Lightmaps are their own resource kind, one page per record, **623 pages** with
mountain-wide ids, each stored once. Every page is 32-bit RGBA and square, at
one of three sizes: 128 (395 pages), 64 (91) or 32 texels (137). [measured]
[[511-lm-pages]]()

The channels carry the **same two blend terms as the baseline**
(`160-lighting-data.md`): alpha is the light intensity A_S, spanning the whole
byte, and RGB is the residual C_S, larger in shade, where the light is
coloured, than in open sun. [measured] [[511-lm-terms]]()

The base they combine with is different. SSX 3's textures are stored at **full
brightness**, not half (`512-ssx3-textures-and-materials.md`), so the lit
result is `(C_D − C_S)·A_S/128` with C_D the texture colour as stored. The
baseline writes the same blend over a half-bright base, `(0.5·C_D − C_S)·A_S/128`.
A consumer that applies the baseline's half-bright formula to SSX 3 data
halves the light, and the residual then weighs twice as much against it.
[inferred] [[511-lm-base]]()

> [[511-lm-pages]]() doc:../research/ssx3-world-data.md "Lightmaps";
> bin 10 per spec:510-bins; decoded with
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldSSH.cs
> (format 5).

> [[511-lm-terms]]() doc:../research/ssx3-world-data.md "Lightmaps": alpha
> 0–255; mean RGB 51.9 at alpha < 128 against 31.1 above;
> spec:160-luminance for the encoding.

> [[511-lm-base]]() doc:../research/ssx3-world-data.md "Lightmaps" (base
> brightness), "Textures"; spec:210-halfbright for the baseline storage.
> Derived from the stored ranges and checked by eye on the imported mountain
> (white lit snow, blue shade); no in-game capture.

## Slots and cells

A page is packed edge to edge with **square slots** whose side is a
power of two: 4, 8, 16 or 32 texels. Each slot holds one patch. The patch's
**cell** is the slot's interior, inset one texel on every side, so a cell is 2,
6, 14 or 30 texels square. The one-texel ring around it belongs to the slot.
All four sizes occur on every page size. [measured] [[511-lm-slots]]()

| Cell | Slot | Patches |
|---:|---:|---:|
| 2 | 4 | 5,515 |
| 6 | 8 | 8,373 |
| 14 | 16 | 14,215 |
| 30 | 32 | 2,541 |

The patch stores its cell as an origin and a size in normalized page
coordinates, as in the baseline. The cell size does not follow the patch's
size: patches of every cell size have a median edge of 34 to 41 metres.
[measured] [[511-lm-resolution]]()

**Addressing.** A patch maps its parameter square onto its cell **edge to
edge**. Parameter 0 lies on the outer edge of the cell's first texel and
parameter 1 on the outer edge of its last: texel coordinate = cell origin + t ×
cell size, sampled with bilinear filtering. At a patch border the sample
therefore blends the cell's edge texel with the slot's ring texel. With this
mapping, the light on the two sides of a shared patch edge agrees. Placing the
corners on the corner texels' centres instead puts every border half a texel
off on both sides, and neighbouring patches visibly disagree. [measured]
[[511-lm-edges]]()

**Orientation.** The cell is applied with the patch's parametric axes
**transposed**, the same convention as the baseline (`160-lighting-data.md`).
[measured] [[511-lm-transpose]]()

> [[511-lm-slots]]() doc:../research/ssx3-world-data.md "Lightmaps"
> (cells): every cell square; every origin ≡ 1 modulo (side + 2) on both
> axes; median page fill 1.00. Baseline contrast: one page size and 8-texel
> tiles without a ring (spec:160-tile).

> [[511-lm-resolution]]() doc:../research/ssx3-world-data.md "Lightmaps"
> (resolution vs size): median patch edge 36.9 / 34.2 / 36.9 / 40.7 m for
> cells 2 / 6 / 14 / 30.

> [[511-lm-edges]]() doc:../research/ssx3-world-data.md "Lightmaps"
> (addressing): mean / 90th-percentile alpha step across about 4,000
> shared edges of Race 1 — 0.3 / 0.75 edge to edge, 6.5 / 17 centre to
> centre.

> [[511-lm-transpose]]() doc:../research/ssx3-world-data.md "Lightmaps"
> (orientation): one-sun fit over the eight square symmetries; transpose
> best, as spec:160-transpose.

## Not established

- What the secondary-page pass computes, and how its mask, page and
  render-state value combine. [open]
- The surface readings for values 0, 1, 5, 7, 13, 17 and 18, and how each
  surface value rides. Chapter 510's caution stands: the baseline's
  response table (`310-surface-response.md`) was not tested against SSX 3.
  [open]
- The patch's remaining small fields; four of them are constant across the
  mountain. [open]
