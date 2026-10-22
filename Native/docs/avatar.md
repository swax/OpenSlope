# Avatars and controllers

PC and Quest bundle every Slopesmith built-in: Blocky Rider, Kestrel, Robin,
Raven, Alpine Exo, Servo Scout and Stick Figure. Native's build reads Slopesmith's
catalogue and original GLBs directly. Their Apache-2.0 attribution accompanies
both packages. No course or retail rider art is packaged.

Choose **Avatar** in the desktop pause menu or Quest wrist menu. Quest also has
an **Avatar** selector under the launcher's **Ride settings**. Selection changes
the visible body immediately and is saved between courses and app restarts.
Windows defaults to a random non-diagnostic rider until a choice is saved; Quest
defaults to Stick Figure. An unavailable saved model falls back to the platform
default with a message; a failed new selection leaves the current body in place.
These are local device preferences, independent of Slopesmith account settings.

For your own avatars, use the same embedded GLB and
[bone contract as Slopesmith](../../Slopesmith/docs/030-character-models.md).
On PC, put top-level `.glb` files in the `characters` folder beside
`avatar-preferences.json` (normally `%LOCALAPPDATA%/OpenSlope/characters`).
Restart the player to refresh the list. On Quest, choose **Ride settings > Add
custom avatar (.glb)** and pick a file. The app validates it before adding it to
its private library. Imported files appear in both launcher and wrist selectors.
The picker pages through the complete library, including the built-ins.

The bounded native loader supports matrix and TRS node transforms, arbitrary
node order, multiple skinned primitives, inverse bind matrices, and up to four
normalized influences. PNG/JPEG base-colour and emissive textures are decoded
locally and packed into a GPU atlas with 512-pixel tiles for each image. Normal
maps, metallic/roughness maps, transparent materials, animation clips and
scrolling emissive masks are not evaluated by Native. Files are limited to
32 MiB, 128 joints and 30,000 triangles. External image/buffer files are not
loaded. Malformed models report a loading error without interrupting the ride.

Desktop poses follow board orientation, stance, crouch, jump, rail spin and
recovery. Quest keeps its existing head, controller and optional body tracking.
On foot, procedural walking legs follow the player independently of the board.
Retargeting rotates the imported skeleton while preserving its parent offsets
and bone lengths. The GLB body frame retains its handedness, so mixed-weight
coat panels and rigid Blocky Rider parts keep their authored proportions.
Tracked arms solve from the imported shoulder and limb lengths; untracked
wrists retain their authored angle and boots retain their sole orientation.
First-person views hide head/neck-weighted triangles while retaining the full
shadow body. Avatar selection does not alter collision or gameplay proportions.
F/V toggles desktop first person; hold C to look down. There is no JavaScript
runtime dependency.

## Course lighting

Desktop and OpenXR bodies, including AI riders, receive course lighting in the
ordinary rendering mode. A shared spatial index blends the four nearest authored
instance lighting records in full 3D at the avatar's hips. Each record contributes
ambient colour and up to three directional keys; placement rotation converts the
model-local keys to world space before the animated skin normals evaluate them.
Colours retain the prop path's display-domain modulation and 256 normalization.
Self-lit signs/bulbs and missing lighting payloads do not seed the field; genuinely
dark records do. Maps without usable records retain the previous simple fill/key.

This is a probe interpolation approximation, comparable to Unity's avatar probe
path. Trailmap specifies the lighting records and their use for nearby dynamic
objects, but does not establish the original rider's exact probe selection.
The static terrain/prop lighting is unchanged, and this does not add new realtime
shadow rays. Controllers, labels and equipment outlines keep their existing
presentation. [Trailmap: 160-instance, 160-instance-frame, 400-lighting]

OpenXR reads both grip-pose actions at predicted display time. Build 0.53 embeds
the first-party 652-triangle Quest Touch Plus model baked through the public
Slopesmith art API, with independent Native input/posing and retained attribution.
The controllers have handles, top plates, sticks, buttons and triggers, with
depth-tested text anchored above each model and facing the viewer. Touch labels
explain stick steer/tuck/brake, stick-click rail exit, mounted X reset/on-foot X recall,
A hold/release jump, B boost and either trigger mount/dismount. Right stick turns the
view; its click toggles first/third person. Y shows/hides control/clock/score panels.
On foot they show stick walk, B run and A jump. The simple-controller profile has Select jump,
left Menu reset and right Menu mount/dismount bindings and matching help.
The Touch Plus art is the project's own rebuild; no Meta reference mesh ships.
Simple controllers retain a generic fallback. Capacitive thumb/index touch and
analog trigger/grip values bend the existing finger chains; see
`quest-playtest-0.53.md`.
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
individual fallback joints, except the head, whose HMD pose has priority.
In standing mode, position-valid inferred leg joints are accepted
without requiring a tracked bit. Inactive, missing and outlier joints fall back
individually; stale joints are not held. Controller grips remain the hand anchors.
Procedural torso up remains world vertical while the user looks down. Room
movement carries fallback feet beneath the body. Body,
controllers and both eyes share one floor/reference transform and room offset.
Initial horizontal centre/heading are aligned to the board; placement changes
and timed reference-space changes recalculate that anchor.

Both stage and local spaces calibrate the current headset sample to a 1.65 metre
standing eye height, raising or lowering the view as needed. This matches the
[WebXR height policy](../../Slopesmith/docs/016-ride.md).
Manual X reset (including its on-foot board-recall action),
run restart, wrist **Recenter View** and system reference-space recentering
resample this height. Mounting, dismounting, teleports and automatic recovery
preserve the vertical offset. Physical leaning and crouching remain relative to
the most recent calibration. Cameras, controller grips/aim rays, body joints and
held-board sampling share the correction; calibration cannot add throw velocity.

Calibration selects seated mode below 1.4 metres above the physical stage floor,
or when only local space is available and physical posture is unknown. Seated
mode ignores runtime pelvis and leg joints, including generated legs, and uses
procedural legs with feet at the virtual player/board. Upper-body tracking and
controller hands remain active. Standing mode establishes its floor from the
first valid neutral ankle pair after height calibration, so even a shifted
runtime floor cannot leave feet floating. It corrects ankles/toes back to the
virtual floor, blending the correction through the knees. If that ankle pair
reveals a shifted floor, posture uses the calibrated eye-to-floor distance.
The hips remain aligned with the torso. The selected mode stays fixed
until another calibration, so standing crouches retain tracked pelvis/knee motion
and lower the view. Reset/recenter in the intended neutral posture; the mode
threshold is an application heuristic rather than a measurement of stature.

Tracking drives presentation only. It does not replace the virtual rider's
physics/collision profile or feed headset motion into trick controls. VR keeps
physical body pose and comfortable head orientation while the board animates.
Exact hand grips, finger articulation, runtime render models, avatar-driven
collision masks, calibrated proportions and first-party rider animations remain
future presentation work in the parity matrix. Retail rider animations are out
of scope.

Validation covers portable pose/skin tests, malformed/partial/lost tracking,
controller anchoring, head removal, crouch, yaw and physics independence.
Authored-shape regressions compare Blocky Rider and Robin's neutral posed
triangles directly with their original GLBs under translation and yaw, and
check that stretching pose landmarks cannot resize Blocky's rigid parts. Actual
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

Build 0.21.0 subsequently records focused Quest ALASKA rendering, actual high
fidelity and live full-body poses, with fallback transitions; see graphics-quality.md.
Build 0.22.0 adds a right-controller score/boost panel. 84 actual Vulkan checks
verify body/controllers, numeric clock/score, green bank/red loss pixels and
stereo/target formats. Worn-headset readability and the new steering controls
remain separate device checks; see trick-scoring.md and vr-steering.md.

Build 0.34 corrects the controller model from its old local-Y handle to the actual
OpenXR thumbward grip axis. Controller poses stay unmodified. The original hand
bind frames now map all three axes to grip, preserving wrist roll and the finger
geometry instead of aiming a thumb-root vector as the entire hand. Third-person
presentation moves the eyes/controllers/panels while avatar IK remains on the
undisplaced body. See quest-controls.md for physical verification limits.

Build 0.39 adds procedural body balance, walking sway, arm inertia, landing
compression, independent head look and fixed switch bindings. The head mesh
now follows yaw, pitch and roll, and the eye bridge supplies desktop first-person
and tracked self-view alignment. See rider-motion.md for authority, tuning,
validation and remaining style/calibration work.

Build 0.59 corrects the sensor-driven finger flexion plane. The previous axis
used the vector from each knuckle back to the wrist, which lies along the palm
and made the fingers sweep sideways. Each chain now bends toward its hand's
anatomical palm normal, with opposite normals on the two mirrored hands.
The hinge follows the full grip rotation and remains shared down the chain.
Thumb touch, index touch/trigger and grip still drive separate groups; release
restores the exact resting mesh. This is independently authored posing of the
existing first-party art, not recovered retail hand animation. See
`finger-curl-0.59.md` for regression evidence and worn-device verification limits.
