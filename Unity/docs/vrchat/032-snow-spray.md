# 032 — Snow Spray (Unity port)

The original board-effect buffers, emission gates, per-surface fields, motion,
sprites, and blend modes are specified in [Trailmap: 380-carve-effects]. This
document describes the current Unity/Udon realization and its deliberate
collapsing of that model.

## Runtime structure

`VRC/Riding/Board/RideableBoard.Fx.cs` drives two manually emitted Unity
`ParticleSystem`s from the board's contact state:

- `surfaceSpray` realizes the per-surface thrown fan and switches its material
  when the active surface class changes; and
- `cloud` batches the softer carve veil and powder cloud into one system.

Hard surfaces route through the existing grit/grind spark system. The wake is
a procedural mesh with a separate lifecycle, documented in
[030 — Carved Wake](030-carved-wake.md).

The systems run with rate-over-time disabled. Udon calls `Emit` explicitly,
keeps the systems alive only while needed, and clears them on dismount or
ejection. Counts derived from a fixed-tick rule are scaled by elapsed time so
the Unity presentation remains stable across render frame rates.

Remote boards reuse the same effect code. Their rendered transform delta,
synced deck bank, and a throttled local surface probe provide the input; range
gates bound the work and the Diagnostics board can disable other riders'
effects without touching the local rider.

## Implementation choices

- The canonical surface ring maps to `surfaceSpray`; its source values are
  currently represented in the Unity code rather than generated from a second
  documentation table.
- The port combines several soft source buffers into `cloud` because they can
  share one billboard material and one batched emit call.
- The rarely visible slip-streak buffer is omitted. This is a known fidelity
  gap, not evidence that the source effect is absent.
- Particle-bank assets are used when available; setup supplies project-owned
  fallback materials for an import without that bank.
- Material changes affect live particles because Unity exposes one renderer
  material for the system. Keep that engine limitation in mind when comparing
  a surface transition.

Any change to what the original buffers do belongs in Trailmap first. This
section should describe only how the Unity representation changes in response.

## Setup and tuning

`VRC/Editor/RideableBoardSetup.cs` creates the `BoardFX` children and wires the
board fields. Re-run `OpenSlope/Setup/Start Gate Boards` (or Setup All) after a
schema or prefab change.

The board inspector exposes a `snowParticles` master plus emission, alpha,
throw, cloud, powder, and distance-LOD controls. These are port controls; their
defaults may approximate the canonical behavior but do not redefine it.

## Verification

- Exercise snow, powder, ice, and hard-surface transitions without exceptions
  or stale materials.
- Confirm frame-rate-independent counts and no per-frame allocation on the
  local board.
- Confirm dismount/eject clears lingering systems.
- Check remote effects enter and leave their range gates cleanly.
- Compare visual fidelity to [Trailmap: 380-carve-effects], recording any
  mismatch here as a Unity divergence rather than copying the source rules.

## See also

[017 — Rideable Board](017-rideable-board.md),
[020 — Surface Physics](020-surface-physics.md),
[033 — Snow Sink](033-snow-sink.md), and
[014 — Particle Effects](../unity/014-particles.md).
