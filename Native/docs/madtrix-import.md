# Jonny Moseley Mad Trix import

The shared native importer recognizes the USA PS2 disc in either
plain ISO or Mode 2 Form 1 BIN form. Its manifest supplies eleven course packages:
Antarctica, Washington DC, Las Vegas, Mount Kilimanjaro, Machu Picchu, Nepal,
Rome, San Francisco, Tahoe, Training and Valdez Alaska.

The desktop map library discovers the BIN beside the executable and lists its
courses through the existing **ISO Sources** menu. Choose **Extract**, then
**Play** when conversion finishes. The same C++ reader is compiled into Android
and the browser worker; no platform-specific decoder is required. Slopesmith's
`/isos` page lists Mad Trix with eleven named courses and preliminary support.
Choose the USA PS2 BIN or ISO, then load individual courses to Play or Inspect.

From the repository root, the importer can also list and extract directly:

```powershell
./temp/native/Release/openslope_import.exe list 'discs/Jonny Moseley Mad Trix (USA).bin'
./temp/native/Release/openslope_import.exe extract 'discs/Jonny Moseley Mad Trix (USA).bin' MADTRIX_AN_ANTARTICA temp/madtrix-maps
./temp/native/Release/openslope_player.exe --map temp/madtrix-maps/MADTRIX_AN_ANTARTICA
```

The converter writes the existing portable `Patches.json`, terrain PNGs, an
explicit `AIP.json` start, the source sky dome and provenance. Curved terrain
supplies rendering and collision through the standard runtime. The authored skier position anchors a
search for nearby snow with clear headroom and a supported starting runout.
This avoids scripted helicopter staging areas. Initial heading follows a clear
downhill route. Material names supply approximate OpenSlope snow/ice/hard
surfaces. Source physics tuning and yaw are not reproduced. Package spellings
are preserved in course IDs.

`Models.json`, `Instances.json` and `Materials.json` carry supported marquee,
neon and Las Vegas waterfall props, or empty tables when none are placed. Terrain
retains its source baked RGB control net, including Vegas's colored lighting.
Native Original lighting and Slopesmith Play/Inspect multiply textures by the
evaluated colors. Inspect reports **Source baked vertex colors loaded**; there
are no image lightmaps to fetch or directional-sun fit to load.

Avatars and boards in Slopesmith and Native Original/Enhanced sample the first
terrain surface below them. When actor-light probes are absent, the baked RGB
modulates a neutral fill/key rig, carrying local shade and colored light onto
the body and equipment. Existing actor probes remain authoritative. Native
evaluates the source bicubic controls; Slopesmith interpolates the rendered
terrain colors. This ground projection is an OpenSlope approximation, not a
reconstruction of the retail actor-lighting equation or moving lamps.

`Skybox` contains a tessellated source dome and its textures. It uses the shared
camera-centred sky renderer and contributes no terrain collision. Terrain and
sky UVs expand the source bilinear coefficients with the packed control
directions preserved. Older Mad Trix imports need re-extraction to receive the
sky and corrected texture orientation.

Exact magenta texels in source cutout art become transparent, including palm
fronds, latticework and sign silhouettes. Other colours and partial alpha keep
their source values. Earlier opaque imports need re-extraction; Slopesmith
marks those map caches for loading again from the saved disc.

Slopesmith clips fully transparent helper pages such as Valdez's `trickable`
texture. Their control net and current collision admission remain available for
inspection; original trick-detection and collision flags are still deferred.

`Splines.json` adapts narrow, sky-facing terrain strips whose entire UV envelope
is painted with the source **Grindable** property colour. The converter reads
`PropertyGroup` images separately from visible art, preserves the cubic strip
centreline and joins unbranched matching ends. A railing texture name alone never
creates a grind rail. Broad surfaces, partial masks and the original game's
surface-based grind detection remain deferred. Las Vegas currently produces
239 segments in 127 paths; this conversion is explicitly approximate.

Supported single-strip sign panels retain their source geometry, hierarchy rest
pose and placed transforms. Source neon image sequences retain their separate
frames. Static marquee and welcome panels receive an OpenSlope brightness pulse;
the shared material player runs at an authored two frames per second. This
adaptation does not claim the original game's timing or procedural animation.
The original source art is retained, including verified identical resource copies
stored by several object packages. Differing copies remain an error.

Las Vegas's two waterfall placements retain their source mesh, rest pose and
water art. Strip suppression flags prevent triangles bridging separate pieces
of the mesh. UVs are rotated/reflected per triangle to align the repeating art
with the dominant downhill direction. The shared UV player moves it at an authored
half repeat per second; the original animation driver and speed remain deferred.
These visual props add no collision. Other courses' waterfall models remain
outside this bounded adapter. `Import.json` records waterfall counts and the
approximation separately from signs.

`Audio` decodes the source VDEF ski, edging and landing tables and their mono
PS-ADPCM samples into the shared riding roles. Source loop boundaries survive.
The surface-family adaptation is labelled approximate in `RidingImport.json`.
Missing roles can fall back to locally extracted Tricky banks; in browser Play,
load a Tricky map on the same device to make those clips available. Source clips
always take priority. No donor disc or audio is downloaded, and the fallback
does not import the donor map's terrain.

`Audio/Music` imports the disc's twelve full-length music streams (about 46
minutes) through the existing music playlist and graph contract. Four-second
WAV chunks retain decoder history and keep startup preload small. Both native
and Slopesmith Play select from this game's tracks; Random chooses a track for
each run, and the selected full track loops. The original game's music scheduling
and fades are not reproduced. Labels retain source track numbers; song titles
and tempos have not been recovered. Music adds roughly 125 MiB per imported map.

Reload older Slopesmith caches from the saved disc to receive music. Existing
native map folders are preserved; re-extract into a new output folder to update
them.

This is a preliminary import. `Import.json` sets `Complete` to
false and records deferred sky vertex lighting, other props, source collision flags,
respawn paths, partial grind masks, original sign/waterfall timing, scripts, events,
ambience, original music scheduling and audio event routing. Geometry baked into the terrain
quilt is retained. OpenSlope's terrain collision currently admits the entire
imported quilt, so decorative source surfaces may also collide. Quest device
performance and fidelity against original game rendering need playtesting.
Sky images currently use unlit source colours. The new baked terrain shading
does not recreate dynamic lamps, prop lighting or the original fog/exposure pipeline.

## Reader boundaries

[`madtrix/importer.cpp`](../src/import/madtrix/importer.cpp) owns game identity,
course discovery, coordinates, image/sky conversion, grind strips and start adaptation.
[`madtrix/props.cpp`](../src/import/madtrix/props.cpp) and
[`madtrix/audio.cpp`](../src/import/madtrix/audio.cpp) own the bounded animated-prop and ski-audio adapters.
[`madtrix/music.cpp`](../src/import/madtrix/music.cpp) reads the separate MET
music bank and writes portable playback chunks and graphs.
[`containers/pak.cpp`](../src/import/containers/pak.cpp) owns the independent
hash-indexed PGRP/PFIL package and bounded chunk decompression. It accepts split
members and preserves ambiguity when a name has multiple source variants.
The converter reads unambiguous terrain/image/XML members. Sign art may explicitly
coalesce up to 32 byte-identical resource copies within a 16 MiB decoded budget.
Format conclusions are tracked in [Trailmap: 550-package, 550-terrain,
550-textures, 550-start, 550-uv, 550-sky, 550-lighting, 550-grind, 550-signs, 550-waterfalls, 550-audio, 550-music].

All eleven courses from the local USA disc passed native extraction, texture
loading, supported spawning, short riding, manual recovery and restart checks.
Each course exports 96 sky quilts as 12,288 triangles, with all sky images
resolved by the runtime. Antarctica also passed worker extraction and an
offline Vulkan render/ride. These are short automated samples, not complete
course playthroughs.

Authored ISO/BIN fixtures exercise public discovery/extraction, chunk reassembly,
dictionary back-references, exact pixels and mixed UV coefficients, curved sky
geometry, runtime OBJ UV orientation, clear staging/runout adaptation, riding,
reset, property-mask grind strips, four/five-vertex sign panels, source flipbook
frames, equivalent resource copies, VDEF/ADPCM audio and loop boundaries,
waterfall strip masks and scrolling, cancellation and malformed-input cleanup.
Music fixtures also check chunk continuity, graph looping, mixed sample rates,
native mixer output and malformed-bank cleanup. Run the focused test after
building `openslope_import` and `openslope_madtrix_tests`:

```powershell
python Native/tests/madtrix_import_test.py temp/native/Release/openslope_import.exe temp/native/Release/openslope_madtrix_tests.exe
```
