# Surface chunks, takeoff puffs and contact sparks

Build 0.62 fills the missing surface-ring portion of the riding effects. Desktop
and Quest use the same simulator and existing coloured particle renderer. The
authority is clean Trailmap 310/380, the shared particle registration contract,
Slopesmith's public board-FX assertions and independent scalar-data inspection
of the user's executable. No other implementation supplied runtime code.

## Functional surface data

`Contracts/surface-spray-v1.json` contains all twenty measured functional rows:
rate, size, fade bounds, sprite registration and opacity. Its companion layout
contains only record size/count and relative scalar positions. An independent
bounded evaluator identifies the initialized table through the already shared
motion response facts, not an executable address or fixed byte signature.
The recovered table's 200 known motion fields agree with the rounded ride
contract; its 140 typed effect fields match the committed spray profile exactly.

The inspection command is `openslope_import surface-spray <user-supplied.iso>`.
`python tools/contracts/check-surface-spray-contract.py <user-supplied.iso>` reproduces the
comparison without modifying the input. Relocated original synthetic programs
cover both register comparisons needed by initialization, every row, duplicates,
ambiguity, unknown bytes, typed limits and immediate/mid-analysis cancellation.
The evaluator remains bounded and never executes the supplied binary as host code.

The runtime embeds those functional facts. Existing imported and custom maps
need no conversion: sprite lookup uses their existing explicit `EmitterSprites`,
named bank or registered `Textures/Particles` files. Missing art stays absent.
No disc, course media or extracted sprite image is packaged with the app.

## Ring behavior

Ground emission follows the clean speed × squared-lean gate. A fixed tick
allocates at most one surface slot, retaining its integer billboard count rather
than discarding powder's excess. Packed snow draws small alpha-over blb1 chunks;
off-track snow uses swp2, powder uses larger str3 twinkles and ice uses small cnf2
shards. The zero-rate rows remain silent. Size stays fixed per billboard and
opacity fades over the row's maximum fade time.

Chunks scatter across the deck's recent contact strip, retain a random share of
its forward velocity and throw up/out of the turn. Their velocity contribution
decelerates on the specified polynomial clock and clamps at its endpoint. The
ground probe keeps their emission on the visible contact when the deck is buried
in powder. Leaving the ground seeds the 70-per-second puff activity, decays it
toward ten and scales it down at low speed. These additive swp2 puffs trail the
board. Non-metal rail travel also admits the specified half-tick puff stream.

Rail grinding and rock/metal/ramp contact throw warm additive sparks, roughly
one per tick. A one-per-second random gate adds a 17–18 spark flare with a longer
fade and stronger throw. Seven tapered, time-offset copies form each comet trail.
The throw follows travel on either end of a switch deck; rail spawn points
interpolate along the travelled segment. Spark flight has its faster clamp clock,
20 m/s² gravity, linear opacity fade and blue lift toward pink-white.

Independent deterministic randomness belongs to the FX simulator and cannot
change physics or the existing cloud random stream. Rendering reconstructs an
interpolated snapshot without advancing clocks or consuming randomness. Pause
holds it, restart/reset clears it and dismount stops emission while old particles
finish fading. Walking and Superman flight do not emit board takeoff puffs.

## Explicit application choices

The softened throw's half-slope above 4.5 m/s, full-lean throw-axis tilt, small
chunk gravity term, puff size/opacity, 5 ms spark-copy spacing and deterministic
seed are native presentation tuning where the clean body does not fix an exact
binding. These are documented rather than claimed as recovered constants.

There is one bounded forty-slot ring shared across surface changes. A slot can
carry a surface/puff payload and the same tick's spark payload: at most 64
surface dots and eighteen sparks, with seven drawn copies per spark. Thus the new
snapshot cannot exceed 7,600 sprites. It shares the existing 32,768-sprite frame
budget with authored effects, reserving space for nearby rider feedback when a
large world burst fills that budget. These limits and the five-metre placement
discontinuity guard are application bounds. Exact original RNG/throw bindings,
the other spray/sheet curves, debris and pickup effects remain comparison work.

## Verification

The simulator suite checks every row, sparse straight travel, multi-billboard
powder slots, throw signs, visible buried contact, size/alpha, interpolation,
pause/reset/expiry, takeoff decay, stationary/off-board gates, spark trails,
flare cadence and pool bounds. Six production desktop replays cover packed snow,
powder, ice, metal, rail travel and a charged jump. Each has visible new pixels
with identical player position/velocity when the art is enabled or disabled.

Real Vulkan fixtures isolate the source textures by colour and cover all seven
effect situations on UNORM/sRGB with 1x/4x MSAA, opaque-world depth, reset fade,
repeat draws, queued stereo parallax and empty-frame cleanup. Broader feature
parity and worn Quest appearance/performance remain active work.

The connected carve sheet also adopts the public board-FX always-pass depth
profile. Paired front/behind checks on both target formats establish this
application presentation choice separately from ordinary particle occlusion.

The final build passes all 54 portable suites. The simulator passes 2,675 checks
on desktop and Quest ARM64; the new source-art/depth/stereo suite passes 621 on
both GPUs. The broader production appearance suite passes 14,584 on both GPUs,
including the connected sheet's new depth profile. Desktop weather/quality/UI
(843), avatar/controller/UI (248) and celestial/lamp (635) checks also pass.
The full repository gate passes in 401.6 seconds.

Actual owned-sprite captures of powder, metal and rails retain identical player
position/velocity against frozen 0.61.0. Independent data recovery was checked
against the supplied USA image; no PAL image or arbitrary executable revision
is claimed. Exact original throw/seed bindings and worn performance remain open.

Version 0.62.0/code 65 is packaged for desktop and Quest. Frozen artifacts are
`temp/native/desktop-surface-fx-0.62.0` and
`temp/native/OpenSlopeNative-quest-0.62.0-surface-fx-debug.apk`; the accompanying
`surface-fx-0.62.0-build.json` pins source, artifact hashes and verification logs.

The signed final APK is installed, with all eight courses, checked effect/audio
sidecars and saved launcher/audio/graphics settings preserved. Device checks
pass 115 JNI/library/SAF and 157 launcher/accessibility assertions. Android lint
has zero errors and three existing warnings; both signatures, sixteen notices,
ARM64-only contents and absence of private course media verify. Snowdream's VR
activity starts through instrumentation; worn appearance and sustained FPS are
not established by that startup check or the offscreen GPU suites.
