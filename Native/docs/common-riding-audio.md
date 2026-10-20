# Common riding audio for SSX 3 and On Tour

The streamed importers now adapt decoded audio into the ordinary Maps riding
banks. This is an OpenSlope approximation: it uses each game's own samples with
the existing OpenSlope jump, landing, glide/carve, rail, wind and boost controls.
It does not require the original event resolver or a game-specific runtime.

`Audio/SoundIndex.json` selects `openslope_board` for group 1 and
`openslope_rider` for group 0. They use the existing bank manifests, WAVs and loop
slices. All ten family rows have landing/jump at +1/+2 and carve/glide at +3/+4.
Wind uses MAIN 32 and held boost uses 120–122. Unsupported gem/pad slots remain
empty. Original banks and `NamedBanks` remain available; collision/event routing
still reports Deferred independently of riding playback.

SSX 3 prefers its SPU snow loops and ordinary hard-surface loops. Its landing
bank supplies landing and approximate jump transients. On Tour uses its packed,
powder and ice board banks, selected shared riding transients and wind, and boost
audio. Hard-family fallbacks reuse the available snow/ice samples. Where a
continuing layer has no source loop, OpenSlope repeats the complete clip. These
choices prioritize usable riding feedback; their exact original meanings and
transitions are not claimed.

`Audio/RidingImport.json` labels the result `Fidelity: Approximate` and records
each output bank/slot, role, source bank/slot and loop policy. Source loop regions
are retained; transients keep their full attack and do not loop. The existing
players continue to own gain, pitch, ground/air gates and launch/landing timing.

The browser passes the selected reference level to board-audio requests. Server
and browser-local readers resolve its bank roles from its own SoundIndex. A
missing explicit course/slot stays silent rather than borrowing another title.
Authored courses without a selected source retain shared-bank lookup.

Fresh imports include the adapter automatically. Existing extracted maps can be
updated without reimporting geometry:

```text
openslope_import adapt-riding-audio <map-folder>
```

The command preserves original banks and saves `SoundIndex.before-riding.json`.
It refuses conflicting generated destinations, stages new files before publishing,
rolls back on failure/cancellation and leaves its complete output unchanged on a
repeat run. Audio and image data remain local; no retail media is packaged.
Generated PCM is bounded to 128 MiB, its source cache to 96 MiB, each source file
to 64 MiB, and the complete Audio tree to the existing 512 MiB/20,000-entry limit.

Synthetic tests cover both source layouts, common slots, real loop slices,
non-loop transients, missing cues, source preservation, cancellation during WAV
writing, conflicting paths and idempotence. A real native Player/Mixer test checks
audible PCM during riding and actual launch/landing events. Browser tests run ISO
extraction, IndexedDB publication and local common-bank WAV delivery. Separate
checks cover selected-course routing and browser ground/air/boost controls.
Local Peak 1 and ER1 imports each produce 44 routes and about 7.5 MiB of derived
WAVs. Listening and further sample-choice refinement remain useful.

## Playback levels and loop joins

The first adapter copied the decoded samples at their original levels. Measured
PACK loops in the local imports had RMS around 0.367 for SSX3 glide/carve and
0.391/0.158 for On Tour carve/glide. Those differences were too strong for the
common ride response. The raw clips contain few saturated samples; measurements
alone do not establish a decoder fault.

Native and browser playback now condition only the reserved `openslope_board`
and `openslope_rider` banks using
[the shared profile](../../Contracts/streamed-riding-audio-v1.json). Each clip gets
a fixed attenuation with role-specific RMS and peak ceilings; quiet samples are
never boosted. Continuous loops lose their DC offset and receive a five
millisecond edge correction so their endpoints meet. Transients retain their
attacks and receive only level control. Duration, pitch and source loop indices
are preserved. Browser loop starts and switches also use brief fades.

This is playback preparation in the private decoded cache. Original WAVs, bank
manifests and `RidingImport.json` remain unchanged. Browser copies are shared
between runs without modifying the raw audio cache. Actual bank names from
`/api/board-audio` select the profile, including browser-local imports; title
prefixes do not. Existing imported courses need a page reload, not ISO reimport.
Other banks keep their existing levels.

On the measured PACK examples, the resulting glide/carve attenuation is about
9.7/7.2 dB for SSX3 and 2.4/7.8 dB for On Tour. Automated checks cover real browser
AudioBuffers, metadata selection, cache reuse, untouched raw buffers, loop joins,
transient shape and native Player/Mixer headroom. Subjective listening remains a
separate check; the profile is OpenSlope presentation tuning.

## Sustained rails and restrained pitch

SSX3's previous adapted rail52 used a 0.63-second non-loop clip, producing a
repeating clank. New imports prefer the sustained BOARD35 metal-family loop
(about 5.23 seconds in the local image). Existing adapted maps receive the same
substitution at playback when their own original BOARD35 loop is available.
Native, server and browser-local readers keep that substitution within the map;
source WAVs and old adapter manifests are preserved.

The shared adapted-board pitch profile now starts glide/carve at 0.90 rate with
at most 0.12 additional bend. Rails use 0.90..1.05 over speed. Legacy banks retain
their original response. These are first-party tuning choices: ISO SNOW.INF and
executable inspection did not establish complete original sample/pitch routing.
Real browser source-node checks and native PCM tests verify the new rate scope
and old-map rail substitution. A page reload applies these riding fixes.

See [course ambience](common-course-ambience.md) for placed mountain sounds.

[Trailmap: 518-authored-riding-adapter, 522-streamed-riding-audio-conditioning, 523-streamed-course-ambience]
