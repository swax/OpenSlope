# Walking and boarding

The Quest/OpenXR player starts on foot beside a parked snowboard. Right B mounts
it within 1.6 metres; B while riding steps off. Reset returns to the on-foot start.
The physical headset's horizontal room offset contributes to mounting distance.
Left stick walks relative to the current head direction, right trigger runs and
right A jumps. Riding retains the existing carve, boost and charged-jump controls.
The labelled controller models change their help with the current mode.

Desktop keeps its riding start. G mounts/dismounts; `--on-foot` starts beside the
board. A/D and W/S walk, Shift runs and Space jumps while on foot. F/V selects
first person and C looks down. The stick figure stands upright, with procedural
walking legs when runtime body joints are unavailable. The board remains visible
at its own location when the player walks away. Optional tracked legs continue
to drive VR presentation without changing collision or movement physics.

## Independent application behavior

Clean Trailmap 300 defines the recovered riding states, while 340, 350 and 370
retain riding jump, rail and contact authority. Walking and stepping off are
application features outside that recovered state machine. `Motion::OnFoot`
and `Control::OnFoot` use value 100 rather than reinterpreting its original IDs.
Slopesmith's public walking/coasting tests establish comparison behavior; the
native movement, separation and collision routines are independently authored
using standard vector projection, interpolation and sphere casts.

Movement runs at the shared fixed 60 Hz: 2.5 m/s walking, 4.5 m/s running,
18 m/s² ground acceleration, 4.5 m/s jump impulse and 9.8 m/s² foot gravity.
These values, the 1.6 metre mount range and a walkable normal-Y threshold of 0.55
are application tuning, not recovered retail constants. Diagonal input is
normalized. Jump and mount are press edges retained through presentation frames
without a simulation tick. Holding either cannot repeatedly jump or toggle.

Ground queries accept solid prop roofs even when their board surface is -1;
trigger volumes do not block or hide the floor. Four separate vertically stacked
sphere casts slide the walker against solid props, including head clearance.
This generic walking volume is distinct from the riding probe/mask profile.
Head direction controls walking intent while virtual camera yaw stays separate,
preventing repeated head turns from feeding back into camera heading.

Stepping off splits player and board positions and carries momentum into both.
An airborne dismount stays airborne and does not snap the camera to the floor.
The board falls at 18 m/s², retains horizontal momentum with light air drag and
loses ground speed at 3.5 m/s² until parked. A stationary board stays parked.
This is provisional coasting: it does not yet accelerate down a slope or implement
the full riding response on its own. Mounting transfers the board's position,
heading, orientation, stance and velocity back into riding. Recovering riders
cannot toggle. Invalid or far-below-course positions use the existing safety
reset; normal play does not automatically recall a distant board.

Remaining parity work includes crouching, flight, board recall/grab/carry, footstep
audio and world-event dispatch while walking, wider terrain wall/ceiling handling,
full loose-board response, and headset checks of control feel and comfort.

## Validation

The portable boarding suite covers standing, an idle board over 1,800 ticks,
short/held mount presses, reset, physical proximity, walking, jump edges, airborne
separation/coasting, 60/72/90/120/144 Hz presentation and solid/trigger/roof contact.
The production Windows replay renders 224 frames across spawn, held mount, walking,
distant-mount rejection and airborne dismount, checking separated positions and
visible avatar pixels. The avatar Vulkan suite also checks the on-foot help labels.

```powershell
python Native/tests/desktop_boarding_test.py temp/native/Release/openslope_player.exe
./temp/native/Release/openslope_player.exe --map Maps/ALASKA --on-foot --first-person
```

The 0.19.0 APK was installed as an update on the connected Quest 3, preserving its
ISO-imported ALASKA library. Device JNI/custom-library/SAF validation passes 52
checks. A bounded launch uses the existing course through the application UID:

```text
adb shell am instrument -w -e vr true -e course ALASKA -e seconds 18 org.openslope.nativeplayer.test/org.openslope.nativeplayer.NativeImportInstrumentation
```

The helper uses an explicitly authored temporary floor if the requested local
course is absent. It checks activity lifetime and reports which source it used;
activity launch alone does not establish live stereo frames, button interaction,
body joint motion or VR comfort. Those remain worn-headset checks. The optional
body tracker and high-fidelity request are accepted on this Quest; see avatar.md.
