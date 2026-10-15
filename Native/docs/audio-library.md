# Map audio interoperability

Build 0.48 consumes the portable public export audio contract. The clean
Trailmap audio data/runtime specifications and public export/API observations
supply the interfaces; no differently licensed decoder or runtime implementation
supplies Native code.

Common board (`zboard`) and MAIN (`zBxsfx`) banks resolve once at map opening:
local files first, then `Maps/Shared`, then sibling folders with `Patches.json`
in sorted order. Folder and WAV case are matched without assuming Android has
Windows filesystem behavior. Missing slots can use the same common bank from a
later source. Explicitly named other banks remain local. Course effects and
placed event routing are never borrowed from another course. Surface routing
prefers local, Shared, then an existing course index; absence retains PACK.

Sibling discovery is bounded to 20,000 entries and 256 maps. On overflow it
keeps local and Shared audio and skips optional sibling fallback. Every
selected path must remain inside its source folder and Maps library. Ambiguous
case variants and unsafe authored names are rejected. Existing 4,096-clip,
96 MiB resident SFX and 128 MiB total audio budgets still apply. Build 0.50
reserves 8 MiB for music streaming; cached clips occupy at most 120 MiB. Full WAVs and
their own sustain regions are selected together. Gameplay performs no file I/O.

`Slopesmith.json` now exports normalized `boardSound`. Native reads it for schema
1 / kind `slopesmith-export`; an explicit `Audio/BoardMix.json` overrides it.
Non-numeric trims use defaults; finite numeric trims clamp to 0..1.
`Effects.json.extensions.slopesmith.customSoundEvents` maps event IDs to
`Sounds/<file>.wav`; `customSounds` maps direct course slots. Canonical instance
and emitter `SoundClip` fields also work independently of those routing links.
Hit-gated emitters preserve their activation policy. Untextured canonical props
with material -1 load without requiring a fake material record.

`Audio/Environment.json` (`openslope-environment-audio/v1`) selects a nonspatial
bed with explicit gain. It fades in off-board and out on mounting over 1.5 s;
`Bed: null` remains silent. It uses the tagged sustain region when available.
Build 0.50 adds race music, authored masters and intro fallback;
see [music playback](music-playback.md). Announcers remain parity work.

Quest SAF preparation copies `Sounds/` alongside local Audio, then fills only
the two common banks and missing surface routing from Shared/installed maps,
even when the selected map has no Audio folder. Local overrides remain first.
The selected full WAV carries its own loop; unrelated course banks and music
are excluded from fallback. Copying shares the existing size, count,
cancellation, and partial-cache cleanup guards.

Validation combines resident-cache tests (including deleting files before their
first event), production Vulkan/PCM replays, public API exports containing only
synthetic geometry/WAVs, and device-side opaque-SAF integration tests. Saved
builds and measured outcomes are recorded in the milestone build manifest.

The 0.48.0/code 50 milestone passes all 46 Native suites and 50 board/cache
checks. Production validation covers 831 library/export/environment frames,
664 board-performance frames, 170 contact/ambient/music frames and 120 surface
routing frames. A further 1,008 owned MESA frames match 0.47.1 position and
velocity exactly. The source-boundary audit checks 331 Native files.

The connected Quest passes 113 JNI/custom-library/SAF checks. Installation
preserves all six checked ALASKA geometry/world/instance/audio files and selected
map preferences. Lint has zero errors and four existing warnings; the signed
ARM64 package contains all sixteen exact notices and no private media. An
eight-second ALASKA startup initializes both 1680x1760 eyes at 4x MSAA and the
runtime full-body tracker. Worn listening and sustained FPS remain unmeasured.

The desktop build is `temp/native/desktop-audio-library-0.48.0`, including its
MESA launcher. The APK is
`temp/native/OpenSlopeNative-quest-0.48.0-audio-library-debug.apk`. The build
manifest beside them pins hashes and the source commit.
