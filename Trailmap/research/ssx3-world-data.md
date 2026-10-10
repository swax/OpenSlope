# SSX 3 world data — terrain, textures, collision, paths, lights and fog

Measurements behind the SSX 3 detail chapters 511–515. They extend
[series comparison](series-comparison.md), which established the container and the record census
(spec:510-ssb); this note goes field by field through what an importer has to get right to show the
mountain faithfully. All figures are from the reader's own NTSC-U disc (`SLUS_207.72`,
`DATA/WORLDS/BAM.BIG`).

## Sources and method

- **Census probe.** A short C# program over the SSX-Library fork's SSX 3 handlers: `SDBHandler`,
  `PHMHandler`/`PSMHandler` for names, `SSBHandler.ReadResources` for the resource walk (every streaming
  chunk the `.sdb` lists, in order), and `WorldPatch`, `WorldBin0`, `WorldSSH`, `WorldMDR`,
  `WorldInstance`, `WorldCollision` and `WorldAIP` for the records. The probe and its full output are kept
  locally in `ResearchData/ssx3-world/` (`Program.cs`, `census.txt`); they are not versioned, since the
  output is a derivative of the disc. Re-running it over the same `bam.ssb` reproduces every number below.
- **Import investigation.** Several findings came out of making the mountain ride correctly in a
  downstream viewer, where a wrong reading shows as a visible defect: a lighting step at every patch border,
  grey streaks on ice, black specks, props a rider passes through. Each was then measured mountain-wide
  with the probe. The two lightmap tests that needed sampled geometry (`seams.py`, `lmfit.py`, also kept in
  `ResearchData/ssx3-world/`) ran over exported patch data in the same world space.
- **Lights, halos and fog probe.** A second program (`ResearchData/ssx3-world/fx/`, output `census515.txt`)
  reads bins 4–7 as raw words, since the decoder has no reader for bin 7 and reads bin 6 as unnamed fields.
  Its `WorldBin6` also stores the ninth word twice and never sets the tenth. The program tests each field
  reading against the whole mountain, then fits each box against geometric models. The readings were then
  carried into a downstream viewer, where the lights, glints and fog volumes landed on the props and runs
  they belong to.
- **Vertex-lighting probe.** A third program (`ResearchData/ssx3-world/vlight/`, output `out.txt` and
  `out2.txt`) walks every instance tail for the vector-unit unpacks of 16-bit colours, compares their
  counts with the vertex records of the instance's model, and histograms the colours. The reading was then
  carried into a downstream viewer, where the props took on the terrain's lit-and-shaded tones.
- Library field names (`U2`, `U7`, `U14`, …) are the decoder's placeholders, used here only to name what
  was measured. A field that was only known as a placeholder before is described by role in the chapters.

## Locations and peaks

- `.sdb` names 49 locations: five hubs (`A`–`E`), seventeen events (letter + discipline + index), 21
  connectors named `<from>_<to>`, five skies (`ASKY`–`ESKY`) and `TRANSP`, which places no patches.
  (spec:511-locations)
- Patch-centre heights by letter (median, m): E 4,925; C 1,853; D −395; A −2,290; B −5,001. Hubs alone: E
  5,076; C 2,271; D −159; A −2,168; B −4,501. Hence peak 3 = E, peak 2 = C over D, peak 1 = A over B, with
  B the foot of the mountain. (spec:511-peaks)
- 173 patch corners are shared by patches of two or more locations, joining 43 location pairs: the
  locations meet edge to edge in one world space with no per-location origin. (spec:511-one-space)

## Patch fields

- `U2` (surface value): histogram as in spec:510-surface. Name-word census per value (top words after
  dropping track codes and generic `sec`/`surface`/`terrain`/`wholetrack` words): 2 → `powder` ×350;
  3 → `deepowder` ×74, `rocky` ×51; 4 → `ice` ×46; 8 → `alpsa`…`alpsg` on all 257; 9 → `nurbtree` ×153,
  `packnurbtree` ×24, `log` ×8; 10 → `podium`/`top` ×45, `helipad`, `metalfront`, `metend`; 1 →
  `watersurface` ×25; 17 → `sup`, `botcem`; 0, 7, 13 and 18 → generic section names, with 7 and 18 adding
  `groundingwalls`, `skyways`, `midground`, `forest`. This explains spec:510-surface's tilt anomaly: value 9
  is tree trunks (vertical) and value 10 podium tops and helipads (flat). (spec:511-surface-names)
- `U14` (secondary page): −1 on 26,749 patches; 297 ×2,134, 62 ×1,051, 198 ×710. `U4` is 425 on exactly
  those 3,895 patches and 41 on every other one; `U5` has bit 0x20 or 0x40 set on the same 3,895
  (values 224, 96, 120, 248, 240, 104, 112, 232) and on no other patch. `U15`–`U17` are −1 and `U18`/`U19` constant (18,492 / 17)
  on every patch. (spec:511-secondary)
- 331 distinct texture pages and all 623 lightmap pages are referenced by patches; no patch lacks a
  lightmap.

## Lightmaps

- **Pages.** 623 bin-10 records, ids 0–622, each id once (no repeats across groups). All 32-bit RGBA,
  square: 395 × 128 px, 91 × 64 px, 137 × 32 px. (spec:511-lm-pages)
- **Channels.** Alpha spans 0–255 (histogram in 32-wide bins: 1.03 M, 2.28 M, 1.55 M, 1.24 M, 0.61 M,
  0.11 M, 0.03 M, 0.14 M). Mean RGB is 51.9 on texels with alpha < 128 and 31.1 on the rest — the residual
  is larger in shade, as the baseline's two-term encoding gives for a coloured light. (spec:511-lm-terms)
- **Cells.** Scaling each patch's lightmap rectangle by its page's size: every cell is square, and its side
  is 2, 6, 14 or 30 texels (14 ×14,215 patches, 6 ×8,373, 2 ×5,515, 30 ×2,541), on every page size. Every
  origin is ≡ 1 modulo (side + 2) on both axes, i.e. one texel inside a 4-, 8-, 16- or 32-texel slot
  boundary. Summing (side + 2)² over each page's patches gives a median page fill of 1.00 (minimum 0.02,
  the partly used last page). (spec:511-lm-slots)
- **Resolution vs size.** Median patch edge length (first two cached corners) is 36.9, 34.2, 36.9 and
  40.7 m for cell sides 2, 6, 14 and 30: the cell resolution does not follow patch size.
  (spec:511-lm-resolution)
- **Addressing.** `seams.py` samples the lightmap alpha at nine points along every edge two patches share
  and compares the two sides, under candidate mappings of patch parameter t to a texel coordinate. Over
  Race 1 with its connectors (about 4,000 shared edges), mean / 90th-percentile |ΔA|: corners on texel
  centres (cell origin + ½ + t·(side − 1)) 6.5 / 17; corners on the outer texel edges (origin + t·side,
  bilinear) 0.3 / 0.75; the edge mapping was the best of the candidates the script tries (shifts,
  half-texel insets, one-texel outsets). For scale, the baseline's own ALOHA under its centre mapping scores 5.95 / 4.
  (spec:511-lm-edges)
- **Orientation.** `lmfit.py` fits one directional sun to lightmap intensity against the analytic patch
  normal, under each of the eight square symmetries of the patch→cell mapping. The transposed mapping fits
  best, as it does on the baseline's courses (spec:160-transpose). (spec:511-lm-transpose)
- **Base brightness.** 757 of 788 texture pages have a colour channel above 128, where the baseline stores
  textures at half brightness (spec:210-halfbright); the blend therefore works on a full-range base. This is
  a derivation, checked visually in the import: reading the base as full range gives lit snow white and
  shade blue. (spec:511-lm-base)

## Textures

- **Ids.** 6,203 bin-9 records, 788 distinct ids (0–787); 5,415 records repeat an id already seen, and
  every repeat is byte-identical to the first. (spec:512-ids)
- **Formats.** 4-bit indexed 476, 8-bit indexed 308, 32-bit 4. (spec:512-formats)
- **Alpha scale.** Over all 784 palettes, no entry's alpha exceeds 128: alpha is on the console's 0–128
  scale. The decoder doubles a palette whose maximum is at most 128. (spec:512-alpha-scale)
- **8-bit palette order and extent.** `WorldSSH` unswizzles every 8-bit palette with the 8/16 bit swap of
  spec:210-palette. The header's colour count (`Total`) is 255 on 196 pages and smaller elsewhere. The
  stored table is never shorter than the highest swizzled slot of any colour below the count, plus one,
  and on 265 of the 308 pages it is longer only by rounding to a whole four-entry row. A colour whose
  swizzled slot lies at or past the count is therefore stored in that extension: 41 pages carry 3,668 such
  texels. Texture 479 lists 236 colours and stores 244 slots; colours 232–235 swizzle to slots 240–243.
  Reading only `Total` slots decoded those texels as transparent black. 38 of 476 4-bit pages also store
  past their count, harmlessly, since 4-bit palettes are not interleaved. (spec:512-palette-order
  spec:512-palette-extent)
- **Fix history.** The fork's `WorldSSH` previously read `Total` slots; it now reads every stored slot up to
  256 before unswizzling (`WorldShapePaletteTests` covers it).

## Materials

- 2,575 bin-0 records. Fields: `TextureID` (primary page), `U1` (secondary page: −1 on 2,456; 50 ×88,
  198 ×12, 62 ×11, 297 ×8), `U7` (render state). `U2` is −1 and `U3` 0 on every record; `U8` is −1 on
  2,550. (spec:512-material-record)
- `U7` census: 1 ×1,487; 3 ×522; 7 ×397; 39 ×51; 33 ×36; 97 ×30; 31 ×21; 27 ×20; 25 ×9; 121 ×2. Bit 0x01
  on all. Bit 0x20 is set on exactly the 119 materials with a secondary page (39, 33, 97, 121).
  (spec:512-render-state)
- Against the decoded page (clear = alpha < 8, solid = alpha ≥ 250): no 0x02/0x04/0x40 bit → 1,532
  materials, 6 pages with any clear texel, 17 with any non-solid texel; 0x02 without 0x04 → 481 of 542
  pages have clear texels; 0x04 → 469 of 469 non-solid; 0x40 → 32 of 32 non-solid. (spec:512-state-vs-alpha)

## Terrain alpha

- Of the 331 terrain pages: 237 fully solid; 93 with clear or partial alpha that is not cutout-shaped; one
  cutout-shaped by the test ≥ 5% clear and ≥ 25% solid — page 307 (33.4% clear, 14.5% partial, 52.1%
  solid), on 7 patches of EBA3's big-air ramp truss. Those patches' `U3` (1 or 9), `U4` (41) and `U5` (0)
  match ordinary solid terrain: no patch field marks the cutout. Page 376: 70.6% clear, 29.4% partial, maximum alpha
  78 of 255, on 118 patches. Page 653: 39.8% clear, 60.1% partial, on 705 patches. (spec:512-terrain-mask
  spec:512-cutout)
- All 3,895 patches with a secondary page sit on one of the 93 masked pages; 5,068 patches use a masked
  page in all, and 64 of the 93 are used only by patches with a secondary page. The secondary pages (62,
  198, 297, and 50 for materials) are partial everywhere, at a uniform half alpha. (spec:512-mask-pass)
- Materials with no alpha bit whose page has non-solid alpha: 17 of 1,532. (spec:512-state-vs-alpha)
- **Negative result.** A per-pixel transparency reading of terrain alpha is wrong on every page except 307:
  it opens holes along ice and carved snow, and a viewer that premultiplies alpha also loses the colour
  under the mask (376's streaks came out flat grey).

## The debug page

- Texture 17 (solid orange) is the page of 41 materials. 1,129 models draw only with it (3,174
  instances); 4 instances' models mix it with real pages. The families are all helpers: reset planes and
  panels (≈1,650), reset volumes 286, backcountry volumes 229, fence collision under several spellings
  (≈490), fence proxies 50, backcountry teleports 42, one-way volumes 23, impact and raven triggers, load and
  unload boxes 37, ride-state boxes, start and finish reset planes. (spec:512-debug-page spec:513-helpers)

## Models, instances and collision

- 10,644 model records; every one is placed, and every instance's model is in the instance's own location
  (41,113 / 41,113). 9,105 instance names equal their model's name. (spec:513-models)
- Instance bounds: the box is ordered min ≤ max on all 41,113 instances; the sphere's centre is the box
  centre on 40,773. (spec:513-bounds)
- **Proxy kinds.** 4,616 bin-12 records: suffix `ProgMesh` 3,415 and `ConvexHull` 1,104, all header kind 1;
  `SphereTree` 97, all header kind 3, which the decoder does not read. (spec:513-proxy-kinds)
- **Layout.** Kind 1 is a list of sub-meshes: 4,154 have one, the rest 2–13. Each sub-mesh has byte vertex
  indices (most vertices in one sub-mesh 253; most triangles 456), four-component vertices, one normal
  per triangle and a list of boxes. (spec:513-proxy-layout)
- **Space.** Transforming each proxy by its name-owner instance's matrix, its box matches the instance's
  world box: median and 75th-percentile difference 0, 90th percentile 5.5 m (proxies deliberately
  larger or smaller than the art). (spec:513-model-space)
- **Binding.** Every proxy's base name is an instance in the same location (4,616 / 4,616). Grouped by
  (location, owner's model): 4,598 pairs, 18 with a second proxy. Every one of the 4,598
  (location, model) placements of a model that has a proxy anywhere carries the proxy in that location —
  none is missing. Instances covered: 4,616 read by name, 21,268 read by (location, model). Rock-named
  instances outside the helper set: 4,641, of which 1,457 by name and 4,489 by model. Instance records
  carry no proxy field (spec:510-instance). (spec:513-binding spec:513-coverage)
- **Earlier misreading.** spec:510-name-scheme read the 4,616 / 4,616 name match as per-instance pairing.
  A downstream import that bound proxies by name left two-thirds of the rocks and many trees passable; one
  boulder model (`rock_de_bolder_d`) has 439 placements and one proxy.
- **No proxy anywhere.** Rocket cores, summit rock formations (`4peakrocka`, `peakrock`, `2peakrock`),
  `noColliderockwall`, falling and impact rocks, cave poly-rocks. (spec:513-no-proxy)
- **Sphere trees.** Crash bags and their end builds, breakable collectables, rock slides, the avalanche
  boulders and bits, ad-board curves, timers, a fountain and a spray nozzle. (spec:513-sphere-trees)
- **Helpers with proxies.** 2,677 of 3,174 helper instances. By kind (placements / with proxy): reset
  planes 1,679 / 1,455; fences and fence proxies 555 / 555; reset volumes 286 / 286; backcountry volumes
  229 / 220; triggers 189 / 5; start and end fences 77 / 77; teleports 42 / 0; load and unload 37 / 37;
  one-way 23 / 1; ride-state 17 / 17; other 40 / 24. (spec:513-helper-proxies)
- **Triggers on real pages.** 205 trigger-named placements whose models are not debug-page-only:
  `treetopatrig` 73, `trigroundspeaker` 14, `EZseqTrig` 12, `dragonTrig`/`dragontrig` 17, `seqpopTrig` 10,
  `seqgushTrig` 12, `lanterntrig` 6, `poptrig`/`popFlashTrig` 14, … (spec:513-helpers)
- **Two proxies per (location, model)** (18 pairs): event-build variants (`crashbag` with
  `crashbag_end_build`, `flagpolea` with `flagpolea_eb`, `tent_dome_openside_a` with its `_eb`), one
  placement with two kinds (`turbine` mesh + hull, `rock_de_bolder_d_01_3201` mesh + hull,
  `2peakrock_steep_summit5` sphere tree + hull, `osprey` hull + mesh, `unique_cargobin_end` hull + sphere
  tree), and paired reset planes and ice walls.

## Baked prop lighting

- **What the tail uploads.** Every instance tail holds 16-bit colour unpacks (vector-unit unpack V4-5, one
  per model part that has vertices). Their colours total exactly the model's vertex count, summed over its
  vertex records in object, part and record order, on 41,112 / 41,113 instances. 39,855 also match record
  by record; the others differ only by vertex records of length zero, which upload nothing. The exception
  is `mdl_CBA2_start_bldg_jumbotron`. A vertex record whose normal record is missing (the decoder then
  draws no triangles from it) still counts. (spec:513-vertex-light)
- **Size.** 4,112,542 colours (7.8 MB as halfwords), mean 100 per instance, the largest 3,222. Race 1
  alone: 284,979 over 3,052 instances.
- **Per placement.** 2,758 models are placed more than once; of their 30,469 later placements, 26,052
  carry different colours from the model's first. 5,844 instances carry one colour on every vertex.
  (spec:513-vertex-light-placement)
- **Scale.** Bits 0–4, 5–9 and 10–14 are red, green and blue. The five sky domes (`ASKY`–`ESKY`) carry
  (16, 16, 16) on all 365 vertices each. The commonest single-colour constants: (9, 9, 9) × 1,257, all
  reset planes and transport helpers; (15, 15, 15) × 287; (16, 16, 16) × 246; (17, 17, 17) × 245; neon
  signs at (21, 22, 25) × 190, (18, 18, 19) × 176 and (20, 20, 21) × 137. Across all colours a channel
  exceeds 16 on 11.2% and peaks at exactly 16 on 2.8%. (spec:513-vertex-light-scale)
- **Per location** (mean r, g, b in five-bit units): `ARA1` 8.5, 9.1, 11.3; `ASS1` 8.5, 9.2, 11.4;
  `BRA2` 11.1, 12.2, 12.8; `BHP1` 12.0, 13.3, 14.2; hub `B` 2.7, 3.6, 4.3; `EBC3_E` 1.7, 3.1, 4.7;
  `C` 8.8, 7.1, 7.5. Blue leads everywhere except hub `C`, `CRA3` and the connectors leaving `C`
  (`C_CBA2`, `C_CHP2`, `C_CRA3`), where red equals or leads it; the skies and `TRANSP` are grey.
- **Alpha.** The top bit is set on 4,093,188 colours. 1,003 placements clear it on some vertices and none
  on all. By name they are light beams, glows and god rays (`searchlight*` 380, `bigchal_*` 272,
  `pinlight_*` 166, `streetlightglow*` 63, god-ray and up-light sheets 21), snow and water sheets
  (`snowstream` 45, `snowsheet` 10, `waterfall` 9) and `ospreySheet` 30. (spec:513-vertex-alpha)
- **Viewer check.** Applied as the GS applies a vertex colour (texel × colour / 128 per channel, product
  saturated, with five bits widened by three places), Race 1's start lodge and its props take the blue
  shade and lit windows the lightmapped snow around them has. Lit by a sun instead, they were uniformly
  grey.

## Paths, rails and sky

- Bin 14 has three records per location (ids 0, 1, 2; 147 in all), 50 of them non-empty: id 0 in the 43
  locations other than skies and `TRANSP` (1,168 AI paths, 143 type-1 track paths), id 1 in the five hubs
  (32 / 17), id 2 in hubs A and D (14 / 6). The decoder's extractor names ids 1 and 2 peak race and peak
  showoff. (spec:514-path-slots)
- **Type-1 float.** For the 64 type-1 paths whose end lies within 1 m of another type-1 path's start, the
  drop in the float from a path to its successor equals the path's summed horizontal step length:
  ratio 1.000 from the 25th to the 90th percentile; against the 3D length the median ratio is 0.82. 7 of
  the 64 increase (junctions). The baseline's distance-to-finish uses the same horizontal metric
  (spec:250-dtf). The float ranges to
  452,413 (4.5 km); 13 paths have under 10 m left; the minimum is −1. (spec:514-race-distance)
- **Starts.** The start-grid list holds positions; counts per event resource range 1–14.
  (spec:514-start-slots)
- **Splines.** 2,659 records in one list; name words: `rail` 751, `railslides` 346, `treerailhevbb` 187,
  `benchrail` 102, `handplant` 100, `log…teeter` ≈135, `dragonpath` 37, `fence` 31, `boxcar` 27, … No field
  separating rails from animation paths was found. Animation-path names: `path_` 51, `rocketpath` 32,
  `ospreyrails` 25 (an osprey flight path named as a rail), raven and eagle splines, `gondolarail` 2
  (the gondola's line), `dragonpath`. (spec:514-splines)
- **Peak race coverage.** On the imported peaks the slot-1 race lines were seen in a viewer to cover the
  hub ground only, not the event runs between hubs; not measured against the event lines.
  (spec:514-peak-coverage)
- **Sky.** Each sky location places one instance whose model has 18 parts. (spec:514-sky)

## Lights, halos and fog

Words are numbered from 0 within each record.

- **Light records.** Bin 6: 1,962 records, all 112 bytes. Every location has exactly one type-0 and one
  type-3 record, at resource ids 1 and 0; its type-1 and type-2 records start at id 2. The type is word 4.
  Words 0–3 are `005541C9`, 16, `00114B20`, 0 on 1,955 records; word 3 is 256 on the other seven. Words
  26–27 are `00542BDE`, 16 on all 1,962. (spec:515-light-record spec:515-light-slots)
- **Placeholders.** 93 of the 98 type-0/3 records (45 suns, 48 ambients) have one byte-identical tail from
  word 5 on: intensity 0.6, colour (1, 1, 1), direction (1, 0, 0), range 1,200, and words 17–24 that are
  not floats (word 18 `77C47EA4`). The five others: suns on `A_ABA1` and `ABC1_A` (both intensity 0.6,
  colour (0.872, 0.787, 0.483), direction (0.329, −0.693, −0.641): elevation about 40°), on `B_BHP1` (0.25,
  blue, direction z +0.636, so shining upward) and on `B_BRA2` (0.6, blue, elevation about 12°); and an ambient on hub
  B (0.33, colour (0, 0.156, 0.248)). The four real suns' boxes are ±1e20. (spec:515-placeholder)
- **Colour, intensity, luminance.** Word 6 equals 0.299·R + 0.587·G + 0.114·B of words 8–10 to within
  3.9e−8 on all 1,962 records. Colour components lie in 0–1, with the peak channel exactly 1 on 1,485.
  Intensity (word 5) for spots: median 140, 90th percentile 4,043, maximum 150,600; for points: median
  29.6, maximum 1,239. Directions are unit length on all records. (spec:515-light-colour)
- **Range.** Word 7 equals min(5,000, 447.2·√(intensity · luminance)) to within 1% on 1,464 of the 1,864
  spot and point lights. The other 400: 395 longer, 371 of them exactly 5,000 (`ABA1` spots of
  intensity 3–6 at 5,000, where the rule gives 360–990); 5 shorter, all point lights in `BHP1`. The
  seven negative intensities are among the longer ones only because the rule was first taken with a
  signed intensity; the mode byte below explains the rest. (spec:515-light-range)
- **Boxes.** Point lights: box = position ± range on 651 / 651, cone words 0, direction (1, 0, 0) on all.
  Spots: inner cosine (word 23) ≥ outer (word 24) on 1,213 / 1,213. Fitted against the spot boxes: the
  bounding box of a flat-capped cone (slant length = range, outer angle) matches 600 within 1 cm and
  714 within 1 m; a spherical sector matches 316 within 1 cm, its misses all on the axis-facing side. The
  bounding box of the apex, the outer cone's rim at distance range and the axis point at distance range
  matches 1,213 / 1,213 within 3 cm (median 0.2 cm); with the inner angle, 55 within 1 cm. Inner angles
  most often 35°, 20°, 15°, 25°; outer 40°, 65°, 30°. (spec:515-light-box spec:515-light-cone)
- **Negative intensity.** Seven records: six spots in `DRA4` (−15 to −100) and one point in `BHP1`
  (−16.1). They are exactly the seven with word 3 = 256. (spec:515-light-negative)
- **Word 25 is a mode byte, not a float.** Read as a float it gives 2.891–2.894, but its top two bytes are
  `40 39` on all 1,962 records and its two low bytes are small integers. The lowest byte sorts the range:
  - **2** on 1,448 spot and point lights. The range rule holds on all 1,448 once the seven negative
    intensities are taken by magnitude (`DRA4` −100: 447.2·√(100 × 0.751) = 3,876, stored 3,876.7).
  - **0** on 232 (231 spots, 1 point), every one at 5,000.
  - **1** on 179 (104 spots, 75 points): 162 at 5,000, the rest 453–4,999. They match the rule only where
    both give 5,000 (22).
  - **3** on 5 point lights in `BHP1`, shorter than the rule (891–1,313 cm against 2,661–4,759).

  With magnitudes, the rule holds on 1,471 of 1,864, and those 1,471 are mode 2 plus the 23 capped
  coincidences. Placeholders carry mode 1. (spec:515-light-range spec:515-range-mode)
- **The byte above it** is 2 on every point light, sun and ambient, and 0–63 on spots, most often 20 (275),
  15 (183), 5 (141), 1 (127) and 0 (216). It does not follow the cone angles: spots sharing a value have
  different inner and outer angles. (spec:515-range-mode)
- **Where.** 1,213 spots and 651 points in 23 locations: fourteen events (`ERA5` 239, `DRA4` 225, `CRA3`
  215, `ARA1` 188, …), the five hubs (6–37 each) and four connectors (`B_BHP1` 13, `B_BRA2` 8, `EBC3_E` 3,
  `E_ERA5` 2). (spec:515-light-slots)
- **Halo records.** Bin 7: 1,679 records, all 80 bytes, in 20 locations: fifteen events, hub D and four
  connectors. Word 3 is 16 on 861 and 32 on 818; the box (words 10–15) is centred on the position (words
  7–9) on all of them, at ±50 for size 16 and ±100 for size 32 without exception. Colours (words 4–6) lie
  in 0–1, peak exactly 1 on 1,306. Word 0 takes one value per location (20 values, 20 locations). Words 1,
  2 (−0.31246), 16 (33), 18 and 19 (33) are constant. Word 17 differs on every record and is
  non-decreasing in record order 1,670 times out of 1,678. (spec:515-halo-record spec:515-halo-size)
- **What halos sit on.** Nearest spot or point light in the same location: median 10.8 m, 64 of 1,658
  within 1 m, 392 within 5 m. 1,428 of 1,679 lie inside an instance's world box (10 cm tolerance). By the
  smallest such box: road flares 149, `duolight` 140, `smallstarbody` 71, searchlights 158 (blue,
  magenta, orange), podium interiors 56, pinlights 74, uplights 53, neon 48; large boxes such as rock
  walls, fence collision and reset planes (114) are where no lamp model encloses the halo.
  (spec:515-halo-owners)
- **Particle models.** Bin 4: 141 records, 62,336 bytes. Word 0 = track | resource id << 8, the record's
  own reference, on 141 / 141. Object count 1, table offset 32, words 3–7 zero, and table entry (−1, 48,
  0, −1) on all 141. At byte 48: box, a word that is 0 on all, frame count 9–29 (median 13; 1,803 puffs
  in all), frame offset 36. Length = 84 + 28·frames on 140; one record (hub E, resource 2) carries 8
  trailing bytes; every length is a multiple of 16. (spec:515-fog-model)
- **Puffs.** Radius 1.9–46.7 m (median 12.2 m); model box diagonal 26.5–279 m. The union of the puff
  spheres reproduces the model box to within 10.1% of its diagonal (median 3.5%), against ~1% on the
  baseline's courses (spec:180-volumes). The middle triple takes a single value per model on 141 / 141,
  every component in 0–1, most often (0.801, 0.912, 1) ×33, (0.593, 0.69, 0.891) ×24, (0.851, 0.929,
  0.992) ×19 and (0.917, 0.917, 0.917) ×18. (spec:515-fog-puffs)
- **What the model box is built from.** The stored box contains the puff spheres on 141 / 141. It matches
  their bounds in Z on 123 and on all three axes on 31. Elsewhere it is wider horizontally, by up to
  10.5 m and differently on each side (`ARA1` resource 5: 4.9, 6.7, 6.9 and 7.2 m past the puffs on the
  four horizontal sides). These fit worse than the plain radius: a billboard swept about the vertical (√2·r
  horizontally), a uniform radius factor k (0.8 ≤ k ≤ 1.5), centres ± the largest radius, and the radius
  scaled by the middle triple. Baseline, from the same importer's Tricky extracts:
  - The model box is the puff spheres' bounds: 0 on Elysium (19 models) and Alaska (17), under 1% on
    Garibaldi and Merqury City.
  - A rotated placement's world box is the bounds of the rotated puff spheres, within 2% on Alaska (26)
    and Garibaldi (6). The rotated model box misses by 18%.
  - Scaling the radius by the triple worsens every fit on both games, so the stored bounds ignore it.
    Since every component is at most 1, that does not separate a tint from a shrinking scale.

  (spec:515-fog-puffs spec:515-fog-placement)
- **Particle placements.** Bin 5: 141 records of 144 bytes, one per model with the same location and
  resource id, carrying the model's reference twice (141 / 141). Transforms are rigid on all 141; 89 are
  unrotated. The world box equals the model box moved by the translation on 87 of the 89 unrotated
  placements. On the rotated ones it is neither the bounding box of the rotated model box nor that of
  the placed puff spheres (over all 141, the puff-sphere bounds miss by a median 4.4% of the diagonal,
  at most 27%). The sphere is centred on the
  world box on 141 / 141, its radius 0.48–1.0 of the box's half diagonal. 13 locations: twelve events
  (`DSS2` 33, `DBC2` 24, `DRA4` 19, …) and hub E (7). (spec:515-fog-placement)

## Bin census reconciliation

The first census (spec:510-bins, from the walk described in [series comparison](series-comparison.md))
listed 29 bin-14 records of 737,680 bytes and 2 each of bins 16 (28,668 bytes) and 18 (144 bytes), with no
bins 21 or 22. Walking the streaming database's chunk table finds 147, 49 and 49. A second probe (kept in
`ResearchData/ssx3-world/walk/`) settled which is right and why they differ.

- **Two independent walks agree.** A whole-file walk, which reads every chunk in file order, closes a group
  at each `CEND` and reads records to the end of the decompressed group, finds the same 103,688 records as
  the database-framed `ReadResources`. Every group ends exactly at a record boundary.
- **The database declares the corrected counts.** The per-location counts in the `.sdb` location table
  (`numSoundTrigger` … `numAvalancheAnimation`) total 13: 49, 14: 147, 15: 49, 16: 49, 17: 20, 18: 49,
  19: 0, 20: 98, 21: 11, 22: 49, which match the walked counts exactly. Every location declares three
  bin-14 records.
- **Empty records.** 193 records have size 0: bin 14 × 97 (slots 1 and 2 on non-hubs, slot 2 on hubs B,
  C and E, all three on the skies and `TRANSP`), bin 20 × 54, bin 22 × 42. In every location the records
  of types ≥ 13 come after all of its types 0–12, in the order 13, 15, (17), 20, 20, 14/0, 14/1, 14/2, 16,
  18, (21), 22 (29 locations without 17, 9 with 17, 11 with 17 and 21). (spec:510-empty)
- **The first census stopped at the first empty record.** Simulating a walk that ends a group at its
  first zero-length record reproduces every figure of the first census exactly: bins 13, 15 and 17 whole
  (they precede any empty record); bin 20 → 44 records, 3,982,688 bytes (its empty banks were not counted,
  its filled ones all precede the first empty one); bin 14 → 29 / 737,680, since connectors have both bank
  slots empty and stop before their path record; bins 16 and 18 → 2 each, the A and D hubs (17,396 +
  11,272 = 28,668 bytes; 2 × 72 bytes), the only locations whose three path slots are all filled; bins 21
  and 22 → none. (spec:510-bins)
- **Paths.** The first census's 1,149 paths and 28,917 points are exactly the AI paths of its 29 records.
  Over all 50 non-empty records: 1,214 AI paths (30,207 points) and 166 race lines (6,191 points). The
  AI-path header constants (2, 100, 4, ·, 101, 4, ·) hold on 1,214 / 1,214 and the ground-plane unit
  rule on 36,398 / 36,398 points, race lines included. The connector records hold 65 AI paths and 21 race
  lines. (spec:510-paths)
- **Chunks.** The file is 3,328 chunks of exactly 32,768 bytes (3,169 `CBXS`, 159 `CEND`), tiling
  109,051,904 bytes; every `CEND` carries a full compressed payload. The first census's 3,169 counted the
  `CBXS` chunks alone. (spec:510-ssb)

## Open leads
- The secondary pass itself (how the mask, the secondary page and the state value combine) — needs the
  renderer, not the data.
- Patch fields `U0`, `U3`, `U10` and the low bits of `U5`; material bits 0x08/0x10; the sphere-tree layout.
- The remaining surface values (0, 7, 13, 18, 17) have no distinctive names.
- Whether the local lights of spec:515-role also reach props at run time, or only through the baked
  vertex colours.
- The falloff each light range mode applies, and the byte beside it; halo words 0 and 17; what the fog
  model's horizontal margin and a rotated placement's world box are built from; whether the puff's middle
  triple is a scale or a tint; how the two spot cones combine.
- **Executable search, negative so far.** The SSX 3 boot ELF has no symbol table (section names only).
  Pattern scans of its code turned up only unrelated structures: a 28-byte record stride loading the puff
  offsets, the halo's offsets with an 80-byte stride, and the light's cone fields read beside its range,
  direction or position. They found a 64-entry sphere table, a frame-rate record conversion and
  rigid-body integration. The fog, halo and light consumers were not located; the fog may go to the
  vector unit with its frames unread on the EE. A live test (poke a fog model's triple or a spot's cones
  in PCSX2 and watch) would settle the renderer questions directly. The autotest harness's PINE
  plumbing would serve, but no PCSX2 was available for this pass.
