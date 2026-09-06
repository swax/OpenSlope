# 520 — Series Addendum: SSX On Tour

On Tour does not descend from the Tricky baseline. It is the next iteration of
the architecture `510-series-ssx-3.md` describes — one streamed mountain,
resource-identifier addressing, authoring above the file format — with a
second round of changes on top. Read 510 first; this chapter states what
On Tour changes again. Against the baseline directly, almost nothing
structural is shared. [measured] [[520-role]]()

Target: the PS2 NTSC-U release.

The world container is decoded to the record level: all 532 streaming groups
reassemble and walk to a clean end, the per-bin census matches the streaming
database's own count tables bin for bin, and the patch, path, instance,
spline, light, material and texture records are identified. The remaining
gaps — mostly field roles inside records and the script bytecode — are listed
at the end. [measured] [[520-status]]()

> [[520-role]]() doc:../research/series-comparison.md — method and coverage;
> figures measured from the reader's own NTSC-U disc, boot ELF `SLUS_212.78`,
> world archive `BAM.BIG`. `agents/ontour/*.out.txt` names the local analysis
> transcripts this chapter was written from; like the captures under
> `ResearchData/`, they are evidence kept on the maintainer's machine and do not
> ship with the repository.

> [[520-status]]() doc:../research/series-comparison.md "On Tour container
> decoded" — 532/532 groups walk clean (`agents/ontour/t4_walk2.out.txt`,
> `t5_census.out.txt`); decoded group size == streaming-database sector size
> on 532/532 (`t7_sdb_parse.out.txt`); 159,600 records in 21 bins.

## Inherited from SSX 3

The world is a single streamed mountain under the same archive name, holding
the same four members: the world data, a streaming database, and the two
resource-name maps. Scripts are a separate compiled archive. The retail disc
ships the controller bindings for in-engine editors. The per-surface
ride-audio configuration file is, once again, **byte-identical to the
baseline's** — unchanged across three titles and two engine generations.
[measured] [[520-inherited]]()

The typed-record header inside a decompressed group keeps SSX 3's roles but
**changed shape**: word 0 packs the bin id (8 bits), a **day/night mask** (2
bits) and the payload size (22 bits — the size is the word shifted right by
ten); word 1
is a **sector id** (16 bits) and a **resource id** (16 bits), where SSX 3
used an 8/24 split; the payload follows immediately, unaligned. A group's
own records carry sector = group index + 2; sector 0 holds the global
resources (materials, models, textures, collision, scripts, effects), which
are **duplicated into every group that needs them**. [measured]
[[520-records]]()

> [[520-inherited]]() doc:../research/series-comparison.md; ride-audio config
> byte-for-byte diff against the baseline's: zero differences, 3,624 bytes.

> [[520-records]]() `agents/ontour/t3_carrypos.out.txt` — headers at the
> carry-implied positions, e.g. one header decoding to bin 1, mask 1, size
> `0x6C1 >> 2` = 432 (the SSX 3 patch size), sector 3, resource 8; another to
> bin 14, sector 3, resource 10, followed by the `#iii` path magic;
> under the SSX 3 header the first record of most groups read "bin 9, size
> 2,115" and ran off at 2,123 — it is a 528-byte texture. Sector = group
> index + 2 on 498/498 groups with patches. Totals: 159,600 records,
> 278,272,292 payload + 1,276,800 header + 5,080,313 pad bytes.

## The world container was rewritten

SSX 3 stores the world as variable-length chunks, each individually
compressed, with an eight-byte header. On Tour stores it as **fixed 32 KB
blocks with a twelve-byte header** of three little-endian words: a
four-character tag (`CBXS` = the group continues, `CEND` = the group closes),
the block size (always 32,768), and a packed word whose low byte is a
**flags** byte and whose upper 24 bits are a **carry**. The flags byte is a
bit set, not a type: bit 0 = the block holds day content, bit 1 = night
content, bit 3 = the payload is raw rather than compressed; six values occur
(1, 2, 3 compressed; 9, 10, 11 raw). The carry is the offset, inside this
block's *decoded* payload, of the first record header — the number of bytes
at the head of the block that still belong to a record begun earlier (0 when
a header starts at offset 0, and on the few blocks holding only the tail of
a group's last record). A compressed payload is one complete, self-contained
compression stream that decodes to between 32,821 and 81,920 bytes (an 80 KB
input cap) followed by zero fill; a raw payload is the full 32,756 bytes. The
mountain is 5,779 such blocks — 5,247 continuing and 532 closing — which tile
the file exactly. [measured] [[520-blocks]]()

**Composition.** A group is the run of blocks up to and including its closing
block. Every compressed block is decoded **independently** (its
own stream, its own window); every raw block contributes its full payload;
the decoded outputs are concatenated in file order — day-only and night-only
blocks included — and the result is the group's record stream, in which
records straddle block boundaries freely, into and out of raw blocks. The
stream ends exactly at the decoded end when the closing block is
compressed, and at the first all-zero record header when it is raw. The
block flags are simply the OR of the day/night masks of the records
overlapping the block, which is what lets the streamer skip whole blocks for
the other time of day. Raw is the writer's choice for incompressible data
(texture pixels) and short tails: 119 raw blocks sit mid-group, 306 at group
ends, 4 at starts. Under this composition **all 532 groups** walk cleanly, and
every group's decoded size equals the size the streaming database records
for it. [measured] [[520-blocks]]()

The streaming database is a 328-byte header, a 532-entry **sector table** of
108 bytes each, a named-line table and an area table. The header holds a
version word, a build float shared with both name maps, the world bounding
box, the offsets of the two trailing tables, a 28-entry 16-bit **per-bin
object total** table and a 28-entry per-bin id-capacity table; the per-bin
totals equal the census on every bin, counting one object per identifier
where day and night are variants of one thing (patches, instances,
textures) and one per record where they are separate resources. Each sector
entry holds the sector's bounding box, its id (= index + 2), the group's
decoded byte size, a small flags word and a 28-entry per-bin object count
that matches the group's records slot for slot. The named-line table has
40-byte entries — a 12-character name such as a track's start line, a
4-character track code, a position and a heading — for about 163
start/finish lines, followed by index lists; the area table is a 29-entry
(hash, type, offset) directory whose hashes are the name map's area keys.
The SSX 3 reader's layout does not apply at all. [measured] [[520-sdb]]()

> [[520-blocks]]() `agents/ontour/t1_headers.out.txt` — magic histogram CBXS
> 5,247 / CEND 532; word 1 = 32,768 on 5,779/5,779; flags-byte histogram
> 3×3,050, 1×1,385, 2×915, 10×247, 11×160, 9×22; payload begins `10 FB` on every
> block with flags 1/2/3 (5,350) and never on 9/10/11 (429); carry max
> 195,177. `t2_walk.out.txt` — carry chain: wherever a block's carry exceeds
> its own decoded length, the next block's carry equals the difference on
> 321/321 cases (block 8 carry 54,709, output 41,043; block 9 carry 13,666);
> group 0's raw run 28,726 → 43,478 → 10,722 = 43,478 − 32,756 proves raw
> blocks carry all 32,756 bytes. `t14_misc.out.txt` — streams consume
> 5,734–32,753 of 32,756 payload bytes, decode to 32,821–81,920 (81,920 on
> 361 blocks); 383 end by reaching the declared size. `t5_census.out.txt` —
> block flags low two bits == OR of overlapping records' masks on
> 5,779/5,779; carry positions coincide with a walked header on 5,717/5,779,
> the other 62 being raw `CEND` blocks with carry 0. Walk status: exact 226
> (closing block compressed), terminated-in-zero-pad 306 (closing block raw),
> failures 0. Refuted alternatives: cross-block concatenation before
> decompression (each stream declares and reaches its size inside its own
> block; the next begins `10 FB` or is raw); carry as valid-byte count (chain
> arithmetic). `Refpack` symbol at `SLUS_212.78` file offset 0x427B40,
> `data/worlds/%s` strings 0x3E3B40–0x3E3B60 for a loader trace if wanted.

> [[520-sdb]]() `agents/ontour/t6_sdb.out.txt`, `t7_sdb_parse.out.txt` — header
> words +8/+10 = 805/534, +48/+52 = 57,784/73,112, bin totals at +56,
> capacities at +164 (bins 0, 2, 9 carry 8 spare ids; 4, 12, 18, 22, 24
> exact); sector table stride 108 from the repeating bbox pattern (entries
> 0–3 at +328/+436/+544/+652), size field at +36 == walked size 532/532, id
> at +26 == index + 2 532/532, per-bin counts at +52..+107 matched slot by
> slot; named-line 40-byte entries (`er1_fl1`, `er1_sl3`, `er1_sbb`), area
> directory 29 entries whose first hash 105,660,593 is also the name-map key
> of `nppd_startArea`. Unresolved: header 159 at +14, the 16/48/112 words at
> +40, sector fields at +24, +28..+34, +40..+50, the index lists' tail.
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/OnTourPS2/SDBHandler.cs
> is a copy of the SSX 3 reader and does not apply.

## What the mountain holds

The stream carries 159,600 records in 21 bins; the distinct-resource counts
below equal the streaming database's per-bin totals exactly. [measured]
[[520-census]]()

| Bin | Distinct | Record size | Contents |
|---:|---:|---|---|
| 0 | 1,363 | 20 (32/44/48 animated) | materials — texture binding; the long forms carry a rate and 2–6 frame texture ids |
| 1 | 22,896 | 432 | **bicubic patches** (plus 14,906 night twins) |
| 2 | 4,050 | varies | models |
| 3 | 37,046 | 176 + 16n | instances (plus night variants) |
| 4 / 5 | 330 / 330 | 112 / 144 | particle definitions / placements |
| 6 | 22 | 112 | lights |
| 7 | 2,062 | 96 | halos |
| 8 | 3,120 | 48 + 128n or 144n | splines |
| 9 | 802 | varies | textures (ids 33–834; the commonest is 128 + 64-byte palette + a 128² 4-bit image with four mips) |
| 10 | 1,533 | 128 + w·h | lightmaps at 64², 128², 256², per sector, with separate day and night images |
| 11 | 49 | 208 | visibility curtains |
| 12 | 2,289 | varies | collision proxies |
| 13 | 503 | 16 + 32n | per-sector hash table (the sound-trigger table, 32-byte entries) |
| 14 | 9,721 | 96–1,896 | **AI paths**, one record per path |
| 15 | 15 | 8–22,980 | per-track day/night index tables |
| 18 | 46 | ~35,164 | sound banks |
| 21 | 3,276 | 28 | per-instance **script bindings** |
| 22 | 1,504 | 60–164+ | compiled scripts |
| 23 | 15 | 8 / 12 | per-track script list |
| 24 | 182 | 220 | effect instances |

**Day and night are a record-level axis.** The 2-bit mask is 1 = day, 2 =
night, 3 = both. Per-sector bins whose content differs by time (patches,
instances, lightmaps, the hash table, the per-track tables) store two records
under the same identifier, one per bit, and never use 3; time-independent
bins (paths, scripts, bindings, effects) always use 3. Day and night patch
twins are byte-identical except for their lightmap rectangle and lightmap
reference. Instance names confirm the polarity: names stored only under bit 0
contain "day" 1,500 times and "night" never, and the reverse for bit 1.
[measured] [[520-daynight-records]]()

> [[520-census]]() `agents/ontour/t5_census.out.txt`, `t12_bins.out.txt`,
> `t17_coll.py` — record counts per bin (0: 10,228; 1: 37,802; 2: 9,529; 3:
> 58,022; 9: 12,374; 10: 2,220; 12: 5,278; 13: 863; 14: 9,721; 15: 30; 18: 67;
> 21: 3,276; 22: 3,014; 23: 15; 24: 1,248), distinct (sector, rid) as
> tabulated; bins 16/17/19/20 absent (database lists them with count 0);
> SSX 3's bin 20 sound banks moved to 18, its two script records (bin 16) are
> replaced by 21–23. Texture layout arithmetic: 11,104 = 128 + 64 + 8,192 +
> 2,048 + 512 + 128 + 32.

> [[520-daynight-records]]() `t16_names.out.txt` — 1-only/day 1,500,
> 1-only/night 0, 2-only/night 1,447, 2-only/day 0; `t8_probe.out.txt` — patch
> twins differ only at dwords 16–28 and 412 over 14,906 pairs.

## Terrain is still a quilt of bicubic patches

The patch record is **432 bytes**, the SSX 3 size, and it holds the same
surface: sixteen power-basis coefficient vectors (x, y, z, 1.0), highest
power first, with the constant term equal to the (0, 0) corner. Layout, all
offsets measured on every record: two zero words; a u16 **surface type**
(sixteen values, all inside 0–18); a u16 flags word; a u16 that takes only
two values (a shader or material template id); eight flag bytes; a lightmap
rectangle (u, v, w, h in atlas units); four corner UVs as whole-tile spans;
the sixteen coefficient vectors; a bounding sphere; the record's own
identifier (equal to the header's); a surface bounding box that contains
every sampled surface point; the four evaluated surface corners at (0,0),
(1,0), (0,1), (1,1); a texture resource id; a lightmap resource id; a second
texture id or −1 (set on exactly the records whose template id takes its
rarer value); three −1 halves; and two trailing words. Surface-type labels
do not carry over from the baseline: the dominant class 0 is the flattest
common class, classes 1–4 and 13 moderately sloped, 7, 8, 12 and 14 steep —
the value space is the baseline's, the mapping needs re-deriving as in SSX 3.
[measured] [[520-patch]]()

> [[520-patch]]() `t9_patch.out.txt`, `t13_patch2.out.txt`, `t15_final.out.txt`
> — offsets: 0 zero×2; 8 u16 type (0×11,214, 2×6,431, 3×6,046, 1×5,516,
> 13×2,727, 7×2,700, 4×1,622, 14×521, 8×380, 12×276, 16×193, 10×94, 9×43,
> 18×26, 6×8, 17×5); 10 u16 flags (9 on 36,206; 1, 11, 137, 393, 139, 129,
> 25, 265); 12 u16 41 on 36,028 / 425 on 1,774; 14 flag byte ×8; 16 lightmap
> rect (sizes in 1/64 steps 7/3/12/15/14/6); 32 four UVs ((1,1) ×35,390,
> (2,2) ×1,306); 64 16 × vec4 (constant term = corner (0,0) on 37,802/37,802);
> 320 sphere (centre inside box 37,802/37,802); 336 own id == header
> 37,802/37,802; 340 bbox (contains every sampled point 37,802/37,802); 364
> four corners (= evaluated surface 37,802/37,802); 412 u16 texture id (289
> distinct, 37–827); 414 u16 lightmap id (0–11); 416 second texture or −1
> (exactly the 1,774 with +12 = 425); 418 −1 ×3; 424 0/2/3, 0. Tilt by class
> (mean |n·z| from the linear coefficients): 0 → 0.73, 1–4/13 → 0.61–0.68,
> 7/8/12/14 → 0.37–0.47, 16 → 0.88, 9 → 0.76 (43 samples).

## The effect-node vocabulary is gone

SSX 3 keeps a table of fifteen effect-node kind names in its executable
(`510-series-ssx-3.md`). **None of those names appear in On Tour's
executable** — not the model-animation kinds, not mesh animation, not the
kill node, the debounce, the particle kind, nor any of SSX 3's own additions.
The scripting VM's symbols are gone, and so is the world-trigger manager that
SSX 3 carries. Only the world-script manager symbol survives. [measured]
[[520-nodes]]()

Whatever drives world behavior in On Tour therefore leaves **no named
vocabulary in the executable at all** — because the behaviour ships as
compiled bytecode in the world stream, bound to instances by same-key
binding records (below). [measured] [[520-nodes]]()

> [[520-nodes]]() doc:../research/series-comparison.md — probe over the whole
> boot ELF string table for each SSX 3 node-kind name plus the VM and
> trigger-manager symbols: zero hits; `WScriptMan` is the one survivor.

## The path record changed

The AI-path record is **present** — 9,721 of them, one record per path where
SSX 3 packed all of a track's paths into one record. The lead changed shape
but not scheme: a four-character magic, a version word, then a
**property list** — a count (3) followed by (key, length, value) triples for
keys 100, 101 and 102, each of length 4 — of which the baseline's and
SSX 3's "constant tuple" was the same list with two properties. Then the
point count, the event count, a position and a bounding box, the points, one
unresolved word, and the events. Each point is **20 bytes**: a packed
signed-byte normal (three components of magnitude ≈127 plus a fourth byte)
followed by the baseline's four floats — and every point satisfies the
baseline's horizontal-unit rule in its (x, y) pair, with slope third and step
length fourth, which also reconfirms centimetres and Z-up. Events are 16
bytes as in SSX 3 — kind, value, start, end — with kinds 300 (point events,
start = end), 100–103, 110, 111, 113 and −1, and start ≤ end ≤ path length.
Property 101 is 1 on every path; 100 takes values of the form 512·k + 32 or
+ 46; 102 takes 45 small values. [measured] [[520-paths]]()

> [[520-paths]]() `t10_paths.out.txt`, `t14_misc.out.txt`, `t15_final.out.txt`
> — header pattern `#iii`, 1, 3, (100, 4, v), (101, 4, 1), (102, 4, v) on
> 9,721/9,721; size = 92 + 20n + 4 + 16e on 9,721/9,721; unit rule |xy| = 1 on
> 210,295/210,295 points (alternative pairings 0.3–0.4 %); packed normal |n| ≈
> 127 on 210,295/210,295, fourth byte 167 odd values; median step 418, max
> 24,003; events: 300 ×60,168, then 111, 110, 103, 100, 102, 101, 113, −1;
> start ≤ end ≤ length on 75,032/75,052; property 100: 1,534 values 512·k +
> {32, 46}. A scan for SSX 3's two-property tuple finds nothing because the
> list has three properties, not because the record is absent; spec:510-paths
> for the SSX 3 form.

## Instances, scripts and behaviour

The instance record has a **176-byte fixed part** (a field at +144 gives the
tail offset: 176 on most, 192 or 208+ on the rest) followed by the same
16-byte rendering-command chain as SSX 3 — reference entries closed by an end
entry. Its fields: a kind enum duplicated in two halves; the record's own
identifier; a 4×4 transform with the translation in the last row; a bounding
sphere and box; a **model id** (a valid model on every instance, present in
the same group, and its authored name shares the instance's description on
most sampled records — the rest are emitters and locators on generic
models); a scale; a count of 0/1/2; and, present exactly when that count is
1, a **collision-proxy id** resolving to a collision record in the same group
— never equal to the model id. So the instance still carries no behaviour of
its own, but unlike SSX 3 it references its collision proxy directly rather
than by name. [measured] [[520-instance]]()

**Behaviour is a script bound to the instance from outside.** One bin holds
compiled scripts — a four-character magic, three size words, then bytecode
with no strings. Another holds **binding records** keyed by (sector, instance
id) — every one names an instance in the same group — each carrying two
optional script references that all resolve to a script in the same group. A
per-track list names one or two further scripts per track. This is what
replaced the effect-node graph: the executable has no node vocabulary
because kinds are compiled into bytecode, and the world stream ships the
bytecode beside the instances it drives. [measured; the "script" reading of
the magic is inferred from the SSX 3 VM's naming and the absence of strings]
[[520-scripts]]()

Splines keep a 48-byte header (own id, bounding box, a kind duplicated in
two halves, segment count, header size 48) and then segments of **128 bytes**
for the common kinds and **144 bytes** for one kind: four power-basis
coefficient vectors highest power first, three link words, a bounding box,
the arc length, then packed or zero data — SSX 3's 16-byte segment prefix is
gone. Materials are 20 bytes (texture id, second texture id or −1, a flags
half); the animated variants replace one word with a rate and append a frame
count and 2–6 texture ids — data-driven texture flipping. Lights (22),
halos (2,062), visibility curtains (49) and particle definitions and
placements (330 each) carry own ids, colours, positions and boxes; their
non-geometric fields are sketched, not decoded. Effect instances (182) are
keyed one-to-one to the name map's effect array. The two name members parse
as eight arrays whose identifier entries are (hash, value, sector u16,
resource u16, value) — the halves are 16-bit here, not 8/24 — and the
805-entry array keys the **textures** (801 of the 802 texture identifiers),
its layer words being the baked source layer.
[measured] [[520-other-records]]()

> [[520-instance]]() `t11_inst.out.txt` — +8 kind (23×37,007, 7×9,542,
> 5×5,322, 21×5,267, 22×783, 6×88, 20×13); +12 own id == header 58,022/58,022;
> +16 4×4; +80 sphere; +96 box; +120 (u16 0, u16 model id): valid 58,022/58,022,
> same group 58,022/58,022, 4,050 distinct = every model, name agreement
> 17,435/20,000 sampled; +124 scale (1.0 ×18,892; 1.6, 1.375, …); +136 −1
> half; +144 tail offset (176 ×38,212, 192 ×17,902); +148 count 0/1/2
> (14,952 / 34,768 / 8,302); +156 (u16 0, u16 collision id) or −1 — present
> exactly when count = 1, same-group bin-12 record 34,768/34,768, == model id
> 0/34,768; +160/+172 filler 0x71458F4A; +168 enum (3×28,573, 0×14,952,
> 2×7,445, 1×3,020, 7, 10, 11, 5); chain: tag-3 references (record-relative
> offsets) closed by tag 6, two + end on 45,055, up to 19 entries.

> [[520-scripts]]() bin 22: `LUN\0`, (size−16, size, size), bytecode, no
> strings; 1,504 distinct. Bin 21: 3,276 records keyed (sector, instance id),
> all naming an instance in the same group; 1,422 first and 1,418 second
> references, all resolving to a same-group bin-22 script; three −1 words
> unread. Bin 23: 15 records (one per track code), 1–2 scripts each, all
> local. spec:510-nodes-absent for the SSX 3 `Luno` VM naming.

> [[520-other-records]]() `t12_bins.out.txt`, `t17_coll.py`, `t16_names.out.txt`
> — splines: kinds 7×2,490, 3×346, 64×264, 5×15, 0×5; 128-byte segments fit
> 2,856/2,856 for kinds 0/3/5/7, 144-byte 264/264 for kind 64; materials:
> texture id in the same group's set 10,176/10,228, flags half (1×7,042,
> 3×2,070, 25×504, 7×372, 27×169); lights 22 × 112 B on seven sectors (type
> 1×19, 2×2, 0), halos 2,062 × 96, curtains 49 × 208, particles 330 × 112 /
> 144; effects 182 keys == name-map effect array 182/182; name arrays 0/1/2/4
> cover patches/instances/models/splines 22,896/22,896, 37,046/37,046,
> 4,049/4,050, 3,120/3,120; array 3 ↔ textures 801/802 (`f_trigger_3475 wr3`,
> `common_patches_common_patches_f_np3_a_l_465 wr1`); array 6 ↔ effects (182
> keys for 209 names); array 7's 29 area hashes = the database's area keys.
> Hash table (bin 13): 16-byte header (0, 0, 4.0f, count), 32-byte entries
> (64-bit key, 0xCC fill, (3, index), payload offset = 16 + 32·count) — the SSX
> 3 sound-trigger table with wider entries.

## Archives, models, characters

The rider-model archive carries the **sibling magic** that `200-archives.md`
records as selecting an identical layout but which is absent from the baseline
disc; the world archive carries the ordinary one. On Tour is the first title
measured here to ship both in one build, which confirms that chapter's
otherwise untested note. [measured] [[520-archives]]()

Models are the same container family at format id **14**, with a sub-model
directory of **112-byte** entries — against SSX 3's id 13, the baseline's id 8
with 80-byte entries, and SSX (2000)'s id 3 with 64. [measured]
[[520-mpf]]()

Riders are **modular**: the archive holds 1,227 members, one per body part per
detail tier, and the parts are bound to a character by a **plain-text
configuration file per rider** — a commented table whose rows name the part
file, the part slot, the detail tier and a variant index. The referenced part
names match the archive members exactly. This is authored source shipped on
the disc, and it has no counterpart in any earlier title, where a rider is a
small number of binary containers. [measured] [[520-chars]]()

> [[520-archives]]() spec:200-bigf; doc:../../Snowknife/SSX-Library/SSX-Library/BIG.cs
> `GetBigType` — rider-model archive detects as `BIG4`, world archive as
> `BIGF`.

> [[520-mpf]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Models/MpfHeaderChecker.cs
> `DetectFileType`; spec:240-detect; spec:240-directory. Measured on rider
> part files: format id 14, one sub-model, directory offset 12, data start
> 128 = 12 + 112 + 4.

> [[520-chars]]() doc:../research/series-comparison.md — per-rider text
> configs in the character directory. Each row is an `mdl` entry taking the
> part file, the part slot, the detail tier and a variant index, under a
> commented column header; local part names resolve directly to archive members.

## Authored names, day and night

On Tour ships **68,928 authored names in eight arrays**, against SSX 3's five.
The three extra arrays are the interesting ones: a placement/layer array, a
**mission** array, and an **effect-instance** array. Start and finish areas are
named too. [measured] [[520-names]]()

| Array | Count | Shape |
|---|---:|---|
| patches | 22,896 | `patch_<track>_<description>_<serial>` |
| instances | 37,530 | `mdl_<track>_<description>_<serial>` |
| models | 4,053 | as instances |
| textures | 805 | a layer prefix, an object name, then a trailing track code — keys 801 of the 802 texture identifiers |
| splines | 3,120 | `spline_<track>_<material>_<serial>` |
| missions | 286 | `<track>_medal_<discipline>_<n>`, `<track>_shred_<objective>_<n>`, `Freeride_<track>` |
| effect instances | 209 | fireworks, falling snow, smoke, sparks, camera flashes |
| areas | 29 | per-track start and finish |

Fifteen track codes appear. **Day and night are a content axis**: the layer
prefixes separate day-only, night-only and common sets, per-track sidecar
members come in day and night pairs, and roughly 1,800 day and 1,500 night
names are authored. [measured] [[520-daynight]]()

> [[520-names]]() doc:../research/series-comparison.md — parsed with the SSX 3
> name-map reader unchanged; array sizes and samples there.

> [[520-daynight]]() doc:../research/series-comparison.md — layer prefixes
> `day_objects_`, `night_objects_`, `common_objects_`, `common_patches_`;
> sidecar members named `<track>d` / `<track>n` with two extensions each;
> word census day 1,773, night 1,500.

## The editor grew

Every editor section SSX 3 ships is present, and the set is larger: the
free-fly cursor gains a **browse mode**, the script-camera editor gains a
much wider set of per-parameter deltas, mission debug gains record, preview
and play, and a further tool section appears. The front end is built on an
embedded Flash-style object model. [measured] [[520-editors]]()

Taken with the text character configs and the named missions and effects, the
direction 510 identifies continues: more of the authoring surface is tools and
text, and less of it is recoverable from the shipped world data. [inferred]
[[520-editors]]()

> [[520-editors]]() doc:../research/series-comparison.md — shipped
> input-configuration file, commented plain text; sections carried over from
> SSX 3 plus additional `EditorBrowse*`, `ScriptEdit*` and `MissionDebug*`
> field families; Flash-style object-model symbols in the ELF. Retail comments
> and bindings are paraphrased.

## Not established

The container, the census and the record identities are settled; what
remains is field-level:

- The patch's template id (two values) and its two flag fields; which table
  the template values index. [open]
- Surface-type labels for the sixteen values — a plane fit per class against
  the corner cache, and the texture names now reachable through the patch's
  texture id. [open]
- Path properties 100 and 102, the packed point's fourth byte, the word
  between points and events, and the event kinds 100–113/300 against the
  baseline's event table. [open]
- Instance fields at +148/+152/+168/+170 and the rendering-chain entry
  semantics (as in SSX 3). [open]
- The script bytecode format, the binding record's three −1 words, and
  whether bindings can name non-instance targets (all 3,276 shipped ones are
  instances). [open]
- The hash-table payload, the per-track index tables, the 220-byte effect
  layout, and the light/halo/curtain/particle field roles beyond geometry.
  [open]
- The streaming database's unnamed header and sector fields, and the index
  lists after the named lines. [open]
- The reader side of the container — whether the loader resumes parsing
  through the carry or only uses the per-block mask for skipping — is
  inferred from the output, not read from the executable. [open]
- Everything in the runtime and presentation parts, as for SSX 3. [open]
