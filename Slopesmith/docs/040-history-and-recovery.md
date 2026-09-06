# 040 — History and recovery

Going back when something goes wrong. A **checkpoint** is a whole document, taken at strategic moments,
thinned exponentially with age and pruned automatically. Any checkpoint can be opened read-only beside the
live map for comparison, restoring one makes it the newest revision rather than rewinding to it, and any part
of the map can be put back to one without disturbing the rest.

`038` holds the sessions this history belongs to; `039` describes the changes that flow between checkpoints.

Two properties are worth stating up front because they are not obvious from the feature list:

- **Why a checkpoint was taken is part of its file name**, so pruning reads it off disk. A lost sidecar costs
  notes, never a checkpoint.
- **Pinned checkpoints skip bucketing entirely**, so a restore or a revert neither thins anything nor consumes
  a band's slot. Recovery does not compete with the ring for its own depth.

## Checkpoints are whole documents

A delta or chunk-addressed store would be smaller per checkpoint and is deliberately not what this does. A
whole document restores by copying a file, opens in every tool that already reads a `.slope.json` — the
importer, the export path, a text editor — and has no history format of its own that can develop bugs or need
migrating. When recovery matters, the simplest thing that can possibly work is worth real disk.

The cost is storage, and two things make it affordable:

- **Compression.** `COLLISION_LAB`'s document is 409,796 bytes and gzips to 62,176 — better than 6:1, because
  pretty-printed arrays of floats are extremely redundant. Checkpoints are written `.slope.json.gz`, using the
  `node:zlib` already in the runtime.
- **Thinning**, below, which is what keeps depth from being linear in time.

It is also what makes everything in *Comparison* and *Reverting part of a map* free. Both are computed from a
pair of whole documents through `039`'s register decomposition, so neither needs a stored diff, an authorship
log or a history format — a checkpoint on disk plus the live document is the whole input.

## When a checkpoint is taken

Not per save. A checkpoint is taken when something meaningful concludes:

- **On a timer with accumulated change** — five minutes of wall clock *and* four kilobytes of changed
  document, so an idle session records nothing and a busy one records steadily.
- **Named, by any editor.** *"before I redid the finish area"* — the one people actually reach for.
- **Forced** before a restore, before a scoped revert, before a bulk destructive operation, when the last
  writer disconnects, and on publish.

Each checkpoint records the revision, the time, and the **set of members who contributed to it** — in a shared
session a checkpoint spans many people's work, so a single author field would be a lie. Named checkpoints also
record who named them and the note.

## Thinning

Keep density where it is useful and let it fall away with age:

| Age | Kept |
|---|---|
| Last hour | every checkpoint |
| Last day | one per hour |
| Last week | one per day |
| Older | one per week, to a bounded count |
| Named, pre-restore, pre-revert | never pruned |

The schedule and the checkpoint cadence are both tunable, with a total byte budget per project as the
backstop — a project that blows the budget drops its oldest unnamed checkpoints first, and says so rather than
silently thinning further than configured.

## Looking at one

Five actions, from a **File → History** panel listing time, contributors, note, size, and what has changed
since:

- **Compare** — open the checkpoint beside the live mountain.
- **Preview** — open the checkpoint read-only without touching the project.
- **Restore** — make it the newest revision.
- **Fork** — save it as a new project, which `createProject` already does.
- **Revert** — put back only the part of the map you name.

Compare reuses the authored-map reference layer from `036` rather than growing a diff viewer: a checkpoint
tessellates into the same patch records an extracted level's `Patches.json` carries, loads into the reference
slot, and then-and-now sit in one viewport with the placement controls that already exist. It costs almost
nothing because the machinery is built, and it is a far better answer to *"what changed?"* than reading a JSON
diff. Only shape and surface type travel — the tile a face wears lives in a level's art folder, and a
checkpoint is drawn as a ghost of the mountain rather than a second textured one.

## What changed, in words

Side by side says *where*; the register model says *what*. Two documents are compared register by register —
canonically, so a difference nobody authored is no difference — and the result is read back as counts: how
many corners moved, how many faces were repainted, retextured or reshaped, which creases changed, which
objects appeared, vanished or were edited by family, whether the run moved, and exactly which globals differ.
That is what tells someone which checkpoint they actually want, and it costs one comparison rather than a
download per checkpoint.

Corners and faces the two documents do not both carry are counted off the id lists rather than off the
registers, because a face nobody painted has no register at all — counting only what the registers hold would
report a freshly subdivided quilt as no change. Those counts are topology, and no assignment puts them back;
see below.

## Restoring is forward-only

Restoring checkpoint r12 writes a **new** revision — r48, whose content equals r12. The counter never rewinds.

This is not bookkeeping fussiness. Every client holds an expectation about where the revision line is, and
under `039` the register versions are derived from it; rewinding the counter would make a client holding r47
accept stale writes as fresh. Forward-only restore keeps a rollback indistinguishable from any other edit as
far as the sync layer is concerned, which is exactly what makes it safe.

A restore is itself checkpointed before it happens, so a bad restore is undone by another restore. It is
broadcast to everyone in the session and named in the feed — *"Alice restored the checkpoint from 14:02"* —
because a viewport changing under someone with no explanation is worse than the mess being fixed. Any editor
may restore; the announcement and the pre-restore checkpoint are what make that safe rather than a permission
matrix.

## Reverting part of a map

Whole-document restore is blunt in a shared session — rolling back an hour to undo one person's mistake
discards everyone else's good work from that hour. With `039`'s registers a **scoped revert** is an ordinary
write and needs no new storage:

- *"revert everything Bob changed since r120"* — assign those registers their r120 values.
- *"revert this selection to r120"* — the same, bounded by the selected vertices and quads.

Both are computed from two things already in hand: the registers whose values differ between the checkpoint
and the live document, and the registers the room credits to a given writer. Their intersection, assigned the
checkpoint's values, *is* the revert. It travels the path any edit travels, resolves last-writer-wins like any
other assignment, and has no refusal path, no conflict handling and no history format of its own.

**Attribution is the room's, and it is memory only.** The room already credits every landed assignment to
whoever landed it; that crediting is kept per register as well as per map. It describes the editing session
rather than the mountain, so a restart forgets it — and writing it down would mean a `mountain.slope.json`
whose bytes change because of who touched them, which is exactly what presence must never be (`039`). It is
the **last** writer, not every writer: a value Bob moved and Ada moved after him belongs to Ada, and reverting
it would discard her work, which is the precise thing a scoped revert exists to avoid.

**A revert puts back values, never structure.** Which vertices and quads exist is not a register, so an
assignment naming geometry somebody deleted retires quietly rather than resurrecting it. Restore is what
brings a deleted mountain back; revert is what puts a changed one right.

Everything that makes a restore safe makes a revert safe, for the same reasons and by the same mechanisms: it
lands as a new revision, it is announced in the room, it is pushed to everyone on the map as ordinary
registers, and the document it replaced is set aside as a pinned checkpoint — so a revert nobody wanted is
undone exactly as a bad restore is. It is an editor action, declared in the route table beside every other
write to a map rather than checked in a handler of its own; a viewer is refused before the request is read.

This is the shape grief-rollback tooling for shared building worlds has converged on.

## Content-addressed assets, or history lies

Custom assets are overwritten in place by name today, so restoring last week's document gives last week's
geometry wearing this week's art, silently. A checkpoint therefore records the content hashes of the assets it
was authored against, and the asset store it draws from is append-only and addressed by hash. Without that,
history is confidently wrong rather than merely incomplete, which is worse.

## Two lines of history

The local `autosaves/` ring is a crash net for the machine it sits on. A server's checkpoints are the shared
line. They are never merged, because they never meet: a local project has no server line and a server project
has no local replica (`038`). The History panel shows whichever line the open project belongs to.

## Git as an escape hatch

`writeJsonAtomic` pretty-prints, so a flat vertex array is one number per line and a moved vertex is three
changed lines — a project folder takes to `git init` unusually well. That is worth documenting for anyone who
wants branches and blame, and worth *not* building on: a hard dependency, commits made on other members'
behalf, and binary assets bloating a repo are all costs this design does not need to carry.
