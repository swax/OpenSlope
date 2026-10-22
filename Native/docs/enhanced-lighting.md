# Desktop enhanced lighting

Open **Graphics** in the desktop pause menu and cycle **Lighting: Original**,
**Lighting: Enhanced**, or **Lighting: Runtime**. The change applies to the live scene immediately and
is saved with the desktop graphics preferences. Original remains the default.
The Quest wrist menu does not expose or enable desktop enhanced lighting.
Lighting mode is specialized when creating the Vulkan pipelines, so Original
compiles out desktop lighting, HDR/bloom and prop world-normal transforms. A
uniform branch alone imposed a measurable GPU cost on Quest even with those
features disabled. Changing modes recreates the pipelines for the selected mode.
All three lighting modes specialize terrain, prop, board and avatar materials
separately, removing unused material branches and varyings from those draws.
Enhanced and Runtime create both untraced and ray-query variants, including
Runtime's world-space avatar and untextured-surface path. Mode changes rebuild
these variants; ray initialization failures retain the untraced variants. XR workload
logs include boarding state, speed, position, avatar triangles and effect counts
alongside frame timings for comparisons during actual rides.

Material specialization is not a measured desktop speedup on every GPU. A local
RTX 4090 Laptop comparison over 1,800 Merqury replay frames at 1920x1080, 4x MSAA
and no snowfall measured Enhanced GPU time at 3.86/4.56 ms before/after and Runtime
at 6.81/6.59 ms, with ray shadows active. Render wall times were 6.65/6.70 ms and
8.84/9.18 ms respectively. These single longer comparisons and shorter noisy runs
do not establish a consistent desktop frame-rate gain.

Enhanced adds smooth world-space terrain normals, warm directional light,
cool sky fill, view-dependent surface highlights and coloured point and spot
lights. Daylight strength follows the course sky's brightness, capped using the
hue and strength of exported directional light when available. Weak blue
moonlight keeps bright blue
night skies such as Merqury City from enabling a sun or broad daylight lamp
falloff. Neutral/warm authored suns and maps without this metadata retain the
sky fallback. The directional
light follows the existing celestial azimuth with a minimum elevation. Lamp
positions and colours come from positive imported type-1 spot and type-2 point
records, including lights without glow sprites. Their illumination radii use the
farthest authored bounds corner from the source, clamped to 4–120 metres.
Night-course HDR strength retains the previous response up to four; stronger
sources use their authored peak divided by 50, bounded to 4–128. This preview
calibration restores tall floodlights' reach without raising weak fill lights
uniformly. Daylight keeps the previous four-unit ceiling. A scene-wide spatial grid
looks up sources at each surface, without a nearest-16 or camera-distance cutoff.
Spotlights use their exported direction and cone cosine (`UnknownFloat2` or
`OuterConeCosine`). New PBD and WDF imports preserve that field, following
[Trailmap: 160-spot-cone, 220-light-cone, 500-light-cone]. For older exports such
as Native Snowdream, missing cones are recovered in memory from retained
`Source` PBD or WDX/WDF files when source order, type and position match. Existing
exported angles take precedence, and exported JSON is left untouched. No
re-export is needed when the map already has cone metadata or retained source.
Only source-less maps without cone metadata use the 35-degree preview fallback.
Maps without local light records can use
their existing lamp glints. These radii, intensities and fallback cones are
enhancement heuristics. Capture logs report the uploaded point and spot counts.
Night-course local lights have an additional distance falloff with a six-metre
scale, concentrating illumination near fixtures instead of washing the entire
slope white as broad imported influence boxes overlap. Daylight retains the
previous response. This falloff is preview tuning, independent of authored cones.
Source recovery logs report how many missing spotlight cones were recovered.
Imported terrain lightmaps and prop lighting
remain the base colour, preserving authored shading and course readability.
Sky art, particles and the rider participate in scene presentation. The desktop
HUD remains at native resolution and is drawn after tone mapping and bloom.

In Original and Enhanced, avatars and mounted, held or loose boards retain their
course-probe ambient tint and directional lighting. Enhanced tone mapping and bloom apply to
those shaded colours. Switching back to Original restores their standard colour
response, including the board's distance fog.

Enhanced uses a 16-bit floating-point colour target when the GPU supports colour
attachment, sampling and linear filtering for that format. A filmic display
curve preserves differences between bright sources, and a restrained spatial
bloom spreads their glow. This also applies at 100% render scale. Switching back
to Original recreates the original targets; render scale and MSAA choices remain
in effect. Devices without the HDR format retain the enhanced lighting pass.
Floating-point colour and the extra presentation target increase attachment
memory. Capture logs report whether HDR and bloom are active.

## Runtime lighting

Runtime bypasses exported terrain lightmaps and per-instance prop lighting. Raw
surface colours receive the runtime sun, sky fill and spatially selected point and
spot lights, with the same HDR, bloom and optional ray-query shadows as Enhanced.
Local and opponent avatars
and boards use these same lights instead of imported course probes. Skin normals
follow the posed body; mounted, held and loose boards use world-space positions
and normals. The desktop HUD remains outside the lighting and tone-mapping passes.

### Calibration against Original

Tricky courses identified as `SNOW`, `MERQUER` and `MESA` in `World.json` use a
calibrated profile. Folder names can change. Garibaldi and other courses retain
their existing response. Available type-0 directional records supply the actual
sun/moon colour and incoming direction, converted to a native surface-to-source
axis. This preserves Mesa's orange sunset rather than substituting a generic sun.
Invalid optional directional records retain the usual fallback.

During scene upload, a bounded CPU fit samples the original terrain texture and
lightmap response, then estimates ambient fill, directional strength and a scalar
power multiplier for each local source. Lamp hues, positions, cones and source
coverage remain intact. Warm sunsets retain the profile's warm ambient hue in
shadow. The fit uses at most 4,096 samples, 2,048 sources, 524,288 sparse
observations and 32 coordinate-descent passes. Every fourth sample is held out;
the result is applied only when its reference error improves. Missing references,
insufficient samples or an exceeded fitting budget retain the profile's fallback.
These lighting parameters are computed once per uploaded scene. Runtime shading
continues to use raw albedo, live lights and ray shadows, without sampling terrain
lightmaps each frame. Avatars and all board placements use the same calibrated rig.
Calibrated blue lunar fill uses one occlusion ray; the main lamps, daytime sun and
warm sunset retain their area-shadow sampling.

Enhanced retains the authored base brightness through HDR tone mapping, then adds
a restrained amount of direct illumination and bloom. Its avatars and boards
retain Original's probe shading and base colour through presentation. Both modes
preserve the original sky artwork's display response. Original pixels and map
files are unchanged. No re-export is needed when the existing lightmaps and light
records are present. Runtime still approximates baked bounce and artist-authored
shadowing, so it does not reproduce every Original pixel.

An optional map-local `NativeLighting.json` overrides the Native profile:

```json
{
  "Schema": "openslope-native-lighting/v1",
  "Enabled": true,
  "AutoFit": false,
  "RuntimeAmbient": [0.12, 0.10, 0.08],
  "DirectionalGain": [0.35, 0.35, 0.35],
  "LocalColour": [1.0, 1.0, 1.0],
  "FalloffMetres": 6,
  "EnhancedAmount": 0.05,
  "Bloom": 0.04
}
```

RGB values are linear and bounded to 0–8. Falloff is 1–32 metres, Enhanced amount
is 0–0.5, and bloom is 0–0.25. The optional file has an 8 KiB limit and must remain
inside the map directory. `Enabled: false` restores the previous lit-mode
response. Auto-fitting defaults on for the three built-in course profiles and
off for other courses. This sidecar is Native-specific and is not required for
the built-in profiles.

Matching captures at 0, 4 and 12 simulation seconds compare Original, Enhanced
and Runtime on all three courses. Terrain/scene RGB error against Original drops
in both lit modes; Mesa retains its warm sunset and shadow fill. Garibaldi's
scene pixels at 0 and 12 seconds remain byte-identical in all three modes after
excluding the random board/rider region. Captures and logs are kept in the
ignored `temp/lighting-calibration/` directory. The CPU fixture recovers known
ambient and lamp power from a synthetic bake, and separate GPU fixtures check
base brightness preservation, Original restoration, and calibration reaching the
avatar and board. These comparisons cover selected views, not every part of each
course.

Paired 180-frame Runtime rides at 1920×1080 scene resolution and 4x MSAA keep
night-course GPU time approximately steady: Snowdream measures 16.78/16.81 ms
before/after calibration, and Merqury measures 5.56/5.22 ms. The brighter authored
moonlight retains rider/board occlusion through its one-ray path. These are
short local comparisons, not full-course frame-rate measurements.

This mode is experimental. Sky fill approximates indirect illumination; bounced
lighting and sky occlusion are not implemented. Shading painted into a source
texture remains part of that texture. Existing Original and Enhanced modes are
available for comparison, and Quest continues to use Original.

Scene-light coverage checks pass: 558 preference/menu/grid checks, 1,038
celestial/import checks, 14,902 Vulkan rendering checks and 459 avatar/board
checks. GPU fixtures cover lights beyond the old camera-distance and count
limits, spotlight direction/cones, both ray-query and fallback paths, and
unchanged Original pixels. They also cover embedded fixture emission, separate
placements blocking the same lamp, unrelated sources and a 3,500-strength,
60-degree spotlight more than fifty metres from its receiver. Local captures
include Tricky Snowdream's `SD_sp_Lamp_0009`, its starting area and Gari daylight.
Moonlight/blue-night and neutral-white-daylight metadata are checked separately.
The soft-shadow GPU fixture grows its transition region from two to sixteen
pixels as the blocker lifts away from the receiver, at both 1x and 4x MSAA;
stationary frames remain identical. A 180-frame Merqury replay completes with
all 932 local lights and soft ray shadows active.
Sampling-budget GPU fixtures also verify visible illumination and occlusion
from faint fill, sixteen overlapping strong lights and 128 overlapping tiny
sources. Blocked output remains within two display-byte steps of the ambient
baseline, with identical untraced output at both 1x and 4x MSAA. Filtered emitter
housings still block other emitters and rays using the opaque override.
A local SSX Snowdream capture reports all 474 point and
160 spot lights uploaded; a 180-frame ride completes with ray shadows active.

Map replacement finishes queued work and rebinds the new scene's light buffers
before drawing it. GPU regressions replace sole-owned
scenes with different point/spot rigs, including empty rigs, in both lit modes
with tracing on and off. Desktop menu tests keep each requested lighting mode
active through the asynchronous map upload and verify failed-load rollback.
Synthetic ISO/BIN imports preserve the cone aliases and reject malformed cones;
optional damaged source leaves an otherwise valid JSON map playable. Local GARI
and Snowdream Runtime captures also load at 200% render scale, with all 160
missing Snowdream cone fields recovered from its retained source.

For repeatable local comparisons, use the same course, replay, render scale,
MSAA, snowfall and camera with each lighting mode:

```powershell
./temp/native/Release/openslope_player.exe --map Maps/GARI --lighting original --capture temp/gari-original.ppm --snow 0
./temp/native/Release/openslope_player.exe --map Maps/GARI --lighting enhanced --capture temp/gari-enhanced.ppm --snow 0
./temp/native/Release/openslope_player.exe --map Maps/GARI --lighting runtime --capture temp/gari-runtime.ppm --snow 0
./temp/native/Release/openslope_player.exe --map Maps/SSX_SNOW --lighting original --capture temp/snow-original.ppm --snow 0
./temp/native/Release/openslope_player.exe --map Maps/SSX_SNOW --lighting enhanced --capture temp/snow-enhanced.ppm --snow 0
```

Map paths refer to the user's local imports; no course assets are included.
Capture overrides do not save preferences. `--lighting` is rejected with `--xr`.

## Ray-traced shadows

Enhanced automatically enables hardware ray-query shadows on desktop devices
supporting Vulkan 1.2, buffer device addresses, acceleration structures and ray
queries. Unsupported devices retain the enhanced lighting pass. Add
`--no-ray-tracing` to force that fallback for comparison or troubleshooting.
Capture logs report whether tracing is active, caster count and mesh acceleration
memory. These desktop switches are rejected with `--xr`.

Shadow rays test the sun and contributing point and spot lights against terrain, opaque props,
boards and posed rider bodies. Offscreen objects remain shadow casters. Hidden instances, interpolated
prop animations and spline movers update their shadow placement each frame.
An imported source inside a compact opaque fixture part ignores that one part
for its own local-light rays. Its pole, other placements of the same model,
terrain, riders and unrelated lights still shadow normally. This is an enclosing
bounds heuristic for fixture parts up to ten metres across; large structures,
degenerate bounds, cutouts and animated placements retain ordinary occlusion.
Only matched emitter housings require triangle-candidate filtering. Terrain,
riders and ordinary props retain hardware opaque traversal; sun rays and local
rays without a housing force opaque traversal for all casters, following the
[Vulkan opacity override rules](https://docs.vulkan.org/spec/latest/chapters/raytraversal.html).
Riders use a renderer-owned triangle acceleration structure refitted from each
posed body. Local and nearby opponent riders cast shadows, with the complete
head retained in first person. Controllers, labels and HUD geometry do not cast
rider shadows. Sky art, cutout/transparent props and deforming cloth do not cast
new shadows in this stage. Existing authored shading remains visible. Rider
shadows require the hardware ray-query path; Original and the untraced fallback
retain their previous presentation.

Immutable mesh acceleration structures are shared with the scene. Each renderer
owns its instance structure, scratch and lighting buffer, preserving queued-view
isolation. Mesh acceleration allocation has a 1 GiB ceiling, and instance updates
have a 100,000-instance ceiling. Initialization/allocation failures retain enhanced
lighting and report the failure. Initial activation builds the mesh acceleration
structures once and can briefly pause a frame.

The fragment path uses [Vulkan ray queries](https://docs.vulkan.org/guide/latest/extensions/ray_tracing.html).
The original shaders remain available without ray-query capabilities, including
the OpenXR path. Android builds consume both generated shader headers from the
host build; the ray shader is only instantiated on an enabled desktop device.

Shadow sampling follows each light's contribution at the receiving surface,
including its albedo, facing, cone and distance falloff. Faint fill lights use
one occlusion ray; finite-area shadows blend in smoothly between 0.01 and 0.02
linear RGB contribution and between one eighth and one half of the combined
local-light contribution. This limits extra area rays to at most seven local
sources per pixel, even when many bright floodlights overlap. Sunlight and
dominant lamps sample a finite emitting
disk: five probes return early for fully lit or occluded pixels, with seventeen
samples around shadow edges. Individually negligible contributions below 0.0005
can skip occlusion only within a combined 0.001 linear RGB budget per pixel;
additional lights still trace rays. All lights retain their illumination, with
no new camera-distance or source-count cutoff. Sampling is fixed between
frames. Default local emitters have a 0.3-metre radius; an enclosing lamp
head supplies a bounded 0.15–0.75-metre estimate from its size. The sun uses an
approximately 0.27-degree angular radius and a 600-metre ray range. Contact
shadows remain tight; the penumbra widens as a blocker moves away from the
receiving surface. These preview source sizes and finite samples approximate
area lighting; no temporal denoiser is used. Concentrating area samples on
visible illumination avoids tracing 5–17 rays for every tiny contribution in
dense city light rigs. Soft shadows still add ray-query cost.
Reflections and bounced lighting are not implemented. Sky-based
daylight and light strength need visual tuning across courses. The imported
lightmaps can contain baked shadows; traced shadows affect the added direct
light rather than darkening the entire imported image a second time.

Performance-fix comparison on the local RTX 4090 Laptop GPU: matched 180-frame
Runtime replays at 1920×1080 scene resolution (150% of a 1280×720 window), 4x
MSAA and no snowfall reduce average GPU time from 16.89 to 3.80 ms in Tricky
Merqury City and from 111.11 to 17.30 ms in Tricky Snowdream. Average render wall
time falls from 20.36 to 6.79 ms and 115.16 to 20.23 ms respectively. All 932
Merqury and 419 Snowdream lights remain uploaded, with ray shadows active.
Snowdream remains the heavier sample; these short replays are not full-course
or cross-device frame-rate guarantees. Captures and logs are in the ignored
`temp/lighting-atmosphere/` directory.

Stage-one validation: the Release player and focused tests build; 135 graphics
preference/menu checks and 14,644 actual Vulkan rendering assertions pass. The
desktop menu/map-load and failed-load rollback integration checks pass. GPU
checks exercise both lighting modes at 1x/4x MSAA, UNORM/sRGB colour output and
exact restoration of Original pixels. Local Garibaldi and SSX Snowdream captures
were visually inspected. These captures establish appearance, not sustained
performance during a full ride. The Native source-boundary audit passes.

Stage-two validation on an RTX 4090 Laptop GPU: 14,660 actual Vulkan assertions,
1,010 celestial/light-import checks, 135 graphics preference/menu checks and 44
PNG/material checks pass. Desktop menu/map-load and rollback integration pass.
The GPU checks cover sun and point-light shadows, offscreen/hidden/moving/spline
casters, scene replacement, MSAA target recreation, queued-view isolation and a
device created without ray-query features. Original Garibaldi and Snowdream
captures remain byte-identical to stage one. No Khronos validation layer is
installed on this host, so API validation-layer diagnostics are not covered.

Local 180-frame replays on both courses at 1920×1080 scene resolution, 4x MSAA
and ambient snow complete with tracing active. Garibaldi reports 2,691 caster
instances, 35.5 MiB of mesh acceleration and 1.51 ms average GPU time; Snowdream
reports 4,709 instances, 23.5 MiB and 1.62 ms. These short local samples are not
full-course or cross-device performance guarantees. Their logs and rendered
comparisons live in the ignored `temp/lighting-comparison/` directory.

Stage-three validation: 14,692 actual Vulkan assertions pass, including HDR
highlight separation, bounded bloom, HUD exclusion and exact restoration of
Original at 100%/150% scale, 1x/4x MSAA and UNORM/sRGB output. Live desktop
mode-switch/map-load/rollback integration passes. The two Original captures
remain byte-identical to stage one. Both 180-frame course replays complete with
HDR, bloom and tracing active at 1920×1080/4x, averaging 1.77 ms of GPU time in
these local samples. Matched 1280×720/4x comparison images and the replay logs are
kept under `temp/lighting-comparison/`. C++ formatting, the Native source-boundary
audit and whitespace checks pass. Full-course, cross-device and validation-layer
coverage remain outside this local verification.
