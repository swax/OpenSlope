# Authoring original courses with Slopesmith

Slopesmith is the interactive authoring front end for original snowboard courses. It edits a Bézier-patch
mountain with a course path, paint, props, lights, rails, gems, and portable effects, then exports the result
as a `Maps/<NAME>` folder for the shared bundle pipeline.

Guide numbers belong to the shared [Slopesmith documentation sequence](../README.md); this folder does
not start a separate numbering sequence.

## Start here

- [001 — Design](../001-design.md) — goals and course-grammar thesis.
- [002 — Course model](../002-course-model.md) — control mesh and patch derivation.
- [003 — Export contract](../003-export-contract.md) — authored map folder, coordinate spaces, and conventions.
- [004 — Sculpt mode](../004-sculpt-mode.md) — terrain and course editing.
- [005 — Texture paint](../005-texture-paint.md) — visual tiles and surface response.
- [012 — Props](../012-props.md), [013 — Sources](../013-lights.md), and
  [014 — Rails, motion paths, and gems](../014-rails.md) — scene authoring.
- [026 — Effects editor](../026-effects-editor.md) — portable graph editing.

## Practical build guides

- [065 — Building a course, one terrain feature at a time](065-course-building.md) — curved track strips,
  feature-led patch layouts, shape-preserving refinement, smooth mixed-resolution joins, intersecting
  quilts, original assets, lighting, API authoring and browser review.
- [067 — Original particle sprites](067-custom-particle-sprites.md) — project-scoped fog and effect textures,
  with browser and export limitations.

## Design and validation

- [064 — Terrain vocabulary](064-terrain-vocabulary.md) — reusable landforms, riding sequences,
  layered routes and material boundaries for original work.
- [066 — A scored build loop](066-scored-build-loop.md) — build, measure, inspect and ride a
  bounded feature; record geometry, asset and gameplay results separately.

## Downstream pipeline

Export invokes `snowknife gltf` and produces the engine-neutral bundle. Project bootstrap, staging, Unity
import, and ride setup are documented by
[Unity's authored-map pipeline](../../../Unity/docs/authoring/00-pipeline.md). The canonical portable
effects contract and SSF round-trip commands are documented by
[Snowknife's effects contract](../../../Snowknife/docs/contracts/effects-interchange.md).
