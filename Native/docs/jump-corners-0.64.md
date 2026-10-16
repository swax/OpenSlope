# Steep jump-corner containment

Build 0.64 addresses the desktop Snowdream report of falling through terrain
beside a right-angle jump. An independently authored four-patch scene reproduces
a floor-to-near-vertical-wall transition: the previous build ends below the
floor without a course reset or knockdown. The user's exact course coordinate
has not been located, so this establishes a reproduced failure class rather
than verification of that particular jump.

The rider's root guard follows the support normal and snow allowance. Previously
both ends of its sweep used the new support offset. A sudden support-frame
change could place the starting sphere beneath the adjacent floor; the
two-sided contact then pushed it farther down. The sweep now starts at the old
guard centre and ends at the new centre. Contact is mapped back to the rider
using the final offset. Unchanged support frames retain the previous arithmetic.

This is an independently authored continuous-collision integration fix using
standard geometry. It preserves clean Trailmap 300/340/370 contact, spring and
surface rules, powder allowances, rail handling and the default no-knockdown
play profile. It adds no world-height clamp or automatic reset. No other port's
runtime implementation was consulted or incorporated.

## Verification

- The old desktop Vulkan host and old Quest ARM64 core both reproduce the
  failure. The new build retains containment for the same approach.
- All 55 portable suites pass, including 1,488 authored steep-corner approaches
  over 178,560 ticks. These cover wall slopes, approach speed/distance, run-up,
  steering, rotated world frames, powder surfaces and jumping. Of those trials,
  158 actually acquire near-vertical support. The suite forbids hidden resets
  and respects each surface's permitted snow depth. The same matrix and all
  368 existing safety assertions pass on Quest ARM64.
- Actual Snowdream and Mesa traversal each cover 24 starts and 4,320 ticks on
  desktop and Quest. These are sampled approaches, not exhaustive course proof.
- Three production Vulkan corner replays cover 360 rendered frames. The seven
  scoring replays still pass 2,293 frames; 118 scoring checks also pass on Quest.
- The full repository gate passes in 326.5 seconds. Android builds and lint
  pass, with zero lint errors and three existing warnings.
- Both APK signatures verify. The ARM64 package contains all sixteen notices
  and no private course media. The installed APK hash matches the frozen build;
  all eight imported courses, tested sidecars and saved preferences survive the
  upgrade. Device JNI/library/SAF checks pass 115 assertions and launcher/font
  scaling/accessibility checks pass 157. The source-boundary audit and repository
  hygiene checks pass. No worn-VR performance claim is made for this build.

Frozen desktop and APK artifacts use the `jump-corner-0.64.0` label. Their build
manifest records hashes, the commit and final device/package checks. Revisit the
reported Snowdream jump during desktop testing. Ground-flare fidelity remains
a separate matched-view investigation, and the wider parity goal remains active.
