# 515 — SSX 3: Lights, Halos and Fog

A detail chapter of the SSX 3 addendum (`510-series-ssx-3.md`): the light
record, the separate halo record that carries a lamp's glow sprite, and the fog
bank's particle model and placement. Read it against `160-lighting-data.md`,
`180-particles-data.md` and `220-level-pbd.md`; where this chapter is silent,
nothing was measured. [measured] [[515-role]]()

> [[515-role]]() doc:../research/ssx3-world-data.md "Lights, halos and fog" —
> method and every figure below.

## The light record

Lights are their own resource kind, **1,962 records of 112 bytes**, twenty
bytes longer than the baseline's. They keep the baseline's four type values,
and the same direction, position and influence box, but store the colour and
its strength separately. [measured] [[515-light-record]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 ×4 | header words, constant except a flag in the fourth (below) |
| 0x10 | u32 | type: 0 sun, 1 spot, 2 point, 3 ambient |
| 0x14 | f32 | intensity |
| 0x18 | f32 | the colour's luminance |
| 0x1C | f32 | range (cm) |
| 0x20 | f32 ×3 | colour, each component 0–1 |
| 0x2C | f32 ×3 | direction (unit) |
| 0x38 | f32 ×3 | position |
| 0x44 | f32 ×3 ×2 | influence box (minimum, maximum) |
| 0x5C | f32 | inner cone cosine |
| 0x60 | f32 | outer cone cosine |
| 0x64 | u8 | range mode (below) |
| 0x65 | u8 | not identified; fixed except on spots |
| 0x66 | u16 | constant |
| 0x68 | u32 ×2 | constant words |

Each location carries **exactly one sun and one ambient**, as its first two
light resources (the ambient first), and its spot and point lights follow.
The mountain has **1,213 spot and 651 point lights** in 23 locations: fourteen
events, the five hubs and four connectors. [measured] [[515-light-slots]]()

Types 1 and 2 are named here by their shape (below): every type-1 light is a
cone and every type-2 light shines in all directions. The baseline's chapters
call the same two values point and decorative flare lights
(`160-lighting-data.md`). [measured] [[515-light-box]]()

> [[515-light-record]]() doc:../research/ssx3-world-data.md "Lights, halos and
> fog"; bin 6 census 1,962 × 112 = 219,744 bytes (spec:510-bins); header words
> `005541C9`, 16, `00114B20`, 0 and trailing words `00542BDE`, 16;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldBin6.cs
> reads the same 28 words unnamed. Baseline record: spec:220-light.

> [[515-light-slots]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> ambient at resource id 0 and sun at id 1 in all 49
> locations; spot and point lights from id 2. Per location: `ERA5` 239,
> `DRA4` 225, `CRA3` 215, `ARA1` 188, …; hubs 6–37; connectors `B_BHP1` 13,
> `B_BRA2` 8, `EBC3_E` 3, `E_ERA5` 2.

### Colour, intensity and range

The colour is stored on a 0–1 scale, its brightest channel exactly 1 on most
records, and the **intensity** carries the strength. Apart from the negative
ones below, a spot's runs from under one to about 150,000 (median 140) and a
point light's to about 1,200 (median 30). The luminance field is the
colour's Rec. 601 luma, 0.299 R + 0.587 G + 0.114 B. [measured] [[515-light-colour]]()

The light's strength is the colour times the intensity, the product the
baseline stores as its high-range colour (`160-lighting-data.md`). [inferred]
[[515-light-colour]]()

The **range** is set by a **range mode** byte. [measured] [[515-range-mode]]()

| Mode | Lights | Range |
|---:|---:|---|
| 2 | 1,448 | **4.472 m × √(\|intensity\| × luminance)**, capped at **50 m**: the distance in metres at which \|intensity\| × luminance over the squared distance falls to 0.05 |
| 0 | 232 | always the 50 m cap; nearly all are spots |
| 1 | 179 | set otherwise, mostly at the cap |
| 3 | 5 | shorter than the mode-2 rule; point lights in one event |

Every mode-2 light follows the rule, and every light's influence box follows
its stored range, whatever the mode (below). [measured] [[515-light-range]]()

Seven lights have a **negative intensity**, and they are exactly the seven
whose fourth header word carries the flag 0x100; their range uses the
intensity's magnitude. [measured] Their colours are ordinary, so the sign is
what makes them subtract light. [inferred] [[515-light-negative]]()

> [[515-light-colour]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> luma identity to within 3.9e−8 on 1,962 / 1,962;
> peak channel exactly 1 on 1,485 / 1,962; spot intensity median 140, 90th
> percentile 4,043, maximum 150,600; point median 29.6, maximum 1,239. The
> product reading rests on the range rule below and spec:160-light-types (a
> single high-range colour per baseline record).

> [[515-light-range]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> range = min(5,000, 447.2·√(|intensity| · luminance)) cm within 1% on
> 1,448 / 1,448 mode-2 lights, the seven negative intensities included;
> 447.2 cm = √(1 / 0.05) m. Box fits: spec:515-light-box.

> [[515-range-mode]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> the light word at 0x64 read as bytes, top two `40 39` on all 1,962. Mode 0
> → 5,000 on 232 / 232; mode 1 → 162 / 179 at 5,000, the rest 453–4,999,
> matching the rule only where both give 5,000; mode 3 → 891–1,313 cm against
> a rule value of 2,661–4,759 (`BHP1`). Placeholders carry mode 1. The byte at
> 0x65 is 2 on every point light, sun and ambient and 0–63 on spots, and
> spots sharing a value differ in cone angles.

> [[515-light-negative]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> six spots in `DRA4` (−15 to −100) and one point in
> `BHP1` (−16.1); fourth header word 256 on exactly these seven and 0 on the
> other 1,955.

### Shapes and boxes

A **point light** shines in every direction. It carries zero in both cone
fields and a fixed direction along +X, and its influence box is a cube of the
range either side of the position. [measured] [[515-light-box]]()

A **spot** shines in a cone along its direction, with an **inner** and an
**outer** half-angle: the inner is never wider than the outer, inner angles run
mostly from 15° to 35° and outer ones from 30° to 65°. Its influence box is the
bounding box of the apex, the outer cone's rim at the range, and the point on
the axis at the range. [measured] [[515-light-cone]]() [[515-light-box]]()

> [[515-light-box]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> point lights: box = position ± range, cone fields 0,
> direction (1, 0, 0) on 651 / 651. Spots: the apex + rim + axis-point
> bounding box with the outer angle matches 1,213 / 1,213 within 3 cm
> (median 0.2 cm); with the inner angle, 55 within 1 cm; a flat-capped cone
> (600) and a spherical sector (316) fit less well.

> [[515-light-cone]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> inner cosine ≥ outer on 1,213 / 1,213; inner angles
> most often 35° × 215, 20° × 182, 15° × 156; outer 40° × 229, 65° × 110, 30°
> × 110.

### Suns and ambients are placeholders

**93 of the 98** suns and ambients are one placeholder, byte-identical after
the type: white, intensity 0.6, direction along +X (a horizontal sun), a 12 m
range, and box and cone fields that do not hold numbers. Only five carry
authored values: four connector suns, two of them the same warm sun at about
40° elevation, and hub B's ambient. The real suns' boxes are unbounded.
[measured] [[515-placeholder]]()

The terrain's sunlight is in its lightmaps (`511-ssx3-terrain-and-lightmaps.md`);
these records do not describe the light the mountain was lit with. [inferred]
[[515-placeholder]]()

> [[515-placeholder]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> 45 suns + 48 ambients share one tail after the type
> word (box words not floats, the first of them `77C47EA4`); authored:
> suns on `A_ABA1` and `ABC1_A` (intensity 0.6, colour (0.872, 0.787,
> 0.483), direction (0.329, −0.693, −0.641)), `B_BHP1` (0.25, blue, shining
> upward) and `B_BRA2` (0.6, blue, elevation about 12°), each boxed at ±1e20;
> ambient on `B` (0.33, colour (0, 0.156, 0.248)).

## Halos

A light record has no glow-sprite field. A lamp's **halo**, the sparkle the
baseline draws from a light whose glow-sprite class is small
(`160-lighting-data.md`), is a record of its own: **1,679 records of 80
bytes**, in fifteen events, hub D and four connectors. [measured]
[[515-halo-record]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | one value per location, not identified |
| 0x04 | u32, f32 | constant |
| 0x0C | u32 | sprite size: 16 or 32 |
| 0x10 | f32 ×3 | colour, each component 0–1 |
| 0x1C | f32 ×3 | position |
| 0x28 | f32 ×3 ×2 | box (minimum, maximum) |
| 0x40 | u32 | constant |
| 0x44 | u32 | different on every halo, not identified |
| 0x48 | u32 ×2 | constant |

The sprite size takes two of the baseline's three glint classes, **16 (861
halos) and 32 (818)**, and the box is the sprite's: centred on the position,
1 m across for size 16 and 2 m for size 32, the baseline's quad sizes for the
same classes. [measured] [[515-halo-size]]()

Halos sit on **lamp and flare props**, not on light records. Most lie inside
the box of a road flare, a searchlight, a pinlight, an uplight, a neon tube
or a podium, and only one in 26 is within a metre of a spot or point light.
[measured] So it is the halo, not the light record, that marks where a lamp
glints. [inferred] [[515-halo-owners]]()

> [[515-halo-record]]() doc:../research/ssx3-world-data.md "Lights, halos and
> fog"; no light word varies like a sprite class (the second header word is
> 16 on all 1,962 lights, suns and ambients included); bin 7 census 1,679 ×
> 80 = 134,320 bytes (spec:510-bins); constants: second word `00114744`,
> third −0.31246, words at 0x40 and 0x4C 33, word at 0x48 `005553C5`; the
> word at 0x44 non-decreasing in record order 1,670 / 1,678 times; no decoder
> reads this bin. Baseline glint gate and quad sizes:
> spec:160-glint.

> [[515-halo-size]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> size 16 → box ±50 cm on 861 / 861; size 32 → ±100 cm on
> 818 / 818; box centred on the position on 1,679 / 1,679.

> [[515-halo-owners]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> 1,428 / 1,679 inside an instance's world box; by the
> smallest enclosing box: road flares 149, `duolight` 140, `smallstarbody` 71,
> searchlights 158, pinlights 74, podium interiors 56, uplights 53, neon 48.
> Nearest spot or point light: median 10.8 m, 64 of 1,658 within 1 m.

## Fog

The particle models and placements have the layout of the baseline's particle
volumes, its **fog banks** (`180-particles-data.md`): a cluster of billboard
puffs, each a position, a three-float field and a radius, placed by a world
transform with a world box. Each model is placed exactly once, by the
placement with the same location and resource id, where the baseline lets many
placements share a model by index. There are **141 of each**, in twelve events
and hub E. [measured] [[515-fog-model]]() [[515-fog-placement]]()

The **model** keeps the baseline's layout (`220-level-pbd.md`) with three
differences. Its first word is the model's own resource reference where the
baseline has its byte size. Its object table gives each object's offset from
the record's start, not from the table. And the object opens with its box,
without the baseline's leading size word. Records are padded to a multiple of
16 bytes. [measured] [[515-fog-model]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | the model's resource reference |
| 0x04 | u32 | object count (1 on every model) |
| 0x08 | u32 | offset of the object table (0x20) |
| 0x0C | u32 ×5 | zero |
| 0x20 | 16 bytes per object | table entry: −1, object offset from the record's start, 0, −1 |
| object + 0 | f32 ×3 ×2 | box (minimum, maximum), model space |
| object + 24 | u32 | zero on every model |
| object + 28 | u32 | puff count |
| object + 32 | u32 | offset of the puffs from the object's start |
| puffs | 28 bytes each | position f32 ×3; a three-float field; radius f32 |

A model holds **9 to 29 puffs** (1,803 in all) of 2 to 47 m radius. The
three-float field takes a **single value per model**, every component between
0 and 1, most often a pale blue or a neutral grey. [measured] [[515-fog-puffs]]()

The model's box always contains its puff spheres. It matches their bounds
vertically on most models and on every axis on about a fifth. Elsewhere it is
wider horizontally, by up to about 10 m and unevenly on each side, so it is
not built from the stored puffs alone. The baseline's box is exactly the puff
spheres' bounds. [measured] [[515-fog-puffs]]()

The **placement** is 144 bytes. [measured] [[515-fog-placement]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 ×4 | zero |
| 0x10 | f32 ×16 | world matrix, rigid |
| 0x50 | f32 ×4 | bounding sphere (centre, radius) |
| 0x60 | u32 ×2 | the model's resource reference, twice |
| 0x68 | f32 ×3 ×2 | world box (minimum, maximum) |
| 0x80 | u32 ×4 | zero |

On an unrotated placement the world box is the model's box moved by the
translation. On a rotated one it matches neither the rotated model box nor
the bounds of the rotated puffs, where the baseline's is the bounds of the
rotated puffs. The sphere is centred on the world box, its radius at most the
box's half diagonal. [measured] [[515-fog-placement]]()

> [[515-fog-model]]() doc:../research/ssx3-world-data.md "Lights, halos and
> fog"; bin 4 census 141 records, 62,336 bytes (spec:510-bins); first word =
> track | resource id << 8 on 141 / 141; table entry (−1, 48, 0, −1) and
> frame offset 36 on all; length = 84 + 28 × puffs on 140, one with 8 bytes
> of padding. Baseline layout: spec:220-particle-model; locations `DSS2` 33,
> `DBC2` 24, `DRA4` 19, … and hub `E` 7.

> [[515-fog-puffs]]() doc:../research/ssx3-world-data.md "Lights, halos and fog";
> radius 1.9–46.7 m (median 12.2); middle triple one value per model on
> 141 / 141, most often (0.801, 0.912, 1) × 33, (0.593, 0.69, 0.891) × 24,
> (0.917, 0.917, 0.917) × 18. Model box ⊇ puff spheres on 141 / 141, equal in
> Z on 123 and on all axes on 31, horizontal excess up to 10.5 m; a vertical
> billboard sweep, a radius factor and the triple as a scale all fit worse.
> Baseline: equal to the puff spheres' bounds (0 on Elysium and Alaska, under
> 1% on Garibaldi and Merqury City; spec:180-volumes).

> [[515-fog-placement]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldParticleInstance.cs
> read order; bin 5 census 141 × 144 = 20,304 bytes; paired with its model by
> (location, resource id) and by the stored reference on 141 / 141; rigid on
> 141, unrotated on 89; world box = model box + translation on 87 of the 89;
> sphere centred on the world box on 141 / 141, radius 0.48–1.0 of the half
> diagonal; rotated (52): rotated model box and rotated puff bounds both miss
> by metres. Baseline rotated placements: the rotated puff spheres' bounds
> within 2% (Alaska 26, Garibaldi 6), the rotated model box 18%. Baseline
> placement: spec:220-particle-instance.

## Not established

- The falloff each range mode applies, and the byte beside the mode. [open]
- The halo's per-location word and its per-halo word. [open]
- What the fog model's horizontal margin and a rotated placement's world box
  are built from. [open]
- Whether the puff's three-float field is a scale, as the baseline's reading
  has it (`180-particles-data.md`), or a tint, as its per-model, blue-leaning
  values suggest. The stored bounds ignore it on both games, which does not
  decide between the two. [open]
- How the engine combines a spot's two cones, and whether the halo and the
  baseline's glint renderer are the same code. [open]
