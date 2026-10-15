# Pads and scripted boost volumes

Build 0.30 connects speed/trick pads and all four authored force properties to
the shared desktop/OpenXR player. Clean Trailmap 150/230/350/360/390 supplies
the recovered graph, force, timing and lap behavior. Existing Maps are data
comparisons; no separately licensed implementation supplies this code.

Main 17 and 18 request speed and trick windows in seconds. Each takes the max
with its live timer, decays at 60 Hz and never writes velocity on collection.
Speed duration selects the fixed strong cap and grounded boost gate. The trick
window multiplies rail spin by 1.6 and clears on airborne separation. The
authored dead-node chain removes draw and collision together. Collected pads
stay collected across run retries; reopening/configuring the course starts a
fresh set. This differs intentionally from gem retry behavior. Ownerless graph
threads cannot grant pads. Human feedback uses MAIN 115/114; AI-owned requests
omit those chimes. Particle sparkle consumers remain outstanding.

Property 7 drives the positive deficit along its normalized world-space axis:
`velocity += axis * max(0, target - dot(velocity, axis)) * rate * dt`.
Targets remain in m/s, never scaled like positions. Host rotation does not turn
the authored force. A positive active window keeps a node armed after departure
but never pushes riders outside the geometry. Mode 1 remains alive while occupied;
mode 0 suppresses force during its cooldown and never self-retires; modes 2+
retire inertly. Explicit activation re-arms the stored duration.

Selection uses the rider's swept movement against the instance's real native
box, triangle proxy or occupancy body. Closed triangle interiors and stationary
box occupants count; transformed broadphase corners and missing occupancy cells
do not. Drawing visibility, response mass and render bounds do not substitute
for collision geometry. Runtime collision tombstones still apply. Moving
objects reuse their collision transforms and relative movement. Continuous
contacts retain one driver instead of reconstructing it each tick.

Property 18 cancels horizontal velocity, drives toward the authored altitude
and releases at or above it. Positive tolerance can place the rider at the exact
height while preserving climb velocity; zero tolerance never snaps. Placement
resets interpolation and crossing history while preserving music playback.
A completed lift waits for actual
exit before contact can reconstruct it, preventing repeated snaps during a fall.
Walking support and captured rails release when the force lifts the rider away.
Ground/rail speed remains bounded; ordinary airborne integration now bypasses
that clamp, allowing the authored vent and wind targets to work.

Property 15 classifies stage once on entry: below ten metres above the host's
floor is stage 0, and the two sides along its local X select stages 1/2. Service
uses the post-crossing remaining-pass count. Property 24 latches that stage's
axis and speed per rider and applies the ordinary directional lag. The importer
now preserves all nineteen payload words, including stage 2's final speed.
Older native Effects documents recover a missing U18 from their retained source
words in memory, without rewriting the user's map.

## Application choices and unfinished equivalence

The lap ride's original position/motion-state program is still open in the
clean spec. Native currently uses an independently authored vertical lag that
cancels horizontal motion, matching the public play tests and observed ascent
direction. The source Z placement and stage launch compose with that ascent,
but the exact original ride is not established. Tube entry and existing path/
finish stations share a counter with a three-second cross-station suppression
window. That interval is an application policy, not a recovered constant.
Freeride/single-pass courses without a lap counter allow the custom lift.
Four-pass counter tests establish three lift passes and a final ride-through;
they do not establish an entire ridden Megaplex lap trajectory.

Held air boost now follows the visible deck. Symmetric decks choose the leading
end on engage and retain it until release; the directional-gear tuning always
uses the nose. Below the cap it adds 8 m/s²; over the final 2 m/s it transitions
to a 40 degree/s speed-preserving turn. Reverse force can brake. These numbers
and the transition are a first-party play profile from public tests, not a
recovered air-thrust formula. The public profile also gives speed-pad/held boost
the same 1.6 air-rotation gain without stacking; a pad alone supplies no air
thrust. Clean 360 only establishes the trick-pad rail consumer, so this air gain
is application behavior. Held engage plays MAIN 120/121/122 once per press,
chosen from the existing meter thresholds, through the real audio mixer.

Passive airborne meter bleed, uber/infinite meter tiers, pad sparkles, remaining
score/time/teleport opcodes and full original lap transport remain parity work.
Per-character stat scaling and the retail trick repertoire are out of scope.
The full objective stays in desktop-parity.md. No new worn-headset test or VR
performance result is claimed; the installed steering build is preserved.

## Validation

Thirty portable suites pass. The boost suite has 116 authored checks; its
optional real-data run totals 297 checks across all 67 force placements and
47 pads in eleven existing imports. It compares world axes/rates/targets and
pad durations to independently exported data, including hidden triangle volumes,
the three altitude drivers and the tube launcher. Pad comparisons use their
authored Race mode; some mode functions explicitly hide them in other modes.
The complete behavior comparison passes 8,774 typed nodes, exact source words
and slot/function joins. The ISO fixture independently checks all nineteen
tube fields, and runtime tests check old-payload recovery without map writes.

Six production Vulkan cases render 47 frames and verify actual pad pixels/
disappearance, independent durations, chime/engage PCM, uncapped vent lift,
altitude placement and stage-2 launch. Existing world/material/crowd/glass/
model/spline/score/recovery replays remain green. These checks prove the stated
interactions, not full-course equivalence or all multi-rider ownership rules.

Four additional production captures enter two actual imported Megaplex vents
from above and from within their authored volume. Over 30 ticks, those entries
gain about 3.9 m and 13.46 m respectively, ending with 15.45/29.52 m/s upward
velocity. These are targeted entry checks; wider approaches, the entire finish
sequence and worn-headset behavior remain unverified.

The signed ARM64 0.30.0/code 31 app and compatible instrumentation APK build.
Android lint reports zero errors/four existing warnings. The app contains fifteen
exact license/notice assets and no bundled course media. The source-boundary
audit checks 222 files. Versioned desktop/APK artifacts and a commit/hash manifest
are saved in the ignored build tree; no new headset execution is claimed.

```powershell
./temp/native/Release/openslope_boost_tests.exe
./temp/native/Release/openslope_boost_tests.exe temp/native-rails-0.17.0/Maps Maps
python Native/tests/boost_replay_test.py temp/native/Release/openslope_player.exe
```

Build 0.32 adds the sampled geometry afterimage for held/speed-pad requests.
Its seven-record cadence and colour tiers follow clean boost-trail research;
attachment/ramp/draw choices and remaining limits are in boost-trail.md.
