# Course sun and beams

Build 0.42 consumes the portable `World.json` / `Glare` settings on desktop and
OpenXR. Clean Trailmap 400 supplies the celestial body, separate core/rim colours,
camera-relative distance and radius, squared screen-distance attenuation and
depth-independent additive fan. Slopesmith's public 049 documentation and
god-rays tests supply the application presentation and portable parameter names.
Its original 32-spoke pattern is shared through Contracts/celestial-spokes-v1.json
and checked against the public API. It is first-party presentation data; the
original engine's separate arbitrary 37-spoke table is not included.

`Glare.Enabled` is authoritative; absent settings stay off. `CoreColour` and
`RimColour` are independent 0..255 triples. `FanIntensity` and `SpriteIntensity`
retain their independent values. `AzimuthDegrees` and `ElevationDegrees` are in
the raw map frame: azimuth zero is +X, the horizontal plane is XY and elevation
is +Z. Native's proper `(x,z,-y)` rotation converts the direction together with
the course. `DistanceUnits` and `SizeUnits` stay in centimetres in the file and
become metres for drawing. Size is a radius/half-extent. A near far plane scales
distance and radius together. Complete first-party defaults support partial
authored records; invalid/nonfinite fields reject loading. Disabling fog does
not prevent the sun settings from loading.

Desktop beams fill the view with independent wedges. Standard rectangle/half-plane
clipping includes corners and handles a projected sun outside the viewport without
overlap or missing areas. Each wedge retains its own brightness, attenuated by
`max(0, 1 - distanceSquared / 3)`. This is independently authored geometry, not a
port of another renderer's fan builder. Fan colour uses the public 128/255 display
gain; the separate textured corona uses 255/128. The layer draws after world,
particles and rider geometry with depth disabled and no depth writes. Desktop and
wrist UI have a later draw so menu text remains readable.

VR uses the public port's shared sky disc with a 40-degree angular radius,
anchored once at the tracked head. Each eye projects that same world body through
its own asymmetric view. Homogeneous W survives interpolation. The disc has a
soft outer fade and retains the separate broad corona. The corona uses only the
top-right quadrant of the named `lens` atlas; cropping before mip generation
prevents the neighbouring star/ring from bleeding into it. Missing or unsuitable
atlas layout uses an independently authored 64x64 smooth radial corona. It adds
no compact core or extra spiked sprite.

As in Slopesmith's application realization, five terrain sight tests in a small
cone determine whole-layer visibility. The fan itself remains depth-independent;
terrain visibility is a separate fade. Native samples this cone at 10 Hz, eases
with a 0.12-second half-life and samples a new course before its first draw.
Those timing/cone/disc fade choices are application tuning. Props do not occlude
the layer. The original engine's always-visible composition, exact packet
quantization and complete display-domain blending on sRGB targets remain distinct
fidelity work. No new worn-device performance or comfort claim is made.

Validation includes 41 portable suites and 977 celestial assertions, front/behind/off-screen coverage,
full viewport area, radius/far clamp, common stereo anchor, terrain visibility,
portable field validation and atlas selection. Actual Vulkan tests cover both
UNORM/sRGB targets and 1x/4x MSAA, late HUD colours, behind-camera suppression,
translation invariance, world/rider depth independence, reset fade, queued-eye
isolation and rejected-input recovery (565 checks). Five actual-player cases render 300 frames
for enable, view direction, terrain visibility and unchanged rider physics.
All eleven private world profiles load with four enabled suns (989 combined
authored/owned checks). The actual Mesa before/after comparison renders another
62 frames with identical rider position and velocity and visible beams. These existing
map folders also exercise explicit null flipbook fields, now accepted as empty
animation lists alongside missing/empty lists.

The Quest SAF tests retain enabled settings and authored nested lens art without
requiring an imported profile. The ordinary folder/cache flow remains unchanged.
Retail map data, atlas images and owned captures stay local and are excluded from
application packages.

The full repository gate passes. The signed ARM64 app is 0.42.0/code 43, with
16 notice/license assets matching their sources and no private course/media files.
Lint reports zero errors and four existing warnings. Quest passes 94 JNI/custom
library/SAF checks. An eight-second Alaska activity check creates both 1680x1760
eyes at 4x MSAA and the full-body tracker; user map and library preference hashes
are preserved. This is startup/cache evidence, not a worn sun-rendering or FPS
measurement.

The full repository gate passes. The signed ARM64 app is 0.42.0/code 43, with
16 notice/license assets matching their sources and no private course/media files.
Lint reports zero errors and four existing warnings. Quest passes 94 JNI/custom
library/SAF checks. An eight-second Alaska activity check creates both 1680x1760
eyes at 4x MSAA and the full-body tracker; user map and library preference hashes
are preserved. This is startup/cache evidence, not a worn sun-rendering or FPS
measurement.

## Remaining import and presentation work

Native's independent ISO importer still does not recover the executable's
per-course sun/sky configuration. Existing maps with `World.json` and authored
maps use their own settings now; a Native-only ISO import without that metadata
keeps the sun disabled. For private Mesa comparison, its existing portable
World.json was supplied to the older native map cache; this is comparison input,
not evidence of an automatic ISO settings extraction. Do not mark that importer
gap complete based on renderer tests. Original sky channels, weather, point-light
flares and the wider parity matrix remain active. Worn Quest confirmation of sun
appearance, terrain fading and comfort remains separate from APK/device checks.

```powershell
./temp/native/Release/openslope_celestial_tests.exe
./temp/native/Release/openslope_celestial_tests.exe Maps
python Native/tests/celestial_render_test.py temp/native/Release/openslope_celestial_render_tests.exe
python Native/tests/celestial_replay_test.py temp/native/Release/openslope_player.exe
```
