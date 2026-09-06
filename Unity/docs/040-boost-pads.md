# 040 — Speed and trick boost pads

This page describes the OpenSlope extraction, import, and runtime port of boost
pads. Canonical pad opcodes, magnitudes, timing rules, sounds, and presentation
belong to [Trailmap: 360-speed-and-boost].

## Bundle pipeline

`Snowknife/Bundle/ParticleBundle.cs` resolves instance effect slots and writes
data-derived `manifest.BoostPads` records containing the pad footprint, kind,
authored value, emitter layers, and cross cue. The pad visual is diverted from
the merged prop mesh so Unity can animate it independently.

`Importer/Editor/BoostPadBuilder.cs` creates, under `BoostPads`:

- an inflated trigger volume;
- the authored one-shot P6 emitter burst;
- a cross-cue `AudioSource`; and
- a `BoostPadMarker` for the VRChat wiring pass.

`PropBuilder.BuildBoostPadDecals` realizes the diverted visual under
`BoostPadDecals`. Refresh the result with **OpenSlope > Refresh > Boost Pads**.

## Runtime mapping

`VRC/World/BoostPad.cs` accepts both a walking player's trigger callback and
the ridden board's `RiderProbe`. A speed pad calls
`RideableBoard.ApplyPadSpeedBoost`; overlapping windows take their maximum and
reuse the board's existing boost gate. A trick pad currently plays its authored
feedback but has no gameplay effect because this world has no trick/scoring
system.

The board effect is local. Presentation is broadcast by the VRChat component,
and an implementation cooldown prevents rapid trigger re-entry.

## Deliberate divergence

OpenSlope optionally pops the pad decal, holds it briefly, and grows it back.
That consume animation is project-authored; the original game's pad lifecycle
is specified only in Trail Map. The collider remains separate and active, so
`BoostPadCooldown` is still the gameplay debounce.

## Configuration and verification

Relevant `ImportConfig` fields are `EmitBoostPads`,
`BoostPadSecondsPerUnit`, `BoostPadTriggerInflate`, `BoostPadCooldown`,
`BoostPadMinRideSpeed`, `BoostPadParticles`, the `BoostPadPop*` controls, and
the two cross clips.

Verify both walking and ridden crossings, max-window behavior, decal pairing,
authored bursts and cues, local board acceleration, and a safe no-visual
fallback for older bundles.
