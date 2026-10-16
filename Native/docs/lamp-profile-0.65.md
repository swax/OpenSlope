# Ground-flare preview profile

Build 0.65 brings the restored ground-flare halo closer to the Slopesmith
preview. A matched Snowdream camera showed the previous ring mostly clipped by
the ground and its star art compressed into thin crossed rectangles. The new
profile uses square star quads, a soft same-hue aura, a smaller world footprint
and a bounded pull toward the camera. The fixed 16x8-pixel core remains at final
output resolution. Lens art and exported map data are unchanged.

## Authority and presentation choices

Clean Trailmap 160 remains authoritative for the small-resolution gate,
Euclidean hue, per-record brightness, ten nearest on-screen sources, centredness
to the fourth power, screen-X rotation, range fade and additive composition.
The nonzero small-class mask admits a pixel core even when it names no single
size class; it then has no world glow.

The play profile is an explicit application choice aimed at the requested
Slopesmith appearance. Public Slopesmith documentation and behavioral tests
describe same-hue aura, class ratios of 0.5/1/2, camera pulls of 3/5/8 metres and
shared stereo bloom with eye-specific star rotation. Native implements these
independently. No Slopesmith/Unity runtime implementation or tuning module was
read or imported for this work.

An independently calibrated medium-class quad spans 0.9 metres before centre
bloom, with the ring, square stars and soft aura sharing that footprint. Small
and large scale by their class relative to 32. Pull is capped at half the source
distance to keep nearby sprites in front of the eye plane. The fixed core is
computed at the pulled depth so moving the glow does not enlarge its pixel
footprint. Missing lens art uses the existing procedural ring/core and a square
cross-star fallback.

These settings differ from Trailmap's approximate original world sizes and
source-depth placement. Geometry in front of the pulled billboard still
occludes it per pixel; geometry between the source and billboard can be passed
by the pull. This is the preview's depth-tested presentation, not a claim of
original source-visibility fading. Unity's runtime visibility kernel remains
outside this milestone.

## Stereo and validation

OpenXR computes both eye matrices before submission, then averages their full
view-projections and world eye positions. Both draws use that common projection
for bloom and its common anchor for pull and distance gain. Billboarding and
star rotation retain the individual eye view. Per-eye dynamic vertices are
still owned by the corresponding renderer through GPU completion.

CPU checks cover class ratios/pulls, square art, the unknown-size core, constant
pixel extent at pulled depth, a near-eye pull bound and shared bloom with
distinct eye rotation. The Vulkan suite exercises lens atlas/fallback/invalid
art, circular ring/aura, occlusion and queued stereo draws on UNORM/sRGB targets
with 1x/4x MSAA. It verifies both eyes remain visible with matching glow energy.

The matched-view comparison uses the existing full Snowdream export as the
read-only Slopesmith reference and the Native import in the Native player. The
reference's displayed comparison translation and mirrored editor X are applied
through its public camera panel. Both renders use the same physical viewpoint
and 78.15-degree vertical field of view. The browser's 2560x1440 canvas export is
reduced to the Native capture's 1280x720 for comparison. The halo and sparkle
composition are substantially closer; other world details and final brightness
are not claimed pixel-identical. Captures and private art remain ignored.

Build hashes, complete test counts, installed-device preservation and validation
logs are recorded in the frozen `lamp-profile-0.65.0` build manifest. Worn-VR
appearance and performance remain play-test work. In-world videos remain
excluded and the broader gameplay parity goal remains active.

All 55 portable suites pass. The focused CPU suite passes 1,003 synthetic
assertions, 1,023 with all eleven desktop course profiles, and 1,018 with the
Quest's eight courses. Both GPUs pass 789 celestial/lamp assertions and all 845
weather/supersampling/native-UI checks. The full repository gate passes in
290.0 seconds; final hygiene and the 400-file Native source-boundary audit pass.
Android lint reports zero errors and three existing warnings. Both APK
signatures verify, with sixteen packaged notices and no private course media.

The signed 0.65 APK is installed with all eight courses, tested sidecars and
saved preferences preserved. Device JNI/library/SAF checks pass 115 assertions
and launcher/accessibility checks pass 157. Snowdream's VR activity starts for
twelve seconds at 2520x2640 per eye and 4x MSAA. The unworn runtime remains in
session state 1 without resumed/focused simulation, so this establishes startup
and resource creation rather than worn frames or sustained frame rate.
