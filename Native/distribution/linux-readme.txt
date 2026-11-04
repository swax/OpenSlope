OpenSlope Native for Linux x64

Extract the complete archive, then run ./Play\ OpenSlope.sh (or openslope_player).
Requires a Vulkan-capable graphics driver, glibc 2.35+ and libstdc++ from GCC 11+.
X11 and Wayland are supported through SDL3. Audio uses the available system backend.
The file picker may require an XDG desktop portal or Zenity.

Choose disc in the library to import your own local ISO/BIN/GCM/RVZ/GBA image.
Custom maps also work without a disc. Maps and import caches are stored in
$XDG_DATA_HOME/OpenSlope (normally ~/.local/share/OpenSlope), outside the download.
Settings use $XDG_CONFIG_HOME/OpenSlope (normally ~/.config/OpenSlope).

Controls and settings are in the pause menu. The archive also includes
openslope_import and openslope_inspect for command-line use. Run openslope_import
without arguments for usage, or openslope_inspect /path/to/Maps/COURSE to inspect a map.
No disc images or extracted courses are included.
