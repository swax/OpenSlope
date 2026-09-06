# Legal

OpenSlope is an independent, unofficial project. It is not endorsed by, affiliated with, or sponsored
by Electronic Arts Inc. or its licensors.

If you hold rights in something you believe this repository carries, please write to
**contact@transparentsource.org**. A specific, good-faith request about specific material will get a
specific answer, and we will act on it. That address is read by a person; you do not need to file a
formal notice to get our attention, and we would much rather have the conversation.

This page is the summary. The binding scope statements are the `NOTICE` file in each component —
[Slopesmith](Slopesmith/NOTICE), [Snowknife](Snowknife/NOTICE), [Trailmap](Trailmap/NOTICE),
[Unity](Unity/NOTICE) — and [`LICENSE`](LICENSE), which maps every path to its terms. Where this page
and a `NOTICE` differ, the `NOTICE` governs.

Security vulnerabilities go somewhere else: see [SECURITY.md](SECURITY.md).

## What this repository does not contain

No retail game asset, executable, disc image, or extracted level, texture, model, or audio file is
included in this repository or in a release artifact built solely from it. Nothing here grants any
right to such material, because none of it is ours to grant.

Disc-backed workflows operate locally on an image supplied by the user. Their outputs may be
derivative of third-party works. OpenSlope neither distributes nor licenses those outputs; users are
responsible for ensuring that their use and handling are lawful. They are excluded from version
control by `.gitignore` rules written for that purpose and must not be attached to an issue,
discussion, or pull request, or distributed through this project.

Courses authored from material you created, or that you otherwise have the right to redistribute, are
yours and can be shared independently of any disc-derived data.

## What this repository does contain

**An interoperability specification.** [Trailmap](Trailmap/) describes what the original game does —
its data formats, its observable behavior, its measured constants — so that independent programs can
read and write compatible data. Its chapter bodies describe behavior rather than how the original
code was organized, and a checked gate enforces that separation on every commit. The citation
definitions and research notes beside them record the evidence those claims rest on — including the
addresses, symbol names, and structure of the routines that were read — as compact provenance, not as
an implementation; see [reverse-engineering hygiene](CONTRIBUTING.md#reverse-engineering-hygiene).

**A bounded set of retail-derived facts.** Format and asset identifiers, enumeration and bank names,
and measured functional constants are carried in the tree, because interoperating requires them. The
authoritative copies are [`Trailmap/specs/data/ride-v1.json`](Trailmap/specs/data/ride-v1.json) and
[`Trailmap/specs/data/external-sound-banks-v1.json`](Trailmap/specs/data/external-sound-banks-v1.json),
together about 12 KB, and each component's `NOTICE` describes the further facts its own source and
tests carry — today, the per-course lap counts and showoff clock lengths; the register-relative shape
of the compiled switch that Snowknife's sound-index reader searches a user-supplied executable for, described
by opcode and register fields rather than by any encoded instruction; and individual measured engine
constants and per-asset measurements (a lookup table, a record's field values, a placement centroid)
cited to the Trailmap chapter that establishes them. Citations in the specifications
additionally carry addresses, field offsets, analyst-assigned labels, and short instruction quotations
— usually a single instruction, sometimes a short sequence, never a listing — kept as evidence for the
claims they support. No bulk listing of the original program is reproduced anywhere, and no source
file, test, or patch definition carries a retail instruction as machine code: where a tool must know
what the user's executable holds at a site, it carries a SHA-256 of those words and reads the words
from that file.

**Tools that modify a user-supplied executable.** The patch definitions under
[`Snowknife/Snowknife/Patches/`](Snowknife/Snowknife/Patches/) change a game executable inside an
image supplied by the user. They do not reproduce the bytes they replace: each region names only a
SHA-256 of what it expects to find, and where a hook must re-execute a displaced instruction, the
definition names where to copy that instruction from in the same file rather than carrying it. No
patch definition in this repository contains a retail instruction word. The generators that produce
those definitions name each displaced instruction by mnemonic and source address — the same short
quotation the research notes carry — and emit the copy directive in its place, and the research probes
that hook a running emulator follow the digest rule throughout: they name a site by digest and read
what it holds from the emulator or from the user's extracted executable. Slopesmith's generated disc
recipe selects no executable feature and disables the separate sky-colour change; applying an executable
feature is an explicit local choice.

**No access-control tooling.** OpenSlope contains no code intended to defeat DRM, console
authentication, license checks, or another access-control mechanism. Snowknife reads files from a
user-supplied disc image and writes a modified copy; it does not alter the platform's access-control
checks. Users are responsible for determining whether making or using an image, applying a patch, or
running the result is permitted under applicable law and contractual terms.

**Original software.** The editor, the extractor, the converters, the runtimes, the models, and the
art are this project's own work, licensed as [`LICENSE`](LICENSE) sets out. Every tracked binary file
is individually declared in [`tools/binary-provenance.json`](tools/binary-provenance.json), recording
what it is and how it was made; a check fails the build if a binary is undeclared or if a declaration
goes stale.

## Trademarks

SSX, SSX Tricky, SSX 3, and SSX On Tour are trademarks of Electronic Arts Inc. Where this repository
names them, it does so to identify what its tools interoperate with — a descriptive use, not a claim
of association. Blender is a trademark of the Blender Foundation, Unity of Unity Technologies, Mixamo
of Adobe Inc., and other marks belong to their respective owners.

OpenSlope, Slopesmith, Snowknife, and Trailmap identify this software only. No claim is made to
unrelated third-party uses of identical or similar names.

## Third-party rights on a retail disc

Rights in the music and the voice performances on a retail disc are held by their publishers, labels,
and performers, and are licensed to Electronic Arts rather than owned by it. Permission from
Electronic Arts would not extend to them. Snowknife can decode those streams from a user-supplied copy;
their output is subject to the same rule as everything else derived from a disc, and no grant in this
repository reaches them.

## Video playback

Slopesmith's Jukebox plays through YouTube's official embedded player. **Slopesmith ships no media
extractor** and makes no request to YouTube's servers for media on its own behalf. It can optionally
be pointed at a self-hosted media server that a viewer already runs on their own machine, in which
case the viewer's browser talks directly to an origin they configured, over an Invidious-compatible
API. The server those bindings were written and tested against is
[Yattee Server](https://github.com/swax/yattee-server), a yt-dlp-based media server maintained by the
same author as OpenSlope. It is separate software under its own MIT licence, is not built, bundled, or
distributed here, and Slopesmith's service is not in the request path; any server answering the same
API works. See [the Jukebox guide](Slopesmith/docs/063-video-bridge.md).

The VRChat runtime's video billboards play through the VRChat SDK's own video components and add no
resolver of their own.

## Contributing

Only submit work you created or have the right to contribute under the affected component's license,
and identify any third-party material and its terms in the pull request. Do not submit extracted
retail assets or generated output whose terms you cannot satisfy. [CONTRIBUTING.md](CONTRIBUTING.md)
has the full expectations, including the reverse-engineering hygiene the gate enforces.

---

*This page describes the project's own boundaries and commitments. It is not legal advice, and it is
not a representation about what any particular use of these tools permits you to do.*
