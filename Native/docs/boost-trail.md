# Geometry boost afterimage

Build 0.32 implements the boost-board history from clean Trailmap 360 and
research/boost-trail. This is sampled geometry, independent of particle art or
an ISO. Desktop and both OpenXR eyes draw shared simulation state. No separately
licensed implementation supplies the history or draw code.

The player keeps seven records of four world-space attachment points. Fixed
simulation frame modulo three selects updates: 20 Hz under the 60 Hz loop.
Held boost or a positive speed-pad request appends a record and saturates the
ring. Release writes nothing and drains one oldest extent per update. Drawing
waits for two records and joins the live rendered deck pose to history. It is
const: repeated rendering and stereo submissions never advance the ring.
Sampling phase persists across placement; history itself clears on warp,
teleport or altitude snap, preventing a sheet across that discontinuity.

No ground/contact test gates the effect. It follows deck yaw, roll, flip and
airtime. A speed pad alone creates it; a trick pad alone does not. Application
walking/recovery/countdown/pending-reset states suppress new samples. Existing
records drain normally when boarding ownership is lost. Those extra lifecycle
gates extend the recovered mounted-rider model into the application's modes.

One RGB value applies to both sheets, using the source thresholds:

| Meter/request | RGB |
|---|---|
| At or below 0.33363 | 1, 0.9645, 0 |
| Above 0.33363, at or below 0.66648 | 1, 0.4746, 0 |
| Above 0.66648, or a speed pad | 1, 0.0758, 0.002 |

Release retains the last colour while draining. Freeride's existing unrestricted
boost profile supplies full energy and therefore held red; scored runs use the
live meter. These colour thresholds do not change cap/engage thresholds. A full
ring becomes nondrawable after six release updates (up to about 0.30 s) and
empty after the seventh (up to 0.35 s), depending on the sampling phase.

## Application drawing profile

Original attachment points and age ramp remain unresolved in the clean research.
This independent profile uses two transverse edge bands around the diagnostic
deck: 0.14..0.22 m either side, 0.8 m toward its tail and 0.015 m above its plane.
Joining the bands through history produces two sheets. RGB fades linearly from
the live pose to black at the oldest record. Those dimensions/ramp are explicit
application choices, not recovered original board geometry. Real equipment
attachment bindings remain part of the broader presentation work.

The live mesh has fixed storage for at most 84 vertices/28 triangles. Each eye
owns its mutable upload buffer. One untextured additive draw uses scene depth
without writing depth, and Native's fog/fade and sRGB profile. Blend/ramp choices
do not establish original pixel equivalence. Inputs are validated before render
fences reset; rejected submissions leave the next frame usable. No new media,
sampler, or Quest document-provider cache asset is required.

## Evidence and remaining work

All 32 portable suites pass. The 56-check trail suite covers cadence, engage,
ring overwrite, release, exact colour boundaries, pad override, live 3D pose,
immutable rendering, invalid inputs and actual airborne/warp/walking behavior.
The expanded Vulkan suite has 1,654 assertions on UNORM/sRGB at 1x/4x MSAA:
depth, additive stacking, age gradient, full fog/fade, target recreation, clearing,
invalid-input recovery and private queued-eye uploads. Avatar/controller tests
retain their existing 84 assertions.

Fifteen production player cases render 1,186 frames. They cover engage/drain,
snow/air pixels, all meter colours, pad red at low energy, trick-pad exclusion
walking suppression and run restart without a stale held request. Without particle art, held cases add 3,419 red pixels
on snow and 3,939 in air versus their corresponding idle runs. These controlled
application captures are not original-game pixel comparisons. Existing boost,
teleport, crowd, material, glass, world, score and recovery replays remain checks.

Original folded attachment vectors, exact blend/ramp, future equipment, other
particle/world effects, character-stat/uber behavior, grabs, AI and full gameplay/
rendering/HUD parity remain in desktop-parity.md. No new worn-headset or VR frame
budget result is claimed. The installed steering build and imported ALASKA stay
preserved.

```powershell
./temp/native/Release/openslope_boost_trail_tests.exe
python Native/tests/appearance_test.py temp/native/Release/openslope_render_tests.exe
python Native/tests/boost_trail_replay_test.py temp/native/Release/openslope_player.exe
```

The signed ARM64 0.32.0/code 33 app and compatible instrumentation APK build.
Lint reports zero errors/four existing warnings. The app packages fifteen exact
license/notice assets and no course media; the source-boundary audit checks
230 files. Final desktop/APK snapshots and a commit/hash manifest are saved in
the ignored build tree. Instrumentation is compiled, not newly run on the Quest.
