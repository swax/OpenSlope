# Quest controls and grip frames

Build 0.34 aligns the supported controls with Slopesmith's public ride manual and
XR behavior tests. It also corrects the controller/hand orientation reported by
the user. This is shared native input and independently authored posing code;
no separately licensed runtime supplies the controls or geometry transforms.
The table includes the 0.35 equipment and 0.36 flight updates; see foot-flight.md
for current movement and unlimited off-board thrust.

Build 0.53 adds per-hand capacitive touch and analog finger posing, the baked
first-party Touch Plus controller model, a controller-fixed depth-tested wrist
panel, continuous-control impacts and interpolated VR board rotation. See
`quest-playtest-0.53.md` for the behavior, source boundary and verification limits.

| Quest input | On foot | Mounted |
|---|---|---|
| Left stick | Head-relative walk/strafe | X turns the player; vertically dominant Y sets posture/flip |
| Head | Walk direction | Always-on gaze steering |
| Right A | Jump; second airborne press enters flight | Hold/release charged jump |
| Right B | Aimed full-speed airborne/held-board thrust | Held boost |
| Either index trigger | Point to ride; re-equip held board | Dismount |
| Either grip | Pick up/pass/throw; behind-head draw | Airborne board take-off |
| Left X | Recall equipment ahead; keep player in place | Nearby-course reset |
| Left Y | Show/hide controls and status panels | Same |
| Right stick X | Smooth view turn, 120 degrees/s at full throw | Unused |
| Right-stick click | First/third-person toggle | Same |
| Left-stick click | Unused | Existing explicit rail exit |

A declarative table supplies the actual OpenXR Touch bindings. Boolean B owns
boost; both trigger-value components feed the one board action through OpenXR's
boolean conversion/aggregation. A held board action cannot repeatedly mount and
dismount. X changes intent by locomotion state. Recall places only the loose
board ahead, probes for a supporting floor, and snaps its interpolation history.
It does not move the rider, restart the event or spend boost. A fresh X press
also recalibrates standing eye height to 1.65 m, on foot or mounted.
A held X does not drag the equipment along with a moving walker.

Startup, X, run restart and **Recenter View** sample the current headset posture
for height calibration. Mounting, dismounting and teleports keep the saved height
offset. Calibrate below 1.4 m above the physical floor to use seated procedural
legs; standing calibration allows runtime leg tracking, including crouching.
The posture mode stays fixed until reset/recenter. See [avatar tracking](avatar.md)
for floor correction and the local-space fallback.

Y replaces the old gate-restart binding. Build 0.35 now toggles an interactive wrist
menu; its controls are a separate page. See equipment-camera-ui.md.
Right-stick camera toggles between first person and a two-metre-back/one-metre-up
view. The rendered controllers and status follow the displaced eyes; the body,
wrist IK, collision and actual room movement stay in the underlying player frame.
Right-stick turn changes the upright presentation yaw only on foot. While riding,
left-stick X turns the player at up to 120 degrees/s, rotating the view, body and
hands together. The board follows the resulting gaze on snow, in air and on rails.
Head steering stays active during stick turns. There is no launcher or wrist-menu
steering selector. The right stick does not turn the mounted player.
Desktop E now toggles boarding, matching Slopesmith; G remains an alias, Q exits
a rail, and T remains full run restart. The simple-controller fallback retains
its limited Select/Menu bindings rather than advertising Touch buttons.

## Grip orientation correction

OpenXR grip poses are not aim poses. Its -Z axis runs thumbward through the
partially closed fist, with X normal to the palm and Y completing the frame.
The generic model previously used raw grip +Y as its handle's length, producing
the reported quarter turn. The drawn model now maps its up axis to grip -Z and
its forward axis to grip -Y, preserving the origin and right-handed basis.
No correction is applied to the tracked quaternion, skeleton positions or eyes.

The stick figure previously aligned a hand to one wrist-to-thumb-root vector,
which also lost twist about that vector. Native now retains each hand's original
three bind axes, maps its X/Y/Z onto grip X/-Y/-Z, and carries all weighted finger
geometry with that complete rigid transform. Controllers are independently drawn
from the same unmodified pose. These are stand-in hand shapes, with finger curl
and exact device contours still pending.

Primary frame references: [OpenXR standard pose identifiers](https://registry.khronos.org/OpenXR/specs/1.0-khr/html/xrspec.html#semantic-path-standard-pose-identifiers)
and [WebXR grip-space explanation](https://immersive-web.github.io/webxr/input-explainer.html).
The mapping is validated against Slopesmith/docs/016-ride.md and its public
xr-play.test.ts examples; no Slopesmith runtime implementation was read or copied.

## Verification and outstanding scope

Portable checks exercise the actual binding table, A charge/release, B preserving
boarding ownership, trigger mount/dismount edges, X recall, Y/camera edges,
view turn/dead zone, all three wrist rotation axes in both hands, unchanged body
IK and translated third-person controllers. Actual Vulkan captures include the
label changes, upright grip, roll, displaced view, tracking fallback and stereo.
Validation: all 34 portable suites pass, including 39,144 control/grip-frame
checks; 102 actual Vulkan avatar/controller checks and 13,740 general GPU
assertions pass. Equipment recall has 987 production frames, with the same
replay passing against the packaged EXE. Existing walking/boarding (218 frames)
and scoring (1,311 frames) replays pass. The signed ARM64 APK is version
0.34.0/code 35; lint reports zero errors and four existing warnings. All 15
notice/license assets match their sources, with no packaged course media.

Worn-headset alignment remains unverified until the user has time to test this
APK. Build 0.35 supersedes proximity-only triggers with per-hand aim and squeeze,
and adds an interactive wrist menu/restart, pickup, carry, transfer, summon and throw.
See equipment-camera-ui.md for the current implementation and validation. Superman
flight, crouch, exact controller geometry/finger curls and the remaining parity
matrix stay active work. Worn checks remain necessary for the new build too.
