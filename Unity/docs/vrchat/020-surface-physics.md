# 020 — Surface Physics (Unity port)

The original surface-response table and the behavior of every field are
specified in [Trailmap: 310-surface-response]. Ground contact, carving, speed,
and contact effects are specified in [Trailmap: 320-ground-contact],
[Trailmap: 330-carving], [Trailmap: 360-speed-and-boost], and
[Trailmap: 380-carve-effects]. This document records only how the Unity board
consumes that contract.

## Generated contract

`Trailmap/specs/data/ride-v1.json` is the shared machine-readable source for
the measured constants. `Slopesmith/tools/generate_ride_contract.py` generates:

- `Unity/VRC/Riding/Board/RideableBoard.Contract.Generated.cs` for the Udon board;
- `Unity/Basis/Riding/BasisBoard.Contract.Generated.cs` for Basis; and
- `Slopesmith/src/app/ride/ride-contract.generated.ts` for the browser ride.

Do not copy surface rows or motion constants into this document or handwritten
C# files. Change the Trailmap prose and JSON fixture together, regenerate both
views, and run the contract checks.

## Unity consumption

`VRC/Riding/Board/RideableBoard.Surface.cs` indexes the generated `_rideSurf*`
arrays by the surface type found by the active terrain or prop probe. It owns
the Unity/Udon implementation of the response algorithm, not the field
definitions.

| Generated field family | Unity consumer |
|---|---|
| contact scale and damping | grounded normal response |
| bog depth, sink budget, and ground threshold | contact-field slew, ground/air transition, and bounded correction |
| visual lift | rendered deck offset |
| speed target and response multiplier | grounded cruise drive |
| forward resistance coefficients | signed forward acceleration |
| carve drag and tilt | lateral resistance and banked contact response |

The board integrates on its fixed tick in `RideableBoard.cs`. Probe results
update the active surface row; short probe misses retain the previous row so
analytic seam recovery can bridge them. Rail contact supplies the rail's own
surface row through `RideableBoard.Rail.cs`.

## Unity-specific policy and divergences

- An out-of-range surface id falls back to the generated generic row instead
  of indexing invalid data.
- The free-roam port treats reset terrain as a race/path rule and uses the
  generic response row for riding it. The original reset behavior remains
  defined by [Trailmap: 390-pickups-and-race].
- Forward and lateral acceleration use the recovered scalar response laws, with
  project-neutral rider inputs exposed for controlled tuning. The fitted lateral
  bite conversion has been removed; see [040](040-carving-response.md).
- On steep wall contacts the port removes the ground-only pushout cap to avoid
  tunneling because it does not reproduce the original type-6/type-10 wipeout
  backstop. Analytic seam recovery is documented in
  [021 — Analytic Terrain Contact](../021-smooth-contact-normal.md).

These are implementation choices. They must stay labelled as divergences and
must not be fed back into the Trailmap description of the original behavior.

## Verification

Regenerate the views with `python Slopesmith/tools/generate_ride_contract.py --unity`, then
run the Slopesmith ride-contract test and the Unity ride tests. Unity telemetry
should additionally cover:

- surface-id changes across terrain and rideable props;
- stable contact and bounded penetration on representative hard and soft
  surfaces;
- transition to and from air without a stale-row jump;
- rail entry preserving the rail surface; and
- the explicitly documented reset and wall-contact divergences.

## See also

[017 — Rideable Board](017-rideable-board.md) owns the vehicle and update loop;
[030 — Carved Wake](030-carved-wake.md), [032 — Snow Spray](032-snow-spray.md),
and [033 — Snow Sink](033-snow-sink.md) own Unity presentation of the contact
state; [009 — Collision](../009-collision.md) owns surface collider import.
