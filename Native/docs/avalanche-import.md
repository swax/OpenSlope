# 1080 Avalanche course import

The shared C++ importer exposes all 25 single-player layouts from the USA GameCube disc
(`GTEE01`). Native desktop/Quest and Slopesmith's browser worker use the same
conversion. Each preview includes curved terrain patches, primary material
textures, static world geometry and placed scenery, the source
triangle collision mesh, OpenSlope trunk proxies, and a supported start with
ordinary riding, recovery and restart. New imports also carry source background
meshes, sky vertex colour/coverage, approximate lighting and adapted snow spray.

The source catalogue and authoritative format findings are in
[Trailmap 600–607](../../Trailmap/specs/600-avalanche-overview.md). Portable
course IDs prefix the uppercase source stem with `AVALANCHE_`, for example
`AVALANCHE_CRS00_03`. These are package-derived identifiers, not recovered retail course titles.
Discovery lists only supported packages present on the selected image. Each
layout resolves its own GEO/COL/MTL/TPL and base environment package and keeps a
separate cache/map. Crs00 Hard/Expert and Crs06 Hard have no corresponding 1P
world package on this disc and are not fabricated.

## Load and play

Select the RVZ on Slopesmith's ISO page, choose **1080° Avalanche**, load
one of the course layouts, then choose **Play**. Disc bytes and extracted assets remain in
the browser's local storage. Existing cached courses are preserved. Unload and
reload a previously imported layout to obtain corrected handedness, terrain/material UVs,
separate scenery placements, sky, lighting and spray.

The native desktop source list recognizes `.rvz`, `.gcm`, `.iso` and `.bin`
beside the executable. Extract a supported course there, then choose Play.
The Android document picker supplies the same seekable reader. Quest device
playback is not established by the Windows/browser checks.

From the repository root, the native tools can also import directly from the
supplied image:

```powershell
./temp/native-core/Release/openslope_import.exe list "discs/1080 Avalanche (USA).rvz"
./temp/native-core/Release/openslope_import.exe extract "discs/1080 Avalanche (USA).rvz" AVALANCHE_CRS01_00 Maps
./temp/native/Release/openslope_player.exe --map Maps/AVALANCHE_CRS01_00
```

Existing map folders are never replaced. R requests ordinary course recovery;
restart returns to the recorded start. The generated AIP start is a supported,
high groomed-terrain point with a downhill heading, rather than a recovered
retail grid or camera record. Its short orientation path is not respawnable;
the players retain their normal safe trail/start recovery behavior.

All starts except the established Crs00 Normal start require a 128-metre supported downhill corridor,
sampled every four metres at its centre and 1.5 metres to either side. Starts
must agree with the topmost contact surface, start below a 32-degree slope and
clear the imported world collider with swept 45-centimetre torso spheres.
Snow labels and `CF_a`/`CF_b` material-name tags admit candidates, with groomed
`CF_a` candidates preferred, as an explicit OpenSlope policy. This avoids isolated
roof edges, covered/overlapping terrain and blocked launch points. The established
Crs00 Normal start policy is retained.

## Conversion

RVZ is decoded on demand through `DiscInput`, including the format's packed
literal and pseudorandom-padding runs. Four decoded groups are cached. Header
hashes, logical/physical extents, table sizes, group lengths and filesystem
nesting are checked before use. This slice accepts GameCube RVZ using NONE or
Zstandard; other RVZ codecs and Wii images produce explicit unsupported errors.
An uncompressed GameCube ISO/GCM uses the same filesystem and course reader.

LVL member offsets and their embedded contents manifest supply checked asset
boundaries. GEO contains indexed, quantized 16-control-point curved patches,
plus indexed GX polygon lists and static placements. Conversion maps source
`(x,y,z)` to portable `(-x,-z,y)` centimetres. The X reflection corrects the
backwards geometric lettering on the ice finish gate as well as printed signage.
Terrain, props, collision, backgrounds and light vectors use the same basis;
polygon winding reverses with it. The terrain keeps its source control tensor
and the portable quilt's skyward winding. The signed 1/1024-unit UV table and each patch's four indexed
UV corners retain authored rotations, mirrors, crops and repeats. Source corners
0/12/3/15 become portable `UVPoints` 0/1/2/3, matching their control points.
The material generator follows the source routing and affine mapping specified
in [Trailmap 603](../../Trailmap/specs/603-avalanche-materials-textures.md).
Terrain corners and scenery vertices both receive this mapping.
Animated tracks freeze at their first key; camera/normal
projections and custom matrices remain deferred and are counted in `Import.json`.

Standalone source PNGs can contain backwards text. The world handedness conversion
corrects their presentation together with geometric lettering; there is no
material-name-specific UV flip. Source PNG bytes remain intact.
Materials select images from TPL; the reader implements the measured formats in
[Trailmap 603](../../Trailmap/specs/603-avalanche-materials-textures.md#tpl-container),
plus standalone RGB565 covered by authored fixtures.
The scenery reader handles missing UV streams and up to four additional UV
index streams. Uniform colour-only triangles become one-pixel RGBA textures,
including Crs01 Normal's no-material sentinel. Invalid material, colour and UV
indices still fail extraction rather than silently dropping geometry. Interpolated
colour-only triangles use bounded 32-pixel atlas tiles.

World scenery retains separate source objects and placements, with names from
the bounded `ObjNameListV2` directory when present. Already-baked static chunks
receive local geometry and a bounding-box-centre placement pivot. Placed templates
keep their source translation as an editable instance location. Their exact linear
basis is baked into the model, preserving shear and authored negative scales in
both players without relying on TRS decomposition. Identical template/basis pairs
share one model. Different bases use separate variants.

Baked scenery is then split into position-connected islands across UV/material
seams and source grid cuts. Ground, foliage and structural geometry have separate
connectivity classes. Within one source chunk, touching pieces with a common material
family and small enclosed details are grouped into compound props; this keeps an
ice arch, its pillars and lettering together. Baked tree pieces can share a source
trunk-cylinder anchor. These are deterministic OpenSlope grouping policies, not
recovered original authoring object names. Physically joined structures or pieces
whose ownership is ambiguous may remain together. Every triangle and UV is retained.

Slopesmith keeps the course as a static reference, as it does for SSX. Separated
models are available through the Prop Library and a reference prop's **place prop**
action. Copies on an authored mountain can be moved, rotated, scaled or revised
into its custom library. New imports require unloading/reloading an older browser
cache to obtain the split models and their placement defaults.

`Models.json` supplies optional `PlacementDefaults` and `PlacementCollisionPath`
metadata for those copies. Source cylinder records with a valid placement index
provide model-local trunk/post hulls; unindexed records use bounded spatial
association. Polygon hulls are associated with enclosed structural geometry.
Recognised wood/metal/stone/wall/fence/sculpture materials provide a visual-geometry
fallback. Foliage, ground decorations, effects and helpers default to no collision
unless a matched trunk hull defines the complete tree. Unknown ownership is not
filled with a canopy-sized bounding box. These are editable authoring defaults,
not a claim to reproduce every source contact law. `Import.json/PropExtraction`
reports component/group counts, solid/decorative defaults and matched hull counts.

The optional hull is independent of visible mesh triangles. It survives payload
decoding, copying/revising into the custom library, Test collision, collision overlays
and native-shaped export. Placement transforms apply to both art and hull, so a
tree's leaves can remain visible while only its trunk blocks the rider. The original
reference COL mesh and supported start are kept unchanged; authoring hulls do not
create duplicate collision in native/reference playback.

The source COL triangle mesh becomes the normal portable collision proxy. Type
0 endpoint/radius records receive closed twelve-sided cylinder proxies as an
OpenSlope approximation for tree trunks. Other primitive classes are counted
and deferred in `Import.json`; their original collision laws are unresolved.
Literal `a` surface tags, observed alongside `CF_a` snow materials, receive a
separate `SurfaceType: 1` proxy so upward snow polygons can support the board.
This matters for Crs05 Normal's stadium floor. Other faces remain solid
obstacles. Rendering and collision remain separate, and hidden proxies stay solid.

## Environment mapping

Each course's base LVL supplies `BGnn_dd.GEO/MTL/TPL` background geometry and
`PLAYERLIGHT_nn_dd.LIG`. The background uses ordinary `Skybox` model/material
files, with camera-relative rendering in both players. The GEO storage tag selects
packed short3 or normalized float3 positions before the common scale matrix.
Vertex tint and alpha
are baked with the source image into bounded 32-pixel triangle atlas tiles;
uniform white vertices keep the original primary image. A white first texture
followed by a second image selects that image and its second UV stream, which
retains the observed cloud layer. This is an explicit portable approximation of
the source material stages. An I4/I8 second image following a white stage becomes
white RGB with intensity as alpha coverage, preserving the sky behind the cloud
mask's black field. Native sky rendering now blends fractional alpha,
matching Slopesmith's existing backdrop blending.
Source TPL repeat addressing is retained with optional `RepeatTexture: true`
on `Skybox/Materials.json` rows; both renderers keep the existing edge-clamped
behavior when the field is absent. This prevents the Crs00 dome's repeating UVs
from stretching texture edges across the sky. Generated atlas pages remain clamped.
Slopesmith's Play range gate measures prop geometry bounds rather than only the
placement origin, so large scenery chunks remain visible beside a distant rider.

Terrain now retains its four source corner colours and the base package's
`SHADnn_dd.DAT` environment-shadow field. The field contains a world-space grid,
projection rectangles and coloured texture tiles. Conversion multiplies the
source corner colour by projected shadow RGB, sampled into 16-by-16 patch tiles
in ordinary 128-by-128 `Lightmaps` pages. `LightmapEncoding: "rgb-multiply"`
selects direct colour modulation in Native and both Slopesmith reference views.
Maps without that field keep the existing residual-lightmap interpretation.
This format extension is currently consumed by Native and Slopesmith; other
map consumers need equivalent support before using these lightmaps.

Main scenery and player LIG rigs remain separate. `Instances.json` carries the
main object rig and an optional `RiderLighting` override for actor probes;
`Lights.json` retains the scenery key directions and colours. Gains stay at their
source values, with saturation after directional evaluation, instead of dimming
every surface by total rig energy. The authored light axis is preserved through
the same reflected world basis as terrain and scenery. A directional key does
not establish the location of a visible sun disc.

The layouts have distinct fixed sky art, baked colours, shadow fields and light
rigs. No continuously advancing day/night clock or animated sun path is
established. Point-light slots and dynamic-light art exist in the source, but
activation, moving lights and dynamic shadow casters remain unresolved. Secondary
object-rig ownership and the exact retail actor-shadow equation are also deferred. The
current main-object rig is an approximation for objects that used another rig.
Textured scenery vertex colour and per-material source lighting gates remain
future work; the new coloured shadow bake currently covers curved terrain.
`AvalancheLighting.json` records the recovered channels and explicit limits.
See [Trailmap 607](../../Trailmap/specs/607-avalanche-lighting.md).

Native's Original/Enhanced modes and Slopesmith also project rider and board positions onto the
first terrain surface below them and sample its RGB lighting. That factor scales
both ambient and directional parts of the player rig. This lets existing RGB
imports shade dynamic bodies in caves and tree shade, while a roof above the
player cannot supply the floor's sample. Native uses the curved terrain query;
Slopesmith interpolates the rendered terrain colours through its existing BVH.
This is an OpenSlope approximation of local actor shade, rather than a recovered
retail actor equation or a new dynamic shadow caster. Legacy residual-lightmap
maps retain their existing spatial instance probes. Already imported RGB maps
need a player/page reload for this runtime improvement, without another disc import.

Refresh lighting on an existing matching map without reimporting its soundtrack
or geometry:

```powershell
./temp/native-core/Release/openslope_import.exe refresh-avalanche-lighting "discs/1080 Avalanche (USA).rvz" AVALANCHE_CRS00_00 Maps/AVALANCHE_CRS00_00
```

The command validates a staged lighting conversion first and preserves the
initial lighting and metadata in `LightingBackup-v1`. Browser courses need a
fresh import to obtain these channels.

Course `PTCL` texture banks are retained under `Textures/Particles` for later
emitter work. The shared `1080Data/Misc/spray.tpl` is preserved as
`ava-spray-source.png` and adapted for the existing puff/sheet effects: white RGB,
with source alpha multiplied by source brightness for portable alpha coverage.
`RidingEffects.json` selects it in Native; Slopesmith's local adapter resolves
its spray and puff aliases to the same file. This adapts art to OpenSlope's
effect simulation; original emitter programs are not executed.

`AvalancheEnvironment.json` records the selected package, emitted background
triangle count, lighting policy, retained particle images and deferred channels.
`World.json` disables inferred source fog and glare; the sky already carries its
own sun/cloud art. OpenSlope's user-controlled snowfall remains available.

## Music

New imports include the named soundtrack from the disc's sound catalogue in
`Audio/Music`. The USA source contains 46 distinct streams with track titles and
artists, including named intro/outro variants. Duplicate stream references are
decoded once; blank-title/artist cues and the explicit music-off entry are excluded.
The importer preserves catalogue order and the first title for an aliased stream.

Disc-stream ADPCM becomes 48 kHz stereo PCM16 WAVs of at most four seconds.
Predictor history continues across chunk boundaries. Each song has a portable
`graph.json` with sequential links and a full-track loop; `playlist.json` and
`MusicImport.json` retain selection order, names, artists, durations and source
provenance. Native desktop/Quest and Slopesmith use their existing per-run random
choice, explicit song selection and mount/dismount fades. This is OpenSlope
playback policy; original per-course selection, cue timing, transitions and mix
automation remain unresolved. See [Trailmap 606](../../Trailmap/specs/606-avalanche-music.md).

The full decoded soundtrack occupies about 1 GiB per independently stored map.
Quest folder caching admits up to 1536 MiB of audio while retaining its entry,
file-size, cancellation and partial-cache cleanup limits. Playback still loads
only the current song's bounded chunks. Reload an older browser course to import
its music. No extracted audio is included in source or application packages.

Add music to an existing local map, or extract a standalone soundtrack folder:

```powershell
./temp/native-core/Release/openslope_import.exe extract-avalanche-music "discs/1080 Avalanche (USA).rvz" Maps/AVALANCHE_CRS00_00
```

The command requires an absent `Audio/Music` destination and preserves existing
terrain and other map files. A failed or cancelled music conversion removes its
new music tree. Fresh course imports include the same conversion automatically.

## Current limits

Only the USA disc ID is exposed. Primary images and polygon
UVs, including curved-terrain corner mappings, are retained. Animated and camera-dependent material
texture generation/transforms, full layered materials, world vertex lighting,
dynamic shadows and source fog, retail starts, other collision primitive classes, sound effects and original audio scheduling,
event/scoring logic and animated hazards remain deferred. Snow/powder/rock
surface assignments use explicit OpenSlope material-name policy. These maps
run OpenSlope's riding physics.

`Import.json` reports emitted stages, proxy policy and deferred features. No
disc image, extracted art or executable bytes are included in source or builds.

## Focused checks

```powershell
python Native/tests/avalanche_import_test.py temp/native-core/Release/openslope_import.exe temp/native-core/Release/openslope_avalanche_tests.exe
python Native/tests/avalanche_music_test.py temp/native-core/Release/openslope_import.exe temp/native-core/Release/openslope_avalanche_tests.exe
python Native/tests/avalanche_lighting_test.py temp/native-core/Release/openslope_import.exe
python Native/tests/avalanche_desktop_test.py temp/native/Release/openslope_player.exe
cd Slopesmith
node --import tsx test/avalanche-browser.test.ts
```

The authored fixtures cover GameCube filesystem traversal, uncompressed and
Zstandard RVZ blocks, packed literals, CMPR/flat-colour pixel values, sky tint and
coverage baking, spray coverage, light rigs, additional
GX index streams, source material SRT/first-key freezing, readable reverse-sign UVs,
rotated/mirrored/cropped/repeated terrain UVs and their native/browser
draw-vertex binding, per-layout member routing, bounded course discovery, curved contact,
collision, supported spawning, riding, recovery, restart, malformed input and
failed-import cleanup. The browser check uses the actual picker, WASM worker,
cache adapter, terrain renderer/contact model and public Play page. Supplying
a local RVZ as its optional argument repeats that flow against user data.
The browser test visits all 25 maps by default; an optional second argument
selects comma-separated portable IDs for a focused local run.
The desktop check opens the production library from a different working
directory, installs an authored RVZ, enters Play and reuses the saved course.
Native sky pixel checks cover fractional alpha on UNORM/sRGB targets, repeat
addressing, camera translation, foreground occlusion and target recreation.

Format references:
[Dolphin's RVZ description](https://github.com/dolphin-emu/dolphin/blob/master/docs/WiaAndRvz.md),
[libogc GX format declarations](https://github.com/devkitPro/libogc/blob/master/gc/ogc/gx.h).
