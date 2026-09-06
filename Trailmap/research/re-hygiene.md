# Reverse-Engineering Hygiene

Why this workspace keeps **what the game does** apart from **how its code did
it**, and how that separation is enforced.

The goal is compatibility: a functional specification precise enough to author
our own game that loads and runs SSX levels. That takes understanding the game —
its data model, its on-disc formats, its observable behavior — and it
specifically does *not* take reproducing the original implementation, its
algorithms, or its source. Those are two different activities, and the
discipline here exists to keep us in the first one.

## The layers

| Layer | Where | Holds |
|---|---|---|
| **Dirty evidence** | `research/`, `elf-map.md`, `analysis.sqlite`, `../tools/analysis/`, `../tools/instrumentation/`, `../tools/patches/`, `../tools/autotest/`, `extracted/`, and citation definitions in `../specs/` | Addresses, RTTI/symbol dumps, field offsets, disassembly structure, probe code, and paths into `extracted/`. |
| **Clean specification** | [`../specs/`](../specs/) chapter bodies | Observable behavior, functional requirements, formats, measured constants and magnitudes. |
| **Clean consumers** | Repository/component docs, source, and tests | Original implementations that consume the spec and reference it with `[Trailmap: <anchor>]`. |

The split is not about who is allowed to read what — everything here is one
workspace. It is about what each layer is *for*. The dirty layer is the lab
notebook: how we found out, plus the negative results and open leads that have
no other home. The clean layer is the finding itself, stated so it stands on its
own.

**Dirty is not the same as unpublished.** Most of the dirty layer is generated
locally from your own copy of the game and never committed: `elf-map.md`, the
`analysis.sqlite` database, the seed data that reseeds it, and `extracted/`. What
ships is the citation definitions in `specs/`, each carrying its evidence inline.
So the addresses and offsets behind a published claim are public by design, while
the disassembly *narrative* and the bulk symbol store stay local. Publishing
evidence next to a conclusion is the point of the citation convention. What the
two principles below guard against is different: prose that relays the shape of
the original code instead of describing behavior.

That direction matters. A fact only reaches the spec once we understand it well
enough to state it without pointing at a disassembly, which is a real bar: it
forces us to know *what the game does* rather than merely *where the code that
does it lives*.

## Two principles

### 1. Stripping references is not the same as describing behavior

This is the trap. Removing `0x0012fef8` and `cGroundMotion` from a paragraph
does not turn it into a behavioral description if the paragraph is a
line-by-line paraphrase of the disassembled routine. A sentence like "it does X,
then checks Y, then branches to Z in this exact order under these exact
conditions" is a transliteration of the *implementation* with the addresses
filed off. It describes how the original code was organized — which is the thing
we neither want nor need, since our own game will not be organized that way.

So clean prose sits at a deliberately higher altitude:

- **Yes** — observable behavior, functional requirements, and measured
  constants:
  *"On landing, vertical velocity is absorbed by a one-sided spring along the
  surface normal, capped at ~0.1 m of travel, with per-surface penetration
  budgets (snow ≈ 2.5 cm, deep powder ≈ 30 cm)."*
- **No** — a transliteration of a routine's control flow:
  *"Function reads boarder+0x298, compares to record+0x20, branches if …"*

The first tells an implementer what to build and leaves them free to build it
any way they like. The second just relays someone else's code.

**Litmus test for any clean statement:** delete its citation and the sentence
must still fully specify the behavior. If removing the citation guts the
sentence, the sentence was leaning on the disassembly and needs rewriting.

### 2. The check is fail-closed, not fail-open

`check` strips the tagged annotations and scans what's left. It is deliberately
**not** a cleaner: nothing is written, and a hit is never fixed by deleting the
offending token. A tool that quietly scrubbed known-bad tokens would rot on
first contact with a new kind of dirty reference, and would let a paraphrased
routine through untouched so long as it had no hex in it.

Read a hit as a *symptom*: dirty residue in the body usually means the prose
drifted from describing behavior to describing implementation. The fix is to
reword the claim and move the pointer into a citation — never to loosen the
scanner. The pattern list is aggressive on purpose and will occasionally flag
innocent prose (a hex colour, say); rewording is the correct response to that
too.

The tool is a tripwire for the author, not a wall. The wall is writing at the
functional altitude to begin with.

## Tag convention

Dirty references live as **citations on clean claims**, where the claim already
stands alone:

```markdown
The landing impact is absorbed by a one-sided spring along the surface
normal, capped at ~0.1 m of travel, with per-surface penetration budgets
(snow ≈ 2.5 cm, deep powder ≈ 30 cm). [[320-sink-budget]]()

> [[320-sink-budget]]() db:snow-sink; @0x0010a428;
> map:"soft contact spring"; budget boarder+0x298 ← record+0x20.
```

Derivations with no clean phrasing and no single citation home go in a
standalone `<!-- DIRTY … DIRTY -->` block. Anything dirty that is **not** inside
a citation or a block is a bug the scan must catch.

Full rules — tag IDs, the machine-resolvable `db:`/`@0x`/`map:`/`doc:` tokens,
`spec:` backrefs, and where each altitude of a fact lives — are in
[`../specs/AUTHORING.md`](../specs/AUTHORING.md).

## Running it

```
python tools/specs/spec_trace.py check   # clean/dirty separation still holds
python tools/specs/spec_trace.py trace   # citations and backrefs still resolve
python tools/specs/repo_hygiene.py check # no new dirty evidence in downstream consumers
python tools/specs/repo_hygiene.py report # complete repository cleanup inventory
```

`check` reports `file:line: <what>: <token>` for each hit and exits non-zero.
The repository check compares its findings with a reviewed baseline. New leaks
fail immediately; resolved baseline entries also fail so cleanup ratchets the
inventory downward instead of leaving invisible exemptions behind. The full
report is retained by CI as `repo-hygiene-report`.

## Caveat

This discipline addresses one risk category — copyright in the original *code* —
and reduces it. It does not make a reimplementation categorically safe: EA still
owns the SSX trademarks and the extracted assets and data themselves, none of
which this process launders. This is engineering hygiene, not legal advice.
