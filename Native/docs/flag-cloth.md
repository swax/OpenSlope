# Flags and banners

Build 0.33 adds property subtype 13 from clean Trailmap 230, with lifecycle
from clean 150. A reached graph installs a private cloth clock on its host.
U0 selects the fixed sampled edge (zero first, nonzero opposite), U1 is cycles
per second, U2 is ripple amplitude in source vertex units, and U3 is lifetime
in seconds. There is no wavelength field. Phase advances under the fixed
simulation clock. A seeded first-party random generator gives each constructed
flag a different initial phase and repeatable replay/restart behavior.

Eight equal sections connect the fixed edge to the free edge. At normalized
station k, model-X displacement is amplitude * k * sin(2*pi*(k-phase)). Native
converts centimetres to metres and divides by the rendered X-axis scale, so a
rotated or nonuniformly scaled placement retains the specified world amplitude.
Zero amplitude draws the exact original mesh. Both sampled ends and tapered
corners keep their original positions and UVs before this displacement.

A bounded graph traversal finds possible flag models before scene upload. It
follows every instance circumstance, function calls and targeted graph hops;
it does not infer cloth from asset names. Only these models get a second,
eight-section index range. A sibling without a reached flag property keeps
its original triangle range even when it shares the model and material.
The supported source strip has four position corners and two triangles; custom
quads may use either diagonal if their first two position corners form an edge.
Other geometry in a model assigned this property reports an unsupported strip
rather than guessing a deformation layout. All 119 locally owned flag models
satisfy this layout, each with one strip.

GPU placement storage retains its existing 192-byte layout. The unused two UV
components hold amplitude and phase/pole; the prepared vertices carry a station
marker in their otherwise unused prop lightmap coordinates. UV scrolling,
material selection, model/route transforms, fog, cutouts, translucent sorting
and private stereo placement buffers keep their existing paths. Bounds expand
along local X before transformation, including flags whose original plane is
outside the view. Wave clocks never advance during drawing.

Pause freezes phase and lifetime. A positive lifetime dispatches the host's
slot-four end chain once; without an end chain it removes the private override.
The end chain may hold the final wave, replace the property or remove it.
Zero lifetime persists until region unload, replacement, hide or course restart.
Re-entry constructs a new clock. The fixed-step scheduler drains end graphs
after property iteration. No ISO or additional cloth texture is required for
custom maps using the effect document schema.

## Evidence and remaining fidelity

- 33 portable suites pass. 264 combined flag/owned-course CPU checks cover formula signs,
  both anchors, phase wrap/reverse, lifetime, scale/rotation/bounds, interpolated
  UVs, original/shared geometry, function/target discovery, pause/end/unload and
  restart. The four owned-course check covers 119 models and constructors:
  ELYSIUM 22, MEGAPLE 12, MESA 38 and SNOW 47.
- 13,740 actual Vulkan assertions include comparisons of the rasterized silhouette with an independent
  eight-station screen-space calculation on UNORM/sRGB at 1x/4x MSAA. They check
  an otherwise culled plane waving into view, private queued stereo phases,
  invalid-state recovery and exact resting geometry.
- 161 production player/Vulkan frames cover phase changes, both fixed ends,
  pause, finite lifetime, run restart and an unchanged shared-model sibling.
  Captures show a rippling surface beside its flat sibling. Another 24 production
  frames load the four imported courses with active flag draws; a MESA close-up
  visibly retains its pole, tapered outline, patterned art and ripple.
- Adjacent material (221 frames), model animation (667 frames), boost history
  (1,186 frames) and avatar/controller (84 GPU checks) regressions pass. The
  signed ARM64 app is version 0.33.0/code 34; lint reports zero errors and four
  existing warnings. All 15 APK notice/license assets match their source files.
  No course media is packaged, and the installed Quest app/ALASKA are preserved.

The phase generator/seed is application policy; source random-sequence matching
has not been established. Rest normals remain the source packed normals;
original dynamic lighting and exact pixel matching remain unverified. Collision
uses authored proxies and runtime collision flags, independently of visual
cloth: 59 owned flags are authored collidable, all mode 2. Exact original
cloth-contact behavior, mirrored custom-scale semantics, material fidelity and
worn-headset appearance/performance still need validation. Fence springs,
particles, debris, movies and the other outstanding world effects remain part
of the full parity goal.
