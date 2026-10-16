# Four-rail carve spray

The native rider now emits a connected additive spray sheet during grounded
carving. Clean Trailmap 380 supplies the system distinction, lean threshold
above 0.3, quarter-metre column spacing, four rails, half-metre ground tail,
1×/2×/3× upper-rail throws and a 0.9-second curl/fade. Clean 180/400 establishes
shared named art and additive compositing. Only clean bodies and owned output
images supplied implementation/comparison inputs.

Emission uses actual travelled distance at fixed ticks, with columns seated by
the same terrain/rideable-prop probes used by the wake. Each base stays fixed in
world space; the upper rails launch up and outside the turn, slow under drag and
curl down under gravity. UV U advances along the column history, while V spans
the four rails. Old columns continue their motion when the rider stops carving
or leaves the ground. Pause freezes age; reset/warp clears the stream. Missing
contact, a turn-sign change, a displacement above 5 m, or a support discontinuity
breaks connectivity. Rendering frequency and eye count do not emit columns.

The current application profile supplies unrecovered bindings: snow-family
types 1–4/8, a 0.3 m/s speed gate, 8 mm ground clearance, a normalized throw
direction combining 0.75 contact-normal and 0.65 outward-lateral components,
throw speed up to 6 m/s scaled by carve and speed/18, exponential drag 3/s,
world-down gravity 12 m/s², opacity 0.08×absolute lean and linear age fade.
Probe normals must agree above 0.75; bases over 1 m apart do not join. These are
explicit provisional choices. The exact per-surface sheet fields, throw/drag/
colour curves, texture-coordinate mapping and full reference trajectory/image
equivalence remain unproven. Ice and hard materials do not draw this snow layer.

Storage holds at most 128 columns and 2,286 triangle-list vertices, sufficient
for the native speed cap over the specified life. Rail positions are evaluated
once per column into reusable storage, then shared between its adjacent bands.
Integer texture-period rebasing preserves UV precision during long sessions.
Vulkan buffers grow geometrically and persist per renderer across target
recreation. This pass uses literal world vertices, separate from billboard
construction, with depth tests, disabled depth writes and additive blending.
Build 0.62 switches only this connected sheet to always-pass depth, matching
Slopesmith's public board-FX assertion. Billboard chunks, puffs and sparks retain
their opaque-world depth tests. The depth choice is an application play profile.
sRGB attachment compositing retains the existing linear-domain fidelity limit.

ISO import adds independent optional `Sheet` to `RidingEffects.json`, naming
`Textures/particle-spry.png`. Existing/custom maps can supply their own sheet
PNG without `Puff` or `Wake`. Missing profile/art draws no replacement; Quest's
image manifest and SAF cache include the configured reference. Retail art stays
outside source control and application packages.

Portable checks cover gate/spacing, four-rail connectivity, throw direction and
multipliers, fixed bases, curl/fade/expiry, bounded history, gap rejection, pause
and reset. Actual GPU checks cover additive colour, interpolated alpha,
overlapping sheets without depth writes, empty submissions and target recreation
at 1x/4x MSAA with UNORM/sRGB targets. Build 0.62 replaces the original sheet
occlusion check with paired front/behind equality on both target formats; the
other particle-depth checks remain. Production-host checks compare
enabled/disabled captures while confirming unchanged rider state:

```powershell
python Native/tests/desktop_sheet_test.py temp/native/Release/openslope_player.exe
```

Those cases include both carve directions, powder/deep snow, straight/light
steering, ice and rock. Quest JNI/SAF cases compile; headset execution remains
pending. Per-surface chunk rings, sparks, airborne puffs, boost/debris/pickup
effects, authored emitter lifecycle and the full desktop-parity.md objective
remain outstanding; this sheet does not complete composite spray parity.

Fresh local GARI extraction stages the explicit sheet slot; its `spry` RGBA
matches the existing owned normalized output exactly. A 120-frame carve draws
42 connected segments and changes 8,859 captured channels when only that slot
is toggled. Two runs each in builds 0.13/0.14 preserve identical rider/contact
state over 480 rendered frames. Local samples measured simulation 0.034 ms and
render wall 0.574 ms before, versus 0.036 ms and 0.590–0.619 ms with the sheet;
GPU samples remained approximately 0.293–0.295 ms. These short headless samples
describe local overhead, not a general performance gain or a VR frame budget.
