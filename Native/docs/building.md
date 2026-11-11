# Build and run Native

Use a [release package](../README.md#download-and-play) to play without a compiler.
The instructions below build from source. Run commands from the OpenSlope repository root.
No disc image or local research workspace is required to build the player.

## Windows

Install Visual Studio 2022 C++ Build Tools with its CMake component and Windows SDK, plus
Python 3 for embedding compiled shaders. The build locates Visual Studio even when CMake
is absent from `PATH`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Native/build.ps1 -Player
./temp/native/Release/openslope_player.exe
```

Dependencies download into the ignored build tree from version- and SHA-256-pinned archives.
An optional local archive cache lives at `.openslope/native-downloads/`.
The build script also runs the configured conformance checks.

Without `--map`, the desktop player opens its map library. To open or inspect a map directly:

```powershell
./temp/native/Release/openslope_player.exe --map Maps/MYMAP
./temp/native/Release/openslope_inspect.exe Maps/MYMAP
```

Use `--on-foot` to start beside the board. See [desktop controls](desktop-controls.md) for
input, capture and replay options, and [graphics quality](graphics-quality.md) for rendering limits.

## Linux and macOS

Install CMake 3.24+, Python 3 and a C++20 compiler. Linux needs GCC 11+ or Clang, plus the
X11/Wayland and audio development packages listed in the
[release workflow](../../.github/workflows/native-release.yml). macOS needs Xcode command-line
tools. Dependencies use checksum-pinned archives; the macOS build includes MoltenVK.

```sh
cmake -S Native -B temp/native-desktop -DCMAKE_BUILD_TYPE=Release -DOPENSLOPE_BUILD_PLAYER=ON
cmake --build temp/native-desktop --parallel 4
ctest --test-dir temp/native-desktop --output-on-failure
```

On Linux:

```sh
./temp/native-desktop/openslope_player
```

On macOS:

```sh
open temp/native-desktop/openslope_player.app
```

All desktop platforms share the library, controls, imports and settings. macOS defaults to
desktop-only; `OPENSLOPE_BUILD_OPENXR` controls the optional OpenXR host on other platforms.
See [release packaging](releases.md) for portable archives and Apple signing/notarization.

### Desktop storage

| Platform | Maps and import cache |
|---|---|
| Windows | Beside the executable, under `Maps/` and the local import cache. |
| Linux | `$XDG_DATA_HOME/OpenSlope`, normally `~/.local/share/OpenSlope`. Settings use `$XDG_CONFIG_HOME/OpenSlope`. |
| macOS | `~/Library/Application Support/OpenSlope`, outside the app bundle. |

Use `--library-root <folder>` to choose another location. Updating Linux/macOS binaries preserves
their external data. For a Windows release update, move the existing Maps folder beside the new
executable. See [import caching](import-cache.md) for invalidation, reuse and cancellation.

## OpenXR

Set an active OpenXR runtime and connect a headset, then run:

```powershell
./temp/native/Release/openslope_player.exe --xr
./temp/native/Release/openslope_player.exe --xr --map Maps/MYMAP
```

The host reports an error if no headset is available. It creates the Vulkan instance/device
through `XR_KHR_vulkan_enable2`, uses runtime-selected stereo views and swapchain formats, and
pauses simulation outside input focus. VR starts on foot. See
[equipment, camera and UI](equipment-camera-ui.md) and [VR steering](vr-steering.md) for controls
and device-validation limits. Windows release packages provide **Play in VR.cmd** for this path.

## Android and Quest

The Android host combines a Java library panel, `NativeActivity` and the Khronos loader.
The project targets ARM64, Android API 29+, NDK 28.1, CMake 3.31.6 and Android SDK 35.
Use JDK 17, Gradle 8.10.2 and Android Gradle Plugin 8.8.2.

On Windows, the optional setup script installs checksum-verified official packages into the
ignored `.openslope/native-android/` directory without changing system-wide installations.
The pinned URLs and publisher checksums are in
[`android/toolchain-windows.json`](../android/toolchain-windows.json); the download is roughly 1 GiB.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Native/build.ps1 -Player
powershell -NoProfile -ExecutionPolicy Bypass -File Native/setup-android.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File Native/build-android.ps1
```

For a manually configured toolchain, build the host player first to generate SPIR-V headers
under `temp/native/generated/`. Set `sdk.dir` in `Native/android/local.properties`, then run:

```text
gradle -p Native/android assembleDebug
adb install Native/android/app/build/outputs/apk/debug/app-debug.apk
```

The debug APK contains no retail assets. Public APKs use the separate
[release and signing process](releases.md).

After sideloading, open **OpenSlope Native**. Choose an existing Maps folder or **Use app Maps folder**
for `/sdcard/Android/data/org.openslope.nativeplayer/files/Maps/`. Custom courses work without an image.
**Import from ISOs** uses the system picker to import selected courses; **Play** enters the immersive
activity. See [Quest first use](quest-launcher.md) and the [library storage contract](map-library.md)
for folder permissions, seekable-image requirements and copying files over USB/ADB.

## Inspect and compare an import

The same C++ importer runs on desktop, Android and in Slopesmith's browser worker. A core-only
Windows build places its command-line tools under `temp/native-core/Release/`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File Native/build.ps1
./temp/native-core/Release/openslope_import.exe list "discs/SSX Tricky (USA).iso"
./temp/native-core/Release/openslope_import.exe extract "discs/SSX Tricky (USA).iso" GARI temp/native-import/Maps
python tools/native/native-compare-maps.py temp/native-import/Maps/GARI Maps/GARI --point-tolerance-cm 0.1 --allow-texture-difference 0083.png --allow-texture-difference 0108.png
python tools/native/native-compare-props.py temp/native-import/Maps/GARI Maps/GARI
python tools/native/native-compare-paths.py temp/native-import/Maps/GARI Maps/GARI
```

Comparison requires an existing reference map. It checks decoded PNG pixels and JSON values;
it does not claim equivalence for deferred stages. This GARI example records a 1 mm allowance
and two alpha-policy differences; comparator defaults remain strict. See
[source provenance](source-provenance.md) for that boundary and
[import performance](import-performance.md) for stage profiling and ARM64 benchmarks.

Existing course names are preserved rather than overwritten. To update an old import, use a
fresh Maps root or explicitly unload that course first. Unload deletes its folder, including
local edits; back up edits before replacing an import.
