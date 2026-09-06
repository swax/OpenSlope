# 250 — AIP/SOP Path Files

Each level ships two sibling path files, `<course>.aip` and `<course>.sop`,
inside the level archive (`200-archives.md`). They use the **identical
container format**; they are two per-mode *datasets* (not two halves of one),
each holding a full set of AI paths, a start-position list, and race lines.
The logical model — race lines as the ordered course spine, the
distance-to-finish progress metric, respawnable AI paths and start-grid assignment —
is `140-paths.md`; this chapter is the field layout that chapter defers
here. [measured] [[250-files]]()

All integers are little-endian u32; all reals are IEEE-754 singles.
Positions are in engine units (centimeters, `002-conventions.md`).
[observed] [[250-types]]()

> [[250-files]]() raw `gari.aip`/`gari.sop` parsed byte-exact this pass; one
> shared reader for both files,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs
> `LoadAIPSOP` (called once per extension),
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs "AIP &
> SOP" region; engine filename builder @0x0025f320 (extension strings `.aip`
> @0x003a97a8, `.sop` @0x003a97b0).

> [[250-types]]() AIPSOPHandler.cs StreamUtil reads (LE defaults),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs.

## File header — 16 bytes

| Offset | Type | Field |
|---:|---|---|
| 0x00 | bytes ×4 | magic `0A 0A 0A 0A` |
| 0x04 | u32 | path-type section count (always 2 as observed; readers treat the file as two sections) |
| 0x08 | u32 | section 1 offset (AI paths) |
| 0x0C | u32 | section 2 offset (race lines) |

Section offsets are relative to the **end of this header**: section 1's
offset is 0 (it starts at file offset 16), and section 2 starts at
16 + its offset. Verified to the byte on real files. [measured]
[[250-header]]()

> [[250-header]]() AIPSOPHandler.cs `LoadAIPSOP` (seeks offset + 16),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs;
> measured: gari.aip section 2 offset 45,840 + 16 = 45,856 = the exact end of
> section 1; gari.sop 13,200 + 16 likewise exact.

## Section 1 — AI paths

Section header: u32 path count, u32 start-position count, then that many u32
**start-position indices** — indices into this section's path array assigning
one path to each rider slot.
Both Garibaldi files carry exactly **6** start indices (`[0,6,12,15,16,17]`
in the `.aip`, `[0..5]` in the `.sop`). [measured] [[250-section-a]]()

Path records follow back-to-back, no padding: a 72-byte fixed header, then
the points, then the events.

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | type — always 2 in observed data |
| 0x04 | u32 | constant 100 |
| 0x08 | u32 | constant 4 |
| 0x0C | u32 | **line rating**, 0…100 — how daring this line is; the AI picks the path whose rating matches its mood (`395-ai-riders.md`). 50 on most paths, with 0/20/25/80/100 outliers |
| 0x10 | u32 | constant 101 |
| 0x14 | u32 | constant 4 |
| 0x18 | u32 | **respawnable** flag (0/1): the path may be used to put a fallen rider back on course (`140-paths.md`) |
| 0x1C | u32 | point count |
| 0x20 | u32 | event count |
| 0x24 | f32 ×3 | path seed position (absolute world position) |
| 0x30 | f32 ×3 | bounding-box min — of the **accumulated** polyline (below) |
| 0x3C | f32 ×3 | bounding-box max |
| 0x48 | f32 ×4 × points | the position steps (below) |
| then | 16 bytes × events | event records (below) |

[measured] [[250-patha]]()

> [[250-section-a]]() AIPSOPHandler.cs `TypeA.StartPosList`, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs; GARI counts:
> aip 90 paths / sop 32; start lists measured raw — closes 140's open item
> (GARI start count = 6). Runtime: the fixed six-pointer field is
> `pathManager+0x14..+0x28`, filled by `AIPath_ParseSection` 0x00198a10.

The runtime representation of the start list is a **fixed six-pointer field**, not
a variable-length array: the parser resolves as many start indices as the file
declares and writes them straight into that field. A playable dataset therefore
requires exactly six valid indices — fewer leave rider slots unset, and more
overwrite the object state that follows the field. [[250-section-a]]()

> [[250-patha]]() AIPSOPHandler.cs `struct PathA` (read order),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs;
> GARI measured: constants hold on all 122 records (the converter asserts
> Type==2/U1==100/U4==101/U5==4); rating dist aip {50×82, 100×3,
> 80×1, 25×2, 20×1, 0×1}, sop {50×32}; respawnable aip 81/90, sop 32/32;
> respawn semantics db:oob-reset. The rating's consumer is db:ai-rider
> (@0x00118838): the parser lands the 0x0C word at `cPath+0x38` —
> the same in-memory slot race lines use for `DistanceToFinish` — and the AI's
> path-choice score subtracts `(100 − |rating − mood|) × 23189.36`.
> spec:395-rating.

## Section 2 — Race lines

Section header (16 bytes): u32 constant 1, u32 **byte size** of the rest of
the section (counted from just after this field to the last event byte;
verified exact on real files), u32 race-line count, u32 constant 0.
[measured] [[250-section-b]]()

A race-line record is a 60-byte fixed header, then points, then events:

| Offset | Type | Field |
|---:|---|---|
| 0x00 | u32 | type — always 1 in observed data |
| 0x04 | u32 | constant 0 |
| 0x08 | u32 | constant 4 |
| 0x0C | f32 | **distance to finish** at the line's start, in the horizontal arc-length metric below |
| 0x10 | u32 | point count |
| 0x14 | u32 | event count |
| 0x18 | f32 ×3 | path seed position |
| 0x24 | f32 ×3 ×2 | bounding box (min, max) of the accumulated polyline |
| 0x3C | f32 ×4 × points | position steps |
| then | 16 bytes × events | event records |

[measured] [[250-pathb]]()

Race lines are stored in course order (record 0 = start, last = finish), and
each line's distance-to-finish approximately equals its own summed horizontal
length plus the next line's distance-to-finish. The chain is approximate
(per-line mismatches of tens to hundreds of units), and the final line runs
*past* the finish — its distance-to-finish is 2,467 (MESA) to 6,099 (MERQUER)
units smaller than its own length. Implementations should treat the stored value
as authoritative rather than recomputing it [inferred]. [measured] [[250-dtf]]()

**Distance-to-finish zero is the finish line.** Walking the minimum-DTF race
line to arc-length `DistanceToFinish` lands on the course's finish arch
(`Mdl_FinnishGate_*`, 0.8–5.8 m) — and on MERQUER, 0.14 m from the uphill edge of
the level's checkered-flag decal. The same line always carries a **type-9 event
at exactly that station** (below). Courses with branching alternates (MERQUER)
keep the *finish chain* in index order, so "last" means minimum stored DTF, not
the last record. Where `.aip` and `.sop` disagree the `.aip` line is the correct
one. [measured] [[250-dtf-zero]]()

**Runtime consumption — confirmed.** A rider's **continuous distance-to-finish**
is the active line's stored distance-to-finish minus `arcLength`, where
`arcLength` is the **horizontal** (W-metric) closest-point projection of the
rider's world position onto the active line, recomputed every frame; the
active line is the nearest of the three bbox candidates around the rider.
The stored per-line DTF is read directly — the engine never recomputes it —
so a port that copies the authored values reproduces the metric exactly
(including the last-line overshoot). DTF feeds **catch-up/rubber-band** and
**off-line detection** (perp distance > 500 units → reset to the line),
*not* standings: placement is a separate discrete checkpoint counter
(`390-pickups-and-race.md`). [measured] [[250-dtf-runtime]]()

> [[250-dtf-runtime]]() db:race — each race line loads into a 60-byte
> runtime record (`cPath`/`cEventPath`); the file `+0x0C` distance-to-finish
> lands at runtime `+0x38`. `Boarder_UpdateRaceLineProgress` 0x001182a0
> (DTF = `line+0x38 − arcLen` → `rider+0x374`), projection
> `cPath_ClosestPointArcLength` 0x00197970, station/length 0x00197c30/0x00198048
> (both consume point `+0x0c` = W), line-select 0x00118618 → `cPathManager_CollectNearestN`
> 0x00198608. Discrete placement `RaceCheckpoint_Handler` 0x0011e700 →
> `rider+0x20`. spec:390-raceline.

> [[250-section-b]]() AIPSOPHandler.cs section-B header, doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs; writer back-patches
> ByteSize (`SaveAIPSOP`); measured gari.aip: 59,688 − 45,864 = 13,824 exact.

> [[250-pathb]]() AIPSOPHandler.cs `struct PathB`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs;
> GARI: aip 14 lines / 756 points, sop 15 / 819; constants hold on all 29.

> [[250-dtf]]() raw-file measurement, parsed per
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs;
> chain on gari.aip: DTF(B0..B5) = 460,747 / 386,786 /
> 311,726 / 229,524 / 144,187 / 53,700 vs own ΣW 73,973 / 75,555 / 82,202 /
> 85,337 / 90,487 / 57,609 (last line overshoot −3,909; B0→B1 mismatch 12,
> B1→B2 495).

> [[250-dtf-zero]]() raw-file measurement over GARI/MESA/ELYSIUM/MERQUER/SNOW
> (`AIP.json`+`SOP.json`, `Instances.json`; 100 units = 1 m). Minimum-DTF line:
> aip B5 / B4 / B7 / B6 / B3. Type-9 with `EventStart == DistanceToFinish`:
> 53,700.06 / 40,070.375 / 1,898.855 / 31,761.543 / 72,938.555 (aip) and
> 55,074.26 / 36,116.082 / 84,564.305 / 31,762.268 / 72,933.984 (sop) — 10/10,
> unique. DTF=0 → nearest `Mdl_FinnishGate_*`: 0.79 / 5.83 / 1.48 / 2.94 / 4.47 m
> (aip); the sop zeros land 13.99 / 4.73 / 2.79 / 2.60 / 4.48 m out, so `.aip`
> wins on GARI. Line overshoot past DTF=0: 3,909 / 2,467 / 4,205 / 6,099 / 4,244.
> MERQUER decal `Mdl_FinishLine_6000` (material 189 `damwater1` → `0180.png`, the
> texture's only user): uphill edge X=123,966.2 vs DTF=0 X=123,952.4; type-9 arc
> span 449.03 vs decal depth 442.69. (Arc 0 taken at the seed `PathPos`. Taking it
> at the first accumulated vertex instead shifts DTF=0 by the first step — 8 units
> on MERQUER, so the decal gap is 0.06–0.14 m either way. Which of the two the
> engine's `cPath` uses is not pinned; it is below the authoring tolerance here.)
> spec:390-finish-loc.

## Position encoding — accumulated steps

On-disc points are **not positions**. Each 16-byte point (X, Y, Z, W)
encodes one step from the previous accumulated position, seeded at the
record's seed position:

```
pos[0] = seed + (X₀·W₀, Y₀·W₀, Z₀·W₀)
pos[k] = pos[k−1] + (Xₖ·Wₖ, Yₖ·Wₖ, Zₖ·Wₖ)
```

The normalization is **horizontal-plane exact**: for every point in all four
measured sections, √(X² + Y²) = 1.0 (within float error), while the full 3-D
length reaches 37 — so (X, Y) is a unit direction in the ground plane, **W is
the step's horizontal length**, and Z is the vertical slope (rise per unit of
horizontal travel), unbounded. Distance-to-finish and event stations chain in
this same horizontal metric. The record's bounding box encloses the
*accumulated* polyline — the proof of the encoding: accumulating keeps 100%
of all 4,277 measured points inside their record's box, while reading each
point as a lone offset leaves ~26% outside. [measured] [[250-accumulation]]()

**The seed is the path's first vertex**: the engine's own walk
over a path seeds its running position from the seed field and then takes one
segment per stored point, so a record of N points is a polyline of **N+1**
vertices and arc-length 0 sits at the seed, not at the first accumulated point.
A reader that starts at `pos[0]` therefore loses the whole first segment and
shifts every arc-addressed thing on the path — event stations included — back
by its length. That is not a rounding error: across GARI's 90 AI paths the first
step is a median of 4.3 m and reaches 49 m, against a jump marker's 3 m
approach window. [traced] [[250-seed-vertex]]()

> [[250-seed-vertex]]() `cPath_ClosestPointArcLength` 0x00197970: the cold path
> (no cached segment) seeds its running point P from `cPath+0x0C` — the seed
> field — at 0x00197a14..0x00197a4c, sets the segment index to 0, and then loops
> `cPath+0x08` (= point count) times, each iteration reading point[i] as
> {direction @+0x00, W @+0x0C}, footing the query onto the segment from P along
> that direction, and advancing `P += direction × W` (0x00197ba0..0x00197bc4).
> So segment 0 runs seed → seed+step₀ and the accumulated arc starts at the seed.
> Same walk in `cPath_PointAtParam` 0x00197ef0. Corollary, and the reason it
> matters: a reader that drops the seed and starts at pos[0] slides
> every event station on every path — GARI first-step horizontal length: median
> 4.33 m, max 49.10 m, min 0.055 m over 90 paths.
>
> [[250-accumulation]]() in-box proof 2105/2105 + 756/756 + 597/597 + 819/819
> (tolerance 1 unit) vs absolute-read ~74%; unit-2D measured 0.99999991–
> 1.00000020 over all points; re-encoder mirrors it (W = 2-D length, divide
> through), AIPSOPHandler.cs `GenerateNewVectors`/`length2D`; accumulation
> validated in practice (delta expansion = TrickyLevelInterface lines
> 749–751); W ranges 5.5–13,292; no zero-length first step on any of 151
> paths.

## Event records — 16 bytes

Identical layout in both path kinds: u32 event type, u32 value, f32 start
station, f32 end station — stations along the path in the horizontal
arc-length metric (every measured event lies within [0, path length]). Point
events have start == end; ranged events occur. Type −1 (the all-ones u32,
value 0) appears to be a disabled slot [inferred]. [measured] [[250-events]]()

The event **type is a 32-slot engine enum**: the legal on-disc type codes are
exactly `{-1, 0..23, 100..105, 300}` (`-1` = the disabled slot), translated
by the parser to an in-memory **index 0–31** (not the raw code); an unknown
code collapses to the disabled slot. Both path kinds share one parser, so
AI-path and race-line events share one vocabulary. Measured census: AI-path
events use codes 100/101/102/105/300 (type 101 ~61–120, type 100 ~189–471,
the rest 0); race-line events use the 1–21 + 300 band (values all 0 except
type 11, whose positive SOP payloads are checkpoint seconds).

**Two path-event families have confirmed gameplay dispatch.** The AI racer queries its
current AI path for items in an arc window ahead of itself and acts on **item
type 25** — which is the translation-table index for raw `EventType` **100**. It
is the **jump marker**: the AI presses its ollie there, and that press is the only
reason an AI rider ever jumps (`395-ai-riders.md`). Its value word packs the
speed the line wants to be taken at (km/h, `value >> 2`) and two trick-selection
flags. Garibaldi's AI paths carry 104 of them. [[250-jump-events]]()

The player course tracker dispatches raw race-line **type 11**, translated to
internal event **12**, as the **checkpoint**. The active race line's event path
converts the rider's previous/current DTF to path arc and returns every event
station in the forward crossed interval; `Boarder_UpdateRaceLineProgress` hands
each full event record to the boarder-state handler. Event 12 passes `record+4`,
the raw `EventValue`, to `RaceCheckpoint_Handler`. In showoff modes 3/5 that integer is
converted to seconds and added to the live countdown; in race it updates the
discrete checkpoint/standing state, presents the **CHECKPOINT** acknowledgement,
and adds no time or points. The event value is therefore not a race time award,
even where a retail AIP record carries a nonzero value. Reverse travel does not
fire because the event-path query rejects a decreasing arc interval. [measured]
[[250-checkpoint-events]]()

This is not a collision with checkpoint scenery. Models such as
`Mdl_CheckPoint_Top_2000` / `Bottom_2000` are flashing signs placed beside the
course; the trigger is the type-11 station on the active race line and can be
several metres from the sign geometry. Alternate race lines can repeat the same
logical checkpoint at the same DTF. The active line supplies one payload, so
route copies must not be summed by an offline consumer. AI-path type 101 is
still not a checkpoint. [[250-checkpoint-events]]()

**Five more AI-path event types have runtime readers**, all in the course
reset and the AI's path tracker. When the reset has chosen a respawn station
it is nudged by any authored window covering it: an internal-index-**28** (raw
103) event pulls the station back to the window's start, an index-**30** (raw
105) event pushes it past the window's end, and the jump marker itself (index
25, raw 100) pushes it past its end when neither of the others applied — a
rider is never put back down inside a jump marker. An index-**29** (raw 104)
window is a **no-reset zone**: a reset request whose tracked station lies
inside one is refused outright. Separately, the AI's path tracker treats an
index-**31** (raw 300) event overlapping the interval it just travelled as
"the path has ended here" and re-selects its line. Of these, raw 100, 105 and
300 occur on the retail AI paths; raw 103 and 104 do not appear in the
surveyed levels, so the refuse-and-nudge machinery ships mostly unused.
Remaining event types have no located reader. [[250-reset-events]]()

> [[250-reset-events]]() `cPath_AdjustStationForRespawnEvents` `0x00196c50`
> (called from `Boarder_CourseReset_PlaceOnRespawnPath` `0x00119228` at
> `0x00119280`): type 28 → `min(station, start)`; type 30 → `max(station, end)`;
> type 25 → `max(station, end)` only if no 28/30 applied; writes the station
> back and returns `cPath_PointAtParam(station)`. `cPath_StationOutsideType29Window`
> `0x00196d50` returns 0 when the station lies inside any type-29 window;
> `Boarder_CourseResetEntry` `0x00118f18` bails on it at `0x00118f5c`.
> `cAIPath_HasType31EventInWindow` `0x00198088` (vtable `0x0038BE48` slot 2:
> `type == 31 ⇒ 1` within `[lo, hi]` at `0x001980cc–0x001980e0`), called at
> `0x001181a0–0x001181b0` in `Boarder_UpdateAiPathTracking` with
> `[+0x340, +0x344]`; nonzero ⇒ `AiPath_SelectOrAdvance(…, 0)`. Index→raw:
> table `0x00339070` — 25→100, 28→103, 29→104, 30→105, 31→300. GARI AI-path
> raw codes present: 100/101/102/105/300/−1. map:"Course reset: triggers,
> warp state and placement".

One event type is a reliable **authoring** marker even so. On the minimum-DTF
race line — and only there — a **type-9** event sits at `EventStart` bit-equal to
that line's `DistanceToFinish`, i.e. exactly at DTF = 0: the finish line. It
holds in all five levels in both files (10/10) and is the only event in either
file with that property. Nothing reads it at runtime (the finish crossing is
posted elsewhere, `390-pickups-and-race.md`), but it is the authored ground truth
for *where* the line is, and a port can read it directly. Type 9 also appears
away from DTF = 0 (GARI's last line has three), so the station test, not the type
alone, identifies the finish. [measured] [[250-dtf-zero]]()

> [[250-jump-events]]() the type-enum translation table at 0x00339070 stores raw
> codes and `PathEvent_Parse` (0x00197668) keeps the INDEX, not the code: index 25
> is raw **100** (word at 0x003390d4). The AI's marker query (0x001392b0) filters
> the path's item list to `type == 25` over `[previousArc, arc + 300 u]` and the
> approach behavior presses the jump bit on it (0x0013799c). Value word decodes as
> `(kmh << 2) | (trickB << 1) | trickA`; GARI raw-100 census 104 events, target
> speeds 46–117 km/h (median 100). spec:395-jump, spec:395-jump-type.

> [[250-checkpoint-events]]() `.sop` selection: `0x0025f5dc` for modes 3/5.
> `PathEvent_Parse` `0x00197668`: raw 11 translates through `0x00339070` to
> internal event 12 and retains `EventValue` at record `+4`. The `cEventPath`
> vtable method `0x00196ea8` maps the previous/current DTF values to arc and
> calls the interval query `0x00197e08`. `Boarder_UpdateRaceLineProgress`
> `0x001182a0` consumes the returned record pointers at
> `0x00118534..0x00118578`; `BoarderState_GameEventToAudio` `0x0011a350`
> passes `record+4` for event 12 at `0x0011a468`; `RaceCheckpoint_Handler`
> `0x0011e700` adds the integer payload to the showoff clock at
> `0x0011e808..0x0011e820`. PAL and NTSC executables agree.

> [[250-events]]() AIPSOPHandler.cs `struct PathEvent`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/AIPSOPHandler.cs;
> station-bound check: all 442 GARI events within [0, ΣW+1]; censuses
> measured raw (gari.aip A: 101×119, 100×104, 300×112, 105×15, 102×1, −1×2;
> B: enum 1–21 + 300; type 11 values 60/75/45). Type-enum translation table
> at 0x00339070; `PathEvent_Parse` 0x00197668 (linear search, index not raw
> code); both path kinds route through `Path_ParseRecord` 0x00197420 →
> `PathEvent_Parse`. Dispatch survey: readers are
> `Boarder_UpdateRaceLineProgress` 0x001182a0 and geometry helpers
> 0x001987c8/0x00198608/0x00197748/0x00197d28 (points + `DistanceToFinish`
> only) was an incomplete reader survey: it missed the EventPath virtual query
> and the returned-record loop above. Control nodes remain separate for finish,
> gates and lap boost. The AI racer (`cComputer`, db:ai-rider) independently
> filters to item type 25 (raw 100); see [[250-jump-events]].

## The two files

Measured populations (GARI raw; a second level's exported JSON for
comparison):

| | gari.aip | gari.sop | ELYSIUM aip | ELYSIUM sop |
|---|---:|---:|---:|---:|
| AI paths | 90 | 32 | 195 | 45 |
| … respawnable | 81 | 32 | 182 | 45 |
| AI-path points | 2,105 | 597 | 3,652 | 862 |
| Race lines | 14 | 15 | 14 | 12 |
| Race-line points | 756 | 819 | 678 | 684 |
| Start indices | 6 | 6 | 6 | 6 |

The datasets **overlap**: on Garibaldi, 11 of the `.sop`'s 47 lines (its 32
respawnable AI paths plus 15 race lines) are identical to `.aip` lines —
same seed position and the same first-step/point sequence. The engine loads
`.sop` only for game modes 3 and 5, the two values dispatched to
`ShowoffMode`; Race and Freeride modes load `.aip`. A practical offline
consumer can union both files' race lines and respawnable AI paths into one
course network and deduplicate. [measured] [[250-two-files]]()

Two disambiguations: the "path level" that drives interactive music link
selection belongs to the music graph (`270-music-graph.md`,
`190-audio-data.md`) — it is unrelated to these files; and grind-rail
splines are not here either — they are PBD spline records
(`220-level-pbd.md`). [observed] [[250-not-this]]()

> [[250-two-files]]() GARI raw + ELYSIUM JSON export
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/Tricky/AIPSOPJsonHandler.cs;
> overlap = dedupe replay (11 dup lines); union consumption (also the source
> of the repo's older no-dedupe figure 142 lines / 3,933 points =
> 14+81+15+32 / 756+1,761+819+597; with dedupe 131 / 3,300).
> Runtime: game-mode dispatcher 0x00112550 maps 3/5 to `ShowoffMode`; filename
> selector 0x0025f5dc chooses `.sop` for exactly 3/5 and `.aip` otherwise.

> [[250-not-this]]() music: PATHFINDER_ChooseLink @0x002c0210,
> PATHFINDER_SetPathLevel @0x002c2460, map:"Dynamic race music"; rails:
> db:rail-geometry @0x00259860; AI pathing classes (RTTI `7cAIPath`
> @0x0038be70) are not consulted by the player wipeout recover, db:oob-reset.
