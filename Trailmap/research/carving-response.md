# Carving response: findings and validation

spec:330-overview; spec:330-yaw; spec:330-alignment-basis; spec:330-yaw-vals;
spec:330-slip; spec:330-carve-force; spec:330-bank-force; spec:330-resistance;
spec:330-carve-formula; spec:330-lateral; spec:320-ground-gold.

## Source and method

This is owner-supplied provenance. The research used executable-based reverse engineering;
gameplay observations alone did not establish the response equations.

The analysis tool `tools/analysis/verify_carving_response.py` uses a separately
written scalar instruction interpreter to compare the two response functions
with analytical equations. Both sides concern the same executable; agreement
is numerical validation, not evidence of an independent or clean-room origin.
The public equations and their compact source citations live in spec 330.

The detailed local research record is preserved under the repository's ignored
`ResearchData/` directory. This public summary retains the method, findings and
limits without the register-level reconstruction.

## Findings

- **Forward resistance:** the three coefficients previously called a turn
  response describe acceleration along forward travel. The direction of the
  input and output projections establishes their role. Rider tuning, stance,
  charge, boost, load and powder depth affect the response.
- **Lateral resistance:** its speed dependence uses forward speed. The
  ordinary lean range has a multiplier of one. Boundary and sign cases
  distinguish this behavior from the earlier fitted lateral-decay model.
- **Heading:** the corrected model accounts for reverse travel and downhill
  alignment. Orientation uses the velocity after force integration; using the
  new orientation to resolve the same tick's resistance changes the behavior.
- **Banking and grounded load:** banking changes the normal response as well
  as lateral acceleration. The historical course-energy measurement describes
  a net result and cannot stand in for gravity once resistance is included.

These conclusions summarize executable analysis. The scalar checks below
validate forward and lateral resistance; heading, contact-frame construction,
banking and integration order were analyzed separately.

## Checks and limitations

The research recorded 3,000 deterministic input cases per response function,
covering velocity signs, zero, piecewise boundaries, all surface-type selectors,
powder depth, edge mismatch, modes, boost, charge and rider inputs. The maximum
relative/scaled discrepancy was approximately 3.1e-7 between float32 instruction
evaluation and float64 algebra.

Sixty cases supply the downstream fixtures. Their inputs, including surface
coefficients and rider statistics, are synthetic; expected accelerations come
from evaluating the locally supplied executable with those inputs. They are
numerical samples, not executable bytes or a dump of retail character settings.

The interpreter does not model exceptional or denormal PS2 floating-point
behavior. These checks are not a live PS2 run or a whole-controller comparison.
Existing gameplay telemetry is separate evidence, with its own coverage limits.

## Open questions

- Establish the runtime load-ratio input across riding conditions; do not
  infer that it is always one from a static initial value.
- Establish the skid-control input's scheduling and its coupling with charge
  and turning. Diagnostic slip is a different quantity.
- Verify rider attribute names against the front end. Until then, use names
  based on the term each attribute affects.
- Compare complete ground ticks in a live run, including input timing,
  contact acquisition, boost strength and the banked normal response.

## Reproduce

```text
python -B Trailmap/tools/analysis/verify_carving_response.py --elf <local-PAL-ELF>
```

The command requires a locally supplied executable and reports numerical
agreement and coverage. Add
`--write-cases Trailmap/specs/data/carving-response-cases-v1.json` to regenerate
the synthetic fixtures. It does not establish source authorization or legal
permission to obtain or distribute material.
