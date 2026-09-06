# 033 — Snow Sink (Unity port)

Physical sink, the soft-contact zones, field slew, bounded correction, and
visual lift are specified in [Trailmap: 310-surface-response] and
[Trailmap: 320-ground-contact]. This document records the Unity realization;
it intentionally carries no duplicate equations or per-surface values.

## Implementation

`RideableBoard.Surface.cs` reads the generated contact arrays described in
[020 — Surface Physics](020-surface-physics.md). `RideableBoard.cs` owns the
fixed-tick integration and keeps live bog, budget, and lift values so a surface
change can ease rather than replace them abruptly.

The physical board position carries the contact response. The rendered board
pivot applies the generated visual-lift value along the smoothed contact up
vector. The station transform remains on the physical position so the avatar
and board share one collision state.

Mount, respawn, and course reset seed the live contact fields from the local
surface. This avoids applying a stale or zero budget on the first grounded
tick. The wake implementation may use the resulting penetration state as a
presentation gate; that dependency is documented in
[030 — Carved Wake](030-carved-wake.md).

## Verification

- Re-run the ride-contract generator before testing changed values.
- Verify that mount and reset begin without a one-frame correction spike.
- Cross a hard/soft boundary and confirm the live fields move smoothly.
- Confirm the rendered lift does not move the collision/station transform.
- Exercise landing transients without adding a separate animation-only plunge.

## See also

[017 — Rideable Board](017-rideable-board.md) owns the overall update loop;
[021 — Analytic Terrain Contact](../021-smooth-contact-normal.md) supplies the
point and normal; [032 — Snow Spray](032-snow-spray.md) is the sibling contact
effect.
