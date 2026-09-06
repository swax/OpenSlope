# Effects authoring P2 — Slopesmith editor

P2 builds a production-shaped editor over the P1 portable effects contract. It
does not introduce a private graph format or bypass the P0-tested SSF writer.

## Implemented

- Effects mode between Props and Play (`6`; Play is `7`).
- Import/export/new `Effects.json` documents.
- Ordered graph/function and node-list editing: create, rename, reorder,
  duplicate, and delete with fresh stable IDs and safe reference cleanup.
- Particle/wait/sound/speed-boost/trick-boost templates.
- Semantic node inspector plus exact raw node JSON with whole-document
  validation before apply.
- Structural, stable-reference, level-object attachment, and emitter-range
  diagnostics.
- Stable authored prop IDs and portable `extensions.slopesmith.attachments`
  records linking props to native effect slots/circumstances.
- Existing document snapshot undo/redo and save/load/export participation.
- Timer-emitter spatial handle backed by the proven `U9/U10/U11` local point.
  Conversion covers engine centimetres/Z-up/X chirality plus prop yaw/scale.
- Mountain/Reference source switch. The loaded reference graph joins back to
  native props through `Instances.json.EffectSlotIndex` and slot
  `originalIndex`, with attachment focus, semantic/raw inspection, bounded
  particle/pulse preview, and persistent/proximity firing during a reference
  Play run. Pre-P1 extracted folders use a visibly labelled, read-only
  `SSFLogic.json` compatibility view rather than pretending to be lossless.

## Verification

The effects test covers P1 preservation plus P2 templates, stable-ID
duplication, strict raw replacement, attachment validation, emitter spatial
round-trip, deletion reference cleanup, legacy-reference conversion, and the
native instance/slot/circumstance join. TypeScript, the production Vite
build, and the broader Slopesmith pipeline check remain green.

## Remaining boundary

The portable prop attachment is sufficient for Slopesmith save/export and Unity
consumption, but P1 `effects-import` only compiles SSF. Original-game object
attachment also requires writing `EffectSlotIndex` in the final level instance
table after authored prop packing. That packaging join remains P4; P2 keeps all
information it needs stable and explicit.
