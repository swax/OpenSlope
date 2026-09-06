# 022 — Ride model: authentic ground contact

Status: implemented in Slopesmith's fixed 60 Hz ride simulation. The
authoritative behavior is defined by [Trailmap: 300, 310, 320, 340] and the
shared `ride-v1.json` constants contract.

## Implementation

`src/app/ride/session.ts` owns the browser simulation and consumes the generated
TypeScript view of `Trailmap/specs/data/ride-v1.json`. It does not define a
second set of surface constants or contact rules. Analytic terrain queries,
fixed-step integration, Slopesmith input mapping, and editor/Test-mode state are
the implementation concerns recorded here and in [016 — Test ride](016-ride.md).

## Verification

The ride checks under `test/` assert observable stability, penetration bounds,
landing transitions, and fixed-step behavior against the shared contract.

Unity ports should consume the same constants contract and reproduce these
observable results before any feel-layer tuning. Port-specific integration
notes belong with the Unity implementation; behavioral changes first update
the corresponding Trailmap chapter and shared fixture.
