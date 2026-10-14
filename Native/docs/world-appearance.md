# Sky panorama and distance fog

Clean Trailmap 220 and 400 establish a small camera-centred model panorama,
using its own texture bank, behind the course. It rotates with the view and has
no translational parallax. Its open top exposes the clear colour. Clean 442
places the original course sky colour in executable initializer data; that
table is not published in the clean chapter body and is not compiled here.

The independent ISO importer converts the optional `<course>_SKY.PBD` and
`<course>_SKY.SSH` pair into the existing `Skybox/Models.json`, `Materials.json`,
`Meshes/*.obj` and `Textures/*.png` contract. It reuses Native's bounded model,
material and texture readers. Sky records have neutral names and need no world
linker or placements. A missing pair is a valid course without a panorama;
a partial pair rejects and rolls back the new import. Original colour, sun,
weather and other world parameters remain unconverted.

Existing custom/extracted maps use this same `Skybox` folder without
`Instances.json` or `Ring.json`. Local hierarchy transforms and the usual raw
centimetre axis conversion apply. The renderer draws each model part once,
unlit, with mipmapped clamp-to-edge art. Geometry/images are shared by both eye
renderers. Each eye cancels its own camera translation before projection, so
the background has no stereo disparity from the ring's small physical radius.
The sky pass uses far depth, depth tests, opaque colour and disabled depth writes.
It does not enter course collision, world placements or terrain visibility.

Sky PNGs share the 256 MiB decoded course-image budget and the 512 MiB GPU sampled
image budget with ordinary art. The Quest document-folder cache preserves sky
metadata and only its referenced meshes/art, with the existing combined image
and geometry copy budgets. Unsafe paths, incomplete tables and present corrupt
images reject playback. Missing art uses the ordinary image fallback.

An optional `World.json` supports explicit application settings:

```json
{
  "Schema": "openslope-world/v1",
  "SkyColor": [90, 110, 130],
  "Fog": {"Enabled": true, "Start": 600, "End": 2200, "Color": [90, 110, 130]}
}
```

Colours are display-domain channels in 0..255; fog distances are metres,
0 <= Start < End <= 10000. `Fog: {"Enabled": false}` disables haze. Unknown
fields, including existing `Glare` metadata, remain available for later consumers.
Profiles are limited to 64 KiB and must stay within the course directory.

Without `SkyColor`, the uppermost sky parts' top image rows provide an
alpha-weighted seam colour. Parts crossing camera-relative height zero provide
the horizon colour at their interpolated image row, unless fog colour is
explicit. Repeated texture references count once. Sampling uses geometry UVs
and canonical decoded pixels, not a title/texture-ID lookup. Courses without
sky retain the prior blue clear and no default fog. Panorama courses default
to linear haze from 600 to 2200 m. These distances, horizon sampling and radial
fog are explicit application choices; original image/trajectory parity is not
claimed. Native does not currently consume a separately recovered sky-colour
table from another component.

Fog blends the shaded display-domain RGB toward the horizon colour using each
fragment's distance from the eye. Props use their world placement; the diagnostic
board uses the corresponding local eye. Additive clouds/sheets attenuate their
colour instead of adding fog colour; alpha wakes attenuate opacity. The sky is
excluded. Shader colour and clear values convert to linear only for an sRGB
attachment. Existing sRGB translucent/additive compositing remains approximate.

Portable authored checks cover model-only loading, nested references, colour
derivation/override, fog bounds, unsafe/incomplete input, optional sky import and
failed-import cleanup. All 11 portable suites pass. The 1,112 actual Vulkan
assertions cover rotation, translation,
left/right eye offsets, foreground depth, open-top clear colour, near/far fog and
target recreation on UNORM/sRGB attachments at 1x/4x MSAA, placed props and
full fog attenuation of additive clouds/sheets and alpha wakes. Run:

```powershell
python Native/tests/appearance_test.py temp/native/Release/openslope_appearance_tests.exe temp/native/Release/openslope_render_tests.exe
python tools/native-compare-sky.py <native-course> <existing-course>
```

The output comparator ignores provenance comments and neutral labels; it checks
hierarchy/TRS, material/texture bindings, exact decoded RGBA, expanded triangles,
UVs, normals and winding, allowing 0.001 raw cm for mesh positions. All eleven
owned local courses match their existing sky output, including 25 exact RGBA
images and 188 triangles per course; worst position difference is 0.00009 raw cm.
Retail assets remain local and excluded from source control, desktop builds and
the main APK. Headset checks for this milestone remain separate from authored
stereo captures.

A 120-frame local GARI carve replay preserves identical rider/contact state
between builds 0.14 and 0.15 while changing 70,233 captured image channels.
One local sample measured render wall 0.390 to 0.409 ms and GPU time 0.188 to
0.218 ms. These short headless measurements describe added rendering work;
they do not establish a general performance improvement or a Quest frame budget.
Existing actual-host jump, four collision cases, audio routes, six wake cases
and eight sheet cases also pass. The ARM64 main/test APKs compile and lint passes.

Full parity still needs recovered authored sky colours, broader world settings,
sun/glare, snow, animated materials/live objects, render quality and performance
work in the desktop-parity.md matrix.
