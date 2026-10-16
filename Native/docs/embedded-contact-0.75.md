# Embedded deck contact after a paused playtest

The user paused desktop Snowdream 0.74 while ordinary riding had become stuck
in the air-control state again. A read-only capture of that OpenSlope process
identified one matching Rider. Only typed rider fields were retained locally;
no process memory dump or retail media was added to the repository.

The captured rider has no jumps, three prior landings, 4.75 seconds in Air,
roughly 24 km/h speed and a partially completed flip from the unwanted air
controls. Its stale ground-error field is about -1.8 cm; a fresh analytic probe
puts the deck about 12.1 cm inside the ice-tagged curved terrain at that spot.
The user suspected deep snow, but the captured contact is surface 5. This does
not establish which earlier trajectory first lost support.

## Correction

The raised guard sphere is touching the terrain from its front side. The
handoff previously required the deck root itself to be in front too. A sunk
deck therefore could not land, while the guard kept it sliding along the sheet.
The front-side check now uses the actual swept guard centre. Matching patch,
front-facing normals, incoming surface-relative velocity and takeoff grace
still gate touchdown. A cached probe alone cannot cause a landing, and a guard
wholly behind a terrain sheet remains ineligible.

This is independently authored Native containment behavior alongside clean
Trailmap 320/340 contact and landing response. Surface coefficients, powder
equilibrium, scoring and the default no-knockdown policy retain their rules.

## Reproduction and checks

The local paired replay restores the captured position, velocity, normal,
board orientation, smoothing, slide, surface fields, air state and trick angles
in the full Snowdream scene. Preserving the board orientation after placement
is essential: ordinary placement projects the supplied up vector against the
heading, which differs from this live airborne pose. An early diagnostic omitted
that restoration and was corrected before the paired comparison.

- The original 0.74 implementation stays airborne for all 120 additional ticks,
  retaining three landings and approximately 12 cm of embedded sliding.
- The corrected runtime lands at tick two, records a fourth landing, recovers
  the remaining flip and finishes grounded after 120 ticks without a reset.
- 108 authored embedded-Air cases cover three slopes, three world headings,
  four surfaces and depths of 0.5, 5 and 12 cm. They require prompt landing and
  sustained ground controls. Separate backside cases must remain airborne.
  The old runtime fails the new regression even on flat ground at 0.5 cm depth.
- The player-safety suite passes 28,301 checks. Existing departing-wall and
  soft-snow equilibrium assertions remain unchanged. The unchanged corner
  matrix passes 1,536 cases, 184,320 contained ticks and 48 near-vertical trials.

- All 57 Native suites pass on the desktop build.
- The frozen production EXE passes 960 Vulkan/carve-only PCM frames, including
  two embedded-Air placements that use ordinary replay placement and a small
  outward initial velocity. The frozen 0.74 EXE fails the first placement with
  zero landings, 135 degrees of air spin and no ground loop after 120 ticks.
- Existing production body-motion and steep-corner checks pass 1,292 and 360
  Vulkan frames respectively.
- Quest debug/test APK builds and lint pass; the frozen ARM64 debug APK is
  version 0.75.0/code 78 with the existing debug signing certificate. Native
  source-boundary audit checks 438 files without forbidden references.

The complete repository gate passes (570.1 s), including 1,002 synthetic .NET
checks, all 232 covered web test files, production build and export smoke test.
The user reports improved desktop play in 0.75. No new Quest installation or
worn-device result is claimed. Existing courses
need no re-import. The broader feature-parity goal remains paused.

For future local reports, pausing as soon as the unwanted air controls appear,
before resetting or dismounting, preserves useful state. Course/build details
and the action immediately before it happened help; a repeatable manual route
is not required when the live state can be captured.
