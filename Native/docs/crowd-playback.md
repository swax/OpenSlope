# Crowd material grids

Build 0.29 installs the authored subtype-17 crowd property in the shared world
runner. Clean Trailmap 150/170/200/230/410 supplies the descriptor, shared art,
patterns, cadence and activity laws. Existing models supply all geometry and UVs;
no spectator meshes are generated from the property.

## Cell state and activity

One shared controller owns sixteen independently phased cells. It advances on
every fifth 60 Hz simulation tick, giving twelve crowd updates per second.
Each cell chooses one of the four clean 410 source-frame sequences and a random
initial phase. A completed sequence rerolls its pattern and can rest on source
frame zero for 0..63 updates. Codes 1..6 use rest chances 0/256, 50/256, 100/256,
200/256, 100/256 and 50/256; code 7 never rests. Code zero freezes the poses and
rest counters while the global beat retains its phase. The standard native PRNG
stream is deterministic for tests, not original random-sequence equivalence.

The native descriptor ignores its first word and reads rows/columns from its
second/third words. Shipped 4x4 and 2x8 descriptors address the same sixteen cells.
The older public two-word descriptor is normalized only when the third word is
absent. Bounded smaller custom grids use their authored cell count. Cells bind
in the model's first draw/material-block order, never sorted material-id order.
All thirty used crowd models across eleven local imports match their actual
source block order; this covers 630 placed stands.

Explicit activity inputs carry active rider positions and codes 0..7. Only
riders within 200 m of a live stand's authored origin feed the controller; camera observers alone
do not animate it. A force flag selects global code 7. The current single-player
application feeds code 1 while a run is active and not resetting. Multiple
explicit inputs use the highest nearby code. These are application defaults:
exact original crowd/SFX activity classification and multi-rider priority remain
required parity work. This milestone does not replace them with a claim that
proximity alone reproduces every crowd reaction.

Each stand owns its projected material state even though cells share the
controller. Pausing one stand holds its captured poses while other stands keep
advancing. Constructor replacement, ordinary region teardown and restart remove
its overrides; existing populated latches and mode/tombstone gates remain.

## Shared art and Maps

`DATA/TEXTURES/CROWD.SSH` is the shared sixteen-frame bank. The independent
importer decodes it through the existing bounded texture reader when present,
writes `Textures/crowd-<name>.png` and publishes `Crowd.json` with schema
`openslope-crowd/v1` and an ordered sixteen-filename `Frames` list. Shared art
stays in the user's map, outside the APK and source control. Explicit custom
profiles can name their own PNGs. The profile has a 64 KiB limit and only safe
single-component PNG names are accepted.

Quest SAF preparation copies the profile and every referenced frame. The new
synthetic ISO and caching case compile; no new device execution is claimed.
New ISO imports include the bank automatically. Older native imports did not
save this loose shared bank in their course Source folder, so the art cannot be
recovered from those sidecars alone. They retain their existing placeholders
until supplemented. The desktop utility can add it without re-extracting or
rewriting course metadata:

```powershell
./temp/native/Release/openslope_import.exe extract-crowd <iso> <map-folder>
./temp/native/Release/openslope_import.exe convert-crowd <saved-crowd-ssh> <map-folder>
```

A supplement refuses an existing profile or conflicting art, publishes the
profile last and removes its newly created files if conversion is cancelled.
Existing custom files remain. User-facing in-app upgrading of an already
imported course still needs its own path; ordinary new imports work end-to-end.

## Rendering and memory

A scene uploads the sixteen crowd images/descriptors once. Per-instance cell
selections choose those pages without rewriting shared material records or
another eye's resources. Crowd drawing uses cutout alpha even though its source
placeholder materials do not carry the ordinary alpha-pass flag. Existing
atlas UVs, authored lighting and model/placement transforms remain active.
No geometry is flattened or replaced with a static crowd image. Private crack
state keeps its existing priority over material playback.

The frame-binding validator checks cell limits, material identity and duplicates
before fence reset without allocating one tree node per cell. Texture-flip RNG
state is now allocated only for installed flip nodes, rather than stored inline
for every world property. The renderer keeps the existing 192-byte eye-local
pose layout. These changes do not establish a new Quest frame-rate result.

## Remaining parity scope

Crowd/SFX activity classification, dynamic crowd chants and their rider/race
selection, exact original PRNG streams, complete world activation and wider
course/VR comfort/performance coverage remain. Combined material properties,
other billboard/video consumers, rigid bodies/debris/respawn and the full
remaining gameplay/audio/rendering matrix also remain. The installed Quest app
and user-imported ALASKA are preserved for the user's limited steering test.

## Validation

All 29 portable suites pass. The crowd suite passes 8,509 pattern/cadence/rest,
authored-order, legacy-descriptor, activity, pause and restart/region checks.
The binary import oracle validates all sixteen synthetic PNGs and ISO outputs,
refuses conflicting existing files, and preserves map sentinels. Three extra
checks cancel conversion after several PNG writes and verify complete new-file
rollback without touching existing custom files.

The actual Vulkan suite passes 1,560 material/channel/state assertions on UNORM
and sRGB with 1x/4x MSAA, including cutout holes despite opaque placeholder flags,
per-cell page selection, queued-eye isolation and rejected-input recovery. The
avatar/HUD suite passes 84 assertions. Five production crowd replays render 84
frames and prove fifth-tick cadence, multiple cell poses and one stand holding
while its neighbor advances. Existing material/glass/world/model/spline/boarding/
score/recovery replays pass, including the 70-check real-map property comparison.

All 30 used crowd models match native/source block order across 630 placements
in eleven imports. Fresh local copies of GARI, MEGAPLE and SNOW are supplemented
without changing their existing course metadata. Six close-up source-stand
captures show the actual art and background cutout; three sixty-frame startup
runs also pass (180 frames). These are targeted checks, not every whole-course
interaction or a complete activation/lifecycle equivalence result.

Two old/new 120-frame replay pairs on each of GARI and MEGAPLE produce identical
pixels on unsupplemented legacy maps. Peak process working-set samples are:

| Course | 0.28 baseline | 0.29 sparse state |
|---|---:|---:|
| GARI | 235.0..244.0 MiB | 227.4..227.8 MiB |
| MEGAPLE | 150.4..150.7 MiB | 143.8..144.1 MiB |

The observer polls process memory at 25 ms intervals. Private-memory samples
vary, especially on GARI; renderer/driver allocation and process variability
remain in these figures. This is limited desktop evidence for the allocation
change, not a VR memory or frame-rate guarantee.

The final ARM64 app is signed 0.29.0/code 30, and its updated instrumentation APK
builds and verifies. Android lint has zero errors/four existing warnings. All
15 packaged notice/license assets match their sources and no course/disc/audio/
texture/mesh data is bundled in the app. The source boundary checks 217 files.
Immutable artifacts and a commit-pinned hash manifest stay in the ignored build
tree. New JNI/SAF cases are compiled, not newly executed on the Quest.

```powershell
./temp/native/Release/openslope_crowd_tests.exe
python Native/tests/crowd_replay_test.py temp/native/Release/openslope_player.exe
```
