# Material playback

Build 0.28 consumes installed UV-scroll (subtype 10) and texture-flip (11)
properties in the shared world runner. Clean Trailmap 150/170/230/410 and
first-party public behavior tests supply the laws. Geometry, collision and
shared material records stay immutable. Combined properties 19/259 and the
special crowd-grid controller remain separate consumers.

## Timing and state

The clocks accumulate fixed 60 Hz steps, independently of render rate. UV rates
are coordinate units per tick; flip speed is frames per second. A frame list
alone never starts a clock. Rendering now rests on its first image, including
when the authored base texture differs or is null. Empty lists retain the base.
The original TexturePath data is not rewritten.

Scroll mode 0 is linear; 1 applies the triangular envelope, rising to half the
rate then falling to zero; 2 is constant-speed ping-pong. Modes 1/2 reverse at
active boundaries, with stopped pause time between legs. Other mode numbers use
linear motion. Native U/V offsets wrap at one repeat. Zero-rate scroll nodes
remain phase receivers, including the actual deferred strike-sign continuation.
A zero-duration linear interval with zero rates remains a stationary receiver;
no automatic motion is invented. Positive lifetime ends the node.

Flip playback preserves fractional phase, advancing once when a tick reaches
the phase threshold. Each material wraps or clamps against its own frame count.
Reverse, random start and random-every-advance are supported. Dwell ignores
random-start/direction, uses the authored first hold, flashes for six ticks,
then rerolls its next hold multiplier uniformly in [0.25,1). The native PRNG
stream is an application choice, not original random-sequence equivalence.
A positive Length is a finite node: its graph starts it and teardown removes
the private override. Length zero persists until the slot lifecycle ends it.

The receiver accepts scroll rate/duration/U/V phase controls 1..6 and flip
rate/select/advance/enable controls 1..4. Main types 3/9 operate on the installed
receiver; a pulse's frame select is visible in the same tick as its constructor.
The authored commands (scroll 6, flip 2) have real-data coverage. Complete
original-state equivalence for unauthored controls remains unproven.
Node pause holds its clock and appearance; replacement, region teardown and
run restart clear private state. Existing populated end/region latches keep
their authority. Mode hides and plain/flagged tombstones retain their gates.

## Rendering and compatibility

The per-instance state holds native UV offsets plus optional per-material frame
choices. Existing fragile groups retain their private crack-frame priority.
Draw grouping includes frame selection and uses that frame's alpha classification.
UV phase lives in each eye's placement buffer, whose std430 stride is now 192
bytes. Model motion and detached route copies preserve it. Shader sampling keeps
native U and negates native V to match the existing OBJ-to-image conversion;
texture wrapping and filtering remain active. No texture or descriptor is
rewritten while another eye owns an in-flight submission. Malformed instance,
material, frame and phase inputs are rejected before renderer fence reset.

New and saved imports use the frame-list/sidecar contract from deferred-world.md.
No ISO re-import is required. No extra binary reader or differently licensed
runtime implementation supplies the clocks, lifecycle or shader changes.

## Scope still outstanding

Special crowd-grid playback and its shared frame art/activity/audio, combined
scroll/flip and animation/flip properties, billboard/material variants, exact
original PRNG streams and full-course/lifecycle equivalence remain parity work.
The cell activation fallback and fast-rotation/rising-floor/trajectory limits
recorded elsewhere still apply. This does not establish headset comfort or a
new VR frame-rate measurement. Quest stays on 0.22 for the user's steering test.

## Validation

All 27 portable suites pass, including 115 fixed-clock, receiver, per-material,
pulse/dwell and lifecycle checks. The real-map property suite still passes 70
checks: 93 recovered frame lists across eleven imports, twenty glass receivers,
real pane shatter/fall-through and the ten-can strike-sign continuation. That
continuation now writes V phase 0.5 without an unsupported receiver; knock-off
can bodies and full mission presentation remain separate work.

The GPU suite passes 1,500 channel/state checks on UNORM/sRGB and 1x/4x MSAA.
They cover frame-zero rest when the base differs, positive native V direction,
U/V wrapping, independent per-material selections, private siblings, retained
UV through model poses, queued-eye isolation and rejected-input recovery.
Avatar/HUD checks still pass 84 assertions. Eleven production material replays
render 221 frames for ambient cycles, same-tick pulse selection, exact rest
restoration, six-tick dwell flash, phase-only nodes and scrolling pixels.

Existing fragile/world/animation/spline/boarding/score/recovery Vulkan replays
pass with the new material/pose layout. Sixty rendered frames from each of eleven
native imports pass upload/playback (660 total); these short start trajectories
do not establish every interaction or whole-course performance.

The signed ARM64 app builds as 0.28.0/code 29; its signed instrumentation APK
also builds. Lint reports zero errors and
four existing warnings. The 15 package notice/license assets match their sources
exactly; no retail course/disc/audio/mesh data is bundled. The source audit checks
211 files. Immutable desktop/APK builds and a commit-pinned hash manifest are
saved under the ignored build tree. No new device execution or FPS claim is made.

```powershell
./temp/native/Release/openslope_texture_playback_tests.exe
python Native/tests/texture_playback_replay_test.py temp/native/Release/openslope_player.exe
```
