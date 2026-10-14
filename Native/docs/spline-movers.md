# Detached spline-path drawing

Build 0.26 runs authored main-type 2/subtype 1 spline movers in the shared
world graph runner. Existing native Maps need no ISO re-import. MERQUER's
subway and SNOW's three chairlift routes activate from their existing saved
behavior data, draw the shared model at independent route poses, and optionally
draw their running cables. Desktop and OpenXR consume the same drawing data.

## Recovered behavior

Clean Trailmap 150/230 describes a detached drawing node. It retains a pointer
to an authored host but does not register as that host's installed property.
Its usual preamble installs a zero/negative debounce as the registered owner.
The host placement, scale/rotation, authored collision and status remain separate
from the mover's drawing poses. Copies use positions/orientations derived from
the path alone, with immutable time-zero model geometry. Host collision does
not silently travel with these drawing copies; the shared runtime test verifies
that distinction. Model-object animation/collision is the separate 0.25 path.

The cursor starts at distance zero, advances in authored metres/second, and
samples position and unit tangent from the analytic cubic. Copies are spaced
uniformly over total route arc length. End modes are finish (retire on next
update), forward wrap, ping-pong and hold; other end modes use forward wrap.
Negative speed clamps at the starting end except for ping-pong, which reverses.
An exact held endpoint remains a valid copy position. Fixed-tick wrap boundaries
use a small numeric tolerance; wrapped copies and direction flips snap their
presentation pose rather than interpolating across the scene.

Orientation modes select tangent yaw/pitch, yaw only, pitch only or neither;
unknown values select both. The model's raw +Y axis leads with zero yaw offset.
The subway's near-quarter-turn offset points its long -X axis down the track.
Pitch reads the unit tangent's vertical component directly as radians and is
applied about model X, with no roll/bank calculation. Return legs flip pitch and
turn yaw by pi. Recovered Euler signs are converted to native matrix axes.

The optional cable is a flat-color, alpha-blended one-pixel line, sampled at ten
uniform parameter intervals per curve segment and culled per segment. Its depth
read uses the scene, and it shares the existing byte-domain color/sRGB output
and fade/fog paths. It does not require a texture or cable mesh in the map.

## Lifetime and activation

A missing registered owner or the recovered 0x0800 stop flag ends the detached
node on update. Base control commands 7/8 clear/set the flag. Clearing it cannot
resurrect destroyed motion. Dead-node mode 0 removes the registered owner;
mode 1 pauses that owner rather than owning the detached mover. Mode 2 keeps
an inert tombstone owner, so detached drawing continues while host collision
and static drawing are disarmed. Mode 3 also requests detached-node death.
A later explicit mover constructor clears the kill request and installs a fresh
cursor; this explicit re-arm matches first-party lifecycle examples. It does not
add an automatic respawn timer. Restart clears runtime movers and reapplies mode
setup. Mode-hidden hosts cannot be resurrected by persistent activation.

The application still uses the explicit 100 m cells / 300 m activation fallback,
not a decoded LTG. Reachable persistent/function/instance-hop mover routes add
path cells to the host's activation footprint. A host activates once while any
of its cells is active; leaving one cell cannot tear it down while another stays
nearby. This matters for hidden templates stored far from their route. Ordinary
region teardown removes the registered owner and therefore the mover; populated
region latches and permanent debounce retain it.

Arc sampling uses independently authored five-point Gauss-Legendre integration
over 64 intervals per curve, followed by bracketed Newton inversion. Synthetic
checks compare an accelerating cubic against an exact distance/parameter result
and a curved route against a separate composite Simpson integral. These numeric
choices, region sampling/work bounds, maximum 1,024 copies per owner and GPU
buffer limits are explicit application choices. They are not decoder algorithms.
Eye-local placement buffers grow within device limits before fence reset, so
copies do not mutate shared scene geometry or another queued eye's descriptors.
Malformed poses/copy bindings/line colors are refused before resource submission.

## Evidence and remaining parity

All 25 portable suites pass. The route suite has 66 synthetic checks and 4,512
checks with the local-course sweep. They cover arc inversion,
orientation modes, negative starts, end modes/overshoot, spacing, detached owner
and kill/tombstone behavior, delayed explicit reinstallation, route-aware region
activation, copy wraps and unchanged host collision. The eleven-course sweep
samples 13 non-rail paths and activates the one subway plus three chairlift
movers with finite copy poses.

Seven production Vulkan replays render 547 frames and assert three independent
copies, ignored template placement/rotation/scale, an unchanged shared-model
sibling, cable pixels and alpha, exact wrap restoration, continued mode-2 drawing
and mode-3 removal. The extended GPU suite passes 1,262 appearance/animation
checks including queued stereo copies, buffer growth and invalid-input recovery;
84 avatar/HUD checks also pass. Existing model-animation and world-interaction
replays pass 667 and 772 frames, including pickup chime PCM. Four targeted
MERQUER/SNOW route captures submit live copies and cables; visual inspection
confirms textured subway cars and suspended chairs/cables. Those captures are
spot checks, not whole-course or Quest performance measurements.

```powershell
./temp/native/Release/openslope_spline_motion_tests.exe temp/native-rails-0.17.0/Maps
python Native/tests/spline_motion_replay_test.py temp/native/Release/openslope_player.exe
```

ARM64 app/test APKs build; Android lint has zero errors and four existing
warnings. The Quest stays on 0.22 for the user's steering test. No worn-headset
0.26 validation or new device frame-rate claim is made. Signed versioned
desktop/APK artifacts and hashes are saved in
`temp/native/spline-movers-0.26.0-build.json`. Score/recovery regressions also pass
1,311/641 actual-player frames and 66 supported placements across eleven imports.

Original LTG activation/culling, exact arc-table equivalence, general dynamic-body
and moving-copy collision profiles, thrown/broken props/debris, counters, UV and
material animation, particle/pad nodes and application respawn timers remain
parity work. The existing fast-rotation, rising-floor and repeated-impact limits
of model-object collision remain recorded in prop-animations.md. This milestone
supplies detached path drawing rather than claiming those consumers complete.
