# Desktop landing, flip and crash-bag corrections

The user reports occasional Snowdream landings that retain air controls while
skimming the ground after the 0.73 improvement, flips centred on the board, and
a brief hold inside a struck crash bag. Build 0.74 addresses these scoped issues.
The broader feature-parity goal remains paused.

## Landing

The initial guard handoff required downward world velocity. A rider can still
approach a bank while moving upward in world space. The handoff now tests
incoming velocity relative to the contacted surface, while retaining matching
patch/front-normal and front-side checks. A departing wall cannot supply a new
touchdown merely because it remains in the cached ground probe.

The authored matrix grows from 288 to 480 cases, adding uphill approaches at
45, 65, 70 and 75 degrees, with four surfaces, three world headings and tilted
decks. Each case requires touchdown within 30 ticks and ground controls for at
least 29 of the final 30 ticks, without a reset. The 0.73 restriction fails the
new upward approach regression. Carve-only production PCM fixtures also include
upward approaches, with no glide, wind or music that could mask a missing loop.

## Flip centre

A crouch-dependent kinematic pelvis is the rotation pivot. The board translates
around that point, carrying both feet, the posed body probes and the boost
attachment with it. Collision now uses the same stance sign as rendering.
Presentation animation never drives physics; the flight camera and physical
head/controller tracking retain their independent frames. VR interpolates the
board translation with its existing orientation interpolation. Unflipped riding,
walking and held-board poses retain their normal origins.

Geometry tests cover both stances, crouch extremes, banked launch frames,
quarter/half/full rotations, binding attachment and tracked-head continuity.
Six new Vulkan views exercise quarter/half/three-quarter flips in both stances.

## Live crash-bag overlap

The normal shove applies one momentum impulse per body per tick. Its small
initial position correction and remaining rider travel could leave limbs inside
the bag's final pose. Repeating that state caused a temporary hold. Simply
increasing the first push was insufficient on compound bodies.

After a live shove, up to four positional passes query the current body pose,
using the physical limb spheres rather than the broad-phase pelvis gate.
Equal-time occupancy overlaps choose the deepest leaf. Grounded separation
follows the support plane, each correction is bounded to 0.5 m, and swept terrain
and neighboring solids constrain the correction. There are no additional
momentum impulses or graph activations in these passes. A blocked neighboring
solid can still prevent complete immediate clearance; this is not a coupled
dynamic-island solver.

An authored mounted-binding regression fails with this final clearance removed
and passes with it enabled. In the retained Snowdream bag 2631 approach, the
comparison without clearance remains embedded for 113 consecutive ticks, with
roughly 0.46 m peak overlap. The final source has no overlaps exceeding 1 cm
in any of that bag's three contacted approaches. A separate crowded bag 1850
approach still has two embedded ticks; the neighboring-solid restriction can
prevent immediate clearance. These placements establish targeted reproduction,
not complete human trajectory equivalence.

All additional rules are independently authored Native behavior alongside clean
Trailmap 320/340 contact and 370 impulse/probe contracts. No differently licensed
runtime implementation supplied the code.

## Validation status

- All 57 Native suites pass, including 28,049 player-safety checks and the
  unchanged 1,536-case / 184,320-tick corner matrix with 48 near-vertical trials.
- The authored live-body suite passes 100 checks; the extended owned-course
  run passes 685, including GARI riding/walking, 88 Merquer can/lid chains and
  all 33 Snowdream bags with 452 leaves each.
- The frozen desktop EXE passes 720 Vulkan/carve-only PCM landing frames,
  1,292 walking/riding body-motion frames and 360 steep-corner frames. Actual
  avatar GPU checks pass 281 assertions, including six new flip views, with
  the flip contact sheet visually inspected.
- Targeted Snowdream bag player ticks average 0.89–4.76 ms per approach, with
  an 11.39 ms maximum. The separate body-only field pass peaks at 15.32 ms.
  These desktop timings are not a sustained Quest frame-budget claim.
- The same 24 complete Snowdream bank placements have no persistent air locks.
- Quest debug/test APK builds and Android lint pass (zero errors, two warnings).
  Native source-boundary audit checks 436 files without forbidden references.

The complete repository gate passes (677.1 s), including 1,002 synthetic .NET
checks, all 232 covered web test files, production build and export smoke test.
The final GPU target was rebuilt after removing a duplicated test loop;
gameplay sources and packaged binaries are unchanged from the complete gate.
No new Quest installation or worn-headset validation is claimed. Existing maps
need no re-import, and opponents remain off by default. The requested desktop
playtest covers Snowdream jump landings, large curves, flips and crash bags.
