# Collision bags and scripted knock-off bodies

The Roller property (main 0/sub 0) now activates the placed prop's live rigid
body. It moves the existing instance, rather than hiding it or creating a
render-only copy. Collision, support queries, culling and drawing consume the
same model delta. The clean Trailmap 130, 230 and 370 bodies establish the shape,
mass-centre, inertia and normal-impulse contracts; no other implementation is
used as a source.

This implementation ships in the 0.38 desktop and Quest test builds.

## Data and impulses

The node's first field supplies scalar mass. Its last three floats supply the
launch direction. The two intervening fields have no recovered consumer and
remain unused. An all-zero direction launches along the authored instance's up
axis with speed inversely proportional to mass; an explicit vector selects a
fixed launch speed. The application launch scale is 8 m/s, not a recovered
original coefficient.

Physics payload zero supplies the compound occupancy shape and its mass data.
The collision centre and centre of mass are distinct: leaf geometry follows
the collision-bearing object's rest transform, while the mass centre is already
in model space. The inverse inertia receives the recovered 0.075 coefficient,
the coordinate change and the cm²-to-m² factor. A body pivots around its mass
centre, recovering the visible model position from that pivot every tick.
Older authored physics documents without a complete mass block retain their
collision geometry and use the shape centre and a box-derived inertia fallback.

Rider impact uses the recovered normal impulse:

```text
J = 1.3 * closingSpeed / (bodyInverseMass + riderInverseMass + rotationalTerm)
```

The prop receives the opposite linear impulse and contact-offset torque; the
rider receives the corresponding normal velocity change. The instance's old
response mass and bounce magnitude do not alter this live-body response. There
is no added upward shove. The script's initial launch remains separate. The
application rider mass is 75 kg.

## Simulation and contact

Bodies integrate at 60 Hz with 9.8 m/s² gravity and internal substeps for angular
motion. Terrain and enabled prop geometry are queried with the decoded compound
leaf spheres. Broad-phase bounds are gathered once per compound query, avoiding
a complete terrain/world traversal per leaf. Simultaneous contacts are solved
as a manifold: repeatedly solving only one t=0 leaf can freeze a wide native
body even though a single-sphere test works.

Normal restitution 0.3, friction 0.65, angular drag, supported rolling resistance,
the speed/spin caps and sleep thresholds are application tuning. The activity
accumulator decays by 0.95 per fixed tick. A supported quiet body sleeps in its
new pose and wakes on another rider hit; it has no five-second respawn timer.
Run restart and the existing region/node lifetime machinery restore authored
presence. Pause and node destruction retain their existing effect controls.

Walking stores its velocity before the walker clips against the prop. This
preserves the incoming impulse when a contact is published after the movement
has already stopped. Riding uses the normal resolved world-contact path. Quest
controller walking and riding use this same Player implementation.

## Fidelity and remaining work

All surveyed Roller targets across the eleven local original-course exports use
mode-3 native physics bodies with player collision enabled. This path does not
make every positive-mass scenery prop movable. Scripted targets such as hydrant
lids can activate through the existing instance/function graph handoff too.
Targets without native body data remain unsupported instead of receiving a
guessed collider.

This is not proof of original trajectories or a complete coupled rigid-body
solver. Moved-body queries use the current world snapshot; fully coupled dynamic
islands, fast changing-rotation contact, exact solver/launch tuning and affine
inertia fidelity remain parity work. Nonuniform/sheared leaves use conservative
sphere envelopes for moved-body environment queries; the rider's native
occupancy collider retains its existing affine handling. Physical room-scale
body contact, worn Quest feel and worst-case device frame budgets still need
targeted validation. Normal ISO collision-event audio resolution remains the
separate work described in shatter.md and audio-import.md.

## Validation

The complete repository gate passes on the final source (476.0 s). Both final
Native build trees pass all 38 suites. The rigid-body checks pass 42 assertions:
momentum, off-centre torque, separate mass/shape frames, source-property independence,
wide compound support, sleep/wake, restart, scripted targets and real Player input.
The actual GARI bag has 452 native leaves; the controlled riding and walking
checks move its mass centre about 6.2 m and 1.5 m respectively.

Twelve desktop replay groups pass 5,593 gameplay frames, including 1,292 new body
frames. A stopped-camera comparison verifies the visible body receding after
impact; CPU collision rays verify its old location is clear and the new one is
collidable. Final runs repeat the body replay, 13,772 Vulkan appearance checks
and 157 avatar/HUD/stereo checks. The exact packaged EXE also passes riding and
walking captures against the GARI map used by its launcher.

The ARM64 app and instrumentation APKs build at 0.38.0/code 39. Lint reports zero
errors and four existing warnings; signatures and all 15 packaged notice assets
are checked, with no course media in the app. The Native source audit checks 280
files without forbidden references. No new headset installation or worn-device
performance result is claimed.

```powershell
python Native/tests/rigid_prop_test.py temp/native/Release/openslope_rigid_prop_tests.exe
python Native/tests/rigid_prop_test.py temp/native/Release/openslope_rigid_prop_tests.exe temp/native-rails-0.17.0/Maps
python Native/tests/roller_replay_test.py temp/native/Release/openslope_player.exe
```
