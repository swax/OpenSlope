# Riding cloud effects

This milestone adds three layers of the composite riding spray: distance-gated
carve plumes, a lean-independent powder cloud and touchdown/skid cloud puffs.
Clean Trailmap 180, 380 and 400 establish the system distinctions, world-space
origins, size/life behavior and compositing. This is not complete spray/wake or
general authored-effect parity; the full objective stays in desktop-parity.md.
The subsequent connected carve sheet is documented in spray-sheet.md; it uses
the same fixed-tick riding state with its own geometry and texture slot.

The shared Player ticks effects at 60 Hz, after riding/contact resolution, even
when audio is disabled. Stable ground motion plus |lean|>0.2, or powder type 3/4,
admits a carve puff per 0.7 m traveled. Its original world position remains fixed;
the rendering curve grows width from 1.6 to 8 m over a two-second life and lifts
it along the stored contact normal. Powder independently re-places 0.3–0.44 m
cloud sprites near the board every tick. Touchdown emits 2–8 big puffs and seeds
a decaying follow-up activity. A fast sideways skid feeds that activity without
the initial burst. Landing width/height match the stated 0.2 s and 2 s points,
with a 0.2 s brightness ramp and quadratic fade. Reset/warp clears the pool;
pause stops its clock. Origins, random seed and counts belong to the player,
so rendering frequency and eye count do not produce extra emissions.

Where the clean bodies do not establish exact bindings, the native application
profile supplies tuning: displacement-based spacing, powder count speed×1.6
(cap 32), hard-skid gates 10 m/s and 4 m/s lateral, follow-up activity decay/rate,
opacity trims, scatter, carve lift and the shared soft-puff selection. Random
reconstruction is deterministic but does not reproduce the original P6 seeds.
Puffs are capped at 512 and sprites at 1,024. Exact curves/signal bindings and
the per-system sprite resolver remain comparison work.

Normal ISO import reads the user's `DATA/TEXTURES/PARTICLE.SSH` with the existing
independent SSH reader and writes the named bank as `Textures/particle-*.png`.
The explicit particle-bank profile detects half-range RGB (maximum≤128), applies
modulate2x there, then uses the strict normalized RGB≤alpha bound to infer and
remove alpha association where needed. This is a bank policy, not a declared
format flag; it does not change course/lightmap decoding. All 38 resulting RGBA
images matched the existing owned shared bank exactly. No art is compiled into
the application package. Synthetic palettes cover full-range and associated
particle colour independently of course normalization.

`RidingEffects.json` is an optional native extension, schema
`openslope-riding-effects/v1`, with `Enabled` and a `Puff` filename in the course's
Textures folder. An independent optional `Wake` slot selects the carved strip;
see carved-wake.md. Imports select `particle-part.png` and preserve the bank's
name→filename map. Build 0.40 also writes the indexed EmitterSprites array and
uses the shared registry for older named banks; see world-particles.md. No
registration-index mapping is inferred
from directory order. Existing/custom Maps can provide this profile and their own
PNG. Without a profile or available referenced art, no substitute sprite is drawn.
The legacy Shared bank is not automatically read by this consumer. Quest SAF
caching copies the profile and the referenced puff within its existing image
budget. Those device cases compile but require a headset to run.

The Vulkan pass creates camera-facing quads from one shared snapshot, including
asymmetric eye projections. It depth-tests against the scene, does not write
depth, and blends source×alpha plus destination. Dynamic vertex storage grows
geometrically and is retained per renderer. UNORM performs the byte-domain sum;
sRGB attachments blend in their native linear domain, so exact original-byte
compositing on that target remains unresolved. The actual GPU tests verify both
attachment paths, occlusion, overlap without depth writes and empty-frame cleanup.

Portable tests cover gates, fixed-world origins, landing bursts, expiry, pause
and reset; actual-host carving renders the extracted puff art. Existing contact,
jump and audio checks remain applicable. Surface-driven 40-slot streams, the
exact sheet bindings, sparks, airborne puffs, boost/debris/pickup
effects and general authored emitter lifecycle are still outstanding. Weather
snowfall is a separate system and is not satisfied by these riding clouds.

Build 0.62 adds the surface ring, takeoff puffs and contact/rail sparks with all
twenty independently checked functional rows. See surface-spray-0.62.md for
emission, sprite selection, alpha/additive rendering, validation and remaining
presentation-tuning limits. Build 0.61 separately adds ambient weather snowfall.
