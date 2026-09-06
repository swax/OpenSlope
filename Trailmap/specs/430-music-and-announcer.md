# 430 — Music and Announcer

The soundtrack is **performed by the run**. Before the race, short **intro
stems** in three intensity tiers are re-sequenced; once racing, an
**interactive music graph** (`190-audio-data.md`, `270-music-graph.md`) is
walked bar by bar, steered by a single **intensity control** and punched by
**events** from gameplay; and the **announcer** rides the same gameplay
events through a probability gate that makes him chattier as the action
heats up. [[430-overview]]()

> [[430-overview]]() db:music-system; db:speech-events;
> map:"Dynamic race music (EA PathFinder) and the announcer".

## Intro stems

The pre-race / menu music re-sequences the level's stem set
(`190-audio-data.md`: equal-length phrases in a quiet tier and two loud
tiers, plus an outro): stems are chained **end to end at phrase boundaries**
with a short (~1 s) volume ramp between choices, the choice randomized —
one stem drawn from a first pool, then pairs drawn from a second — so the
lead-in never plays identically twice. The whole layer **stops when the
race-start sequence begins** and the graph below takes over; a config-driven
duck reconciles its level against speech and effects every frame.
[[430-stems]]()

> [[430-stems]]() db:music-system; map:"Dynamic race music" — stems
> loaded per level by `IntroMusic_LoadLevelBig` @0x00215358 (stream group
> 2), stopped by `IntroMusic_Stop` @0x002156c0 inside
> `Race_AudioBeginSequence` @0x00215780; first stem rand 1..3 then pairs
> rand 4..7, 1000 ms ramps; per-frame duck `Music_LevelReconcile`
> @0x0021bd20 (MUSICLEVEL/INTRODUCK). Open: the stem-index → tier-letter
> mapping and what cues the outro stem.

## Walking the graph

In-race playback is a chunk scheduler over the song graph, serviced on a
fast fixed clock (≈ 100 Hz, independent of the simulation tick): the
playing stream's current audio chunk drains, and when it is nearly empty
the walker advances to the next node **just in time**, queueing that node's
chunk so playback is gapless. Several streams can run; the highest-priority
one is elected **master** each service and the others sync to it.
[[430-walk]]()

At each advance the next node is chosen by **the** branch rule: scan the
current node's links in order and take the **first whose `[min, max]` range
contains the current intensity value** (`190-audio-data.md`); a full-range
link is therefore an unconditional fallthrough. Two node forms steer
without playing: a marker node fires a client callback (sync points), and a
loop node arms a **counter** that substitutes for the intensity in its
links and decrements per pass — "play this section N times, then fall
through". Per-node variable tables remap values along the way. [[430-choose]]()

> [[430-walk]]() db:music-system — `PATHFINDER_Service` @0x002c1660
> (master election by max priority, advance when `bytesRemaining <
> threshold`); 100 Hz timer registered by `PATHX_Init` @0x00223b40;
> chunk start `PATHFINDER_StartNodeSample` @0x002c1000, slave sync
> `PATHFINDER_SyncStreamToMaster` @0x002c12a8.

> [[430-choose]]() db:music-system — `PATHFINDER_ChooseLink`
> @0x002c0210: first link with `min ≤ ctl ≤ max`, ctl = the stream's path
> level (or the live loop counter); control-node walk
> `PATHFINDER_RouteToNode` @0x002c02e0 (sample 0 = marker callback,
> sample −1 = arm loop counter), per-node remap `PATHFINDER_NodeValueRemap`
> @0x002c0468; the `0..127` full-range link encoding is the common
> unconditional subentry.

## The intensity control

The single 0–127 control the links test — the **path level** — is set by
gameplay in coarse steps: [measured] [[430-level]]()

| Moment | Path level |
|---|---:|
| racing, default | 80 |
| inside an uber-trick tier | 90 |

The music's intensity is a **routing** phenomenon — the *same* song takes
busier paths as the level rises — not a volume or layer mix. In the
measured song graphs, every authored two-link split point sits at 40–59, so
the default racing level of 80 already always takes the higher-energy
branch; raising the level further to 90 does not visibly unlock more of the
graph in the measured data. (One attract mode randomizes the level across
0–99, exercising the low regions.) Each song record also carries an
authored playback volume and BPM; songs for a level cycle under an enable
mask, so consecutive races shuffle through the level's playlist.
[[430-level-extra]]()

**"It's Tricky" is a song swap, not a routing level.** When the boost meter
fills, the graph walker does not raise the path level to 127 within the
race song — it swaps in a **separate, dedicated song** (authored linear,
every link unconditional) that plays until the meter empties, at which
point the race song resumes. Because that song's own graph is linear, its
internal path level (127, or 90 mid-uber) is irrelevant to its playback;
127 is not a busier region of the race song, and no race-song split point
is reachable only above 90 or 127 in the measured data
(`270-music-graph.md`). [[430-level-extra]]()

> [[430-level]]() db:music-system — `RaceMusic_Start` @0x00215718 sets
> path level 80 (mode 6: rand % 100); 90 on trick-tier enter, 127 via
> `EnterTrickySong` @0x00226138; setter `PATHFINDER_SetPathLevel`
> @0x002c2460 (all streams).

> [[430-level-extra]]() db:music-system — song records: BPM and a
> path-level volume %; cycling @0x00225b58 under the enable bitmask;
> "It's Tricky" is a dedicated song swapped in/out by
> `EnterTrickySong`/`ExitTrickySong` @0x00226138/@0x002261a0 when the
> boost meter fills/empties (`390-pickups-and-race.md`).

## Events: gameplay punching the music

Discrete moments inject **events** rather than moving the level. An event
is queued and consumed at the **next chunk boundary** (so the punch lands
on the bar), looked up in the song's event table — indexed by the playing
track, the event number, and the current node's authored **section** — and
the resulting router entry jumps the walk to a target node (optionally
cancelling pending jumps, or marking the song's end). Sync variants allow a
hard cut or an immediate (mid-bar) application for moments that must not
wait. [[430-events]]()

The traced event vocabulary: entering uber-trick **tiers 1/2/3** fires song
events 1/3/5; the trick **ending** starts a one-second grace, then fires
the matching exit event (2/4/6) — so back-to-back tricks hold the elevated
section instead of yo-yoing — while a **crash cancels the grace and exits
immediately**. Plain riding re-asserts a neutral event, and **crossing the
finish** fires a one-shot stinger event. [[430-vocab]]()

> [[430-events]]() db:music-system — queue `PATHFINDER_QueueEvent`
> @0x002c27a0 (consumed at the chunk boundary; sync 2 = hard cut, < 0 →
> `PATHFINDER_ApplyEventImmediate` @0x002c0c50); lookup
> `PATHFINDER_EventTableLookup` @0x002c04f8 over (track, event,
> section = node flags & 0x7f); router u32 {action, flags, target}: flags
> bit0/1 node change, bit2 cancel pending, bit6 mark song end; direct
> jumps `PATHFINDER_QueueJumpToNode` @0x002c2a68. Open: the action byte's
> full semantics.

> [[430-vocab]]() db:music-system — boarder-event dispatcher
> `BoarderState_GameEventToAudio` @0x0011a350 (22-case table): game events
> 2/4/6 → song events 1/3/5 (`MusicTricky_TierEnterDispatch` @0x0021c598),
> ends 3/5/7 → 1000 ms grace → 2/4/6, crash/reset cancels @0x0021c9c8,
> event 1 → song event 0, finish events → song event 10 one-shot (armed
> flag). Open: which gameplay moments post several of the 22 boarder
> events.

## The announcer

The announcer consumes the **same gameplay event stream**: each event kind
maps to a **speech category** (big air, landings, knockdowns, passes, …)
whose bank holds many interchangeable lines (`190-audio-data.md`). Whether
an event actually speaks passes a **probability gate**: a random draw
against a table entry indexed by the **event category** and the current
**excitement level** (an integer 0–9 tracked from the run's action and
clamped by configuration). Each category has its own excitement curve — so
as a run heats up the announcer fires on moments he'd earlier have let
pass, and routine events stay rare even at full excitement. Delivery is
asynchronous (posted to the speech system, which picks a variant line);
speech, like music, is not spatialized. [[430-announcer]]()

> [[430-announcer]]() db:speech-events — gate
> `Speech_EventProbabilityGate` @0x00236278: play iff `(rand & 0x3ff) <
> probTable[category·10 + excitement]`, table @0x003a4798, excitement =
> clamp of a tracked stat; dispatcher rows (airborne → big-air category,
> etc.) from @0x0011a350; tricky-meter-full has its own hook
> (`Speech_OnTrickyMeterFull` @0x00233cd8); delivery = message-bus post
> @0x0022f808 consumed by the speech system (`SpeechSys_Init`
> @0x00228d28); the event → bank binding is data (`190-audio-data.md`).
