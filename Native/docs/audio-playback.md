# Native sound and music playback

This milestone adds playable Maps audio to the Windows and OpenXR hosts. Windows
uses a native stereo-float output queue; Quest builds use AAudio. The independent
C++ mixer owns resampling, loop regions, voice priorities, stereo/positional
mixing, smoothing, pause and mute. No retail media is packaged in the EXE/APK.
The full parity objective remains in desktop-parity.md.

Clean Trailmap chapters 190, 200, 260, 270, 420 and 430 supply the data and
behavior authority. Generated WAV/JSON files are interoperability evidence only.
Native has no connection to a separate game-format decoder. PCM/WAV handling,
fixed-point codec recurrences, expression evaluation and graph traversal are
independently authored. This is not a claim of full audio/race/announcer parity.

The bank decoder handles signed eight-bit PCM, PS-ADPCM and EA-XA. It respects
self-relative bank entries, absolute channel offsets, empty slots, loop tags,
opposite nibble orders, codec-specific history precision and per-channel state
across streamed blocks. MicroTalk speech remains unsupported. The music reader
retains node/link words, complete variable-remap lists, event routes and sample
offsets. Standard PCM8/16/24/32 and float32 WAV input is bounded and checked.

Useful independent tools:

```powershell
./temp/native/Release/openslope_import.exe directory <iso> DATA/CONFIG
./temp/native/Release/openslope_import.exe archive-directory <iso> DATA/AUDIO/MUSIC.BIG
./temp/native/Release/openslope_import.exe read-archive <iso> DATA/AUDIO/AUDIO.BIG <member> <new-file>
./temp/native/Release/openslope_audio.exe bank <bank.bnk> <new-directory>
./temp/native/Release/openslope_audio.exe stream <stem> <new-wave>
./temp/native/Release/openslope_audio.exe graph <graph.mpf> <song.mus> <new-directory>
```

Large archives are indexed with bounded table reads; individual members are read
without loading the entire music archive. Normal ISO import now invokes bank,
ADL attachment, config-driven song/intro and async-bank extraction; see
audio-import.md. Build 0.44 independently normalizes boot-executable collision-event routes;
see collision-audio-import.md. Build 0.45 independently recovers board surface
routing (board-audio-import.md). Dynamic chants and speech extraction remain
required follow-up work. Existing populated
Maps folders continue to supply their audio data.

`Audio/SoundIndex.json` (`openslope-sound-index/v1`) supplies bank groups and
collision-event clip routes. Missing event/slot data stays silent. A prop's
`Sounds.CollisonSound` triggers a positional one-shot with impact gain, range
gate and 0.8-second debounce. Contact enables interactive emitter events 16/28/57
before and independently of resolving the collision cue. Point, ellipsoid, cone
and alternate-mode emitter records consume their declared gain curves. Optional
`Audio/ExternalIndex.json`, schema `openslope-external-sounds/v1`, provides explicit
`Events: {eventId: {Clip}}` routes for environmental banks. Fixed environment and
crowd routes are imported. Dynamic traffic/character-chant selection remains pending.

The board selects a family from `Audio/BoardSoundIndex.json`, or the established
`Maps/Shared/Audio/BoardSoundIndex.json`, with PACK fallback. Build 0.46 replaces
the early disc-expression playback profile with original OpenSlope glide/carve
response, rail handoff, scaled launch/landing, wind, boost envelope and authored
mix. It prewarms configured effects banks, shares attack/loop PCM and keeps
music reads outside the gameplay lock. See [board-audio-performance.md](board-audio-performance.md)
for the shared profile, state gates, budget, public-API conformance and limits.
`SNOW.INF` is still imported for inspection and codec/program conformance; focused
rider playback does not execute it. Broader music/announcer/lifecycle parity stays
active.

`Audio/Music/playlist.json` names map-local song directories. Each `graph.json`
names its WAV chunks. First inclusive matching link wins; 1-based sample indices,
loop counters, chained remaps, event-volume overrides, track exclusion and song
end are supported. The next PCM chunk is queued ahead and swaps within the mixer
at the boundary. A 100 Hz service loads/prefetches music with live voices pinned
during eviction. Build 0.50 adds random song choice per run, mounting crossfades,
off-board intro fallback, streamed authored masters and recovery continuity;
see [music playback](music-playback.md) for the shared mix and bounded memory.
Graph path level remains 80 until live performance routing is connected. Exact
race-start/menu intro timing, uber/trick grace and dedicated-song swaps, async loop/delay layers,
multi-stream synchronization, marker callbacks and the announcer remain outstanding.

Older graph exports with variable offsets but no remap pairs cannot establish
faithful routing. Native reports that the graph needs re-import rather than guess
those pairs. The new graph utility writes `VariableMaps` alongside established
node/link fields. Optional/corrupt audio failure is reported without substituting
an unrelated clip. AAudio disconnection recovery and Linux device output remain
platform work; worn headset listening remains unverified.

Quest's SAF cache copies the declared Audio library's WAV/JSON/INF assets, bounded
to 1536 MiB, 20,000 entries, six directory levels and 64 MiB per file. It also
materializes the shared board-routing sidecar in the course cache. The Audio
library contains complete banks/chunk sets; it is broader than the renderer's
image reference list. Source containers and other file types are not copied.
Build 0.44 passes 98 device-side JNI/custom-library/SAF cases, including automatic
collision-route import. This establishes extraction/cache behavior, not worn listening.

Desktop M toggles mute; P and loss of focus pause playback. Offline capture
supports `--audio-capture <wave>` alongside `--capture`, producing 48 kHz stereo
from the same fixed-tick gameplay and mixer, without opening an output device.
`--audio-smoke` queues a quiet generated tone to verify the actual output driver.
Audio capture is bounded to 128 MiB of float samples.

Validation includes independently authored codec/mixer/program/graph fixtures and
production-host PCM captures for pass-through impact sound, independent hit-gated
ambience, ground/air board gates and gapless chunk routing. A local board/course
bank comparison matched 115 WAVs including loop slices sample-for-sample. One
complete native-decoded song matched all 318 existing chunk WAVs exactly and
retained its node/link/event records plus three recovered remap lists. These
comparisons use owned local exports and do not place media in source control.
