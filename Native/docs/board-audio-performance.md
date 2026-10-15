# Board audio performance

Native performs the primary rider's glide/carve bed with original OpenSlope
presentation tuning from `Contracts/board-audio-v1.json`. The authority is the
public Slopesmith board-sound API, public audio tests and docs/034, together with
sanitized Trailmap 190/420 for bank/state interfaces. No runtime implementation
from another project supplies this code. The saved profile contains first-party
parameters rather than a disc expression sequence. `SNOW.INF` remains importable
for inspection; it no longer drives the focused rider's bed.

Lateral slip (cm/s), absolute lean (percent) and normalized speed drive a smooth
glide/carve handoff and independent pitch. Soft and hard families alter that
balance. The source of terrain family selection remains the imported course-local
or legacy Shared index, with PACK fallback. A rail replaces terrain sound with
the RAIL glide row. Ordinary off-board movement/flight silences the board bed;
applied Superman boost shares the held board-boost envelope.

The loop targets attack at 20/s and release at 6/s, written as ramps across each
fixed frame. Charged launch counters produce a single charge-scaled ollie; a
roll-off produces none. A snow landing uses the preceding airborne into-surface
velocity, remains silent through a 0.9 m/s arrival and scales against an 18 m/s
slam. Catching a rail does not produce a snow thud. Predicted flight strictly
greater than 1.5 seconds opens the big-air wind layer. Boost uses its meter-selected
MAIN clip captured on engage, punches to 0.9 for 0.6 seconds, releases at 2.5/s
to 0.45 while held, then fades to silence after release. The engine engage action
is semantic rather than a second overlapping one-shot.

Default authored mix: volume .8, glide .7, carve .8, transients .7, cues .8. Optional
`Audio/BoardMix.json` carries `schema: "openslope-board-mix/v1"` and a `boardSound`
object with these lower-case fields plus `enabled`. Missing trims use defaults;
finite numeric trims clamp to 0..1. This is a Native portable sidecar; current
Slopesmith map export does not carry its in-editor mix into that file. The trim
includes rider-owned gem/pad cues, boost and wind. Prop/effect/ambient audio retains
its independent mix, and the game master still applies over everything.

Course opening prewarms configured bank WAVs and event-referenced clips, bounded
to 4,096 names and 96 MiB decoded. Loop regions and full attacks share one decoded
PCM allocation. Loops without a sibling region use the full clip; sustain-only
voices begin at their region while one-shots retain the full attack. Files beyond
the admission budget remain unavailable and increment `prewarm_skipped`; they do
not fall back to file access on a gameplay edge. Normal owned courses use about
22 MiB for all configured effects banks. The total cache remains bounded to
128 MiB with resident SFX protected from music eviction.

Gameplay only looks up decoded clips. The music service serializes its own work,
releases the scene mutex during graph/PCM reads and checks a revision before
publishing work after resets or cue/level changes. Reset and music controls enqueue
state changes; they do not read files in the gameplay tick. Offline capture calls
the service explicitly; live hosts already run it on their audio service thread.

Validation passes all 45 native suites, including 41 board performance/prewarm
checks and mixer ramp/generation guards. A separate public-API comparison matches
7,160 response samples across all ten families (maximum absolute error
1.11e-16), plus default mix/bend tuning. The full repository gate passes in
241.7 seconds. Production Vulkan/PCM checks cover 394 performance frames,
120 routing/fallback frames, 170 contact/ambient/board/music frames and 273
on-foot flight/boost frames. Actual owned wood/metal clips add 360 comparison
frames with unchanged rider position/velocity. Full GARI and ALASKA openings
prewarm 151/145 clips respectively, with zero budget skips.

The signed ARM64 0.46.0/code 47 APK passes 100 Quest JNI/custom-library/SAF
checks, with all sixteen exact license/notice assets and no private media.
Lint reports zero errors and four existing warnings. The installed APK hash
matches the saved build; ALASKA geometry, world, instances, audio metadata and
selected-map preferences retain their hashes. An eight-second ALASKA startup
initializes both 1680x1760 eyes at 4x MSAA and the runtime full-body tracker.
This does not establish worn listening or sustained FPS.

Saved builds are under `temp/native/desktop-board-performance-0.46.0` and
`temp/native/OpenSlopeNative-quest-0.46.0-board-performance-debug.apk`.
Build 0.48 adds shared-bank-only custom-map loading and portable editor mix export;
see `audio-library.md`. Wider music/announcer behavior and broader
gameplay/graphics/performance parity remain active.
