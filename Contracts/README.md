# Shared interoperability contracts

These Apache-2.0 data files are tracked inputs to the public implementations and tests:

- `ride-v1.json`: shared rider constants and response parameters for Slopesmith and Unity.
- `external-sound-banks-v1.json`: fixed bank/file identifiers for Slopesmith, Snowknife and Native.
- `particle-sprites-v1.json`: short sprite registration identifiers, retaining registration order and duplicates.
- `celestial-spokes-v1.json`: Slopesmith's original 32-spoke sun-beam pattern, shared as first-party presentation data.
- `world-layout-v1.json`: course-slot identifiers and relative scalar-record field offsets for portable sun/sky metadata recovery.
- `carving-response-cases-v1.json`: independent reference cases checked by TypeScript and C# tests.

From the repository root, validate the generated views with:

```text
python Slopesmith/tools/generate_ride_contract.py --unity --check
python Slopesmith/tools/generate_audio_bank_catalog.py --check
```

`Trailmap/` is an optional, ignored local research workspace and is absent from fresh
clones. Existing `[Trailmap: ...]` citations identify that local evidence; they are
provenance labels, not links to files shipped by this repository. Required builds,
tests, and publication checks use the tracked contracts and `tools/hygiene/`.
The local emulator harness can regenerate its audio view with the audio generator's
`--local-autotest` flag. Local specification checks remain available in Trailmap.

Optionally check the particle registration identifiers against a user-supplied image:

```text
python tools/check-particle-contract.py <user-supplied-iso>
```

This compares short functional identifiers and preserves duplicate registration slots;
it does not export addresses, executable code or media. Slopesmith's public preview API
and Native's consumers validate against the same tracked registry.
