# Quest riding steering

Native OpenXR always uses head steering. The Quest launcher and wrist menu have
no steering-mode selector, and old saved choices cannot turn head steering off.
Windows uses `--xr`; older `--head-steering` launch arguments remain accepted.
Linux/device validation remains outstanding.

While riding, left-stick X rotates the player at up to 120 degrees/s using a 0.18
physical dead zone and linear normalized throw. This is a fallback for limited
physical head turning: the view, body, hands and pointing rays rotate together,
and the board follows the combined physical head direction and stick yaw. The
stick does not take steering authority away from the head or turn the deck
independently. On foot, the left stick walks and the right stick turns.
Incidental stick Y retains the existing dominant-axis
gate so horizontal steering does not also add an accidental flip.

On snow, project gaze and travel onto the contact plane. The first 5 degrees is
neutral; another 30 degrees reaches full steering. This drives the ordinary
fixed-tick lean/force/heading code, without a second gaze-based board yaw. Travel
is the reference, with the ridden forward axis as the near-stationary fallback.
This gives equivalent head/stick inputs the same speed and curve, including
banked surfaces and switch stance. Looking vertically supplies no yaw.

In air, gaze aims the deck toward the horizontal look bearing at the normal air
turn rate and stops inside the dead zone. Rails use the shared 270 degrees/s air
rate for head follow. Stick turning changes the gaze target in either state;
head follow stops at that target without turning the seat a second time.
VR has a free rail pose; desktop retains the existing
recovered ±80-degree pose and its state/force authority.

Head-derived board turns never rotate the upright headset seat. Stick yaw is
applied directly to the shared tracking frame, independently of the board's
heading change. Rendered head, hands/body and eyes share that upright transform.
An anchor records heading, physical headset yaw and the current carry; course
placement or reference-space changes establish a new anchor. This avoids the
gaze/camera feedback loop caused by carrying the view with a head-driven carve.

These are first-party VR application controls, aligned with Slopesmith's public
head-steer/XR tests and documented controls. Clean Trailmap 300/330/340/350/400
continues to govern rider forces, motion/control, contact and scene depth; the
original game has no headset control specification. No decoder implementation
is involved.

Portable checks cover head-carve trajectories over three surfaces, both stances,
two slopes and three steering amounts, including reversal/release. Quest checks
exercise stick-driven player rotation and gaze follow on snow, in air and on
rails, on-foot controls, seated/standing height preservation, rotated avatar wrists
and torso alignment, and removal of the wrist steering toggle. Worn-headset feel
and comfort still need user testing.
