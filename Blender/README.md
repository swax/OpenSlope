# Blender

This directory contains the earliest exploratory tooling in OpenSlope. The
reverse-engineering work began here: loading extracted levels into Blender,
testing coordinate and geometry assumptions, understanding the game's bicubic
terrain, and proving out editing round trips. Those experiments later informed
Trailmap, Snowknife, Slopesmith, and Unity.

The current tools cover:

- previewing extracted levels and glTF bundles in Blender;
- importing and exporting bundle sidecar data;
- experimenting with Bézier/NURBS terrain authoring; and
- documenting Blender-to-Snowknife prop-remodeling workflows.

Use [`open-level.ps1`](open-level.ps1) to inspect an extracted OBJ level or
[`open-bundle.ps1`](open-bundle.ps1) to inspect a Snowknife glTF bundle.

## Documentation

Numbers are stable identifiers within this documentation tree; gaps, if introduced, do not imply that files
are missing.

- [001 — NURBS terrain authoring and analytic trail carving](docs/001-nurbs-terrain-authoring.md)
- [002 — Prop remodel round-trip](docs/002-prop-remodel-roundtrip.md)

## License

The repository-authored software, documentation, and other material in this
directory are licensed under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
