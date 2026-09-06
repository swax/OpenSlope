# 510 — Series Addendum: SSX 3

SSX 3 keeps the world *data model* of the Tricky baseline almost intact and
replaces nearly everything around it: one streamed mountain instead of
per-course levels, resource identifiers instead of array indices, and no
authored logic graph at all. This chapter states the differences; where a
baseline chapter is not contradicted here it was measured to still apply.
[measured] [[510-role]]()

Target: the PS2 NTSC-U release, a DVD image with the plain sector size the
baseline assumes.

> [[510-role]]() doc:../research/series-comparison.md — method, full
> censuses and negative results; all figures below measured from the
> reader's own NTSC-U disc, boot ELF `SLUS_207.72`, world archive `BAM.BIG`.

## What survives intact

Measured, not assumed: the archive format and its compression
(`200-archives.md`); terrain as a quilt of bicubic patches with per-patch
corner UVs, lightmap reference and surface type (`110-terrain.md`); the
grind-rail spline segment with its control points, arc length and chaining
(`140-paths.md`); the path file's record layout, point encoding and event
record (`250-paths-aip-sop.md`); the per-image texture chunk chain and its
implied-size rule (`210-textures-ssh.md`); the sound-bank container and the
bank manifest (`260-audio-files.md`); the per-surface ride-audio
configuration (`420-audio-runtime.md`); and units and axes
(`002-conventions.md`). [measured] [[510-unchanged]]()

Two of those deserve emphasis because they are the spec's hardest-won
results and they transfer **verbatim**:

**Paths.** The path record parses under the baseline's layout with its
leading constant tuple holding on all 1,149 paths of the mountain, and all
28,917 of their points satisfy the horizontal-unit rule — the two
ground-plane components form a unit vector, the third is an unbounded slope,
and the fourth is the step's horizontal length. Only the file magic differs.
This simultaneously confirms that SSX 3 is centimeters and Z-up.
[measured] [[510-paths]]()

**Ride audio.** The per-surface ride-audio configuration file is
**byte-identical** to the baseline's, all 3,624 bytes: the same mini-language,
the same instruction set, the same ten surface sections. [measured]
[[510-snow]]()

> [[510-unchanged]]() doc:../research/series-comparison.md; archive type
> read as BIGF; per-subsystem evidence cited individually below.

> [[510-paths]]() doc:../research/series-comparison.md; spec:250-patha;
> spec:250-accumulation; spec:002-axes. Measured over all 29 path bins:
> header constants `(2, 100, 4, 101, 4)` on 1,149/1,149 paths; 28,917/28,917
> points unit in the ground-plane pair (the alternative pairings match on
> 0.6%); median step 685 units; magic is four ASCII `i` bytes where the
> baseline has four `\x0a`.

> [[510-snow]]() doc:../research/series-comparison.md;
> spec:420-ride. Byte-for-byte diff against the baseline's file:
> zero differences.

## One mountain, streamed

There are no per-course level archives. A single world archive holds four
members: the world data, a streaming database, and two resource-name maps.
[measured] [[510-container]]()

| Member | Holds |
|---|---|
| `<world>.ssb` | the world: a stream of compressed chunks (104 MB) |
| `<world>.sdb` | the streaming database: named locations, chunks, sub-chunks |
| `<world>.phm` | resource identifier → index, per resource array |
| `<world>.psm` | the matching name strings |

The world file is a flat sequence of length-prefixed chunks, each
individually compressed with the baseline's compression scheme. Chunks
accumulate into a group; a chunk tagged `CEND` closes the group, and the
group's concatenated payload is then a sequence of typed records. The
mountain contains 3,169 chunks forming **159 groups**, which is exactly the
sub-chunk count the streaming database declares — the grouping *is* the
streaming granularity. The database names **49 locations**. [measured]
[[510-ssb]]()

Each record in a group carries a one-byte **bin id** and a three-byte size,
then a **track** byte and a three-byte **resource id**. Every reference in
the world — a patch to its texture, an instance to its model — is that
(track, resource) pair rather than an array index, resolved through the two
name-map members. [measured] [[510-ids]]()

| Bin | Records | Bytes | Contents |
|---:|---:|---:|---|
| 0 | 2,575 | 51,824 | materials |
| 1 | 30,644 | 13,238,208 | patches — one per record, 432 bytes each |
| 2 | 10,644 | 23,184,560 | models |
| 3 | 41,113 | 24,020,896 | instances |
| 4 / 5 | 141 / 141 | 62,336 / 20,304 | particle definitions / placements |
| 6 | 1,962 | 219,744 | lights |
| 7 | 1,679 | 134,320 | halos |
| 8 | 2,659 | 1,748,784 | splines |
| 9 | 6,203 | 56,335,584 | texture images |
| 10 | 623 | 28,018,560 | lightmap images |
| 11 | 167 | 34,736 | visibility curtains |
| 12 | 4,616 | 6,392,492 | collision proxies |
| 13 | 49 | 737,007 | sound-trigger tables |
| 14 | 29 | 737,680 | paths |
| 15 | 49 | 295,568 | terrain-paint data |
| 16 | 2 | 28,668 | scripts |
| 17 | 20 | 117,448 | camera triggers |
| 18 | 2 | 144 | sequence table |
| 20 | 44 | 3,982,688 | sound banks |

[measured] [[510-bins]]()

> [[510-container]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSBHandler.cs
> (chunk walk and bin ids), `SDBHandler.cs`, `PHMHandler.cs`,
> `PSMHandler.cs`.

> [[510-ssb]]() doc:../research/series-comparison.md; reader written against
> SSBHandler.cs; measured 3,169 chunks / 159 groups against the database
> header's 49 locations, 183 chunks, 159 sub-chunks.

> [[510-ids]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSBData/WorldCommon.cs;
> cross-check: patch lightmap references span 0..622 = the 623 lightmap
> records exactly.

> [[510-bins]]() doc:../research/series-comparison.md; full census over the
> mountain; bin numbering per the SSBHandler.cs comment, names corrected
> against the measured contents (bin 15 by its authored names, bin 13 by its
> record layout).

## The world carries its authoring names

Unlike either earlier title, SSX 3 ships the **authored scene-graph name of
every resource**: 89,676 strings across five arrays — 30,644 patch names,
41,113 instance names, 10,644 model names, 2,659 spline names and 4,616
collision-proxy names. [measured] [[510-names]]()

The convention is `<type>_<track>_<description>_<serial>`, where the track
code is a peak letter, a two-letter discipline and an index; seventeen track
codes appear. Collision proxies are named for the object they belong to with
a suffix naming their generation mode — a convex hull, a progressive mesh or
a sphere tree — and **every one of the 4,616 base names matches an instance
name exactly**, so the pairing was by name. [measured] [[510-name-scheme]]()

Behavior is visible in the names: objects are called out as rails, reset
volumes, breakables, triggers, crowd volumes, teetering logs and scrolling
conveyors, and two of those words are also engine node-kind names.
[measured] [[510-name-behaviour]]()

> [[510-names]]() doc:../research/series-comparison.md; parsed from the
> name-map member per PSMHandler.cs; array sizes match the bin counts above
> for patches, instances, models, splines and collision proxies.

> [[510-name-scheme]]() doc:../research/series-comparison.md; track codes
> ABA1 ABC1 ARA1 ASS1 BHP1 BRA2 CBA2 CHP2 CRA3 DBC2 DRA4 DSS2 EBA3 EBC3 EHP3
> ERA5 ESS3; collision suffix census ProgMesh 3,415, ConvexHull 1,104,
> SphereTree 97; base-name match 4,616/4,616 against instances, 4,227/4,616
> against models.

> [[510-name-behaviour]]() doc:../research/series-comparison.md; word census
> over all 89,676 names: rail 5,639, collide 4,666, reset 2,657, light
> 1,400, break 1,067, start 1,027, volume 775, crowd 427, anim 367, trigger
> 267, teeter 208, conveyor 18; shipped artist residue included (placeholder
> and duplicate names).

## Patch record

The patch holds the same sixteen stored bicubic coefficients in the same
order as the baseline, the same four corner UVs, a lightmap reference and a
cached four-corner set, in **432 bytes** against the baseline's 448. The
differences are storage widths and one addition: corner UVs are two
components rather than four, cached corners are three rather than four, the
texture and lightmap references are resource identifiers, and the record
adds a **bounding sphere** — centre and radius — alongside the corner data.
[measured] [[510-patch]]()

**Surface type.** The record carries a small-integer field in the same role,
and every one of its thirteen observed values across all 30,644 patches falls
inside the baseline enumeration of `110-terrain.md`. The labels, however,
must **not** be carried over: fitting a plane through each patch's stored
corners shows the value the baseline labels as *wall* is the flattest class
in the mountain, and the value labelled *rock* the steepest — the opposite of
how the same two values behave in the earlier titles. The value space is
shared; the mapping from value to material was re-assigned and needs
re-deriving. [measured] [[510-surface]]()

**Texture UV convention.** The baseline's one-tile-per-patch inset is
**gone**. Patches span whole tiles: a single tile on 13,497 of them and an
eight-by-eight repeat on 9,473, with two- and three-tile spans making up most
of the rest. Nothing carries the fractional inset. [measured] [[510-uv]]()

> [[510-patch]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSBData/WorldPatch.cs;
> size confirmed by division: 13,238,208 bytes over 30,644 records = 432.0.

> [[510-surface]]() doc:../research/series-comparison.md;
> spec:110-surface-types. Histogram over all patches: 0 × 8,378, 1 × 836, 2
> × 8,033, 3 × 3,276, 4 × 1,923, 5 × 1, 7 × 2,075, 8 × 257, 9 × 200, 10 ×
> 83, 13 × 5,091, 17 × 7, 18 × 484. Tilt by value (mean up-component of the
> fitted plane normal): value 10 = 0.85 and value 9 = 0.13 here, against
> value 10 = 0.38 in the 2000 title's course.

> [[510-uv]]() doc:../research/series-comparison.md; spec:110-uv-inset. Span
> census over all 30,644 patches: (1,1) × 13,497, (8,8) × 9,473, (2,1) ×
> 3,272, (3,1) × 2,733; zero occurrences of the 0.984 inset.

## Instances carry no behavior

The instance record's fixed part is 160 bytes and was censused over **all
41,113 instances**. It holds a transform, a bounding sphere, a bounding box,
a resource identifier of its own, a model reference, a scale, one boolean set
on 1,203 instances, and one index field that is −1 on every instance in the
mountain. Seven further fields are zero on every instance. There is **no
effect-slot reference, no collision-mode selector, no physics-body index and
no properties reference** — the whole cluster of behavioral fields the
baseline puts on the properties record (`120-objects.md`, `130-collision-data.md`)
is absent from the instance. Its only outbound reference is to a model.
[measured] [[510-instance]]()

Instance records are variable-length, and the bytes past the fixed part are
not properties: they are a **rendering command chain**, a list of 16-byte
entries whose tag field takes only the two values that mean *reference this
address* and *end of chain*, with every referenced address 16-byte aligned.
27,188 instances carry one such chain, 12,242 carry two, and the longest
carries twelve. [inferred] [[510-instance-tail]]()

The consequence for the data model is structural: an instance in SSX 3 is a
placed, pre-baked draw, not a placed object with attached behavior.
[inferred] [[510-instance-tail]]()

> [[510-instance]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSBData/WorldInstance.cs
> read order; census over all 41,113 records: leading four words 0; scale
> 12,019 distinct with 1.0 dominant; the −1 field 41,113/41,113; the tail
> offset field 160 on every record; model references resolve to 1,083
> distinct models.

> [[510-instance-tail]]() 16-byte stride, tag values 3 and 6 in the position
> and with the meanings of the console's transfer-chain tags (reference,
> return), and every referenced address a multiple of 16 across the whole
> mountain — a size field would not be. Filler words carry the usual debug
> sentinel. Derivation and the alternative readings considered:
> doc:../research/series-comparison.md.

## No authored logic graph

The baseline's logic model — an instance reaching a shared effect slot, the
slot naming chains by circumstance, chains built from typed nodes
(`150-logic.md`) — has **no counterpart in the shipped world data**.
[measured] [[510-logic]]()

Every logic-shaped bin is keyed by track with a zero resource id, one record
per track: 49 sound-trigger tables, 49 terrain-paint records, 20 camera-trigger
records and 2 script records, the largest around 60 KB. Nothing inside them is
individually addressable from outside, and no instance references them.
Against the baseline's same-course figures — 391 effect slots, 918 chains,
1,990 nodes and 4,445 instance bindings, roughly five placements sharing each
chain — the count of addressable authored graphs here is zero.
[measured] [[510-logic]]()

The sound-trigger table decodes as a hash-keyed lookup: a header, then
24-byte entries of a 64-bit key, a small packed word and a common payload
offset. It shares its leading magic with the baseline's collision-sound
sidecar but not its entry layout. It is a table, not a graph. [measured]
[[510-adl]]()

**Node vocabulary.** The engine's node-kind name table holds fifteen kinds
against the baseline's twenty-nine, overlapping on roughly half. Retained:
the three model-animation kinds, mesh animation, the kill node, the debounce
and the particle kind. Added: a teetering animation, a flexing bridge, a
floating body, a floating and a sprung rail, a conveyor, a fading kill and a
restore. **Absent:** every boost kind, every texture-animation kind (both
scroll and flip), the crowd box, the counter, the timer, the rail toggle, the
roller, the flag, the cracked surface, the trick trigger and the movie
driver. [measured] [[510-nodes]]()

Those names appear **only in the executable**, adjacent to a parser's
diagnostic for an unrecognized token. The world bins contain no strings at
all: the shipped data references node kinds numerically, through a structure
that carries no directory. [measured] [[510-nodes-absent]]()

## The authoring layer was elsewhere

Three facts, taken together, place SSX 3's authoring above the file format
rather than in it. First, the world ships its authoring names and expresses
behavior in them (above). Second, the executable's node-kind names sit beside
a text parser's error string, and the shipped scripts are compiled bytecode
bundled with their animations and sound banks — a build step stands between
authored source and shipped data. Third, the retail disc ships the
**controller bindings for in-engine editors**, in a commented plain-text
input-mapping file — a free-fly cursor with snapping, rotation, zoom, an
orient mode and three speed tiers; a path editor with add-node, move-node,
delete-node and add-event; a collision viewer; and a script-camera editor.
Neither earlier title has any of this. [measured] [[510-authoring]]()

The shipped format is therefore the **output** of an authoring pipeline, not
the authoring representation. This is the substantive difference from the
baseline, where the level file *is* what the designer built and can be read,
edited and written back. [inferred] [[510-authoring]]()

> [[510-logic]]() doc:../research/series-comparison.md; bin key census: bins
> 13, 15, 16 and 17 all carry resource id 0 with one record per track;
> baseline figures from `merquer.ssf` and its exported effects document.

> [[510-adl]]() stride confirmed by arithmetic: header 16 + 456 entries × 24
> = 10,960, which is the payload offset stored in every entry. The
> baseline's entry layout
> (doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/ADLHandler.cs)
> parses its own file 3,881/3,881 and this one 8/456.

> [[510-nodes]]() node-kind name table, boot ELF `SLUS_207.72` @0x0038a658
> and a second copy @0x00382658, against the Tricky table @0x0026c6a0; full
> listings and the three-way diff doc:../research/series-comparison.md.

> [[510-nodes-absent]]() `"Invalid token."` @0x0038a5d0 immediately precedes
> the table; string scan over the whole of bins 3, 13, 15, 16 and 17
> returned no meaningful text.

> [[510-authoring]]() doc:../research/series-comparison.md; script bundles =
> compiled `.isb` + animation list + sound bank per bundle, under a master
> table; scripting VM and world-script symbols in the ELF; editor bindings
> in the shipped `DATA/CONFIG/INPUT.MAP`, under commented sections named for
> the generic editor, the path editor and the collision viewer, plus the
> script-camera sections. Zero editor, VM or world-script symbols in either
> earlier title's boot ELF.

## Not established

- The record layouts inside the per-track sound-trigger, terrain-paint,
  camera-trigger and script bins. No community decoder covers them and they
  contain no strings to anchor on. [open]
- How a trigger reaches an instance, given the instance carries no
  back-reference. [open]
- The surface-type labels for this title. The value space is shared with the
  baseline; the mapping is not. [open]
- Whether the model container's section layout differs beyond its format id,
  which `240-models-mpf.md` records for this title. [open]
- Everything in the runtime and presentation parts. SSX 3 rebuilt the
  rider — a balance-metered grind, a different air and trick model,
  deep-powder handling — and no constant in those parts was tested against
  it. Treat the baseline's runtime chapters as not applying. [open]
