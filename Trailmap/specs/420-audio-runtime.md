# 420 — Audio Runtime

How sounds get chosen, shaped, and placed at run time. The data model —
banks, groups, slots, the per-instance collision-sound rows, the ride-audio
matrix — is `190-audio-data.md`; this chapter specifies the three runtime
paths that consume it: **event-id one-shots** (prop hits), **direct-slot
one-shots** from the logic graph, and the **continuous board-ride
programs** — plus the placed ambient emitters and what "positional" means
for each. Music and speech are `430-music-and-announcer.md`. [[420-overview]]()

> [[420-overview]]() db:audio; db:prop-collision-sound;
> map:"Prop collision audio routing"; map:"Board-snow audio routing".

## Event resolution: two paths, no fallback

A requested sound reaches a bank slot one of two ways: [[420-resolve]]()

- **Event id → (group, slot).** Collision sounds carry an *event id*, which
  one global table remaps to a bank group and a bank-local slot. The default
  group is the level's **course bank**; a handful of ids override to the
  shared **crowd bank**; and table entries with no mapping are
  **authored-silent** — the request simply plays nothing. The same id means
  the same *kind* of sound on every level (the table is global), realized by
  whatever that level's course bank ships in the slot.
- **Direct slot.** A sound node in the logic graph (`150-logic.md` main
  type 8 — fireworks, scripted events) carries a **raw course-bank slot**,
  bypassing the event table entirely. [[420-resolve]]()

Neither path has an empty-slot fallback: a level whose course bank lacks a
referenced slot is silent there, exactly as the data chapter warns
(`190-audio-data.md`). [[420-resolve-vals]]()

> [[420-resolve]]() map:"Prop collision audio routing" — resolver
> `AudioSoundEventId_ToGroupAndSlotCandidate` 0x0022ddb8, slot table
> 0x003a2870 indexed id−2 (ids 2..182), default group 2 (course), ids
> 97–99 → group 3 (crowd) slots 0–2, unmapped entries skip the slot write;
> direct path `SsfSoundPlay_QueueCourseBankSound` 0x00216ac0 hard-codes
> group 2, raw slot. db:prop-collision-sound.

> [[420-resolve-vals]]() map:"SSF effect-graph sound" — no empty-slot
> fallback on either path (the silent Mesa bomb pots,
> `390-pickups-and-race.md`); 77 of the event ids map to course-bank slots,
> doc:../research/extracted-data.md "Prop collision sounds from ADL and
> `BANKS.INF`".

## Prop-hit one-shots

Contact with a prop that has a collision-sound row plays its event-resolved
sound as a **positional 3D one-shot at the prop**, with: [[420-oneshot]]()

- **impact-scaled volume** — the loudness scales with the speed of the hit,
  clamped to the mixer's 0–127 range, so a graze whispers and a full-speed
  hit slams;
- a **listener-range gate** — contacts far from the listener don't enqueue
  a sound at all; and
- a **per-object debounce** — after a hit, further sounds from the *same*
  object are suppressed for ≈ 0.8 s, so a scraping or repeated contact
  doesn't machine-gun. [[420-oneshot]]()

This is the path behind every prop's hit sound — and also behind the
**foliage swish**: tree and bush canopies are pass-through instances
(`370-world-interaction.md`) whose collision rows name leaf-rustle events,
so riding through foliage swishes by the same mechanism that clangs a
fence, just with no physical response attached. [[420-foliage]]()

> [[420-oneshot]]() db:prop-collision-sound —
> `PropCollisionSound_TriggerCandidate` @0x00217148: gate on the instance's
> linked row, range check vs listener, impact scalar from the carried
> velocity clamped 0..127, debounce ring @0x002159d8 registered for the
> current tick + 50 (50/60 s); 3D positional start via the sound-manager
> instance arrays. `370-world-interaction.md` holds the contact-side
> statement.

> [[420-foliage]]() doc:../research/extracted-data.md "Prop collision
> sounds from ADL and `BANKS.INF`" — leaf events: id 7 (tree leaves) and
> 12 (bushy leaves) resolve to course-bank rustle slots (GARI 050/051);
> the canopies are pass-through (movability 0) cutout instances.

## The board-ride programs

The continuous sound of riding — the glide hiss, the carve grind — is not
one-shots but **persistent audio nodes re-evaluated every tick**. Three
nodes run per rider: a **glide** layer, a **carve** layer, and a slip
accent; the glide layer has an alternate, simplified variant selected for
riders without the primary-rider flag (the non-player bed) [inferred]. Each
tick, each node: [[420-ride]]()

1. selects the **surface family** for the surface under the board (the
   ten-family map of `190-audio-data.md` — packed, powder, loose, ice,
   metal, wood, rail, rock, glass, chute), which picks the looped sample
   from the Board bank's family×mode matrix;
2. evaluates that family's authored **expression program** over the live
   ride signals — **slip** (sideways travel), **dig** (edge bite),
   **lean** (carve angle), and two derived blends — producing a **volume**
   and a **pitch bend**; and
3. writes both onto the looping node. [[420-ride]]()

So the ride sound is continuously *performed* by the physics: packed snow's
glide swells with slip and chokes when the edge is buried, powder's carve
follows lean and dig, wood and glass map slip to volume and bend pitch —
each family's response is its program, authored in the same config that
names the matrix (`190-audio-data.md`). [[420-ride-programs]]()

The nodes are **gated by motion state**: the glide and carve layers go
silent while airborne, and the slip accent runs only on the ground — so
leaving the snow cuts the ride bed naturally, with no explicit "stop"
event. A separate **mute flag** can hard-silence the bed during transitions
(mount, reset), and on unmute the volume fades back in over about five
ticks rather than popping. [[420-ride-gates]]()

**Rails are the open edge:** the matrix ships a rail family, but the
terrain-surface mapper never selects it; the grind loop is driven by a
rail-specific path that is not yet traced. [inferred] [[420-rail]]()

### Focused-rider big-air wind

Air does have a wind sound, but it is **rider state**, not course ambience.
`Music_LevelReconcile` gets the music-focus boarder and requires motion state
**1** (air) plus the landing predictor's **total predicted flight time > 1.5
seconds**. That strict gate starts one shared/focused-rider voice at **MAIN
group 0, slot 32**. Landing or leaving the qualifying state stops the voice.
The same driver changes its level through the flight and reconciles the music
level, so this is the wind heard during a large jump rather than an always-on
weather layer. [[420-big-air-wind]]()

The predictor object is built on air-state entry and advanced while airborne;
its exposed result is the predicted total flight, not elapsed airtime. Decoded
`zbxsfx/032` is mono 16 kHz, 95,760 samples (5.985 s), with bank loop tags
`0x86=2436` and `0x87=95688`. It is broadband wind. [[420-big-air-wind]]()

The neighboring BOARD-family transients are also state-owned: primary-rider
air entry plays `family·8 + 2`, and primary-rider landing/contact plays
`family·8 + 1` (`+5` is the alternate/non-primary landing variant).
[[420-big-air-wind]]()

> [[420-ride]]() map:"Board-snow audio routing"; db:audio — per-rider
> node setup builds the slip/glide/carve nodes; sample slot = family·8 +
> mode (carve +3, glide +4, alternate glide +6); family from
> `SnowAudio_SurfaceTypeToGroup`; signals `Slip`/`Dig`/`Lean` read from
> boarder fields, `Board` = Slip/4 + Dig·2, `Bend` = Board + Slip,
> doc:../research/extracted-data.md "`SNOW.INF` is audio, but it reveals
> runtime signals".

> [[420-ride-programs]]() doc:../research/extracted-data.md — the
> config's per-family GLIDE/AIGLIDE/CARVE scripts compile to bytecode
> evaluated per tick into volume + bend; family behaviors as summarized
> there (PACK/ICE/CHUTE/ROCK/METAL slip+dig-driven glide; POWDER/LOOSE
> carve from lean+dig; WOOD/RAIL/GLASS slip volume + bend pitch).

> [[420-ride-gates]]() map:"Board-snow audio routing" — glide/carve
> callbacks skip motion state 1 (air), the slip accent runs only in state
> 2 (ground), the alternate-glide variant evaluates in states 2/3; mute
> flag + 5-tick fade-back divider (volume ÷ counter while it decrements).
> The alternate-glide node (slot +6) is selected for riders without the
> primary flag — reading: the simplified bed for non-player riders.
> [inferred]

> [[420-rail]]() map:"Board-snow audio routing" — the RAIL family is
> compiled from the config but `SnowAudio_SurfaceTypeToGroup` never
> returns it for terrain contact. Open lead: trace the rail-slide sound
> node (`350-rails.md`).

> [[420-big-air-wind]]() `Music_LevelReconcile` `0x0021bd20` gets the
> focused rider via `0x0020f218`, tests boarder motion state `+0x424 == 1`
> and landing-predictor total `boarder+0x57b0,+0x44 > 1.5`, then calls the
> sole start path `0x0020fb28` for group 0 / slot 32; `0x0020fdb8` stops
> it. Predictor construction is `0x00123b18`, called from air entry
> `0x00108310`; `0x00123ed0` advances it. Decoded PAL `zbxsfx` slot 032
> measurements and BNKl loop tags as stated above. Board transition calls
> at the same air/contact state edges select family offsets +2 / +1 (+5
> alternate).

## Placed ambience

Besides its collision row, an instance's sound data can carry **ambient
emitter records** attached at world positions. The runtime builds a separate
**spatial grid**, visits only the listener's nearby cell, and dispatches four
variable-sized record types: [[420-ambient]]()

| Type | Voice | Listener region / gain |
|---:|---|---|
| 0 | continuing | point at `entityPosition + (U2,U3,U4)`; active for `distance < U5`; gain = curve `U6` at `distance/U5` |
| 1 | continuing | oriented ellipsoid centered at the same offset; half-extents `U5..U7`, orientation axis `U8..U10`, curve selector `U11` |
| 2 | continuing | radial range plus a directional/cone gate; one curve shapes radial distance and a second shapes the angular term |
| 3 | alternate mode | point + radius like type 0, but constant gain `1.0` and the sound-manager's non-maintained flag (likely a triggered/one-shot emitter) [inferred] |

Type 0's falloff helper has six exact choices for normalized distance `d`:
[[420-ambient-curves]]()

| `U6` | Gain |
|---:|---|
| 0 | `1 − d²` |
| 1 | `1 − d / (1.5 − 0.5d)` |
| 2 | `1 − d` |
| 3 | `(1 − d) / (1.5 − 0.5(1 − d))` |
| 4 | `(1 − d)²` |
| 5 | `1` through `d=0.7`, then `(1 − d) / 0.3` |

### Event routing and global environmental banks

External records still carry a **global event id**, but that id has three traced
routes. `AudioSoundEventId_ToGroupAndSlotCandidate` first calls the special-bank
classifier; the following ids bypass the normal course-bank table and resolve
to **group 6 / slot 0**: [[420-ambient-banks]]()

```text
79..96, 102, 103..147, 159..178, 183..185
```

The external-voice path then calls `AudioExternal_LoadSpecialBankCandidate`,
whose 107-entry table dispatches `eventId - 79`. Fixed cases load one named global BNKl
from `DATA/AUDIO/AUDIO.BIG`; these are not slots in the current course's `BANK`.
The reviewed event-to-name data lives once in
`specs/data/external-sound-banks-v1.json`; Slopesmith, Snowknife, and the live
audio probe use generated views. Its values are short executable/file
identifiers, not player-facing or narrative strings. Keeping them available is
required for complete offline extraction and routing.

Three group-6 ids are not fixed-name programs; they choose their bank at
resolve time. Group-2 events outside the ranges above still use the normal
event→course-bank-slot table described earlier. [[420-ambient-dynamic]]()

### No per-course flat wind bed

Retail does **not** select one background bank per map. `BANKS.INF` lists
`Wind1.bnk` and `Wind2.bnk` under `SWAP` in every course section, along with
the same large candidate list; the parser only registers those names for
on-demand loading. The only code reference to the `Wind1` string is the
fixed external-event dispatcher (event **116**), beside `Wind2` (event
**117**), reached through the placed-voice start/update path. Neither string
has a course-load caller. [[420-no-flat-bed]]()

The complete eleven-course `Sounds.ExternalSounds` census places **zero**
event-116 and **zero** event-117 records. Thus the shipped background model is
the listener moving through the positional emitters described here, plus the
rider/board near-field bed, the predicted-big-air MAIN/032 wind above, and race
music—not an always-on Wind1/Wind2 track. An authentic map importer must not
infer a flat bed from either bank's availability. [[420-no-flat-bed]]()

OpenSlope's optional silence filler does not revise that finding. It is explicit port policy, declared as
`Maps/<LEVEL>/Audio/Environment.json`, and is used only while the local player is off-board, in preference to
intro music stems. Snowknife currently writes `Wind1/000` at gain `0.15` for retail extracts; an
authored map may select another declared bed or write `Bed: null`. Consumers must read that contract and must
not fall back to event 116/117, `SWAP` membership, snowfall, or a placed-emitter census when it is absent.
[[420-openslope-environment-filler]]()

> [[420-openslope-environment-filler]]() Port policy, not retail evidence: the
> eleven-course census behind [[420-no-flat-bed]]()
> (zero event-116/117 `ExternalSounds` records; `Wind1`/`Wind2` reachable only
> through the fixed dispatcher cases at `0x0022cfb4`/`0x0022cfc4`) is what the
> filler must not be mistaken for. The declared contract lives with the port's
> importer, outside this spec's sources.

Ids **95** and **134** are two independent traffic channels. Each selects
between `Trafficloop` and `Traffic_Loop2` from its own flag, and the two flags
are otherwise unrelated — the same clip pair, addressable twice. Both are
initialized to the first variant, and nothing in the retail build ever clears
either one, so in practice both ids always resolve to `Trafficloop` and
`Traffic_Loop2` is unreachable. A tool should map both ids to `Trafficloop` and
treat the second clip as unused archive data rather than inventing a switching
condition. [[420-traffic]]()

Id **102** is the **crowd chant**: the crowd calling a rider by name. It
resolves only when the emitter's viewport is following the rider that the music
and announcer track, so at most one rider's chant is live at a time and a
placement no viewport is watching stays silent. When it does resolve, the bank
comes from one of two sets — chants specific to that rider's character, or
generic crowd chants — chosen by the rider's current race position: **first
place always draws a character chant; second and third are a near-even coin
flip (50 in 101); fourth or lower always draws a generic chant**. One rider is
additionally pinned to the generic set at every position: **Mac**, the one
roster character whose own chant banks ship on disc without a chant-configuration
entry (`190-audio-data.md`) — his name is never chanted even in first place. The
test is on the rider's voice identity, which is filled from the same character
definition as the chant-table index and is equal to it for every shipped
character, so the two identities cannot diverge outside the hidden
character cheat, which sets a voice identity no character owns. The pick
within the selected set is uniform. The audible effect is that the crowd chants
your name while you are winning and falls back to generic cheering once you are
not. [[420-chant-select]]()

### Interactive ambient emitters (hit-gated loops)

Three ordinary group-2 events form an **interactive class**: **16**, **28**, and
**57** — placed in retail only on cars, fire hydrants, and police cars
respectively. A placed emitter with one of these events is **silent until the
rider first hits its owning instance**, and is then enabled permanently:
nothing disables it again short of a full audio reset, so a burst hydrant
sprays (and a struck car alarms, and a struck police car wails) for the rest of
the run. The enablement is **per-instance** — hitting one hydrant does not
start its neighbours — and the class membership is engine-fixed, not data:
every other placed event, including the floodlight hum (68), plays on listener
proximity alone. [[420-interactive-ambient]]()

What opens the gate is the **impact itself, not the impact sound**. A prop
enables its emitter on being hit even when the collision produces no audible
one-shot at all, so the trigger cannot be described as "its collision sound
plays". Retail depends on that distinction rather than merely tolerating it:
**every one of the 22 fire hydrants carries the silent collision sentinel**, so
a rule keyed on an audible impact would predict hydrants that never spray,
which contradicts both the shipped audio and direct observation. A struck
hydrant is therefore heard as the spray alone, while a struck police car is
heard as its ordinary body-impact one-shot *and* the siren starting together.
A tool must run the enablement off the contact, before and independently of
resolving that prop's own collision event to a clip.
[[420-interactive-gate]]()

> [[420-interactive-ambient]]() db:audio-interactive-ambient; empirically
> confirmed against retail (idle hydrants silent; burst sprays indefinitely).
> Classifier `AudioEventId_IsInteractiveAmbientClass` `0x0022e750` ({16,28,57});
> membership test `AudioConfig_IsEntityInteractiveEnabled` `0x0022e780`
> (registry `config+0x410c`, count `+0x442c`, cache `+0x4434`/`+0x4438`);
> gate applied in the lazy voice start `AudioExternal_StartOrUpdateVoiceSlot`
> `0x0022c458`; registration `AudioConfig_RegisterInteractiveEntity`
> `0x0022e7e0`, sole caller `0x0022da78` in
> `Audio_PlayResolvedSoundEvent3DCandidate` guarded by
> `AudioEntity_HasInteractiveAmbientRecord` `0x0022e6c8`. Census: event 16 on
> 21 car instances, 28 on 22 hydrants, 57 on 10 police cars.

> [[420-interactive-gate]]() db:audio-interactive-ambient. Within
> `Audio_PlayResolvedSoundEvent3DCandidate` `0x0022da18` the registration call
> at `+0x0060` precedes the event→group/slot resolve at `+0x007c` and its
> unresolvable-event bail-out at `+0x0084`, so an entity registers whether or
> not the event it was called with yields a voice; the only skips ahead of it
> are a null entity and the `config+0x4430` repeat-entity cache. Data: in
> `MERQUER/Instances.json` all 22 `Mdl_FireHyDrant_Base_*` carry
> `CollisonSound` 0 — absent from `SoundIndex.json`, hence silent — alongside
> their event-28 record, while the 21 cars and 10 police cars carry
> `CollisonSound` 11 (`merqurycity1/033.wav`). Event→clip for the class:
> 16→`035.wav`, 28→`024.wav`, 57→`036.wav`; those three plus the floodlight's
> 38 are the only `merqurycity1` slots Snowknife emits a `.loop.wav` region
> for. Empirically confirmed against retail: hitting a hydrant plays `024.wav`
> with no other impact sound, hitting a police car plays `036.wav` alongside
> its body one-shot.

The fixed environmental banks carry one slot-0 program in the observed set, and
the maintained type-0 voice loops it. BNKl patches `0x86`/`0x87` are loop
start/end: for example `Coyote.bnk` is mono 22.05 kHz, 149,239 samples
(6.77 s), loop `0..149239`. Thus a Coyote placement is a spatial maintained
loop, not an intermittently scheduled one-shot. [[420-ambient-loop]]()

### Retail census

The five extracted retail courses contain **331** records: 328 type 0, three
type 1, and no type 2/3. The three type-1 records belong to a floodlight, a
highway module, and the subway train—not crowds. The 328 type-0 records divide
into 153 Crowd events (97–99), 53 normal group-2 events, 109 fixed group-6
environment events, and 13 dynamic event-102 records. Crowd routes to group 3
slots 0–2; every crowd record uses curve 2 (linear), with radii 65.25–148.5 m.

Across **all eleven** retail courses the three dynamic ids are placed very
unevenly. The chant is common: **20** records, spread over eight courses and
absent only from the three with little or no ambient emitter content at all.
Every chant record is a point emitter; most use the linear curve but not all,
and radii run 38–141 m, so a reader must take the curve and radius from the
record rather than assuming the crowd defaults. Traffic is the opposite —
id **134** is placed **exactly once in the entire game**, in Merqury City, and
that one placement is an oriented ellipsoid (the highway module) rather than a
point. Id **95** is placed **nowhere**: it is a live dispatcher entry with no
authored use in retail. [[420-dynamic-census]]()

The executable's fixed dispatcher names 84 banks, but the PAL retail
`AUDIO.BIG` examined here omits 16 of them: `TV1` through `TV4`, `Penguins`,
`Bird_Crows2`, `Bird_Crows3`, `Bird_Eagle2`, `Bird_Eagle3`, `Alleyway_4`
through `Alleyway_8`, `Magnetic_Turbo_Donut`, and
`Super_Conducting_Collider`. None is referenced by the five extracted courses.
This is an archive/version fact, not a second routing rule: a tool should keep
the ELF mapping, but report a missing referenced bank rather than substitute a
different sound. [[420-ambient-archive]]()

SNOW specifically has 27 crowd records, 27 fixed environmental records, and two
dynamic event-102 records. Its five event-115 placements resolve to
`Coyote.bnk`; the literal event-118 `Wolf .bnk` exists in `AUDIO.BIG` but SNOW
does not place event 118. [[420-ambient-census]]()

> [[420-ambient]]() map:"Prop collision audio routing" — grid build/insert
> `0x0022abd0` / `0x0022b500`, type dispatcher and region math
> `ADL_UpdateExternalSoundsNearListenerCandidate` `0x0022b868`; types 0–2
> call `0x0022d770` with `t1=1`, type 3 with `t1=0`.

> [[420-ambient-curves]]() `AudioExternal_EvaluateFalloffCurveCandidate`
> `0x0022c138`, jump table `0x003a1bc0`, cases `0x0022c168` through
> `0x0022c204`.

> [[420-ambient-banks]]() `AudioSoundEventId_IsSpecialBankCandidate`
> `0x0022e898`; group/slot write at `0x0022dde4..0x0022ddec`;
> `AudioExternal_LoadSpecialBankCandidate` `0x0022cb40`, jump table
> `0x003a26a0`, fixed bank strings `0x003a1c98..0x003a2680`.

> [[420-ambient-dynamic]]() event-95 case `0x0022cc84`, event-102 case
> `0x0022ccc4`, event-134 case `0x0022d114`.

> [[420-no-flat-bed]]() `AudioBanks_ParseLevelBankMapCandidate` `0x00211590`,
> `SWAP` store `0x00211a64..0x00211ab8`; `Wind1` string `0x003a2030` has its
> sole code ref at `0x0022cfb4`, `Wind2` at `0x0022cfc4`, both inside
> `AudioExternal_LoadSpecialBankCandidate` `0x0022cb40`. That loader's sole
> incoming call is `0x0022c6b8` in `AudioExternal_StartOrUpdateVoiceSlot`;
> maintained voices are upserted only from
> `ADL_UpdateExternalSoundsNearListenerCandidate`. Full 11-course census:
> events 116/117 = 0/0.

> [[420-traffic]]() db:audio-dynamic-traffic; map:"Dynamic group-6 programs
> (traffic, crowd chant)" — both cases test one flag in the chant/audio config
> object (`*0x0034490C` `+0x4440` for 95, `+0x4444` for 134) and copy either
> `0x003a1e68` `Trafficloop` or `0x003a1e88` `Traffic_Loop2`. Exhaustive
> `.text` immediate scan for `0x4440`/`0x4444`: the only writers are the ctor
> `0x0022d5ec`/`0x0022d5fc` and the reset `0x0022e87c`/`0x0022e890`, both
> storing 1; `0x0015de1c` (28-byte-stride array) and `0x001dc4cc`
> (`lui 0x0039` constant `0x00394440`) are false positives. Both clips exist
> in PAL `AUDIO.BIG`.

> [[420-chant-select]]() db:audio-crowd-chant; map:"Dynamic group-6 programs
> (traffic, crowd chant)" — case `0x0022ccc4`. Viewport gate: emitter `+0x3c`
> indexes the view manager (`*0x00338E58` `+0x730`, 128-byte stride), `+0xa4`
> is that viewport's boarder, compared against
> `Audio_GetMusicFocusBoarder(mgr,-1)` `0x0020f218`; mismatch returns 0. Race
> position is `boarder+0x110` (1-based; written by `Race_StandingsPass+0x244`
> `0x00115344`, and mapped to a 0–99 level by `SoundManager_UpdateLevels`
> `0x0020f568` as `99-(v-1)*99/(numRiders-1)`). Thresholds `<2`, `<4`, else;
> coin flip `(rnd&0x7fff)*101/32767 < 50`; uniform pick
> `(rnd&0x7fff)*N/32767`. The always-generic identity is
> `riderRow(boarder+0x464)+0x64 == 3` at `0x0022ccf8..0x0022cd04`; `+0x64` is
> the **voice id**, written by `RiderRow_InitHuman` `0x0016a9f0` (`lbu` at
> `0x0016aab8`), `RiderRow_InitAI` `0x0016ae80` (`0x0016af78`) and the
> front-end re-apply `0x00266748` (`0x00266850`) from `CharacterDefTable`
> `0x003330a8` (12 × 56 B) field `+0x34`, while the chant index `+0x38` comes
> from the same row's `+0x00`; on disc `+0x34 == +0x00` = 0..11 for all twelve
> rows, so 3 = Mac (row 3 name pointers `Marty`/`Mac`). The only out-of-range
> voice id is 12 (`0x0016ac10`, when `row+0x80 != 2` under the character-0
> cheat `0x003364b8`), matching the speech bounds check `sltiu ...,12` at
> `0x00234bb0`. map:"Rider table, character definitions and the rider row".

> [[420-dynamic-census]]() db:audio-dynamic-traffic; full-coverage census over
> all 11 retail course archives — the five standing `Maps/` extractions plus
> `ALASKA`, `ALOHA`, `MEGAPLE`, `PIPE`, `TRICK`, `UNTRACK` extracted from
> `ssx-tricky.iso` for this pass. Event 102 = 20 records (ELYSIUM 4, MERQUER 3,
> ALASKA 3, ALOHA 3, GARI 2, MESA 2, SNOW 2, MEGAPLE 1; none in PIPE/TRICK/
> UNTRACK), all `U0=0`, curve `U6` 2×16 / 3×2 / 0×2, radius `U5`
> 3800–14100 (38–141 m). Event 134 = 1 record, `MERQUER Instances[3743]`,
> `U0=1`. Event 95 = 0 records. PIPE/TRICK/UNTRACK are genuine zeroes, not
> failed extractions: they carry 429/562/1113 instances with `Sounds` blocks
> but 0/0/11 external records.

> [[420-ambient-loop]]() `Coyote.bnk` decoded from retail `AUDIO.BIG`;
> BNKl patch tags `0x86`/`0x87`; maintained voice flag at type-0 call into
> `AudioExternal_UpsertVoiceCandidate` `0x0022d770`.

> [[420-ambient-census]]() census of
> `Maps/{GARI,MESA,ELYSIUM,MERQUER,SNOW}/Instances.json`; event resolver
> `AudioSoundEventId_ToGroupAndSlotCandidate` `0x0022ddb8`; special classifier
> and loader above; ids 97/98/99 route to group 3 slots 0/1/2.

> [[420-ambient-archive]]() PAL `DATA/AUDIO/AUDIO.BIG` member-name census
> compared with the 84 fixed cases in the loader jump table; five-course
> `Instances.json` census above; db:audio.

## Spatialization expectations

For parity: prop one-shots and placed ambience are **positional** (3D
attenuated from their world location); the board-ride bed and the rider's
own effects follow the listener and read as **near-field**, not
distance-attenuated; music and announcer speech are **flat** (no
spatialization — `430-music-and-announcer.md`). The original's exact
placed-emitter attenuation curves are pinned above; prop-hit one-shot distance
shaping remains a tuning edge. [[420-spatial]]()

> [[420-spatial]]() db:audio; map:"Prop collision audio routing" —
> categorization from the traced paths (3D positional start for collision
> one-shots, listener-gated grid for ambience, per-rider continuous nodes).
