# 500 — Series Addendum: SSX (2000)

The first SSX runs on the same engine lineage as Tricky. This chapter states
where the 2000 title **differs** from the Tricky baseline the rest of this
spec describes; anything not listed here was measured to be the same, and the
baseline chapter is authoritative for it. It is a delta, not a second spec:
a reader implementing SSX (2000) reads the baseline chapters and applies this
one on top. [measured] [[500-role]]()

Target: the PS2 NTSC-U release. The disc is a CD image whose sectors carry
2,352 bytes each in Mode 2 Form 1 — user data begins 24 bytes into each
sector and runs 2,048 bytes — where every later PS2 SSX ships on DVD with
plain 2,048-byte sectors. Above that layer the file system is the same
ISO 9660 tree the baseline describes. [measured] [[500-disc]]()

> [[500-role]]() doc:../research/series-comparison.md — method and coverage;
> all counts below measured from the reader's own NTSC-U disc, boot ELF
> `SLUS_200.95`, example course `MERQUERY.BIG` (Merqury City, the one course
> shipped in both titles, which makes every count in this chapter a true A/B
> against the Tricky measurement of the same course).

> [[500-disc]]() doc:../research/series-comparison.md; sector mode read from
> the raw image: sync + Mode 2 subheader, `\x01CD001` found at sector 16
> offset 24; conversion to a plain 2,048-byte image is a straight per-sector
> slice.

## What is unchanged

Confirmed by measurement rather than assumption: the archive format and its
compression (`200-archives.md`); the terrain model — a quilt of bicubic
patches with per-patch surface type, corner UVs and a lightmap reference
(`110-terrain.md`); the grind-rail spline segment record with its
chaining and arc-length fields (`140-paths.md`); the path point encoding and
event record (`250-paths-aip-sop.md`); the texture bank container and its
per-image chunk chain (`210-textures-ssh.md`); the audio stream container
(`260-audio-files.md`); and units, axes and world scale
(`002-conventions.md`). [measured] [[500-unchanged]]()

**Units and axes hold.** Every path point in the example course satisfies the
horizontal-unit rule the baseline states — the two ground-plane components
form a unit vector and the third is an unbounded slope — over all 3,040
points, which independently fixes the ground plane and the up axis. Terrain
corroborates it: fitting a plane through each patch's stored corner cache,
ridable snow and powder patches average 0.69 in the up component while the
patches carrying the wall surface type average 0.38. The world bounding box
and the spatial-grid cell size are in the same centimeter frame, the cell
being 10,000 units — 100 m — square. [measured] [[500-axes]]()

> [[500-unchanged]]() doc:../research/series-comparison.md; archive type
> read as BIGF from the course archives; per-record comparisons cited
> individually below.

> [[500-axes]]() doc:../research/series-comparison.md; spec:002-axes;
> spec:250-accumulation. Measured on `merquery_city.aip` (3,040 points,
> 100.000% unit in the ground-plane pair; the alternative pairings match on
> 1.6% and 0.6%) and on `merquery_city.wdf` (2,434 snow/powder patches vs
> 493 wall patches, smallest-eigenvector plane fit over the four stored
> corners).

## Level container

The level's data is split across more members than Tricky's two, and the
world file is **pre-chunked into the spatial grid** rather than stored as
flat arrays with a separate broad phase. [measured] [[500-members]]()

| Member | Holds |
|---|---|
| `<course>.wdx` | index: format version, world bounding box, grid dimensions and cell size, model directory, the per-cell offset/size table, materials, splines |
| `<course>.wdf` | the world itself: one blob per grid cell, each holding that cell's instances, patches, spline segments and lights |
| `<course>.wdr` | render models |
| `<course>.wds` | auxiliary index [open] |
| `<course>.wfx` | behavior data — the effect graph, physics bodies and collision proxies |
| `<course>.aip` | paths (one file; there is no sibling second dataset) |
| `<course>.map` | a plain-text manifest |
| `<course>.ssh`, `<course>l.ssh` | texture bank, lightmap bank |
| `<course>_sky.mdr`, `<course>_sky.ssh` | sky model and its bank |

A cell blob is laid out as: a small header of three vectors and six counts, a
fixed sixteen-entry table, a variable table sized by one of the counts, then —
after 16-byte alignment — the cell's instances, patches, spline segments and
lights back to back. Walking the grid this way reproduces the declared cell
sizes on 119 of the example course's 131 populated cells. [measured]
[[500-cells]]()

The example course carries 3,955 patches, 2,588 instances, 563 lights and 841
spline segments over a 19 × 21 grid. [measured] [[500-counts]]()

> [[500-members]]() member list read from the course archive;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/OGPS2/WDXHandler.cs
> (index) and `WDFHandler.cs` (cell walk).

> [[500-cells]]() reader written against WDFHandler.cs `Load`; residual
> check = cell end vs declared offset+size, 119/131 exact, remainder not
> chased doc:../research/series-comparison.md

> [[500-counts]]() doc:../research/series-comparison.md; `merquery_city.wdx`
> header: grid 19 × 21, cell 10,000, 1,024 models, 509 materials, 147
> splines; totals summed over the cell walk.

## Patch record

The patch is the **same size as Tricky's, 448 bytes**, holding the same
information with two fields reshaped: the bounding-box corners are stored as
four-component vectors rather than three, and the freed 16 bytes at the tail
are spent differently — Tricky splits them into resource-kind tags, a
visibility word and spare resource slots, where the 2000 record carries the
texture and lightmap references as full 32-bit fields followed by the surface
type and one spare word. The lightmap reference, the four corner UVs, the
sixteen stored bicubic coefficients and the four cached corner points are
identical in count, order and meaning. [measured] [[500-patch]]()

**Surface types.** The field is present and its observed values all fall
inside the baseline enumeration of `110-terrain.md`. The example course uses
nine of them: reset 695, standard snow 1,634, standard off-track 34, powder
567, slow powder 233, ice 18, wall 493, no-trail/ice-crunch 264, and
no-collision 17. The two values whose labels can be tested from geometry
behave as the baseline labels predict — the wall type is the steepest class
in the course and the snow/powder types the flattest. Full label parity
across all nineteen values is **not** established; only the values a course
actually uses can be checked. [measured] [[500-surface]]()

**Texture UV convention.** The one-tile-per-patch inset the baseline
describes is the dominant layout here too: 3,881 of the course's 3,955
patches span 0.984 in both parametric directions — the same 0.008-per-side
inset — with the remainder spanning two or three whole tiles.
[measured] [[500-uv]]()

> [[500-patch]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/OGPS2/WDFHandler.cs
> `struct Patch` vs
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> `struct Patch`; both sum to 448 bytes, verified by the cell-walk residual
> above.

> [[500-surface]]() doc:../research/series-comparison.md;
> spec:110-surface-types. Histogram measured over all 3,955 patches of the
> example course; tilt corroboration per [[500-axes]]().

> [[500-uv]]() doc:../research/series-comparison.md; spec:110-uv-inset.
> Census over all 3,955 patches: span (0.984, 0.984) × 3,881; (3.0, 1.0) ×
> 34; (0.984, 2.0) × 27; the rest single-figure.

## Object properties live on the instance

Tricky separates an instance from its behavior: the instance names a shared
properties record, and that record holds the collision mode, collision proxy,
physics body, surface type, bounce and — the load-bearing one — the effect-slot
index (`120-objects.md`, `150-logic.md`). In the 2000 title the same fields
are stored **inline in the instance record itself**: transform, a lighting
matrix, three directional key colors and an ambient color, a prefab
reference, bounding box, flag word, player bounce, collision mode, collision
proxy index and physics index. There is no shared properties pool and
therefore no properties-level sharing between placements. [measured]
[[500-instance]]()

The practical consequence is that instance-affecting edits are edits to the
world file's cell blobs, not to a flat table. [inferred] [[500-instance]]()

> [[500-instance]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/OGPS2/WDFHandler.cs
> `struct Instance` (272 bytes) vs
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `ObjectPropertiesStruct`.

## Behavior file

The `.wfx` is the direct ancestor of the SSF of `230-level-ssf.md`. It carries
**four** of that chapter's eight sections — effect slots, physics bodies,
collision proxies and the effect-chain header table — and its records are the
same sizes: a seven-word effect slot, a three-word physics pointer, a
three-word collision pointer. The section extents tile the file exactly, which
pins those sizes independently of any parser. [measured] [[500-wfx]]()

Absent, relative to the baseline: the **named-function table**, the shared
**object-properties** table (inline on the instance, above), the **instance
join table**, and the **spline logic descriptors**. The effect-slot to chain
indirection itself is present. [measured] [[500-wfx-missing]]()

The example course carries 131 effect slots, 514 chains, 21 physics bodies
and 619 collision proxies. Tricky's rebuild of the same course carries 391
slots, 918 chains, 1,990 nodes, 64 physics bodies, 1,064 collision proxies,
15 named functions, 1,431 properties records and 4,445 instance
bindings. [measured] [[500-ab]]()

**Node vocabulary.** The engine's effect-node kinds number fifteen here
against the baseline's twenty-nine, and the fifteen are a subset. Present:
the three model-animation kinds, the animated-texture-flip and the
scroll-plus-flip combination, the plain UV scroll, mesh animation, the
one-shot kill node, the debounce, the lap and random boost pads, the crowd
box, the trick trigger, the particle kind and the spline-path mover. Added by
Tricky and **not available** here: the roller body, the counter, the timer,
the directional boost volume, the rail toggle, the standalone texture flip,
the fence flex, the flag, the cracked surface, the Z-boost, the tube-end
boost, the movie driver, the collide-emitter and the camera kind.
[measured] [[500-nodes]]()

Because the counter, the timer and the named-function table are all absent,
the composition layer that makes the baseline's logic graph a small scripting
language is not present in the 2000 title: chains exist, but there is no
authored way to count, to schedule, or to name and call a shared routine.
[inferred] [[500-nodes]]()

> [[500-wfx]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/OGPS2/WFXHandler.cs
> `Load` vs
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.
> Tiling measured on `merquery_city.wfx`: header 40 + 131 slots × 28 = 3,708
> = the declared physics offset; + 21 × 12 = 3,960 = the declared collision
> offset; + 619 × 12 = 11,388 = the declared chain-table offset.

> [[500-wfx-missing]]() doc:../research/series-comparison.md; the WFX header
> declares four (count, offset) pairs against the SSF's eight.

> [[500-ab]]() doc:../research/series-comparison.md; SSX (2000) figures from
> the WFX header; Tricky figures from `merquer.ssf` header and its exported
> effects document (918 graphs, 15 functions, 1,990 nodes, 4,445 bindings).
> GARI for scale: 78 slots, 306 chains, 700 nodes, 20 functions.

> [[500-nodes]]() the engine's node-kind name table, boot ELF `SLUS_200.95`
> @0x001a9dd8 (fifteen entries, plus the kill node at @0x001a9ab8), against
> the Tricky table @0x0026c6a0 (with its kill node at @0x0026c0a8); full
> listings doc:../research/series-comparison.md.

## Paths

One `.aip` per course, holding both datasets; there is no `.sop` sibling.
The file header is three counts followed by a fixed list of **eight**
start-position indices — the baseline's runtime takes six. Race lines and AI
paths then follow as two back-to-back arrays. [measured] [[500-aip]]()

The record is the baseline's with a shorter prefix. A race line opens
directly on its **distance-to-finish** value, then point count, event count,
seed position and bounding box — the baseline's leading type word and two
constants are absent. An AI path opens on a single float that is zero on
every path in the example course, where the baseline's AI-path header carries
the **line rating** and the **respawnable** flag that drive AI path choice
(`395-ai-riders.md`); neither field exists here. Points and the 16-byte event
record are unchanged, and the whole file parses to its exact byte length.
[measured] [[500-aip-record]]()

Event type codes observed in the example course: 0, 9, 10, 11, 12, 14, 15,
16, 18 and 19. [measured] [[500-aip-events]]()

> [[500-aip]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/OGPS2/AIPHandler.cs
> `Load`; measured `merquery_city.aip`: 6 race lines, 199 AI paths, start
> list `[0..7]`.

> [[500-aip-record]]() doc:../research/series-comparison.md; spec:250-patha;
> spec:250-pathb. Reader consumed 77,260 of 77,260 bytes; 3,040 points,
> 1,171 events; every AI path's leading float 0.0; median step length 521
> units.

> [[500-aip-events]]() doc:../research/series-comparison.md; census over all
> 1,171 events of the example course; the baseline's translation table and
> its single dispatched type are untested here [open].

## Textures, models, audio

**Texture banks** use the older container variant, and the baseline's claim
that every image's chunk list is followed by the ASCII group terminator does
**not** hold: the course and lightmap banks carry no terminator at all, so an
image's extent must be derived from the gap to the next directory entry
alone. The sky bank does carry one. The creator code differs from the
baseline's; it is identification only. [measured] [[500-ssh]]()

**Models** use the same container family at format id **3** against the
baseline's 8, with a sub-model directory of **64-byte** entries rather than
80. The container shape — count, directory offset, absolute data start, then
the directory — is unchanged, and the data start computes from the 64-byte
stride exactly. Rider models split into high and low detail as separate
members rather than tiers inside one container, and the sky is a separate
model format. [measured] [[500-mpf]]()

**Audio** members are the same stream container as the baseline. Per-course
music archives hold the intro stems as members named for the course with
tier and index suffixes, matching the A/B/C intensity tiers of
`430-music-and-announcer.md`. The per-surface ride-audio configuration file
is present and is the same mini-language with **byte-identical program
bodies**; what differs is which surfaces share which program. The baseline
runs rock and metal through the detailed program that reads slip, dig and
lean, and adds a chute surface alongside them; the 2000 title instead groups
rock and metal with the flat hard-surface program that maps slip straight to
volume. Rock and metal therefore sound materially different between the two
titles even though not one instruction changed. The bank manifest, speech and
music configuration files are all present under the same names.
The control-map files number eight rather than two. [measured] [[500-audio]]()

> [[500-ssh]]() spec:210-directory; spec:210-variants. Magic on all three
> example banks reads as the older variant; terminator occurrences: course
> bank 0, lightmap bank 0, sky bank 1. Loader comment corroborates
> (doc:../../Snowknife/SSX-Library/SSX-Library/EATextureLibrary/OldShapeHandler.cs
> `LoadShape`: sized by offset alone for this title).

> [[500-mpf]]() spec:240-detect; spec:240-directory.
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/MpfHeaderChecker.cs
> `DetectFileType`. Measured: board model declares 10 sub-models and a data
> start of 656 = 12 + 64 × 10 + 4; a head model declares 2 and 144 = 12 + 64
> × 2 + 4.

> [[500-audio]]() doc:../research/series-comparison.md; spec:420-ride;
> stream magic read on the per-course music members; tier naming
> `<course>-A1..C4`. Ride-audio config 3,615 vs 3,624 bytes; the only diff
> hunks are section-header moves — 2000 groups {PACK,ICE} / {POWDER,LOOSE} /
> {METAL,WOOD,RAIL,ROCK,GLASS}, the baseline groups
> {PACK,ICE,CHUTE,ROCK,METAL} / {POWDER,LOOSE} / {WOOD,RAIL,GLASS}; the three
> program bodies are unchanged.

## Not established

- The auxiliary index member's contents. [open]
- Whether the surface-type labels hold for the values no shipped course
  uses. [open]
- The per-node payload layouts of the fifteen node kinds — only the kind
  vocabulary and the container were measured, not the chain contents.
  [open]
- Every constant in the runtime and presentation parts. Nothing in this
  chapter tests rider physics, and the baseline's constants all carry Tricky
  provenance; a port targeting this title must re-derive them. [open]
