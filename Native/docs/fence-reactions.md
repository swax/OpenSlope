# Collision fence reactions

Build 0.58 installs the imported subtype-12 fence property instead of leaving
it unsupported. The shared runtime drives desktop and Quest rendering. Mounted
and walking players reach the same accepted-contact graph path.

## Authority and profile

Clean Trailmap 230 defines the record: an unsigned word and float flex amount,
with a collision-triggered damped spring that settles and self-removes. Clean
150 governs graph ownership, pause, node-end and region-deactivate latches;
clean 370 retains authored contact eligibility and response. The public
Slopesmith reference-effects and sheet-prop documentation describes a damped
whole-target rattle, with vertex-weighted fence bending still outstanding.
Neither another runtime implementation nor a separately licensed decoder is
used as Native guidance.

The recovered material does not establish the spring constants, flex units,
unknown word's role or vertex weights. Native therefore uses an explicit
first-party presentation profile: horizontal hit direction, 4.5 Hz oscillation,
exponential decay at 5 per second, 0.2 metres of envelope per flex unit, a signed
25 cm envelope bound, and exact rest after 1.6 seconds. The common authored
0.5 flex gives a 10 cm initial envelope. These values are application tuning,
not a claim of recovered original constants or identical Slopesmith timing.
The unknown unsigned word remains intact in the imported contract.

There is no displacement at construction, and render interpolation blends the
previous and current fixed-tick transforms. Every object in the affected model
gets the same world displacement, transformed back through its placement;
rotation and nonuniform scale cannot redirect the hit or amplify its envelope.
Shared-model siblings remain at rest. Zero flex or no horizontal hit is inert.

## Collision and lifecycle

The reaction is visual, like the existing procedural flag wave. A marked
`PropMotion` follows the normal render/culling path while collision queries
retain the authored shape and zero cosmetic surface velocity. Replacing a
physical motion with a visual reaction restores the collision shape to rest.
The marker defaults off, preserving moving platforms, bodies and animation.
Normal motion-binding validation still applies to marked submissions.

Construction preserves visibility/collision flags. It creates no rigid body,
collision impulse, teleport or rider-control state. Further contacts while the
reaction is live do not restart its clock or re-run its graph. Once it retires,
a new hit can trigger a new reaction. Authored contact audio remains on its
existing routes.

Pause/stop freezes the current pose. A normal completion removes the private
motion and restores exact resting geometry. A populated node-end chain runs
once and can retain a settled node or replace/destroy it. Region exit tears
down an unlatched reaction; a populated region-exit column suppresses that
teardown. Hide, replacement and course restart use ordinary property cleanup.
An inactive clock cannot leave a stale interpolation or collider override.

## Validation and remaining work

The authored tests cover analytic decay and reversal, time partitioning,
settling, bounds, missing impacts, real riding/walking contacts, shared geometry,
rotated/scaled placements, collision isolation, pause, restart and lifecycle
latches. Production Vulkan tests exercise visible motion, an unchanged sibling,
fixed-tick interpolation and exact restored pixels on UNORM/sRGB at one/four
samples. Owned-course tests discover the graph/slot joins in GARI, MEGAPLE,
MERQUER and SNOW and exercise their collidable fence placements.

This is whole-target preview behavior. Recovered vertex-weighted deformation,
dynamic fence normals, exact spring/timing matching and worn Quest appearance
remain unverified, alongside the rest of the full play-parity objective.

## Recorded milestone evidence

All 50 portable Native suites pass. The optional owned-course fence run passes
16,119 checks over 1,788 unique placements (GARI 359, MEGAPLE 172, MERQUER 680,
SNOW 577), with 5,337 accepted reactions and 27 mode exclusions across freeride,
race and showoff. Every accepted reaction settles; fence construction adds no
unsupported operations.
The ten Snowdream showoff-only panels and seven excluded in showoff are covered
by their actual mode flags. The existing 489 owned collision-bag and can/lid
checks pass, including all 88 Merquer can pairs.

The production renderer passes 14,582 texture/lightmap assertions, including
the new fence motion/sibling/interpolation/resting-pixel cases on both colour
formats and sample counts. Dedicated suites retain 207 avatar/controller/wrist
checks and 585 celestial/depth/HUD/stereo checks. The complete repository gate
passes in 283.4 seconds, including hygiene, the full Slopesmith tier, coverage
and the generated-map smoke flow. The Native source audit checks 375 files
without forbidden references.

The same 56 authored fence checks also pass as a standalone ARM64 executable
linked against the APK's actual native core and run on the connected Quest.
The signed 0.58.0/code 61 APK is installed, preserving the checked sidecars of
all eight courses plus saved launcher/audio preferences. It passes 115
JNI/library/SAF and 157 launcher/version/accessibility checks. A twelve-second
Merquer startup initializes both eyes at 2520x2640 with four samples and the
runtime full-body tracker. The session is idle/unfocused, so no worn appearance
or sustained frame-rate claim follows from it.

Android lint reports zero errors/three existing warnings; both APK signatures
verify and sixteen exact packaged notices match their sources, with no private
course media. Frozen artifacts are `temp/native/desktop-fences-0.58.0` and
`temp/native/OpenSlopeNative-quest-0.58.0-fences-debug.apk`. The adjacent
`fence-reactions-0.58.0-build.json` pins the commit, hashes and validation logs.
