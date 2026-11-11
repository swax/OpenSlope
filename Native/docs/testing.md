# Testing Native

Choose checks for the changed behavior using the
[repository validation policy](../../CONTRIBUTING.md#routine-development).
Run commands below from the repository root. Synthetic checks require no game assets.

## Portable checks

```text
npm run verify:native
```

The portable core needs CMake 3.24+, Python 3 and a C++20 compiler. It has no graphics,
Android, OpenXR or game-engine dependency. CI builds and tests it on Windows and Linux.
The suite includes:

- independent carving fixtures, source-axis conversion, analytic and swept terrain contact,
  closest-hit selection, surface response, spring units and fixed-step simulation;
- synthetic ISO9660/BIG/RefPack data, PNG decoding, provenance, cancellation, invalid input,
  map discovery and protection of existing courses;
- image bounds, texture/lightmap pairing, lighting equations, prop geometry, transforms,
  material indirection and independently authored VIF fixtures;
- charged jumps, spins/flips, switch landings, focus clearing, braking, starts and AIP/SOP paths.

Checks remain active in Release builds and do not depend on `assert`.
The tracked `Contracts/ride-v1.json` and reference cases supply shared inputs. If the optional
local research data is present, the native check also verifies that those tracked views match it.
No research workspace is needed for a fresh checkout's synthetic tests.

## Desktop rendering and replay

Build the player using the [build guide](building.md). An offscreen capture uses the real Vulkan
pipeline and needs no visible window or headset:

```powershell
./temp/native/Release/openslope_player.exe --capture temp/native/demo.ppm --seconds 2
```

Add `--map Maps/MYMAP` to capture a specific map. Authored pixel checks use synthetic PNGs
and exercise production shaders with UNORM and sRGB targets:

```powershell
python Native/tests/appearance_test.py temp/native/Release/openslope_appearance_tests.exe temp/native/Release/openslope_render_tests.exe
```

These checks require a working Vulkan GPU and are separate from portable CPU checks.
For a charged jump, half-spin and switch landing through the desktop renderer:

```powershell
python Native/tests/desktop_replay_test.py temp/native/Release/openslope_player.exe
```

See [desktop controls](desktop-controls.md) for the bounded replay interface and its limits.
Mac CI probes Metal buffer and placement-heap support before GPU smoke checks. Hosts that
cannot run those checks still build, run portable/audio checks and verify packages, with the
GPU limitation recorded in release metadata.

## Android device checks

Build the separate test APK with `Native/build-android.ps1 -Tests`. Its synthetic ISO fixture
is generated into ignored build assets and included only in the test APK.

```text
adb install -r Native/android/app/build/outputs/apk/debug/app-debug.apk
adb install -r Native/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w org.openslope.nativeplayer.test/org.openslope.nativeplayer.NativeImportInstrumentation
```

Instrumentation exercises the ARM64 JNI importer, local custom-map discovery, folder
publication/playback/cancellation, referenced-asset copying and interrupted-cache cleanup
through a test document provider. It does not exercise the headset's own picker UI or
immersive rendering. The same runner accepts `-e vr true -e course ALASKA -e seconds 18`
for a bounded local-course activity check; see [boarding validation](boarding.md) for evidence limits.

## Feature and device coverage

The [parity matrix](desktop-parity.md) and individual [feature documents](README.md) record
implemented behavior, validation and remaining work. Short automated samples and historical
playtests do not establish complete gameplay or headset coverage.
