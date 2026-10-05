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
| Props, lights, rails, gems, screens, labels | object id | the whole object; edited a field at a time | last write wins per field (see *Objects*) |
| Models, particle volumes, prop lines, effect rows and nodes | object id | the whole object | last write wins per object |
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

A defined outcome still has to reach every replica. Two people writing one register at the same moment both
send before either hears the other; the room lands one and then the other, and relays each to the other
person. The one whose write landed second hears the first relayed *before* its own acknowledgement — the room
answers a socket in the order it sequences — and that relay carries the one value it must not write, because
the room already holds its own over it. So **a replica never lets an arriving value replace a write of its
own that is still unacknowledged**: the register keeps its value, and an object replaced whole gets the fields
it has in flight back on top, exactly as the room will hold them. Whatever it has changed and not yet sent is
sent first, which puts it under the same rule. Without this, the replica that won would hold the loser's value
until the drift check noticed — a defined outcome, reached late.

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

## Objects: whole to create, a field at a time to edit

An object is one register: it is what the document decomposes into, what a section hashes, and what creating,
replacing or deleting one assigns. Editing one that already exists is finer. A replica that finds a prop,
light, rail, gem, screen or label changed sends only the top-level fields that changed, as
`o/<family>.<field>/<id>` (`o/prop.pos/prop:a001`), each last-writer-wins on its own. Whole-object last-writer-wins
lost an edit whenever two people touched one object at once — one dragging a prop while another renamed it,
the later whole value carrying the other's stale field back — and that is the case this removes. The field
sits beside the family rather than after the id because ids may carry slashes and field names never do, so a
key parses one way.

Two rules keep it honest:

- **A field never creates an object.** A field arriving for an object the document does not hold is retired,
  discarded like any late edit for deleted geometry. A whole-object assignment would have re-created a prop
  somebody had just deleted; a field cannot, so a deletion stays deleted while somebody else is still
  dragging what was deleted.
- **Linked fields travel together.** Some fields describe one thing between them: a prop's asset is its
  `level`, `model` and `name` with its `group` and `specialKind`; a spot light's `kind` goes with its `dir` and
  `cone`; an attached screen's `prop` with its pose, and its `width` with its `height`. When any field of a
  group changes, the whole group is sent, so a group always lands whole from one writer and two people can
  never leave a prop showing one model under another's name.

The other families stay whole-object, each for a reason the record carries: a model's vertices and quads
index into each other, a particle volume is an imported native record, a prop line's settings and the props it
generated must come from one writer, and an effect row or node carries a type its payload is shaped by.

The decomposition, the digest and the stored document are unchanged — a field is a way of assigning part of a
register, not a register of its own — so a replica's shadow stays keyed by whole object and a field updates
the object it belongs to. The room credits fields individually, and a whole-object write supersedes the field
credits before it, so a scoped revert (`040`) of one person puts back the fields they last wrote and leaves
the fields somebody wrote after them standing.

## Topology takes an implicit claim

Topology cannot be last-writer-wins. Two people subdividing the same quad concurrently do not produce a merge;
they produce duplicated, non-manifold geometry. But it does not need a lease either — nothing here is held,
managed, or released by hand.

When a topology tool commits, the client asks the server to compare-and-swap the affected id set,
applies the change locally at once, and reverts if it lost the race. One round trip, no interface, nothing to
remember. You never manage a claim; you occasionally see *"Jed just changed that — try again"*, and rarely,
because topology edits are a small fraction of drags and paints.

Same-map snapshots use the ordinary frame renderer rather than the opening-map loader. They keep the camera,
mode, armed tools and surviving selections; object selections are remapped by stable id, and deleted geometry
is removed from selections, hidden sets and pinned cages. Frozen gestures are ended before indices change.
The existing scene stays visible until the synchronous geometry/picking replacement is ready. Updates within
one frame coalesce, and identical topology broadcasts, claim rejections, catch-ups and whole-document drift
repairs do not replace or redraw the map twice. A rejected local geometry edit produces one brief, non-modal
notice, even when its winning snapshot already arrived; successful edits and ordinary remote updates stay quiet.
A whole-document replacement — a drift repair, an outside write, a catch-up the log cannot reach — still
resets undo history: old snapshot entries cannot safely restore over another participant's work. Somebody
else's topology delta does not (see *Topology travels as a delta*). Initial loads and project switches keep
their progressive loading experience.

Terrain-only snapshots leave the Scene category launcher, Sound panel and Course controls intact, preserving
focus, expanded sections and an active board-sound preview. Preserved controls resolve the current document
when edited. Changed settings still refresh their own panels, and object inspectors that bind directly to
replaced objects are rebound. Prop assets already in memory need no load or second object redraw; newly loaded
models or group definitions request that redraw only after they arrive. Failed asset loads can be retried.

`test/sync-context.test.ts` covers identity preservation, deleted selections, frame coalescing and duplicate
conflict/drift recovery and rejection notices. `test/prop-sync.test.ts` covers cached, concurrent and failed
asset loads. `test/sync-browser.test.ts` follows real remote topology edits in an isolated browser and checks
camera, selection, mode, focus, audio-preview continuity, retained controls, loading overlays and render errors.

The alternative — serialising topology through the server and having it execute the operation with the pure
core — is tempting because `src/core/` is deterministic and fs-free. It is rejected: it puts a round trip in
front of every subdivide, and it makes core version skew between installs a correctness bug rather than a
cosmetic one. Either way, participants compare document and core versions when they join, and a mismatched
install joins read-only rather than writing geometry the others would evaluate differently.

### Topology travels as a delta, named by id

*Implemented; the design was revised through two rounds of review before the wire protocol changed.*

Until stable ids existed, a claim had to carry the claimant's whole document, because nothing smaller could
describe what a renumbering did. Four costs followed from that, and bandwidth was only the first:

- Every claim and every relay was the size of the mountain, whatever the operation touched.
- Every receiver digested the whole document twice to recognise an identical snapshot, rebuilt its shadow from
  scratch, and then swapped the scene.
- The room cleared its log on every topology change, because no log entry could describe one. Anybody who
  reconnected across a topology edit, however small, got the whole document back.
- A whole-document replacement reset every other participant's undo history, since nothing could say which
  of their entries survived it.

Stable ids, tombstones and id-keyed registers (stages 1 and 2) remove the reason for all four. A topology edit
can now be stated as which names went, which arrived, and how the survivors are wired. That statement is
relative to a structure every replica already agrees on, which the drift digest's topology section confirms.

| Message | Before | With deltas |
|---|---|---|
| `claim` (client → room) | `ids`, `at`, `document` | `ids`, `at`, `delta`, `changes` |
| `claim` (won) | `ok`, `at` | unchanged |
| `claim` (lost) | `document`, or an `error` instead of any answer | always a `claim`: `steps`, or `document` for a log gap or drift |
| `topology` (relay) | `document` | `delta`, `changes` |
| `caught-up` | `changes`, or `document` after any topology change | `steps`; `document` for a log gap or an outside write |

Measured on synthetic grids with `src/core/doc/topology-delta.ts`. Over real sockets, `test/sync.test.ts`
sees a delete claim of about 290 bytes against a 282 KB document.

| | 64×64 (4,225 vertices, 4,096 quads) | 141×141 (20,164 vertices, 19,881 quads) |
|---|---|---|
| Whole document | 407 KB | 2.04 MB |
| Delete one interior quad | 160 B | 163 B |
| Loop cut across the grid | 13.3 KB delta + 4.4 KB registers | 30.9 KB delta + 9.7 KB registers |
| Hash one delta result | 4.0 ms | 19.1 ms |
| One full digest (a receiver used to run two) | 12.2 ms | 47.8 ms |

#### What a delta says

```ts
/** One stretch of the new order: a run of the previous order kept as it stood, or one element written whole. */
type VertexRun = [from: number, count: number] | [id: string, x: number, y: number, z: number];
type QuadRun = [from: number, count: number] | [id: string, a: string, b: string, c: string, d: string];

interface TopologyDelta {
  vertices: VertexRun[];                             // the new vertex order
  quads: QuadRun[];                                  // the new quad order; written quads name corners by id
  freeEdges: [string, string][] | null;              // always carried
  tJunctions: { vertex: string; edge: [string, string]; t: number }[] | null;   // always carried
  tombstones?: { keep: number; add: string[] } | null;                         // when they changed
  nextId: number;
  structure: string;                                 // the topology-section hash the result must have
}
```

**Presence is part of the structure.** In every optional field, `null` means the result has no such field, `[]`
means it has an empty one, and an absent key means "as the base had it". The two are not interchangeable:
`structuralDocument` keeps an empty list and drops an absent one, so they hash differently, and real code
produces both — a rewrite writes `tJunctions: []`, `migrateMountain` deletes an empty free-edge list.

Removal is implicit: whatever the runs do not keep is gone. A separate `retired` list would state the same
fact a second time, and the two statements could disagree. What the document *records* about a removal, its
tombstones, is carried explicitly as the length of the old list that stands plus the names appended to it. An
ordinary operation keeps the whole list and appends. When undo brings names back, they are removed from the
list, which a delta states as the common prefix that stands plus the tail after it.

**Array order is part of the structure.** A delta cannot be just a set of additions and removals, because the
order of the arrays is data. Digest sections chunk vertices and quads by index, `Patches.json` is ordinal, and
two replicas holding the same ids in a different order are reported as drifted. So the new order is spelled
out as runs over the old one:

- `[from, count]` keeps a stretch of the previous order exactly as it stood.
- A run that starts with a string writes one element whole: a vertex with its position, or a quad with its
  four corners named by vertex id.

A quad that was rewired is written whole under its own id. A surviving vertex is never written; if it moved,
its position travels as a register like any other.

The runs are a general permutation encoding, so correctness does not depend on how an operation orders its
output. Size does. Most operations compact survivors in order and append what they mint, so a delete is two or
three runs and a loop cut is one run plus the new elements. A surface cut or an edge-crossing weld inserts each
new piece right after its source, which costs about two runs per cell it crosses. A retopology rebuilds both
arrays and degrades to one run per element.

That last case can make a claim *larger* than the document. Register keys name geometry by id, so they run
two or three times longer than the index keys a stored document uses. It is accepted: whole-surface rewrites
are rare, they are bounded by the socket's burst allowance, and a second claim format for them would be a
second path to keep correct.

Free edges and T-junctions are both short lists, so both are carried every time. That means neither list in
the result depends on the claimant's base holding exactly the room's copy. This matters most for T-junctions:
each replica re-seats them from its own geometry on every render, so a replica's list can legitimately differ
from the room's between claims (see *Not in scope*). Carrying the claimant's list makes the claimant's own
seating authoritative.

**A delta checks itself.** `structure` is the hash of the topology section the result must have, which is the
same section the drift digest compares. Whoever applies a delta (the room or a replica) recomputes that hash.
A mismatch means the delta was applied to a different base from the one it was written against. That is
drift, and it gets the drift answer: the whole document.

The hash covers ids, wiring, free edges, the T-node association, tombstones, `nextId`, `kind` and `version`. It
does not cover positions or channel values; the idle drift check still does. Beyond the hash, applying a delta
refuses malformed input instead of throwing:

- runs must be in range, and no element may be kept twice;
- a written quad has four corners and is a valid cell (`isValidCell`: a proper quad or an `[A,B,C,C]` wedge),
  and every corner names a vertex the result has;
- no id may appear twice among the vertices, or twice among the quads;
- no id may be both live and tombstoned;
- `nextId` may not go below the base's.

The sender hashes its own result, so the hash catches a wrong base, not a buggy claimant. The validations
above are what limit the damage a buggy claimant can do.

#### The claim and the room

The claim becomes `{ t: 'claim', ids, at, delta, changes, batch }`. The meaning of `ids` and `at` does not
change: the compare-and-swap covers the ids the operation consumed, checked against the last sequence the
claimant saw.

`changes` is the register difference the claimant's tick would have sent anyway: the same `differences()`
pass, read off the document after the operation. Two kinds of entry are left out because the delta already
says them:

- positions of the vertices the delta writes;
- clears of registers whose key names an id the delta removed.

That second rule is about *ids*, not edges. A rewrite that dissolves an edge between two surviving vertices
drops its crease, and that clear must travel. Otherwise the crease stays hidden on every receiver and comes
back if the edge ever forms again, which is the silent-crease failure described under stable identity.

The claim reply lists the keys of `changes` the room refused. A participant's `g/name` assignment is one of
them unless it manages the map, as in an ordinary batch.

The acceptance rule does not change. A claim loses if an id it names has been consumed since `at`, or if `at`
predates the last topology change or the retained log. Today the stale-base rule already implies the id rule,
since any id stamped after `at` means a topology change after `at`. The id comparison is kept because it is
what will decide claims once the stale-base rule can be relaxed (see *Not in scope*).

A claim that passes is applied to the room's own document instead of replacing it: first the delta (verifying
the structure hash), then the claimant's `changes`, **in arrival order and nothing more**. Some other
participant may have written a register after the claimant applied its operation but before the claim
arrived; the claim lands after that write and wins, as any later write does. That is last-writer-wins in
arrival order, the rule every ordinary assignment already follows.

The whole-document claim worked differently: it adopted the claimant's document and then replayed everything
since `at` over it, so the concurrent writer won. That replay was also wrong in a second way. It re-applied the
claimant's own batches over its claim, and it re-applied other people's writes over the claimant's own later
batches. Both moved the room to a value nobody held, and only a drift check repaired it.

Arrival order is exact only if every replica resolves concurrent writes the same way. That is the rule under
*Absolute values on the wire*: a replica never lets an arriving value replace a write of its own that is still
unacknowledged. A claim extends what counts as unacknowledged. The registers in an outstanding claim's
`changes` are in flight just as an unacknowledged batch's are. The same holds for relays applied with a delta,
for catch-up steps, and for a repair.

The rule has one exception. The room can refuse a write instead of landing it: a non-manager's rename, or a
value a register cannot hold. Then the room keeps the relayed value, so the replica remembers the last value it
skipped for each register it had in flight. If the acknowledgement lists that register as refused, the replica
applies the remembered value. A refused whole object also releases the skipped values of its fields. Once
nothing is in flight for a register, the replica forgets what it skipped for it.

The claim takes one sequence number, stamps its ids, forces a snapshot, and **enters the log** as
`{ at, delta, changes }`. In that entry, `changes` lists the claimant's assignments that moved the document.
The relay is the same entry: `{ t: 'topology', at, delta, changes, by }`.

**Every claim gets a `claim` answer.** A claim the room could not read used to be answered with `error`, and
the client then waited for a `claim` that never came: its outstanding claim never cleared, and the tick and the
drift check stopped for good. Now every claim is answered with a `claim`, including a malformed delta, too many
ids or changes, and a claim in the old whole-document form from a client that omits its versions. The
answer is `ok`, lost with `steps`, or lost with `document`. Claim `changes` have their own size limit, since a
subdivide can carry more inherited attributes than the ordinary batch limit of 4,096.

#### Catch-up keeps the log

Log entries no longer describe structures that stop existing, so a topology change no longer clears the log.
`caught-up` carries `steps`, which a replica applies in order:

- the registers landed since the reconnecting tab's sequence, merged into one step between topology entries;
- each topology entry as a step of its own.

The whole document is reserved for the two things a log cannot express:

- **A sequence older than the retained tail.**
- **A document replaced from outside the room**: an import, a restore, a write by another process. The room
  records the sequence at which it adopted such a write, and any catch-up from before it is answered with the
  document.

The log itself is kept across outside writes. Claims built before an outside write are settled by the
structure hash: if the write changed topology, the claim's base is not the room's and it is answered with the
document. If it did not, the claim applies like any other.

The `revision` push that announces an outside write carries no sequence, so a tab that adopted it still
reports the older sequence. On its next reconnect it is handed the same document once more. It installs that
copy without a redraw, because the document already matches. Putting a sequence on `revision` would avoid the
extra copy, but the tab that made the write is deliberately left out of that push, so it would still need
another route.

This closed an older gap. A tab that was away during an outside write used to be caught up with the registers
on either side of it, and kept the old mountain until the idle drift check noticed. A room that adopts a newer
revision off disk on a snapshot conflict still tells nobody until their idle check.

Between a reconnecting tab's `watch` and its `caught-up`, the room may relay changes that the catch-up then
repeats. They can also overtake it. A relay sequenced during the join's awaits arrives *before* the steps that
precede it. For registers the repeat is harmless, but a repeated delta does not apply cleanly.

So the client buffers relays for the map it is rejoining. When `caught-up` arrives, it applies the steps, then
any buffered relay sequenced after them. In practice there are none, because every buffered relay is covered
by the catch-up. A join that fails answers with `error` instead of `caught-up`. That ends the buffering and
applies the buffered relays in order, leaving the drift check to settle the rest.

A page opens a map at a sequence. The answers it opens one from carry `at` beside the document. Those are
`GET /api/projects/:id`, `GET /api/projects/current` and `POST /api/projects/:id/activate`:

- **While a room is open**, the document is the room's own copy and `at` is the room's head. The stored
  snapshot can lag the room by one write. A page that loaded it and joined at the head would hold less than the
  sequence it named, and its first topology claim would be built on a structure the room no longer has.
- **With no room open**, the document is the stored one and `at` is 0, where the room that opens from it
  starts.

The page watches from `at`, so its catch-up holds only what the room sequenced after the document it loaded.
Nothing it already holds is replayed over it. A page used to catch up from sequence 0 over a snapshot that
could already hold some of the log's topology steps, and each of those failed its hash and fell back to the
whole document. The page installs the document as received, like anything else the room sends (see
*Receivers*). A map this tab created, imported or duplicated is served without `at`, and joins at the head
as before.

A room counts from 0 each time it opens. A sequence beyond its head therefore came from an earlier room on
this map: a page that loaded just before that room closed, or a tab that outlived a restart. Nothing in this
room's log is measured from it, so that catch-up is the document.

#### Receivers

A replica applies a delta to its own live document, verifies the hash, and absorbs the `changes`, skipping
registers it has in flight. The result is a new document object, so the editor's same-map swap can still
compare before with after. That object shares no container that a register write mutates in place. The shadow
drops the registers of geometry that went and gains what arrived; nothing is rebuilt from scratch.

**A replica installs whatever the room sends exactly as it arrives**: a delta's result, or a whole document from
a repair, a catch-up, a rejection or a revision. The editor used to pass every synced document back through
`migrateMountain`. That function edits its argument in place: it deletes an empty free-edge list, reorients
and dedupes free edges, infers T-nodes when the list is absent, and drops records near an edge end. The
replica then took the edited copy as the room's structure. With deltas the room holds the claimant's output
as produced, which need not be a fixed point of that function, so a re-migrated replica would hold a base the
room does not have, and every claim it made would fail the hash. The server already normalises a document
once, when it reads one off disk or from a save; that is the only place it happens.

After a whole document is installed, any batch still in flight is re-written onto it. In-flight batches carry
their values, not only their keys. A batch still unacknowledged when the document arrives was sequenced after
the document was produced, so the room holds its values and the document does not.

Unsent local edits on surviving geometry survive by construction, because the delta is applied to the
document that holds them instead of replacing it. An unsent edit to a register named in the relay's `changes`
yields to it, as it would to an ordinary relay. An unsent edit on geometry that went retires quietly, as
today.

If a delta fails to apply or to verify, the replica asks the room for the topology section, which is the whole
document. That is the drift path, taken immediately instead of at the next idle check. Until the document
arrives the replica sends nothing and ignores further topology relays. If the socket drops before it arrives,
the replica asks again after catching up, and it asks again whenever it joins a room. A request sent just
after a project switch can reach the server before the new room is open and go unanswered.

Three states need a deliberate answer:

- **One of this replica's own claims is outstanding.** The room answers on one ordered socket, so any topology
  relay arriving now was sequenced ahead of that claim. The claim will lose on the stale-base rule, and its
  rejection will carry this relay among its steps. The relay is ignored here instead of being applied to a
  document it was not written against.
- **The socket drops while a claim is outstanding.** The answer is lost with the socket, and the room may or
  may not have taken the claim. The replica settles it with the whole document after it catches up.
- **A whole document is adopted from outside the register path while a claim is outstanding.** This happens on
  a `revision` push or a project switch. The claim's answer can no longer be applied to the document the
  replica holds, so when it comes the replica settles that claim with the whole document too. A drift repair
  that arrives while a claim is outstanding is ignored, because the claim's answer will settle the replica.
- **A local topology edit has not been claimed yet.** It happened inside the current 40 ms tick. The relay was
  sequenced first, so the local edit has lost. The replica rewinds to the structure and registers the room
  holds, applies the relay, and shows the same rejection notice a lost claim shows. This edit used to
  disappear silently. Unsent register edits from the same tick go with it, because they cannot be told
  apart from what the operation produced.

Topology claims wait while held changes await a reconnection decision, so a claim never leaves held values
out of the room.

#### The loser

A rejection carries `steps` instead of the room's document: everything sequenced since the loser's `at`,
including its own batches that were in flight when it claimed and the winner's topology. The loser kept what
the room held when it claimed (its structure and a copy of its shadow). It rebuilds that document and applies
the steps. It lands on the room's state without the whole mountain crossing the wire, and without passing
back through its own geometry.

Edits the loser made while its claim was outstanding are not lost with it, as long as they were register edits.
The tick held them back, so they are exactly the difference between its document and its shadow. They are
re-asserted onto the rebuilt document, where those naming geometry that no longer exists retire quietly, and
they are sent at once. A drift check taken before they were sent would find them missing from the room and
repair them away.

That only holds while the loser's structure is still the one it claimed. A second operation, or an undo, made
while the claim was outstanding has register effects that belong to a structure the rebuild discards: moved
corners, inherited paint, every value a restore puts back. Re-asserting those would half-apply an operation.
So if the structure moved after the claim, those edits are discarded with it, as in the rewind case.

The whole document is still the answer in two cases: a claim older than the retained log or than an outside
write, and a delta that failed to apply or verify at the room. In the second case the claimant's base was not
the room's, which is drift.

#### Undo

A remote topology change no longer resets anyone's undo history.

- **Register entries survive.** They name registers by stable id, so they outlast another author's
  renumbering the same way they outlast a remote register write. A re-assertion that names geometry which has
  since gone retires quietly.
- **Whole-document entries do not.** These are the entries a participant's own topology edits record.
  Restoring either side of one would put back a structure that no longer exists and erase the remote change.

So every structural arrival — a relay, a topology step in a catch-up, a lost claim, a rewind — drops
whole-document entries from both stacks, keeps every register entry, and rebases the history's baseline on the
new document. That happens synchronously with the swap, so the arrival can never be sealed into the next entry
as a local change.

A participant's own topology edits made before the arrival can therefore no longer be undone. That includes
one still inside the 350 ms commit debounce. It cannot be helped: neither side of such an entry exists any
more.

Undoing your own topology edit otherwise works as before: it restores the document on the other side of the
edit, and that restore claims like any other topology edit, now as a delta. Register entries now outlive
other people's topology changes, so a restore must not hand out an id twice, which it used to. Undoing an
operation rolled `nextId` back and forgot the names the operation minted without tombstoning them, so the next
operation minted the same names for different geometry. Somebody's surviving register entry, or an edit still
in flight, would then land on that new geometry.

So a restore keeps the document's identity moving forward:

- `nextId` stays at the higher of the current and the restored value;
- every name the restore removes is tombstoned;
- every name it brings back is no longer tombstoned.

The room refuses a delta that lowers `nextId`. This holds alone as well as shared, and it is what `nextId`
already promises: no id is ever handed out twice. Surviving tombstones keep their order and newly retired names
follow them, so the delta's prefix stays long. A list the rule empties is removed, not left as `[]`, as
`retireMeshIds` already does.

After a restore, the history measures its baseline off the document the restore produced, not the snapshot it
asked for. Otherwise the carried-forward identity would look like a fresh edit at the next commit, and that
phantom entry would wipe the redo stack.

Undoing a topology edit still re-asserts every register value in the restored document, so it can erase
register work other people did in the meantime. The follow-up is to make topology undo an inverse delta plus
register priors.

#### Compatibility

The claim, the relay, the rejection and the catch-up all change shape, so `CORE_VERSION` moves.

- **An older bundle on a newer server** joins read-only on the version mismatch, so it never claims. It would
  not understand a delta, so the room sends that session the whole document as its topology relay, and catches
  it up with the whole document whenever a topology step is in range.
- **A newer bundle on an older server** still accepts a whole-document `topology` relay and adopts it as
  today.

#### Not in scope

- **Merging concurrent topology.** With deltas, the room could in principle apply a claim built on an older
  structure when its ids are disjoint from everything consumed since. Two things prevent that today:
  - Every install mints from the document's shared `nextId` under the constant `INSTALL_ID = 'local'`, so two
    concurrent claimants mint the same names.
  - The claim set covers what an operation consumed or rewired, but not the existing corners a newly added
    quad attaches to. Two extrusions off the same edge would name disjoint ids, and both would win.

  The stale-base rule stays until ids are minted per participant and the claim also covers what an operation
  attaches to.
- **Holding a topology edit made while disconnected.** It is not sent, and the drift repair reverts it on
  reconnect, as today.
- **Telling connected tabs about a snapshot-conflict adoption.** They learn at their next idle drift check, as
  today.
- **T-node drift between claims.** A replica's render can drop a T-node record, for instance when a vertex is
  dragged to the end of its host edge, and the tick takes that as derived bookkeeping, as it does today. The
  room keeps the old association until somebody's next claim carries the new one. In the meantime an idle
  drift check can fetch the whole document. Claiming such changes was considered and set aside, because every
  replica re-seats the same arrival:
  - the replicas race N identical claims;
  - each claim advances the stale-base sequence, so real claims lose with a false notice;
  - each arrival counts as structural, so it drops everyone's topology undo.

  A fix needs a non-structural update that takes no stale-base sequence.
- **A sequence from an earlier room that the next room has already passed.** A page that loads a map at
  sequence N just before its room closes may join a reopened room that is already past N. It is then caught
  up from N in the new room's log and misses that room's first N changes until its idle drift check. A
  topology step among them fails its hash and falls back to the document. A page that loads the stored map
  before any room opens, and then misses an outside write that replaces it, is left behind the same way.
  Telling rooms apart needs an identity per room carried with the sequence.
- **Rendering a topology change incrementally.** A renumbering still re-tessellates. Stage 6 owns that.

#### Tests

"Identical" below means the same canonical structure (including T-node `t`) and the same registers. It does
not mean byte-identical JSON: crease keys enumerate in a different order on each side, and an emptied channel
is `{}` on one side and absent on the other. The digest ignores both.

- `test/sync-delta.test.ts` (new, core): round-trips deltas across the real operations, and the result must be
  identical to the operated document, including the crease case above. Operations covered: delete, loop cut,
  cell edge insert, flip, dissolve, weld, edge rip, append, an edge-dissolving rewrite, and an undo that
  resurrects names. It also checks run compactness, refusal of a delta written against another base,
  malformed input, and identity carried forward across a restore.
- `test/room-digest.test.ts`: the lazy-digest equalities hold across a delta claim. The log survives the
  claim, catch-up across it returns steps, and an outside write turns an earlier catch-up into the document.
- `test/sync.test.ts`:
  - bounds a claim's size in bytes against the document's;
  - has a loser revert from steps, with no document;
  - catches up a third replica that reconnects across a topology edit, from the log;
  - forces a structural divergence to show the resync;
  - writes a register the claimant also sets in its claim, and shows that every replica ends on the room's
    value;
  - opens a page while the stored snapshot lags the room by a topology edit. The page is handed the room's
    document and sequence, joins with nothing replayed, and claims at once without a whole-document answer.
    A page naming a sequence beyond the room's head is caught up with the document.
- `test/sync-context.test.ts`: the relay ignored during an outstanding claim, the single rejection notice, the
  rewind of an unclaimed local edit, a claim outstanding across a disconnect, the skip of an in-flight register
  and its refused exception, and history keeping register entries while dropping whole-document entries
  without leaving a phantom entry behind a restore.
- `test/sync-browser.test.ts`: a local edit made before a remote topology change can still be undone after it.

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
becomes invisible instead of a reload. The room maintains them lazily: an accepted batch only records which
registers it moved, and their sections are rehashed when a replica asks — which it does only once idle — so
landing an edit costs microseconds rather than a chunk's rehash at every participant's coalescing rate.

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

A held change is not always one the room lacks. A batch can land and lose only its acknowledgement with the
socket, and the replica cannot tell that from a batch that never arrived. Replaying it would overwrite whatever
somebody wrote over it since, which breaks last-writer-wins in arrival order. So the room remembers the highest
batch it has answered from each replica, and `caught-up` reports it. A held value from a batch at or below that
number is already in the room, and the replica lets it go before deciding what to replay or summarise.

- **The replica is one page load, not the tab.** The tab id outlives a reload and is copied into a duplicated
  tab, but batch numbers restart with each page. The socket therefore names the register sync's own `replica`.
- **The number is read when the `watch` arrives,** before the room has answered anything sent on the new
  socket. One socket is answered in order, so the highest batch answered vouches for earlier batches from the
  same socket and nothing more.
- **The record lives with the open room.** If the room closed while the replica was away, it has forgotten,
  and the held batch is replayed as before.

`test/sync.test.ts` loses an acknowledgement on a real socket and checks that a later write survives the
reconnection. It also checks that a page reloaded under the same tab id still replays its own lost batch.

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
4. **Topology compare-and-swap claims**, carried as id-based deltas.
5. **Per-participant undo.**
6. **Incremental rebuild**, so a remote change updates the affected patches instead of re-tessellating and
   re-baking the mountain. `010` names this as a cost owed regardless of approach, and with several editors it
   is what will feel bad first.
