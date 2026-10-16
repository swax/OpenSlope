# Forward reset bias

Build 0.70 changes the forward distance used by a course reset when opponents
are enabled. The old opponent path used a non-negative gap to the field's mean
course progress. A rider could therefore recover a long distance ahead simply
because the others were far away. The local human did not receive that bias.

The shared field now records 0.8 seconds of the speed of the competitor one
place behind. Last place uses the competitor immediately ahead. The local
human's normal manual reset uses the same rule; ordinary automatic opponent
requests retain their own rider as the reset subject. The bias is a distance
along the current path's horizontal arc, applied before respawn-window
adjustment and safe route selection.

There is no forward bias for solo play, Freeride, Showoff, Megaplex or a rider
less than 100 metres from the course finish. The mode comes from the local
run, so an opponent's internal race clock cannot enable race catch-up in a
Freeride or Showoff session. Megaplex is identified from the existing course
metadata; a custom course with multiple laps is not excluded by its lap count.
The normal reset hold, fade, manual meter cost and 30 km/h drop-in remain.

This implements the detailed clean Trailmap `390-reset-bias` rule. Clean 395's
reset overview still describes a different mean-progress rule; the detailed
390 rule is the chosen Native behavior, not a claim that those two source
descriptions have been reconciled by new retail measurements. No other port's
runtime or separately licensed format implementation was used as guidance.

## Verification scope

The new field integration fixture fails against the previous behavior before
the correction. It exercises real fixed-step players and accepted reset holds,
with leader, middle and last-place local/AI subjects, different course gaps,
finish exclusions, both non-race modes, Megaplex metadata, a custom four-lap
course and solo racing. The expected distance uses the named adjacent rider's
actual speed at the request. Sloping-path and reset-window tests separately
verify the horizontal distance and adjustment order. Existing ownership,
body-clearance, path-cache and route-resumption assertions remain required.

All 57 portable Native suites pass. The expanded field suite passes 324
authored checks, 39,936 with the eleven desktop courses and 29,133 with the
Quest's eight courses. Both CPUs pass 90 course-recovery checks and the
separate 1,536-case / 184,320-tick terrain-corner matrix. Quest additionally
passes 269 conformance, 24,690 AI-input, 26,609 player-safety, 736 rail,
54 moving-support and 713 opt-in legacy-recovery checks.

The actual production desktop Vulkan host passes 641 reset frames, including
accepted/refused/manual/automatic requests and completely black placement
fades, plus 360 corner-containment frames. Android debug APK/test builds pass;
lint reports zero errors and two existing warnings. The update retains the
installed debug certificate. A first package built with another local debug
key was rejected before installation; the matching-key package is frozen
separately. The final installed APK hash matches that saved package.

All eight Quest maps, sampled sidecars and launcher/audio/graphics preferences
survive the update and OpenXR startup unchanged. Device checks pass 121
JNI/library/SAF and 163 launcher/font/accessibility assertions. Snowdream starts
OpenXR with 2520 x 2640 eye targets at 150% and four-sample MSAA; the unworn
runtime reports resumed/focused/simulation false. This verifies startup and
configuration, not interactive riding or frame rate. Temporary ARM64 test
binaries are removed; the APK packages sixteen notice assets and no course media.

The complete required `npm run verify` gate passes in 637.8 seconds: hygiene,
all 57 Native suites, 1,002 synthetic .NET tests, type checking, lint, all 232
covered web files, production build and authored export/glTF smoke. Covered
web tests finish in 460 seconds with four jobs and one internal worker.

The first covered web stage exceeded its unchanged fifteen-minute limit with
one test job; the expired runner tree was stopped. A two-job retry completed
231/232 files, failing only the rebuild benchmark's overhead/base ratio
(9.102 ms without the pick tree, 19.318 ms with it). The existing test runner
now includes that benchmark in its `RUN_ALONE` group. The complete passing
run measures 3.571 ms without the tree and 5.841 ms with it, an overhead of
2.270 ms below the base cost. Assertions, measurement batches and timeout
remain unchanged; no editor runtime code was changed.

## Bounded course replays

The diagnostic now records the primary run mode explicitly. Earlier sweeps
used a Freeride primary and opponents with internal race clocks; those are not
evidence for an actual Race-mode setup. This build runs both setups, with six
opponents and a stationary braking local rider, checking finite states and
actual finish/lap transitions. Each run ends at all six finishes or 600
simulated seconds.

| Course | Race finishes | Race seconds | Freeride finishes | Freeride seconds |
|---|---:|---:|---:|---:|
| Alaska | 6 / 6 | 406.8 | 6 / 6 | 376.4 |
| Aloha | 5 / 6 | 600.0 | 6 / 6 | 163.6 |
| Elysium | 5 / 6 | 600.0 | 6 / 6 | 376.2 |
| Gari | 6 / 6 | 213.1 | 5 / 6 | 600.0 |
| Megaplex | 5 / 6 | 600.0 | 6 / 6 | 275.5 |
| Merquer City | 6 / 6 | 294.1 | 6 / 6 | 296.4 |
| Mesa | 5 / 6 | 600.0 | 6 / 6 | 251.6 |
| Snowdream | 6 / 6 | 191.2 | 6 / 6 | 184.6 |
| Untracked | 6 / 6 | 222.1 | 4 / 6 | 600.0 |

That is 50/54 Race and 51/54 Freeride finishes. All Megaplex riders reach their
fourth lap; one Race rider remains unfinished. The seven unfinished states
and their late replay samples are saved. A pose-only replay omits mutable
world state, private timers, mode setup and input history, so it cannot by
itself establish every underlying defect. These are open cases, not passing
complete-course equivalence or a reason to add a no-progress warp. Other
formations, interacting humans and worn-headset performance remain unverified.

## Remaining parity work

GARI's recorded three-surface terrain trap remains open. The 0.69 entry replay
shows ordinary travel into the junction around 64 seconds, long after the last
reset near the course start; changing reset bias alone cannot establish a fix
for that contact defect. No stuck timer or direct AI position driving is added.

The field still orders unfinished riders using continuous course progress.
Clean 390 describes discrete checkpoint progress as the standings key, so the
standings authority and its tie behavior remain work even though the bias now
uses the adjacent entry in the existing shared standings. Candidate scoring,
full racing/session behavior, skill/trick variation, broader gameplay/audio/
rendering parity and worn-headset performance also remain open. In-world video
screens remain excluded by user request.
