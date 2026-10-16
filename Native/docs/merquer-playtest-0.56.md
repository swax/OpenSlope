# Merquer play-test follow-up

Build 0.56.0/code 59 addresses the reported prop-contact stalls and distant
surface flicker, and displays its version in the application. It uses the clean
Trailmap lighting/rendering interfaces, public Slopesmith documentation/tests,
standard numerical/rendering techniques and independently inspected owned map
data. No other runtime or differently licensed decoder supplies Native code.

## Version display

`VERSION.txt` supplies both the CMake-generated Native version and Gradle's APK
version name. The desktop pause menu, VR wrist menu and accessible Android
launcher show it. The Android check verifies the displayed string against the
installed package. Desktop pixel checks retain separated heading rows and a
compact panel after adding the label.

## Prop-contact work

The occupancy query previously chose its analytic sphere path only when three
computed affine scales were exactly equal. Imported float transforms, and their
composed moving poses, usually fail that equality. Nominal spheres could invoke
the iterative ellipsoid-distance solver throughout the hierarchy, multiplied
by compound leaves, contact iterations and nearby live bodies.

Queries now reject outside a conservative swept bounding sphere first. A nearly
round affine sphere uses an analytic enclosing sphere when its maximum surface
expansion is at most 0.01 mm. This is explicit application numerical policy;
genuine nonuniform scale and shear retain their affine solver. Original leaves,
mass, inertia, rider impulses and graph lifetimes remain in use. Collision tests
cover contact time, stationary penetration, off-axis misses and the empty gap
inside a genuinely compressed ellipsoid's enclosing sphere. This does not claim
bit-identical secondary body trajectories after changing numerical contacts.

A standalone CPU probe uses the actual installed MERQUER data on Quest: all 88
can placements, 24 fixed ticks each, with a rider impulse and live can/lid bodies.
The previous core's largest sampled body tick was 47.99 ms; the updated core's
was 9.47 ms. Total body work across those 2,112 ticks fell from 9,771.95 to
6,959.13 ms. These are physics measurements without rendering, not a sustained
VR frame-rate result or a guarantee for every future pile-up.

The tracked owned-map suite also advances every can/lid chain for 72 ticks,
checks their live finite poses, and drives real mounted Player contacts through
two crowded approaches. Together with GARI walking/riding, impulse, shape,
sleep and restart coverage, it passes 489 assertions. Owned maps remain local
test inputs and are not packaged.

## Depth and texture filtering

The renderer now uses reversed D32 floating-point depth: near is one, far/clear
is zero, depth passes on greater-or-equal, and the infinite sky draws at zero.
The same projection feeds desktop, each XR eye, culling and world-space UI.
Visibility distances and the authored lighting equation are unchanged.

A new GPU fixture puts a rear surface one millimetre behind a front surface at
300 metres, deliberately drawing the rear material last. The front colour
survives on UNORM/sRGB targets at one and four samples. The full appearance suite
passes 13,924 checks, including texture/lightmap channels and material layers;
585 celestial/glint/depth checks and 222 avatar/wrist/stereo checks also pass.
Desktop UI replays cover 96 frames at origins separated by five kilometres.

Diffuse samplers additionally use up to 4x anisotropic filtering when the device
supports and enables that feature. Unsupported devices retain ordinary filtering.
Sky and gutterless lightmap samplers retain their separate policies. This aims
to reduce angled-texture shimmer without changing the exported colour domain.

## Lighting investigation and limits

The Quest's actual MERQUER instance sidecar and lamp/start texture hashes match
the locally audited Native map. Lamp texture 0047 and platform texture 0040 also
match the existing exported PNGs byte for byte. The street-light model's 53
expanded triangles match the existing export's geometry, UVs and stored normals
within export precision; matched platform faces show the same UV/normal result.
Its ambient 256 / zero-key block is authored full-bright data. Native preserves
that instead of applying an arbitrary global dimmer.

These checks found no corrupt lamp/start copy or lamp UV/normal/texture decode
mismatch. They do not establish the user's perceived brightness match in
worn VR. Broader Merquer prop appearance remains open for a rendered comparison,
as does confirmation that the reported windows are resolved on the headset.
Quest train visibility, fence flex, in-world screen video and the rest of the
play-parity goal remain active.

The subsequent 0.57 rendered comparison identifies and corrects the prop-light
staging and saturation differences; see prop-lighting-0.57.md. The original
data checks and 0.56 measurements above remain historical evidence.

## Saved build and device validation

The final repository gate passes in 249 seconds, including all 49 Native suites
and 227 Slopesmith full-tier groups with coverage. Android APK builds, signatures,
lint and package checks pass. The ARM64 package includes the sixteen exact
notices and no private map media.

The connected Quest is upgraded to 0.56.0, preserving the checked sidecars of all
eight installed courses and the saved launcher/audio preferences. It passes 115
JNI/library/SAF checks and 157 launcher flow, version, scaling and accessibility
checks. A twelve-second MERQUER launch initializes both eyes at 2520x2640 (150%
of 1680x1760), four samples, and the high-fidelity runtime full-body tracker.
The session remains idle/unfocused during this check; worn appearance and
sustained target refresh/FPS are not established.

Saved artifacts are `temp/native/desktop-merquer-0.56.0` and
`temp/native/OpenSlopeNative-quest-0.56.0-merquer-debug.apk`. The adjacent
`merquer-0.56.0-build.json` pins the source commit, hashes and validation. Local
profiling, comparisons and device captures stay ignored under `temp/`.
