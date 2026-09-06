# 270 — Interactive-Music Graph Files

A song in the interactive-music system is a triplet inside the music
archive: `<name>.mpf` (the graph), `<name>.mus` (the chunked audio stream
the graph addresses), and a loop bank — a standard `BNKl` bank
(`260-audio-files.md`), named by the config's `LOOPDATA` key with a `.bnk`
extension. The config's `AsyncLevel`/`PhrasesPerBank`
keys name it an **async** layer (a separate volume-mixed bed alongside the
graph-walked Pathfinder track); its contents and runtime consumer are not
further traced [open]. The music config file names the triplet per song
(`PATHDATA` / `MUSDATA` / `LOOPDATA` keys), and a second config maps each
course to its song list, including the special section naming the
full-trick-meter swap song. The runtime walk —
link selection by path level, event-driven jumps, intensity behavior — is
`190-audio-data.md`/`430-music-and-announcer.md`; this chapter is the byte
layout. [measured] [[270-triplet]]()

The music `.mpf` is unrelated to the model `.mpf` (`240-models-mpf.md`): the
music graph begins with the 4 ASCII bytes `xDFP`, while the model file
starts with a small-integer id — the 4-byte signature is a reliable
discriminator. Byte 4 is a version (3) and byte 5 a sub-version (1) in every
shipped file. All values little-endian. **Every pointer in the file is
stored in 4-byte units** (multiply by 4 to get a byte offset). [measured]
[[270-magic]]()

> [[270-triplet]]() PATHDATA/MUSDATA keys, musicmap section→song resolution
> (incl. `[TRICK]`); raw MUSIC.INF/MUSICMAP.INF from the unpacked music
> archive; 21 song pairs on the PAL disc (survey below). `LOOPDATA` values use
> the `.bnk` extension of the `BNKl` container (`260-audio-files.md`);
> `PhrasesPerBank`/`BeatsPerPhrase`/`AsyncLevel` are the adjacent interface
> fields that identify an async-mixed phrase bank, not yet traced to a runtime
> consumer. The retail section names and assignments are paraphrased here.

> [[270-magic]]() the format rejects non-xDFP, version-gates at 3, and applies
> the ×4 on every pointer; model-.mpf first bytes = the format id 8
> (`240-models-mpf.md`); all 21 graphs parsed offset-by-offset this pass —
> every derived pointer chains correctly.

## Header

| Offset | Type | Field |
|---:|---|---|
| 0x00 | char[4] | magic `xDFP` |
| 0x04 | u8 | version = 3 |
| 0x05 | u8 | sub-version = 1 |
| 0x06 | u16 | tool residue (0x00B0 in all 21 shipped files); never read |
| 0x08 | 4 bytes | never read (zero in all files) |
| 0x0C | u8 | **player instance number** the graph binds to (0–3; 0 in every shipped file) |
| 0x0D | u8 | track count (1 in every shipped file) |
| 0x0E | u8 | section count (2–10 observed) |
| 0x0F | u8 | event count (11 on race songs, 6 on the two menu songs) |
| 0x10 | u8 | router count (6–15) |
| 0x11 | u8 | variable count (0–5) |
| 0x12 | u16 | node count (59–600) |
| 0x14 | 16 bytes | never read (zero in inspected files) |
| 0x24 | u16 × node count | node-offset table; each entry × 4 = the node record's byte offset |

The loader validates only the magic and the version pair (exactly 3 / 1),
reads the instance byte and the counts, and takes the node table at 0x24.
[measured] [[270-header]]()

> [[270-header]]() scripted parse of all 21 PAL graphs (cross-check: Top Bomb
> = 1 track / 4 sections / 11 events / 12 routers / 2 vars / 232 nodes).
> Engine `PATHFINDER_LoadGraph` `0x002c1ce0`: magic `0x50464478` at
> `0x002c1d58–64`, `lhu +4 == 0x0103` at `0x002c1d6c`, `lbu 12(file)` at
> `0x002c1d30` → `0x002bff30`; counts `+0x0d..+0x12`; node table = file + 0x24
> at `0x002c1da0`; exhaustive offset grep of `0x002bf000–0x002c4000` finds no
> +6 / +8..+0xb / +0x14..+0x23 file loads; census: all 21 graphs instance 0.

## Node record

Variable length: a 12-byte header plus 4 bytes per link, packed
sequentially. [measured] [[270-node]]()

| Offset | Type | Field |
|---:|---|---|
| 0x00 | s16 | sample index — **1-based** into the samples table when > 0; 0 = control/marker node; −1 = loop node |
| 0x02 | u8 | track (0 in every shipped file) |
| 0x03 | u8 | flags: low 7 bits = the node's **section number** (an event-table dimension); bit 0x80 = **cancel-pending marker** — a router that targets this node has its cancel-pending bit forced on, so jumping there clears deferred-event bookkeeping. Set on the entry node, on loop nodes (0xFF) and some section-boundary control nodes, never on sample nodes; it is not an end-of-song mark (song end is a router flag, below) [[270-node-runtime]]() |
| 0x04 | u8 | subdivision factor, used only when a slave stream is time-aligned to a master (beat ÷ factor, chunk ÷ factor); 1 on every race-song node, 8/16/32 only in the menu jingle — dead in retail, store opaquely [[270-node-runtime]]() |
| 0x05 | u8 | **beat count**: chunk duration ÷ count is the beat period; the stream keeps a beat counter on that clock and fetches the next node only when the counter reaches the count (race songs: 4 beats ≈ 600 ms) [[270-node-runtime]]() |
| 0x06 | u8 ×3 | multi-stream sync fields: on a control/marker node the first byte is the sync mode (0 = none — the value on every shipped control node; 127 = start the new chunk so it ends with the master's node; 255 = align to the master's next beat, entering mid-node at the matching beat; other = a custom ratio from the sample nodes' first byte and this node's second and third bytes); on sample nodes the first byte (always 4) feeds that ratio. Dead in retail [[270-node-runtime]]() |
| 0x09 | u8 | loop count — arms a decrementing counter on loop nodes |
| 0x0A | u8 | variable-remap list index (variables table below) |
| 0x0B | u8 | link count |
| 0x0C | 4 bytes × links | link records |

The 1-based sample indexing is pinned by the data: in every file the maximum
node sample index equals the samples-table entry count exactly (chunk =
samples[index − 1]), with 0/−1 reserved. [measured] [[270-node]]()

> [[270-node]]() node record = sample u16 (−1 = logic), flags, link
> count/records; runtime per-byte decode
> db:music-system @0x002c04f8 (0 = control/marker, −1 = loop, loop counter
> +0x09, remap index +0x0a); Top Bomb census: 232 nodes = 202 sample + 15
> control + 15 loop; topbomb nodes reference 1..202 over a 202-entry table.

## Link record — 4 bytes

`{s8 range min, s8 range max, s16 next-node index}`. The link-selection
walk (first link whose range contains the control value) is specified in
`430-music-and-announcer.md`; the control is the stream's path level (0–127,
`190-audio-data.md`) or the decrementing loop counter while looping. The
common unconditional link is {0, 127}. [measured] [[270-link]]()

Two measured refinements of the selection data: adjacent ranges **share
their boundary value** (a two-link node is `{0, K}, {K, 127}`, never K+1 —
first-match-wins gives K to the first link), and the observed split points K
all sit **below the in-race default path level of 80**
(`430-music-and-announcer.md`) (40–59 across one song's 152 two-link nodes)
— so at the default level the higher-energy
branch is always taken, and the calm branch needs the level pulled under
roughly 40–59. [measured] [[270-link-data]]()

> [[270-link]]() PATHFINDER_ChooseLink @0x002c0210 (scans 4-byte subentries
> {min s8, max s8, next s16} at node+0x0c, first min ≤ ctl ≤ max),
> db:music-system; PATHFINDER_SetPathLevel @0x002c2460; parse: all 58
> single links in slaybreak are exactly {0,127,next}.

> [[270-link-data]]() topbomb parse: 152/152 two-link nodes share the
> boundary (refines the older "partition" phrasing); split points {54×45,
> 59×31, 40×31, 50×30, 41×15}; default 80 = RaceMusic_Start @0x00215718.

## Tail tables

Immediately after the last node record, in order: [measured] [[270-tail]]()

1. **Event table** — `events × tracks × sections` bytes (4-aligned after).
   Each byte is a **router index**, laid out **track-major, then event, then
   section**: `index = ((track × eventCount) + event) × sectionCount +
   section`. The boundary lookup uses the current node's section; the queue
   path reads the section-0 cell of the (track, event) row for the
   track-excluded flag below.
2. **Routers** — u32 × router count, encoded `{s8 action, u8 flags, s16
   target node}`. The action byte is a **volume override**: 0–127 becomes
   the stream's action volume (multiplied by the stream's own 0–100 % level
   at the next chunk start), −1 leaves it untouched — every shipped router is
   −1. Flags: 0x01 and 0x02 are equivalent "perform node change" bits; 0x04
   clears deferred-event bookkeeping (forced on when the target node carries
   node-flag 0x80); 0x40 marks song end (the stream ends and is muted
   thereafter); 0x80, read from the section-0 cell at queue time, **excludes
   that track** from the queued command — it keeps walking its links instead
   of jumping. Shipped values: 0x00/0x01/0x02/0x80/0x81/0x82; the 0x80/0x81
   routers serve song event 0 ("normal riding") in every race song.
3. **Variables** — u32 × variable count, a list of **boundaries** in 4-byte
   units: a node with remap index i (1-based; 0 = none) uses the pair words
   from word offset `vars[i−1]` up to (excluding) `vars[i]`; for the last
   list the end bound is the word after the table — the track-table pointer
   — which works because the pair words sit immediately after that pointer
   and end where the track table begins. Each pair word is `{hi16 node to
   match, lo16 replacement}`: leaving a node with index i toward target T,
   every pair whose match equals the current target replaces it (chained).
   Shipped songs have one to five single-pair lists.
4. **Track-table pointer** — one u32 (× 4 = the track table's offset).
5. **Track table** — u32 per track. The engine never dereferences these
   words: for every stream the samples table is taken as track table +
   4 × track count, so the per-track entries are opaque. Track identity
   lives in the stream's track index, the event table's track dimension and
   the node's track byte (a direct jump-to-node is accepted only by the
   stream whose track equals the node's).
6. **Samples table** — 8 bytes per audio chunk, running to end of file: a
   u32 stored in 4-byte units — the stored value × 4 gives the `.mus` byte
   offset, and observed byte offsets are all 128-byte aligned (matching the
   `.mus` padding rule below) — and one plain u32 **chunk duration in
   milliseconds** (= floor(sample frames × 1000 / sample rate); the runtime
   divides it by the node's beat count for the beat period and uses the
   remaining beats for its prefetch/advance threshold).

> [[270-node-runtime]]() beat count: `PATHFINDER_StartNodeSample` `0x002c1000`
> (`rec+0x20 = duration / node[5]` at `0x002c1168–84`; beat counter `rec+6` vs
> `node[5]` at `0x002c119c–d0`); `PATHFINDER_Service` `0x002c18c0`
> (`(node[5] + 1 − rec[6]) × rec+0x20`). +0x04/+0x06..+0x08:
> `PATHFINDER_SyncStreamToMaster` `0x002c12a8` (`dur / (node[5] × node[4])` at
> `0x002c1390`, `dur / node[4]` at `0x002c13bc`; marker `lbu +6` gate at
> `0x002c1318`; mode 127 at `0x002c14ac`, −1 at `0x002c14f8`, else `+7/+8` at
> `0x002c1548–1600`, sample `lb +6` at `0x002c1568`). Bit 0x80:
> `PATHFINDER_EventTableLookup` `0x002c063c–0x002c0654` (`node[3] & 0x80 →
> routerFlags |= 4`); `AdvanceNode` flag-4 handling at `0x002c08a0/0x002c0914`.
> Census: sample nodes b4 = 1, b5 = 4, b6 = 4, b7 = b8 = 0 (femenuquad b4 ∈ {8,
> 16, 32}); control nodes b4 = 1, b5 = 1, b6 = 0; loop flags 0xFF.

The samples-table addressing is fully verified: every offset in every
shipped graph lands exactly on a stream header in the paired `.mus`
(202/202 on one song, 49/49 on another, and the full 21-file survey chains
to end-of-file). [measured] [[270-samples]]()

> [[270-tail]]() table order; duration carried as a meta field; event lookup
> PATHFINDER_EventTableLookup @0x002c04f8; router decode @0x002c27a0 (queue,
> sync modes) +
> PATHFINDER_ApplyEventImmediate @0x002c0c50; remap consumer
> PATHFINDER_NodeValueRemap @0x002c0468; topbomb event table = 44 bytes,
> values all < router count; router quartet at the head of both inspected
> files = no-jump actions; topbomb vars {0x4ce, 0x4cf} → pairs {20,208} /
> {62,44} (valid node ids). Multiply order: `0x002c0560–0x002c0570` (three
> `mult`, + section at `0x002c05e4`); `PATHFINDER_QueueEvent`
> `0x002c2884–94`; topbomb decode under that order yields the known vocabulary
> (ev1/3/5 → 212/222/114, ev2/4/6 → 62/44/222, ev10 → 208). Router action:
> `AdvanceNode` `0x002c0890–0x002c08bc` (`lb action; bgez → sb rec+0x14`),
> `ApplyEventImmediate` `0x002c0cd4–ec` (`rec+0x14 × rec+4 / 100` →
> `0x00224068`), `StartNodeSample` `0x002c10c8–e8`, `UpdateStreamVolumes`
> `0x002c00e0`; flags `0x002c08f4` (& 3), `0x002c089c/0x002c0914` (& 4),
> `0x002c08d8` (& 0x40 → `rec+0x15`), `QueueEvent` `0x002c28b8–cc` (& 0x80 →
> mask bit cleared, cmd byte 3 = 1); router census (1486): {0x00: 31, 0x01:
> 1189, 0x02: 19, 0x80: 20, 0x81: 222, 0x82: 5}, action −1 everywhere.
> Variables: `PATHFINDER_NodeValueRemap` `0x002c0468` (`vars[i−1]`/`vars[i]` at
> `0x002c04b0–b4`, count = difference, key = `w >> 16`, val = `w & 0xffff`,
> `movz` chaining); loader `0x002c1e14–24`; every file's pair region lies
> between the track-table pointer and the track table with word count = list
> count (topbomb {208→20}, {44→62}; reality 5 lists). Samples: `0x002c1160`
> (`lw -4(entry)` then `div` by `node[5]`); `0x002c135c–a8` (8-byte entry via
> ldl/ldr, +4 ÷ node[5] × node[4]); `PATHFINDER_GetNodeSampleOffset`
> `0x002c01b0` returns word 0 only. Tracks: loader `0x002c1e24–4c` (hdr+0x2c
> stored, never read); `PATHFINDER_QueueJumpToNode` `0x002c2b54–5c`
> (`1 << node[2]` must equal the stream's track bit); `tracks[0] × 4 ==
> samples offset` on all 21 files.

> [[270-samples]]() parse: gcd of topbomb's 202 offsets = 128 exactly;
> duration verified against the stream headers of 8 chunks across 2 songs
> (86,362 frames @ 36,000 Hz → 2,398 ms stored); chunk start =
> PATHFINDER_StartNodeSample @0x002c1000, drain/advance PATHFINDER_Service
> @0x002c1660 / PATHFINDER_AdvanceNode @0x002c06e0, db:music-system.

## The `.mus` stream container

The `.mus` has **no file-level header**: it is a bare concatenation of
independent SCHl streams (`260-audio-files.md`), one per samples-table
entry, each zero-padded to the next 128-byte boundary. All addressing comes
from the graph's samples table. Measured stream parameters on the race
songs: stereo, 36,000 Hz (35,999 on one song), EA-XA codec; a chunk's
duration is musical — one or a few measures (≈2.4 s at 100 BPM, ≈4.56 s = 8
beats at 105 BPM), which is what makes graph transitions land on musical
boundaries. [measured] [[270-mus]]()

> [[270-mus]]() one stream per chunk, seek per entry;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/EAAudioHandler.cs
> `Load` (chunk 0 chain measured: SCHl 44 B → SCCl → 36 SCDl → SCEl → pad);
> rates/codec from the stream-header dumps; BPM from MUSIC.INF.

## Shipped data

All 21 graphs on the PAL disc are version 3.1, single-track, with the same
unknown header word; race songs carry 11 events, the two menu songs 6 (and
no variables). Sizes span 59–600 nodes (49–568 chunks), graph files 1.5–19
KB, stream files 7.7–36.5 MB. [measured] [[270-survey]]()

Worked example — Top Bomb: 232 nodes (202 sample, 15 control, 15 loop);
152 two-link, 79 one-link, and one terminal zero-link node; the entry node
is a control node with a single {0,127} link; 44-byte event table; ~2.4 s
stereo chunks. [measured] [[270-survey]]()

The full-trick-meter ("It's Tricky") behavior is a **song change**, not a
graph branch: the swap queues the special song named by the config's
`[TRICK]` section, whose graph is *linear* — every link unconditional
{0,127} — so the path level is irrelevant inside it. Within a normal race
song, the level picks among links whose split points sit at 40–59.
[measured] [[270-tricky]]()

> [[270-survey]]() scripted parse of all 21 .mpf files decodes every chunk +
> graph cleanly.

> [[270-tricky]]() MUSICMAP.INF's `[TRICK]` section resolves to a dedicated
> graph whose parse has 59 nodes, 58 unconditional links + 1 terminal; swap =
> MusicSys_EnterTrickySong @0x00226138 / exit @0x002261a0 (level target 127,
> 90 in über tier), db:music-system; note: the config's PATHLEVEL/ASYNCLEVEL
> keys are per-song VOLUME percentages, not the node-graph path level
> (db obs @0x00215718) — do not conflate.

<!-- DIRTY
Open questions (derivations: elf-map "EA sound library: stream tags, banks,
codecs and speech scripts"):
- Node bytes +0x04/+0x07/+0x08 musical meaning under a multi-track song:
  none ships; the sync routine 0x002c12a8 is fully readable if ever required.
- Router flag bits other than 0x01/0x02/0x04/0x40/0x80: not examined.
DIRTY -->
