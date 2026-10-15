# Wind vents and shaft entry, build 0.54.1

This follow-up addresses two reproduced Tokyo Megaplex entry failures. Wind
targets, approach rates, durations, tube stages and lap gates still use clean
Trailmap 360. Prop admission and slide/bounce semantics use clean 370. The code
is independent; no other runtime or separately licensed decoder implementation
was read or reused.

## Contact and rims

Application trigger queries use a three-centimetre skin and include the body's
full query extent. Exact public collision queries retain their zero-margin
default. Responsive props keep their original shapes, contact times and physical
response. Force occupancy and reset rearming use matching reach; physical room
offsets also reach the force service while walking.

A grounded board can step onto a low admitted rideable surface of the same prop.
The top must be upward-facing, within 0.65 m vertically and at most 0.65 m ahead.
Destination and crossing probes reject blocked clearance. Nonrideable props,
tall walls and ceilings remain obstacles. The reproduced fan rim previously
gave a nearly horizontal side normal before the rider reached its wind field.
With the step, that approach climbs onto the ramp and launches without a rebound.

## Shaft transport

The lap-shaft entry has an explicit first-party transport profile. It captures
horizontal position at the host box centre once, after deciding the allowed
lap and entry stage. The final pass retains its ordinary ride-through without
capture. Clean 360 establishes that the original node writes position and reads
this box midpoint; its complete position routine is still untraced. This profile
does not claim to reproduce that unknown implementation.

While an allowed vertical lap/elevator force remains active, application motion
advances the ascent without ordinary terrain/prop response cancelling it.
Nonresponsive triggers continue to dispatch, allowing the upper Z transport and
exit boost to run. The force service's occupied-volume/altitude lifetime clears
transport automatically; ordinary controls and collision resume. On-foot entry
uses the same transport without mounting a board. Pause consumes no simulation
time, and placement/restart clears stale transport state. Held jump edges are
discarded during the scripted ride; held boost becomes available again on exit.

## Verification

The portable suites cover the unchanged exact boundary, trigger-only tolerance,
solid obstacles, low rideable steps, one-time capture and final-pass bypass.
Owned regressions cover all 67 placed drivers and 47 pads, plus a real fan
approach, complete mounted lap-shaft ascent and the same shaft on foot. The
shaft cases reach the authored upper transport; mounted cases also verify that
ordinary boost works after release. Direct probes show the formerly blocked fan
approach rising about 69 m, and the lap shaft completing roughly 490 m of travel
including the authored upper snap. These are simulation measurements, not a
claim that every approach to the furniture should pass through a solid side.

All 48 Native suites pass. The current owned runs pass 317 boost checks and 320
start/recovery checks, including 66 supported placements across eleven courses.
The production glass replay still passes 3,972 Vulkan/PCM frames. A separate
150-frame production replay reaches the upper shaft outlet without bounces or
recovery fade. The final freeriding HUD capture shows a full boost bar.

The repository gate passes. After the final HUD-only correction, the desktop
48-suite gate and both APKs were rebuilt and Android lint passed. The signed
ARM64-only package contains all sixteen notices and no course media. Build
0.54.1/code 57 is installed on Quest: 115 JNI/library checks and 154 launcher
checks pass, with the checked imported files and preferences unchanged. A
portable boost executable linked to the APK core also passes 124 checks on the
Quest CPU. Worn presentation and sustained frame rate remain human test items.

Saved builds: `temp/native/desktop-playtest-0.54.1` and
`temp/native/OpenSlopeNative-quest-0.54.1-playtest-debug.apk`. Ignored build
metadata and device records retain hashes and the validation logs.
