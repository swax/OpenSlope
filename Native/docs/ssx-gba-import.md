# SSX Tricky GBA import

The shared C++ importer accepts `.gba` images of SSX Tricky AXYE revision 0.
Slopesmith's game-library picker, the Windows file picker and Quest's document picker
use this importer. The game appears separately as **SSX Tricky (GBA)**, with
eight named courses. Loading a ROM preserves a previously selected PS2 disc.

Choose the ROM, load a course, then choose Play or Inspect. Source images and
converted assets stay on the device. Native installed libraries group the
converted maps under the same game name. Existing packaged clients need a
build containing this importer; no server-prepared map bank is required.

## Converted content

The adapter emits the ordinary portable map files, including textured terrain,
static scenery, collision, a supported start and route, editable grind splines,
sky assets, riding sound banks and music graphs. Browser, Windows and Quest
consume the same output. Scanning reads only bounded catalogue metadata;
extraction supports cancellation and refuses existing destinations.

The accepted calibration is 0.1 metres per source unit. Compatible textured
triangle pairs become bilinear bicubic patches when their angle is at most
20 degrees and the geometric deviation is at most 0.05 m. Other opaque
triangle surfaces retain their exact geometry as collapsed patch edges.
Terrain frames face skyward for one-sided analytic contact. Mixed source
triangle winding is corrected by transposing the control net and UV corners
together. Slopesmith applies the same correction when reading older cached
GBA maps, so those courses do not require another extraction. Browser start
placement also seats exact section boundaries within half a metre inside the
existing patch, avoiding Float32 edge misses during drop-in.
Cutout scenery retains its native texture orientation and transparent pixels.
These are reconstructed editable surfaces, rather than recovered authoring
controls. The optional local [Trailmap chapter](../../Trailmap/specs/610-tricky-gba.md)
describes the source formats and corrected course-name lookup.

Grind lines follow native marked cap triangles, excluding almost vertical
supports. Straight cubic spans retain the source bends, with small endpoint
seams joined. Their metal material and acquisition behavior use OpenSlope's
riding system. No additional visible rail mesh is generated.

The recovered tiled horizon is wrapped onto a dome with authored sky fill.
All 23 PCM effects are retained. Native jump, landing and pickup feedback is
adapted to the common riding banks; snow, carving, grinding and air beds are
authored noise. The original hardware noise generator is not emulated.

Ten recovered music arrangements use bounded WAV chunks and the standard
music player. Each arrangement preserves one complete native playlist cycle.
Converted music is reusable across course imports. Default arrangement order
is an adaptation; original course-to-music selection remains unverified.

## Limits and validation

Support is preliminary and specific to the recognized revision. Native pickup
and checkpoint placements, event billboards and original animation/audio
scheduling remain deferred. Imported courses support ordinary riding, editing
and grinding; their source event scripts are not executed.

`native_ssx_gba_import` uses authored ROM fixtures for all eight course names,
textures, protected creases, collision, media, malformed input and cleanup.
Its native probe checks ground support through drop-in, spawn/reset, moving
rail acquisition, soundtrack playback, bounded discovery reads and cancellation. `iso-library.test.ts`
also chooses a `.gba` through `/isos`, loads and rides Garibaldi with music, checks reload
persistence and keeps the PS2 source separate. Local owner-ROM validation
covers all eight courses and compares music sample counts against the earlier
native-decoder study. Extracted assets and reports remain outside Git.
`native_desktop_library` also checks case-insensitive `.GBA` discovery, external
source selection, installation and preservation of locally edited course files.
