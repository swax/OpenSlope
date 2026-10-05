# Carving response implementation

The ride consumes the recovered response laws in [Trailmap 330](../../Trailmap/specs/330-carving.md)
and the shared surface contract. `ride-response.ts` owns the scalar forward resistance,
lateral resistance, heading closure and banked normal response. `physics.ts` applies
resistance in the opening contact frame, integrates acceleration, then updates heading.
The measured net course-energy gain is retained as historical calibration data, not
applied as an additional reduced gravity after restoring the resistance.

## Where the numbers live

The `response` section of [ride-v1.json](../../Trailmap/specs/data/ride-v1.json)
names the resistance, heading, lean, bank and contact coefficients. Each group
records its spec reference, provenance and units. Surface-dependent values remain
in `surfaces`; these coefficients are shared across surfaces or selected by mode.

The generator emits `src/app/ride/ride-response.generated.ts` and constants in both
Unity response partials. Change values in the JSON, formulas in `ride-response.ts`
and the C# template, then run `python tools/generate_ride_contract.py --unity`.
The generated constants retain the previous numeric precision and the formulas
retain their arithmetic order. For example, the yaw cap is radians **per tick**,
and lateral speed knots are already in m/s; do not convert them again.

`defaults` identifies project-selected neutral inputs; `guards` identifies
dimensioned numerical floors; `units` identifies conversion factors. None of
these is presented as a recovered rider attribute. Formula identities (zero,
unity, signs) and the spec's mode/surface IDs remain inline. The shared guards
apply to these response paths, not unrelated collision or rendering tolerances.

## Port choices and limits

The default response tuning uses neutral normalized statistics, the ordinary mode,
matching edge preference, a load ratio of one, and zero skid-control state. They are
project defaults, not a reproduced retail character configuration. `responseTuning`
can override them for controlled comparisons. The complete original load-ratio and
skid-control input paths remain unresolved in the spec. The port's held/pad boost is
binary; original meter-dependent strength is not reconstructed by this change.

Low-grip assistance is opt-in. It still modifies tilt, self-centering and lateral
recovery when enabled; disabling it no longer claims that every other controller
detail is exactly original. VR gaze input and seat comfort, switch lead selection,
braking input, contact redirection safeguards and terrain acquisition remain port
adaptations. Contact/input scheduling still needs a live comparison on identical
course segments before claiming whole-controller equivalence.

Grounded WebXR gaze feeds the same normalized steer input as desktop controls. The
heading closure stays referenced to actual travel for both, so looking into a curve
does not add a second yaw target and scrub extra speed. Manual stick ownership also
removes gaze from the entire ground carve. Air/rail aiming and headset seat comfort
are separate. `head-steer.test.ts` compares velocity, position and board heading for
equivalent head/stick inputs across snow, powder, ice, slopes, switch and reversals.

Slopesmith also supplies a low-speed cruise recovery floor after collisions or skids.
It fades from full alignment at 0.5 m/s to zero at the 2 m/s switch-latch threshold;
the ordinary alignment gate still wins whenever it supplies more drive. Holding
brake suppresses this added assistance. Surface targets, resistance, rider factors
and the alignment gate at normal riding speeds are unchanged. This recovery policy
is a port choice, not a claim about retail behavior. `flat-ground-ride.test.ts` covers
slow sideways/backward recovery on snow, ice and rock in regular and switch stance,
plus brake suppression and preservation of faster skids and switch transitions.

## Verification

`test/carving-response.test.ts` executes the scalar helpers against synthetic
reference fixtures from the spec data, plus heading and force invariants.
The fixtures contain generated inputs and numerical outputs; their source and
validation limits are documented in Trailmap 330's research citation.
`ride-telemetry.test.ts` checks the production integration; the full ride suite checks
standstill, landing, switch behavior and AI tracking. The response helpers use SI units.
Regenerate the surface contract with `python tools/generate_ride_contract.py --unity`.
The source methodology is documented in Trailmap; downstream code cites the spec.
