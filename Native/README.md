# OpenSlope Native

**Ride OpenSlope courses in a standalone desktop or Quest app.** Native plays original maps
from [Slopesmith](../Slopesmith/README.md) and imports courses locally from supported game
images. It shares OpenSlope's portable map format and needs no disc for original courses.

The player is experimental. See the [feature and parity matrix](docs/desktop-parity.md) for
implemented systems, known gaps and device validation.

## Download and play

Choose a Native package from the [OpenSlope releases](https://github.com/swax/OpenSlope/releases?q=native-v).

| Platform | Start the app |
|---|---|
| Windows x64 | Extract the whole ZIP into a writable folder and open `OpenSlope.exe`. Requires Windows 10/11 and a Vulkan graphics driver. |
| Linux x64 | Extract the archive and run `Play OpenSlope.sh` or `openslope_player`. See the [Linux requirements](distribution/linux-readme.txt). |
| macOS | Choose Apple Silicon or Intel, then move `OpenSlope.app` to Applications and open it. Requires macOS 11+ and a Metal-capable GPU; MoltenVK is bundled. |
| Standalone Quest | Sideload the APK, then open **OpenSlope Native** from the headset's sideloaded applications. |

1. Add a custom map as `Maps/NAME/Patches.json` with its accompanying files, or use **Choose disc**
   on desktop / **Import from ISOs** on Quest to import courses from your own supported image.
   On Quest, **Choose Maps folder** or **Use app Maps folder** selects your library.
2. Choose **Game → Map**, then **Play**. Selecting a map does not start a ride or an import.
3. Open the pause menu on desktop or wrist menu on Quest for controls, avatar, graphics and audio settings.

On Windows, the Maps folder lives beside the executable. Linux and macOS keep maps outside the
application; see [library storage](docs/building.md#desktop-storage). On Quest, the library remembers
the chosen folder. The [map-library guide](docs/map-library.md) covers imports, refresh and recovery.

Desktop basics: **WASD** moves or steers, **E** mounts/dismounts, **Space** jumps, **Shift** boosts,
and **Escape** opens the menu. On Quest, walk with the left stick and mount a nearby board with
either trigger; **A** jumps and **B** boosts while riding. See the
[desktop controls](docs/desktop-controls.md) and [Quest controls](docs/equipment-camera-ui.md) for the full mappings.

For PC VR on Windows, set an active OpenXR runtime and launch **Play in VR.cmd**. Linux also has
an optional OpenXR host; the macOS package supports desktop play. See [OpenXR setup](docs/building.md#openxr).

## Documentation

- [Documentation index](docs/README.md) — player guides, supported imports and implementation details.
- [Build from source](docs/building.md) — Windows, Linux, macOS and Android/Quest.
- [Testing](docs/testing.md) and [development](docs/development.md) — validation, formatting and source boundaries.
- [Release notes](releases/) and [release packaging](docs/releases.md) — changes, distribution and signing.

## Content and license

No game content is bundled. Keep disc-derived courses local/private; use original or rights-cleared
assets for maps you share. See [LEGAL.md](../LEGAL.md).

OpenSlope is independent and unofficial. Native is licensed under [Apache-2.0](LICENSE);
see [NOTICE](NOTICE) and [third-party notices](ThirdPartyNotices/README.md).
