# Trailmap research index

Research notes preserve measurements, derivations, negative results, implementation histories, and open leads
behind the clean behavioral specification. They are public provenance and working context, not normative
chapters. The corresponding conclusions belong in the [specification](../specs/README.md).

## Research process and maintenance

- [Reverse-engineering hygiene](re-hygiene.md) — clean-body/provenance policy and enforcement.
- [Extracted data](extracted-data.md) — facts measured directly from course and configuration files.
- [Analysis tooling](tooling.md) — `ssx_analyze.py` command cookbook.
- [Autotest probe provenance](autotest-probe-provenance.md) — provenance requirements for emulator probes.
- [Implementation follow-ups](implementation-follow-ups.md) — specification findings not yet adopted downstream.
- [Open questions](open-questions.md) — unresolved leads and decisive next checks.

## Riding, collision, and scoring

- [Board model](board-model.md) — absorbed portable board-state and response study.
- [Rider telemetry](rider-telemetry.md) — frame-fenced PINE capture and annotation.
- [Ground-contact gold measurements](ground-contact-gold.md)
- [Ground-contact implementation history](ground-contact-implementation-history.md)
- [Air rotation, gravity, and boost](air-rotation-and-boost.md)
- [Prop collision semantics](prop-collision-semantics.md)
- [Rail spline SSF flags](rail-spline-ssf-flags.md)
- [Scoring](scoring.md)

## Rendering and world presentation

- [Boost board trail](boost-trail.md)
- [CrowdBox runtime](crowd-box.md)
- [Emitter sprite index](emitter-sprite-index.md)
- [Kicker animation investigation](kicker-animation-investigation.md)
- [Colored flares and light glints](light-flares.md)
- [Material alpha mode](material-alpha-flag.md)
- [Board snow-spray render pipeline](spray-render-pipeline.md)
- [Board snow-spray systems](spray-systems.md)
- [Sun god-rays](sun-godrays.md)
- [Texture-flip runtime](texture-flip-runtime.md)
- [Texture-flip timing](texture-flip-timing.md)

## Effects authoring

- [P0 — Write path and runtime risk gates](effects-authoring-p0.md)
- [P1 — Portable graph contract](effects-authoring-p1.md)
- [P2 — Slopesmith editor](effects-authoring-p2.md)
- [SSF effects semantic-name census](effects-semantic-names.md)

## Executable tools and series studies

- [Noclip/fly-mode patch](noclip-fly-mode.md)
- [Series comparison](series-comparison.md) — SSX (2000), SSX 3, and On Tour against the Tricky baseline.

Bulk analysis artifacts remain local and gitignored. See the parent [Trailmap README](../README.md#local-only-inputs)
and [`ResearchData/README.md`](../../ResearchData/README.md) for storage and regeneration boundaries.
