# Crash and animated recovery

Clean Trailmap 300 and 340 distinguish a crash (motion 5/control 19), a
relative get-up (motion 6/control 20), and a course reset. Recovery retains
carried velocity and heading, moves near the rider's current position, and
returns control when the get-up animation emits completion. The clean bodies
do not establish the complete tumble integrator, original get-up clip, exact
relative offset or one proven hard-landing threshold.

Native now implements this lifecycle in the shared fixed-tick player. A hard
player-bounce impact retains the existing orientation-adjusted threshold from
370. Inverted/severely tilted landings, excessive downward impacts and fast
contact with surface rows 6/10 also enter crash. Entry records the carried frame
and one crash cause/counter, cancels charge/release, and preserves linear
momentum. Lean and slide continue their shared slew rather than snapping to zero.
Cruise, charge, boost and trick input stay suppressed through tumble/get-up.
Manual reset remains available. A new hard impact can interrupt the get-up.

The provisional tumble rotates the board/body frame around an impact-derived
axis, with initial angular speed `clamp(0.18 * speed, 2.4, 8)` rad/s and
exponential damping of 8/s on ground or 1.2/s in air. Ordinary surface contact
continues without cruise drive. A supported rider with normal speed <=1.5 m/s
and angular speed <=0.9 rad/s for 0.2 s enters relative recovery. These rates
and gates are application tuning, not recovered original trajectories. Hard
landing currently uses deck tilt >=90 degrees or incoming normal speed >28 m/s;
unrideable rows require tangent speed >5 m/s. Original error-field/impact
classification and intermediate landing-contact gates still need work.

Relative get-up adds 8 cm along the current normal and 30 cm behind the carried
nose. It does not warp to the spawn or clear tangent velocity, and retains
switch stance. Recover-contact uses the exceptional contact correction from
340: depth correction clamped to +/-8.33 cm and velocity projected onto the
contact plane. This projection is distinct from the retained incoming normal
velocity of an ordinary clean landing. Original offset and tumble poses remain
unresolved.

A first-party keyframed get-up track drives orientation progress, crouch and
board/body height. The default track runs through five poses over 1.2 s, ending
at the standing pose with a `get-up-finished` marker. The player consumes that
marker; it has no get-up-duration test that independently restores control.
A track which reaches its final pose without that marker remains in recover-wait
until explicitly reset. Pause/focus loss freezes simulation and cannot fabricate
completion. Imported character/skeletal animation, visible rider rendering and
original clip parity remain outstanding; the existing visible board and posed
collision volume consume the current track.

`RiderAnimations.json` optionally supplies an authored track:

```json
{
  "Schema": "openslope-rider-animation/v1",
  "GetUp": [
    {"Time": 0, "Standing": 0, "Crouch": 1, "Height": 0.3},
    {"Time": 1, "Standing": 1, "Crouch": 0, "Height": 0,
     "Event": "get-up-finished"}
  ]
}
```

The profile is bounded to 1 MiB and 2..256 ordered keys, starting at zero and
ending by 30 s. Standing/crouch are in 0..1; height is in 0..2 m. A completion
marker is legal only at the final standing pose. Smooth interpolation is an
application policy. Quest's document-folder cache preserves and validates the
profile. Default play needs no new ISO extraction or character assets.

The camera retains its carried heading through tumble/get-up. Pose-root height
affects the rendered board and collision volume, leaving the camera anchor
unchanged. Tracked VR head orientation is also left independent of the tumble.
This avoids injecting the board's animation into head tracking; comfort and
on-device behavior still need hardware verification.

The specified unresolved-crash fallbacks use 7 s overall or 3 s of unresolved
ground contact. During an active run they call the existing course-reset entry
point; outside an active run they start relative get-up. The same active-run
boundary now governs reset-surface and below-course automatic recovery, while
manual reset remains unconditional. Current desktop/Quest hosts are freeride;
the shared `run_active` hook is covered by tests but awaits Race/Showoff session
integration. Path-selected reset placement and the 0.8 s fade/hold remain work.

Twelve portable suites pass, including 713 focused animation/recovery assertions.
They cover clean/hard landings, surface gates, retained momentum/stance, near-crash
placement, completion markers, missing-marker holds, malformed clips, pause/reset,
camera separation and three/seven-second run fallbacks. Four production-host cases
render 1,200 frames: inverted landing, hard vertical impact, hard prop rebound,
and a missing-marker get-up. Each completed pose has visible board pixels. Run:

```powershell
python Native/tests/desktop_recovery_test.py temp/native/Release/openslope_player.exe
```

Existing jump, collision, audio, wake and sheet host cases and 1,112 Vulkan
appearance assertions also pass. An ordinary 120-frame GARI replay has identical
rider/contact state and final pixels in builds 0.15 and 0.16. The ARM64 main/test
APKs compile; lint, signature and media-exclusion checks pass. The full parity
matrix remains active: original
character poses/tumble, exact landing classification, race/path reset, authored
world logic, breakables and remaining presentation/audio/effects are separate work.
