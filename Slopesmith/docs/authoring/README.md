# Authoring original courses with Slopesmith

Slopesmith is the interactive authoring front end for original snowboard courses. It edits a Bézier-patch
mountain with a course path, paint, props, lights, rails, gems, and portable effects, then exports the result
as a `Maps/<NAME>` folder for the shared bundle pipeline.

## Start here

- [001 — Design](../001-design.md) — goals and course-grammar thesis.
- [002 — Course model](../002-course-model.md) — control mesh and patch derivation.
- [003 — Export contract](../003-export-contract.md) — authored map folder, coordinate spaces, and conventions.
- [004 — Sculpt mode](../004-sculpt-mode.md) — terrain and course editing.
- [005 — Texture paint](../005-texture-paint.md) — visual tiles and surface response.
- [012 — Props](../012-props.md), [013 — Sources](../013-lights.md), and
  [014 — Rails, motion paths, and gems](../014-rails.md) — scene authoring.
- [026 — Effects editor](../026-effects-editor.md) — portable graph editing.

## Data-driven design studies

- [Terrain vocabulary](vocabulary/01-terrain-vocabulary.md) decomposes a shipped mountain into reusable
  course and terrain grammar for original work.
- [Scored build loop](vocabulary/02-scored-build-loop.md) describes the code-driven author → measure → revise
  workflow built on Slopesmith's headless core.

## Downstream pipeline

Export invokes `snowknife gltf` and produces the engine-neutral bundle. Project bootstrap, staging, Unity
import, and ride setup are documented by
[Unity's authored-map pipeline](../../../Unity/docs/authoring/00-pipeline.md). The canonical portable
effects contract and SSF round-trip commands are documented by
[Snowknife's effects contract](../../../Snowknife/docs/contracts/effects-interchange.md).
