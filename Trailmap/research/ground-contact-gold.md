# Ground-contact gold measurements

This note records the measured constraints used to calibrate and validate the
Slopesmith ground-contact port. They are port evidence, not proof of the
retail helper's internal formula or solver.

## Grounded energy fit

On the matched Snowdream approach, retail speed rises from 14.32 m/s to
20.49 m/s over a 22.74 m vertical drop without boost. The energy fit is

`(20.49^2 - 14.32^2) / (2 * 22.74) = 4.73 m/s^2`.

That is the effective **contact-plane** calibration, not a complete grounded
world-down force. It combines unrecovered retail terms and must not be cited as
a recovered engine constant.

## Normal-load correction from Gari ice

The keyboard-only capture
`../../ResearchData/telemetry/gari-ice-turn-retail-keyboard-20260720-160415.jsonl`
separates input scaling from physics. Across 77 near-neutral Type-5 samples,
the recovered three-zone helper averages 13.77 m/s² while the contact sits near
the 5 mm bog floor. Type 5's authored `A/100` is 13.5093 m/s². During 136
full-lean samples the response averages 17.16 m/s² as the curved path loads the
contact further.

The old port treated Snowdream's 4.73 m/s² energy fit as the whole world-down
load. On flat ice that fixes the response near 4.73 and yields only about
4.1 m/s² of banked lateral acceleration. The deterministic corrected fixture
uses the row load and measures 11.63 m/s² / 48.6 deg/s on flat ice; retail's
loaded Gari turns reach 61.8–100.0 deg/s. The port now keeps 4.73 only in the
contact-plane projection and uses surface `A/100` in the normal projection.

## Probe-constrained patch solve

Using triangle barycentrics only as a seed placed the smooth-patch contact
0.86-1.30 m sideways from the actual probe on the second and third marked
Snowdream lips, retaining contact to -73.5 and -64.9 degrees. Solving
`patch(u,v) = probeRay(t)` moved those takeoffs to -34.0 and -33.6 degrees.

Across 525 post-fix analytic probes, the solved point's distance from the
probe was 11 nm median, 9.1 micrometres p99, and 9.7 micrometres maximum.

The run and interpretation are summarized for the editor implementation in
`../../Slopesmith/docs/016-ride.md`; this note is the research-side citation
for the functional constraints.
