# Desktop and terrain playtest follow-up

Build 0.47.1 addresses the user's MESA landing/terrain report, boost release/end,
continuous rail yaw, walking chase camera and compact desktop UI. Authority is
the user's requested behavior, sanitized Trailmap contact/charge/rail interfaces
and standard continuous collision, rigid frames and screen projection. Native
remains independent of other runtime/format implementations.

Ground integration retains the shared spring/redirect model. A small swept root
sphere prevents exceptional impulses from moving the rider deeply through the
terrain while that model settles. Its allowance includes the current shared sink
budget, preserving deep powder equilibrium instead of turning snow into a rigid
floor. Four soft-surface equilibrium checks and a production y=-0.252 case verify
that behavior. Air orientation grace no longer suppresses
terrain chord contact. A grounded walk whose destination probe misses an uphill
surface checks the crossed chord before losing support. Surface 17 remains
intentionally non-colliding and surface 0 retains course recovery behavior.

A synthetic hard-contact replay reproduces the old failure at y=-1.65357 after
two ticks on a flat y=0 surface. The guarded run ends at y=-0.0950179 with an
outward normal velocity. Owned MESA traversal checks sample 24 terrain starts and
4,320 fixed ticks without a deep terrain crossing. These cover repeated falls,
boost/carve input, jumps and recovery; they do not reproduce every possible route.

Boost input release clears held state before early returns. Rider/flight sound
queries also require an active run, so expiry/recovery cannot leave a loop latched.
The trail's history and live endpoints use the same selected thrust end as the
board force; switching ends starts a fresh history. Carried boards and foot-sole
trails keep their own attachment frames.

Desktop rail input accumulates unrestricted turns at 240 degrees/second (with
existing boost scaling); release holds the chosen orientation with zero angular
rate. Rail travel and its camera heading remain on the analytic tangent. VR's
continuous stick/gaze turn path is preserved.

Walking in third person snaps the chase view behind the moving avatar unless the
user is dragging to orbit. The walking input basis is retained during automatic
recentering, preventing held strafe from turning its own reference into a circle.
First-person and flight views retain their separate behavior.

Desktop gameplay uses narrow top/bottom bars. The menu remains a compact action
panel. Desktop UI vertices are authored directly in screen coordinates and drawn
through a dedicated opaque overlay pipeline. This removes world depth conflicts
and floating-point cancellation at distant course coordinates. Wrist geometry
retains its world frame and pointer interaction. A 96-frame Vulkan test checks
identical HUD/menu pixels across a 5 km translation and changed camera heading.

Validation passes all 46 native suites, including 368 terrain/walk, boost and
camera checks. Production regressions include 664 board audio frames (including
run-expiry/release), 773 rail frames, 96 translation/rotation-stable UI frames,
273 foot-flight frames, 170 contact/ambient/music frames, 168 equipment frames,
315 shatter frames and real menu/map switching. Both UNORM/sRGB avatar, stereo,
controller labels and late UI paths pass 204 Vulkan checks. The 24-start/4,320-tick
MESA traversal also passes with the budget-aware guard. A separate actual-course
504-frame ride performs four launches and ten landings. The previous timed-run
boost defect reproduces a tail RMS of 1200.09; the fixed run reaches exactly zero.

The 0.47.0 preview remains saved separately. The final desktop build is
`temp/native/desktop-playtest-safety-0.47.1/OpenSlopeNative.exe`, with its MESA
Freeride launcher alongside. The signed 0.47.1/code 49 Quest APK is saved at
`temp/native/OpenSlopeNative-quest-0.47.1-playtest-safety-debug.apk`.
The required full repository gate passes in 241.7 seconds; the Native boundary
audit checks 329 files with no forbidden references. The signed ARM64 app passes
100 Quest JNI/custom-library/SAF checks, with sixteen exact notice/license assets
and no private media. Lint has zero errors and four existing warnings. The
installed APK hash matches the saved artifact. ALASKA geometry, world, instances,
audio sidecars and map-selection preferences retain their hashes. An eight-second
startup initializes both 1680x1760 eyes at 4x MSAA and the runtime full-body tracker;
this establishes startup, not worn listening or sustained FPS.
Worn feel and the user's exact MESA route still need playtesting; desktop progress
continues without waiting for it.
