# 019 — Firework triggers and native P6 particles

SSX authors fireworks as an effect-graph relationship, not as behavior on the visible canister prop:

- an invisible trigger instance owns an `EffectSlotIndex`;
- that slot's collision graph uses `MainType 7` nodes to run sub-effects on launcher instances;
- a firework sub-effect contains one or more `MainType 2 / SubType 0` particle emitters and a `MainType 8`
  firing sound.

The sound is the discriminator between fireworks and otherwise similar silent collision emitters such as dust,
sparks, fire, and hydrant water. The pipeline derives all launchers and links from this graph; model names are not
used to classify the effect.

## Bundle data

`Snowknife/Bundle/ParticleBundle.cs` writes `manifest.Fireworks`:

- `Launchers[]` — instance index, geometry-derived muzzle/barrel, firing-sound slot, and every complete P6 emitter
  layer from the launcher's sub-effect;
- `Triggers[]` — trigger instance/index, root-local bounds, effect slot, and exact launcher instance indices it runs.

Each layer contains the recovered `type2Sub0` law:

- logical particle count and trail-copy count;
- particle-start window and internal time scale;
- size and lifetime center/span;
- trail-copy age spacing;
- emitter origin and two centered spawn axes;
- base velocity and three centered velocity-variation axes;
- gravity;
- four semantic `[R,G,B,A]` stops (native SSF ARGB is normalized by Snowknife);
- `PARTICLE.SSH` sprite index and blend selector.

Extraction applies the owning instance position, rotation, and scale. Layer origins are root-local mesh-space points;
spawn/velocity/gravity values are root-local mesh-space vectors. A zero-origin launcher layer is placed at the
geometry-derived canister muzzle, and its native +Z particle basis is rotated onto the measured barrel direction.
Unity therefore does not need to reopen `Instances.json` or infer an aim.

The same rule covers direct SlopeSmith exports and all shared P6 consumers (persistent snow guns/flares, ambient
bursts, pickups, and boost pads). Their flattened `Props.obj` groups no longer have native instance rows, so the
export carries the model-to-world similarity in `Effects.json` `extensions.slopesmith.propPoses`, joined through
`bakedGroups`. Snowknife applies that pose to every local P6 point/vector before Unity sees it. Using the synthesized
group AABB centre with identity rotation made a yawed snow gun fire in its unplaced model direction—typically a
visible 90° error—even though SlopeSmith correctly previewed the placement yaw.

## Unity realization

`TriggerBuilder` builds:

1. `Fireworks` — one playable hierarchy per launcher. `P6EmitterBuilder` creates a stationary stock
   `ParticleSystem` for timing, random lifetime/size, and billboard quads. The `OpenSlope/P6Particle*` vertex shader
   evaluates the recovered P6 trajectory for each particle:

   ```text
   a = ageSeconds × timeScale
   ac = min(a, 2.7)
   curve = -0.73 × ac + 0.113 × ac²
   position = spawn
            + (gravity / timeScale²) × a
            + ((gravity / timeScale²) - (velocity / timeScale)) × curve
   ```

   Stable particle random values select coefficients in `[-0.5,+0.5]` for the two spawn axes and three velocity
   axes. Unity emission reproduces the authored start window; lifetime/size ranges, four-stop color, sprite, and
   blend are data-driven. Native trail copies are parallel particle renderers with the same seed and an increasing
   shader age offset, so each copy samples the same logical particle earlier on its P6 path and dies with its head.

2. `Triggers` — an invisible `BoxCollider (isTrigger)` for every mapped trigger, plus a
   `FireworkMarker` carrying the launcher systems, volley stagger, cooldown, and source effect slot. The platform
   wiring pass realizes that marker as `FireworkTrigger` or `BasisFirework`.

The P6 shader displaces vertices only; it needs no runtime MonoBehaviour and works in a VRChat upload. The importer
also computes a conservative trajectory envelope from all spawn/velocity corners over the maximum particle life.
Unity does not serialize a `Renderer.localBounds` override, so zero-speed CPU particles spawn within a sphere covering
that envelope. Their world-space `Center` stream is subtracted in the shader, while the emitter's world origin is
carried per-system in the serialized Custom Data stream; the P6 vectors are transformed into the same world basis.
The sphere therefore supplies persistent runtime culling bounds without changing the rendered trajectory.

## Trigger mapping

The authored trigger-to-launcher list is preferred. `FireworkUseRealMapping` can disable it for diagnostics, and a
trigger with no usable links falls back to the nearest launchers inside `FireworkFireRadius`, capped by
`FireworkMaxPerTrigger`. A launcher that is never targeted remains an ordinary visible prop and gets no runtime
trigger link.

## Runtime and networking

The trigger behavior calls `Play()` on a launcher root; Unity recursively starts every child layer/trail copy. It
then plays the positional `AudioSource` attached to that root. Launchers in one trigger fire in order using
`FireworkVolleyStagger`; `FireworkCooldown` guards re-entry.

VRChat uses a transient network event so every client sees and hears the volley. There is no synchronized persistent
state and late joiners need no history. The local walking player or rideable board is the only trigger source, which
avoids duplicate broadcasts. Basis uses its equivalent event wrapper.

## Sound

`LauncherInfo.Sound` is the sub-effect's raw `MainType 8` course-bank slot. `TriggerBuilder` loads
`Audio/SFX/<LevelSfxBank>/<slot>.wav`, adds a positional `AudioSource`, and tags it with `SpatialAudio` for the
platform wiring pass. `FireworkSoundSlot` is used only when a launcher graph has no authored slot. Volume and rolloff
remain Unity-side presentation settings.

## Configuration

Particle appearance has no tuning block: it comes from the P6 layer. The remaining controls cover behavior
and safety:

- `EmitTriggers`;
- `FireworkUseRealMapping`, `FireworkFireRadius`, and `FireworkMaxPerTrigger`;
- `FireworkVolleyStagger` and `FireworkCooldown`;
- `FireworkSoundSlot`, volume, and distance rolloff.

`P6EmitterBuilder` applies the same bounded editor/runtime safety policy as Slopesmith: corrupt counts are capped,
persistent rates are limited, zero-life persistent layers receive a three-second occupancy lifetime, and interactive
one-shots receive the same alpha visibility floor. Sprite width is authored, not boosted — a one-shot draws at the
same scale as a continuous plume. These limits do not replace authored values for normal retail data.

## Rebuild

After changing the bundle or importer:

1. run `snowknife gltf <level-folder> <level-name>` to write the current bundle;
2. stage it into the Unity project with `snowknife unity ...`;
3. sync `Importer` plus the target platform folder (`VRC` or `Basis`);
4. re-import the level so materials, systems, bounds, markers, and platform wiring are rebuilt together.

See also [014 — Particles](unity/014-particles.md), [034 — Bundle Pipeline](../../Snowknife/docs/034-bundle-pipeline.md),
[052 — Ambient Emitters](052-ambient-emitters.md), and [013 — Udon Components](vrchat/013-udon-components.md).
