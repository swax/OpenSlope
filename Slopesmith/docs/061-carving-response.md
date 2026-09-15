# Carving response implementation

The ride consumes the recovered response laws in [Trailmap 330](../../Trailmap/specs/330-carving.md)
and the shared surface contract. `ride-response.ts` owns the scalar forward resistance,
lateral resistance, heading closure and banked normal response. `physics.ts` applies
resistance in the opening contact frame, integrates acceleration, then updates heading.
The measured net course-energy gain is retained as historical calibration data, not
applied as an additional reduced gravity after restoring the resistance.

## Port choices and limits

The default response tuning uses neutral normalized statistics, the ordinary mode,
matching edge preference, a load ratio of one, and zero skid-control state. They are
project defaults, not a reproduced retail character configuration. `responseTuning`
can override them for controlled comparisons. The complete original load-ratio and
skid-control input paths remain unresolved in the spec. The port's held/pad boost is
binary; original meter-dependent strength is not reconstructed by this change.

Low-grip assistance is opt-in. It still modifies tilt, self-centering and lateral
recovery when enabled; disabling it no longer claims that every other controller
detail is exactly original. VR gaze reference and seat comfort, switch lead selection,
braking input, contact redirection safeguards and terrain acquisition remain port
adaptations. Contact/input scheduling still needs a live comparison on identical
course segments before claiming whole-controller equivalence.

## Verification

`test/carving-response.test.ts` executes the scalar helpers against synthetic
reference fixtures from the spec data, plus heading and force invariants.
The fixtures contain generated inputs and numerical outputs; their source and
validation limits are documented in Trailmap 330's research citation.
`ride-telemetry.test.ts` checks the production integration; the full ride suite checks
standstill, landing, switch behavior and AI tracking. The response helpers use SI units.
Regenerate the surface contract with `python tools/generate_ride_contract.py --unity`.
The source methodology is documented in Trailmap; downstream code cites the spec.
