# Slopesmith ideas

Staged proposals and superseded assessments. Nothing here is a product contract; a design that ships moves up
into [`docs/`](../README.md) under the same number. Where each one stands:

- [007 — Flow-aligned ribbons](007-flow-ribbons.md) — the run as its own patch ribbon stitched into a cut
  corridor; staged R1–R4, unbuilt. [023](../023-spline-loft-track.md)'s loft took the additive route instead and
  lists 007's derived corridor cut as a non-goal.
- [010 — Collaborative editing](010-collaborative-editing.md) — the original assessment of the codebase against
  multi-client editing; superseded by [038](../038-hosted-sessions.md) and [039](../039-concurrent-editing.md),
  kept for its reasoning.
- [019 — Rips, lips & holes](019-rips.md) — open-boundary editing on [017](../017-topology-surgery.md)'s op
  contract. The rip landed (`src/core/mesh/ops/edge-rip.ts`); stitch, hole cut, and the lip UI have not.
- [021 — Fidelity & performance lint](021-fidelity-lint.md) — a live HUD and preflight section over the measured
  reference envelope; unbuilt (`src/core/fidelity.ts` does not exist).
- [042 — Whole-mountain relayout with owned quantization](042-relayout-quantization.md) — taking over QuadWild's
  quantization stage. M1's prescribed seams landed (`src/core/mesh/retopology/prescribe.ts`); the sizing field,
  product wiring, and the open questions remain.
