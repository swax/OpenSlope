# 190 — Audio Data

A level's audio is organized as **sound banks** of indexed **slots**, assigned to
a small set of fixed **groups** by scope (global, board, course, crowd, …), plus
the **music** — a set of intro stems and an interactive in-race music **graph** —
and the **announcer** speech bank. This chapter defines that data model: what a
bank and a slot are, how scope and slots are addressed, what the music graph
encodes, and how the announcer's lines are organized. The container and codec
byte layouts are in `260-audio-files.md` and the music-graph file in
`270-music-graph.md`; how sounds are chosen and mixed at run time is in
`420-audio-runtime.md` (effects, ride audio) and `430-music-and-announcer.md`
(music intensity, announcer gating).

## Sound banks and slots

A **bank** is an array of **slots**, each slot holding one sound (its channel
count, sample rate, codec, and sample data) or standing **empty**. Sounds are
addressed by slot number; an empty slot simply plays nothing — there is **no
fallback** to a default sound, so a level that references a slot its bank does
not ship is silent there (a Mesa explosion prop that names a report sound absent
from Mesa's course bank makes no sound in the shipped game). [[190-bank]]()

Banks are assigned to a handful of fixed **groups** by scope, via a config:
[[190-groups]]()

| Group | Scope | Holds |
|---|---|---|
| Main | global | shared UI / pickup / generic SFX |
| Board | global | the per-surface ride sounds (below) |
| Course | **per level** | this level's prop, event, and ambience SFX |
| Crowd | global | crowd reactions |
| (Aux) | — | (unused in the levels examined) |
| Tricky | global | the "It's Tricky" set |

A sound is requested by an **event id** resolved through one global table;
logic-graph sound nodes (`150-logic.md`) instead carry a direct course-bank
slot. Which groups events resolve into, and the direct-slot bypass, are
runtime behavior specified in `420-audio-runtime.md`. [[190-events]]()

> [[190-bank]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/BnkHandler.cs (`BnkHandler`,
> `BnkSound`: per-slot relative-offset table where a 0 entry = empty slot; per-
> sound tags `0x82` channels, `0x84` rate, `0xA0` codec, `0x85` samples).
> db:audio; map:"SSF effect-graph sound (firework `SoundPlay`)" — the missing-
> slot tail plays nothing (Mesa `Bomb_Event` slot 83 absent from its course
> bank).

> [[190-groups]]() doc:../research/extracted-data.md "Prop collision
> sounds from ADL and `BANKS.INF`" — `BANKS.INF` keys MAIN/BOARD/BANK/CROWD/
> AUX/TRICKY → groups 0–5 (GARI `zbxsfx`/`zboard`/`garibaldi1`/`Crowd`/—/`tricky`);
> parser 0x00211590, map:"Prop collision audio routing".

> [[190-events]]() map:"Prop collision audio routing" — event id →
> (group, slot) via `AudioSoundEventId_SlotJumpTable` 0x003a2870 (indexed
> id−2); ids 97/98/99 → crowd group. SSF SoundPlay path
> `SsfSoundPlay_QueueCourseBankSound` 0x00216ac0 hard-codes group 2 and passes
> the raw slot. db:prop-collision-sound.

### Collision-sound extraction contract

The normalized resolver rows are **not distributed with the specification or
implementation**. An extractor reads them from the user's boot executable and
writes a map-local `Audio/SoundIndex.json` beside the decoded banks. It also
reads that disc's `DATA/CONFIG/BANKS.INF`, so group 2 names the actual course
bank without a checked-in level→bank table. [[190-collision-event-map]]()

The sidecar schema is `openslope-sound-index/v1`. `Banks` maps numeric sound
groups to locally extracted bank folder names; `CollisionEvents` maps an event
id to `{Group, Slot, Bank, Clip}`, where `Clip` is an explicit map-relative
`Audio/SFX/<bank>/<slot>.wav` path. Entries whose jump-table handler takes the
silent path are omitted. A consumer treats a missing/unsupported sidecar as
unresolved rather than substituting a compiled retail table or guessing a bank
from sibling folders. [[190-collision-event-map]]()

The machine-readable structural contract is
`Snowknife/Snowknife/schemas/course/sound-index-v1.schema.json`; it contains no
event rows or bank-name data.

The map directory is already the ownership boundary for disc-derived assets.
Keeping the resolver output there makes deletion, provenance, regional
differences, and public-distribution checks follow the WAVs from which the
entries take their meaning.

> [[190-collision-event-map]]() map:"Prop collision audio routing";
> db:prop-collision-sound; doc:../research/extracted-data.md "Prop collision
> sounds from ADL and `BANKS.INF`" — normalized event id → bank scope and
> bank-local slot results, per-level BANK names, and the pinned GARI/MESA
> material exemplars; omitted cases take the silent path. Tooling recovers these
> facts locally into `Audio/SoundIndex.json` rather than distributing the rows.

### Prop collision sounds

The sound a prop makes when the rider hits it is **per-instance** data, kept out
of the instance record. Instances are joined by a **name-hash** sidecar
(`120-objects.md`) to rows of a per-level collision-sound table; a row carries the
collision event id (resolved to a course-bank slot through the remap above) and
an optional set of spatial ambient emitters. An instance with no row makes no
collision sound. [[190-adl]]()

> [[190-adl]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/ADLHandler.cs
> (`HashSound` rows keyed by instance hash → `SoundData.CollisonSound` event id
> + `ExternalSound[]` spatial emitters); runtime gate at entity+0xf4,
> map:"Prop collision audio routing"; db:prop-collision-sound;
> doc:../research/extracted-data.md "Prop collision sounds from ADL and
> `BANKS.INF`".

The sibling `ExternalSounds[]` records are **variable-sized by type**, not one
fixed seven-field structure. All begin with `{type, eventId, offsetX,
offsetY, offsetZ, rangeOrExtent}`; types 0–2 are continuing voices and type 3
uses the alternate non-maintained playback mode. The exact runtime shapes and
falloff functions are in `420-audio-runtime.md`. [[190-adl-external]]()

| Type | Bytes | On-disk fields | Runtime shape |
|---:|---:|---|---|
| 0 | `0x1c` | two ints + `U2..U6` | point + radius + falloff selector |
| 1 | `0x30` | two ints + `U2..U11` | oriented ellipsoid + falloff selector |
| 2 | `0x30` | two ints + `U2..U11` | directional/cone region + two falloffs |
| 3 | `0x18` | two ints + `U2..U5` | point + radius, constant gain / alternate voice mode |

> [[190-adl-external]]() map:"Prop collision audio routing" — record walk at
> `0x0022b994–0x0022b9ec` advances `0x1c/0x30/0x30/0x18` for types 0/1/2/3;
> update branches at `ADL_UpdateExternalSoundsNearListenerCandidate`
> `0x0022b868`; db:audio.

`SoundIndex` is a **global event id**, not necessarily a current-course BNK
slot. Fixed environmental ids in ranges 79–96, 103–147, 159–178, and 183–185
(with dynamic exceptions 95 and 134), plus dynamic id 102, route to the global
group-6 bank dispatcher; crowd ids 97–99 route to Crowd slots 0–2; ordinary ids
use the course-bank resolver. The complete fixed environmental name table and
dynamic exceptions are in `420-audio-runtime.md`. [[190-adl-external-events]]()

> [[190-adl-external-events]]() `AudioSoundEventId_IsSpecialBankCandidate`
> `0x0022e898`; `AudioExternal_LoadSpecialBankCandidate` `0x0022cb40` and
> table `0x003a26a0`; db:audio.

## Board ride audio

The continuous sound of the board on the snow is organized as a **matrix** in the
Board bank: a row per **surface family** (packed snow, powder, loose, ice, metal,
wood, rail, rock, glass, chute) and, within each, a set of **mode** slots
(carve, glide, air-glide, and one-shot transients). A surface type maps to a
family, exactly as it maps to a physical response (`110-terrain.md`,
`310-surface-response.md`), so riding wood sounds like wood. The matrix is
compiled from a config that also names the live input signals (slip, dig, lean,
…) the runtime mixes these by; that mixing is specified in `420-audio-runtime.md`.
[[190-ride]]()

> [[190-ride]]() doc:../research/extracted-data.md "`SNOW.INF` is
> audio, but it reveals runtime signals" — 10 groups (PACK/POWDER/LOOSE/ICE/
> METAL/WOOD/RAIL/ROCK/GLASS/CHUTE) × mode offsets (carve +3, glide +4,
> air-glide +6) in the Board bank, indexed group·8+mode; surface→group map and
> input vars (Slip/Dig/Lean/Board/Bend); map:"Board-snow audio routing"; db:audio.

## Music — intro stems

Each course ships its **intro music** as a set of short **stems**: a quiet tier
and two loud tiers, each of several mutually-distinct phrases of one shared
length, plus a shorter **outro** (about half the tier length). The tiers are
**horizontally re-sequenced**, not layered/mixed together (each loud stem
peaks near full scale, so summing two would clip) — stems are chained end to
end at phrase boundaries, the choice randomized, so authoring intends the
tiers to track intensity but the traced runtime selection is a randomized
draw rather than an intensity read (`430-music-and-announcer.md`). This is
the menu/lead-in music; the in-race music is the graph below, which takes
over when the race starts. The stems are EA-XA-coded streams in the
per-level archive. [[190-stems]]()

> [[190-stems]]() map:"Dynamic race music (EA PathFinder) and the
> announcer" — intro stems loaded by `IntroMusic_LoadLevelBig` 0x00215358 into
> stream group 2, stopped at race start; db:music-system. GARI/Mesa: 16 stems
> (A1–4, B1–4, C1–8, end), A/B/C each 128,291 samples ≈ 5.818 s at 22050 Hz,
> `end` half-length; signal analysis shows horizontal re-sequencing, not
> vertical layering. EA-XA codec (`260-audio-files.md`).

## The interactive in-race music graph

The music that plays **during** a race is an **interactive graph** — one
"PathFinder" song plays per race, and a course names a list of such songs
cycled between races. The data is a triplet: a **graph file** of nodes and
links, a paired **chunk stream** of short audio segments (a bar or a few
bars each), and an async loop bank. Each **node** names an audio chunk (or is
a pure control node) and carries a set of outgoing **links**; each link
carries an inclusive **range** `[min, max]` over a 0–127 control axis and the
next node it leads to — the single runtime control the ranges test is the
**path level**. The link-selection walk, the event table that can inject
jumps, and the specific path-level values gameplay uses are runtime
behavior, specified in `430-music-and-announcer.md`; the graph file's byte
layout is in `270-music-graph.md`. [[190-graph]]()

> [[190-graph]]() map:"Dynamic race music (EA PathFinder) and the
> announcer"; db:music-system — `.mpf` graph + `.mus` EA-XA chunk stream +
> `.bnk`; node header (sample index, track, section, link count) then
> `linkCount` × link `{min s8, max s8, next s16}`; `PATHFINDER_ChooseLink`
> 0x002c0210 picks the first link whose `[min,max]` holds the per-stream path
> level (0–127, set by `PATHFINDER_SetPathLevel` 0x002c2460); event table →
> routers → jumps. Counts: Top Bomb 232 nodes / 202 chunks. Path-level
> values (race/tier/Tricky), event firing, and chunk scheduling are 430's.

## Announcer speech

The MC announcer's voice is a set of **speech banks** organized by **event
category** — takeoff, big air, landing, knockdown, pass, position, combo, and so
on — each bank a file holding many interchangeable **variant** lines for that
event. Lines are coded with the speech codec (MicroTalk). The binding from a
speech event to its bank is itself a **data file**, not hardcoded; and a
**probability table** indexed by event and an "excitement" level decides whether a
given event actually speaks, so the announcer thins out or fires up with the run.
The excitement computation and event routing are runtime behavior
(`430-music-and-announcer.md`). The same speech system carries the rider chatter,
the World-Circuit narrator, and the front-end voices in parallel bank sets.
[[190-speech]]()

> [[190-speech]]() map:"Dynamic race music (EA PathFinder) and the
> announcer"; db:speech-events — `SPEECH.BIG` under `data\speech\` (`mc\`,
> `char\`, `narr\`, `fe\`); per-event `.dat` = N MicroTalk SCHl streams (e.g.
> `Land` 161 variants); event→bank binding in `events.evt` (loader 0x00228268,
> not in the ELF); fire gate `Speech_EventProbabilityGate` 0x00236278 vs table
> 0x003a4798 (event × 10 excitement levels). MicroTalk codec
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/Audio/UtkCodec.cs.

## Crowd chant banks

The crowd's **name chants** — the crowd calling a rider by name — are a bank set
separate from both the announcer speech banks and the crowd cheer/groan patches.
They are bound by a **config file**, not hardcoded: it declares two counts (how
many chant banks each character has, and how many generic chants exist) followed
by the bank paths themselves, in two groups. The per-character group is stored
as a fixed-stride table indexed by **character**, so a character's chants are
addressed by identity rather than by search; the generic group is a flat list.
Retail ships **4 chants per character and 12 generic chants**. Which of the two
groups a placement draws from is a runtime decision (`420-audio-runtime.md`).
[[190-chant]]()

The per-character table's index order is a property of the data, and a tool
reading it must use this order rather than the order the config file happens to
list characters in — the two differ: [[190-chant-order]]()

```text
0 Eddie   1 Kaori   2 Luther    3 Mac      4 Moby     5 Zoe
6 JP      7 Elise   8 Psymon    9 Seeiah  10 Brodi   11 Marisol
```

The table reserves 20 slots per character and 20 generic slots, far more than
the 4 and 12 retail fills, so the counts must be read from the config rather
than assumed. The retail archive also carries a **thirteenth** set of four chant
banks, for a rider identity the shipping config never references; the roster
carries that identity as an alternate display name for the character at index 3.
It is unreferenced data, not a routing rule — and the runtime agrees: the chant
selector pins that same character to the generic set at every race position
(`420-audio-runtime.md`), so the thirteenth set is unreachable by construction,
not merely unlisted. [[190-chant-orphan]]()

> [[190-chant]]() db:audio-crowd-chant; map:"Dynamic group-6 programs (traffic,
> crowd chant)" — `data/config/chant.inf` (`0x0039fc78`), parser `0x0022e1f0`
> writing the config object at `*0x0034490C`: `COUNT`/`CHARCHANTBANKS` →
> `+0x4104` (4), `GENCHANTBANKS` → `+0x4108` (12); per-character paths at `+4`
> as `[12][20][64]`, generic at `+0x3C04` as `[20][64]`; both counts default to
> -1 before parse. 64 `C_*.bnk` members in PAL `AUDIO.BIG`.

> [[190-chant-order]]() indices read directly off the parser's per-character
> store bases (`base = 4 + idx*1280`): `EDDIE` 4, `KAORI` 1284, `LUTHER` 2564,
> `MAC` 3844, `MOBY` 5124, `ZOE` 6404, `JP` 7684, `ELISE` 8964, `PSYMON`
> 10244, `SEEIAH` 11524, `BRODI` 12804, `MARISOL` 14084, generic 15364; key
> format strings `0x003a2b78..0x003a2c00`. A perfect bijection onto 0–11, and
> not `chant.inf`'s own listing order (which starts MAC, MOBY, ELISE, KAORI).

> [[190-chant-orphan]]() `C_Mart01..04.bnk` present in PAL `AUDIO.BIG`, matched
> by no `chant.inf` key; roster table `0x0037ef10` holds 16-byte
> (display, 4-char asset code) records whose index-3 entry is `Marty`/`Mac`.
> Runtime side: the event-102 early-out `0x0022ccf8..0x0022cd04` tests the
> rider row's voice id `+0x64 == 3`, and `CharacterDefTable` `0x003330a8`
> row 3 (`+0x00` = 3, `+0x34` = 3, names `Marty`/`Mac`) is the only source of
> that value — map:"Rider table, character definitions and the rider row".

## Codec families

The audio data uses four codecs; their identities, ids, and use are
specified in `260-audio-files.md`. [[190-codecs]]()

> [[190-codecs]]() codec identities, ids, and byte layouts are
> `260-audio-files.md`'s "Codec ids" and per-codec sections.
