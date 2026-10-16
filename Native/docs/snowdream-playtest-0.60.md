# Snowdream crash bags and flare halos

Build 0.60 addresses the reported crash-bag stalls and missing circular rings
around Snowdream's ground flares. These are independently authored changes to
Native collision/rendering. Clean Trailmap 130/370 establish the collision
features and 160 establishes lamp hue, size, brightness, range and depth. The
public Slopesmith light-glint documentation identifies the owned lens atlas as
the preferred art, with a procedural fallback. No other runtime implementation
or differently licensed decoder was used.

## Compound collision work

Each of the 33 imported Snowdream bags has 452 collision spheres. The terrain
query previously tested every leaf against each nearby patch's 64 sampled
cells, including cells outside the entire body's swept bounds. It now rejects
those cells before visiting individual leaves. Triangle sweeps also reject
motion outside the plane's radius-wide slab and return immediately when the
initial face overlap or the first face entry already establishes the earliest
contact. Edge/vertex sweeps remain active for the other cases.

No collision leaves, masses, inertia, contact iterations or motion rules were
removed. The isolated replay advances all 33 bags for 24 ticks with a fixed
rider shove. All 792 resulting matrices match the previous core exactly on
desktop, and a separate comparison on Quest also retains all 792 matrices.

The desktop replay's total body work fell from 6,601.49 to 1,118.69 ms; its
largest sampled tick fell from 41.19 to 6.27 ms. On the Quest ARM64 CPU, the same
replay against its existing imported SNOW folder fell from 6,338.88 to
1,375.71 ms total and from 17.42 to 6.00 ms for the largest sampled tick.
These are isolated CPU measurements without rendering, not a sustained VR
frame-rate claim or a guarantee for every simultaneous pile-up.

The tracked owned-map suite additionally activates all 33 bags through their
real world graphs for 72 ticks apiece, checks live/finite poses and preserves
all 452 leaves. Together with all 88 Merquer can/lid chains and existing real
GARI walking/riding checks, it passes 622 assertions. Analytic triangle tests
cover both face sides, stationary overlap, parallel misses and vertex entry
while already inside the plane slab.

## Circular flare halos

The previous lamp shader always used an invented soft radial glow, which
cannot draw the atlas's circular ring. Lamp batches now use the extracted lens
texture: upper-left ring, upper-right fixed soft core and lower-left star.
Each tile is sampled with a half-texel inset and a clamped, base-level sampler
to keep neighboring tiles out. The ring uses the light's ordinary brightness
gain; the old quarter-strength soft-glow multiplier is removed.

Custom maps without a usable atlas use an independently authored circular
rim, soft core and crossed-star fallback. A non-even or undersized atlas
selects that fallback. Light selection, shared source hue, centredness,
world-sized ring, fixed pixel core, range and depth testing are retained.
Opaque terrain and props continue to occlude the sprites per pixel.

GPU fixtures isolate ring/core/star quadrants with distinct colors, check a
visible rim with a dark interior, and cover absent/invalid art plus complete
and partial occlusion on UNORM and sRGB targets. Paired captures of the actual
Snowdream start and a nearby red flare also use its unchanged imported lens
texture. This establishes the circular ring in Native; exact whole-image
Slopesmith calibration and worn Quest appearance remain separate checks.

## Build verification

All 50 portable Native suites pass, along with 14,582 production Vulkan
appearance checks, 233 avatar/controller/UI checks and 635 celestial/lamp/depth
checks. Repository hygiene, Slopesmith type/lint/full coverage and production
build pass. The export smoke step initially hit a Windows folder-rename lock;
it passes when rerun after stopping the temporary comparison server.

The signed 0.60.0/code 63 APK is installed. Its exact package hash, all eight
courses' checked sidecars and saved launcher/audio preferences are verified.
Device checks pass 115 JNI/library/SAF and 157 launcher/accessibility assertions.
Android lint has zero errors/three existing warnings; both APK signatures and
sixteen packaged notices verify. No private course media is packaged.

Frozen artifacts are `temp/native/desktop-snowdream-0.60.0` and
`temp/native/OpenSlopeNative-quest-0.60.0-snowdream-debug.apk`. The accompanying
`snowdream-playtest-0.60.0-build.json` retains commit/artifact hashes and the
replay/verification logs, including the separate smoke retry.

Desktop supersampling with a 150% default, menu graphics controls and map-load
progress feedback are the next user-requested UI work. In-world video screens
remain excluded by user direction; broader gameplay parity remains active.
