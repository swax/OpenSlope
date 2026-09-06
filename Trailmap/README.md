# Trailmap

**A functional interoperability specification of *SSX Tricky*, derived through reverse engineering and
written as behavior rather than original implementation.**

The [specification](specs/README.md) covers on-disc formats, the world data model, rider behavior,
interaction, rendering, effects, and audio. Its chapter bodies are intended to be sufficient for an
independent implementation without reproducing how the retail code was organized.

Every non-obvious claim carries provenance. Citation definitions and occasional `DIRTY` notes are
tracked beside the chapter bodies and are public by design; they may contain addresses, offsets, retail
symbol names, and short instruction quotations — usually a single instruction, sometimes a short
sequence, never a listing — along with the occasional line of configuration text where naming a field
required it. No disassembly listing is reproduced here. The marked annotations are evidence, not
implementation guidance.

**No retail executable, disc image, or extracted asset is included.**

## Start here

- [Specification index](specs/README.md) — the product: formats, behavior, and normative data.
- [Authoring rules](specs/AUTHORING.md) — citation syntax and the clean-body/provenance boundary.
- [Research index](research/README.md) — measurements, derivations, histories, and open questions.
- [Reverse-engineering hygiene](research/re-hygiene.md) — why the research/specification boundary exists and how it is enforced.
- [Tool index](tools/README.md) — analysis, instrumentation, patch, and maintenance utilities.

Validate a normal checkout from this directory:

```powershell
python tools/specs/spec_trace.py check
```

`check` removes marked provenance in memory and scans what remains; it does not write a cleaned tree.
Maintainers with local analysis artifacts can additionally run `python tools/specs/spec_trace.py trace`
to verify citations, backlinks, and coverage.

## Scope and layers

- **Baseline:** *SSX Tricky* PAL PS2, boot ELF `SLES_505.45`.
- **Patch addenda:** Chapters 440–443 also cover the NTSC-U `SLUS_203.26` build.
- **Series addenda:** Selected deltas for SSX (2000), SSX 3, and SSX On Tour.
- **Not goals:** decompilation, preserving the original code structure, or shipping retail content.

| Layer | Location | Contains |
|---|---|---|
| Behavioral specification | Chapter bodies under [`specs/`](specs/README.md) | Observable behavior, formats, requirements, constants, and normative data |
| Public provenance | Citation definitions and `DIRTY` notes under `specs/` | Compact addresses, symbols, offsets, short quotations, and open leads supporting claims |
| Committed research | `research/` | Derivations, negative results, histories, and working notes |
| Local research | `analysis.sqlite`, `research/elf-map.md`, `extracted/` | Bulk labels, xrefs, disassembly narrative, and user-extracted files |
| Maintenance tools | [`tools/`](tools/README.md) | ELF/VU analysis, PINE instrumentation, patches, and spec checks |

The division of labor is deliberate: conclusions belong in behavioral chapter bodies, short provenance
belongs in their citations, and full derivations belong in research. Downstream implementations cite the
specification; implementation or port guidance stays with Snowknife, Slopesmith, or Unity.

## Selected research notes

The complete list is in the [research index](research/README.md).

| Note | Purpose |
|---|---|
| [Extracted data](research/extracted-data.md) | Facts measured directly from course and configuration files |
| [Board model](research/board-model.md) | Portable snowboard state and response model synthesized from the findings |
| [Tooling](research/tooling.md) | Extraction and analysis command cookbook |
| [Rider telemetry](research/rider-telemetry.md) | Frame-fenced PINE trace capture and annotation |
| [Open questions](research/open-questions.md) | Unresolved leads and decisive next checks |
| [Implementation follow-ups](research/implementation-follow-ups.md) | Spec findings the components have not yet adopted, by owner |
| [Ground-contact history](research/ground-contact-implementation-history.md) | Raw traces and superseded interpretations |
| [Prop collision semantics](research/prop-collision-semantics.md) | Runtime provenance for dynamic prop contact and activation |
| [RE hygiene](research/re-hygiene.md) | Clean-body/provenance policy and enforcement |

`research/elf-map.md` is intentionally local: it is the full disassembly map referenced by compact
citations but is rebuilt from the user's own executable.

## Local-only inputs

Fresh clones do not contain retail or bulk analysis artifacts:

| Path | Purpose | Generated with |
|---|---|---|
| `extracted/` | Boot ELF, configuration, and level files from your disc | A disc/BIG extractor; see [tooling](research/tooling.md) |
| `analysis.sqlite` | Labels, comments, observations, xrefs, functions, and strings | `tools/analysis/ssx_analyze.py` |
| `tools/analysis/ssx_seed_data.py` | Durable local labels and observations used to reseed the database | `ssx_analyze.py seed-known` workflow |
| `research/elf-map.md` | Full disassembly map and subsystem leads | Rebuilt while analyzing the local boot ELF |

These paths are gitignored. The specification checks degrade gracefully when they are absent.

Trailmap citations also point into the SSX-Library community decoder
([upstream](https://github.com/GlitcherOG/SSX-Library); the [fork](https://github.com/swax/SSX-Library)
Snowknife builds against is what the citations resolve to). In this repository it is the
`Snowknife/SSX-Library/` submodule; initialize it with:

```powershell
git submodule update --init Snowknife/SSX-Library
```

Without the submodule, `trace` reports those citations as unverified rather than broken.

## License and scope

Trailmap is independent and unofficial, and is not affiliated with or endorsed by Electronic Arts.
No retail binary, disc image, or extracted asset is distributed here; local inputs must come from a
copy you own and must not be redistributed.

Repository-authored specifications, research, software, prose, and data under `Trailmap/` are licensed
under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for scope, trademarks, and third-party attribution.
The grant does not extend to retail content, EA trademarks, or separately licensed projects such as
SSX-Library.

Trailmap builds on years of work by the SSX modding and preservation community, especially SSX-Library
contributors GlitcherOG, Erickson Munoz, and Jaime Solsona.
