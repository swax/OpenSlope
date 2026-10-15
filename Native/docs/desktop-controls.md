# Desktop controls and authored starts

This milestone adds the next gameplay slice to the portable player: start-grid
placement, charged jumps, airborne spins/flips, switch stance, progressive landing
speed bands, braking, tuck pose state and pause/focus handling. The broader
[desktop parity matrix](desktop-parity.md) remains the completion checklist.

## Input and state

Desktop input follows Slopesmith's control vocabulary: A/D or horizontal arrows
carve on the ground and spin in the air; W/S or vertical arrows tuck/brake on the
ground and flip in the air; Space holds a jump charge; Shift boosts; R resets;
F/V changes camera; C looks down; E spawns a board ahead; LMB/G mounts/dismounts;
P/Escape opens the pause menu. Build 0.36 adds double-jump flight and Ctrl crouch;
see foot-flight.md for the current on-foot profile and equipment.
The title reports speed, charge, ground/air/switch or on-foot state and visible
prop/draw counts. The stick figure depicts stance and crouch. Mouse look,
gamepad and the complete HUD remain outstanding. See boarding.md for walking,
running, foot jumps and the optional desktop on-foot start.

Motion and jump control are separate (`300-two-machines`, `300-decoupled`). Only
charge entry needs ground. Once committed, charge and release survive a crest;
release counts down at 13.33/s and launches when it reaches zero. Full charge
takes five 60 Hz release ticks (about 83 ms, the discrete form of the ~75 ms
continuous countdown). Input edges survive presentation frames with no physics
tick. Charge entry samples the last validated motion state before the current probe,
so a press on the final grounded frame is retained through crest discovery.
Focus loss/pause cancel uncommitted charge without synthesizing a launch;
a committed countdown freezes with the rest of simulation. Reset is edge-triggered.

The charge-up rate of 2.5/s, high jump-stat default, 18 m/s² brake and 720 deg/s
unfinished-flip recovery are desktop application choices. They match the current
Slopesmith play profile's intended controls, rather than claiming recovered retail
constants where Trailmap is open. `PlayTuning` carries these choices separately
from the unchanged shared ride contract. Tuck drives both the pose field and
the visible stick figure's crouch; build 0.36 replaces the diagnostic board with stock first-party art.

## Motion and presentation

Lean now uses the shared speed-scaled target and powder slew in chapter 330.
Cruise fades from full authority at 30 degrees to zero at 60 degrees of skid;
square tail-first travel is folded into that band so switch riding can continue.
Held ground boost thrust respects the narrow lean window. Meter/tier gating
remains a later milestone: boost is still binary in this slice.

The launch evaluates chapter 340's squared-charge/statistic/speed curve in raw
centimetres, converts once to metres, and **adds** its impulse to carried velocity.
Flat/gentle ground uses the normalized normal-plus-0.2-tangent fallback. Steep
geometry uses the specified blend; its additional proportional carry uses an
application multiplier of one because the clean prose does not fix that coefficient.
Air keeps two-stage gravity, horizontal damping and the raised cap.

Air steering spins the physical nose; pitch is a separate rendered flip, using
the same 270 deg/s desktop rate and preserving contact bookkeeping. This is
Slopesmith's presentation model, not full equivalence to the original game's
single quaternion apply about a stick-selected axis. Held air boost applies the
desktop x1.6 trick-rate multiplier and an 8 m/s² heading thrust. Mouse/view aim
and the full momentum-preserving cap bend remain outstanding.

The board draws bank and flip from its presentation frame. The camera uses the
travel-facing frame on ground and the takeoff heading in air, so a flip/half-spin
does not rotate the camera around the rider. OpenXR uses the same separation;
right A is mapped to jump, left-stick Y to posture, B to boost, and either trigger
to mount/dismount. X recalls equipment on foot and resets the course while mounted.
Quest starts on foot. Automated
device launch does not verify physical controller presses or comfort.

Falling motion sweeps the previous/new position against terrain, catching a
surface crossed within one tick. Touchdown seats at the hit, applies independent
tilt/yaw speed bands, seeds response error at zero and keeps incoming normal
velocity. The next ground response absorbs that impact; it is not projected flat
at discovery. Ground redirect runs before separation and launch, with a 0.3 m/s
tangential floor to avoid turning a stationary absorber oscillation into travel.
The source-constant and application-guard distinction is intentional. Hard-impact
wipeout, animated relative get-up and shared prop contacts are implemented in
later milestones; see crash-recovery.md and world-contacts.md. Complete original
landing gates and walls/undersides remain.
Exact whole-trajectory equivalence to Slopesmith has not been established.

## Paths and spawn

The independent AIP/SOP reader follows clean chapter 250: section offsets relative
to the end of the 16-byte header, distinct AI/race headers, six validated start
indices, packed displacement vectors expanded by W and preserved event records.
The portable JSON uses the existing `StartPosList`, `AIPaths`, `RaceLines`,
`PathPos`, `PathPoints`, `PathEvents`, rating/respawn and DTF fields.

Runtime reconstructs N+1 vertices, beginning at the seed and accumulating every
step in `(x,z,-y)/100`. The middle grid slot supplies a reproducible start; heading
uses a 15 metre 3D baseline to span staging jogs. Unlike Slopesmith's current
whole-segment baseline, native interpolates at the exact requested distance.
Fallbacks are the named staging anchor, four metres along the first race line,
then the original highest-rideable terrain policy. The desktop drop-in starts
one metre above the selected surface at zero velocity. AIP is the default dataset;
SOP is used if AIP is absent. Full race/showoff mode selection is still pending.

Every JSON is bounded to 64 MiB, with path/index/vector/count checks. Android's
document cache now includes optional AIP/SOP metadata. Existing native imports
without path output still play; re-import into a fresh Maps root adds paths.
The importer does not overwrite existing course folders or synthesize empty path
files where the source has none.

GARI contains three AI events whose end station precedes the start. Native keeps
those exact stations rather than sorting or discarding them. Future event dispatch
must define the correct consumption behavior; this milestone only preserves them.
Race events, DTF and respawn flags are carried for subsequent race/reset/AI work.
Rail splines are separate PBD data, now imported and playable; see rails.md.

## Verification and replay

Portable tests exercise charge/release timing, a crest skip, mid-air rejection,
sub-tick input edges, focus clearing, brake/tuck behavior, flips/spins, switch
landings, swept floor contact, retained impact velocity and path seeds/start indices.
Authored path-container fixtures cover byte offsets, both datasets, displacement
expansion, reversed event stations and failed-import cleanup. No retail fixture
is required or packaged.

`tools/native-compare-paths.py` compares generated files only. Seeds, start indices,
attributes, DTF and event stations must recover identical float32 values. Expanded
displacements permit 0.01 raw cm (0.1 mm), reflecting independent double products
versus a reference's rounded float products. GARI's 151 paths, 4,277 displacement
steps and 542 events pass, with maximum displacement delta 0.000710 raw cm.
All eleven local course comparisons pass at that declared tolerance; the largest
observed displacement delta is 0.001155 raw cm (0.01155 mm).

The production Windows host also accepts bounded `openslope-replay/v1` input
sequences with fixed tick counts and optional world-metre placement. `--replay`
requires `--capture`; it renders every sample through the actual Vulkan pipeline,
reports end state and average render timing, and saves the final PPM. Example:

```powershell
python Native/tests/desktop_replay_test.py temp/native/Release/openslope_player.exe
./temp/native/Release/openslope_player.exe --map <authored-floor-folder> --capture temp/native/jump.ppm --replay Native/tests/replay-ollie.json
```

The authored floor test runs 269 rendered frames: full charge, delayed launch,
half-spin, switch touchdown and continued riding. It checks the end-state counters
and rendered board pixels. The existing 162 Vulkan appearance assertions also
run against UNORM/sRGB attachments. Timing during these checks is diagnostic,
not an isolated performance baseline or evidence of headset performance.

Rail controls: A/D slews deck spin, Shift adds tangent boost, Space retains the
shared charged jump, and Q exits carrying velocity. VR uses left-stick steering,
B boost, A jump and left-stick click exit. See rails.md.

The stick figure follows crouch and board presentation. F/V selects first person;
hold C to look down at the body and board. `--first-person` / `--look-down` also
work for offline captures. VR shows grip-tracked controller models with labels;
see avatar.md for optional body tracking and fallback behavior.

`--mode race` / `--mode showoff` selects a timed event; the default is Freeride.
Mounting starts the countdown, the title displays the clock/checkpoints/lap,
and T restarts the event. Quest's library has the same mode selector; its
left-controller clock panel labels Y controls. See course-runs.md.
