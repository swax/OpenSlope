# 047 — Continuous emitters

Persistent `MainType 2 / SubType 0` graphs drive snow cannons, road flares, lantern flames, and any equivalent
authored effect. They are selected structurally: a visible instance's `EffectSlotIndex` resolves through the slot's
`PersistantEffectSlot` to a graph containing emitter nodes. No model-name list classifies them.

## Bundle

`ParticleBundle.BuildEmitters` writes each host and its complete P6 layers to `manifest.Emitters`. Extraction applies
the owning instance transform to every layer: origin becomes a root-local mesh-space point; spawn axes, velocity
basis, and gravity become root-local vectors; size center/span absorb the instance's scalar size. Unity therefore
does not aim a cone from model geometry or tune an approximate speed/gravity.

The record retains muzzle/barrel/radius/light metadata for other prop presentation, but particle motion is wholly
defined by the transformed P6 layer.

## Unity

`EmitterBuilder` groups systems under `Level/Emitters/Cannons` and `Level/Emitters/Flares`, then delegates every
layer to `P6EmitterBuilder`. A stock looping `ParticleSystem` supplies timing, random lifetime/size, and billboard
quads; `OpenSlope/P6Particle*` evaluates the recovered trajectory in the vertex shader. Authored color stops, sprite,
blend mode, spawn plane, velocity envelope, gravity, and trail copies all share the same implementation used by
fireworks and collision-triggered ambient bursts.

Because Unity does not serialize a custom renderer-bounds override, the zero-speed CPU particles occupy a
conservative sphere covering the P6 trajectory. The shader subtracts each particle's world-space `Center`, restores
the per-system world origin from serialized Custom Data, and evaluates the transformed P6 vectors in the same basis,
so this persisted culling envelope does not affect the visible motion.

The systems require no runtime script. `playOnAwake` starts them, and the object culler/performance board may toggle
their parent groups.

## Blend and sprites

The layer's remapped blend selector is authoritative:

- additive layers use `OpenSlope/P6ParticleAdditive`;
- alpha layers use `OpenSlope/P6ParticleAlpha`;
- darkening layers use alpha blending with black RGB, reproducing framebuffer multiplication toward black.

`SpriteIndex` indexes the shared `PARTICLE.SSH` name table; there is no global sprite override. All four authored
RGBA stops are interpolated over particle life.

## Configuration

`BuildEmitters` is the master toggle. `EmitterMinSize` is the sole particle-content filter: zero builds every
persistent emitter, while a higher threshold can omit small layers for a constrained target. There are no visual
tuning knobs: the complete P6 law drives the result.

Re-run **OpenSlope/Refresh/Prop Emitters** after changing the current bundle. See [019 — Fireworks](../019-fireworks.md) for the
shared P6 implementation and [045 — Flares & Lamp Glows](045-flares.md) for the separate light glint path.
