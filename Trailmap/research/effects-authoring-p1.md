# Effects authoring P1 — portable graph contract

Date: 2026-07-14. Contract: `openslope-effects` version 1. Target adapter: PAL
SSX Tricky (`SLES-50545`).

P1 turns the P0 binary proof into a shared authoring boundary. The same
`Effects.json` can now be emitted by Snowknife, retained and exported by
Slopesmith, accepted by the Unity importer, and compiled by Snowknife back to an
SSF for the verified BIG/ISO installation path.

## Gate status

| Gate | Status | Result |
|---|---|---|
| Versioned contract | pass | JSON Schema and matching TypeScript model define `openslope-effects` v1 |
| Stable identity | pass | graphs, functions, slots, nodes, shared properties, instance bindings and resources use string IDs; cross-table numeric indices are absent from the portable form |
| Complete SSF coverage | pass | header, graph/function nodes, all seven slot circumstances, shared properties, bindings, physics, collision groups and spline records are represented |
| Snowknife export/import | pass | both directions reconstruct an SSF and require complete semantic equality after excluding layout-only offsets/alignment |
| Slopesmith retention/export | pass | the mountain document preserves an attached Effects document through save/load and emits it as `Effects.json` in a level export |
| Unity handoff | pass (contract) | `snowknife unity` carries the file; the Unity importer validates kind/version/table shape before scene mutation |
| Unity behavior compiler | deferred to P3 | P1 imports the source document but does not yet translate nodes into Unity components |
| Integrated ISO button | deferred to P4 | today the explicit `effects-import` + `ssf-install-iso` commands use the proven path |

## Corpus proof

Every PAL retail level SSF completed this sequence:

```text
SSF -> Effects.json -> reconstructed SSF -> binary save -> binary reload
```

The adapter compared complete semantic snapshots, not just counts. All 12
levels passed, covering 9,067 graph/function nodes and 25,470 instance bindings.
The full GARI document covers 306 graphs, 20 functions, 700 nodes, 531 shared
properties and 3,393 instance bindings; its rebuilt SSF retained the original
370,532-byte length and independently passed `ssf-check`.

A small checked-in authored fixture additionally proves that a document with
non-integral timer-emitter U9/U10/U11 values can compile without needing a
retail source SSF.

## Contract decisions

- IDs are authoritative; array order only requests the next compact binary
  index assignment. `originalIndex` is optional provenance.
- Known SSF fields retain their native names and exact JSON values under each
  node's `payload`. This keeps partially understood types lossless while the UI
  layers semantic names over them.
- `semanticType` uses original engine property names where available and may be
  refined from proven graph context. In particular, main types 3/9 are virtual
  controls whose operation depends on the property node installed by the slot;
  the raw opcode/command remains authoritative when that receiver is ambiguous.
- Numeric references are removed from payloads and represented by stable IDs in
  `references`. Snowknife resolves them only at binary compilation.
- `ObjectProperties` stays visibly shared. Editing one instance safely still
  requires a copy-on-write property operation in P2.
- Physics, collision groups and SSF spline records remain part of the document
  even if the first editor UI treats them as advanced/raw resources.
- Tool-specific metadata belongs under `extensions`. Snowknife ignores it for
  ISO compilation.
- Snowknife uses strict payload deserialization: a field unsupported by the
  current binary adapter is an error, never silently discarded.

The canonical schema is
`Snowknife/Snowknife/schemas/authoring/openslope-effects-v1.schema.json`; the human-facing
workflow is `Snowknife/docs/contracts/effects-interchange.md`.

## Commands

```powershell
dotnet run --project Snowknife/Snowknife/Snowknife.csproj -c Debug -- effects-export level.ssf Effects.json --level GARI
dotnet run --project Snowknife/Snowknife/Snowknife.csproj -c Debug -- effects-check Effects.json
dotnet run --project Snowknife/Snowknife/Snowknife.csproj -c Debug -- effects-import Effects.json rebuilt.ssf
```

A normal `snowknife import` run now performs the first command automatically.

## Boundary to later phases

P1 supplies programmatic import, validation, persistence and export. P2 adds the
Slopesmith graph browser, node inspector, object-binding operations, templates
and undoable copy-on-write edits. P3 interprets supported nodes into Unity
behavior and preview components. P4 makes the verified SSF/BIG/ISO compilation
a production Slopesmith packaging workflow.
