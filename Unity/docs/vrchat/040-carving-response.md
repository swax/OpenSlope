# Carving response implementation

Both Unity ride layers consume [Trailmap 330](../../../Trailmap/specs/330-carving.md).
`Slopesmith/tools/generate_ride_contract.py --unity` generates their surface columns
and scalar response methods. The C# methods share `ride_response.cs.txt`; changes to
that template must be regenerated for both layers.

The VRChat board applies forward and lateral resistance in the opening contact frame,
preserves the banked normal residual, integrates acceleration, then updates heading.
The Basis board now runs fixed simulation ticks and shares the response and heading
laws. Basis still uses its older position-snap/sink contact and an approximate normal
reaction for banking; it is not a complete compliant-contact reproduction.

## Explicit adaptations

Response statistics initialize to project-neutral values; no retail rider is imported.
Inspector fields permit controlled tuning of the normalized resistance statistics,
mode, preferred edge, supplied load ratio and skid-control state. The complete original
caller-state mapping is still open in the spec. Held/pad boost remains binary.

Low-grip assistance defaults off for new VRChat components; existing serialized scenes
may retain their chosen setting. Gaze steering, seat comfort, mounting, push/brake input,
contact acquisition and recovery remain platform adaptations. These differences must
be considered in a live comparison; scalar formula agreement alone is insufficient.

## Verification

`Snowknife.Tests/CarvingResponseTests.cs` compiles and executes the generated scalar
methods from both layers using minimal math shims and the shared synthetic numerical
fixtures. Their source and validation limits are documented in Trailmap 330's
research citation. This test does not compile the complete Udon/Basis scene or
substitute for Unity Play Mode tests. Slopesmith's ride-contract test guards the
production call sites.
