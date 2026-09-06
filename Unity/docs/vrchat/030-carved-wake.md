# 030 — Carved Wake (Unity port)

The original wake's gates, topology, per-surface parameters, blend, and fade
behavior are specified in [Trailmap: 380-carve-effects]. This document covers
the procedural mesh built by `RideableBoard.Wake.cs` and the
`OpenSlope/WakeRibbon` overlay shader.

The rideable board ([017](017-rideable-board.md)) drives several cosmetic layers off its ride state — the snow
spray ([032](032-snow-spray.md)), the glide/carve audio, and this wake. Those
systems share ride state but have independent rendering and lifetime policy.

## Why a procedural mesh, not a `TrailRenderer`

A Unity `TrailRenderer` flickered the ribbon away when brief contact loss caused
`Clear()` to discard the whole streak. The port therefore owns a FIFO of
cross-sections and rebuilds a mesh, using a lenient presentation contact gate so
short physics-probe gaps do not erase an otherwise continuous trail.

## How the port works (`RideableBoard.Wake.cs`)

A fixed-size FIFO ring of up to `WK_MAX` (56) **cross-sections**, each a perpendicular row of `WK_CROSS` (20)
vertices laid on the snow at the board's trailing edge:

- **World-space mesh.** The `Wake` child is pinned to world origin/identity every frame, so the mesh's local verts
  *are* world coordinates — the ribbon stays put on the hill while the board moves over it.
- **Lay gate** (`UpdateWakeTrail`): lay a new cross-section when on a wake-bearing snow surface
  (`WakeSurfaceDepth > 0`), within `wakeGroundReach` of the ground (lenient — not the strict grounded band), above
  `trailMinSpeed`, and **not buried** — on deep powder the deck sinks *below* the surface (there's no groove to
  draw, just a plowed plume), so the `_sinkDepth > hoverHeight` under-snow gate stops it (see
  [033 — Snow Sink](033-snow-sink.md)). Cross-sections drop every `wakePointSpacing`; a jump past `wakeRestartGap`
  starts a fresh run; a brief gate flicker stitches back onto the same run.
- **Perpendicular rows + a leading-cap triangle.** Each row is laid across the *motion* direction (full width), so
  the ribbon body is rectangular; the crabbing board is reconciled at the head by a transient forward triangle
  poking to the leading silhouette. Row width = the board footprint projected onto the across-motion axis (deck
  aligned → thin, sideways → widest), scaled by the avatar-fit `_riderScale`.
- **Per-surface presentation** (`WakeSurfaceDepth`) maps the probed surface id
  to the port's line thickness or disables the wake. Compare the mapping to
  [Trailmap: 380-carve-effects] rather than documenting a second canonical table here.
- **Colour, not geometry.** The twin-groove + age fade live in
  **per-vertex colour**, overlay-blended onto the snow by `OpenSlope/WakeRibbon` (a `DstColor·SrcColor` blend), so the
  groove darkens (`wakeDarken`) and a **sun-direction split** (`wakeSunSplit`) lightens the sun-facing wall /
  darkens the away wall — and because it's an overlay it auto-matches the snow's own shade. The sun azimuth is the
  same data-derived world sun as the prop lighting ([010](../unity/010-object-lighting.md)).

## Knobs

`trailEnabled`, `trailMinSpeed`, `wakeLife` (age-out, ~`0.9 s` like the engine), `wakeGroundReach` (the lenient
contact band), `wakePointSpacing` / `wakeRestartGap`, `trailWidthMin` / `trailWidthMax` (board width/length → the
swept ribbon width), `trailHeight` (lift above the snow to beat z-fighting), `trailTailOffset`, `wakeDarken`,
`wakeSunSplit`. The `Wake` child + mesh filter + `WakeRibbon` material are built by `RideableBoardSetup` — re-run
**`OpenSlope/Setup/Start Gate Boards`** to give an old board the wake.

## Known divergence

The port uses one `wakeLife` for the whole ribbon and a shorter fixed ring than
the canonical model. Per-surface persistence is not implemented. Treat
`wakeLife` and `wakePointSpacing` as Unity tuning, and use
[Trailmap: 380-carve-effects] when closing the fidelity gap.

## See also

[017 — Rideable Board](017-rideable-board.md) (the board this trails behind), [020 — Surface
Physics](020-surface-physics.md) (the per-`SurfaceType` table the wake depth/width mirror), [032 — Snow
Spray](032-snow-spray.md) (the sibling carve FX, sharing `IsSnowSurface`), [033 — Snow Sink](033-snow-sink.md)
(the under-snow gate that stops the wake once the deck is buried), [010 — Object Lighting](../unity/010-object-lighting.md)
(the world sun the groove's light/shadow split uses). The functional behaviour is specified in [Trailmap: 380-carve-effects].
