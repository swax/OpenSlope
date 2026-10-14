# OpenSlope Native

Experimental C++20 player for portable OpenSlope maps, with a Vulkan renderer and OpenXR host.
Windows desktop rendering and portable conformance tests are the local validation targets.
The ARM64 Android APK builds, and the user reports successful Quest play after importing ALASKA
inside the app. Build 0.21.0 reaches 71.5–72 fps in a focused Quest 3 ALASKA sample with
4x MSAA and live full-body tracking; the user confirms walking/boarding and improved performance.
Longer rides, comfort and wider headset coverage still need testing.
The Linux host still needs target build/device validation. Full gameplay parity remains
tracked in the matrix below.

The desktop player starts on an original procedural slope, or reads a local `Maps/<NAME>/Patches.json`.
The Quest app starts with a Maps library: choose a populated folder, or select a local SSX Tricky PS2
ISO to add courses. No ISO is required to browse and play custom maps. No retail content is packaged.
The importer currently converts terrain, textures, lightmaps, static prop geometry/placements,
AIP/SOP course paths, collision proxies/physics bodies, configured sound/music assets and provenance. The player renders textured
terrain and shared world props, supports charged jumps, spins/flips and switch landings, and uses
authored prop contacts for bounce, ride surfaces and pass-through events. Animated crash recovery,
analytic rails, timed runs, spin/flip/rail scoring and the visible stick figure are implemented. Quest starts on foot
beside the board, with walking/jumping and nearby mounting. Live prop behavior, executable audio
resolvers, grabs, pickups/uber tiers, AI races and multiplayer remain later stages. See
[the map-library contract](docs/map-library.md) and [desktop parity matrix](docs/desktop-parity.md).

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
F/V switches first/chase camera, C looks down, G mounts/dismounts, P pauses and Escape exits.
Use `--on-foot` to start beside the board; A/D/W/S walk, Shift runs and Space jumps in that mode.
See [walking and boarding](docs/boarding.md). Input pauses when the preview loses
focus; an uncommitted jump charge is cancelled.

Desktop rendering defaults to 4x MSAA, falling back to a supported colour/depth
sample count. Use `--msaa 1`, `2`, `4` or `8` for window or capture mode.
OpenXR also defaults to 4x MSAA. The Quest launcher offers 100%, 125% and 150% of
the runtime's recommended eye dimensions, plus Off/2x/4x edge smoothing. Start at
100%/4x; higher resolution increases attachment memory and GPU cost.
Quest's **Riding steering** selector offers Stick only or Head + stick override.
Head mode uses look-to-carve with a neutral zone; the stick takes priority when
deflected. See [VR steering](docs/vr-steering.md) for controls, view carry and
remaining headset validation. Timed runs now bank spin/flip and rail tricks and
spend/refill boost; see [trick scoring](docs/trick-scoring.md) for exact scope.
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
VR starts on foot: left stick walks, right trigger runs, right A jumps and B mounts a nearby
board. B while riding steps off; X resets to the on-foot start. While riding, left stick
steers and right trigger boosts. Touch-compatible bindings are the
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
3. **Import SSX Tricky ISO** opens the system file picker, discovers supported courses, and lets
   you select which to import into the current Maps folder. Existing map names are kept. Cancel
   stops the current course; courses already imported remain available.
4. **Play** validates the selected terrain, props and PNGs, then loads them into the immersive OpenXR activity.
   You start on foot; right B mounts the nearby board. Left stick walks, trigger runs and A jumps.
   Once mounted, stick steers/postures, trigger boosts and A charges/releases a jump. B dismounts;
   X resets beside the board.
   Returning from the game returns to the library.

System document providers must support seekable ISO reads and writable/renameable folders for import.
If the headset has no system document picker, custom maps can still be copied into the app Maps folder
over USB/ADB. For development: `adb push Maps/GARI /sdcard/Android/data/org.openslope.nativeplayer/files/Maps/`.
Terrain, static props, diffuse textures and baked lighting are consumed by this prototype;
no retail data belongs in the APK or a release.

The same importer can be checked on desktop without a headset:

```powershell
./temp/native-core/Release/openslope_import.exe list "discs/SSX Tricky (USA).iso"
./temp/native-core/Release/openslope_import.exe extract "discs/SSX Tricky (USA).iso" GARI temp/native-import/Maps
python tools/native-compare-maps.py temp/native-import/Maps/GARI Maps/GARI --point-tolerance-cm 0.1 --allow-texture-difference 0083.png --allow-texture-difference 0108.png
python tools/native-compare-props.py temp/native-import/Maps/GARI Maps/GARI
python tools/native-compare-paths.py temp/native-import/Maps/GARI Maps/GARI
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
Hard landings, prop crashes and animated relative get-up are described in
[crash recovery](docs/crash-recovery.md), including provisional pose/physics tuning.
Keep platform file access behind the application host,
so the readers and gameplay core can also be compiled for desktop tools or WebAssembly.

See [NOTICE](NOTICE) and [third-party notices](ThirdPartyNotices/README.md).
See [source provenance](docs/source-provenance.md) for the implementation and dependency boundary.

The desktop and VR player now use the first-party stick figure avatar. F/V switches
to first person; hold C to look down. VR controller models show control labels,
and supported Quest runtimes can supply upper-body/full-body joints. See
[avatar presentation](docs/avatar.md) for API support, fallbacks and validation.

Timed events are available through `--mode race|showoff` or the Quest library's
Event selector. Mount to start the countdown; Race counts up and Showoff counts
down with checkpoint time awards. T/Y restarts. The desktop title and left VR
controller panel show clock/state. See [course runs](docs/course-runs.md) for
the course metric, finish/lap rules, authored settings and remaining race systems.
