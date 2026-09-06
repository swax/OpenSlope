# Local research data

This directory holds durable, machine-local research evidence that should survive cleanup of the
repository's disposable `temp/` workspace. Everything below this README is ignored by Git, and a fresh
checkout finds the directory empty.

Generated ISOs, map exports, extracted archives, build trees, and verification output remain disposable
and do not belong here. Back up this directory separately if the evidence matters to ongoing work.

## Provenance

Anything a maintainer keeps here is derived from their own copy of the game — recorded from a running
emulator session, or computed from geometry that disc already contains. It is intermediate research
material: the evidence a conclusion was drawn from, kept so the conclusion can be re-checked later. It is
theirs to use and not theirs to redistribute, which is why `.gitignore` versions this README and nothing
beneath it.

A committed document or spec that cites a path under `ResearchData/` is recording where a number came
from. It is not a promise that the file ships with a clone. Readers working from their own copy of the
game can regenerate the cited evidence:

- `telemetry/` — the probe workflow in `Trailmap/research/rider-telemetry.md`; <!-- repo-hygiene: allow[dirty-path] -- naming where a reader regenerates this directory is this file's entire job; the workflow is a research note by nature and has no clean-spec equivalent to point at instead -->
- `effects/` — the `ssf-canary` workflow in `Trailmap/research/effects-authoring-p0.md`; <!-- repo-hygiene: allow[dirty-path] -- same: a regeneration instruction, not a consumer of the artifact -->
- `trails/` — re-run `Slopesmith/tools/mountain-study/trail-selection.ts` and `trail-benchmark.ts` over
  centerlines picked as `Slopesmith/docs/023-spline-loft-track.md` describes; both write to `temp/`.
