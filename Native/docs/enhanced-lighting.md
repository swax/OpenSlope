# Desktop enhanced lighting

Open **Graphics** in the desktop pause menu and select **Lighting: Original**
or **Lighting: Enhanced**. The change applies to the live scene immediately and
is saved with the desktop graphics preferences. Original remains the default.
The Quest wrist menu does not expose or enable desktop enhanced lighting.

The first stage adds smooth world-space terrain normals, warm directional light,
cool sky fill, view-dependent surface highlights and up to sixteen nearby coloured
lamps. Daylight strength follows the course sky's brightness; the directional
light follows the existing celestial azimuth with a minimum elevation. Lamp
positions and colours come from the imported light records. Their illumination
radii are an enhancement heuristic. Imported terrain lightmaps and prop lighting
remain the base colour, preserving authored shading and course readability.
Sky art, particles, the rider and HUD retain their existing presentation.

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

This first stage does not trace rays, cast new shadows, add reflections or render
an HDR bloom pass. It establishes the comparison mode and lighting inputs for
those subsequent renderer stages. Sky-based daylight and lamp radii need visual
tuning across courses. The imported lightmaps can contain baked shadows, so
future dynamic shadows must affect the new direct light rather than darkening
the entire imported image a second time.

Stage-one validation: the Release player and focused tests build; 135 graphics
preference/menu checks and 14,644 actual Vulkan rendering assertions pass. The
desktop menu/map-load and failed-load rollback integration checks pass. GPU
checks exercise both lighting modes at 1x/4x MSAA, UNORM/sRGB colour output and
exact restoration of Original pixels. Local Garibaldi and SSX Snowdream captures
were visually inspected. These captures establish appearance, not sustained
performance during a full ride. The Native source-boundary audit passes.
