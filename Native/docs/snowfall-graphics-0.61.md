# Snowfall, desktop graphics and course loading

Build 0.61 adds ambient snowfall to desktop and OpenXR. Its authority is clean
Trailmap 400's world-fixed, camera-recentred weather field and the public
Slopesmith snowfall documentation and test assertions. Native uses independently
authored C++, shaders and tests; no other runtime implementation was consulted.

## Snowfall

The default level is 3 on a saved 0–10 dial: 600 flakes in a 40×34×40 m box,
lifted 5 m above the cyclopean eye. Falling speeds are 2.2–4 m/s, horizontal
drift is 0.7 m/s, and flake diameters are 0.1–0.3 m. Near and box-edge fades
shrink flakes before they reach the face or recycle. Below level 3 the field
only thins, preserving each remaining flake's path. The independently tuned
upper range increases density, drift and falling speed and tightens the box;
level 10 has 100,000 flakes. Their size stays unchanged. This upper profile is
application weather, not a recovered original per-course weather roll.

A fixed seed bakes a bounded 2.8 MB instance field once per renderer. One
instanced draw computes motion and wrapping on the GPU without per-frame
particle uploads. Flake centres wrap before expanding corners, and billboards
remain upright when the head rolls. Both VR eyes use the same cyclopean anchor
and phase. Depth testing hides snow behind opaque terrain, props and the rider;
the recovery fade includes it. The simulation clock interpolates for high
display rates, stops with pause/focus loss and resets on a new map or run.

Graphics → Snow is available in both the desktop pause menu and VR wrist menu.
Zero clears the weather; Defaults restores level 3. Settings survive relaunch.
Existing course files need no conversion or changes. Snow is enabled for every
course, matching the public play profile's application choice.

## Desktop quality

Desktop scene rendering defaults to 150% of the current client dimensions in
each direction, with 4x MSAA. Graphics offers 100/125/150/200% render scale and
Off/2x/4x/8x MSAA. Supported sample-count fallback remains active. Unsupported
scaled targets fall back to 100% with a visible notice. The readout reports the
actual scene and window dimensions. Supersampling increases pixel work and
attachment memory; 150% means 2.25 times the scene pixels.

The world resolves to a display-domain offscreen texture, then downsamples
through a clamped linear sampler. A separate pass draws desktop UI at native
window resolution. Captures retain their 1280×720 output size; their default
scene is 1920×1080. Quest continues to use the launcher's eye scale, MSAA and
target-refresh controls, with the wrist menu adding weather and display stats.

Desktop CLI overrides are `--render-scale 100|125|150|200`, `--msaa 1|2|4|8`
and `--snow 0..10`. `--graphics-preferences <file>` isolates saved settings;
`--ui-graphics` opens that page in a capture. Command-line overrides alone do
not write preferences. Native image fixtures keep weather off unless requested.

## Course loading

Selecting a desktop map immediately draws a named loading screen with a bar.
A worker prepares terrain, player/world state, tessellation, models, decoded
textures and audio. The main thread continues drawing and processing window
events. GPU texture and geometry uploads then report their actual stage and
completion fraction while drawing the previous paused scene beneath the UI.
These are stage/asset fractions, not measured download bytes or a time estimate.

The new player, GPU scene and audio become live only after preparation succeeds.
A failed load preserves the current course and returns to its map library with
an error notice. Gameplay and repeated menu actions are gated during loading;
the new course starts on foot without catching up the time spent uploading.

## Verification

The portable snowfall suite checks the public default, thinning/density,
deterministic field, large travel/teleport wrapping, ride-through parallax,
fades and clock lifecycle. Preferences tests cover bounded schema parsing,
atomic persistence, invalid writes, scale overflow and desktop/wrist controls.

Actual Vulkan fixtures cover all four desktop scales, 1x/4x MSAA and UNORM/sRGB
outputs: visible default/clear/blizzard weather, motion, fixed-clock redraw,
prefix thinning, parallax, whole-box recycling, opaque depth, reset fade and
queued stereo. They also check native UI pixels, scene-edge coverage, a filling
loading bar and drawing/retaining the old scene during an interrupted upload.
The real desktop window smoke exercises menu settings, a successful map switch
with intermediate frames, and a corrupt-map rollback.

All 52 portable suites pass. The weather/quality/UI GPU suite passes 843 checks
on both desktop and the connected Quest GPU. Existing production appearance
(14,582), avatar/controller/UI (248, including owned-course captures) and
celestial/lamp (635) GPU checks pass. Actual Snowdream captures verify clear,
ambient, blizzard and the desktop graphics page. The full repository gate
passes, including its export smoke step.

The signed 0.61.0/code 64 APK is installed with all eight imported courses and
saved launcher/audio/graphics settings preserved. Device JNI/library/SAF checks
pass 115 assertions and launcher/accessibility checks pass 157. Android lint has
zero errors and three existing warnings; signatures, sixteen packaged notices,
ARM64-only contents and absence of private course media verify. Snowdream's VR
activity launches through instrumentation; this does not establish worn rendering
or a sustained frame-rate result.

Frozen builds are `temp/native/desktop-snowfall-0.61.0` and
`temp/native/OpenSlopeNative-quest-0.61.0-snowfall-debug.apk`. The accompanying
`snowfall-graphics-0.61.0-build.json` pins commit, artifact hashes and test logs.

Worn Quest appearance, comfort and sustained frame budgets remain device
play-test work. In-world video screens remain excluded by user direction, and
the broader parity objective remains active.
