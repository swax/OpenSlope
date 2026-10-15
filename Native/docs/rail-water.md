# Rail response and flowing water

Build 0.41 addresses the desktop playtest's slow rail rotation and reversed Aloha
water. Clean Trailmap 350 retains rail travel, snap, speed, collision and selector
authority. Slopesmith's public docs/016-ride.md specifies a separate desktop
presentation response: approach the quantized held direction's Ã‚Â±80 degree pose
at 240 degrees/s. Native now reaches that pose in one third of a second, reverses
immediately at the same visual rate, and returns to travel alignment on release.
The slow 75 degrees/sÃ‚Â² selector rate remains separate. The visual change does not
steer the rail tangent, alter velocity or rotate the desktop chase camera.

VR retains its free deck pose and manual view carry. Public ride-contract tests
specify the shared air rate for rail input: 270 degrees/s, with the 1.6 trick
boost multiplier on manual input. Head follow uses the unboosted rate, stops at
its gaze target and never carries the headset seat. Stick ownership still wins
over conflicting gaze. The desktop boardslide response is application
presentation, and these VR controls are application choices; neither claims an
exact original trick-animation or scoring port.

Texture clocks and native UV phases keep the clean 170/410 behavior. The error
was in applying a V sign chosen for an image-flipping upload after Native had
already converted OBJ V in its vertex stream. With `imageV = 1 - objV`, the
correct sample is `1 - objV + nativePhaseV`. Both native offsets therefore add
at the Vulkan placement boundary. Static UVs, images and saved maps are unchanged.
No ISO re-import is needed. This fixes all V-driven consumers together, including
river/waterslide, caustic and scanline material families; U-driven motion keeps
its existing sign. A new public Slopesmith browser test independently checks the
same sampled PNG coordinate through Three's texture API at Ã‚Â±0.25 phase.

Validation includes all 40 native suites, 608 rail assertions and 26,743 VR input
assertions. Nine actual-player rail cases render 773 frames, covering prompt
input, reversal, release, curves, boost, jump, exit and the rail end. Texture
graphs render another 273 frames: signed V clocks agree exactly with their
phase-controlled images, and sibling placements retain their own coordinates.
The Vulkan appearance suite passes 13,908 channel checks across UNORM/sRGB and
1x/4x MSAA, including signed quarter-cycle V samples, pose composition and
queued-eye isolation.

Private Aloha comparison covers all 20 RiverCsection placements and 158 UV-bearing
triangles. Their authored positive V rate, mesh UV gradients and identity
placements yield downward feature motion on 157 triangles with the corrected
sign; one small local triangle rises with the surface. The previous sign reverses
all these directions. Actual-player before/after captures render 62 course frames
at the same one- and thirty-tick placements; rider positions and velocities match
exactly. The thirty-tick view changes 192,471 pixels. This is a geometry/data check,
not a claim that every water or animated wave matches the original presentation.
Course data and captures remain ignored and excluded from application packages.

The full repository gate passes. The signed ARM64 app builds as 0.41.0/code 42,
alongside its instrumentation APK. Lint has zero errors and four existing warnings.
All 15 notice assets match their sources. Quest installation is verified against
the saved APK's hash, 91 device
JNI/custom-library/SAF checks pass, and an eight-second Alaska launch creates both
1680x1760 eyes with 4x MSAA and the runtime full-body tracker. The headset is asleep;
this is startup/resource evidence. The user's Alaska map and library preferences
retain their pre-update hashes. Worn confirmation of rail turn feel and water
appearance remains separate from these checks. Complete trick windows,
animation selection, rail audio and wider world presentation still
belong to the active parity goal.

Build 0.47.1 supersedes the earlier desktop pose cap at the user's request: held
steering now accumulates continuous turns at 240 degrees/second, with release
holding the chosen angle. The original selector's cap is not a desktop turn
limit. Analytic tangent travel and the VR path remain separate. See
[playtest-safety.md](playtest-safety.md) for the regression checks.
