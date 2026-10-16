# Prop lighting preview alignment

Build 0.57.0/code 60 corrects the overbright Merquer gate and other imported
props in the shared desktop/Quest renderer. Version 0.56's contact, depth and
version-label changes remain in place.

## Authority and data checks

Native guidance is the sanitized clean Trailmap 160/400 lighting interface,
public first-party documentation/tests, ordinary lighting mathematics, owned
exported data and visible black-box app output. No differently licensed decoder
or other runtime implementation supplies this code.

The Merquer gate textures 0061/0062 match the existing exported pixels. Lamp
0047 and platform 0040 match too, as do their audited UVs/normals. Their instance
lighting records also agree. Changing texture files, artificially dimming all
props or normalizing HDR input records would hide the rendering error and damage
authored full-bright surfaces.

## Independent calibration

A temporary map contains a uniform `(200,160,120)` texture and five quads whose
ambient records are 64, 128, 256, 512 and 4096. The real Slopesmith app draws
`(50,40,30)`, `(100,80,60)`, then `(200,160,120)` for all three remaining quads.
A second quad interpolates stored normals from negative X to positive X, with
an HDR positive-X key. It draws a black left half and texture-true right half.
Native's former vertex-light interpolation drew a brightness ramp instead.

The source app is observed through its documented BrowserView view link, with
an isolated local project, explicit world-space camera, clean textured preset,
settled assets and no asset errors. The Native production player uses the same
authored geometry and camera. The reference runtime's implementation is neither
read nor queried for shading guidance. Temporary calibration assets are original
and contain no disc media.

## Rendering policy

The shared shader interpolates the supplied model-local normal, normalizes it,
then evaluates ambient plus three positive normal/key dot products. A zero
normal contributes no key light. HDR records stay intact until the sum is
clamped to `[0,1]`, before multiplying the decoded texture in its byte domain.
Placement and camera rotations never enter that baked model-local dot product.

This is explicitly the first-party preview/play profile. Clean 400 describes
the original renderer's vertex-stage clamp and Gouraud interpolation; Native
does not claim that original interpolation is equivalent to this profile.
Clean 160's coordinate frame, authored normal splits and stored light records
are preserved. Untextured or missing-image prop materials use the first-party
warm neutral `(194,187,170)` fallback. Effect/board white tiles are separate.

Lighting blocks are flat varyings shared by each primitive, while the normal
interpolates. This avoids extra fragment storage-buffer lookups and preserves
the existing 192-byte placement format, instancing and per-eye isolation.
Terrain lightmaps, fog, alpha/depth ordering and authored self-lit props retain
their own existing paths.

## Validation

All thirteen sampled calibration pixels match the reference exactly, including
both sides of the opposed-normal quad. On the matched Merquer gate roof, mean
absolute byte error per RGB channel falls from `(37.86,48.79,41.16)` in 0.56 to
`(1.59,1.25,0.98)`. Selected pillar/beam samples also agree within two byte levels.
This is a focused prop comparison, not a claim of identical whole-scene output;
other material, filtering, effects and animation differences remain.

Production GPU fixtures cover the five ambient levels, opposed-normal half
plane, neutral fallback, HDR grazing keys, rotated placements, private texture
frames and queued stereo views, on UNORM/sRGB targets with one/four samples:
14,528 texture/lightmap checks pass. Dedicated suites also pass 585 celestial,
depth/HUD/stereo checks and 207 avatar/controller/wrist checks. All 49 portable
Native suites pass, and production captures load all eleven owned courses.
The complete repository verification gate also passes in 364.4 seconds,
including the full Slopesmith tier, coverage and the generated-map smoke flow.

Three 180-frame desktop Merquer runs per build sample median GPU times of
4.30 ms before and 4.04 ms after, with median render wall times of 6.90/6.28 ms.
No desktop slowdown is observed in that narrow check. These sequential samples
do not control GPU clocks, establish a general performance gain or measure Quest.

The Quest upgrade preserves all eight installed courses and saved launcher/audio
preferences. The exact installed APK hash matches the saved 0.57 artifact.
115 JNI/library/SAF checks and 157 launcher/version/accessibility checks pass.
A twelve-second Merquer smoke launch initializes both eyes at 2520x2640 with
four samples and a runtime full-body tracker. Its XR session is idle/unfocused;
worn appearance and sustained frame rate still require a physical play test.
APK signatures, sixteen exact packaged notices, the Native source boundary and
Android lint pass (zero errors, three existing warnings).

Saved artifacts are `temp/native/desktop-lighting-0.57.0` and
`temp/native/OpenSlopeNative-quest-0.57.0-lighting-debug.apk`. The adjacent
`prop-lighting-0.57.0-build.json` records the source commit, hashes and evidence.
Owned captures, comparison PNGs and original calibration maps stay ignored under
`temp/`; the temporary calibration entries are removed from the playable Maps
library after preserving them there.
