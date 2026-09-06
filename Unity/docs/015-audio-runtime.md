# 015 — Audio runtime

How decoded WAV assets become music, spatial ambience, impacts, footsteps, and ride-driven audio in
Unity. Container parsing, codecs, extraction commands, and decode validation belong to
[Snowknife 015 — Audio extraction](../../Snowknife/docs/015-audio-extraction.md); retail behavior is
specified by `[Trailmap: 190-audio-data, 260-audio-files, 420-audio-runtime]`.

Code: `Importer/Editor/AudioBuilder.cs`,
`VRC/Editor/SurfaceAudioSetup.cs`,
`VRC/Editor/VrcWiring.cs`, and the audio behaviors under `VRC/World/`.

## Asset contract

`snowknife unity` stages decoded clips under `Assets/OpenSlope/Maps/<LEVEL>/Audio/{Music,SFX}` and the shared
board/announcer assets under `Assets/OpenSlope/Maps/Shared`. The bundle manifest names the course bank and
describes placed loops with their source path, kind, position, range, falloff, and optional hit gate.
The importer consumes that contract; it does not infer archive membership or reinterpret native event IDs.

Looping consumers prefer a sibling `NNN.loop.wav` when Snowknife emitted one from the BNKl loop region.
One-shot consumers keep using the complete `NNN.wav`, including its attack.

## Native spatial sources

`AudioBuilder`, run by `OpenSlope/Load/Map...` and `OpenSlope/Refresh/Audio`, creates stock Unity
`AudioSource`s under `OpenSlope_Map/Audio`. Every spatial source carries a `SpatialAudio` marker so the
VRChat wiring pass adds and configures `VRCSpatialAudioSource`; otherwise VRChat's default 40 m far
distance can replace the authored rolloff and mute distant sources.

- **Crowds** use native ADL `ExternalSounds` events 97–99 when present, preserving the instance-relative
  offset, Crowd slot, range, and falloff. Geometry clustering remains a fallback for older or authored maps.
- **Environment emitters** cover birds, animals, machinery, water, city beds, and other fixed global-bank
  programs. The bundle carries the resolved `Audio/SFX/<bank>/000.wav` path instead of asking Unity to
  reproduce the retail bank dispatcher.
- **Type-1 regions** are oriented ellipsoids in the source data. The point-source runtime uses their
  volume-equivalent sphere, avoiding the very large false audible area produced by taking the longest axis.
- **Flat beds** are not inferred from bank availability. Unity has no map-background clip/configuration path:
  native ambience comes only from placed `ExternalSounds`, and big-air wind belongs to the rider below.

Crowd and environmental sources share a small 2 Hz proximity manager. It starts a maintained source only
while the local listener is inside its region, limiting simultaneous decoding and mixing on Quest. Crowd
and environmental beds use lower priorities than board and contact cues.

## Hit-gated interactive loops

Events 16, 28, and 57—car alarms, hydrant spray, and police sirens—start silent. Their manifest records
carry `HitGated` and `Owner`; the importer creates inactive play-on-awake objects for them.

- Hydrants pair directly with their collision-triggered `AmbientEmitter`. A burst activates the spray
  loop and the lid re-arm stops it.
- Cars and police loops are managed by `HitGatedLoops`. A board wall impact takes the nearest loop
  within the configured radius, so one hit cannot arm a neighboring placement.
- Retail leaves these voices running forever. The port's default global wind-down is seven seconds; a
  repeat hit on an already-armed loop pushes its stop later rather than arming the next one along, and
  `activeSeconds = 0` restores the retail lifetime. A hydrant's spray is excluded from that: it is armed and
  stopped by its own emitter's burst/re-arm cycle, so this manager never takes it over.

Board-impact arming is local to the rider. Hydrant bursts follow the emitter's networked event path.

## Surface and collision audio

`OpenSlope/Setup/Surface Audio` attaches the Udon surface-audio path to `SurfaceDetector`. It chooses clips
from the staged `zboard` bank according to the `Surf_<type>` collider beneath the local player or board.
Re-run the setup after a full map import because the import rebuilds `OpenSlope_Map`.

Prop impact sources are attached to the collision bucket or computed-bounds collider whose resolved
course-bank material they represent. The board plays the full clip as a one-shot on contact. The course-bank
folder comes from the manifest; scanning for "the non-shared SFX folder" is only a legacy-bundle fallback.

Ride-through volumes carry their sounds the same way, resolved at import rather than on contact. A
ride-over button's trigger box holds the volume instance's remapped `CollisonSound` clip (the megaplex
button notes) and `ButtonU` plays it on the pulse broadcast, so every player hears the crossing. A
trigger-driven breakable's smash (the megaplex glass panes, the city sewer walls) is the break chain's own
raw-slot clip - the manifest `BreakSound` - played at the break FX anchor; roll-away clusters keep theirs
at the landing.

The ridden board's own bed - the glide and carve loops under the local rider - swaps clips by the same
SurfaceType through the retail surface→family mapping (verified against the ELF jump table): nine of the
shared `zboard` bank's ten families are wired (RAIL belongs to the grind path's own loop). `BedFrame` then
uses an original OpenSlope response over speed, lateral Slip and absolute Lean. A smooth speed envelope
opens the bed and the stronger of skid/lean hands it to the carve row; broad material families alter the
balance. Slopesmith's `boardBedFrame` implements the same authored curve. The AUTOTEST4 analyzer now reports
only measured signal distributions, and `tools/ride-study/board-bed-study.ts` shows how this curve responds
to them; neither tool carries a retail `SNOW.INF` program or expected-output table. Exact retail loudness,
pitch and recovery timing are intentionally not claimed.
Those same surfaces trade the snow spray for the grit spark shower
([032 - Snow spray](vrchat/032-snow-spray.md)).

Airborne wind is a separate rider-owned layer. On the ground→air edge the Unity boards cast the same
two-stage ballistic path they integrate and latch the predicted landing time. A result strictly over 1.5 s
starts the local 2D `zbxsfx/032` loop; landing fades and destroys it. This mirrors the recovered focused-rider
MAIN-bank ownership and gate and deliberately does not use `Wind1`, `Wind2`, weather state, or map metadata.
The clip prefers `Maps/Shared/Audio/SFX/zbxsfx/032.loop.wav` when Snowknife emitted the tagged loop region,
falling back to `032.wav`. The exact retail in-flight gain curve remains open,
so `bigAirWindVolume` and the ordinary board fade supply the current mix.

## Off-board environment filler

`Maps/<LEVEL>/Audio/Environment.json` is the one engine-neutral declaration of an optional silence filler.
It names the bank, slot, map-relative clip and gain; Unity carries no `AmbientClip`/`AmbientVolume` import
setting and does not infer this layer from external events 116/117 or weather. `AudioBuilder` imports the
declared clip as the 2D `Audio/EnvironmentBed` source and prefers its adjacent `.loop.wav` sustain region.

`MusicDirector` owns the runtime rule. A declared bed plays while the local player is off-board, fades out over 1.5 s
on mount, and returns on dismount. The board pushes mount state even when a level has no PathFinder race
graph, so the bed does not depend on race music or the announcer setup. Intro stems are used only when the map
has no environment declaration. The Background music Settings
Board row mutes whichever off-board layer is active.

## Intro music

The base importer can place one looping intro stem so a map is not silent without a platform runtime.
`OpenSlope/Setup/Music Director` replaces that bed with `MusicDirector`, a local Udon behavior that shuffles
one arrangement's bars through two ping-ponged sources and crossfades at each boundary. Setup disables the
static bed; removing the director restores it.

The default is the energetic C arrangement. A1–A4 can be substituted for a calmer, more varied set. These
are start-gate/intro stems, not the in-race PathFinder soundtrack; see
[039 — Race-audio runtime](039-race-audio-runtime.md).

## Known approximations

- General ambient and surface clip choices that lack a traced event binding are still tuning choices.
- Big-air wind's slot, focused-rider ownership and >1.5 s predictor gate are traced; only its in-flight gain curve
  remains an approximation.
- Loop-region clips omit the one-time attack that retail plays when a maintained voice enters range. Replaying
  that attack at a 2 Hz proximity boundary sounded like arbitrary repeated impacts, so the runtime favors the
  clean sustain.
- Dynamic event 102, the rider/race-position-dependent crowd chant, is intentionally skipped in free ride.
- Crowd-cheer stingers off the stand-side `FWTrigger`s remain separate event-system work; see
  [011 — Triggers and interactivity](011-triggers-and-interactivity.md).
- A glass pane's glancing-hit CRACK (its own collision header: a Sub14 Cracked node + course-bank slot 65)
  has no port counterpart - the panes are ride-through breakables here, so there is no non-breaking hit to
  crack on.

## See also

[009 — Collision](009-collision.md), [013 — Udon components](vrchat/013-udon-components.md),
[019 — Fireworks](019-fireworks.md), and
[Snowknife 039 — Race-audio extraction](../../Snowknife/docs/039-race-audio-extraction.md).
