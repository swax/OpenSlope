# Landing frames and terrain corners

Build 0.69 addresses a shared collision defect found while tracing an opponent
at an Elysium terrain junction. The correction serves the local rider and
opponents on both desktop and Quest. Existing maps need no re-import.

A landing changes the cached support normal and lateral deck offset. The old
solver accepted that pose immediately, although the new terrain guard could
now overlap an adjacent floor. The next tick began on the wrong side of that
floor, potentially trapping the rider beneath its edge.

The movement solver now sweeps the new landing frame before accepting the
final pose. Landing is latched for the remainder of that movement, so another
collision pass does not bank the same landing again. Ordinary contact, input,
charge/release and score rules remain in their existing shared paths.

A separate cached-probe defect caused the remaining Elysium reattachment. An
airborne rider already behind a wall could discover it along the old contact
normal and snap back onto it without a new crossing. Ordinary air now lands
through the swept travel query. A moving support may still cross a stationary
rider between world ticks; its relative plane crossing is checked explicitly.
Aligned rail-to-floor handoff remains an explicit transition. The opt-in legacy
tumble/get-up path keeps its existing tangent-only contact motion. Default play
does not enable forced knockdowns.

Narrow corners also need simultaneous clearance: pushing out of one surface
can undo clearance from another. Within the existing eight-pass limit, the
guard retains its terrain contact planes and chooses the nearest point that
satisfies them. The independently authored three-dimensional projection
enumerates up to three independent active planes. Coordinates are relative to
the first guard centre to retain precision far from the course origin.

Finite-edge tangent planes can become overconservative. If they demand a
farther correction than retaining the starting centre, the solver tests that
centre against the actual terrain and uses it only if clear. This bounds the
correction by an available clear pose, without a placement/reset or an
arbitrary new movement-distance cap. Deep initial contact still uses the
existing support-side correction when the starting centre is not clear.
Remaining travel keeps its outward normal component; only motion into the
contact is clipped. A shallow guard overlap cannot cancel the surface spring's
budget pushout.

These are explicit Native collision safety policies using ordinary geometry.
Clean Trailmap 320's analytic contact normal, carve-offset probe, surface
spring and depth budget remain authoritative, along with 340's landing seed
and carried-velocity rules. Soft-snow sink is retained. No other port's runtime
implementation or separately licensed format library is used as guidance.

## Verification scope

An authored ledge fixture reproduces the old defect: a near-vertical landing
places the guard 19.5 cm inside a neighboring floor. The expanded fixture uses
four headings, three ledge gaps, snow/powder/metal and an optional third wall:
72 cases and 8,640 fixed ticks. Every tick checks clearance, finite state,
unchanged placement serial and a bounded displacement appropriate to the
authored input. The cases include actual near-vertical landings. The
original steep-corner matrix remains a separate regression requirement.

Twelve cached-wall cases cover four headings and three back-side distances,
followed by steering and boost checks. Eight sloped/flat surface cases require
outward budget recovery. A real animated platform crosses an airborne rider
and supplies its authored surface velocity. The rail tests retain their original
overhead-obstacle case and add a separate unobstructed floor handoff with a
depth-budget check. The optional legacy crash/get-up suite remains required.

The final six-opponent sweep reaches all six finishes on eight courses,
including Alaska and Elysium, and four laps on Megaplex. GARI reaches five by
the 600-second bound: one rider remains trapped at a steep terrain junction
after recovery. Restoring that recorded pose without AI steering reproduces
the contact stall. This remains an open terrain/placement case. The earlier
landing-only Elysium prototype also stalled; its passing authored corners
alone did not resolve that course case.

| Course | Finished riders | Simulated seconds |
|---|---:|---:|
| Alaska | 6 / 6 | 364.1 |
| Aloha | 6 / 6 | 167.0 |
| Elysium | 6 / 6 | 368.1 |
| Gari | 5 / 6 | 600.0, bounded run |
| Megaplex | 6 / 6, four laps | 262.2 |
| Merquer City | 6 / 6 | 296.0 |
| Mesa | 6 / 6 | 236.1 |
| Snowdream | 6 / 6 | 184.6 |
| Untracked | 6 / 6 | 212.9 |

All 57 portable Native suites pass. Both CPUs pass the new ledge checks and
the separate 1,536-case / 184,320-tick corner matrix. Desktop includes 50
near-vertical ledge cases and Quest 54; their contact invariants pass without
requiring identical trajectories. Quest passes 26,609 player-safety checks,
736 rail, 54 moving-animation/support, 713 opt-in legacy-recovery, 269
conformance and 86 course-recovery checks. Its eight-course AI-input and field
suites pass 24,690 and 29,066 assertions. The desktop eleven-course field suite
passes 39,869 assertions.

Actual desktop Vulkan checks pass 251 avatar/stereo and 845 weather/UI checks.
Production corner and score replays pass 360 and 2,293 rendered frames. The
Quest update retains its debug signing identity; 121 JNI/library/SAF and 163
launcher/font/accessibility checks pass. All eight maps, sampled sidecars and
saved preferences survive the update and OpenXR startup unchanged. The APK
contains sixteen notice assets and no private course media. Android lint
reports zero errors and two existing warnings.

Snowdream OpenXR startup succeeds at 2520 x 2640 per eye, 150% scale and
four-sample MSAA. The unworn runtime reports resumed/focused/simulation false.
This verifies startup/configuration, not interactive riding or frame rate.
The course sweep uses one formation with a stationary local player, checking
finite state and actual finish/lap transitions. Wider formations, human
interaction and worn-headset comfort/performance still need validation.

The required complete `npm run verify` gate passes in 828.6 seconds with one
web-test job: hygiene, all 57 Native suites, 1,002 synthetic .NET tests, type
checking, lint, all 232 covered web test files, production build and the
authored export/glTF smoke test. A parallel attempt reports 231/232, failing
the session-end checkpoint assertion in `sessions.test.ts`; that entire file
then passes under coverage in isolation, followed by the complete serial run.
All test assertions and the web implementation remain unchanged.

This does not establish complete contact/trajectory equivalence, all possible
course junctions or worn-headset comfort. The reset-bias discrepancy recorded
in `opponent-recovery-0.68.md`, full race/session behavior and the wider
gameplay/audio/rendering parity matrix remain active work. Default play
continues to retain control after ordinary impacts.
