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

The course scale is 0.15625 metres per source unit, 56.25% larger than the original
0.1-metre calibration. Terrain, scenery, collision, routes and rails share this
conversion. Re-load older cached maps to regenerate them at the larger scale.
Adjacent opaque terrain triangles with compatible materials, UVs and surface
flags combine into one convex quad. Pairing starts with square-like quads, then
rearranges compatible neighbours along alternating paths to maximize the number
of paired faces. Mixed source winding and repeated vertices at seams are handled.
Material and UV boundaries, sharp creases and concave outlines remain protected.
Faces without a compatible partner stay as one triangular patch each; they are
never divided into three smaller quads. Every source triangle is accounted for
once, and paired patches retain both source record IDs.

Area-weighted slope fields join across source edges at up to 20 degrees,
including texture and material seams. Shared cubic boundary curves and four
fitted interior height controls turn the faceted source into curved terrain.
The fit follows the curved source triangles while encouraging a common tangent
plane at gentle joins. Steep walls and high-angle creases retain their source
profile. Horizontal footprints stay fixed, and interior displacement is bounded
on narrow pieces. Unmatched patches use the same curved triangular source field
and exactly the same boundary curves as neighbouring quads, without adding
midpoints or hanging edges. Re-extract older cached maps to obtain the compact
reconstruction.
Terrain frames face skyward for one-sided analytic contact. Mixed source
triangle winding is corrected by transposing the control net and UV corners
together. Slopesmith applies the same correction when reading older cached
GBA maps. Re-extract older cached maps to obtain the updated pairing. Browser start
placement also seats exact section boundaries within half a metre inside the
existing patch, avoiding Float32 edge misses during drop-in.
Cutout scenery retains its native texture orientation and transparent pixels.
Each edge-connected scenery object becomes a separate prop with its own model,
placement and pivot at the centre of its base. Coincident vertices are joined
across material seams, and hidden collision sharing the object's edges stays
with that prop. Unmatched collision remains separate and invisible. These are
geometry-derived objects; the source does not supply recovered prop names.
Connected structures spanning more than 100 metres are divided into local
pieces so camera-range queries still find their nearby ends. Ordinary props
remain whole even when they cross a cell boundary. Local coordinates also keep
mesh quantization local. Re-extract older cached maps to obtain separate props.
Texture atlases use power-of-two dimensions, with the flat-colour palette on
its own final row and a duplicated one-pixel gutter around each tile. Transparent
cutout texels take their hidden RGB from the nearest visible texel in the same
tile, retaining their alpha. This prevents the source green key and neighbouring
tiles from bleeding into filtered edges. Visible source colours remain intact.
The layout preserves original tile texels on power-of-two texture consumers;
resampling the whole atlas blends tile edges and the palette strip. Older cached
imports need a new extraction for this layout.
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
`native_ssx_gba_matching` compares the pair count against exhaustive solutions,
including odd cycles and paths that must rearrange the initial greedy pairs.
`native_ssx_gba_smoothing` checks quad and unsplit triangular surfaces, coincident
cubic boundaries, analytic normal agreement across gentle/material joins and
preserved high-angle creases.
Its native probe checks ground support through drop-in, spawn/reset, moving
rail acquisition, soundtrack playback, bounded discovery reads and cancellation. `iso-library.test.ts`
also chooses a `.gba` through `/isos`, loads and rides Garibaldi with music, checks reload
persistence and keeps the PS2 source separate. Local owner-ROM validation
covers all eight courses and compares music sample counts against the earlier
native-decoder study. Extracted assets and reports remain outside Git.
`native_desktop_library` also checks case-insensitive `.GBA` discovery, external
source selection, installation and preservation of locally edited course files.
