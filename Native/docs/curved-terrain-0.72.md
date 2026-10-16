# Curved terrain collision and compound clearance

Build 0.72 corrects a mismatch between continuous patch support and coarse
sphere collision. In a full Snowdream Race replay, opponent actor 3 stops at
exactly the same position despite nonzero velocity. A trace through the actual
field tick shows alternating terrain contacts exhausting the movement passes;
the shared force and feedback phases preserve that result. At that location,
the sampled snow collider differs from the curved patch by about 20 cm. The
board has already moved below the actual snow, and its guard becomes trapped
between the sampled snow and a ramp. Restoring only the final pose is not the
same replay: actor identity, mode, previous inputs and shared world state matter.

Sphere queries now subdivide the patch control net where its convex bounds
overlap the swept body. The control net's distance from its bilinear net, plus
the bilinear corner twist, bounds each leaf's distance from its two collision
triangles. Ordinary cells stop within one millimetre of the continuous patch.
Subdivision has a depth limit of ten for unusually large custom control nets;
those inputs can reach that limit before meeting the tolerance. Collision is
still an approximation, rather than an exact sphere/patch intersection or a
proof against every possible tunnelling case.

A shared cache retains at most 32,768 live subdivision cells, evicting inactive
patch trees. Cell-vector capacity stays below 30 MiB on the supported targets;
that excludes other terrain data and cache bookkeeping. Terrain copies can
share the cache, with queries protected by a mutex. Cache misses compute the
same geometry. Single-sphere queries prune cells that cannot improve an initial
overlap's nearest feature or beat an existing impact time. Compound queries
retain all relevant leaf searches.

The same investigation found an initial-overlap error in sphere/triangle tests:
an overlapping vertex could win before a nearer edge at the same time of impact.
Equal-time overlap candidates now retain the deepest contact, giving the nearest
triangle feature independently of vertex order and winding.

## Compound bodies

The more accurate terrain exposed opposing initial contacts in partly embedded
bags. In the retained GARI case, 57 of 103 initial contacts face away from the
body's centre; the initial manifold cancels the incoming shove. Simply dropping
those contacts passes the old motion checks but leaves an authored stack about
20 cm inside the floor. That alternative was rejected.

Terrain contacts now retain their originating sphere index. Before solving an
initial overlap, the body adapter orients thin-terrain contacts toward the body's
centre and adjusts their signed depth using that sphere's radius. The complete
overlap is cleared, retaining the shove. This is a Native clearance policy for
thin surfaces, not a general solution for arbitrarily interlocked geometry.
Closed-prop contacts and actual swept crossings retain their existing response.

These are independently authored geometry corrections aligned with clean
Trailmap 110's continuous patch model and 320's requirement that contact follows
the actual surface. Existing contact springs, powder allowances, launch/landing
rules and the default no-knockdown profile remain in use. The experiment that
clipped travel against accumulated contact normals did not solve the original
replay and is not part of the implementation. Trick-only flag behavior remains
an open specification detail; this change does not infer a mode mask from it.

## Verification

- 1,260 authored curved-surface assertions cover bowls and ridges at three
  scales, translated and rotated frames, both sides, interior and boundary
  points, stationary clearance, overlap depth and swept impact time. The prior
  implementation fails this fixture. A separate 48-assertion edge-overlap
  matrix covers both sides, cyclic vertex orders and both windings.
- 14,112 route/cache/copy assertions cover 48 curved patches in both traversal
  directions. Another 24 competing-layer checks preserve earliest and nearest
  contacts. Source-probe metadata survives missed probes; ray hits have no
  sphere identity. Core conformance totals 15,667 checks on Windows and Quest.
- Twelve authored compound cases cover three pitches, both terrain sides and
  uniform/mixed sphere radii. Every case must retain horizontal motion and
  clear every leaf over 120 ticks. The old body solver fails this regression.
  All 658 owned/body assertions pass on both CPUs, including the unchanged
  GARI bag displacement requirement: about 7.03 m riding and 3.74 m walking.
- All 57 Native suites pass. The 1,536-case steep-corner matrix retains
  containment over 184,320 ticks on both CPUs, including 48 near-vertical trials.
  The field suite passes 40,050 desktop and 29,247 Quest checks. Quest also
  passes 24,690 AI-input, 26,609 player-safety, 736 rail, 90 course-recovery,
  54 moving-support and 713 opt-in legacy-recovery checks.
- Actual Vulkan checks pass 266 avatar/stereo and 845 weather/UI assertions.
  Frozen production-player replays pass 1,292 body-motion, 641 recovery and
  360 corner-containment frames. Recovery and corner replays retain their
  no-reset/no-knockdown requirements.

The walking body render test previously assumed visible red-pixel area must
shrink by 25% as the prop moves away. The corrected body clears the ground and
starts clipped by the bottom screen edge, then moves fully into view. Retained
captures show the body advancing about 1.99 m with the camera stationary, while
its pixel centroid moves upward by about 167 pixels. The test retains its area
requirement for unclipped captures. For clipped captures it instead requires
clearing the screen edges and moving upward by over 10% of the image height;
it also requires actual additional world displacement. An unchanged rendered
silhouette cannot satisfy this check. Body count, shared-model isolation,
camera position and sleeping-state assertions remain required.

Five batches of the same 20,480 recorded Snowdream queries measure a median
4.91 microseconds/query in the final Windows build, versus 52.15 in the prior
coarse build during this measurement. Both builds process identical inputs;
their hit counts differ because the geometry changes. Earlier cache-only
prototypes were substantially slower and were rejected. These are scoped CPU
query measurements, not a general game-frame-rate claim.

The crowded owned checks retain all 88 Merquer can/lid chains and 33 Snowdream
bags with 452 leaf spheres. Measured maximum stepping samples are 9.63/30.21 ms
on Windows and 7.09/27.75 ms on Quest. Other checks were running during these
samples; these values do not establish a 120 Hz frame budget.

Windows and Quest builds and Android lint pass. The installed debug update
retains its signing identity and matches the frozen APK hash. All eight maps,
sampled sidecars and saved launcher/audio/graphics preferences survive the
upgrade and OpenXR startup. Device instrumentation passes 121 JNI/library/SAF
and 163 launcher/accessibility checks. Snowdream starts OpenXR with 2520 x 2640
eye targets at 150% and four-sample MSAA. The unworn runtime reports
resumed/focused/simulation false: this verifies startup, not riding FPS or
comfort. Test-only ARM64 binaries are removed.

The complete required `npm run verify` gate passes in 703.2 seconds: repository
hygiene, all 57 Native suites, 1,002 synthetic .NET tests, type checking, lint,
all 232 covered web files, production build and authored export/glTF smoke.
Coverage uses four jobs and one internal worker; assertions and deadlines
retain their existing requirements.

## Bounded course replays

Each mode-explicit replay uses six opponents and a stationary braking local
rider, checking finite state and actual finish/lap transitions. It ends at all
six finishes or 600 simulated seconds.

| Course | Race finishes | Race seconds | Freeride finishes | Freeride seconds |
|---|---:|---:|---:|---:|
| Alaska | 4 / 6 | 600.0 | 5 / 6 | 600.0 |
| Aloha | 5 / 6 | 600.0 | 5 / 6 | 600.0 |
| Elysium | 5 / 6 | 600.0 | 4 / 6 | 600.0 |
| Gari | 5 / 6 | 600.0 | 6 / 6 | 219.2 |
| Megaplex | 6 / 6 | 383.2 | 5 / 6 | 600.0 |
| Merquer City | 6 / 6 | 333.3 | 5 / 6 | 600.0 |
| Mesa | 6 / 6 | 271.6 | 6 / 6 | 231.5 |
| Snowdream | 6 / 6 | 425.7 | 6 / 6 | 181.2 |
| Untracked | 6 / 6 | 285.6 | 6 / 6 | 231.2 |

That is 49/54 Race and 48/54 Freeride finishes, versus 48/54 and 51/54 in 0.71.
All Megaplex riders reach their fourth lap. All eighteen replay logs and the
eleven unfinished riders' final states and late samples are retained. Snowdream
and Untracked Race now finish all six; other courses lose finishes in this
bounded formation. Changed contact and prop trajectories affect subsequent
paths, so these results are neither complete AI parity nor evidence that every
individual stall is solved. Full-course terrain/contact/route cases remain open.

Full AI skill/trick variation, shared sessions, remaining gameplay/audio/rendering
fidelity and worn Quest comfort/performance remain part of the wider objective.
In-world video screens remain excluded by user request.
