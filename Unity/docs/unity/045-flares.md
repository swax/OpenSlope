# 045 — Colored Flares and Light Glints (Unity port)

World-light types, flare composition, the light-record glint gate, colour law,
projection, and source behavior are specified in
[Trailmap: 160-lighting-data] and [Trailmap: 180-particles-data]. This document
covers only the bundle and Unity realization.

## Bundle mapping

`ParticleBundle.BuildEmitters` exports continuous emitters to
`manifest.Emitters`. For an emitter near a decorative light it also carries a
normalized tint and diagnostic light metadata. The association is spatial and
data-derived; it does not depend on a model-name allowlist. Emitters without a
matching decorative light retain no tint, which keeps unrelated snow/fog
emitters on their normal path.

`ParticleBundle.BuildLightGlows` separately exports glint-capable light records
to `manifest.LightGlows`. The plume and glint remain independent bundle objects;
the light is the source of the glint, not an attribute synthesized on the prop.

## Importer realization

`EmitterBuilder` handles the continuous plume with the blend mode and particle
parameters supplied by the bundle. Refresh it with
`OpenSlope/Refresh/Prop Emitters` after changing emitter settings.

`LightGlowBuilder` creates one `OpenSlope/FlareHalo` renderer per
`LightGlows` record under a shared `LightGlows` root. It uses the staged lens
atlas when available and maps bundle position, hue, and size class into the
material. The builder runs after range-culling setup so distant lights are not
silently removed with ordinary nearby props.

The material and builder tuning in `ImportConfig` controls Unity size, alpha,
range, pixel floor, centre bloom, aura, camera pull, and visibility fade. These
are port settings; the source law and measured constants remain in Trailmap.
`OpenSlope/Refresh/Light Glows` reapplies them without a full import.

## Runtime visibility

`LightGlowBuilder` adds a `GlintFadeMarker`; platform wiring realizes
`GlintFade`. The runtime samples a small visibility kernel from the viewer and
eases each renderer's `_Visibility`. With that component enabled the shader
does not also depth-test the quad, avoiding competing occlusion models.

Primitive colliders that contain the light are cached as its housing and
ignored by identity. Large merged mesh colliders are never globally exempted;
a hit very near the light is treated as housing for that ray, while a separate
surface remains an occluder. This is Unity-specific compensation for coarse
generated prop colliders.

With visibility fading disabled, the material falls back to depth testing.
The edit-mode Scene view does not run the Udon fade, so runtime/play mode is the
place to judge final occlusion.

## Verification

- Confirm emitter/light association is stable across repeated bundle builds.
- Check an emitter with no nearby decorative light remains untinted.
- Check glints whose lights sit inside primitive and merged-mesh housings.
- Exercise the fade at range and around terrain/prop edges in play mode.
- Verify missing lens art selects the documented fallback.
- Compare source fidelity to [Trailmap: 160-lighting-data], not to numeric prose
  in this implementation document.

## Related implementation

[014 — Particle Effects](014-particles.md) owns shared particle-bank import;
[047 — Continuous Emitters](047-continuous-emitters.md) owns generic emitter
realization; [010 — Object Lighting](010-object-lighting.md) owns the static
lighting path. The Slopesmith preview sibling is
[Slopesmith: 047-light-glints].
