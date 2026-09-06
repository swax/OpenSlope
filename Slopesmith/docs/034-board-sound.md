# 034 — Board sound

The sound of riding, in Test mode: the **glide** hiss and **carve** grind under the board, the scrape of a
rail, the ollie pop and the landing thud, the wind during a predicted big jump, the gem chime and pad hit, and the roar while boost is held. It is
performed from the game's own shared banks, so a mountain you are building sounds like a mountain the game
shipped — powder is soft, ice is thin and bright, the wood bridge deck knocks, and a surface you paint is a
surface you hear.

Retail runs the ride bed as **persistent audio nodes re-evaluated every tick**, not as one-shots: the surface
under the board picks a family row out of the Board bank, and that family's authored program turns the live
ride signals into a volume and a pitch bend, written onto the looping node
[Trailmap: 190-audio-data, 420-audio-runtime]. Slopesmith performs the same two layers off the same bank, from
the same surface map, with the signal→loudness shape the Unity board uses (Unity docs/015 — the two ports
are deliberately the same sound).

## Where the sound comes from

The board banks are **level-independent**: `zboard` (the ride matrix and its transients) and `zbxsfx` (the
main SFX bank, including big-air wind 032 and the boost roar) are staged by `snowknife shared` under
`Maps/Shared/Audio/SFX` and may also exist beneath older per-level extractions. The editor resolves either
layout, so an authored mountain does not need map-specific audio metadata. With no extracted shared banks, a
test ride is simply silent and the Sound panel says so.

- `GET /api/board-audio` → `{board, boost}`, naming the levels that supply each bank (`null` = not extracted).
- `GET /api/board-sound?slot=4[&bank=zboard|zbxsfx][&loop=1]` → that slot's WAV. `loop=1` prefers the sibling
  `NNN.loop.wav` Snowknife emits from the BNKl loop region — the clean sustain a continuously performed layer
  wants — and falls back to the complete WAV for slots that ship no loop region. The transients ask for the
  complete WAV on purpose: a pop is its attack.

Only those two banks are reachable through the route; course banks stay behind the level-scoped
`/api/effect-sound` that prop hits and SSF `PlaySound` nodes use ([026](026-effects-editor.md),
[027](027-reference-effects.md)).

## The family matrix

Ten surface families, each a row of mode slots at `family·8 + mode` — carve `+3`, glide `+4`, air-glide `+6`
(`core/audio/board-sound.ts`):

| Family | carve | glide | Rides |
|---|---:|---:|---|
| PACK | 003 | 004 | standard snow, sand, the no-trail ice/water types |
| POWDER | 011 | 012 | powder, slow powder, and the reset/out-of-bounds type |
| LOOSE | 019 | 020 | standard off-track |
| ICE | 027 | 028 | ice, bounce/unskiable |
| METAL | 035 | 036 | off-track metal |
| WOOD | 043 | 044 | the bridge-deck planks (SurfaceType 12) |
| RAIL | 051 | 052 | grinding (see below) |
| ROCK | 059 | 060 | rock, wall, ice-crunch |
| GLASS | 067 | 068 | the speed/grinding surface |
| CHUTE | 075 | 076 | show-off ramp / metal |

The SurfaceType → family map is read from `Maps/Shared/Audio/BoardSoundIndex.json`. `snowknife shared`
generates that sidecar by interpreting the user's boot executable (`SnowAudio_SurfaceTypeToGroup`), and that
sidecar is what the ride consumes. A twenty-entry fallback legend IS checked in, at
`src/core/reference/surface-types.ts`, so the editor can label and sound a surface before any disc has been
imported; it names each type and its audio family. Missing metadata and out-of-range types use the neutral
PACK fallback.

**Rails are the open edge.** The bank ships a RAIL row but the terrain mapper never returns it — retail
selects the grind loop through a rail-specific path that is not traced [Trailmap: 420-audio-runtime]. The
grind layer here reaches for that row directly whenever the board is locked to a rail, which is a reading of
the bank's own layout rather than a traced behavior.

## How the layers are performed

Every frame, from the **tick** state (not the interpolated render pose — that would smear the edges the
transients are found on):

- **glide and carve use OpenSlope's authored response** (`boardBedFrame`,
  `core/audio/board-sound.ts`) over the independently measured interface signals: lateral Slip and absolute
  Lean, plus the ride's normalized speed. A smooth speed envelope opens the bed; the stronger of skid and
  lean hands energy from glide to carve; broad firm/soft/hard-surface families alter that balance. Pitch
  follows skid and lean over an authored span (response 1.0 → rate 1.5). This preserves the live-signal and
  bank-row interface without shipping the retail `SNOW.INF` expression sequence;
- both ground loops go **silent in the air** — exactly as
  retail's motion-state gate does — and silent on a rail, where the grind layer takes over at the rail
  family's own loop, riding speed;
- loop attacks slew at **20/s** (35 ms to the big-air target, at most 50 ms to full scale) while releases stay
  at 6/s; both are written as ramps across the frame, keeping physical edges responsive without clicks;
- the **ollie** fires on the launch edge at a level set by the charge that fed it; the **landing thud** fires
  on the touchdown edge, scaled by the arriving into-surface speed against an 18 m/s slam (measured from the
  last airborne velocity: by the time the state is readable the contact model has already answered the
  impact);
- **boost** punches to full for 0.6 s on the engage edge, decays to half while it thrusts, then fades out and
  stops on release. The clips are flat, near-constant roars, so that envelope *is* the sound — the same shape
  the Unity board reconstructs, and for the same reason: the voice-volume code behind the heard fade is not
  traced.

Pausing a ride fades the bed out without disturbing the edge trackers, so it picks up where it left off.
Everything is 2D and local to the player's board: this is the deck under the rider's own feet, not a source
out in the world. It connects to the editor's one page-lifetime, interactive-latency `AudioContext`, shared
with the effects layer's positional listener. The AI field is silent.

The same page-lifetime cache owns every decoded board, prop, effect and placed-ambience buffer. Board clips
begin loading on entry to Test (and are requested again harmlessly from the cache at ride construction);
prop/effect/ambience clips begin loading when their source data arrives. Stop → Play therefore reuses the
warm device and `AudioBuffer`s. Gameplay edges only create and start a source—they do not initiate file I/O
or decoding. A browser/device output buffer remains, but Slopesmith no longer adds a cold-context or
cold-fetch delay to it.

## Game-event cues (gems and pads)

**A gem chime is not part of the gem's effect.** The gem's collision graph carries only
`[MainType 14 score][MainType 2 sparkle burst][MainType 0 Sub 5 dead-node kill]` — no sound node. The chime is
played by engine code at the tail of the multiplier apply, as a direct slot in the **MAIN** bank (`zbxsfx`,
sound group 0), gated to the local human rider and bypassing the prop-collision event-id resolver entirely.
Boost and trick pads work the same way, from the same hub (`BoarderState_GameEventToAudio`)
[Trailmap: 390-pickups-and-race "Scoring sounds", 420-audio-runtime]:

| Cue | MAIN slot | Fired by |
|---|---:|---|
| gem ×2 / ×3 / ×5 | 116 / 117 / 118 | MainType 14, tier by the multiplier **value** (≥3 → 117, ≥5 → 118) |
| speed pad | 115 | MainType 17 |
| trick pad | 114 | MainType 18 |
| held boost | 120 / 121 / 122 by meter | the boost engage (no meter here → the full-meter clip) |

So the test ride plays them where the *gameplay* lands — `TestRide.applyEffect`, the same switch that applies
the multiplier and the pad boost — not in the effects runtime, which plays what the graph itself authored
(`MainType 8 SoundPlay` direct slots and prop-hit event ids; [026](026-effects-editor.md),
[027](027-reference-effects.md)). Slopesmith's **directional-boost** property stays silent: no sound is traced
on it. Scoring's other feedback — clean landing and bail — is per-character **voice**, not a numbered SFX
slot, and is out of scope here along with the announcer.

Re-fire is already governed upstream: collision graphs carry the retail per-object debounce and trigger
volumes fire on the enter edge, so leaning on a pad doesn't machine-gun the cue.

## The mix (Scene ▸ Sound ▸ `<mountain name>`)

The mountain carries a `boardSound` mix — on/off, master **volume**, and four trims: **glide**, **carve**,
**transients** (the board's own one-shots: ollie, landing, grind) and **cues** (the rider-owned MAIN-bank audio:
big-air wind, gem chime, pads, held boost). The two trims are split the way the game splits the banks, so the
gameplay feedback can sit above or below the board without touching the bed. The layer *levels* are performed
by the ride from the surface and the ride signals, so what is authored here is the balance between them, not
their loudness curve. A document with no mix rides with sound on at the default balance, so old saves gain the
bed without an edit — and a mix saved before the cue trim existed picks up its default the same way.

**▶ hear base surface** auditions the glide loop of whichever family the mountain's base ride feel maps to,
and the panel names that family — the fastest way to check that "base ride feel: powder" sounds like powder
before riding down to find out.

Scene ▸ Sound ▸ Reference also exposes **big-air wind** as `zbxsfx 032`, its recovered
`predicted flight > 1.5 s` trigger, and a looped preview. It remains visible without a loaded reference because
the cue is shared rider audio; placing it beneath Reference documents the recovered game behaviour without
misrepresenting it as authored per-map ambience.

## Ported, and not ported

- The per-family **retail board-sound expressions are not shipped**. `audio_signals.py` keeps AUTOTEST4 as a
  measurement of the Slip/Dig/Lean operating ranges but emits no program outputs.
  `tools/ride-study/board-bed-study.ts` feeds the measured Slip/Lean/speed samples through OpenSlope's
  authored curve so it can be tuned against real riding ranges without carrying a parity transcription.
  The retail node's exact loudness, pitch and post-carve recovery therefore remain intentionally out of
  scope; the authored curve aims for a clear clean-glide → skid/carve handoff instead of output identity.
- The **air-glide** slot (`+6`) is unused. It is retail's simplified bed for riders without the primary flag,
  and this ride has exactly one board — the player's.
- The **ollie and landing transients** use the traced primary-rider bindings: BOARD family `+2` on air-state
  entry and `+1` on landing/contact (`+5` is the alternate/non-primary landing).
- The **big-air wind** is MAIN slot 32, started only while airborne when the takeoff landing predictor reports
  a total flight strictly over 1.5 seconds. It stops on landing. This is rider-owned 2D audio—not a Wind1/Wind2
  background bed or a weather effect. The recovered clip, ownership and gate are exact; its local mix level
  uses the normal OpenSlope fade because the retail per-flight volume curve is not decoded yet.
- Retail's **mute flag and its five-tick fade-back** are not modelled; the pause fade covers the same ground
  for an editor playtest.
- The **held-boost cue** is reconstructed, not literal: retail fires slot 120/121/122 as a one-shot on the
  engage frame and never re-fires while held, but the clips are flat ~1.12 s roars and the real game audibly
  fades on release, which a flat one-shot cannot do without external voice-volume control that isn't traced.
  This loops the clip under a punch→sustain→release envelope instead — the same reconstruction, for the same
  reason, as the Unity board (Unity docs/015).
- Board sound is a **test-ride** subsystem. It is not part of the export: an exported mountain gets its board
  bed from the game, which ships these banks already.

## Code

`core/audio/board-sound.ts` (the family map, the slot arithmetic, the big-air/cue slots, the authored mix and its
normalization), `app/audio/runtime.ts` (the shared context and page-lifetime decoded-buffer cache),
`app/ride/board-audio.ts` (the performance: layers, transients, big-air wind, cues and boost envelope),
`app/ride/session.ts` (built at ▶ Play, stepped after the camera, cues handed over from
`applyEffect`, disposed at Stop), `server/routes/audio.ts` (the shared-bank reader) and the two routes in
`server/api/levels.ts`.

`npx tsx test/board-sound.test.ts && npx tsx test/board-audio.test.ts` holds the parts that can be asserted offline. `test/board-sound.test.ts` covers
the data and the route: the complete surface→family table against the traced map, the slot arithmetic against
the decoded bank layout, the project-authored response invariants over synthetic clean/skid/crawl inputs,
the big-air gate, cue slots and the chime's value thresholds, the mix's clamping/defaulting
and its document round trip, and the bank reader's loop-region preference, one-shot behavior, and refusal of
non-board banks. `tools/ride-study/board-bed-study.ts` is the tuning report: point it at any AUTOTEST4 run to
see measured inputs beside the authored response. `test/board-audio.test.ts` drives the performance itself over a synthetic run against a stubbed Web
Audio graph — the row a surface selects and the swap when it changes, the rail hand-off replacing the snow
bed, both layers opening on a fast carve and closing on a crawl, the ground bed cutting in the air, MAIN/032
starting only above the predicted-flight threshold and stopping on landing, the ollie firing once on its edge,
a hard landing thudding where a drift-down doesn't, the boost roar looping from the
other bank and stopping on release, and each cue reaching its own slot on its own trim. What the loops sound
like against a real mountain is a listen test.

## See also

[016 — Test ride](016-ride.md) (the ride the bed is performed from),
[031 — Custom Race Music Packing](031-custom-race-music.md) (the other half of the Sound panel),
[026 — Effects Editor](026-effects-editor.md) (prop hits and `PlaySound` nodes, which use the course banks),
Unity `docs/015-audio-runtime.md` (the Unity board's own bed), and
[Trailmap: 190-audio-data, 420-audio-runtime].
