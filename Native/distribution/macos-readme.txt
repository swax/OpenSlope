OpenSlope Native for macOS

Move OpenSlope.app to Applications or another folder, then open it.
Download the arm64 build for Apple Silicon or the x64 build for an Intel Mac.
Requires macOS 11 or later and a Metal-capable GPU. MoltenVK is included;
no Vulkan SDK or Homebrew installation is required. This build supports desktop play.

The release manifest and notes state whether the app is Developer ID signed and
Apple notarized. An ad-hoc-signed preview may be blocked by Gatekeeper; review
the source and use Apple's Privacy & Security controls only if you trust the build.

Choose disc in the library to import your own local ISO/BIN/GCM/RVZ/GBA image.
Custom maps also work without a disc. Maps, import caches and settings are stored
in ~/Library/Application Support/OpenSlope, outside the app, and survive app updates.
Controls and settings are in the pause menu.

Command-line tools are inside OpenSlope.app/Contents/MacOS: openslope_import and
openslope_inspect. Run openslope_import without arguments for usage, or pass a map
folder to openslope_inspect. No disc images or extracted courses ship.
