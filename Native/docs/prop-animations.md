# Model-object animation and moving contacts

Build 0.25 adds per-instance model playback to the shared desktop/OpenXR player.
Nearby persistent graphs install their own animation nodes; multiple placements
of one model keep separate clocks and poses. Geometry stays uploaded once.
Rendering, culling and collision use the same model-object transforms. Existing
native imports use their saved behavior file and Models.json without an ISO
re-import; custom maps can provide the same portable files.

## Clip and property behavior

Clean Trailmap 120 supplies the six cubic channels, absolute clip seconds,
window clamping, base-translation replacement, Z/Y/X composition and parent
hierarchy. Unchannelled rotation is zero, and an animated object ignores its
stored rest rotation/scale. Static and mesh-less parents still compose once.
Clips use 30 frames per second. Time-zero model poses remain compatible with
the earlier static renderer and collision loader.

Clean 150/230 supplies property subtypes 256 (real time), 257 (budgeted delta)
and 258 (idle plus triggered combo). The runner supports once/wrap/ping-pong,
reverse, authored clip windows/rates, random rate/start and contact debounce.
A zero-length resolved window installs no player. Delta playback starts frozen;
control command 2 grants value/30 clip seconds, so slower clips consume their
budget more slowly in wall time. Delta nodes do not retire at a clip endpoint.
Commands 1/3/4 hold, trigger a combo or seek. Combo playback retains the idle
snapshot, composes it with the second local object pose before parent hierarchy,
and resumes or latches according to the end sign. Subtype 257's integer-encoded
start word is interpreted as its preserved float payload where applicable.

An ordinary one-shot requests slot 4 once on completion. A populated slot 4,
even an empty graph, suppresses default node teardown and can latch the pose.
Property sub 5 mode 0 destroys/restores, mode 1 pauses a current animation and
modes 2+ tombstone the instance. Mode-setup hides cannot be resurrected by a
nearby persistent graph. A full run restart clears runtime clocks and regions,
restores authored state and applies the chosen mode function again.

## Region lifecycle

The application builds sparse 100 m cells and activates cells within 300 m of
the rider or most recently supplied camera position. These are explicit
application choices informed by clean 400's range/grid observations; the source
LTG layout and exact original visibility footprint are not imported yet.
Desktop supplies its camera and OpenXR supplies tracked eye positions.

Clean 150's persistent circumstance runs on activation. One empty beat retains
the region; a second deactivates it. Populated slot 3 suppresses ordinary
teardown, including when its graph is empty. Reactivation preserves an installed
node retained by that latch. Otherwise region teardown restores the static pose
and re-approach can install a fresh node. Negative debounce and permanent
tombstones survive ordinary region teardown. Positive debounce requests its
node-end chain; zero debounce lasts until ordinary teardown.

## Rendering and collision

Model-object pose deltas transform each immutable mesh part. Its transformed
bounds drive distance/frustum culling and translucent sort position, so an object
can enter view even when its time-zero bounds were outside. Key-light directions
are transformed to retain lighting with the animated normal. Fixed-tick previous
and current poses feed presentation interpolation; per-eye descriptor buffers
retain the existing deferred stereo submission ownership.

Collision boxes, triangle proxies and occupancy bodies follow the same object
poses. Only changed BVH leaves and ancestors are refitted. Sweeps account for
object translation relative to the rider; contacts report surface velocity and
solid response uses closing speed relative to that surface. Ground response,
carving, braking, launch strength and grounded speed caps likewise use relative
rider velocity while preserving inherited world momentum. Walking and parked
boards follow support motion. Mounting, dismounting, walking jumps and mounted
jumps retain support velocity, with no double carry on launch.

Matrix interpolation and rotational collision chords are application
approximations, not exact quaternion interpolation or continuous rotating-shape
collision. Broadphase bounds join the two endpoint bounds. Very fast rotation,
multiple impacts within one tick and rapidly rising floors need further work;
subsequent collision passes currently reuse the full tick's object motion.
Exact arbitrary dynamic-body trajectories and full-course collision equivalence
are not claimed.

## Validation and remaining scope

All 24 portable suites pass. The typed clip/law suite has 70 synthetic checks;
with the local course sweep it passes 18,263 checks over 165 animated models in
all eleven courses. The shared-player runtime suite has 50 checks for activation,
region/end latches, delta controls, shared-model isolation, matching collision,
moving-surface impact, walking/parked-board carry, mounting, mounted launch,
relative speed caps and on-foot launch momentum.

Seven actual-player Vulkan replays render 667 frames and assert moving colored
pixels, an unchanged sibling of the same model, delta hold, default rest/latched
end poses, and entry from outside the original culling bounds. Extended GPU
checks pass 1,230 appearance/animation assertions, including interpolated poses,
queued stereo isolation and rejection of invalid motion before fence reset;
84 avatar/HUD assertions also pass. World-interaction
replays pass 772 frames including pickup pixels/chime PCM; score and recovery
regressions pass 1,311 and 641 frames. All eleven local imports retain six
supported recovery placements each (66 total). Local one-second startup renders
exercise nearby course graphs; these are startup smoke tests, not whole-course
or Quest performance measurements.

```powershell
./temp/native/Release/openslope_prop_animation_tests.exe temp/native-rails-0.17.0/Maps
./temp/native/Release/openslope_prop_runtime_tests.exe
python Native/tests/prop_animation_replay_test.py temp/native/Release/openslope_player.exe
```

Spline-path movers, thrown rigid bodies, break/rearm twins and debris, UV and
material animation, counters/flags, pads and the other unsupported graph nodes
still need consumers. The first-party application's timed pickup grow-back,
animation auto-return and general 30-second reset profile also remain separate
parity work. Retained active loops outside a deactivated region need wider
behavioral comparison. Animation sample validity and startup rendering do not
prove every authored event or every full-course trajectory.

The implementation uses clean specification bodies, first-party public behavior
examples and standard matrix/collision math. Exported course files supply only
interoperability/validation data. No differently licensed decoder or runtime
implementation supplies Native code. ARM64 app and test APKs build with valid
signatures and version 0.25.0/code 26; Android lint reports zero errors and four
existing warnings. Package assets match the 15 license/notice files exactly,
with no course, disc or audio media. Versioned artifacts and hashes are saved in
`temp/native/prop-animations-0.25.0-build.json`. The installed Quest remains on 0.22 for
the user's steering test; no worn-headset 0.25 test or new device FPS is claimed.
