# Automatic board surface audio mapping

Build 0.45 writes `Audio/BoardSoundIndex.json` during native ISO import on
desktop and Quest. Its `openslope-board-sound-index/v1` fields are `Schema`,
`SourceExecutable` and `SurfaceGroups`. The course-local file makes a copied
map self-contained. Existing local indexes and the legacy
`Maps/Shared/Audio/BoardSoundIndex.json` remain supported by playback/cache code.
Missing or out-of-domain routing retains the established PACK fallback.

Clean Trailmap 190/420 establish the surface-family selector, sentinel/index
normalization, family/mode matrix and audio ownership. The terrain domain is
read from the embedded ride contract. Native independently identifies bounded
code-pointer tables whose handlers return constant family ids, then discovers
the checked selector and its scalar field provider/normalizer. It evaluates each
raw terrain type through the actual supplied branch and return-delay paths.
Table entries before the terrain domain must not be mistaken for type zero.
No retail addresses, instruction words, normalization value or mapping rows are
compiled into the reader.

The scalar path shares the independent boot/ELF validation and instruction
semantics with collision-audio recovery. It permits private stack storage only,
never writes the input image, invokes host code or supplies another runtime's
implementation. Unsupported, incomplete or ambiguous selectors remain unresolved
or fail explicitly; no family is inferred from a surface name. A missing sidecar
is still valid for an authored map.

Discovery uses 6..1024-entry pointer runs, at most 512 runs, 16 KiB target spans,
4 KiB selector searches and 32-byte definition/provider windows. Guards must
agree with their table extent, have at most 256 entries and cover the requested
terrain domain. Family results must be 0..9; diverse constant handlers and an
observed dispatch through the selected table are required. The shared scalar
analysis has 4096 steps per probe, a 15-million-step global budget and cancellation
checks. These are bounded application admission rules, not a general CPU emulator
or a promise of compatibility with every executable revision.

The normal importer joins the recovered mapping with the configured Board bank
and user-supplied `SNOW.INF`, and removes the board-extraction Deferred marker.
The file is produced independently of collision-route availability. Existing map
folders and authored overrides are preserved. Reimport into a fresh Maps root
to populate missing metadata. A read-only inspection command is available:

```text
openslope_import board-groups <user-supplied.iso>
```

Synthetic conformance uses unrelated values/register allocation and covers
different index adjustments and sentinel counts, delayed returns, field dataflow,
constant/invalid providers, relocation, duplicate/ambiguous tables, explicit
domain sizes, cancellation and normal ISO extraction. A production Vulkan/PCM
test imports the synthetic sidecar, verifies the selected family's frequency,
custom override, missing-index PACK fallback and legacy Shared fallback, and
compares unchanged rider position/velocity.

Validation passes all 44 native suites, including 22 authored selector/import
cases and direct domain/cancellation checks. The full repository gate passes
in 224.6 seconds. The production routing replay covers 120 Vulkan/PCM frames;
the existing contact/ambient/board/music replay also passes. Eleven fresh real
imports match 220 board-family rows and preserve all 1,045 collision routes.
Private wood/metal comparisons use the actual decoded Board bank and programs:
360 additional frames change the sustained audio while keeping position and
velocity identical. These establish family routing, not Slopesmith's authored
bed response or exact original signal calibration.

The signed 0.45.0/code 46 ARM64 app passes 100 Quest JNI/custom-library/SAF
checks. Lint has zero errors and four existing warnings. All sixteen notice/
license assets match their sources and the main APK contains no private media.
ALASKA receives only its missing board index and updated import status; existing
geometry, world settings, instances, sound routes and preferences retain their
hashes. An authored local index is preserved if already present.
An eight-second ALASKA startup initializes both 1680x1760 eyes at 4x MSAA and
the full-body tracker; this is startup evidence only.

The user's USA image reproduces all twenty entries in the existing portable
Shared export. No PAL image has been tested. Neither the executable, resulting
retail mapping, decoded media nor private captures enter source/application
packages.

This closes surface-family extraction. Build 0.46 adds the authored bed response,
rail handoff, boost envelope, prewarmed clips and Native mix sidecar described in
[board-audio-performance.md](board-audio-performance.md). Wider audio/music/
announcer behavior still requires parity work. Device import/startup checks do
not establish worn listening or sustained FPS.
