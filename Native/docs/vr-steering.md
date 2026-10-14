# Quest riding steering

Before opening a course, choose **Riding steering** in the Quest library:

- **Stick only** is the default. Head movement looks around independently.
- **Head + stick override** uses gaze while the left stick is centred. A
  deflected stick owns steering until it returns to centre.

On Windows OpenXR, add `--xr --head-steering`; the Linux OpenXR host accepts
`--head-steering`. Linux/device validation remains outstanding.

Both modes retain head-relative on-foot walking. Riding stick X has a 0.18
physical dead zone. Ground carve uses squared normalized throw; air spin uses
linear normalized throw. Incidental stick Y retains the existing dominant-axis
gate so horizontal steering does not also add an accidental flip.

On snow, project gaze and travel onto the contact plane. The first 5 degrees is
neutral; another 30 degrees reaches full steering. This drives the ordinary
fixed-tick lean/force/heading code, without a second gaze-based board yaw. Travel
is the reference, with the ridden forward axis as the near-stationary fallback.
This gives equivalent head/stick inputs the same speed and curve, including
banked surfaces and switch stance. Looking vertically supplies no yaw.

In air, head mode aims the deck toward the horizontal look bearing at the
normal air turn rate and stops inside the dead zone. A deflected stick owns
the spin. On rails, VR head mode aims the deck at up to 90 degrees/s and manual
spin uses the same rate. VR has a free rail pose; desktop retains the existing
recovered ±80-degree pose and its state/force authority.

Head-derived turns never rotate the upright headset seat. Manual steering
carries 25% of the already-clamped ground heading change and full air/rail
turn into it. Rendered head, hands/body and eyes share that upright transform.
An anchor records heading, physical headset yaw and the current carry; course
placement or reference-space changes establish a new anchor. This avoids the
gaze/camera feedback loop caused by carrying the view with a head-driven carve.

These are first-party VR application controls, aligned with Slopesmith's public
head-steer/XR tests and documented controls. Clean Trailmap 300/330/340/350/400
continues to govern rider forces, motion/control, contact and scene depth; the
original game has no headset control specification. No decoder implementation
is involved.

26,732 portable checks compare head and stick trajectories over three surfaces,
both stances, two slopes and three steering amounts, including reversal/release.
They also verify fixed-gaze arrival/relaxation, drift/dead zones, manual ownership, view carry, air aim/stop and
rail aim/spin. The ARM64 APK builds and installs as 0.22.0. Worn-headset feel,
tracking loss/recenter and new-mode frame/comfort behavior still need user testing;
the previous 0.21.0 72 Hz measurements are not evidence for those new controls.
