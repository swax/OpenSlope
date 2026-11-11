# Snowknife documentation

Documentation for disc/archive extraction, decoded intermediate assets, portable contracts, and the
engine-neutral bundle produced by `snowknife`.

Numbers are stable identifiers within the Snowknife documentation tree, not a continuous chapter count.
Gaps are intentional, and other components may reuse the same identifiers in their own trees.

## Import and convert a course

- [Snowknife README](../README.md) — introduction, downloads and first commands.
- [Import a course for browser play](browser-play.md) — checkout, build, import, and select a course in Slopesmith.
- [Import the SSX 3 mountain](ssx3-import.md) — sections, peaks and events of the SSX 3 world as Slopesmith references.
- [Repack an authored course](../REPACK.md) — build an ISO or SSX Mod Manager package from a Slopesmith export.
- [001 — CLI export pipeline](001-cli-export-pipeline.md)
- [034 — Bundle pipeline](034-bundle-pipeline.md)

## Assets and contracts

- [015 — Audio extraction](015-audio-extraction.md)
- [018 — Board assets](018-board-assets.md)
- [039 — Race-audio extraction](039-race-audio-extraction.md)
- [051 — Billboard screens](051-billboard-screens.md)
- [Effects interchange contract](contracts/effects-interchange.md)
- [Portable schemas](../Snowknife/schemas/README.md)
- [Repack technical reference](repack-technical-reference.md)

## Development

- [Developing Snowknife](development.md) — source setup, formatting and architecture.
- [Testing Snowknife](testing.md)
- [Releasing Snowknife](releases.md) — prebuilt downloads, matching source and GitHub Actions packaging.

Unity import and runtime behavior are documented in
[Unity](../../Unity/docs/README.md); interactive authoring behavior is documented in
[Slopesmith](../../Slopesmith/docs/). Facts about the retail game belong to
Trailmap (`../../Trailmap/specs/README.md` in the local Trailmap workspace), cited here with `[Trailmap: ...]` tags.
