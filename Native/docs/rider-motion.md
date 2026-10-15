# Rider body and head motion

Build 0.39 animates the first-party stick figure on desktop and Quest. Walking
swings opposing arms and legs and shifts the pelvis. Riding folds the spine
and knees for crouch/charge, eases the visible edge pose on reversal, balances
against measured acceleration and compresses on landing. Arms respond to
acceleration separately from the torso. Calm grounded travel occasionally
looks sideways; activity returns the gaze toward travel. Parked riders do not
glance. Feet retain their anatomical bindings when riding switch, while the head
looks toward the direction of travel.

The independently authored RiderMotion filter advances only on simulation
ticks. Rendering interpolates its samples alongside the rider position and
does not advance timers or consume gameplay randomness. Placement and equipment
attachment changes clear its history. The balance filter uses a 0.25 second
response, edge pose has a 0.14 second half-life, arm inertia has a 0.20 second
response and 9.6 cm travel limit, and the vertical hip absorber has a 0.20 second
response and 12 cm limit. Landing compression uses a finite 15 ms impulse.
Released charge supplies a short pop extension. Horizontal travel has no hip lag;
airborne poses move with the deck. Riding charge lowers the pelvis up to 22 cm;
on-foot crouch retains its deeper 35 cm drop and the existing collision behavior.

Procedural two-segment limbs preserve the bundled figure's anatomical lengths.
The pelvis lowers when needed to reach the bindings, and poles remain defined
when a bend direction and limb axis coincide. Shoulders turn partly toward
travel, independently of the fixed feet. These are original application poses;
there are no retail rider or trick animation clips.

On-foot head orientation is independent of loose or carried equipment. Rotating
the held board changes the hand and gear poses without rolling the walker's head.

The head has its own complete orientation frame. All three axes transform the
head mesh, including its existing front/back landmarks. Desktop first-person
look follows the camera, including held-C look-down; third-person head look
does not follow the observer's orbit. The first-person camera uses the figure's
eye bridge. Automatic glances never steer the camera, board or walker.

OpenXR supplies the head position and complete orientation directly. The eye
bridge reconstructs that position, including when looking down or rolling the
head. HMD head pose takes priority over inferred body-tracker head position.
A valid held-out pair of controllers supplies the fallback wearer heading when
the user looks back. Controller hands retain physical left/right identity and
remain anchored to their grips. When a grip exceeds the fixed arm's reach, the
procedural shoulder yields instead of pulling the hand away from the controller.
Fresh valid tracked body joints continue to replace fallback joints individually;
lost, malformed and outlier samples fall back as before. Procedural animation
does not add motion to the headset's view or drive tracking-based steering.

Authority is the public first-party behavior described in Slopesmith/docs/016-ride.md
and its rider-pose and on-foot-pose tests, together with the user-requested avatar
and tracking presentation. No Slopesmith runtime posing code is used as a port
input. Clean Trailmap 300 and 340 establish gameplay state and launch/landing
transitions; clean 400 establishes depth and independent camera framing. The
shared riding contract, collision probes and physics integration are unchanged.

The current procedural profile is a first-party approximation. The four selectable
Slopesmith styles, calibrated stature/reach, authored animation clips and broader
equipment choices remain parity work. Tracking-position authority can require
different limb lengths from the default rig; stature calibration is still needed
for general body proportions. Worn Quest self-view, reach and comfort remain
separate from desktop, simulated-tracking and APK validation.

Validation includes the full repository gate, final desktop/core builds with
39 passing suites each, and 15,662 motion/anatomy/binding/tracking checks.
The motion cases cover 30/60/120/240 Hz filtering, chatter absorption, landing
compression, glances, crouch, both switch bindings, walking, close/far grips,
HMD priority and four held-board orientations. 204 actual Vulkan checks cover
all head axes, first-person hiding, translated-root-independent walking pixels,
partial/lost tracking, controller roll, stereo, target formats and HUD panels.
Production foot/carry, boarding, camera, rail, crash/path recovery, collision
and desktop UI regressions pass. The packaged EXE also renders 195 GARI frames
across riding, walking and look-down captures. ARM64 main/test APKs build,
Android lint has zero errors and four existing warnings, and final package
signature and all 15 notice assets are checked. No worn-headset test or install
of this build is claimed.
