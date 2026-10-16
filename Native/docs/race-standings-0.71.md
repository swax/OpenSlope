# Checkpoint standings and completion clocks

Build 0.71 changes the optional field's Race standings from continuous distance
along the course to earned checkpoint progress. A warp farther down-course
cannot give a rider checkpoint credit. A rider moved behind the field retains
the checkpoints actually crossed. Continuous course metres remain available
as separate metadata and retain the existing non-Race field ordering.

The six-frame standings pass now ranks unfinished racers by their checkpoint
count. Equal counts retain their previous relative order; a new entrant follows
existing tied riders. Stable ties are a Native policy implementing the strict
leader comparison in clean Trailmap 390, not a claim that every retail tie rule
has been measured. The local HUD, catch-up reference ladder and forward-reset
reference all consume the same standings.

A real finish ranks ahead of unfinished racers. Completion is recorded each
world frame on a shared field clock, before the next standings pass. A rider
joining an existing race cannot overtake an earlier finisher with its shorter
personal elapsed time. Continued riding or adding opponents cannot rewrite an
existing completion time; local dismount preserves opponents' result history.
The local rider still abandons their own run on dismount. Simultaneous
completion stamps retain their previous order. The individual run clocks and results remain separate;
the field clock advances in real fixed ticks, independently of AI catch-up
dilation, and survives the local player's dismount. A full restart clears the
field's result history.

The rules use the clean bodies of Trailmap `390-race-score`,
`390-finish-events` and `395-standings`. This is independently authored Native
code; no other port's runtime or differently licensed format implementation was
used as guidance.

## Verification scope

Both new regressions fail against 0.70 before the correction: a zero-checkpoint
rider physically farther down-course incorrectly leads, and a late entrant's
shorter personal clock incorrectly reverses the finish order.

The authored fixture earns checkpoints by ordinary fixed-step riding through
two race-line events. It never writes the progress counters. It then moves
riders to different stations and checks that displacement cannot manufacture
credit, ties retain the incumbent leader, a second crossing advances the local
HUD, actual finishes supersede unfinished riders, and restarting clears the
result history. A separate finish fixture covers an already completed opponent,
local dismount and a later opponent with a genuinely shorter personal clock.

The reset-bias scenarios now earn their stated placing through actual checkpoint
crossings before testing resets, rather than treating their starting positions
as placing. Leader/middle/last human and AI subjects and all 0.70 exclusions
remain required. All 57 portable Native suites pass. The expanded field suite
passes 438 authored assertions, 40,050 with the eleven desktop courses and
29,247 with the eight Quest courses. Both CPUs retain 90 recovery checks and
the separate 1,536-case / 184,320-tick corner matrix. Quest also passes 269
conformance, 24,690 AI-input, 26,609 player-safety, 736 rail, 54 moving-support
and 713 opt-in legacy-recovery checks.

Actual desktop Vulkan checks pass 266 avatar/stereo and 845 weather/UI
assertions. The frozen production executable passes 641 reset frames and
360 corner-containment frames. The first avatar test command omitted its
required capture-directory argument; its corrected invocation and the
remaining render checks pass without a runtime-source change.

Android APK/test builds pass, with zero lint errors and two existing warnings.
The installed update retains its debug signing identity and matches the frozen
APK hash. All eight maps, sampled sidecars and launcher/audio/graphics preferences
survive the upgrade and OpenXR startup. Device checks pass 121 JNI/library/SAF
and 163 launcher/font/accessibility assertions. The APK packages sixteen notice
assets and no course media. Snowdream starts OpenXR with 2520 x 2640 eye targets
at 150% and four-sample MSAA; the unworn runtime reports resumed/focused/
simulation false. That establishes startup/configuration, not riding frame rate
or comfort. Test-only ARM64 binaries are removed.

The complete required `npm run verify` gate passes in 659.1 seconds: hygiene,
all 57 Native suites, 1,002 synthetic .NET tests, type checking, lint, all 232
covered web files, production build and authored export/glTF smoke. Covered
web tests finish in 476 seconds with four jobs and one internal worker.
The first attempt completed 231/232 covered files; the access-token file hit
a loopback TCP connection timeout after its earlier assertions passed. That
entire file then passed under coverage in isolation. The existing runner's
`RUN_ALONE` scheduling now includes that socket check. Authentication runtime,
assertions and timeouts remain unchanged.

## Bounded course replays

Each mode-explicit run uses six opponents and a stationary braking local rider,
checking every rider's finite state and actual finish/lap transitions. It ends
at all six finishes or 600 simulated seconds.

| Course | Race finishes | Race seconds | Freeride finishes | Freeride seconds |
|---|---:|---:|---:|---:|
| Alaska | 5 / 6 | 600.0 | 6 / 6 | 376.4 |
| Aloha | 6 / 6 | 351.8 | 6 / 6 | 163.6 |
| Elysium | 5 / 6 | 600.0 | 6 / 6 | 376.2 |
| Gari | 5 / 6 | 600.0 | 5 / 6 | 600.0 |
| Megaplex | 5 / 6 | 600.0 | 6 / 6 | 275.5 |
| Merquer City | 6 / 6 | 323.1 | 6 / 6 | 296.4 |
| Mesa | 6 / 6 | 264.1 | 6 / 6 | 251.6 |
| Snowdream | 5 / 6 | 600.0 | 6 / 6 | 184.6 |
| Untracked | 5 / 6 | 600.0 | 4 / 6 | 600.0 |

That is 48/54 Race and 51/54 Freeride finishes. All Megaplex riders reach their
fourth lap; one Race rider remains unfinished. The nine unfinished states and
their late samples are retained. Changing the reference ladder changes Race
trajectories; a different finish count does not establish a terrain fix or
complete course equivalence. Pose-only restoration omits mutable world state,
private timers, input history and mode setup, so it cannot establish every
underlying cause. Other formations, interacting humans and worn-headset
performance remain unverified.

## Remaining parity work

This does not establish complete racing equivalence. The current bounded
replays still expose unfinished contact/route cases, and the recorded GARI
terrain junction remains open.
The shared six-frame cadence and fixed-tick completion stamps do not prove
every event-dispatch timing detail. Full AI skill/trick variation, human/shared
sessions, gameplay/audio/rendering parity and worn-headset comfort/performance
remain active work. The detailed 390 reset-bias rule remains the chosen profile;
395's differing overview and reset candidate-scoring differences remain noted.
In-world video screens remain excluded by user request.
