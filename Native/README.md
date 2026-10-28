# OpenSlope Native

For packaged Windows/Quest builds and GitHub prereleases, see
[release packaging and signing](docs/releases.md).

Build 0.89 adds preliminary Jonny Moseley Mad Trix USA PS2 import, with eleven
courses, source baked colored lighting, supported animated signs and waterfalls,
grind rails, riding sounds and twelve music tracks. See [build notes](releases/0.89.0.md).

Build 0.88 adds desktop Enhanced and Runtime lighting, shared avatars on Windows
and Quest, and shader optimizations that improve Quest rendering performance.
Desktop performance varies by GPU and lighting mode. See [build notes](releases/0.88.0.md).

Build 0.87 adds four stock board designs, with a fresh choice on course restart
or a new-board pull. Avatars and boards respond to course lighting in normal
lighting mode. See [build notes](releases/0.87.0.md).

Build 0.86 removes both Race and Showoff start countdowns. Riding, scoring and
the event clock start on the first mounted tick. See [build notes](releases/0.86.0.md).
The equipment-frame fixes and SSX gem importer remain included;
older SSX maps need re-importing to receive gem animation and pickup metadata.

Build 0.82 makes Quest Y hide the full wrist HUD and controller models together.
Press Y again to restore them. See [build notes](releases/0.82.0.md).

Build 0.81 adds a 600 metre terrain draw range and matching fog on desktop and
Quest. Existing courses work without re-importing. See [build notes](releases/0.81.0.md).

Build 0.80 fixes original SSX riding-sprite loading, excludes unscored On Tour
paths from race progress/finish calculations, and admits one state of paired
On Tour event terrain for rendering and collision. See [build notes](releases/0.80.0.md).

Build 0.79 hides the opponent menu and removes control hints from the desktop
window title. The Windows package has shorter setup instructions; full controls
remain in the in-game menu. See [release notes](releases/0.79.0.md).

Build 0.78 opens the desktop library at startup and lists ISO files beside the
EXE. Queue course extractions, follow progress in each row, then choose Play
when ready. Wheel scrolling and a draggable scrollbar replace desktop paging.
The native reader supports SSX and SSX Tricky PS2, including the original
game's raw `.bin` disc images. SSX 3 PS2 import now exports events and peaks
through the same reader used by Slopesmith's `/isos` worker.
See [SSX 3 import and remaining limits](docs/ssx3-import.md).
SSX On Tour PS2 uses the same importer with individual day/night track selections;
see [On Tour import and remaining limits](docs/ontour-import.md). Whole-mountain
imports are unavailable.
See [SSX import and current limits](docs/ssx-import.md).
See [desktop ISO setup](docs/desktop-iso-0.78.md).

The shared importer also previews all 25 single-player USA 1080° Avalanche layouts
directly from `.rvz`, `.gcm` or GameCube `.iso`. Curved terrain, primary textures,
static scenery, collision, spawning and reset work through the existing portable
map path in Native and Slopesmith. Source background meshes, sky colours and cloud
coverage, approximate course lighting, adapted riding spray and 46 named music
streams accompany new imports. Music uses the shared song picker and full-track
looping; original audio scheduling remains deferred. See
[Avalanche import and current limits](docs/avalanche-import.md).

Jonny Moseley Mad Trix USA PS2 `.bin`/`.iso` discs expose eleven courses through
the same native library. The converter imports curved terrain with source baked colored lighting, textures,
sky domes, terrain collision and adapted starts; see [Mad Trix import and limits](docs/madtrix-import.md).
Its twelve source music tracks use the shared playlist player, with bounded
audio chunks and whole-track looping.

Build 0.76 adds desktop A/D strafing, left-drag look/turn and E to spawn and
mount at the player's feet, including mid-air. See [desktop controls](docs/desktop-controls-0.76.md).

Build 0.75 fixes an embedded-deck air-state lock reproduced from a paused
Snowdream playtest. See [captured contact validation](docs/embedded-contact-0.75.md).

Build 0.74 extends the landing correction to upward travel into banks, centres
flips on the rider's pelvis, and clears lingering live-bag overlaps. See
[playtest fixes and validation](docs/playtest-contact-0.74.md).

Build 0.73 fixes sliding along banks in the air state and restores grounded
steering and carve audio after tilted-board landings. See
[bank touchdown validation](docs/bank-touchdown-0.73.md).

Build 0.72 makes swept terrain collision follow the curved patches more closely
and clears partly embedded compound props toward the body's side of the terrain.
It also fixes initial sphere overlaps choosing the wrong triangle feature. See
[curved terrain validation and limits](docs/curved-terrain-0.72.md).

Build 0.71 orders unfinished racers by earned checkpoint progress and records
finishes on a shared clock, including opponents added after a race has begun.
Existing maps need no re-import. See
[standings validation and remaining work](docs/race-standings-0.71.md),
[reset bias](docs/reset-bias-0.70.md),
[landing containment](docs/landing-frame-0.69.md) and
[opponent recovery](docs/opponent-recovery-0.68.md).

Experimental C++20 player for portable OpenSlope maps, with a Vulkan renderer and OpenXR host.
Windows desktop rendering and portable conformance tests are the local validation targets.
The ARM64 Android APK builds, and the user reports successful Quest play after importing ALASKA
inside the app. Build 0.21.0 reaches 71.5–72 fps in a focused Quest 3 ALASKA sample with
4x MSAA and live full-body tracking; the user confirms walking/boarding and improved performance.
Longer rides, comfort and wider headset coverage still need testing.
The Linux host still needs target build/device validation. Full gameplay parity remains
tracked in the matrix below.

The desktop player starts on an original procedural slope, or reads a local `Maps/<NAME>/Patches.json`.
The Quest app starts with a Maps library: choose a populated folder, or select a local SSX or SSX Tricky PS2
disc image to add courses. No ISO is required to browse and play custom maps. No retail content is packaged.
The importer currently converts terrain, textures, lightmaps, static prop geometry/placements,
AIP/SOP course paths, collision proxies/physics bodies, configured sound/music assets and provenance. The player renders textured
terrain and shared world props, supports charged jumps, spins/flips and switch landings, and uses
authored prop contacts for bounce, ride surfaces and pass-through events. Animated crash recovery,
analytic rails, timed runs, spin/flip/rail scoring and selectable skinned avatars are implemented. Quest starts on foot
beside the board, with walking/jumping and nearby mounting. Authored reset volumes, multiplier pickups, mode hides and graph-triggered sound
now run through the shared world logic. Persistent model-object animations move
rendered parts and matching collision/support. Fresh imports recover collision-sound event routes from
the disc's boot executable into `Audio/SoundIndex.json`, plus board-surface groups into
`Audio/BoardSoundIndex.json`. Full live prop behavior, uber tiers, complete AI races and multiplayer remain
later stages. The retail cast and trick repertoire are out of scope, as CONTRIBUTING.md sets out. See
[the map-library contract](docs/map-library.md) and [desktop parity matrix](docs/desktop-parity.md).

Build 0.37 fixes GARI's black barrier overlay and adds per-piece break animations,
with shared walking/riding contact events. Automatic collision-event sound routing
still needs executable extraction; see [barrier validation and limits](docs/shatter.md).

Build 0.38 adds [live collision bags and scripted knock-off props](docs/rigid-props.md).
Walking and riding transfer linear and angular momentum, the native collision
shape follows the moving model, and props settle in place. Desktop and Quest use
the same runtime; exact solver tuning and worn-device checks remain.

Build 0.30 adds timed speed/trick pads, authored conveyors/vents/wind, altitude
lifts and staged tube launches. See [boost volumes](docs/boost-volumes.md) for
source alignment, test evidence and the remaining original lap-ride/air-profile
gaps. Desktop and Quest use the same gameplay code.

Build 0.31 connects authored [instance teleports](docs/teleports.md), including
Merqury City's entrance/exit, stopped destination-facing arrival and retained
run/music. Walking arrivals keep the parked board nearby.

Build 0.32 adds the [boost geometry afterimage](docs/boost-trail.md), shared
between desktop and VR: seven sampled board poses, source meter colours and
speed-pad activation, with a draining release and no particle-art requirement.

Build 0.62 adds [surface chunks, takeoff puffs and rail/contact sparks](docs/surface-spray-0.62.md).
Packed snow, off-track, powder and ice use their own verified sprite/size/fade
profiles; rails and hard contacts throw warm comet trails with occasional flares.
Existing imported sprite banks work without re-extracting a course.

## Build and try on Windows

Install Visual Studio 2022 C++ Build Tools with its CMake component and Windows SDK. Python 3 is
needed to embed locally compiled shaders. The build locates the Visual Studio installation even
when CMake is absent from PATH. Dependencies download into the ignored build tree and are pinned
by version and SHA-256; an optional local archive cache lives at `.openslope/native-downloads/`.

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Native/build.ps1 -Player
./temp/native/Release/openslope_player.exe
```

A/D steer/spin, W/S tuck/brake/flip, Space holds a charged jump, Shift boosts, R resets,
F/V switches first/chase camera, C looks down, and E dismounts or spawns and mounts at your feet.
RMB drag orbits the camera without turning the avatar; LMB drag turns the on-foot character with the camera.
RMB over a loose board carries it and releases to throw.
P/Escape opens the pause menu; Escape first releases a held mouse drag.
The wheel changes camera distance. The pause menu includes a map library and ride settings.
Choose **Avatar** for all seven Slopesmith riders or a custom character GLB. Quest
offers the same choice in its wrist menu and launcher Ride settings; see
[avatars and custom imports](docs/avatar.md).
Without `--map`, the desktop starts in the library. Place `.iso` or `.bin` files beside
the EXE and choose **ISO Sources**, then **Extract <course>** to queue a course.
Progress stays in its row, which becomes **Play <course>** when ready.
Completed courses live in `Maps/<name>` beside the EXE; playing is a separate click.
Existing/custom maps need no ISO; **Refresh** discovers newly added files.
Use `--on-foot` to start beside the board; A/D strafe, W/S walk and Space jumps in that mode.
Jump again in the air (or Jump + Boost) to fly; Shift/B boosts along the look/controller aim.
Ctrl crouches or flies down. G retains the nearby boarding shortcut. See [on-foot flight](docs/foot-flight.md).
See [walking and boarding](docs/boarding.md). Input pauses when the preview loses
focus; an uncommitted jump charge is cancelled.

Desktop rendering defaults to 150% scene resolution and 4x MSAA, falling back
to supported targets/sample counts. Graphics in the pause menu saves render
scale (100/125/150/200%), MSAA (Off/2x/4x/8x) and snow (0–10, default 3).
Desktop Graphics offers saved Original, Enhanced and Runtime lighting modes.
Runtime replaces imported lighting with runtime lights for the course, player and boards; see
[enhanced lighting](docs/enhanced-lighting.md) for scope and comparison commands.
The UI stays at native window resolution. `--render-scale`, `--msaa` and
`--snow` override those settings for window/capture mode. Map-library selection
shows a responsive loading bar. See [snowfall and graphics](docs/snowfall-graphics-0.61.md).
OpenXR also defaults to 4x MSAA. The Quest launcher offers 100%, 125% and 150% of
the runtime's recommended eye dimensions, plus Off/2x/4x edge smoothing. Fresh
settings default to 150%/4x and a 120 fps target. Target frame rate is configurable
at 72/80/90/120 fps, with runtime-supported fallback. Existing preferences remain
in effect. Higher resolution increases attachment memory and GPU cost.
Flag and banner graphs now drive eight-section cloth waves, with private phase,
both fixed ends, lifecycle and conservative culling. See [flag-cloth.md](docs/flag-cloth.md)
for supported geometry, validation and remaining fidelity work.

Quest controls now match the supported Slopesmith actions, including right-stick
view turn/click camera, squeeze carry/throw and the interactive Y wrist menu. Controller models use the OpenXR grip frame,
and hand skin follows full wrist orientation. See [quest-controls.md](docs/quest-controls.md)
for the earlier mapping and [equipment, camera and UI](docs/equipment-camera-ui.md)
for current controls, independent implementation, validation and remaining physical checks.

Quest always uses head steering with left-stick player turning as a fallback.
The stick rotates the player, tracked hands and view together; the board follows
the resulting gaze. See [VR steering](docs/vr-steering.md) for controls, tracking and
remaining headset validation. Timed runs now bank spin/flip and rail tricks and
spend/refill boost; see [trick scoring](docs/trick-scoring.md) for exact scope.
Manual reset and the existing active-run recovery triggers now prefer a nearby
authored respawn path, with safe course/trail fallbacks for custom maps. They
preserve the run clock and banked score. See [course recovery](docs/course-recovery.md)
for the supported placement rules, shared desktop/VR hold and fade, and remaining
world-trigger work.
Authored world contacts now dispatch portable effect graphs, including Showoff
gems, course reset, mode hides/rail toggles, waits and sound. Existing native
imports use their saved behavior sidecar without re-import. See
[world logic](docs/world-logic.md) for compatibility, verification and remaining
property/region lifecycle work. [Prop animations](docs/prop-animations.md) covers
per-instance clocks, budget/combo controls, region/end latches and moving contacts.
[Spline movers](docs/spline-movers.md) adds detached subway/chairlift copies,
arc-spaced playback, route-aware activation and one-pixel running cables.
[Deferred world interactions](docs/deferred-world.md) adds checklist counters,
contact-gated glass cracking/shatter, paired support removal and private material
frames, with old-import frame recovery and no ISO re-import.
[Material playback](docs/material-playback.md) adds fixed-tick UV scroll and
per-instance flip/pulse/dwell clocks with receiver controls and lifecycle teardown.
[Crowd playback](docs/crowd-playback.md) adds shared spectator art, independently
phased material cells, activity/rest laws, cutout drawing and safe map supplements.
Configured Maps now render fixed-tick carve, powder and landing/skid cloud
sprites. Fresh ISO imports stage the particle bank and `RidingEffects.json`;
existing maps can provide the same profile and their own PNG. See
[riding effects](docs/riding-effects.md) for the implemented layers and limits.
Supported ground surfaces also leave a bounded textured wake, narrow while
riding straight and wider through a carve. See [carved wake](docs/carved-wake.md)
for the surface table, contact probes, two alpha passes and open tuning bindings.
Grounded carves also throw a connected four-rail additive ribbon; see
[spray sheet](docs/spray-sheet.md) for implemented behavior and provisional tuning.
Terrain now uses hierarchical frustum selection and adaptive index submission.
`--no-terrain-culling` provides a desktop comparison path; see
[terrain culling](docs/terrain-culling.md) for measurements and remaining limits.
See [graphics quality](docs/graphics-quality.md) for verification and limits.
A course can be opened directly:

```powershell
./temp/native/Release/openslope_player.exe --map Maps/GARI
./temp/native/Release/openslope_inspect.exe Maps/GARI
```

Populated Maps audio plays through the native mixer: board/landing sounds, admitted
contact and ambient routes, and complete music graphs. M mutes; pause and focus
loss also pause audio. `--no-audio` disables device playback. Old music graphs
without variable-remap data need re-import with the independent audio utility.
Mounting crossfades from the environment/intro to a run-selected song. Authored
`Music/track.wav` and its loop arrangement stream on desktop and Quest;
see [music lifecycle](docs/music-playback.md).
The desktop and wrist **Audio** menus provide volume, music enable and per-course
song selection, saved between sessions. M restores the previous audible volume;
see [audio settings](docs/audio-settings.md).
See [native audio](docs/audio-playback.md) for supported contracts, capture/testing
commands, extraction tools and remaining music/speech work. A fresh ISO import now
stages the configured banks, music graph/chunks, loop banks and intro stems;
see [audio import](docs/audio-import.md) for the remaining resolver limits.

Courses with AIP/SOP metadata use the middle authored start-row slot and its down-course heading.
Fallbacks use the staging anchor, race line and finally the highest rideable patch. The desktop
drop-in begins one metre above the surface. See [desktop controls](docs/desktop-controls.md).
Map courses load their referenced
`Textures/*.png` and `Lightmaps/*.png`; missing diffuse images retain surface/normal colours,
and a missing lightmap leaves the diffuse texture visible. See [terrain appearance](docs/terrain-appearance.md).
Courses with the prop contracts also render their referenced `Meshes/*.obj` and textures with
per-instance lighting. Collision uses authored proxy/body assets and local boxes. Hard prop impacts
enter wipeout followed by animated relative get-up; R also resets. See
[static props](docs/static-props.md) and [world contact](docs/world-contacts.md).

Offline GPU validation requires no visible window or headset:

```powershell
./temp/native/Release/openslope_player.exe --capture temp/native/demo.ppm --seconds 2
```

The output is a PPM image generated by the actual Vulkan pipeline.
The same capture supports `--map Maps/GARI`. Authored GPU pixel checks can also run locally:

```powershell
python Native/tests/appearance_test.py temp/native/Release/openslope_appearance_tests.exe temp/native/Release/openslope_render_tests.exe
```

These checks use synthetic PNGs and exercise the production Vulkan shaders with both UNORM and
sRGB output targets. They require a Vulkan GPU and are separate from the portable CPU CI checks.

## OpenXR

```powershell
./temp/native/Release/openslope_player.exe --xr
./temp/native/Release/openslope_player.exe --xr --map Maps/GARI
```

Use an active OpenXR runtime and a connected headset. Errors are reported if no headset is
available. The host creates the Vulkan instance/device through `XR_KHR_vulkan_enable2`, uses
runtime-selected stereo views and swapchain formats, and pauses simulation outside input focus.
VR starts on foot: left stick walks, B runs, A jumps and either trigger mounts a nearby
board. A trigger while riding steps off. X recalls the board on foot and resets the course
while mounted. B boosts while riding. Touch-compatible bindings are the
initial profile; dedicated Steam Frame bindings and device-specific extensions remain device work.
Right A charges/releases the jump, and left-stick Y controls posture/flip when vertically dominant.
Locomotion rotates the world camera by heading without applying board bank to the tracked head.
Air trick rotation stays out of the camera frame.

The current renderer serializes GPU work and draws the two eyes separately. This intentionally
simple first renderer shares geometry and sampled images between eyes, but needs profiling, multiview and optional foveation
before any claim of headset performance. It does not request Meta-only rendering extensions.

## Android / Quest build path

The Android host uses a Java map-library panel, `NativeActivity` and the Khronos loader. Selecting
a course prepares its terrain, prop/path tables, referenced meshes and PNGs, then starts the immersive player.
The Gradle project targets ARM64, Android API 29+, NDK 28.1, CMake 3.31.6, and Android SDK 35.
Use JDK 17 and Gradle 8.10.2 with Android Gradle Plugin 8.8.2. The SDK/NDK and Gradle are separate
prerequisites; no system-wide installer is run by the host build.

On Windows, the optional setup script downloads checksum-verified official packages into the
ignored `.openslope/native-android/` directory. It does not change system-wide installations:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Native/setup-android.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File Native/build-android.ps1
```

`android/toolchain-windows.json` records the pinned URLs and publisher checksums. The setup
downloads roughly 1 GiB of archives and retains the tools for subsequent builds.

Build the host player first: it generates portable SPIR-V headers under `temp/native/generated/`.
Then configure `Native/android/local.properties` with `sdk.dir` and run:

```text
gradle -p Native/android assembleDebug
adb install Native/android/app/build/outputs/apk/debug/app-debug.apk
```

The ARM64 Android build is verified with the isolated Windows toolchain. The debug-signed APK
contains no retail assets. Installation, the actual JNI importer and local/custom SAF library
contracts have connected-Quest evidence. The user imported ALASKA with the system picker and
played build 0.14.0. Build 0.19.0 launches that existing course and initializes optional tracking;
live stereo/body poses, controller interaction and performance need targeted device testing.

After installation, find **OpenSlope Native** in the headset's sideloaded applications:

1. **Choose Maps folder** selects the root that contains course subfolders. Access is remembered.
   **Use app Maps folder** selects `/sdcard/Android/data/org.openslope.nativeplayer/files/Maps/`.
2. Existing `Maps/<name>/Patches.json` courses appear as **Play <name>** buttons. Custom maps work
   immediately without selecting an ISO. Use **Refresh courses** after adding files outside the app.
3. **Import from ISO** opens the system file picker, discovers supported SSX/SSX Tricky courses, and lets
   you select which to import into the current Maps folder. Existing map names are kept. Cancel
   stops the current course; courses already imported remain available.
   To refresh an old import, choose **Unload** beside that course and confirm, then import it again.
   Unload deletes that course's folder, including local edits; other courses stay available.
4. **Play** validates the selected terrain, props and PNGs, then loads them into the immersive OpenXR activity.
   You start on foot; either trigger mounts the nearby board. Left stick walks, B runs and A jumps.
   Once mounted, stick steers/postures, B boosts and A charges/releases a jump. Either trigger dismounts;
   X resets beside the board. On foot X recalls the equipment without moving you.
   Returning from the game returns to the library.

System document providers must support seekable ISO reads and writable/renameable folders for import.
If the headset has no system document picker, custom maps can still be copied into the app Maps folder
over USB/ADB. For development: `adb push Maps/GARI /sdcard/Android/data/org.openslope.nativeplayer/files/Maps/`.
Terrain, static props, diffuse textures and baked lighting are consumed by this prototype;
no retail data belongs in the APK or a release.

The same importer can be checked on desktop without a headset:

For repeatable extraction timings, stage profiles, and baseline comparisons, see
[ISO import performance](docs/import-performance.md). The benchmark also builds
for ARM64 Android; current measurements and device verification limits are recorded there.

```powershell
./temp/native-core/Release/openslope_import.exe list "discs/SSX Tricky (USA).iso"
./temp/native-core/Release/openslope_import.exe extract "discs/SSX Tricky (USA).iso" GARI temp/native-import/Maps
python tools/native/native-compare-maps.py temp/native-import/Maps/GARI Maps/GARI --point-tolerance-cm 0.1 --allow-texture-difference 0083.png --allow-texture-difference 0108.png
python tools/native/native-compare-props.py temp/native-import/Maps/GARI Maps/GARI
python tools/native/native-compare-paths.py temp/native-import/Maps/GARI Maps/GARI
```

The comparison checks the implemented canonical stages against an existing reference map,
comparing decoded PNG pixels and JSON values rather than formatting or compression. It does not
claim equivalence for the deferred import stages.
The GARI example explicitly records a 1 mm coordinate allowance and the two documented alpha-policy
differences; the comparator's defaults remain strict. See [source provenance](docs/source-provenance.md).
Previously imported terrain-only courses remain playable. To add extracted props and course paths, import into a
fresh Maps root; existing course names are deliberately skipped rather than overwritten.

Build the separate device-test APK with `Native/build-android.ps1 -Tests`. The authored synthetic
ISO fixture is generated into ignored build assets and is included only in that test APK:

```text
adb install -r Native/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r Native/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w org.openslope.nativeplayer.test/org.openslope.nativeplayer.NativeImportInstrumentation
```

These tests exercise the actual ARM64 JNI importer, local custom-map discovery, and folder
publication/playback/cancellation through a test document provider, including copying referenced
textures, lightmaps and prop meshes and removing an interrupted play cache. They do not exercise the
headset's own picker UI or immersive rendering. They pass 52 checks on the connected Quest 3.
The same runner accepts `-e vr true -e course ALASKA -e seconds 18` for a bounded local-course
activity smoke check; see [boarding validation](docs/boarding.md) for its evidence limits.

## Portable checks

```text
npm run verify:native
```

On Linux, CMake 3.24+, Python 3 and a C++20 compiler are required. The core has no graphics, Android,
OpenXR, or game-engine dependency. CI builds and tests it on Windows and Linux. With the player
enabled, the Linux host runs OpenXR directly; it is the intended native Linux ARM64 path for
Steam Frame, pending target compilation and device verification.

Tests cover independent carving-response fixtures, source-axis conversion, curved analytic
contact, closest-hit selection, no-collision surfaces, spring units and damping, speed-preserving
redirect, and fixed 60 Hz simulation at 72/90/120/144 Hz presentation rates. Tests fail in Release
builds too; they do not rely on `assert`. Synthetic disc tests cover ISO9660, both BIG variants,
all RefPack commands, canonical patches, decoded RGBA PNGs, provenance, cancellation, invalid
inputs, map discovery and protection of existing courses. They require no retail disc or assets.
Appearance checks cover PNG variants, corrupt/oversized images, image path bounds, diffuse corner
pairing, transposed lightmap UVs, material grouping, and the RGB-residual/alpha lighting equation.
Prop checks cover shared OBJ geometry, hierarchy, instance lighting/transforms, visibility/culling,
static animation snapshots, material indirection and independently authored VIF packets.
Gameplay checks cover separate jump control, countdown/carry, spins/flips, switch, landing bands,
swept terrain contact, focus clearing, braking and authored starts. Independent AIP/SOP fixtures
cover displacement expansion, event records and corrupt-input cleanup.

For a complete charged jump/half-spin/switch landing through the actual desktop renderer:

```powershell
python Native/tests/desktop_replay_test.py temp/native/Release/openslope_player.exe
```

The bounded replay interface and its limits are described in [desktop controls](docs/desktop-controls.md).

## Formatting

`Native/.clang-format` sets the C++ style. It is pinned to clang-format 23.1.3, because other
versions can format slightly differently:

```powershell
uv tool install clang-format==23.1.3
```

`git clang-format` formats only the lines changed since `HEAD`. To reformat every native source:

```powershell
clang-format -i (git ls-files 'Native/src/*.?pp' 'Native/include/*.hpp' 'Native/tests/*.?pp')
```

Formatting-only commits are listed in `.git-blame-ignore-revs`. GitHub skips them in blame views;
run `git config blame.ignoreRevsFile .git-blame-ignore-revs` to do the same for local `git blame`.

## Specification alignment

Trailmap's clean behavioral chapter bodies are the implementation authority. The tracked
`Contracts/ride-v1.json` is embedded at build time; there is no separate hand-maintained surface
table. See [specification alignment](docs/spec-alignment.md) for implemented slices, differences
from existing ports, and explicit prototype choices. No Trailmap installation or disc is required
to build or run the synthetic tests. When the local Trailmap data files are present, the native
check also requires the tracked ride contract and independent fixtures to match them exactly.

Authored prop contacts, recovery, rails, avatar presentation and walking now run in desktop gameplay.
Remaining world logic, races/tricks, presentation, audio/effects and graphics/performance stay in the
desktop-parity.md matrix. The user reports successful initial Quest play on 0.14.0.
Targeted headset checks continue alongside desktop implementation. Sky import,
camera-centred panorama and fog are described in [world appearance](docs/world-appearance.md).
Build 0.43 automatically recovers the selected course's sun and sky settings
during native ISO import. See [world settings import](docs/world-settings-import.md)
for the independent reader, existing-map handling and validation limits.
Build 0.44 also recovers collision-event sound routes from the user's executable;
see [collision audio import](docs/collision-audio-import.md).
Build 0.45 recovers the board surface-family map into each imported course's
Audio folder; see [board audio import](docs/board-audio-import.md).
Hard landings, prop crashes and animated relative get-up are described in
[crash recovery](docs/crash-recovery.md), including provisional pose/physics tuning.
Keep platform file access behind the application host,
so the readers and gameplay core can also be compiled for desktop tools or WebAssembly.
Game-specific readers live under `src/import/`; see
[importer architecture](docs/importer-architecture.md) for the folder layout,
shared container layer and steps for adding another game.

See [NOTICE](NOTICE) and [third-party notices](ThirdPartyNotices/README.md).
See [source provenance](docs/source-provenance.md) for the implementation and dependency boundary.

The desktop and VR player support all seven Slopesmith avatars and custom GLBs,
with a saved Avatar selector. Windows defaults to a random rider; Quest defaults
to Stick Figure. F/V switches to first person; hold C to look down. VR controller models show control labels,
and supported Quest runtimes can supply upper-body/full-body joints. See
[avatar presentation](docs/avatar.md) for API support, fallbacks and validation.

Timed events are available through `--mode race|showoff` or the Quest library's
Event selector. Mount to start riding and the clock immediately; Race counts up and Showoff counts
down with checkpoint time awards. T restarts on desktop; Y toggles the Quest controls display. The desktop title and left VR
controller panel show clock/state. See [course runs](docs/course-runs.md) for
the course metric, finish/lap rules, authored settings and remaining race systems.
