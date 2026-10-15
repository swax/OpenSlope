# Native music lifecycle and authored masters

Build 0.50 adds mounting, dismounting, intro fallback and authored master playback
to the existing graph scheduler. The broader parity objective remains active in
desktop-parity.md.

Behavior authority is the public music API and custom-music documentation (031)
from Slopesmith, exercised with synthetic audio. The clean Trailmap music
chapters and shared graph DTO remain the authority for imported graph traversal.
No separate decoder implementation, private media or retail mix table supplies
this playback code. `Contracts/music-playback-v1.json` records the original
OpenSlope gains: race/master 0.42, intro 0.3 and a 1.5-second crossfade. Graph
`Volume` remains extraction metadata; this playback profile controls the race
bus, above any graph event-volume override and below the master volume.

On foot, the player uses `Audio/Environment.json` when present. Explicit
`Bed: null` means silence. Only an absent environment file permits intro music:
`Audio/Intro/stems.json` or WAV directory names select C phrases, then A, then B.
Older exports with the same names directly in `Audio/` also work. A finite phrase
plays at a time, followed by another selected phrase; `end.wav` is excluded.
Mounting fades the off-board layer out and race music in. Dismounting fades race
music to a stop; remounting restarts its beginning.

`Music/track.wav` takes precedence over the reference playlist. The optional
version-1 `Music/arrangement.json` supplies `loopStartSeconds` and `loopEndSeconds`;
zero end means EOF. The initial attack plays before the loop start, then playback
wraps over the declared region. The same master loop applies to the authored
adaptive arrangement mode while adaptive generation remains future work. The
Quest SAF cache now includes both root Music files under the existing shared
audio count, byte, cancellation and cleanup limits.

Reference playlists choose a random song for each new run. The public native
scene API also accepts an explicit song and independent music enable state.
Recovering or teleporting preserves song choice and music transport; a full run
restart resets transport and may choose another random song. Dismount, music
disable and explicit song selection retain the run's preference. Music controls
are not yet exposed in the desktop/wrist menus or saved to preferences.

Long masters and intro phrases use bounded, seekable WAV reads outside the
gameplay mutex. Each stream queues two half-second 48 kHz stereo output blocks
(384,000 decoded bytes) and retains one bounded source window. The graph/SFX
cache allows 120 MiB, including a 96 MiB resident SFX ceiling; the remaining
8 MiB of the established 128 MiB budget covers streaming windows and temporary
buffers. Tiny loops coalesce into output blocks, independent of service timing.
Pause/focus loss freezes mixer transport, and recovery clears effects without
discarding the music bus. Service revisions reject obsolete reads after reset.

Validation currently includes all 47 Native suites, 37 focused streaming/mix
checks, 19 public API observations and 1,892 production Vulkan/PCM frames. Cases
cover a 96 MiB master without full decode, single-frame loops, concurrent
reset/service, intro tier priority, explicit environment silence, public stereo
36 kHz master export, loop-region exclusion, mounting/dismounting/remounting,
master precedence and retained run song choice. Existing audio regressions cover
another 1,785 Vulkan/PCM frames; 96 HUD frames remain stable and 1,008 owned MESA
frames retain exactly the 0.47.1 final position and velocity. The repository gate
passes in 276.3 seconds; the final source boundary checks 339 Native files.

The installed 0.50.0/code 52 Quest APK passes 115 JNI/library/SAF checks, including
root Music caching. Home pause, app-icon resume into the same course, Android
Back/app exit, map-picker return and three XR resource-release cycles pass with
no Android fatal exception. The six checked ALASKA files and saved map
preferences retain their hashes. Desktop and signed ARM64 APK packages retain
all sixteen exact notices and contain no private course media.
An eight-second ALASKA startup initializes both 1680x1760 eyes at 4x MSAA and
the full-body tracker. Android lint reports zero errors and four existing warnings.
An eight-second ALASKA startup initializes both 1680x1760 eyes at 4x MSAA and
the full-body tracker. Android lint reports zero errors and four existing warnings.

Saved builds: `temp/native/desktop-music-lifecycle-0.50.0` and
`temp/native/OpenSlopeNative-quest-0.50.0-music-lifecycle-debug.apk`. The adjacent
build manifest records hashes, source commit and device evidence.

Live path-level/trick/uber events, dedicated-song transitions, async layers,
announcers, exact intro/results timing and worn listening remain outstanding.
This milestone does not establish complete music or gameplay parity.
