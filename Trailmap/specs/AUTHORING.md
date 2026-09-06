# Authoring the Spec

How `specs/` is written and kept coupled to the Trailmap workspace. This file
is authoring machinery, not spec content: `tools/specs/spec_trace.py` neither
traces nor checks it.

The `specs/` folder holds the spec: clean prose, densely annotated with
citations back into the Trailmap workspace. The prose and the citations are
separable by construction — `check` strips the citations and verifies that
what remains still stands on its own (see
[`../research/re-hygiene.md`](../research/re-hygiene.md) for why). The spec and
the RE iterate together; the coupling contract below is what keeps a finding on
either side traceable to the other.

## Cite plentifully

Every constant, threshold, table row, and non-obvious behavioral claim
carries a citation. In Parts 1–4 a paragraph without at least one citation
should be the exception. The citation is what lets the next RE session
find and re-verify the claim — an uncited claim can silently rot when the
RE understanding moves.

## Citation tags and definitions

A citation is two parts, both built from the same **tag**:

- an inline tag `[[320-sink-budget]]()` at the end of the claim it supports —
  the empty link renders the tag blue, so cited claims pop out of the prose;
- a definition: a blockquote led by the same tag, placed near the claim,
  holding the evidence. The quote bar shows exactly what the check strips —
  every blockquote led by a tag is dirty (a plain blockquote is clean prose
  and must not start with `[[`).

Tag IDs are `<chapter>-<slug>`, globally unique across the whole spec, never
renamed or reused once created. The Trailmap research notes link **back** to them with
the token `spec:320-sink-budget` (in `../research/elf-map.md` sections and in
`analysis.sqlite` observation text), so when a finding changes, the exact
spec claims it invalidates are greppable.

## Citation tokens are machine-resolvable RE-side keys

A citation definition starts with structured, semicolon-separated tokens;
free text may follow:

| Token | Resolves to |
|---|---|
| `db:snow-sink` | an observation topic in `analysis.sqlite` |
| `@0x0010a428` | an ELF address (symbols / observations / comments) |
| `map:"soft contact spring"` | a heading fragment in `../research/elf-map.md` |
| `doc:../research/board-model.md` | a note file, relative to `specs/` |

A `doc:` target that resolves outside Trailmap names a sibling checkout this
repo does not vendor (the SSX-Library decoder). `trace` reports those as
unverified when the checkout is absent rather than broken, and the same applies
to targets that are generated locally from your own disc — `elf-map.md` and
`analysis.sqlite`. Only a missing *committed* file is an error.

**Reference direction.** The doc layers are `<repo>/docs` (implementation) →
`specs/` (the clean spec) → `../research` (dirty Trailmap research notes). Citations
here point **down or at primary sources** only: `../research`,
`analysis.sqlite`, the ELF, or the SSX-Library community decoder. The spec is
the authority on the game's formats and behavior; downstream tools (the
`snowknife` extractor / OpenSlope Unity importer) reference the spec, **never the
reverse**, so the spec must not cite them — their decode/import detail lives
in the implementation docs. A `doc:`
citation into the repo's implementation docs is migration debt from before
the spec existed — `trace` warns on it; retire it by absorbing the knowledge
(clean part → the chapter body, evidence → the citation definition or a
`DIRTY` block) and re-pointing.

**Where dirty detail lives.** Don't create a dirty note just to have
something to cite — that's a transcription layer that drifts. Each fact has
three homes, each with one job:

| Altitude | Home | Holds |
|---|---|---|
| Conclusion | chapter body | the clean behavioral claim |
| Provenance summary | the claim's citation definition | key address, db topic, headline numbers, one-line evidence |
| Derivation | `../research` + the db | traces, address tables, evidence, negative results, open leads |

The dirty docs are the *investigation working surface* — the lab notebook.
When a chapter absorbs a subsystem, the corresponding dirty-note section gets
**pruned**: its restated behavioral narrative comes out (the conclusion's home
is now the spec), the derivation stays, and a `spec:` backref goes in. The
dirty layer gets rawer and thinner as the spec grows, but is never retired —
negative results and open leads have no spec home and must keep theirs.
Implementation/port guidance doesn't belong in the dirty layer at all; it
goes to the owning component's docs (`Snowknife/docs`, `Slopesmith/docs`, or `Unity/docs`).

**Downstream summaries are not specifications.** An implementation document
may name the source fields it consumes and briefly identify the behavior a code
path realizes, but it must not duplicate authoritative tables, equations,
thresholds, enumerations, or step-by-step game behavior. Put those facts here
and link to their chapter from the implementation document. Downstream docs
own code locations, conversion steps, engine constraints, project-authored
tuning, known deviations, and implementation verification.

Example:

```markdown
The landing impact is absorbed by a one-sided spring along the surface
normal, capped at ~0.1 m of travel, with per-surface penetration budgets
(snow ≈ 2.5 cm, deep powder ≈ 30 cm). [[320-sink-budget]]()

> [[320-sink-budget]]() db:snow-sink; @0x0010a428;
> map:"soft contact spring"; budget boarder+0x298 ← record+0x20.
```

A pointer — an address, offset, ELF/symbol name, class shape — never sits in
the chapter body. It goes in the claim's citation definition (its provenance
home), and the body carries the clean behavioral claim plus the `[[id]]()`
tag. Reword the prose; do not wrap the pointer in place.

Longer derivations and open leads that have no clean phrasing and no single
citation home go in a **standalone DIRTY block** — the `<!-- DIRTY` opener
alone on its line, the body beneath it, then a `DIRTY -->` closer:

```markdown
<!-- DIRTY
Open questions:
- the loader internals are untraced; candidate future trace = …
DIRTY -->
```

The DIRTY block must stand on its own lines. A marker embedded inline in a
prose line (`… the gate <!-- DIRTY +0x58 DIRTY --> is ~0 on ice …`) is
rejected by `check`'s fail-closed scan: it is the escape hatch that leaves a
pointer in the prose flow, which is exactly the thing the separation is meant
to prevent. Reword and cite instead.

## Retail names and quoted expression

Function labels in the `Subsystem_Verb` style are analyst-assigned names unless
the evidence explicitly marks one as a retail symbol, RTTI name, or string-table
entry. Use the descriptive label freely, but do not present its spelling as a
name supplied by the executable.

The clean/dirty boundary is not a permission to reproduce expression. These
rules apply to chapters, citation definitions, DIRTY blocks and `research/`:

- Do not include bulk disassembly or a verbatim instruction sequence that
  reproduces a routine. Keep compact address provenance and, when it is needed
  to prove an interface fact, only the shortest instruction fragment.
- Paraphrase retail configuration and script passages. Retain field names,
  short identifiers and minimal value fragments only when they identify the
  interface; never copy a section or command sequence merely because it is
  useful evidence.
- Review player-facing and format strings passage by passage. Short labels,
  button sequences, format fragments and method names can be functional facts;
  longer expressive text should be removed or paraphrased unless its exact
  wording is itself required for interoperability.
- Treat an ordered table of authored visual, audio or tuning choices as a
  potentially creative selection. If the exact rows are not required to define
  the interface, publish a local extraction recipe or project-authored default
  instead and keep only measurements and conclusions in the public graph.

Density, length and a step-by-step account of independently discovered behavior
do not by themselves make analytical prose suspect. Preserve original method,
negative results, measurements and reasoning; review for copied expression and
retail implementation structure, not for factual detail.

## `tools/specs/spec_trace.py` keeps both directions honest

- `python ../tools/specs/spec_trace.py trace` — link-integrity and coverage report:
  citations that no longer resolve (dropped DB topic, renamed elf-map
  heading, missing doc), `spec:` backrefs in the Trailmap research notes that point at
  anchors that don't exist, RE topics with **zero** spec citations (new
  findings not yet specced), and spec paragraphs that contain numbers but no
  citation.
- `python ../tools/specs/spec_trace.py check` — strips every dirty annotation in
  memory, then fail-closed scans the residue (addresses, offsets, citation
  tokens, symbol shapes) and fails if a dirty token survives outside an
  annotation. Nothing is written: the strip is a test of whether the clean
  prose stands on its own.

The iteration loop: a RE session adds or corrects a `db:` topic /
elf-map section (adding `spec:` backrefs where the spec already covers it) →
`trace` flags uncovered topics and stale citations → the affected spec
chapter is updated → `check` confirms the separation still holds.

## Source-material map

Where each part's content is drawn from while authoring. `<repo>/docs NNN` is
the numbered document in the owning component's own docs tree — `Snowknife/docs`,
`Slopesmith/docs`, `Unity/docs`, `Unity/docs/unity` or `Unity/docs/vrchat`; the
numbers are per-tree, so a few are reused across trees.

- Part 1/4 world data + rendering: `<repo>/docs` 002, 003, 005, 006, 007,
  008, 009, 010, 012, 014 + the export/bundle pipeline docs (`<repo>/docs`
  001, 034)
- Part 2 formats: SSX-Library FileHandlers (PBD/SSF/AIPSOP/MPF/SSH/BIG/audio);
  audio/music decode in `<repo>/docs` 015, 039
- Part 3 physics: `../research/elf-map.md`, `board-model.md`,
  `extracted-data.md`, `analysis.sqlite`; repo docs 016, 017, 020, 021, 026,
  030, 031, 032, 033, 035, 036, 037, 038
- Audio/music: repo docs 015, 019, 039
