# Opponent recovery and route continuity

Build 0.68 corrects reset placement and the next input frame for the optional
opponent field. Desktop and Quest share this implementation. Existing portable
maps work without re-importing; the default opponent count remains zero.

- The reset anchor is the rider's tracked path projected at its current
  position, using the forward segment cache. Being displaced beside a closer,
  differently rated route does not silently change that anchor.
- Raw event 104 on the tracked path refuses the request. An unrelated nearby
  path cannot bypass the no-reset window.
- The shared reset-window helper applies 103 backward, 105 forward and 100
  jump-window priority before checking the destination's floor and body space.
  The adjusted station determines the actual placement, not just its metadata.
- After a completed reset, input resumes the route selected for placement.
  A mood preference for another nearby line does not immediately discard it.
- A reset records the placement serial. A later independent warp chooses a
  fresh route rather than reviving historical reset metadata, even if the
  request happens before the next AI input tick.
- The raised, floor-aligned drop retains its one-metre world-up offset and
  exactly 30 km/h of horizontal velocity. A sloping path no longer adds a
  vertical component to that seed.

The rules come from sanitized clean Trailmap 250 reset events and 390 reset
placement, with 395's cached path projection/input behavior. Factoring the
window helper reuses independently authored Native code. Neither another port's
runtime implementation nor the separately licensed format library is guidance
or an implementation dependency.

The default play profile continues riding and permits reset after event finish
or expiry while preserving its result. That is an intentional application
difference from clean 390's terminal-event refusal, retained from existing
continued-play behavior and tests.

## Verification and limits

Authored shared-field fixtures exercise displaced anchors, all three reset
adjustments, no-reset refusal beside a closer line, a warp before the next
input tick, a respawn-disabled preferred route, selected-route resumption,
subsequent warp invalidation and horizontal seed velocity on a real sloped
floor. These use ordinary reset requests and fixed-step `Player`, with the
existing body-clearance and hold/fade checks retained.

The six-opponent Alaska diagnostic now reaches actual event finish for all six
riders at 370.1 simulated seconds. The previous 0.67 run reached five by its
600-second limit. This is a bounded replay of one formation, not proof of all
routes, player interaction or race fidelity. It does not add a stuck timer,
vertical-target guard or direct path-position driving.

The complete nine-course sweep reaches 53 of 54 finishes. Eight courses finish
all six opponents; Megaplex completes all four laps. Elysium reaches five by the
600-second bound. The remaining rider changes from floor support to a nearly
vertical metal surface at a terrain junction and becomes trapped. Restoring its
recorded pose without AI input reproduces the contact trap. This is an open
shared-terrain case, not evidence of complete race or collision parity.

| Course | Finished riders | Simulated seconds |
|---|---:|---:|
| Alaska | 6 / 6 | 370.1 |
| Aloha | 6 / 6 | 166.1 |
| Elysium | 5 / 6 | 600.0, bounded run |
| Gari | 6 / 6 | 226.7 |
| Megaplex | 6 / 6, four laps | 263.6 |
| Merquer City | 6 / 6 | 298.2 |
| Mesa | 6 / 6 | 221.0 |
| Snowdream | 6 / 6 | 179.2 |
| Untracked | 6 / 6 | 231.9 |

All 57 portable Native suites pass. The shared-field suite passes 39,869
assertions with the eleven local courses and 29,066 on the Quest's eight
courses. Quest additionally passes 269 conformance, 86 course-recovery,
24,690 AI-input, 672 rail and 372 player-safety checks. Both CPUs retain the
1,536-case corner matrix, including 48 actual near-vertical departures and
184,320 contained ticks. Those authored corners do not cover the new Elysium
junction; their passing result cannot close that defect.

Actual desktop Vulkan checks pass 251 avatar/stereo and 845 weather/UI checks.
The frozen production executable passes corner and scoring replays with 360
and 2,293 rendered frames. The Quest debug update keeps its signing identity;
121 JNI/library/SAF and 163 launcher/font/accessibility checks pass. All eight
maps, sampled sidecars and saved preferences survive the update and OpenXR
startup unchanged. Android lint reports zero errors and two existing warnings.
The APK retains sixteen notice assets and packages no private course media.

The complete required `npm run verify` gate passes in 510.2 seconds, including
all 57 Native suites, 1,002 synthetic .NET tests, type checking, lint, all 232
covered web test files, the production build and authored export/glTF smoke.
An initial run's access-token test hit a loopback connection timeout; that
entire file passes under coverage in isolation, then the complete gate passes
on repeat. Its assertions and the test infrastructure are unchanged.

Snowdream OpenXR startup succeeds with 2520 x 2640 eye targets at 150% and
four-sample MSAA. The unworn runtime reports resumed/focused/simulation false.
This verifies startup and configuration, not interactive riding or frame rate.

The clean reset-bias descriptions still disagree: 390 specifies 0.8 seconds of
the adjacent placed rider's speed, with finish/course/mode exclusions; 395's
summary describes mean other-rider progress. Native currently retains the
latter profile. Resolving and validating that difference remains active work;
complete-course finishes do not prove the current bias is equivalent.

First-party AI skill/trick variation, full racing/session behavior, the wider
gameplay/audio/rendering parity matrix and worn-VR comfort/performance remain
unfinished. Retail characters and the retail trick repertoire stay outside
the contribution scope; in-world video screens remain excluded by user request.
