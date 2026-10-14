# Carved wake

The shared player now retains a textured ground trail during steady grounded
motion, including straight riding. Clean Trailmap 380 establishes a roughly
100-section paired strip, per-surface enable/fade table, widening through a
carve, advancing longitudinal UVs, neutral colour, separate alpha compositing,
two offset passes and a tapered ending when its gate drops. Only clean chapter
bodies supplied behavior; the implementation and tuning here are independent.

Surface types 1, 2, 8, 15 and 16 use scalar 0.0286; 3 and 4 use 0.0167;
5 uses 0.1998. Other types emit no wake. Each section retains the scalar at
birth so crossing into another material does not change the old track's fade.
Air, wipeout, stopping, unsupported surfaces or a missing contact end emission.
The last four sections taper toward zero at the tip; subsequent contact starts
a separate strip. Reset/warp clears all history, and pause freezes the clock.
Rendering and eye count cannot produce extra sections.

Application choices where exact clean bindings remain open: half-metre spacing,
full width 0.28–0.90 m from absolute lean, a 0.3 m/s speed gate, initial alpha
0.7, linear per-second subtraction of the surface scalar and four-step endpoint
taper. The ring holds at most 100 sections, so a full unbroken track spans
49.5 m; snow and powder can survive for tens of seconds while ice fades sooner.
These values implement the stated character and ordering, not proof of exact
original trajectories or fade curves.

At emission the centre and both edges are probed against analytic terrain and
authored rideable prop collision. Their positions and normals are retained in
world space. An edge missing support, meeting a non-wake surface, differing in
normal by too much or stepping over a substantial height discontinuity breaks
the strip. The probes span ±0.75 m around the requested point; normal agreement
must exceed 0.75 and edge displacement along the centre normal must remain below
0.35 m. A displacement over 5 m in one tick starts fresh. These are conservative
application limits; finer tessellation and exact contact-plane reconstruction
on sharp course transitions remain comparison work.

ISO imports name the shared `tral` art as `Textures/particle-tral.png` and add
optional `Wake` to `RidingEffects.json` (`openslope-riding-effects/v1`). `Puff`
and `Wake` are independent optional slots; a custom map may supply either.
References must be flat safe filenames inside Textures. No art is bundled in
the EXE/APK. Missing profile/art disables drawing rather than supplying a
replacement. Quest's existing image manifest/cache includes both references.

The Vulkan pass consumes at most 594 triangle-list vertices from the shared
snapshot. Per-vertex alpha interpolates through the ribbon, without terrain
lighting. Source-alpha/one-minus-source-alpha compositing depth-tests without
writing depth. Two draws use 8 mm and 12 mm normal offsets; the second mirrors
the across-strip UV to place the one-edge texture at the other groove. The
offsets and mirrored pass reconstruction are application choices until exact
clean render bindings are established. Images use the existing diffuse mip
policy. Vertex buffers grow geometrically and persist per renderer across
target recreation. Integer-period UV rebasing avoids unbounded float coordinates
in long sessions without changing texture phase. sRGB attachments blend in linear space, with the same
documented byte-domain fidelity limit as other translucent effects.

Portable checks cover all surface gates, width, world/contact positions, distance
spacing, 100-section wrapping, fade ordering, endpoint taper, air/teleport breaks,
pause and reset. Actual Vulkan checks cover two-pass alpha, interpolated fade,
mirrored groove edges, longitudinal repetition, occlusion, overlapping geometry
without depth writes, zero/empty submissions and target recreation at 1x/4x MSAA
on UNORM/sRGB targets. Run the production host checks with:

```powershell
python Native/tests/desktop_wake_test.py temp/native/Release/openslope_player.exe
```

They compare enabled/disabled wake captures for straight/carved riding, powder,
ice, rock and a raised rideable prop, while checking unchanged rider state.
Quest build/cache cases compile; headset execution remains pending. Surface
spray, the four-rail sheet, sparks, airborne puffs, boost/debris/pickup effects,
authored emitter lifecycle and the rest of desktop-parity.md remain outstanding.

A local 180-frame GARI replay run twice in builds 0.12/0.13 preserved the same
rider/contact state over 720 rendered frames. Samples measured 0.037–0.062 ms
simulation and 0.420–0.421 ms render wall before, versus 0.043–0.052 ms and
0.459–0.526 ms with the wake; GPU samples were 0.237–0.243 ms and 0.244–0.251 ms.
These short headless samples describe local cost only; they are not a whole-game
budget, hardware VR result or general performance improvement claim.
