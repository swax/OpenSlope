# Desktop enhanced lighting

Open **Graphics** in the desktop pause menu and select **Lighting: Original**
or **Lighting: Enhanced**. The change applies to the live scene immediately and
is saved with the desktop graphics preferences. Original remains the default.
The Quest wrist menu does not expose or enable desktop enhanced lighting.

Enhanced adds smooth world-space terrain normals, warm directional light,
cool sky fill, view-dependent surface highlights and up to sixteen nearby coloured
point lights. Daylight strength follows the course sky's brightness; the directional
light follows the existing celestial azimuth with a minimum elevation. Lamp
positions and colours come from imported type-2 light records, including lights
without glow sprites. Their illumination radii use the authored bounds, clamped
to 4–64 metres; intensity is bounded to four. Maps without point lights can use
their existing lamp glints. These radii and intensities are enhancement heuristics.
Imported terrain lightmaps and prop lighting
remain the base colour, preserving authored shading and course readability.
Sky art, particles and the rider participate in scene presentation. The desktop
HUD remains at native resolution and is drawn after tone mapping and bloom.

Avatars and mounted, held or loose boards retain their course-probe ambient tint
and directional lighting in both modes. Enhanced tone mapping and bloom apply to
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

For repeatable local comparisons, use the same course, replay, render scale,
MSAA, snowfall and camera with each lighting mode:

```powershell
./temp/native/Release/openslope_player.exe --map Maps/GARI --lighting original --capture temp/gari-original.ppm --snow 0
./temp/native/Release/openslope_player.exe --map Maps/GARI --lighting enhanced --capture temp/gari-enhanced.ppm --snow 0
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

Shadow rays test the sun and nearby point lights against terrain, opaque props
and boards. Offscreen objects remain shadow casters. Hidden instances, interpolated
prop animations and spline movers update their shadow placement each frame.
Sky art, cutout/transparent props, deforming cloth and the articulated rider do
not cast new shadows in this stage. Existing authored shading remains visible.

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

Shadows currently use one visibility ray per contributing light, with a small
surface bias and a 600-metre sun-ray range. Soft shadow filtering, reflections
and bounced lighting are not implemented. Sky-based
daylight and light strength need visual tuning across courses. The imported
lightmaps can contain baked shadows; traced shadows affect the added direct
light rather than darkening the entire imported image a second time.

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
