# Shared opponent field

Build 0.66 adds an opt-in field of zero to sixteen opponents to desktop and
Quest. Open **Opponents** in the desktop or wrist menu and use **More / Fewer**;
zero is the default. Desktop also accepts `--ai-riders 6`. The thin HUD and the
closed wrist panel show the local place. Opponents keep riding after dismount,
restart with the event, and use the existing stick figure and snowboard. Maps
without usable AI routes remain playable solo and explain why the field cannot
be enabled. The count survives desktop map changes when the destination has
routes; it is a session choice, not a saved graphics preference.

## Implementation and alignment

`AiInput` supplies ordinary `RideInput` to the same `Player` as the human. This
continues the clean Trailmap 395 foundation described in `ai-input.md`. Terrain,
prop collision, rails, world graphs and moving bodies belong to one shared
scene. Motion, scoring/run state, contacts, recovery and input clocks are private
to each rider. World timers, movers, particles and rigid props advance once per
real tick; crowd and region activation observe the entire field and local view.

Catch-up uses zero, one or two existing fixed physics steps for each opponent;
the run clock remains in real time. All riders participate in one force roster,
including zero-step actors, preserving lift occupancy and private lap entries.
An extra AI step advances that rider's force integration without advancing world
time or the human again. A finished lift blocks re-entry only for that rider;
later arrivals can use it while the previous rider remains inside.

Actor IDs survive waits, graph/function calls and command dispatch. An AI's
button boosts that AI while the button's world changes are shared. Reset and
teleport also address only the triggering actor; teleport staging uses its
six-slot creation index. Human pad/gem cues and scoring commands stay local,
while spatial course sounds reach the local audio observer. Removed IDs are
retired so delayed work cannot command replacement riders.

Standings update every six real ticks by course DTF/lap progress and finish
time. Each opponent paces the competitor immediately ahead; the leader paces the
runner-up. Body overlaps separate through existing world sweeps at clean 395's
0.55 weight, with no artificial lanes or forced knockdown. Recovery biases
forward toward the other riders' mean progress and chooses a respawnable AI
line, retaining terrain safety checks and the existing recovery fallback. No
stuck timer or path-position driving is added.

Build 0.67 adds contact-driven wedge recovery and body-space checks for the
raised and seated recovery poses, so forward bias can choose a clear nearby
route instead of repeatedly placing inside a prop. It also preserves the AI's
forward cache when its current route wins re-selection. Shared analytic terrain,
support-frame and rail/floor corrections are recorded in `course-contact-0.67.md`.

Figures use the shared avatar pose and mesh, without controllers or labels.
The renderer submits extra board transforms against one uploaded snowboard.
Both eyes use the same figures/effect snapshot. Nearby riding feedback is merged
under fixed budgets, prioritizing the local player; world particles are emitted
once. Figure distance is capped at 400 m and opponent feedback at 100 m. With
zero opponents the original simulation path and effect submissions remain.

This is independently authored from sanitized clean Trailmap, shared Contracts,
public Slopesmith behavior documentation/tests and independently inspected map
data. No other port's runtime implementation is used.

## Verification status

The synthetic field suite currently passes 219 checks for actual menu-ray
selection, countdown, dismount/restart/retirement, fixed-step invariance,
standings, body separation, delayed command ownership, spatial sound delivery,
safe forward recovery, teleport destinations, independent lift laps and owned
boost-render snapshots that remain valid after a source reset. The
boost suite passes 137 checks, including seventeen riders, zero/extra steps,
global cooldowns and staggered lift arrivals. World graphs retain 78 checks.

Six opponents traverse ten seconds on every one of the eleven owned desktop
courses, 6,600 shared ticks / 39,600 opponent state samples checked for finiteness.
Every opponent advances over 20 m; the slowest course's minimum is 56.3 m
(Megaplex). These are sampled opening sections, not complete-course/lap proof.
The actual Vulkan avatar suite passes 251 checks, including sixteen full figures
and shared boards in both UNORM/sRGB eye views at 150% and four-sample MSAA.
An actual Snowdream production capture also shows the moving field and place;
the frozen executable additionally simulates and renders sixteen opponents.
The complete desktop field run passes 39,831 assertions. Quest ARM64 passes
29,028 field assertions over its eight installed courses, plus 24,688 AI-input,
137 boost, 78 world-graph and 251 actual Vulkan avatar/field checks. The steep
corner matrix still contains all 178,560 ticks on Quest. The weather/UI GPU
suite retains 845 desktop checks, including supersampling and queued stereo.

All 57 portable Native suites pass. The APK builds and signatures verify, with
sixteen notice assets, ARM64 libraries and no private course media. Android lint
reports zero errors and three existing warnings. Installed JNI/library/SAF
checks pass 115 assertions; launcher/font-scaling/accessibility passes 157. All
eight imported courses, sampled sidecars and saved preferences survive upgrade.
OpenXR startup also succeeds on Snowdream with 2520 x 2640 eye targets at
150% and four-sample MSAA. The runtime reports resumed/focused/simulation false
because the headset is unworn; this checks startup, not interactive VR riding.
The frozen 0.65 and new solo Snowdream capture match byte for byte after eight
seconds, including trajectory/world readouts. The 1,186-frame production boost
replay also passes after the snapshot lifetime correction.
The complete repository gate passes in 539.8 seconds, including all 227
Slopesmith checks under coverage, its production build and export smoke test.
Earlier attempts exposed timing-sensitive rebuild/session checks; a serial run
with restricted CPU affinity exceeded the gate's fifteen-minute budget and
Chrome's context-recovery deadline. The test runner now accepts
`SLOPESMITH_TEST_JOBS`, with CLI precedence and a minimum of one job. The passing
run uses two test jobs and two rebuild workers with normal CPU access. All
assertions, coverage checks and discovery remain in the gate.

No worn-VR frame-rate claim is made. Optional large fields need device profiling;
the default remains zero. Per-character statistics, full authored air-trick
selection, shared human sessions and the wider gameplay/audio/rendering matrix
remain active work. This milestone does not claim complete parity.
