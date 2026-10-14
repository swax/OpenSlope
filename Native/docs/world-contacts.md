# Playable authored prop contact

The player owns a shared `CollisionWorld` loaded from its Maps course. Windows
and OpenXR hosts use that same fixed-step rider. Quest's folder cache includes
referenced collision proxies and `Physics.json`, with `SSFLogic.json` accepted
for older exported maps. Imports validate the collision contract before publishing.

Clean Trailmap chapters 130, 300, 320, 340 and 370 establish the contact split,
response equations and wipeout transition. The importer/query boundary is
described in [collision foundation](collision-foundation.md). There is no linkage
to a separate game-format decoder. Only generated course data is used for local
interoperability comparisons.

The short ground line chooses the nearest admitted terrain or response-enabled
rideable prop. Surface type, point and normal enter the same spring, resistance,
bank and landing model. A prop identifier is retained on the grounded rider.
Upward rideable faces defer seating to this line rather than floating the deck
at pelvis-sphere height. Other admitted rideable contacts remove incoming normal
motion, keeping tangent velocity. Pass-through shapes cannot become ground or
camera surfaces.
An explicit local box is sufficient even when the custom model has no render
geometry; collision eligibility does not depend on whether the prop is drawn.

The separate prop pass uses one pelvis sphere and eighteen possible limb spheres.
The original application pose profile places torso/head, paired shoulder/elbow/
hand and hip/knee/foot chains, and four deck probes. The default pelvis radius is
0.85 m and can be configured; crouch, flip and bank re-pose the profile. Ground
uses fourteen limbs, air uses all eighteen. Exact character skeletons, original
ground-mask bits and animation-derived poses remain outstanding. The BVH query
box follows the enabled limbs, falling back to the body when none are supplied,
as required by the clean specification. Mode 2 still tests only the body sphere;
mode 3 gates on the body and tests the enabled limbs.

Each fixed tick sweeps the posed volume through the intended displacement.
It processes a solid impact or a deck landing in travel order, applies the
authored response, then sweeps remaining rebound travel. A bounded eight-pass
solver prevents unbounded contact loops; unresolved travel is stopped at the
iteration cap. Initial overlap receives the specified ten-percent penetration
correction, once per instance per tick. This continuous integration policy and
the pose profile are application choices, not a claim of identical trajectories
to the original engine. Provisional double-sided triangle and general ellipsoid
limits remain as recorded in collision-foundation.md.

Begin/stay/end events retain instance, effect slot, surface, shape contact and
physical response separately. A zero-mass or bounce-disabled shape can emit an
event without changing velocity. A crossed trigger emits begin, followed by end
on the next clear tick; continuing overlap emits stay rather than repeated begin.
Reset/warp clears contact history. Audio consumes the event stream through
portable map routes. Executable sound resolution, authored graphs, reset-volume
logic, pickups, break/rearm and live rigid-body activation remain outstanding.

The specified hard-impact threshold enters motion 5 / control 19. Ordinary drive,
charge and airborne trick input stop, while velocity and surface contact continue.
The desktop title shows wipeout/recovery and get-up progress. A first-party
pose now animates the shared tumble/relative get-up path, and the get-up track
emits completion to restore control. Hard landings and unrideable-surface triggers are also connected; see
[crash recovery](crash-recovery.md) for provisional thresholds, pose tuning and
run gating. Original character/tumble fidelity and full path/fade reset remain
outstanding. R still exits explicitly.

The desktop chase camera shortens its arm against terrain and solid prop rays,
with 15 cm clearance. This is a point-ray obstruction check; camera-radius
occlusion, orbit controls and smoothing remain work. Tracked VR head positions
are not clamped by this desktop camera policy. Headset comfort and contact input
still need device validation.

CPU fixtures cover solid rebound, thin proxy walls, occupied/hollow body traversal,
fast movement, wipeout input suppression,
trigger begin/stay/end, elevated rideable-box landing, continued prop ground
contact and camera obstruction. Production Vulkan replays cover a solid wall,
a contact-only trigger, an elevated triangle deck and a custom box with no render
geometry, alongside the existing
269-frame charged-jump/spin/landing replay. Quest APK, test APK, lint and signature
checks run without a headset; instrumentation execution still requires a device.

`tools/native-compare-collision.py` compares generated instance joins at float32
precision, expanded collision corners within 0.001 raw cm, face normals within
1e-6, all physics payloads/encoded masks and local bounds directly against source
PBD records. It reads comparison data only, never another decoder implementation.
These are format checks; they do not prove complete gameplay parity.

Local validation passed for all eleven supported disc courses, including
multi-payload physics groups and unreferenced records. A 300-frame GARI desktop
replay from its authored start also ran with the existing exported Maps folder:
simulation averaged 0.039 ms/tick, render wall 2.163 ms/frame and GPU 1.816 ms/frame
on the local desktop. This short sample contains no prop impacts and establishes
only a startup/riding baseline; the authored replays supply the impact evidence.
It is not a whole-course or Quest performance result.
