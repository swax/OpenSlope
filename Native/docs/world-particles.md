# World particles and fireworks

Build 0.40 executes timer and collision emitter nodes on desktop and Quest.
Firework triggers now produce their authored layers at the called instances,
alongside the existing course SoundPlay dispatch. The same path handles
continuous emitters, collision snow bursts and darkening flare smoke.

The 51-field block follows clean Trailmap 180 and 230. Timer fields retain
their float types, including fractional U9. Collision fields from older map
documents are reinterpreted from their stored f32 words. Origin, two spawn
axes, base velocity, three velocity variation axes and gravity convert once
from centimetres/Z-up into the native map frame. Construction snapshots the
current owning instance placement; rigid bodies and spline movers supply their
live instance pose. Model-only submesh animation does not move that instance
frame. A collision captures its live point and outward normal through nested
functions, target calls and waits; it replaces the stored point and redirects
the authored base speed without changing the remaining variation vectors.

A positive emission window releases the count once, spaced by window/count.
A negative window streams at count/abs(window), and a zero window releases
the count together. Lifetime and half-extent size use their centred ranges.
Positions follow the clean 180 shared polynomial law, including its 2.7 clamp.
The four native ARGB stops become RGBA and interpolate across each particle's
life. Authored trail timing produces tapered copies. Fixed-tick emitter age
interpolates for rendering; reconstructing either eye consumes no simulation
time or gameplay randomness.

Detached emitters coexist with other installed properties. Lifetime operation 3
kills the addressed owner's detached layers, and an explicit constructor can
install again. Run restart clears all records. Region exit disposes an
unlatched emitter; a populated exit latch retains it, and reentry does not
duplicate that live layer. One-shot trigger graphs must disarm their receiver
when authored that way; GARI's triggers already do so before calling launchers.

Sprite registration is independent of image-directory order. The shared Apache
contract Contracts/particle-sprites-v1.json retains all 38 short registration
identifiers, including the repeated mip1 entry. The table was independently
checked against inline 12-byte registration data in the user's supplied image;
tools/check-particle-contract.py reproduces that data comparison without
disassembly, another decoder implementation, addresses or exported media.
Slopesmith's public preview API agrees with the complete contract, guarded by
its new particle-contract test. Native implementation uses the clean specs,
this shared data contract and independently authored runtime/rendering code.

New ISO imports write an explicit EmitterSprites filename array into the existing
RidingEffects.json profile. Older named SpriteBank maps resolve through the same
registration contract. Authored maps can use Textures/Particles/<name>.png
without an imported profile, or provide an explicit indexed filename array.
Missing sprite art stays missing rather than selecting unrelated textures.
These textures join the portable asset manifest. Quest's external-folder planner
also requests optional named files before they exist in its play cache, and
copies bounded nested texture paths through the selected document tree. Safe
path components, canonical map bounds, cancellation and image budgets remain
enforced. No disc or course art is packaged with the application.

Each eye draws coloured camera-facing quads with opaque-world depth testing
and no depth writes. Selector 1 uses alpha blending, selector 4 darkens the
frame by its alpha while ignoring source colour, and other selectors use the
additive path. Additive layers batch by texture; alpha/darkening layers sort
back to front after the additive pass. Fog attenuates additive colour and the
opacity of alpha/darkening layers. The existing target colour conversion is
retained for UNORM and sRGB swapchains.

The application bounds records at 512 emitters, authored counts at 8,192,
trail copies at 32 and output at 32,768 sprites per view, with a 500 metre
sprite distance limit. Its deterministic integer hashing, uniform samples,
linear colour-ramp interpolation, trail taper and maximum-axis size scaling
are independently authored presentation choices. Exact original seed streams,
registry metadata beyond names, nonuniform billboard scaling and performance
across worn devices remain comparison work. Standalone fog volumes, weather
snow, point-light flare colour and god rays are separate remaining consumers.

Validation includes 40 native suites, all eleven existing course graph datasets,
918 production Vulkan/PCM frames for walking/riding bursts, delays, streams,
stops and restart, and 13,896 actual Vulkan appearance checks. Pixel checks cover
all blend paths, dark smoke, fog, depth, missing art and multiple texture layers
on 1x/4x UNORM/sRGB targets. Every one of GARI's 23 report-bearing trigger chains
produces sparks and course sound events; the largest sampled burst reaches
12,597 sprites. Matching actual-player captures show 1,567 changed pixels at
30 ticks and 1,185 at 60 ticks, with identical rider position and velocity.
The first GARI trigger batches 3,600 sprites in one draw.

The full repository gate passes. Quest 0.40 installs and passes 91 JNI,
custom-library and SAF checks, including authored nested particle art without
an imported profile. The test provider bootstraps its fixed fixture-tree grant
from its own process to the same-signed target after APK updates. Production
document permissions retain the normal folder-picker grant flow. The user's
ALASKA Patches.json and library preferences retain their pre-update hashes.
An eight-second ALASKA activity check initializes both 1680x1760 eyes with 4x
MSAA, requests high body fidelity successfully and creates the runtime full-body
tracker. The headset was asleep, so this confirms startup and resource creation,
not active tracked poses, rendered particle frames or a sustained frame rate.
These device checks do not establish worn-headset particle performance or comfort.
