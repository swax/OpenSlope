# Effects interchange — P1 contract

`Effects.json` is the portable source document shared by Snowknife, Slopesmith,
and the Unity importer, and it is the **only** SSF effect source the gltf-time
bundlers read. Every bundler reaches it through one shared, cached, read-only
view (`Bundle/SsfLogic.cs`), which normalizes the document's stable IDs into
native SSF indices — so bundle code speaks the native dialect (`EffectSlots`,
`EffectHeaders`, `Functions`, `PhysicsHeaders`) over this contract's storage.

`SSFLogic.json` is a separate file serving one job: the **repack/compile
chain**. Extraction writes it, authored slots are appended into the work copy,
and `SSFGenerate` compiles it back into a `.ssf`. It is not an interchange
document and nothing reads it for bundling — it omits the SSF object-property
and instance-binding tables and uses raw array indices as identity. Moving the
repack write side onto this contract needs a stable-ID document merge (both
sides allocate `graph:0000`-style ids) coupled to pbd instance packing order.

The canonical schema is
[`schemas/authoring/openslope-effects-v1.schema.json`](../../Snowknife/schemas/authoring/openslope-effects-v1.schema.json).
Version 1 targets the PAL PS2 build of SSX Tricky while carrying explicit target
metadata so later adapters do not have to guess.

Graph meaning and runtime circumstance behavior come from
[Trailmap: 150-logic, 180-particles-data, 230-level-ssf,
370-world-interaction]. This interchange contract carries those specified
meanings between tools; the spec chapters carry the reverse-engineering
provenance and remain the authority when behavior is corrected.

## Data flow

```text
retail/canary .ssf
    -> snowknife effects-export
    -> Effects.json
       -> Slopesmith save / level export
       -> Unity import (P1 validates; P3 compiles behavior)
       -> snowknife effects-import
    -> rebuilt .ssf
    -> snowknife ssf-install-iso / later integrated repack
```

`snowknife import` writes `Effects.json` automatically alongside the legacy
intermediates. `snowknife unity` copies it because it is a Unity source artifact,
not a glTF-only intermediate.

`snowknife gltf` hard-depends on it: present, it is validated against the
schema below; absent, the run prints an explicit warning naming the fix and
produces a **feature-less** bundle (no movers, pads, triggers, or emitters).
A bare authored export with no effects at all is still legal, which is why this
is a warning and not an error — but for a retail map extraction, a missing
`Effects.json` means the map lost every SSF-driven feature, so re-run
`snowknife import` (or `snowknife effects-export`) rather than shipping the result.

## Identity and ordering

Every graph, function, slot, shared property, instance binding, physics record,
collision-model group, spline, and node has a stable string `id`. References use
those IDs or `null`; numeric SSF indices never cross a table boundary in the
portable document.

Array order is still meaningful: it is the requested compact order for the
next SSF export. Moving an item does not require fixing every caller because the
references continue to name its ID. `originalIndex` is optional provenance for
diffs and diagnostics, never identity.

## Losslessness boundary

Known node data stays under `payload` with the SSX field names and exact JSON
number values. Cross-table integer fields are removed from that payload and
promoted to stable `references`; Snowknife reconstructs the integers only when
compiling the ordered tables to SSF. Physics and collision resources remain in
the document because they are part of the SSF, even though an effects editor may
initially show them as advanced/raw data.

Native field order is confined to that lossless payload boundary. In particular,
timer-emitter colour quartets `U33..U48` remain SSF-native **A,R,G,B** in
`payload`, while every named API, semantic editor control, bundle `ColorStops`
tuple, and renderer uses **R,G,B,A**. Snowknife and Slopesmith each perform the
rotation in one adapter; consumers must not reinterpret the numbered fields.

`extensions` is the only home for non-SSF authoring metadata such as Unity
preview overrides. Snowknife ignores it when compiling the binary. Engine data
must not be moved into an extension.

`semanticType` is the canonical engine-neutral name for one native node opcode;
it is not the binary authority and it does not describe when the graph runs.
The schema owns its vocabulary, while Snowknife and Slopesmith additionally
verify that a supplied name is compatible with `mainType` plus its subtype or
command. It may be omitted when the meaning is unknown. Experimental meanings
must use an explicit lowercase `x-...` namespace rather than introducing an
alias that another consumer might mistake for a standard name.

Keep these four identities separate across every tool:

| Concern | Portable authority | Example |
|---|---|---|
| What the node does | `semanticType` | `particle.timer` |
| Native round-trip identity | `mainType` + `payload` | main type 2, subtype 0 |
| When its graph runs | `slot.circumstances` | `persistent` or `collision` |
| How long it emits | timer payload emission fields | `EmissionWindow` / native `U2` |

Thus `particle.timer` in a persistent graph is a looping/ambient emitter, while
the same canonical node in a collision graph is a collision burst. Slopesmith's
`timer-emitter` is only an internal template ID, and Unity's `Emitters` versus
trigger/pad layer placement is derived from the graph circumstance; neither is
another interchange semantic name.

Snowknife uses the engine's original property-node identities
(`property.roller`, `property.uv-scroll`, `property.mesh-animation`,
`property.anim-delta`, and so on) and behavior-specific names for subtype-5
actions. Main types 3 and 9 are virtual controls, so their useful label is
inferred from the property node installed by the owning slot—for example
`material.texture-frame`, `counter.decrement`, or `animation.delta-grant`. If
that receiver cannot be proved, the label remains `node.control.command-N`.
Import/repack always retains the raw main type, subtype, command and value.

The current SSF reader/writer understands every node found in the 12-level PAL
corpus. The schema permits arbitrary payload fields so future reader support can
add newly discovered fields without a format-version bump. The current Snowknife
adapter deserializes payloads strictly and refuses any field it cannot preserve;
it never silently drops one. Truly unknown binary opcodes still require reader
support before they can be recovered from a binary SSF—the JSON contract cannot
restore bytes the binary parser never read.

## Commands

```powershell
snowknife effects-export level.ssf Effects.json --level <courseSlot>
snowknife effects-check Effects.json
snowknife effects-import Effects.json rebuilt.ssf
snowknife ssf-install-iso clean.iso <courseSlot> rebuilt.ssf output.iso
```

Both export and import pass through a semantic SSF comparison. `effects-check`
validates IDs/references and performs an in-memory compile followed by a real
SSF save/reload proof.

Slopesmith's TypeScript contract lives in
`src/core/effects/document.ts`. An `EffectsDocument` can be attached to the
mountain document; save/load preserves it, and level export writes the same
validated `Effects.json`. The P2 Effects mode provides graph/function and node
list editing, semantic and exact raw-field inspectors, templates/duplication,
validation, prop-slot attachments, undo/redo, and an emitter-origin gizmo
without changing this interchange boundary.

Slopesmith prop attachments live under
`extensions.slopesmith.attachments`. Their target is a stable authored prop ID,
not its current array index. This makes the join portable to Unity and lets P4
resolve the final packed object index when writing `Instances.json`.
Snowknife's P1 SSF compiler correctly ignores this editor metadata: an SSF stores
the graph tables, while the object-to-slot join is in the level instance data.

Placed props use a second stable-ID join,
`extensions.slopesmith.nativeCollisions`. Each placement entry carries the exact editable
`mode`, `playerCollision`, `responseMass`, `playerBounce`, `bounceAmount`, the exact
instance transform, and an optional `{ level, body, instance }` sphere-tree
donor. `bakedGroups` resolves it to the final packed instance just like an
attachment. The ISO compiler preserves all fields without applying a universal
“solid” conversion; a mode-3 donor is accepted only when its level equals the
repack target because `PhysicsIndex` is target-pool-local. This is deliberately
an instance/contact interchange seam rather than a new SSF graph field. The collision lab uses the same public
profile as ordinary placement; effects and sounds diagnose incompatible profiles rather than mutating them.
