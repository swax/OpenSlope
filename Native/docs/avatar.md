# Stick figure avatar and controllers

Desktop and OpenXR render the existing Slopesmith stick figure, including its
colour-coded limbs, fingers, joints and front/back landmarks. The bundled GLB
is unchanged (SHA-256 `e1a06ea45c5238cb6086acae5941d44684ffb64eb8021b0cea91632cd24fa5bf`).
Its original Apache-2.0 attribution is retained in assets/NOTICE.txt and packaged
with both hosts. This is first-party avatar art; no course or retail rider art
is packaged. There is no JavaScript or framework runtime dependency.

A bounded loader accepts the bundled GLB's rigid skin profile: 49 joints,
8,744 vertices and 4,816 triangles. Independently authored posing transforms
each bone segment, preserves the coloured geometry and applies simple vertex
lighting. Desktop follows board orientation, stance, crouch, jump, rail spin and
the existing recovery pose. On foot the figure stands upright at the walker's
position, with procedural walking legs; the parked/coasting board stays separate.
Two-segment limb geometry supplies bent knees and
elbows. These are application poses, not original character/trick clips.
First-person views omit head/neck geometry so the camera cannot be enclosed by
the player's own head. F/V toggles desktop first person; hold C to look down.
`--first-person` and `--look-down` also work in captures and desktop launchers.

OpenXR reads both grip-pose actions at predicted display time. The procedural
controller models have handles, top plates, sticks, buttons and triggers, with
depth-tested text anchored above each model and facing the viewer. Touch labels
explain stick steer/tuck/brake, stick-click rail exit, X reset, trigger boost,
A hold/release jump and B dismount. On foot they show stick walk, trigger run,
A jump and B mount board. The simple-controller profile has Select jump,
left Menu reset and right Menu mount/dismount bindings and matching help.
These are original generic models, not device art.
Missing grip poses hide the affected model immediately and use a procedural arm.

Quest tracking uses the official optional extensions:

- `XR_FB_body_tracking`: upper-body joints, active state and confidence.
- `XR_META_body_tracking_full_body`: full joint set including runtime-generated legs.
- `XR_META_body_tracking_fidelity`: request high fidelity when supported and read
  the actual fidelity status. The runtime can decline that preference.

Extensions are enabled only when advertised. System properties gate tracker
creation. A failed full-body creation retries the upper-body joint set; absent
or failed optional tracking preserves the head/controller fallback. The Android
manifest declares the body-tracking permission and an optional body feature.
No hardware-support assumption is compiled into the portable core. The fidelity
revision-1 public ABI is supplied locally because the pinned OpenXR 1.1.53 headers
do not declare it; its registered structure IDs are checked against Khronos.

Every render frame starts with a fresh pose. Active body samples with confidence
above 0.05 and finite, position-valid joints within 2.5 metres of the head replace
individual fallback joints. Position-valid inferred leg joints are accepted
without requiring a tracked bit. Inactive, missing and outlier joints fall back
individually; stale joints are not held. Controller grips remain the hand anchors.
Procedural torso up remains world vertical while the user looks down. Room
movement carries fallback feet beneath the body. Body,
controllers and both eyes share one floor/reference transform and room offset.
Initial horizontal centre/heading are aligned to the board; placement changes
and timed reference-space changes recalculate that anchor. Local space uses a
1.65 metre initial eye-height fallback; stage space uses the runtime floor.

Tracking drives presentation only. It does not replace the virtual rider's
physics/collision profile or feed headset motion into trick controls. VR keeps
physical body pose and comfortable head orientation while the board animates.
Exact hand grips, finger articulation, runtime render models, avatar-driven
collision masks, calibrated proportions and original rider animations remain
future presentation work in the parity matrix.

Validation covers portable pose/skin tests, malformed/partial/lost tracking,
controller anchoring, head removal, crouch, yaw and physics independence. Actual
Vulkan tests render desktop, look-down, full-body and fallback poses, compare
visible labels, distinct stereo eyes, 1x/4x samples and UNORM/sRGB targets. Existing gameplay
and graphics regressions pass. ARM64 main/test APKs and Android lint pass.
On the connected Quest 3, build 0.19.0 has the body permission granted, creates the
full-body tracker and receives success (0) for the high-fidelity request. The
existing ISO-imported ALASKA course opens through a bounded activity smoke check.
These checks establish API initialization, not active high-fidelity status, live
joint poses, rendered stereo frames or comfort. Effective pose/fidelity logs and
a worn-headset self-view/controller check remain the next device evidence.

API authority: [Meta native body tracking](https://developers.meta.com/vr/documentation/native/android/move-body-tracking/),
[Khronos full-body joints](https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrBodyJointSetFB.html),
[Khronos fidelity request](https://registry.khronos.org/OpenXR/specs/1.1/man/html/xrRequestBodyTrackingFidelityMETA.html).
Clean Trailmap 300, 340, 350, 370 and 400 continue to establish gameplay state,
pose/camera separation and depth behavior; the user-directed avatar/tracking
presentation is explicitly an application choice.
