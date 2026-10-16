# On-foot movement and stock equipment

Build 0.36 extends the shared Player rather than replacing board physics. These
are first-party Slopesmith play controls, not recovered retail rider states.
Clean Trailmap 300/340 still governs the board's control separation and airborne
ride response. The application walker retains gravity and solid geometry; it is
separate from the research-only noclip feature.

## Controls and movement

Desktop Space jumps; release and press again before landing to enter persistent
directional flight. Jump plus Boost is the alternate entry, including adding
Boost during an ordinary jump. Quest uses A and B for the same actions. A ledge
fall alone does not arm the second jump. WASD/left stick supplies flat-view
directional thrust, held Jump rises, and desktop Ctrl descends. Landing ends
flight. Releasing controls preserves a ballistic trajectory with gravity.

Shift/B restores full acceleration and caps. An explicit look/controller aim
overrides the directional thrust while boosted. Aimed boost also works on an
inherited airborne arc without first entering the persistent flight state. Held
equipment uses its nose and can thrust directly off the floor. Reversing against
current velocity increases thrust up to the authored braking limit.

The public on-foot profile supplies forward speed 8.13 m/s, lateral/backward
speed 4.065 m/s, 55% crouch movement, jump 4.77 m/s, gravity 9.81 m/s², thrust
30 m/s², a 4/s throttle ramp, and 300 m/s horizontal/vertical full caps. Cruise
flight uses half acceleration and caps. Persistent flight has 0.3/s horizontal
resistance. A carried board-speed arc retains its horizontal momentum unless
steered or boosted; an ordinary hop retains the separate walking air response.
These values were read through the public first-party walker API. Portable tests
compare measured acceleration, climb, slow-arc and braking traces without
reading or copying its runtime implementation.

As of build 0.76, desktop E spawns and mounts at the player's current feet,
including mid-air, or steps off while riding. It preserves full velocity and
does not teleport to a parked board. Holding E toggles once. Left-drag looks
around while riding and turns the on-foot character; A/D strafe without turning.
RMB carries/throws; G retains the nearby legacy board shortcut.
The executable defaults to third person, as do the 0.36 test launchers. Escape
first releases captured mouse look, then opens the menu. The smaller desktop
menu leaves more of the course visible.

## Collision, body, sound and effects

The walker sweeps its actual diagonal feet trajectory before a short ground
probe, so a fast descent meets the crossed slope rather than its buried far
endpoint. Cached terrain triangles now participate in the body sphere sweeps,
alongside existing solid prop shapes. Side hits consume inward speed; rising
flight can no longer cross a terrain cliff. The crouched body is 35 cm lower,
and standing waits for ceiling clearance instead of moving the feet underground.
This is still the independent application controller, not a universal capsule or
rigid-body solver. Arbitrary concave corners and all private courses need wider
trajectory comparison.

Flying legs use the neutral stance instead of a walking cycle. Physical Quest
body/head/controller tracking keeps its existing per-joint fallback. Broader
first-party body/head animation remains an explicit playtest follow-up.

Actual applied off-board boost opens a rider-owned MAIN/120 loop. Selecting full
caps without directional thrust is silent, and release closes that voice. No
board meter is spent. Two sole streaks reuse the bounded seven-record boost
history; held gear retains its own attachment. Attachment changes reset history
so a board-to-feet transition cannot draw a cross-map streak. Audio requires the
map's configured bank; no course media is included in the application.

## First-party snowboard art

The diagnostic quad is replaced by Slopesmith's stock 444-triangle, 1.86 m
snowboard, including sidecut, flat base, raised tips and its default colours.
Native embeds a saved GLB; it has no build/runtime dependency on the authoring
application. The optional `Native/tools/export-snowboard.ts` bakes that art through
the public gear API and applies a half turn about Y for Native's model-space
nose. Run it from the repository root with Slopesmith's local `tsx` runner.

Targeting/carry use the same conservative public grab box: half-width 0.2086 m,
half-length 0.93 m, centre/half-height 0.072 m, with Native's 0.02 m render offset.
Highlights and boost tail attachments follow the new dimensions. The GLB is
first-party Apache-2.0 art with attribution in assets/NOTICE.txt. Custom painted
equipment, alternate gear and full geometry-driven board dynamics remain work.

## Verification

`native_foot_motion` checks public numeric traces, both flight entries, ledge
gating, free aimed boost, caps, landing/focus behavior, full/crouch walk speeds,
solid terrain walls, diagonal steep-slope touchdown, low ceilings, menu size,
click/held-E actions, switch-relative flips and the baked stock mesh.
`Native/tests/foot_motion_replay_test.py` exercises the production desktop Vulkan
and PCM paths with authored geometry and tone assets. Existing carry/throw,
boarding, prop, recovery, rail, appearance and menu tests remain regression
requirements. Worn-headset reach/feel is still a distinct validation step.

Local validation passes all 36 portable suites and 57 targeted locomotion,
collision, control, layout and stock-geometry checks. Production Vulkan/PCM
coverage totals 2,839 gameplay frames, alongside 157 avatar/UI checks and 13,740
texture/lightmap channel checks. The full repository gate passes; final compact
UI changes additionally rerun both native build trees and real 16:9 menu text
spacing/presentation checks. The signed ARM64 Quest APK is 0.36.0/code 37, embeds
the exact stock GLB, and passes Android lint with zero errors/four existing
warnings. All 15 notice/license assets match; no course media ships. The GLB
also regenerates byte-for-byte. This milestone does not install to a headset.
