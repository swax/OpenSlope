# 039 — Concurrent editing

How several people edit one mountain at the same time without fighting over it. The design in two lines:
**the unit of concurrency is a register, not the document**, and ordinary editing is a free-for-all of
last-writer-wins assignments over those registers. Only topology — which vertices and quads exist — needs an
exclusive claim, and that claim is instantaneous and invisible.

`038` covers where the authoritative document lives and how participants reach it. This covers what they send
each other. It generalises `010`'s central insight — concurrent edits confined to disjoint parts need no merge
engine — from large manually claimed rectangles down to one register at a time, claimed automatically.

## Why the document is the wrong conflict domain

The project service holds one `revision` and one sha256 over the whole document. That is exactly one conflict
domain, so *any* two concurrent edits collide; a second writer's save is refused with HTTP 409 whether the two
people touched the same vertex or opposite ends of the mountain. Optimistic concurrency layered on top of a
single domain is the same refusal arriving more often.

Decomposing the document into independently versioned registers is what makes free-for-all editing correct
rather than lossy. Two people working on different parts then never conflict, because they never write the
same register.

| Domain | Register key | Value | Concurrency |
|---|---|---|---|
| Vertex position | vertex id | xyz | last write wins, arrival order |
| Edge handle | `"from>to"` | V3 offset | last write wins |
| Quad attributes | quad id | paint / tex / orient / twist, per field | last write wins per field |
| Props, lights, rails, gems, effect nodes | object id | the whole object | last write wins per object |
| Course path | the path | all knots | last write wins (see *Ordered data*) |
| Globals — sun, name, bake exposure, skybox, music | one each | value | last write wins |
| Which vertices and quads exist | — | — | **not a register** — see *Topology* |

## Stable identity is the prerequisite

`types.ts` defines vertex id `i` as living at `vertices[i*3 .. +2]`: **an id is an array index**. `quads`,
`edgeHandles`, `quadPaint`, `quadTex`, `quadOrient`, `quadTwist`, `freeEdges` and `tJunctions` all key off
those indices.

While that holds, any topology edit renumbers the world. Deleting quad 5 shifts every `quadPaint` key above
it, and an in-flight edit from someone else silently lands on a different face than the one they were looking
at. No versioning scheme survives that, so stable ids come first:

- Ids are assigned at creation as `installId:counter` — globally unique with no coordination.
- The document keeps an id→index map, rebuilt on load. Index becomes a rendering and serialization detail;
  nothing addressable ever refers to one.
- Deleted ids leave tombstones, so an edit that arrives for something already removed is discarded quietly
  instead of erroring or resurrecting geometry.

This reaches the document format, the export path and every keyed map, and it is the expensive part of the
whole feature — everything below is cheap by comparison. It is worth doing on its own merit regardless:
index-addressed keyed maps are fragile even for a single author running topology surgery (`017`).

**`edgeHandles` is the dangerous one, because it fails silently.** Its key is compound — two vertex ids as
`"from>to"` — and it is parsed by regex in two places, each of which skips anything it cannot read. A dropped
handle raises nothing: the edge falls back to its Bessel default and the terrain quietly changes shape. So a
change that widens ids without widening both parsers compiles, runs, and passes most of the mesh suite while
erasing every crease in the document on the first topology edit. Every id migration therefore asserts that
handle keys survive it by count, and the mesh suite carries a case that creases a vertex, deletes an
unrelated quad beneath it, and demands the crease come back byte-identical.

`Patches.json` stays ordinal on disk whatever the memory model does, because the engine consumes an ordered
patch array with no id column. The stable id belongs in `PatchName` and in the `Slopesmith.json` sidecar,
which is what lets a re-export after topology surgery still be diffed against its predecessor.

The reference mesh keeps its indices. It is rebuilt by position-dedup on every load and never edited, so its
numbering is legitimately ephemeral — ids there would be ceremony. What that costs is one generic parameter
on the selection and clipboard helpers the authored and reference surfaces share.

## Absolute values on the wire

Nearly every edit is an absolute assignment: a drag sets a position, painting sets a surface type, moving a
prop sets a transform. Assignments are idempotent, and last-writer-wins is the semantics people already
expect — whoever moved it most recently is who moved it.

The exceptions are the relative tools: smooth, extrude, nudge-by-delta, subdivide, the bulk crease operations.
**Those resolve client-side into the absolute values they produce, before anything is sent.** The wire carries
"these registers now hold these values", never "I performed this operation."

The consequence is the useful one: **ordinary edits cannot be rejected.** Last-writer-wins over an absolute
value always has a defined outcome, so there is no rejection dialog and no merge prompt in the normal path.
Refusal is reserved for structural impossibility — an edit naming a tombstoned id, or a topology claim that
lost a race.

Values coalesce per register at 20–30 Hz rather than per frame; the intermediate positions of a drag are
worthless once a later value exists. The existing 450 ms debounce stops being the transport and becomes the
checkpoint cadence: the server writes a revisioned snapshot every so many accepted changes, so the
durable format, the revision line and the autosave ring all keep working as they do now.

### The room is authoritative over the document, not over the file

A room holds the newest copy of a map *that this server knows about*, and those are not the same claim. An
import, a checkpoint restore or another save inside this process reaches the room through `onProjectWritten`
and it adopts them whole — that write replaced the mountain rather than assigning to it. A write from
somewhere else — a headless recipe, a second server, a restored backup — reaches the
file and no listener at all, and a room that went on holding its older document would write that over the
newer one under a higher revision number. That is a lost update the optimistic check cannot catch by itself,
because the room is the party that is behind.

Two defences, and they are independent on purpose:

- **The snapshot carries the revision the room last saw.** `saveRoomDocument` passes it as `baseRevision`, so
  a room that has fallen behind is REFUSED rather than allowed to overwrite. It then adopts what landed and
  bumps its sequence, which is the same thing it does for an in-process external write, and participants
  resync onto what is on disk instead of onto what the room was holding.
- **The projects folder is watched.** `watchProjectWrites` turns an outside write into the ordinary revision
  event, so rooms adopt and clients are told promptly rather than at the next snapshot — which on an idle map
  may never come. Only `project.json` is watched, because the document is written before it.

Losing the watch costs freshness and never correctness: the base revision still makes the outside write
conflict rather than disappear. Both are covered by `test/project-concurrency.test.ts`, which spawns a
real second process to write the file, because an in-process save announces itself and would prove nothing.

## Topology takes an implicit claim

Topology cannot be last-writer-wins. Two people subdividing the same quad concurrently do not produce a merge;
they produce duplicated, non-manifold geometry. But it does not need a lease either — nothing here is held,
managed, or released by hand.

When a topology tool commits, the client asks the server to compare-and-swap the affected id set,
applies the change locally at once, and reverts if it lost the race. One round trip, no interface, nothing to
remember. You never manage a claim; you occasionally see *"Jed just changed that — try again"*, and rarely,
because topology edits are a small fraction of drags and paints.

The alternative — serialising topology through the server and having it execute the operation with the pure
core — is tempting because `src/core/` is deterministic and fs-free. It is rejected: it puts a round trip in
front of every subdivide, and it makes core version skew between installs a correctness bug rather than a
cosmetic one. Either way, participants compare document and core versions when they join, and a mismatched
install joins read-only rather than writing geometry the others would evaluate differently.

## Drift detection and repair

Any change-streaming system drifts eventually, from bugs rather than from design. A cheap always-on detector
is what keeps a bug from becoming two people silently editing different mountains, and it belongs in the first
version rather than the last.

**Canonicalize before hashing.** The current hash is sha256 over `JSON.stringify`, which is sensitive to key
insertion order and float formatting. A document assembled by applying changes serializes differently from
the identical document read off disk, so an uncanonicalized check reports drift constantly and is quickly
ignored. Sorted keys and fixed float precision are the whole fix.

**Hash in two levels so repair is partial.** One hash over everything says *that* you diverged, not *where*,
and on a large mesh the only remedy is refetching the document. Hash per section instead — vertices in chunks
of about 1024, quad attributes, objects, globals — compare the roots, and on a mismatch descend one level and
refetch only the divergent chunk. Two levels is plenty, the section hashes maintain incrementally, and repair
becomes invisible instead of a reload.

Check on idle, on reconnect, and after any lost claim.

## Awareness is what actually prevents conflicts

Free-for-all editing works in practice because people can see each other. Live selections in each participant's
colour and a soft highlight on whatever someone is actively dragging avoid nearly every collision socially —
far cheaper than any locking scheme, and it is the mechanism doing the real work here. Cursor coordinates are
more private: only a tab sharing its screen publishes one, inside the disposable screen frame routed only to
its active observers. Presence is part of the concurrency design, not decoration on top of it.

That disposable awareness stream also carries the participant themselves. Every tab publishes one world-space
owner sample for the camera/body it currently owns: editor camera outside Play, walker on foot, rider while
mounted, and the real head plus both grip transforms when WebXR tracking has them. During Play the same sample
also carries the owner's equipment as an independent world object: `mounted`, `loose`, or `held`, with its own
transform, velocity and teleport epoch. A dismounted deck can therefore coast or lie where it stopped while its
owner walks elsewhere, and a VR deck follows the hand carrying or throwing it. The sample names the current
character-library id, so changing Rider model changes how that person appears to everybody else without making
avatar choice mountain data. Player objects live directly under the scene rather than under an editor overlay or
a Play root; this is what lets an editor see a rider descend and a rider see an editor standing at their camera.

The pose is absolute, disposable and map-scoped like the selection stream. A moving owner publishes through the existing
12.5 Hz latest-state window; a still owner reuses the same sample and sends only a one-second heartbeat. Fixed
samples are stamped in the server clock estimated from WebSocket ping round trips. A receiver ports the Unity
board follower rather than lerping packet-to-packet: it reconstructs low-passed/clamped acceleration and angular
delta, predicts `position + velocity·age + ½ acceleration·age²` (with the acceleration term capped at 0.5 s and
the velocity coast at 1.5 s), then critically damps the visible root toward that moving target. Rotation is
extrapolated and exponentially followed. Ordinary late corrections therefore bleed in without a forward/back
snap; a changed teleport epoch or a 50 m error cuts immediately. Equipment has a second follower governed by its
own pose and epoch, so new coast samples keep publishing even while the owner is still and equipment relocation
does not snap the avatar. Head and hands are kept body-local and eased onto the body follower, so network
correction never pulls the avatar's limbs away from its body.

For acknowledgement, each local change is *local*, *in flight*, or *landed*. Do not decorate the mesh with
that: the save disk beside Undo pulses while changes are moving, stays steady once they land, and turns amber
while reconnecting. A text panel appears only when interrupted work needs explanation or a decision —
"reconnecting — 47 changes held". Per-element indication earns its place only when someone else overrides something you
touched, where the element flashes in their colour.

One case needs deciding rather than defaulting: after a disconnection, replaying held changes means
overwriting whatever others did to exactly those registers while you were gone. That is right for thirty
seconds and wrong for an hour. Past a threshold, present a reconciliation summary instead of replaying blind.

## Undo

Whole-document snapshots cannot survive shared editing — restoring one would erase everyone else's work along
with your own. Undo becomes per-participant inverse assignments: record the registers you changed together
with their prior values, and undo re-asserts those priors as a fresh change rather than rolling back history.

It can therefore resurrect a value someone else has since changed. That is the accepted meaning of the
gesture — "put back what I had" — and it stays consistent because the re-assertion is an ordinary write like
any other.

## Ordered data: the course path

Knots are an ordered list of free 3D positions, not id-keyed members, so they do not decompose into registers
the way the mesh does (`010` names this). Treat the whole path as a single register to begin with: course
edits are infrequent and usually belong to whoever is shaping the run. If it becomes contended, give each
knot a stable id and a fractional order key, which makes insertion between two knots conflict-free.

## Building it by hand, or adopting Yjs

What this document describes is a map of last-writer-wins registers with a central sequencer — which is a
CRDT. `010`'s Tier 3 raises Yjs, and it is a real option here: `Y.Map` for vertices, quad attributes and
objects gives drift-freedom by construction, so the hashing above becomes unnecessary, and `Y.UndoManager`
scoped by origin is precisely the per-participant undo described above.

The cost is that `mountain.slope.json` must stay a plain JSON document the export pipeline reads, so a
projection between the document and the shared type is maintained either way, and topology still needs a
claim.

Build the register model by hand first. It is small, fully under our control, and stable ids are required for
either path. Keep the wire format register-shaped so Yjs can slot in behind it. Writing version vectors and
merge-repair logic is the signal to stop and adopt Yjs rather than reimplement it less well.

## Staged path

1. **Stable vertex and quad ids**, with tombstones. Blocks everything, and pays for itself single-user.
2. **Register decomposition and canonical two-level hashing**, still single-writer. Entirely testable offline,
   with no networking involved.
3. **Register sync and presence.** Free-for-all editing works at this point.
4. **Topology compare-and-swap claims.**
5. **Per-participant undo.**
6. **Incremental rebuild**, so a remote change updates the affected patches instead of re-tessellating and
   re-baking the mountain. `010` names this as a cost owed regardless of approach, and with several editors it
   is what will feel bad first.
