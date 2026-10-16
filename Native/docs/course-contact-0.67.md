# Course contact and opponent continuity

Build 0.67 addresses stalls found by running six opponents through complete
locally imported race courses. The same terrain and prop paths serve the local
rider on desktop and Quest; these are shared physics corrections.

- Analytic terrain rays accept only roots that satisfy both the bicubic patch
  and the finite ray. A coarse triangle supplies an unbounded-line seed, never
  a fallback contact. Short rays can reach the real curve without reaching its
  chord, and a chord crossing alone cannot repeatedly land a rider.
- Ground-support rays skip reverse-facing terrain crossings while continuing
  through the same segment to find support. At a sloped floor beside a wall,
  the previous two-sided probe could choose the wall's reverse side, leave
  ground, and immediately land at the original floor point every tick. General
  ray queries and the swept containment guard remain two-sided.
- The contact probe, swept landing and containment guard use the same lateral
  deck offset during a carve. Landing seats that deck reference on the hit.
  A root above a narrow ledge cannot repeatedly re-land there while its actual
  deck is already beyond the edge. This also applies to rideable prop tops.
- The airborne root guard follows the upright deck frame rather than a stale
  wall-probe normal. Grounded guards retain the contact normal and surface snow
  allowance. Both endpoints still use their own support frame, preserving the
  steep-corner containment correction from 0.64.
- A deeply seated grounded guard exits through its known support side. A
  reverse-facing triangle normal is corrected only when an analytic ray finds
  that same patch aligned with the cached support. The guard cannot push the
  rider farther beneath a floor while the spring is trying to recover.
- A rider on a rail keeps the dedicated tangent-motion state when a terrain
  floor crosses the rail. Airborne landing queries do not overwrite rail
  motion with grounded contact while leaving rail controls active.
- Re-selecting the current AI path preserves its forward segment cache. Facing
  away from a valid pursuit target does not trigger an extra route change;
  clean Trailmap 395's grounded five-metre off-path threshold still applies.
- Actual prop shoves and rider separation feed the scored-run wedge recovery
  described in `course-recovery.md`. Passive triggers, terrain support,
  walking and freeride do not arm it. This is contact-driven recovery, with no
  no-progress timer or direct path-position driving.
- Forward-biased AI recovery considers body clearance as well as floor
  support. Among the six nearest respawn-enabled routes it rejects positions
  that intersect responsive props in the raised spawn or seated pose. Normal
  route following is unchanged; no map re-import is required.

The ray solver uses ordinary analytic geometry. Support-facing and body-space
checks are explicit native application safety policies. The wedge decay and
threshold are independently chosen application values, recorded separately
from the clean recovered behavior. The implementation uses sanitized Trailmap
110/300/320/340/350/370/395, shared Contracts, public behavior documentation and
independently inspected owned map output. No other port's runtime source was
consulted or incorporated. Private map data and diagnostic traces remain local.

## Verification scope

Authored fixtures cover short curved rays, chord-only misses, curved boundaries,
upright flight after a wall probe, a sloped floor overlapping a reverse-facing
wall, rail/floor crossings, forward-cache retention, contact-driven recovery
gates and a blocked AI reset point with a clear alternative. The terrain-junction,
airborne-guard, rail and reset-clearance cases fail before their corresponding
corrections. Ordinary soft-snow contact and the steep-corner matrix remain
required regression checks.

The portable gate retains all 57 suites. Quest ARM64 passes 269 conformance,
86 recovery, 672 rail and 372 player-safety checks; its AI-input and shared-field
runs pass 24,690 and 29,030 assertions over the eight installed courses. Desktop
and Quest both pass the expanded 1,536-case corner matrix: all 1,488 original
approaches remain, plus 48 staged near-vertical departures that must actually
return to floor support. That covers 184,320 contained ticks on each CPU.
The stronger guard prevents the former approach cases from acquiring wall
support, so explicit departures preserve coverage of the support-frame change.

Actual desktop Vulkan checks pass 251 avatar/stereo and 845 weather/UI checks.
Production corner and scoring replays pass 360 and 2,293 rendered frames.
The debug APK updates in place with the same signing certificate; 121 device
JNI/library/SAF checks and 163 launcher/accessibility checks pass. All eight
imported courses, sampled sidecars and saved preferences survive unchanged.

Six-rider desktop runs reach actual event finish on eight of nine complete race
courses. Megaplex completes all four laps. Alaska reaches five finishes by the
600-second limit; one remaining rider circles near the finish with stable
terrain contact. This is an open pursuit/route-following case, not full racing
parity. The other completion times below are simulated event seconds, not
rendered frame-rate or device-performance measurements.

That Alaska target remains roughly 5--13 m above the rider; its projected
forward component repeatedly turns negative. This matches clean
395-board-plane's described limit circle below an authored flight line. The
earlier jump/path-entry failure still needs investigation. The specified
board-plane controller is retained; a vertical re-selection trigger or
time-based stuck reset would conceal that earlier failure.
An additional diagnostic records a trail-fallback recovery after the nearby
takeoff marker, followed by zero launches. Tracing that entry and the missing
jump is the next AI task.

| Course | Finished riders | Simulated seconds |
|---|---:|---:|
| Alaska | 5 / 6 | 600.0, bounded run |
| Aloha | 6 / 6 | 163.6 |
| Elysium | 6 / 6 | 366.0 |
| Gari | 6 / 6 | 223.5 |
| Megaplex | 6 / 6, four laps | 255.3 |
| Merquer City | 6 / 6 | 307.9 |
| Mesa | 6 / 6 | 200.0 |
| Snowdream | 6 / 6 | 185.5 |
| Untracked | 6 / 6 | 230.8 |

Android lint reports zero errors and two existing warnings. Snowdream OpenXR
startup succeeds with 2520 x 2640 eye targets at 150% and four-sample MSAA, and
requests the available full-body tracker/high fidelity. The unworn runtime
reports resumed/focused/simulation false. This proves startup and resource
configuration, not interactive riding or frame-rate performance. The map and
preference snapshot also remains unchanged after startup.

The required full repository run passes hygiene, all 57 Native suites, all
1,002 synthetic .NET tests, type checking and lint. Its covered Slopesmith
suite reports 231/232 passing: `hateoas-api.test.ts` hits a loopback
`connect ETIMEDOUT` while making a second document PUT. That entire file then
passes under coverage in isolation with all assertions unchanged. The
production build and authored export/glTF smoke stages also pass separately.
The original wrapper exits with that transport failure; this is component
validation with a recorded isolated retry, not a claim of one green wrapper run.

Full-course diagnostics use six ordinary `AiInput` sources, the shared world
and fixed-step `Player`, with a stationary local player. They check finite
state and actual course-run finish/lap transitions. They do not establish every
starting formation, route, rider count, human interaction, worn-VR comfort or
device performance. First-party AI skill/trick variation, shared human sessions
and the wider gameplay/audio/rendering parity matrix remain active work.
